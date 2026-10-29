/* =====================================================================
   03 - Timeline: tracks (one per marker type), zoom, ruler, mouse editing
   The strip scrolls both ways. #axis is the time axis; it is `zoom` times as wide
   as the visible part. The track-name column stays put on the left while you scroll.
   ===================================================================== */
const HW = 132;                 // width of the track-name column (same as --hw in the CSS)
const LANE_H = 32, TRK_PAD = 6; // one row of clips inside a track
let zoom = 1;
let drag = null;
let holdUntil = 0;              // the user just scrolled or zoomed: do not pull the view back to the playhead
const noFollow = ms => { holdUntil = performance.now() + (ms || 2200); };
const viewW = () => Math.max(60, strip.clientWidth - HW);        // width of the visible time axis
const maxZoom = () => (meta ? Math.max(4, 10 * nF() / viewW()) : 1);   // about 10 screen pixels per frame at most
function setAxisWidth() { tlInner.style.setProperty('--axis-w', Math.round(viewW() * zoom) + 'px'); }

/* ---------- zoom ---------- */
// Remember which part of the video is in the middle of the view, so a window resize can keep it there
let viewCentre = 0.5;
function rememberView() { if (meta && axis.clientWidth) viewCentre = (strip.scrollLeft + viewW() / 2) / axis.clientWidth; }
function afterZoom() {
  lastVW = viewW();
  $('zVal').textContent = (zoom < 10 ? zoom.toFixed(1).replace('.0', '') : Math.round(zoom)) + '×';
  const mz = maxZoom();
  $('zSlider').value = mz > 1 ? Math.round(Math.log(zoom) / Math.log(mz) * 1000) : 0;
  renderRuler(); renderTimeline();
}
// Keep the point under screen x (default: the middle of the visible axis) where it is while the zoom changes.
function setZoom(z, anchorX) {
  if (!meta) return;
  const sr = strip.getBoundingClientRect(), ar = axis.getBoundingClientRect(), visL = sr.left + HW;
  const ax = anchorX == null ? visL + viewW() / 2 : clamp(anchorX, visL, sr.right);
  const frac = (ax - ar.left) / ar.width;
  zoom = clamp(z, 1, maxZoom());
  setAxisWidth();
  strip.scrollLeft = frac * axis.getBoundingClientRect().width - (ax - visL);
  afterZoom();
}
function zoomBy(factor) {       // buttons and keys: zoom around the playhead when it is on screen
  noFollow();
  const pr = playheadEl.getBoundingClientRect(), sr = strip.getBoundingClientRect(), visL = sr.left + HW;
  setZoom(zoom * factor, pr.left >= visL && pr.left <= sr.right ? pr.left : null);
}
function zoomFit() { zoom = 1; setAxisWidth(); strip.scrollLeft = 0; afterZoom(); }
function zoomToMarker() {
  const m = byId(selId);
  if (!m) { toast('Select a marker first.'); return; }
  noFollow();
  const n = nF(), s = F(m.start), e = F(m.end);
  zoom = clamp(n / ((e - s) * 1.6), 1, maxZoom());          // the marker fills about 60% of the visible axis
  setAxisWidth();
  strip.scrollLeft = (s + e) / 2 / n * axis.getBoundingClientRect().width - viewW() / 2;
  afterZoom();
}
// Bring a frame into view (used after jumps you asked for: selecting a marker, typing a time, stepping)
function scrollToFrame(f) {
  if (zoom <= 1 || !meta) return;
  const x = f / nF() * axis.clientWidth, v0 = strip.scrollLeft, vw = viewW();
  if (x < v0 + 8 || x > v0 + vw - 8) strip.scrollLeft = x - vw * 0.2;
}
// While playing, page the view along with the playhead, unless you are dragging or just scrolled yourself
function followPlayhead(f) {
  if (zoom <= 1 || drag || video.paused || performance.now() < holdUntil) return;
  scrollToFrame(f);
}
strip.addEventListener('scroll', () => { renderRuler(); rememberView(); });
strip.addEventListener('wheel', e => {
  noFollow(6000);                                            // you are looking around: give you a few seconds before the view follows the playhead again
  if (!meta || !(e.ctrlKey || e.metaKey)) return;           // plain scrolling is left alone; Ctrl or ⌘ + wheel (or a pinch) zooms at the mouse
  e.preventDefault();
  const dy = clamp(e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY, -60, 60);
  setZoom(zoom * Math.exp(-dy * 0.012), e.clientX);
}, { passive: false });
$('zIn').addEventListener('click', () => zoomBy(2));
$('zOut').addEventListener('click', () => zoomBy(0.5));
$('zFit').addEventListener('click', zoomFit);
$('zSel').addEventListener('click', zoomToMarker);
$('zSlider').addEventListener('change', e => e.target.blur());       // so Space, M and the arrow keys work right after zooming
$('zSlider').addEventListener('pointerup', e => e.target.blur());
$('zSlider').addEventListener('input', e => {
  if (!meta) return;
  noFollow();
  const pr = playheadEl.getBoundingClientRect(), sr = strip.getBoundingClientRect(), visL = sr.left + HW;
  setZoom(Math.exp(e.target.value / 1000 * Math.log(maxZoom())), pr.left >= visL && pr.left <= sr.right ? pr.left : null);
});

