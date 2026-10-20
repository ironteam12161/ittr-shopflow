// ITTR ShopFlow control sweep: signs in as the owner, a full manager, a Customers-only manager and a mechanic, opens every
// page that account may use and clicks every visible, safe control on it (one at a time, re-reading the page after each
// click). It records page errors, server 5xx answers, failed requests and sideways scrolling, and reports per page how
// many controls were clicked and which were skipped.
//
// Skipped on purpose (never clicked): anything that deletes, voids, finalizes, sends (email/SMS/links), pays, resets,
// signs out, connects outside services or imports. Browser confirm/prompt questions are DISMISSED (only "close without saving" is accepted), so a guarded
// action never runs. Synthetic data on a throw-away database only; no provider is configured, nothing leaves the machine.
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { startTestServer, dbSuiteGuard, reportSuite } from './test_harness.mjs';

const NAME = 'control sweep';
dbSuiteGuard(NAME);
let chromium = null; try { ({ chromium } = await import('playwright')); } catch (_) {}
const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = chromium ? await chromium.launch(exe ? { executablePath: exe } : {}).catch(() => null) : null;
if (!browser) {
  if (process.env.ITTR_REQUIRE_BROWSER_SUITE === '1') { reportSuite(NAME, 'FAILED', 'Chromium not available'); console.error(`FAIL ${NAME}: Chromium not available`); process.exit(1); }
  reportSuite(NAME, 'SKIPPED', 'Chromium not available'); console.log(`SKIP ${NAME}: Chromium not available`); process.exit(0);
}
const OWNER = { username: 'owner', password: 'Shop-Boss-Pass-2026' }, MPASS = 'Manager-Pass-2026', KPASS = 'Mechanic-Pass-1';
const srv = await startTestServer({ prefix: 'ittr_sweep', admin: OWNER });
const R = srv.request;
const SKIP = /delete|remove|void|\bsend\b|send |e-?mail|text (the )?customer|\bsms\b|\btext\b|\bpay\b|payment|charge|refund|reset|sign out|log ?out|finali[sz]e|disconnect|connect|import|sync|restore|archive|merge|deactivate|start fresh|reconcile|repair|wipe|purge|revoke|turn off|logout|check email|run (all|now)|send now|apply credit|receive|record payment|approve|decline|copy link|print|download|export|csv|pdf|open .*in new|camera|scan|upload|photo|voice|mic/i;
const SKIP_ATTR = /del|void|send|email|sms|pay|reset|logout|finalize|import|sync|revoke|print|pdf|csv|download|upload|scan/i;
const results = [], problems = [];
const DIALOGS = '.modal.open,.poModal .box,#estEditor:not(.hidden) #estEditorBox,.payDlg,.blModal,.repModal,.cmpModal,.estWoDlg,.tfBackdrop,.cfmDlg';
// Controls of a container, identified by tag + text + attributes (so a re-rendered control is found again).
const CONTROLS_JS = `(root, seen) => { const out = []; for (const e of root.querySelectorAll('button,[role="button"],a[href^="#"],summary,input[type="checkbox"],select')) { if (!e.offsetParent || e.disabled || e.closest('[hidden]')) continue;
  const label = (e.getAttribute('aria-label') || e.textContent || e.value || e.name || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
  const attrs = [...e.attributes].filter(a => /^(data-|onclick|id|class)/.test(a.name)).map(a => a.name + '=' + a.value).join(' ').slice(0, 200);
  out.push({ key: e.tagName + '|' + label + '|' + attrs, label, attrs, el: e }); } return out; }`;
