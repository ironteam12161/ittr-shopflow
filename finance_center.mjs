// ITTR ShopFlow v24.37.0 finance center
// Estimates, tire fees, accountant reports and Gmail (Zelle + vendor bill) inbox.
// Everything here is additive: new tables only, no changes to existing invoice data.
import crypto from 'node:crypto';
import { documentEmailHtml, sendResendEmail } from './email_templates.mjs';

export const TIRE_FEE_CODES = Object.freeze({ user: 'tire_user_fee', disposal: 'tire_disposal_fee' });
export const DEFAULT_TIRE_FEES = Object.freeze({
  userFee: 2.5,
  userFeeLabel: 'Illinois Tire User Fee',
  userFeeRetainedPerTire: 0.1,
  disposalFee: 10,
  disposalLabel: 'Tire Disposal Fee',
  taxable: false
});
const ESTIMATE_STATUSES = ['draft', 'sent', 'approved', 'declined', 'converted', 'expired'];
const LINE_TYPES = ['labor', 'part', 'fee', 'sublet', 'other'];
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const DEFAULT_GMAIL_QUERIES = Object.freeze({
  zelle: 'zelle -in:chats -in:spam',
  vendor: '(invoice OR "amount due" OR "balance due" OR statement) has:attachment -zelle -from:me -in:chats -in:spam'
});

const money = v => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const isoDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;

export async function ensureFinanceSchema(pool) {
  if (!pool) return;
  await pool.query(`
  CREATE TABLE IF NOT EXISTS shop_settings(
    setting_key TEXT PRIMARY KEY, value JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_by TEXT, updated_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS customer_estimates(
    id BIGSERIAL PRIMARY KEY, estimate_number TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','approved','declined','converted','expired')),
    customer_id BIGINT, customer_name TEXT NOT NULL DEFAULT 'Customer', customer_email TEXT,
    unit_id BIGINT, unit_number TEXT, vin TEXT, dot_number TEXT, mileage NUMERIC, po_number TEXT,
    billing_address TEXT, billing_city TEXT, billing_state TEXT, billing_postal_code TEXT,
    estimate_date DATE NOT NULL DEFAULT CURRENT_DATE, valid_until DATE,
    tax_rate NUMERIC DEFAULT 0, shop_supplies NUMERIC DEFAULT 0, environmental_fee NUMERIC DEFAULT 0,
    discount_type TEXT DEFAULT 'fixed', discount_value NUMERIC DEFAULT 0, discount NUMERIC DEFAULT 0,
    subtotal NUMERIC DEFAULT 0, taxable_subtotal NUMERIC DEFAULT 0, tax NUMERIC DEFAULT 0, total NUMERIC DEFAULT 0,
    customer_note TEXT, internal_note TEXT, decision_note TEXT, decided_at TIMESTAMPTZ, decided_by TEXT,
    converted_invoice_id BIGINT, converted_at TIMESTAMPTZ, sent_at TIMESTAMPTZ,
    created_by TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_customer_estimates_status ON customer_estimates(status,estimate_date DESC);
  CREATE INDEX IF NOT EXISTS idx_customer_estimates_customer ON customer_estimates(customer_id,estimate_date DESC);
  CREATE TABLE IF NOT EXISTS customer_estimate_lines(
    id BIGSERIAL PRIMARY KEY, estimate_id BIGINT NOT NULL REFERENCES customer_estimates(id) ON DELETE CASCADE,
    sort_order INTEGER DEFAULT 0, job_uid TEXT, job_name TEXT, parent_line_id BIGINT,
    line_type TEXT NOT NULL CHECK(line_type IN ('labor','part','fee','sublet','other')),
    description TEXT NOT NULL DEFAULT '', part_number TEXT, quantity NUMERIC NOT NULL DEFAULT 1,
    unit_price NUMERIC NOT NULL DEFAULT 0, unit_cost NUMERIC DEFAULT 0, taxable BOOLEAN DEFAULT FALSE,
    discount NUMERIC DEFAULT 0, line_total NUMERIC DEFAULT 0, inventory_part_id BIGINT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_customer_estimate_lines_estimate ON customer_estimate_lines(estimate_id,sort_order,id);
  ALTER TABLE fullbay_import_customers ADD COLUMN IF NOT EXISTS tire_disposal_exempt BOOLEAN NOT NULL DEFAULT FALSE;
  CREATE INDEX IF NOT EXISTS idx_customer_invoice_lines_fee_code ON customer_invoice_lines((metadata->>'feeCode')) WHERE metadata ? 'feeCode';
  CREATE TABLE IF NOT EXISTS gmail_accounts(
    id BIGSERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, refresh_token_enc TEXT NOT NULL,
    connected_by TEXT NOT NULL, connected_at TIMESTAMPTZ DEFAULT now(), last_sync_at TIMESTAMPTZ,
    last_sync_error TEXT, active BOOLEAN NOT NULL DEFAULT TRUE
  );
  CREATE TABLE IF NOT EXISTS gmail_oauth_states(
    state TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gmail_finance_messages(
    id BIGSERIAL PRIMARY KEY, account_id BIGINT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
    gmail_message_id TEXT NOT NULL, thread_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('zelle_in','zelle_out','vendor_bill','other')),
    from_name TEXT, from_email TEXT, subject TEXT, snippet TEXT, received_at TIMESTAMPTZ,
    amount NUMERIC, counterparty TEXT, memo TEXT, reference TEXT, attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','matched','reviewed','ignored')),
    matched_invoice_id BIGINT, matched_payment_id BIGINT, handled_by TEXT, handled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(account_id,gmail_message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_gmail_finance_messages_kind ON gmail_finance_messages(kind,status,received_at DESC);
  `);
}

// ---------------------------------------------------------------- settings
export async function getSetting(db, key, defaults) {
  const r = await db.query('SELECT value FROM shop_settings WHERE setting_key=$1', [key]);
  return { ...defaults, ...(r.rows[0]?.value || {}) };
}
export function cleanTireFeeSettings(b = {}, cur = DEFAULT_TIRE_FEES) {
  const amt = (v, fb) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1000 ? money(n) : fb; };
  return {
    userFee: amt(b.userFee, cur.userFee),
    userFeeLabel: str(b.userFeeLabel ?? cur.userFeeLabel, 80) || DEFAULT_TIRE_FEES.userFeeLabel,
    userFeeRetainedPerTire: amt(b.userFeeRetainedPerTire, cur.userFeeRetainedPerTire),
    disposalFee: amt(b.disposalFee, cur.disposalFee),
    disposalLabel: str(b.disposalLabel ?? cur.disposalLabel, 80) || DEFAULT_TIRE_FEES.disposalLabel,
    taxable: b.taxable === undefined ? !!cur.taxable : b.taxable === true
  };
}

// ---------------------------------------------------------------- tire fee lines (shared by invoices and estimates)
// "Set" semantics: the request states how many new tires were sold and how many other tires were
// disposed. A new tire always carries the user fee AND the disposal fee; other tires carry disposal only.
export function tireFeeQuantities(newTires, otherDisposed) {
  const n = Math.max(0, Math.min(500, Math.floor(num(newTires))));
  const d = Math.max(0, Math.min(500, Math.floor(num(otherDisposed))));
  return { userQty: n, disposalQty: n + d };
}
async function setTireFeeLines(db, { table, fk, parentId, newTires, otherDisposed, fees }) {
  const { userQty, disposalQty } = tireFeeQuantities(newTires, otherDisposed);
  const plan = [
    [TIRE_FEE_CODES.user, fees.userFeeLabel, userQty, fees.userFee],
    [TIRE_FEE_CODES.disposal, fees.disposalLabel, disposalQty, fees.disposalFee]
  ];
  for (const [code, label, qty, price] of plan) {
    const existing = (await db.query(`SELECT id FROM ${table} WHERE ${fk}=$1::bigint AND metadata->>'feeCode'=$2 ORDER BY id`, [parentId, code])).rows;
    if (existing.length > 1) await db.query(`DELETE FROM ${table} WHERE id = ANY($1::bigint[])`, [existing.slice(1).map(x => x.id)]);
    if (!qty) { if (existing[0]) await db.query(`DELETE FROM ${table} WHERE id=$1::bigint`, [existing[0].id]); continue; }
    const desc = `${label} (${qty} tire${qty === 1 ? '' : 's'})`;
    if (existing[0]) {
      await db.query(`UPDATE ${table} SET description=$2,quantity=$3::numeric,unit_price=$4::numeric,taxable=$5::boolean,discount=0,line_total=$3::numeric*$4::numeric,line_type='fee' WHERE id=$1::bigint`, [existing[0].id, desc, qty, price, !!fees.taxable]);
    } else {
      await db.query(`INSERT INTO ${table}(${fk},sort_order,job_name,line_type,description,quantity,unit_price,unit_cost,taxable,discount,line_total,metadata)
        VALUES($1::bigint,(SELECT coalesce(max(sort_order),0)+1 FROM ${table} WHERE ${fk}=$1::bigint),'Tire fees','fee',$2,$3::numeric,$4::numeric,0,$5::boolean,0,$3::numeric*$4::numeric,$6::jsonb)`,
      [parentId, desc, qty, price, !!fees.taxable, JSON.stringify({ feeCode: code })]);
    }
  }
  return { userQty, disposalQty };
}

