# -*- coding: utf-8 -*-
"""Video Redline - open the tool and make sure its helper is running (Windows, no window, no administrator rights).

This is what the "Video Redline" icon on the Desktop and in the Start menu runs. One click does everything:
  1. it looks for a helper on the helper's five connection numbers, all at the same time (about a third of a second);
  2. if none answers, it starts the helper (hidden, the same way Windows does at sign-in) and waits for it;
  3. it opens video-redline.html (the file next to the tools folder) in your web browser.
With nothing running, that usually takes under a second. Nothing needs to be started by hand, and the browser is never asked any question.
If the helper is slow to come up (a cold disk, a virus scanner looking at Python), the page is opened after about 3 seconds anyway
(its own card, with "Check again", covers that moment) and the opener keeps waiting in the background, up to 30 seconds. A box is
shown only if the helper never answers. If the helper's launcher ended without an error and still nothing answers after about
10 seconds, it stops waiting at that point.

The file keeps its old name, open_video_review.pyw, on purpose: icons that were made before the product was renamed point at it.

It IGNORES everything given on the command line. It uses the standard library only. It writes what it does to logs\\helper.log
in the tools folder (or, if that folder cannot be written, to video-redline-helper.log in the temp folder: a message says which).
A second double-click while the first is still working does nothing, so one click never opens two browser tabs.

Run it with the private Python of this folder:
    venv\\Scripts\\pythonw.exe -E -X utf8 open_video_review.pyw
"""
import http.client
import json
import os
import socket
import subprocess
import sys
import threading
import time
import zlib

TOOLS = os.path.dirname(os.path.abspath(__file__))
LAUNCHER = os.path.join(TOOLS, "helper_launcher.pyw")
PAGE_NAMES = ("video-redline.html", "video-review.html")   # the second name is an install from before the rename
HELPER_ID = "video-review-helper"                          # what the helper's /status says about itself (not a screen text)
WAIT_SECONDS = 30                                          # how long to wait for a helper that was just started
OPEN_AFTER_SECONDS = 3.5                                   # open the page after this long even if the helper has not answered yet
QUIET_END_SECONDS = 10                                     # the launcher ended with code 0 and still no helper answers after this long: stop waiting
CONNECT_SECONDS = 0.3                                      # a helper that listens accepts at once; a closed number never answers within this time on Windows
READ_SECONDS = 1.5                                         # then it may take this long to read the answer
POLL_SECONDS = 0.25                                        # about how often to ask again while waiting
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
MUTEX_NAME = "Local\\VideoReviewOpener-%08x" % (zlib.crc32(TOOLS.lower().encode("utf-8", "replace")) & 0xFFFFFFFF)   # one per tools folder
TITLE = "Video Redline"
_log_file = None                                           # the log file that was really written


def _log_paths():
    """logs\\helper.log in the tools folder first; if that folder cannot be written, the temp folder (as the helper does)."""
    paths = [os.path.join(TOOLS, "logs", "helper.log")]
    temp = os.environ.get("TEMP") or os.environ.get("TMP")
    if temp:
        paths.append(os.path.join(temp, "video-redline-helper.log"))
    return paths


def _log(text):
    """One line in the log (best effort: never a reason to stop). Remembers which file it really wrote."""
    global _log_file
    line = time.strftime("%Y-%m-%d %H:%M:%S") + "  [opener] " + text + "\n"
    paths = _log_paths()
    if _log_file in paths:
        paths.remove(_log_file)
        paths.insert(0, _log_file)
    for path in paths:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "a", encoding="utf-8", errors="replace") as f:
                f.write(line)
            _log_file = path
            return
        except OSError:
            continue


def _ports():
    try:
        first = int(os.environ.get("VRT_PORT", "") or 0)
    except ValueError:
        first = 0
    return tuple(first + i for i in range(5)) if first else (47831, 47832, 47833, 47834, 47835)


