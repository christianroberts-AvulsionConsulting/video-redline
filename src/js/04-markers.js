/* =====================================================================
   04 - Markers: add, select, edit; the marker list (left) and properties (right)
   ===================================================================== */
function changed(opts) {
  ver++; renderTimeline(); renderList();
  if (!(opts && opts.keepProps)) renderProps();               // typing a time keeps the panel as it is, so Tab and clicks keep working
  refreshOverlay(); cleanupMarkersChanged();
  const sel = selId && listEl.querySelector('.mcard.sel'); if (sel) revealIn(listEl, sel);       // the list re-sorts: keep the selected card in view
}

function newMarker(type, start, end) {
  const m = { id: uid(), type, start, end, comment: '', boxes: [] };
  if (isVisualType(type)) m.visual = defaultVisual(type);
  return m;
}
function addMarker(start, end, opts) {
  opts = opts || {};
  const m = newMarker(opts.type || 'note', start, end);
  markers.push(m);
  commit();
  selectMarker(m.id, { seek: !!opts.seek });
}
function addAtPlayhead() {
  if (!meta) { toast('Open a video first.'); return; }
  const pf = curFrame(), one = Math.round(fps), n = nF();
  let s = inF, e = outF;
  if (s == null && e == null) { s = pf; e = pf + one; }
  else if (e == null) e = pf > s ? pf : s + one;      // only an In point: close the range at the playhead
  else if (s == null) s = pf < e ? pf : e - one;      // only an Out point: start at the playhead
  if (e <= s) e = s + one;
  s = clamp(s, 0, n - 1); e = clamp(e, s + 1, n);
  inF = outF = null;
  addMarker(T(s), T(e), { type: 'note' });
}
function selectMarker(id, opts) {
  opts = opts || {};
  if (id !== selId) selBox = null;
  selId = id;
  changed();
  const m = byId(id);
  if (m && opts.seek) seekFrame(F(m.start), true);
  if (opts.scroll !== false) revealIn(listEl, listEl.querySelector('.mcard[data-id="' + id + '"]'));
}
function duplicateMarker(id) {
  const src = byId(id); if (!src) return;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = uid(); copy.boxes.forEach(b => { b.id = uid(); });
  delete copy.origin;                       // a copy is not the cut the cleanup panel made
  markers.splice(markers.indexOf(src) + 1, 0, copy);
  commit(); selectMarker(copy.id, { seek: false });
}
function deleteMarker(id) {
  markers = markers.filter(m => m.id !== id);
  if (selId === id) { selId = null; selBox = null; }
  commit(); changed();
  toast('Marker deleted. Undo brings it back (' + MOD + (isMac ? 'Z' : '+Z') + ').');
}
function deleteBox(m, bid) {
  m.boxes = m.boxes.filter(b => b.id !== bid);
  if (selBox === bid) selBox = null;
  commit(); changed();
}
function setIn() { if (!meta) return; inF = curFrame(); if (outF != null && outF <= inF) outF = null; renderIO(); }
function setOut() {
  if (!meta) return;
  const f = curFrame();
  if (inF != null && f <= inF) { toast('The Out point has to come after the In point.'); return; }
  outF = f; renderIO();
}
function setType(m, type) {
  if (type === m.type) return;                      // clicking the type that is already chosen changes nothing
  const old = m.type;
  m.type = type;
  if (isVisualType(type)) {
    const v = m.visual;
    if (!v) m.visual = defaultVisual(type);
    else if (!hasText(v) && v.kind === VIS.defaultKind(old)) {       // no typed words and no kind picked by hand: the kind follows the type; style, who writes the words, size, panel and accent stay
      const d = defaultVisual(type), op = v.opts || {};
      d.style = v.style || d.style; d.textBy = v.textBy || d.textBy;
      d.opts.scale = op.scale; d.opts.bg = op.bg; d.opts.accent = op.accent;
      m.visual = d;
    }
  }
  commit(); changed();
}

