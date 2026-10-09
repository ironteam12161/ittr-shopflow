// ITTR ShopFlow v24.41.0 mechanic time clock.
// Mechanics clock in and out of their work day. Shifts are the paid time that the productivity report
// splits into repair / other work / break / idle. Every change an admin makes is kept with a reason.
import { getSetting } from './finance_center.mjs';
import { DEFAULT_SHOP_HOURS, zonedToUtc, localYmd } from './mechanic_productivity.mjs';

export const DEFAULT_TIME_CLOCK = Object.freeze({ autoClockIn: true, maxShiftHours: 14, weeklyOvertimeHours: 40, weekStartsOn: 1 });
const MIN = 60000, HOUR = 3600000;
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const weekday = ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const str = (v, n = 500) => String(v ?? '').replace(/[<>]/g, '').trim().slice(0, n);

export async function ensureTimeClockSchema(pool) {
  if (!pool) return;
  await pool.query(`
  CREATE TABLE IF NOT EXISTS mechanic_shifts(
    id BIGSERIAL PRIMARY KEY, username TEXT NOT NULL, clock_in TIMESTAMPTZ NOT NULL, clock_out TIMESTAMPTZ,
    in_source TEXT NOT NULL DEFAULT 'self', out_source TEXT, in_note TEXT, out_note TEXT,
    edited_by TEXT, edited_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, deleted_by TEXT, created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT mechanic_shift_order CHECK (clock_out IS NULL OR clock_out > clock_in));
  CREATE UNIQUE INDEX IF NOT EXISTS uq_mechanic_shift_open ON mechanic_shifts(username) WHERE clock_out IS NULL AND deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_mechanic_shifts_user ON mechanic_shifts(username, clock_in DESC);
  CREATE TABLE IF NOT EXISTS mechanic_shift_edits(
    id BIGSERIAL PRIMARY KEY, shift_id BIGINT NOT NULL, username TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL,
    before JSONB, after JSONB, edited_by TEXT NOT NULL, edited_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS idx_mechanic_shift_edits_shift ON mechanic_shift_edits(shift_id, edited_at DESC);`);
}

export function cleanTimeClockSettings(b = {}, cur = DEFAULT_TIME_CLOCK) {
  const num = (v, fb, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : fb; };
  return { autoClockIn: b.autoClockIn === undefined ? cur.autoClockIn !== false : b.autoClockIn === true,
    maxShiftHours: num(b.maxShiftHours, cur.maxShiftHours, 6, 24), weeklyOvertimeHours: num(b.weeklyOvertimeHours, cur.weeklyOvertimeHours, 0, 80),
    weekStartsOn: [0, 1].includes(Number(b.weekStartsOn)) ? Number(b.weekStartsOn) : cur.weekStartsOn };
}

// ---------------------------------------------------------------- pure timesheet math (unit tested)
// shifts: [{start,end}] ms (end may be `now` for an open shift). Splits at local midnight; weeks start on weekStartsOn.
export function buildTimesheet(shifts, { from, to, tz, weekStartsOn = 1, weeklyOvertimeHours = 40 }) {
  const days = new Map();
  for (let d = from; d <= to; d = addDays(d, 1)) days.set(d, { date: d, paidMs: 0, shifts: 0 });
  for (const s of shifts) {
    let a = s.start;
    while (a < s.end) {
      const ymd = localYmd(a, tz), next = zonedToUtc(addDays(ymd, 1), '00:00', tz), b = Math.min(s.end, next);
      const row = days.get(ymd); if (row) { row.paidMs += b - a; row.shifts++; }
      a = b;
    }
  }
  const weeks = [], otLimit = weeklyOvertimeHours * HOUR;
  for (const row of days.values()) {
    const back = (weekday(row.date) - weekStartsOn + 7) % 7, start = addDays(row.date, -back);
    let w = weeks[weeks.length - 1]; if (!w || w.weekStart !== start) weeks.push(w = { weekStart: start, paidMs: 0, days: 0 });
    w.paidMs += row.paidMs; if (row.paidMs > 0) w.days++;
  }
  for (const w of weeks) { w.regularMs = otLimit ? Math.min(w.paidMs, otLimit) : w.paidMs; w.overtimeMs = otLimit ? Math.max(0, w.paidMs - otLimit) : 0; }
  const paidMs = weeks.reduce((n, w) => n + w.paidMs, 0), overtimeMs = weeks.reduce((n, w) => n + w.overtimeMs, 0);
  return { days: [...days.values()], weeks, totals: { paidMs, overtimeMs, regularMs: paidMs - overtimeMs, daysWorked: [...days.values()].filter(d => d.paidMs > 0).length } };
}

