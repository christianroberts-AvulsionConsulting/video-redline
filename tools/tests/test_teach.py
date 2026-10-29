r"""Tests for "Teach it your ums": the fingerprint, the trainer, the store, the helper's /teach endpoints, and the page's engine
(cleanup.js) using the trained model.

Run from the tools folder:
    venv\Scripts\python.exe -m unittest discover -s tests -p "test_teach.py" -v          (Windows)
    venv/bin/python -m unittest discover -s tests -p "test_teach.py" -v                  (Mac)

Fast: no speech models, no network. Everything the tests hear is MADE UP (a buzz shaped like a vowel for an "um", noise sweeps,
pops and bells for sound effects), so a pass proves that the code paths work and that the maths of Python and JavaScript agree. It says
nothing about how well it tells YOUR ums from YOUR sound effects: that needs your own recordings.
The page engine tests need Node.js and are skipped without it.
"""
import http.client
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import wave
from unittest import mock

import numpy as np

import _paths
from _paths import REAL, SCRATCH, module_file

SR = 16000


def _import(name):
    return importlib.import_module(name)


# ---- made-up sounds -----------------------------------------------------------------------------------------------------------
def _resonate(x, f, bw):
    r = np.exp(-np.pi * bw / SR)
    a1, a2 = -2 * r * np.cos(2 * np.pi * f / SR), r * r
    y = np.zeros_like(x)
    for i in range(len(x)):
        y[i] = x[i] - a1 * (y[i - 1] if i > 0 else 0) - a2 * (y[i - 2] if i > 1 else 0)
    return y


def _env(n, attack=0.08, release=0.15):
    t = np.arange(n) / SR
    return np.clip(np.minimum(1, t / attack) * np.minimum(1, (n / SR - t) / release), 0, 1)


def make_um(rng):
    n = int(rng.uniform(0.3, 0.9) * SR)
    t = np.arange(n) / SR
    f0 = rng.uniform(95, 150) * (1 + 0.03 * np.sin(2 * np.pi * rng.uniform(3, 6) * t))
    ph = 2 * np.pi * np.cumsum(f0) / SR
    src = sum(np.sin(k * ph) / k for k in range(1, 25))
    y = (_resonate(src, rng.uniform(450, 650), 90) + 0.5 * _resonate(src, rng.uniform(1100, 1700), 110)
         + 0.25 * _resonate(src, rng.uniform(2300, 2800), 150))
    return y / np.max(np.abs(y)) * _env(n) * rng.uniform(0.1, 0.5)


def make_whoosh(rng):
    n = int(rng.uniform(0.3, 1.0) * SR)
    x = rng.normal(0, 1, n)
    out = np.zeros(n)
    c0, c1 = rng.uniform(200, 800), rng.uniform(2500, 6000)
    for s in range(0, n, 1024):
        seg = x[s:s + 2048]
        if len(seg) < 64:
            break
        c = c0 + (c1 - c0) * s / n
        S = np.fft.rfft(seg * np.hanning(len(seg)))
        S *= np.exp(-0.5 * ((np.fft.rfftfreq(len(seg), 1 / SR) - c) / (0.35 * c + 100)) ** 2)
        out[s:s + len(seg)] += np.fft.irfft(S, len(seg))
    return out / np.max(np.abs(out)) * _env(n, n / SR * 0.5, n / SR * 0.4) * rng.uniform(0.1, 0.5)


def make_pop(rng):
    n = int(rng.uniform(0.12, 0.22) * SR)
    y = rng.normal(0, 1, n) * np.exp(-np.arange(n) / SR * rng.uniform(25, 45))
    return y / np.max(np.abs(y)) * rng.uniform(0.2, 0.6)


def make_bell(rng):
    n = int(rng.uniform(0.4, 1.0) * SR)
    t = np.arange(n) / SR
    base = rng.uniform(400, 1200)
    y = sum(a * np.sin(2 * np.pi * base * r * t) * np.exp(-t * d) for a, r, d in [(1, 1, 4), (.6, 2.76, 6), (.4, 5.4, 9), (.3, 8.93, 12)])
    return y / np.max(np.abs(y)) * rng.uniform(0.1, 0.5)


