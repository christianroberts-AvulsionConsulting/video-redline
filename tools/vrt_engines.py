"""The two speech engines: Parakeet (exact word timing) and Whisper (catches the ums and uhs).

Both run on the CPU. Parakeet goes through the onnx-asr package (ONNX Runtime, no PyTorch); Whisper goes
through faster-whisper (CTranslate2, int8). Neither needs the internet once the models are downloaded.
"""
from __future__ import annotations

import math
import os
import re

import numpy as np

from vrt_audio import SR, to_float
from vrt_env import describe_import_failure, switch_off_ort_telemetry
from vrt_merge import norm

PARAKEET_MODELS = {
    "v2": ("nemo-parakeet-tdt-0.6b-v2", "istupakov/parakeet-tdt-0.6b-v2-onnx",
           "Parakeet TDT 0.6B v2 (English)"),
    "v3": ("nemo-parakeet-tdt-0.6b-v3", "istupakov/parakeet-tdt-0.6b-v3-onnx",
           "Parakeet TDT 0.6B v3 (25 European languages)"),
}
PARAKEET_FILES = ["config.json", "vocab.txt", "nemo128.onnx", "encoder-model.int8.onnx",
                  "decoder_joint-model.int8.onnx"]
SILERO_REPO = "istupakov/silero-vad-onnx"
SILERO_FILES = ["silero_vad.onnx", "config.json"]

WHISPER_REPOS = {
    "tiny.en": "Systran/faster-whisper-tiny.en", "tiny": "Systran/faster-whisper-tiny",
    "base.en": "Systran/faster-whisper-base.en", "base": "Systran/faster-whisper-base",
    "small.en": "Systran/faster-whisper-small.en", "small": "Systran/faster-whisper-small",
    "medium.en": "Systran/faster-whisper-medium.en", "medium": "Systran/faster-whisper-medium",
    "large-v1": "Systran/faster-whisper-large-v1", "large-v2": "Systran/faster-whisper-large-v2",
    "large-v3": "Systran/faster-whisper-large-v3", "large": "Systran/faster-whisper-large-v3",
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo", "turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "distil-large-v3": "Systran/faster-distil-whisper-large-v3",
}
WHISPER_FILES = ["config.json", "model.bin", "tokenizer.json", "vocabulary.*", "vocabulary.json",
                 "preprocessor_config.json"]

# The exact commit of every model repo that the helper downloads, so that a later change to a repo on Hugging Face cannot
# change what setup installs. Looked up on 28 Oct 2026 (the head of each repo's main branch that day); for each one the
# files the helper needs were checked to exist at that commit. To move to a newer model: check it, then change the id here
# (and in THIRD-PARTY-NOTICES.md). A repo that a person names by hand (`--whisper owner/name`) is not in this table and is
# downloaded from its main branch, as before.
MODEL_REVISIONS = {
    "istupakov/parakeet-tdt-0.6b-v2-onnx": "0bbb45a3365852604aef28b538a8f066f4ccaa85",
    "istupakov/parakeet-tdt-0.6b-v3-onnx": "8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce",
    "istupakov/silero-vad-onnx": "b3e3ee3cce4c11ceb63b1a0b229d916069c1ddf6",
    "Systran/faster-whisper-tiny.en": "0d3d19a32d3338f10357c0889762bd8d64bbdeba",
    "Systran/faster-whisper-tiny": "d90ca5fe260221311c53c58e660288d3deb8d356",
    "Systran/faster-whisper-base.en": "3d3d5dee26484f91867d81cb899cfcf72b96be6c",
    "Systran/faster-whisper-base": "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66",
    "Systran/faster-whisper-small.en": "d1d751a5f8271d482d14ca55d9e2deeebbae577f",
    "Systran/faster-whisper-small": "536b0662742c02347bc0e980a01041f333bce120",
    "Systran/faster-whisper-medium.en": "a29b04bd15381511a9af671baec01072039215e3",
    "Systran/faster-whisper-medium": "08e178d48790749d25932bbc082711ddcfdfbc4f",
    "Systran/faster-whisper-large-v1": "b07c8d4be0be90092aa01a29c975077acb8d15c9",
    "Systran/faster-whisper-large-v2": "f0fe81560cb8b68660e564f55dd99207059c092e",
    "Systran/faster-whisper-large-v3": "edaa852ec7e145841d8ffdb056a99866b5f0a478",
    "mobiuslabsgmbh/faster-whisper-large-v3-turbo": "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf",
    "Systran/faster-distil-whisper-large-v3": "c3058b475261292e64a0412df1d2681c06260fab",
}
WHISPER_MB = {"tiny.en": 75, "tiny": 75, "base.en": 145, "base": 145, "small.en": 485, "small": 485,
              "medium.en": 1530, "medium": 1530, "large-v1": 3090, "large-v2": 3090, "large-v3": 3090,
              "large": 3090, "large-v3-turbo": 1620, "turbo": 1620, "distil-large-v3": 1510}

