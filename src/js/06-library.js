/* =====================================================================
   06 - Visuals and styles
   A "visual" is a kind (list, diagram, callout...) + a style (an Open Design design system) + its text.
   Markers of type visual / list / diagram carry one. Saved visuals live in the
   Visuals tab; styles live in the Styles tab (150 built in, more can be imported from Open Design).
   ===================================================================== */
const ODSTYLES = (() => { const el = $('od-styles'); if (!el) return []; try { return JSON.parse(el.textContent); } catch (e) { return []; } })();
const HAS_VIS = typeof VIS !== 'undefined';
if (HAS_VIS) { const s = document.createElement('style'); s.id = 'vis-css'; s.textContent = VIS.css(); document.head.appendChild(s); }
const BUILTIN_STYLE = { id: 'default', name: 'Neutral Modern', category: 'Starter', description: 'A clean, product-oriented default.', atmosphere: 'Calm, functional, quietly confident.', theme: 'light', source: 'open-design',
  t: { bg: '#fafafa', surface: '#ffffff', fg: '#111111', muted: '#6b6b6b', border: '#e5e5e5', accent: '#2f6feb', fd: "'Inter', -apple-system, 'Segoe UI', system-ui, sans-serif", fb: "'Inter', -apple-system, 'Segoe UI', system-ui, sans-serif", r: 12, sh: '0 2px 8px rgba(0,0,0,.08)', fw: 600, ls: -0.01 } };

let lib = { visuals: [], styles: [], starred: [], defStyle: 'default', seeded: false };
try { Object.assign(lib, JSON.parse(store.get('vrt:lib') || '{}')); } catch (e) { /* first run */ }
function saveLib() { store.set('vrt:lib', JSON.stringify(lib)); }
const styleIndex = new Map();
function rebuildStyleIndex() { styleIndex.clear(); ODSTYLES.forEach(s => styleIndex.set(s.id, s)); (lib.styles || []).forEach(s => styleIndex.set(s.id, s)); }
rebuildStyleIndex();
const allStyles = () => ODSTYLES.concat(lib.styles || []);
const styleById = id => styleIndex.get(id) || null;
const fallbackStyle = () => styleById(lib.defStyle) || styleById('default') || ODSTYLES[0] || BUILTIN_STYLE;
const defaultStyleId = () => fallbackStyle().id;
const isStarred = id => (lib.starred || []).indexOf(id) >= 0;
function toggleStar(id) { const i = lib.starred.indexOf(id); if (i >= 0) lib.starred.splice(i, 1); else lib.starred.push(id); saveLib(); }

/* ---------- visual data ---------- */
const kindById = id => (HAS_VIS ? VIS.KINDS.find(k => k.id === id) : null);
const kindLabel = id => { const k = kindById(id); return k ? k.label : id; };
const KIND_ICON = { list: 'list', steps: 'steps', diagram: 'diagram', callout: 'callout', highlight: 'highlight', 'lower-third': 'lower-third', 'title-card': 'title-card', 'big-number': 'big-number', quote: 'quote', shortcut: 'shortcut' };
// textBy says who writes the words: 'ai' (the default: the assistant writes them from the marker's comment) or 'me' (typed in the editor)
const hasText = v => !!(v && v.content && ((v.content.title || '').trim() || (v.content.body || '').trim()));
// The one test for "the assistant writes the words". A visual with no textBy (an old file or library item) follows the rule normVisual uses: typed words mean 'me', none mean 'ai'.
function isAiText(v) { return !!v && (v.textBy === 'ai' || (v.textBy !== 'me' && !hasText(v))); }
function defaultVisual(type) {
  if (!HAS_VIS) return null;
  const v = VIS.normalize({ kind: VIS.defaultKind(type), content: { title: '', body: '' } });
  v.style = defaultStyleId(); v.textBy = 'ai';
  return v;
}
// A visual can carry a note for the AI editor (movement, a 3D look, anything the picture cannot show). Using the visual from the library puts it into the marker's Comment.
const NOTE_MAX = 600;
function normVisual(v) {
  if (!HAS_VIS || !v || typeof v !== 'object') return null;
  const n = VIS.normalize(v);
  n.style = (typeof v.style === 'string' && v.style) ? v.style : defaultStyleId();
  n.textBy = (v.textBy === 'ai' || v.textBy === 'me') ? v.textBy : (hasText(n) ? 'me' : 'ai');      // older files with typed words keep them
  const note = typeof v.note === 'string' ? v.note.replace(/\r\n?/g, '\n').trim().slice(0, NOTE_MAX) : '';
  if (note) n.note = note;
  return n;
}
// Library items saved before textBy existed (and the starter set of an older build) get theirs once, here, so the editor, the preview and the export agree.
if (HAS_VIS && Array.isArray(lib.visuals)) {
  let fixed = false;
  lib.visuals.forEach(it => { if (it && it.visual && typeof it.visual === 'object' && it.visual.textBy !== 'ai' && it.visual.textBy !== 'me') { const nv = normVisual(it.visual); if (nv) { it.visual = nv; fixed = true; } } });
  if (fixed) saveLib();
}
// Previews show stand-in words: a skeleton for "AI writes it", sample text when you chose to type but have not yet
const AI_SAMPLE = {
  list: { title: 'AI writes the heading', body: 'First point\nSecond point\nThird point' },
  steps: { title: 'AI writes the heading', body: 'First step\nSecond step\nThird step' },
  diagram: { title: '', body: 'Start -> Middle -> End' },
  callout: { title: 'AI writes this', body: 'The words come from your comment.' },
  highlight: { title: 'AI writes the label', body: '' },
  'lower-third': { title: 'AI writes the name', body: 'and the subtitle' },
  'title-card': { title: 'AI writes the title', body: 'and the subtitle' },
  'big-number': { title: '00', body: 'AI picks the number and label' },
  quote: { title: 'Who said it', body: 'AI writes the quote from your comment.' },
  shortcut: { title: 'AI writes the shortcut', body: 'Ctrl + X' }
};
function withSample(v) {
  if (isAiText(v)) return Object.assign({}, v, { content: AI_SAMPLE[v.kind] || { title: 'AI writes the text', body: '' } });
  const k = kindById(v.kind);
  return (k && !hasText(v)) ? Object.assign({}, v, { content: k.sample }) : v;
}
function renderVisualInto(host, v) {
  if (!HAS_VIS || !v) return;
  try { VIS.render(host, withSample(v), styleById(v.style) || fallbackStyle()); } catch (e) { host.textContent = ''; }
}
const cloneVisual = v => JSON.parse(JSON.stringify(v));
const freshVisual = v => normVisual(cloneVisual(v)) || cloneVisual(v);       // a copy that always has a style and a textBy, whatever it came from

