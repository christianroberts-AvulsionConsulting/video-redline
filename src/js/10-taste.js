/* =====================================================================
   10 - Taste Test: short "1 or 2?" pairs that teach Claude how this editor likes the edit
   The editor hears the same moment of their own video twice, version 1 and version 2, and answers 1 is better, 2 is better, Same, or
   Both bad (with a short note). They are never told which version is the setting they have now. Two ways in:
     Tune a step        one round per editing step. Each answer moves the setting toward the version picked, and the next pair is closer
                        together, like an eye test; once the answers turn to Same it has found the spot. Dead air comes first: it plays the
                        raw recording with the rough cut's pauses trimmed by different amounts (the rough cut writes redline-pauses.json).
     Which pass is better?   only the spots where the open pass and an earlier pass (a saved session file) cut differently, played blind.
   Settings change as soon as an answer is in, and the round can be stopped at any time without losing a pick. Each editor's taste profile
   lives in their own Obsidian vault: the Video Redline helper (tools/vrt_taste.py) makes the vault when there is none and writes the
   note. Claude's tools read the profile from the vault note (the rough cut reads its dead-air timing from it).
   The clips play through Cuts out's seamless jumps (08-cutout.js): while a clip plays, tasteSpans stands in for the cuts on the timeline.
   Nothing here changes the markers or the video.
   ===================================================================== */
const TASTE_PORTS = [47831, 47832, 47833, 47834, 47835];
const PROFILE_FORMAT = 'video-redline-taste-profile/1';
const ROUND_SIZES = [['About 2 minutes', 8], ['About 5 minutes', 20], ['About 10 minutes', 40], ['Until I stop', 1e9]];
const LATER_STEPS = ['Cuts: stutters, retakes and cut edges', 'Little sounds', 'Zooms', 'Cards and look', 'Blurs', 'B-roll ideas', 'Chapters and titles'];
const HOUSE_DEAD_AIR = { tailSeconds: 0.14, headSeconds: 0.10, minGapSeconds: 0.35 };      // the rough cut's preferences.json, for an editor with no profile yet
const r2 = v => Math.round(v * 100) / 100;
const copyOf = o => JSON.parse(JSON.stringify(o));
const mmss = t => Math.floor(t / 60) + ':' + pad2(Math.floor(t % 60));      // plain lines say 3:25, not 3:25.20

const TASTE = {
  port: null,                     // a helper that knows /taste
  info: null,                     // its last answer to GET /taste
  profile: null,                  // the editor's profile, as it is now
  pauses: null,                   // the rough cut's pause list for the open video
  older: null,                    // { name, cuts } an earlier pass, for Which pass is better?
  run: null,                      // the round in progress
  last: null,                     // the round that just finished: { round, saved }
  size: 1,                        // index into ROUND_SIZES
  busy: '', said: '',
};

