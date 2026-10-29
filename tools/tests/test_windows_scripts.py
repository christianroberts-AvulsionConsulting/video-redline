r"""Tests for the launcher scripts (setup-windows.bat, start-helper-windows.bat, transcribe-windows.bat, the three .command files for the
Mac, tools/.gitignore). The tests that run a batch file are Windows only; ScriptTextTests reads the files as text and runs anywhere.

Run from the tools folder:    venv\Scripts\python.exe -m unittest discover -s tests -p "test_windows_scripts.py" -v

The light tests need nothing but cmd.exe. The "sandbox" tests build a throw-away working install inside
tmp\test-scratch\ (a copy of uv, the private Python and the packages, plus a link to the real hf-cache so that the
speech models are found) and run the real batch files in it, OFFLINE. They take a few minutes. The real tools folder
is never modified; the sandbox is deleted at the end.

All audio is a made-up recording (noise and a hum), not speech.
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import unittest
import wave

import _paths
from _paths import NO_BASH, REAL, SCRATCH, TOOLS, cloud_named, find_bash

import numpy as np

WIN = sys.platform.startswith("win")
HAVE_INSTALL = os.path.isfile(os.path.join(REAL, "venv", "Scripts", "python.exe")) and \
    os.path.isfile(os.path.join(REAL, "uv", "uv.exe")) and os.path.isdir(os.path.join(REAL, "hf-cache", "hub"))


def code_files():
    """The files of the code under test that a user has next to the batch files (not the install)."""
    out = []
    for name in sorted(os.listdir(TOOLS)):
        full = os.path.join(TOOLS, name)
        if os.path.isfile(full) and (name.endswith((".py", ".bat", ".command", ".txt"))):
            out.append(name)
    return out


def copy_code(dest):
    os.makedirs(dest, exist_ok=True)
    for name in code_files():
        shutil.copy2(os.path.join(TOOLS, name), os.path.join(dest, name))


def base_env(**extra):
    env = {k: v for k, v in os.environ.items()
           if k.upper() not in ("PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONUSERBASE", "VRT_SKIP_VC_CHECK")}
    env["VRT_NO_PAUSE"] = "1"
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
        env[k] = "http://127.0.0.1:9"             # nothing listens there: a download fails at once instead of starting
    env["NO_PROXY"] = ""
    env["no_proxy"] = ""
    env.update(extra)
    return env


def run_bat(bat, args=(), env=None, timeout=900):
    """Run a batch file the way a double-click does (cmd.exe), return (exit_code, all_output_text).

    Nobody is there to type: the batch file's stdin is empty (end of input), so a question such as the one setup-windows.bat
    asks inside a OneDrive folder is answered with 'nothing' at once. (With the test runner's own stdin it would wait for
    the whole timeout, and its output is captured, so nobody would see what it waited for.)"""
    line = '"%s"' % bat + "".join(' "%s"' % a for a in args)
    r = subprocess.run('cmd /d /s /c "%s"' % line, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       env=env or base_env(), cwd=os.path.dirname(bat), timeout=timeout)
    return r.returncode, r.stdout.decode("utf-8", errors="replace")


def make_wav(path, seconds=4):
    sr = 16000
    rng = np.random.default_rng(1)
    x = rng.normal(0, 0.0015, sr * seconds)
    x[int(0.5 * sr):int(1.6 * sr)] += 0.2 * np.sin(2 * np.pi * 180 * np.arange(int(1.1 * sr)) / sr)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(np.clip(x * 32767, -32768, 32767).astype("<i2").tobytes())
    return path


def safe_delete(path):
    """Delete a folder under SCRATCH. Links (junctions) are removed first so nothing outside is ever followed."""
    path = os.path.abspath(path)
    assert path.startswith(os.path.abspath(SCRATCH) + os.sep), path
    if not os.path.isdir(path):
        return
    for dirpath, dirnames, _ in os.walk(path):
        for d in list(dirnames):
            full = os.path.join(dirpath, d)
            if os.path.isjunction(full) or os.path.islink(full):
                os.rmdir(full)
                dirnames.remove(d)
    shutil.rmtree(path, ignore_errors=True)


@unittest.skipUnless(WIN, "Windows batch files")
class ZipAndQuotingTests(unittest.TestCase):
    """No install needed: these stop before anything is downloaded."""

    def setUp(self):
        self.root = os.path.join(SCRATCH, "bat-light")
        safe_delete(self.root)
        os.makedirs(self.root)
        self.addCleanup(safe_delete, self.root)

    def skip_in_a_cloud_folder(self):
        # setup-windows.bat stops at its folder question (by design) when this checkout itself lies in a OneDrive-style folder
        if cloud_named(self.root):
            self.skipTest("this checkout lies in a cloud-looking folder, so setup-windows.bat stops at its folder question before "
                          "the part this test checks. Run the tests from a plain folder inside your user folder, such as C:\\Users\\<your name>\\VideoRedline")

    def test_a_batch_file_that_asks_a_question_gets_end_of_input_instead_of_waiting(self):
        folder = os.path.join(self.root, "asks")
        os.makedirs(folder)
        bat = os.path.join(folder, "ask.bat")
        with open(bat, "wb") as f:
            f.write(b'@echo off\r\nset "ANS="\r\nset /p "ANS=Your choice: "\r\nif defined ANS (echo got an answer) else (echo got nothing)\r\n')
        code, out = run_bat(bat, timeout=30)                                 # (before the fix this waited for the whole timeout)
        self.assertEqual(code, 0, out)
        self.assertIn("got nothing", out)

    def test_setup_opened_from_inside_the_zip_says_to_extract_first(self):
        folder = os.path.join(self.root, "Temp1_Video Redline Tool.zip")          # where Explorer puts a file opened from a zip
        os.makedirs(folder)
        shutil.copy2(os.path.join(TOOLS, "setup-windows.bat"), folder)
        code, out = run_bat(os.path.join(folder, "setup-windows.bat"))
        self.assertEqual(code, 1, out)
        self.assertIn("Extract All", out)
        self.assertIn("INSIDE the zip", out)
        self.assertNotIn("a download failed", out)
        self.assertFalse(os.path.exists(os.path.join(folder, "uv")), "nothing may be downloaded from inside the zip")

    def test_setup_with_the_other_files_missing_says_so(self):
        folder = os.path.join(self.root, "just the bat")
        os.makedirs(folder)
        shutil.copy2(os.path.join(TOOLS, "setup-windows.bat"), folder)
        code, out = run_bat(os.path.join(folder, "setup-windows.bat"))
        self.assertEqual(code, 1, out)
        self.assertIn("requirements.txt", out)
        self.assertIn("Extract All", out)
        self.assertNotIn("a download failed", out)

    def test_transcribe_opened_from_inside_the_zip_says_to_extract_first(self):
        folder = os.path.join(self.root, "Temp2_tools.zip")
        os.makedirs(folder)
        shutil.copy2(os.path.join(TOOLS, "transcribe-windows.bat"), folder)
        code, out = run_bat(os.path.join(folder, "transcribe-windows.bat"), [make_wav(os.path.join(self.root, "a.wav"))])
        self.assertEqual(code, 1, out)
        self.assertIn("Extract All", out)
        self.assertNotIn("setup has not been run", out)

    def test_folder_with_ampersand_caret_and_percent_shows_its_name_without_errors(self):
        self.skip_in_a_cloud_folder()
        folder = os.path.join(self.root, "Tom & Jerry ^ (100%) tools")
        copy_code(folder)
        code, out = run_bat(os.path.join(folder, "setup-windows.bat"))
        self.assertNotIn("is not recognized", out)
        self.assertIn("Tom & Jerry ^ (100%) tools", out)                     # the whole name, both & and ^ intact
        self.assertEqual(code, 1, out)                                       # it then fails at the (blocked) download
        self.assertIn("a download failed", out)

    def test_missing_visual_cpp_runtime_is_found_before_anything_is_downloaded(self):
        self.skip_in_a_cloud_folder()
        # a pretend Windows folder without msvcp140.dll / msvcp140_1.dll
        fake_root = os.path.join(self.root, "FakeWindows")
        os.makedirs(os.path.join(fake_root, "System32"))
        folder = os.path.join(self.root, "tools")
        copy_code(folder)
        code, out = run_bat(os.path.join(folder, "setup-windows.bat"), env=base_env(SystemRoot=fake_root))
        self.assertEqual(code, 1, out)
        self.assertIn("https://aka.ms/vs/17/release/vc_redist.x64.exe", out)
        self.assertIn("administrator", out)
        self.assertNotIn("a download failed", out)
        self.assertFalse(os.path.exists(os.path.join(folder, "uv")), "nothing may be downloaded before the runtime is installed")
        # the escape hatch for a PC where the check is wrong: it goes on to the (blocked) download
        code, out = run_bat(os.path.join(folder, "setup-windows.bat"), env=base_env(SystemRoot=fake_root, VRT_SKIP_VC_CHECK="1"))
        self.assertNotIn("vc_redist", out)

    def test_launcher_in_an_odd_folder_without_setup_says_run_setup(self):
        folder = os.path.join(self.root, "Odd & Even")
        copy_code(folder)
        code, out = run_bat(os.path.join(folder, "transcribe-windows.bat"), [make_wav(os.path.join(self.root, "a.wav"))])
        self.assertEqual(code, 1, out)
        self.assertIn("setup has not been run", out)


def stub(path, text):
    """A stand-in batch file (CRLF), for the files that belong to the automatic start and are not part of this package."""
    with open(path, "wb") as f:
        f.write(text.replace("\n", "\r\n").encode("ascii"))


STUB_SETUP_AUTOSTART = '@echo off\necho STUB setup-autostart ran with [%*]\n>"%~dp0ran-autostart.txt" echo args=%*\nexit /b %STUB_RC%\n'
STUB_STOP = ('@echo off\necho STUB stop-helper ran (VRT_NO_PAUSE=%VRT_NO_PAUSE%)\n>"%~dp0ran-stop.txt" echo no_pause=%VRT_NO_PAUSE%\n'
             'title STUB TITLE\nexit /b %STUB_RC%\n')


def spliced_setup(folder, label, body):
    """setup-windows.bat cut down to one part of itself: the first lines of the real file (they set TOOLS), then `body`, then the
    real file from `label` to its end. So the real lines of the offer, or of the subroutine that stops a helper, run without the
    downloads in front of them. Returns the path of the cut-down file (named setup-windows.bat, so %~dp0 is the folder)."""
    with open(os.path.join(TOOLS, "setup-windows.bat"), "rb") as f:
        lines = f.read().decode("ascii").split("\r\n")
    head = next(i for i, l in enumerate(lines) if l.startswith('if "%TOOLS:~-1%"==')) + 1
    start = next(i for i, l in enumerate(lines) if l.rstrip() == ":" + label)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, "setup-windows.bat")
    with open(path, "wb") as f:
        f.write("\r\n".join(lines[:head] + body + lines[start:]).encode("ascii"))
    return path


def run_bat_typing(bat, answer, wait_for, env=None, timeout=900):
    """Run a batch file with a pipe as the keyboard, like a person who is at it: one key press for 'Press any key to start' at once,
    then `answer` (bytes) as soon as `wait_for` has appeared in what the window shows. Returns (exit code, window text)."""
    p = subprocess.Popen('cmd /d /s /c "%s"' % ('"%s"' % bat), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         env=env or base_env(), cwd=os.path.dirname(bat))
    shown = bytearray()

    def read():
        while True:
            chunk = p.stdout.read1(4096)
            if not chunk:
                return
            shown.extend(chunk)

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    try:
        p.stdin.write(b"k")                                            # (the first "pause" takes one character from the keyboard, and no more)
        p.stdin.flush()
        end = time.time() + timeout
        while wait_for.encode("ascii") not in bytes(shown) and p.poll() is None and time.time() < end:
            time.sleep(0.2)
        p.stdin.write(answer)
        p.stdin.close()
    except OSError:
        pass
    try:
        p.wait(timeout=180)
    except subprocess.TimeoutExpired:
        p.kill()
    reader.join(10)
    return p.returncode, bytes(shown).decode("utf-8", errors="replace")


def run_with_input(bat, answer=None, env=None, timeout=120):
    """Like run_bat, but a person types `answer` (bytes) at the keyboard; None = nobody can type (end of input at once)."""
    line = '"%s"' % bat
    r = subprocess.run('cmd /d /s /c "%s"' % line, input=answer, stdin=subprocess.DEVNULL if answer is None else None,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env or base_env(), cwd=os.path.dirname(bat), timeout=timeout)
    return r.returncode, r.stdout.decode("utf-8", errors="replace")


@unittest.skipUnless(WIN, "Windows batch files")
class AutostartHooksOfSetupTests(unittest.TestCase):
    """The two things setup-windows.bat does about the automatic start (files of the Video Redline app, not of this package; stand-in
    copies are used here, in a temporary folder): it ends a hidden helper before it repairs the folder, and at the very end it offers to
    run setup-autostart-windows.bat. The real lines of the script run; the downloads in front of them are cut away."""

    def setUp(self):
        self.root = os.path.join(SCRATCH, "bat-hooks")
        safe_delete(self.root)
        os.makedirs(self.root)
        self.addCleanup(safe_delete, self.root)

    def ran(self, folder, name):
        path = os.path.join(folder, "ran-" + name + ".txt")
        if not os.path.isfile(path):
            return None
        with open(path, "rb") as f:
            return f.read().decode("ascii").strip()

    def env(self, **extra):
        env = base_env(STUB_RC="0")
        env.pop("VRT_NO_PAUSE", None)                                  # a person is at the keyboard
        env.update(extra)
        return env

    # ---- ending the helper before the repair ---------------------------------------------------------
    def stop_part(self, folder, with_stub, rc="0", **env):
        bat = spliced_setup(folder, "stop_helper", ["call :stop_helper", "echo AFTER-STOP errorlevel=%errorlevel%",
                                                    "echo NO_PAUSE-AFTER=[%VRT_NO_PAUSE%]", "exit /b 0"])
        if with_stub:
            stub(os.path.join(folder, "stop-helper-windows.bat"), STUB_STOP)
        return run_with_input(bat, env=self.env(STUB_RC=rc, **env))

    def test_the_helper_is_stopped_with_stop_helper_windows_bat_when_that_file_is_in_the_folder(self):
        folder = os.path.join(self.root, "Tom & Jerry ^ (100%) tools")
        code, out = self.stop_part(folder, True)
        self.assertEqual(code, 0, out)
        self.assertIn("Stopping it first", out)
        self.assertIn("STUB stop-helper ran (VRT_NO_PAUSE=1)", out)                    # told not to wait for a key in the middle of setup
        self.assertEqual(self.ran(folder, "stop"), "no_pause=1")
        self.assertIn("AFTER-STOP errorlevel=0", out)                                   # and setup goes on
        self.assertIn("NO_PAUSE-AFTER=[]", out)                                         # the switch is not left on for the rest of setup
        self.assertNotIn("is not recognized", out)
        self.assertNotIn("unexpected at this time", out)

    def test_a_switch_the_person_had_set_comes_back_and_a_failing_stop_does_not_end_setup(self):
        folder = os.path.join(self.root, "b")
        code, out = self.stop_part(folder, True, rc="1", VRT_NO_PAUSE="7")
        self.assertEqual(code, 0, out)
        self.assertIn("STUB stop-helper ran (VRT_NO_PAUSE=1)", out)
        self.assertIn("AFTER-STOP", out)
        self.assertIn("NO_PAUSE-AFTER=[7]", out)

    def test_without_the_file_nothing_is_called_and_the_text_does_not_name_it(self):
        folder = os.path.join(self.root, "c")
        code, out = self.stop_part(folder, False)
        self.assertEqual(code, 0, out)
        self.assertIn("End it first, the way README.md describes", out)
        self.assertIn("a helper is running from this folder", out)
        self.assertNotIn("stop-helper-windows", out)                                     # that file is not here: it must not be named
        self.assertNotIn("STUB", out)
        self.assertIn("AFTER-STOP errorlevel=0", out)                                    # setup goes on
        self.assertIsNone(self.ran(folder, "stop"))

    # ---- the offer at the end -----------------------------------------------------------------------
    def ask(self, folder, answer, rc="0", with_stub=True, with_remove=False, env=None):
        bat = spliced_setup(folder, "autostart_offer", ["goto autostart_offer"])
        if with_stub:
            stub(os.path.join(folder, "setup-autostart-windows.bat"), STUB_SETUP_AUTOSTART)
        if with_remove:
            stub(os.path.join(folder, "remove-autostart-windows.bat"), "@echo off\n")
        return run_with_input(bat, answer, env=env or self.env(STUB_RC=rc))

    def test_the_question_says_plainly_what_it_does(self):
        code, out = self.ask(os.path.join(self.root, "d"), None, with_remove=True)
        self.assertEqual(code, 0, out)
        flat = " ".join(out.split())                                                      # (the lines wrap; read the sentences)
        for want in ("Optional: start the helper by itself?", "starts hidden (no window) each time you sign in to Windows.",
                     "This adds one start-up setting to YOUR Windows user settings", 'and a "Video Redline" icon to your Desktop and Start menu.',
                     "No administrator rights.", "Open Video Redline with that icon from then on.", "If you stop the helper later, that icon starts it again.",
                     "remove-autostart-windows.bat", "If you say no, nothing is changed",
                     "Start the helper by itself? (Y = yes, Enter = no)"):
            self.assertIn(want, flat)
        # (round 3d: the host's setup-autostart-windows.bat adds ONE start-up setting and two icons; the question used to say "two entries")
        self.assertNotIn("two entries", flat)
        self.assertNotIn("Video Review", flat)
        # (round 6, R6T-1: the host's page does not start the helper - "tried and does not work" - so the question may not promise it)
        self.assertNotIn("page can start", out)
        self.assertNotIn("when it is not running", out)
        code, out = self.ask(os.path.join(self.root, "d2"), None)
        self.assertNotIn("remove-autostart-windows.bat", out)                            # not named when that file is not there

    def test_a_closed_input_or_an_empty_answer_means_no_and_changes_nothing(self):
        for n, answer in enumerate((None, b"", b"\r\n", b"\r\n\r\n", b"  \r\n")):
            folder = os.path.join(self.root, "no%d" % n)
            code, out = self.ask(folder, answer)
            self.assertEqual(code, 0, "%r: %s" % (answer, out))
            self.assertIn("Start the helper by itself?", out)                           # it was asked
            self.assertNotIn("STUB", out, repr(answer))
            self.assertIsNone(self.ran(folder, "autostart"), repr(answer))

    def test_only_a_plain_y_or_yes_says_yes(self):
        no = (b"n\r\n", b"N\r\n", b"no\r\n", b"yes please\r\n", b"yy\r\n", b"y&echo hi\r\n", b'""\r\n', b"%PATH%\r\n", b"maybe\r\n",
              b"1\r\n", b"ja\r\n", b"yes!\r\n", b"y n\r\n", b"/yes\r\n")
        for n, answer in enumerate(no):
            folder = os.path.join(self.root, "n%d" % n)
            code, out = self.ask(folder, answer)
            self.assertEqual(code, 0, "%r: %s" % (answer, out))
            self.assertIsNone(self.ran(folder, "autostart"), repr(answer))
            self.assertNotIn("STUB", out, repr(answer))
            self.assertNotIn("\r\nhi\r\n", out)                                         # text after & was not run as a command
        for n, answer in enumerate((b"y\r\n", b"Y\r\n", b"  yes  \r\n", b"YES\r\n", b"Yes\r\n")):
            folder = os.path.join(self.root, "y%d" % n)
            code, out = self.ask(folder, answer)
            self.assertEqual(code, 0, "%r: %s" % (answer, out))
            self.assertEqual(self.ran(folder, "autostart"), "args=/yes", repr(answer))        # it is run once, and does not ask its own question again
            self.assertIn("STUB setup-autostart ran with [/yes]", out)
            self.assertNotIn("was not set up", out)

    def test_when_the_automatic_start_fails_setup_itself_still_ends_well(self):
        folder = os.path.join(self.root, "fail")
        code, out = self.ask(folder, b"y\r\n", rc="1")
        self.assertEqual(code, 0, out)                                                   # setup itself is finished
        self.assertIn("The automatic start did not finish", out)
        self.assertIn("read the lines above to see why", out)
        self.assertIn("start-helper-windows.bat", out)
        self.assertIn("your own user folder", out)                                        # a shared or synchronised folder was refused: what to do
        self.assertIn('(for example "%s\\VideoRedline")' % os.environ["USERPROFILE"].rstrip("\\"), out)     # the real user folder, not a placeholder
        # (round 8, L3: and says WHICH folder to move, the one the icon needs to find the page in)
        self.assertIn("move the " + WHOLE + " into your own user folder", " ".join(out.split()))

    def test_a_failed_automatic_start_is_not_reported_as_not_set_up_when_its_entries_were_added(self):
        """Round 6 (R6T-3). The host's setup-autostart-windows.bat ends with exit 1 in several places AFTER it has written the start-up entry
        (the helper did not answer in 40 s, its speech tools are not ready, Windows was asked and nothing happened, the helper could not be
        started just now), and it says 'the start-up entry was added' (round 3d: its lines as the host has them now; they said 'the two
        entries' before). Setup must not follow that with 'was not set up'."""
        cases = (("verify_timeout", "PROBLEM: the start-up entry was added, but the helper did not answer within 40 seconds."),
                 ("not_ready", "PROBLEM: the helper is running (connection number 48200), but its speech tools are not ready."),
                 ("launcher_silent", "PROBLEM: the start-up entry was added and Windows was asked to start the helper, but nothing"),
                 ("start_fail", "PROBLEM: the start-up entry was added, but the helper could not be started just now."))
        for name, problem in cases:
            folder = os.path.join(self.root, "added-" + name)
            bat = spliced_setup(folder, "autostart_offer", ["goto autostart_offer"])
            stub(os.path.join(folder, "setup-autostart-windows.bat"), "@echo off\necho %s\nexit /b 1\n" % problem)
            code, out = run_with_input(bat, b"y\r\n", env=self.env())
            self.assertEqual(code, 0, "%s: %s" % (name, out))                            # setup itself is finished
            self.assertIn(problem, out)                                                  # what that file says is shown as it is
            self.assertNotIn("not set up", out, name)                                    # ... and is not contradicted by what comes after it
            self.assertIn("The automatic start did not finish: read the lines above to see why.", out, name)
            self.assertIn("You can run", out)
            self.assertIn("setup-autostart-windows.bat", out.split(problem)[1], name)
            self.assertIn("start-helper-windows.bat", out.split(problem)[1], name)
            self.assertIn("If the lines above say that other people can change this folder", out, name)    # the folder advice stays, as an 'if'

    def test_nobody_is_asked_in_the_test_paths_or_when_the_file_is_not_there(self):
        code, out = self.ask(os.path.join(self.root, "silent1"), b"y\r\n", env=base_env(STUB_RC="0"))     # VRT_NO_PAUSE=1: nobody is at the keyboard
        self.assertEqual(code, 0, out)
        self.assertNotIn("start the helper by itself", out.lower())
        self.assertIsNone(self.ran(os.path.join(self.root, "silent1"), "autostart"))
        code, out = self.ask(os.path.join(self.root, "silent2"), b"y\r\n", with_stub=False)
        self.assertEqual(code, 0, out)
        self.assertNotIn("start the helper by itself", out.lower())

    # ---- the ALL DONE screen: the Video Redline icon (made by setup-autostart-windows.bat) is the first way, starting by hand is the fallback --------------
    def all_done(self, folder, with_stub, person=True):
        bat = spliced_setup(folder, "all_done", ["goto all_done"])
        if with_stub:
            stub(os.path.join(folder, "setup-autostart-windows.bat"), STUB_SETUP_AUTOSTART)
        return run_with_input(bat, env=self.env() if person else base_env(STUB_RC="0"))

    NEXT = 'Next: double-click "setup-autostart-windows.bat" in this folder to add the Video Redline icon. After that, open Video Redline with that icon'
    RATHER_NOT = 'If you would rather not, double-click "start-helper-windows.bat" each time (in this same folder) and leave its window open'

    def test_all_done_sends_the_person_to_the_icon_first_and_the_question_follows_once(self):
        """Round 3d (item 2). The screen used to name the hand start as the normal way and the icon as a side remark. The icon (made by
        setup-autostart-windows.bat, the way to open Video Redline on Windows) is first, the hand start is for people who would rather not."""
        folder = os.path.join(self.root, "done1")
        code, out = self.all_done(folder, True)
        self.assertEqual(code, 0, out)
        flat = " ".join(out.split())
        self.assertIn(self.NEXT, flat)
        self.assertIn(self.RATHER_NOT, flat)
        icon, hand = flat.index(self.NEXT), flat.index(self.RATHER_NOT)
        self.assertLess(flat.index("ALL DONE"), icon)
        self.assertLess(icon, hand, "the icon comes first, starting by hand is the fallback")
        for want in ('To use the "Create transcript and find cuts" button in Video Redline, the helper (a small program) has to be running.',
                     "it starts the helper if needed. The helper then also starts by itself, hidden, each time you sign in to Windows.",
                     'drag a video onto "transcribe-windows.bat"', "Please do not move or rename this folder"):
            self.assertIn(want, flat)
        # the sentence that announces the question is there, and the question really follows (once, after the whole screen, and a closed input says no)
        announce = "(Setup asks you about this next, so you need not open the file yourself: answer Y and it does the same.)"
        self.assertEqual(flat.count(announce), 1)
        self.assertLess(icon, flat.index(announce))
        self.assertLess(flat.index(announce), hand)
        self.assertEqual(flat.count("Optional: start the helper by itself?"), 1, out)
        self.assertLess(hand, flat.index("Optional: start the helper by itself?"))
        self.assertNotIn("STUB", out)
        self.assertIsNone(self.ran(folder, "autostart"))
        # nothing of the old screen, and nothing that says the page starts the helper
        for gone in ("The easy way", "Or start it by hand each time", "see AUTOSTART.md", "this folder does not have it", "Video Review",
                     "page can start", "when it is not running"):
            self.assertNotIn(gone, flat)

    def test_all_done_does_not_promise_a_question_when_nobody_can_be_asked(self):
        code, out = self.all_done(os.path.join(self.root, "done2"), True, person=False)               # VRT_NO_PAUSE=1: the test path
        self.assertEqual(code, 0, out)
        flat = " ".join(out.split())
        self.assertIn(self.NEXT, flat)                       # (a person can still double-click the file later: the pointer stays)
        self.assertIn(self.RATHER_NOT, flat)
        self.assertLess(flat.index(self.NEXT), flat.index(self.RATHER_NOT))
        self.assertNotIn("Setup asks you", out)
        self.assertNotIn("Optional: start the helper by itself?", out)
        self.assertNotIn("STUB", out)

    def test_all_done_without_the_file_never_tells_anybody_to_double_click_a_file_that_is_not_there(self):
        for n, person in enumerate((True, False)):
            code, out = self.all_done(os.path.join(self.root, "done3%d" % n), False, person=person)
            self.assertEqual(code, 0, out)
            self.assertIn("ALL DONE", out)
            self.assertNotIn("setup-autostart-windows", out)
            self.assertNotIn("remove-autostart-windows", out)
            self.assertNotIn("Optional: start the helper by itself?", out)
            self.assertNotIn("Next:", out)
            self.assertNotIn("icon", out.lower())                                      # an icon that this folder cannot add is not promised
            self.assertIn('Start it by hand each time: double-click "start-helper-windows.bat"', out)
            self.assertIn("leave its window open", out)
            self.assertIn("with the Video Redline app download; this folder does not have it", out)    # said plainly, not as a file to run
            self.assertIn('drag a video onto "transcribe-windows.bat"', out)
            self.assertIn('"Create transcript and find cuts" button in Video Redline', out)

    def test_all_done_branches_on_the_file_also_in_a_folder_with_special_characters(self):
        for n, name in enumerate(("Tom & Jerry ^ (100%) tools", "Odd (x86) & !hi! ^ tools")):
            code, out = self.all_done(os.path.join(self.root, "odd-with-%d" % n, name), True)
            self.assertEqual(code, 0, out)
            self.assertIn(self.NEXT, " ".join(out.split()))
            code, out = self.all_done(os.path.join(self.root, "odd-without-%d" % n, name), False)
            self.assertEqual(code, 0, out)
            self.assertIn('Start it by hand each time: double-click "start-helper-windows.bat"', out)
            self.assertNotIn("Next:", out)
            self.assertNotIn("is not recognized", out)
            self.assertNotIn("unexpected at this time", out)

    # ---- the tidy-up at the end: never the job folder of a helper that is running --------------------------------
    def tidy(self, folder):
        """Run the real tidy-up lines of setup-windows.bat in `folder` (with this test's Python as the private Python)."""
        bat = spliced_setup(folder, "tidy_up", ['set "PY=%s"' % sys.executable, "goto tidy_up"])
        return run_with_input(bat, env=base_env(STUB_RC="0"), timeout=300)

    def test_the_tidy_up_keeps_what_a_running_helper_owns_and_removes_the_rest(self):
        import vrt_server as V
        folder = os.path.join(self.root, "tidy1")
        copy_code(folder)
        stub(os.path.join(folder, "stop-helper-windows.bat"), STUB_STOP)
        tmp = os.path.join(folder, "tmp")
        live = os.path.join(tmp, "jobs-47002", "0123abcd")                    # a helper that runs: a finished transcript waits to be fetched
        dead = os.path.join(tmp, "jobs-47001", "4567ef01")                    # a helper that was killed: its lock file is left, nobody holds it
        for d in (live, dead):
            os.makedirs(d)
            with open(os.path.join(d, "result.json"), "w") as f:
                f.write("{}")
        open(os.path.join(tmp, "jobs-47001.lock"), "w").close()
        old_run = os.path.join(tmp, "run-old")
        os.makedirs(old_run)
        old = time.time() - 3600
        os.utime(old_run, (old, old))
        open(os.path.join(tmp, "spawn.lock"), "w").close()
        helper = V.FileLock(os.path.join(tmp, "jobs-47002.lock"))
        self.assertIs(helper.try_acquire(), True)
        self.addCleanup(helper.release)
        code, out = self.tidy(folder)
        self.assertEqual(code, 0, out)
        self.assertTrue(os.path.isfile(os.path.join(live, "result.json")), "the folder of the running helper was deleted:\n" + out)
        self.assertTrue(os.path.isfile(os.path.join(tmp, "jobs-47002.lock")))
        self.assertFalse(os.path.exists(os.path.join(tmp, "jobs-47001")), "the folder of a helper that is gone stays in the way")
        self.assertFalse(os.path.exists(os.path.join(tmp, "jobs-47001.lock")))
        self.assertTrue(os.path.isdir(old_run), "while a helper runs it may own any scratch folder: nothing of the kind is deleted")
        self.assertTrue(os.path.exists(os.path.join(tmp, "spawn.lock")), "a running helper may be about to use it")
        self.assertTrue(os.path.isdir(tmp))
        # no helper is stopped for the tidy-up (the running one carries on)
        self.assertIsNone(self.ran(folder, "stop"))
        self.assertNotIn("STUB", out)
        # the helper ends: the next run clears everything, and the empty folder tmp goes too
        helper.release()
        code, out = self.tidy(folder)
        self.assertEqual(code, 0, out)
        self.assertFalse(os.path.exists(tmp), "left in tmp: %s" % (os.listdir(tmp) if os.path.isdir(tmp) else ""))

    def test_the_tidy_up_also_removes_the_old_shared_jobs_folder_of_a_very_old_helper(self):
        """Round 6 (R6T-2). tmp\\jobs is where helpers from before the per-port folders kept the uploaded video. Setup is no helper and claims no
        folder, so it was still called 'jobs' and skipped that very entry as its 'own'. The old 'rmdir /s /q tmp' removed it, and a video copy
        in the tools folder is exactly what the tidy-up is for. A lock that somebody holds is still respected."""
        import vrt_server as V
        folder = os.path.join(self.root, "tidy3")
        copy_code(folder)
        tmp = os.path.join(folder, "tmp")
        video = os.path.join(tmp, "jobs", "abc", "video.mp4")
        os.makedirs(os.path.dirname(video))
        with open(video, "wb") as f:
            f.write(b"x")
        os.makedirs(os.path.join(tmp, "jobs-47001", "def"))                  # a helper that was killed
        open(os.path.join(tmp, "spawn.lock"), "w").close()
        held = V.FileLock(os.path.join(tmp, "jobs.lock"))                   # ... but somebody holds the lock of the old shared folder
        self.assertIs(held.try_acquire(), True)
        self.addCleanup(held.release)
        code, out = self.tidy(folder)
        self.assertEqual(code, 0, out)
        self.assertTrue(os.path.isfile(video), "a lock that is held means a helper may be using the folder:\n" + out)
        self.assertFalse(os.path.exists(os.path.join(tmp, "jobs-47001")))
        held.release()                                                      # nobody holds it now: the next run clears it, and tmp itself goes
        code, out = self.tidy(folder)
        self.assertEqual(code, 0, out)
        self.assertFalse(os.path.exists(os.path.join(tmp, "jobs")), "the old shared folder tmp\\jobs (a video copy) was left behind:\n" + out)
        self.assertFalse(os.path.exists(tmp), "left in tmp: %s" % (os.listdir(tmp) if os.path.isdir(tmp) else ""))

    def test_the_tidy_up_leaves_a_young_scratch_folder_of_a_drag_and_drop_run_alone(self):
        folder = os.path.join(self.root, "tidy2")
        copy_code(folder)
        tmp = os.path.join(folder, "tmp")
        young = os.path.join(tmp, "run-young")                               # transcribe-windows.bat may be working in another window
        os.makedirs(young)
        with open(os.path.join(young, "audio.raw"), "wb") as f:
            f.write(b"x" * 10)
        code, out = self.tidy(folder)
        self.assertEqual(code, 0, out)
        self.assertTrue(os.path.isfile(os.path.join(young, "audio.raw")))

    def test_the_tidy_up_is_not_a_blunt_rmdir_of_tmp(self):
        with open(os.path.join(TOOLS, "setup-windows.bat"), "rb") as f:
            lines = f.read().decode("ascii").split("\r\n")
        for n, line in enumerate(lines, 1):
            self.assertFalse(line.lower().startswith("if exist") and "rmdir /s /q" in line.lower() and "\\tmp" in line.lower(),
                             "line %d deletes tmp as a whole: %s" % (n, line))


# ------------------------------------------------------------------------------------------------
# Round 3d. What the six launcher scripts and the two dot files say. ScriptTextTests reads them as text and runs anywhere;
# the other classes run the real batch files (Windows only).
# ------------------------------------------------------------------------------------------------
BAT_FILES = ("setup-windows.bat", "start-helper-windows.bat", "transcribe-windows.bat")
COMMAND_FILES = ("setup-mac.command", "start-helper-mac.command", "transcribe-mac.command")
SAID_THE_PAGE_STARTS_IT = re.compile(r"(?i)page (can|could|will|may|also)( also)? start|page starts|start it when it is not running|"
                                     r"starts the helper from the page|the page[^.]{0,40}\bstarts? the helper")


# Round 8 (L3). "This folder" on the screens of the scripts is the tools folder, and the Video Redline icon opens the page only when
# video-redline.html lies next to the tools folder (open_video_review.pyw looks for it in the folder above). So every piece of advice
# that says "move the folder" says which folder: the one that has video-redline.html and the tools folder inside it.
WHOLE = "whole Video Redline folder (the one that has video-redline.html and the tools folder inside it)"


def script_text(name):
    with open(os.path.join(TOOLS, name), "rb") as f:
        return f.read().decode("ascii")


def echoed_sh(name):
    """What the echo "..." lines of a .command file print, as one text with single spaces (the same idea as echoed for a batch file)."""
    parts = []
    for line in script_text(name).splitlines():
        m = re.match(r'\s*echo "(.*)"\s*$', line)
        if m:
            parts.append(m.group(1).strip())
    return " ".join(" ".join(parts).split())


def echoed(name):
    """What the echo lines of a batch file print, as one text with single spaces (comments and commands left out), so that a sentence
    that wraps over two lines of the file can be looked for."""
    parts = []
    for line in script_text(name).splitlines():
        m = re.match(r"(?i)(?:if\s.*?\s)?echo\s+(.*)$", line.strip())
        if m:
            parts.append(m.group(1))
    return " ".join(" ".join(parts).split())


class ScriptTextTests(unittest.TestCase):
    def test_the_bytes_of_every_script_follow_the_rules(self):
        """.bat: plain ASCII, CRLF on every line and no bare LF or CR, no BOM. .command: plain ASCII, LF only, #!/bin/bash first.
        The dot files: plain ASCII, LF only (a guard: these held before round 3d as well)."""
        for name in BAT_FILES:
            raw = script_text(name).encode("ascii")
            self.assertFalse(raw.startswith(b"\xef\xbb\xbf"), name)
            self.assertGreater(raw.count(b"\r\n"), 100, name)
            self.assertEqual(raw.count(b"\n"), raw.count(b"\r\n"), name + ": a bare LF")
            self.assertEqual(raw.count(b"\r"), raw.count(b"\r\n"), name + ": a bare CR")
            self.assertTrue(raw.endswith(b"\r\n"), name)
        for name in COMMAND_FILES:
            raw = script_text(name).encode("ascii")
            self.assertFalse(raw.startswith(b"\xef\xbb\xbf"), name)
            self.assertTrue(raw.startswith(b"#!/bin/bash\n"), name)
            self.assertNotIn(b"\r", raw, name + " must be LF only")
        for name in (".gitignore", ".gitattributes"):
            raw = script_text(name).encode("ascii")
            self.assertFalse(raw.startswith(b"\xef\xbb\xbf"), name)
            self.assertNotIn(b"\r", raw, name)

    def test_no_script_says_video_review_or_whoever_gave_you_this_tool(self):
        """Round 3d (items 3 and 0). The product is Video Redline and the person to ask is the one who invited you to the beta."""
        old = re.compile(r"(?i)video review|videoreview|video-review\.html|whoever gave|gave you this tool")
        for name in BAT_FILES + COMMAND_FILES:
            for n, line in enumerate(script_text(name).splitlines(), 1):
                self.assertIsNone(old.search(line), "%s line %d: %s" % (name, n, line.strip()))
        # the places that used to say it now name the person who invited the tester to the beta (on one line each, so that a test can find it)
        for name, at_least in (("setup-windows.bat", 2), ("start-helper-windows.bat", 1), ("setup-mac.command", 3), ("start-helper-mac.command", 1)):
            found = [l for l in script_text(name).splitlines() if "the person who invited you to the beta" in l]
            self.assertGreaterEqual(len(found), at_least, name)

    def test_titles_and_banners_say_video_redline(self):
        for name in BAT_FILES + COMMAND_FILES:
            text = script_text(name)
            self.assertIn("Video Redline Tool - ", text.splitlines()[2], name)                   # the first comment line names the file's job
            for line in text.splitlines():
                if line.lower().startswith("title "):
                    self.assertIn("Video Redline", line, name)
        self.assertIn("echo   Video Redline Tool - one-time setup", script_text("setup-windows.bat"))
        self.assertIn('echo "  Video Redline Tool - one-time setup (Mac)"', script_text("setup-mac.command"))
        self.assertIn("echo   Starting the Video Redline helper.", script_text("start-helper-windows.bat"))
        self.assertIn('echo "  Starting the Video Redline helper.', script_text("start-helper-mac.command"))

    def test_folder_advice_is_the_user_folder_never_the_c_drive_the_desktop_or_documents(self):
        """Round 3d (item 1). Windows: %USERPROFILE%\\VideoRedline (C:\\Users\\<name>\\VideoRedline); Mac: ~/VideoRedline. A folder directly on
        C:\\ is writable by every signed-in user, which setup-autostart-windows.bat warns about; Desktop and Documents are synchronised."""
        for name in BAT_FILES + COMMAND_FILES:
            for n, line in enumerate(script_text(name).splitlines(), 1):
                self.assertIsNone(re.search(r"(?i)\bC:[\\/]+(?!Users\b)", line), "%s line %d names a folder on the C drive: %s" % (name, n, line.strip()))
                self.assertNotIn("YourName", line, name)
                if re.search(r"\b(Desktop|Documents)\b", line):                                    # only a warning or the icon, never a place to put the folder
                    self.assertRegex(line, r"(?i)icon|icloud|sync|cloud", "%s line %d: %s" % (name, n, line.strip()))
        bat = script_text("setup-windows.bat")
        self.assertIn('set "EXAMPLE=C:\\Users\\<your name>\\VideoRedline"', bat)
        self.assertIn('if defined USERPROFILE set "EXAMPLE=%USERPROFILE%\\VideoRedline"', bat)
        self.assertIn('if not "%EXAMPLE:~1,2%"==":\\" set "EXAMPLE=C:\\Users\\<your name>\\VideoRedline"', bat)      # a UNC path gives the placeholder
        for n, line in enumerate(bat.splitlines(), 1):
            if "user folder" in line and re.match(r"\s*(if .* )?echo", line, re.I):
                self.assertIn('(for example "%EXAMPLE%")', line, "line %d gives no example: %s" % (n, line.strip()))
        self.assertEqual(bat.count('your own user folder (for example "%EXAMPLE%")'), 4)                  # long path, cloud question, stopped, refused start
        # the Mac: five places in setup-mac.command, one each in the other two
        for name, at_least in (("setup-mac.command", 5), ("start-helper-mac.command", 1), ("transcribe-mac.command", 1)):
            found = [l for l in script_text(name).splitlines() if "~/VideoRedline" in l]
            self.assertGreaterEqual(len(found), at_least, name)
        for name in COMMAND_FILES:
            self.assertNotIn("C:\\", script_text(name), name)

    def test_the_long_path_note_says_a_short_place_inside_the_user_folder(self):
        line = next(l for l in script_text("setup-windows.bat").splitlines() if "this folder's path is quite long" in l)
        self.assertIn("move the " + WHOLE + " to a short place inside your own user folder", line)
        self.assertNotIn("shorter place", line)
        self.assertIn('(for example "%EXAMPLE%") and run this file again.', line)

    def test_every_move_the_folder_advice_names_the_whole_video_redline_folder(self):
        """Round 8 (L3). The screens print the path of the TOOLS folder as 'this folder'. A tester who moves only that folder leaves
        video-redline.html behind, and the Video Redline icon then cannot find the page. So the advice says which folder to move."""
        count = {"setup-windows.bat": 4, "setup-mac.command": 2}              # Windows: long path, refused start, cloud question, stopped. Mac: cloud question, stopped.
        for name in BAT_FILES + COMMAND_FILES:
            text = echoed(name) if name.endswith(".bat") else echoed_sh(name)
            hits = [m.start() for m in re.finditer(r"\b[Mm]ove the ", text)]
            self.assertEqual(len(hits), count.get(name, 0), name)
            for at in hits:
                self.assertRegex(text[at:], r"^[Mm]ove the " + re.escape(WHOLE), "%s: %s" % (name, text[at:at + 160]))
            self.assertNotRegex(text, r"(?i)\bthe whole folder\b", name)
        mac = echoed_sh("setup-mac.command")
        self.assertIn("WHAT TO DO (recommended): close this window, move the " + WHOLE + " to ~/VideoRedline (a folder called VideoRedline in "
                      "your home folder), and run setup-mac.command from there.", mac)
        self.assertIn("Move the " + WHOLE + " to ~/VideoRedline and run setup-mac.command from there.", mac)

    def test_every_move_the_folder_advice_of_setup_windows_says_to_stop_the_helper_first(self):
        """Round 8 (R8-REV-1). A helper that runs from the folder, perhaps without a window, keeps Windows from moving it. The cloud
        question, the 'Setup was stopped' line and the refused automatic start say so, and name stop-helper-windows.bat (the host file)."""
        text = echoed("setup-windows.bat")
        why = "Windows will not move a folder while the helper runs from it."
        self.assertEqual(text.count(why), 3)
        self.assertEqual(text.count("stop-helper-windows.bat first, if this folder has that file: " + why), 1)
        self.assertEqual(text.count("Before you move it, double-click stop-helper-windows.bat if this folder has that file, because " + why), 2)
        for at in [m.start() for m in re.finditer(re.escape(why), text)]:
            self.assertIn("stop-helper-windows.bat", text[max(0, at - 160):at], text[max(0, at - 160):at + 80])

    def test_the_mac_tidy_up_does_not_delete_tmp_as_a_whole(self):
        """Round 9 (S2). setup-windows.bat never deletes tmp as a whole (a helper that runs from the folder keeps its job folder there, with a
        finished transcript that nobody has fetched yet); setup-mac.command did. A Mac helper is started by hand and the not-ready help sends
        the person back to setup, so the Mac script does it the Windows way, with the very same Python line."""
        mac = script_text("setup-mac.command")
        start = mac.index("# ---- tidy up")
        tidy = mac[start:mac.index('echo " ====', start)]
        self.assertNotRegex(tidy, r"rm -rf [^\n]*tmp")
        for want in ('VRT_TOOLS="$TOOLS"', "v._instance['name']='setup'", "v.clean_old_job_folders()", "a=v.other_helpers_alive()",
                     "a or v.clean_stale_run_dirs()", "a or v.clean_spawn_lock()", 'rmdir "$TOOLS/tmp"'):
            self.assertIn(want, tidy)
        win = script_text("setup-windows.bat")
        code = r'"(import os,sys; sys\.path.*?)"'
        self.assertEqual(re.search(code, tidy).group(1), re.search(code, win[win.index(":tidy_up"):win.index(":all_done")]).group(1))

    def test_gitignore_lists_the_icon_pictures_and_keeps_every_other_line(self):
        """Round 3d (item 8). add-desktop-icon-windows.bat writes video-redline.ico into tools/ (older runs left video-review.ico)."""
        lines = script_text(".gitignore").split("\n")
        rules = [l for l in lines if l.strip() and not l.startswith("#")]
        for want in ("python/", "venv/", "uv/", "uv-cache/", "hf-cache/", "tmp/", "dev/", "logs/", "__pycache__/", "*.pyc",
                     "*-transcript.json", "*.ico"):
            self.assertIn(want, rules)
        self.assertEqual(len(rules), len(set(rules)), "a rule twice")
        above = lines[lines.index("*.ico") - 1]
        self.assertTrue(above.startswith("#"), "a comment line says what *.ico is for")
        for word in ("add-desktop-icon-windows.bat", "video-redline.ico", "video-review.ico"):
            self.assertIn(word, above)

    def test_gitattributes_still_asks_for_the_right_line_endings(self):
        rules = {}
        for line in script_text(".gitattributes").splitlines():
            if line.strip() and not line.startswith("#"):
                pattern, *attrs = line.split()
                rules[pattern] = attrs
        self.assertEqual(rules.get("*.bat"), ["text", "eol=crlf"])
        self.assertEqual(rules.get("*.command"), ["text", "eol=lf"])

    def test_no_script_says_that_the_page_starts_the_helper(self):
        """The Video Redline page never starts the helper (a web page cannot start a program), and neither do its buttons."""
        for name in BAT_FILES + COMMAND_FILES:
            for n, line in enumerate(script_text(name).splitlines(), 1):
                self.assertIsNone(SAID_THE_PAGE_STARTS_IT.search(line), "%s line %d: %s" % (name, n, line.strip()))

    def test_windows_scripts_name_the_icon_and_the_hand_start_in_the_canonical_order(self):
        """setup-windows.bat (ALL DONE) and start-helper-windows.bat (stopped): the icon first, then setup-autostart-windows.bat for a
        person who has no icon yet, then the hand start (start-helper-windows.bat) for anybody who would rather not."""
        done = echoed("setup-windows.bat")
        for want in ('Next: double-click "setup-autostart-windows.bat" in this folder to add the Video Redline icon.',
                     'If you would rather not, double-click "start-helper-windows.bat" each time'):
            self.assertIn(want, done)
        self.assertLess(done.index('Next: double-click "setup-autostart-windows.bat" in this folder to add the Video Redline icon.'),
                        done.index('If you would rather not, double-click "start-helper-windows.bat" each time'))
        stopped = echoed("start-helper-windows.bat")
        for want in ('To start it again, double-click the "Video Redline" icon on your Desktop (it starts the helper and opens Video Redline).',
                     'No icon yet? Double-click "setup-autostart-windows.bat" (in this same folder) once: it adds the icon and makes the helper '
                     'start by itself at every sign-in.',
                     'Or, if you would rather not, double-click "start-helper-windows.bat" again and leave its window open.'):
            self.assertIn(want, stopped)
        icon = stopped.index('To start it again, double-click the "Video Redline" icon on your Desktop (it starts the helper and opens Video Redline).')
        no_icon = stopped.index('No icon yet? Double-click "setup-autostart-windows.bat" (in this same folder) once: it adds the icon and makes the helper '
                                'start by itself at every sign-in.')
        rather_not = stopped.index('Or, if you would rather not, double-click "start-helper-windows.bat" again and leave its window open.')
        self.assertLess(icon, no_icon)
        self.assertLess(no_icon, rather_not)

    @unittest.skipUnless(find_bash(), NO_BASH)
    def test_mac_scripts_parse_with_bash(self):
        for name in COMMAND_FILES:
            r = subprocess.run([find_bash(), "-n", os.path.join(TOOLS, name).replace("\\", "/")], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, name + ": " + r.stderr)


@unittest.skipUnless(WIN, "Windows batch files")
class FolderAdviceRunTests(unittest.TestCase):
    """Round 3d (item 1), run for real: the advice names the real user folder, survives odd names, and never names a folder on the C drive."""

    def setUp(self):
        self.root = os.path.join(SCRATCH, "bat-advice")
        safe_delete(self.root)
        os.makedirs(self.root)
        self.addCleanup(safe_delete, self.root)

    def env(self, profile, **extra):
        env = base_env(**extra)
        for key in [k for k in env if k.upper() == "USERPROFILE"]:
            del env[key]
        if profile is not None:
            env["USERPROFILE"] = profile
        return env

    PROFILES = ((r"C:\Users\Pat Lee", r"C:\Users\Pat Lee\VideoRedline"),
                (r"D:\Profiles\pat", r"D:\Profiles\pat\VideoRedline"),
                (r"C:\Users\Tom & Jerry ^ (1) !x! 5%", r"C:\Users\Tom & Jerry ^ (1) !x! 5%\VideoRedline"),
                (r"\\server\share\pat", r"C:\Users\<your name>\VideoRedline"),                  # a network profile: the placeholder
                (None, r"C:\Users\<your name>\VideoRedline"))                                   # no USERPROFILE at all

    def test_the_long_path_note_names_the_user_folder(self):
        if cloud_named(self.root):
            self.skipTest("this checkout lies in a cloud-looking folder, so setup-windows.bat stops at its folder question first")
        folder = os.path.join(self.root, "a rather long folder name so that the whole path has more than ninety characters", "tools")
        self.assertGreater(len(folder), 90)
        copy_code(folder)
        fake_root = os.path.join(self.root, "FakeWindows")                                   # no Visual C++ runtime there: setup stops right after the note
        os.makedirs(os.path.join(fake_root, "System32"))
        for profile, want in self.PROFILES:
            code, out = run_bat(os.path.join(folder, "setup-windows.bat"), env=self.env(profile, SystemRoot=fake_root))
            flat = " ".join(out.split())
            self.assertIn("NOTE: this folder's path is quite long.", flat, out)
            self.assertIn('If anything fails, move the ' + WHOLE + ' to a short place inside your own user folder (for example "%s") and run this file again.' % want,
                          flat, repr(profile))
            self.assertNotIn("shorter place", flat)
            self.assertNotIn("C:\\VideoRedline", out)
            self.assertNotIn("is not recognized", out)
            self.assertNotIn("unexpected at this time", out)

    def test_the_cloud_folder_advice_and_the_stopped_text_name_the_user_folder(self):
        folder = os.path.join(self.root, "OneDrive", "tools")
        copy_code(folder)
        for profile, want in self.PROFILES:
            code, out = run_bat(os.path.join(folder, "setup-windows.bat"), env=self.env(profile))        # nobody types: Enter, which stops
            flat = " ".join(out.split())
            self.assertEqual(code, 1, out)
            self.assertIn("WARNING: this folder is inside a folder that OneDrive synchronises", flat)
            self.assertIn('WHAT TO DO (recommended): close this window, move the ' + WHOLE + ' into your own user folder (for example "%s"), '
                          'and run setup-windows.bat from there.' % want, flat, repr(profile))
            self.assertIn('Setup was stopped. Nothing was downloaded and nothing was changed. Move the ' + WHOLE + ' into your own user folder '
                          '(for example "%s") and run setup-windows.bat from there.' % want, flat, repr(profile))
            self.assertEqual(flat.count('(for example "%s")' % want), 2, out)
            for bad in ("C:\\VideoRedline", "C:\\VideoReview", "Video Review", "is not recognized", "unexpected at this time"):
                self.assertNotIn(bad, out, repr(profile))
            self.assertFalse(os.path.exists(os.path.join(folder, "uv")))                          # nothing was downloaded


@unittest.skipUnless(find_bash(), NO_BASH)
class MacFolderAdviceRunTests(unittest.TestCase):
    """Round 8 (L3), run for real with whatever bash this computer has (not a Mac): the cloud-folder question and the 'stopped' text of
    setup-mac.command say which folder to move."""

    def setUp(self):
        self.root = os.path.join(SCRATCH, "mac-advice")
        safe_delete(self.root)
        os.makedirs(self.root)
        self.addCleanup(safe_delete, self.root)

    def test_the_cloud_folder_advice_and_the_stopped_text_name_the_whole_video_redline_folder(self):
        folder = os.path.join(self.root, "OneDrive", "tools")
        copy_code(folder)
        home = os.path.join(self.root, "home")
        os.makedirs(home)
        env = dict(os.environ, VRT_NO_PAUSE="1", VRT_STOP_AFTER_FOLDER_CHECK="1", HOME=home.replace("\\", "/"))
        r = subprocess.run([find_bash(), os.path.join(folder, "setup-mac.command").replace("\\", "/")], input=b"", stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, env=env, timeout=120)                   # nobody types: Return, which stops
        out = r.stdout.decode("utf-8", errors="replace")
        flat = " ".join(out.split())
        self.assertEqual(r.returncode, 1, out)
        self.assertIn("WARNING: this folder is inside a folder that OneDrive synchronises", flat)
        self.assertIn("WHAT TO DO (recommended): close this window, move the " + WHOLE + " to ~/VideoRedline (a folder called VideoRedline in "
                      "your home folder), and run setup-mac.command from there.", flat)
        self.assertIn("Setup was stopped. Nothing was downloaded and nothing was changed. Move the " + WHOLE + " to ~/VideoRedline and run "
                      "setup-mac.command from there.", flat)
        self.assertNotIn("the whole folder", flat)
        self.assertNotIn("C:\\", out)


# stand-ins for the helper (it ends with the code in STUB_RC) and for the check of the private Python: start-helper-windows.bat then
# prints what it prints after the helper has ended
STUB_TRANSCRIBE = "import sys\nsys.exit(0)\n"
STUB_SERVER = "import os, sys\nsys.exit(int(os.environ.get('STUB_RC', '0')))\n"


def start_helper_in(folder, with_autostart):
    """start-helper-windows.bat (the real file) in `folder`, with stand-ins for transcribe.py and vrt_server.py and this test's own Python as
    the private Python. With `with_autostart` the folder also has a stand-in for setup-autostart-windows.bat."""
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(TOOLS, "start-helper-windows.bat"), "rb") as f:
        lines = f.read().decode("ascii").split("\r\n")
    at = [i for i, l in enumerate(lines) if l.startswith('set "PY=')]
    assert len(at) == 1, at
    lines[at[0]] = 'set "PY=%s"' % sys.executable
    path = os.path.join(folder, "start-helper-windows.bat")
    with open(path, "wb") as f:
        f.write("\r\n".join(lines).encode("ascii"))
    for name, text in (("transcribe.py", STUB_TRANSCRIBE), ("vrt_server.py", STUB_SERVER)):
        with open(os.path.join(folder, name), "w") as f:
            f.write(text)
    if with_autostart:
        stub(os.path.join(folder, "setup-autostart-windows.bat"), "@echo off\n")
    return path


