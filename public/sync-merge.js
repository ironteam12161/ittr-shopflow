// v24.66.0: when two devices save the shop record at the same moment, the second save used to be dropped and the
// person had to redo their change. Now the change is replayed on top of the newer server copy, one work order /
// finding at a time: whatever this device changed (added, edited, deleted) since its last sync is applied to the
// newest data. Only a record that BOTH devices changed keeps the other device's version and is reported back.
// v24.67.0: the change itself is a small, storable "change set" (each changed record with its value before and
// after), so a queued offline edit can be replayed after a reload without the original copy of the shop record.
(function (root) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const idOf = x => (x && typeof x === 'object' && x.id != null && String(x.id) !== '') ? String(x.id) : '';
  const isIdList = v => Array.isArray(v) && v.every(x => idOf(x));
  const byId = list => { const m = new Map(); for (const x of Array.isArray(list) ? list : []) { const id = idOf(x); if (id) m.set(id, x); } return m; };

  // Changes from base to local: [{k, id?, hb, b, hl, l}] (hb/hl: the record existed before/after; id: a record in a
  // list of records with ids, such as work orders). Keys/records that did not change are not listed.
  function diffState(base, local) {
    base = isObj(base) ? base : {}; local = isObj(local) ? local : {};
    const out = [];
    for (const k of new Set([...Object.keys(base), ...Object.keys(local)])) {
      const bv = base[k], lv = local[k];
      if ((bv === undefined || isIdList(bv)) && (lv === undefined || isIdList(lv)) && (bv !== undefined || lv !== undefined) && (Array.isArray(bv) || Array.isArray(lv))) {
        const b = byId(bv), l = byId(lv);
        for (const id of new Set([...b.keys(), ...l.keys()])) {
          const x = b.get(id), y = l.get(id);
          if (!same(x, y)) out.push({ k, id, hb: x !== undefined, b: x, hl: y !== undefined, l: y });
        }
        // A list that appeared or disappeared as a whole (e.g. [] -> missing) is a key change too.
        if ((bv === undefined) !== (lv === undefined) && !b.size && !l.size) out.push({ k, hb: bv !== undefined, b: bv, hl: lv !== undefined, l: lv });
        continue;
      }
      if (!same(bv, lv)) out.push({ k, hb: bv !== undefined, b: bv, hl: lv !== undefined, l: lv });
    }
    return out;
  }

  // Apply a change set on top of the newest copy. A record the other side did not touch takes this device's value;
  // a record the other side changed differently is a conflict: the newest copy wins and the record is reported.
  function applyChanges(remote, changes) {
    remote = isObj(remote) ? remote : {};
    const payload = { ...remote }, conflicts = [], lost = [];
    const lists = new Map();
    for (const c of Array.isArray(changes) ? changes : []) {
      if (!c || typeof c.k !== 'string') continue;
      if (c.id != null) { if (!lists.has(c.k)) lists.set(c.k, []); lists.get(c.k).push(c); continue; }
      const rv = remote[c.k], has = rv !== undefined;
      const baseMatch = has === !!c.hb && (!has || same(rv, c.b)), localMatch = has === !!c.hl && (!has || same(rv, c.l));
      if (localMatch) continue;
      if (baseMatch) { if (c.hl) payload[c.k] = c.l; else delete payload[c.k]; continue; }
      conflicts.push(c.k); lost.push(c);
    }
    for (const [k, list] of lists) {
      const rl = Array.isArray(remote[k]) ? remote[k] : [], r = byId(rl), decide = new Map(), adds = [];
      for (const c of list) {
        const id = String(c.id), rv = r.get(id), has = rv !== undefined;
        const baseMatch = has === !!c.hb && (!has || same(rv, c.b)), localMatch = has === !!c.hl && (!has || same(rv, c.l));
        if (localMatch) continue;
        if (baseMatch) { if (has) decide.set(id, c.hl ? c.l : null); else if (c.hl) adds.push(c.l); continue; }
        conflicts.push(`${k === 'workorders' ? 'Work order' : k === 'issues' ? 'Finding' : k} ${id}`); lost.push(c);
      }
      if (!decide.size && !adds.length) continue;
      const next = [];
      for (const x of rl) { const id = idOf(x); if (id && decide.has(id)) { const v = decide.get(id); if (v !== null) next.push(v); } else next.push(x); }
      payload[k] = next.concat(adds);
    }
    return { payload, conflicts, lost, changed: !same(payload, remote) };
  }

  function rebaseShopflow(base, local, remote) {
    const out = applyChanges(remote, diffState(base, local));
    return { payload: out.payload, conflicts: out.conflicts, lost: out.lost, changed: out.changed };
  }

  root.ittrSyncMerge = { diffState, applyChanges, rebaseShopflow, same };
  root.ittrRebaseShopflow = rebaseShopflow;
})(typeof window !== 'undefined' ? window : globalThis);