// When a shift was left open, close it at the later of the last recorded work and shop closing time,
// never later than the max shift length. The admin sees it flagged for review.
export function forgottenShiftCloseAt({ clockIn, lastEvent, shopClose, maxShiftHours }) {
  const cap = clockIn + maxShiftHours * HOUR;
  let at = Math.max(lastEvent || 0, shopClose > clockIn ? shopClose : 0);
  if (!at || at <= clockIn) at = clockIn + MIN;
  return Math.min(at, cap);
}

// ---------------------------------------------------------------- data access
const shiftRow = r => r && ({ id: Number(r.id), username: r.username, clockIn: r.clock_in, clockOut: r.clock_out, inSource: r.in_source, outSource: r.out_source || '', inNote: r.in_note || '', outNote: r.out_note || '', editedBy: r.edited_by || '', editedAt: r.edited_at });
export async function openShift(db, username) {
  return shiftRow((await db.query('SELECT * FROM mechanic_shifts WHERE username=$1 AND clock_out IS NULL AND deleted_at IS NULL', [username])).rows[0]);
}
// Starting a task timer or an activity while off the clock opens a shift, flagged as automatic.
export async function autoClockIn(db, username, source) {
  const cfg = await getSetting(db, 'time_clock', DEFAULT_TIME_CLOCK);
  if (cfg.autoClockIn === false) return null;
  const r = await db.query(`INSERT INTO mechanic_shifts(username,clock_in,in_source) VALUES($1,now(),$2)
    ON CONFLICT (username) WHERE clock_out IS NULL AND deleted_at IS NULL DO NOTHING RETURNING *`, [username, `auto:${source}`]);
  return shiftRow(r.rows[0]) || null;
}
async function assertNoOverlap(db, username, start, end, exceptId = null) {
  const r = await db.query(`SELECT id,clock_in,clock_out FROM mechanic_shifts WHERE username=$1 AND deleted_at IS NULL AND ($4::bigint IS NULL OR id<>$4::bigint)
    AND clock_in < coalesce($3::timestamptz,'infinity'::timestamptz) AND coalesce(clock_out,'infinity'::timestamptz) > $2::timestamptz LIMIT 1`, [username, start, end, exceptId]);
  if (r.rowCount) fail(409, 'That time overlaps another shift for this mechanic.');
}
async function logEdit(db, shiftId, username, action, reason, before, after, by) {
  await db.query('INSERT INTO mechanic_shift_edits(shift_id,username,action,reason,before,after,edited_by) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)',
    [shiftId, username, action, reason, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, by]);
}

export async function closeForgottenShifts(pool, { stopMechanicWork, now = Date.now() } = {}) {
  const cfg = await getSetting(pool, 'time_clock', DEFAULT_TIME_CLOCK), hours = await getSetting(pool, 'shop_hours', DEFAULT_SHOP_HOURS);
  const open = (await pool.query(`SELECT * FROM mechanic_shifts WHERE clock_out IS NULL AND deleted_at IS NULL AND clock_in < $1::timestamptz`, [new Date(now - cfg.maxShiftHours * HOUR).toISOString()])).rows;
  const closed = [];
  for (const s of open) {
    const clockIn = new Date(s.clock_in).getTime();
    const ev = (await pool.query(`SELECT max(greatest(started_at,coalesce(ended_at,started_at))) t FROM task_time_sessions WHERE mechanic_username=$1 AND started_at>=$2::timestamptz`, [s.username, s.clock_in])).rows[0]?.t;
    const at = forgottenShiftCloseAt({ clockIn, lastEvent: ev ? new Date(ev).getTime() : 0, shopClose: zonedToUtc(localYmd(clockIn, hours.timezone), hours.end, hours.timezone), maxShiftHours: cfg.maxShiftHours });
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const u = await db.query(`UPDATE mechanic_shifts SET clock_out=$2::timestamptz,out_source='auto:forgot',out_note='Forgot to clock out. Closed automatically, please check.' WHERE id=$1 AND clock_out IS NULL RETURNING *`, [s.id, new Date(at).toISOString()]);
      if (u.rowCount && stopMechanicWork) await stopMechanicWork(db, s.username, at, 'Shift closed (forgot to clock out)');
      await db.query('COMMIT');
      if (u.rowCount) closed.push({ id: Number(s.id), username: s.username, clockOut: new Date(at).toISOString() });
    } catch (e) { try { await db.query('ROLLBACK'); } catch (_) {} console.warn('[time clock] auto close failed', s.id, e?.message); } finally { db.release(); }
  }
  return closed;
}
export function startTimeClockScheduler({ pool, stopMechanicWork, onChange }) {
  if (!pool) return;
  const tick = async () => { try { const c = await closeForgottenShifts(pool, { stopMechanicWork }); if (c.length) { console.log(`[time clock] closed ${c.length} forgotten shift(s)`); onChange?.(); } } catch (e) { console.warn('[time clock]', e?.message || e); } };
  setTimeout(tick, 60 * 1000).unref?.();
  setInterval(tick, 10 * 60 * 1000).unref?.();
}

