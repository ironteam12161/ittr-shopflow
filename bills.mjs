// ITTR ShopFlow v24.48.0: Bills — every purchase the shop makes (parts, supplies, tools, fuel, rent, utilities, …),
// typed in by the office, with an expense category on each line. Built to be sent to QuickBooks Online later:
//  - One table for all bills: parts_vendor_invoices (the same rows Smart Receiving, AI scan and Gmail already create),
//    so a purchase is never entered twice and parts bills show up here too.
//  - Each line has a category; each category maps to a QuickBooks account (chart of accounts), set once by the owner.
//  - kind 'bill' = pay later (QBO Bill + BillPayment), kind 'expense' = paid at purchase (QBO Purchase).
//  - qb_* columns hold the QuickBooks id / status per bill so the sync can be added without changing this data.

const money = v => Math.round((Number(v) || 0) * 100) / 100;
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const ymd = v => { if (!v) return null; if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10); const s = String(v); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };

export const PAYMENT_METHODS = { cash: 'Cash', check: 'Check', card: 'Credit / debit card', ach: 'ACH / bank transfer', zelle: 'Zelle', other: 'Other' };
export const BILL_KINDS = { bill: 'Bill (pay later)', expense: 'Expense (already paid)' };

// Starting chart. qb_account is the QuickBooks account name the owner/accountant can change; kind is informational.
export const DEFAULT_CATEGORIES = [
  ['parts', 'Parts (for repairs)', 'Cost of Goods Sold:Parts', 'cogs'],
  ['fluids', 'Oil & fluids', 'Cost of Goods Sold:Oil & Fluids', 'cogs'],
  ['tires', 'Tires', 'Cost of Goods Sold:Tires', 'cogs'],
  ['sublet', 'Sublet / outside repairs', 'Cost of Goods Sold:Sublet', 'cogs'],
  ['shop_supplies', 'Shop supplies', 'Shop Supplies', 'expense'],
  ['tools', 'Tools & small equipment', 'Tools & Equipment', 'expense'],
  ['freight', 'Freight & delivery', 'Freight & Delivery', 'expense'],
  ['fuel', 'Fuel', 'Fuel', 'expense'],
  ['rent', 'Rent / lease', 'Rent or Lease', 'expense'],
  ['utilities', 'Utilities', 'Utilities', 'expense'],
  ['insurance', 'Insurance', 'Insurance', 'expense'],
  ['shop_repairs', 'Shop & building repairs', 'Repairs & Maintenance', 'expense'],
  ['office', 'Office supplies & software', 'Office Supplies & Software', 'expense'],
  ['advertising', 'Advertising', 'Advertising & Marketing', 'expense'],
  ['uniforms', 'Uniforms & safety gear', 'Uniforms', 'expense'],
  ['equipment', 'Equipment (large purchase)', 'Machinery & Equipment', 'asset'],
  ['other', 'Other', 'Other Business Expenses', 'expense'],
];

export async function ensureBillSchema(pool) {
  await pool.query(`
  ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS bill_kind TEXT NOT NULL DEFAULT 'bill';
  ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS terms TEXT;
  ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS payment_method TEXT;
  ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
  ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS updated_by TEXT;
  ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS qb_id TEXT;
  ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS qb_sync_token TEXT;
  ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS qb_payment_id TEXT;
  ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS qb_status TEXT NOT NULL DEFAULT 'not_synced';
  ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS qb_synced_at TIMESTAMPTZ;
  ALTER TABLE parts_vendor_invoices ADD COLUMN IF NOT EXISTS qb_error TEXT;
  ALTER TABLE parts_vendor_invoice_lines ADD COLUMN IF NOT EXISTS category TEXT;
  ALTER TABLE parts_vendor_invoice_lines ADD COLUMN IF NOT EXISTS work_order_id TEXT;
  ALTER TABLE parts_vendor_invoice_lines ADD COLUMN IF NOT EXISTS unit_number TEXT;
  CREATE TABLE IF NOT EXISTS expense_categories(
    key TEXT PRIMARY KEY, name TEXT NOT NULL, qb_account TEXT, qb_account_id TEXT, kind TEXT NOT NULL DEFAULT 'expense',
    sort INTEGER NOT NULL DEFAULT 100, active BOOLEAN NOT NULL DEFAULT TRUE, updated_by TEXT, updated_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_vendor_invoice_lines_category ON parts_vendor_invoice_lines(category);
  CREATE INDEX IF NOT EXISTS idx_parts_vendor_invoices_qb ON parts_vendor_invoices(qb_status);`);
  for (const [i, [key, name, qb, kind]] of DEFAULT_CATEGORIES.entries())
    await pool.query('INSERT INTO expense_categories(key,name,qb_account,kind,sort) VALUES($1,$2,$3,$4,$5) ON CONFLICT(key) DO NOTHING', [key, name, qb, kind, (i + 1) * 10]);
}

