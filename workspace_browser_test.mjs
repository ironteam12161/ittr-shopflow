// v24.70.0: Repair Board, work-order page, approval lanes, desktop sidebar, docked AI panel, shared tables and the
// mechanic's "report a problem on this job" — real Chromium against a disposable server + database (never production).
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dbSuiteGuard, reportSuite, startTestServer, ok, eq, sleep } from './test_harness.mjs';
const NAME = 'workspace browser';
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
const srv = await startTestServer({ prefix: 'ittr_wsbr', admin: OWNER });
const B = srv.base();
const failures = []; let STEP = '';
async function scenario(name, fn) { STEP = ''; try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.error(`FAIL ${name}${STEP ? ` [at: ${STEP}]` : ''}: ${e.message.split('\n')[0]}`); } }
async function newPage({ width = 1440, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
  const page = await ctx.newPage(); page.errors = []; page.prompts = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('dialog', d => { page.prompts.push(d.message()); (d.type() === 'prompt' ? d.accept('Customer paying first') : d.accept()).catch(() => {}); });
  return { ctx, page };
}
async function signIn(page, u, p) {
  await page.fill('#loginUser', u); await page.fill('#loginPass', p); await page.click('#loginForm button[type="submit"]');
  await page.waitForFunction(un => typeof session !== 'undefined' && session?.username === un, u, { timeout: 15000 });
  await page.waitForFunction(() => typeof cloudReady !== 'undefined' && cloudReady === true, null, { timeout: 15000 });
}
const until = (page, fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout });
const shot = async (page, name) => { const dir = process.env.ITTR_SCREENSHOT_DIR; if (dir) await page.screenshot({ path: `${dir}/${name}.png` }).catch(() => {}); };
const stageOf = (page, wo) => page.evaluate(id => document.querySelector(`#board .bdCard[data-wo="${id}"]`)?.closest('.bdCol')?.dataset.stage || '', String(wo));
const laneOf = (page, id) => page.evaluate(x => document.querySelector(`#findingLanes .lnCard[data-finding="${x}"]`)?.closest('.bdCol')?.dataset.lane || '', String(id));