# A verbatim-style prompt: it nudges Whisper to write the ums, uhs and false starts instead of tidying them away.
VERBATIM_PROMPT = "Umm, let me think like, hmm... Okay, here's what I'm, like, thinking."


class EngineProblem(Exception):
    """Plain-language problem with a model (missing download, cannot load, ...). `hint` (optional) says what to do."""

    def __init__(self, message, hint=None):
        Exception.__init__(self, message)
        self.hint = hint


def _is_missing_model_error(e):
    name = type(e).__name__
    msg = str(e).lower()
    return (name in ("LocalEntryNotFoundError", "OfflineModeIsEnabled", "ModelFileNotFoundError",
                     "NoModelNameOrPathSpecifiedError", "ModelLoadingError")
            or "offline" in msg or "local_files_only" in msg or "not found in cache" in msg
            or "cannot find the requested files" in msg
            # CTranslate2 raises a RuntimeError like this when the folder exists but model.bin is missing
            or "unable to open file" in msg or "model.bin" in msg)


def download_snapshot(repo, patterns):
    """Download (or confirm) the files of one model repo into the Hugging Face cache folder.

    A repo in MODEL_REVISIONS is fetched at that exact commit. The engines later open the model offline by the name "main",
    which the cache answers from its refs/main file, so that file is pointed at the commit that was just downloaded.
    """
    from huggingface_hub import snapshot_download
    rev = MODEL_REVISIONS.get(repo)
    path = snapshot_download(repo, revision=rev, allow_patterns=patterns)
    if rev:
        _point_main_at(path, rev)
    return path


