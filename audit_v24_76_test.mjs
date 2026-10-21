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
import { twilioSignature } from './customer_sms.mjs';
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
// A stand-in for FMCSA's QCMobile service (local, no real FMCSA call): USDOT 1111111 answers too slowly the first time,
// USDOT 2222222 always answers too slowly.
const fmcsaHits = {};
const fmcsaMock = (await import('node:http')).createServer((req, res) => {
  const dot = (req.url.match(/carriers\/(\d+)/) || [])[1] || ''; fmcsaHits[dot] = (fmcsaHits[dot] || 0) + 1;
  const slow = dot === '2222222' || (dot === '1111111' && fmcsaHits[dot] === 1);
  setTimeout(() => { if (res.writableEnded || res.destroyed) return; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ content: { carrier: { dotNumber: Number(dot), legalName: `CARRIER ${dot} LLC`, phyCity: 'Dallas', phyState: 'TX', allowedToOperate: 'Y' } } })); }, slow ? 2000 : 20);
});
await new Promise(r => fmcsaMock.listen(0, '127.0.0.1', r));
const srv = await startTestServer({ prefix: 'ittr_a76', admin: OWNER, env: { STRIPE_WEBHOOK_SECRET: 'whsec_test_ittr', FMCSA_WEBKEY: 'test-key', FMCSA_API_BASE_URL: `http://127.0.0.1:${fmcsaMock.address().port}/qc/services`, FMCSA_TIMEOUT_MS: '700', TWILIO_ACCOUNT_SID: 'ACaudit', TWILIO_AUTH_TOKEN: 'twilio-audit-secret', TWILIO_FROM: '+13125550100', TWILIO_API_BASE: `http://127.0.0.1:${fmcsaMock.address().port}`, ITTR_BACKUP_BATCH: '50' } });
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
    // A payment dialog over an open invoice: Tab stays in it; Escape closes only the payment dialog.
    const inv = await newInvoice(1); await R(`/api/invoices/${inv}/finalize`, { method: 'POST', token: owner, body: {} });
    await page.click('.poModal [data-po="close"]'); await page.click('[data-discard-choice="discard"]'); // Cancel on the edited form asks first
    ok(await until(() => page.evaluate(() => !document.querySelector('.poModal')), 3000), 'purchase order: "Discard changes" closes the form');
    await page.evaluate(() => showView('invoices')); await sleep(600);
    await page.evaluate(id => openInvoice(id, true), inv); await page.waitForSelector('#invoiceModal.open'); await sleep(400);
    await page.evaluate(id => { recordInvoicePayment(id, 1); }, inv); await page.waitForSelector('.payDlg #payAmt');
    for (let k = 0; k < 14; k++) await page.keyboard.press('Tab');
    ok(await page.evaluate(() => !!document.activeElement?.closest('.payDlg')), 'payment dialog: Tab stays inside');
    await page.keyboard.press('Escape'); await sleep(300);
    ok(await page.evaluate(() => !document.querySelector('.payDlg')), 'Escape closes the payment dialog');
    ok(await page.evaluate(() => document.getElementById('invoiceModal').classList.contains('open')), 'the invoice behind it stays open');
    eq(page.errs.join(' | '), '', 'no page errors');
    await ctx.close();
  });
  await scenario('A32 server: refused or malformed requests keep their 4xx status; backup is one snapshot; build names its commit', async () => {
    const bad = await R('/api/invoices', { method: 'POST', token: owner, raw: '{not json', allowError: true });
    eq(bad.status, 400, 'malformed JSON answers 400, not 500'); ok(/valid JSON/.test(bad.error || ''), `with a clear message (${bad.error})`);
    const b = await fetch(srv.base() + '/api/admin/backup', { headers: { Authorization: `Bearer ${owner}` } }); const j = await b.json();
    eq(b.status, 200, 'backup downloads'); eq(j.consistentSnapshot, true, 'all tables from one snapshot'); ok(j.tables && j.rowCounts, 'tables and counts present');
    ok('commit' in (await R('/api/build')), 'build reports the deployed commit field');
  });
  await scenario('A44 backup: complete file with matching counts; a slow download is paced; a failure mid-export breaks the download instead of leaving a finished-looking file', async () => {
    await srv.db.query('CREATE TABLE zzy_backup_rows AS SELECT g AS id FROM generate_series(1, 137) g'); // more than two 50-row batches
    const b = await fetch(srv.base() + '/api/admin/backup', { headers: { Authorization: `Bearer ${owner}` } }); const j = await b.json();
    eq(j.complete, true, 'the file says it is complete');
    for (const [t, n] of Object.entries(j.rowCounts)) eq(j.tables[t]?.length, n, `${t}: rows in the file match the count`);
    ok(j.tables.auth_users.every(u => u.password_hash === '[removed]'), 'password hashes stay out');
    eq(j.tables.zzy_backup_rows.map(r => r.id).join(), Array.from({ length: 137 }, (_, k) => k + 1).join(), 'a table larger than one batch is exported whole, in order');
    await srv.db.query('DROP TABLE zzy_backup_rows');
    // A large table, then a small one last. The reader stops reading; while the server waits for it, the last table is
    // dropped, so the export fails part-way. Without pacing the server would already have finished the whole file.
    await srv.db.query("CREATE TABLE zzz_backup_big AS SELECT g AS id, repeat('x', 900) AS pad FROM generate_series(1, 30000) g");
    await srv.db.query('CREATE TABLE zzzz_backup_tail(id int)');
    const http = await import('node:http');
    const res = await new Promise((ok2, bad) => { const rq = http.get(srv.base() + '/api/admin/backup', { headers: { Authorization: `Bearer ${owner}` } }, ok2); rq.on('error', bad); });
    res.pause(); await sleep(1500);
    await srv.db.query('DROP TABLE zzzz_backup_tail');
    let body = '', ended = false, broke = false;
    await new Promise(done => { res.on('data', c => { body += c; }); res.on('end', () => { ended = true; done(); }); res.on('aborted', () => { broke = true; }); res.on('error', () => { broke = true; done(); }); res.on('close', done); res.resume(); });
    ok(!body.includes('"complete":true'), 'the cut-off file does not claim to be complete');
    ok(broke || !ended || res.complete === false, 'the download ends as failed, not as a finished file');
    await srv.db.query('DROP TABLE zzz_backup_big');
    // The server is fine afterwards and the database connection was given back.
    const again = await (await fetch(srv.base() + '/api/admin/backup', { headers: { Authorization: `Bearer ${owner}` } })).json();
    eq(again.complete, true, 'the next backup works');
  });
  await scenario('A33 signed-in account checks from the shop network never block someone else\'s sign-in', async () => {
    let limited = 0;
    for (let k = 0; k < 110; k++) if ((await R('/api/auth/me', { token: owner, allowError: true })).status === 429) limited++;
    eq(limited, 0, '110 signed-in checks in a row are not refused');
    ok(await srv.login('mech1', KPASS), 'a mechanic can still sign in from the same address');
  });
  await scenario('A34 two devices: the mechanic starts and completes a job on the phone; the office sees it live and invoices it', async () => {
    const st = await R('/api/state', { token: owner }), sf = st.shopflow.payload;
    sf.workorders = [...sf.workorders.filter(w => w.id !== 9701), { id: 9701, unit: 'CHAIN-1', customer: 'Private Audit Fleet LLC', customerId: cust.id, status: 'In Progress', mechanic: 'mech1', helpers: [], unitType: 'customer', truckHere: true, tasks: [{ uid: 'c1', t: 'Replace air filter', done: false, parts: [] }] }];
    await R('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf, expectedVersion: st.shopflow.version } });
    const office = await newPage(1280), phone = await newPage(390);
    await signIn(office.page, OWNER.username, OWNER.password); await office.page.evaluate(() => showView('board')); await sleep(800);
    await signIn(phone.page, 'mech1', KPASS);
    const task = page => page.evaluate(() => state.workorders.find(w => w.id === 9701)?.tasks?.[0] || null);
    await phone.page.evaluate(() => apiJSON('/api/work-orders/9701/tasks/by-uid/c1/action', { method: 'POST', body: { action: 'start' } }));
    ok(await until(async () => !!(await task(office.page))?.startedAt, 8000), 'the office sees the job start without a reload');
    await sleep(1100);
    await phone.page.evaluate(() => apiJSON('/api/work-orders/9701/tasks/by-uid/c1/action', { method: 'POST', body: { action: 'complete' } }));
    ok(await until(async () => { const t = await task(office.page); return t && (t.done || t.stoppedAt); }, 8000), 'the office sees the job completed without a reload');
    // The mechanic completes the work order on the phone (the app's own save).
    await phone.page.evaluate(() => setStatus(9701, 'Completed'));
    ok(await until(async () => (await R('/api/state', { token: owner })).shopflow.payload.workorders.find(w => w.id === 9701)?.status === 'Completed', 8000), 'the phone\'s completion reaches the server');
    ok(await until(() => office.page.evaluate(() => state.workorders.find(w => w.id === 9701)?.status === 'Completed'), 8000), 'the office sees the work order completed');
    const inv = await office.page.evaluate(() => apiJSON('/api/invoices/from-work-order/9701', { method: 'POST', body: {} }));
    const id = inv.id || inv.invoiceId || inv.invoice?.id; ok(id, `an invoice was made from the work order (${JSON.stringify(inv).slice(0, 120)})`);
    const b = await R(`/api/invoices/${id}`, { token: owner });
    ok(b.lines.some(l => /air filter/i.test(`${l.description} ${l.job_name}`)), 'the invoice carries the completed job');
    eq((await R('/api/work-orders/9701/billing-links', { token: owner })).invoices.some(i => Number(i.id) === Number(id)), true, 'the work order Billing tab links to it');
    eq([...office.page.errs, ...phone.page.errs].join(' | '), '', 'no page errors on either device');
    await office.ctx.close(); await phone.ctx.close();
  });
  await scenario('A35 two devices: a finding from the phone is approved in the office and appears on the phone as a job', async () => {
    const st = await R('/api/state', { token: owner }), sf = st.shopflow.payload;
    sf.workorders = [...sf.workorders.filter(w => w.id !== 9801), { id: 9801, unit: 'FIND-1', customer: 'Private Audit Fleet LLC', status: 'In Progress', mechanic: 'mech1', helpers: [], unitType: 'customer', truckHere: true, tasks: [{ uid: 'g1', t: 'Inspection', done: false, parts: [] }] }];
    await R('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf, expectedVersion: st.shopflow.version } });
    const office = await newPage(1280), phone = await newPage(390);
    await signIn(office.page, OWNER.username, OWNER.password); await office.page.evaluate(() => showView('approvals')); await sleep(800);
    await signIn(phone.page, 'mech1', KPASS);
    // The mechanic reports a finding the way the app saves it.
    await phone.page.evaluate(() => { state.issues = state.issues || []; state.issues.push({ id: 98011, wo: 9801, severity: 'Needs Attention', description: 'Cracked mud flap bracket', approval: 'Waiting for Customer', taskUid: 'g1', taskSnapshot: 'Inspection' }); save(); });
    ok(await until(() => office.page.evaluate(() => (state.issues || []).some(i => String(i.id) === '98011')), 8000), 'the office sees the new finding without a reload');
    const d = await office.page.evaluate(() => apiJSON('/api/findings/98011/decision', { method: 'POST', body: { value: 'Proceed' } }));
    ok(d && d.ok !== false, 'the office approves it');
    ok(await until(() => phone.page.evaluate(() => (state.workorders.find(w => w.id === 9801)?.tasks || []).some(t => String(t.findingId ?? '') === '98011')), 8000), 'the phone shows the approved job without a reload');
    const uid = await phone.page.evaluate(() => state.workorders.find(w => w.id === 9801).tasks.find(t => String(t.findingId ?? '') === '98011').uid);
    await phone.page.evaluate(u => apiJSON(`/api/work-orders/9801/tasks/by-uid/${encodeURIComponent(u)}/action`, { method: 'POST', body: { action: 'start' } }), uid);
    ok(await until(() => office.page.evaluate(u => !!state.workorders.find(w => w.id === 9801)?.tasks.find(t => t.uid === u)?.startedAt, uid), 8000), 'the office sees the mechanic start it');
    eq([...office.page.errs, ...phone.page.errs].join(' | '), '', 'no page errors on either device');
    await office.ctx.close(); await phone.ctx.close();
  });
  await scenario('A36 a device that loses the network catches up when it comes back', async () => {
    const { ctx, page } = await newPage(1280); await signIn(page, 'mgrfull', MPASS);
    await page.evaluate(() => showView('parts')); await sleep(1200);
    const before = await qty();
    await ctx.setOffline(true); await sleep(1500);
    ok(await page.evaluate(() => !navigator.onLine), 'the page knows it is offline');
    await R(`/api/parts/${part.id}/transaction`, { method: 'POST', token: owner, body: { type: 'adjust_add', qty: 7, note: 'while offline' } });
    const target = await qty(); eq(target, before + 7, 'stock changed while the device was offline');
    await ctx.setOffline(false);
    ok(await until(() => page.evaluate(t => document.getElementById('parts')?.textContent.includes(String(t)), target), 12000), `the Parts page shows ${target} after coming back online`);
    eq(page.errs.join(' | '), '', 'no page errors');
    await ctx.close();
  });
  await scenario('A37 phone (touch, mobile viewport): a mechanic taps Start and Complete on a job', async () => {
    const st = await R('/api/state', { token: owner }), sf = st.shopflow.payload;
    sf.workorders = [...sf.workorders.filter(w => w.id !== 9901), { id: 9901, unit: 'TAP-1', customer: 'Private Audit Fleet LLC', status: 'In Progress', mechanic: 'mech2', helpers: [], unitType: 'customer', truckHere: true, tasks: [{ uid: 't1', t: 'Grease chassis', done: false, parts: [] }] }];
    await R('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf, expectedVersion: st.shopflow.version } });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, serviceWorkers: 'block' });
    const page = await ctx.newPage(); page.setDefaultTimeout(8000); page.errs = []; page.on('pageerror', e => page.errs.push(e.message)); page.on('dialog', d => d.accept().catch(() => {}));
    await signIn(page, 'mech2', KPASS); // mech2 has no job running (one job at a time per mechanic)
    await page.evaluate(() => openDetail(9901)); await page.waitForSelector('#detailModal.open');
    await page.locator('#detailBody button', { hasText: 'Start Task' }).first().tap();
    ok(await until(async () => !!(await R('/api/state', { token: owner })).shopflow.payload.workorders.find(w => w.id === 9901)?.tasks[0]?.startedAt, 8000), 'the tap started the job on the server');
    await sleep(1200);
    const done = page.locator('#detailBody button', { hasText: 'Complete Task' }).first(); await done.waitFor({ timeout: 8000 }); await done.tap();
    // Completing may ask for the outcome; answer "completed" when it does.
    await sleep(600); const outcome = page.locator('button', { hasText: /^(Completed|Job completed|Yes, completed)/i }).first(); if (await outcome.count()) await outcome.tap().catch(() => {});
    ok(await until(async () => { const t = (await R('/api/state', { token: owner })).shopflow.payload.workorders.find(w => w.id === 9901)?.tasks[0]; return t && (t.stoppedAt || t.done); }, 8000), 'the tap completed the job on the server');
    eq(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'no sideways scrolling on the phone');
    eq(page.errs.join(' | '), '', 'no page errors');
    await ctx.close();
  });
  await scenario('A38 FMCSA lookup: a slow first answer is retried; a service that never answers gives a clear message', async () => {
    const t0 = Date.now(), r1 = await R('/api/fmcsa/carriers/1111111', { token: owner, allowError: true });
    eq(r1.status, 200, `the retry found the carrier (${r1.error || ''})`); eq(r1.item?.legalName, 'CARRIER 1111111 LLC', 'with its name'); eq(fmcsaHits['1111111'], 2, 'one retry after the slow answer');
    const r2 = await R('/api/fmcsa/carriers/2222222', { token: owner, allowError: true });
    eq(r2.status, 504, 'a service that never answers is a timeout'); ok(/did not answer/.test(r2.error || ''), `with a clear message (${r2.error})`); eq(fmcsaHits['2222222'], 2, 'tried twice, then stopped');
    ok(Date.now() - t0 < 6000, 'the whole lookup stays bounded');
    // In the browser the card says it may take a while, then shows the match.
    const { ctx, page } = await newPage(1280); await signIn(page, 'mgrfull', MPASS);
    await page.evaluate(() => showView('customers')); await sleep(600);
    await page.evaluate(() => openCustomerEditor()); await page.waitForSelector('#ceDot', { state: 'visible' });
    await page.fill('#ceDot', '1111111'); delete fmcsaHits['1111111'];
    await page.evaluate(() => { fmcsaLookupDot = ''; lookupCustomerFmcsa(true); });
    ok(await until(() => page.evaluate(() => /CARRIER 1111111 LLC/.test(document.getElementById('fmcsaLookupCard')?.textContent || '')), 6000), 'the lookup card shows the carrier');
    eq(page.errs.join(' | '), '', 'no page errors');
    await ctx.close();
  });
  await scenario('A39 emailing a customer link follows the link permissions; a repeated text never undoes a later STOP', async () => {
    await R('/api/admin/managers', { method: 'POST', token: owner, body: { username: 'mgrnone', display: 'mgrnone', password: MPASS, permissions: {} } }).catch(() => {});
    await R('/api/admin/managers/mgrmix', { method: 'PUT', token: owner, body: { permissions: { invoices: true, inventory: true } } }); // A1 takes Invoices away
    const e = await R('/api/estimates', { method: 'POST', token: owner, body: { customerName: 'Private Audit Fleet LLC' } });
    const est = await R('/api/customer-links', { method: 'POST', token: owner, body: { kind: 'estimate', refId: String(e.id) } });
    const por = await R('/api/customer-links', { method: 'POST', token: owner, body: { kind: 'portal', refId: String(cust.id) } });
    const tok = { owner, mgrfull: await srv.login('mgrfull', MPASS), mgrcust: await srv.login('mgrcust', MPASS), mgrmix: await srv.login('mgrmix', MPASS), mgrnone: await srv.login('mgrnone', MPASS), mech1: await srv.login('mech1', KPASS) };
    // estimate needs Invoices; portal needs Customers and Invoices (mgrmix has Invoices + Inventory, mgrcust only Customers).
    const allowed = { estimate: ['owner', 'mgrfull', 'mgrmix'], portal: ['owner', 'mgrfull'] }, bad = [];
    for (const [kind, link, refId] of [['estimate', est, String(e.id)], ['portal', por, String(cust.id)]]) for (const who of Object.keys(tok)) {
      const before = (await db.query('SELECT meta FROM customer_links WHERE id=$1', [link.id])).rows[0].meta;
      const r = await R('/api/customer-links/email', { method: 'POST', token: tok[who], body: { kind, refId, url: link.url, to: 'fleet@audit.test' }, allowError: true });
      const ok403 = r.status === 403, should = allowed[kind].includes(who);
      if (should === ok403) bad.push(`${who} ${kind}: ${r.status}`);
      if (!should && JSON.stringify((await db.query('SELECT meta FROM customer_links WHERE id=$1', [link.id])).rows[0].meta) !== JSON.stringify(before)) bad.push(`${who} ${kind}: refused send changed the link`);
    }
    eq(bad.join(' | '), '', 'every role/kind answers as its permissions say, and refused sends change nothing');
    // Signed inbound texts (test secret, local only): START(A) -> STOP(B) -> START(A) again must stay opted out.
    const url = srv.base() + '/api/sms/inbound', phone = '+13125559999';
    const text = (sid, Body) => { const params = { From: phone, Body, MessageSid: sid }; return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSignature('twilio-audit-secret', url, params) }, body: new URLSearchParams(params) }).then(r => r.status); };
    const out = async () => (await db.query('SELECT 1 FROM sms_optouts WHERE phone=$1', [phone])).rowCount === 1;
    eq(await text('SMa1', 'START'), 200, 'signed text accepted'); eq(await out(), false, 'opted in');
    await text('SMb2', 'STOP'); eq(await out(), true, 'STOP opts out');
    await text('SMa1', 'START'); eq(await out(), true, 'a repeated old START does not undo the later STOP');
    eq((await db.query("SELECT count(*)::int n FROM sms_messages WHERE twilio_sid IN ('SMa1','SMb2')")).rows[0].n, 2, 'the repeat is stored once');
    await text('SMc3', 'START'); eq(await out(), false, 'a new START opts back in');
    await text('SMb2', 'STOP'); eq(await out(), false, 'a repeated old STOP does not undo the later START');
    eq(await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'bad' }, body: new URLSearchParams({ From: phone, Body: 'STOP', MessageSid: 'SMx' }) }).then(r => r.status), 403, 'an unsigned text is refused');
  });
  await scenario('A40 a text arriving in the open conversation keeps the reply being typed', async () => {
    const url = srv.base() + '/api/sms/inbound', phone = '+13125558888';
    const text = (sid, Body) => { const params = { From: phone, Body, MessageSid: sid }; return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSignature('twilio-audit-secret', url, params) }, body: new URLSearchParams(params) }); };
    await text('SMd1', 'Is the truck ready?');
    const { ctx, page } = await newPage(1280); await signIn(page, OWNER.username, OWNER.password);
    await page.evaluate(p => window.ITTR_SMS.compose({ phone: p }), phone); await page.waitForSelector('#smsBody');
    await page.click('#smsBody'); await page.keyboard.type('Unsent repair estimate explanation');
    await page.evaluate(() => { const t = document.getElementById('smsBody'); t.setSelectionRange(6, 6); });
    await text('SMd2', 'Also check the brakes please');
    await page.evaluate(p => window.dispatchEvent(new CustomEvent('ittr:sms', { detail: { phone: p, preview: 'Also check the brakes please' } })), phone);
    ok(await until(() => page.evaluate(() => /Also check the brakes/.test(document.getElementById('smsBubbles')?.textContent || '')), 6000), 'the new text appears');
    eq(await page.inputValue('#smsBody'), 'Unsent repair estimate explanation', 'the unsent reply is kept');
    eq(await page.evaluate(() => JSON.stringify([document.activeElement?.id, document.activeElement?.selectionStart])), JSON.stringify(['smsBody', 6]), 'focus and cursor stay where they were');
    eq(page.errs.join(' | '), '', 'no page errors');
    await ctx.close();
  });
  await scenario('A41 invoice: an edit made during a slow save is saved too; a slow older invoice never replaces the newer one', async () => {
    const inv = await newInvoice(1), other = await newInvoice(1);
    const { ctx, page } = await newPage(1280); await signIn(page, 'mgrfull', MPASS);
    await page.evaluate(() => showView('invoices')); await sleep(800);
    await page.evaluate(id => openInvoice(id, true), inv); await page.waitForSelector('#invoiceModal.open'); await sleep(500);
    await page.evaluate(() => stopLiveStatusSocket()); await sleep(300);
    // Hold the first header save; type a newer note while it is on its way.
    let release, held = new Promise(r => { release = r; }), puts = [];
    await page.route(new RegExp(`/api/invoices/${inv}$`), async route => { if (route.request().method() !== 'PUT') return route.continue(); puts.push(JSON.parse(route.request().postData() || '{}').customerNote); if (puts.length === 1) await held; await route.continue().catch(() => {}); });
    await page.fill('#invCustomerNote', 'First note'); await page.dispatchEvent('#invCustomerNote', 'input');
    ok(await until(() => puts.length === 1, 4000), 'the first save left');
    await page.fill('#invCustomerNote', 'Second note must persist'); await page.dispatchEvent('#invCustomerNote', 'input'); await sleep(1100);
    const mid = await page.evaluate(() => [document.getElementById('invoiceDraftState')?.dataset.state, document.getElementById('invoiceDraftState')?.textContent]);
    ok(mid[0] !== 'saved', `not "saved" while the newer note waits (${mid})`); ok(/Saving latest changes/.test(mid[1] || ''), `says it is saving the latest changes (${mid[1]})`);
    release();
    ok(await until(async () => (await R(`/api/invoices/${inv}`, { token: owner })).invoice.customer_note === 'Second note must persist', 6000), 'the newer note reaches the server without another action');
    ok(await until(() => page.evaluate(() => document.getElementById('invoiceDraftState')?.dataset.state === 'saved'), 4000), '"All changes saved" only after that');
    eq(puts.length, 2, 'exactly one follow-up save');
    await page.unroute(new RegExp(`/api/invoices/${inv}$`));
    // A slow load of invoice A must not replace invoice B opened after it.
    let releaseA, heldA = new Promise(r => { releaseA = r; });
    await page.route(new RegExp(`/api/invoices/${other}$`), async route => { if (route.request().method() === 'GET') await heldA; await route.continue().catch(() => {}); });
    const pa = page.evaluate(id => openInvoice(id, true), other);
    await sleep(200); await page.evaluate(id => openInvoice(id, true), inv); await sleep(400);
    releaseA(); await pa.catch(() => {}); await sleep(500);
    eq(await page.evaluate(() => activeInvoice?.invoice?.id), inv, 'the newer selection stays');
    // Closing while a load is on its way keeps the editor closed.
    heldA = new Promise(r => { releaseA = r; });
    const pc = page.evaluate(id => openInvoice(id, true), other); await sleep(200);
    await page.evaluate(() => closeModal('invoiceModal')); await sleep(200); releaseA(); await pc.catch(() => {}); await sleep(500);
    eq(await page.evaluate(() => document.getElementById('invoiceModal').classList.contains('open')), false, 'a load that finishes after closing does not reopen the editor');
    eq(page.errs.join(' | '), '', 'no page errors');
    await page.unroute(new RegExp(`/api/invoices/${other}$`)); await ctx.close();
  });
  await scenario('A42 estimates: typing in the next field while a save is on its way keeps focus, cursor and every character', async () => {
    const e = await R('/api/estimates', { method: 'POST', token: owner, body: { customerName: 'Private Audit Fleet LLC' } });
    await R(`/api/estimates/${e.id}/lines`, { method: 'POST', token: owner, body: { lineType: 'labor', description: 'Audit labor', quantity: 1, unitPrice: 100 } });
    const { ctx, page } = await newPage(1280); await signIn(page, 'mgrfull', MPASS);
    await page.evaluate(() => showView('estimates')); await page.waitForSelector(`#estimates [data-open="${e.id}"] .estOpenBtn`, { timeout: 8000 });
    await page.click(`#estimates [data-open="${e.id}"] .estOpenBtn`); await page.waitForSelector('#estEditor:not(.hidden) [data-h="poNumber"]');
    // Hold the header save; meanwhile the person moves on (Tab) and types in Unit #.
    let release, held = new Promise(r => { release = r; });
    const rx = new RegExp(`/api/estimates/${e.id}$`);
    await page.route(rx, async route => { if (route.request().method() === 'PUT') await held; await route.continue().catch(() => {}); });
    await page.click('[data-h="poNumber"]'); await page.keyboard.type('PO-4411'); await page.keyboard.press('Tab');
    await page.keyboard.type('U-77');
    release(); await sleep(150);
    await page.keyboard.type('8'); // keeps typing straight through the redraw
    await until(async () => (await R(`/api/estimates/${e.id}`, { token: owner })).estimate.po_number === 'PO-4411', 5000); await sleep(700);
    const st = await page.evaluate(() => { const a = document.activeElement; return { h: a?.dataset?.h || a?.tagName, v: a?.value, s: a?.selectionStart }; });
    eq(st.h, 'unitNumber', 'focus stays in Unit # after the save redraws the editor');
    eq(st.v, 'U-778', 'every character typed in Unit # is kept');
    eq(st.s, 5, 'the cursor stays at the end of what was typed');
    eq(await page.inputValue('[data-h="poNumber"]'), 'PO-4411', 'the saved field shows the saved value');
    await page.keyboard.press('Tab');
    ok(await until(async () => (await R(`/api/estimates/${e.id}`, { token: owner })).estimate.unit_number === 'U-778', 5000), 'leaving Unit # saves it');
    await page.unroute(rx);
    // The same on a line: save the description, keep typing the hours.
    const lrx = new RegExp(`/api/estimates/${e.id}/lines/\\d+$`);
    held = new Promise(r => { release = r; });
    await page.route(lrx, async route => { if (route.request().method() === 'PUT') await held; await route.continue().catch(() => {}); });
    await page.click('.estRow[data-line] [data-f="description"]'); await page.keyboard.press('End'); await page.keyboard.type(' plus'); await page.keyboard.press('Tab');
    await page.keyboard.press('Tab'); // part # column is empty for labor; next is hours
    const target = await page.evaluate(() => document.activeElement?.dataset?.f);
    await page.keyboard.press('Control+A'); await page.keyboard.type('2.5');
    release(); await sleep(900);
    const ls = await page.evaluate(() => { const a = document.activeElement; return { f: a?.dataset?.f, v: a?.value }; });
    eq(ls.f, target, 'focus stays in the line field being typed in');
    eq(ls.v, '2.5', 'the line value being typed is kept');
    ok(/plus/.test(await page.inputValue('.estRow[data-line] [data-f="description"]')), 'the saved description shows');
    // An older answer for an estimate that was closed never reopens it.
    held = new Promise(r => { release = r; });
    await page.unroute(lrx); await page.route(rx, async route => { if (route.request().method() === 'GET') await held; await route.continue().catch(() => {}); });
    const pr = page.evaluate(id => window.ittrOpenEstimate(id), e.id); await sleep(200);
    await page.evaluate(() => document.querySelector('#estEditorBox [data-est="close"]')?.click()); await sleep(200);
    const dc = await page.$('[data-discard-choice="discard"]'); if (dc) await dc.click();
    release(); await pr.catch(() => {}); await sleep(500);
    ok(await page.evaluate(() => document.getElementById('estEditor').classList.contains('hidden')), 'a load that finishes after closing does not reopen the estimate');
    eq(page.errs.join(' | '), '', 'no page errors');
    await page.unroute(rx); await ctx.close();
  });
  await scenario('A43 invoice editor: every field and button can be reached by the pointer at 1280/1440 px and 125–200% zoom, with long names', async () => {
    const long = 'Extremely Long Interstate Refrigerated Freight Logistics Holdings Incorporated';
    const i = await R('/api/invoices', { method: 'POST', token: owner, body: { customerId: cust.id, customerName: cust.customer_name, unitNumber: 'AUD-LONG-UNIT-0000001', customerNote: 'n' } });
    await R(`/api/invoices/${i.id}/lines`, { method: 'POST', token: owner, body: { lineType: 'labor', description: `${long} brake chamber replacement both axles`, quantity: 1.5, unitPrice: 150, jobName: long } });
    await R(`/api/invoices/${i.id}/lines`, { method: 'POST', token: owner, body: { lineType: 'part', description: `${long} air brake chamber 30/30 long stroke`, partNumber: 'PART-NUMBER-THAT-IS-VERY-LONG-123456', quantity: 2, unitPrice: 89.5, unitCost: 40, jobName: long } });
    // 1280 px at 125/150/200% zoom lays out like 1024/853/640 CSS px.
    for (const w of [1440, 1280, 1024, 853, 640]) {
      const { ctx, page } = await newPage(w); await signIn(page, OWNER.username, OWNER.password);
      await page.evaluate(() => showView('invoices')); await sleep(600);
      await page.evaluate(id => openInvoice(id, true), i.id); await page.waitForSelector('#invoiceModal.open #invMileage'); await sleep(600);
      const bad = await page.evaluate(() => {
        const root = document.getElementById('invoiceModal'), out = [];
        root.querySelectorAll('details').forEach(d => { d.open = true; }); // folded sections (Additional fees) too
        for (const el of root.querySelectorAll('input:not([type=hidden]),select,textarea,button')) {
          if (!el.offsetParent || el.closest('.invoicePrintOnly') || !el.checkVisibility({ checkVisibilityCSS: true })) continue;
          const r0 = el.getBoundingClientRect(); if (r0.width < 4 || r0.height < 4) continue;
          el.scrollIntoView({ block: 'center', inline: 'nearest' }); const r = el.getBoundingClientRect(), y = r.top + r.height / 2;
          for (const x of [r.left + 3, r.left + r.width / 2, r.right - 3]) {
            const hit = document.elementFromPoint(x, y);
            if (!(hit && (hit === el || el.contains(hit) || [...(el.labels || [])].some(l => l.contains(hit))))) { out.push(`${el.id || el.dataset.f || el.getAttribute('aria-label') || el.textContent.trim().slice(0, 24) || el.tagName}@${Math.round(x)},${Math.round(y)}→${hit ? (hit.id || String(hit.className).slice(0, 30) || hit.tagName) + ':' + (hit.textContent || '').trim().slice(0, 20) : 'nothing'}`); break; }
          }
        }
        return out;
      });
      eq(bad.join(' | '), '', `${w}px: no control covered`);
      eq(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${w}px: no sideways page scroll`);
      eq(page.errs.join(' | '), '', `${w}px: no page errors`);
      await ctx.close();
    }
  });
  await scenario('A45 Escape closes the parts tool dialogs; on a phone the bottom menu never covers a control scrolled into view', async () => {
    const { ctx, page } = await newPage(1280); await signIn(page, OWNER.username, OWNER.password);
    for (const [label, open] of [['Fluids in gallons', 'openFluidsTool()'], ['Fullbay price check', 'openFullbayPriceCheck()']]) {
      await page.evaluate(code => { (0, eval)(code); }, open); await page.waitForSelector('.payDlg', { timeout: 6000 }); await sleep(300);
      await page.keyboard.press('Escape');
      ok(await until(() => page.evaluate(() => !document.querySelector('.payDlg')), 3000), `${label}: Escape closes it`);
      ok(await page.locator('#topNav button, nav button').first().isVisible().catch(() => true), `${label}: the page behind is usable again`);
    }
    // The estimate's "Create work order" box (it has no Escape of its own): Escape closes it and leaves the estimate open.
    const e = await R('/api/estimates', { method: 'POST', token: owner, body: { customerName: 'Private Audit Fleet LLC' } });
    await R(`/api/estimates/${e.id}/lines`, { method: 'POST', token: owner, body: { lineType: 'labor', description: 'Escape check', quantity: 1, unitPrice: 50 } });
    await page.evaluate(() => showView('estimates')); await page.evaluate(id => window.ittrOpenEstimate(id), e.id); await page.waitForSelector('#estEditor:not(.hidden) [data-est="to-wo"]');
    await page.click('[data-est="to-wo"]'); await page.waitForSelector('#estWoDlg', { timeout: 6000 }); await sleep(300);
    await page.keyboard.press('Escape');
    ok(await until(() => page.evaluate(() => !document.getElementById('estWoDlg')), 3000), 'Create work order: Escape closes it');
    ok(await page.evaluate(() => !document.getElementById('estEditor').classList.contains('hidden')), 'the estimate behind it stays open');
    eq(page.errs.join(' | '), '', 'no page errors'); await ctx.close();
    // Phone: the mechanic's help line sits at the end of the page, right above the fixed bottom menu.
    const pc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, serviceWorkers: 'block' });
    const ph = await pc.newPage(); ph.setDefaultTimeout(8000); ph.errs = []; ph.on('pageerror', e => ph.errs.push(e.message));
    await signIn(ph, 'mech2', KPASS); await ph.evaluate(() => showView('mechanic')); await sleep(800);
    await ph.evaluate(() => window.scrollTo(0, 0));
    await ph.locator('#mechanic .mechHelp summary').tap({ timeout: 4000 }); // fails if the bottom menu is on top of it
    ok(await ph.evaluate(() => document.querySelector('#mechanic .mechHelp').open), 'the tap opened the help');
    await ph.evaluate(() => { window.scrollTo(0, 0); document.querySelector('#mechanic .mechHelp summary').scrollIntoView({ block: 'nearest' }); }); await sleep(200);
    const cov = await ph.evaluate(() => { const r = document.querySelector('#mechanic .mechHelp summary').getBoundingClientRect(), nav = document.getElementById('mobileBottomNav')?.getBoundingClientRect(); return { bottom: Math.round(r.bottom), navTop: Math.round(nav?.top ?? 1e9) }; });
    ok(cov.bottom <= cov.navTop, `scrolled into view, it stops above the bottom menu (${cov.bottom} <= ${cov.navTop})`);
    eq(ph.errs.join(' | '), '', 'phone: no page errors'); await pc.close();
  });
  await scenario('A46 phone: a mechanic\'s "Truck Is Here" is saved (assigned customer truck only, never back to "not here")', async () => {
    const st = await R('/api/state', { token: owner }), sf = st.shopflow.payload;
    sf.workorders = [...sf.workorders.filter(w => ![9951, 9952].includes(w.id)),
      { id: 9951, unit: 'ARRIVE-1', customer: 'Private Audit Fleet LLC', status: 'Open', mechanic: 'mech2', helpers: [], unitType: 'customer', truckHere: false, tasks: [{ uid: 'a1', t: 'Inspect brakes', done: false, parts: [] }] },
      { id: 9952, unit: 'ARRIVE-2', customer: 'Private Audit Fleet LLC', status: 'Open', mechanic: 'mech1', helpers: [], unitType: 'customer', truckHere: false, tasks: [{ uid: 'a2', t: 'Inspect lights', done: false, parts: [] }] }];
    await R('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf, expectedVersion: st.shopflow.version } });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    const page = await ctx.newPage(); page.setDefaultTimeout(8000); page.errs = []; page.on('pageerror', e => page.errs.push(e.message)); page.on('dialog', d => d.accept().catch(() => {}));
    await signIn(page, 'mech2', KPASS); await page.evaluate(() => showView('mechanic')); await sleep(900);
    await page.locator('#mechanic button[onclick*="mechanicMarkTruckHere(9951)"]').first().tap(); // "✓ Truck Is Here" on ARRIVE-1
    const here = async id => (await R('/api/state', { token: owner })).shopflow.payload.workorders.find(w => w.id === id)?.truckHere;
    ok(await until(async () => (await here(9951)) === true, 6000), 'the server keeps the mechanic\'s "Truck Is Here"');
    ok(await until(() => page.evaluate(() => /Ready to Work \(1\)/.test(document.getElementById('mechanic').innerText)), 4000), 'the truck moves to Ready to Work on the phone');
    // The same save path cannot take it back to "not here", and a mechanic cannot mark someone else's truck.
    const tok = await srv.login('mech2', KPASS), cur = await R('/api/state', { token: tok });
    const p2 = JSON.parse(JSON.stringify(cur.shopflow.payload)); for (const w of p2.workorders) if (w.id === 9951 || w.id === 9952) w.truckHere = w.id === 9952;
    for (const w of p2.workorders) if (w.id === 9951) w.truckHere = false;
    await R('/api/state/shopflow', { method: 'PUT', token: tok, body: { payload: p2, expectedVersion: cur.shopflow.version }, allowError: true });
    eq(await here(9951), true, 'a later save cannot set it back to "not here"');
    eq(await here(9952), false, 'a truck assigned to another mechanic is not changed');
    eq(page.errs.join(' | '), '', 'no page errors'); await ctx.close();
  });
  await scenario('A47 launch: a malformed id answers 400 (not 500); no "upload this browser" question on an empty database; new work orders get a time; invoice line fields are named', async () => {
    for (const path of ['/api/invoices/null', '/api/invoices/abc/pdf', '/api/estimates/not-a-number']) {
      const r = await R(path, { token: owner, allowError: true });
      eq(r.status, 400, `${path} answers 400`); ok(!/unexpected server error/i.test(r.error || ''), `${path}: a clear message (${r.error})`);
    }
    const { ctx, page } = await newPage(1280); await signIn(page, OWNER.username, OWNER.password);
    // A brand-new browser signing in to an empty online database: nothing to upload, so no question.
    const asked = await page.evaluate(async () => {
      const real = window.apiJSON, said = []; const realConfirm = window.confirm; window.confirm = m => { said.push(m); return false; };
      window.apiJSON = async (url, o) => /^\/api\/state$/.test(url) ? { users: { payload: {} }, shopflow: { payload: { workorders: [], issues: [] } }, pro: { payload: {} } } : real(url, o);
      const keep = [USERS, state, PRO]; USERS = {}; state = { workorders: [], issues: [] }; PRO = Object.assign({ vehicles: [], maintenance: [], audit: [], notifications: [], delays: [] });
      try { await loadCloudStateAfterLogin(); } catch (_) {} finally { window.apiJSON = real; window.confirm = realConfirm; [USERS, state, PRO] = keep; }
      return said;
    });
    eq(asked.filter(m => /database is empty/i.test(m)).length, 0, 'no "upload this browser\'s data" question when the browser has nothing');
    await page.evaluate(() => showView('workorders')); await sleep(500);
    await page.getByRole('button', { name: '+ New Work Order' }).first().click(); await sleep(500);
    ok(/^\d\d:\d\d$/.test(await page.inputValue('#woForm [name=time]')), 'the scheduled time is filled in like the date');
    await page.keyboard.press('Escape'); await sleep(300);
    const inv = await newInvoice(1);
    await R(`/api/invoices/${inv}/lines`, { method: 'POST', token: owner, body: { lineType: 'labor', description: 'Named labor', quantity: 1, unitPrice: 100, taxable: false, jobName: 'J' } });
    await page.evaluate(() => showView('invoices')); await sleep(500);
    await page.evaluate(id => openInvoice(id, true), inv); await page.waitForSelector('#invoiceModal.open'); await sleep(800);
    const unnamed = await page.evaluate(() => [...document.querySelectorAll('#invoiceModal input:not([type=hidden]), #invoiceModal select, #invoiceModal textarea')].filter(e => e.offsetParent && !(e.getAttribute('aria-label') || e.title || (e.labels && [...e.labels].some(l => l.textContent.trim())) || e.placeholder)).map(e => e.className || e.id || e.tagName));
    eq(unnamed.join(' | '), '', 'every invoice editor field has a name');
    eq(page.errs.join(' | '), '', 'no page errors'); await ctx.close();
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
finally { await browser.close().catch(() => {}); fmcsaMock.close(); await srv.cleanup(); }

if (failures.length) { reportSuite(NAME, 'FAILED', failures.join('; ')); console.error(`FAIL ${NAME}: ${failures.length} scenario(s)`); process.exit(1); }
reportSuite(NAME, 'PASSED'); console.log(`PASS ${NAME}`);