// Keep the same stretch of video in view when the window changes size
let lastVW = 0;
function onTimelineResize() {
  if (!meta) { setAxisWidth(); return; }
  const vw = viewW();
  if (zoom > maxZoom()) zoom = maxZoom();
  setAxisWidth();
  if (zoom > 1 && lastVW && Math.abs(vw - lastVW) > 1) strip.scrollLeft = viewCentre * axis.clientWidth - vw / 2;     // keep the same stretch of video in the middle
  afterZoom();
}

/* ---------- ruler, in/out marks ---------- */
const RULER_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
function renderRuler() {
  ruler.querySelectorAll('i.t').forEach(e => e.remove());
  if (!meta) { renderIO(); return; }
  const dur = nF() / fps, W = axis.clientWidth || 600, vw = viewW(), sl = strip.scrollLeft;
  const stepS = RULER_STEPS.find(s => s / dur * W >= 84) || 3600;
  // Only draw the labels near what is on screen (one screen of margin each side) so a long, zoomed-in video stays light.
  const t0 = Math.max(0, (sl - vw) / W * dur), t1 = Math.min(dur, (sl + 2 * vw) / W * dur);
  const frag = document.createDocumentFragment();
  for (let i = Math.floor(t0 / stepS); i * stepS <= t1 + 1e-9; i++) {
    const t = i * stepS, hh = Math.floor(t / 3600), mm = Math.floor(t % 3600 / 60), ss = t % 60;
    const txt = hh ? hh + ':' + pad2(mm) + ':' + pad2(Math.round(ss))
                   : (stepS < 1 ? mm + ':' + ss.toFixed(1).padStart(4, '0') : mm + ':' + pad2(Math.round(ss)));
    frag.appendChild(h('i', { class: 't maj', style: 'left:' + (t / dur * 100) + '%' }, h('span', { text: txt })));
    for (let j = 1; j < 5; j++) {
      const tm = (i + j / 5) * stepS;
      if (tm < dur) frag.appendChild(h('i', { class: 't', style: 'left:' + (tm / dur * 100) + '%' }));
    }
  }
  ruler.appendChild(frag);
  renderIO();
}
function renderIO() {
  ioLayer.textContent = '';
  $('inVal').textContent = inF == null ? '—' : tcf(T(inF));
  $('outVal').textContent = outF == null ? '—' : tcf(T(outF));
  $('bClearIO').hidden = inF == null && outF == null;
  if (!meta) return;
  const n = nF(), add = (cls, f, txt) => {
    const d = h('div', { class: cls, style: 'left:' + (f / n * 100) + '%' }, txt ? h('span', { text: txt }) : null);
    ioLayer.appendChild(d); return d;
  };
  if (inF != null && outF != null && outF > inF) add('band', inF).style.width = ((outF - inF) / n * 100) + '%';
  if (inF != null) add('flag', inF, 'I');
  if (outF != null) add('flag out', outF, 'O');
}

