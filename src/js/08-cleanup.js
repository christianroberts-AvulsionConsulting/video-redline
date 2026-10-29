/* =====================================================================
   08 - Audio cleanup
   Plugs the cleanup engine (cleanup.js) and its review panel (cleanup-panel.js) into this page.
   You open a transcript of the video; the panel finds dead air, ums, stutters, repeats, false starts and other
   non-word sounds; confident ones become cut markers, unsure ones wait in a queue for you to Accept or Reject.
   The panel only touches the page through the small `cleanupApi` object below. "Create transcript and find cuts" talks to the optional
   helper (tools/, started by the user, or on Windows at sign-in and by the "Video Redline" icon) through the TranscriberClient module, on 127.0.0.1 only.
   ===================================================================== */
const HAS_CLEANUP = typeof Cleanup !== 'undefined' && typeof CleanupPanel !== 'undefined';
let cleanupPanel = null;
let rangeEnd = null, rangeTimer = null;         // playRange(): pause when the video reaches this time
const timeCbs = [];
let batching = 0, batchDirty = false;
let panelSaid = '';                             // the last thing the panel told the user (api.toast); loadSessionFile adds it to its own toast so the page does not paint over it
let skipCuts = false;                           // while playing, jump over cut markers

// What a cut remembers about where it came from (kept in the saved markers and the JSON export).
// The reason is a sentence ending in "Cuts m:ss to m:ss", up to about 430 characters long; the other strings are short ids.
function cleanOrigin(o) {
  const out = {};
  ['kind', 'reason', 'by', 'candidateId'].forEach(k => { if (typeof o[k] === 'string') out[k] = o[k].slice(0, k === 'reason' ? 600 : 240); });
  if (isFinite(o.confidence)) out.confidence = +o.confidence;
  if (typeof o.auto === 'boolean') out.auto = o.auto;
  return out;
}
const videoKey = () => (meta ? meta.name + '|' + meta.duration.toFixed(3) : '');

// The words said inside a marker, when a transcript is loaded in the cleanup panel. '' when there is none.
// The panel's wordsBetween(t0, t1) gives the words that overlap the time range as one string (at most 1,200 characters).
function spokenAt(m) {
  try {
    const s = cleanupPanel && typeof cleanupPanel.wordsBetween === 'function' ? cleanupPanel.wordsBetween(m.start, m.end) : '';
    return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, 1500) : '';
  } catch (e) { return ''; }
}
// true when the panel stopped early: longer text is cut at a word and ends with an ellipsis (about 90 seconds of speech), so the export says so
const spokenCut = s => s.length > 1000 && s.slice(-1) === '…';

function stopRange() { rangeEnd = null; if (rangeTimer) { clearInterval(rangeTimer); rangeTimer = null; } }
function checkRange() {
  if (rangeEnd != null && (video.currentTime >= rangeEnd || video.paused || video.ended)) { video.pause(); stopRange(); }
}
function emitTime() {
  if (!timeCbs.length) return;
  const t = video.currentTime;
  timeCbs.slice().forEach(cb => { try { cb(t); } catch (e) { /* a listener failed; ignore */ } });
}
function afterCutChange() { if (batching) { batchDirty = true; return; } commit(); changed(); }

