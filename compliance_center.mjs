// ITTR ShopFlow v24.39.0 compliance center:
//  - Annual vehicle inspection reports (49 CFR 396.17/396.21) with printable PDF
//  - Fleet PM / CARB / recurring maintenance tracking (miles from Samsara, alerts by email)
//  - Owner "start fresh" reset of test data, with a snapshot kept for recovery
import crypto from 'node:crypto';
import { getSetting } from './finance_center.mjs';
import { alertEmailHtml, sendResendEmail } from './email_templates.mjs';

// ---------------------------------------------------------------- annual inspection items (49 CFR 396, Appendix G)
export const INSPECTION_SECTIONS = Object.freeze([
  ['1', 'BRAKE SYSTEM', [['a', 'Service Brakes'], ['b', 'Parking Brake System'], ['c', 'Brake Drums or Rotors'], ['d', 'Brake Hose'], ['e', 'Brake Tubing'], ['f', 'Low Pressure Warning Device'], ['g', 'Tractor Protection Valve'], ['h', 'Air Compressor'], ['i', 'Electric Brakes'], ['j', 'Hydraulic Brakes'], ['k', 'Vacuum Systems']]],
  ['2', 'COUPLING DEVICES', [['a', 'Fifth Wheels'], ['b', 'Pintle Hooks'], ['c', 'Drawbar/Towbar Eye'], ['d', 'Drawbar/Towbar Tongue'], ['e', 'Safety Devices'], ['f', 'Saddle-Mounts']]],
  ['3', 'EXHAUST SYSTEM', [['a', 'Any exhaust system determined to be leaking at a point forward of or directly below the driver/sleeper compartment.'], ['b', 'A bus exhaust system leaking or discharging to the atmosphere in violation of standards (1), (2) or (3).'], ['c', 'No part of the exhaust system of any motor vehicle shall be so located as would be likely to result in burning, charring, or damaging the electrical wiring, the fuel supply, or any combustible part of the motor vehicle.']]],
  ['4', 'FUEL SYSTEM', [['a', 'Visible leak'], ['b', 'Fuel tank filler cap missing'], ['c', 'Fuel tank securely attached']]],
  ['5', 'LIGHTING DEVICES', [['a', 'All lighting devices and reflectors required by Section 393 shall be operable.']]],
  ['6', 'SAFE LOADING', [['a', 'Part(s) of vehicle or condition of loading such that the spare tire or any part of the load or dunnage can fall onto the roadway.'], ['b', 'Protection against shifting cargo']]],
  ['7', 'STEERING MECHANISM', [['a', 'Steering Wheel Free Play'], ['b', 'Steering Column'], ['c', 'Front Axle Beam and All Steering Components Other Than Steering Column'], ['d', 'Steering Gear Box'], ['e', 'Pitman Arm'], ['f', 'Power Steering'], ['g', 'Ball and Socket Joints'], ['h', 'Tie Rods and Drag Links'], ['i', 'Nuts'], ['j', 'Steering System']]],
  ['8', 'SUSPENSION', [['a', 'Any U-bolt(s), spring hanger(s), or other axle positioning part(s) cracked, broken, loose or missing resulting in shifting of an axle from its normal position.'], ['b', 'Spring Assembly'], ['c', 'Torque, Radius or Tracking Components.']]],
  ['9', 'FRAME', [['a', 'Frame Members'], ['b', 'Tire and Wheel Clearance'], ['c', 'Adjustable Axle Assemblies (Sliding Subframes)']]],
  ['10', 'TIRES', [['a', 'Tires on any steering axle of a power unit.'], ['b', 'All other tires.']]],
  ['11', 'WHEELS AND RIMS', [['a', 'Lock or Side Ring'], ['b', 'Wheels and Rims'], ['c', 'Fasteners'], ['d', 'Welds']]],
  ['12', 'WINDSHIELD GLAZING', [['a', 'Requirements and exceptions as stated pertaining to any crack, discoloration or vision reducing matter (reference 393.60 for exceptions)']]],
  ['13', 'WINDSHIELD WIPERS', [['a', 'Any power unit that has an inoperative wiper, or missing or damaged parts that render it ineffective.']]]
]);
export const INSPECTION_CODES = INSPECTION_SECTIONS.flatMap(([n, , items]) => items.map(([l]) => `${n}${l}`));
// Items that normally do not apply, per vehicle type (the inspector can still change any of them).
export const INSPECTION_PRESETS = Object.freeze({
  tractor: ['1i', '1j', '1k', '2b', '2c', '2d', '2f', '3b', '9c'],
  truck: ['1g', '1i', '1j', '1k', '2a', '2b', '2c', '2d', '2e', '2f', '3b', '9c'],
  trailer: ['1f', '1g', '1h', '1i', '1j', '1k', '2a', '2b', '2c', '2d', '2f', '3a', '3b', '3c', '4a', '4b', '4c', '7a', '7b', '7c', '7d', '7e', '7f', '7g', '7h', '7i', '7j', '10a', '12a', '13a'],
  other: []
});
export function presetItems(type) {
  const na = new Set(INSPECTION_PRESETS[type] || []);
  return Object.fromEntries(INSPECTION_CODES.map(c => [c, { status: na.has(c) ? 'na' : 'ok', repairedDate: '' }]));
}
export function cleanItems(raw, type) {
  const base = presetItems(type), out = {};
  for (const c of INSPECTION_CODES) {
    const x = raw && typeof raw === 'object' ? raw[c] : null;
    const status = ['ok', 'repair', 'na', 'repaired'].includes(x?.status) ? x.status : base[c].status;
    const repairedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(x?.repairedDate || '')) ? x.repairedDate : '';
    out[c] = { status: status === 'repaired' && !repairedDate ? 'repair' : status, repairedDate: status === 'repaired' ? repairedDate : '' };
  }
  return out;
}
export const inspectionResult = items => Object.values(items).some(i => i.status === 'repair') ? 'needs_repair' : 'passed';

