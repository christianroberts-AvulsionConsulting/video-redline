"""The Mac launcher, checked without a Mac: add-launcher-mac.command (makes "Video Redline.app"), open-video-redline-mac.command (what the
app runs), stop-helper-mac.command, and the Mac side of open_video_review.pyw.

None of this has been run on a Mac. What these tests prove: the scripts are valid bash 3.2 text that runs where a bash exists (Git Bash on
Windows is enough), the app that is made carries the right folder even when its name has spaces and odd characters, the program inside the
app really starts the launcher with the private Python, problems are said in a box (a stand-in for osascript records the text), and the
Mac branches of open_video_review.pyw call "open", "osascript" and Popen the way a Mac needs. What they cannot prove: that macOS lets a
hand-made app start without a signature, that Finder shows it, or that "open" opens the browser.
"""
import importlib.machinery
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest

from _paths import NO_BASH, SCRATCH, TOOLS, find_bash

NEW_FILES = ("add-launcher-mac.command", "open-video-redline-mac.command", "stop-helper-mac.command")
OPENER = os.path.join(TOOLS, "open_video_review.pyw")


def text_of(name, base=TOOLS):
    with open(os.path.join(base, name), "rb") as f:
        return f.read().decode("utf-8")                                                   # (the scripts must also pass .encode("ascii"): see the byte rules)


def posix(path):
    return path.replace("\\", "/")


class MacLauncherTextTests(unittest.TestCase):
    def test_the_new_scripts_follow_the_byte_rules_of_the_other_mac_scripts(self):
        for name in NEW_FILES:
            raw = text_of(name).encode("ascii")
            self.assertTrue(raw.startswith(b"#!/bin/bash\n"), name)
            self.assertNotIn(b"\r", raw, name + " must be LF only")
            self.assertIn("Video Redline - ", text_of(name).splitlines()[2], name)       # the first comment line names the file's job

    def test_the_new_scripts_have_valid_syntax(self):
        bash = find_bash()
        if not bash:
            self.skipTest(NO_BASH)
        for name in NEW_FILES + ("setup-mac.command",):
            r = subprocess.run([bash, "-n", posix(os.path.join(TOOLS, name))], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, timeout=60)
            self.assertEqual(r.returncode, 0, name + ": " + r.stdout.decode("utf-8", "replace"))

    def test_nothing_in_them_needs_a_newer_bash_than_the_one_a_mac_has(self):
        """bash 3.2: no associative arrays, no mapfile, no ${var,,}, no ${var^^}, no &>> and no |&."""
        import re
        for name in NEW_FILES:
            for n, line in enumerate(text_of(name).splitlines(), 1):
                if line.lstrip().startswith("#"):
                    continue
                self.assertIsNone(re.search(r"declare\s+-A|mapfile|readarray|\$\{[A-Za-z_]+(,,|\^\^)\}|&>>|\|&", line), "%s line %d: %s" % (name, n, line))

    def test_setup_makes_the_app_as_its_last_step_and_says_what_to_do_with_it(self):
        setup = text_of("setup-mac.command")
        self.assertIn("[7 of 7]", setup)
        self.assertNotIn(" of 6]", setup)
        self.assertIn('bash "$TOOLS/add-launcher-mac.command" --quiet', setup)
        self.assertLess(setup.index("[6 of 7]"), setup.index("[7 of 7]"))
        self.assertLess(setup.index("[7 of 7]"), setup.index("ALL DONE"))
        # an app that could not be made is no reason to stop: the helper can still be started by hand
        self.assertIn("start-helper-mac.command", setup[setup.index("ALL DONE"):])

    def test_the_stop_script_only_touches_this_folders_helper(self):
        stop = text_of("stop-helper-mac.command")
        self.assertIn('*"$TOOLS/helper_launcher.pyw"*|*"$TOOLS/vrt_server.py"*', stop)
        self.assertNotIn("pkill", stop)
        self.assertNotIn("killall", stop)

    def test_the_release_zip_hands_out_the_new_scripts(self):
        path = os.path.join(TOOLS, "..", "make-release-zip.py")
        if not os.path.isfile(path):
            self.skipTest("make-release-zip.py is not next to the tools folder")
        with open(path, encoding="utf-8") as f:
            zip_script = f.read()
        for name in NEW_FILES:
            self.assertIn('"tools/%s"' % name, zip_script, name)

    def test_the_docs_no_longer_say_the_mac_start_is_not_built(self):
        self.assertNotIn("not built yet", text_of("AUTOSTART.md"))
        top = os.path.join(TOOLS, "..")
        for name, needle in (("README.md", "Video Redline.app"), (".gitignore", "/Video Redline.app/")):
            if not os.path.isfile(os.path.join(top, name)):
                continue                                                                  # not the repository layout: nothing to look at
            self.assertIn(needle, text_of(name, top), name)


