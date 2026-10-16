// v24.67.0: pending-save queue (public/sync-queue.js) against a real server and disposable database.
// Each "device" is the real engine the page uses, with its own storage (localStorage stand-in), live copy and token.
import { dbSuiteGuard, startTestServer, ok, eq, sleep } from './test_harness.mjs';
dbSuiteGuard('sync queue integration');
await import('./public/sync-merge.js'); await import('./public/sync-queue.js');
const createEngine = globalThis.ittrCreateSyncEngine, KEYS = globalThis.ittrSyncQueueKeys;

const srv = await startTestServer({ prefix: 'ittr_syncq' });
const memStorage = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), keys: () => [...m.keys()] }; };
const clean = st => { const o = { ...st }; delete o.status; return o; };
const wo = (id, x = {}) => ({ id: String(id), unit: `U${id}`, customer: 'Test Fleet', status: 'Open', mechanic: 'mech1', tasks: [{ uid: `t${id}`, t: 'PM service', done: false }], ...x });
const find = (sf, id) => (sf.workorders || []).find(w => String(w.id) === String(id));

function device({ storage, user, token, hooks = {} }) {
  const dev = { live: {}, versions: {}, online: true, user, token, conflicts: [], notices: [], puts: 0 };
  dev.engine = createEngine({
    storage, user: () => dev.user, online: () => dev.online,
    getLive: k => dev.live[k], setLive: (k, o) => { dev.live[k] = o; },
    serverVersion: k => dev.versions[k] || 0, setServerVersion: (k, v) => { dev.versions[k] = v; },
    allowKey: k => dev.role === 'mechanic' ? k === 'shopflow' : true,
    fetchState: async () => { if (hooks.fetch) await hooks.fetch(); return clean(await srv.request('/api/state', { token: dev.token })); },
    put: async (k, json, expected) => { dev.puts++; if (hooks.put) await hooks.put(k, json, expected, dev.puts); return srv.request(`/api/state/${k}`, { method: 'PUT', token: dev.token, raw: `{"payload":${json},"expectedVersion":${expected}}` }); },
    onConflicts: (k, list) => dev.conflicts.push(...list), onNotice: kind => dev.notices.push(kind),
  });
  dev.load = async ({ legacyOwner = false } = {}) => {
    const fresh = clean(await srv.request('/api/state', { token: dev.token }));
    for (const k of Object.keys(fresh)) { dev.live[k] = JSON.parse(JSON.stringify(fresh[k].payload)); dev.versions[k] = fresh[k].version; }
    const legacyBase = {};
    for (const n of dev.engine.legacyNeeds(fresh)) { try { const h = await srv.request(`/api/state/${n.key}/version/${n.version}`, { token: dev.token }); (legacyBase[n.key] ||= {})[n.version] = h.payload; } catch (_) {} }
    return dev.engine.restore(fresh, { legacyOwner, legacyBase });
  };
  dev.edit = fn => { fn(dev.live.shopflow); dev.engine.changed('shopflow', 0); };
  dev.settle = async () => { await sleep(20); await dev.engine.idle(); };
  return dev;
}
async function server(token) { return (await srv.request('/api/state', { token })).shopflow; }
async function remoteEdit(token, fn) { const st = await server(token); fn(st.payload); await srv.request('/api/state/shopflow', { method: 'PUT', token, body: { payload: st.payload, expectedVersion: st.version } }); }