/* ---------- tracks and clips ---------- */
function renderTimeline() {
  lanes.textContent = ''; heads.textContent = '';
  if (!meta) { lanes.appendChild(h('div', { class: 'none', text: 'Open a video to start marking it up.' })); return; }
  const n = nF(), order = sorted(), groups = new Map(), minF = 8 * nF() / Math.max(1, axis.clientWidth || 600);   // a clip is drawn at least 8 px wide
  order.forEach((m, i) => { const k = typeLabel(m); if (!groups.has(k)) groups.set(k, []); groups.get(k).push([m, i + 1]); });
  const keys = [...groups.keys()].sort((a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b));
  const W = axis.clientWidth || 600;
  let y = 0;
  if (!keys.length) {
    heads.appendChild(h('div', { class: 'head', style: '--tc:' + colorOf('note') + ';top:0;height:64px' }, icon('layers'), 'Markers'));
    lanes.appendChild(h('div', { class: 'none', text: 'No markers yet. Press M, or drag on this track to mark a stretch.' }));
    lanes.appendChild(h('div', { class: 'trk', 'data-type': 'note', style: 'top:0;height:64px' }));
    heads.style.minHeight = lanes.style.height = '64px';       // min-height, so the name column still stretches to the bottom and hides the playhead behind it
    return;
  }
  keys.forEach((k, ti) => {
    const items = groups.get(k), ends = [], laneOf = new Map(), tcol = colorOf(k);
    items.forEach(([m]) => {          // overlapping markers of one type go on separate rows so none is hidden
      let l = ends.findIndex(e => e <= F(m.start));
      if (l < 0) { l = ends.length; ends.push(0); }
      ends[l] = Math.max(F(m.end), F(m.start) + minF); laneOf.set(m.id, l);        // pack by what you see on screen, so short nearby clips never hide each other
    });
    const th = Math.max(1, ends.length) * LANE_H + TRK_PAD * 2;
    heads.appendChild(h('div', { class: 'head', style: '--tc:' + tcol + ';top:' + y + 'px;height:' + th + 'px', title: helpOf(k) }, icon(iconOf(k)), k, h('span', { class: 'n', text: String(items.length) })));
    lanes.appendChild(h('div', { class: 'trk' + (ti % 2 ? ' alt' : ''), 'data-type': k === 'custom' ? '' : k, style: 'top:' + y + 'px;height:' + th + 'px' }));
    items.forEach(([m, num]) => {
      const s = F(m.start), e = F(m.end), wpx = (e - s) / n * W, snippet = m.comment.trim().replace(/\s+/g, ' ').slice(0, 60);
      lanes.appendChild(h('div', {
        class: 'clip' + (m.id === selId ? ' sel' : '') + (wpx < 26 ? ' tiny' : ''), 'data-id': m.id,
        style: '--tc:' + tcol + ';left:' + (s / n * 100) + '%;width:' + ((e - s) / n * 100) + '%;top:' + (y + TRK_PAD + laneOf.get(m.id) * LANE_H) + 'px',
        title: '#' + num + ' ' + k + ' · ' + tcf(m.start) + ' to ' + tcf(m.end) + (m.comment ? '\n' + m.comment : '')
      }, h('i', { class: 'e l', 'data-side': 'l' }), h('span', { class: 'lbl' }, h('b', { text: String(num) }), snippet), h('i', { class: 'e r', 'data-side': 'r' })));
    });
    y += th;
  });
  heads.style.minHeight = lanes.style.height = y + 'px';
}

/* ---------- mouse on the timeline ----------
   click = jump, drag on empty track = new range, drag a clip = move, drag its ends = resize, ruler = scrub */
