// v24.71.0: browser regression suite for the October 2026 audit — real Chromium against a disposable server + database.
// S1  unit / customer names with apostrophes, quotes, markup and script-breaking text are shown literally and never run,
//     across header search, customer directory search, vehicle profile and history, truck search and invoice lookup.
// S5  sign-out and session expiry remove this device's read copies of shop data; an unsent mechanic edit stays bound to
//     that mechanic (another account signing in on the same device neither sees nor sends it) and is saved when the
//     same mechanic signs in again.
// #96 the owner's dashboard shows a mechanic's inspection promptly, even while the owner has an unsaved change waiting.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dbSuiteGuard, reportSuite, startTestServer, ok, eq, sleep } from './test_harness.mjs';
const NAME = 'security browser';
dbSuiteGuard(NAME);

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {
  if (process.env.ITTR_REQUIRE_BROWSER_SUITE === '1') { reportSuite(NAME, 'FAILED', 'Playwright not installed'); console.error(`FAIL ${NAME}: Playwright is not installed`); process.exit(1); }
  reportSuite(NAME, 'SKIPPED', 'Playwright not installed'); console.log(`SKIP ${NAME}: Playwright is not installed`); process.exit(0);
}
const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
let browser;
try { browser = await chromium.launch(exe ? { executablePath: exe } : {}); } catch (e) {
  if (process.env.ITTR_REQUIRE_BROWSER_SUITE === '1') { reportSuite(NAME, 'FAILED', 'Chromium not available'); console.error(`FAIL ${NAME}: Chromium could not start: ${e.message.split('\n')[0]}`); process.exit(1); }
  reportSuite(NAME, 'SKIPPED', 'Chromium not installed'); console.log(`SKIP ${NAME}: Chromium is not installed`); process.exit(0);
}

const OWNER = { username: 'owner', password: 'Shop-Boss-Pass-2026' };
const srv = await startTestServer({ prefix: 'ittr_secbr', admin: OWNER });
const B = srv.base();
const failures = []; let STEP = '';
const step = x => { STEP = x; if (process.env.ITTR_TEST_VERBOSE) console.log(`  · ${x}`); };
const ONLY = process.env.ITTR_ONLY ? new RegExp(process.env.ITTR_ONLY) : null;
async function scenario(name, fn) { if (ONLY && !ONLY.test(name)) return; STEP = ''; try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.error(`FAIL ${name}${STEP ? ` [at: ${STEP}]` : ''}: ${e.message.split('\n')[0]}`); } }
async function newPage({ width = 1440, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
  const page = await ctx.newPage(); page.errors = []; page.dialogs = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('dialog', d => { page.dialogs.push(d.message()); d.accept().catch(() => {}); });
  return { ctx, page };
}
async function signIn(page, u, p) {
  await page.waitForSelector('#loginUser', { state: 'visible', timeout: 15000 });
  await page.fill('#loginUser', u); await page.fill('#loginPass', p); await page.click('#loginForm button[type="submit"]');
  await page.waitForFunction(un => typeof session !== 'undefined' && session?.username === un, u, { timeout: 15000 });
  await page.waitForFunction(() => typeof cloudReady !== 'undefined' && cloudReady === true, null, { timeout: 15000 });
}
const until = (page, fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout });
const signOut = async page => { await Promise.all([page.waitForEvent('load', { timeout: 15000 }), page.evaluate(() => { logout(); })]); await page.waitForSelector('#loginUser', { state: 'visible' }); };
// Every payload tries to run window.__xssHit(n); the page never defines it as anything but a recorder.
const P = {
  // Survives encodeURIComponent (which leaves ' ( ) - . _ ! ~ * alone): the shape that broke the old search results.
  quote: `XQ1'-window.__xssHit(1)-'`,
  semi: `XQ2');window.__xssHit(2);//`,
  dquote: `XQ3" onmouseover="window.__xssHit(3)" x="`,
  markup: `XQ4"><img src=x onerror="window.__xssHit(4)">`,
  slash: `XQ5\\'-window.__xssHit(5)-'`,
  script: `XQ6</script><script>window.__xssHit(6)</script>`,
};
const CUSTOMER = `O'Brien "Haul" <b>&</b> Co'-window.__xssHit(9)-'`;
const T = (uid, t, x = {}) => ({ uid, t, done: false, startedAt: '', stoppedAt: '', elapsedMs: 0, ...x });

