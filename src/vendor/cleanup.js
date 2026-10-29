/*!
 * cleanup.js  -  analysis engine for "Audio cleanup" in Video Redline (video-redline.html).
 *
 * Turns a word-level transcript (plus the silences and unrecognised sounds found in the
 * audio) into a list of CUT CANDIDATES: dead space, ums and ers, stutters, repeated words,
 * false starts and other non-word sounds. Confident candidates are marked "auto" (the page
 * applies them as cut markers); unsure ones are marked "review" (the page queues them with a
 * plain-language explanation so the user can Accept or Reject).
 *
 * Works in Node (module.exports) and in a plain browser <script> (global Cleanup).
 * No DOM, no network, no dependencies, no eval, ES2019 only, no regex look-behind
 * and no unicode property escapes (Safari 15 safe), ASCII-only source.
 *
 * CANONICAL TRANSCRIPT (what the helper script writes)
 *   { format:"video-review-transcript", version:1,
 *     video:{ name, duration }, engines:{ parakeet, whisper, audio },
 *     words:   [ { w, s, e, c, src } ],       seconds; c 0..1; src "parakeet"|"whisper"|"both"
 *     silences:[ { s, e } ],                  quiet regions (>= 0.3 s)
 *     sounds:  [ { s, e, kind, c, db } ] }    audible regions no engine turned into a word
 *                                             kind: "voiced"|"noise"|"breath"|"click"
 *
 * PUBLIC API
 *   Cleanup.DEFAULTS
 *   Cleanup.parseTranscript(text)            -> { transcript, format, warnings }   (throws a friendly Error)
 *   Cleanup.validateTranscript(obj)          -> { ok, errors, warnings }
 *   Cleanup.analyze(transcript, params)      -> { candidates, stats, warnings }
 *   Cleanup.mergeCuts(ranges, { gap })       -> merged [{start,end}]
 *   Cleanup.wordsInRange(transcript, a, b)   -> indices into transcript.words
 *   Cleanup.describeKind(kind)               -> { label, help }
 *   Cleanup.formatTime(seconds)              -> "m:ss.cc" or "h:mm:ss.cc"
 *   Cleanup.KINDS, Cleanup.version
 *
 * CANDIDATE
 *   { id, kind, start, end, text, confidence, status:"auto"|"review", reason, src:[...], words:[...] }
 *   start/end are the exact range to cut (seconds, rounded to milliseconds, already padded).
 *   words are indices into transcript.words (the array that was passed in).
 *   Optional (added in 1.1.0, a page may ignore it): partial:true = only the start of the listed word is cut
 *   (a stutter that the engine wrote as one joined word, "wh-what"); the cut point is an estimate.
 *
 * Every range in the output is non-overlapping (when two rules claim the same time, the
 * higher-confidence candidate is kept). Candidates are sorted by start.
 *
 * HOW EACH KIND IS DECIDED (all numbers are tunable through params, see DEFAULTS)
 *   dead-space   gap between two words (or video start / end) longer than minGap. Cut =
 *                [prev.end + keepPause/2, next.start - keepPause/2], then pad. Confidence rises with
 *                the share of the cut covered by silences[], falls for sounds[] inside it and at the
 *                very start/end of the video. Without any audio information (SRT, plain Whisper) dead
 *                space is capped below the auto line.
 *                Always "review" (never auto): a gap with a click, noise, voiced sound or loud/long breath
 *                inside, the very start or end of the video, and any gap over longGap. A soft breath of
 *                ordinary length inside a pause counts as quiet and goes away with the pause. From softGap
 *                (3 s) up to longGap (6 s) the confidence glides down instead of falling off a cliff at
 *                one exact length (a silent wait of 3 to 5 s is the most common thing a viewer needs).
 *                The gap is measured once the fillers that will be cut are taken out: "pause + um +
 *                pause" is one pause, trimmed on both sides of the um (up to three candidates side by side).
 *   filler       word in params.fillers (or a Whisper-only, um-like, non-dictionary spelling such as
 *                "ummmm"). Real words ("like", "so", "you know") are never fillers unless the user
 *                adds them, and then they are always "review". "mm" right after a number is the unit
 *                millimetre, not a filler. Confidence = engine confidence, engine agreement (both >
 *                Parakeet > Whisper-only) and audio evidence, combined as log-odds. The silence
 *                list the helper writes has the part under every word taken out, so a word that sits
 *                between two silences gets no audio bonus (and no "audio is not silent" claim).
 *   repeat       the same word again within stutterWindow: keep the LAST, cut the rest. Emphasis
 *                ("very very"), grammar ("that that"), numbers (digits or spelled out), spelled letters,
 *                keys and buttons ("Next, Next", "Tab Tab"), three or more copies of a content word, copies
 *                with a comma or a clear pause between them are "review". A full stop, "?" or "!" after a
 *                word ends the sentence: the next sentence is never a restart. "so... so" is review.
 *   stutter      a fragment before the finished word: "wh- what", "ex excel", "I I'm". Keep the last.
 *                Guess-based rules, always "review": a short word that only ONE engine heard right before
 *                a word with the same first letter within 0.5 s ("Pip Pivot"; needs both engines); a short
 *                unsure fragment; a stutter written as one joined word ("I-I-I", "wh-what").
 *   false-start  "click the click on ...": always "review". Needs a clear restart pattern. Also
 *                "Pull the ... drag the region" (a different first word, same shape; weak, 0.55).
 *   non-word     a sound in sounds[] that no word covers and that lasts at least minSound. Soft breaths
 *                shorter than minBreath (0.45 s) are ordinary and ignored; includeBreaths:false = no breaths.
 *   Candidates built from subtitle files (approximate timing) are all "review".
 *
 * WHERE A CUT STARTS AND ENDS (1.1.0)
 *   A word's reported start is often late (up to about 0.1 s after a short gap), so a cut that ends at "the next
 *   word's start - pad" can bite the first syllable of the word that stays. When a repeat, stutter or false start is
 *   followed by a kept word, the cut ends at the edge of a measured silence if there is one, and otherwise
 *   60% of the gap (at most 0.12 s) before the reported start. A cut that starts after a short gap
 *   (0.06 to 0.25 s) starts up to 40% of that gap (at most 0.08 s) before the first removed word, for the same reason.
 *   Every cut is finally kept at least `pad` away from every word that no candidate cuts (overlapping input).
 *
 * PARAMS added in 1.1.0 (all optional; garbage values fall back to the default)
 *   includeBreaths (true), minBreath (0.45 s), softGap (3 s). minCut is at least 0.005 s. minNoise (0.3 s, added in
 *   1.1.1): "noise" and "click" sounds shorter than this are ignored (mouse and keyboard taps). params.fillers must be a
 *   list or a comma separated string (null, a number, an object or a boolean mean "the default list").
 *   Times in milliseconds in a Whisper JSON or word list file are detected (a word cannot last 20 s) and converted.
 *
 * The text and reason fields contain words from the transcript: they are stripped of angle
 * brackets and quotes, but still insert them with textContent (or escape them), never innerHTML.
 *
 * VERSIONS
 *   1.2.1  words only: the product is called Video Redline, so the two messages that name it (a file that is not a transcript,
 *          and another kind of Video Redline file) say so. Nothing else changed: the same candidates, the same numbers, the
 *          same API. (The file format names video-review-transcript, video-review-session and video-review-library are
 *          the names inside the files and stay as they are.)
 *   1.2.0  cleanup levels (careful / balanced / thorough), see PRESETS and LEVELS.
 *   1.1.x  see the notes under PARAMS and WHERE A CUT STARTS AND ENDS above.
 */
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    root.Cleanup = factory();
  }
}(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  var VERSION = '1.2.1';
  var EPS = 1e-9;
  var KINDS = ['dead-space', 'filler', 'stutter', 'repeat', 'false-start', 'non-word'];
  var PRIORITY = { 'filler': 0, 'stutter': 1, 'repeat': 2, 'false-start': 3, 'non-word': 4, 'dead-space': 5 };
  var SOUND_KINDS = setOf('voiced noise breath click');
  var SRC_VALUES = setOf('parakeet whisper both other');
  var MAX_ERRORS = 25;
  var CUT_MARK = '\u0001'; // placeholder inside reason strings: replaced by the final "Cuts m:ss to m:ss" sentence

  /* ------------------------------------------------------------------ parameters */
  var DEFAULTS = {
    minGap: 0.8,           // silence longer than this between two words is dead space (seconds)
    keepPause: 0.35,       // natural pause left in place when cutting dead space
    fillers: ['um', 'uh', 'er', 'erm', 'ah', 'hmm', 'mm', 'mhm', 'uhm', 'umm', 'uhh', 'eh',
      'uhmm', 'err', 'ehm', 'ehh', 'ahh', 'ahm', 'hm', 'mmhmm'],
    stutterWindow: 1.0,    // a repeat must start within this many seconds after the previous word ended
    autoThreshold: 0.85,   // confidence at or above this = status "auto"
    minCut: 0.08,          // ignore cuts shorter than this (seconds, after padding)
    includeNonWords: true,
    includeStutters: true, // stutters and repeated words
    includeFillers: true,
    includeDeadSpace: true,
    includeFalseStarts: true, // only used when includeStutters is on
    pad: 0.02,             // seconds trimmed inside each cut edge so word edges are not clipped
    longGap: 6,            // a silent gap longer than this is always left for review (maybe waiting for a program)
    minSound: 0.15,        // non-word sounds shorter than this are ignored
    longSound: 0.6,        // a breath/noise longer than this is "long" (can be auto)
    maxNonWord: 3,         // a non-word sound longer than this is always left for review
    loudDb: -20,           // a sound at or above this level (dB) counts as loud
    longFiller: 1.2,       // a filler longer than this is suspicious (always review)
    // --- added in 1.1.0 (all optional) ---
    includeBreaths: true,  // false = never report breaths (and never let a breath lower the confidence of a pause)
    minBreath: 0.45,       // a soft breath shorter than this is ordinary and is ignored (long or loud ones are still reported)
    softGap: 3,            // a silent gap longer than this loses confidence step by step and reaches "review" before longGap
    // --- added after a test on a real screen recording (1.1.1) ---
    minNoise: 0.3,         // a "noise" or "click" sound shorter than this is a mouse or keyboard tap, not something to cut: ignored
    // --- 1.2.0: cleanup levels (see PRESETS). 'careful' is the behaviour of 1.1.x. Also minNoise (1.1.1). ---
    level: 'careful',
    quietSounds: false,    // true = short soft sounds inside a pause (breath, click, a tap of the keyboard) do not hold the pause back for review
    quietSoundMax: 0.5,    // ... "short" means at most this many seconds (a voiced sound, a possibly missed word, always holds it back)
    autoEdges: false       // true = a silent start or end of the video can be applied without asking
  };

  // A level only changes the defaults of the params below; anything the caller sets explicitly still wins.
  var PRESETS = {
    careful: {},
    balanced: { softGap: 5, longGap: 10, minNoise: 0.6, minBreath: 0.6, quietSounds: true, autoEdges: true },
    thorough: { softGap: 10, longGap: 20, minNoise: 1.0, minBreath: 0.8, quietSounds: true, autoEdges: true, autoThreshold: 0.8 }
  };

  /* ------------------------------------------------------------------ small helpers */
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function num(x, d) {
    var n = NaN;
    if (typeof x === 'number') n = x;
    else if (typeof x === 'string' && x.trim() !== '') n = Number(x);
    return isFinite(n) ? n : d;
  }
  function bool(x, d) {
    if (x === undefined || x === null) return d;
    if (typeof x === 'string') return !/^(false|0|no|off|)$/i.test(x.trim());
    return !!x;
  }
  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }
  function r2(x) { return Math.round(x * 100) / 100; }
  function r3(x) { return Math.round(x * 1000) / 1000; }
  function setOf(str) {
    var o = Object.create(null), a = str.split(/\s+/);
    for (var i = 0; i < a.length; i++) if (a[i]) o[a[i]] = 1;
    return o;
  }

  function formatTime(t) {
    t = Number(t);
    if (!isFinite(t) || t < 0) t = 0;
    var cs = Math.round(t * 100);
    var h = Math.floor(cs / 360000); cs -= h * 360000;
    var m = Math.floor(cs / 6000); cs -= m * 6000;
    var s = Math.floor(cs / 100); cs -= s * 100;
    var tail = (s < 10 ? '0' : '') + s + '.' + (cs < 10 ? '0' : '') + cs;
    return h > 0 ? h + ':' + (m < 10 ? '0' : '') + m + ':' + tail : m + ':' + tail;
  }
  function logit(p) { p = clamp(p, 0.02, 0.98); return Math.log(p / (1 - p)); }
  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

  /* "Teach it your ums": how much a sound's fingerprint (46 numbers the helper measures, see tools/vrt_teach.py) looks like the
     person's own ums, 0 to 1. `model` is what the helper trained (GET /teach/model). null when the model or the fingerprint do not fit.
     The arithmetic is the same as score() in vrt_teach.py (a test checks that the two agree). */
  function scoreFingerprint(model, fp) {
    if (!isObj(model) || !Array.isArray(fp) || !Array.isArray(model.mean) || !Array.isArray(model.std)) return null;
    var n = fp.length, i;
    if (n < 1 || model.features !== n || model.mean.length !== n || model.std.length !== n) return null;
    var z = new Array(n);
    for (i = 0; i < n; i++) {
      var v = num(fp[i], NaN), sd = num(model.std[i], NaN), mu = num(model.mean[i], NaN);
      if (!isFinite(v) || !isFinite(sd) || !isFinite(mu) || sd <= 0) return null;
      z[i] = clamp((v - mu) / sd, -6, 6);
    }
    if (model.kind === 'two-class') {
      if (!Array.isArray(model.w) || model.w.length !== n) return null;
      var s = num(model.b, 0);
      for (i = 0; i < n; i++) s += z[i] * num(model.w[i], 0);
      return sigmoid(clamp(s, -30, 30));
    }
    if (model.kind === 'one-class') {
      var d2 = 0, edge = num(model.edge, NaN), slope = num(model.slope, NaN);
      if (!isFinite(edge) || edge <= 0 || !isFinite(slope)) return null;
      for (i = 0; i < n; i++) d2 += z[i] * z[i];
      return sigmoid(clamp(-(d2 / n / edge - 1) * slope, -30, 30));
    }
    return null;
  }
  function fmtDur(x) { return String(Math.round(x * 100) / 100); }
  function q(s) { return '\u201C' + s + '\u201D'; }
  function cutLine(a, b) { return 'Cuts ' + formatTime(a) + ' to ' + formatTime(b) + ' (' + fmtDur(b - a) + ' s).'; }
  function times(n) { return n === 2 ? 'twice' : n + ' times'; }

  /* ------------------------------------------------------------------ text normalising */
  // Characters stripped from the edges of a word: ASCII punctuation, Latin-1 punctuation,
  // general/CJK punctuation, music notes. Letters, digits and everything else stay.
  var EDGE_L = /^[\s!-\/:-@\[-`{-~\u00A1-\u00BF\u2000-\u206F\u2E00-\u2E7F\u3000-\u303F\u266A\u266B\uFE50-\uFE6F\uFF01-\uFF0F\uFF1A-\uFF20]+/;
  var EDGE_R = /[\s!-\/:-@\[-`{-~\u00A1-\u00BF\u2000-\u206F\u2E00-\u2E7F\u3000-\u303F\u266A\u266B\uFE50-\uFE6F\uFF01-\uFF0F\uFF1A-\uFF20]+$/;
  // "has a letter or a digit": Latin, Greek, Cyrillic and other alphabets, kana, CJK, Hangul, full-width Latin
  var LEX = /[0-9A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02AF\u0370-\u1FFF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF\uFF21-\uFF3A\uFF41-\uFF5A]/;
  var FRAG_END = /[0-9A-Za-z\u00C0-\u02AF\u0370-\u1FFF][\-\u2010-\u2015]+["'\u201C\u201D\u2018\u2019)\]]*$/;

  function stripEdges(raw) {
    return String(raw).replace(/[\u2018\u2019\u02BC\u00B4`]/g, "'").replace(EDGE_L, '').replace(EDGE_R, '');
  }
  function lexical(s) { return LEX.test(s); }
  function squeeze(s) { return s.replace(/(.)\1{2,}/g, '$1$1'); }
  // Key used to match filler lists: lower case, no inner hyphen/apostrophe/dot, runs of 3+ letters squeezed to 2
  function fillerKey(n) { return squeeze(n.replace(/[\-'.\u2010-\u2015]/g, '')); }

  /* ------------------------------------------------------------------ word lists */
  var TWO = setOf('ab ad ah am an as at aw ax ay be by do eh em en er go ha he hi hm ho id if in is it la lo ma me mm mu my no of oh ok on op or ow ox oy pa pi re so to uh um un up us we ya ye yo');
  var THREE = setOf('the and for are but not you all any can had her was one our out day get has him his how man new now old see two way who boy did its let put say she too use add ask big box bus buy car cut end eye far few fix got hit hot job key kid law lay leg lot low map may mix net off oil own pay per pen pop red row run set sit six sun tab tax ten tip top try van via war web why win yes yet zip app bar bit bug cap col sum max min avg bad bed bag bat bet cup dad dog dry due ear eat egg fan fat fun gas gun guy hat hey ice ill jam joy lie lip log mad mom mud nor nod nut odd pad pan pie pig pin pot raw ray rid rub sad saw sea sew shy sir sky son sue tag tie toe ton toy tub wet wow zoo pdf csv doc xls ppt png jpg gif url api sql css');
  // words that are normal to say twice in a row ("very very", "no no no", "that that", "had had")
  var EMPHASIS = setOf('very no yes yeah yep nope really so bye ha more now right okay ok sure well hey never please little many far much again go come wait stop hello hi good big long hot cold fast slow blah la na boom oh ooh wow');
  var GRAMMAR = setOf('that had');
  // words for keys, buttons and menu steps: tutorials say these several times in a row on purpose
  // ("Next, Next, Next", "press Tab Tab", "down down down"), so a repeat is never auto-cut
  var NAV = setOf('next back previous tab down up left right enter return delete undo redo plus minus click press space backspace escape shift ctrl control alt option command cmd home end insert paste copy cut save finish continue apply done close scroll twice');
  // spelled-out numbers: "twenty twenty four", "one one" are values, not stutters
  var NUMWORDS = setOf('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion');
  function isNumberWord(n) {
    if (NUMWORDS[n]) return true;
    if (n.indexOf('-') < 0) return false;
    var parts = n.split('-');
    for (var i = 0; i < parts.length; i++) if (!NUMWORDS[parts[i]]) return false;
    return true;
  }
  // small function words: repeating one of these is almost always a stutter
  var FUNC = setOf('a an the i we you he she it they to of in on at by for with and or but is are was be as so if that this me my us');
  // a phrase cannot normally end on one of these: if it does and then restarts, it was abandoned
  var DANGLING = setOf('the a an to of in on at by for with from into onto your my our their its');
  // pronouns that people restart as a contraction: "I I'm", "we we're", "it it's"
  var CONTR = setOf('i you he she it we they that there what who here let how where when why this');
  // um-like sounds that Whisper writes in many spellings. Used only for Whisper-only words
  // that are not in the built-in list (for example "ummmmm" or "aaahm").
  var UMLIKE = /^(?:u+h+m*|u+m+h*|a+h+m*|e+h+m*|e+r+m*|h+m+|m{2,}|m+h+m*)$/;

  function isRealShort(n) { return n.length <= 2 ? !!TWO[n] : !!THREE[n]; }

  var TAIL_QUOTES = /["'\u201C\u201D\u2018\u2019)\]]+$/;
  var ELLIPSIS_END = /(?:\.{2,}|\u2026)$/;
  var SENT_END = /[.!?;:\u3002\uFF01\uFF1F]$/;

  // A word the engine wrote with inner hyphens that looks like a stutter ("wh-what", "I-I-I", "the-the", "s-s-so"):
  // returns the share of the word's time taken by the repeated start (0 = not a stutter). Compound words
  // ("e-mail", "well-known", "re-read", "up-to-date") are not stutters: each part before the last must repeat or start the next one.
  function joinedFraction(n) {
    if (n.indexOf('-') < 0 && !/[\u2010-\u2015]/.test(n)) return 0;
    var parts = n.split(/[\-\u2010-\u2015]+/), m = parts.length, i, letters = 0, early = 0;
    if (m < 2 || m > 8) return 0;
    for (i = 0; i < m; i++) {
      if (!/^[a-z](?:[a-z']*[a-z])?$/.test(parts[i])) return 0; // letters only: numbers, dates and codes are left alone
      letters += parts[i].length;
      if (i < m - 1) early += parts[i].length;
    }
    for (i = 0; i < m - 1; i++) {
      var p = parts[i], nx = parts[i + 1], ok;
      if (p === nx) ok = !EMPHASIS[p] && !NAV[p];               // "the-the"; but "bye-bye", "no-no", "so-so" are real words
      else if (CONTR[p] && nx.indexOf(p + "'") === 0) ok = true; // "I-I'm"
      else ok = p.length <= 3 && nx.length > p.length && nx.indexOf(p) === 0 && p !== 'a' && p !== 'i' && (p.length === 1 || !isRealShort(p));
      if (!ok) return 0;
    }
    return Math.min(0.75, (m - 1) / m, early / letters);
  }

  var DEFAULT_KEYS = (function () {
    var o = Object.create(null);
    for (var i = 0; i < DEFAULTS.fillers.length; i++) o[fillerKey(stripEdges(DEFAULTS.fillers[i]).toLowerCase())] = 1;
    return o;
  }());

  /* ------------------------------------------------------------------ interval index */
  // items sorted by .s; pm[i] = largest .e among items[0..i] (non-decreasing, so we can binary-search)
  function makeIndex(items) {
    var pm = new Array(items.length), m = -Infinity;
    for (var i = 0; i < items.length; i++) { if (items[i].e > m) m = items[i].e; pm[i] = m; }
    return { items: items, pm: pm };
  }
  function firstAfter(pm, a) {
    var lo = 0, hi = pm.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (pm[mid] > a) hi = mid; else lo = mid + 1; }
    return lo;
  }
  function forOverlaps(ix, a, b, fn) {
    var items = ix.items;
    for (var i = firstAfter(ix.pm, a); i < items.length && items[i].s < b; i++) {
      if (items[i].e > a) fn(items[i], i);
    }
  }
  function coverage(ix, a, b) {
    if (!(b > a)) return 0;
    var tot = 0;
    forOverlaps(ix, a, b, function (x) { tot += Math.min(x.e, b) - Math.max(x.s, a); });
    return clamp(tot / (b - a), 0, 1);
  }

  function cleanSilences(list) {
    var arr = [];
    if (Array.isArray(list)) {
      for (var i = 0; i < list.length; i++) {
        var x = list[i];
        if (!isObj(x)) continue;
        var s = num(x.s, NaN), e = num(x.e, NaN);
        if (!isFinite(s) || !isFinite(e) || e <= s || e <= 0) continue;
        arr.push({ s: Math.max(0, s), e: e });
      }
    }
    arr.sort(function (a, b) { return a.s - b.s || a.e - b.e; });
    var out = [];
    for (var j = 0; j < arr.length; j++) {
      var cur = out[out.length - 1];
      if (cur && arr[j].s <= cur.e + 1e-6) { if (arr[j].e > cur.e) cur.e = arr[j].e; }
      else out.push({ s: arr[j].s, e: arr[j].e });
    }
    return out;
  }
  function cleanSounds(list) {
    var arr = [];
    if (Array.isArray(list)) {
      for (var i = 0; i < list.length; i++) {
        var x = list[i];
        if (!isObj(x)) continue;
        var s = num(x.s, NaN), e = num(x.e, NaN);
        if (!isFinite(s) || !isFinite(e) || e <= s || e <= 0) continue;
        var kind = typeof x.kind === 'string' ? x.kind.trim().toLowerCase() : '';
        if (!SOUND_KINDS[kind]) kind = 'noise';
        var c = num(x.c, NaN);
        arr.push({ s: Math.max(0, s), e: e, kind: kind, c: isFinite(c) ? clamp(c > 1.5 && c <= 100 ? c / 100 : c, 0, 1) : 0.5, db: num(x.db, null) });
      }
    }
    arr.sort(function (a, b) { return a.s - b.s || a.e - b.e; });
    return arr;
  }

  /* ------------------------------------------------------------------ parameters */
  function normaliseFillerList(list) {
    if (typeof list === 'string') list = list.split(/[,\n;]/);
    var singles = Object.create(null), phrases = [], any = false, infer = false;
    if (!Array.isArray(list)) list = [];
    for (var i = 0; i < list.length; i++) {
      if (typeof list[i] !== 'string') continue;
      var parts = list[i].toLowerCase().split(/\s+/), keys = [];
      for (var j = 0; j < parts.length; j++) {
        var n = stripEdges(parts[j]);
        if (lexical(n)) keys.push(fillerKey(n));
      }
      if (keys.length === 1) { singles[keys[0]] = 1; any = true; if (UMLIKE.test(keys[0])) infer = true; }
      else if (keys.length > 1) { phrases.push(keys); any = true; }
    }
    phrases.sort(function (a, b) { return b.length - a.length; }); // longest phrase first
    return { singles: singles, phrases: phrases, infer: infer, any: any };
  }

  function resolveParams(p) {
    p = isObj(p) ? p : {};
    var lvl = typeof p.level === 'string' && Object.prototype.hasOwnProperty.call(PRESETS, p.level) ? p.level : 'careful';
    var d = {}, k0, o = {};
    for (k0 in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k0)) d[k0] = DEFAULTS[k0];
    for (k0 in PRESETS[lvl]) if (Object.prototype.hasOwnProperty.call(PRESETS[lvl], k0)) d[k0] = PRESETS[lvl][k0];
    o.level = lvl;
    o.quietSounds = bool(p.quietSounds, d.quietSounds);
    o.quietSoundMax = Math.max(0, num(p.quietSoundMax, d.quietSoundMax));
    o.autoEdges = bool(p.autoEdges, d.autoEdges);
    o.minGap = Math.max(0.05, num(p.minGap, d.minGap));
    o.keepPause = Math.max(0, num(p.keepPause, d.keepPause));
    o.stutterWindow = Math.max(0, num(p.stutterWindow, d.stutterWindow));
    o.autoThreshold = clamp(num(p.autoThreshold, d.autoThreshold), 0, 1);
    o.minCut = Math.max(0.005, num(p.minCut, d.minCut)); // a zero-length cut is never a useful candidate
    o.pad = Math.max(0, num(p.pad, d.pad));
    o.longGap = Math.max(o.minGap, num(p.longGap, d.longGap));
    // softGap: where confidence starts to glide down towards longGap. A caller who moved longGap on its own (without softGap)
    // asked for a different cut-off line, so no glide is applied before it.
    if (isFinite(num(p.softGap, NaN))) o.softGap = clamp(num(p.softGap, d.softGap), 0, o.longGap);
    else if (isFinite(num(p.longGap, NaN)) && num(p.longGap, NaN) !== d.longGap) o.softGap = o.longGap;
    else o.softGap = Math.min(d.softGap, o.longGap);
    o.minSound = Math.max(0.01, num(p.minSound, d.minSound));
    o.longSound = Math.max(0, num(p.longSound, d.longSound));
    o.maxNonWord = Math.max(0, num(p.maxNonWord, d.maxNonWord));
    o.loudDb = num(p.loudDb, d.loudDb);
    o.longFiller = Math.max(0.1, num(p.longFiller, d.longFiller));
    o.minBreath = Math.max(0, num(p.minBreath, d.minBreath));
    o.minNoise = Math.max(0, num(p.minNoise, d.minNoise));
    o.includeBreaths = bool(p.includeBreaths, d.includeBreaths);
    o.includeNonWords = bool(p.includeNonWords, d.includeNonWords);
    o.includeStutters = bool(p.includeStutters, d.includeStutters);
    o.includeFillers = bool(p.includeFillers, d.includeFillers);
    o.includeDeadSpace = bool(p.includeDeadSpace, d.includeDeadSpace);
    o.includeFalseStarts = bool(p.includeFalseStarts, d.includeFalseStarts);
    o.learned = isObj(p.learned) ? p.learned : null;      // the trained "my ums" model (see scoreFingerprint); null = not used
    // only a list (array) or a comma separated string changes the filler list; null, a number, an object or a
    // boolean fall back to the defaults like any other bad value (an explicit [] or '' still means "no fillers")
    o.filler = normaliseFillerList(Array.isArray(p.fillers) || typeof p.fillers === 'string' ? p.fillers : d.fillers);
    return o;
  }

  /* ------------------------------------------------------------------ context: clean tokens + indexes */
  function srcOf(x) { x = typeof x === 'string' ? x.trim().toLowerCase() : ''; return SRC_VALUES[x] ? x : 'other'; }

  function buildContext(transcript, P, warnings) {
    var tr = isObj(transcript) ? transcript : {};
    var rawWords = Array.isArray(tr.words) ? tr.words : [];
    var T = [], skipped = 0, i;
    for (i = 0; i < rawWords.length; i++) {
      var w = rawWords[i];
      if (!isObj(w)) { skipped++; continue; }
      var s = num(w.s, NaN), e = num(w.e, NaN);
      if (!isFinite(s) || !isFinite(e)) { skipped++; continue; }
      if (e < s) e = s;
      if (e <= 0) { skipped++; continue; }
      if (s < 0) s = 0;
      var text = w.w === undefined || w.w === null ? '' : String(w.w).trim();
      var base = stripEdges(text).replace(/[<>"`\x00-\x1F]/g, ''); // shown in reasons: never carry markup characters
      var n = base.toLowerCase();
      if (!lexical(n)) continue; // punctuation only: not a word
      var isFrag = FRAG_END.test(text);
      var disp = isFrag ? base + '-' : base; // a cut-off word keeps its dash: "wh-"
      var c = num(w.c, NaN);
      if (isFinite(c) && c > 1.5 && c <= 100) c = c / 100;
      var cKnown = isFinite(c);
      var tail = text.replace(TAIL_QUOTES, '');
      var ellipsis = ELLIPSIS_END.test(tail);
      T.push({
        i: i, w: text, disp: disp, n: n, key: fillerKey(n), s: s, e: e,
        c: cKnown ? clamp(c, 0, 1) : 0.7, cKnown: cKnown, src: srcOf(w.src),
        fp: Array.isArray(w.fp) && w.fp.length > 0 && w.fp.length <= 128 ? w.fp : null,   // the helper's fingerprint of an um-like sound
        frag: isFrag, isNum: /[0-9]/.test(n) || isNumberWord(n),
        caps: base.length >= 2 && base.length <= 3 && base === base.toUpperCase() && base !== base.toLowerCase(),
        // punctuation the engine wrote after the word: a full stop, "?" or "!" ends the sentence, so the next word
        // is a new sentence and never a restart; "..." trails off (a hesitation, still only for review)
        endsSent: !isFrag && !ellipsis && SENT_END.test(tail), trails: !isFrag && ellipsis,
        comma: !isFrag && /,$/.test(tail),
        cap: /^[A-Z]/.test(base) && base !== base.toUpperCase() && base.length > 1,
        join: isFrag ? 0 : joinedFraction(n),
        pos: 0, filler: false, claimed: false, cutFiller: false
      });
    }
    if (skipped) warnings.push(skipped + ' word' + (skipped === 1 ? ' was' : 's were') + ' ignored because its start or end time was missing or not a number.');

    var sorted = true;
    for (i = 1; i < T.length; i++) {
      if (T[i].s < T[i - 1].s || (T[i].s === T[i - 1].s && T[i].e < T[i - 1].e)) { sorted = false; break; }
    }
    if (!sorted) T.sort(function (a, b) { return a.s - b.s || a.e - b.e || a.i - b.i; });

    // Two engines (or a repeated export) can list the same word at the same time: keep one.
    var D = [], dups = 0;
    for (i = 0; i < T.length; i++) {
      var t = T[i], dup = null;
      for (var j = D.length - 1; j >= 0 && j >= D.length - 8; j--) {
        var u = D[j];
        if (t.s - u.s > 0.01) break;
        if (u.n === t.n && Math.abs(t.e - u.e) <= 0.01) { dup = u; break; }
      }
      if (dup) {
        dups++;
        if (dup.src !== t.src && dup.src !== 'other' && t.src !== 'other') dup.src = 'both'; // one engine each: both heard it
        if (t.cKnown && (!dup.cKnown || t.c > dup.c)) { dup.c = t.c; dup.cKnown = true; }
      } else D.push(t);
    }
    if (dups) warnings.push(dups + ' duplicate word' + (dups === 1 ? '' : 's') + ' at the same time ' + (dups === 1 ? 'was' : 'were') + ' merged.');
    for (i = 0; i < D.length; i++) D[i].pos = i;

    var maxEnd = 0;
    for (i = 0; i < D.length; i++) if (D[i].e > maxEnd) maxEnd = D[i].e;
    var declared = isObj(tr.video) ? num(tr.video.duration, NaN) : NaN;
    var duration = maxEnd, durationKnown = false;
    if (isFinite(declared) && declared > 0) {
      if (declared >= maxEnd - 0.05) { duration = Math.max(declared, maxEnd); durationKnown = true; }
      else warnings.push('The video length in the file (' + fmtDur(declared) + ' s) is shorter than the last word, so it was ignored.');
    }

    var sil = cleanSilences(tr.silences), snd = cleanSounds(tr.sounds);
    var hasAudio;
    if (tr.hasAudio !== undefined && tr.hasAudio !== null) hasAudio = !!tr.hasAudio;
    else hasAudio = sil.length > 0 || snd.length > 0 || (isObj(tr.engines) && typeof tr.engines.audio === 'string' && tr.engines.audio.trim() !== '');

    var eng = isObj(tr.engines) ? tr.engines : {};
    return {
      P: P, T: D, C: [], duration: duration, durationKnown: durationKnown, hasAudio: hasAudio,
      approximate: !!tr.approximate, skipped: skipped,
      // did each speech engine run? 'yes' (named), 'no' (empty or "not used"), '?' (the file does not say)
      eng: { parakeet: engineState(eng.parakeet), whisper: engineState(eng.whisper) },
      silIx: makeIndex(sil), soundIx: makeIndex(snd), wordIx: makeIndex(D), deadRanges: [], fillerCuts: []
    };
  }
  function engineState(v) {
    if (typeof v !== 'string') return '?';
    var t = v.trim();
    return t === '' || /^(not used|none|off|skipped|disabled|n\/a)\b/i.test(t) ? 'no' : 'yes';
  }

  /* ------------------------------------------------------------------ candidate plumbing */
  function srcSetOf(toks, extra) {
    var has = { parakeet: false, whisper: false, audio: false }, i;
    for (i = 0; i < toks.length; i++) {
      var s = toks[i].src;
      if (s === 'both') { has.parakeet = true; has.whisper = true; }
      else if (s === 'parakeet') has.parakeet = true;
      else if (s === 'whisper') has.whisper = true;
    }
    if (extra) has.audio = true;
    var out = [];
    if (has.parakeet) out.push('parakeet');
    if (has.whisper) out.push('whisper');
    if (has.audio) out.push('audio');
    return out;
  }
  function textOf(toks) {
    var a = [];
    for (var i = 0; i < toks.length; i++) a.push(toks[i].disp);
    return a.join(' ');
  }
  function idxOf(toks) {
    var a = [];
    for (var i = 0; i < toks.length; i++) a.push(toks[i].i);
    return a;
  }
  function limitRange(ctx, a, b) {
    var lo = Math.max(0, a), hi = ctx.durationKnown ? Math.min(ctx.duration, b) : b;
    return [r3(lo), r3(hi)];
  }

  // The range to cut when removing tokens chunk[0..n-1] that are followed by T[pos+1].
  // Starts just inside the first word; ends just inside the next word, unless a long gap follows
  // (then dead-space handling owns the gap, so we stop at the end of the removed word).
  function chunkRange(ctx, chunk) {
    var P = ctx.P, first = chunk[0], last = chunk[chunk.length - 1];
    var next = ctx.T[last.pos + 1], prev = ctx.T[first.pos - 1];
    var end = next && next.s - last.e <= P.minGap + 1e-6 ? cutEndBefore(ctx, last, next) : last.e - P.pad;
    return limitRange(ctx, cutStartAfter(ctx, first, prev), end);
  }
  // The latest silence that ends in [lo, hi] and ends after `after`, or null. Silences are measured on the audio itself,
  // so the end of one is where the sound really starts (the helper writes only quiet stretches of 0.3 s or more).
  function silenceEndNear(ctx, lo, hi, after) {
    var best = null;
    forOverlaps(ctx.silIx, lo - 0.001, hi + 0.001, function (x) {
      if (x.e >= lo && x.e <= hi && x.e > after && (best === null || x.e > best)) best = x.e;
    });
    return best;
  }
  // Where a cut may end when the word at `next` stays. The engines often report the start of a word that follows a short gap
  // up to about 0.1 s late, so "next.s - pad" can remove the first syllable of the word that is meant to stay. The cut ends
  // at a measured silence edge when the audio gives one; otherwise it stops inside the gap, 60% of the gap (at most 0.12 s)
  // before the reported start.
  function cutEndBefore(ctx, last, next) {
    var P = ctx.P, g = next.s - last.e;
    if (ctx.hasAudio) {
      var se = silenceEndNear(ctx, next.s - 0.15, next.s + 0.02, last.e);
      if (se !== null) return Math.min(next.s, se) - P.pad;
    }
    return next.s - Math.max(P.pad, Math.min(0.6 * g, 0.12));
  }
  // The same idea for the start edge: the first word that is cut can really begin earlier than reported, which would leave
  // a loud stub of it. Only for a short gap before the word (0.06 to 0.25 s) that no measured silence edge explains.
  function cutStartAfter(ctx, first, prev) {
    var P = ctx.P, plain = first.s + P.pad;
    if (!prev) return plain;
    var g = first.s - prev.e;
    if (g < 0.06 || g > 0.25) return plain;
    if (ctx.hasAudio && silenceEndNear(ctx, first.s - 0.15, first.s + 0.02, prev.e) !== null) return plain;
    return first.s - Math.min(0.4 * g, 0.08); // at most 40% of the gap, so the word before it keeps at least 60% of it
  }
  // Split removed tokens into runs that sit directly next to each other (no filler or long gap between)
  function chunksOf(ctx, toks) {
    var chunks = [], cur = [toks[0]];
    for (var k = 1; k < toks.length; k++) {
      var a = toks[k - 1], b = toks[k];
      if (b.pos === a.pos + 1 && b.s - a.e <= ctx.P.minGap + 1e-6) cur.push(b);
      else { chunks.push(cur); cur = [b]; }
    }
    chunks.push(cur);
    return chunks;
  }

  /* ------------------------------------------------------------------ fillers */
  function classifyFiller(tok, ctx) {
    var F = ctx.P.filler;
    if (tok.caps) return null; // "ER", "EM": almost certainly an abbreviation, not a filler
    if (tok.key === 'mm') { // "25 mm", "twenty five mm": the unit millimetre, not a hum
      var before = ctx.T[tok.pos - 1];
      if (before && before.isNum && tok.s - before.e <= 0.4) return null;
    }
    if (F.singles[tok.key]) {
      return { real: !DEFAULT_KEYS[tok.key] && !UMLIKE.test(tok.key) };
    }
    if (F.infer && (tok.src === 'whisper' || tok.src === 'other') && tok.key.length <= 7 &&
        !DEFAULT_KEYS[tok.key] && UMLIKE.test(tok.key)) {
      return { real: false, inferred: true };
    }
    return null;
  }

  // "X heard nothing here" is only said when X really ran: with --no-whisper or --no-parakeet (or a plain Whisper file) the
  // other engine never listened, so there is nothing to report about it.
  function enginePhrase(tok, ctx) {
    var pct = tok.cKnown && tok.src !== 'other' ? Math.round(tok.c * 100) + '% sure' : '';
    if (tok.src === 'whisper') return '(Whisper ' + (pct || 'did not give a confidence') + (ctx.eng.parakeet === 'yes' ? '; Parakeet heard nothing here' : '') + ')';
    if (tok.src === 'parakeet') return '(Parakeet ' + (pct || 'did not give a confidence') + (ctx.eng.whisper === 'yes' ? '; Whisper heard nothing here' : '') + ')';
    if (tok.src === 'both') return '(both Parakeet and Whisper heard it' + (pct ? ', ' + pct : '') + ')';
    return pct ? '(' + pct + ')' : '(from the transcript)';
  }

  // Does a measured silence end right before the word or start right after it? (see the note in makeFiller)
  function silenceBeside(ctx, tok) {
    var found = false;
    forOverlaps(ctx.silIx, tok.s - 0.07, tok.e + 0.07, function (x) {
      if ((x.e >= tok.s - 0.06 && x.e <= tok.s + 0.03) || (x.s >= tok.e - 0.03 && x.s <= tok.e + 0.06)) found = true;
    });
    return found;
  }

  function makeFiller(tok, cls, ctx) {
    var P = ctx.P, dur = tok.e - tok.s;
    var r = limitRange(ctx, tok.s + P.pad, tok.e - P.pad);
    if (r[1] - r[0] < P.minCut - EPS) return null;

    // Evidence is combined as log-odds: the engine's own confidence, how many engines agree,
    // and what the audio looks like at that moment.
    var force = false, audio = 'unknown';
    var z = logit(tok.c);
    if (tok.src === 'both') z += 1.0;
    else if (tok.src === 'whisper' && ctx.eng.parakeet !== 'no') z -= 0.3; // Parakeet listened and did not hear it
    // (when Parakeet never ran, nobody disagrees with Whisper, so there is nothing to subtract)

    if (ctx.hasAudio) {
      var voiced = 0;
      forOverlaps(ctx.soundIx, tok.s - 0.05, tok.e + 0.05, function (x) {
        if (x.kind === 'voiced') voiced += Math.min(x.e, tok.e + 0.05) - Math.max(x.s, tok.s - 0.05);
      });
      var sc = dur > 0 ? coverage(ctx.silIx, tok.s, tok.e) : 0;
      if (voiced > 0 && voiced >= Math.min(0.08, dur * 0.5)) { z += 1.2; audio = 'voiced'; }
      else if (sc >= 0.8) { z -= tok.src === 'both' ? 1.2 : 2.5; audio = 'silent'; }
      else if (sc >= 0.4) { z -= 0.6; audio = 'partly'; }
      else if (sc >= 0.1) { z += 0.3; audio = 'open'; }
      else if (silenceBeside(ctx, tok)) {
        // The helper removes the part of a quiet gap that lies under a word (transcribe.py silences_without_words), so a
        // word that sits exactly between two silences looks the same whether the audio under it is a real "um" or true
        // silence. That is no evidence either way: leave the confidence alone and do not claim anything about the audio.
      } else { z += 0.9; audio = 'open'; } // no quiet gap anywhere near: the audio is clearly active there
    } else if (tok.src === 'whisper') {
      z -= 0.3; // nothing to confirm a Whisper-only word
    }
    // What the person taught the tool (Teach it your ums). It can only hold a cut back: a sound that looks nothing like their ums
    // (a sound effect, a pop) loses up to 3 log-odds, and when it looks clearly unlike them it is never applied without asking (both
    // engines agreeing on a sound effect would otherwise still be sure enough); a sound that looks like an um adds nothing.
    var mine = null;
    if (P.learned && tok.fp) {
      var um = scoreFingerprint(P.learned, tok.fp);
      if (um !== null) {
        var lz = clamp(logit(um) * 0.8, -3, 0);
        if (lz < -0.05) { z += lz; mine = um; }
        if (um < 0.35) force = true;
      }
    }
    var conf = sigmoid(z);

    var parts = [];
    if (cls.real) {
      conf = Math.min(conf, 0.75); force = true;
      parts.push(q(tok.disp) + ' is a real word that is on your filler list, so it could be a normal part of the sentence. Please check before cutting it.');
    } else {
      var heard = 'Heard ' + q(tok.disp) + ' ' + enginePhrase(tok, ctx);
      if (audio === 'voiced') heard += ' with a voiced sound in the audio';
      else if (audio === 'open') heard += ' and the audio is not silent there';
      else if (audio === 'silent') heard += ', but the audio is silent at that moment, so it may be a mistake';
      else if (audio === 'partly') heard += ', but the audio is partly quiet there';
      else if (!ctx.hasAudio && tok.src === 'whisper') heard += '. The audio levels were not checked';
      parts.push(heard + '.');
      if (cls.inferred) parts.push('It is not on your filler list, but it is short and not a normal word, so it looks like an \u201Cum\u201D.');
    }
    if (mine !== null && mine < 0.5) {
      parts.push('It does not sound much like the ums you taught the tool (about ' + Math.max(1, Math.round(mine * 100)) + '% like them), so it could be a sound effect or another sound. Please listen first.');
    }
    if (dur > P.longFiller) {
      conf -= 0.2; force = true;
      parts.push('It lasts ' + fmtDur(dur) + ' s, which is long for a filler (a speech engine can stretch one over a pause), so please listen first.');
    }
    parts.push(CUT_MARK);
    var out = {
      kind: 'filler', start: r[0], end: r[1], text: tok.disp, confidence: conf, force: force,
      src: srcSetOf([tok], audio !== 'unknown'), words: [tok.i], reason: parts.join(' ')
    };
    if (mine !== null) out.mine = mine;
    return out;
  }

  function detectFillers(ctx, out) {
    var T = ctx.T, F = ctx.P.filler, P = ctx.P, i, k;
    var byFirst = Object.create(null);
    for (i = 0; i < F.phrases.length; i++) {
      var f = F.phrases[i][0];
      (byFirst[f] || (byFirst[f] = [])).push(F.phrases[i]);
    }
    for (i = 0; i < T.length; i++) {
      var tok = T[i];
      var list = byFirst[tok.key];
      if (list) {
        var matched = null;
        for (var p = 0; p < list.length && !matched; p++) {
          var ph = list[p];
          if (i + ph.length > T.length) continue;
          var ok = true;
          for (k = 1; k < ph.length; k++) {
            if (T[i + k].key !== ph[k] || T[i + k].s - T[i + k - 1].e > P.minGap + 1e-6) { ok = false; break; }
          }
          if (ok) matched = ph;
        }
        if (matched) {
          var toks = T.slice(i, i + matched.length);
          for (k = 0; k < toks.length; k++) toks[k].filler = true;
          var r = limitRange(ctx, toks[0].s + P.pad, toks[toks.length - 1].e - P.pad);
          if (r[1] - r[0] >= P.minCut - EPS) {
            var cc = 0;
            for (k = 0; k < toks.length; k++) cc += toks[k].c;
            cc /= toks.length;
            out.push({
              kind: 'filler', start: r[0], end: r[1], text: textOf(toks), confidence: Math.min(cc, 0.75), force: true,
              src: srcSetOf(toks, false), words: idxOf(toks),
              reason: q(textOf(toks)) + ' is a phrase on your filler list. It is made of real words, so it could be a normal part of the sentence. Please check before cutting it. ' + CUT_MARK
            });
          }
          i += matched.length - 1;
          continue;
        }
      }
      var cls = classifyFiller(tok, ctx);
      if (!cls) continue;
      tok.filler = true;
      var cand = makeFiller(tok, cls, ctx);
      if (cand) {
        out.push(cand);
        // A real "um" that is cut leaves its surroundings joined together: dead space is measured without it (see detectDeadSpace)
        if (!cls.real && !cand.force) { tok.cutFiller = true; ctx.fillerCuts.push({ pos: tok.pos, s: tok.s, e: tok.e, len: cand.end - cand.start, disp: tok.disp }); }
      }
    }
  }

  /* ------------------------------------------------------------------ stutters and repeats */
  function echo(a, b) {
    if (a.endsSent) return null; // a full stop, "?" or "!" ends the sentence: what follows is a new sentence, never a restart
    var r = null;
    if (a.n === b.n) r = { t: a.frag ? 'frag' : 'repeat' };
    else if (a.frag && b.n.length > a.n.length && b.n.indexOf(a.n) === 0) r = { t: 'frag' };
    else if (!a.frag && !a.isNum && !b.isNum && a.n.length >= 2 && a.n.length <= 3 &&
        b.n.length > a.n.length && b.n.indexOf(a.n) === 0 && b.n.charAt(a.n.length) !== "'" && !isRealShort(a.n)) {
      r = { t: 'frag', weak: a.n.length === 3 };
    } else if (CONTR[a.n] && b.n.indexOf(a.n + "'") === 0) r = { t: 'contr' };
    if (r && a.trails) r.trail = true; // "so... so": a hesitation or a trailing-off, so it is left for review
    return r;
  }

  function detectRepeats(ctx, out) {
    var C = ctx.C, P = ctx.P, i = 0;
    while (i < C.length - 1) {
      var run = [C[i]], rels = [], j = i;
      while (j + 1 < C.length) {
        var a = C[j], b = C[j + 1];
        if (b.s - a.e > P.stutterWindow + EPS) break;
        var rel = echo(a, b);
        if (!rel) break;
        run.push(b); rels.push(rel); j++;
      }
      if (run.length >= 2) { emitRun(ctx, run, rels, out); i = j; } else i++;
    }
  }

  function emitRun(ctx, run, rels, out) {
    var P = ctx.P, kept = run[run.length - 1], cutToks = run.slice(0, run.length - 1), k;
    var pure = true, weak = false, contr = false, trail = false, maxGap = 0;
    for (k = 0; k < rels.length; k++) {
      if (rels[k].t !== 'repeat') pure = false;
      if (rels[k].weak) weak = true;
      if (rels[k].t === 'contr') contr = true;
      if (rels[k].trail) trail = true;
      var g = run[k + 1].s - run[k].e;
      if (g > maxGap) maxGap = g;
    }
    var minC = 1, lowKnown = false, comma = false, allCap = true;
    for (k = 0; k < run.length; k++) {
      if (run[k].cKnown && run[k].c < minC) minC = run[k].c;
      if (run[k].cKnown && run[k].c < 0.5) lowKnown = true;
      if (k < run.length - 1 && run[k].comma) comma = true;
      if (!run[k].cap) allCap = false;
    }
    // a capitalised word in the middle of a sentence is usually a button, menu or feature name ("Next", "Pivot")
    var before = ctx.T[run[0].pos - 1];
    var uiName = allCap && !!before && !before.endsSent;
    var word = kept.disp, n = kept.n, count = run.length;
    var conf, force = false, why;
    var oneLetter = n.length === 1 && n !== 'i' && n !== 'a';
    var keepLast = 'Accept to keep only the last one; reject to keep ' + (count === 2 ? 'both' : 'them all') + '.';

    if (pure && (kept.isNum || EMPHASIS[n] || NAV[n] || GRAMMAR[n] || oneLetter)) {
      conf = 0.5; force = true;
      if (kept.isNum) why = 'The number ' + q(word) + ' is said ' + times(count) + ' in a row. That can be on purpose (a value, a year, a code or a phone number), so please check. ' + keepLast;
      else if (oneLetter) why = 'The letter ' + q(word) + ' is said ' + times(count) + ' in a row. It may be someone spelling something out, so please check. ' + keepLast;
      else if (GRAMMAR[n]) why = q(word) + ' twice in a row can be correct grammar (as in \u201Chad had\u201D or \u201Cthat that\u201D) or a stutter. Accept to keep only the last one; reject to keep both.';
      else if (NAV[n] && !EMPHASIS[n]) why = q(word) + ' is said ' + times(count) + ' in a row. In a tutorial that is often on purpose (pressing a key or clicking a button more than once, like \u201CNext, Next\u201D), so please check. ' + keepLast;
      else why = q(word) + ' is said ' + times(count) + ' in a row. That can be on purpose (for emphasis), so please check. ' + keepLast;
    } else if (pure && !FUNC[n] && (count >= 3 || comma || uiName || maxGap > 0.35)) {
      // a content word said again: a stutter is tight ("data data"), a list of names or a repeated click is spaced out or numbered
      conf = 0.6; force = true;
      why = q(word) + ' is said ' + times(count) + ' in a row' + (count >= 3 ? '' : (comma ? ', written with a comma between the copies,' : (uiName ? ', with a capital letter in the middle of a sentence like a button or menu name,' : ', with a clear pause between the copies,'))) +
        '. Three in a row, a list of names or a repeated step is often on purpose (clicking or naming the same thing again), so please check. ' + keepLast;
    } else if (pure) {
      conf = FUNC[n] ? 0.95 : 0.9;
      why = q(word) + ' is said ' + times(count) + ' in a row, which sounds like a stutter. Only the last one is kept.';
    } else if (weak) {
      conf = 0.7; force = true;
      why = q(cutToks[cutToks.length - 1].disp) + ' looks like the start of ' + q(word) + ' that was cut off (a stutter). The unfinished attempt is cut and ' + q(word) + ' is kept. If ' + q(cutToks[cutToks.length - 1].disp) + ' was meant as a real word, reject this one.';
    } else if (contr) {
      conf = 0.9;
      why = q(textOf(cutToks)) + ' was started and then restarted as ' + q(word) + '. The first try is cut and ' + q(word) + ' is kept.';
    } else {
      var hy = false;
      for (k = 0; k < cutToks.length; k++) if (cutToks[k].frag) hy = true;
      conf = hy ? 0.93 : 0.88;
      why = 'A word was started more than once: ' + q(textOf(cutToks)) + ' then ' + q(word) + '. The unfinished attempt' + (cutToks.length === 1 ? ' is' : 's are') + ' cut and ' + q(word) + ' is kept.';
    }
    if (trail && !force) {
      conf = Math.min(conf, 0.6); force = true;
      why += ' The first one ends with \u201C...\u201D in the transcript, so it may be a pause on purpose rather than a stutter. Please check.';
    }
    if (!force) {
      if (maxGap <= 0.35) conf += 0.02; else if (maxGap > 0.7) conf -= 0.1;
      if (lowKnown) conf -= 0.1;
    }
    var kind = pure ? 'repeat' : 'stutter';
    var chunks = chunksOf(ctx, cutToks);
    for (k = 0; k < cutToks.length; k++) cutToks[k].claimed = true;
    for (var c = 0; c < chunks.length; c++) {
      var ch = chunks[c], r = chunkRange(ctx, ch);
      if (r[1] - r[0] < P.minCut - EPS) continue;
      out.push({
        kind: kind, start: r[0], end: r[1], text: textOf(ch), confidence: conf, force: force,
        src: srcSetOf(ch, false), words: idxOf(ch), reason: why + ' ' + CUT_MARK
      });
    }
  }

  /* ------------------------------------------------------------------ stutters written as one joined word */
  // Whisper often writes a stutter as one token: "I-I-I", "wh-what", "the-the". Only the engine knows the real times, so the
  // cut is the first part of the token's time (an estimate), and it is always left for review.
  function detectJoined(ctx, out) {
    var T = ctx.T, P = ctx.P;
    for (var i = 0; i < T.length; i++) {
      var tok = T[i];
      if (!tok.join || tok.filler || tok.claimed) continue;
      var dur = tok.e - tok.s;
      var r = limitRange(ctx, tok.s + P.pad, tok.s + dur * tok.join - P.pad);
      if (r[1] - r[0] < P.minCut - EPS) continue;
      tok.claimed = true;
      out.push({
        kind: 'stutter', start: r[0], end: r[1], text: tok.disp, confidence: 0.6, force: true, partial: true,
        src: srcSetOf([tok], false), words: [tok.i],
        reason: 'The speech engine wrote ' + q(tok.disp) + ' as one joined word, which usually means a stutter (the start of the word said more than once). ' +
          'The repeated start is cut and the finished word is kept. The engine gives one time for the whole word, so the cut point is only an estimate: please listen before accepting. ' + CUT_MARK
      });
    }
  }

  /* ------------------------------------------------------------------ one engine heard a short word before a word with the same first letter */
  // Evidence from disagreement (needs both engines): a short word that only ONE of them heard, directly before a word that begins with
  // the same letter, is often the first try of that word ("that the", "Pip Pivot", "work we're" were all real stutters in the test clip).
  // A short low-confidence fragment that no dictionary knows counts too. Always review, never auto.
  function firstLetter(n) {
    var m = /[a-z]/.exec(n);
    return m ? m[0] : '';
  }
  function detectDisagreements(ctx, out) {
    var T = ctx.T, P = ctx.P;
    for (var i = 0; i + 1 < T.length; i++) {
      var a = T[i], b = T[i + 1], single = false, why = '';
      if (a.filler || b.filler || a.claimed || b.claimed || a.endsSent || a.isNum || b.isNum || a.caps || a.join) continue;
      if (a.n === b.n || b.s - a.e > 0.5 + EPS || b.s < a.e - 0.05) continue;
      // the first try is short and no longer than the finished word (a stutter is a clipped attempt, not a whole longer word)
      if (a.e - a.s > 0.25 || a.n.length < 2 || a.n.length > b.n.length + 1) continue;
      var l = firstLetter(a.n);
      if (l === '' || l !== firstLetter(b.n)) continue;
      var both = ctx.eng.parakeet === 'yes' && ctx.eng.whisper === 'yes';
      var who = a.src === 'parakeet' ? 'Parakeet' : (a.src === 'whisper' ? 'Whisper' : '');
      if (both && who && b.src === 'both') { // the finished word is solid (both engines heard it); the first try is the odd one out
        single = true;
        why = 'Only ' + who + ' heard ' + q(a.disp) + ' (the other engine did not), and the very next word, ' + q(b.disp) + ', starts with the same letter. ';
      } else if (a.src !== 'other' && a.cKnown && a.c < 0.8 && a.n.length <= 3 && !isRealShort(a.n) && !FUNC[a.n] && !NAV[a.n] && b.n.length > a.n.length) {
        why = q(a.disp) + ' is short, the engine was unsure of it (' + Math.round(a.c * 100) + '% sure), and the very next word, ' + q(b.disp) + ', starts with the same letter. ';
      }
      if (!why) continue;
      var r = chunkRange(ctx, [a]);
      if (r[1] - r[0] < P.minCut - EPS) continue;
      a.claimed = true;
      out.push({
        kind: 'stutter', start: r[0], end: r[1], text: a.disp, confidence: single && a.cKnown && a.c < 0.6 ? 0.55 : 0.45, force: true,
        src: srcSetOf([a], false), words: [a.i],
        reason: why + 'That can be a stutter: the first try of ' + q(b.disp) + ' that came out as a different short word. It is only a guess, so please listen before accepting. ' +
          'Accept to cut ' + q(a.disp) + ' and keep ' + q(b.disp) + '; reject to keep both. ' + CUT_MARK
      });
    }
  }

  /* ------------------------------------------------------------------ false starts */
  function detectFalseStarts(ctx, out) {
    var C = ctx.C, P = ctx.P, i = 0;
    while (i < C.length - 2) {
      var done = 0;
      for (var k = 2; k <= 4 && i + k < C.length && !done; k++) {
        var A = C.slice(i, i + k), a1 = A[0], ak = A[k - 1], r1 = C[i + k];
        // a restart is only recognised when it begins with the same word ("click the- click on ...")
        if (a1.isNum || a1.n.length < 1 || r1.n !== a1.n) continue;
        var ok = true, x;
        for (x = 0; x < k; x++) if (A[x].claimed) ok = false;
        for (x = 0; x < k - 1; x++) if (A[x].endsSent) ok = false; // a sentence boundary inside the phrase: not one abandoned phrase
        for (x = 1; x < k && ok; x++) {
          if (A[x].pos !== A[x - 1].pos + 1 || A[x].s - A[x - 1].e > P.stutterWindow + EPS) ok = false;
        }
        if (!ok || r1.s - ak.e > P.stutterWindow + EPS) continue;
        // the whole phrase said twice, word for word?
        var verbatim = i + 2 * k <= C.length;
        for (x = 0; x < k && verbatim; x++) if (C[i + k + x].n !== A[x].n) verbatim = false;
        var cue = null, conf = 0, because = '';
        if (verbatim) {
          cue = 'verbatim'; conf = 0.62; because = 'The same words were said twice in a row.';
        } else if (ak.frag) {
          cue = 'hyphen'; conf = 0.72; because = 'The first try stops in the middle of a word.';
        } else if (DANGLING[ak.n] && !FUNC[a1.n] && k <= 3) {
          cue = 'dangling'; conf = 0.65; because = 'A phrase does not normally end on ' + q(ak.disp) + ', and the same first word comes straight after.';
        }
        if (!cue) continue;
        var R = [];
        for (x = 0; x < 4 && i + k + x < C.length; x++) R.push(C[i + k + x]);
        var r = chunkRange(ctx, A);
        if (r[1] - r[0] < P.minCut - EPS) continue;
        for (x = 0; x < k; x++) A[x].claimed = true;
        out.push({
          kind: 'false-start', start: r[0], end: r[1], text: textOf(A), confidence: conf, force: true,
          src: srcSetOf(A, false), words: idxOf(A),
          reason: 'Looks like a false start: ' + q(textOf(A)) + ' was said and then started again as ' + q(textOf(R)) + '. ' + because +
            ' This removes the abandoned part and keeps the restart, so please check that it still reads right. ' + CUT_MARK
        });
        done = k;
      }
      i += done ? done : 1;
    }
  }

  // Rule B: the restart begins with a DIFFERENT first word but has the same shape: "Pull the ... drag the region". The phrase
  // stops on a word that cannot end it ("the"), there is a hesitation pause (0.15 to 1 s), then another action word and the same
  // "the" follow. A weak pattern, so it is always left for review.
  function detectRestarts(ctx, out) {
    var T = ctx.T, P = ctx.P;
    for (var i = 0; i + 3 < T.length; i++) {
      var x = T[i], d1 = T[i + 1], y = T[i + 2], d2 = T[i + 3];
      if (!DANGLING[d1.n] || d2.n !== d1.n || x.n === y.n) continue;
      if (x.filler || d1.filler || y.filler || d2.filler || x.claimed || d1.claimed || y.claimed || d2.claimed) continue;
      if (FUNC[x.n] || DANGLING[x.n] || FUNC[y.n] || DANGLING[y.n] || x.isNum || y.isNum || x.caps || y.caps) continue;
      if (x.endsSent || d1.endsSent || y.endsSent) continue;
      var pause = y.s - d1.e;
      if (pause < 0.15 - EPS || pause > 1.0 + EPS || d1.s - x.e > 0.3 + EPS || d2.s - y.e > 0.3 + EPS) continue;
      var A = [x, d1], r = chunkRange(ctx, A);
      if (r[1] - r[0] < P.minCut - EPS) continue;
      x.claimed = true; d1.claimed = true;
      out.push({
        kind: 'false-start', start: r[0], end: r[1], text: textOf(A), confidence: 0.55, force: true,
        src: srcSetOf(A, false), words: idxOf(A),
        reason: 'Looks like a false start: ' + q(textOf(A)) + ' stops on ' + q(d1.disp) + ', which cannot end a phrase, and after a pause the same kind of phrase starts again as ' +
          q(y.disp + ' ' + d2.disp) + '. This is only a guess from the shape of the words. This removes the abandoned part and keeps the restart, so please check that it still reads right. ' + CUT_MARK
      });
    }
  }

  /* ------------------------------------------------------------------ dead space */
  function soundsText(kinds) {
    var parts = [];
    if (kinds.voiced) parts.push('a voiced sound');
    if (kinds.breath) parts.push('a breath');
    if (kinds.noise) parts.push('some noise');
    if (kinds.click) parts.push('a click');
    return parts.join(', ');
  }

  // A soft breath of ordinary length belongs to normal speech. Inside a pause that is cut anyway it goes away with the pause,
  // so it is no reason to doubt the pause (and when the user switched breaths off, no breath is).
  function ordinaryBreath(x, P) {
    if (x.kind !== 'breath') return false;
    if (!P.includeBreaths) return true;
    return (x.e - x.s) <= P.longSound && !(x.db !== null && x.db >= P.loudDb);
  }

  // Dead space is measured on the words that REMAIN: a filler that is going to be cut does not count as speech, so
  // "pause + um + pause" is one long pause (and is cut down to keepPause), not two short ones that both stay.
  function detectDeadSpace(ctx, out) {
    var T = ctx.T, P = ctx.P, cuts = ctx.fillerCuts, i, U = [], gone = Object.create(null);
    for (i = 0; i < cuts.length; i++) gone[cuts[i].pos] = 1;
    for (i = 0; i < T.length; i++) if (!gone[T[i].pos]) U.push(T[i]);
    if (!U.length) return;

    // the filler cuts that lie (even partly) between a and b, clipped to [a, b]
    var cutIx = makeIndex(cuts); // cuts are pushed in word order, so they are sorted by start
    function holesIn(a, b) {
      var h = [];
      forOverlaps(cutIx, a, b, function (c) {
        var hs = Math.max(c.s, a), he = Math.min(c.e, b);
        if (he - hs > EPS) h.push({ s: hs, e: he, len: Math.min(c.len, he - hs), disp: c.disp });
      });
      return h;
    }
    function holeLen(h) {
      var t = 0;
      for (var k = 0; k < h.length; k++) t += h[k].len;
      return t;
    }
    var hasCuts = cuts.length > 0;

    function addGap(prev, next, gs, ge, holes, gapEff) {
      var half = P.keepPause / 2;
      var cs = prev ? gs + half : gs, ce = next ? ge - half : ge;
      if (!(ce > cs)) return;

      // the stretch to cut, minus the filler words inside it (they have their own candidates)
      var regions = [], cur = cs, k;
      for (k = 0; k < holes.length; k++) {
        var hs = Math.max(holes[k].s, cs), he = Math.min(holes[k].e, ce);
        if (he <= hs) continue;
        if (hs > cur) regions.push([cur, hs]);
        if (he > cur) cur = he;
      }
      if (ce > cur) regions.push([cur, ce]);

      var edge = !prev ? 'start' : (!next ? 'end' : null);
      var pieces = [], total = 0;
      for (k = 0; k < regions.length; k++) {
        var rs = regions[k][0], re = regions[k][1];
        // pad from a real word at the outer ends, and from the filler word at the inner ends (its start may be reported a little late)
        var start = rs === cs ? (prev ? rs + P.pad : rs) : rs + P.pad, end = re === ce ? (next ? re - P.pad : re) : re - P.pad;
        var lim = limitRange(ctx, start, end);
        start = lim[0]; end = lim[1];
        if (end - start < P.minCut - EPS) continue;

        var conf, cover = 0, kinds = {}, any = false, pen = 0, soundOv = 0, softOv = 0;
        if (ctx.hasAudio) {
          cover = coverage(ctx.silIx, rs, re);
          forOverlaps(ctx.soundIx, rs, re, function (x) {
            var ov = Math.min(x.e, re) - Math.max(x.s, rs);
            if (ordinaryBreath(x, P)) { softOv += ov; return; } // goes away with the pause: counts as quiet, never as a reason to doubt
            // balanced / thorough: a short sound that is not voiced (a tap, a click, a breath, a small noise) goes with the pause too
            if (P.quietSounds && x.kind !== 'voiced' && (x.e - x.s) <= P.quietSoundMax + EPS) { softOv += ov; return; }
            var wgt = x.kind === 'voiced' ? 1 : (x.kind === 'noise' ? 0.6 : 0.35);
            pen += (0.06 + 0.7 * ov / (re - rs)) * wgt;
            soundOv += ov;
            kinds[x.kind] = 1; any = true;
          });
          // A gap that is mostly filled by a recognised sound is not "dead": the sound is reported on its own.
          if (soundOv >= 0.5 * (re - rs)) continue;
          if (softOv > 0) cover = clamp(cover + softOv / (re - rs), 0, 1);
          conf = 0.45 + 0.5 * cover - Math.min(0.5, pen);
        } else {
          conf = Math.min(0.78, 0.55 + 0.05 * gapEff);
        }
        if (edge) conf -= 0.08;
        conf = Math.max(0.2, conf); // an unclear gap is still worth a look, so it never shows as "0% sure"
        // Anything the reason asks the user to check is never applied without asking: a sound inside the cut, and the very
        // start or end of the video (a title or a final result can sit there).
        var force = any || (!!edge && !P.autoEdges);
        // The longer the silence, the likelier it is a wait the viewer needs (a recalculation, an install). Confidence glides
        // down from softGap to longGap (no cliff at one exact length); past longGap it is always left for review.
        if (gapEff > P.softGap) {
          var f = P.longGap > P.softGap ? Math.min(1, (gapEff - P.softGap) / (P.longGap - P.softGap)) : 1;
          conf = Math.min(conf, 0.95 - 0.2 * f);
        }
        if (gapEff > P.longGap) { force = true; conf = Math.min(conf, 0.75); }
        pieces.push({ s: start, e: end, rs: rs, re: re, conf: conf, force: force, cover: cover, kinds: kinds, any: any, soft: softOv > 0.01 });
        total += end - start;
      }
      if (!pieces.length) return;

      var left = gapEff - total;
      var noun, where;
      if (prev && next) where = ' between ' + q(prev.disp) + ' and ' + q(next.disp);
      else if (!prev) where = ' at the very start of the video, before ' + q(next.disp);
      else where = ' at the very end of the video, after ' + q(prev.disp);
      var around = '';
      if (holes.length === 1) around = ' (the ' + q(holes[0].disp) + ' in the middle is cut too)';
      else if (holes.length > 1) around = ' (the ' + holes.length + ' filler sounds in the middle are cut too)';
      for (k = 0; k < pieces.length; k++) {
        var pc = pieces[k];
        noun = ctx.hasAudio ? (pc.cover >= 0.75 ? 'Silence' : 'Gap') : 'Pause';
        var clause;
        if (!ctx.hasAudio) clause = 'nothing is said, but the audio levels were not checked';
        else if (pc.cover >= 0.97) clause = pc.soft ? 'the audio is quiet apart from a soft breath' : 'the audio is quiet the whole time';
        else if (pc.cover >= 0.75) clause = 'the audio is quiet for most of it (' + Math.round(pc.cover * 100) + '%' + (pc.soft ? ', counting a soft breath as quiet' : '') + ')';
        else clause = 'nothing is said, but the audio is only quiet for ' + Math.round(pc.cover * 100) + '% of it' + (pc.soft ? ' (counting a soft breath as quiet)' : '');
        var parts = [noun + ' of ' + fmtDur(gapEff) + ' s' + where + around + ': ' + clause + '.'];
        if (pc.any) parts.push('Something audible happens inside it (' + soundsText(pc.kinds) + '), so check you do not want it.');
        if (edge) parts.push('Trimming the ' + (edge === 'start' ? 'start' : 'end') + ' of a video is usually safe, but check you do not want to keep it.');
        if ((gapEff > P.longGap || (!edge && gapEff > P.softGap)) && (pc.force || pc.conf < P.autoThreshold - 1e-9)) {
          parts.push('This is a long pause (' + fmtDur(gapEff) + ' s). It may be you waiting for a program to load or a result to appear, and the screen may be changing, which viewers might need to see, so it is left for you to decide.');
        }
        parts.push(CUT_MARK + (edge ? '' : ' A natural pause of ' + fmtDur(left) + ' s is left' + (pieces.length > 1 ? ' in total' : '') + '.'));

        ctx.deadRanges.push({ s: pc.rs, e: pc.re });
        out.push({
          kind: 'dead-space', start: pc.s, end: pc.e, text: '[silence ' + fmtDur(gapEff) + ' s]', confidence: pc.conf, force: pc.force,
          src: srcSetOf((prev ? [prev] : []).concat(next ? [next] : []), ctx.hasAudio), words: [], reason: parts.join(' ')
        });
      }
    }

    // effective length of the gap [a, b] once the filler words inside it are cut
    function effective(a, b) {
      if (!hasCuts) return { holes: [], gap: b - a };
      var h = holesIn(a, b);
      return { holes: h, gap: (b - a) - holeLen(h) };
    }

    var maxEnd = U[0].e, prevTok = U[0], e0, gi;
    e0 = effective(0, U[0].s);
    if (e0.gap > P.minGap + 1e-6) addGap(null, U[0], 0, U[0].s, e0.holes, e0.gap);
    for (i = 1; i < U.length; i++) {
      var t = U[i];
      if (t.s - maxEnd > 0) {
        gi = effective(maxEnd, t.s);
        if (gi.gap > P.minGap + 1e-6) addGap(prevTok, t, maxEnd, t.s, gi.holes, gi.gap);
      }
      if (t.e > maxEnd) { maxEnd = t.e; prevTok = t; }
    }
    if (ctx.durationKnown && ctx.duration > maxEnd) {
      gi = effective(maxEnd, ctx.duration);
      if (gi.gap > P.minGap + 1e-6) addGap(prevTok, null, maxEnd, ctx.duration, gi.holes, gi.gap);
    }
    ctx.deadRanges.sort(function (a, b) { return a.s - b.s; });
  }

  /* ------------------------------------------------------------------ non-word sounds */
  function insideDead(ctx, a, b) {
    var arr = ctx.deadRanges, lo = 0, hi = arr.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid].s <= a + EPS) lo = mid + 1; else hi = mid; }
    // arr[lo-1] is the last range starting at or before a; ranges never overlap each other
    return lo > 0 && arr[lo - 1].e >= b - EPS;
  }

  function detectNonWords(ctx, out) {
    var P = ctx.P, sounds = ctx.soundIx.items;
    for (var si = 0; si < sounds.length; si++) {
      var x = sounds[si], dur = x.e - x.s;
      var pieces = [[x.s, x.e]], covered = 0;
      forOverlaps(ctx.wordIx, x.s, x.e, function (tok) {
        covered += Math.min(tok.e, x.e) - Math.max(tok.s, x.s);
        var next = [];
        for (var p = 0; p < pieces.length; p++) {
          var a = pieces[p][0], b = pieces[p][1];
          if (tok.e <= a || tok.s >= b) { next.push(pieces[p]); continue; }
          if (tok.s - a > 0) next.push([a, tok.s]);
          if (b - tok.e > 0) next.push([tok.e, b]);
        }
        pieces = next;
      });
      if (covered > 0.35 * dur) continue; // mostly a word: not a stray sound
      for (var pi = 0; pi < pieces.length; pi++) {
        var a0 = pieces[pi][0], b0 = pieces[pi][1], len = b0 - a0;
        if (len < P.minSound - EPS) continue;
        if (insideDead(ctx, a0, b0)) continue; // the dead-space cut already covers it
        var r = limitRange(ctx, a0 + P.pad, b0 - P.pad);
        if (r[1] - r[0] < P.minCut - EPS) continue;
        var loud = x.db !== null && x.db >= P.loudDb;
        var isLong = len > P.longSound;
        var conf, text, why, force = false;
        // An ordinary breath (soft and short) is normal speech and would flood the review queue: it is ignored. A breath that is
        // long, loud or at least minBreath seconds long is still reported; includeBreaths:false switches breaths off completely.
        if (x.kind === 'breath' && (!P.includeBreaths || (len < P.minBreath - EPS && !loud && !isLong))) continue;
        // In a screen recording most short noises and clicks are the mouse or the keyboard. They are not worth a review card.
        if ((x.kind === 'noise' || x.kind === 'click') && len < P.minNoise - EPS) continue;
        if (x.kind === 'voiced') {
          conf = 0.45 + 0.4 * x.c + (len >= 0.15 && len <= 0.8 ? 0.05 : 0) - (len > 1.2 ? 0.2 : 0);
          text = '[voiced sound]';
          why = 'A voiced sound (' + fmtDur(len) + ' s) that ' + (ctx.eng.parakeet === 'yes' && ctx.eng.whisper === 'yes' ? 'neither Parakeet nor Whisper' : 'the speech engine did not') +
            ' turned into a word. It is probably an \u201Cmm\u201D or \u201Cum\u201D that was not recognised.';
          if (len > 1.5) { force = true; why += ' It is long, so it could be speech that was missed. Please listen before accepting.'; }
        } else if (x.kind === 'breath') {
          conf = 0.4 + 0.2 * x.c + (isLong || loud ? 0.35 : 0);
          text = '[breath]';
          why = (isLong ? 'A long breath' : (loud ? 'A loud breath' : 'A breath')) + ' (' + fmtDur(len) + ' s) with no words.' +
            (isLong || loud ? ' It is long or loud enough to be noticed.' : ' Breaths between sentences are normal, so this is left for you to decide.');
        } else if (x.kind === 'click') {
          conf = Math.min(0.8, 0.4 + 0.25 * x.c + (isLong || loud ? 0.2 : 0));
          text = '[click]';
          why = 'A click (' + fmtDur(len) + ' s) with no words. It could be a mouth click or a mouse or keyboard click you want to keep, so it is left for you to decide.';
        } else {
          conf = 0.4 + 0.25 * x.c + (isLong || loud ? 0.3 : 0);
          text = '[noise]';
          why = (isLong ? 'A long noise' : (loud ? 'A loud noise' : 'A noise')) + ' (' + fmtDur(len) + ' s) with no words. It could be a cough or mouth noise, or a sound from the program that you want to keep.';
        }
        if (len > P.maxNonWord) {
          force = true;
          why += ' It lasts a long time, so it may be music, program sound or quiet speech. Please listen before accepting.';
        }
        out.push({
          kind: 'non-word', start: r[0], end: r[1], text: text, confidence: conf, force: force,
          src: ['audio'], words: [], reason: why + ' ' + CUT_MARK
        });
      }
    }
  }

  /* ------------------------------------------------------------------ overlap resolution */
  // Keeps the higher-confidence candidate whenever two ranges overlap.
  function resolveOverlaps(list) {
    var order = list.slice().sort(function (a, b) {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      var pa = PRIORITY[a.kind], pb = PRIORITY[b.kind];
      if (pa !== pb) return pa - pb;
      return a.start - b.start || a.end - b.end;
    });
    var acc = [];
    for (var i = 0; i < order.length; i++) {
      var c = order[i], lo = 0, hi = acc.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (acc[mid].start < c.start) lo = mid + 1; else hi = mid; }
      var before = lo > 0 ? acc[lo - 1] : null, after = lo < acc.length ? acc[lo] : null;
      if (before && before.end > c.start + EPS) continue;
      if (after && after.start < c.end - EPS) continue;
      acc.splice(lo, 0, c);
    }
    return acc;
  }

  /* ------------------------------------------------------------------ keep cuts clear of the words that stay */
  // The cut rules trust the word times. A file with overlapping words (a merged export, subtitle cues, one word timed into its
  // neighbour) would let a filler or repeat cut clip the end of the word before it or the start of the word after it. Every
  // cut is shrunk until it is at least `pad` away from each word that is not cut by any candidate.
  function clampToKeptWords(ctx, list) {
    var P = ctx.P, i, j, cutIdx = Object.create(null), byOrig = Object.create(null), out = [];
    for (i = 0; i < ctx.T.length; i++) byOrig[ctx.T[i].i] = ctx.T[i];
    for (i = 0; i < list.length; i++) for (j = 0; j < list[i].words.length; j++) cutIdx[list[i].words[j]] = 1;
    for (i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.kind === 'dead-space') { out.push(c); continue; } // sits inside a gap measured from the end of the latest word
      var s = c.start, e = c.end, lo = Infinity, hi = -Infinity;
      for (j = 0; j < c.words.length; j++) {
        var ow = byOrig[c.words[j]];
        if (ow) { if (ow.s < lo) lo = ow.s; if (ow.e > hi) hi = ow.e; }
      }
      var mid = lo <= hi ? (lo + hi) / 2 : (s + e) / 2;
      var hits = [];
      forOverlaps(ctx.wordIx, s - P.pad, e + P.pad, function (t) { if (!cutIdx[t.i]) hits.push(t); });
      for (j = 0; j < hits.length; j++) {
        var t = hits[j];
        if ((t.s + t.e) / 2 <= mid) { if (t.e + P.pad > s + 1e-6) s = t.e + P.pad; }
        else if (t.s - P.pad < e - 1e-6) e = t.s - P.pad;
      }
      if (s === c.start && e === c.end) { out.push(c); continue; }
      if (e - s < P.minCut - EPS) continue;
      c.start = s; c.end = e;
      out.push(c);
    }
    return out;
  }

  /* ------------------------------------------------------------------ analyze */
  function analyze(transcript, params) {
    var warnings = [];
    var P = resolveParams(params);
    var ctx = buildContext(transcript, P, warnings);
    var raw = [], i;

    if (P.includeFillers) detectFillers(ctx, raw);
    var C = [];
    for (i = 0; i < ctx.T.length; i++) if (!ctx.T[i].filler) C.push(ctx.T[i]);
    ctx.C = C;
    if (P.includeStutters) {
      detectRepeats(ctx, raw);
      if (P.includeFalseStarts) { detectFalseStarts(ctx, raw); detectRestarts(ctx, raw); }
      detectJoined(ctx, raw);          // the weaker, guess-based rules come last so they never take a word from a stronger one
      detectDisagreements(ctx, raw);
    }
    if (P.includeDeadSpace) detectDeadSpace(ctx, raw);
    if (P.includeNonWords) detectNonWords(ctx, raw);

    var kept = clampToKeptWords(ctx, resolveOverlaps(raw));
    var byId = Object.create(null), cands = [];
    var cutSeconds = 0, autoSeconds = 0, auto = 0, review = 0;
    var byKind = {};
    for (i = 0; i < KINDS.length; i++) byKind[KINDS[i]] = { count: 0, seconds: 0 };

    for (i = 0; i < kept.length; i++) {
      var k = kept[i];
      var conf = r2(clamp(isFinite(k.confidence) ? k.confidence : 0.5, 0, 0.99));
      var force = k.force;
      var start = r3(k.start), end = r3(k.end);
      if (!(end - start >= 0.001)) continue; // never hand over a zero-length cut
      // the "Cuts m:ss to m:ss" sentence is written last, from the final (rounded, clamped) range
      var reason = k.reason.indexOf(CUT_MARK) >= 0 ? k.reason.split(CUT_MARK).join(cutLine(start, end)) : k.reason + ' ' + cutLine(start, end);
      if (ctx.approximate) {
        force = true; conf = Math.min(conf, 0.8);
        reason += ' The times in this file are approximate (it came from subtitles), so check the cut points.';
      }
      var status = !force && conf >= P.autoThreshold - 1e-9 ? 'auto' : 'review';
      var id = k.kind + ':' + Math.round(start * 100);
      if (byId[id]) { var n = 2; while (byId[id + '#' + n]) n++; id = id + '#' + n; }
      byId[id] = 1;
      var cand = {
        id: id, kind: k.kind, start: start, end: end, text: k.text, confidence: conf,
        status: status, reason: reason, src: k.src, words: k.words
      };
      if (k.partial) cand.partial = true; // optional: only part of the listed word is cut (a joined stutter such as "wh-what")
      if (typeof k.mine === 'number') cand.mine = k.mine; // optional: how much this sound looked like the person's own ums (see scoreFingerprint)
      cands.push(cand);
      var len = end - start;
      cutSeconds += len;
      byKind[k.kind].count++; byKind[k.kind].seconds += len;
      if (status === 'auto') { auto++; autoSeconds += len; } else review++;
    }
    for (i = 0; i < KINDS.length; i++) byKind[KINDS[i]].seconds = r3(byKind[KINDS[i]].seconds);
    var total = isObj(transcript) && Array.isArray(transcript.words) ? transcript.words.length : 0;
    return {
      candidates: cands,
      stats: {
        words: total, duration: r3(ctx.duration), cutSeconds: r3(cutSeconds),
        autoSeconds: r3(autoSeconds), reviewSeconds: r3(cutSeconds - autoSeconds),
        byKind: byKind, auto: auto, review: review, skipped: ctx.skipped,
        hasAudio: ctx.hasAudio
      },
      warnings: warnings
    };
  }

  /* ------------------------------------------------------------------ mergeCuts / wordsInRange / describeKind */
  function mergeCuts(ranges, opts) {
    var gap = isObj(opts) ? num(opts.gap, 0.05) : 0.05;
    if (gap < 0) gap = 0;
    var arr = [];
    if (Array.isArray(ranges)) {
      for (var i = 0; i < ranges.length; i++) {
        var r = ranges[i];
        if (!isObj(r)) continue;
        var s = num(r.start, NaN), e = num(r.end, NaN);
        if (!isFinite(s) || !isFinite(e) || e <= s) continue;
        arr.push({ start: s, end: e });
      }
    }
    arr.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    var out = [];
    for (var j = 0; j < arr.length; j++) {
      var cur = out[out.length - 1];
      if (cur && arr[j].start - cur.end <= gap + 1e-9) { if (arr[j].end > cur.end) cur.end = arr[j].end; }
      else out.push({ start: arr[j].start, end: arr[j].end });
    }
    return out;
  }

  function wordsInRange(transcript, start, end) {
    var a = num(start, NaN), b = num(end, NaN), out = [];
    if (!isFinite(a) || !isFinite(b) || !isObj(transcript) || !Array.isArray(transcript.words)) return out;
    if (b < a) { var t = a; a = b; b = t; }
    var words = transcript.words;
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!isObj(w)) continue;
      var s = num(w.s, NaN), e = num(w.e, NaN);
      if (!isFinite(s) || !isFinite(e)) continue;
      if (e < s) e = s;
      if (b === a) { if (s <= a && (a < e || (e === s && a === s))) out.push(i); }
      else if (s < b - EPS && e > a + EPS) out.push(i);
    }
    return out;
  }

  var KIND_INFO = {
    'dead-space': { label: 'Dead space', help: 'A long pause where nothing is being said.' },
    'filler': { label: 'Filler sound', help: 'Sounds like \u201Cum\u201D, \u201Cuh\u201D or \u201Cer\u201D that fill a pause while thinking.' },
    'stutter': { label: 'Stutter', help: 'A word that was started more than once, like \u201Cwh- what\u201D.' },
    'repeat': { label: 'Repeated word', help: 'The same word said twice or more in a row, like \u201Cthe the\u201D.' },
    'false-start': { label: 'False start', help: 'A phrase that was started, dropped, and started again.' },
    'non-word': { label: 'Other sound', help: 'A breath, cough, mouth click or hum that is not a word.' },
    'manual': { label: 'Marked by you', help: 'A section you picked yourself to cut.' }
  };
  function describeKind(kind) {
    var k = typeof kind === 'string' && Object.prototype.hasOwnProperty.call(KIND_INFO, kind) ? KIND_INFO[kind] : null;
    return k ? { label: k.label, help: k.help } : { label: 'Other', help: 'A section marked for cutting.' };
  }

  /* ================================================================== reading transcript files */
  function friendly(msg) { return new Error(msg); }

  var NOT_A_TRANSCRIPT = 'This file does not look like a transcript that Video Redline can read. ' +
    'It can open the transcript file made by the helper script (.json), a Whisper transcript (.json), or a subtitle file (.srt or .vtt).';

  // --- generic word list -> canonical, sorted, validated words
  // a fingerprint is a short list of plain numbers; anything else is dropped
  function cleanFingerprint(fp) {
    if (!Array.isArray(fp) || fp.length < 1 || fp.length > 128) return null;
    var out = new Array(fp.length);
    for (var i = 0; i < fp.length; i++) { var v = fp[i]; if (typeof v !== 'number' || !isFinite(v)) return null; out[i] = v; }
    return out;
  }
  function normaliseWordList(raw, defaultSrc, warnings) {
    var out = [], dropped = 0, fixed = 0;
    for (var i = 0; i < raw.length; i++) {
      var x = raw[i];
      if (!isObj(x)) { dropped++; continue; }
      var s = num(x.s, NaN), e = num(x.e, NaN);
      if (!isFinite(s) || !isFinite(e)) { dropped++; continue; }
      if (e < s) { e = s; fixed++; }
      if (e <= 0) { dropped++; continue; }
      if (s < 0) { s = 0; fixed++; }
      var w = x.w === undefined || x.w === null ? '' : String(x.w).trim();
      if (w === '') { dropped++; continue; }
      var c = num(x.c, NaN);
      if (isFinite(c) && c > 1.5 && c <= 100) c = c / 100;
      var src = srcOf(x.src); if (src === 'other') src = defaultSrc;
      var rec = { w: w, s: s, e: e, c: isFinite(c) ? clamp(c, 0, 1) : null, src: src, _i: i };
      var fp = cleanFingerprint(x.fp);
      if (fp) rec.fp = fp;                          // the helper's fingerprint of an um-like sound (see scoreFingerprint): kept as it is
      out.push(rec);
    }
    out.sort(function (a, b) { return a.s - b.s || a.e - b.e || a._i - b._i; });
    for (var j = 0; j < out.length; j++) delete out[j]._i;
    if (dropped) warnings.push(dropped + ' word' + (dropped === 1 ? ' was' : 's were') + ' left out because ' + (dropped === 1 ? 'its' : 'their') + ' times or text were missing or invalid.');
    if (fixed) warnings.push(fixed + ' word time' + (fixed === 1 ? ' was' : 's were') + ' repaired (negative or backwards).');
    return out;
  }

  function newTranscript() {
    return {
      format: 'video-review-transcript', version: 1,
      video: { name: '', duration: 0 },
      engines: { parakeet: '', whisper: '', audio: '' },
      words: [], silences: [], sounds: [], hasAudio: false, approximate: false
    };
  }
  function strOr(x, d) { return typeof x === 'string' ? x : d; }

  function finishTranscript(t) {
    if (!(t.video.duration > 0)) t.video.duration = 0;
    return t;
  }

  // --- canonical
  function fromCanonical(obj, warnings) {
    if (!Array.isArray(obj.words)) throw friendly('The transcript file has no list of words, so there is nothing to analyse.');
    var t = newTranscript();
    var v = num(obj.version, 1);
    if (v > 1) warnings.push('This transcript file is a newer version (' + v + ') than this page understands; it will be read as well as possible.');
    if (isObj(obj.video)) { t.video.name = strOr(obj.video.name, ''); t.video.duration = num(obj.video.duration, 0); }
    if (isObj(obj.engines)) {
      t.engines.parakeet = strOr(obj.engines.parakeet, '');
      t.engines.whisper = strOr(obj.engines.whisper, '');
      t.engines.audio = strOr(obj.engines.audio, '');
    }
    t.words = normaliseWordList(obj.words, 'other', warnings);
    if (obj.words.length && !t.words.length) throw friendly('None of the ' + obj.words.length + ' words in this transcript file had usable start and end times.');
    if (!t.words.length) warnings.push('This transcript has no words in it.');
    var sil = cleanSilences(obj.silences), snd = cleanSounds(obj.sounds);
    t.silences = sil; t.sounds = snd;
    t.hasAudio = sil.length > 0 || snd.length > 0 || t.engines.audio.trim() !== '';
    if (!t.hasAudio) warnings.push('This transcript has no audio information (silences and sounds), so dead space will be left for you to review.');
    return finishTranscript(t);
  }

  // --- Whisper family
  function pickNum() {
    for (var i = 0; i < arguments.length; i++) { var n = num(arguments[i], NaN); if (isFinite(n)) return n; }
    return NaN;
  }
  function pickStr() {
    for (var i = 0; i < arguments.length; i++) if (typeof arguments[i] === 'string') return arguments[i];
    return '';
  }

  function decodeEntities(s) {
    return s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
  }

  // Spread the words of a caption evenly across its time span.
  function spreadText(text, s, e, out) {
    var parts = text.split(/\s+/), toks = [];
    for (var i = 0; i < parts.length; i++) if (lexical(stripEdges(parts[i]))) toks.push(parts[i]);
    var n = toks.length;
    if (!n || !(e > s)) return 0;
    var d = (e - s) / n;
    for (var k = 0; k < n; k++) out.push({ w: toks[k], s: s + d * k, e: s + d * (k + 1), c: 0.4, src: 'other' });
    return n;
  }

  // Some tools write times in milliseconds (AssemblyAI, several Whisper wrappers). A typical word cannot last 20 seconds, and a
  // word cannot start thousands of times later than the stated length of the recording, so such a list is read as milliseconds.
  function fixMillis(raw, hintDuration, warnings) {
    var lens = [], maxE = 0, i;
    for (i = 0; i < raw.length; i++) {
      if (!isFinite(raw[i].s) || !isFinite(raw[i].e)) continue;
      if (raw[i].e > maxE) maxE = raw[i].e;
      if (raw[i].e >= raw[i].s) lens.push(raw[i].e - raw[i].s);
    }
    if (!lens.length) return false;
    lens.sort(function (a, b) { return a - b; });
    var med = lens[lens.length >> 1];
    if (!(med >= 20 || (hintDuration > 0 && maxE > 1000 && maxE > hintDuration * 20))) return false;
    for (i = 0; i < raw.length; i++) { raw[i].s = raw[i].s / 1000; raw[i].e = raw[i].e / 1000; }
    warnings.push('The times in this file looked like milliseconds (far too large to be seconds for words or for this recording), so they were divided by 1000. Check that the cut points line up with the video.');
    return true;
  }

  function fromWhisperSegments(segs, warnings, obj) {
    var t = newTranscript(), raw = [], spread = false, noTimes = 0;
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      if (!isObj(seg)) continue;
      if (Array.isArray(seg.words) && seg.words.length) {
        for (var j = 0; j < seg.words.length; j++) {
          var w = seg.words[j];
          if (!isObj(w)) continue;
          var s = pickNum(w.start, w.s), e = pickNum(w.end, w.e);
          if (!isFinite(s) || !isFinite(e)) { noTimes++; continue; }
          raw.push({ w: pickStr(w.word, w.text, w.w), s: s, e: e, c: pickNum(w.probability, w.prob, w.score, w.confidence, w.c, w.p), src: 'whisper' });
        }
      } else {
        var ss = pickNum(seg.start, seg.s), se = pickNum(seg.end, seg.e), text = pickStr(seg.text);
        if (isFinite(ss) && isFinite(se) && text.trim() !== '') {
          if (spreadText(decodeEntities(text), ss, se, raw)) spread = true;
        }
      }
    }
    var wasMs = fixMillis(raw, obj ? num(obj.duration, 0) : 0, warnings);
    if (spread) {
      t.approximate = true;
      warnings.push('Some or all of this Whisper file has times for each sentence only, not for each word. Word times were spread evenly inside each sentence, so cuts are approximate. Everything will be listed for you to check. For exact timing, run Whisper with word timestamps turned on.');
    }
    if (noTimes) warnings.push(noTimes + ' word' + (noTimes === 1 ? ' had' : 's had') + ' no time in the Whisper file (often numbers) and ' + (noTimes === 1 ? 'was' : 'were') + ' left out.');
    t.words = normaliseWordList(raw, 'whisper', warnings);
    if (!t.words.length) throw friendly('This Whisper file has no words with times in it, so there is nothing to analyse.');
    t.engines.whisper = pickStr(obj && obj.model, obj && obj.model_name, 'Whisper');
    t.video.duration = obj ? num(obj.duration, 0) : 0;
    if (wasMs && t.video.duration > 0) { // a length written in milliseconds as well: bring it to seconds if it only fits that way
      var lastWord = t.words.length ? t.words[t.words.length - 1].e : 0;
      if (t.video.duration > lastWord * 20) t.video.duration = t.video.duration / 1000;
    }
    warnings.push('This file has no audio information (silences and sounds), so dead space will be left for you to review.');
    return finishTranscript(t);
  }

  function parseCppStamp(str) {
    var m = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d+))?$/.exec(typeof str === 'string' ? str.trim() : '');
    if (!m) return NaN;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number('0.' + m[4]) : 0);
  }
  function cppTimes(o) {
    if (!isObj(o)) return null;
    if (isObj(o.offsets)) {
      var a = num(o.offsets.from, NaN), b = num(o.offsets.to, NaN);
      if (isFinite(a) && isFinite(b)) return [a / 1000, b / 1000];
    }
    if (isObj(o.timestamps)) {
      var c = parseCppStamp(o.timestamps.from), d = parseCppStamp(o.timestamps.to);
      if (isFinite(c) && isFinite(d)) return [c, d];
    }
    return null;
  }

  function fromWhisperCpp(list, warnings, obj) {
    var t = newTranscript(), raw = [], spread = false, i, j;
    for (i = 0; i < list.length; i++) {
      var seg = list[i];
      if (!isObj(seg)) continue;
      var toks = Array.isArray(seg.tokens) ? seg.tokens : null, used = 0, cur = null;
      if (toks) {
        for (j = 0; j < toks.length; j++) {
          var tk = toks[j];
          if (!isObj(tk) || typeof tk.text !== 'string') continue;
          var txt = tk.text, tr = txt.trim();
          if (tr === '' || /^\[[^\]]*\]$/.test(tr) || /^<\|[^|]*\|>$/.test(tr)) continue;
          var tm = cppTimes(tk);
          if (!tm) continue;
          var p = num(tk.p, NaN);
          if (cur === null || /^\s/.test(txt)) {
            if (cur) raw.push(finishCpp(cur));
            cur = { w: tr, s: tm[0], e: tm[1], ps: isFinite(p) ? [p] : [] };
          } else {
            cur.w += tr; cur.e = Math.max(cur.e, tm[1]);
            if (isFinite(p)) cur.ps.push(p);
          }
          used++;
        }
        if (cur) raw.push(finishCpp(cur));
      }
      if (!used) {
        var tm2 = cppTimes(seg), text = pickStr(seg.text);
        if (tm2 && text.trim() !== '' && spreadText(decodeEntities(text), tm2[0], tm2[1], raw)) spread = true;
      }
    }
    if (spread) {
      t.approximate = true;
      warnings.push('This whisper.cpp file has times for each sentence only, not for each word. Word times were spread evenly inside each sentence, so cuts are approximate. Everything will be listed for you to check. Run whisper.cpp with the full JSON option (-ojf) for word times.');
    }
    t.words = normaliseWordList(raw, 'whisper', warnings);
    if (!t.words.length) throw friendly('This whisper.cpp file has no words with times in it, so there is nothing to analyse.');
    t.engines.whisper = 'whisper.cpp';
    warnings.push('Word times from whisper.cpp can be a little rough; check the cut points.');
    warnings.push('This file has no audio information (silences and sounds), so dead space will be left for you to review.');
    return finishTranscript(t);
  }
  function finishCpp(cur) {
    var c = null;
    if (cur.ps.length) { var tot = 0; for (var i = 0; i < cur.ps.length; i++) tot += cur.ps[i]; c = tot / cur.ps.length; }
    return { w: cur.w, s: cur.s, e: cur.e, c: c, src: 'whisper' };
  }

  // --- a plain list of words from some other tool
  function fromWordList(list, warnings, obj) {
    var raw = [], noTimes = 0;
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      if (!isObj(w)) continue;
      var s = pickNum(w.start, w.s), e = pickNum(w.end, w.e);
      if (!isFinite(s) || !isFinite(e)) { noTimes++; continue; }
      raw.push({ w: pickStr(w.word, w.text, w.w, w.punctuated_word), s: s, e: e, c: pickNum(w.probability, w.confidence, w.score, w.prob, w.c, w.p), src: 'other' });
    }
    var t = newTranscript();
    fixMillis(raw, isObj(obj) ? pickNum(obj.audio_duration, obj.duration) : 0, warnings);
    t.words = normaliseWordList(raw, 'other', warnings);
    if (noTimes) warnings.push(noTimes + ' word' + (noTimes === 1 ? ' had' : 's had') + ' no time and ' + (noTimes === 1 ? 'was' : 'were') + ' left out.');
    if (!t.words.length) throw friendly('This file has a list of words but none of them have start and end times, so there is nothing to analyse.');
    warnings.push('This file has no audio information (silences and sounds), so dead space will be left for you to review.');
    return finishTranscript(t);
  }

  // --- SRT / VTT
  var TIME_LINE = /^\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d+)?)\s*-+>\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d+)?)/;
  function parseClock(str) {
    var m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d+))?$/.exec(str);
    if (!m) return NaN;
    return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number('0.' + m[4]) : 0);
  }

  function fromSubtitles(text, isVtt, warnings) {
    var lines = text.split('\n'), cues = [], cur = null, bad = 0, i;
    function flush() { if (cur) { cues.push(cur); cur = null; } }
    for (i = 0; i < lines.length; i++) {
      var line = lines[i], m = TIME_LINE.exec(line);
      if (m) {
        if (cur && cur.lines.length && /^\d+$/.test(cur.lines[cur.lines.length - 1].trim())) cur.lines.pop(); // next cue's index line
        flush();
        var a = parseClock(m[1]), b = parseClock(m[2]);
        if (isFinite(a) && isFinite(b) && b > a) cur = { s: a, e: b, lines: [] };
        else { bad++; cur = null; }
      } else if (line.trim() === '') {
        flush();
      } else if (cur) {
        cur.lines.push(line);
      }
    }
    flush();
    if (!cues.length) throw friendly('No captions with times were found in this ' + (isVtt ? 'VTT' : 'SRT') + ' file. Is it the right file?');
    if (bad) warnings.push(bad + ' caption' + (bad === 1 ? ' was' : 's were') + ' skipped because ' + (bad === 1 ? 'its' : 'their') + ' times could not be read.');
    var raw = [];
    for (i = 0; i < cues.length; i++) {
      var tx = cues[i].lines.join(' ').replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/\[[^\]]*\]/g, ' ');
      spreadText(decodeEntities(tx), cues[i].s, cues[i].e, raw);
    }
    var t = newTranscript();
    t.approximate = true;
    t.words = normaliseWordList(raw, 'other', warnings);
    if (!t.words.length) throw friendly('The captions in this file have no words in them, so there is nothing to analyse.');
    warnings.unshift('This is a subtitle file (' + (isVtt ? 'VTT' : 'SRT') + '). It only has times for each caption, not for each word, so word times were spread evenly inside each caption and cuts are approximate. Everything will be listed for you to check. For exact timing use the helper script.');
    warnings.push('This file has no audio information (silences and sounds), so dead space will be left for you to review.');
    return finishTranscript(t);
  }

  // --- entry point
  function decodeBytes(buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer || buf);
    if (typeof TextDecoder === 'function') {
      var enc = 'utf-8';
      if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) enc = 'utf-16le';
      else if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) enc = 'utf-16be';
      return new TextDecoder(enc).decode(u8);
    }
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  // True when a list of {text|word, start, end} items is one word per item (not one sentence per item). Looks at up to 400
  // items spread over the whole list: at most 5 percent may contain a space, and the typical item must be short (seconds
  // or milliseconds).
  function looksLikeWordArray(list) {
    var n = Math.min(list.length, 400), step = Math.max(1, Math.floor(list.length / n)), seen = 0, multi = 0, durs = [], i;
    for (i = 0; i < list.length && seen < n; i += step) {
      var it = list[i];
      if (!isObj(it)) return false;
      var txt = pickStr(it.word, it.text, it.w), s = pickNum(it.start, it.s), e = pickNum(it.end, it.e);
      if (typeof txt !== 'string' || !isFinite(s) || !isFinite(e)) return false;
      seen++;
      if (/\s/.test(txt.trim())) multi++;
      durs.push(e - s);
    }
    if (seen < 3 || multi > seen * 0.05) return false;
    durs.sort(function (a, b) { return a - b; });
    var med = durs[Math.floor(durs.length / 2)];
    return med <= 3 || (med >= 20 && med <= 3000);   // seconds, or milliseconds (fixMillis converts those later)
  }

  function fromJson(obj, warnings) {
    if (Array.isArray(obj)) {
      var f = obj.length ? obj[0] : null;
      if (!obj.length) throw friendly('This file is an empty list, so there is nothing to analyse.');
      if (!isObj(f)) throw friendly(NOT_A_TRANSCRIPT);
      // A plain list of {text,start,end} where every text is ONE word (Parakeet and many other tools write this) has a time
      // for each word. Only a list whose texts are whole sentences is a list of segments.
      if (Array.isArray(f.words)) obj = { segments: obj };
      else if (('start' in f) && ('text' in f) && !('word' in f) && !looksLikeWordArray(obj)) obj = { segments: obj };
      else if ((('word' in f) || ('text' in f) || ('w' in f)) && (('start' in f) || ('s' in f))) obj = { words: obj };
      else throw friendly(NOT_A_TRANSCRIPT);
    }
    if (!isObj(obj)) throw friendly(NOT_A_TRANSCRIPT);
    var w0 = Array.isArray(obj.words) && obj.words.length ? obj.words[0] : null;
    var canonWords = isObj(w0) && ('w' in w0) && ('s' in w0) && ('e' in w0);
    if (obj.format === 'video-review-transcript' || (canonWords && !Array.isArray(obj.segments))) {
      return { format: 'video-review-transcript', transcript: fromCanonical(obj, warnings) };
    }
    if (typeof obj.format === 'string' && /^video-review/.test(obj.format)) {
      throw friendly('This looks like another kind of Video Redline file, not a transcript. Open it with the matching button instead.');
    }
    if (Array.isArray(obj.segments)) return { format: 'whisper-json', transcript: fromWhisperSegments(obj.segments, warnings, obj) };
    if (Array.isArray(obj.transcription)) return { format: 'whisper-cpp-json', transcript: fromWhisperCpp(obj.transcription, warnings, obj) };
    if (isObj(obj.result) && Array.isArray(obj.result.segments)) return { format: 'whisper-json', transcript: fromWhisperSegments(obj.result.segments, warnings, obj.result) };
    var dg = obj.results && Array.isArray(obj.results.channels) && obj.results.channels[0] && Array.isArray(obj.results.channels[0].alternatives) ? obj.results.channels[0].alternatives[0] : null;
    if (dg && Array.isArray(dg.words)) return { format: 'word-list', transcript: fromWordList(dg.words, warnings, obj) };
    if (Array.isArray(obj.word_segments) && obj.word_segments.length) return { format: 'word-list', transcript: fromWordList(obj.word_segments, warnings, obj) };
    if (Array.isArray(obj.words)) {
      if (!obj.words.length) { var e0 = fromCanonical(obj, warnings); return { format: 'video-review-transcript', transcript: e0 }; }
      return { format: 'word-list', transcript: fromWordList(obj.words, warnings, obj) };
    }
    throw friendly(NOT_A_TRANSCRIPT);
  }

  function parseTranscript(text) {
    var warnings = [];
    if (text && typeof text === 'object' && typeof text.byteLength === 'number') text = decodeBytes(text);
    var obj = null, s;
    if (isObj(text) || Array.isArray(text)) obj = text;
    else if (typeof text === 'string') s = text;
    else throw friendly('That file could not be read as text. Pick the transcript file (.json, .srt or .vtt).');

    if (obj === null) {
      s = s.replace(/^[\uFEFF\u200B]+/, '').replace(/\r\n?/g, '\n');
      var trimmed = s.trim();
      if (trimmed === '') throw friendly('That file is empty, so there is no transcript to read.');
      var first = trimmed.charAt(0);
      if (first === '{' || first === '[') {
        try { obj = JSON.parse(trimmed); }
        catch (ignore) {
          if (first === '{' || trimmed.indexOf('-->') === -1) {
            throw friendly('This file looks like a JSON transcript, but it is damaged or cut off, so it cannot be read. Try making the transcript again.');
          }
        }
      }
      if (obj === null) {
        var isVtt = /^WEBVTT/.test(trimmed);
        if (isVtt || trimmed.indexOf('-->') !== -1) {
          var sub = fromSubtitles(s, isVtt, warnings);
          return { transcript: sub, format: isVtt ? 'vtt' : 'srt', warnings: warnings };
        }
        throw friendly(NOT_A_TRANSCRIPT);
      }
    }
    var res = fromJson(obj, warnings);
    return { transcript: res.transcript, format: res.format, warnings: warnings };
  }

  /* ------------------------------------------------------------------ validateTranscript */
  function validateTranscript(obj) {
    var errors = [], warnings = [];
    function err(m) { if (errors.length < MAX_ERRORS) errors.push(m); else if (errors.length === MAX_ERRORS) errors.push('...and more problems like these.'); }
    if (!isObj(obj)) return { ok: false, errors: ['The transcript is not an object.'], warnings: warnings };
    if (obj.format !== undefined && obj.format !== 'video-review-transcript') err('The file says its format is ' + q(String(obj.format)) + ', not \u201Cvideo-review-transcript\u201D.');
    if (obj.version !== undefined && !isFinite(num(obj.version, NaN))) err('The version is not a number.');
    if (!Array.isArray(obj.words)) {
      err('The list of words is missing.');
    } else {
      var lastS = -Infinity, unsorted = false;
      for (var i = 0; i < obj.words.length; i++) {
        var w = obj.words[i], label = 'Word ' + (i + 1);
        if (!isObj(w)) { err(label + ' is not an object.'); continue; }
        if (typeof w.w !== 'string') err(label + ' has no text.');
        else label += ' (' + q(w.w) + ')';
        var s = w.s, e = w.e;
        if (typeof s !== 'number' || !isFinite(s)) err(label + ' has a start time that is not a number.');
        else if (s < 0) err(label + ' has a negative start time.');
        if (typeof e !== 'number' || !isFinite(e)) err(label + ' has an end time that is not a number.');
        else if (e < 0) err(label + ' has a negative end time.');
        if (typeof s === 'number' && typeof e === 'number' && isFinite(s) && isFinite(e)) {
          if (e < s) err(label + ' ends before it starts.');
          if (s < lastS) unsorted = true;
          lastS = s;
        }
        if (w.c !== undefined && w.c !== null && (typeof w.c !== 'number' || !isFinite(w.c) || w.c < 0 || w.c > 1)) err(label + ' has a confidence that is not between 0 and 1.');
        if (w.src !== undefined && w.src !== 'parakeet' && w.src !== 'whisper' && w.src !== 'both' && w.src !== 'other') err(label + ' has an unknown source (expected parakeet, whisper or both).');
      }
      if (unsorted) warnings.push('The words are not in time order; they will be sorted when the file is opened.');
    }
    if (obj.silences !== undefined) {
      if (!Array.isArray(obj.silences)) err('The list of silences is not a list.');
      else for (var a = 0; a < obj.silences.length; a++) {
        var sl = obj.silences[a];
        if (!isObj(sl) || typeof sl.s !== 'number' || typeof sl.e !== 'number' || !isFinite(sl.s) || !isFinite(sl.e) || sl.e <= sl.s || sl.s < 0) err('Silence ' + (a + 1) + ' does not have a valid start and end.');
      }
    }
    if (obj.sounds !== undefined) {
      if (!Array.isArray(obj.sounds)) err('The list of sounds is not a list.');
      else for (var b = 0; b < obj.sounds.length; b++) {
        var sn = obj.sounds[b];
        if (!isObj(sn) || typeof sn.s !== 'number' || typeof sn.e !== 'number' || !isFinite(sn.s) || !isFinite(sn.e) || sn.e <= sn.s || sn.s < 0) err('Sound ' + (b + 1) + ' does not have a valid start and end.');
        else if (!SOUND_KINDS[sn.kind]) err('Sound ' + (b + 1) + ' has an unknown kind (expected voiced, noise, breath or click).');
      }
    }
    if (obj.video !== undefined && !isObj(obj.video)) err('The video details are missing or wrong.');
    else if (isObj(obj.video) && obj.video.duration !== undefined && (typeof obj.video.duration !== 'number' || !isFinite(obj.video.duration) || obj.video.duration < 0)) err('The video duration is not a valid number.');
    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  }

  return {
    version: VERSION,
    KINDS: KINDS.slice(),
    DEFAULTS: DEFAULTS,
    // 1.2.0: how much the finder applies on its own. Pass { level: 'balanced' } (or any single param) to analyze().
    PRESETS: PRESETS,
    LEVELS: [
      { id: 'careful', label: 'Careful', help: 'Applies only what it is very sure about. Anything with a sound inside, or a long pause, waits for you.' },
      { id: 'balanced', label: 'Balanced', help: 'Also applies pauses with a small click, tap or breath inside, and trims a silent start or end. Long pauses (over 10 seconds) wait for you.' },
      { id: 'thorough', label: 'Thorough', help: 'Applies most pauses, even long ones (up to 20 seconds), and is quicker to apply ums. Check the result with the Preview button.' }
    ],
    parseTranscript: parseTranscript,
    validateTranscript: validateTranscript,
    analyze: analyze,
    scoreFingerprint: scoreFingerprint,
    mergeCuts: mergeCuts,
    wordsInRange: wordsInRange,
    describeKind: describeKind,
    formatTime: formatTime
  };
}));