// ---------------------------------------------------------------- PDF (letter, one page, 3 item columns)
export async function renderAnnualInspectionPdf({ PDFDocument, report: r, shop }) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 28, info: { Title: `Annual Vehicle Inspection ${r.report_number}` } });
  const chunks = []; doc.on('data', c => chunks.push(c)); const done = new Promise(res => doc.on('end', () => res(Buffer.concat(chunks))));
  const L = 28, R = 584, W = R - L, INK = '#111827', MUT = '#4b5563', LINE = '#111827', GRAY = '#d1d5db';
  const t = (s, x, y, o = {}) => doc.text(String(s ?? ''), x, y, { lineBreak: o.width ? true : false, ...o });
  const box = (x, y, w, h, fill) => { doc.save().lineWidth(.7).rect(x, y, w, h); fill ? doc.fillAndStroke(fill, LINE) : doc.stroke(LINE); doc.restore(); };
  const check = (x, y, on) => { box(x, y, 8, 8); if (on) doc.save().lineWidth(1.2).moveTo(x + 1.5, y + 1.5).lineTo(x + 6.5, y + 6.5).moveTo(x + 6.5, y + 1.5).lineTo(x + 1.5, y + 6.5).stroke(INK).restore(); };
  const date = v => { if (!v) return ''; const d = new Date(String(v).slice(0, 10) + 'T12:00:00'); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; };
  // title + history box
  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK); t('ANNUAL VEHICLE INSPECTION REPORT', L, 30, { width: 360, align: 'center' });
  doc.font('Helvetica').fontSize(8).fillColor(MUT); t(`${shop.name} · ${shop.address1}, ${shop.address2}${shop.phone ? ` · ${shop.phone}` : ''}`, L, 52, { width: 360, align: 'center' });
  const hx = 402, hw = R - hx; box(hx, 24, hw, 14, '#374151'); doc.font('Helvetica-Bold').fontSize(8).fillColor('#fff'); t('VEHICLE HISTORY RECORD', hx, 28, { width: hw, align: 'center' });
  box(hx, 38, hw / 2, 30); box(hx + hw / 2, 38, hw / 2, 30); box(hx, 68, hw, 22);
  doc.fillColor(INK).font('Helvetica').fontSize(6.5); t('REPORT NUMBER', hx + 4, 41); t('FLEET UNIT NUMBER', hx + hw / 2 + 4, 41); t('DATE', hx + 4, 71);
  doc.font('Helvetica-Bold').fontSize(11); t(r.report_number, hx + 4, 53, { width: hw / 2 - 8 }); t(r.fleet_unit_number || '', hx + hw / 2 + 4, 53, { width: hw / 2 - 8, align: 'center' }); t(date(r.inspection_date), hx + 40, 75, { width: hw - 50, align: 'center' });
  // info grid
  let y = 96; const half = W / 2;
  const cell = (x, yy, w, h, label, value, size = 11) => { box(x, yy, w, h); doc.font('Helvetica').fontSize(6.5).fillColor(INK); t(label, x + 4, yy + 3); doc.font('Helvetica').fontSize(size); t(value || '', x + 4, yy + 12, { width: w - 8, height: h - 12, ellipsis: true }); };
  cell(L, y, half, 26, 'MOTOR CARRIER OPERATOR', r.carrier_name); cell(L + half, y, half, 26, "INSPECTOR'S NAME (PRINT OR TYPE)", r.inspector_name);
  y += 26; cell(L, y, half, 26, 'ADDRESS', r.carrier_address);
  box(L + half, y, half, 26); doc.font('Helvetica').fontSize(6.5); t('THIS INSPECTOR MEETS THE QUALIFICATION REQUIREMENTS IN SECTION 396.19.', L + half + 4, y + 3); check(L + half + 4, y + 13, r.inspector_qualified !== false); doc.fontSize(8); t('YES', L + half + 16, y + 14);
  y += 26; cell(L, y, half, 26, 'CITY, STATE, ZIP CODE', r.carrier_city_state_zip);
  box(L + half, y, half, 26); doc.font('Helvetica').fontSize(6.5); t('VEHICLE IDENTIFICATION AND COMPLETE:', L + half + 4, y + 3);
  const idk = r.id_kind || 'vin'; let cx = L + half + 150; for (const [k, lbl] of [['plate', 'LIC. PLATE NO.'], ['vin', 'VIN'], ['other', 'OTHER']]) { check(cx, y + 2, idk === k); t(lbl, cx + 11, y + 3); cx += k === 'plate' ? 62 : 32; }
  doc.fontSize(11); t(idk === 'plate' ? r.plate : idk === 'other' ? r.id_other : r.vin, L + half + 4, y + 13, { width: half - 8 });
  y += 26; box(L, y, half, 28); doc.fontSize(6.5); t('VEHICLE TYPE', L + 4, y + 3);
  cx = L + 58; for (const [k, lbl] of [['tractor', 'TRACTOR'], ['trailer', 'TRAILER'], ['truck', 'TRUCK']]) { check(cx, y + 2, r.vehicle_type === k); doc.fontSize(8); t(lbl, cx + 11, y + 2.5); cx += 58; }
  check(L + 58, y + 15, r.vehicle_type === 'other'); doc.fontSize(8); t(`(OTHER)${r.vehicle_type === 'other' && r.other_type ? ` ${r.other_type}` : ''}`, L + 69, y + 15.5);
  cell(L + half, y, half, 28, 'INSPECTION AGENCY/LOCATION (OPTIONAL)', r.agency_location);
  y += 34;
  // components
  box(L, y, W, 13, '#374151'); doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#fff'); t('VEHICLE COMPONENTS INSPECTED', L, y + 3, { width: W, align: 'center' }); doc.fillColor(INK); y += 13;
  const colW = W / 3, cOk = 18, cNr = 22, cRd = 30, textW = colW - cOk - cNr - cRd - 6, top = y;
  for (let c = 0; c < 3; c++) { const x = L + c * colW; box(x, y, colW, 14, '#f3f4f6'); doc.font('Helvetica-Bold').fontSize(5.2); t('OK', x, y + 5, { width: cOk, align: 'center' }); t('NEEDS', x + cOk, y + 2, { width: cNr, align: 'center' }); t('REPAIR', x + cOk, y + 7.5, { width: cNr, align: 'center' }); t('REPAIRED', x + cOk + cNr, y + 2, { width: cRd, align: 'center' }); t('DATE', x + cOk + cNr, y + 7.5, { width: cRd, align: 'center' }); doc.fontSize(7); t('ITEM', x + cOk + cNr + cRd, y + 5, { width: textW, align: 'center' }); }
  y += 14;
  // Pre-measure every row, then split into 3 balanced columns.
  doc.font('Helvetica').fontSize(7);
  const rows = []; for (const [n, name, items] of INSPECTION_SECTIONS) { rows.push({ head: `${n}. ${name}`, h: 10 }); for (const [l, txt] of items) rows.push({ code: `${n}${l}`, text: `${l}. ${txt}`, h: Math.max(10, doc.heightOfString(`${l}. ${txt}`, { width: textW - 8 }) + 2) }); }
  const total = rows.reduce((a, r2) => a + r2.h, 0), target = total / 3, cols = [[], [], []]; let ci = 0, acc = 0;
  for (const row of rows) {
    if (ci < 2 && acc + row.h > target + 4) {
      ci++; acc = 0;
      const prev = cols[ci - 1]; if (prev.length && prev[prev.length - 1].head) { const h = prev.pop(); cols[ci].push(h); acc += h.h; } // never leave a heading alone at the bottom
    }
    cols[ci].push(row); acc += row.h;
  }
  const bottom = y + Math.max(...cols.map(cl => cl.reduce((a, r2) => a + r2.h, 0))) + 4;
  cols.forEach((cl, c) => {
    const x = L + c * colW; let yy = y;
    for (const row of cl) {
      if (row.head) { doc.font('Helvetica-Bold').fontSize(7.2).fillColor(INK); t(row.head, x + cOk + cNr + cRd + 3, yy + 2); yy += row.h; continue; }
      const it = r.items?.[row.code] || { status: 'ok' };
      doc.font('Helvetica-Bold').fontSize(7.5);
      if (it.status === 'ok') t('X', x, yy + 1, { width: cOk, align: 'center' });
      else if (it.status === 'na') t('N/A', x, yy + 1, { width: cOk, align: 'center' });
      else { t('X', x + cOk, yy + 1, { width: cNr, align: 'center' }); if (it.status === 'repaired' && it.repairedDate) { doc.font('Helvetica').fontSize(5.6); t(date(it.repairedDate), x + cOk + cNr, yy + 2, { width: cRd, align: 'center' }); } }
      doc.font('Helvetica').fontSize(7).fillColor(INK); t(row.text, x + cOk + cNr + cRd + 9, yy + 1, { width: textW - 8 });
      yy += row.h; doc.save().lineWidth(.3).moveTo(x, yy).lineTo(x + cOk + cNr + cRd, yy).stroke(GRAY).restore();
    }
    for (const dx of [0, cOk, cOk + cNr, cOk + cNr + cRd]) doc.save().lineWidth(.7).moveTo(x + dx, y - 14).lineTo(x + dx, bottom).stroke(LINE).restore();
  });
  box(L, top, W, bottom - top);
  // other conditions
  y = bottom + 6; doc.font('Helvetica').fontSize(7.2); t('List any other condition which may prevent safe operation of this vehicle:', L, y);
  doc.font('Helvetica').fontSize(9); t(r.other_conditions || 'NONE', L + 250, y - 1, { width: W - 250 }); y += 16;
  doc.fontSize(6.8).fillColor(MUT); t('INSTRUCTIONS: MARK COLUMN ENTRIES TO VERIFY INSPECTION:  X  OK,  X  NEEDS REPAIR,  N/A  IF ITEMS DO NOT APPLY,  DATE  REPAIRED DATE', L, y, { width: W, align: 'center' }); y += 12;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5);
  const passed = inspectionResult(r.items || {}) === 'passed';
  t(passed ? 'CERTIFICATION: THIS VEHICLE HAS PASSED ALL THE INSPECTION ITEMS FOR THE ANNUAL VEHICLE INSPECTION REPORT IN ACCORDANCE WITH 49 CFR 396.'
    : 'THIS VEHICLE HAS ITEMS MARKED NEEDS REPAIR. IT DOES NOT PASS THE ANNUAL INSPECTION UNTIL THOSE ITEMS ARE REPAIRED (49 CFR 396.17).', L, y, { width: W }); y = doc.y + 14;
  doc.font('Helvetica').fontSize(8); doc.save().lineWidth(.7).moveTo(L, y + 12).lineTo(L + 250, y + 12).moveTo(L + 300, y + 12).lineTo(R, y + 12).stroke(LINE).restore();
  t("INSPECTOR'S SIGNATURE", L, y + 15); t('DATE', L + 300, y + 15); doc.fontSize(10); t(date(r.inspection_date), L + 300, y, { width: 150 });
  doc.page.margins.bottom = 0; // footer must not push a blank second page
  doc.fontSize(6.5).fillColor(MUT); t(`Report ${r.report_number} · Prepared with ITTR ShopFlow by ${shop.name}. Keep with the vehicle file for 14 months (49 CFR 396.21).`, L, 772, { width: W, align: 'center' });
  doc.end(); return done;
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
  CREATE TABLE IF NOT EXISTS annual_inspections(
    id BIGSERIAL PRIMARY KEY, report_number TEXT UNIQUE NOT NULL, inspection_date DATE NOT NULL DEFAULT CURRENT_DATE,
    vehicle_type TEXT NOT NULL DEFAULT 'tractor', other_type TEXT, customer_id BIGINT, unit_id BIGINT, usdot TEXT,
    carrier_name TEXT NOT NULL DEFAULT '', carrier_address TEXT, carrier_city_state_zip TEXT,
    fleet_unit_number TEXT, id_kind TEXT NOT NULL DEFAULT 'vin', vin TEXT, plate TEXT, id_other TEXT,
    inspector_name TEXT, inspector_qualified BOOLEAN NOT NULL DEFAULT TRUE, agency_location TEXT,
    items JSONB NOT NULL DEFAULT '{}'::jsonb, other_conditions TEXT, result TEXT NOT NULL DEFAULT 'passed',
    created_by TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_annual_inspections_date ON annual_inspections(inspection_date DESC);
  CREATE INDEX IF NOT EXISTS idx_annual_inspections_vin ON annual_inspections(upper(vin));
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
  productivity: { label: 'Mechanic productivity (task timers + activity history)', tables: ['task_time_sessions', 'task_time_adjustments'] },
  work_orders: { label: 'Work orders, findings and their inspections', tables: ['mechanic_inspections', 'service_orders'] },
  billing: { label: 'Invoices, payments, estimates and email logs', tables: ['customer_invoice_payments', 'customer_invoice_lines', 'customer_invoices', 'invoice_email_deliveries', 'customer_estimate_lines', 'customer_estimates'] },
  gmail: { label: 'Gmail money inbox items (accounts stay connected)', tables: ['gmail_finance_messages'] },
  annual_inspections: { label: 'Annual inspection reports', tables: ['annual_inspections'] }
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
  const order = ['customer_invoice_payments', 'customer_invoice_lines', 'invoice_email_deliveries', 'customer_invoices', 'customer_estimate_lines', 'customer_estimates', 'task_time_adjustments', 'task_time_sessions', 'mechanic_inspections', 'service_orders', 'gmail_finance_messages', 'annual_inspections'];
  for (const t of order) if (snapshot[t]) {
    if (t === 'gmail_finance_messages') await db.query(`DELETE FROM gmail_finance_messages`);
    else await db.query(`DELETE FROM ${t}`);
  }
  return { scopes: chosen, counts };
}

