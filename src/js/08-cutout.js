/* =====================================================================
   08 - Cuts out: watch the video as if every cut were taken out
   The "Cuts out" button above the timeline plays the video with every cut jumped over: the cuts already on the timeline AND the ones that
   still wait under "Needs your decision" in the Cleanup tab (those have no marker yet, so the cleanup panel is asked: cuts()).
   Every cut is in one of three states:
     final      a cut you drew yourself, or one you committed (that is the Accept of the Cleanup tab)
     proposed   applied on its own by the Cleanup tab and not confirmed by you yet
     undecided  waits under "Needs your decision" (no marker yet)
   Commit makes cuts final: the cleanup panel's Accept. Put back takes a cut out again so that stretch plays: the panel's Reject (or deleting a
   cut that is not the panel's). Both are one step of Undo. Nothing here touches the video file; the view only changes what you watch.
   While the view is on: the timeline shades every cut by state, a bar under the picture shows where the playhead is once the cuts are out,
   and the cut you just heard skipped (or the one the playhead sits in) gets Commit and Put back buttons.
   ===================================================================== */
let skipCuts = false;                           // the view is on (named for the button it grew from: it used to only skip the cuts while playing)
let hideCuts = false;                           // the timeline draws no cut track and no shading, to keep it quiet; the cuts still work, still skip, and stay in the lists and the export
let cutCache = null, cutKey = '';               // { cuts, spans, removed }, rebuilt when the markers or the panel's cards change
let chipRange = null;                           // { lo, hi }: the stretch the bar's buttons act on
let panelSeen = null, panelSerial = 0, seenRev = '';

const isFinalCut = m => !(m.origin && m.origin.auto === true);       // an automatic cut is a proposal until it is accepted; every other cut is the user's own
// A string that changes when the open panel is another one or its cards changed (each video gets a new panel, whose counter starts again)
function panelRev() {
  if (cleanupPanel !== panelSeen) { panelSeen = cleanupPanel; panelSerial++; }
  try { return panelSerial + ':' + (cleanupPanel && cleanupPanel.revision ? cleanupPanel.revision() : 0); } catch (e) { return panelSerial + ':x'; }
}
function panelCards() { try { return cleanupPanel && cleanupPanel.cuts ? cleanupPanel.cuts() : []; } catch (e) { return []; } }

/* ---------- the list of cuts ---------- */
function buildCuts() {
  const dur = meta.duration, cuts = [], cutMarkers = markers.filter(m => m.type === 'cut');
  cutMarkers.forEach(m => cuts.push({
    key: 'm' + m.id, markerId: m.id, candId: (m.origin && m.origin.by === 'cleanup-panel' && m.origin.candidateId) || '', start: m.start, end: m.end,
    state: isFinalCut(m) ? 'final' : 'proposed', note: m.comment.trim()
  }));
  panelCards().forEach(c => {
    if (c.state !== 'pending') return;
    const s = clamp(c.start, 0, dur), e = clamp(c.end, 0, dur);
    if (!(e > s) || cutMarkers.some(m => m.start < e && m.end > s)) return;      // (an automatic cut that came back onto a waiting card already covers it)
    cuts.push({ key: 'c' + c.id, markerId: '', candId: c.id, start: s, end: e, state: 'undecided', note: c.text });
  });
  cuts.sort((a, b) => a.start - b.start || a.end - b.end);
  const spans = [];                                    // cuts that touch or overlap play as one jump
  cuts.forEach(c => {
    const last = spans[spans.length - 1];
    if (last && c.start <= last.end + 0.001) { last.end = Math.max(last.end, c.end); last.cuts.push(c); }
    else spans.push({ start: c.start, end: c.end, cuts: [c] });
  });
  let removed = 0;
  spans.forEach(sp => { sp.before = removed; removed += sp.end - sp.start; });
  return { cuts, spans, removed };
}
function cutData() {
  if (!meta) return { cuts: [], spans: [], removed: 0 };
  const key = ver + '|' + panelRev() + '|' + meta.duration;
  if (!cutCache || key !== cutKey) { cutCache = buildCuts(); cutKey = key; }
  return cutCache;
}
const cutOfMarker = m => cutData().cuts.find(c => c.markerId === m.id);
// Where a moment of the source video lands once the cuts are out, in seconds
function afterCutsAt(t) {
  let gone = 0;
  for (const sp of cutData().spans) { if (sp.start >= t) break; gone += Math.min(sp.end, t) - sp.start; }
  return t - gone;
}