def room(y, rng, db=-52):
    z = np.concatenate([np.zeros(1600), y, np.zeros(1600)])
    return (z + rng.normal(0, 10 ** (db / 20), len(z))).astype(np.float32)


def sounds(kinds, n, seed):
    rng = np.random.default_rng(seed)
    return [room(kinds[i % len(kinds)](rng), rng) for i in range(n)]


UMS = [make_um]
SFX = [make_whoosh, make_pop, make_bell]


def write_clip(path, pieces, gap=1.0, seed=5):
    """A recording: the pieces one after another with `gap` seconds of room tone between them."""
    rng = np.random.default_rng(seed)
    gap_n = int(gap * SR)
    parts = [rng.normal(0, 0.0015, gap_n)]
    for p in pieces:
        parts.append(p)
        parts.append(rng.normal(0, 0.0015, gap_n))
    x = np.clip(np.concatenate(parts), -1, 1)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((x * 32767).astype("<i2").tobytes())


class TeachBase(unittest.TestCase):
    """Every test gets a teach folder of its own."""

    def setUp(self):
        self.T = _import("vrt_teach")
        self.dir = tempfile.mkdtemp(prefix="teach-", dir=SCRATCH)
        self.patches = [mock.patch.object(self.T, "TEACH_DIR", self.dir),
                        mock.patch.object(self.T, "SOURCES_DIR", os.path.join(self.dir, "sources")),
                        mock.patch.object(self.T, "MODEL_PATH", os.path.join(self.dir, "model.json")),
                        mock.patch.object(self.T, "SUMMARY_PATH", os.path.join(self.dir, "summary.json"))]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.dir, ignore_errors=True)

    def fps(self, kinds, n, seed):
        return [self.T.fingerprint(x) for x in sounds(kinds, n, seed)]


class FingerprintTests(TeachBase):
    def test_it_has_the_promised_number_of_numbers(self):
        fp = self.fps(UMS, 1, 1)[0]
        self.assertEqual(len(fp), self.T.N_FEATURES)
        self.assertEqual(len(self.T.FEATURE_NAMES), self.T.N_FEATURES)
        self.assertTrue(all(np.isfinite(fp)))

    def test_loudness_does_not_change_it(self):
        x = sounds(UMS, 1, 2)[0]
        a, b = self.T.fingerprint(x), self.T.fingerprint(x * 0.1)
        self.assertLess(float(np.max(np.abs(np.asarray(a) - np.asarray(b)))), 0.05)

    def test_too_short_or_silent_gives_nothing(self):
        self.assertIsNone(self.T.fingerprint(np.zeros(8000)))
        self.assertIsNone(self.T.fingerprint(np.ones(300) * 0.1))

    def test_an_um_and_a_sound_effect_differ(self):
        ums, sfx = np.asarray(self.fps(UMS, 20, 3)), np.asarray(self.fps(SFX, 20, 4))
        spread = np.abs(ums.mean(axis=0) - sfx.mean(axis=0)) / (ums.std(axis=0) + sfx.std(axis=0) + 1e-6)
        self.assertGreater(int((spread > 1.0).sum()), 8)


