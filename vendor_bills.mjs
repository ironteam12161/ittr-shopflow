// ITTR ShopFlow v24.42.0: vendor bills, separated and analysed by vendor.
// Vendor invoices come from Smart Receiving (parts received into stock), from uploads scanned by AI ("filed", for
// bookkeeping only) and from vendor-bill emails in Gmail. The analysis groups them by vendor and flags price increases,
// parts bought cheaper at another vendor, invoice math that doesn't add up, possible duplicate bills, unpaid bills
// past due and cores past due.

const money = v => Math.round((Number(v) || 0) * 100) / 100;
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const day = v => { if (!v) return null; if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10); const s = String(v); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };
export const vendorKey = v => String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\.(com|net|org|us|co)(\/.*)?$/, '').replace(/[^a-z0-9]+/g, ' ').replace(/\b(inc|llc|ltd|corp|corporation|company|co)\b/g, ' ').replace(/\s+/g, '');
export const normPart = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const normInvoiceNo = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^(inv|invoice|no)+/, '').replace(/^0+/, '');

export async function ensureVendorBillSchema(pool) {
  await pool.query(`
  ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS due_date DATE;
  ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
  ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS paid_reference TEXT;
  ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS paid_by TEXT;
  ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS gmail_message_id BIGINT;
  ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS file_key TEXT;
  ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS file_mime TEXT;
  ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS notes TEXT;
  CREATE INDEX IF NOT EXISTS idx_parts_vendor_invoices_vendor ON parts_vendor_invoices(lower(coalesce(vendor,'')),invoice_date DESC);`);
}

// Problems with the numbers printed on one bill. Tolerance: $1 or 1%, so rounding on the bill is not flagged.
export function checkInvoiceMath(inv, lines = []) {
  const out = [], tol = x => Math.max(1, Math.abs(x) * 0.01);
  const sub = num(inv.subtotal), tax = num(inv.tax), freight = num(inv.freight), total = num(inv.total);
  const ls = lines.filter(l => num(l.quantity) || num(l.unit_cost ?? l.unitCost) || num(l.line_total ?? l.lineTotal));
  if (ls.length && sub > 0) {
    const sumLines = money(ls.reduce((a, l) => a + (num(l.line_total ?? l.lineTotal) || num(l.quantity) * num(l.unit_cost ?? l.unitCost)), 0));
    if (Math.abs(sumLines - sub) > tol(sub)) out.push({ code: 'LINES_NE_SUBTOTAL', message: `Lines add up to $${sumLines.toFixed(2)} but the subtotal says $${sub.toFixed(2)}.`, diff: money(sumLines - sub) });
  }
  if (total > 0 && (sub > 0 || tax > 0 || freight > 0)) {
    const calc = money(sub + tax + freight);
    if (Math.abs(calc - total) > tol(total)) out.push({ code: 'TOTAL_MISMATCH', message: `Subtotal + tax + freight = $${calc.toFixed(2)} but the total says $${total.toFixed(2)}.`, diff: money(total - calc) });
  }
  ls.forEach((l, i) => {
    const q = num(l.quantity), u = num(l.unit_cost ?? l.unitCost), lt = num(l.line_total ?? l.lineTotal);
    if (q > 0 && u > 0 && lt > 0 && Math.abs(q * u - lt) > Math.max(1, lt * 0.02)) out.push({ code: 'LINE_MATH', line: i + 1, message: `Line ${i + 1} (${str(l.vendor_part_number ?? l.partNumber, 40) || str(l.description, 40)}): ${q} × $${u.toFixed(2)} = $${money(q * u).toFixed(2)}, but the line total says $${lt.toFixed(2)}.`, diff: money(lt - q * u) });
  });
  return out;
}