export async function timesheetReport(db, { from, to, mechanic = '', now = Date.now() }) {
  const cfg = await getSetting(db, 'time_clock', DEFAULT_TIME_CLOCK), hours = await getSetting(db, 'shop_hours', DEFAULT_SHOP_HOURS), tz = hours.timezone;
  const start = zonedToUtc(from, '00:00', tz), end = zonedToUtc(addDays(to, 1), '00:00', tz);
  const mechs = (await db.query(`SELECT username,display_name FROM auth_users WHERE role='mechanic' AND active=true AND ($1='' OR username=$1) ORDER BY display_name`, [mechanic])).rows;
  const rows = (await db.query(`SELECT s.*,(SELECT count(*)::int FROM mechanic_shift_edits e WHERE e.shift_id=s.id) edits FROM mechanic_shifts s
    WHERE deleted_at IS NULL AND clock_in < $2::timestamptz AND coalesce(clock_out,now()) > $1::timestamptz AND ($3='' OR username=$3) ORDER BY clock_in`,
  [new Date(start).toISOString(), new Date(end).toISOString(), mechanic])).rows;
  const names = new Map(mechs.map(m => [m.username, m.display_name || m.username]));
  for (const r of rows) if (!names.has(r.username)) names.set(r.username, r.username);
  const mechanics = [...names].map(([username, display]) => {
    const mine = rows.filter(r => r.username === username);
    const spans = mine.map(r => ({ start: Math.max(start, new Date(r.clock_in).getTime()), end: Math.min(end, r.clock_out ? new Date(r.clock_out).getTime() : now) })).filter(s => s.end > s.start);
    const sheet = buildTimesheet(spans, { from, to, tz, weekStartsOn: cfg.weekStartsOn, weeklyOvertimeHours: cfg.weeklyOvertimeHours });
    const shifts = mine.map(r => ({ ...shiftRow(r), edits: r.edits, open: !r.clock_out, durationMs: (r.clock_out ? new Date(r.clock_out).getTime() : now) - new Date(r.clock_in).getTime(),
      flags: [r.in_source?.startsWith('auto') ? 'auto_in' : '', r.out_source === 'auto:forgot' ? 'forgot_out' : '', r.edits ? 'edited' : '', !r.clock_out ? 'open' : ''].filter(Boolean) }));
    return { username, display, ...sheet, shifts, flagged: shifts.filter(s => s.flags.some(f => f === 'auto_in' || f === 'forgot_out')).length };
  });
  return { range: { from, to }, settings: { ...cfg, timezone: tz }, mechanics, generatedAt: new Date(now).toISOString() };
}

