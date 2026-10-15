// v24.54.0: canned jobs: saved job packages (labor + parts + fees) for the work done every week (PM service, brakes,
// tires…). Picking one adds its lines to an estimate or invoice through the same line APIs the screens use, so stock
// reservation and price checks stay in one place, or adds its labor lines as tasks on a work order.
const LINE_TYPES = ['labor', 'part', 'fee', 'sublet', 'other'];
const str = (v, n) => String(v ?? '').replace(/[<>]/g, '').trim().slice(0, n);
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export function cleanCannedLines(lines) {
  return (Array.isArray(lines) ? lines : []).slice(0, 60).map(l => {
    const lineType = LINE_TYPES.includes(l?.lineType) ? l.lineType : 'other';
    return {
      lineType, description: str(l?.description, 500) || (lineType === 'labor' ? 'Labor' : 'Item'),
      partNumber: lineType === 'part' ? str(l?.partNumber, 120) : '',
      quantity: Math.max(0, Math.min(1e5, num(l?.quantity || 1))), unitPrice: Math.max(0, Math.min(1e7, num(l?.unitPrice))),
      taxable: l?.taxable === true, inventoryPartId: lineType === 'part' && Number(l?.inventoryPartId) > 0 ? Number(l.inventoryPartId) : null
    };
  }).filter(l => l.description);
}
export const cannedTotal = lines => Math.round(lines.reduce((a, l) => a + l.quantity * l.unitPrice, 0) * 100) / 100;

export async function ensureCannedJobSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS canned_jobs(
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT, notes TEXT, lines JSONB NOT NULL DEFAULT '[]'::jsonb,
    active BOOLEAN NOT NULL DEFAULT true, use_count INTEGER NOT NULL DEFAULT 0, last_used_at TIMESTAMPTZ,
    created_by TEXT NOT NULL, updated_by TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE UNIQUE INDEX IF NOT EXISTS idx_canned_jobs_name ON canned_jobs(lower(name)) WHERE active;`);
}

export function registerCannedJobRoutes(app, { auth, adminOnly, managerPermission, requireDb, audit }) {
  const edit = managerPermission('invoices');
  const shape = async (db, rows) => {
    // Linked stock parts show today's sell price and on-hand, so an old saved price is easy to spot.
    const ids = [...new Set(rows.flatMap(r => (r.lines || []).map(l => l.inventoryPartId).filter(Boolean)))];
    const parts = ids.length ? Object.fromEntries((await db.query('SELECT id,price,quantity FROM fullbay_import_parts WHERE id = ANY($1::bigint[])', [ids]).catch(() => ({ rows: [] }))).rows.map(p => [String(p.id), p])) : {};
    return rows.map(r => { const lines = (r.lines || []).map(l => { const p = l.inventoryPartId ? parts[String(l.inventoryPartId)] : null; return p ? { ...l, currentPrice: p.price == null ? null : Number(p.price), onHand: Number(p.quantity || 0) } : l; });
      return { id: r.id, name: r.name, category: r.category || '', notes: r.notes || '', lines, total: cannedTotal(lines), useCount: r.use_count, lastUsedAt: r.last_used_at, updatedAt: r.updated_at }; });
  };
  app.get('/api/canned-jobs', auth, adminOnly, async (req, res, next) => { try {
    const db = requireDb(), q = str(req.query.q, 80);
    const rows = (await db.query(`SELECT * FROM canned_jobs WHERE active AND ($1='' OR name ILIKE '%'||$1||'%' OR coalesce(category,'') ILIKE '%'||$1||'%') ORDER BY use_count DESC, lower(name) LIMIT 200`, [q])).rows;
    res.json({ items: await shape(db, rows) });
  } catch (e) { next(e); } });
  const save = async (req, res, next, id) => { try {
    const db = requireDb(), name = str(req.body?.name, 120), lines = cleanCannedLines(req.body?.lines);
    // A typed part number that matches exactly one stock part is linked to it (current price, on-hand, reservation).
    for (const l of lines) if (l.lineType === 'part' && l.partNumber && !l.inventoryPartId) {
      const m = (await db.query(`SELECT id FROM fullbay_import_parts WHERE lower(part_number)=lower($1) AND coalesce(status,'Active')<>'Inactive' LIMIT 2`, [l.partNumber]).catch(() => ({ rows: [] }))).rows;
      if (m.length === 1) l.inventoryPartId = Number(m[0].id);
    }
    if (!name) return res.status(400).json({ error: 'Give the canned job a name.' });
    if (!lines.length) return res.status(400).json({ error: 'Add at least one labor, part or fee line.' });
    const vals = [name, str(req.body?.category, 60), str(req.body?.notes, 1000), JSON.stringify(lines), req.user.username];
    const r = id
      ? await db.query(`UPDATE canned_jobs SET name=$1,category=$2,notes=$3,lines=$4::jsonb,updated_by=$5,updated_at=now() WHERE id=$6::bigint AND active RETURNING *`, [...vals, id])
      : await db.query(`INSERT INTO canned_jobs(name,category,notes,lines,created_by,updated_by) VALUES($1,$2,$3,$4::jsonb,$5,$5) RETURNING *`, vals);
    if (!r.rowCount) return res.status(404).json({ error: 'Canned job not found.' });
    await audit(req.user.username, id ? 'canned_job_updated' : 'canned_job_created', { id: r.rows[0].id, name });
    res.json({ item: (await shape(db, r.rows))[0] });
  } catch (e) { if (e?.code === '23505') return res.status(409).json({ error: 'A canned job with that name already exists.' }); next(e); } };
  app.post('/api/canned-jobs', auth, edit, (req, res, next) => save(req, res, next, null));
  app.put('/api/canned-jobs/:id', auth, edit, (req, res, next) => save(req, res, next, req.params.id));
  app.delete('/api/canned-jobs/:id', auth, edit, async (req, res, next) => { try {
    const r = await requireDb().query('UPDATE canned_jobs SET active=false,updated_by=$2,updated_at=now() WHERE id=$1::bigint AND active RETURNING name', [req.params.id, req.user.username]);
    if (!r.rowCount) return res.status(404).json({ error: 'Canned job not found.' });
    await audit(req.user.username, 'canned_job_deleted', { id: req.params.id, name: r.rows[0].name }); res.json({ ok: true });
  } catch (e) { next(e); } });
  app.post('/api/canned-jobs/:id/used', auth, adminOnly, async (req, res, next) => { try {
    await requireDb().query('UPDATE canned_jobs SET use_count=use_count+1,last_used_at=now() WHERE id=$1::bigint', [req.params.id]); res.json({ ok: true });
  } catch (e) { next(e); } });
}
