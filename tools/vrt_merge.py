"""Merge the Parakeet and Whisper word lists into the one canonical word list.

Rules (see README for the plain-language version):

* Parakeet is the backbone: its words and its timing are kept.
* A word both engines heard gets src "both" (Parakeet timing, combined confidence).
* A filler (um, uh, erm, hmm ...) that only Whisper heard is added with src "whisper", but only if there is
  real sound in the gap where it should be. Its edges are then set from the sound itself, because Whisper's own
  timing for such short sounds is unreliable.
* A word Whisper heard twice in a row ("to, to") or as a stutter fragment ("s-") that Parakeet smoothed away is
  added the same way.
* Whisper's ordinary words are never added: if Parakeet did not hear a normal word, it is not put in the text.
"""
from __future__ import annotations

import bisect
import difflib
import re
import unicodedata

FILLERS = {
    "um", "umm", "ummm", "uhm", "uhmm", "uh", "uhh", "uhhh", "er", "err", "erm", "ehm", "eh", "ah", "ahh",
    "hm", "hmm", "hmmm", "mm", "mmm", "mhm", "mmhm", "mmhmm", "hmmmm",
}
# trailing punctuation also covers the full-width marks used in Chinese and Japanese text
_PUNCT_END = ".,;:!?\u2026\u201d\u2019\"')]}\u3002\u3001\uff0c\uff1f\uff01\uff1a\uff1b"
_PUNCT_START = "\u201c\u2018\"'([{\u00bf\u00a1"
_APOSTROPHES = "\u2019\u2018\u02bc`"        # typographic apostrophes are treated as a plain '


def norm(text):
    """Comparison form of a word: lower case, letters and digits of ANY script (Latin, Cyrillic, Greek, CJK, ...),
    apostrophes and hyphens kept, everything else (punctuation, symbols, spaces) removed.

    A word in a non-Latin script must not normalise to "" because merge() throws such words away.
    """
    t = text.lower()
    for a in _APOSTROPHES:
        t = t.replace(a, "'")
    # keep letters, digits and combining marks (they belong to the letters before them: accents, Hindi, Thai ...)
    t = "".join(ch for ch in t if ch.isalnum() or ch in "'-" or unicodedata.category(ch)[0] == "M")
    return t.strip("-'")


def split_punct(text):
    """('hello,' -> ('hello', ',')). Leading quotes/brackets are dropped, trailing punctuation is kept apart."""
    t = text.strip()
    t = t.lstrip(_PUNCT_START)
    end = len(t)
    while end > 0 and t[end - 1] in _PUNCT_END:
        end -= 1
    return t[:end], t[end:]


def is_filler(n):
    return n in FILLERS


def is_fragment(text):
    """A cut-off stutter fragment such as 's-' or 'pi-' (a few letters followed by a dash).

    Hyphenated compounds such as 'well-known' or 'pop-up' are NOT fragments.
    """
    t = text.strip().strip(".,;:!?\"'\u201c\u201d\u2018\u2019)")
    return bool(re.match(r"^[^\W\d_]{1,6}-+$", t))        # letters of any script, not only A-Z


def noisy_or(a, b):
    if a is None:
        return b
    if b is None:
        return a
    return 1.0 - (1.0 - a) * (1.0 - b)


class Merged:
    def __init__(self):
        self.words = []
        self.stats = {
            "parakeet_words": 0, "whisper_words": 0, "both": 0, "parakeet_only": 0,
            "whisper_only_added": 0, "whisper_only_dropped_no_sound": 0, "fillers_replaced_misheard": 0,
            "fillers_total": 0, "fillers_both": 0, "fillers_parakeet_only": 0, "fillers_whisper_only": 0,
            "repeats_added": 0, "fragments_added": 0, "filler_edges_tightened": 0, "word_edges_snapped": 0,
        }
        self.dropped = []      # whisper fillers thrown away, with the reason (for the log)


