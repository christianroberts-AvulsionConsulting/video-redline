#!/usr/bin/env python3
"""Video Redline helper - a small program that runs on YOUR computer so the Video Redline page can make a transcript
with one click.

A web page cannot start programs, so the Video Redline page never starts this helper (neither do its buttons Create transcript
and Check again): the helper has to be running first. Windows: double-click the Video Redline icon on your Desktop; it starts the
helper if needed (hidden, with no window) and opens the page. If there is no such icon yet, double-click setup-autostart-windows.bat
once (it adds the icon and makes the helper start by itself at every sign-in); if you would rather not, double-click
start-helper-windows.bat and leave its window open. Mac: open Terminal, type bash and a space, drag start-helper-mac.command into
the window, press Return, and leave its window open. The page then talks to the helper on 127.0.0.1 (this computer only): it sends
the video, the helper runs transcribe.py (the same speech tools as the drag-and-drop launcher), and the page picks up the finished
transcript. Nothing leaves your computer.

On Windows the helper starts by itself, hidden, with no window, when the Video Redline icon is double-clicked and at every sign-in
after setup-autostart-windows.bat has been run (see AUTOSTART.md). A program that starts it that way sets the environment variable
VRT_BACKGROUND=1 (any value except empty, 0, false or no): the console texts then say that the helper runs in the background, and
how to stop it, instead of asking for a window to be left open or closed. stop-helper-windows.bat stops a helper that has no window
(only one that runs from the same tools folder as that file). A helper that is started by hand (start-helper-windows.bat) and finds
one that is already running, in another window or hidden, says so and says that closing its own window stops nothing.

Only the Python standard library is used. The helper listens on 127.0.0.1 ONLY (never on the network).

Endpoints (JSON unless noted)
    GET    /status                   { ok, helper, version, busy, ready, port, problem, maxUploadBytes, syncWarning }
                                     (syncWarning: true when the tools folder lies in a cloud-synced folder or on a network
                                     drive, the same check as the warning in the start-up window; false otherwise. The folder
                                     name is never part of the answer. The check is made BEFORE the helper starts to answer, so
                                     the first answer already has the right yes or no; only if it takes longer than about a
                                     second (a Mac asks `defaults` and `mount`) is a "false" given until it is known.)
    POST   /jobs?name=<file name>    body = the raw video bytes (Content-Length required);
                                     optional header X-Options = JSON { parakeet, whisper, noWhisper, noParakeet, threads }
                                     -> { job } once the upload is complete
    GET    /jobs/<id>                { job, state, stage, percent, etaSeconds, message, error }
    GET    /jobs/<id>/result         the transcript JSON (once; then the job folder is deleted)
    POST   /jobs/<id>/cancel         stop the work and delete the job folder
    DELETE /jobs/<id>                stop the work, delete the job folder, forget the job

Errors are always { error: "<code>", message: "<plain language>" }.

SECURITY: WHAT THIS HELPER DOES AND DOES NOT PROTECT (read this before changing the checks below)
    What it checks. It listens on 127.0.0.1 only. It answers only requests whose Host is 127.0.0.1:<port> or
    localhost:<port> (this stops DNS rebinding) and whose Origin is http://localhost[:port], http://127.0.0.1[:port], an
    address given with --allow-origin, "null" or "file://". Ordinary websites are refused. "null" is what a page opened from
    a file on this computer sends, and the Video Redline page is exactly that, so it must stay allowed. Safari may send the
    exact text "file://" for such a page instead, so that is allowed too, with the same trust as "null". Only those two exact
    strings count: "file://x" or "file:///etc" are refused like any other foreign origin.
    The known limit. There is NO password or pairing key, on purpose: typing a code would be too much friction for the
    people this tool is made for. So a page that is able to send "Origin: null" or "Origin: file://" (for example a
    sandboxed frame inside any website the user visits) or any program on this computer can ask the helper to transcribe
    a video that it sends.
    What such a page CANNOT do: read the user's files, start programs, write outside the helper's own job folder, or fetch
    a transcript it did not start (job numbers are 128 random bits). What it CAN do: use the CPU, hold the single job slot
    (the real page then sees "busy"), and make the helper unpack audio into scratch space. The damage is limited, not
    prevented, by three guards that run while a job works (every VRT_WATCH_S seconds, default 2):
      * disk guard: the job is stopped (error "disk-full") when free space on the drive falls below max(500 MB, 1 GB), or
        when the audio it unpacked is larger than max(2 GB, 50 x the upload), never more than 40 GB;
      * abandoned-job guard: a running job that nobody has asked about (GET /jobs/<id> or /result) for 10 minutes
        (VRT_ABANDON_S) is cancelled, so a closed or refreshed page cannot keep the helper busy;
      * time limit: one job may run for 3 hours at most (VRT_MAX_JOB_S).
    The uploaded video is kept in <tools folder>/tmp/jobs-<port>/<job>/ (folder mode 0700, file mode 0600 where the
    operating system has such modes) and is deleted when the job ends. If the tools folder lies inside a folder that a
    cloud service synchronises (OneDrive, Dropbox, iCloud, Google Drive; on a Mac also the Desktop and Documents folders
    when iCloud Drive keeps them) or on a network drive, that service would copy the video: the start-up window shows a
    warning (sync_warning), and the setup files check the folder name before they download anything. The advice in
    README-helper-security.md is "close the helper window when you are not using it" (when the optional automatic start is on
    there is no window: stop-helper-windows.bat stops the hidden helper, remove-autostart-windows.bat turns the start off).
"""
from __future__ import annotations

import argparse
import atexit
import collections
import errno
import http.client
import json
import os
import queue
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

HELPER_ID = "video-review-helper"
HELPER_VERSION = "1.1.0"          # raised from 1.0.0 for the Video Redline beta, so an older helper can be told apart; nothing compares it
IS_WIN = os.name == "nt"
IS_MAC = sys.platform == "darwin"

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
TMP_DIR = os.path.join(TOOLS_DIR, "tmp")
JOBS_DIR = os.path.join(TMP_DIR, "jobs")          # main() replaces this with tmp/jobs-<port>: every helper has its own folder
TRANSCRIBE_PY = os.path.join(TOOLS_DIR, "transcribe.py")
SETUP_FILE = "setup-windows.bat" if IS_WIN else "setup-mac.command"
START_FILE = "start-helper-windows.bat" if IS_WIN else "start-helper-mac.command"
STOP_FILE = "stop-helper-windows.bat"             # not part of this package: the Windows automatic start brings it (see AUTOSTART.md)
AUTOSTART_FILE = "setup-autostart-windows.bat"    # ditto: it adds the start-up setting and the Video Redline icon (the icon starts the helper)
# Task Manager shows no command line unless that column is added; the hidden helper is told apart by the folder in its command line
TASK_MANAGER_STEPS = "Task Manager, Details tab; first right-click the column bar, choose Select columns and tick Command line"


def how_to_run(name):
    """One plain sentence on how to start a file of the tools folder on this computer. A .command file is not marked as
    a program after a download, so on a Mac it is run through bash (double-clicking it often fails)."""
    if IS_WIN:
        return "Open the tools folder and double-click %s." % name
    return "On a Mac: open Terminal, type bash and a space, drag %s into the window, then press Return." % name


def has_autostart_file():
    """True when setup-autostart-windows.bat lies in this tools folder. It comes with the Video Redline app, so a copy of the tools
    folder may not have it (the texts then fall back to the hand start). Only asked on Windows."""
    return os.path.isfile(os.path.join(TOOLS_DIR, AUTOSTART_FILE))


def start_again_text(short=False):
    """The last sentence of a text that sends a person to the setup file: how to start the helper afterwards. Windows: the Video
    Redline icon comes first (it starts the helper if needed and opens the page; the page never starts the helper by itself), then
    setup-autostart-windows.bat for a person who has no icon yet (left out when short=True, for texts that the page cuts), and the
    hand start when that file is not in the folder. A Mac: the helper is started by hand, as before."""
    if IS_WIN:
        if has_autostart_file():
            if short:
                return "Then start the helper again: double-click the Video Redline icon on your Desktop."
            return ("Then start the helper again: double-click the Video Redline icon on your Desktop. If there is no such icon yet, "
                    "double-click %s once (it adds the icon)." % AUTOSTART_FILE)
        return "Then start the helper again: double-click %s and leave its window open." % START_FILE
    return "Then start the helper again."


def moved_tail_text():
    """The end of moved_text(), short because the page cuts that text at 400 characters. After a repair the old icon and the start-up
    setting still point at the old place, so on Windows the next step is setup-autostart-windows.bat, which makes the icon again and
    starts the helper (AUTOSTART.md says the same). Without that file: the hand start."""
    if IS_WIN:
        if has_autostart_file():
            return "Then double-click %s: it makes the Video Redline icon and starts the helper." % AUTOSTART_FILE
        return "Then double-click %s and leave its window open." % START_FILE
    return "It repairs the folder and keeps the speech models. Then start the helper again."


def stop_before_moving_text():
    """Windows only (a Mac gets ''): the line of the folder WARNING that comes before 'what to do in the new place'. The WARNING is printed
    by a helper that runs from the very folder it tells the person to move, and Windows will not move a folder while a program runs
    from it (AUTOSTART.md says the same), so the helper has to be ended first. A helper with a window of its own: close the window.
    A helper without one (VRT_BACKGROUND, the icon or the automatic start; its WARNING is in the log): stop-helper-windows.bat, named only
    when it lies in this folder, else the Task Manager way."""
    if not IS_WIN:
        return ""
    why = "Windows will not move a folder while the helper runs from it."
    if not background_mode():
        return "First close this window, which stops the helper. " + why
    if os.path.isfile(os.path.join(TOOLS_DIR, STOP_FILE)):
        return "First stop the helper (it runs without a window): double-click %s. %s" % (STOP_FILE, why)
    return ("First stop the helper (it runs without a window): end the pythonw.exe program that has this tools folder in its command line "
            "(%s), or sign out of Windows. %s" % (TASK_MANAGER_STEPS, why))


def move_to_new_place_text():
    """The last line of the folder WARNING: what to do once the folder has been moved."""
    if IS_WIN:
        if has_autostart_file():
            return ("After the move, run setup-windows.bat there once, then %s (it makes the Video Redline icon there), and open "
                    "Video Redline with that icon." % AUTOSTART_FILE)
        return "After the move, run setup-windows.bat there once, and start the helper from there (start-helper-windows.bat)."
    return "run the setup file there once, and start the helper from there."


def background_mode():
    """True when the environment variable VRT_BACKGROUND is set to anything except empty, 0, false or no. The helper then
    runs without a window of its own (the hidden start sets it), so its texts must not ask anybody to leave a window open
    or to close it."""
    return os.environ.get("VRT_BACKGROUND", "").strip().lower() not in ("", "0", "false", "no")


def how_to_stop_background():
    """One plain sentence on how to stop a helper that has no window. stop-helper-windows.bat is only named when it lies in
    this folder. Without it: the hidden helper is the pythonw.exe program that runs helper_launcher.pyw, so Task Manager shows
    no vrt_server.py; it is told apart by this tools folder in its command line."""
    if IS_WIN:
        if os.path.isfile(os.path.join(TOOLS_DIR, STOP_FILE)):
            return "To stop it: run %s." % STOP_FILE
        return ("To stop it: end the pythonw.exe program that has this tools folder in its command line (%s), "
                "or sign out of Windows." % TASK_MANAGER_STEPS)
    return "To stop it, end the python process called vrt_server.py (Activity Monitor shows it)."


