// ITTR ShopFlow v24.41.0 mechanic productivity report.
// Every shop day is split into: repair (task timers) > other activities > break > unaccounted.
// The day is measured against the mechanic's clocked shifts (time clock). Days with no clock punches fall back
// to shop hours. Unaccounted time inside that window, beyond the break allowance, is reported as idle.
import { getSetting } from './finance_center.mjs';

export const DEFAULT_SHOP_HOURS = Object.freeze({
  timezone: 'America/Chicago', start: '07:00', end: '17:00', workdays: [1, 2, 3, 4, 5],
  idleGapMinutes: 15, breakAllowanceMinutes: 30
});
export const ACTIVITY_LABELS = Object.freeze({
  cleaning: 'Cleaning work area', yard: 'In the yard', moving_unit: 'Moving truck / trailer', parts: 'Getting parts',
  waiting_parts: 'Waiting for parts', helping: 'Helping another mechanic', inspection: 'General inspection', break: 'Break', custom: 'Custom activity'
});
const RANK = { repair: 3, activity: 2, break: 1 };
const MIN = 60000, DAY = 86400000;

// ---------------------------------------------------------------- time zone helpers (no dependencies)
function tzOffsetMs(date, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
  const g = t => Number(p.find(x => x.type === t)?.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second')) - Math.floor(date.getTime() / 1000) * 1000;
}
export function zonedToUtc(ymd, hhmm, tz) {
  const [y, m, d] = ymd.split('-').map(Number), [H, M] = String(hhmm || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, H || 0, M || 0);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  const again = guess - tzOffsetMs(new Date(t), tz);
  if (again !== t) t = again;
  return t;
}
export const localYmd = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const weekday = ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

export function cleanShopHours(b = {}, cur = DEFAULT_SHOP_HOURS) {
  const hm = (v, fb) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : fb;
  let tz = String(b.timezone ?? cur.timezone);
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = cur.timezone; }
  const days = Array.isArray(b.workdays) ? [...new Set(b.workdays.map(Number).filter(d => d >= 0 && d <= 6))].sort() : cur.workdays;
  const num = (v, fb, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : fb; };
  const out = { timezone: tz, start: hm(b.start, cur.start), end: hm(b.end, cur.end), workdays: days.length ? days : cur.workdays,
    idleGapMinutes: num(b.idleGapMinutes, cur.idleGapMinutes, 5, 240), breakAllowanceMinutes: num(b.breakAllowanceMinutes, cur.breakAllowanceMinutes, 0, 180) };
  if (out.end <= out.start) out.end = cur.end > out.start ? cur.end : '23:59';
  return out;
}

// ---------------------------------------------------------------- pure day accounting (unit tested)
// intervals: [{start,end,kind:'repair'|'activity'|'break',label,code?}] in ms. window: {start,end}|null.
// windows: the paid/expected time (clocked shifts or shop hours). `window` (one span) is still accepted.
export function accountDay({ intervals, window, windows, dayStart, dayEnd, gapMinutes = 15 }) {
  const wins = (windows || (window ? [window] : [])).filter(w => w && w.end > w.start);
  const clip = intervals.map(i => ({ ...i, start: Math.max(i.start, dayStart), end: Math.min(i.end, dayEnd) })).filter(i => i.end > i.start);
  const lo = Math.min(dayStart, ...wins.map(w => w.start)), hi = Math.max(dayEnd, ...wins.map(w => w.end));
  const cuts = new Set([lo, hi]);
  for (const i of clip) { cuts.add(i.start); cuts.add(i.end); }
  for (const w of wins) { cuts.add(w.start); cuts.add(w.end); }
  const pts = [...cuts].filter(t => t >= lo && t <= hi).sort((a, b) => a - b);
  const segs = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1]; if (b <= a) continue;
    let top = null; for (const i of clip) if (i.start <= a && i.end >= b && (!top || RANK[i.kind] > RANK[top.kind])) top = i;
    const inWin = wins.some(w => a >= w.start && b <= w.end);
    if (!top && !inWin) continue;
    const kind = top ? top.kind : 'idle', label = top ? top.label : 'No activity recorded', code = top?.code || '';
    const last = segs[segs.length - 1];
    if (last && last.end === a && last.kind === kind && last.label === label && last.inWindow === inWin) last.end = b;
    else segs.push({ start: a, end: b, kind, label, code, inWindow: inWin });
  }
  const t = { repairMs: 0, activityMs: 0, breakMs: 0, unaccountedMs: 0, overtimeMs: 0, byActivity: {} };
  for (const s of segs) {
    const ms = s.end - s.start;
    if (s.kind === 'idle') { t.unaccountedMs += ms; continue; }
    if (!s.inWindow) { if (s.kind === 'repair') t.overtimeMs += ms; }
    if (s.kind === 'repair') t.repairMs += ms;
    else if (s.kind === 'break') t.breakMs += ms;
    else { t.activityMs += ms; t.byActivity[s.code || 'custom'] = (t.byActivity[s.code || 'custom'] || 0) + ms; }
  }
  const gaps = [];
  segs.forEach((s, i) => {
    if (s.kind !== 'idle' || s.end - s.start < gapMinutes * MIN) return;
    const prev = segs.slice(0, i).reverse().find(x => x.kind !== 'idle'), next = segs.slice(i + 1).find(x => x.kind !== 'idle');
    gaps.push({ start: s.start, end: s.end, minutes: Math.round((s.end - s.start) / MIN), before: prev ? prev.label : 'Start of shift', after: next ? next.label : 'End of shift' });
  });
  return { ...t, scheduledMs: wins.reduce((n, w) => n + w.end - w.start, 0), segments: segs.map(({ inWindow, ...s }) => s), gaps };
}

