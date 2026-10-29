/* =====================================================================
   01 - Core: types, helpers, state, saving, undo/redo, toast, modals
   ===================================================================== */
const SVG_NS = 'http://www.w3.org/2000/svg';

// [name, icon, what it tells the assistant]
const TYPES = [
  ['cut', 'scissors', 'Remove this sound or section'],
  ['visual', 'image', 'Add a picture, screenshot or clip over the video'],
  ['list', 'list', 'Show a list on screen'],
  ['diagram', 'diagram', 'Show a diagram on screen'],
  ['note', 'note', 'A comment only, no edit']
];
const TYPE_NAMES = TYPES.map(t => t[0]);
const VISUAL_TYPES = ['visual', 'list', 'diagram'];   // types that can carry a styled visual
// Types that used to exist. Old saved markers that have one become a "visual" marker (they keep their callout / lower-third look as the visual's kind).
const RETIRED_TYPES = ['callout', 'lower-third'];
const COLORS = { cut: '#ef5350', visual: '#a78bfa', list: '#34d399', diagram: '#38bdf8', note: '#94a3b8' };
const CUSTOM_COLOR = '#e879f9';
const colorOf = t => COLORS[t] || CUSTOM_COLOR;
const typeLabel = m => m.type || 'custom';
const typeInfo = t => TYPES.find(x => x[0] === t);
const iconOf = t => (typeInfo(t) || [0, 'tag'])[1];
const helpOf = t => { const f = typeInfo(t); return f ? f[2] : 'Your own instruction for the assistant'; };
const isVisualType = t => VISUAL_TYPES.indexOf(t) >= 0;
const typeRank = k => { const i = TYPE_NAMES.indexOf(k); return i < 0 ? 100 : i; };

/* ---------- small helpers ---------- */
const $ = id => document.getElementById(id);
const pad2 = n => String(n).padStart(2, '0');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r4 = v => Math.round(v * 10000) / 10000;
const sec2 = v => (Math.round(Math.max(0, v) * 100) / 100).toFixed(2);       // rounds exactly like tc() below, so the two never disagree
const letter = i => (i >= 26 ? String.fromCharCode(65 + Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));
let uidN = 0;
const uid = () => 'm' + Date.now().toString(36) + (uidN++).toString(36);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
const MOD = isMac ? '⌘' : 'Ctrl';

// Build a DOM element:  h('div', {class:'x', onclick: fn, text:'..'}, child, child...)
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const k in (props || {})) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  kids.flat(2).forEach(c => { if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c))); });
  return e;
}
function icon(name, cls) {
  const s = document.createElementNS(SVG_NS, 'svg'), u = document.createElementNS(SVG_NS, 'use');
  s.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
  s.setAttribute('aria-hidden', 'true');
  u.setAttribute('href', '#i-' + name);
  s.appendChild(u);
  return s;
}
// Put the icon named in data-icon into every such element (buttons, tabs, round badges)
function mountIcons(root) {
  (root || document).querySelectorAll('[data-icon]:not([data-icon-done])').forEach(el => {
    el.setAttribute('data-icon-done', '1');
    el.insertBefore(icon(el.getAttribute('data-icon')), el.firstChild);
  });
}
function setIcon(btn, name) { const u = btn.querySelector('use'); if (u) u.setAttribute('href', '#i-' + name); }

// Timecode like 0:03.17 (or 1:02:03.17). Rounds to hundredths (or thousandths when digits = 3) first.
function tc(seconds, digits) {
  const d = digits === 3 ? 1000 : 100, w = digits === 3 ? 3 : 2;
  const total = Math.round(Math.max(0, seconds) * d), f = total % d;
  const whole = Math.floor(total / d), s = whole % 60, m = Math.floor(whole / 60) % 60, hh = Math.floor(whole / 3600);
  return (hh ? hh + ':' + pad2(m) : String(m)) + ':' + pad2(s) + '.' + String(f).padStart(w, '0');
}
// Frame rates like 29.97 are really 30000/1001; use the exact fraction so long videos do not drift.
function normFps(v) {
  for (const [shown, exact] of [[23.976, 24000 / 1001], [29.97, 30000 / 1001], [47.952, 48000 / 1001], [59.94, 60000 / 1001]]) {
    if (Math.abs(v - shown) < 0.006) return exact;
  }
  return v;
}
const fmtFps = v => String(parseFloat(v.toFixed(3)));
const tcd = () => (fps > 100 ? 3 : 2);                 // at very high frame rates two decimals cannot name every frame
const tcf = s => tc(s, tcd());

// Scroll a panel just enough to show a child. Never moves the page itself.
function revealIn(container, el) {
  if (!container || !el) return;
  const c = container.getBoundingClientRect(), r = el.getBoundingClientRect();
  if (r.top < c.top) container.scrollTop -= c.top - r.top + 8;
  else if (r.bottom > c.bottom) container.scrollTop += r.bottom - c.bottom + 8;
}

// Finish a half-typed value in a text box before the next mouse action reads the marker times
function flushEdits() {
  const a = document.activeElement;
  if (a && a !== document.body && a.matches && a.matches('input, textarea') && !a.closest('.modal, .picker, .cp-root')) a.blur();
}

/* ---------- elements and state ---------- */
const app = $('app'), video = $('video'), stage = $('stage'), stageWrap = $('stageWrap'), overlay = $('overlay'), dropEl = $('drop');
const strip = $('strip'), tlInner = $('tlInner'), axis = $('axis'), ruler = $('ruler'), lanes = $('lanes'), heads = $('heads'), ioLayer = $('ioLayer');
const playheadEl = $('playhead'), phHead = $('phHead'), listEl = $('list'), propsEl = $('props'), toastEl = $('toast');