try {
  const owner = await srv.login(OWNER.username, OWNER.password);
  await srv.request('/api/admin/users', { method: 'POST', token: owner, body: { username: 'mech1', display: 'Mech One', password: 'Mechanic-Pass-1' } });
  await srv.request('/api/admin/managers', { method: 'POST', token: owner, body: { username: 'office1', display: 'Office', password: 'Manager-Pass-2026', permissions: { customers: true } } });
  const st = await srv.request('/api/state', { token: owner }); const sf = st.shopflow.payload;
  const T = (uid, t, x = {}) => ({ uid, t, done: false, startedAt: '', stoppedAt: '', elapsedMs: 0, ...x });
  const now = new Date().toISOString();
  sf.workorders = [
    { id: 601, unit: 'DEMO-01', customer: 'Demo Fleet', status: 'Open', mechanic: 'mech1', helpers: [], unitType: 'customer', truckHere: false, date: '2026-10-17', time: '08:00', tasks: [T('a1', 'PM service')] },
    { id: 602, unit: 'DEMO-02', customer: 'Demo Fleet', status: 'Open', mechanic: 'mech1', helpers: [], unitType: 'customer', truckHere: true, date: '2026-10-16', time: '08:00', tasks: [T('b1', 'Check brakes'), T('b2', 'Replace wiper')] },
    { id: 603, unit: 'DEMO-03', customer: 'Sample Logistics', status: 'In Progress', mechanic: 'mech1', helpers: [], unitType: 'customer', truckHere: true, priority: 'High', date: '2026-10-16', time: '09:00', tasks: [T('c1', 'Replace LF drum', { startedAt: now, runningBy: 'mech1' }), T('c2', 'Adjust slack', { done: true, taskOutcome: 'completed', elapsedMs: 1800000 })] },
    { id: 604, unit: 'DEMO-04', customer: 'Sample Logistics', status: 'In Progress', mechanic: 'mech1', helpers: [], unitType: 'customer', truckHere: true, date: '2026-10-16', time: '10:00', tasks: [T('d1', 'Oil change', { done: true, taskOutcome: 'completed', elapsedMs: 2400000 })] },
    { id: 605, unit: 'DEMO-05', customer: 'Demo Fleet', status: 'Open', mechanic: 'mech1', helpers: [], unitType: 'customer', truckHere: true, date: '2026-10-16', time: '11:00', tasks: [T('e1', 'Inspection')] },
  ];
  sf.issues = [
    { id: 8001, wo: 602, mechanic: 'mech1', severity: 'High', description: 'LF brake lining below spec', recommendation: 'Replace LF brake shoes', approval: 'Waiting for Customer', createdAt: now, created: '10/16/2026', photoIds: [] },
    { id: 8002, wo: 602, mechanic: 'mech1', severity: 'Needs Attention', description: 'Wiper arm loose', recommendation: 'Tighten', approval: 'Waiting for Customer', createdAt: now, created: '10/16/2026', photoIds: [] },
  ];
  await srv.request('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf, expectedVersion: st.shopflow.version } });
  const serverShop = async () => (await srv.request('/api/state', { token: owner })).shopflow.payload;

  await scenario('desktop sidebar: grouped, role-aware, collapsible and remembered', async () => {
    const { ctx, page } = await newPage(); await page.goto(B); await signIn(page, OWNER.username, OWNER.password);
    const nav = await page.evaluate(() => { const n = document.querySelector('header>nav').getBoundingClientRect(), m = document.querySelector('main').getBoundingClientRect(); return { left: n.left, width: n.width, height: n.height, mainLeft: m.left }; });
    ok(nav.left === 0 && nav.width > 200 && nav.height > 500 && nav.mainLeft >= nav.width - 1, `sidebar on the left, page beside it (${JSON.stringify(nav)})`);
    const groups = await page.$$eval('header>nav .navGroupLabel', els => els.filter(e => e.offsetParent).map(e => e.textContent.trim()));
    eq(groups.join('|'), 'Shop|Customers & Units|Parts|Money|Management', 'groups in order');
    ok(!(await page.locator('header nav .navbtn[data-view="mechanic"]').isVisible()), 'mechanic-only buttons stay hidden for the owner');
    await page.click('.navCollapse'); await until(page, () => document.body.classList.contains('navCollapsed'));
    ok((await page.evaluate(() => document.querySelector('header>nav').getBoundingClientRect().width)) < 80, 'collapsed to icons');
    eq(await page.getAttribute('header nav .navbtn[data-view="invoices"]', 'title'), 'Invoices', 'collapsed buttons keep their name as a tooltip');
    await page.reload(); await until(page, () => typeof cloudReady !== 'undefined' && cloudReady, null, 15000);
    ok(await page.evaluate(() => document.body.classList.contains('navCollapsed')), 'collapse remembered after reload');
    await page.click('.navCollapse');
    const { ctx: c2, page: p2 } = await newPage(); await p2.goto(B); await signIn(p2, 'office1', 'Manager-Pass-2026');
    ok(!(await p2.locator('header nav .navbtn[data-view="invoices"]').isVisible()), 'manager without Invoices permission does not see Invoices');
    ok(await p2.locator('header nav .navbtn[data-view="board"]').isVisible(), 'manager sees the Repair Board');
    eq(page.errors.length + p2.errors.length, 0, `no script errors (${[...page.errors, ...p2.errors].join(' | ')})`); await ctx.close(); await c2.close();
  });

  await scenario('Repair Board: stages from the work order, QC, blockers, filters', async () => {
    const { ctx, page } = await newPage(); await page.goto(B); await signIn(page, OWNER.username, OWNER.password);
    await page.click('header nav .navbtn[data-view="board"]'); await until(page, () => location.hash === '#board' && document.querySelector('#board .bdCard'));
    STEP = 'stages';
    eq(await stageOf(page, 601), 'expected', 'not here yet → Expected'); eq(await stageOf(page, 602), 'approval', 'findings waiting → Approval');
    eq(await stageOf(page, 603), 'repair', 'job running → Repair'); eq(await stageOf(page, 604), 'qc', 'all jobs done → Quality Check'); eq(await stageOf(page, 605), 'checkedin', 'here, nothing started → Checked In');
    await shot(page, 'board');
    STEP = 'QC';
    await page.click('#board .bdCard[data-wo="604"] button:has-text("QC passed")'); await until(page, () => window.ittrWoStage(state.workorders.find(w => w.id === 604)) === 'ready');
    eq(await stageOf(page, 604), 'ready', 'QC passed → Ready');
    await until(page, () => ittrSync.status().pending === 0, null, 15000);
    ok((await serverShop()).workorders.find(w => w.id === 604).qc?.passedAt, 'QC saved to the server');
    STEP = 'blocker';
    await page.click('#board .bdCard[data-wo="603"] .bdMore summary'); await page.click('#board .bdCard[data-wo="603"] .bdMenu button:has-text("On hold")');
    await until(page, () => document.querySelector('#board .bdCard[data-wo="603"] .bdBlockers')?.textContent.includes('On hold'));
    ok(page.prompts.some(p => /on hold/i.test(p)), 'asks why the truck is on hold');
    await page.check('#board .bdToggle input'); await until(page, () => document.querySelectorAll('#board .bdCard').length === 1);
    eq(await page.evaluate(() => document.querySelector('#board .bdCard').dataset.wo), '603', 'Blocked only shows the held truck');
    await page.uncheck('#board .bdToggle input');
    await page.fill('#bdSearch', 'DEMO-05'); await until(page, () => document.querySelectorAll('#board .bdCard').length === 1);
    ok(await page.evaluate(() => document.activeElement?.id === 'bdSearch'), 'typing in search keeps focus');
    await page.fill('#bdSearch', '');
    await until(page, () => ittrSync.status().pending === 0, null, 15000);
    const hold = (await serverShop()).workorders.find(w => w.id === 603).blockers?.hold;
    ok(hold?.on && hold.by === 'owner' && hold.note === 'Customer paying first', 'blocker saved with who and why');
    STEP = 'expected→checked in';
    await page.click('#board .bdCard[data-wo="601"] button:has-text("Truck is here")'); await until(page, () => window.ittrWoStage(state.workorders.find(w => w.id === 601)) === 'checkedin');
    eq(page.errors.length, 0, `no script errors (${page.errors.join(' | ')})`); await ctx.close();
  });

  await scenario('work-order page: tabs in the address, reload, Back, actions refresh the page (no pop-up)', async () => {
    const { ctx, page } = await newPage(); await page.goto(`${B}/#board`); await signIn(page, OWNER.username, OWNER.password);
    await until(page, () => document.querySelector('#board .bdCard[data-wo="603"]'));
    await page.click('#board .bdCard[data-wo="603"] .bdOpen'); await until(page, () => location.hash === '#wo/603/jobs' && document.querySelector('#wo .wsHead'));
    ok((await page.textContent('#wo .wsHead')).includes('DEMO-03') && (await page.textContent('#wo .wsHead')).includes('On hold'), 'header shows unit and blockers');
    eq(await page.title(), 'Unit DEMO-03 · ITTR ShopFlow', 'tab title names the unit');
    await page.fill('#parkingEdit', 'P-7'); await page.click('#wo button:has-text("Save Parking Spot")');
    await until(page, () => state.workorders.find(w => w.id === 603).parking === 'P-7');
    ok(!(await page.evaluate(() => document.getElementById('detailModal').classList.contains('open'))), 'no pop-up opened');
    eq(await page.evaluate(() => currentView), 'wo', 'still on the work-order page'); ok((await page.textContent('#wo .wsHead')).includes('P-7'), 'page refreshed with the new parking spot');
    await page.click('#wsTab-time'); await until(page, () => location.hash === '#wo/603/time');
    ok((await page.textContent('#wsPanel')).includes('Replace LF drum'), 'time tab lists jobs');
    ok(await page.evaluate(() => getComputedStyle(document.querySelector('#wsPanel .ds-table td.num')).textAlign === 'right'), 'labor time right-aligned');
    await page.reload(); await until(page, () => typeof cloudReady !== 'undefined' && cloudReady && currentView === 'wo' && document.querySelector('#wsTab-time[aria-selected="true"]'), null, 15000);
    for (const t of ['findings', 'photos', 'inspection', 'billing', 'jobs']) { await page.click(`#wsTab-${t}`); await until(page, x => location.hash.endsWith(`/${x}`), t); }
    await page.goBack(); await until(page, () => currentView === 'board'); ok(await page.locator('#board').isVisible(), 'Back returns to the board');
    STEP = 'manager billing';
    const { ctx: c2, page: p2 } = await newPage(); await p2.goto(`${B}/#wo/603/billing`); await signIn(p2, 'office1', 'Manager-Pass-2026');
    await until(p2, () => currentView === 'wo' && document.querySelector('#wsPanel'));
    ok((await p2.textContent('#wsPanel')).includes('Invoices permission'), 'billing tab respects the Invoices permission');
    eq(page.errors.length + p2.errors.length, 0, `no script errors (${[...page.errors, ...p2.errors].join(' | ')})`); await ctx.close(); await c2.close();
  });

  await scenario('approval lanes: review, send to customer, approve → job created, decline', async () => {
    const { ctx, page } = await newPage(); await page.goto(B); await signIn(page, OWNER.username, OWNER.password);
    await page.click('header nav .navbtn[data-view="approvals"]'); await until(page, () => document.querySelector('#findingLanes .lnCard'));
    eq(await laneOf(page, 8001), 'reported', 'new finding in Reported');
    await page.click('#findingLanes .lnCard[data-finding="8001"] button:has-text("Mark reviewed")'); await until(page, () => window.ittrFindingLane(state.issues.find(i => i.id === 8001)) === 'review');
    eq(await laneOf(page, 8001), 'review', 'reviewed → Office Review');
    await page.click('#findingLanes .lnCard[data-finding="8001"] button:has-text("Send to customer")');
    await until(page, () => document.getElementById('shareLinkModal')?.classList.contains('open'));
    await page.click('#shareLinkModal [data-share="create"]'); await until(page, () => document.getElementById('shareUrlInput')?.value.includes('/c/'), null, 15000);
    await page.evaluate(() => closeModal('shareLinkModal'));
    await until(page, () => ['8001', '8002'].every(id => window.ittrFindingLane(state.issues.find(i => String(i.id) === id)) === 'customer'));
    eq(await laneOf(page, 8002), 'customer', 'all open findings of the truck moved to Customer Approval');
    await shot(page, 'lanes');
    await page.click('#findingLanes .lnCard[data-finding="8001"] button:has-text("Approve")');
    await until(page, () => window.ittrFindingLane(state.issues.find(i => i.id === 8001)) === 'job', null, 15000);
    ok(await page.evaluate(() => state.workorders.find(w => w.id === 602).tasks.some(t => String(t.findingId) === '8001')), 'approved finding is a job on the work order');
    await page.click('#findingLanes .lnCard[data-finding="8002"] button:has-text("Decline")');
    await until(page, () => window.ittrFindingLane(state.issues.find(i => i.id === 8002)) === 'declined', null, 15000);
    await page.click('#findingModes button:has-text("List by date")'); ok(await page.locator('#approvalIssues').isVisible(), 'list view still there');
    await page.click('#findingModes button:has-text("Approval lanes")');
    eq(page.errors.length, 0, `no script errors (${page.errors.join(' | ')})`); await ctx.close();
  });

  await scenario('docked AI panel takes its own column; page content is not covered', async () => {
    const { ctx, page } = await newPage(); await page.goto(`${B}/#board`); await signIn(page, OWNER.username, OWNER.password);
    await page.evaluate(() => toggleShopAI(true)); await until(page, () => document.body.classList.contains('aiChatOpen'));
    const g = await page.evaluate(() => { const p = document.getElementById('shopAiPanel').getBoundingClientRect(), m = document.querySelector('main').getBoundingClientRect(); return { pl: p.left, pr: p.right, mr: m.right, w: innerWidth }; });
    ok(Math.abs(g.pr - g.w) < 2 && g.mr <= g.pl + 1, `panel docked right and page ends before it (${JSON.stringify(g)})`);
    await shot(page, 'ai-docked');
    await page.evaluate(() => toggleShopAI(false)); await until(page, () => !document.body.classList.contains('aiChatOpen'));
    ok((await page.evaluate(() => document.querySelector('main').getBoundingClientRect().right)) > 1400, 'page gets its width back');
    eq(page.errors.length, 0, `no script errors (${page.errors.join(' | ')})`); await ctx.close();
  });

  await scenario('phone: board and work-order page fit, tables become cards, Ukrainian labels', async () => {
    const { ctx, page } = await newPage({ width: 390, height: 844 }); await page.goto(`${B}/#board`); await signIn(page, OWNER.username, OWNER.password);
    await until(page, () => document.querySelector('#board .bdCard'));
    ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390, 'board: no sideways scroll');
    ok(await page.locator('#board .bdStagePick').isVisible(), 'stage picker on phone');
    await page.click('#board .bdStagePick button:has-text("Expected")'); await until(page, () => [...document.querySelectorAll('#board .bdCol')].filter(c => c.offsetParent).length === 1);
    await page.click('#board .bdStagePick button:has-text("Expected")');
    await shot(page, 'phone-board');
    await page.goto(`${B}/#wo/603/time`); await until(page, () => currentView === 'wo' && document.querySelector('#wsPanel table'), null, 15000);
    ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390, 'work-order page: no sideways scroll');
    await until(page, () => document.querySelector('#wsPanel table.ds-cards'));
    const card = await page.evaluate(() => { const t = document.querySelector('#wsPanel table.ds-cards'); return t && getComputedStyle(t.tHead).display === 'none' && t.querySelector('td').dataset.dsLabel === 'Job'; });
    ok(card, 'table shown as labelled cards on a phone');
    await page.selectOption('#languageSelect', 'uk'); await page.waitForLoadState('load'); await sleep(400);
    await until(page, () => typeof cloudReady !== 'undefined' && cloudReady && currentLanguage === 'uk', null, 15000);
    await page.evaluate(() => showView('board')); await until(page, () => document.querySelector('#board h1')?.textContent.includes('Дошка ремонтів'));
    ok((await page.textContent('#board')).includes('Очікується'), 'stage names in Ukrainian');
    await page.selectOption('#languageSelect', 'en'); await page.waitForLoadState('load');
    eq(page.errors.length, 0, `no script errors (${page.errors.join(' | ')})`); await ctx.close();
  });

  await scenario('mechanic phone: report a problem on a job → finding names the job; job photos section', async () => {
    const { ctx, page } = await newPage({ width: 390, height: 844 }); await page.goto(B); await signIn(page, 'mech1', 'Mechanic-Pass-1');
    ok(!(await page.locator('#mobileBottomNav [data-mobile-view="board"]').isVisible()), 'no office pages for the mechanic');
    await page.evaluate(() => openDetail(603)); await until(page, () => document.getElementById('detailModal').classList.contains('open'));
    eq(await page.locator('#detailModal .taskReport button').count(), 2, 'report button on each job');
    await page.locator('#detailModal .taskReport button').first().click(); await until(page, () => document.getElementById('issueModal').classList.contains('open'));
    eq(await page.inputValue('#issueTask'), 'c1', 'job picked in the finding form'); eq(await page.inputValue('#issueWO'), '603', 'truck picked');
    await page.fill('#issueForm [name="description"]', 'Drum scored on LF'); await page.click('#issueForm button[type="submit"]');
    await until(page, () => state.issues.some(i => i.description === 'Drum scored on LF'));
    await until(page, () => ittrSync.status().pending === 0, null, 15000);
    const f = (await serverShop()).issues.find(i => i.description === 'Drum scored on LF');
    ok(f && f.taskUid === 'c1' && f.taskSnapshot === 'Replace LF drum', 'finding saved with its job');
    ok(f.officeReviewedAt === '' && f.sentAt === '', 'new finding starts in Reported');
    ok((await page.textContent('#issues')).includes('Found on job'), 'finding card names the job');
    await page.evaluate(() => openDetail(603)); await until(page, () => document.getElementById('detailModal').classList.contains('open'));
    ok((await page.textContent('#detailBody')).includes('Photos for this job'), 'job photos section on the job');
    ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390, 'no sideways scroll');
    eq(page.errors.length, 0, `no script errors (${page.errors.join(' | ')})`); await ctx.close();
  });
} catch (e) {
  console.error(e); failures.push('setup');
} finally {
  await browser.close().catch(() => {}); await srv.cleanup();
}
if (failures.length) { console.error(`FAIL ${NAME}: ${failures.join('; ')}`); console.error(srv.output().slice(-2000)); process.exitCode = 1; }
else console.log(`PASS ${NAME}: all scenarios`);
