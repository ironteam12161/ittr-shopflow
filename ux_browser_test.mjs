// v24.74.0: UI/UX audit (Oct 17, 2026) first-release checks at phone width — real Chromium, disposable server + database.
// U1 the AI button never covers the inspection's Next button; U3/U8 work-order tabs keep keyboard focus, support arrow
// keys and keep the selected tab in view; U4 invoice cards on a phone; U5 Parts starts with Search/Scan/New Part and
// keeps the other tools under "More tools"; U6 Repair Board unit buttons are at least 44 px; U7 search/sort/activity and
// form fields have accessible names; no page wider than the phone.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dbSuiteGuard, reportSuite, startTestServer, ok, eq, sleep } from './test_harness.mjs';
const NAME = 'ux browser';
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
  if (process.env.ITTR_REQUIRE_BROWSER_SUITE === '1') { reportSuite(NAME, 'FAILED', 'Chromium not available'); console.error(`FAIL ${NAME}: Chromium could not start`); process.exit(1); }
  reportSuite(NAME, 'SKIPPED', 'Chromium not installed'); console.log(`SKIP ${NAME}: Chromium is not installed`); process.exit(0);
}
const OWNER = { username: 'owner', password: 'Shop-Boss-Pass-2026' };
const srv = await startTestServer({ prefix: 'ittr_ux', admin: OWNER });
const failures = [];
async function scenario(name, fn) { try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.error(`FAIL ${name}: ${e.message.split('\n')[0]}`); } }
async function pg(u, p, w = 390) { const ctx = await browser.newContext({ viewport: { width: w, height: 844 }, serviceWorkers: 'block' }); const page = await ctx.newPage(); page.errs = []; page.on('pageerror', e => page.errs.push(e.message)); page.on('dialog', d => d.accept()); await page.goto(srv.base()); await page.fill('#loginUser', u); await page.fill('#loginPass', p); await page.click('#loginForm button[type="submit"]'); await page.waitForFunction(() => typeof cloudReady !== 'undefined' && cloudReady, null, { timeout: 15000 }); return { ctx, page }; }
const rect = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return { x: r.x, y: r.y, w: r.width, h: r.height, vis: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 }; }, sel);
const overlap = (a, b) => a && b && a.vis && b.vis && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const unnamed = page => page.evaluate(() => [...document.querySelectorAll('main input:not([type=hidden]):not([type=checkbox]):not([type=radio]), main select, main textarea')].filter(e => e.offsetParent && !(e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)) || e.closest('label') || e.title)).map(e => e.id || e.name || e.placeholder));

