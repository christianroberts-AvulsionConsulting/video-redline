#!/usr/bin/env python3
"""Video Redline - transcription helper.

Turns a video (or audio) file into <name>-transcript.json: every spoken word with its time, plus the quiet gaps
and the non-word sounds. It runs two open-source speech engines on YOUR computer (nothing is uploaded):

  * NVIDIA Parakeet - exact word timing
  * OpenAI Whisper  - catches the "um"s and "uh"s that Parakeet tends to drop

Usage:
    transcribe.py <video-or-audio-file> [--out FILE] [--parakeet v2|v3] [--whisper MODEL]
                  [--no-whisper] [--no-parakeet] [--threads N]

Other modes:
    transcribe.py --download-models   (one-time download of the speech models)
    transcribe.py --self-test         (quick check that everything works)
    transcribe.py <recording> --teach um|notum   (learn from a recording of your ums, or of sounds that are not ums; see vrt_teach.py)
    transcribe.py --check-venv        (setup uses this: does the private Python belong to this folder?)
    transcribe.py --check-packages    (setup uses this: can every speech package be loaded on this computer?)
"""
from __future__ import annotations

import os
import sys

HELPER_VERSION = "1.1.1"
FORMAT_VERSION = 1

# ---- keep everything inside this folder, and stay offline unless we are downloading models -------------
TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("HF_HOME", os.path.join(TOOLS_DIR, "hf-cache"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "0")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("DO_NOT_TRACK", "1")
# Microsoft's ONNX Runtime (the Parakeet part) has usage reporting built in. This variable stops the reporting over the internet of the
# builds that have it (read from the wheels: the Apple Silicon Mac build); the Windows build ignores it, and there
# vrt_env.switch_off_ort_telemetry() calls the library's own disable function. Set outright, not with setdefault.
os.environ["ORT_DISABLE_TELEMETRY"] = "1"
_DOWNLOAD_MODE = "--download-models" in sys.argv
if not _DOWNLOAD_MODE:
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
sys.path.insert(0, TOOLS_DIR)

import argparse
import datetime
import json
import re
import shutil
import tempfile
import time
import traceback

try:
    sys.stdout.reconfigure(errors="replace", line_buffering=True)
    sys.stderr.reconfigure(errors="replace", line_buffering=True)
except Exception:
    pass


class FriendlyError(Exception):
    """An error with a message a non-developer can act on."""

    def __init__(self, message, hint=None, code=1):
        Exception.__init__(self, message)
        self.hint = hint
        self.code = code


def plain_folder_example():
    """A plain local folder to suggest (not Desktop or Documents: on many computers a cloud service syncs those). On Windows it is
    VideoRedline inside the user's own folder, written with the real user folder (USERPROFILE) when that is a plain drive path;
    a folder directly on the C drive is shared with the other accounts of the PC."""
    if sys.platform != "win32":
        return "~/VideoRedline"
    home = (os.environ.get("USERPROFILE") or "").strip().rstrip("\\/")
    if len(home) > 3 and home[0].isalpha() and home[1:3] == ":\\":
        return home + "\\VideoRedline"
    return "C:\\Users\\<your name>\\VideoRedline"


def how_to_give_a_video():
    """What really works to hand a video to the launcher of this computer. On a Mac the .command file takes the video(s)
    as arguments (transcribe-mac.command), so they are dragged into the Terminal window after it; dropping a video onto the
    .command file itself does nothing."""
    if sys.platform == "win32":
        return "Drag your video onto 'transcribe-windows.bat'."
    return ("On a Mac: open Terminal, type bash and a space, drag 'transcribe-mac.command' into the window, type another "
            "space, drag your video into the window too, then press Return.")


# ----------------------------------------------------------------------------------------------
# Progress lines
# ----------------------------------------------------------------------------------------------
def fmt_clock(seconds):
    seconds = int(max(0, round(seconds)))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return "%d:%02d:%02d" % (h, m, s) if h else "%d:%02d" % (m, s)


def fmt_left(seconds):
    seconds = int(max(0, round(seconds)))
    if seconds < 10:
        return "a few seconds"
    if seconds < 60:
        return "about %d seconds" % (round(seconds / 5.0) * 5)
    m = int(round(seconds / 60.0))
    if m < 60:
        return "about %d minute%s" % (m, "" if m == 1 else "s")
    h, m = divmod(m, 60)
    return "about %d h %02d min" % (h, m)


class Progress:
    """Prints progress lines: a friendly one by default, or JSON lines with --machine."""

    def __init__(self, stages, machine=False):
        # stages: list of (key, label, weight)
        total = float(sum(w for _, _, w in stages)) or 1.0
        self.stages = [(k, l, w / total) for k, l, w in stages]
        self.index = {k: i for i, (k, _, _) in enumerate(self.stages)}
        self.machine = machine
        self.t0 = time.time()
        self.cur = None
        self.last_print = 0.0
        self.last_pct = -1
        self.done_before = 0.0
        self.frac = 0.0
        self.detail = ""
        self.last_key = None

    def start(self, key, detail=""):
        i = self.index[key]
        self.done_before = sum(w for _, _, w in self.stages[:i])
        self.cur = i
        self.frac = 0.0
        self.detail = detail
        self.emit(force=True)

    def update(self, frac, detail=None):
        if self.cur is None:
            return
        self.frac = max(0.0, min(1.0, frac))
        if detail is not None:
            self.detail = detail
        self.emit()

    def finish_stage(self):
        self.frac = 1.0
        self.emit(force=True)

    def percent(self):
        if self.cur is None:
            return 0.0
        return 100.0 * (self.done_before + self.stages[self.cur][2] * self.frac)

    def emit(self, force=False):
        now = time.time()
        pct = self.percent()
        if not force and (now - self.last_print < 2.0 and int(pct) - self.last_pct < 5):
            return
        if not force and int(pct) == self.last_pct and now - self.last_print < 10.0:
            return
        key = (self.cur, int(pct), self.detail)
        if key == self.last_key:
            return
        self.last_key = key
        self.last_print = now
        self.last_pct = int(pct)
        elapsed = now - self.t0
        remaining = None
        if pct >= 4.0 and elapsed >= 6.0:
            remaining = elapsed * (100.0 - pct) / pct
        label = self.stages[self.cur][1]
        if self.machine:
            print("PROGRESS " + json.dumps({
                "stage": self.stages[self.cur][0], "label": label, "percent": int(pct), "elapsed": int(elapsed),
                "remaining": None if remaining is None else int(remaining), "detail": self.detail}), flush=True)
        else:
            line = "[%3d%%] %s" % (int(pct), label)
            if self.detail:
                line += " - " + self.detail
            line += " | %s so far" % fmt_clock(elapsed)
            if remaining is not None and pct < 99.5:
                line += " | %s left" % fmt_left(remaining)
            print(line, flush=True)


def peak_memory_mb():
    """Most memory this program used at any moment, in MB (None if it cannot be read)."""
    try:
        if sys.platform == "win32":
            import ctypes
            from ctypes import wintypes

            class PMC(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                            ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                            ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

            k32 = ctypes.WinDLL("kernel32")
            ps = ctypes.WinDLL("psapi")
            k32.GetCurrentProcess.restype = wintypes.HANDLE
            ps.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
            ps.GetProcessMemoryInfo.restype = wintypes.BOOL
            pmc = PMC()
            pmc.cb = ctypes.sizeof(PMC)
            if ps.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb):
                return pmc.PeakWorkingSetSize / 1048576.0
            return None
        import resource
        r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return r / 1048576.0 if sys.platform == "darwin" else r / 1024.0
    except Exception:
        return None


def say(msg=""):
    print(msg, flush=True)


# ----------------------------------------------------------------------------------------------
# Argument parsing
# ----------------------------------------------------------------------------------------------
def default_threads():
    n = os.cpu_count() or 4
    return max(1, min(8, n - 2)) if n > 3 else max(1, n - 1)


def build_parser():
    ap = argparse.ArgumentParser(
        prog="transcribe.py", description="Make a word-level transcript (JSON) from a video or audio file.")
    ap.add_argument("input", nargs="?", help="the video or audio file")
    ap.add_argument("--out", help="where to save the transcript (default: <video name>-transcript.json next to the video)")
    ap.add_argument("--parakeet", choices=["v2", "v3"], default="v2",
                    help="Parakeet model: v2 = English only (default), v3 = 25 European languages")
    ap.add_argument("--whisper", default="small.en", metavar="MODEL",
                    help="Whisper model: tiny.en, base.en, small.en (default), medium.en, large-v3 ...")
    ap.add_argument("--no-whisper", action="store_true", help="skip Whisper (faster, but misses more ums and uhs)")
    ap.add_argument("--no-parakeet", action="store_true", help="skip Parakeet (Whisper timing only; less exact)")
    ap.add_argument("--threads", type=int, default=default_threads(), help="CPU threads to use (default %d)" % default_threads())
    ap.add_argument("--machine", action="store_true", help="print progress as JSON lines (for a launcher window)")
    ap.add_argument("--download-models", action="store_true", help="download the speech models (needs internet), then stop")
    ap.add_argument("--self-test", action="store_true", help="run a quick check on a tiny made-up recording, then stop")
    ap.add_argument("--check-venv", action="store_true",
                    help="check that the private Python in venv/ belongs to this folder (used by setup), then stop")
    ap.add_argument("--check-packages", action="store_true",
                    help="check that every speech package loads on this computer (used by setup), then stop")
    ap.add_argument("--teach", choices=["um", "notum"],
                    help="learn from a recording instead of making a transcript: um = it is full of ums and uhs, "
                         "notum = it is full of sounds that are NOT ums (sound effects, breaths, clicks)")
    ap.add_argument("--teach-name", help="the recording's own file name (shown in the list of what it learned from)")
    ap.add_argument("--teach-sync", action="store_true",
                    help="read the Accept / Reject examples of one video as JSON on stdin, store them, retrain, print the summary")
    ap.add_argument("--teach-forget", metavar="WHAT",
                    help="forget what was learned (all, clips, decisions, or clip:<id> for one recording), then print the summary")
    ap.add_argument("--keep-temp", action="store_true", help="keep the temporary audio file (for debugging)")
    ap.add_argument("--debug-dump", metavar="DIR", help="also save each engine's raw words into DIR (for debugging)")
    ap.add_argument("--version", action="version", version="transcribe.py " + HELPER_VERSION)
    return ap


# ----------------------------------------------------------------------------------------------
# Model download
# ----------------------------------------------------------------------------------------------
def download_models(args):
    import vrt_engines as E
    wanted = []
    if not args.no_parakeet:
        name = E.PARAKEET_MODELS[args.parakeet]
        wanted.append(("Parakeet speech model (%s)" % name[2], name[1], E.PARAKEET_FILES, 660, "parakeet"))
        wanted.append(("voice-activity model (tiny)", E.SILERO_REPO, E.SILERO_FILES, 3, "silero"))
    if not args.no_whisper:
        repo = E.WHISPER_REPOS.get(args.whisper, args.whisper)
        mb = E.WHISPER_MB.get(args.whisper, 500)
        wanted.append(("Whisper speech model (%s)" % args.whisper, repo, E.WHISPER_FILES, mb,
                       "whisper" if "/" in repo else None))
    # a model whose files are all in place is not downloaded again (so setup can be re-run offline to repair a folder)
    todo = [w for w in wanted if not (w[4] and not E.model_problems(w[1], w[4]))]
    if todo:
        total = sum(w[3] for w in todo)
        say("This downloads about %.1f GB once. After that, everything works offline." % (total / 1000.0))
        say("Files are saved inside this folder only: %s" % os.environ["HF_HOME"])
        say("")
    for i, (label, repo, patterns, mb, kind) in enumerate(wanted, 1):
        if kind and not E.model_problems(repo, kind):
            say("(%d of %d) The %s is already downloaded." % (i, len(wanted), label))
            continue
        say("(%d of %d) Downloading the %s - about %d MB ..." % (i, len(wanted), label, mb))
        try:
            E.download_snapshot(repo, patterns)
        except Exception as e:
            raise FriendlyError(
                "I could not download the %s." % label,
                "Check that this computer is connected to the internet (and not behind a blocking firewall), "
                "then run the setup file again. It picks up where it left off. (Technical detail: %s)" % str(e)[:200])
        # an interrupted download can leave a folder with some of the files: make sure every file is really there
        missing = E.model_problems(repo, kind) if kind else []
        if missing:
            raise FriendlyError(
                "The download of the %s did not finish (missing: %s)." % (label, ", ".join(missing)),
                "Check the internet connection, then run the setup file again. It picks up where it left off.")
        say("    done.")
    say("")
    say("All speech models are downloaded.")
    return 0


# ----------------------------------------------------------------------------------------------
# Pipeline
# ----------------------------------------------------------------------------------------------
def make_tmp_dir():
    base = os.path.join(TOOLS_DIR, "tmp")
    try:
        os.makedirs(base, exist_ok=True)
        return tempfile.mkdtemp(prefix="run-", dir=base)
    except OSError:
        return tempfile.mkdtemp(prefix="vrt-")


def silences_without_words(sil, words, min_len=0.3):
    """Drop the part of a quiet gap that sits under a word (so a cut can never remove speech)."""
    out = []
    import bisect
    starts = [w["s"] for w in words]
    for s, e in sil:
        pieces = [(s, e)]
        k = max(0, bisect.bisect_left(starts, s - 3.0))
        while k < len(words) and words[k]["s"] < e:
            w = words[k]
            k += 1
            if w["e"] <= s:
                continue
            ov = min(e, w["e"]) - max(s, w["s"])
            dur = max(0.01, w["e"] - w["s"])
            if ov / dur >= 0.5:                  # the word is mostly inside the quiet gap: keep the word safe
                nxt = []
                for a, b in pieces:
                    if w["e"] <= a or w["s"] >= b:
                        nxt.append((a, b))
                    else:
                        if w["s"] - a > 0.0:
                            nxt.append((a, w["s"]))
                        if b - w["e"] > 0.0:
                            nxt.append((w["e"], b))
                pieces = nxt
        for a, b in pieces:
            if b - a >= min_len:
                out.append((round(a, 3), round(b, 3)))
    return out


def run_pipeline(args, progress_cb=None):
    import vrt_audio as A
    import vrt_engines as E
    import vrt_merge as M

    in_path = os.path.abspath(args.input)
    if not os.path.exists(in_path):
        raise FriendlyError("I can't find that file: %s" % in_path,
                            "Check the spelling. " + how_to_give_a_video())
    if os.path.isdir(in_path):
        raise FriendlyError("That is a folder, not a video file: %s" % in_path)
    stem = os.path.splitext(os.path.basename(in_path))[0]
    out_path = os.path.abspath(args.out) if args.out else os.path.join(os.path.dirname(in_path), stem + "-transcript.json")
    out_dir = os.path.dirname(out_path)
    try:
        os.makedirs(out_dir, exist_ok=True)
        probe = os.path.join(out_dir, ".vrt-write-test-%d" % os.getpid())
        with open(probe, "w") as f:
            f.write("x")
        os.remove(probe)
    except OSError:
        raise FriendlyError("I can't save files in the folder next to your video (%s)." % out_dir,
                            "The folder may be read-only, or on a drive that is full. Copy the video to a plain folder "
                            "on this computer (for example %s) and try again, or tell me where to save with --out."
                            % plain_folder_example())

    use_p = not args.no_parakeet
    use_w = not args.no_whisper
    if not use_p and not use_w:
        raise FriendlyError("Both speech engines are switched off, so there is nothing to do.")

    stages = [("decode", "Reading the audio from your video", 3), ("analyse", "Measuring loudness and quiet gaps", 3)]
    if use_p:
        stages.append(("parakeet", "Parakeet: finding every word and its exact time", 22))
    if use_w:
        stages.append(("whisper", "Whisper: catching the ums and uhs", 67))
    stages.append(("merge", "Putting it all together", 5))
    prog = Progress(stages, machine=args.machine)
    t_start = time.time()
    timings = {}

    tmp_dir = make_tmp_dir()
    raw_path = os.path.join(tmp_dir, "audio.raw")
    pcm = None
    try:
        # 1. decode ---------------------------------------------------------------------------------
        prog.start("decode", "file: %s" % os.path.basename(in_path))
        t = time.time()
        try:
            info = A.decode_to_pcm(in_path, raw_path, on_progress=lambda f: prog.update(f))
        except A.AudioProblem as e:
            raise FriendlyError(str(e), getattr(e, "hint", None))
        except OSError as e:
            if getattr(e, "errno", None) == 28:
                raise FriendlyError("The disk is full, so I can't unpack the audio.",
                                    "Free up a few hundred MB on this drive and try again.")
            raise
        prog.finish_stage()
        timings["decode"] = time.time() - t
        pcm = A.open_pcm(raw_path)
        audio_dur = len(pcm) / float(A.SR)
        duration = info["container_duration"] or audio_dur
        say("Audio length: %s" % fmt_clock(audio_dur))
        for wmsg in info.get("warnings", []):
            say("Note: " + wmsg)

        # 2. energy envelope --------------------------------------------------------------------------
        prog.start("analyse")
        t = time.time()
        db = A.compute_db(pcm)
        env = A.Envelope(pcm, db)
        for wmsg in env.warnings:
            say("Note: " + wmsg)
        timings["analyse"] = time.time() - t
        prog.finish_stage()

        # 3. Parakeet ---------------------------------------------------------------------------------
        P, W = [], []
        pk = None
        if use_p:
            prog.start("parakeet", "loading the model")
            t = time.time()
            try:
                pk = E.Parakeet(args.parakeet, threads=args.threads)
            except E.EngineProblem as e:
                raise FriendlyError(str(e), getattr(e, "hint", None))
            blocks = env.plan_blocks(180.0)
            prog.update(0.0, "listening")
            tot = audio_dur

            def pk_prog(f):
                prog.update(f, "%s of %s" % (fmt_clock(f * tot), fmt_clock(tot)))

            P = pk.run(pcm, blocks, on_progress=pk_prog)
            timings["parakeet"] = time.time() - t
            prog.finish_stage()
            if args.debug_dump:
                os.makedirs(args.debug_dump, exist_ok=True)
                with open(os.path.join(args.debug_dump, "parakeet-raw.json"), "w", encoding="utf-8") as f:
                    json.dump(P, f, ensure_ascii=False, indent=0)

        # 4. Whisper ----------------------------------------------------------------------------------
        wh = None
        windows = env.plan_blocks(24.0)
        if use_w:
            prog.start("whisper", "loading the model")
            t = time.time()
            try:
                wh = E.Whisper(args.whisper, threads=args.threads)
            except E.EngineProblem as e:
                raise FriendlyError(str(e), getattr(e, "hint", None))
            todo = [w for w in windows if env.has_sound(w[0], w[1])]
            tot = audio_dur

            def wh_prog(f):
                prog.update(f, "%s of %s" % (fmt_clock(f * tot), fmt_clock(tot)))

            W = wh.run(pcm, todo, on_progress=wh_prog)
            timings["whisper"] = time.time() - t
            prog.finish_stage()
            if args.debug_dump:
                os.makedirs(args.debug_dump, exist_ok=True)
                with open(os.path.join(args.debug_dump, "whisper-raw.json"), "w", encoding="utf-8") as f:
                    json.dump(W, f, ensure_ascii=False, indent=0)

        # 5. merge + audio analysis --------------------------------------------------------------------
        prog.start("merge")
        t = time.time()
        if use_p:
            merged = M.merge(P, W, env, windows)
        else:
            merged = M.merge(W, [], env, windows)
            for w in merged.words:
                w["src"] = "whisper"
        words = merged.words
        spans = [(w["s"], w["e"]) for w in words]
        sil = silences_without_words(env.silences(0.3), words)
        sounds = env.sounds(spans)
        try:                                       # a fingerprint of every um-like sound, for "Teach it your ums" (never breaks a transcript)
            import vrt_teach
            vrt_teach.attach_fingerprints(words, pcm)
        except Exception:
            pass
        timings["merge"] = time.time() - t
        prog.finish_stage()

        engines = {
            "parakeet": pk.engine_id if pk else "not used",
            "whisper": wh.engine_id if wh else "not used",
            "audio": ("numpy energy envelope (25 ms window, 10 ms step); noise floor %.1f dB; quiet = below floor + %.0f dB; "
                      "silences >= 0.30 s; sounds >= 0.12 s with no word within 60 ms, classified by simple spectral "
                      "features; word edges beside silence and filler edges snapped to the sound itself"
                      % (env.floor_db, env.margin_db)),
        }
        doc = {
            "format": "video-review-transcript",
            "version": FORMAT_VERSION,
            "video": {"name": os.path.basename(in_path), "duration": round(float(duration), 3)},
            "engines": engines,
            "words": words,
            "silences": [{"s": s, "e": e} for s, e in sil],
            "sounds": sounds,
        }
        tmp_out = out_path + ".part"
        with open(tmp_out, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp_out, out_path)

        elapsed = time.time() - t_start
        result = {"doc": doc, "out_path": out_path, "elapsed": elapsed, "timings": timings, "stats": merged.stats,
                  "dropped": merged.dropped, "env": env, "audio_dur": audio_dur, "P": P, "W": W}
        return result
    finally:
        if pcm is not None:
            pcm.close()
        if not getattr(args, "keep_temp", False):
            shutil.rmtree(tmp_dir, ignore_errors=True)


def run_teach(args):
    """--teach: decode a recording, find the separate sounds in it, fingerprint them and add them to what the helper has learned."""
    import hashlib
    import vrt_audio as A
    import vrt_teach as T

    in_path = os.path.abspath(args.input)
    if not os.path.isfile(in_path):
        raise FriendlyError("I can't find that file: %s" % in_path)
    out_path = os.path.abspath(args.out) if args.out else os.path.join(os.path.dirname(in_path), "teach-result.json")
    label = args.teach
    name = (args.teach_name or os.path.basename(in_path))[:120]
    h = hashlib.sha1()
    with open(in_path, "rb") as f:
        h.update(f.read(4 * 1024 * 1024))
    clip_key = "%s|%d" % (h.hexdigest(), os.path.getsize(in_path))

    prog = Progress([("decode", "Reading the sound from your recording", 45), ("analyse", "Measuring loudness and quiet gaps", 15),
                     ("learn", "Learning the sounds", 40)], machine=args.machine)
    tmp_dir = make_tmp_dir()
    raw_path = os.path.join(tmp_dir, "audio.raw")
    pcm = None
    try:
        prog.start("decode", "file: %s" % name)
        try:
            A.decode_to_pcm(in_path, raw_path, on_progress=lambda fr: prog.update(fr))
        except A.AudioProblem as e:
            raise FriendlyError(str(e), getattr(e, "hint", None))
        prog.finish_stage()
        pcm = A.open_pcm(raw_path)
        prog.start("analyse")
        env = A.Envelope(pcm, A.compute_db(pcm))
        prog.finish_stage()
        prog.start("learn")
        spans = T.clip_sounds(env, label)
        if len(spans) < 3:
            raise FriendlyError("I could not find separate sounds in that recording.",
                                "Record the sounds one at a time with a short gap between each (a second is plenty), in a quiet "
                                "room, and make sure the recording is not silent.")
        fps = []
        for i, (a, b) in enumerate(spans):
            fp = T.fingerprint(A.to_float(pcm, int(a * T.SR), int(b * T.SR)))
            if fp:
                fps.append(fp)
            prog.update((i + 1) / float(len(spans)))
        found = len(fps)
        dropped = 0
        if label == "um":
            fps, dropped = T.drop_outliers(fps)
        if len(fps) < 3:
            raise FriendlyError("I could not use the sounds in that recording.", "Try a clearer recording with a short gap between the sounds.")
        summary = T.add_clip(label, name, fps, dropped, T.clip_id_for(label, clip_key))
        prog.finish_stage()
    finally:
        if pcm is not None:
            pcm.close()
        if not getattr(args, "keep_temp", False):
            shutil.rmtree(tmp_dir, ignore_errors=True)
    doc = {"format": "video-redline-teach", "version": 1, "label": label, "name": name, "found": found, "used": len(fps),
           "ignored": dropped, "summary": summary}
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp_out = out_path + ".part"
    with open(tmp_out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp_out, out_path)
    say("")
    say("Learned from %d %s sound%s (%d left out because they looked unlike the rest)." % (
        len(fps), "um" if label == "um" else "not-um", "" if len(fps) == 1 else "s", dropped))
    return 0


def print_summary(res, args):
    doc = res["doc"]
    st = res["stats"]
    words = doc["words"]
    import vrt_merge
    fillers = [w for w in words if vrt_merge.norm(w["w"]) in vrt_merge.FILLERS]
    longest = max([s["e"] - s["s"] for s in doc["silences"]] or [0])
    say("")
    say("=" * 64)
    say("DONE in %s  (%s of audio, %.1fx faster than real time)" % (
        fmt_clock(res["elapsed"]), fmt_clock(res["audio_dur"]), res["audio_dur"] / max(0.01, res["elapsed"])))
    say("=" * 64)
    say("Words found: %d" % len(words))
    both_on = (not args.no_parakeet) and (not args.no_whisper)
    if both_on:
        say("   both engines agreed on %d, Parakeet only %d, Whisper only %d" % (
            st["both"], st["parakeet_only"], len(words) - st["both"] - st["parakeet_only"]))
        say("Ums, uhs and similar sounds: %d  (heard by both %d, Parakeet only %d, Whisper only %d)" % (
            len(fillers), st["fillers_both"], st["fillers_parakeet_only"], st["fillers_whisper_only"]))
    else:
        say("   (only %s was used)" % ("Whisper" if args.no_parakeet else "Parakeet"))
        say("Ums, uhs and similar sounds: %d" % len(fillers))
    say("Quiet gaps of 0.3 s or more: %d  (longest %.1f s)" % (len(doc["silences"]), longest))
    kinds = {}
    for s in doc["sounds"]:
        kinds[s["kind"]] = kinds.get(s["kind"], 0) + 1
    say("Other sounds (breaths, clicks, coughs, humming): %d%s" % (
        len(doc["sounds"]), ("  (" + ", ".join("%d %s" % (v, k) for k, v in sorted(kinds.items())) + ")") if kinds else ""))
    say("")
    tm = res["timings"]
    parts = []
    for key, label in (("decode", "reading audio"), ("analyse", "measuring"), ("parakeet", "Parakeet"),
                       ("whisper", "Whisper"), ("merge", "combining")):
        if key in tm:
            parts.append("%s %s" % (label, fmt_clock(tm[key])))
    say("Time spent: " + ", ".join(parts))
    pm = peak_memory_mb()
    if pm:
        say("Most memory used at any moment: %d MB" % pm)
    say("")
    say("Saved: %s" % res["out_path"])
    say("Next: open this file in the Video Redline page, in the Audio cleanup section.")


# ----------------------------------------------------------------------------------------------
# Self-test
# ----------------------------------------------------------------------------------------------
def self_test(args):
    import wave
    import numpy as np
    say("Self-test: making a tiny 6 second test recording (a hum, a gap, a click and some noise) ...")
    d = make_tmp_dir()
    try:
        sr = 16000
        t = np.arange(sr * 6) / sr
        rng = np.random.default_rng(1)
        x = rng.normal(0, 0.0015, t.shape)                                   # quiet room tone
        x[int(0.5 * sr):int(1.6 * sr)] += 0.2 * np.sin(2 * np.pi * 180 * t[int(0.5 * sr):int(1.6 * sr)])   # a voiced hum
        x[int(4.0 * sr):int(4.01 * sr)] += rng.normal(0, 0.3, int(0.01 * sr))                               # a click
        x[int(4.8 * sr):int(5.3 * sr)] += rng.normal(0, 0.05, int(0.5 * sr))                                # a noise burst
        pcm = np.clip(x * 32767, -32768, 32767).astype("<i2")
        wav_path = os.path.join(d, "selftest.wav")
        with wave.open(wav_path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(pcm.tobytes())
        a = argparse.Namespace(**vars(args))
        a.input = wav_path
        a.out = os.path.join(d, "selftest-transcript.json")
        a.machine = False
        a.debug_dump = None
        res = run_pipeline(a)
        doc = res["doc"]
        problems = []
        if doc.get("format") != "video-review-transcript" or doc.get("version") != 1:
            problems.append("the output header is wrong")
        for key in ("video", "engines", "words", "silences", "sounds"):
            if key not in doc:
                problems.append("the output is missing '%s'" % key)
        if not any(s["e"] - s["s"] > 1.5 for s in doc["silences"]):
            problems.append("the quiet gap was not found")
        if not doc["sounds"]:
            problems.append("the hum / click / noise were not found")
        with open(a.out, "r", encoding="utf-8") as f:
            json.load(f)
        if problems:
            raise FriendlyError("The self-test did not pass: " + "; ".join(problems) + ".",
                                "Please run the setup file again. If this keeps happening, send the file "
                                "'logs/last-error.txt' to the person who invited you to the beta.")
        say("Self-test passed: the models load, audio is read, and a valid transcript file is written (%.0f s)." % res["elapsed"])
        return 0
    finally:
        shutil.rmtree(d, ignore_errors=True)


# ----------------------------------------------------------------------------------------------
def log_unexpected(exc):
    try:
        logs = os.path.join(TOOLS_DIR, "logs")
        os.makedirs(logs, exist_ok=True)
        path = os.path.join(logs, "last-error.txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write("Video Redline transcription helper %s\n%s\n" % (HELPER_VERSION, datetime.datetime.now().isoformat()))
            # only the options (words that start with --) are written: the other arguments are file names, and a file name is the
            # person's own folder and video name, which this file (people are asked to send it) does not need
            opts = [a for a in sys.argv[1:] if a.startswith("--")]
            f.write("Python %s on %s\nOptions: %s (and %d other argument(s), not written here)\n\n"
                    % (sys.version.split()[0], sys.platform, opts, len(sys.argv) - 1 - len(opts)))
            f.write("".join(traceback.format_exception(type(exc), exc, exc.__traceback__)))
        return path
    except Exception:
        return None


def main(argv=None):
    ap = build_parser()
    args = ap.parse_args(argv)
    try:
        import vrt_env
        if args.check_venv:
            problem = vrt_env.venv_problem(TOOLS_DIR)
            if problem:
                raise FriendlyError(problem[0], problem[1])
            say("The private Python belongs to this folder.")
            return 0
        if args.check_packages:
            problem = vrt_env.check_packages()
            if problem:
                raise FriendlyError(problem[0], problem[1])
            say("All the speech packages load.")
            return 0
        problem = vrt_env.venv_problem(TOOLS_DIR)
        if problem:
            raise FriendlyError(problem[0], problem[1])
        if args.download_models:
            return download_models(args)
        if args.teach_sync or args.teach_forget:
            import vrt_teach
            if args.teach_forget:
                if not re.fullmatch(r"all|clips|decisions|clip:[0-9a-f]{1,32}", args.teach_forget):
                    raise FriendlyError("I do not know what to forget: %s" % args.teach_forget[:40])
                summary = vrt_teach.forget(args.teach_forget)
            else:
                body = json.loads(sys.stdin.buffer.read(40 * 1024 * 1024).decode("utf-8"))
                summary = vrt_teach.sync_video(body.get("video", ""), body.get("examples", []))
            print(json.dumps(summary, separators=(",", ":")), flush=True)
            return 0
        if args.self_test:
            return self_test(args)
        if args.teach:
            if not args.input:
                raise FriendlyError("Please give me a recording to learn from.")
            return run_teach(args)
        if not args.input:
            ap.print_usage()
            raise FriendlyError("Please give me a video file to transcribe.", how_to_give_a_video())
        res = run_pipeline(args)
        print_summary(res, args)
        return 0
    except FriendlyError as e:
        say("")
        say("PROBLEM: " + str(e))
        if e.hint:
            say("WHAT TO DO: " + e.hint)
        if args.self_test:                         # setup asks a person to send logs/last-error.txt when the self-test fails
            note = log_unexpected(e)
            if note:
                say("A technical note was saved here: %s" % note)
        return e.code
    except KeyboardInterrupt:
        say("")
        say("Stopped. Nothing was saved.")
        return 130
    except MemoryError:
        say("")
        say("PROBLEM: The computer ran out of memory while working on this video.")
        say("WHAT TO DO: Close other programs and try again. If it still fails, try --no-whisper, or a smaller Whisper "
            "model such as --whisper base.en.")
        return 2
    except Exception as e:
        try:
            from vrt_env import is_missing_runtime, missing_runtime_texts
            runtime_missing = is_missing_runtime(e)
        except Exception:
            runtime_missing = False
        if runtime_missing:
            problem, todo = missing_runtime_texts()
            log_unexpected(e)
            say("")
            say("PROBLEM: " + problem)
            say("WHAT TO DO: " + todo)
            return 1
        path = log_unexpected(e)
        say("")
        say("PROBLEM: Something unexpected went wrong (%s)." % (str(e)[:200] or type(e).__name__))
        if path:
            say("A technical note was saved here: %s" % path)
        say("WHAT TO DO: Try once more. If it fails again, send that note to the person who invited you to the beta.")
        return 2


if __name__ == "__main__":
    sys.exit(main())
