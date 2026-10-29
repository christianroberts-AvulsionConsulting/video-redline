r"""Tests for the transcription helper (fast ones: no speech models, no network).

Run from the tools folder:
    venv\Scripts\python.exe -m unittest discover -s tests -v          (Windows)
    venv/bin/python -m unittest discover -s tests -v                  (Mac)

Every test here was written together with a fix and fails on the code from before that fix (run with
VRT_TOOLS_DIR=<copy of the old code> to see it). All audio is synthetic.
"""
import contextlib
import importlib
import io
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

import _paths
from _paths import REAL, SCRATCH, TOOLS, NO_BASH, find_bash

import numpy as np

import real_tokens


def _import(name):
    return importlib.import_module(name)


def fake_seg(tokens, stamps, start=0.0, end=None, lps=None):
    return types.SimpleNamespace(tokens=tokens, timestamps=stamps, logprobs=lps or [], start=start,
                                 end=end if end is not None else start + 1.0)


def words_of(P, seg, offset=0.0):
    """Parakeet's own token-to-word step (the method does not use `self`)."""
    return P._seg_to_words(None, seg, offset)


# ------------------------------------------------------------------------------------------------
# 2. Numbers glued onto the previous word
# ------------------------------------------------------------------------------------------------
class NumberWordsTests(unittest.TestCase):
    def setUp(self):
        self.E = _import("vrt_engines")

    def test_real_token_sequences_keep_numbers_separate(self):
        for tokens, stamps, expected in real_tokens.REAL_SEQUENCES:
            got = " ".join(w["text"] for w in words_of(self.E.Parakeet, fake_seg(tokens, stamps)))
            self.assertEqual(got, expected)

    def test_number_after_a_word_is_its_own_word_with_its_own_time(self):
        tokens, stamps, _ = real_tokens.REAL_SEQUENCES[1]        # "We had 150 orders in 2024 and 35% growth."
        ws = words_of(self.E.Parakeet, fake_seg(tokens, stamps))
        by = {w["text"]: w for w in ws}
        self.assertIn("150", by)
        self.assertIn("had", by)
        self.assertLessEqual(by["had"]["e"], by["150"]["s"] + 1e-6)          # "had" ends before "150" starts
        # the spoken "150" begins at the bare word-start marker (0.40 s), not at the first digit token (0.64 s)
        self.assertAlmostEqual(by["150"]["s"], 0.40, places=2)
        self.assertAlmostEqual(by["150"]["e"], 1.36, places=2)
        self.assertEqual(by["2024"]["s"], 1.84)

    def test_currency_and_percent(self):
        E = self.E
        ws = words_of(E.Parakeet, fake_seg([" is", " ", "$", "4", "5", ".", "5", "0", " each", ",", " 20", "%", " off"],
                                           [(i * 0.2, 0.16) for i in range(13)]))
        self.assertEqual([w["text"] for w in ws], ["is", "$45.50", "each,", "20%", "off"])

    def test_thousands_separator_and_clock_time_stay_one_word(self):
        E = self.E
        ws = words_of(E.Parakeet, fake_seg([" ", "1", ",", "2", "5", "0", " at", " ", "1", "0", ":", "3", "0"],
                                           [(i * 0.2, 0.16) for i in range(13)]))
        self.assertEqual([w["text"] for w in ws], ["1,250", "at", "10:30"])

    def test_comma_without_space_is_still_split_between_words(self):
        E = self.E
        ws = words_of(E.Parakeet, fake_seg([" all", ",", "er", "m"], [(i * 0.2, 0.16) for i in range(4)]))
        self.assertEqual([w["text"] for w in ws], ["all,", "erm"])

    def test_opening_bracket_after_a_marker_starts_a_word(self):
        E = self.E
        ws = words_of(E.Parakeet, fake_seg([" see", " ", "(", "below", ")", "."], [(i * 0.2, 0.16) for i in range(6)]))
        self.assertEqual([w["text"] for w in ws], ["see", "(below)."])

    def test_a_filler_before_a_number_stays_a_filler(self):
        E, M = self.E, _import("vrt_merge")
        ws = words_of(E.Parakeet, fake_seg([" um", " ", "5", " rows"], [(0.0, 0.2), (0.2, 0.16), (0.4, 0.2), (0.6, 0.2)]))
        self.assertEqual([w["text"] for w in ws], ["um", "5", "rows"])
        self.assertTrue(M.is_filler(M.norm(ws[0]["text"])))

    def test_marker_far_before_the_first_token_does_not_move_the_start(self):
        E = self.E
        ws = words_of(E.Parakeet, fake_seg([" had", " ", "1", "5"], [(0.0, 0.2), (0.3, 0.1), (1.5, 0.2), (1.7, 0.2)]))
        self.assertEqual([w["text"] for w in ws], ["had", "15"])
        self.assertEqual(ws[1]["s"], 1.5)


# ------------------------------------------------------------------------------------------------
# 5. Overlapping speech chunks say the same word twice
# ------------------------------------------------------------------------------------------------
class FakeAdapter:
    def __init__(self, segs):
        self.segs = segs

    def with_timestamps(self):
        return self

    def recognize(self, wav):
        return iter(self.segs)


class FakeAsr:
    def __init__(self, segs):
        self.adapter = FakeAdapter(segs)

    def with_vad(self, vad, **kw):
        return self.adapter


def run_parakeet_on(segs, seconds=25.0):
    E = _import("vrt_engines")
    pk = E.Parakeet.__new__(E.Parakeet)
    pk.asr = FakeAsr(segs)
    pk.vad = object()
    pcm = np.zeros(int(seconds * 16000), np.int16)
    return pk.run(pcm, [(0.0, seconds)]), pk


class OverlappingChunkTests(unittest.TestCase):
    def texts(self, words):
        return [re.sub(r"[^\w']", "", w["text"]).lower() for w in words]

    def test_word_at_the_join_is_kept_once(self):
        # the real case: chunk 1 is 0 - 19.95 s, chunk 2 is 19.65 - 20.21 s, both hear "Excel" at the join
        a = fake_seg([" and", " Excel"], [(19.28, 0.32), (19.60, 0.35)], start=0.0, end=19.95, lps=[-0.02, -0.1])
        b = fake_seg([" Excel", ".", " will"], [(0.0, 0.30), (0.30, 0.08), (0.32, 0.20)], start=19.65, end=20.21,
                     lps=[-0.3, -0.1, -0.05])
        words, pk = run_parakeet_on([a, b])
        self.assertEqual(self.texts(words), ["and", "excel", "will"])
        self.assertEqual(getattr(pk, "duplicates_dropped", None), 1)

    def test_a_genuinely_repeated_word_in_the_overlap_is_not_removed(self):
        a = fake_seg([" no", " no"], [(19.40, 0.12), (19.56, 0.12)], start=0.0, end=20.0)
        b = fake_seg([" no", " no", " more"], [(0.05, 0.12), (0.21, 0.12), (0.45, 0.20)], start=19.35, end=20.2)
        words, _ = run_parakeet_on([a, b])
        self.assertEqual(self.texts(words), ["no", "no", "more"])

    def test_chunks_that_do_not_overlap_are_left_alone(self):
        a = fake_seg([" go", " to"], [(9.6, 0.2), (9.8, 0.2)], start=0.0, end=10.0)
        b = fake_seg([" to", " the"], [(0.0, 0.2), (0.2, 0.2)], start=10.0, end=10.5)
        words, _ = run_parakeet_on([a, b])
        self.assertEqual(self.texts(words), ["go", "to", "to", "the"])

    def test_the_more_complete_copy_wins(self):
        a = fake_seg([" the", " Exc"], [(19.2, 0.3), (19.6, 0.3)], start=0.0, end=19.9)
        b = fake_seg([" Excel", " will"], [(0.0, 0.3), (0.35, 0.2)], start=19.6, end=20.3)
        words, _ = run_parakeet_on([a, b])
        self.assertEqual(self.texts(words), ["the", "excel", "will"])


