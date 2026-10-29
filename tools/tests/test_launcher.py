"""The hidden Windows launcher (helper_launcher.pyw) really reaches the helper's main().

Why this file exists: a one-line edit once joined the line "import vrt_server" onto the end of a comment. The file still compiled,
every other test passed, and the first person who installed the download got a launcher that ended with
"NameError: name 'vrt_server' is not defined" and a helper that never started. These tests run the REAL launcher file, in a scratch
folder next to a stand-in vrt_server.py, in a separate Python, under a mutex name of their own (the real one belongs to a running helper).
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

from _paths import REAL, SCRATCH

LAUNCHER = os.path.join(REAL, "helper_launcher.pyw")

RUNNER = textwrap.dedent('''
    import importlib.machinery, importlib.util, os, sys
    path = sys.argv[1]
    loader = importlib.machinery.SourceFileLoader("helper_launcher", path)
    spec = importlib.util.spec_from_loader("helper_launcher", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    module.MUTEX_NAME = "Local\\\\VRTLauncherTest" + str(os.getpid())     # never the mutex of a real running helper
    sys.exit(module.main())
''')


def stand_in(body):
    return textwrap.dedent('''
        DEFAULT_PORTS = (49991,)
        def probe_helper(port):
            return False
        def main(argv=None):
        ''') + textwrap.indent(textwrap.dedent(body).strip("\n"), "    ") + "\n"


class LauncherSourceTests(unittest.TestCase):
    def test_the_import_of_the_helper_is_a_statement_of_its_own(self):
        src = open(LAUNCHER, encoding="utf-8").read()
        lines = [ln for ln in src.splitlines() if "import vrt_server" in ln]
        self.assertTrue(lines, "the launcher no longer imports vrt_server")
        for ln in lines:
            self.assertRegex(ln, r"^\s+import vrt_server\b", "the import must start its own line: " + ln)
            self.assertNotIn("#", ln.split("import vrt_server")[0], "the import is inside a comment: " + ln)

    def test_the_helper_is_started_after_it_is_imported(self):
        src = open(LAUNCHER, encoding="utf-8").read()
        imported = re.search(r"^\s+import vrt_server\b", src, re.M)
        started = re.search(r"^\s+rc = vrt_server\.main\(", src, re.M)
        self.assertIsNotNone(imported)
        self.assertIsNotNone(started)
        self.assertLess(imported.start(), started.start())


@unittest.skipUnless(os.path.isfile(LAUNCHER), "helper_launcher.pyw is not in the tools folder")
class LauncherRunTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="launch-", dir=SCRATCH)
        self.copy = os.path.join(self.root, "helper_launcher.pyw")
        shutil.copy(LAUNCHER, self.copy)
        self.runner = os.path.join(self.root, "run_launcher.py")
        with open(self.runner, "w", encoding="utf-8") as f:
            f.write(RUNNER)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def run_launcher(self, helper_body):
        with open(os.path.join(self.root, "vrt_server.py"), "w", encoding="utf-8") as f:
            f.write(stand_in(helper_body))
        env = dict(os.environ)
        env["TEMP"] = env["TMP"] = self.root                    # (the log falls back to the temp folder only when the tools folder cannot be written)
        proc = subprocess.run([sys.executable, "-I", self.runner, self.copy], cwd=self.root, env=env,
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
        log_path = os.path.join(self.root, "logs", "helper.log")
        log = open(log_path, encoding="utf-8", errors="replace").read() if os.path.isfile(log_path) else ""
        return proc.returncode, log, proc.stdout.decode("utf-8", "replace")

    def test_the_launcher_reaches_the_helper_and_logs_its_end(self):
        code, log, out = self.run_launcher('print("STAND-IN HELPER RAN"); return 0')
        self.assertEqual(code, 0, log + out)
        self.assertIn("STAND-IN HELPER RAN", log, "the helper's own output must reach the log\n" + log)
        self.assertIn("The helper has ended (code 0)", log)
        self.assertNotIn("could not start", log)

    def test_a_helper_that_is_already_running_is_left_alone(self):
        code, log, out = self.run_launcher("return 10")
        self.assertEqual(code, 0, log + out)
        self.assertIn("A helper was already running. Nothing to do.", log)

    def test_a_helper_that_crashes_is_written_to_the_log(self):
        code, log, out = self.run_launcher('raise RuntimeError("stand-in crash")')
        self.assertEqual(code, 1, log + out)
        self.assertIn("The helper could not start", log)
        self.assertIn("stand-in crash", log)

    def test_the_command_line_is_ignored_and_the_work_folder_is_the_tools_folder(self):
        code, log, out = self.run_launcher('import os; print("CWD=" + os.getcwd()); return 0')
        self.assertEqual(code, 0, log + out)
        found = re.search(r"CWD=(.+)", log)
        self.assertIsNotNone(found, log)
        self.assertEqual(os.path.normcase(os.path.realpath(found.group(1).strip())), os.path.normcase(os.path.realpath(self.root)))


if __name__ == "__main__":
    unittest.main()
