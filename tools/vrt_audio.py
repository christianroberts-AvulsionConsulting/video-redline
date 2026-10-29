"""Audio helpers for the transcription helper (numpy only, no other audio libraries).

* decode_to_pcm   : streams any video/audio file to 16 kHz mono 16-bit PCM on disk (PyAV, no ffmpeg install needed)
* compute_db      : short-time energy envelope (25 ms window, 10 ms hop) in dB
* Envelope        : noise floor, audible regions, silences, sounds, filler boundary refinement

Everything here works on a memory-mapped file, so a 40 minute recording never has to sit in memory.
"""
from __future__ import annotations

import os

import numpy as np

from vrt_env import describe_import_failure

SR = 16000         # sample rate used everywhere
HOP = 160           # 10 ms
WIN = 400           # 25 ms
OWN = (WIN - HOP) // 2   # each frame "owns" the middle HOP samples of its window


class AudioProblem(Exception):
    """Raised with a plain-language message when the file cannot be read. `hint` (optional) says what to do."""

    def __init__(self, message, hint=None):
        Exception.__init__(self, message)
        self.hint = hint


# ----------------------------------------------------------------------------------------------
# Decoding
# ----------------------------------------------------------------------------------------------
GAP_TOLERANCE = SR // 50        # 20 ms: smaller timing differences are normal decoder / resampler jitter
START_TOLERANCE = SR // 200     # 5 ms: a track that starts later than this is padded so it stays on the video's clock
MAX_FILL_SECONDS = 1800.0       # a forward jump of more than 30 minutes is a broken timestamp, not a real dropout
MAX_TRIM_SECONDS = 1.0          # a backward jump of more than 1 second is a timestamp reset (clips joined together)


def _mmss(seconds):
    seconds = int(max(0, round(seconds)))
    return "%d:%02d" % divmod(seconds, 60)


def _secs(seconds):
    return ("%.1f s" % seconds) if seconds < 600 else _mmss(seconds)