// A line with no category: parts bills from Smart Receiving / scans are parts, anything else is "other".
export const lineCategory = l => str(l.category, 40) || (str(l.vendor_part_number ?? l.partNumber, 80) || l.matched_part_id ? 'parts' : 'other');

// Clean a bill typed in the Bills form. Throws {status:400} with a plain message on bad input.
export function cleanBill(b = {}, categoryKeys = new Set(DEFAULT_CATEGORIES.map(c => c[0]))) {
  const bad = m => { throw Object.assign(new Error(m), { status: 400 }); };
  const kind = b.kind === 'expense' ? 'expense' : 'bill';
  const billDate = ymd(b.billDate);
  if (!billDate) bad('Enter the bill date.');
  const dueDate = kind === 'bill' ? ymd(b.dueDate) : null;
  if (dueDate && dueDate < billDate) bad('Due date cannot be before the bill date.');
  const raw = Array.isArray(b.lines) ? b.lines.slice(0, 200) : [];
  const lines = [];
  for (const [i, l] of raw.entries()) {
    const description = str(l.description, 300), partNumber = str(l.partNumber, 80);
    const quantity = l.quantity === '' || l.quantity == null ? 1 : num(l.quantity), unitCost = num(l.unitCost);
    let amount = l.amount === '' || l.amount == null ? money(quantity * unitCost) : money(l.amount);
    if (!description && !partNumber && !amount) continue;
    if (!description && !partNumber) bad(`Line ${i + 1}: describe what was bought.`);
    if (quantity <= 0) bad(`Line ${i + 1}: quantity must be more than 0.`);
    if (amount < 0) bad(`Line ${i + 1}: amounts can't be negative. Put discounts and credits in the Discount box.`);
    const category = str(l.category, 40) || (partNumber ? 'parts' : '');
    if (!category) bad(`Line ${i + 1}: choose a category.`);
    if (!categoryKeys.has(category)) bad(`Line ${i + 1}: unknown category.`);
    lines.push({ description, partNumber, quantity, unitCost: unitCost || (quantity ? money(amount / quantity) : 0), amount, category,
      workOrderId: str(l.workOrderId, 40) || null, unitNumber: str(l.unitNumber, 40) || null });
  }
  if (!lines.length) bad('Add at least one line: what was bought and how much.');
  const discount = Math.abs(money(b.discount)), tax = money(b.tax), freight = money(b.freight);
  if (tax < 0 || freight < 0) bad('Tax and freight cannot be negative.');
  const subtotal = money(lines.reduce((a, l) => a + l.amount, 0)), total = money(subtotal - discount + tax + freight);
  if (total <= 0) bad('The bill total must be more than $0.');
  if (b.total !== undefined && b.total !== '' && b.total !== null && Math.abs(money(b.total) - total) > 0.01) bad(`Lines, tax and freight add up to $${total.toFixed(2)}, but the bill total says $${money(b.total).toFixed(2)}. Check the numbers.`);
  const paymentMethod = PAYMENT_METHODS[b.paymentMethod] ? b.paymentMethod : null;
  if (kind === 'expense' && !paymentMethod) bad('Choose how it was paid.');
  return { kind, vendor: str(b.vendor, 160), billNumber: str(b.billNumber, 80) || null, billDate, dueDate, terms: str(b.terms, 40) || null,
    poNumber: str(b.poNumber, 80) || null, notes: str(b.notes, 1000) || null, paymentMethod, paymentReference: str(b.paymentReference, 160) || null,
    paidOn: kind === 'expense' ? (ymd(b.paidOn) || billDate) : null, discount, tax, freight, subtotal, total, lines };
}

