// v24.53.0: 2-step login with an authenticator app (TOTP, RFC 6238) plus one-time recovery codes, and the
// per-account sign-in lock. Pure helpers are exported for the tests; routes are registered from server.js.
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const s = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, ''); let bits = 0, value = 0; const out = [];
  for (const ch of s) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function totpCode(secretB32, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest(), o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1000000)).padStart(6, '0');
}
export const totpStep = (ms = Date.now()) => Math.floor(ms / 30000);
// Accepts the code for the current 30-second step or one step either side (phone clock drift). A step that was
// already used is refused, so a code seen over someone's shoulder cannot be replayed. Returns the step or null.
export function verifyTotp(secretB32, code, lastStep = 0, ms = Date.now()) {
  const c = String(code || '').replace(/\D/g, ''); if (c.length !== 6 || !secretB32) return null;
  const now = totpStep(ms);
  for (const s of [now, now - 1, now + 1]) {
    if (s <= Number(lastStep || 0)) continue;
    const exp = totpCode(secretB32, s);
    if (crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(c))) return s;
  }
  return null;
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

// v24.76.5: authenticator secrets are encrypted in the database (AES-256-GCM) when MFA_SECRET_KEY is set (16 or more
// characters), so a copy of the database alone cannot produce 2-step codes. Without the setting they stay as before.
// - Existing secrets are encrypted at startup (migrateTotpSecrets).
// - To change the key: put the old value in MFA_SECRET_KEY_OLD and the new one in MFA_SECRET_KEY, deploy (startup
//   re-encrypts with the new key), then remove MFA_SECRET_KEY_OLD.
// - To stop encrypting (for example before going back to a version older than v24.76.5): move the value to
//   MFA_SECRET_KEY_OLD and leave MFA_SECRET_KEY empty, deploy; startup stores the secrets in plain form again.
// - If the key is missing or wrong, an encrypted secret cannot be read: sign-in says so (MFA_KEY) instead of "wrong code",
//   and recovery codes and email codes still work.
const SEALED = 'enc1.';
const mfaKey = raw => { const v = String(raw || '').trim(); return v.length >= 16 ? crypto.createHash('sha256').update(v).digest() : null; };
export const mfaKeys = (env = process.env) => ({ current: mfaKey(env.MFA_SECRET_KEY), old: mfaKey(env.MFA_SECRET_KEY_OLD) });
export const isSealedSecret = v => typeof v === 'string' && v.startsWith(SEALED);
export function sealTotpSecret(plain, keys = mfaKeys()) {
  if (!plain || !keys.current || isSealedSecret(plain)) return plain;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', keys.current, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return SEALED + [iv, c.getAuthTag(), enc].map(b => b.toString('base64url')).join('.');
}
const openWith = (stored, key) => {
  const [iv, tag, enc] = stored.slice(SEALED.length).split('.').map(x => Buffer.from(x || '', 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
};
// The secret in plain form, or throws {code:'MFA_KEY'} when it is encrypted and no key that is set opens it.
export function openTotpSecret(stored, keys = mfaKeys()) {
  if (!stored || !isSealedSecret(stored)) return stored || null;
  for (const k of [keys.current, keys.old]) { if (!k) continue; try { return openWith(stored, k); } catch (_) {} }
  throw Object.assign(new Error('An authenticator secret cannot be read: MFA_SECRET_KEY is missing or was changed.'), { code: 'MFA_KEY', status: 503 });
}
// Startup: encrypt plain secrets, re-encrypt ones that only the old key opens. Reports secrets no key opens.
export async function migrateTotpSecrets(db, keys = mfaKeys()) {
  const out = { sealed: 0, resealed: 0, unsealed: 0, unreadable: 0, keySet: Boolean(keys.current) };
  const rows = (await db.query('SELECT id,totp_secret,totp_pending_secret FROM auth_users WHERE totp_secret IS NOT NULL OR totp_pending_secret IS NOT NULL')).rows;
  for (const r of rows) {
    const next = {};
    for (const col of ['totp_secret', 'totp_pending_secret']) {
      const v = r[col]; if (!v) continue;
      if (!isSealedSecret(v)) { if (keys.current) { next[col] = sealTotpSecret(v, keys); out.sealed++; } continue; }
      if (keys.current) { try { openWith(v, keys.current); continue; } catch (_) {} }
      if (keys.old) { try { const plain = openWith(v, keys.old); next[col] = keys.current ? sealTotpSecret(plain, keys) : plain; out[keys.current ? 'resealed' : 'unsealed']++; continue; } catch (_) {} }
      out.unreadable++;
    }
    const cols = Object.keys(next);
    // Only if the row still holds what was read, so a setup made meanwhile is never overwritten.
    if (cols.length) await db.query(`UPDATE auth_users SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(',')} WHERE id=$1 AND ${cols.map((c, i) => `${c} IS NOT DISTINCT FROM $${i + 2 + cols.length}`).join(' AND ')}`, [r.id, ...cols.map(c => next[c]), ...cols.map(c => r[c])]);
  }
  return out;
}
export const hashRecovery = c => crypto.createHash('sha256').update(String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');
export function newRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => { const h = crypto.randomBytes(5).toString('hex'); return `${h.slice(0, 5)}-${h.slice(5)}`; });
}
export const mfaRequiredForRole = role => role === 'admin' || role === 'manager';
export const LOGIN_LOCK = { maxFailures: 8, minutes: 15 };

export async function ensureMfaSchema(db) {
  await db.query(`
    ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
    ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS totp_pending_secret TEXT;
    ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS totp_recovery JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS failed_logins INT NOT NULL DEFAULT 0;
    ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
    ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS email_mfa_enabled BOOLEAN NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS mfa_email_codes(id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL, email TEXT NOT NULL, code_hash TEXT NOT NULL, attempts INT NOT NULL DEFAULT 0, expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now());
    CREATE INDEX IF NOT EXISTS idx_mfa_email_codes_user ON mfa_email_codes(user_id,purpose,created_at DESC);
    CREATE TABLE IF NOT EXISTS trusted_devices(id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL, label TEXT, ip TEXT, created_at TIMESTAMPTZ DEFAULT now(), last_used_at TIMESTAMPTZ DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON trusted_devices(user_id);`);
  // Lost phone and lost recovery codes: whoever controls the Railway variables can turn 2-step login off for one
  // account by setting ITTR_RESET_2FA=<username> and restarting (then remove the variable again).
  const reset = String(process.env.ITTR_RESET_2FA || '').trim().toLowerCase();
  if (reset) {
    const r = await db.query(`UPDATE auth_users SET totp_enabled=false,email_mfa_enabled=false,totp_secret=NULL,totp_pending_secret=NULL,totp_recovery='[]'::jsonb WHERE lower(username)=$1 RETURNING username`, [reset]);
    if (r.rowCount) console.warn(`ITTR: 2-step login turned off for ${reset} by ITTR_RESET_2FA. Remove that variable now.`);
  }
}

// v24.57.0: email codes and remembered devices.
export const TRUSTED_DEVICE_DAYS = 30;
const sha = v => crypto.createHash('sha256').update(String(v || '')).digest('hex');
export function maskEmail(e) { const [u, d] = String(e || '').split('@'); if (!d) return ''; return `${u.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(6, u.length - 2)))}@${d}`; }
export const validEmail = e => /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/.test(String(e || '')) && String(e).length <= 254;
export const hasSecondFactor = u => Boolean(u?.totp_enabled || u?.email_mfa_enabled);
// Send a 6-digit code by email (10 minutes, 5 tries). At most one every 30 seconds and 8 an hour per account.
export async function sendEmailCode(db, user, { purpose, email, sendEmail, shopName = 'ITTR ShopFlow' }) {
  const recent = (await db.query(`SELECT count(*) FILTER (WHERE created_at>now()-interval '30 seconds')::int s, count(*)::int h FROM mfa_email_codes WHERE user_id=$1 AND created_at>now()-interval '1 hour'`, [user.id])).rows[0];
  if (recent.s > 0) return { ok: false, status: 429, error: 'A code was just sent. Wait 30 seconds before asking for another.' };
  if (recent.h >= 8) return { ok: false, status: 429, error: 'Too many codes this hour. Try again later or use a recovery code.' };
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db.query(`UPDATE mfa_email_codes SET used_at=now() WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL`, [user.id, purpose]);
  await db.query(`INSERT INTO mfa_email_codes(user_id,purpose,email,code_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')`, [user.id, purpose, email, sha(`${user.id}:${code}`)]);
  const pretty = `${code.slice(0, 3)} ${code.slice(3)}`;
  const r = await sendEmail({ to: [email], subject: `${pretty} is your ${shopName} sign-in code`, idempotencyKey: `mfa-${user.id}-${Date.now()}`,
    text: `Your ${shopName} sign-in code is ${pretty}. It works for 10 minutes.\n\nIf you did not try to sign in, change your ShopFlow password: someone knows it.`,
    html: `<div style="font-family:Arial,sans-serif;color:#101828"><p>Your ${shopName} sign-in code:</p><p style="font-size:30px;font-weight:800;letter-spacing:4px;margin:8px 0">${pretty}</p><p style="color:#475467">It works for 10 minutes. If you did not try to sign in, change your ShopFlow password: someone knows it.</p></div>`,
    tags: [{ name: 'document', value: 'sign_in_code' }] }).catch(e => ({ ok: false, error: e?.message }));
  if (!r?.ok) { await db.query(`UPDATE mfa_email_codes SET used_at=now() WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL`, [user.id, purpose]); return { ok: false, status: 502, error: r?.error || 'The code email could not be sent.' }; }
  return { ok: true, sentTo: maskEmail(email) };
}
export async function verifyEmailCode(db, user, code, purpose) {
  const c = String(code || '').replace(/\D/g, ''); if (c.length !== 6) return null;
  const row = (await db.query(`SELECT * FROM mfa_email_codes WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1`, [user.id, purpose])).rows[0];
  if (!row || row.attempts >= 5) return null;
  const good = crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(sha(`${user.id}:${c}`)));
  if (!good) { await db.query('UPDATE mfa_email_codes SET attempts=attempts+1 WHERE id=$1', [row.id]); return null; }
  const r = await db.query('UPDATE mfa_email_codes SET used_at=now() WHERE id=$1 AND used_at IS NULL', [row.id]);
  return r.rowCount ? row : null;
}
export async function createTrustedDevice(db, user, { label = '', ip = '' } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO trusted_devices(user_id,token_hash,label,ip,expires_at) VALUES($1,$2,$3,$4,now()+($5||' days')::interval)`, [user.id, sha(token), String(label).slice(0, 160), String(ip).slice(0, 64), String(TRUSTED_DEVICE_DAYS)]);
  await db.query(`DELETE FROM trusted_devices WHERE user_id=$1 AND (expires_at<now() OR id NOT IN (SELECT id FROM trusted_devices WHERE user_id=$1 ORDER BY last_used_at DESC LIMIT 10))`, [user.id]);
  return token;
}
export async function isTrustedDevice(db, user, token) {
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(String(token || ''))) return false;
  const r = await db.query(`UPDATE trusted_devices SET last_used_at=now() WHERE user_id=$1 AND token_hash=$2 AND expires_at>now() RETURNING id`, [user.id, sha(token)]);
  return r.rowCount > 0;
}
export const forgetTrustedDevices = (db, userId) => db.query('DELETE FROM trusted_devices WHERE user_id=$1', [userId]);

// Second step of sign-in. Returns {ok:true} or {ok:false,reason}. A recovery code is used up when it works.
export async function checkSecondFactor(db, user, code) {
  const raw = String(code || '').trim(); if (!raw) return { ok: false, reason: 'missing' };
  if (/^\d[\d\s]{5,7}$/.test(raw)) {
    let keyProblem = false;
    if (user.totp_enabled) {
      let secret = null; try { secret = openTotpSecret(user.totp_secret); } catch (e) { if (e.code !== 'MFA_KEY') throw e; keyProblem = true; }
      const step = secret ? verifyTotp(secret, raw, user.totp_last_step) : null;
      if (step != null && (await db.query('UPDATE auth_users SET totp_last_step=$2 WHERE id=$1 AND totp_last_step<$2', [user.id, step])).rowCount) return { ok: true };
    }
    if (user.email_mfa_enabled && await verifyEmailCode(db, user, raw, 'login')) return { ok: true, viaEmail: true };
    return { ok: false, reason: keyProblem ? 'key' : 'bad' };
  }
  const h = hashRecovery(raw), list = Array.isArray(user.totp_recovery) ? user.totp_recovery : [];
  if (!list.includes(h)) return { ok: false, reason: 'bad' };
  const r = await db.query(`UPDATE auth_users SET totp_recovery=totp_recovery - $2 WHERE id=$1 AND totp_recovery ? $2`, [user.id, h]);
  return r.rowCount ? { ok: true, recoveryUsed: true, recoveryLeft: list.length - 1 } : { ok: false, reason: 'bad' };
}

export function registerMfaRoutes(app, { auth, ownerOnly, requireDb, audit, bcrypt, bwipjs, limiter, cleanUsername, sendEmail, shopName = 'ITTR ShopFlow' }) {
  const fail = (res, status, error, code) => res.status(status).json({ error, ...(code ? { code } : {}) });
  app.get('/api/auth/2fa', auth, async (req, res, next) => { try {
    const devices = Number((await requireDb().query('SELECT count(*)::int n FROM trusted_devices WHERE user_id=$1 AND expires_at>now()', [req.user.id])).rows[0].n);
    res.json({ enabled: hasSecondFactor(req.user), app: Boolean(req.user.totp_enabled), email: Boolean(req.user.email_mfa_enabled), emailTo: req.user.email_mfa_enabled ? maskEmail(req.user.email) : '',
      accountEmail: req.user.email || '', recommended: mfaRequiredForRole(req.user.role), recoveryLeft: Array.isArray(req.user.totp_recovery) ? req.user.totp_recovery.length : 0, rememberedDevices: devices });
  } catch (e) { next(e); } });
  // Email codes: confirm the password and the address with a code sent there, then sign-in asks for an emailed code.
  app.post('/api/auth/2fa/email/setup', limiter, auth, async (req, res, next) => { try {
    if (!(await bcrypt.compare(String(req.body?.password || ''), req.user.password_hash || ''))) return fail(res, 400, 'Your password is not correct.', 'BAD_PASSWORD');
    const email = String(req.body?.email || req.user.email || '').trim().toLowerCase(); if (!validEmail(email)) return fail(res, 400, 'Enter a valid email address.');
    const r = await sendEmailCode(requireDb(), req.user, { purpose: 'setup', email, sendEmail, shopName });
    if (!r.ok) return fail(res, r.status || 502, r.error);
    res.json({ ok: true, sentTo: r.sentTo });
  } catch (e) { next(e); } });
  app.post('/api/auth/2fa/email/enable', limiter, auth, async (req, res, next) => { try {
    const db = requireDb(), row = await verifyEmailCode(db, req.user, req.body?.code, 'setup');
    if (!row) return fail(res, 400, 'That code is not correct or has expired. Send a new one.', 'BAD_CODE');
    const hadCodes = Array.isArray(req.user.totp_recovery) && req.user.totp_recovery.length, codes = hadCodes ? null : newRecoveryCodes();
    await db.query(`UPDATE auth_users SET email=$2,email_mfa_enabled=true${codes ? ',totp_recovery=$3::jsonb' : ''},updated_at=now() WHERE id=$1`, codes ? [req.user.id, row.email, JSON.stringify(codes.map(hashRecovery))] : [req.user.id, row.email]);
    const out = await db.query('DELETE FROM auth_sessions WHERE user_id=$1 AND id<>$2', [req.user.id, req.user.session_id]);
    await audit(req.user.username, '2fa_email_enabled', { email: maskEmail(row.email), otherSessionsSignedOut: out.rowCount });
    res.json({ ok: true, sentTo: maskEmail(row.email), recoveryCodes: codes, otherSessionsSignedOut: out.rowCount });
  } catch (e) { next(e); } });
  app.get('/api/auth/devices', auth, async (req, res, next) => { try {
    const r = await requireDb().query('SELECT id,label,created_at,last_used_at,expires_at FROM trusted_devices WHERE user_id=$1 AND expires_at>now() ORDER BY last_used_at DESC', [req.user.id]);
    res.json({ items: r.rows });
  } catch (e) { next(e); } });
  app.delete('/api/auth/devices', auth, async (req, res, next) => { try {
    const r = await forgetTrustedDevices(requireDb(), req.user.id); await audit(req.user.username, 'remembered_devices_forgotten', { count: r.rowCount }); res.json({ ok: true, forgotten: r.rowCount });
  } catch (e) { next(e); } });
  // Step 1: confirm the password, get a new secret as a QR code for the authenticator app (not active yet).
  app.post('/api/auth/2fa/setup', limiter, auth, async (req, res, next) => { try {
    if (!(await bcrypt.compare(String(req.body?.password || ''), req.user.password_hash || ''))) return fail(res, 400, 'Your password is not correct.', 'BAD_PASSWORD');
    const secret = newTotpSecret(), label = encodeURIComponent(`ITTR ShopFlow:${req.user.username}`);
    const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('ITTR ShopFlow')}&algorithm=SHA1&digits=6&period=30`;
    await requireDb().query('UPDATE auth_users SET totp_pending_secret=$2 WHERE id=$1', [req.user.id, sealTotpSecret(secret)]);
    let qrSvg = ''; try { qrSvg = bwipjs.toSVG({ bcid: 'qrcode', text: uri, scale: 3, paddingwidth: 4, paddingheight: 4, backgroundcolor: 'FFFFFF' }); } catch (_) {}
    res.json({ secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, qrSvg });
  } catch (e) { next(e); } });
  // Step 2: type the 6-digit code the app shows. Turns 2-step login on, returns 10 recovery codes once, signs out
  // every other device so they have to sign in with the code too.
  app.post('/api/auth/2fa/enable', limiter, auth, async (req, res, next) => { try {
    const db = requireDb(), u = (await db.query('SELECT id,totp_pending_secret FROM auth_users WHERE id=$1', [req.user.id])).rows[0];
    if (!u?.totp_pending_secret) return fail(res, 409, 'Start the setup again.');
    let pending; try { pending = openTotpSecret(u.totp_pending_secret); } catch (e) { if (e.code === 'MFA_KEY') return fail(res, 503, 'The server cannot read this setup: its MFA_SECRET_KEY setting changed. Start the setup again.', 'MFA_KEY'); throw e; }
    const step = verifyTotp(pending, req.body?.code, 0);
    if (step == null) return fail(res, 400, 'That code is not correct. Check the phone clock and type the newest code.', 'BAD_CODE');
    const codes = newRecoveryCodes();
    await db.query(`UPDATE auth_users SET totp_secret=totp_pending_secret,totp_pending_secret=NULL,totp_enabled=true,totp_last_step=$2,totp_recovery=$3::jsonb,updated_at=now() WHERE id=$1`, [req.user.id, step, JSON.stringify(codes.map(hashRecovery))]);
    const out = await db.query('DELETE FROM auth_sessions WHERE user_id=$1 AND id<>$2', [req.user.id, req.user.session_id]);
    await audit(req.user.username, '2fa_enabled', { otherSessionsSignedOut: out.rowCount });
    res.json({ ok: true, recoveryCodes: codes, otherSessionsSignedOut: out.rowCount });
  } catch (e) { next(e); } });
  app.post('/api/auth/2fa/recovery-codes', limiter, auth, async (req, res, next) => { try {
    if (!hasSecondFactor(req.user)) return fail(res, 409, '2-step login is not on.');
    if (!(await bcrypt.compare(String(req.body?.password || ''), req.user.password_hash || ''))) return fail(res, 400, 'Your password is not correct.', 'BAD_PASSWORD');
    const codes = newRecoveryCodes();
    await requireDb().query('UPDATE auth_users SET totp_recovery=$2::jsonb WHERE id=$1', [req.user.id, JSON.stringify(codes.map(hashRecovery))]);
    await audit(req.user.username, '2fa_recovery_codes_replaced', {});
    res.json({ ok: true, recoveryCodes: codes });
  } catch (e) { next(e); } });
  // Turning it off needs the password AND a current code (or a recovery code).
  app.post('/api/auth/2fa/disable', limiter, auth, async (req, res, next) => { try {
    if (!hasSecondFactor(req.user)) return res.json({ ok: true });
    if (!(await bcrypt.compare(String(req.body?.password || ''), req.user.password_hash || ''))) return fail(res, 400, 'Your password is not correct.', 'BAD_PASSWORD');
    const db = requireDb(), chk = await checkSecondFactor(db, req.user, req.body?.code);
    if (!chk.ok) return fail(res, 400, 'That code is not correct.', 'BAD_CODE');
    await db.query(`UPDATE auth_users SET totp_enabled=false,email_mfa_enabled=false,totp_secret=NULL,totp_pending_secret=NULL,totp_recovery='[]'::jsonb,updated_at=now() WHERE id=$1`, [req.user.id]);
    await forgetTrustedDevices(db, req.user.id);
    await audit(req.user.username, '2fa_disabled', {});
    res.json({ ok: true });
  } catch (e) { next(e); } });
  // A manager lost their phone: the owner turns 2-step login off for them, and they sign in again and set it up anew.
  app.delete('/api/admin/managers/:username/2fa', auth, ownerOnly, async (req, res, next) => { try {
    const db = requireDb(), username = cleanUsername(req.params.username);
    const r = await db.query(`UPDATE auth_users SET totp_enabled=false,email_mfa_enabled=false,totp_secret=NULL,totp_pending_secret=NULL,totp_recovery='[]'::jsonb,updated_at=now() WHERE username=$1 AND role='manager' RETURNING id`, [username]);
    if (r.rowCount) await forgetTrustedDevices(db, r.rows[0].id);
    if (!r.rowCount) return fail(res, 404, 'Manager not found.');
    await db.query('DELETE FROM auth_sessions WHERE user_id=$1', [r.rows[0].id]);
    await audit(req.user.username, '2fa_reset_for_manager', { username });
    res.json({ ok: true });
  } catch (e) { next(e); } });
}