def how_to_start_background():
    """One plain sentence on how to start a helper that has no window again. Windows: the Video Redline icon (the helper only runs
    without a window when the icon or the start-up setting started it, and the page cannot start it). A copy of the tools folder
    without setup-autostart-windows.bat has no icon to name, and the line above it (start_again_text, from the problem text) already
    says to start the helper by hand there: the same remedy, so the two lines do not disagree. Nothing for a Mac."""
    if IS_WIN:
        if has_autostart_file():
            return "To start it again: double-click the Video Redline icon on your Desktop."
        return "To start it again: double-click %s and leave its window open." % START_FILE
    return ""


def how_to_stop_running():
    """One plain sentence on how to stop a helper that is ALREADY RUNNING when it is not known whether it has a window of its own or
    runs hidden (the automatic start). True for both: closing the window of a helper that has one stops it; a hidden helper has no
    window, so stop-helper-windows.bat (only named when it lies in this folder) or Task Manager does it. The one that runs may
    belong to ANOTHER copy of the tools (any helper on the five numbers is found, whichever folder it runs from), and that file only
    stops a helper of its own folder: the text says so, instead of "this tools folder"."""
    if IS_WIN:
        if os.path.isfile(os.path.join(TOOLS_DIR, STOP_FILE)):
            return ("To stop it: close the window it runs in, or, if it runs hidden, double-click %s. That file only stops a helper that "
                    "runs from this same tools folder; for a helper from another copy of the tools, use the stop file in that copy." % STOP_FILE)
        return ("To stop it: close the window it runs in. If it runs hidden, end the pythonw.exe program that has the tools folder it "
                "runs from in its command line (%s), or sign out of Windows. That folder may be another copy of the tools."
                % TASK_MANAGER_STEPS)
    return "To stop it: close the Terminal window it runs in."


def stop_first_text():
    """One plain sentence for people who are about to repair, move, rename or replace the tools folder: a running helper
    holds files in it (the same sentence is in README.md). The Windows file stop-helper-windows.bat is named as an 'if'
    because a copy of the tools folder may not have it. Keep it short: moved_text() must stay under 400 characters."""
    if IS_WIN:
        return "If a helper is running, end it first: close its window, or double-click %s (if your tools folder has that file)." % STOP_FILE
    return "If the helper is running, end it first: close its Terminal window."


def _env_num(name, default, cast=float):
    try:
        v = os.environ.get(name)
        return default if v in (None, "") else cast(v)
    except ValueError:
        return default


DEFAULT_PORTS = (47831, 47832, 47833, 47834, 47835)
MAX_UPLOAD = int(_env_num("VRT_MAX_UPLOAD_BYTES", 6 * 1024 ** 3, int))        # 6 GB
MIN_FREE_MARGIN = int(_env_num("VRT_MIN_FREE_BYTES", 500 * 1024 * 1024, int))  # "+ 500 MB" in: free >= 1.2 x size + 500 MB
FREE_FACTOR = 1.2
CHUNK = 1024 * 1024                                                            # uploads are streamed to disk in 1 MB pieces
HEADER_TIMEOUT = 15.0                                                          # seconds to wait for the request headers
UPLOAD_IDLE_TIMEOUT = float(_env_num("VRT_SOCKET_TIMEOUT", 60.0))             # no byte received for this long = stalled
TTL_DONE = float(_env_num("VRT_TTL_DONE_S", 3600.0))                          # a finished transcript nobody fetched
TTL_ERROR = float(_env_num("VRT_TTL_ERROR_S", 900.0))                         # a failed job
TTL_CANCELLED = 300.0
STALL_LIMIT = float(_env_num("VRT_STALL_S", 1200.0))                          # transcribe.py silent this long = stuck
MAX_JOB_S = float(_env_num("VRT_MAX_JOB_S", 3 * 3600.0))                      # hard cap on how long ONE job may run (3 hours)
ABANDON_S = float(_env_num("VRT_ABANDON_S", 600.0))                           # nobody asked about a running job for this long
WATCH_S = max(0.1, float(_env_num("VRT_WATCH_S", 2.0)))                       # how often a running job is checked
GUARD_FREE_FLOOR = 1024 ** 3                                                   # free space must stay above max(margin, 1 GB)
SCRATCH_FLOOR = int(_env_num("VRT_SCRATCH_FLOOR_BYTES", 2 * 1024 ** 3, int))   # unpacked audio allowed: max(2 GB, 50 x upload) ...
SCRATCH_FACTOR = 50
SCRATCH_CEILING = int(_env_num("VRT_SCRATCH_CEILING_BYTES", 40 * 1024 ** 3, int))   # ... but never more than 40 GB
SPAWN_WAIT_S = 120.0                                                           # longest wait for another helper to start its job
CLAIM_WAIT_S = 90.0                                                            # longest wait for the speech tool's scratch folder
MAX_NAME = 200                                                                 # longest file name kept (the ending is always kept)
MAX_REQUEST_LINE = 8192
MAX_HEADER_BYTES = 16384
MAX_CONNECTIONS = 64
DEBUG = bool(os.environ.get("VRT_DEBUG"))

EXTENSIONS = (".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg")
PARAKEET_CHOICES = ("v2", "v3")
WHISPER_CHOICES = ("tiny.en", "tiny", "base.en", "base", "small.en", "small", "medium.en", "medium", "large-v1",
                   "large-v2", "large-v3", "large", "large-v3-turbo", "turbo", "distil-large-v3")
EXTRA_ORIGINS = set()                    # filled from --allow-origin
JOB_ID = re.compile(r"[0-9a-f]{32}")
LOCAL_ORIGIN = re.compile(r"http://(?:localhost|127\.0\.0\.1)(?::([0-9]{1,5}))?")

STAGE_TEXT = {
    "decode": "Reading the sound from your video",
    "analyse": "Measuring loudness and quiet gaps",
    "parakeet": "Finding every word and its exact time",
    "whisper": "Listening for the ums and uhs",
    "merge": "Putting it all together",
}


# ----------------------------------------------------------------------------------------------
# Console output. Printing goes through a queue and its own thread, so a stuck console window (on Windows, clicking
# inside a console window freezes whatever prints) can never freeze the server.
# ----------------------------------------------------------------------------------------------
class Console(object):
    def __init__(self):
        self._q = queue.Queue(maxsize=5000)
        self._thread = None
        self._lock = threading.Lock()

    def _start(self):
        with self._lock:
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, name="console", daemon=True)
                self._thread.start()

    def _run(self):
        while True:
            line = self._q.get()
            try:
                sys.stdout.write(line + "\n")
                sys.stdout.flush()
            except Exception:
                pass
            finally:
                self._q.task_done()

    def say(self, text=""):
        self._start()
        try:
            self._q.put_nowait(text)
        except queue.Full:
            pass

    def log(self, text):
        self.say(time.strftime("%H:%M:%S") + "  " + text)

    def flush(self, timeout=2.0):
        end = time.time() + timeout
        while self._q.unfinished_tasks and time.time() < end:
            time.sleep(0.02)


CON = Console()


def debug(text):
    if DEBUG:
        CON.say("[debug] " + text)


# ----------------------------------------------------------------------------------------------
# Small helpers
# ----------------------------------------------------------------------------------------------
def fmt_size(n):
    n = float(n)
    for unit, div in (("GB", 1024.0 ** 3), ("MB", 1024.0 ** 2), ("KB", 1024.0)):
        if n >= div:
            v = n / div
            return ("%.1f %s" % (v, unit)) if v < 100 else ("%d %s" % (round(v), unit))
    return "%d bytes" % n


def remove_quiet(path):
    try:
        os.remove(path)
    except OSError:
        pass


def rmtree_robust(path, tries=25, delay=0.25):
    """Delete a folder even if Windows still holds a file for a moment (a process that was just killed)."""
    for i in range(tries):
        if not os.path.exists(path):
            return True
        try:
            shutil.rmtree(path)
        except OSError:
            pass
        if not os.path.exists(path):
            return True
        time.sleep(delay)
    return not os.path.exists(path)


def make_private_dir(path):
    """Create a folder that only the current user can enter (mode 0700 where the operating system has such modes)."""
    os.makedirs(path, mode=0o700, exist_ok=True)
    if not IS_WIN:
        try:
            os.chmod(path, 0o700)
        except OSError:
            pass


def open_private_file(path):
    """Create a NEW file that only the current user can read or write (mode 0600 where supported). An existing file is
    never reused."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
    return os.fdopen(fd, "wb", buffering=0)


def tree_size(path):
    """Total size in bytes of every file below `path` (what is missing or unreadable counts as 0)."""
    total = 0
    stack = [path]
    while stack:
        p = stack.pop()
        try:
            with os.scandir(p) as it:
                for e in it:
                    try:
                        if e.is_dir(follow_symlinks=False):
                            stack.append(e.path)
                        elif e.is_file(follow_symlinks=False):
                            total += os.stat(e.path).st_size      # (not e.stat(): on Windows that can lag behind a growing file)
                    except OSError:
                        pass
        except OSError:
            pass
    return total


# ----------------------------------------------------------------------------------------------
# Who owns which folder in tmp/. Every running helper keeps an exclusive lock on tmp/<its folder>.lock until it ends (the
# operating system lets go of it however the helper ends), so "can I take the lock?" means "no running helper owns it".
# ----------------------------------------------------------------------------------------------
class FileLock(object):
    OFFSET = 1 << 20                  # (Windows) lock a spot far beyond the end of the file, so reading the file is never blocked

    def __init__(self, path):
        self.path = path
        self.fd = None

    def try_acquire(self):
        """True: now held. False: another program holds it. None: this drive or system cannot do file locks."""
        if self.fd is not None:
            return True
        try:
            fd = os.open(self.path, os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0), 0o600)
        except OSError:
            return None
        try:
            if IS_WIN:
                import msvcrt
                os.lseek(fd, self.OFFSET, 0)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, ImportError) as e:
            try:
                os.close(fd)
            except OSError:
                pass
            held = (errno.EACCES, errno.EAGAIN, getattr(errno, "EWOULDBLOCK", errno.EAGAIN), errno.EDEADLK)
            return False if getattr(e, "errno", None) in held else None
        self.fd = fd
        return True

    def write_note(self, text):
        """Put a short ASCII text at the start of the lock file (the locked spot lies far beyond it, so anybody can read it).
        Other helpers read it to tell the helper that holds this lock now from an earlier one that had the same name."""
        if self.fd is None:
            return
        try:
            os.lseek(self.fd, 0, 0)
            os.write(self.fd, text.encode("ascii", "replace"))
        except (OSError, ValueError):
            pass

    def release(self):
        fd, self.fd = self.fd, None
        if fd is None:
            return
        if IS_WIN:
            try:
                import msvcrt
                os.lseek(fd, self.OFFSET, 0)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            except Exception:
                pass
        try:
            os.close(fd)
        except OSError:
            pass


def acquire_with_wait(lock, seconds, stop=None):
    """Try for up to `seconds`. Returns what try_acquire returns (False = still held by someone else)."""
    end = time.time() + seconds
    while True:
        got = lock.try_acquire()
        if got is not False:
            return got
        if time.time() >= end or (stop is not None and stop()):
            return False
        time.sleep(0.1)


JOBS_NAME = re.compile(r"jobs(?:-[0-9]+)*")          # tmp/jobs (old shared folder), tmp/jobs-<port>, tmp/jobs-<port>-<pid>
TOKEN = re.compile(r"[0-9a-f]{16}")
# "token": a random word that tells THIS run of the helper from an earlier one that had the same folder name (same port).
# It is written into the lock file and into the owner mark of every scratch folder (see mark_run_dir).
_instance = {"name": "jobs", "lock": None, "token": secrets.token_hex(8)}


def lock_path_for(name):
    return os.path.join(TMP_DIR, name + ".lock")


def claim_instance_folder(port, wait=3.0):
    """Make tmp/jobs-<port> this helper's own folder (taking its lock first) and point JOBS_DIR at it. Returns its name."""
    global JOBS_DIR
    os.makedirs(TMP_DIR, exist_ok=True)
    names = ["jobs-%d" % port, "jobs-%d-%d" % (port, os.getpid())]
    for i, name in enumerate(names):
        lock = FileLock(lock_path_for(name))
        got = acquire_with_wait(lock, wait if i == 0 else 0.0)      # (a helper that is just closing on this port may still hold it)
        if got is False:
            continue
        _instance["name"], _instance["lock"] = name, (lock if got else None)
        if got:
            lock.write_note(_instance["token"] + "\n")
        JOBS_DIR = os.path.join(TMP_DIR, name)
        return name
    _instance["name"], _instance["lock"] = names[-1], None
    JOBS_DIR = os.path.join(TMP_DIR, names[-1])
    return names[-1]


