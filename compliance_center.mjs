// ITTR ShopFlow v24.39.0 compliance center:
//  - Annual inspection documents: the shop's own truck/trailer forms, filled in and printed
//  - Fleet PM / CARB / recurring maintenance tracking (miles from Samsara, alerts by email)
//  - Owner "start fresh" reset of test data, with a snapshot kept for recovery
import crypto from 'node:crypto';
import { PDFDocument as PdfLibDocument, StandardFonts, rgb } from 'pdf-lib';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getSetting } from './finance_center.mjs';
import { alertEmailHtml, sendResendEmail } from './email_templates.mjs';

// ---------------------------------------------------------------- annual inspection documents
// The shop's own annual inspection forms (truck/tractor and trailer) are stored as blank PDF templates.
// Only the changing values are written onto them, at the same spots the originals used.
const TEMPLATE_DIR = fileURLToPath(new URL('./assets/inspection-templates/', import.meta.url));
const BOX = { reportNumber: [427.2, 491.4], unitNumber: [492.9, 611.1], date: [456.1, 606.1] };
// x/y are PDF points from the bottom-left (baseline); w = widest the text may get before it shrinks.
const COMMON = {
  carrierName: { label: 'Motor carrier operator', w: 282 }, address: { label: 'Address', w: 282 }, cityStateZip: { label: 'City, state, ZIP', w: 282 },
  inspectorName: { label: "Inspector's name", w: 280 }, vin: { label: 'VIN', w: 150 }, agency: { label: 'Inspection agency / location', w: 280 },
  reportNumber: { label: 'Report number', center: true }, unitNumber: { label: 'Fleet unit number', center: true }, date: { label: 'Date', center: true },
  otherConditions: { label: 'Other conditions (bottom right)', w: 92 }
};
export const INSPECTION_TEMPLATES = Object.freeze({
  truck: { label: 'Truck / tractor', file: 'annual-truck.pdf', fields: {
    reportNumber: { y: 741.5, size: 12 }, unitNumber: { y: 741.5, size: 12 }, date: { y: 723.5, size: 12 },
    carrierName: { x: 37.1, y: 693.4, size: 12 }, address: { x: 37.1, y: 669.4, size: 12 }, cityStateZip: { x: 37.1, y: 645.4, size: 12 },
    inspectorName: { x: 326.9, y: 693.6, size: 12 }, vin: { x: 324.8, y: 644.1, size: 12, w: 280 }, agency: { x: 326.9, y: 622.2, size: 11 },
    otherConditions: { x: 517.9, y: 226.4, size: 11 } } },
  trailer: { label: 'Trailer', file: 'annual-trailer.pdf', fields: {
    reportNumber: { y: 742.0, size: 11 }, unitNumber: { y: 742.0, size: 11 }, date: { y: 724.5, size: 11 },
    carrierName: { x: 41.1, y: 693.6, size: 11 }, address: { x: 41.6, y: 668.3, size: 11 }, cityStateZip: { x: 41.1, y: 646.5, size: 11 },
    inspectorName: { x: 326.9, y: 692.0, size: 12 }, vin: { x: 329.6, y: 646.9, size: 11, w: 280 }, agency: { x: 326.9, y: 622.2, size: 11 },
    otherConditions: { x: 517.9, y: 226.4, size: 11 } } }
});
export const INSPECTION_FIELD_KEYS = Object.keys(COMMON);
export function cleanInspectionFields(raw = {}) {
  const out = {}; for (const k of INSPECTION_FIELD_KEYS) out[k] = String(raw?.[k] ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, k === 'otherConditions' ? 60 : 120);
  if (out.vin) out.vin = out.vin.toUpperCase();
  return out;
}
export async function renderInspectionTemplate(template, fields) {
  const t = INSPECTION_TEMPLATES[template]; if (!t) throw Object.assign(new Error('Unknown inspection template.'), { status: 400 });
  const doc = await PdfLibDocument.load(fs.readFileSync(TEMPLATE_DIR + t.file)), page = doc.getPage(0), font = await doc.embedFont(StandardFonts.Helvetica);
  const f = cleanInspectionFields(fields);
  // Positions are measured inside the visible (crop) area; the forms are 11x17 sheets cropped to the form.
  const crop = page.getCropBox(), ox = crop.x, oy = crop.y;
  for (const [k, pos] of Object.entries(t.fields)) {
    const text = f[k]; if (!text) continue;
    const spec = { ...COMMON[k], ...pos }, box = BOX[k];
    const maxW = spec.center && box ? box[1] - box[0] - 6 : spec.w || 200;
    let size = spec.size; while (size > 6 && font.widthOfTextAtSize(text, size) > maxW) size -= 0.5;
    const w = font.widthOfTextAtSize(text, size), x = spec.center && box ? box[0] + (box[1] - box[0] - w) / 2 : spec.x;
    page.drawText(text, { x: x + ox, y: spec.y + oy, size, font, color: rgb(0, 0, 0) });
  }
  doc.setTitle(`Annual Vehicle Inspection ${f.unitNumber || f.vin || ''}`.trim());
  return Buffer.from(await doc.save());
}