/* ---------- typed times: 83.5, 1:23.5 or 1:02:03.5 (an "s" on the end is fine) ---------- */
function parseTime(text) {
  const parts = String(text).trim().replace(/s$/i, '').split(':').map(p => p.trim());
  if (parts.length > 3 || parts.some(p => !/^(\d+\.?\d*|\.\d+)$/.test(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
}
function setTimeFromText(m, which, text) {
  if (!meta) { toast('Open a video first.'); return; }
  const t = parseTime(text);
  if (!isFinite(t)) { toast('Type a time like 1:23.45 or 83.5'); return; }
  const f = Math.round(t * fps), n = nF();
  let want;
  if (which === 'start') { want = clamp(f, 0, F(m.end) - 1); m.start = T(want); }
  else { want = clamp(f, F(m.start) + 1, n); m.end = T(want); }
  if (want !== f) toast(which === 'start' ? 'The start has to be inside the video and before the end.' : 'The end has to be inside the video and after the start.', 4000);
  commit(); changed({ keepProps: true }); syncTimeFields(m);
  seekFrame(which === 'start' ? want : want - 1, true);      // show the frame you just set (the last frame inside the marker for an end time)
}
function setEdgeToPlayhead(m, which) {
  const f = curFrame();
  if (which === 'start') { if (f >= F(m.end)) { toast('The start has to come before the end.'); return; } m.start = T(f); }
  else { if (f <= F(m.start)) { toast('The end has to come after the start.'); return; } m.end = T(f); }
  commit(); changed({ keepProps: true }); syncTimeFields(m);
}
// Bring the Start / End boxes and the length line up to date without rebuilding the panel
function syncTimeFields(m) {
  const s = propsEl.querySelector('[data-fk=start]'), e = propsEl.querySelector('[data-fk=end]'), len = propsEl.querySelector('.timelen');
  if (s && document.activeElement !== s) s.value = tcf(m.start);
  if (e && document.activeElement !== e) e.value = tcf(m.end);
  if (len) len.textContent = sec2(m.end - m.start) + ' s long · frames ' + F(m.start) + ' to ' + F(m.end);
}

/* ---------- marker list (left panel) ---------- */
function renderList() {
  listEl.textContent = '';
  const order = sorted();
  order.forEach((m, i) => listEl.appendChild(markerCard(m, i + 1)));
  $('countBadge').textContent = markers.length;
  $('emptyMsg').hidden = markers.length > 0;
}
function markerCard(m, num) {
  const hasComment = !!m.comment.trim(), pills = [];
  if (m.boxes.length) pills.push(h('span', { class: 'pill' }, icon('box'), m.boxes.length + (m.boxes.length === 1 ? ' box' : ' boxes')));
  if (m.visual && isVisualType(m.type)) {
    const st = styleById(m.visual.style), desc = kindLabel(m.visual.kind) + (st ? ' · ' + st.name : '');
    pills.push(h('span', { class: 'pill', title: desc }, icon('sparkles'), h('span', { class: 'ptxt', text: desc })));
    if (isAiText(m.visual)) pills.push(h('span', { class: 'pill', title: 'The assistant writes the words from the comment' }, 'AI text'));       // its own pill, so a long style name cannot push it out
  }
  return h('div', { class: 'mcard' + (m.id === selId ? ' sel' : ''), 'data-id': m.id, style: '--tc:' + colorOf(m.type), onclick: () => selectMarker(m.id, { seek: true, scroll: false }) },
    h('div', { class: 'mcard-top' }, h('span', { class: 'mnum', text: String(num) }), h('span', { class: 'mtype' }, icon(iconOf(m.type)), typeLabel(m)), h('span', { class: 'mdur', text: sec2(m.end - m.start) + ' s' })),
    h('div', { class: 'mtime', text: tcf(m.start) + ' → ' + tcf(m.end) }),
    h('div', { class: 'mcomment' + (hasComment ? '' : ' none'), text: hasComment ? m.comment.trim() : 'No comment yet' }),
    pills.length ? h('div', { class: 'mmeta' }, pills) : null,
    h('div', { class: 'mactions' },
      h('button', { class: 'btn icon ghost', title: 'Duplicate', onclick: e => { e.stopPropagation(); duplicateMarker(m.id); } }, icon('duplicate')),
      h('button', { class: 'btn icon ghost danger', title: 'Delete', onclick: e => { e.stopPropagation(); deleteMarker(m.id); } }, icon('trash'))));
}

/* ---------- properties of the selected marker (right panel) ---------- */
function captureFocus() {
  const a = document.activeElement;
  if (a && propsEl.contains(a) && a.dataset && a.dataset.fk) return { fk: a.dataset.fk, s: a.selectionStart, e: a.selectionEnd };
  return null;
}
function restoreFocus(f) {
  if (!f) return;
  const el = propsEl.querySelector('[data-fk="' + f.fk + '"]');
  if (el) { el.focus(); try { if (f.s != null) el.setSelectionRange(f.s, f.e); } catch (e) { /* not a text field */ } }
}
let lastPropsId = null;
function renderProps() {
  const keep = captureFocus();
  let top = propsEl.scrollTop;
  if (selId !== lastPropsId) { top = 0; lastPropsId = selId; }       // a different marker starts at the top
  propsEl.textContent = '';
  const m = byId(selId);
  $('propTitle').textContent = 'Properties';
  if (!m) {
    propsEl.appendChild(h('div', { class: 'empty empty-props' }, h('span', { class: 'empty-ic', 'data-icon': 'settings' }), h('b', { text: 'Nothing selected' }),
      h('p', { text: 'Select a marker in the list or on the timeline to change its type, times, comment, boxes and visual.' })));
    mountIcons(propsEl);
    return;
  }
  const num = sorted().indexOf(m) + 1;
  propsEl.appendChild(h('div', { class: 'props-head', style: '--tc:' + colorOf(m.type) },
    h('span', { class: 'big-num', text: '#' + num }), h('span', { class: 'what', text: typeLabel(m) }), h('span', { class: 'grow' }),
    h('button', { class: 'btn icon sm', title: 'Duplicate this marker', onclick: () => duplicateMarker(m.id) }, icon('duplicate')),
    h('button', { class: 'btn icon sm danger', title: 'Delete this marker', onclick: () => deleteMarker(m.id) }, icon('trash'))));
  propsEl.appendChild(secType(m));
  propsEl.appendChild(secComment(m));          // the comment is what you fill in most, so it sits high in the panel
  propsEl.appendChild(secTime(m));
  if (isVisualType(m.type) && typeof buildVisualSection === 'function') propsEl.appendChild(buildVisualSection(m));
  propsEl.appendChild(secBoxes(m));
  mountIcons(propsEl);
  flushInsert();
  propsEl.scrollTop = top;
  restoreFocus(keep);
}
function secType(m) {
  const custom = !TYPE_NAMES.includes(m.type);
  const grid = h('div', { class: 'typegrid' },
    TYPES.map(([name, ic]) => h('button', { class: 'tbtn' + (m.type === name ? ' on' : ''), style: '--tc:' + colorOf(name), title: helpOf(name), onclick: () => setType(m, name) }, icon(ic), name)),
    h('button', { class: 'tbtn' + (custom ? ' on' : ''), style: '--tc:' + CUSTOM_COLOR, title: 'Your own instruction', onclick: () => { setType(m, ''); const i = propsEl.querySelector('[data-fk=ctype]'); if (i) i.focus(); } }, icon('tag'), 'custom'));
  const sec = h('div', { class: 'sec' }, h('h4', { text: 'Type' }), grid, h('div', { class: 'typehelp', text: helpOf(m.type) }));
  if (custom) {
    const inp = h('input', { type: 'text', 'data-fk': 'ctype', placeholder: 'Type your own instruction, e.g. zoom in', maxlength: 40, value: m.type, 'aria-label': 'Custom type' });
    inp.addEventListener('input', () => { m.type = inp.value.replace(/[\[\]\r\n]/g, '').trim(); queueSave(); renderTimeline(); renderList(); });
    inp.addEventListener('change', () => { commit(); changed(); });
    sec.appendChild(h('div', { class: 'custom-type' }, inp));
  }
  return sec;
}
function timeField(m, which) {
  const inp = h('input', { type: 'text', 'data-fk': which, value: tcf(which === 'start' ? m.start : m.end), inputmode: 'decimal', spellcheck: 'false',
    title: 'Type a time like 1:23.45 or 83.5', 'aria-label': which === 'start' ? 'Start time' : 'End time' });
  inp.addEventListener('change', () => {
    if (inp.dataset.cancel) { delete inp.dataset.cancel; inp.value = tcf(m[which]); return; }
    setTimeFromText(m, which, inp.value);
    const cur = $('props').querySelector('[data-fk="' + which + '"]'); if (cur) cur.value = tcf(m[which]);
  });
  inp.addEventListener('blur', () => { setTimeout(() => { delete inp.dataset.cancel; }, 0); });       // an Escape never carries over to the next edit
  inp.addEventListener('focus', () => { delete inp.dataset.cancel; setTimeout(() => { try { inp.select(); } catch (x) { /* ignore */ } }, 0); });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') inp.blur();
    else if (e.key === 'Escape') { inp.dataset.cancel = '1'; inp.value = tcf(m[which]); setTimeout(() => { delete inp.dataset.cancel; }, 0); }       // Escape cancels the edit; the flag only lives until the key press is handled
  });
  return h('div', { class: 'timefield' }, which === 'start' ? 'Start' : 'End',
    h('div', { class: 'row' }, inp, h('button', { class: 'btn icon', title: 'Set to the playhead', onclick: () => setEdgeToPlayhead(m, which) }, icon('marker'))));
}
function secTime(m) {
  return h('div', { class: 'sec' }, h('h4', { text: 'Time' }),
    h('div', { class: 'timegrid' }, timeField(m, 'start'), timeField(m, 'end')),
    h('div', { class: 'timelen', text: sec2(m.end - m.start) + ' s long · frames ' + F(m.start) + ' to ' + F(m.end) }));
}
function secComment(m) {
  const ta = h('textarea', { 'data-fk': 'comment', rows: 4, placeholder: 'What should happen here? Write it for the editing assistant.', 'aria-label': 'Comment' });
  ta.value = m.comment;
  ta.addEventListener('input', () => { m.comment = ta.value; queueSave(); renderTimeline(); renderList(); if (typeof syncAiHint === 'function') syncAiHint(m); });
  ta.addEventListener('change', () => commit());
  return h('div', { class: 'sec' }, h('h4', { text: 'Comment' }), ta);
}
function secBoxes(m) {
  const f = curFrame(), tcol = colorOf(m.type);
  const rows = m.boxes.map((b, i) => h('div', { class: 'boxrow' + (b.id === selBox ? ' picked' : ''), style: '--tc:' + tcol, onclick: () => {
      selBox = b.id; if (!inRange(m, curFrame())) seekFrame(F(m.start), true); changed(); } },
    h('span', { class: 'lt', text: letter(i) }),
    h('span', { class: 'nums' }, 'x ' + b.x + '  y ' + b.y + '  w ' + b.w + '  h ' + b.h,
      h('small', { text: pct1(b.x / meta.w) + '%, ' + pct1(b.y / meta.h) + '%, ' + pct1(b.w / meta.w) + '%, ' + pct1(b.h / meta.h) + '%' })),
    h('button', { class: 'btn icon sm ghost danger', title: 'Delete this box', onclick: e => { e.stopPropagation(); deleteBox(m, b.id); } }, icon('trash'))));
  const hint = m.boxes.length
    ? 'Drag a box on the video to move it, or drag its corners to resize it.' + (inRange(m, f) ? '' : ' The playhead is outside this marker, so its boxes are hidden.')
    : 'Drag on the video to draw a box showing where a visual should sit. Without a box, the assistant picks a sensible spot.';
  return h('div', { class: 'sec' }, h('h4', {}, 'Boxes on the video'),
    m.boxes.length ? h('div', { class: 'boxlist' }, rows) : null, h('div', { class: 'hint', style: m.boxes.length ? 'margin-top:10px' : '', text: hint }));
}
const pct1 = v => (+(v * 100).toFixed(1)).toFixed(1);
