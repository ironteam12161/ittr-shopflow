// v24.54.0: customer links: a private web page the shop sends by email or text, where the customer approves or
// declines estimate jobs and inspection findings and sees the photos. No customer login: the link itself is the key.
//  - 256-bit random token; only its SHA-256 hash is stored, so a database copy cannot be turned back into links.
//  - Every link expires (default 14 days) and can be turned off by the shop at any time.
//  - The page shows customer prices only: never costs, internal notes, mechanic names or other customers.
//  - Each decision records the typed name, time, IP and browser, and goes through the same code as the shop's buttons.
import crypto from 'node:crypto';

const str = (v, n) => String(v ?? '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const money = v => Math.round(Number(v || 0) * 100) / 100;
export const hashLinkToken = t => crypto.createHash('sha256').update(String(t || '')).digest('hex');
export const LINK_KINDS = { estimate: 14, inspection: 14, portal: 180 };

export async function ensureCustomerLinkSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS customer_links(
    id BIGSERIAL PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL, customer_id BIGINT,
    created_by TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, revoked_by TEXT,
    view_count INTEGER NOT NULL DEFAULT 0, last_viewed_at TIMESTAMPTZ, decided_at TIMESTAMPTZ, meta JSONB NOT NULL DEFAULT '{}'::jsonb);
  CREATE INDEX IF NOT EXISTS idx_customer_links_ref ON customer_links(kind,ref_id,created_at DESC);
  ALTER TABLE customer_estimate_lines ADD COLUMN IF NOT EXISTS customer_decision TEXT;
  ALTER TABLE customer_estimates ADD COLUMN IF NOT EXISTS customer_signed_name TEXT;
  ALTER TABLE customer_estimates ADD COLUMN IF NOT EXISTS customer_decided_at TIMESTAMPTZ;
  ALTER TABLE customer_estimates ADD COLUMN IF NOT EXISTS customer_decision_ip TEXT;
  ALTER TABLE customer_estimates ADD COLUMN IF NOT EXISTS work_order_id TEXT;`);
}

export async function findActiveLink(db, token, { touch = false } = {}) {
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(String(token || ''))) return null;
  const r = await db.query(`SELECT * FROM customer_links WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()`, [hashLinkToken(token)]);
  let l = r.rows[0];
  // v24.74.0: an estimate link opened from a customer portal lives only as long as that portal: turning the portal off
  // (or its expiry) also ends the links made from it.
  const parent = /^portal:(\d+)$/.exec(String(l?.created_by || ''));
  if (l && parent && !(await db.query('SELECT 1 FROM customer_links WHERE id=$1::bigint AND revoked_at IS NULL AND expires_at>now()', [parent[1]])).rowCount) l = null;
  if (l && touch) await db.query('UPDATE customer_links SET view_count=view_count+1,last_viewed_at=now() WHERE id=$1', [l.id]);
  return l || null;
}
export function publicBaseUrl(req) {
  const env = String(process.env.APP_PUBLIC_URL || '').trim().replace(/\/$/, '');
  return env || (req ? `${req.protocol}://${req.get('host')}` : '');
}
export async function createCustomerLink(db, { kind, refId, customerId = null, days, by, base = '' }) {
  if (!LINK_KINDS[kind]) throw Object.assign(new Error('Unknown link type.'), { status: 400 });
  const token = crypto.randomBytes(32).toString('base64url'), d = Math.max(1, Math.min(365, Number(days) || LINK_KINDS[kind]));
  const r = await db.query(`INSERT INTO customer_links(token_hash,kind,ref_id,customer_id,created_by,expires_at) VALUES($1,$2,$3,$4::bigint,$5,now()+($6||' days')::interval) RETURNING id,expires_at`,
    [hashLinkToken(token), kind, String(refId), customerId || null, by, String(d)]);
  return { id: r.rows[0].id, url: `${String(base).replace(/\/$/, '')}/c/${token}`, expiresAt: r.rows[0].expires_at };
}