const cleanupApi = {
  getDuration: () => (meta ? meta.duration : 0),
  getFps: () => fps,
  getFile: () => (meta ? videoFile : null),
  getVideoName: () => (meta ? meta.name : null),
  getTime: () => video.currentTime,
  seek(t) { stopRange(); if (meta) { video.pause(); video.currentTime = clamp(t, 0, meta.duration); scrollToFrame(curFrame()); } },
  playRange(a, b) {
    if (!meta) return;
    stopRange();
    video.currentTime = clamp(a, 0, meta.duration); rangeEnd = b;
    const p = video.play(); if (p && p.catch) p.catch(() => {});
    rangeTimer = setInterval(checkRange, 40);      // does not depend on animation frames, so it also works in background tabs
  },
  onTime(cb) { timeCbs.push(cb); return () => { const i = timeCbs.indexOf(cb); if (i >= 0) timeCbs.splice(i, 1); }; },
  addCut(spec) {
    if (!meta) return null;
    const n = nF(), s = clamp(F(spec.start), 0, n - 1), e = clamp(F(spec.end), s + 1, n);
    const m = { id: uid(), type: 'cut', start: T(s), end: T(e), comment: String(spec.comment || ''), boxes: [] };
    if (spec.origin && typeof spec.origin === 'object') m.origin = cleanOrigin(spec.origin);
    markers.push(m);
    afterCutChange();
    return m.id;
  },
  removeCut(id) {
    if (!byId(id)) return;
    markers = markers.filter(m => m.id !== id);
    if (selId === id) { selId = selBox = null; }
    afterCutChange();
  },
  getCuts: () => markers.filter(m => m.type === 'cut').map(m => ({ id: m.id, start: m.start, end: m.end, comment: m.comment, origin: m.origin ? JSON.parse(JSON.stringify(m.origin)) : undefined })),
  toast: msg => { panelSaid = String(msg); toast(msg, 4200); },
  // each video keeps its own transcript and decisions
  storage: { get: k => store.get(k + '|' + videoKey()), set: (k, v) => store.set(k + '|' + videoKey(), v) },
  confirm: msg => window.confirm(msg),
  batch(fn) { batching++; try { fn(); } finally { batching--; if (!batching && batchDirty) { batchDirty = false; commit(); changed(); } } }
};

/* ---------- the helper on Windows ----------
   The page does NOT start the helper: a browser cannot start a program. With no helper, the help card sends the person to the
   "Video Redline" icon (open_video_review.pyw), which starts the helper first and then opens this page. The helper also starts by
   itself, hidden, when the person signs in to Windows (tools\setup-autostart-windows.bat adds that start-up entry once).
   What this wrapper does in real use, on a Windows computer and on a page the helper would answer (a file on this computer, or localhost):
   - It words the cards for a hidden helper. The client's own advice talks about "the helper window", which a hidden helper does not have,
     so these cards say how to stop the helper (stop-helper-windows.bat) and how it starts again (the Video Redline icon).
   - A helper that has answered but is still checking its speech tools counts as ready: run() waits for it.
   - While a transcript is being made it asks every few seconds whether the helper is still there, so a helper that was stopped in
     the middle is reported after about 7 to 8 seconds. (The client alone says "Lost contact with the helper" after about 2 seconds and
     gives up after about 17; this only shortens the second part.)
   The panel and transcriber-client.js are not changed: the panel gets this object as its TranscriberClient option. Nothing here runs
   until the user presses the button. On a Mac, or on a page the helper would not answer (https, other hosts), it does nothing and the
   client's own answer is used.
   SWITCHED OFF AND NOT USED IN REAL USE: asking Windows to start the helper from this page (launch(), waitFor(), the memory, the
   TEXT lines, the constants LINK, WAIT_MS, RETRY_WAIT_MS, POLL_MS, GAP_MS, MAX_TRIES, FORGET_MS and the part of check() after
   "if (!launchEnabled())"). It used the link videoreview://start, by clicking a hidden <a id="vrtHelperLaunch">. That does not work
   in a browser (a hidden frame may not open an app, and the click replaced the whole page with an error page), and setup no longer
   registers the link. The code stays only because the unit tests exercise it, and it runs only when a test sets
   window.__vrtHelperSeam.launchFromPage = true. Nothing in the real page sets that.
   Test seam (nothing sets it in real use): window.__vrtHelperSeam = { launchFromPage, launch(link) replaces the click, link, ports, windows,
   anyPage, off, waitMs, retryMs, forgetMs, pollMs, gapMs, beatMs, quickMs }. Read when used, so a test can set it at any time. */
const helperSeam = () => { try { return window.__vrtHelperSeam || {}; } catch (e) { return {}; } };