// v24.76.2: every control is operated by a real pointer (Playwright moves the mouse to it and checks that nothing covers
// it), not a DOM .click(). A control another element covers, or that cannot be scrolled into the window, is a problem.
// The page marks the control with data-sweep-click first; the mark is removed again before the next control is looked up.
let covered = 0;
async function pointerClick(page, who, where, label) {
  const loc = page.locator('[data-sweep-click]').first();
  try {
    if (await loc.evaluate(e => e.tagName === 'SELECT')) { const v = await loc.evaluate(e => [...e.options].find(x => x.index !== e.selectedIndex)?.value ?? null); if (v === null) return false; await loc.selectOption(v, { timeout: 2500 }); }
    else await loc.click({ timeout: 2500 });
    return true;
  } catch (e) {
    const m = String(e?.message || e), hit = m.match(/<[^\n]*?>[^\n]*?intercepts pointer events/);
    if (hit || /outside of the viewport/.test(m)) { covered++; problems.push(`${who} ${where}: "${label}" cannot be reached by the pointer${hit ? ` (${hit[0].slice(0, 160)})` : ' (outside the window)'}`); }
    return false;
  } finally { await page.evaluate(() => document.querySelectorAll('[data-sweep-click]').forEach(e => e.removeAttribute('data-sweep-click'))).catch(() => {}); }
}
// Close what a click left open, down to `keep` dialogs: Escape (answering "Discard changes" when asked), several times, so a
// dialog that appears only after it has loaded its data is closed too. One that never closes on Escape is a problem.
const openCount = page => page.evaluate(DIALOGS => [...document.querySelectorAll(DIALOGS)].filter(d => d.getClientRects().length || d.classList.contains('open')).length, DIALOGS).catch(() => 0);
async function closeAll(page, who, where, label, keep = 0) {
  for (let k = 0; k < 8; k++) {
    await page.evaluate(() => document.querySelectorAll('.ittrChoice').forEach(c => (c.querySelector('[data-discard-choice="discard"]') || c.querySelector('button:last-child'))?.click())).catch(() => {});
    if (await openCount(page) <= keep) return;
    await page.keyboard.press('Escape').catch(() => {}); await sleep(300);
  }
  if (await openCount(page) > keep) problems.push(`${who} ${where}: a dialog left open by "${label}" does not close on Escape`);
}
// Inside a dialog that a click opened: click its safe controls once each (one level deep), then close it.
async function sweepDialog(page, who, where, opener) {
  let clicked = 0; const seen = new Set();
  for (let guard = 0; guard < 30; guard++) {
    const next = await page.evaluate(({ DIALOGS, CONTROLS_JS, seen }) => { const list = [...document.querySelectorAll(DIALOGS)].filter(d => d.getClientRects().length || d.classList.contains('open')); const d = list.at(-1); if (!d) return null;
      const controls = (0, eval)(CONTROLS_JS)(d); const c = controls.find(x => !seen.includes(x.key)); return c ? { key: c.key, label: c.label, attrs: c.attrs } : null; }, { DIALOGS, CONTROLS_JS, seen: [...seen] }).catch(() => null);
    if (!next) break; seen.add(next.key);
    if (SKIP.test(next.label) || SKIP_ATTR.test(next.attrs) || /^(×|✕|x|close|cancel|back|done)$/i.test(next.label)) continue;
    const ok = await page.evaluate(({ DIALOGS, CONTROLS_JS, key }) => { const d = [...document.querySelectorAll(DIALOGS)].filter(x => x.getClientRects().length || x.classList.contains('open')).at(-1); if (!d) return false;
      const c = (0, eval)(CONTROLS_JS)(d).find(x => x.key === key); if (!c) return false; c.el.setAttribute('data-sweep-click', '1'); return true; }, { DIALOGS, CONTROLS_JS, key: next.key }).catch(() => false);
    if (!ok || !(await pointerClick(page, who, `${where} > "${opener}"`, next.label))) continue; clicked++; await sleep(400);
    // Anything this opened on top (a second dialog, a choice question) is closed again; the first dialog stays.
    await sleep(300); await closeAll(page, who, where, next.label, 1);
    if (!(await page.evaluate(() => !!session).catch(() => false))) { problems.push(`${who} ${where} > "${opener}": "${next.label}" signed the account out`); break; }
  }
  return clicked;
}

