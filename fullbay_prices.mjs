// v24.60.0: Fullbay sell prices. Fullbay's inventory export has two price columns: "Selling Price" is only filled when
// someone typed an override ("Override Calculated Selling Price" = Yes); every other part sells at its
// "Calculated Selling Price" (cost + Fullbay's markup). The first import read only "Selling Price", so most parts
// came in at $0. This compares our prices with Fullbay's (from the row kept at import, or an uploaded export) and
// fills the parts that have no price. A price someone set in ShopFlow is never overwritten.
import { isGallonUom } from './fluids.mjs';

const money = v => { const n = Number(String(v ?? '').replace(/^="?|"$/g, '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const field = (row, name) => { const k = Object.keys(row || {}).find(x => norm(x) === norm(name)); return k ? String(row[k] ?? '').replace(/^="?|"$/g, '').trim() : ''; };

// The price Fullbay sells a part at, from one export row (or the raw row kept at import).
export function fullbaySellPrice(row) {
  const override = /^y(es)?$/i.test(field(row, 'Override Calculated Selling Price'));
  const sell = money(field(row, 'Selling Price')), calc = money(field(row, 'Calculated Selling Price'));
  if (override && sell > 0) return sell;
  if (calc > 0) return calc;
  return sell > 0 ? sell : null;
}

export function registerFullbayPriceRoutes(app, { auth, managerPermission, requireDb, audit, csvUpload, csvObjects }) {
  const run = async (req, res, next) => {
    try {
      const db = requireDb(), apply = String(req.body?.apply || req.query.apply || '') === '1';
      const fromFile = !!req.file;
      const fileRows = fromFile ? csvObjects(req.file.buffer) : [];
      if (fromFile && !fileRows.length) return res.status(400).json({ error: 'No data rows found in this CSV.' });
      const parts = (await db.query(`SELECT id,part_number,description,uom,price,cost,quantity,raw FROM fullbay_import_parts WHERE coalesce(status,'Active')<>'Inactive'`)).rows;
      // Parts switched to gallons sell per gallon; Fullbay's price is per old unit (drum, case…).
      const conv = new Map((await db.query(`SELECT DISTINCT ON (part_id) part_id,metadata FROM part_inventory_transactions WHERE transaction_type='unit_change' ORDER BY part_id,id DESC`)).rows
        .filter(r => !r.metadata?.reverted && Number(r.metadata?.gallonsPerOldUnit) > 0).map(r => [Number(r.part_id), Number(r.metadata.gallonsPerOldUnit)]));
      // Exact part # first ("BW K073073" and "BW  K073073" are two parts in Fullbay); spacing/punctuation only as a fallback.
      const exact = new Map(), loose = new Map(), add = (m, k, p) => { if (k) (m.get(k) || m.set(k, []).get(k)).push(p); };
      for (const p of parts) { add(exact, String(p.part_number || '').trim().toLowerCase(), p); add(loose, norm(p.part_number), p); }
      const pairs = [];
      if (fromFile) {
        for (const row of fileRows) {
          const pn = field(row, 'Part #'), price = fullbaySellPrice(row);
          if (!pn || price == null) continue;
          const list = exact.get(pn.toLowerCase()) || (loose.get(norm(pn))?.length === 1 ? loose.get(norm(pn)) : null);
          if (!list) { pairs.push({ partNumber: pn, description: field(row, 'Description'), fullbay: price, part: null }); continue; }
          for (const p of list) pairs.push({ partNumber: pn, description: field(row, 'Description'), fullbay: price, part: p });
        }
      } else {
        for (const p of parts) { const price = p.raw && typeof p.raw === 'object' ? fullbaySellPrice(p.raw) : null; if (price != null) pairs.push({ partNumber: p.part_number, description: p.description, fullbay: price, part: p }); }
      }
      const out = { source: fromFile ? 'file' : 'import', checked: pairs.length, matched: 0, missing: [], different: [], notFound: [], applied: 0 };
      for (const x of pairs) {
        if (!x.part) { out.notFound.push({ partNumber: x.partNumber, description: x.description, fullbay: x.fullbay }); continue; }
        const g = isGallonUom(x.part.uom) ? (conv.get(Number(x.part.id)) || 1) : 1;
        const expected = Math.round(x.fullbay / g * 100) / 100, ours = Number(x.part.price || 0);
        const item = { id: Number(x.part.id), partNumber: x.part.part_number, description: x.part.description, uom: x.part.uom, ours, fullbay: expected, inStock: Number(x.part.quantity || 0) };
        if (ours <= 0) out.missing.push(item);
        else if (Math.abs(ours - expected) >= 0.01) out.different.push(item);
        else out.matched++;
      }
      if (apply && out.missing.length) {
        const ids = out.missing.map(m => m.id), prices = out.missing.map(m => m.fullbay);
        const r = await db.query(`UPDATE fullbay_import_parts p SET price=v.price,updated_at=now() FROM unnest($1::bigint[],$2::numeric[]) v(id,price)
          WHERE p.id=v.id AND coalesce(p.price,0)<=0 RETURNING p.id`, [ids, prices]);
        out.applied = r.rowCount; out.matched += r.rowCount; const done = new Set(r.rows.map(x => Number(x.id)));
        out.missing = out.missing.filter(m => !done.has(m.id));
        await audit(req.user.username, 'parts_prices_from_fullbay', { source: out.source, file: req.file?.originalname || null, applied: r.rowCount, sample: out.missing.slice(0, 50).map(m => ({ id: m.id, price: m.fullbay })) });
      }
      out.missingCount = out.missing.length; out.differentCount = out.different.length; out.notFoundCount = out.notFound.length;
      out.missing.sort((a, b) => b.inStock - a.inStock); out.different.sort((a, b) => Math.abs(b.ours - b.fullbay) - Math.abs(a.ours - a.fullbay));
      out.missing = out.missing.slice(0, 300); out.different = out.different.slice(0, 300); out.notFound = out.notFound.slice(0, 100);
      res.json(out);
    } catch (e) { next(e); }
  };
  app.post('/api/parts/fullbay-prices', auth, managerPermission('inventory'), csvUpload.single('file'), run);
}