// ---------------------------------------------------------------- fleet maintenance
export const SERVICE_TYPES = Object.freeze({
  oil_change: { name: 'Oil change / PM', miles: 25000, days: 180 },
  pm_a: { name: 'PM A service', miles: 15000, days: 90 },
  pm_b: { name: 'PM B service', miles: 45000, days: 365 },
  carb_test: { name: 'CARB smoke test (Clean Truck Check)', miles: null, days: 365 },
  annual_inspection: { name: 'Annual DOT inspection', miles: null, days: 365 },
  dpf_clean: { name: 'DPF cleaning', miles: 200000, days: null },
  custom: { name: 'Other maintenance', miles: null, days: null }
});
const iso = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
const intOrNull = v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : null; };
// Pure status calculation (unit tested).
const ymd = v => v == null || v === '' ? null : v instanceof Date ? (Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : null) : String(v).slice(0, 10);
export function serviceStatus(item, { currentMiles = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const dueMiles = item.last_done_miles != null && item.interval_miles ? Number(item.last_done_miles) + Number(item.interval_miles) : null;
  let dueDate = ymd(item.due_date);
  if (!dueDate && ymd(item.last_done_date) && item.interval_days) { const d = new Date(ymd(item.last_done_date) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + Number(item.interval_days)); dueDate = d.toISOString().slice(0, 10); }
  const milesLeft = dueMiles != null && currentMiles != null ? Math.round(dueMiles - currentMiles) : null;
  const daysLeft = dueDate ? Math.round((Date.parse(dueDate) - Date.parse(today)) / 86400000) : null;
  const warnMiles = Number(item.warn_miles ?? 1000), warnDays = Number(item.warn_days ?? 30);
  let status = 'ok';
  if ((milesLeft != null && milesLeft <= 0) || (daysLeft != null && daysLeft < 0)) status = 'overdue';
  else if ((milesLeft != null && milesLeft <= warnMiles) || (daysLeft != null && daysLeft <= warnDays)) status = 'due_soon';
  else if (dueMiles == null && dueDate == null) status = 'no_data';
  return { status, dueMiles, dueDate, milesLeft, daysLeft };
}

export async function ensureComplianceSchema(pool) {
  if (!pool) return;
  await pool.query(`
  CREATE TABLE IF NOT EXISTS inspection_documents(
    id BIGSERIAL PRIMARY KEY, template TEXT NOT NULL, fields JSONB NOT NULL DEFAULT '{}'::jsonb,
    carrier_name TEXT, unit_number TEXT, vin TEXT, doc_date TEXT, customer_id BIGINT, unit_id BIGINT,
    created_by TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_inspection_documents_created ON inspection_documents(created_at DESC);
  ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS odometer_miles NUMERIC;
  ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS odometer_at TIMESTAMPTZ;
  ALTER TABLE customer_units ADD COLUMN IF NOT EXISTS odometer_source TEXT;
  CREATE TABLE IF NOT EXISTS fleet_service_items(
    id BIGSERIAL PRIMARY KEY, unit_id BIGINT, unit_label TEXT NOT NULL DEFAULT '', vin TEXT,
    service_type TEXT NOT NULL DEFAULT 'custom', name TEXT NOT NULL,
    interval_miles INTEGER, interval_days INTEGER, warn_miles INTEGER NOT NULL DEFAULT 1000, warn_days INTEGER NOT NULL DEFAULT 30,
    last_done_date DATE, last_done_miles NUMERIC, due_date DATE, notes TEXT, active BOOLEAN NOT NULL DEFAULT TRUE,
    last_alert_level TEXT, last_alert_at TIMESTAMPTZ,
    created_by TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_fleet_service_items_unit ON fleet_service_items(unit_id);
  CREATE TABLE IF NOT EXISTS fleet_service_history(
    id BIGSERIAL PRIMARY KEY, item_id BIGINT NOT NULL REFERENCES fleet_service_items(id) ON DELETE CASCADE,
    done_date DATE NOT NULL, done_miles NUMERIC, note TEXT, work_order_id TEXT, recorded_by TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS data_reset_snapshots(
    id BIGSERIAL PRIMARY KEY, scopes JSONB NOT NULL, snapshot JSONB NOT NULL, created_by TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now()
  );`);
}

// Samsara odometer → customer_units.odometer_miles (units linked by samsara_vehicle_id or VIN).
export async function syncSamsaraOdometers(db, samsaraPaged) {
  const stats = await samsaraPaged('/fleet/vehicles/stats', { types: 'obdOdometerMeters,gpsOdometerMeters' });
  let updated = 0;
  for (const s of stats || []) {
    const m = s.obdOdometerMeters?.value ?? s.gpsOdometerMeters?.value; if (m == null) continue;
    const miles = Math.round(Number(m) / 1609.344), at = s.obdOdometerMeters?.time || s.gpsOdometerMeters?.time || new Date().toISOString(), vin = String(s.externalIds?.['samsara.vin'] || s.vin || '').toUpperCase();
    const r = await db.query(`UPDATE customer_units SET odometer_miles=$2,odometer_at=$3::timestamptz,odometer_source='samsara',mileage=greatest(coalesce(mileage,0),$2::bigint) WHERE samsara_vehicle_id=$1::text OR ($4<>'' AND upper(coalesce(vin,''))=$4)`, [String(s.id), miles, at, vin]);
    updated += r.rowCount;
  }
  return { vehicles: (stats || []).length, updated };
}

async function fleetItemsWithStatus(db) {
  const rows = (await db.query(`SELECT f.*,u.unit_number,u.vin AS unit_vin,u.customer_name,u.odometer_miles,u.odometer_at,u.odometer_source,u.mileage AS unit_mileage
    FROM fleet_service_items f LEFT JOIN customer_units u ON u.id=f.unit_id WHERE f.active=true ORDER BY f.id`)).rows;
  return rows.map(r => {
    const currentMiles = r.odometer_miles != null ? Number(r.odometer_miles) : r.unit_mileage != null ? Number(r.unit_mileage) : null;
    return { ...r, unit_display: r.unit_number ? `Unit ${r.unit_number}` : (r.unit_label || r.vin || 'Unit'), currentMiles, milesSource: r.odometer_source === 'samsara' ? 'Samsara' : currentMiles != null ? 'Last recorded' : '', ...serviceStatus(r, { currentMiles }) };
  });
}

export async function runFleetAlerts(db, { force = false } = {}) {
  const cfg = await getSetting(db, 'fleet_alerts', { enabled: true, email: '' });
  const items = await fleetItemsWithStatus(db), shop = { name: String(process.env.SHOP_NAME || 'Iron Team Truck & Trailer Repair') };
  const fresh = items.filter(i => ['due_soon', 'overdue'].includes(i.status) && (force || i.last_alert_level !== i.status));
  if (!fresh.length) return { sent: false, count: 0 };
  const to = String(cfg.email || process.env.INVOICE_REPLY_TO || process.env.SHOP_EMAIL || '').trim();
  let sent = false, error = '';
  if (cfg.enabled !== false && to) {
    const detail = i => [i.milesLeft != null ? (i.milesLeft <= 0 ? `${Math.abs(i.milesLeft).toLocaleString()} mi past due` : `${i.milesLeft.toLocaleString()} mi left`) : '', i.daysLeft != null ? (i.daysLeft < 0 ? `${Math.abs(i.daysLeft)} days past due (${i.dueDate})` : `due ${i.dueDate} (${i.daysLeft} days)`) : '', i.currentMiles != null ? `odometer ${Math.round(i.currentMiles).toLocaleString()} mi` : ''].filter(Boolean).join(' · ');
    const base = String(process.env.APP_PUBLIC_URL || '').replace(/\/$/, '');
    const r = await sendResendEmail({ to: [to], subject: `Fleet maintenance: ${fresh.filter(i => i.status === 'overdue').length} overdue, ${fresh.filter(i => i.status === 'due_soon').length} due soon`,
      html: alertEmailHtml({ title: 'Fleet maintenance reminders', intro: 'These trucks need service soon. Mark each one done in ShopFlow after the work is finished.', rows: fresh.map(i => ({ unit: i.unit_display, service: i.name, status: i.status, detail: detail(i) })), shop, appUrl: base ? `${base}/?view=compliance` : '' }),
      text: fresh.map(i => `${i.status === 'overdue' ? 'OVERDUE' : 'DUE SOON'}: ${i.unit_display} — ${i.name} — ${detail(i)}`).join('\n'),
      idempotencyKey: `fleet-alert-${crypto.createHash('sha1').update(fresh.map(i => `${i.id}:${i.status}`).join('|')).digest('hex')}-${new Date().toISOString().slice(0, 10)}` });
    sent = r.ok; error = r.ok ? '' : r.error;
  }
  if (sent || !to || cfg.enabled === false) for (const i of fresh) await db.query('UPDATE fleet_service_items SET last_alert_level=$2,last_alert_at=now() WHERE id=$1', [i.id, i.status]);
  return { sent, count: fresh.length, to, error };
}

// ---------------------------------------------------------------- owner data reset
export const RESET_SCOPES = Object.freeze({
  productivity: { label: 'Mechanic productivity (time clock, task timers + activity history)', tables: ['task_time_sessions', 'task_time_adjustments', 'mechanic_shift_edits', 'mechanic_shifts'] },
  work_orders: { label: 'Work orders, findings and their inspections', tables: ['mechanic_inspections', 'service_orders'] },
  billing: { label: 'Invoices, payments, estimates and email logs', tables: ['customer_invoice_payments', 'customer_invoice_lines', 'customer_invoices', 'invoice_email_deliveries', 'customer_estimate_lines', 'customer_estimates'] },
  gmail: { label: 'Gmail money inbox items (accounts stay connected)', tables: ['gmail_finance_messages'] },
  annual_inspections: { label: 'Annual inspection documents', tables: ['inspection_documents'] }
});
export async function resetData(db, scopes, username) {
  const chosen = scopes.filter(s => RESET_SCOPES[s]), snapshot = {}, counts = {};
  for (const s of chosen) for (const t of RESET_SCOPES[s].tables) {
    const ok = (await db.query(`SELECT to_regclass($1) t`, [`public.${t}`])).rows[0]?.t; if (!ok) continue;
    snapshot[t] = (await db.query(`SELECT * FROM ${t}`)).rows; counts[t] = snapshot[t].length;
  }
  const state = key => db.query(`SELECT payload FROM app_state WHERE state_key=$1 FOR UPDATE`, [key]).then(r => r.rows[0]?.payload || {});
  if (chosen.includes('productivity')) {
    const users = await state('users'); snapshot.users_activity = {};
    for (const [u, v] of Object.entries(users)) if (v && typeof v === 'object') { snapshot.users_activity[u] = { currentActivity: v.currentActivity, activityHistory: v.activityHistory }; v.activityHistory = []; v.currentActivity = { code: '', note: '', startedAt: '' }; }
    await db.query(`UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by=$2 WHERE state_key='users'`, [JSON.stringify(users), username]);
  }
  if (chosen.includes('work_orders')) {
    const sf = await state('shopflow'); snapshot.shopflow = sf; counts.work_orders = (sf.workorders || []).length;
    await db.query(`UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by=$2 WHERE state_key='shopflow'`, [JSON.stringify({ ...sf, workorders: [], issues: [] }), username]);
    if (!chosen.includes('productivity')) { /* keep timers unless productivity is also reset */ }
    await db.query(`UPDATE fullbay_import_parts SET allocated=0 WHERE coalesce(allocated,0)<>0`);
  }
  await db.query(`INSERT INTO data_reset_snapshots(scopes,snapshot,created_by) VALUES($1::jsonb,$2::jsonb,$3)`, [JSON.stringify(chosen), JSON.stringify(snapshot), username]);
  const order = ['mechanic_shift_edits', 'mechanic_shifts', 'customer_invoice_payments', 'customer_invoice_lines', 'invoice_email_deliveries', 'customer_invoices', 'customer_estimate_lines', 'customer_estimates', 'task_time_adjustments', 'task_time_sessions', 'mechanic_inspections', 'service_orders', 'gmail_finance_messages', 'inspection_documents'];
  for (const t of order) if (snapshot[t]) {
    if (t === 'gmail_finance_messages') await db.query(`DELETE FROM gmail_finance_messages`);
    else await db.query(`DELETE FROM ${t}`);
  }
  return { scopes: chosen, counts };
}

// ---------------------------------------------------------------- routes
export function registerComplianceRoutes(app, deps) {
  const { auth, ownerOnly, adminOnly, requireDb, audit, shopProfile, lookupFmcsaCarrier, searchFmcsaCarriersByName, samsaraPaged, samsaraConfigured } = deps;
  const read = h => async (req, res, next) => { try { res.json(await h(requireDb(), req, res)); } catch (e) { if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code }); next(e); } };
  const tx = h => async (req, res, next) => { const db = await requireDb().connect(); try { await db.query('BEGIN'); const out = await h(db, req); await db.query('COMMIT'); res.json(out); } catch (e) { try { await db.query('ROLLBACK'); } catch {} if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code }); next(e); } finally { db.release(); } };
  const fail = (s, m) => { throw Object.assign(new Error(m), { status: s }); };
  const str = (v, n = 300) => String(v ?? '').trim().slice(0, n);

  // --- annual inspection documents (the shop's own form, filled in)
  app.get('/api/inspection-docs/templates', auth, adminOnly, (req, res) => res.json({ templates: Object.entries(INSPECTION_TEMPLATES).map(([key, t]) => ({ key, label: t.label, fields: Object.keys(t.fields) })), fields: Object.fromEntries(Object.entries(COMMON).map(([k, v]) => [k, v.label])), shop: shopProfile() }));
  app.get('/api/inspection-docs', auth, adminOnly, read(async (db, req) => {
    const q = str(req.query.q, 100);
    return { items: (await db.query(`SELECT id,template,fields,carrier_name,unit_number,vin,doc_date,created_by,updated_at FROM inspection_documents
      WHERE ($1='' OR coalesce(carrier_name,'') ILIKE '%'||$1||'%' OR coalesce(vin,'') ILIKE '%'||$1||'%' OR coalesce(unit_number,'') ILIKE '%'||$1||'%') ORDER BY id DESC LIMIT 300`, [q])).rows };
  }));
  app.get('/api/annual-inspections/lookup', auth, adminOnly, read(async (db, req) => {
    const q = str(req.query.q, 100), digits = q.replace(/\D/g, ''), isDot = /^\d{3,8}$/.test(q.replace(/\s/g, ''));
    if (q.length < 2) return { customers: [], carriers: [] };
    const customers = (await db.query(`SELECT id,customer_name,dot_number,coalesce(nullif(billing_address,''),address) address,coalesce(nullif(billing_city,''),city) city,coalesce(nullif(billing_state,''),state) state,coalesce(nullif(billing_postal_code,''),postal_code) postal_code
      FROM fullbay_import_customers WHERE deleted_at IS NULL AND (customer_name ILIKE '%'||$1||'%' OR ($2<>'' AND regexp_replace(coalesce(dot_number,''),'\\D','','g')=$2)) ORDER BY customer_name LIMIT 8`, [q, isDot ? digits : ''])).rows;
    let carriers = [], fmcsaError = '';
    try { carriers = isDot ? [await lookupFmcsaCarrier(digits)] : (q.length >= 3 && searchFmcsaCarriersByName ? await searchFmcsaCarriersByName(q) : []); } catch (e) { fmcsaError = e.message; }
    return { customers, carriers, fmcsaError };
  }));
  app.get('/api/annual-inspections/units', auth, adminOnly, read(async (db, req) => ({ items: (await db.query(`SELECT id,unit_number,vin,plate,year,make,model FROM customer_units WHERE ($1::bigint IS NULL OR customer_id=$1::bigint) AND ($2='' OR unit_number ILIKE '%'||$2||'%' OR coalesce(vin,'') ILIKE '%'||$2||'%') ORDER BY unit_number LIMIT 50`, [req.query.customerId || null, str(req.query.q, 60)])).rows })));
  const docValues = (b, preview = false) => { const template = INSPECTION_TEMPLATES[b?.template] ? b.template : null; if (!template) fail(400, 'Pick the truck or trailer form.'); const f = cleanInspectionFields(b.fields); if (!f.carrierName && !preview) fail(400, 'Motor carrier name is required.'); return { template, f }; };
  app.post('/api/inspection-docs/preview', auth, adminOnly, async (req, res, next) => {
    try { const { template, f } = docValues(req.body || {}, true); res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', 'inline; filename="annual-inspection-preview.pdf"'); res.send(await renderInspectionTemplate(template, f)); }
    catch (e) { if (e?.status) return res.status(e.status).json({ error: e.message }); next(e); }
  });
  app.post('/api/inspection-docs', auth, adminOnly, read(async (db, req) => {
    const { template, f } = docValues(req.body || {}), id = req.body?.id ? Number(req.body.id) : null, vals = [template, JSON.stringify(f), f.carrierName, f.unitNumber, f.vin, f.date, req.body?.customerId || null, req.body?.unitId || null];
    const r = id ? await db.query(`UPDATE inspection_documents SET template=$2,fields=$3::jsonb,carrier_name=$4,unit_number=$5,vin=$6,doc_date=$7,customer_id=$8::bigint,unit_id=$9::bigint,updated_at=now() WHERE id=$1::bigint RETURNING id`, [id, ...vals])
      : await db.query(`INSERT INTO inspection_documents(template,fields,carrier_name,unit_number,vin,doc_date,customer_id,unit_id,created_by) VALUES($1,$2::jsonb,$3,$4,$5,$6,$7::bigint,$8::bigint,$9) RETURNING id`, [...vals, req.user.username]);
    if (!r.rowCount) fail(404, 'Document not found.');
    await audit(req.user.username, 'inspection_document_saved', { id: r.rows[0].id, template, unit: f.unitNumber, vin: f.vin });
    return { ok: true, id: r.rows[0].id };
  }));
  app.get('/api/inspection-docs/:id', auth, adminOnly, read(async (db, req) => { const r = (await db.query('SELECT * FROM inspection_documents WHERE id=$1::bigint', [req.params.id])).rows[0]; if (!r) fail(404, 'Document not found.'); return { item: r }; }));
  app.delete('/api/inspection-docs/:id', auth, adminOnly, read(async (db, req) => { await db.query('DELETE FROM inspection_documents WHERE id=$1::bigint', [req.params.id]); await audit(req.user.username, 'inspection_document_deleted', { id: req.params.id }); return { ok: true }; }));
  app.get('/api/inspection-docs/:id/pdf', auth, adminOnly, async (req, res, next) => {
    try {
      const r = (await requireDb().query('SELECT * FROM inspection_documents WHERE id=$1::bigint', [req.params.id])).rows[0]; if (!r) return res.status(404).json({ error: 'Document not found.' });
      res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="Annual-Inspection-${String(r.unit_number || r.vin || r.id).replace(/[^A-Za-z0-9_-]/g, '_')}.pdf"`);
      res.send(await renderInspectionTemplate(r.template, r.fields));
    } catch (e) { next(e); }
  });

  // --- fleet maintenance
  app.get('/api/fleet-maintenance', auth, adminOnly, read(async db => {
    const items = await fleetItemsWithStatus(db), cfg = await getSetting(db, 'fleet_alerts', { enabled: true, email: '' });
    const units = (await db.query(`SELECT id,unit_number,vin,customer_name,odometer_miles,odometer_at,odometer_source,mileage,samsara_vehicle_id FROM customer_units ORDER BY (samsara_vehicle_id IS NULL),unit_number LIMIT 2000`)).rows;
    return { items, units, types: SERVICE_TYPES, alerts: { ...cfg, defaultEmail: process.env.INVOICE_REPLY_TO || process.env.SHOP_EMAIL || '' }, samsara: !!samsaraConfigured() };
  }));
  const itemInput = async (db, b) => {
    const t = SERVICE_TYPES[b.serviceType] ? b.serviceType : 'custom';
    let unitId = b.unitId ? Number(b.unitId) || null : null, vin = str(b.vin, 20).toUpperCase(), label = str(b.unitLabel, 60);
    if (!unitId && vin) unitId = (await db.query(`SELECT id FROM customer_units WHERE upper(coalesce(vin,''))=$1 LIMIT 1`, [vin])).rows[0]?.id || null;
    if (!unitId && label) unitId = (await db.query(`SELECT id FROM customer_units WHERE lower(unit_number)=lower($1) ORDER BY samsara_vehicle_id IS NULL LIMIT 1`, [label])).rows[0]?.id || null;
    if (!unitId && !vin && !label) fail(400, 'Pick a unit or enter a VIN / unit number.');
    return { unitId, vin, label, type: t, name: str(b.name, 120) || SERVICE_TYPES[t].name, intervalMiles: b.intervalMiles === undefined ? SERVICE_TYPES[t].miles : intOrNull(b.intervalMiles), intervalDays: b.intervalDays === undefined ? SERVICE_TYPES[t].days : intOrNull(b.intervalDays),
      warnMiles: intOrNull(b.warnMiles) ?? 1000, warnDays: intOrNull(b.warnDays) ?? 30, lastDate: iso(b.lastDoneDate), lastMiles: b.lastDoneMiles === '' || b.lastDoneMiles == null ? null : Number(b.lastDoneMiles) || null, dueDate: iso(b.dueDate), notes: str(b.notes, 500) };
  };
  app.post('/api/fleet-maintenance', auth, adminOnly, read(async (db, req) => {
    const bulk = Array.isArray(req.body?.items), list = bulk ? req.body.items.slice(0, 500) : [req.body || {}], ids = [], errors = [];
    for (const [n, b] of list.entries()) {
      let x; try { x = await itemInput(db, b); } catch (e) { if (!bulk) throw e; errors.push({ line: n + 1, error: e.message }); continue; }
      ids.push((await db.query(`INSERT INTO fleet_service_items(unit_id,unit_label,vin,service_type,name,interval_miles,interval_days,warn_miles,warn_days,last_done_date,last_done_miles,due_date,notes,created_by)
        VALUES($1::bigint,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11::numeric,$12::date,$13,$14) RETURNING id`, [x.unitId, x.label, x.vin, x.type, x.name, x.intervalMiles, x.intervalDays, x.warnMiles, x.warnDays, x.lastDate, x.lastMiles, x.dueDate, x.notes, req.user.username])).rows[0].id);
    }
    await audit(req.user.username, 'fleet_service_items_added', { count: ids.length, skipped: errors.length }); return { ok: true, ids, errors };
  }));
  app.put('/api/fleet-maintenance/:id', auth, adminOnly, read(async (db, req) => {
    const x = await itemInput(db, req.body || {});
    const r = await db.query(`UPDATE fleet_service_items SET unit_id=$2::bigint,unit_label=$3,vin=$4,service_type=$5,name=$6,interval_miles=$7,interval_days=$8,warn_miles=$9,warn_days=$10,last_done_date=$11::date,last_done_miles=$12::numeric,due_date=$13::date,notes=$14,last_alert_level=NULL,updated_at=now() WHERE id=$1::bigint`,
      [req.params.id, x.unitId, x.label, x.vin, x.type, x.name, x.intervalMiles, x.intervalDays, x.warnMiles, x.warnDays, x.lastDate, x.lastMiles, x.dueDate, x.notes]);
    if (!r.rowCount) fail(404, 'Service item not found.'); return { ok: true };
  }));
  app.post('/api/fleet-maintenance/:id/done', auth, adminOnly, tx(async (db, req) => {
    const it = (await db.query('SELECT f.*,u.odometer_miles,u.mileage FROM fleet_service_items f LEFT JOIN customer_units u ON u.id=f.unit_id WHERE f.id=$1::bigint FOR UPDATE OF f', [req.params.id])).rows[0]; if (!it) fail(404, 'Service item not found.');
    const date = iso(req.body?.doneDate) || new Date().toISOString().slice(0, 10), miles = req.body?.doneMiles != null && req.body.doneMiles !== '' ? Number(req.body.doneMiles) : (it.odometer_miles ?? it.mileage ?? null);
    const nextDue = iso(req.body?.nextDueDate);
    await db.query('INSERT INTO fleet_service_history(item_id,done_date,done_miles,note,work_order_id,recorded_by) VALUES($1,$2::date,$3::numeric,$4,$5,$6)', [it.id, date, miles, str(req.body?.note, 500), str(req.body?.workOrderId, 20) || null, req.user.username]);
    await db.query('UPDATE fleet_service_items SET last_done_date=$2::date,last_done_miles=$3::numeric,due_date=$4::date,last_alert_level=NULL,updated_at=now() WHERE id=$1', [it.id, date, miles, nextDue]);
    await audit(req.user.username, 'fleet_service_done', { itemId: it.id, date, miles }); return { ok: true };
  }));
  app.get('/api/fleet-maintenance/:id/history', auth, adminOnly, read(async (db, req) => ({ items: (await db.query('SELECT * FROM fleet_service_history WHERE item_id=$1::bigint ORDER BY done_date DESC,id DESC', [req.params.id])).rows })));
  app.delete('/api/fleet-maintenance/:id', auth, adminOnly, read(async (db, req) => { await db.query('UPDATE fleet_service_items SET active=false,updated_at=now() WHERE id=$1::bigint', [req.params.id]); return { ok: true }; }));
  app.post('/api/fleet-maintenance/sync-miles', auth, adminOnly, read(async db => { if (!samsaraConfigured()) fail(503, 'Samsara is not configured. Add SAMSARA_API_TOKEN in Railway.'); return { ok: true, ...(await syncSamsaraOdometers(db, samsaraPaged)) }; }));
  app.put('/api/fleet-maintenance/settings/alerts', auth, ownerOnly, read(async (db, req) => {
    const v = { enabled: req.body?.enabled !== false, email: str(req.body?.email, 254) };
    if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) fail(400, 'Enter a valid email address.');
    await db.query(`INSERT INTO shop_settings(setting_key,value,updated_by,updated_at) VALUES('fleet_alerts',$1::jsonb,$2,now()) ON CONFLICT(setting_key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`, [JSON.stringify(v), req.user.username]);
    return { ok: true, alerts: v };
  }));
  app.post('/api/fleet-maintenance/alerts/send', auth, ownerOnly, read(async db => runFleetAlerts(db, { force: true })));
  app.get('/api/fleet-maintenance/summary', auth, adminOnly, read(async db => { const items = await fleetItemsWithStatus(db); return { overdue: items.filter(i => i.status === 'overdue').length, dueSoon: items.filter(i => i.status === 'due_soon').length }; }));

  // --- owner data reset
  app.get('/api/admin/reset-data/preview', auth, ownerOnly, read(async db => {
    const out = {};
    for (const [k, v] of Object.entries(RESET_SCOPES)) { let n = 0; for (const t of v.tables) { const ok = (await db.query('SELECT to_regclass($1) t', [`public.${t}`])).rows[0]?.t; if (ok) n += Number((await db.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n); } out[k] = { label: v.label, rows: n }; }
    const sf = (await db.query(`SELECT payload FROM app_state WHERE state_key='shopflow'`)).rows[0]?.payload || {};
    out.work_orders.rows += (sf.workorders || []).length;
    return { scopes: out, snapshots: (await db.query('SELECT id,scopes,created_by,created_at FROM data_reset_snapshots ORDER BY id DESC LIMIT 10')).rows };
  }));
  app.post('/api/admin/reset-data', auth, ownerOnly, tx(async (db, req) => {
    if (String(req.body?.confirm || '').trim().toUpperCase() !== 'START FRESH') fail(400, 'Type START FRESH to confirm.');
    const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes.map(String) : []; if (!scopes.some(s => RESET_SCOPES[s])) fail(400, 'Pick at least one thing to reset.');
    const r = await resetData(db, scopes, req.user.username); await audit(req.user.username, 'data_reset', r); return { ok: true, ...r };
  }));
  app.get('/api/admin/reset-data/snapshots/:id', auth, ownerOnly, async (req, res, next) => {
    try { const r = (await requireDb().query('SELECT * FROM data_reset_snapshots WHERE id=$1::bigint', [req.params.id])).rows[0]; if (!r) return res.status(404).json({ error: 'Snapshot not found.' });
      res.setHeader('Content-Disposition', `attachment; filename="ittr-reset-snapshot-${r.id}.json"`); res.json(r); } catch (e) { next(e); }
  });
}

export function startFleetScheduler({ pool, samsaraPaged, samsaraConfigured }) {
  if (!pool) return;
  const tick = async () => {
    try { if (samsaraConfigured()) await syncSamsaraOdometers(pool, samsaraPaged); } catch (e) { console.warn('[fleet odometer sync]', e?.message || e); }
    try { const r = await runFleetAlerts(pool); if (r.count) console.log(`[fleet alerts] ${r.count} item(s), email ${r.sent ? 'sent' : `not sent${r.error ? `: ${r.error}` : ''}`}`); } catch (e) { console.warn('[fleet alerts]', e?.message || e); }
  };
  setTimeout(tick, 90 * 1000).unref?.();
  setInterval(tick, 6 * 3600 * 1000).unref?.();
}