def decode_to_pcm(path, raw_path, on_progress=None):
    """Decode the first audio track of `path` to 16 kHz mono int16 written to `raw_path`.

    Every decoded frame is placed by its own timestamp, not just appended: if the file has a gap in its audio
    timestamps, or packets that could not be decoded, silence of the right length is written instead, so that every
    later word keeps the time it has on the video. (Appending frames back to back would shift every later word
    earlier by the size of the gap.) A backward jump of the timestamps is handled the other way round: a small
    overlap is trimmed, and a big jump (two clips joined) just carries on from the current position.

    Returns dict(samples, container_duration, had_video, bad_packets, gaps, warnings). `gaps` is a list of
    (position_seconds, silence_seconds) and `warnings` a list of plain-language sentences for the person using the
    tool. Streams in small pieces: memory use is tiny.
    """
    try:
        import av
    except Exception as e:  # pragma: no cover
        msg, hint = describe_import_failure(e, "The audio decoder (PyAV)")
        raise AudioProblem(msg, hint) from e

    try:
        container = av.open(str(path))
    except FileNotFoundError:
        raise AudioProblem("I could not find that file.")
    except Exception as e:
        raise AudioProblem(
            "I could not open that file as a video or audio file. It may be damaged, still being written, "
            "or in a format I do not know. (Technical detail: %s)" % (getattr(e, "strerror", None) or type(e).__name__)
        )
    try:
        if not container.streams.audio:
            raise AudioProblem("This file has no audio track, so there is nothing to transcribe.")
        stream = container.streams.audio[0]
        had_video = len(container.streams.video) > 0
        dur = None
        if container.duration:
            dur = container.duration / 1000000.0   # av.time_base
        elif stream.duration and stream.time_base:
            dur = float(stream.duration * stream.time_base)

        resampler = av.AudioResampler(format="s16", layout="mono", rate=SR)
        written = 0                 # samples written so far (16 kHz)
        base = 0.0                  # media time (s) that belongs to output position 0; moves when timestamps jump back
        last_report = 0.0
        bad_packets = 0
        first_bad_at = None
        gaps = []                   # (position_seconds, silence_seconds)
        resets = []                 # position_seconds where the timestamps jumped by a lot
        trimmed = 0                 # samples dropped because the timestamps overlapped the audio already written
        late_start = None           # clock time of a first frame so late that it is a timestamp problem, not a pause
        demux_error = None
        with open(raw_path, "wb") as out:
            def put(frames, skip):
                """Write resampled frames, dropping the first `skip` samples. Returns the samples still to skip."""
                nonlocal written
                for fr in frames:
                    arr = np.ascontiguousarray(fr.to_ndarray()).reshape(-1)
                    if skip > 0:
                        if skip >= arr.size:
                            skip -= arr.size
                            continue
                        arr = arr[skip:]
                        skip = 0
                    out.write(arr.tobytes())
                    written += arr.size
                return skip

            def silence(n):
                """Write n samples of silence (in pieces of at most 10 seconds)."""
                nonlocal written
                left = n
                while left > 0:
                    k = min(left, SR * 10)
                    out.write(b"\x00\x00" * k)
                    left -= k
                written += n

            it = container.demux(stream)
            while True:
                try:
                    packet = next(it)
                except StopIteration:
                    break
                except AudioProblem:
                    raise
                except Exception as e:                     # the container itself is damaged from here on
                    demux_error = e
                    break
                try:
                    frames = packet.decode()
                except Exception:
                    bad_packets += 1
                    if first_bad_at is None:
                        first_bad_at = written / float(SR)
                    if bad_packets > 5000:
                        raise AudioProblem("The audio in this file is too damaged to read.")
                    continue
                for frame in frames:
                    skip = 0
                    overlap = 0
                    ft = frame.time
                    if ft is not None:
                        rel = ft - base
                        target = max(0, int(round(rel * SR)))
                        if rel < 0:
                            skip = int(round(-rel * SR))      # e.g. the priming frame of an AAC track starts before 0
                        delta = target - written
                        if delta > (GAP_TOLERANCE if written else START_TOLERANCE):
                            if delta > MAX_FILL_SECONDS * SR:
                                # too big to be sound that went missing: carry on from here instead of writing hours of silence
                                if written:
                                    resets.append(written / float(SR))
                                else:
                                    late_start = ft
                                base = ft - written / float(SR)
                            else:
                                if written:               # (a late start is padded too, but is not a "gap")
                                    gaps.append((written / float(SR), delta / float(SR)))
                                silence(delta)
                        elif delta < -GAP_TOLERANCE:
                            if -delta > MAX_TRIM_SECONDS * SR:
                                resets.append(written / float(SR))
                                base = ft - written / float(SR)
                            else:
                                overlap = -delta
                                skip = max(skip, overlap)
                    left = put(resampler.resample(frame), skip)
                    if overlap:
                        trimmed += min(overlap, skip - left)
                    if on_progress and dur and ft is not None and ft - last_report > 2.0:
                        last_report = ft
                        on_progress(min(0.99, ft / dur))
            try:
                put(resampler.resample(None), 0)
            except Exception:
                pass
        if written < SR // 4:
            raise AudioProblem("The audio in this file is empty or too short to transcribe.")

        audio_dur = written / float(SR)
        warnings = []
        total_gap = sum(g[1] for g in gaps)
        if bad_packets:
            warnings.append(
                "Part of the audio in this file is damaged: %d small piece%s could not be read (the first one near %s%s). "
                "Those moments are filled with silence, so the words after them keep their right time, but anything "
                "said there is missing." % (
                    bad_packets, "" if bad_packets == 1 else "s", _mmss(first_bad_at or 0.0),
                    (", about %s of sound in total" % _secs(total_gap)) if total_gap > 0 else ""))
        elif gaps:
            warnings.append(
                "The sound in this file has %d break%s in its timing (%s of missing sound in total, the first near %s). "
                "I filled each break with silence so that the words after it stay on the right time." % (
                    len(gaps), "" if len(gaps) == 1 else "s", _secs(total_gap), _mmss(gaps[0][0])))
        if resets:
            warnings.append(
                "The timing of the sound jumps by a large amount near %s (this happens when two recordings were joined "
                "together). Words after that point may not line up exactly with the video." % _mmss(resets[0]))
        if late_start is not None:
            warnings.append(
                "The sound track starts very late on the file's clock (at %s). I treated that moment as the beginning, "
                "so the words line up with the start of the recording." % _mmss(late_start))
        if trimmed > GAP_TOLERANCE:
            warnings.append(
                "Some of the sound in this file overlaps itself in time (%s in total), so the overlapping part was "
                "skipped to keep the words on the right time." % _secs(trimmed / float(SR)))
        if demux_error is not None:
            warnings.append(
                "The file seems to be damaged or cut short after %s, so the rest of it could not be read." % _mmss(audio_dur))
        if dur and not warnings and abs(audio_dur - dur) > 1.0:
            if audio_dur < dur:
                warnings.append(
                    "The sound track is %s shorter than the video (it ends at %s, the video at %s). The word times "
                    "are not affected, but the silent end of the video is not analysed." % (
                        _secs(dur - audio_dur), _mmss(audio_dur), _mmss(dur)))
            else:
                warnings.append(
                    "The sound track is %s longer than the video (%s against %s). If the words seem to drift away "
                    "from the picture, the recording has a timing problem." % (
                        _secs(audio_dur - dur), _mmss(audio_dur), _mmss(dur)))
        return {"samples": written, "container_duration": dur, "had_video": had_video, "bad_packets": bad_packets,
                "gaps": gaps, "warnings": warnings}
    finally:
        try:
            container.close()
        except Exception:
            pass