const fracF = x => { const r = axis.getBoundingClientRect(); return (x - r.left) / r.width * nF(); };   // float frame under the mouse, at any zoom and scroll
function edgeScroll(x) {         // dragging near the left or right edge of a zoomed timeline scrolls it along
  if (zoom <= 1) return;
  const sr = strip.getBoundingClientRect();
  if (x < sr.left + HW + 28) strip.scrollLeft -= 18; else if (x > sr.right - 28) strip.scrollLeft += 18;
}
strip.addEventListener('pointerdown', e => {
  if (!meta || e.button !== 0) return;
  if (e.target === strip) { noFollow(8000); return; }                 // a press on the strip's own scrollbar
  if (e.target.closest('.tl-heads, .tl-corner') || e.clientX < strip.getBoundingClientRect().left + HW) return;      // the track-name column
  flushEdits();
  noFollow();
  try { strip.setPointerCapture(e.pointerId); } catch (x) { /* synthetic events */ }
  const ff = fracF(e.clientX), clipEl = e.target.closest('.clip');
  if (e.target.closest('#ruler')) { drag = { kind: 'scrub', x0: e.clientX, moved: false }; video.pause(); seekFrame(Math.floor(ff)); return; }
  if (clipEl) {
    const m = byId(clipEl.dataset.id), side = e.target.dataset.side;
    selBox = null;                                                    // clicking the marker itself means Delete now removes the marker, not a box picked earlier
    selectMarker(m.id, { seek: false });
    drag = { kind: side === 'l' ? 'l' : side === 'r' ? 'r' : 'move', id: m.id, x0: e.clientX, ff0: ff, sF: F(m.start), eF: F(m.end), moved: false };
    return;
  }
  const trk = e.target.closest('.trk');
  drag = { kind: 'create', type: (trk && trk.dataset.type) || 'note', gy: (trk ? parseFloat(trk.style.top) || 0 : 0) + TRK_PAD, x0: e.clientX, ff0: ff, moved: false };
});
strip.addEventListener('pointermove', e => {
  if (!drag) return;
  if (!drag.moved && Math.abs(e.clientX - drag.x0) < 3) return;       // still a click, not a drag
  drag.moved = true;
  edgeScroll(e.clientX);
  const ff = fracF(e.clientX), n = nF();
  if (drag.kind === 'scrub') { seekFrame(Math.floor(ff)); return; }
  if (drag.kind === 'create') {
    let g = lanes.querySelector('.rubber');
    if (!g) { g = h('div', { class: 'rubber', style: 'top:' + drag.gy + 'px;height:26px;border-radius:6px' }); lanes.appendChild(g); }
    const a = clamp(Math.round(drag.ff0), 0, n), b = clamp(Math.round(ff), 0, n);
    drag.a = a; drag.b = b;
    g.style.left = (Math.min(a, b) / n * 100) + '%'; g.style.width = (Math.abs(b - a) / n * 100) + '%';
    return;
  }
  const m = byId(drag.id); if (!m) return;
  const d = Math.round(ff - drag.ff0);
  if (drag.kind === 'move') {
    const len = drag.eF - drag.sF, s = clamp(drag.sF + d, 0, n - len);
    m.start = T(s); m.end = T(s + len);
  } else if (drag.kind === 'l') m.start = T(clamp(drag.sF + d, 0, drag.eF - 1));
  else m.end = T(clamp(drag.eF + d, drag.sF + 1, n));
  changed();
});
function endDrag() {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.kind === 'scrub') return;
  if (d.kind === 'create') {
    lanes.querySelectorAll('.rubber').forEach(g => g.remove());
    if (!d.moved) { seekFrame(Math.floor(d.ff0)); return; }
    const s = Math.min(d.a, d.b), en = Math.max(d.a, d.b);
    if (en - s >= 1) addMarker(T(s), T(en), { type: d.type, seek: true });
    return;
  }
  if (!d.moved) {   // plain click on a clip: just jump to that spot inside it
    const m = byId(d.id);
    if (m) seekFrame(clamp(Math.floor(d.ff0), F(m.start), F(m.end) - 1));
    return;
  }
  commit();
}
strip.addEventListener('pointerup', endDrag);
strip.addEventListener('pointercancel', endDrag);

// Right-click a marker: select it and offer Delete (Undo brings it back)
strip.addEventListener('contextmenu', e => {
  const clipEl = meta && e.target.closest && e.target.closest('.clip');
  if (!clipEl) return;                                                // anywhere else the browser's own menu stays
  e.preventDefault();
  const m = byId(clipEl.dataset.id); if (!m) return;
  selBox = null; selectMarker(m.id, { seek: false });
  const x = e.clientX, y = e.clientY;
  const menu = h('div', { class: 'menu', role: 'menu', style: 'min-width:170px' },
    h('button', { role: 'menuitem', onclick: () => { closePopover(); deleteMarker(m.id); } }, icon('trash'), 'Delete marker'));
  openPopover({ getBoundingClientRect: () => ({ left: x, right: x, top: y - 6, bottom: y - 6 }), contains: () => false }, menu);       // a point, not an element, to hang the menu on
  const b = menu.querySelector('button'); if (b) b.focus();
});

/* ---------- the bar between the video and the timeline: drag to resize ---------- */
// How tall the timeline may be: at most 62% of the window and at most what the page grid leaves room for (styles.css: 100vh - 340px, never under 150px).
// The splitter and the saved height use the same limits, so the bar follows the mouse all the way and no hidden overshoot is stored.
function tlLimits() { const H = window.innerHeight, hi = Math.min(Math.round(H * 0.62), Math.max(150, H - 340)); return [Math.min(170, hi), hi]; }
(() => {
  const sp = $('splitter');
  let dragging = null;
  sp.addEventListener('pointerdown', e => { try { sp.setPointerCapture(e.pointerId); } catch (x) { /* synthetic events */ } sp.classList.add('drag'); dragging = { y0: e.clientY, h0: $('timeline').offsetHeight }; });
  sp.addEventListener('pointermove', e => {
    if (!dragging) return;
    const lim = tlLimits(), hgt = clamp(dragging.h0 + (dragging.y0 - e.clientY), lim[0], lim[1]);
    app.style.setProperty('--tlh', hgt + 'px');
  });
  const stop = () => { if (dragging) { dragging = null; sp.classList.remove('drag'); ui.tlh = $('timeline').offsetHeight; saveUi(); fitStage(); } };
  sp.addEventListener('pointerup', stop); sp.addEventListener('pointercancel', stop);
})();