# ------------------------------------------------------------------------------------------------
# 6. Timestamp gaps and undecodable packets
# ------------------------------------------------------------------------------------------------
class FakeFrame:
    """An already-resampled frame: `n` samples (16 kHz) of the value 1000, to be found again in the output."""

    def __init__(self, time, n):
        self.time = time
        self.n = n

    def to_ndarray(self):
        return np.full((1, self.n), 1000, np.int16)


class FakePacket:
    def __init__(self, frames=None, error=None):
        self.frames, self.error = frames or [], error

    def decode(self):
        if self.error:
            raise self.error
        return self.frames


class FakeContainer:
    def __init__(self, items, duration_s):
        self.items = items
        self.duration = int(duration_s * 1000000)
        self.streams = types.SimpleNamespace(audio=[types.SimpleNamespace(duration=None, time_base=None)], video=[])

    def demux(self, stream):
        for it in self.items:
            if isinstance(it, Exception):
                raise it
            yield it

    def close(self):
        pass


class FakeResampler:
    def __init__(self, **kw):
        pass

    def resample(self, frame):
        return [] if frame is None else [frame]


@contextlib.contextmanager
def fake_av(container):
    mod = types.ModuleType("av")
    mod.open = lambda path: container
    mod.AudioResampler = FakeResampler
    saved = sys.modules.get("av")
    sys.modules["av"] = mod
    try:
        yield
    finally:
        if saved is None:
            sys.modules.pop("av", None)
        else:
            sys.modules["av"] = saved


def frames_between(t0, t1, step_n=371):
    """Back-to-back frames covering media time t0 .. t1 (each step_n samples long)."""
    out, t = [], t0
    dur = step_n / 16000.0
    while t < t1 - 1e-9:
        out.append(FakePacket([FakeFrame(t, step_n)]))
        t += dur
    return out


