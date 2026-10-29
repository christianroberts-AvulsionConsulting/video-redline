/*!
 * visuals.js  -  "visual templates" renderer for Video Redline.
 *
 * Draws a styled motion-design style overlay (list, steps, diagram, callout, highlight, lower-third,
 * title-card, big-number, quote, shortcut) inside a host element, from a Style (design tokens) and
 * some content. Offline, no dependencies, no DOM access at load time, ES2019 syntax at most.
 *
 *   VIS.KINDS            the 10 kinds (id, label, blurb, suits, fields, sample)
 *   VIS.OPTIONS          allowed option values (align, scale, bg, accent, pointer)
 *   VIS.OPTION_USE       which options each kind actually uses (see below)
 *   VIS.defaultKind(markerType)
 *   VIS.normalize(visual)            -> { kind, content:{title,body}, opts:{align,scale,bg,accent,pointer} }
 *   VIS.html(visual, style, w, h)    -> inner HTML string for a host of w x h px
 *   VIS.render(host, visual, style)  -> sets CSS vars + innerHTML on the host, then shrinks to fit if the browser says it overflows.
 *                                       A highlight whose label hangs OUTSIDE the ring also measures the room above / below the host
 *                                       (up to the nearest ancestor that clips) and sets overflow:visible on the host while it needs it
 *   VIS.describe(visual, style, opts) -> string[] (plain language build instructions for the markdown export; opts.aiText = the author did not type the words, opts.spoken = words said inside the marker)
 *   VIS.css()                        -> string (all CSS, every class prefixed vis-)
 *   VIS.escape(str)
 *
 * Notes for the page that uses it:
 *   - Inject VIS.css() once into a <style> element. All classes are prefixed vis-.
 *   - The host needs a definite width and height (VIS.render reads clientWidth / clientHeight) and should be positioned
 *     (relative / absolute). The visual fills it. Overlay content has pointer-events:none so the host keeps receiving events.
 *   - VIS.html() is pure and self-contained (every colour / font / size is an inline custom property on its root element), so
 *     it also works for export previews and thumbnails. VIS.render() additionally sets the style tokens on the host and, when
 *     the browser reports that the result overflows its box, shrinks the font size in 8% steps (at most 10 times).
 *   - Sizes are estimated from character widths of the font stacks (conservative, about 7-10% wide for common fonts), so text
 *     is a little smaller than the absolute maximum rather than risking overflow.
 *   - Text shrinks before a word is broken mid-word: a word is only broken when keeping it whole would cost more than 60% of the
 *     comfortable size (80% for diagrams), see solve().
 *   - Every piece of user text has dir="auto", so right-to-left text (Hebrew, Arabic, Persian) keeps its base direction. The
 *     zero width (non-)joiners U+200C / U+200D are kept, so emoji ZWJ sequences and Persian / Indic spelling survive.
 *
 * ---------------------------------------------------------------------------------------------
 * FIELD + OPTION SEMANTICS PER KIND  (title / body are the only two text fields)
 * ---------------------------------------------------------------------------------------------
 *  list         title = heading (optional). body = one bullet per line (max 12; "-", "*", "1." prefixes stripped).
 *               Wide hosts with 4+ bullets may flow into 2 columns automatically.
 *  steps        title = heading (optional). body = one step per line (max 12), numbered badges 1..n.
 *               A vertical rail joins the badges when left aligned and single column.
 *  diagram      title = heading (optional). body = nodes: one per line, or one line "A -> B -> C".
 *               "->", "-->", "=>" and the arrow glyph are always arrows. A bare ">" is an arrow only between plain words,
 *               never inside a comparison (">=100", "A1>B1", "Sales > 100"): see the rule above ARROW_RE. 2..8 nodes (extra ones are dropped,
 *               a lone node gets a dashed "..." partner). Horizontal when the host is wide, vertical when tall
 *               (picked by whichever gives the larger text). The last node is the accent (the result).
 *               align only moves the heading; the flow itself is always centred.
 *  callout      title = bold heading (optional). body = text (each line is a paragraph).
 *               pointer = which edge gets the tail (auto = down). The tail sits at the left / centre / right
 *               of the edge following align (left/right pointers sit at the middle of the side).
 *               Ignored (no tail) when bg = none. align also moves the accent bar (left / right / top rule).
 *  highlight    title = label chip text. body = optional second line in the chip. The host box itself is the ring:
 *               a rounded accent outline between a thin dark and a thin light keyline (so it reads on white and on dark footage),
 *               all drawn inside the host box, plus a glow. The inside stays transparent so the recording shows through.
 *               align = chip position along the top edge. bg: solid = accent chip, soft = translucent surface chip
 *               plus a faint accent wash inside the ring, none = chip text only (legible halo).
 *               The label is never smaller than 12 px. It hangs from the top edge INSIDE the ring while it covers little of the
 *               box (<= 22% of its height and 60% of its width); on a small or narrow box it sits just ABOVE the ring instead
 *               (plan.place 'out'), under it ('below') or, with no room at all, inside again ('in' + wide). VIS.html() cannot
 *               see the page and assumes room above; VIS.render() measures it. The host must not clip in that case; render()
 *               sets overflow:visible on it while needed and restores it afterwards.
 *  lower-third  title = name (max 2 lines). body = subtitle (max 2 lines). Content-sized bar anchored near the bottom
 *               of the host. align = left / centre / right placement of the bar. The text size is capped so a one-line name
 *               plus subtitle takes about a sixth of the height of a 16:9 host (scale 1.6 can still enlarge it in a strip).
 *  title-card   title = big centred title. body = subtitle. A short accent rule sits between them.
 *  big-number   title = the value, e.g. "40%", "$1.2M", "10x". Currency prefix and unit suffix are set smaller.
 *               body = label under the value. The value is the hero accent colour.
 *  quote        body = the quote. title = attribution. Large accent quote mark on top.
 *  shortcut     title = what it does. body = keys joined by "+", several shortcuts on separate lines.
 *               Optional label before a colon ("Windows: Ctrl + T", "Excel for Windows: Ctrl + B"; up to 24 characters, any script,
 *               kept whole: a label wider than its row ends in an ellipsis). Sequences use "," or "then" ("Alt, H, O, I").
 *               A literal plus key is written "Ctrl + +" or "Ctrl++". Glyphs are understood both ways:
 *               the command / option / shift / control / enter / tab / esc / delete symbols map to proper keycaps.
 *               The last key of each shortcut is the accent (hero) key.
 *
 *  Options (all kinds unless noted; see VIS.OPTION_USE):
 *   align    left | center | right      text alignment / element placement (defaults: list, steps, callout, highlight,
 *                                        lower-third, quote = left; diagram, title-card, big-number, shortcut = center)
 *   scale    0.6 .. 1.6                 multiplies the natural text size. The natural size is the largest size that
 *                                        fits, capped at a comfortable size, so scale > 1 only grows text while it
 *                                        still fits inside the box; scale < 1 always works.
 *   bg       solid | soft | none        solid = opaque surface; soft = surface at 88% + backdrop blur (plain 96% fallback);
 *                                        none = no panel, text gets a halo (surface coloured text-shadow).
 *   accent   '' or '#rrggbb'            overrides the style accent (the hero colour) for this visual only.
 *   pointer  auto|left|right|up|down|none   callout only.
 *
 * Style (design tokens) = { id, name, category, description, atmosphere, theme, source, t:{ bg, surface, fg, muted,
 *   border, accent, accent2?, success?, warn?, danger?, fd, fb, fm?, r, sh, fw, ls } }. Bad / missing tokens fall back
 *   to a built-in neutral style; the colours are repaired on the panel: text and muted text to 4.5:1, accent used as text
 *   (big number, quote mark) and as a decorative fill (bullets, bars, rules) to 3:1.
 */