/* ---------- playing ---------- */
function skipCutsCheck() {
  if (!skipCuts || !meta) return;
  const t = video.currentTime, sp = cutData().spans.find(s => t >= s.start - 0.001 && t < s.end - 0.001);
  syncCutPos(t);
  if (!sp) return;
  if (video.paused || rangeEnd != null) { showSpan(sp, false); return; }      // sitting inside a cut, or previewing one: nothing is jumped (a Preview of a stretch plays it as asked)
  if (relayJump(sp)) return;                                                  // the second <video> was waiting: no stall
  if (relayGrace && performance.now() < relayGrace.until && sp.end === relayGrace.end && t >= sp.end - RELAY_GRACE) return;      // it landed a hair before the cut's end: play on, a seek here would stall
  video.currentTime = Math.min(sp.end, meta.duration);                        // otherwise a plain seek (the browser has to decode from the keyframe before it: a short stall)
  showSpan(sp, true);
}

/* ---------- jumping without a stall ----------
   A seek makes the browser decode again from the keyframe before the new spot. On a screen recording with a keyframe every few seconds that is
   a quarter of a second or more: the picture freezes and the sound drops out at every cut, and it does not feel like the finished video.
   So a second <video> of the same file waits just after the next cut, already decoded. A moment before the cut it starts playing, muted and
   invisible (RELAY_LEAD), and when the playhead reaches the cut the two trade places: the waiting one is unmuted and shown, the old one is paused,
   and the old one then goes off to wait at the cut after that. `video` always names the one on screen, so nothing else in the page notices.
   The plain seek above stays as the safety net: it does the jump whenever the second <video> is not ready, the browser refuses it, or the
   cut is at the very end. Nothing is written to the video or the markers. */
const RELAY_AHEAD = 4;           // seconds: start preparing for a cut when it is this close
const RELAY_LEAD = 0.12;         // seconds of real time the waiting video plays, muted, before it takes over (the browser's start-up delay is absorbed here)
let spareEl = null;              // the <video> that is not on screen (null until the first cut view needs it)
let relay = null;                // { sp, aim, ready, playing, token } while the spare is on its way to the next cut
const RELAY_LAND = 0.012;        // seconds past the cut's end the waiting video should be at when it takes over (landing inside the cut would play a bit of it)
const RELAY_GRACE = 0.04;        // a swap that still lands this close before the cut's end is left alone for a moment instead of being seeked
let relayTok = 0, relayShift = 0.06, relayOff = false, relayTimer = null, relayAt = 0, inputAt = 0, relayGrace = null;      // relayShift: learnt correction, in seconds of the video (the browser takes about 40 ms to start playing)
['keydown', 'pointerdown'].forEach(n => document.addEventListener(n, () => { inputAt = performance.now(); }, true));

function relayMake() {
  const el = document.createElement('video');
  el.playsInline = true; el.preload = 'auto'; el.muted = true; el.className = 'spare';
  el.addEventListener('error', () => { relayOff = true; relayCancel(); });
  wireVideo(el);
  video0.parentNode.insertBefore(el, video0.nextSibling);      // before the overlay, so the boxes stay on top
  return el;
}
function relayCancel() {
  relay = null; relayTok++;
  if (spareEl) { try { spareEl.pause(); } catch (e) { /* nothing to stop */ } spareEl.muted = true; }
}
// The spare lets go of the file (the view goes off), so it does not hold a second decoder for nothing
function relayRelease() {
  if (spareEl) { spareEl.removeAttribute('src'); delete spareEl.dataset.url; try { spareEl.load(); } catch (e) { /* nothing loaded */ } }
}
// A new video opens (or the video is closed): the page's own <video> is the live one again
function relayReset() {
  relayCancel();
  if (video !== video0) {
    const old = video; video = video0;
    old.classList.add('spare'); video0.classList.remove('spare'); video0.muted = false; old.muted = true;
    spareEl = old;
  }
  relayRelease();
}
function relayStart() { if (!relayTimer) relayTimer = setInterval(relayTick, 8); }
function relayStop() { if (relayTimer) { clearInterval(relayTimer); relayTimer = null; } relayCancel(); }