def release_instance_folder():
    """On a clean stop: remove our (empty) folder and let go of the lock."""
    try:
        os.rmdir(JOBS_DIR)
    except OSError:
        pass
    lock, _instance["lock"] = _instance["lock"], None
    if lock is not None:
        lock.release()
        remove_quiet(lock.path)


def _other_job_names():
    """(folder-or-lock base name) of every tmp/jobs* entry that is not ours."""
    try:
        entries = os.listdir(TMP_DIR)
    except OSError:
        return []
    out = set()
    for n in entries:
        base = n[:-5] if n.endswith(".lock") else n
        if base != _instance["name"] and JOBS_NAME.fullmatch(base):
            out.add(base)
    return sorted(out)


def clean_old_job_folders():
    """At start: delete the job folders of helpers that are NOT running any more (and the old shared tmp/jobs). A folder is
    only touched when its lock can be taken, i.e. when no running helper owns it."""
    for name in _other_job_names():
        lock = FileLock(lock_path_for(name))
        if lock.try_acquire() is not True:
            continue                                                  # owned by a running helper (or locks do not work here)
        try:
            folder = os.path.join(TMP_DIR, name)
            if os.path.isdir(folder):
                rmtree_robust(folder, tries=12, delay=0.2)
            gone = not os.path.exists(folder)
        finally:
            lock.release()
        if gone:
            remove_quiet(lock.path)


def other_helpers_alive():
    """True if another helper is running (or if we cannot tell)."""
    for name in _other_job_names():
        lock = FileLock(lock_path_for(name))
        if lock.try_acquire() is True:
            lock.release()
        else:
            return True                                               # held by a running helper, or we cannot tell
    return False


RUN_DIR_BASE = TMP_DIR
SPAWN_LOCK_PATH = os.path.join(TMP_DIR, "spawn.lock")


def clean_spawn_lock(path=None):
    """Delete tmp/spawn.lock, the lock file that all helpers share while a job starts (see run_job). It is never deleted while a job
    runs, because another helper may be about to use it; it is harmless but untidy, so it goes when nobody needs it: no other helper
    runs and nobody holds it. Called at start-up and when a job has found its scratch folder. Any doubt means: leave it. Never raises."""
    path = SPAWN_LOCK_PATH if path is None else path
    try:
        if not os.path.exists(path) or other_helpers_alive():
            return
        lock = FileLock(path)
        if lock.try_acquire() is not True:
            return                                                    # a job is just starting, or locks do not work here
        lock.release()
        remove_quiet(path)
    except Exception:
        pass


def run_dir_names():
    """transcribe.py keeps its decoded audio in tmp/run-*/ and deletes it itself when it ends normally. When we have to
    kill it (cancel, window closed, stuck) that clean-up never runs, so the helper does it."""
    try:
        return set(n for n in os.listdir(RUN_DIR_BASE) if n.startswith("run-") and os.path.isdir(os.path.join(RUN_DIR_BASE, n)))
    except OSError:
        return set()


RUN_OWNER_FILE = "vrt-owner.txt"                      # inside tmp/run-*: who made it (transcribe.py deletes the whole folder, mark included)


def mark_run_dir(name):
    """Write the owner mark of the scratch folder tmp/<name> that this helper's job made: the name of this helper's own folder
    (tmp/jobs-<port>) and its token. If this helper is killed in the middle of the job, a helper that starts later can see that
    the owner is gone and delete the folder at once (see clean_stale_run_dirs). Without a working lock nobody could tell
    whether this helper is alive, so then no mark is written. Never raises."""
    if _instance["lock"] is None:
        return
    try:
        with open(os.path.join(RUN_DIR_BASE, name, RUN_OWNER_FILE), "w", encoding="ascii", newline="\n") as f:
            f.write("%s %s\n" % (_instance["name"], _instance["token"]))
    except (OSError, ValueError):
        pass                                                  # the folder is already gone (the job ended): nothing to mark


def run_dir_owner(name):
    """(folder name of the owner, token) from the mark in tmp/<name>, or None when there is no readable mark (a run of the
    drag-and-drop launcher, a helper from before the marks, a folder that is just being made)."""
    try:
        with open(os.path.join(RUN_DIR_BASE, name, RUN_OWNER_FILE), "rb") as f:
            parts = f.read(200).decode("ascii", "replace").split()
    except OSError:
        return None
    if len(parts) == 2 and JOBS_NAME.fullmatch(parts[0]) and TOKEN.fullmatch(parts[1]):
        return parts[0], parts[1]
    return None


def owner_is_gone(owner):
    """True only when it is certain that the helper which wrote this owner mark is not running any more. 'Cannot tell' (the
    drive does not do file locks, the lock file cannot be read) counts as still running."""
    name, token = owner
    if token == _instance["token"]:
        return False                                              # this very helper
    if name == _instance["name"] and _instance["lock"] is not None:
        return True                                               # we hold that folder's lock now, so the earlier helper with that name has ended
    path = lock_path_for(name)
    if not os.path.exists(path):
        return True                                               # no lock file: nobody holds that name (a helper that ended removes it)
    lock = FileLock(path)
    got = lock.try_acquire()
    if got is True:
        lock.release()
        return True                                               # not held: that helper was killed
    if got is None:
        return False
    try:
        with open(path, "rb") as f:
            now = f.read(64).decode("ascii", "replace").strip()
    except OSError:
        return False
    return bool(TOKEN.fullmatch(now)) and now != token            # held by a LATER helper that took the same name over


def start_claim(job, proc, before, spawn_lock):
    """Find out WHICH tmp/run-* folder this job's process makes, so that only that one is ever measured or deleted: another
    helper may have a job of its own, and the drag-and-drop launcher uses the same tmp folder. While we look, other helpers
    wait for the spawn lock, so the new folder can only be ours."""
    def work():
        try:
            end = time.time() + CLAIM_WAIT_S
            while True:
                gone = proc.poll() is not None
                new = run_dir_names() - before
                if new:
                    with job.lock:
                        job.run_dirs |= new
                    for n in sorted(new):
                        debug("job %s owns scratch folder(s): %s" % (job.id[:6], n))
                        mark_run_dir(n)
                    return
                if gone or time.time() > end:
                    return
                time.sleep(0.05)
        finally:
            spawn_lock.release()
            clean_spawn_lock(spawn_lock.path)                         # (only when no other helper runs: one file less in tmp)

    t = threading.Thread(target=work, name="claim-" + job.id[:6], daemon=True)
    job.claim_thread = t
    t.start()


def sweep_run_dirs(job):
    """Delete the scratch folder(s) this job's process made (call after the process is dead)."""
    t = getattr(job, "claim_thread", None)
    if t is not None and t is not threading.current_thread():
        t.join(timeout=10.0)
    with job.lock:
        mine = set(job.run_dirs)
    for n in mine:
        rmtree_robust(os.path.join(RUN_DIR_BASE, n), tries=8)


def clean_stale_run_dirs(min_age=300.0):
    """At start: scratch folders left by a run that was killed hard. (Windows refuses to delete a file that is still open,
    so a run that is genuinely working is never harmed there; the caller does not call this while another helper runs.)
    A folder that carries the owner mark of a helper that has certainly ended is stale at once, whatever its age. Every other
    folder (no mark, or its owner is running, or is this helper) is stale when it is older than min_age seconds, as before."""
    now = time.time()
    for n in run_dir_names():
        p = os.path.join(RUN_DIR_BASE, n)
        try:
            owner = run_dir_owner(n)
            if (owner is not None and owner_is_gone(owner)) or now - os.path.getmtime(p) > min_age:
                rmtree_robust(p, tries=3, delay=0.2)
        except Exception:                                      # (start-up must never fail because of a scratch folder)
            pass


def clean_orphaned_run_dirs():
    """At start, while another helper is running: delete only the scratch folders whose owner mark says that their helper has
    ended. Folders of a running helper, folders without a mark and the age rule are left alone (the running helper may own
    them)."""
    for n in run_dir_names():
        try:
            owner = run_dir_owner(n)
            if owner is not None and owner_is_gone(owner):
                rmtree_robust(os.path.join(RUN_DIR_BASE, n), tries=3, delay=0.2)
        except Exception:
            pass