@unittest.skipUnless(WIN, "Windows batch files")
class StartHelperMessagesTests(unittest.TestCase):
    """Round 3d (S3). What start-helper-windows.bat tells a person when the helper has ended: how to start it again (the Video Redline icon
    first), what an already running helper means, and who to ask. The page never starts the helper, and the text never says it does."""

    def setUp(self):
        self.root = os.path.join(SCRATCH, "bat-start")
        safe_delete(self.root)
        os.makedirs(self.root)
        self.addCleanup(safe_delete, self.root)
        self.count = 0

    def run_start(self, rc, with_autostart, name="tools"):
        self.count += 1
        bat = start_helper_in(os.path.join(self.root, "run%d" % self.count, name), with_autostart)
        code, out = run_with_input(bat, env=base_env(STUB_RC=str(rc)))                      # VRT_NO_PAUSE=1 (nobody presses a key)
        return code, out, " ".join(out.split())

    def test_a_helper_that_has_stopped_is_started_again_with_the_icon_first(self):
        code, out, flat = self.run_start(0, True)
        self.assertEqual(code, 0, out)
        self.assertIn("Starting the Video Redline helper.", flat)
        self.assertIn("The helper has stopped. The Video Redline page can no longer make transcripts.", flat)
        icon = flat.index('To start it again, double-click the "Video Redline" icon on your Desktop (it starts the helper and opens Video Redline).')
        no_icon = flat.index('No icon yet? Double-click "setup-autostart-windows.bat" (in this same folder) once: it adds the icon and makes the helper '
                             'start by itself at every sign-in.')
        rather_not = flat.index('Or, if you would rather not, double-click "start-helper-windows.bat" again and leave its window open.')
        self.assertLess(icon, no_icon)
        self.assertLess(no_icon, rather_not)
        self.assertNotIn("To use it again, double-click", flat)                               # (the old, hand-start-only sentence)
        self.assertIsNone(SAID_THE_PAGE_STARTS_IT.search(flat))

    def test_without_the_file_that_makes_the_icon_only_the_hand_start_is_named(self):
        code, out, flat = self.run_start(0, False)
        self.assertEqual(code, 0, out)
        self.assertIn('The helper has stopped. The Video Redline page can no longer make transcripts. To use it again, double-click '
                      '"start-helper-windows.bat".', flat)
        self.assertNotIn("icon", flat.lower())                                               # no icon is promised that nobody can add
        self.assertNotIn("setup-autostart", flat)

    def test_an_already_running_helper_keeps_its_words_and_names_the_icon_only_when_it_can_exist(self):
        code, out, flat = self.run_start(10, True)
        self.assertEqual(code, 10, out)                                                      # the code is handed on
        self.assertIn("Nothing more to do: the helper is already running (in another window, or hidden). Closing this window does not stop that helper.", flat)
        self.assertIn('To open Video Redline, double-click the "Video Redline" icon on your Desktop.', flat)
        self.assertNotIn("in the background", flat)
        code, out, flat = self.run_start(10, False)
        self.assertEqual(code, 10, out)
        self.assertIn("Nothing more to do: the helper is already running (in another window, or hidden). Closing this window does not stop that helper.", flat)
        self.assertNotIn("icon", flat.lower())

    ICON = 'To open Video Redline, double-click the "Video Redline" icon on your Desktop.'
    NO_ICON = 'No icon yet? Double-click "setup-autostart-windows.bat" (in this same folder) once to add it.'
    RATHER_NOT = 'If you would rather not, double-click "video-redline.html" (next to the tools folder) instead.'

    def test_an_already_running_helper_does_not_send_a_hand_start_person_to_an_icon_they_may_not_have(self):
        """Round 8 (R8-REV-3 / L6). The line used to be 'double-click the Video Redline icon on your Desktop' whenever setup-autostart-windows.bat
        was in the folder. A tester who chose 'I would rather not' (the hand start) has no icon, and double-clicking start-helper-windows.bat
        a second time ends here: the screen must say what to do without the icon, in the order of the other messages (icon, no icon yet, rather not)."""
        for name in ("tools", "Tom & Jerry ^ (100%) tools"):
            code, out, flat = self.run_start(10, True, name=name)
            self.assertEqual(code, 10, out)                                                  # the code is handed on
            for want in (self.ICON, self.NO_ICON, self.RATHER_NOT):
                self.assertIn(want, flat)
            self.assertLess(flat.index("Closing this window does not stop that helper."), flat.index(self.ICON))
            self.assertLess(flat.index(self.ICON), flat.index(self.NO_ICON))
            self.assertLess(flat.index(self.NO_ICON), flat.index(self.RATHER_NOT))
            self.assertIsNone(SAID_THE_PAGE_STARTS_IT.search(flat))
            self.assertNotIn("is not recognized", out)
            self.assertNotIn("unexpected at this time", out)

    def test_an_unexpected_stop_names_the_person_who_invited_you_to_the_beta(self):
        for with_autostart in (True, False):
            code, out, flat = self.run_start(3, with_autostart)
            self.assertEqual(code, 3, out)
            self.assertIn("PROBLEM: the helper stopped unexpectedly (code 3).", flat)
            self.assertIn('WHAT TO DO: double-click "start-helper-windows.bat" again. If it keeps stopping, send a screenshot of this window to '
                          'the person who invited you to the beta.', flat)
            self.assertNotIn("whoever", flat)

    def test_special_characters_in_the_folder_name_do_not_break_the_branches(self):
        for with_autostart in (True, False):
            code, out, flat = self.run_start(0, with_autostart, name="Tom & Jerry ^ (100%) tools")
            self.assertEqual(code, 0, out)
            self.assertEqual("setup-autostart" in flat, with_autostart, out)
            self.assertIn("The helper has stopped.", flat)
            self.assertNotIn("is not recognized", out)
            self.assertNotIn("unexpected at this time", out)


