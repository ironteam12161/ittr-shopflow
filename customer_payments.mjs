// ITTR ShopFlow v24.49.0: one payment from a customer for several invoices (or a lump sum).
// A customer payment (Zelle, check, ACH …) is recorded once in customer_payments and split into ordinary invoice
// payments (customer_invoice_payments.customer_payment_id), so invoice balances, reports and payment search work as
// before. What is not applied stays on the customer as credit and can be applied to invoices later.

const money = v => Math.round((Number(v) || 0) * 100) / 100;
const str = (v, n = 200) => String(v ?? '').replace(/[<>]/g, '').trim().slice(0, n);

export async function ensureCustomerPaymentSchema(pool) {
  await pool.query(`
  CREATE TABLE IF NOT EXISTS customer_payments(
    id BIGSERIAL PRIMARY KEY, customer_id BIGINT, customer_name TEXT NOT NULL,
    amount NUMERIC NOT NULL CHECK(amount>0), method TEXT, reference TEXT, note TEXT,
    paid_at TIMESTAMPTZ DEFAULT now(), received_by TEXT NOT NULL, gmail_message_id BIGINT, created_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_customer_payments_customer ON customer_payments(customer_id,paid_at DESC);
  ALTER TABLE customer_invoice_payments ADD COLUMN IF NOT EXISTS customer_payment_id BIGINT REFERENCES customer_payments(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_customer_invoice_payments_cp ON customer_invoice_payments(customer_payment_id) WHERE customer_payment_id IS NOT NULL;`);
}

// Check a split before saving: every invoice belongs to the customer, is open, and gets no more than it owes; the
// splits never add up to more than the money available. Returns cleaned allocations.
export function checkAllocations(allocations, invoices, available) {
  const byId = new Map(invoices.map(i => [String(i.id), i])), seen = new Set(), out = [];
  for (const a of Array.isArray(allocations) ? allocations : []) {
    const amount = money(a?.amount); if (amount <= 0) continue;
    const id = String(a?.invoiceId ?? ''), inv = byId.get(id);
    if (!inv) throw Object.assign(new Error('One of the invoices is not an open invoice of this customer. Refresh and try again.'), { status: 409 });
    if (seen.has(id)) throw Object.assign(new Error(`Invoice ${inv.invoice_number} is listed twice.`), { status: 400 });
    seen.add(id);
    if (amount > money(inv.balance_due) + 0.009) throw Object.assign(new Error(`Invoice ${inv.invoice_number} only owes $${money(inv.balance_due).toFixed(2)}.`), { status: 409 });
    out.push({ invoiceId: id, invoiceNumber: inv.invoice_number, amount });
  }
  const total = money(out.reduce((s, a) => s + a.amount, 0));
  if (total > money(available) + 0.009) throw Object.assign(new Error(`The invoices add up to $${total.toFixed(2)}, more than the $${money(available).toFixed(2)} available.`), { status: 400 });
  return { allocations: out, total };
}

