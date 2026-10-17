// v24.75.0: mechanic visibility — real server + disposable database (never production), isolated test accounts.
// Policy: every ACTIVE mechanic SEES all of the shop's work orders (assigned or not) with their findings, photos,
// task-time records and PDFs; what a mechanic may DO (timers, parts, inspection answers, helpers, completing, reopening,
// whole-shop save edits) stays limited to work orders they are assigned to (primary or helper).
// V1  two mechanics get the same work-order set, including one assigned to neither (fails before v24.75.0).
// V2  a mechanic's copy has no part buy costs and no account data; other mechanics appear only as a name directory.
// V3  details follow the same read policy: task sessions, photos, completed work-order PDF.
// V4  viewing another mechanic's work does not allow acting on it (dedicated routes and the whole-shop save).
// V5  completed work stays locked through the whole-shop save; reopening is its own route with the old rule.
// V6  financial/administrative routes stay closed to mechanics.
// V7  deactivated, deleted and logged-out accounts lose access at once.
// V8  live signals to a mechanic carry no work-order data.
// B*  (browser) All shop work / My assigned work, Ready / Upcoming / Completed, view-only detail, account switching.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dbSuiteGuard, reportSuite, startTestServer, ok, eq, sleep } from './test_harness.mjs';
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');
const NAME = 'mechanic visibility';
dbSuiteGuard(NAME);

const OWNER = { username: 'owner', password: 'Shop-Boss-Pass-2026' };
const srv = await startTestServer({ prefix: 'ittr_mvis', admin: OWNER });
const R = srv.request, db = srv.db;
const failures = [];
async function scenario(name, fn) { try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.error(`FAIL ${name}: ${e.message.split('\n')[0]}`); } }
const T = (uid, t, x = {}) => ({ uid, t, done: false, startedAt: '', stoppedAt: '', elapsedMs: 0, parts: [], ...x });
const PASS = 'Mechanic-Pass-1';
let browser = null;