@unittest.skipUnless(WIN and HAVE_INSTALL, "needs the installed tools folder (uv, venv, models)")
class SandboxInstallTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if cloud_named(SCRATCH):                  # (setup-windows.bat would stop at its folder question, and the 1.5 GB copy would be uploaded)
            raise unittest.SkipTest("this checkout lies in a cloud-looking folder; the sandbox install is not built there. "
                                    "Run the tests from a plain folder inside your user folder, such as C:\\Users\\<your name>\\VideoRedline")
        cls.root = os.path.join(SCRATCH, "sandbox-root")
        safe_delete(cls.root)
        os.makedirs(cls.root)
        cls.dir = os.path.join(cls.root, "tools")
        cls.build(cls.dir)
        cls.wav = make_wav(os.path.join(cls.root, "clip", "hum.wav"))

    @classmethod
    def tearDownClass(cls):
        safe_delete(cls.root)

    @staticmethod
    def sh(cmd, env=None, ok=(0,)):
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, timeout=900)
        out = r.stdout.decode("utf-8", errors="replace")
        assert r.returncode in ok, "%s -> %s\n%s" % (cmd, r.returncode, out)
        return out

    @classmethod
    def build(cls, dest):
        """A working install like the one setup makes, built offline from the real one."""
        os.makedirs(dest)
        uvenv = dict(os.environ, UV_PYTHON_INSTALL_DIR=os.path.join(dest, "python"), UV_PYTHON_PREFERENCE="only-managed",
                     UV_NO_CONFIG="1", UV_OFFLINE="1", UV_PYTHON_DOWNLOADS="never")
        versioned = [p for p in glob.glob(os.path.join(REAL, "python", "cpython-3.12.*"))
                     if not os.path.islink(p) and not os.path.isjunction(p)]
        assert versioned, "the private Python is not installed"
        cls.sh(["robocopy", os.path.join(REAL, "uv"), os.path.join(dest, "uv"), "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"],
               ok=range(0, 8))
        cls.sh(["robocopy", versioned[0], os.path.join(dest, "python", os.path.basename(versioned[0])), "/E", "/NFL", "/NDL",
                "/NJH", "/NJS", "/NP"], ok=range(0, 8))
        uv = os.path.join(dest, "uv", "uv.exe")
        cls.sh([uv, "python", "install", "3.12", "--no-bin", "--no-registry"], env=uvenv)
        cls.sh([uv, "venv", os.path.join(dest, "venv"), "--python", "3.12"], env=uvenv)
        cls.sh(["robocopy", os.path.join(REAL, "venv", "Lib", "site-packages"), os.path.join(dest, "venv", "Lib", "site-packages"),
                "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"], ok=range(0, 8))
        cls.sh(["cmd", "/c", "mklink", "/J", os.path.join(dest, "hf-cache"), os.path.join(REAL, "hf-cache")])
        copy_code(dest)

    def env(self, **extra):
        return base_env(UV_OFFLINE="1", **extra)

    def transcribe(self, folder, env=None):
        out_json = os.path.splitext(self.wav)[0] + "-transcript.json"
        if os.path.exists(out_json):
            os.remove(out_json)
        code, out = run_bat(os.path.join(folder, "transcribe-windows.bat"), [self.wav], env=env or self.env())
        return code, out, out_json

    # (the tests run in alphabetical order and the last one moves the sandbox, hence the numbers)
    def test_1_python_variables_on_the_computer_do_not_break_the_launcher(self):
        poison = os.path.join(self.root, "poison")
        os.makedirs(poison, exist_ok=True)
        with open(os.path.join(poison, "numpy.py"), "w") as f:
            f.write("raise ImportError('a different numpy from PYTHONPATH was imported')\n")
        for name, extra in (("PYTHONHOME", {"PYTHONHOME": r"C:\no\such\python"}), ("PYTHONPATH", {"PYTHONPATH": poison})):
            with self.subTest(variable=name):
                code, out, out_json = self.transcribe(self.dir, env=self.env(**extra))
                self.assertEqual(code, 0, out)
                self.assertNotIn("Python path configuration", out)
                self.assertNotIn("different numpy", out)
                with open(out_json, encoding="utf-8") as f:
                    self.assertEqual(json.load(f)["format"], "video-review-transcript")

    def test_2_python_variables_on_the_computer_do_not_break_setup(self):
        code, out = run_bat(os.path.join(self.dir, "setup-windows.bat"),
                            env=self.env(PYTHONHOME=r"C:\no\such\python", PYTHONPATH=os.path.join(self.root, "poison")))
        self.assertEqual(code, 0, out)
        self.assertIn("ALL DONE", out)

    def autostart_stubs(self, folder):
        for name, text in (("setup-autostart-windows.bat", STUB_SETUP_AUTOSTART), ("remove-autostart-windows.bat", "@echo off\n"),
                           ("stop-helper-windows.bat", STUB_STOP)):
            stub(os.path.join(folder, name), text)

    def ran_files(self, folder):
        return sorted(n for n in os.listdir(folder) if n.startswith("ran-"))

    def remove_stubs(self, folder):
        for name in ("setup-autostart-windows.bat", "remove-autostart-windows.bat", "stop-helper-windows.bat", "ran-autostart.txt", "ran-stop.txt"):
            if os.path.exists(os.path.join(folder, name)):
                os.remove(os.path.join(folder, name))

    def test_2b_with_the_automatic_start_files_in_the_folder_a_run_that_nobody_watches_asks_nothing_and_starts_nothing(self):
        self.autostart_stubs(self.dir)
        self.addCleanup(self.remove_stubs, self.dir)
        code, out = run_bat(os.path.join(self.dir, "setup-windows.bat"), env=self.env(STUB_RC="0"))        # VRT_NO_PAUSE=1, nothing to type with
        self.assertEqual(code, 0, out)
        self.assertIn("ALL DONE", out)
        self.assertNotIn("start the helper by itself", out.lower())
        self.assertEqual(self.ran_files(self.dir), [], "no stand-in file may be run when the folder is fine and nobody was asked")
        self.assertNotIn("Stopping it first", out)                                                          # nothing to repair: no helper is stopped
        self.assertNotIn("End it first", out)

    def test_2c_at_a_keyboard_the_offer_comes_after_all_done_and_only_a_yes_starts_it(self):
        self.autostart_stubs(self.dir)
        self.addCleanup(self.remove_stubs, self.dir)
        env = self.env(STUB_RC="0")
        env.pop("VRT_NO_PAUSE")                                                                              # a person is at the keyboard
        code, out = run_bat_typing(os.path.join(self.dir, "setup-windows.bat"), b"n\r\n", "Start the helper by itself? (Y = yes, Enter = no)", env)
        self.assertEqual(code, 0, out)
        self.assertIn("ALL DONE", out)
        self.assertLess(out.index("ALL DONE"), out.index("Optional: start the helper by itself?"))
        self.assertEqual(self.ran_files(self.dir), [], "saying no changes nothing")
        code, out = run_bat_typing(os.path.join(self.dir, "setup-windows.bat"), b"y\r\n", "Start the helper by itself? (Y = yes, Enter = no)", env)
        self.assertEqual(code, 0, out)
        self.assertIn("STUB setup-autostart ran with [/yes]", out)
        self.assertEqual(self.ran_files(self.dir), ["ran-autostart.txt"])
        self.assertEqual(self.ran(self.dir, "autostart"), "args=/yes")

    def ran(self, folder, name):
        with open(os.path.join(folder, "ran-%s.txt" % name), "rb") as f:
            return f.read().decode("ascii").strip()

    def test_3_moved_folder_is_noticed_by_the_launcher_and_repaired_by_setup(self):
        moved = os.path.join(self.root, "Tom & Jerry ^ moved tools")
        os.rename(self.dir, moved)
        if True:
            # 1. the launcher says exactly what to do (instead of a cryptic "uv trampoline failed" and nothing else)
            code, out, _ = self.transcribe(moved)
            self.assertEqual(code, 1, out)
            self.assertIn("moved, renamed or copied", out)
            self.assertIn("setup-windows.bat", out)
            # 2. running setup again repairs it, offline, and keeps the models
            code, out = run_bat(os.path.join(moved, "setup-windows.bat"), env=self.env())
            self.assertEqual(code, 0, out)
            self.assertIn("Repairing the working space", out)
            self.assertIn("ALL DONE", out)
            self.assertNotIn("is not recognized", out)
            # a hidden helper may hold files of the folder: stop-helper-windows.bat is not in this folder, so setup can only say so
            self.assertIn("End it first, the way README.md describes", out)
            self.assertNotIn("stop-helper-windows", out)
            self.assertLess(out.index("Repairing the working space"), out.index("End it first"))
            self.assertLess(out.index("End it first"), out.index("ALL DONE"))
            # 3. and the launcher works again
            code, out, out_json = self.transcribe(moved)
            self.assertEqual(code, 0, out)
            self.assertTrue(os.path.isfile(out_json))
            # 4. moved once more, now with stop-helper-windows.bat in the folder (a stand-in for the real file): setup calls it before the
            #    repair, tells it not to wait for a key, and goes on
            moved_again = os.path.join(self.root, "moved again")
            os.rename(moved, moved_again)
            stub(os.path.join(moved_again, "stop-helper-windows.bat"), STUB_STOP)
            code, out = run_bat(os.path.join(moved_again, "setup-windows.bat"), env=self.env(STUB_RC="0"))
            self.assertEqual(code, 0, out)
            self.assertIn("Repairing the working space", out)
            self.assertIn("STUB stop-helper ran (VRT_NO_PAUSE=1)", out)
            self.assertEqual(self.ran(moved_again, "stop"), "no_pause=1")
            self.assertLess(out.index("Repairing the working space"), out.index("STUB stop-helper ran"))
            self.assertLess(out.index("STUB stop-helper ran"), out.index("[4 of 6]"))
            self.assertIn("ALL DONE", out)
            self.assertNotIn("End it first", out)                                                           # the advice is only for when the file is not there


if __name__ == "__main__":
    unittest.main()