class TrainingTests(TeachBase):
    def test_too_few_ums_make_no_model(self):
        self.assertIsNone(self.T.train(self.fps(UMS, self.T.MIN_UMS - 1, 5), self.fps(SFX, 30, 6)))

    def test_with_both_kinds_it_tells_unseen_sounds_apart(self):
        m = self.T.train(self.fps(UMS, 40, 7), self.fps(SFX, 40, 8))
        self.assertEqual(m["kind"], "two-class")
        um = [self.T.score(m, f) for f in self.fps(UMS, 30, 17)]
        fx = [self.T.score(m, f) for f in self.fps(SFX, 30, 18)]
        self.assertGreaterEqual(np.mean(np.asarray(um) >= 0.5), 0.9)
        self.assertGreaterEqual(np.mean(np.asarray(fx) < 0.5), 0.9)
        self.assertGreater(m["check"]["recall"], 0.8)
        self.assertGreater(m["check"]["rejects"], 0.8)

    def test_with_only_ums_it_still_holds_back_very_different_sounds(self):
        m = self.T.train(self.fps(UMS, 40, 9), [])
        self.assertEqual(m["kind"], "one-class")
        um = [self.T.score(m, f) for f in self.fps(UMS, 30, 19)]
        fx = [self.T.score(m, f) for f in self.fps(SFX, 30, 20)]
        self.assertGreaterEqual(np.mean(np.asarray(um) >= 0.5), 0.7)
        self.assertGreaterEqual(np.mean(np.asarray(fx) < 0.5), 0.9)

    def test_a_few_not_ums_are_not_enough_for_two_classes(self):
        m = self.T.train(self.fps(UMS, 30, 10), self.fps(SFX, self.T.MIN_EACH - 1, 11))
        self.assertEqual(m["kind"], "one-class")

    def test_a_model_for_another_number_of_features_scores_nothing(self):
        m = self.T.train(self.fps(UMS, 20, 12), self.fps(SFX, 20, 13))
        self.assertIsNone(self.T.score(m, [0.0] * 5))

    def test_a_cough_in_a_recording_of_ums_is_left_out(self):
        rng = np.random.default_rng(14)
        fps = self.fps(UMS, 30, 14)
        odd = self.T.fingerprint(room(make_pop(rng) * 3, rng))
        kept, dropped = self.T.drop_outliers(fps + [odd])
        self.assertEqual(dropped, 1)
        self.assertEqual(len(kept), 30)


class StoreTests(TeachBase):
    def test_a_recording_is_stored_and_trains(self):
        s = self.T.add_clip("um", "my ums.wav", self.fps(UMS, 30, 21), 2, "aaaa")
        self.assertTrue(s["ready"])
        self.assertEqual(s["ums"], 30)
        self.assertEqual(s["clips"][0]["name"], "my ums.wav")
        self.assertEqual(s["clips"][0]["ignored"], 2)
        self.assertTrue(os.path.isfile(self.T.MODEL_PATH))
        again = self.T.add_clip("um", "my ums.wav", self.fps(UMS, 30, 21), 2, "aaaa")      # the same recording again replaces itself
        self.assertEqual(again["ums"], 30)

    def test_video_choices_replace_the_earlier_ones_of_that_video(self):
        self.T.add_clip("um", "ums.wav", self.fps(UMS, 30, 22), 0, "bbbb")
        ex = [{"label": "um", "fp": f} for f in self.fps(UMS, 3, 23)] + [{"label": "notum", "fp": f} for f in self.fps(SFX, 2, 24)]
        s = self.T.sync_video("a video|12.000", ex)
        self.assertEqual(s["decisions"], {"ums": 3, "notums": 2})
        s = self.T.sync_video("a video|12.000", ex[:1])                       # undo: only one choice is left
        self.assertEqual(s["decisions"], {"ums": 1, "notums": 0})
        s = self.T.sync_video("a video|12.000", [])                          # all undone: the video leaves the store
        self.assertEqual(s["decisions"], {"ums": 0, "notums": 0})

    def test_bad_examples_are_ignored(self):
        s = self.T.sync_video("v|1.000", [{"label": "um", "fp": [1, 2]}, {"label": "cat", "fp": [0.0] * self.T.N_FEATURES},
                                          {"label": "um", "fp": [float("nan")] * self.T.N_FEATURES}, "junk", None])
        self.assertEqual(s["decisions"], {"ums": 0, "notums": 0})

    def test_forgetting(self):
        self.T.add_clip("um", "ums.wav", self.fps(UMS, 30, 25), 0, "cccc")
        self.T.add_clip("notum", "fx.wav", self.fps(SFX, 30, 26), 0, "dddd")
        self.T.sync_video("v|1.000", [{"label": "um", "fp": f} for f in self.fps(UMS, 2, 27)])
        s = self.T.forget("clip:dddd")
        self.assertEqual([c["id"] for c in s["clips"]], ["cccc"])
        self.assertEqual(s["kind"], "one-class")
        s = self.T.forget("decisions")
        self.assertEqual(s["decisions"], {"ums": 0, "notums": 0})
        self.assertEqual(len(s["clips"]), 1)
        s = self.T.forget("clips")
        self.assertEqual(s["clips"], [])
        self.assertFalse(s["ready"])
        self.assertFalse(os.path.exists(self.T.MODEL_PATH))
        self.T.add_clip("um", "ums.wav", self.fps(UMS, 30, 25), 0, "cccc")
        self.assertEqual(self.T.forget("all")["ums"], 0)

    def test_the_clip_finder_splits_a_recording_at_the_gaps(self):
        import vrt_audio as A
        path = os.path.join(self.dir, "clip.wav")
        rng = np.random.default_rng(31)
        write_clip(path, [make_um(rng) for _ in range(12)], gap=1.0)
        raw = os.path.join(self.dir, "clip.raw")
        A.decode_to_pcm(path, raw)
        pcm = A.open_pcm(raw)
        try:
            env = A.Envelope(pcm, A.compute_db(pcm))
            spans = self.T.clip_sounds(env)
        finally:
            pcm.close()
        self.assertEqual(len(spans), 12)

    def test_um_like_words_get_a_fingerprint_and_ordinary_words_do_not(self):
        for w in ("um", "uh", "erm", "hmm", "ummmm", "uhhh"):
            self.assertTrue(self.T.wants_fingerprint(w), w)
        for w in ("hello", "like", "and", "mother"):
            self.assertFalse(self.T.wants_fingerprint(w), w)


