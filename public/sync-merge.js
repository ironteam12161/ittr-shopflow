// v24.66.0: when two devices save the shop record at the same moment, the second save used to be dropped and the
// person had to redo their change. Now the change is replayed on top of the newer server copy, one work order /
// finding at a time: whatever this device changed (added, edited, deleted) since its last sync is applied to the
// newest data. Only a work order that BOTH devices changed keeps the other device's version and is reported back.
(function (root) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const byId = list => { const m = new Map(); for (const x of Array.isArray(list) ? list : []) if (x && typeof x === 'object' && x.id != null && String(x.id) !== '') m.set(String(x.id), x); return m; };

  function mergeList(baseList, localList, remoteList, conflicts, label) {
    const b = byId(baseList), l = byId(localList), r = byId(remoteList);
    const out = [];
    const take = new Map();
    for (const id of new Set([...b.keys(), ...l.keys(), ...r.keys()])) {
      const bv = b.get(id), lv = l.get(id), rv = r.get(id);
      if (same(lv, bv)) { take.set(id, rv); continue; }        // not changed here: newest server copy wins
      if (same(rv, bv) || same(rv, lv)) { take.set(id, lv); continue; } // only changed here (or the same both ways)
      take.set(id, rv); conflicts.push(`${label} ${id}`);         // changed on both devices: keep the other device's
    }
    // Server order first, then the items this device added, in its own order.
    for (const x of Array.isArray(remoteList) ? remoteList : []) { const id = x && x.id != null ? String(x.id) : ''; if (!id) { out.push(x); continue; } if (take.get(id) !== undefined) { out.push(take.get(id)); take.delete(id); } }
    for (const x of Array.isArray(localList) ? localList : []) { const id = x && x.id != null ? String(x.id) : ''; if (id && take.get(id) !== undefined) { out.push(take.get(id)); take.delete(id); } }
    return out;
  }

  function rebaseShopflow(base, local, remote) {
    base = base && typeof base === 'object' ? base : {};
    local = local && typeof local === 'object' ? local : {};
    remote = remote && typeof remote === 'object' ? remote : {};
    const conflicts = [], payload = { ...remote };
    payload.workorders = mergeList(base.workorders, local.workorders, remote.workorders, conflicts, 'Work order');
    payload.issues = mergeList(base.issues, local.issues, remote.issues, conflicts, 'Finding');
    for (const k of new Set([...Object.keys(local), ...Object.keys(base)])) {
      if (k === 'workorders' || k === 'issues' || same(local[k], base[k])) continue;
      if (same(remote[k], base[k])) { if (local[k] === undefined) delete payload[k]; else payload[k] = local[k]; }
      else if (!same(remote[k], local[k])) conflicts.push(k);
    }
    return { payload, conflicts, changed: !same(payload, remote) };
  }

  root.ittrRebaseShopflow = rebaseShopflow;
})(typeof window !== 'undefined' ? window : globalThis);
