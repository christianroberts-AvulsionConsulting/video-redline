/* =====================================================================
   02 - Video: opening, playback, seeking (everything snaps to whole frames)
   ===================================================================== */
let videoFile = null;                           // the File that is open now (the cleanup helper reads it)
function loadVideo(file) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);        // the file is streamed by the browser, never read into memory by us
  pendingName = file.name; videoFile = file;
  video.src = objectUrl;
}
// Back to the empty state (used when a file cannot be played)
function closeVideo() {
  meta = null; videoFile = null; markers = []; selId = selBox = inF = outF = null;
  hist = []; hi = -1; syncUndo();
  stage.hidden = true; dropEl.hidden = false; $('btnPreview').hidden = true;
  $('fileinfo').innerHTML = '<span class="dim">No video open yet</span>';
  overlay.textContent = ''; overlayKey = '';
  changed(); renderRuler();
  stopRange(); buildCleanupPanel();
}
video.addEventListener('error', () => {
  if (!video.getAttribute('src')) return;
  closeVideo();
  toast('This browser cannot play that file. Try an .mp4 (H.264) or .mov, or open it in Chrome or Safari.', 6500);
});
video.addEventListener('loadedmetadata', () => {
  if (!video.videoWidth || !isFinite(video.duration)) { closeVideo(); toast('That file has no picture or no readable length.', 5000); return; }
  meta = { name: pendingName, w: video.videoWidth, h: video.videoHeight, duration: video.duration };
  fps = 30; markers = [];
  const raw = store.get(storeKey());
  let restored = 0;
  if (raw) {
    try {
      const s = JSON.parse(raw);
      if (s.fps >= 1 && s.fps <= 240) fps = normFps(+s.fps);
      markers = cleanMarkers(s.markers, null);
      restored = markers.length;
    } catch (e) { markers = []; }
  }
  selId = selBox = inF = outF = null;
  video.playbackRate = parseFloat($('speed').value);
  dropEl.hidden = true; stage.hidden = false; $('btnPreview').hidden = false;
  resetHistory();
  renderMeta(); fitStage(); zoomFit(); changed(); updateClock(true);
  stopRange(); buildCleanupPanel();
  toast(restored ? 'Welcome back: ' + restored + ' marker' + (restored === 1 ? '' : 's') + ' restored.' : 'Video ready. Press M to add a marker.');
});

function renderMeta() {
  const el = $('fileinfo');
  el.textContent = '';
  el.appendChild(h('b', { text: meta.name, title: meta.name }));
  el.appendChild(h('span', { class: 'tag res', text: meta.w + '×' + meta.h }));
  el.appendChild(h('span', { class: 'tag', text: meta.duration.toFixed(3) + ' s' }));
  const inp = h('input', { type: 'number', id: 'fps', min: 1, max: 240, step: 'any', value: fmtFps(fps),
    title: 'Browsers cannot always tell the frame rate. Set it to match your video (30, 29.97, 60...).' });
  el.appendChild(h('label', {}, 'Frame rate', inp, 'fps'));
  inp.addEventListener('focus', () => { delete inp.dataset.cancel; });
  inp.addEventListener('blur', () => { setTimeout(() => { delete inp.dataset.cancel; }, 0); });
  inp.addEventListener('change', () => {
    if (inp.dataset.cancel) { delete inp.dataset.cancel; inp.value = fmtFps(fps); return; }
    const v = parseFloat(inp.value);
    if (!(v >= 1 && v <= 240)) { inp.value = fmtFps(fps); toast('Frame rate must be between 1 and 240.'); return; }
    setFps(normFps(v));
  });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); else if (e.key === 'Escape') { inp.dataset.cancel = '1'; inp.value = fmtFps(fps); setTimeout(() => { delete inp.dataset.cancel; }, 0); } });   // Escape cancels the edit
}
// A new frame rate re-snaps every marker to whole frames of the new rate.
function setFps(v) {
  const t = video.currentTime;
  fps = v; inF = outF = null;
  const n = nF();
  markers.forEach(m => {
    const s = clamp(F(m.start), 0, n - 1), e = clamp(F(m.end), s + 1, n);
    m.start = T(s); m.end = T(e);
  });
  seekFrame(Math.floor(t * fps));
  renderRuler(); changed(); commit(); updateClock(true);
}

/* ---------- playback and seeking ---------- */
// We aim for the middle of the frame so the browser can never round back to the frame before.
function seekFrame(f, reveal) {
  if (!meta) return;
  const c = clamp(Math.round(f), 0, nF() - 1);
  video.currentTime = (c + 0.5) / fps;
  if (reveal) scrollToFrame(c);
}
function togglePlay() { if (!meta) return; if (video.paused) { const p = video.play(); if (p && p.catch) p.catch(() => {}); } else video.pause(); }
function step(n) { if (!meta) return; video.pause(); seekFrame(curFrame() + n, true); }

let lastFrame = -1, lastPaused = null, overlayKey = '';
function updateClock(force) {
  if (!meta) return;
  const f = curFrame();
  if (!force && f === lastFrame && video.paused === lastPaused) return;
  lastFrame = f; lastPaused = video.paused;
  const c = $('clock');
  c.querySelector('.tc-main').textContent = tcf(T(f));
  c.querySelector('.tc-sub').textContent = '/ ' + tcf(nF() / fps) + ' · frame ' + f;
  setIcon($('bPlay'), video.paused ? 'play' : 'pause');
  const pct = (f / nF() * 100) + '%';
  playheadEl.style.left = pct; phHead.style.left = pct;
  followPlayhead(f);
  skipCutsCheck(); emitTime();
}
// Redraw the boxes on the video only when something that affects them has changed.
function refreshOverlay() {
  if (!meta) return;
  const f = curFrame();
  const active = markers.filter(m => m.boxes.length && inRange(m, f)).map(m => m.id).join(',');
  const key = ver + '|' + selId + '|' + selBox + '|' + active + '|' + stage.style.width + '|' + previewOn;
  if (key !== overlayKey) { overlayKey = key; renderOverlay(f); }
}
function tick() { requestAnimationFrame(tick); updateClock(false); refreshOverlay(); }
// The video's own events keep the clock right even when the browser slows animation (background tabs).
['seeking', 'seeked', 'timeupdate', 'play', 'pause', 'ended'].forEach(ev => video.addEventListener(ev, () => { updateClock(false); refreshOverlay(); }));

/* ---------- layout: fit the video into the middle area ---------- */
function fitStage() {
  if (!meta) return;
  const w = stageWrap.clientWidth - 36, hgt = stageWrap.clientHeight - 36;
  if (w < 60 || hgt < 60) return;
  const s = Math.min(w / meta.w, hgt / meta.h);
  stage.style.width = Math.floor(meta.w * s) + 'px';
  stage.style.height = Math.floor(meta.h * s) + 'px';
}
