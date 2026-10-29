/* =====================================================================
   02 - Video: opening, playback, seeking (everything snaps to whole frames)
   ===================================================================== */
let videoFile = null;                           // the File that is open now (the cleanup helper reads it)
// `handle` (optional) is the file's FileSystemFileHandle when the picker or a drop gave one: it is kept so a saved session can open this video again by itself.
function loadVideo(file, handle) {
  saveNow();                                    // the markers of the video that is open now are kept before another video takes their place
  if (handle) vidRemember(file.name, handle);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);        // the file is streamed by the browser, never read into memory by us
  pendingName = file.name; videoFile = file;
  video.src = objectUrl;
}
// Back to the empty state (used when a file cannot be played)
function closeVideo() {
  meta = null; videoFile = null; markers = []; selId = selBox = inF = outF = null;
  hist = []; hi = -1; syncUndo();
  stage.hidden = true; dropEl.hidden = false; $('btnPreview').hidden = true; $('vzoom').hidden = true; resetVideoZoom();
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
  dropEl.hidden = true; stage.hidden = false; $('btnPreview').hidden = false; $('vzoom').hidden = false;
  resetHistory();
  resetVideoZoom();                                // a new video always opens showing the whole picture
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
  const s = Math.min(w / meta.w, hgt / meta.h) * vz;
  stage.style.width = Math.floor(meta.w * s) + 'px';
  stage.style.height = Math.floor(meta.h * s) + 'px';
  clampPan();
}

/* ---------- zoom in on the picture (the timeline has its own zoom, see 03-timeline.js) ----------
   The picture is simply made bigger than the middle area, which hides what does not fit. Boxes are stored in video pixels and
   vpt() measures the overlay on screen, so drawing and moving boxes keeps working at any zoom. */
const VZ_MAX = 8;
let vz = 1;                       // how many times bigger than "fit"
let vpan = { x: 0, y: 0 };        // how far the picture is moved from the middle, in screen pixels
function clampPan() {
  // The picture can be moved until its edge, plus the 18 px margin, meets the edge of the area. When it fits there is nothing to move.
  const mx = Math.max(0, (stage.offsetWidth - stageWrap.clientWidth) / 2 + 18), my = Math.max(0, (stage.offsetHeight - stageWrap.clientHeight) / 2 + 18);
  vpan.x = clamp(vpan.x, -mx, mx); vpan.y = clamp(vpan.y, -my, my);
  stage.style.transform = vpan.x || vpan.y ? 'translate(' + vpan.x + 'px,' + vpan.y + 'px)' : '';
}
function syncVideoZoom() {
  $('vzVal').textContent = (vz < 10 ? vz.toFixed(1).replace('.0', '') : Math.round(vz)) + '×';
  $('vzFit').disabled = vz <= 1;
  $('vzOut').disabled = vz <= 1;
  $('vzIn').disabled = vz >= VZ_MAX;
  stage.classList.toggle('zoomed', vz > 1);
}
// Zoom while the point under screen (cx, cy) stays where it is (default: the middle of the area).
function setVideoZoom(z, cx, cy) {
  if (!meta) return;
  z = clamp(z, 1, VZ_MAX);
  if (z === vz) return;
  const wr = stageWrap.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  if (cx == null) { cx = wr.left + wr.width / 2; cy = wr.top + wr.height / 2; }
  const u = (cx - sr.left) / sr.width, v = (cy - sr.top) / sr.height, k = z / vz;     // the point as a fraction of the picture, and how much bigger the picture gets
  const W = sr.width * k, H = sr.height * k;
  vpan.x = cx - u * W - (wr.left + wr.width / 2 - W / 2);
  vpan.y = cy - v * H - (wr.top + wr.height / 2 - H / 2);
  vz = z;
  fitStage(); syncVideoZoom();
}
function resetVideoZoom() {
  vz = 1; vpan = { x: 0, y: 0 }; vpd = null;
  stage.style.transform = ''; stage.classList.remove('panning');
  syncVideoZoom();
}
stageWrap.addEventListener('wheel', e => {
  if (!meta || stage.hidden) return;
  e.preventDefault();                                            // nothing else here scrolls, so the wheel zooms (a pinch on a touchpad arrives as Ctrl + wheel)
  const dy = clamp(e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY, -60, 60);
  setVideoZoom(vz * Math.exp(-dy * (e.ctrlKey ? 0.015 : 0.0045)), e.clientX, e.clientY);
}, { passive: false });
$('vzIn').addEventListener('click', () => setVideoZoom(vz * 2));
$('vzOut').addEventListener('click', () => setVideoZoom(vz / 2));
$('vzFit').addEventListener('click', () => setVideoZoom(1));

// Moving the zoomed picture: the middle mouse button, Shift + drag, or a plain drag when no marker is picked (nothing could be drawn then anyway).
let vpd = null;
function startPan(e) {
  if (vz <= 1) return false;
  const plain = e.button === 0 && !e.shiftKey && !overlay.classList.contains('canDraw') && !e.target.closest('.box');
  if (!(plain || e.button === 1 || (e.button === 0 && e.shiftKey))) return false;
  e.preventDefault();
  try { overlay.setPointerCapture(e.pointerId); } catch (x) { /* synthetic events */ }
  vpd = { id: e.pointerId, x: e.clientX, y: e.clientY, px: vpan.x, py: vpan.y, moved: false, plain };
  stage.classList.add('panning');
  return true;
}
overlay.addEventListener('pointermove', e => {
  if (!vpd || e.pointerId !== vpd.id) return;
  const dx = e.clientX - vpd.x, dy = e.clientY - vpd.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) vpd.moved = true;
  vpan.x = vpd.px + dx; vpan.y = vpd.py + dy;
  clampPan();
});
function endPan(e) {
  if (!vpd || e.pointerId !== vpd.id) return;
  const d = vpd; vpd = null;
  stage.classList.remove('panning');
  if (!d.moved && d.plain && e.type === 'pointerup') toast('Pick a marker first (press M to add one), then drag on the video to draw a box.', 4200);
}
overlay.addEventListener('pointerup', endPan);
overlay.addEventListener('pointercancel', endPan);