/* ---------- things that must be measured after they are in the page ---------- */
const pendingInsert = [];
const whenInserted = fn => pendingInsert.push(fn);
function flushInsert() { while (pendingInsert.length) { try { pendingInsert.shift()(); } catch (e) { /* a preview failed; ignore */ } } }

/* ---------- a picture of the current video frame, used as the backdrop behind previews ---------- */
let frameCache = { t: -1, url: '' };
function frameBackdrop() {
  if (!meta || video.readyState < 2) return '';
  if (Math.abs(frameCache.t - video.currentTime) < 0.001 && frameCache.url) return frameCache.url;
  try {
    const c = document.createElement('canvas'); c.width = 480; c.height = Math.round(480 * meta.h / meta.w);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    frameCache = { t: video.currentTime, url: c.toDataURL('image/jpeg', 0.6) };
    return frameCache.url;
  } catch (e) { return ''; }
}
// Typical placement of each kind inside a 16:9 frame (fractions), used when a marker has no box yet
const PLACE = { list: [.52, .12, .42, .62], steps: [.52, .1, .42, .72], diagram: [.1, .2, .8, .46], callout: [.5, .2, .4, .3], highlight: [.3, .3, .4, .26], 'lower-third': [.06, .72, .5, .17],
  'title-card': [.15, .28, .7, .4], 'big-number': [.3, .22, .4, .5], quote: [.12, .2, .76, .55], shortcut: [.28, .38, .44, .24] };
// A 16:9 preview: backdrop + the visual placed like it would be on the video. Returns { el, update }.
function stageThumb(getVisual, getBox, opts) {
  opts = opts || {};
  const bg = h('div', { class: 'vprev-bg blank' }), host = h('div', { class: 'vprev-host' });
  const el = h('div', { class: 'vprev' }, bg, host);
  function update() {
    const v = getVisual(); if (!v) return;
    const url = opts.backdrop === false ? '' : frameBackdrop();
    bg.className = 'vprev-bg' + (url ? '' : ' blank'); bg.style.backgroundImage = url ? 'url(' + url + ')' : '';
    const b = getBox && getBox(), p = PLACE[v.kind] || PLACE['title-card'];
    const rect = b ? [b.x / meta.w, b.y / meta.h, b.w / meta.w, b.h / meta.h] : p;
    host.style.left = rect[0] * 100 + '%'; host.style.top = rect[1] * 100 + '%'; host.style.width = rect[2] * 100 + '%'; host.style.height = rect[3] * 100 + '%';
    renderVisualInto(host, v);
  }
  whenInserted(update);
  return { el, update };
}