// invoices: [{id,vendor,invoice_number,invoice_date,due_date,total,subtotal,tax,freight,status,paid_at}]
// lines: [{invoice_id,vendor_part_number,description,quantity,unit_cost,line_total}] (may cover a longer period than the range, for price history)
// cores: [{vendor,open_quantity,open_amount,due_date}]
export function analyzeVendors({ invoices = [], lines = [], cores = [], from, to, today = new Date().toISOString().slice(0, 10) }) {
  // Bills from Smart Receiving before v24.42.0 never recorded payment; they count as owed only once they have a due date.
  const tracksPayment = i => !!i.due_date || String(i.status || '') === 'filed';
  const inRange = d => d && (!from || d >= from) && (!to || d <= to);
  const invById = new Map(invoices.map(i => [String(i.id), { ...i, date: day(i.invoice_date) || day(i.received_at) || day(i.created_at) }]));
  const live = [...invById.values()].filter(i => String(i.status || '') !== 'void');
  const ranged = live.filter(i => inRange(i.date));
  const names = new Map();
  for (const i of invById.values()) { const k = vendorKey(i.vendor) || 'unknown'; const m = names.get(k) || new Map(); const n = String(i.vendor || '').trim() || 'Unknown vendor'; m.set(n, (m.get(n) || 0) + 1); names.set(k, m); }
  const vkey = v => { const m = names.get(vendorKey(v) || 'unknown'); return m ? [...m].sort((a, b) => b[1] - a[1])[0][0] : (String(v || '').trim() || 'Unknown vendor'); };
  const vendors = new Map();
  const V = name => { const k = vkey(name).toLowerCase(); if (!vendors.has(k)) vendors.set(k, { vendor: vkey(name), bills: 0, total: 0, subtotal: 0, tax: 0, freight: 0, firstBill: null, lastBill: null, unpaidBills: 0, unpaid: 0, overdue: 0, coresOwed: 0, coresValue: 0, byMonth: {}, parts: new Map() }); return vendors.get(k); };
  for (const i of ranged) {
    const v = V(i.vendor); v.bills++; v.total += num(i.total); v.subtotal += num(i.subtotal); v.tax += num(i.tax); v.freight += num(i.freight);
    if (!v.firstBill || i.date < v.firstBill) v.firstBill = i.date; if (!v.lastBill || i.date > v.lastBill) v.lastBill = i.date;
    const m = i.date.slice(0, 7); v.byMonth[m] = money((v.byMonth[m] || 0) + num(i.total));
  }
  // Unpaid is about today, not the range: every unpaid bill counts.
  for (const i of live) if (tracksPayment(i) && !i.paid_at && num(i.total) > 0) { const v = V(i.vendor); v.unpaidBills++; v.unpaid += num(i.total); const due = day(i.due_date); if (due && due < today) v.overdue += num(i.total); }
  for (const c of cores) { const v = V(c.vendor); v.coresOwed += num(c.open_quantity); v.coresValue += num(c.open_amount); }

  // Line history per vendor+part, oldest first.
  const hist = new Map(), byPart = new Map();
  for (const l of lines) {
    const inv = invById.get(String(l.invoice_id)); if (!inv || String(inv.status || '') === 'void') continue;
    const pk = normPart(l.vendor_part_number); const cost = num(l.unit_cost) || (num(l.quantity) ? num(l.line_total) / num(l.quantity) : 0);
    const rec = { vendor: vkey(inv.vendor), partNumber: str(l.vendor_part_number, 60), description: str(l.description, 120), qty: num(l.quantity), cost: money(cost), date: inv.date, invoiceId: inv.id, invoiceNumber: inv.invoice_number || '' };
    if (inRange(inv.date)) { const v = V(inv.vendor), key = pk || `d:${rec.description.toLowerCase()}`; const p = v.parts.get(key) || { partNumber: rec.partNumber, description: rec.description, qty: 0, spend: 0, lastCost: 0, lastDate: '' }; p.qty += rec.qty; p.spend += num(l.line_total) || rec.qty * rec.cost; if (rec.date >= p.lastDate) { p.lastCost = rec.cost; p.lastDate = rec.date; } v.parts.set(key, p); }
    if (!pk || pk.length < 3 || rec.cost <= 0) continue;
    const hk = `${rec.vendor.toLowerCase()}|${pk}`; (hist.get(hk) || hist.set(hk, []).get(hk)).push(rec);
    (byPart.get(pk) || byPart.set(pk, []).get(pk)).push(rec);
  }
  const priceIncreases = [];
  for (const list of hist.values()) {
    list.sort((a, b) => (a.date || '').localeCompare(b.date || '') || num(a.invoiceId) - num(b.invoiceId));
    for (let k = 1; k < list.length; k++) {
      const prev = list[k - 1], cur = list[k];
      if (!inRange(cur.date) || cur.cost <= prev.cost * 1.05 || cur.cost - prev.cost < 0.5) continue;
      priceIncreases.push({ vendor: cur.vendor, partNumber: cur.partNumber, description: cur.description, oldCost: prev.cost, newCost: cur.cost, pct: Math.round((cur.cost / prev.cost - 1) * 1000) / 10, oldDate: prev.date, newDate: cur.date, invoiceId: cur.invoiceId, invoiceNumber: cur.invoiceNumber, qty: cur.qty, extra: money((cur.cost - prev.cost) * cur.qty) });
    }
  }
  priceIncreases.sort((a, b) => b.extra - a.extra || b.pct - a.pct);
  // The same part bought at another vendor for less in the 180 days before.
  const cheaperElsewhere = [], seen = new Set();
  for (const list of byPart.values()) {
    if (new Set(list.map(r => r.vendor.toLowerCase())).size < 2) continue;
    const sorted = [...list].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    for (const cur of sorted) {
      if (!inRange(cur.date)) continue;
      const k = `${cur.vendor.toLowerCase()}|${normPart(cur.partNumber)}`; if (seen.has(k)) continue; seen.add(k);
      const limit = new Date(new Date(`${cur.date}T00:00:00Z`).getTime() - 180 * 864e5).toISOString().slice(0, 10);
      const others = sorted.filter(r => r.vendor.toLowerCase() !== cur.vendor.toLowerCase() && r.date >= limit && r.date <= cur.date);
      const best = others.sort((a, b) => a.cost - b.cost)[0];
      if (best && best.cost < cur.cost * 0.95 && cur.cost - best.cost >= 0.5) cheaperElsewhere.push({ partNumber: cur.partNumber, description: cur.description, vendor: cur.vendor, cost: cur.cost, date: cur.date, invoiceId: cur.invoiceId, invoiceNumber: cur.invoiceNumber, qty: cur.qty, cheaperVendor: best.vendor, cheaperCost: best.cost, cheaperDate: best.date, savings: money((cur.cost - best.cost) * cur.qty) });
    }
  }
  cheaperElsewhere.sort((a, b) => b.savings - a.savings);
  // Math on each bill in the range.
  const linesByInv = new Map(); for (const l of lines) (linesByInv.get(String(l.invoice_id)) || linesByInv.set(String(l.invoice_id), []).get(String(l.invoice_id))).push(l);
  const mathProblems = [];
  for (const i of ranged) { const p = checkInvoiceMath(i, linesByInv.get(String(i.id)) || []); if (p.length) mathProblems.push({ invoiceId: i.id, vendor: vkey(i.vendor), invoiceNumber: i.invoice_number || '', date: i.date, total: money(i.total), problems: p }); }
  // Possible duplicates: same vendor and total within 7 days, or the same invoice number written differently.
  const duplicates = [], byVendor = new Map();
  for (const i of live) (byVendor.get(vkey(i.vendor).toLowerCase()) || byVendor.set(vkey(i.vendor).toLowerCase(), []).get(vkey(i.vendor).toLowerCase())).push(i);
  for (const list of byVendor.values()) for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
    const x = list[a], y = list[b]; if (!inRange(x.date) && !inRange(y.date)) continue;
    const sameNo = normInvoiceNo(x.invoice_number) && normInvoiceNo(x.invoice_number) === normInvoiceNo(y.invoice_number);
    const days = x.date && y.date ? Math.abs(new Date(x.date) - new Date(y.date)) / 864e5 : 99;
    const sameAmt = num(x.total) > 0 && Math.abs(num(x.total) - num(y.total)) < 0.01 && days <= 7;
    if (sameNo || sameAmt) duplicates.push({ vendor: vkey(x.vendor), reason: sameNo ? 'Same invoice number' : `Same total within ${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'}`, total: money(x.total), bills: [x, y].map(i => ({ invoiceId: i.id, invoiceNumber: i.invoice_number || '', date: i.date, total: money(i.total), status: i.status })) });
  }
  const unpaidPastDue = live.filter(i => tracksPayment(i) && !i.paid_at && day(i.due_date) && day(i.due_date) < today && num(i.total) > 0)
    .map(i => ({ invoiceId: i.id, vendor: vkey(i.vendor), invoiceNumber: i.invoice_number || '', dueDate: day(i.due_date), total: money(i.total), daysLate: Math.round((new Date(today) - new Date(day(i.due_date))) / 864e5) }))
    .sort((a, b) => b.daysLate - a.daysLate);
  const coresPastDue = cores.filter(c => day(c.due_date) && day(c.due_date) < today).map(c => ({ vendor: vkey(c.vendor), partNumber: c.part_number || '', qty: num(c.open_quantity), value: money(c.open_amount), dueDate: day(c.due_date) }));

  const totalSpend = money([...vendors.values()].reduce((a, v) => a + v.total, 0));
  const list = [...vendors.values()].map(v => ({
    vendor: v.vendor, bills: v.bills, total: money(v.total), subtotal: money(v.subtotal), tax: money(v.tax), freight: money(v.freight), avgBill: v.bills ? money(v.total / v.bills) : 0,
    share: totalSpend ? Math.round(v.total / totalSpend * 1000) / 10 : 0, firstBill: v.firstBill, lastBill: v.lastBill,
    unpaidBills: v.unpaidBills, unpaid: money(v.unpaid), overdue: money(v.overdue), coresOwed: v.coresOwed, coresValue: money(v.coresValue), byMonth: v.byMonth,
    topParts: [...v.parts.values()].sort((a, b) => b.spend - a.spend).slice(0, 10).map(p => ({ ...p, spend: money(p.spend) })),
    priceIncreases: priceIncreases.filter(p => p.vendor.toLowerCase() === v.vendor.toLowerCase()).length,
  })).filter(v => v.bills || v.unpaid || v.coresOwed).sort((a, b) => b.total - a.total || b.unpaid - a.unpaid);
  return {
    totals: { vendors: list.filter(v => v.bills).length, bills: ranged.length, spend: totalSpend, unpaid: money(list.reduce((a, v) => a + v.unpaid, 0)), overdue: money(list.reduce((a, v) => a + v.overdue, 0)), coresValue: money(list.reduce((a, v) => a + v.coresValue, 0)),
      possibleSavings: money(cheaperElsewhere.reduce((a, c) => a + c.savings, 0)), priceIncreaseCost: money(priceIncreases.reduce((a, p) => a + p.extra, 0)) },
    vendors: list,
    alerts: { priceIncreases: priceIncreases.slice(0, 100), cheaperElsewhere: cheaperElsewhere.slice(0, 100), mathProblems: mathProblems.slice(0, 100), duplicates: duplicates.slice(0, 50), unpaidPastDue: unpaidPastDue.slice(0, 100), coresPastDue: coresPastDue.slice(0, 100) },
  };
}

