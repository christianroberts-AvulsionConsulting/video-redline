# -*- coding: utf-8 -*-
"""Video Redline helper - hidden start for Windows (no window, no console, no administrator rights).

This file is run in two real cases: by Windows when you sign in (the "Run" entry that setup-autostart-windows.bat adds), and by the
"Video Redline" icon (open_video_review.pyw) when no helper answers. The Video Redline page does NOT start it: a web page cannot
start a program. (Older versions also registered a videoreview:// link that ran this file; nothing in the page uses it any more
and setup no longer adds it, but a link that is still registered works the same way.) However it starts, it starts the helper inside
this same process and writes what happens to logs\\helper.log in the tools folder (or to video-redline-helper.log in the temp
folder, if the tools folder cannot be written).

It IGNORES everything it is given on the command line, the link's address included: it never reads it, never writes it to
the log and never passes it on. Whatever starts it, it does the same one thing.

Run it with the private Python of this folder (-E keeps other software's PYTHON settings out of the way, -X utf8 keeps the
text format the helper expects):
    venv\\Scripts\\pythonw.exe -E -X utf8 helper_launcher.pyw

It starts at most one helper: a second copy finds the first one and ends quietly. It uses the standard library only.
"""
import os
import sys
import threading
import time

TOOLS = os.path.dirname(os.path.abspath(__file__))
MUTEX_NAME = "Local\\VideoReviewHelperLauncher"      # one launcher per Windows sign-in session
LOG_MAX = 1024 * 1024                                # the log is renamed to helper.log.1 once it grows past 1 MB (one backup is kept)
_keep = []                                           # things that must stay alive as long as this process does


class _Log(object):
    """Stands in for sys.stdout and sys.stderr. pythonw has no console, so everything the helper prints would be lost
    (the helper's banner, "Job failed" lines, and any error that stops it from starting)."""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.f = None
        self.size = 0
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            self.size = os.path.getsize(path)
        except OSError:
            self.size = 0
        if self.size > LOG_MAX:
            self._rotate()
        else:
            self._open()

    def _open(self):
        self.f = open(self.path, "a", encoding="utf-8", errors="replace", buffering=1)

    def _rotate(self):
        try:
            if self.f is not None:
                self.f.close()
        except OSError:
            pass
        self.f = None
        try:
            os.replace(self.path, self.path + ".1")
        except OSError:
            pass                                      # another copy still has the file open: keep writing to it
        self.size = 0
        self._open()

    def write(self, text):
        with self.lock:
            try:
                if self.size > LOG_MAX:
                    self._rotate()
                self.f.write(text)
                self.size += len(text)
            except (OSError, ValueError, AttributeError):
                pass
        return len(text)

    def flush(self):
        with self.lock:
            try:
                self.f.flush()
            except (OSError, ValueError, AttributeError):
                pass

    def reconfigure(self, **kwargs):                 # vrt_server.main() asks for this when it runs on a real console
        pass

    def isatty(self):
        return False

    def say(self, text):
        self.write(time.strftime("%Y-%m-%d %H:%M:%S") + "  [launcher] " + text + "\n")


def _open_log():
    """logs\\helper.log in the tools folder; if that folder cannot be written, video-redline-helper.log in the temp folder."""
    for path in (os.path.join(TOOLS, "logs", "helper.log"),
                 os.path.join(os.environ.get("TEMP") or os.environ.get("TMP") or TOOLS, "video-redline-helper.log")):
        try:
            return _Log(path)
        except OSError:
            continue
    return None


def _another_launcher_is_running():
    """True if another copy of this launcher already holds the Windows mutex (it is starting the helper, or it is the helper).
    The sign-in entry and the Video Redline icon (open_video_review.pyw) can start a launcher at the same moment: this makes sure
    only one of them starts anything."""
    try:
        import ctypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateMutexW.restype = ctypes.c_void_p
        k32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
        handle = k32.CreateMutexW(None, 0, MUTEX_NAME)
        err = ctypes.get_last_error()
        if handle:
            _keep.append(handle)                      # keep it open: the mutex lives as long as this process
        return bool(handle) and err == 183           # ERROR_ALREADY_EXISTS
    except Exception:
        return False                                  # no mutex here (not Windows?): the helper's own "already running" check still holds


def _helper_answers(vrt_server, seconds):
    """True once any helper answers on the helper's ports within `seconds`."""
    try:
        first = int(os.environ.get("VRT_PORT", "") or 0)
    except ValueError:
        first = 0
    ports = tuple(first + i for i in range(5)) if first else tuple(vrt_server.DEFAULT_PORTS)
    end = time.time() + seconds
    while True:
        if any(vrt_server.probe_helper(p) for p in ports):
            return True
        if time.time() >= end:
            return False
        time.sleep(0.5)


def main():
    extra = len(sys.argv) - 1
    sys.argv = sys.argv[:1]                          # 1. IGNORE the command line: the helper must never see the link's address
    log = _open_log()
    if log is not None:
        sys.stdout = sys.stderr = log                # 2. pythonw has no console: send every message to the log file
    else:
        log = type("NoLog", (), {"say": lambda self, t: None})()
    log.say("Starting. Python %s, tools folder %s%s" % (
        sys.version.split()[0], TOOLS, (" (%d extra word(s) on the command line, ignored)" % extra) if extra else ""))
    try:
        if _another_launcher_is_running():            # 3. one launcher at a time
            log.say("Another launcher is already starting or running the helper. Nothing to do.")
            return 0
        log.say("The helper's own messages follow. It runs without a window, so ignore any advice about a window: "
                "to stop it, double-click stop-helper-windows.bat in the tools folder; to start it again, double-click the "
                "Video Redline icon.")
        try:
            os.chdir(TOOLS)                           # 4. work from the tools folder, never from wherever Windows started us
        except OSError:
            pass
        if TOOLS not in sys.path:
            sys.path.insert(0, TOOLS)
        os.environ["VRT_BACKGROUND"] = "1"           # tells a newer helper it has no window (its banner then says so); an older one ignores it        import vrt_server                            # 5. the helper itself (standard library only)
        rc = vrt_server.main([])                     #    explicit empty list: it never reads sys.argv. Returns when the helper stops.
        if rc == 10:
            log.say("A helper was already running. Nothing to do.")
            return 0
        if rc == 1 and _helper_answers(vrt_server, 8.0):
            log.say("Another helper won the race to start; it answers. Nothing to do.")
            return 0
        log.say("The helper has ended (code %r)." % (rc,))
        return 0 if rc == 0 else 1
    except SystemExit as e:
        log.say("The helper asked to exit (%r)." % (e.code,))
        return 0 if e.code in (None, 0, 10) else 1
    except BaseException:
        import traceback
        log.say("The helper could not start:\n" + traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.exit(main())
