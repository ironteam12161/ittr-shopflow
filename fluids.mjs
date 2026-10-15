// ITTR ShopFlow v24.43.0: fluids (oil, antifreeze, DEF, ATF, hydraulic, gear oil…) are stocked in gallons.
// Work orders and invoices can use gallons or quarts; stock always moves in gallons (1 qt = 0.25 gal).
// The owner converts existing fluid parts once (e.g. "Antifreeze - 55 Gallon" drums → gallons): quantity, reservations,
// reorder levels and prices are converted together so nothing is lost or double-counted.
import { packSize } from './part_matching.mjs';

export const FLUID_UNITS = Object.freeze({ gal: 1, qt: 0.25 });
export const FLUID_RE = /\b(anti-?freeze|coolant|motor oil|engine oil|oil\b.*\b(15w|10w|5w|0w|sae|synthetic|diesel)|(15w|10w|5w|0w)-?\d{2}|\bdef\b|diesel exhaust fluid|\batf\b|transmission fluid|trans fluid|hydraulic|gear (oil|lube)|80w|75w|85w|90w|140w|power steering fluid|brake fluid|dot ?[345]\b|washer fluid|windshield fluid|wiper fluid|fluid)\b/i;
const NOT_FLUID = /\b(filter|cap|seal|gasket|pump|tank|hose|fitting|sensor|gauge|dipstick|funnel|drain plug|absorbent|pad|pan|cooler|reservoir|grease|thermostat|housing|radiator|valve|switch|line|tester|bracket|clamp)\b/i;
export const isGallonUom = u => /^\s*(gal|gallon|gallons)\s*$/i.test(String(u || ''));
export function looksLikeFluid(p) { const t = `${p?.description || ''} ${p?.part_number || ''} ${p?.category || ''}`; return FLUID_RE.test(t) && !NOT_FLUID.test(t); }
// Gallons in one current stock unit of the part, read from its description ("55 Gallon" → 55, "1 qt" → 0.25, "case of 12 qt" → 3).
export function gallonsPerStockUnit(p) {
  const t = `${p?.description || ''} ${p?.part_number || ''} ${p?.uom || ''}`;
  const caseQt = /\b(?:case\s+of\s+|)(\d+)\s*(?:x|\/|-)?\s*(?:1\s*)?(?:qt|quarts?)\b.*\b(case|cs|pack|pk)\b|\b(case|cs)\s+of\s+(\d+)\s*(?:x\s*)?(?:1\s*)?(?:qt|quarts?)\b/i.exec(t);
  if (caseQt) return Number(caseQt[1] || caseQt[4]) / 4;
  const ps = packSize(t);
  return ps && ps.kind === 'gal' && ps.size > 0 ? ps.size : 1;
}
// Stock gallons per billed/used unit for a part in gallons; 1 for everything else.
export function stockPerUnit(unit, partUom) { return isGallonUom(partUom) && FLUID_UNITS[unit] ? FLUID_UNITS[unit] : 1; }
export const unitLabel = (u, q) => u === 'qt' ? (Number(q) === 1 ? 'qt' : 'qts') : u === 'gal' ? 'gal' : '';

export async function ensureFluidSchema(pool) {
  await pool.query('ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS is_fluid BOOLEAN');
  await pool.query('ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE fullbay_import_parts ADD COLUMN IF NOT EXISTS archived_by TEXT');
}

