// v24.76.5: operations safety, on its own server because two of these end every session or stop the server.
// O1 the owner can sign out every account on every device (and forget remembered devices); nobody else can.
// O2 signing in with the setup password from Railway (BOOTSTRAP_ADMIN_PASSWORD) is reported, until it is changed.
// O3 SIGTERM: running requests finish, live phones are told the server is restarting, new connections are refused,
//    and the server exits cleanly.
// O4 started the way Railway starts it (`npm start`), the server receives SIGTERM (before v24.76.5 npm kept it).
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
    let out = ''; const env = { ...process.env, PORT: String(port), NODE_ENV: 'test', PGOPTIONS: `-c search_path=${srv.schema}`, OPENAI_API_KEY: '', OPENROUTER_API_KEY: '', SAMSARA_API_TOKEN: '', ITTR_SHUTDOWN_GRACE_MS: '4000' };
    const npm = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['start'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    npm.stdout.on('data', d => out += d); npm.stderr.on('data', d => out += d);
    const up = await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/health/live`)).ok; } catch { return false; } }, 20000);
    ok(up, `the server started through npm start\n${out.slice(-400)}`);
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
