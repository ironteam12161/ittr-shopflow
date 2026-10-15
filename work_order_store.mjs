// v24.56.0: work orders also live one row per work order. A database trigger copies every work order out of the
// shop record on every save (whatever code path saved it), so:
//  - a deleted work order keeps its last full copy and the owner can put it back (recycle bin, 90 days);
//  - work orders can be searched and reported on without loading the whole shop record;
//  - moving the app's reads to this table later is a step-by-step change, not a big-bang migration.
export async function ensureWorkOrderStore(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS work_orders(
    id TEXT PRIMARY KEY, status TEXT, unit TEXT, customer TEXT, mechanic TEXT, payload JSONB NOT NULL,
    first_seen_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), removed_at TIMESTAMPTZ);
  CREATE INDEX IF NOT EXISTS idx_work_orders_removed ON work_orders(removed_at) WHERE removed_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_work_orders_unit ON work_orders(lower(unit));
  CREATE OR REPLACE FUNCTION ittr_sync_work_orders(p JSONB) RETURNS void LANGUAGE plpgsql AS $f$
  BEGIN
    INSERT INTO work_orders(id,status,unit,customer,mechanic,payload,updated_at,removed_at)
      SELECT DISTINCT ON (w->>'id') w->>'id',w->>'status',w->>'unit',w->>'customer',w->>'mechanic',w,now(),NULL
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p->'workorders')='array' THEN p->'workorders' ELSE '[]'::jsonb END) w
      WHERE jsonb_typeof(w)='object' AND coalesce(w->>'id','')<>''
      ORDER BY w->>'id'
    ON CONFLICT(id) DO UPDATE SET status=excluded.status,unit=excluded.unit,customer=excluded.customer,mechanic=excluded.mechanic,payload=excluded.payload,updated_at=now(),removed_at=NULL
      WHERE work_orders.payload IS DISTINCT FROM excluded.payload OR work_orders.removed_at IS NOT NULL;
    UPDATE work_orders SET removed_at=now() WHERE removed_at IS NULL AND id NOT IN (
      SELECT w->>'id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p->'workorders')='array' THEN p->'workorders' ELSE '[]'::jsonb END) w WHERE jsonb_typeof(w)='object' AND coalesce(w->>'id','')<>'');
    DELETE FROM work_orders WHERE removed_at < now()-interval '90 days';
  END $f$;
  CREATE OR REPLACE FUNCTION ittr_work_orders_trigger() RETURNS trigger LANGUAGE plpgsql AS $f$
  BEGIN IF NEW.state_key='shopflow' THEN PERFORM ittr_sync_work_orders(NEW.payload); END IF; RETURN NEW; END $f$;
  DROP TRIGGER IF EXISTS trg_ittr_work_orders ON app_state;
  CREATE TRIGGER trg_ittr_work_orders AFTER INSERT OR UPDATE OF payload ON app_state FOR EACH ROW EXECUTE FUNCTION ittr_work_orders_trigger();`);
  await db.query(`SELECT ittr_sync_work_orders(payload) FROM app_state WHERE state_key='shopflow'`);
}

export function registerWorkOrderStoreRoutes(app, { auth, adminOnly, ownerOnly, requireDb, audit, broadcastShopStatus }) {
  app.get('/api/work-orders/removed', auth, adminOnly, async (req, res, next) => { try {
    const r = await requireDb().query(`SELECT id,status,unit,customer,mechanic,removed_at,jsonb_array_length(CASE WHEN jsonb_typeof(payload->'tasks')='array' THEN payload->'tasks' ELSE '[]'::jsonb END) tasks FROM work_orders WHERE removed_at IS NOT NULL ORDER BY removed_at DESC LIMIT 200`);
    res.json({ items: r.rows });
  } catch (e) { next(e); } });
  app.post('/api/work-orders/:id/restore', auth, ownerOnly, async (req, res, next) => {
    const db = await requireDb().connect();
    try {
      await db.query('BEGIN');
      const w = (await db.query('SELECT payload FROM work_orders WHERE id=$1 AND removed_at IS NOT NULL', [String(req.params.id)])).rows[0];
      if (!w) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'This work order is not in the recycle bin.' }); }
      const cur = (await db.query(`SELECT payload,version FROM app_state WHERE state_key='shopflow' FOR UPDATE`)).rows[0];
      const sf = cur?.payload && typeof cur.payload === 'object' ? cur.payload : { workorders: [], issues: [] }, list = Array.isArray(sf.workorders) ? sf.workorders : [];
      if (list.some(x => String(x?.id) === String(req.params.id))) { await db.query('ROLLBACK'); return res.status(409).json({ error: `Work order #${req.params.id} already exists.` }); }
      const q = await db.query(`UPDATE app_state SET payload=$1::jsonb,version=version+1,updated_at=now(),updated_by=$2 WHERE state_key='shopflow' RETURNING version`, [JSON.stringify({ ...sf, workorders: [...list, w.payload] }), req.user.username]);
      await db.query('COMMIT');
      await audit(req.user.username, 'work_order_restored', { workOrderId: req.params.id });
      broadcastShopStatus('shopflow_changed', { by: req.user.username, version: Number(q.rows[0].version) });
      res.json({ ok: true, version: Number(q.rows[0].version) });
    } catch (e) { try { await db.query('ROLLBACK'); } catch (_) {} next(e); } finally { db.release(); }
  });
}
