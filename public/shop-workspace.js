// ITTR ShopFlow v24.70.0 — office work-order page (#wo/<id>/<tab>), Repair Board (#board) and the findings approval
// lanes. Everything here reads the same shop record as the rest of the app; the only new stored fields are additive:
//   work order: qc {passedAt, by, notes}, blockers {parts|customer|sublet|hold: {on, by, at, note}}, releasedAt/By
//   finding:    officeReviewedAt/By, sentAt/By (sent to the customer for approval), taskUid/taskSnapshot (set by the mechanic)
// Stages are computed, never stored, so nothing can drift out of step with the work order itself.
// Mechanics cannot change the office fields: the server keeps them as they were on a mechanic's save (server.js).
(function () {
  'use strict';
  const E = s => esc(s), T = s => tr(s);
  const office = () => ['admin', 'manager'].includes(session?.role);
  const woById = id => (state.workorders || []).find(w => String(w.id) === String(id));
  const issuesFor = w => (state.issues || []).filter(i => String(i.wo) === String(w?.id));
  const when = v => { const d = new Date(v); return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  const ago = v => { const d = new Date(v); if (isNaN(d)) return ''; const m = Math.max(0, Math.round((Date.now() - d) / 60000)); return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
  const icon = (n, c = 'sm') => (typeof ittrIcon === 'function' ? ittrIcon(n, c) : '');
  const me = () => session?.username || '';
  const J = v => E(jsArg(v)); // id inside onclick="…" (see jsArg in index.html)

  // ------------------------------------------------------------------ stages, lanes, blockers
  const STAGES = [
    ['expected', 'Expected', 'Not here yet'], ['checkedin', 'Checked In', 'Here, work not started'], ['diagnosis', 'Diagnosis', 'Inspecting / finding problems'],
    ['approval', 'Approval', 'Waiting for a decision on findings'], ['repair', 'Repair', 'Jobs being worked'], ['qc', 'Quality Check', 'All jobs done, needs a check'], ['ready', 'Ready', 'Checked — ready to go'],
  ];
  const taskResolved = t => taskHasFinalDecision(t) || t?.findingDecision === 'Do Not Proceed';
  function findingLane(i) {
    const a = i.approval || 'Waiting for Customer';
    if (a === 'Do Not Proceed') return 'declined';
    if (a === 'Proceed') {
      if (!i.convertedToTask) return 'approved';
      const w = woById(i.wo), t = (w?.tasks || []).find(t => String(t.findingId ?? '') === String(i.id));
      return t && taskResolved(t) ? 'done' : 'job';
    }
    if (i.sentAt) return 'customer';
    if (i.officeReviewedAt) return 'review';
    return 'reported';
  }
  const LANES = [['reported', 'Reported'], ['review', 'Office Review'], ['customer', 'Customer Approval'], ['approved', 'Approved'], ['declined', 'Declined'], ['job', 'Job Created'], ['done', 'Completed']];
  function woStageOf(w) {
    if (!w) return 'expected';
    if (String(w.status) === 'Completed') return 'ready';
    if (!readyForMechanic(w)) return 'expected';
    const tasks = (w.tasks || []).filter(Boolean);
    if (tasks.length && tasks.every(taskResolved)) return w.qc?.passedAt ? 'ready' : 'qc';
    if (tasks.some(t => t.startedAt && !t.stoppedAt && !t.done)) return 'repair';
    if (issuesFor(w).some(i => ['reported', 'review', 'customer'].includes(findingLane(i)))) return 'approval';
    if (tasks.some(t => t.done || t.startedAt || Number(t.elapsedMs || 0) > 0) || String(w.status) === 'In Progress') return 'repair';
    if (w.inspection?.startedAt || issuesFor(w).length) return 'diagnosis';
    return 'checkedin';
  }
  // Open purchase orders per work order (server: /api/purchase-orders/open-by-work-order), refreshed at most every minute.
  const openPOs = { at: 0, byWo: new Map(), promise: null };
  function loadOpenPOs(force = false) {
    if (!office() || openPOs.promise || (!force && Date.now() - openPOs.at < 60000)) return;
    openPOs.promise = apiJSON('/api/purchase-orders/open-by-work-order').then(d => {
      const m = new Map(); for (const x of d?.items || []) { const k = String(x.workOrderId); (m.get(k) || m.set(k, []).get(k)).push(x); }
      openPOs.byWo = m;
    }).catch(() => {}).finally(() => { openPOs.at = Date.now(); openPOs.promise = null; if (currentView === 'board') renderBoard(); else if (currentView === 'wo') renderWs(); });
  }
  window.ittrOpenPOs = openPOs;
  const BLOCKERS = [['parts', 'Waiting on parts'], ['customer', 'Waiting on customer'], ['sublet', 'Waiting on sublet'], ['hold', 'On hold']];
  function woBlockers(w) {
    const b = w?.blockers && typeof w.blockers === 'object' ? w.blockers : {}, out = [];
    for (const [k, label] of BLOCKERS) if (b[k]?.on) out.push({ k, label, by: b[k].by, at: b[k].at, note: b[k].note || '' });
    // Parts on an open purchase order for this work order hold the truck up even when nobody set the flag.
    const pos = openPOs.byWo.get(String(w?.id)) || [];
    if (pos.length && !b.parts?.on) out.push({ k: 'parts', label: 'Waiting on parts', auto: true, at: '', note: pos.map(p => [p.poNumber, p.vendor, p.expectedDate && `${T('due')} ${String(p.expectedDate).slice(0, 10)}`].filter(Boolean).join(' · ') || T('Parts on order')).join('; ') });
    // Findings sent to the customer and not answered hold the truck up even when nobody set the flag.
    const sent = issuesFor(w).filter(i => findingLane(i) === 'customer');
    if (sent.length && !b.customer?.on) out.push({ k: 'customer', label: 'Waiting on customer', auto: true, at: sent.map(i => i.sentAt).sort()[0], note: `${sent.length} ${T(sent.length === 1 ? 'finding sent' : 'findings sent')}` });
    return out;
  }
  const blockerChip = x => `<span class="ds-chip ${x.k === 'hold' ? 'danger' : 'warn'}" title="${E([x.note, x.by && `${T('by')} ${mechanicDisplay(x.by)}`, x.at && when(x.at)].filter(Boolean).join(' · '))}">${icon(x.k === 'hold' ? 'lock' : 'alert')}${E(T(x.label))}${x.at ? ` · ${E(ago(x.at))}` : ''}</span>`;
  const stageChip = st => { const s = STAGES.find(x => x[0] === st) || STAGES[0], cls = { expected: '', checkedin: 'info', diagnosis: 'info', approval: 'warn', repair: 'info', qc: 'warn', ready: 'ok' }[st] || ''; return `<span class="ds-chip ${cls}">${E(T(s[1]))}</span>`; };
  const laneChip = l => { const x = LANES.find(y => y[0] === l) || LANES[0], cls = { reported: 'warn', review: 'info', customer: 'warn', approved: 'ok', declined: 'danger', job: 'info', done: 'ok' }[l]; return `<span class="ds-chip ${cls}">${E(T(x[1]))}</span>`; };
  Object.assign(window, { ittrWoStage: woStageOf, ittrFindingLane: findingLane, ittrWoBlockers: woBlockers });

  // ------------------------------------------------------------------ office actions (saved through the normal shop save)
  function change(fn) { if (!office()) return alert(T('Manager access required.')); fn(); save(); render(); }
  window.wsPassQc = id => change(() => { const w = woById(id); if (w) w.qc = { passedAt: new Date().toISOString(), by: me(), notes: '' }; });
  window.wsReopenQc = id => change(() => { const w = woById(id); if (w) w.qc = { passedAt: '', by: me(), notes: '', reopenedAt: new Date().toISOString() }; });
  window.wsRelease = id => { if (!confirm(T('Mark this truck as picked up? It leaves the board.'))) return; change(() => { const w = woById(id); if (w) { w.releasedAt = new Date().toISOString(); w.releasedBy = me(); } }); };
  window.wsToggleBlocker = (id, k) => {
    const w = woById(id); if (!w) return;
    const on = !w.blockers?.[k]?.on; let note = '';
    if (on && k === 'hold') { note = (prompt(T('Why is this truck on hold?')) || '').trim().slice(0, 200); if (!note) return; }
    if (on && k === 'sublet') note = (prompt(T('Which outside shop / what job? (optional)')) || '').trim().slice(0, 200);
    change(() => { w.blockers = { ...(w.blockers || {}), [k]: on ? { on: true, by: me(), at: new Date().toISOString(), note } : { on: false, by: me(), at: new Date().toISOString(), note: '' } }; });
  };
  window.wsMarkReviewed = id => change(() => { const i = (state.issues || []).find(x => String(x.id) === String(id)); if (i) { i.officeReviewedAt = new Date().toISOString(); i.officeReviewedBy = me(); } });
  window.wsUnreview = id => change(() => { const i = (state.issues || []).find(x => String(x.id) === String(id)); if (i) { i.officeReviewedAt = ''; i.officeReviewedBy = ''; i.sentAt = ''; i.sentBy = ''; } });
  // Sending uses the existing inspection link for the work order; once a link is made, the reviewed findings move on.
  window.wsSendToCustomer = woId => {
    const w = woById(woId); if (!w || !office()) return;
    if (typeof shareCustomerLink !== 'function') return alert(T('Customer links are not available.'));
    shareCustomerLink({ kind: 'inspection', refId: String(w.id), title: `Inspection report${w.unit ? ` for unit ${String(w.unit).replace(/'/g, '')}` : ''}`, onDone: () => {
      const now = new Date().toISOString(); let n = 0;
      for (const i of issuesFor(w)) if (['reported', 'review'].includes(findingLane(i))) { i.officeReviewedAt = i.officeReviewedAt || now; i.officeReviewedBy = i.officeReviewedBy || me(); i.sentAt = now; i.sentBy = me(); n++; }
      if (n) { save(); render(); }
    } });
  };
  window.wsDecide = (id, value) => setApproval(id, value);

  // ------------------------------------------------------------------ work-order page
  const TABS = [['jobs', 'Jobs'], ['findings', 'Findings'], ['photos', 'Photos'], ['inspection', 'Inspection'], ['time', 'Time'], ['billing', 'Billing']];
  window.openWoWorkspace = (id, tab) => {
    const w = woById(id); if (!w) return;
    const same = currentView === 'wo' && String(woWs.id) === String(w.id);
    woWs.id = String(w.id); if (tab) woWs.tab = tab; else if (!same) woWs.tab = 'jobs';
    if (same) { renderWs(); return; }
    showView('wo');
  };
  window.wsTab = tab => { woWs.tab = tab; try { history.replaceState({ ittr: true, view: 'wo', woId: woWs.id, woTab: tab }, '', `${location.pathname}${location.search}#wo/${encodeURIComponent(woWs.id)}/${tab}`); } catch (_) {} renderWs(); };
  function woPhotosHtml(w, { title = '', mineOnly = false } = {}) {
    const list = issuesFor(w).filter(i => !mineOnly || i.mechanic === me());
    if (!list.length) return title ? '' : `<div class="ds-empty">${E(T('No findings with photos on this work order yet.'))}</div>`;
    return `${title ? `<h2 style="margin-top:16px">${E(title)}</h2>` : ''}<div class="wsPhotoGroups">${list.map(i => `<div class="wsPhotoGroup"><div class="wsPhotoHead"><b>${E(i.description || T('Finding'))}</b>${i.taskSnapshot ? `<span class="muted"> · ${E(i.taskSnapshot)}</span>` : ''} ${laneChip(findingLane(i))}</div>${findingPhotoMarkup(i)}</div>`).join('')}</div>`;
  }
  window.woPhotosHtml = woPhotosHtml;
  function timeHtml(w) {
    const rows = (w.tasks || []).map(t => `<tr><td>${E(t.t || '')}</td><td>${E(mechanicDisplay(t.runningBy || t.outcomeBy || w.mechanic) || '')}</td><td>${t.startedAt && !t.stoppedAt && !t.done ? `<span class="ds-chip info">${E(T('Running'))}</span>` : taskResolved(t) ? `<span class="ds-chip ok">${E(T('Done'))}</span>` : `<span class="ds-chip">${E(T('Not started'))}</span>`}</td><td class="num">${E(fmtDuration(taskElapsed(t)))}</td></tr>`).join('');
    const total = (w.tasks || []).reduce((s, t) => s + (Number(taskElapsed(t)) || 0), 0);
    return `<div class="card" style="padding:0;overflow:auto"><table class="ds-table"><thead><tr><th>${E(T('Job'))}</th><th>${E(T('Mechanic'))}</th><th>${E(T('State'))}</th><th class="num">${E(T('Labor time'))}</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="muted">${E(T('No jobs on this work order.'))}</td></tr>`}</tbody><tfoot><tr><th colspan="3">${E(T('Total'))}</th><th class="num">${E(fmtDuration(total))}</th></tr></tfoot></table></div>
      <div class="card mechanicWorkSummary"><h2 style="margin:0">${E(T('Mechanic Work Summary'))}</h2><div class="muted">${E(T('Who worked on each job and their recorded labor time.'))}</div><div data-mechanic-work-summary-wo="${E(String(w.id))}" style="margin-top:8px"><div class="muted">${E(T('Loading mechanic labor…'))}</div></div></div>`;
  }
  function billingHtml(w) {
    if (!managerCan('invoices')) return `<div class="ds-alert">${icon('lock')}<div>${E(T('Billing needs the Invoices permission.'))}</div></div>`;
    const done = String(w.status) === 'Completed';
    return `<div class="card"><h2 style="margin-top:0">${E(T('Billing'))}</h2>
      <p class="muted">${E(T('Totals, tax and payments stay in Invoices; this page only links to them.'))}</p>
      <div class="wsActions">${done ? (w.unitType === 'equipment' ? `<span class="muted">${E(T('In-house repair — not billed.'))}</span>` : `<button type="button" class="ds-btn ds-btn-primary" onclick="createServiceOrderFromWO(${Number(w.id)})">${E(T('Review Service Order / Invoice'))}</button>`) : `<span class="muted">${E(T('The invoice is made when the work order is completed.'))}</span>`}
      <button type="button" class="ds-btn ds-btn-secondary" onclick="showView('estimates')">${E(T('Open Estimates'))}</button><button type="button" class="ds-btn ds-btn-secondary" onclick="showView('invoices')">${E(T('Open Invoices'))}</button>
      ${done ? `<button type="button" class="ds-btn ds-btn-secondary" onclick="downloadWorkOrderPDF(${Number(w.id)})">${E(T('Download Work Order PDF'))}</button>` : ''}</div></div>`;
  }
  function inspectionHtml(w) {
    const card = typeof window.inspectionCardMarkup === 'function' && w.inspection?.required ? window.inspectionCardMarkup(w) : '';
    const repairs = typeof window.inspectionRepairsMarkup === 'function' && w.inspection?.required ? window.inspectionRepairsMarkup(w) : '';
    return card || repairs ? `${card}${repairs}` : `<div class="ds-empty">${E(T('No inspection on this work order.'))}</div>`;
  }
  function findingsHtml(w) {
    const list = issuesFor(w).slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    if (!list.length) return `<div class="ds-empty">${E(T('No findings on this work order.'))}</div>`;
    const waiting = list.filter(i => ['reported', 'review'].includes(findingLane(i))).length;
    return `${waiting ? `<div class="wsActions" style="margin-bottom:10px"><button type="button" class="ds-btn ds-btn-primary" onclick="wsSendToCustomer(${Number(w.id)})">${icon('upload')}<span>${E(T('Send findings to customer'))} (${waiting})</span></button></div>` : ''}
      ${list.map(i => `<div class="wsFinding"><div class="wsFindingLane">${laneChip(findingLane(i))}${i.officeReviewedAt ? `<span class="muted">${E(T('Reviewed'))} ${E(when(i.officeReviewedAt))}</span>` : ''}${i.sentAt ? `<span class="muted">· ${E(T('Sent'))} ${E(when(i.sentAt))}</span>` : ''}${findingLane(i) === 'reported' ? `<button type="button" class="ds-btn ds-btn-secondary ds-btn-sm" onclick="wsMarkReviewed(${J(i.id)})">${E(T('Mark reviewed'))}</button>` : ''}</div>${findingRecordCard(i, w)}</div>`).join('')}`;
  }
  function renderWs() {
    const box = document.getElementById('wo'); if (!box || currentView !== 'wo') return;
    loadOpenPOs();
    const w = woById(woWs.id);
    if (!w) { box.innerHTML = `<div class="ds-empty">${E(T('This work order is not available. It may have been deleted.'))} <button type="button" class="ds-btn ds-btn-secondary" onclick="showView('board')">${E(T('Back to the Repair Board'))}</button></div>`; return; }
    const tab = TABS.some(t => t[0] === woWs.tab) ? woWs.tab : 'jobs';
    const st = woStageOf(w), blockers = woBlockers(w), iss = issuesFor(w), photoCount = iss.reduce((n, i) => n + (Array.isArray(i.photoIds) ? i.photoIds.length : i.photoId ? 1 : 0) + (typeof i.photo === 'string' && i.photo.startsWith('data:image/') ? 1 : 0), 0);
    const counts = { findings: iss.length, photos: photoCount, jobs: (w.tasks || []).length };
    const keepScroll = window.scrollY;
    box.innerHTML = `<div class="wsHead">
      <div class="wsTitle"><button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" onclick="mobileGoBack()" aria-label="${E(T('Back'))}">${icon('left')}<span>${E(T('Back'))}</span></button>
        <div><h1>${E(T('Unit'))} ${E(w.unit || '—')} <span class="muted wsWoNo">#${E(String(w.id))}</span></h1><div class="muted">${E(w.customer || '')}${w.parking ? ` · ${E(T('Parking'))} ${E(w.parking)}` : ''} · ${E(fmtScheduled(w))}</div></div></div>
      <div class="wsMeta">${stageChip(st)}${blockers.map(blockerChip).join('')}<span class="wsMechs">${assignmentChips(w)}</span></div>
    </div>
    <div class="wsTabs" role="tablist" aria-label="${E(T('Work order sections'))}">${TABS.map(([k, label]) => `<button type="button" role="tab" id="wsTab-${k}" aria-selected="${k === tab}" aria-controls="wsPanel" class="wsTab${k === tab ? ' active' : ''}" onclick="wsTab('${k}')">${E(T(label))}${counts[k] ? ` <span class="wsCount">${counts[k]}</span>` : ''}</button>`).join('')}</div>
    <div id="wsPanel" class="wsPanel" role="tabpanel" aria-labelledby="wsTab-${tab}"></div>`;
    const panel = box.querySelector('#wsPanel');
    panel.innerHTML = tab === 'jobs' ? `<div class="card wsJobs">${workOrderDetailHtml(w)}</div>` : tab === 'findings' ? findingsHtml(w) : tab === 'photos' ? woPhotosHtml(w) : tab === 'inspection' ? inspectionHtml(w) : tab === 'time' ? timeHtml(w) : billingHtml(w);
    if (tab === 'jobs' || tab === 'time') try { loadWorkOrderTaskSessions(w.id); } catch (_) {}
    try { hydrateFindingPhotos(); } catch (_) {}
    try { applyTranslations?.(); } catch (_) {}
    try { window.ittrRefreshTables?.(box); } catch (_) {}
    document.title = `${T('Unit')} ${w.unit || ''} · ITTR ShopFlow`;
    window.scrollTo(0, keepScroll);
  }

  // ------------------------------------------------------------------ Repair Board
  let boardFilter = { q: '', mech: '', blocked: false, stage: '' };
  try { boardFilter = { ...boardFilter, ...JSON.parse(localStorage.getItem('ittr_board_filter') || '{}'), q: '' }; } catch (_) {}
  window.wsBoardFilter = (k, v) => { boardFilter[k] = v; try { localStorage.setItem('ittr_board_filter', JSON.stringify({ mech: boardFilter.mech, blocked: boardFilter.blocked, stage: boardFilter.stage })); } catch (_) {} renderBoard(k === 'q'); };
  function boardItems() {
    const dayMs = 36e5 * 36;
    return (state.workorders || []).filter(w => {
      if (w.releasedAt) return false;
      if (String(w.status) === 'Completed') { const d = new Date(w.completedAt); return !isNaN(d) && Date.now() - d < dayMs; }
      return true;
    }).map(w => ({ w, st: woStageOf(w), blockers: woBlockers(w) }));
  }
  function cardActions(x) {
    const w = x.w, id = Number(w.id), a = [];
    if (x.st === 'expected' && w.unitType === 'customer') a.push(`<button type="button" class="ds-btn ds-btn-secondary ds-btn-sm" onclick="markTruckHere(${id})">${E(T('Truck is here'))}</button>`);
    if (x.st === 'approval' && issuesFor(w).some(i => ['reported', 'review'].includes(findingLane(i)))) a.push(`<button type="button" class="ds-btn ds-btn-secondary ds-btn-sm" onclick="wsSendToCustomer(${id})">${E(T('Send to customer'))}</button>`);
    if (x.st === 'qc') a.push(`<button type="button" class="ds-btn ds-btn-primary ds-btn-sm" onclick="wsPassQc(${id})">${icon('check')}<span>${E(T('QC passed'))}</span></button>`);
    if (x.st === 'ready' && String(w.status) !== 'Completed' && w.qc?.passedAt) a.push(`<button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" onclick="wsReopenQc(${id})">${E(T('Reopen QC'))}</button>`);
    if (x.st === 'ready' && String(w.status) === 'Completed') a.push(`<button type="button" class="ds-btn ds-btn-secondary ds-btn-sm" onclick="wsRelease(${id})">${E(T('Picked up'))}</button>`);
    return a.join('');
  }
  function boardCard(x) {
    const w = x.w, tasks = (w.tasks || []).filter(Boolean), done = tasks.filter(taskResolved).length, iss = issuesFor(w), waiting = iss.filter(i => ['reported', 'review', 'customer'].includes(findingLane(i))).length;
    const running = tasks.find(t => t.startedAt && !t.stoppedAt && !t.done);
    return `<article class="bdCard${x.blockers.length ? ' blocked' : ''}" draggable="true" data-wo="${E(String(w.id))}" aria-label="${E(T('Unit'))} ${E(w.unit || '')}">
      <div class="bdTop"><button type="button" class="bdOpen" onclick="openWoWorkspace(${Number(w.id)})"><b>${E(w.unit || '—')}</b><span class="muted">#${E(String(w.id))}</span></button>${w.priority && w.priority !== 'Normal' ? `<span class="ds-chip ${/high|urgent/i.test(w.priority) ? 'danger' : 'warn'}">${E(T(w.priority))}</span>` : ''}</div>
      <div class="bdCust muted">${E(w.customer || '')}</div>
      <div class="bdLine">${icon('user')}<span>${E([w.mechanic, ...(w.helpers || [])].filter(Boolean).map(mechanicDisplay).join(', ') || T('Not assigned'))}</span></div>
      ${tasks.length ? `<div class="bdProg" title="${E(T('Jobs done'))}"><span style="width:${Math.round(done / tasks.length * 100)}%"></span></div><div class="bdLine muted">${done}/${tasks.length} ${E(T('jobs done'))}${running ? ` · ${E(T('Working'))}: ${E(running.t || '')}` : ''}</div>` : ''}
      ${waiting ? `<div class="bdLine">${icon('alert')}<span>${waiting} ${E(T(waiting === 1 ? 'finding waiting' : 'findings waiting'))}</span></div>` : ''}
      ${x.blockers.length ? `<div class="bdBlockers">${x.blockers.map(blockerChip).join('')}</div>` : ''}
      <div class="bdActs">${cardActions(x)}<details class="bdMore"><summary class="ds-btn ds-btn-ghost ds-btn-sm">${E(T('Blockers'))}</summary><div class="bdMenu">${BLOCKERS.map(([k, label]) => `<button type="button" role="menuitemcheckbox" aria-checked="${!!w.blockers?.[k]?.on}" onclick="wsToggleBlocker(${Number(w.id)},'${k}')">${w.blockers?.[k]?.on ? '✓ ' : ''}${E(T(label))}</button>`).join('')}</div></details></div>
    </article>`;
  }
  function renderBoard(keepFocus = false) {
    const box = document.getElementById('board'); if (!box || currentView !== 'board') return;
    loadOpenPOs();
    const all = boardItems(), mechs = [...new Set((state.workorders || []).flatMap(w => [w.mechanic, ...(w.helpers || [])]).filter(Boolean))].sort();
    const q = boardFilter.q.trim().toLowerCase();
    const items = all.filter(x => (!q || [x.w.unit, x.w.customer, x.w.id, x.w.vin].some(v => String(v || '').toLowerCase().includes(q)))
      && (!boardFilter.mech || [x.w.mechanic, ...(x.w.helpers || [])].includes(boardFilter.mech)) && (!boardFilter.blocked || x.blockers.length));
    const byStage = Object.fromEntries(STAGES.map(s => [s[0], []])); items.forEach(x => byStage[x.st].push(x));
    const blockedCount = all.filter(x => x.blockers.length).length;
    const focus = keepFocus && document.activeElement?.id === 'bdSearch';
    box.innerHTML = `<div class="toolbar"><div><h1>${E(T('Repair Board'))}</h1><div class="muted">${E(T('Every open truck by stage. Stages follow the work order; blockers show what is holding a truck up.'))}</div></div><button onclick="openWorkOrder()">+ ${E(T('New Work Order'))}</button></div>
    <div class="bdBar card"><input id="bdSearch" type="search" class="ds-input" placeholder="${E(T('Search unit, customer, VIN, WO #'))}" value="${E(boardFilter.q)}" oninput="wsBoardFilter('q',this.value)" aria-label="${E(T('Search the board'))}">
      <select class="ds-input" aria-label="${E(T('Mechanic'))}" onchange="wsBoardFilter('mech',this.value)"><option value="">${E(T('All mechanics'))}</option>${mechs.map(m => `<option value="${E(m)}"${boardFilter.mech === m ? ' selected' : ''}>${E(mechanicDisplay(m))}</option>`).join('')}</select>
      <label class="bdToggle"><input type="checkbox" ${boardFilter.blocked ? 'checked' : ''} onchange="wsBoardFilter('blocked',this.checked)"> ${E(T('Blocked only'))} <span class="ds-chip ${blockedCount ? 'warn' : ''}">${blockedCount}</span></label></div>
    <div class="bdStagePick" role="tablist" aria-label="${E(T('Stage'))}">${STAGES.map(([k, label]) => `<button type="button" role="tab" aria-selected="${boardFilter.stage === k}" class="${boardFilter.stage === k ? 'active' : ''}" onclick="wsBoardFilter('stage','${boardFilter.stage === k ? '' : k}')">${E(T(label))} <span>${byStage[k].length}</span></button>`).join('')}</div>
    <div class="bdCols${boardFilter.stage ? ' oneStage' : ''}">${STAGES.map(([k, label, hint]) => `<section class="bdCol${boardFilter.stage && boardFilter.stage !== k ? ' bdHide' : ''}${byStage[k].length ? '' : ' isEmpty'}" data-stage="${k}" aria-label="${E(T(label))}"><div class="bdHead"><b>${E(T(label))}</b><span class="bdNum">${byStage[k].length}</span><div class="muted">${E(T(hint))}</div></div><div class="bdList">${byStage[k].map(boardCard).join('') || `<div class="bdEmpty muted">${E(T('Nothing here'))}</div>`}</div></section>`).join('')}</div>`;
    if (focus) { const s = document.getElementById('bdSearch'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    try { applyTranslations?.(); } catch (_) {}
  }
  // Drag-and-drop does what a button would do; a stage that follows from the mechanic's work cannot be faked by dragging,
  // so those drops explain what moves the truck instead. Every move also has a button (keyboard and touch).
  const WHY = { diagnosis: 'A truck moves to Diagnosis when the mechanic starts the inspection or reports a finding.', approval: 'A truck moves to Approval when a finding is waiting for a decision.', repair: 'A truck moves to Repair when a mechanic starts a job.', qc: 'A truck moves to Quality Check when every job is done.', ready: 'A truck moves to Ready when QC passes or the work order is completed.', checkedin: 'Only a truck that is not here yet can be checked in.', expected: 'Only a customer truck that has not been started can be moved back to Expected.' };
  window.wsBoardDrop = (id, to) => {
    const w = woById(id); if (!w || !office()) return false;
    const from = woStageOf(w), started = (w.tasks || []).some(t => t.startedAt || t.done || Number(t.elapsedMs || 0) > 0);
    if (from === to) return false;
    if (to === 'checkedin' && from === 'expected') { if (w.unitType !== 'customer') { showToast(T('Fleet units are released automatically.'), 'info'); return false; } markTruckHere(Number(w.id)); return true; }
    if (to === 'expected' && w.unitType === 'customer' && !started && String(w.status) !== 'Completed') { change(() => { w.truckHere = false; }); return true; }
    if (to === 'ready' && from === 'qc') { wsPassQc(w.id); return true; }
    if (to === 'qc' && from === 'ready' && w.qc?.passedAt && String(w.status) !== 'Completed') { wsReopenQc(w.id); return true; }
    showToast(T(WHY[to] || 'This move is not available.'), 'info', 6000); return false;
  };
  document.addEventListener('dragstart', e => { const c = e.target.closest?.('#board .bdCard'); if (!c) return; e.dataTransfer.setData('text/plain', c.dataset.wo); e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); });
  document.addEventListener('dragend', e => { e.target.closest?.('#board .bdCard')?.classList.remove('dragging'); document.querySelectorAll('#board .bdCol.dropHere').forEach(x => x.classList.remove('dropHere')); });
  document.addEventListener('dragover', e => { const col = e.target.closest?.('#board .bdCol'); if (!col) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; document.querySelectorAll('#board .bdCol.dropHere').forEach(x => x !== col && x.classList.remove('dropHere')); col.classList.add('dropHere'); });
  document.addEventListener('drop', e => { const col = e.target.closest?.('#board .bdCol'); if (!col) return; e.preventDefault(); col.classList.remove('dropHere'); const id = e.dataTransfer.getData('text/plain'); if (id) wsBoardDrop(id, col.dataset.stage); });

  document.addEventListener('click', e => { const d = e.target.closest('.bdMore'); document.querySelectorAll('.bdMore[open]').forEach(x => { if (x !== d) x.removeAttribute('open'); }); });

  // ------------------------------------------------------------------ Findings approval lanes (in the Findings page)
  let lanesMode = 'lanes';
  try { lanesMode = localStorage.getItem('ittr_findings_mode') || 'lanes'; } catch (_) {}
  window.wsFindingsMode = m => { lanesMode = m; try { localStorage.setItem('ittr_findings_mode', m); } catch (_) {} renderLanes(); };
  function laneCard(i) {
    const w = woById(i.wo), l = findingLane(i), id = E(String(i.id)), jid = J(i.id), photos = (Array.isArray(i.photoIds) ? i.photoIds.length : i.photoId ? 1 : 0) + (typeof i.photo === 'string' && i.photo.startsWith('data:image/') ? 1 : 0);
    const acts = [];
    if (l === 'reported') acts.push(`<button type="button" class="ds-btn ds-btn-secondary ds-btn-sm" onclick="wsMarkReviewed(${jid})">${E(T('Mark reviewed'))}</button>`);
    if (['reported', 'review'].includes(l) && w) acts.push(`<button type="button" class="ds-btn ds-btn-secondary ds-btn-sm" onclick="wsSendToCustomer(${Number(w.id)})">${E(T('Send to customer'))}</button>`);
    if (['reported', 'review', 'customer'].includes(l)) acts.push(`<button type="button" class="ds-btn ds-btn-primary ds-btn-sm" onclick="wsDecide(${jid},'Proceed')">${E(T('Approve'))}</button><button type="button" class="ds-btn ds-btn-danger ds-btn-sm" onclick="wsDecide(${jid},'Do Not Proceed')">${E(T('Decline'))}</button>`);
    if (['review', 'customer'].includes(l)) acts.push(`<button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" onclick="wsUnreview(${jid})">${E(T('Back to Reported'))}</button>`);
    if (l === 'declined' || l === 'approved') acts.push(`<button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" onclick="wsDecide(${jid},'Waiting for Customer')">${E(T('Reopen'))}</button>`);
    return `<article class="lnCard sev-${E(String(i.severity || '').toLowerCase().replace(/\s+/g, '-'))}" data-finding="${id}">
      <div class="lnTop"><button type="button" class="bdOpen" ${w ? `onclick="openWoWorkspace(${Number(w.id)},'findings')"` : 'disabled'}><b>${E(w?.unit || i.unitSnapshot || T('Unknown unit'))}</b></button><span class="ds-chip ${/critical/i.test(i.severity) ? 'danger' : /high/i.test(i.severity) ? 'warn' : ''}">${E(T(i.severity || 'Needs Attention'))}</span></div>
      <div class="lnText">${E(i.description || '')}</div>${i.recommendation ? `<div class="muted lnRec">${E(T('Recommended'))}: ${E(i.recommendation)}</div>` : ''}
      <div class="muted lnMeta">${E(mechanicDisplay(i.mechanic) || '')} · ${E(when(i.createdAt) || i.created || '')}${photos ? ` · ${icon('camera')} ${photos}` : ''}${i.sentAt ? ` · ${E(T('Sent'))} ${E(ago(i.sentAt))}` : ''}</div>
      <div class="bdActs">${acts.join('')}</div></article>`;
  }
  function renderLanes() {
    const sec = document.getElementById('approvals'); if (!sec) return;
    let host = document.getElementById('findingLanes');
    if (!host) {
      const bar = document.createElement('div'); bar.className = 'lnModes'; bar.id = 'findingModes';
      sec.querySelector('.toolbar')?.appendChild(bar);
      host = document.createElement('div'); host.id = 'findingLanes'; host.className = 'lnBoard';
      sec.querySelector('.notice')?.insertAdjacentElement('beforebegin', host);
    }
    const bar = document.getElementById('findingModes');
    if (bar) bar.innerHTML = `<div class="lnSeg" role="group" aria-label="${E(T('Findings view'))}"><button type="button" aria-pressed="${lanesMode === 'lanes'}" onclick="wsFindingsMode('lanes')">${E(T('Approval lanes'))}</button><button type="button" aria-pressed="${lanesMode !== 'lanes'}" onclick="wsFindingsMode('list')">${E(T('List by date'))}</button></div>`;
    const lanes = lanesMode === 'lanes';
    sec.classList.toggle('lanesMode', lanes);
    if (!lanes) { host.innerHTML = ''; return; }
    const cutoff = Date.now() - 30 * 864e5, recent = i => { const d = new Date(i.decisionAt || i.createdAt || 0); return isNaN(d) || d.getTime() === 0 || d >= cutoff; };
    const by = Object.fromEntries(LANES.map(l => [l[0], []]));
    for (const i of state.issues || []) { const l = findingLane(i); if (['declined', 'done', 'approved', 'job'].includes(l) && !recent(i)) continue; by[l].push(i); }
    for (const k in by) by[k].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    host.innerHTML = `<div class="muted lnHint">${E(T('A finding moves left to right: the office reviews it, sends it to the customer, the decision is recorded and an approved repair becomes a job on the work order. Decided items show for 30 days; the full history is under "List by date".'))}</div>
      <div class="bdCols lnCols">${LANES.map(([k, label]) => `<section class="bdCol" data-lane="${k}" aria-label="${E(T(label))}"><div class="bdHead"><b>${E(T(label))}</b><span class="bdNum">${by[k].length}</span></div><div class="bdList">${by[k].map(laneCard).join('') || `<div class="bdEmpty muted">${E(T('Nothing here'))}</div>`}</div></section>`).join('')}</div>`;
    try { applyTranslations?.(); } catch (_) {}
  }

  // ------------------------------------------------------------------ desktop sidebar (office) + shared tables
  function syncShell() {
    document.body.classList.toggle('officeShell', office());
    let collapsed = false; try { collapsed = localStorage.getItem('ittr_nav_collapsed') === '1'; } catch (_) {}
    document.body.classList.toggle('navCollapsed', office() && collapsed);
    const b = document.querySelector('.navCollapse'); if (b) b.setAttribute('aria-expanded', String(!collapsed));
    // Collapsed: labels hidden, so every button keeps its name as a tooltip (screen readers read the hidden text).
    document.querySelectorAll('header>nav .navbtn[data-view]').forEach(n => { const t = (n.querySelector('.navTxt')?.textContent || '').trim(); if (t) n.title = collapsed ? t : ''; });
  }
  window.ittrToggleSidebar = () => { let c = false; try { c = localStorage.getItem('ittr_nav_collapsed') === '1'; localStorage.setItem('ittr_nav_collapsed', c ? '0' : '1'); } catch (_) {} syncShell(); };
  window.ittrSyncShell = syncShell;
  // One table look for list tables: sticky header, right-aligned numbers, cards on a phone. Tables that have their own
  // phone layout (work orders, parts), editors (inputs inside) and print templates are left alone.
  const NUM_HEAD = /\b(qty|quantity|price|rate|total|amount|balance|cost|hours|hrs|labor|due|paid|tax|subtotal|profit|margin|count|miles|mileage|on hand|available)\b|[$%#]/i;
  const NUM_CELL = /^[-−]?\(?[$€£]?\s?-?[\d,]+(\.\d+)?\)?\s?(%|h|hrs|mi)?$/i;
  function enhanceTable(t) {
    if (t.dataset.dsDone === '1' || t.classList.contains('noCards') || t.closest('.modal,.printOnly,[data-print],#workorders,#invoiceWorkspace') || t.classList.contains('partsTableV2')) return;
    if (t.querySelector('input,select,textarea') || t.querySelector('td[data-label]')) return;
    const heads = [...(t.tHead?.rows[0]?.cells || [])]; if (!heads.length) return;
    t.dataset.dsDone = '1'; t.classList.add('ds-table');
    const labels = heads.map(h => (h.textContent || '').trim());
    const rows = [...t.tBodies].flatMap(b => [...b.rows]);
    labels.forEach((l, c) => {
      const cells = rows.map(r => r.cells[c]).filter(Boolean), filled = cells.filter(x => (x.textContent || '').trim());
      const numeric = NUM_HEAD.test(l) && filled.length && filled.filter(x => NUM_CELL.test((x.textContent || '').trim())).length >= Math.ceil(filled.length * 0.8);
      if (numeric) { heads[c].classList.add('num'); cells.forEach(x => x.classList.add('num')); }
    });
    if (labels.length <= 8) { t.classList.add('ds-cards'); rows.forEach(r => [...r.cells].forEach((cell, c) => { if (!cell.hasAttribute('data-ds-label')) cell.setAttribute('data-ds-label', cell.colSpan > 1 ? '' : labels[c] || ''); })); }
  }
  function refreshTables(root) { (root || document).querySelectorAll('main table').forEach(t => { if (t.dataset.dsDone === '1') { delete t.dataset.dsDone; } enhanceTable(t); }); }
  let tblTimer = null;
  const mo = new MutationObserver(() => { clearTimeout(tblTimer); tblTimer = setTimeout(() => refreshTables(document.querySelector('main')), 120); });
  const startObs = () => { const m = document.querySelector('main'); if (m) { mo.observe(m, { childList: true, subtree: true }); refreshTables(m); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObs); else startObs();
  window.ittrRefreshTables = refreshTables;

  // ------------------------------------------------------------------ hooks into the app
  window.ittrWsRender = () => { if (currentView === 'wo') renderWs(); else if (currentView === 'board') renderBoard(); if (office() && document.getElementById('approvals')) renderLanes(); };
  window.ittrWsAfterShow = view => { syncShell(); if (view === 'wo') renderWs(); if (view === 'board') renderBoard(); if (view === 'approvals') renderLanes(); };
  if (typeof render === 'function' && !render.__ws) { const original = render; const wrapped = function () { const r = original.apply(this, arguments); try { window.ittrWsRender(); } catch (e) { console.error('Workspace render failed:', e); } return r; }; wrapped.__ws = true; try { render = wrapped; } catch (_) {} window.render = wrapped; }
  if (typeof currentView !== 'undefined' && ['wo', 'board', 'approvals'].includes(currentView)) window.ittrWsAfterShow(currentView);
})();