export function registerFluidRoutes(app, { auth, managerPermission, requireDb, audit }) {
  const perm = managerPermission('inventory');
  app.get('/api/parts/fluids', auth, perm, async (req, res, next) => {
    try {
      const r = await requireDb().query(`SELECT id,part_number,internal_barcode,description,category,uom,quantity,allocated,cost,price,reorder_point,is_fluid FROM fullbay_import_parts
        WHERE coalesce(status,'Active')<>'Inactive' ORDER BY description NULLS LAST LIMIT 5000`);
      const q = String(req.query.q || '').trim().toLowerCase();
      // q: find any other part by name to switch (fluids the keyword list did not recognise).
      const fluids = r.rows.filter(p => isGallonUom(p.uom) || (q ? `${p.description || ''} ${p.part_number || ''}`.toLowerCase().includes(q) : p.is_fluid === true || (p.is_fluid !== false && looksLikeFluid(p))));
      res.json({
        converted: fluids.filter(p => isGallonUom(p.uom)),
        candidates: fluids.filter(p => !isGallonUom(p.uom)).map(p => ({ ...p, suggestedGallons: gallonsPerStockUnit(p) })),
      });
    } catch (e) { next(e); }
  });
  // Convert parts to gallons. gallons = how many gallons one current stock unit holds (55 for a drum, 1 if already counted per gallon).
  app.post('/api/parts/fluids/convert', auth, perm, async (req, res, next) => {
    const items = (Array.isArray(req.body?.items) ? req.body.items : []).map(x => ({ id: Number(x?.id), g: Number(x?.gallons) })).filter(x => x.id > 0 && x.g > 0 && x.g <= 1000).slice(0, 500);
    if (!items.length) return res.status(400).json({ error: 'Choose at least one part and how many gallons one unit holds.' });
    const db = await requireDb().connect();
    try {
      await db.query('BEGIN');
      if ((await db.query("SELECT 1 FROM inventory_count_sessions WHERE status='open' LIMIT 1")).rowCount) { await db.query('ROLLBACK'); return res.status(409).json({ error: 'Finish or cancel the open inventory count first.' }); }
      const sq = await db.query("SELECT payload FROM app_state WHERE state_key='shopflow' FOR UPDATE");
      const sf = sq.rows[0]?.payload && typeof sq.rows[0].payload === 'object' ? sq.rows[0].payload : null;
      let converted = 0, woParts = 0, invLines = 0;
      for (const { id, g } of items) {
        const p = (await db.query('SELECT * FROM fullbay_import_parts WHERE id=$1::bigint FOR UPDATE', [id])).rows[0];
        if (!p || isGallonUom(p.uom)) continue;
        const mul = c => `${c}=CASE WHEN ${c} IS NULL THEN NULL ELSE ${c}*$2::numeric END`, div = c => `${c}=CASE WHEN ${c} IS NULL THEN NULL ELSE ${c}/$2::numeric END`;
        await db.query(`UPDATE fullbay_import_parts SET uom='gal',${['quantity', 'allocated', 'reorder_point', 'min_qty', 'max_qty', 'on_order'].map(mul).join(',')},${['cost', 'price', 'last_purchase_cost', 'previous_purchase_cost'].map(div).join(',')},updated_at=now() WHERE id=$1::bigint`, [id, g]);
        const after = (await db.query('SELECT quantity FROM fullbay_import_parts WHERE id=$1::bigint', [id])).rows[0];
        await db.query(`INSERT INTO part_inventory_transactions(part_id,transaction_type,quantity_delta,quantity_before,quantity_after,reference,reason,username,metadata) VALUES($1,'unit_change',0,$2::numeric,$3::numeric,'Gallons','Stock unit changed to gallons',$4,$5::jsonb)`,
          [id, Number(p.quantity || 0), Number(after?.quantity || 0), req.user.username, JSON.stringify({ gallonsPerOldUnit: g, oldUom: p.uom || null })]);
        // Open work-order reservations and invoice lines keep their meaning: 1 drum reserved = 55 gal reserved.
        if (sf) for (const w of (Array.isArray(sf.workorders) ? sf.workorders : [])) for (const t of (Array.isArray(w?.tasks) ? w.tasks : [])) for (const wp of (Array.isArray(t?.parts) ? t.parts : [])) {
          if (Number(wp?.inventoryPartId) !== id) continue;
          wp.qty = Math.round(Number(wp.qty || 0) * g * 1000) / 1000; wp.unit = 'gal'; wp.stockPerUnit = 1;
          if (wp.reservedQty != null) wp.reservedQty = Math.round(Number(wp.reservedQty || 0) * g * 1000) / 1000;
          if (wp.unitPrice != null) wp.unitPrice = Number(wp.unitPrice) / g; if (wp.unitCost != null) wp.unitCost = Number(wp.unitCost) / g;
          woParts++;
        }
        const lr = await db.query(`UPDATE customer_invoice_lines SET stock_posted_qty=coalesce(stock_posted_qty,0)*$2::numeric,
            metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('stockPerUnit',coalesce((metadata->>'stockPerUnit')::numeric,1)*$2::numeric) WHERE inventory_part_id=$1::bigint`, [id, g]);
        invLines += lr.rowCount; converted++;
        // v24.59.0: open estimates keep the price quoted (per drum, case…); the line remembers how many gallons it is.
        await db.query(`UPDATE customer_estimate_lines l SET metadata=coalesce(l.metadata,'{}'::jsonb)||jsonb_build_object('stockPerUnit',coalesce((l.metadata->>'stockPerUnit')::numeric,1)*$2::numeric)
            FROM customer_estimates e WHERE e.id=l.estimate_id AND e.status NOT IN ('converted','declined') AND l.inventory_part_id=$1::bigint`, [id, g]);
      }
      if (sf && woParts) await db.query("UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by=$2 WHERE state_key='shopflow'", [JSON.stringify(sf), req.user.username]);
      await db.query('COMMIT');
      await audit(req.user.username, 'fluids_converted_to_gallons', { items, converted, woParts, invLines });
      res.json({ ok: true, converted, workOrderParts: woParts, invoiceLines: invLines });
    } catch (e) { try { await db.query('ROLLBACK'); } catch (_) {} next(e); } finally { db.release(); }
  });
  // v24.45.2: undo a wrong switch to gallons. Uses the factor saved when the part was switched, and puts quantity,
  // reservations, reorder levels, prices, open work-order parts and invoice lines back in the old unit.
  app.post('/api/parts/:id/fluids/revert', auth, perm, async (req, res, next) => {
    const id = Number(req.params.id); if (!(id > 0)) return res.status(404).json({ error: 'Part not found.' });
    const db = await requireDb().connect();
    try {
      await db.query('BEGIN');
      const p = (await db.query('SELECT * FROM fullbay_import_parts WHERE id=$1::bigint FOR UPDATE', [id])).rows[0];
      if (!p) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Part not found.' }); }
      if (!isGallonUom(p.uom)) { await db.query('ROLLBACK'); return res.status(409).json({ error: 'This part is not counted in gallons.' }); }
      const t = (await db.query(`SELECT metadata FROM part_inventory_transactions WHERE part_id=$1 AND transaction_type='unit_change' AND coalesce(metadata->>'reverted','')='' ORDER BY id DESC LIMIT 1`, [id])).rows[0];
      const g = Number(t?.metadata?.gallonsPerOldUnit) > 0 ? Number(t.metadata.gallonsPerOldUnit) : 1, oldUom = t?.metadata?.oldUom || 'EA';
      const div = c => `${c}=CASE WHEN ${c} IS NULL THEN NULL ELSE ${c}/$2::numeric END`, mul = c => `${c}=CASE WHEN ${c} IS NULL THEN NULL ELSE ${c}*$2::numeric END`;
      await db.query(`UPDATE fullbay_import_parts SET uom=$3,is_fluid=false,${['quantity', 'allocated', 'reorder_point', 'min_qty', 'max_qty', 'on_order'].map(div).join(',')},${['cost', 'price', 'last_purchase_cost', 'previous_purchase_cost'].map(mul).join(',')},updated_at=now() WHERE id=$1::bigint`, [id, g, oldUom]);
      const after = (await db.query('SELECT quantity FROM fullbay_import_parts WHERE id=$1::bigint', [id])).rows[0];
      await db.query(`UPDATE part_inventory_transactions SET metadata=metadata||'{"reverted":true}'::jsonb WHERE part_id=$1 AND transaction_type='unit_change' AND coalesce(metadata->>'reverted','')=''`, [id]);
      await db.query(`INSERT INTO part_inventory_transactions(part_id,transaction_type,quantity_delta,quantity_before,quantity_after,reference,reason,username,metadata) VALUES($1,'unit_change',0,$2::numeric,$3::numeric,'Undo gallons','Stock unit changed back from gallons',$4,$5::jsonb)`,
        [id, Number(p.quantity || 0), Number(after?.quantity || 0), req.user.username, JSON.stringify({ revertedFromGallons: true, gallonsPerOldUnit: g, newUom: oldUom, reverted: true })]);
      const sq = await db.query("SELECT payload FROM app_state WHERE state_key='shopflow' FOR UPDATE");
      const sf = sq.rows[0]?.payload && typeof sq.rows[0].payload === 'object' ? sq.rows[0].payload : null;
      let woParts = 0;
      if (sf) for (const w of (Array.isArray(sf.workorders) ? sf.workorders : [])) for (const tk of (Array.isArray(w?.tasks) ? w.tasks : [])) for (const wp of (Array.isArray(tk?.parts) ? tk.parts : [])) {
        if (Number(wp?.inventoryPartId) !== id) continue;
        const spu = Number(wp.stockPerUnit) > 0 ? Number(wp.stockPerUnit) : 1;
        wp.qty = Math.round(Number(wp.qty || 0) * spu / g * 1000) / 1000; delete wp.unit; delete wp.stockPerUnit;
        if (wp.reservedQty != null) wp.reservedQty = Math.round(Number(wp.reservedQty || 0) / g * 1000) / 1000;
        if (wp.unitPrice != null) wp.unitPrice = Number(wp.unitPrice) * g; if (wp.unitCost != null) wp.unitCost = Number(wp.unitCost) * g;
        woParts++;
      }
      if (sf && woParts) await db.query("UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by=$2 WHERE state_key='shopflow'", [JSON.stringify(sf), req.user.username]);
      // Invoice lines keep what the customer was billed; only how much stock each billed unit moves changes.
      const lr = await db.query(`UPDATE customer_invoice_lines SET stock_posted_qty=coalesce(stock_posted_qty,0)/$2::numeric,
          metadata=(coalesce(metadata,'{}'::jsonb)-'galPrice'-'galCost')||jsonb_build_object('stockPerUnit',coalesce((metadata->>'stockPerUnit')::numeric,1)/$2::numeric) WHERE inventory_part_id=$1::bigint`, [id, g]);
      await db.query(`UPDATE customer_estimate_lines l SET metadata=(coalesce(l.metadata,'{}'::jsonb)-'galPrice'-'galCost'-'unit')||jsonb_build_object('stockPerUnit',coalesce((l.metadata->>'stockPerUnit')::numeric,1)/$2::numeric)
          FROM customer_estimates e WHERE e.id=l.estimate_id AND e.status NOT IN ('converted','declined') AND l.inventory_part_id=$1::bigint`, [id, g]);
      await db.query('COMMIT');
      await audit(req.user.username, 'fluid_unit_reverted', { partId: id, gallonsPerOldUnit: g, oldUom, woParts, invoiceLines: lr.rowCount });
      res.json({ ok: true, uom: oldUom, gallonsPerOldUnit: g, workOrderParts: woParts, invoiceLines: lr.rowCount });
    } catch (e) { try { await db.query('ROLLBACK'); } catch (_) {} next(e); } finally { db.release(); }
  });
  // Take a part off (or put it on) the Fluids list without changing its unit.
  app.post('/api/parts/:id/fluid-flag', auth, perm, async (req, res, next) => {
    try {
      const v = req.body?.isFluid === true ? true : req.body?.isFluid === false ? false : null;
      const r = await requireDb().query('UPDATE fullbay_import_parts SET is_fluid=$2,updated_at=now() WHERE id=$1::bigint RETURNING id', [req.params.id, v]);
      if (!r.rowCount) return res.status(404).json({ error: 'Part not found.' });
      await audit(req.user.username, 'fluid_flag', { partId: Number(req.params.id), isFluid: v });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
}

// v24.45.2: delete parts you don't need. A part never used anywhere is deleted; a part that appears on invoices,
// vendor bills, counts or stock history is archived instead (hidden from every list, history kept). Archived parts can be restored.
export function registerPartDeleteRoutes(app, { auth, managerPermission, requireDb, audit }) {
  const perm = managerPermission('inventory');
  async function removeOne(db, id, username) {
    const p = (await db.query('SELECT id,part_number,description,quantity,allocated,status FROM fullbay_import_parts WHERE id=$1::bigint FOR UPDATE', [id])).rows[0];
    if (!p) return { id, error: 'Part not found.' };
    if (Number(p.allocated || 0) > 0) return { id, error: `${p.description || p.part_number || 'Part'} is reserved on an open work order. Remove it from the work order first.` };
    const used = (await db.query(`SELECT
        EXISTS(SELECT 1 FROM part_inventory_transactions WHERE part_id=$1) OR
        EXISTS(SELECT 1 FROM customer_invoice_lines WHERE inventory_part_id=$1) OR
        EXISTS(SELECT 1 FROM parts_vendor_invoice_lines WHERE matched_part_id=$1) OR
        EXISTS(SELECT 1 FROM part_purchase_cost_history WHERE part_id=$1) OR
        EXISTS(SELECT 1 FROM inventory_count_lines WHERE part_id=$1) OR
        EXISTS(SELECT 1 FROM part_core_obligations WHERE part_id=$1) AS used`, [id])).rows[0]?.used;
    if (used) {
      await db.query(`UPDATE fullbay_import_parts SET status='Inactive',archived_at=now(),archived_by=$2,updated_at=now() WHERE id=$1::bigint`, [id, username]);
      return { id, archived: true, name: p.description || p.part_number };
    }
    await db.query('DELETE FROM fullbay_import_parts WHERE id=$1::bigint', [id]);
    return { id, deleted: true, name: p.description || p.part_number };
  }
  app.post('/api/parts/delete', auth, perm, async (req, res, next) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(n => n > 0))].slice(0, 500);
    if (!ids.length) return res.status(400).json({ error: 'Choose at least one part.' });
    const db = await requireDb().connect();
    try {
      await db.query('BEGIN');
      if ((await db.query("SELECT 1 FROM inventory_count_sessions WHERE status='open' LIMIT 1")).rowCount) { await db.query('ROLLBACK'); return res.status(409).json({ error: 'Finish or cancel the open inventory count first.' }); }
      const results = []; for (const id of ids) results.push(await removeOne(db, id, req.user.username));
      await db.query('COMMIT');
      const deleted = results.filter(r => r.deleted).length, archived = results.filter(r => r.archived).length, errors = results.filter(r => r.error);
      await audit(req.user.username, 'parts_deleted', { ids, deleted, archived, errors: errors.length });
      res.json({ ok: true, deleted, archived, errors, results });
    } catch (e) { try { await db.query('ROLLBACK'); } catch (_) {} next(e); } finally { db.release(); }
  });
  app.post('/api/parts/:id/restore', auth, perm, async (req, res, next) => {
    try {
      const r = await requireDb().query(`UPDATE fullbay_import_parts SET status='Active',archived_at=NULL,archived_by=NULL,updated_at=now() WHERE id=$1::bigint RETURNING id`, [req.params.id]);
      if (!r.rowCount) return res.status(404).json({ error: 'Part not found.' });
      await audit(req.user.username, 'part_restored', { partId: Number(req.params.id) }); res.json({ ok: true });
    } catch (e) { next(e); }
  });
}