export async function buildVendorAnalysis(db, { from, to }) {
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  // Bills in the range, plus one year before it for price history and duplicates.
  const invoices = await q(`SELECT id,vendor,invoice_number,invoice_date,received_at,created_at,due_date,subtotal,tax,freight,total,status,paid_at FROM parts_vendor_invoices
     WHERE coalesce(invoice_date,received_at::date,created_at::date) BETWEEN ($1::date - interval '365 days') AND $2::date`, [from, to]);
  const ids = invoices.map(i => i.id);
  const lines = ids.length ? await q(`SELECT invoice_id,vendor_part_number,description,quantity,unit_cost,line_total FROM parts_vendor_invoice_lines WHERE invoice_id=ANY($1::bigint[])`, [ids]) : [];
  // Unpaid bills outside the window still count as owed.
  const older = await q(`SELECT id,vendor,invoice_number,invoice_date,received_at,created_at,due_date,subtotal,tax,freight,total,status,paid_at FROM parts_vendor_invoices
     WHERE paid_at IS NULL AND coalesce(status,'')<>'void' AND coalesce(invoice_date,received_at::date,created_at::date) < ($1::date - interval '365 days')`, [from]);
  let cores = [];
  try { cores = await q(`SELECT c.vendor_name_snapshot vendor,p.part_number,c.open_quantity,c.open_amount,c.due_date FROM part_core_obligations c LEFT JOIN fullbay_import_parts p ON p.id=c.part_id WHERE c.status NOT IN ('closed','credited') AND c.open_quantity>0`); } catch (_) {}
  return { from, to, ...analyzeVendors({ invoices: [...invoices, ...older], lines, cores, from, to }) };
}