try {
  if (process.env.ITTR_TEST_VERBOSE) console.log('  · setup');
  const owner = await srv.login(OWNER.username, OWNER.password);
  for (const u of ['mecha', 'mechb']) await srv.request('/api/admin/users', { method: 'POST', token: owner, body: { username: u, display: u.toUpperCase(), password: 'Mechanic-Pass-1' } });
  const mechA = await srv.login('mecha', 'Mechanic-Pass-1');
  await srv.request('/api/timeclock/punch', { method: 'POST', token: mechA, body: { action: 'in' } });
  // Stored the way an attacker would: a customer typed by the office and units started by a mechanic's phone.
  const cust = await srv.request('/api/customers', { method: 'POST', token: owner, body: { customer_name: CUSTOMER, email: 'xq@fleet.test' } });
  const custId = cust.item?.id;
  const unitIds = [];
  for (const v of Object.values(P)) { const r = await srv.request(`/api/customers/${custId}/units`, { method: 'POST', token: owner, body: { unit_number: v, make: 'Volvo' } }); unitIds.push(r.item?.id || r.unit?.id); }
  const ss = await srv.request('/api/work-orders/self-start', { method: 'POST', token: mechA, body: { unit: P.quote, customer: CUSTOMER, jobs: [`Job ${P.markup}`] } });
  ok(ss.workOrder?.unit === P.quote, 'self-start stored the unit text as typed (rendering must make it safe)');
  await srv.request('/api/invoices', { method: 'POST', token: owner, body: { customerId: custId, customerName: CUSTOMER, unitNumber: P.quote } });
  const st = await srv.request('/api/state', { token: owner }); const sf = st.shopflow.payload;
  sf.workorders.push({ id: 801, unit: 'INSP-801', customer: 'Dash Fleet', status: 'In Progress', mechanic: 'mecha', helpers: [], unitType: 'customer', truckHere: true, date: '2026-10-16', time: '08:00', tasks: [T('i-t1', 'Annual inspection')], inspection: { required: true, type: 'truck', status: 'Not Started', results: {} } });
  sf.workorders.push({ id: 802, unit: 'EDIT-802', customer: 'Dash Fleet', status: 'Open', mechanic: 'mecha', helpers: [], unitType: 'customer', truckHere: true, date: '2026-10-16', time: '09:00', tasks: [T('e-t1', 'Oil change')] });
  await srv.request('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf, expectedVersion: st.shopflow.version } });
  const serverWo = async id => (await srv.request('/api/state', { token: owner })).shopflow.payload.workorders.find(w => String(w.id) === String(id));

  await scenario('S1 hostile unit/customer names: shown literally, never executed (search, profiles, history, work orders, invoices)', async () => {
    const { ctx, page } = await newPage();
    await page.addInitScript(() => { window.__xss = []; Object.defineProperty(window, '__xssHit', { value: n => window.__xss.push(n), writable: false }); });
    await page.goto(B); await signIn(page, OWNER.username, OWNER.password);
    page.setDefaultTimeout(3000);
    const missing = await page.evaluate(() => [...ITTR_ACTIONS].filter(n => typeof window[n] !== 'function'));
    eq(missing.join(), '', 'every data-act action is a real page function');
    const hits = () => page.evaluate(() => window.__xss.slice());
    const closeAll = () => page.evaluate(() => { document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open')); try { hideGlobalSmartSearch(); } catch (_) {} });
    // DOM-click (runs the handler even if the button is scrolled away), never destructive buttons.
    const SKIP = /delete|remove|permanent|void|merge|reset|logout|archive/i;
    const clickables = sel => page.evaluate(([sel, skip]) => [...document.querySelectorAll(sel)].map((el, i) => ({ i, h: (el.getAttribute('onclick') || '') + ' ' + (el.dataset.act || '') + ' ' + el.textContent })).filter(x => !new RegExp(skip, 'i').test(x.h)).map(x => x.i), [sel, SKIP.source]);
    const clickNth = (sel, i) => page.evaluate(([sel, i]) => { const el = document.querySelectorAll(sel)[i]; if (el) { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); el.click(); } }, [sel, i]);
    let clicked = 0;
    // 1. Header search: every result (customers, vehicles, work orders / service history, invoices).
    step('header search');
    for (const q of ['XQ', "O'Brien"]) {
      await page.evaluate(q => runGlobalSmartSearch(q), q);
      const txt = await page.textContent('#globalSmartSearchResults');
      ok(txt.includes(q === 'XQ' ? P.quote : `O'Brien "Haul" <b>&</b> Co`), `search "${q}" shows the text literally`);
      const idx = await clickables('#globalSmartSearchResults .smartResult');
      ok(idx.length >= 2, `search "${q}" has results to click (${idx.length})`);
      for (const i of idx) { await page.evaluate(q => runGlobalSmartSearch(q), q); await clickNth('#globalSmartSearchResults .smartResult', i); clicked++; await sleep(400); await closeAll(); }
    }
    eq((await hits()).join(), '', 'no payload ran from header search');
    // 2. Vehicle profiles of each hostile unit, every button in the profile and its history.
    step('vehicle profile');
    const sweepModal = async reopen => { await reopen(); await sleep(500); const idx = await clickables('.modal.open button, .modal.open [onclick]'); for (const i of idx.slice(0, 25)) { await reopen(); await sleep(250); await clickNth('.modal.open button, .modal.open [onclick]', i); clicked++; await sleep(200); } await closeAll(); };
    for (const id of unitIds.filter(Boolean)) await sweepModal(() => page.evaluate(x => openVehicleProfile(x, 'history'), id));
    eq((await hits()).join(), '', 'no payload ran from vehicle profiles');
    // 3. Customer profile (units, history) and directory search.
    step('customer profile');
    await page.evaluate(() => showView('customers')); await sleep(400);
    await page.evaluate(x => openCustomerProfile(x), custId); await sleep(800);
    ok((await page.locator('.modal.open').first().textContent()).includes(`O'Brien "Haul" <b>&</b> Co`), 'customer name shown literally in the profile');
    await sweepModal(() => page.evaluate(x => openCustomerProfile(x), custId));
    if (await page.locator('#customerDirectorySearch').count()) {
      await page.fill('#customerDirectorySearch', 'XQ'); await sleep(1000);
      for (const i of await clickables('#smartDirectoryResults button')) { await clickNth('#smartDirectoryResults button', i); clicked++; await sleep(250); await closeAll(); await page.evaluate(() => showView('customers')); await page.fill('#customerDirectorySearch', 'XQ'); await sleep(700); }
    }
    eq((await hits()).join(), '', 'no payload ran from the customer profile/directory');
    // 4. Work order detail of the mechanic's hostile unit and the work-order list.
    step('work order');
    await page.evaluate(() => showView('workorders')); await sleep(500);
    for (const i of (await clickables('#workorders button')).slice(0, 30)) { await clickNth('#workorders button', i); clicked++; await sleep(150); await closeAll(); await page.evaluate(() => { if (currentView !== 'workorders') showView('workorders'); }); }
    eq((await hits()).join(), '', 'no payload ran from work orders');
    // 5. Invoice customer lookup.
    step('invoice lookup');
    await page.evaluate(() => showView('invoices')); await sleep(800);
    if (await page.evaluate(() => typeof runInvoiceLookup === 'function' && !!document.getElementById('invoiceLookupResults'))) {
      await page.evaluate(q => runInvoiceLookup(q), "O'Brien"); await sleep(900);
      for (const i of await clickables('#invoiceLookupResults button')) { await page.evaluate(q => runInvoiceLookup(q), "O'Brien"); await sleep(500); await clickNth('#invoiceLookupResults button', i); clicked++; await sleep(300); }
    }
    eq((await hits()).join(), '', 'no payload ran from invoice lookup');
    console.log(`  S1: ${clicked} controls activated`);
    ok(clicked >= 20, `enough controls were exercised (${clicked})`);
    await ctx.close();
  });

  await scenario('S5 sign-out removes this device\'s shop data copies and the page memory', async () => {
    const { ctx, page } = await newPage(); await page.goto(B); await signIn(page, OWNER.username, OWNER.password);
    ok(await page.evaluate(() => !!localStorage.getItem('ittr_shopflow_v2')), 'shop copy cached while signed in');
    await signOut(page);
    const left = await page.evaluate(() => ['ittr_shopflow_v2', 'ittr_users_v1', 'ittr_pro_v20', 'ittr_ai_translation_cache_v2'].filter(k => localStorage.getItem(k)));
    eq(left.length, 0, `read caches removed after sign-out (${left})`);
    const mem = await page.evaluate(() => JSON.stringify({ s: typeof state !== 'undefined' ? state : null, u: typeof USERS !== 'undefined' ? USERS : null }));
    ok(!mem.includes('INSP-801') && !mem.includes('Dash Fleet'), 'no shop data left in page memory');
    ok(!(await page.evaluate(() => document.body.innerText)).includes('INSP-801'), 'no shop data left on screen');
    await ctx.close();
  });

  await scenario('S5 session expiry (revoked elsewhere) clears the copies too', async () => {
    const { ctx, page } = await newPage(); await page.goto(B); await signIn(page, OWNER.username, OWNER.password);
    const tok = await page.evaluate(() => sessionStorage.getItem('ittr_cloud_token'));
    await srv.request('/api/auth/logout', { method: 'POST', token: tok, body: {} });
    await page.evaluate(() => apiJSON('/api/state').catch(() => {}));
    await until(page, () => document.getElementById('loginScreen').style.display === 'flex');
    eq(await page.evaluate(() => localStorage.getItem('ittr_shopflow_v2')), null, 'shop copy removed after the session ended');
    await ctx.close();
  });

  await scenario('S5 unsent mechanic edit: kept for that mechanic, invisible to the next account, saved on return', async () => {
    const { ctx, page } = await newPage({ width: 390, height: 844 }); await page.goto(B); await signIn(page, 'mecha', 'Mechanic-Pass-1');
    await ctx.setOffline(true);
    await page.evaluate(() => { const w = state.workorders.find(x => String(x.id) === '802'); w.complaint = 'MECH-A-OFFLINE-EDIT'; save(); });
    await until(page, () => /MECH-A-OFFLINE-EDIT/.test(localStorage.getItem('ittr_sync_queue_v3:mecha') || ''));
    await page.evaluate(() => logout()); // offline: no reload, nothing can be sent
    await until(page, () => document.getElementById('loginScreen').style.display === 'flex');
    ok(page.dialogs.some(d => /unsent change/i.test(d)), 'the mechanic is told the change is kept on this device');
    ok(/MECH-A-OFFLINE-EDIT/.test(await page.evaluate(() => localStorage.getItem('ittr_sync_queue_v3:mecha') || '')), 'queued edit kept, bound to mecha');
    eq(await page.evaluate(() => localStorage.getItem('ittr_shopflow_v2')), null, 'read copy removed even offline');
    await ctx.setOffline(false);
    await signIn(page, 'mechb', 'Mechanic-Pass-1'); await sleep(1500);
    ok(!JSON.stringify(await page.evaluate(() => state)).includes('MECH-A-OFFLINE-EDIT'), 'mechb does not see mecha\'s unsent edit');
    eq((await serverWo(802)).complaint, undefined, 'mechb\'s session did not send mecha\'s edit');
    await signOut(page);
    await signIn(page, 'mecha', 'Mechanic-Pass-1');
    await until(page, () => !localStorage.getItem('ittr_sync_queue_v3:mecha'), null, 15000);
    eq((await serverWo(802)).complaint, 'MECH-A-OFFLINE-EDIT', 'mecha\'s edit saved after signing in again');
    await ctx.close();
  });

  await scenario('#96 owner dashboard shows the mechanic\'s inspection promptly, even with an unsaved owner change waiting', async () => {
    const o = await newPage(), m = await newPage({ width: 390, height: 844 });
    await o.page.goto(B); await signIn(o.page, OWNER.username, OWNER.password);
    await o.page.evaluate(() => showView('dashboard')); await sleep(300);
    // The owner's own save keeps failing (server busy), so a change stays waiting on the owner's device.
    await o.page.route('**/api/state/shopflow', r => r.request().method() === 'PUT' ? r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"busy"}' }) : r.continue());
    await o.page.evaluate(() => { const w = state.workorders.find(x => String(x.id) === '802'); w.notes = 'OWNER-WAITING-EDIT'; save(); });
    await until(o.page, () => ittrSync.hasPending('shopflow'));
    await m.page.goto(B); await signIn(m.page, 'mecha', 'Mechanic-Pass-1');
    const t0 = Date.now();
    await m.page.evaluate(() => openInspectionWorkflow(801));
    await until(m.page, () => document.getElementById('inspectionWorkflowModal')?.classList.contains('open'));
    await until(o.page, () => /Inspecting/.test(document.getElementById('mechanicLiveStatus')?.innerText || '') && /INSP-801|Truck inspection/.test(document.getElementById('mechanicLiveStatus')?.innerText || ''), null, 12000);
    const secs = (Date.now() - t0) / 1000; console.log(`  owner saw "Inspecting" after ${secs.toFixed(1)} s`);
    ok(await o.page.evaluate(() => state.workorders.find(x => String(x.id) === '802')?.notes === 'OWNER-WAITING-EDIT'), 'owner\'s waiting change kept on screen');
    ok(await o.page.evaluate(() => ittrSync.hasPending('shopflow')), 'owner\'s change still queued to be sent');
    await o.page.unroute('**/api/state/shopflow');
    await o.page.evaluate(() => ittrSync.syncAll());
    await until(o.page, () => !ittrSync.hasPending('shopflow'), null, 15000);
    eq((await serverWo(802)).notes, 'OWNER-WAITING-EDIT', 'owner\'s change saved once the server answers');
    const wo = await serverWo(801); eq(wo.inspection.status, 'In Progress', 'inspection status on the server');
    eq(o.page.errors.length + m.page.errors.length, 0, `no script errors (${o.page.errors.concat(m.page.errors).join(' | ')})`);
    await o.ctx.close(); await m.ctx.close();
  });
} catch (e) {
  failures.push('setup'); console.error(`FAIL ${NAME} setup${STEP ? ` [at: ${STEP}]` : ''}: ${e.stack || e.message}\n${srv.output().slice(-3000)}`);
} finally {
  await browser.close().catch(() => {});
  await srv.cleanup();
}
if (failures.length) { console.error(`FAIL ${NAME}: ${failures.length} scenario(s) failed: ${failures.join('; ')}`); process.exit(1); }
console.log(`PASS ${NAME}`);
reportSuite(NAME, 'PASSED');