@unittest.skipUnless(module_file("cleanup.js"), "cleanup.js not found")
class PageEngineTests(TeachBase):
    """cleanup.js is run with Node: the model must give the same number there as in Python, and a sound that does not look like the
    person's ums must lose its automatic cut."""

    @classmethod
    def setUpClass(cls):
        cls.node = shutil.which("node")

    def run_node(self, source):
        if not self.node:
            self.skipTest("Node.js is not installed")
        path = os.path.join(SCRATCH, "teach-node-%d.js" % os.getpid())
        with open(path, "w", encoding="utf-8") as f:
            f.write("const Cleanup = require(%s);\n%s" % (json.dumps(module_file("cleanup.js")), source))
        r = subprocess.run([self.node, path], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr.decode("utf-8", "replace"))
        return json.loads(r.stdout.decode("utf-8"))

    def test_javascript_scores_exactly_like_python(self):
        for kind, pos, neg in (("two", self.fps(UMS, 30, 41), self.fps(SFX, 30, 42)), ("one", self.fps(UMS, 30, 43), [])):
            m = self.T.train(pos, neg)
            probe = self.fps(UMS, 6, 44) + self.fps(SFX, 6, 45)
            want = [self.T.score(m, f) for f in probe]
            got = self.run_node("const m=%s, ps=%s; console.log(JSON.stringify(ps.map(p=>Cleanup.scoreFingerprint(m,p))));"
                                % (json.dumps(m), json.dumps(probe)))
            for a, b in zip(want, got):
                self.assertAlmostEqual(a, b, places=6, msg=kind)

    def test_a_sound_effect_that_was_heard_as_an_um_waits_for_a_decision(self):
        m = self.T.train(self.fps(UMS, 30, 51), self.fps(SFX, 30, 52))
        um_fp, fx_fp = self.fps(UMS, 1, 53)[0], self.fps(SFX, 1, 54)[0]

        def transcript(fp):
            words = [{"w": "Hello", "s": 0.0, "e": 0.4, "c": 0.9, "src": "both"},
                     {"w": "um", "s": 1.0, "e": 1.5, "c": 0.97, "src": "both", "fp": fp},
                     {"w": "world", "s": 2.2, "e": 2.6, "c": 0.9, "src": "both"}]
            return {"format": "video-review-transcript", "version": 1, "video": {"name": "t.mp4", "duration": 3.0},
                    "words": words, "silences": [], "sounds": [{"s": 1.0, "e": 1.5, "kind": "voiced", "c": 0.9, "db": -20}]}

        out = self.run_node(
            "const run=(tr,learned)=>Cleanup.analyze(tr,{level:'balanced',learned}).candidates.filter(c=>c.kind==='filler')[0];"
            "const um=%s, fx=%s, m=%s;"
            "const plain=run(um,null), withUm=run(um,m), withFx=run(fx,m), noModel=run(fx,null);"
            "console.log(JSON.stringify({plain:plain.status,withUm:withUm.status,withFx:withFx.status,noModel:noModel.status,"
            "fxReason:withFx.reason,fxMine:withFx.mine,umConf:[plain.confidence,withUm.confidence],fxConf:[noModel.confidence,withFx.confidence]}));"
            % (json.dumps(transcript(um_fp)), json.dumps(transcript(fx_fp)), json.dumps(m)))
        self.assertEqual(out["plain"], "auto")
        self.assertEqual(out["withUm"], "auto", "a sound that looks like the person's ums keeps its automatic cut")
        self.assertEqual(out["noModel"], "auto", "without the model nothing changes")
        self.assertEqual(out["withFx"], "review", "a sound effect now waits for a decision")
        self.assertIn("taught", out["fxReason"])
        self.assertLess(out["fxMine"], 0.5)
        self.assertLess(out["fxConf"][1], out["fxConf"][0])
        self.assertAlmostEqual(out["umConf"][0], out["umConf"][1], places=6)

    def test_a_loaded_transcript_keeps_the_fingerprints_and_drops_bad_ones(self):
        fp = self.fps(UMS, 1, 59)[0]
        out = self.run_node(
            "const tr={format:'video-review-transcript',version:1,video:{name:'t.mp4',duration:5},"
            "words:[{w:'um',s:1,e:1.5,c:0.9,src:'both',fp:%s},{w:'uh',s:2,e:2.5,c:0.9,src:'both',fp:['x',1]},{w:'ok',s:3,e:3.5,c:0.9,src:'both'}],silences:[],sounds:[]};"
            "const p=Cleanup.parseTranscript(JSON.stringify(tr));console.log(JSON.stringify(p.transcript.words.map(w=>w.fp||null)));" % json.dumps(fp))
        self.assertEqual(out, [fp, None, None])

    def test_the_model_can_only_hold_a_cut_back(self):
        m = self.T.train(self.fps(UMS, 30, 55), self.fps(SFX, 30, 56))
        fx_fp = self.fps(SFX, 1, 57)[0]
        words = [{"w": "um", "s": 1.0, "e": 1.5, "c": 0.5, "src": "parakeet", "fp": self.fps(UMS, 1, 58)[0]}]
        tr = {"format": "video-review-transcript", "version": 1, "video": {"name": "t.mp4", "duration": 3.0}, "words": words,
              "silences": [], "sounds": []}
        out = self.run_node("const tr=%s,m=%s;const a=Cleanup.analyze(tr,{level:'balanced'}).candidates[0], b=Cleanup.analyze(tr,{level:'balanced',learned:m}).candidates[0];"
                            "console.log(JSON.stringify([a.confidence,b.confidence]));" % (json.dumps(tr), json.dumps(m)))
        self.assertAlmostEqual(out[0], out[1], places=6)