async function knownVendor(db, resolveVendor, raw, create) {
  const name = str(raw, 160); if (!name) return '';
  const k = vendorKey(name);
  const r = await db.query(`SELECT vendor,count(*)::int n FROM parts_vendor_invoices WHERE vendor IS NOT NULL AND trim(vendor)<>'' GROUP BY vendor ORDER BY 2 DESC LIMIT 500`);
  const hit = r.rows.find(x => vendorKey(x.vendor) === k);
  if (hit) return hit.vendor;
  return (await resolveVendor(db, name, create)) || name;
}

export function cleanVendorDraft(b = {}) {
  const inv = b.invoice || {};
  const d = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : null);
  const lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 300).map(l => ({ partNumber: str(l.partNumber, 80), manufacturer: str(l.manufacturer, 80), description: str(l.description, 300), quantity: num(l.quantity), unitCost: money(l.unitCost), coreCost: money(l.coreCost), lineTotal: money(l.lineTotal || num(l.quantity) * num(l.unitCost)) }))
    .filter(l => l.partNumber || l.description || l.quantity || l.lineTotal);
  return { vendor: str(inv.vendor, 160), invoiceNumber: str(inv.invoiceNumber, 80) || null, invoiceDate: d(inv.invoiceDate), dueDate: d(inv.dueDate), poNumber: str(inv.poNumber, 80) || null,
    subtotal: money(inv.subtotal), tax: money(inv.tax), freight: money(inv.freight), total: money(inv.total), notes: str(inv.notes, 1000) || null, lines };
}

