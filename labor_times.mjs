// ITTR ShopFlow v24.41.0 labor time analysis.
// Every labor job (invoice labor lines, completed work-order tasks, imported Fullbay history) is sorted into a
// job type by keywords ("wheel seal", "king pin", "PM"...). For each type the shop's typical billed hours are
// learned from the invoices, and each mechanic's real (task timer) hours are compared with that typical time.
import { getSetting } from './finance_center.mjs';

const T = (key, label, keywords, bookHours = null) => ({ key, label, keywords, bookHours });
// Order matters: the first type whose keyword appears wins, so specific jobs come before broad ones.
export const DEFAULT_JOB_TYPES = Object.freeze([
  T('king_pins', 'King pins', ['king pin*', 'kingpin*']),
  T('wheel_seal', 'Wheel seal', ['wheel seal*', 'hub seal*', 'axle seal*', 'oil seal*', 'hub oil seal*']),
  T('wheel_bearing', 'Wheel bearings / hub', ['wheel bearing*', 'hub bearing*', 'inner bearing*', 'outer bearing*', 'hub assembl*', 'wheel end*']),
  T('pm_service', 'PM service / lube', ['pm', 'pm a', 'pm b', 'pm service', 'preventive maint*', 'preventative maint*', 'oil change', 'lube*', 'lubricat*', 'grease*']),
  T('annual_inspection', 'Annual / DOT inspection', ['annual inspection*', 'annual', 'dot inspection*', 'fhwa', 'federal inspection*']),
  T('brake_chamber', 'Brake chamber', ['brake chamber*', 'spring brake*', 'air chamber*', 'maxi brake*', 'chamber*']),
  T('slack_adjuster', 'Slack adjuster', ['slack adjust*', 'slack*', 'auto slack*']),
  T('brakes', 'Brakes (shoes / drums)', ['brake job*', 'brake shoe*', 'shoes', 'brake drum*', 'drums', 'reline*', 'brake lining*', 'brakes', 'brake*', 'cam shaft*', 'camshaft*', 's cam*']),
  T('air_dryer', 'Air dryer', ['air dryer*', 'air drier*', 'dryer cartridge*', 'dryer']),
  T('air_system', 'Air leak / air lines', ['air leak*', 'air line*', 'air hose*', 'glad hand*', 'gladhand*', 'air valve*', 'relay valve*', 'air tank*', 'compressor*']),
  T('fifth_wheel', 'Fifth wheel', ['fifth wheel*', '5th wheel*']),
  T('landing_gear', 'Landing gear', ['landing gear*', 'landing leg*']),
  T('suspension', 'Suspension / air bags', ['air bag*', 'airbag*', 'air spring*', 'leaf spring*', 'shock*', 'torque rod*', 'torque arm*', 'suspension', 'spring hanger*', 'equalizer*', 'bushing*', 'ride height', 'leveling valve*']),
  T('driveline', 'Driveline / U-joints', ['u joint*', 'ujoint*', 'driveshaft*', 'drive shaft*', 'carrier bearing*', 'yoke*', 'driveline']),
  T('clutch', 'Clutch', ['clutch*']),
  T('aftertreatment', 'DPF / DEF / EGR', ['dpf', 'def', 'doc', 'egr', 'scr', 'regen*', 'aftertreatment', 'nox*', 'dosing*', 'diesel particulate*']),
  T('cooling', 'Cooling system', ['radiator*', 'coolant*', 'water pump*', 'thermostat*', 'fan clutch*', 'antifreeze', 'overheat*']),
  T('battery_starting', 'Batteries / starting / charging', ['batter*', 'starter*', 'alternator*', 'jump start*', 'no start', 'charging']),
  T('alignment', 'Alignment', ['alignment', 'align*', 'toe in', 'toe out']),
  T('tires', 'Tires', ['tire*', 'tyre*', 'flat', 'dismount*', 'mount and balance', 'recap*', 'steer tire*', 'drive tire*']),
  T('diagnostics', 'Diagnostics', ['diagnos*', 'diag', 'troubleshoot*', 'check engine*', 'scan*', 'fault code*', 'codes']),
  T('lights_electrical', 'Lights / wiring', ['light*', 'lamp*', 'bulb*', 'wiring', 'wire*', 'electrical', 'marker*', 'harness*', '7 way*', 'pigtail*', 'abs']),
  T('doors_body', 'Doors / body / mud flaps', ['door*', 'hinge*', 'roll up', 'rollup', 'panel*', 'mud flap*', 'mudflap*', 'bumper*', 'fender*', 'rear impact guard*', 'icc bumper*', 'conspicuity*', 'reflective tape*']),
  T('welding', 'Welding / fabrication', ['weld*', 'fabricat*', 'crack*']),
  T('engine', 'Engine', ['engine*', 'injector*', 'turbo*', 'head gasket*', 'valve adjust*', 'overhead*', 'fuel filter*', 'fuel pump*'])
]);

