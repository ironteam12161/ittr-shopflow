// v24.70.0: Repair Board / approval-lane fields against a disposable database. The office sets QC, blockers, pick-up,
// "reviewed" and "sent to customer"; a mechanic's whole-shop save must keep those exactly as they were, a new finding
// from a mechanic can never arrive already reviewed or sent, and the job a finding was found on is kept.
// Decisions still go through /api/findings/:id/decision (unchanged), which turns an approved finding into a job.
import { dbSuiteGuard, startTestServer, ok, eq } from './test_harness.mjs';
dbSuiteGuard('Repair Board workflow fields');
const srv = await startTestServer({ prefix: 'ittr_flow' });

try {
  const owner = await srv.login('opsadmin', 'CI-Ops-Admin-2026!');
  await srv.request('/api/admin/users', { method: 'POST', token: owner, body: { username: 'mech1', display: 'Mech One', password: 'Mechanic-Pass-1' } });
  await srv.request('/api/admin/managers', { method: 'POST', token: owner, body: { username: 'mgr1', display: 'Manager', password: 'Manager-Pass-2026', permissions: { invoices: true } } });
  const mech = await srv.login('mech1', 'Mechanic-Pass-1'), mgr = await srv.login('mgr1', 'Manager-Pass-2026');
  const get = async token => (await srv.request('/api/state', { token })).shopflow;
  const put = async (token, payload, version) => srv.request('/api/state/shopflow', { method: 'PUT', token, body: { payload, expectedVersion: version } });
  const now = new Date().toISOString();

  let st = await get(owner);
  const sf = st.payload;
  sf.workorders = [{ id: 701, unit: 'FLOW-1', customer: 'Flow Fleet', status: 'In Progress', mechanic: 'mech1', helpers: [], unitType: 'customer', truckHere: true, tasks: [{ uid: 'f1', t: 'Brakes', done: true, taskOutcome: 'completed' }],
    qc: { passedAt: now, by: 'opsadmin' }, blockers: { hold: { on: true, by: 'opsadmin', at: now, note: 'Customer paying first' } } }];
  sf.issues = [{ id: 9101, wo: 701, mechanic: 'mech1', severity: 'High', description: 'Cracked drum', approval: 'Waiting for Customer', createdAt: now, officeReviewedAt: now, officeReviewedBy: 'opsadmin', sentAt: now, sentBy: 'opsadmin', taskUid: 'f1', taskSnapshot: 'Brakes' }];
  await put(owner, sf, st.version);

  // Manager (office) can change the office fields.
  st = await get(mgr); st.payload.workorders[0].blockers.parts = { on: true, by: 'mgr1', at: now, note: 'Drum on order' };
  await put(mgr, st.payload, st.version);
  ok((await get(owner)).payload.workorders[0].blockers.parts?.on === true, 'manager sets a blocker');

  // Mechanic tries to clear QC/blockers, mark picked up, and un-send / un-review the finding; also adds a new finding
  // that claims to be reviewed and sent. Ordinary work (notes) still saves.
  st = await get(mech);
  const w = st.payload.workorders.find(x => String(x.id) === '701');
  w.qc = { passedAt: '', by: 'mech1' }; w.blockers = {}; w.releasedAt = now; w.releasedBy = 'mech1'; w.completionNotes = 'MECH NOTE';
  const i = st.payload.issues.find(x => String(x.id) === '9101'); i.officeReviewedAt = ''; i.sentAt = ''; i.sentBy = 'mech1'; i.description = 'Cracked drum, LF';
  st.payload.issues.push({ id: '9103" autofocus onfocus="alert(1)', wo: 701, severity: 'High', description: 'Crafted id', approval: 'Waiting for Customer' });
  st.payload.issues.push({ id: 9102, wo: 701, severity: 'Needs Attention', description: 'Loose mud flap', approval: 'Proceed', officeReviewedAt: now, officeReviewedBy: 'mech1', sentAt: now, sentBy: 'mech1', taskUid: 'f1', taskSnapshot: 'Brakes' });
  await put(mech, st.payload, st.version);

  const after = (await get(owner)).payload, aw = after.workorders.find(x => String(x.id) === '701');
  eq(aw.completionNotes, 'MECH NOTE', 'mechanic work still saves');
  eq(aw.qc?.passedAt, now, 'QC kept'); eq(aw.blockers?.hold?.on, true, 'hold blocker kept'); eq(aw.blockers?.parts?.on, true, 'parts blocker kept');
  ok(!aw.releasedAt && !aw.releasedBy, 'mechanic cannot mark the truck picked up');
  const ai = after.issues.find(x => String(x.id) === '9101');
  eq(ai.officeReviewedAt, now, 'review kept'); eq(ai.sentAt, now, 'sent kept'); eq(ai.sentBy, 'opsadmin', 'sent-by kept'); eq(ai.description, 'Cracked drum, LF', 'mechanic can still edit the finding text');
  ok(!after.issues.some(x => x.description === 'Crafted id'), 'a finding whose id could break the office page is not stored');
  const ni = after.issues.find(x => String(x.id) === '9102');
  ok(ni, 'new mechanic finding saved');
  eq(ni.approval, 'Waiting for Customer', 'new finding waits for a decision'); eq(ni.officeReviewedAt, '', 'new finding not reviewed'); eq(ni.sentAt, '', 'new finding not sent'); eq(ni.sentBy, '', 'no sent-by');
  eq(ni.taskUid, 'f1', 'job the finding was found on is kept'); eq(ni.taskSnapshot, 'Brakes', 'job name kept'); eq(ni.mechanic, 'mech1', 'mechanic recorded');

  // Decision path unchanged: approving creates the job (Job Created lane), declining removes nothing.
  const d = await srv.request('/api/findings/9102/decision', { method: 'POST', token: owner, body: { value: 'Proceed' } });
  ok(d.ok !== false, 'decision accepted');
  const s2 = (await get(owner)).payload, t = s2.workorders.find(x => String(x.id) === '701').tasks.find(x => String(x.findingId ?? '') === '9102');
  ok(t, 'approved finding became a job on the work order'); ok(s2.issues.find(x => String(x.id) === '9102').convertedToTask, 'finding marked converted');
  eq(s2.workorders.find(x => String(x.id) === '701').qc?.passedAt, now, 'decision keeps QC');
  // Open purchase orders per work order (Repair Board "Waiting on parts"): owner sees PO and vendor, a manager without
  // Parts & inventory only that parts are on order, a mechanic nothing.
  const po = await srv.request('/api/purchase-orders', { method: 'POST', token: owner, body: { vendor: 'Flow Parts', workOrderId: '701', expectedDate: '2026-10-20', lines: [{ partNumber: 'DRUM-1', description: 'Brake drum', qty: 1, unitCost: 120 }] } });
  let open = await srv.request('/api/purchase-orders/open-by-work-order', { token: owner });
  eq(open.items.length, 0, 'a draft PO does not hold the truck up');
  await srv.request(`/api/purchase-orders/${po.id}/status`, { method: 'POST', token: owner, body: { status: 'ordered' } });
  open = await srv.request('/api/purchase-orders/open-by-work-order', { token: owner });
  ok(open.items.length === 1 && open.items[0].workOrderId === '701' && open.items[0].poNumber === po.poNumber && open.items[0].vendor === 'Flow Parts' && open.items[0].qtyOpen === 1, 'ordered PO listed for its work order (owner sees PO and vendor)');
  const mo = await srv.request('/api/purchase-orders/open-by-work-order', { token: mgr });
  ok(mo.items.length === 1 && !('poNumber' in mo.items[0]) && !('vendor' in mo.items[0]) && mo.items[0].expectedDate, 'manager without Parts & inventory sees only that parts are on order');
  eq((await srv.request('/api/purchase-orders/open-by-work-order', { token: mech, allowError: true })).status, 403, 'mechanic cannot list purchase orders');
  console.log('PASS Repair Board workflow fields: office-only QC/blockers/pick-up/review/sent, job link, decision path, open POs');
} catch (e) {
  console.error(e); console.error(srv.output().slice(-2500)); process.exitCode = 1;
} finally { await srv.cleanup(); }