class EndpointTests(unittest.TestCase):
    """The helper's /teach endpoints, on a spare port, with a teach folder of its own."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="teach-http-", dir=SCRATCH)
        cls.env = mock.patch.dict(os.environ, {"VRT_TEACH_DIR": cls.dir})
        cls.env.start()
        cls.V = _import("vrt_server")
        cls.patches = [mock.patch.object(cls.V, "TEACH_DIR", cls.dir), mock.patch.object(cls.V, "EXTRA_ORIGINS", set())]
        for p in cls.patches:
            p.start()
        cls.server = cls.V.HelperServer(("127.0.0.1", 0), cls.V.Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        for p in cls.patches:
            p.stop()
        cls.env.stop()
        shutil.rmtree(cls.dir, ignore_errors=True)

    def ask(self, method, path, body=None, origin="null"):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        try:
            data = None if body is None else json.dumps(body).encode("utf-8")
            headers = {"Origin": origin}
            if data is not None:
                headers["Content-Type"] = "application/json"
            c.request(method, path, body=data, headers=headers)
            r = c.getresponse()
            return r.status, json.loads(r.read().decode("utf-8") or "null"), dict((k.lower(), v) for k, v in r.getheaders())
        finally:
            c.close()

    def test_an_empty_helper_says_so(self):
        st, d, h = self.ask("GET", "/teach")
        self.assertEqual(st, 200)
        self.assertFalse(d["ready"])
        self.assertEqual(h.get("access-control-allow-origin"), "null")
        st, d, _ = self.ask("GET", "/teach/model")
        self.assertEqual((st, d["model"]), (200, None))

    def test_choices_are_stored_trained_and_forgotten_over_http(self):
        T = _import("vrt_teach")
        ums = [T.fingerprint(x) for x in sounds(UMS, 14, 61)]
        fx = [T.fingerprint(x) for x in sounds(SFX, 14, 62)]
        ex = [{"label": "um", "fp": f} for f in ums] + [{"label": "notum", "fp": f} for f in fx]
        st, d, _ = self.ask("POST", "/teach/examples", {"video": "v|9.000", "examples": ex})
        self.assertEqual(st, 200, d)
        self.assertTrue(d["ready"])
        self.assertEqual(d["decisions"], {"ums": 14, "notums": 14})
        st, d, _ = self.ask("GET", "/teach/model")
        self.assertEqual(d["model"]["kind"], "two-class")
        st, d, _ = self.ask("GET", "/teach")
        self.assertEqual(d["kind"], "two-class")
        st, d, _ = self.ask("POST", "/teach/forget", {"what": "all"})
        self.assertEqual(st, 200)
        self.assertFalse(d["ready"])
        st, d, _ = self.ask("GET", "/teach/model")
        self.assertIsNone(d["model"])

    def test_bad_requests_are_refused(self):
        self.assertEqual(self.ask("POST", "/teach/forget", {"what": "../../x"})[0], 400)
        self.assertEqual(self.ask("POST", "/teach/examples", {"video": "v"})[0], 400)
        self.assertEqual(self.ask("GET", "/teach/nothing")[0], 404)
        self.assertEqual(self.ask("DELETE", "/teach")[0], 405)
        self.assertEqual(self.ask("GET", "/teach", origin="https://example.com")[0], 403)

    def test_the_upload_option_is_checked(self):
        self.assertEqual(self.V.parse_options('{"teach":"um"}'), {"teach": "um"})
        with self.assertRaises(ValueError):
            self.V.parse_options('{"teach":"cat"}')


class RecordingJobTests(TeachBase):
    """transcribe.py --teach on a real file, the way the helper runs it for an upload."""

    @staticmethod
    def read(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def run_teach(self, path, label):
        out = os.path.join(self.dir, "result.json")
        env = dict(os.environ, VRT_TEACH_DIR=self.dir)
        cmd = [sys.executable, os.path.join(_paths.TOOLS, "transcribe.py"), path, "--teach", label, "--teach-name", "my %s.wav" % label,
               "--out", out, "--machine"]
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=_paths.TOOLS, timeout=180)
        return r, out

    def test_a_recording_of_ums_and_one_of_sound_effects_teach_a_model(self):
        rng = np.random.default_rng(71)
        ums, fx = os.path.join(self.dir, "ums.wav"), os.path.join(self.dir, "fx.wav")
        write_clip(ums, [make_um(rng) for _ in range(16)] + [make_pop(rng) * 2], gap=1.0, seed=1)      # one pop sneaked into the ums
        write_clip(fx, [[make_whoosh, make_pop, make_bell][i % 3](rng) for i in range(16)], gap=1.0, seed=2)
        r, out = self.run_teach(ums, "um")
        self.assertEqual(r.returncode, 0, r.stdout.decode("utf-8", "replace")[-800:])
        doc = self.read(out)
        self.assertEqual(doc["format"], "video-redline-teach")
        self.assertEqual(doc["found"], 17)
        self.assertEqual(doc["ignored"], 1, "the pop in the middle of the ums is left out")
        self.assertEqual(doc["used"], 16)
        self.assertEqual(doc["summary"]["kind"], "one-class")
        self.assertIn(b"PROGRESS", r.stdout)
        r, out = self.run_teach(fx, "notum")
        self.assertEqual(r.returncode, 0, r.stdout.decode("utf-8", "replace")[-800:])
        doc = self.read(out)
        self.assertEqual(doc["summary"]["kind"], "two-class")
        self.assertEqual((doc["summary"]["ums"], doc["summary"]["notums"]), (16, 16))
        self.assertTrue(os.path.isfile(os.path.join(self.dir, "model.json")))

    def test_a_silent_recording_is_refused_in_plain_words(self):
        path = os.path.join(self.dir, "silent.wav")
        write_clip(path, [np.zeros(SR)], gap=1.0)
        r, _ = self.run_teach(path, "um")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(b"PROBLEM", r.stdout)


if __name__ == "__main__":
    unittest.main()