def child_env():
    """The same clean environment the launchers use, so settings from other software cannot break our private Python."""
    env = dict(os.environ)
    for k in ("PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONUSERBASE", "PYTHONEXECUTABLE", "__PYVENV_LAUNCHER__"):
        env.pop(k, None)
    env["HF_HOME"] = os.path.join(TOOLS_DIR, "hf-cache")
    env["HF_HUB_OFFLINE"] = "1"
    env["HF_HUB_DISABLE_TELEMETRY"] = "1"
    env["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def private_python():
    cand = os.path.join(TOOLS_DIR, "venv", "Scripts", "python.exe") if IS_WIN else os.path.join(TOOLS_DIR, "venv", "bin", "python")
    if os.path.exists(cand) or os.path.islink(cand):
        return cand
    return sys.executable


def popen_kwargs():
    if IS_WIN:
        return {"creationflags": 0x08000000}          # CREATE_NO_WINDOW: no extra black windows
    return {"start_new_session": True}                 # its own process group, so the whole tree can be stopped


def kill_tree(proc, wait=10.0):
    """Stop a process AND everything it started (the private Python on Windows is a launcher that starts the real one)."""
    if proc is None:
        return
    if proc.poll() is not None:
        return                      # already gone: its number may belong to an unrelated program by now, never touch it
    pid = proc.pid
    try:
        if IS_WIN:
            tk = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "taskkill.exe")
            try:
                subprocess.run([tk, "/PID", str(pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               stdin=subprocess.DEVNULL, creationflags=0x08000000, timeout=30)
            except Exception:
                pass
            try:
                proc.kill()
            except Exception:
                pass
        else:
            try:
                pgid = os.getpgid(pid)
            except OSError:
                pgid = None
            for sig, grace in ((signal.SIGTERM, 2.0), (signal.SIGKILL, 0.0)):
                try:
                    if pgid:
                        os.killpg(pgid, sig)
                    else:
                        os.kill(pid, sig)
                except OSError:
                    pass
                end = time.time() + grace
                while grace and time.time() < end and proc.poll() is None:
                    time.sleep(0.05)
                if proc.poll() is not None:
                    break
    finally:
        try:
            proc.wait(timeout=wait)
        except Exception:
            pass


_PATH_PATTERNS = (
    re.compile(r"[A-Za-z]:[\\/][^\s\"'<>|)]*"),                       # C:\Users\...
    re.compile(r"\\\\[^\s\"'<>|)]+"),                                  # \\server\share
    re.compile(r"(?<![\w.:/-])/(?:[\w.~+@-]+/)+[\w.~+@-]*"),          # /Users/me/file
)


def scrub(text, limit=300):
    """Plain-language text that is safe to show on the page: no file paths, no stack traces, no 'technical detail'."""
    if not text:
        return ""
    t = str(text)
    for p in (TOOLS_DIR, JOBS_DIR):
        t = t.replace(p, "")
    t = re.sub(r"\s*\((?:technical detail|technical note)[^)]*\)", "", t, flags=re.I)
    for pat in _PATH_PATTERNS:
        t = pat.sub("", t)
    t = re.sub(r"Traceback \(most recent call last\).*", "", t, flags=re.S)
    t = re.sub(r"\s+", " ", t).strip(" :;,-")
    t = t.replace(" .", ".").replace(" ,", ",")
    return t[:limit]


# ----------------------------------------------------------------------------------------------
# Is the speech toolkit installed? (packages + models), checked once and cached
# ----------------------------------------------------------------------------------------------
def _glob_size_ok(pattern_dir_prefix, filename_test, min_bytes):
    hub = os.path.join(TOOLS_DIR, "hf-cache", "hub")
    try:
        entries = os.listdir(hub)
    except OSError:
        return False
    for d in entries:
        if not d.startswith("models--") or not pattern_dir_prefix(d.lower()):
            continue
        snaps = os.path.join(hub, d, "snapshots")
        try:
            for s in os.listdir(snaps):
                folder = os.path.join(snaps, s)
                for f in os.listdir(folder):
                    if filename_test(f.lower()):
                        try:
                            if os.path.getsize(os.path.join(folder, f)) >= min_bytes:
                                return True
                        except OSError:
                            pass
        except OSError:
            continue
    return False


def models_problem():
    """None if some Parakeet model, some Whisper model and the voice detector are on disk, else plain-language text."""
    ok_p = _glob_size_ok(lambda d: "parakeet" in d, lambda f: f.endswith(".onnx") and "encoder" in f, 50 * 1024 * 1024)
    ok_w = _glob_size_ok(lambda d: "whisper" in d, lambda f: f == "model.bin", 10 * 1024 * 1024)
    ok_v = _glob_size_ok(lambda d: "silero" in d, lambda f: f.endswith(".onnx"), 100 * 1024)
    if ok_p and ok_w and ok_v:
        return None
    return ("The speech models have not been downloaded yet. " + how_to_run(SETUP_FILE)
            + " Wait for ALL DONE. " + start_again_text())


def setup_text():
    return ("The speech tools are not set up on this computer yet. " + how_to_run(SETUP_FILE)
            + " Wait for ALL DONE. " + start_again_text())


def moved_text():
    """The page shows this as the first line of its help card and cuts it at 400 characters (cleanup-panel.js, helpCard), so
    the whole text must be shorter than that on Windows and on a Mac (a test checks)."""
    return ("This tools folder was moved, renamed or copied after setup, so the speech tools cannot find their Python. "
            + stop_first_text() + " " + how_to_run(SETUP_FILE) + " " + moved_tail_text())


class Readiness(object):
    def __init__(self):
        self.lock = threading.Lock()
        self.ready = False
        self.checking = True
        self.problem = "The helper is still starting up. Wait a few seconds and try again."
        self.checked_at = 0.0
        self._running = False

    def snapshot(self):
        with self.lock:
            return self.ready, self.checking, self.problem

    def _run_cli(self, py, flag):
        r = subprocess.run([py, TRANSCRIBE_PY, flag], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, env=child_env(), cwd=TOOLS_DIR, timeout=180, **popen_kwargs())
        return r.returncode, r.stdout.decode("utf-8", "replace")

    def compute(self):
        """(ready, problem) - runs transcribe.py --check-venv and --check-packages, then looks for the model files."""
        py = private_python()
        if not os.path.isfile(TRANSCRIBE_PY):
            return False, "The other files that belong with the helper (such as transcribe.py) are missing. Use the complete tools folder."
        if not (os.path.exists(py) or os.path.islink(py)):
            return False, setup_text()
        try:
            rc, out = self._run_cli(py, "--check-venv")
            if rc != 0:
                return False, moved_text()
            rc, out = self._run_cli(py, "--check-packages")
            if rc != 0:
                what = explain_failure(rc, *extract_problem(out))
                return False, what[1] if what[0] == "not-ready" else (
                    "The speech tools could not be loaded on this computer. " + (scrub(extract_problem(out)[0]) or setup_text()))
        except subprocess.TimeoutExpired:
            return False, "Checking the speech tools took too long. The computer may be busy with other programs."
        except OSError:
            return False, setup_text()
        mp = models_problem()
        if mp:
            return False, mp
        return True, None

    def refresh(self):
        with self.lock:
            if self._running:
                return
            self._running = True
        try:
            ready, problem = self.compute()
        except Exception as e:                                   # never let a check kill the helper
            debug("readiness check failed: %r" % (e,))
            ready, problem = False, "I could not check the speech tools just now."
        with self.lock:
            self.ready, self.problem, self.checking = ready, problem, False
            self.checked_at = time.time()
            self._running = False

    def refresh_if_stale(self, max_age=8.0):
        """Called from /status: if we are not ready, look again now and then (the user may have just run setup)."""
        with self.lock:
            stale = (not self.ready) and (not self._running) and (time.time() - self.checked_at > max_age)
        if stale:
            threading.Thread(target=self.refresh, name="ready-check", daemon=True).start()


READY = Readiness()
_startup = {"sync_warning": False}        # start_sync_check() sets it once, before the helper starts to answer (see main): did the start-up check find a cloud-synced or network folder? (see /status)


# ----------------------------------------------------------------------------------------------
# Turning what transcribe.py printed into a message for the page
# ----------------------------------------------------------------------------------------------
def extract_problem(output):
    problem, todo = "", ""
    for raw in (output or "").splitlines():
        s = raw.strip()
        if s.startswith("PROBLEM:"):
            problem = s[8:].strip()
        elif s.startswith("WHAT TO DO:"):
            todo = s[11:].strip()
    return problem, todo, output or ""


def explain_failure(rc, problem, todo, output, stalled=False):
    """(code, plain-language message). Never contains a file path or a stack trace."""
    if stalled:
        return "failed", ("The speech engine stopped responding, so I stopped it. Close other programs and try again, or try "
                          "a shorter recording.")
    p = (problem or "").lower()
    t = (todo or "").lower()
    both = p + " " + t
    if "no audio track" in p:
        return "no-audio", ("This recording has no audio track, so there is nothing to transcribe. (A screen recording made "
                            "with the microphone switched off has no sound.)")
    if "too damaged" in p or "empty or too short" in p:
        return "bad-media", scrub(problem) or "The audio in this file could not be read."
    if "could not open that file" in p or "could not find that file" in p or "can't find that file" in p:
        return "bad-media", ("I could not open that file as a video or audio recording. It may be damaged, still being "
                             "recorded or copied, or in a format I do not know. Try playing it in a video player first.")
    if "disk is full" in p or "can't save files" in p or "no space" in both:
        return "disk-full", "The disk is full, so I can't unpack the audio. Free up a few hundred MB on this drive and try again."
    if "ran out of memory" in both:
        return "out-of-memory", ("The computer ran out of memory while working on this recording. Close other programs and "
                                 "try again. If it keeps happening, ask for the lighter settings (a smaller Whisper model, "
                                 "or no Whisper).")
    if "visual c++" in both:
        return "not-ready", ("This computer is missing a free Microsoft component (the Microsoft Visual C++ Redistributable) "
                             "that the speech engines need. Download it from https://aka.ms/vs/17/release/vc_redist.x64.exe, "
                             "open it and click Install. (Installing needs an administrator.) " + start_again_text(short=True))
    if "moved or copied" in p or "moved, renamed" in p:
        return "not-ready", moved_text()
    if ("not been downloaded" in p or "partly downloaded" in p or "not installed correctly" in p
            or "setup file" in both or "not downloaded completely" in p):
        return "not-ready", ("The speech tools are not fully set up on this computer. " + how_to_run(SETUP_FILE)
                             + " Wait for ALL DONE. " + start_again_text())
    if problem:
        msg = scrub(problem)
        if msg and "went wrong" not in msg.lower():
            return "failed", msg
    if rc is not None and (rc < 0 or rc > 255 or rc in (137, 139)):
        return "out-of-memory", ("The speech engine stopped suddenly. The computer may have run out of memory. Close other "
                                 "programs and try again.")
    if background_mode():                                          # (no window: the text of the helper is in the logs folder, if anywhere)
        return "failed", ("Something unexpected went wrong while making the transcript. Try once more. If it keeps happening, "
                          "send the files in the logs folder of the tools folder (if there are any) to the person who invited you to the beta.")
    return "failed", ("Something unexpected went wrong while making the transcript. Try once more. If it keeps happening, send "
                      "the helper window text (and logs/last-error.txt from the tools folder, if there is one) to the person "
                      "who invited you to the beta.")


# ----------------------------------------------------------------------------------------------
# Jobs
# ----------------------------------------------------------------------------------------------
class Job(object):
    def __init__(self, jid, ext, size, name, origin):
        self.id = jid
        self.ext = ext
        self.size = size
        self.name = name                              # the page's own file name (kept in memory only, put back in the result)
        self.origin = origin
        self.dir = os.path.join(JOBS_DIR, jid)
        self.input = os.path.join(self.dir, "input" + ext)
        self.result = os.path.join(self.dir, "result.json")
        self.lock = threading.RLock()
        self.state = "uploading"                      # uploading (internal) | running | done | error | cancelled
        self.stage = "starting"
        self.percent = 0
        self.eta = None
        self.message = "Getting ready"
        self.error = None
        self.proc = None
        self.cancel_requested = False
        self.stalled = False
        self.created = time.time()
        self.finished = None
        self.fetched = False
        self.fetched_at = None
        self.last_output = time.time()
        self.last_seen = time.time()                  # the last time the page asked about this job (GET /jobs/<id> or /result)
        self.t_start = None
        self.guard = None                             # (code, message) when a safety limit stopped the job
        self.run_dirs = set()                         # the tmp/run-* folder(s) that THIS job's speech process made
        self.claim_thread = None

    def view(self):
        with self.lock:
            st = "running" if self.state == "uploading" else self.state
            return {"job": self.id, "state": st, "stage": self.stage, "percent": int(self.percent),
                    "etaSeconds": self.eta, "message": self.message, "error": self.error}


class Registry(object):
    def __init__(self):
        self.lock = threading.RLock()
        self.jobs = {}
        self.active = None

    def busy(self):
        with self.lock:
            return self.active is not None

    def claim(self, job):
        with self.lock:
            if self.active is not None:
                return False
            self.active = job
            self.jobs[job.id] = job
            return True

    def release(self, job):
        with self.lock:
            if self.active is job:
                self.active = None

    def get(self, jid):
        with self.lock:
            return self.jobs.get(jid)

    def forget(self, job):
        with self.lock:
            self.jobs.pop(job.id, None)
            if self.active is job:
                self.active = None

    def all(self):
        with self.lock:
            return list(self.jobs.values())


REG = Registry()


def parse_options(header):
    """Validate the X-Options header against the allow-list. Returns a dict; raises ValueError(plain message)."""
    if header is None or header.strip() == "":
        return {}
    if len(header) > 2048:
        raise ValueError("The options are too long.")
    try:
        d = json.loads(header)
    except ValueError:
        raise ValueError("The options are not valid.")
    if not isinstance(d, dict):
        raise ValueError("The options are not valid.")
    out = {}
    v = d.get("parakeet")
    if v is not None:
        if v not in PARAKEET_CHOICES:
            raise ValueError("The Parakeet model must be v2 or v3.")
        out["parakeet"] = v
    v = d.get("whisper")
    if v is not None:
        if not isinstance(v, str) or v not in WHISPER_CHOICES:
            raise ValueError("That Whisper model is not one I know.")
        out["whisper"] = v
    for key in ("noWhisper", "noParakeet"):
        v = d.get(key)
        if v is not None:
            if not isinstance(v, bool):
                raise ValueError("The option %s must be true or false." % key)
            if v:
                out[key] = True
    v = d.get("threads")
    if v is not None:
        if isinstance(v, bool) or not isinstance(v, int) or v < 1 or v > 64:
            raise ValueError("The number of threads must be a whole number from 1 to 64.")
        out["threads"] = v
    if out.get("noWhisper") and out.get("noParakeet"):
        raise ValueError("Both speech engines are switched off, so there would be nothing to do.")
    return out


def clean_name(raw):
    """The page's file name without folders or control characters (kept only to put back into the transcript)."""
    name = (raw or "").replace("\\", "/").split("/")[-1]
    name = "".join(ch for ch in name if ch >= " " and ch != "\x7f").strip()
    if len(name) > MAX_NAME:
        stem, ext = os.path.splitext(name)
        if 0 < len(ext) <= 16:                        # a normal ending: shorten the stem, never the ending
            return stem[:max(1, MAX_NAME - len(ext))] + ext
        return name[:MAX_NAME]
    return name


def free_floor():
    """Free space on the drive must never fall below this while a job works."""
    return max(MIN_FREE_MARGIN, GUARD_FREE_FLOOR)


def scratch_limit(upload_size):
    """How much unpacked audio one job may leave in its scratch folder: max(2 GB, 50 x the upload), never more than 40 GB."""
    return min(SCRATCH_CEILING, max(SCRATCH_FLOOR, SCRATCH_FACTOR * int(upload_size)))


def guard_problem(upload_size, free, scratch):
    """None, or (code, plain-language message) when a running job has to be stopped to protect the drive."""
    if free < free_floor():
        return ("disk-full", "This recording expands to far more space than your drive has (only %s are left), so I stopped it "
                             "before the drive filled up. Free up some space, or try a shorter file." % fmt_size(max(0, free)))
    cap = scratch_limit(upload_size)
    if scratch > cap:
        return ("disk-full", "This recording expands to far more space than a file of this size should (more than %s), so I "
                             "stopped it to protect your drive. Try a shorter file." % fmt_size(cap))
    return None


def fmt_span(seconds):
    s = float(seconds)
    if s >= 3600:
        v, unit = s / 3600.0, "hour"
    elif s >= 60:
        v, unit = s / 60.0, "minute"
    else:
        v, unit = s, "second"
    v = int(round(v)) if abs(v - round(v)) < 0.05 else round(v, 1)
    return "%s %s%s" % (v, unit, "" if v == 1 else "s")


def disk_check(size):
    need = int(size * FREE_FACTOR) + free_floor()
    try:
        make_private_dir(JOBS_DIR)
        free = shutil.disk_usage(JOBS_DIR).free
    except OSError:
        return True, 0, need
    return free >= need, free, need


def origin_text(origin):
    if origin is None:
        return "a program on this computer"
    if origin == "null" or origin == "file://":
        return "a page opened from a file"
    return "a page at " + origin[:60]


def start_job(job, options):
    t = threading.Thread(target=run_job, args=(job, options), name="job-" + job.id[:6], daemon=True)
    t.start()


def finish_error(job, code, message):
    with job.lock:
        if job.state in ("cancelled", "done"):
            return
        job.state = "error"
        job.error = code
        job.message = message
        job.eta = None
        job.finished = time.time()
    remove_quiet(job.input)                            # the big file is not needed any more
    REG.release(job)
    CON.log("Job failed: " + message)


def finish_done(job, elapsed):
    with job.lock:
        job.state = "done"
        job.percent = 100
        job.stage = "done"
        job.eta = None
        job.message = "Your transcript is ready."
        job.finished = time.time()
    remove_quiet(job.input)
    REG.release(job)
    CON.log("Job finished in %d s. The page can pick up the transcript now." % int(elapsed))


def cancel_job(job, why="Cancelled."):
    """Stop the work, kill the whole process tree, delete the folder. Safe to call twice."""
    with job.lock:
        was = job.state
        if was in ("cancelled",):
            return
        job.cancel_requested = True
        proc = job.proc
        if was in ("running", "uploading"):
            job.state = "cancelled"
            job.message = why
            job.error = None
            job.eta = None
            job.finished = time.time()
    kill_tree(proc)
    if proc is not None:
        sweep_run_dirs(job)
    rmtree_robust(job.dir)
    REG.release(job)
    if was in ("running", "uploading"):
        CON.log("Job cancelled.")


def run_job(job, options):
    cmd = [private_python(), TRANSCRIBE_PY, job.input, "--out", job.result, "--machine"]
    if options.get("parakeet"):
        cmd += ["--parakeet", options["parakeet"]]
    if options.get("whisper"):
        cmd += ["--whisper", options["whisper"]]
    if options.get("noWhisper"):
        cmd.append("--no-whisper")
    if options.get("noParakeet"):
        cmd.append("--no-parakeet")
    if options.get("threads"):
        cmd += ["--threads", str(options["threads"])]
    # Only one helper at a time may be in the short window between starting transcribe.py and its scratch folder appearing,
    # so that folder can be told apart from the ones other helpers make (see start_claim).
    spawn_lock = FileLock(SPAWN_LOCK_PATH)
    acquire_with_wait(spawn_lock, SPAWN_WAIT_S, stop=lambda: job.cancel_requested)
    if job.cancel_requested:
        spawn_lock.release()
        return
    job.t_start = time.time()
    job.last_seen = job.last_output = job.t_start     # (the upload may have taken a while: the clocks start now)
    before = run_dir_names()
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                env=child_env(), cwd=TOOLS_DIR, **popen_kwargs())
    except OSError as e:
        spawn_lock.release()
        debug("could not start transcribe.py: %r" % (e,))
        finish_error(job, "not-ready", setup_text())
        return
    with job.lock:
        job.proc = proc
        cancelled = job.cancel_requested
    start_claim(job, proc, before, spawn_lock)
    if cancelled:
        kill_tree(proc)
        sweep_run_dirs(job)
        return

    def stop_for(code, message):
        with job.lock:
            if job.guard is None:
                job.guard = (code, message)
        CON.log("Stopping the job: " + message)
        kill_tree(proc)

    def watchdog():
        prev = time.time()
        awake = 0.0                                   # seconds this job has really been running (time asleep does not count)
        while proc.poll() is None:
            time.sleep(WATCH_S)
            if job.cancel_requested:
                return
            now = time.time()
            dt, prev = now - prev, now
            if dt > max(30.0, 10 * WATCH_S):          # the computer was asleep (or frozen): nobody is to blame for that
                job.last_seen = max(job.last_seen, now)
                job.last_output = max(job.last_output, now)
                dt = WATCH_S
            awake += dt
            if now - job.last_output > STALL_LIMIT:
                job.stalled = True
                kill_tree(proc)
                return
            if awake > MAX_JOB_S:
                stop_for("failed", "This recording is taking longer than %s, so I stopped it. Try a shorter recording, or ask "
                                   "for the lighter settings (a smaller Whisper model, or no Whisper)." % fmt_span(MAX_JOB_S))
                return
            if now - job.last_seen > ABANDON_S:
                CON.log("Nobody has asked about this job for %s (the page was probably closed or reloaded). Stopping it."
                        % fmt_span(ABANDON_S))
                cancel_job(job, "The page went away, so the helper stopped this job.")
                return
            try:
                free = shutil.disk_usage(RUN_DIR_BASE).free
                with job.lock:
                    mine = list(job.run_dirs)
                scratch = sum(tree_size(os.path.join(RUN_DIR_BASE, n)) for n in mine)
            except OSError:
                continue
            bad = guard_problem(job.size, free, scratch)
            if bad:
                stop_for(*bad)
                return

    threading.Thread(target=watchdog, name="watch-" + job.id[:6], daemon=True).start()

    tail = collections.deque(maxlen=200)
    last_stage = None
    try:
        for raw in iter(proc.stdout.readline, b""):
            job.last_output = time.time()
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if line.startswith("PROGRESS "):
                try:
                    d = json.loads(line[9:])
                except ValueError:
                    continue
                if isinstance(d, dict):
                    last_stage = apply_progress(job, d, last_stage)
            elif line.strip():
                tail.append(line)
    except (OSError, ValueError):
        pass
    try:
        rc = proc.wait()
    except Exception:
        rc = None
    if job.cancel_requested:
        return
    output = "\n".join(tail)
    problem, todo, _ = extract_problem(output)
    ok = rc == 0 and os.path.isfile(job.result) and os.path.getsize(job.result) > 2
    if not ok and (job.stalled or job.guard or not problem):
        sweep_run_dirs(job)                          # it died without cleaning up after itself (killed, crashed, out of memory)
    if job.guard and not ok:                         # stopped by a safety limit (drive filling up, too long)
        finish_error(job, job.guard[0], job.guard[1])
        return
    if ok:
        finish_done(job, time.time() - job.t_start)
    else:
        debug("transcribe.py exited with %r; last lines:\n%s" % (rc, output[-1500:]))
        code, msg = explain_failure(rc, problem, todo, output, stalled=job.stalled)
        finish_error(job, code, msg)


def apply_progress(job, d, last_stage):
    stage = d.get("stage")
    stage = stage if isinstance(stage, str) and re.fullmatch(r"[a-z_]{1,24}", stage) else job.stage
    try:
        pct = int(d.get("percent", 0))
    except (TypeError, ValueError):
        pct = 0
    pct = max(0, min(99, pct))
    rem = d.get("remaining")
    eta = int(rem) if isinstance(rem, (int, float)) and not isinstance(rem, bool) and 0 <= rem < 10 ** 7 else None
    label = STAGE_TEXT.get(stage) or scrub(d.get("label"), 80) or "Working"
    detail = d.get("detail")
    extra = ""
    if isinstance(detail, str):
        if re.fullmatch(r"\d{1,3}:\d\d(?::\d\d)? of \d{1,3}:\d\d(?::\d\d)?", detail.strip()):
            extra = " (" + detail.strip() + ")"
        elif detail.strip().lower() == "loading the model":
            extra = " (getting ready)"
    with job.lock:
        if job.state != "running" and job.state != "uploading":
            return last_stage
        job.stage = stage
        job.percent = max(job.percent, pct)               # never goes backwards
        job.eta = eta
        job.message = label + extra
    if stage != last_stage:
        CON.log("Working: " + label)
    return stage


# ----------------------------------------------------------------------------------------------
# HTTP
# ----------------------------------------------------------------------------------------------
def origin_allowed(origin):
    if origin == "null" or origin == "file://":          # a page opened from a file ("file://" is what Safari may send)
        return True
    m = LOCAL_ORIGIN.fullmatch(origin)
    if m:
        return m.group(1) is None or int(m.group(1)) <= 65535
    return origin in EXTRA_ORIGINS


class HelperServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = not IS_WIN          # on Windows SO_REUSEADDR would let a second program share our port
    request_queue_size = 64

    def __init__(self, addr, handler):
        self._conn_lock = threading.Lock()
        self._conns = 0
        ThreadingHTTPServer.__init__(self, addr, handler)

    def process_request(self, request, client_address):
        with self._conn_lock:
            if self._conns >= MAX_CONNECTIONS:
                try:
                    request.close()
                except OSError:
                    pass
                return
            self._conns += 1
        ThreadingHTTPServer.process_request(self, request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            ThreadingHTTPServer.process_request_thread(self, request, client_address)
        finally:
            with self._conn_lock:
                self._conns -= 1

    def handle_error(self, request, client_address):
        if DEBUG:
            import traceback
            CON.say("[debug] " + traceback.format_exc())


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = HEADER_TIMEOUT
    server_version = "VideoReviewHelper/" + HELPER_VERSION
    sys_version = ""

    # ---- plumbing --------------------------------------------------------------------------------
    def version_string(self):
        return self.server_version

    def log_message(self, fmt, *args):
        pass

    def handle(self):
        self.close_connection = True
        self.body_remaining = 0
        self.cors_origin = None
        self.replied = False
        try:
            self.handle_one_request()
        finally:
            self._linger()

    def parse_request(self):
        if len(self.raw_requestline) > MAX_REQUEST_LINE:
            self.requestline, self.request_version, self.command = "", "HTTP/1.1", ""
            self.send_error(414, "Request too long")
            return False
        ok = BaseHTTPRequestHandler.parse_request(self)
        if ok:
            size = sum(len(k) + len(v) + 4 for k, v in self.headers.items())
            if size > MAX_HEADER_BYTES:
                self.send_error(431, "Request headers too large")
                return False
        return ok

    def send_error(self, code, message=None, explain=None):
        """Parse-level errors (the base class would send an HTML page)."""
        table = {400: ("bad-request", "That request could not be understood."),
                 414: ("bad-request", "The request address is too long."),
                 431: ("bad-request", "The request headers are too large."),
                 501: ("method-not-allowed", "That kind of request is not supported."),
                 505: ("bad-request", "That HTTP version is not supported.")}
        err, msg = table.get(code, ("bad-request", "That request could not be handled."))
        self.close_connection = True
        self.cors_origin = None
        self._send_json(code, {"error": err, "message": msg})

    def _cors_headers(self):
        if self.cors_origin is not None:
            self.send_header("Access-Control-Allow-Origin", self.cors_origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Type, X-Helper")
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send_bytes(self, code, body, ctype, extra=()):
        if self.replied:
            return
        self.replied = True
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        if code != 204:
            self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Helper", HELPER_ID + "/" + HELPER_VERSION)
        self.send_header("Connection", "close")
        self._cors_headers()
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        self.wfile.flush()
        self.close_connection = True

    def _send_json(self, code, obj, extra=()):
        self._send_bytes(code, json.dumps(obj, ensure_ascii=True, separators=(",", ":")).encode("ascii"),
                         "application/json; charset=utf-8", extra)

    def fail(self, code, err, message, extra=()):
        self._send_json(code, {"error": err, "message": message}, extra)

    def _linger(self):
        """If the page is still sending a body we refused, read (and drop) it for a moment before closing, so the
        browser gets to see our answer instead of 'connection reset'."""
        rem = getattr(self, "body_remaining", 0)
        if rem <= 0:
            return
        try:
            self.wfile.flush()
            self.connection.shutdown(socket.SHUT_WR)
            self.connection.settimeout(2.0)
            limit = min(rem, 512 * 1024 * 1024)
            got, end = 0, time.time() + 20.0
            while got < limit and time.time() < end:
                data = self.connection.recv(1 << 20)
                if not data:
                    break
                got += len(data)
        except (OSError, ValueError):
            pass

    # ---- request gate ------------------------------------------------------------------------------
    def _host_ok(self):
        hosts = self.headers.get_all("Host") or []
        if len(hosts) != 1:
            return False
        port = self.server.server_address[1]
        return hosts[0].strip().lower() in ("127.0.0.1:%d" % port, "localhost:%d" % port)

    def _gate(self):
        """Host and Origin checks. Returns True if the request may proceed."""
        cl = self.headers.get("Content-Length")
        if cl is not None and re.fullmatch(r"[0-9]{1,15}", cl.strip() or "x"):
            self.body_remaining = int(cl.strip())
        if not self._host_ok():                                  # DNS-rebinding defence
            self.fail(403, "bad-host", "This helper only answers requests addressed to 127.0.0.1 or localhost.")
            return False
        origins = self.headers.get_all("Origin")
        if origins:
            if len(origins) != 1 or not origin_allowed(origins[0].strip()):
                self.fail(403, "bad-origin", "This helper only answers the Video Redline page on this computer.")
                return False
            self.cors_origin = origins[0].strip()
        return True

    def _dispatch(self):
        try:
            if not self._gate():
                return
            method = self.command
            if method == "OPTIONS":
                return self._preflight()
            path = urlsplit(self.path).path
            if path == "/":
                if method != "GET":
                    return self._method_not_allowed("GET")
                if background_mode():
                    text = ("Video Redline helper is running in the background. Go back to the Video Redline page and click "
                            "Create transcript.\n")
                else:
                    text = ("Video Redline helper is running. Leave its window open, go back to the Video Redline page and click "
                            "Create transcript.\n")
                return self._send_bytes(200, text.encode("ascii"), "text/plain; charset=utf-8")
            if path == "/status":
                if method != "GET":
                    return self._method_not_allowed("GET")
                return self._status()
            if path == "/jobs":
                if method != "POST":
                    return self._method_not_allowed("POST")
                return self._post_job()
            m = re.fullmatch(r"/jobs/([^/]+)(?:/(result|cancel))?", path)
            if not m:
                return self.fail(404, "not-found", "There is nothing at that address.")
            jid, sub = m.group(1), m.group(2)
            if not JOB_ID.fullmatch(jid):
                return self.fail(400, "bad-job-id", "That is not a job number this helper handed out.")
            if sub is None:
                if method == "GET":
                    return self._get_job(jid)
                if method == "DELETE":
                    return self._delete_job(jid)
                return self._method_not_allowed("GET, DELETE")
            if sub == "result":
                if method != "GET":
                    return self._method_not_allowed("GET")
                return self._get_result(jid)
            if method != "POST":
                return self._method_not_allowed("POST")
            return self._cancel_job(jid)
        except (ConnectionError, TimeoutError, OSError) as e:
            debug("connection problem: %r" % (e,))
            self.close_connection = True
        except Exception as e:
            debug("internal error: %r" % (e,))
            if DEBUG:
                import traceback
                CON.say(traceback.format_exc())
            try:
                self.fail(500, "internal", "Something went wrong inside the helper. Try again.")
            except Exception:
                self.close_connection = True

    do_GET = do_POST = do_DELETE = do_OPTIONS = do_HEAD = do_PUT = do_PATCH = _dispatch

    def _method_not_allowed(self, allow):
        self.fail(405, "method-not-allowed", "That kind of request is not allowed here.", (("Allow", allow),))

    def _preflight(self):
        if self.cors_origin is None:
            return self._send_bytes(204, b"", "text/plain", (("Allow", "GET, POST, DELETE, OPTIONS"),))
        self._send_bytes(204, b"", "text/plain", (
            ("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS"),
            ("Access-Control-Allow-Headers", "X-Options, Content-Type"),
            ("Access-Control-Max-Age", "600")))

    # ---- GET /status -------------------------------------------------------------------------------
    def _status(self):
        READY.refresh_if_stale()
        ready, checking, problem = READY.snapshot()
        body = {"ok": True, "helper": HELPER_ID, "version": HELPER_VERSION, "busy": REG.busy(), "ready": bool(ready),
                "port": self.server.server_address[1], "maxUploadBytes": MAX_UPLOAD,
                "syncWarning": bool(_startup["sync_warning"])}      # (only yes or no: never the folder name)
        if not ready:
            body["problem"] = problem
            body["checking"] = bool(checking)
        self._send_json(200, body)

    # ---- POST /jobs --------------------------------------------------------------------------------
    def _post_job(self):
        qs = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
        names = qs.get("name", [])
        raw_name = names[0] if len(names) == 1 else ""
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype in ("", "application/x-www-form-urlencoded", "multipart/form-data", "text/plain"):
            return self.fail(415, "bad-content-type", "Send the video as raw bytes with the content type application/octet-stream.")
        if self.headers.get("Transfer-Encoding") is not None or self.headers.get("Content-Length") is None:
            return self.fail(411, "length-required", "The upload must say how large it is (Content-Length).")
        if not re.fullmatch(r"[0-9]{1,15}", self.headers.get("Content-Length").strip() or "x"):
            return self.fail(400, "bad-request", "The upload size is not a number.")
        size = int(self.headers.get("Content-Length").strip())
        if size <= 0:
            return self.fail(400, "empty", "The file is empty.")
        if size > MAX_UPLOAD:
            return self.fail(413, "too-big", "This file is %s, which is more than the %s this helper accepts. Export a smaller or "
                                             "lower-quality copy and try again." % (fmt_size(size), fmt_size(MAX_UPLOAD)))
        name = clean_name(raw_name)
        if not name:
            return self.fail(400, "bad-request", "The file name is missing.")
        ext = os.path.splitext(name)[1].lower()
        if ext not in EXTENSIONS:
            shown = ext if re.fullmatch(r"\.[a-z0-9]{1,8}", ext) else "(none)"
            return self.fail(415, "bad-type", "I can only work with video or audio files (%s). This file's ending is %s."
                             % (", ".join(EXTENSIONS), shown))
        try:
            options = parse_options(self.headers.get("X-Options"))
        except ValueError as e:
            return self.fail(400, "bad-options", str(e))
        ready, checking, problem = READY.snapshot()
        if not ready:
            READY.refresh()                                       # the user may have run setup since we last looked
            ready, checking, problem = READY.snapshot()
        if not ready:
            return self.fail(503, "not-ready", problem or setup_text())
        job = Job(secrets.token_hex(16), ext, size, name, self.cors_origin)
        if not REG.claim(job):
            return self.fail(409, "busy", "The helper is already busy with another video. Wait for it to finish, then try again.")
        ok = False
        try:
            enough, free, need = disk_check(size)
            if not enough:
                return self.fail(507, "disk-full", "There is not enough free space on this drive: about %s is needed for a "
                                                   "%s video and only %s is free. Free up some space and try again."
                                 % (fmt_size(need), fmt_size(size), fmt_size(free)))
            CON.log("Receiving a %s file, %s (from %s)." % (ext, fmt_size(size), origin_text(self.cors_origin)))
            result = self._receive(job, size)
            if result is not True:
                return self.fail(*result)
            with job.lock:
                job.state = "running"
                job.stage = "starting"
                job.message = "Getting ready"
                job.last_seen = time.time()                           # the "nobody is asking" clock starts now
            ok = True
        finally:
            if not ok:
                if job.state == "uploading":
                    with job.lock:
                        job.state = "error"
                        job.finished = time.time()
                rmtree_robust(job.dir, tries=8)
                REG.forget(job)
        CON.log("Upload complete. Making the transcript ...")
        start_job(job, options)
        try:
            self._send_json(200, {"ok": True, "job": job.id})
        except (OSError, ValueError):
            cancel_job(job, "The page went away.")               # nobody is waiting for this transcript any more
            self.close_connection = True

    def _receive(self, job, size):
        """Stream the body to disk. Returns True, or a tuple (code, error, message) for self.fail."""
        try:
            make_private_dir(job.dir)
            f = open_private_file(job.input)
        except OSError:
            return (500, "internal", "I could not create a working folder on this drive.")
        buf = bytearray(CHUNK)
        mv = memoryview(buf)
        remaining = size
        try:
            self.connection.settimeout(UPLOAD_IDLE_TIMEOUT)
            with f:
                while remaining > 0:
                    try:
                        n = self.rfile.readinto(mv[:min(CHUNK, remaining)])
                    except (socket.timeout, TimeoutError):
                        self.body_remaining = 0
                        self.close_connection = True
                        CON.log("The upload stalled and was dropped.")
                        return (408, "timeout", "The upload stopped arriving, so the helper gave up. Try again.")
                    except (ConnectionError, OSError):
                        self.body_remaining = 0
                        self.close_connection = True
                        CON.log("The page stopped sending the video (closed or cancelled).")
                        return (400, "aborted", "The upload was interrupted.")
                    if not n:
                        self.body_remaining = 0
                        self.close_connection = True
                        CON.log("The page stopped sending the video (closed or cancelled).")
                        return (400, "aborted", "The upload was interrupted.")
                    try:
                        view = mv[:n]
                        while len(view):
                            w = f.write(view)
                            view = view[w:]
                    except OSError as e:
                        self.body_remaining = remaining
                        if getattr(e, "errno", None) == 28:
                            return (507, "disk-full", "The drive ran out of space while receiving the video. Free up some "
                                                      "space and try again.")
                        return (500, "internal", "I could not save the video on this drive.")
                    remaining -= n
                    self.body_remaining = remaining
        finally:
            try:
                self.connection.settimeout(HEADER_TIMEOUT)
            except OSError:
                pass
        self.body_remaining = 0
        return True

    # ---- GET/DELETE /jobs/<id> ---------------------------------------------------------------------
    def _job_or_404(self, jid):
        job = REG.get(jid)
        if job is None:
            self.fail(404, "not-found", "The helper does not know about that job (it may have finished long ago, or the "
                                        "helper was restarted).")
        return job

    def _get_job(self, jid):
        job = self._job_or_404(jid)
        if job is not None:
            job.last_seen = time.time()                               # the page is alive (see the abandoned-job guard)
            self._send_json(200, job.view())

    def _cancel_job(self, jid):
        job = self._job_or_404(jid)
        if job is None:
            return
        self._drain_small_body()
        with job.lock:
            running = job.state in ("running", "uploading")
        if running:
            cancel_job(job)
        self._send_json(200, {"ok": True, "state": job.view()["state"]})

    def _delete_job(self, jid):
        job = self._job_or_404(jid)
        if job is None:
            return
        self._drain_small_body()
        cancel_job(job)
        rmtree_robust(job.dir, tries=8)
        REG.forget(job)
        self._send_json(200, {"ok": True})

    def _drain_small_body(self):
        n = self.body_remaining
        if 0 < n <= 4096:
            try:
                self.rfile.read(n)
                self.body_remaining = 0
            except (OSError, ValueError):
                pass

    # ---- GET /jobs/<id>/result ---------------------------------------------------------------------
    def _get_result(self, jid):
        job = self._job_or_404(jid)
        if job is None:
            return
        job.last_seen = time.time()
        with job.lock:
            state, fetched = job.state, job.fetched
        if state != "done":
            return self.fail(409, "not-done", "The transcript is not ready yet.")
        if fetched or not os.path.isfile(job.result):
            return self.fail(410, "gone", "This transcript was already handed over and has been deleted from the helper. "
                                          "Make it again if you need another copy.")
        with open(job.result, "rb") as f:
            raw = f.read()
        try:                                                      # put the page's own file name back (we stored input.<ext>)
            doc = json.loads(raw.decode("utf-8"))
            if isinstance(doc, dict) and isinstance(doc.get("video"), dict) and job.name:
                doc["video"]["name"] = job.name
                raw = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        except (ValueError, UnicodeDecodeError):
            pass
        self._send_bytes(200, raw, "application/json; charset=utf-8")
        with job.lock:
            job.fetched = True
            job.fetched_at = time.time()
        rmtree_robust(job.dir, tries=8)


# ----------------------------------------------------------------------------------------------
# Cleanup
# ----------------------------------------------------------------------------------------------
def sweep_once():
    now = time.time()
    for job in REG.all():
        with job.lock:
            state, fin = job.state, job.finished
            fetched, fat = job.fetched, job.fetched_at
        if state == "done" and not fetched and fin and now - fin > TTL_DONE:
            rmtree_robust(job.dir, tries=4)
            REG.forget(job)
        elif state == "error" and fin and now - fin > TTL_ERROR:
            rmtree_robust(job.dir, tries=4)
            REG.forget(job)
        elif state == "cancelled" and fin and now - fin > TTL_CANCELLED:
            REG.forget(job)
        elif state == "done" and fetched and fat and now - fat > 600:
            REG.forget(job)
    known = set(j.id for j in REG.all())                           # folders nobody owns (a delete that was blocked earlier)
    try:
        for name in os.listdir(JOBS_DIR):
            if name not in known:
                p = os.path.join(JOBS_DIR, name)
                try:
                    old = now - os.path.getmtime(p) > 30
                except OSError:
                    old = False
                if old:
                    rmtree_robust(p, tries=3)
    except OSError:
        pass


def janitor_loop(stop):
    while not stop.wait(3.0):
        try:
            sweep_once()
        except Exception as e:
            debug("janitor: %r" % (e,))


def clean_all_jobs():
    try:
        for name in os.listdir(JOBS_DIR):
            rmtree_robust(os.path.join(JOBS_DIR, name), tries=12, delay=0.2)
    except OSError:
        pass


_shutdown_lock = threading.Lock()
_shutdown_done = False
_console_restore = []


def shutdown_all():
    """Stop every running job (whole process trees) and delete every job folder. Safe to call more than once."""
    global _shutdown_done
    with _shutdown_lock:
        if _shutdown_done:
            return
        _shutdown_done = True
    for job in REG.all():
        try:
            with job.lock:
                job.cancel_requested = True
                proc = job.proc
            kill_tree(proc, wait=5.0)
            if proc is not None:
                sweep_run_dirs(job)
        except Exception:
            pass
    clean_all_jobs()
    release_instance_folder()
    for fn in _console_restore:
        try:
            fn()
        except Exception:
            pass


# ----------------------------------------------------------------------------------------------
# Windows details (all optional: if one fails the helper still works)
# ----------------------------------------------------------------------------------------------
_win_keep = []


def win_setup():
    if not IS_WIN:
        return
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)

        # 1. Clicking inside a console window freezes it (QuickEdit). Switch that off for this window.
        k32.GetStdHandle.restype = wintypes.HANDLE
        k32.GetConsoleMode.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        k32.SetConsoleMode.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        h = k32.GetStdHandle(-10)
        mode = wintypes.DWORD()
        if h and k32.GetConsoleMode(h, ctypes.byref(mode)):
            old = mode.value
            k32.SetConsoleMode(h, (old & ~0x0040) | 0x0080)
            _console_restore.append(lambda: k32.SetConsoleMode(h, old))

        # 2. Put this process in a job object that kills everything in it when the helper dies for ANY reason
        #    (window closed, killed from Task Manager): no speech engine is ever left running in the background.
        class IOC(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in ("ro", "wo", "oo", "rb", "wb", "ob")]

        class BASIC(ctypes.Structure):
            _fields_ = [("pu", ctypes.c_int64), ("ju", ctypes.c_int64), ("flags", wintypes.DWORD),
                        ("minws", ctypes.c_size_t), ("maxws", ctypes.c_size_t), ("alimit", wintypes.DWORD),
                        ("aff", ctypes.c_size_t), ("prio", wintypes.DWORD), ("sched", wintypes.DWORD)]

        class EXT(ctypes.Structure):
            _fields_ = [("basic", BASIC), ("io", IOC), ("pml", ctypes.c_size_t), ("jml", ctypes.c_size_t),
                        ("ppmu", ctypes.c_size_t), ("pjmu", ctypes.c_size_t)]

        k32.CreateJobObjectW.restype = wintypes.HANDLE
        k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        job = k32.CreateJobObjectW(None, None)
        if job:
            info = EXT()
            info.basic.flags = 0x2000                                # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
                k32.AssignProcessToJobObject(job, k32.GetCurrentProcess())
            _win_keep.append(job)                                    # the handle must stay open as long as we live

        # 3. Closing the console window: clean up before Windows ends the process.
        HandlerRoutine = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)

        def on_ctrl(ctrl):
            if ctrl in (2, 5, 6):                                    # close, log off, shut down
                shutdown_all()
                return True
            return False

        cb = HandlerRoutine(on_ctrl)
        _win_keep.append(cb)
        k32.SetConsoleCtrlHandler(cb, True)
    except Exception as e:
        debug("windows setup: %r" % (e,))


# ----------------------------------------------------------------------------------------------
# Start-up
# ----------------------------------------------------------------------------------------------
PORT_PROBE_S = max(0.0, float(_env_num("VRT_PORT_PROBE_S", 4.0)))             # how long a busy port may take to show that it is a helper
PORT_PROBE_EVERY = 0.25                                                        # seconds between two looks at such a port
PORT_PROBE_ASK = 1.0                                                           # longest wait for one answer while doing so


def probe_port(port, timeout=2.0):
    """What answers on this port? 'helper' = a Video Redline helper. 'other' = something answered that is not a helper (a web
    server, text that is not JSON or JSON that cannot be read, a connection that is closed on us). None = nobody answered: nothing
    listens (the connection is refused) or the program accepted the connection and has not said anything yet."""
    c = None
    try:
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
        c.request("GET", "/status")
        r = c.getresponse()
        d = json.loads(r.read(65536).decode("utf-8", "replace"))
    except (socket.timeout, TimeoutError, ConnectionRefusedError):         # (before Python 3.10 socket.timeout is not TimeoutError)
        return None
    except (http.client.HTTPException, ConnectionError, ValueError):
        return "other"
    except OSError:
        return None
    except Exception:                                                      # (JSON nested so deep that it ends in RecursionError, and the like)
        return "other"
    finally:
        if c is not None:
            c.close()
    return "helper" if isinstance(d, dict) and d.get("helper") == HELPER_ID else "other"


def probe_helper(port):
    """True if a Video Redline helper already answers on this port."""
    return probe_port(port) == "helper"


def port_in_use(e):
    """True if this bind error says that another program already listens on the port (not 'not allowed' or the like)."""
    return getattr(e, "errno", None) in (errno.EADDRINUSE, getattr(errno, "WSAEADDRINUSE", errno.EADDRINUSE))


def bind_server(ports):
    """Returns (server, None), or (None, port_of_the_helper_that_is_already_running), or (None, None).

    A port that is in use may belong to a helper that is still starting (it has bound the port but is not answering yet: the
    winner of a race when several helpers start at once). So such a port is looked at for up to PORT_PROBE_S seconds before the
    next one is tried: the helper is found as 'already running' instead of a second helper taking the next port. The look ends
    at once when the port answers and is not a helper. When nobody answers any more, the bind is tried again (the port may just
    have been freed)."""
    for p in ports:
        end = time.time() + PORT_PROBE_S
        more = True                                            # False once the last try at the bind is being made
        while True:
            try:
                return HelperServer(("127.0.0.1", p), Handler), None
            except OSError as e:
                in_use = port_in_use(e)
            if not more:
                break
            what = probe_port(p, timeout=PORT_PROBE_ASK if in_use else 2.0)
            if what == "helper":
                return None, p
            if not in_use:
                break                                          # not 'busy' (for example 'not allowed'): waiting would not help
            if what == "other" or time.time() >= end:
                more = False                                   # one more try at the bind, then on to the next port
                if what == "other":
                    time.sleep(PORT_PROBE_EVERY)               # (a program that hangs up on us may be closing its port just now)
                continue
            time.sleep(PORT_PROBE_EVERY)
    return None, None


SYNC_SERVICES = (("onedrive", "OneDrive"), ("dropbox", "Dropbox"), ("icloud", "iCloud"), ("mobile documents", "iCloud"),
                 ("com~apple~clouddocs", "iCloud"), ("google drive", "Google Drive"), ("googledrive", "Google Drive"),
                 ("my drive", "Google Drive"))
NETWORK_FS = ("nfs", "nfs4", "cifs", "smbfs", "smb", "smb3", "afpfs", "webdav", "davfs", "davfs2", "sshfs", "fuse.sshfs", "9p")


def network_mount_points(text):
    """Mount points of network drives, read from the output of `mount` (Mac, Linux) or the contents of /proc/mounts."""
    points = []
    for line in (text or "").splitlines():
        m = re.search(r" on (.+?) type ([A-Za-z0-9_.]+) ", line)                      # Linux: srv:/x on /mnt/x type nfs4 (...)
        if not m:
            m = re.search(r" on (.+?) \(([A-Za-z0-9_.]+)[,)]", line)                  # Mac:   //me@srv/share on /Volumes/x (smbfs, ...)
        if m:
            if m.group(2) in NETWORK_FS:
                points.append(m.group(1))
            continue
        parts = line.split()                                                          # /proc/mounts: srv:/x /mnt/x nfs4 rw 0 0
        if len(parts) >= 3 and parts[2] in NETWORK_FS:
            points.append(parts[1].replace("\\040", " "))
    return points


def on_network_drive(path):
    """True if `path` is on a network share (Windows: \\\\server\\share or a mapped drive; Mac/Linux: a mounted share)."""
    try:
        p = os.path.abspath(path)
        if IS_WIN:
            if p.startswith("\\\\") and not p.startswith("\\\\?\\"):
                return True
            if p.upper().startswith("\\\\?\\UNC\\"):
                return True
            import ctypes
            drive = os.path.splitdrive(p)[0]
            return bool(drive) and ctypes.windll.kernel32.GetDriveTypeW(drive + "\\") == 4          # DRIVE_REMOTE
        text = ""
        if os.path.exists("/proc/mounts"):
            with open("/proc/mounts", "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
        else:
            r = subprocess.run(["mount"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
            text = r.stdout.decode("utf-8", "replace")
        for mp in network_mount_points(text):
            mp = mp.rstrip("/")
            if mp and (p == mp or p.startswith(mp + "/")):
                return True
    except Exception:
        pass
    return False


def example_folder():
    """A plain local folder to suggest for the tools folder. Windows: VideoRedline inside the user's own folder, written with the real
    user folder (USERPROFILE) when that is a plain local one, else with the placeholder <your name>. Not a folder directly on the C
    drive: that is shared with the other accounts of the PC, and the automatic start (setup-autostart-windows.bat) warns about it. A Mac:
    ~/VideoRedline."""
    if not IS_WIN:
        return "~/VideoRedline"
    placeholder = "C:\\Users\\<your name>\\VideoRedline"
    home = (os.environ.get("USERPROFILE") or "").strip().rstrip("\\/")
    low = home.replace("\\", "/").lower()
    if not re.match(r"[A-Za-z]:\\[^\\/]", home) or any(key in low for key, _ in SYNC_SERVICES) or on_network_drive(home):
        return placeholder
    return home + "\\VideoRedline"


EXAMPLE_FOLDER = example_folder()


def in_desktop_or_documents(path, home=None):
    """True if `path` is the Desktop or Documents folder of the user's home folder (the two that iCloud Drive can sync), or
    lies inside one of them."""
    home = (os.path.expanduser("~") if home is None else str(home)).replace("\\", "/").rstrip("/").lower()
    if not home or home == "~":
        return False
    for candidate in {str(path), os.path.abspath(str(path)), os.path.realpath(str(path))}:
        low = candidate.replace("\\", "/").rstrip("/").lower()
        for folder in ("/desktop", "/documents"):
            if low == home + folder or low.startswith(home + folder + "/"):
                return True
    return False


def icloud_desktop_documents_on():
    """True on a Mac whose Finder keeps the Desktop and Documents folders in iCloud Drive (System Settings > Apple
    Account > iCloud > iCloud Drive > "Desktop & Documents Folders"). False on any other computer, and False when the
    question cannot be asked: `defaults` is missing, fails or times out."""
    if not IS_MAC:
        return False
    try:
        r = subprocess.run(["defaults", "read", "com.apple.finder", "FXICloudDriveDesktop"], stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
        return r.returncode == 0 and r.stdout.decode("utf-8", "replace").strip() == "1"
    except Exception:
        return False


def move_advice_lines():
    """The last lines of the folder WARNING: what to move (the whole Video Redline folder, the one with video-redline.html and tools
    inside it: the Video Redline icon that setup-autostart-windows.bat makes looks for the page in the folder above tools, so moving
    the tools folder alone would leave the icon without a page), to where, and what to do before and after. Windows: three lines, because
    the helper that prints this runs from the folder and Windows will not move it until the helper has been ended. A Mac: two lines."""
    where = ("To avoid that, move the whole Video Redline folder (the one with video-redline.html and tools in it) to a plain "
             "local folder (for example %s)" % EXAMPLE_FOLDER)
    if IS_WIN:
        return [where + ".", stop_before_moving_text(), move_to_new_place_text()]
    return [where + ",", move_to_new_place_text()]


def sync_warning(path, network=None, icloud_desktop=None, home=None):
    """Lines of text for the start-up window when `path` is probably copied somewhere else by a cloud service or sits on a
    network drive (the video you send is stored there while it is processed). Empty when all is well.

    It looks at the folder NAME only: the names in SYNC_SERVICES; on a Mac also the Desktop and Documents folders when
    iCloud Drive keeps them (`icloud_desktop` and `home` are for tests: None means ask this Mac / use the real home
    folder); and a network drive."""
    low = str(path).replace("\\", "/").lower()
    for key, label in SYNC_SERVICES:
        if key in low:
            return ["WARNING: this tools folder is inside a folder that %s synchronises." % label,
                    "The video you send is stored here while it is processed, so %s may upload a copy." % label] + move_advice_lines()
    if (IS_MAC or icloud_desktop is not None) and in_desktop_or_documents(path, home):
        icloud_on = icloud_desktop_documents_on() if icloud_desktop is None else icloud_desktop
        if icloud_on:
            return ["WARNING: this tools folder is inside your Desktop or Documents folder, which iCloud Drive synchronises.",
                    "The video you send is stored here while it is processed, so iCloud may upload a copy."] + move_advice_lines()
    is_network = on_network_drive(path) if network is None else network
    if is_network:
        return ["WARNING: this tools folder is on a network drive.",
                "The video you send is stored here while it is processed, so it travels over the network."] + move_advice_lines()
    return []


def banner(lines):
    width = max(len(s) for s in lines) + 4
    CON.say("")
    CON.say(" " + "=" * width)
    for s in lines:
        CON.say("   " + s)
    CON.say(" " + "=" * width)
    CON.say("")


def already_running_lines(background):
    """The banner of a helper that starts and finds another one already running. Started by hand (a window of its own), this window
    is not the helper: closing it stops nothing, and the one that runs may be in another window or hidden (the automatic start). The
    words ALREADY RUNNING stay: people look for them."""
    if background:
        return ["The Video Redline helper is ALREADY RUNNING.",
                "You do not need to start it again. Go back to the Video Redline page",
                "and click Create transcript."]
    where = "in another window, or running hidden" if IS_WIN else "in another Terminal window"
    return ["The Video Redline helper is ALREADY RUNNING (%s)." % where,
            "You do not need to start it again. Go back to the Video Redline page",
            "and click Create transcript. You can close this window: that does not stop the helper."]


SYNC_WAIT_S = 1.0                                                              # longest start-up waits for the folder check before it answers


def start_sync_check():
    """Start the folder check (sync_warning of the tools folder) in a thread of its own, so main() can tidy the folders meanwhile.
    The thread stores the yes or no that GET /status gives in _startup["sync_warning"] the moment it knows it. Returns (thread,
    found): found["lines"] holds the warning lines once the thread has ended."""
    found = {}

    def work():
        try:
            lines = sync_warning(TOOLS_DIR)
        except Exception as e:                                                 # a check must never keep the helper from starting
            debug("folder check failed: %r" % (e,))
            lines = []
        found["lines"] = lines
        _startup["sync_warning"] = bool(lines)

    t = threading.Thread(target=work, name="folder-check", daemon=True)
    t.start()
    return t, found


def main(argv=None):
    try:
        sys.stdout.reconfigure(errors="replace", line_buffering=True)
        sys.stderr.reconfigure(errors="replace", line_buffering=True)
    except Exception:
        pass
    ap = argparse.ArgumentParser(prog="vrt_server.py", description="Video Redline helper (local server for the page).")
    ap.add_argument("--port", type=int, default=_env_num("VRT_PORT", None, int),
                    help="first port to try (default 47831; then the next four are tried)")
    ap.add_argument("--allow-origin", action="append", default=[], metavar="ORIGIN",
                    help="also answer a page served from this exact origin, e.g. https://tools.example.com (repeatable)")
    ap.add_argument("--version", action="version", version="vrt_server.py " + HELPER_VERSION)
    args = ap.parse_args(argv)
    for o in args.allow_origin:
        o = o.strip().rstrip("/")
        if not re.fullmatch(r"https?://[A-Za-z0-9.\-]+(:[0-9]{1,5})?", o):
            CON.say("PROBLEM: --allow-origin needs an address like https://tools.example.com (no path).")
            CON.flush()
            return 1
        EXTRA_ORIGINS.add(o)
    ports = DEFAULT_PORTS if args.port is None else tuple(args.port + i for i in range(5))
    if args.port is not None and not (1024 <= args.port <= 65530):
        CON.say("PROBLEM: the port must be between 1024 and 65530.")
        CON.flush()
        return 1

    CON.say("")
    CON.say("Video Redline helper %s" % HELPER_VERSION)
    server, running_on = bind_server(ports)
    background = background_mode()                               # no window of its own: say so instead of 'leave this window open'
    if server is None:
        if running_on is not None:
            banner(already_running_lines(background))
            if not background:
                CON.say("  " + how_to_stop_running())
                CON.say("")
            CON.flush()
            return 10
        banner(["The Video Redline helper could not start.",
                "Its connection numbers (%d to %d) are all used by other programs." % (ports[0], ports[-1]),
                "Close other programs that may use them, or restart the computer, and try again."])
        CON.flush()
        return 1

    port = server.server_address[1]
    check, found = start_sync_check()                            # the folder check runs while the folders below are tidied
    win_setup()
    claim_instance_folder(port)                                  # tmp/jobs-<port>: this helper's own folder, kept by a lock
    make_private_dir(JOBS_DIR)
    clean_all_jobs()                                             # our own folder: leftovers of an earlier helper on this port
    clean_old_job_folders()                                      # other folders: only those that no running helper owns
    if not other_helpers_alive():
        clean_stale_run_dirs()
    else:
        clean_orphaned_run_dirs()                                # (a running helper may own the other scratch folders: only those of a helper that has ended)
    clean_spawn_lock()                                           # (the lock file of earlier jobs; only when no other helper runs)
    atexit.register(shutdown_all)
    stop = threading.Event()
    threading.Thread(target=janitor_loop, args=(stop,), name="janitor", daemon=True).start()

    def on_signal(signum, frame):
        raise KeyboardInterrupt()

    for name in ("SIGTERM", "SIGBREAK", "SIGHUP"):
        if hasattr(signal, name):
            try:
                signal.signal(getattr(signal, name), on_signal)
            except (ValueError, OSError):
                pass

    check.join(SYNC_WAIT_S)                                      # /status must not say "no warning" before the check has an answer (about 1 second at most)
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.2}, name="server", daemon=True).start()
    check.join(12.0)
    warning = found.get("lines")                                 # (/status says yes or no; the lines themselves stay in this window)
    if warning:
        banner(warning)
    CON.say("Checking the speech tools ...")
    READY.refresh()
    ready, _, problem = READY.snapshot()
    if ready and background:
        banner(["Video Redline helper is running in the background.",
                "Go back to the page and click Create transcript.",
                how_to_stop_background(),
                "(connection number %d on this computer only)" % port])
    elif ready:
        banner(["Video Redline helper is running.",
                "Leave this window open. Go back to the page and click Create transcript.",
                "To stop the helper, close this window.",
                "(connection number %d on this computer only)" % port])
    else:
        banner(["Video Redline helper is running, but it is NOT ready yet.",
                "(connection number %d on this computer only)" % port])
        CON.say("  " + (problem or setup_text()))
        CON.say("")
        if background:
            CON.say(("  Once the speech tools are set up, stop the helper and start it again. " + how_to_stop_background() + " "
                     + how_to_start_background()).rstrip())
        else:
            CON.say("  Leave this window open: once the speech tools are set up, close this window and start the helper again.")
        CON.say("")

    code = 0
    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        CON.say("")
        CON.say("Stopping the helper ...")
    finally:
        stop.set()
        try:
            server.shutdown()
        except Exception:
            pass
        shutdown_all()
        try:
            server.server_close()
        except Exception:
            pass
    CON.say("The helper has stopped. Nothing was kept.")
    CON.flush()
    return code


if __name__ == "__main__":
    sys.exit(main())
