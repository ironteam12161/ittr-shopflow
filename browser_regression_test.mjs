// v24.67.0: browser regression suite (real Chromium against a disposable server + database).
// Checks behaviour, not just console errors: sign-in screen, tab title / address / Back / reload, phone layout,
// offline edit → reload → remote edit → reconnect, late Workshop AI answers after New Chat / logout / account switch /
// expired session / attachment analysis, and the service-worker upgrade path for a tab left open across a deploy.
// Needs Playwright's Chromium: `npx playwright install chromium` (CI does this), or PLAYWRIGHT_CHROMIUM_PATH.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dbSuiteGuard, reportSuite, startTestServer, ok, eq, sleep } from './test_harness.mjs';
dbSuiteGuard('browser regression');

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {
  try { ({ chromium } = require(`${process.env.PWROOT || ''}/index.js`)); } catch (e) {
    if (process.env.ITTR_REQUIRE_BROWSER_SUITE === '1') { reportSuite('browser regression', 'FAILED', 'Playwright not installed'); console.error('FAIL browser regression: Playwright is not installed'); process.exit(1); }
    reportSuite('browser regression', 'SKIPPED', 'Playwright not installed'); console.log('SKIP browser regression: Playwright is not installed (npm install, then npx playwright install chromium)'); process.exit(0);
  }
}
const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

let browser;
try { browser = await chromium.launch(exe ? { executablePath: exe } : {}); } catch (e) {
  if (process.env.ITTR_REQUIRE_BROWSER_SUITE === '1') { reportSuite('browser regression', 'FAILED', 'Chromium not available'); console.error(`FAIL browser regression: Chromium could not start: ${e.message.split('\n')[0]}`); process.exit(1); }
  reportSuite('browser regression', 'SKIPPED', 'Chromium not installed'); console.log('SKIP browser regression: Chromium is not installed (npx playwright install chromium)'); process.exit(0);
}
const OWNER = { username: 'owner', password: 'Shop-Boss-Pass-2026' };
const srv = await startTestServer({ prefix: 'ittr_browser', admin: OWNER });
const B = srv.base();
const failures = [];
async function scenario(name, fn) { try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.error(`FAIL ${name}: ${e.message}`); } }
async function newPage({ width = 1366, height = 860, sw = 'block' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: sw });
  const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message)); page.on('dialog', d => d.dismiss().catch(() => {}));
  return { ctx, page };
}
async function signIn(page, u = OWNER.username, p = OWNER.password) {
  await page.fill('#loginUser', u); await page.fill('#loginPass', p); await page.click('#loginForm button[type="submit"]');
  await page.waitForFunction(un => window.session?.username === un || (typeof session !== 'undefined' && session?.username === un), u, { timeout: 15000 });
  await page.waitForFunction(() => typeof cloudReady !== 'undefined' && cloudReady === true, null, { timeout: 15000 });
}
const until = async (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout });

