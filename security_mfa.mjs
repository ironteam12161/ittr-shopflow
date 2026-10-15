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
    ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;`);
  // Lost phone and lost recovery codes: whoever controls the Railway variables can turn 2-step login off for one
  // account by setting ITTR_RESET_2FA=<username> and restarting (then remove the variable again).
  const reset = String(process.env.ITTR_RESET_2FA || '').trim().toLowerCase();
  if (reset) {
    const r = await db.query(`UPDATE auth_users SET totp_enabled=false,totp_secret=NULL,totp_pending_secret=NULL,totp_recovery='[]'::jsonb WHERE lower(username)=$1 RETURNING username`, [reset]);
    if (r.rowCount) console.warn(`ITTR: 2-step login turned off for ${reset} by ITTR_RESET_2FA. Remove that variable now.`);
  }
}

// Second step of sign-in. Returns {ok:true} or {ok:false,reason}. A recovery code is used up when it works.
export async function checkSecondFactor(db, user, code) {
  const raw = String(code || '').trim(); if (!raw) return { ok: false, reason: 'missing' };
  if (/^\d[\d\s]{5,7}$/.test(raw)) {
    const step = verifyTotp(user.totp_secret, raw, user.totp_last_step);
    if (step == null) return { ok: false, reason: 'bad' };
    const r = await db.query('UPDATE auth_users SET totp_last_step=$2 WHERE id=$1 AND totp_last_step<$2', [user.id, step]);
    return r.rowCount ? { ok: true } : { ok: false, reason: 'bad' };
  }
  const h = hashRecovery(raw), list = Array.isArray(user.totp_recovery) ? user.totp_recovery : [];
  if (!list.includes(h)) return { ok: false, reason: 'bad' };
  const r = await db.query(`UPDATE auth_users SET totp_recovery=totp_recovery - $2 WHERE id=$1 AND totp_recovery ? $2`, [user.id, h]);
  return r.rowCount ? { ok: true, recoveryUsed: true, recoveryLeft: list.length - 1 } : { ok: false, reason: 'bad' };
}

export function registerMfaRoutes(app, { auth, ownerOnly, requireDb, audit, bcrypt, bwipjs, limiter, cleanUsername }) {
  const fail = (res, status, error, code) => res.status(status).json({ error, ...(code ? { code } : {}) });
  app.get('/api/auth/2fa', auth, (req, res) => res.json({
    enabled: Boolean(req.user.totp_enabled), recommended: mfaRequiredForRole(req.user.role),
    recoveryLeft: Array.isArray(req.user.totp_recovery) ? req.user.totp_recovery.length : 0
  }));
  // Step 1: confirm the password, get a new secret as a QR code for the authenticator app (not active yet).
  app.post('/api/auth/2fa/setup', limiter, auth, async (req, res, next) => { try {
    if (!(await bcrypt.compare(String(req.body?.password || ''), req.user.password_hash || ''))) return fail(res, 400, 'Your password is not correct.', 'BAD_PASSWORD');
    const secret = newTotpSecret(), label = encodeURIComponent(`ITTR ShopFlow:${req.user.username}`);
    const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('ITTR ShopFlow')}&algorithm=SHA1&digits=6&period=30`;
    await requireDb().query('UPDATE auth_users SET totp_pending_secret=$2 WHERE id=$1', [req.user.id, secret]);
    let qrSvg = ''; try { qrSvg = bwipjs.toSVG({ bcid: 'qrcode', text: uri, scale: 3, paddingwidth: 4, paddingheight: 4, backgroundcolor: 'FFFFFF' }); } catch (_) {}
    res.json({ secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, qrSvg });
  } catch (e) { next(e); } });
  // Step 2: type the 6-digit code the app shows. Turns 2-step login on, returns 10 recovery codes once, signs out
  // every other device so they have to sign in with the code too.
  app.post('/api/auth/2fa/enable', limiter, auth, async (req, res, next) => { try {
    const db = requireDb(), u = (await db.query('SELECT id,totp_pending_secret FROM auth_users WHERE id=$1', [req.user.id])).rows[0];
    if (!u?.totp_pending_secret) return fail(res, 409, 'Start the setup again.');
    const step = verifyTotp(u.totp_pending_secret, req.body?.code, 0);
    if (step == null) return fail(res, 400, 'That code is not correct. Check the phone clock and type the newest code.', 'BAD_CODE');
    const codes = newRecoveryCodes();
    await db.query(`UPDATE auth_users SET totp_secret=totp_pending_secret,totp_pending_secret=NULL,totp_enabled=true,totp_last_step=$2,totp_recovery=$3::jsonb,updated_at=now() WHERE id=$1`, [req.user.id, step, JSON.stringify(codes.map(hashRecovery))]);
    const out = await db.query('DELETE FROM auth_sessions WHERE user_id=$1 AND id<>$2', [req.user.id, req.user.session_id]);
    await audit(req.user.username, '2fa_enabled', { otherSessionsSignedOut: out.rowCount });
    res.json({ ok: true, recoveryCodes: codes, otherSessionsSignedOut: out.rowCount });
  } catch (e) { next(e); } });
  app.post('/api/auth/2fa/recovery-codes', limiter, auth, async (req, res, next) => { try {
    if (!req.user.totp_enabled) return fail(res, 409, '2-step login is not on.');
    if (!(await bcrypt.compare(String(req.body?.password || ''), req.user.password_hash || ''))) return fail(res, 400, 'Your password is not correct.', 'BAD_PASSWORD');
    const codes = newRecoveryCodes();
    await requireDb().query('UPDATE auth_users SET totp_recovery=$2::jsonb WHERE id=$1', [req.user.id, JSON.stringify(codes.map(hashRecovery))]);
    await audit(req.user.username, '2fa_recovery_codes_replaced', {});
    res.json({ ok: true, recoveryCodes: codes });
  } catch (e) { next(e); } });
  // Turning it off needs the password AND a current code (or a recovery code).
  app.post('/api/auth/2fa/disable', limiter, auth, async (req, res, next) => { try {
    if (!req.user.totp_enabled) return res.json({ ok: true });
    if (!(await bcrypt.compare(String(req.body?.password || ''), req.user.password_hash || ''))) return fail(res, 400, 'Your password is not correct.', 'BAD_PASSWORD');
    const db = requireDb(), chk = await checkSecondFactor(db, req.user, req.body?.code);
    if (!chk.ok) return fail(res, 400, 'That code is not correct.', 'BAD_CODE');
    await db.query(`UPDATE auth_users SET totp_enabled=false,totp_secret=NULL,totp_pending_secret=NULL,totp_recovery='[]'::jsonb,updated_at=now() WHERE id=$1`, [req.user.id]);
    await audit(req.user.username, '2fa_disabled', {});
    res.json({ ok: true });
  } catch (e) { next(e); } });
  // A manager lost their phone: the owner turns 2-step login off for them, and they sign in again and set it up anew.
  app.delete('/api/admin/managers/:username/2fa', auth, ownerOnly, async (req, res, next) => { try {
    const db = requireDb(), username = cleanUsername(req.params.username);
    const r = await db.query(`UPDATE auth_users SET totp_enabled=false,totp_secret=NULL,totp_pending_secret=NULL,totp_recovery='[]'::jsonb,updated_at=now() WHERE username=$1 AND role='manager' RETURNING id`, [username]);
    if (!r.rowCount) return fail(res, 404, 'Manager not found.');
    await db.query('DELETE FROM auth_sessions WHERE user_id=$1', [r.rows[0].id]);
    await audit(req.user.username, '2fa_reset_for_manager', { username });
    res.json({ ok: true });
  } catch (e) { next(e); } });
}
