// ITTR ShopFlow full-screen photo viewer (v24.69.0).
// Whole photo first (fit to screen, nothing cropped), then zoom / pan / rotate, previous / next, keyboard and touch.
// Markup (arrows, circles, short text) is drawn OVER the photo from saved data; the original image is never changed.
//   ITTRPhotoViewer.open({ items, index, t, onSaveMarks })
//   item: { id, load: async ({fresh}) => url, caption, kind, meta: {unit, component, mechanic, time, finding}, marks: [], editable }
(function () {
  const COLORS = { red: '#ef4444', amber: '#f59e0b', white: '#ffffff', black: '#111827', blue: '#3b82f6' };
  const I = n => (window.ittrIcon ? window.ittrIcon(n) : '');
  let V = null;

  function css() {
    if (document.getElementById('pvStyle')) return;
    const s = document.createElement('style'); s.id = 'pvStyle';
    s.textContent = `
.pv{position:fixed;inset:0;z-index:5000;background:#05080f;color:#e5e7eb;display:grid;grid-template-rows:auto 1fr auto;font-family:var(--ds-font,system-ui);touch-action:none}
.pvBar{display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(17,24,39,.96);border-bottom:1px solid #1f2937;flex-wrap:wrap}
.pvBar .pvTitle{flex:1;min-width:140px}.pvTitle b{display:block;font-size:15px;color:#fff}.pvTitle span{font-size:12.5px;color:#9ca3af}
.pv button{min-height:44px;min-width:44px;border-radius:10px;border:1px solid #374151;background:#111827;color:#f3f4f6;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 10px;font:600 14px/1 var(--ds-font,system-ui);cursor:pointer;width:auto}
.pv button:hover{background:#1f2937}.pv button[aria-pressed="true"]{background:#1d4ed8;border-color:#1d4ed8}
.pv button:disabled{opacity:.45;cursor:not-allowed}
.pv .ds-icon{width:20px;height:20px}
.pvStage{position:relative;overflow:hidden;cursor:grab}.pvStage.pvPanning{cursor:grabbing}.pvStage.pvDraw{cursor:crosshair}
.pvLayer{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}
.pvLayer img{display:block;width:100%;height:100%;user-select:none;-webkit-user-drag:none;pointer-events:none}
.pvLayer svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
.pv [hidden]{display:none!important}
.pvMsg{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;padding:24px;font-size:15px}
.pvSpin{width:34px;height:34px;border-radius:50%;border:3px solid #374151;border-top-color:#e5e7eb;animation:pvSpin .9s linear infinite}@keyframes pvSpin{to{transform:rotate(360deg)}}
.pvNav{position:absolute;top:50%;transform:translateY(-50%);z-index:2;background:rgba(17,24,39,.75)!important;min-height:56px!important;min-width:48px!important}
.pvPrev{left:10px}.pvNext{right:10px}
.pvFoot{display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(17,24,39,.96);border-top:1px solid #1f2937;flex-wrap:wrap;font-size:13px;color:#cbd5e1}
.pvFoot .pvCap{flex:1;min-width:160px}.pvFoot .pvCap b{color:#fff}
.pvTools{display:none;gap:6px;flex-wrap:wrap;align-items:center}.pv.pvEditing .pvTools{display:flex}.pv.pvEditing .pvView{display:none}
.pvSwatch{width:30px;height:30px;min-width:30px!important;min-height:30px!important;padding:0!important;border-radius:50%!important;border:2px solid #4b5563!important}
.pvSwatch[aria-pressed="true"]{outline:3px solid #93c5fd;outline-offset:1px}
.pvStatus{font-weight:700}.pvStatus.ok{color:#4ade80}.pvStatus.err{color:#f87171}
.pvTag{display:inline-block;margin-left:6px;padding:3px 7px;border-radius:999px;font-size:11px;font-weight:800;background:#374151;color:#fff;vertical-align:1px}.pvTag.before{background:#b54708}.pvTag.after{background:#067647}
@media(max-width:600px){.pvBar .pvZoomBtns{display:none}.pvNav{display:none}}`;
    document.head.appendChild(s);
  }
  const tr = (t, s) => (typeof t === 'function' ? t(s) : s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function open({ items, index = 0, t, onSaveMarks, opener } = {}) {
    if (!Array.isArray(items) || !items.length) return;
    close(true); css();
    const root = document.createElement('div'); root.className = 'pv'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', tr(t, 'Photo viewer'));
    root.innerHTML = `
<div class="pvBar"><div class="pvTitle"><b class="pvCount"></b><span class="pvCtx"></span></div>
 <span class="pvView" style="display:contents"><span class="pvZoomBtns" style="display:contents">
  <button type="button" data-a="out" aria-label="${esc(tr(t, 'Zoom out'))}" title="${esc(tr(t, 'Zoom out'))} (−)">${I('zoomOut')}</button>
  <button type="button" data-a="fit" aria-label="${esc(tr(t, 'Fit to screen'))}" title="${esc(tr(t, 'Fit to screen'))} (0)">${I('fit')}</button>
  <button type="button" data-a="in" aria-label="${esc(tr(t, 'Zoom in'))}" title="${esc(tr(t, 'Zoom in'))} (+)">${I('zoomIn')}</button></span>
  <button type="button" data-a="rotate" aria-label="${esc(tr(t, 'Rotate'))}" title="${esc(tr(t, 'Rotate'))} (R)">${I('rotate')}</button>
  <button type="button" data-a="marks" aria-pressed="true" title="${esc(tr(t, 'Show or hide markup'))} (M)">${I('eye')}<span>${esc(tr(t, 'Markup'))}</span></button>
  <button type="button" data-a="edit" class="pvEditBtn" hidden>${I('pencil')}<span>${esc(tr(t, 'Mark up'))}</span></button></span>
 <button type="button" data-a="close" aria-label="${esc(tr(t, 'Close'))}" title="${esc(tr(t, 'Close'))} (Esc)">${I('close')}<span>${esc(tr(t, 'Close'))}</span></button>
</div>
<div class="pvStage"><div class="pvLayer"><img alt=""><svg class="pvSvg" xmlns="http://www.w3.org/2000/svg"></svg></div><div class="pvMsg" hidden></div>
 <button type="button" class="pvNav pvPrev" data-a="prev" aria-label="${esc(tr(t, 'Previous photo'))}">${I('left')}</button>
 <button type="button" class="pvNav pvNext" data-a="next" aria-label="${esc(tr(t, 'Next photo'))}">${I('right')}</button></div>
<div class="pvFoot"><div class="pvCap"></div>
 <div class="pvTools" role="toolbar" aria-label="${esc(tr(t, 'Markup tools'))}">
  <button type="button" data-tool="arrow" aria-pressed="true">${I('arrow')}<span>${esc(tr(t, 'Arrow'))}</span></button>
  <button type="button" data-tool="circle" aria-pressed="false">${I('circle')}<span>${esc(tr(t, 'Circle'))}</span></button>
  <button type="button" data-tool="text" aria-pressed="false">${I('text')}<span>${esc(tr(t, 'Text'))}</span></button>
  ${Object.keys(COLORS).slice(0, 3).map((c, i) => `<button type="button" class="pvSwatch" data-color="${c}" aria-pressed="${i ? 'false' : 'true'}" aria-label="${esc(tr(t, c === 'red' ? 'Red' : c === 'amber' ? 'Amber' : 'White'))}" style="background:${COLORS[c]}"></button>`).join('')}
  <button type="button" data-a="undo">${I('undo')}<span>${esc(tr(t, 'Undo'))}</span></button>
  <button type="button" data-a="clear">${I('trash')}<span>${esc(tr(t, 'Clear'))}</span></button>
  <button type="button" data-a="cancel">${esc(tr(t, 'Cancel'))}</button>
  <button type="button" data-a="save" style="background:#1d4ed8;border-color:#1d4ed8">${I('check')}<span>${esc(tr(t, 'Save markup'))}</span></button>
 </div><span class="pvStatus" role="status" aria-live="polite"></span></div>`;
    document.body.appendChild(root);
    const prevOverflow = document.documentElement.style.overflow; document.documentElement.style.overflow = 'hidden';
    const $ = s => root.querySelector(s), stage = $('.pvStage'), layer = $('.pvLayer'), img = $('img'), svg = $('.pvSvg'), msg = $('.pvMsg');
    V = { root, items, i: Math.max(0, Math.min(items.length - 1, index)), t, onSaveMarks, opener: opener || document.activeElement, prevOverflow,
      s: 1, fit: 1, x: 0, y: 0, rot: 0, nw: 0, nh: 0, showMarks: true, editing: false, tool: 'arrow', color: 'red', draft: null, marks: [], pointers: new Map(), gen: 0 };

    const status = (text, cls = '') => { const el = $('.pvStatus'); el.textContent = text || ''; el.className = 'pvStatus ' + cls; };
    function apply() {
      const rotW = V.rot % 180 ? V.nh : V.nw, rotH = V.rot % 180 ? V.nw : V.nh;
      layer.style.width = V.nw + 'px'; layer.style.height = V.nh + 'px';
      // translate to centre, rotate around the image centre, scale
      layer.style.transform = `translate(${V.x}px,${V.y}px) scale(${V.s}) translate(${rotW / 2}px,${rotH / 2}px) rotate(${V.rot}deg) translate(${-V.nw / 2}px,${-V.nh / 2}px)`;
    }
    function fitView() {
      const r = stage.getBoundingClientRect(), rotW = V.rot % 180 ? V.nh : V.nw, rotH = V.rot % 180 ? V.nw : V.nh;
      if (!rotW || !rotH) return;
      V.fit = Math.min(r.width / rotW, r.height / rotH, 4); V.s = V.fit; V.x = (r.width - rotW * V.s) / 2; V.y = (r.height - rotH * V.s) / 2; apply();
    }
    function zoomAt(f, cx, cy) {
      const r = stage.getBoundingClientRect(); cx = cx ?? r.width / 2; cy = cy ?? r.height / 2;
      const ns = Math.max(V.fit, Math.min(V.fit * 8, V.s * f)); const k = ns / V.s;
      V.x = cx - (cx - V.x) * k; V.y = cy - (cy - V.y) * k; V.s = ns; if (ns === V.fit) fitView(); else apply();
    }
    function drawMarks() {
      const list = V.editing ? V.marks.concat(V.draft ? [V.draft] : []) : (V.items[V.i].marks || []);
      svg.setAttribute('viewBox', `0 0 ${V.nw || 1} ${V.nh || 1}`);
      const W = V.nw || 1, H = V.nh || 1, sw = Math.max(3, Math.round(Math.min(W, H) / 160));
      svg.innerHTML = (V.showMarks || V.editing) ? list.map(m => {
        const c = COLORS[m.c] || COLORS.red, x = m.x * W, y = m.y * H;
        if (m.t === 'text') { const fs = Math.max(18, Math.round(Math.min(W, H) / 22)); return `<text x="${x}" y="${y}" fill="${c}" font-size="${fs}" font-weight="800" font-family="system-ui,sans-serif" paint-order="stroke" stroke="#000" stroke-width="${Math.max(2, fs / 8)}">${esc(m.text)}</text>`; }
        const x2 = m.x2 * W, y2 = m.y2 * H;
        if (m.t === 'circle') { const r = Math.hypot(x2 - x, y2 - y); return `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${c}" stroke-width="${sw}"/>`; }
        const a = Math.atan2(y2 - y, x2 - x), h = sw * 5;
        return `<g stroke="${c}" stroke-width="${sw}" stroke-linecap="round" fill="none"><line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}"/><path d="M${x2 - h * Math.cos(a - .45)},${y2 - h * Math.sin(a - .45)} L${x2},${y2} L${x2 - h * Math.cos(a + .45)},${y2 - h * Math.sin(a + .45)}"/></g>`;
      }).join('') : '';
    }
    function header() {
      const it = V.items[V.i], m = it.meta || {};
      $('.pvCount').textContent = `${tr(t, 'Photo')} ${V.i + 1} / ${V.items.length}`;
      $('.pvCtx').textContent = [m.unit && `${tr(t, 'Unit')} ${m.unit}`, m.component, m.mechanic, m.time].filter(Boolean).join(' · ');
      $('.pvCap').innerHTML = `${it.kind ? `<span class="pvTag ${esc(it.kind)}">${esc(tr(t, it.kind === 'before' ? 'Before' : it.kind === 'after' ? 'After' : 'Detail'))}</span> ` : ''}<b>${esc(it.caption || '')}</b>${m.finding ? `<div>${esc(m.finding)}</div>` : ''}`;
      $('[data-a="prev"]').disabled = V.i === 0; $('[data-a="next"]').disabled = V.i === V.items.length - 1;
      $('[data-a="prev"]').hidden = $('[data-a="next"]').hidden = V.items.length < 2;
      $('.pvEditBtn').hidden = !(it.editable && onSaveMarks);
      $('[data-a="marks"]').hidden = !((it.marks || []).length);
    }
    async function load(fresh = false, retried = false) {
      const it = V.items[V.i], g = ++V.gen;
      header(); status(''); img.removeAttribute('src'); layer.style.visibility = 'hidden'; svg.innerHTML = '';
      msg.hidden = false; msg.innerHTML = `<div class="pvSpin" aria-hidden="true"></div><div>${esc(tr(t, fresh ? 'The photo link expired — getting a new one…' : 'Loading full photo…'))}</div>`;
      let url;
      try { url = typeof it.load === 'function' ? await it.load({ fresh }) : it.src; } catch (e) { if (g === V.gen) failed(e?.status === 403 ? tr(t, 'You do not have access to this photo.') : (e?.message || tr(t, 'Photo could not be loaded.'))); return; }
      if (g !== V.gen) return;
      img.onload = () => { if (g !== V.gen) return; V.nw = img.naturalWidth; V.nh = img.naturalHeight; msg.hidden = true; layer.style.visibility = 'visible'; V.rot = 0; fitView(); drawMarks(); };
      img.onerror = () => { if (g !== V.gen) return; if (!retried && typeof it.load === 'function') return load(true, true); failed(tr(t, 'Photo could not be loaded. The connection may be down or the link has expired.')); };
      img.src = url;
    }
    function failed(text) {
      msg.hidden = false; layer.style.visibility = 'hidden';
      msg.innerHTML = `<div style="color:#fca5a5">${I('alert')}</div><div>${esc(text)}</div><button type="button" data-a="retry">${I('retry')}<span>${esc(tr(t, 'Retry'))}</span></button>`;
    }
    const go = d => { if (V.editing) return; const n = V.i + d; if (n < 0 || n >= V.items.length) return; V.i = n; load(); };
    function setEditing(on) {
      V.editing = on; root.classList.toggle('pvEditing', on); stage.classList.toggle('pvDraw', on);
      V.marks = on ? JSON.parse(JSON.stringify(V.items[V.i].marks || [])) : []; V.draft = null; status(''); if (on) fitView(); drawMarks();
    }
    function toImage(ev) {
      // pointer position -> 0..1 image coordinates (undo pan, zoom, rotation)
      const r = stage.getBoundingClientRect(); let px = (ev.clientX - r.left - V.x) / V.s, py = (ev.clientY - r.top - V.y) / V.s;
      const rotW = V.rot % 180 ? V.nh : V.nw, rotH = V.rot % 180 ? V.nw : V.nh; px -= rotW / 2; py -= rotH / 2;
      const a = -V.rot * Math.PI / 180, qx = px * Math.cos(a) - py * Math.sin(a), qy = px * Math.sin(a) + py * Math.cos(a);
      return { x: Math.max(0, Math.min(1, (qx + V.nw / 2) / V.nw)), y: Math.max(0, Math.min(1, (qy + V.nh / 2) / V.nh)) };
    }
    async function saveMarks() {
      const it = V.items[V.i], marks = V.marks.slice();
      status(tr(t, 'Saving markup…')); $('[data-a="save"]').disabled = true;
      try { await onSaveMarks(it, marks); it.marks = marks; setEditing(false); header(); status(tr(t, 'Markup saved. The original photo is unchanged.'), 'ok'); }
      catch (e) { status(`${tr(t, 'Markup not saved')}: ${e?.message || e}`, 'err'); }
      finally { $('[data-a="save"]').disabled = false; }
    }

    root.addEventListener('click', ev => {
      const b = ev.target.closest('button'); if (!b) return;
      const a = b.dataset.a;
      if (b.dataset.tool) { V.tool = b.dataset.tool; root.querySelectorAll('[data-tool]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); return; }
      if (b.dataset.color) { V.color = b.dataset.color; root.querySelectorAll('[data-color]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); return; }
      if (a === 'close') return close();
      if (a === 'prev') return go(-1); if (a === 'next') return go(1);
      if (a === 'in') return zoomAt(1.5); if (a === 'out') return zoomAt(1 / 1.5); if (a === 'fit') return fitView();
      if (a === 'rotate') { V.rot = (V.rot + 90) % 360; fitView(); return; }
      if (a === 'marks') { V.showMarks = !V.showMarks; b.setAttribute('aria-pressed', String(V.showMarks)); b.innerHTML = `${I(V.showMarks ? 'eye' : 'eyeOff')}<span>${esc(tr(t, 'Markup'))}</span>`; drawMarks(); return; }
      if (a === 'retry') return load(true);
      if (a === 'edit') return setEditing(true);
      if (a === 'cancel') return setEditing(false);
      if (a === 'undo') { V.marks.pop(); drawMarks(); return; }
      if (a === 'clear') { V.marks = []; drawMarks(); return; }
      if (a === 'save') return saveMarks();
    });
    stage.addEventListener('wheel', ev => { ev.preventDefault(); const r = stage.getBoundingClientRect(); zoomAt(ev.deltaY < 0 ? 1.2 : 1 / 1.2, ev.clientX - r.left, ev.clientY - r.top); }, { passive: false });
    stage.addEventListener('dblclick', ev => { if (V.editing) return; const r = stage.getBoundingClientRect(); if (V.s > V.fit * 1.05) fitView(); else zoomAt(2.5, ev.clientX - r.left, ev.clientY - r.top); });
    let swipe = null, pinch = null;
    stage.addEventListener('pointerdown', ev => {
      if (ev.target.closest('button')) return;
      stage.setPointerCapture?.(ev.pointerId); V.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (V.editing && V.pointers.size === 1 && V.nw) {
        const p = toImage(ev);
        if (V.tool === 'text') {
          const text = (window.prompt(tr(t, 'Short label (max 60 characters)')) || '').trim().slice(0, 60);
          if (text) { V.marks.push({ t: 'text', x: p.x, y: p.y, text, c: V.color }); drawMarks(); }
          V.pointers.delete(ev.pointerId); return;
        }
        V.draft = { t: V.tool, x: p.x, y: p.y, x2: p.x, y2: p.y, c: V.color }; return;
      }
      if (V.pointers.size === 2) { const [a, b] = [...V.pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: V.s }; swipe = null; return; }
      swipe = { x: ev.clientX, y: ev.clientY, ox: V.x, oy: V.y, moved: false }; stage.classList.add('pvPanning');
    });
    stage.addEventListener('pointermove', ev => {
      if (!V.pointers.has(ev.pointerId)) return; V.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (V.editing && V.draft) { const p = toImage(ev); V.draft.x2 = p.x; V.draft.y2 = p.y; drawMarks(); return; }
      if (pinch && V.pointers.size === 2) { const [a, b] = [...V.pointers.values()], r = stage.getBoundingClientRect(); zoomAt((pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d) / V.s, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top); return; }
      if (swipe) { const dx = ev.clientX - swipe.x, dy = ev.clientY - swipe.y; if (Math.abs(dx) + Math.abs(dy) > 6) swipe.moved = true; if (V.s > V.fit * 1.01) { V.x = swipe.ox + dx; V.y = swipe.oy + dy; apply(); } }
    });
    const up = ev => {
      V.pointers.delete(ev.pointerId); stage.classList.remove('pvPanning');
      if (V.editing && V.draft) { const d = V.draft; V.draft = null; if (Math.hypot((d.x2 - d.x) * V.nw, (d.y2 - d.y) * V.nh) > 8) V.marks.push(d); drawMarks(); return; }
      if (V.pointers.size < 2) pinch = null;
      if (swipe && swipe.moved && V.s <= V.fit * 1.01) { const dx = ev.clientX - swipe.x; if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1); }
      swipe = null;
    };
    stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
    V.onKey = ev => {
      if (!V || ev.defaultPrevented) return;
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); if (V.editing) setEditing(false); else close(); return; }
      if (ev.key === 'Tab') { const f = [...root.querySelectorAll('button:not([disabled]):not([hidden])')].filter(b => b.offsetParent); if (!f.length) return; const i = f.indexOf(document.activeElement); if (ev.shiftKey && i <= 0) { ev.preventDefault(); f[f.length - 1].focus(); } else if (!ev.shiftKey && i === f.length - 1) { ev.preventDefault(); f[0].focus(); } return; }
      if (V.editing) { if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); V.marks.pop(); drawMarks(); } return; }
      const k = ev.key;
      if (k === 'ArrowLeft') { ev.preventDefault(); go(-1); } else if (k === 'ArrowRight') { ev.preventDefault(); go(1); }
      else if (k === '+' || k === '=') { ev.preventDefault(); zoomAt(1.5); } else if (k === '-' || k === '_') { ev.preventDefault(); zoomAt(1 / 1.5); }
      else if (k === '0') { ev.preventDefault(); fitView(); } else if (k.toLowerCase() === 'r') { ev.preventDefault(); V.rot = (V.rot + 90) % 360; fitView(); }
      else if (k.toLowerCase() === 'm') { ev.preventDefault(); root.querySelector('[data-a="marks"]').click(); }
    };
    document.addEventListener('keydown', V.onKey, true);
    V.onResize = () => { if (V && V.nw) fitView(); };
    window.addEventListener('resize', V.onResize);
    load();
    setTimeout(() => root.querySelector('[data-a="close"]')?.focus(), 0);
    return api();
  }
  function close(silent) {
    if (!V) return; const v = V; V = null;
    document.removeEventListener('keydown', v.onKey, true); window.removeEventListener('resize', v.onResize);
    v.root.remove(); document.documentElement.style.overflow = v.prevOverflow || '';
    // The page may have re-drawn the gallery meanwhile, so the opener can be a function that finds the tile again.
    if (!silent) try { (typeof v.opener === 'function' ? v.opener() : v.opener)?.focus?.(); } catch (_) {}
  }
  function api() { return { close, get index() { return V?.i; }, get scale() { return V ? V.s / V.fit : 0; }, get rotation() { return V?.rot; }, get editing() { return !!V?.editing; } }; }
  window.ITTRPhotoViewer = { open, close, get state() { return V ? { index: V.i, zoom: V.s / V.fit, rotation: V.rot, editing: V.editing, marks: V.marks.length, x: V.x, y: V.y } : null; } };
})();