async function newPage(width) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', acceptDownloads: false });
  const page = await ctx.newPage(); page.setDefaultTimeout(6000);
  // Every browser question is dismissed (nothing guarded ever runs), except "close without saving": accepting that only
  // throws away what the sweep itself typed, and dismissing it would leave the form over the page.
  page.on('dialog', d => (/close without saving|discard (your )?changes|unsaved/i.test(d.message()) ? d.accept() : d.dismiss()).catch(() => {}));
  ctx.on('page', p => p.close().catch(() => {})); // pop-up windows (PDF previews)
  return { ctx, page };
}
async function signIn(page, u, p) {
  await page.goto(srv.base()); await page.waitForSelector('#loginUser', { state: 'visible' });
  await page.fill('#loginUser', u); await page.fill('#loginPass', p); await page.click('#loginForm button[type="submit"]');
  await page.waitForFunction(() => typeof cloudReady !== 'undefined' && cloudReady && session, null, { timeout: 15000 }); await sleep(400);
}

try {
  const owner = await srv.login(OWNER.username, OWNER.password);
  const ALL = { invoices: true, financials: true, inventory: true, customers: true, reports: true, employees: true };
  await R('/api/admin/managers', { method: 'POST', token: owner, body: { username: 'mgrfull', display: 'Manager Full', password: MPASS, permissions: ALL } });
  await R('/api/admin/managers', { method: 'POST', token: owner, body: { username: 'mgrcust', display: 'Manager Cust', password: MPASS, permissions: { customers: true } } });
  await R('/api/admin/users', { method: 'POST', token: owner, body: { username: 'mech1', display: 'Mech One', password: KPASS } });
  await R('/api/timeclock/settings', { method: 'PUT', token: owner, body: { requireClockIn: false, autoClockIn: false } }).catch(() => {});
  // Synthetic shop data: a customer, a part, open and completed work, a draft and a sent invoice, an estimate, a PO.
  const cust = (await R('/api/customers', { method: 'POST', token: owner, body: { customer_name: 'Sweep Fleet LLC', email: 'fleet@sweep.test' } })).item;
  const part = (await R('/api/parts', { method: 'POST', token: owner, body: { partNumber: 'SW-1', description: 'Sweep filter', quantity: 5, cost: 4, price: 9 } })).item;
  const st = await R('/api/state', { token: owner }), sf = st.shopflow.payload;
  sf.workorders = [...(sf.workorders || []),
    { id: 7001, unit: 'SW-UNIT-1', customer: 'Sweep Fleet LLC', status: 'In Progress', mechanic: 'mech1', helpers: [], unitType: 'customer', truckHere: true, tasks: [{ uid: 's1', t: 'Brake inspection', done: false, parts: [] }, { uid: 's2', t: 'Oil change', done: false, parts: [] }] },
    { id: 7002, unit: 'SW-UNIT-2', customer: 'Sweep Fleet LLC', status: 'Completed', mechanic: 'mech1', helpers: [], unitType: 'customer', truckHere: true, tasks: [{ uid: 's3', t: 'PM service', done: true, outcome: 'completed', parts: [] }] }];
  await R('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf, expectedVersion: st.shopflow.version } });
  const mkInv = async () => { const i = await R('/api/invoices', { method: 'POST', token: owner, body: { customerId: cust.id, customerName: cust.customer_name, unitNumber: 'SW-UNIT-1' } });
    await R(`/api/invoices/${i.id}/lines`, { method: 'POST', token: owner, body: { lineType: 'labor', description: 'Labor', quantity: 1, unitPrice: 100, taxable: false, jobName: 'J' } });
    await R(`/api/invoices/${i.id}/lines`, { method: 'POST', token: owner, body: { lineType: 'part', description: 'Sweep filter', partNumber: 'SW-1', quantity: 1, unitPrice: 9, unitCost: 4, taxable: false, jobName: 'J', inventoryPartId: part.id } }); return i.id; };
  const draft = await mkInv(); const sent = await mkInv(); await R(`/api/invoices/${sent}/finalize`, { method: 'POST', token: owner, body: {} });
  const est = await R('/api/estimates', { method: 'POST', token: owner, body: { customerName: 'Sweep Fleet LLC' } });
  await R(`/api/estimates/${est.id}/lines`, { method: 'POST', token: owner, body: { lineType: 'labor', description: 'Brakes', quantity: 1, unitPrice: 100, jobName: 'Brakes' } });
  await R('/api/purchase-orders', { method: 'POST', token: owner, body: { vendor: 'Sweep Parts Co', lines: [{ partId: part.id, quantity: 2, unitCost: 4 }] } }).catch(() => {});

  for (const [who, pass, width] of [['owner', OWNER.password, 1280], ['mgrfull', MPASS, 1280], ['mgrcust', MPASS, 900], ['mech1', KPASS, 390]]) {
    // The owner's sweep may have ticked permission boxes or changed settings; put the accounts back first.
    await R('/api/admin/managers/mgrfull', { method: 'PUT', token: owner, body: { permissions: ALL } }).catch(() => {});
    await R('/api/admin/managers/mgrcust', { method: 'PUT', token: owner, body: { permissions: { customers: true } } }).catch(() => {});
    await R('/api/timeclock/settings', { method: 'PUT', token: owner, body: { requireClockIn: false, autoClockIn: false } }).catch(() => {});
    const { ctx, page } = await newPage(width); let where = '';
    page.on('pageerror', e => problems.push(`${who} ${where}: page error: ${e.message.split('\n')[0]}`));
    page.on('response', r => { const u = new URL(r.url()); if (r.status() >= 500 && u.pathname.startsWith('/api/')) problems.push(`${who} ${where}: ${r.request().method()} ${u.pathname} -> ${r.status()}`); });
    page.on('requestfailed', q => { const f = q.failure()?.errorText || ''; if (!/ERR_ABORTED|aborted/i.test(f) && new URL(q.url()).origin === srv.base()) problems.push(`${who} ${where}: request failed ${new URL(q.url()).pathname} (${f})`); });
    await signIn(page, who, pass);
    const allowed = await page.evaluate(() => APP_VIEWS.filter(v => allowedViewForRole(v) && v !== 'wo'));
    for (const view of allowed) {
      where = view; let clicked = 0, skipped = 0, inner = 0; const seen = new Set();
      await page.evaluate(v => showView(v), view); await sleep(900);
      for (let guard = 0; guard < 80; guard++) {
        // The next visible control on this page not yet tried (identified by its text + attributes).
        const next = await page.evaluate(({ view, seen }) => {
          const host = document.getElementById(view); if (!host || host.classList.contains('hidden')) return null;
          const els = [...host.querySelectorAll('button,[role="button"],a[href^="#"],summary,input[type="checkbox"],select')].filter(e => e.offsetParent && !e.disabled && !e.closest('[hidden]'));
          for (const e of els) {
            const label = (e.getAttribute('aria-label') || e.textContent || e.value || e.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
            const attrs = [...e.attributes].filter(a => /^(data-|onclick|id|class)/.test(a.name)).map(a => `${a.name}=${a.value}`).join(' ').slice(0, 200);
            const key = `${e.tagName}|${label}|${attrs}`; if (seen.includes(key)) continue;
            e.setAttribute('data-sweep-target', '1'); return { key, label, attrs, tag: e.tagName };
          }
          return null;
        }, { view, seen: [...seen] });
        if (!next) break; seen.add(next.key);
        await page.evaluate(() => { const t = document.querySelector('[data-sweep-target]'); if (t) t.removeAttribute('data-sweep-target'); });
        if (SKIP.test(next.label) || SKIP_ATTR.test(next.attrs)) { skipped++; continue; }
        // Find the page's own element again by key (so a re-render never clicks a stale node), then click it with the pointer.
        const ok = await page.evaluate(({ view, key }) => {
          const host = document.getElementById(view); if (!host) return false;
          const els = [...host.querySelectorAll('button,[role="button"],a[href^="#"],summary,input[type="checkbox"],select')].filter(e => e.offsetParent && !e.disabled);
          for (const e of els) {
            const label = (e.getAttribute('aria-label') || e.textContent || e.value || e.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
            const attrs = [...e.attributes].filter(a => /^(data-|onclick|id|class)/.test(a.name)).map(a => `${a.name}=${a.value}`).join(' ').slice(0, 200);
            if (`${e.tagName}|${label}|${attrs}` !== key) continue;
            e.setAttribute('data-sweep-click', '1'); return true;
          }
          return false;
        }, { view, key: next.key }).catch(() => false);
        if (!ok || !(await pointerClick(page, who, view, next.label))) continue; clicked++;
        await sleep(450);
        if (await page.evaluate(DIALOGS => [...document.querySelectorAll(DIALOGS)].some(d => d.getClientRects().length || d.classList.contains('open')), DIALOGS).catch(() => false)) inner += await sweepDialog(page, who, view, next.label);
        // Close whatever opened (dialogs answer Escape; choice questions return null = nothing done) and come back.
        await closeAll(page, who, view, next.label, 0);
        const state = await page.evaluate(v => ({ cur: currentView, signedIn: !!session, sw: document.documentElement.scrollWidth, vw: innerWidth }), view).catch(() => ({ cur: '', signedIn: false }));
        if (!state.signedIn) { problems.push(`${who} ${view}: "${next.label}" signed the account out`); await signIn(page, who, pass); }
        if (state.sw > state.vw + 1) problems.push(`${who} ${view}: sideways scrolling after "${next.label}" (${state.sw}px > ${state.vw}px)`);
        if (state.cur !== view) { await page.evaluate(v => showView(v), view).catch(() => {}); await sleep(500); }
      }
      results.push({ who, view, clicked, skipped, inner });
      console.log(`  ${who.padEnd(7)} ${view.padEnd(16)} clicked ${String(clicked).padStart(3)}  in dialogs ${String(inner).padStart(3)}  skipped ${String(skipped).padStart(3)}`);
    }
    // The main editors open from table rows; open them directly and sweep inside.
    const editors = who === 'mech1' ? [['mechanic', 'work order detail', 'openDetail(7001)']]
      : who === 'mgrcust' ? [['workorders', 'work order detail', 'openDetail(7001)']]
      : [['invoices', 'draft invoice', `openInvoice(${draft})`], ['invoices', 'sent invoice', `openInvoice(${sent})`], ['workorders', 'work order detail', 'openDetail(7001)'], ['estimates', 'estimate', `ittrOpenEstimate(${est.id})`]];
    for (const [view, label, open] of editors) {
      where = `${view} > ${label}`;
      await page.evaluate(v => showView(v), view).catch(() => {}); await sleep(700);
      await page.evaluate(code => { try { return (0, eval)(code); } catch (e) { return String(e); } }, open).catch(() => {}); await sleep(900);
      const inner = await sweepDialog(page, who, view, label);
      await closeAll(page, who, view, label, 0);
      results.push({ who, view: label, clicked: 0, skipped: 0, inner });
      console.log(`  ${who.padEnd(7)} ${label.padEnd(16)} in editor ${String(inner).padStart(3)}`);
    }
    await ctx.close();
  }
  const total = results.reduce((s, r) => s + r.clicked + r.inner, 0), skipped = results.reduce((s, r) => s + r.skipped, 0);
  const uniq = [...new Set(problems)];
  if (uniq.length) { for (const p of uniq) console.error(`  problem: ${p}`); reportSuite(NAME, 'FAILED', `${uniq.length} problem(s)`); console.error(`FAIL ${NAME}: ${uniq.length} problem(s) in ${total} clicks`); process.exitCode = 1; }
  else { reportSuite(NAME, 'PASSED', `${total} pointer clicks, ${skipped} skipped, ${results.length} pages`); console.log(`PASS ${NAME}: ${total} controls clicked with the pointer on ${results.length} role/page combinations (${skipped} skipped as destructive/outbound), none covered, no page errors, 5xx, failed requests or sideways scrolling`); }
} finally { await browser.close().catch(() => {}); await srv.cleanup(); }
