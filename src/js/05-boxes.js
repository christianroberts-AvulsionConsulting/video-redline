/* =====================================================================
   05 - Boxes on the video (and the styled visual preview inside them)
   Boxes are stored in the video's own pixels, whatever size the video is shown at.
   ===================================================================== */
let previewOn = true;
const placeBox = (el, b) => {
  el.style.left = (b.x / meta.w * 100) + '%'; el.style.top = (b.y / meta.h * 100) + '%';
  el.style.width = (b.w / meta.w * 100) + '%'; el.style.height = (b.h / meta.h * 100) + '%';
};
function renderOverlay(f) {
  overlay.textContent = '';
  overlay.classList.toggle('canDraw', !!byId(selId));
  const hosts = [];
  for (const m of markers) {
    if (!inRange(m, f)) continue;                    // boxes only show while the playhead is inside the marker
    const isSel = m.id === selId;
    m.boxes.forEach((b, i) => {
      const hasVisual = i === 0 && previewOn && m.visual && isVisualType(m.type) && typeof VIS !== 'undefined';
      const aiText = hasVisual && isAiText(m.visual);              // the words are written by the AI: the preview is a skeleton, so say so
      const el = h('div', { class: 'box ' + (isSel ? 'sel' : 'other') + (b.id === selBox ? ' picked' : '') + (hasVisual ? ' has-visual' : '') + (aiText ? ' ai-text' : ''),
        'data-m': m.id, 'data-b': b.id, style: '--tc:' + colorOf(m.type) });
      placeBox(el, b);
      if (hasVisual) { const host = h('div', { class: 'box-visual' }); el.appendChild(host); hosts.push([host, m]); }
      if (aiText) el.appendChild(h('span', { class: 'aitag', text: 'AI writes the text from your comment' }));
      if (isSel || !hasVisual) el.appendChild(h('span', { class: 'tag', text: letter(i) + ' · ' + typeLabel(m) }));
      if (isSel) {
        el.appendChild(h('span', { class: 'bdel', text: '×', title: 'Delete this box' }));
        ['nw', 'ne', 'sw', 'se'].forEach(c => el.appendChild(h('i', { class: 'hdl', 'data-c': c })));
      }
      overlay.appendChild(el);
    });
  }
  hosts.forEach(([host, m]) => renderVisualInto(host, m.visual));       // needs the host to be in the page so it can measure itself
}
// Mouse position -> video pixels. Uses the size the video is shown at, so a half-size view gives doubled numbers.
function vpt(e) {
  const r = overlay.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * meta.w, y: (e.clientY - r.top) / r.height * meta.h };
}
function rectFrom(ax, ay, bx, by) {
  const x1 = clamp(Math.round(Math.min(ax, bx)), 0, meta.w), x2 = clamp(Math.round(Math.max(ax, bx)), 0, meta.w);
  const y1 = clamp(Math.round(Math.min(ay, by)), 0, meta.h), y2 = clamp(Math.round(Math.max(ay, by)), 0, meta.h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
let bdrag = null;
overlay.addEventListener('pointerdown', e => {
  if (!meta || e.button !== 0) return;
  flushEdits();
  const p = vpt(e), boxEl = e.target.closest('.box');
  if (boxEl) {
    const m = byId(boxEl.dataset.m), b = m && m.boxes.find(x => x.id === boxEl.dataset.b); if (!b) return;
    const hd = e.target.closest('.hdl'), isDel = !!e.target.closest('.bdel');   // read these first: the overlay is redrawn below
    selId = m.id; selBox = b.id;
    if (isDel) { deleteBox(m, b.id); return; }
    changed();
    try { overlay.setPointerCapture(e.pointerId); } catch (x) { /* synthetic events */ }
    if (hd) {
      const c = hd.dataset.c;
      bdrag = { kind: 'resize', m, b, fx: c.includes('w') ? b.x + b.w : b.x, fy: c.includes('n') ? b.y + b.h : b.y };
    } else bdrag = { kind: 'move', m, b, ox: p.x - b.x, oy: p.y - b.y };
    return;
  }
  const m = byId(selId);
  if (!m) { toast('Pick a marker first (press M to add one), then drag on the video to draw a box.', 4200); return; }
  if (!inRange(m, curFrame())) { video.pause(); seekFrame(F(m.start), true); }
  try { overlay.setPointerCapture(e.pointerId); } catch (x) { /* synthetic events */ }
  bdrag = { kind: 'draw', m, x0: clamp(p.x, 0, meta.w), y0: clamp(p.y, 0, meta.h) };
});
overlay.addEventListener('pointermove', e => {
  if (!bdrag) return;
  const p = vpt(e), d = bdrag;
  if (d.kind === 'draw') {
    let g = overlay.querySelector('.rubber');
    if (!g) { g = h('div', { class: 'rubber' }); overlay.appendChild(g); }
    d.rect = rectFrom(d.x0, d.y0, p.x, p.y);
    placeBox(g, d.rect);
    return;
  }
  const el = overlay.querySelector('.box[data-b="' + d.b.id + '"]');
  if (d.kind === 'move') {
    d.b.x = clamp(Math.round(p.x - d.ox), 0, meta.w - d.b.w);
    d.b.y = clamp(Math.round(p.y - d.oy), 0, meta.h - d.b.h);
  } else {
    const r = rectFrom(d.fx, d.fy, p.x, p.y);
    if (r.w >= 4 && r.h >= 4) Object.assign(d.b, r);
  }
  if (el) { placeBox(el, d.b); const host = el.querySelector('.box-visual'); if (host) renderVisualInto(host, d.m.visual); }
});
function endBoxDrag() {
  if (!bdrag) return;
  const d = bdrag; bdrag = null;
  overlay.querySelectorAll('.rubber').forEach(g => g.remove());
  if (d.kind === 'draw') {
    const min = Math.max(4, 8 * meta.w / overlay.getBoundingClientRect().width);    // ignore accidental clicks (under 8 screen pixels)
    if (!d.rect || d.rect.w < min || d.rect.h < min) return;
    const b = Object.assign({ id: uid() }, d.rect);
    d.m.boxes.push(b); selBox = b.id;
  }
  commit(); changed();
}
overlay.addEventListener('pointerup', endBoxDrag);
overlay.addEventListener('pointercancel', endBoxDrag);

$('btnPreview').addEventListener('click', () => { previewOn = !previewOn; ui.preview = previewOn; saveUi(); syncPreviewBtn(); refreshOverlay(); });
function syncPreviewBtn() {
  const b = $('btnPreview');
  b.classList.toggle('on', previewOn);
  setIcon(b, previewOn ? 'eye' : 'eye-off');
  b.title = previewOn ? 'Showing the styled visuals on the video. Click to show plain boxes.' : 'Showing plain boxes. Click to preview the styled visuals.';
}
