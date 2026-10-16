// v24.69.0: finding photos — several per finding, caption, before/after pairing, non-destructive markup, small
// thumbnails, and an upload that can be retried safely (the phone sends a client id; a retry after a lost answer
// returns the photo already saved instead of storing it twice). Access rules are unchanged from server.js:
// the owner, or a mechanic assigned to the work order (canAccessPhotoWorkOrder).
const KINDS = new Set(['', 'before', 'after', 'detail']);
const COLORS = new Set(['red', 'amber', 'white', 'black', 'blue']);
const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const unit = v => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, Math.round(n * 10000) / 10000)) : null; };

// Markup is stored as data next to the untouched original: arrows, circles and short text labels in 0..1 image space.
export function cleanAnnotations(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw Object.assign(new Error('Markup must be a list.'), { status: 400 });
  if (list.length > 40) throw Object.assign(new Error('Too many marks on one photo (max 40).'), { status: 400 });
  return list.map(a => {
    const t = String(a?.t || '');
    if (!['arrow', 'circle', 'text'].includes(t)) throw Object.assign(new Error('Unknown mark type.'), { status: 400 });
    const x = unit(a.x), y = unit(a.y);
    if (x == null || y == null) throw Object.assign(new Error('Mark position is missing.'), { status: 400 });
    const c = COLORS.has(a?.c) ? a.c : 'red';
    if (t === 'text') { const text = clip(a.text, 60); if (!text) throw Object.assign(new Error('Text mark is empty.'), { status: 400 }); return { t, x, y, text, c }; }
    const x2 = unit(a.x2), y2 = unit(a.y2);
    if (x2 == null || y2 == null) throw Object.assign(new Error('Mark end point is missing.'), { status: 400 });
    return { t, x, y, x2, y2, c };
  });
}

export async function ensurePhotoSchema(db) {
  await db.query(`ALTER TABLE finding_photos ADD COLUMN IF NOT EXISTS caption TEXT;
    ALTER TABLE finding_photos ADD COLUMN IF NOT EXISTS kind TEXT;
    ALTER TABLE finding_photos ADD COLUMN IF NOT EXISTS pair_id TEXT;
    ALTER TABLE finding_photos ADD COLUMN IF NOT EXISTS component TEXT;
    ALTER TABLE finding_photos ADD COLUMN IF NOT EXISTS annotations JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE finding_photos ADD COLUMN IF NOT EXISTS thumb_key TEXT;
    ALTER TABLE finding_photos ADD COLUMN IF NOT EXISTS thumb_width INTEGER;
    ALTER TABLE finding_photos ADD COLUMN IF NOT EXISTS thumb_height INTEGER;
    ALTER TABLE finding_photos ADD COLUMN IF NOT EXISTS client_id TEXT;
    ALTER TABLE finding_photos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
    ALTER TABLE finding_photos ADD COLUMN IF NOT EXISTS updated_by TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_finding_photos_client ON finding_photos(finding_id,client_id) WHERE client_id IS NOT NULL;`);
}

export function photoMeta(r) {
  return {
    id: r.id, findingId: r.finding_id, workOrderId: r.work_order_id, uploader: r.uploader_username,
    caption: r.caption || '', kind: r.kind || '', pairId: r.pair_id || '', component: r.component || '',
    annotations: Array.isArray(r.annotations) ? r.annotations : [], width: Number(r.width || 0), height: Number(r.height || 0),
    hasThumb: !!r.thumb_key, createdAt: r.created_at, updatedAt: r.updated_at || null, updatedBy: r.updated_by || '', clientId: r.client_id || '',
  };
}

