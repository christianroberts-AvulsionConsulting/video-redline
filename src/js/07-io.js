/* =====================================================================
   07 - Export for Claude, sessions, dropping files
   ===================================================================== */
const baseName = () => meta.name.replace(/\.[^.\\/]+$/, '').replace(/[\\/:*?"<>|]+/g, '_');
const pct = v => +(v * 100).toFixed(1);
function stamp() { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

// The style records used by visuals in this video (each once). A style this browser does not have is replaced by the fallback style, the same one the markdown spells out, so "listed under Visual styles" is always true.
function usedStyles() {
  const seen = new Map();
  sorted().forEach(m => { if (m.visual && isVisualType(m.type)) { const st = styleById(m.visual.style) || fallbackStyle(); if (st && !seen.has(st.id)) seen.set(st.id, st); } });
  return [...seen.values()];
}
// What the assistant is told when an "AI writes it" visual has nothing to write from (the markdown and the JSON say the same)
const NO_SOURCE_WARNING = 'this marker has no comment and no spoken words are available, so there is nothing to write the text from. Ask the editor what it should say.';
// Added when the spoken words of a very long marker were cut short (the cleanup panel gives at most 1,200 characters, about 90 seconds of speech)
const SPOKEN_CUT_NOTE = 'Note: that is only the first part of what is said during this marker; the rest was left out because it is long.';
function styleMarkdown(st) {
  const t = st.t || {}, L = [];
  L.push('### ' + st.name + ' (' + st.id + ')');
  L.push('Category: ' + (st.category || 'n/a') + ' · ' + (st.theme || 'light') + ' theme' + (st.source === 'custom' ? ' · imported by the user' : ' · Open Design design system'));
  if (st.atmosphere) L.push('Atmosphere: ' + st.atmosphere);
  L.push('Colours: background ' + t.bg + ', surface ' + t.surface + ', text ' + t.fg + ', muted text ' + t.muted + ', border ' + t.border + ', accent ' + t.accent + (t.accent2 ? ', second accent ' + t.accent2 : ''));
  L.push('Fonts: display ' + t.fd + '; body ' + t.fb);
  L.push('Shape: corner radius ' + t.r + ' px; shadow ' + (t.sh || 'none') + '; display weight ' + t.fw + (t.ls ? '; display letter-spacing ' + t.ls + ' em' : ''));
  if (st.source !== 'custom') L.push('Full design system: https://github.com/nexu-io/open-design/tree/main/design-systems/' + st.id);
  if (st.designMd) L.push('', 'DESIGN.md for this style:', '', '```markdown', st.designMd.trim(), '```');
  return L;
}
function buildMarkdown() {
  const L = [];
  L.push('# Video Redline notes: ' + meta.name, '');
  L.push('Video: ' + meta.w + 'x' + meta.h + ', ' + fmtFps(fps) + ' fps, ' + meta.duration.toFixed(3) + ' s (' + tc(meta.duration) + ')');
  L.push('Exported: ' + stamp(), '');
  L.push('Times are seconds from the start of this video. Boxes are in video pixels from the top-left corner.', '');
  const styleFirst = new Map();                       // style id -> item number where its tokens are written out in full
  sorted().forEach((m, i) => {
    L.push('## ' + (i + 1) + '. [' + typeLabel(m) + '] ' + sec2(m.start) + ' s to ' + sec2(m.end) + ' s (' + tc(m.start) + ' to ' + tc(m.end) + ', ' + sec2(m.end - m.start) + ' s)');
    const text = m.comment.trim() ? m.comment.trim().replace(/\r?\n/g, '\n  ') : '(none)';   // later lines are indented so they stay part of the comment
    L.push('Comment: ' + text);
    if (m.visual && isVisualType(m.type) && typeof VIS !== 'undefined') {
      const ai = isAiText(m.visual), spoken = ai ? spokenAt(m) : '';           // "AI writes it": no words are exported, only what to write from
      const st = styleById(m.visual.style) || fallbackStyle(), lines = VIS.describe(m.visual, st, ai ? { aiText: true, spoken } : null), first = styleFirst.get(st.id);
      if (first == null) styleFirst.set(st.id, i + 1);
      if (ai && !m.comment.trim() && !spoken) lines.splice(2, 0, 'Warning: ' + NO_SOURCE_WARNING);
      if (ai && spokenCut(spoken)) { const k = lines.findIndex(ln => /^Spoken at this time:/.test(ln)); if (k >= 0) lines.splice(k + 1, 0, SPOKEN_CUT_NOTE); }
      lines.forEach((ln, k) => {
        if (first != null && /^(Style mood|Colours|Fonts|Shape):/.test(ln)) return;      // spelled out once, at its first use
        if (first != null && /^Build it to fill/.test(ln)) ln = ln.replace(/ above\.$/, ' listed under Visual styles at the end.');
        L.push(k === 0 ? 'Visual: ' + ln.replace(/^Visual kind:\s*/i, '') : '  ' + ln);
        if (first != null && /^Style: /.test(ln)) L.push('  Style tokens: same as item ' + first + ' (also listed under Visual styles at the end).');
      });
      if (m.boxes.length) L.push('Visual goes in: Box A');
    }
    if (!m.boxes.length) L.push('Boxes: none');
    m.boxes.forEach((b, j) => L.push('Box ' + letter(j) + ': x ' + b.x + ', y ' + b.y + ', w ' + b.w + ', h ' + b.h +
      ' (' + pct(b.x / meta.w).toFixed(1) + '%, ' + pct(b.y / meta.h).toFixed(1) + '%, ' + pct(b.w / meta.w).toFixed(1) + '%, ' + pct(b.h / meta.h).toFixed(1) + '%)'));
    L.push('');
  });
  const styles = usedStyles();
  if (styles.length) {
    L.push('## Visual styles', '');
    L.push('Use these design tokens for the visuals above (colours, fonts, corner radius, shadow). The styles come from Open Design design systems (https://github.com/nexu-io/open-design).', '');
    styles.forEach(st => { styleMarkdown(st).forEach(x => L.push(x)); L.push(''); });
  }
  return L.join('\n');
}
// opts.keepHidden: keep the typed words of a visual that is set to "AI writes it" (the saved session needs them to come back; Export for Claude leaves them out)
function buildJson(opts) {
  return {
    tool: 'video-review', version: 2,
    video: { name: meta.name, width: meta.w, height: meta.h, fps: +fmtFps(fps), duration: +meta.duration.toFixed(3) },
    markers: sorted().map((m, i) => {
      const o = { id: i + 1, type: typeLabel(m), start: r4(m.start), end: r4(m.end), startFrame: F(m.start), endFrame: F(m.end), comment: m.comment,
        boxes: m.boxes.map((b, j) => ({ label: letter(j), x: b.x, y: b.y, w: b.w, h: b.h,
          percent: { x: pct(b.x / meta.w), y: pct(b.y / meta.h), w: pct(b.w / meta.w), h: pct(b.h / meta.h) } })) };
      if (m.visual && isVisualType(m.type)) {
        const vv = Object.assign({}, m.visual, { placedInBox: m.boxes.length ? 'A' : null });
        if (isAiText(m.visual) && typeof VIS !== 'undefined') {            // the words are not exported: say what to write and what was said at this time
          const spoken = spokenAt(m), lines = VIS.describe(m.visual, styleById(m.visual.style) || fallbackStyle(), { aiText: true, spoken });
          if (!(opts && opts.keepHidden)) delete vv.content;
          vv.textBy = 'ai';
          vv.text = { by: 'ai', instruction: lines[1].replace(/^Text:\s*/, '') + ' ' + lines[2] };
          if (!m.comment.trim() && !spoken) vv.text.instruction += ' Warning: ' + NO_SOURCE_WARNING;
          if (spoken) vv.spoken = spoken;
          if (spokenCut(spoken)) vv.spokenTruncated = true;                  // only the first part of what was said is here
        } else vv.textBy = 'me';
        if (!(opts && opts.keepHidden)) delete vv.note;                          // a library visual's note was put into the Comment when it was used; the Comment is what the assistant reads
        o.visual = vv;
      }
      if (m.origin) o.origin = m.origin;
      return o;
    }),
    styles: usedStyles()
  };
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const needVideo = () => { if (!meta) { toast('Open a video first.'); return true; } return false; };

function exportForClaude() {
  if (needVideo()) return;
  const b = baseName();
  download(b + '-review.md', buildMarkdown(), 'text/markdown;charset=utf-8');
  setTimeout(() => download(b + '-review.json', JSON.stringify(buildJson(), null, 2), 'application/json'), 350);
  toast('Saved ' + b + '-review.md and ' + b + '-review.json to your Downloads folder. Give both to Claude.', 5500);
}
function copyMarkdown() {
  if (needVideo()) return;
  const text = buildMarkdown();
  const fallback = () => {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text;
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove(); toast(ok ? 'Markdown copied. Paste it to Claude.' : 'Could not copy. Use Export for Claude instead.');
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast('Markdown copied. Paste it to Claude.'), fallback);
  else fallback();
}
/* ---------- Prompt for Claude ----------
   A fallback for when Claude does not pick the video up by itself: one button puts a ready-made prompt on the clipboard.
   Nothing from Claude in the markers yet: it asks for a first pass (transcript, a draft of visual markers as a session file, each tagged with an origin).
   Markers drafted by Claude are there (origin.by === 'claude'): it asks Claude to compare them with what was kept, changed and deleted and to learn from it. */
const PROMPT_MAX_NOTES = 30000;                        // longer notes are not pasted into the prompt; Export for Claude carries them instead
function buildClaudePrompt() {
  const kinds = {}; markers.forEach(m => { const t = typeLabel(m); kinds[t] = (kinds[t] || 0) + 1; });
  const drafted = sorted().filter(m => m.origin && m.origin.by === 'claude');
  const haveWords = !!spokenAt({ start: 0, end: meta.duration });
  const now = markers.length
    ? markers.length + ' marker' + (markers.length === 1 ? '' : 's') + ' (' + Object.keys(kinds).map(t => kinds[t] + ' ' + t).join(', ') + ')' + (drafted.length ? ', ' + drafted.length + ' of them drafted by you earlier' : '')
    : 'no markers yet';
  const L = [];
  L.push(drafted.length ? 'I have reviewed your draft for a video in Video Redline. Please learn from what I did.' : 'Please make the first pass of an edit for a video I am marking up in Video Redline.', '');
  L.push('VIDEO', 'Name: ' + meta.name, 'Picture: ' + meta.w + 'x' + meta.h + ', ' + fmtFps(fps) + ' fps', 'Length: ' + tc(meta.duration) + ' (' + meta.duration.toFixed(3) + ' s)',
    'Right now: ' + now + '. A transcript is ' + (haveWords ? 'loaded in the Cleanup tab.' : 'not loaded in the Cleanup tab yet.'), '');
  const notes = buildMarkdown();
  if (drafted.length) {
    L.push('WHAT I WANT YOU TO DO',
      '1. Compare my current markers (below) with the draft you saved: which of yours I kept unchanged, which I changed (timing, kind, style, words, box or comment), which I deleted, what I added myself, and which cut suggestions from the Cleanup tab I accepted. A marker of yours that is missing below was deleted.',
      '2. Tell me the patterns in a few plain lines, for example "you delete recap lists" or "you move cards half a second later".',
      '3. Update your notes about my taste, so the next first pass needs less fixing. Do not change my markers or the video.', '',
      'Your drafts that are still there (id, then where it starts): ' + drafted.map(m => m.origin.candidateId + ' at ' + tc(m.start)).join(', ') + '.',
      'If you have the JSON from Export for Claude, use it: it carries your origin tags and exact values.', '',
      'MY MARKERS NOW', notes.length <= PROMPT_MAX_NOTES ? notes : 'My notes are too long to paste here. Use Export for Claude and give both files to Claude.');
    return L.join('\n');
  }
  L.push('WHAT I WANT YOU TO DO',
    '1. Get a transcript with word times for this video. Use the Video Redline helper (tools/transcribe.py in the Video Redline folder) or any speech to text that runs on this computer. The video must not be uploaded anywhere.',
    '2. Look at a few frames first, so you know what is already on screen. Do not repeat text that is already in the picture.',
    '3. Draft the visual markers a viewer would need: lists, steps, diagrams, callouts, shortcuts, big numbers, quotes, title cards, lower thirds. A spoken keyboard shortcut, a list of steps or rules, a term being defined, a number being read out and a "watch next" are the clearest cases. Skip anything that would only decorate.',
    '4. Keep visuals away from dead air and ums that will be cut. Give each visual a box, clear of whatever the speaker is pointing at.',
    '5. Save the draft as ONE Video Redline session file (.json, format below) next to the video and tell me the path. I will open it with File, Load session from file, then accept, reject or edit each marker.', '',
    'HOW TO TAG YOUR DRAFT',
    'Put "origin": {"by": "claude", "candidateId": "v1", "reason": "one sentence why", "confidence": 0.7} on every marker you draft (ids v1, v2, and so on). Keep a copy of your draft. When I am done I will ask you to compare it with my final edit and learn from what I kept, changed and deleted.', '',
    'FILE FORMAT',
    '{ "tool": "video-review", "version": 2,',
    '  "video": { "name": ' + JSON.stringify(meta.name) + ', "width": ' + meta.w + ', "height": ' + meta.h + ', "fps": ' + fmtFps(fps) + ', "duration": ' + +meta.duration.toFixed(3) + ' },',
    '  "markers": [ { "type": "visual", "start": 12.0, "end": 18.5, "comment": "what it is and why, for the editor",',
    '      "boxes": [ { "x": 960, "y": 300, "w": 800, "h": 400 } ],',
    '      "visual": { "kind": "callout", "content": { "title": "Pro tip", "body": "Press F4 to switch between absolute and relative references." }, "style": "<a style id>", "textBy": "me" },',
    '      "origin": { "by": "claude", "candidateId": "v1", "reason": "...", "confidence": 0.7 } } ],',
    '  "styles": [] }',
    'Times are seconds from the start of the video. Boxes are in video pixels from the top left corner. "type" is "visual" for most kinds, "list" for list and steps, "diagram" for a diagram, or "note" for a comment with no edit.');
  if (typeof VIS !== 'undefined') L.push('Visual kinds: ' + VIS.KINDS.map(k => k.id).join(', ') + '. Each takes a "title" and a "body" (one item per line; "A -> B -> C" for a diagram; "Windows: Ctrl + T" on one line and "Mac: ⌘ + T" on the next for a shortcut).',
    'Style ids (use one style for the whole video unless I say otherwise): ' + allStyles().map(s => s.id).join(', ') + '.');
  if (markers.length) L.push('', 'MARKERS I ALREADY HAVE (keep them in the file exactly as they are, and keep your visuals off them)', notes.length <= PROMPT_MAX_NOTES ? notes : 'My notes are too long to paste here. Use Export for Claude and give both files to Claude.');
  return L.join('\n');
}
function copyClaudePrompt() {
  if (needVideo()) return;
  copyPlainText(buildClaudePrompt(), 'Prompt copied. Paste it into Claude.', 'Could not copy. Use Export for Claude instead.');
}
function saveSessionFile() {                           // File, Download session file (File, Save session is in 07-sessions.js: it saves into the sessions folder)
  if (needVideo()) return;
  download(baseName() + '-session.json', JSON.stringify(buildJson({ keepHidden: true }), null, 2), 'application/json');
  toast('Session file saved to your Downloads folder.');
}

// Turn saved / imported marker data into clean markers that fit this video. `from` = the file's video info (or null).
function cleanMarkers(arr, from) {
  const n = nF(), out = [];
  const sx = from && from.width ? meta.w / from.width : 1, sy = from && from.height ? meta.h / from.height : 1;
  (Array.isArray(arr) ? arr : []).forEach(o => {
    const s0 = Number(o.start), e0 = Number(o.end);
    if (!isFinite(s0) || !isFinite(e0)) return;
    if (F(s0) >= n) return;                                    // starts after the end of this video: skip it instead of piling it on the last frame
    const s = clamp(F(s0), 0, n - 1), e = clamp(F(e0), s + 1, n);
    let type = String(o.type == null ? 'note' : o.type).replace(/[\[\]\r\n]/g, '').trim();
    if (type.toLowerCase() === 'custom') type = '';
    const std = TYPE_NAMES.find(t => t === type.toLowerCase()); if (std) type = std;
    const retired = RETIRED_TYPES.find(t => t === type.toLowerCase());
    if (retired) type = 'visual';
    const boxes = [];
    (Array.isArray(o.boxes) ? o.boxes : []).forEach(b => {
      let r = { x: +b.x, y: +b.y, w: +b.w, h: +b.h };
      if (![r.x, r.y, r.w, r.h].every(isFinite)) return;
      r = rectFrom(r.x * sx, r.y * sy, (r.x + r.w) * sx, (r.y + r.h) * sy);
      if (r.w >= 1 && r.h >= 1) boxes.push(Object.assign({ id: uid() }, r));
    });
    const m = { id: uid(), type, start: T(s), end: T(e), comment: String(o.comment == null ? '' : o.comment), boxes };
    if (isVisualType(type)) m.visual = normVisual(o.visual) || defaultVisual(retired || type);
    if (o.origin && typeof o.origin === 'object') m.origin = cleanOrigin(o.origin);
    out.push(m);
  });
  return out;
}
function readFile(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); }); }
async function loadSessionFile(file) {
  if (needVideo()) return false;
  let text;
  try { text = await readFile(file); } catch (e) { toast('That file is not a saved session.'); return false; }
  return loadSessionText(text, file.name);
}
// `text` is a saved session (from a file picker, a drop, or the sessions folder); `fileName` is only for a transcript that was opened here by mistake. Returns true when the session was loaded.
async function loadSessionText(text, fileName) {
  if (needVideo()) return false;
  let data;
  try { data = JSON.parse(text); } catch (e) { toast('That file is not a saved session.'); return false; }
  if (!data || !Array.isArray(data.markers)) {
    if (!(looksLikeTranscript(text) && cleanupOpenTranscript(text, fileName))) toast('That file is not a saved session.');      // a transcript file belongs in the Cleanup tab
    return false;
  }
  const v = data.video || {};
  if (v.name && v.name !== meta.name && !confirm('This session was made for “' + v.name + '”, but “' + meta.name + '” is open. Load it anyway?')) return false;
  if (markers.length && !confirm('Replace the ' + markers.length + ' marker(s) you have now?')) return false;
  if (v.fps >= 1 && v.fps <= 240) fps = normFps(+v.fps);
  if (Array.isArray(data.styles)) importStyleRecords(data.styles);
  markers = cleanMarkers(data.markers, v);
  sessForget();                                     // these markers are no longer the work of the session File, Save session updates (07-sessions.js sets it again for a session opened from the folder)
  selId = selBox = inF = outF = null;
  const f = $('fps'); if (f) f.value = fmtFps(fps);
  const loaded = markers.length;
  panelSaid = '';
  // The page changes and the panel looks at the cuts again right away (it only follows the page; cuts of another transcript stay). Both belong to ONE history
  // step, so one Ctrl+Z undoes the whole load: while the panel works, the page's own commit is held back (batching) and made once afterwards.
  batching++;
  try { renderRuler(); updateClock(true); cleanupSyncAfterJump(true); } finally { batching--; }
  batchDirty = false; changed(); commit();
  cleanupDropPendingRefresh();                       // the panel has just looked at the cuts: changed() must not queue a second look
  const said = panelSaid; panelSaid = '';            // what the panel told the user while doing that (for example "...leave out 1 cut ... listed under Rejected"): our toast must not paint over it
  const n = markers.length;
  toast('Loaded ' + loaded + ' marker' + (loaded === 1 ? '' : 's') + '.' + (n < loaded ? ' The Cleanup tab took out ' + (loaded - n) + ' automatic cut' + (loaded - n === 1 ? '' : 's') + ' that do not belong to the transcript it has open.' : '') + (said ? ' ' + said : ''), (n < loaded || said) ? 7000 : undefined);
  return true;
}

/* ---------- files from the file pickers and from drag and drop ---------- */
const isVideoFile = f => (f.type && f.type.indexOf('video/') === 0) || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name);
async function loadTranscriptFile(f) {                // .srt / .vtt: subtitles from somewhere else are a transcript for the Cleanup tab
  if (needVideo()) return;
  let text; try { text = await readFile(f); } catch (e) { toast('That file could not be read.'); return; }
  if (!cleanupOpenTranscript(text, f.name)) toast('That does not look like a video file.');
}
// The handle of the first dropped file (a promise, or null). It has to be asked for while the drop event is still running; a handle lets a saved session open a dropped video again later.
const dropHandle = e => {
  const it = e.dataTransfer && e.dataTransfer.items && e.dataTransfer.items[0];
  return it && typeof it.getAsFileSystemHandle === 'function' ? it.getAsFileSystemHandle().catch(() => null) : null;
};
function handleFile(f, handle) {
  if (/\.json$/i.test(f.name)) loadSessionFile(f);      // a saved session, or a transcript (that one opens in the Cleanup tab)
  else if (/\.(srt|vtt)$/i.test(f.name)) loadTranscriptFile(f);
  else if (isVideoFile(f)) { if (handle) handle.then(hd => loadVideo(f, hd)); else loadVideo(f); }
  else toast('That does not look like a video file.');
}
const pick = (input, fn) => { input.addEventListener('change', () => { if (input.files[0]) fn(input.files[0]); input.value = ''; }); };
pick($('fileVideo'), loadVideo); pick($('fileSession'), loadSessionFile);
window.addEventListener('dragover', e => { e.preventDefault(); dropEl.classList.add('over'); });
window.addEventListener('dragleave', e => { if (!e.relatedTarget) dropEl.classList.remove('over'); });
// The Cleanup panel takes any file dropped on it as a transcript and stops the drop there, so the window handler below never sees it:
// clear the highlight first, and route the dropped files like anywhere else: one file is a video, saved session or transcript,
// several files or a .md / .css file are design system files for the style importer (the panel would only say "does not look like a transcript").
window.addEventListener('drop', () => dropEl.classList.remove('over'), true);
$('cleanupHost').addEventListener('drop', e => {
  const fl = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
  if (!fl.length) return;
  const hd = dropHandle(e);
  e.preventDefault(); e.stopPropagation();
  if (fl.length > 1 || /\.(md|css)$/i.test(fl[0].name)) importStyleFiles(fl); else handleFile(fl[0], hd);
}, true);
window.addEventListener('drop', e => {
  e.preventDefault(); dropEl.classList.remove('over');
  const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
  if (!files.length) return;
  const hd = dropHandle(e);
  if (files.length > 1 || /\.(md|css)$/i.test(files[0].name)) importStyleFiles(files);      // design system files go to the style importer
  else handleFile(files[0], hd);
});
window.addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
