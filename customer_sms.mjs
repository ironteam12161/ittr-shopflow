// v24.55.0: two-way texting with customers through Twilio. Off until TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
// TWILIO_FROM (a Twilio number) or TWILIO_MESSAGING_SERVICE_SID are set in Railway, and the Twilio number's
// "A message comes in" webhook points to <APP_PUBLIC_URL>/api/sms/inbound.
//  - Incoming texts are accepted only with a valid X-Twilio-Signature (HMAC-SHA1 with the auth token).
//  - STOP / UNSUBSCRIBE / CANCEL / END / QUIT opt the number out; the shop can't text it again until it texts START.
//  - Replies are matched to the customer by phone and pop up for the shop over the live connection.
import crypto from 'node:crypto';

export function smsConfig(env = process.env) {
  const sid = String(env.TWILIO_ACCOUNT_SID || '').trim(), token = String(env.TWILIO_AUTH_TOKEN || '').trim();
  const from = String(env.TWILIO_FROM || '').trim(), service = String(env.TWILIO_MESSAGING_SERVICE_SID || '').trim();
  return { enabled: Boolean(sid && token && (from || service)), sid, token, from, service, api: String(env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '') };
}
// US/Canada numbers to E.164 (+1XXXXXXXXXX); other numbers must already start with +.
export function normalizePhone(v) {
  const s = String(v || '').trim(), d = s.replace(/\D/g, '');
  if (s.startsWith('+') && d.length >= 8 && d.length <= 15) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return '';
}
export function twilioSignature(authToken, url, params) {
  const data = url + Object.keys(params || {}).sort().map(k => k + params[k]).join('');
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}
export function validTwilioSignature(authToken, url, params, header) {
  const exp = twilioSignature(authToken, url, params), got = String(header || '');
  return got.length === exp.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(exp));
}
const STOP = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|optout|opt out)\s*[.!]*\s*$/i, START = /^\s*(start|unstop|yes)\s*[.!]*\s*$/i;