export function registerPhotoRoutes(app, { auth, requireDb, requireR2, signedUrl, audit, getShopflowPayload, canAccessPhotoWorkOrder, photoAccessRow }) {
  const woFor = async id => (Array.isArray((await getShopflowPayload()).workorders) ? (await getShopflowPayload()).workorders : []).find(x => String(x?.id) === String(id));
  const urls = async (r, variant) => ({ thumbUrl: await signedUrl(r.thumb_key || r.r2_key), ...(variant === 'full' ? { url: await signedUrl(r.r2_key) } : {}) });

  // Every photo of a work order with small signed thumbnail links (one request per screen, not one per photo).
  app.get('/api/work-orders/:id/photos', auth, async (req, res, next) => {
    try {
      requireR2();
      const w = await woFor(req.params.id);
      if (!w && req.user?.role !== 'admin') return res.status(404).json({ error: 'Work order not found.' });
      if (w && !canAccessPhotoWorkOrder(req.user, w)) return res.status(403).json({ error: 'Photo access denied.' });
      const rows = (await requireDb().query('SELECT * FROM finding_photos WHERE work_order_id=$1 AND deleted_at IS NULL ORDER BY created_at, id', [String(req.params.id)])).rows;
      const photos = [];
      for (const r of rows.slice(0, 300)) photos.push({ ...photoMeta(r), ...(await urls(r)) });
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ workOrderId: String(req.params.id), photos, expiresIn: 600 });
    } catch (e) { next(e); }
  });

  app.get('/api/photos/:photoId', auth, async (req, res, next) => {
    try {
      requireR2();
      const a = await photoAccessRow(req.params.photoId, req.user); if (a.error) return res.status(a.status).json({ error: a.error });
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ ...photoMeta(a.row), ...(await urls(a.row, 'full')), expiresIn: 600 });
    } catch (e) { next(e); }
  });

  // Caption, before/after, component and markup. The image itself is never changed.
  app.patch('/api/photos/:photoId', auth, async (req, res, next) => {
    try {
      const a = await photoAccessRow(req.params.photoId, req.user); if (a.error) return res.status(a.status).json({ error: a.error });
      if (req.user.role !== 'admin' && String(a.row.uploader_username) !== String(req.user.username)) return res.status(403).json({ error: 'Only the person who took the photo or the owner can change it.' });
      const b = req.body || {}, set = [], vals = [a.row.id];
      const add = (col, v) => { vals.push(v); set.push(`${col}=$${vals.length}`); };
      if (b.caption !== undefined) add('caption', clip(b.caption, 300) || null);
      if (b.component !== undefined) add('component', clip(b.component, 80) || null);
      if (b.kind !== undefined) { const k = String(b.kind || ''); if (!KINDS.has(k)) return res.status(400).json({ error: 'Choose before, after or detail.' }); add('kind', k || null); }
      if (b.pairId !== undefined) {
        const p = String(b.pairId || '');
        if (p) { const other = (await requireDb().query('SELECT id FROM finding_photos WHERE id=$1 AND finding_id=$2 AND deleted_at IS NULL', [p, a.row.finding_id])).rows[0]; if (!other || p === a.row.id) return res.status(400).json({ error: 'The paired photo must be another photo of the same finding.' }); }
        add('pair_id', p || null);
      }
      if (b.annotations !== undefined) { let list; try { list = cleanAnnotations(b.annotations); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); } add('annotations', JSON.stringify(list)); set[set.length - 1] += '::jsonb'; }
      if (!set.length) return res.status(400).json({ error: 'Nothing to change.' });
      add('updated_by', req.user.username); set.push('updated_at=now()');
      const r = (await requireDb().query(`UPDATE finding_photos SET ${set.join(',')} WHERE id=$1 RETURNING *`, vals)).rows[0];
      await audit(req.user.username, 'finding_photo_updated', { photoId: r.id, findingId: r.finding_id, workOrderId: r.work_order_id, fields: Object.keys(b).filter(k => ['caption', 'component', 'kind', 'pairId', 'annotations'].includes(k)), marks: Array.isArray(r.annotations) ? r.annotations.length : 0 });
      res.json({ ok: true, photo: photoMeta(r) });
    } catch (e) { next(e); }
  });
}
