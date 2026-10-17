// v24.71.0: security regression suite for the October 2026 audit (S2, S3, S4, E1) — real server + disposable database.
// S2  mechanic A never receives mechanic B's work orders, findings or customers in ANY response (reads, every mutation a
//     mechanic can reach, errors), and helpers / parts / timing / inspection / self-start keep working.
// S3  role × permission matrix for /api/smart-search, /api/customer-units/suggest and the self-start lookup: forbidden
//     categories and contact fields are absent, not just hidden.
// S4  a live socket that stays open is closed on sign-out, "sign out other devices", password reset, account delete and
//     session expiry; mechanics get only refresh signals; the old ?token= form and oversized frames are refused.
// E1  /api/health/live always answers; /api/health (readiness) answers 503 while the database or schema is missing and
//     recovers by itself; a server whose database is unreachable at startup never starts serving.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dbSuiteGuard, reportSuite, startTestServer, ok, eq, sleep } from './test_harness.mjs';
const NAME = 'security integration';
dbSuiteGuard(NAME);
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');

const OWNER = { username: 'owner', password: 'Shop-Boss-Pass-2026' };
const srv = await startTestServer({ prefix: 'ittr_sec', admin: OWNER, env: { ITTR_LIVE_RECHECK_MS: '1000' } });
const R = srv.request;
const failures = [];
async function scenario(name, fn) { try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.error(`FAIL ${name}: ${e.message.split('\n')[0]}`); } }
// Markers that belong only to mechanic B's work and to private customer contact details.
const B_MARKERS = ['BOB-SECRET-UNIT', 'Bobs Hidden Fleet', 'B-FINDING-SECRET', 'bob-only-note'];
const CONTACT = { email: 'secret-contact@fleet.test', phone: '555-0199-777', address: '42 Hidden Yard Rd' };
const noB = (obj, where) => { const s = JSON.stringify(obj); for (const m of B_MARKERS) ok(!s.includes(m), `${where}: leaked "${m}"`); };
const T = (uid, t, x = {}) => ({ uid, t, done: false, startedAt: '', stoppedAt: '', elapsedMs: 0, ...x });

