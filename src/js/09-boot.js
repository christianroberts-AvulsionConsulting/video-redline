/* =====================================================================
   08 - Keyboard, shortcuts help, menus, panels, start-up
   ===================================================================== */
/* ---------- saved screen settings ---------- */
let ui = { tab: 'cleanup', noLeft: false, noRight: false, tlh: 0, preview: true, skipCuts: false };   // tlh 0 = never resized: the CSS default applies
try { Object.assign(ui, JSON.parse(store.get('vrt:ui') || '{}')); } catch (e) { /* defaults */ }
ui.tab = 'cleanup';                                                  // the app always opens on the first tab, Cleanup, whichever tab was open last time
function saveUi() { store.set('vrt:ui', JSON.stringify(ui)); }

/* ---------- keyboard ---------- */
document.addEventListener('keydown', e => {
  const t = e.target;
  if (e.key === 'Escape') {
    const typing = !!(t.matches && t.matches('input, textarea, select'));
    if (typing) t.blur();
    if (popClose) { closePopover(); return; }                  // one Escape closes a picker or window, even from a text box inside it
    if (modalStack.length) { closeModal(); return; }
    if (typing) return;
    if (narrow() && (app.classList.contains('show-left') || app.classList.contains('show-right'))) {      // a slide-in panel closes with Escape too
      const left = app.classList.contains('show-left');
      app.classList.remove('show-left', 'show-right'); $(left ? 'btnPanelL' : 'btnPanelR').focus(); return;
    }
  }
  // Typing in a comment, a time box, a search box or a dropdown never triggers shortcuts.
  if (t.matches && t.matches('input, textarea, select, [contenteditable]')) return;
  if (e.isComposing || modalStack.length) return;
  if (t.closest && t.closest('#paneCleanup') && !(e.metaKey || e.ctrlKey)) return;      // the cleanup panel has its own J K A R Z X Space keys
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  if (mod) {
    if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === 'y') { e.preventDefault(); redo(); }
    return;
  }
  if (e.altKey) return;
  if (e.key === '?') { e.preventDefault(); showShortcuts(); return; }
  if (!meta) return;
  switch (e.key) {
    case ' ':
      if (t.closest && t.closest('button, a[href], [role=tab], [role=menuitem]')) break;      // a focused button, link or tab (reached with the keyboard) is activated by Space
      e.preventDefault(); if (!e.repeat) togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); step(e.shiftKey ? -Math.round(fps) : -1); break;
    case 'ArrowRight': e.preventDefault(); step(e.shiftKey ? Math.round(fps) : 1); break;
    case '+': case '=': zoomBy(2); break;
    case '-': case '_': zoomBy(0.5); break;
    case '0': zoomFit(); break;
    case 'm': case 'M': if (!e.repeat) addAtPlayhead(); break;
    case 'i': case 'I': if (!e.repeat) setIn(); break;
    case 'o': case 'O': if (!e.repeat) setOut(); break;
    case 'Delete': case 'Backspace': {
      e.preventDefault();
      const m = byId(selId);
      // A box you have clicked goes first; otherwise the selected marker goes (Undo brings it back).
      if (m && selBox) deleteBox(m, selBox); else if (m) deleteMarker(m.id); else toast('Click a marker on the timeline first, then press Delete.', 3600);
      break;
    }
  }
});
// After a mouse click a button lets go of the keyboard, so Space and the arrow keys reach the player. A click made with the keyboard (Enter or Space) keeps its place.
document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('button'); if (b && e.detail > 0 && !b.closest('.modal, .picker, .cp-root')) b.blur(); });

/* ---------- shortcuts help: always one click away, never cut off ---------- */
const HINTS = [
  ['Space', 'Play / pause'], ['← →', 'One frame'], ['⇧ ← →', 'One second'], ['M', 'Add marker'], ['I  O', 'In / out'], ['+  −', 'Zoom timeline']
];
function renderHints() {
  const box = $('hints'); box.textContent = '';
  HINTS.forEach(([k, d]) => box.appendChild(h('span', {}, h('kbd', { text: k }), d)));
}
function showShortcuts() {
  if (modalStack.length) return;
  const row = (keys, what) => h('div', {}, h('span', { text: what }), h('span', { class: 'k' }, keys.map(k => h('kbd', { text: k }))));
  openModal({
    title: 'Keyboard and mouse shortcuts', narrow: true,
    body: h('div', { class: 'keylist' },
      h('h4', { text: 'Playing' }), row(['Space'], 'Play or pause'), row(['←'], 'Back one frame'), row(['→'], 'Forward one frame'), row(['Shift', '←'], 'Back one second'), row(['Shift', '→'], 'Forward one second'),
      h('h4', { text: 'Markers' }), row(['M'], 'Add a marker (1 second)'), row(['I'], 'Set the in point'), row(['O'], 'Set the out point, then M uses both'), row([MOD, 'Z'], 'Undo'), row([MOD, 'Shift', 'Z'], 'Redo'), row(['Delete'], 'Remove the box you clicked, or else the selected marker'),
      h('h4', { text: 'Timeline' }), row(['+'], 'Zoom in'), row(['-'], 'Zoom out'), row(['0'], 'Show the whole video'), row([MOD, 'wheel'], 'Zoom at the mouse'), row(['Shift', 'wheel'], 'Move along the timeline'),
      h('h4', { text: 'Zoom the picture' }), row(['wheel'], 'Zoom in or out on the video, at the mouse'), row(['drag'], 'Move a zoomed picture (when no marker is picked)'), row(['Shift', 'drag'], 'Move a zoomed picture, even with a marker picked'),
      h('h4', { text: 'With the mouse' }), row(['click'], 'Jump to that moment'), row(['drag on a track'], 'Mark a new range'), row(['drag a clip'], 'Move it'), row(['drag a clip end'], 'Resize it'), row(['drag on the video'], 'Draw a box'), row(['?'], 'Show this list')),
    footer: h('button', { class: 'btn primary', onclick: closeModal }, 'Done')
  });
}