def merge(P, W, env, whisper_windows, log=None):
    """P, W: lists of dict(text, s, e, c). Returns Merged."""
    out = Merged()
    out.stats["parakeet_words"] = len(P)
    out.stats["whisper_words"] = len(W)

    # --- clean Parakeet words
    pw = []
    for w in P:
        core, punct = split_punct(w["text"])
        n = norm(core)
        if not core or not n:
            continue
        pw.append({"w": core, "raw": w["text"].strip(), "n": n, "s": float(w["s"]), "e": float(w["e"]),
                   "c": w.get("c"), "src": "parakeet", "wc": None})
    pw.sort(key=lambda x: (x["s"], x["e"]))
    for i in range(len(pw) - 1):                     # a word cannot run into the next one
        if pw[i]["e"] > pw[i + 1]["s"]:
            pw[i]["e"] = max(pw[i]["s"] + 0.04, pw[i + 1]["s"])

    # --- clean Whisper words
    ww = []
    for w in W:
        core, punct = split_punct(w["text"])
        n = norm(core)
        if not core or not n:
            continue
        ww.append({"w": core, "raw": w["text"].strip(), "n": n, "s": float(w["s"]), "e": float(w["e"]),
                   "c": w.get("c"), "used": False, "frag": is_fragment(core)})
    ww.sort(key=lambda x: (x["s"], x["e"]))

    # --- 1. snap Parakeet word edges to the real start/end of the sound next to silence
    snap_word_edges(pw, env, out.stats)

    for w in pw:
        w["hs"], w["he"] = w["s"], w["e"]

    # --- 2. ordinary words: align the two lists by text, window by window
    windows = whisper_windows or [(0.0, env.duration)]
    p_idx_by_win = {}
    starts = [a for a, _ in windows]
    for i, w in enumerate(pw):
        if is_filler(w["n"]):
            continue
        k = max(0, bisect.bisect_right(starts, (w["s"] + w["e"]) / 2.0) - 1)
        p_idx_by_win.setdefault(k, []).append(i)
    w_idx_by_win = {}
    for j, w in enumerate(ww):
        if is_filler(w["n"]) or w["frag"]:
            continue
        k = max(0, bisect.bisect_right(starts, (w["s"] + w["e"]) / 2.0) - 1)
        w_idx_by_win.setdefault(k, []).append(j)

    unmatched_w_dups = []      # (j) whisper words with no partner that might be a repeat
    match_of_w = {}            # whisper word index -> parakeet word index it was matched with
    for k in sorted(set(p_idx_by_win) | set(w_idx_by_win)):
        pi = p_idx_by_win.get(k, [])
        wj = w_idx_by_win.get(k, [])
        sm = difflib.SequenceMatcher(None, [pw[i]["n"] for i in pi], [ww[j]["n"] for j in wj], autojunk=False)
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag == "equal":
                for a, b in zip(range(i1, i2), range(j1, j2)):
                    p, w = pw[pi[a]], ww[wj[b]]
                    p["src"] = "both"
                    p["wc"] = w["c"]
                    w["used"] = True
                    match_of_w[wj[b]] = pi[a]
            elif tag == "replace":
                # same time and different text: the engines disagree about this word
                for a in range(i1, i2):
                    p = pw[pi[a]]
                    for b in range(j1, j2):
                        w = ww[wj[b]]
                        if min(p["e"], w["e"]) - max(p["s"], w["s"]) > 0.02 and not w["used"]:
                            w["used"] = True
                            p["disagree"] = True
                            break
        # whisper words with no partner: remember the ones next to an identical word (possible repeat)
        for b, j in enumerate(wj):
            if ww[j]["used"]:
                continue
            twins = []
            if b > 0 and ww[wj[b - 1]]["n"] == ww[j]["n"]:
                twins.append(wj[b - 1])
            if b + 1 < len(wj) and ww[wj[b + 1]]["n"] == ww[j]["n"]:
                twins.append(wj[b + 1])
            if not twins:
                continue
            # Two identical Whisper words, one Parakeet word: the text alignment cannot tell which Whisper word belongs
            # to it. The one that sits closer in time does; the other is the extra (repeated) word.
            swapped = False
            for j2 in twins:
                if j2 in match_of_w:
                    p = pw[match_of_w[j2]]
                    pc = (p["s"] + p["e"]) / 2.0
                    d_new = abs((ww[j]["s"] + ww[j]["e"]) / 2.0 - pc)
                    d_old = abs((ww[j2]["s"] + ww[j2]["e"]) / 2.0 - pc)
                    if d_new < d_old:
                        match_of_w[j] = match_of_w.pop(j2)
                        ww[j]["used"] = True
                        p["wc"] = ww[j]["c"]
                        ww[j2]["used"] = False
                        unmatched_w_dups.append(j2)
                        swapped = True
                        break
            if not swapped:
                unmatched_w_dups.append(j)

    # --- 3. fillers: match by time, then add what only Whisper heard
    p_fill = [i for i, w in enumerate(pw) if is_filler(w["n"])]
    w_fill = [j for j, w in enumerate(ww) if is_filler(w["n"])]
    used_p = set()
    for j in w_fill:
        w = ww[j]
        wc = (w["s"] + w["e"]) / 2.0
        best, bd = None, 9.0
        for i in p_fill:
            if i in used_p:
                continue
            p = pw[i]
            d = max(0.0, max(p["s"], w["s"]) - min(p["e"], w["e"]))      # gap between the two spans
            dc = abs((p["s"] + p["e"]) / 2.0 - wc)
            if d <= 0.35 and dc < bd:
                best, bd = i, dc
        if best is not None:
            used_p.add(best)
            pw[best]["src"] = "both"
            pw[best]["wc"] = w["c"]
            pw[best]["hints"] = [(pw[best]["hs"], pw[best]["he"]), (w["s"], max(w["e"], w["s"] + 0.05))]
            w["used"] = True

    allw = sorted(pw, key=lambda x: (x["s"], x["e"]))
    for j in w_fill:
        w = ww[j]
        if w["used"]:
            continue
        w["used"] = True
        if _replace_misheard(w, allw, env, out):
            continue
        _place_whisper_word(w, allw, env, out, kind="filler")
    for j in unmatched_w_dups:
        w = ww[j]
        if w["used"]:
            continue
        w["used"] = True
        if _place_whisper_word(w, allw, env, out, kind="repeat"):
            out.stats["repeats_added"] += 1
    for j, w in enumerate(ww):
        if w["frag"] and not w["used"]:
            w["used"] = True
            if _place_whisper_word(w, allw, env, out, kind="fragment"):
                out.stats["fragments_added"] += 1

    # --- 4. tighten the edges of every filler to the sound itself
    for k, w in enumerate(allw):
        if not is_filler(w["n"]):
            continue
        prev_e = allw[k - 1]["e"] if k > 0 else 0.0
        next_s = allw[k + 1]["s"] if k + 1 < len(allw) else env.duration
        if _refine_filler(w, prev_e, next_s, env):
            out.stats["filler_edges_tightened"] += 1

    # --- 5. final tidy
    allw.sort(key=lambda x: (x["s"], x["e"]))
    for i in range(len(allw) - 1):
        a, b = allw[i], allw[i + 1]
        if a["e"] > b["s"] + 0.001:
            a["e"] = max(a["s"] + 0.02, b["s"])
    final = []
    for w in allw:
        c = _final_conf(w)
        item = {"w": w["raw"], "s": round(w["s"], 3), "e": round(max(w["e"], w["s"] + 0.01), 3),
                "c": round(c, 2), "src": w["src"]}
        final.append(item)
        if w["src"] == "both":
            out.stats["both"] += 1
        elif w["src"] == "parakeet":
            out.stats["parakeet_only"] += 1
        if is_filler(w["n"]):
            out.stats["fillers_total"] += 1
            out.stats["fillers_" + {"both": "both", "parakeet": "parakeet_only", "whisper": "whisper_only"}[w["src"]]] += 1
    out.words = final
    return out