var VIS = (function () {
  'use strict';

  /* ===========================================================================================
   * 1. small helpers
   * ========================================================================================= */
  function isStr(v) { return typeof v === 'string'; }
  function clamp(n, a, b) { return n < a ? a : (n > b ? b : n); }
  function num(v, d) {
    var n = (typeof v === 'number') ? v : (isStr(v) ? parseFloat(v) : NaN);
    return isFinite(n) ? n : d;
  }
  function rnd(n, p) { var k = Math.pow(10, p === undefined ? 2 : p); return Math.round(n * k) / k; }
  function px(n) { return rnd(n, 2) + 'px'; }
  function indexOf(arr, v) { return arr.indexOf(v); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function get(o, k) { return has(o, k) ? o[k] : undefined; }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;');
  }

  /**
   * user text -> safe plain string (control characters removed, CRLF -> LF, length capped).
   * Zero width space (200B), line / paragraph separators and the BOM are dropped. The zero width NON-joiner (200C) and
   * JOINER (200D) are KEPT: they are part of emoji ZWJ sequences (family, woman technologist...) and of Persian / Indic
   * spelling, so removing them changes the meaning of the text.
   */
  function clean(v, max) {
    if (v === null || v === undefined || typeof v === 'object' || typeof v === 'function') { return ''; }
    var s = String(v).replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\u2028\u2029\uFEFF]/g, '');
    if (s.length > max) {
      s = s.slice(0, max);
      var last = s.charCodeAt(s.length - 1);
      if (last >= 0xD800 && last <= 0xDBFF) { s = s.slice(0, -1); }
    }
    return s;
  }
  function oneLine(s) { return String(s).replace(/\s+/g, ' ').trim(); }
  function splitLines(s) {
    var out = [], parts = String(s).split('\n'), i, t;
    for (i = 0; i < parts.length; i++) {
      t = parts[i].replace(/[ \t\u00A0]+/g, ' ').trim();
      if (t) { out.push(t); }
    }
    return out;
  }
  var MARK_RE = /^\s*(?:[\u2022\u00B7\u25AA\u25B8\u25BA\u2023*]|-(?!>)|\d{1,2}[.)])\s+/;
  function stripMark(s) { return s.replace(MARK_RE, '').trim(); }

  /* ---- colour maths (hex strings only) ---- */
  function hexNorm(c) {
    if (!isStr(c)) { return ''; }
    var s = c.trim().toLowerCase();
    var m = /^#([0-9a-f]{3})$/.exec(s);
    if (m) { s = '#' + m[1].charAt(0) + m[1].charAt(0) + m[1].charAt(1) + m[1].charAt(1) + m[1].charAt(2) + m[1].charAt(2); }
    return /^#[0-9a-f]{6}$/.test(s) ? s : '';
  }
  function rgbOf(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function hexOf(rgb) {
    var out = '#', i, v;
    for (i = 0; i < 3; i++) { v = Math.round(clamp(rgb[i], 0, 255)); out += (v < 16 ? '0' : '') + v.toString(16); }
    return out;
  }
  function mix(a, b, t) {
    var A = rgbOf(a), B = rgbOf(b);
    return hexOf([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
  }
  function lin(v) { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function lum(h) { var c = rgbOf(h); return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); }
  function contrast(a, b) {
    var la = lum(a), lb = lum(b), hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }
  function rgba(h, a) { var c = rgbOf(h); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function inkOn(h) { return contrast(h, '#ffffff') >= contrast(h, '#111111') ? '#ffffff' : '#111111'; }
  /** mix colour c towards `toward` in 5% steps until it reaches contrast `target` against `on` (or has become `toward`). */
  function pull(c, toward, target, on) {
    var j, cand = c;
    for (j = 1; j <= 20; j++) {
      cand = mix(c, toward, j * 0.05);
      if (contrast(cand, on) >= target) { return cand; }
    }
    return cand;
  }
  var MIN_TEXT = 4.5, MIN_LARGE = 3;

  /* ===========================================================================================
   * 2. kinds, options, defaults
   * ========================================================================================= */
  var KINDS = [
    {
      id: 'list', label: 'Bullet list',
      blurb: 'A heading with one bullet point per line.',
      suits: ['list', 'visual'],
      fields: [
        { key: 'title', label: 'Heading', placeholder: 'Why use tables?', rows: 1 },
        { key: 'body', label: 'Bullets (one per line)', placeholder: 'One bullet per line', rows: 5 }
      ],
      sample: { title: 'Why use tables', body: 'Ranges grow automatically as you add rows\nBuilt-in filter and sort buttons\nFormulas fill down on their own\nBanded rows keep data readable' }
    },
    {
      id: 'steps', label: 'Numbered steps',
      blurb: 'A heading with numbered steps, one step per line.',
      suits: ['list', 'visual'],
      fields: [
        { key: 'title', label: 'Heading', placeholder: 'Create a PivotTable', rows: 1 },
        { key: 'body', label: 'Steps (one per line)', placeholder: 'One step per line', rows: 5 }
      ],
      sample: { title: 'Create a PivotTable', body: 'Click any cell inside your data\nOpen the Insert tab\nChoose PivotTable\nDrag fields into Rows and Values' }
    },
    {
      id: 'diagram', label: 'Flow diagram',
      blurb: 'Two to eight boxes joined by arrows, laid out to suit the box shape.',
      suits: ['diagram'],
      fields: [
        { key: 'title', label: 'Heading (optional)', placeholder: 'How the data flows', rows: 1 },
        { key: 'body', label: 'Boxes (one per line, or A -> B -> C)', placeholder: 'Raw data -> Clean up -> PivotTable -> Chart', rows: 4 }
      ],
      sample: { title: 'How the data flows', body: 'Raw data -> Clean up -> PivotTable -> Chart' }
    },
    {
      id: 'callout', label: 'Callout',
      blurb: 'A card with a small pointer tail that points at something on screen.',
      suits: ['callout', 'visual'],
      fields: [
        { key: 'title', label: 'Heading (optional)', placeholder: 'Pro tip', rows: 1 },
        { key: 'body', label: 'Text', placeholder: 'Press F4 to switch between absolute and relative references.', rows: 3 }
      ],
      sample: { title: 'Pro tip', body: 'Press F4 to switch between absolute and relative cell references.' }
    },
    {
      id: 'highlight', label: 'Highlight box',
      blurb: 'A glowing outline around part of the screen with a small label tab.',
      suits: ['visual', 'callout'],
      fields: [
        { key: 'title', label: 'Label', placeholder: 'Click here', rows: 1 },
        { key: 'body', label: 'Small caption (optional)', placeholder: 'Totals update automatically', rows: 1 }
      ],
      sample: { title: 'Total column', body: 'Updates automatically' }
    },
    {
      id: 'lower-third', label: 'Lower third',
      blurb: 'A name bar near the bottom of the screen: name plus a small subtitle.',
      suits: ['lower-third'],
      fields: [
        { key: 'title', label: 'Name', placeholder: 'Alex Morgan', rows: 1 },
        { key: 'body', label: 'Subtitle', placeholder: 'Spreadsheet trainer', rows: 1 }
      ],
      sample: { title: 'Alex Morgan', body: 'Spreadsheet trainer' }
    },
    {
      id: 'title-card', label: 'Title card',
      blurb: 'A big centred title with a subtitle underneath.',
      suits: ['visual'],
      fields: [
        { key: 'title', label: 'Title', placeholder: 'Excel Pivot Tables', rows: 2 },
        { key: 'body', label: 'Subtitle', placeholder: 'Part 2 of the series', rows: 2 }
      ],
      sample: { title: 'Excel Pivot Tables', body: 'Summarise thousands of rows in seconds' }
    },
    {
      id: 'big-number', label: 'Big number',
      blurb: 'One huge value with a short label, great for results and stats.',
      suits: ['visual'],
      fields: [
        { key: 'title', label: 'Value', placeholder: '40%', rows: 1 },
        { key: 'body', label: 'Label', placeholder: 'less time spent on reports', rows: 2 }
      ],
      sample: { title: '40%', body: 'less time spent on monthly reports' }
    },
    {
      id: 'quote', label: 'Quote',
      blurb: 'A large quotation with an attribution line.',
      suits: ['visual'],
      fields: [
        { key: 'title', label: 'Who said it', placeholder: 'Priya Shah, Finance Lead', rows: 1 },
        { key: 'body', label: 'Quote', placeholder: 'Learning shortcuts cut my reporting time in half.', rows: 4 }
      ],
      sample: { title: 'Priya Shah, Finance Lead', body: 'Learning keyboard shortcuts cut my reporting time in half.' }
    },
    {
      id: 'shortcut', label: 'Keyboard shortcut',
      blurb: 'Keycaps for one or more shortcuts, like Ctrl + Shift + L.',
      suits: ['visual', 'callout'],
      fields: [
        { key: 'title', label: 'What it does', placeholder: 'Insert a table', rows: 1 },
        { key: 'body', label: 'Keys joined by + (one shortcut per line)', placeholder: 'Windows: Ctrl + T\nMac: \u2318 + T', rows: 3 }
      ],
      sample: { title: 'Insert a table', body: 'Windows: Ctrl + T\nMac: \u2318 + T' }
    }
  ];
  var KIND_IDS = KINDS.map(function (k) { return k.id; });

  var OPTIONS = {
    align: ['left', 'center', 'right'],
    scale: [0.6, 0.75, 0.9, 1, 1.15, 1.3, 1.45, 1.6],
    scaleRange: { min: 0.6, max: 1.6, step: 0.05, def: 1 },
    bg: ['solid', 'soft', 'none'],
    accent: '',
    accentFormat: '#rrggbb',
    pointer: ['auto', 'left', 'right', 'up', 'down', 'none']
  };

  var OPTION_USE = {
    'list': ['align', 'scale', 'bg', 'accent'],
    'steps': ['align', 'scale', 'bg', 'accent'],
    'diagram': ['align', 'scale', 'bg', 'accent'],
    'callout': ['align', 'scale', 'bg', 'accent', 'pointer'],
    'highlight': ['align', 'scale', 'bg', 'accent'],
    'lower-third': ['align', 'scale', 'bg', 'accent'],
    'title-card': ['align', 'scale', 'bg', 'accent'],
    'big-number': ['align', 'scale', 'bg', 'accent'],
    'quote': ['align', 'scale', 'bg', 'accent'],
    'shortcut': ['align', 'scale', 'bg', 'accent']
  };

  var KIND_ALIGN = {
    'list': 'left', 'steps': 'left', 'diagram': 'center', 'callout': 'left', 'highlight': 'left',
    'lower-third': 'left', 'title-card': 'center', 'big-number': 'center', 'quote': 'left', 'shortcut': 'center'
  };

  function kindById(id) {
    for (var i = 0; i < KINDS.length; i++) { if (KINDS[i].id === id) { return KINDS[i]; } }
    return KINDS[6];
  }

  function defaultKind(markerType) {
    var t = isStr(markerType) ? markerType.toLowerCase().replace(/[\s_]+/g, '-') : '';
    if (t === 'list') { return 'list'; }
    if (t === 'diagram') { return 'diagram'; }
    if (t === 'callout') { return 'callout'; }
    if (t === 'lower-third' || t === 'lowerthird') { return 'lower-third'; }
    return 'title-card';
  }

  function resolveKind(k, fallbackType) {
    if (isStr(k)) {
      var s = k.toLowerCase().trim().replace(/[\s_]+/g, '-');
      if (indexOf(KIND_IDS, s) >= 0) { return s; }
      var compact = s.replace(/-/g, ''), i;
      for (i = 0; i < KIND_IDS.length; i++) { if (KIND_IDS[i].replace(/-/g, '') === compact) { return KIND_IDS[i]; } }
      var alias = { title: 'title-card', number: 'big-number', stat: 'big-number', keys: 'shortcut', keyboard: 'shortcut', bullets: 'list', flow: 'diagram', ring: 'highlight', box: 'highlight', name: 'lower-third' };
      if (has(alias, s)) { return alias[s]; }
    }
    return defaultKind(fallbackType);
  }

  function normalize(v) {
    var o = (v && typeof v === 'object') ? v : {};
    var kind = resolveKind(o.kind, o.markerType || o.type || 'visual');
    var c = (o.content && typeof o.content === 'object') ? o.content : (isStr(o.content) ? { body: o.content } : o);
    var op = (o.opts && typeof o.opts === 'object') ? o.opts : ((o.options && typeof o.options === 'object') ? o.options : {});
    var align = (isStr(op.align) && indexOf(OPTIONS.align, op.align.toLowerCase()) >= 0) ? op.align.toLowerCase() : KIND_ALIGN[kind];
    var bg = (isStr(op.bg) && indexOf(OPTIONS.bg, op.bg.toLowerCase()) >= 0) ? op.bg.toLowerCase() : 'solid';
    var pointer = (isStr(op.pointer) && indexOf(OPTIONS.pointer, op.pointer.toLowerCase()) >= 0) ? op.pointer.toLowerCase() : 'auto';
    return {
      kind: kind,
      content: { title: clean(c.title, 300), body: clean(c.body, 4000) },
      opts: {
        align: align,
        scale: rnd(clamp(num(op.scale, 1), 0.6, 1.6), 2),
        bg: bg,
        accent: hexNorm(op.accent),
        pointer: pointer
      }
    };
  }

  /* ===========================================================================================
   * 3. style tokens
   * ========================================================================================= */
  var DEFAULT_STYLE = {
    id: 'studio-light', name: 'Studio Light', category: 'Clean',
    description: 'Neutral light card with a blue accent, used when no style is chosen.',
    atmosphere: 'Clean, bright and friendly, like a modern app UI.',
    theme: 'light', source: 'custom',
    t: {
      bg: '#f4f5f7', surface: '#ffffff', fg: '#14161a', muted: '#5b6370', border: '#dfe2e8',
      accent: '#2f6df6', accent2: '#7c4dff', success: '#1f9d55', warn: '#d98e04', danger: '#d64545',
      fd: '"Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif',
      fb: '"Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif',
      fm: 'Consolas, Menlo, "Courier New", monospace',
      r: 14, sh: '0 10px 30px rgba(15,23,42,.18)', fw: 700, ls: -0.01
    }
  };

  var GENERIC_RE = /(^|,)\s*(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded)\s*$/i;
  function stack(v, dflt, mono) {
    var s = isStr(v) ? v.replace(/\s+/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '') : '';
    if (/[^A-Za-z0-9 ,'"_.\-]/.test(s)) { return dflt; }   // anything unusual (brackets, semicolons, slashes...) -> built-in stack
    if (s.length < 3 || s.length > 300) { return dflt; }
    if ((s.match(/"/g) || []).length % 2 || (s.match(/'/g) || []).length % 2) { return dflt; }
    if (!GENERIC_RE.test(s)) { s += mono ? ', monospace' : ', sans-serif'; }
    return s;
  }

  var SHADOW_FN = { rgb: 1, rgba: 1, hsl: 1, hsla: 1 };
  function cleanShadow(v) {
    if (!isStr(v)) { return 'none'; }
    var s = v.trim();
    if (!s || s.toLowerCase() === 'none') { return 'none'; }
    if (s.length > 200 || !/^[a-z0-9\s.,#()%\-]+$/i.test(s)) { return 'none'; }
    var depth = 0, i, ch;
    for (i = 0; i < s.length; i++) {
      ch = s.charAt(i);
      if (ch === '(') { depth++; } else if (ch === ')') { depth--; if (depth < 0) { return 'none'; } }
    }
    if (depth !== 0) { return 'none'; }
    var fns = s.match(/[a-z]+(?=\()/gi) || [];
    for (i = 0; i < fns.length; i++) { if (!has(SHADOW_FN, fns[i].toLowerCase())) { return 'none'; } }
    return s;
  }
  function scaleShadow(s, k) {
    if (s === 'none') { return s; }
    return s.replace(/(-?\d*\.?\d+)px/g, function (m, n) { return rnd(parseFloat(n) * k, 2) + 'px'; });
  }

  /** the full, sanitised token set used by the renderer. */
  function tokens(style, accentOverride) {
    var st = (style && typeof style === 'object') ? style : {};
    var t = (st.t && typeof st.t === 'object') ? st.t : {};
    var D = DEFAULT_STYLE.t, T = {}, k, keys = ['bg', 'surface', 'fg', 'muted', 'border', 'accent'];
    for (var i = 0; i < keys.length; i++) { k = keys[i]; T[k] = hexNorm(t[k]) || D[k]; }
    T.accent2 = hexNorm(t.accent2) || T.accent;
    T.success = hexNorm(t.success) || D.success;
    T.warn = hexNorm(t.warn) || D.warn;
    T.danger = hexNorm(t.danger) || D.danger;
    T.theme = st.theme === 'dark' ? 'dark' : (st.theme === 'light' ? 'light' : (lum(T.surface) < 0.3 ? 'dark' : 'light'));
    // contrast repair. Text colours move as little as possible towards black / white (or towards the text colour) in 5% steps.
    //   body text      >= 4.5:1 on the panel
    //   muted text     >= 4.5:1 on the panel (it carries real content: subtitles, labels, attributions, platform names)
    //   accent as text >= 3:1 on the panel (it is only used for large text: the big number and the quote mark) and, for the
    //                     decorative accent fills (bullets, bars, rules), as the colour of the fill
    if (contrast(T.fg, T.surface) < MIN_TEXT) { T.fg = pull(T.fg, lum(T.surface) > 0.179 ? '#000000' : '#ffffff', MIN_TEXT, T.surface); }
    if (contrast(T.muted, T.surface) < MIN_TEXT) { T.muted = pull(T.muted, T.fg, MIN_TEXT, T.surface); }
    if (T.border === T.surface) { T.border = mix(T.surface, T.fg, 0.14); }
    if (accentOverride) { T.accent = accentOverride; if (!hexNorm(t.accent2)) { T.accent2 = accentOverride; } }
    T.ink = inkOn(T.accent);
    T.accTx = T.accent;
    if (contrast(T.accTx, T.surface) < MIN_LARGE) { T.accTx = pull(T.accent, T.fg, MIN_LARGE, T.surface); }
    // inset fills (diagram boxes, keycaps): the style's page background when it contrasts enough with the text, else a tint of the surface
    T.s2 = (T.bg !== T.surface && contrast(T.fg, T.bg) >= 4.2 && contrast(T.bg, T.surface) >= 1.03) ? T.bg : mix(T.surface, T.fg, 0.06);
    // keycaps must look raised. On a dark panel the page background is DARKER than the panel and would read as a recessed well, so
    // the cap is lifted towards the text colour and the lip below it is a darker shade of the panel. On a light panel the old rule stands.
    T.dark = lum(T.surface) < 0.3;
    T.key = T.dark ? mix(T.surface, T.fg, 0.12) : (T.s2 === T.bg ? T.bg : mix(T.surface, T.fg, 0.045));
    T.keyEdge = T.dark ? mix(T.surface, '#000000', 0.6) : mix(T.key, '#000000', 0.34);
    T.keyHi = T.dark ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.6)';
    T.accEdge = mix(T.accent, '#000000', 0.32);
    T.fd = stack(t.fd, D.fd, false);
    T.fb = stack(t.fb, D.fb, false);
    T.fm = stack(t.fm, D.fm, true);
    T.r = clamp(num(t.r, D.r), 0, 48);
    T.sh = cleanShadow(t.sh === undefined ? D.sh : t.sh);
    T.fw = clamp(Math.round(num(t.fw, D.fw) / 100) * 100, 400, 900);
    T.fwq = clamp(T.fw, 400, 600);
    T.ls = rnd(clamp(num(t.ls, D.ls), -0.1, 0.3), 3);
    return T;
  }

  /** geometry that depends on the host size only. u = 1 at roughly a 560 px wide card. */
  function geom(W, H, T, bg) {
    var u = clamp(Math.min(W, H * 1.7) / 560, 0.06, 4);
    var r = T.r * u;
    return {
      u: u,
      r: r, r2: r * 0.55, r3: r * 0.3,
      br: T.r >= 22 ? '999px' : px(Math.max(T.r > 0 ? 0.5 : 0, r * 0.7)),
      bw: clamp(1.2 * u, 0.6, 3.2),
      blur: clamp(12 * u, 1, 28),
      sh: bg === 'none' ? 'none' : scaleShadow(T.sh, u)
    };
  }

  /* ===========================================================================================
   * 4. text measuring (estimates how many lines text wraps to, so the font size can be fitted)
   * ========================================================================================= */
  var FONT_FACTORS = [
    ['arial black', 1.32], ['archivo black', 1.2], ['black', 1.12], ['verdana', 1.17], ['tahoma', 1.03], ['inter', 1.05], ['georgia', 1.07], ['poppins', 1.1], ['montserrat', 1.14],
    ['trebuchet', 1.02], ['century gothic', 1.1], ['gothic', 1.05], ['segoe', 0.99], ['roboto', 0.99], ['open sans', 1.04],
    ['lato', 0.99], ['nunito', 1], ['space grotesk', 1.06], ['dm sans', 1.04], ['playfair', 1.04], ['merriweather', 1.12],
    ['garamond', 0.9], ['times', 0.92], ['palatino', 1.0], ['book antiqua', 1.0], ['cambria', 0.98], ['rockwell', 1.08],
    ['impact', 0.78], ['oswald', 0.72], ['bebas', 0.68], ['condensed', 0.74], ['narrow', 0.76], ['anton', 0.74],
    ['comic', 1.1], ['futura', 1.0], ['avenir', 1.0], ['helvetica', 1.0], ['arial', 1.0], ['calibri', 0.92], ['candara', 0.96],
    ['optima', 0.98], ['gill sans', 0.95], ['rounded', 1.02], ['system-ui', 1.0], ['ui-sans-serif', 1.0], ['sf pro', 1.0],
    ['-apple-system', 1.0], ['blinkmacsystemfont', 1.0], ['serif', 1.0], ['sans-serif', 1.0]
  ];
  var MONO_NAMES = ['courier', 'consolas', 'menlo', 'monaco', 'mono', 'jetbrains', 'fira code', 'source code', 'lucida console', 'andale', 'monospace', 'ui-monospace', 'sf mono'];
  var fontCache = {};
  function fontInfo(stackStr) {
    if (fontCache[stackStr]) { return fontCache[stackStr]; }
    var parts = stackStr.toLowerCase().replace(/["']/g, '').split(','), i, j, p, f = 0, mono = false, firstNamed = true;
    for (i = 0; i < parts.length; i++) {
      p = parts[i].trim();
      if (!p) { continue; }
      if (firstNamed) {
        for (j = 0; j < MONO_NAMES.length; j++) { if (p.indexOf(MONO_NAMES[j]) >= 0) { mono = true; } }
        firstNamed = false;
      }
      var matched = false;
      for (j = 0; j < FONT_FACTORS.length; j++) {
        if (p.indexOf(FONT_FACTORS[j][0]) >= 0) { f = Math.max(f, FONT_FACTORS[j][1]); matched = true; break; }
      }
      if (!matched) { f = Math.max(f, 1.04); }
      if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/.test(p)) { break; }
    }
    var info = { ff: f || 1.04, mono: mono };
    fontCache[stackStr] = info;
    return info;
  }
  function profile(stackStr, weight, ls) {
    var f = fontInfo(stackStr);
    return { ff: f.ff, mono: f.mono, wf: 1 + Math.max(0, weight - 400) / 100 * 0.028, ls: ls || 0 };
  }

  var W27 = ' ijl.,:;\'`|!I\u00A0';
  var W33 = 'trf()[]{}-"/\\*^~';
  var W50 = 'acekszvxyJ';
  var W56 = 'bdghnopqu0123456789$#?_';
  var W58 = '+=<>';
  var W70 = 'ABCDEFGHKNOPQRSTUVXYZ';
  function charEm(code, ch) {
    if (code < 0x80) {
      if (W27.indexOf(ch) >= 0) { return 0.27; }
      if (W33.indexOf(ch) >= 0) { return 0.34; }
      if (W50.indexOf(ch) >= 0) { return 0.5; }
      if (W56.indexOf(ch) >= 0) { return 0.57; }
      if (W58.indexOf(ch) >= 0) { return 0.59; }
      if (W70.indexOf(ch) >= 0) { return 0.71; }
      if (ch === 'L') { return 0.58; }
      if (ch === 'm' || ch === 'M' || ch === '%') { return 0.88; }
      if (ch === 'w') { return 0.76; }
      if (ch === 'W') { return 0.96; }
      if (ch === '@') { return 1.0; }
      if (ch === '&') { return 0.7; }
      return 0.6;
    }
    if (code === 0x2014) { return 1.0; }
    if (code === 0x2013) { return 0.56; }
    if (code >= 0x2E80) { return 1.0; }
    if (code >= 0x2190 && code <= 0x23FF) { return 0.95; }
    if (code < 0x250) { return 0.58; }
    return 0.65;
  }
  var SAFETY = 1.05;
  /** width of one unwrapped line in em units (font size 1). */
  function emWidth(text, pf) {
    var total = 0, n = 0, i, c, joined = false, d;
    for (i = 0; i < text.length; i++) {
      c = text.charCodeAt(i);
      if (c === 0x200D) { joined = true; continue; }   // zero width joiner: the glyph after it is part of the same cluster
      // zero width: ZWSP / ZWNJ / LRM / RLM / word joiner, variation selectors, combining diacritics
      if (c === 0x200B || c === 0x200C || c === 0x200E || c === 0x200F || c === 0x2060 || (c >= 0xFE00 && c <= 0xFE0F) || (c >= 0x0300 && c <= 0x036F)) { continue; }
      if (c >= 0xD800 && c <= 0xDBFF) {
        d = text.charCodeAt(i + 1);
        // emoji skin tone modifiers (U+1F3FB..1F3FF) and glyphs joined by a ZWJ add no width of their own
        if (!joined && !(c === 0xD83C && d >= 0xDFFB && d <= 0xDFFF)) { total += 1.15; n++; }
        i++; joined = false; continue;
      }
      if (joined) {   // a BMP emoji symbol joined to the previous glyph (female sign, heart...) is part of that cluster; letters still count
        joined = false;
        if (c >= 0x2190 && c <= 0x2BFF) { continue; }
      }
      total += pf.mono ? 0.62 : charEm(c, text.charAt(i));
      n++;
    }
    if (!pf.mono) { total = total * pf.ff * pf.wf; }
    return (total + n * pf.ls) * SAFETY;
  }
  /** greedy wrap simulation. returns { n: lines, w: widest line (px), longest: widest single word (px) }. */
  function wrap(text, fs, maxW, pf) {
    var words = String(text).split(/\s+/), i, ww, cur = 0, lines = 0, widest = 0, longest = 0;
    var space = emWidth(' ', pf) * fs;
    if (maxW < 1) { maxW = 1; }
    for (i = 0; i < words.length; i++) {
      if (!words[i]) { continue; }
      ww = emWidth(words[i], pf) * fs;
      if (ww > longest) { longest = ww; }
      if (!lines) { lines = 1; }
      if (ww > maxW) {
        if (cur > 0) { lines++; }
        lines += Math.ceil(ww / maxW) - 1;
        cur = ww - Math.floor(ww / maxW) * maxW;
        widest = maxW;
        continue;
      }
      if (cur === 0) { cur = ww; }
      else if (cur + space + ww <= maxW) { cur += space + ww; }
      else { if (cur > widest) { widest = cur; } lines++; cur = ww; }
    }
    if (cur > widest) { widest = cur; }
    return { n: lines, w: widest, longest: longest };
  }

  /* ---- search for the biggest font size that still fits ---- */
  function bisect(ok, lo, hi) {
    if (ok(hi)) { return hi; }
    if (!ok(lo)) { return lo; }
    for (var i = 0; i < 28; i++) {
      var mid = (lo + hi) / 2;
      if (ok(mid)) { lo = mid; } else { hi = mid; }
    }
    return lo;
  }
  /**
   * need(fs) -> { fit: bool, words: bool }  words = no single word is wider than its box.
   *
   * Two sizes are searched: `loose` (the biggest size at which the text fits, words may be broken mid-word) and `strict`
   * (the biggest size at which it fits AND no word is broken). Text shrinks gracefully before a word is broken: `strict` wins
   * unless it is smaller than minRatio x the size we would otherwise have used. That size is min(loose, cap): `cap` is the
   * comfortable size of the kind, NOT the bisection upper bound (which is 1.65 x cap and made the old test about 0.91 x cap,
   * a cliff that broke words such as "PivotTable" for a size loss of 10%). A word is therefore broken only as a last resort.
   */
  var MIN_STRICT = 0.4;
  // `floor` (px, optional) = a size under which text is not legible: `strict` is not used below it either (the highlight label)
  function solve(need, lo, hi, cap, minRatio, floor) {
    var loose = bisect(function (f) { return need(f).fit; }, lo, hi);
    var strict = bisect(function (f) { var r = need(f); return r.fit && r.words; }, lo, hi);
    var ref = Math.min(loose, cap > 0 ? cap : loose), least = ref * (minRatio === undefined ? MIN_STRICT : minRatio);
    if (floor && floor <= ref) { least = Math.max(least, floor); }
    return { fit: strict >= least ? strict : loose, strict: strict, loose: loose };
  }
  function finalize(need, cap, scale, minRatio, floor) {
    var lo = 1, hi = Math.max(cap * 1.65, 2);
    var s = solve(need, lo, hi, cap, minRatio, floor), fit = s.fit;
    var nat = Math.min(fit, cap);
    var fs = Math.max(lo, Math.min(nat * scale, fit));
    var chk = need(fs);
    return { fs: fs, fit: fit, nat: nat, cap: cap, strictNat: Math.min(s.strict, cap), ok: chk.fit, words: chk.words };
  }
  function refOf(W, H) { return Math.min(H, W * 0.8); }

  /* ===========================================================================================
   * 5. layout constants (em of the root font size unless noted). CSS and estimators both read these.
   * ========================================================================================= */
  var G = {
    lh: 1.3, tlh: 1.14,
    pad: {
      'list': [1.15, 0.95], 'steps': [1.15, 0.95], 'diagram': [1.0, 0.9], 'callout': [1.1, 0.85],
      'title-card': [0.7, 0.5], 'big-number': [0.3, 0.2], 'quote': [1.3, 0.95], 'shortcut': [1.2, 0.95]
    },
    lstTitle: 1.4, lstTitlePadB: 0.5, lstTitleMarB: 0.6, lstGap: 0.5, stpGap: 0.85, colGap: 1.8,
    dotW: 0.4, markGap: 0.75, stpBadge: 1.8, stpMarkGap: 0.85, stpPadTop: 0.25,
    dgTitle: 1.3, dgTitleMar: 0.8, nodePadX: 0.55, nodePadY: 0.6, nodeLh: 1.2, arrow: 1.5, nodeMaxW: 24,
    coTitle: 1.2, coTitleMar: 0.3, coLh: 1.35, coParGap: 0.35, coBar: 0.3, coGap: 0.8, coBarTop: 0.24, tail: 0.95, tailW: 1.7,
    chipPadX: 0.85, chipPadT: 0.4, chipPadB: 0.45, chipSub: 0.78, chipSubMar: 0.15, chipLh: 1.2, chipSubLh: 1.25,
    // highlight: chipInset = gap between the chip and the ring corner (em, added to the corner radius); chipOutMin = narrowest an
    // OUTSIDE chip may be (em) so a label on a very narrow box still reads; hlInH / hlInW = the most of the box an INSIDE chip may
    // cover (height / width); hlFloor = smallest label size (px) we call legible; hlRing = ring thickness allowance (em);
    // ringKey = thickness of each neutral keyline beside the accent line (fraction of the accent line); ringDark / ringLight = their opacity
    chipInset: 0.3, chipOutMin: 12, hlInH: 0.22, hlInW: 0.6, hlFloor: 12, hlRoomFloor: 9, hlRing: 0.4, ringKey: 0.35, ringDark: 0.6, ringLight: 0.75,
    ltBar: 0.32, ltPadL: 0.85, ltPadR: 1.1, ltPadT: 0.55, ltPadB: 0.6, ltSub: 0.56, ltSubMar: 0.25, ltLh: 1.12, ltSubLh: 1.3, ltTop: 0.22,
    tcLh: 1.08, tcRuleW: 3, tcRuleH: 0.1, tcRuleMar: 0.32, tcSub: 0.36, tcSubLh: 1.35,
    bnLabel: 0.24, bnLabelLh: 1.3, bnLabelMar: 0.14, bnUnit: 0.5,
    qmH: 1.5, qLh: 1.28, qMaxW: 34, qByMar: 0.9, qBy: 0.58, qByLh: 1.3,
    keyH: 2.3, keyMin: 2.3, keyPadX: 0.65, keyTxt: 0.82, keyGap: 0.4, plusW: 0.5, thenW: 0.7, rowGapY: 0.55, rowsGap: 0.7,
    // labScale = size of the platform label pills and the "or" between alternatives; keyWord / keyWordW = size of the small word
    // under a symbol on a stacked cap (CSS em, and the factor the width estimate uses for it)
    orH: 0.8, scTitle: 0.95, scTitleMar: 0.9, labScale: 0.64, keyWord: 0.52, keyWordW: 0.54,
    // lower third: the font size is capped at min(ltCapH x host height, ltCapW x host width + ltCapB) so the bar stays about a sixth of a 16:9 frame
    ltCapH: 0.26, ltCapW: 0.0275, ltCapB: 1
  };

  /* ===========================================================================================
   * 6. content parsing
   * ========================================================================================= */
  var MAXITEMS = 12, MAXNODES = 8, MAXROWS = 6, MAXKEYS = 6, MAXKEYTXT = 16;
  /*
   * Diagram arrows. A spreadsheet tutorial's boxes are full of comparisons (">=100", "A1>B1", "Sales > 100"), so a ">" is NOT
   * always an arrow. The rule, per line:
   *   1. "->", "-->", "=>", "==>" and the arrow glyphs (-> => and friends) are ALWAYS arrows.
   *   2. A bare ">" is an arrow only when ALL of these hold:
   *        a. it has white space on both sides ("B > C"; never "B>C", ">100", ">=", "<>");
   *        b. the line has no other comparison-looking use of "<" or ">" (an unspaced ">", any "<", ">=", "<=", "<>", ">>");
   *           one such use means every bare ">" on that line is text, so "Cells <> blank > Count" is a single box;
   *        c. neither side of it is a value. The operand on the left counts as a value when all of it is one (a number, a
   *           cell or range reference, quoted text, a formula or function call); the operand on the right also when its
   *           FIRST word is one. "Sales > 100", "B2 > C2" and "Orders > 100 units" are comparisons, "Open file > Save as"
   *           and "Step 1 > Step 2" are flows.
   *      Write "->" when you mean an arrow between values ("1 -> 2 -> 3", "Q1 -> Q2").
   */
  var ARROW_RE = /\s*(?:-+>|=+>|\u2192|\u27F6|\u21D2|\u2794|\u279C|\u279D|\u279E)\s*/;
  var ARROW_ALL_RE = new RegExp(ARROW_RE.source, 'g');
  var NUM_OP = /^[-+(]?[$\u20AC\u00A3\u00A5\u20B9]?\d[\d.,]*\s?(?:%|[KkMmBb])?\)?$/;
  var CELL_OP = /^(?:[A-Za-z0-9_']+!)?\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?$/;
  var QUOTED_OP = /^["'\u201C\u2018\u00AB]/;
  var FORMULA_OP = /^=|^[A-Za-z][A-Za-z0-9._]*\(.*\)?$|^(?:TRUE|FALSE)$/i;
  function isValueOperand(s) {
    s = s.trim();
    return !!s && (NUM_OP.test(s) || (CELL_OP.test(s) && !/^F[0-9]{1,2}$/i.test(s)) || FORMULA_OP.test(s));   // quoted menu or button names and function keys (F2, F4) are steps, not values
  }
  /** a line piece without definite arrows: split it on spaced ">" that are real arrows between non-value operands. */
  function splitBare(s) {
    var toks = s.split(/\s+>\s+/), out = [], cur, i;
    if (toks.length < 2) { return [s]; }
    cur = toks[0];
    for (i = 1; i < toks.length; i++) {
      if (isValueOperand(toks[i - 1]) || isValueOperand(toks[i]) || isValueOperand(toks[i].split(/\s+/)[0])) { cur += ' > ' + toks[i]; }   // a comparison stays inside its box
      else { out.push(cur); cur = toks[i]; }
    }
    out.push(cur);
    return out;
  }
  /** true when the line uses "<" or ">" as something other than a spaced bare ">" or a definite arrow (so no bare ">" is an arrow). */
  function hasComparison(line) {
    var rest = line.replace(ARROW_ALL_RE, ' ');
    return /</.test(rest) || /(?:^|\S)>|>(?:\S|$)/.test(rest);
  }
  function parseNodes(lines) {
    var out = [], i, j, parts, p, line, bare;
    for (i = 0; i < lines.length; i++) {
      line = stripMark(lines[i]);
      bare = !hasComparison(line);
      parts = line.split(ARROW_RE);
      for (j = 0; j < parts.length; j++) {
        p = bare ? splitBare(parts[j]) : [parts[j]];
        p.forEach(function (x) { x = x.trim(); if (x) { out.push(x); } });
      }
    }
    return out;
  }

  /* ---- keyboard shortcuts ---- */
  // glyph -> canonical key id
  var GLYPH_KEYS = {
    '\u2318': 'cmd', '\u2325': 'opt', '\u21E7': 'shift', '\u2303': 'ctrlmac', '\u21EA': 'caps',
    '\u21B5': 'enter', '\u23CE': 'enter', '\u2305': 'enter', '\u2324': 'enter', '\u21E5': 'tab', '\u238B': 'esc',
    '\u232B': 'backspace', '\u2326': 'del', '\u2423': 'space', '\u229E': 'win',
    '\u2190': 'left', '\u2191': 'up', '\u2192': 'right', '\u2193': 'down'
  };
  // lower-case name (spaces, '_' and '-' removed) -> canonical key id
  var NAME_KEYS = {
    ctrl: 'ctrl', control: 'ctrl', ctl: 'ctrl', cmd: 'cmd', command: 'cmd', meta: 'cmd', opt: 'opt', option: 'opt',
    alt: 'alt', altgr: 'altgr', shift: 'shift', win: 'win', windows: 'win', winkey: 'win', windowskey: 'win', super: 'win',
    enter: 'enter', 'return': 'enter', tab: 'tab', esc: 'esc', escape: 'esc',
    backspace: 'backspace', bksp: 'backspace', bs: 'backspace', del: 'del', delete: 'del',
    space: 'space', spacebar: 'space', caps: 'caps', capslock: 'caps', fn: 'fn',
    home: 'home', end: 'end', pgup: 'pgup', pageup: 'pgup', pgdn: 'pgdn', pagedown: 'pgdn', pgdown: 'pgdn',
    ins: 'ins', insert: 'ins', prtsc: 'prtsc', printscreen: 'prtsc', prtscn: 'prtsc', scrolllock: 'scrlk', numlock: 'numlk', pause: 'pause', menu: 'menu',
    up: 'up', down: 'down', left: 'left', right: 'right', uparrow: 'up', downarrow: 'down', leftarrow: 'left', rightarrow: 'right',
    plus: '+', minus: '-', comma: ',', period: '.', dot: '.', slash: '/', backslash: '\\', tilde: '~', equals: '=', semicolon: ';', quote: "'", backtick: '`'
  };
  // canonical id -> display. g = glyph, t = text, stacked = glyph over small word
  var KEY_DISPLAY = {
    cmd: { g: '\u2318', t: 'command', stacked: true },
    opt: { g: '\u2325', t: 'option', stacked: true },
    shift: { g: '\u21E7', t: 'shift', stacked: true },
    ctrlmac: { g: '\u2303', t: 'control', stacked: true },
    ctrl: { t: 'Ctrl' }, alt: { t: 'Alt' }, altgr: { t: 'AltGr' },
    win: { g: '\u229E', t: 'win', stacked: true },
    enter: { g: '\u21B5', t: 'enter', stacked: true },
    tab: { g: '\u21E5', t: 'tab', stacked: true },
    esc: { t: 'Esc' },
    backspace: { g: '\u232B', t: 'backspace', stacked: true },
    del: { g: '\u2326', t: 'del', stacked: true },
    caps: { g: '\u21EA', t: 'caps', stacked: true },
    space: { t: 'Space', wide: true },
    fn: { t: 'fn' }, home: { t: 'Home' }, end: { t: 'End' }, pgup: { t: 'PgUp' }, pgdn: { t: 'PgDn' }, ins: { t: 'Ins' },
    prtsc: { t: 'PrtSc' }, scrlk: { t: 'ScrLk' }, numlk: { t: 'NumLk' }, pause: { t: 'Pause' }, menu: { t: 'Menu' },
    up: { g: '\u2191', t: '' }, down: { g: '\u2193', t: '' }, left: { g: '\u2190', t: '' }, right: { g: '\u2192', t: '' }
  };
  var KEY_WORDS = { cmd: 'Command', opt: 'Option', shift: 'Shift', ctrlmac: 'Control', ctrl: 'Ctrl', alt: 'Alt', altgr: 'AltGr', win: 'Windows key', enter: 'Enter', tab: 'Tab', esc: 'Esc', backspace: 'Backspace', del: 'Delete', caps: 'Caps Lock', space: 'Space', up: 'Up arrow', down: 'Down arrow', left: 'Left arrow', right: 'Right arrow' };

  function keyOf(tok) {
    var raw = tok.trim(), id = '', low, d;
    if (!raw) { return null; }
    if (has(GLYPH_KEYS, raw)) { id = GLYPH_KEYS[raw]; }
    else {
      low = raw.toLowerCase().replace(/[\s_]+/g, '');
      if (raw.length > 1 && has(NAME_KEYS, low)) { id = NAME_KEYS[low]; }
      else if (raw.length === 1 || (raw.length === 2 && raw.charCodeAt(0) >= 0xD800)) {
        return { id: raw.toLowerCase(), t: raw.toUpperCase(), g: '', stacked: false, wide: false, single: true };
      } else if (/^f([1-9]|1\d|2[0-4])$/.test(low)) {
        return { id: low, t: low.toUpperCase(), g: '', stacked: false, wide: false, single: false };
      } else if (/arrow$/.test(low) && has(NAME_KEYS, low.replace(/arrow$/, ''))) {
        id = NAME_KEYS[low.replace(/arrow$/, '')];
      }
    }
    if (id && id.length === 1) {   // plus, minus, comma ... spelled out
      return { id: id, t: id === '-' ? '\u2212' : id, g: '', stacked: false, wide: false, single: true };
    }
    if (id && has(KEY_DISPLAY, id)) {
      d = KEY_DISPLAY[id];
      // Windows style words stay plain caps; only the symbol itself (or Mac-only names) gets the symbol + word cap
      if (!has(GLYPH_KEYS, raw) && (id === 'shift' || id === 'win')) {
        return { id: id, t: id === 'shift' ? 'Shift' : 'Win', g: '', stacked: false, wide: false, single: false };
      }
      return { id: id, t: d.t, g: d.g || '', stacked: !!d.stacked, wide: !!d.wide, single: false };
    }
    // any other key name is drawn as typed. A very long one is cut with an ellipsis (never mid-word without a sign); the whole name stays in `full` for describe()
    var t = raw, out;
    if (t === t.toLowerCase()) { t = t.charAt(0).toUpperCase() + t.slice(1); }
    out = { id: low || t.toLowerCase(), t: ellipsize(t, MAXKEYTXT), g: '', stacked: false, wide: false, single: false };
    if (out.t !== t) { out.full = t; }
    return out;
  }
  /** cut text to at most n characters, ending in an ellipsis; never splits a surrogate pair. */
  function ellipsize(s, n) {
    if (s.length <= n) { return s; }
    var cut = s.slice(0, n - 1), last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xD800 && last <= 0xDBFF) { cut = cut.slice(0, -1); }
    return cut.replace(/\s+$/, '') + '\u2026';
  }

  /** "Ctrl + Shift + L" -> ['Ctrl','Shift','L'].  A '+' with nothing before it is the plus key itself. */
  function splitChord(s) {
    var out = [], buf = '', i, ch;
    s = s.trim();
    for (i = 0; i < s.length; i++) {
      ch = s.charAt(i);
      if (ch === '+') {
        if (buf.trim() === '') { buf += '+'; } else { out.push(buf.trim()); buf = ''; }
      } else { buf += ch; }
    }
    if (buf.trim()) { out.push(buf.trim()); }
    return out;
  }
  var MOD_GLYPHS = '\u2318\u2325\u21E7\u2303\u21EA';
  function expandGlyphs(tokens) {
    var out = [], i, t, j, parts, p, k;
    for (i = 0; i < tokens.length; i++) {
      t = tokens[i];
      if (t.length > 1 && MOD_GLYPHS.indexOf(t.charAt(0)) >= 0) {
        parts = t.split(/\s+/);
        for (j = 0; j < parts.length; j++) {
          p = parts[j];
          if (!p) { continue; }
          k = 0;
          while (k < p.length - 1 && MOD_GLYPHS.indexOf(p.charAt(k)) >= 0) { out.push(p.charAt(k)); k++; }
          out.push(p.slice(k));
        }
      } else { out.push(t); }
    }
    return out;
  }
  var LABEL_OK_KEYWORDS = /^(win|windows|mac|macos|pc|linux)$/i;
  // a label needs a letter: Latin, or any other script (Greek, Cyrillic, Hebrew, Arabic, Indic, Thai ... and CJK / Hangul), but not the symbol blocks (arrows, key glyphs)
  var LABEL_LETTER = /[A-Za-z\u00C0-\u024F\u0370-\u1FFF\u3040-\uD7FF]/;
  /**
   * one line -> { label, groups:[[key,...],...], dropped } ; several groups = a key sequence (Alt, H, O, I).
   * The label ("Windows", "Excel for Windows") is kept whole (up to 24 characters, the limit of the pattern below); the layout
   * wraps it onto its own line and, only when it is wider than the whole row, ends it with an ellipsis.
   * `dropped` counts the keys / sequence steps beyond the limit of 6 that were not kept.
   */
  function parseShortcutLine(line) {
    var label = '', rest = line, mm = /^\s*([^:+,]{1,24}?)\s*:\s*(\S.*)$/.exec(line);
    if (mm && LABEL_LETTER.test(mm[1]) && mm[1].trim().length >= 2) {
      var cand = mm[1].trim(), candLow = cand.toLowerCase().replace(/[\s_]+/g, '');
      if (LABEL_OK_KEYWORDS.test(cand) || !has(NAME_KEYS, candLow)) { label = cand; rest = mm[2]; }
    }
    var groupStrs = rest.split(/,\s+|\s+then\s+/i), groups = [], gi, toks, keys, ki, k, dropped = 0;
    for (gi = 0; gi < groupStrs.length; gi++) {
      toks = expandGlyphs(splitChord(groupStrs[gi]));
      keys = [];
      for (ki = 0; ki < toks.length; ki++) {
        k = keyOf(toks[ki]);
        if (k) { keys.push(k); }
      }
      if (!keys.length) { continue; }
      if (groups.length >= MAXKEYS) { dropped += keys.length; continue; }
      if (keys.length > MAXKEYS) { dropped += keys.length - MAXKEYS; keys = keys.slice(0, MAXKEYS); }
      groups.push(keys);
    }
    return { label: label, groups: groups, dropped: dropped };
  }
  /** lines -> rows (max 6). `rows.dropped` = shortcut lines beyond the limit, `rows.droppedKeys` = keys / steps beyond the limit inside kept rows. */
  function parseShortcuts(lines) {
    var rows = [], i, r, droppedRows = 0, droppedKeys = 0;
    for (i = 0; i < lines.length; i++) {
      r = parseShortcutLine(lines[i]);
      if (!r.groups.length) { continue; }
      if (rows.length < MAXROWS) { rows.push(r); droppedKeys += r.dropped; } else { droppedRows++; }
    }
    rows.dropped = droppedRows;
    rows.droppedKeys = droppedKeys;
    return rows;
  }
  function keyName(k) {
    var w = get(KEY_WORDS, k.id);
    if (w) { return k.g ? w + ' (' + k.g + ')' : w; }
    return k.full || k.t || k.g;
  }
  function chordText(row) {
    return row.groups.map(function (g) { return g.map(keyName).join(' + '); }).join(', then ');
  }

  /* ---- big number: "$1.2M" -> prefix "$", number "1.2", suffix "M" ---- */
  function splitNumber(v) {
    var m = /^([$\u20AC\u00A3\u00A5\u20B9+\-]?)\s*(\d[\d.,]*)\s*([A-Za-z%\u00D7+]{1,6})?$/.exec(v);
    if (!m || (m[1].length + (m[3] ? m[3].length : 0)) === 0) { return null; }
    return { pre: m[1], num: m[2], suf: m[3] || '', spaced: /\d\s+[A-Za-z]/.test(v) };
  }

  /** everything the layout needs, derived from the normalised visual */
  function prepare(n) {
    var k = n.kind, title = oneLine(n.content.title), lines = splitLines(n.content.body), ph = false, m;
    if (!title && !lines.length) {
      var s = kindById(k).sample;
      title = oneLine(s.title); lines = splitLines(s.body); ph = true;
    }
    m = { kind: k, title: title, lines: lines, ph: ph, dropped: 0, droppedKeys: 0 };
    switch (k) {
      case 'list':
      case 'steps':
        m.items = lines.map(stripMark).filter(function (x) { return x; });
        if (m.items.length > MAXITEMS) { m.dropped = m.items.length - MAXITEMS; m.items = m.items.slice(0, MAXITEMS); }
        break;
      case 'diagram':
        m.nodes = parseNodes(lines);
        if (m.nodes.length > MAXNODES) { m.dropped = m.nodes.length - MAXNODES; m.nodes = m.nodes.slice(0, MAXNODES); }
        m.ghosts = 0;
        while (m.nodes.length + m.ghosts < 2) { m.ghosts++; }
        break;
      case 'callout': m.paras = lines; break;
      case 'highlight':
      case 'lower-third':
      case 'title-card': m.sub = lines.join(' '); break;
      case 'big-number': m.label = lines.join(' '); m.num = splitNumber(title); break;
      case 'quote': m.quote = lines.join(' '); break;
      case 'shortcut':
        m.rows = parseShortcuts(lines);
        m.dropped = m.rows.dropped; m.droppedKeys = m.rows.droppedKeys;
        break;
    }
    return m;
  }

  /* ===========================================================================================
   * 7. planners: pick the font size (and structural choices) for each kind
   * ========================================================================================= */
  function ctxOf(n, m, W, H, T, g, env) {
    return {
      n: n, m: m, W: W, H: H, T: T, g: g, o: n.opts, scale: n.opts.scale, env: env || {},
      pd: profile(T.fd, T.fw, T.ls), pb: profile(T.fb, 400, 0), pb6: profile(T.fb, 600, 0), pq: profile(T.fd, T.fwq, T.ls)
    };
  }
  function inner(c, fs, P) {
    return { w: c.W - 2 * c.g.bw - 2 * P[0] * fs, h: c.H - 2 * c.g.bw - 2 * P[1] * fs };
  }

  function planList(c, steps) {
    var m = c.m, g = c.g, P = G.pad[steps ? 'steps' : 'list'], n = m.items.length;
    function need(fs, cols) {
      var a = inner(c, fs, P), h = 0, words = true, i, r, rows, hs = [], textW, lines, tl;
      if (m.title) {
        tl = wrap(m.title, fs * G.lstTitle, a.w, c.pd);
        h += tl.n * G.lstTitle * G.tlh * fs;
        words = words && tl.longest <= a.w;
        if (n) { h += (G.lstTitlePadB + G.lstTitleMarB) * fs + g.bw; }
      }
      if (n) {
        textW = (a.w - (cols - 1) * G.colGap * fs) / cols - (steps ? G.stpBadge + G.stpMarkGap : G.dotW + G.markGap) * fs;
        for (i = 0; i < n; i++) {
          r = wrap(m.items[i], fs, textW, c.pb);
          words = words && r.longest <= textW;
          lines = Math.max(r.n, 1);
          hs.push(steps ? Math.max(G.stpBadge, G.stpPadTop + lines * G.lh) * fs : lines * G.lh * fs);
        }
        rows = Math.ceil(n / cols);
        var sum = 0, rr, cc, mx;
        for (rr = 0; rr < rows; rr++) {
          mx = 0;
          for (cc = 0; cc < cols; cc++) { if (hs[rr + cc * rows] !== undefined) { mx = Math.max(mx, hs[rr + cc * rows]); } }
          sum += mx;
        }
        h += sum + (rows - 1) * (steps ? G.stpGap : G.lstGap) * fs;
      }
      return { fit: h <= a.h, words: words };
    }
    var cap = 0.07 * refOf(c.W, c.H);
    var r1 = finalize(function (f) { return need(f, 1); }, cap, c.scale), best = r1, cols = 1;
    if (n >= 4 && c.W > c.H * 1.15) {
      var r2 = finalize(function (f) { return need(f, 2); }, cap, c.scale);
      if (r2.nat > r1.nat * 1.1) { best = r2; cols = 2; }
    }
    return { fs: best.fs, ok: best.ok, words: best.words, cols: cols };
  }

  function diagramNeed(c, fs, orient) {
    var m = c.m, g = c.g, P = G.pad.diagram, a = inner(c, fs, P), h = 0, words = true, tl, i, r, nn = m.nodes.length + m.ghosts, nodeW, textW, mxLines = 1, nodeH;
    if (m.title) {
      tl = wrap(m.title, fs * G.dgTitle, a.w, c.pd);
      h += tl.n * G.dgTitle * G.tlh * fs + G.dgTitleMar * fs;
      words = words && tl.longest <= a.w;
    }
    var all = m.nodes.slice(), gi;
    for (gi = 0; gi < m.ghosts; gi++) { all.push('\u2026'); }
    if (orient === 'h') {
      nodeW = (a.w - (nn - 1) * G.arrow * fs) / nn;
      textW = nodeW - 2 * G.nodePadX * fs - 2 * g.bw;
      for (i = 0; i < all.length; i++) {
        r = wrap(all[i], fs, textW, c.pb6);
        words = words && r.longest <= textW;
        mxLines = Math.max(mxLines, r.n);
      }
      h += (mxLines * G.nodeLh + 2 * G.nodePadY) * fs + 2 * g.bw;
    } else {
      nodeW = Math.min(a.w, G.nodeMaxW * fs);
      textW = nodeW - 2 * G.nodePadX * fs - 2 * g.bw;
      for (i = 0; i < all.length; i++) {
        r = wrap(all[i], fs, textW, c.pb6);
        words = words && r.longest <= textW;
        nodeH = (r.n * G.nodeLh + 2 * G.nodePadY) * fs + 2 * g.bw;
        h += nodeH;
      }
      h += (nn - 1) * G.arrow * fs;
    }
    return { fit: h <= a.h, words: words };
  }
  // A diagram would rather shrink a label to a fifth of its comfortable size than break a word of it in the middle: boxes are narrow,
  // so a broken word is the commonest way a flow diagram looks wrong.
  var DIAGRAM_MIN_STRICT = 0.2;
  function planDiagram(c) {
    var cap = 0.062 * refOf(c.W, c.H);
    var rh = finalize(function (f) { return diagramNeed(c, f, 'h'); }, cap, c.scale, DIAGRAM_MIN_STRICT);
    var rv = finalize(function (f) { return diagramNeed(c, f, 'v'); }, cap, c.scale, DIAGRAM_MIN_STRICT);
    var prefH = c.W >= c.H * 1.1, orient;
    // compare the sizes at which no word has to be broken; the box shape only breaks near-ties
    if (prefH) { orient = rh.strictNat >= rv.strictNat * 0.92 ? 'h' : 'v'; } else { orient = rv.strictNat >= rh.strictNat * 0.92 ? 'v' : 'h'; }
    var best = orient === 'h' ? rh : rv;
    return { fs: best.fs, ok: best.ok, words: best.words, orient: orient };
  }

  function resolvePointer(o) {
    if (o.bg === 'none' || o.pointer === 'none') { return 'none'; }
    return o.pointer === 'auto' ? 'down' : o.pointer;
  }
  function planCallout(c) {
    var m = c.m, P = G.pad.callout, ptr = resolvePointer(c.o), center = c.o.align === 'center';
    function need(fs) {
      var Wc = c.W - ((ptr === 'left' || ptr === 'right') ? G.tail * fs : 0);
      var Hc = c.H - ((ptr === 'up' || ptr === 'down') ? G.tail * fs : 0);
      var aw = Wc - 2 * c.g.bw - 2 * P[0] * fs - (center ? 0 : (G.coBar + G.coGap) * fs);
      var ah = Hc - 2 * c.g.bw - 2 * P[1] * fs, h = 0, words = true, tl, i, r;
      if (center) { h += (G.coBarTop + G.coGap) * fs; }
      if (m.title) {
        tl = wrap(m.title, fs * G.coTitle, aw, c.pd);
        h += tl.n * G.coTitle * G.tlh * fs;
        words = words && tl.longest <= aw;
        if (m.paras.length) { h += G.coTitleMar * fs; }
      }
      for (i = 0; i < m.paras.length; i++) {
        r = wrap(m.paras[i], fs, aw, c.pb);
        words = words && r.longest <= aw;
        h += r.n * G.coLh * fs + (i ? G.coParGap * fs : 0);
      }
      return { fit: h <= ah, words: words };
    }
    var r = finalize(need, 0.085 * refOf(c.W, c.H), c.scale);
    return { fs: r.fs, ok: r.ok, words: r.words, ptr: ptr };
  }

  /**
   * Highlight label. Where the chip goes (plan.place):
   *   'in'    hangs from the top edge INSIDE the ring (as before) when it stays small: at most G.hlInH of the box height and G.hlInW of
   *           its width, at a legible size (>= G.hlFloor px and not far below the comfortable size).
   *   'out'   otherwise it sits ABOVE the ring, attached to its top edge, so it does not cover what is being highlighted; it may be
   *           wider than the box (it is at least G.chipOutMin em wide) but its text takes at most 2 + 2 lines.
   *   'below' like 'out' but under the ring; only chosen by render() when it measured that there is no room above.
   *           When the room is smaller than the chip, the label is made smaller to fit it (down to G.hlRoomFloor px, a little under
   *           the floor, because it is still entirely outside the box).
   *   'in' + wide  when there is no room outside either (render() measured), the chip goes inside after all, as wide and tall as the
   *           old layout allowed (up to 60% of the box height), so it is still as legible as it can be.
   * VIS.html() cannot see the page, so it assumes there is room above; VIS.render() measures it (env.room = free px above / below).
   * The label font is at least G.hlFloor px (12), whatever the box size: on a narrow column a 3 px label was the old result.
   */
  function planHighlight(c) {
    var m = c.m, W = c.W, H = c.H, rad = c.g.r, room = c.env && c.env.room;
    var cap = Math.max(G.hlFloor, Math.min(0.30 * H, 0.055 * Math.sqrt(W * H), 0.08 * W));
    if (!m.title && !m.sub) { return { fs: Math.max(1, cap * c.scale), ok: true, words: true, place: 'in', wide: false, chipH: 0, chipMaxW: 0 }; }
    /** size of the chip at font size fs for the three kinds of width: 'in' (comfortable), 'wide' (inside, old limit), 'out' */
    function chip(fs, mode) {
      var avail = W - 2 * (rad + G.chipInset * fs), maxW, tw, h = (G.chipPadT + G.chipPadB) * fs, words = true, r, tl = 0, sl = 0;
      if (mode === 'out') { maxW = Math.max(avail, G.chipOutMin * fs); }
      else if (mode === 'wide') { maxW = avail; }
      else { maxW = Math.min(avail, G.hlInW * W); }
      tw = Math.max(maxW, 1) - 2 * G.chipPadX * fs;
      if (m.title) { r = wrap(m.title, fs, tw, c.pd); h += r.n * G.chipLh * fs; words = words && r.longest <= tw; tl = r.n; }
      if (m.sub) { r = wrap(m.sub, fs * G.chipSub, tw, c.pb); h += (m.title ? G.chipSubMar * fs : 0) + r.n * G.chipSub * G.chipSubLh * fs; words = words && r.longest <= tw; sl = r.n; }
      return { h: h, words: words, tl: tl, sl: sl, maxW: Math.max(maxW, 1) };
    }
    function needIn(fs) { var d = chip(fs, 'in'); return { fit: d.h + G.hlRing * fs <= G.hlInH * H, words: d.words }; }
    function needWide(fs) { var d = chip(fs, 'wide'); return { fit: d.h + G.hlRing * fs <= 0.6 * H, words: d.words }; }
    // an outside chip takes 2 + 2 lines of text; at the legibility floor it may take 4 + 4 before the text is made smaller than the floor
    function needOut(fs) { var d = chip(fs, 'out'), lim = fs <= G.hlFloor + 0.01 ? 4 : 2; return { fit: d.tl <= lim && d.sl <= lim, words: d.words }; }
    var rIn = finalize(needIn, cap, c.scale, undefined, G.hlFloor);
    if (rIn.ok && rIn.words && rIn.nat >= Math.max(G.hlFloor, 0.7 * cap)) { return { fs: rIn.fs, ok: true, words: rIn.words, place: 'in', wide: false, chipH: chip(rIn.fs, 'in').h, chipMaxW: chip(rIn.fs, 'in').maxW }; }
    var rOut = finalize(needOut, cap, c.scale, undefined, G.hlFloor), dOut = chip(rOut.fs, 'out'), h = dOut.h, place = 'out', rW, above, below, gap, fsR;
    if (room) {
      above = num(room.above, 0); below = num(room.below, 0);
      if (above >= h + 1) { place = 'out'; }
      else if (below >= h + 1) { place = 'below'; }
      else {
        // not enough room for this size: a smaller label that fits the bigger gap, unless that is under G.hlRoomFloor px AND the label
        // that would fit inside the ring is clearly more legible; else inside after all
        gap = Math.max(above, below) - 1;
        fsR = bisect(function (f) { var n = needOut(f); return n.fit && n.words && chip(f, 'out').h <= gap; }, 1, rOut.fs);
        rW = finalize(needWide, cap, c.scale, undefined, G.hlFloor);
        if (fsR >= G.hlRoomFloor || (fsR >= 5 && fsR > rW.fs * 1.3)) {
          dOut = chip(fsR, 'out');
          place = above >= dOut.h + 1 ? 'out' : 'below';   // above is preferred whenever the smaller label fits there
          return { fs: fsR, ok: true, words: true, place: place, wide: false, chipH: dOut.h, chipMaxW: dOut.maxW };
        }
        return { fs: rW.fs, ok: rW.ok, words: rW.words, place: 'in', wide: true, chipH: chip(rW.fs, 'wide').h, chipMaxW: chip(rW.fs, 'wide').maxW };
      }
    }
    return { fs: rOut.fs, ok: rOut.ok, words: rOut.words, place: place, wide: false, chipH: h, chipMaxW: dOut.maxW };
  }

  function planLowerThird(c) {
    var m = c.m, W = c.W, H = c.H, center = c.o.align === 'center';
    var cap = clamp(Math.min(G.ltCapH * H, G.ltCapW * W + G.ltCapB), 2, 200);
    function need(fs) {
      var aw = W * 0.96 - 2 * c.g.bw;
      var tw = aw - (center ? 2 * G.ltPadR : (G.ltBar + G.ltPadL + G.ltPadR)) * fs;
      var h = (G.ltPadT + G.ltPadB) * fs + 2 * c.g.bw, words = true, nl, sl = { n: 0, longest: 0 };
      nl = wrap(m.title || ' ', fs, tw, c.pd);
      h += nl.n * G.ltLh * fs;
      words = nl.longest <= tw;
      if (m.sub) {
        sl = wrap(m.sub, fs * G.ltSub, tw, c.pb6);
        h += G.ltSubMar * fs + sl.n * G.ltSub * G.ltSubLh * fs;
        words = words && sl.longest <= tw;
      }
      if (center) { h += G.ltTop * fs; }
      return { fit: h <= H * 0.88 && nl.n <= 2 && sl.n <= 2, words: words };
    }
    var r = finalize(need, cap, c.scale);
    return { fs: r.fs, ok: r.ok, words: r.words };
  }

  function planTitleCard(c) {
    var m = c.m, P = G.pad['title-card'];
    function need(fs) {
      var a = inner(c, fs, P), h = 0, words = true, r;
      if (m.title) {
        r = wrap(m.title, fs, a.w, c.pd);
        h += r.n * G.tcLh * fs;
        words = r.longest <= a.w;
      }
      if (m.sub) {
        if (m.title) { h += (2 * G.tcRuleMar + G.tcRuleH) * fs; }
        r = wrap(m.sub, fs * G.tcSub, a.w, c.pb6);
        h += r.n * G.tcSub * G.tcSubLh * fs;
        words = words && r.longest <= a.w;
      }
      return { fit: h <= a.h, words: words };
    }
    var r = finalize(need, 0.2 * refOf(c.W, c.H), c.scale);
    return { fs: r.fs, ok: r.ok, words: r.words };
  }

  function bigValueEm(m, pf) {
    if (m.num) {
      return emWidth(m.num.num, pf) + G.bnUnit * (emWidth(m.num.pre, pf) + emWidth(m.num.suf, pf) + (m.num.spaced ? 0.3 : 0));
    }
    return emWidth(m.title, pf);
  }
  function planBigNumber(c) {
    var m = c.m, P = G.pad['big-number'];
    var vEm = m.title ? bigValueEm(m, c.pd) : 0;
    function need(fs) {
      var a = inner(c, fs, P), h = 0, words = true, r;
      if (m.title) { h += fs; words = vEm * fs <= a.w; }
      if (m.label) {
        r = wrap(m.label, fs * G.bnLabel, a.w, c.pb6);
        h += (m.title ? G.bnLabelMar * fs : 0) + r.n * G.bnLabel * G.bnLabelLh * fs;
        words = words && r.longest <= a.w;
      }
      return { fit: h <= a.h && (!m.title || vEm * fs <= a.w), words: words };
    }
    var r = finalize(need, 0.46 * refOf(c.W, c.H), c.scale);
    return { fs: r.fs, ok: r.ok, words: r.words };
  }

  function planQuote(c) {
    var m = c.m, P = G.pad.quote;
    function need(fs) {
      var a = inner(c, fs, P), tw = Math.min(a.w, G.qMaxW * fs), h = G.qmH * fs, words = true, r;
      if (m.quote) {
        r = wrap(m.quote, fs, tw, c.pq);
        h += r.n * G.qLh * fs;
        words = r.longest <= tw;
      }
      if (m.title) {
        r = wrap(m.title.toUpperCase(), fs * G.qBy, a.w, { ff: c.pb6.ff, mono: c.pb6.mono, wf: c.pb6.wf, ls: 0.08 });
        h += (G.qByMar + 0) * fs + r.n * G.qBy * G.qByLh * fs;
        words = words && r.longest <= a.w;
      }
      return { fit: h <= a.h, words: words };
    }
    var r = finalize(need, 0.075 * refOf(c.W, c.H), c.scale);
    return { fs: r.fs, ok: r.ok, words: r.words };
  }

  function keyWidthEm(k, pf) {
    if (k.id === 'space') { return 7.5; }
    if (k.stacked) {
      var tw = emWidth(k.t.toUpperCase(), { ff: pf.ff, mono: pf.mono, wf: pf.wf, ls: 0.08 }) * G.keyWordW;
      return Math.max(2.6, Math.max(0.95 * 1.05, tw) + 2 * G.keyPadX);
    }
    if (!k.t && k.g) { return G.keyMin; }
    return Math.max(G.keyMin, emWidth(k.t, pf) * (k.single ? 1.05 : G.keyTxt) + 2 * G.keyPadX);
  }
  /** items of one shortcut row as widths (em) so the wrapping can be simulated */
  function rowItems(row, pf) {
    var items = [], gi, ki, grp;
    if (row.label) { items.push(emWidth(row.label.toUpperCase(), { ff: pf.ff, mono: pf.mono, wf: pf.wf, ls: 0.14 }) * G.labScale + 1.4 * G.labScale + 0.1); }
    for (gi = 0; gi < row.groups.length; gi++) {
      grp = row.groups[gi];
      if (gi) { items.push(G.thenW); }
      for (ki = 0; ki < grp.length; ki++) {
        if (ki) { items.push(G.plusW); }
        items.push(keyWidthEm(grp[ki], pf));
      }
    }
    return items;
  }
  function planShortcut(c) {
    var m = c.m, P = G.pad.shortcut, rows = m.rows, pf = c.pb6;
    var itemSets = rows.map(function (r) { return rowItems(r, pf); });
    var hasLabels = rows.some(function (r) { return r.label; });
    function need(fs) {
      var a = inner(c, fs, P), aw = a.w / fs, h = 0, words = true, i, j, r, lines, cur, width, widest = 0;
      if (m.title) {
        r = wrap(m.title, fs * G.scTitle, a.w, c.pd);
        h += r.n * G.scTitle * G.tlh * fs;
        words = r.longest <= a.w;
        if (rows.length) { h += G.scTitleMar * fs; }
      }
      var nItems = rows.length + ((!hasLabels && rows.length > 1) ? rows.length - 1 : 0);
      for (i = 0; i < itemSets.length; i++) {
        lines = 1; cur = 0;
        for (j = 0; j < itemSets[i].length; j++) {
          width = itemSets[i][j];
          if (width > widest) { widest = width; }
          width = Math.min(width, aw);   // a label wider than the row is cut with an ellipsis (last resort), it never gets wider than the row
          if (cur === 0) { cur = width; }
          else if (cur + G.keyGap + width <= aw) { cur += G.keyGap + width; }
          else { lines++; cur = width; }
        }
        h += (lines * G.keyH + (lines - 1) * G.rowGapY) * fs;
      }
      if (nItems > 1) { h += (nItems - 1) * G.rowsGap * fs; }
      if (!hasLabels && rows.length > 1) { h += (rows.length - 1) * G.orH * fs; }
      return { fit: h <= a.h, words: words && widest <= aw };
    }
    var r2 = finalize(need, 0.075 * refOf(c.W, c.H), c.scale);
    return { fs: r2.fs, ok: r2.ok, words: r2.words };
  }

  function plan(n, m, W, H, T, g, env) {
    var c = ctxOf(n, m, W, H, T, g, env), p;
    switch (n.kind) {
      case 'list': p = planList(c, false); break;
      case 'steps': p = planList(c, true); break;
      case 'diagram': p = planDiagram(c); break;
      case 'callout': p = planCallout(c); break;
      case 'highlight': p = planHighlight(c); break;
      case 'lower-third': p = planLowerThird(c); break;
      case 'big-number': p = planBigNumber(c); break;
      case 'quote': p = planQuote(c); break;
      case 'shortcut': p = planShortcut(c); break;
      default: p = planTitleCard(c);
    }
    p.fs = clamp(p.fs, 1, 4000);
    return p;
  }

  /* ===========================================================================================
   * 8. HTML builders
   * ========================================================================================= */
  var ARROW_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 12h15M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // dir="auto": the base direction of every piece of user text follows its first strong character, so Hebrew / Arabic / Persian text
  // keeps its punctuation and its bullet or badge on the right side (and Latin text is unchanged)
  var DIR = ' dir="auto"';
  function bTitle(cls, text) { return text ? '<div class="vis-h ' + cls + '"' + DIR + '>' + esc(text) + '</div>' : ''; }

  function bList(c, pl, steps) {
    var m = c.m, h = '<div class="vis-surf vis-panel vis-chk"><div class="vis-in">', n = m.items.length, i;
    h += bTitle('vis-lst-t', m.title);
    if (n) {
      var cols = pl.cols, rows = Math.ceil(n / cols);
      h += '<ul class="vis-lst' + (steps ? ' vis-stp' : '') + (steps && cols === 1 && c.o.align === 'left' ? ' vis-rail' : '') +
        '" style="--vis-cols:' + cols + ';--vis-rows:' + rows + '">';
      for (i = 0; i < n; i++) {
        h += '<li class="vis-li"' + DIR + '>' + (steps ? '<span class="vis-sn"><b>' + (i + 1) + '</b></span>' : '<i class="vis-dot"></i>') +
          '<span class="vis-li-t' + (steps ? ' vis-st-t' : '') + '">' + esc(m.items[i]) + '</span></li>';
      }
      h += '</ul>';
    }
    return h + '</div></div>';
  }

  function bDiagram(c, pl) {
    var m = c.m, h = '<div class="vis-surf vis-panel vis-chk"><div class="vis-in">', i, all = [], total;
    h += bTitle('vis-dg-t', m.title);
    for (i = 0; i < m.nodes.length; i++) { all.push({ t: m.nodes[i], ghost: false }); }
    for (i = 0; i < m.ghosts; i++) { all.push({ t: '\u2026', ghost: true }); }
    total = all.length;
    h += '<div class="vis-flow vis-flow-' + pl.orient + '">';
    for (i = 0; i < total; i++) {
      if (i) { h += '<span class="vis-arr">' + ARROW_SVG + '</span>'; }
      h += '<div class="vis-node' + (all[i].ghost ? ' vis-node-g' : (i === total - 1 ? ' vis-node-x' : '')) + '"' + DIR + '><span>' + esc(all[i].t) + '</span></div>';
    }
    return h + '</div></div></div>';
  }

  var TAIL_PATH = {
    down: ['0 0 30 18', 'M0 0 L15 18 L30 0'],
    up: ['0 0 30 18', 'M0 18 L15 0 L30 18'],
    right: ['0 0 18 30', 'M0 0 L18 15 L0 30'],
    left: ['0 0 18 30', 'M18 0 L0 15 L18 30']
  };
  function tailPosition(ptr, align) {
    var along = (align === 'left') ? 'left:calc(var(--vis-r) + 1.1em)' : (align === 'right' ? 'right:calc(var(--vis-r) + 1.1em)' : 'left:50%;margin-left:-' + (G.tailW / 2) + 'em');
    if (ptr === 'down') { return 'top:calc(100% - var(--vis-bw));width:' + G.tailW + 'em;height:calc(' + G.tail + 'em + var(--vis-bw));' + along; }
    if (ptr === 'up') { return 'bottom:calc(100% - var(--vis-bw));width:' + G.tailW + 'em;height:calc(' + G.tail + 'em + var(--vis-bw));' + along; }
    if (ptr === 'right') { return 'left:calc(100% - var(--vis-bw));width:calc(' + G.tail + 'em + var(--vis-bw));height:' + G.tailW + 'em;top:50%;margin-top:-' + (G.tailW / 2) + 'em'; }
    return 'right:calc(100% - var(--vis-bw));width:calc(' + G.tail + 'em + var(--vis-bw));height:' + G.tailW + 'em;top:50%;margin-top:-' + (G.tailW / 2) + 'em';
  }
  function bCallout(c, pl) {
    var m = c.m, ptr = pl.ptr, h, i;
    h = '<div class="vis-co vis-ptr-' + ptr + '"><div class="vis-cw"><div class="vis-surf vis-panel vis-chk"><div class="vis-in"><div class="vis-co-in"><div class="vis-bar"></div><div class="vis-co-tx">';
    h += bTitle('vis-co-t', m.title);
    for (i = 0; i < m.paras.length; i++) { h += '<div class="vis-co-b"' + DIR + '>' + esc(m.paras[i]) + '</div>'; }
    h += '</div></div></div></div>';
    if (ptr !== 'none') {
      h += '<svg class="vis-tail" viewBox="' + TAIL_PATH[ptr][0] + '" preserveAspectRatio="none" aria-hidden="true" focusable="false" style="' + tailPosition(ptr, c.o.align) + '"><path d="' + TAIL_PATH[ptr][1] + '"/></svg>';
    }
    return h + '</div></div>';
  }

  function bHighlight(c, pl) {
    var m = c.m, h = '<div class="vis-hl"><div class="vis-ring"></div>', pos, cls;
    if (m.title || m.sub) {
      // centred: left 50% + translateX(-50%) on a chip whose width is max-content (clamped by max-width), so it is not squeezed into
      // the half box that "left:50%" leaves as the shrink-to-fit width. left / right: offset from the corner by the radius + .3em.
      pos = c.o.align === 'center' ? 'left:50%;-webkit-transform:translateX(-50%);transform:translateX(-50%)' :
        (c.o.align === 'right' ? 'right:calc(var(--vis-r) + ' + G.chipInset + 'em)' : 'left:calc(var(--vis-r) + ' + G.chipInset + 'em)');
      cls = 'vis-chip' + (pl.place === 'out' ? ' vis-chip-out' : (pl.place === 'below' ? ' vis-chip-below' : ' vis-lim' + (pl.wide ? ' vis-chip-wide' : '')));
      h += '<div class="' + cls + '" style="' + pos + '">';
      if (m.title) { h += '<div class="vis-chip-t"' + DIR + '>' + esc(m.title) + '</div>'; }
      if (m.sub) { h += '<div class="vis-chip-s"' + DIR + '>' + esc(m.sub) + '</div>'; }
      h += '</div>';
    }
    return h + '</div>';
  }

  function bLowerThird(c) {
    var m = c.m, h = '<div class="vis-ltw"><div class="vis-surf vis-ltp vis-lim"><div class="vis-lt-bar"></div><div class="vis-lt-tx">';
    h += bTitle('vis-lt-n', m.title);
    if (m.sub) { h += '<div class="vis-lt-sw"><div class="vis-lt-s"' + DIR + '>' + esc(m.sub) + '</div></div>'; }
    return h + '</div></div></div>';
  }

  function bTitleCard(c) {
    var m = c.m, h = '<div class="vis-surf vis-panel vis-chk"><div class="vis-in">';
    h += bTitle('vis-tc-t', m.title);
    if (m.sub) {
      if (m.title) { h += '<div class="vis-rule"></div>'; }
      h += '<div class="vis-tc-s"' + DIR + '>' + esc(m.sub) + '</div>';
    }
    return h + '</div></div>';
  }

  function bBigNumber(c) {
    var m = c.m, h = '<div class="vis-surf vis-panel vis-chk"><div class="vis-in">';
    if (m.title) {
      h += '<div class="vis-h vis-bn-v"' + DIR + '>';
      if (m.num) {
        if (m.num.pre) { h += '<span class="vis-bn-u">' + esc(m.num.pre) + '</span>'; }
        h += esc(m.num.num);
        if (m.num.suf) { h += '<span class="vis-bn-u' + (m.num.spaced ? ' vis-bn-sp' : '') + '">' + esc(m.num.suf) + '</span>'; }
      } else { h += esc(m.title); }
      h += '</div>';
    }
    if (m.label) { h += '<div class="vis-bn-lw' + (m.title ? '' : ' vis-bn-solo') + '"><div class="vis-bn-l"' + DIR + '>' + esc(m.label) + '</div></div>'; }
    return h + '</div></div>';
  }

  function bQuote(c) {
    var m = c.m, h = '<div class="vis-surf vis-panel vis-chk"><div class="vis-in"><div class="vis-qm"><span>\u201C</span></div>';
    if (m.quote) { h += '<div class="vis-q"' + DIR + '>' + esc(m.quote) + '</div>'; }
    if (m.title) { h += '<div class="vis-by"><div class="vis-by-t"' + DIR + '>\u2014 ' + esc(m.title) + '</div></div>'; }
    return h + '</div></div>';
  }

  function keyHtml(k, accent) {
    var cls = 'vis-key' + (k.stacked ? ' vis-key-s' : '') + (k.wide ? ' vis-key-w' : '') + (k.single ? ' vis-key-1' : '') + (accent ? ' vis-key-x' : '');
    var inside;
    if (k.stacked) { inside = '<span class="vis-key-g">' + esc(k.g) + '</span><span class="vis-key-t">' + esc(k.t) + '</span>'; }
    else if (!k.t && k.g) { inside = '<span class="vis-key-g vis-key-ar">' + esc(k.g) + '</span>'; }
    else { inside = '<span class="vis-key-t">' + esc(k.t) + '</span>'; }
    return '<span class="' + cls + '">' + inside + '</span>';
  }
  function bShortcut(c) {
    var m = c.m, h = '<div class="vis-surf vis-panel vis-chk"><div class="vis-in">', i, gi, ki, row, grp, hasLabels = m.rows.some(function (r) { return r.label; });
    h += bTitle('vis-sc-t', m.title);
    if (m.rows.length) {
      h += '<div class="vis-sc-rows">';
      for (i = 0; i < m.rows.length; i++) {
        row = m.rows[i];
        if (i && !hasLabels) { h += '<div class="vis-or"><span>or</span></div>'; }
        h += '<div class="vis-sc-row">';
        if (row.label) { h += '<span class="vis-sc-lab"' + DIR + '>' + esc(row.label) + '</span>'; }
        for (gi = 0; gi < row.groups.length; gi++) {
          grp = row.groups[gi];
          if (gi) { h += '<span class="vis-then">\u203A</span>'; }
          for (ki = 0; ki < grp.length; ki++) {
            if (ki) { h += '<span class="vis-plus">+</span>'; }
            h += keyHtml(grp[ki], gi === row.groups.length - 1 && ki === grp.length - 1);
          }
        }
        h += '</div>';
      }
      h += '</div>';
    }
    return h + '</div></div>';
  }

  function rootVars(T, g, fs, bg) {
    var a = T.accent, halo = rgba(T.surface, 0.9);
    var pbg = bg === 'solid' ? T.surface : (bg === 'soft' ? rgba(T.surface, 0.88) : 'transparent');
    var pbgFb = bg === 'solid' ? T.surface : (bg === 'soft' ? rgba(T.surface, 0.96) : 'transparent');
    var v = [
      ['fs', px(fs)],
      ['bg', T.bg], ['surface', T.surface], ['fg', T.fg], ['muted', T.muted], ['border', T.border],
      ['accent', a], ['accent2', T.accent2], ['success', T.success], ['warn', T.warn], ['danger', T.danger],
      ['ink', T.ink], ['acc-tx', T.accTx], ['s2', T.s2], ['key', T.key], ['key-edge', T.keyEdge], ['key-hi', T.keyHi], ['acc-edge', T.accEdge],
      ['a10', rgba(a, 0.1)], ['a25', rgba(a, 0.25)], ['a45', rgba(a, 0.45)],
      ['pbg', pbg], ['pbg-fb', pbgFb],
      ['tsh', '0 0 .1em ' + halo + ',0 0 .28em ' + halo + ',0 0 .6em ' + halo + ',0 .04em .3em rgba(0,0,0,.18)'],
      ['fd', T.fd], ['fb', T.fb], ['fm', T.fm], ['fw', String(T.fw)], ['fwq', String(T.fwq)], ['ls', T.ls + 'em'],
      ['r', px(g.r)], ['r2', px(g.r2)], ['r3', px(g.r3)], ['br', g.br], ['bw', px(g.bw)], ['sh', g.sh], ['blur', px(g.blur)]
    ];
    var out = [], i;
    for (i = 0; i < v.length; i++) { out.push('--vis-' + v[i][0] + ':' + v[i][1]); }
    return out.join(';');
  }

  /** env (render() only): { room: { above, below } } = free pixels around the host, so a highlight label can sit outside the ring. */
  function build(visual, style, hostW, hostH, env) {
    var n = normalize(visual);
    var W = clamp(num(hostW, 320), 8, 12000), H = clamp(num(hostH, 180), 8, 12000);
    var T = tokens(style, n.opts.accent), g = geom(W, H, T, n.opts.bg), m = prepare(n);
    var pl = plan(n, m, W, H, T, g, env), c = ctxOf(n, m, W, H, T, g, env), body;
    switch (n.kind) {
      case 'list': body = bList(c, pl, false); break;
      case 'steps': body = bList(c, pl, true); break;
      case 'diagram': body = bDiagram(c, pl); break;
      case 'callout': body = bCallout(c, pl); break;
      case 'highlight': body = bHighlight(c, pl); break;
      case 'lower-third': body = bLowerThird(c); break;
      case 'big-number': body = bBigNumber(c); break;
      case 'quote': body = bQuote(c); break;
      case 'shortcut': body = bShortcut(c); break;
      default: body = bTitleCard(c);
    }
    var cls = 'vis-root vis-k-' + n.kind + ' vis-a-' + n.opts.align + ' vis-bg-' + n.opts.bg + ' vis-th-' + T.theme + (m.ph ? ' vis-ph' : '');
    var html = '<div class="' + cls + '" data-vis-kind="' + n.kind + '" style="' + esc(rootVars(T, g, pl.fs, n.opts.bg)) + '">' + body + '</div>';
    return { html: html, plan: pl, tokens: T, norm: n, model: m, geom: g, W: W, H: H };
  }

  function html(visual, style, hostW, hostH) { return build(visual, style, hostW, hostH).html; }

  /* ===========================================================================================
   * 9. render into a host element
   * ========================================================================================= */
  var HOST_VARS = ['bg', 'surface', 'fg', 'muted', 'border', 'accent', 'accent2', 'success', 'warn', 'danger', 'fd', 'fb', 'fm', 'fw', 'ls'];
  function setHostVars(host, T) {
    if (!host || !host.style || typeof host.style.setProperty !== 'function') { return; }
    var i, k, v;
    for (i = 0; i < HOST_VARS.length; i++) {
      k = HOST_VARS[i]; v = T[k];
      if (k === 'ls') { v = v + 'em'; } else if (k === 'fw') { v = String(v); }
      host.style.setProperty('--vis-' + k, v);
    }
  }
  function overflowing(root) {
    var w = root.clientWidth, h = root.clientHeight, i, e, list;
    list = root.querySelectorAll('.vis-chk');
    for (i = 0; i < list.length; i++) {
      e = list[i];
      if (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1) { return true; }
    }
    list = root.querySelectorAll('.vis-lim');
    for (i = 0; i < list.length; i++) {
      e = list[i];
      if (e.offsetWidth > w + 1 || e.offsetHeight > h + 1) { return true; }
    }
    list = root.querySelectorAll('.vis-ltp');
    for (i = 0; i < list.length; i++) {
      if (list[i].offsetHeight > h * 0.93) { return true; }
    }
    return false;
  }
  /**
   * Free room in px above and below the host, up to the nearest ancestor that clips its content (the video frame or preview box),
   * or null when the page cannot tell (no layout, no clipping ancestor). A highlight label that does not fit inside its ring hangs
   * outside it and needs that room. Uses only the host's own document: no global lookups.
   */
  function roomAround(host) {
    try {
      var doc = host.ownerDocument, view = doc && doc.defaultView, p = host.parentNode, cs, fr, hr;
      if (!view || typeof view.getComputedStyle !== 'function' || typeof host.getBoundingClientRect !== 'function') { return null; }
      while (p && p.nodeType === 1) {
        cs = view.getComputedStyle(p);
        if (cs && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible')) {
          fr = p.getBoundingClientRect(); hr = host.getBoundingClientRect();
          return { above: hr.top - fr.top, below: fr.bottom - hr.bottom };
        }
        p = p.parentNode;
      }
    } catch (e) { /* layout not available */ }
    return null;
  }
  /** a label outside the ring is drawn beyond the host box, so the host must not clip it; restored as soon as it is not needed. */
  function setOverflow(host, visible) {
    try {
      if (!host || !host.style) { return; }
      if (visible) {
        if (!host.visOv) { host.visOv = { v: host.style.overflow || '' }; }
        host.style.overflow = 'visible';
      } else if (host.visOv) {
        host.style.overflow = host.visOv.v;
        host.visOv = null;
      }
    } catch (e) { /* read-only host */ }
  }
  function render(host, visual, style) {
    if (!host) { return; }
    var W = num(host.clientWidth, 0), H = num(host.clientHeight, 0);
    if (W < 4) { W = 640; }
    if (H < 4) { H = 360; }
    var res = build(visual, style, W, H), room;
    if (res.plan.place === 'out') {
      // the label wants to sit above the ring: is there room above (or below) it inside the frame? If not, build again knowing that
      room = roomAround(host);
      if (room) { res = build(visual, style, W, H, { room: room }); }
    }
    setHostVars(host, res.tokens);
    setOverflow(host, res.plan.place === 'out' || res.plan.place === 'below');
    host.innerHTML = res.html;
    // safety net: the estimate is conservative, but if the browser still reports overflow, shrink in small steps
    try {
      if (typeof host.querySelector !== 'function') { return; }
      var root = host.querySelector('.vis-root');
      if (!root || !root.style || typeof root.style.setProperty !== 'function' || typeof root.querySelectorAll !== 'function') { return; }
      var fs = res.plan.fs, tries = 0;
      while (tries < 10 && fs > 1.2 && overflowing(root)) {
        fs = fs * 0.92;
        root.style.setProperty('--vis-fs', px(fs));
        tries++;
      }
    } catch (e) { /* layout not available: keep the estimate */ }
  }

  /* ===========================================================================================
   * 10. describe() for the markdown export
   * ========================================================================================= */
  function q(s) { return '"' + s + '"'; }
  // What the AI is asked to write for each kind when the author did not type the words ("AI writes it from my comment")
  var AI_TEXT = {
    'list': 'a heading (optional, up to about 6 words) and 3 to 6 short bullets, one idea per line (at most 12)',
    'steps': 'a heading (optional) and 3 to 6 short steps in the order they happen, one per line (at most 12)',
    'diagram': 'an optional heading and 2 to 8 short boxes in order, written as A -> B -> C (at most 8)',
    'callout': 'an optional short heading and one or two short sentences (about 12 to 25 words)',
    'highlight': 'a short label (2 to 4 words) and an optional small caption',
    'lower-third': 'a name and a short subtitle (role or topic)',
    'title-card': 'a short title (up to about 8 words) and an optional subtitle',
    'big-number': 'one value (a number, percentage or amount) and a short label under it',
    'quote': 'a short quotation and who said it',
    'shortcut': 'what the shortcut does and the keys joined by + (one shortcut per line; give both Windows and Mac keys when both apply)'
  };
  var KEYCAP_NOTE = 'Draw each key as a keyboard keycap with a slightly raised edge, joined by small "+" signs; the last key of each shortcut uses the accent colour. Keys written as Mac symbols (command, option, shift, control) or named Command/Option are drawn as the symbol with a small word under it; Enter, Tab, Backspace and Delete are drawn with their symbol and a small word; Esc, Ctrl, Alt, Shift and Win written as words are plain word keycaps. Several shortcuts are separated by "or" (or by their platform labels).';
  // How each kind is laid out, for visuals whose words the AI writes (the per-kind blocks below describe finished text)
  var AI_LAYOUT = {
    'list': 'Layout: the heading on top, then one bullet point per line.',
    'steps': 'Layout: the heading on top, then numbered steps on accent coloured badges, one per line.',
    'diagram': 'Layout: boxes joined by arrows from each box to the next; the last box is the accent coloured result. Lay the boxes out horizontally if the drawn box is wide, vertically if it is tall.',
    'callout': 'Layout: a card, with a small pointer tail only as given by the "Pointer tail" line below.',
    'lower-third': 'Layout: a name bar anchored near the bottom of the box with an accent bar on one side.',
    'title-card': 'Layout: big title, a short accent rule, then the subtitle.',
    'big-number': 'Layout: one huge value in the accent colour (a currency symbol or unit is set smaller) with the label under it.',
    'quote': 'Layout: a large accent coloured opening quote mark above the quote, the attribution below it.',
    'shortcut': KEYCAP_NOTE
  };
  // opts.aiText: the author did not type the words; describe what to write instead. opts.spoken: words said inside the marker (optional).
  function describe(visual, style, opts) {
    var n = normalize(visual), T = tokens(style, n.opts.accent), st = (style && typeof style === 'object') ? style : {};
    var m = prepare(n), k = kindById(n.kind), L = [], i;
    var o = n.opts, ai = !!(opts && opts.aiText);
    var title = n.content.title ? oneLine(n.content.title) : '', empty = m.ph;
    L.push('Visual kind: ' + k.label + ' (' + n.kind + '). ' + k.blurb);
    if (ai) {
      L.push('Text: not written yet. Write it yourself from the marker Comment (it says what is wanted) and from what is said at this time. Write ' + AI_TEXT[n.kind] + '.');
      L.push('Use only facts that appear in the Comment or in what is said at this time; never invent numbers, names or steps. Keep every line short enough to fit the drawn box.');
      var sp = (opts && isStr(opts.spoken)) ? oneLine(clean(opts.spoken, 1500)) : '';
      L.push(sp ? 'Spoken at this time: ' + q(sp) : 'Spoken at this time: not available, so write the text from the Comment alone.');
      if (AI_LAYOUT[n.kind]) { L.push(AI_LAYOUT[n.kind]); }
      if (n.kind === 'callout') { L.push('Pointer tail: ' + (resolvePointer(o) === 'none' ? 'none (draw no tail)' : resolvePointer(o) + ' edge' + (o.pointer === 'auto' ? ' (auto)' : '')) + '.'); }
    } else if (empty) { L.push('No text has been entered for this visual yet (the editor preview shows placeholder wording). Ask the editor for the wording, or leave the text areas clearly marked as empty.'); }
    switch (ai ? (n.kind === 'highlight' ? 'highlight' : '') : (empty ? '' : n.kind)) {
      case 'list':
        L.push('Heading: ' + (title ? q(title) : 'none') + '.');
        L.push('Bullets (' + m.items.length + '), top to bottom:');
        for (i = 0; i < m.items.length; i++) { L.push('Bullet ' + (i + 1) + ': ' + q(m.items[i])); }
        if (m.dropped) { L.push('Note: ' + m.dropped + ' extra bullet(s) were ignored because the maximum is ' + MAXITEMS + '.'); }
        break;
      case 'steps':
        L.push('Heading: ' + (title ? q(title) : 'none') + '.');
        L.push('Numbered steps (' + m.items.length + '), top to bottom, numbers on accent coloured badges:');
        for (i = 0; i < m.items.length; i++) { L.push('Step ' + (i + 1) + ': ' + q(m.items[i])); }
        if (m.dropped) { L.push('Note: ' + m.dropped + ' extra step(s) were ignored because the maximum is ' + MAXITEMS + '.'); }
        break;
      case 'diagram':
        L.push('Heading: ' + (title ? q(title) : 'none') + '.');
        L.push('Flow of ' + m.nodes.length + ' boxes joined by arrows, in this order:');
        for (i = 0; i < m.nodes.length; i++) { L.push('Node ' + (i + 1) + ': ' + q(m.nodes[i])); }
        L.push('Flow in one line: ' + m.nodes.join(' -> '));
        L.push('Arrows point from each node to the next. The last node is the accent coloured result. Lay the boxes out horizontally if the box is wide, vertically if it is tall.');
        if (m.dropped) { L.push('Note: ' + m.dropped + ' extra node(s) were ignored because the maximum is ' + MAXNODES + '.'); }
        break;
      case 'callout':
        L.push('Heading: ' + (title ? q(title) : 'none') + '.');
        L.push('Callout text: ' + (m.paras.length ? q(m.paras.join(' / ')) : 'none') + '.');
        L.push('Pointer tail: ' + (resolvePointer(o) === 'none' ? 'none' : resolvePointer(o) + ' edge' + (o.pointer === 'auto' ? ' (auto)' : '')) + '.');
        break;
      case 'highlight':
        if (!ai) {
          L.push('Label text: ' + (title ? q(title) : 'none') + '.');
          L.push('Small caption under the label: ' + (m.sub ? q(m.sub) : 'none') + '.');
        }
        L.push('The drawn box itself is the highlight. Draw a rounded accent coloured outline around the whole box with a soft glow, and a thin dark line just outside it and a thin light line just inside it so the outline stays visible on both light and dark recordings. ' +
          (o.bg === 'soft' ? 'Inside the outline put only a very faint wash of the accent colour (about 10%), so the recording still shows through.' : 'Keep the inside of the outline transparent so the screen recording shows through.'));
        L.push('Label: ' + (o.bg === 'solid' ? 'a solid accent coloured chip with text in the contrast ink colour (' + T.ink + ')' :
          (o.bg === 'soft' ? 'a translucent panel coloured chip (surface at about 88% opacity with a backdrop blur) with an accent coloured border and normal text colour' :
            'no chip, only the text in the normal text colour with a soft surface coloured halo')) + ', placed at the ' + (o.align === 'center' ? 'centre' : o.align) + ' of the top edge of the box.');
        L.push('If the chip would cover more than about a fifth of the box (a small or narrow box), attach it to the top of the outline on the outside instead (under the outline if there is no room above it, inside only if there is no room at all). Keep the label text at least about 12 px in the preview (about 1.5% of the frame width), even on a narrow box.');
        break;
      case 'lower-third':
        L.push('Name: ' + (title ? q(title) : 'none') + '.');
        L.push('Subtitle: ' + (m.sub ? q(m.sub) : 'none') + '.');
        L.push('A name bar anchored near the bottom of the box with an accent bar on one side.');
        break;
      case 'title-card':
        L.push('Title: ' + (title ? q(title) : 'none') + '.');
        L.push('Subtitle: ' + (m.sub ? q(m.sub) : 'none') + '.');
        L.push('Big title, a short accent rule, then the subtitle.');
        break;
      case 'big-number':
        L.push('Big value: ' + (title ? q(title) : 'none') + ' (the hero text, in the accent colour; a currency symbol or unit is set smaller).');
        L.push('Label under the value: ' + (m.label ? q(m.label) : 'none') + '.');
        break;
      case 'quote':
        L.push('Quote: ' + (m.quote ? q(m.quote) : 'none') + '.');
        L.push('Attribution: ' + (title ? q(title) : 'none') + '.');
        L.push('A large accent coloured opening quote mark sits above the quote.');
        break;
      case 'shortcut':
        L.push('What it does: ' + (title ? q(title) : 'none') + '.');
        L.push('Shortcuts (' + m.rows.length + '):');
        for (i = 0; i < m.rows.length; i++) {
          L.push('Shortcut ' + (i + 1) + (m.rows[i].label ? ' for ' + m.rows[i].label : '') + ': ' + chordText(m.rows[i]) + '. One keycap per key, in this order' +
            (m.rows[i].groups.length > 1 ? ', pressed one after another (a sequence), with a small arrow between the steps' : ', pressed together') + '.');
        }
        if (m.dropped) { L.push('Note: ' + m.dropped + ' extra shortcut line(s) were ignored because the maximum is ' + MAXROWS + '.'); }
        if (m.droppedKeys) { L.push('Note: ' + m.droppedKeys + ' extra key(s) were ignored because a shortcut shows at most ' + MAXKEYS + ' keys per step and ' + MAXKEYS + ' steps.'); }
        L.push(KEYCAP_NOTE);
        break;
    }
    var bgText = n.kind === 'highlight' ?
      'label background ' + (o.bg === 'solid' ? 'solid (accent coloured chip)' : (o.bg === 'soft' ? 'soft (translucent surface chip with an accent border, plus a faint accent wash inside the outline)' : 'none (label text only, with a soft halo; no chip)')) :
      'panel background ' + (o.bg === 'solid' ? 'solid (opaque surface)' : (o.bg === 'soft' ? 'soft (surface at about 88% opacity with a backdrop blur)' : 'none (no panel, text needs a soft halo or shadow to stay legible)'));
    L.push('Options: align ' + o.align + '; size scale ' + o.scale + ' (1 = natural size); ' + bgText +
      '; accent ' + (o.accent ? 'overridden to ' + o.accent : 'from the style (' + T.accent + ')') +
      (n.kind === 'callout' ? '; pointer ' + o.pointer : '') + '.');
    function meta(v, n) { return oneLine(clean(v, n)).replace(/[<>]/g, ''); }
    var sName = meta(st.name, 80) || DEFAULT_STYLE.name, sId = meta(st.id, 80) || DEFAULT_STYLE.id;
    var sSrc = meta(st.source, 30), sCat = meta(st.category, 40), sMood = meta(st.atmosphere, 300);
    L.push('Style: ' + q(sName) + ' (id ' + sId + ', ' + T.theme + ' theme' + (sSrc ? ', source ' + sSrc : '') + (sCat ? ', category ' + sCat : '') + ').');
    if (sMood) { L.push('Style mood: ' + sMood); }
    L.push('Colours: background ' + T.bg + ', panel surface ' + T.surface + ', text ' + T.fg + ', muted text ' + T.muted + ', border ' + T.border + ', accent ' + T.accent + '.');
    L.push('Fonts: display ' + T.fd + ' at weight ' + T.fw + ' with letter-spacing ' + T.ls + 'em; body ' + T.fb + '.');
    L.push('Shape: corner radius ' + T.r + ' px on a reference card (scale it with the box size), shadow ' + T.sh + '.');
    L.push(n.kind === 'highlight' ?
      'Build it to fill the drawn box (only the label may sit just outside it, as described above), keep every word readable, and use the style colours, fonts, radius and shadow above.' :
      'Build it to fill the drawn box, keep every word inside the box, and use the style colours, fonts, radius and shadow above.');
    return L;
  }

  /* ===========================================================================================
   * 11. CSS
   * ========================================================================================= */
  function css() {
    var P = G.pad, a = [];
    function add(s) { a.push(s); }
    add('.vis-root,.vis-root *{box-sizing:border-box}');
    add('.vis-root{position:relative;display:block;width:100%;height:100%;margin:0;padding:0;font-family:var(--vis-fb);font-size:var(--vis-fs,16px);font-weight:400;font-style:normal;line-height:' + G.lh + ';color:var(--vis-fg);text-align:start;text-transform:none;letter-spacing:normal;text-decoration:none;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;-webkit-text-size-adjust:100%;pointer-events:none;-webkit-user-select:none;user-select:none}');
    add('.vis-a-center{text-align:center}.vis-a-right{text-align:right}');
    add('.vis-ph{opacity:.55}');
    // surfaces
    add('.vis-surf{position:relative;overflow:hidden;border-radius:var(--vis-r);background:var(--vis-pbg);border:var(--vis-bw) solid var(--vis-border);box-shadow:var(--vis-sh)}');
    add('.vis-bg-soft .vis-surf{-webkit-backdrop-filter:blur(var(--vis-blur));backdrop-filter:blur(var(--vis-blur))}');
    add('@supports not ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){.vis-bg-soft .vis-surf{background:var(--vis-pbg-fb)}}');
    add('.vis-bg-none .vis-surf{background:transparent;border-color:transparent;box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none}');
    add('.vis-bg-none .vis-surf,.vis-bg-none .vis-chip{text-shadow:var(--vis-tsh)}');
    add('.vis-panel{display:flex;flex-direction:column;width:100%;height:100%}');
    add('.vis-in{margin-top:auto;margin-bottom:auto;width:100%;min-width:0}');
    var kinds = ['list', 'steps', 'diagram', 'callout', 'title-card', 'big-number', 'quote', 'shortcut'], i;
    for (i = 0; i < kinds.length; i++) { add('.vis-k-' + kinds[i] + ' .vis-panel{padding:' + P[kinds[i]][1] + 'em ' + P[kinds[i]][0] + 'em}'); }
    // display text
    add('.vis-h{font-family:var(--vis-fd);font-weight:var(--vis-fw);letter-spacing:var(--vis-ls);line-height:' + G.tlh + ';color:var(--vis-fg);overflow-wrap:break-word;word-break:break-word}');
    // list + steps
    add('.vis-lst-t{font-size:' + G.lstTitle + 'em;padding-bottom:' + rnd(G.lstTitlePadB / G.lstTitle, 4) + 'em;margin-bottom:' + rnd(G.lstTitleMarB / G.lstTitle, 4) + 'em;border-bottom:var(--vis-bw) solid var(--vis-border)}');
    add('.vis-lst-t:last-child{padding-bottom:0;margin-bottom:0;border-bottom:0}');
    add('.vis-lst{display:grid;grid-auto-flow:column;grid-template-columns:repeat(var(--vis-cols,1),minmax(0,1fr));grid-template-rows:repeat(var(--vis-rows,1),auto);column-gap:' + G.colGap + 'em;row-gap:' + G.lstGap + 'em;list-style:none;margin:0;padding:0}');
    add('.vis-stp{row-gap:' + G.stpGap + 'em}');
    add('.vis-li{display:flex;align-items:flex-start;gap:' + G.markGap + 'em;min-width:0;line-height:' + G.lh + '}');
    add('.vis-stp .vis-li{gap:' + G.stpMarkGap + 'em}');
    add('.vis-li-t{flex:1 1 auto;min-width:0;overflow-wrap:break-word;word-break:break-word}');
    add('.vis-a-center .vis-li{justify-content:center}.vis-a-center .vis-li-t{flex:0 1 auto}');
    add('.vis-a-right .vis-li{flex-direction:row-reverse}.vis-a-right .vis-li-t{flex:0 1 auto}');
    add('.vis-dot{display:block;flex:0 0 auto;width:' + G.dotW + 'em;height:' + G.dotW + 'em;margin-top:' + rnd((G.lh - G.dotW) / 2, 3) + 'em;border-radius:var(--vis-br);background:var(--vis-acc-tx)}');
    add('.vis-sn{display:flex;flex:0 0 auto;align-items:center;justify-content:center;width:' + G.stpBadge + 'em;height:' + G.stpBadge + 'em;border-radius:var(--vis-br);background:var(--vis-accent);color:var(--vis-ink);font-family:var(--vis-fd);font-weight:var(--vis-fw);letter-spacing:0;text-shadow:none}');
    add('.vis-sn b{font-size:.9em;font-weight:inherit;line-height:1}');
    add('.vis-st-t{padding-top:' + G.stpPadTop + 'em}');
    add('.vis-rail .vis-li{position:relative}');
    add('.vis-rail .vis-li:not(:last-child)::after{content:"";position:absolute;inset-inline-start:calc(' + (G.stpBadge / 2) + 'em - var(--vis-bw));top:' + G.stpBadge + 'em;bottom:-' + G.stpGap + 'em;width:calc(var(--vis-bw) * 2);background:var(--vis-border)}');
    // diagram
    add('.vis-dg-t{font-size:' + G.dgTitle + 'em;margin-bottom:' + rnd(G.dgTitleMar / G.dgTitle, 4) + 'em}');
    add('.vis-flow{display:flex;align-items:stretch;justify-content:center;text-align:center}');
    add('.vis-flow-v{flex-direction:column;align-items:center}');
    add('.vis-node{flex:1 1 0;min-width:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:' + G.nodePadY + 'em ' + G.nodePadX + 'em;border-radius:var(--vis-r2);background:var(--vis-s2);color:var(--vis-fg);border:var(--vis-bw) solid var(--vis-border);font-weight:600;line-height:' + G.nodeLh + ';overflow-wrap:break-word;word-break:break-word;text-shadow:none}');
    add('.vis-node span{min-width:0;overflow-wrap:break-word;word-break:break-word}');
    add('.vis-flow-v .vis-node{flex:0 0 auto;width:100%;max-width:' + G.nodeMaxW + 'em}');
    add('.vis-node-x{background:var(--vis-accent);border-color:var(--vis-accent);color:var(--vis-ink)}');
    add('.vis-node-g{background:transparent;border-style:dashed;color:var(--vis-muted)}');
    add('.vis-arr{display:flex;flex:0 0 ' + G.arrow + 'em;align-items:center;justify-content:center;color:var(--vis-muted)}');
    add('.vis-arr svg{display:block;width:1em;height:1em;overflow:visible}');
    // bg none: nothing sits behind the marks, so arrows get the text colour and a surface coloured halo, bullets and the step rail a ring of it
    add('.vis-bg-none .vis-arr{color:var(--vis-fg);-webkit-filter:drop-shadow(0 0 .08em var(--vis-surface)) drop-shadow(0 0 .22em var(--vis-surface));filter:drop-shadow(0 0 .08em var(--vis-surface)) drop-shadow(0 0 .22em var(--vis-surface))}');
    add('.vis-bg-none .vis-dot{box-shadow:0 0 0 .12em var(--vis-surface)}');
    add('.vis-bg-none .vis-rail .vis-li:not(:last-child)::after{background:var(--vis-muted);box-shadow:0 0 0 .1em var(--vis-surface)}');
    add('.vis-flow-v .vis-arr{width:100%;height:' + G.arrow + 'em}');
    add('.vis-flow-v .vis-arr svg{-webkit-transform:rotate(90deg);transform:rotate(90deg)}');
    // callout
    add('.vis-co{position:absolute;left:0;top:0;right:0;bottom:0}');
    add('.vis-ptr-down{padding-bottom:' + G.tail + 'em}.vis-ptr-up{padding-top:' + G.tail + 'em}.vis-ptr-left{padding-left:' + G.tail + 'em}.vis-ptr-right{padding-right:' + G.tail + 'em}');
    add('.vis-cw{position:relative;width:100%;height:100%}');
    add('.vis-tail{position:absolute;display:block;overflow:visible}');
    add('.vis-tail path{fill:var(--vis-pbg);stroke:var(--vis-border);stroke-width:var(--vis-bw);stroke-linejoin:round;vector-effect:non-scaling-stroke}');
    add('.vis-co-in{display:flex;gap:' + G.coGap + 'em;align-items:stretch;min-width:0}');
    add('.vis-bar{flex:0 0 ' + G.coBar + 'em;border-radius:' + (G.coBar / 2) + 'em;background:var(--vis-acc-tx)}');
    add('.vis-co-tx{flex:1 1 auto;min-width:0}');
    add('.vis-a-right .vis-co-in{flex-direction:row-reverse}');
    add('.vis-a-center .vis-co-in{flex-direction:column;align-items:center}');
    add('.vis-a-center .vis-bar{flex:0 0 auto;width:2.2em;height:' + G.coBarTop + 'em}');
    add('.vis-a-center .vis-co-tx{width:100%}');
    add('.vis-co-t{font-size:' + G.coTitle + 'em;margin-bottom:' + rnd(G.coTitleMar / G.coTitle, 4) + 'em}');
    add('.vis-co-t:last-child{margin-bottom:0}');
    add('.vis-co-b{line-height:' + G.coLh + ';overflow-wrap:break-word;word-break:break-word}');
    add('.vis-co-b+.vis-co-b{margin-top:' + G.coParGap + 'em}');
    // highlight. The ring is drawn entirely INSIDE the host box (a host that clips, like the app's, would cut anything outside it):
    // a thin dark line outermost, the accent line, then a thin light line, so the ring reads on white AND on dark recordings.
    // --vis-rw = accent line, --vis-kw = each neutral line, --vis-rbd = border drawn by the ring, --vis-rb = whole thickness
    add('.vis-hl{position:absolute;left:0;top:0;right:0;bottom:0;--vis-rw:max(2px,.2em);--vis-kw:calc(var(--vis-rw) * ' + G.ringKey + ');--vis-rbd:calc(var(--vis-rw) + var(--vis-kw));--vis-rb:calc(var(--vis-rw) + 2 * var(--vis-kw))}');
    add('.vis-ring{position:absolute;left:0;top:0;right:0;bottom:0;border:var(--vis-rbd) solid var(--vis-accent);border-radius:var(--vis-r);box-shadow:inset 0 0 0 var(--vis-kw) rgba(255,255,255,' + G.ringLight + '),0 0 0 calc(var(--vis-rw) * .6) var(--vis-a25),0 0 1.1em var(--vis-a45)}');
    add('.vis-ring::before{content:"";position:absolute;left:calc(-1 * var(--vis-rbd));top:calc(-1 * var(--vis-rbd));right:calc(-1 * var(--vis-rbd));bottom:calc(-1 * var(--vis-rbd));border-radius:var(--vis-r);box-shadow:inset 0 0 0 var(--vis-kw) rgba(0,0,0,' + G.ringDark + ')}');
    add('.vis-bg-soft .vis-ring{background:var(--vis-a10)}');
    // the chip: width is max-content (clamped by max-width), so a centred chip is not squeezed into the half box that left:50% leaves. The
    // max-width numbers are the ones planHighlight() wraps at: inside = box - 2 x (radius + inset) and at most hlInW of the box; outside = the
    // same without the hlInW limit but never narrower than chipOutMin em; 'wide' (inside, no room outside) = box - 2 x (radius + inset).
    var chipEdge = '2 * (var(--vis-r) + ' + G.chipInset + 'em)';
    add('.vis-chip{position:absolute;top:var(--vis-rb);width:-webkit-max-content;width:max-content;max-width:min(calc(100% - ' + chipEdge + '),' + (G.hlInW * 100) + '%);padding:' + G.chipPadT + 'em ' + G.chipPadX + 'em ' + G.chipPadB + 'em;border-radius:0 0 var(--vis-r2) var(--vis-r2);background:var(--vis-accent);color:var(--vis-ink);text-shadow:none;line-height:' + G.chipLh + ';text-align:start;overflow:hidden}');
    add('.vis-chip-wide{max-width:calc(100% - ' + chipEdge + ')}');
    add('.vis-chip-out,.vis-chip-below{max-width:max(calc(100% - ' + chipEdge + '),' + G.chipOutMin + 'em)}');
    add('.vis-chip-out{top:auto;bottom:100%;border-radius:var(--vis-r2) var(--vis-r2) 0 0}');
    add('.vis-chip-below{top:100%}');
    add('.vis-chip-t{font-family:var(--vis-fd);font-weight:var(--vis-fw);letter-spacing:var(--vis-ls);overflow-wrap:break-word;word-break:break-word}');
    add('.vis-chip-s{font-size:' + G.chipSub + 'em;line-height:' + G.chipSubLh + ';opacity:.9;overflow-wrap:break-word;word-break:break-word}');
    add('.vis-chip-t+.vis-chip-s{margin-top:' + rnd(G.chipSubMar / G.chipSub, 3) + 'em}');
    add('.vis-bg-soft .vis-chip{background:var(--vis-pbg);color:var(--vis-fg);border:var(--vis-bw) solid var(--vis-accent);border-top:0;-webkit-backdrop-filter:blur(var(--vis-blur));backdrop-filter:blur(var(--vis-blur))}');
    add('.vis-bg-soft .vis-chip-out{border-top:var(--vis-bw) solid var(--vis-accent);border-bottom:0}');
    add('@supports not ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){.vis-bg-soft .vis-chip{background:var(--vis-pbg-fb)}}');
    add('.vis-bg-none .vis-chip{background:transparent;color:var(--vis-fg)}');
    // lower third
    add('.vis-ltw{position:absolute;left:2%;right:2%;bottom:7%;display:flex;justify-content:flex-start}');
    add('.vis-a-center .vis-ltw{justify-content:center}.vis-a-right .vis-ltw{justify-content:flex-end}');
    add('.vis-ltp{display:flex;flex-direction:row;align-items:stretch;max-width:100%}');
    add('.vis-lt-bar{flex:0 0 ' + G.ltBar + 'em;background:var(--vis-acc-tx)}');
    add('.vis-lt-tx{min-width:0;padding:' + G.ltPadT + 'em ' + G.ltPadR + 'em ' + G.ltPadB + 'em ' + G.ltPadL + 'em}');
    add('.vis-lt-n{line-height:' + G.ltLh + '}');
    add('.vis-lt-sw{margin-top:' + G.ltSubMar + 'em}');
    add('.vis-lt-s{font-size:' + G.ltSub + 'em;line-height:' + G.ltSubLh + ';color:var(--vis-muted);font-weight:500;overflow-wrap:break-word;word-break:break-word}');
    add('.vis-a-right .vis-ltp{flex-direction:row-reverse}.vis-a-right .vis-lt-tx{padding:' + G.ltPadT + 'em ' + G.ltPadL + 'em ' + G.ltPadB + 'em ' + G.ltPadR + 'em}');
    add('.vis-a-center .vis-ltp{flex-direction:column}.vis-a-center .vis-lt-bar{flex:0 0 ' + G.ltTop + 'em}.vis-a-center .vis-lt-tx{padding:' + G.ltPadT + 'em ' + G.ltPadR + 'em ' + G.ltPadB + 'em}');
    // title card
    add('.vis-tc-t{line-height:' + G.tcLh + '}');
    add('.vis-rule{width:' + G.tcRuleW + 'em;height:' + G.tcRuleH + 'em;margin:' + G.tcRuleMar + 'em auto;border-radius:' + (G.tcRuleH / 2) + 'em;background:var(--vis-acc-tx)}');
    add('.vis-a-left .vis-rule{margin-left:0}.vis-a-right .vis-rule{margin-right:0}');
    add('.vis-tc-s{font-size:' + G.tcSub + 'em;line-height:' + G.tcSubLh + ';color:var(--vis-muted);font-weight:500;overflow-wrap:break-word;word-break:break-word}');
    // big number
    add('.vis-bn-v{font-size:1em;line-height:1;color:var(--vis-acc-tx);white-space:nowrap}');
    add('.vis-bn-u{font-size:' + G.bnUnit + 'em}.vis-bn-sp{margin-left:.12em}');
    add('.vis-bn-lw{margin-top:' + G.bnLabelMar + 'em}.vis-bn-solo{margin-top:0}');
    add('.vis-bn-l{font-size:' + G.bnLabel + 'em;line-height:' + G.bnLabelLh + ';color:var(--vis-muted);font-weight:600;overflow-wrap:break-word;word-break:break-word}');
    // quote
    add('.vis-qm{display:block;height:' + G.qmH + 'em;overflow:hidden}');
    add('.vis-qm span{display:block;margin-top:-.1em;font-family:Georgia,"Times New Roman",serif;font-weight:700;font-size:4em;line-height:1;color:var(--vis-acc-tx)}');
    add('.vis-q{font-family:var(--vis-fd);font-weight:var(--vis-fwq);letter-spacing:var(--vis-ls);line-height:' + G.qLh + ';max-width:' + G.qMaxW + 'em;overflow-wrap:break-word;word-break:break-word}');
    add('.vis-a-center .vis-q{margin-left:auto;margin-right:auto}.vis-a-right .vis-q{margin-left:auto}');
    add('.vis-by{margin-top:' + G.qByMar + 'em}');
    add('.vis-by-t{font-size:' + G.qBy + 'em;line-height:' + G.qByLh + ';letter-spacing:.08em;text-transform:uppercase;color:var(--vis-muted);font-weight:600;overflow-wrap:break-word;word-break:break-word}');
    // shortcut
    add('.vis-sc-t{font-size:' + G.scTitle + 'em;margin-bottom:' + rnd(G.scTitleMar / G.scTitle, 4) + 'em}');
    add('.vis-sc-t:last-child{margin-bottom:0}');
    add('.vis-sc-rows{display:flex;flex-direction:column;align-items:center;gap:' + G.rowsGap + 'em}');
    add('.vis-a-left .vis-sc-rows{align-items:flex-start}.vis-a-right .vis-sc-rows{align-items:flex-end}');
    add('.vis-sc-row{display:flex;flex-wrap:wrap;align-items:center;gap:' + G.rowGapY + 'em ' + G.keyGap + 'em;max-width:100%}');
    add('.vis-a-center .vis-sc-row{justify-content:center}.vis-a-left .vis-sc-row{justify-content:flex-start}.vis-a-right .vis-sc-row{justify-content:flex-end}');
    add('.vis-or{display:flex;align-items:center;height:' + rnd(G.orH / G.labScale, 3) + 'em;font-size:' + G.labScale + 'em;line-height:1;letter-spacing:.14em;text-transform:uppercase;color:var(--vis-muted);font-weight:600}');
    add('.vis-sc-lab{font-size:' + G.labScale + 'em;line-height:1;letter-spacing:.14em;text-transform:uppercase;color:var(--vis-muted);font-weight:700;padding:.4em .7em;border:var(--vis-bw) solid var(--vis-border);border-radius:var(--vis-r3);max-width:100%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}');
    add('.vis-plus{font-size:.75em;line-height:1;color:var(--vis-muted);font-weight:600}');
    add('.vis-then{font-size:1em;line-height:1;color:var(--vis-muted);font-weight:600;padding:0 .1em}');
    add('.vis-key{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;min-width:' + G.keyMin + 'em;height:' + G.keyH + 'em;padding:0 ' + G.keyPadX + 'em;border-radius:min(calc(var(--vis-r) * .5),.6em);background:var(--vis-key);color:var(--vis-fg);border:var(--vis-bw) solid var(--vis-border);box-shadow:inset 0 .06em 0 var(--vis-key-hi),0 .1em 0 var(--vis-key-edge),0 .24em .45em rgba(0,0,0,.16);font-family:var(--vis-fb);font-weight:600;line-height:1;white-space:nowrap;text-shadow:none}');
    add('.vis-key-t{font-size:' + G.keyTxt + 'em;line-height:1}');
    add('.vis-key-1 .vis-key-t{font-size:1.05em;font-weight:700}');
    add('.vis-key-g{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI Symbol","Segoe UI",Arial,sans-serif;font-size:.95em;line-height:1}');
    add('.vis-key-ar{font-size:1.15em}');
    add('.vis-key-s .vis-key-g{font-size:.95em}');
    add('.vis-key-s .vis-key-t{margin-top:.2em;font-size:' + G.keyWord + 'em;letter-spacing:.08em;text-transform:uppercase;opacity:.85}');
    add('.vis-key-w{min-width:7.5em}');
    add('.vis-key-x{background:var(--vis-accent);color:var(--vis-ink);border-color:var(--vis-acc-edge);box-shadow:0 .1em 0 var(--vis-acc-edge),0 .24em .45em rgba(0,0,0,.2)}');
    return a.join('\n');
  }

  /* ===========================================================================================
   * 12. public API
   * ========================================================================================= */
  var api = {
    version: '1.0.1',
    KINDS: KINDS,
    OPTIONS: OPTIONS,
    OPTION_USE: OPTION_USE,
    defaultKind: defaultKind,
    normalize: normalize,
    html: html,
    render: render,
    describe: describe,
    css: css,
    escape: esc,
    // internals exposed for tests and tooling (not part of the contract)
    _build: build,
    _plan: function (visual, style, w, h) { var r = build(visual, style, w, h); return r.plan; },
    _parseShortcut: parseShortcutLine,
    _parseNodes: function (body) { return parseNodes(splitLines(body)); },
    _tokens: tokens,
    _splitNumber: splitNumber,
    _wrap: function (text, fs, maxW, stackStr, weight, ls) { return wrap(text, fs, maxW, profile(stackStr || DEFAULT_STYLE.t.fb, weight || 400, ls || 0)); },
    _G: G
  };
  return api;
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = VIS; }
