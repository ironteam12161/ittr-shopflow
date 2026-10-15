// v24.54.0: fleet customer portal. One private, revocable link per customer (default 180 days) shows that customer's
// units, open estimates (approve online), invoices (PDF, pay online, what is owed) and recent service. It reuses the
// customer-link token rules; every lookup is limited to the customer the link was made for.
import { findActiveLink, createCustomerLink, publicBaseUrl } from './customer_links.mjs';

const money = v => Math.round(Number(v || 0) * 100) / 100;
// Invoices and estimates belong to the customer by id; older imported ones only by name.
const OWN = (alias) => `(${alias}.customer_id=$1::bigint OR (${alias}.customer_id IS NULL AND lower(trim(${alias}.customer_name))=lower(trim($2))))`;

export async function portalView(db, link, { shopInfo }) {
  const c = (await db.query('SELECT id,customer_name FROM fullbay_import_customers WHERE id=$1::bigint', [link.ref_id])).rows[0]; if (!c) return null;
  const args = [c.id, c.customer_name || ''];
  const units = (await db.query(`SELECT unit_number,vin,year,make,model FROM customer_units WHERE customer_id=$1::bigint ORDER BY unit_number LIMIT 300`, [c.id]).catch(() => ({ rows: [] }))).rows;
  const invoices = (await db.query(`SELECT i.id,i.invoice_number,i.invoice_date,i.due_date,i.status,i.total,i.balance_due,i.unit_number,i.payment_url FROM customer_invoices i
    WHERE ${OWN('i')} AND i.status NOT IN ('draft','void') ORDER BY i.invoice_date DESC,i.id DESC LIMIT 150`, args)).rows;
  const estimates = (await db.query(`SELECT e.id,e.estimate_number,e.estimate_date,e.valid_until,e.status,e.total,e.unit_number,e.customer_decided_at FROM customer_estimates e
    WHERE ${OWN('e')} AND e.status IN ('sent','approved','declined') ORDER BY e.estimate_date DESC,e.id DESC LIMIT 50`, args)).rows;
  const last = {};
  for (const i of invoices) { const u = String(i.unit_number || '').toLowerCase(); if (u && !last[u]) last[u] = i.invoice_date; }
  const today = new Date(new Date().toDateString());
  const inv = invoices.map(i => { const bal = money(i.balance_due), due = i.due_date ? new Date(i.due_date) : null;
    return { id: Number(i.id), number: i.invoice_number, date: i.invoice_date, dueDate: i.due_date, status: bal <= 0.004 ? 'paid' : i.status === 'partial' ? 'partly paid' : 'open', total: money(i.total), balance: bal, unit: i.unit_number || '',
      overdueDays: bal > 0.004 && due && due < today ? Math.round((today - due) / 86400000) : 0, payUrl: bal > 0.004 && /^https:\/\//.test(i.payment_url || '') ? i.payment_url : '' }; });
  return { kind: 'portal', shop: shopInfo(), customer: { name: c.customer_name },
    owed: money(inv.reduce((a, i) => a + i.balance, 0)), overdue: money(inv.filter(i => i.overdueDays > 0).reduce((a, i) => a + i.balance, 0)),
    units: units.map(u => ({ unit: u.unit_number, vin: u.vin || '', description: [u.year, u.make, u.model].filter(Boolean).join(' '), lastService: last[String(u.unit_number || '').toLowerCase()] || null })),
    estimates: estimates.map(e => ({ id: Number(e.id), number: e.estimate_number, date: e.estimate_date, status: e.status, total: money(e.total), unit: e.unit_number || '',
      canApprove: e.status === 'sent' && !e.customer_decided_at && !(e.valid_until && new Date(e.valid_until) < today) })),
    invoices: inv };
}

export function registerPortalRoutes(app, { requireDb, publicLimiter, invoicePdf, audit }) {
  const noStore = res => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex, nofollow'); };
  const portal = async (req, res) => { const l = await findActiveLink(requireDb(), req.params.token); if (!l || l.kind !== 'portal') { res.status(404).json({ error: 'This link has expired or was turned off. Please contact the shop.', code: 'LINK_GONE' }); return null; } return l; };
  const ownerName = async (db, id) => (await db.query('SELECT customer_name FROM fullbay_import_customers WHERE id=$1::bigint', [id])).rows[0]?.customer_name || '';
  // Open one of their estimates for approval: a short-lived estimate link, made only for this customer's estimate.
  app.post('/api/public/link/:token/estimate/:id/open', publicLimiter, async (req, res, next) => { try {
    noStore(res); const l = await portal(req, res); if (!l) return; const db = requireDb();
    const e = (await db.query(`SELECT e.id,e.status FROM customer_estimates e WHERE e.id=$3::bigint AND ${OWN('e')}`, [l.ref_id, await ownerName(db, l.ref_id), req.params.id])).rows[0];
    if (!e || e.status !== 'sent') return res.status(404).json({ error: 'This estimate is not waiting for an answer.' });
    const x = await createCustomerLink(db, { kind: 'estimate', refId: e.id, customerId: l.ref_id, days: 3, by: `portal:${l.id}`, base: publicBaseUrl(req) });
    res.json({ url: x.url });
  } catch (e) { next(e); } });
  app.get('/api/public/link/:token/invoice/:id/pdf', publicLimiter, async (req, res, next) => { try {
    noStore(res); const l = await portal(req, res); if (!l) return; const db = requireDb();
    const i = (await db.query(`SELECT i.id,i.invoice_number FROM customer_invoices i WHERE i.id=$3::bigint AND ${OWN('i')} AND i.status NOT IN ('draft','void')`, [l.ref_id, await ownerName(db, l.ref_id), req.params.id])).rows[0];
    if (!i) return res.status(404).json({ error: 'Invoice not found.' });
    const pdf = await invoicePdf(db, i.id); if (!pdf) return res.status(404).json({ error: 'Invoice not found.' });
    await audit(`portal:${l.id}`, 'portal_invoice_pdf', { invoiceId: i.id, customerId: l.ref_id }).catch(() => {});
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `inline; filename="${String(i.invoice_number).replace(/[^A-Za-z0-9_-]/g, '_')}.pdf"`); res.end(pdf);
  } catch (e) { next(e); } });
}