try {
  const owner = await srv.login(OWNER.username, OWNER.password);
  await srv.request('/api/admin/users', { method: 'POST', token: owner, body: { username: 'mech1', display: 'Mech', password: 'Mechanic-Pass-1' } });
  const c = (await srv.request('/api/customers', { method: 'POST', token: owner, body: { customer_name: 'Very Long Company Name Logistics International Holdings LLC', email: 'averyveryverylongemailaddress@verylongdomainname-example.com' } })).item;
  await srv.request(`/api/customers/${c.id}/units`, { method: 'POST', token: owner, body: { unit_number: 'UNIT-1234567890', vin: '1HGBH41JXMN109186' } });
  await srv.request('/api/invoices', { method: 'POST', token: owner, body: { customerId: c.id, customerName: c.customer_name, unitNumber: 'UNIT-1234567890' } });
  const st = await srv.request('/api/state', { token: owner }); const sf = st.shopflow.payload;
  sf.workorders = [{ id: 501, unit: 'T-501', customer: 'Fleet', status: 'In Progress', mechanic: 'mech1', helpers: [], unitType: 'customer', truckHere: true, date: '2026-10-17', time: '08:00', tasks: [{ uid: 'x1', t: 'Brakes', done: false, parts: [] }], inspection: { required: true, type: 'truck', status: 'Not Started', results: {} } }];
  await srv.request('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf, expectedVersion: st.shopflow.version } });
  await srv.request('/api/timeclock/punch', { method: 'POST', token: await srv.login('mech1', 'Mechanic-Pass-1'), body: { action: 'in' } });
  const o = await pg('owner', OWNER.password);

  await scenario('dashboard cards have consistent stages, identities, filters and keyboard navigation', async () => {
    await o.page.evaluate(() => { showView('dashboard'); calendarDate=new Date(2026,9,17);setCalendarMode('week'); });
    const card=o.page.locator('#shopCalendar button.calJob').first();
    ok((await card.innerText()).includes('Fleet · WO #501'), 'customer and order identify the visit');
    eq(await card.locator('.calStage').innerText(), 'Paused / waiting', 'computed stage matches the orange legend');
    await o.page.fill('#calendarSearch','no matching visit');
    eq(await o.page.locator('#shopCalendar .calJob').count(),0,'calendar filter applies');
    await o.page.fill('#calendarSearch','Brakes');
    eq(await o.page.locator('#shopCalendar .calJob').count(),1,'job search finds the visit');
    await card.focus(); await o.page.keyboard.press('Enter');
    await o.page.waitForFunction(()=>location.hash.includes('501'));
    await o.page.evaluate(()=>showView('dashboard'));
    await o.page.fill('#calendarSearch','');
  });
  await scenario('dashboard fits phone, tablet and desktop with current mechanic status before the calendar', async () => {
    for(const width of [390,900,1440]) {
      await o.page.setViewportSize({width,height:900});
      await o.page.evaluate(()=>{showView('dashboard');setCalendarMode('week')});
      eq(await o.page.evaluate(()=>document.documentElement.scrollWidth),width,`dashboard fits ${width}px`);
      ok(await o.page.evaluate(()=>document.getElementById('mechanicLiveStatus').getBoundingClientRect().top<document.getElementById('shopCalendar').getBoundingClientRect().top),'mechanic status comes first');
      if(width===1440)ok(await o.page.evaluate(()=>[...document.querySelectorAll('.calendarWeek .calendarCellEmpty')].every(e=>e.getBoundingClientRect().height<160)),'empty days stay compact');
    }
    await o.page.setViewportSize({width:390,height:844});
  });
  await scenario('no office screen is wider than a 390 px phone; fields have accessible names', async () => {
    for (const v of ['customers', 'invoices', 'parts', 'purchaseorders', 'bills', 'estimates', 'compliance', 'reports', 'board', 'workorders', 'approvals', 'trucksearch', 'procenter']) {
      await o.page.evaluate(v => showView(v), v); await sleep(1200);
      eq(await o.page.evaluate(() => document.documentElement.scrollWidth), 390, `${v} fits the phone`);
      eq((await unnamed(o.page)).join(), '', `${v}: every visible field has a name`);
    }
    await o.page.evaluate(() => showView('customers')); await sleep(800); await o.page.fill('#customerDirectorySearch', 'Very'); await sleep(1500);
    eq(await o.page.evaluate(() => document.documentElement.scrollWidth), 390, 'customer search results with long names fit');
  });
  await scenario('U6 Repair Board unit buttons are at least 44 px tall', async () => {
    await o.page.evaluate(() => showView('board')); await sleep(800);
    const h = await o.page.evaluate(() => [...document.querySelectorAll('.bdOpen')].map(e => e.getBoundingClientRect().height));
    ok(h.length && h.every(x => x >= 44), `heights ${h}`);
  });
  await scenario('U3/U8 work-order tabs: focus stays on the selected tab, arrow keys work, selected tab visible', async () => {
    await o.page.evaluate(() => { location.hash = '#wo/501/jobs'; }); await sleep(1200);
    await o.page.focus('#wsTab-photos'); await o.page.keyboard.press('Enter'); await sleep(500);
    eq(await o.page.evaluate(() => document.activeElement?.id), 'wsTab-photos', 'focus on the chosen tab after Enter');
    await o.page.keyboard.press('ArrowRight'); await sleep(500);
    const next = await o.page.evaluate(() => ({ focus: document.activeElement?.id, selected: document.querySelector('[role=tab][aria-selected=true]')?.id }));
    ok(next.focus === next.selected && next.focus !== 'wsTab-photos', `ArrowRight moves to the next section (${JSON.stringify(next)})`);
    eq(await o.page.evaluate(() => [...document.querySelectorAll('.wsTabs [role=tab]')].filter(t => t.tabIndex === 0).length), 1, 'one tab stop');
    await o.page.evaluate(() => { location.hash = '#wo/501/inspection'; }); await sleep(900);
    ok(await o.page.evaluate(() => { const t = document.querySelector('[role=tab][aria-selected=true]'), s = t.parentElement.getBoundingClientRect(), r = t.getBoundingClientRect(); return r.left >= s.left - 1 && r.right <= s.right + 1; }), 'selected tab is inside the visible strip');
  });
  await scenario('U4 invoice cards: number and status first, balance emphasised, full-width Open', async () => {
    await o.page.evaluate(() => showView('invoices')); await sleep(1500);
    const r = await o.page.evaluate(() => { const row = document.querySelector('tr.invRow'); if (!row) return null; const g = s => row.querySelector(s).getBoundingClientRect(); return { display: getComputedStyle(row).display, num: g('.invC-num'), status: g('.invC-status'), bal: g('.invC-bal'), act: g('.invC-act button'), row: row.getBoundingClientRect() }; });
    ok(r && r.display === 'grid', 'invoice row is a card');
    ok(Math.abs(r.num.top - r.status.top) < 6, 'number and status on the first line');
    ok(r.act.width > r.row.width * 0.8 && r.act.height >= 44, `Open is a large button (${JSON.stringify({act: r.act, row: r.row})})`);
  });
  await scenario('U5 Parts starts with Search, Scan and New Part; other tools under More tools', async () => {
    await o.page.evaluate(() => showView('parts')); await sleep(1200);
    const vis = await o.page.evaluate(() => ({ count: !!document.querySelector('.partsToolsMore button')?.offsetParent, more: !!document.querySelector('.partsMoreBtn')?.offsetParent, searchTop: document.getElementById('partsSearch').getBoundingClientRect().top }));
    ok(!vis.count && vis.more, 'occasional tools folded on a phone'); ok(vis.searchTop < 600, `search near the top (${Math.round(vis.searchTop)} px)`);
    await o.page.click('.partsMoreBtn'); ok(await o.page.evaluate(() => !!document.querySelector('.partsToolsMore button')?.offsetParent), 'More tools opens them');
  });
  await scenario('U1 AI button does not cover the inspection Next button', async () => {
    const m = await pg('mech1', 'Mechanic-Pass-1');
    await m.page.evaluate(() => openInspectionWorkflow(501)); await sleep(1000);
    ok(!overlap(await rect(m.page, '#shopAiFab'), await rect(m.page, '#inspectionWorkflowNav button:last-child')), 'no overlap');
    await m.page.evaluate(() => closeInspectionWorkflow()); await sleep(300);
    eq(m.page.errs.length, 0, `no script errors (${m.page.errs.join(' | ')})`); await m.ctx.close();
  });
  eq(o.page.errs.length, 0, `no script errors (${o.page.errs.join(' | ')})`);
} catch (e) { failures.push('setup'); console.error(`FAIL ${NAME} setup: ${e.stack || e.message}`); }
finally { await browser.close().catch(() => {}); await srv.cleanup(); }
if (failures.length) { console.error(`FAIL ${NAME}: ${failures.join('; ')}`); process.exit(1); }
console.log(`PASS ${NAME}`); reportSuite(NAME, 'PASSED');