function makeHelperAutostart(Base, opts) {
  opts = opts || {};
  const ICON_FILE = 'setup-autostart-windows.bat';       // makes the "Video Redline" icon (and the start at sign-in), the one answer to "no icon yet" everywhere (the client's texts and the helper's say the same)
  const STOP_FILE = 'stop-helper-windows.bat';           // stops the hidden helper
  const START_AGAIN = 'double-click the "Video Redline" icon on your Desktop';   // how the hidden helper starts again after it was stopped
  const BEAT_MS = 2500;         // while a transcript is being made: how often to ask whether the helper is still there
  const LOST_BEATS = 3;         // this many quick "nobody there" answers in a row mean the helper stopped
  const QUICK_MS = 900;         // an answer that takes longer than this is a busy helper (or computer), not a stopped one
  /* SWITCHED OFF, NOT USED IN REAL USE (see the note above): the constants of the launch path. */
  const LINK = 'videoreview://start';                    // the old link; setup does not register it any more
  const WAIT_MS = 25000;        // how long to wait for a helper that Windows was asked to start
  const RETRY_WAIT_MS = 10000;  // ... when an earlier ask did not work
  const POLL_MS = 700;          // how often to ask again while waiting
  const GAP_MS = 8000;          // within this time of the last ask to Windows, do not ask again: wait for the first one
  const MAX_TRIES = 2;          // asks to Windows in a row without success ...
  const FORGET_MS = 60000;      // ... are counted for this long; after that the page asks again (no reload needed)
  const say = typeof opts.say === 'function' ? opts.say : () => {};          // say(text, milliseconds): the page's toast (launch path only)
  const hide = typeof opts.hide === 'function' ? opts.hide : () => {};      // takes the toast away again (the launch path uses it; cancel() also calls it, so Cancel clears whatever toast is showing)
  const memory = { tries: 0, lastLaunch: 0, until: 0, launches: 0, syncSaid: false };       // tries..launches: launch path only; syncSaid: the cloud-folder warning was shown (once per page). Shared by every panel of this page (a new panel is made for each video)
  // The helper (1.1.0 and newer) tells the page when its folder is inside a synchronised folder: a copy of the video then sits there while a transcript is made.
  const SYNC_TEXT = 'Heads up: the helper\'s folder is inside a synchronised folder (OneDrive, Dropbox, iCloud or Google Drive). A copy of your video sits there while a transcript is made, and the sync program may upload it. Move the whole Video Redline folder into your own user folder (for example VideoRedline), as the README says.';

  /* The panel (cleanup-panel.js 1.2.0) turns EVERY SENTENCE of a help text into one numbered step. So each sentence below is one thing to DO:
     two ways of doing the same step ("..., or double-click ...") stay inside one sentence, no sentence starts with "Or", and no sentence only
     describes a cause. (A colon or comma does not start a new step; a full stop followed by a capital letter does.)
     Whenever a text says to stop the helper, it also says how it starts again: the "Video Redline" icon. The page itself starts nothing. */
  // The client says something like this when it finds nobody; the page keeps it in its own cards, because the helper may be running and only blocked.
  const BLOCKED = 'If it still cannot find the helper (the icon may have said that the helper did not start), restart your computer and try the icon once more, and check that nothing blocks the connection (your browser, a VPN or a firewall): if your browser asks whether this page may connect to programs on your computer, choose Allow (if you clicked Block before, click the small icon at the left of the address bar, switch the permission back on and reload this page).';
  const NO_HELPER = 'On Windows, double-click the "Video Redline" icon on your Desktop, which starts the helper and opens a new page that you can close (if there is no such icon yet, first double-click ' + ICON_FILE + ' once: it is in the tools folder and makes the icon). Come back to this page and press Check again. ' + BLOCKED;
  /* The lines of the switched-off launch path (nothing reaches them in real use). */
  const TEXT = {
    starting: 'Looking for the helper ...',
    slow: 'Still waiting for the helper. Double-click the "Video Redline" icon on your Desktop: it starts the helper.',
    tried: 'The helper did not answer in time.',
    triedHelp: NO_HELPER,
    gaveUp: 'I could not reach the helper.',
    gaveUpHelp: NO_HELPER
  };
  /* The client's own advice talks about "the helper window". A helper that starts by itself has none. These replace advice that
     mentions it (the helper's window, if you opened one yourself, is still covered). */
  const HELP_WIN = {
    'no-helper': NO_HELPER,
    'busy': 'The helper is already making another transcript. Wait until it has finished (a transcript that a page you closed or reloaded started ends by itself after about 10 minutes), or to stop it right now, double-click ' + STOP_FILE + ' in the tools folder (or close the helper window, if you opened one yourself) and then ' + START_AGAIN + '. Then press Check again.',
    'network': 'The connection to the helper was lost. Double-click the "Video Redline" icon on your Desktop to start the helper again (you can close the page it opens). Then click Create transcript again.',
    'not-ready': 'Close other programs. Then stop the helper (double-click ' + STOP_FILE + ' in the tools folder, or close the helper window if you opened one yourself), ' + START_AGAIN + ' and press Check again. If this keeps happening, stop the helper the same way, double-click setup-windows.bat once more, wait for ALL DONE, and then ' + START_AGAIN + '.',
    'failed': 'Something went wrong while making the transcript. Try once more. If it keeps failing, try a shorter recording, or send the file logs\\helper.log from the tools folder (or the text in the helper window, if you opened one) to the person who invited you to the beta.'
  };

  /* Asking Windows to start the helper from the page is OFF. It was tried and does not work: a hidden frame is not allowed to open an
     app, and a click on the link made the test browser replace the whole page with an error page and start nothing. The sure ways
     are the start at sign-in and the "Video Redline" icon (open_video_review.pyw), so with no helper the person is sent to the icon.
     The rest of this wrapper (the heartbeat, the advice) works as before. A test turns the old behaviour on with the seam launchFromPage. */
  const launchEnabled = () => helperSeam().launchFromPage === true;
  const asReady = r => Object.assign({}, r, { ready: true, checking: false, problem: null });
  const tune = (k, dflt) => { const v = helperSeam()[k]; return v > 0 ? v : dflt; };
  const notFound = () => ({ found: false, ready: false, busy: false, version: null, port: null, problem: '' });

  /* Only Windows (a Mac comes later), and only a page the helper would answer: a file on this computer, or http://localhost or
     http://127.0.0.1. (The helper refuses every other Origin, so for an https page starting it would not help.) */
  function wantsAutostart() {
    const s = helperSeam();
    if (s.off === true) return false;
    const win = typeof s.windows === 'boolean' ? s.windows : /Windows NT/.test((navigator && navigator.userAgent) || '');
    const here = s.anyPage === true || location.protocol === 'file:' || (location.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname));
    return win && here;
  }
  /* The client's advice for a helper that is running but cannot get ready (speech tools missing, folder moved, took too long, files
     missing) says "start the helper again" or "close the helper window". A hidden helper has no window and nothing but the icon starts it,
     so: advice that mentions the window is replaced, and "start the helper again" becomes "double-click the icon". A repair with
     setup-windows.bat cannot replace files that the running helper uses, so "double-click setup-windows.bat" becomes "stop the helper
     (double-click stop-helper-windows.bat in the tools folder), then double-click setup-windows.bat" (still one sentence, so one step). */
  const startsSentence = (whole, at) => at === 0 || /[.!?]["')]*\s+$/.test(whole.slice(0, at));
  const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
  const fixNotReady = help => {
    const h = String(help == null ? '' : help);
    if (!h.replace(/\s+/g, '')) { return h; }
    if (/helper window/i.test(h)) { return HELP_WIN['not-ready']; }
    // After a repair with setup-windows.bat the old icon and start-up entry point at the old place (folder moved or copied): setup-autostart-windows.bat makes them again and starts the helper
    const again = /setup repairs the folder/i.test(h) ? 'double-click ' + ICON_FILE + ' (it makes the "Video Redline" icon again and starts the helper)' : START_AGAIN;
    return h
      .replace(/(?:Open the tools folder and )?double-click setup-windows\.bat/gi, (m, at, whole) => {
        const t = 'stop the helper (double-click ' + STOP_FILE + ' in the tools folder), then double-click setup-windows.bat';
        return startsSentence(whole, at) ? cap(t) : t;
      })
      .replace(/start the helper again/gi, (m, at, whole) => (startsSentence(whole, at) ? cap(again) : again))
      .replace(/\s*On a Mac: .*?press Return\./g, '');                      // this card is for Windows: the Mac recipe is not for this reader
  };
  /* The client's advice for no-helper, busy and network always talks about starting the helper or a window; for the others only when it says "helper window". */
  const rewrite = (code, help) => {
    if (!wantsAutostart() || !HELP_WIN[code]) { return help; }
    if (['no-helper', 'busy', 'network'].indexOf(code) >= 0) { return HELP_WIN[code]; }
    if (code === 'not-ready') { return fixNotReady(help); }
    return /helper window/i.test(String(help || '')) ? HELP_WIN[code] : help;
  };

  /* SWITCHED OFF, NOT USED IN REAL USE (see the note at the top): the one place that knows how the link is opened. Returns false when the browser would not even try. */
  function launch() {
    try {
      const s = helperSeam();
      memory.launches++;
      if (typeof s.launch === 'function') { s.launch(LINK); return true; }
      let a = document.getElementById('vrtHelperLaunch');
      if (a && a.parentNode) { a.parentNode.removeChild(a); }
      a = document.createElement('a');
      a.id = 'vrtHelperLaunch';
      a.setAttribute('aria-hidden', 'true'); a.setAttribute('tabindex', '-1');
      const link = (typeof s.link === 'string' && s.link) || LINK;     // (s.link: tests only, so a test never opens the real link)
      a.setAttribute('data-vrt-link', link); a.setAttribute('data-vrt-count', String(memory.launches));
      a.style.display = 'none';
      a.href = link;
      document.body.appendChild(a);
      a.click();                       // a real click on a link, inside the user's click: a browser does not open an app for a hidden frame
      return true;
    } catch (e) { return false; }
  }

  function create(cfg) {
    const real = Base.create(cfg);
    let ticket = null;           // the question that is waiting right now (one at a time)

    const ask = () => {            // real.check() is called right here, not a moment later: inside the click when the panel calls check()
      let p = null;
      try { p = real.check(); } catch (e) { p = null; }
      return Promise.resolve(p).then(r => (r && typeof r === 'object' ? r : notFound()), () => notFound());
    };
    const failed = (r, text, help) => Object.assign({}, r, { found: false, ready: false, busy: false, port: null, problem: text, help: help });
    const fixed = r => (r && r.found && !r.ready && !r.checking && r.help) ? Object.assign({}, r, { help: rewrite('not-ready', r.help) }) : r;   // the helper's own advice
    const answer = r => (r.ready ? r : (r.checking === true ? asReady(r) : fixed(r)));      // a found helper: up and ready, just started (run() waits for it), or cannot get ready (the panel explains)

    /* SWITCHED OFF, NOT USED IN REAL USE (only reached with the test seam launchFromPage): ask every POLL_MS until the helper answers or the time is up. Never rejects. */
    function waitFor(t, last, deadline) {
      const t0 = Date.now();
      let slowSaid = false;
      return new Promise(resolve => {
        const done = r => { if (t.timer) { clearTimeout(t.timer); t.timer = null; } t.wake = null; resolve(r); };
        t.wake = () => done(last);
        const tick = () => {
          t.timer = null;
          if (t.stopped) { done(last); return; }
          ask().then(r => {
            if (t.stopped) { done(last); return; }
            last = r;
            const now = Date.now();
            if (r.found) { memory.tries = 0; hide(); done(answer(r)); return; }                  // it answered: the link works (busy is the panel's business)
            if (now >= deadline) { done(failed(r, TEXT.tried, TEXT.triedHelp)); return; }
            if (!slowSaid && now - t0 > 8000) { slowSaid = true; say(TEXT.slow, 8000); }
            t.timer = setTimeout(tick, tune('pollMs', POLL_MS));
          });
        };
        t.timer = setTimeout(tick, tune('pollMs', POLL_MS));                        // the caller has just asked once
      });
    }

    /* The panel calls this synchronously inside the click, so the first question is sent while the click is still fresh. */
    function check() {
      if (ticket) { ticket.stop(); }
      const t = ticket = { stopped: false, timer: null, wake: null };
      t.stop = () => { t.stopped = true; if (t.timer) { clearTimeout(t.timer); t.timer = null; } if (t.wake) { t.wake(); } };
      const finish = r => { if (ticket === t) { ticket = null; } return r; };
      return ask().then(first => {
        if (!t.stopped && first.found && first.syncWarning === true && !memory.syncSaid) { memory.syncSaid = true; say(SYNC_TEXT, 16000); }
        if (t.stopped || !wantsAutostart()) { return first; }
        if (first.found) {
          if (first.ready) { memory.tries = 0; }
          return answer(first);                                                // (a helper that has only just started is never started twice)
        }
        if (!launchEnabled()) { return first; }                                // REAL USE ENDS HERE: the page does not start the helper (see the note at the top): its card sends the person to the icon. Everything below is the switched-off launch path.
        const now = Date.now();
        if (memory.lastLaunch && now - memory.lastLaunch < tune('gapMs', GAP_MS)) {                       // an earlier question already asked Windows
          return waitFor(t, first, memory.until);
        }
        if (memory.tries && now - memory.lastLaunch > tune('forgetMs', FORGET_MS)) { memory.tries = 0; }   // old failures are forgotten
        if (memory.tries >= MAX_TRIES || !launch()) { return failed(first, TEXT.gaveUp, TEXT.gaveUpHelp); }
        memory.until = Date.now() + (memory.tries ? tune('retryMs', RETRY_WAIT_MS) : tune('waitMs', WAIT_MS));
        memory.tries++; memory.lastLaunch = Date.now();
        say(TEXT.starting, 8000);
        return waitFor(t, first, memory.until);
      }).then(finish, () => finish(notFound()));
    }

    const lostError = () => {
      const e = new Error('The connection to the helper was lost.');
      e.code = 'network'; e.help = rewrite('network', Base.helpText('network'));
      return e;
    };

    /* run() has its own wait for a helper that is still checking (checkingWaitMs, 60 s), so a helper that has only just come up works.
       Once the speech work has begun, the helper is asked about every BEAT_MS. The client itself tells the person "Lost contact with
       the helper, trying again ..." after about 2 seconds, but gives up only after about 17 seconds. When nobody answers LOST_BEATS
       times in a row, each time at once (a stopped helper refuses a connection immediately, a busy one is slow), the run is ended and
       reported as a lost connection (the card then replaces that "trying again" line). */
    function run(file, options, onProgress) {
      if (ticket) { ticket.stop(); }
      let beat = null, over = false, lost = false, started = false, quick = 0, beatClient = null;
      const stopBeat = () => { over = true; if (beat) { clearTimeout(beat); beat = null; } };
      /* Once the helper has been found, the beats ask only its port: a busy helper makes the client look at all five ports every 20 s,
         which would print four red "connection refused" lines in the browser console each time. */
      const askBeat = () => {
        if (!beatClient) { return ask().then(r => { if (r.found && r.port) { try { beatClient = Base.create(Object.assign({}, cfg, { ports: [r.port] })); } catch (e) { /* keep asking the shared client */ } } return r; }); }
        let p = null;
        try { p = beatClient.check(); } catch (e) { p = null; }
        return Promise.resolve(p).then(r => (r && typeof r === 'object' ? r : notFound()), () => notFound());
      };
      const watch = () => {
        if (over || beat) { return; }
        beat = setTimeout(() => {
          beat = null;
          const t0 = Date.now();
          askBeat().then(r => {
            if (over) { return; }
            if (r.found) { quick = 0; } else if (Date.now() - t0 <= tune('quickMs', QUICK_MS)) { quick++; }
            if (quick >= LOST_BEATS) { lost = true; stopBeat(); try { real.cancel(); } catch (e) { /* the run ends either way */ } return; }
            watch();
          });
        }, tune('beatMs', BEAT_MS));
      };
      const progress = pg => {
        if (!started && !over && pg && pg.phase === 'transcribing' && wantsAutostart()) { started = true; watch(); }
        if (typeof onProgress === 'function') { onProgress(pg); }
      };
      return real.run(file, options, progress).then(v => { stopBeat(); return v; }, err => {
        stopBeat();
        if (lost) { err = lostError(); }
        try {
          if (err && wantsAutostart()) {
            err.help = rewrite(err.code, err.help);
            if (err.code === 'network' && /helper window/i.test(String(err.message))) { err.message = err.message.replace(/\s*Check that the helper window is still open\.?/i, ''); }
          }
        } catch (e) { /* keep the client's own error */ }
        throw err;
      });
    }

    /* Cancel stops the waiting here (nothing more is asked, nothing more is started) and whatever run() is doing. */
    function cancel() {
      const waiting = !!ticket && !ticket.stopped;
      if (ticket) { ticket.stop(); ticket = null; }
      if (waiting) { hide(); }       // a question in flight counts as waiting (also a plain Check again), so Cancel clears whatever toast is showing; the "Starting the helper" toast of the switched-off launch path would otherwise stay on next to the "Cancelled" card
      return Promise.resolve(real.cancel()).then(v => !!v || waiting, () => waiting);
    }

    return { check: check, run: run, cancel: cancel };
  }

  return {
    create: create,
    helpText: code => {
      if (!wantsAutostart()) { return Base.helpText(code); }
      if (['no-helper', 'busy', 'network', 'failed'].indexOf(code) >= 0) { return HELP_WIN[code]; }
      return code === 'not-ready' ? fixNotReady(Base.helpText(code)) : Base.helpText(code);
    },
    CODES: Base.CODES,
    version: Base.version
  };
}
// Nothing is made until a video is open; with no TranscriberClient on the page (no helper support) the panel keeps its own answer.
const HelperAutostart = typeof TranscriberClient !== 'undefined' ? makeHelperAutostart(TranscriberClient, { say: (m, ms) => toast(m, ms), hide: () => toastEl.classList.remove('show') }) : undefined;