class DecodeTimestampTests(unittest.TestCase):
    def setUp(self):
        self.A = _import("vrt_audio")
        self.tmp = tempfile.mkdtemp(prefix="dec-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def decode(self, items, duration_s=None):
        raw = os.path.join(self.tmp, "a.raw")
        with fake_av(FakeContainer(items, duration_s if duration_s is not None else 0)):
            info = self.A.decode_to_pcm("fake.mkv", raw)
        x = np.fromfile(raw, dtype="<i2")
        return info, x

    def first_sound_after(self, x, t):
        idx = np.flatnonzero(x[int(t * 16000):] != 0)
        return (idx[0] / 16000.0 + t) if len(idx) else None

    def test_gap_in_the_timestamps_is_filled_with_silence(self):
        items = frames_between(0.0, 10.0) + frames_between(20.0, 30.0)
        info, x = self.decode(items, duration_s=30.0)
        self.assertAlmostEqual(len(x) / 16000.0, 30.0, delta=0.05)
        self.assertAlmostEqual(self.first_sound_after(x, 10.1), 20.0, delta=0.02)    # later audio keeps its media time
        self.assertEqual(len(info["gaps"]), 1)
        self.assertAlmostEqual(info["gaps"][0][1], 10.0, delta=0.05)
        self.assertTrue(any("break" in w and "timing" in w for w in info["warnings"]))

    def test_undecodable_packets_do_not_shift_later_words(self):
        good = frames_between(0.0, 10.0)
        bad = [FakePacket(error=ValueError("invalid data")) for _ in range(5)]      # about 0.12 s lost
        later = frames_between(10.0 + 5 * 371 / 16000.0, 20.0)
        info, x = self.decode(good + bad + later, duration_s=20.0)
        self.assertEqual(info["bad_packets"], 5)
        self.assertAlmostEqual(len(x) / 16000.0, 20.0, delta=0.05)
        self.assertTrue(any("damaged" in w for w in info["warnings"]))

    def test_late_start_is_padded_without_a_warning(self):
        info, x = self.decode(frames_between(2.0, 6.0), duration_s=6.0)
        self.assertAlmostEqual(self.first_sound_after(x, 0.0), 2.0, delta=0.02)
        self.assertEqual(info["gaps"], [])
        self.assertEqual(info["warnings"], [])

    def test_a_small_overlap_is_trimmed(self):
        # 20 ms of rounding noise is ignored, a 0.5 s overlap is cut so that the later audio keeps its media time
        items = frames_between(0.0, 10.0) + frames_between(9.5, 20.0)
        info, x = self.decode(items, duration_s=20.0)
        self.assertAlmostEqual(len(x) / 16000.0, 20.0, delta=0.05)
        self.assertTrue(any("overlaps" in w for w in info["warnings"]))

    def test_a_big_backward_jump_just_carries_on(self):
        items = frames_between(0.0, 10.0) + frames_between(0.0, 10.0)      # two clips joined: time starts again
        info, x = self.decode(items, duration_s=10.0)
        self.assertAlmostEqual(len(x) / 16000.0, 20.0, delta=0.05)
        self.assertTrue(any("jumps" in w for w in info["warnings"]))

    def test_a_huge_forward_jump_does_not_write_hours_of_silence(self):
        items = frames_between(0.0, 10.0) + frames_between(7200.0, 7210.0)
        info, x = self.decode(items, duration_s=10.0)
        self.assertLess(len(x) / 16000.0, 25.0)
        self.assertTrue(any("jumps" in w for w in info["warnings"]))

    def test_a_track_that_starts_hours_late_is_not_padded_with_hours_of_silence(self):
        info, x = self.decode(frames_between(36000.0, 36010.0), duration_s=10.0)
        self.assertAlmostEqual(len(x) / 16000.0, 10.0, delta=0.05)
        self.assertTrue(any("starts very late" in w for w in info["warnings"]))

    def test_frames_without_a_time_are_just_appended(self):
        items = [FakePacket([FakeFrame(None, 1600)]) for _ in range(20)]
        info, x = self.decode(items)
        self.assertEqual(len(x), 32000)

    def test_a_negative_first_time_does_not_crash(self):
        items = [FakePacket([FakeFrame(-0.0213, 371)])] + frames_between(0.00188, 3.0)
        info, x = self.decode(items, duration_s=3.0)
        self.assertAlmostEqual(len(x) / 16000.0, 3.0, delta=0.05)
        self.assertEqual(info["warnings"], [])
        self.assertEqual(int(np.count_nonzero(x[:30])), 30)         # the part of the priming frame after time 0 is kept

    def test_a_damaged_container_keeps_what_was_read(self):
        info, x = self.decode(frames_between(0.0, 10.0) + [ValueError("Invalid data found")], duration_s=20.0)
        self.assertAlmostEqual(len(x) / 16000.0, 10.0, delta=0.05)
        self.assertTrue(any("cut short" in w for w in info["warnings"]))

    def test_undamaged_audio_has_no_warnings(self):
        info, x = self.decode(frames_between(0.0, 10.0), duration_s=10.0)
        self.assertEqual(info["warnings"], [])
        self.assertEqual(info["gaps"], [])


def _burst_pcm(seconds, bursts, sr=44100):
    n = int(seconds * sr)
    x = np.random.default_rng(5).normal(0, 0.01, n).astype(np.float32)      # a little noise so the AAC file is not tiny
    for t in bursts:
        a = int(t * sr)
        b = min(n, a + int(0.3 * sr))
        x[a:b] = 0.5 * np.sin(2 * np.pi * 440 * np.arange(b - a) / sr)
    return (x * 32767).astype(np.int16)


def _write_aac(path, pcm, sr=44100):
    import av
    out = av.open(path, "w", format="ipod")
    st = out.add_stream("aac", rate=sr, layout="mono")
    for i in range(0, len(pcm), 1024):
        fr = av.AudioFrame.from_ndarray(pcm[i:i + 1024].reshape(1, -1), format="s16", layout="mono")
        fr.sample_rate = sr
        fr.pts = i
        for p in st.encode(fr):
            out.mux(p)
    for p in st.encode(None):
        out.mux(p)
    out.close()


def _burst_starts(raw, sr=16000, thr=3000):
    x = np.fromfile(raw, dtype="<i2")
    idx = np.flatnonzero(np.abs(x) > thr)
    starts = [idx[0]] if len(idx) else []
    for a, b in zip(idx[:-1], idx[1:]):
        if b - a > sr // 2:
            starts.append(b)
    return len(x) / float(sr), [round(float(s) / sr, 2) for s in starts]


class DecodeRealFileTests(unittest.TestCase):
    """Real AAC files made with PyAV: a timestamp gap and damaged data (synthetic tones, bursts at known times)."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="aac-", dir=SCRATCH)
        cls.src = os.path.join(cls.dir, "src.m4a")
        _write_aac(cls.src, _burst_pcm(60, [5, 35, 50]))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def decode(self, path):
        A = _import("vrt_audio")
        raw = path + ".raw"
        info = A.decode_to_pcm(path, raw)
        dur, bursts = _burst_starts(raw)
        return info, dur, bursts

    def test_undamaged_file_is_unchanged(self):
        info, dur, bursts = self.decode(self.src)
        self.assertAlmostEqual(dur, 60.0, delta=0.05)
        self.assertEqual(bursts, [5.0, 35.0, 50.0])

    def test_audio_timestamp_gap_keeps_later_words_on_the_media_clock(self):
        import av
        a = av.open(self.src)
        ain = a.streams.audio[0]
        gap = os.path.join(self.dir, "gap.mkv")
        o = av.open(gap, "w")
        aout = o.add_stream_from_template(ain)
        shift = int(10.0 / ain.time_base)                    # everything from 30 s on is 10 s later
        for pkt in a.demux(ain):
            if pkt.dts is None:
                continue
            if float(pkt.pts * ain.time_base) >= 30.0:
                pkt.pts += shift
                pkt.dts += shift
            pkt.stream = aout
            o.mux(pkt)
        o.close()
        a.close()
        info, dur, bursts = self.decode(gap)
        self.assertAlmostEqual(dur, 70.0, delta=0.1)
        self.assertEqual(bursts, [5.0, 45.0, 60.0])           # the bursts that were at 35 s and 50 s are at 45 s and 60 s
        self.assertTrue(info["warnings"])

    def test_damaged_data_does_not_make_later_audio_early(self):
        with open(self.src, "rb") as f:
            data = bytearray(f.read())
        rng = random.Random(7)
        mid = len(data) // 3
        for k in range(6000):
            data[mid + k] = rng.randrange(256)
        bad = os.path.join(self.dir, "bad.m4a")
        with open(bad, "wb") as f:
            f.write(data)
        info, dur, bursts = self.decode(bad)
        self.assertGreater(info["bad_packets"], 0)
        self.assertAlmostEqual(dur, 60.0, delta=0.1)
        self.assertEqual(bursts, [5.0, 35.0, 50.0])
        self.assertTrue(any("damaged" in w for w in info["warnings"]))


# ------------------------------------------------------------------------------------------------
# 11. Words in other scripts
# ------------------------------------------------------------------------------------------------
class NonLatinTests(unittest.TestCase):
    def setUp(self):
        self.M = _import("vrt_merge")

    def test_norm_keeps_words_of_any_script(self):
        for w in ["\u043f\u0440\u0438\u0432\u0435\u0442", "\u041f\u0440\u0438\u0432\u0456\u0442", "\u0397\u03b5\u03b9\u03b1",
                  "\u03b3\u03b5\u03b9\u03b1", "\u65e5\u672c\u8a9e", "\u0928\u092e\u0938\u094d\u0924\u0947", "stra\u00dfe"]:
            self.assertNotEqual(self.M.norm(w), "", w)

    def test_norm_still_cleans_english(self):
        M = self.M
        self.assertEqual(M.norm("Um,"), "um")
        self.assertEqual(M.norm("Mm-hmm."), "mm-hmm")
        self.assertEqual(M.norm("uh-"), "uh")
        self.assertEqual(M.norm("(Excel)"), "excel")
        self.assertEqual(M.norm("$1,250."), "1250")
        self.assertEqual(M.norm("don\u2019t"), "don't")           # typographic apostrophe
        self.assertEqual(M.norm("--"), "")

    def test_fragment_detection_works_for_other_letters_too(self):
        M = self.M
        self.assertTrue(M.is_fragment("s-"))
        self.assertTrue(M.is_fragment("\u043f\u0440-"))
        self.assertFalse(M.is_fragment("well-known"))

    def test_merge_does_not_delete_cyrillic_or_greek_words(self):
        A, M = _import("vrt_audio"), self.M

        class Fake:
            def __init__(self, a):
                self.a = a

            def __len__(self):
                return len(self.a)

            def __getitem__(self, sl):
                a, b, _ = sl.indices(len(self.a))
                return self.a[a:b] if b > a else np.zeros(0, np.int16)

            def close(self):
                pass

        rng = np.random.default_rng(1)
        x = rng.normal(0, 0.002, 16000 * 4)
        x[16000:48000] += 0.2 * np.sin(2 * np.pi * 180 * np.arange(32000) / 16000)
        pcm = Fake(np.clip(x * 32767, -32768, 32767).astype("<i2"))
        env = A.Envelope(pcm, A.compute_db(pcm))
        P = [{"text": "\u041f\u0440\u0438\u0432\u0435\u0442,", "s": 1.0, "e": 1.6, "c": 0.9},
             {"text": "\u03ba\u03cc\u03c3\u03bc\u03b5", "s": 1.7, "e": 2.4, "c": 0.9}]
        out = M.merge(P, [], env, env.plan_blocks(24.0))
        self.assertEqual([w["w"] for w in out.words], ["\u041f\u0440\u0438\u0432\u0435\u0442,", "\u03ba\u03cc\u03c3\u03bc\u03b5"])


# ------------------------------------------------------------------------------------------------
# 4 and 7. A computer without the Visual C++ runtime; a half-downloaded model
# ------------------------------------------------------------------------------------------------
class _BlockImport:
    def __init__(self, name, message):
        self.name, self.message = name, message

    def find_spec(self, fullname, path, target=None):
        if fullname == self.name:
            raise ImportError(self.message)
        return None


@contextlib.contextmanager
def broken_import(name, message):
    saved = {k: sys.modules.pop(k) for k in list(sys.modules) if k == name or k.startswith(name + ".")}
    finder = _BlockImport(name, message)
    sys.meta_path.insert(0, finder)
    try:
        yield
    finally:
        sys.meta_path.remove(finder)
        sys.modules.update(saved)


DLL_MESSAGE = "DLL load failed while importing onnxruntime_pybind11_state: The specified module could not be found."
VC_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe"


@unittest.skipUnless(sys.platform.startswith("win"), "the missing Visual C++ runtime is a Windows problem")
class MissingRuntimeTests(unittest.TestCase):
    def test_parakeet_explains_the_missing_runtime(self):
        E = _import("vrt_engines")
        with broken_import("onnxruntime", DLL_MESSAGE):
            with self.assertRaises(E.EngineProblem) as cm:
                E.Parakeet("v2")
        text = str(cm.exception) + " " + (getattr(cm.exception, "hint", None) or "")
        self.assertIn(VC_URL, text)
        self.assertIn("Visual C++", text)

    def test_whisper_explains_the_missing_runtime(self):
        E = _import("vrt_engines")
        with broken_import("faster_whisper", "DLL load failed while importing ctranslate2: The specified module could not be found."):
            with self.assertRaises(E.EngineProblem) as cm:
                E.Whisper("small.en")
        text = str(cm.exception) + " " + (getattr(cm.exception, "hint", None) or "")
        self.assertIn(VC_URL, text)

    def test_a_plain_import_problem_still_says_run_setup_again(self):
        E = _import("vrt_engines")
        with broken_import("faster_whisper", "No module named 'faster_whisper'"):
            with self.assertRaises(E.EngineProblem) as cm:
                E.Whisper("small.en")
        text = str(cm.exception) + " " + (getattr(cm.exception, "hint", None) or "")
        self.assertIn("setup", text)
        self.assertNotIn(VC_URL, text)

    def test_check_packages_mode_reports_it(self):
        T = _import("transcribe")
        buf = io.StringIO()
        with broken_import("onnxruntime", DLL_MESSAGE), contextlib.redirect_stdout(buf):
            code = T.main(["--check-packages"])
        self.assertEqual(code, 1)
        self.assertIn(VC_URL, buf.getvalue())
        self.assertIn("PROBLEM", buf.getvalue())

    def test_check_packages_passes_on_a_healthy_install(self):
        T = _import("transcribe")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = T.main(["--check-packages"])
        self.assertEqual(code, 0, buf.getvalue())

    def test_a_dll_error_anywhere_in_a_run_gets_the_friendly_message(self):
        T = _import("transcribe")
        buf = io.StringIO()
        err = ImportError("DLL load failed while importing _multiarray_umath: The specified module could not be found.")
        with mock.patch.object(T, "run_pipeline", side_effect=err), mock.patch.object(T, "log_unexpected", return_value=None), \
                contextlib.redirect_stdout(buf):
            code = T.main([os.path.join(SCRATCH, "x.wav")])
        self.assertEqual(code, 1)
        self.assertIn(VC_URL, buf.getvalue())
        self.assertNotIn("Something unexpected", buf.getvalue())


def make_fake_cache(root, repo, files, partial=()):
    """Create <root>/models--a--b/{refs/main, snapshots/<id>/<files>}; sizes in bytes; `partial` names are left out."""
    base = os.path.join(root, "models--" + repo.replace("/", "--"))
    os.makedirs(os.path.join(base, "refs"), exist_ok=True)
    with open(os.path.join(base, "refs", "main"), "w") as f:
        f.write("abc123def456")
    snap = os.path.join(base, "snapshots", "abc123def456")
    os.makedirs(snap, exist_ok=True)
    for name, size in files.items():
        if name in partial:
            continue
        with open(os.path.join(snap, name), "wb") as f:
            f.truncate(size)
    return snap


WHISPER_FILES = {"config.json": 2657, "tokenizer.json": 2128466, "vocabulary.txt": 422309, "model.bin": 21000000}
PARAKEET_FILES = {"config.json": 97, "vocab.txt": 9384, "nemo128.onnx": 139764,
                  "encoder-model.int8.onnx": 110000000, "decoder_joint-model.int8.onnx": 8998286}
SILERO_FILES = {"silero_vad.onnx": 2327524}


class ModelFilesTests(unittest.TestCase):
    def setUp(self):
        self.E = _import("vrt_engines")
        self.root = tempfile.mkdtemp(prefix="hf-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        from huggingface_hub import constants
        p = mock.patch.object(constants, "HF_HUB_CACHE", self.root)
        p.start()
        self.addCleanup(p.stop)

    def fake_whisper_model(self, exc):
        """Stand-in for faster_whisper.WhisperModel: opening the folder fails the way CTranslate2 does."""
        mod = types.ModuleType("faster_whisper")

        def boom(*a, **k):
            raise exc
        mod.WhisperModel = boom
        p = mock.patch.dict(sys.modules, {"faster_whisper": mod})
        p.start()
        self.addCleanup(p.stop)

    def test_a_whisper_model_without_model_bin_is_called_partly_downloaded(self):
        make_fake_cache(self.root, "Systran/faster-whisper-small.en", WHISPER_FILES, partial=("model.bin",))
        self.fake_whisper_model(RuntimeError("Unable to open file 'model.bin' in model 'C:\\x\\snapshots\\abc123def456'"))
        with self.assertRaises(self.E.EngineProblem) as cm:
            self.E.Whisper("small.en")
        text = str(cm.exception) + " " + (getattr(cm.exception, "hint", None) or "")
        self.assertIn("model.bin", text)
        self.assertIn("setup", text)
        self.assertNotIn("Unable to open", text)

    def test_the_raw_ctranslate2_error_alone_is_also_friendly(self):
        # even with the files looking complete (a damaged model.bin), the RuntimeError must not escape as a stack trace
        make_fake_cache(self.root, "Systran/faster-whisper-small.en", WHISPER_FILES)
        self.fake_whisper_model(RuntimeError("Unable to open file 'model.bin' in model 'x'"))
        with self.assertRaises(self.E.EngineProblem):
            self.E.Whisper("small.en")

    def test_model_problems_lists_what_is_missing(self):
        E = self.E
        repo = "Systran/faster-whisper-small.en"
        self.assertEqual(E.model_problems(repo, "whisper"), ["config.json", "tokenizer.json", "vocabulary.txt", "model.bin"])
        make_fake_cache(self.root, repo, WHISPER_FILES, partial=("model.bin",))
        self.assertEqual(E.model_problems(repo, "whisper"), ["model.bin"])
        make_fake_cache(self.root, repo, WHISPER_FILES)
        self.assertEqual(E.model_problems(repo, "whisper"), [])

    def test_a_truncated_file_counts_as_missing(self):
        E = self.E
        repo = "istupakov/parakeet-tdt-0.6b-v2-onnx"
        files = dict(PARAKEET_FILES, **{"encoder-model.int8.onnx": 5000})
        make_fake_cache(self.root, repo, files)
        self.assertEqual(E.model_problems(repo, "parakeet"), ["encoder-model.int8.onnx"])

    def test_vocabulary_json_is_accepted_instead_of_vocabulary_txt(self):
        E = self.E
        repo = "Systran/faster-whisper-large-v3"
        files = {"config.json": 100, "tokenizer.json": 5000, "vocabulary.json": 5000, "model.bin": 21000000}
        make_fake_cache(self.root, repo, files)
        self.assertEqual(E.model_problems(repo, "whisper"), [])

    def download_args(self, *extra):
        T = _import("transcribe")
        return T, T.build_parser().parse_args(["--download-models"] + list(extra))

    def test_download_that_ends_with_a_missing_file_is_reported(self):
        E = self.E
        T, args = self.download_args("--no-parakeet")
        make_fake_cache(self.root, "Systran/faster-whisper-small.en", WHISPER_FILES, partial=("model.bin",))
        with mock.patch.object(E, "download_snapshot", return_value=None), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(T.FriendlyError) as cm:
                T.download_models(args)
        self.assertIn("model.bin", str(cm.exception))

    def test_complete_models_are_not_downloaded_again(self):
        E = self.E
        T, args = self.download_args()
        make_fake_cache(self.root, "istupakov/parakeet-tdt-0.6b-v2-onnx", PARAKEET_FILES)
        make_fake_cache(self.root, "istupakov/silero-vad-onnx", SILERO_FILES)
        make_fake_cache(self.root, "Systran/faster-whisper-small.en", WHISPER_FILES)
        calls = []
        with mock.patch.object(E, "download_snapshot", side_effect=lambda *a, **k: calls.append(a)), \
                contextlib.redirect_stdout(io.StringIO()):
            code = T.download_models(args)
        self.assertEqual(code, 0)
        self.assertEqual(calls, [])

    def test_an_incomplete_model_is_downloaded_again(self):
        E = self.E
        T, args = self.download_args("--no-parakeet")
        make_fake_cache(self.root, "Systran/faster-whisper-small.en", WHISPER_FILES, partial=("model.bin",))
        calls = []

        def fetch(repo, patterns):
            calls.append(repo)
            make_fake_cache(self.root, repo, WHISPER_FILES)

        with mock.patch.object(E, "download_snapshot", side_effect=fetch), contextlib.redirect_stdout(io.StringIO()):
            code = T.download_models(args)
        self.assertEqual(code, 0)
        self.assertEqual(calls, ["Systran/faster-whisper-small.en"])

    # ---- round 3e (item 3): models come from one exact commit, not from whatever the branch head is today ----
    def test_every_model_the_helper_can_download_has_a_full_commit_id(self):
        E = self.E
        repos = {m[1] for m in E.PARAKEET_MODELS.values()} | {E.SILERO_REPO} | set(E.WHISPER_REPOS.values())
        self.assertEqual(sorted(repos), sorted(E.MODEL_REVISIONS))                 # nothing missing, nothing left over
        for repo, rev in E.MODEL_REVISIONS.items():
            self.assertRegex(rev, r"^[0-9a-f]{40}$", repo)

    def fake_hub_download(self, calls, rev):
        """Stand-in for huggingface_hub.snapshot_download that lays out what the real one does for a commit id."""
        def fake(repo, **kw):
            calls.append((repo, kw))
            snap = make_fake_cache(self.root, repo, {"config.json": 5})
            os.replace(snap, os.path.join(os.path.dirname(snap), rev))
            os.remove(os.path.join(self.root, "models--" + repo.replace("/", "--"), "refs", "main"))     # a commit id leaves no ref
            return os.path.join(os.path.dirname(snap), rev)
        return fake

    def test_a_download_asks_for_the_pinned_commit_and_points_main_at_it(self):
        E = self.E
        repo = "Systran/faster-whisper-small.en"
        rev = E.MODEL_REVISIONS[repo]
        calls = []
        with mock.patch("huggingface_hub.snapshot_download", self.fake_hub_download(calls, rev)):
            path = E.download_snapshot(repo, E.WHISPER_FILES)
        self.assertEqual(calls, [(repo, {"revision": rev, "allow_patterns": E.WHISPER_FILES})])
        self.assertEqual(os.path.basename(path), rev)
        # the engines open the model offline by the name "main": the cache answers that from refs/main
        self.assertEqual(E._snapshot_of(repo), rev)

    def test_a_repo_the_person_named_by_hand_is_downloaded_from_main_as_before(self):
        E = self.E
        calls = []
        with mock.patch("huggingface_hub.snapshot_download", lambda repo, **kw: calls.append((repo, kw)) or "x"):
            E.download_snapshot("someone/their-own-model", ["config.json"])
        self.assertEqual(calls, [("someone/their-own-model", {"revision": None, "allow_patterns": ["config.json"]})])

    def test_main_is_not_pointed_at_a_folder_that_is_not_that_commit(self):
        E = self.E
        snap = make_fake_cache(self.root, "Systran/faster-whisper-small.en", {"config.json": 5})      # folder abc123def456
        before = E._snapshot_of("Systran/faster-whisper-small.en")
        self.assertFalse(E._point_main_at(snap, "d1d751a5f8271d482d14ca55d9e2deeebbae577f"))
        self.assertEqual(E._snapshot_of("Systran/faster-whisper-small.en"), before)


# ------------------------------------------------------------------------------------------------
# 3 and 12. Folder moved or copied after setup
# ------------------------------------------------------------------------------------------------
class MovedFolderTests(unittest.TestCase):
    def test_venv_that_points_into_another_tools_folder_is_reported(self):
        env = _import("vrt_env")
        a, b = os.path.join(SCRATCH, "A tools"), os.path.join(SCRATCH, "B tools")
        prefix = os.path.join(b, "venv")
        base = os.path.join(a, "python", "cpython-3.12-windows-x86_64-none")
        problem = env.venv_problem(b, prefix=prefix, base_prefix=base)
        self.assertIsNotNone(problem)
        self.assertIn("moved or copied", problem[0])
        self.assertIn("setup", problem[1])

    def test_venv_that_belongs_to_this_folder_is_fine(self):
        env = _import("vrt_env")
        b = os.path.join(SCRATCH, "B tools")
        self.assertIsNone(env.venv_problem(b, prefix=os.path.join(b, "venv"),
                                           base_prefix=os.path.join(b, "python", "cpython-3.12-windows-x86_64-none")))

    def test_other_pythons_are_left_alone(self):
        env = _import("vrt_env")
        b = os.path.join(SCRATCH, "B tools")
        # not a virtual environment at all
        self.assertIsNone(env.venv_problem(b, prefix=r"C:\Python312", base_prefix=r"C:\Python312"))
        # a developer's own venv somewhere else
        self.assertIsNone(env.venv_problem(b, prefix=os.path.join(SCRATCH, "devenv"), base_prefix=r"C:\Python312"))
        # a venv in this folder made from a system Python
        self.assertIsNone(env.venv_problem(b, prefix=os.path.join(b, "venv"), base_prefix=r"C:\Python312"))

    def test_the_running_python_passes_its_own_check(self):
        env = _import("vrt_env")
        self.assertIsNone(env.venv_problem(REAL))

    def test_check_venv_mode_runs(self):
        T = _import("transcribe")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = T.main(["--check-venv"])
        self.assertEqual(code, 0, buf.getvalue())


# ------------------------------------------------------------------------------------------------
# The scripts as files: line endings, quoting, the environment variables, .gitignore
# ------------------------------------------------------------------------------------------------
def read_bytes(name):
    with open(os.path.join(TOOLS, name), "rb") as f:
        return f.read()


class ScriptFileTests(unittest.TestCase):
    BAT = ["setup-windows.bat", "transcribe-windows.bat"]
    COMMAND = ["setup-mac.command", "transcribe-mac.command"]

    def test_windows_scripts_are_ascii_with_crlf(self):
        for name in self.BAT:
            raw = read_bytes(name)
            raw.decode("ascii")
            self.assertEqual(raw.count(b"\n"), raw.count(b"\r\n"), name + " must use CRLF line endings")

    def test_mac_scripts_are_ascii_with_lf_and_a_shebang(self):
        for name in self.COMMAND:
            raw = read_bytes(name)
            raw.decode("ascii")
            self.assertNotIn(b"\r", raw, name + " must use LF line endings or macOS cannot run it")
            self.assertTrue(raw.startswith(b"#!/bin/bash\n"), name)

    def test_mac_scripts_avoid_things_bash_3_2_does_not_have(self):
        banned = [r"declare\s+-[A-Za-z]*A", r"\bmapfile\b", r"\breadarray\b", r"\$\{[A-Za-z_0-9]+(,,|\^\^|@Q|@E|@P)",
                  r"&>>", r"\|&", r"\bcoproc\b", r";;&", r";&", r"\blocal\s+-n\b", r"\bdeclare\s+-n\b", r"read\s+-t\s+0\.",
                  r"\$\{!?[A-Za-z_0-9]+\[@\]\}", r"=~"]
        for name in self.COMMAND:
            text = read_bytes(name).decode("ascii")
            for line in text.splitlines():
                if line.lstrip().startswith("#"):
                    continue
                for pat in banned:
                    self.assertIsNone(re.search(pat, line), "%s: %r matches %s" % (name, line, pat))

    @unittest.skipUnless(find_bash(), NO_BASH)
    def test_mac_scripts_parse(self):
        for name in self.COMMAND:
            r = subprocess.run([find_bash(), "-n", os.path.join(TOOLS, name)], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, name + ": " + r.stderr)

    def test_all_four_scripts_clear_the_python_environment_variables(self):
        for name in self.BAT:
            text = read_bytes(name).decode("ascii")
            for var in ("PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONUSERBASE"):
                self.assertIn('set "%s="' % var, text, name)
        for name in self.COMMAND:
            text = read_bytes(name).decode("ascii")
            m = re.search(r"^unset\b[^\n]*$", text, re.M)
            self.assertIsNotNone(m, name)
            for var in ("PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONUSERBASE"):
                self.assertIn(var, m.group(0), name)

    def test_the_tools_folder_is_never_echoed_unquoted(self):
        # an unquoted "echo %TOOLS%" breaks on a folder such as "Tom & Jerry" and drops a "^"
        for name in self.BAT:
            for n, line in enumerate(read_bytes(name).decode("ascii").splitlines(), 1):
                if re.match(r"\s*echo\b", line, re.I) and "%TOOLS%" in line:
                    self.assertRegex(line, r'"[^"]*%TOOLS%[^"]*"', "%s line %d: %s" % (name, n, line))

    def test_windows_scripts_check_for_a_zip_and_for_missing_files(self):
        for name in self.BAT:
            text = read_bytes(name).decode("ascii")
            self.assertIn("goto in_zip", text, name)
            self.assertIn("goto not_extracted", text, name)
            self.assertIn("Extract All", text, name)

    def test_gitignore_lists_everything_that_setup_creates(self):
        text = read_bytes(".gitignore").decode("utf-8")
        lines = [l.strip() for l in text.splitlines() if l.strip() and not l.startswith("#")]
        for want in ("python/", "venv/", "uv/", "uv-cache/", "hf-cache/", "tmp/", "dev/", "__pycache__/", "*.pyc",
                     "*-transcript.json"):
            self.assertIn(want, lines)

    def test_gitattributes_keeps_the_line_endings(self):
        text = read_bytes(".gitattributes").decode("utf-8")
        self.assertRegex(text, r"\*\.command\s+text\s+eol=lf")
        self.assertRegex(text, r"\*\.bat\s+text\s+eol=crlf")
        self.assertRegex(text, r"(?m)^\*\.py\s+text\s+eol=lf\s*$")
        self.assertRegex(text, r"(?m)^\*\.pyw\s+text\s+eol=lf\s*$")                  # the hidden start for Windows is a Python file

    def test_gitattributes_lines_are_exactly_these_and_do_not_contradict_each_other(self):
        rules = {}
        for line in read_bytes(".gitattributes").decode("utf-8").splitlines():
            if line.strip() and not line.lstrip().startswith("#"):
                pattern, *attrs = line.split()
                self.assertNotIn(pattern, rules, "two lines for " + pattern)
                rules[pattern] = attrs
        self.assertEqual(rules, {"*.command": ["text", "eol=lf"], "*.bat": ["text", "eol=crlf"], "*.py": ["text", "eol=lf"],
                                 "*.pyw": ["text", "eol=lf"]})
        for name in os.listdir(TOOLS):                                                # what the files in this folder really use
            full = os.path.join(TOOLS, name)
            if os.path.isfile(full) and name.endswith((".command", ".bat", ".py", ".pyw")):
                raw = read_bytes(name)
                crlf = raw.count(b"\r\n")
                if name.endswith(".bat"):
                    self.assertEqual(raw.count(b"\n"), crlf, name + " must be CRLF")
                else:
                    self.assertEqual(crlf, 0, name + " must be LF")


@unittest.skipUnless(find_bash(), NO_BASH)
class MacScriptSmokeTests(unittest.TestCase):
    """The early exits of the Mac scripts, run with whatever bash this computer has (NOT bash 3.2 and NOT a Mac).

    The Mac scripts have never been run on a Mac. These only show that the zip / missing-files / not-set-up-yet paths
    behave, and that nothing is downloaded on the way.
    """

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="mac-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def run_script(self, folder, name, **extra):
        env = dict(os.environ, VRT_NO_PAUSE="1", HTTPS_PROXY="http://127.0.0.1:9", https_proxy="http://127.0.0.1:9",
                   HTTP_PROXY="http://127.0.0.1:9", http_proxy="http://127.0.0.1:9", ALL_PROXY="http://127.0.0.1:9")
        env.update(extra)
        r = subprocess.run([find_bash(), os.path.join(folder, name).replace("\\", "/")], stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, env=env, timeout=120)
        return r.returncode, r.stdout.decode("utf-8", errors="replace")

    def test_setup_from_inside_a_zip_says_to_unpack_first(self):
        folder = os.path.join(self.root, "Video Redline Tool.zip")
        os.makedirs(folder)
        shutil.copy2(os.path.join(TOOLS, "setup-mac.command"), folder)
        code, out = self.run_script(folder, "setup-mac.command")
        self.assertEqual(code, 1, out)
        self.assertIn("zip", out)
        self.assertIn("unpack", out)
        self.assertFalse(os.path.exists(os.path.join(folder, "uv")), "nothing may be downloaded from inside a zip")

    def test_setup_with_the_other_files_missing_says_so(self):
        folder = os.path.join(self.root, "alone")
        os.makedirs(folder)
        shutil.copy2(os.path.join(TOOLS, "setup-mac.command"), folder)
        code, out = self.run_script(folder, "setup-mac.command")
        self.assertEqual(code, 1, out)
        self.assertIn("requirements.txt", out)
        self.assertFalse(os.path.exists(os.path.join(folder, "uv")))

    def test_transcribe_before_setup_says_run_setup(self):
        folder = os.path.join(self.root, "not set up")
        os.makedirs(folder)
        for name in ("transcribe-mac.command", "transcribe.py"):
            shutil.copy2(os.path.join(TOOLS, name), folder)
        code, out = self.run_script(folder, "transcribe-mac.command", PYTHONHOME="/no/such/python")
        self.assertEqual(code, 1, out)
        self.assertIn("setup has not been run", out)

    def test_transcribe_from_inside_a_zip_says_to_unpack_first(self):
        folder = os.path.join(self.root, "tools.zip")
        os.makedirs(folder)
        shutil.copy2(os.path.join(TOOLS, "transcribe-mac.command"), folder)
        code, out = self.run_script(folder, "transcribe-mac.command")
        self.assertEqual(code, 1, out)
        self.assertIn("zip", out)


class LastErrorFileTests(unittest.TestCase):
    def test_the_file_people_are_asked_to_send_holds_no_file_names(self):
        """Round 9 (S3). logs/last-error.txt used to hold the whole command line, so a drag-and-drop run wrote the person's own folder and video
        name into a file that people are asked to send. Now only the options (words that start with --) are written."""
        T = _import("transcribe")
        folder = tempfile.mkdtemp(prefix="le-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        argv = ["transcribe.py", r"C:\Users\pat\Videos\holiday.mp4", "--no-whisper", "--out", r"C:\Users\pat\out.json"]
        try:
            raise RuntimeError("boom")
        except RuntimeError as exc:
            with mock.patch.object(T, "TOOLS_DIR", folder), mock.patch.object(sys, "argv", argv):
                path = T.log_unexpected(exc)
        self.assertTrue(path and os.path.isfile(path), path)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        for gone in ("pat", "holiday", "Videos", "out.json"):
            self.assertNotIn(gone, text)
        self.assertIn("Options: ['--no-whisper', '--out'] (and 2 other argument(s), not written here)", text)
        self.assertIn("RuntimeError: boom", text)                       # the traceback is still there


class PageModulePathTests(unittest.TestCase):
    """Round 3e (item 15a). The page modules lie next to the tools folder in the author's working copy and in src/vendor/ in the repository."""

    def test_module_file_looks_in_both_places(self):
        root = tempfile.mkdtemp(prefix="mf-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        tools = os.path.join(root, "tools")
        os.makedirs(tools)
        with mock.patch.object(_paths, "REAL", tools):
            self.assertIsNone(_paths.module_file("cleanup-panel.js"))
            os.makedirs(os.path.join(root, "src", "vendor"))
            vendor = os.path.join(root, "src", "vendor", "cleanup-panel.js")
            open(vendor, "w").close()
            self.assertEqual(_paths.module_file("cleanup-panel.js"), os.path.abspath(vendor))          # the repository layout
            nextto = os.path.join(root, "cleanup-panel.js")
            open(nextto, "w").close()
            self.assertEqual(_paths.module_file("cleanup-panel.js"), os.path.abspath(nextto))          # the working copy wins
            self.assertIsNone(_paths.module_file("transcriber-client.js"))


class SelfTestNoteTests(unittest.TestCase):
    """Round 3e (item 11). setup-windows.bat asks a person whose self-test failed to send logs\\last-error.txt: that file has to exist."""

    def test_a_failed_self_test_writes_the_note_that_setup_asks_for(self):
        T = _import("transcribe")
        folder = tempfile.mkdtemp(prefix="st-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        empty = {"doc": {"format": "video-review-transcript", "version": 1, "video": {}, "engines": [], "words": [], "silences": [],
                         "sounds": []}, "elapsed": 1.0}
        out = io.StringIO()

        def fake_pipeline(a):
            import json
            with open(a.out, "w", encoding="utf-8") as f:
                json.dump(empty["doc"], f)
            return empty

        with mock.patch.object(T, "TOOLS_DIR", folder), mock.patch("vrt_env.venv_problem", return_value=None), \
                mock.patch.object(T, "run_pipeline", side_effect=fake_pipeline), contextlib.redirect_stdout(out):
            code = T.main(["--self-test"])
        self.assertNotEqual(code, 0)
        self.assertIn("PROBLEM: The self-test did not pass: the quiet gap was not found; the hum / click / noise were not found.", out.getvalue())
        note = os.path.join(folder, "logs", "last-error.txt")
        self.assertTrue(os.path.isfile(note), out.getvalue())
        self.assertIn("A technical note was saved here: " + note, out.getvalue())
        with open(note, encoding="utf-8") as f:
            self.assertIn("The self-test did not pass", f.read())

    def test_a_problem_that_is_not_a_self_test_writes_no_note(self):
        T = _import("transcribe")
        folder = tempfile.mkdtemp(prefix="st-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        with mock.patch.object(T, "TOOLS_DIR", folder), mock.patch("vrt_env.venv_problem", return_value=("The private Python is wrong.", "Run setup.")), \
                contextlib.redirect_stdout(io.StringIO()):
            T.main(["--check-venv"])
        self.assertFalse(os.path.exists(os.path.join(folder, "logs", "last-error.txt")))


class TelemetryTests(unittest.TestCase):
    """Round 3e (item 1). The onnxruntime that is installed says in its own Privacy.md that its official builds send usage events
    to Microsoft unless ORT_DISABLE_TELEMETRY=1 is set before it starts (and the Python call disable_telemetry_events() is made).
    The helper promises that nothing leaves the computer, so it does both everywhere onnxruntime can start."""

    def test_the_helpers_child_processes_get_it_even_if_the_person_had_set_it_to_0(self):
        V = _import("vrt_server")
        with mock.patch.dict(os.environ, {"ORT_DISABLE_TELEMETRY": "0"}):
            self.assertEqual(V.child_env()["ORT_DISABLE_TELEMETRY"], "1")

    def test_transcribe_py_sets_it_when_it_is_imported_before_anything_else_loads(self):
        code = ("import sys, os; sys.path.insert(0, sys.argv[1]); import transcribe; "
                "print('ORT=' + os.environ.get('ORT_DISABLE_TELEMETRY', 'unset') + ' loaded=' + str('onnxruntime' in sys.modules))")
        r = subprocess.run([sys.executable, "-I", "-c", code, TOOLS], stdin=subprocess.DEVNULL, capture_output=True,
                           text=True, timeout=120, env=dict(os.environ, ORT_DISABLE_TELEMETRY="0"))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("ORT=1 loaded=False", r.stdout)

    class RecordOnImport(object):
        """A meta_path finder that makes a stand-in for the named modules when they are first imported, and writes down what
        ORT_DISABLE_TELEMETRY said at that very moment (a module that is already in sys.modules would never show it)."""

        def __init__(self, makers):
            self.makers = makers
            self.seen = {}

        def find_spec(self, name, path=None, target=None):
            if name in self.makers:
                import importlib.util
                return importlib.util.spec_from_loader(name, self)
            return None

        def create_module(self, spec):
            self.seen[spec.name] = os.environ.get("ORT_DISABLE_TELEMETRY")
            return self.makers[spec.name]()

        def exec_module(self, module):
            pass

    @contextlib.contextmanager
    def import_recording(self, makers):
        names = set(makers) | {"onnx_asr", "faster_whisper"}
        saved = {k: sys.modules.pop(k) for k in list(sys.modules) if k.split(".")[0] in names}
        finder = self.RecordOnImport(makers)
        sys.meta_path.insert(0, finder)
        try:
            yield finder
        finally:
            sys.meta_path.remove(finder)
            for k in [k for k in sys.modules if k.split(".")[0] in names]:
                del sys.modules[k]
            sys.modules.update(saved)

    def fake_runtime(self, calls, fails=None):
        rt = types.ModuleType("onnxruntime")
        rt.SessionOptions = type("SessionOptions", (), {})

        def disable_telemetry_events():
            calls.append(os.environ.get("ORT_DISABLE_TELEMETRY"))
            if fails:
                raise fails
        rt.disable_telemetry_events = disable_telemetry_events
        asr = types.ModuleType("onnx_asr")
        asr.load_model = lambda *a, **k: types.SimpleNamespace(asr=types.SimpleNamespace())
        asr.load_vad = lambda *a, **k: object()
        return {"onnxruntime": rt, "onnx_asr": asr}

    def test_parakeet_sets_the_variable_before_it_imports_onnxruntime_and_then_calls_disable_telemetry_events(self):
        E = _import("vrt_engines")
        calls = []
        modules = self.fake_runtime(calls)
        with self.import_recording({name: (lambda m=m: m) for name, m in modules.items()}) as rec, \
                mock.patch.object(E, "require_model", lambda *a, **k: None), mock.patch.dict(os.environ, {"ORT_DISABLE_TELEMETRY": "0"}):
            E.Parakeet("v2")
        self.assertEqual(rec.seen["onnxruntime"], "1")                               # already 1 when onnxruntime was imported
        self.assertEqual(calls, ["1"])                                               # called once

    def test_check_packages_asks_onnxruntime_to_hold_back_too(self):
        """transcribe.py --check-packages runs at every helper start and imports onnxruntime as well."""
        import vrt_env
        with mock.patch.object(vrt_env, "switch_off_ort_telemetry") as switch, mock.patch.dict(os.environ, {"ORT_DISABLE_TELEMETRY": "0"}):
            problem = vrt_env.check_packages()
            self.assertEqual(os.environ["ORT_DISABLE_TELEMETRY"], "1")
        self.assertIsNone(problem)
        switch.assert_called_once()
        self.assertEqual(switch.call_args[0][0].__name__, "onnxruntime")
        self.assertIs(_import("vrt_engines").switch_off_ort_telemetry, vrt_env.switch_off_ort_telemetry)

    def test_a_failing_or_missing_disable_call_never_stops_the_engine(self):
        E = _import("vrt_engines")
        for fails in (RuntimeError("no such thing"), AttributeError("old onnxruntime")):
            calls = []
            with mock.patch.dict(sys.modules, self.fake_runtime(calls, fails)), \
                    mock.patch.object(E, "require_model", lambda *a, **k: None):
                p = E.Parakeet("v2")
            self.assertEqual(calls, ["1"])
            self.assertTrue(hasattr(p, "asr"))
        modules = self.fake_runtime([])
        del modules["onnxruntime"].disable_telemetry_events                  # a build that has no such function at all
        with mock.patch.dict(sys.modules, modules), mock.patch.object(E, "require_model", lambda *a, **k: None):
            self.assertTrue(hasattr(E.Parakeet("v2"), "asr"))

    def test_whisper_sets_the_variable_before_faster_whisper_can_load_onnxruntime(self):
        E = _import("vrt_engines")
        seen = []
        fw = types.ModuleType("faster_whisper")

        def whisper_model(*a, **k):
            seen.append(os.environ.get("ORT_DISABLE_TELEMETRY"))
            return object()
        fw.WhisperModel = whisper_model
        with self.import_recording({"faster_whisper": lambda: fw}) as rec, mock.patch.object(E, "require_model", lambda *a, **k: None), \
                mock.patch.dict(os.environ, {"ORT_DISABLE_TELEMETRY": "0"}):
            E.Whisper("small.en")
        self.assertEqual(rec.seen["faster_whisper"], "1")                            # set before faster-whisper (and so onnxruntime) can load
        self.assertEqual(seen, ["1"])

    def test_the_real_onnxruntime_takes_the_call(self):
        E = _import("vrt_engines")
        try:
            import onnxruntime as rt
        except Exception as exc:
            self.skipTest("onnxruntime is not installed here: %s" % exc)
        self.assertTrue(E.switch_off_ort_telemetry(rt))
        self.assertFalse(E.switch_off_ort_telemetry())                         # without the module only the variable is set


if __name__ == "__main__":
    unittest.main()
