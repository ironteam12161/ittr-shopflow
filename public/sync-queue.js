// v24.67.0: offline / pending saves for the shared records (shop, users, operations).
//
// Every edit is kept on this device as a CHANGE SET against the last copy the server confirmed (sync-merge.js), per
// signed-in account. A save is sent with the server version it was based on; if another device saved first, the
// change set is replayed on top of the newest copy and sent again. Queued changes are removed only after the server
// confirmed a save that contains them, and only if no newer edit was queued meanwhile. After a reload the queued
// change set is applied to the freshly loaded copy (the person sees their edit again) and then saved.
// The page wires it in public/index.html; the tests drive the same engine (sync_queue_integration_test.mjs).
(function (root) {
  const QUEUE_PREFIX = 'ittr_sync_queue_v3:', LEGACY_KEY = 'ittr_sync_queue_v2', ARCHIVE_PREFIX = 'ittr_sync_archive_v1:';
  const MAX_CONFLICT_ROUNDS = 4, RETRY_MS = [2000, 5000, 15000, 30000, 60000];

  function createSyncEngine(o) {
    const M = o.merge || root.ittrSyncMerge;
    const timers = { set: o.setTimeout || ((f, ms) => setTimeout(f, ms)), clear: o.clearTimeout || (t => clearTimeout(t)) };
    const tab = o.tabId || Math.random().toString(36).slice(2, 10);
    let gen = 0;
    const bases = {}, flights = {}, again = {}, debounce = {}, retry = {}, errors = {};
    const user = () => String(o.user() || '').toLowerCase();
    const qKey = u => QUEUE_PREFIX + u;
    const rev = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const readQ = (u = user()) => { if (!u) return {}; try { const q = JSON.parse(o.storage.getItem(qKey(u)) || '{}'); return q && typeof q === 'object' ? q : {}; } catch (_) { return {}; } };
    // Storage full or blocked (private mode): the save still goes to the server; the status says the copy on this
    // device could not be kept, so a reload before it is saved would lose it.
    const writeQ = (q, u = user()) => { if (!u) return; try { if (Object.keys(q).length) o.storage.setItem(qKey(u), JSON.stringify(q)); else o.storage.removeItem(qKey(u)); if (errors._storage) delete errors._storage; } catch (e) { errors._storage = { kind: 'storage', message: 'This device could not keep a copy of the unsaved change (storage full or blocked).' }; } };
    const readItem = key => readQ()[key] || null;
    const writeItem = (key, item) => { const q = readQ(); if (item) q[key] = item; else delete q[key]; writeQ(q); };
    const live = key => o.getLive(key);
    const status = () => { try { o.onStatus?.(api.status()); } catch (_) {} };
    const stale = (g, u) => g !== gen || u !== user();

    function archive(kind, info, owner = user()) {
      const u = owner; if (!u) return;
      try {
        const k = ARCHIVE_PREFIX + u; let a = []; try { a = JSON.parse(o.storage.getItem(k) || '[]'); } catch (_) { a = []; }
        if (!Array.isArray(a)) a = [];
        a.push({ at: new Date().toISOString(), kind, ...info }); while (a.length > 20) a.shift();
        o.storage.setItem(k, JSON.stringify(a));
      } catch (_) {}
    }

    // The copy the server confirmed for this device (what change sets are computed against).
    function setBase(key, payload, version) {
      const json = JSON.stringify(payload ?? null);
      bases[key] = { json, obj: JSON.parse(json), version: Number(version || 0) };
    }

    // Write the current edits (live vs confirmed copy) to the queue. Returns the queue item (or null: nothing pending).
    function persist(key) {
      const b = bases[key]; if (!b || !user()) return readItem(key);
      const changes = M.diffState(b.obj, live(key));
      if (!changes.length) { writeItem(key, null); return null; }
      const prev = readItem(key);
      const item = { v: 3, user: user(), key, rev: rev(), tab, baseVersion: b.version, changes, queuedAt: prev?.queuedAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
      writeItem(key, item); o.onQueued?.(key);
      return item;
    }

    function schedule(key, ms = 180) {
      if (debounce[key]) timers.clear(debounce[key]);
      debounce[key] = timers.set(() => { debounce[key] = null; api.sync(key); }, ms);
    }
    function scheduleRetry(key) {
      const r = retry[key] || (retry[key] = { n: 0, t: null });
      if (r.t) timers.clear(r.t);
      const ms = RETRY_MS[Math.min(r.n, RETRY_MS.length - 1)]; r.n++;
      r.t = timers.set(() => { r.t = null; api.sync(key); }, ms);
    }
    function clearRetry(key) { const r = retry[key]; if (r?.t) timers.clear(r.t); delete retry[key]; delete errors[key]; }

    function reportConflicts(key, lost, conflicts) {
      if (!conflicts.length) return;
      archive('conflict', { key, records: lost.slice(0, 20).map(c => ({ k: c.k, id: c.id ?? null, mine: c.hl ? c.l : null })) });
      try { o.onConflicts?.(key, conflicts); } catch (_) {}
    }

    // Saved: confirmed copy moves forward; edits made while the save was in flight are kept and queued again.
    function finish(key, item, saved, version, sentLiveJson, fast, conflicts, lost) {
      setBase(key, saved, version); o.setServerVersion?.(key, version);
      const now = live(key), nowJson = JSON.stringify(now);
      if (nowJson === sentLiveJson) {
        if (!fast) o.setLive(key, JSON.parse(bases[key].json), { reason: 'merged' });
        const cur = readItem(key);
        if (cur && cur.rev === item.rev) writeItem(key, null);
        else if (cur && cur.tab === tab) persist(key);
        // A newer item written by another tab of this account stays: it is replayed on its own.
      } else {
        const during = M.diffState(JSON.parse(sentLiveJson), now);
        if (!fast) { const out = M.applyChanges(JSON.parse(bases[key].json), during); o.setLive(key, out.payload, { reason: 'merged' }); conflicts = conflicts.concat(out.conflicts); lost = lost.concat(out.lost); }
        persist(key); again[key] = true;
      }
      clearRetry(key);
      reportConflicts(key, lost, conflicts);
    }

    async function syncOnce(key) {
      const g = gen, u = user();
      if (!u) return;
      let item = bases[key] ? persist(key) : readItem(key);
      if (!item) { clearRetry(key); return; }
      if (!o.online()) { errors[key] = { kind: 'offline' }; return; }
      if (item.user && item.user !== u) return; // never another account's change
      for (let round = 0; round < MAX_CONFLICT_ROUNDS; round++) {
        const b = bases[key], sentLiveJson = JSON.stringify(live(key));
        // The change set is taken at the same moment as the copy that is sent, so nothing typed in between is skipped.
        if (b) { item = persist(key); if (!item) { clearRetry(key); return; } }
        let json, expected, fast = false, conflicts = [], lost = [], merged = null;
        if (round === 0 && b && b.version === item.baseVersion && Number(o.serverVersion?.(key) ?? b.version) === b.version && b.version > 0) {
          json = sentLiveJson; expected = b.version; fast = true;
        } else {
          let st;
          try { st = await o.fetchState(); } catch (e) { if (stale(g, u)) return; return fail(key, e); }
          if (stale(g, u)) return;
          const remote = st?.[key]; if (!remote) return fail(key, Object.assign(new Error('The server copy is not available.'), { status: 503 }));
          const out = M.applyChanges(remote.payload, item.changes);
          conflicts = out.conflicts; lost = out.lost; merged = out.payload;
          if (!out.changed) { finish(key, item, remote.payload, remote.version, sentLiveJson, false, conflicts, lost); return; }
          json = JSON.stringify(merged); expected = Number(remote.version);
        }
        try {
          const r = await o.put(key, json, expected);
          if (stale(g, u)) return;
          finish(key, item, fast ? JSON.parse(json) : merged, r.version, sentLiveJson, fast, conflicts, lost);
          return;
        } catch (e) {
          if (stale(g, u)) return;
          if (e?.code === 'STATE_VERSION_CONFLICT' || e?.code === 'STATE_VERSION_REQUIRED') continue;
          return fail(key, e);
        }
      }
      errors[key] = { kind: 'busy', message: 'Other devices kept saving at the same time.' };
      scheduleRetry(key);
      try { o.onNotice?.('retrying', { key }); } catch (_) {}
    }

    function fail(key, e) {
      const st = Number(e?.status || 0);
      if (st === 401) { errors[key] = { kind: 'signed-out', message: 'Sign in again to save.' }; return; }
      if (st >= 400 && st < 500 && ![408, 409, 425, 429].includes(st)) {
        // The server refused this change for good (permission, bad data): set it aside on this device and say so.
        const item = readItem(key); if (item) archive('refused', { key, status: st, error: String(e?.message || ''), item });
        writeItem(key, null); clearRetry(key);
        try { o.onNotice?.('refused', { key, message: String(e?.message || 'The server refused this change.') }); } catch (_) {}
        return;
      }
      errors[key] = { kind: o.online() ? 'retrying' : 'offline', message: String(e?.message || 'Network error') };
      scheduleRetry(key);
    }

    const api = {
      tab, setBase, persist, schedule,
      base: key => bases[key] ? { version: bases[key].version, json: bases[key].json } : null,
      item: key => readItem(key),
      queue: () => readQ(),
      hasPending: key => !!readItem(key) || !!flights[key] || !!debounce[key],
      status() {
        const q = readQ(), keys = new Set([...Object.keys(q), ...Object.keys(flights).filter(k => flights[k])]);
        const errs = Object.values(errors);
        return { pending: keys.size, syncing: Object.values(flights).some(Boolean), offline: !o.online(), error: errs.find(x => x.kind !== 'offline') || null, keys: [...keys] };
      },
      // An edit happened: queue it now (survives a reload) and save shortly.
      changed(key, ms) { persist(key); status(); if (o.online()) schedule(key, ms); },
      sync(key) {
        if (flights[key]) { again[key] = true; return flights[key]; }
        if (debounce[key]) { timers.clear(debounce[key]); debounce[key] = null; }
        const g = gen;
        flights[key] = (async () => {
          try { do { again[key] = false; await syncOnce(key); } while (again[key] && g === gen); }
          catch (e) { if (g === gen) fail(key, e); }
          finally { flights[key] = null; status(); }
        })();
        status();
        return flights[key];
      },
      async syncAll() { for (const k of Object.keys(readQ())) await api.sync(k); },
      async idle() { while (Object.values(flights).some(Boolean) || Object.values(debounce).some(Boolean)) await Promise.all(Object.values(flights).filter(Boolean).concat(new Promise(r => timers.set(r, 50)))); },
      // Versions of the server copy a pre-v24.67.0 queued edit was based on (fetched before restore()).
      legacyNeeds(fresh) {
        try { const old = JSON.parse(o.storage.getItem(LEGACY_KEY) || '{}') || {}; return Object.entries(old).filter(([k, it]) => Number(it?.baseVersion) > 0 && fresh?.[k] && Number(it.baseVersion) !== Number(fresh[k].version)).map(([key, it]) => ({ key, version: Number(it.baseVersion) })); } catch (_) { return []; }
      },
      // After sign-in: the fresh server copies become the confirmed copies, queued edits of THIS account are put back
      // on top (conflicting records keep the server's version and are reported), then saved.
      restore(fresh, { legacyOwner = false, legacyBase } = {}) {
        const u = user(); if (!u) return { restored: [], quarantined: 0 };
        for (const k of Object.keys(fresh || {})) if (fresh[k]) setBase(k, fresh[k].payload, fresh[k].version);
        let quarantined = 0;
        // Queue from before v24.67.0: one shared, whole-record copy with no account. Only the account that was
        // already signed in on this tab may take it over, and only when its base copy is known.
        try {
          const raw = o.storage.getItem(LEGACY_KEY);
          if (raw) {
            let old = {}; try { old = JSON.parse(raw) || {}; } catch (_) { old = {}; }
            for (const [key, it] of Object.entries(old)) {
              const remote = fresh?.[key], baseCopy = it && Number(it.baseVersion) > 0 ? (Number(it.baseVersion) === Number(remote?.version) ? remote.payload : legacyBase?.[key]?.[Number(it.baseVersion)]) : undefined;
              if (legacyOwner && remote && baseCopy !== undefined && o.allowKey?.(key) !== false) {
                const changes = M.diffState(baseCopy, it.payload);
                if (changes.length) { const q = readQ(); q[key] = { v: 3, user: u, key, rev: rev(), tab, baseVersion: Number(it.baseVersion), changes, queuedAt: it.queuedAt || new Date().toISOString(), updatedAt: new Date().toISOString(), migrated: true }; writeQ(q); }
              } else { archive('legacy', { key, item: it }, '_unowned'); quarantined++; }
            }
            o.storage.removeItem(LEGACY_KEY);
          }
        } catch (_) {}
        const restored = [];
        for (const [key, item] of Object.entries(readQ())) {
          if (!item || item.v !== 3 || (item.user && item.user !== u) || !Array.isArray(item.changes) || (o.allowKey && !o.allowKey(key))) { archive('unusable', { key, item }); writeItem(key, null); continue; }
          const remote = fresh?.[key]; if (!remote) continue;
          const out = M.applyChanges(remote.payload, item.changes);
          o.setLive(key, out.payload, { reason: 'restored' });
          reportConflicts(key, out.lost, out.conflicts);
          persist(key); restored.push(key);
        }
        status();
        return { restored, quarantined };
      },
      // Sign-out / account switch: stop everything; late answers are ignored. Queued edits stay with their account.
      reset() {
        gen++;
        for (const k of Object.keys(debounce)) { if (debounce[k]) timers.clear(debounce[k]); delete debounce[k]; }
        for (const k of Object.keys(retry)) clearRetry(k);
        for (const k of Object.keys(bases)) delete bases[k];
        for (const k of Object.keys(flights)) flights[k] = null;
        for (const k of Object.keys(errors)) delete errors[k];
        status();
      },
      archived: () => { try { return JSON.parse(o.storage.getItem(ARCHIVE_PREFIX + user()) || '[]'); } catch (_) { return []; } },
    };
    return api;
  }

  root.ittrCreateSyncEngine = createSyncEngine;
  root.ittrSyncQueueKeys = { QUEUE_PREFIX, LEGACY_KEY, ARCHIVE_PREFIX };
})(typeof window !== 'undefined' ? window : globalThis);