// deps: auth, managerPermission, requireDb, audit, recalcInvoice, paymentMethod
export function registerCustomerPaymentRoutes(app, deps) {
  const { auth, managerPermission, requireDb, audit, recalcInvoice, paymentMethod } = deps;
  const perm = managerPermission('invoices');
  const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, code }); };
  const wrap = fn => async (req, res, next) => {
    if (!/^\d+$/.test(String(req.params.id || ''))) return res.status(404).json({ error: 'Customer not found.' });
    const db = await requireDb().connect();
    try { await db.query('BEGIN'); const out = await fn(db, req); await db.query('COMMIT'); res.json(out); }
    catch (e) { try { await db.query('ROLLBACK'); } catch (_) {} if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code }); next(e); }
    finally { db.release(); }
  };
  const customerOf = async (db, id) => { const c = (await db.query('SELECT id,customer_name FROM fullbay_import_customers WHERE id=$1::bigint', [id])).rows[0]; if (!c) fail(404, 'Customer not found.'); return c; };
  // Invoices of the customer: by id, or by name on invoices that were never linked to a customer record.
  const openInvoices = (db, c, lock = false) => db.query(`SELECT id,invoice_number,invoice_date,due_date,unit_number,status,total,amount_paid,balance_due FROM customer_invoices
    WHERE (customer_id=$1::bigint OR (customer_id IS NULL AND lower(trim(customer_name))=lower(trim($2)))) AND status IN ('draft','sent','partial') AND balance_due>0.009
    ORDER BY invoice_date,id${lock ? ' FOR UPDATE' : ''}`, [c.id, c.customer_name]).then(r => r.rows);
  const credits = (db, c, lock = false) => db.query(`SELECT cp.*,cp.amount-coalesce((SELECT sum(p.amount) FROM customer_invoice_payments p WHERE p.customer_payment_id=cp.id),0) remaining
    FROM customer_payments cp WHERE cp.customer_id=$1::bigint ORDER BY cp.paid_at,cp.id${lock ? ' FOR UPDATE' : ''}`, [c.id]).then(r => r.rows.map(x => ({ ...x, remaining: money(x.remaining) })));
  const view = (c, invoices, cr) => ({
    customer: { id: Number(c.id), name: c.customer_name },
    openInvoices: invoices.map(i => ({ id: Number(i.id), invoiceNumber: i.invoice_number, invoiceDate: i.invoice_date, dueDate: i.due_date, unit: i.unit_number || '', status: i.status, total: money(i.total), paid: money(i.amount_paid), balance: money(i.balance_due) })),
    openBalance: money(invoices.reduce((s, i) => s + money(i.balance_due), 0)),
    credits: cr.filter(x => x.remaining > 0.009).map(x => ({ id: Number(x.id), paidAt: x.paid_at, method: x.method || '', reference: x.reference || '', amount: money(x.amount), remaining: x.remaining })),
    creditTotal: money(cr.reduce((s, x) => s + Math.max(0, x.remaining), 0)),
  });
  async function applyTo(db, req, cp, allocations, noteText) {
    for (const a of allocations) {
      await db.query(`INSERT INTO customer_invoice_payments(invoice_id,amount,method,reference,note,paid_at,received_by,customer_payment_id) VALUES($1::bigint,$2::numeric,$3,$4,$5,$6,$7,$8)`,
        [a.invoiceId, a.amount, cp.method, cp.reference, noteText, cp.paid_at, req.user.username, cp.id]);
      await db.query('UPDATE customer_invoices SET amount_paid=amount_paid+$2::numeric,updated_at=now() WHERE id=$1::bigint', [a.invoiceId, a.amount]);
      await recalcInvoice(db, a.invoiceId);
    }
  }

  app.get('/api/customers/:id/receivables', auth, perm, wrap(async (db, req) => {
    const c = await customerOf(db, req.params.id);
    return view(c, await openInvoices(db, c), await credits(db, c));
  }));

  // Receive one payment and split it across invoices; the rest stays as customer credit.
  app.post('/api/customers/:id/receive-payment', auth, perm, wrap(async (db, req) => {
    const c = await customerOf(db, req.params.id), b = req.body || {};
    const amount = money(b.amount); if (amount <= 0) fail(400, 'Enter the amount received.');
    const method = paymentMethod(b.method), reference = method === 'Cash' ? '' : str(b.reference, 160), note = str(b.note, 2000);
    const invoices = await openInvoices(db, c, true), { allocations, total } = checkAllocations(b.allocations, invoices, amount);
    if (reference && !b.allowDuplicateReference) {
      const prior = (await db.query(`SELECT 'invoice '||i.invoice_number what FROM customer_invoice_payments p JOIN customer_invoices i ON i.id=p.invoice_id WHERE lower(p.reference)=lower($1) AND lower(coalesce(p.method,''))=lower($2)
        UNION ALL SELECT 'a payment from '||customer_name FROM customer_payments WHERE lower(reference)=lower($1) AND lower(coalesce(method,''))=lower($2) LIMIT 1`, [reference, method])).rows[0];
      if (prior) fail(409, `${method} ${reference} was already recorded on ${prior.what}.`, 'DUPLICATE_REFERENCE');
    }
    const gmailId = Number(b.gmailMessageId) || null;
    if (gmailId) { const m = (await db.query('SELECT kind,status FROM gmail_finance_messages WHERE id=$1 FOR UPDATE', [gmailId])).rows[0]; if (!m || m.kind !== 'zelle_in') fail(409, 'That email is not a received Zelle payment.'); if (m.status === 'matched') fail(409, 'This Zelle payment was already applied.', 'ALREADY_APPLIED'); }
    const paidAt = /^\d{4}-\d{2}-\d{2}$/.test(String(b.paidAt || '')) ? `${b.paidAt}T12:00:00` : null;
    const cp = (await db.query(`INSERT INTO customer_payments(customer_id,customer_name,amount,method,reference,note,paid_at,received_by,gmail_message_id) VALUES($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz,now()),$8,$9) RETURNING *`,
      [c.id, c.customer_name, amount, method, reference || null, note || null, paidAt, req.user.username, gmailId])).rows[0];
    const split = allocations.length > 1 || total < amount;
    await applyTo(db, req, cp, allocations, [split ? `Part of one $${amount.toFixed(2)} payment` : '', note].filter(Boolean).join(' · '));
    if (gmailId) await db.query(`UPDATE gmail_finance_messages SET status='matched',matched_invoice_id=$2,handled_by=$3,handled_at=now() WHERE id=$1`, [gmailId, allocations[0]?.invoiceId || null, req.user.username]);
    const credit = money(amount - total);
    await audit(req.user.username, 'customer_payment_received', { customerId: Number(c.id), paymentId: Number(cp.id), amount, method, reference, invoices: allocations.map(a => [a.invoiceNumber, a.amount]), credit, gmailMessageId: gmailId });
    return { ok: true, paymentId: Number(cp.id), applied: total, credit, ...view(c, await openInvoices(db, c), await credits(db, c)) };
  }));

  // Apply credit the customer already has (oldest payment first) to open invoices.
  app.post('/api/customers/:id/apply-credit', auth, perm, wrap(async (db, req) => {
    const c = await customerOf(db, req.params.id), cr = (await credits(db, c, true)).filter(x => x.remaining > 0.009);
    const available = money(cr.reduce((s, x) => s + x.remaining, 0));
    if (available <= 0) fail(409, 'This customer has no credit to apply.');
    const { allocations, total } = checkAllocations(req.body?.allocations, await openInvoices(db, c, true), available);
    if (!allocations.length) fail(400, 'Enter how much credit goes to each invoice.');
    for (const a of allocations) {
      let left = a.amount;
      for (const x of cr) {
        if (left <= 0.009) break; if (x.remaining <= 0.009) continue;
        const take = money(Math.min(left, x.remaining));
        await applyTo(db, req, x, [{ ...a, amount: take }], `Customer credit from ${x.method || 'payment'}${x.reference ? ` ${x.reference}` : ''} on ${new Date(x.paid_at).toISOString().slice(0, 10)}`);
        x.remaining = money(x.remaining - take); left = money(left - take);
      }
    }
    await audit(req.user.username, 'customer_credit_applied', { customerId: Number(c.id), total, invoices: allocations.map(a => [a.invoiceNumber, a.amount]) });
    return { ok: true, applied: total, ...view(c, await openInvoices(db, c), await credits(db, c)) };
  }));
}