/* ---------- style picker (a searchable popover with swatches) ---------- */
const swatchEl = st => h('span', { class: 'swatches' }, [st.t.bg, st.t.surface, st.t.accent, st.t.fg].map(c => h('i', { style: 'background:' + c })));
function openStylePicker(anchor, currentId, onPick) {
  let q = '', mode = 'all';
  const search = h('input', { type: 'search', placeholder: 'Search styles…', 'aria-label': 'Search styles' });
  const seg = h('div', { class: 'seg' }, [['all', 'All'], ['star', '★ Starred'], ['light', 'Light'], ['dark', 'Dark']].map(([k, label]) =>
    h('button', { class: k === mode ? 'on' : '', onclick: e => { mode = k; seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.currentTarget)); draw(); } }, label)));
  const list = h('div', { class: 'picker-list' });
  const box = h('div', { class: 'picker' }, h('div', { class: 'picker-top' }, search, seg), list);
  function draw() {
    list.textContent = '';
    const ql = q.trim().toLowerCase();
    let items = allStyles().filter(s => (!ql || (s.name + ' ' + s.id + ' ' + s.category + ' ' + (s.description || '')).toLowerCase().indexOf(ql) >= 0) &&
      (mode === 'all' || (mode === 'star' && isStarred(s.id)) || s.theme === mode));
    if (!items.length) { list.appendChild(h('div', { class: 'pane-note', text: 'No styles match.' })); return; }
    const groups = new Map();
    const starred = items.filter(s => isStarred(s.id));
    if (mode === 'all' && !ql && starred.length) groups.set('★ Starred', starred);
    items.forEach(s => { const k = s.source === 'custom' ? 'Imported' : (s.category || 'Other'); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); });
    groups.forEach((arr, cat) => {
      list.appendChild(h('div', { class: 'picker-cat', text: cat }));
      arr.forEach(s => list.appendChild(h('button', { class: 'picker-item' + (s.id === currentId ? ' on' : ''), onclick: () => { closePopover(); onPick(s.id); } },
        swatchEl(s), h('span', { class: 'nm' }, h('b', { text: s.name }), h('small', { text: (s.theme === 'dark' ? 'Dark · ' : 'Light · ') + (s.description || s.category || '') })))));
    });
  }
  search.addEventListener('input', () => { q = search.value; draw(); });
  draw();
  openPopover(anchor, box);
  setTimeout(() => search.focus(), 0);
  const cur = list.querySelector('.picker-item.on'); if (cur) revealIn(list, cur);
}
/* ---------- kind picker (shows only the current kind; the others open in a popover) ---------- */
function openKindPicker(anchor, currentId, onPick) {
  const list = h('div', { class: 'picker-list' });
  const box = h('div', { class: 'picker' }, list);
  VIS.KINDS.forEach(k => list.appendChild(h('button', { class: 'picker-item' + (k.id === currentId ? ' on' : ''), type: 'button', onclick: () => { closePopover(); onPick(k.id); } },
    icon(KIND_ICON[k.id] || 'sparkles'), h('span', { class: 'nm' }, h('b', { text: k.label }), h('small', { text: k.blurb })))));
  openPopover(anchor, box);
  const cur = list.querySelector('.picker-item.on'); if (cur) revealIn(list, cur);
}
function kindButton(v, onChange) {
  const kd = kindById(v.kind);
  const b = h('button', { class: 'stylebtn', type: 'button', title: 'Choose a kind of visual' }, icon(KIND_ICON[v.kind] || 'sparkles'),
    h('span', { class: 'nm' }, h('b', { text: kd ? kd.label : v.kind })), icon('chevron-down'));
  b.addEventListener('click', () => openKindPicker(b, v.kind, id => { v.kind = id; onChange(v, { final: true, structural: true }); }));
  return b;
}
function styleButton(v, onChange) {
  const st = styleById(v.style) || fallbackStyle();
  const b = h('button', { class: 'stylebtn', type: 'button', title: 'Choose a style' }, swatchEl(st),
    h('span', { class: 'nm' }, h('b', { text: st.name }), h('small', { text: (st.category || '') + ' · ' + (st.theme === 'dark' ? 'dark' : 'light') })), icon('chevron-down'));
  b.addEventListener('click', () => openStylePicker(b, v.style, id => { v.style = id; onChange(v, { final: true, structural: true }); }));
  return b;
}