export async function ensureSmsSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS sms_messages(
    id BIGSERIAL PRIMARY KEY, direction TEXT NOT NULL CHECK(direction IN ('in','out')), phone TEXT NOT NULL, customer_id BIGINT,
    body TEXT NOT NULL, status TEXT, twilio_sid TEXT UNIQUE, error TEXT, created_by TEXT, created_at TIMESTAMPTZ DEFAULT now(), read_at TIMESTAMPTZ);
  CREATE INDEX IF NOT EXISTS idx_sms_phone ON sms_messages(phone,created_at DESC);
  CREATE TABLE IF NOT EXISTS sms_optouts(phone TEXT PRIMARY KEY, opted_out_at TIMESTAMPTZ DEFAULT now(), source TEXT);`);
}
async function customerForPhone(db, phone) {
  const tail = phone.replace(/\D/g, '').slice(-10); if (tail.length < 10) return null;
  return (await db.query(`SELECT id,customer_name FROM fullbay_import_customers WHERE right(regexp_replace(coalesce(phone,''),'\\D','','g'),10)=$1 ORDER BY active DESC NULLS LAST,id LIMIT 1`, [tail]).catch(() => ({ rows: [] }))).rows[0] || null;
}

export function registerSmsRoutes(app, { auth, adminOnly, requireDb, audit, broadcastShopStatus, publicLimiter, formParser }) {
  const fail = (res, s, error, code) => res.status(s).json({ error, ...(code ? { code } : {}) });
  const base = req => String(process.env.APP_PUBLIC_URL || '').trim().replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
  app.get('/api/sms/config', auth, adminOnly, async (req, res, next) => { try {
    const c = smsConfig(); let unread = 0;
    if (c.enabled) unread = Number((await requireDb().query(`SELECT count(*)::int n FROM sms_messages WHERE direction='in' AND read_at IS NULL`)).rows[0].n);
    res.json({ enabled: c.enabled, from: c.from || (c.service ? 'Messaging service' : ''), unread, missing: c.enabled ? [] : ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'].filter(k => !String(process.env[k] || '').trim()) });
  } catch (e) { next(e); } });
  app.post('/api/sms', auth, adminOnly, async (req, res, next) => { try {
    const c = smsConfig(); if (!c.enabled) return fail(res, 503, 'Texting is not set up. Add the Twilio keys in Railway.', 'SMS_NOT_CONFIGURED');
    const db = requireDb(), phone = normalizePhone(req.body?.to), body = String(req.body?.body || '').replace(/\r/g, '').trim().slice(0, 1200);
    if (!phone) return fail(res, 400, 'Enter a valid mobile number, e.g. (312) 555-0199.');
    if (!body) return fail(res, 400, 'Type a message.');
    if ((await db.query('SELECT 1 FROM sms_optouts WHERE phone=$1', [phone])).rowCount) return fail(res, 409, 'This customer replied STOP, so texting is off for this number. They can text START to turn it back on.', 'SMS_OPTED_OUT');
    const customerId = Number(req.body?.customerId) || (await customerForPhone(db, phone))?.id || null;
    const form = new URLSearchParams({ To: phone, Body: body, StatusCallback: `${base(req)}/api/sms/status` });
    if (c.service) form.set('MessagingServiceSid', c.service); else form.set('From', c.from);
    const r = await fetch(`${c.api}/2010-04-01/Accounts/${encodeURIComponent(c.sid)}/Messages.json`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${c.sid}:${c.token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { await db.query(`INSERT INTO sms_messages(direction,phone,customer_id,body,status,error,created_by) VALUES('out',$1,$2,$3,'failed',$4,$5)`, [phone, customerId, body, String(d.message || r.status).slice(0, 300), req.user.username]);
      return fail(res, 502, `Twilio did not send it: ${d.message || `HTTP ${r.status}`}`); }
    const m = (await db.query(`INSERT INTO sms_messages(direction,phone,customer_id,body,status,twilio_sid,created_by) VALUES('out',$1,$2,$3,$4,$5,$6) RETURNING id,created_at`, [phone, customerId, body, d.status || 'queued', d.sid || null, req.user.username])).rows[0];
    await audit(req.user.username, 'sms_sent', { phone, customerId, sid: d.sid, length: body.length });
    res.json({ ok: true, id: m.id, sid: d.sid, status: d.status || 'queued' });
  } catch (e) { next(e); } });
  const twilioRequest = (req, res) => { const c = smsConfig(); if (!c.enabled) { res.status(503).end(); return null; }
    const params = Object.fromEntries(Object.entries(req.body || {}).map(([k, v]) => [k, String(v)]));
    if (!validTwilioSignature(c.token, base(req) + req.originalUrl, params, req.get('x-twilio-signature'))) { res.status(403).type('text/plain').send('Bad signature'); return null; }
    return params; };
  app.post('/api/sms/inbound', publicLimiter, formParser, async (req, res, next) => { try {
    const p = twilioRequest(req, res); if (!p) return;
    const db = requireDb(), phone = normalizePhone(p.From), body = String(p.Body || '').slice(0, 2000);
    if (!phone) return res.type('text/xml').send('<Response/>');
    const cust = await customerForPhone(db, phone);
    await db.query(`INSERT INTO sms_messages(direction,phone,customer_id,body,status,twilio_sid) VALUES('in',$1,$2,$3,'received',$4) ON CONFLICT(twilio_sid) DO NOTHING`, [phone, cust?.id || null, body, p.MessageSid || null]);
    if (STOP.test(body)) await db.query(`INSERT INTO sms_optouts(phone,source) VALUES($1,'reply') ON CONFLICT(phone) DO UPDATE SET opted_out_at=now()`, [phone]);
    else if (START.test(body)) await db.query('DELETE FROM sms_optouts WHERE phone=$1', [phone]);
    broadcastShopStatus('sms_received', { phone, customer: cust?.customer_name || '', preview: body.slice(0, 80) });
    res.type('text/xml').send('<Response/>');
  } catch (e) { next(e); } });
  app.post('/api/sms/status', publicLimiter, formParser, async (req, res, next) => { try {
    const p = twilioRequest(req, res); if (!p) return;
    if (p.MessageSid) await requireDb().query('UPDATE sms_messages SET status=$2,error=coalesce($3,error) WHERE twilio_sid=$1', [p.MessageSid, String(p.MessageStatus || '').slice(0, 30), p.ErrorCode ? `Error ${p.ErrorCode}` : null]);
    res.status(204).end();
  } catch (e) { next(e); } });
  app.get('/api/sms/threads', auth, adminOnly, async (req, res, next) => { try {
    const r = await requireDb().query(`SELECT DISTINCT ON (m.phone) m.phone,m.body,m.direction,m.created_at,m.customer_id,c.customer_name,
        (SELECT count(*)::int FROM sms_messages u WHERE u.phone=m.phone AND u.direction='in' AND u.read_at IS NULL) unread,
        EXISTS(SELECT 1 FROM sms_optouts o WHERE o.phone=m.phone) opted_out
      FROM sms_messages m LEFT JOIN fullbay_import_customers c ON c.id=m.customer_id ORDER BY m.phone,m.created_at DESC`);
    res.json({ items: r.rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 200) });
  } catch (e) { next(e); } });
  app.get('/api/sms/thread', auth, adminOnly, async (req, res, next) => { try {
    const phone = normalizePhone(req.query.phone); if (!phone) return fail(res, 400, 'Phone number required.');
    const db = requireDb(), r = await db.query(`SELECT id,direction,body,status,error,created_by,created_at FROM sms_messages WHERE phone=$1 ORDER BY created_at DESC LIMIT 200`, [phone]);
    await db.query(`UPDATE sms_messages SET read_at=now() WHERE phone=$1 AND direction='in' AND read_at IS NULL`, [phone]);
    const cust = await customerForPhone(db, phone);
    res.json({ phone, customer: cust, optedOut: (await db.query('SELECT 1 FROM sms_optouts WHERE phone=$1', [phone])).rowCount > 0, items: r.rows.reverse() });
  } catch (e) { next(e); } });
}
