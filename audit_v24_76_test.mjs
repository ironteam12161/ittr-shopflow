// v24.76.0: regression suite for the October 19, 2026 audit of v24.75.3 (67c178d) — real server, disposable database,
// real Chromium. Every scenario reproduces one confirmed finding exactly as the audit describes it.
// A1  manager permissions survive login, reload (session restore) and account switching (full / restricted / mixed).
// A2  invoice finalize/void, work-order parts and parts receiving announce every affected area (inventory, customers,
//     bills); an open Parts screen in another browser converges to the server quantity without a reload.
// A3  after the live socket reconnects, screens loaded on their own (Parts, Invoices, Customers, Bills, POs) refresh
//     the areas that changed while disconnected — once, not in a storm.
// A4  the stale-data Refresh is clickable over the invoice editor and reloads the open invoice; an unsaved draft is
//     never replaced without the person choosing to.
// A5  Operations "Audit / Repair History Links" works; GET /api/fullbay/history/import-audit answers (empty and populated).
// A6  a slow page that finishes after another page opened does not change the address, title or scroll.
// A7  an older search response never replaces the results of a newer query (or of a cleared search).
// A8  offline sign-out removes the open invoice from memory and from the hidden editor; unsent edits stay account-bound.
// A9  dialogs: name, initial focus, Tab/Shift+Tab containment, Escape, unsaved-changes protection, focus restore, nesting.
// A10 customer portal photos: named thumbnail buttons; viewer with Close, Escape, zoom and focus restore.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dbSuiteGuard, reportSuite, startTestServer, ok, eq, sleep } from './test_harness.mjs';
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');
const NAME = 'audit v24.76';
dbSuiteGuard(NAME);
let chromium = null; try { ({ chromium } = require('playwright')); } catch (_) {}
const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = chromium ? await chromium.launch(exe ? { executablePath: exe } : {}).catch(() => null) : null;
if (!browser) {
  if (process.env.ITTR_REQUIRE_BROWSER_SUITE === '1') { reportSuite(NAME, 'FAILED', 'Chromium not available'); console.error(`FAIL ${NAME}: Chromium not available`); process.exit(1); }
  reportSuite(NAME, 'SKIPPED', 'Chromium not available'); console.log(`SKIP ${NAME}: Chromium not available`); process.exit(0);
}
const OWNER = { username: 'owner', password: 'Shop-Boss-Pass-2026' };
const srv = await startTestServer({ prefix: 'ittr_a76', admin: OWNER, env: { STRIPE_WEBHOOK_SECRET: 'whsec_test_ittr' } });
const R = srv.request, db = srv.db;
const failures = [];
// ITTR_AUDIT_ONLY=A16,A19 runs only those scenarios (local debugging); the full check always runs all of them.
const ONLY = (process.env.ITTR_AUDIT_ONLY || '').split(',').filter(Boolean);
async function scenario(name, fn) { if (ONLY.length && !ONLY.some(p => name.startsWith(p + ' '))) return; try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.error(`FAIL ${name}: ${e.message.split('\n')[0]}`); } }
const MPASS = 'Manager-Pass-2026', KPASS = 'Mechanic-Pass-1';
const ALL = { invoices: true, financials: true, inventory: true, customers: true, reports: true, employees: true };
const until = async (fn, ms = 6000, step = 100) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { try { v = await fn(); if (v) return v; } catch (_) {} await sleep(step); } return v; };

async function newPage(width = 1280) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage(); page.setDefaultTimeout(8000);
  page.errs = []; page.on('pageerror', e => page.errs.push(e.message));
  page.dialogs = []; page.on('dialog', d => { page.dialogs.push(d.message()); d.accept().catch(() => {}); });
  return { ctx, page };
}
async function signIn(page, u, p) {
  if (!page.url().startsWith(srv.base())) await page.goto(srv.base());
  await page.waitForSelector('#loginUser', { state: 'visible' });
  await page.fill('#loginUser', u); await page.fill('#loginPass', p); await page.click('#loginForm button[type="submit"]');
  await page.waitForFunction(() => typeof cloudReady !== 'undefined' && cloudReady && session, null, { timeout: 15000 }); await sleep(300);
}
const signOut = async page => { await page.evaluate(() => { window.ITTR_NO_LOGOUT_RELOAD = true; return logout(); }); await page.waitForSelector('#loginUser', { state: 'visible' }); };
const views = page => page.evaluate(() => ['customers', 'parts', 'purchaseorders', 'estimates', 'invoices', 'bills', 'reports', 'accounts', 'compliance', 'trucksearch', 'activityhistory'].filter(v => allowedViewForRole(v)).join(','));
const navVisible = page => page.evaluate(() => [...document.querySelectorAll('header nav .navbtn[data-view]')].filter(b => b.offsetParent).map(b => b.dataset.view).sort().join(','));