try {
  const owner = await srv.login(OWNER.username, OWNER.password);
  await srv.request('/api/admin/users', { method: 'POST', token: owner, body: { username: 'mech1', display: 'Mech One', password: 'Mechanic-Pass-1' } });
  await srv.request('/api/admin/managers', { method: 'POST', token: owner, body: { username: 'office1', display: 'Office', password: 'Manager-Pass-2026', permissions: { invoices: true, customers: true } } });
  const st = await srv.request('/api/state', { token: owner });
  const sf = st.shopflow.payload; sf.workorders = [1, 2, 3].map(i => ({ id: String(3000 + i), unit: `U${i}`, customer: 'Browser Fleet', status: 'Open', mechanic: 'mech1', date: '2026-10-16', time: '08:00', truckHere: true, tasks: [{ uid: `t${i}`, t: 'PM', done: false }] }));
  await srv.request('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf, expectedVersion: st.shopflow.version } });
  const serverWo = async id => (await srv.request('/api/state', { token: owner })).shopflow.payload.workorders.find(w => w.id === String(id));

  await scenario('sign-in screen: logo, show password, no AI button before sign-in', async () => {
    const { ctx, page } = await newPage(); await page.goto(B);
    ok(await page.locator('.loginLogo').isVisible(), 'logo shown'); ok(!(await page.locator('#shopAiFab').isVisible()), 'AI button hidden before sign-in');
    await page.fill('#loginPass', 'x'); await page.click('.loginPassShow'); eq(await page.getAttribute('#loginPass', 'type'), 'text', 'show password');
    await page.click('.loginPassShow'); eq(await page.getAttribute('#loginPass', 'type'), 'password', 'hide again');
    await signIn(page); ok(await page.locator('#shopAiFab').isVisible(), 'AI button after sign-in');
    eq(page.errors.length, 0, `no script errors (${page.errors.join(' | ')})`); await ctx.close();
  });

  await scenario('tab title, address, Back and reload keep the page', async () => {
    const { ctx, page } = await newPage(); await page.goto(B); await signIn(page);
    await page.click('header nav .navbtn[data-view="invoices"]'); await until(page, () => location.hash === '#invoices');
    eq(await page.title(), 'Invoices · ITTR ShopFlow', 'tab title'); ok(await page.locator('#invoices').isVisible(), 'invoices shown');
    await page.click('header nav .navbtn[data-view="parts"]'); await until(page, () => location.hash === '#parts');
    await page.goBack(); await until(page, () => currentView === 'invoices'); ok(await page.locator('#invoices').isVisible(), 'Back shows invoices again');
    await page.reload(); await until(page, () => typeof cloudReady !== 'undefined' && cloudReady && currentView === 'invoices', null, 15000);
    eq(await page.title(), 'Invoices · ITTR ShopFlow', 'same page after reload');
    eq(page.errors.length, 0, `no script errors (${page.errors.join(' | ')})`); await ctx.close();
  });

  await scenario('phone layout: no sideways scroll, bottom navigation, readable header', async () => {
    const { ctx, page } = await newPage({ width: 390, height: 844 }); await page.goto(B); await signIn(page);
    for (const v of ['dashboard', 'workorders', 'invoices', 'parts', 'customers']) {
      await page.evaluate(v => showView(v), v); await sleep(700);
      const m = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, vw: innerWidth }));
      ok(m.w <= m.vw, `${v}: page is ${m.w}px wide on a ${m.vw}px phone`);
    }
    ok(await page.locator('#mobileBottomNav').isVisible(), 'bottom navigation visible');
    const brand = await page.evaluate(() => { const s = document.querySelector('header .brandText strong'); return s ? s.scrollWidth <= s.clientWidth + 1 : true; });
    ok(brand, 'shop name not cut off');
    const mech = await newPage({ width: 390, height: 844 }); await mech.page.goto(B); await signIn(mech.page, 'mech1', 'Mechanic-Pass-1');
    ok(await mech.page.locator('#mechanic').isVisible(), 'mechanic home'); ok((await mech.page.evaluate(() => document.documentElement.scrollWidth)) <= 390, 'mechanic screen fits');
    eq(page.errors.concat(mech.page.errors).length, 0, 'no script errors'); await mech.ctx.close(); await ctx.close();
  });

  await scenario('offline edit → reload → remote edit → reconnect: the edit is shown again and saved', async () => {
    const { ctx, page } = await newPage({ sw: 'allow' }); await page.goto(B); await signIn(page);
    await page.evaluate(() => navigator.serviceWorker?.ready);
    await ctx.setOffline(true);
    await page.evaluate(() => { const w = state.workorders.find(x => x.id === '3001'); w.complaint = 'BROWSER-OFFLINE'; save(); });
    await until(page, () => !!JSON.parse(localStorage.getItem('ittr_sync_queue_v3:owner') || '{}').shopflow);
    ok(/Offline/.test(await page.textContent('#syncQueueText')), 'badge says offline with a pending change');
    await page.reload().catch(() => {}); await sleep(800); // offline reload: the app cannot sign in, the queue stays
    const remote = await srv.request('/api/state', { token: owner }); remote.shopflow.payload.workorders.find(w => w.id === '3002').complaint = 'OTHER-DEVICE';
    await srv.request('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: remote.shopflow.payload, expectedVersion: remote.shopflow.version } });
    eq((await serverWo(3001)).complaint, undefined, 'nothing saved while offline');
    await ctx.setOffline(false); await page.goto(B);
    await until(page, () => (typeof cloudReady !== 'undefined' && cloudReady) || document.getElementById('loginScreen').style.display === 'flex', null, 15000);
    if (await page.evaluate(() => document.getElementById('loginScreen').style.display === 'flex')) await signIn(page);
    await until(page, () => typeof cloudReady !== 'undefined' && cloudReady, null, 15000);
    await until(page, () => state.workorders.find(x => x.id === '3001')?.complaint === 'BROWSER-OFFLINE', null, 10000);
    await until(page, () => !localStorage.getItem('ittr_sync_queue_v3:owner'), null, 10000);
    eq((await serverWo(3001)).complaint, 'BROWSER-OFFLINE', 'offline edit saved after reconnect'); eq((await serverWo(3002)).complaint, 'OTHER-DEVICE', 'other device\'s edit kept');
    eq(await page.textContent('#syncQueueText'), 'Synced', 'badge back to Synced');
    await ctx.close();
  });

  await scenario('mechanic self-start while an edit is still unsaved: the edit survives and is saved', async () => {
    const mech = await srv.login('mech1', 'Mechanic-Pass-1');
    await srv.request('/api/timeclock/punch', { method: 'POST', token: mech, body: { action: 'in' } });
    const { ctx, page } = await newPage({ width: 390, height: 844 }); await page.goto(B); await signIn(page, 'mech1', 'Mechanic-Pass-1');
    await page.route('**/api/state/shopflow', r => r.request().method() === 'PUT' ? r.abort('failed') : r.continue());
    await page.evaluate(() => { state.workorders.find(x => x.id === '3003').completionNotes = 'MECH-PENDING'; save(); });
    await until(page, () => !!JSON.parse(localStorage.getItem('ittr_sync_queue_v3:mech1') || '{}').shopflow && ittrSync.status().error);
    // Same steps as the Start New Job wizard after the server created the work order.
    await page.evaluate(async () => { const r = await apiJSON('/api/work-orders/self-start', { method: 'POST', body: JSON.stringify({ unit: 'SS-77', jobs: ['PM service'] }) }); if (r?.shopflow) ittrAdoptServerShopflow(r.shopflow, r.version); });
    ok(await page.evaluate(() => state.workorders.some(w => w.unit === 'SS-77') && state.workorders.find(x => x.id === '3003')?.completionNotes === 'MECH-PENDING'), 'new job shown and the unsaved edit still on screen');
    ok(await page.evaluate(() => !!JSON.parse(localStorage.getItem('ittr_sync_queue_v3:mech1') || '{}').shopflow), 'the unsaved edit is still queued');
    await page.unroute('**/api/state/shopflow'); await page.evaluate(() => ittrSync.sync('shopflow'));
    await until(page, () => !localStorage.getItem('ittr_sync_queue_v3:mech1'), null, 10000);
    eq((await serverWo(3003)).completionNotes, 'MECH-PENDING', 'saved after the connection came back');
    ok((await srv.request('/api/state', { token: owner })).shopflow.payload.workorders.some(w => w.unit === 'SS-77'), 'self-started work order kept');
    await ctx.close();
  });

  // ---------------------------------------------------------------- Workshop AI: late answers never leak
  const chatPage = async () => {
    const p = await newPage(); await p.page.goto(B); await signIn(p.page);
    p.calls = []; let n = 0;
    await p.page.route('**/api/ai/copilot/action', r => r.fulfill({ json: { ok: true, action: null } }));
    await p.page.route('**/api/ai/shop-chat', async route => { const body = JSON.parse(route.request().postData() || '{}'); const i = ++n; p.calls.push(body); const slow = /SLOW/.test(body.message); if (slow) await sleep(1500); await route.fulfill({ json: { result: slow ? `STALE-ANSWER-${i}` : `FRESH-ANSWER-${i}`, sources: [] } }).catch(() => {}); });
    await p.page.click('#shopAiFab'); return p;
  };
  const chatText = page => page.evaluate(() => document.getElementById('shopAiMessages').innerText);
  const stored = page => page.evaluate(() => JSON.stringify(Object.fromEntries(Object.keys(sessionStorage).filter(k => k.startsWith('ittr_ai_chat_')).map(k => [k, sessionStorage.getItem(k)]))));

  await scenario('AI: New Chat while an answer is pending — late answer dropped, new chat usable at once', async () => {
    for (const noAbort of [false, true]) {
      const { ctx, page, calls } = await chatPage();
      if (noAbort) await page.evaluate(() => { AbortController.prototype.abort = function () {}; }); // the answer still arrives: it must be ignored, not just cancelled
      await page.fill('#shopAiInput', 'SLOW question one'); await page.click('#shopAiSend');
      await sleep(200); await page.click('text=New Chat');
      ok(!(await page.isDisabled('#shopAiSend')), 'send button usable immediately');
      await page.fill('#shopAiInput', 'quick question two'); await page.click('#shopAiSend');
      await until(page, () => /FRESH-ANSWER/.test(document.getElementById('shopAiMessages').innerText));
      await sleep(1800);
      const txt = await chatText(page), st = await stored(page);
      ok(!/STALE-ANSWER/.test(txt) && !/question one/.test(txt), `stale answer not shown (abort ${noAbort ? 'disabled' : 'on'})`);
      ok(!/STALE-ANSWER|question one/.test(st), 'stale answer not stored');
      eq(calls.at(-1).history.length, 0, 'new chat sends no old history');
      ok(!(await page.isDisabled('#shopAiSend')), 'late answer did not touch the new chat\'s busy state');
      await ctx.close();
    }
  });

  await scenario('AI: logout → another account signs in — no late answer, no old chat', async () => {
    const { ctx, page } = await chatPage();
    await page.fill('#shopAiInput', 'SLOW owner question'); await page.click('#shopAiSend'); await sleep(200);
    await page.evaluate(() => logout()); await signIn(page, 'office1', 'Manager-Pass-2026');
    await page.evaluate(() => toggleShopAI(true)); await sleep(1800);
    const txt = await chatText(page), st = await stored(page);
    ok(!/STALE-ANSWER|owner question/.test(txt), 'office1 does not see the owner\'s chat or its late answer');
    ok(!/STALE-ANSWER|owner question/.test(st), 'nothing of it stored under any account');
    ok(!(await page.isDisabled('#shopAiSend')), 'office1 can send');
    await ctx.close();
  });

  await scenario('AI: session expires while an answer is pending — answer dropped, chat closed', async () => {
    const { ctx, page } = await chatPage();
    await page.fill('#shopAiInput', 'first quick'); await page.click('#shopAiSend'); await until(page, () => /FRESH-ANSWER/.test(document.getElementById('shopAiMessages').innerText));
    await page.fill('#shopAiInput', 'SLOW expiring question'); await page.click('#shopAiSend'); await sleep(200);
    const token = await page.evaluate(() => sessionStorage.getItem('ittr_cloud_token'));
    await srv.request('/api/auth/logout', { method: 'POST', token, body: {} });
    await page.evaluate(() => apiJSON('/api/state').catch(() => {}));
    await until(page, () => document.getElementById('loginScreen').style.display === 'flex');
    await sleep(1800);
    ok(!/STALE-ANSWER/.test(await chatText(page)) && !/expiring question/.test(await chatText(page)), 'chat screen emptied, late answer not shown');
    ok(!/STALE-ANSWER/.test(await stored(page)), 'late answer not stored');
    await signIn(page); await page.evaluate(() => toggleShopAI(true));
    ok(/FRESH-ANSWER/.test(await chatText(page)), 'same account in the same tab gets its saved chat back');
    ok(!/STALE-ANSWER/.test(await chatText(page)), 'without the dropped answer');
    await ctx.close();
  });

  await scenario('AI: attachment analysis finishing after New Chat is dropped', async () => {
    const { ctx, page } = await chatPage();
    await page.route('**/api/ai/import/analyze', async route => { await sleep(1500); await route.fulfill({ json: { ok: true, draft: { customerName: 'LATE DRAFT CO', services: [{ description: 'x', labor: [], parts: [] }] } } }).catch(() => {}); });
    await page.setInputFiles('#shopAiFile', { name: 'old-invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') });
    await page.click('#shopAiSend'); await sleep(200); await page.click('text=New Chat'); await sleep(1800);
    const txt = await chatText(page);
    ok(!/LATE DRAFT CO|Review actions/.test(txt), 'late analysis not shown in the new chat');
    eq(await page.evaluate(() => shopAiImportDraft), null, 'no draft waiting for review'); eq(await page.evaluate(() => shopAiPendingFile), null, 'attachment cleared');
    eq(await page.inputValue('#shopAiInput'), '', 'draft text cleared'); eq(await page.inputValue('#shopAiUnit'), '', 'unit context cleared');
    await ctx.close();
  });

  await scenario('service worker: current cache, new assets cached; open tab is offered the new version', async () => {
    const { ctx, page } = await newPage({ sw: 'allow' }); await page.goto(B); await signIn(page);
    const version = await page.evaluate(() => FRONTEND_VERSION);
    await page.evaluate(() => navigator.serviceWorker.ready); await until(page, () => !!navigator.serviceWorker.controller, null, 10000).catch(() => {});
    const keys = await page.evaluate(async () => (await caches.keys()));
    ok(keys.includes(`ittr-shopflow-v${version}`), `cache ittr-shopflow-v${version} exists (${keys.join(',')})`);
    ok(await page.evaluate(async v => !!(await (await caches.open(`ittr-shopflow-v${v}`)).match('/sync-queue.js')) && !!(await (await caches.open(`ittr-shopflow-v${v}`)).match('/sync-merge.js')), version), 'new sync assets are in the offline shell');
    const sw = await (await fetch(`${B}/sw.js`)).text();
    await page.route('**/sw.js', r => r.fulfill({ contentType: 'application/javascript', body: sw.replace(/ittr-shopflow-v[0-9.]+/, 'ittr-shopflow-v99.0.0-test') }));
    await page.evaluate(async () => { const reg = await navigator.serviceWorker.getRegistration(); await reg.update(); });
    await until(page, async () => (await caches.keys()).includes('ittr-shopflow-v99.0.0-test'), null, 15000);
    await until(page, async v => !(await caches.keys()).includes(`ittr-shopflow-v${v}`), version, 15000);
    await page.route('**/api/build', r => r.fulfill({ json: { frontendExpected: '99.0.0', backend: '99.0.0', build: 'test' } }));
    ok(await page.evaluate(() => ittrCheckForUpdate()), 'version check finds the new release');
    ok(await page.locator('#ittrUpdateBar').isVisible(), 'the open tab shows "a new version is ready"');
    await page.unroute('**/api/build');
    await Promise.all([page.waitForEvent('load'), page.click('#ittrUpdateBar button')]);
    ok(await page.evaluate(() => typeof ittrSync === 'object'), 'page reloaded on the new version');
    await ctx.close();
  });
} finally {
  await browser.close().catch(() => {}); await srv.cleanup();
}
if (failures.length) { console.error(`Browser regression: ${failures.length} scenario(s) failed: ${failures.join('; ')}`); process.exit(1); }
console.log('Browser regression: all scenarios passed');
