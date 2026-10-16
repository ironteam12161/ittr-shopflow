// ITTR ShopFlow photo upload queue (v24.69.0).
// A finding photo is first written to this device (IndexedDB), then uploaded. The finding itself is saved whether or
// not the upload works. States shown to the person:
//   saving   — being written to this device
//   local    — "Saved on this device" (only after the IndexedDB write really completed)
//   memory   — "Not saved on this device" (storage unavailable/full): keep the app open until it uploads
//   uploading, uploaded, failed ("Retry"), refused (server said no for good — explained, can be removed)
//   signin   — waiting for the person to sign in again
// Entries belong to the signed-in account; another account never sees or uploads them. Each upload carries the
// entry id as clientId, so a retry after a lost answer never stores the photo twice (server: photo_center.mjs).
(function () {
  const DB = 'ittr-photo-queue', STORE = 'uploads';
  let dbp = null;
  function openDb() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB is not available'));
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { const s = r.result.createObjectStore(STORE, { keyPath: 'id' }); s.createIndex('user', 'user'); };
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error || new Error('IndexedDB open failed'));
      r.onblocked = () => reject(new Error('IndexedDB is blocked'));
    }).catch(e => { dbp = null; throw e; });
    return dbp;
  }
  const tx = async (mode, fn) => { const db = await openDb(); return new Promise((resolve, reject) => { const t = db.transaction(STORE, mode), s = t.objectStore(STORE); let out; Promise.resolve(fn(s)).then(v => { out = v; }); t.oncomplete = () => resolve(out); t.onerror = () => reject(t.error || new Error('IndexedDB write failed')); t.onabort = () => reject(t.error || new Error('IndexedDB write aborted')); }); };
  const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

  function create({ user, upload, onChange, online = () => navigator.onLine }) {
    const mem = new Map(); // id -> entry (the live view; blobs of durable entries are re-read from IndexedDB on demand)
    let busy = false, again = false, retryTimer = null, attempt = 0;
    const me = () => String(user() || '').toLowerCase();
    const emit = e => { try { onChange?.(e); } catch (_) {} };
    const set = (e, patch) => { Object.assign(e, patch, { updatedAt: new Date().toISOString() }); emit(e); return e; };
    async function persist(e) { const { blob, ...rest } = e; await tx('readwrite', s => s.put({ ...rest, blob })); }
    async function drop(id) { try { await tx('readwrite', s => s.delete(id)); } catch (_) {} }

    const api = {
      // Load this account's queued photos after sign-in / reload.
      async restore() {
        // Entries of other accounts stay in memory (an unsaved one must not be lost) but are never listed or sent.
        try {
          const rows = await tx('readonly', s => req(s.index('user').getAll(me())));
          for (const r of rows || []) { if (mem.has(r.id)) continue; const st = ['uploading', 'saving', 'uploaded', 'signin', 'memory'].includes(r.status) ? 'local' : r.status; mem.set(r.id, { ...r, status: st, durable: true }); }
        } catch (_) {}
        for (const e of mem.values()) emit(e);
        return api.list();
      },
      list(findingId) { return [...mem.values()].filter(e => e.user === me() && (findingId == null || String(e.findingId) === String(findingId))).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))); },
      get: id => mem.get(id) || null,
      // Queue one photo (already prepared/compressed). Resolves once the device copy is written (or known to have failed).
      async add({ findingId, workOrderId, blob, name = 'finding-photo.jpg', caption = '', kind = '', component = '', meta = {} }) {
        if (!me()) throw new Error('Sign in first.');
        const e = { id: uid(), user: me(), findingId: String(findingId), workOrderId: String(workOrderId), blob, name, type: blob?.type || 'image/jpeg', size: blob?.size || 0, caption: String(caption || '').slice(0, 300), kind, component: String(component || '').slice(0, 80), meta, status: 'saving', attempts: 0, error: '', createdAt: new Date().toISOString(), durable: false };
        mem.set(e.id, e); emit(e);
        try { await persist(e); set(e, { status: 'local', durable: true }); }
        catch (err) { set(e, { status: 'memory', durable: false, error: String(err?.message || err) }); }
        api.process();
        return e;
      },
      // Send everything that is waiting, one photo at a time.
      async process() {
        if (busy) { again = true; return; }
        if (!online() || !me()) return;
        busy = true;
        try {
          do {
            again = false;
            for (const e of api.list()) {
              if (!['local', 'memory', 'failed'].includes(e.status)) continue;
              if (!online()) break;
              if (!e.blob && e.durable) { try { const row = await tx('readonly', s => req(s.get(e.id))); e.blob = row?.blob; } catch (_) {} }
              if (!e.blob) { set(e, { status: 'failed', error: 'The photo is no longer on this device.' }); continue; }
              set(e, { status: 'uploading', attempts: (e.attempts || 0) + 1, error: '' });
              try {
                const res = await upload(e);
                if (e.user !== me()) { set(e, { status: e.durable ? 'local' : 'memory' }); continue; } // account changed meanwhile
                set(e, { status: 'uploaded', photoId: res?.photoId || res?.photo?.id || '', photo: res?.photo || null, error: '' });
                if (e.durable) await drop(e.id);
                e.blob = null; attempt = 0;
              } catch (err) {
                const st = Number(err?.status || 0);
                if (st === 401) { set(e, { status: 'signin', error: 'Sign in again to upload.' }); continue; }
                if (st >= 400 && st < 500 && ![408, 425, 429].includes(st)) { set(e, { status: 'refused', error: String(err?.message || `Upload refused (${st})`) }); if (e.durable) persist(e).catch(() => {}); continue; }
                set(e, { status: 'failed', error: String(err?.message || 'Upload failed') }); if (e.durable) persist(e).catch(() => {});
              }
            }
          } while (again && online());
        } finally { busy = false; }
        if (api.list().some(e => e.status === 'failed') && online()) { clearTimeout(retryTimer); const ms = [5000, 15000, 30000, 60000][Math.min(attempt++, 3)]; retryTimer = setTimeout(() => api.process(), ms); }
      },
      async retry(id) { const e = mem.get(id); if (!e || e.user !== me()) return; if (['failed', 'refused', 'signin', 'memory', 'local'].includes(e.status)) { set(e, { status: e.durable ? 'local' : 'memory', error: '' }); } return api.process(); },
      async remove(id) { const e = mem.get(id); if (!e || e.user !== me()) return; mem.delete(id); if (e.durable) await drop(id); emit({ ...e, status: 'removed' }); },
      forgetUploaded() { for (const [k, e] of mem) if (e.status === 'uploaded') mem.delete(k); },
      // Account ended: stop retrying. Device copies stay (they belong to that account) and are only listed for it.
      signedOut() { clearTimeout(retryTimer); },
      // After signing in again, photos that were waiting for it go back in line.
      resumeSignin() { for (const e of api.list()) if (e.status === 'signin') set(e, { status: e.durable ? 'local' : 'memory', error: '' }); return api.process(); },
      pendingCount() { return api.list().filter(e => e.status !== 'uploaded').length; },
    };
    window.addEventListener('online', () => api.process());
    return api;
  }
  window.ITTRPhotoQueueFactory = { create };
})();