def _final_conf(w):
    pc, wc = w.get("c"), w.get("wc")
    if w["src"] == "both":
        base = noisy_or(pc, wc)
    elif w["src"] == "whisper":
        base = w.get("c_final", w.get("c"))
    else:
        base = pc
    if base is None:
        base = 0.5
    if w.get("disagree") and w["src"] != "whisper":
        base = min(base, 0.7)            # the other engine heard something different here
    return max(0.0, min(1.0, base))


# ----------------------------------------------------------------------------------------------
def snap_word_edges(pw, env, stats):
    """Pull a word's start/end to the real onset/offset of the sound when it sits next to a quiet gap.

    Parakeet times words in 80 ms steps, so the start of the first word after a pause can be a bit early or late.
    """
    runs = [(env.t_start(a), env.t_end(b)) for a, b in env.audible]
    if not runs:
        return
    rs = [r[0] for r in runs]
    re_ = [r[1] for r in runs]
    n = len(pw)
    for i, w in enumerate(pw):
        prev_e = pw[i - 1]["e"] if i > 0 else 0.0
        next_s = pw[i + 1]["s"] if i + 1 < n else env.duration
        # start: first sound after a quiet gap of 120 ms or more
        k = bisect.bisect_left(rs, w["s"] - 0.25)
        while k < len(runs) and rs[k] <= w["s"] + 0.2:
            gap_before = rs[k] - (re_[k - 1] if k > 0 else 0.0)
            if gap_before >= 0.12 and prev_e <= rs[k] + 0.03 and rs[k] < w["e"] - 0.04 and abs(rs[k] - w["s"]) > 0.015:
                w["s"] = rs[k]
                stats["word_edges_snapped"] += 1
                break
            k += 1
        # end: last sound before a quiet gap of 120 ms or more
        k = bisect.bisect_left(re_, w["e"] - 0.2)
        while k < len(runs) and re_[k] <= w["e"] + 0.25:
            gap_after = (rs[k + 1] if k + 1 < len(runs) else env.duration) - re_[k]
            if gap_after >= 0.12 and next_s >= re_[k] - 0.03 and re_[k] > w["s"] + 0.04 and abs(re_[k] - w["e"]) > 0.015:
                w["e"] = re_[k]
                stats["word_edges_snapped"] += 1
                break
            k += 1