// Group estimate lines into the jobs the customer decides on. A job is a labor line plus the parts under it (same
// job_uid); a fee tied to a part (tire fees) follows that part. Lines in no job are "Other charges", always included.
export function estimateJobs(lines) {
  const byId = new Map(lines.map(l => [String(l.id), l])), jobs = new Map(), other = [];
  const keyOf = l => { if (l.job_uid) return `j:${l.job_uid}`; const f = l.metadata?.forLineId && byId.get(String(l.metadata.forLineId)); return f?.job_uid ? `j:${f.job_uid}` : null; };
  for (const l of lines) {
    const k = keyOf(l), line = { type: l.line_type, description: l.description, quantity: Number(l.quantity), unit: ['gal', 'qt'].includes(l.metadata?.unit) ? l.metadata.unit : '', unitPrice: money(l.unit_price), total: money(l.line_total) };
    if (!k) { other.push(line); continue; }
    if (!jobs.has(k)) jobs.set(k, { key: k, name: '', lines: [], ids: [], total: 0, decision: null });
    const j = jobs.get(k); j.lines.push(line); j.ids.push(Number(l.id)); j.total = money(j.total + Number(l.line_total || 0));
    if (l.line_type === 'labor' && !j.name) j.name = l.job_name || l.description;
    if (l.customer_decision) j.decision = l.customer_decision;
  }
  for (const j of jobs.values()) if (!j.name) j.name = j.lines[0]?.description || 'Job';
  return { jobs: [...jobs.values()], other, otherTotal: money(other.reduce((a, l) => a + l.total, 0)) };
}