// ---------------------------------------------------------------- report builder
export async function buildProductivityReport(db, { from, to, mechanic = '', now = Date.now() }) {
  const hours = await getSetting(db, 'shop_hours', DEFAULT_SHOP_HOURS), tz = hours.timezone;
  const rangeStart = zonedToUtc(from, '00:00', tz), rangeEnd = zonedToUtc(addDays(to, 1), '00:00', tz);
  const mechRows = (await db.query(`SELECT username,display_name FROM auth_users WHERE role='mechanic' AND ($1='' OR username=$1) ORDER BY display_name`, [mechanic])).rows;
  const sessions = (await db.query(`SELECT work_order_id,task_uid,task_name,mechanic_username,started_at,ended_at,end_reason,pause_reason,pause_note
    FROM task_time_sessions WHERE started_at < $2::timestamptz AND coalesce(ended_at,now()) > $1::timestamptz AND ($3='' OR mechanic_username=$3) ORDER BY started_at`,
  [new Date(rangeStart).toISOString(), new Date(rangeEnd).toISOString(), mechanic])).rows;
  const shiftRows = await db.query(`SELECT username,clock_in,clock_out FROM mechanic_shifts WHERE deleted_at IS NULL AND clock_in < $2::timestamptz AND coalesce(clock_out,now()) > $1::timestamptz AND ($3='' OR username=$3) ORDER BY clock_in`,
    [new Date(rangeStart).toISOString(), new Date(rangeEnd).toISOString(), mechanic]).then(r => r.rows).catch(() => []);
  const users = (await db.query(`SELECT payload FROM app_state WHERE state_key='users'`)).rows[0]?.payload || {};
  const sf = (await db.query(`SELECT payload FROM app_state WHERE state_key='shopflow'`)).rows[0]?.payload || {};
  const woById = new Map((Array.isArray(sf.workorders) ? sf.workorders : []).map(w => [String(w?.id), w]));
  const names = new Map(mechRows.map(r => [r.username, r.display_name || r.username]));
  for (const s of sessions) if (!names.has(s.mechanic_username) && (!mechanic || s.mechanic_username === mechanic)) names.set(s.mechanic_username, users[s.mechanic_username]?.display || s.mechanic_username);

  // Billed hours: invoice labor lines are keyed to the WO task uid; split by each mechanic's share of that task's clocked time.
  const billedLines = (await db.query(`SELECT l.job_uid,l.quantity FROM customer_invoice_lines l JOIN customer_invoices i ON i.id=l.invoice_id
    WHERE l.line_type='labor' AND coalesce(l.job_uid,'')<>'' AND i.status IN ('sent','partial','paid') AND i.invoice_date BETWEEN $1::date AND $2::date`, [from, to])).rows;
  const uids = [...new Set(billedLines.map(l => l.job_uid))];
  const shares = new Map();
  if (uids.length) {
    const r = (await db.query(`SELECT task_uid,mechanic_username,sum(extract(epoch from (coalesce(ended_at,now())-started_at))) secs FROM task_time_sessions WHERE task_uid = ANY($1::text[]) GROUP BY 1,2`, [uids])).rows;
    const tot = new Map(); for (const x of r) tot.set(x.task_uid, (tot.get(x.task_uid) || 0) + Number(x.secs));
    for (const x of r) shares.set(`${x.task_uid}|${x.mechanic_username}`, tot.get(x.task_uid) ? Number(x.secs) / tot.get(x.task_uid) : 0);
  }

  const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const firstEver = new Map();
  for (const r of (await db.query(`SELECT mechanic_username u,min(started_at) t FROM task_time_sessions GROUP BY 1 UNION ALL SELECT username,min(clock_in) FROM mechanic_shifts WHERE deleted_at IS NULL GROUP BY 1`).catch(() => ({ rows: [] }))).rows) {
    const t = new Date(r.t).getTime(); if (!firstEver.has(r.u) || t < firstEver.get(r.u)) firstEver.set(r.u, t);
  }
  const mechanics = [];
  for (const [username, display] of names) {
    const mine = sessions.filter(s => s.mechanic_username === username);
    const intervals = mine.map(s => {
      const w = woById.get(String(s.work_order_id)) || {};
      return { start: new Date(s.started_at).getTime(), end: s.ended_at ? new Date(s.ended_at).getTime() : Math.min(now, rangeEnd), kind: 'repair',
        label: `WO #${s.work_order_id}${w.unit ? ` · Unit ${w.unit}` : ''} · ${s.task_name || 'Repair'}`, workOrderId: String(s.work_order_id), endReason: s.end_reason || (s.ended_at ? '' : 'running'), pauseReason: s.pause_reason || '' };
    });
    const hist = Array.isArray(users[username]?.activityHistory) ? [...users[username].activityHistory].filter(a => a?.startedAt && a?.code).sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt)) : [];
    const current = users[username]?.currentActivity;
    hist.forEach((a, i) => {
      const start = new Date(a.startedAt).getTime(); let end = a.endedAt ? new Date(a.endedAt).getTime() : NaN;
      if (!Number.isFinite(end)) end = current?.code && current.startedAt === a.startedAt ? now : (hist[i + 1] ? new Date(hist[i + 1].startedAt).getTime() : start);
      // An activity never closed is capped at the end of its own shop day so one forgotten button can't fill a week.
      const cap = zonedToUtc(addDays(localYmd(start, tz), 1), '00:00', tz);
      end = Math.min(end, cap, now);
      if (end > start && end > rangeStart && start < rangeEnd) intervals.push({ start, end, kind: a.code === 'break' ? 'break' : 'activity', code: a.code, label: a.code === 'custom' ? (a.customText || 'Custom activity') : ACTIVITY_LABELS[a.code] || a.code, note: a.note || '' });
    });
    const shifts = shiftRows.filter(r => r.username === username).map(r => ({ start: new Date(r.clock_in).getTime(), end: r.clock_out ? new Date(r.clock_out).getTime() : Math.min(now, rangeEnd) }));
    const tot = { clockedDays: 0, scheduledMs: 0, repairMs: 0, activityMs: 0, breakMs: 0, unaccountedMs: 0, idleMs: 0, overtimeMs: 0, byActivity: {}, daysWorked: 0, noActivityDays: 0, longestIdleMs: 0, gaps: 0 };
    const dayRows = [];
    // Days before a mechanic's first record (new hire, or before ShopFlow was used) are not counted as "no activity".
    const seen = [...intervals.map(i => i.start), ...shifts.map(w => w.start), ...(firstEver.has(username) ? [firstEver.get(username)] : [])], firstSeen = seen.length ? localYmd(Math.min(...seen), tz) : '9999-12-31';
    for (const ymd of days) {
      const dayStart = zonedToUtc(ymd, '00:00', tz), dayEnd = Math.min(zonedToUtc(addDays(ymd, 1), '00:00', tz), now);
      if (dayEnd <= dayStart) continue;
      const scheduled = hours.workdays.includes(weekday(ymd));
      const clockedWins = shifts.map(w => ({ start: Math.max(w.start, dayStart), end: Math.min(w.end, dayEnd) })).filter(w => w.end > w.start);
      const clocked = clockedWins.length > 0;
      let window = scheduled ? { start: zonedToUtc(ymd, hours.start, tz), end: Math.min(zonedToUtc(ymd, hours.end, tz), now) } : null;
      if (window && window.end <= window.start) window = null;
      const windows = clocked ? clockedWins : window ? [window] : [];
      const todays = intervals.filter(i => i.end > dayStart && i.start < dayEnd);
      if (!todays.length && !clocked) { if (ymd >= firstSeen && window && window.end - window.start >= 60 * MIN) { tot.noActivityDays++; dayRows.push({ date: ymd, workday: true, noActivity: true, scheduledMs: window.end - window.start }); } continue; }
      if (clocked) tot.clockedDays++;
      const r = accountDay({ intervals: todays, windows, dayStart, dayEnd, gapMinutes: hours.idleGapMinutes });
      const allowance = Math.max(0, hours.breakAllowanceMinutes * MIN - r.breakMs);
      const idleMs = Math.max(0, r.unaccountedMs - allowance);
      tot.daysWorked++; for (const k of ['scheduledMs', 'repairMs', 'activityMs', 'breakMs', 'unaccountedMs', 'overtimeMs']) tot[k] += r[k];
      tot.idleMs += idleMs; tot.gaps += r.gaps.length;
      for (const [c, ms] of Object.entries(r.byActivity)) tot.byActivity[c] = (tot.byActivity[c] || 0) + ms;
      for (const g of r.gaps) tot.longestIdleMs = Math.max(tot.longestIdleMs, g.end - g.start);
      const pauses = todays.filter(i => i.kind === 'repair' && i.pauseReason && i.end <= dayEnd).map(i => i.pauseReason);
      // Minute-by-minute timelines are only kept for the last 31 days of the range (the chart shows 14).
      if (days.length - days.indexOf(ymd) > 31) r.segments = [];
      const marks = [...todays.flatMap(i => [i.start, i.end]), ...(clocked ? clockedWins.flatMap(w => [w.start, w.end]) : [])];
      dayRows.push({ date: ymd, workday: scheduled, clocked, window: windows[0] || null, windows, clockIn: clocked ? clockedWins[0].start : null, clockOut: clocked ? clockedWins[clockedWins.length - 1].end : null, ...r, idleMs, pauses,
        firstEvent: Math.max(dayStart, Math.min(...marks)), lastEvent: Math.min(dayEnd, Math.max(...marks)),
        workOrders: [...new Set(todays.filter(i => i.kind === 'repair').map(i => i.workOrderId))] });
    }
    const inRange = mine.filter(s => { const t = new Date(s.started_at).getTime(); return t >= rangeStart && t < rangeEnd; });
    const pauseReasons = {}; for (const s of inRange) if (s.end_reason === 'paused') { const k = s.pause_reason || 'No reason given'; pauseReasons[k] = (pauseReasons[k] || 0) + 1; }
    let billedHours = 0; for (const l of billedLines) billedHours += Number(l.quantity || 0) * (shares.get(`${l.job_uid}|${username}`) || 0);
    const clockedH = tot.repairMs / 3600000;
    mechanics.push({ username, display,
      totals: { ...tot, utilizationPct: tot.scheduledMs ? Math.round((tot.repairMs - tot.overtimeMs) / tot.scheduledMs * 1000) / 10 : 0,
        billedHours: Math.round(billedHours * 100) / 100, efficiencyPct: clockedH > 0.05 && billedHours > 0.01 ? Math.round(billedHours / clockedH * 1000) / 10 : null,
        workOrders: new Set(inRange.map(s => String(s.work_order_id))).size, tasksCompleted: inRange.filter(s => s.end_reason === 'completed').length, pauseReasons },
      days: dayRows });
  }
  mechanics.sort((a, b) => b.totals.repairMs - a.totals.repairMs);
  return { range: { from, to }, settings: hours, activityLabels: ACTIVITY_LABELS, generatedAt: new Date(now).toISOString(), mechanics };
}

