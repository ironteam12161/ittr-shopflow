// v24.55.0: purchase orders: what the shop ordered from a vendor, so arriving parts can be checked against it.
// Draft → Ordered (emailed or marked) → Partly received → Received (or Cancelled). Receiving puts stock-linked lines
// on the shelf with the same cost rules as a manual receive (average cost, purchase history). The vendor's bill is
// then created in Bills from the PO, already filled in, so receiving and paying stay two separate, clear steps.
const str = (v, n) => String(v ?? '').replace(/[<>]/g, '').trim().slice(0, n);
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = v => Math.round(num(v) * 100) / 100;
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const PO_STATUSES = ['draft', 'ordered', 'partial', 'received', 'cancelled'];

export async function ensurePurchaseOrderSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS purchase_orders(
    id BIGSERIAL PRIMARY KEY, po_number TEXT UNIQUE NOT NULL, vendor TEXT NOT NULL, vendor_email TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ordered','partial','received','cancelled')),
    work_order_id TEXT, expected_date DATE, notes TEXT, total NUMERIC NOT NULL DEFAULT 0,
    ordered_at TIMESTAMPTZ, received_at TIMESTAMPTZ, created_by TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS purchase_order_lines(
    id BIGSERIAL PRIMARY KEY, po_id BIGINT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE, sort_order INTEGER DEFAULT 0,
    inventory_part_id BIGINT, part_number TEXT, description TEXT NOT NULL, qty_ordered NUMERIC NOT NULL CHECK(qty_ordered>0),
    qty_received NUMERIC NOT NULL DEFAULT 0, unit_cost NUMERIC NOT NULL DEFAULT 0, line_total NUMERIC NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS idx_po_lines ON purchase_order_lines(po_id,sort_order,id);
  CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status,created_at DESC);`);
}
async function nextPoNumber(db) {
  const y = new Date().getFullYear(), r = await db.query(`SELECT max(substring(po_number from '([0-9]+)$')::int) n FROM purchase_orders WHERE po_number LIKE $1`, [`PO-${y}-%`]);
  return `PO-${y}-${String(Number(r.rows[0]?.n || 0) + 1).padStart(5, '0')}`;
}
async function cleanLines(db, lines) {
  const out = [];
  for (const l of (Array.isArray(lines) ? lines : []).slice(0, 200)) {
    const qty = Math.min(1e6, Math.max(0, num(l?.qty ?? l?.quantity))); if (!qty) continue;
    let partId = Number(l?.inventoryPartId) > 0 ? Number(l.inventoryPartId) : null, pn = str(l?.partNumber, 120), desc = str(l?.description, 500);
    if (!partId && pn) { const m = (await db.query(`SELECT id FROM fullbay_import_parts WHERE lower(part_number)=lower($1) AND coalesce(status,'Active')<>'Inactive' LIMIT 2`, [pn])).rows; if (m.length === 1) partId = Number(m[0].id); }
    if (partId && (!desc || !pn)) { const p = (await db.query('SELECT part_number,description FROM fullbay_import_parts WHERE id=$1', [partId])).rows[0]; if (p) { pn = pn || p.part_number || ''; desc = desc || p.description || ''; } }
    if (!desc && !pn) continue;
    const cost = Math.min(1e7, Math.max(0, num(l?.unitCost)));
    out.push({ partId, pn, desc: desc || pn, qty, cost, total: money(qty * cost) });
  }
  return out;
}
async function writeLines(db, poId, lines) {
  await db.query('DELETE FROM purchase_order_lines WHERE po_id=$1', [poId]);
  let i = 0; for (const l of lines) await db.query(`INSERT INTO purchase_order_lines(po_id,sort_order,inventory_part_id,part_number,description,qty_ordered,unit_cost,line_total) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [poId, ++i, l.partId, l.pn, l.desc, l.qty, l.cost, l.total]);
  await db.query('UPDATE purchase_orders SET total=(SELECT coalesce(sum(line_total),0) FROM purchase_order_lines WHERE po_id=$1),updated_at=now() WHERE id=$1', [poId]);
}
async function bundle(db, id) {
  const po = (await db.query('SELECT * FROM purchase_orders WHERE id=$1::bigint', [id])).rows[0]; if (!po) return null;
  const lines = (await db.query(`SELECT l.*,p.quantity on_hand FROM purchase_order_lines l LEFT JOIN fullbay_import_parts p ON p.id=l.inventory_part_id WHERE l.po_id=$1 ORDER BY l.sort_order,l.id`, [po.id])).rows;
  return { po, lines };
}

