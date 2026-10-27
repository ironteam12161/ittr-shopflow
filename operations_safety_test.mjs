// v24.76.5: operations safety, on its own server because two of these end every session or stop the server.
// O1 the owner can sign out every account on every device (and forget remembered devices); nobody else can.
// O2 signing in with the setup password from Railway (BOOTSTRAP_ADMIN_PASSWORD) is reported, until it is changed.
// O3 SIGTERM: running requests finish, live phones are told the server is restarting, new connections are refused,
//    and the server exits cleanly.
// O4 started the way Railway starts it (`npm start`), the server receives SIGTERM (before v24.76.5 npm kept it).
// O5 failed sign-ins are recorded (reason, address, browser) for the owner, apart from real sign-ins, and kept 90 days;
//    a manager with Reports never sees sign-in addresses or browsers.
// O6 database time limits (db_pool.mjs): a connection dropped while in use fails one request instead of crashing the
//    server; a statement past its limit and a database that never answers give up.
// O7 the unit sync never waits on Samsara inside a transaction; a request stuck behind a lock answers 503.
// O8 MFA_SECRET_KEY: authenticator secrets encrypted in the database, old ones at startup, key change, lost key.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { dbSuiteGuard, reportSuite, startTestServer, ok, eq, sleep } from './test_harness.mjs';
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');
const NAME = 'operations safety';
dbSuiteGuard(NAME);
const OWNER = { username: 'owner', password: 'Shop-Boss-Pass-2026' };
const srv = await startTestServer({ prefix: 'ittr_ops_safety', admin: OWNER, env: { ITTR_SHUTDOWN_GRACE_MS: '6000' } });
const R = srv.request, db = srv.db, failures = [];
async function scenario(name, fn) { try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.error(`FAIL ${name}: ${e.message.split('\n')[0]}`); } }
const until = async (f, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(50); } return false; };
const socket = async tok => {
  const ws = new WebSocket(srv.base().replace('http', 'ws') + '/ws/shop-status'), msgs = []; ws.closed = null;
  ws.on('message', d => { try { msgs.push(JSON.parse(String(d))); } catch (_) {} }); ws.on('close', (code, reason) => { ws.closed = { code, reason: String(reason) }; });
  await new Promise((res, rej) => { ws.on('open', () => { ws.send(JSON.stringify({ type: 'auth', token: tok })); res(); }); ws.on('error', rej); });
  ok(await until(() => msgs.some(m => m.type === 'connected'), 4000), 'live socket connected'); return ws;
};
const MPASS = 'Manager-Pass-2026', KPASS = 'Mechanic-Pass-1';
try {
  const owner = await srv.login(OWNER.username, OWNER.password);
  await R('/api/admin/managers', { method: 'POST', token: owner, body: { username: 'opsmgr', display: 'Ops Manager', password: MPASS, permissions: { invoices: true, customers: true, inventory: true, reports: true, employees: true } } });
  await R('/api/admin/users', { method: 'POST', token: owner, body: { username: 'opsmech', display: 'Ops Mech', password: KPASS } });

  await scenario('O1 the owner signs out every account on every device (remembered devices too); a manager cannot', async () => {
    const ownerPhone = await srv.login(OWNER.username, OWNER.password), mgr = await srv.login('opsmgr', MPASS), mech = await srv.login('opsmech', KPASS);
    const uid = (await db.query("SELECT id FROM auth_users WHERE username='opsmgr'")).rows[0].id;
    await db.query("INSERT INTO trusted_devices(user_id,token_hash,label,expires_at) VALUES($1,'ops-safety-device','test phone',now()+interval '30 days')", [uid]);
    const mechLive = await socket(mech);
    eq((await R('/api/admin/sessions/revoke-all', { method: 'POST', token: mgr, body: {}, allowError: true })).status, 403, 'a manager cannot sign everyone out');
    eq((await R('/api/admin/sessions/revoke-all', { method: 'POST', token: mech, body: {}, allowError: true })).status, 403, 'a mechanic cannot sign everyone out');
    const r = await R('/api/admin/sessions/revoke-all', { method: 'POST', token: owner, body: {} });
    ok(r.signedOut >= 3, `other sign-ins ended (${r.signedOut})`); eq(r.devicesForgotten, 1, 'remembered devices forgotten');
    eq((await R('/api/auth/me', { token: owner, allowError: true })).status, 200, 'the owner stays signed in here');
    for (const [who, tok] of [['the owner on another device', ownerPhone], ['the manager', mgr], ['the mechanic', mech]]) eq((await R('/api/auth/me', { token: tok, allowError: true })).status, 401, `${who} is signed out`);
    eq(Number((await db.query('SELECT count(*) n FROM trusted_devices')).rows[0].n), 0, 'no remembered device left');
    ok(await until(() => mechLive.closed, 4000), 'the signed-out phone\'s live connection is dropped straight away');
    const a = (await db.query("SELECT details FROM server_audit WHERE action='all_sessions_signed_out' ORDER BY id DESC LIMIT 1")).rows[0];
    ok(a && a.details.sessions >= 3, 'recorded in the activity log');
  });

  await scenario('O2 signing in with the setup password from Railway is reported, until the password is changed', async () => {
    const first = await R('/api/auth/login', { method: 'POST', body: { username: OWNER.username, password: OWNER.password } });
    eq(first.setupPasswordInUse, true, 'the owner still uses BOOTSTRAP_ADMIN_PASSWORD: reported');
    const m = await R('/api/auth/login', { method: 'POST', body: { username: 'opsmech', password: KPASS } });
    eq(m.setupPasswordInUse, undefined, 'another password: nothing reported');
    const NEW = 'Shop-Changed-Pass-2026';
    await R('/api/auth/password', { method: 'POST', token: first.token, body: { currentPassword: OWNER.password, newPassword: NEW } });
    const after = await R('/api/auth/login', { method: 'POST', body: { username: OWNER.username, password: NEW } });
    eq(after.setupPasswordInUse, undefined, 'after the change: nothing reported');
    ok((await db.query("SELECT 1 FROM server_audit WHERE action='login' AND (details->>'setupPassword')::boolean")).rowCount >= 1, 'the sign-in with the setup password is in the activity log');
    const mgr = await srv.login('opsmgr', MPASS);
    eq((await R('/api/admin/security-events', { token: mgr, allowError: true })).status, 403, 'only the owner sees the sign-in list');
    const ev = (await R('/api/admin/security-events', { token: after.token })).items;
    const flagged = ev.find(e => e.action === 'login' && e.details?.setupPassword);
    ok(flagged && flagged.details.ip && 'device' in flagged.details, 'the owner\'s list shows the setup-password sign-in with its address and device');
    ok(ev.some(e => e.action === 'all_sessions_signed_out') && ev.some(e => e.action === 'own_password_changed'), 'and the sign-everyone-out and the password change');
    ok(!ev.some(e => !/login|lock|session|password|2fa|device/.test(e.action)), 'and nothing unrelated to sign-in security');
    const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
    ok(html.includes('d.setupPasswordInUse') && html.includes('signOutEveryone()') && html.includes('/api/admin/sessions/revoke-all'), 'the app shows the warning and has the Sign out everyone button');
    OWNER.password = NEW;
  });

  await scenario('O5 failed sign-ins are recorded with the reason, address and device; managers never see addresses', async () => {
    // Its own address, so this suite's other sign-ins do not share its rate limit (the server trusts one proxy hop).
    const H = { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.77', 'User-Agent': 'OpsSafety-Test/1.0' };
    const tryLogin = async body => (await fetch(srv.base() + '/api/auth/login', { method: 'POST', headers: H, body: JSON.stringify(body) })).status;
    const failedRows = async () => (await db.query("SELECT username,details FROM server_audit WHERE action='login_failed' AND details->>'ip'='203.0.113.77' ORDER BY id")).rows;
    eq(await tryLogin({ username: 'opsmech', password: 'not-the-password' }), 401, 'wrong password refused');
    eq(await tryLogin({ username: 'nobody-here', password: 'Typed-Into-Name-Box-1' }), 401, 'unknown account refused');
    await db.query("UPDATE auth_users SET email_mfa_enabled=true,email='opsmgr@example.test' WHERE username='opsmgr'");
    eq(await tryLogin({ username: 'opsmgr', password: MPASS, code: '000000' }), 401, 'wrong 2-step code refused');
    await db.query("UPDATE auth_users SET email_mfa_enabled=false,email=NULL,failed_logins=0 WHERE username='opsmgr'");
    const rows = await failedRows();
    eq(rows.map(r => r.details.reason).join(','), 'password,unknown_account,code', 'each failure recorded with its reason');
    ok(rows.every(r => r.details.device === 'OpsSafety-Test/1.0'), 'with the browser it came from');
    eq(rows[0].username, 'opsmech', 'a failure on a real account names the account'); eq(rows[0].details.inARow, 1, 'and counts the failures in a row');
    ok(rows[1].username === null && !JSON.stringify(rows[1]).includes('nobody-here') && !JSON.stringify(rows[1]).includes('Typed-Into'), 'a failure for a name with no account stores neither the name nor anything typed');
    const ownerTok = await srv.login(OWNER.username, OWNER.password), ev = await R('/api/admin/security-events', { token: ownerTok });
    ok(ev.failedLast24h >= 3 && ev.failures.some(f => f.details?.ip === '203.0.113.77'), 'the owner sees them under Failed sign-ins, with the 24-hour count');
    ok(!ev.items.some(e => e.action === 'login_failed') && ev.items.some(e => e.action === 'login'), 'apart from real sign-ins, so a burst of failures cannot push those out');
    const mgr = await srv.login('opsmgr', MPASS), log = (await R('/api/admin/server-audit', { token: mgr })).rows;
    ok(log.some(r => r.action === 'login') && !log.some(r => r.details && ('ip' in r.details || 'device' in r.details)), 'a manager with Reports sees sign-ins in the activity log without addresses or browsers');
    ok(!log.some(r => r.action === 'login_failed'), 'and without failed sign-ins');
    ok((await R('/api/admin/server-audit', { token: ownerTok })).rows.some(r => r.action === 'login' && r.details?.ip), 'the owner still sees addresses');
  });

  await scenario('O6 database time limits: a dropped connection in use fails one request, not the server; slow work is cut off', async () => {
    const { createPool, dbLimits, withoutStatementLimit, isDatabaseUnavailable } = await import('./db_pool.mjs');
    const d = dbLimits({}); eq(`${d.connectMs}/${d.statementMs}/${d.idleTxMs}`, '15000/120000/120000', 'defaults: 15 s to connect, 120 s per statement, 120 s idle in a transaction');
    const off = dbLimits({ ITTR_DB_STATEMENT_TIMEOUT_MS: '0', ITTR_DB_IDLE_TX_TIMEOUT_MS: 'nonsense' }); ok(off.statementMs === 0 && off.idleTxMs === 120000, '0 turns a limit off; a value that is not a number keeps the default');
    const quiet = { error: () => {} }, uncaught = [], onUncaught = e => uncaught.push(e.message);
    process.on('uncaughtException', onUncaught);
    const pool = createPool({ connectionString: process.env.DATABASE_URL, ssl: false, log: quiet, env: { ITTR_DB_STATEMENT_TIMEOUT_MS: '800', ITTR_DB_IDLE_TX_TIMEOUT_MS: '500' } });
    try {
      // A request holds a connection inside a transaction while it waits on something else; the database ends it.
      const c = await pool.connect(); await c.query('BEGIN'); await c.query('SELECT 1'); await sleep(1500);
      let err = null; try { await c.query('SELECT 2'); } catch (e) { err = e; }
      c.release(err || undefined);
      eq(uncaught.length, 0, `the dropped connection did not become an uncaught error (it crashed the server before) ${uncaught.join('; ')}`);
      ok(err && isDatabaseUnavailable(err), `that request fails as "database unavailable" (${err?.message})`);
      let slow = null; try { await pool.query('SELECT pg_sleep(2)'); } catch (e) { slow = e; }
      ok(slow?.code === '57014' && isDatabaseUnavailable(slow), 'a statement running past its limit is cancelled');
      eq((await withoutStatementLimit(pool, cl => cl.query('SELECT pg_sleep(1.2), true AS done'))).rows[0].done, true, 'maintenance work (index builds) may run longer');
      eq((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout, '800ms', 'and the limit applies again afterwards');
      eq((await pool.query('SELECT 3 AS n')).rows[0].n, 3, 'the pool keeps working');
    } finally { await pool.end(); }
    // A database address that accepts the connection and never answers (a network black hole).
    const hole = net.createServer(() => {}); await new Promise(r => hole.listen(0, '127.0.0.1', r));
    const stuck = createPool({ connectionString: `postgresql://u:p@127.0.0.1:${hole.address().port}/x`, ssl: false, log: quiet, env: { ITTR_DB_CONNECT_TIMEOUT_MS: '500' } });
    const t0 = Date.now(); let cerr = null; try { await stuck.query('SELECT 1'); } catch (e) { cerr = e; }
    await stuck.end().catch(() => {}); hole.close();
    ok(cerr && isDatabaseUnavailable(cerr) && Date.now() - t0 < 3000, `waiting for a database that does not answer gives up (${Date.now() - t0} ms: ${cerr?.message})`);
    process.off('uncaughtException', onUncaught);
    eq(uncaught.length, 0, 'nothing uncaught');
  });

  await scenario('O7 the server: Samsara is never waited on inside a transaction; a query stuck on a lock answers 503, not forever', async () => {
    const srv2 = await startTestServer({ prefix: 'ittr_ops_limits', admin: { username: 'owner2', password: 'Limits-Owner-2026!' }, env: {
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${new URL('./samsara_stub_preload.mjs', import.meta.url).href}`.trim(),
      ITTR_TEST_SAMSARA_DELAY_MS: '1500', SAMSARA_API_TOKEN: 'stub-token', PGAPPNAME: 'ittr-ops-o7', ITTR_DB_STATEMENT_TIMEOUT_MS: '2000' } });
    try {
      const tok = await srv2.login('owner2', 'Limits-Owner-2026!');
      const idleTx = async () => Number((await db.query("SELECT count(*) n FROM pg_stat_activity WHERE application_name='ittr-ops-o7' AND state LIKE 'idle in transaction%'")).rows[0].n);
      const sync = srv2.request('/api/samsara/unit-sync', { method: 'POST', token: tok, body: {}, allowError: true }).catch(e => ({ status: 'no answer: ' + e.message }));
      let held = 0; const t = Date.now(); while (Date.now() - t < 1200) { held = Math.max(held, await idleTx()); await sleep(50); }
      eq(held, 0, 'while Samsara is slow, no database transaction is held open waiting for it');
      const out = await sync; eq(out.status, 200, `the unit sync finishes (${JSON.stringify(out).slice(0, 120)})`);
      // Another connection holds the shop record locked and never finishes (a stuck transaction).
      const lock = await srv2.db.connect();
      try {
        await lock.query('BEGIN'); await lock.query('LOCK TABLE app_state IN ACCESS EXCLUSIVE MODE');
        const t1 = Date.now(), r = await fetch(srv2.base() + '/api/state', { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(8000) }).catch(e => ({ status: 'no answer: ' + e.message }));
        const body = typeof r.json === 'function' ? await r.json().catch(() => ({})) : {};
        eq(r.status, 503, `a request stuck behind the lock answers 503 after the statement limit (${Date.now() - t1} ms)`);
        eq(body.code, 'DB_UNAVAILABLE', 'with "the database is busy or not answering", so the phone retries');
      } finally { await lock.query('ROLLBACK').catch(() => {}); lock.release(); }
      eq((await fetch(srv2.base() + '/api/health/live')).status, 200, 'the server is still up');
      eq((await srv2.request('/api/state', { token: tok })).status, 200, 'and answers normally once the lock is gone');
    } finally { await srv2.cleanup(); }
  });

  await scenario('O8 with MFA_SECRET_KEY, authenticator secrets are encrypted in the database; old ones at startup; the key can be changed', async () => {
    const { totpCode, totpStep } = await import('./security_mfa.mjs');
    const KEY1 = 'shop-mfa-key-one-2026', KEY2 = 'shop-mfa-key-two-2026', P = 'Mfa-Owner-Pass-2026';
    const env = { MFA_SECRET_KEY: KEY1 }, srv3 = await startTestServer({ prefix: 'ittr_ops_mfa', admin: { username: 'owner3', password: P }, env });
    try {
      const restart = async changes => { await srv3.stop(); Object.assign(env, changes); await srv3.start(); };
      const stored = async u => (await srv3.db.query('SELECT totp_secret s,totp_pending_secret p FROM auth_users WHERE username=$1', [u])).rows[0];
      const signIn = (u, code, pw = P) => srv3.request('/api/auth/login', { method: 'POST', body: { username: u, password: pw, code }, allowError: true });
      // A code's 30-second step can be used once (replay protection); each sign-in here starts from a fresh step.
      const appCode = async (u, sec) => { await srv3.db.query('UPDATE auth_users SET totp_last_step=0 WHERE username=$1', [u]); return totpCode(sec, totpStep()); };
      const tok = await srv3.login('owner3', P);
      const setup = await srv3.request('/api/auth/2fa/setup', { method: 'POST', token: tok, body: { password: P } }), secret = setup.secret.replace(/\s/g, '');
      const pend = await stored('owner3');
      ok(pend.p.startsWith('enc1.') && !pend.p.includes(secret), 'the secret waiting for the first code is stored encrypted');
      const en = await srv3.request('/api/auth/2fa/enable', { method: 'POST', token: tok, body: { code: totpCode(secret, totpStep()) } });
      const act = await stored('owner3');
      ok(en.ok && act.s.startsWith('enc1.') && !act.s.includes(secret) && act.p === null, 'turned on: stored encrypted, nothing in plain form');
      eq((await signIn('owner3', await appCode('owner3', secret))).status, 200, 'signing in with the app code works');
      // A secret saved before encryption (plain) is encrypted when the server starts.
      await srv3.request('/api/admin/managers', { method: 'POST', token: (await signIn('owner3', en.recoveryCodes[0])).token, body: { username: 'mfamgr', display: 'Mfa Manager', password: MPASS, permissions: { invoices: true } } });
      const plain = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
      await srv3.db.query("UPDATE auth_users SET totp_secret=$1,totp_enabled=true,totp_last_step=0 WHERE username='mfamgr'", [plain]);
      await restart({});
      const mig = await stored('mfamgr');
      ok(mig.s.startsWith('enc1.') && !mig.s.includes(plain), 'a plain secret saved before is encrypted at startup');
      eq((await signIn('mfamgr', await appCode('mfamgr', plain), MPASS)).status, 200, 'and its app keeps working');
      // Changing the key: the old one goes in MFA_SECRET_KEY_OLD for one deploy.
      const before = (await stored('owner3')).s;
      await restart({ MFA_SECRET_KEY: KEY2, MFA_SECRET_KEY_OLD: KEY1 });
      const after = (await stored('owner3')).s;
      ok(after.startsWith('enc1.') && after !== before, 're-encrypted with the new key at startup');
      await restart({ MFA_SECRET_KEY_OLD: '' });
      eq((await signIn('owner3', await appCode('owner3', secret))).status, 200, 'with only the new key, the app code still works');
      // Turning encryption off (before going back to an older version): the key moves to MFA_SECRET_KEY_OLD.
      await restart({ MFA_SECRET_KEY: '', MFA_SECRET_KEY_OLD: KEY2 });
      eq((await stored('owner3')).s, secret, 'with only the old key set, startup stores the secret in plain form again');
      eq((await signIn('owner3', await appCode('owner3', secret))).status, 200, 'and the app code works');
      await restart({ MFA_SECRET_KEY: KEY2, MFA_SECRET_KEY_OLD: '' });
      ok((await stored('owner3')).s.startsWith('enc1.'), 'with the key back, it is encrypted again');
      // The key is lost: say so, do not count it as a wrong code, and let recovery codes in.
      await restart({ MFA_SECRET_KEY: '' });
      ok(/ITTR SETUP: \d+ authenticator secret\(s\) cannot be read: MFA_SECRET_KEY is not set/.test(srv3.output()), 'startup reports secrets it cannot read');
      const lost = await signIn('owner3', await appCode('owner3', secret));
      ok(lost.status === 503 && lost.code === 'MFA_KEY', `an app code answers "cannot be checked right now" (${lost.status} ${lost.code}), not "wrong code"`);
      eq(Number((await srv3.db.query("SELECT failed_logins n FROM auth_users WHERE username='owner3'")).rows[0].n), 0, 'and does not count towards the account lock');
      eq((await signIn('owner3', en.recoveryCodes[1])).status, 200, 'a recovery code still signs in');
    } finally { await srv3.cleanup(); }
  });

  await scenario('O3 SIGTERM: a running request finishes, live phones hear "restarting", new connections are refused, clean exit', async () => {
    const tok = await srv.login(OWNER.username, OWNER.password), live = await socket(tok), child = srv.child();
    // A request already on its way: headers sent, body still coming.
    const body = JSON.stringify({ username: OWNER.username, password: OWNER.password }), port = Number(new URL(srv.base()).port);
    const req = net.connect(port, '127.0.0.1'); await new Promise(r => req.once('connect', r));
    let reply = ''; req.on('data', d => { reply += d; });
    req.write(`POST /api/auth/login HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, 10)}`);
    await sleep(200);
    const exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal })));
    child.kill('SIGTERM');
    ok(await until(() => live.closed, 3000), 'the live connection is closed');
    eq(live.closed.code, 1012, 'with "service restart" (1012), so the phone reconnects to the new server at once');
    const refused = await new Promise(r => { const c = net.connect(port, '127.0.0.1'); c.once('connect', () => { c.destroy(); r(false); }); c.once('error', () => r(true)); });
    ok(refused, 'new connections are refused while stopping');
    req.write(body.slice(10));
    ok(await until(() => /\r\n\r\n/.test(reply), 4000), 'the request that was already running gets its answer');
    ok(/^HTTP\/1\.1 200/.test(reply) && /"token":"/.test(reply), `it is answered normally (${reply.split('\r\n')[0]})`);
    ok(/connection: close/i.test(reply), 'and told to close the connection');
    const end = await Promise.race([exited, sleep(8000).then(() => null)]);
    ok(end, 'the server exits on its own'); eq(end.code, 0, 'with a clean exit code');
    ok(/\[shutdown\] SIGTERM/.test(srv.output()) && /\[shutdown\] done/.test(srv.output()), 'and says so in the log');
  });

  await scenario('O4 started with `npm start` (as Railway does), the server receives SIGTERM and stops cleanly', async () => {
    const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    // Failed sign-ins are kept for 90 days: the server started below removes older ones at startup.
    await db.query(`INSERT INTO server_audit(username,action,details,created_at) VALUES
      ('opsmech','login_failed','{"reason":"password","marker":"prune-old"}',now()-interval '91 days'),
      ('opsmech','login_failed','{"reason":"password","marker":"prune-keep"}',now()-interval '89 days')`);
    let out = ''; const env = { ...process.env, PORT: String(port), NODE_ENV: 'test', PGOPTIONS: `-c search_path=${srv.schema}`, OPENAI_API_KEY: '', OPENROUTER_API_KEY: '', SAMSARA_API_TOKEN: '', ITTR_SHUTDOWN_GRACE_MS: '4000' };
    const npm = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['start'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    npm.stdout.on('data', d => out += d); npm.stderr.on('data', d => out += d);
    const up = await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/health/live`)).ok; } catch { return false; } }, 20000);
    ok(up, `the server started through npm start\n${out.slice(-400)}`);
    const markers = async () => (await db.query("SELECT details->>'marker' m FROM server_audit WHERE details ? 'marker' ORDER BY 1")).rows.map(r => r.m).join(',');
    ok(await until(async () => (await markers()) === 'prune-keep', 5000), `failed sign-ins older than 90 days were removed at startup, newer ones kept (${await markers()})`);
    const exited = new Promise(r => npm.once('exit', code => r(code)));
    npm.kill('SIGTERM');
    const code = await Promise.race([exited, sleep(8000).then(() => 'timeout')]);
    ok(/\[shutdown\] SIGTERM/.test(out), `Node got the signal through npm (log: ${out.split('\n').filter(l => /shutdown/.test(l)).join(' | ') || 'no shutdown line'})`);
    ok(code !== 'timeout', 'npm start ended');
    const gone = await until(async () => { try { await fetch(`http://127.0.0.1:${port}/api/health/live`); return false; } catch { return true; } }, 6000);
    ok(gone, 'no server left running after npm start ended');
  });
} catch (e) { failures.push(`setup: ${e.message.split('\n')[0]}`); console.error(e); }
finally { await srv.cleanup(); }

if (failures.length) { reportSuite(NAME, 'FAILED', failures.join('; ')); console.error(`FAIL ${NAME}: ${failures.length} scenario(s)`); process.exit(1); }
reportSuite(NAME, 'PASSED'); console.log(`PASS ${NAME}`);