def _point_main_at(snapshot_path, rev):
    """Write <repo cache folder>/refs/main = rev, unless the downloaded snapshot is not that commit's folder."""
    try:
        snap = os.path.abspath(snapshot_path)
        if os.path.basename(snap) != rev:
            return False
        refs = os.path.join(os.path.dirname(os.path.dirname(snap)), "refs")
        os.makedirs(refs, exist_ok=True)
        tmp = os.path.join(refs, "main.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(rev)
        os.replace(tmp, os.path.join(refs, "main"))
        return True
    except OSError:
        return False


# What must be in the downloaded copy of a model before it can be used: (file name or "a|b" alternatives, smallest
# plausible size in bytes). An interrupted download can leave the folder with some files but not the big model file.
MODEL_PARTS = {
    "parakeet": [("config.json", 2), ("vocab.txt", 1000), ("nemo128.onnx", 10000),
                 ("encoder-model.int8.onnx", 100000000), ("decoder_joint-model.int8.onnx", 1000000)],
    "silero": [("silero_vad.onnx", 500000)],
    "whisper": [("config.json", 2), ("tokenizer.json", 1000), ("vocabulary.txt|vocabulary.json", 1000),
                ("model.bin", 20000000)],
}


def _hf_cache_root():
    from huggingface_hub import constants
    return constants.HF_HUB_CACHE


def model_problems(repo, kind, cache_root=None):
    """Names of the files of model `repo` that are missing or too small in the Hugging Face cache ([] = all there).

    `kind` is "parakeet", "silero" or "whisper". Nothing downloaded at all gives every required name.
    """
    root = cache_root or _hf_cache_root()
    snap = _snapshot_of(repo, root)
    folder = os.path.join(root, "models--" + repo.replace("/", "--"), "snapshots", snap) if snap else None
    missing = []
    for names, min_bytes in MODEL_PARTS[kind]:
        found = False
        for name in names.split("|"):
            try:
                if folder and os.path.getsize(os.path.join(folder, name)) >= min_bytes:
                    found = True
                    break
            except OSError:
                pass
        if not found:
            missing.append(names.split("|")[0])
    return missing


def require_model(repo, kind, label, cache_root=None):
    """Raise EngineProblem (plain language) unless every file of the model is in place."""
    missing = model_problems(repo, kind, cache_root)
    if not missing:
        return
    everything = len(missing) == len(MODEL_PARTS[kind])
    if everything:
        raise EngineProblem(
            "The %s has not been downloaded yet." % label,
            "Please run the setup file once (it needs the internet for the download, after that everything works "
            "offline).")
    raise EngineProblem(
        "The %s was only partly downloaded (missing: %s). The download was probably interrupted." % (
            label, ", ".join(missing)),
        "Please run the setup file again. It fetches the missing part (this needs the internet once).")


# ----------------------------------------------------------------------------------------------
# Parakeet
# ----------------------------------------------------------------------------------------------
# The function below (_tdt_decoding_with_durations) is taken from onnx-asr, https://github.com/istupakov/onnx-asr
# (the TDT decoding loop of its transducer model class), and it is MODIFIED from the original. The change that matters:
# the original throws away the predicted length of each word piece, and this copy keeps it and returns it with the start
# frame (see the docstring), which is needed for exact word end times. Besides that, this copy is shortened: it leaves out
# the original's type annotations, its assertions, and its clamp of the encoder lengths for TensorRT low-precision models
# (this tool never uses such a model).
#
# onnx-asr is under the MIT licence. Its copyright line and permission notice follow, as the licence asks:
#
#   MIT License
#
#   Copyright (c) 2025 Ilya Stupakov
#
#   Permission is hereby granted, free of charge, to any person obtaining a copy
#   of this software and associated documentation files (the "Software"), to deal
#   in the Software without restriction, including without limitation the rights
#   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
#   copies of the Software, and to permit persons to whom the Software is
#   furnished to do so, subject to the following conditions:
#
#   The above copyright notice and this permission notice shall be included in all
#   copies or substantial portions of the Software.
#
#   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
#   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
#   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
#   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
#   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
#   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
#   SOFTWARE.
#
# (The same text is in the Appendix of THIRD-PARTY-NOTICES.md, in the folder above this one.)
def _tdt_decoding_with_durations(self, encoder_out, encoder_out_lens, /, **kwargs):
    """onnx-asr's TDT decoding loop (MIT licence, Copyright (c) 2025 Ilya Stupakov; see the notice above this function),
    copied and MODIFIED (the notice above lists how): the change that matters is that it also returns each token's predicted
    duration (in encoder frames). The stock version throws that number away, and we need it for word end times.
    Each timestamp is returned as a (start_frame, duration_frames) pair; _decode_tokens scales both by 80 ms.
    """
    from onnx_asr.utils import log_softmax
    need_logprobs = kwargs.get("need_logprobs")
    for encodings, encodings_len in zip(encoder_out, encoder_out_lens):
        prev_state = self._create_state()
        tokens, stamps, logprobs = [], [], []
        t = 0
        emitted = 0
        while t < encodings_len:
            logits, step, state = self._decode(tokens, prev_state, encodings[t])
            token = logits.argmax()
            if token != self._blank_idx:
                prev_state = state
                tokens.append(int(token))
                stamps.append((t, max(int(step), 0)))
                emitted += 1
                if need_logprobs:
                    logprobs.append(log_softmax(logits)[token])
            if step > 0:
                t += step
                emitted = 0
            elif token == self._blank_idx or emitted == self._max_tokens_per_step:
                t += 1
                emitted = 0
        yield tokens, stamps, (logprobs if need_logprobs else None)


# ----------------------------------------------------------------------------------------------
# Tokens to words
# ----------------------------------------------------------------------------------------------
# Parakeet writes a word as sub-word tokens; a token that begins with a space starts a new word. Before numbers
# the model emits the word-start marker as a token of its own (a bare space, then "1", "5", "0"), so the marker
# has to be remembered, or "had 150" becomes "had150".
#
# A symbol in this list starts a NEW word when the model marked a word start in front of it ("$" in "is $45",
# "(" in "(see below)"). Without a marker, and for every other punctuation mark, it stays with the word before.
_WORD_OPENERS = "$\u20ac\u00a3\u00a5\u20b9\u00a2#@+([{\"\u201c\u2018\u00bf\u00a1"
_MARKER_REACH = 0.5     # seconds: a bare word-start marker this close before the first real token marks the word start


def tokens_to_words(toks, stamps, lps=None):
    """Join Parakeet's sub-word tokens into words.

    toks: token strings (a leading space = word start); stamps: one (start_s, duration_s) pair per token (or a plain
    start time); lps: optional log-probabilities. Returns a list of dicts {text, t0, t1, lps} in chunk time.
    """
    lps = lps or []
    words = []
    cur = None
    pending = None            # start time of a word-start marker that has not been used yet
    for i, tok in enumerate(toks):
        if i >= len(stamps):
            break
        st = stamps[i]
        if isinstance(st, (list, tuple, np.ndarray)):
            t0, dur = float(st[0]), float(st[1])
        else:
            t0, dur = float(st), 0.08
        lp = float(lps[i]) if i < len(lps) else None
        text = tok
        if text.startswith(" ") and pending is None:
            pending = t0                       # remember the marker even when the token is only the marker
        core = text.strip()
        if core == "":
            continue
        new_word = pending is not None or cur is None
        start = t0
        if pending is not None and 0.0 <= t0 - pending <= _MARKER_REACH:
            start = pending                    # the marker is where the spoken word really begins
        pending = None
        is_punct = all(not ch.isalnum() for ch in core)
        opener = is_punct and core[0] in _WORD_OPENERS
        if not new_word and not is_punct and cur is not None:
            # the model sometimes writes 'all,erm' with no space after the comma: split there. But not inside a
            # number: "1,250" and "10:30" stay one word.
            last = cur["text"][-1]
            in_number = last in ",:" and core[0].isdigit() and cur["text"][-2:-1].isdigit()
            if (last in ",;:!?" and not in_number) or (last == "." and len(cur["text"].rstrip(".")) > 2 and core[0].isalpha()):
                new_word = True
        if new_word and not (is_punct and cur is not None and not opener):
            if cur is not None:
                words.append(cur)
            cur = {"text": core, "t0": start, "t1": t0 + max(dur, 0.08), "lps": [lp] if lp is not None else []}
        else:
            cur["text"] += core
            if not is_punct:
                cur["t1"] = max(cur["t1"], t0 + max(dur, 0.08))
                if lp is not None:
                    cur["lps"].append(lp)
    if cur is not None:
        words.append(cur)
    return words


def add_chunk_words(kept, new, prev_end, tolerance=0.4, look_back=8):
    """Add the words of one speech chunk to `kept`, leaving out words the previous chunk already has.

    Neighbouring chunks overlap by up to ~0.3 s (every chunk is padded by 150 ms on each side), so a word spoken at
    the join is heard by both chunks. A new word is the same sound as an earlier word when the two spans overlap by
    more than `tolerance` of the shorter one (a word can only overlap itself: real words do not overlap in time).
    Matching is one to one, so a genuinely repeated word ("no no") is not removed. Of the two copies the more
    complete text (a word cut off at the chunk edge is shorter) is kept, then the more confident, then the first.

    prev_end: absolute end time (s) of the previous chunk, or None for the first chunk. Returns how many copies
    were dropped.
    """
    if prev_end is None or not kept:
        kept.extend(new)
        return 0
    n_before = len(kept)
    claimed = set()
    dropped = 0
    for w in new:
        match = None
        if w["s"] < prev_end + 0.08:
            dur_w = max(1e-3, w["e"] - w["s"])
            for idx in range(n_before - 1, max(-1, n_before - 1 - look_back), -1):
                if idx in claimed:
                    continue
                k = kept[idx]
                ov = min(w["e"], k["e"]) - max(w["s"], k["s"])
                if ov <= 0 or ov <= tolerance * min(dur_w, max(1e-3, k["e"] - k["s"])):
                    continue
                nw, nk = norm(w["text"]), norm(k["text"])
                same = nw == nk or (nw and nk and (nw.startswith(nk) or nk.startswith(nw)))
                key = (1 if same else 0, ov)
                if match is None or key > match[0]:
                    match = (key, idx)
        if match is None:
            kept.append(w)
            continue
        idx = match[1]
        claimed.add(idx)
        dropped += 1
        old = kept[idx]
        if (len(norm(w["text"])), w.get("c") or 0.0) > (len(norm(old["text"])), old.get("c") or 0.0):
            kept[idx] = w
    return dropped


# (switch_off_ort_telemetry is in vrt_env.py, so that `transcribe.py --check-packages`, which imports onnxruntime too, can use it)
class Parakeet:
    def __init__(self, version="v2", threads=4, log=print):
        import types
        os.environ["ORT_DISABLE_TELEMETRY"] = "1"       # must be set before onnxruntime is imported
        try:
            import onnxruntime as rt
            import onnx_asr
        except Exception as e:
            msg, hint = describe_import_failure(e, "The Parakeet speech engine (onnxruntime / onnx-asr)")
            raise EngineProblem(msg, hint) from e
        switch_off_ort_telemetry(rt)
        self.version = version
        self.model_name, self.repo, self.label = PARAKEET_MODELS[version]
        require_model(self.repo, "parakeet", "Parakeet speech model")
        require_model(SILERO_REPO, "silero", "voice-activity model")
        so = rt.SessionOptions()
        so.intra_op_num_threads = int(threads)
        so.inter_op_num_threads = 1
        so.log_severity_level = 3
        providers = ["CPUExecutionProvider"]
        try:
            self.asr = onnx_asr.load_model(self.model_name, quantization="int8", sess_options=so,
                                           providers=providers)
            vad_so = rt.SessionOptions()
            vad_so.intra_op_num_threads = 1
            vad_so.log_severity_level = 3
            self.vad = onnx_asr.load_vad("silero", sess_options=vad_so, providers=providers)
        except Exception as e:
            if _is_missing_model_error(e):
                raise EngineProblem(
                    "The Parakeet speech model has not been downloaded yet. Please run the setup file once "
                    "(it needs the internet for the download, after that everything works offline).") from e
            raise
        self.durations_ok = False
        try:
            inner = self.asr.asr
            if hasattr(inner, "_create_state") and hasattr(inner, "_blank_idx") and hasattr(inner, "_max_tokens_per_step"):
                inner._decoding = types.MethodType(_tdt_decoding_with_durations, inner)
                self.durations_ok = True
        except Exception:
            self.durations_ok = False
        self.snapshot = _snapshot_of(self.repo)
        self.engine_id = "%s via onnx-asr %s, int8 ONNX on CPU%s" % (
            self.model_name, _pkg_version("onnx-asr"),
            (", snapshot %s" % self.snapshot[:8]) if self.snapshot else "")

    def run(self, pcm, blocks, on_progress=None, batch_size=4, vad_threshold=0.5):
        """Transcribe each (start, end) block (seconds) and return a flat list of word dicts.

        Each block is cut by the voice-activity detector into speech chunks of at most ~20 seconds, so
        the model never sees silence stretches and never gets more than it can handle.
        """
        adapter = self.asr.with_vad(
            self.vad, batch_size=batch_size, threshold=vad_threshold, neg_threshold=max(0.1, vad_threshold - 0.2),
            min_speech_duration_ms=100, max_speech_duration_s=20, min_silence_duration_ms=100, speech_pad_ms=150,
        ).with_timestamps()
        words = []
        self.duplicates_dropped = 0
        total = max(1e-6, sum(b - a for a, b in blocks))
        done = 0.0
        for a, b in blocks:
            wav = to_float(pcm, a * SR, b * SR)
            if len(wav) < SR // 10:
                done += b - a
                continue
            seg_iter = adapter.recognize(wav)
            block_words = []
            prev_end = None
            for seg in seg_iter:
                # neighbouring chunks overlap at the join: a word spoken there must be kept only once
                self.duplicates_dropped += add_chunk_words(block_words, self._seg_to_words(seg, a), prev_end)
                prev_end = a + seg.end
                if on_progress:
                    on_progress(min(1.0, (done + min(b - a, seg.end)) / total))
            words.extend(block_words)
            done += b - a
            if on_progress:
                on_progress(min(1.0, done / total))
        words.sort(key=lambda w: (w["s"], w["e"]))
        return words

    def _seg_to_words(self, seg, offset):
        """Turn one speech chunk (tokens + timestamps + log-probabilities) into words."""
        words = tokens_to_words(seg.tokens or [], seg.timestamps or [], seg.logprobs or [])
        out = []
        for w in words:
            conf = float(math.exp(sum(w["lps"]) / len(w["lps"]))) if w["lps"] else None
            out.append({"text": w["text"], "s": offset + seg.start + w["t0"], "e": offset + seg.start + w["t1"],
                        "c": conf})
        return out


# ----------------------------------------------------------------------------------------------
# Whisper
# ----------------------------------------------------------------------------------------------
class Whisper:
    def __init__(self, model="small.en", threads=4, log=print):
        self.model_name = model
        repo = WHISPER_REPOS.get(model, model)
        self.repo = repo
        switch_off_ort_telemetry()                      # faster-whisper loads onnxruntime itself when it needs it
        try:
            from faster_whisper import WhisperModel
        except Exception as e:
            msg, hint = describe_import_failure(e, "The Whisper speech engine (faster-whisper)")
            raise EngineProblem(msg, hint) from e
        if "/" in repo and not os.path.isdir(model):
            # a model from the Hugging Face cache (not a folder the user pointed at): are all its files really there?
            require_model(repo, "whisper", "Whisper speech model '%s'" % model)
        try:
            self.model = WhisperModel(repo if "/" in repo else model, device="cpu", compute_type="int8",
                                      cpu_threads=int(threads), num_workers=1)
        except Exception as e:
            if _is_missing_model_error(e) or isinstance(e, (OSError, ValueError)):
                raise EngineProblem(
                    "The Whisper speech model '%s' has not been downloaded completely." % model,
                    "Please run the setup file again (it needs the internet for the download, after that everything "
                    "works offline).") from e
            raise
        self.snapshot = _snapshot_of(repo)
        self.engine_id = "faster-whisper %s, %s, int8 on CPU%s" % (
            _pkg_version("faster-whisper"), repo.split("/")[-1],
            (", snapshot %s" % self.snapshot[:8]) if self.snapshot else "")

    def run(self, pcm, windows, on_progress=None, prompt=VERBATIM_PROMPT, condition_on_previous_text=False,
            beam_size=5):
        """Transcribe each (start, end) window separately and return word dicts.

        Every window is its own call, so every window gets the verbatim prompt. (faster-whisper only uses the
        prompt for the first 30 seconds of a call when it is told not to condition on previous text.)
        """
        words = []
        total = max(1e-6, sum(b - a for a, b in windows))
        done = 0.0
        for a, b in windows:
            wav = to_float(pcm, a * SR, b * SR)
            if len(wav) >= SR // 5:
                segs, _info = self.model.transcribe(
                    wav, language="en" if self.model_name.endswith(".en") else None,
                    task="transcribe", beam_size=beam_size,
                    word_timestamps=True,
                    initial_prompt=prompt,
                    condition_on_previous_text=condition_on_previous_text,
                    vad_filter=False,
                    no_speech_threshold=None,        # a lone "um" can look like "no speech" to Whisper
                    log_prob_threshold=None,
                    compression_ratio_threshold=2.4,
                    suppress_blank=False,
                    without_timestamps=False,
                    max_initial_timestamp=2.0,
                    prepend_punctuations="\"'\u201c\u00bf([{-", append_punctuations="\"'.,!?:)]}\u3001",
                )
                for seg in segs:
                    for w in (seg.words or []):
                        t = w.word.strip()
                        if not t:
                            continue
                        words.append({"text": t, "s": a + float(w.start), "e": a + float(w.end),
                                      "c": float(w.probability), "seg_no_speech": float(seg.no_speech_prob),
                                      "seg_logprob": float(seg.avg_logprob)})
                    if on_progress:
                        on_progress(min(1.0, (done + min(b - a, seg.end)) / total))
            done += b - a
            if on_progress:
                on_progress(min(1.0, done / total))
        words.sort(key=lambda w: (w["s"], w["e"]))
        return words


# ----------------------------------------------------------------------------------------------
def _pkg_version(name):
    try:
        from importlib.metadata import version
        return version(name)
    except Exception:
        return "unknown"


def _snapshot_of(repo, cache_root=None):
    """Commit id of the cached copy of a Hugging Face repo (so the transcript says exactly which model was used)."""
    try:
        root = os.path.join(cache_root or _hf_cache_root(), "models--" + repo.replace("/", "--"))
        with open(os.path.join(root, "refs", "main"), "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""