def _probe_one(port, found):
    """Ask one number whether a Video Redline helper lives there. Adds the number to `found` if it does."""
    conn = None
    try:
        sock = socket.create_connection(("127.0.0.1", port), timeout=CONNECT_SECONDS)
        sock.settimeout(READ_SECONDS)
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=READ_SECONDS)
        conn.sock = sock                                   # connected already (quickly); the rest of the exchange may take longer
        conn.request("GET", "/status")
        data = json.loads(conn.getresponse().read(8192).decode("utf-8", "replace"))
        if isinstance(data, dict) and data.get("ok") and data.get("helper") == HELPER_ID:
            found.append(port)
    except (OSError, ValueError, http.client.HTTPException):
        pass
    finally:
        if conn is not None:
            try:
                conn.close()
            except OSError:
                pass


def _helper_up(limit=None):
    """True if a helper answers on one of its five numbers. All five are asked at the same time, so this takes about
    CONNECT_SECONDS when nothing is there (and almost no time when a helper is)."""
    found = []
    threads = [threading.Thread(target=_probe_one, args=(p, found), daemon=True) for p in _ports()]
    for t in threads:
        t.start()
    end = time.monotonic() + (limit if limit is not None else CONNECT_SECONDS + READ_SECONDS + 0.2)
    while not found and time.monotonic() < end and any(t.is_alive() for t in threads):
        time.sleep(0.02)
    return bool(found)


def _start_helper():
    """Start the hidden helper, detached from this process (it must keep running after this one ends). Returns the process, or None."""
    try:
        return subprocess.Popen([sys.executable, "-E", "-X", "utf8", LAUNCHER], cwd=TOOLS,
                                creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP, close_fds=True,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError as e:
        _log("Could not start the helper: %r" % (e,))
        return None


def _wait_for_helper(proc, started, limit):
    """Wait for the helper that was just started, until `limit` seconds after `started` (a monotonic time).
    Returns (up, final): up is True when a helper answers. final is True when there is no point in waiting any longer:
    the launcher ended with an error; or it ended with code 0 (another launcher, for example the one that runs when you sign in,
    is starting the helper, so it is worth waiting for) but still nothing answers after QUIET_END_SECONDS; or WAIT_SECONDS are over.
    With final False the caller may call this again with a later limit."""
    limit = min(limit, WAIT_SECONDS)
    deadline = started + limit
    while True:
        round_start = time.monotonic()
        if _helper_up(limit=max(0.4, deadline - round_start)):
            return True, False
        code = proc.poll()
        now = time.monotonic()
        if code is not None and code != 0:
            _log("The launcher ended with code %r and no helper answers." % (code,))
            return False, True
        if code == 0 and now - started >= QUIET_END_SECONDS:
            _log("The launcher ended without an error, but no helper answers after %d seconds." % (QUIET_END_SECONDS,))
            return False, True
        if now >= deadline:
            return False, limit >= WAIT_SECONDS
        pause = POLL_SECONDS - (now - round_start)
        if pause > 0:
            time.sleep(min(pause, deadline - now))


def _take_lock():
    """(True, handle) if this is the only opener running. (False, None) if another one is: the first click is already doing the work."""
    try:
        import ctypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateMutexW.restype = ctypes.c_void_p
        k32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
        handle = k32.CreateMutexW(None, 0, MUTEX_NAME)
        err = ctypes.get_last_error()
        if not handle:
            return True, None
        if err == 183:                                     # ERROR_ALREADY_EXISTS
            k32.CloseHandle.argtypes = [ctypes.c_void_p]
            k32.CloseHandle(handle)
            return False, None
        return True, handle
    except Exception:
        return True, None                                  # no mutex here (not Windows?): carry on


def _release_lock(handle):
    if handle:
        try:
            import ctypes
            k32 = ctypes.WinDLL("kernel32")
            k32.CloseHandle.argtypes = [ctypes.c_void_p]
            k32.CloseHandle(handle)
        except Exception:
            pass


def _say(text):
    """A plain Windows message box (there is no console)."""
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, text, TITLE, 0x40 | 0x1000)   # information icon, on top
    except Exception:
        pass