function relayPrime(sp) {
  const el = spareEl || (spareEl = relayMake()), rate = video.playbackRate || 1, token = ++relayTok;
  relay = { sp, token, ready: false, playing: false, aim: Math.max(0, sp.end - RELAY_LEAD * rate + relayShift) };
  if (el.dataset.url !== objectUrl) { el.src = objectUrl; el.dataset.url = objectUrl; }
  el.muted = true; el.playbackRate = rate; el.pause();
  const go = () => {
    if (!relay || relay.token !== token) return;
    el.addEventListener('seeked', () => { if (relay && relay.token === token) relay.ready = true; }, { once: true });
    el.currentTime = relay.aim;
  };
  if (el.readyState >= 1) go(); else el.addEventListener('loadedmetadata', go, { once: true });
}
function relayTick() {
  if (!skipCuts || !meta || relayOff) { if (relay) relayCancel(); return; }
  if (video.paused || video.seeking || video.ended || rangeEnd != null) { if (relay) relayCancel(); return; }
  const t = video.currentTime, rate = video.playbackRate || 1, spans = cutData().spans;
  if (relay && (!spans.some(s => s.start === relay.sp.start && s.end === relay.sp.end) || t > relay.sp.end)) relayCancel();      // the cut it waits at is gone or edited, or the playhead is already past it
  if (!relay) {
    const next = spans.find(s => s.start > t + 0.0005);
    if (next && next.end <= meta.duration - 0.1 && (next.start - t) / rate <= RELAY_AHEAD) relayPrime(next);      // (a cut that runs to the end is left to the plain seek)
    return;
  }
  const sp = relay.sp;      // it keeps the cut it waits at, also in the instant the playhead reaches it
  if (!relay.ready) return;
  spareEl.playbackRate = rate;
  if (!relay.playing && t >= sp.start - RELAY_LEAD * rate) {
    relay.playing = true;
    const p = spareEl.play(); if (p && p.catch) p.catch(() => { relayOff = true; relayCancel(); });      // (a browser that will not play it unseen: no relay, the plain seek is used)
  }
  if (relay.playing && t >= sp.start - 0.004 * rate) { if (relaySwap()) updateClock(true); }      // (half a tick early, so the jump is as often early as late)
}
// Called by skipCutsCheck() when the playhead has reached a cut: true when the waiting video took over
function relayJump(sp) {
  if (!relay || !relay.ready || !relay.playing || relay.sp.start !== sp.start || relay.sp.end !== sp.end) return false;
  return relaySwap();
}
function relaySwap() {
  const sp = relay.sp, nxt = spareEl, cur = video, err = nxt.currentTime - sp.end;      // err > 0: the waiting video is already past the cut's end
  if (nxt.paused || nxt.seeking || nxt.readyState < 2 || Math.abs(err) > 0.25) { relayCancel(); return false; }
  cur.muted = true; nxt.muted = false;
  nxt.classList.remove('spare'); cur.classList.add('spare');
  cur.pause();
  video = nxt; spareEl = cur; relay = null; relayTok++; relayAt = performance.now();
  relayShift = Math.max(-0.2, Math.min(0.2, relayShift + 0.8 * (RELAY_LAND - err)));      // aim a little earlier or later next time, so it lands just past the cut's end
  relayGrace = { end: sp.end, until: relayAt + 300 };
  showSpan(sp, true);
  return true;
}
// The browser paused the live video by itself right after a swap (some browsers do that when sound is switched on without a click): give up on swapping and carry on playing
function cutPaused() {
  if (!relayAt || performance.now() - relayAt > 400 || performance.now() - inputAt < 600) return;
  relayOff = true; relayAt = 0;
  const p = video.play(); if (p && p.catch) p.catch(() => {});
}

function setSkipCuts(on) {
  skipCuts = !!on; ui.skipCuts = skipCuts; saveUi();
  if (skipCuts) relayStart(); else { relayStop(); relayRelease(); }
  const b = $('bSkip'); b.classList.toggle('on', skipCuts); b.setAttribute('aria-pressed', String(skipCuts));
  b.title = skipCuts ? 'Cuts out is on: the video plays with every cut jumped over. Click to play everything again.'
                     : 'Watch the video with every cut taken out, including the ones still waiting for your decision';
  chipRange = null;
  refreshCutView();
}