export function registerProductivityRoutes(app, { auth, ownerOnly, managerPermission, requireDb, audit }) {
  const reportsPerm = managerPermission('reports');
  const iso = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
  app.get('/api/reports/mechanics', auth, reportsPerm, async (req, res, next) => {
    try {
      const db = requireDb(), hours = await getSetting(db, 'shop_hours', DEFAULT_SHOP_HOURS), today = localYmd(Date.now(), hours.timezone);
      let from = iso(req.query.from) || addDays(today, -6), to = iso(req.query.to) || today;
      if (from > to) [from, to] = [to, from];
      if ((Date.parse(to) - Date.parse(from)) / DAY > 366) return res.status(400).json({ error: 'Pick a range of one year or less.' });
      res.json(await buildProductivityReport(db, { from, to, mechanic: String(req.query.mechanic || '').trim().toLowerCase() }));
    } catch (e) { next(e); }
  });
  app.put('/api/reports/mechanics/settings', auth, ownerOnly, async (req, res, next) => {
    try {
      const db = requireDb(), cur = await getSetting(db, 'shop_hours', DEFAULT_SHOP_HOURS), val = cleanShopHours(req.body || {}, cur);
      await db.query(`INSERT INTO shop_settings(setting_key,value,updated_by,updated_at) VALUES('shop_hours',$1::jsonb,$2,now()) ON CONFLICT(setting_key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`, [JSON.stringify(val), req.user.username]);
      await audit(req.user.username, 'shop_hours_changed', val);
      res.json({ ok: true, settings: val });
    } catch (e) { next(e); }
  });
}