// ---------------------------------------------------------------- routes
export function registerComplianceRoutes(app, deps) {
  const { auth, ownerOnly, adminOnly, requireDb, audit, PDFDocument, shopProfile, lookupFmcsaCarrier, samsaraPaged, samsaraConfigured } = deps;
  const read = h => async (req, res, next) => { try { res.json(await h(requireDb(), req, res)); } catch (e) { if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code }); next(e); } };
  const tx = h => async (req, res, next) => { const db = await requireDb().connect(); try { await db.query('BEGIN'); const out = await h(db, req); await db.query('COMMIT'); res.json(out); } catch (e) { try { await db.query('ROLLBACK'); } catch {} if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code }); next(e); } finally { db.release(); } };
  const fail = (s, m) => { throw Object.assign(new Error(m), { status: s }); };
  const str = (v, n = 300) => String(v ?? '').trim().slice(0, n);

  // --- annual inspections
  app.get('/api/annual-inspections/meta', auth, adminOnly, (req, res) => res.json({ sections: INSPECTION_SECTIONS, presets: INSPECTION_PRESETS, shop: shopProfile() }));
  app.get('/api/annual-inspections', auth, adminOnly, read(async (db, req) => {
    const q = str(req.query.q, 100);
    return { items: (await db.query(`SELECT id,report_number,inspection_date,vehicle_type,carrier_name,usdot,fleet_unit_number,vin,plate,inspector_name,result,created_by,updated_at FROM annual_inspections
      WHERE ($1='' OR carrier_name ILIKE '%'||$1||'%' OR coalesce(vin,'') ILIKE '%'||$1||'%' OR coalesce(fleet_unit_number,'') ILIKE '%'||$1||'%' OR coalesce(usdot,'')=$1 OR report_number ILIKE '%'||$1||'%') ORDER BY inspection_date DESC,id DESC LIMIT 300`, [q])).rows };
  }));
  app.get('/api/annual-inspections/lookup', auth, adminOnly, read(async (db, req) => {
    const q = str(req.query.q, 100); if (q.length < 2) return { customers: [], fmcsa: null };
    const customers = (await db.query(`SELECT id,customer_name,dot_number,coalesce(nullif(billing_address,''),address) address,coalesce(nullif(billing_city,''),city) city,coalesce(nullif(billing_state,''),state) state,coalesce(nullif(billing_postal_code,''),postal_code) postal_code
      FROM fullbay_import_customers WHERE deleted_at IS NULL AND (customer_name ILIKE '%'||$1||'%' OR regexp_replace(coalesce(dot_number,''),'\\D','','g')=regexp_replace($1,'\\D','','g')) ORDER BY customer_name LIMIT 8`, [q])).rows;
    let fmcsa = null, fmcsaError = '';
    if (/^\d{3,8}$/.test(q.replace(/\D/g, '')) && q.replace(/\D/g, '').length === q.replace(/\s/g, '').length) { try { fmcsa = await lookupFmcsaCarrier(q); } catch (e) { fmcsaError = e.message; } }
    return { customers, fmcsa, fmcsaError };
  }));
  app.get('/api/annual-inspections/units', auth, adminOnly, read(async (db, req) => ({ items: (await db.query(`SELECT id,unit_number,vin,plate,year,make,model FROM customer_units WHERE ($1::bigint IS NULL OR customer_id=$1::bigint) AND ($2='' OR unit_number ILIKE '%'||$2||'%' OR coalesce(vin,'') ILIKE '%'||$2||'%') ORDER BY unit_number LIMIT 50`, [req.query.customerId || null, str(req.query.q, 60)])).rows })));
  app.get('/api/annual-inspections/:id', auth, adminOnly, read(async (db, req) => { const r = (await db.query('SELECT * FROM annual_inspections WHERE id=$1::bigint', [req.params.id])).rows[0]; if (!r) fail(404, 'Inspection not found.'); return { item: r }; }));
  const saveInspection = async (db, req, id) => {
    const b = req.body || {}, type = ['tractor', 'trailer', 'truck', 'other'].includes(b.vehicleType) ? b.vehicleType : 'tractor', items = cleanItems(b.items, type);
    const vals = [iso(b.inspectionDate) || new Date().toISOString().slice(0, 10), type, str(b.otherType, 60), b.customerId || null, b.unitId || null, str(b.usdot, 12), str(b.carrierName, 160), str(b.carrierAddress, 200), str(b.carrierCityStateZip, 160),
      str(b.fleetUnitNumber, 40), ['vin', 'plate', 'other'].includes(b.idKind) ? b.idKind : 'vin', str(b.vin, 20).toUpperCase(), str(b.plate, 20).toUpperCase(), str(b.idOther, 60), str(b.inspectorName, 120), b.inspectorQualified !== false, str(b.agencyLocation, 200),
      JSON.stringify(items), str(b.otherConditions, 1000), inspectionResult(items)];
    if (!vals[6]) fail(400, 'Motor carrier name is required.');
    if (id) {
      const r = await db.query(`UPDATE annual_inspections SET inspection_date=$2::date,vehicle_type=$3,other_type=$4,customer_id=$5::bigint,unit_id=$6::bigint,usdot=$7,carrier_name=$8,carrier_address=$9,carrier_city_state_zip=$10,fleet_unit_number=$11,id_kind=$12,vin=$13,plate=$14,id_other=$15,inspector_name=$16,inspector_qualified=$17,agency_location=$18,items=$19::jsonb,other_conditions=$20,result=$21,updated_at=now() WHERE id=$1::bigint RETURNING id,report_number`, [id, ...vals]);
      if (!r.rowCount) fail(404, 'Inspection not found.'); return r.rows[0];
    }
    await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [2462]); const y = new Date().getFullYear();
    const n = (await db.query(`SELECT coalesce(max((regexp_match(report_number,$1))[1]::int),0)+1 n FROM annual_inspections WHERE report_number ~ $2`, [`^AI-${y}-([0-9]+)$`, `^AI-${y}-[0-9]+$`])).rows[0].n;
    return (await db.query(`INSERT INTO annual_inspections(report_number,inspection_date,vehicle_type,other_type,customer_id,unit_id,usdot,carrier_name,carrier_address,carrier_city_state_zip,fleet_unit_number,id_kind,vin,plate,id_other,inspector_name,inspector_qualified,agency_location,items,other_conditions,result,created_by)
      VALUES($1,$2::date,$3,$4,$5::bigint,$6::bigint,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22) RETURNING id,report_number`, [`AI-${y}-${String(n).padStart(5, '0')}`, ...vals, req.user.username])).rows[0];
  };
  app.post('/api/annual-inspections', auth, adminOnly, tx(async (db, req) => { const r = await saveInspection(db, req, null); await audit(req.user.username, 'annual_inspection_created', r); return { ok: true, ...r }; }));
  app.put('/api/annual-inspections/:id', auth, adminOnly, tx(async (db, req) => { const r = await saveInspection(db, req, req.params.id); await audit(req.user.username, 'annual_inspection_updated', r); return { ok: true, ...r }; }));
  app.delete('/api/annual-inspections/:id', auth, ownerOnly, read(async (db, req) => { await db.query('DELETE FROM annual_inspections WHERE id=$1::bigint', [req.params.id]); await audit(req.user.username, 'annual_inspection_deleted', { id: req.params.id }); return { ok: true }; }));
  app.get('/api/annual-inspections/:id/pdf', auth, adminOnly, async (req, res, next) => {
    try {
      const r = (await requireDb().query('SELECT * FROM annual_inspections WHERE id=$1::bigint', [req.params.id])).rows[0]; if (!r) return res.status(404).json({ error: 'Inspection not found.' });
      const buf = await renderAnnualInspectionPdf({ PDFDocument, report: r, shop: shopProfile() });
      res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="Annual-Inspection-${String(r.fleet_unit_number || r.report_number).replace(/[^A-Za-z0-9_-]/g, '_')}.pdf"`); res.send(buf);
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