class PcmFile:
    """Read-only view of a raw 16-bit mono file on disk. pcm[a:b] reads just that part (nothing is kept in memory)."""

    def __init__(self, path):
        self.path = path
        self.n = os.path.getsize(path) // 2
        self.f = open(path, "rb")

    def __len__(self):
        return self.n

    def __getitem__(self, sl):
        start, stop, _ = sl.indices(self.n)
        if stop <= start:
            return np.zeros(0, np.int16)
        self.f.seek(start * 2)
        return np.frombuffer(self.f.read((stop - start) * 2), dtype="<i2")

    def close(self):
        try:
            self.f.close()
        except Exception:
            pass


def open_pcm(raw_path):
    return PcmFile(raw_path)


def to_float(pcm, a, b):
    """float32 copy of samples [a, b) scaled to -1..1."""
    a = max(0, int(a))
    b = min(len(pcm), int(b))
    if b <= a:
        return np.zeros(0, np.float32)
    return (np.asarray(pcm[a:b], dtype=np.float32) * np.float32(1.0 / 32768.0))


# ----------------------------------------------------------------------------------------------
# Energy envelope
# ----------------------------------------------------------------------------------------------
def compute_db(pcm, frames_per_chunk=6000):
    n = len(pcm)
    if n < WIN:
        x = to_float(pcm, 0, n)
        ms = float(np.mean(x * x)) if len(x) else 0.0
        return np.array([10.0 * np.log10(ms + 1e-10)], np.float32)
    nframes = (n - WIN) // HOP + 1
    db = np.empty(nframes, np.float32)
    for f0 in range(0, nframes, frames_per_chunk):
        f1 = min(nframes, f0 + frames_per_chunk)
        a = f0 * HOP
        b = (f1 - 1) * HOP + WIN
        x = np.asarray(pcm[a:b], dtype=np.float64) * (1.0 / 32768.0)
        cs = np.empty(len(x) + 1)
        cs[0] = 0.0
        np.cumsum(x * x, out=cs[1:])
        idx = np.arange(f1 - f0) * HOP
        ms = (cs[idx + WIN] - cs[idx]) / WIN
        db[f0:f1] = 10.0 * np.log10(ms + 1e-10)
    return db


def _runs(mask):
    """[(first_index, last_index_inclusive)] of True runs."""
    if mask.size == 0:
        return []
    m = np.concatenate(([False], mask, [False]))
    d = np.diff(m.astype(np.int8))
    starts = np.flatnonzero(d == 1)
    ends = np.flatnonzero(d == -1) - 1
    return list(zip(starts.tolist(), ends.tolist()))