@unittest.skipUnless(find_bash(), NO_BASH)
class MacLauncherRunTests(unittest.TestCase):
    """The real scripts, run with the real bash of this computer in a scratch copy, with stand-ins for the private Python and osascript."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="maclaunch-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, self.root, True)
        self.bin = os.path.join(self.root, "bin")
        os.makedirs(self.bin)
        self.record_args = posix(os.path.join(self.root, "python-args.txt"))
        self.record_boxes = posix(os.path.join(self.root, "boxes.txt"))
        self.write(os.path.join(self.bin, "osascript"),
                   '#!/bin/bash\nfor a in "$@"; do printf \'%s\\n\' "$a"; done >> "$VRT_TEST_BOXES"\nprintf \'%s\\n\' "----" >> "$VRT_TEST_BOXES"\n')

    @staticmethod
    def write(path, text):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", newline="\n") as f:
            f.write(text)
        os.chmod(path, 0o755)

    def make_folder(self, name="VideoRedline", with_python=True):
        """A Video Redline folder with the real scripts in its tools folder and, if asked, a stand-in venv/bin/python that records its arguments."""
        top = os.path.join(self.root, name)
        tools = os.path.join(top, "tools")
        os.makedirs(tools)
        for fname in NEW_FILES + ("open_video_review.pyw", "helper_launcher.pyw"):
            shutil.copy(os.path.join(TOOLS, fname), tools)
        if with_python:
            self.write(os.path.join(tools, "venv", "bin", "python"),
                       '#!/bin/bash\nfor a in "$@"; do printf \'%s\\n\' "$a"; done > "$VRT_TEST_ARGS"\nexit 0\n')
        return top, tools

    def run_sh(self, script, *args):
        env = dict(os.environ, VRT_NO_PAUSE="1", VRT_TEST_ARGS=self.record_args, VRT_TEST_BOXES=self.record_boxes,
                   PATH=self.bin + os.pathsep + os.environ.get("PATH", ""))
        r = subprocess.run([find_bash(), posix(script)] + list(args), input=b"", stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, timeout=120)
        return r.returncode, r.stdout.decode("utf-8", "replace")

    def boxes(self):
        try:
            with open(self.record_boxes, encoding="utf-8") as f:
                return f.read()
        except OSError:
            return ""

    def test_the_app_is_made_and_the_program_inside_it_starts_the_opener_with_the_private_python(self):
        top, tools = self.make_folder()
        code, out = self.run_sh(os.path.join(tools, "add-launcher-mac.command"), "--quiet")
        self.assertEqual(code, 0, out)
        app = os.path.join(top, "Video Redline.app")
        plist = text_of(os.path.join("Contents", "Info.plist"), app)
        self.assertIn("local.videoredline.launcher", plist)
        self.assertIn("<string>video-redline-launcher</string>", plist)
        stub = os.path.join(app, "Contents", "MacOS", "video-redline-launcher")
        self.assertTrue(os.path.isfile(stub))
        stub_text = text_of(os.path.join("Contents", "MacOS", "video-redline-launcher"), app)
        self.assertTrue(stub_text.startswith("#!/bin/bash\n"))
        self.assertEqual(subprocess.run([find_bash(), "-n", posix(stub)], timeout=60).returncode, 0)
        code, out = self.run_sh(stub)                                                    # what a double-click does
        self.assertEqual(code, 0, out)
        with open(self.record_args, encoding="utf-8") as f:
            args = f.read().split("\n")[:-1]
        self.assertEqual(args[:3], ["-E", "-X", "utf8"], args)
        self.assertTrue(args[3].endswith("/tools/open_video_review.pyw"), args)
        self.assertEqual(len(args), 4, args)
        self.assertEqual(self.boxes(), "")                                               # no complaint when all is well

    def test_running_it_again_is_safe_and_gives_the_same_app(self):
        top, tools = self.make_folder()
        script = os.path.join(tools, "add-launcher-mac.command")
        self.assertEqual(self.run_sh(script, "--quiet")[0], 0)
        stub = os.path.join(top, "Video Redline.app", "Contents", "MacOS", "video-redline-launcher")
        first = text_of(os.path.join("Contents", "MacOS", "video-redline-launcher"), os.path.join(top, "Video Redline.app"))
        code, out = self.run_sh(script)                                                  # without --quiet: the long closing text
        self.assertEqual(code, 0, out)
        self.assertIn("The \"Video Redline\" app is ready.", out)
        self.assertEqual(text_of(os.path.join("Contents", "MacOS", "video-redline-launcher"), os.path.join(top, "Video Redline.app")), first)
        self.assertTrue(os.path.isfile(stub))

    def test_a_folder_name_with_spaces_and_odd_characters_is_written_into_the_app_safely(self):
        top, tools = self.make_folder("Tom & Jerry's (1) $HOME `x`")
        code, out = self.run_sh(os.path.join(tools, "add-launcher-mac.command"), "--quiet")
        self.assertEqual(code, 0, out)
        stub = os.path.join(top, "Video Redline.app", "Contents", "MacOS", "video-redline-launcher")
        self.assertEqual(subprocess.run([find_bash(), "-n", posix(stub)], timeout=60).returncode, 0)
        code, out = self.run_sh(stub)
        self.assertEqual(code, 0, out)
        with open(self.record_args, encoding="utf-8") as f:
            args = f.read().split("\n")[:-1]
        self.assertTrue(args[3].endswith("/Tom & Jerry's (1) $HOME `x`/tools/open_video_review.pyw"), args)   # nothing was expanded or cut

    def test_something_else_called_video_redline_app_is_left_alone(self):
        top, tools = self.make_folder()
        foreign = os.path.join(top, "Video Redline.app", "Contents")
        os.makedirs(foreign)
        with open(os.path.join(foreign, "Info.plist"), "w", newline="\n") as f:
            f.write("<plist><dict><key>CFBundleIdentifier</key><string>com.someone.else</string></dict></plist>\n")
        code, out = self.run_sh(os.path.join(tools, "add-launcher-mac.command"), "--quiet")
        self.assertEqual(code, 1, out)
        self.assertIn("PROBLEM", out)
        self.assertIn("this tool did not make, so it was left alone", out)
        self.assertIn("WHAT TO DO", out)
        self.assertIn("com.someone.else", text_of("Info.plist", foreign))
        self.assertFalse(os.path.exists(os.path.join(top, "Video Redline.app", "Contents", "MacOS")))

    def test_a_missing_file_stops_it_with_what_to_do(self):
        top, tools = self.make_folder()
        os.remove(os.path.join(tools, "open_video_review.pyw"))
        code, out = self.run_sh(os.path.join(tools, "add-launcher-mac.command"), "--quiet")
        self.assertEqual(code, 1, out)
        self.assertIn("PROBLEM: A file that belongs with this one (open_video_review.pyw) is not in the tools folder.", " ".join(out.split()))
        self.assertIn("WHAT TO DO", out)
        self.assertFalse(os.path.exists(os.path.join(top, "Video Redline.app")))

    def test_without_the_one_time_setup_the_launcher_says_so_in_a_box(self):
        top, tools = self.make_folder(with_python=False)
        code, out = self.run_sh(os.path.join(tools, "open-video-redline-mac.command"))
        self.assertEqual(code, 1, out)
        box = self.boxes()
        self.assertIn("The one-time setup has not been run yet", box)
        self.assertIn("setup-mac.command", box)
        self.assertIn("on run argv", box)                                                # the text travels as an argument, never inside the AppleScript
        self.assertIn("Video Redline", box)

    def test_an_app_whose_folder_was_moved_says_so_in_a_box_instead_of_doing_nothing(self):
        top, tools = self.make_folder()
        self.assertEqual(self.run_sh(os.path.join(tools, "add-launcher-mac.command"), "--quiet")[0], 0)
        stub = os.path.join(top, "Video Redline.app", "Contents", "MacOS", "video-redline-launcher")
        os.rename(tools, tools + "-moved")
        code, out = self.run_sh(os.path.join(tools + "-moved", "..", "Video Redline.app", "Contents", "MacOS", "video-redline-launcher"))
        self.assertEqual(code, 1, out)
        self.assertIn("cannot find its tools folder", self.boxes())
        self.assertIn("setup-mac.command", self.boxes())
        self.assertTrue(os.path.isfile(stub))

    def test_a_launcher_with_part_of_the_tools_folder_missing_says_which_part(self):
        top, tools = self.make_folder()
        os.remove(os.path.join(tools, "helper_launcher.pyw"))
        code, out = self.run_sh(os.path.join(tools, "open-video-redline-mac.command"))
        self.assertEqual(code, 1, out)
        self.assertIn("Part of the tools folder is missing", self.boxes())
        self.assertFalse(os.path.exists(self.record_args))                               # and Python was not started


class FakeSubprocess(object):
    """Stands in for the subprocess module inside open_video_review.pyw: records every call, starts nothing."""
    DEVNULL = subprocess.DEVNULL
    SubprocessError = subprocess.SubprocessError
    TimeoutExpired = subprocess.TimeoutExpired

    def __init__(self, returncode=0):
        self.calls = []
        self.returncode = returncode

    def run(self, args, **kwargs):
        self.calls.append(("run", list(args), kwargs))
        return types.SimpleNamespace(returncode=self.returncode)

    def Popen(self, args, **kwargs):
        self.calls.append(("Popen", list(args), kwargs))
        return "the process"


class MacBranchOfTheOpenerTests(unittest.TestCase):
    """open_video_review.pyw is shared with Windows. Its functions read IS_WIN and IS_MAC when they run, so the Mac branches can be
    checked on any computer by switching those two and putting a recording stand-in where subprocess is."""

    def load(self, mac):
        loader = importlib.machinery.SourceFileLoader("open_video_review_under_test", OPENER)
        spec = importlib.util.spec_from_loader("open_video_review_under_test", loader)
        mod = importlib.util.module_from_spec(spec)
        loader.exec_module(mod)
        mod.IS_WIN, mod.IS_MAC = (not mac), mac
        mod._log = lambda text: None                                                     # never write into the real logs\helper.log
        mod.TOOLS = tempfile.mkdtemp(prefix="macopen-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, mod.TOOLS, True)
        mod.subprocess = FakeSubprocess()
        return mod

    def test_a_box_on_a_mac_is_an_osascript_dialog_with_the_text_as_an_argument(self):
        mod = self.load(mac=True)
        text = 'Line one\nHe said "stop" and \\ went away'
        mod._say(text)
        kind, args, kwargs = mod.subprocess.calls[0]
        self.assertEqual(args[0], "osascript")
        self.assertEqual(args[-2:], [text, "Video Redline"])                              # untouched: no escaping is needed
        self.assertIn("on run argv", args)
        self.assertIn("end run", args)
        self.assertTrue(any("display dialog (item 1 of argv)" in a for a in args))

    def test_the_page_is_opened_with_open_and_a_refusal_is_reported(self):
        mod = self.load(mac=True)
        self.assertTrue(mod._open_page("/Users/x/VideoRedline/video-redline.html"))
        self.assertEqual(mod.subprocess.calls[0][1], ["open", "/Users/x/VideoRedline/video-redline.html"])
        mod.subprocess.returncode = 1
        self.assertFalse(mod._open_page("/Users/x/VideoRedline/video-redline.html"))

    def test_the_helper_is_started_in_a_session_of_its_own_on_a_mac_and_detached_on_windows(self):
        mod = self.load(mac=True)
        self.assertEqual(mod._start_helper(), "the process")
        kind, args, kwargs = mod.subprocess.calls[0]
        self.assertEqual(args, [sys.executable, "-E", "-X", "utf8", mod.LAUNCHER])
        self.assertIs(kwargs.get("start_new_session"), True)
        self.assertNotIn("creationflags", kwargs)                                         # that argument is an error on a Mac
        self.assertEqual(kwargs["cwd"], mod.TOOLS)
        win = self.load(mac=False)
        win._start_helper()
        kwargs = win.subprocess.calls[0][2]
        self.assertEqual(kwargs.get("creationflags"), 0x00000008 | 0x00000200)           # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP, as before
        self.assertNotIn("start_new_session", kwargs)

    def test_the_boxes_say_app_and_mac_on_a_mac_and_keep_their_windows_words_on_windows(self):
        mac = self.load(mac=True)
        text = mac._helper_message("start")
        self.assertIn("open the Video Redline app again.", text)
        self.assertIn("give your Mac user account permission", text)
        self.assertNotIn("Windows", text)
        self.assertNotIn("icon", text)
        win = self.load(mac=False)
        text = win._helper_message("start")
        self.assertIn("click the Video Redline icon again.", text)
        self.assertIn("give your Windows account permission", text)

    @unittest.skipUnless(sys.platform != "win32", "flock is for a Mac or Linux")
    def test_a_second_click_while_the_first_is_working_does_nothing(self):
        mod = self.load(mac=True)
        mine, handle = mod._take_lock()
        self.assertTrue(mine)
        again, nothing = mod._take_lock()
        self.assertFalse(again)
        self.assertIsNone(nothing)
        mod._release_lock(handle)
        mine, handle = mod._take_lock()
        self.assertTrue(mine)
        mod._release_lock(handle)


if __name__ == "__main__":
    unittest.main()
