r"""Tests that run the real speech models on the made-up test clips in audio-test\ (about a minute in total).

Run from the tools folder:    venv\Scripts\python.exe -m unittest discover -s tests -p "test_real_models.py" -v

They are skipped when the models or the clips are not there. ALL CLIPS ARE SYNTHETIC (the Windows text-to-speech voice),
so a pass shows that the code path works on these clips. It says nothing about how often these problems occur, or how
accurate the tool is, on real people talking.
"""
import contextlib
import importlib
import io
import json
import os
import re
import shutil
import tempfile
import unittest

import _paths
from _paths import AUDIO_TEST, REAL, SCRATCH

NUMBERS = os.path.join(AUDIO_TEST, "numbers", "numbers.wav")
NUMBERS_LONG = os.path.join(AUDIO_TEST, "numbers", "numbers-long.wav")
OVERLAP = os.path.join(AUDIO_TEST, "continuous", "continuous-vad-overlap.wav")


def models_present():
    try:
        E = importlib.import_module("vrt_engines")
        if not hasattr(E, "model_problems"):                # the code from before the fixes cannot tell: try anyway
            return os.path.isdir(os.path.join(REAL, "hf-cache", "hub"))
        return (not E.model_problems(E.PARAKEET_MODELS["v2"][1], "parakeet")
                and not E.model_problems(E.SILERO_REPO, "silero")
                and not E.model_problems(E.WHISPER_REPOS["small.en"], "whisper"))
    except Exception:
        return False


def validate(doc):
    """The canonical transcript format that cleanup.js reads. Returns a list of problems (empty = fine)."""
    bad = []
    if doc.get("format") != "video-review-transcript" or doc.get("version") != 1:
        bad.append("header")
    for key in ("video", "engines", "words", "silences", "sounds"):
        if key not in doc:
            bad.append("missing " + key)
    for w in doc.get("words", []):
        if not (isinstance(w.get("w"), str) and w["w"].strip() and 0 <= w["s"] < w["e"] and 0 <= w["c"] <= 1
                and w["src"] in ("parakeet", "whisper", "both")):
            bad.append("word %r" % (w,))
    ws = doc.get("words", [])
    for a, b in zip(ws, ws[1:]):
        if b["s"] < a["s"] or a["e"] > b["s"] + 0.0015:
            bad.append("order/overlap %r %r" % (a, b))
    for s in doc.get("silences", []):
        if not (0 <= s["s"] < s["e"]):
            bad.append("silence %r" % (s,))
    for s in doc.get("sounds", []):
        if not (0 <= s["s"] < s["e"] and s["kind"] in ("voiced", "noise", "breath", "click")):
            bad.append("sound %r" % (s,))
    return bad


@unittest.skipUnless(models_present() and os.path.isfile(NUMBERS) and os.path.isfile(OVERLAP),
                     "needs the downloaded speech models and the clips in audio-test")
class RealModelTests(unittest.TestCase):
    def transcribe(self, clip, *extra):
        T = importlib.import_module("transcribe")
        out = os.path.join(tempfile.mkdtemp(prefix="rm-", dir=SCRATCH), "out.json")
        self.addCleanup(shutil.rmtree, os.path.dirname(out), ignore_errors=True)
        args = T.build_parser().parse_args([clip, "--out", out, "--threads", "6"] + list(extra))
        with contextlib.redirect_stdout(io.StringIO()):
            T.run_pipeline(args)
        with open(out, encoding="utf-8") as f:
            doc = json.load(f)
        self.assertEqual(validate(doc), [])
        return doc

    @staticmethod
    def plain(words):
        return [re.sub(r"^[^\w$]+|[.,;:!?]+$", "", w["w"]) for w in words]

    def test_numbers_are_separate_words(self):
        doc = self.transcribe(NUMBERS)
        got = self.plain(doc["words"])
        for want in ("row", "150", "had", "2024", "12%"):
            self.assertIn(want, got)
        glued = [w for w in got if re.search(r"[A-Za-z]\d|\d[A-Za-z]", w)]
        self.assertEqual(glued, [], "words with letters and digits stuck together: %r" % glued)

    @unittest.skipUnless(os.path.isfile(NUMBERS_LONG), "numbers-long.wav is missing")
    def test_more_numbers_symbols_and_cell_references(self):
        doc = self.transcribe(NUMBERS_LONG)
        got = set(self.plain(doc["words"]))
        for want in ("150", "2024", "35%", "12", "200", "$1,250", "2", "3", "$45.50", "20%"):
            self.assertIn(want, got)
        for glued in ("had150", "in2024", "and35%", "type12", "row200", "sheet2", "copy3", "is$1"):
            self.assertNotIn(glued, [g.lower() for g in got])

    def test_a_word_at_the_join_of_two_speech_chunks_is_not_said_twice(self):
        doc = self.transcribe(OVERLAP, "--no-whisper")
        words = doc["words"]
        for at in (19.6, 57.9, 96.2):
            near = [w for w in words if abs(w["s"] - at) < 0.5 and re.sub(r"\W", "", w["w"]).lower() == "excel"]
            self.assertEqual(len(near), 1, "expected the word 'Excel' once near %.1f s, got %r" % (at, near))
        for a, b in zip(words, words[1:]):
            same = re.sub(r"\W", "", a["w"]).lower() == re.sub(r"\W", "", b["w"]).lower()
            self.assertFalse(same and b["s"] - a["e"] < 0.05 and a["e"] - a["s"] < 0.5,
                             "the same word twice in a row: %r %r" % (a, b))


if __name__ == "__main__":
    unittest.main()