class Envelope:
    """Noise floor, audible regions, silences and sounds for one recording."""

    def __init__(self, pcm, db, margin_db=7.0, hold_db=4.0):
        self.pcm = pcm
        self.n = len(pcm)
        self.duration = self.n / float(SR)
        self.db = db
        self.nf = len(db)
        # 3-frame median so one noisy frame cannot flip the decision
        if self.nf >= 3:
            st = np.stack([db[:-2], db[1:-1], db[2:]])
            sm = np.empty_like(db)
            sm[1:-1] = np.median(st, axis=0)
            sm[0] = db[0]
            sm[-1] = db[-1]
        else:
            sm = db.copy()
        self.sm = sm
        valid = sm[sm > -85.0]
        if valid.size < 20:
            valid = sm
        # noise floor: take the quietest 10 percent as a starting point, then use the typical level of everything
        # within 6 dB of that (the lowest single frames of steady noise sit about 1 to 2 dB under its true average)
        p10 = float(np.percentile(valid, 10))
        near = valid[valid < p10 + 6.0]
        self.floor_db = float(max(np.median(near) if near.size else p10, -80.0))
        self.speech_db = float(np.percentile(valid, 95)) if valid.size else self.floor_db
        self.margin_db = margin_db
        self.hold_db = hold_db
        self.range_db = self.speech_db - self.floor_db
        self.warnings = []
        if self.range_db < 15.0:
            self.warnings.append(
                "Could not find a clearly quiet background in this recording (the quietest parts are only %.0f dB "
                "below the speech). Dead-space detection may miss some quiet gaps." % self.range_db
            )
        self._build_regions()

    # -- frame/time conversion --------------------------------------------------------------
    def t_start(self, i):
        return 0.0 if i <= 0 else (i * HOP + OWN) / float(SR)

    def t_end(self, j):
        return self.duration if j >= self.nf - 1 else (j * HOP + OWN + HOP) / float(SR)

    def frame_at(self, t):
        return int(min(max(0, round((t * SR - OWN - HOP / 2.0) / HOP)), self.nf - 1))

    # -- regions ----------------------------------------------------------------------------
    def _build_regions(self):
        hi = self.floor_db + self.margin_db
        lo = self.floor_db + self.hold_db
        self.thr_hi = hi
        self.thr_lo = lo
        above_lo = self.sm >= lo
        runs = _runs(above_lo)
        keep = []
        for a, b in runs:
            if np.max(self.sm[a:b + 1]) >= hi:
                keep.append([a, b])
        self.raw_runs = [tuple(r) for r in keep]            # every audible run, even a 10 ms click
        # short blips (< 50 ms) are ignored when looking for silences; runs closer than 60 ms are joined
        solid = [r for r in keep if (r[1] - r[0] + 1) >= 5]
        merged = []
        for r in solid:
            if merged and r[0] - merged[-1][1] - 1 < 6:
                merged[-1][1] = r[1]
            else:
                merged.append([r[0], r[1]])
        self.audible = [tuple(r) for r in merged]
        self.rr_times = [(self.t_start(x), self.t_end(y)) for x, y in self.raw_runs if y - x + 1 >= 4]
        self.rr_starts = [r[0] for r in self.rr_times]
        self.rr_ends = [r[1] for r in self.rr_times]
        self.run_times = [(self.t_start(x), self.t_end(y)) for x, y in self.audible]
        self.run_starts = [r[0] for r in self.run_times]
        self.run_ends = [r[1] for r in self.run_times]

    def silences(self, min_len=0.3):
        """Quiet stretches of at least `min_len` seconds: list of (start, end) seconds."""
        out = []
        prev_end = -1
        for a, b in self.audible + [(self.nf, self.nf)]:
            g0 = prev_end + 1
            g1 = a - 1
            if g1 >= g0:
                s = self.t_start(g0)
                e = self.t_end(g1) if g1 < self.nf - 1 else self.duration
                if e - s >= min_len:
                    out.append((round(s, 3), round(e, 3)))
            prev_end = b
        return out

    def is_audible_between(self, t0, t1, min_frames=2):
        """True if the energy is above the floor for at least `min_frames` frames within [t0, t1]."""
        if self.nf == 0:
            return False
        i0 = self.frame_at(max(0.0, t0))
        i1 = self.frame_at(min(self.duration, t1))
        if i1 < i0:
            i0, i1 = i1, i0
        return int(np.count_nonzero(self.sm[i0:i1 + 1] >= self.thr_lo)) >= min_frames

    def level_db(self, t0, t1):
        a = int(max(0, t0 * SR))
        b = int(min(self.n, t1 * SR))
        if b - a < 8:
            return -100.0
        x = to_float(self.pcm, a, b)
        return float(10.0 * np.log10(float(np.mean(x * x)) + 1e-10))

    # -- finding where a sound really starts and ends -----------------------------------------
    def _valleys(self, i0, i1):
        """Frame numbers of real dips (at least 4 dB deep, 60 ms from the ends) inside the burst of frames i0..i1."""
        seg = self.sm[i0:i1 + 1]
        n = len(seg)
        out = []
        for k in range(6, n - 6):
            v = seg[k]
            if v > seg[k - 1] or v > seg[k + 1]:
                continue
            if v > float(np.min(seg[max(0, k - 3):k + 4])):
                continue
            lm = float(np.max(seg[max(0, k - 12):k]))
            rm = float(np.max(seg[k + 1:k + 13]))
            if v <= min(lm, rm) - 4.0:
                if out and k - out[-1] < 5:
                    if v < seg[out[-1]]:
                        out[-1] = k
                else:
                    out.append(k)
        return [i0 + k for k in out]

    def sound_for_hint(self, hints, lo, hi, reach=0.8):
        """Find the real sound that the engines placed (roughly) at the time spans in `hints`, never going beyond [lo, hi].

        hints : list of (start, end) spans from the engines. Looks at the separate bursts of sound (a burst ends
        wherever the energy falls to the background), picks the one that overlaps the spans most, and cuts it at a
        real dip if a neighbouring word is stuck to it. If none overlaps, takes the nearest one within `reach` seconds.
        Bursts separated by a dip of 80 ms or less are joined only when they lie inside a span itself.
        Returns (start, end, ok_overlap) or None.
        """
        import bisect
        if isinstance(hints, tuple):
            hints = [hints]
        cands = []
        k = max(0, bisect.bisect_left(self.rr_ends, lo - 0.001))
        while k < len(self.rr_times) and self.rr_starts[k] <= hi + 0.001:
            rs, re_ = self.rr_times[k]
            s0, e0 = max(rs, lo), min(re_, hi)
            if e0 - s0 >= 0.04:
                cands.append([s0, e0])
            k += 1
        if not cands:
            return None
        wins = [(h0 - 0.12, max(h1, h0 + 0.05) + 0.12) for h0, h1 in hints]

        def score(s0, e0):
            return sum(max(0.0, min(e0, w1) - max(s0, w0)) for w0, w1 in wins)

        best = None
        for i, (s0, e0) in enumerate(cands):
            ov = score(s0, e0)
            if ov > 0.02:
                key = (1, ov)
            else:
                dist = min(max(0.0, max(s0 - h1, h0 - e0)) for h0, h1 in hints)
                if dist > reach:
                    continue
                key = (0, -dist)
            if best is None or key > best[0]:
                best = (key, i)
        if best is None:
            return None
        i = best[1]
        s, e = cands[i]
        # join neighbours across a short dip, but only when they sit inside an engine's own span
        def inside(c0, c1):
            return any(min(c1, h1) - max(c0, h0) > 0.02 for h0, h1 in hints)
        j = i - 1
        while j >= 0 and s - cands[j][1] <= 0.08 and inside(*cands[j]):
            s = cands[j][0]
            j -= 1
        j = i + 1
        while j < len(cands) and cands[j][0] - e <= 0.08 and inside(*cands[j]):
            e = cands[j][1]
            j += 1
        # a neighbouring word may be stuck to the front or back with no quiet gap: cut at the dip between them
        if best[0][0] == 1 and e - s > 0.2:
            f0, f1 = self.frame_at(s), self.frame_at(e)
            vs = self._valleys(f0, f1)
            if vs:
                cuts = [s] + [self.t_start(v) for v in vs] + [e]
                bestp = None
                for a_, b_ in zip(cuts[:-1], cuts[1:]):
                    if b_ - a_ < 0.05:
                        continue
                    sc = score(a_, b_)
                    if bestp is None or sc > bestp[0]:
                        bestp = (sc, a_, b_)
                if bestp is not None and bestp[0] > 0.02:
                    s, e = bestp[1], bestp[2]
        return (s, e, best[0][0] == 1)

    def quiet_cut_near(self, t, back=6.0, forward=0.0, min_t=None):
        """A good place to split the recording near time `t`: the quietest spot in [t-back, t+forward].

        Prefers the middle of the longest quiet stretch; falls back to the lowest-energy 100 ms.
        """
        lo = max(min_t if min_t is not None else 0.0, t - back)
        hi = min(self.duration, t + forward)
        if hi <= lo:
            return min(self.duration, max(lo, t))
        i0 = self.frame_at(lo)
        i1 = self.frame_at(hi)
        seg = self.sm[i0:i1 + 1]
        if seg.size == 0:
            return t
        quiet = seg < self.thr_lo
        best_len = 0
        best_mid = None
        for a, b in _runs(quiet):
            ln = b - a + 1
            if ln > best_len:
                best_len = ln
                best_mid = (a + b) // 2
        if best_mid is not None and best_len >= 8:       # 80 ms or more of quiet
            return self.t_start(i0 + best_mid)
        k = 10
        if seg.size >= k:
            avg = np.convolve(seg, np.ones(k) / k, mode="valid")
            return self.t_start(i0 + int(np.argmin(avg)) + k // 2)
        return self.t_start(i0 + int(np.argmin(seg)))

    def plan_blocks(self, max_len, min_len=5.0):
        """Split the recording into consecutive (start, end) blocks of at most max_len seconds,
        always cutting in a quiet spot so that no word is split in two."""
        blocks = []
        start = 0.0
        back = min(10.0, max_len * 0.4)
        while start < self.duration - 1e-6:
            end = start + max_len
            if end >= self.duration - 1.0:
                end = self.duration
            else:
                end = self.quiet_cut_near(end, back=back, forward=0.0, min_t=start + min_len)
                if end <= start + 0.5:
                    end = min(self.duration, start + max_len)
            blocks.append((round(start, 3), round(end, 3)))
            start = end
        return blocks

    def has_sound(self, t0, t1):
        """True if anything rises above the background between t0 and t1."""
        return self.is_audible_between(t0, t1, min_frames=3)

    # -- sounds -----------------------------------------------------------------------------
    def sounds(self, word_spans, min_len=0.12, pad=0.04):
        """Audible regions that no word covers (within 40 ms): breaths, clicks, coughs, a stray "mm", a stutter.

        word_spans : list of (start, end) for every word (any engine).
        Returns list of dict(s, e, kind, c, db), sorted by time.
        A stretch of sound that sits right next to a word still needs 0.12 s, and the engines time the end of a word only roughly: the
        speech engines time the end of a word only roughly; stretches squeezed between two words with no dip on
        either side are treated as part of the speech.
        """
        import bisect
        padded = sorted((s - pad, e + pad) for s, e in word_spans)
        starts = [p[0] for p in padded]
        out = []
        for a, b in self.raw_runs:
            rs, re_ = self.t_start(a), self.t_end(b)
            k = bisect.bisect_left(starts, re_)
            touching = []
            j = k - 1
            while j >= 0 and padded[j][0] > rs - 6.0:
                if padded[j][1] > rs:
                    touching.append(padded[j])
                j -= 1
            touching.sort()
            pieces = [(rs, re_, "run", "run")]
            for ps, pe in touching:
                new = []
                for (x, y, lb, rb) in pieces:
                    if pe <= x or ps >= y:
                        new.append((x, y, lb, rb))
                        continue
                    if ps > x:
                        new.append((x, ps, lb, "word"))
                    if pe < y:
                        new.append((pe, y, "word", rb))
                pieces = new
            for (x, y, lb, rb) in pieces:
                d = y - x
                adjacent = (lb == "word") or (rb == "word")
                if lb == "word" and rb == "word":
                    if d < 0.4:
                        continue                              # continuous with the speech on both sides
                elif adjacent:
                    if d < min_len:
                        continue
                elif d < min_len:
                    if d >= 0.004 and d < 0.10:
                        kind, conf, db = self.classify_click(x, y)
                        if kind and db >= self.floor_db + 12.0:
                            out.append({"s": round(x, 3), "e": round(y, 3), "kind": kind, "c": round(conf, 2),
                                        "db": int(round(db))})
                        continue
                    # 0.10 to 0.12 s: fall through to the normal classifier
                kind, conf, db = self.classify(x, y)
                if not kind:
                    continue
                if db < self.floor_db + (12.0 if adjacent else 9.0) and kind != "click":
                    continue                                   # barely above the background: not worth showing
                if adjacent:
                    conf = max(0.3, conf - 0.15)
                out.append({"s": round(x, 3), "e": round(y, 3), "kind": kind, "c": round(conf, 2), "db": int(round(db))})
        out.sort(key=lambda z: z["s"])
        return out

    def _has_energy(self, t0, t1):
        i0, i1 = self.frame_at(t0), self.frame_at(t1)
        return i1 > i0 and float(np.mean(self.sm[i0:i1 + 1] >= self.thr_hi)) > 0.6

    # -- classification (simple spectral features) --------------------------------------------
    def _features(self, t0, t1):
        a = int(t0 * SR)
        b = int(t1 * SR)
        x = to_float(self.pcm, a, b)
        if len(x) > SR * 2:                      # look at the middle two seconds at most
            mid = len(x) // 2
            x = x[mid - SR:mid + SR]
        if len(x) < 64:
            return None
        rms = float(np.sqrt(np.mean(x * x)) + 1e-9)
        peak = float(np.max(np.abs(x)) + 1e-9)
        w = np.hanning(len(x)).astype(np.float32)
        nfft = 1 << int(np.ceil(np.log2(max(256, len(x)))))
        spec = np.abs(np.fft.rfft(x * w, nfft)) ** 2
        freqs = np.fft.rfftfreq(nfft, 1.0 / SR)
        band = (freqs >= 80) & (freqs <= 7500)
        p = spec[band] + 1e-12
        fb = freqs[band]
        total = float(np.sum(p))
        centroid = float(np.sum(fb * p) / total)
        flat = float(np.exp(np.mean(np.log(p))) / np.mean(p))
        low = float(np.sum(p[fb < 500]) / total)
        # harmonicity: strength of the best periodic match at pitch lags 70-400 Hz
        harm = 0.0
        if len(x) >= 1024:
            frames = []
            step = 320
            for st in range(0, len(x) - 640, step):
                frames.append(x[st:st + 640])
                if len(frames) >= 60:
                    break
            hs = []
            for fr in frames:
                fr = fr - np.mean(fr)
                e0 = float(np.dot(fr, fr)) + 1e-9
                if e0 < 1e-6:
                    continue
                ac = np.correlate(fr, fr, mode="full")[len(fr) - 1:]
                lo, hi = int(SR / 400), int(SR / 70)
                hs.append(float(np.max(ac[lo:hi]) / ac[0]))
            if hs:
                harm = float(np.median(hs))
        db = float(20 * np.log10(rms))
        return {"rms": rms, "peak": peak, "crest": peak / rms, "centroid": centroid, "flat": flat, "low": low,
                "harm": harm, "db": db, "dur": t1 - t0}

    def classify(self, t0, t1):
        f = self._features(t0, t1)
        if f is None:
            return None, 0.0, -100.0
        d = f["dur"]
        # voiced hum such as an unrecognised "mm": periodic and low
        if f["harm"] >= 0.55 and f["low"] >= 0.45 and d >= 0.15:
            return "voiced", min(0.9, 0.5 + f["harm"] * 0.45), f["db"]
        # breath: soft, noise-like, mid/high frequency, about a quarter second to a second and a half
        soft = f["db"] < self.speech_db - 12.0
        if 0.18 <= d <= 1.8 and f["flat"] >= 0.08 and f["low"] < 0.45 and soft and f["harm"] < 0.5:
            return "breath", 0.45 + min(0.35, f["flat"]), f["db"]
        if d < 0.10:
            return self.classify_click(t0, t1)               # under a tenth of a second: a click or smack
        return "noise", 0.5 if f["flat"] > 0.05 else 0.4, f["db"]

    def classify_click(self, t0, t1):
        f = self._features(max(0.0, t0 - 0.003), t1 + 0.003)
        if f is None:
            return None, 0.0, -100.0
        # must stand well above the background to count as a deliberate click
        if f["db"] < self.floor_db + 12.0 and f["peak"] < 0.02:
            return None, 0.0, f["db"]
        if f["crest"] < 2.0:
            return None, 0.0, f["db"]
        return "click", 0.6, f["db"]