export function registerCustomerLinkRoutes(app, deps) {
  const { auth, adminOnly, managerPermission, requireDb, audit, publicLimiter, shopProfile, readShopflow, applyFindingDecision,
    englishText, findingPhotoUrls, inspectionItemsFor, broadcastShopStatus, publicFile, sendEmail, announceDataDomain } = deps;
  const invoicesPerm = managerPermission('invoices');
  const noStore = res => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex, nofollow'); res.setHeader('Referrer-Policy', 'no-referrer'); };
  const gone = res => res.status(404).json({ error: 'This link has expired or was turned off. Please contact the shop for a new one.', code: 'LINK_GONE' });
  const findLink = findActiveLink;
  const shopInfo = () => { const s = shopProfile(); return { name: s.name, phone: s.phone, email: s.email || '', address: [s.address1, s.address2].filter(Boolean).join(', ') }; };

  async function estimateView(db, link) {
    const e = (await db.query('SELECT * FROM customer_estimates WHERE id=$1::bigint', [link.ref_id])).rows[0]; if (!e) return null;
    const lines = (await db.query('SELECT * FROM customer_estimate_lines WHERE estimate_id=$1::bigint ORDER BY sort_order,id', [e.id])).rows;
    const g = estimateJobs(lines), expired = e.valid_until && new Date(e.valid_until) < new Date(new Date().toDateString());
    return { kind: 'estimate', shop: shopInfo(), estimate: { number: e.estimate_number, date: e.estimate_date, validUntil: e.valid_until, customer: e.customer_name, unit: e.unit_number, vin: e.vin, mileage: e.mileage, po: e.po_number, note: e.customer_note || '', status: e.status,
      subtotal: money(e.subtotal), tax: money(e.tax), shopSupplies: money(e.shop_supplies), environmentalFee: money(e.environmental_fee), discount: money(e.discount), total: money(e.total), signedName: e.customer_signed_name || '', decidedAt: e.customer_decided_at },
      jobs: g.jobs.map(({ ids, ...j }) => j), other: g.other, otherTotal: g.otherTotal,
      canDecide: ['draft', 'sent'].includes(e.status) && !e.customer_decided_at && !expired && g.jobs.length > 0, expired: Boolean(expired) };
  }
  async function inspectionView(db, link) {
    const sf = await readShopflow(db), w = (sf.workorders || []).find(x => String(x?.id) === String(link.ref_id)); if (!w) return null;
    const insp = w.inspection && typeof w.inspection === 'object' ? w.inspection : {}, results = insp.results || {};
    const items = inspectionItemsFor(w), flagged = [];
    let okCount = 0;
    for (const it of items) { const r = results[it.id]; if (!r?.status) continue; if (r.status === 'ok' || r.status === 'pass') { okCount++; continue; } if (!['repair', 'attention'].includes(r.status)) continue;
      flagged.push({ label: it.en || it.label, section: it.sectionTitle || '', status: r.status === 'repair' ? 'Needs repair' : 'Keep an eye on', note: await englishText(r.note || '') }); }
    const issues = (sf.issues || []).filter(i => String(i?.wo) === String(w.id));
    const photos = await findingPhotoUrls(db, issues.map(i => String(i.id)));
    const findings = [];
    for (const i of issues) findings.push({ id: String(i.id), title: await englishText(i.recommendation || i.description || ''), detail: i.recommendation && i.description ? await englishText(i.description) : '',
      severity: i.severity || '', decision: i.approval === 'Proceed' ? 'approved' : i.approval === 'Do Not Proceed' ? 'declined' : 'pending',
      canDecide: !['Proceed', 'Do Not Proceed'].includes(i.approval), photos: photos[String(i.id)] || [] });
    return { kind: 'inspection', shop: shopInfo(), vehicle: { unit: w.unit || '', description: [w.year, w.make, w.model].filter(Boolean).join(' '), vin: w.vin || '', customer: w.customer || '', date: insp.completedAt || insp.startedAt || w.date || '' },
      inspection: { status: insp.status || '', type: insp.type || '', okCount, flagged }, findings, canDecide: findings.some(f => f.canDecide) };
  }

  // ---- public (no login; the token is the key) -------------------------------------------------------------
  app.get('/c/:token', publicLimiter, (req, res) => { noStore(res); res.sendFile(publicFile('customer.html')); });
  app.get('/api/public/link/:token', publicLimiter, async (req, res, next) => { try {
    noStore(res); const db = requireDb(), link = await findLink(db, req.params.token, { touch: true }); if (!link) return gone(res);
    const view = link.kind === 'estimate' ? await estimateView(db, link) : link.kind === 'inspection' ? await inspectionView(db, link) : link.kind === 'portal' && deps.portalView ? await deps.portalView(db, link) : null;
    if (!view) return gone(res);
    res.json({ ...view, expiresAt: link.expires_at });
  } catch (e) { next(e); } });
  app.post('/api/public/link/:token/decide', publicLimiter, async (req, res, next) => {
    noStore(res); const pool = requireDb(), name = str(req.body?.name, 80), note = str(req.body?.note, 1000);
    const ip = String(req.ip || '').slice(0, 64), ua = String(req.get('user-agent') || '').slice(0, 200);
    try {
      const link = await findLink(pool, req.params.token); if (!link) return gone(res);
      if (name.length < 2) return res.status(400).json({ error: 'Type your full name to sign.' });
      if (req.body?.agree !== true) return res.status(400).json({ error: 'Tick the box to authorize the work.' });
      const who = `customer:${name}`;
      if (link.kind === 'estimate') {
        const db = await pool.connect();
        try {
          await db.query('BEGIN');
          const e = (await db.query('SELECT * FROM customer_estimates WHERE id=$1::bigint FOR UPDATE', [link.ref_id])).rows[0];
          if (!e || !['draft', 'sent'].includes(e.status) || e.customer_decided_at) { await db.query('ROLLBACK'); return res.status(409).json({ error: 'This estimate was already answered. Call the shop to change it.' }); }
          if (e.valid_until && new Date(e.valid_until) < new Date(new Date().toDateString())) { await db.query('ROLLBACK'); return res.status(409).json({ error: 'This estimate has expired. Call the shop for an updated one.' }); }
          const lines = (await db.query('SELECT * FROM customer_estimate_lines WHERE estimate_id=$1::bigint ORDER BY sort_order,id', [e.id])).rows;
          const { jobs } = estimateJobs(lines), want = req.body?.jobs || {};
          if (!jobs.length) { await db.query('ROLLBACK'); return res.status(409).json({ error: 'There is nothing to approve on this estimate.' }); }
          const missing = jobs.filter(j => !['approve', 'decline'].includes(want[j.key]));
          if (missing.length) { await db.query('ROLLBACK'); return res.status(400).json({ error: `Choose Approve or Decline for: ${missing.map(j => j.name).join(', ')}.` }); }
          let approved = 0, approvedTotal = 0;
          for (const j of jobs) { const d = want[j.key] === 'approve' ? 'approved' : 'declined'; if (d === 'approved') { approved++; approvedTotal += j.total; }
            await db.query('UPDATE customer_estimate_lines SET customer_decision=$2 WHERE id = ANY($1::bigint[])', [j.ids, d]); }
          const status = approved ? 'approved' : 'declined';
          const summary = `${approved ? 'Approved' : 'Declined'} online by ${name}: ${approved} of ${jobs.length} job${jobs.length === 1 ? '' : 's'} approved ($${approvedTotal.toFixed(2)} before tax/fees).${note ? ` Note: ${note}` : ''}`;
          await db.query(`UPDATE customer_estimates SET status=$2,decision_note=$3,decided_at=now(),decided_by=$4,customer_signed_name=$5,customer_decided_at=now(),customer_decision_ip=$6,updated_at=now() WHERE id=$1::bigint`, [e.id, status, summary, who, name, ip]);
          await db.query(`UPDATE customer_links SET decided_at=now(),meta=meta||$2::jsonb WHERE id=$1`, [link.id, JSON.stringify({ name, ip, ua, approved, of: jobs.length })]);
          await db.query('COMMIT');
          await audit(who, 'estimate_customer_decision', { estimateId: e.id, estimateNumber: e.estimate_number, status, approved, jobs: jobs.length, ip, ua, linkId: link.id });
          broadcastShopStatus('customer_decision', { kind: 'estimate', id: e.id, label: `Estimate ${e.estimate_number}`, name, status, approved, of: jobs.length });
          // v24.76.1: the estimate's status changed: open Estimates screens refresh, and a page that was offline catches up on
          // reconnect (the decision is a public request, so the announcement middleware does not see it).
          announceDataDomain?.('invoices', 'customer');
          return res.json({ ok: true, status, approved, of: jobs.length });
        } catch (e) { try { await db.query('ROLLBACK'); } catch (_) {} throw e; } finally { db.release(); }
      }
      if (link.kind === 'inspection') {
        const sf = await readShopflow(pool), want = req.body?.findings || {};
        const mine = (sf.issues || []).filter(i => String(i?.wo) === String(link.ref_id) && !['Proceed', 'Do Not Proceed'].includes(i.approval));
        const picks = mine.filter(i => ['approve', 'decline'].includes(want[String(i.id)]));
        if (!picks.length) return res.status(400).json({ error: 'Choose Approve or Decline for at least one repair.' });
        // v24.74.0: each repair is its own decision. One that could not be recorded (changed by the shop meanwhile) no
        // longer hides the ones that were: the answer lists every repair with its outcome, and only "none recorded" is an error.
        let approved = 0; const results = [];
        for (const i of picks) {
          const decision = want[String(i.id)] === 'approve' ? 'approve' : 'decline', db = await pool.connect();
          try { const r = await applyFindingDecision(db, String(i.id), decision === 'approve' ? 'Proceed' : 'Do Not Proceed', who);
            results.push({ id: String(i.id), decision, ok: !!r.ok, ...(r.ok ? {} : { error: r.error || 'Not recorded.' }) });
            if (r.ok && decision === 'approve') approved++;
          } catch (e) { results.push({ id: String(i.id), decision, ok: false, error: 'Not recorded.' }); }
          finally { db.release(); }
        }
        const recorded = results.filter(r => r.ok).length, failed = results.length - recorded;
        if (!recorded) return res.status(409).json({ error: 'Your answer could not be recorded. Please call the shop.', results, recorded: 0, of: picks.length });
        await pool.query(`UPDATE customer_links SET decided_at=now(),meta=meta||$2::jsonb WHERE id=$1`, [link.id, JSON.stringify({ name, ip, ua, approved, of: picks.length, recorded, note })]);
        await audit(who, 'inspection_customer_decision', { workOrderId: link.ref_id, approved, of: picks.length, recorded, notRecorded: results.filter(r => !r.ok).map(r => r.id), note, ip, ua, linkId: link.id });
        broadcastShopStatus('customer_decision', { kind: 'inspection', id: link.ref_id, label: `Work order #${link.ref_id}`, name, approved, of: picks.length });
        broadcastShopStatus('shopflow_changed', { by: who });
        return res.json({ ok: true, approved, of: picks.length, recorded, partial: failed > 0, results });
      }
      return res.status(400).json({ error: 'Nothing to decide on this page.' });
    } catch (e) { next(e); }
  });

  // ---- shop side ------------------------------------------------------------------------------------------
  app.post('/api/customer-links', auth, adminOnly, async (req, res, next) => { try {
    const db = requireDb(), kind = String(req.body?.kind || ''), refId = str(req.body?.refId, 60);
    if (!['estimate', 'inspection', 'portal'].includes(kind)) return res.status(400).json({ error: 'Choose an estimate, an inspection or a customer portal.' });
    let customerId = null;
    if (kind === 'estimate') {
      if (req.user.role === 'manager' && req.user.permissions?.invoices !== true) return res.status(403).json({ error: 'Manager permission required: invoices.' });
      const e = (await db.query('SELECT id,status,customer_id FROM customer_estimates WHERE id=$1::bigint', [refId])).rows[0];
      if (!e) return res.status(404).json({ error: 'Estimate not found.' });
      if (['converted', 'declined'].includes(e.status)) return res.status(409).json({ error: `This estimate is ${e.status}.` });
      customerId = e.customer_id;
      await db.query(`UPDATE customer_estimates SET status=CASE WHEN status='draft' THEN 'sent' ELSE status END,sent_at=coalesce(sent_at,now()) WHERE id=$1::bigint`, [e.id]);
    } else if (kind === 'portal') {
      if (req.user.role === 'manager' && req.user.permissions?.customers !== true) return res.status(403).json({ error: 'Manager permission required: customers.' });
      // v24.72.0: the portal shows invoices, balances and invoice PDFs, so creating one also needs Invoices.
      if (req.user.role === 'manager' && req.user.permissions?.invoices !== true) return res.status(403).json({ error: 'Manager permission required: invoices (the customer portal shows invoices and balances).' });
      const c = (await db.query('SELECT id FROM fullbay_import_customers WHERE id=$1::bigint', [refId])).rows[0]; if (!c) return res.status(404).json({ error: 'Customer not found.' });
      customerId = c.id;
    } else {
      const w = ((await readShopflow(db)).workorders || []).find(x => String(x?.id) === refId); if (!w) return res.status(404).json({ error: 'Work order not found.' });
      customerId = w.customerId || null;
    }
    const link = await createCustomerLink(db, { kind, refId, customerId: Number(customerId) || null, days: req.body?.days, by: req.user.username, base: publicBaseUrl(req) });
    await audit(req.user.username, 'customer_link_created', { kind, refId, linkId: link.id });
    res.json({ ...link, ...(await linkEmailContext(db, kind, refId, customerId)) });
  } catch (e) { if (e?.status) return res.status(e.status).json({ error: e.message }); next(e); } });
  // v24.57.0: who to email and what the email says, per link type.
  async function linkEmailContext(db, kind, refId, customerId) {
    const cust = customerId ? (await db.query('SELECT customer_name,email FROM fullbay_import_customers WHERE id=$1::bigint', [customerId]).catch(() => ({ rows: [] }))).rows[0] : null;
    if (kind === 'estimate') { const e = (await db.query('SELECT estimate_number,customer_email,customer_name,unit_number FROM customer_estimates WHERE id=$1::bigint', [refId])).rows[0] || {};
      return { suggestedEmail: e.customer_email || cust?.email || '', customerName: e.customer_name || cust?.customer_name || '', subject: `Estimate ${e.estimate_number || ''}${e.unit_number ? ` for unit ${e.unit_number}` : ''}: review and approve online`, button: 'Review & approve online',
        intro: `Your estimate${e.unit_number ? ` for unit ${e.unit_number}` : ''} is ready. Open it to approve or decline each job. Declined jobs are not done or charged.` }; }
    if (kind === 'inspection') { const w = ((await readShopflow(db)).workorders || []).find(x => String(x?.id) === String(refId)) || {};
      return { suggestedEmail: cust?.email || '', customerName: w.customer || cust?.customer_name || '', subject: `Inspection report${w.unit ? ` for unit ${w.unit}` : ''}: photos and recommended repairs`, button: 'See the inspection report',
        intro: `We inspected ${w.unit ? `unit ${w.unit}` : 'your vehicle'}. Open the report to see the photos and approve the repairs you want done.` }; }
    return { suggestedEmail: cust?.email || '', customerName: cust?.customer_name || '', subject: `Your ${shopProfile().name} account`, button: 'Open your account',
      intro: 'Here is your private page with your units, estimates and invoices. You can approve estimates and pay invoices online there.' };
  }
  // Email a link that was just created. The link must be a live one for this estimate / work order / customer.
  app.post('/api/customer-links/email', auth, adminOnly, async (req, res, next) => { try {
    const db = requireDb(), kind = String(req.body?.kind || ''), refId = str(req.body?.refId, 60), given = String(req.body?.url || '').trim();
    const token = (given.match(/\/c\/([A-Za-z0-9_-]{30,80})$/) || [])[1], link = token ? await findActiveLink(db, token) : null;
    if (!link || link.kind !== kind || String(link.ref_id) !== refId) return res.status(400).json({ error: 'Create a new link first, then email it.' });
    // v24.74.0: the button in the email always points at this shop's own address, built here; a link pasted with another
    // host (or http/other schemes) is refused instead of being sent to the customer.
    const base = publicBaseUrl(req), url = `${base}/c/${token}`;
    let givenOrigin = ''; try { givenOrigin = new URL(given).origin; } catch (_) {}
    if (givenOrigin !== new URL(base).origin) return res.status(400).json({ error: 'This link does not point to the shop\'s website. Create a new link, then email it.' });
    const list = String(req.body?.to || '').split(/[,;\s]+/).map(a => a.trim().toLowerCase()).filter(Boolean);
    if (!list.length || list.some(a => !/^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/.test(a))) return res.status(400).json({ error: 'Enter the customer\'s email address.' });
    const c = await linkEmailContext(db, kind, refId, link.customer_id), shop = shopProfile(), esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const note = str(req.body?.message, 1000), hello = c.customerName ? `Hello ${c.customerName},` : 'Hello,';
    const html = `<div style="font-family:Arial,sans-serif;color:#101828;max-width:560px;line-height:1.5"><p>${esc(hello)}</p><p>${esc(c.intro)}</p>${note ? `<p>${esc(note)}</p>` : ''}
      <p style="margin:22px 0"><a href="${esc(url)}" style="display:inline-block;background:#c2410c;color:#fff;padding:13px 22px;border-radius:10px;text-decoration:none;font-weight:800">${esc(c.button)}</a></p>
      <p style="color:#475467;font-size:13px">This private link is for you only and works until ${esc(new Date(link.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))}.<br>${esc(shop.name)} · ${esc(shop.phone)}</p></div>`;
    const text = `${hello}\n\n${c.intro}\n${note ? `\n${note}\n` : ''}\n${c.button}: ${url}\n\n${shop.name} · ${shop.phone}`;
    const r = await sendEmail({ to: list, subject: c.subject, text, html, replyTo: shop.email || '', idempotencyKey: `link-${link.id}-${list.join(',')}`, tags: [{ name: 'document', value: `link_${kind}` }] });
    if (!r?.ok) return res.status(r?.status || 502).json({ error: r?.error || 'The email was not sent.' });
    if (kind === 'estimate') await db.query(`UPDATE customer_estimates SET customer_email=coalesce(nullif(customer_email,''),$2) WHERE id=$1::bigint`, [refId, list[0]]);
    await db.query(`UPDATE customer_links SET meta=meta||$2::jsonb WHERE id=$1`, [link.id, JSON.stringify({ emailedTo: list, emailedAt: new Date().toISOString() })]);
    await audit(req.user.username, 'customer_link_emailed', { kind, refId, linkId: link.id, to: list });
    res.json({ ok: true, to: list });
  } catch (e) { next(e); } });
  // v24.76.0: listing and turning off links follow the same permissions as creating them (estimate: Invoices;
  // portal: Customers and Invoices; inspection: any manager, like work orders). Before, any manager could list every
  // link (customer ids, who signed) and turn off portals or estimate links outside their permissions.
  const linkKindAllowed = (u, kind) => u?.role === 'admin' || (u?.role === 'manager' && (kind === 'inspection' || (kind === 'estimate' && u.permissions?.invoices === true) || (kind === 'portal' && u.permissions?.customers === true && u.permissions?.invoices === true)));
  app.get('/api/customer-links', auth, adminOnly, async (req, res, next) => { try {
    const kind = str(req.query.kind, 20);
    if (kind && !linkKindAllowed(req.user, kind)) return res.status(403).json({ error: 'You do not have permission to see these links.' });
    const kinds = ['estimate', 'inspection', 'portal'].filter(k => linkKindAllowed(req.user, k));
    const r = await requireDb().query(`SELECT id,kind,ref_id,created_by,created_at,expires_at,revoked_at,view_count,last_viewed_at,decided_at,meta->>'name' signed_name FROM customer_links WHERE ($1='' OR kind=$1) AND ($2='' OR ref_id=$2) AND kind = ANY($3::text[]) ORDER BY created_at DESC LIMIT 50`, [kind, str(req.query.refId, 60), kinds]);
    res.json({ items: r.rows });
  } catch (e) { next(e); } });
  app.delete('/api/customer-links/:id', auth, adminOnly, async (req, res, next) => { try {
    const cur = (await requireDb().query('SELECT kind FROM customer_links WHERE id=$1::bigint', [req.params.id])).rows[0];
    if (cur && !linkKindAllowed(req.user, cur.kind)) return res.status(403).json({ error: 'You do not have permission to turn off this link.' });
    const r = await requireDb().query('UPDATE customer_links SET revoked_at=now(),revoked_by=$2 WHERE id=$1::bigint AND revoked_at IS NULL RETURNING kind,ref_id', [req.params.id, req.user.username]);
    if (!r.rowCount) return res.status(404).json({ error: 'Link not found or already off.' });
    await audit(req.user.username, 'customer_link_revoked', { linkId: req.params.id, ...r.rows[0] }); res.json({ ok: true });
  } catch (e) { next(e); } });
}
