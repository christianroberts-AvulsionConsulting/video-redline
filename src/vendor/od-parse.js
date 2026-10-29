/*!
 * od-parse.js  -  parser for Open Design "design system" packages.
 *
 * Reads the three files of an Open Design package (manifest.json, DESIGN.md,
 * tokens.css) - or any subset of them - and produces a small, safe "Style"
 * object that a video-overlay tool can use to preview and describe a visual.
 *
 * Works in Node (module.exports) and in a plain browser <script> (global
 * ODParse). No dependencies, no network, no eval, ES2019 only, no regex
 * look-behind (Safari 15 safe).
 *
 * Open Design: https://github.com/nexu-io/open-design  (Apache-2.0).
 * Data derived from it is described in NOTICE-open-design.txt.
 *
 * Public API
 *   ODParse.parseTokensCss(cssText)  -> { vars: { '--bg': '#fafafa', ... }, unresolved: [...] }
 *   ODParse.parseDesignMd(mdText)    -> { name, category, description, atmosphere, sections, hex, ... }
 *   ODParse.buildStyle({ id, manifest, designMd, tokensCss, source }) -> Style
 *       every input is optional (manifest may be an object or JSON text); source is
 *       'open-design' or 'custom' (default).  Pass diag:{} to get diag.notes, a list of
 *       the decisions taken (fallbacks used, values repaired).
 *   ODParse.normHex(str), ODParse.luminance(hex), ODParse.contrast(hexA, hexB)
 *       normHex returns '#rrggbb' or null; luminance/contrast return NaN for non-colours.
 *   (plus helpers: parseColor, colorOver, mixHex, cleanFontStack, slugify, clip, proseText,
 *    scrubThemeClaims, version)
 *
 * Untrusted input: every function accepts any value and any text up to 600000 characters without
 * throwing, hanging or exhausting memory.  Patterns are anchored or bounded, quoted strings end at the
 * end of their line, var() resolution is iterative and capped (4000 characters per value, 1000000 in
 * total per file, 12 levels of fallback), and lists such as palette lines are capped.
 *
 * Style = { id, name, category, description(<=140), atmosphere(<=220), theme:'light'|'dark',
 *           source, t:{ bg, surface, fg, muted, border, accent, accent2?, success?, warn?,
 *           danger?, fd, fb, fm?, r, sh, fw, ls } }   (colours are '#rrggbb', see the task notes)
 *
 * All text that ends up in a Style is plain text with no angle brackets, but it
 * is still user data: escape it before putting it into HTML.
 */
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    root.ODParse = factory();
  }
}(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  var VERSION = '1.1.0';
  var MAX_INPUT = 600000; // characters; protects the browser from a huge paste
  var MAX_LINE = 3000;    // characters kept of one DESIGN.md / front matter line
  var MAX_VALUE = 4000;   // longest resolved tokens.css value that is kept
  var MAX_REFS = 400;     // var() references read from one tokens.css value
  var MAX_EXPANSION = 1000000; // characters that var() substitution may produce for one tokens.css file
  var MAX_ENTRIES = 1500; // palette lines considered in one DESIGN.md
  var QUOTE_SPAN = 20000; // a quoted string longer than this is not looked for (its quotes are plain characters)

  // ------------------------------------------------------------------ utils
  // Only text and numbers are text: objects, arrays and functions are NOT turned into
  // "[object Object]" / "a,b" (a manifest field of the wrong type is simply ignored).
  function str(x) {
    var t = typeof x;
    if (t === 'string') return x;
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(x);
    return '';
  }
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }
  function round(n, d) { var f = Math.pow(10, d || 0); return Math.round(n * f) / f; }
  function uniq(arr) {
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) {
      var k = String(arr[i]);
      if (!has(seen, k)) { seen[k] = 1; out.push(arr[i]); }
    }
    return out;
  }
  function limitInput(s) { s = str(s); return s.length > MAX_INPUT ? s.slice(0, MAX_INPUT) : s; }

  // Strip trailing characters that belong to `set` (a string of characters) - a plain loop,
  // because "[set]+$" regular expressions are quadratic on long runs.
  var SPACE_SET = ' \t\n\r\f\v\u00a0\u2028\u2029\ufeff';
  function trimEndSet(s, set) {
    var e = s.length;
    while (e > 0 && set.indexOf(s.charAt(e - 1)) >= 0) e--;
    return e === s.length ? s : s.slice(0, e);
  }

  // Quote scanner for one string.  q(i) is called where s.charAt(i) is a quote mark and returns
  // the index of the closing quote, or -1 when the string is not closed before the end of its
  // line (browsers end a string at a newline) or within QUOTE_SPAN characters: the quote is then an
  // ordinary character.  A failed scan is remembered, so a line full of lone quotes costs linear time.
  function quoteScanner(s) {
    var bad = { '"': -1, "'": -1 };
    return function (i) {
      var q = s.charAt(i);
      if (i < bad[q]) return -1;
      var n = Math.min(s.length, i + 1 + QUOTE_SPAN);
      for (var j = i + 1; j < n; j++) {
        var c = s.charAt(j);
        if (c === '\\') { j++; continue; }
        if (c === q) return j;
        if (c === '\n') { bad[q] = j; return -1; }
      }
      bad[q] = n;
      return -1;
    };
  }

  // Index of the first `sep` (a single char) at nesting depth 0 outside quotes, or -1.
  function topIndex(s, sep) {
    var depth = 0, skip = quoteScanner(s);
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '"' || ch === "'") { var e = skip(i); if (e > i) i = e; continue; }
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') { if (depth > 0) depth--; }
      else if (ch === sep && depth === 0) return i;
    }
    return -1;
  }

  // Split `s` on `sep` (a single char) at nesting depth 0, ignoring quoted text.
  function splitTop(s, sep) {
    var out = [], depth = 0, start = 0, skip = quoteScanner(s);
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '"' || ch === "'") { var e = skip(i); if (e > i) i = e; continue; }
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') { if (depth > 0) depth--; }
      else if (ch === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
    }
    out.push(s.slice(start));
    return out;
  }

  // Index of the ")" that closes the "(" at `open`, or -1.
  function matchParen(s, open) {
    var depth = 0, skip = quoteScanner(s);
    for (var i = open; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '"' || ch === "'") { var e = skip(i); if (e > i) i = e; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  // Remove every "( ... )" group (and the space before it) whose inside makes drop(inside) true.
  // One linear pass; nested groups are handled inner-first, so an outer group that qualifies
  // takes its inner groups with it.
  function dropParens(s, drop) {
    var stack = [], dead = null, n = s.length, i;
    for (i = 0; i < n; i++) {
      var ch = s.charAt(i);
      if (ch === '(') { if (stack.length < 60) stack.push(i); }
      else if (ch === ')' && stack.length) {
        var o = stack.pop();
        if (drop(s.slice(o + 1, i))) {
          if (!dead) dead = [];
          var a = o;
          while (a > 0 && s.charAt(a - 1) === ' ') a--;
          dead.push([a, i + 1]);
        }
      }
    }
    if (!dead) return s;
    var mask = new Array(n + 1), out = '';
    for (i = 0; i < dead.length; i++) for (var k = dead[i][0]; k < dead[i][1]; k++) mask[k] = 1;
    for (i = 0; i < n; i++) if (!mask[i]) out += s.charAt(i);
    return out;
  }

  // ----------------------------------------------------------------- colour
  // All 148 CSS Color Level 4 keywords (the web-safe names plus the grey spellings and rebeccapurple).
  var NAMED = {
    aliceblue: '#f0f8ff', antiquewhite: '#faebd7', aqua: '#00ffff', aquamarine: '#7fffd4', azure: '#f0ffff',
    beige: '#f5f5dc', bisque: '#ffe4c4', black: '#000000', blanchedalmond: '#ffebcd', blue: '#0000ff',
    blueviolet: '#8a2be2', brown: '#a52a2a', burlywood: '#deb887', cadetblue: '#5f9ea0', chartreuse: '#7fff00',
    chocolate: '#d2691e', coral: '#ff7f50', cornflowerblue: '#6495ed', cornsilk: '#fff8dc', crimson: '#dc143c',
    cyan: '#00ffff', darkblue: '#00008b', darkcyan: '#008b8b', darkgoldenrod: '#b8860b', darkgray: '#a9a9a9',
    darkgreen: '#006400', darkgrey: '#a9a9a9', darkkhaki: '#bdb76b', darkmagenta: '#8b008b', darkolivegreen: '#556b2f',
    darkorange: '#ff8c00', darkorchid: '#9932cc', darkred: '#8b0000', darksalmon: '#e9967a', darkseagreen: '#8fbc8f',
    darkslateblue: '#483d8b', darkslategray: '#2f4f4f', darkslategrey: '#2f4f4f', darkturquoise: '#00ced1', darkviolet: '#9400d3',
    deeppink: '#ff1493', deepskyblue: '#00bfff', dimgray: '#696969', dimgrey: '#696969', dodgerblue: '#1e90ff',
    firebrick: '#b22222', floralwhite: '#fffaf0', forestgreen: '#228b22', fuchsia: '#ff00ff', gainsboro: '#dcdcdc',
    ghostwhite: '#f8f8ff', gold: '#ffd700', goldenrod: '#daa520', gray: '#808080', green: '#008000',
    greenyellow: '#adff2f', grey: '#808080', honeydew: '#f0fff0', hotpink: '#ff69b4', indianred: '#cd5c5c',
    indigo: '#4b0082', ivory: '#fffff0', khaki: '#f0e68c', lavender: '#e6e6fa', lavenderblush: '#fff0f5',
    lawngreen: '#7cfc00', lemonchiffon: '#fffacd', lightblue: '#add8e6', lightcoral: '#f08080', lightcyan: '#e0ffff',
    lightgoldenrodyellow: '#fafad2', lightgray: '#d3d3d3', lightgreen: '#90ee90', lightgrey: '#d3d3d3', lightpink: '#ffb6c1',
    lightsalmon: '#ffa07a', lightseagreen: '#20b2aa', lightskyblue: '#87cefa', lightslategray: '#778899', lightslategrey: '#778899',
    lightsteelblue: '#b0c4de', lightyellow: '#ffffe0', lime: '#00ff00', limegreen: '#32cd32', linen: '#faf0e6',
    magenta: '#ff00ff', maroon: '#800000', mediumaquamarine: '#66cdaa', mediumblue: '#0000cd', mediumorchid: '#ba55d3',
    mediumpurple: '#9370db', mediumseagreen: '#3cb371', mediumslateblue: '#7b68ee', mediumspringgreen: '#00fa9a', mediumturquoise: '#48d1cc',
    mediumvioletred: '#c71585', midnightblue: '#191970', mintcream: '#f5fffa', mistyrose: '#ffe4e1', moccasin: '#ffe4b5',
    navajowhite: '#ffdead', navy: '#000080', oldlace: '#fdf5e6', olive: '#808000', olivedrab: '#6b8e23',
    orange: '#ffa500', orangered: '#ff4500', orchid: '#da70d6', palegoldenrod: '#eee8aa', palegreen: '#98fb98',
    paleturquoise: '#afeeee', palevioletred: '#db7093', papayawhip: '#ffefd5', peachpuff: '#ffdab9', peru: '#cd853f',
    pink: '#ffc0cb', plum: '#dda0dd', powderblue: '#b0e0e6', purple: '#800080', rebeccapurple: '#663399',
    red: '#ff0000', rosybrown: '#bc8f8f', royalblue: '#4169e1', saddlebrown: '#8b4513', salmon: '#fa8072',
    sandybrown: '#f4a460', seagreen: '#2e8b57', seashell: '#fff5ee', sienna: '#a0522d', silver: '#c0c0c0',
    skyblue: '#87ceeb', slateblue: '#6a5acd', slategray: '#708090', slategrey: '#708090', snow: '#fffafa',
    springgreen: '#00ff7f', steelblue: '#4682b4', tan: '#d2b48c', teal: '#008080', thistle: '#d8bfd8',
    tomato: '#ff6347', turquoise: '#40e0d0', violet: '#ee82ee', wheat: '#f5deb3', white: '#ffffff',
    whitesmoke: '#f5f5f5', yellow: '#ffff00', yellowgreen: '#9acd32'
  };

  function parseHexColor(s) {
    if (typeof s !== 'string') return null;
    var h = s.charAt(0) === '#' ? s.slice(1) : s;
    if (!/^[0-9a-f]+$/i.test(h)) return null;
    if (h.length === 3 || h.length === 4) {
      h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2) +
        (h.length === 4 ? h.charAt(3) + h.charAt(3) : '');
    }
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    };
  }

  function num(tok, pctScale) {
    // "12", "12.5", "50%", "none" -> number (percent scaled by pctScale/100)
    if (tok === undefined) return NaN;
    if (tok === 'none') return 0;
    var m = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(%?)$/i.exec(tok);
    if (!m) return NaN;
    var v = parseFloat(m[1]);
    return m[2] ? v * pctScale / 100 : v;
  }
  function hueDeg(tok) {
    if (tok === undefined) return NaN;
    if (tok === 'none') return 0;
    var m = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(deg|grad|rad|turn)?$/i.exec(tok);
    if (!m) return NaN;
    var v = parseFloat(m[1]), u = (m[2] || 'deg').toLowerCase();
    if (u === 'grad') v = v * 0.9; else if (u === 'rad') v = v * 180 / Math.PI; else if (u === 'turn') v = v * 360;
    return ((v % 360) + 360) % 360;
  }
  function alphaOf(tok) {
    if (tok === undefined) return 1;
    var a = num(tok, 1);
    return isNaN(a) ? NaN : clamp(a, 0, 1);
  }
  function hslToRgb(h, s, l) {
    s = clamp(s, 0, 1); l = clamp(l, 0, 1);
    var c = (1 - Math.abs(2 * l - 1)) * s, hp = h / 60, x = c * (1 - Math.abs(hp % 2 - 1)), r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; } else if (hp < 2) { r = x; g = c; } else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; } else if (hp < 5) { r = x; b = c; } else { r = c; b = x; }
    var m = l - c / 2;
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
  }
  function srgbToLin(c) { c = c / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function linToSrgb(c) {
    c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return clamp(c, 0, 1) * 255;
  }
  function oklabToRgb(L, a, b) {
    var l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    var m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    var s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    var l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    return {
      r: linToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      g: linToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      b: linToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
    };
  }
  function rgbToOklab(r, g, b) {
    var lr = srgbToLin(r), lg = srgbToLin(g), lb = srgbToLin(b);
    var l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    var m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    var s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return {
      L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    };
  }

  function mixColors(c1, p1, c2, p2, space) {
    if (p1 === null && p2 === null) { p1 = 50; p2 = 50; }
    else if (p1 === null) p1 = 100 - p2;
    else if (p2 === null) p2 = 100 - p1;
    p1 = clamp(p1, 0, 100); p2 = clamp(p2, 0, 100);
    var sum = p1 + p2;
    if (sum <= 0) return null;
    var alphaMul = sum < 100 ? sum / 100 : 1;
    var w1 = p1 / sum, w2 = p2 / sum;
    var a = c1.a * w1 + c2.a * w2;
    if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    if (space === 'oklab') {
      var o1 = rgbToOklab(c1.r, c1.g, c1.b), o2 = rgbToOklab(c2.r, c2.g, c2.b);
      var L = (o1.L * c1.a * w1 + o2.L * c2.a * w2) / a;
      var A = (o1.a * c1.a * w1 + o2.a * c2.a * w2) / a;
      var B = (o1.b * c1.a * w1 + o2.b * c2.a * w2) / a;
      var rgb = oklabToRgb(L, A, B);
      return { r: rgb.r, g: rgb.g, b: rgb.b, a: a * alphaMul };
    }
    return {
      r: (c1.r * c1.a * w1 + c2.r * c2.a * w2) / a,
      g: (c1.g * c1.a * w1 + c2.g * c2.a * w2) / a,
      b: (c1.b * c1.a * w1 + c2.b * c2.a * w2) / a,
      a: a * alphaMul
    };
  }

  // parseColor(str) -> { r,g,b (0-255), a (0-1) } or null.  Handles hex, rgb(),
  // hsl(), oklab(), oklch(), color-mix(), a few keywords and bare "H S% L%".
  function parseColor(input, depth) {
    depth = depth || 0;
    if (depth > 6) return null;
    var s = str(input).trim();
    if (!s || s.length > 400) return null;
    s = s.toLowerCase().replace(/\s*!important$/, '');
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (has(NAMED, s)) return parseHexColor(NAMED[s]);
    if (s.charAt(0) === '#') return parseHexColor(s);
    var m = /^([a-z-]+)\(([\s\S]*)\)$/.exec(s);
    if (!m) {
      var t = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:deg)?[\s,]+((?:\d+(?:\.\d+)?|\.\d+))%[\s,]+((?:\d+(?:\.\d+)?|\.\d+))%$/.exec(s); // shadcn style triplet
      if (t) { var z = hslToRgb(parseFloat(t[1]), parseFloat(t[2]) / 100, parseFloat(t[3]) / 100); z.a = 1; return z; }
      return null;
    }
    var fn = m[1], body = m[2].trim();
    if (fn === 'color-mix') {
      var parts = splitTop(body, ',');
      if (parts.length !== 3) return null;
      var im = /^in\s+([a-z-]+)/.exec(parts[0].trim());
      if (!im) return null;
      var space = im[1];
      var sides = [];
      for (var i = 1; i < 3; i++) {
        var p = parts[i].trim(), pct = null, mm;
        if ((mm = /^((?:\d+(?:\.\d+)?|\.\d+))%\s+([\s\S]+)$/.exec(p))) { pct = parseFloat(mm[1]); p = mm[2]; }
        else if ((mm = /^([\s\S]+?)\s+((?:\d+(?:\.\d+)?|\.\d+))%$/.exec(p))) { pct = parseFloat(mm[2]); p = mm[1]; }
        var col = parseColor(p, depth + 1);
        if (!col) return null;
        sides.push({ c: col, p: pct });
      }
      return mixColors(sides[0].c, sides[0].p, sides[1].c, sides[1].p, space);
    }
    var tok = body.replace(/\//g, ' ').split(/[\s,]+/).filter(function (x) { return x !== ''; });
    var r, g, b, a, o;
    if (fn === 'rgb' || fn === 'rgba') {
      if (tok.length < 3) return null;
      r = num(tok[0], 255); g = num(tok[1], 255); b = num(tok[2], 255); a = alphaOf(tok[3]);
      if (isNaN(r) || isNaN(g) || isNaN(b) || isNaN(a)) return null;
      return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: a };
    }
    if (fn === 'hsl' || fn === 'hsla') {
      if (tok.length < 3) return null;
      var h = hueDeg(tok[0]), sat = num(tok[1], 1), lig = num(tok[2], 1); a = alphaOf(tok[3]);
      if (isNaN(h) || isNaN(sat) || isNaN(lig) || isNaN(a)) return null;
      o = hslToRgb(h, tok[1].indexOf('%') >= 0 ? sat : sat / 100, tok[2].indexOf('%') >= 0 ? lig : lig / 100);
      return { r: o.r, g: o.g, b: o.b, a: a };
    }
    if (fn === 'oklch' || fn === 'oklab') {
      if (tok.length < 3) return null;
      var L = num(tok[0], 1); a = alphaOf(tok[3]);
      if (isNaN(L) || isNaN(a)) return null;
      var A, B;
      if (fn === 'oklch') {
        var C = num(tok[1], 0.4), H = hueDeg(tok[2]);
        if (isNaN(C) || isNaN(H)) return null;
        A = C * Math.cos(H * Math.PI / 180); B = C * Math.sin(H * Math.PI / 180);
      } else {
        A = num(tok[1], 0.4); B = num(tok[2], 0.4);
        if (isNaN(A) || isNaN(B)) return null;
      }
      o = oklabToRgb(clamp(L, 0, 1), A, B);
      return { r: o.r, g: o.g, b: o.b, a: a };
    }
    return null;
  }

  function hex2(n) { n = clamp(Math.round(n), 0, 255); return (n < 16 ? '0' : '') + n.toString(16); }
  function toHex(c) { return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b); }
  function flatten(c, under) {
    var u = under || { r: 255, g: 255, b: 255 }, a = c.a;
    return { r: c.r * a + u.r * (1 - a), g: c.g * a + u.g * (1 - a), b: c.b * a + u.b * (1 - a), a: 1 };
  }
  function hexToRgb(hex) { var c = parseHexColor(hex); return c ? { r: c.r, g: c.g, b: c.b, a: 1 } : null; }

  // normHex(str) -> "#rrggbb" (lower case) for any fully opaque CSS colour, else null.
  function normHex(x) {
    var s = str(x).trim();
    if (!s) return null;
    if (/^[0-9a-fA-F]{6}$/.test(s) || /^[0-9a-fA-F]{8}$/.test(s)) s = '#' + s;
    var c = parseColor(s);
    if (!c || c.a < 0.999) return null;
    return toHex(c);
  }

  // The first visible colour stop of a CSS gradient ("linear-gradient(90deg, #f00 0%, #00f)"), or null.
  // A gradient is not a colour (normHex and parseColor do not accept it), but a token that holds one
  // still tells us which colour the author meant for that slot.
  function gradientStop(x) {
    var s = str(x).trim();
    if (s.length > 1500 || !/^(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(s)) return null;
    var open = s.indexOf('('), end = matchParen(s, open);
    if (end < 0) return null;
    var parts = splitTop(s.slice(open + 1, end), ',');
    for (var i = 0; i < parts.length; i++) {
      var toks = splitTop(parts[i].trim(), ' ');
      for (var j = 0; j < toks.length; j++) {
        if (toks[j] === '') continue;
        var c = parseColor(toks[j]);
        if (c && c.a > 0.004) return c;
      }
    }
    return null;
  }

  // colour text -> "#rrggbb", compositing any transparency over `underHex`.
  // Returns null when it is not a colour or is fully transparent.  A gradient counts as its first stop.
  function colorOver(x, underHex) {
    var c = parseColor(x) || gradientStop(x);
    if (!c || c.a <= 0.004) return null;
    return toHex(c.a >= 0.999 ? c : flatten(c, underHex ? hexToRgb(underHex) : null));
  }

  function luminance(hex) {
    var h = normHex(hex);
    if (!h) return NaN;
    var c = parseHexColor(h);
    return 0.2126 * srgbToLin(c.r) + 0.7152 * srgbToLin(c.g) + 0.0722 * srgbToLin(c.b);
  }
  function contrast(a, b) {
    var la = luminance(a), lb = luminance(b);
    if (isNaN(la) || isNaN(lb)) return NaN;
    var hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }
  function mixHex(a, b, t) { // t = share of b (0..1)
    var ca = parseHexColor(a), cb = parseHexColor(b);
    if (!ca || !cb) return typeof a === 'string' ? a : null; // not two colours: nothing to mix (never throws)
    return toHex({ r: ca.r + (cb.r - ca.r) * t, g: ca.g + (cb.g - ca.g) * t, b: ca.b + (cb.b - ca.b) * t });
  }
  function hsvOf(hex) {
    var c = parseHexColor(hex);
    if (!c) return { h: 0, s: 0, v: 0 };
    var r = c.r / 255, g = c.g / 255, b = c.b / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d > 0) {
      if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
    }
    return { h: h, s: mx === 0 ? 0 : d / mx, v: mx };
  }
  function rgbDist(a, b) {
    var ca = parseHexColor(a), cb = parseHexColor(b);
    if (!ca || !cb) return 0;
    return Math.sqrt(Math.pow(ca.r - cb.r, 2) + Math.pow(ca.g - cb.g, 2) + Math.pow(ca.b - cb.b, 2));
  }

  // -------------------------------------------------------------- tokens.css
  function stripComments(s) { // linear time, even for thousands of unterminated "/*"
    var out = '', i = 0, a, b;
    for (;;) {
      a = s.indexOf('/*', i);
      if (a < 0) { out += s.slice(i); break; }
      out += s.slice(i, a);
      b = s.indexOf('*/', a + 2);
      if (b < 0) break; // unterminated comment: the rest is comment
      i = b + 2;
    }
    return out;
  }

  // A tokens.css pasted from a web page or a chat often arrives in a <style> tag or a ``` fence.
  function stripWrappers(s) {
    if (s.indexOf('<') < 0 && s.indexOf('```') < 0 && s.indexOf('~~~') < 0) return s;
    return s.replace(/<\/?style\b[^<>]{0,200}>/gi, ' ').replace(/^[ \t]*(?:```|~~~)[^\n]*$/gm, '');
  }

  // Top-level rules: [{ sel, body }] (rules inside at-rules are not included, see collectRules).
  function scanRules(css) {
    var rules = [], depth = 0, selStart = 0, bodyStart = 0, sel = '', skip = quoteScanner(css);
    for (var i = 0; i < css.length; i++) {
      var ch = css.charAt(i);
      if (ch === '"' || ch === "'") { var e = skip(i); if (e > i) i = e; continue; }
      if (ch === '{') {
        if (depth === 0) { sel = css.slice(selStart, i); bodyStart = i + 1; }
        depth++;
      } else if (ch === '}') {
        if (depth > 0) {
          depth--;
          if (depth === 0) { rules.push({ sel: sel.replace(/\s+/g, ' ').trim(), body: css.slice(bodyStart, i) }); selStart = i + 1; }
        } else { selStart = i + 1; }
      } else if (ch === ';' && depth === 0) {
        selStart = i + 1; // "@import ...;" / "@charset ...;" / "@layer a, b;"
      }
    }
    return rules;
  }

  // At-rules whose body applies unconditionally in a browser, so :root inside them still counts:
  // @layer, @supports (unless negated) and @media all/screen.  Every other at-rule is skipped
  // (prefers-color-scheme, width queries, @font-face, @keyframes ...).
  function isTransparentAtRule(sel) {
    if (/^@layer\b/i.test(sel)) return true;
    if (/^@supports\b/i.test(sel)) return !/^@supports\s+not\b/i.test(sel);
    return /^@media\s+(?:only\s+)?(?:all|screen)$/i.test(sel);
  }
  function collectRules(css, depth) {
    var top = scanRules(css), out = [];
    for (var i = 0; i < top.length; i++) {
      var r = top[i];
      if (r.sel.charAt(0) !== '@') { out.push(r); continue; }
      if (depth < 4 && isTransparentAtRule(r.sel)) {
        var inner = collectRules(r.body, depth + 1);
        for (var k = 0; k < inner.length; k++) out.push(inner[k]);
      }
    }
    return out;
  }

  function isPlainRoot(sel) {
    if (!sel || sel.charAt(0) === '@') return false;
    var parts = splitTop(sel, ','), ok = parts.length > 0;
    for (var i = 0; i < parts.length && ok; i++) {
      var p = parts[i].trim();
      if (!(p === ':root' || p === 'html' || p === ':root:root' || p === 'html:root' || p === ':host')) ok = false;
    }
    return ok;
  }
  function isLightScoped(sel) {
    return !!sel && sel.charAt(0) !== '@' && /light/i.test(sel) && !/dark/i.test(sel) && /:root|html|\[data-|\.light|\.theme/i.test(sel);
  }

  function declsOf(body, into) {
    var chunks = splitTop(body, ';');
    for (var i = 0; i < chunks.length; i++) {
      var c = chunks[i];
      if (c.indexOf('{') >= 0 || c.indexOf('}') >= 0) continue;
      var idx = c.indexOf(':');
      if (idx < 1) continue;
      var name = c.slice(0, idx).trim();
      if (name.slice(0, 2) !== '--' || name.length < 3 || name === '--__proto__') continue;
      var val = c.slice(idx + 1).replace(/\s+/g, ' ').trim().replace(/ ?!important$/i, '');
      if (val === '') continue;
      into[name] = val;
    }
  }

  // ---- var() resolution
  // A value is parsed once into parts: literal text, or a reference { n: '--name', f: fallback text }.
  // Resolving then walks the parts with an explicit stack of names (no recursion over aliases, so a
  // chain of 100000 aliases cannot overflow the call stack), keeps every result in a table (so a
  // shared token is resolved once) and refuses to build anything longer than MAX_VALUE characters
  // or to produce more than MAX_EXPANSION characters in total (so --b: var(--a) var(--a) doubled 30
  // times cannot exhaust memory).  Only the nesting of fallbacks (at most 12) is recursive.
  function isIdentCode(c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45; }
  function varParts(value) {
    var parts = [], i = 0, refs = 0, re = /var\(/gi, m;
    while ((m = re.exec(value)) !== null) {
      var idx = m.index;
      if (idx > 0 && isIdentCode(value.charCodeAt(idx - 1))) continue; // "somevar(" is not var()
      var end = matchParen(value, idx + 3);
      if (end < 0 || ++refs > MAX_REFS) return null;
      var inner = value.slice(idx + 4, end), comma = topIndex(inner, ',');
      if (idx > i) parts.push(value.slice(i, idx));
      parts.push({ n: (comma < 0 ? inner : inner.slice(0, comma)).trim(), f: comma < 0 ? null : inner.slice(comma + 1), ft: undefined });
      i = end + 1;
      re.lastIndex = i;
    }
    if (i < value.length) parts.push(value.slice(i));
    return parts;
  }

  var NEED = { need: true }; // evalParts result: a referenced token has to be resolved first
  function evalParts(parts, depth, st) {
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (typeof p === 'string') out += p;
      else {
        var v = null;
        if (p.n.slice(0, 2) === '--') {
          if (has(st.memo, p.n)) v = st.memo[p.n];
          else if (has(st.raw, p.n) && !has(st.busy, p.n)) { st.need = p.n; return NEED; }
        }
        if (v === null && p.f !== null) {
          if (depth >= 12) return null;
          if (p.ft === undefined) p.ft = varParts(p.f.trim());
          if (p.ft === null) return null;
          v = evalParts(p.ft, depth + 1, st);
          if (v === NEED) return NEED;
        }
        if (v === null) return null;
        out += v;
      }
      if (out.length > MAX_VALUE) return null;
    }
    return out;
  }

  // Value of token `name` (a string), null when it cannot be resolved, or NEED.
  function evalName(name, st) {
    var raw = st.raw[name], t = has(st.tmpl, name) ? st.tmpl[name] : undefined;
    if (t === undefined) {
      t = /var\(/i.test(raw) ? varParts(raw) : false; // false: no references, the text is the value
      st.tmpl[name] = t;
    }
    if (t === false) return raw.length > MAX_VALUE ? null : raw;
    if (t === null || st.spent > MAX_EXPANSION) return null;
    var r = evalParts(t, 0, st);
    if (r !== NEED && r !== null) st.spent += r.length;
    return r;
  }

  function parseTokensCss(cssText) {
    var css = stripWrappers(stripComments(limitInput(cssText)));
    var rules = collectRules(css, 0), raw = {}, i, found = false;
    for (i = 0; i < rules.length; i++) {
      if (isPlainRoot(rules[i].sel)) { declsOf(rules[i].body, raw); found = true; }
    }
    if (!found) { // a file that only has a light theme block
      for (i = 0; i < rules.length; i++) {
        if (isLightScoped(rules[i].sel)) declsOf(rules[i].body, raw);
      }
    }
    var st = { raw: raw, memo: {}, busy: {}, tmpl: {}, need: null, spent: 0 };
    var vars = {}, unresolved = [], names = Object.keys(raw);
    for (i = 0; i < names.length; i++) {
      if (has(st.memo, names[i])) continue;
      var stack = [names[i]];
      st.busy[names[i]] = true;
      while (stack.length) {
        var cur = stack[stack.length - 1], r = evalName(cur, st);
        if (r === NEED) { st.busy[st.need] = true; stack.push(st.need); continue; }
        delete st.busy[cur];
        st.memo[cur] = r;
        stack.pop();
      }
    }
    for (i = 0; i < names.length; i++) {
      var v = st.memo[names[i]];
      if (v === null) unresolved.push(names[i]); else vars[names[i]] = v.trim();
    }
    return { vars: vars, unresolved: unresolved };
  }

  // ------------------------------------------------------------ text helpers
  function foldText(s) {
    return str(s)
      .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
      .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
      .replace(/[\u2013\u2014\u2015]/g, ' - ')
      .replace(/\u2026/g, '...')
      .replace(/[\u00a0\u2009\u200a\u202f]/g, ' ')
      .replace(/[\u00b7\u2022\u2027\u25cf\u2219]/g, '-')
      .replace(/\u00d7/g, 'x')
      .replace(/[\u2192\u21d2\u279c]/g, '-')
      .replace(/[\u2190-\u21ff\u2300-\u23ff\u2600-\u27bf\u2b00-\u2bff\uD800-\uDFFF\ufe0f\u200b-\u200d\ufeff]/g, '')
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ');
  }
  function cleanText(s) { // plain text for Style fields: no angle brackets, collapsed spaces
    return foldText(s).replace(/<[^<>]*>/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  }
  function stripMd(s) {
    // Every pattern is bounded by the next bracket / marker, so none of them rescans the rest of the text.
    return str(s)
      .replace(/!\[[^\][]*\]\((?:[^()]|\([^()]*\))*\)/g, '')
      .replace(/\[([^\][]+)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[\s(])[*_]([^*_\n]+?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
      .replace(/<[^<>]+>/g, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  var ABBREV = /^(?:e\.g|i\.e|vs|etc|approx|mr|mrs|ms|dr|st|no|inc|ltd|co)\.$/i;
  function sentencesOf(s) { // `s` has single spaces only (see clip / cleanText)
    var out = [], re = /[.!?]+["')\]]*(?=\s|$)/g, last = 0, m;
    while ((m = re.exec(s)) !== null) {
      var end = m.index + m[0].length;
      if (ABBREV.test(s.slice(s.lastIndexOf(' ', m.index - 1) + 1, end))) continue; // the word that ends here
      out.push(s.slice(last, end).trim());
      last = end;
    }
    if (last < s.length && s.slice(last).trim()) out.push(s.slice(last).trim());
    return out;
  }
  // Shorten at a sentence boundary when possible, else at a word boundary.
  function clip(s, max) {
    s = str(s).replace(/\s+/g, ' ').trim();
    max = max > 0 ? max : 140;
    if (s.length <= max) return s;
    if (s.length > 6000) s = s.slice(0, 6000);
    var sents = sentencesOf(s), acc = '';
    for (var i = 0; i < sents.length; i++) {
      var next = acc ? acc + ' ' + sents[i] : sents[i];
      if (next.length > max) break;
      acc = next;
    }
    if (acc.length >= Math.min(40, max * 0.35)) return acc;
    // no whole sentence fits: cut at the last clause break, else at a word break
    var cut = s.slice(0, max - 3), cl = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('; '), cut.lastIndexOf(': '), cut.lastIndexOf(' - '));
    if (cl > max * 0.5) cut = cut.slice(0, cl);
    else { var sp = cut.lastIndexOf(' '); if (sp > max * 0.5) cut = cut.slice(0, sp); }
    cut = trimEndSet(cut, ' ,;:(-');
    if (cut.split('(').length > cut.split(')').length && cut.lastIndexOf('(') > max * 0.4) cut = trimEndSet(cut.slice(0, cut.lastIndexOf('(')), ' ,;:(-');
    for (var g = 0; g < 4; g++) { // do not end on a dangling function word
      var tail = /\s(?:and|or|but|with|of|the|a|an|to|in|on|for|that|which|as|by|from|into|its|their|is|are)$/i.exec(cut);
      if (!tail || cut.length - tail[0].length < max * 0.4) break;
      cut = trimEndSet(cut.slice(0, cut.length - tail[0].length), ' ,;:(-');
    }
    return cut + '...';
  }

  function hasCode(s, test) { for (var i = 0; i < s.length; i++) if (test(s.charCodeAt(i))) return true; return false; }
  function isWideScript(c) { return (c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x9fff) || (c >= 0x0600 && c <= 0x06ff); }
  function isCjk(c) { return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff); }
  function isNonLatin(c) { return c > 0x24f; }

  // Prose for humans: drop "(#08090a)", "(rgba(...) / #fff)", "(CJK name)" asides and parentheses that
  // quote raw design tokens: "(--bg: oklch(98.75% 0 0))", "({colors.canvas} - #000)", "(var(--x))".
  var COLOUR_SRC = '#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab)\\([^()]*\\)';
  function colourOnly(inner) {
    var n = 0, rest = inner.replace(new RegExp(COLOUR_SRC, 'gi'), function () { n++; return ' '; });
    return n > 0 && /^[\s\/,;]*$/.test(rest.replace(/\b(?:and|or|to)\b/gi, ' '));
  }
  var TOKEN_JUNK = /(?:^|[^\w-])--[a-z][\w-]*|\{[^{}]*\}|\bvar\(/i;
  function proseText(s) {
    s = str(s).slice(0, 8000).replace(/\s+/g, ' ');
    s = dropParens(s, function (inner) { return colourOnly(inner) || TOKEN_JUNK.test(inner) || hasCode(inner, isWideScript); });
    s = trimEndSet(s, ' ');
    var e = s.length;
    while (e > 0 && '-*_'.indexOf(s.charAt(e - 1)) >= 0) e--; // a trailing markdown rule
    if (s.length - e >= 3) s = trimEndSet(s.slice(0, e), ' ');
    return s.replace(/ ([,.;:])/g, '$1');
  }

  // ---- claims about the page theme
  // The prose of a package is written from its DESIGN.md, the colours come from its tokens.css, and the two do
  // not always agree ("Sleek dark interface" next to a white page).  A clause that states the opposite of
  // the theme the Style really has is dropped, so the picker text and the colour swatches never contradict.
  var WORD_NOT_LINK = '(?!(?:and|or|with|on|in|for|of|to|the|a|an)\\b)[a-z][a-z-]*';
  function claimSrc(adj, nouns) {
    return '\\b(' + adj + ')\\b\\s+(?:' + WORD_NOT_LINK + '\\s+){0,2}(?:' + nouns + ')\\b';
  }
  var ADJ_DARK = 'dark[- ]?themed|dark|nocturnal|near[- ](?:pure[- ])?black|pure[- ]black|pitch[- ]black|jet[- ]black';
  var ADJ_LIGHT = 'white|near[- ]white|off[- ]white|light|bright|cream|ivory|pale';
  var NOUN_PAGE = 'canvas|backgrounds?|pages?';
  var NOUN_LOOK = 'ui|uis|interfaces?|themes?|surfaces?|aesthetic|look|experience|palette|command center|cockpit surfaces?';
  var CLAIM = {
    dark: { page: claimSrc(ADJ_DARK, NOUN_PAGE), look: claimSrc(ADJ_DARK, NOUN_LOOK), adj: new RegExp('\\b(?:(an?)\\s+)?(?:' + ADJ_DARK + ')\\b[ -]?', 'gi') },
    light: { page: claimSrc(ADJ_LIGHT, NOUN_PAGE), look: claimSrc(ADJ_LIGHT, NOUN_LOOK), adj: new RegExp('\\b(?:(an?)\\s+)?(?:' + ADJ_LIGHT + ')\\b[ -]?', 'gi') }
  };
  // Replacement for a removed adjective: a leading "a" / "an" is kept and agrees with the word that now follows ("A dark interface" -> "An interface").
  function dropAdjective(m, art, off, whole) {
    var c = whole.charAt(off + m.length);
    if (!art || !/[a-z]/i.test(c)) return art ? art + ' ' : ' ';
    var an = 'aeiou'.indexOf(c.toLowerCase()) >= 0;
    return (art.charAt(0) === 'A' ? (an ? 'An ' : 'A ') : (an ? 'an ' : 'a '));
  }
  // "light/dark surfaces", "light and dark themes": one half of a pair is not a claim for either theme.
  var PAIR_BEFORE = /(?:light|white|bright|dark|black)(?:\s*[\/&,]\s*|\s+(?:and|or)\s+)$/i;
  var PAIR_AFTER = /^(?:\s*[\/&,]\s*|\s+(?:and|or)\s+)(?:light|white|bright|dark|black)/i;
  function hasClaim(text, src) {
    var re = new RegExp(src, 'gi'), m;
    while ((m = re.exec(text)) !== null) {
      var end = m.index + m[0].length;
      if (!PAIR_BEFORE.test(text.slice(Math.max(0, m.index - 16), m.index)) && !PAIR_AFTER.test(text.slice(end, end + 16))) return true;
    }
    return false;
  }
  function claimKind(text, wrong) { // 'page' (about the whole page), 'look' (about the UI) or '' for the theme `wrong`
    var right = wrong === 'dark' ? 'light' : 'dark';
    // a text that speaks about both themes ("#313338 light theme, #1e1f22 dark theme") makes no one-sided claim
    if (hasClaim(text, CLAIM[right].page) || hasClaim(text, CLAIM[right].look)) return '';
    if (hasClaim(text, CLAIM[wrong].page)) return 'page';
    return hasClaim(text, CLAIM[wrong].look) ? 'look' : '';
  }
  function upFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  // mode 'sentence': a sentence with a wrong claim is dropped.  mode 'clause': only the clause is dropped
  // (or just the adjective when what is left still says something).
  function scrubThemeClaims(text, theme, mode) {
    text = str(text);
    var wrong = theme === 'dark' ? 'light' : 'dark';
    if (!text || !claimKind(text, wrong)) return text;
    var sents = sentencesOf(text), out = [];
    for (var i = 0; i < sents.length; i++) {
      var sent = sents[i];
      if (!claimKind(sent, wrong)) { out.push(sent); continue; }
      if (mode === 'sentence') continue;
      var bits = sent.split(/(,\s|;\s|\s--?\s|:\s)/), kept = [], k;
      for (k = 0; k < bits.length; k += 2) {
        var clause = bits[k], sep = bits[k + 1] || '', kind = claimKind(clause, wrong);
        if (kind === 'look') {
          var rest = clause.replace(CLAIM[wrong].adj, dropAdjective).replace(/\s+/g, ' ').trim();
          if (rest.split(' ').length >= 4) { kept.push({ t: rest, sep: sep }); }
        } else if (!kind) kept.push({ t: clause, sep: sep });
      }
      if (!kept.length) continue;
      var line = '';
      for (k = 0; k < kept.length; k++) line += kept[k].t + (k < kept.length - 1 ? kept[k].sep : '');
      line = line.replace(/^(?:and|or|but|with)\s+/i, '');
      if (!/[.!?]["')\]]*$/.test(line)) line = trimEndSet(line, ' ,;:-') + '.';
      out.push(upFirst(line));
    }
    return out.join(' ');
  }
  function plainKey(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  // Sentences of `atmo` that only repeat what `desc` already says are left out.
  function newSentences(atmo, desc) {
    var d = plainKey(desc), out = [], sents = sentencesOf(atmo);
    for (var i = 0; i < sents.length; i++) {
      var key = plainKey(sents[i]);
      if (key.length >= 6 && d.indexOf(key) >= 0) continue;
      out.push(sents[i]);
    }
    return out.join(' ');
  }

  function slugify(s) {
    return foldText(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  }
  // A short stable id for a name that has no letters or digits to make a slug from (a name in
  // Japanese or Arabic, say), so two different names do not both become "custom-style".
  function hashId(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return 'style-' + h.toString(36);
  }
  function titleCase(s) {
    return str(s).replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }).trim();
  }
  function cleanName(s) {
    s = stripMd(str(s).slice(0, 600));
    s = s.replace(/^design\s+system\s+(?:inspired\s+by|for|of)\s+/i, '')
      .replace(/^design\s+system\s*[:\-]\s*/i, '')
      .replace(/\s+design\s+system\s*$/i, '');
    // Asides in another script ("Stripe (translated name)") and a trailing CJK name are dropped, but only while
    // some Latin text is left: a name written entirely in Japanese, Chinese or Arabic is kept as it is.
    var t = dropParens(s, function (inner) { return hasCode(inner, isNonLatin); }).replace(/\s+/g, ' ').trim();
    var e = t.length;
    while (e > 0 && (isCjk(t.charCodeAt(e - 1)) || t.charAt(e - 1) === ' ')) e--;
    t = t.slice(0, e).trim();
    return cleanText(/[A-Za-z0-9]/.test(t) ? t : s).slice(0, 60);
  }

  // ----------------------------------------------------------------- palette
  // A colour written in a document: #rgb #rgba #rrggbb #rrggbbaa, or rgb() / rgba() / hsl() / hsla() / oklch() / oklab().
  var HEX_RE_SRC = '#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])';
  var FN_RE_SRC = '\\b(?:rgba?|hsla?|oklch|oklab)\\([^()]{3,80}\\)';
  var COLOR_RE_SRC = HEX_RE_SRC + '|' + FN_RE_SRC;
  var COLORISH = new RegExp(COLOR_RE_SRC, 'i');
  var COLOR_GI = new RegExp(COLOR_RE_SRC, 'gi');
  var DASHES = String.fromCharCode(0x2013, 0x2014); // en and em dash

  // Every fully opaque colour in `text`, as '#rrggbb' (translucent ones such as #0000007f are skipped).
  function hexesIn(text) {
    var re = COLOR_GI, m, out = [];
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      var h = normHex(m[0]);
      if (h) out.push(h);
    }
    return out;
  }
  function trimStartSet(s, set) {
    var b = 0;
    while (b < s.length && set.indexOf(s.charAt(b)) >= 0) b++;
    return b === 0 ? s : s.slice(b);
  }
  // "Label: ... colour" on a plain line (no list marker): the label is the first word group before the first colon.
  function colonColour(t) {
    var c = t.indexOf(':');
    return c > 0 && c <= 31 && /^[A-Za-z]/.test(t) && COLORISH.test(t.slice(c + 1));
  }

  // Role words.  label = the colour's name, lead = the first clause of its description,
  // any = anywhere in the description.  "neg" patterns veto a match.
  var NOT_PAGE = '(?:button|card|input|section|badge|callout|nav|navigation|footer|overlay|banner|tag|pill|panel|row|modal|code|dropdown|hover|surface|sidebar|header|text|link|chip|toast|tooltip|alert|warning|error)s?\\b[^,;.]{0,14}\\b(?:background|canvas)';
  var ROLE_RULES = {
    accent: {
      label: /\b(accent|brand|primary|cta|action|highlight|interactive|signature|hero)\b/,
      neg: /\b(text|foreground|fg|on|hover|active|pressed|muted|dark|light|subtle|soft|tint|background|bg|border|surface|disabled|focus)\b/,
      headNeg: /\b(text|typography|background|surface|border|neutral|status|semantic)\b/,
      lead: /\b(accent|brand colou?r|primary brand|brand primary|signature|cta|call to action|primary action|highlights?|interactive)\b/,
      leadNeg: /\b(background|border|text|hover|surface|shadow|dark|light)\b/,
      any: /\b(cta|call to action|primary buttons?|hero element)\b/
    },
    bg: {
      label: /\b(background|bg|canvas|backdrop|page)\b/,
      neg: /\b(surface|card|panel|elevated|button|hover|active|input|overlay|modal|inverse|inverted|code|tag|badge|text|on|accent|brand|alt|secondary|tertiary)\b/,
      headNeg: /\b(text|border|status|semantic)\b/,
      lead: /\b(background|canvas)\b/,
      leadNeg: new RegExp(NOT_PAGE + '|^(?:light|dark|alt|secondary|tertiary)\\s+(?:section|surface)|\\b(?:inverse|inverted)\\b'),
      any: /\b(page|site|app|main)\s+(?:background|canvas)\b/
    },
    surface: {
      label: /\b(surface|card|cards|panel|container|elevated|modal|popover|tile|sidebar)\b/,
      neg: /\b(text|on|border|hover|active|inverse|tint|accent|button)\b/,
      headNeg: /\b(text|border|status|semantic)\b/,
      lead: /\b(cards?|panels?|surfaces?|elevated|containers?|modals?|sidebars?|dropdowns?|tiles?)\b/,
      leadNeg: /\b(text|border|hover|link|shadow)\b/,
      any: /\b(cards?|panels?|modals?|elevated)\b/
    },
    fg: {
      label: /\b(foreground|fg|text|ink|body|copy|headline|heading|headings)\b/,
      neg: /\b(secondary|tertiary|quaternary|muted|subtle|disabled|placeholder|caption|meta|on|inverse|inverted|link|accent|brand|light|faint|dim|dimmed|alt)\b/,
      headNeg: /\b(background|surface|border|status|semantic)\b/,
      lead: /^(?:the |all )?(?:primary |main |body |default |base |dark |light )?(?:text|foreground|ink|copy|headlines?|headings?|body)\b/,
      leadNeg: /\b(secondary|muted|tertiary|link|button|placeholder|disabled|caption|subtle|on)\b/,
      any: /\b(primary|main|body|default)\s+text\b/
    },
    muted: {
      label: /\b(muted|secondary text|text secondary|tertiary|subtle text|caption|captions|placeholder|meta|subtext|supporting|quaternary|dim|dimmed|subtle|faint)\b/,
      neg: /\b(background|bg|surface|border|accent|on|inverse|button|hover)\b/,
      headNeg: /\b(background|surface|border|status|semantic)\b/,
      lead: /\b(?:muted|secondary|tertiary|subtle|caption|placeholder|metadata|supporting|de-?emphasi[sz]ed)\b[^,;.]{0,20}\btext\b|^muted\b|\bmuted text\b/,
      leadNeg: /\b(background|border|button)\b/,
      any: /\b(muted|tertiary|captions?|metadata|placeholders?|timestamps?|subtext)\b/
    },
    border: {
      label: /\b(border|borders|divider|dividers|hairline|outline|stroke|separator|rule|line|lines)\b/,
      neg: /\b(focus|ring|accent|text|button)\b/,
      headNeg: /\b(background|surface|text|status|semantic)\b/,
      lead: /\b(borders?|dividers?|hairlines?|separators?|outlines?|rules?)\b/,
      leadNeg: /\b(buttons?|links?|focus)\b/,
      any: /\b(borders?|dividers?|hairlines?|separators?)\b/
    },
    success: { label: /\b(success|positive|ok|valid|confirm|green)\b/, neg: /\b(on|text)\b/, lead: /\b(success|positive)\b/, any: /\bsuccess\b/ },
    warn: { label: /\b(warn|warning|caution|attention|amber|yellow)\b/, neg: /\b(on|text)\b/, lead: /\b(warning|caution)\b/, any: /\bwarning\b/ },
    danger: { label: /\b(danger|error|alert|critical|destructive|negative|failure|red)\b/, neg: /\b(on|text)\b/, lead: /\b(error|danger|destructive|critical)\b/, any: /\b(error|danger)\b/ }
  };
  var ROLE_ORDER = ['accent', 'bg', 'surface', 'fg', 'muted', 'border', 'success', 'warn', 'danger'];

  function leadOf(note) { // first clause of a description
    return str(note).split(/[,;.:]|\s-\s|\u2014|\u2013/)[0].trim();
  }

  var VARIANT_PENALTY = 8;
  function scoreRole(role, e) {
    var R = ROLE_RULES[role], s = 0, lead = e.lead !== undefined ? e.lead : leadOf(e.note);
    if (R.label.test(e.label)) s += 10;
    if (R.neg.test(e.label)) s -= 12;
    if (role === 'fg' && /^on[- ](?:background|surface)$/.test(e.label)) s += 24; // Material-style "on-background" is the text colour
    if (e.heading && R.label.test(e.heading)) s += 5;
    if (e.heading && R.headNeg && R.headNeg.test(e.heading)) s -= 6;
    var techLead = /\b[a-z]+(?:-[a-z0-9]+){2,}\b/.test(lead); // "facebook-background-color" is a token name, not prose
    if (R.lead && lead && !techLead && R.lead.test(lead) && !(R.leadNeg && R.leadNeg.test(lead))) s += 7;
    if (R.any && R.any.test(e.note)) s += 2;
    if (/default/.test(e.heading)) s += 5;
    if (e.variant) s -= VARIANT_PENALTY; // "light mode" / "dark theme" alternates rank below the main palette
    if (role === 'accent' && s > 0) s += hsvOf(e.hex).s * 2;
    return s;
  }

  // Lines of the colour section(s) -> [{ label, heading, note, hex, hexes, dark }]
  // Every pattern here is either anchored, bounded or limited to one line (of at most MAX_LINE characters),
  // and trailing-character trims are plain loops: a long run of spaces or dashes costs linear time.
  function paletteEntries(sections, fullText) {
    var texts = [], k;
    for (k in sections) {
      if (has(sections, k) && /colou?r|palette/i.test(k) && !/chart|data vis|gradient/i.test(k)) texts.push(sections[k]);
    }
    var body = texts.length ? texts.join('\n') : fullText;
    var lines = body.split('\n'), entries = [], heading = '', inFence = false, skipDark = false;
    var colourG = new RegExp(COLOR_RE_SRC, 'g'), splitLab = new RegExp('[:,' + DASHES + ']| - ');
    var pairRe = new RegExp('\\*\\*([^*]+?)\\*\\*[\\s:`(]{0,8}(#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])|(?:rgba?|hsla?|oklch|oklab)\\([^()]{3,80}\\))', 'gi');
    function push(label, note, hexes, extra) {
      if (!hexes.length || entries.length >= MAX_ENTRIES) return;
      var lab = trimEndSet(stripMd(label).toLowerCase(), ':-' + DASHES).trim();
      var nt = stripMd(note).toLowerCase().replace(/\(\s*[\/,&]*\s*\)/g, '');
      entries.push({
        label: lab,
        heading: heading.toLowerCase(), note: trimStartSet(nt, ' ()/:,-' + DASHES).trim(),
        hex: hexes[0], hexes: uniq(hexes), dark: !!(extra && extra.dark),
        variant: !!(extra && extra.dark) || /\b(dark|light)\b/.test(heading.toLowerCase() + ' ' + lab)
      });
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], t = line.trim(), m;
      if (entries.length >= MAX_ENTRIES) break;
      if (/^(```|~~~)/.test(t)) { inFence = !inFence; skipDark = false; continue; }
      if (!inFence && (m = /^#{3,6}\s+(.*)$/.exec(t))) { heading = stripMd(m[1]); continue; }
      if (inFence) {
        if (/\{\s*$/.test(t) && /dark/i.test(t)) skipDark = true;
        else if (/^\}/.test(t)) skipDark = false;
        if ((m = /^(--[\w-]+)\s*:\s*([^;]+);?/.exec(t))) {
          var hh = hexesIn(m[2]);
          if (hh.length) push(m[1].replace(/^--/, '').replace(/[-_]+/g, ' '), '', hh, { dark: skipDark });
        } else if ((m = /^([A-Za-z][\w /&-]{1,30}?)\s*[:=]\s*(.*)$/.exec(t))) {
          var h2 = hexesIn(m[2]);
          if (h2.length) push(m[1], '', h2, { dark: skipDark });
        }
        continue;
      }
      if (t.charAt(0) === '|') { // table row
        var cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|');
        if (cells.length >= 2 && !/^[\s:|-]+$/.test(t)) {
          var allHex = hexesIn(t);
          if (allHex.length) {
            var label = '', note = [];
            for (var c = 0; c < cells.length; c++) {
              var cell = cells[c], ch = hexesIn(cell);
              if (!label && !ch.length && /[A-Za-z]/.test(cell)) label = cell; else if (!ch.length) note.push(cell);
            }
            push(label || cells[0], note.join(' '), allHex);
          }
        }
        continue;
      }
      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line) || /\*\*[^*]+\*\*/.test(line) || colonColour(t)) {
        var lh = hexesIn(line);
        if (!lh.length) continue;
        // several "**Label:** `#hex`" pairs on one line
        var pm, pairs = [];
        pairRe.lastIndex = 0;
        while ((pm = pairRe.exec(line)) !== null) pairs.push(pm);
        if (pairs.length >= 2) {
          for (var p = 0; p < pairs.length; p++) {
            var ph = normHex(pairs[p][2]);
            if (ph) push(pairs[p][1], '', [ph]);
          }
          continue;
        }
        var bm = /\*\*([^*]+?)\*\*/.exec(line), lab, rest;
        if (bm) {
          lab = bm[1];
          rest = line.slice(bm.index + bm[0].length);
        } else {
          var hi = line.search(COLORISH);
          var before = trimEndSet(line.slice(0, hi).replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''), '`(: \t=-');
          rest = line.slice(hi);
          lab = before;
          if (!stripMd(lab)) { // "`#fff` - Background"
            var after = trimStartSet(rest.replace(colourG, ''), ' \t`):,-' + DASHES);
            lab = after.split(splitLab)[0];
            rest = after;
          }
        }
        push(lab, rest.replace(colourG, ''), lh);
      }
    }
    return entries;
  }

  function pickRoles(entries) {
    var pairs = [], i, r;
    for (i = 0; i < entries.length; i++) {
      for (r = 0; r < ROLE_ORDER.length; r++) {
        var sc = scoreRole(ROLE_ORDER[r], entries[i]);
        // a "dark theme"/"light mode" alternate still qualifies, it just ranks below the main palette
        if (sc + (entries[i].variant ? VARIANT_PENALTY : 0) >= 3) pairs.push({ e: i, role: ROLE_ORDER[r], score: sc - i * 0.001 });
      }
    }
    pairs.sort(function (a, b) { return b.score - a.score; });
    var usedE = {}, usedR = {}, roles = {};
    for (i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      if (usedE[p.e] || usedR[p.role]) continue;
      usedE[p.e] = true; usedR[p.role] = true;
      roles[p.role] = entries[p.e].hex;
    }
    return roles;
  }

  // Last resort when no role words match: guess from the colours alone.
  function rolesFromHex(hexes) {
    var out = {}, neutrals = [], i;
    var accentBest = null, bestScore = 0;
    for (i = 0; i < hexes.length; i++) {
      var hv = hsvOf(hexes[i]), lum = luminance(hexes[i]);
      if (hv.s < 0.18) neutrals.push(hexes[i]);
      var sc = hv.s * (hv.v > 0.25 ? 1 : 0.3) * (lum > 0.03 && lum < 0.85 ? 1 : 0.4);
      if (hv.s >= 0.3 && sc > bestScore) { bestScore = sc; accentBest = hexes[i]; }
    }
    if (accentBest) out.accent = accentBest;
    for (i = 0; i < neutrals.length; i++) {
      var l = luminance(neutrals[i]);
      if (l > 0.6 || l < 0.08) { out.bg = neutrals[i]; break; }
    }
    if (out.bg) {
      var bestC = 0;
      for (i = 0; i < neutrals.length; i++) {
        var cc = contrast(neutrals[i], out.bg);
        if (cc > bestC && cc >= 4.5) { bestC = cc; out.fg = neutrals[i]; }
      }
    }
    return out;
  }

  // ------------------------------------------------------------- typography
  var GENERIC = { 'serif': 1, 'sans-serif': 1, 'monospace': 1, 'cursive': 1, 'fantasy': 1, 'system-ui': 1, 'ui-serif': 1, 'ui-sans-serif': 1, 'ui-monospace': 1, 'ui-rounded': 1, 'emoji': 1, 'math': 1, 'fangsong': 1 };
  var SKIP_FONT = /emoji|symbol|dingbats|^-apple-system$|^blinkmacsystemfont$|^inherit$|^initial$|^unset$|^revert$|^var\(|^!|^\$|[{};<>\\]/i;
  var SAFE = {
    sans: ["system-ui", "-apple-system", "'Segoe UI'", "Arial", "sans-serif"],
    serif: ["Georgia", "'Times New Roman'", "serif"],
    mono: ["ui-monospace", "Menlo", "Consolas", "monospace"],
    cursive: ["'Segoe Script'", "'Bradley Hand'", "cursive"]
  };
  // Fonts that mark "the system part" of a stack; anything named after them is only a fallback.
  var SYSTEM_MARK = { '-apple-system': 1, 'blinkmacsystemfont': 1, 'segoe ui': 1, 'system-ui': 1 };

  // Not a real family: the template name "custom-font", and "Inter Fallback" style entries (a metrics-adjusted
  // local face that a site defines for itself; no visitor's machine has it).
  var PLACEHOLDER_FONT = /^(?:custom[- ]?font|your[- ]?font|brand[- ]?font|font[- ]?family|fallback|placeholder)$|[ -]fallback$/i;
  // A proportional face in front of the monospace generics would make the code font a text font.
  var PROPORTIONAL_FONT = /^(?:georgia|times(?: new roman)?|arial(?: black| narrow)?|helvetica(?: neue)?|verdana|tahoma|trebuchet ms|segoe ui|calibri|cambria|garamond|palatino|book antiqua|impact|comic sans ms|inter(?: variable)?|roboto|open sans|lato)$/i;
  function notMono(name) {
    return PROPORTIONAL_FONT.test(name) || (/\b(?:sans|serif|grotesk|grotesque|script)\b/i.test(name) && !/mono|code|courier|consol|typewriter/i.test(name));
  }

  function fontItems(stack) {
    var parts = splitTop(str(stack).replace(/\s+/g, ' '), ','), out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim().replace(/^["']|["']$/g, '').trim();
      if (p) out.push(p);
    }
    return out;
  }
  // Safe, quote-light font stack: named font(s) first, then system fallbacks,
  // always ending in a generic family.  `slot` is 'display' | 'body' | 'mono'.
  function cleanFontStack(stack, slot) {
    var items = fontItems(stack), named = [], kind = '', i, low, lead = true;
    for (i = 0; i < items.length; i++) {
      low = items[i].toLowerCase();
      if (has(GENERIC, low) || has(SYSTEM_MARK, low)) {
        lead = false; // only fonts listed before the first system font count as "the" font
        if (low === 'monospace' || low === 'ui-monospace') kind = kind || 'mono';
        else if (low === 'serif' || low === 'ui-serif') kind = kind || 'serif';
        else if (low === 'cursive') kind = kind || 'cursive';
        else if (low === 'sans-serif' || low === 'ui-sans-serif' || low === 'system-ui' || low === 'ui-rounded') kind = kind || 'sans';
        continue;
      }
      if (!lead || SKIP_FONT.test(items[i]) || !/^[A-Za-z0-9 ._+-]{1,40}$/.test(items[i])) continue;
      if (PLACEHOLDER_FONT.test(items[i]) || (slot === 'mono' && notMono(items[i]))) continue;
      named.push(items[i]);
    }
    if (slot === 'mono') kind = 'mono';
    if (!kind) {
      var joined = items.join(' ').toLowerCase();
      if (/mono|code|courier|consolas|menlo/.test(joined)) kind = 'mono';
      else if (/serif|georgia|times|garamond|palatino|charter|playfair|merriweather|lora|baskerville|didot|bodoni|cambria/.test(joined) && !/sans/.test(joined)) kind = 'serif';
      else kind = 'sans';
    }
    var seen = {}, out = [];
    function add(n) {
      var key = n.replace(/['"]/g, '').toLowerCase();
      if (has(seen, key)) return;
      seen[key] = 1;
      out.push(/[ ]/.test(n) && n.charAt(0) !== "'" ? "'" + n + "'" : n);
    }
    named.slice(0, 2).forEach(add);
    SAFE[kind].forEach(add);
    var s = out.join(', ');
    if (s.length > 150) s = out.slice(-5).join(', ');
    return s;
  }

  // "weight 600", "W500", table columns -> number; used on the Typography section.
  function weightHint(typoText) {
    var lines = str(typoText).split('\n'), i, m, header = null;
    for (i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (t.charAt(0) === '|') {
        var cells = t.replace(/^\||\|$/g, '').split('|').map(function (c) { return stripMd(c).toLowerCase(); });
        if (/weight/.test(cells.join('|')) && !/^\d/.test(cells[cells.length - 1])) { header = cells; continue; }
        if (header && /^(display|heading|headline|h1|title|hero)\b/.test(cells[0])) {
          var wi = -1;
          for (var h = 0; h < header.length; h++) if (/weight/.test(header[h])) wi = h;
          if (wi >= 0 && cells[wi] && (m = /\b([1-9]00)\b/.exec(cells[wi]))) return parseInt(m[1], 10);
        }
        continue;
      }
      var low = t.toLowerCase();
      if (/\b(display|headings?|headlines?|h1|titles?)\b/.test(low.split(/[:,(]/)[0]) || /\b(display|heading|headline)s?\b[^.]{0,60}\b(weight|w)[\s:=]{0,10}[1-9]00\b/.test(low)) {
        if ((m = /\b(?:weight|font-weight|w)[\s:=]{0,10}([1-9]00)\b/.exec(low))) return parseInt(m[1], 10);
        if ((m = /\b([1-9]00)\b/.exec(low)) && !/\b\d+\s*px\b/.test(m[0])) return parseInt(m[1], 10);
      }
    }
    return null;
  }

  function fontsFromMd(typoText) {
    var out = {}, lines = str(typoText).split('\n'), i, m;
    function role(label) {
      label = label.toLowerCase();
      if (/\bmono|code\b/.test(label)) return 'mono';
      if (/display|heading|headline|title|h1/.test(label)) return 'display';
      if (/body|text|primary|base|ui|sans/.test(label)) return 'body';
      return '';
    }
    function setIf(r, v) { if (r && v && !out[r]) out[r] = v; }
    for (i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if ((m = /\bFamilies\s*:?\*{0,2}\s*(.+)$/i.exec(t)) && /=/.test(m[1])) {
        var kv = /\b([a-z]+)\s*=\s*([^,=]+?)(?=,\s*[a-z]+\s*=|$)/gi, km;
        while ((km = kv.exec(m[1])) !== null) setIf(role(km[1]), km[2].trim());
        continue;
      }
      if ((m = /^(?:[-*+]\s*)?\**([A-Za-z][A-Za-z /&-]{1,30}?)\**\s*:\s*\**\s*(.+)$/.exec(t))) {
        var r = role(m[1]);
        if (!r) continue;
        var bt = /`([^`]+)`/.exec(m[2]);
        var cand = bt ? bt[1] : (/["'][^"']+["']/.test(m[2]) ? m[2] : '');
        if (cand) {
          var wpos = cand.search(/weight\s*\d/i); // "Inter, weight 600": the weight is not part of the family
          if (wpos >= 0) cand = trimEndSet(cand.slice(0, wpos), ', \t');
          setIf(r, cand);
        }
      }
    }
    return out;
  }

  // -------------------------------------------------------------- DESIGN.md
  // The value of a "key: value" line without its trailing " # comment".
  function yamlValue(v) {
    for (var i = v.indexOf('#'); i >= 0; i = v.indexOf('#', i + 1)) {
      if (i > 0 && /\s/.test(v.charAt(i - 1))) { v = v.slice(0, i); break; }
    }
    return v.trim();
  }
  // "# Title" / "## Section" (exactly `level` hashes, optional closing hashes) -> the title text, else null.
  function atxTitle(line, level) {
    var n = 0;
    while (n < line.length && line.charAt(n) === '#') n++;
    if (n !== level || n >= line.length || !/\s/.test(line.charAt(n))) return null;
    var s = trimEndSet(trimEndSet(trimEndSet(line.slice(n), SPACE_SET), '#'), SPACE_SET);
    s = trimStartSet(s, SPACE_SET);
    return s === '' ? null : s;
  }
  // A very small YAML reader: nested "key: value" maps only (enough for DESIGN.md front matter).
  function miniYaml(txt) {
    var root = {}, stack = [{ ind: -1, obj: root }], lines = str(txt).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].length > MAX_LINE ? lines[i].slice(0, MAX_LINE) : lines[i];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      var m = /^(\s*)([A-Za-z0-9_.\/-]+)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      var ind = m[1].length, key = m[2], val = yamlValue(m[3]);
      while (stack.length > 1 && stack[stack.length - 1].ind >= ind) stack.pop();
      if (key === '__proto__' || stack.length > 6) continue;
      var parent = stack[stack.length - 1].obj;
      if (val === '') { var child = {}; parent[key] = child; stack.push({ ind: ind, obj: child }); }
      else parent[key] = val.replace(/^["']|["']$/g, '');
    }
    return root;
  }
  function frontMatterPalette(y) {
    var out = [], c = isObj(y.colors) ? y.colors : null;
    if (!c) return out;
    Object.keys(c).forEach(function (k) {
      if (typeof c[k] !== 'string' || c[k].length > 200) return;
      var hx = hexesIn(c[k]);
      if (!hx.length) { var one = normHex(c[k]); if (one) hx = [one]; } // a value that is just a colour name: "navy"
      if (!hx.length) return;
      out.push({ label: k.replace(/[-_]+/g, ' ').toLowerCase(), heading: '', note: '', hex: hx[0], hexes: hx, dark: false, variant: false });
    });
    return out;
  }
  function frontMatterType(y) {
    var out = { fonts: {}, weight: null, radius: null };
    if (isObj(y.typography)) {
      Object.keys(y.typography).forEach(function (k) {
        var o = y.typography[k];
        if (!isObj(o)) return;
        var fam = o.fontFamily || o['font-family'];
        var role = /mono|code/i.test(k) ? 'mono' : /display|headline|title|hero|h1/i.test(k) ? 'display' : /body|text|paragraph|base/i.test(k) ? 'body' : '';
        if (role && typeof fam === 'string' && !out.fonts[role]) out.fonts[role] = fam;
        if (role === 'display' && out.weight === null && /^[1-9]00$/.test(str(o.fontWeight))) out.weight = parseInt(o.fontWeight, 10);
      });
    }
    if (isObj(y.rounded)) {
      var px = lenPx(y.rounded.lg || y.rounded.md || y.rounded.DEFAULT || y.rounded['default']);
      if (px !== null) out.radius = px;
    }
    return out;
  }

  // "- **Visual style:** ..." lines are read by factsOf; they are not the prose of the section.
  var FACT_BULLET = /^[ \t]*[-*+][ \t]+\*\*(?:visual style|style|mood|tone|color stance|colour stance|keywords?)\b/i;
  function leadProse(text) {
    var blocks = text.split(/\n\s*\n/), i, b, bullets = [];
    for (i = 0; i < blocks.length; i++) {
      b = blocks[i].trim();
      if (!b) continue;
      if (/^(```|~~~|#|\||>|-{3,}$)/.test(b)) continue;
      if (/^(?:[-*+]|\d+[.)])\s/.test(b)) { if (!bullets.length) bullets = b.split('\n').filter(function (l) { return !FACT_BULLET.test(l); }); continue; }
      var plain = stripMd(b.slice(0, 6000).split('\n').join(' '));
      if (plain.length >= 20) return plain;
    }
    if (bullets.length) return stripMd(bullets.slice(0, 4).map(stripMd).join('. '));
    return '';
  }
  // The template DESIGN.md of a "style family" lists the names of its colour tokens as the colour stance
  // ("primary, secondary, neutral, success, warning, danger"): that is a vocabulary list, not a stance.
  var ROLE_WORD = /^(?:primary|secondary|tertiary|neutrals?|success|warning|warn|danger|error|info|accents?|surfaces?|subtle|layers?|background|text|border|and|or|the|a|of)$/i;
  function onlyRoleWords(v) {
    var words = v.split(/[^A-Za-z]+/);
    for (var i = 0; i < words.length; i++) if (words[i] !== '' && !ROLE_WORD.test(words[i])) return false;
    return true;
  }
  // Horizontal whitespace only ([ \t]): "\s*" would let every blank line restart a scan to the end of a run of blank lines.
  function factsOf(text) {
    var out = [], re = /^[ \t]*[-*+][ \t]+\*\*(visual style|style|mood|tone|color stance|colour stance|keywords?)[ \t]*:?\*\*:?[ \t]*(.+)$/gim, m;
    while ((m = re.exec(text)) !== null) {
      var key = stripMd(m[1]).replace(/:$/, ''), val = stripMd(m[2]);
      if (/stance$/i.test(key) && onlyRoleWords(val)) continue;
      out.push(key + ': ' + val);
    }
    return out;
  }

  function parseDesignMd(mdText) {
    var md = limitInput(mdText).replace(/^\ufeff/, '').replace(/\r\n?/g, '\n'), fm = {}, fmY = {}, fmText = '';
    // YAML front matter: the first thing in the file, but blank lines, spaces after the fences and a file that ends
    // right after the closing fence are all allowed.
    var fmm = /^\s*---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(md);
    if (fmm) { // two horizontal rules around markdown ("# Title ...") are not front matter: its first line must read "key: ..."
      var fl = fmm[1].split('\n'), fi = 0;
      while (fi < fl.length && (!fl[fi].trim() || fl[fi].trim().charAt(0) === '#')) fi++;
      if (fi >= fl.length || !/^\s*[A-Za-z0-9_.\/-]+\s*:/.test(fl[fi].slice(0, 200))) fmm = null;
    }
    if (fmm) {
      fmY = miniYaml(fmm[1]); fmText = fmm[1];
      ['name', 'title', 'description', 'category'].forEach(function (k) { fm[k] = typeof fmY[k] === 'string' ? fmY[k] : ''; });
      md = md.slice(fmm[0].length);
    }
    var lines = md.split('\n'), inFence = false, fenceMark = '', h1 = '', cur = null, secs = [], quote = [], preamble = [], preLen = 0;
    for (var li = 0; li < lines.length; li++) if (lines[li].length > MAX_LINE) lines[li] = lines[li].slice(0, MAX_LINE); // keeps every per-line pattern cheap
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], t = line.trim(), m;
      if (/^(```|~~~)/.test(t)) {
        if (!inFence) { inFence = true; fenceMark = t.slice(0, 3); } else if (t.indexOf(fenceMark) === 0) { inFence = false; }
        if (cur) cur.lines.push(line);
        continue;
      }
      if (!inFence) {
        if (!h1 && (m = atxTitle(line, 1)) !== null) { h1 = m; continue; }
        if ((m = atxTitle(line, 2)) !== null) {
          cur = { title: stripMd(m).replace(/^\d+(?:\.\d+)*[.)]?\s+/, '').trim(), lines: [] };
          secs.push(cur);
          continue;
        }
        if (!cur) {
          if (/^\s*>/.test(line)) quote.push(line.replace(/^\s*>\s?/, ''));
          else if (t && preLen < 4000) { preamble.push(t); preLen += t.length; }
        }
      }
      if (cur) cur.lines.push(line);
    }
    var sections = {}, k;
    for (i = 0; i < secs.length; i++) {
      k = secs[i].title || ('Section ' + (i + 1));
      if (k === '__proto__') k = '_proto_';
      var body = secs[i].lines.join('\n').trim();
      sections[k] = has(sections, k) ? sections[k] + '\n\n' + body : body;
    }
    var category = '', descParts = [];
    for (i = 0; i < quote.length; i++) {
      var qm = /^\s*category\s*:\s*(.+)$/i.exec(quote[i].replace(/\*\*/g, ''));
      if (qm) category = stripMd(qm[1]);
      else if (/^\s*\**(surface|status|version|tags?|platform|updated|author|source|license|type)\**\s*:/i.test(quote[i])) continue; // metadata, not prose
      else if (quote[i].trim()) descParts.push(quote[i].trim());
    }
    var description = stripMd(descParts.join(' ').slice(0, 4000));
    if (!description && fm.description) description = stripMd(fm.description.slice(0, 4000));
    if (!description && preamble.length) description = stripMd(preamble.join(' ').slice(0, 4000));
    if (!category && fm.category) category = stripMd(fm.category);

    var titles = Object.keys(sections), atmoKey = '';
    for (i = 0; i < titles.length; i++) if (/atmosphere|visual theme|overview|mood|philosophy|visual principles|identity|vibe|personality/i.test(titles[i])) { atmoKey = titles[i]; break; }
    if (!atmoKey) { // no "atmosphere" section: take the first one that is not a palette/type/layout reference
      for (i = 0; i < titles.length; i++) if (!/colou?r|palette|typograph|font|spacing|layout|component|motion|responsive|accessib|token|do.?s and don|agent/i.test(titles[i])) { atmoKey = titles[i]; break; }
    }
    var atmosphere = atmoKey ? leadProse(sections[atmoKey]) : '';
    var facts = atmoKey ? factsOf(sections[atmoKey]) : [];

    var hex = uniq(hexesIn(fmText + '\n' + md)).slice(0, 120);
    var entries = frontMatterPalette(fmY).concat(paletteEntries(sections, md));
    var roles = pickRoles(entries);
    if (!roles.bg && !roles.accent && hex.length) roles = rolesFromHex(hex);

    var typoKey = '';
    for (i = 0; i < titles.length; i++) if (/typograph|font|type\b/i.test(titles[i])) { typoKey = titles[i]; break; }
    var typoText = typoKey ? sections[typoKey] : '';
    var fonts = typoText ? fontsFromMd(typoText) : {};
    var displayWeight = typoText ? weightHint(typoText) : null;
    var fmType = frontMatterType(fmY);
    ['display', 'body', 'mono'].forEach(function (k) { if (!fonts[k] && fmType.fonts[k]) fonts[k] = fmType.fonts[k]; });
    if (displayWeight === null) displayWeight = fmType.weight;

    var cardRadius = null, rm;
    var compKey = '';
    for (i = 0; i < titles.length; i++) if (/component/i.test(titles[i])) { compKey = titles[i]; break; }
    if (compKey && (rm = /\bcards?\b[^\n.]{0,80}?\b(\d{1,2})\s*px\s+(?:corner\s+)?radius|\bcards?\b[^\n]{0,80}?radius[\s:=]{0,8}(\d{1,2})\s*px/i.exec(sections[compKey]))) {
      cardRadius = parseInt(rm[1] || rm[2], 10);
    }
    if (cardRadius === null && fmType.radius !== null) cardRadius = Math.round(fmType.radius);

    return {
      name: cleanName(h1 || fm.name || fm.title || ''),
      category: cleanText(category),
      description: description,
      atmosphere: atmosphere,
      facts: facts,
      sections: sections,
      hex: hex,
      palette: entries,
      roles: roles,
      fonts: fonts,
      displayWeight: displayWeight,
      cardRadius: cardRadius
    };
  }

  // ------------------------------------------------------------ build style
  var T = {
    bg: ['--bg', '--background', '--color-bg', '--color-background', '--bg-color', '--background-color', '--page-bg', '--surface-0', '--canvas', '--color-canvas', '--paper', '--bg-base', '--bg-page'],
    surface: ['--surface', '--card', '--color-surface', '--bg-surface', '--card-bg', '--card-background', '--panel', '--surface-1', '--bg-card', '--color-card', '--bg-elevated', '--elevated'],
    fg: ['--fg', '--foreground', '--text', '--color-fg', '--color-text', '--text-color', '--color-foreground', '--ink', '--text-primary', '--fg-1', '--color-text-primary'],
    fg2: ['--fg-2', '--text-secondary', '--color-text-secondary'],
    muted: ['--muted', '--muted-foreground', '--text-muted', '--color-muted', '--text-secondary', '--color-text-secondary', '--fg-muted', '--meta', '--fg-3'],
    border: ['--border', '--color-border', '--border-color', '--divider', '--line', '--outline', '--stroke', '--border-soft'],
    accent: ['--accent', '--color-accent', '--primary', '--color-primary', '--brand', '--brand-color', '--color-brand', '--accent-color', '--link', '--accent-primary'],
    accent2: ['--accent-2', '--accent2', '--accent-secondary', '--secondary-accent', '--secondary', '--color-secondary', '--accent-light', '--brand-2', '--highlight', '--tertiary'],
    success: ['--success', '--color-success', '--positive', '--green', '--ok'],
    warn: ['--warn', '--warning', '--color-warning', '--caution', '--amber'],
    danger: ['--danger', '--error', '--destructive', '--color-danger', '--color-error', '--red', '--negative'],
    fd: ['--font-display', '--font-heading', '--font-headings', '--heading-font', '--font-title', '--font-serif', '--font-primary'],
    fb: ['--font-body', '--font-sans', '--font-base', '--font-family', '--font-text', '--body-font', '--font-ui', '--font'],
    fm: ['--font-mono', '--font-code', '--mono', '--font-monospace'],
    radius: ['--radius-md', '--radius', '--radius-card', '--card-radius', '--border-radius', '--rounded', '--radius-lg', '--radius-sm'],
    shadow: ['--elev-raised', '--shadow-md', '--shadow', '--shadow-card', '--box-shadow', '--elevation-2', '--shadow-lg', '--shadow-sm'],
    tracking: ['--tracking-display', '--letter-spacing-display', '--ls-display', '--heading-letter-spacing', '--tracking-heading', '--letter-spacing-heading'],
    weight: ['--font-weight-display', '--fw-display', '--font-weight-heading', '--font-weight-headings', '--heading-weight', '--weight-display', '--fw-heading']
  };

  var DEFAULTS = {
    light: { bg: '#fafafa', surface: '#ffffff', fg: '#111111', muted: '#6b6b6b', border: '#e5e5e5', accent: '#2f6feb' },
    dark: { bg: '#0f1011', surface: '#191a1b', fg: '#f4f4f5', muted: '#9a9aa2', border: '#2c2d31', accent: '#6e8bff' }
  };

  function lenPx(v) { // CSS length -> px number or null
    var m = /^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(px|rem|em|pt)?$/i.exec(str(v).trim());
    if (!m) return null;
    var n = parseFloat(m[1]), u = (m[2] || 'px').toLowerCase();
    if (u === 'rem' || u === 'em') n *= 16; else if (u === 'pt') n *= 4 / 3;
    return n;
  }

  // Resolve a box-shadow value to plain CSS: no var(), no color-mix(), no oklch().
  function cleanShadow(value, underHex) {
    var v = str(value).trim();
    if (!v) return null;
    if (/^none$/i.test(v)) return 'none';
    var layers = splitTop(v, ','), out = [];
    for (var i = 0; i < layers.length && out.length < 3; i++) {
      var toks = splitTop(layers[i].trim(), ' ').filter(function (x) { return x !== ''; }), parts = [], ok = true, hasColor = false, nums = 0;
      for (var j = 0; j < toks.length; j++) {
        var tk = toks[j];
        if (/^inset$/i.test(tk)) { parts.push('inset'); continue; }
        if (/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:px|em|rem)?$/i.test(tk)) {
          parts.push(parseFloat(tk) === 0 ? '0' : tk);
          nums++;
          continue;
        }
        var c = parseColor(tk);
        if (c) {
          hasColor = true;
          if (c.a < 0.005) { ok = false; break; } // invisible layer
          if (c.a >= 0.999) parts.push(toHex(c)); else parts.push('rgba(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ',' + round(c.a, 3) + ')');
          continue;
        }
        ok = false; break;
      }
      if (!ok || nums < 2 || nums > 4) continue; // a box-shadow layer has 2 to 4 lengths
      if (!hasColor) parts.push('rgba(0,0,0,0.2)');
      out.push(parts.join(' '));
    }
    if (!out.length) return null;
    var s = out.join(', ');
    return /^[a-z0-9#%.,() \-]+$/i.test(s) && s.length <= 220 ? s : null;
  }

  function firstVar(V, names) {
    for (var i = 0; i < names.length; i++) if (has(V, names[i]) && V[names[i]] !== '') return V[names[i]];
    return null;
  }
  function tokColor(V, names, underHex) {
    for (var i = 0; i < names.length; i++) {
      if (!has(V, names[i])) continue;
      var c = colorOver(V[names[i]], underHex);
      if (c) return c;
    }
    return null;
  }
  function toObj(x) {
    if (isObj(x)) return x;
    if (typeof x === 'string' && x.length <= MAX_INPUT && x.trim().charAt(0) === '{') { try { var o = JSON.parse(x); return isObj(o) ? o : {}; } catch (e) { return {}; } }
    return {};
  }
  function hasWords(s) { // two letters in a row; markdown debris such as "||| ##" is not text
    var run = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c >= 0xc0) { if (++run >= 2) return true; } else run = 0;
    }
    return false;
  }
  function isBoilerplate(s) { return /^bundled opendesign package for/i.test(s) || /derived from curated design\.md/i.test(s); }

  function buildStyle(input) {
    input = isObj(input) ? input : {};
    var manifest = toObj(input.manifest);
    var md = parseDesignMd(input.designMd);
    var css = parseTokensCss(input.tokensCss);
    var V = css.vars, hasTokens = Object.keys(V).length > 0;
    var R = md.roles || {};
    var source = input.source === 'open-design' ? 'open-design' : 'custom';
    var diag = isObj(input.diag) ? input.diag : null; // optional: collects notes about decisions taken
    if (diag) diag.notes = [];
    function note(s) { if (diag) diag.notes.push(s); }
    if (!hasTokens) note('no-tokens');
    if (!md.name && !Object.keys(md.sections).length) note('no-design-md');

    // ---- identity
    // manifest fields of the wrong type (an object where a name should be) are ignored, not turned into "[object Object]"
    var mName = typeof manifest.name === 'string' ? manifest.name : '';
    var mCategory = typeof manifest.category === 'string' ? manifest.category : '';
    var mDescription = typeof manifest.description === 'string' ? manifest.description : '';
    var rawId = (typeof input.id === 'string' || typeof input.id === 'number' ? str(input.id) : '') || (typeof manifest.id === 'string' ? manifest.id : '');
    var name = cleanName(mName.slice(0, 500)) || md.name || '';
    var id = slugify(rawId) || slugify(name) || ((rawId || name) ? hashId(rawId || name) : 'custom-style');
    if (!name) name = titleCase(id);
    var category = cleanText(mCategory) || md.category || (source === 'open-design' ? 'Other' : 'Custom');
    category = category.slice(0, 48);

    // ---- does DESIGN.md describe the same colours as tokens.css?
    var mdCoherent = true;
    if (hasTokens && md.hex.length) {
      // A tokens.css without any colour (only radius and fonts, say) cannot contradict the palette of DESIGN.md.
      var probe = [tokColor(V, T.accent), tokColor(V, T.bg), tokColor(V, T.surface), tokColor(V, T.fg)].filter(Boolean);
      if (probe.length) {
        mdCoherent = false;
        for (var pi = 0; pi < probe.length; pi++) if (md.hex.indexOf(probe[pi]) >= 0) mdCoherent = true;
        if (!mdCoherent) note('design-md-palette-differs-from-tokens');
      }
    }

    // ---- colours: tokens.css first, then colours named in DESIGN.md, then derived
    var bg = tokColor(V, T.bg, null) || R.bg || null;
    var surfaceT = null;
    var base = bg || '#ffffff';
    surfaceT = tokColor(V, T.surface, base);
    var surface = surfaceT || (hasTokens && !mdCoherent ? null : R.surface) || null;
    var fgT = tokColor(V, T.fg, base), fg2T = tokColor(V, T.fg2, base);

    if (!bg && surface) { bg = surface; surface = null; }
    if (!bg) {
      var ref = fgT || R.fg;
      bg = ref && luminance(ref) > 0.5 ? DEFAULTS.dark.bg : DEFAULTS.light.bg;
      note('bg-default');
    }
    var theme = luminance(bg) < 0.18 ? 'dark' : 'light';
    var D = DEFAULTS[theme];

    if (!surface) {
      if (theme === 'light') {
        surface = luminance(bg) >= 0.93 ? (bg === '#ffffff' ? '#f4f4f5' : '#ffffff') : mixHex(bg, '#ffffff', 0.55);
      } else {
        surface = mixHex(bg, '#ffffff', 0.06);
      }
    }

    // text colour: readable on the page background wins
    var fgCands = uniq([fgT, (hasTokens && !mdCoherent ? null : R.fg), fg2T].filter(Boolean));
    var fg = null, i;
    for (i = 0; i < fgCands.length && !fg; i++) if (contrast(fgCands[i], bg) >= 4.5) fg = fgCands[i];
    if (!fg && fgCands.length) {
      fg = fgCands[0];
      for (i = 1; i < fgCands.length; i++) if (contrast(fgCands[i], bg) > contrast(fg, bg)) fg = fgCands[i];
    }
    if (!fg) { fg = D.fg; note('fg-default'); }
    if (contrast(fg, bg) < 4.5) { // nothing readable was offered: plain ink, else pure black or white (one of them always reaches 4.5)
      var plains = theme === 'dark' ? ['#f4f4f5', '#ffffff', '#000000'] : ['#111111', '#000000', '#ffffff'], ink = fg;
      for (i = 0; i < plains.length; i++) {
        if (contrast(plains[i], bg) >= 4.5) { ink = plains[i]; break; }
        if (contrast(plains[i], bg) > contrast(ink, bg)) ink = plains[i];
      }
      if (ink !== fg) { fg = ink; note('fg-replaced-by-plain-ink'); }
    }
    if (fgT && fg !== fgT) note('fg-differs-from-token');

    // a card colour the text cannot be read on (e.g. a white "content panel" next to white text)
    if (contrast(fg, surface) < 3) {
      surface = theme === 'dark' ? mixHex(bg, fg, 0.07) : mixHex(bg, fg, 0.03);
      note('surface-derived-text-unreadable-on-token-surface');
    }

    var muted = tokColor(V, T.muted, bg) || (hasTokens && !mdCoherent ? null : R.muted) || mixHex(fg, bg, 0.42);
    if (contrast(muted, bg) < 2) { muted = mixHex(fg, bg, 0.42); note('muted-derived-token-invisible-on-page'); }
    var border = tokColor(V, T.border, bg) || (hasTokens && !mdCoherent ? null : R.border) || mixHex(bg, fg, 0.14);
    var accent = tokColor(V, T.accent, bg) || R.accent || null;
    if (!accent) {
      var hv = md.hex, best = null, bestS = 0;
      for (i = 0; i < hv.length; i++) { var h = hsvOf(hv[i]); if (h.s > bestS && h.s >= 0.35 && h.v > 0.3) { bestS = h.s; best = hv[i]; } }
      accent = best || D.accent;
    }
    // a "hero" accent that disappears into the page (grey pill on a dark page): use the next
    // most prominent colour the package defines instead
    if (hsvOf(accent).s < 0.15 && contrast(accent, bg) < 2 && contrast(accent, surface) < 2) {
      var alts = ['--accent-light', '--accent-hover', '--meta', '--fg-2', '--muted'];
      for (i = 0; i < alts.length; i++) {
        var alt = tokColor(V, [alts[i]], bg);
        if (alt && contrast(alt, bg) >= 3) { accent = alt; break; }
      }
      if (contrast(accent, bg) < 2) accent = fg;
      note('accent-substituted-token-accent-invisible-on-page');
    }
    // a colour slot whose value no colour reader understands ("currentColor", a var() that never resolved) is reported
    ['bg', 'surface', 'fg', 'muted', 'border', 'accent'].forEach(function (slot) {
      var declared = false, k;
      for (k = 0; k < T[slot].length; k++) if (has(V, T[slot][k])) declared = true;
      if (declared && !tokColor(V, T[slot], slot === 'bg' ? null : bg)) note('token-colour-unparsed-' + slot);
    });
    var accent2 = tokColor(V, T.accent2, bg) || (mdCoherent ? R.accent2 || null : null);
    if (accent2 && rgbDist(accent2, accent) < 40) accent2 = null;
    var success = tokColor(V, T.success, bg) || (mdCoherent ? R.success || null : null);
    var warn = tokColor(V, T.warn, bg) || (mdCoherent ? R.warn || null : null);
    var danger = tokColor(V, T.danger, bg) || (mdCoherent ? R.danger || null : null);

    // ---- fonts
    var mf = md.fonts || {};
    var fd = cleanFontStack(firstVar(V, T.fd) || mf.display || firstVar(V, T.fb) || mf.body || '', 'display');
    var fb = cleanFontStack(firstVar(V, T.fb) || mf.body || firstVar(V, T.fd) || mf.display || '', 'body');
    var fmRaw = firstVar(V, T.fm) || mf.mono || '';
    var fm = fmRaw ? cleanFontStack(fmRaw, 'mono') : '';

    // ---- radius / shadow / weight / tracking
    var radius = null, rv = firstVar(V, T.radius);
    if (rv !== null) radius = lenPx(rv);
    if (radius === null && md.cardRadius !== null) radius = md.cardRadius;
    if (radius === null) radius = 12;
    radius = clamp(Math.round(radius), 0, 48);

    var shadow = null, sv = firstVar(V, T.shadow);
    if (sv !== null) shadow = cleanShadow(sv, bg);
    if (shadow === null) shadow = 'none';

    var fw = null, wv = firstVar(V, T.weight);
    if (wv !== null && /^\d{3}$/.test(wv.trim())) fw = parseInt(wv, 10);
    else if (wv !== null && /^(?:bold|bolder)$/i.test(wv.trim())) fw = 700;
    else if (wv !== null && /^normal$/i.test(wv.trim())) fw = 400;
    if (fw === null && md.displayWeight) fw = md.displayWeight;
    if (fw === null) fw = /serif$/.test(fd) && !/sans-serif$/.test(fd) ? 500 : 600;
    fw = clamp(Math.round(fw / 100) * 100, 400, 900);

    var ls = 0, tv = firstVar(V, T.tracking);
    if (tv !== null) {
      var tm = /^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(em|px|rem)?$/i.exec(tv.trim());
      if (tm) {
        var tn = parseFloat(tm[1]), tu = (tm[2] || 'em').toLowerCase();
        if (tu === 'em') ls = tn;
        else {
          var refPx = lenPx(V['--text-4xl'] || '') || lenPx(V['--text-3xl'] || '') || 48;
          ls = (tu === 'rem' ? tn * 16 : tn) / refPx;
        }
      }
    }
    ls = round(clamp(ls, -0.1, 0.3), 3);
    if (ls === 0) ls = 0; // no -0

    // ---- prose
    var desc = cleanText(proseText(md.description));
    if (!desc || isBoilerplate(desc)) desc = cleanText(proseText(mDescription.slice(0, 4000)));
    if (isBoilerplate(desc) || !hasWords(desc)) desc = '';
    var atmo = cleanText(proseText(md.atmosphere));
    if (!hasWords(atmo)) atmo = '';
    // The prose is written about the package, the colours come from tokens.css: a clause that claims the opposite
    // theme ("Sleek dark interface" on a white page) is dropped.
    var descClaim = scrubThemeClaims(desc, theme, 'clause'), atmoClaim = scrubThemeClaims(atmo, theme, 'sentence');
    if (descClaim !== desc) { desc = descClaim; note('description-theme-claim-removed'); }
    if (atmoClaim !== atmo) { atmo = atmoClaim; note('atmosphere-theme-claim-removed'); }
    // The atmosphere is what the description does not already say; the "Visual style" facts of the package follow it.
    if (desc && atmo) atmo = newSentences(atmo, clip(desc, 140));
    var factLine = md.facts && md.facts.length ? scrubThemeClaims(cleanText(md.facts.slice(0, 2).join('. ') + '.'), theme, 'clause') : '';
    if (factLine) {
      var withFacts = atmo ? cleanText(trimEndSet(atmo, '.!? ') + '. ' + factLine) : factLine;
      if (withFacts.length <= 220 || !atmo) atmo = withFacts;
    }
    if (!desc) desc = atmo ? clip(atmo, 140) : '';
    if (atmo && plainKey(atmo) === plainKey(desc)) atmo = ''; // never the same words twice

    var t = { bg: bg, surface: surface, fg: fg, muted: muted, border: border, accent: accent };
    if (accent2) t.accent2 = accent2;
    if (success) t.success = success;
    if (warn) t.warn = warn;
    if (danger) t.danger = danger;
    t.fd = fd; t.fb = fb;
    if (fm) t.fm = fm;
    t.r = radius; t.sh = shadow; t.fw = fw; t.ls = ls;

    return {
      id: id,
      name: name,
      category: category,
      // shortening can cut away the half of a text that made a claim harmless ("dark ui ... white background"): check again
      description: scrubThemeClaims(clip(desc, 140), theme, 'clause'),
      atmosphere: scrubThemeClaims(clip(atmo, 220), theme, 'sentence'),
      theme: theme,
      source: source,
      t: t
    };
  }

  return {
    version: VERSION,
    parseTokensCss: parseTokensCss,
    parseDesignMd: parseDesignMd,
    buildStyle: buildStyle,
    normHex: normHex,
    luminance: luminance,
    contrast: contrast,
    parseColor: parseColor,
    colorOver: colorOver,
    mixHex: mixHex,
    cleanFontStack: cleanFontStack,
    slugify: slugify,
    clip: clip,
    proseText: proseText,
    scrubThemeClaims: scrubThemeClaims
  };
}));