try {
  const owner = await srv.login(OWNER.username, OWNER.password);
  const mgr = async (username, permissions) => { await R('/api/admin/managers', { method: 'POST', token: owner, body: { username, display: username, password: MPASS, permissions } }); return srv.login(username, MPASS); };
  const mgrFull = await mgr('mgrfull', ALL); await mgr('mgrcust', { customers: true }); await mgr('mgrmix', { invoices: true, inventory: true });
  for (const u of ['mech1', 'mech2']) await R('/api/admin/users', { method: 'POST', token: owner, body: { username: u, display: u, password: KPASS } });
  await R('/api/timeclock/settings', { method: 'PUT', token: owner, body: { requireClockIn: false, autoClockIn: false } }).catch(() => {});
  const cust = (await R('/api/customers', { method: 'POST', token: owner, body: { customer_name: 'Private Audit Fleet LLC', email: 'private-fleet@audit.test' } })).item;
  await R('/api/customers', { method: 'POST', token: owner, body: { customer_name: 'Older Search Fleet' } });
  await R('/api/customers', { method: 'POST', token: owner, body: { customer_name: 'Newer Search Fleet' } });
  const part = (await R('/api/parts', { method: 'POST', token: owner, body: { partNumber: 'SYNC-PART-1', description: 'Sync audit filter', quantity: 10, cost: 4, price: 9 } })).item;
  const qty = async () => Number((await db.query('SELECT quantity FROM fullbay_import_parts WHERE id=$1', [part.id])).rows[0].quantity);
  const newInvoice = async (q = 1) => { const i = await R('/api/invoices', { method: 'POST', token: owner, body: { customerId: cust.id, customerName: cust.customer_name, unitNumber: 'AUD-1', customerNote: 'Original note' } });
    await R(`/api/invoices/${i.id}/lines`, { method: 'POST', token: owner, body: { lineType: 'part', description: 'Sync audit filter', partNumber: 'SYNC-PART-1', quantity: q, unitPrice: 9, unitCost: 4, taxable: false, jobName: 'Parts', inventoryPartId: part.id } }); return i.id; };

  // ---------- A1 ----------
  const EXPECT = { mgrfull: 'customers,parts,purchaseorders,estimates,invoices,bills,reports,accounts,compliance,trucksearch,activityhistory', mgrcust: 'customers,compliance,trucksearch', mgrmix: 'parts,purchaseorders,estimates,invoices,bills' };
  for (const [u, want] of Object.entries(EXPECT)) await scenario(`A1 ${u}: permission-controlled views after login, reload and account switch`, async () => {
    const { ctx, page } = await newPage(); await signIn(page, u, MPASS);
    eq(await views(page), want, 'after login');
    for (const v of want.split(',')) ok((await navVisible(page)).split(',').includes(v) || ['compliance', 'trucksearch', 'activityhistory', 'accounts'].includes(v), `${v} in the menu`);
    await page.reload(); await page.waitForFunction(() => typeof cloudReady !== 'undefined' && cloudReady && session, null, { timeout: 15000 }); await sleep(300);
    eq(await views(page), want, 'after reload (session restore)');
    if (want.includes('parts')) { await page.evaluate(() => showView('parts')); await sleep(600); eq(await page.evaluate(() => currentView), 'parts', 'can open Parts'); }
    await signOut(page); await signIn(page, 'mgrcust', MPASS); eq(await views(page), EXPECT.mgrcust, 'next account gets its own permissions');
    await ctx.close();
  });
  await scenario('A1 a permission removed by the owner takes effect in the open session', async () => {
    const { ctx, page } = await newPage(); await signIn(page, 'mgrmix', MPASS);
    ok((await views(page)).includes('invoices'), 'invoices at first');
    await R('/api/admin/managers/mgrmix', { method: 'PUT', token: owner, body: { permissions: { inventory: true } } }).catch(async () => R('/api/admin/managers/mgrmix/permissions', { method: 'PUT', token: owner, body: { permissions: { inventory: true } } }));
    eq((await R('/api/invoices', { token: await srv.login('mgrmix', MPASS), allowError: true })).status, 403, 'server refuses at once');
    await page.reload(); await page.waitForFunction(() => typeof cloudReady !== 'undefined' && cloudReady && session, null, { timeout: 15000 }); await sleep(300);
    ok(!(await views(page)).includes('invoices') && (await views(page)).includes('parts'), 'screen follows the server after reload');
    await ctx.close();
  });

  // ---------- A2 ----------
  const socket = async tok => { const ws = new WebSocket(srv.base().replace('http', 'ws') + '/ws/shop-status'), msgs = []; ws.on('message', d => { try { msgs.push(JSON.parse(String(d))); } catch (_) {} });
    await new Promise((res, rej) => { ws.on('open', () => { ws.send(JSON.stringify({ type: 'auth', token: tok })); res(); }); ws.on('error', rej); }); await until(() => msgs.some(m => m.type === 'connected'), 4000); return { ws, msgs }; };
  await scenario('A2 every stock change announces inventory (and the other areas it touches)', async () => {
    const s = await socket(mgrFull), domains = () => new Set(s.msgs.filter(m => m.type === 'data_changed').map(m => m.domain)), reset = () => { s.msgs.length = 0; };
    const inv = await newInvoice(1); await sleep(500); reset();
    await R(`/api/invoices/${inv}/finalize`, { method: 'POST', token: owner }); eq(await qty(), 9, 'finalize took one from stock');
    await until(() => domains().has('inventory'), 2500); ok(domains().has('inventory'), `finalize announces inventory (got ${[...domains()]})`); ok(domains().has('customers'), 'and the customer balance');
    reset(); await R(`/api/invoices/${inv}/void`, { method: 'POST', token: owner, body: { reason: 'audit' } }); eq(await qty(), 10, 'void returned it');
    await until(() => domains().has('inventory'), 2500); ok(domains().has('inventory'), 'void announces inventory');
    const st = await R('/api/state', { token: owner }), sf = st.shopflow.payload;
    sf.workorders = [{ id: 9101, unit: 'AUD-WO', customer: 'Private Audit Fleet LLC', status: 'In Progress', mechanic: 'mech1', helpers: [], unitType: 'customer', truckHere: true, tasks: [{ uid: 'aw1', t: 'Filter', done: false, parts: [] }] }];
    await R('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf, expectedVersion: st.shopflow.version } });
    reset(); await R('/api/work-orders/9101/tasks/by-uid/aw1/parts', { method: 'POST', token: await srv.login('mech1', KPASS), body: { inventoryPartId: part.id, partNumber: 'SYNC-PART-1', description: 'Sync audit filter', qty: 1 } });
    await until(() => domains().has('inventory'), 2500); ok(domains().has('inventory'), 'a part reserved on a work order announces inventory');
    s.ws.close();
  });
  await scenario('A2 an open Parts screen in a second browser shows the finalized quantity without a reload', async () => {
    await db.query('UPDATE fullbay_import_parts SET quantity=10,allocated=0 WHERE id=$1', [part.id]);
    const { ctx, page } = await newPage(); await signIn(page, 'mgrfull', MPASS);
    await page.evaluate(() => showView('parts')); await page.waitForSelector('#partsList .partsRow'); await sleep(800);
    const inv = await newInvoice(1); await sleep(900);
    let fetched = 0; page.on('request', r => { if (/\/api\/parts\?/.test(r.url())) fetched++; });
    await R(`/api/invoices/${inv}/finalize`, { method: 'POST', token: owner }); eq(await qty(), 9, 'server 10 → 9');
    const shown = await until(() => page.evaluate(() => [...document.querySelectorAll('#partsList .partsRow')].find(r => r.textContent.includes('SYNC-PART-1'))?.querySelector('[data-label="On hand"]')?.textContent.trim()).then(t => /^9\b/.test(t || '') ? t : ''), 5000);
    ok(shown, 'Parts shows 9'); ok(fetched >= 1 && fetched <= 3, `Parts fetched once or a few times, not a storm (${fetched})`);
    eq(await qty(), 9, 'no duplicate stock change from the refresh');
    await ctx.close();
  });

  // ---------- A3 ----------
  await scenario('A3 reconnecting refreshes a screen whose area changed while disconnected (no storm)', async () => {
    const { ctx, page } = await newPage(); await signIn(page, 'mgrfull', MPASS);
    await page.evaluate(() => showView('parts')); await page.waitForSelector('#partsList .partsRow'); await sleep(800);
    await page.evaluate(() => stopLiveStatusSocket()); await sleep(1200); // the close completes before the change
    const before = await qty(); await R(`/api/parts/${part.id}/transaction`, { method: 'POST', token: owner, body: { type: 'adjust_add', qty: 3, note: 'audit reconnect' } });
    eq(await qty(), before + 3, 'server changed while this screen was disconnected');
    let fetched = 0; page.on('request', r => { if (/\/api\/parts\?/.test(r.url())) fetched++; });
    await page.evaluate(() => { liveSocketStopped = false; connectLiveStatusSocket(); });
    const want = String(before + 3);
    const shown = await until(() => page.evaluate(w => [...document.querySelectorAll('#partsList .partsRow')].find(r => r.textContent.includes('SYNC-PART-1'))?.querySelector('[data-label="On hand"]')?.textContent.trim().startsWith(w), want), 5000);
    ok(shown, `Parts shows ${want} after reconnect`); ok(fetched >= 1 && fetched <= 2, `one refresh, not a storm (${fetched})`);
    // Nothing changed meanwhile: a second reconnect does not refetch.
    fetched = 0; await page.evaluate(() => stopLiveStatusSocket()); await page.evaluate(() => { liveSocketStopped = false; connectLiveStatusSocket(); }); await sleep(1500);
    eq(fetched, 0, 'reconnect with no missed change does not reload');
    for (const [view, change] of [['invoices', async () => R('/api/invoices', { method: 'POST', token: owner, body: { customerName: 'Reconnect Invoice Co' } })], ['customers', async () => R('/api/customers', { method: 'POST', token: owner, body: { customer_name: 'Reconnect Customer Co' } })], ['bills', async () => R('/api/bills', { method: 'POST', token: owner, body: { vendor: 'Reconnect Vendor', billNumber: `RB-${Date.now()}`, billDate: '2026-10-19', lines: [{ description: 'x', amount: 5, category: 'parts' }] } }).catch(e => e)], ['purchaseorders', async () => R('/api/purchase-orders', { method: 'POST', token: owner, body: { vendor: 'Reconnect PO Vendor', lines: [{ partNumber: 'SYNC-PART-1', description: 'x', qty: 1, unitCost: 1, inventoryPartId: part.id }] } }).catch(e => e)]]) {
      await page.evaluate(v => showView(v), view); await sleep(1200);
      await page.evaluate(() => stopLiveStatusSocket()); await sleep(1200); await change(); await sleep(400);
      let n = 0; const re = { invoices: /\/api\/invoices(\?|$)/, customers: /\/api\/customers(\?|$)/, bills: /\/api\/bills(\?|$)/, purchaseorders: /\/api\/purchase-orders(\?|$)/ }[view];
      const h = r => { if (r.method() === 'GET' && re.test(new URL(r.url()).pathname + new URL(r.url()).search)) n++; }; page.on('request', h);
      await page.evaluate(() => { liveSocketStopped = false; connectLiveStatusSocket(); }); await until(() => n > 0, 4000); page.off('request', h);
      ok(n >= 1, `${view} refreshed after reconnect`);
    }
    await ctx.close();
  });

  // ---------- A4 ----------
  await scenario('A4 Refresh over the invoice editor is clickable and reloads the open invoice (clean); a draft is protected', async () => {
    const inv = await newInvoice(1);
    const { ctx, page } = await newPage(); await signIn(page, 'mgrfull', MPASS);
    await page.evaluate(() => showView('invoices')); await sleep(800);
    await page.evaluate(id => openInvoice(id, true), inv); await page.waitForSelector('#invoiceModal.open'); await sleep(500);
    await page.focus('#invCustomerNote'); // focused, not typed in (the dialog layer also focuses a field on open)
    await R(`/api/invoices/${inv}`, { method: 'PUT', token: owner, body: { customerNote: 'Changed on another device' } });
    // v24.76.0: a clean editor updates by itself (no click needed); the Refresh note is for unsaved drafts.
    ok(await until(() => page.evaluate(() => activeInvoice?.invoice?.customer_note === 'Changed on another device'), 6000), 'clean editor shows the newer invoice');
    await sleep(1500); eq((await R(`/api/invoices/${inv}`, { token: owner })).invoice.customer_note, 'Changed on another device', 'reloading the editor never saves the old values back');
    // Dirty draft: type in the editor, then another device changes the invoice.
    const field = await page.evaluateHandle(() => [...document.querySelectorAll('#invoiceEditor .ilDesc')].find(e => e.offsetParent && !e.readOnly && !e.disabled)); // a line field (not autosaved while typing)
    await field.fill('MY UNSAVED DRAFT TEXT');
    await R(`/api/invoices/${inv}`, { method: 'PUT', token: owner, body: { customerNote: 'Second remote change' } });
    await page.waitForSelector('#ittrStaleNote button', { timeout: 6000 });
    await page.click('#ittrStaleNote button:first-of-type', { timeout: 3000 });
    await page.waitForSelector('[data-stale-choice="keep"]', { timeout: 3000 });
    await page.click('[data-stale-choice="keep"]');
    eq(await field.inputValue(), 'MY UNSAVED DRAFT TEXT', 'keeping my changes leaves the draft');
    await ctx.close();
  });

  // ---------- A5 ----------
  await scenario('A5 Imported history audit answers for empty and populated history; Repair History Links runs', async () => {
    let r = await R('/api/fullbay/history/import-audit', { token: owner, allowError: true }); eq(r.status, 200, `empty history: ${r.error || ''}`); eq(r.imported, 0, 'none imported');
    await db.query(`INSERT INTO fullbay_service_history(source_key,service_order,unit_number,customer_name,actual_correction,part_amount) VALUES('fullbay:a1','SO-1','U1','X','Replaced filter',12),('fullbay:a2','SO-2','U2','X','',0)`);
    r = await R('/api/fullbay/history/import-audit', { token: owner, allowError: true }); eq(r.status, 200, `populated: ${r.error || ''}`); eq(r.imported, 2, 'two imported'); eq(r.incomplete, 1, 'one incomplete');
    const { ctx, page } = await newPage(); await signIn(page, OWNER.username, OWNER.password);
    await page.evaluate(() => showView('procenter')); await sleep(1200);
    let called = false; page.on('request', q => { if (q.url().includes('/api/fullbay/history/reconcile')) called = true; });
    await page.evaluate(() => { const b = [...document.querySelectorAll('#procenter button')].find(x => /Repair History Links/.test(x.textContent)); b.click(); });
    await until(() => called, 3000);
    ok(!page.errs.some(e => /reconcileFullbayHistory/.test(e)), `no "not defined" error (${page.errs.join(' | ')})`); ok(called, 'reconcile request sent');
    await ctx.close();
  });

  // ---------- A6 ----------
  await scenario('A6 a slow Parts page finishing after Customers opened does not change the address or title', async () => {
    const { ctx, page } = await newPage(); await signIn(page, 'mgrfull', MPASS);
    // Parts already mounted from an earlier visit that was superseded (as on a shop tablet): showView goes straight to
    // the slow afterShow().
    await page.evaluate(() => showView('dashboard')); await sleep(400); await page.evaluate(() => mountRouteModule('parts')); await sleep(800);
    let release; const held = new Promise(r => { release = r; });
    await page.route(/\/api\/parts(\?|\/summary)/, async route => { await held; await route.continue().catch(() => {}); });
    await page.evaluate(() => { window.__p = showView('parts'); }); await sleep(400);
    await page.evaluate(() => showView('customers')); await sleep(400);
    release(); await page.evaluate(() => window.__p).catch(() => {}); await sleep(600);
    eq(await page.evaluate(() => currentView), 'customers', 'Customers is the page'); eq(await page.evaluate(() => location.hash), '#customers', 'address stays #customers');
    ok(/^Customers/.test(await page.title()), `title stays Customers (${await page.title()})`);
    ok(await page.evaluate(() => !document.getElementById('customers').classList.contains('hidden')), 'Customers visible');
    await page.unroute(/\/api\/parts(\?|\/summary)/); await ctx.close();
  });

  // ---------- A7 ----------
  await scenario('A7 an older search response never replaces newer results (global and customer search); clearing cancels', async () => {
    const { ctx, page } = await newPage(); await signIn(page, 'mgrfull', MPASS);
    const gate = new Map(); await page.route(/\/api\/smart-search\?/, async route => { const q = new URL(route.request().url()).searchParams.get('q'); if (q === 'older') await new Promise(r => gate.set('older', r)); await route.continue().catch(() => {}); });
    await page.fill('#globalSmartSearch', 'older'); await until(() => gate.has('older'), 3000);
    await page.fill('#globalSmartSearch', 'newer'); await until(() => page.evaluate(() => /Newer Search Fleet/.test(document.getElementById('globalSmartSearchResults')?.textContent || '')), 4000);
    gate.get('older')(); gate.delete('older'); await sleep(700);
    const txt = await page.evaluate(() => document.getElementById('globalSmartSearchResults')?.textContent || '');
    ok(/Newer Search Fleet/.test(txt) && !/Older Search Fleet/.test(txt), `global search keeps the newer results (${txt.slice(0, 80)})`);
    await page.fill('#globalSmartSearch', 'older'); await until(() => gate.has('older'), 3000);
    await page.fill('#globalSmartSearch', ''); gate.get('older')(); gate.delete('older'); await sleep(700);
    ok(!/Older Search Fleet/.test(await page.evaluate(() => document.getElementById('globalSmartSearchResults')?.textContent || '')), 'cleared search shows no late results');
    await page.evaluate(() => showView('customers')); await sleep(800);
    await page.fill('#customerDirectorySearch', 'older'); await until(() => gate.has('older'), 3000);
    await page.fill('#customerDirectorySearch', 'newer'); await until(() => page.evaluate(() => /Newer Search Fleet/.test(document.getElementById('smartDirectoryResults')?.textContent || '')), 4000);
    gate.get('older')(); gate.delete('older'); await sleep(700);
    const t2 = await page.evaluate(() => document.getElementById('smartDirectoryResults')?.textContent || '');
    ok(/Newer Search Fleet/.test(t2) && !/Older Search Fleet/.test(t2), 'customer search keeps the newer results');
    await ctx.close();
  });

  // ---------- A8 ----------
  await scenario('A8 offline sign-out clears the open invoice from memory and the hidden editor; next account sees nothing', async () => {
    const inv = await newInvoice(1);
    const { ctx, page } = await newPage(); await signIn(page, 'mgrfull', MPASS);
    await page.evaluate(() => showView('invoices')); await sleep(800);
    await page.evaluate(id => openInvoice(id, true), inv); await page.waitForSelector('#invoiceModal.open'); await sleep(400);
    ok(await page.evaluate(() => /Private Audit Fleet/.test(document.getElementById('invoiceEditor')?.textContent || '')), 'invoice open');
    await ctx.setOffline(true);
    await page.evaluate(() => { window.ITTR_NO_LOGOUT_RELOAD = true; return logout(); }).catch(() => {});
    await page.waitForSelector('#loginUser', { state: 'visible' });
    const left = await page.evaluate(() => ({ active: typeof activeInvoice !== 'undefined' && activeInvoice ? 'activeInvoice' : '', dom: [...document.querySelectorAll('body *:not(script)')].filter(e => ![...e.children].some(c => /Private Audit Fleet|private-fleet@audit/.test(c.outerHTML)) && /Private Audit Fleet|private-fleet@audit\.test/.test(e.outerHTML)).map(e => `${e.tagName}#${e.id}.${e.className} in #${e.closest('[id]')?.id}`).slice(0, 4).join(' | '), inputs: [...document.querySelectorAll('input,textarea')].filter(e => /Private Audit Fleet|private-fleet@audit/.test(e.value)).length }));
    eq(left.active, '', 'activeInvoice cleared'); eq(left.dom, '', 'no private text left in the page'); eq(left.inputs, 0, 'no private values left in fields');
    await ctx.setOffline(false); await signIn(page, 'mgrcust', MPASS);
    ok(!(await page.evaluate(() => /Private Audit Fleet LLC/.test(document.getElementById('invoiceEditor')?.textContent || ''))), 'next account sees no invoice');
    await signOut(page); await signIn(page, 'mgrfull', MPASS); await page.evaluate(() => showView('invoices')); await sleep(800);
    await page.evaluate(id => openInvoice(id, true), inv); await page.waitForSelector('#invoiceModal.open');
    ok(await page.evaluate(() => /Private Audit Fleet/.test(document.getElementById('invoiceEditor')?.textContent || '')), 'the same account can open it again');
    eq(page.errs.filter(e => !/Failed to fetch|NetworkError|cancel/i.test(e)).join(' | '), '', 'no page errors');
    await ctx.close();
  });

  // ---------- A9 ----------
  await scenario('A9 New Work Order dialog: named, focused, Tab contained, Escape, unsaved-changes guard, focus restored, nested', async () => {
    const { ctx, page } = await newPage(); await signIn(page, OWNER.username, OWNER.password);
    await page.evaluate(() => showView('workorders')); await sleep(800);
    await page.evaluate(() => { const b = document.createElement('button'); b.id = 'auditOpener'; b.textContent = 'opener'; b.onclick = () => openWorkOrder(); document.body.appendChild(b); b.focus(); b.click(); });
    await page.waitForSelector('#woModal.open'); await sleep(200);
    const sem = await page.evaluate(() => { const m = document.getElementById('woModal'), d = m.getAttribute('role') === 'dialog' ? m : m.querySelector('[role="dialog"]'); const lab = d && (d.getAttribute('aria-label') || document.getElementById(d.getAttribute('aria-labelledby') || '')?.textContent || ''); return { role: !!d, modal: d?.getAttribute('aria-modal'), name: String(lab || '').trim(), focusIn: m.contains(document.activeElement) }; });
    ok(sem.role, 'role=dialog'); eq(sem.modal, 'true', 'aria-modal'); ok(sem.name.length > 2, `accessible name (${sem.name})`); ok(sem.focusIn, 'focus moved into the dialog');
    for (const key of ['Tab', 'Shift+Tab']) for (let i = 0; i < 60; i++) { await page.keyboard.press(key); ok(await page.evaluate(() => document.getElementById('woModal').contains(document.activeElement)), `${key} #${i} stays inside`); }
    await page.keyboard.press('Escape'); await sleep(200);
    ok(!(await page.evaluate(() => document.getElementById('woModal').classList.contains('open'))), 'Escape closes a clean dialog');
    eq(await page.evaluate(() => document.activeElement?.id), 'auditOpener', 'focus returns to the opener');
    await page.evaluate(() => document.getElementById('auditOpener').click()); await page.waitForSelector('#woModal.open');
    await page.evaluate(() => { const i = [...document.querySelectorAll('#woModal input[type="text"], #woModal textarea')].find(e => e.offsetParent); i.focus(); });
    await page.keyboard.type('Unsaved unit note');
    await page.keyboard.press('Escape'); await sleep(200);
    ok(await page.evaluate(() => document.getElementById('woModal').classList.contains('open')), 'Escape with unsaved changes asks first');
    await page.waitForSelector('[data-discard-choice="keep"]'); await page.click('[data-discard-choice="keep"]');
    ok(await page.evaluate(() => document.getElementById('woModal').classList.contains('open')), 'Keep editing leaves it open');
    await page.keyboard.press('Escape'); await page.waitForSelector('[data-discard-choice="discard"]'); await page.click('[data-discard-choice="discard"]'); await sleep(200);
    ok(!(await page.evaluate(() => document.getElementById('woModal').classList.contains('open'))), 'Discard closes');
    // Nested: work-order detail, then the helper picker inside it.
    const st = await R('/api/state', { token: owner }), sf = st.shopflow.payload; sf.workorders = [{ id: 9201, unit: 'NEST-1', customer: 'X', status: 'Open', mechanic: 'mech1', helpers: [], unitType: 'customer', truckHere: true, tasks: [] }];
    await R('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf, expectedVersion: st.shopflow.version } }); await page.evaluate(() => refreshCloudStateSilently()); await sleep(800);
    await page.evaluate(() => { window.__ittrForceDetailModal = true; openDetail(9201); }); await page.waitForSelector('#detailModal.open');
    await page.evaluate(() => openAddHelper(9201)); await page.waitForSelector('#helperModal.open'); await sleep(150);
    ok(await page.evaluate(() => document.getElementById('helperModal').contains(document.activeElement)), 'focus in the nested dialog');
    await page.keyboard.press('Escape'); await sleep(200);
    ok(await page.evaluate(() => !document.getElementById('helperModal').classList.contains('open') && document.getElementById('detailModal').classList.contains('open')), 'Escape closes only the nested dialog');
    ok(await page.evaluate(() => document.getElementById('detailModal').contains(document.activeElement)), 'focus back in the outer dialog');
    await ctx.close();
  });

  // ---------- A10 ----------
  await scenario('A10 portal inspection photos: keyboard thumbnails, viewer Close/Escape/zoom, focus restored', async () => {
    const st = await R('/api/state', { token: owner }), sf = st.shopflow.payload;
    sf.workorders.push({ id: 9301, unit: 'PHOTO-1', customer: 'Private Audit Fleet LLC', status: 'In Progress', mechanic: 'mech1', helpers: [], unitType: 'customer', truckHere: true, tasks: [], inspection: { required: true, type: 'truck', status: 'Completed', results: {} } });
    sf.issues = [{ id: 'ph1', wo: 9301, recommendation: 'Replace brake drum', approval: 'Waiting for Customer' }];
    await R('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf, expectedVersion: st.shopflow.version } });
    const link = await R('/api/customer-links', { method: 'POST', token: owner, body: { kind: 'inspection', refId: '9301' } }), token = link.url.split('/c/')[1];
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const { ctx, page } = await newPage(390);
    await page.route(new RegExp(`/api/public/link/${token}$`), async route => { const r = await route.fetch(); const d = await r.json(); for (const f of d.findings || []) f.photos = [PNG, PNG]; await route.fulfill({ response: r, json: d }); });
    await page.goto(`${srv.base()}/c/${token}`); await page.waitForSelector('.photos');
    const thumb = await page.$('.photos button'); ok(thumb, 'thumbnails are buttons');
    ok(/photo/i.test((await thumb.getAttribute('aria-label')) || ''), 'thumbnail has a name');
    await thumb.focus(); await page.keyboard.press('Enter');
    await page.waitForSelector('[role="dialog"]'); const dlg = await page.$('[role="dialog"]');
    ok(await dlg.$('button[aria-label*="Close" i], button[data-a="close"]'), 'Close button'); ok(await dlg.$('button[aria-label*="Zoom in" i], [data-a="zoomin"], [data-a="in"]'), 'zoom control');
    ok(await page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement)), 'focus inside the viewer');
    for (let i = 0; i < 15; i++) { await page.keyboard.press('Tab'); ok(await page.evaluate(() => !!document.querySelector('[role="dialog"]')?.contains(document.activeElement)), 'Tab stays in the viewer'); }
    await page.keyboard.press('Escape'); await sleep(200);
    ok(!(await page.$('[role="dialog"]')), 'Escape closes'); ok(await page.evaluate(() => document.activeElement?.closest?.('.photos') != null), 'focus back on the thumbnail');
    eq(page.errs.join(' | '), '', 'no page errors');
    await ctx.close();
  });

  await scenario('A16 invoice header autosave never silently overwrites a header changed on another device', async () => {
    const inv = await newInvoice(1);
    const b = await R(`/api/invoices/${inv}`, { token: owner }); ok(b.headerPrint, 'invoice carries a header fingerprint');
    await R(`/api/invoices/${inv}/lines`, { method: 'POST', token: owner, body: { lineType: 'labor', description: 'Extra', quantity: 1, unitPrice: 5, taxable: false, jobName: 'J' } });
    eq((await R(`/api/invoices/${inv}`, { token: owner })).headerPrint, b.headerPrint, 'a line change does not change the header fingerprint');
    await R(`/api/invoices/${inv}`, { method: 'PUT', token: owner, body: { customerNote: 'Remote header' } });
    const stale = await R(`/api/invoices/${inv}`, { method: 'PUT', token: owner, body: { customerNote: 'Mine', expectedHeaderPrint: b.headerPrint }, allowError: true });
    eq(stale.status, 409, 'stale autosave refused'); eq(stale.code, 'INVOICE_HEADER_CHANGED', 'with a code');
    eq((await R(`/api/invoices/${inv}`, { token: owner })).invoice.customer_note, 'Remote header', 'remote change kept');
    // Browser: typing a note while another device changes the header → choice; "keep" saves over on purpose.
    const { ctx, page } = await newPage(); await signIn(page, 'mgrfull', MPASS);
    await page.evaluate(() => showView('invoices')); await sleep(800);
    await page.evaluate(id => openInvoice(id, true), inv); await page.waitForSelector('#invoiceModal.open'); await sleep(400);
    await page.focus('#invCustomerNote'); await page.keyboard.type('Local note');
    await R(`/api/invoices/${inv}`, { method: 'PUT', token: owner, body: { customerNote: 'Second remote' } });
    await page.waitForSelector('[data-header-choice="keep"]', { timeout: 6000 });
    await sleep(1200); eq(await page.$$eval('.ittrChoice', x => x.length), 1, 'one question, not one per autosave attempt');
    await page.click('[data-header-choice="keep"]');
    ok(await until(async () => /Local note/.test((await R(`/api/invoices/${inv}`, { token: owner })).invoice.customer_note || ''), 5000), 'choosing "keep" saves this device\'s note on purpose');
    // The header save that runs before adding or removing a line asks too (before, it reverted the other device's
    // header change even when this person never touched the header). Live updates are off so the editor is stale.
    await sleep(1500); await page.evaluate(() => stopLiveStatusSocket()); await sleep(1200);
    await R(`/api/invoices/${inv}`, { method: 'PUT', token: owner, body: { customerNote: 'Third remote' } });
    const p = page.evaluate(() => persistInvoiceDraftBeforeStructureChange('Preserving your invoice'));
    await page.waitForSelector('[data-header-choice="reload"]', { timeout: 6000 }); await page.click('[data-header-choice="reload"]');
    eq(await p, false, 'the line change stops when the newer version is loaded');
    eq((await R(`/api/invoices/${inv}`, { token: owner })).invoice.customer_note, 'Third remote', 'the other device\'s note is kept');
    ok(await until(() => page.evaluate(() => activeInvoice?.invoice?.customer_note === 'Third remote'), 5000), 'the editor shows the newer version');
    await ctx.close();
  });
  await scenario('A22 the same account on two devices: a change from the other device updates the open invoice', async () => {
    const inv = await newInvoice(1), other = await srv.login('mgrfull', MPASS); // the account's second device
    const { ctx, page } = await newPage(); await signIn(page, 'mgrfull', MPASS);
    await page.evaluate(() => showView('invoices')); await sleep(800);
    await page.evaluate(id => openInvoice(id, true), inv); await page.waitForSelector('#invoiceModal.open'); await sleep(4500); // past this tab's own writes
    await R(`/api/invoices/${inv}`, { method: 'PUT', token: other, body: { customerNote: 'From my phone' } });
    ok(await until(() => page.evaluate(() => activeInvoice?.invoice?.customer_note === 'From my phone'), 6000), 'the open editor shows the change from the other device');
    await ctx.close();
  });
  await scenario('A23 A/R aging: a company not linked to a customer record can still receive a payment', async () => {
    const i = await R('/api/invoices', { method: 'POST', token: owner, body: { customerName: 'Unlinked Haulers Co', unitNumber: 'UL-1' } });
    await R(`/api/invoices/${i.id}/lines`, { method: 'POST', token: owner, body: { lineType: 'labor', description: 'Labor', quantity: 1, unitPrice: 61, taxable: false, jobName: 'J' } });
    await R(`/api/invoices/${i.id}/finalize`, { method: 'POST', token: owner, body: {} });
    const { ctx, page } = await newPage(); await signIn(page, OWNER.username, OWNER.password);
    await page.evaluate(() => { try { sessionStorage.setItem('ittr_reports_tab', 'ar'); } catch (_) {} showView('reports'); });
    const row = page.locator('#repArAging tr.arCust', { hasText: 'Unlinked Haulers Co' });
    await row.waitFor({ timeout: 10000 });
    ok(/not linked to a customer record/.test(await row.textContent()), 'the row says why');
    await row.locator('button[data-ar="pay-unlinked"]').click();
    await page.waitForSelector('#payAmt', { timeout: 5000 });
    eq(await page.inputValue('#payAmt'), '61.00', 'the dialog starts with the balance');
    await page.click('.payMethods [data-pm="Cash"]'); await page.click('[data-pay="ok"]');
    ok(await until(async () => Number((await R(`/api/invoices/${i.id}`, { token: owner })).invoice.balance_due) === 0, 5000), 'the invoice is paid');
    ok(await until(() => page.evaluate(() => ![...document.querySelectorAll('#repArAging tr.arCust')].some(r => /Unlinked Haulers Co/.test(r.textContent))), 5000), 'the company leaves A/R aging');
    eq(page.errs.join(' | '), '', 'no page errors');
    await ctx.close();
  });
  await scenario('A25 a stale invoice editor never writes old line text over a newer line', async () => {
    const inv = await newInvoice(1);
    const lab = await R(`/api/invoices/${inv}/lines`, { method: 'POST', token: owner, body: { lineType: 'labor', description: 'ORIGINAL LABOR', quantity: 1, unitPrice: 50, taxable: false, jobName: 'J' } });
    let lineId = null; const lineOf = async () => (await R(`/api/invoices/${inv}`, { token: owner })).lines.find(l => lineId ? l.id === lineId : l.description === 'ORIGINAL LABOR');
    const L = await lineOf(); ok(L.print, 'lines carry a fingerprint'); lineId = L.id;
    const body = d => ({ lineType: 'labor', description: d, quantity: 1, unitPrice: 50, taxable: false, jobName: 'J' });
    const stale = await R(`/api/invoices/${inv}/lines/${L.id}`, { method: 'PUT', token: owner, body: { ...body('X'), expectedPrint: 'not-the-current-one' }, allowError: true });
    eq(stale.status, 409, 'a stale line save is refused'); eq(stale.code, 'INVOICE_LINE_CHANGED', 'with a code');
    const { ctx, page } = await newPage(); await signIn(page, 'mgrfull', MPASS);
    await page.evaluate(() => showView('invoices')); await sleep(800);
    await page.evaluate(id => openInvoice(id, true), inv); await page.waitForSelector('#invoiceModal.open'); await sleep(500);
    await page.evaluate(() => stopLiveStatusSocket()); await sleep(1200); // this editor now stays stale
    await R(`/api/invoices/${inv}/lines/${L.id}`, { method: 'PUT', token: owner, body: body('REMOTE CORRECTED LABOR') });
    // 1) Saving the header with the line untouched leaves the other device's line alone.
    await page.fill('#invCustomerNote', 'header only'); await page.evaluate(() => saveInvoiceHeader()); await sleep(800);
    eq((await lineOf()).description, 'REMOTE CORRECTED LABOR', 'an untouched line is not written back');
    // 2) Editing that same line asks; "Load the newer version" keeps the other device's text.
    await page.evaluate(() => stopLiveStatusSocket()); await sleep(300);
    await R(`/api/invoices/${inv}/lines/${L.id}`, { method: 'PUT', token: owner, body: body('REMOTE SECOND') });
    const desc = page.locator(`[data-invoice-line="${L.id}"] .ilDesc`); await desc.fill('MY LABOR');
    const p = page.evaluate(() => saveInvoiceHeader());
    await page.waitForSelector('[data-line-choice="reload"]', { timeout: 6000 }); await page.click('[data-line-choice="reload"]'); await p;
    eq((await lineOf()).description, 'REMOTE SECOND', 'the other device\'s line is kept');
    ok(await until(() => page.evaluate(() => activeInvoice.lines.some(l => l.description === 'REMOTE SECOND')), 5000), 'the editor shows the newer line');
    // 3) "Keep my changes" saves this device's text on purpose.
    await page.evaluate(() => stopLiveStatusSocket()); await sleep(300);
    await R(`/api/invoices/${inv}/lines/${L.id}`, { method: 'PUT', token: owner, body: body('REMOTE THIRD') });
    await page.locator(`[data-invoice-line="${L.id}"] .ilDesc`).fill('MINE ON PURPOSE');
    const p2 = page.evaluate(() => saveInvoiceHeader());
    await page.waitForSelector('[data-line-choice="keep"]', { timeout: 6000 }); await page.click('[data-line-choice="keep"]'); await p2;
    eq((await lineOf()).description, 'MINE ON PURPOSE', 'keeping my change saves it');
    // 4) A header conflict answered with "load newer" leaves no line change behind.
    await page.evaluate(() => stopLiveStatusSocket()); await sleep(300);
    await R(`/api/invoices/${inv}`, { method: 'PUT', token: owner, body: { customerNote: 'remote header' } });
    await page.locator(`[data-invoice-line="${L.id}"] .ilDesc`).fill('SHOULD NOT SAVE');
    const p3 = page.evaluate(() => saveInvoiceHeader());
    await page.waitForSelector('[data-header-choice="reload"]', { timeout: 6000 }); await page.click('[data-header-choice="reload"]'); await p3;
    eq((await lineOf()).description, 'MINE ON PURPOSE', 'no line was written when the header question stopped the save');
    eq(page.errs.join(' | '), '', 'no page errors');
    await ctx.close();
  });
  await scenario('A26 a saved note leaves the invoice clean; an unsaved line stays unsaved', async () => {
    const inv = await newInvoice(1);
    const { ctx, page } = await newPage(); await signIn(page, 'mgrfull', MPASS);
    await page.evaluate(() => showView('invoices')); await sleep(800);
    await page.evaluate(id => openInvoice(id, true), inv); await page.waitForSelector('#invoiceModal.open'); await sleep(500);
    await page.focus('#invCustomerNote'); await page.keyboard.type(' saved');
    ok(await until(() => page.evaluate(() => document.getElementById('invoiceDraftState')?.dataset.state === 'saved'), 5000), 'the note autosaved');
    eq(await page.evaluate(() => ittrInvoiceEditorDirty()), false, 'nothing unsaved after the autosave');
    await page.locator('#invoiceEditor .ilDesc').first().fill('typed, not saved');
    await page.focus('#invCustomerNote'); await page.keyboard.type('!');
    ok(await until(() => page.evaluate(() => document.getElementById('invoiceDraftState')?.dataset.state === 'saved'), 5000), 'the note autosaved again');
    eq(await page.evaluate(() => ittrInvoiceEditorDirty()), true, 'the unsaved line still counts as unsaved');
    await ctx.close();
  });
  await scenario('A27 a change from the same account on another device right after this tab saved something still updates the open invoice', async () => {
    const inv = await newInvoice(1), other = await newInvoice(1), phone = await srv.login('mgrfull', MPASS);
    const { ctx, page } = await newPage(); await signIn(page, 'mgrfull', MPASS);
    await page.evaluate(() => showView('invoices')); await sleep(800);
    await page.evaluate(id => openInvoice(id, true), inv); await page.waitForSelector('#invoiceModal.open'); await sleep(4500);
    // This tab saves something (another invoice), and within a second the phone changes the open one.
    await page.evaluate(id => apiJSON(`/api/invoices/${id}`, { method: 'PUT', body: { customerNote: 'tab wrote this' } }), other);
    await R(`/api/invoices/${inv}`, { method: 'PUT', token: phone, body: { customerNote: 'From my phone, right after' } });
    ok(await until(() => page.evaluate(() => activeInvoice?.invoice?.customer_note === 'From my phone, right after'), 6000), 'the open editor shows the phone\'s change');
    // This tab's own autosave still never reloads its own editor.
    let gets = 0; page.on('request', q => { if (q.method() === 'GET' && new RegExp(`/api/invoices/${inv}$`).test(q.url())) gets++; });
    await page.focus('#invCustomerNote'); await page.keyboard.type(' x');
    ok(await until(() => page.evaluate(() => document.getElementById('invoiceDraftState')?.dataset.state === 'saved'), 5000), 'autosaved'); await sleep(1500);
    eq(gets, 0, 'its own autosave does not reload the editor');
    await ctx.close();
  });
  await scenario('A28 a customer\'s online estimate approval refreshes an open Estimates page', async () => {
    const e = await R('/api/estimates', { method: 'POST', token: owner, body: { customerName: 'Private Audit Fleet LLC' } });
    await R(`/api/estimates/${e.id}/lines`, { method: 'POST', token: owner, body: { lineType: 'labor', description: 'Brake job', quantity: 1, unitPrice: 100, jobName: 'Brakes' } });
    await R(`/api/estimates/${e.id}`, { method: 'PUT', token: owner, body: { status: 'sent' } });
    const link = await R('/api/customer-links', { method: 'POST', token: owner, body: { kind: 'estimate', refId: String(e.id) } });
    const token = link.token || String(link.url || '').split('/c/')[1];
    const { ctx, page } = await newPage(); await signIn(page, 'mgrfull', MPASS);
    await page.evaluate(() => showView('estimates')); await page.waitForSelector(`#estimates [data-open="${e.id}"]`, { timeout: 8000 });
    const pub = await R(`/api/public/link/${token}`);
    const jobs = Object.fromEntries((pub.jobs || pub.estimate?.jobs || []).map(j => [j.key, 'approve']));
    const d = await R(`/api/public/link/${token}/decide`, { method: 'POST', body: { name: 'Test Customer', agree: true, jobs } });
    eq(d.status, 'approved', 'the customer approved');
    ok(await until(() => page.evaluate(id => /approved/i.test(document.querySelector(`#estimates [data-open="${id}"]`)?.textContent || ''), e.id), 6000), 'the open list shows approved without a reload');
    await ctx.close();
  });
  await scenario('A29 an online (Stripe) payment refreshes an open invoice', async () => {
    const inv = await newInvoice(1); await R(`/api/invoices/${inv}/finalize`, { method: 'POST', token: owner, body: {} });
    const { ctx, page } = await newPage(); await signIn(page, 'mgrfull', MPASS);
    await page.evaluate(() => showView('invoices')); await sleep(800);
    await page.evaluate(id => openInvoice(id, true), inv); await page.waitForSelector('#invoiceModal.open'); await sleep(800);
    const crypto = await import('node:crypto'), t = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_a29', payment_intent: 'pi_a29', payment_status: 'paid', amount_total: 300, created: t, metadata: { invoice_id: String(inv) } } } });
    const hook = () => fetch(srv.base() + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${crypto.createHmac('sha256', 'whsec_test_ittr').update(`${t}.${body}`).digest('hex')}` }, body }).then(r => r.json());
    eq((await hook()).recorded, true, 'payment recorded (test signature, no real provider)');
    ok(await until(() => page.evaluate(() => (activeInvoice?.payments || []).some(p => p.reference === 'pi_a29')), 6000), 'the open invoice shows the online payment');
    eq((await hook()).recorded, false, 'a replayed event records nothing');
    await ctx.close();
  });
  await scenario('A30 sign-in fields are announced by name; clicking a label focuses its field', async () => {
    for (const w of [390, 900, 1440]) {
      const { ctx, page } = await newPage(w); await page.goto(srv.base() + '/'); await page.waitForSelector('#loginPass');
      const names = await page.evaluate(() => [...document.querySelectorAll('#loginUser,#loginPass,#loginCode')].map(e => [e.id, (e.labels?.[0]?.textContent || e.getAttribute('aria-label') || '').trim()]));
      eq(names.filter(([, n]) => !n).map(([id]) => id).join(','), '', `every sign-in field has a label at ${w}px`);
      await page.click('label[for="loginPass"]'); eq(await page.evaluate(() => document.activeElement?.id), 'loginPass', 'the Password label focuses the password field');
      await page.click('.loginPassShow'); eq(await page.evaluate(() => document.getElementById('loginPass').labels?.[0]?.textContent.trim()), 'Password', 'still named when shown');
      await ctx.close();
    }
  });
  await scenario('A31 Estimates and Purchase Orders: keyboard opening, focus kept in the form, Escape asks before discarding', async () => {
    const e = await R('/api/estimates', { method: 'POST', token: owner, body: { customerName: 'Private Audit Fleet LLC' } });
    const { ctx, page } = await newPage(1280); await signIn(page, OWNER.username, OWNER.password);
    await page.evaluate(() => showView('estimates')); await page.waitForSelector(`#estimates [data-open="${e.id}"] .estOpenBtn`, { timeout: 8000 });
    await page.focus(`#estimates [data-open="${e.id}"] .estOpenBtn`); await page.keyboard.press('Enter');
    await page.waitForSelector('#estEditor:not(.hidden) #estEditorBox[role="dialog"]', { timeout: 6000 });
    ok(await page.evaluate(() => !!document.getElementById('estEditorBox').getAttribute('aria-labelledby')), 'the estimate editor is a named dialog');
    for (const [label, open, box] of [['estimate', null, '#estEditorBox'], ['purchase order', async () => { await page.evaluate(() => { const b = [...document.querySelectorAll('#estEditorBox [data-est="close"]')][0]; b?.click(); }); await page.evaluate(() => showView('purchaseorders')); await page.waitForSelector('#purchaseorders button'); await page.evaluate(() => [...document.querySelectorAll('#purchaseorders button')].find(b => /New purchase order|\+ New/i.test(b.textContent))?.click()); await page.waitForSelector('.poModal .box', { timeout: 6000 }); }, '.poModal .box']]) {
      if (open) await open();
      const field = await page.evaluateHandle(sel => [...document.querySelector(sel).querySelectorAll('input[type="text"],input:not([type]),textarea')].find(x => x.offsetParent && !x.disabled && !x.readOnly), box);
      await field.fill(`unsaved ${label} draft`);
      // Tab from the last control stays inside.
      await page.evaluate(sel => { const f = [...document.querySelector(sel).querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]')].filter(x => x.offsetParent); f.at(-1).focus(); }, box);
      await page.keyboard.press('Tab');
      ok(await page.evaluate(sel => document.querySelector(sel).contains(document.activeElement), box), `${label}: Tab stays inside the form`);
      await page.keyboard.press('Shift+Tab'); ok(await page.evaluate(sel => document.querySelector(sel).contains(document.activeElement), box), `${label}: Shift+Tab stays inside`);
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-discard-choice="keep"]', { timeout: 3000 });
      await page.click('[data-discard-choice="keep"]');
      ok(await page.evaluate(sel => !!document.querySelector(sel)?.offsetParent, box), `${label}: "Keep editing" keeps the form open`);
      eq(await field.inputValue(), `unsaved ${label} draft`, `${label}: the draft is still there`);
    }
    eq(page.errs.join(' | '), '', 'no page errors');
    await ctx.close();
  });
  await scenario('A17 work-order Billing tab links to its estimate and invoice', async () => {
    const st = await R('/api/state', { token: owner }), sf = st.shopflow.payload;
    sf.workorders = [...sf.workorders.filter(w => w.id !== 9501), { id: 9501, unit: 'BILL-1', customer: 'Private Audit Fleet LLC', status: 'Completed', mechanic: 'mech1', helpers: [], unitType: 'customer', truckHere: true, tasks: [] }];
    await R('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf, expectedVersion: st.shopflow.version } });
    const inv = await newInvoice(1); await db.query("UPDATE customer_invoices SET work_order_id='9501' WHERE id=$1", [inv]);
    const e = await R('/api/estimates', { method: 'POST', token: owner, body: { customerName: 'Private Audit Fleet LLC' } }); await db.query("UPDATE customer_estimates SET work_order_id='9501' WHERE id=$1", [e.id]);
    eq((await R('/api/work-orders/9501/billing-links', { token: await srv.login('mgrcust', MPASS), allowError: true })).status, 403, 'needs the Invoices permission');
    const { ctx, page } = await newPage(); await signIn(page, OWNER.username, OWNER.password);
    await page.evaluate(() => { location.hash = '#wo/9501/billing'; }); await page.waitForSelector('[data-ws-open-invoice]', { timeout: 8000 });
    ok(await page.$('[data-ws-open-estimate]'), 'estimate listed');
    await page.click('[data-ws-open-invoice]'); await page.waitForSelector('#invoiceModal.open', { timeout: 8000 });
    eq(await page.evaluate(() => activeInvoice?.invoice?.id), inv, 'the linked invoice opens');
    await page.evaluate(() => closeInvoiceWorkspace()); await sleep(300); await page.evaluate(() => { location.hash = '#wo/9501/billing'; }); await page.waitForSelector('[data-ws-open-estimate]', { timeout: 8000 });
    const estReq = page.waitForRequest(r => new URL(r.url()).pathname === `/api/estimates/${e.id}`, { timeout: 8000 });
    await page.click('[data-ws-open-estimate]'); await estReq;
    eq(await page.evaluate(() => currentView), 'estimates', 'the linked estimate opens on Estimates');
    await ctx.close();
  });
  await scenario('A18 Operations tools: search filters, favorites stay per account', async () => {
    const { ctx, page } = await newPage(820); await signIn(page, OWNER.username, OWNER.password);
    await page.evaluate(() => showView('procenter')); await page.waitForSelector('#opsToolSearch');
    await page.fill('#opsToolSearch', 'audit log'); await sleep(150);
    // Visible on screen (checkVisibility), not just the attribute: a display rule can override [hidden].
    const shown = await page.$$eval('.opsGroup:not(.opsFavs) .opsTool', x => x.filter(t => t.checkVisibility()).map(t => t.textContent.trim().slice(0, 20)));
    ok(shown.length >= 1 && shown.every(t => /audit/i.test(t)), `only matching tools are visible (${shown})`);
    await page.fill('#opsToolSearch', ''); await page.click('.opsTool[data-tool="daily-report"] .opsStar');
    ok(/Daily report/.test(await page.textContent('#opsFavList')), 'starred tool in Favorites');
    await page.evaluate(() => { const o = window.showProPanel; window.__panelCalls = 0; window.showProPanel = (...a) => { window.__panelCalls++; return o(...a); }; });
    await page.click('#opsFavList button'); await sleep(300);
    eq(await page.evaluate(() => window.__panelCalls), 1, 'a favorite runs its tool once');
    await page.reload(); await page.waitForFunction(() => typeof cloudReady !== 'undefined' && cloudReady && session, null, { timeout: 15000 });
    await page.evaluate(() => showView('procenter')); await page.waitForSelector('#opsFavList'); await sleep(300);
    ok(/Daily report/.test(await page.textContent('#opsFavList')), 'favorite kept after reload');
    await signOut(page); await signIn(page, 'mgrfull', MPASS); await page.evaluate(() => showView('procenter')); await page.waitForSelector('#opsFavList'); await sleep(300);
    ok(!/Daily report/.test(await page.textContent('#opsFavList')), 'another account has its own favorites');
    eq(await page.evaluate(() => document.documentElement.scrollWidth), 820, 'tablet width fits');
    await ctx.close();
  });
  await scenario('A19 mechanic job details: no empty timer row, add-part form folded until needed', async () => {
    const st = await R('/api/state', { token: owner }), sf = st.shopflow.payload;
    sf.workorders = [...sf.workorders.filter(w => w.id !== 9601), { id: 9601, unit: 'JOB-1', customer: 'X', status: 'In Progress', mechanic: 'mech1', helpers: [], unitType: 'customer', truckHere: true, tasks: [{ uid: 'j1', t: 'Brake inspection', done: false, startedAt: '', stoppedAt: '', elapsedMs: 0, parts: [] }, { uid: 'j2', t: 'Done without timer', done: true, outcome: 'completed', startedAt: '', stoppedAt: '', elapsedMs: 0, parts: [] }] }];
    await R('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf, expectedVersion: st.shopflow.version } });
    const { ctx, page } = await newPage(390); await signIn(page, 'mech1', KPASS);
    await page.evaluate(() => openDetail(9601)); await page.waitForSelector('#detailModal.open');
    const d = await page.evaluate(() => { const b = document.getElementById('detailBody'); return { notStarted: /Not started/.test(b.querySelectorAll('.taskrow')[0]?.textContent || ''), doneSaysNotStarted: /Not started/.test(b.querySelectorAll('.taskrow')[1]?.textContent || ''), emptyTimer: /Latest Start|Started:/.test(b.querySelector('.taskrow')?.textContent || ''), folded: !!b.querySelector('details.partAddDetails:not([open])'), partInputVisible: !!b.querySelector('#partNo_9601_0')?.checkVisibility() }; });
    ok(d.notStarted && !d.emptyTimer, 'unstarted job shows "Not started" instead of empty times'); ok(!d.doneSaysNotStarted, 'a finished job never says "Not started"'); ok(d.folded && !d.partInputVisible, `add-part form folded (${JSON.stringify(d)})`);
    await page.click('details.partAddDetails > summary'); ok(await page.evaluate(() => !!document.querySelector('#detailBody #partNo_9601_0')?.checkVisibility()), '+ Add part opens the form');
    await ctx.close();
  });
  for (const [who, pass, w, h, label] of [['owner', OWNER.password, 640, 450, '200% zoom (1280×900 at 200%)'], ['mech1', KPASS, 640, 450, '200% zoom'], ['owner', OWNER.password, 844, 390, 'phone landscape'], ['mech1', KPASS, 844, 390, 'phone landscape']])
    await scenario(`A20 ${who} ${label}: every allowed page fits`, async () => {
      const { ctx, page } = await newPage(w); await page.setViewportSize({ width: w, height: h }); await signIn(page, who, pass);
      const allowed = await page.evaluate(() => APP_VIEWS.filter(v => allowedViewForRole(v) && v !== 'wo')), bad = [];
      for (const v of allowed) { await page.evaluate(x => showView(x), v); await sleep(600); const sw = await page.evaluate(() => document.documentElement.scrollWidth); if (sw > w + 1) bad.push(`${v}:${sw}`); }
      eq(bad.join(','), '', 'no sideways scrolling'); await ctx.close();
    });
  await scenario('A21 every visible control on every page has an accessible name (owner, manager, mechanic)', async () => {
    const inventory = {}, unnamed = [];
    for (const [who, pass] of [['owner', OWNER.password], ['mgrcust', MPASS], ['mech1', KPASS]]) {
      const { ctx, page } = await newPage(1280); await signIn(page, who, pass);
      const allowed = await page.evaluate(() => APP_VIEWS.filter(v => allowedViewForRole(v) && v !== 'wo'));
      for (const v of allowed) {
        await page.evaluate(x => showView(x), v); await sleep(900);
        const r = await page.evaluate(view => { const host = document.getElementById(view); if (!host) return { n: 0, bad: [] };
          const els = [...host.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,[role=button],[tabindex]:not([tabindex="-1"])')].filter(e => e.offsetParent);
          const name = e => (e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') && document.getElementById(e.getAttribute('aria-labelledby'))?.textContent || e.title || (e.labels && [...e.labels].map(l => l.textContent).join(' ')) || e.closest('label')?.textContent || (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.tagName) ? e.placeholder : e.textContent) || '').trim();
          return { n: els.length, bad: els.filter(e => !name(e)).map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className ? '.' + String(e.className).split(' ')[0] : ''}`).slice(0, 5) }; }, v);
        inventory[`${who}:${v}`] = r.n; for (const b of r.bad) unnamed.push(`${who}:${v}:${b}`);
      }
      await ctx.close();
    }
    console.log('  control inventory (visible controls per page):', JSON.stringify(inventory));
    eq(unnamed.join(' | '), '', 'controls without a name');
  });
  // ---------- investigated items ----------
  await scenario('A11 stopping the barcode camera before the scanner runs does not throw', async () => {
    const { ctx, page } = await newPage(); await signIn(page, OWNER.username, OWNER.password);
    const r = await page.evaluate(() => { partsHtml5Scanner = { stop() { throw new Error('Cannot stop, scanner is not running or paused.'); }, clear() {} }; try { stopPartsCamera(); return 'ok'; } catch (e) { return e.message; } });
    eq(r, 'ok', 'no exception'); await sleep(300); eq(page.errs.filter(e => /Cannot stop/.test(e)).join(), '', 'no unhandled error');
    await ctx.close();
  });
  await scenario('A12 purchase-order rows open from the keyboard', async () => {
    await R('/api/purchase-orders', { method: 'POST', token: owner, body: { vendor: 'Keyboard PO Vendor', lines: [{ partNumber: 'SYNC-PART-1', description: 'x', qty: 1, unitCost: 1, inventoryPartId: part.id }] } });
    const { ctx, page } = await newPage(); await signIn(page, 'mgrfull', MPASS);
    await page.evaluate(() => showView('purchaseorders')); await page.waitForSelector('.poOpenBtn');
    let opened = false; page.on('request', q => { if (/\/api\/purchase-orders\/\d+$/.test(new URL(q.url()).pathname)) opened = true; });
    await page.focus('.poOpenBtn'); await page.keyboard.press('Enter');
    ok(await until(() => opened, 4000), 'Enter on the PO number opens that purchase order');
    await ctx.close();
  });
  await scenario('A13 populated Reports overview fits a 390 px phone', async () => {
    const inv = await newInvoice(1); await R(`/api/invoices/${inv}/finalize`, { method: 'POST', token: owner });
    await R(`/api/invoices/${inv}/payments`, { method: 'POST', token: owner, body: { amount: 5, method: 'Cash' } }).catch(() => {});
    const { ctx, page } = await newPage(390); await signIn(page, OWNER.username, OWNER.password);
    await page.evaluate(() => showView('reports')); await sleep(2500);
    const wide = await page.evaluate(() => { const W = document.documentElement.clientWidth; return { sw: document.documentElement.scrollWidth, el: [...document.querySelectorAll('#reports *')].filter(e => e.offsetParent && e.getBoundingClientRect().right > W + 1 && !e.closest('[style*="overflow"],.reportTableWrap,table')).slice(0, 3).map(e => `${e.tagName}.${e.className}#${e.id} ${Math.round(e.getBoundingClientRect().right)}`).join(' | ') }; });
    eq(wide.sw, 390, `page width (${wide.el})`);
    await ctx.close();
  });

  // ---------- role matrix ----------
  const tokens = { owner, mgrfull: await srv.login('mgrfull', MPASS), mgrcust: await srv.login('mgrcust', MPASS), mgrmix: await srv.login('mgrmix', MPASS), mech1: await srv.login('mech1', KPASS), mech2: await srv.login('mech2', KPASS) };
  // Expected status by role for direct API calls (2xx = allowed). The visible menu is checked separately (A1/A15).
  const MATRIX = [
    ['/api/invoices', { owner: 1, mgrfull: 1, mgrcust: 0, mgrmix: 1, mech1: 0 }],
    ['/api/estimates', { owner: 1, mgrfull: 1, mgrcust: 0, mgrmix: 1, mech1: 0 }],
    ['/api/bills', { owner: 1, mgrfull: 1, mgrcust: 0, mgrmix: 1, mech1: 0 }],
    ['/api/payments/search?q=ab', { owner: 1, mgrfull: 1, mgrcust: 0, mgrmix: 1, mech1: 0 }],
    ['/api/purchase-orders', { owner: 1, mgrfull: 1, mgrcust: 0, mgrmix: 1, mech1: 0 }],
    ['/api/parts?q=SYNC', { owner: 1, mgrfull: 1, mgrcust: 1, mgrmix: 1, mech1: 1 }],
    ['/api/customers', { owner: 1, mgrfull: 1, mgrcust: 1, mgrmix: 0, mech1: 0 }],
    ['/api/reports/finance', { owner: 1, mgrfull: 1, mgrcust: 0, mgrmix: 0, mech1: 0 }],
    ['/api/admin/managers', { owner: 1, mgrfull: 0, mgrcust: 0, mgrmix: 0, mech1: 0 }],
    ['/api/fullbay/history/import-audit', { owner: 1, mgrfull: 0, mgrcust: 0, mgrmix: 0, mech1: 0 }],
    ['/api/customer-links?kind=portal', { owner: 1, mgrfull: 1, mgrcust: 0, mgrmix: 0, mech1: 0 }], // portal needs Customers AND Invoices (same as creating one)
    ['/api/customer-links?kind=estimate', { owner: 1, mgrfull: 1, mgrcust: 0, mgrmix: 1, mech1: 0 }],
    ['/api/work-orders/removed', { owner: 1, mgrfull: 1, mgrcust: 1, mgrmix: 1, mech1: 0 }],
  ];
  await scenario('A14 API permission matrix: owner, full / restricted / mixed managers, mechanic', async () => {
    await R('/api/admin/managers/mgrmix', { method: 'PUT', token: owner, body: { permissions: { invoices: true, inventory: true } } }); // A1 changed it
    const pl = await R('/api/customer-links', { method: 'POST', token: owner, body: { kind: 'portal', refId: String(cust.id) } });
    eq((await R(`/api/customer-links/${pl.id}`, { method: 'DELETE', token: tokens.mgrmix, allowError: true })).status, 403, 'a manager without Customers cannot turn off a portal');
    const wrong = [];
    for (const [path, exp] of MATRIX) for (const [who, allow] of Object.entries(exp)) {
      const st = (await R(path, { token: tokens[who], allowError: true })).status, got = st >= 200 && st < 300 ? 1 : 0;
      if (got !== allow) wrong.push(`${who} ${path} → ${st}`);
    }
    eq(wrong.join(' ; '), '', 'every role gets exactly what it is allowed');
    // Mechanics read every work order but cannot act on another mechanic's.
    const st = await R('/api/state', { token: owner }), sf = st.shopflow.payload;
    sf.workorders = [...sf.workorders.filter(w => w.id !== 9401), { id: 9401, unit: 'M2-ONLY', customer: 'X', status: 'In Progress', mechanic: 'mech2', helpers: [], unitType: 'customer', truckHere: true, tasks: [{ uid: 'm2t', t: 'Job', done: false, parts: [] }] }];
    await R('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf, expectedVersion: st.shopflow.version } });
    ok((await R('/api/state', { token: tokens.mech1 })).shopflow.payload.workorders.some(w => w.id === 9401), 'mech1 sees mech2 work');
    eq((await R('/api/work-orders/9401/tasks/by-uid/m2t/action', { method: 'POST', token: tokens.mech1, body: { action: 'start' }, allowError: true })).status, 403, 'mech1 cannot start a timer on it');
  });
  await scenario('A24 server checks the area permission on Compliance, texting, productivity and service orders', async () => {
    const doc = (await db.query(`INSERT INTO inspection_documents(template,fields,unit_number,created_by) VALUES('annual','{}'::jsonb,'DOC-1','owner') RETURNING id`)).rows[0].id;
    // mgrmix has Invoices + Inventory but not Customers; mgrcust has only Customers.
    const cases = [
      ['GET', '/api/annual-inspections/units', 'mgrmix', 403], ['GET', `/api/inspection-docs/${doc}`, 'mgrmix', 403], ['DELETE', `/api/inspection-docs/${doc}`, 'mgrmix', 403],
      ['PUT', '/api/fleet-maintenance/customers/1/reminders', 'mgrmix', 403], ['GET', '/api/fleet-maintenance/summary', 'mgrmix', 403], ['GET', '/api/inspection-docs', 'mgrmix', 403],
      ['GET', '/api/sms/threads', 'mgrmix', 403], ['GET', '/api/sms/config', 'mgrmix', 403],
      ['GET', '/api/admin/productivity', 'mgrcust', 403], ['GET', '/api/service-orders/1', 'mgrcust', 403],
      ['GET', '/api/inspection-docs', 'mgrcust', 200], ['GET', '/api/fleet-maintenance/summary', 'mgrcust', 200], ['GET', `/api/inspection-docs/${doc}`, 'mgrcust', 200],
      ['GET', '/api/inspection-docs', 'mech1', 403],
    ], bad = [];
    for (const [method, path, who, want] of cases) {
      const st = (await R(path, { method, token: tokens[who], body: method === 'PUT' ? { enabled: false } : undefined, allowError: true })).status ?? 200;
      if ((want === 200) !== (st >= 200 && st < 300) || (want === 403 && st !== 403)) bad.push(`${who} ${method} ${path}: ${st}`);
    }
    eq(bad.join(' | '), '', 'every call answers as its permission says');
    eq((await db.query('SELECT count(*)::int n FROM inspection_documents WHERE id=$1', [doc])).rows[0].n, 1, 'the refused delete removed nothing');
  });
  for (const [who, pass] of [['owner', OWNER.password], ['mgrfull', MPASS], ['mgrcust', MPASS], ['mech1', KPASS], ['mech2', KPASS]]) for (const w of [390, 820, 1280])
    await scenario(`A15 ${who} at ${w}px: every allowed page opens without errors or sideways scrolling`, async () => {
      const { ctx, page } = await newPage(w); await signIn(page, who, pass);
      const allowed = await page.evaluate(() => APP_VIEWS.filter(v => allowedViewForRole(v) && !['wo'].includes(v)));
      ok(allowed.length > 0, 'has pages');
      const bad = [];
      for (const v of allowed) { await page.evaluate(x => showView(x), v); await sleep(700); const sw = await page.evaluate(() => document.documentElement.scrollWidth); if (sw > w + 1) bad.push(`${v}:${sw}`); }
      eq(bad.join(','), '', 'no page wider than the screen');
      eq(page.errs.filter(e => !/Failed to fetch|aborted|cancel/i.test(e)).join(' | '), '', 'no page errors');
      await ctx.close();
    });

  // ---------- verification areas (recorded in docs/AUDIT-v24.76.0.md) ----------
  await scenario('V2 payment → invoice balance → customer portal "You owe" agree', async () => {
    const c = (await R('/api/customers', { method: 'POST', token: owner, body: { customer_name: 'Balance Check Fleet' } })).item;
    const i = await R('/api/invoices', { method: 'POST', token: owner, body: { customerId: c.id, customerName: c.customer_name } });
    await R(`/api/invoices/${i.id}/lines`, { method: 'POST', token: owner, body: { lineType: 'labor', description: 'Labor', quantity: 2, unitPrice: 50.005, taxable: false, jobName: 'Job' } });
    await R(`/api/invoices/${i.id}/finalize`, { method: 'POST', token: owner });
    await R(`/api/invoices/${i.id}/payments`, { method: 'POST', token: owner, body: { amount: 40, method: 'Cash' } });
    const inv = (await R(`/api/invoices/${i.id}`, { token: owner })).invoice;
    const portal = await R('/api/customer-links', { method: 'POST', token: owner, body: { kind: 'portal', refId: String(c.id) } });
    const v = await R(`/api/public/link/${portal.url.split('/c/')[1]}`);
    eq(Number(v.owed), Number(inv.balance_due), 'portal owed equals invoice balance'); ok(Number(inv.balance_due) > 0 && Number(inv.balance_due) < 100.02, `balance ${inv.balance_due}`);
    const over = await R(`/api/invoices/${i.id}/payments`, { method: 'POST', token: owner, body: { amount: 1000, method: 'Cash' }, allowError: true });
    ok(over.status >= 400 || Number((await R(`/api/invoices/${i.id}`, { token: owner })).invoice.balance_due) >= 0, `overpayment is refused or never makes a negative balance (${over.status})`);
  });
  await scenario('V5 portal isolation: another customer\'s invoice PDF and a revoked portal are refused', async () => {
    const a = (await R('/api/customers', { method: 'POST', token: owner, body: { customer_name: 'Isolation A Co' } })).item, b = (await R('/api/customers', { method: 'POST', token: owner, body: { customer_name: 'Isolation B Co' } })).item;
    const ib = await R('/api/invoices', { method: 'POST', token: owner, body: { customerId: b.id, customerName: b.customer_name } });
    await R(`/api/invoices/${ib.id}/lines`, { method: 'POST', token: owner, body: { lineType: 'labor', description: 'B work', quantity: 1, unitPrice: 10, taxable: false, jobName: 'J' } }); await R(`/api/invoices/${ib.id}/finalize`, { method: 'POST', token: owner });
    const pa = await R('/api/customer-links', { method: 'POST', token: owner, body: { kind: 'portal', refId: String(a.id) } }), ta = pa.url.split('/c/')[1];
    eq((await fetch(`${srv.base()}/api/public/link/${ta}/invoice/${ib.id}/pdf`)).status, 404, 'A cannot open B\'s invoice PDF');
    ok(!JSON.stringify(await R(`/api/public/link/${ta}`)).includes('Isolation B Co'), 'A\'s portal shows nothing of B');
    await R(`/api/customer-links/${pa.id}`, { method: 'DELETE', token: owner });
    ok((await R(`/api/public/link/${ta}`, { allowError: true })).status >= 400, 'revoked portal refused');
    eq((await R('/api/public/link/not-a-real-token-000000000000000000000000', { allowError: true })).status >= 400, true, 'unknown token refused');
  });
  await scenario('V7 concurrent finalize posts stock once; two invoices taking the last unit stay in the ledger', async () => {
    await db.query('UPDATE fullbay_import_parts SET quantity=1,allocated=0 WHERE id=$1', [part.id]);
    const i1 = await newInvoice(1);
    const rs = await Promise.all([1, 2, 3].map(() => R(`/api/invoices/${i1}/finalize`, { method: 'POST', token: owner, allowError: true })));
    eq(await qty(), 0, `three simultaneous finalizes take one unit once (${rs.map(r => r.status)})`);
    const i2 = await newInvoice(1), i3 = await newInvoice(1);
    const rr = await Promise.all([i2, i3].map(id => R(`/api/invoices/${id}/finalize`, { method: 'POST', token: owner, allowError: true })));
    const q = await qty(), tx = Number((await db.query(`SELECT coalesce(sum(quantity_delta),0)::numeric s FROM part_inventory_transactions WHERE part_id=$1`, [part.id]).catch(() => ({ rows: [{ s: null }] }))).rows[0].s);
    console.log(`  note: finalize statuses ${rr.map(r => r.status)}; stock now ${q} (negative-stock policy: ${q < 0 ? 'allowed with warning' : 'not below zero'}); ledger sum ${tx}`);
    ok(q >= -2 && q <= 0, 'stock moved by at most the two sales');
  });
  await scenario('V4 security headers, login enumeration, login rate limit, no secrets in the browser bundle', async () => {
    const r = await fetch(srv.base() + '/'), h = Object.fromEntries(r.headers);
    ok(/default-src/.test(h['content-security-policy'] || ''), 'CSP'); eq(h['x-content-type-options'], 'nosniff', 'nosniff');
    ok(/frame-ancestors|DENY|SAMEORIGIN/i.test((h['content-security-policy'] || '') + (h['x-frame-options'] || '')), 'framing restricted');
    const a = await R('/api/auth/login', { method: 'POST', body: { username: 'no-such-user-x', password: 'Wrong-Pass-123' }, allowError: true });
    const b = await R('/api/auth/login', { method: 'POST', body: { username: 'mech2', password: 'Wrong-Pass-123' }, allowError: true });
    eq(a.status, b.status, 'same status for unknown user and wrong password'); eq(a.error, b.error, 'same message');
    let locked = false; for (let k = 0; k < 14 && !locked; k++) { const x = await R('/api/auth/login', { method: 'POST', body: { username: 'mech2', password: `Wrong-${k}-pass` }, allowError: true }); if (x.status === 429 || /locked|too many/i.test(x.error || '')) locked = true; }
    ok(locked, 'repeated wrong passwords are slowed or locked');
    const { readFileSync, readdirSync } = await import('node:fs');
    const files = readdirSync('public').filter(f => /\.(js|html)$/.test(f)).map(f => 'public/' + f).concat(readdirSync('public/modules').map(f => 'public/modules/' + f));
    const hits = files.filter(f => /sk_(live|test)_[A-Za-z0-9]{8,}|re_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA )?PRIVATE KEY|whsec_[A-Za-z0-9]{8,}/.test(readFileSync(f, 'utf8')));
    eq(hits.join(','), '', 'no API keys or private keys in files served to browsers');
  });
} catch (e) { failures.push(`setup: ${e.message.split('\n')[0]}`); console.error(e); }
finally { await browser.close().catch(() => {}); await srv.cleanup(); }

if (failures.length) { reportSuite(NAME, 'FAILED', failures.join('; ')); console.error(`FAIL ${NAME}: ${failures.length} scenario(s)`); process.exit(1); }
reportSuite(NAME, 'PASSED'); console.log(`PASS ${NAME}`);