export function registerPurchaseOrderRoutes(app, { auth, managerPermission, requireDb, audit, receiveStock, sendShopEmail, shopProfile }) {
  const inv = managerPermission('inventory'), fail = (res, s, error) => res.status(s).json({ error });
  const tx = fn => async (req, res, next) => { const db = await requireDb().connect(); try { await db.query('BEGIN'); const out = await fn(db, req, res); if (res.headersSent) { await db.query('ROLLBACK'); return; } await db.query('COMMIT'); res.json(out); } catch (e) { try { await db.query('ROLLBACK'); } catch (_) {} next(e); } finally { db.release(); } };
  app.get('/api/purchase-orders', auth, inv, async (req, res, next) => { try {
    const st = PO_STATUSES.includes(String(req.query.status)) ? String(req.query.status) : '', q = str(req.query.q, 80);
    const r = await requireDb().query(`SELECT o.*,(SELECT count(*)::int FROM purchase_order_lines l WHERE l.po_id=o.id) line_count,
        (SELECT coalesce(sum(qty_received),0) FROM purchase_order_lines l WHERE l.po_id=o.id) qty_received,(SELECT coalesce(sum(qty_ordered),0) FROM purchase_order_lines l WHERE l.po_id=o.id) qty_ordered
      FROM purchase_orders o WHERE ($1='' OR o.status=$1) AND ($1<>'' OR o.status NOT IN ('received','cancelled') OR o.updated_at>now()-interval '60 days')
        AND ($2='' OR o.po_number ILIKE '%'||$2||'%' OR o.vendor ILIKE '%'||$2||'%' OR EXISTS(SELECT 1 FROM purchase_order_lines l WHERE l.po_id=o.id AND (l.part_number ILIKE '%'||$2||'%' OR l.description ILIKE '%'||$2||'%')))
      ORDER BY CASE o.status WHEN 'ordered' THEN 0 WHEN 'partial' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,o.created_at DESC LIMIT 300`, [st, q]);
    res.json({ items: r.rows });
  } catch (e) { next(e); } });
  // Parts at or below their reorder point, for "Add low-stock parts". Filtered to one vendor when given.
  app.get('/api/purchase-orders/suggestions', auth, inv, async (req, res, next) => { try {
    const v = str(req.query.vendor, 120);
    const r = await requireDb().query(`SELECT p.id,p.part_number,p.description,p.quantity,coalesce(p.reorder_point,p.min_qty) reorder_at,p.max_qty,p.vendor,coalesce(p.last_purchase_cost,p.cost,0) unit_cost,
        (SELECT coalesce(sum(l.qty_ordered-l.qty_received),0) FROM purchase_order_lines l JOIN purchase_orders o ON o.id=l.po_id WHERE l.inventory_part_id=p.id AND o.status IN ('ordered','partial','draft')) on_order
      FROM fullbay_import_parts p WHERE coalesce(p.status,'Active')<>'Inactive' AND coalesce(p.reorder_point,p.min_qty) IS NOT NULL AND p.quantity<=coalesce(p.reorder_point,p.min_qty)
        AND ($1='' OR lower(coalesce(p.vendor,''))=lower($1)) ORDER BY p.vendor NULLS LAST,p.part_number LIMIT 300`, [v]);
    res.json({ items: r.rows.map(p => { const target = num(p.max_qty) > 0 ? num(p.max_qty) : num(p.reorder_at) * 2 || 1, need = Math.max(0, target - num(p.quantity) - num(p.on_order));
      return { inventoryPartId: Number(p.id), partNumber: p.part_number || '', description: p.description || '', onHand: num(p.quantity), reorderAt: num(p.reorder_at), onOrder: num(p.on_order), vendor: p.vendor || '', unitCost: money(p.unit_cost), suggestQty: Math.ceil(need) }; }).filter(p => p.suggestQty > 0) });
  } catch (e) { next(e); } });
  // v24.70.0: Repair Board — trucks waiting on ordered parts. Office accounts only; the PO number and vendor are shown only
  // with the Parts & inventory permission, otherwise just that parts are on order and when they are due.
  app.get('/api/purchase-orders/open-by-work-order', auth, async (req, res, next) => { try {
    if (!['admin', 'manager'].includes(req.user?.role)) return fail(res, 403, 'Manager access required.');
    const full = req.user.role === 'admin' || req.user.permissions?.inventory === true;
    const r = await requireDb().query(`SELECT o.work_order_id,o.po_number,o.vendor,o.status,o.expected_date,
        (SELECT coalesce(sum(greatest(l.qty_ordered-l.qty_received,0)),0) FROM purchase_order_lines l WHERE l.po_id=o.id) qty_open
      FROM purchase_orders o WHERE o.status IN ('ordered','partial') AND coalesce(o.work_order_id,'')<>'' ORDER BY o.expected_date NULLS LAST,o.id LIMIT 500`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ items: r.rows.filter(x => Number(x.qty_open) > 0).map(x => ({ workOrderId: String(x.work_order_id), status: x.status, expectedDate: x.expected_date, qtyOpen: Number(x.qty_open), ...(full ? { poNumber: x.po_number, vendor: x.vendor } : {}) })) });
  } catch (e) { next(e); } });
  app.get('/api/purchase-orders/:id', auth, inv, async (req, res, next) => { try { const b = await bundle(requireDb(), req.params.id); if (!b) return fail(res, 404, 'Purchase order not found.'); res.json(b); } catch (e) { next(e); } });
  app.post('/api/purchase-orders', auth, inv, tx(async (db, req, res) => {
    const vendor = str(req.body?.vendor, 160); if (!vendor) return fail(res, 400, 'Choose the vendor.');
    const lines = await cleanLines(db, req.body?.lines); if (!lines.length) return fail(res, 400, 'Add at least one part with a quantity.');
    const num_ = await nextPoNumber(db);
    const po = (await db.query(`INSERT INTO purchase_orders(po_number,vendor,vendor_email,work_order_id,expected_date,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [num_, vendor, str(req.body?.vendorEmail, 200) || null, str(req.body?.workOrderId, 40) || null, /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.expectedDate || '')) ? req.body.expectedDate : null, str(req.body?.notes, 2000) || null, req.user.username])).rows[0];
    await writeLines(db, po.id, lines); await audit(req.user.username, 'purchase_order_created', { id: po.id, poNumber: num_, vendor, lines: lines.length });
    return { ok: true, id: Number(po.id), poNumber: num_ };
  }));
  app.put('/api/purchase-orders/:id', auth, inv, tx(async (db, req, res) => {
    const po = (await db.query('SELECT * FROM purchase_orders WHERE id=$1::bigint FOR UPDATE', [req.params.id])).rows[0]; if (!po) return fail(res, 404, 'Purchase order not found.');
    if (['received', 'cancelled'].includes(po.status)) return fail(res, 409, `This purchase order is ${po.status}.`);
    const anyReceived = Number((await db.query('SELECT coalesce(sum(qty_received),0) n FROM purchase_order_lines WHERE po_id=$1', [po.id])).rows[0].n) > 0;
    await db.query(`UPDATE purchase_orders SET vendor=coalesce(nullif($2,''),vendor),vendor_email=$3,work_order_id=$4,expected_date=$5,notes=$6,updated_at=now() WHERE id=$1`,
      [po.id, str(req.body?.vendor, 160), str(req.body?.vendorEmail, 200) || null, str(req.body?.workOrderId, 40) || null, /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.expectedDate || '')) ? req.body.expectedDate : null, str(req.body?.notes, 2000) || null]);
    if (Array.isArray(req.body?.lines)) { if (anyReceived) return fail(res, 409, 'Parts were already received on this order, so its lines are locked. Start a new purchase order for more parts.');
      const lines = await cleanLines(db, req.body.lines); if (!lines.length) return fail(res, 400, 'Add at least one part with a quantity.'); await writeLines(db, po.id, lines); }
    await audit(req.user.username, 'purchase_order_updated', { id: po.id }); return { ok: true };
  }));
  app.post('/api/purchase-orders/:id/status', auth, inv, tx(async (db, req, res) => {
    const to = String(req.body?.status || ''), po = (await db.query('SELECT * FROM purchase_orders WHERE id=$1::bigint FOR UPDATE', [req.params.id])).rows[0];
    if (!po) return fail(res, 404, 'Purchase order not found.');
    const received = Number((await db.query('SELECT coalesce(sum(qty_received),0) n FROM purchase_order_lines WHERE po_id=$1', [po.id])).rows[0].n);
    if (to === 'ordered' && ['draft'].includes(po.status)) await db.query(`UPDATE purchase_orders SET status='ordered',ordered_at=now(),updated_at=now() WHERE id=$1`, [po.id]);
    else if (to === 'cancelled' && !received && ['draft', 'ordered'].includes(po.status)) await db.query(`UPDATE purchase_orders SET status='cancelled',updated_at=now() WHERE id=$1`, [po.id]);
    else if (to === 'draft' && po.status === 'ordered' && !received) await db.query(`UPDATE purchase_orders SET status='draft',ordered_at=NULL,updated_at=now() WHERE id=$1`, [po.id]);
    else if (to === 'received' && po.status === 'partial') await db.query(`UPDATE purchase_orders SET status='received',received_at=now(),updated_at=now() WHERE id=$1`, [po.id]); // close short: the rest won't come
    else return fail(res, 409, received && to === 'cancelled' ? 'Parts were already received, so it cannot be cancelled. Use "Close (rest not coming)".' : `Cannot change a ${po.status} order to ${to}.`);
    await audit(req.user.username, 'purchase_order_status', { id: po.id, from: po.status, to }); return { ok: true, status: to };
  }));
  // Receive what arrived. Each line can be partly received; stock-linked lines go on the shelf at the PO cost.
  app.post('/api/purchase-orders/:id/receive', auth, inv, tx(async (db, req, res) => {
    const po = (await db.query('SELECT * FROM purchase_orders WHERE id=$1::bigint FOR UPDATE', [req.params.id])).rows[0]; if (!po) return fail(res, 404, 'Purchase order not found.');
    if (!['ordered', 'partial', 'draft'].includes(po.status)) return fail(res, 409, `This purchase order is ${po.status}.`);
    const lines = (await db.query('SELECT * FROM purchase_order_lines WHERE po_id=$1 FOR UPDATE', [po.id])).rows, byId = new Map(lines.map(l => [String(l.id), l]));
    const reference = str(req.body?.reference, 80), got = [], seen = new Set();
    for (const x of Array.isArray(req.body?.lines) ? req.body.lines : []) {
      const l = byId.get(String(x?.id)), q = Math.max(0, num(x?.qty)); if (!l || !q) continue;
      // v24.72.0: one entry per line. A repeated line was checked against the same "still due" twice and could put more
      // on the shelf than was ordered; the whole receipt is refused (rolled back) instead.
      if (seen.has(String(l.id))) return fail(res, 400, `${l.part_number || l.description}: this line is listed twice in one receipt.`);
      seen.add(String(l.id));
      const left = num(l.qty_ordered) - num(l.qty_received); if (q > left + 1e-9) return fail(res, 400, `${l.part_number || l.description}: only ${left} still due on this order.`);
      l.qty_received = num(l.qty_received) + q;
      if (l.inventory_part_id) await receiveStock(db, { partId: l.inventory_part_id, qty: q, unitCost: num(l.unit_cost), vendor: po.vendor, reference: reference || po.po_number, username: req.user.username, note: `Received on ${po.po_number}` });
      const upd = await db.query('UPDATE purchase_order_lines SET qty_received=qty_received+$2 WHERE id=$1 AND qty_received+$2<=qty_ordered+0.000001', [l.id, q]);
      if (!upd.rowCount) return fail(res, 409, `${l.part_number || l.description}: more than ordered would be received. Refresh the order and try again.`);
      got.push({ id: Number(l.id), qty: q, stocked: Boolean(l.inventory_part_id) });
    }
    if (!got.length) return fail(res, 400, 'Enter how many arrived for at least one line.');
    const open = Number((await db.query('SELECT count(*)::int n FROM purchase_order_lines WHERE po_id=$1 AND qty_received<qty_ordered', [po.id])).rows[0].n);
    const status = open ? 'partial' : 'received';
    await db.query(`UPDATE purchase_orders SET status=$2,ordered_at=coalesce(ordered_at,now()),received_at=CASE WHEN $2='received' THEN now() ELSE received_at END,updated_at=now() WHERE id=$1`, [po.id, status]);
    await audit(req.user.username, 'purchase_order_received', { id: po.id, poNumber: po.po_number, lines: got, reference });
    return { ok: true, status, received: got };
  }));
  app.post('/api/purchase-orders/:id/email', auth, inv, async (req, res, next) => { try {
    const db = requireDb(), b = await bundle(db, req.params.id); if (!b) return fail(res, 404, 'Purchase order not found.');
    const to = String(req.body?.to || b.po.vendor_email || '').trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return fail(res, 400, 'Enter the vendor\'s email address.');
    const shop = shopProfile(), po = b.po;
    const rows = b.lines.map(l => `<tr><td style="padding:6px;border-bottom:1px solid #e4e7ec">${escHtml(l.part_number || '')}</td><td style="padding:6px;border-bottom:1px solid #e4e7ec">${escHtml(l.description)}</td><td style="padding:6px;border-bottom:1px solid #e4e7ec;text-align:right">${num(l.qty_ordered)}</td></tr>`).join('');
    const note = str(req.body?.message, 2000);
    const html = `<div style="font-family:Arial,sans-serif;color:#101828;max-width:640px"><h2 style="margin:0 0 4px">Purchase order ${escHtml(po.po_number)}</h2><div style="color:#475467;margin-bottom:12px">${escHtml(shop.name)} · ${escHtml(shop.phone)}<br>${escHtml(shop.address1)}, ${escHtml(shop.address2)}</div>
      ${note ? `<p>${escHtml(note)}</p>` : ''}<table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr><th style="text-align:left;padding:6px;border-bottom:2px solid #101828">Part #</th><th style="text-align:left;padding:6px;border-bottom:2px solid #101828">Description</th><th style="text-align:right;padding:6px;border-bottom:2px solid #101828">Qty</th></tr></thead><tbody>${rows}</tbody></table>
      ${po.expected_date ? `<p>Needed by: <b>${escHtml(String(po.expected_date).slice(0, 10))}</b></p>` : ''}<p>Please put <b>${escHtml(po.po_number)}</b> on your invoice. Thank you.</p></div>`;
    const text = `Purchase order ${po.po_number} from ${shop.name}\n${note ? `${note}\n` : ''}\n${b.lines.map(l => `${l.part_number || '-'}  ${l.description}  x${num(l.qty_ordered)}`).join('\n')}\n\nPlease put ${po.po_number} on your invoice.`;
    const r = await sendShopEmail({ to: [to], subject: `Purchase order ${po.po_number} from ${shop.name}`, text, html, replyTo: shop.email || '', idempotencyKey: `po-${po.id}-${Date.now()}`, tags: [{ name: 'document', value: 'purchase_order' }] });
    if (!r.ok) return fail(res, 502, r.error || 'The email was not sent.');
    await db.query(`UPDATE purchase_orders SET vendor_email=$2,status=CASE WHEN status='draft' THEN 'ordered' ELSE status END,ordered_at=coalesce(ordered_at,now()),updated_at=now() WHERE id=$1`, [po.id, to]);
    await audit(req.user.username, 'purchase_order_emailed', { id: po.id, to }); res.json({ ok: true });
  } catch (e) { next(e); } });
}