/* ---------- the editor for one visual: kind, style, who writes the words, options (used in the panel and in the designer window) ---------- */
// Quick by default: pick a kind, optionally a style, and say who writes the words. Typing fields and the finer options only show when needed.
// o.getComment: () => the marker's comment (panel only; used to nudge you to write one). o.open: show the fine options without a fold (designer). o.extra: a node for the end of the fine options.
let moreOpen = false;                        // the "More options" fold stays the way you left it
function buildVisualEditor(v, onChange, o) {
  o = o || {};
  const root = h('div', { class: 'vedit' });
  const fire = (info) => onChange(v, info || {});
  if (v.textBy !== 'ai' && v.textBy !== 'me') v.textBy = isAiText(v) ? 'ai' : 'me';       // never show a choice that nothing is set to
  function draw() {
    root.textContent = '';
    const kd = kindById(v.kind), ai = isAiText(v);
    // a div, not a label: a label would pass a click on its caption to the button
    root.appendChild(h('div', { class: 'field', role: 'group', 'aria-label': 'What kind of visual?' }, h('span', { text: 'What kind of visual?' }), kindButton(v, onChange), kd ? h('span', { class: 'hint', text: kd.blurb }) : null));
    root.appendChild(h('label', { class: 'field', style: 'margin-top:12px' }, 'Style (optional)', styleButton(v, onChange)));

    // who writes the words (two toggle buttons: Space and the arrow keys drive the video everywhere in this app, so these are not real radios)
    const choice = (by, title, sub) => h('button', { class: 'choice' + ((by === 'ai') === ai ? ' on' : ''), type: 'button', 'aria-pressed': String((by === 'ai') === ai),
      onclick: () => { if ((by === 'ai') === ai) return; v.textBy = by; fire({ final: true, structural: true }); } },
      h('span', { class: 'dot' }), h('span', {}, h('b', { text: title }), h('small', { text: sub })));
    root.appendChild(h('div', { class: 'field', style: 'margin-top:12px' }, 'Who writes the words?',
      h('div', { class: 'choices', role: 'group', 'aria-label': 'Who writes the words' },
        choice('ai', 'AI writes it from my comment', 'Say what you want in the Comment. The assistant writes the words.'),
        choice('me', 'I will type it', 'Type the words yourself.'))));

    if (ai) {
      root.appendChild(o.getComment
        ? h('div', { class: 'ai-hint' + (o.getComment().trim() ? '' : ' warn'), 'data-ai-hint': '1' }, h('b', { text: 'The AI writes the words.' }),
            ' Say what you want in the Comment above, for example “a list of the three golden rules”. It also hears what is said at this time when a transcript is loaded. Drag a box on the video to choose where it goes and how big it is.')
        : h('div', { class: 'ai-hint' }, h('b', { text: 'The AI writes the words' }), ' from the comment of the marker this visual is used on.'));
    } else {
      const fields = h('div', { class: 'fieldset' });
      (kd ? kd.fields : []).forEach(f => {
        const el = (f.rows && f.rows > 1) ? h('textarea', { rows: f.rows, placeholder: f.placeholder || '', 'data-fk': 'vf-' + f.key }) : h('input', { type: 'text', placeholder: f.placeholder || '', 'data-fk': 'vf-' + f.key });
        el.value = (v.content && v.content[f.key]) || '';
        el.addEventListener('input', () => { v.content[f.key] = el.value; fire({ final: false }); });
        el.addEventListener('change', () => fire({ final: true }));
        fields.appendChild(h('label', { class: 'field' }, f.label, el));
      });
      root.appendChild(fields);
    }

    // finer options (alignment, panel, size, accent, pointer) sit behind a fold
    const open = !!o.open || moreOpen;
    if (!o.open) {
      root.appendChild(h('button', { class: 'morebtn', type: 'button', 'aria-expanded': String(open), onclick: () => { moreOpen = !moreOpen; draw(); } },
        icon('chevron-down'), 'More options', h('span', { class: 'grow' }), h('small', { class: 'dim', text: 'alignment, size, colours' })));
    }
    if (open) {
      const op = v.opts, optRow = (label, ctl) => h('div', { class: 'optrow' }, h('span', { text: label }), ctl);
      const segOf = (key, vals) => h('div', { class: 'seg' }, vals.map(([val, label]) => h('button', { type: 'button', class: op[key] === val ? 'on' : '',
        onclick: e => { op[key] = val; e.currentTarget.parentNode.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.currentTarget)); fire({ final: true }); } }, label)));
      const scale = h('input', { type: 'range', min: 60, max: 160, step: 5, value: Math.round(op.scale * 100), 'aria-label': 'Text size' });
      scale.addEventListener('input', () => { op.scale = scale.value / 100; fire({ final: false }); });
      scale.addEventListener('change', () => fire({ final: true }));
      const accent = h('input', { type: 'color', value: op.accent || (styleById(v.style) || fallbackStyle()).t.accent, 'aria-label': 'Accent colour' });
      accent.addEventListener('input', () => { op.accent = accent.value; fire({ final: false }); });
      accent.addEventListener('change', () => fire({ final: true }));
      const reset = h('button', { type: 'button', class: 'btn sm ghost', title: 'Use the style’s own accent', onclick: () => { op.accent = ''; fire({ final: true, structural: true }); } }, 'Reset');
      const use = (VIS.OPTION_USE && VIS.OPTION_USE[v.kind]) || ['align', 'scale', 'bg', 'accent'];   // only the options this kind really uses
      const opts = h('div', { class: 'fieldset' });
      if (use.indexOf('align') >= 0) opts.appendChild(optRow('Align', segOf('align', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']])));
      if (use.indexOf('bg') >= 0) opts.appendChild(optRow('Panel', segOf('bg', [['solid', 'Solid'], ['soft', 'Soft'], ['none', 'None']])));
      if (use.indexOf('scale') >= 0) opts.appendChild(optRow('Text size', scale));
      if (use.indexOf('accent') >= 0) opts.appendChild(optRow('Accent colour', h('span', { style: 'display:inline-flex;gap:6px;align-items:center' }, accent, reset)));
      if (use.indexOf('pointer') >= 0) opts.appendChild(optRow('Pointer', segOf('pointer', [['auto', 'Auto'], ['left', '←'], ['right', '→'], ['up', '↑'], ['down', '↓'], ['none', 'None']])));
      if (o.extra) opts.appendChild(o.extra);
      root.appendChild(opts);
    }
    mountIcons(root);
  }
  draw();
  root.redraw = draw;
  return root;
}
// the hint turns amber while the comment is empty (called as you type in the Comment box)
function syncAiHint(m) {
  const el = propsEl.querySelector('[data-ai-hint]');
  if (el) el.classList.toggle('warn', !m.comment.trim());
}

/* ---------- the Visual section of a marker's properties ---------- */
function buildVisualSection(m) {
  const sec = h('div', { class: 'sec' });
  if (!HAS_VIS) { sec.appendChild(h('h4', { text: 'Visual' })); sec.appendChild(h('div', { class: 'hint', text: 'The visuals module did not load.' })); return sec; }
  if (!m.visual) m.visual = defaultVisual(m.type);
  const v = m.visual;
  const thumb = stageThumb(() => m.visual, () => m.boxes[0] || null);
  const designer = h('button', { class: 'btn sm', type: 'button', title: 'A larger window with the visual on top of the current video frame', onclick: () => openDesigner({ title: 'Design this visual', visual: m.visual, box: m.boxes[0] || null,
    applyLabel: 'Apply to marker', onApply: nv => { m.visual = nv; commit(); changed(); } }) }, icon('sparkles'), 'Open in the designer');
  const editor = buildVisualEditor(v, (vv, info) => {
    thumb.update(); ver++; refreshOverlay();
    if (info.final) { commit(); renderList(); if (info.structural) { editor.redraw(); } } else queueSave();
  }, { getComment: () => m.comment, extra: designer });
  sec.appendChild(h('h4', {}, 'Visual', h('span', { class: 'grow' }),
    h('button', { class: 'btn sm ghost', title: 'Pick a visual you saved earlier', onclick: e => openLibraryPicker(e.currentTarget, m) }, icon('sparkles'), 'From library'),
    h('button', { class: 'btn sm ghost', title: 'Save this visual in your library', onclick: () => saveVisualToLibrary(m.visual, m) }, icon('save'), 'Save')));
  sec.appendChild(thumb.el);
  sec.appendChild(editor);
  sec.appendChild(h('div', { class: 'hint', style: 'margin-top:12px', text: m.boxes.length
    ? 'The visual is drawn inside Box A, on top of the video. Other boxes are plain regions.'
    : 'Draw a box on the video to place this visual. Without a box, the assistant chooses a spot and tells you.' }));
  return sec;
}

/* ---------- saving visuals in the library ---------- */
function saveVisualToLibrary(v, m) {
  const name = (prompt('Name this visual:', suggestName(v)) || '').trim();
  if (!name) return;
  lib.visuals.unshift({ id: uid(), name, visual: freshVisual(v), created: Date.now() });
  saveLib(); toast('Saved “' + name + '” in your Visuals tab.');
  if (ui.tab === 'visuals') renderVisualsPane();
}
function suggestName(v) {
  const t = ((v.content && v.content.title) || '').trim();
  const st = styleById(v.style);
  return (t ? t.slice(0, 28) : kindLabel(v.kind)) + (st ? ' · ' + st.name : '');
}
function applyLibraryVisual(item, m) {
  m = m || byId(selId);
  if (!m) { toast('Select a marker first, then use a visual.'); return; }
  if (!isVisualType(m.type)) { const k = kindById(item.visual.kind); m.type = (k && k.suits && k.suits.find(isVisualType)) || 'visual'; }
  const oldNote = m.visual && m.visual.note;
  m.visual = freshVisual(item.visual);
  swapNote(m, oldNote, m.visual.note);
  commit(); changed();
  toast('Applied “' + item.name + '” to marker #' + (sorted().indexOf(m) + 1) + '.' + (m.visual.note ? ' Its note was added to the Comment.' : ''));
}
// Puts a visual's note into the marker's Comment (once). The note of the visual it replaces comes out again, but only while it is still there word for word.
function swapNote(m, oldNote, newNote) {
  let c = m.comment || '';
  if (oldNote && oldNote !== newNote && c.indexOf(oldNote) >= 0) c = c.replace(oldNote, '').replace(/\n{3,}/g, '\n\n').trim();
  if (newNote && c.indexOf(newNote) < 0) c = c.trim() ? c.replace(/\s+$/, '') + '\n' + newNote : newNote;
  m.comment = c;
}
function openLibraryPicker(anchor, m) {
  const box = h('div', { class: 'picker' }, h('div', { class: 'picker-top' }, h('b', { text: 'Your saved visuals' })), h('div', { class: 'picker-list' }));
  const list = box.lastChild;
  if (!lib.visuals.length) list.appendChild(h('div', { class: 'pane-note', text: 'Nothing saved yet. Design a visual, then press Save.' }));
  lib.visuals.forEach(it => list.appendChild(h('button', { class: 'picker-item', onclick: () => { closePopover(); applyLibraryVisual(it, m); } },
    swatchEl(styleById(it.visual.style) || fallbackStyle()), h('span', { class: 'nm' }, h('b', { text: it.name }), h('small', { text: kindLabel(it.visual.kind) })))));
  openPopover(anchor, box, { alignRight: true });
}

/* ---------- the designer window ---------- */
function openDesigner(o) {
  const v = freshVisual(o.visual);
  const nameInp = o.withName ? h('input', { type: 'text', value: o.name || '', placeholder: 'Name, e.g. Shortcut keys, warm', 'aria-label': 'Name' }) : null;
  const thumb = stageThumb(() => v, () => o.box || null);
  const editor = buildVisualEditor(v, (vv, info) => { thumb.update(); if (info.structural) editor.redraw(); }, { open: true });
  // the note is for the library only: a visual already on a marker has had its note put into the Comment, which is where it is edited from then on
  const noteInp = o.withName ? h('textarea', { rows: 3, maxlength: NOTE_MAX, 'aria-label': 'Note for the AI', placeholder: 'For example: Turn the number slowly around its vertical axis in 3D, like a rotating sign.' }) : null;
  if (noteInp) { noteInp.value = v.note || ''; noteInp.addEventListener('input', () => { v.note = noteInp.value; }); }
  const noteField = noteInp ? h('label', { class: 'field', style: 'margin-top:12px' }, 'Note for the AI (optional)', noteInp,
    h('span', { class: 'hint', text: 'Added to the marker’s Comment each time you press Use, so you do not have to write it again. Good for things the picture cannot show, such as a 3D spin or a slow fade.' })) : null;
  const done = () => normVisual(v) || v;
  const side = h('div', { class: 'designer-side' }, nameInp ? h('label', { class: 'field' }, 'Name', nameInp) : null, editor, noteField);
  const left = h('div', {}, thumb.el, h('div', { class: 'hint', style: 'margin-top:10px', text: frameBackdrop() ? 'Shown on top of the frame the video is paused on.' : 'Open a video to see the visual on top of a real frame.' }));
  const modal = openModal({
    title: o.title || 'Visual designer',
    body: h('div', { class: 'designer' }, left, side),
    footer: [h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      o.secondaryLabel ? h('button', { class: 'btn', onclick: () => { o.onSecondary(done(), nameInp ? nameInp.value : ''); closeModal(); } }, o.secondaryLabel) : null,
      h('button', { class: 'btn primary', onclick: () => { o.onApply(done(), nameInp ? nameInp.value : ''); closeModal(); } }, o.applyLabel || 'Save')]
  });
  mountIcons(modal.box);
  flushInsert();
}

/* ---------- Visuals tab (the library) ---------- */
function seedLibrary() {
  if (lib.seeded || lib.visuals.length || !HAS_VIS) return;
  const pick = (...ids) => ids.find(id => styleById(id)) || defaultStyleId();
  const mk = (name, kind, style, title, body, opts) => ({ id: uid(), name, created: Date.now(),
    visual: Object.assign(VIS.normalize({ kind, content: { title, body }, opts: opts || {} }), { style, textBy: 'me' }) });       // the starter set has typed words
  lib.visuals = [
    mk('Excel shortcut', 'shortcut', pick('default'), 'Select the whole table', 'Ctrl + A'),
    mk('Step list', 'steps', pick('warm-editorial', 'default'), 'Make a pivot table', 'Click inside your data\nInsert, then PivotTable\nDrag a field into Rows'),
    mk('Highlight the button', 'highlight', pick('default'), 'Click here', ''),
    mk('Name and title', 'lower-third', pick('linear-app', 'default'), 'Alex Rivera', 'Spreadsheet coach'),
    mk('Big number', 'big-number', pick('default'), '3×', 'faster with this shortcut'),
    mk('Simple flow', 'diagram', pick('default'), 'How it works', 'Data -> Formula -> Result')
  ];
  lib.seeded = true; saveLib();
}
function visualRow(it) {
  const thumb = stageThumb(() => it.visual, null, { backdrop: false });
  const st = styleById(it.visual.style);
  const sub = (isAiText(it.visual) ? 'AI text · ' : '') + (it.visual.note ? 'Note · ' : '') + kindLabel(it.visual.kind) + (st ? ' · ' + st.name : '');      // the AI flag comes first: it is the part that must not be cut off
  return h('div', { class: 'vrow', 'data-id': it.id },
    thumb.el,
    h('div', { class: 'info' },
      h('b', { text: it.name, title: it.name }),
      h('small', { text: sub, title: sub + (isAiText(it.visual) ? ' (the assistant writes the words from the marker comment)' : '') }),
      h('div', { class: 'acts' },
        h('button', { class: 'btn sm primary', title: 'Use on the selected marker' + (it.visual.note ? ' (its note is added to the Comment: ' + it.visual.note + ')' : ''), onclick: () => applyLibraryVisual(it) }, 'Use'),
        h('button', { class: 'btn icon sm', title: 'Edit this visual', 'aria-label': 'Edit', onclick: () => editLibraryVisual(it) }, icon('settings')),
        h('button', { class: 'btn icon sm', title: 'Make a copy', 'aria-label': 'Duplicate', onclick: () => duplicateLibraryVisual(it) }, icon('duplicate')),
        h('button', { class: 'btn icon sm danger', title: 'Delete from the library', 'aria-label': 'Delete', onclick: () => deleteLibraryVisual(it) }, icon('trash')))));
}
function duplicateLibraryVisual(it) {
  const i = lib.visuals.indexOf(it); if (i < 0) return;
  lib.visuals.splice(i + 1, 0, { id: uid(), name: it.name + ' copy', visual: freshVisual(it.visual), created: Date.now() });
  saveLib(); renderVisualsPane(true); toast('Made a copy of “' + it.name + '”.');
}
function deleteLibraryVisual(it) {
  if (!confirm('Delete “' + it.name + '” from your library? This cannot be undone.')) return;
  lib.visuals = lib.visuals.filter(x => x.id !== it.id); saveLib(); renderVisualsPane(true);
}
function editLibraryVisual(it) {
  openDesigner({ title: 'Edit visual', visual: it.visual, name: it.name, withName: true, applyLabel: 'Save changes',
    onApply: (nv, name) => { it.visual = nv; it.name = (name || '').trim() || it.name; saveLib(); renderVisualsPane(true); } });
}
function newLibraryVisual() {
  const base = defaultVisual('visual');
  openDesigner({ title: 'New visual', visual: base, name: '', withName: true, applyLabel: 'Save to library',
    onApply: (nv, name) => { lib.visuals.unshift({ id: uid(), name: (name || '').trim() || suggestName(nv), visual: nv, created: Date.now() }); saveLib(); renderVisualsPane(); } });
}
// The Make with AI button, shared by the Visuals and Styles tabs (both open the same window; its result always goes to the Visuals tab)
const makeWithAiRow = () => HAS_VIS ? h('div', { class: 'row' }, h('button', { class: 'btn sm', style: 'flex:1 1 auto', title: 'Copy a prompt that lets any AI assistant write visuals for your library', onclick: openMakeWithAi }, icon('sparkles'), 'Make with AI')) : null;
let visQuery = '';
function renderVisualsPane(keepScroll) {       // keepScroll: Duplicate, Delete and Edit leave the list where it was (New puts its item at the top, so it starts from the top)
  const pane = $('paneVisuals'), prev = keepScroll && pane.querySelector('.pane-body'), top = prev ? prev.scrollTop : 0;
  pane.textContent = '';
  seedLibrary();
  const search = h('input', { type: 'search', placeholder: 'Search your visuals…', value: visQuery, 'aria-label': 'Search visuals' });
  search.addEventListener('input', () => { visQuery = search.value; drawGrid(); });
  pane.appendChild(h('div', { class: 'lib-head' },
    h('div', { class: 'row' }, h('button', { class: 'btn primary sm', title: 'Design a new visual', onclick: newLibraryVisual }, icon('plus'), 'New'),
      search,
      h('button', { class: 'btn icon sm ghost', title: 'Save your library to a file', 'aria-label': 'Save library', onclick: exportLibrary }, icon('download')),
      h('button', { class: 'btn icon sm ghost', title: 'Load a library file', 'aria-label': 'Load library', onclick: () => $('fileLib').click() }, icon('upload'))),
    makeWithAiRow()));
  const body = h('div', { class: 'pane-body' });
  pane.appendChild(body);
  function drawGrid() {
    body.textContent = '';
    const q = visQuery.trim().toLowerCase(), items = lib.visuals.filter(it => !q || (it.name + ' ' + kindLabel(it.visual.kind)).toLowerCase().indexOf(q) >= 0);
    body.appendChild(h('div', { class: 'pane-note', text: 'Visuals you save live here. Select a marker, then press Use to put one on it. They are kept in this browser and work for every video.' }));
    if (!items.length) { body.appendChild(h('div', { class: 'pane-note', text: lib.visuals.length ? 'No visuals match.' : 'Nothing saved yet. Press New to design one.' })); return; }
    body.appendChild(h('div', { class: 'vlist' }, items.map(visualRow)));
    mountIcons(body); flushInsert();
  }
  drawGrid();
  if (top) body.scrollTop = top;
}
function exportLibrary() {
  download('video-redline-library.json', JSON.stringify({ tool: 'video-review-library', version: 1, visuals: lib.visuals, styles: lib.styles, starred: lib.starred, defStyle: lib.defStyle }, null, 2), 'application/json');
  toast('Library saved to your Downloads folder.');
}
// Adds what a library file holds (already parsed) to the library: how many visuals it added, or -1 when it is not a library file. Used by Load and by the paste box of Make with AI.
function addLibraryData(d) {
  if (!d || !Array.isArray(d.visuals)) return -1;
  if (Array.isArray(d.styles)) importStyleRecords(d.styles);
  let n = 0;
  d.visuals.forEach(it => { const nv = it && normVisual(it.visual); if (nv) { lib.visuals.push({ id: uid(), name: String(it.name || 'Imported visual'), visual: nv, created: Date.now() }); n++; } });
  (d.starred || []).forEach(id => { if (lib.starred.indexOf(id) < 0) lib.starred.push(id); });
  saveLib(); renderVisualsPane();
  return n;
}
async function importLibraryFile(file) {
  let d; try { d = JSON.parse(await readFile(file)); } catch (e) { toast('That is not a library file.'); return; }
  const n = addLibraryData(d);
  if (n < 0) { toast('That is not a library file.'); return; }
  toast('Added ' + n + ' visual' + (n === 1 ? '' : 's') + ' to your library.');
}
$('fileLib').addEventListener('change', () => { const f = $('fileLib').files[0]; if (f) importLibraryFile(f); $('fileLib').value = ''; });

/* ---------- Styles tab ---------- */
let styleQuery = '', styleMode = 'all', styleCat = '', styleFiltersOpen = false, stylePending = new Set(), styleScrollTimer = null;
function styleCard(st) {
  const host = h('div', { class: 'vprev-host', style: 'left:10%;top:16%;width:80%;height:68%' });
  const thumb = h('div', { class: 'vprev', style: '--sbg:' + st.t.bg + ';background:' + st.t.bg }, host);
  const card = h('div', { class: 'vcard scard', 'data-id': st.id, onclick: () => useStyle(st) }, thumb,
    h('button', { class: 'star' + (isStarred(st.id) ? ' on' : ''), title: 'Favourite', onclick: e => { e.stopPropagation(); toggleStar(st.id); e.currentTarget.classList.toggle('on', isStarred(st.id)); setIcon(e.currentTarget, isStarred(st.id) ? 'star-fill' : 'star'); } }, icon(isStarred(st.id) ? 'star-fill' : 'star')),
    h('div', { class: 'cap' }, h('b', { text: st.name }), h('small', { text: (st.theme === 'dark' ? 'Dark · ' : 'Light · ') + (st.category || '') }), swatchEl(st)));
  card._render = () => { if (HAS_VIS) renderVisualInto(host, { kind: 'callout', content: { title: 'Sample', body: 'This is how text looks in ' + st.name }, opts: { bg: 'solid', scale: 1 }, style: st.id }); };
  return card;
}
function useStyle(st) {
  const m = byId(selId);
  if (m && isVisualType(m.type) && m.visual) { m.visual.style = st.id; commit(); changed(); toast('“' + st.name + '” applied to marker #' + (sorted().indexOf(m) + 1) + '.'); }
  else { lib.defStyle = st.id; saveLib(); toast('“' + st.name + '” will be the style for new visuals. Select a visual marker to apply it to one.'); }
}
function styleRenderVisible(body) {
  const r = body.getBoundingClientRect();
  [...stylePending].forEach(c => {
    const b = c.getBoundingClientRect();
    if (b.bottom >= r.top - 240 && b.top <= r.bottom + 240) { stylePending.delete(c); try { c._render(); } catch (x) { /* skip this sample */ } }
  });
}
function renderStylesPane() {
  const pane = $('paneStyles'); pane.textContent = '';
  const search = h('input', { type: 'search', placeholder: 'Search styles…', value: styleQuery, 'aria-label': 'Search styles' });
  const cats = [...new Set(allStyles().map(s => s.source === 'custom' ? 'Imported' : (s.category || 'Other')))].sort();
  const catSel = h('select', { 'aria-label': 'Category' }, h('option', { value: '', text: 'All categories' }), cats.map(c => h('option', { value: c, text: c })));
  catSel.value = styleCat;
  const filtersActive = () => styleMode !== 'all' || !!styleCat;
  const syncFilterBtn = () => filterBtn.classList.toggle('on', filtersActive());      // a dot shows that a filter is on even while the filters are folded away
  const seg = h('div', { class: 'seg' }, [['all', 'All'], ['star', '★'], ['light', 'Light'], ['dark', 'Dark']].map(([k, label]) =>
    h('button', { class: k === styleMode ? 'on' : '', title: k === 'star' ? 'Favourites' : null, 'aria-label': k === 'star' ? 'Favourites' : null,
      onclick: e => { styleMode = k; seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.currentTarget)); syncFilterBtn(); drawGrid(); } }, label)));
  search.addEventListener('input', () => { styleQuery = search.value; drawGrid(); });
  catSel.addEventListener('change', () => { styleCat = catSel.value; syncFilterBtn(); drawGrid(); });
  const filterRow = h('div', { class: 'row filters' }, seg, catSel);        // wraps: the category list gets its own line in a narrow panel
  filterRow.hidden = !styleFiltersOpen;
  const filterBtn = h('button', { class: 'btn sm' + (filtersActive() ? ' on' : ''), type: 'button', title: 'Filter by favourites, light, dark or category', 'aria-expanded': String(styleFiltersOpen),
    onclick: () => { styleFiltersOpen = !styleFiltersOpen; filterRow.hidden = !styleFiltersOpen; filterBtn.setAttribute('aria-expanded', String(styleFiltersOpen)); } }, 'Filter', icon('chevron-down'));
  pane.appendChild(h('div', { class: 'lib-head' }, h('div', { class: 'row' }, search, filterBtn,
    h('button', { class: 'btn icon sm', title: 'Add a design system from Open Design (its DESIGN.md and tokens.css files)', 'aria-label': 'Import a design system', onclick: () => $('fileStyle').click() }, icon('import'))),
    filterRow,
    makeWithAiRow()));
  const body = h('div', { class: 'pane-body' }); pane.appendChild(body);
  body.addEventListener('scroll', () => { if (!styleScrollTimer) styleScrollTimer = setTimeout(() => { styleScrollTimer = null; styleRenderVisible(body); }, 60); });
  function drawGrid() {
    body.textContent = '';
    const q = styleQuery.trim().toLowerCase();
    const items = allStyles().filter(s => (!q || (s.name + ' ' + s.id + ' ' + s.category + ' ' + (s.description || '')).toLowerCase().indexOf(q) >= 0) &&
      (!styleCat || (s.source === 'custom' ? 'Imported' : (s.category || 'Other')) === styleCat) &&
      (styleMode === 'all' || (styleMode === 'star' && isStarred(s.id)) || s.theme === styleMode));
    body.appendChild(h('div', { class: 'pane-note' }, h('b', { text: 'Open Design' }), ' styles. Click one to use it on the selected visual, or, with nothing selected, for new visuals. ★ keeps favourites. Style names that are brand names belong to their owners; the styles are rough look-alikes, not official and not affiliated with them.'));
    if (!items.length) { body.appendChild(h('div', { class: 'pane-note', text: 'No styles match.' })); return; }
    const grid = h('div', { class: 'vgrid' }); body.appendChild(grid);
    const cards = items.map(styleCard); cards.forEach(c => grid.appendChild(c));
    mountIcons(body);
    stylePending = new Set(cards);          // draw each sample only when it is (nearly) on screen
    styleRenderVisible(body);
    setTimeout(() => styleRenderVisible(body), 60);
  }
  drawGrid();
}
function onTabShown(name) {
  if (name === 'visuals') renderVisualsPane();
  else if (name === 'styles') renderStylesPane();
}