MISHEARD = {"a", "i", "i'm", "am", "an", "and", "in", "on", "of", "or", "oh", "the", "it", "is", "as", "so",
            "you", "to", "he", "we", "if", "at", "but", "no", "now", "earned", "um"}


def _replace_misheard(w, allw, env, out):
    """Whisper heard a filler where Parakeet wrote a very short ordinary word ('a', 'and', "I'm") that Whisper
    does not have. Turn that word into the filler (Parakeet's timing is kept)."""
    lo_t, hi_t = w["s"] - 0.25, w["e"] + 0.25
    starts = [x["s"] for x in allw]
    k = max(0, bisect.bisect_left(starts, lo_t - 0.6))
    best = None
    while k < len(allw) and allw[k]["s"] <= hi_t:
        p = allw[k]
        k += 1
        if p["src"] != "parakeet" or is_filler(p["n"]) or len(p["n"]) > 4 or p["n"] not in MISHEARD:
            continue
        if p.get("disagree") is None and p["n"] not in ("a", "i", "an", "and", "am", "i'm", "oh", "earned"):
            continue
        ov = min(p["e"], hi_t) - max(p["s"], lo_t)
        if ov > 0 and (best is None or ov > best[0]):
            best = (ov, p)
    if best is None:
        return False
    p = best[1]
    if not env.is_audible_between(p["s"], p["e"], 2):
        return False
    p["w"], p["n"], p["raw"] = w["w"], w["n"], w["raw"]
    p["hs"], p["he"] = p["s"], p["e"]
    p["src"] = "whisper"
    p["wc"] = w["c"]
    p["c_final"] = 0.5 * (w["c"] if w["c"] is not None else 0.5) + 0.5 * 0.8
    out.stats["fillers_replaced_misheard"] += 1
    return True


