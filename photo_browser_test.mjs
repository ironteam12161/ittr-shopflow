// v24.69.0: finding photos in a real browser (Chromium) against a disposable server + database and the in-memory S3
// (mock_s3.mjs) — never real R2. Checks the mechanic phone flow (several photos with caption/type, offline save shows
// "Saved on this device" only after the device copy is written, upload failure keeps the finding and offers Retry,
// reload keeps the waiting photos, retry uploads each photo once), the owner's full-screen viewer (keyboard, zoom,
// rotate, swipe, Esc, focus), non-destructive markup, expired links and broken thumbnails with retry, older data-URL
// photos, Ukrainian labels, and no sideways scrolling at phone width.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { dbSuiteGuard, reportSuite, startTestServer, ok, eq, sleep } from './test_harness.mjs';
import { startMockS3 } from './mock_s3.mjs';
const NAME = 'photo browser';
dbSuiteGuard(NAME);

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {
  if (process.env.ITTR_REQUIRE_BROWSER_SUITE === '1') { reportSuite(NAME, 'FAILED', 'Playwright not installed'); console.error(`FAIL ${NAME}: Playwright is not installed`); process.exit(1); }
  reportSuite(NAME, 'SKIPPED', 'Playwright not installed'); console.log(`SKIP ${NAME}: Playwright is not installed`); process.exit(0);
}
const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
let browser;
try { browser = await chromium.launch(exe ? { executablePath: exe } : {}); } catch (e) {
  if (process.env.ITTR_REQUIRE_BROWSER_SUITE === '1') { reportSuite(NAME, 'FAILED', 'Chromium not available'); console.error(`FAIL ${NAME}: Chromium could not start: ${e.message.split('\n')[0]}`); process.exit(1); }
  reportSuite(NAME, 'SKIPPED', 'Chromium not installed'); console.log(`SKIP ${NAME}: Chromium is not installed`); process.exit(0);
}

const OWNER = { username: 'owner', password: 'Shop-Boss-Pass-2026' };
const s3 = await startMockS3();
const srv = await startTestServer({ prefix: 'ittr_photobr', admin: OWNER, env: s3.env });
const B = srv.base();
const failures = [];
let STEP = '';
async function scenario(name, fn) { STEP = ''; try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.error(`FAIL ${name}${STEP ? ` [at: ${STEP}]` : ''}: ${e.message}`); } }
async function newPage({ width = 1366, height = 860 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
  const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message)); page.dialogs = []; page.on('dialog', d => { page.dialogs.push(d.type()); d.accept().catch(() => {}); });
  return { ctx, page };
}
async function signIn(page, u, p) {
  await page.fill('#loginUser', u); await page.fill('#loginPass', p); await page.click('#loginForm button[type="submit"]');
  await page.waitForFunction(un => typeof session !== 'undefined' && session?.username === un, u, { timeout: 15000 });
  await page.waitForFunction(() => typeof cloudReady !== 'undefined' && cloudReady === true, null, { timeout: 15000 });
}
const until = (page, fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout });
const jpeg = (w, h, color) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
const shot = async (page, name) => { const dir = process.env.ITTR_SCREENSHOT_DIR; if (dir) await page.screenshot({ path: `${dir}/${name}.png` }).catch(() => {}); };

