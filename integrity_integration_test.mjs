// v24.72.0: regression suite for the October 17, 2026 audit — real server + disposable database (never production).
// F1  a mechanic's whole-shop save cannot rewrite finished work: completed work orders, completed inspections, jobs a
//     helper finished, parts and timers; removed jobs are kept. Normal mechanic edits (job outcome, finishing the order)
//     still work, and what was refused is reported back (notApplied).
// F2  Customers without Invoices gets no invoice data through portal links, customer/vehicle profiles or Fullbay detail.
// F3  a purchase-order receipt that repeats a line is refused and puts nothing on the shelf.
// F4  startup never merges same-name customers; the owner's reviewed merge moves every reference in one transaction.
// D2  CSV uploads are capped per request before the body is read.
import http from 'node:http';
import { dbSuiteGuard, reportSuite, startTestServer, ok, eq } from './test_harness.mjs';
const NAME = 'integrity integration';
dbSuiteGuard(NAME);

const OWNER = { username: 'owner', password: 'Shop-Boss-Pass-2026' };
const srv = await startTestServer({ prefix: 'ittr_integ', admin: OWNER, env: { ITTR_CSV_MAX_REQUEST_MB: '5' } });
const R = srv.request;
const failures = [];
async function scenario(name, fn) { try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.error(`FAIL ${name}: ${e.message.split('\n')[0]}`); } }
const T = (uid, t, x = {}) => ({ uid, t, done: false, startedAt: '', stoppedAt: '', elapsedMs: 0, parts: [], ...x });

