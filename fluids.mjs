// ITTR ShopFlow v24.43.0: fluids (oil, antifreeze, DEF, ATF, hydraulic, gear oil…) are stocked in gallons.
// Work orders and invoices can use gallons or quarts; stock always moves in gallons (1 qt = 0.25 gal).
// The owner converts existing fluid parts once (e.g. "Antifreeze - 55 Gallon" drums → gallons): quantity, reservations,
// reorder levels and prices are converted together so nothing is lost or double-counted.
import { packSize } from './part_matching.mjs';

export const FLUID_UNITS = Object.freeze({ gal: 1, qt: 0.25 });
export const FLUID_RE = /\b(anti-?freeze|coolant|motor oil|engine oil|oil\b.*\b(15w|10w|5w|0w|sae|synthetic|diesel)|(15w|10w|5w|0w)-?\d{2}|\bdef\b|diesel exhaust fluid|\batf\b|transmission fluid|trans fluid|hydraulic|gear (oil|lube)|80w|75w|85w|90w|140w|power steering fluid|brake fluid|dot ?[345]\b|washer fluid|windshield fluid|wiper fluid|fluid)\b/i;
const NOT_FLUID = /\b(filter|cap|seal|gasket|pump|tank|hose|fitting|sensor|gauge|dipstick|funnel|drain plug|absorbent|pad|pan|cooler|reservoir|grease)\b/i;
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

export function registerFluidRoutes(app, { auth, managerPermission, requireDb, audit }) {
  const perm = managerPermission('inventory');
  app.get('/api/parts/fluids', auth, perm, async (req, res, next) => {
    try {
      const r = await requireDb().query(`SELECT id,part_number,internal_barcode,description,category,uom,quantity,allocated,cost,price,reorder_point FROM fullbay_import_parts
        WHERE coalesce(status,'Active')<>'Inactive' ORDER BY description NULLS LAST LIMIT 5000`);
      const q = String(req.query.q || '').trim().toLowerCase();
      // q: find any other part by name to switch (fluids the keyword list did not recognise).
      const fluids = r.rows.filter(p => isGallonUom(p.uom) || (q ? `${p.description || ''} ${p.part_number || ''}`.toLowerCase().includes(q) : looksLikeFluid(p)));
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
      }
      if (sf && woParts) await db.query("UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by=$2 WHERE state_key='shopflow'", [JSON.stringify(sf), req.user.username]);
      await db.query('COMMIT');
      await audit(req.user.username, 'fluids_converted_to_gallons', { items, converted, woParts, invLines });
      res.json({ ok: true, converted, workOrderParts: woParts, invoiceLines: invLines });
    } catch (e) { try { await db.query('ROLLBACK'); } catch (_) {} next(e); } finally { db.release(); }
  });
}