def _gap_candidates(allw, t0, t1):
    """Gaps (lo, hi) between consecutive words that touch the time range [t0, t1]."""
    k = max(0, bisect.bisect_left(allw, t0, key=lambda x: x["s"]) - 3)
    gaps = []
    while k <= len(allw):
        lo = allw[k - 1]["e"] if k > 0 else 0.0
        hi = allw[k]["s"] if k < len(allw) else 1e9
        if lo > t1 + 0.5:
            break
        if hi >= t0 - 0.5:
            gaps.append((lo, hi))
        k += 1
    return gaps


def _place_whisper_word(w, allw, env, out, kind):
    """Add a word only Whisper heard, at the real sound in the right gap. Returns True if added."""
    hint_s, hint_e = w["s"], max(w["e"], w["s"] + 0.05)
    best = None
    for lo, hi in _gap_candidates(allw, hint_s - 0.9, hint_e + 0.9):
        hi = min(hi, env.duration)
        if hi - lo < 0.06:
            continue
        r = env.sound_for_hint([(hint_s, hint_e)], max(0.0, lo - 0.04), hi + 0.04)
        if r is None:
            continue
        s0, e0, hit = r
        s0, e0 = max(s0, lo - 0.03), min(e0, hi + 0.03)        # word edges are only good to a few tens of ms
        if e0 - s0 < (0.08 if kind == "filler" else 0.05):
            continue
        dist = max(0.0, max(s0 - hint_e, hint_s - e0))
        key = (1 if hit else 0, -dist, e0 - s0)
        if best is None or key > best[0]:
            best = (key, s0, e0)
    if best is None:
        # nothing audible in the gap: Whisper made it up from silence or room noise
        if kind == "filler":
            out.stats["whisper_only_dropped_no_sound"] += 1
            out.dropped.append((w["w"], round(hint_s, 2), "no sound in the gap"))
        return False
    _, s, e = best
    if e - s < 0.05:
        return False
    strong = env.level_db(s, e) >= env.floor_db + 12.0
    pc = w.get("c")
    c_final = 0.5 * (pc if pc is not None else 0.5) + 0.5 * (1.0 if strong else 0.6)
    item = {"w": w["w"], "raw": w["raw"], "n": w["n"], "s": s, "e": e, "c": pc, "wc": pc,
            "c_final": c_final, "src": "whisper", "added_kind": kind, "hs": hint_s, "he": hint_e}
    pos = bisect.bisect_left(allw, s, key=lambda x: x["s"])
    allw.insert(pos, item)
    out.stats["whisper_only_added"] += 1
    return True


def _refine_filler(w, prev_e, next_s, env):
    """Set a filler's start/end from the real sound. Keeps the engine's span if no sound is found."""
    lo = max(0.0, prev_e - 0.04)
    hi = min(env.duration, next_s + 0.04)
    hints = w.get("hints") or [(w.get("hs", w["s"]), w.get("he", w["e"]))]
    r = env.sound_for_hint(hints, lo, hi, reach=0.3)
    if r is None:
        return False
    s, e, hit = r
    if not hit:
        return False
    if abs(s - w["s"]) < 0.01 and abs(e - w["e"]) < 0.01:
        return False
    # do not let one filler swallow a long stretch of other sound (e.g. a filler glued to a word)
    if e - s > 2.5:
        return False
    w["s"], w["e"] = s, e
    return True