// deps: auth, managerPermission, requireDb, audit, resolveVendor, extractVendorInvoice(file)->parsed, textAI, storeFile, readFile, fetchGmailAttachment, reportRange
export function registerVendorBillRoutes(app, deps) {
  const { auth, requireDb, audit, resolveVendor, extractVendorInvoice, textAI, storeFile, readFile, fetchGmailAttachment, reportRange, upload } = deps;
  // Owner, or a manager allowed to see inventory or reports.
  const perm = (req, res, next) => { const u = req.user; if (u?.role === 'admin') return next(); if (u?.role === 'manager' && (u.permissions?.inventory !== false || u.permissions?.reports !== false)) return next(); return res.status(403).json({ error: 'Manager access required.' }); };
  const wrap = fn => async (req, res, next) => { try { if (req.params?.id != null && !/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Vendor bill not found.' }); const out = await fn(requireDb(), req, res); if (out !== undefined && !res.headersSent) res.json(out); } catch (e) { if (e?.code === 'AI_NOT_CONFIGURED') return res.status(503).json({ error: e.message, code: e.code }); if (e?.code === 'AI_BUDGET_REACHED') return res.status(429).json({ error: e.message, code: e.code }); if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code }); next(e); } };
  const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, code }); };

  async function draftFrom(db, file, extra = {}) {
    const mime = String(file.mimetype || '');
    if (!mime.startsWith('image/') && mime !== 'application/pdf') fail(415, 'Use a PDF or a photo (JPG/PNG/WEBP) of the vendor invoice.');
    const parsed = await extractVendorInvoice(file);
    const lines = (Array.isArray(parsed?.lines) ? parsed.lines : []).map(l => ({ partNumber: str(l.partNumber, 80), manufacturer: str(l.manufacturer, 80), description: str(l.description, 300), quantity: num(l.quantity), unitCost: num(l.unitCost), coreCost: num(l.coreCost), lineTotal: num(l.lineTotal) }));
    const vendor = parsed?.vendor ? await knownVendor(db, resolveVendor, parsed.vendor, false) : '';
    const invoice = { vendor, invoiceNumber: str(parsed?.invoiceNumber, 80), invoiceDate: str(parsed?.invoiceDate, 10), dueDate: str(parsed?.dueDate, 10), poNumber: str(parsed?.poNumber, 80), terms: str(parsed?.terms, 60), subtotal: num(parsed?.subtotal), tax: num(parsed?.tax), freight: num(parsed?.freight), total: num(parsed?.total) };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(invoice.invoiceDate)) invoice.invoiceDate = '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(invoice.dueDate)) invoice.dueDate = '';
    const net = /net\s*(\d{1,3})/i.exec(invoice.terms);
    if (!invoice.dueDate && invoice.invoiceDate && net) invoice.dueDate = new Date(new Date(`${invoice.invoiceDate}T00:00:00Z`).getTime() + Number(net[1]) * 864e5).toISOString().slice(0, 10);
    const dup = invoice.invoiceNumber ? (await db.query(`SELECT id,status FROM parts_vendor_invoices WHERE lower(coalesce(vendor,''))=lower($1) AND lower(coalesce(invoice_number,''))=lower($2) LIMIT 1`, [vendor, invoice.invoiceNumber])).rows[0] : null;
    let fileKey = null;
    if (storeFile) { try { fileKey = await storeFile(`vendor-bills/${Date.now()}-${Math.random().toString(36).slice(2, 10)}${mime === 'application/pdf' ? '.pdf' : '.jpg'}`, file.buffer, mime); } catch (e) { console.warn('[vendor bills] file not stored', e?.message); } }
    return { invoice, lines, mathProblems: checkInvoiceMath(invoice, lines), alreadyFiled: dup ? { id: dup.id, status: dup.status } : null, file: { key: fileKey, mime, name: str(file.originalname, 200) || 'invoice' }, ...extra };
  }

  app.get('/api/vendor-invoices/analysis', auth, perm, wrap(async (db, req) => buildVendorAnalysis(db, reportRange(req.query))));
  app.get('/api/vendor-invoices', auth, perm, wrap(async (db, req) => {
    const { from, to } = reportRange(req.query), vendor = str(req.query.vendor, 160), search = str(req.query.q, 80).toLowerCase();
    const rows = (await db.query(`SELECT i.id,i.vendor,i.invoice_number,coalesce(i.invoice_date,i.received_at::date,i.created_at::date) invoice_date,i.due_date,i.po_number,i.subtotal,i.tax,i.freight,i.total,i.status,i.source_method,i.paid_at,i.paid_reference,i.file_key IS NOT NULL has_file,i.gmail_message_id,
        count(l.id)::int line_count FROM parts_vendor_invoices i LEFT JOIN parts_vendor_invoice_lines l ON l.invoice_id=i.id
      WHERE coalesce(i.invoice_date,i.received_at::date,i.created_at::date) BETWEEN $1::date AND $2::date AND ($3='' OR lower(coalesce(i.vendor,''))=lower($3))
        AND ($4='' OR lower(coalesce(i.invoice_number,'')||' '||coalesce(i.po_number,'')||' '||coalesce(i.vendor,'')) LIKE '%'||$4||'%' OR EXISTS(SELECT 1 FROM parts_vendor_invoice_lines x WHERE x.invoice_id=i.id AND lower(coalesce(x.vendor_part_number,'')||' '||coalesce(x.description,'')) LIKE '%'||$4||'%'))
      GROUP BY i.id ORDER BY 4 DESC,i.id DESC LIMIT 500`, [from, to, vendor, search])).rows;
    return { items: rows.map(r => ({ ...r, invoice_date: day(r.invoice_date), due_date: day(r.due_date), subtotal: money(r.subtotal), tax: money(r.tax), freight: money(r.freight), total: money(r.total) })) };
  }));
  app.get('/api/vendor-invoices/:id', auth, perm, wrap(async (db, req) => {
    const i = (await db.query('SELECT * FROM parts_vendor_invoices WHERE id=$1::bigint', [req.params.id])).rows[0]; if (!i) fail(404, 'Vendor bill not found.');
    const lines = (await db.query('SELECT line_no,vendor_part_number,manufacturer,description,quantity,unit_cost,core_cost,line_total,received_quantity,matched_part_id FROM parts_vendor_invoice_lines WHERE invoice_id=$1 ORDER BY line_no,id', [i.id])).rows;
    const { raw_extract, file_key, ...rest } = i;
    return { invoice: { ...rest, has_file: !!file_key, invoice_date: day(i.invoice_date), due_date: day(i.due_date) }, lines, mathProblems: checkInvoiceMath(i, lines) };
  }));
  app.get('/api/vendor-invoices/:id/file', auth, perm, async (req, res, next) => {
    try {
      if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Vendor bill not found.' });
      const i = (await requireDb().query('SELECT file_key,file_mime,invoice_number FROM parts_vendor_invoices WHERE id=$1::bigint', [req.params.id])).rows[0];
      if (!i?.file_key || !readFile) return res.status(404).json({ error: 'No file is stored for this bill.' });
      const buf = await readFile(i.file_key);
      res.setHeader('Content-Type', /^(application\/pdf|image\/(png|jpe?g|webp))$/i.test(i.file_mime || '') ? i.file_mime : 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${String(i.invoice_number || 'vendor-bill').replace(/[^A-Za-z0-9._-]/g, '_')}${/pdf/.test(i.file_mime || '') ? '.pdf' : ''}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.send(buf);
    } catch (e) { next(e); }
  });
  app.post('/api/vendor-invoices/scan', auth, perm, upload.single('file'), wrap(async (db, req) => {
    if (!req.file) fail(400, 'Choose a vendor invoice PDF or photo.');
    return draftFrom(db, req.file);
  }));
  app.post('/api/vendor-invoices/gmail/:messageId/scan', auth, perm, wrap(async (db, req) => {
    const a = await fetchGmailAttachment(db, req.params.messageId, req.body?.index);
    const draft = await draftFrom(db, { buffer: a.buffer, mimetype: a.mimeType, originalname: a.filename }, { gmailMessageId: a.message.id });
    if (!draft.invoice.vendor && a.message.counterparty) draft.invoice.vendor = await knownVendor(db, resolveVendor, a.message.counterparty, false);
    return draft;
  }));
  app.post('/api/vendor-invoices', auth, perm, wrap(async (db, req) => {
    const d = cleanVendorDraft(req.body || {});
    if (!d.vendor) fail(400, 'Vendor is required so the bill is filed under the right company.');
    if (!(d.total > 0) && !d.lines.length) fail(400, 'Enter the bill total or its lines.');
    const vendor = await knownVendor(db, resolveVendor, d.vendor, true);
    const gmailId = Number(req.body?.gmailMessageId) || null, fileKey = str(req.body?.file?.key, 300) || null;
    if (fileKey && !/^vendor-bills\/[\w.-]+$/.test(fileKey)) fail(400, 'Invalid file reference.');
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const total = d.total > 0 ? d.total : money(d.lines.reduce((a, l) => a + l.lineTotal, 0) + d.tax + d.freight);
      const ins = await c.query(`INSERT INTO parts_vendor_invoices(vendor,invoice_number,invoice_date,due_date,po_number,subtotal,tax,freight,total,source_filename,source_method,status,raw_extract,created_by,gmail_message_id,file_key,file_mime,notes)
        VALUES($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10,$11,'filed',$12::jsonb,$13,$14,$15,$16,$17) RETURNING id`,
      [vendor, d.invoiceNumber, d.invoiceDate, d.dueDate, d.poNumber, d.subtotal || money(d.lines.reduce((a, l) => a + l.lineTotal, 0)), d.tax, d.freight, total, str(req.body?.file?.name, 255) || null, gmailId ? 'gmail' : (fileKey || req.body?.file?.name ? 'ai_file' : 'manual'), JSON.stringify(req.body?.invoice || {}), req.user.username, gmailId, fileKey, fileKey ? str(req.body?.file?.mime, 60) : null, d.notes]);
      const id = ins.rows[0].id;
      let n = 0; for (const l of d.lines) { n++; await c.query(`INSERT INTO parts_vendor_invoice_lines(invoice_id,line_no,vendor_part_number,manufacturer,description,quantity,unit_cost,core_cost,line_total,match_status,received_quantity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'unmatched',0)`, [id, n, l.partNumber || null, l.manufacturer || null, l.description || null, l.quantity, l.unitCost, l.coreCost, l.lineTotal]); }
      if (gmailId) await c.query(`UPDATE gmail_finance_messages SET status='reviewed',handled_by=$2,handled_at=now() WHERE id=$1 AND status='new'`, [gmailId, req.user.username]);
      await c.query('COMMIT');
      await audit(req.user.username, 'vendor_bill_filed', { id, vendor, invoiceNumber: d.invoiceNumber, total, lines: d.lines.length, gmailMessageId: gmailId });
      return { ok: true, id, vendor };
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (_) {}
      if (e?.code === '23505') fail(409, 'A bill with this vendor and invoice number is already saved.', 'DUPLICATE_INVOICE');
      throw e;
    } finally { c.release(); }
  }));
  app.patch('/api/vendor-invoices/:id', auth, perm, wrap(async (db, req) => {
    const cur = (await db.query('SELECT * FROM parts_vendor_invoices WHERE id=$1::bigint', [req.params.id])).rows[0]; if (!cur) fail(404, 'Vendor bill not found.');
    const b = req.body || {}, sets = [], p = [cur.id];
    const add = (col, v) => { p.push(v); sets.push(`${col}=$${p.length}`); };
    if (b.paid === true) { add('paid_at', /^\d{4}-\d{2}-\d{2}$/.test(String(b.paidOn || '')) ? `${b.paidOn}T12:00:00Z` : new Date().toISOString()); add('paid_reference', str(b.paidReference, 160) || null); add('paid_by', req.user.username); }
    if (b.paid === false) { sets.push('paid_at=NULL', 'paid_reference=NULL', 'paid_by=NULL'); }
    if ('dueDate' in b) add('due_date', /^\d{4}-\d{2}-\d{2}$/.test(String(b.dueDate || '')) ? b.dueDate : null);
    if ('notes' in b) add('notes', str(b.notes, 1000) || null);
    if (b.vendor && str(b.vendor, 160).toLowerCase() !== String(cur.vendor || '').toLowerCase()) add('vendor', await knownVendor(db, resolveVendor, b.vendor, true));
    if (b.void === true) { if (cur.status === 'received') fail(409, 'This bill was received into stock. Undo it from Parts → Smart Receiving instead.'); sets.push("status='void'"); }
    if (!sets.length) fail(400, 'Nothing to change.');
    try { await db.query(`UPDATE parts_vendor_invoices SET ${sets.join(',')} WHERE id=$1::bigint`, p); }
    catch (e) { if (e?.code === '23505') fail(409, 'That vendor already has a bill with this invoice number.', 'DUPLICATE_INVOICE'); throw e; }
    await audit(req.user.username, 'vendor_bill_updated', { id: cur.id, changes: Object.keys(b) });
    return { ok: true };
  }));
  // A short written summary of the analysis for the owner (one cheap AI call on the numbers already computed).
  app.post('/api/vendor-invoices/analysis/summary', auth, perm, wrap(async (db, req) => {
    const a = await buildVendorAnalysis(db, reportRange(req.body || {}));
    if (!a.vendors.length) return { summary: 'No vendor bills in this period yet.' };
    const compact = { period: `${a.from} to ${a.to}`, totals: a.totals,
      vendors: a.vendors.slice(0, 12).map(v => ({ vendor: v.vendor, bills: v.bills, spend: v.total, share: v.share, unpaid: v.unpaid, overdue: v.overdue, coresValue: v.coresValue, topParts: v.topParts.slice(0, 3).map(p => `${p.partNumber || p.description} $${p.spend}`) })),
      priceIncreases: a.alerts.priceIncreases.slice(0, 8), cheaperElsewhere: a.alerts.cheaperElsewhere.slice(0, 8), mathProblems: a.alerts.mathProblems.slice(0, 5).map(m => `${m.vendor} #${m.invoiceNumber}: ${m.problems.map(p => p.message).join(' ')}`),
      duplicates: a.alerts.duplicates.slice(0, 5).map(d => `${d.vendor}: ${d.reason} $${d.total}`), unpaidPastDue: a.alerts.unpaidPastDue.slice(0, 8), coresPastDue: a.alerts.coresPastDue.length };
    const lang = /^uk/i.test(String(req.user?.language || '')) ? 'Ukrainian' : 'English';
    const summary = await textAI(`You are the purchasing analyst of a heavy-duty truck repair shop. Write a short report for the owner in ${lang}: at most 8 bullet points, most money first. Use only the numbers in the data; never invent vendors, parts or amounts. Cover where the money went, price increases, where the same part was cheaper, bills to double-check, what is owed and overdue, and cores to return. End with up to 3 concrete actions. Plain text bullets starting with "• ", no markdown headers.`, JSON.stringify(compact));
    return { summary: String(summary || '').slice(0, 4000) };
  }));
}