// "Cut track" button: show or hide the cuts on the timeline (the track of red clips and the Cuts out shading)
function setHideCuts(on) {
  hideCuts = !!on; ui.hideCuts = hideCuts; saveUi();
  const b = $('bCutVis'); b.classList.toggle('on', !hideCuts); b.setAttribute('aria-pressed', String(!hideCuts)); setIcon(b, hideCuts ? 'eye-off' : 'eye');
  b.title = hideCuts ? 'The cuts are hidden on the timeline. Click to show the cut track again.'
                     : 'Hide the cuts on the timeline (the cut track and the shading) to keep it quiet. They still work and stay in the Markers tab.';
  if (meta) renderTimeline();
}

/* ---------- what the view shows ---------- */
// Everything that depends on the cuts, redrawn: the shading on the timeline, the bar, the buttons on the cut, the clock line
function refreshCutView() {
  cutKey = '';
  if (!meta) { syncCutBar(); return; }
  renderCutBands(); syncCutBar(); renderCutChip(); updateClock(true);
}
function cutViewChanged() { if (skipCuts) { syncCutBar(); renderCutChip(); updateClock(true); } }      // called by changed()
setInterval(() => {                                    // the panel's own decisions (a Reject of a waiting card) change no marker, so ask now and then
  if (!skipCuts || !meta) return;
  const r = panelRev();
  if (r !== seenRev) { seenRev = r; refreshCutView(); }
}, 400);

function renderCutBands() {
  const old = lanes.querySelector('.cutbands'); if (old) old.remove();
  if (!skipCuts || hideCuts || !meta) return;
  const dur = nF() / fps, wrap = h('div', { class: 'cutbands' });
  cutData().cuts.forEach(c => wrap.appendChild(h('div', { class: 'cutband ' + c.state, style: 'left:' + (c.start / dur * 100) + '%;width:' + ((c.end - c.start) / dur * 100) + '%' })));
  lanes.insertBefore(wrap, lanes.firstChild);          // behind the clips
}
let posText = '';
function syncCutPos(t) {
  const el = $('cbTime'); if (!el) return;
  const s = tcf(afterCutsAt(t)) + ' / ' + tcf(Math.max(0, nF() / fps - cutData().removed));
  if (s !== posText) { posText = s; el.textContent = s; }
}
function syncCutBar() {
  const bar = $('cutbar'); if (!bar) return;
  bar.hidden = !(skipCuts && meta);
  if (bar.hidden) return;
  const d = cutData(), n = { final: 0, proposed: 0, undecided: 0 };
  d.cuts.forEach(c => { n[c.state]++; });
  $('cbGone').textContent = d.cuts.length ? '−' + tc(d.removed) + ' in ' + d.cuts.length + (d.cuts.length === 1 ? ' cut' : ' cuts') : 'no cuts yet';
  $('cbNFinal').textContent = n.final; $('cbNProposed').textContent = n.proposed; $('cbNUndecided').textContent = n.undecided;
  const open = n.proposed + n.undecided, b = $('cbCommitAll');
  b.disabled = open === 0;
  b.querySelector('.lbl').textContent = open ? 'Commit all ' + open : 'All final';
  posText = ''; syncCutPos(video.currentTime);
}

