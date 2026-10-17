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

  // v24.73.0: three-way merge of ONE record that both sides changed (base b, this device l, newest copy r). Fields and
  // child items that only one side changed are combined, so a mechanic's note and the office's priority on the same
  // work order both survive, and two mechanics on different jobs (tasks by uid) or inspection items (results by item id)
  // do not conflict. Only the same value changed differently on both sides is a conflict: the newest copy keeps it and
  // its path is reported. Returns {value, conflicts:[path...]}.
  const keyOf = x => (x && typeof x === 'object') ? (x.uid != null && String(x.uid) !== '' ? 'u:' + x.uid : (x.id != null && String(x.id) !== '' ? 'i:' + x.id : '')) : '';
  const isKeyedList = v => Array.isArray(v) && v.length > 0 && v.every(x => keyOf(x)) && new Set(v.map(keyOf)).size === v.length;
  function merge3(b, l, r, path = '') {
    if (same(l, b)) return { value: r, conflicts: [] };
    if (same(r, b) || same(l, r)) return { value: l, conflicts: [] };
    if (isObj(b) && isObj(l) && isObj(r)) {
      const out = { ...r }, conflicts = [];
      for (const k of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
        const hb = k in b, hl = k in l, hr = k in r;
        if (hl === hb && (!hl || same(l[k], b[k]))) continue;          // this device did not touch k
        if (hr === hb && (!hr || same(r[k], b[k]))) { if (hl) out[k] = l[k]; else delete out[k]; continue; } // only this device did
        if (hl && hr) { const m = merge3(hb ? b[k] : undefined, l[k], r[k], path ? `${path}.${k}` : k); out[k] = m.value; conflicts.push(...m.conflicts); continue; }
        if (hl === hr && (!hl || same(l[k], r[k]))) continue;
        conflicts.push(path ? `${path}.${k}` : k);                     // removed on one side, changed on the other: keep newest
      }
      return { value: out, conflicts };
    }
    const lists = [b, l, r].filter(Array.isArray);
    if (lists.length === 3 && [b, l, r].every(v => v.length === 0 || isKeyedList(v))) {
      const B = new Map(b.map(x => [keyOf(x), x])), L = new Map(l.map(x => [keyOf(x), x])), Rm = new Map(r.map(x => [keyOf(x), x]));
      const out = [], conflicts = [];
      for (const x of r) {
        const k = keyOf(x), inB = B.has(k), inL = L.has(k);
        if (!inL && inB) { if (same(x, B.get(k))) continue; conflicts.push(`${path}[${k.slice(2)}]`); out.push(x); continue; } // removed here, edited there
        if (!inL) { out.push(x); continue; }                                                                         // added there
        const m = merge3(inB ? B.get(k) : undefined, L.get(k), x, `${path}[${k.slice(2)}]`); out.push(m.value); conflicts.push(...m.conflicts);
      }
      for (const x of l) { const k = keyOf(x); if (!Rm.has(k) && !B.has(k)) out.push(x); }                           // added here
      for (const x of l) { const k = keyOf(x); if (!Rm.has(k) && B.has(k) && !same(x, B.get(k))) conflicts.push(`${path}[${k.slice(2)}]`); } // edited here, removed there
      return { value: out, conflicts };
    }
    return { value: r, conflicts: [path || '(value)'] };
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
        const label = `${k === 'workorders' ? 'Work order' : k === 'issues' ? 'Finding' : k} ${id}`;
        // Both sides changed this record: combine what each changed; only the same field changed both ways conflicts.
        if (c.hb && c.hl && has && isObj(c.b) && isObj(c.l) && isObj(rv)) {
          const m = merge3(c.b, c.l, rv);
          decide.set(id, m.value);
          if (m.conflicts.length) { conflicts.push(`${label} (${m.conflicts.slice(0, 3).join(', ')})`); lost.push({ ...c, fields: m.conflicts }); }
          continue;
        }
        conflicts.push(label); lost.push(c);
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

  root.ittrSyncMerge = { diffState, applyChanges, rebaseShopflow, same, merge3 };
  root.ittrRebaseShopflow = rebaseShopflow;
})(typeof window !== 'undefined' ? window : globalThis);