/* ---------- the panel in the left tabs ---------- */
function buildCleanupPanel() {
  const host = $('cleanupHost');
  if (cleanupPanel) { try { cleanupPanel.destroy(); } catch (e) { /* already gone */ } cleanupPanel = null; }
  host.textContent = '';
  updateCleanupBadge();
  if (!HAS_CLEANUP) { host.appendChild(h('div', { class: 'pane-note', text: 'The audio cleanup module did not load.' })); return; }
  if (!meta) {
    host.appendChild(h('div', { class: 'empty' }, h('span', { class: 'empty-ic', 'data-icon': 'scissors' }), h('b', { text: 'Audio cleanup' }),
      h('p', { text: 'Open a video first. Then open a transcript of it, and this tab finds dead air, ums, stutters and false starts and turns them into cut markers for you to review.' })));
    mountIcons(host);
    return;
  }
  try { cleanupPanel = CleanupPanel.create({ host, api: cleanupApi, Cleanup, TranscriberClient: HelperAutostart, transcriberPorts: helperSeam().ports }); }
  catch (e) { host.appendChild(h('div', { class: 'pane-note', text: 'Audio cleanup could not start: ' + (e && e.message ? e.message : e) })); }
  updateCleanupBadge();
}
function updateCleanupBadge() {
  const b = $('cleanupBadge'); if (!b) return;
  let n = 0;
  try { if (cleanupPanel) n = cleanupPanel.summary().pending || 0; } catch (e) { n = 0; }
  b.textContent = String(n); b.hidden = n === 0;
}
// When cuts change in the page (you deleted one, undo, loading a session) the panel repaints. Slightly delayed and merged,
// so dragging a cut or accepting 200 cards does not repaint 200 times.
let cleanupRefreshTimer = null;
function cleanupMarkersChanged() {
  if (!cleanupPanel || cleanupRefreshTimer) return;
  cleanupRefreshTimer = setTimeout(() => {
    cleanupRefreshTimer = null;
    try { if (cleanupPanel) { cleanupPanel.refreshMarkers(); updateCleanupBadge(); } } catch (e) { /* ignore */ }
  }, 220);
}
function cleanupDropPendingRefresh() { if (cleanupRefreshTimer) { clearTimeout(cleanupRefreshTimer); cleanupRefreshTimer = null; } }
setInterval(updateCleanupBadge, 600);