/* The buttons on the cut you just heard skipped (or the one the playhead sits in) */
const chipCuts = () => (chipRange && meta ? cutData().cuts.filter(c => c.start < chipRange.hi && c.end > chipRange.lo) : []);
const cutChipHeld = () => { const e = $('cbLast'); return !!e && (e.matches(':hover') || e.contains(document.activeElement)); };      // the pointer is on the buttons: keep what they act on
function showSpan(sp, fromJump) {
  if (fromJump && cutChipHeld()) return;
  if (chipRange && chipRange.lo === sp.start && chipRange.hi === sp.end) return;
  chipRange = { lo: sp.start, hi: sp.end }; renderCutChip();
}
function renderCutChip() {
  const box = $('cbLast'); if (!box) return;
  const cuts = skipCuts ? chipCuts() : [];
  box.hidden = !cuts.length;
  box.textContent = '';
  if (!cuts.length) return;
  const lo = Math.min(...cuts.map(c => c.start)), hi = Math.max(...cuts.map(c => c.end)), open = cuts.filter(c => c.state !== 'final');
  const note = cuts.length === 1 && cuts[0].note ? cuts[0].note : '';
  [h('span', { class: 'cb-lbl' }, cuts.length === 1 ? 'Cut ' : cuts.length + ' cuts ', h('b', { text: tcf(lo) + ' to ' + tcf(hi) }), ' · ' + sec2(hi - lo) + ' s'),
   ['final', 'proposed', 'undecided'].filter(s => cuts.some(c => c.state === s)).map(s => h('span', { class: 'pill cutstate ' + s, text: s })),
   note ? h('span', { class: 'cb-note', title: note, text: note }) : null,
   h('span', { class: 'grow' }),
   h('button', { class: 'btn sm', title: 'Take this cut out again, so this stretch plays. Undo brings the cut back.', onclick: () => putBackCuts(cuts) }, icon('undo'), 'Put back'),
   open.length ? h('button', { class: 'btn sm primary', title: 'Make this cut final: the same as Accept in the Cleanup tab', onclick: () => commitCuts(open) }, icon('check'), 'Commit') : null
  ].flat().forEach(el => { if (el) box.appendChild(el); });
}

/* ---------- Commit and Put back ---------- */
const cardIds = () => new Set(panelCards().map(c => c.id));
function commitCuts(list) {
  const todo = list.filter(c => c.state !== 'final');
  if (!todo.length) { toast('Those cuts are already final.'); return; }
  const known = cardIds(), cards = [], loose = [];
  todo.forEach(c => { if (c.candId && known.has(c.candId)) cards.push(c.candId); else if (c.markerId) loose.push(c.markerId); });
  cleanupApi.batch(() => {
    if (cards.length) cleanupPanel.decide('accept', cards);
    loose.forEach(id => { const m = byId(id); if (m && m.origin) m.origin.auto = false; });      // a cut of an old transcript that no card claims: it is simply yours now
  });
  if (loose.length) { commit(); changed(); }
  refreshCutView();
  toast(todo.length === 1 ? 'Committed: this cut is final.' : 'Committed ' + todo.length + ' cuts. Undo (' + MOD + (isMac ? 'Z' : '+Z') + ') takes it back.', 3600);
}
function putBackCuts(list) {
  if (!list.length) return;
  const known = cardIds(), cards = [], loose = [];
  list.forEach(c => { if (c.candId && known.has(c.candId)) cards.push(c.candId); else if (c.markerId) loose.push(c.markerId); });
  const lo = Math.min(...list.map(c => c.start)), hi = Math.max(...list.map(c => c.end)), playing = !video.paused;
  cleanupApi.batch(() => {
    if (cards.length) cleanupPanel.decide('reject', cards);
    loose.forEach(id => cleanupApi.removeCut(id));
  });
  refreshCutView();
  seekFrame(F(Math.max(0, lo - 1)), true);              // a second before it, so you hear it in its place
  if (playing) { const p = video.play(); if (p && p.catch) p.catch(() => {}); }
  toast('Put back ' + tcf(lo) + ' to ' + tcf(hi) + ': it plays again. Undo (' + MOD + (isMac ? 'Z' : '+Z') + ') takes it out.', 4200);
}
function commitAllCuts() { commitCuts(cutData().cuts.filter(c => c.state !== 'final')); }

/* ---------- the same two buttons in the Properties panel of a cut ---------- */
function secCut(m) {
  const fin = isFinalCut(m), c = cutOfMarker(m);
  return h('div', { class: 'sec' }, h('h4', { text: 'Cut' }),
    h('div', { class: 'cutstate-line' }, h('span', { class: 'pill cutstate ' + (fin ? 'final' : 'proposed') }, icon(fin ? 'check' : 'clock'), fin ? 'final' : 'proposed'),
      h('span', { class: 'hint', text: fin ? 'Yours. The export tells Claude this cut is final.' : 'Applied on its own and not confirmed. The export tells Claude it is only a proposal.' })),
    c ? h('div', { class: 'row-btns' },
      fin ? null : h('button', { class: 'btn sm primary', onclick: () => commitCuts([c]) }, icon('check'), 'Commit this cut'),
      h('button', { class: 'btn sm', onclick: () => putBackCuts([c]) }, icon('undo'), 'Put it back')) : null);
}