// Spread tax and a discount over the lines in proportion (cents-exact) so each QuickBooks account gets its true cost.
export function allocate(lines, add) {
  const base = lines.reduce((a, l) => a + l.amount, 0);
  if (!add || !base) return lines.map(l => money(l.amount));
  const out = lines.map(l => money(l.amount + add * l.amount / base));
  const diff = money(money(base + add) - out.reduce((a, v) => a + v, 0));
  if (diff) { let k = 0; lines.forEach((l, i) => { if (l.amount > lines[k].amount) k = i; }); out[k] = money(out[k] + diff); }
  return out;
}

// What will be sent to QuickBooks Online for this bill (also shown as "QuickBooks preview" so the mapping can be
// checked before the connection exists). Returns { object, payload, missing[] }.
export function quickBooksPayload(bill, lines, categories) {
  const cats = new Map(categories.map(c => [c.key, c])), missing = [];
  if (!bill.vendor) missing.push('Vendor');
  const ls = lines.map(l => ({ ...l, category: lineCategory(l), amount: money(l.line_total ?? l.amount) }));
  const amounts = allocate(ls, money(num(bill.tax) - Math.abs(num(bill.discount))));
  const row = (amount, description, key) => {
    const c = cats.get(key); if (!c?.qb_account && !c?.qb_account_id) missing.push(`QuickBooks account for "${c?.name || key}"`);
    return { DetailType: 'AccountBasedExpenseLineDetail', Amount: amount, Description: description || undefined,
      AccountBasedExpenseLineDetail: { AccountRef: c?.qb_account_id ? { value: c.qb_account_id, name: c.qb_account || c.name } : { name: c?.qb_account || c?.name || key } } };
  };
  const Line = ls.map((l, i) => row(amounts[i], [l.vendor_part_number ?? l.partNumber, l.description].filter(Boolean).join(' — ') + (num(l.quantity) && num(l.quantity) !== 1 ? ` (x${num(l.quantity)})` : ''), l.category));
  if (num(bill.freight)) Line.push(row(money(bill.freight), 'Freight', 'freight'));
  const head = { VendorRef: { name: bill.vendor || '' }, TxnDate: ymd(bill.invoice_date ?? bill.billDate), DocNumber: bill.invoice_number ?? bill.billNumber ?? undefined,
    PrivateNote: [bill.po_number ? `PO ${bill.po_number}` : '', bill.notes || ''].filter(Boolean).join(' · ') || undefined, Line };
  const kind = (bill.bill_kind ?? bill.kind) === 'expense' ? 'expense' : 'bill';
  if (kind === 'expense') {
    const m = bill.payment_method ?? bill.paymentMethod;
    return { object: 'Purchase', missing: [...new Set(missing)], payload: { ...head, PaymentType: m === 'card' ? 'CreditCard' : m === 'check' ? 'Check' : 'Cash', DocNumber: head.DocNumber || bill.paid_reference || undefined } };
  }
  return { object: 'Bill', missing: [...new Set(missing)], payload: { ...head, DueDate: ymd(bill.due_date ?? bill.dueDate) || undefined, SalesTermRef: bill.terms ? { name: bill.terms } : undefined } };
}

const csvCell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };

// deps: auth, managerPermission, ownerOnly, requireDb, audit, resolveVendor, knownVendor, reportRange
export function registerBillRoutes(app, deps) {
  const { auth, managerPermission, ownerOnly, requireDb, audit, resolveVendor, knownVendor, reportRange } = deps;
  const perm = managerPermission('invoices');
  const wrap = fn => async (req, res, next) => { try { if (req.params?.id != null && !/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Bill not found.' }); const out = await fn(requireDb(), req, res); if (out !== undefined && !res.headersSent) res.json(out); } catch (e) { if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code }); next(e); } };
  const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, code }); };
  const categories = async db => (await db.query('SELECT key,name,qb_account,qb_account_id,kind,sort,active FROM expense_categories ORDER BY sort,name')).rows;
  const statusOf = r => r.status === 'void' ? 'void' : r.paid_at ? 'paid' : r.due_date && ymd(r.due_date) < new Date().toISOString().slice(0, 10) ? 'overdue' : 'unpaid';
  const view = r => ({ id: Number(r.id), kind: r.bill_kind || 'bill', vendor: r.vendor || '', billNumber: r.invoice_number || '', billDate: ymd(r.invoice_date), dueDate: ymd(r.due_date), terms: r.terms || '',
    poNumber: r.po_number || '', notes: r.notes || '', subtotal: money(r.subtotal), discount: money(r.discount), tax: money(r.tax), freight: money(r.freight), total: money(r.total),
    paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null, paymentMethod: r.payment_method || '', paymentReference: r.paid_reference || '', source: r.source_method || '',
    receivedIntoStock: r.status === 'received', status: statusOf(r), hasFile: !!r.file_key, qbStatus: r.qb_status || 'not_synced', qbId: r.qb_id || null, qbError: r.qb_error || null,
    createdBy: r.created_by || '', updatedBy: r.updated_by || '', categories: r.categories || undefined, lineCount: r.line_count ?? undefined });
  const lineView = l => ({ id: Number(l.id), description: l.description || '', partNumber: l.vendor_part_number || '', quantity: num(l.quantity), unitCost: money(l.unit_cost), amount: money(l.line_total),
    category: lineCategory(l), workOrderId: l.work_order_id || '', unitNumber: l.unit_number || '', receivedQuantity: num(l.received_quantity) });
  const loadBill = async (db, id) => {
    const r = (await db.query('SELECT * FROM parts_vendor_invoices WHERE id=$1::bigint', [id])).rows[0]; if (!r) fail(404, 'Bill not found.');
    const lines = (await db.query('SELECT * FROM parts_vendor_invoice_lines WHERE invoice_id=$1 ORDER BY line_no,id', [r.id])).rows;
    return { r, lines };
  };
  const touchQb = r => (r.qb_status === 'synced' ? 'needs_update' : r.qb_status || 'not_synced');

  app.get('/api/bills/meta', auth, perm, wrap(async db => ({ categories: await categories(db), paymentMethods: PAYMENT_METHODS, kinds: BILL_KINDS })));

  // Owner: rename categories, set their QuickBooks account, hide unused ones, add new ones.
  app.put('/api/bills/categories', auth, ownerOnly, wrap(async (db, req) => {
    const list = Array.isArray(req.body?.categories) ? req.body.categories.slice(0, 100) : [];
    if (!list.length) fail(400, 'Nothing to save.');
    for (const [i, x] of list.entries()) {
      const name = str(x.name, 80); if (!name) fail(400, 'Every category needs a name.');
      let key = str(x.key, 40).toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (!key) key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || `cat_${Date.now()}`;
      const kind = ['cogs', 'expense', 'asset'].includes(x.kind) ? x.kind : 'expense';
      await db.query(`INSERT INTO expense_categories(key,name,qb_account,qb_account_id,kind,sort,active,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())
        ON CONFLICT(key) DO UPDATE SET name=excluded.name,qb_account=excluded.qb_account,qb_account_id=excluded.qb_account_id,kind=excluded.kind,sort=excluded.sort,active=excluded.active,updated_by=excluded.updated_by,updated_at=now()`,
      [key, name, str(x.qbAccount, 160) || null, str(x.qbAccountId, 40) || null, kind, (i + 1) * 10, x.active !== false, req.user.username]);
    }
    await audit(req.user.username, 'expense_categories_saved', { count: list.length });
    return { categories: await categories(db) };
  }));

  app.get('/api/bills/vendors', auth, perm, wrap(async (db, req) => {
    const q = str(req.query.q, 80).toLowerCase();
    const r = await db.query(`SELECT name,max(last) last,sum(n)::int n FROM (
        SELECT vendor name,max(coalesce(invoice_date,created_at::date)) last,count(*) n FROM parts_vendor_invoices WHERE coalesce(trim(vendor),'')<>'' GROUP BY vendor
        UNION ALL SELECT canonical_name,NULL,0 FROM parts_vendors WHERE active IS NOT FALSE) v
      WHERE $1='' OR lower(name) LIKE '%'||$1||'%' GROUP BY name ORDER BY sum(n) DESC,name LIMIT 20`, [q]);
    return { vendors: r.rows.map(x => ({ name: x.name, bills: x.n, last: ymd(x.last) })) };
  }));

  async function listRows(db, req) {
    const { from, to } = reportRange(req.query);
    const status = ['unpaid', 'overdue', 'paid', 'void'].includes(req.query.status) ? req.query.status : '';
    const cat = str(req.query.category, 40), vendor = str(req.query.vendor, 160), q = str(req.query.q, 80).toLowerCase();
    return (await db.query(`SELECT i.*,coalesce(i.invoice_date,i.received_at::date,i.created_at::date) invoice_date,
        (SELECT array_agg(DISTINCT coalesce(l.category,CASE WHEN coalesce(l.vendor_part_number,'')<>'' OR l.matched_part_id IS NOT NULL THEN 'parts' ELSE 'other' END)) FROM parts_vendor_invoice_lines l WHERE l.invoice_id=i.id) categories,
        (SELECT count(*)::int FROM parts_vendor_invoice_lines l WHERE l.invoice_id=i.id) line_count
      FROM parts_vendor_invoices i
      WHERE coalesce(i.invoice_date,i.received_at::date,i.created_at::date) BETWEEN $1::date AND $2::date
        AND ($3='' OR ($3='void' AND i.status='void') OR ($3<>'void' AND i.status<>'void' AND (
          ($3='paid' AND i.paid_at IS NOT NULL) OR ($3='unpaid' AND i.paid_at IS NULL) OR ($3='overdue' AND i.paid_at IS NULL AND i.due_date<current_date))))
        AND ($4='' OR EXISTS(SELECT 1 FROM parts_vendor_invoice_lines l WHERE l.invoice_id=i.id AND coalesce(l.category,CASE WHEN coalesce(l.vendor_part_number,'')<>'' OR l.matched_part_id IS NOT NULL THEN 'parts' ELSE 'other' END)=$4))
        AND ($5='' OR lower(coalesce(i.vendor,''))=lower($5))
        AND ($6='' OR lower(coalesce(i.vendor,'')||' '||coalesce(i.invoice_number,'')||' '||coalesce(i.po_number,'')||' '||coalesce(i.notes,'')) LIKE '%'||$6||'%'
          OR EXISTS(SELECT 1 FROM parts_vendor_invoice_lines x WHERE x.invoice_id=i.id AND lower(coalesce(x.vendor_part_number,'')||' '||coalesce(x.description,'')) LIKE '%'||$6||'%'))
      ORDER BY coalesce(i.invoice_date,i.received_at::date,i.created_at::date) DESC,i.id DESC LIMIT 1000`, [from, to, status, cat, vendor, q])).rows;
  }

  app.get('/api/bills', auth, perm, wrap(async (db, req) => {
    const rows = await listRows(db, req), items = rows.map(view), live = items.filter(b => b.status !== 'void');
    const sum = a => money(a.reduce((s, b) => s + b.total, 0));
    // Spend per category in the range, split exactly like QuickBooks: tax and discount spread over the lines, freight
    // to Freight. The category totals therefore add up to "Spent in period".
    const { from, to } = reportRange(req.query);
    const bills = (await db.query(`SELECT id,tax,discount,freight FROM parts_vendor_invoices i WHERE i.status<>'void' AND coalesce(i.invoice_date,i.received_at::date,i.created_at::date) BETWEEN $1::date AND $2::date`, [from, to])).rows;
    const allLines = bills.length ? (await db.query('SELECT invoice_id,line_total,category,vendor_part_number,matched_part_id FROM parts_vendor_invoice_lines WHERE invoice_id=ANY($1::bigint[]) ORDER BY invoice_id,line_no,id', [bills.map(x => x.id)])).rows : [];
    const byBill = new Map(); for (const l of allLines) { const k = String(l.invoice_id); if (!byBill.has(k)) byBill.set(k, []); byBill.get(k).push({ ...l, category: lineCategory(l), amount: money(l.line_total) }); }
    const catTotals = {}, addCat = (k, v) => { if (v) catTotals[k] = money((catTotals[k] || 0) + v); };
    for (const r of bills) { const ls = byBill.get(String(r.id)) || [], amounts = allocate(ls, money(num(r.tax) - Math.abs(num(r.discount)))); ls.forEach((l, i) => addCat(l.category, amounts[i])); addCat('freight', money(r.freight)); }
    return { from, to, items, totals: { count: live.length, total: sum(live), unpaid: sum(live.filter(b => b.status === 'unpaid' || b.status === 'overdue')), overdue: sum(live.filter(b => b.status === 'overdue')),
      overdueCount: live.filter(b => b.status === 'overdue').length, paid: sum(live.filter(b => b.status === 'paid')), notSynced: live.filter(b => b.qbStatus !== 'synced').length }, byCategory: catTotals };
  }));

  // CSV for the accountant / QuickBooks import: one row per bill line, with the QuickBooks account of its category.
  app.get('/api/bills/export.csv', auth, perm, wrap(async (db, req, res) => {
    const cats = new Map((await categories(db)).map(c => [c.key, c])), rows = (await listRows(db, req)).filter(r => r.status !== 'void');
    const ids = rows.map(r => r.id), lines = ids.length ? (await db.query('SELECT * FROM parts_vendor_invoice_lines WHERE invoice_id=ANY($1::bigint[]) ORDER BY invoice_id,line_no,id', [ids])).rows : [];
    const out = [['Bill No', 'Vendor', 'Bill Date', 'Due Date', 'Terms', 'Type', 'Category', 'QuickBooks Account', 'Description', 'Qty', 'Line Amount', 'Bill Total', 'Status', 'Paid On', 'Paid With', 'Memo']];
    for (const r of rows) {
      const ls = lines.filter(l => String(l.invoice_id) === String(r.id)).map(l => ({ ...l, category: lineCategory(l), amount: money(l.line_total) }));
      const amounts = allocate(ls, money(num(r.tax) - Math.abs(num(r.discount)))), v = view(r);
      const push = (key, desc, qty, amt) => { const c = cats.get(key); out.push([v.billNumber, v.vendor, v.billDate, v.dueDate || '', v.terms, v.kind === 'expense' ? 'Expense' : 'Bill', c?.name || key, c?.qb_account || '', desc, qty, amt.toFixed(2), v.total.toFixed(2), v.status, v.paidAt ? v.paidAt.slice(0, 10) : '', PAYMENT_METHODS[v.paymentMethod] || '', v.notes]); };
      ls.forEach((l, i) => push(l.category, [l.vendor_part_number, l.description].filter(Boolean).join(' — '), num(l.quantity), amounts[i]));
      if (num(r.freight)) push('freight', 'Freight', 1, money(r.freight));
    }
    const { from, to } = reportRange(req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bills-${from}-to-${to}.csv"`);
    res.send('﻿' + out.map(r => r.map(csvCell).join(',')).join('\r\n'));
  }));

  app.get('/api/bills/:id', auth, perm, wrap(async (db, req) => {
    const { r, lines } = await loadBill(db, req.params.id), cats = await categories(db);
    return { bill: view(r), lines: lines.map(lineView), quickBooks: quickBooksPayload(r, lines, cats) };
  }));

  const keysOf = async db => new Set((await categories(db)).filter(c => c.active).map(c => c.key));
  async function writeLines(c, id, lines) {
    await c.query('DELETE FROM parts_vendor_invoice_lines WHERE invoice_id=$1', [id]);
    let n = 0;
    for (const l of lines) { n++; await c.query(`INSERT INTO parts_vendor_invoice_lines(invoice_id,line_no,vendor_part_number,description,quantity,unit_cost,core_cost,line_total,match_status,received_quantity,category,work_order_id,unit_number)
      VALUES($1,$2,$3,$4,$5,$6,0,$7,'unmatched',0,$8,$9,$10)`, [id, n, l.partNumber || null, l.description || null, l.quantity, l.unitCost, l.amount, l.category, l.workOrderId, l.unitNumber]); }
  }
  const dupError = e => { if (e?.code === '23505') fail(409, 'This vendor already has a bill with that bill number.', 'DUPLICATE_INVOICE'); throw e; };

  app.post('/api/bills', auth, perm, wrap(async (db, req) => {
    const d = cleanBill(req.body || {}, await keysOf(db));
    if (!d.vendor) fail(400, 'Enter the vendor (who you bought from).');
    const vendor = await knownVendor(db, resolveVendor, d.vendor, true);
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const ins = await c.query(`INSERT INTO parts_vendor_invoices(vendor,invoice_number,invoice_date,due_date,po_number,subtotal,discount,tax,freight,total,source_method,status,raw_extract,created_by,notes,bill_kind,terms,payment_method,paid_at,paid_reference,paid_by,updated_at,updated_by)
        VALUES($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10,'manual','filed','{}'::jsonb,$11,$12,$13,$14,$15,$16::timestamptz,$17,$18,now(),$11) RETURNING id`,
      [vendor, d.billNumber, d.billDate, d.dueDate, d.poNumber, d.subtotal, d.discount, d.tax, d.freight, d.total, req.user.username, d.notes, d.kind, d.terms, d.paymentMethod,
        d.paidOn ? `${d.paidOn}T12:00:00Z` : null, d.kind === 'expense' ? d.paymentReference : null, d.kind === 'expense' ? req.user.username : null]);
      const id = ins.rows[0].id;
      await writeLines(c, id, d.lines);
      await c.query('COMMIT');
      await audit(req.user.username, 'bill_created', { id, vendor, kind: d.kind, total: d.total, lines: d.lines.length });
      return { ok: true, id: Number(id) };
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} dupError(e); } finally { c.release(); }
  }));

  // Edit a bill. A bill already received into stock keeps its parts lines (quantities and costs feed inventory):
  // only its details and line categories can change. A void bill can't change.
  app.put('/api/bills/:id', auth, perm, wrap(async (db, req) => {
    const { r, lines: cur } = await loadBill(db, req.params.id);
    if (r.status === 'void') fail(409, 'This bill is void.');
    const b = req.body || {}, keys = await keysOf(db);
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      if (r.status === 'received') {
        const cats = Array.isArray(b.lines) ? b.lines : [];
        for (const l of cats) { if (!l?.id) continue; const k = str(l.category, 40); if (!keys.has(k)) fail(400, 'Unknown category.');
          await c.query('UPDATE parts_vendor_invoice_lines SET category=$3,work_order_id=$4,unit_number=$5 WHERE id=$1::bigint AND invoice_id=$2', [l.id, r.id, k, str(l.workOrderId, 40) || null, str(l.unitNumber, 40) || null]); }
        const due = ymd(b.dueDate);
        await c.query('UPDATE parts_vendor_invoices SET due_date=$2::date,terms=$3,notes=$4,updated_at=now(),updated_by=$5,qb_status=$6 WHERE id=$1', [r.id, due, str(b.terms, 40) || null, str(b.notes, 1000) || null, req.user.username, touchQb(r)]);
      } else {
        const d = cleanBill({ ...b, kind: b.kind || r.bill_kind, paidOn: b.paidOn || ymd(r.paid_at) }, keys);
        if (!d.vendor) fail(400, 'Enter the vendor (who you bought from).');
        const vendor = await knownVendor(c, resolveVendor, d.vendor, true);
        const paid = d.kind === 'expense' ? { at: `${d.paidOn}T12:00:00Z`, ref: d.paymentReference, by: r.paid_by || req.user.username, m: d.paymentMethod } : { at: r.paid_at, ref: r.paid_reference, by: r.paid_by, m: r.paid_at ? (r.payment_method || d.paymentMethod) : d.paymentMethod };
        await c.query(`UPDATE parts_vendor_invoices SET vendor=$2,invoice_number=$3,invoice_date=$4::date,due_date=$5::date,po_number=$6,subtotal=$7,discount=$8,tax=$9,freight=$10,total=$11,notes=$12,bill_kind=$13,terms=$14,
            payment_method=$15,paid_at=$16::timestamptz,paid_reference=$17,paid_by=$18,updated_at=now(),updated_by=$19,qb_status=$20 WHERE id=$1`,
        [r.id, vendor, d.billNumber, d.billDate, d.dueDate, d.poNumber, d.subtotal, d.discount, d.tax, d.freight, d.total, d.notes, d.kind, d.terms, paid.m, paid.at, paid.ref, paid.by, req.user.username, touchQb(r)]);
        await writeLines(c, r.id, d.lines);
      }
      await c.query('COMMIT');
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} dupError(e); } finally { c.release(); }
    await audit(req.user.username, 'bill_updated', { id: Number(r.id), receivedIntoStock: r.status === 'received', linesBefore: cur.length });
    return { ok: true };
  }));

  app.post('/api/bills/:id/payment', auth, perm, wrap(async (db, req) => {
    const { r } = await loadBill(db, req.params.id);
    if (r.status === 'void') fail(409, 'This bill is void.');
    if (r.paid_at) fail(409, 'This bill is already marked paid.');
    const b = req.body || {}, on = ymd(b.paidOn) || new Date().toISOString().slice(0, 10), method = PAYMENT_METHODS[b.method] ? b.method : null;
    if (!method) fail(400, 'Choose how it was paid.');
    await db.query('UPDATE parts_vendor_invoices SET paid_at=$2::timestamptz,payment_method=$3,paid_reference=$4,paid_by=$5,updated_at=now(),updated_by=$5,qb_status=$6 WHERE id=$1',
      [r.id, `${on}T12:00:00Z`, method, str(b.reference, 160) || null, req.user.username, touchQb(r)]);
    await audit(req.user.username, 'bill_paid', { id: Number(r.id), method, paidOn: on, total: money(r.total) });
    return { ok: true };
  }));
  app.delete('/api/bills/:id/payment', auth, perm, wrap(async (db, req) => {
    const { r } = await loadBill(db, req.params.id);
    if ((r.bill_kind || 'bill') === 'expense') fail(409, 'An expense is paid when it is entered. Change it to a Bill first if it is not paid.');
    await db.query('UPDATE parts_vendor_invoices SET paid_at=NULL,paid_reference=NULL,paid_by=NULL,updated_at=now(),updated_by=$2,qb_status=$3 WHERE id=$1', [r.id, req.user.username, touchQb(r)]);
    await audit(req.user.username, 'bill_payment_removed', { id: Number(r.id) });
    return { ok: true };
  }));
  app.post('/api/bills/:id/void', auth, perm, wrap(async (db, req) => {
    const { r } = await loadBill(db, req.params.id);
    if (r.status === 'received') fail(409, 'This bill was received into stock. Undo it from Parts → Smart Receiving instead.');
    if (r.status === 'void') return { ok: true };
    const reason = str(req.body?.reason, 300); if (!reason) fail(400, 'Say why this bill is voided.');
    await db.query(`UPDATE parts_vendor_invoices SET status='void',notes=trim(both ' ' from coalesce(notes,'')||' [Void: '||$2||']'),updated_at=now(),updated_by=$3,qb_status=$4 WHERE id=$1`, [r.id, reason, req.user.username, r.qb_id ? 'needs_update' : r.qb_status]);
    await audit(req.user.username, 'bill_voided', { id: Number(r.id), reason, total: money(r.total) });
    return { ok: true };
  }));

}