try {
  const owner = await srv.login(OWNER.username, OWNER.password);
  await srv.request('/api/admin/users', { method: 'POST', token: owner, body: { username: 'mech1', display: 'Mech One', password: 'Mechanic-Pass-1' } });
  const st = await srv.request('/api/state', { token: owner });
  const sf = st.shopflow.payload;
  sf.workorders = [{ id: 501, unit: 'DEMO-12', customer: 'Demo Fleet', status: 'Open', mechanic: 'mech1', helpers: [], date: '2026-10-16', time: '08:00', truckHere: true, tasks: [{ uid: 't1', t: 'Brake inspection', done: false }] }];
  // An older finding with a photo stored inside the record (before photos moved to storage) must still show.
  const tiny = `data:image/jpeg;base64,${(await jpeg(40, 30, '#3355aa')).toString('base64')}`;
  sf.issues = [{ id: 7001, wo: 501, mechanic: 'mech1', severity: 'Needs Attention', description: 'Older finding with an embedded photo', recommendation: '', photo: tiny, photoId: '', approval: 'Waiting for Customer', createdAt: '2026-10-15T10:00:00Z', created: '10/15/2026' }];
  await srv.request('/api/state/shopflow', { method: 'PUT', token: owner, body: { payload: sf, expectedVersion: st.shopflow.version } });
  const serverShop = async () => (await srv.request('/api/state', { token: owner })).shopflow.payload;
  const photos = [{ name: 'drum-crack.jpg', mimeType: 'image/jpeg', buffer: await jpeg(2400, 1600, '#7a3b1e') }, { name: 'drum-wide.jpg', mimeType: 'image/jpeg', buffer: await jpeg(900, 1200, '#1e5a7a') }];
  let findingId = null;

  await scenario('mechanic phone: offline finding with 2 photos → "Saved on this device" → upload fails → reload → Retry → uploaded once', async () => {
    const { ctx, page } = await newPage({ width: 390, height: 844 });
    // A request held by the test's network interception can stall; the app's upload time limit must free the queue.
    await ctx.addInitScript(() => { window.ITTR_UPLOAD_TIMEOUT_MS = 5000; }); await page.goto(B); await signIn(page, 'mech1', 'Mechanic-Pass-1');
    await page.click('#mobileBottomNav [data-mobile-view="inspection"]').catch(() => page.evaluate(() => document.querySelector('[data-view="inspection"]').click()));
    await page.click('#inspection .toolbar button'); await until(page, () => document.getElementById('issueModal').classList.contains('open'));
    await page.fill('#issueForm [name="description"]', 'LF brake drum cracked');
    await page.setInputFiles('#findingPhotoInput', photos);
    await until(page, () => document.querySelectorAll('#findingPhotoPicker .fpPickRow').length === 2);
    await page.fill('#findingPhotoPicker .fpPickRow:nth-child(1) input', 'Crack at 3 o\'clock');
    await page.selectOption('#findingPhotoPicker .fpPickRow:nth-child(1) select', 'before');
    ok((await page.textContent('#findingPhotoStatus')).includes('2 photos ready'), 'status says 2 photos ready');
    await shot(page, 'after-mechanic-picker');
    const sw = await page.evaluate(() => document.documentElement.scrollWidth); ok(sw <= 390, `no sideways scroll in the finding form (${sw}px)`);

    await ctx.setOffline(true);
    await page.click('#issueForm button[type="submit"]');
    await until(page, () => !document.getElementById('issueModal').classList.contains('open'));
    findingId = await page.evaluate(() => state.issues.find(i => i.description === 'LF brake drum cracked')?.id);
    ok(findingId, 'finding saved in the app while offline');
    await until(page, id => document.querySelectorAll(`.fpGallery[data-fp-finding="${id}"] [data-fp-status="local"]`).length === 2, String(findingId));
    const chips = await page.$$eval(`.fpGallery[data-fp-finding="${findingId}"] .fpState .ds-chip`, els => els.map(e => e.textContent.trim()));
    ok(chips.every(t => t === 'Saved on this device'), `chips: ${chips.join(' / ')}`);
    eq(await page.evaluate(() => new Promise(res => { const r = indexedDB.open('ittr-photo-queue'); r.onsuccess = () => { const q = r.result.transaction('uploads').objectStore('uploads').count(); q.onsuccess = () => res(q.result); }; })), 2, 'both photos really are in IndexedDB');
    ok(/photo/.test(await page.textContent('#syncQueueText')), 'sync badge mentions photos waiting');
    await shot(page, 'after-mechanic-saved-on-device');
    const sw2 = await page.evaluate(() => document.documentElement.scrollWidth);
    const wide = sw2 > 390 ? await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > 392 && e.offsetParent).slice(0, 6).map(e => `${e.tagName}#${e.id}.${String(e.className).slice(0, 40)} ${Math.round(e.getBoundingClientRect().right)}`).join(' | ')) : '';
    ok(sw2 <= 390, `no sideways scroll on the findings list (${sw2}px: ${wide})`);

    // Back online but the photo upload keeps failing: the finding still reaches the server, the photos wait with Retry.
    await page.route('**/api/findings/*/photo', r => r.abort('failed'));
    await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await until(page, id => document.querySelectorAll(`.fpGallery[data-fp-finding="${id}"] [data-fp-status="failed"]`).length === 2, String(findingId), 15000);
    ok(await page.locator(`.fpGallery[data-fp-finding="${findingId}"] .fpState button:has-text("Retry")`).count() === 2, 'Retry offered on each photo');
    await until(page, () => ittrSync.status().pending === 0, null, 15000);
    ok((await serverShop()).issues.some(i => String(i.id) === String(findingId)), 'finding saved on the server although the photos failed');
    eq(s3.objects.size, 0, 'nothing stored yet');
    await shot(page, 'after-mechanic-upload-failed');

    // A stalled upload (no answer at all) is given up after the time limit and offered for Retry again.
    STEP = 'stalled upload';
    await page.unroute('**/api/findings/*/photo'); await page.route('**/api/findings/*/photo', () => {});
    await page.evaluate(() => { const e = ittrPhotoQueue.list().find(x => x.status === 'failed'); if (e) ittrPhotoQueue.retry(e.id); }); // the automatic retry may already be under way
    await until(page, () => ittrPhotoQueue.list().some(e => e.status === 'failed' && /took too long/.test(e.error)), null, 30000);
    eq(s3.objects.size, 0, 'nothing stored by the stalled upload');
    await page.unroute('**/api/findings/*/photo'); await page.route('**/api/findings/*/photo', r => r.abort('failed'));

    await page.reload(); await until(page, () => typeof cloudReady !== 'undefined' && cloudReady, null, 15000);
    await page.evaluate(() => document.querySelector('[data-view="inspection"]').click());
    await until(page, id => document.querySelectorAll(`.fpGallery[data-fp-finding="${id}"] [data-fp-kind="queue"]`).length === 2, String(findingId), 15000);

    STEP = 'retry uploads';
    await page.unroute('**/api/findings/*/photo');
    // Retry what is still waiting (the app's own automatic retry may already have sent some once the network is back).
    const retryBtn = page.locator(`.fpGallery[data-fp-finding="${findingId}"] .fpState button:has-text("Retry")`).first();
    if (await retryBtn.isVisible().catch(() => false)) await retryBtn.click({ timeout: 3000 }).catch(() => {});
    await page.evaluate(() => ittrPhotoQueue.list().filter(e => e.status === 'failed').forEach(e => ittrPhotoQueue.retry(e.id)));
    await until(page, id => document.querySelectorAll(`.fpGallery[data-fp-finding="${id}"] [data-fp-kind="server"]`).length === 2 && !document.querySelector(`.fpGallery[data-fp-finding="${id}"] [data-fp-kind="queue"]`), String(findingId), 20000)
      .catch(async e => { throw new Error(`${e.message.split('\n')[0]} queue=${JSON.stringify(await page.evaluate(() => ittrPhotoQueue.list().map(x => [x.status, x.error, x.photoId])))} tiles=${await page.evaluate(id => [...document.querySelectorAll(`.fpGallery[data-fp-finding="${id}"] .fpThumb`)].map(t => t.dataset.fpKind + ':' + (t.dataset.fpStatus || '')).join(','), String(findingId))} rows=${(await srv.db.query('SELECT count(*)::int n FROM finding_photos')).rows[0].n}`); });
    eq(s3.objects.size, 4, 'two originals + two thumbnails stored');
    const rows = (await srv.db.query('SELECT caption,kind FROM finding_photos WHERE finding_id=$1 ORDER BY created_at', [String(findingId)])).rows;
    eq(rows.length, 2, 'two photo rows'); ok(rows.some(r => r.caption === 'Crack at 3 o\'clock' && r.kind === 'before'), 'caption and Before type kept');
    await until(page, () => ittrSync.status().pending === 0, null, 15000);
    const iss = (await serverShop()).issues.find(i => String(i.id) === String(findingId));
    ok(iss.photoIds?.length === 2 && iss.photoId, 'finding record lists its photos');
    eq(await page.evaluate(() => new Promise(res => { const r = indexedDB.open('ittr-photo-queue'); r.onsuccess = () => { const q = r.result.transaction('uploads').objectStore('uploads').count(); q.onsuccess = () => res(q.result); }; })), 0, 'device copies removed after upload');
    await until(page, () => !/photo/.test(document.getElementById('syncQueueText').textContent));
    const imgs = await page.$$eval(`.fpGallery[data-fp-finding="${findingId}"] img`, els => els.map(i => ({ src: i.currentSrc || i.src, fit: getComputedStyle(i).objectFit })));
    ok(imgs.every(i => i.src.includes('_t.jpg') && i.fit === 'contain'), 'cards load thumbnails, shown whole (not cropped)');
    await shot(page, 'after-mechanic-uploaded');
    eq(page.errors.length, 0, `no script errors (${page.errors.join(' | ')})`); await ctx.close();
  });

  await scenario('owner viewer: keyboard, zoom, rotate, swipe, Esc + focus, non-destructive markup', async () => {
    const { ctx, page } = await newPage(); await page.goto(B); await signIn(page, OWNER.username, OWNER.password);
    await page.click('header nav .navbtn[data-view="approvals"]');
    await page.evaluate(() => { wsFindingsMode('list'); setFindingView('all'); });
    const g = `.fpGallery[data-fp-finding="${findingId}"]`;
    await until(page, sel => document.querySelectorAll(`${sel} [data-fp-kind="server"]:not(.fpLoading)`).length === 2, g, 15000);
    ok(await page.locator(`${g} .fpTag.before`).count() === 1, 'Before tag on the card');
    await shot(page, 'after-office-findings');
    const first = page.locator(`${g} [data-fp-kind="server"] .fpImg`).first();
    await first.click(); await until(page, () => document.querySelector('.pv') && ITTRPhotoViewer.state && document.querySelector('.pv .pvLayer').style.visibility === 'visible');
    const meta = await page.textContent('.pv .pvCtx'); ok(meta.includes('DEMO-12') && meta.includes('Mech One'), `context shown: ${meta}`);
    eq(await page.textContent('.pv .pvCount'), 'Photo 1 / 2', 'counter');
    ok(!(await page.locator('.pv .pvMsg').isVisible()), 'loading message gone once the photo shows');
    ok(!(await page.locator('.pv [data-a="marks"]').isVisible()), 'show/hide markup only offered when the photo has markup');
    await shot(page, 'after-viewer');
    await page.keyboard.press('ArrowRight'); await until(page, () => ITTRPhotoViewer.state.index === 1);
    await page.keyboard.press('ArrowLeft'); await until(page, () => ITTRPhotoViewer.state.index === 0 && document.querySelector('.pv .pvLayer').style.visibility === 'visible');
    await page.keyboard.press('+'); ok((await page.evaluate(() => ITTRPhotoViewer.state.zoom)) > 1.4, 'zoom in');
    await page.keyboard.press('0'); ok(Math.abs((await page.evaluate(() => ITTRPhotoViewer.state.zoom)) - 1) < 0.01, 'fit');
    await page.keyboard.press('r'); eq(await page.evaluate(() => ITTRPhotoViewer.state.rotation), 90, 'rotate');
    await page.keyboard.press('r'); await page.keyboard.press('r'); await page.keyboard.press('r'); eq(await page.evaluate(() => ITTRPhotoViewer.state.rotation), 0, 'rotate back');
    // Fit-to-screen never crops: the whole photo is inside the stage.
    const fit = await page.evaluate(() => { const s = document.querySelector('.pv .pvStage').getBoundingClientRect(), l = document.querySelector('.pv .pvLayer img').getBoundingClientRect(); return l.left >= s.left - 1 && l.top >= s.top - 1 && l.right <= s.right + 1 && l.bottom <= s.bottom + 1; });
    ok(fit, 'whole photo visible at fit');
    const box = await page.locator('.pv .pvStage').boundingBox();
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
    await until(page, () => ITTRPhotoViewer.state.index === 1); // swipe left → next
    await page.keyboard.press('ArrowLeft'); await until(page, () => ITTRPhotoViewer.state.index === 0 && document.querySelector('.pv .pvLayer').style.visibility === 'visible');

    // Markup: draw an arrow, save; the stored photo bytes do not change.
    const before = new Map([...s3.objects].map(([k, v]) => [k, Buffer.from(v.body)]));
    await page.click('.pv [data-a="edit"]'); ok(await page.evaluate(() => ITTRPhotoViewer.state.editing), 'markup mode');
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3); await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 5 }); await page.mouse.up();
    eq(await page.evaluate(() => ITTRPhotoViewer.state.marks), 1, 'one mark drawn');
    await page.click('.pv [data-a="save"]'); await until(page, () => /original photo is unchanged/.test(document.querySelector('.pv .pvStatus').textContent));
    const ann = (await srv.db.query('SELECT annotations FROM finding_photos WHERE finding_id=$1 AND jsonb_array_length(annotations)>0', [String(findingId)])).rows;
    eq(ann.length, 1, 'markup stored'); eq(ann[0].annotations[0].t, 'arrow', 'arrow stored');
    ok([...before].every(([k, v]) => Buffer.compare(v, s3.objects.get(k).body) === 0), 'stored photos unchanged by markup');

    // A text label is typed in the viewer itself (no browser pop-up) and is added to the arrow already there.
    STEP = 'text label';
    await page.click('.pv [data-a="edit"]'); await page.click('.pv [data-tool="text"]');
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.4);
    await until(page, () => !document.querySelector('.pv .pvTextBox').hidden);
    await page.fill('.pv .pvTextBox input', 'Crack here'); await page.keyboard.press('Enter');
    eq(await page.evaluate(() => ITTRPhotoViewer.state.marks), 2, 'label added next to the arrow');
    await page.click('.pv [data-a="save"]'); await until(page, () => /original photo is unchanged/.test(document.querySelector('.pv .pvStatus').textContent));
    const ann2 = (await srv.db.query('SELECT annotations FROM finding_photos WHERE finding_id=$1 AND jsonb_array_length(annotations)>0', [String(findingId)])).rows[0].annotations;
    ok(ann2.length === 2 && ann2.some(m => m.t === 'text' && m.text === 'Crack here'), 'typed label stored');
    ok(!page.dialogs.includes('prompt'), 'no browser pop-up used for the label');

    // Details: caption, type and before/after pair are changed in the viewer.
    STEP = 'details';
    await page.click('.pv [data-a="details"]'); await until(page, () => !document.querySelector('.pv .pvDetails').hidden);
    await page.fill('.pv .pvDetails [name="caption"]', 'Cracked drum, LF side');
    const pairTo = await page.evaluate(() => [...document.querySelectorAll('.pv .pvDetails [name="pairId"] option')].map(o => o.value).find(Boolean));
    ok(pairTo, 'the other photo is offered as its pair');
    await page.selectOption('.pv .pvDetails [name="pairId"]', pairTo);
    const kindShown = await page.inputValue('.pv .pvDetails [name="kind"]');
    await page.click('.pv [data-a="detsave"]'); await until(page, () => /Details saved/.test(document.querySelector('.pv .pvStatus').textContent));
    const det = (await srv.db.query("SELECT caption,kind,pair_id FROM finding_photos WHERE finding_id=$1 AND caption='Cracked drum, LF side'", [String(findingId)])).rows[0];
    ok(det && (det.kind || '') === kindShown && det.pair_id === pairTo, `caption and pair saved, type kept (${JSON.stringify(det)} / shown "${kindShown}")`);
    ok((await page.textContent('.pv .pvCap')).includes('Cracked drum, LF side'), 'viewer shows the new caption');
    await page.keyboard.press('Escape'); await until(page, () => !document.querySelector('.pv'));
    ok(await page.evaluate(() => document.activeElement?.classList.contains('fpImg')), 'focus back on the photo that opened the viewer');
    await until(page, sel => document.querySelector(`${sel} .fpMarks`), g);
    eq(page.errors.length, 0, `no script errors (${page.errors.join(' | ')})`); await ctx.close();
  });

  await scenario('expired links and broken thumbnails recover with Retry; older embedded photo shows; Ukrainian labels', async () => {
    const { ctx, page } = await newPage(); await page.goto(B); await signIn(page, OWNER.username, OWNER.password);
    await page.click('header nav .navbtn[data-view="approvals"]'); await page.evaluate(() => { wsFindingsMode('list'); setFindingView('all'); });
    const g = `.fpGallery[data-fp-finding="${findingId}"]`;
    await until(page, sel => document.querySelectorAll(`${sel} [data-fp-kind="server"]:not(.fpLoading)`).length === 2, g, 15000);
    STEP = 'legacy';
    ok(await page.evaluate(() => document.querySelector('.fpGallery[data-fp-finding="7001"] [data-fp-kind="legacy"] img')?.src.startsWith('data:image/')), 'older embedded photo shown');

    STEP = 'full link expired';
    // Full photo link expired: the viewer fetches a fresh link once, then offers Retry.
    const fullKeys = [...s3.objects.keys()].filter(k => !k.endsWith('_t.jpg'));
    fullKeys.forEach(k => s3.server.forceExpired.add(k));
    await page.locator(`${g} [data-fp-kind="server"] .fpImg`).first().click();
    await until(page, () => document.querySelector('.pv [data-a="retry"]'), null, 15000);
    ok(/could not be loaded/.test(await page.textContent('.pv .pvMsg')), 'failure explained');
    await shot(page, 'after-viewer-failed');
    fullKeys.forEach(k => s3.server.forceExpired.delete(k));
    await page.click('.pv [data-a="retry"]'); await until(page, () => document.querySelector('.pv .pvLayer').style.visibility === 'visible');
    await page.keyboard.press('Escape');

    STEP = 'thumbnails expired';
    // Thumbnails expired: tile shows "tap to retry"; tapping gets fresh links.
    const thumbs = [...s3.objects.keys()].filter(k => k.endsWith('_t.jpg')); thumbs.forEach(k => s3.server.forceExpired.add(k));
    await sleep(1100); // signed links are per second: make sure the new ones differ from the cached images
    await page.evaluate(wo => fpReloadWo(wo), '501');
    await until(page, sel => document.querySelectorAll(`${sel} .fpBroken`).length === 2, g, 15000);
    thumbs.forEach(k => s3.server.forceExpired.delete(k));
    await page.locator(`${g} .fpBroken .fpImg`).first().click();
    await until(page, sel => document.querySelectorAll(`${sel} [data-fp-kind="server"]:not(.fpLoading):not(.fpBroken)`).length === 2, g, 15000);

    STEP = 'ukrainian';
    await page.selectOption('#languageSelect', 'uk');
    await page.waitForLoadState('load'); await sleep(500);
    await until(page, () => typeof cloudReady !== 'undefined' && cloudReady && currentLanguage === 'uk', null, 15000);
    await page.evaluate(() => { document.querySelector('header nav .navbtn[data-view="approvals"]').click(); wsFindingsMode('list'); setFindingView('all'); });
    await until(page, () => /Додати фото/.test(document.getElementById('approvalIssues').textContent));
    await page.locator(`${g} [data-fp-kind="server"] .fpImg`).first().click();
    await until(page, () => document.querySelector('.pv'));
    ok((await page.textContent('.pv .pvCount')).startsWith('Фото'), 'viewer in Ukrainian');
    ok((await page.getAttribute('.pv [data-a="close"]', 'aria-label')) === 'Закрити', 'close label in Ukrainian');
    await page.keyboard.press('Escape');
    await shot(page, 'after-ukrainian-viewer-closed');

    // Delete (uploader or owner): the stored photo and its thumbnail go, and the finding record no longer lists it.
    STEP = 'close while loading';
    await page.route('**/*_t.jpg*', r => r.continue()); // (thumbnails unaffected)
    await page.route(u => /\/findings\/.*(?<!_t)\.jpg/.test(String(u)) && !/_t\.jpg/.test(String(u)), async r => { await sleep(1500); await r.continue().catch(() => {}); });
    await page.locator(`${g} [data-fp-kind="server"] .fpImg`).first().click(); await until(page, () => document.querySelector('.pv'));
    await page.keyboard.press('Escape'); await sleep(2500);
    eq(page.errors.length, 0, `closing during a slow load raises no error (${page.errors.join(' | ')})`);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    STEP = 'delete';
    const objsBefore = s3.objects.size;
    await page.locator(`${g} [data-fp-kind="server"] .fpImg`).last().click(); await until(page, () => document.querySelector('.pv .pvLayer')?.style.visibility === 'visible');
    await page.click('.pv [data-a="details"]'); await page.click('.pv [data-a="delete"]');
    await until(page, () => !document.querySelector('.pv') || /1 \/ 1|1 \/ 1/.test(document.querySelector('.pv .pvCount')?.textContent || ''));
    ok(page.dialogs.includes('confirm'), 'delete asks first');
    await until(page, sel => document.querySelectorAll(`${sel} [data-fp-kind="server"]`).length === 1, g, 15000);
    eq(s3.objects.size, objsBefore - 2, 'photo and thumbnail removed from storage');
    await until(page, () => ittrSync.status().pending === 0, null, 15000);
    eq((await serverShop()).issues.find(i => String(i.id) === String(findingId)).photoIds.length, 1, 'finding record lists one photo');
    eq(page.errors.length, 0, `no script errors (${page.errors.join(' | ')})`); await ctx.close();
  });
} catch (e) {
  console.error(e); failures.push('setup');
} finally {
  await browser.close().catch(() => {}); await srv.cleanup(); await s3.close();
}
if (failures.length) { console.error(`FAIL ${NAME}: ${failures.join('; ')}`); console.error(srv.output().slice(-2000)); process.exitCode = 1; }
else console.log(`PASS ${NAME}: all scenarios`);
