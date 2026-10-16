// v24.69.0: finding photos against a disposable database and an in-memory S3 (mock_s3.mjs) — never real R2.
// Covers: upload with caption/kind, the thumbnail object, a retried upload with the same clientId (stored once),
// the work-order photo list, the thumb/full signed links, markup saved next to the untouched original, who may see and
// change photos (owner, assigned mechanic; not another mechanic; managers keep the existing no-access rule),
// delete removing both objects, and the customer inspection page not showing deleted photos.
import sharp from 'sharp';
import { dbSuiteGuard, startTestServer, ok, eq } from './test_harness.mjs';
import { startMockS3 } from './mock_s3.mjs';
import { cleanAnnotations } from './photo_center.mjs';
dbSuiteGuard('Finding photos (mock S3)');
const s3 = await startMockS3();
const srv = await startTestServer({ prefix: 'ittr_photo', env: s3.env });

const jpeg = (w, h, color) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
async function upload(token, findingId, workOrderId, buf, fields = {}) {
  const fd = new FormData(); fd.append('photo', new Blob([buf], { type: 'image/jpeg' }), 'evidence.jpg'); fd.append('workOrderId', String(workOrderId));
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  const r = await fetch(`${srv.base()}/api/findings/${encodeURIComponent(findingId)}/photo`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const get = (path, token) => srv.request(path, { token, allowError: true });

try {
  // cleanAnnotations is the only gate for stored markup: unit-space coordinates, known types and colours, a cap.
  eq(JSON.stringify(cleanAnnotations([{ t: 'arrow', x: 0.1, y: 0.2, x2: 1.4, y2: -1, c: 'green' }])), JSON.stringify([{ t: 'arrow', x: 0.1, y: 0.2, x2: 1, y2: 0, c: 'red' }]), 'markup is clamped to the photo and unknown colours fall back to red');
  for (const bad of [[{ t: 'script', x: 0, y: 0 }], [{ t: 'text', x: 0.5, y: 0.5, text: '   ' }], [{ t: 'circle', x: 0.5, y: 0.5 }], 'nope', Array.from({ length: 41 }, () => ({ t: 'text', x: 0, y: 0, text: 'x' }))]) {
    let threw = false; try { cleanAnnotations(bad); } catch (e) { threw = e.status === 400; } ok(threw, `invalid markup refused: ${JSON.stringify(bad).slice(0, 40)}`);
  }

  const owner = await srv.login('opsadmin', 'CI-Ops-Admin-2026!');
  for (const u of ['mech1', 'mech2']) await srv.request('/api/admin/users', { method: 'POST', token: owner, body: { username: u, display: u, password: `${u}-Pass-2026!` } });
  await srv.request('/api/admin/managers', { method: 'POST', token: owner, body: { username: 'mgr1', display: 'Manager', password: 'Manager-Pass-2026', permissions: { invoices: true, customers: true } } });
  const mech1 = await srv.login('mech1', 'mech1-Pass-2026!'), mech2 = await srv.login('mech2', 'mech2-Pass-2026!'), mgr = await srv.login('mgr1', 'Manager-Pass-2026');
  const st = await srv.request('/api/state', { token: owner });
  const shop = { ...(st.shopflow?.payload || {}), workorders: [{ id: 501, unit: 'PH-1', customer: 'Photo Fleet', status: 'Open', mechanic: 'mech1', helpers: [], tasks: [{ uid: 'a', t: 'Brakes', done: false }] }], issues: [{ id: 9001, wo: 501, mechanic: 'mech1', severity: 'High', description: 'Cracked brake drum', recommendation: 'Replace drum', approval: 'Waiting for Customer', photoId: '', photoIds: [] }] };
  await srv.request('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: shop, expectedVersion: st.shopflow?.version || 0 } });

  // Upload by the assigned mechanic with caption + before, plus a large photo to see the thumbnail made smaller.
  const big = await jpeg(3000, 2000, '#884422');
  const a = await upload(mech1, 9001, 501, big, { clientId: 'client-aaa', caption: 'Crack at 3 o\'clock', kind: 'before', component: 'LF drum' });
  eq(a.status, 200, 'assigned mechanic can upload'); ok(a.photoId && a.photo?.caption === 'Crack at 3 o\'clock' && a.photo.kind === 'before' && a.photo.component === 'LF drum', 'caption, kind and component are stored');
  ok(a.photo.hasThumb, 'thumbnail recorded');
  const keys = [...s3.objects.keys()], full = keys.find(k => !k.endsWith('_t.jpg')), thumb = keys.find(k => k.endsWith('_t.jpg'));
  ok(full && thumb, `original and thumbnail objects stored (${keys.join(', ')})`);
  const tm = await sharp(s3.objects.get(thumb).body).metadata(), fm = await sharp(s3.objects.get(full).body).metadata();
  ok(Math.max(tm.width, tm.height) <= 480 && Math.max(fm.width, fm.height) <= 1920, `thumbnail ≤480px (${tm.width}x${tm.height}), original normalised ≤1920px (${fm.width}x${fm.height})`);
  ok(Math.abs(tm.width / tm.height - 1.5) < 0.02, 'thumbnail keeps the whole picture (same aspect ratio, not cropped)');

  // The phone lost the answer and sends the same photo again: stored once, same id back.
  const again = await upload(mech1, 9001, 501, big, { clientId: 'client-aaa', caption: 'Crack at 3 o\'clock', kind: 'before' });
  eq(again.status, 200, 'retried upload answered'); ok(again.duplicate === true && again.photoId === a.photoId, 'retry with the same clientId returns the photo already saved');
  eq((await srv.db.query('SELECT count(*)::int n FROM finding_photos WHERE finding_id=$1', ['9001'])).rows[0].n, 1, 'no duplicate row');
  eq(s3.objects.size, 2, 'no duplicate objects');

  const b = await upload(owner, 9001, 501, await jpeg(800, 600, '#226644'), { clientId: 'client-bbb', caption: 'New drum fitted', kind: 'after' });
  eq(b.status, 200, 'owner can upload');
  eq((await upload(mech2, 9001, 501, await jpeg(10, 10, '#000'), { clientId: 'x' })).status, 403, 'a mechanic not on the work order cannot upload');
  eq((await upload(mgr, 9001, 501, await jpeg(10, 10, '#000'), { clientId: 'y' })).status, 403, 'manager upload follows the existing rule (owner + assigned mechanics only)');
  eq((await upload(mech1, 9001, 99999, await jpeg(10, 10, '#000'))).status, 404, 'unknown work order refused');

  // List for the work order: one request, thumbnail links, metadata.
  const list = await get('/api/work-orders/501/photos', mech1);
  eq(list.status, 200, 'assigned mechanic lists photos'); eq(list.photos.length, 2, 'both photos listed');
  const pa = list.photos.find(p => p.id === a.photoId);
  ok(pa.thumbUrl.includes(encodeURIComponent(thumb).replace(/%2F/g, '/')) || pa.thumbUrl.includes(thumb), 'list gives the thumbnail link, not the full photo');
  ok(!('url' in pa), 'list does not sign full-size links');
  const tr = await fetch(pa.thumbUrl); eq(tr.status, 200, 'thumbnail link loads'); eq(Buffer.from(await tr.arrayBuffer()).length, s3.objects.get(thumb).body.length, 'thumbnail bytes served');
  eq((await get('/api/work-orders/501/photos', mech2)).status, 403, 'other mechanic cannot list');
  eq((await get('/api/work-orders/501/photos', mgr)).status, 403, 'manager cannot list (existing rule kept)');
  eq((await get('/api/work-orders/501/photos', owner)).photos.length, 2, 'owner lists');
  const one = await get(`/api/photos/${a.photoId}`, owner); ok(one.url && one.thumbUrl && one.caption, 'single photo gives full + thumb links');
  const tv = await get(`/api/photos/${a.photoId}/url?variant=thumb`, mech1); ok(tv.url.includes('_t.jpg'), 'variant=thumb signs the thumbnail');
  const fv = await get(`/api/photos/${a.photoId}/url`, mech1); ok(!fv.url.includes('_t.jpg'), 'default link is the full photo');
  eq((await get(`/api/photos/${a.photoId}/url`, mech2)).status, 403, 'other mechanic cannot get a link');

  // An expired signed link is refused by storage (what the viewer's "link expired — get a new one" handles).
  s3.server.forceExpired.add(full);
  eq((await fetch(fv.url)).status, 403, 'expired link refused by storage'); s3.server.forceExpired.delete(full);
  eq((await fetch((await get(`/api/photos/${a.photoId}/url`, mech1)).url)).status, 200, 'a fresh link works');

  // Markup: saved as data, the stored image is untouched.
  const before = Buffer.from(s3.objects.get(full).body);
  const marks = [{ t: 'circle', x: 0.4, y: 0.5, x2: 0.5, y2: 0.5, c: 'red' }, { t: 'text', x: 0.2, y: 0.2, text: 'Crack here', c: 'amber' }];
  const pm = await srv.request(`/api/photos/${a.photoId}`, { method: 'PATCH', token: mech1, body: { annotations: marks } });
  eq(pm.photo.annotations.length, 2, 'markup saved'); eq(pm.photo.updatedBy, 'mech1', 'who changed it is recorded');
  ok(Buffer.compare(before, s3.objects.get(full).body) === 0, 'original photo bytes unchanged by markup');
  eq((await srv.request(`/api/photos/${a.photoId}`, { method: 'PATCH', token: mech1, body: { annotations: [{ t: 'bogus' }] }, allowError: true })).status, 400, 'invalid markup refused');
  eq((await srv.request(`/api/photos/${b.photoId}`, { method: 'PATCH', token: mech1, body: { caption: 'mine now' }, allowError: true })).status, 403, 'a mechanic cannot change someone else\'s photo');
  eq((await srv.request(`/api/photos/${a.photoId}`, { method: 'PATCH', token: mech2, body: { caption: 'x' }, allowError: true })).status, 403, 'other mechanic cannot change it');
  eq((await srv.request(`/api/photos/${a.photoId}`, { method: 'PATCH', token: owner, body: { kind: 'sideways' }, allowError: true })).status, 400, 'unknown photo type refused');
  const paired = await srv.request(`/api/photos/${a.photoId}`, { method: 'PATCH', token: owner, body: { pairId: b.photoId, caption: 'Before: cracked drum' } });
  eq(paired.photo.pairId, b.photoId, 'owner pairs before/after'); eq(paired.photo.caption, 'Before: cracked drum', 'owner edits caption');
  eq((await srv.request(`/api/photos/${a.photoId}`, { method: 'PATCH', token: owner, body: { pairId: a.photoId }, allowError: true })).status, 400, 'a photo cannot be paired with itself');
  const audits = (await srv.db.query("SELECT count(*)::int n FROM server_audit WHERE action='finding_photo_updated'")).rows[0].n;
  ok(audits === 2, `photo changes are audited (${audits})`);

  // Customer inspection page shows both, then not the deleted one.
  const link = await srv.request('/api/customer-links', { method: 'POST', token: owner, body: { kind: 'inspection', refId: '501' } });
  const token = link.url.split('/c/')[1];
  let view = await srv.request(`/api/public/link/${token}`);
  eq(view.findings.find(f => f.id === '9001').photos.length, 2, 'customer page shows the photos');
  eq((await srv.request(`/api/photos/${b.photoId}`, { method: 'DELETE', token: mech1, allowError: true })).status, 403, 'mechanic cannot delete the owner\'s photo');
  const objectsBefore = s3.objects.size;
  await srv.request(`/api/photos/${b.photoId}`, { method: 'DELETE', token: owner });
  eq(s3.objects.size, objectsBefore - 2, 'delete removes the photo and its thumbnail');
  view = await srv.request(`/api/public/link/${token}`);
  eq(view.findings.find(f => f.id === '9001').photos.length, 1, 'customer page no longer shows the deleted photo');
  eq((await get('/api/work-orders/501/photos', owner)).photos.length, 1, 'deleted photo leaves the list');

  // Older photo rows (before this release) have no thumbnail: they still list and open with the full image.
  await srv.db.query("INSERT INTO finding_photos(id,finding_id,work_order_id,uploader_username,r2_key,content_type,size_bytes,width,height) VALUES('legacy-1','9001','501','mech1','findings/501/legacy-1.jpg','image/jpeg',10,10,10)");
  s3.objects.set('findings/501/legacy-1.jpg', { body: await jpeg(10, 10, '#123456'), type: 'image/jpeg' });
  const legacy = (await get('/api/work-orders/501/photos', mech1)).photos.find(p => p.id === 'legacy-1');
  ok(legacy && !legacy.hasThumb && legacy.caption === '' && Array.isArray(legacy.annotations) && legacy.thumbUrl.includes('legacy-1.jpg') && (await fetch(legacy.thumbUrl)).status === 200, 'pre-v24.69 photo listed with the full image as its thumbnail');
  console.log('PASS finding photos: upload, thumbnail, idempotent retry, list, links, expiry, markup, access, delete, customer page');
} catch (e) {
  console.error(e); console.error(srv.output().slice(-3000)); process.exitCode = 1;
} finally {
  await srv.cleanup(); await s3.close();
}