/* ---------- importing Open Design systems (DESIGN.md + tokens.css, optionally manifest.json) ---------- */
function importStyleRecords(list) {       // style records that came with a saved session or library
  let n = 0;
  (list || []).forEach(s => {
    if (!s || !s.id || !s.t || styleIndex.has(s.id)) return;
    lib.styles.push(Object.assign({}, s, { source: s.source === 'open-design' ? 'open-design' : 'custom' })); n++;
  });
  if (n) { saveLib(); rebuildStyleIndex(); }
}
async function importStyleFiles(files) {
  if (typeof ODParse === 'undefined') { toast('The style importer did not load.'); return; }
  files = Array.from(files);
  const by = re => files.find(f => re.test(f.name));
  const md = by(/\.md$/i), css = by(/\.css$/i), man = by(/manifest\.json$/i);
  if (!md && !css) { toast('Pick the DESIGN.md and tokens.css files of an Open Design system.', 5000); return; }
  const designMd = md ? await readFile(md) : '', tokensCss = css ? await readFile(css) : '';
  let manifest = null; try { manifest = man ? JSON.parse(await readFile(man)) : null; } catch (e) { manifest = null; }
  let st;
  try { st = ODParse.buildStyle({ id: manifest && manifest.id, manifest, designMd, tokensCss, source: 'custom' }); } catch (e) { toast('Could not read those files as a design system.', 5000); return; }
  if (!st) { toast('Could not read those files as a design system.', 5000); return; }
  st.source = 'custom'; if (designMd) st.designMd = designMd;
  let id = st.id || 'imported', base = id, i = 2;
  while (styleIndex.has(id)) id = base + '-' + (i++);
  st.id = id;
  lib.styles.push(st); lib.defStyle = id; saveLib(); rebuildStyleIndex();
  if (ui.tab === 'styles') renderStylesPane();
  toast('Imported “' + st.name + '”. It is now the style for new visuals.', 5000);
}
$('fileStyle').addEventListener('change', () => { const f = $('fileStyle').files; if (f.length) importStyleFiles(f); $('fileStyle').value = ''; });