let meta = null;          // { name, w, h, duration } once a video is open
let fps = 30;
let markers = [];         // { id, type, start, end, comment, boxes:[{id,x,y,w,h}], visual? }   times in seconds, boxes in video pixels
let selId = null, selBox = null;
let inF = null, outF = null;   // in / out points as frame numbers
let ver = 0;              // bumped on every change so the video overlay knows to redraw
let objectUrl = null, pendingName = '';

const nF = () => Math.max(1, Math.round(meta.duration * fps));   // number of frames
const F = t => Math.round(t * fps);                              // seconds -> frame
const T = f => f / fps;                                          // frame -> seconds
const byId = id => markers.find(m => m.id === id);
const sorted = () => markers.map((m, i) => [m, i]).sort((a, b) => a[0].start - b[0].start || a[1] - b[1]).map(x => x[0]);
const curFrame = () => clamp(Math.floor(video.currentTime * fps + 1e-4), 0, nF() - 1);
const inRange = (m, f) => F(m.start) <= f && f < F(m.end);

/* ---------- saving in the browser, per video ---------- */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  // true when it was saved. false: the storage is full or blocked; the app still works, but the audio cleanup panel (which reads this answer) and saveNow() tell the user
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
};
const storeKey = () => 'vrt:' + meta.name + '|' + meta.duration.toFixed(3);
let saveTimer = null, saveWarned = false;
function saveNow() {
  clearTimeout(saveTimer);
  if (!meta) return;
  const ok = store.set(storeKey(), JSON.stringify({ v: 2, fps, markers }));
  store.set('vrt:last', JSON.stringify({ name: meta.name, duration: meta.duration }));
  if (!ok && !saveWarned) { saveWarned = true; toast('This browser could not save your markers (its storage is full or blocked). Use File, Save session to keep a copy.', 8000); }
}
const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); };

/* ---------- undo / redo (snapshots of the markers) ---------- */
let hist = [], hi = -1;
const snap = () => JSON.stringify({ fps, markers });
function syncUndo() { $('btnUndo').disabled = hi <= 0; $('btnRedo').disabled = hi >= hist.length - 1; }
function resetHistory() { hist = [snap()]; hi = 0; syncUndo(); }
// Call after a finished edit (not on every mouse move).
function commit() {
  const s = snap();
  if (s !== hist[hi]) {
    hist.length = hi + 1; hist.push(s);
    if (hist.length > 300) hist.shift();
    hi = hist.length - 1;
  }
  syncUndo(); saveNow();
}
function applySnap(s) {
  const o = JSON.parse(s);
  fps = o.fps; markers = o.markers;
  const f = $('fps'); if (f) f.value = fmtFps(fps);
  if (selId && !byId(selId)) selId = null;
  const sm = byId(selId);
  if (selBox && !(sm && sm.boxes.some(b => b.id === selBox))) selBox = null;
  inF = outF = null;
  renderRuler(); changed(); syncUndo(); saveNow();
  cleanupSyncAfterJump();
}
function undo() { if (meta && hi > 0) { hi--; applySnap(hist[hi]); } }
function redo() { if (meta && hi < hist.length - 1) { hi++; applySnap(hist[hi]); } }

/* ---------- toast ---------- */
let toastTimer;
function toast(msg, ms) {
  toastEl.textContent = msg; toastEl.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms || 3200);
}

/* ---------- popovers (menus, pickers) and modals ---------- */
let popClose = null;
function closePopover() { if (popClose) { const c = popClose; popClose = null; c(); } }
// Show `content` next to `anchor`. Closes on outside click or Escape.
function openPopover(anchor, content, opts) {
  closePopover();
  opts = opts || {};
  const root = $('popRoot');
  root.appendChild(content);
  const a = anchor.getBoundingClientRect(), cw = content.offsetWidth, ch = content.offsetHeight;
  let left = opts.alignRight ? a.right - cw : a.left;
  left = clamp(left, 8, window.innerWidth - cw - 8);
  let top = a.bottom + 6;
  if (top + ch > window.innerHeight - 8) top = Math.max(8, a.top - ch - 6);
  content.style.left = left + 'px'; content.style.top = top + 'px';
  const onDown = e => { if (!content.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
  popClose = () => { document.removeEventListener('pointerdown', onDown, true); content.remove(); if (opts.onClose) opts.onClose(); };
  return closePopover;
}
const modalStack = [];
function closeModal() { const m = modalStack.pop(); if (m) { m.back.remove(); if (m.onClose) m.onClose(); } }
function openModal(o) {
  const back = h('div', { class: 'backdrop', onpointerdown: e => { if (e.target === back) closeModal(); } });
  const bodyEl = h('div', { class: 'modal-body' }, o.body);
  const footEl = o.footer ? h('div', { class: 'modal-foot' }, o.footer) : null;
  const box = h('div', { class: 'modal' + (o.narrow ? ' narrow' : ''), role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' }, h('h3', { text: o.title || '' }),
      h('button', { class: 'btn icon ghost', title: 'Close (Esc)', onclick: closeModal }, icon('x'))),
    bodyEl, footEl);
  back.appendChild(box);
  $('modalRoot').appendChild(back);
  modalStack.push({ back, onClose: o.onClose });
  return { bodyEl, footEl, box, close: closeModal };
}
