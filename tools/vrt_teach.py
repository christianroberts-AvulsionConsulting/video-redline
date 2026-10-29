"""Teach it your ums: a small model of what YOUR ums sound like, learned from your own recordings and your Accept / Reject choices.

Why it exists. The speech engines write "um" wherever they think they hear one, and a sound effect (a whoosh, a pop, a bell) can fool
them. The cleanup rules then see "there is sound here" and take that as proof. This module gives the rules one more piece of
evidence: how much the sound itself looks like the ums the person taught it.

What is stored (all of it inside <tools folder>/teach/, never uploaded, never any audio):
    sources/clip-<id>.json    the fingerprints of the sounds in one recording the person pointed at (label "um" or "notum")
    sources/video-<id>.json   the fingerprints behind the Accept / Reject choices made in one video (label per choice)
    model.json                the trained model (the page evaluates it itself, see Cleanup.scoreFingerprint in cleanup.js)
    summary.json              what the page shows: counts, how well the model checks out, when it was trained

A fingerprint is FEATURES numbers (see FEATURE_NAMES) that describe one sound's spectral shape, pitch, steadiness and timing. They do
not depend on how loud the recording is. Numpy only, no other libraries, nothing to download.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time

import numpy as np

SR = 16000
TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
TEACH_DIR = os.environ.get("VRT_TEACH_DIR") or os.path.join(TOOLS_DIR, "teach")      # (the variable is for tests)
SOURCES_DIR = os.path.join(TEACH_DIR, "sources")
MODEL_PATH = os.path.join(TEACH_DIR, "model.json")
SUMMARY_PATH = os.path.join(TEACH_DIR, "summary.json")

MODEL_VERSION = 1
MIN_EACH = 8             # a class needs at least this many examples before it counts
MIN_UMS = 10             # no model before this many ums
MAX_PER_CLIP = 400       # one recording never adds more than this many sounds (evenly spread over it)
MAX_PER_CLASS = 2000     # the model never trains on more than this many examples of one class
MIN_SOUND = 0.12         # seconds: shorter bursts in a recording of ums are clicks and taps, not ums
MIN_SOUND_NOTUM = 0.06   # ... but in a recording of sounds that are not ums a pop that short still counts
MAX_SOUND = 3.0          # seconds: longer ones are speech or music, not one um
LAMBDA = 2.0             # ridge strength of the logistic model (the weights are shrunk; few examples must not overfit)
ONE_CLASS_SLOPE = 3.0    # one-class mode: how fast the score falls beyond the edge of the person's ums
UMLIKE = re.compile(r"^(?:u+h+m*|u+m+h*|a+h+m*|e+h+m*|e+r+m*|h+m+|m{2,}|m+h+m*)$")
FILLERS = {
    "um", "umm", "ummm", "uhm", "uhmm", "uh", "uhh", "uhhh", "er", "err", "erm", "ehm", "eh", "ah", "ahh",
    "hm", "hmm", "hmmm", "mm", "mmm", "mhm", "mmhm", "mmhmm", "hmmmm",
}


def wants_fingerprint(norm_word):
    """True for a word that is an um, an uh and the like (the words the cleanup rules may treat as a filler sound)."""
    return norm_word in FILLERS or bool(len(norm_word) <= 7 and UMLIKE.match(norm_word))


# ----------------------------------------------------------------------------------------------
# The fingerprint
# ----------------------------------------------------------------------------------------------
WIN, HOP, NFFT = 400, 160, 512          # 25 ms frames every 10 ms
PWIN, PFFT = 640, 2048                  # 40 ms frames for the pitch search
N_MEL, N_CEP = 24, 12
BANDS_HZ = (0, 300, 600, 1200, 2400, 4800, 8000)
FEATURE_NAMES = (
    ["cep%d_mean" % i for i in range(1, N_CEP + 1)] + ["cep%d_std" % i for i in range(1, N_CEP + 1)] +
    ["band_%d_%d" % (BANDS_HZ[i], BANDS_HZ[i + 1]) for i in range(len(BANDS_HZ) - 1)] +
    ["voicing", "voiced_share", "pitch_log2", "pitch_wobble",
     "flatness", "centroid_log2", "centroid_wobble", "rolloff_log2", "zero_cross", "flux",
     "length_log10", "attack", "level_wobble", "level_slope", "active_share", "crest_db"]
)
N_FEATURES = len(FEATURE_NAMES)

_cache = {}


def _tables():
    if "mel" in _cache:
        return _cache
    freqs = np.arange(NFFT // 2 + 1) * SR / float(NFFT)
    hz_to_mel = lambda f: 2595.0 * np.log10(1.0 + f / 700.0)
    mel_to_hz = lambda m: 700.0 * (10.0 ** (m / 2595.0) - 1.0)
    edges = mel_to_hz(np.linspace(hz_to_mel(100.0), hz_to_mel(7600.0), N_MEL + 2))
    mel = np.zeros((N_MEL, len(freqs)))
    for i in range(N_MEL):
        lo, mid, hi = edges[i], edges[i + 1], edges[i + 2]
        up = (freqs - lo) / max(1e-9, mid - lo)
        down = (hi - freqs) / max(1e-9, hi - mid)
        mel[i] = np.clip(np.minimum(up, down), 0.0, None)
    k = np.arange(N_MEL)
    dct = np.cos(np.pi / N_MEL * (k[None, :] + 0.5) * np.arange(1, N_CEP + 1)[:, None])      # (N_CEP, N_MEL): c1 .. c12
    band_bins = [(int(np.searchsorted(freqs, BANDS_HZ[i])), int(np.searchsorted(freqs, BANDS_HZ[i + 1])))
                 for i in range(len(BANDS_HZ) - 1)]
    _cache.update(mel=mel, dct=dct, freqs=freqs, hann=np.hanning(WIN), phann=np.hanning(PWIN), band_bins=band_bins,
                  lo_bin=int(np.searchsorted(freqs, 100.0)), hi_bin=int(np.searchsorted(freqs, 7600.0)))
    return _cache


def fingerprint(samples):
    """FEATURES numbers for ONE sound. `samples` are mono 16 kHz values in -1..1 (a numpy array or a list).
    None when the sound is shorter than 60 ms or has no signal at all."""
    x = np.asarray(samples, dtype=np.float64)
    if x.size < int(0.06 * SR):
        return None
    x = x - x.mean()
    peak = float(np.max(np.abs(x)))
    if peak < 1e-5:
        return None
    t = _tables()
    if x.size < WIN:
        x = np.concatenate([x, np.zeros(WIN - x.size)])
    nfr = 1 + (x.size - WIN) // HOP
    idx = np.arange(WIN)[None, :] + HOP * np.arange(nfr)[:, None]
    raw = x[idx]
    e_db = 10.0 * np.log10(np.mean(raw * raw, axis=1) + 1e-10)
    active = e_db >= e_db.max() - 25.0
    if int(active.sum()) < 3:
        active = np.ones(nfr, dtype=bool)
    spec = np.abs(np.fft.rfft(raw[active] * t["hann"], NFFT)) ** 2                  # (a, 257)
    ea = e_db[active]
    ta = np.flatnonzero(active) * HOP / float(SR)

    # cepstrum of the mel spectrum: the shape of the sound, whatever its loudness
    logmel = np.log(spec @ t["mel"].T + 1e-10)
    ceps = logmel @ t["dct"].T
    f = list(ceps.mean(axis=0)) + list(ceps.std(axis=0))
    # share of the energy in six broad bands
    tot = spec.sum() + 1e-10
    for a, b in t["band_bins"]:
        f.append(float(np.log10(spec[:, a:b].sum() / tot + 1e-6)))

    # pitch: how clearly periodic the sound is, and where
    pad = (PWIN - WIN) // 2
    xp = np.concatenate([np.zeros(pad), x, np.zeros(PWIN)])
    fi = np.flatnonzero(active)
    pidx = np.arange(PWIN)[None, :] + HOP * fi[:, None]
    seg = xp[pidx] * t["phann"]
    seg = seg - seg.mean(axis=1, keepdims=True)
    ac = np.fft.irfft(np.abs(np.fft.rfft(seg, PFFT, axis=1)) ** 2, PFFT, axis=1)[:, :260]
    ac = ac / (ac[:, :1] + 1e-12)
    lo_lag, hi_lag = int(SR / 400), int(SR / 70)
    mid = ac[:, lo_lag:hi_lag + 1]
    peak_mask = np.zeros_like(mid, dtype=bool)
    peak_mask[:, 1:-1] = (mid[:, 1:-1] > mid[:, :-2]) & (mid[:, 1:-1] >= mid[:, 2:])
    cand = np.where(peak_mask, mid, 0.0)
    voicing = cand.max(axis=1)
    lag = lo_lag + cand.argmax(axis=1)
    voiced = voicing > 0.45
    f.append(float(np.median(voicing)))
    f.append(float(voiced.mean()))
    if int(voiced.sum()) >= 1:
        lf = np.log2(SR / lag[voiced].astype(np.float64))
        f.append(float(np.median(lf)))
        f.append(float(12.0 * lf.std()) if lf.size >= 3 else 0.0)
    else:
        f.append(float(np.log2(120.0)))
        f.append(0.0)

    # spectral character
    fb = t["freqs"][t["lo_bin"]:t["hi_bin"]]
    pb = spec[:, t["lo_bin"]:t["hi_bin"]] + 1e-12
    flat = np.exp(np.mean(np.log(pb), axis=1)) / np.mean(pb, axis=1)
    cent = (pb * fb).sum(axis=1) / pb.sum(axis=1)
    lc = np.log2(cent)
    cum = np.cumsum(pb, axis=1) / pb.sum(axis=1, keepdims=True)
    roll = fb[np.minimum((cum < 0.85).sum(axis=1), len(fb) - 1)]
    zc = np.mean(np.abs(np.diff(np.sign(raw[active]), axis=1)) > 0, axis=1)
    pn = pb / pb.sum(axis=1, keepdims=True)
    flux = float(np.mean(np.sqrt(np.sum(np.diff(pn, axis=0) ** 2, axis=1)))) if pn.shape[0] > 1 else 0.0
    f += [float(np.log10(flat.mean() + 1e-6)), float(lc.mean()), float(lc.std()), float(np.log2(roll.mean())),
          float(zc.mean()), flux]

    # timing and loudness shape
    dur = x.size / float(SR)
    rms = float(np.sqrt(np.mean(x * x)) + 1e-12)
    slope = float(np.polyfit(ta, ea, 1)[0]) if ea.size >= 3 and ta[-1] > ta[0] else 0.0
    f += [float(np.log10(dur)), float(np.argmax(e_db)) / float(max(1, nfr - 1)), float(ea.std()), slope,
          float(active.mean()), float(20.0 * np.log10(peak / rms))]
    out = [float("%.4g" % v) for v in f]
    if len(out) != N_FEATURES or not all(np.isfinite(out)):
        return None
    return out


# ----------------------------------------------------------------------------------------------
# Finding the separate sounds in a teaching clip
# ----------------------------------------------------------------------------------------------
def clip_sounds(env, label="um"):
    """[(start, end)] seconds of every separate sound in a recording of sounds (an Envelope of vrt_audio). Bursts closer than 60 ms
    were already joined by the envelope; too long ones (speech, music) are left out, and so are too short ones: a tap in a recording
    of ums is not an um (0.12 s), but a pop in a recording of sound effects is one of the sounds to keep apart from ums (0.06 s)."""
    low = MIN_SOUND if label == "um" else MIN_SOUND_NOTUM
    out = [(a, b) for a, b in env.run_times if low <= b - a <= MAX_SOUND]
    if len(out) > MAX_PER_CLIP:
        keep = np.linspace(0, len(out) - 1, MAX_PER_CLIP).round().astype(int)
        out = [out[i] for i in keep]
    return out


def drop_outliers(fps):
    """(kept, dropped_count). A breath, a cough or a click inside a recording of ums would be learned as an um; a sound that looks
    nothing like the rest of the clip (far from the typical one in many features at once) is left out. Needs 10 sounds or more."""
    if len(fps) < 10:
        return list(fps), 0
    X = np.asarray(fps, dtype=np.float64)
    med = np.median(X, axis=0)
    mad = np.median(np.abs(X - med), axis=0) * 1.4826
    scale = np.maximum(mad, np.maximum(0.05 * np.abs(med), 1e-3))
    z = np.minimum(np.abs(X - med) / scale, 8.0)
    d = z.mean(axis=1)
    cut = max(3.0, float(np.median(d)) * 2.2)
    keep = d <= cut
    if keep.sum() < 10:
        return list(fps), 0
    return [fps[i] for i in range(len(fps)) if keep[i]], int((~keep).sum())


def attach_fingerprints(words, pcm, limit=4000):
    """Add "fp" to every word of a transcript that is an um-like sound (called by transcribe.py). Never raises."""
    import vrt_audio as A
    import vrt_merge as M
    n = 0
    for w in words:
        if n >= limit:
            break
        try:
            if not wants_fingerprint(M.norm(w["w"])):
                continue
            s, e = float(w["s"]), float(w["e"])
            if e - s < 0.06:
                e = s + 0.06
            fp = fingerprint(A.to_float(pcm, int(s * SR), int(e * SR)))
        except Exception:
            continue
        if fp:
            w["fp"] = fp
            n += 1
    return n


# ----------------------------------------------------------------------------------------------
# The model
# ----------------------------------------------------------------------------------------------
def sigmoid(z):
    z = np.clip(z, -30.0, 30.0)
    return 1.0 / (1.0 + np.exp(-z))


def _stdize(X, mean, std):
    return np.clip((X - mean) / std, -6.0, 6.0)


def _fit_logistic(Z, y, w):
    """Ridge logistic regression by Newton steps. Z is standardized; returns (weights, bias)."""
    n, d = Z.shape
    Zb = np.hstack([Z, np.ones((n, 1))])
    ridge = np.full(d + 1, LAMBDA)
    ridge[-1] = 1e-6
    beta = np.zeros(d + 1)
    for _ in range(40):
        p = sigmoid(Zb @ beta)
        g = Zb.T @ (w * (p - y)) + ridge * beta
        h = (Zb * (w * p * (1.0 - p) + 1e-9)[:, None]).T @ Zb + np.diag(ridge)
        step = np.linalg.solve(h, g)
        beta -= step
        if float(np.max(np.abs(step))) < 1e-7:
            break
    return beta[:-1], float(beta[-1])


def _balanced_weights(y):
    n1 = max(1.0, float(y.sum()))
    n0 = max(1.0, float(len(y) - y.sum()))
    return np.where(y > 0.5, len(y) / (2.0 * n1), len(y) / (2.0 * n0))


def _folds(y, k):
    """Deterministic stratified folds: example i goes to fold (rank within its class) mod k."""
    fold = np.zeros(len(y), dtype=int)
    for cls in (0.0, 1.0):
        ix = np.flatnonzero(y == cls)
        fold[ix] = np.arange(len(ix)) % k
    return fold


def _one_class_stats(X):
    mean = X.mean(axis=0)
    std = np.maximum(X.std(axis=0), np.maximum(0.05 * np.abs(mean), 1e-3))
    return mean, std


def _one_class_d2(X, mean, std):
    return np.mean(_stdize(X, mean, std) ** 2, axis=1)


def train(pos, neg):
    """Train from fingerprints. pos / neg: lists of fingerprints (ums / sounds that are not ums). Returns the model dict, or None
    when there are not enough ums yet. The model has a "check" entry: how it did on examples it had not seen."""
    P = np.asarray(pos, dtype=np.float64).reshape(-1, N_FEATURES)
    N = np.asarray(neg, dtype=np.float64).reshape(-1, N_FEATURES)
    if len(P) < MIN_UMS:
        return None
    model = {"version": MODEL_VERSION, "features": N_FEATURES, "ums": int(len(P)), "notums": int(len(N)),
             "trained": int(time.time())}
    if len(N) >= MIN_EACH:
        X = np.vstack([P, N])
        y = np.concatenate([np.ones(len(P)), np.zeros(len(N))])
        mean = X.mean(axis=0)
        std = np.maximum(X.std(axis=0), 1e-3)
        w, b = _fit_logistic(_stdize(X, mean, std), y, _balanced_weights(y))
        model.update(kind="two-class", mean=[float("%.5g" % v) for v in mean], std=[float("%.5g" % v) for v in std],
                     w=[float("%.5g" % v) for v in w], b=float("%.5g" % b))
        # how well does it do on examples it has not seen? (stratified folds)
        k = int(min(5, len(P), len(N)))
        fold = _folds(y, k)
        pred = np.zeros(len(y))
        for f in range(k):
            tr, te = fold != f, fold == f
            m = X[tr].mean(axis=0)
            s = np.maximum(X[tr].std(axis=0), 1e-3)
            ww, bb = _fit_logistic(_stdize(X[tr], m, s), y[tr], _balanced_weights(y[tr]))
            pred[te] = sigmoid(_stdize(X[te], m, s) @ ww + bb)
        hit = (pred >= 0.5)
        model["check"] = {"recall": float(hit[y > 0.5].mean()), "rejects": float((~hit[y < 0.5]).mean()),
                          "ums": int(len(P)), "notums": int(len(N))}
    else:
        mean, std = _one_class_stats(P)
        k = int(min(10, len(P)))
        fold = np.arange(len(P)) % k
        d2 = np.zeros(len(P))
        for f in range(k):
            tr, te = fold != f, fold == f
            m, s = _one_class_stats(P[tr])
            d2[te] = _one_class_d2(P[te], m, s)
        edge = float(np.quantile(d2, 0.9))               # 9 in 10 of the person's own held-out ums fall inside this
        model.update(kind="one-class", mean=[float("%.5g" % v) for v in mean], std=[float("%.5g" % v) for v in std],
                     edge=float("%.5g" % max(edge, 1e-3)), slope=ONE_CLASS_SLOPE)
        model["check"] = {"recall": 0.9, "rejects": None, "ums": int(len(P)), "notums": int(len(N))}
    return model


def score(model, fp):
    """Probability (0 to 1) that the sound with this fingerprint is one of the person's ums. Same arithmetic as
    Cleanup.scoreFingerprint in cleanup.js (a test checks that the two agree)."""
    if not model or not fp or len(fp) != model.get("features"):
        return None
    z = _stdize(np.asarray(fp, dtype=np.float64), np.asarray(model["mean"]), np.asarray(model["std"]))
    if model["kind"] == "two-class":
        return float(sigmoid(float(np.dot(z, np.asarray(model["w"]))) + model["b"]))
    d2 = float(np.mean(z ** 2))
    return float(sigmoid(-(d2 / model["edge"] - 1.0) * model["slope"]))


# ----------------------------------------------------------------------------------------------
# The store
# ----------------------------------------------------------------------------------------------
def _write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _source_id(text):
    return hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()[:16]


def _clean_fp(fp):
    if not isinstance(fp, list) or len(fp) != N_FEATURES:
        return None
    try:
        out = [float(v) for v in fp]
    except (TypeError, ValueError):
        return None
    return out if all(np.isfinite(out)) else None


def load_sources():
    docs = []
    try:
        names = sorted(os.listdir(SOURCES_DIR))
    except OSError:
        return docs
    for n in names:
        if n.endswith(".json"):
            d = _read_json(os.path.join(SOURCES_DIR, n))
            if isinstance(d, dict) and isinstance(d.get("examples"), list):
                d["_file"] = n
                docs.append(d)
    return docs


def _gather(docs):
    pos, neg = [], []
    for d in docs:
        for ex in d["examples"]:
            fp = _clean_fp(ex.get("fp"))
            if fp is None:
                continue
            (pos if ex.get("label") == "um" else neg).append(fp)
    return pos[-MAX_PER_CLASS:], neg[-MAX_PER_CLASS:]


def retrain():
    """Train from everything in the store, write model.json and summary.json, return the summary."""
    docs = load_sources()
    pos, neg = _gather(docs)
    model = train(pos, neg)
    if model is None:
        try:
            os.remove(MODEL_PATH)
        except OSError:
            pass
    else:
        _write_json(MODEL_PATH, model)
    clips, decisions_ums, decisions_not = [], 0, 0
    for d in docs:
        n_um = sum(1 for e in d["examples"] if e.get("label") == "um")
        n_not = len(d["examples"]) - n_um
        if d.get("kind") == "clip":
            clips.append({"id": d["_file"][len("clip-"):-len(".json")] if d["_file"].startswith("clip-") else d["_file"],
                          "name": str(d.get("name") or "recording")[:120], "label": d.get("label"),
                          "sounds": len(d["examples"]), "ignored": int(d.get("ignored") or 0)})
        elif d.get("kind") == "video":
            decisions_ums += n_um
            decisions_not += n_not
    summary = {"ok": True, "version": MODEL_VERSION, "ready": model is not None,
               "kind": model.get("kind") if model else None,
               "ums": len(pos), "notums": len(neg), "clips": clips,
               "decisions": {"ums": decisions_ums, "notums": decisions_not},
               "check": model.get("check") if model else None,
               "trained": model.get("trained") if model else None,
               "needs": {"ums": MIN_UMS, "each": MIN_EACH}}
    _write_json(SUMMARY_PATH, summary)
    return summary


def add_clip(label, name, fps, ignored, clip_id):
    """Store the fingerprints of one teaching recording (replaces an earlier copy of the same recording)."""
    doc = {"kind": "clip", "label": label, "name": name, "added": int(time.time()), "ignored": int(ignored),
           "examples": [{"label": label, "fp": fp} for fp in fps]}
    _write_json(os.path.join(SOURCES_DIR, "clip-%s.json" % clip_id), doc)
    return retrain()


def sync_video(video_key, examples):
    """Replace the Accept / Reject examples of ONE video with these (so undo, a changed mind and a new level all stay right)."""
    clean = []
    for ex in examples[:5000] if isinstance(examples, list) else []:
        if not isinstance(ex, dict) or ex.get("label") not in ("um", "notum"):
            continue
        fp = _clean_fp(ex.get("fp"))
        if fp is not None:
            clean.append({"label": ex["label"], "fp": fp})
    path = os.path.join(SOURCES_DIR, "video-%s.json" % _source_id(str(video_key)))
    if clean:
        _write_json(path, {"kind": "video", "added": int(time.time()), "examples": clean})
    else:
        try:
            os.remove(path)
        except OSError:
            pass
    return retrain()


def forget(what):
    """what: "all", "clips" (the teaching recordings), "decisions" (what your Accept / Reject choices taught it) or
    "clip:<id>" (one teaching recording, the id from the summary)."""
    if what.startswith("clip:"):
        return forget_clip(what[5:])
    for d in load_sources():
        if what == "all" or (what == "clips" and d.get("kind") == "clip") or (what == "decisions" and d.get("kind") == "video"):
            try:
                os.remove(os.path.join(SOURCES_DIR, d["_file"]))
            except OSError:
                pass
    return retrain()


def forget_clip(clip_id):
    try:
        os.remove(os.path.join(SOURCES_DIR, "clip-%s.json" % re.sub(r"[^0-9a-f]", "", clip_id)[:32]))
    except OSError:
        pass
    return retrain()


def clip_id_for(label, content_key):
    return _source_id("%s|%s" % (label, content_key))