/* Undo, redo and loading a session change cuts without the panel being asked. The page wins, and the panel is told to look again
   (refreshMarkers). It finds its own cuts again by what they remember (origin.candidateId), so the new marker ids after a loaded
   session do not matter, and it keeps its own state, so nothing here reads or writes the panel's saved decisions:
   - a cut that came back (undo of a delete, redo of an accept) is kept, and the "rejected" recorded when it vanished is dropped;
   - a cut that vanished is not re-added. After undoing an Accept the card goes back to "Needs your decision"; an automatic cut that
     vanished (undo of the automatic batch, a cut deleted by hand) is recorded as rejected and waits under "Rejected", one click on
     Restore away; automatic cuts that come in with a loaded session and fit no card of the open transcript are left alone;
   - a cut you trimmed or moved stays yours.
   The panel is never rebuilt here: that would cancel a transcript job that is still running and lose the filter, the selected card
   and the scroll position. (A rebuild happens only when a video is opened or closed.) */
function cleanupSyncAfterJump(loadedSession) {
  if (!cleanupPanel || !meta) return;
  if (cleanupRefreshTimer) { clearTimeout(cleanupRefreshTimer); cleanupRefreshTimer = null; }       // changed() just queued the same repaint
  // { loaded: true } (after File, Load session only) lets a newer panel bring back the automatic cuts of its own transcript that the session lacks; an older panel ignores it
  try { if (loadedSession) { cleanupPanel.refreshMarkers({ loaded: true }); } else { cleanupPanel.refreshMarkers(); } } catch (e) { /* the panel keeps whatever it had */ }
  updateCleanupBadge();
}

