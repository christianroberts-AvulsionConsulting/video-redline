/* transcriber-client.js - lets the Video Redline page make a transcript with one click.
 *
 * A web page cannot start programs, so the helper has to be running first and this page never starts it (neither does
 * any button of the panel). On Windows the "Video Redline" icon on the Desktop starts it, hidden and with no window, and
 * opens the page; setup-autostart-windows.bat adds that icon and makes the helper start by itself at every sign-in.
 * start-helper-windows.bat (a window that the user leaves open) is the way for a person who would rather not have that.
 * On a Mac the user starts it by hand (start-helper-mac.command, run through Terminal). This file talks to that helper
 * on 127.0.0.1 (this computer only; no other address is ever contacted): it sends the video, shows progress, and hands
 * back the finished transcript object (the same JSON the drag-and-drop launcher writes).
 *
 *   var tc = TranscriberClient.create({ ports: [47831, 47832, 47833, 47834, 47835], timeoutMs: 1200 });
 *   tc.check()                      -> Promise<{ found, ready, busy, version, port, problem }>   (never rejects)
 *                                      (+ checking: true while a just-started helper is still checking its speech tools:
 *                                      then found is true, ready is false and problem says to wait a few seconds)
 *                                      (+ syncWarning: boolean, only when found is true: true when the helper says that its
 *                                      tools folder lies in a cloud-synced folder (OneDrive, Dropbox, iCloud, Google Drive) or
 *                                      on a network drive, so a copy of the video may be uploaded while it is processed; false
 *                                      when it says there is no such warning or does not say at all (an older helper). The
 *                                      folder name is not passed on. Added in 1.0.2; nothing else about check() changed.)
 *                                      The ports are asked one after another, the one that answered last time first, and the
 *                                      asking stops at the first helper that is ready and free. With the helper on that port
 *                                      that is one request, so the browser logs no refused connections; run() uses the same
 *                                      port again after checking that it still answers. A helper on a later port costs one
 *                                      refused connection for each empty port before it, the first time only. If the helper
 *                                      that answers is busy or still starting, the ports behind it are asked as well (a second
 *                                      helper may be running there, free): the first ready and free one is used, else the
 *                                      first ready one. That wider look is made at most once every 20 seconds.
 *   tc.run(file, options, onProgress) -> Promise<transcript>      rejects with Error { message (friendly), code, help }
 *                                      (+ jobError: the helper's own reason, e.g. 'no-audio', 'bad-media', 'out-of-memory',
 *                                      when code is 'failed' because the work itself failed; help always fits the real cause)
 *   tc.cancel()                     -> Promise<boolean>           stops the upload / work and tells the helper
 *   TranscriberClient.helpText(code) -> short plain-language instruction for a failure code
 *                                      (The page turns every sentence of a help text into one numbered step. So in the
 *                                      advice for a helper that is not ready every sentence says something to do and the
 *                                      text ends with the click that tries again; advice that mentions the helper's window
 *                                      also covers a helper that runs hidden and has none. Reworded in 1.0.3. The one change besides
 *                                      the words: a helper that is not ready and gives no reason now gets the short default
 *                                      sentence as check().problem, not the whole advice. Also in 1.0.3 (words only): the advice
 *                                      for a helper that is not running names the Video Redline icon first (it starts the
 *                                      helper and opens the page), then setup-autostart-windows.bat for a computer that has no
 *                                      icon yet, then start-helper-windows.bat for a person who would rather not have the
 *                                      automatic start; the advice for a helper that is busy or lost says how a stopped helper
 *                                      starts again (for a Mac as well: the Terminal recipe, or "the same way as before"); the step for
 *                                      the hand start begins "On Windows"; and the advice after a failure says "the person who invited
 *                                      you to the beta". The Mac recipe is the same as before.)
 *
 *   options    (all optional): { parakeet: 'v2'|'v3', whisper: 'small.en'|..., noWhisper: bool, noParakeet: bool, threads: int }
 *   onProgress({ phase: 'checking'|'uploading'|'transcribing'|'finishing', percent: 0..100 (whole operation: the upload
 *              counts for 15, transcribing for 80, finishing for 5; never goes backwards), message, etaSeconds|null })
 *              While a job runs and the helper does not answer, the message becomes "Lost contact with the helper, trying
 *              again ..." (phase 'transcribing', same percent, no time left) after two failed asks in a row; the helper's own
 *              messages come back as soon as it answers. When the helper has gone away (its window was closed), the person is
 *              told after about 2 seconds and run() gives up ('network') about 17 seconds after the last answer. A helper that
 *              is frozen (it keeps the connection open but never answers) makes every ask wait for its 6 second limit: the
 *              person is told after about 14 seconds and run() gives up after about 53 seconds.
 *   error.code is one of: 'no-helper', 'busy', 'not-ready', 'disk-full', 'cancelled', 'failed', 'too-big', 'network'
 *
 *   create() settings (all optional): ports, timeoutMs (one request to a port while looking for the helper, default 1200; the
 *   ports are asked one after another, so keep it at 1.5 seconds or less), pollMs (how often a running job is asked
 *   about; the helper stops a job that nobody has asked about for 10 minutes, so keep this under a few seconds),
 *   checkingWaitMs (how long run() waits for a just-started helper to finish checking, default 60000).
 *
 * Plain ES2019, ASCII only, no libraries. Nothing here touches the page (no DOM) when the file loads.
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else if (root) {
    root.TranscriberClient = api;
  }
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = '1.0.3';
  var HELPER_ID = 'video-review-helper';
  var DEFAULT_PORTS = [47831, 47832, 47833, 47834, 47835];
  var UPLOAD_SHARE = 15;        /* percent of the whole operation */
  var WORK_SHARE = 80;
  var FINISH_SHARE = 5;
  var DEFAULT_MAX_BYTES = 6 * 1024 * 1024 * 1024;
  var ALLOWED_OPTIONS = ['parakeet', 'whisper', 'noWhisper', 'noParakeet', 'threads'];

  var HELP = {
    'no-helper': 'Start the helper: on Windows, double-click the Video Redline icon on your Desktop (it starts the helper and opens Video Redline in a new page that you can close). On a Mac: open Terminal, type bash and a space, drag start-helper-mac.command into the window, then press Return. On Windows, if there is no such icon yet, open the tools folder and double-click setup-autostart-windows.bat once: it adds the icon and makes the helper start by itself at every sign-in. On Windows, if you would rather not use the automatic start, double-click start-helper-windows.bat in the tools folder each time and leave its window open. Leave the helper running (if it has a window, do not close it), then come back to this page and click Create transcript again.',
    'busy': 'The helper is already making another transcript. Wait until it has finished, then click Create transcript again. If that transcript was started by a page that you have since closed or reloaded, the helper stops it by itself after about 10 minutes; to stop it right now, close the helper window (if you started the helper by hand) or, on Windows, double-click stop-helper-windows.bat in the tools folder. If you stopped the helper, start it again: on Windows, double-click the Video Redline icon on your Desktop (or start-helper-windows.bat, if you started it by hand). On a Mac: open Terminal, type bash and a space, drag start-helper-mac.command into the window, then press Return. Then click Create transcript again.',
    'not-ready': 'Open the tools folder and double-click setup-windows.bat. On a Mac: open Terminal, type bash and a space, drag setup-mac.command into the window, then press Return. Wait for ALL DONE. Then start the helper again and click Create transcript again.',
    'disk-full': 'There is not enough free space on this computer\'s drive for this recording. Free up some space (about 1.5 times the size of the video, and at least 1 GB more), or try a shorter recording, then click Create transcript again.',
    'cancelled': 'You cancelled it. Nothing was kept. Click Create transcript to start again.',
    'failed': 'Something went wrong while making the transcript. Try once more. If it keeps failing, try a shorter recording, or send the text in the helper window (or, if the helper has no window, the files in the logs folder of the tools folder) to the person who invited you to the beta.',
    'too-big': 'This file is too large for the helper (the limit is about 6 GB). Export a smaller or lower-quality copy of the video and try again.',
    'network': 'The connection to the helper was lost. Make sure the helper is running: on Windows, double-click the Video Redline icon on your Desktop, which starts it again if it has stopped (if you started the helper by hand and closed its window, double-click start-helper-windows.bat again). On a Mac: start it again through Terminal, the same way as before. Then click Create transcript again.'
  };

  var DEFAULT_MESSAGE = {
    'no-helper': 'I cannot find the helper program on this computer.',
    'busy': 'The helper is already busy making another transcript.',
    'not-ready': 'The speech tools are not installed on this computer yet.',
    'disk-full': 'There is not enough free space on this computer for this video.',
    'cancelled': 'Cancelled.',
    'failed': 'The transcript could not be made.',
    'too-big': 'This file is too large for the helper.',
    'network': 'The connection to the helper was lost.'
  };

  /* What the helper itself reports when the work fails (error.jobError). The page's error code stays 'failed', but the
     advice must fit the real cause: "try once more" can never help for a recording without sound. */
  var HELP_JOB = {
    'no-audio': 'This recording has no sound. Check that the microphone was switched on when it was recorded, or choose a different file.',
    'bad-media': 'The helper could not read the sound in this file. Try playing it in a video player first. If it plays, export it again (an mp4 works best) and try that copy, or choose a different file.',
    'out-of-memory': 'The computer ran out of memory. Close other programs and try again. If it keeps happening, try a shorter recording, or ask for the lighter settings (a smaller Whisper model, or no Whisper).'
  };

  /* The helper's "not ready" messages are not all cured by running the setup file. These are the causes it can report
     (vrt_server.py: Readiness.compute, explain_failure); the message itself decides which advice fits. */
  var HELP_NOT_READY = [
    [/still starting up|still checking|just started/i,
      'Wait a few seconds, then click Create transcript again.'],
    [/visual c\+\+|vc_redist/i,
      'Follow the steps in the message above (install the free Microsoft component), then start the helper again and click Create transcript.'],
    [/moved, renamed|moved or copied/i,
      'Double-click setup-windows.bat once more. On a Mac: open Terminal, type bash and a space, drag setup-mac.command into the window, then press Return. Wait for ALL DONE (setup repairs the folder in under a minute and keeps the speech models). Then start the helper again and click Create transcript again.'],
    /* (the helper is running and re-checks by itself, so nothing is started again: closing a window or starting the helper would
       say "already running" to a person whose helper runs hidden) */
    [/took too long|could not check the speech tools|try starting the helper again/i,
      'Close other programs that keep the computer busy. Wait a few seconds. Then click Create transcript again.'],
    [/files that belong with the helper|complete tools folder/i,
      'Copy or unzip the complete tools folder (all of its files together). Then start the helper again and click Create transcript again.']
  ];

  var HELP_CANCELLED_BY_HELPER = 'The helper stopped this transcript (it had not heard from this page for a while, or it was cancelled somewhere else). Nothing was kept. Click Create transcript to start again.';
  var CHECKING_PROBLEM = 'The helper has just started and is still checking the speech tools. Wait a few seconds and try again.';
  /* Shown instead of the helper's own message while a running job gets no answer (so the page does not look frozen).
     cleanup-panel.js (stageLine) has to recognise it by its first words, "Lost contact", to say so on its main status line
     (otherwise the small grey line under the bar is all a person sees): keep them. */
  var LOST_CONTACT_MESSAGE = 'Lost contact with the helper, trying again ...';
  var LOST_CONTACT_AFTER = 2;   /* failed asks in a row before the person is told */
  var WIDE_LOOK_MS = 20000;     /* at most one look behind a busy or not-ready helper in this time (see findHelper) */
  var GIVE_UP_AFTER = 6;        /* failed asks in a row before run() gives up: waits of 1.4, 2.8, 4, 4 and 4 s = about 16 s
                                   (about 17 s after the last answer; a frozen helper also makes each ask wait 6 s: about 53 s) */

  function notReadyHelp(message) {
    var m = String(message || '');
    for (var i = 0; i < HELP_NOT_READY.length; i++) {
      if (HELP_NOT_READY[i][0].test(m)) { return HELP_NOT_READY[i][1]; }
    }
    return HELP['not-ready'];
  }

  function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  function helpText(code) {
    if (has(HELP, code)) { return HELP[code]; }
    return has(HELP_JOB, code) ? HELP_JOB[code] : HELP.failed;
  }

  /* jobError: the helper's own error word for a failed job (optional). */
  function makeError(code, message, jobError) {
    var e = new Error(message || DEFAULT_MESSAGE[code] || DEFAULT_MESSAGE.failed);
    e.code = has(HELP, code) ? code : 'failed';
    if (typeof jobError === 'string' && jobError) { e.jobError = jobError; }
    if (e.code === 'not-ready') { e.help = notReadyHelp(message); }
    else if (e.code === 'failed' && e.jobError && has(HELP_JOB, e.jobError)) { e.help = HELP_JOB[e.jobError]; }
    else { e.help = helpText(e.code); }
    return e;
  }

  function tryJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) { return lo; }
    return Math.max(lo, Math.min(hi, n));
  }

  function currentProtocol() {
    try { return (root && root.location && root.location.protocol) || ''; } catch (e) { return ''; }
  }

  function noHelperProblem() {
    var msg = 'The helper has not been started yet. (If it is running, your browser may have blocked the connection: if it asks whether this page may connect to programs on your computer, choose Allow.)';
    if (currentProtocol() === 'https:') {
      msg += ' This page was opened from a secure web address (https), and some browsers refuse to let such a page talk to a program on this computer. Open the page from the file on your computer instead.';
    }
    return msg;
  }

  function cleanOptions(options) {
    var out = {};
    var any = false;
    if (options && typeof options === 'object') {
      ALLOWED_OPTIONS.forEach(function (k) {
        var v = options[k];
        if (v !== undefined && v !== null && v !== '') { out[k] = v; any = true; }
      });
    }
    return any ? out : null;
  }

  /* ------------------------------------------------------------------------------------------------
     create()
     ------------------------------------------------------------------------------------------------ */
  function create(cfg) {
    cfg = cfg || {};
    var ports = (cfg.ports && cfg.ports.length) ? cfg.ports.slice() : DEFAULT_PORTS.slice();
    var timeoutMs = cfg.timeoutMs > 0 ? cfg.timeoutMs : 1200;
    var pollMs = cfg.pollMs > 0 ? cfg.pollMs : 700;
    var checkingWaitMs = cfg.checkingWaitMs >= 0 ? cfg.checkingWaitMs : 60000;    /* how long run() waits for a helper that is still checking */
    var checkingPollMs = cfg.checkingPollMs > 0 ? cfg.checkingPollMs : 1000;
    var impl = { fetch: cfg.fetch || null, XMLHttpRequest: cfg.XMLHttpRequest || null };   /* hooks for tests */
    var maxBytesSeen = {};          /* port -> the largest upload that helper accepts */
    var lastPort = null;            /* the port where a helper answered last (asked first next time) */
    var lastWideLook = 0;           /* when the ports behind a busy or not-ready helper were last asked (see findHelper) */
    var current = null;             /* the run in progress (one at a time per client) */

    function base(port) { return 'http://127.0.0.1:' + port; }
    function getFetch() { return impl.fetch || (root && typeof root.fetch === 'function' ? root.fetch : null); }
    function getXhr() { return impl.XMLHttpRequest || (root && root.XMLHttpRequest ? root.XMLHttpRequest : null); }

    /* One request with a time limit. Resolves { status, text }; rejects on a network error or when time runs out. */
    function http(url, init, ms) {
      var f = getFetch();
      return new Promise(function (resolve, reject) {
        if (!f) { reject(new Error('no fetch')); return; }
        var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) { return; }
          settled = true;
          if (ctl) { try { ctl.abort(); } catch (e) { /* ignore */ } }
          reject(new Error('timeout'));
        }, ms);
        var opts = { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors' };
        Object.keys(init || {}).forEach(function (k) { opts[k] = init[k]; });
        if (ctl) { opts.signal = ctl.signal; }
        var p;
        try { p = f.call(root, url, opts); } catch (e) { clearTimeout(timer); settled = true; reject(e); return; }
        Promise.resolve(p).then(function (res) {
          return res.text().then(function (text) {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            resolve({ status: res.status, text: text });
          });
        }).catch(function (e) {
          if (settled) { return; }
          settled = true;
          clearTimeout(timer);
          reject(e);
        });
      });
    }

    /* ---- check() ---------------------------------------------------------------------------------- */
    function probe(port) {
      return http(base(port) + '/status', { method: 'GET' }, timeoutMs).then(function (r) {
        var j = tryJson(r.text);
        if (r.status === 200 && j && j.ok === true && j.helper === HELPER_ID) {
          if (typeof j.maxUploadBytes === 'number') { maxBytesSeen[port] = j.maxUploadBytes; }
          return { port: port, status: j };
        }
        return null;
      }).catch(function () { return null; });
    }

    function notFound(problem) {
      return { found: false, ready: false, busy: false, version: null, port: null, problem: problem || noHelperProblem() };
    }

    /* The ports in the order they are asked: the one that answered last time, then the others as listed. */
    function probeOrder() {
      var order = [];
      if (lastPort !== null && ports.indexOf(lastPort) >= 0) { order.push(lastPort); }
      ports.forEach(function (p) { if (order.indexOf(p) < 0) { order.push(p); } });
      return order;
    }

    /* 2 = ready and free, 1 = ready but busy, 0 = still starting or not ready */
    function rank(hit) { return hit.status.ready ? (hit.status.busy ? 1 : 2) : 0; }

    /* Asks the ports one after another and stops at the first real helper that is ready and free (never all at once:
       every refused connection is a red error in the browser's console, so a helper on the first port must cost exactly
       one request). If the helper that answers is busy or not ready, the ports behind it are asked too, because a second
       helper can be running there (the launcher starts one on the next port when the first is too busy to answer in time):
       the first ready and free one wins, else the first ready one, else the first one that answered. That wider look costs
       refused connections, so it is made at most once every WIDE_LOOK_MS (run() looks every second while a just-started
       helper checks its tools). Resolves { port, status } or null. shouldStop (optional) is asked before each port: true
       stops the search (a cancelled run). */
    function findHelper(shouldStop) {
      var order = probeOrder();
      return new Promise(function (resolve) {
        var i = 0;
        var best = null;
        var wide = false;
        function done() {
          if (best) { lastPort = best.port; }
          resolve(best);
        }
        function next() {
          if (i >= order.length || (shouldStop && shouldStop())) { done(); return; }
          probe(order[i++]).then(function (hit) {
            if (hit && (!best || rank(hit) > rank(best))) { best = hit; }
            if (best && rank(best) === 2) { done(); return; }
            if (best && !wide) {                                   /* the first helper found is busy or not ready */
              var since = Date.now() - lastWideLook;
              if (since >= 0 && since < WIDE_LOOK_MS) { done(); return; }
              wide = true; lastWideLook = Date.now();
            }
            next();
          }).catch(function () { resolve(null); });
        }
        next();
      });
    }

    function check() { return checkNow(null); }

    function checkNow(shouldStop) {
      if (!getFetch()) {
        return Promise.resolve(notFound('This browser cannot talk to the helper (it has no fetch). Try a current version of Safari, Chrome or Edge.'));
      }
      var search;
      try { search = findHelper(shouldStop); } catch (e) { return Promise.resolve(notFound()); }
      return search.then(function (pick) {
        if (!pick) { return notFound(); }
        var s = pick.status;
        var ready = !!s.ready;
        var checking = !ready && s.checking === true;       /* just started: the helper is still looking at its speech tools */
        var problem = null;
        if (checking) {
          problem = CHECKING_PROBLEM;
        } else if (!ready) {
          problem = (typeof s.problem === 'string' && s.problem) ? s.problem : DEFAULT_MESSAGE['not-ready'];
        }
        var res = { found: true, ready: ready, busy: !!s.busy, version: typeof s.version === 'string' ? s.version : null, port: pick.port, problem: problem };
        res.syncWarning = s.syncWarning === true;               /* the helper's yes or no about a cloud-synced or network tools folder */
        if (checking) { res.checking = true; }
        else if (!ready) { res.help = notReadyHelp(problem); }   /* cause-specific steps (Visual C++, folder moved, ...) */
        return res;
      }).catch(function () { return notFound(); });
    }

    /* ---- run() ------------------------------------------------------------------------------------ */
    function report(ctx, phase, rawPercent, message, eta) {
      if (ctx.finished) { return; }
      var pct = Math.round(clamp(rawPercent, 0, 100) * 10) / 10;
      if (pct < ctx.pct) { pct = ctx.pct; }          /* never goes backwards */
      ctx.pct = pct;
      if (typeof ctx.onProgress === 'function') {
        try {
          ctx.onProgress({ phase: phase, percent: pct, message: message, etaSeconds: (typeof eta === 'number' && isFinite(eta)) ? Math.max(0, Math.round(eta)) : null });
        } catch (e) { /* a mistake in the page's callback must not break the transcript */ }
      }
    }

    function errorFromResponse(status, body, where) {
      var code = body && typeof body.error === 'string' ? body.error : '';
      var msg = body && typeof body.message === 'string' ? body.message : '';
      if (code === 'busy' || status === 409) { return makeError('busy', msg); }
      if (code === 'disk-full' || status === 507) { return makeError('disk-full', msg); }
      if (code === 'too-big' || status === 413) { return makeError('too-big', msg); }
      if (code === 'not-ready' || status === 503) { return makeError('not-ready', msg); }
      if (status === 0) { return makeError('network', where === 'upload' ? 'The connection to the helper was lost while the video was being sent.' : ''); }
      return makeError('failed', msg);
    }

    function sendCancel(port, jobId) {
      if (!port || !jobId) { return Promise.resolve(); }
      return http(base(port) + '/jobs/' + jobId + '/cancel', { method: 'POST' }, 8000).then(function () { }, function () { });
    }

    function phaseCheck(ctx, file) {
      report(ctx, 'checking', 0, 'Looking for the helper on this computer ...', null);
      return new Promise(function (resolve, reject) {
        ctx.abortPhase = function () { reject(makeError('cancelled')); };
        var deadline = Date.now() + checkingWaitMs;
        function attempt() {
          ctx.timer = null;
          /* starts with the port the last check() found, so a helper that is still there costs one request; a cancel stops the search */
          checkNow(function () { return ctx.cancelled; }).then(function (st) {
            if (ctx.cancelled) { reject(makeError('cancelled')); return; }
            if (!st.found) { reject(makeError('no-helper', st.problem)); return; }
            if (!st.ready) {
              if (st.checking && Date.now() < deadline) {     /* a helper that has just started: give it time to finish checking */
                report(ctx, 'checking', 0, 'The helper has just started and is still checking the speech tools. Waiting for it ...', null);
                ctx.timer = setTimeout(attempt, checkingPollMs);
                return;
              }
              reject(makeError('not-ready', st.problem));
              return;
            }
            if (st.busy) { reject(makeError('busy')); return; }
            var max = maxBytesSeen[st.port] || DEFAULT_MAX_BYTES;
            if (file.size > max) { reject(makeError('too-big')); return; }
            ctx.port = st.port;
            resolve(st);
          });
        }
        attempt();
      });
    }

    function phaseUpload(ctx, file, options) {
      return new Promise(function (resolve, reject) {
        ctx.abortPhase = function () { reject(makeError('cancelled')); };
        var X = getXhr();
        if (!X) { reject(makeError('failed', 'This browser cannot send files to the helper.')); return; }
        var xhr = new X();
        ctx.xhr = xhr;
        ctx.uploadDone = false;
        var name = (file && file.name) ? String(file.name) : 'video.mp4';
        var lastTick = 0;
        function pctText(f) { return Math.max(0, Math.min(100, Math.floor(f * 100))) + '%'; }
        try {
          xhr.open('POST', base(ctx.port) + '/jobs?name=' + encodeURIComponent(name), true);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          var opt = cleanOptions(options);
          if (opt) { xhr.setRequestHeader('X-Options', JSON.stringify(opt)); }
          xhr.responseType = 'text';
          xhr.timeout = 0;
          if (xhr.upload) {
            xhr.upload.onprogress = function (ev) {
              var total = (ev && ev.lengthComputable && ev.total) ? ev.total : file.size;
              var frac = total ? (ev.loaded / total) : 0;
              var t = Date.now();
              if (t - lastTick < 100 && frac < 1) { return; }
              lastTick = t;
              report(ctx, 'uploading', UPLOAD_SHARE * Math.min(1, frac), 'Sending the video to the helper on this computer ... ' + pctText(frac), null);
            };
            xhr.upload.onload = function () { ctx.uploadDone = true; };
          }
          xhr.onload = function () {
            var body = tryJson(xhr.responseText);
            var ok = xhr.status >= 200 && xhr.status < 300 && body && typeof body.job === 'string';
            if (ctx.cancelled) {                      /* cancelled after the last byte was sent: stop the job the helper just made */
              if (ok) { sendCancel(ctx.port, body.job); }
              return;
            }
            if (ok) { ctx.jobId = body.job; resolve(body.job); return; }
            reject(errorFromResponse(xhr.status, body, 'upload'));
          };
          xhr.onerror = function () { reject(makeError('network', 'The connection to the helper was lost while the video was being sent.')); };
          xhr.ontimeout = xhr.onerror;
          xhr.onabort = function () { reject(makeError('cancelled')); };
          report(ctx, 'uploading', 0, 'Sending the video to the helper on this computer ... 0%', null);
          xhr.send(file);
        } catch (e) {
          reject(makeError('failed', 'The video could not be sent to the helper.'));
        }
      });
    }

    function phaseWork(ctx) {
      return new Promise(function (resolve, reject) {
        ctx.abortPhase = function () { reject(makeError('cancelled')); };
        var fails = 0;                  /* asks in a row that got no usable answer */
        function schedule(ms) {
          if (ctx.cancelled || ctx.finished) { return; }
          ctx.timer = setTimeout(tick, ms);
        }
        function askFailed() {
          fails++;
          if (fails >= GIVE_UP_AFTER) { reject(makeError('network')); return; }
          /* the same percent and no time left: the bar stays where it is, but the page no longer looks as if all is well */
          if (fails === LOST_CONTACT_AFTER) { report(ctx, 'transcribing', ctx.pct, LOST_CONTACT_MESSAGE, null); }
          schedule(Math.min(4000, pollMs * Math.pow(2, fails)));       /* 1.4 s, 2.8 s, 4 s ... */
        }
        function tick() {
          ctx.timer = null;
          if (ctx.cancelled) { reject(makeError('cancelled')); return; }
          var t0 = Date.now();
          http(base(ctx.port) + '/jobs/' + ctx.jobId, { method: 'GET' }, 6000).then(function (r) {
            if (ctx.cancelled) { reject(makeError('cancelled')); return; }
            var j = tryJson(r.text);
            if (r.status === 404) {
              reject(makeError('failed', 'The helper no longer knows about this job (it may have been restarted). Please try again.'));
              return;
            }
            if (r.status !== 200 || !j || typeof j.state !== 'string') { askFailed(); return; }
            fails = 0;
            if (j.state === 'running') {
              var hp = clamp(j.percent, 0, 100);
              report(ctx, 'transcribing', UPLOAD_SHARE + WORK_SHARE * hp / 100, String(j.message || 'Working ...'), (typeof j.etaSeconds === 'number') ? j.etaSeconds : null);
              var took = Date.now() - t0;              /* a slow helper gets asked less often */
              schedule(Math.min(4000, Math.max(pollMs, took * 2)));
              return;
            }
            if (j.state === 'done') { resolve(j); return; }
            if (j.state === 'cancelled') {                  /* not by this page (it would have stopped polling): the helper or somebody else did it */
              var why = makeError('cancelled', typeof j.message === 'string' ? j.message : '');
              why.help = HELP_CANCELLED_BY_HELPER;
              reject(why);
              return;
            }
            /* state 'error' */
            var code = (j.error === 'disk-full' || j.error === 'not-ready') ? j.error : 'failed';
            reject(makeError(code, typeof j.message === 'string' ? j.message : '', typeof j.error === 'string' ? j.error : ''));
          }, function () {
            if (ctx.cancelled) { reject(makeError('cancelled')); return; }
            askFailed();
          });
        }
        report(ctx, 'transcribing', UPLOAD_SHARE, 'The helper is starting the speech engines ...', null);
        schedule(pollMs);
      });
    }

    function phaseFetch(ctx) {
      report(ctx, 'finishing', UPLOAD_SHARE + WORK_SHARE, 'Collecting the finished transcript ...', null);
      return new Promise(function (resolve, reject) {
        ctx.abortPhase = function () { reject(makeError('cancelled')); };
        http(base(ctx.port) + '/jobs/' + ctx.jobId + '/result', { method: 'GET' }, 120000).then(function (r) {
          if (ctx.cancelled) { reject(makeError('cancelled')); return; }
          var doc = tryJson(r.text);
          if (r.status === 200 && doc && typeof doc === 'object') { resolve(doc); return; }
          if (r.status === 200) { reject(makeError('failed', 'The helper sent back a transcript that could not be read.')); return; }
          reject(errorFromResponse(r.status, doc, 'result'));
        }, function () {
          reject(makeError('network', 'The connection to the helper was lost while the finished transcript was being collected.'));
        });
      });
    }

    function run(file, options, onProgress) {
      if (current) {
        return Promise.reject(makeError('busy', 'A transcript is already being made from this page. Wait for it, or cancel it first.'));
      }
      if (!file || typeof file.size !== 'number') {
        return Promise.reject(makeError('failed', 'Choose a video file first.'));
      }
      var ctx = { cancelled: false, finished: false, pct: 0, xhr: null, uploadDone: false, jobId: null, port: null, timer: null, abortPhase: null, onProgress: onProgress };
      current = ctx;
      function end() {
        ctx.finished = true;
        if (ctx.timer) { clearTimeout(ctx.timer); ctx.timer = null; }
        if (current === ctx) { current = null; }
      }
      return Promise.resolve().then(function () {      /* the first progress callback comes after run() has returned */
        return phaseCheck(ctx, file);
      }).then(function () {
        return phaseUpload(ctx, file, options);
      }).then(function () {
        return phaseWork(ctx);
      }).then(function () {
        return phaseFetch(ctx);
      }).then(function (doc) {
        if (ctx.cancelled) { throw makeError('cancelled'); }
        report(ctx, 'finishing', 100, 'Done. The transcript is ready.', 0);
        end();
        return doc;
      }, function (err) {
        var wasCancelled = ctx.cancelled;
        var jobId = ctx.jobId, port = ctx.port;
        end();
        if (wasCancelled) { throw makeError('cancelled'); }
        if (jobId && err && err.code !== 'busy') { sendCancel(port, jobId); }      /* do not leave the helper working for nobody */
        throw err;
      });
    }

    function cancel() {
      var ctx = current;
      if (!ctx || ctx.cancelled) { return Promise.resolve(false); }
      ctx.cancelled = true;
      if (ctx.timer) { clearTimeout(ctx.timer); ctx.timer = null; }
      if (ctx.xhr && !ctx.uploadDone) {
        try { ctx.xhr.abort(); } catch (e) { /* ignore */ }
      }
      if (ctx.abortPhase) { ctx.abortPhase(); }
      /* if the upload had already been sent completely, the XHR is left to finish: its answer carries the job number to cancel */
      return sendCancel(ctx.port, ctx.jobId).then(function () { return true; });
    }

    return { check: check, run: run, cancel: cancel };
  }

  return {
    create: create,
    helpText: helpText,
    CODES: Object.keys(HELP),
    version: VERSION
  };
}));