try {
  const owner = await srv.login(OWNER.username, OWNER.password);
  for (const [u, d] of [['t_roman', 'Roman Test'], ['t_ivan', 'Ivan Test'], ['t_temp', 'Temp Mech']]) await R('/api/admin/users', { method: 'POST', token: owner, body: { username: u, display: d, password: PASS } });
  await R('/api/timeclock/settings', { method: 'PUT', token: owner, body: { requireClockIn: false, autoClockIn: false } }).catch(() => {});
  const st = await R('/api/state', { token: owner }), sf = st.shopflow.payload;
  sf.workorders = [
    { id: 801, unit: 'R-801', customer: 'Alpha Fleet', status: 'In Progress', mechanic: 't_roman', helpers: [], unitType: 'customer', truckHere: true, date: '2026-10-17', time: '08:00', tasks: [T('r1', 'Brake job', { parts: [{ id: 'p1', partNumber: 'BRK-1', qty: 2, unitCost: 41.5, unitPrice: 89 }] })], inspection: { required: true, type: 'truck', status: 'Not Started', results: {} } },
    { id: 802, unit: 'I-802', customer: 'Beta Fleet', status: 'Open', mechanic: 't_ivan', helpers: ['t_roman'], unitType: 'customer', truckHere: false, date: '2026-10-18', time: '09:00', tasks: [T('i1', 'PM service')] },
    { id: 803, unit: 'N-803', customer: 'Gamma Fleet', status: 'Open', mechanic: '', helpers: [], unitType: 'customer', truckHere: true, date: '2026-10-17', time: '10:00', tasks: [T('n1', 'Diagnose air leak')] },
    { id: 804, unit: 'C-804', customer: 'Delta Fleet', status: 'Completed', mechanic: 't_ivan', helpers: [], unitType: 'customer', truckHere: true, completedAt: '2026-10-16T15:00:00Z', completedBy: 't_ivan', outcomeWorkflowVersion: 1, tasks: [T('c1', 'Replace starter', { done: true, completedAt: '2026-10-16T14:00:00Z', completedBy: 't_ivan', taskOutcome: 'completed', outcomeBy: 't_ivan' })] },
    { id: 805, unit: 'U-805', customer: 'Alpha Fleet', status: 'Open', mechanic: 'T_ROMAN', helpers: [], unitType: 'customer', truckHere: true, date: '2026-10-17', time: '11:00', tasks: [T('u1', 'Tires')] },
  ];
  sf.issues = [{ id: 'iss1', wo: 801, mechanic: 't_roman', description: 'Cracked drum', recommendation: 'Replace drum', approval: 'Waiting for Customer' }, { id: 'iss3', wo: 803, mechanic: '', description: 'Air leak', recommendation: 'Replace valve', approval: 'Waiting for Customer' }];
  await R('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf, expectedVersion: st.shopflow.version } });
  const roman = await srv.login('t_roman', PASS), ivan = await srv.login('t_ivan', PASS);
  const mstate = tok => R('/api/state', { token: tok });
  const ids = s => s.shopflow.payload.workorders.map(w => String(w.id)).sort().join(',');

  await scenario('V1 two mechanics see the same work orders, including one assigned to neither', async () => {
    const a = await mstate(roman), b = await mstate(ivan);
    eq(ids(a), '801,802,803,804,805', 'Roman sees every shop work order'); eq(ids(b), ids(a), 'Ivan sees the same set');
    eq(a.shopflow.payload.issues.map(i => i.id).sort().join(), 'iss1,iss3', 'findings of every work order');
  });

  await scenario('V2 no part buy cost or account data in a mechanic\'s copy; others are a name directory', async () => {
    const s = await mstate(ivan), json = JSON.stringify(s);
    const part = s.shopflow.payload.workorders.find(w => w.id === 801).tasks[0].parts[0];
    ok(!('unitCost' in part), 'buy cost hidden'); eq(part.unitPrice, 89, 'sell price kept (as in parts search)');
    ok(!/password|token_hash|totp|recovery|permissions/i.test(json), 'no account secrets or permissions');
    const users = s.users.payload;
    eq(users.t_roman?.display, 'Roman Test', 'other mechanic\'s name for the helper picker');
    eq(Object.keys(users.t_roman).sort().join(), 'directoryOnly,display,role', 'directory entry has only name and role');
    ok(!('owner' in users), 'owner/managers not listed');
    ok(users.t_ivan && 'currentActivity' in users.t_ivan, 'own entry still has own activity');
    const full = (await R('/api/state', { token: owner })).shopflow.payload.workorders.find(w => w.id === 801).tasks[0].parts[0];
    eq(full.unitCost, 41.5, 'the office copy keeps the cost');
  });

  await scenario('V3 details follow the read policy: task time, photos, completed PDF', async () => {
    eq((await R('/api/work-orders/801/task-sessions', { token: ivan, allowError: true })).status, 200, 'Ivan reads task time on Roman\'s work order');
    eq((await R('/api/work-orders/803/photos', { token: ivan, allowError: true })).status === 403, false, 'photos of an unassigned work order are not refused');
    const pdf = await fetch(`${srv.base()}/api/work-orders/804/pdf`, { headers: { Authorization: `Bearer ${roman}` } });
    eq(pdf.status, 200, 'Roman downloads the completed PDF of Ivan\'s work order');
  });

  await scenario('V4 seeing another mechanic\'s work does not allow acting on it', async () => {
    const tries = [
      ['task timer', `/api/work-orders/801/tasks/by-uid/r1/action`, { action: 'start' }],
      ['add part', `/api/work-orders/801/tasks/by-uid/r1/parts`, { partNumber: 'X-1', description: 'x', qty: 1 }],
      ['inspection answers', `/api/work-orders/801/inspection`, { inspection: { status: 'In Progress', results: { brakes: { status: 'ok' } } } }],
      ['add helper', `/api/work-orders/801/helpers`, { username: 't_ivan' }],
      ['reopen', `/api/work-orders/804/reactivate`, { reason: 'x', tasks: ['y'] }],
    ];
    const tok = { 'reopen': roman };
    for (const [what, path, body] of tries) {
      const r = await R(path, { method: 'POST', token: tok[what] || ivan, body, allowError: true });
      eq(r.status, 403, `${what} refused`);
    }
    eq((await R('/api/work-orders/803/tasks/by-uid/n1/action', { method: 'POST', token: ivan, body: { action: 'start' }, allowError: true })).status, 403, 'timer on an unassigned work order refused');
    // Whole-shop save: edits to work Ivan is not on are kept out and reported.
    const s = await mstate(ivan), p = JSON.parse(JSON.stringify(s.shopflow.payload));
    const w801 = p.workorders.find(w => w.id === 801); w801.status = 'Completed'; w801.tasks[0].t = 'Hijacked'; w801.tasks[0].done = true;
    p.workorders.find(w => w.id === 803).notes = 'Ivan was here'; p.issues.find(i => i.id === 'iss3').recommendation = 'Ignore';
    const r = await R('/api/state/shopflow', { method: 'PUT', token: ivan, body: { payload: p, expectedVersion: s.shopflow.version } });
    ok((r.notApplied || []).some(x => x.workOrderId === '801' && x.reason === 'not_assigned'), 'refusal reported');
    const after = (await R('/api/state', { token: owner })).shopflow.payload;
    const a801 = after.workorders.find(w => w.id === 801);
    eq(a801.status, 'In Progress', 'status unchanged'); eq(a801.tasks[0].t, 'Brake job', 'job unchanged'); eq(a801.tasks[0].parts[0].unitCost, 41.5, 'hidden cost not wiped by the save');
    ok(!after.workorders.find(w => w.id === 803).notes, 'unassigned work order unchanged'); eq(after.issues.find(i => i.id === 'iss3').recommendation, 'Replace valve', 'finding unchanged');
    // His own work still saves.
    const s2 = await mstate(ivan), p2 = JSON.parse(JSON.stringify(s2.shopflow.payload)); p2.workorders.find(w => w.id === 802).notes = 'Bring PM kit';
    await R('/api/state/shopflow', { method: 'PUT', token: ivan, body: { payload: p2, expectedVersion: s2.shopflow.version } });
    eq((await R('/api/state', { token: owner })).shopflow.payload.workorders.find(w => w.id === 802).notes, 'Bring PM kit', 'own work order note saved');
  });

  await scenario('V5 completed work is locked in the whole-shop save; reopening uses its own route', async () => {
    const s = await mstate(ivan), p = JSON.parse(JSON.stringify(s.shopflow.payload));
    const w = p.workorders.find(x => x.id === 804); w.status = 'In Progress'; w.tasks[0].t = 'Rewritten';
    const r = await R('/api/state/shopflow', { method: 'PUT', token: ivan, body: { payload: p, expectedVersion: s.shopflow.version } });
    ok((r.notApplied || []).some(x => x.workOrderId === '804' && x.reason === 'completed'), 'completed refusal reported');
    let a = (await R('/api/state', { token: owner })).shopflow.payload.workorders.find(x => x.id === 804);
    eq(a.status, 'Completed', 'still completed'); eq(a.tasks[0].t, 'Replace starter', 'job text unchanged');
    eq((await R('/api/work-orders/804/reactivate', { method: 'POST', token: ivan, body: { reason: '', tasks: [] }, allowError: true })).status, 400, 'reason and job required');
    const ok2 = await R('/api/work-orders/804/reactivate', { method: 'POST', token: ivan, body: { reason: 'Customer came back: starter noise', tasks: ['Check starter mount'] } });
    ok(ok2.ok && ok2.shopflow.workorders.some(x => x.id === 804 && x.status === 'In Progress'), 'reopened by the completing mechanic');
    a = (await R('/api/state', { token: owner })).shopflow.payload.workorders.find(x => x.id === 804);
    ok(a.isReactivated && a.reactivatedBy === 't_ivan' && a.tasks.some(t => t.t === 'Check starter mount') && a.history.at(-1).type === 'reactivated', 'reopen recorded with job and history');
    eq((await R('/api/work-orders/804/reactivate', { method: 'POST', token: ivan, body: { reason: 'again', tasks: ['x'] }, allowError: true })).status, 409, 'cannot reopen an open work order');
  });

  await scenario('V6 financial and administrative routes stay closed to mechanics', async () => {
    for (const path of ['/api/invoices', '/api/bills', '/api/estimates', '/api/admin/managers', '/api/customer-links', '/api/reports/finance', '/api/state/users/version/1'])
      ok([401, 403, 404].includes((await R(path, { token: roman, allowError: true })).status), `${path} closed`);
    eq((await R('/api/state/users', { method: 'PUT', token: roman, body: { payload: {}, expectedVersion: 1 }, allowError: true })).status, 403, 'users record cannot be saved');
    eq((await R('/api/work-orders/803', { method: 'DELETE', token: roman, allowError: true })).status, 403, 'cannot delete a work order');
  });

  await scenario('V7 deactivated, deleted and logged-out accounts lose access', async () => {
    const temp = await srv.login('t_temp', PASS); eq((await R('/api/state', { token: temp, allowError: true })).status, 200, 'temp account works');
    await db.query("UPDATE auth_users SET active=false WHERE username='t_temp'");
    eq((await R('/api/state', { token: temp, allowError: true })).status, 401, 'deactivated: existing session refused');
    ok(!(await mstate(roman)).users.payload.t_temp, 'deactivated mechanic left out of the directory');
    await db.query("UPDATE auth_users SET active=true WHERE username='t_temp'");
    const t2 = await srv.login('t_temp', PASS); await R('/api/auth/logout', { method: 'POST', token: t2 });
    eq((await R('/api/state', { token: t2, allowError: true })).status, 401, 'logged out: session refused');
    const t3 = await srv.login('t_temp', PASS); await R('/api/admin/users/t_temp', { method: 'DELETE', token: owner });
    eq((await R('/api/state', { token: t3, allowError: true })).status, 401, 'deleted: session refused');
  });

  await scenario('V8 live signals to a mechanic carry no work-order data', async () => {
    const ws = new WebSocket(srv.base().replace('http', 'ws') + '/ws/shop-status'), msgs = [];
    ws.on('message', d => { try { msgs.push(JSON.parse(String(d))); } catch (_) {} });
    await new Promise((res, rej) => { ws.on('open', () => { ws.send(JSON.stringify({ type: 'auth', token: ivan })); res(); }); ws.on('error', rej); });
    for (let i = 0; i < 50 && !msgs.some(m => m.type === 'connected'); i++) await sleep(50);
    await R('/api/work-orders/801/tasks/by-uid/r1/action', { method: 'POST', token: roman, body: { action: 'start' } });
    for (let i = 0; i < 40 && !msgs.some(m => m.type === 'shopflow_changed'); i++) await sleep(50);
    const m = msgs.find(x => x.type === 'shopflow_changed'); ok(m, 'Ivan is told to refresh');
    eq(Object.keys(m).sort().join(), 'at,type', 'the signal carries no data');
    ws.close();
  });

  // ---------- browser ----------
  let chromium = null; try { ({ chromium } = require('playwright')); } catch (_) {}
  const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  if (chromium) browser = await chromium.launch(exe ? { executablePath: exe } : {}).catch(() => null);
  if (!browser) {
    if (process.env.ITTR_REQUIRE_BROWSER_SUITE === '1') { failures.push('browser (Chromium not available)'); console.error('FAIL browser scenarios: Chromium not available'); }
    else console.log('SKIP browser scenarios: Chromium not available');
  } else {
    // Reset 801's timer so the screens are calm; 804 back to completed for the Completed view.
    { const s = await R('/api/state', { token: owner }), p = s.shopflow.payload; const w = p.workorders.find(x => x.id === 801); w.tasks[0] = { ...w.tasks[0], startedAt: '', stoppedAt: '', runningBy: '' };
      Object.assign(p.workorders.find(x => x.id === 804), { status: 'Completed', completedAt: '2026-10-17T15:00:00Z', completedBy: 't_ivan', isReactivated: false });
      await R('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: p, expectedVersion: s.shopflow.version } }); }
    const login = async (page, u) => { await page.fill('#loginUser', u); await page.fill('#loginPass', PASS); await page.click('#loginForm button[type="submit"]'); await page.waitForFunction(() => typeof cloudReady !== 'undefined' && cloudReady && session?.role === 'mechanic', null, { timeout: 15000 }); await sleep(600); };
    const units = (page, sel) => page.$$eval(`${sel} .card b`, bs => bs.map(b => b.textContent.replace('Unit ', '').trim()).filter(x => /^[A-Z]-\d+$/.test(x)).sort().join(','));
    for (const [label, width] of [['phone', 390], ['desktop', 1280]]) {
      await scenario(`B1 ${label}: All shop work, My assigned work, Ready / Upcoming / Completed`, async () => {
        const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' }), page = await ctx.newPage(); page.setDefaultTimeout(6000);
        const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('dialog', d => d.accept());
        await page.goto(srv.base()); await login(page, 't_roman');
        await page.evaluate(() => showView('mechanic')); await sleep(400);
        eq(await units(page, '#mechanicJobs'), 'N-803,R-801,U-805', 'Ready: every truck here, assigned or not');
        eq(await units(page, '#mechanicUpcoming'), 'I-802', 'Upcoming');
        const meta = await page.textContent('#mechanicUpcoming'); ok(/WO #802/.test(meta) && /Ivan Test/.test(meta) && /Roman Test/.test(meta), 'WO number, primary and helper shown');
        await page.click('#mechanic .mechViewMine'); await sleep(200);
        eq(await units(page, '#mechanicJobs'), 'R-801,U-805', 'Mine: primary work (any letter case)'); eq(await units(page, '#mechanicUpcoming'), 'I-802', 'Mine: helper work');
        await page.fill('#mechanic .mechViewSearch', '805'); await sleep(200); eq(await units(page, '#mechanicJobs'), 'U-805', 'search by WO number');
        await page.fill('#mechanic .mechViewSearch', ''); await page.click('#mechanic .mechViewAll'); await sleep(200);
        await page.evaluate(() => showView('mycompleted')); await sleep(300);
        eq(await units(page, '#myCompletedJobs'), 'C-804', 'Completed: shop work Roman was not on');
        eq(await page.$$eval('#myCompletedJobs button', bs => bs.filter(b => /openReactivate/.test(b.getAttribute('onclick') || '')).length), 0, 'no reopen button on someone else\'s work');
        await page.click('#mycompleted .mechViewMine'); await sleep(200); eq(await units(page, '#myCompletedJobs'), '', 'Mine: none completed by Roman');
        await page.click('#mycompleted .mechViewAll'); await sleep(100);
        await page.evaluate(() => { showView('mechanic'); openDetail(803); }); await sleep(500);
        const det = await page.textContent('#detailBody');
        ok(/View only/.test(det) && !/Start Work Order/.test(det), 'unassigned detail is view only');
        ok(!(await page.$('#detailBody button[onclick*="taskAction"], #detailBody .mechanicAction')), 'no action buttons');
        await page.evaluate(() => closeModal('detailModal'));
        await page.evaluate(() => openDetail(801)); await sleep(400); ok(/Start Work Order/.test(await page.textContent('#detailBody')), 'own work order keeps its actions');
        await page.evaluate(() => closeModal('detailModal'));
        if (width === 390) eq(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'fits the phone');
        // Account switch on the same device: no carried-over filter, search or data from the previous person.
        await page.click('#mechanic .mechViewMine'); await page.fill('#mechanic .mechViewSearch', 'R-801'); await sleep(150);
        await page.evaluate(() => logout()); await page.waitForSelector('#loginUser', { state: 'visible' }); await login(page, 't_ivan');
        await page.evaluate(() => showView('mechanic')); await sleep(400);
        eq(await page.inputValue('#mechanic .mechViewSearch'), '', 'search cleared'); eq(await page.getAttribute('#mechanic .mechViewAll', 'aria-pressed'), 'true', 'Ivan starts on All shop work');
        eq(await units(page, '#mechanicJobs'), 'N-803,R-801,U-805', 'Ivan sees the same Ready list');
        eq(errs.join(' | '), '', 'no browser errors');
        await ctx.close();
      });
    }
  }
} catch (e) { failures.push(`setup: ${e.message.split('\n')[0]}`); console.error(e); }
finally { if (browser) await browser.close().catch(() => {}); await srv.cleanup(); }

if (failures.length) { reportSuite(NAME, 'FAILED', failures.join('; ')); console.error(`FAIL ${NAME}: ${failures.length} scenario(s)`); process.exit(1); }
reportSuite(NAME, 'PASSED'); console.log(`PASS ${NAME}`);