// A transcript file that was dropped or picked somewhere else on the page opens in the Cleanup tab. false: no panel (no video is open).
function cleanupOpenTranscript(text, name) {
  if (!cleanupPanel) return false;
  showTab('cleanup');
  try { cleanupPanel.load(text, name ? { source: { kind: 'file', name: String(name).slice(0, 120) } } : {}); } catch (e) { /* the panel shows its own message */ }
  return true;
}
// true when the engine can read this text as a transcript (the tool's JSON, Whisper JSON, SRT or VTT)
function looksLikeTranscript(text) { try { return HAS_CLEANUP && !!Cleanup.parseTranscript(text); } catch (e) { return false; } }

/* ---------- skip the cuts while playing, to hear the video the way it will sound after the cuts ---------- */
function skipCutsCheck() {
  if (!skipCuts || !meta || video.paused || rangeEnd != null) return;      // (a Preview of a stretch plays that stretch as asked, even inside a cut)
  let t = video.currentTime, jumped = false;
  for (let guard = 0; guard < 50; guard++) {          // cuts can touch each other: keep going to the end of the run
    const c = markers.find(m => m.type === 'cut' && t >= m.start - 0.001 && t < m.end - 0.001);
    if (!c) break;
    t = c.end; jumped = true;
  }
  if (jumped) video.currentTime = Math.min(t, meta.duration);
}
function setSkipCuts(on) {
  skipCuts = !!on; ui.skipCuts = skipCuts; saveUi();
  const b = $('bSkip'); b.classList.toggle('on', skipCuts);
  b.title = skipCuts ? 'Skipping cuts while playing. Click to play everything.' : 'While playing, jump over the cut markers so you hear the video as it will sound after the cuts';
}