/* ---------- File menu: see openFileMenu in 07-sessions.js ---------- */

/* ---------- panels and tabs ---------- */
function narrow() { return window.innerWidth <= 980; }
function togglePanel(side) {
  if (narrow()) {
    const other = side === 'left' ? 'show-right' : 'show-left';
    app.classList.remove(other); app.classList.toggle('show-' + side);
  } else {
    app.classList.toggle('no-' + side);
    ui[side === 'left' ? 'noLeft' : 'noRight'] = app.classList.contains('no-' + side); saveUi();
    setTimeout(onLayoutChange, 0);
  }
}
function showTab(name) {
  ui.tab = name; saveUi();
  document.querySelectorAll('.tab').forEach(t => { const on = t.dataset.tab === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on)); });
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === 'pane' + name[0].toUpperCase() + name.slice(1)));
  app.classList.toggle('cleanup-wide', name === 'cleanup');           // the transcript and review cards need more room
  if (name === 'markers') revealIn(listEl, listEl.querySelector('.mcard.sel'));      // a marker picked on the timeline while another tab was open: the list could not scroll to it while hidden
  setTimeout(onLayoutChange, 0);
  if (typeof onTabShown === 'function') onTabShown(name);
}
function onLayoutChange() { fitStage(); onTimelineResize(); refreshOverlay(); }

/* ---------- start-up ---------- */
function boot() {
  mountIcons();
  renderHints();
  if (ui.noLeft) app.classList.add('no-left');
  if (ui.noRight) app.classList.add('no-right');
  if (ui.tlh) { const lim = tlLimits(); app.style.setProperty('--tlh', clamp(ui.tlh, lim[0], lim[1]) + 'px'); }
  tlInner.style.setProperty('--hw', HW + 'px');
  previewOn = ui.preview !== false; syncPreviewBtn();
  const tabEls = Array.from(document.querySelectorAll('.tab'));
  tabEls.forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
  tabEls.forEach((t, i) => t.addEventListener('keydown', e => {      // as a tab list promises: Left / Right / Home / End walk the tabs (and do not step the video)
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    const n = tabEls.length, j = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (j < 0) return;
    e.preventDefault(); e.stopPropagation(); tabEls[j].focus(); showTab(tabEls[j].dataset.tab);
  }));
  $('btnOpen').addEventListener('click', openVideoPicker);
  $('btnOpen2').addEventListener('click', openVideoPicker);
  $('btnFile').addEventListener('click', openFileMenu);
  $('btnCopy').addEventListener('click', copyMarkdown);
  $('btnExport').addEventListener('click', exportForClaude);
  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);
  $('btnPanelL').addEventListener('click', () => togglePanel('left'));
  $('btnPanelR').addEventListener('click', () => togglePanel('right'));
  $('btnKeys').addEventListener('click', showShortcuts);
  $('bPlay').addEventListener('click', togglePlay);
  $('bBack').addEventListener('click', () => step(-1));
  $('bFwd').addEventListener('click', () => step(1));
  $('bBack1s').addEventListener('click', () => step(-Math.round(fps)));
  $('bFwd1s').addEventListener('click', () => step(Math.round(fps)));
  $('bIn').addEventListener('click', setIn);
  $('bOut').addEventListener('click', setOut);
  $('bMark').addEventListener('click', addAtPlayhead);
  $('bClearIO').addEventListener('click', () => { inF = outF = null; renderIO(); });
  $('bSkip').addEventListener('click', () => setSkipCuts(!skipCuts));
  setSkipCuts(ui.skipCuts === true);
  buildCleanupPanel();
  $('speed').addEventListener('change', e => { video.playbackRate = parseFloat(e.target.value); e.target.blur(); });
  try {
    const last = JSON.parse(store.get('vrt:last') || 'null');
    if (last && last.name) $('lastSeen').textContent = 'Last time you worked on: ' + last.name + ' (open it again to continue).';
  } catch (e) { /* no history yet */ }
  if (window.ResizeObserver) {
    // the work runs one frame later, outside the observer callback: resizing things inside it can make the browser log a harmless "ResizeObserver loop" error
    const later = fn => { let q = 0; return () => { if (!q) q = requestAnimationFrame(() => { q = 0; fn(); }); }; };
    new ResizeObserver(later(onLayoutChange)).observe(stageWrap); new ResizeObserver(later(onTimelineResize)).observe(strip);
    const sb = document.querySelector('.statusbar');      // the shortcut hints wrap to a second line in a narrow window: the slide-in panels stop above the bar, whatever its height
    if (sb) new ResizeObserver(() => app.style.setProperty('--sbh', sb.offsetHeight + 'px')).observe(sb);
  }
  window.addEventListener('resize', onLayoutChange);
  showTab(ui.tab);
  setAxisWidth(); changed(); renderRuler();
  requestAnimationFrame(tick);
}
boot();