// ---------------------------------------------------------------- pure helpers (unit tested)
// Job name and line description are often the same text; keep each piece once.
export const joinText = (...parts) => { const out = []; for (const p of parts.map(x => String(x || '').trim()).filter(Boolean)) if (!out.some(o => o.toLowerCase().includes(p.toLowerCase()))) out.push(p); return out.join(' · '); };
const norm = s => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function compileJobTypes(types) {
  return types.filter(t => t && !t.disabled && Array.isArray(t.keywords) && t.keywords.length).map(t => {
    const parts = t.keywords.map(k => String(k || '').toLowerCase().replace(/[^a-z0-9* ]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(k => k && k !== '*')
      .map(k => k.endsWith('*') ? `${esc(k.slice(0, -1).trim())}[a-z0-9]*` : esc(k));
    return { ...t, re: parts.length ? new RegExp(` (?:${parts.join('|')}) `) : null };
  }).filter(t => t.re);
}
export function classifyJob(text, compiled) {
  const s = norm(text);
  for (const t of compiled) if (t.re.test(s)) return t.key;
  return null;
}
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const r2 = v => v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
export function describe(values) {
  const v = values.filter(x => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return { n: 0, median: null, p25: null, p75: null, avg: null, min: null, max: null };
  return { n: v.length, median: r2(quantile(v, .5)), p25: r2(quantile(v, .25)), p75: r2(quantile(v, .75)), avg: r2(v.reduce((a, b) => a + b, 0) / v.length), min: r2(v[0]), max: r2(v[v.length - 1]) };
}
// One mechanic doing one job: their share of the task's timer hours. A job counts toward a mechanic when they did
// at least 80% of it; otherwise it is a team job (still in the job-type statistics, not in personal comparisons).
export function leadMechanic(byMechanic) {
  const total = Object.values(byMechanic).reduce((a, b) => a + b, 0); if (!total) return null;
  const [name, secs] = Object.entries(byMechanic).sort((a, b) => b[1] - a[1])[0];
  return secs / total >= 0.8 ? name : 'team';
}
// Compare each mechanic with the shop's typical time for the same job type. Timer jobs are compared with the shop's
// median timer hours, Fullbay jobs with the Fullbay median, so the two sources are never mixed in one ratio.
// ratio 1.2 = took 20% longer than the shop usually does. billedEff = billed hours ÷ real hours on invoiced jobs.
export const basisOf = j => j.source === 'fullbay' ? 'fullbay' : 'timer';
export function typicalTimes(jobs) {
  const by = new Map();
  for (const j of jobs) { if (!j.type || !(j.mechHours > 0)) continue; const k = `${basisOf(j)}|${j.type}`; if (!by.has(k)) by.set(k, []); by.get(k).push(j.basisHours ?? j.mechHours); }
  return Object.fromEntries([...by].map(([k, v]) => [k, describe(v).median]));
}
export function compareMechanics(jobs, typical, minJobs = 1) {
  const by = new Map();
  for (const j of jobs) {
    const t = typical[`${basisOf(j)}|${j.type}`], h = j.mechHours;
    if (!j.mechanic || j.mechanic === 'team' || !t || !(h > 0)) continue;
    const k = `${j.mechanic}|${j.type}`;
    if (!by.has(k)) by.set(k, { mechanic: j.mechanic, type: j.type, hours: [], ratios: [], billed: 0, real: 0 });
    const x = by.get(k); x.hours.push(h); x.ratios.push(h / t);
    if (j.source !== 'fullbay' && j.billed > 0 && j.actual > 0) { x.billed += j.billed; x.real += j.actual; }
  }
  const eff = (b, r) => r > 0.05 && b > 0 ? Math.round(b / r * 100) : null;
  const cells = [...by.values()].filter(x => x.hours.length >= minJobs).map(x => {
    const d = describe(x.hours), ratio = quantile([...x.ratios].sort((a, b) => a - b), .5);
    return { mechanic: x.mechanic, type: x.type, n: d.n, median: d.median, avg: d.avg, ratio: r2(ratio), pct: Math.round((ratio - 1) * 100), billedEff: eff(x.billed, x.real), _b: x.billed, _r: x.real, _ratios: x.ratios };
  });
  const people = new Map();
  for (const c of cells) { if (!people.has(c.mechanic)) people.set(c.mechanic, { mechanic: c.mechanic, jobs: 0, types: 0, ratios: [], billed: 0, real: 0 }); const p = people.get(c.mechanic); p.jobs += c.n; p.types++; p.ratios.push(...c._ratios); p.billed += c._b; p.real += c._r; }
  for (const c of cells) { delete c._b; delete c._r; delete c._ratios; }
  const mechanics = [...people.values()].map(p => { const ratio = quantile(p.ratios.sort((a, b) => a - b), .5); return { mechanic: p.mechanic, jobs: p.jobs, types: p.types, ratio: r2(ratio), pct: Math.round((ratio - 1) * 100), billedEff: eff(p.billed, p.real), billedHours: r2(p.billed), realHours: r2(p.real) }; }).sort((a, b) => a.ratio - b.ratio);
  return { cells, mechanics };
}

// ---------------------------------------------------------------- data
async function loadJobTypes(db) {
  const s = await getSetting(db, 'labor_job_types', { types: null });
  return Array.isArray(s.types) && s.types.length ? s.types : DEFAULT_JOB_TYPES;
}
export function cleanJobTypes(list) {
  if (!Array.isArray(list)) throw Object.assign(new Error('Send the list of job types.'), { status: 400 });
  const seen = new Set();
  return list.slice(0, 80).map((t, i) => {
    const label = String(t?.label || '').replace(/[<>]/g, '').trim().slice(0, 60); if (!label) return null;
    let key = String(t?.key || label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || `type_${i}`;
    while (seen.has(key)) key += '_2'; seen.add(key);
    const keywords = (Array.isArray(t.keywords) ? t.keywords : String(t.keywords || '').split(',')).map(k => String(k).toLowerCase().replace(/[<>]/g, '').trim().slice(0, 40)).filter(Boolean).slice(0, 40);
    const bh = Number(t.bookHours); return { key, label, keywords, bookHours: Number.isFinite(bh) && bh > 0 && bh <= 100 ? Math.round(bh * 100) / 100 : null, disabled: t.disabled === true };
  }).filter(Boolean);
}

export async function loadLaborJobs(db, { from, to, source = 'all' }) {
  const jobs = [];
  const mechs = (await db.query(`SELECT username,display_name FROM auth_users WHERE role='mechanic'`)).rows;
  const display = new Map(mechs.map(m => [m.username, m.display_name || m.username]));
  // Fullbay tech names are matched to ShopFlow mechanics by full display name, then by first name when that is unique.
  const byName = new Map(), byFirst = new Map();
  for (const m of mechs) { const d = String(m.display_name || '').toLowerCase().trim(); if (d) byName.set(d, m.username); const f = d.split(/\s+/)[0]; if (f) byFirst.set(f, byFirst.has(f) ? null : m.username); }
  const techKey = name => { const n = String(name || '').split(/[,;/]/)[0].trim(); if (!n) return null; const l = n.toLowerCase(); return byName.get(l) || byFirst.get(l.split(/\s+/)[0]) || `fb:${n}`; };

  if (source !== 'fullbay') {
    const lines = (await db.query(`SELECT i.id invoice_id,i.invoice_number,i.invoice_date,i.work_order_id,i.unit_number,i.customer_name,coalesce(nullif(l.job_uid,''),'line-'||l.id) job,
        max(l.job_uid) job_uid,string_agg(DISTINCT coalesce(l.job_name,''),' ') job_name,string_agg(l.description,' · ' ORDER BY l.sort_order) description,sum(l.quantity) hours
      FROM customer_invoice_lines l JOIN customer_invoices i ON i.id=l.invoice_id
      WHERE l.line_type='labor' AND i.status<>'void' AND i.invoice_date BETWEEN $1::date AND $2::date
      GROUP BY i.id,i.invoice_number,i.invoice_date,i.work_order_id,i.unit_number,i.customer_name,coalesce(nullif(l.job_uid,''),'line-'||l.id)`, [from, to])).rows;
    const sf = (await db.query(`SELECT payload FROM app_state WHERE state_key='shopflow'`)).rows[0]?.payload || {};
    const tasks = [];
    for (const w of Array.isArray(sf.workorders) ? sf.workorders : []) for (const t of Array.isArray(w?.tasks) ? w.tasks : []) if (t?.uid) tasks.push({ w, t });
    const uids = [...new Set([...lines.map(l => l.job_uid).filter(Boolean), ...tasks.map(x => String(x.t.uid))])];
    const secs = new Map();
    if (uids.length) for (const r of (await db.query(`SELECT task_uid,mechanic_username,sum(extract(epoch from (coalesce(ended_at,now())-started_at))) s,max(coalesce(ended_at,started_at)) last
        FROM task_time_sessions WHERE task_uid = ANY($1::text[]) GROUP BY 1,2`, [uids])).rows) {
      if (!secs.has(r.task_uid)) secs.set(r.task_uid, { by: {}, last: null });
      const x = secs.get(r.task_uid); x.by[r.mechanic_username] = Number(r.s) || 0; if (!x.last || r.last > x.last) x.last = r.last;
    }
    const timer = uid => { const x = uid && secs.get(uid); if (!x) return { actual: null, mechanic: null, mechHours: null, by: {} };
      const total = Object.values(x.by).reduce((a, b) => a + b, 0), lead = leadMechanic(x.by);
      return { actual: total / 3600, mechanic: lead, mechHours: lead && lead !== 'team' ? total / 3600 : null, by: Object.fromEntries(Object.entries(x.by).map(([k, v]) => [k, Math.round(v / 36) / 100])), last: x.last }; };
    const invoiced = new Set();
    for (const l of lines) {
      if (l.job_uid) invoiced.add(l.job_uid);
      const tm = timer(l.job_uid), billed = Number(l.hours) || null;
      jobs.push({ source: 'invoice', id: `inv-${l.invoice_id}-${l.job}`, date: String(l.invoice_date instanceof Date ? l.invoice_date.toISOString() : l.invoice_date).slice(0, 10), ref: `Invoice ${l.invoice_number}`, workOrderId: l.work_order_id || '',
        unit: l.unit_number || '', customer: l.customer_name || '', text: joinText(l.job_name, l.description), billed, actual: tm.actual, mechanic: tm.mechanic, mechHours: tm.mechHours, byMechanic: tm.by });
    }
    // Finished work-order tasks that are not invoiced yet still show how long the job really took.
    for (const { w, t } of tasks) {
      const uid = String(t.uid); if (invoiced.has(uid) || !(t.done || t.taskOutcome === 'completed')) continue;
      const tm = timer(uid); if (!tm.actual) continue;
      const date = String(t.completedAt || tm.last?.toISOString?.() || '').slice(0, 10); if (!date || date < from || date > to) continue;
      jobs.push({ source: 'work_order', id: `wo-${w.id}-${uid}`, date, ref: `WO #${w.id}`, workOrderId: String(w.id), unit: w.unit || '', customer: w.customer || '', text: String(t.t || ''), billed: null, actual: tm.actual, mechanic: tm.mechanic, mechHours: tm.mechHours, byMechanic: tm.by });
    }
  }
  if (source !== 'shopflow') {
    const fb = (await db.query(`SELECT id,service_order,invoice_number,action_completed_at,unit_number,customer_name,coalesce(nullif(tech,''),lead_tech) tech,complaint,actual_correction,hours
      FROM fullbay_service_history WHERE hours > 0 AND action_completed_at >= $1::date AND action_completed_at < ($2::date + 1)`, [from, to])).rows;
    for (const r of fb) {
      const mech = techKey(r.tech), h = Number(r.hours);
      jobs.push({ source: 'fullbay', id: `fb-${r.id}`, date: new Date(r.action_completed_at).toISOString().slice(0, 10), ref: `Fullbay SO ${r.service_order || r.invoice_number || ''}`.trim(), workOrderId: '',
        unit: r.unit_number || '', customer: r.customer_name || '', text: joinText(r.complaint, r.actual_correction), billed: h, actual: null, mechanic: mech, mechHours: h, byMechanic: {}, tech: r.tech || '' });
    }
  }
  const name = k => !k ? '' : k === 'team' ? 'Team job' : k.startsWith('fb:') ? `${k.slice(3)} (Fullbay)` : display.get(k) || k;
  for (const j of jobs) j.mechanicName = name(j.mechanic);
  return { jobs, name };
}

export async function buildLaborTimeReport(db, { from, to, source = 'all' }) {
  const types = await loadJobTypes(db), compiled = compileJobTypes(types);
  const { jobs, name } = await loadLaborJobs(db, { from, to, source });
  const valid = jobs.filter(j => (j.billed > 0 && j.billed <= 60) || (j.actual > 0.05 && j.actual <= 60));
  for (const j of valid) j.type = classifyJob(j.text, compiled);
  const typed = valid.filter(j => j.type);
  const out = [];
  for (const t of types.filter(t => !t.disabled)) {
    const mine = typed.filter(j => j.type === t.key); if (!mine.length) { out.push({ key: t.key, label: t.label, keywords: t.keywords, bookHours: t.bookHours ?? null, n: 0 }); continue; }
    const billed = describe(mine.map(j => j.billed)), actual = describe(mine.filter(j => j.source !== 'fullbay').map(j => j.actual));
    const standard = t.bookHours || billed.median || actual.median;
    out.push({ key: t.key, label: t.label, keywords: t.keywords, bookHours: t.bookHours ?? null, n: mine.length, billed, actual, standard, standardSource: t.bookHours ? 'book' : billed.median ? 'billed' : 'timer',
      sources: { invoice: mine.filter(j => j.source === 'invoice').length, work_order: mine.filter(j => j.source === 'work_order').length, fullbay: mine.filter(j => j.source === 'fullbay').length } });
  }
  const typicalTimes_ = typicalTimes(typed), cmp = compareMechanics(typed, typicalTimes_);
  for (const t of out) { t.peerTimer = typicalTimes_[`timer|${t.key}`] ?? null; t.peerFullbay = typicalTimes_[`fullbay|${t.key}`] ?? null; }
  for (const c of cmp.cells) c.name = name(c.mechanic);
  for (const m of cmp.mechanics) m.name = name(m.mechanic);
  const unc = new Map();
  for (const j of valid.filter(j => !j.type)) { const k = String(j.text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80) || '(no description)'; const x = unc.get(k) || { text: k, n: 0, hours: 0 }; x.n++; x.hours += j.billed || j.actual || 0; unc.set(k, x); }
  return { range: { from, to }, source, types: out.sort((a, b) => b.n - a.n), cells: cmp.cells, mechanics: cmp.mechanics,
    uncategorized: [...unc.values()].sort((a, b) => b.n - a.n).slice(0, 40).map(x => ({ ...x, hours: r2(x.hours) })),
    totals: { jobs: valid.length, categorized: typed.length, withTimer: valid.filter(j => j.actual > 0).length, fullbay: valid.filter(j => j.source === 'fullbay').length },
    generatedAt: new Date().toISOString() };
}

export function registerLaborTimeRoutes(app, { auth, ownerOnly, managerPermission, requireDb, audit }) {
  const reportsPerm = managerPermission('reports');
  const iso = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
  const range = q => { const today = new Date().toISOString().slice(0, 10); let from = iso(q.from) || `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`, to = iso(q.to) || today; if (from > to) [from, to] = [to, from]; return { from, to, source: ['shopflow', 'fullbay'].includes(q.source) ? q.source : 'all' }; };
  const wrap = fn => async (req, res, next) => { try { res.json(await fn(req)); } catch (e) { if (e?.status) return res.status(e.status).json({ error: e.message }); next(e); } };
  app.get('/api/reports/labor-times', auth, reportsPerm, wrap(req => buildLaborTimeReport(requireDb(), range(req.query))));
  app.get('/api/reports/labor-times/jobs', auth, reportsPerm, wrap(async req => {
    const db = requireDb(), r = range(req.query), compiled = compileJobTypes(await loadJobTypes(db)), type = String(req.query.type || ''), mech = String(req.query.mechanic || '');
    const { jobs } = await loadLaborJobs(db, r);
    const rows = jobs.map(j => ({ ...j, type: classifyJob(j.text, compiled) })).filter(j => (type === '_none' ? !j.type : !type || j.type === type) && (!mech || j.mechanic === mech));
    return { items: rows.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 400).map(j => ({ ...j, billed: r2(j.billed), actual: r2(j.actual), mechHours: r2(j.mechHours) })) };
  }));
  app.get('/api/reports/labor-times/job-types', auth, reportsPerm, wrap(async req => ({ types: await loadJobTypes(requireDb()), defaults: DEFAULT_JOB_TYPES })));
  app.put('/api/reports/labor-times/job-types', auth, ownerOnly, wrap(async req => {
    const db = requireDb(), types = req.body?.reset ? null : cleanJobTypes(req.body?.types);
    await db.query(`INSERT INTO shop_settings(setting_key,value,updated_by,updated_at) VALUES('labor_job_types',$1::jsonb,$2,now()) ON CONFLICT(setting_key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`, [JSON.stringify({ types }), req.user.username]);
    await audit(req.user.username, 'labor_job_types_changed', { count: types ? types.length : 'reset' });
    return { ok: true, types: types || DEFAULT_JOB_TYPES };
  }));
}
