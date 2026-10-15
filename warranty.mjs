// v24.55.0: warranty & comebacks.
//  - Comeback: the same kind of repair on the same unit (same customer) again within N days (default 90). Repairs
//    are grouped with the shop's own job types from Reports → Job times (brakes, wheel seals, air dryer…), across
//    ShopFlow invoices and imported Fullbay history. Routine work that repeats on purpose (PM, inspections,
//    diagnostics, tires, lights, body, welding) is not counted.
//  - Warranty: labor and parts warranty windows (default 90 / 365 days). When a unit comes in, the work order shows
//    the repairs still under warranty, so a returning failure is caught before it is billed again.
import { getSetting } from './finance_center.mjs';
import { compileJobTypes, classifyJob, DEFAULT_JOB_TYPES, loadLaborJobs } from './labor_times.mjs';

export const WARRANTY_DEFAULTS = { laborDays: 90, partsDays: 365, comebackDays: 90, ignoreTypes: ['pm_service', 'annual_inspection', 'vehicle_inspection', 'diagnostics', 'tires', 'lights_electrical', 'doors_body', 'welding'] };
const DAY = 86400000;
export const unitKey = (customer, unit) => {
  const c = String(customer || '').toLowerCase().replace(/\b(llc|inc|corp|co|ltd|company|trucking|transport(ation)?|logistics)\b/g, '').replace(/[^a-z0-9]/g, '');
  const u = String(unit || '').toLowerCase().replace(/^(unit|truck|trk|tr)\s*#?\s*/, '').replace(/[^a-z0-9]/g, '');
  return u ? `${c}|${u}` : '';
};
const days = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / DAY);

// Pure: given labor jobs (with type), find each repair that came back within `within` days.
export function findComebacks(jobs, { within = 90, ignore = [] } = {}) {
  const groups = new Map();
  for (const j of jobs) { if (!j.type || ignore.includes(j.type) || !['invoice', 'fullbay'].includes(j.source)) continue;
    const k = unitKey(j.customer, j.unit); if (!k) continue; const g = `${k}#${j.type}`; (groups.get(g) || groups.set(g, []).get(g)).push(j); }
  const out = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < list.length; i++) { const a = list[i - 1], b = list[i], d = days(a.date, b.date);
      if (a.ref === b.ref || d <= 0 || d > within) continue;
      out.push({ unit: b.unit || a.unit, customer: b.customer || a.customer, type: b.type, days: d,
        first: { date: a.date, ref: a.ref, mechanic: a.mechanicName || '', text: a.text || '' }, again: { date: b.date, ref: b.ref, mechanic: b.mechanicName || '', text: b.text || '' } }); }
  }
  return out.sort((x, y) => y.again.date.localeCompare(x.again.date));
}

export async function warrantySettings(db) { const s = await getSetting(db, 'warranty_terms', WARRANTY_DEFAULTS); return { ...WARRANTY_DEFAULTS, ...s }; }
async function typedJobs(db, from, to) {
  const st = await getSetting(db, 'labor_job_types', { types: null }), types = Array.isArray(st.types) && st.types.length ? st.types : DEFAULT_JOB_TYPES;
  const compiled = compileJobTypes(types), labels = Object.fromEntries(types.map(t => [t.key, t.label]));
  const { jobs } = await loadLaborJobs(db, { from, to, source: 'all' });
  for (const j of jobs) j.type = classifyJob(j.text, compiled);
  return { jobs, labels };
}
const isoDay = d => d.toISOString().slice(0, 10);

export function registerWarrantyRoutes(app, { auth, adminOnly, ownerOnly, managerPermission, requireDb, audit, reportRange }) {
  const reportsPerm = managerPermission('reports');
  app.get('/api/warranty/settings', auth, adminOnly, async (req, res, next) => { try { res.json(await warrantySettings(requireDb())); } catch (e) { next(e); } });
  app.put('/api/warranty/settings', auth, ownerOnly, async (req, res, next) => { try {
    const n = (v, d, max) => Math.max(0, Math.min(max, Math.round(Number(v ?? d)))) || d, cur = await warrantySettings(requireDb());
    const v = { laborDays: n(req.body?.laborDays, cur.laborDays, 3650), partsDays: n(req.body?.partsDays, cur.partsDays, 3650), comebackDays: n(req.body?.comebackDays, cur.comebackDays, 730),
      ignoreTypes: Array.isArray(req.body?.ignoreTypes) ? req.body.ignoreTypes.map(x => String(x).slice(0, 40)).slice(0, 60) : cur.ignoreTypes };
    await requireDb().query(`INSERT INTO shop_settings(setting_key,value,updated_by,updated_at) VALUES('warranty_terms',$1::jsonb,$2,now()) ON CONFLICT(setting_key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`, [JSON.stringify(v), req.user.username]);
    await audit(req.user.username, 'warranty_settings_changed', v); res.json(v);
  } catch (e) { next(e); } });
  // Comebacks in a period: repairs done again within the comeback window, with who did the first one.
  app.get('/api/reports/comebacks', auth, reportsPerm, async (req, res, next) => { try {
    const db = requireDb(), set = await warrantySettings(db), { from, to } = reportRange(req.query);
    const start = isoDay(new Date(new Date(`${from}T12:00:00`).getTime() - set.comebackDays * DAY));
    const { jobs, labels } = await typedJobs(db, start, to);
    const list = findComebacks(jobs, { within: set.comebackDays, ignore: set.ignoreTypes }).filter(c => c.again.date >= from && c.again.date <= to).map(c => ({ ...c, label: labels[c.type] || c.type }));
    const done = jobs.filter(j => ['invoice', 'fullbay'].includes(j.source) && j.type && !set.ignoreTypes.includes(j.type) && j.date >= from && j.date <= to).length;
    const tally = key => Object.entries(list.reduce((a, c) => { const k = key(c) || '—'; a[k] = (a[k] || 0) + 1; return a; }, {})).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
    res.json({ from, to, settings: set, repairs: done, comebacks: list.length, rate: done ? Math.round(list.length / done * 1000) / 10 : 0, byType: tally(c => c.label), byMechanic: tally(c => c.first.mechanic), items: list });
  } catch (e) { next(e); } });
  // Repairs on one unit still under warranty (for the work order screen).
  app.get('/api/warranty/unit', auth, adminOnly, async (req, res, next) => { try {
    const db = requireDb(), set = await warrantySettings(db), key = unitKey(req.query.customer, req.query.unit); if (!key) return res.json({ items: [], settings: set });
    const span = Math.max(set.laborDays, set.partsDays), now = new Date(), from = isoDay(new Date(now.getTime() - span * DAY)), to = isoDay(now);
    const { jobs, labels } = await typedJobs(db, from, to), today = isoDay(now);
    const add = (d, n) => isoDay(new Date(new Date(`${d}T12:00:00`).getTime() + n * DAY));
    const items = jobs.filter(j => ['invoice', 'fullbay'].includes(j.source) && unitKey(j.customer, j.unit) === key && !set.ignoreTypes.includes(j.type))
      .map(j => ({ date: j.date, ref: j.ref, text: j.text, type: j.type, label: labels[j.type] || '', mechanic: j.mechanicName || '', laborUntil: add(j.date, set.laborDays), partsUntil: add(j.date, set.partsDays) }))
      .map(x => ({ ...x, laborWarranty: x.laborUntil >= today, partsWarranty: x.partsUntil >= today })).filter(x => x.laborWarranty || x.partsWarranty)
      .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
    res.json({ items, settings: set });
  } catch (e) { next(e); } });
}