// v24.38.0: tire fees belong to a specific tire part line and sit right under it in the same job:
//   Michelin XDA 11R22.5 ×4 → Tire User Fee ×4 → Tire Disposal Fee ×4
// Each fee can be switched off per line (e.g. the customer keeps the old tires → no disposal fee).
export const TIRE_PART_RE = /\btires?\b|\b\d{3}\/\d{2}\s?r\s?\d{2}(\.\d)?\b|\b1[01]r2[245](\.5)?\b|\b\d{2,3}r\d{2}\.5\b/i;
export const NOT_TIRE_RE = /\btube\b|valve|chain|gauge|\biron\b|patch|\bplug\b|repair kit|sealant|balanc|rotation|user fee|disposal|\brims?\b|lug\b/i;
export const looksLikeTire = l => TIRE_PART_RE.test(`${l.description || ''} ${l.part_number || ''}`) && !NOT_TIRE_RE.test(l.description || '');
async function tireFeeContext(db, { table, fk, parentId, customerId }) {
  const lines = (await db.query(`SELECT * FROM ${table} WHERE ${fk}=$1::bigint ORDER BY sort_order,id`, [parentId])).rows;
  const fees = lines.filter(l => l.metadata?.forLineId);
  const cust = customerId ? (await db.query('SELECT id,customer_name,tire_disposal_exempt FROM fullbay_import_customers WHERE id=$1::bigint', [customerId])).rows[0] : null;
  return {
    customer: cust ? { id: cust.id, name: cust.customer_name, disposalExempt: !!cust.tire_disposal_exempt } : null,
    legacyFeeLines: lines.filter(l => l.metadata?.feeCode && !l.metadata?.forLineId).length,
    parts: lines.filter(l => l.line_type === 'part').map(l => {
      const mine = fees.filter(f => String(f.metadata.forLineId) === String(l.id));
      const q = code => { const f = mine.find(x => x.metadata.feeCode === code); return f ? Number(f.quantity) : 0; };
      return { id: l.id, description: l.description, partNumber: l.part_number, quantity: Number(l.quantity), isTire: looksLikeTire(l), userQty: q(TIRE_FEE_CODES.user), disposalQty: q(TIRE_FEE_CODES.disposal), hasFees: mine.length > 0 };
    })
  };
}
async function setTireFeesForParts(db, { table, fk, parentId, items, fees }) {
  const out = [];
  for (const it of Array.isArray(items) ? items.slice(0, 100) : []) {
    const part = (await db.query(`SELECT * FROM ${table} WHERE id=$1::bigint AND ${fk}=$2::bigint AND line_type='part'`, [it.partLineId, parentId])).rows[0];
    if (!part) throw Object.assign(new Error('Tire line not found on this document.'), { status: 409 });
    const qty = Math.max(0, Math.min(500, Math.round(num(it.quantity))));
    const plan = [[TIRE_FEE_CODES.user, fees.userFeeLabel, it.userFee !== false ? qty : 0, fees.userFee], [TIRE_FEE_CODES.disposal, fees.disposalLabel, it.disposalFee !== false ? qty : 0, fees.disposalFee]];
    for (const [code, label, q, price] of plan) {
      const ex = (await db.query(`SELECT id FROM ${table} WHERE ${fk}=$1::bigint AND metadata->>'forLineId'=$2 AND metadata->>'feeCode'=$3 ORDER BY id`, [parentId, String(part.id), code])).rows;
      if (ex.length > 1) await db.query(`DELETE FROM ${table} WHERE id = ANY($1::bigint[])`, [ex.slice(1).map(x => x.id)]);
      if (!q) { if (ex[0]) await db.query(`DELETE FROM ${table} WHERE id=$1::bigint`, [ex[0].id]); continue; }
      if (ex[0]) await db.query(`UPDATE ${table} SET description=$2,quantity=$3::numeric,unit_price=$4::numeric,taxable=$5::boolean,discount=0,line_total=$3::numeric*$4::numeric,line_type='fee',parent_line_id=$6::bigint,job_uid=$7,job_name=$8 WHERE id=$1::bigint`,
        [ex[0].id, label, q, price, !!fees.taxable, part.parent_line_id, part.job_uid || '', part.job_name || '']);
      else await db.query(`INSERT INTO ${table}(${fk},sort_order,job_uid,job_name,parent_line_id,line_type,description,quantity,unit_price,unit_cost,taxable,discount,line_total,metadata)
        VALUES($1::bigint,$2,$3,$4,$5::bigint,'fee',$6,$7::numeric,$8::numeric,0,$9::boolean,0,$7::numeric*$8::numeric,$10::jsonb)`,
      [parentId, part.sort_order || 0, part.job_uid || '', part.job_name || '', part.parent_line_id, label, q, price, !!fees.taxable, JSON.stringify({ feeCode: code, forLineId: Number(part.id) })]);
    }
    out.push({ partLineId: Number(part.id), quantity: qty, userFee: it.userFee !== false && qty > 0, disposalFee: it.disposalFee !== false && qty > 0 });
  }
  // Per-tire fees replace the older invoice-level tire fee lines (v24.37.0) so nothing is charged twice.
  if (out.length) await db.query(`DELETE FROM ${table} WHERE ${fk}=$1::bigint AND metadata ? 'feeCode' AND NOT metadata ? 'forLineId'`, [parentId]);
  // Fee lines whose tire line was deleted are removed too.
  await db.query(`DELETE FROM ${table} f WHERE f.${fk}=$1::bigint AND f.metadata ? 'forLineId' AND NOT EXISTS (SELECT 1 FROM ${table} p WHERE p.id=(f.metadata->>'forLineId')::bigint AND p.${fk}=$1::bigint)`, [parentId]);
  return out;
}
async function rememberDisposalExempt(db, customerId, value) {
  if (customerId && typeof value === 'boolean') await db.query('UPDATE fullbay_import_customers SET tire_disposal_exempt=$2 WHERE id=$1::bigint', [customerId, value]);
}

// ---------------------------------------------------------------- estimates
async function nextEstimateNumber(db) {
  const y = new Date().getFullYear();
  await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [2461]);
  const q = await db.query('SELECT coalesce(max((regexp_match(estimate_number,$1))[1]::int),0)+1 n FROM customer_estimates WHERE estimate_number ~ $2', [`^EST-${y}-([0-9]+)$`, `^EST-${y}-[0-9]+$`]);
  return `EST-${y}-${String(Number(q.rows[0]?.n || 1)).padStart(5, '0')}`;
}
export function estimateTotals(est, lines) {
  let sub = 0, taxable = 0;
  for (const l of lines) { const t = Math.max(0, num(l.quantity) * num(l.unit_price) - num(l.discount)); sub += t; if (l.taxable) taxable += t; }
  sub = money(sub); taxable = money(taxable);
  const pre = Math.max(0, sub + money(est.shop_supplies) + money(est.environmental_fee));
  const dv = Math.max(0, money(est.discount_value));
  const discount = money(Math.min(pre, est.discount_type === 'percent' ? pre * Math.min(100, dv) / 100 : dv));
  const ratio = pre > 0 ? discount / pre : 0;
  const taxableAfter = money(Math.max(0, taxable * (1 - ratio)));
  const tax = money(taxableAfter * money(est.tax_rate) / 100);
  const subtotal = money(pre - discount);
  return { subtotal, taxable_subtotal: taxableAfter, discount, tax, total: money(subtotal + tax) };
}
async function recalcEstimate(db, id) {
  const est = (await db.query('SELECT * FROM customer_estimates WHERE id=$1::bigint FOR UPDATE', [id])).rows[0];
  if (!est) return null;
  const lines = (await db.query('SELECT quantity,unit_price,discount,taxable FROM customer_estimate_lines WHERE estimate_id=$1::bigint', [id])).rows;
  const t = estimateTotals(est, lines);
  await db.query('UPDATE customer_estimates SET subtotal=$2,taxable_subtotal=$3,discount=$4,tax=$5,total=$6,updated_at=now() WHERE id=$1::bigint', [id, t.subtotal, t.taxable_subtotal, t.discount, t.tax, t.total]);
  return { ...est, ...t };
}
async function estimateBundle(db, id) {
  const estimate = (await db.query(`SELECT e.*,c.dot_number AS customer_dot_number,c.email AS profile_customer_email,c.credit_terms AS customer_terms FROM customer_estimates e LEFT JOIN fullbay_import_customers c ON c.id=e.customer_id WHERE e.id=$1::bigint`, [id])).rows[0];
  if (!estimate) return null;
  const lines = (await db.query('SELECT * FROM customer_estimate_lines WHERE estimate_id=$1::bigint ORDER BY sort_order,id', [id])).rows;
  const invoice = estimate.converted_invoice_id ? (await db.query('SELECT id,invoice_number,status,total,balance_due FROM customer_invoices WHERE id=$1::bigint', [estimate.converted_invoice_id])).rows[0] || null : null;
  return { estimate, lines, invoice };
}
const editable = s => ['draft', 'sent'].includes(String(s));
function lineInput(b) {
  const typ = LINE_TYPES.includes(b.lineType) ? b.lineType : 'other';
  const qty = Math.max(0, Math.min(1e6, num(b.quantity))), price = Math.max(0, Math.min(1e7, num(b.unitPrice)));
  const discount = Math.min(qty * price, Math.max(0, num(b.discount)));
  return {
    typ, qty, price, discount,
    description: str(b.description, 1000), partNumber: str(b.partNumber, 120), jobName: str(b.jobName, 200),
    unitCost: Math.max(0, num(b.unitCost)), taxable: b.taxable === true,
    inventoryPartId: typ === 'part' && b.inventoryPartId ? Number(b.inventoryPartId) || null : null,
    parentLineId: typ === 'labor' ? null : (b.parentLineId ? Number(b.parentLineId) || null : null)
  };
}