// ---------------------------------------------------------------- routes
export function registerTimeClockRoutes(app, { auth, ownerOnly, managerPermission, requireDb, audit, stopMechanicWork, onChange }) {
  const reportsPerm = managerPermission('reports');
  const iso = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
  const when = (v, label) => { const t = Date.parse(v); if (!Number.isFinite(t)) fail(400, `Enter a valid ${label}.`); if (t > Date.now() + 5 * MIN) fail(400, `The ${label} can't be in the future.`); return new Date(t).toISOString(); };
  const wrap = fn => async (req, res, next) => { try { res.json(await fn(req)); } catch (e) { if (e?.status) return res.status(e.status).json({ error: e.message }); if (e?.code === '23505') return res.status(409).json({ error: 'This mechanic is already clocked in.' }); next(e); } };
  const tx = async fn => { const db = await requireDb().connect(); try { await db.query('BEGIN'); const out = await fn(db); await db.query('COMMIT'); return out; } catch (e) { try { await db.query('ROLLBACK'); } catch (_) {} throw e; } finally { db.release(); } };

  // ---- the mechanic's own clock
  app.get('/api/timeclock/me', auth, wrap(async req => {
    const db = requireDb(), hours = await getSetting(db, 'shop_hours', DEFAULT_SHOP_HOURS), cfg = await getSetting(db, 'time_clock', DEFAULT_TIME_CLOCK), tz = hours.timezone, now = Date.now();
    const today = localYmd(now, tz), back = (weekday(today) - cfg.weekStartsOn + 7) % 7, weekFrom = addDays(today, -back);
    const t = await timesheetReport(db, { from: weekFrom, to: today, mechanic: req.user.username, now });
    const me = t.mechanics.find(m => m.username === req.user.username);
    return { open: await openShift(db, req.user.username), todayMs: me?.days.find(d => d.date === today)?.paidMs || 0, weekMs: me?.totals.paidMs || 0,
      weeklyOvertimeHours: cfg.weeklyOvertimeHours, shifts: (me?.shifts || []).slice(-10).reverse(), serverNow: new Date(now).toISOString() };
  }));
  app.post('/api/timeclock/punch', auth, wrap(async req => {
    const action = String(req.body?.action || ''), note = str(req.body?.note, 300), username = req.user.username;
    if (!['in', 'out'].includes(action)) fail(400, 'Unknown clock action.');
    const out = await tx(async db => {
      const open = (await db.query('SELECT * FROM mechanic_shifts WHERE username=$1 AND clock_out IS NULL AND deleted_at IS NULL FOR UPDATE', [username])).rows[0];
      if (action === 'in') {
        if (open) fail(409, 'You are already clocked in.');
        const r = await db.query(`INSERT INTO mechanic_shifts(username,clock_in,in_source,in_note) VALUES($1,now(),'self',$2) RETURNING *`, [username, note]);
        return { shift: shiftRow(r.rows[0]) };
      }
      if (!open) fail(409, 'You are not clocked in.');
      const r = await db.query(`UPDATE mechanic_shifts SET clock_out=greatest(now(),clock_in+interval '1 millisecond'),out_source='self',out_note=$2 WHERE id=$1 RETURNING *`, [open.id, note]);
      const stopped = stopMechanicWork ? await stopMechanicWork(db, username, new Date(r.rows[0].clock_out).getTime(), 'Clocked out') : { paused: 0, activity: false };
      return { shift: shiftRow(r.rows[0]), stopped };
    });
    await audit(username, action === 'in' ? 'clock_in' : 'clock_out', { shiftId: out.shift.id, paused: out.stopped?.paused || 0 });
    onChange?.(username);
    return { ok: true, ...out };
  }));

  // ---- owner / manager timesheets
  app.get('/api/timeclock/timesheet', auth, reportsPerm, wrap(async req => {
    const db = requireDb(), hours = await getSetting(db, 'shop_hours', DEFAULT_SHOP_HOURS), today = localYmd(Date.now(), hours.timezone);
    let from = iso(req.query.from) || addDays(today, -13), to = iso(req.query.to) || today;
    if (from > to) [from, to] = [to, from];
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 366) fail(400, 'Pick a range of one year or less.');
    return timesheetReport(db, { from, to, mechanic: String(req.query.mechanic || '').trim().toLowerCase() });
  }));
  app.get('/api/timeclock/shifts/:id/history', auth, reportsPerm, wrap(async req => ({ items: (await requireDb().query('SELECT * FROM mechanic_shift_edits WHERE shift_id=$1::bigint ORDER BY edited_at DESC', [req.params.id])).rows })));
  const needReason = b => { const r = str(b?.reason, 300); if (r.length < 3) fail(400, 'Write a short reason for this change (kept in the history).'); return r; };
  app.post('/api/timeclock/shifts', auth, ownerOnly, wrap(async req => {
    const b = req.body || {}, reason = needReason(b), username = String(b.username || '').trim().toLowerCase();
    const mech = (await requireDb().query(`SELECT 1 FROM auth_users WHERE username=$1 AND role='mechanic'`, [username])).rowCount; if (!mech) fail(400, 'Pick a mechanic.');
    const cin = when(b.clockIn, 'clock-in time'), cout = b.clockOut ? when(b.clockOut, 'clock-out time') : null;
    if (cout && cout <= cin) fail(400, 'Clock-out must be after clock-in.');
    const row = await tx(async db => {
      await assertNoOverlap(db, username, cin, cout);
      const r = (await db.query(`INSERT INTO mechanic_shifts(username,clock_in,clock_out,in_source,out_source,in_note,edited_by,edited_at) VALUES($1,$2,$3,'admin',$4,$5,$6,now()) RETURNING *`, [username, cin, cout, cout ? 'admin' : null, reason, req.user.username])).rows[0];
      await logEdit(db, r.id, username, 'added', reason, null, { clockIn: cin, clockOut: cout }, req.user.username);
      return r;
    });
    await audit(req.user.username, 'shift_added', { id: row.id, username, reason });
    onChange?.(username);
    return { ok: true, shift: shiftRow(row) };
  }));
  app.put('/api/timeclock/shifts/:id', auth, ownerOnly, wrap(async req => {
    const b = req.body || {}, reason = needReason(b);
    const row = await tx(async db => {
      const cur = (await db.query('SELECT * FROM mechanic_shifts WHERE id=$1::bigint AND deleted_at IS NULL FOR UPDATE', [req.params.id])).rows[0]; if (!cur) fail(404, 'Shift not found.');
      const cin = b.clockIn ? when(b.clockIn, 'clock-in time') : new Date(cur.clock_in).toISOString();
      const cout = b.clockOut === null || b.clockOut === '' ? null : b.clockOut ? when(b.clockOut, 'clock-out time') : cur.clock_out ? new Date(cur.clock_out).toISOString() : null;
      if (cout && cout <= cin) fail(400, 'Clock-out must be after clock-in.');
      await assertNoOverlap(db, cur.username, cin, cout, cur.id);
      const r = (await db.query(`UPDATE mechanic_shifts SET clock_in=$2,clock_out=$3,out_source=CASE WHEN $3::timestamptz IS NULL THEN NULL WHEN clock_out IS NULL OR clock_out<>$3::timestamptz THEN 'admin' ELSE out_source END,edited_by=$4,edited_at=now() WHERE id=$1 RETURNING *`, [cur.id, cin, cout, req.user.username])).rows[0];
      await logEdit(db, cur.id, cur.username, 'edited', reason, { clockIn: cur.clock_in, clockOut: cur.clock_out }, { clockIn: cin, clockOut: cout }, req.user.username);
      if (!cur.clock_out && cout && stopMechanicWork) await stopMechanicWork(db, cur.username, new Date(cout).getTime(), 'Clocked out by manager');
      return r;
    });
    await audit(req.user.username, 'shift_edited', { id: row.id, username: row.username, reason });
    onChange?.(row.username);
    return { ok: true, shift: shiftRow(row) };
  }));
  app.delete('/api/timeclock/shifts/:id', auth, ownerOnly, wrap(async req => {
    const reason = needReason(req.body || req.query);
    const row = await tx(async db => {
      const cur = (await db.query('SELECT * FROM mechanic_shifts WHERE id=$1::bigint AND deleted_at IS NULL FOR UPDATE', [req.params.id])).rows[0]; if (!cur) fail(404, 'Shift not found.');
      await db.query('UPDATE mechanic_shifts SET deleted_at=now(),deleted_by=$2 WHERE id=$1', [cur.id, req.user.username]);
      await logEdit(db, cur.id, cur.username, 'deleted', reason, { clockIn: cur.clock_in, clockOut: cur.clock_out }, null, req.user.username);
      return cur;
    });
    await audit(req.user.username, 'shift_deleted', { id: row.id, username: row.username, reason });
    onChange?.(row.username);
    return { ok: true };
  }));
  app.get('/api/timeclock/settings', auth, reportsPerm, wrap(async () => ({ settings: await getSetting(requireDb(), 'time_clock', DEFAULT_TIME_CLOCK) })));
  app.put('/api/timeclock/settings', auth, ownerOnly, wrap(async req => {
    const db = requireDb(), val = cleanTimeClockSettings(req.body || {}, await getSetting(db, 'time_clock', DEFAULT_TIME_CLOCK));
    await db.query(`INSERT INTO shop_settings(setting_key,value,updated_by,updated_at) VALUES('time_clock',$1::jsonb,$2,now()) ON CONFLICT(setting_key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`, [JSON.stringify(val), req.user.username]);
    await audit(req.user.username, 'time_clock_settings', val);
    return { ok: true, settings: val };
  }));
}