try {
  const owner = await srv.login('opsadmin', 'CI-Ops-Admin-2026!');
  await srv.request('/api/admin/users', { method: 'POST', token: owner, body: { username: 'mech1', display: 'Mech One', password: 'Mechanic-Pass-1' } });
  await srv.request('/api/admin/managers', { method: 'POST', token: owner, body: { username: 'mgr1', display: 'Manager One', password: 'Manager-Pass-2026', permissions: { invoices: true } } });
  const mgr = await srv.login('mgr1', 'Manager-Pass-2026');
  const reset = async () => remoteEdit(owner, sf => { sf.workorders = [1, 2, 3, 4, 5].map(i => wo(i)); sf.issues = []; });
  await reset();

  // ---------------------------------------------------------------- offline edit → reload → remote edit → reconnect
  {
    const storage = memStorage();
    const A = device({ storage, user: 'opsadmin', token: owner }); await A.load();
    A.online = false; A.edit(sf => { find(sf, 1).complaint = 'A-OFFLINE'; }); await A.settle();
    ok(A.engine.item('shopflow')?.changes?.length === 1, 'the offline edit is queued as a change set');
    eq(find((await server(owner)).payload, 1).complaint, undefined, 'nothing reached the server while offline');
    // Reload: a new page (new engine) on the same device storage, online again, while another device saved meanwhile.
    await remoteEdit(owner, sf => { find(sf, 2).complaint = 'REMOTE'; });
    const A2 = device({ storage, user: 'opsadmin', token: owner });
    const back = await A2.load();
    ok(back.restored.includes('shopflow') && find(A2.live.shopflow, 1).complaint === 'A-OFFLINE', 'after the reload the queued edit is shown again on top of the fresh copy');
    await A2.engine.syncAll(); await A2.settle();
    const s = (await server(owner)).payload;
    eq(find(s, 1).complaint, 'A-OFFLINE', 'the offline edit is saved after the reload'); eq(find(s, 2).complaint, 'REMOTE', 'and the other device\'s edit is kept');
    eq(A2.engine.item('shopflow'), null, 'queue empty only after the save'); eq(A2.conflicts.length, 0, 'no conflict for different work orders');
  }
  console.log('PASS offline edit → reload → remote edit → reconnect: edit kept and saved, other device\'s edit kept');

  // ---------------------------------------------------------------- independent work orders, same open page
  await reset();
  {
    const A = device({ storage: memStorage(), user: 'opsadmin', token: owner }); await A.load();
    await remoteEdit(owner, sf => { find(sf, 2).priority = 'High'; sf.workorders.push(wo(6)); });
    A.edit(sf => { find(sf, 3).status = 'In Progress'; sf.workorders = sf.workorders.filter(w => w.id !== '5'); sf.workorders.push(wo(7)); }); await A.settle();
    const s = (await server(owner)).payload;
    ok(find(s, 3).status === 'In Progress' && find(s, 2).priority === 'High' && find(s, 6) && find(s, 7) && !find(s, 5), 'edits, adds and deletes from both devices are merged');
    eq(A.engine.item('shopflow'), null, 'queue empty'); ok(find(A.live.shopflow, 2).priority === 'High', 'this device now shows the other device\'s edit');
  }
  console.log('PASS independent work orders: edit/add/delete from both devices merged on version conflict');

  // ---------------------------------------------------------------- same record changed on both devices
  await reset();
  {
    const A = device({ storage: memStorage(), user: 'opsadmin', token: owner }); await A.load();
    await remoteEdit(owner, sf => { find(sf, 1).complaint = 'THEIRS'; });
    A.edit(sf => { find(sf, 1).complaint = 'MINE'; find(sf, 3).complaint = 'MINE-3'; }); await A.settle();
    const s = (await server(owner)).payload;
    eq(find(s, 1).complaint, 'THEIRS', 'same work order: the version already saved is kept'); eq(find(s, 3).complaint, 'MINE-3', 'an unrelated change in the same save is not lost');
    ok(A.conflicts.includes('Work order 1'), 'the conflict is reported (warning shown)');
    const arc = A.engine.archived().find(x => x.kind === 'conflict'); ok(arc && JSON.stringify(arc).includes('MINE'), 'this device\'s version of the conflicting work order is kept in the device archive');
    eq(A.engine.item('shopflow'), null, 'queue empty after the explicit resolution');
  }
  console.log('PASS same-record conflict: other device\'s version kept and reported, unrelated change saved, mine archived');

  // ---------------------------------------------------------------- edits made while a save is in flight
  await reset();
  {
    let release, gate = new Promise(r => { release = r; }), queuedAtSecondSave = null;
    const storage = memStorage();
    const A = device({ storage, user: 'opsadmin', token: owner, hooks: { put: async (k, json, exp, n) => { if (n === 2) queuedAtSecondSave = storage.getItem(KEYS.QUEUE_PREFIX + 'opsadmin'); if (n === 1) await gate; } } });
    await A.load();
    A.edit(sf => { find(sf, 1).complaint = 'FIRST'; });
    await sleep(30); ok(A.puts === 1, 'first save in flight');
    A.edit(sf => { find(sf, 1).complaint = 'FIRST+MORE'; find(sf, 4).complaint = 'DURING'; });
    ok(JSON.stringify(A.engine.item('shopflow').changes).includes('DURING'), 'the newer edit is queued while the first save is in flight');
    release(); await A.settle();
    const s = (await server(owner)).payload;
    eq(find(s, 1).complaint, 'FIRST+MORE', 'a record edited again during the save ends up with the newest value'); eq(find(s, 4).complaint, 'DURING', 'a record edited during the save is saved too');
    ok(A.puts >= 2 && String(queuedAtSecondSave).includes('DURING') && JSON.parse(queuedAtSecondSave).shopflow.changes.find(c => c.id === '1')?.b?.complaint === 'FIRST', 'confirming the older save left the newer revision queued (rebased on the confirmed copy) and it was sent next');
    eq(A.engine.item('shopflow'), null, 'queue empty at the end');
  }
  console.log('PASS edits during an in-flight save: confirming the older save keeps the newer queued revision, which is then saved');

  // ---------------------------------------------------------------- repeated conflicts, then success
  await reset();
  {
    let contention = 6;
    const A = device({ storage: memStorage(), user: 'opsadmin', token: owner, hooks: { put: async () => { if (contention-- > 0) await remoteEdit(owner, sf => { find(sf, 5).complaint = `busy-${contention}`; }); } } });
    await A.load();
    A.edit(sf => { find(sf, 2).complaint = 'PERSISTENT'; }); await A.settle();
    ok(A.notices.includes('retrying'), 'after repeated conflicts the person is told it will retry');
    ok(A.engine.item('shopflow'), 'and the change is still queued'); eq(A.engine.status().error?.kind, 'busy', 'status says why');
    contention = 0; await A.engine.sync('shopflow'); await A.settle();
    eq(find((await server(owner)).payload, 2).complaint, 'PERSISTENT', 'saved once the other device stops'); eq(A.engine.item('shopflow'), null, 'queue empty');
  }
  console.log('PASS repeated conflicts: change kept with a retry status, saved when contention stops');

  // ---------------------------------------------------------------- failed retries (network / server down)
  await reset();
  {
    let failures = 2;
    const A = device({ storage: memStorage(), user: 'opsadmin', token: owner, hooks: { put: async () => { if (failures-- > 0) throw new TypeError('Failed to fetch'); } } });
    await A.load();
    A.edit(sf => { find(sf, 3).complaint = 'NETWORK'; }); await A.settle();
    ok(A.engine.item('shopflow') && A.engine.status().error?.kind === 'retrying', 'network failure: change kept, status "retrying"');
    await A.engine.sync('shopflow'); await A.settle(); ok(A.engine.item('shopflow'), 'second failure: still kept');
    await A.engine.sync('shopflow'); await A.settle();
    eq(find((await server(owner)).payload, 3).complaint, 'NETWORK', 'saved on the next retry'); eq(A.engine.item('shopflow'), null, 'queue empty'); eq(A.engine.status().error, null, 'status clear');
    // A refusal that will never succeed is set aside (archived) instead of retrying forever.
    const B = device({ storage: memStorage(), user: 'opsadmin', token: owner, hooks: { put: async () => { throw Object.assign(new Error('payload required'), { status: 400 }); } } });
    await B.load(); B.edit(sf => { find(sf, 4).complaint = 'REFUSED'; }); await B.settle();
    ok(B.notices.includes('refused') && !B.engine.item('shopflow') && B.engine.archived().some(x => x.kind === 'refused'), 'a refused change is archived on the device and the person is told');
  }
    // Device storage full: saving still works, nothing throws, and the status says the device copy was not kept.
    const full = { getItem: () => null, setItem: () => { throw Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' }); }, removeItem: () => {} };
    const C = device({ storage: full, user: 'opsadmin', token: owner }); await C.load();
    C.edit(sf => { find(sf, 5).complaint = 'STORAGE-FULL'; }); await C.settle();
    eq(find((await server(owner)).payload, 5).complaint, 'STORAGE-FULL', 'saved even though the device storage is full'); eq(C.engine.status().error?.kind, 'storage', 'status reports the storage problem');
  console.log('PASS failed retries: kept and retried after network errors; a permanent refusal is archived and reported; full device storage never blocks saving');

  // ---------------------------------------------------------------- pending changes stay with their account
  await reset();
  {
    const storage = memStorage();
    const A = device({ storage, user: 'opsadmin', token: owner }); await A.load();
    A.online = false; A.edit(sf => { find(sf, 1).complaint = 'OWNER-PENDING'; }); await A.settle();
    A.engine.reset();
    const M = device({ storage, user: 'mgr1', token: mgr }); await M.load(); await M.engine.syncAll(); await M.settle();
    eq(Object.keys(M.engine.queue()).length, 0, 'another account sees no pending change'); ok(find(M.live.shopflow, 1).complaint !== 'OWNER-PENDING', 'and the change is not applied to its screen');
    eq(find((await server(owner)).payload, 1).complaint, undefined, 'nor saved under the other account');
    const A3 = device({ storage, user: 'opsadmin', token: owner }); await A3.load(); await A3.engine.syncAll(); await A3.settle();
    eq(find((await server(owner)).payload, 1).complaint, 'OWNER-PENDING', 'the owner\'s change is saved when the owner signs in again');
  }
  console.log('PASS account isolation: queued changes are kept per account and replayed only for that account');

  // ---------------------------------------------------------------- queue saved by the previous app version (v2)
  await reset();
  {
    const before = await server(owner); const edited = JSON.parse(JSON.stringify(before.payload)); find(edited, 1).complaint = 'LEGACY-EDIT';
    await remoteEdit(owner, sf => { find(sf, 2).complaint = 'AFTER-LEGACY'; });
    const storage = memStorage(); storage.setItem(KEYS.LEGACY_KEY, JSON.stringify({ shopflow: { payload: edited, baseVersion: before.version, queuedAt: new Date().toISOString() } }));
    const A = device({ storage, user: 'opsadmin', token: owner }); await A.load({ legacyOwner: true }); await A.engine.syncAll(); await A.settle();
    const s = (await server(owner)).payload;
    ok(find(s, 1).complaint === 'LEGACY-EDIT' && find(s, 2).complaint === 'AFTER-LEGACY', 'old-format edit merged against its real starting version (from the server history)');
    eq(storage.getItem(KEYS.LEGACY_KEY), null, 'old queue removed after migration');
    // No owner known (fresh sign-in on a shared device): set aside, not applied.
    const st2 = memStorage(); st2.setItem(KEYS.LEGACY_KEY, JSON.stringify({ shopflow: { payload: { workorders: [] }, baseVersion: before.version } }));
    const B = device({ storage: st2, user: 'mgr1', token: mgr }); const r = await B.load({ legacyOwner: false }); await B.engine.syncAll(); await B.settle();
    ok(r.quarantined === 1 && JSON.parse(st2.getItem(KEYS.ARCHIVE_PREFIX + '_unowned') || '[]').length === 1, 'an old-format edit with no known account is archived, not applied');
    ok((await server(owner)).payload.workorders.length === 5, 'server data untouched');
    eq((await srv.request('/api/state/shopflow/version/1', { token: mgr, allowError: true })).status, 200, 'history endpoint answers managers');
    eq((await srv.request('/api/state/users/version/1', { token: mgr, allowError: true })).status, 403, 'users history is owner-only');
    eq((await srv.request('/api/state/shopflow/version/999999', { token: owner, allowError: true })).code, 'STATE_VERSION_UNAVAILABLE', 'an unknown version is reported as unavailable');
  }
  console.log('PASS old queue format: merged against the real base version when the account is known; archived otherwise');

  // ---------------------------------------------------------------- mechanic: offline edit of own work order
  await reset();
  {
    const mech = await srv.login('mech1', 'Mechanic-Pass-1'), storage = memStorage();
    const A = device({ storage, user: 'mech1', token: mech }); A.role = 'mechanic'; await A.load();
    A.online = false; A.edit(sf => { find(sf, 3).completionNotes = 'MECH-OFFLINE'; }); await A.settle();
    await remoteEdit(owner, sf => { find(sf, 4).priority = 'High'; });
    const A2 = device({ storage, user: 'mech1', token: mech }); A2.role = 'mechanic'; await A2.load(); await A2.engine.syncAll(); await A2.settle();
    const s = (await server(owner)).payload;
    ok(find(s, 3).completionNotes === 'MECH-OFFLINE' && find(s, 4).priority === 'High', 'mechanic\'s offline note saved after reload; office edit kept');
  }
  console.log('PASS mechanic offline edit → reload → reconnect');
  console.log('Sync queue integration: all scenarios passed');
} finally { await srv.cleanup(); }