// ---------------------------------------------------------------- Gmail parsing (pure; unit tested)
const collapse = s => String(s || '').replace(/\r/g, '').replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
export function htmlToText(html) {
  return collapse(String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#36;|&dollar;/gi, '$').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'"));
}
const amountFrom = s => { const m = String(s || '').match(/\$\s?([\d,]+(?:\.\d{1,2})?)/); return m ? money(m[1].replace(/,/g, '')) : null; };
const cleanName = s => str(String(s || '').replace(/[®™*]/g, '').replace(/\s+/g, ' ').replace(/[.,;:]+$/, ''), 120);
export function parseZelleEmail({ subject = '', body = '' }) {
  const text = collapse(`${subject}\n${body}`);
  if (!/zelle/i.test(text)) return null;
  const incoming = /\bsent you\b|\byou(?:'ve| have)?\s+received\b|\breceived (?:money|a payment|a zelle)|\bdeposited\b|\bhas been deposited\b/i.test(text);
  const outgoing = /\byou(?:'ve| have)?\s+sent\b|\byour payment to\b|\bpayment (?:was|has been) sent\b|\byou paid\b/i.test(text);
  if (!incoming && !outgoing) return null;
  const kind = incoming && !/^\s*you(?:'ve| have)?\s+sent\b/i.test(subject) ? 'zelle_in' : 'zelle_out';
  let amount = null;
  for (const re of [/sent you\s*\$\s?([\d,]+(?:\.\d{1,2})?)/i, /received\s*\$\s?([\d,]+(?:\.\d{1,2})?)/i, /you(?:'ve| have)?\s+sent\s*\$\s?([\d,]+(?:\.\d{1,2})?)/i, /amount\s*:?\s*\$\s?([\d,]+(?:\.\d{1,2})?)/i]) {
    const m = text.match(re); if (m) { amount = money(m[1].replace(/,/g, '')); break; }
  }
  if (amount === null) amount = amountFrom(text);
  let counterparty = '';
  const cps = kind === 'zelle_in'
    ? [/(?:^|\n)\s*([A-Za-z][A-Za-z0-9 .,&'/-]{1,60}?)\s+sent you\b/i, /received\s*\$[\d,.]+\s+from\s+([A-Za-z][A-Za-z0-9 .,&'/-]{1,60}?)(?=\s+(?:on|via|with|through)\b|[.\n]|$)/i, /\bfrom\s*:?\s+([A-Za-z][A-Za-z0-9 .,&'/-]{1,60}?)(?=[.\n]|$)/i, /\bsender\s*:?\s*([A-Za-z][A-Za-z0-9 .,&'/-]{1,60}?)(?=[.\n]|$)/i]
    : [/sent\s*\$[\d,.]+\s+to\s+([A-Za-z][A-Za-z0-9 .,&'/-]{1,60}?)(?=\s+(?:on|via|with)\b|[.\n]|$)/i, /your payment to\s+([A-Za-z][A-Za-z0-9 .,&'/-]{1,60}?)(?=\s+(?:was|has|for|on)\b|[.\n]|$)/i, /\b(?:recipient|to)\s*:\s*([A-Za-z][A-Za-z0-9 .,&'/-]{1,60}?)(?=[.\n]|$)/i];
  for (const re of cps) { const m = text.match(re); if (m && !/^(you|your|zelle|money|a payment)$/i.test(m[1].trim())) { counterparty = cleanName(m[1]); break; } }
  const memoMatch = text.match(/\b(?:memo|message|note|for)\s*:\s*["“]?([^\n"”]{1,160})/i);
  const memo = memoMatch ? str(memoMatch[1], 160) : '';
  const invoiceRef = (text.match(/\bIT-\d{4}-\d{3,6}\b/i) || [])[0] || '';
  return { kind, amount, counterparty, memo, reference: invoiceRef.toUpperCase() };
}
const GENERIC_SENDER = /^(no-?reply|do-?not-?reply|billing|accounts?(?: receivable)?|ar|invoices?|invoice|statements?|notifications?|info|support|customer service)$/i;
export function vendorNameFromSender(fromName, fromEmail) {
  const name = cleanName(String(fromName || '').replace(/["']/g, '').replace(/\s+via\s+.*$/i, ''));
  if (name && !GENERIC_SENDER.test(name) && !/@/.test(name)) return name;
  const domain = String(fromEmail || '').split('@')[1] || '';
  const parts = domain.toLowerCase().split('.').filter(p => !['mail', 'email', 'billing', 'invoices', 'notify', 'e', 'em', 'mg'].includes(p));
  const root = parts.length >= 2 ? parts[parts.length - 2] : parts[0] || '';
  return root ? root.charAt(0).toUpperCase() + root.slice(1) : (name || 'Vendor');
}
export function parseVendorBillEmail({ subject = '', body = '', fromName = '', fromEmail = '', attachments = [] }) {
  const text = collapse(`${subject}\n${body}`);
  if (/^invoice IT-\d{4}-/i.test(subject)) return null; // our own customer invoices
  const hasPdf = attachments.some(a => /pdf/i.test(a.mimeType || '') || /\.pdf$/i.test(a.filename || ''));
  if (!/invoice|amount due|balance due|statement|bill\b/i.test(text) && !hasPdf) return null;
  let amount = null;
  for (const re of [/(?:invoice total|total due|amount due|balance due|total amount|grand total|amount)\s*:?\s*\$?\s?([\d,]+\.\d{2})/i, /\btotal\s*:?\s*\$\s?([\d,]+\.\d{2})/i]) {
    const m = text.match(re); if (m) { amount = money(m[1].replace(/,/g, '')); break; }
  }
  const inv = text.match(/\binvoice\s*(?:#|no\.?|number|num)\s*:?\s*([A-Z0-9][A-Z0-9-]{2,24})/i) || text.match(/\binvoice\s+([A-Z]*\d[A-Z0-9-]{2,24})/i);
  return { kind: 'vendor_bill', amount, counterparty: vendorNameFromSender(fromName, fromEmail), memo: '', reference: inv ? inv[1].toUpperCase() : '' };
}
export function scoreZelleMatch(msg, inv) {
  let score = 0; const reasons = [];
  const memo = `${msg.memo || ''} ${msg.reference || ''}`.toUpperCase();
  if (inv.invoice_number && memo.includes(String(inv.invoice_number).toUpperCase())) { score += 100; reasons.push('invoice # in memo'); }
  else if (inv.invoice_number) { const tail = String(inv.invoice_number).match(/(\d+)$/)?.[1]?.replace(/^0+/, ''); if (tail && tail.length >= 2 && new RegExp(`(^|\\D)0*${tail}(\\D|$)`).test(memo)) { score += 35; reasons.push('invoice number in memo'); } }
  if (msg.amount != null && Math.abs(money(msg.amount) - money(inv.balance_due)) < 0.011) { score += 60; reasons.push('amount = balance due'); }
  else if (msg.amount != null && Math.abs(money(msg.amount) - money(inv.total)) < 0.011) { score += 40; reasons.push('amount = invoice total'); }
  const words = s => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !['llc', 'inc', 'corp', 'the', 'and', 'trucking', 'transport', 'logistics', 'express'].includes(w)));
  const a = words(msg.counterparty), b = words(inv.customer_name); let overlap = 0; for (const w of a) if (b.has(w)) overlap++;
  if (overlap) { score += Math.min(45, overlap * 25); reasons.push('name matches customer'); }
  if (inv.unit_number && memo.includes(String(inv.unit_number).toUpperCase()) && String(inv.unit_number).length >= 2) { score += 15; reasons.push('unit # in memo'); }
  return { score, reasons };
}

// ---------------------------------------------------------------- token crypto
function tokenKey() {
  const raw = String(process.env.GMAIL_TOKEN_KEY || '').trim();
  if (raw.length < 16) return null;
  return crypto.createHash('sha256').update(raw).digest();
}
export function encryptToken(plain, key = tokenKey()) {
  if (!key) throw Object.assign(new Error('GMAIL_TOKEN_KEY is not configured.'), { status: 503 });
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}
export function decryptToken(blob, key = tokenKey()) {
  if (!key) throw Object.assign(new Error('GMAIL_TOKEN_KEY is not configured.'), { status: 503 });
  const [v, iv, tag, enc] = String(blob || '').split('.');
  if (v !== 'v1') throw new Error('Unsupported token format.');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------- Gmail API client
const googleUrls = () => ({
  auth: process.env.GOOGLE_OAUTH_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
  token: process.env.GOOGLE_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  revoke: process.env.GOOGLE_OAUTH_REVOKE_URL || 'https://oauth2.googleapis.com/revoke',
  gmail: (process.env.GMAIL_API_BASE || 'https://gmail.googleapis.com/gmail/v1').replace(/\/$/, '')
});
function gmailConfig() {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim(), clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
  const base = String(process.env.APP_PUBLIC_URL || '').trim().replace(/\/$/, '');
  const redirectUri = String(process.env.GOOGLE_REDIRECT_URI || (base ? `${base}/api/gmail/oauth/callback` : '')).trim();
  const missing = [!clientId && 'GOOGLE_CLIENT_ID', !clientSecret && 'GOOGLE_CLIENT_SECRET', !redirectUri && 'APP_PUBLIC_URL (or GOOGLE_REDIRECT_URI)', !tokenKey() && 'GMAIL_TOKEN_KEY (16+ random characters)'].filter(Boolean);
  return { clientId, clientSecret, redirectUri, missing, configured: !missing.length };
}
async function googleJson(url, init = {}) {
  const r = await fetch(url, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(String(d?.error_description || d?.error?.message || d?.error || `Google request failed (${r.status})`).slice(0, 300)), { status: r.status === 401 ? 502 : 502, googleStatus: r.status });
  return d;
}
async function gmailAccessToken(account) {
  const cfg = gmailConfig();
  const d = await googleJson(googleUrls().token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: decryptToken(account.refresh_token_enc), grant_type: 'refresh_token' }) });
  return d.access_token;
}
const b64 = s => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
function walkParts(part, out = { plain: '', html: '', attachments: [] }) {
  if (!part) return out;
  const mime = String(part.mimeType || '');
  if (part.filename && part.body?.attachmentId) out.attachments.push({ filename: str(part.filename, 200), mimeType: mime, size: num(part.body.size), attachmentId: part.body.attachmentId });
  else if (mime === 'text/plain' && part.body?.data) out.plain += b64(part.body.data) + '\n';
  else if (mime === 'text/html' && part.body?.data) out.html += b64(part.body.data) + '\n';
  for (const p of part.parts || []) walkParts(p, out);
  return out;
}
export function parseFromHeader(v) {
  const s = String(v || ''); const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim(), email: m[2].trim().toLowerCase() } : { name: '', email: s.trim().toLowerCase() };
}
export function classifyGmailMessage(msg) {
  const headers = Object.fromEntries((msg.payload?.headers || []).map(h => [String(h.name).toLowerCase(), h.value]));
  const parts = walkParts(msg.payload);
  const body = parts.plain.trim() ? collapse(parts.plain) : htmlToText(parts.html);
  const from = parseFromHeader(headers.from), subject = str(headers.subject, 300);
  const base = { gmailMessageId: msg.id, threadId: msg.threadId, fromName: from.name, fromEmail: from.email, subject, snippet: str(htmlToText(msg.snippet || ''), 300), receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null, attachments: parts.attachments };
  const z = parseZelleEmail({ subject, body });
  if (z) return { ...base, ...z };
  const v = parseVendorBillEmail({ subject, body, fromName: from.name, fromEmail: from.email, attachments: parts.attachments });
  if (v) return { ...base, ...v };
  return null;
}

// ---------------------------------------------------------------- reports
export function reportRange(q = {}) {
  const today = new Date(); const y = today.getUTCFullYear();
  let from = isoDate(q.from), to = isoDate(q.to);
  if (!from) from = `${y}-01-01`;
  if (!to) to = today.toISOString().slice(0, 10);
  if (from > to) [from, to] = [to, from];
  return { from, to };
}
const BILLED = "i.status IN ('sent','partial','paid')";
const FEE_CLASS = `CASE
  WHEN l.metadata->>'feeCode'='${TIRE_FEE_CODES.user}' OR l.description ~* 'tire\\s*user\\s*fee' THEN 'tire_user_fee'
  WHEN l.metadata->>'feeCode'='${TIRE_FEE_CODES.disposal}' OR l.description ~* 'tire\\s*(disposal|recycl)' THEN 'tire_disposal_fee'
  WHEN l.line_type='labor' THEN 'labor'
  WHEN l.line_type='part' THEN 'parts'
  WHEN l.line_type='sublet' THEN 'sublet'
  ELSE 'fees_other' END`;

export async function buildFinanceReport(db, range) {
  const { from, to } = range, P = [from, to];
  const q = async (sql, params = P) => (await db.query(sql, params)).rows;
  const tire = await getSetting(db, 'tire_fees', DEFAULT_TIRE_FEES);

  const [k] = await q(`SELECT count(*)::int invoices, coalesce(sum(i.total),0) billed, coalesce(sum(i.subtotal),0) sales, coalesce(sum(i.tax),0) tax,
      coalesce(sum(i.discount),0) discounts, coalesce(sum(i.shop_supplies),0) shop_supplies, coalesce(sum(i.environmental_fee),0) environmental_fees,
      coalesce(avg(i.total),0) avg_invoice
    FROM customer_invoices i WHERE ${BILLED} AND i.invoice_date BETWEEN $1::date AND $2::date`);
  const [paid] = await q(`SELECT coalesce(sum(p.amount),0) collected, count(*)::int payments FROM customer_invoice_payments p JOIN customer_invoices i ON i.id=p.invoice_id
    WHERE i.status<>'void' AND p.paid_at::date BETWEEN $1::date AND $2::date`);
  const [ar] = await q(`SELECT coalesce(sum(balance_due),0) outstanding, count(*)::int open_invoices,
      coalesce(sum(balance_due) FILTER (WHERE coalesce(due_date,invoice_date)<CURRENT_DATE),0) overdue,
      count(*) FILTER (WHERE coalesce(due_date,invoice_date)<CURRENT_DATE)::int overdue_invoices
    FROM customer_invoices WHERE status IN ('sent','partial') AND balance_due>0.009`, []);
  const [drafts] = await q(`SELECT count(*)::int n, coalesce(sum(total),0) total FROM customer_invoices WHERE status='draft'`, []);

  const categories = await q(`SELECT ${FEE_CLASS} category, coalesce(sum(l.line_total),0) amount, coalesce(sum(l.quantity),0) qty,
      coalesce(sum(CASE WHEN l.line_type='part' THEN l.quantity*coalesce(nullif(l.unit_cost,0),p.cost,0) ELSE 0 END),0) cost
    FROM customer_invoice_lines l JOIN customer_invoices i ON i.id=l.invoice_id LEFT JOIN fullbay_import_parts p ON p.id=l.inventory_part_id
    WHERE ${BILLED} AND i.invoice_date BETWEEN $1::date AND $2::date GROUP BY 1`);
  const cat = Object.fromEntries(categories.map(c => [c.category, { amount: money(c.amount), qty: num(c.qty), cost: money(c.cost) }]));
  const catv = (k2, f = 'amount') => cat[k2]?.[f] || 0;

  const monthly = await q(`WITH m AS (SELECT generate_series(date_trunc('month',$1::date),date_trunc('month',$2::date),interval '1 month')::date m)
    SELECT to_char(m.m,'YYYY-MM') AS month,
      coalesce((SELECT sum(l.line_total) FROM customer_invoice_lines l JOIN customer_invoices i ON i.id=l.invoice_id WHERE ${BILLED} AND date_trunc('month',i.invoice_date)=m.m AND l.line_type='labor'),0) labor,
      coalesce((SELECT sum(l.line_total) FROM customer_invoice_lines l JOIN customer_invoices i ON i.id=l.invoice_id WHERE ${BILLED} AND date_trunc('month',i.invoice_date)=m.m AND l.line_type='part' AND NOT (l.description ~* 'tire\\s*(user\\s*fee|disposal|recycl)' OR l.metadata ? 'feeCode')),0) parts,
      coalesce((SELECT sum(l.line_total) FROM customer_invoice_lines l JOIN customer_invoices i ON i.id=l.invoice_id WHERE ${BILLED} AND date_trunc('month',i.invoice_date)=m.m AND (l.line_type NOT IN ('labor','part') OR l.description ~* 'tire\\s*(user\\s*fee|disposal|recycl)' OR l.metadata ? 'feeCode')),0)
        + coalesce((SELECT sum(i.shop_supplies+i.environmental_fee-i.discount) FROM customer_invoices i WHERE ${BILLED} AND date_trunc('month',i.invoice_date)=m.m),0) other,
      coalesce((SELECT sum(i.tax) FROM customer_invoices i WHERE ${BILLED} AND date_trunc('month',i.invoice_date)=m.m),0) tax,
      coalesce((SELECT sum(i.total) FROM customer_invoices i WHERE ${BILLED} AND date_trunc('month',i.invoice_date)=m.m),0) billed,
      coalesce((SELECT sum(p.amount) FROM customer_invoice_payments p JOIN customer_invoices i ON i.id=p.invoice_id WHERE i.status<>'void' AND date_trunc('month',p.paid_at)=m.m),0) collected,
      coalesce((SELECT sum(v.total) FROM parts_vendor_invoices v WHERE coalesce(v.status,'')<>'void' AND date_trunc('month',coalesce(v.invoice_date,v.received_at::date,v.created_at::date))=m.m),0) parts_purchased
    FROM m ORDER BY m.m LIMIT 36`);

  const aging = await q(`SELECT CASE WHEN d<=0 THEN 'current' WHEN d<=30 THEN '1-30' WHEN d<=60 THEN '31-60' WHEN d<=90 THEN '61-90' ELSE '90+' END bucket,
      count(*)::int n, coalesce(sum(balance_due),0) amount
    FROM (SELECT balance_due, CURRENT_DATE-coalesce(due_date,invoice_date) d FROM customer_invoices WHERE status IN ('sent','partial') AND balance_due>0.009) x GROUP BY 1`, []);
  const agingOrder = ['current', '1-30', '31-60', '61-90', '90+'];
  const agingOut = agingOrder.map(b => { const r = aging.find(a => a.bucket === b); return { bucket: b, count: r?.n || 0, amount: money(r?.amount) }; });

  const customersOwing = await q(`SELECT coalesce(customer_id::text,'name:'||lower(customer_name)) key, max(customer_name) customer_name, max(customer_id) customer_id,
      count(*)::int invoices, sum(balance_due) balance, min(coalesce(due_date,invoice_date)) oldest_due,
      max(CURRENT_DATE-coalesce(due_date,invoice_date))::int days_past_due,
      sum(balance_due) FILTER (WHERE coalesce(due_date,invoice_date)<CURRENT_DATE) overdue
    FROM customer_invoices WHERE status IN ('sent','partial') AND balance_due>0.009 GROUP BY 1 ORDER BY sum(balance_due) DESC LIMIT 100`, []);
  const openInvoices = await q(`SELECT id,invoice_number,customer_name,unit_number,invoice_date,due_date,total,amount_paid,balance_due,status,
      (CURRENT_DATE-coalesce(due_date,invoice_date))::int days_past_due
    FROM customer_invoices WHERE status IN ('sent','partial') AND balance_due>0.009 ORDER BY coalesce(due_date,invoice_date),id LIMIT 300`, []);

  const partsUsage = await q(`SELECT coalesce(max(nullif(l.part_number,'')),max(p.part_number),'') part_number, max(l.description) description,
      count(DISTINCT l.invoice_id)::int times_used, sum(l.quantity) qty, sum(l.line_total) revenue,
      sum(l.quantity*coalesce(nullif(l.unit_cost,0),p.cost,0)) cost, max(i.invoice_date) last_used
    FROM customer_invoice_lines l JOIN customer_invoices i ON i.id=l.invoice_id LEFT JOIN fullbay_import_parts p ON p.id=l.inventory_part_id
    WHERE ${BILLED} AND i.invoice_date BETWEEN $1::date AND $2::date AND l.line_type='part' AND NOT (l.metadata ? 'feeCode')
    GROUP BY coalesce(l.inventory_part_id::text, nullif(lower(trim(l.part_number)),''), lower(trim(l.description)))
    ORDER BY sum(l.quantity*coalesce(nullif(l.unit_cost,0),p.cost,0)) DESC, sum(l.line_total) DESC LIMIT 200`);

  const vendorSpend = await q(`SELECT coalesce(nullif(trim(vendor),''),'Unknown vendor') vendor, count(*)::int bills, coalesce(sum(subtotal),0) subtotal,
      coalesce(sum(tax),0) tax, coalesce(sum(freight),0) freight, coalesce(sum(total),0) total, max(coalesce(invoice_date,received_at::date)) last_bill
    FROM parts_vendor_invoices WHERE coalesce(status,'')<>'void' AND coalesce(invoice_date,received_at::date,created_at::date) BETWEEN $1::date AND $2::date
    GROUP BY 1 ORDER BY sum(total) DESC NULLS LAST LIMIT 100`);
  const vendorBills = await q(`SELECT id,vendor,invoice_number,coalesce(invoice_date,received_at::date) invoice_date,subtotal,tax,freight,total
    FROM parts_vendor_invoices WHERE coalesce(status,'')<>'void' AND coalesce(invoice_date,received_at::date,created_at::date) BETWEEN $1::date AND $2::date ORDER BY 4 DESC,id DESC LIMIT 500`);

  const paymentMethods = await q(`SELECT coalesce(nullif(trim(p.method),''),'Other') method, count(*)::int n, sum(p.amount) amount
    FROM customer_invoice_payments p JOIN customer_invoices i ON i.id=p.invoice_id WHERE i.status<>'void' AND p.paid_at::date BETWEEN $1::date AND $2::date GROUP BY 1 ORDER BY 3 DESC`);

  const tireMonthly = await q(`SELECT to_char(date_trunc('month',i.invoice_date),'YYYY-MM') AS month, ${FEE_CLASS} category, sum(l.quantity) qty, sum(l.line_total) amount
    FROM customer_invoice_lines l JOIN customer_invoices i ON i.id=l.invoice_id
    WHERE ${BILLED} AND i.invoice_date BETWEEN $1::date AND $2::date AND (l.metadata ? 'feeCode' OR l.description ~* 'tire\\s*(user\\s*fee|disposal|recycl)')
    GROUP BY 1,2 ORDER BY 1`);
  const userQty = catv('tire_user_fee', 'qty'), disposalQty = catv('tire_disposal_fee', 'qty');

  const topCustomers = await q(`WITH billed AS (
      SELECT coalesce(i.customer_id::text,'name:'||lower(i.customer_name)) k, max(i.customer_name) customer_name, max(i.customer_id) customer_id, count(*)::int invoices, sum(i.total) billed
      FROM customer_invoices i WHERE ${BILLED} AND i.invoice_date BETWEEN $1::date AND $2::date GROUP BY 1),
    owed AS (SELECT coalesce(customer_id::text,'name:'||lower(customer_name)) k, sum(balance_due) balance FROM customer_invoices WHERE status IN ('sent','partial') GROUP BY 1)
    SELECT b.*, coalesce(o.balance,0) balance FROM billed b LEFT JOIN owed o ON o.k=b.k ORDER BY b.billed DESC LIMIT 15`);

  const estimates = await q(`SELECT status, count(*)::int n, coalesce(sum(total),0) total FROM customer_estimates WHERE estimate_date BETWEEN $1::date AND $2::date GROUP BY status`);

  const partsRevenue = catv('parts'), partsCost = catv('parts', 'cost');
  const purchased = vendorSpend.reduce((a, v) => a + num(v.total), 0);
  return {
    range, generatedAt: new Date().toISOString(),
    tireSettings: tire,
    kpis: {
      invoices: k.invoices, billed: money(k.billed), sales: money(k.sales), tax: money(k.tax), discounts: money(k.discounts), avgInvoice: money(k.avg_invoice),
      collected: money(paid.collected), payments: paid.payments,
      outstanding: money(ar.outstanding), openInvoices: ar.open_invoices, overdue: money(ar.overdue), overdueInvoices: ar.overdue_invoices,
      draftInvoices: drafts.n, draftValue: money(drafts.total),
      labor: catv('labor'), laborHours: catv('labor', 'qty'), parts: partsRevenue, partsCost, partsMargin: money(partsRevenue - partsCost),
      partsMarginPct: partsRevenue > 0 ? Math.round((partsRevenue - partsCost) / partsRevenue * 1000) / 10 : 0,
      sublet: catv('sublet'), otherFees: money(catv('fees_other') + num(k.shop_supplies) + num(k.environmental_fees)),
      partsPurchased: money(purchased)
    },
    revenueMix: [
      { key: 'labor', label: 'Labor', amount: catv('labor') },
      { key: 'parts', label: 'Parts', amount: partsRevenue },
      { key: 'tire_fees', label: 'Tire fees', amount: money(catv('tire_user_fee') + catv('tire_disposal_fee')) },
      { key: 'sublet', label: 'Sublet', amount: catv('sublet') },
      { key: 'other', label: 'Shop supplies & other', amount: money(catv('fees_other') + num(k.shop_supplies) + num(k.environmental_fees)) }
    ],
    monthly: monthly.map(m => ({ month: m.month, labor: money(m.labor), parts: money(m.parts), other: money(m.other), tax: money(m.tax), billed: money(m.billed), collected: money(m.collected), partsPurchased: money(m.parts_purchased) })),
    aging: agingOut,
    customersOwing: customersOwing.map(c => ({ customerId: c.customer_id, customerName: c.customer_name, invoices: c.invoices, balance: money(c.balance), overdue: money(c.overdue), oldestDue: c.oldest_due, daysPastDue: Math.max(0, num(c.days_past_due)) })),
    openInvoices: openInvoices.map(i => ({ ...i, total: money(i.total), amount_paid: money(i.amount_paid), balance_due: money(i.balance_due) })),
    partsUsage: partsUsage.map(p => ({ partNumber: p.part_number, description: p.description, timesUsed: p.times_used, qty: num(p.qty), revenue: money(p.revenue), cost: money(p.cost), margin: money(num(p.revenue) - num(p.cost)), lastUsed: p.last_used })),
    vendorSpend: vendorSpend.map(v => ({ vendor: v.vendor, bills: v.bills, subtotal: money(v.subtotal), tax: money(v.tax), freight: money(v.freight), total: money(v.total), lastBill: v.last_bill })),
    vendorBills: vendorBills.map(v => ({ ...v, subtotal: money(v.subtotal), tax: money(v.tax), freight: money(v.freight), total: money(v.total) })),
    paymentMethods: paymentMethods.map(p => ({ method: p.method, count: p.n, amount: money(p.amount) })),
    tireFees: {
      userFeeQty: userQty, userFeeAmount: catv('tire_user_fee'), disposalQty, disposalAmount: catv('tire_disposal_fee'),
      totalAmount: money(catv('tire_user_fee') + catv('tire_disposal_fee')),
      userFeeRetained: money(userQty * num(tire.userFeeRetainedPerTire)),
      userFeeToRemit: money(catv('tire_user_fee') - userQty * num(tire.userFeeRetainedPerTire)),
      monthly: tireMonthly.map(t => ({ month: t.month, category: t.category, qty: num(t.qty), amount: money(t.amount) }))
    },
    topCustomers: topCustomers.map(c => ({ customerName: c.customer_name, customerId: c.customer_id, invoices: c.invoices, billed: money(c.billed), balance: money(c.balance) })),
    estimates: ESTIMATE_STATUSES.map(s => { const r = estimates.find(e => e.status === s); return { status: s, count: r?.n || 0, total: money(r?.total) }; })
  };
}

// ---------------------------------------------------------------- routes
export function registerFinanceRoutes(app, deps) {
  const { auth, ownerOnly, managerPermission, requireDb, audit, recalcInvoice, nextInvoiceNumber, PDFDocument, renderCustomerDocumentPdf, shopProfile, logoPath, dateText } = deps;
  const invoicesPerm = managerPermission('invoices'), reportsPerm = managerPermission('reports');
  const tx = handler => async (req, res, next) => {
    const db = await requireDb().connect();
    try { await db.query('BEGIN'); const out = await handler(db, req, res); if (!res.headersSent) { await db.query('COMMIT'); res.json(out); } else await db.query('ROLLBACK').catch(() => {}); }
    catch (e) { try { await db.query('ROLLBACK'); } catch {} if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code }); next(e); }
    finally { db.release(); }
  };
  const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, code }); };
  const read = handler => async (req, res, next) => { try { res.json(await handler(requireDb(), req, res)); } catch (e) { if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code }); next(e); } };

  // ----- settings
  app.get('/api/finance/settings', auth, invoicesPerm, read(async db => ({ tireFees: await getSetting(db, 'tire_fees', DEFAULT_TIRE_FEES), gmail: { ...(await getSetting(db, 'gmail_queries', DEFAULT_GMAIL_QUERIES)), ...gmailPublicStatus() } })));
  app.put('/api/finance/settings/tire-fees', auth, ownerOnly, read(async (db, req) => {
    const cur = await getSetting(db, 'tire_fees', DEFAULT_TIRE_FEES), next = cleanTireFeeSettings(req.body || {}, cur);
    await db.query(`INSERT INTO shop_settings(setting_key,value,updated_by,updated_at) VALUES('tire_fees',$1::jsonb,$2,now()) ON CONFLICT(setting_key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`, [JSON.stringify(next), req.user.username]);
    await audit(req.user.username, 'tire_fee_settings_changed', next);
    return { ok: true, tireFees: next };
  }));
  app.put('/api/finance/settings/gmail-queries', auth, ownerOnly, read(async (db, req) => {
    const next = { zelle: str(req.body?.zelle, 400) || DEFAULT_GMAIL_QUERIES.zelle, vendor: str(req.body?.vendor, 400) || DEFAULT_GMAIL_QUERIES.vendor };
    await db.query(`INSERT INTO shop_settings(setting_key,value,updated_by,updated_at) VALUES('gmail_queries',$1::jsonb,$2,now()) ON CONFLICT(setting_key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`, [JSON.stringify(next), req.user.username]);
    return { ok: true, gmail: next };
  }));

  // ----- tire fees on invoices
  app.get('/api/invoices/:id/tire-fees', auth, invoicesPerm, read(async (db, req) => {
    const inv = (await db.query('SELECT id,customer_id,status FROM customer_invoices WHERE id=$1::bigint', [req.params.id])).rows[0];
    if (!inv) fail(404, 'Invoice not found.');
    return { settings: await getSetting(db, 'tire_fees', DEFAULT_TIRE_FEES), locked: !['draft', 'sent', 'partial'].includes(inv.status), ...(await tireFeeContext(db, { table: 'customer_invoice_lines', fk: 'invoice_id', parentId: inv.id, customerId: inv.customer_id })) };
  }));
  app.post('/api/invoices/:id/tire-fees', auth, invoicesPerm, tx(async (db, req) => {
    const inv = (await db.query('SELECT * FROM customer_invoices WHERE id=$1::bigint FOR UPDATE', [req.params.id])).rows[0];
    if (!inv) fail(404, 'Invoice not found.');
    if (!['draft', 'sent', 'partial'].includes(inv.status)) fail(409, 'Paid or void invoices are locked.');
    const fees = await getSetting(db, 'tire_fees', DEFAULT_TIRE_FEES);
    const r = Array.isArray(req.body?.items)
      ? { items: await setTireFeesForParts(db, { table: 'customer_invoice_lines', fk: 'invoice_id', parentId: inv.id, items: req.body.items, fees }) }
      : await setTireFeeLines(db, { table: 'customer_invoice_lines', fk: 'invoice_id', parentId: inv.id, newTires: req.body?.newTires, otherDisposed: req.body?.otherDisposed, fees });
    await rememberDisposalExempt(db, inv.customer_id, req.body?.rememberDisposalExempt);
    await recalcInvoice(db, inv.id);
    await audit(req.user.username, 'invoice_tire_fees_set', { invoiceId: inv.id, ...r });
    return { ok: true, ...r };
  }));

  // ----- estimates
  app.get('/api/estimates', auth, invoicesPerm, read(async (db, req) => {
    const status = ESTIMATE_STATUSES.includes(String(req.query.status || '')) ? String(req.query.status) : '';
    const q = str(req.query.q, 120);
    // Past-due sent estimates are shown as expired without mutating history.
    const rows = (await db.query(`SELECT id,estimate_number,CASE WHEN status='sent' AND valid_until<CURRENT_DATE THEN 'expired' ELSE status END status,customer_id,customer_name,unit_number,vin,estimate_date,valid_until,total,converted_invoice_id,created_by,updated_at
      FROM customer_estimates WHERE ($1='' OR status=$1) AND ($2='' OR customer_name ILIKE '%'||$2||'%' OR estimate_number ILIKE '%'||$2||'%' OR coalesce(unit_number,'') ILIKE '%'||$2||'%' OR coalesce(vin,'') ILIKE '%'||$2||'%')
      ORDER BY estimate_date DESC,id DESC LIMIT 500`, [status, q])).rows;
    const stats = (await db.query(`SELECT status,count(*)::int n,coalesce(sum(total),0) total FROM customer_estimates GROUP BY status`)).rows;
    return { items: rows, stats };
  }));
  app.get('/api/estimates/:id', auth, invoicesPerm, read(async (db, req) => { const x = await estimateBundle(db, req.params.id); if (!x) fail(404, 'Estimate not found.'); return x; }));
  app.post('/api/estimates', auth, invoicesPerm, tx(async (db, req) => {
    const b = req.body || {};
    let c = null; if (b.customerId) c = (await db.query('SELECT * FROM fullbay_import_customers WHERE id=$1::bigint', [b.customerId])).rows[0] || null;
    const num2 = await nextEstimateNumber(db), days = Math.max(1, Math.min(180, Math.floor(num(b.validDays) || 30)));
    const r = await db.query(`INSERT INTO customer_estimates(estimate_number,customer_id,customer_name,customer_email,unit_id,unit_number,vin,dot_number,mileage,po_number,estimate_date,valid_until,tax_rate,billing_address,billing_city,billing_state,billing_postal_code,customer_note,internal_note,created_by)
      VALUES($1,$2::bigint,$3,$4,$5::bigint,$6,$7,$8,$9::numeric,$10,CURRENT_DATE,CURRENT_DATE+$11::int,$12::numeric,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [num2, c?.id || null, str(b.customerName || c?.customer_name || 'Customer', 200), str(b.customerEmail || c?.email || '', 254) || null, b.unitId || null, str(b.unitNumber, 60), str(b.vin, 40), str(b.dotNumber || c?.dot_number || '', 20), num(b.mileage) || null, str(b.poNumber, 80),
      days, Math.max(0, Math.min(25, num(b.taxRate))), c?.billing_address || c?.address || null, c?.billing_city || c?.city || null, c?.billing_state || c?.state || null, c?.billing_postal_code || c?.postal_code || null, str(b.customerNote, 4000), str(b.internalNote, 4000), req.user.username]);
    await audit(req.user.username, 'estimate_created', { estimateId: r.rows[0].id, estimateNumber: num2 });
    return { ok: true, id: r.rows[0].id, estimateNumber: num2 };
  }));
  app.put('/api/estimates/:id', auth, invoicesPerm, tx(async (db, req) => {
    const cur = (await db.query('SELECT * FROM customer_estimates WHERE id=$1::bigint FOR UPDATE', [req.params.id])).rows[0];
    if (!cur) fail(404, 'Estimate not found.');
    const b = req.body || {};
    if (b.status !== undefined && b.status !== cur.status) {
      const to = String(b.status);
      if (cur.status === 'converted') fail(409, 'This estimate is already converted to an invoice.');
      if (!['draft', 'sent', 'approved', 'declined'].includes(to)) fail(400, 'Unsupported estimate status.');
      await db.query(`UPDATE customer_estimates SET status=$2,decision_note=CASE WHEN $2 IN ('approved','declined') THEN $3 ELSE decision_note END,
        decided_at=CASE WHEN $2 IN ('approved','declined') THEN now() ELSE NULL END,decided_by=CASE WHEN $2 IN ('approved','declined') THEN $4 ELSE NULL END,
        sent_at=CASE WHEN $2='sent' THEN coalesce(sent_at,now()) ELSE sent_at END,updated_at=now() WHERE id=$1::bigint`, [cur.id, to, str(b.decisionNote, 1000), req.user.username]);
      await audit(req.user.username, 'estimate_status_changed', { estimateId: cur.id, from: cur.status, to });
    }
    const hasHeader = ['customerName', 'customerId', 'customerEmail', 'unitNumber', 'vin', 'mileage', 'poNumber', 'validUntil', 'taxRate', 'shopSupplies', 'environmentalFee', 'discountType', 'discountValue', 'customerNote', 'internalNote', 'estimateDate'].some(k => b[k] !== undefined);
    if (hasHeader) {
      if (!editable(cur.status) && cur.status !== 'approved') fail(409, 'Declined or converted estimates are locked.');
      let c = null; if (b.customerId) c = (await db.query('SELECT * FROM fullbay_import_customers WHERE id=$1::bigint', [b.customerId])).rows[0] || null;
      await db.query(`UPDATE customer_estimates SET customer_id=$2::bigint,customer_name=$3,customer_email=$4,unit_number=$5,vin=$6,mileage=$7::numeric,po_number=$8,valid_until=$9::date,tax_rate=$10::numeric,
        shop_supplies=$11::numeric,environmental_fee=$12::numeric,discount_type=$13,discount_value=$14::numeric,customer_note=$15,internal_note=$16,estimate_date=$17::date,updated_at=now() WHERE id=$1::bigint`,
      [cur.id, b.customerId === undefined ? cur.customer_id : (Number(b.customerId) || null), str(b.customerName ?? c?.customer_name ?? cur.customer_name, 200) || 'Customer', str(b.customerEmail ?? cur.customer_email ?? '', 254) || null, str(b.unitNumber ?? cur.unit_number, 60), str(b.vin ?? cur.vin, 40),
        b.mileage !== undefined ? (num(b.mileage) || null) : cur.mileage, str(b.poNumber ?? cur.po_number, 80), isoDate(b.validUntil) || cur.valid_until, Math.max(0, Math.min(25, num(b.taxRate ?? cur.tax_rate))),
        Math.max(0, num(b.shopSupplies ?? cur.shop_supplies)), Math.max(0, num(b.environmentalFee ?? cur.environmental_fee)), b.discountType === 'percent' ? 'percent' : (b.discountType === 'fixed' ? 'fixed' : cur.discount_type || 'fixed'),
        Math.max(0, num(b.discountValue ?? cur.discount_value)), str(b.customerNote ?? cur.customer_note, 4000), str(b.internalNote ?? cur.internal_note, 4000), isoDate(b.estimateDate) || cur.estimate_date]);
    }
    await recalcEstimate(db, cur.id);
    return { ok: true };
  }));
  app.delete('/api/estimates/:id', auth, invoicesPerm, tx(async (db, req) => {
    const cur = (await db.query('SELECT * FROM customer_estimates WHERE id=$1::bigint FOR UPDATE', [req.params.id])).rows[0];
    if (!cur) fail(404, 'Estimate not found.');
    if (cur.status === 'converted') fail(409, 'Converted estimates are kept for history.');
    await db.query('DELETE FROM customer_estimates WHERE id=$1::bigint', [cur.id]);
    await audit(req.user.username, 'estimate_deleted', { estimateId: cur.id, estimateNumber: cur.estimate_number });
    return { ok: true };
  }));
  const lockedEstimate = async (db, id) => {
    const est = (await db.query('SELECT * FROM customer_estimates WHERE id=$1::bigint FOR UPDATE', [id])).rows[0];
    if (!est) fail(404, 'Estimate not found.');
    if (!editable(est.status)) fail(409, `This estimate is ${est.status}. Move it back to draft to edit lines.`);
    return est;
  };
  const resolveParent = async (db, estId, l) => {
    if (!l.parentLineId) return { parentLineId: null, jobUid: l.typ === 'labor' ? crypto.randomUUID() : '', jobName: l.jobName };
    const p = (await db.query(`SELECT id,job_uid,job_name FROM customer_estimate_lines WHERE id=$1::bigint AND estimate_id=$2::bigint AND line_type='labor'`, [l.parentLineId, estId])).rows[0];
    if (!p) fail(409, 'Parent labor operation not found.');
    return { parentLineId: p.id, jobUid: p.job_uid || '', jobName: p.job_name || l.jobName };
  };
  app.post('/api/estimates/:id/lines', auth, invoicesPerm, tx(async (db, req) => {
    const est = await lockedEstimate(db, req.params.id), l = lineInput(req.body || {}), p = await resolveParent(db, est.id, l);
    const r = await db.query(`INSERT INTO customer_estimate_lines(estimate_id,sort_order,job_uid,job_name,parent_line_id,line_type,description,part_number,quantity,unit_price,unit_cost,taxable,discount,line_total,inventory_part_id,metadata)
      VALUES($1::bigint,(SELECT coalesce(max(sort_order),0)+1 FROM customer_estimate_lines WHERE estimate_id=$1::bigint),$2,$3,$4::bigint,$5,$6,$7,$8::numeric,$9::numeric,$10::numeric,$11::boolean,$12::numeric,greatest(0,$8::numeric*$9::numeric-$12::numeric),$13::bigint,'{}'::jsonb) RETURNING id`,
    [est.id, p.jobUid, p.jobName || (l.typ === 'labor' ? l.description : ''), p.parentLineId, l.typ, l.description || (l.typ === 'labor' ? 'Labor' : 'Item'), l.partNumber, l.qty, l.price, l.unitCost, l.taxable, l.discount, l.inventoryPartId]);
    await recalcEstimate(db, est.id);
    return { ok: true, id: r.rows[0].id };
  }));
  app.put('/api/estimates/:id/lines/:lineId', auth, invoicesPerm, tx(async (db, req) => {
    const est = await lockedEstimate(db, req.params.id), old = (await db.query('SELECT * FROM customer_estimate_lines WHERE id=$1::bigint AND estimate_id=$2::bigint', [req.params.lineId, est.id])).rows[0];
    if (!old) fail(404, 'Estimate line not found.');
    const l = lineInput({ ...req.body, lineType: req.body?.lineType || old.line_type });
    const p = l.typ === 'labor' ? { parentLineId: null, jobUid: old.job_uid || crypto.randomUUID(), jobName: l.description || old.job_name } : await resolveParent(db, est.id, l);
    await db.query(`UPDATE customer_estimate_lines SET line_type=$3,description=$4,part_number=$5,quantity=$6::numeric,unit_price=$7::numeric,unit_cost=$8::numeric,taxable=$9::boolean,discount=$10::numeric,
      line_total=greatest(0,$6::numeric*$7::numeric-$10::numeric),parent_line_id=$11::bigint,job_uid=$12,job_name=$13,inventory_part_id=$14::bigint WHERE id=$1::bigint AND estimate_id=$2::bigint`,
    [old.id, est.id, l.typ, l.description || old.description, l.partNumber, l.qty, l.price, l.unitCost, l.taxable, l.discount, p.parentLineId, p.jobUid, p.jobName, l.inventoryPartId]);
    if (l.typ === 'labor') await db.query('UPDATE customer_estimate_lines SET job_name=$3 WHERE estimate_id=$1::bigint AND parent_line_id=$2::bigint', [est.id, old.id, p.jobName]);
    await recalcEstimate(db, est.id);
    return { ok: true };
  }));
  app.delete('/api/estimates/:id/lines/:lineId', auth, invoicesPerm, tx(async (db, req) => {
    const est = await lockedEstimate(db, req.params.id);
    await db.query(`DELETE FROM customer_estimate_lines WHERE estimate_id=$1::bigint AND (id=$2::bigint OR parent_line_id=$2::bigint OR metadata->>'forLineId'=$2::text)`, [est.id, req.params.lineId]);
    await recalcEstimate(db, est.id);
    return { ok: true };
  }));
  app.get('/api/estimates/:id/tire-fees', auth, invoicesPerm, read(async (db, req) => {
    const est = (await db.query('SELECT id,customer_id,status FROM customer_estimates WHERE id=$1::bigint', [req.params.id])).rows[0];
    if (!est) fail(404, 'Estimate not found.');
    return { settings: await getSetting(db, 'tire_fees', DEFAULT_TIRE_FEES), locked: !editable(est.status), ...(await tireFeeContext(db, { table: 'customer_estimate_lines', fk: 'estimate_id', parentId: est.id, customerId: est.customer_id })) };
  }));
  app.post('/api/estimates/:id/tire-fees', auth, invoicesPerm, tx(async (db, req) => {
    const est = await lockedEstimate(db, req.params.id), fees = await getSetting(db, 'tire_fees', DEFAULT_TIRE_FEES);
    const r = Array.isArray(req.body?.items)
      ? { items: await setTireFeesForParts(db, { table: 'customer_estimate_lines', fk: 'estimate_id', parentId: est.id, items: req.body.items, fees }) }
      : await setTireFeeLines(db, { table: 'customer_estimate_lines', fk: 'estimate_id', parentId: est.id, newTires: req.body?.newTires, otherDisposed: req.body?.otherDisposed, fees });
    await rememberDisposalExempt(db, est.customer_id, req.body?.rememberDisposalExempt);
    await recalcEstimate(db, est.id);
    return { ok: true, ...r };
  }));
  app.post('/api/estimates/:id/convert', auth, invoicesPerm, tx(async (db, req) => {
    const est = (await db.query('SELECT * FROM customer_estimates WHERE id=$1::bigint FOR UPDATE', [req.params.id])).rows[0];
    if (!est) fail(404, 'Estimate not found.');
    if (est.status === 'converted' && est.converted_invoice_id) return { ok: true, id: est.converted_invoice_id, existing: true };
    if (est.status === 'declined') fail(409, 'Declined estimates cannot be invoiced. Move it back to draft first.');
    const lines = (await db.query('SELECT * FROM customer_estimate_lines WHERE estimate_id=$1::bigint ORDER BY sort_order,id', [est.id])).rows;
    if (!lines.length) fail(409, 'Add at least one line before converting the estimate.');
    const c = est.customer_id ? (await db.query('SELECT credit_terms FROM fullbay_import_customers WHERE id=$1::bigint', [est.customer_id])).rows[0] : null;
    const terms = String(c?.credit_terms || 'Due on Receipt'), days = /60/.test(terms) ? 60 : /45/.test(terms) ? 45 : /30/.test(terms) ? 30 : /15/.test(terms) ? 15 : 0;
    const invoiceNumber = await nextInvoiceNumber(db);
    const inv = (await db.query(`INSERT INTO customer_invoices(invoice_number,customer_id,customer_name,customer_email,unit_id,unit_number,vin,dot_number,mileage,po_number,invoice_date,due_date,terms,tax_rate,shop_supplies,environmental_fee,discount_type,discount_value,billing_address,billing_city,billing_state,billing_postal_code,customer_note,internal_note,created_by)
      VALUES($1,$2::bigint,$3,$4,$5::bigint,$6,$7,$8,$9::numeric,$10,CURRENT_DATE,CURRENT_DATE+$11::int,$12,$13::numeric,$14::numeric,$15::numeric,$16,$17::numeric,$18,$19,$20,$21,$22,$23,$24) RETURNING id`,
    [invoiceNumber, est.customer_id, est.customer_name, est.customer_email, est.unit_id, est.unit_number || '', est.vin || '', est.dot_number || '', est.mileage, est.po_number || '', days, terms, est.tax_rate, est.shop_supplies, est.environmental_fee, est.discount_type || 'fixed', est.discount_value || 0,
      est.billing_address, est.billing_city, est.billing_state, est.billing_postal_code, est.customer_note || '', [`Created from estimate ${est.estimate_number}.`, est.internal_note || ''].filter(Boolean).join('\n'), req.user.username])).rows[0];
    const idMap = new Map();
    const ordered = [...lines.filter(l => l.line_type === 'labor'), ...lines.filter(l => l.line_type !== 'labor')];
    for (const l of ordered) {
      const meta = { ...(l.metadata || {}), estimateId: Number(est.id), estimateLineId: Number(l.id) };
      if (l.inventory_part_id) meta.inventoryPartId = Number(l.inventory_part_id);
      if (meta.forLineId) meta.forLineId = idMap.get(String(meta.forLineId)) || null;
      const r = await db.query(`INSERT INTO customer_invoice_lines(invoice_id,sort_order,job_uid,job_name,line_type,description,part_number,quantity,unit_price,unit_cost,taxable,discount,discount_type,discount_value,line_total,parent_line_id,inventory_part_id,stock_posted_qty,metadata)
        VALUES($1::bigint,$2,$3,$4,$5,$6,$7,$8::numeric,$9::numeric,$10::numeric,$11::boolean,$12::numeric,'fixed',$12::numeric,$13::numeric,$14::bigint,$15::bigint,0,$16::jsonb) RETURNING id`,
      [inv.id, l.sort_order, l.job_uid || '', l.job_name || '', l.line_type, l.description, l.part_number || '', l.quantity, l.unit_price, l.unit_cost || 0, !!l.taxable, l.discount || 0, l.line_total, l.parent_line_id ? idMap.get(String(l.parent_line_id)) || null : null, l.inventory_part_id, JSON.stringify(meta)]);
      idMap.set(String(l.id), r.rows[0].id);
    }
    await recalcInvoice(db, inv.id);
    await db.query(`UPDATE customer_estimates SET status='converted',converted_invoice_id=$2::bigint,converted_at=now(),decided_at=coalesce(decided_at,now()),decided_by=coalesce(decided_by,$3),updated_at=now() WHERE id=$1::bigint`, [est.id, inv.id, req.user.username]);
    await audit(req.user.username, 'estimate_converted', { estimateId: est.id, estimateNumber: est.estimate_number, invoiceId: inv.id, invoiceNumber });
    return { ok: true, id: inv.id, invoiceNumber };
  }));
  const estimatePdf = x => renderCustomerDocumentPdf({ PDFDocument, kind: 'ESTIMATE', invoice: { ...x.estimate, status: x.estimate.status === 'converted' ? 'approved' : x.estimate.status }, lines: x.lines, payments: [], shop: shopProfile(), logoPath, text: v => String(v ?? ''), dateText });
  const estimateMessage = e => { const shop = shopProfile(); return `Hello${e.customer_name ? ` ${String(e.customer_name).split(/\s+/).slice(0, 3).join(' ')}` : ''},\n\nThank you for the opportunity to quote your repair. Estimate ${e.estimate_number}${e.unit_number ? ` for Unit ${e.unit_number}` : ''} is attached.\n\nReply to this email or call us${shop.phone ? ` at ${shop.phone}` : ''} to approve the work.\n\nThank you,\n${shop.name}`; };
  app.get('/api/estimates/:id/email-draft', auth, invoicesPerm, read(async (db, req) => {
    const x = await estimateBundle(db, req.params.id); if (!x) fail(404, 'Estimate not found.');
    const e = x.estimate; return { to: e.customer_email || e.profile_customer_email || '', subject: `Estimate ${e.estimate_number} from ${shopProfile().name}${e.unit_number ? ` — Unit ${e.unit_number}` : ''}`, message: estimateMessage(e), configured: Boolean(process.env.RESEND_API_KEY && process.env.INVOICE_FROM_EMAIL) };
  }));
  app.post('/api/estimates/:id/email', auth, invoicesPerm, read(async (db, req) => {
    const x = await estimateBundle(db, req.params.id); if (!x) fail(404, 'Estimate not found.');
    const e = x.estimate, list = v => String(v || '').split(/[,;\s]+/).map(a => a.trim().toLowerCase()).filter(Boolean), ok = a => a.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a);
    const to = list(req.body?.to || e.customer_email || e.profile_customer_email), cc = list(req.body?.cc);
    if (!to.length) fail(400, 'Customer email is required.'); const bad = [...to, ...cc].find(a => !ok(a)); if (bad) fail(400, `"${bad}" is not a valid email address.`);
    const subject = str(req.body?.subject || `Estimate ${e.estimate_number} from ${shopProfile().name}`, 200).replace(/[\r\n]+/g, ' '), message = String(req.body?.message || estimateMessage(e)).slice(0, 5000);
    const base = String(process.env.APP_PUBLIC_URL || '').replace(/\/$/, ''), shop = shopProfile();
    const r = await sendResendEmail({ to, cc, subject, text: message, replyTo: String(process.env.INVOICE_REPLY_TO || shop.email || ''), idempotencyKey: `estimate-${e.id}-${str(req.body?.requestId, 80).replace(/[^A-Za-z0-9_-]/g, '') || crypto.randomUUID()}`,
      html: documentEmailHtml({ kind: 'estimate', doc: e, lines: x.lines, message, shop, logoUrl: base ? `${base}/assets/iron-team-logo.png` : '', accent: String(process.env.SHOP_ACCENT_COLOR || '#c2410c') }),
      attachments: [{ filename: `${String(e.estimate_number).replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`, content: (await estimatePdf(x)).toString('base64') }], tags: [{ name: 'document', value: 'estimate' }] });
    if (!r.ok) fail(502, r.error);
    await db.query(`UPDATE customer_estimates SET customer_email=$2,status=CASE WHEN status='draft' THEN 'sent' ELSE status END,sent_at=coalesce(sent_at,now()),updated_at=now() WHERE id=$1::bigint`, [e.id, to[0]]);
    await audit(req.user.username, 'estimate_emailed', { estimateId: e.id, to, cc, resendId: r.id });
    return { ok: true, id: r.id, to };
  }));
  app.get('/api/estimates/:id/pdf', auth, invoicesPerm, async (req, res, next) => {
    try {
      const x = await estimateBundle(requireDb(), req.params.id); if (!x) return res.status(404).json({ error: 'Estimate not found.' });
      const buf = await renderCustomerDocumentPdf({ PDFDocument, kind: 'ESTIMATE', invoice: { ...x.estimate, status: x.estimate.status === 'converted' ? 'approved' : x.estimate.status }, lines: x.lines, payments: [], shop: shopProfile(), logoPath, text: v => String(v ?? ''), dateText });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${String(x.estimate.estimate_number).replace(/[^A-Za-z0-9_-]/g, '_')}.pdf"`);
      res.send(buf);
    } catch (e) { next(e); }
  });

  // ----- reports
  app.get('/api/reports/finance', auth, reportsPerm, invoicesPerm, read(async (db, req) => buildFinanceReport(db, reportRange(req.query))));

  // ----- Gmail
  function gmailPublicStatus() { const c = gmailConfig(); return { configured: c.configured, missing: c.missing, redirectUri: c.redirectUri }; }
  app.get('/api/gmail/status', auth, invoicesPerm, read(async db => {
    const accounts = (await db.query('SELECT id,email,connected_by,connected_at,last_sync_at,last_sync_error,active FROM gmail_accounts ORDER BY connected_at')).rows;
    const counts = (await db.query(`SELECT kind,status,count(*)::int n,coalesce(sum(amount),0) amount FROM gmail_finance_messages GROUP BY kind,status`)).rows;
    return { ...gmailPublicStatus(), accounts, counts };
  }));
  app.post('/api/gmail/connect', auth, ownerOnly, read(async (db, req) => {
    const cfg = gmailConfig(); if (!cfg.configured) fail(503, `Gmail is not configured. Add ${cfg.missing.join(', ')} in Railway.`, 'GMAIL_NOT_CONFIGURED');
    const state = crypto.randomBytes(24).toString('base64url');
    await db.query("DELETE FROM gmail_oauth_states WHERE expires_at<now()");
    await db.query("INSERT INTO gmail_oauth_states(state,username,expires_at) VALUES($1,$2,now()+interval '10 minutes')", [state, req.user.username]);
    const u = new URL(googleUrls().auth);
    Object.entries({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', scope: GMAIL_SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state }).forEach(([k, v]) => u.searchParams.set(k, v));
    return { url: u.toString() };
  }));
  // Browser redirect from Google: no bearer token here, so the single-use state proves who started it.
  app.get('/api/gmail/oauth/callback', async (req, res) => {
    const done = (status, msg) => res.redirect(302, `/?gmail=${status}${msg ? `&gmailMessage=${encodeURIComponent(String(msg).slice(0, 200))}` : ''}`);
    try {
      const db = requireDb(), state = str(req.query.state, 200), code = str(req.query.code, 2000);
      if (req.query.error) return done('error', `Google: ${req.query.error}`);
      const st = (await db.query('DELETE FROM gmail_oauth_states WHERE state=$1 AND expires_at>now() RETURNING username', [state])).rows[0];
      if (!st || !code) return done('error', 'The Gmail sign-in link expired. Try Connect Gmail again.');
      const cfg = gmailConfig();
      const tok = await googleJson(googleUrls().token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: 'authorization_code' }) });
      if (!tok.refresh_token) return done('error', 'Google did not return offline access. Remove ITTR from your Google account permissions and connect again.');
      const profile = await googleJson(`${googleUrls().gmail}/users/me/profile`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
      const email = str(profile.emailAddress, 254).toLowerCase();
      await db.query(`INSERT INTO gmail_accounts(email,refresh_token_enc,connected_by) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET refresh_token_enc=excluded.refresh_token_enc,connected_by=excluded.connected_by,connected_at=now(),active=true,last_sync_error=NULL`, [email, encryptToken(tok.refresh_token), st.username]);
      await audit(st.username, 'gmail_connected', { email });
      return done('connected', email);
    } catch (e) { console.error('Gmail OAuth callback', e?.message); return done('error', e?.message || 'Gmail connection failed.'); }
  });
  app.delete('/api/gmail/accounts/:id', auth, ownerOnly, read(async (db, req) => {
    const a = (await db.query('SELECT * FROM gmail_accounts WHERE id=$1::bigint', [req.params.id])).rows[0]; if (!a) fail(404, 'Gmail account not found.');
    try { await fetch(`${googleUrls().revoke}?token=${encodeURIComponent(decryptToken(a.refresh_token_enc))}`, { method: 'POST' }); } catch (_) { /* revoke is best effort */ }
    await db.query('DELETE FROM gmail_accounts WHERE id=$1::bigint', [a.id]);
    await audit(req.user.username, 'gmail_disconnected', { email: a.email });
    return { ok: true };
  }));
  async function listIds(token, query, max = 200) {
    const ids = []; let pageToken = '';
    while (ids.length < max) {
      const u = new URL(`${googleUrls().gmail}/users/me/messages`); u.searchParams.set('q', query); u.searchParams.set('maxResults', '100'); if (pageToken) u.searchParams.set('pageToken', pageToken);
      const d = await googleJson(u, { headers: { Authorization: `Bearer ${token}` } });
      (d.messages || []).forEach(m => ids.push(m.id)); pageToken = d.nextPageToken; if (!pageToken) break;
    }
    return ids.slice(0, max);
  }
  async function syncAccount(db, account, queries) {
    const token = await gmailAccessToken(account);
    const window = account.last_sync_at ? ` after:${Math.floor(new Date(account.last_sync_at).getTime() / 1000) - 3 * 86400}` : ' newer_than:120d';
    const known = new Set((await db.query('SELECT gmail_message_id FROM gmail_finance_messages WHERE account_id=$1', [account.id])).rows.map(r => r.gmail_message_id));
    const ids = [...new Set([...(await listIds(token, queries.zelle + window)), ...(await listIds(token, queries.vendor + window))])].filter(id => !known.has(id));
    let added = 0;
    for (const id of ids) {
      const msg = await googleJson(`${googleUrls().gmail}/users/me/messages/${encodeURIComponent(id)}?format=full`, { headers: { Authorization: `Bearer ${token}` } });
      const x = classifyGmailMessage(msg); if (!x) continue;
      const r = await db.query(`INSERT INTO gmail_finance_messages(account_id,gmail_message_id,thread_id,kind,from_name,from_email,subject,snippet,received_at,amount,counterparty,memo,reference,attachments)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::numeric,$11,$12,$13,$14::jsonb) ON CONFLICT(account_id,gmail_message_id) DO NOTHING`,
      [account.id, x.gmailMessageId, x.threadId, x.kind, x.fromName, x.fromEmail, x.subject, x.snippet, x.receivedAt, x.amount, x.counterparty, x.memo, x.reference, JSON.stringify(x.attachments)]);
      added += r.rowCount;
    }
    await db.query('UPDATE gmail_accounts SET last_sync_at=now(),last_sync_error=NULL WHERE id=$1', [account.id]);
    return { email: account.email, scanned: ids.length, added };
  }
  app.post('/api/gmail/sync', auth, invoicesPerm, read(async (db, req) => {
    if (!gmailConfig().configured) fail(503, `Gmail is not configured. Add ${gmailConfig().missing.join(', ')} in Railway.`, 'GMAIL_NOT_CONFIGURED');
    const accounts = (await db.query('SELECT * FROM gmail_accounts WHERE active=true ORDER BY id')).rows;
    if (!accounts.length) fail(409, 'Connect a Gmail account first.');
    const queries = await getSetting(db, 'gmail_queries', DEFAULT_GMAIL_QUERIES), results = [];
    for (const a of accounts) {
      try { results.push(await syncAccount(db, a, queries)); }
      catch (e) { const m = str(e?.message || 'Sync failed', 400); await db.query('UPDATE gmail_accounts SET last_sync_error=$2 WHERE id=$1', [a.id, m]); results.push({ email: a.email, error: m }); }
    }
    await audit(req.user.username, 'gmail_synced', { results });
    return { ok: true, results };
  }));
  app.get('/api/gmail/messages', auth, invoicesPerm, read(async (db, req) => {
    const kind = ['zelle_in', 'zelle_out', 'vendor_bill'].includes(String(req.query.kind)) ? String(req.query.kind) : '';
    const status = ['new', 'matched', 'reviewed', 'ignored'].includes(String(req.query.status)) ? String(req.query.status) : '';
    const rows = (await db.query(`SELECT m.id,m.kind,m.from_name,m.from_email,m.subject,m.snippet,m.received_at,m.amount,m.counterparty,m.memo,m.reference,m.status,m.matched_invoice_id,
        m.handled_by,m.handled_at,a.email account_email,i.invoice_number matched_invoice_number,
        (SELECT json_agg(json_build_object('index',o.ord-1,'filename',o.a->>'filename','mimeType',o.a->>'mimeType','size',o.a->>'size')) FROM jsonb_array_elements(m.attachments) WITH ORDINALITY o(a,ord)) attachments
      FROM gmail_finance_messages m JOIN gmail_accounts a ON a.id=m.account_id LEFT JOIN customer_invoices i ON i.id=m.matched_invoice_id
      WHERE ($1='' OR m.kind=$1) AND ($2='' OR m.status=$2) ORDER BY m.received_at DESC NULLS LAST,m.id DESC LIMIT 300`, [kind, status])).rows;
    const open = (await db.query(`SELECT id,invoice_number,customer_name,unit_number,total,balance_due FROM customer_invoices WHERE status IN ('sent','partial','draft') AND balance_due>0.009 ORDER BY invoice_date DESC LIMIT 500`)).rows;
    for (const m of rows) if (m.kind === 'zelle_in' && m.status === 'new') m.suggestions = open.map(inv => ({ ...scoreZelleMatch(m, inv), invoice: inv })).filter(s => s.score >= 40).sort((a, b) => b.score - a.score).slice(0, 4);
    return { items: rows };
  }));
  app.post('/api/gmail/messages/:id/apply-payment', auth, invoicesPerm, tx(async (db, req) => {
    const m = (await db.query('SELECT * FROM gmail_finance_messages WHERE id=$1::bigint FOR UPDATE', [req.params.id])).rows[0];
    if (!m) fail(404, 'Email not found.');
    if (m.kind !== 'zelle_in') fail(409, 'Only received Zelle payments can be applied to an invoice.');
    if (m.status === 'matched') fail(409, 'This Zelle payment was already applied.', 'ALREADY_APPLIED');
    const inv = (await db.query('SELECT * FROM customer_invoices WHERE id=$1::bigint FOR UPDATE', [req.body?.invoiceId])).rows[0];
    if (!inv || inv.status === 'void') fail(409, 'Invoice is missing or void.');
    const amount = money(req.body?.amount ?? m.amount);
    if (amount <= 0) fail(400, 'Payment amount must be greater than zero.');
    if (amount > money(inv.balance_due) + 0.01) fail(409, `Payment ($${amount.toFixed(2)}) is more than the balance due ($${money(inv.balance_due).toFixed(2)}).`);
    const p = (await db.query(`INSERT INTO customer_invoice_payments(invoice_id,amount,method,reference,note,paid_at,received_by) VALUES($1::bigint,$2::numeric,'Zelle',$3,$4,coalesce($5::timestamptz,now()),$6) RETURNING id`,
      [inv.id, amount, str(`Zelle ${m.counterparty || ''}`.trim(), 160), str(`From Gmail (${m.subject || 'Zelle'})${m.memo ? ` · Memo: ${m.memo}` : ''}`, 2000), m.received_at, req.user.username])).rows[0];
    await db.query('UPDATE customer_invoices SET amount_paid=amount_paid+$2::numeric,updated_at=now() WHERE id=$1::bigint', [inv.id, amount]);
    await recalcInvoice(db, inv.id);
    await db.query(`UPDATE gmail_finance_messages SET status='matched',matched_invoice_id=$2,matched_payment_id=$3,handled_by=$4,handled_at=now() WHERE id=$1`, [m.id, inv.id, p.id, req.user.username]);
    await audit(req.user.username, 'gmail_zelle_applied', { messageId: m.id, invoiceId: inv.id, invoiceNumber: inv.invoice_number, amount });
    return { ok: true, paymentId: p.id };
  }));
  app.post('/api/gmail/messages/:id/status', auth, invoicesPerm, read(async (db, req) => {
    const to = String(req.body?.status || '');
    if (!['new', 'reviewed', 'ignored'].includes(to)) fail(400, 'Unsupported status.');
    const r = await db.query(`UPDATE gmail_finance_messages SET status=$2,handled_by=$3,handled_at=now() WHERE id=$1::bigint AND status<>'matched' RETURNING id`, [req.params.id, to, req.user.username]);
    if (!r.rowCount) fail(409, 'Applied payments cannot be changed here.');
    return { ok: true };
  }));
  app.get('/api/gmail/messages/:id/attachments/:index', auth, invoicesPerm, async (req, res, next) => {
    try {
      const db = requireDb(), m = (await db.query('SELECT m.*,a.refresh_token_enc,a.email FROM gmail_finance_messages m JOIN gmail_accounts a ON a.id=m.account_id WHERE m.id=$1::bigint', [req.params.id])).rows[0];
      const att = m?.attachments?.[Number(req.params.index)];
      if (!att?.attachmentId) return res.status(404).json({ error: 'Attachment not found.' });
      const token = await gmailAccessToken(m);
      const d = await googleJson(`${googleUrls().gmail}/users/me/messages/${encodeURIComponent(m.gmail_message_id)}/attachments/${encodeURIComponent(att.attachmentId)}`, { headers: { Authorization: `Bearer ${token}` } });
      const safeType = /^(application\/pdf|image\/(png|jpe?g|gif|webp)|text\/csv)$/i.test(att.mimeType || '') ? att.mimeType : 'application/octet-stream';
      res.setHeader('Content-Type', safeType);
      res.setHeader('Content-Disposition', `${safeType === 'application/octet-stream' ? 'attachment' : 'inline'}; filename="${String(att.filename || 'attachment').replace(/[^A-Za-z0-9._-]/g, '_')}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(Buffer.from(String(d.data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    } catch (e) { if (e?.status) return res.status(e.status).json({ error: e.message }); next(e); }
  });
}
