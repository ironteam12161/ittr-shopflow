// v24.65.0: repair customer / unit links that the office "Create Work Order" form carried over from the previous work
// order (fixed in 24.64.0: form.reset() did not clear the hidden customerId / unitRecordId). A work order whose linked
// customer or unit does not match the customer name / unit # typed on it loses the bad link (the directory sync links it
// again by name), and an invoice whose customer_id points at a different company than its customer name is re-linked
// to the company with that exact name (or unlinked), so statements and the fleet portal never show another fleet's
// invoice. Runs at start-up; changes nothing when everything matches.
const key = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/\b(llc|inc|corp|corporation|co|ltd|the)\b/g, '').replace(/[^a-z0-9]+/g, '');
// A work order's customer / unit links, kept only when they match the customer name and unit # on the work order.
export async function trustedWoLinks(db, w) {
  let customerId = /^\d+$/.test(String(w?.customerId || '')) ? String(w.customerId) : '', unitRecordId = /^\d+$/.test(String(w?.unitRecordId || '')) ? String(w.unitRecordId) : '';
  if (customerId) { const c = (await db.query('SELECT customer_name FROM fullbay_import_customers WHERE id=$1::bigint', [customerId])).rows[0]; if (!c || (String(w.customer || '').trim() && !sameName(c.customer_name, w.customer))) customerId = ''; }
  if (unitRecordId) { const u = (await db.query('SELECT unit_number,customer_id::text customer_id FROM customer_units WHERE id=$1::bigint', [unitRecordId])).rows[0]; if (!u || (String(w.unit || '').trim() && String(u.unit_number || '').toLowerCase().replace(/[^a-z0-9]+/g, '') !== String(w.unit).toLowerCase().replace(/[^a-z0-9]+/g, '')) || (u.customer_id && customerId && u.customer_id !== customerId)) unitRecordId = ''; }
  return { customerId: customerId || null, unitRecordId: unitRecordId || null };
}
// Same company when the names match after clean-up, or one starts with the first 8 characters of the other
// ("Air Delivery Corp" / "Air Delivery Corporation").
export function sameName(a, b) {
  const x = key(a), y = key(b);
  if (!x || !y) return true;
  if (x === y) return true;
  const n = Math.min(8, x.length, y.length);
  return n >= 5 && (x.startsWith(y.slice(0, n)) || y.startsWith(x.slice(0, n)));
}
const unitKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export async function repairWorkOrderLinks(pool, { audit } = {}) {
  const db = await pool.connect(), fixedWo = [], fixedInv = [];
  try {
    await db.query('BEGIN');
    const q = (await db.query("SELECT payload FROM app_state WHERE state_key='shopflow' FOR UPDATE")).rows[0];
    const sf = q?.payload && typeof q.payload === 'object' ? q.payload : null, list = Array.isArray(sf?.workorders) ? sf.workorders : [];
    const cIds = [...new Set(list.map(w => String(w?.customerId || '')).filter(x => /^\d+$/.test(x)))];
    const uIds = [...new Set(list.map(w => String(w?.unitRecordId || '')).filter(x => /^\d+$/.test(x)))];
    const cust = new Map(cIds.length ? (await db.query('SELECT id::text id,customer_name FROM fullbay_import_customers WHERE id=ANY($1::bigint[])', [cIds])).rows.map(r => [r.id, r.customer_name]) : []);
    const units = new Map(uIds.length ? (await db.query('SELECT id::text id,unit_number,customer_id::text customer_id FROM customer_units WHERE id=ANY($1::bigint[])', [uIds])).rows.map(r => [r.id, r]) : []);
    for (const w of list) {
      if (!w || typeof w !== 'object' || w.unitType === 'equipment') continue;
      const fix = {}, cid = String(w.customerId || ''), uid = String(w.unitRecordId || '');
      if (/^\d+$/.test(cid) && cust.has(cid) && String(w.customer || '').trim() && !sameName(cust.get(cid), w.customer)) fix.customerId = { was: cid, linkedName: cust.get(cid) };
      const u = /^\d+$/.test(uid) ? units.get(uid) : null;
      if (u && String(w.unit || '').trim() && (unitKey(u.unit_number) !== unitKey(w.unit) || (fix.customerId && u.customer_id === cid))) fix.unitRecordId = { was: uid, linkedUnit: u.unit_number };
      if (!Object.keys(fix).length) continue;
      if (fix.customerId) w.customerId = '';
      if (fix.unitRecordId) w.unitRecordId = '';
      fixedWo.push({ workOrderId: String(w.id), unit: w.unit || '', customer: w.customer || '', ...fix });
    }
    if (fixedWo.length) await db.query("UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by='system:link-repair' WHERE state_key='shopflow'", [JSON.stringify(sf)]);
    // Service orders and invoices whose customer_id belongs to a different company than the name printed on them.
    for (const [table, numCol] of [['service_orders', 'service_order_number'], ['customer_invoices', 'invoice_number']]) {
      const has = (await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND column_name=$2`, [table, numCol])).rowCount;
      const bad = (await db.query(`SELECT t.id,${has ? `t.${numCol}` : 't.id'}::text num,t.customer_name,c.customer_name linked_name
          FROM ${table} t JOIN fullbay_import_customers c ON c.id=t.customer_id WHERE coalesce(t.customer_name,'')<>''`)).rows.filter(r => !sameName(r.linked_name, r.customer_name));
      for (const r of bad) {
        const m = (await db.query('SELECT id FROM fullbay_import_customers WHERE lower(trim(customer_name))=lower(trim($1)) ORDER BY id LIMIT 2', [r.customer_name])).rows;
        const to = m.length === 1 ? m[0].id : null;
        await db.query(`UPDATE ${table} SET customer_id=$2 WHERE id=$1`, [r.id, to]);
        fixedInv.push({ table, id: Number(r.id), number: r.num, customer: r.customer_name, wasLinkedTo: r.linked_name, nowCustomerId: to ? Number(to) : null });
      }
    }
    await db.query('COMMIT');
  } catch (e) { try { await db.query('ROLLBACK'); } catch (_) {} throw e; } finally { db.release(); }
  if ((fixedWo.length || fixedInv.length) && audit) await audit('system', 'work_order_links_repaired', { workOrders: fixedWo.slice(0, 200), invoices: fixedInv.slice(0, 200) });
  return { workOrders: fixedWo, invoices: fixedInv };
}