try {
  const owner = await srv.login(OWNER.username, OWNER.password);
  for (const u of ['mecha', 'mechb', 'mechc']) await R('/api/admin/users', { method: 'POST', token: owner, body: { username: u, display: u.toUpperCase(), password: 'Mechanic-Pass-1' } });
  const mgr = async (username, permissions) => { await R('/api/admin/managers', { method: 'POST', token: owner, body: { username, display: username, password: 'Manager-Pass-2026', permissions } }); return srv.login(username, 'Manager-Pass-2026'); };
  const mgrNone = await mgr('mgrnone', {}), mgrCust = await mgr('mgrcust', { customers: true }), mgrInv = await mgr('mgrinv', { invoices: true });
  const mechA = await srv.login('mecha', 'Mechanic-Pass-1'), mechB = await srv.login('mechb', 'Mechanic-Pass-1');

  // Customers, units and an invoice with contact details that must stay office-only.
  const cust = await R('/api/customers', { method: 'POST', token: owner, body: { customer_name: 'Contact Test Fleet', email: CONTACT.email, phone: CONTACT.phone, address: CONTACT.address, dot_number: '7654321' } });
  const custId = cust.item?.id || cust.customer?.id || cust.id;
  await R(`/api/customers/${custId}/units`, { method: 'POST', token: owner, body: { unit_number: 'CT-500', vin: '', make: 'Volvo', notes: 'unit-private-note' } });
  const part = await R('/api/parts', { method: 'POST', token: owner, body: { partNumber: 'SEC-FLT-1', description: 'Security filter', quantity: 5, cost: 4, price: 9 } });
  const partId = Number(part.item?.id || part.part?.id || part.id);
  await R('/api/invoices', { method: 'POST', token: owner, body: { customerId: custId, customerName: 'Contact Test Fleet', unitNumber: 'CT-500' } });

  const st = await R('/api/state', { token: owner }); const sf = st.shopflow.payload;
  sf.workorders = [
    { id: 701, unit: 'ALICE-UNIT-1', customer: 'Alice Fleet', status: 'In Progress', mechanic: 'mecha', helpers: [], unitType: 'customer', truckHere: true, date: '2026-10-16', time: '08:00', tasks: [T('a-t1', 'Brake job')], inspection: { required: true, type: 'truck', status: 'In Progress', results: {} } },
    { id: 702, unit: 'BOB-SECRET-UNIT', customer: 'Bobs Hidden Fleet', notes: 'bob-only-note', status: 'In Progress', mechanic: 'mechb', helpers: [], unitType: 'customer', truckHere: true, date: '2026-10-16', time: '09:00', tasks: [T('b-t1', 'Bob job')] },
  ];
  sf.issues = [
    { id: 'ia1', wo: 701, mechanic: 'mecha', description: 'Alice finding', approval: 'Waiting for Customer' },
    { id: 'ib1', wo: 702, mechanic: 'mechb', description: 'B-FINDING-SECRET', approval: 'Waiting for Customer' },
  ];
  sf.privateOfficeKey = { note: 'bob-only-note' }; // any other top-level key is office data
  await R('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf, expectedVersion: st.shopflow.version } });
  await R('/api/timeclock/punch', { method: 'POST', token: mechA, body: { action: 'in' } });

  await scenario('S2 reads: GET /api/state and history versions are scoped to mechanic A', async () => {
    const s = await R('/api/state', { token: mechA }); noB(s, 'GET /api/state');
    eq(s.shopflow.payload.workorders.length, 1, 'A sees one work order');
    ok(!('privateOfficeKey' in s.shopflow.payload), 'other top-level keys are not sent to a mechanic');
    const v = await R(`/api/state/shopflow/version/${s.shopflow.version}`, { token: mechA }); noB(v, 'history version');
  });

  await scenario('S2 mutations: helpers, parts, timing, inspection, activity, focus, clock — no B data', async () => {
    let r = await R('/api/work-orders/701/helpers', { method: 'POST', token: mechA, body: { username: 'mechc' } }); noB(r, 'add helper');
    ok(r.shopflow.workorders.some(w => w.id === 701 && (w.helpers || []).some(h => String(h.username || h).toLowerCase() === 'mechc')), 'helper added and returned');
    r = await R('/api/work-orders/701/helpers/mechc', { method: 'DELETE', token: mechA }); noB(r, 'remove helper');
    r = await R('/api/work-orders/701/tasks/by-uid/a-t1/action', { method: 'POST', token: mechA, body: { action: 'start' } }); noB(r, 'task start');
    ok(r.shopflow.workorders.find(w => w.id === 701).tasks[0].startedAt, 'timer started');
    r = await R('/api/work-orders/701/tasks/by-uid/a-t1/parts', { method: 'POST', token: mechA, body: { inventoryPartId: partId, partNumber: 'SEC-FLT-1', description: 'Security filter', qty: 1 } }); noB(r, 'add part');
    const added = r.part?.id || r.shopflow.workorders.find(w => w.id === 701).tasks[0].parts?.at(-1)?.id;
    ok(added, 'part added');
    r = await R(`/api/work-orders/701/tasks/by-uid/a-t1/parts/${encodeURIComponent(added)}`, { method: 'DELETE', token: mechA }); noB(r, 'remove part');
    r = await R('/api/work-orders/701/tasks/by-uid/a-t1/action', { method: 'POST', token: mechA, body: { action: 'pause', reason: 'Waiting on parts' } }); noB(r, 'task pause');
    r = await R('/api/work-orders/701/tasks/by-uid/a-t1/action', { method: 'POST', token: mechA, body: { action: 'resume' } }); noB(r, 'task resume');
    r = await R('/api/work-orders/701/inspection', { method: 'POST', token: mechA, body: { inspection: { status: 'In Progress', results: { brakes: { status: 'ok' } } } } }); noB(r, 'inspection save');
    r = await R('/api/mechanic/focus-inspection', { method: 'POST', token: mechA, body: { workOrderId: '701' } }); noB(r, 'focus inspection');
    r = await R('/api/mechanic/activity', { method: 'POST', token: mechA, body: { action: 'start', code: 'parts', note: 'parts run' } }); noB(r, 'activity');
    r = await R('/api/timeclock/punch', { method: 'POST', token: mechA, body: { action: 'out' } }); noB(r, 'clock out');
    ok(!JSON.stringify(r).includes('ALICE-UNIT-1') || !('shopflow' in (r.stopped || {})), 'clock-out does not return the shop record');
    await R('/api/timeclock/punch', { method: 'POST', token: mechA, body: { action: 'in' } });
  });

  await scenario('S2 errors: touching B\'s work order is refused without B\'s data', async () => {
    for (const [path, method, body] of [['/api/work-orders/702/helpers', 'POST', { username: 'mechc' }], ['/api/work-orders/702/tasks/by-uid/b-t1/action', 'POST', { action: 'start' }], ['/api/work-orders/702/inspection', 'POST', { inspection: { status: 'In Progress' } }], ['/api/work-orders/702/task-sessions', 'GET'], ['/api/work-orders/702/pdf', 'GET']]) {
      const r = await R(path, { method, token: mechA, body, allowError: true });
      ok(r.status >= 400, `${method} ${path} refused (got ${r.status})`); noB(r, `${method} ${path}`);
    }
  });

  await scenario('S2 self-start (USDOT/VIN) still works and returns only A\'s work', async () => {
    const lk = await R('/api/work-orders/self-start/lookup?unit=CT-500', { token: mechA }); noB(lk, 'lookup');
    ok((lk.matches || []).some(m => m.unit_number === 'CT-500'), 'unit found by mechanic');
    const s = JSON.stringify(lk); for (const v of Object.values(CONTACT)) ok(!s.includes(v), `mechanic lookup leaked contact ${v}`);
    const r = await R('/api/work-orders/self-start', { method: 'POST', token: mechA, body: { unit: 'CT-500', customer: 'Contact Test Fleet', jobs: ['Check lights'] } });
    noB(r, 'self-start'); ok(r.workOrder?.id, 'work order created');
    ok(r.shopflow.workorders.every(w => w.mechanic === 'mecha' || (w.helpers || []).some(h => String(h.username || h) === 'mecha')), 'self-start response has only A\'s work orders');
  });

  await scenario('S3 matrix: smart-search and unit suggestions follow permissions', async () => {
    const roles = { owner, mgrNone, mgrCust, mgrInv };
    const out = {};
    for (const [k, tok] of Object.entries(roles)) out[k] = await R('/api/smart-search?q=Contact%20Test', { token: tok });
    const inv = await R('/api/smart-search?q=CT-500', { token: owner });
    ok(out.owner.customers.length >= 1, 'owner sees customers');
    eq(out.mgrNone.customers.length, 0, 'manager without Customers gets no customers');
    ok(!JSON.stringify(out.mgrNone).includes(CONTACT.email) && !JSON.stringify(out.mgrNone).includes(CONTACT.phone), 'no contact for manager without Customers');
    ok(out.mgrCust.customers.length >= 1 && JSON.stringify(out.mgrCust).includes(CONTACT.email), 'manager with Customers sees contact');
    const invNone = await R('/api/smart-search?q=CT-500', { token: mgrNone }), invCust = await R('/api/smart-search?q=CT-500', { token: mgrCust }), invInv = await R('/api/smart-search?q=CT-500', { token: mgrInv });
    eq((invNone.invoices || []).length, 0, 'manager without Invoices gets no invoices');
    eq((invCust.invoices || []).length, 0, 'Customers permission alone gets no invoices');
    ok(!JSON.stringify(invNone).includes('balance_due') && !JSON.stringify(invCust).includes('balance_due'), 'no balances without Invoices');
    ok((inv.invoices || []).length >= 1, 'owner finds the invoice'); ok((invInv.invoices || []).length >= 1, 'manager with Invoices sees invoices');
    ok(!JSON.stringify(invNone).includes('unit-private-note'), 'unit notes need Customers');
    ok(invNone.units.some(u => u.unit_number === 'CT-500'), 'units stay searchable for every manager');
    const sug = {}; for (const [k, tok] of Object.entries({ ...roles, mechA })) sug[k] = await R('/api/customer-units/suggest?q=CT-500', { token: tok });
    for (const k of ['mgrNone', 'mechA']) { const s = JSON.stringify(sug[k]); ok(sug[k].items.some(x => x.unit_number === 'CT-500'), `${k} still finds the unit`); ok(!s.includes(CONTACT.email) && !s.includes(CONTACT.phone), `${k} gets no customer contact`); ok(!/samsara_l(at|ong)|samsara_driver/.test(s), `${k} gets no live GPS/driver`); }
    for (const k of ['owner', 'mgrCust', 'mgrInv']) ok(JSON.stringify(sug[k]).includes(CONTACT.email), `${k} keeps customer email (estimates/invoices need it)`);
    const lkOwner = await R('/api/work-orders/self-start/lookup?unit=CT-500', { token: owner }); ok(JSON.stringify(lkOwner).includes(CONTACT.email), 'owner lookup keeps contact');
    const deny = await R('/api/smart-search?q=Contact', { token: mechA, allowError: true }); eq(deny.status, 403, 'mechanic cannot use smart-search');
    const so = await R('/api/service-orders/1/to-invoice', { method: 'POST', token: mgrNone, body: {}, allowError: true }); eq(so.status, 403, 'service order → invoice needs Invoices');
  });

  // ---------- S4 live sockets ----------
  const wsUrl = q => srv.base().replace('http', 'ws') + '/ws/shop-status' + (q || '');
  function openSocket(token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl()); const msgs = []; let closed = null;
      ws.on('message', d => { try { msgs.push(JSON.parse(String(d))); } catch (_) {} });
      ws.on('close', (code, reason) => { closed = { code, reason: String(reason) }; });
      ws.on('error', () => {});
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
      const t0 = Date.now(); (function wait() { if (msgs.some(m => m.type === 'connected')) return resolve({ ws, msgs, closed: () => closed }); if (closed || Date.now() - t0 > 5000) return reject(new Error(`socket not admitted (${JSON.stringify(closed)})`)); setTimeout(wait, 30); })();
    });
  }
  const closedWithin = async (s, ms, what) => { const t0 = Date.now(); while (!s.closed() && Date.now() - t0 < ms) await sleep(50); ok(s.closed(), `${what}: socket still open after ${ms} ms`); };

  await scenario('S4 sign-out (from another client) closes the lingering socket', async () => {
    const tok = await srv.login('mechb', 'Mechanic-Pass-1'); const s = await openSocket(tok);
    await R('/api/auth/logout', { method: 'POST', token: tok, body: {} });
    await closedWithin(s, 3000, 'logout');
  });
  await scenario('S4 "sign out other devices" and password reset close sockets', async () => {
    const t1 = await srv.login('mechc', 'Mechanic-Pass-1'), t2 = await srv.login('mechc', 'Mechanic-Pass-1');
    const s1 = await openSocket(t1);
    await R('/api/auth/sessions/revoke-others', { method: 'POST', token: t2, body: {} });
    await closedWithin(s1, 3000, 'revoke others');
    const s2 = await openSocket(t2);
    await R('/api/admin/users/mechc/password', { method: 'PATCH', token: owner, body: { password: 'Mechanic-Pass-2' } });
    await closedWithin(s2, 3000, 'owner password reset');
  });
  await scenario('S4 account delete and session expiry close sockets', async () => {
    await R('/api/admin/users', { method: 'POST', token: owner, body: { username: 'mechtmp', display: 'Tmp', password: 'Mechanic-Pass-1' } });
    const tt = await srv.login('mechtmp', 'Mechanic-Pass-1'); const s = await openSocket(tt);
    await R('/api/admin/users/mechtmp', { method: 'DELETE', token: owner });
    await closedWithin(s, 3000, 'account delete');
    const te = await srv.login('mechb', 'Mechanic-Pass-1'); const se = await openSocket(te);
    await srv.db.query("UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE user_id=(SELECT id FROM auth_users WHERE username='mechb')");
    await closedWithin(se, 4000, 'session expiry');
  });
  await scenario('S4 mechanics get refresh signals only; office gets details; legacy ?token= and big frames refused', async () => {
    const tb = await srv.login('mechb', 'Mechanic-Pass-1');
    const sm = await openSocket(tb), so = await openSocket(owner);
    await R('/api/work-orders/701/tasks/by-uid/a-t1/action', { method: 'POST', token: mechA, body: { action: 'resume' } });
    await sleep(500);
    const mm = sm.msgs.filter(m => m.type !== 'connected'), om = so.msgs.filter(m => m.type !== 'connected');
    ok(mm.length >= 1, 'mechanic got a refresh signal');
    ok(mm.every(m => Object.keys(m).sort().join() === 'at,type'), `mechanic messages carry no details: ${JSON.stringify(mm)}`);
    ok(om.some(m => m.by === 'mecha'), 'office still gets who changed what');
    sm.ws.close(); so.ws.close();
    const legacy = await new Promise(res => { const w = new WebSocket(wsUrl(`?token=${encodeURIComponent(owner)}`)); let got = false; w.on('message', d => { if (/connected/.test(String(d))) got = true; }); w.on('close', c => res({ got, c })); w.on('error', () => {}); });
    ok(!legacy.got && legacy.c === 1008, `legacy URL token refused (code ${legacy.c})`);
    const big = await openSocket(owner); big.ws.send('x'.repeat(10000)); await closedWithin(big, 3000, 'oversized frame');
    eq(big.closed().code, 1009, 'oversized frame closes with 1009');
  });

  // ---------- E1 readiness ----------
  await scenario('E1 liveness always 200; readiness 503 on missing schema and recovers', async () => {
    const live = await R('/api/health/live'); ok(live.ok && live.live, 'live');
    const ready = await R('/api/health'); ok(ready.ok && ready.ready && ready.db && ready.schema, 'ready');
    await srv.db.query('ALTER TABLE app_state RENAME TO app_state_moved');
    try {
      const down = await R('/api/health', { allowError: true }); eq(down.status, 503, 'readiness 503 when the schema is missing'); ok(!down.ok && down.db === true && down.schema === false, 'reports schema problem');
      eq((await R('/api/health/live')).status, 200, 'liveness stays 200');
    } finally { await srv.db.query('ALTER TABLE app_state_moved RENAME TO app_state'); }
    const back = await R('/api/health'); ok(back.ok && back.ready, 'readiness recovers by itself');
  });

  await scenario('E1 database outage at runtime: 503, no crash, recovers; unreachable at startup: never serves', async () => {
    // A TCP relay in front of Postgres that can be cut, so the app sees a real outage (not a mocked one).
    const target = new URL(process.env.DATABASE_URL); const tport = Number(target.port || 5432), thost = target.hostname;
    let up = true; const socks = new Set();
    const relay = net.createServer(c => { if (!up) return c.destroy(); const u = net.connect(tport, thost); socks.add(c); socks.add(u); c.pipe(u); u.pipe(c); const end = () => { c.destroy(); u.destroy(); socks.delete(c); socks.delete(u); }; c.on('error', end); u.on('error', end); c.on('close', end); u.on('close', end); });
    await new Promise(r => relay.listen(0, '127.0.0.1', r));
    const via = new URL(process.env.DATABASE_URL); via.hostname = '127.0.0.1'; via.port = String(relay.address().port);
    const app2 = await startTestServer({ prefix: 'ittr_sec_e1', admin: OWNER, env: { DATABASE_URL: via.toString() } });
    try {
      ok((await app2.request('/api/health')).ready, 'ready through the relay');
      up = false; for (const s of socks) s.destroy();
      let down = null; for (let i = 0; i < 40 && !(down && down.status === 503); i++) { down = await app2.request('/api/health', { allowError: true }).catch(e => ({ status: 0, err: e.message })); await sleep(250); }
      eq(down.status, 503, 'readiness 503 while the database is unreachable');
      eq((await app2.request('/api/health/live')).status, 200, 'process alive (no crash) during the outage');
      up = true;
      let back = null; for (let i = 0; i < 60 && !(back && back.ready); i++) { back = await app2.request('/api/health', { allowError: true }).catch(() => null); await sleep(250); }
      ok(back?.ready, 'readiness recovers when the database returns');
    } finally { await app2.cleanup(); relay.close(); for (const s of socks) s.destroy(); }
    // Startup with an unreachable database: the process exits non-zero and never answers.
    const dead = new URL(process.env.DATABASE_URL); dead.hostname = '127.0.0.1'; dead.port = '1';
    const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, DATABASE_URL: dead.toString(), PORT: '0', NODE_ENV: 'test', OPENAI_API_KEY: '', OPENROUTER_API_KEY: '' }, stdio: 'ignore' });
    const code = await new Promise(r => { const t = setTimeout(() => { child.kill('SIGKILL'); r('timeout'); }, 30000); child.on('exit', c => { clearTimeout(t); r(c); }); });
    ok(code !== 0 && code !== 'timeout', `startup without a database exits with an error (got ${code})`);
  });
} catch (e) {
  failures.push('setup'); console.error(`FAIL ${NAME} setup: ${e.stack || e.message}\n${srv.output().slice(-3000)}`);
} finally {
  await srv.cleanup();
}
if (failures.length) { console.error(`FAIL ${NAME}: ${failures.length} scenario(s) failed: ${failures.join('; ')}`); process.exit(1); }
console.log(`PASS ${NAME}`);
reportSuite(NAME, 'PASSED');