/* ---------- the helper ---------- */
async function tasteHttp(port, path, opts, ms) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, t = setTimeout(() => ctl && ctl.abort(), ms || 4000);
  try {
    const r = await fetch('http://127.0.0.1:' + port + path, Object.assign({ cache: 'no-store', signal: ctl ? ctl.signal : undefined }, opts || {}));
    let body = null; try { body = await r.json(); } catch (e) { /* not JSON */ }
    return { status: r.status, body };
  } finally { clearTimeout(t); }
}
// Ask each port in turn for /taste: an older helper on the first port answers 404, and a newer one may be running on the next
async function tasteFind() {
  const order = (TASTE.port ? [TASTE.port] : []).concat(TASTE_PORTS.filter(p => p !== TASTE.port));
  TASTE.oldHelper = false;
  for (const p of order) {
    try {
      const r = await tasteHttp(p, '/taste', null, 1500);
      if (r.status === 200 && r.body && r.body.ok) { TASTE.port = p; return r.body; }
      if (r.status === 404 && r.body && r.body.error) TASTE.oldHelper = true;           // a helper from before the Taste Test
    } catch (e) { /* nothing there */ }
  }
  TASTE.port = null; return null;
}
async function tasteRefresh() {
  TASTE.busy = 'Looking for the Video Redline helper…'; tasteRender();
  const info = await tasteFind();
  TASTE.busy = ''; TASTE.info = info;
  if (info && info.setUp) TASTE.profile = tasteMergeDraft(info.profile && info.profile.format === PROFILE_FORMAT ? info.profile : tasteNewProfile(info));
  tasteRender();
}
// Only the name is needed: the helper makes the Obsidian vault itself
async function tasteSetup(form) {
  const body = { editor: form.editor.value.trim(), channel: form.channel.value.trim() };
  if (form.vault.value.trim()) body.vault = form.vault.value.trim();
  if (!body.editor) { TASTE.said = 'Type your name.'; tasteRender(); return; }
  TASTE.busy = 'Setting up Obsidian…'; tasteRender();
  try {
    const r = await tasteHttp(TASTE.port, '/taste/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 15000);
    const res = (r.status === 200 && r.body && r.body.result) || {};
    TASTE.said = r.status === 200 ? (res.vault && res.vault.message) || '' : ((r.body && r.body.message) || 'The helper could not save that.');
  } catch (e) { TASTE.said = 'The helper did not answer. Is it still running?'; }
  TASTE.busy = '';
  await tasteRefresh();
}
async function tasteSave() {
  const p = TASTE.profile; if (!p) return null;
  p.updated = new Date().toISOString();
  p.lines = tasteLines(p); p.settingsText = tasteSettingsText(p);
  try { store.set('vrt:taste:draft', JSON.stringify(p)); } catch (e) { /* storage full */ }
  if (!TASTE.port) return { ok: false, message: 'Not saved to your vault yet: the helper is not running. Your picks are kept on this computer until it is.' };
  try {
    const r = await tasteHttp(TASTE.port, '/taste/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: p }) }, 30000);
    if (r.status !== 200 || !r.body || !r.body.ok) return { ok: false, message: (r.body && r.body.message) || 'The helper could not save your picks. They are kept on this computer.' };
    store.set('vrt:taste:draft', '');
    return { ok: true, note: r.body.note };
  } catch (e) { return { ok: false, message: 'The helper did not answer, so your picks are kept on this computer for now.' }; }
}
// Picks made while the helper was away are kept in this browser; they win when they are newer than the vault's copy
function tasteMergeDraft(p) {
  try {
    const d = JSON.parse(store.get('vrt:taste:draft') || 'null');
    if (d && d.format === PROFILE_FORMAT && d.editor === p.editor && String(d.updated) > String(p.updated || '')) { setTimeout(() => tasteSave().then(tasteRender), 0); return d; }
  } catch (e) { /* no draft */ }
  return p;
}
function tasteNewProfile(info) {
  return { format: PROFILE_FORMAT, editor: info.editor, channel: info.channel || '', updated: '', settings: {}, lines: [], settingsText: [], rounds: [] };
}

/* ---------- what the profile says, in plain words ---------- */
const deadAirOf = p => Object.assign({}, HOUSE_DEAD_AIR, (p && p.settings && p.settings.deadAir) || {});
function tasteSettingsText(p) {
  const d = deadAirOf(p);
  return ['Dead air: keep ' + d.tailSeconds.toFixed(2) + ' s after speech and ' + d.headSeconds.toFixed(2) + ' s before it, and leave pauses under ' + d.minGapSeconds.toFixed(2) + ' s alone' + (p.settings && p.settings.deadAir ? '.' : ' (the house values: no dead-air round yet).')];
}
// The newest round of each step that was not undone says what this editor likes (a Which pass check is a check, not taste)
function tasteLines(p) {
  const seen = new Set(), out = [];
  (p.rounds || []).slice().reverse().forEach(r => { if (r.undone || r.mode !== 'tune' || seen.has(r.step)) return; seen.add(r.step); out.unshift(...(r.summary || [])); });
  return out;
}

/* ---------- the rough cut's pause list ---------- */
// Rebuilds the rough cut's keep list for other timings (the same steps as find-cuts.mjs; see the note where it writes redline-pauses.json)
function tasteKeep(p, s) {
  const pf = p.fps || 30, dur = p.duration;
  const down = t => Math.floor(t * pf + 1e-6) / pf, up = t => Math.ceil(t * pf - 1e-6) / pf;
  const groups = tasteGroups(p, s.minGapSeconds);
  const merge = list => {
    const out = [];
    for (const [a, b] of [...list].sort((x, y) => x[0] - y[0])) {
      if (out.length && a <= out[out.length - 1][1] + 1e-6) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
      else if (b > a) out.push([a, b]);
    }
    return out;
  };
  let keep = merge(groups.map(([a, b]) => [Math.max(0, down(a - s.headSeconds)), Math.min(dur, up(b + s.tailSeconds))]));
  if (p.held && p.held.length) keep = merge(keep.concat(p.held));
  for (const [cf, ct] of p.removals || []) {
    const next = [];
    for (const [a, b] of keep) {
      if (ct <= a || cf >= b) { next.push([a, b]); continue; }
      if (a < cf) next.push([a, cf]);
      if (ct < b) next.push([ct, b]);
    }
    keep = next;
  }
  return merge(keep.filter(([a, b]) => b - a >= 2 / pf));
}
// The pieces of sound joined where they are closer than minGap; a group stays when any piece in it is not noise
function tasteGroups(p, minGap) {
  const groups = [];
  for (const [a, b, kept] of p.islands) {
    const g = groups[groups.length - 1];
    if (g && a - g[1] < minGap - 1e-9) { g[1] = b; g[2] = g[2] || kept; } else groups.push([a, b, kept]);
  }
  return groups.filter(g => g[2]);
}
function spansOutside(keep, dur) {
  const out = []; let at = 0;
  keep.forEach(([a, b]) => { if (a > at + 1e-6) out.push({ start: at, end: a }); at = Math.max(at, b); });
  if (at < dur - 1e-6) out.push({ start: at, end: dur });
  return out;
}
// What plays around a spot: `back` seconds you hear before `t0` and `ahead` seconds after `t1` (heard time, so removed silence does not
// count). The clip also starts at least RUNWAY seconds before its first jump: the second <video> needs a moment to be ready at the first
// cut (see 08-cutout.js), and a plain seek there adds a stall that sounds like a longer pause, the very thing being judged.
const RUNWAY = 1.2;
function clipWindow(spans, t0, t1, back, ahead) {
  const keep = []; let at = 0;
  spans.forEach(s => { if (s.start > at) keep.push([at, s.start]); at = Math.max(at, s.end); });
  if (at < meta.duration) keep.push([at, meta.duration]);
  let i = keep.findIndex(([, b]) => b > t0 - 1e-6); if (i < 0) i = keep.length - 1;
  if (keep[i][0] > t0 && i > 0) i--;                    // t0 sits in a cut: start from the piece before it
  let need = back, from = Math.min(t0, keep[i][1]);
  while (i >= 0) {
    const a = keep[i][0], have = from - a;
    if (have >= need) { from -= need; break; }
    need -= have; if (i === 0) { from = a; break; }
    i--; from = keep[i][1];
  }
  for (let k = 0; k < 3 && keep[i][1] - from < RUNWAY && i > 0; k++) { i--; from = Math.max(keep[i][0], keep[i][1] - RUNWAY); }
  let j = keep.findIndex(([, b]) => b > t1 + 1e-6), to = t1;
  need = ahead;
  while (j >= 0 && j < keep.length) {
    const [a, b] = keep[j], start = Math.max(a, to), have = b - start;
    if (have >= need) { to = start + need; break; }
    need -= have; to = b; j++;
  }
  return { from: Math.max(0, from), to: Math.min(meta.duration, to) };
}
async function tasteLoadPauses(file) {
  let p;
  try { p = JSON.parse(await readFile(file)); } catch (e) { toast('That file could not be read.'); return; }
  if (!p || p.format !== 'rough-cut-pauses/1' || !Array.isArray(p.islands)) { toast('That is not a pause list. The rough cut writes it as redline-pauses.json in its work folder.', 6000); return; }
  if (Math.abs(p.duration - meta.duration) > 1) { toast('That pause list is for a recording of ' + tc(p.duration) + ', but the video open is ' + tc(meta.duration) + '. Open the raw recording the rough cut worked on.', 7000); return; }
  TASTE.pauses = p;
  try { store.set('vrt:taste:pauses|' + storeKey(), JSON.stringify(p)); } catch (e) { /* too big to keep: it is only needed now */ }
  toast('Pause list loaded: ' + p.islands.length + ' pieces of sound from ' + p.source + '.');
  tasteRender();
}
function tasteRecallPauses() {
  TASTE.pauses = null; TASTE.older = null;
  if (!meta) return;
  try { const p = JSON.parse(store.get('vrt:taste:pauses|' + storeKey()) || 'null'); if (p && p.format === 'rough-cut-pauses/1') TASTE.pauses = p; } catch (e) { /* none kept */ }
}

/* ---------- playing a clip ---------- */
let tasteClip = null, tasteWasSkip = false;
function tasteBadge(text) {
  let b = $('tasteBadge');
  if (!b) { b = h('div', { class: 'taste-badge', id: 'tasteBadge' }); stage.appendChild(b); }
  b.hidden = !text; b.textContent = text || '';
}
// Plays `from` to `to` (seconds of the video) with `spans` jumped over. Resolves true when it played to the end, false when it was stopped.
function tastePlayOne(spans, from, to, label) {
  tasteEndClip(false);
  return new Promise(resolve => {
    stopRange(); video.pause();
    tasteWasSkip = skipCuts;
    tasteSpans = { cuts: [], spans, removed: spans.reduce((t, s) => t + s.end - s.start, 0) };
    skipCuts = true; relayCancel(); relayStart();
    refreshCutView();                                    // the Cuts out bar and the timeline's shading step aside while the clip plays
    let start = clamp(from, 0, meta.duration);
    const inCut = spans.find(s => start >= s.start && start < s.end); if (inCut) start = inCut.end;
    const clip = tasteClip = { to, resolve, started: 0 };
    tasteBadge(label);
    const go = () => {
      if (tasteClip !== clip || clip.started) return;
      clip.started = performance.now();
      const p = video.play(); if (p && p.catch) p.catch(() => tasteEndClip(false));
    };
    video.addEventListener('seeked', go, { once: true });
    setTimeout(go, 700);                                 // (a seek to where it already is may never say "seeked")
    video.currentTime = start;
    clip.timer = setInterval(() => {
      if (tasteClip !== clip || !clip.started) return;
      if (video.currentTime >= clip.to - 0.005 || video.ended) tasteEndClip(true);
      else if (video.paused && !video.seeking && performance.now() - clip.started > 400) tasteEndClip(false);      // someone paused it
    }, 10);
  });
}
function tasteEndClip(ok) {
  const c = tasteClip; if (!c) return;
  tasteClip = null; clearInterval(c.timer);
  video.pause();
  tasteSpans = null; skipCuts = tasteWasSkip;
  if (!skipCuts) relayStop();
  tasteBadge('');
  refreshCutView();
  c.resolve(ok);
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function tastePlayPair(pair, which) {
  const run = TASTE.run; if (!run) return;
  const token = run.playToken = (run.playToken || 0) + 1, mine = () => TASTE.run === run && run.playToken === token;
  run.playing = which || 'both'; tasteRender();
  const order = which === 1 ? [1] : which === 2 ? [2] : [1, 2];
  for (let i = 0; i < order.length; i++) {
    if (!mine()) return;
    if (i) await wait(650);
    const v = pair.versions[order[i]];
    const ok = await tastePlayOne(v.spans, pair.from, pair.to, String(order[i]));
    if (!ok) break;
  }
  if (mine()) { run.playing = ''; tasteRender(); }
}

/* ---------- Tune a step: dead air ----------
   Two settings, each found like an eye test: the pause left between sentences (what is kept after speech plus before the next, in the same
   proportion as now), and the longest pause inside a sentence that is left alone. */
const DEAD_PARAMS = {
  pause: {
    name: 'pause between sentences', noDifference: 'You heard no difference in the pause between sentences, so it stays as it was.', step: 0.12, minStep: 0.03, lo: 0.11, hi: 1.2,
    get: s => r2(s.tailSeconds + s.headSeconds),
    set: (s, v) => { const share = s.tailSeconds / (s.tailSeconds + s.headSeconds), tail = Math.max(0.06, r2(v * share)); return Object.assign({}, s, { tailSeconds: tail, headSeconds: Math.max(0.05, r2(v - tail)) }); },
    floorSays: 'Pauses can go no tighter than this: below it, word endings start to clip.',
  },
  gap: {
    name: 'short pauses left alone', noDifference: 'You heard no difference in how the short pauses were handled, so that stays as it was.', step: 0.2, minStep: 0.05, lo: 0.2, hi: 1.2,
    get: s => s.minGapSeconds, set: (s, v) => Object.assign({}, s, { minGapSeconds: r2(v) }),
  },
};
function stairNew(def, value) { return { value, start: value, step: def.step, tried: [], prefer: 0, n: 0, moves: 0, sames: 0, done: false, floored: false }; }
function stairCandidate(def, st, lo) {
  const dirs = st.tried.length ? [-st.tried[0]] : st.prefer ? [st.prefer, -st.prefer] : (Math.random() < 0.5 ? [1, -1] : [-1, 1]);
  for (const d of dirs) {
    if (st.tried.includes(d)) continue;
    const v = r2(clamp(st.value + d * st.step, Math.max(def.lo, lo || 0), def.hi));
    if (Math.abs(v - st.value) >= def.minStep / 2) return { dir: d, value: v };
  }
  return null;
}
function stairAnswer(def, st, cand, verdict, lo) {
  st.n++;
  if (verdict === 'cand') { st.value = cand.value; st.tried = []; st.prefer = cand.dir; st.moves++; if (def.floorSays && st.value <= def.lo + 1e-9) st.floored = true; }
  else if (verdict === 'cur') { st.tried.push(cand.dir); st.prefer = 0; if (st.tried.length >= 2 || !stairCandidate(def, st, lo)) { st.step /= 2; st.tried = []; } }
  else if (verdict === 'same') { st.step /= 2; st.tried = []; st.sames++; }
  if (st.step < def.minStep - 1e-9 || st.n >= 6 || !stairCandidate(def, st, lo)) st.done = true;
}
// Where a pair can be heard: a pause (raw gap between two groups of speech) that both versions trim differently
function deadAirSpots(run, key, a, b) {
  const p = TASTE.pauses, words = p.words || [];
  const lowGap = Math.min(a.minGapSeconds, b.minGapSeconds), groups = tasteGroups(p, lowGap), out = [];
  const pauseA = a.tailSeconds + a.headSeconds, pauseB = b.tailSeconds + b.headSeconds;
  for (let i = 0; i + 1 < groups.length; i++) {
    const end = groups[i][1], next = groups[i + 1][0], L = next - end;
    if (end < 4 || next > p.duration - 4 || run.used.has(Math.round(end * 10))) continue;
    if ((p.removals || []).some(([x, y]) => x < next + 3 && y > end - 3)) continue;           // a mistake cut nearby would muddle what is being compared
    const prev = words.filter(w => w[1] <= end + 0.08).pop(), sentence = !!prev && /[.?!]["')]?$/.test(prev[2]);
    let fits;
    if (key === 'pause') fits = L > Math.max(pauseA, pauseB) + 0.1 && L >= Math.max(a.minGapSeconds, b.minGapSeconds);
    else fits = L >= Math.min(a.minGapSeconds, b.minGapSeconds) && L < Math.max(a.minGapSeconds, b.minGapSeconds) && L > Math.min(pauseA, pauseB) + 0.08;
    if (fits) out.push({ i, end, next, L, sentence });
  }
  // A pause trial is best on real dead air after a sentence (what the rough cut is there to remove), a gap trial on a short pause inside one
  const want = key === 'pause' ? out.filter(s => s.sentence && s.L >= Math.max(pauseA, pauseB) + 0.4) : out.filter(s => !s.sentence);
  const pool = want.length ? want : key === 'pause' && out.some(s => s.sentence) ? out.filter(s => s.sentence) : out;
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
}
function deadAirNext(run) {
  const keys = Object.keys(DEAD_PARAMS).filter(k => !run.stairs[k].done);
  if (!keys.length) return null;
  for (let tries = 0; tries < keys.length; tries++) {
    const key = keys[(run.turn++) % keys.length], def = DEAD_PARAMS[key], st = run.stairs[key];
    const lo = key === 'gap' ? (TASTE.pauses.floorGap || 0.15) + 0.05 : 0;
    const cand = stairCandidate(def, st, lo);
    if (!cand) { st.done = true; continue; }
    const cur = run.settings, other = def.set(cur, cand.value);
    const spot = deadAirSpots(run, key, cur, other);
    if (!spot) { st.done = true; continue; }
    run.used.add(Math.round(spot.end * 10));
    const flip = Math.random() < 0.5;
    const ver = s => ({ settings: s, spans: spansOutside(tasteKeep(TASTE.pauses, s), meta.duration) });
    const versions = flip ? { 1: ver(other), 2: ver(cur) } : { 1: ver(cur), 2: ver(other) };
    const { from, to } = clipWindow(cutUnion(versions[1].spans.concat(versions[2].spans)), spot.end, spot.next, 3, 2.5);
    return { key, cand, from, to, at: spot.end, sentence: spot.sentence, candidateIs: flip ? 1 : 2, versions, what: 'the ' + def.name };
  }
  return null;
}
function deadAirAnswer(run, pair, answer) {
  const def = DEAD_PARAMS[pair.key], st = run.stairs[pair.key];
  const verdict = answer === 'same' ? 'same' : answer === 'bad' ? 'bad' : Number(answer) === pair.candidateIs ? 'cand' : 'cur';
  const lo = pair.key === 'gap' ? (TASTE.pauses.floorGap || 0.15) + 0.05 : 0;
  stairAnswer(def, st, pair.cand, verdict, lo);
  if (verdict === 'cand') {
    run.settings = def.set(run.settings, st.value);
    TASTE.profile.settings.deadAir = Object.assign({}, run.settings);      // settings change right away
  }
}
function deadAirSummary(run) {
  const lines = [], b = run.before, a = run.settings;
  const said = (key, more, less, same) => {
    const st = run.stairs[key]; if (!st.n) return;
    const d = DEAD_PARAMS[key].get(a) - DEAD_PARAMS[key].get(b);
    if (st.sames === st.n) lines.push(DEAD_PARAMS[key].noDifference);
    else lines.push(Math.abs(d) < 0.03 ? same : d > 0 ? more(d) : less(-d));
  };
  said('pause', d => d > 0.15 ? 'You like clearly longer pauses between sentences.' : 'You like a bit more breathing room between sentences.',
    d => d > 0.15 ? 'You like much tighter pauses between sentences.' : 'You like the pauses between sentences a bit tighter.',
    'The pause between sentences was already about right for you.');
  said('gap', () => 'Leave more of the short, natural pauses inside a sentence alone.', () => 'Tighten even the short pauses inside a sentence.',
    'Which short pauses get left alone was already right for you.');
  if (run.stairs.pause.floored) lines.push(DEAD_PARAMS.pause.floorSays);
  return lines;
}

/* ---------- Which pass is better? ---------- */
function cutUnion(list) {
  const out = [];
  list.map(c => [c.start, c.end]).sort((x, y) => x[0] - y[0]).forEach(([a, b]) => {
    if (out.length && a <= out[out.length - 1].end + 1e-6) out[out.length - 1].end = Math.max(out[out.length - 1].end, b); else if (b > a) out.push({ start: a, end: b });
  });
  return out;
}
const undecidedCards = against => panelCards().filter(c => c.state === 'pending' && !against.some(m => m.start < c.end && m.end > c.start)).map(c => ({ start: c.start, end: c.end }));
// The stretches only one of the two passes cuts, gathered into spots a few seconds apart
function passSpots(oldSpans, newSpans) {
  const edges = new Set([0, meta.duration]); oldSpans.concat(newSpans).forEach(s => { edges.add(s.start); edges.add(s.end); });
  const xs = [...edges].sort((a, b) => a - b), inSome = (list, t) => list.some(s => t >= s.start && t < s.end), parts = [];
  for (let i = 0; i + 1 < xs.length; i++) { const m = (xs[i] + xs[i + 1]) / 2; if (inSome(oldSpans, m) !== inSome(newSpans, m)) parts.push([xs[i], xs[i + 1]]); }
  const spots = [];
  parts.forEach(([a, b]) => { const s = spots[spots.length - 1]; if (s && a - s.end < 2) { s.end = b; s.diff += b - a; } else spots.push({ start: a, end: b, diff: b - a }); });
  return spots.filter(s => s.diff >= 0.04);
}
async function tasteLoadOlder(file) {
  let data;
  try { data = JSON.parse(await readFile(file)); } catch (e) { toast('That file could not be read.'); return; }
  if (!data || !Array.isArray(data.markers)) { toast('That is not a saved session.'); return; }
  const v = data.video || {};
  if (v.name && v.name !== meta.name && !confirm('That session was made for “' + v.name + '”, but “' + meta.name + '” is open. Compare it anyway?')) return;
  TASTE.older = { name: file.name, cuts: cleanMarkers(data.markers, v).filter(m => m.type === 'cut') };
  tasteRender();
}
function passPairs() {
  const nowCuts = markers.filter(m => m.type === 'cut'), oldCuts = TASTE.older.cuts;
  const nowSpans = cutUnion(nowCuts.concat(undecidedCards(nowCuts))), oldSpans = cutUnion(oldCuts.concat(undecidedCards(oldCuts)));
  return passSpots(oldSpans, nowSpans).map(s => {
    const flip = Math.random() < 0.5, now = { spans: nowSpans, pass: 'now' }, old = { spans: oldSpans, pass: 'older' };
    const { from, to } = clipWindow(cutUnion(nowSpans.concat(oldSpans)), s.start, s.end, 3, 2.5);
    return { key: 'pass', from, to, at: s.start, newIs: flip ? 1 : 2, versions: flip ? { 1: now, 2: old } : { 1: old, 2: now }, what: 'the cut' };
  });
}
function passSummary(run) {
  const n = { now: 0, older: 0, same: 0, bad: 0 }, olderAt = [], badAt = [];
  run.picks.forEach(k => { n[k.won]++; if (k.won === 'older') olderAt.push(mmss(k.at)); if (k.won === 'bad') badAt.push(mmss(k.at)); });
  const total = run.picks.length, lines = [];
  if (!total) return lines;
  lines.push('The new pass won ' + n.now + ' of ' + total + ' spot' + (total === 1 ? '' : 's') + ', the earlier pass won ' + n.older + ', and ' + n.same + ' sounded the same.');
  if (olderAt.length) lines.push('The earlier pass sounded better at ' + olderAt.join(', ') + '.');
  if (badAt.length) lines.push('Neither was right at ' + badAt.join(', ') + '.');
  return lines;
}

/* ---------- a round ---------- */
function tasteStart(mode) {
  if (!meta || !TASTE.profile) return;
  TASTE.last = null; TASTE.said = '';
  if (!TASTE.profile.settings) TASTE.profile.settings = {};                   // (a profile note edited by hand may have lost it)
  const settings = deadAirOf(TASTE.profile);
  const run = { mode, step: mode === 'pass' ? 'pass' : 'deadAir', id: Date.now().toString(36), hadOwn: !!TASTE.profile.settings.deadAir, before: copyOf(settings), settings: copyOf(settings), picks: [], n: 0, max: ROUND_SIZES[TASTE.size][1], used: new Set(), turn: 0, pair: null, playing: '', noting: false };
  if (mode === 'pass') {
    run.queue = passPairs();
    if (!run.queue.length) { toast('The two passes cut exactly the same, so there is nothing to compare.'); return; }
    run.total = Math.min(run.max, run.queue.length);
  } else {
    run.stairs = {}; Object.keys(DEAD_PARAMS).forEach(k => { run.stairs[k] = stairNew(DEAD_PARAMS[k], DEAD_PARAMS[k].get(settings)); });
  }
  TASTE.run = run;
  tasteNextPair();
}
function tasteNextPair() {
  const run = TASTE.run; if (!run) return;
  run.pair = null; run.noting = false;
  if (run.n < run.max) run.pair = run.mode === 'pass' ? (run.queue.shift() || null) : deadAirNext(run);
  if (!run.pair) { tasteFinish(); return; }
  run.n++;
  tasteRender();
  tastePlayPair(run.pair);
}
async function tasteAnswer(answer, note) {
  const run = TASTE.run; if (!run || !run.pair) return;
  if (answer === 'bad' && note === undefined) { run.noting = true; tasteRender(); const box = $('tasteNote'); if (box) box.focus(); return; }
  tasteEndClip(false);
  const pair = run.pair, pick = { n: run.n, at: +pair.at.toFixed(2), what: pair.what, answer, note: note || '' };
  if (run.mode === 'pass') pick.won = answer === 'same' ? 'same' : answer === 'bad' ? 'bad' : pair.versions[answer].pass;
  else {
    pick.versions = { 1: pair.versions[1].settings, 2: pair.versions[2].settings };
    deadAirAnswer(run, pair, answer);
  }
  run.picks.push(pick);
  tasteKeepRound(run);
  if (run.picks.length % 4 === 0) tasteSave();          // kept in this browser after every pick, in the vault every few picks and at the end
  tasteNextPair();
}
// The round in progress is part of the profile from its first pick, so stopping (or closing the page) loses nothing
function tasteKeepRound(run) {
  const p = TASTE.profile, rounds = p.rounds || (p.rounds = []);
  const r = { id: run.id, date: new Date().toLocaleDateString('en-CA'),      // (the editor's own date, as YYYY-MM-DD)
    mode: run.mode, step: run.step, video: meta.name,
    title: run.mode === 'pass' ? 'Which pass is better (' + TASTE.older.name + ')' : 'Dead air',
    before: run.mode === 'pass' ? {} : { deadAir: run.hadOwn ? run.before : null }, after: run.mode === 'pass' ? {} : { deadAir: copyOf(run.settings) },      // (null: the editor had no dead-air setting of their own yet)
    summary: run.mode === 'pass' ? passSummary(run) : deadAirSummary(run), picks: run.picks };
  const i = rounds.findIndex(x => x.id === run.id);
  if (i >= 0) rounds[i] = r; else rounds.push(r);
  p.updated = new Date().toISOString();
  try { store.set('vrt:taste:draft', JSON.stringify(p)); } catch (e) { /* storage full */ }
}
async function tasteFinish() {
  const run = TASTE.run; if (!run) return;
  tasteEndClip(false);
  TASTE.run = null;
  if (!run.picks.length) { tasteRender(); return; }
  tasteKeepRound(run);
  const round = TASTE.profile.rounds.find(r => r.id === run.id);
  TASTE.last = { round, saved: null }; TASTE.busy = 'Saving to your vault…'; tasteRender();
  TASTE.last.saved = await tasteSave();
  TASTE.busy = ''; tasteRender();
}
async function tasteUndo() {
  const p = TASTE.profile, r = p && (p.rounds || []).filter(x => !x.undone && x.mode === 'tune').pop();
  if (!r) return;
  if (!confirm('Put the settings back to how they were before the dead-air round of ' + r.date + '?')) return;
  r.undone = true;
  if (r.before.deadAir) p.settings.deadAir = Object.assign({}, r.before.deadAir); else delete p.settings.deadAir;      // back to the house values
  TASTE.last = null; TASTE.busy = 'Saving…'; tasteRender();
  const saved = await tasteSave();
  TASTE.busy = ''; TASTE.said = saved && saved.ok ? 'The last round is undone.' : (saved && saved.message) || ''; tasteRender();
}

/* ---------- the pane ---------- */
function tasteRender() {
  const host = $('tasteHost'); if (!host) return;
  host.textContent = '';
  const add = el => { if (el) host.appendChild(el); };
  add(h('div', { class: 'taste-intro' }, h('b', { text: 'Taste Test' }), h('span', { class: 'hint', text: 'Hear the same moment twice and pick the better one. Each answer teaches Claude how you like the edit.' })));
  if (TASTE.busy) add(h('div', { class: 'hint taste-busy', text: TASTE.busy }));
  if (TASTE.said) add(h('div', { class: 'taste-said', text: TASTE.said }));
  if (!meta) { add(h('div', { class: 'hint', text: 'Open a video first.' })); return; }
  if (!TASTE.info) { if (!TASTE.busy) add(tasteNoHelper()); return; }
  if (!TASTE.info.setUp) { add(tasteSetupForm()); return; }
  if (TASTE.run) { add(tastePairCard()); return; }
  if (TASTE.last) add(tasteResult());
  add(h('div', { class: 'taste-who hint' }, 'Training ', h('b', { text: TASTE.info.editor }), '’s taste, saved in the Obsidian vault ', h('b', { text: TASTE.info.vault }), '. ',
    h('button', { class: 'linkish', onclick: () => { TASTE.info = Object.assign({}, TASTE.info, { setUp: false }); tasteRender(); } }, 'Change')));
  add(h('label', { class: 'taste-size' }, 'Round length ', h('select', { onchange: e => { TASTE.size = +e.target.value; } }, ROUND_SIZES.map(([t], i) => h('option', { value: i, selected: i === TASTE.size }, t))),
    h('span', { class: 'hint', text: ' Stop whenever you like: every pick is kept.' })));
  add(tasteStepsSection());
  add(tastePassSection());
  const undoable = (TASTE.profile.rounds || []).some(r => !r.undone && r.mode === 'tune');
  if (undoable) add(h('div', { class: 'taste-undo' }, h('button', { class: 'btn sm', onclick: tasteUndo }, icon('undo'), 'Undo last round'), h('span', { class: 'hint', text: ' Puts the settings back to how they were before it.' })));
  if ((TASTE.profile.lines || []).length) add(h('div', { class: 'taste-lines' }, h('h4', { text: 'What it has learned' }), h('ul', null, TASTE.profile.lines.map(l => h('li', { text: l })))));
}
function tasteNoHelper() {
  if (TASTE.oldHelper) return h('div', { class: 'taste-box' }, h('b', { text: 'The helper running now is too old for the Taste Test' }),
    h('p', { class: 'hint', text: 'Close it (on Windows, stop-helper-windows.bat in the tools folder; on a Mac, stop-helper-mac.command), start the one that came with this version of Video Redline, then press Try again.' }),
    h('button', { class: 'btn sm primary', onclick: tasteRefresh }, 'Try again'));
  return h('div', { class: 'taste-box' }, h('b', { text: 'The Video Redline helper is not running' }),
    h('p', { class: 'hint', text: 'The Taste Test saves your picks through the helper, the same small program that makes transcripts. Start it (on Windows, open Video Redline with its desktop icon; on a Mac, run start-helper-mac.command in the tools folder), then press Try again.' }),
    h('button', { class: 'btn sm primary', onclick: tasteRefresh }, 'Try again'));
}
function tasteSetupForm() {
  const i = TASTE.info, form = h('form', { class: 'taste-box taste-form', onsubmit: e => { e.preventDefault(); tasteSetup(form); } },
    h('b', { text: 'Set up your taste profile' }),
    h('p', { class: 'hint', text: 'Type your name and press Save. Your picks are saved as a note in an Obsidian vault, and Claude reads that note. The vault is made for you if you have none.' }),
    h('label', null, 'Your name', h('input', { type: 'text', name: 'editor', value: i.editor || '', maxlength: 60, placeholder: 'For example Rob' })),
    h('label', null, 'Channel (optional)', h('input', { type: 'text', name: 'channel', value: i.channel || '', maxlength: 80, placeholder: 'The YouTube channel you edit for' })),
    h('label', null, 'Obsidian vault folder (optional)', h('input', { type: 'text', name: 'vault', value: '', placeholder: (i.vault ? 'Now “' + i.vault + '”. Leave empty to keep it. ' : 'Leave empty and a vault is made for you in Documents. ') + 'Your own vault: the full path, for example ' + (isMac ? '/Users/you/Documents/My vault' : 'C:\\Users\\you\\Obsidian\\My vault') })),
    h('div', { class: 'row-btns' }, h('button', { class: 'btn sm primary', type: 'submit' }, 'Save'), i.setUp === false && TASTE.profile ? h('button', { class: 'btn sm', type: 'button', onclick: tasteRefresh }, 'Cancel') : null));
  return form;
}
function tasteStepsSection() {
  const p = TASTE.pauses, ready = !!p;
  const pick = h('input', { type: 'file', id: 'tastePausesFile', accept: '.json,application/json', hidden: true, onchange: e => { if (e.target.files[0]) tasteLoadPauses(e.target.files[0]); e.target.value = ''; } });
  return h('div', { class: 'taste-sec' }, h('h4', { text: 'Tune a step' }),
    h('div', { class: 'taste-step' + (ready ? ' ready' : '') },
      h('div', { class: 'taste-step-t' }, h('b', { text: 'Dead air' }), h('span', { class: 'hint', text: ready ? 'Pauses in the raw recording, trimmed different amounts. Pause list: ' + p.source : 'Open the raw recording, then load the pause list the rough cut made for it (redline-pauses.json in its work folder).' })),
      pick, h('div', { class: 'row-btns' }, h('button', { class: 'btn sm' + (ready ? '' : ' primary'), onclick: () => pick.click() }, ready ? 'Other pause list' : 'Load pause list'),
        ready ? h('button', { class: 'btn sm primary', onclick: () => tasteStart('tune') }, icon('play'), 'Start') : null)),
    LATER_STEPS.map(t => h('div', { class: 'taste-step later' }, h('b', { text: t }), h('span', { class: 'hint', text: 'Not built yet.' }))));
}
function tastePassSection() {
  const o = TASTE.older;
  const pick = h('input', { type: 'file', id: 'tasteOlderFile', accept: '.json,application/json', hidden: true, onchange: e => { if (e.target.files[0]) tasteLoadOlder(e.target.files[0]); e.target.value = ''; } });
  const spots = o ? passPairs().length : 0;
  return h('div', { class: 'taste-sec' }, h('h4', { text: 'Which pass is better?' }),
    h('p', { class: 'hint', text: o ? 'Comparing the pass open now with ' + o.name + ': they cut differently in ' + spots + ' spot' + (spots === 1 ? '' : 's') + '. You won’t be told which is which.' : 'Plays only the spots where the pass open now cuts differently from an earlier one. Pick the earlier pass’s session file.' }),
    pick, h('div', { class: 'row-btns' }, h('button', { class: 'btn sm' + (o ? '' : ' primary'), onclick: () => pick.click() }, o ? 'Other earlier pass' : 'Pick the earlier pass'),
      o && spots ? h('button', { class: 'btn sm primary', onclick: () => tasteStart('pass') }, icon('play'), 'Start') : null));
}
function tastePairCard() {
  const run = TASTE.run, pair = run.pair;
  const of = run.mode === 'pass' ? ' of ' + run.total : run.max < 1e8 ? ' of up to ' + run.max : '';
  const btn = (answer, label, key, cls) => h('button', { class: 'btn ' + (cls || ''), disabled: run.noting, onclick: () => tasteAnswer(answer) }, label, h('kbd', { text: key }));
  return h('div', { class: 'taste-box taste-pair' },
    h('div', { class: 'taste-pair-head' }, h('b', { text: (run.mode === 'pass' ? 'Which pass is better' : 'Dead air') + ' · pair ' + run.n + of }), h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', onclick: tasteFinish }, 'Stop and save')),
    h('p', { class: 'hint', text: 'Listen to ' + pair.what + ' at ' + mmss(pair.at) + '. ' + (run.playing ? 'Playing ' + (run.playing === 'both' ? 'version 1, then version 2…' : 'version ' + run.playing + '…') : 'Which version is better?') }),
    h('div', { class: 'row-btns' },
      h('button', { class: 'btn sm', onclick: () => tastePlayPair(pair) }, icon('play'), 'Play both', h('kbd', { text: 'R' })),
      h('button', { class: 'btn sm', onclick: () => tastePlayPair(pair, 1) }, 'Play 1'), h('button', { class: 'btn sm', onclick: () => tastePlayPair(pair, 2) }, 'Play 2')),
    h('div', { class: 'taste-answers' }, btn('1', '1 is better', '1', 'primary'), btn('2', '2 is better', '2', 'primary'), btn('same', 'Same', 'S'), btn('bad', 'Both bad', 'B')),
    run.noting ? h('form', { class: 'taste-note', onsubmit: e => { e.preventDefault(); tasteAnswer('bad', $('tasteNote').value.trim()); } },
      h('input', { type: 'text', id: 'tasteNote', maxlength: 200, placeholder: 'A few words, like “cut more” or “too early” (you can leave it empty)' }),
      h('button', { class: 'btn sm primary', type: 'submit' }, 'Next')) : null);
}
function tasteResult() {
  const { round, saved } = TASTE.last;
  return h('div', { class: 'taste-box taste-result' }, h('b', { text: round.title + ': done' }),
    h('ul', null, (round.summary.length ? round.summary : ['No change.']).map(l => h('li', { text: l }))),
    saved ? h('p', { class: 'hint', text: saved.ok ? 'Saved to your vault as ' + saved.note + '.' : saved.message }) : null);
}

// 1, 2, S, B and R answer and replay while a pair waits (the Taste tab is open and nobody is typing)
document.addEventListener('keydown', e => {
  const run = TASTE.run;
  if (!run || !run.pair || ui.tab !== 'taste' || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  if (e.target.matches && e.target.matches('input, textarea, select, [contenteditable]')) return;
  const k = e.key.toLowerCase(), act = { 1: () => tasteAnswer('1'), 2: () => tasteAnswer('2'), s: () => tasteAnswer('same'), b: () => tasteAnswer('bad'), r: () => tastePlayPair(run.pair) }[k];
  if (!act) return;
  e.preventDefault(); e.stopPropagation(); act();
}, true);
$('tabTaste').addEventListener('click', () => { if (!TASTE.info && !TASTE.busy) tasteRefresh(); else tasteRender(); });
// A new video (or none): what belonged to the old one goes
let tasteVideoSeen = '';
setInterval(() => {
  const k = meta ? storeKey() : '';
  if (k === tasteVideoSeen) return;
  tasteVideoSeen = k;
  if (TASTE.run) { tasteEndClip(false); TASTE.run = null; }
  TASTE.last = null; tasteRecallPauses();
  if (ui.tab === 'taste') tasteRender();
}, 500);
tasteRender();
