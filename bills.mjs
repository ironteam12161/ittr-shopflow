// ITTR ShopFlow v24.48.0: Bills — every purchase the shop makes (parts, supplies, tools, fuel, rent, utilities, …),
// typed in by the office, with an expense category on each line. Built to be sent to QuickBooks Online later:
//  - One table for all bills: parts_vendor_invoices (the same rows Smart Receiving, AI scan and Gmail already create),
//    so a purchase is never entered twice and parts bills show up here too.
//  - Each line has a category; each category maps to a QuickBooks account (chart of accounts), set once by the owner.
//  - kind 'bill' = pay later (QBO Bill + BillPayment), kind 'expense' = paid at purchase (QBO Purchase).
//  - qb_* columns hold the QuickBooks id / status per bill so the sync can be added without changing this data.

import { shopProfile } from './invoice_pdf.mjs';

const money = v => Math.round((Number(v) || 0) * 100) / 100;
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const ymd = v => { if (!v) return null; if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10); const s = String(v); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };

export const PAYMENT_METHODS = { cash: 'Cash', check: 'Check', card: 'Credit / debit card', ach: 'ACH / bank transfer', zelle: 'Zelle', other: 'Other' };
export const BILL_KINDS = { bill: 'Bill (pay later)', expense: 'Expense (already paid)', credit: 'Vendor credit', journal: 'Core not returned' };

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
  // v24.62.0: a core deposit is money the vendor gives back when the old core is returned, so it is not a cost:
  // QuickBooks "Core Deposits" is an Other Current Asset. A vendor credit for the returned core takes it back off;
  // a core never returned is moved to parts cost.
  ['core_deposits', 'Core deposits (refundable)', 'Core Deposits', 'asset'],
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
  CREATE INDEX IF NOT EXISTS idx_parts_vendor_invoices_qb ON parts_vendor_invoices(qb_status);
  CREATE INDEX IF NOT EXISTS idx_pvi_credit_applied_to ON parts_vendor_invoices((raw_extract->>'appliedToBillId')) WHERE bill_kind='credit';
  CREATE INDEX IF NOT EXISTS idx_pvi_core_obligation ON parts_vendor_invoices((raw_extract->>'coreObligationId')) WHERE raw_extract ? 'coreObligationId';`);
  for (const [i, [key, name, qb, kind]] of DEFAULT_CATEGORIES.entries())
    await pool.query('INSERT INTO expense_categories(key,name,qb_account,kind,sort) VALUES($1,$2,$3,$4,$5) ON CONFLICT(key) DO NOTHING', [key, name, qb, kind, (i + 1) * 10]);
}

// A line with no category: parts bills from Smart Receiving / scans are parts, anything else is "other".
export const lineCategory = l => str(l.category, 40) || (str(l.vendor_part_number ?? l.partNumber, 80) || l.matched_part_id ? 'parts' : 'other');

// v24.62.0: a parts bill received into stock keeps each core charge on its part line (core_cost). For QuickBooks, the
// category totals and the CSV it is its own line on Core deposits, so the lines add up to what the vendor billed.
export function withCoreLines(lines) {
  const out = [];
  for (const l of lines) {
    out.push(l);
    const core = num(l.core_cost), q = num(l.quantity) || 1;
    if (core > 0) out.push({ ...l, id: null, virtual: true, vendor_part_number: '', partNumber: '', description: `Core deposit – ${str(l.vendor_part_number ?? l.partNumber, 80) || str(l.description, 80) || 'part'}`,
      quantity: q, unit_cost: core, core_cost: 0, line_total: money(core * q), amount: money(core * q), category: 'core_deposits', matched_part_id: null });
  }
  return out;
}
// v24.63.0: a bill's vendor is who sold to the shop, never the shop itself (an AI scan can read the "Bill to" block).
const nameKey = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\b(llc|inc|corp|co|ltd|the|and)\b/g, ' ').replace(/[^a-z0-9]+/g, '');
export function isOwnShopName(vendor, shopName = shopProfile().name) {
  const v = nameKey(vendor), s = nameKey(shopName), head = nameKey(String(shopName || '').split(/\s+/).slice(0, 2).join(' '));
  return !!v && (v === s || (head.length >= 6 && v.startsWith(head)));
}
// Credits are stored negative and "core not returned" entries add up to $0, so every total nets out by itself.
export const kindOf = r => (['expense', 'credit', 'journal'].includes(r?.bill_kind ?? r?.kind) ? (r.bill_kind ?? r.kind) : 'bill');

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
  const ls = withCoreLines(lines).map(l => ({ ...l, category: lineCategory(l), amount: money(l.line_total ?? l.amount) }));
  const kind0 = kindOf(bill);
  if (kind0 === 'journal') {
    const Line = ls.map(l => { const c = cats.get(l.category); if (!c?.qb_account && !c?.qb_account_id) missing.push(`QuickBooks account for "${c?.name || l.category}"`);
      return { DetailType: 'JournalEntryLineDetail', Amount: Math.abs(l.amount), Description: l.description || undefined,
        JournalEntryLineDetail: { PostingType: l.amount >= 0 ? 'Debit' : 'Credit', AccountRef: c?.qb_account_id ? { value: c.qb_account_id, name: c.qb_account || c.name } : { name: c?.qb_account || c?.name || l.category } } }; });
    return { object: 'JournalEntry', missing: [...new Set(missing)], payload: { TxnDate: ymd(bill.invoice_date ?? bill.billDate), DocNumber: bill.invoice_number ?? bill.billNumber ?? undefined, PrivateNote: bill.notes || undefined, Line } };
  }
  if (kind0 === 'credit') ls.forEach(l => { l.amount = Math.abs(l.amount); });
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
  const kind = kind0;
  if (kind === 'credit') return { object: 'VendorCredit', missing: [...new Set(missing)], payload: head };
  if (kind === 'expense') {
    const m = bill.payment_method ?? bill.paymentMethod;
    return { object: 'Purchase', missing: [...new Set(missing)], payload: { ...head, PaymentType: m === 'card' ? 'CreditCard' : m === 'check' ? 'Check' : 'Cash', DocNumber: head.DocNumber || bill.paid_reference || undefined } };
  }
  return { object: 'Bill', missing: [...new Set(missing)], payload: { ...head, DueDate: ymd(bill.due_date ?? bill.dueDate) || undefined, SalesTermRef: bill.terms ? { name: bill.terms } : undefined } };
}

// v24.62.0: money side of a core returned to the vendor (Parts → Cores). Only for cores that came in on a vendor bill,
// whose deposit sits on Core deposits:
//  - credited → a vendor credit for that vendor (Core deposits −amount; QuickBooks VendorCredit), open until it is used
//    on a payment ("Mark applied");
//  - closed with money still open (core kept / never returned) → "core not returned": Parts +amount, Core deposits
//    −amount, total $0 (QuickBooks JournalEntry);
//  - reopened → those entries are voided.
// db is the caller's transaction client.
export async function recordCoreMoney(db, { core, partNumber, action, amount, date, reference, username }) {
  if (!core?.vendor_invoice_id) return null;
  const tag = { coreObligationId: Number(core.id) };
  if (action === 'reopened') {
    const r = await db.query(`UPDATE parts_vendor_invoices SET status='void',notes=trim(both ' ' from coalesce(notes,'')||' [Void: core reopened]'),updated_at=now(),updated_by=$2,
        qb_status=CASE WHEN qb_id IS NOT NULL THEN 'needs_update' ELSE qb_status END WHERE raw_extract->>'coreObligationId'=$1 AND status<>'void' RETURNING id`, [String(core.id), username]);
    return r.rowCount;
  }
  amount = money(amount); if (!(amount > 0) || !['credited', 'closed'].includes(action)) return null;
  const on = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : new Date().toISOString().slice(0, 10);
  const what = `${partNumber || 'part'}${core.purchase_reference ? ` (bill ${core.purchase_reference})` : ''}`;
  const credit = action === 'credited', n = (await db.query(`SELECT count(*)::int n FROM parts_vendor_invoices WHERE raw_extract->>'coreObligationId'=$1`, [String(core.id)])).rows[0].n + 1;
  const docNumber = `${credit ? 'CORE-CR' : 'CORE-KEPT'}-${core.id}-${n}`;
  const ins = await db.query(`INSERT INTO parts_vendor_invoices(vendor,invoice_number,invoice_date,subtotal,discount,tax,freight,total,source_method,status,raw_extract,created_by,notes,bill_kind,paid_at,paid_by,updated_at,updated_by)
      VALUES($1,$2,$3::date,$4,0,0,0,$4,'core','filed',$5::jsonb,$6,$7,$8,$9::timestamptz,$10,now(),$6) RETURNING id`,
    [core.vendor_name_snapshot || '', docNumber, on, credit ? -amount : 0, JSON.stringify(tag), username,
      credit ? `Core returned: ${what}${reference ? ` · credit ${reference}` : ''}` : `Core not returned: ${what} — deposit moved to parts cost`,
      credit ? 'credit' : 'journal', credit ? null : `${on}T12:00:00Z`, credit ? null : username]);
  const id = ins.rows[0].id, line = (no, desc, amt, cat) => db.query(`INSERT INTO parts_vendor_invoice_lines(invoice_id,line_no,vendor_part_number,description,quantity,unit_cost,core_cost,line_total,match_status,received_quantity,category)
      VALUES($1,$2,NULL,$3,1,$4,0,$4,'unmatched',0,$5)`, [id, no, desc, amt, cat]);
  if (credit) await line(1, `Core credit – ${partNumber || 'part'}`, -amount, 'core_deposits');
  else { await line(1, `Core not returned – ${partNumber || 'part'}`, amount, 'parts'); await line(2, `Core deposit written off – ${partNumber || 'part'}`, -amount, 'core_deposits'); }
  return Number(id);
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
  // v24.63.0: vendor credits applied to a bill lower what is left to pay on it.
  const applied = r => money(r.applied_credits);
  const view = r => ({ id: Number(r.id), kind: kindOf(r), coreObligationId: Number(r.raw_extract?.coreObligationId) || null,
    appliedCredits: applied(r), balanceDue: money(num(r.total) + applied(r)), appliedToBillId: Number(r.raw_extract?.appliedToBillId) || null, vendor: r.vendor || '', billNumber: r.invoice_number || '', billDate: ymd(r.invoice_date), dueDate: ymd(r.due_date), terms: r.terms || '',
    poNumber: r.po_number || '', notes: r.notes || '', subtotal: money(r.subtotal), discount: money(r.discount), tax: money(r.tax), freight: money(r.freight), total: money(r.total),
    paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null, paymentMethod: r.payment_method || '', paymentReference: r.paid_reference || '', source: r.source_method || '',
    receivedIntoStock: r.status === 'received', status: statusOf(r), hasFile: !!r.file_key, hasCore: !!r.has_core, qbStatus: r.qb_status || 'not_synced', qbId: r.qb_id || null, qbError: r.qb_error || null,
    createdBy: r.created_by || '', updatedBy: r.updated_by || '', categories: r.categories ? [...new Set([...r.categories, ...(r.has_core ? ['core_deposits'] : [])])] : undefined, lineCount: r.line_count ?? undefined });
  const lineView = l => ({ id: l.id == null ? null : Number(l.id), virtual: !!l.virtual, description: l.description || '', partNumber: l.vendor_part_number || '', quantity: num(l.quantity), unitCost: money(l.unit_cost), amount: money(l.line_total),
    category: lineCategory(l), workOrderId: l.work_order_id || '', unitNumber: l.unit_number || '', receivedQuantity: num(l.received_quantity) });
  const loadBill = async (db, id) => {
    const r = (await db.query(`SELECT i.*,(SELECT coalesce(sum(c.total),0) FROM parts_vendor_invoices c WHERE c.bill_kind='credit' AND c.status<>'void' AND c.raw_extract->>'appliedToBillId'=i.id::text) applied_credits,EXISTS(SELECT 1 FROM parts_vendor_invoice_lines l WHERE l.invoice_id=i.id AND coalesce(l.core_cost,0)>0) has_core FROM parts_vendor_invoices i WHERE i.id=$1::bigint`, [id])).rows[0]; if (!r) fail(404, 'Bill not found.');
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
        (SELECT count(*)::int FROM parts_vendor_invoice_lines l WHERE l.invoice_id=i.id) line_count,
        EXISTS(SELECT 1 FROM parts_vendor_invoice_lines l WHERE l.invoice_id=i.id AND coalesce(l.core_cost,0)>0) has_core,
        (SELECT coalesce(sum(c.total),0) FROM parts_vendor_invoices c WHERE c.bill_kind='credit' AND c.status<>'void' AND c.raw_extract->>'appliedToBillId'=i.id::text) applied_credits
      FROM parts_vendor_invoices i
      WHERE coalesce(i.invoice_date,i.received_at::date,i.created_at::date) BETWEEN $1::date AND $2::date
        AND ($3='' OR ($3='void' AND i.status='void') OR ($3<>'void' AND i.status<>'void' AND (
          ($3='paid' AND i.paid_at IS NOT NULL) OR ($3='unpaid' AND i.paid_at IS NULL) OR ($3='overdue' AND i.paid_at IS NULL AND i.due_date<current_date))))
        AND ($4='' OR EXISTS(SELECT 1 FROM parts_vendor_invoice_lines l WHERE l.invoice_id=i.id AND (coalesce(l.category,CASE WHEN coalesce(l.vendor_part_number,'')<>'' OR l.matched_part_id IS NOT NULL THEN 'parts' ELSE 'other' END)=$4 OR ($4='core_deposits' AND coalesce(l.core_cost,0)>0))))
        AND ($5='' OR lower(coalesce(i.vendor,''))=lower($5))
        AND ($6='' OR lower(coalesce(i.vendor,'')||' '||coalesce(i.invoice_number,'')||' '||coalesce(i.po_number,'')||' '||coalesce(i.notes,'')) LIKE '%'||$6||'%'
          OR EXISTS(SELECT 1 FROM parts_vendor_invoice_lines x WHERE x.invoice_id=i.id AND lower(coalesce(x.vendor_part_number,'')||' '||coalesce(x.description,'')) LIKE '%'||$6||'%'))
      ORDER BY coalesce(i.invoice_date,i.received_at::date,i.created_at::date) DESC,i.id DESC LIMIT 1000`, [from, to, status, cat, vendor, q])).rows;
  }

  app.get('/api/bills', auth, perm, wrap(async (db, req) => {
    const rows = await listRows(db, req), items = rows.map(view), live = items.filter(b => b.status !== 'void');
    const sum = a => money(a.reduce((s, b) => s + b.total, 0)), owed = a => money(a.reduce((s, b) => s + b.balanceDue, 0));
    // Spend per category in the range, split exactly like QuickBooks: tax and discount spread over the lines, freight
    // to Freight. The category totals therefore add up to "Spent in period".
    const { from, to } = reportRange(req.query);
    const bills = (await db.query(`SELECT id,tax,discount,freight FROM parts_vendor_invoices i WHERE i.status<>'void' AND coalesce(i.invoice_date,i.received_at::date,i.created_at::date) BETWEEN $1::date AND $2::date`, [from, to])).rows;
    const allLines = bills.length ? withCoreLines((await db.query('SELECT invoice_id,line_total,category,vendor_part_number,matched_part_id,quantity,core_cost,description FROM parts_vendor_invoice_lines WHERE invoice_id=ANY($1::bigint[]) ORDER BY invoice_id,line_no,id', [bills.map(x => x.id)])).rows) : [];
    const byBill = new Map(); for (const l of allLines) { const k = String(l.invoice_id); if (!byBill.has(k)) byBill.set(k, []); byBill.get(k).push({ ...l, category: lineCategory(l), amount: money(l.line_total) }); }
    const catTotals = {}, addCat = (k, v) => { if (v) catTotals[k] = money((catTotals[k] || 0) + v); };
    for (const r of bills) { const ls = byBill.get(String(r.id)) || [], amounts = allocate(ls, money(num(r.tax) - Math.abs(num(r.discount)))); ls.forEach((l, i) => addCat(l.category, amounts[i])); addCat('freight', money(r.freight)); }
    return { from, to, items, totals: { count: live.length, total: sum(live), unpaid: owed(live.filter(b => b.status === 'unpaid' || b.status === 'overdue')), overdue: owed(live.filter(b => b.status === 'overdue')),
      overdueCount: live.filter(b => b.status === 'overdue').length, paid: sum(live.filter(b => b.status === 'paid')), notSynced: live.filter(b => b.qbStatus !== 'synced').length }, byCategory: catTotals };
  }));

  // CSV for the accountant / QuickBooks import: one row per bill line, with the QuickBooks account of its category.
  app.get('/api/bills/export.csv', auth, perm, wrap(async (db, req, res) => {
    const cats = new Map((await categories(db)).map(c => [c.key, c])), rows = (await listRows(db, req)).filter(r => r.status !== 'void');
    const ids = rows.map(r => r.id), lines = ids.length ? (await db.query('SELECT * FROM parts_vendor_invoice_lines WHERE invoice_id=ANY($1::bigint[]) ORDER BY invoice_id,line_no,id', [ids])).rows : [];
    const out = [['Bill No', 'Vendor', 'Bill Date', 'Due Date', 'Terms', 'Type', 'Category', 'QuickBooks Account', 'Description', 'Qty', 'Line Amount', 'Bill Total', 'Status', 'Paid On', 'Paid With', 'Memo']];
    for (const r of rows) {
      const ls = withCoreLines(lines.filter(l => String(l.invoice_id) === String(r.id))).map(l => ({ ...l, category: lineCategory(l), amount: money(l.line_total) }));
      const amounts = allocate(ls, money(num(r.tax) - Math.abs(num(r.discount)))), v = view(r);
      const push = (key, desc, qty, amt) => { const c = cats.get(key); out.push([v.billNumber, v.vendor, v.billDate, v.dueDate || '', v.terms, ({ expense: 'Expense', credit: 'Vendor credit', journal: 'Journal (core not returned)' })[v.kind] || 'Bill', c?.name || key, c?.qb_account || '', desc, qty, amt.toFixed(2), v.total.toFixed(2), v.status, v.paidAt ? v.paidAt.slice(0, 10) : '', PAYMENT_METHODS[v.paymentMethod] || '', v.notes]); };
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
    return { bill: view(r), lines: withCoreLines(lines).map(lineView), quickBooks: quickBooksPayload(r, lines, cats) };
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
    if (isOwnShopName(d.vendor)) fail(400, 'The vendor is the company you bought from — not your own shop. Check the letterhead at the top of the bill.');
    const vendor = await knownVendor(db, resolveVendor, d.vendor, true);
    // v24.48.2: a bill scanned in Bills keeps its photo/PDF (stored by /api/vendor-invoices/scan).
    const file = req.body?.file || {}, fileKey = str(file.key, 300) || null;
    if (fileKey && !/^vendor-bills\/[\w.-]+$/.test(fileKey)) fail(400, 'Invalid file reference.');
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const ins = await c.query(`INSERT INTO parts_vendor_invoices(vendor,invoice_number,invoice_date,due_date,po_number,subtotal,discount,tax,freight,total,source_method,status,raw_extract,created_by,notes,bill_kind,terms,payment_method,paid_at,paid_reference,paid_by,updated_at,updated_by,file_key,file_mime,source_filename)
        VALUES($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10,$19,'filed','{}'::jsonb,$11,$12,$13,$14,$15,$16::timestamptz,$17,$18,now(),$11,$20,$21,$22) RETURNING id`,
      [vendor, d.billNumber, d.billDate, d.dueDate, d.poNumber, d.subtotal, d.discount, d.tax, d.freight, d.total, req.user.username, d.notes, d.kind, d.terms, d.paymentMethod,
        d.paidOn ? `${d.paidOn}T12:00:00Z` : null, d.kind === 'expense' ? d.paymentReference : null, d.kind === 'expense' ? req.user.username : null,
        fileKey ? 'ai_file' : 'manual', fileKey, fileKey ? str(file.mime, 60) : null, fileKey ? str(file.name, 255) || null : null]);
      const id = ins.rows[0].id;
      await writeLines(c, id, d.lines);
      // v24.51.0: a bill filed from a vendor-bill email marks that email handled.
      const gmailId = Number(req.body?.gmailMessageId) || null;
      if (gmailId) await c.query(`UPDATE parts_vendor_invoices SET gmail_message_id=$2,source_method='gmail' WHERE id=$1`, [id, gmailId]).then(() => c.query(`UPDATE gmail_finance_messages SET status='reviewed',handled_by=$2,handled_at=now() WHERE id=$1 AND status='new'`, [gmailId, req.user.username]));
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
    if (['credit', 'journal'].includes(kindOf(r))) fail(409, 'This entry was made from Parts → Cores. Change it there (Reopen the core).');
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
        if (isOwnShopName(d.vendor)) fail(400, 'The vendor is the company you bought from — not your own shop. Check the letterhead at the top of the bill.');
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
    const b = req.body || {}, on = ymd(b.paidOn) || new Date().toISOString().slice(0, 10);
    // v24.63.0: a vendor credit is used by taking it off one of that vendor's bills (or the vendor refunds it).
    if (kindOf(r) === 'credit' && b.applyToBillId) {
      const t = (await db.query('SELECT id,vendor,invoice_number,bill_kind,status,paid_at FROM parts_vendor_invoices WHERE id=$1::bigint', [Number(b.applyToBillId) || 0])).rows[0];
      if (!t || ['credit', 'journal'].includes(t.bill_kind) || t.status === 'void') fail(400, 'Choose one of this vendor\'s bills.');
      if (nameKey(t.vendor) !== nameKey(r.vendor)) fail(400, 'A vendor credit can only be used on a bill from the same vendor.');
      await db.query(`UPDATE parts_vendor_invoices SET paid_at=$2::timestamptz,payment_method='other',paid_reference=$3,paid_by=$4,updated_at=now(),updated_by=$4,qb_status=$5,
          raw_extract=coalesce(raw_extract,'{}'::jsonb)||jsonb_build_object('appliedToBillId',$6::bigint) WHERE id=$1`,
        [r.id, `${on}T12:00:00Z`, `Applied to bill #${t.invoice_number || t.id}`, req.user.username, touchQb(r), t.id]);
      await audit(req.user.username, 'vendor_credit_applied', { id: Number(r.id), billId: Number(t.id), amount: money(r.total) });
      return { ok: true };
    }
    const method = PAYMENT_METHODS[b.method] ? b.method : null;
    if (!method) fail(400, 'Choose how it was paid.');
    await db.query('UPDATE parts_vendor_invoices SET paid_at=$2::timestamptz,payment_method=$3,paid_reference=$4,paid_by=$5,updated_at=now(),updated_by=$5,qb_status=$6 WHERE id=$1',
      [r.id, `${on}T12:00:00Z`, method, str(b.reference, 160) || null, req.user.username, touchQb(r)]);
    await audit(req.user.username, 'bill_paid', { id: Number(r.id), method, paidOn: on, total: money(r.total) });
    return { ok: true };
  }));
  app.delete('/api/bills/:id/payment', auth, perm, wrap(async (db, req) => {
    const { r } = await loadBill(db, req.params.id);
    if ((r.bill_kind || 'bill') === 'expense') fail(409, 'An expense is paid when it is entered. Change it to a Bill first if it is not paid.');
    if (kindOf(r) === 'journal') fail(409, 'This entry has nothing to pay.');
    await db.query(`UPDATE parts_vendor_invoices SET paid_at=NULL,paid_reference=NULL,paid_by=NULL,updated_at=now(),updated_by=$2,qb_status=$3,raw_extract=CASE WHEN raw_extract ? 'appliedToBillId' THEN raw_extract-'appliedToBillId' ELSE raw_extract END WHERE id=$1`, [r.id, req.user.username, touchQb(r)]);
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