def _find_page():
    """video-redline.html next to the tools folder; an install from before the rename has video-review.html instead."""
    parent = os.path.dirname(TOOLS)
    for name in PAGE_NAMES:
        path = os.path.join(parent, name)
        if os.path.isfile(path):
            return path
    return None


def _open_page(page):
    """Open the page the way a double-click does (in your web browser). True if Windows accepted it."""
    try:
        os.startfile(page)
        return True
    except OSError as e:
        _log("Could not open the page: %r" % (e,))
        return False


def _helper_message(why):
    """The box shown after the page has opened but no helper is there. It never tells the person to repeat what they just did."""
    if why == "files":
        return ("Video Redline opened, but part of its tools folder is missing (helper_launcher.pyw), so the part that makes "
                "transcripts (the helper) cannot start.\n\nPlease copy the complete tools folder again (all of its files together) "
                "into the Video Redline folder.")
    text = ("Video Redline opened, but the part that makes transcripts (the helper) could not start, so \"Create transcript\" "
            "will not work yet.\n\nPlease restart your computer, then click the Video Redline icon again.")
    if _log_file is None or _log_file != _log_paths()[0]:
        text += ("\n\nVideo Redline cannot save files in its own folder:\n" + TOOLS + "\nPlease ask the person who invited you to the beta, or "
                 "whoever installed it, to give your Windows account permission to change that folder.")
    if _log_file:
        text += "\n\nIf it still does not work, please send this file to the person who invited you to the beta:\n" + _log_file
    else:
        text += "\n\nIf it still does not work, please tell the person who invited you to the beta (I could not save a log file, either)."
    return text


def main():
    sys.argv = sys.argv[:1]                           # the command line is never used
    t0 = time.monotonic()
    page = _find_page()
    if page is None:
        _log("The Video Redline page is missing next to the tools folder.")
        _say("I cannot find the Video Redline page. It should be here:\n\n"
             + os.path.join(os.path.dirname(TOOLS), PAGE_NAMES[0])
             + "\n\nIt may have been moved or deleted. Please put it back in that folder, or download Video Redline again.")
        return 1
    mine, lock = _take_lock()
    if not mine:
        _log("Another click is already opening Video Redline. Nothing to do.")
        return 0
    why = ""
    opened = None                                     # None: the page has not been opened yet
    up = _helper_up()
    if not up:
        _log("No helper answers. Starting it.")
        if not os.path.isfile(LAUNCHER):
            why = "files"
            _log("helper_launcher.pyw is missing from the tools folder, so the helper cannot be started.")
        else:
            proc = _start_helper()
            if proc is not None:
                waited = time.monotonic()
                up, final = _wait_for_helper(proc, waited, OPEN_AFTER_SECONDS)
                if not up and not final:
                    # A slow start (a cold disk, a virus scanner looking at Python): do not keep the person looking at nothing.
                    # The page's own card ("Check again") covers the moment until the helper is there; this keeps waiting.
                    _log("No helper yet after %.1f seconds. Opening the page now and waiting on." % (time.monotonic() - t0))
                    opened = _open_page(page)
                    _release_lock(lock)               # the page is open: a deliberate second click may open it again
                    lock = None
                    if opened:
                        up, final = _wait_for_helper(proc, waited, WAIT_SECONDS)
            why = "" if up else "start"
        _log("The helper answers now (after %.1f seconds)." % (time.monotonic() - t0) if up
             else "The helper did not answer (after %.1f seconds)." % (time.monotonic() - t0))
    if opened is None:
        opened = _open_page(page)
    _release_lock(lock)                               # before any box below: a box waits for a click, and must not block the next icon click
    if not opened:
        _say("Windows could not open Video Redline in your web browser.\n\nPlease open it yourself: double-click this file:\n\n" + page)
        return 1
    if not up:
        _say(_helper_message(why))
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException as e:                        # never a stack trace window
        _log("Unexpected problem: %r" % (e,))
        sys.exit(1)