try {
  const owner = await srv.login(OWNER.username, OWNER.password);
  for (const u of ['mecha', 'mechb']) await R('/api/admin/users', { method: 'POST', token: owner, body: { username: u, display: u.toUpperCase(), password: 'Mechanic-Pass-1' } });
  const mgr = async (username, permissions) => { await R('/api/admin/managers', { method: 'POST', token: owner, body: { username, display: username, password: 'Manager-Pass-2026', permissions } }); return srv.login(username, 'Manager-Pass-2026'); };
  const mgrCust = await mgr('mgrcust', { customers: true }), mgrBoth = await mgr('mgrboth', { customers: true, invoices: true }), mgrInv = await mgr('mgrinv', { inventory: true });
  const mechA = await srv.login('mecha', 'Mechanic-Pass-1');
  const shop = async () => (await R('/api/state', { token: owner })).shopflow.payload;
  const wo = async id => (await shop()).workorders.find(w => String(w.id) === String(id));

  // ---------- F1 ----------
  const st = await R('/api/state', { token: owner }); const sf = st.shopflow.payload;
  const finishedBrake = T('c-t1', 'Brake repair', { done: true, completedAt: '2026-10-16T10:00:00Z', completedBy: 'mecha', taskOutcome: 'completed', elapsedMs: 3600000, parts: [{ id: 'p1', partNumber: 'BRK-1', qty: 2 }] });
  sf.workorders = [
    { id: 901, unit: 'DONE-901', customer: 'Lock Fleet', status: 'Completed', mechanic: 'mecha', helpers: [], completedAt: '2026-10-16T11:00:00Z', tasks: [finishedBrake], inspection: { required: true, type: 'truck', status: 'Completed', results: { brakes: { status: 'repair', note: 'LF lining 2mm' } } } },
    { id: 902, unit: 'OPEN-902', customer: 'Lock Fleet', status: 'In Progress', mechanic: 'mecha', helpers: ['mechb'], tasks: [T('o-t1', 'Oil change', { parts: [{ id: 'p2', partNumber: 'OIL-1', qty: 1 }], elapsedMs: 1200000 }), T('o-t2', 'Helper job', { done: true, completedAt: '2026-10-16T12:00:00Z', completedBy: 'mechb', taskOutcome: 'completed' }), T('o-t3', 'Wipers')], inspection: { required: true, type: 'truck', status: 'Completed', results: { lights: { status: 'ok' } } } },
    { id: 903, unit: 'OPEN-903', customer: 'Lock Fleet', status: 'In Progress', mechanic: 'mecha', helpers: [], tasks: [T('q-t1', 'Check AC')] },
  ];
  sf.issues = [];
  await R('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf, expectedVersion: st.shopflow.version } });
  const mechSave = async mutate => { const s = await R('/api/state', { token: mechA }); const p = JSON.parse(JSON.stringify(s.shopflow.payload)); mutate(p); return R('/api/state/shopflow', { method: 'PUT', token: mechA, body: { payload: p, expectedVersion: s.shopflow.version } }); };

  await scenario('F1 completed work order: emptied jobs, changed inspection and status are not applied, and reported', async () => {
    const r = await mechSave(p => { const w = p.workorders.find(x => x.id === 901); w.tasks = []; w.status = 'In Progress'; w.inspection.results.brakes = { status: 'ok' }; w.notes = 'rewritten'; });
    ok(Array.isArray(r.notApplied) && r.notApplied.some(x => x.workOrderId === '901' && x.reason === 'completed'), `refusal reported (${JSON.stringify(r.notApplied)})`);
    const w = await wo(901);
    eq(w.status, 'Completed', 'still completed'); eq(w.tasks.length, 1, 'finished job kept'); eq(w.tasks[0].parts.length, 1, 'parts kept');
    eq(w.inspection.results.brakes.status, 'repair', 'completed inspection result kept'); ok(w.notes !== 'rewritten', 'notes unchanged');
  });
  await scenario('F1 open work order: removed jobs kept, helper\'s finished job and completed inspection kept, parts/timers from server', async () => {
    const r = await mechSave(p => { const w = p.workorders.find(x => x.id === 902);
      w.tasks = [{ ...w.tasks[0], parts: [], elapsedMs: 99999999, startedAt: '2020-01-01T00:00:00Z' }, { ...w.tasks[1], done: false, completedAt: '', taskOutcome: '' }];
      w.inspection.results.lights = { status: 'repair' }; });
    const w = await wo(902);
    eq(w.tasks.length, 3, 'removed job kept'); ok(w.tasks.some(t => t.uid === 'o-t3'), 'wipers job kept');
    const oil = w.tasks.find(t => t.uid === 'o-t1'); eq(oil.parts.length, 1, 'parts only change through the parts route'); eq(oil.elapsedMs, 1200000, 'timer only changes through the timer route'); eq(oil.startedAt, '', 'start time unchanged');
    const helper = w.tasks.find(t => t.uid === 'o-t2'); eq(helper.done, true, 'job finished by the helper stays finished');
    eq(w.inspection.results.lights.status, 'ok', 'completed inspection result kept');
    ok(r.notApplied.some(x => x.reason === 'finished_by_other') && r.notApplied.some(x => x.reason === 'inspection_completed'), `reported (${JSON.stringify(r.notApplied)})`);
  });
  await scenario('F1 normal mechanic edits still save: job outcome, notes, new job, finishing the order', async () => {
    const r = await mechSave(p => { const w = p.workorders.find(x => x.id === 903); w.tasks[0].taskOutcome = 'next_visit'; w.tasks[0].outcomeNote = 'Needs compressor'; w.notes = 'Customer waiting'; w.tasks.push(T('q-new', 'Extra: cabin filter')); });
    eq(r.notApplied, undefined, 'nothing refused');
    let w = await wo(903); eq(w.tasks[0].taskOutcome, 'next_visit', 'outcome saved'); eq(w.notes, 'Customer waiting', 'notes saved'); ok(w.tasks.some(t => t.uid === 'q-new' && Array.isArray(t.parts) && !t.parts.length), 'new job added without parts');
    await mechSave(p => { const x = p.workorders.find(y => y.id === 903); x.status = 'Completed'; x.completedAt = new Date().toISOString(); x.completionNotes = 'Done'; });
    w = await wo(903); eq(w.status, 'Completed', 'mechanic can still finish the work order');
    const unchanged = await mechSave(() => {}); eq(unchanged.notApplied, undefined, 'an unchanged save reports nothing');
  });

  // ---------- F2 ----------
  const cust = (await R('/api/customers', { method: 'POST', token: owner, body: { customer_name: 'Money Fleet', email: 'm@fleet.test' } })).item;
  const unit = (await R(`/api/customers/${cust.id}/units`, { method: 'POST', token: owner, body: { unit_number: 'M-1' } })).item;
  await srv.db.query(`INSERT INTO fullbay_service_history(source_key,customer_id,customer_name,service_order,invoice_number,unit_number,total_amount,labor_amount,part_amount,complaint,action_number,raw) VALUES('t1',$1,'Money Fleet','SO-77','INV-SECRET-77','M-1',900,500,400,'Brakes','1','{}'::jsonb)`, [cust.id]);
  await R('/api/invoices', { method: 'POST', token: owner, body: { customerId: cust.id, customerName: 'Money Fleet', unitId: unit.id, unitNumber: 'M-1' } });
  const hasMoney = o => /INV-SECRET-77|"totalAmount"|"laborAmount"|"invoice":"/.test(JSON.stringify(o));
  await scenario('F2 Customers without Invoices: no portal link, no invoice data in profiles or Fullbay detail', async () => {
    const link = await R('/api/customer-links', { method: 'POST', token: mgrCust, body: { kind: 'portal', refId: String(cust.id) }, allowError: true });
    eq(link.status, 403, 'portal link needs Invoices');
    const cp = await R(`/api/customers/${cust.id}/profile`, { token: mgrCust });
    ok(cp.history.some(h => h.source === 'fullbay'), 'work history still shown'); ok(!hasMoney(cp), 'customer profile has no invoice numbers or amounts');
    const up = await R(`/api/customer-units/${unit.id}/profile`, { token: mgrCust });
    ok(!up.history.some(h => h.source === 'invoice'), 'vehicle profile leaves out shop invoices'); ok(!hasMoney(up), 'vehicle profile has no money');
    const so = await R(`/api/fullbay/service-orders/SO-77?customerId=${cust.id}`, { token: mgrCust });
    ok(so.order && !hasMoney(so) && !JSON.stringify(so).includes('"totalAmount"'), 'Fullbay detail without invoice/amounts');
  });
  await scenario('F2 Customers + Invoices and owner keep full history and portal links', async () => {
    const cp = await R(`/api/customers/${cust.id}/profile`, { token: mgrBoth }); ok(JSON.stringify(cp).includes('INV-SECRET-77'), 'invoice number shown');
    const up = await R(`/api/customer-units/${unit.id}/profile`, { token: owner }); ok(up.history.some(h => h.source === 'invoice'), 'owner sees shop invoices');
    const link = await R('/api/customer-links', { method: 'POST', token: mgrBoth, body: { kind: 'portal', refId: String(cust.id) } }); ok(link.url || link.token, 'portal link created');
  });

  // ---------- F3 ----------
  await scenario('F3 a receipt that lists the same PO line twice is refused and stock is unchanged', async () => {
    const part = await R('/api/parts', { method: 'POST', token: owner, body: { partNumber: 'PO-DUP-1', description: 'Dup test filter', quantity: 0, cost: 5, price: 10 } });
    const partId = Number(part.item?.id || part.part?.id || part.id);
    const po = await R('/api/purchase-orders', { method: 'POST', token: mgrInv, body: { vendor: 'Dup Parts', lines: [{ inventoryPartId: partId, partNumber: 'PO-DUP-1', description: 'Dup test filter', qty: 10, unitCost: 5 }] } });
    await R(`/api/purchase-orders/${po.id}/status`, { method: 'POST', token: mgrInv, body: { status: 'ordered' } });
    const b = await R(`/api/purchase-orders/${po.id}`, { token: mgrInv }); const lineId = (b.lines || b.po?.lines || [])[0].id;
    const r = await R(`/api/purchase-orders/${po.id}/receive`, { method: 'POST', token: mgrInv, body: { lines: [{ id: lineId, qty: 10 }, { id: lineId, qty: 10 }] }, allowError: true });
    eq(r.status, 400, 'duplicate line refused');
    const qty = Number((await srv.db.query('SELECT quantity FROM fullbay_import_parts WHERE id=$1', [partId])).rows[0].quantity);
    eq(qty, 0, 'nothing put on the shelf'); eq(Number((await srv.db.query('SELECT qty_received FROM purchase_order_lines WHERE id=$1', [lineId])).rows[0].qty_received), 0, 'nothing received');
    await R(`/api/purchase-orders/${po.id}/receive`, { method: 'POST', token: mgrInv, body: { lines: [{ id: lineId, qty: 10 }] } });
    eq(Number((await srv.db.query('SELECT quantity FROM fullbay_import_parts WHERE id=$1', [partId])).rows[0].quantity), 10, 'a normal receipt still works');
    const over = await R(`/api/purchase-orders/${po.id}/receive`, { method: 'POST', token: mgrInv, body: { lines: [{ id: lineId, qty: 1 }] }, allowError: true }); ok(over.status >= 400, 'nothing more than ordered');
  });

  // ---------- F4 ----------
  await scenario('F4 restart keeps same-name customers apart; reviewed owner merge moves every reference', async () => {
    const a = (await R('/api/customers', { method: 'POST', token: owner, body: { customer_name: 'Twin Trucking', dot_number: '111' } })).item;
    const b = (await R('/api/customers', { method: 'POST', token: owner, body: { customer_name: 'Twin Trucking', dot_number: '222' } })).item;
    await srv.stop(); await srv.start();
    const left = (await srv.db.query("SELECT id FROM fullbay_import_customers WHERE customer_name='Twin Trucking'")).rows.length;
    eq(left, 2, 'both same-name customers still exist after a restart');
    const link = await R('/api/customer-links', { method: 'POST', token: owner, body: { kind: 'portal', refId: String(b.id) } });
    const ownerTok = await srv.login(OWNER.username, OWNER.password);
    const m = await R('/api/customers/merge', { method: 'POST', token: ownerTok, body: { masterId: a.id, duplicateId: b.id } });
    eq(m.moved?.customer_links, 1, 'portal link moved to the kept customer');
    eq((await srv.db.query('SELECT count(*)::int n FROM customer_links WHERE customer_id=$1', [b.id])).rows[0].n, 0, 'nothing left pointing at the removed customer');
    ok((await srv.db.query("SELECT details FROM server_audit WHERE action='customer_merged' ORDER BY id DESC LIMIT 1")).rows[0].details.duplicateRecord.dot_number === '222', 'removed record kept in the audit log');
    ok(link.url || link.token, 'link existed');
  });

  // ---------- D2 ----------
  await scenario('D2 a CSV upload larger than the per-request cap is refused before the body is read', async () => {
    const tok = await srv.login(OWNER.username, OWNER.password);
    const u = new URL(srv.base() + '/api/fullbay/check/service-history');
    const status = await new Promise((resolve, reject) => {
      const rq = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': String(50 * 1024 * 1024) } }, res => { res.resume(); resolve(res.statusCode); });
      rq.on('error', e => (e.code === 'ECONNRESET' || e.code === 'EPIPE') ? null : reject(e)); rq.on('close', () => resolve(0)); rq.write('--x\r\n'); setTimeout(() => rq.destroy(), 3000);
    });
    eq(status, 413, 'too large');
  });
} catch (e) {
  failures.push('setup'); console.error(`FAIL ${NAME} setup: ${e.stack || e.message}\n${srv.output().slice(-3000)}`);
} finally { await srv.cleanup(); }
if (failures.length) { console.error(`FAIL ${NAME}: ${failures.length} scenario(s) failed: ${failures.join('; ')}`); process.exit(1); }
console.log(`PASS ${NAME}`);
reportSuite(NAME, 'PASSED');
