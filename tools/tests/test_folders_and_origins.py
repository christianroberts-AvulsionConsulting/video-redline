r"""Tests for: the folder check that setup and the helper make (cloud-synced folders), the "file://" origin, and the
wording of the launcher texts (Mac users are told to run .command files with bash, never to double-click them).

Run from the tools folder:
    venv\Scripts\python.exe -m unittest discover -s tests -p "test_folders_and_origins.py" -v          (Windows)
    venv/bin/python -m unittest discover -s tests -p "test_folders_and_origins.py" -v                  (Mac)

Also here: how the helper starts (a port that is in use is looked at for a few seconds, the scratch folders of a helper that was killed,
VRT_BACKGROUND, the syncWarning field of /status) and the two hooks of setup-windows.bat for the automatic start of the Video Redline app
(ends a hidden helper before a repair, offers setup-autostart-windows.bat at the end), which are tested with stand-in files.

Fast: no speech models, no network, nothing is downloaded. The helper is started inside this process on a spare port
(port 0 = the operating system picks one), never on the helper's own ports 47831 to 47835. The batch-file and bash tests
run the real setup files with the test switch VRT_STOP_AFTER_FOLDER_CHECK=1, which makes them stop right after the folder
check (before any download).
"""
import contextlib
import http.client
import importlib
import io
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

import _paths
from _paths import REAL, SCRATCH, TOOLS, NO_BASH, cloud_named, find_bash, module_file

WIN = sys.platform.startswith("win")
MAC_RECIPE = "On a Mac: open Terminal, type bash and a space, drag %s into the window, then press Return."
COMMANDS = ("setup-mac.command", "start-helper-mac.command", "transcribe-mac.command")


def _import(name):
    return importlib.import_module(name)


def read_text(name):
    with open(os.path.join(TOOLS, name), "rb") as f:
        return f.read().decode("utf-8")


def skip_in_a_cloud_folder(test):
    """For tests that expect the first cloud name to be the one in the folder they make (or no cloud name at all): the scripts
    answer for the first name in the whole path, so they cannot be told apart when this checkout itself lies in such a folder."""
    if cloud_named(test.root):
        test.skipTest("this checkout lies in a cloud-looking folder, whose name the scripts find first. Run the tests from a "
                      "plain folder inside your user folder, such as C:\\Users\\<your name>\\VideoRedline")


# ------------------------------------------------------------------------------------------------
# Item 20. The helper also accepts the Origin "file://" (Safari may send it)
# ------------------------------------------------------------------------------------------------
class OriginRuleTests(unittest.TestCase):
    def setUp(self):
        self.V = _import("vrt_server")

    def test_null_and_file_are_accepted(self):
        self.assertTrue(self.V.origin_allowed("null"))
        self.assertTrue(self.V.origin_allowed("file://"))

    def test_near_misses_and_foreign_origins_are_refused(self):
        for o in ("file://x", "file:///etc", "file:///", "file://localhost", "file:/", "file:", "File://", "FILE://", "NULL",
                  "Null", " file://", "file:// ", "file://null", "null:", "http://evil.example", "https://evil.example",
                  "http://localhost.evil.com", "http://127.0.0.1.evil.com", "https://localhost:3000", "http://[::1]:3000",
                  "http://localhost:99999", "", "*"):
            self.assertFalse(self.V.origin_allowed(o), repr(o))

    def test_the_other_rules_are_unchanged(self):
        V = self.V
        for o in ("http://localhost", "http://localhost:3000", "http://127.0.0.1", "http://127.0.0.1:5199"):
            self.assertTrue(V.origin_allowed(o), o)
        with mock.patch.object(V, "EXTRA_ORIGINS", {"https://tools.example.com"}):
            self.assertTrue(V.origin_allowed("https://tools.example.com"))
            self.assertFalse(V.origin_allowed("https://tools.example.com.evil.example"))
            self.assertFalse(V.origin_allowed("file://x"))

    def test_the_command_line_cannot_add_a_file_origin(self):
        # --allow-origin only takes http(s) addresses, so "file://x" can never become trusted through it
        V = self.V
        out = io.StringIO()
        with mock.patch.object(V, "EXTRA_ORIGINS", set()), contextlib.redirect_stdout(out):
            code = V.main(["--allow-origin", "file://x"])
            V.CON.flush()
        self.assertEqual(code, 1)
        self.assertIn("--allow-origin", out.getvalue())

    def test_the_log_names_a_file_page_the_same_way(self):
        self.assertEqual(self.V.origin_text("file://"), self.V.origin_text("null"))
        self.assertEqual(self.V.origin_text("null"), "a page opened from a file")
        self.assertEqual(self.V.origin_text("file://x"), "a page at file://x")


class _ReadyStub(object):
    """The real readiness check starts the speech tools; these tests only need the gate in front of /status."""

    def refresh_if_stale(self, *a, **k):
        pass

    def snapshot(self):
        return True, False, None


class OriginOverHttpTests(unittest.TestCase):
    """The real request handler, on a spare port of its own."""

    @classmethod
    def setUpClass(cls):
        cls.V = _import("vrt_server")
        cls.patches = [mock.patch.object(cls.V, "READY", _ReadyStub()), mock.patch.object(cls.V, "EXTRA_ORIGINS", set())]
        for p in cls.patches:
            p.start()
        cls.server = cls.V.HelperServer(("127.0.0.1", 0), cls.V.Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        for p in cls.patches:
            p.stop()

    def ask(self, method, path, origin=None, headers=None, extra_origin=None, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        try:
            c.putrequest(method, path)
            if origin is not None:
                c.putheader("Origin", origin)
            if extra_origin is not None:
                c.putheader("Origin", extra_origin)
            for k, v in (headers or {}).items():
                c.putheader(k, v)
            c.endheaders(body)
            r = c.getresponse()
            data = r.read()
            return r.status, dict((k.lower(), v) for k, v in r.getheaders()), data
        finally:
            c.close()

    def test_status_answers_a_page_opened_from_a_file(self):
        for origin in ("null", "file://"):
            status, h, data = self.ask("GET", "/status", origin)
            self.assertEqual(status, 200, origin)
            self.assertEqual(h.get("access-control-allow-origin"), origin, origin)
            self.assertIn(b'"helper":"video-review-helper"', data)

    def test_the_preflight_of_a_file_page_is_answered(self):
        for origin in ("null", "file://"):
            status, h, _ = self.ask("OPTIONS", "/jobs", origin, {"Access-Control-Request-Method": "POST",
                                                                   "Access-Control-Request-Headers": "content-type,x-options",
                                                                   "Access-Control-Request-Private-Network": "true"})
            self.assertEqual(status, 204, origin)
            self.assertEqual(h.get("access-control-allow-origin"), origin)
            self.assertEqual(h.get("access-control-allow-private-network"), "true")
            self.assertIn("POST", h.get("access-control-allow-methods", ""))

    def test_a_post_from_a_file_page_reaches_the_real_checks(self):
        # a file name the helper does not accept: the answer (415) comes from the upload checks, so the gate let it through
        for origin in ("null", "file://"):
            status, h, data = self.ask("POST", "/jobs?name=x.exe", origin,
                                       {"Content-Type": "application/octet-stream", "Content-Length": "3"}, body=b"abc")
            self.assertEqual(status, 415, origin)
            self.assertIn(b"bad-type", data)
            self.assertEqual(h.get("access-control-allow-origin"), origin)

    def test_foreign_origins_and_near_misses_get_403_and_no_cors_header(self):
        for origin in ("http://evil.example", "https://evil.example", "file://x", "file:///etc", "file:///", "File://", "FILE://",
                       "file://null", "http://localhost.evil.com", "http://user@localhost:3000"):
            for method, path in (("GET", "/status"), ("OPTIONS", "/jobs"), ("DELETE", "/jobs/" + "0" * 32)):
                status, h, data = self.ask(method, path, origin, {"Access-Control-Request-Method": "POST"})
                self.assertEqual(status, 403, "%s %s from %r" % (method, path, origin))
                self.assertNotIn("access-control-allow-origin", h)
            status, h, data = self.ask("POST", "/jobs?name=clip.mp4", origin,
                                       {"Content-Type": "application/octet-stream", "Content-Length": "3"}, body=b"abc")
            self.assertEqual(status, 403, origin)
            self.assertIn(b"bad-origin", data)

    def test_two_origin_headers_are_refused_even_if_both_are_fine(self):
        status, _, data = self.ask("GET", "/status", "null", extra_origin="file://")
        self.assertEqual(status, 403)
        status, _, data = self.ask("GET", "/status", "file://", extra_origin="https://evil.example")
        self.assertEqual(status, 403)

    def test_the_host_check_still_applies_to_a_file_page(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        try:
            c.putrequest("GET", "/status", skip_host=True)
            c.putheader("Host", "evil.example")
            c.putheader("Origin", "file://")
            c.endheaders()
            r = c.getresponse()
            body = r.read()
            self.assertEqual(r.status, 403)
            self.assertIn(b"bad-host", body)
        finally:
            c.close()

    def test_a_request_without_an_origin_still_works(self):
        status, h, _ = self.ask("GET", "/status")
        self.assertEqual(status, 200)
        self.assertNotIn("access-control-allow-origin", h)

    def test_status_says_syncwarning_yes_or_no_and_never_where(self):
        V = self.V
        for flag in (False, True):
            with mock.patch.dict(V._startup, {"sync_warning": flag}):
                status, h, data = self.ask("GET", "/status", "null")
            self.assertEqual(status, 200)
            text = data.decode("ascii")
            body = json.loads(text)
            self.assertIs(body["syncWarning"], flag)
            for gone in (V.TOOLS_DIR, V.TOOLS_DIR.replace("\\", "\\\\"), os.path.basename(V.TOOLS_DIR) + os.sep, "OneDrive", "Dropbox"):
                self.assertNotIn(gone, text)
        # additive: the fields the page already knew are all still there, and syncWarning is the only new one
        self.assertEqual(sorted(body), sorted(["ok", "helper", "version", "busy", "ready", "port", "maxUploadBytes", "syncWarning"]))
        self.assertEqual(body["helper"], "video-review-helper")

    def test_syncwarning_is_false_until_the_start_up_check_has_found_something(self):
        V = self.V
        self.assertIs(type(V._startup["sync_warning"]), bool)
        with mock.patch.dict(V._startup, {"sync_warning": 0}):                       # whatever main() stores, the answer is a yes or no
            self.assertIs(json.loads(self.ask("GET", "/status")[2])["syncWarning"], False)
        with mock.patch.dict(V._startup, {"sync_warning": ["a line"]}):
            self.assertIs(json.loads(self.ask("GET", "/status")[2])["syncWarning"], True)

    def test_the_page_at_the_root_follows_vrt_background(self):
        with mock.patch.dict(os.environ):
            os.environ.pop("VRT_BACKGROUND", None)
            text = self.ask("GET", "/")[2].decode("ascii")
            self.assertIn("Leave its window open", text)                              # without the variable nothing changes
            self.assertNotIn("background", text)
            for off in ("", "0", "false", "No"):
                os.environ["VRT_BACKGROUND"] = off
                self.assertEqual(self.ask("GET", "/")[2].decode("ascii"), text, repr(off))
            os.environ["VRT_BACKGROUND"] = "1"
            text = self.ask("GET", "/")[2].decode("ascii")
            self.assertIn("Video Redline helper is running in the background.", text)
            self.assertIn("Create transcript", text)
            self.assertNotIn("window", text)


# ------------------------------------------------------------------------------------------------
# Start-up: a port that is in use may belong to a helper that is still starting (bind_server waits for it a little)
# ------------------------------------------------------------------------------------------------
class _Stand(object):
    """A program that listens on a port, for the port tests. It has bound the port when it is made.
    mode 'helper': accepts at once, says nothing until `delay` seconds have passed, then answers /status like a helper (a helper that
        is slow to start). 'silent': accepts and never answers. 'web': answers at once with text that is no helper. 'json': answers at
        once with the JSON of another program. 'hangup': reads the request and closes the connection. 'deep' / 'deepobj': answers at
        once with JSON that is nested far too deep for json.loads (5000 levels of [ or of {"a":), which ends in RecursionError.
        close_after: gives the port back after that many seconds."""

    def __init__(self, port, mode, delay=0.0, close_after=None):
        self.port, self.mode, self.delay = port, mode, delay
        self.t0 = time.time()
        self.stop = threading.Event()
        self.conns = []
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", port))
        self.sock.listen(16)
        self.sock.settimeout(0.1)
        threading.Thread(target=self._serve, daemon=True).start()
        if close_after is not None:
            threading.Timer(close_after, self.close).start()

    def _serve(self):
        while not self.stop.is_set():
            try:
                c, _ = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            self.conns.append(c)
            threading.Thread(target=self._answer, args=(c,), daemon=True).start()

    def _send(self, c, ctype, body):
        head = "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % (ctype, len(body))
        c.sendall(head.encode("ascii") + body)

    def _answer(self, c):
        try:
            if self.mode == "silent":
                self.stop.wait(600)
                return
            c.settimeout(5)
            c.recv(4096)
            if self.mode == "hangup":
                return
            if self.mode == "web":
                return self._send(c, "text/plain", b"hello, I am a web server but not the helper")
            if self.mode == "json":
                return self._send(c, "application/json", b'{"ok":true,"helper":"some-other-program"}')
            if self.mode == "deep":
                return self._send(c, "application/json", b"[" * 5000)
            if self.mode == "deepobj":
                return self._send(c, "application/json", b'{"a":' * 5000)
            self.stop.wait(max(0.0, self.delay - (time.time() - self.t0)))
            body = json.dumps({"ok": True, "helper": "video-review-helper", "version": "1.0.0", "busy": False, "ready": False,
                               "checking": True, "port": self.port}).encode("ascii")
            self._send(c, "application/json", body)
        except OSError:
            pass
        finally:
            try:
                c.close()
            except OSError:
                pass

    def close(self):
        self.stop.set()
        try:
            self.sock.close()
        except OSError:
            pass
        for c in self.conns:
            try:
                c.close()
            except OSError:
                pass


class PortProbeTests(unittest.TestCase):
    """bind_server: when the first port is in use, look at it for a few seconds (VRT_PORT_PROBE_S) before moving on, so the slow
    winner of a start-up race is found as 'already running' and no second helper takes the next port."""

    def setUp(self):
        self.V = _import("vrt_server")
        self.stands = []
        self.servers = []
        self.addCleanup(self.cleanup)
        self.p1, self.p2 = self.two_free_ports()

    def cleanup(self):
        for s in self.stands:
            s.close()
        for s in self.servers:
            s.server_close()

    @staticmethod
    def two_free_ports():
        socks = [socket.socket() for _ in range(2)]
        try:
            for s in socks:
                s.bind(("127.0.0.1", 0))
            return [s.getsockname()[1] for s in socks]
        finally:
            for s in socks:
                s.close()

    def stand(self, port, mode, **kw):
        s = _Stand(port, mode, **kw)
        self.stands.append(s)
        return s

    def bind(self, wait):
        t0 = time.time()
        with mock.patch.object(self.V, "PORT_PROBE_S", wait):
            server, running_on = self.V.bind_server((self.p1, self.p2))
        if server is not None:
            self.servers.append(server)
        return server, running_on, time.time() - t0

    def test_a_free_port_is_taken_at_once(self):
        server, running_on, took = self.bind(30)
        self.assertIsNotNone(server)
        self.assertIsNone(running_on)
        self.assertEqual(server.server_address[1], self.p1)
        self.assertLess(took, 3)

    def test_a_helper_that_is_slow_to_answer_is_found_as_already_running_and_the_next_port_stays_free(self):
        self.stand(self.p1, "helper", delay=3.0)
        server, running_on, took = self.bind(6)
        self.assertIsNone(server, "a second helper took the next port")
        self.assertEqual(running_on, self.p1)
        self.assertGreaterEqual(took, 2.7, "it did not wait for the answer")
        self.assertLess(took, 6.5)
        s = socket.socket()
        try:
            s.bind(("127.0.0.1", self.p2))                                     # nothing took the next port
        finally:
            s.close()

    def test_a_program_that_accepts_and_never_answers_is_skipped_after_the_wait_and_not_before(self):
        self.stand(self.p1, "silent")
        server, running_on, took = self.bind(1.0)
        self.assertIsNone(running_on)
        self.assertEqual(server.server_address[1], self.p2)
        self.assertGreaterEqual(took, 0.9, "it gave up on the busy port at once")
        self.assertLess(took, 8)

    def test_a_program_that_answers_but_is_no_helper_is_skipped_at_once(self):
        for mode in ("web", "json", "hangup"):
            with self.subTest(mode=mode):
                s = self.stand(self.p1, mode)
                server, running_on, took = self.bind(30)
                self.assertIsNone(running_on)
                self.assertEqual(server.server_address[1], self.p2, mode)
                self.assertLess(took, 5, "it waited for a program that is clearly no helper")
                server.server_close()
                self.servers.remove(server)
                s.close()
                time.sleep(0.2)

    def test_a_port_that_is_given_back_while_it_waits_is_taken(self):
        self.stand(self.p1, "silent", close_after=1.0)
        server, running_on, took = self.bind(10)
        self.assertIsNone(running_on)
        self.assertEqual(server.server_address[1], self.p1, "the port was free again, but the next one was taken")
        self.assertGreaterEqual(took, 0.8)
        self.assertLess(took, 8)

    def test_an_error_that_is_not_busy_is_not_waited_for(self):
        real = self.V.HelperServer
        stand = self.stand(self.p1, "silent")

        def refuse_the_first(addr, handler):
            if addr[1] == self.p1:
                raise PermissionError(13, "not allowed")
            return real(addr, handler)

        with mock.patch.object(self.V, "HelperServer", side_effect=refuse_the_first):
            t0 = time.time()
            with mock.patch.object(self.V, "PORT_PROBE_S", 30):
                server, running_on = self.V.bind_server((self.p1, self.p2))
            took = time.time() - t0
        self.servers.append(server)
        self.assertEqual(server.server_address[1], self.p2)
        self.assertLess(took, 8, "it waited as if the port were in use by a starting helper")
        stand.close()

    def test_probe_port_tells_the_answers_apart(self):
        V = self.V
        self.stand(self.p1, "helper", delay=0.0)
        self.assertEqual(V.probe_port(self.p1), "helper")
        self.assertIs(V.probe_helper(self.p1), True)
        for mode, want in (("web", "other"), ("json", "other"), ("hangup", "other"), ("silent", None)):
            p = self.two_free_ports()[0]
            s = self.stand(p, mode)
            self.assertEqual(V.probe_port(p, timeout=0.5), want, mode)
            if mode != "silent":
                self.assertIs(V.probe_helper(p), False, mode)
            s.close()
        self.assertIsNone(V.probe_port(self.two_free_ports()[0], timeout=3.0), "nothing listens: nobody answers")

    def test_a_program_that_answers_with_json_too_deep_to_read_is_just_another_program(self):
        """probe_port used to let RecursionError out of json.loads: probe_helper() and bind_server() raised, and main() (which does not
        catch it) could not start while such a program sat on the first port. Now it is 'other': skipped at once, as before."""
        V = self.V
        for mode in ("deep", "deepobj"):
            with self.subTest(mode=mode):
                p1, p2 = self.two_free_ports()
                s = self.stand(p1, mode)
                self.assertEqual(V.probe_port(p1, timeout=2.0), "other")
                self.assertIs(V.probe_helper(p1), False)
                t0 = time.time()
                with mock.patch.object(V, "PORT_PROBE_S", 30):
                    server, running_on = V.bind_server((p1, p2))
                took = time.time() - t0
                self.servers.append(server)
                self.assertIsNone(running_on)
                self.assertIsNotNone(server, "bind_server found no port")
                self.assertEqual(server.server_address[1], p2, mode)
                self.assertLess(took, 5, "it waited for a program that is clearly no helper")
                s.close()

    def test_the_wait_comes_from_vrt_port_probe_s(self):
        def value(**env):
            e = {k: v for k, v in os.environ.items() if k != "VRT_PORT_PROBE_S"}
            e.update(env)
            r = subprocess.run([sys.executable, "-c", "import sys; sys.path.insert(0, %r); import vrt_server as v; print(v.PORT_PROBE_S)" % TOOLS],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=e, timeout=60)
            return r.stdout.decode().strip()
        self.assertEqual(value(), "4.0")
        self.assertEqual(value(VRT_PORT_PROBE_S="0.5"), "0.5")
        self.assertEqual(value(VRT_PORT_PROBE_S="nonsense"), "4.0")
        self.assertEqual(value(VRT_PORT_PROBE_S="-3"), "0.0")


# ------------------------------------------------------------------------------------------------
# Start-up: scratch folders (tmp/run-*) of a helper that was killed are deleted by the next start at once
# ------------------------------------------------------------------------------------------------
class RunDirOwnerTests(unittest.TestCase):
    """Who owns tmp/run-*: the helper that made the job marks the folder (vrt-owner.txt: its folder name and a token), the lock file
    tmp/jobs-<port>.lock carries the same token while it runs. A folder whose owner has ended is stale at once; every other folder
    (no mark, owner running, this very helper) keeps the old age rule (older than 5 minutes, and only when no other helper runs)."""
    ME, TOKEN = "jobs-47000", "a" * 16

    def setUp(self):
        self.V = V = _import("vrt_server")
        self.tmp = tempfile.mkdtemp(prefix="own-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        for p in (mock.patch.object(V, "TMP_DIR", self.tmp), mock.patch.object(V, "RUN_DIR_BASE", self.tmp),
                  mock.patch.object(V, "JOBS_DIR", os.path.join(self.tmp, self.ME)),
                  mock.patch.dict(V._instance, {"name": self.ME, "lock": None, "token": self.TOKEN})):
            p.start()
            self.addCleanup(p.stop)
        self.locks = []
        self.addCleanup(lambda: [l.release() for l in self.locks])
        V._instance["lock"] = self.hold(self.ME, self.TOKEN)                       # this helper, as claim_instance_folder makes it

    def hold(self, name, token):
        """A running helper with this folder name (in this process: a second lock on the same file is refused, as between processes)."""
        lock = self.V.FileLock(self.V.lock_path_for(name))
        self.assertIs(lock.try_acquire(), True)
        lock.write_note(token + "\n")
        self.locks.append(lock)
        return lock

    def run_dir(self, name, owner=None, age=0):
        p = os.path.join(self.tmp, name)
        os.makedirs(p)
        with open(os.path.join(p, "audio.raw"), "wb") as f:
            f.write(b"x" * 100)
        if owner:
            with open(os.path.join(p, "vrt-owner.txt"), "w") as f:
                f.write("%s %s\n" % owner)
        if age:
            t = time.time() - age
            os.utime(p, (t, t))
        return name

    def left(self):
        return sorted(n for n in os.listdir(self.tmp) if n.startswith("run-"))

    # ---- the mark ---------------------------------------------------------------------------------
    def test_the_mark_names_the_helper_and_reads_back(self):
        V = self.V
        n = self.run_dir("run-mine")
        V.mark_run_dir(n)
        with open(os.path.join(self.tmp, n, V.RUN_OWNER_FILE), "rb") as f:
            self.assertEqual(f.read(), ("%s %s\n" % (self.ME, self.TOKEN)).encode("ascii"))
        self.assertEqual(V.run_dir_owner(n), (self.ME, self.TOKEN))

    def test_no_mark_when_the_folder_is_gone_or_when_nobody_could_tell_whether_this_helper_lives(self):
        V = self.V
        V.mark_run_dir("run-not-there")                                                # no error, and the folder is not made
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "run-not-there")))
        n = self.run_dir("run-no-lock")
        with mock.patch.dict(V._instance, {"lock": None}):
            V.mark_run_dir(n)
        self.assertIsNone(V.run_dir_owner(n))

    def test_a_mark_that_is_not_readable_means_no_owner(self):
        V = self.V
        n = self.run_dir("run-x")
        self.assertIsNone(V.run_dir_owner(n))                                          # none yet
        for text in ("", "garbage", "jobs-47000", "jobs-47000 short", "other-47000 " + "b" * 16, "jobs-47000 " + "B" * 16,
                     "jobs-47000 " + "b" * 16 + " extra"):
            with open(os.path.join(self.tmp, n, V.RUN_OWNER_FILE), "w") as f:
                f.write(text)
            self.assertIsNone(V.run_dir_owner(n), repr(text))
        self.assertIsNone(V.run_dir_owner("run-no-such-folder"))

    def test_the_job_marks_the_scratch_folder_it_finds(self):
        V = self.V
        job = V.Job("f" * 32, ".wav", 10, "x.wav", None)

        class Proc(object):
            def poll(self):
                return None

        spawn = V.FileLock(os.path.join(self.tmp, "spawn.lock"))
        self.assertIs(spawn.try_acquire(), True)
        V.start_claim(job, Proc(), V.run_dir_names(), spawn)
        self.run_dir("run-made-by-the-job")                                             # what transcribe.py does a moment later
        job.claim_thread.join(15)
        self.assertEqual(job.run_dirs, {"run-made-by-the-job"})
        self.assertEqual(V.run_dir_owner("run-made-by-the-job"), (self.ME, self.TOKEN))

    def test_the_lock_file_carries_the_token_of_the_helper_that_holds_it(self):
        V = self.V
        with mock.patch.dict(V._instance, {"name": "jobs", "lock": None}):
            name = V.claim_instance_folder(47123, wait=0.5)
            try:
                self.assertEqual(name, "jobs-47123")
                with open(V.lock_path_for(name), "rb") as f:
                    self.assertEqual(f.read().decode("ascii"), self.TOKEN + "\n")
            finally:
                V.release_instance_folder()
        self.assertFalse(os.path.exists(V.lock_path_for("jobs-47123")))

    # ---- what start-up deletes --------------------------------------------------------------------
    def test_the_folder_of_a_helper_that_was_killed_goes_at_once_but_a_young_folder_of_an_unknown_owner_stays(self):
        V = self.V
        gone_a = self.run_dir("run-owner-no-lock-file", ("jobs-47001", "b" * 16))             # killed: its lock file was cleaned or never seen
        open(V.lock_path_for("jobs-47002"), "w").close()
        gone_b = self.run_dir("run-owner-lock-free", ("jobs-47002", "c" * 16))                # killed: lock file left, nobody holds it
        keep = self.run_dir("run-no-mark-young")
        self.run_dir("run-no-mark-old", age=3600)
        V.clean_stale_run_dirs()
        self.assertEqual(self.left(), [keep], "dead owners and old folders go, a young folder without mark stays: %s" % self.left())
        self.assertNotIn(gone_a, self.left())
        self.assertNotIn(gone_b, self.left())

    def test_a_helper_that_started_again_on_the_same_port_does_not_keep_the_folder_of_its_dead_predecessor(self):
        n = self.run_dir("run-predecessor", (self.ME, "d" * 16))                              # same folder name, another token: a run before this one
        self.run_dir("run-mine", (self.ME, self.TOKEN))
        self.V.clean_stale_run_dirs()
        self.assertEqual(self.left(), ["run-mine"])
        self.assertNotIn(n, self.left())

    def test_while_another_helper_runs_only_the_folders_of_a_dead_owner_go(self):
        V = self.V
        self.hold("jobs-47003", "e" * 16)                                                      # a second helper, running
        self.assertTrue(V.other_helpers_alive())
        live = self.run_dir("run-of-the-running-helper", ("jobs-47003", "e" * 16))
        live_old = self.run_dir("run-of-the-running-helper-old", ("jobs-47003", "e" * 16), age=3600)
        dead = self.run_dir("run-of-a-dead-helper", ("jobs-47004", "f" * 16))
        taken_over = self.run_dir("run-of-a-helper-whose-name-was-taken-over", ("jobs-47003", "9" * 16))   # 47003 now belongs to a later helper
        unmarked_young = self.run_dir("run-unmarked-young")
        unmarked_old = self.run_dir("run-unmarked-old", age=3600)                              # (it may be that helper's: not touched)
        V.clean_orphaned_run_dirs()
        self.assertEqual(self.left(), sorted([live, live_old, unmarked_young, unmarked_old]),
                         "left: %s" % self.left())
        self.assertNotIn(dead, self.left())
        self.assertNotIn(taken_over, self.left())

    def test_the_old_rule_stays_for_everything_that_is_not_certainly_dead(self):
        V = self.V
        self.hold("jobs-47003", "e" * 16)
        young_live = self.run_dir("run-live-young", ("jobs-47003", "e" * 16))
        old_live = self.run_dir("run-live-old", ("jobs-47003", "e" * 16), age=3600)
        old_mine = self.run_dir("run-mine-old", (self.ME, self.TOKEN), age=3600)
        young_mine = self.run_dir("run-mine-young", (self.ME, self.TOKEN))
        V.clean_stale_run_dirs()                                                               # (main() only calls it when no helper runs)
        self.assertEqual(self.left(), sorted([young_live, young_mine]), "older than 5 minutes goes as it always did; young stays")
        self.assertNotIn(old_live, self.left())
        self.assertNotIn(old_mine, self.left())

    def test_clean_stale_run_dirs_with_zero_still_removes_every_folder(self):
        # what stop-helper-windows.bat calls (after it has made sure that no helper runs): its meaning must not change
        V = self.V
        self.hold("jobs-47003", "e" * 16)
        for i, owner in enumerate([None, ("jobs-47003", "e" * 16), ("jobs-47009", "1" * 16), (self.ME, self.TOKEN)]):
            self.run_dir("run-%d" % i, owner, age=5)
        V.clean_stale_run_dirs(0)
        self.assertEqual(self.left(), [])

    def test_when_nobody_can_tell_whether_the_owner_lives_the_folder_is_kept(self):
        V = self.V
        self.hold("jobs-47003", "e" * 16)
        a = self.run_dir("run-cannot-tell", ("jobs-47003", "e" * 16))
        with mock.patch.object(V.FileLock, "try_acquire", return_value=None):                  # this drive does not do file locks
            V.clean_orphaned_run_dirs()
        self.assertEqual(self.left(), [a])
        # the lock is held, but the lock file cannot be read: the token cannot be compared, so the folder stays
        self.hold("jobs-47006", "8" * 16)
        b = self.run_dir("run-lock-file-unreadable", ("jobs-47006", "6" * 16))
        real_open = open

        def refuse_reading_the_lock(path, *args, **kw):
            if str(path).endswith(".lock"):
                raise PermissionError(13, "no")
            return real_open(path, *args, **kw)

        with mock.patch("builtins.open", side_effect=refuse_reading_the_lock):
            V.clean_orphaned_run_dirs()
        self.assertEqual(self.left(), sorted([a, b]))
        V.clean_orphaned_run_dirs()                                                            # readable again: that token is a later helper's
        self.assertEqual(self.left(), [a])

    def test_the_whole_start_up_calls_the_right_one(self):
        # main(): no other helper running -> clean_stale_run_dirs(); another one running -> clean_orphaned_run_dirs()
        src = read_text("vrt_server.py")
        self.assertRegex(src, r"if not other_helpers_alive\(\):\n\s+clean_stale_run_dirs\(\)\n\s+else:\n\s+clean_orphaned_run_dirs\(\)")
        # ... and the lock file that the helpers share while a job starts is tidied right after (it checks for other helpers itself)
        self.assertRegex(src, r"clean_orphaned_run_dirs\(\)[^\n]*\n\s+clean_spawn_lock\(\)")


# ------------------------------------------------------------------------------------------------
# tmp/spawn.lock: the lock file that the helpers share while a job starts. It stays after a job only because nobody deleted it.
# ------------------------------------------------------------------------------------------------
class SpawnLockTests(unittest.TestCase):
    ME = "jobs-47000"

    def setUp(self):
        self.V = V = _import("vrt_server")
        self.tmp = tempfile.mkdtemp(prefix="spl-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.path = os.path.join(self.tmp, "spawn.lock")
        for p in (mock.patch.object(V, "TMP_DIR", self.tmp), mock.patch.object(V, "RUN_DIR_BASE", self.tmp),
                  mock.patch.object(V, "SPAWN_LOCK_PATH", self.path), mock.patch.object(V, "JOBS_DIR", os.path.join(self.tmp, self.ME)),
                  mock.patch.dict(V._instance, {"name": self.ME, "lock": None, "token": "a" * 16})):
            p.start()
            self.addCleanup(p.stop)
        self.locks = []
        self.addCleanup(lambda: [l.release() for l in self.locks])
        self.hold(self.ME)                                                       # this helper runs

    def hold(self, name):
        lock = self.V.FileLock(self.V.lock_path_for(name))
        self.assertIs(lock.try_acquire(), True)
        self.locks.append(lock)
        return lock

    def make(self):
        open(self.path, "w").close()

    def test_it_goes_when_no_other_helper_runs_and_nobody_holds_it(self):
        self.make()
        self.V.clean_spawn_lock()
        self.assertFalse(os.path.exists(self.path))

    def test_it_stays_while_another_helper_runs(self):
        self.make()
        self.hold("jobs-47003")                                                  # a second helper: it may be about to start a job
        self.V.clean_spawn_lock()
        self.assertTrue(os.path.exists(self.path))

    def test_it_stays_while_somebody_holds_it(self):
        self.make()
        spawn = self.V.FileLock(self.path)
        self.assertIs(spawn.try_acquire(), True)                                 # a job is just starting its speech process
        self.V.clean_spawn_lock()
        self.assertTrue(os.path.exists(self.path))
        spawn.release()
        self.V.clean_spawn_lock()
        self.assertFalse(os.path.exists(self.path))

    def test_nothing_to_delete_is_not_an_error_and_makes_no_file(self):
        self.V.clean_spawn_lock()
        self.assertFalse(os.path.exists(self.path))
        with mock.patch.object(self.V, "other_helpers_alive", side_effect=RuntimeError("x")):
            self.make()
            self.V.clean_spawn_lock()                                            # never raises
        self.assertTrue(os.path.exists(self.path))

    def test_a_job_that_has_found_its_scratch_folder_tidies_it(self):
        V = self.V

        class Proc(object):
            def poll(self):
                return None

        for others, want_left in ((False, False), (True, True)):
            with self.subTest(another_helper_runs=others):
                self.make()
                if others:
                    self.hold("jobs-47004")
                job = V.Job("f" * 32, ".wav", 10, "x.wav", None)
                spawn = V.FileLock(self.path)
                self.assertIs(spawn.try_acquire(), True)                        # what run_job does before it starts transcribe.py
                V.start_claim(job, Proc(), V.run_dir_names(), spawn)
                os.makedirs(os.path.join(self.tmp, "run-made-by-%s" % others))   # what transcribe.py does a moment later
                job.claim_thread.join(15)
                self.assertEqual(os.path.exists(self.path), want_left)

    def test_run_job_and_start_up_use_it(self):
        src = read_text("vrt_server.py")
        self.assertRegex(src, r"finally:\n\s+spawn_lock\.release\(\)\n\s+clean_spawn_lock\(spawn_lock\.path\)")
        main = src[src.index("def main(argv=None):"):]
        self.assertLess(main.index("clean_orphaned_run_dirs()"), main.index("clean_spawn_lock()"))
        self.assertLess(main.index("clean_spawn_lock()"), main.index("atexit.register(shutdown_all)"))


# ------------------------------------------------------------------------------------------------
# GET /status says syncWarning right from the first answer: the folder check is made before the helper starts to answer
# ------------------------------------------------------------------------------------------------
class _FastReady(object):
    """main() asks the readiness check, which starts the speech tools; here it says 'ready' at once."""

    def refresh(self):
        pass

    def snapshot(self):
        return True, False, None

    def refresh_if_stale(self, *a, **k):
        pass


class _NotReady(_FastReady):
    """The same, but the speech tools are not set up: it says 'not ready' with this problem text (the start-up window then prints it)."""

    def __init__(self, problem):
        self.problem = problem

    def snapshot(self):
        return False, False, self.problem


class _TimeProxy(object):
    """vrt_server's own view of the time module while main() runs in a thread of a test: sleep() is short, and once `stop` is set it ends
    the waiting loop of main() the way Ctrl+C does (only in the thread that runs main())."""

    def __init__(self, stop, owner):
        self._stop, self._owner, self._fired = stop, owner, False

    def __getattr__(self, name):
        return getattr(time, name)

    def sleep(self, seconds):
        if self._stop.is_set() and not self._fired and threading.current_thread() is self._owner[0]:
            self._fired = True                                                       # (once: the clean-up that follows must be able to wait)
            raise KeyboardInterrupt()
        time.sleep(min(seconds, 0.05))


class StartUpSyncWarningTests(unittest.TestCase):
    """main() runs inside this process (in a thread) on a spare port: bind_server is replaced by a server on port 0, the speech-tool check
    by one that says 'ready'. Only the folder check is slow or loud, as a Mac's `defaults` and `mount` can be."""

    def setUp(self):
        self.V = V = _import("vrt_server")
        self.tmp = tempfile.mkdtemp(prefix="su-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.server = V.HelperServer(("127.0.0.1", 0), V.Handler)                # listens already: a request waits until main() serves
        self.port = self.server.server_address[1]
        self.assertNotIn(self.port, V.DEFAULT_PORTS)
        self.stop = threading.Event()
        self.owner = [None]
        self.result = {}
        self.out = io.StringIO()
        self.thread = None

    def start(self, sync_warning, **patches):
        V = self.V
        pairs = [mock.patch.object(V, "TMP_DIR", self.tmp), mock.patch.object(V, "RUN_DIR_BASE", self.tmp),
                 mock.patch.object(V, "SPAWN_LOCK_PATH", os.path.join(self.tmp, "spawn.lock")),
                 mock.patch.object(V, "JOBS_DIR", os.path.join(self.tmp, "jobs")),
                 mock.patch.dict(V._instance, {"name": "jobs", "lock": None, "token": "a" * 16}),
                 mock.patch.dict(V._startup, {"sync_warning": False}), mock.patch.object(V, "_shutdown_done", False),
                 mock.patch.object(V, "bind_server", return_value=(self.server, None)), mock.patch.object(V, "win_setup"),
                 mock.patch.object(V, "READY", patches.get("ready") or _FastReady()), mock.patch.object(V, "sync_warning", sync_warning),
                 mock.patch.object(V.atexit, "register"), mock.patch.object(V, "time", _TimeProxy(self.stop, self.owner)),
                 mock.patch.object(V, "SYNC_WAIT_S", patches.get("wait", 1.0)), mock.patch.object(V, "TOOLS_DIR", self.tmp)]
        for p in pairs:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.finish)

        def run():
            self.owner[0] = threading.current_thread()
            try:
                with contextlib.redirect_stdout(self.out):
                    self.result["code"] = V.main(["--port", str(self.port + 1)])        # (the port number is not used: bind_server is replaced)
            except BaseException as e:
                self.result["error"] = e

        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()

    def finish(self):
        self.stop.set()
        if self.thread is not None:
            self.thread.join(20)
            self.assertFalse(self.thread.is_alive(), "main() did not end")
        self.assertEqual(self.result.get("code"), 0, self.result)
        self.server.server_close()

    def status(self, timeout=15):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        try:
            t0 = time.time()
            c.request("GET", "/status")
            r = c.getresponse()
            return json.loads(r.read().decode("ascii")), time.time() - t0
        finally:
            c.close()

    def test_the_first_answer_already_says_true_when_the_folder_check_takes_a_moment(self):
        def slow_warning(path, **kw):
            time.sleep(0.4)
            return ["WARNING: this tools folder is inside a folder that OneDrive synchronises."]

        self.start(slow_warning)
        body, took = self.status()                                                  # asked at once: it is answered when main() serves
        self.assertIs(body["syncWarning"], True, "the first answer said no although the folder is in OneDrive (answered after %.2f s)" % took)
        self.assertGreaterEqual(took, 0.3, "it answered before the check was done")
        self.assertIs(self.status()[0]["syncWarning"], True)
        self.assertEqual(sorted(body), sorted(["ok", "helper", "version", "busy", "ready", "port", "maxUploadBytes", "syncWarning"]))
        for _ in range(100):                                                        # the lines for the window are printed too
            if "OneDrive synchronises" in self.out.getvalue():
                break
            time.sleep(0.1)
        self.assertIn("WARNING: this tools folder is inside a folder that OneDrive synchronises.", self.out.getvalue())

    def test_a_plain_folder_says_false_from_the_start_and_prints_no_warning(self):
        self.start(lambda path, **kw: [])
        body, _ = self.status()
        self.assertIs(body["syncWarning"], False)
        time.sleep(0.3)
        self.assertNotIn("WARNING", self.out.getvalue())

    def test_a_check_that_takes_very_long_delays_the_answers_by_about_a_second_at_most_and_the_answer_comes_later(self):
        release = threading.Event()

        def stuck_warning(path, **kw):
            release.wait(30)                                                        # a Mac whose `defaults` or `mount` does not come back
            return ["WARNING: this tools folder is on a network drive."]

        self.addCleanup(release.set)
        self.start(stuck_warning, wait=0.5)
        t0 = time.time()
        body, took = self.status()
        self.assertLess(time.time() - t0, 5, "serving waited for a stuck check")
        self.assertGreaterEqual(took, 0.4, "it did not wait for the check at all")
        self.assertIs(body["syncWarning"], False, "nothing is known yet: the helper must not guess 'true'")
        release.set()                                                               # the check ends: from now on the answer is true
        for _ in range(100):
            if self.status()[0]["syncWarning"] is True:
                break
            time.sleep(0.1)
        self.assertIs(self.status()[0]["syncWarning"], True)

    def test_a_check_that_fails_never_keeps_the_helper_from_starting(self):
        def broken(path, **kw):
            raise RuntimeError("no")

        self.start(broken)
        body, _ = self.status()
        self.assertIs(body["syncWarning"], False)
        self.assertTrue(self.thread.is_alive())

    def hidden_not_ready(self, with_file):
        """main() of a helper without a window (VRT_BACKGROUND=1) on Windows whose speech tools are not set up; the tools folder has
        setup-autostart-windows.bat or lacks it. Returns (the problem text it was given, everything it printed after the NOT ready banner)."""
        V = self.V
        if with_file:
            open(os.path.join(self.tmp, "setup-autostart-windows.bat"), "w").close()
        for p in (mock.patch.object(V, "IS_WIN", True), mock.patch.object(V, "START_FILE", "start-helper-windows.bat"),
                  mock.patch.object(V, "SETUP_FILE", "setup-windows.bat"), mock.patch.object(V, "TOOLS_DIR", self.tmp),
                  mock.patch.dict(os.environ, {"VRT_BACKGROUND": "1"})):
            p.start()
            self.addCleanup(p.stop)                                                  # (undone after finish(): cleanups run last in, first out)
        problem = V.setup_text()
        self.start(lambda path, **kw: [], ready=_NotReady(problem))
        for _ in range(200):
            if "Once the speech tools are set up" in self.out.getvalue():
                break
            time.sleep(0.05)
        out = self.out.getvalue()
        self.assertIn("NOT ready yet", out)
        self.assertIn("Once the speech tools are set up, stop the helper and start it again.", out)
        return problem, out[out.index("NOT ready yet"):]

    @unittest.skipUnless(WIN, "main() is run here as a Windows helper; the texts themselves are checked on every computer in RoundEightPydocsTests")
    def test_a_hidden_helper_that_is_not_ready_names_the_same_way_to_start_it_again_in_both_lines_with_the_autostart_file(self):
        problem, tail = self.hidden_not_ready(True)
        self.assertIn("Then start the helper again: double-click the Video Redline icon on your Desktop.", problem)
        self.assertIn(problem, tail)
        self.assertIn("To start it again: double-click the Video Redline icon on your Desktop.", tail)
        self.assertNotIn("start-helper-windows.bat", tail)

    @unittest.skipUnless(WIN, "main() is run here as a Windows helper; the texts themselves are checked on every computer in RoundEightPydocsTests")
    def test_a_hidden_helper_that_is_not_ready_names_the_same_way_to_start_it_again_in_both_lines_without_the_autostart_file(self):
        """Round 8 (L5). The line from the problem text said start-helper-windows.bat, the next line the Video Redline icon that this copy
        of the tools cannot make: two different remedies, and the hand start asks for a window that a hidden helper does not have."""
        problem, tail = self.hidden_not_ready(False)
        self.assertEqual(problem, "The speech tools are not set up on this computer yet. Open the tools folder and double-click setup-windows.bat. "
                                  "Wait for ALL DONE. Then start the helper again: double-click start-helper-windows.bat and leave its window open.")
        self.assertIn(problem, tail)
        self.assertIn("To start it again: double-click start-helper-windows.bat and leave its window open.", tail)
        self.assertNotIn("icon", tail)

    def test_the_source_starts_the_check_before_the_server_and_waits_at_most_a_second(self):
        src = read_text("vrt_server.py")
        main = src[src.index("def main(argv=None):"):]
        self.assertLess(main.index("start_sync_check()"), main.index("clean_all_jobs()"))               # (it runs while the folders are tidied)
        self.assertLess(main.index("check.join(SYNC_WAIT_S)"), main.index("target=server.serve_forever"))
        self.assertNotIn("sync_warning(TOOLS_DIR)", main, "main() must not run the check itself after the server has started")
        self.assertLessEqual(self.V.SYNC_WAIT_S, 1.0)
        self.assertIn("syncWarning", src.split('"""')[1])


# ------------------------------------------------------------------------------------------------
# VRT_BACKGROUND: a helper without a window says so
# ------------------------------------------------------------------------------------------------
class BackgroundTextTests(unittest.TestCase):
    def setUp(self):
        self.V = _import("vrt_server")

    def test_which_values_switch_it_on(self):
        for value, want in (("", False), ("0", False), ("false", False), ("False", False), ("FALSE", False), ("no", False), ("No", False),
                            (" ", False), (" 0 ", False), ("1", True), ("yes", True), ("true", True), ("anything", True), ("00", True)):
            with mock.patch.dict(os.environ, {"VRT_BACKGROUND": value}):
                self.assertIs(self.V.background_mode(), want, repr(value))
        with mock.patch.dict(os.environ):
            os.environ.pop("VRT_BACKGROUND", None)
            self.assertIs(self.V.background_mode(), False)

    def test_how_to_stop_names_stop_helper_windows_bat_only_when_it_is_in_the_folder(self):
        V = self.V
        folder = tempfile.mkdtemp(prefix="stop-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        with mock.patch.object(V, "TOOLS_DIR", folder):
            with mock.patch.object(V, "IS_WIN", True):
                text = V.how_to_stop_background()
                self.assertNotIn("stop-helper-windows", text)
                # the hidden helper is a pythonw.exe that runs helper_launcher.pyw: Task Manager shows no vrt_server.py
                self.assertIn("pythonw.exe", text)
                self.assertIn("command line", text)
                self.assertIn("this tools folder", text)
                self.assertIn("sign out of Windows", text)
                self.assertNotIn("vrt_server", text)
                # Task Manager has no Command line column until the person adds it: the text says how
                self.assertIn("(Task Manager, Details tab; first right-click the column bar, choose Select columns and tick Command line)", text)
                open(os.path.join(folder, "stop-helper-windows.bat"), "w").close()
                self.assertEqual(V.how_to_stop_background(), "To stop it: run stop-helper-windows.bat.")
            with mock.patch.object(V, "IS_WIN", False):
                text = V.how_to_stop_background()
                self.assertIn("end the python process called vrt_server.py", text)
                self.assertNotIn(".bat", text)

    def test_the_failure_text_does_not_send_people_to_a_window_that_is_not_there(self):
        V = self.V
        with mock.patch.dict(os.environ):
            os.environ.pop("VRT_BACKGROUND", None)
            normal = V.explain_failure(1, "", "", "")
            os.environ["VRT_BACKGROUND"] = "1"
            hidden = V.explain_failure(1, "", "", "")
        self.assertEqual(normal[0], "failed")
        self.assertEqual(hidden[0], "failed")
        self.assertIn("logs/last-error.txt", normal[1])                          # (round 3e: it only promises what exists)
        self.assertNotIn("window", hidden[1])
        self.assertIn("logs folder", hidden[1])
        self.assertNotIn("shows what happened", normal[1] + hidden[1])

    def test_the_banner_texts_in_the_source_are_the_old_ones_and_the_new_ones(self):
        src = read_text("vrt_server.py")
        for old in ("Video Redline helper is running.", "Leave this window open. Go back to the page and click", "Create transcript and find cuts.",
                    "To stop the helper, close this window.",
                    "Leave this window open: once the speech tools are set up, close this window and start the helper again."):
            self.assertIn(old, src)
        for new in ("Video Redline helper is running in the background.", "how_to_stop_background()", "The Video Redline helper is ALREADY RUNNING.",
                    "ALREADY RUNNING (%s).", "You can close this window: that does not stop the helper.",
                    "Once the speech tools are set up, stop the helper and start it again."):
            self.assertIn(new, src)
        # (changed in round 4: "...click Create transcript. You can close this window." let a person think that closing it stops the helper,
        # and "(in another window or in the background)" did not say that the one that runs may be hidden)
        self.assertNotIn("click Create transcript. You can close this window.", src)


# ------------------------------------------------------------------------------------------------
# Item 5. The folder check (cloud-synced folders), in the helper
# ------------------------------------------------------------------------------------------------
class SyncWarningTests(unittest.TestCase):
    def setUp(self):
        self.V = _import("vrt_server")

    def warn(self, path, **kw):
        kw.setdefault("network", False)
        return self.V.sync_warning(path, **kw)

    def test_the_cloud_names_are_still_found(self):
        for path, label in (("C:\\Users\\me\\OneDrive - Contoso\\Desktop\\tools", "OneDrive"), ("C:\\Users\\me\\Dropbox\\tools", "Dropbox"),
                            ("/Users/me/Library/Mobile Documents/com~apple~CloudDocs/tools", "iCloud"),
                            ("D:\\Google Drive\\tools", "Google Drive"), ("G:\\My Drive\\tools", "Google Drive")):
            lines = self.warn(path, icloud_desktop=False)
            self.assertTrue(lines and ("that %s synchronises." % label) in lines[0], "%s: %s" % (path, lines))
            self.assertIn("upload a copy", lines[1])
            # (round 8: the whole Video Redline folder, the one with video-redline.html and tools in it: the icon that setup-autostart-windows.bat
            # makes looks for the page in the folder above tools, so moving the tools folder alone would leave the icon without a page)
            self.assertIn("move the whole Video Redline folder (the one with video-redline.html and tools in it) to a plain local folder", lines[2])
            self.assertNotIn("move the whole tools folder", lines[2])

    def test_a_plain_folder_gives_no_warning(self):
        self.assertEqual(self.warn("C:\\Users\\me\\VideoRedline\\tools"), [])
        self.assertEqual(self.warn("/Users/me/VideoRedline/tools", icloud_desktop=True, home="/Users/me"), [])

    def test_desktop_and_documents_warn_only_when_icloud_drive_keeps_them(self):
        for path in ("/Users/me/Documents/tools", "/Users/me/Documents", "/Users/me/Desktop/VideoRedline/tools",
                     "/users/ME/desktop/tools", "/Users/me/Documents/"):
            lines = self.warn(path, icloud_desktop=True, home="/Users/me")
            self.assertTrue(lines and "Desktop or Documents folder, which iCloud Drive synchronises" in lines[0], "%s: %s" % (path, lines))
            self.assertIn("iCloud may upload a copy", lines[1])
            self.assertEqual(self.warn(path, icloud_desktop=False, home="/Users/me"), [], path)

    def test_folders_that_only_look_similar_are_not_desktop_or_documents(self):
        for path in ("/Users/me/Documents-old/tools", "/Users/me/Desktop2", "/Users/me/Downloads/tools", "/Users/other/Documents/tools",
                     "/Users/me/Projects/Documents/tools", "/Users/me"):
            self.assertEqual(self.warn(path, icloud_desktop=True, home="/Users/me"), [], path)

    def test_windows_style_home_folders_work_too(self):
        self.assertTrue(self.warn("C:\\Users\\me\\Documents\\tools", icloud_desktop=True, home="C:\\Users\\me"))

    def test_a_cloud_name_wins_over_the_desktop_rule_and_the_network_rule_still_works(self):
        lines = self.warn("/Users/me/Documents/Dropbox/tools", icloud_desktop=True, home="/Users/me")
        self.assertIn("Dropbox", lines[0])
        self.assertIn("network drive", self.V.sync_warning("C:\\x", network=True)[0])

    def test_on_a_computer_that_is_not_a_mac_defaults_is_never_asked(self):
        V = self.V
        with mock.patch.object(V, "IS_MAC", False), mock.patch.object(V.subprocess, "run") as run:
            self.assertFalse(V.icloud_desktop_documents_on())
            self.assertEqual(V.sync_warning("/Users/me/Documents/tools", network=False, home="/Users/me"), [])
        run.assert_not_called()

    def test_on_a_mac_the_answer_of_the_finder_setting_decides(self):
        V = self.V

        def fake(stdout=b"", returncode=0, error=None):
            def run(cmd, **kw):
                self.assertEqual(cmd, ["defaults", "read", "com.apple.finder", "FXICloudDriveDesktop"])
                if error:
                    raise error
                return subprocess.CompletedProcess(cmd, returncode, stdout, b"")
            return run

        with mock.patch.object(V, "IS_MAC", True):
            for run, want in ((fake(b"1\n"), True), (fake(b"0\n"), False), (fake(b"2\n"), False), (fake(b"", 1), False),
                              (fake(b"1\n", 1), False), (fake(error=FileNotFoundError("defaults")), False),
                              (fake(error=subprocess.TimeoutExpired("defaults", 5)), False), (fake(error=OSError("denied")), False)):
                with mock.patch.object(V.subprocess, "run", run):
                    self.assertEqual(V.icloud_desktop_documents_on(), want)
                    lines = V.sync_warning("/Users/me/Documents/tools", network=False, home="/Users/me")
                    self.assertEqual(bool(lines), want)
            # outside Desktop and Documents the question is not even asked
            with mock.patch.object(V.subprocess, "run", side_effect=AssertionError("must not be asked")):
                self.assertEqual(V.sync_warning("/Users/me/VideoRedline/tools", network=False, home="/Users/me"), [])


# ------------------------------------------------------------------------------------------------
# Items 3, 8, 12: the texts people read
# ------------------------------------------------------------------------------------------------
class LauncherTextTests(unittest.TestCase):
    def setUp(self):
        self.V = _import("vrt_server")

    def test_the_helper_tells_a_mac_user_to_use_bash_and_a_windows_user_to_double_click(self):
        V = self.V
        with mock.patch.object(V, "IS_WIN", False), mock.patch.object(V, "SETUP_FILE", "setup-mac.command"),                 mock.patch.object(V, "_glob_size_ok", return_value=False):
            texts = (V.setup_text(), V.moved_text(), V.models_problem(), V.how_to_run("setup-mac.command"),
                     V.explain_failure(1, "A speech model was only partly downloaded.", "", "")[1])
            for text in texts:
                self.assertNotIn("ouble-click", text)
                self.assertIn(MAC_RECIPE % "setup-mac.command", text)
            self.assertIn("ALL DONE", V.setup_text())
            self.assertIn("moved, renamed or copied", V.moved_text())              # the page recognises the cause by these words
        with mock.patch.object(V, "IS_WIN", True), mock.patch.object(V, "SETUP_FILE", "setup-windows.bat"),                 mock.patch.object(V, "_glob_size_ok", return_value=False):
            self.assertIn("double-click setup-windows.bat", V.setup_text())
            self.assertIn("double-click setup-windows.bat", V.moved_text())
            self.assertIn("double-click setup-windows.bat", V.models_problem())
            self.assertNotIn("bash", V.setup_text())

    def test_a_check_of_the_speech_tools_that_did_not_finish_does_not_tell_anybody_to_start_the_helper_again(self):
        """The helper is running when it says this, and it looks again by itself: 'start the helper again' sent a person whose helper runs
        hidden to start-helper-windows.bat, which only says ALREADY RUNNING. The page recognises both messages by their first words."""
        V = self.V
        rd = V.Readiness()

        def timed_out(py, flag):
            raise subprocess.TimeoutExpired("x", 1)

        rd._run_cli = timed_out
        slow = rd.compute()
        self.assertFalse(slow[0])
        rd2 = V.Readiness()

        def broken():
            raise RuntimeError("x")

        rd2.compute = broken
        rd2.refresh()
        for text in (slow[1], rd2.problem):
            self.assertNotRegex(text, r"(?i)start(ing)? the helper|close the helper|window")
            self.assertLess(len(text), 200)
        self.assertEqual(slow[1], "Checking the speech tools took too long. The computer may be busy with other programs.")
        self.assertEqual(rd2.problem, "I could not check the speech tools just now.")
        client = module_file("transcriber-client.js")                                   # (the client still recognises the older wording too)
        if client:
            with open(client, "rb") as f:
                js = f.read().decode("utf-8")
            for words in ("took too long", "could not check the speech tools", "try starting the helper again"):
                self.assertIn(words, js.split("var HELP_NOT_READY")[1].split("];")[0])

    def test_the_launcher_of_the_speech_tool_names_a_plain_folder_and_what_works_on_a_mac(self):
        T = _import("transcribe")
        with mock.patch.object(sys, "platform", "darwin"):
            self.assertEqual(T.plain_folder_example(), "~/VideoRedline")
            text = T.how_to_give_a_video()
            self.assertIn("type bash and a space, drag 'transcribe-mac.command' into the window", text)
            self.assertIn("drag your video into the window too", text)
            self.assertNotIn("Drag your video onto", text)                    # dropping a video on a .command file does nothing
        with mock.patch.object(sys, "platform", "win32"):
            # the real user folder when it is known (a message built at run time), else a placeholder for the name; never a folder
            # directly on the C drive (the other accounts of the PC may change files there, and the automatic start warns about it)
            with mock.patch.dict(os.environ, {"USERPROFILE": "C:\\Users\\Pat Lee"}):
                self.assertEqual(T.plain_folder_example(), "C:\\Users\\Pat Lee\\VideoRedline")
            with mock.patch.dict(os.environ, {"USERPROFILE": "D:\\Profiles\\pat\\"}):
                self.assertEqual(T.plain_folder_example(), "D:\\Profiles\\pat\\VideoRedline")
            for odd in ("", "C:\\", "\\\\server\\share\\pat", "pat", "/home/pat"):
                with mock.patch.dict(os.environ, {"USERPROFILE": odd}):
                    self.assertEqual(T.plain_folder_example(), "C:\\Users\\<your name>\\VideoRedline", repr(odd))
            self.assertIn("transcribe-windows.bat", T.how_to_give_a_video())
        source = read_text("transcribe.py")
        self.assertNotIn("your Desktop", source)
        self.assertIsNone(re.search(r"C:\\+VideoRedline", source), "transcribe.py recommends a folder directly on the C drive")

    def test_a_mistyped_video_path_gets_advice_that_works_on_this_computer(self):
        """The 'I can't find that file' hint used to say to drag the video onto the launcher file, which does nothing on a Mac."""
        T = _import("transcribe")
        args = T.build_parser().parse_args([os.path.join(SCRATCH, "no-such-video.mp4")])
        for platform in ("darwin", "win32"):
            with mock.patch.object(sys, "platform", platform):
                with self.assertRaises(T.FriendlyError) as cm:
                    T.run_pipeline(args)
                advice = T.how_to_give_a_video()
            self.assertIn("find that file", str(cm.exception))
            hint = cm.exception.hint
            self.assertIn("Check the spelling.", hint)
            self.assertIn(advice, hint)
            self.assertNotIn("launcher file", hint)
            if platform == "darwin":
                self.assertIn("type bash and a space, drag 'transcribe-mac.command' into the window", hint)
                self.assertNotIn("Drag your video onto", hint)                # dropping a video on a .command file does nothing
            else:
                self.assertIn("Drag your video onto 'transcribe-windows.bat'", hint)
                self.assertNotIn("bash", hint)

    def test_the_moved_folder_hint_of_the_speech_tool(self):
        env = _import("vrt_env")
        b = os.path.join(SCRATCH, "B tools")
        args = dict(prefix=os.path.join(b, "venv"), base_prefix=os.path.join(SCRATCH, "A tools", "python", "cpython-3.12-x"))
        with mock.patch.object(sys, "platform", "darwin"):
            problem, todo = env.venv_problem(b, **args)
            self.assertIn("moved or copied", problem)
            self.assertNotIn("ouble-click", todo)
            self.assertIn(MAC_RECIPE % "setup-mac.command", todo)
        with mock.patch.object(sys, "platform", "win32"):
            problem, todo = env.venv_problem(b, **args)
            self.assertIn("Double-click the setup file (setup-windows.bat) once more", todo)

    def test_moved_text_and_the_readme_say_the_same_sentence_about_ending_the_helper_first(self):
        """Before the setup file repairs the folder, or before the folder is moved, renamed or replaced, a running helper must
        end: it holds files in the folder (venv, python). The sentence does not claim that stop-helper-windows.bat is there."""
        V = self.V
        readme = read_text("README.md")
        with mock.patch.object(V, "IS_WIN", True), mock.patch.object(V, "SETUP_FILE", "setup-windows.bat"):
            sentence = V.stop_first_text()
            self.assertIn("double-click stop-helper-windows.bat.", sentence)
            self.assertIn("close its window", sentence)
            self.assertIn(sentence, V.moved_text())
            self.assertLess(V.moved_text().index(sentence), V.moved_text().index("double-click setup-windows.bat"))   # first end it, then repair
            self.assertGreaterEqual(readme.count(sentence), 2, "README.md: where it explains the moved folder, and where it explains moving, "
                                                               "renaming or replacing it")
            self.assertIn("moved, renamed or copied", V.moved_text())
        with mock.patch.object(V, "IS_WIN", False), mock.patch.object(V, "SETUP_FILE", "setup-mac.command"):
            sentence = V.stop_first_text()
            self.assertEqual(sentence, "If the helper is running, end it first: close its Terminal window.")
            self.assertIn(sentence, V.moved_text())
            self.assertNotIn("ouble-click", V.moved_text())
            self.assertNotIn(".bat", V.moved_text())
            self.assertIn(MAC_RECIPE % "setup-mac.command", V.moved_text())
        # the page recognises the cause by these words and must still do so
        self.assertIn("moved, renamed or copied", V.explain_failure(1, "this folder was moved or copied", "", "")[1])

    def test_moved_text_fits_the_help_card_of_the_page_on_windows_and_on_a_mac(self):
        """The page shows moved_text() as the first lines of its help card and cuts it at 400 characters (cleanup-panel.js, helpCard:
        clip(problem, 400)). The Windows text had grown to 442 characters, so 'speech models. Then start the helper again.' was lost."""
        V = self.V
        limit = 400
        panel = module_file("cleanup-panel.js")
        if panel:
            with open(panel, "rb") as f:
                m = re.search(r"var lead = [^;]*?clip\([^;]*?, (\d+)\)", f.read().decode("utf-8"))
            self.assertIsNotNone(m, "cleanup-panel.js helpCard no longer cuts the lead with clip(..., N): update this test")
            limit = min(limit, int(m.group(1)))
        for win, setup in ((True, "setup-windows.bat"), (False, "setup-mac.command")):
            with mock.patch.object(V, "IS_WIN", win), mock.patch.object(V, "SETUP_FILE", setup):
                text = V.moved_text()
                self.assertLessEqual(len(text), limit, "%s: %d characters: %s" % (setup, len(text), text))
                self.assertTrue(text.endswith(V.moved_tail_text()), text)                                 # the end, which was cut off
                self.assertIn(V.stop_first_text(), text)
                self.assertIn("moved, renamed or copied", text)                                           # the page recognises the cause by these words
        # (round 3d) the end differs: on a Mac the helper is still started by hand; on Windows the next step is the file that makes the
        # Video Redline icon (the old icon and the start-up setting still point at the old place) - or, when that file is not in the
        # folder, the hand start. All three fit.
        folder = tempfile.mkdtemp(prefix="moved-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        with mock.patch.object(V, "IS_WIN", False), mock.patch.object(V, "SETUP_FILE", "setup-mac.command"):
            self.assertTrue(V.moved_text().endswith("Then start the helper again."))
        for has_file in (False, True):
            if has_file:
                open(os.path.join(folder, "setup-autostart-windows.bat"), "w").close()
            with mock.patch.object(V, "IS_WIN", True), mock.patch.object(V, "SETUP_FILE", "setup-windows.bat"), \
                    mock.patch.object(V, "TOOLS_DIR", folder):
                text = V.moved_text()
                self.assertLessEqual(len(text), limit, "%d characters: %s" % (len(text), text))
                if has_file:
                    self.assertTrue(text.endswith("Then double-click setup-autostart-windows.bat: it makes the Video Redline icon and starts the helper."), text)
                else:
                    self.assertTrue(text.endswith("Then double-click start-helper-windows.bat and leave its window open."), text)
                    self.assertNotIn("setup-autostart", text)                  # a file that is not there is not named

    def test_no_example_folder_is_directly_on_the_c_drive(self):
        """The Windows automatic start (setup-autostart-windows.bat) calls a folder directly on C: shared, because every account of the PC
        may change files there, and it refuses it when setup-windows.bat passes /yes. So the example folder is inside the user folder."""
        V = self.V
        self.assertEqual(V.EXAMPLE_FOLDER, V.example_folder())
        self.assertIn(V.EXAMPLE_FOLDER, V.sync_warning("C:\\Users\\me\\OneDrive\\tools", network=False, icloud_desktop=False)[2])
        # a message built at run time uses the real user folder; a folder that cannot be the user's own plain local folder gives the placeholder
        placeholder = "C:\\Users\\<your name>\\VideoRedline"
        with mock.patch.object(V, "IS_WIN", True):
            for home in ("C:\\Users\\Pat Lee", "C:\\Users\\Pat Lee\\", "D:\\Profiles\\pat"):
                with mock.patch.dict(os.environ, {"USERPROFILE": home}):
                    self.assertEqual(V.example_folder(), home.rstrip("\\") + "\\VideoRedline", home)
            for odd in ("", "   ", "C:", "C:\\", "\\\\server\\share\\pat", "pat", "/home/pat", "C:\\Users\\pat\\OneDrive - Contoso", "C:\\Users\\Dropbox"):
                with mock.patch.dict(os.environ, {"USERPROFILE": odd}):
                    self.assertEqual(V.example_folder(), placeholder, repr(odd))
            with mock.patch.dict(os.environ):
                os.environ.pop("USERPROFILE", None)
                self.assertEqual(V.example_folder(), placeholder)
        with mock.patch.object(V, "IS_WIN", False):
            self.assertEqual(V.example_folder(), "~/VideoRedline")
        # no text advises a folder directly on the C drive, in any form; a static text names the folder with a placeholder for the user name
        for name in ("README.md", "README-helper-security.md", "setup-windows.bat", "start-helper-windows.bat", "transcribe-windows.bat",
                     "vrt_server.py", "transcribe.py", "vrt_env.py"):
            for n, line in enumerate(read_text(name).splitlines(), 1):
                self.assertIsNone(re.search(r"(?i)C:[\\/]+VideoRedline", line), "%s line %d: %s" % (name, n, line.strip()))
                self.assertNotIn("YourName", line, "%s line %d still uses the old placeholder: %s" % (name, n, line.strip()))
        for name in ("README.md", "README-helper-security.md"):
            self.assertIn("C:\\Users\\<your name>\\VideoRedline", read_text(name), name)

    def test_the_readme_has_a_short_paragraph_on_starting_automatically_that_points_at_autostart_md(self):
        readme = read_text("README.md")
        i = readme.index("### Starting automatically (Windows)")
        part = readme[i:readme.index("\n## ", i)]
        self.assertLess(len(part.split()), 220, "a short paragraph")
        for name in ("AUTOSTART.md", "setup-autostart-windows.bat", "stop-helper-windows.bat", "remove-autostart-windows.bat"):
            self.assertIn(name, part)
        self.assertIn("Mac", part)
        self.assertIn("by hand", part)
        # it sits inside the section on the one-click button (before the drag-and-drop part), and the manual route is still described
        self.assertLess(readme.index("## Using the one-click button"), i)
        self.assertLess(i, readme.index("## Transcribing a video"))
        # the Video Redline icon is the first of the ways to get the helper running; starting it by hand stays as the fallback
        # (round 3d: the first way used to be "double-click setup-autostart-windows.bat", with the icon only as the way to start it again)
        section = readme[readme.index("## Using the one-click button"):i]
        easy = section.index("- **Windows, the Video Redline icon (the easy way):** double-click the **Video Redline** icon on your Desktop")
        by_hand = section.index("- **Windows, by hand (always works, and the way if you would rather not have the icon):** double-click **`start-helper-windows.bat`**")
        self.assertLess(easy, by_hand)
        # (Mac launcher: the Mac has its own easy way, the Video Redline app, ahead of the by-hand Terminal route)
        mac_app = section.index("- **Mac, the Video Redline app (the easy way):** double-click the **Video Redline** app")
        mac_hand = section.index("- **Mac, by hand (always works):** open **Terminal**")
        self.assertLess(by_hand, mac_app)
        self.assertLess(mac_app, mac_hand)
        # the icon starts the helper if needed and opens the page; no icon yet: setup-autostart-windows.bat once (it adds the icon and makes the
        # helper start by itself at every sign-in); the icon was deleted: add-desktop-icon-windows.bat
        way = section[easy:by_hand]
        for want in ("starts the helper if it is not running", "opens Video Redline",
                     "If there is no such icon yet, double-click **`setup-autostart-windows.bat`** once",
                     "it adds the icon", "each time you sign in to Windows", "add-desktop-icon-windows.bat"):
            self.assertIn(want, way)
        self.assertNotIn("tools folder does not have", way)                  # (round 3e: the files are in the download, so no 'if')
        self.assertLess(way.index("double-click the **Video Redline** icon"), way.index("setup-autostart-windows.bat"))
        self.assertNotIn("the easy way (once)", section)
        # (changed in round 6: the host's page does NOT start the helper - "tried and does not work" - so the README may not say it does)
        self.assertNotIn("page can start it", section)
        self.assertIn("the page never starts it by itself (neither do its buttons **Create transcript and find cuts** and **Check again**)", section)
        # step 4 is true for both ways: a window to close, or a hidden helper that stop-helper-windows.bat stops
        step4 = section[section.index("**4. Stop the helper when you are finished**"):]
        step4 = step4[:step4.index("\n")]
        for want in ("close its window", "stop-helper-windows.bat", "has no window"):
            self.assertIn(want, step4)
        self.assertNotIn("**4. Close the helper window**", readme, "the old step 4 told everybody to close a window")
        # where to keep the folder, and that setup offers it
        self.assertIn("C:\\Users\\<your name>\\VideoRedline", part)
        self.assertIn("directly on the C drive", part)
        self.assertIn("`setup-windows.bat` offers the automatic start", part)
        # the page does not start the helper; the icon does. And the folder check WARNS and asks when it is run on its own: it stops
        # on its own only for a network drive, a percent sign or a path that is too long, and when it is run from setup (/yes)
        self.assertNotIn("page can start it", part)
        self.assertIn("**Video Redline** icon on your Desktop", part)
        self.assertLess(part.index("**Video Redline** icon"), part.index("stop-helper-windows.bat"))      # (round 3d) the icon comes first
        self.assertIn("If the helper is not running, the icon starts it first", part)
        self.assertIn("warns you and asks whether to go on", part)
        self.assertIn("network drive, a percent sign or a very long path it stops", part)
        self.assertIn("run that way, it stops instead of asking", part)
        self.assertNotIn("refuse", part)
        text = part.encode("ascii")                                                         # plain characters only
        self.assertTrue(text)

    def test_the_readme_names_the_switches_a_developer_needs(self):
        readme = read_text("README.md")
        for word in ("VRT_BACKGROUND", "VRT_PORT_PROBE_S", "syncWarning", "vrt-owner.txt", "stop-helper-windows.bat", "MODEL_REVISIONS"):
            self.assertIn(word, readme)

    def test_no_text_recommends_the_desktop_or_the_documents_folder(self):
        """Every mention of Desktop or Documents must be a warning about cloud sync, never advice to put the folder there."""
        warning_words = re.compile(r"avoid|Avoid|not |out of|iCloud|sync|SYNC|cloud|Keep the")
        names = ["README.md", "README-helper-security.md", "transcribe.py", "vrt_env.py", "vrt_server.py", "setup-windows.bat",
                 "start-helper-windows.bat", "transcribe-windows.bat"] + list(COMMANDS)
        for name in names:
            for n, line in enumerate(read_text(name).splitlines(), 1):
                if re.search(r"\b(Desktop|Documents)\b", line):
                    if re.search(r"\bicon\b", line):
                        continue                  # (round 6: "the Video Redline icon on your Desktop" starts a stopped helper; it says nothing about where the folder goes)
                    self.assertRegex(line, warning_words, "%s line %d recommends a synced place: %s" % (name, n, line.strip()))
        self.assertIn("C:\\Users\\<your name>\\VideoRedline", read_text("README.md"))
        self.assertIn('(for example "%EXAMPLE%")', read_text("setup-windows.bat"))                  # worked out at run time from USERPROFILE
        self.assertIn("~/VideoRedline", read_text("setup-mac.command"))
        self.assertIn("~/VideoRedline", read_text("README.md"))

    def test_command_files_never_say_to_double_click_a_command_file(self):
        for name in COMMANDS:
            text = read_text(name)
            self.assertIn("type bash and a space", text, name)
            for n, line in enumerate(text.splitlines(), 1):
                if re.search(r"ouble-click", line):
                    # (Mac launcher: the ALL DONE screen sends people to the Video Redline app, which is not a .command file, and says not to
                    # double-click video-redline.html; the check below still forbids double-clicking a .command file)
                    about_app = re.search(r"(?i)\bapp\b|video-redline\.html", line)
                    self.assertTrue("zip file" in line or "does not work" in line or about_app, "%s line %d: %s" % (name, n, line.strip()))
        # nowhere may a .command file be named as something to double-click (only "do not double-click it" is allowed)
        wrong = re.compile(r"(?i)(?<!not )double-click(?:ing)?\s+(?:the file\s+)?[*`\"]*(?:setup|start-helper|transcribe)-mac\.command")
        for name in ["README.md", "README-helper-security.md", "vrt_server.py", "vrt_env.py", "transcribe.py", "setup-windows.bat",
                     "start-helper-windows.bat", "transcribe-windows.bat"] + list(COMMANDS):
            for n, line in enumerate(read_text(name).splitlines(), 1):
                self.assertIsNone(wrong.search(line), "%s line %d: %s" % (name, n, line.strip()))

    def test_mac_pause_line_does_not_promise_that_the_window_closes(self):
        # Run with bash in a Terminal that is already open, a finished script only hands back the prompt: the window stays.
        for name in COMMANDS:
            text = read_text(name)
            pauses = [l for l in text.splitlines() if "Press any key" in l and "printf" in l and "cancel" not in l]
            self.assertEqual(len(pauses), 1, name)
            self.assertIn("Press any key to finish.", pauses[0], name)
            self.assertNotIn("to close this window", text, name)
        # a double-clicked .bat window really does close afterwards, so the Windows wording stays
        for name in ("start-helper-windows.bat", "transcribe-windows.bat"):
            self.assertIn("Press any key to close this window.", read_text(name), name)

    def test_the_mac_files_name_the_three_commands_with_their_folder_in_the_chmod_hint(self):
        # (round 3e: how a maintainer publishes is in DEVELOPERS.md of the repository, not in a README that is in the download)
        text = read_text("README.md")
        self.assertNotIn("--chmod=+x setup-mac.command", text)
        self.assertIn("in the repository on GitHub", text)
        self.assertNotIn("dev/evaluate.py", text)

    def test_both_all_done_screens_explain_the_one_click_button_and_keep_drag_and_drop(self):
        bat = read_text("setup-windows.bat")
        done = bat[bat.index("ALL DONE."):bat.index(":in_zip")]
        for want in ("Create transcript and find cuts", "start-helper-windows.bat", "leave", "transcribe-windows.bat", "drag"):
            self.assertIn(want, done)
        sh = read_text("setup-mac.command")
        done = sh[sh.index("ALL DONE."):]
        # (Mac launcher: when setup made the Video Redline app the screen sends people to it; if it could not be made, the Terminal route
        # with start-helper-mac.command is the fallback. The drag-and-drop transcript part after both is unchanged.)
        app, fallback = done.split("\nelse\n", 1)
        self.assertRegex(app, r'double-click the \\"Video Redline\\" app')
        for want in ("Create transcript and find cuts", "stop-helper-mac.command"):
            self.assertIn(want, app)
        for want in ("Create transcript and find cuts", "start-helper-mac.command", "type bash and a space", "transcribe-mac.command",
                     "Leave that window", "drag your"):
            self.assertIn(want, fallback)
        self.assertNotIn("ouble-click", fallback)

    def test_install_log_is_not_mentioned_in_any_shipped_file(self):
        needle = "install" + "-log"
        for name in ["README.md", "README-helper-security.md", "requirements.txt", "transcribe.py", "vrt_audio.py", "vrt_engines.py",
                     "vrt_env.py", "vrt_merge.py", "vrt_server.py", "setup-windows.bat", "start-helper-windows.bat",
                     "transcribe-windows.bat", ".gitignore", ".gitattributes"] + list(COMMANDS):
            self.assertNotIn(needle, read_text(name), name)
        self.assertIn("Setup prints every download", read_text("README.md"))

    def test_setup_names_where_each_download_comes_from(self):
        for name in ("setup-windows.bat", "setup-mac.command"):
            text = read_text(name)
            for want in ("from github.com", "from pypi.org", "from huggingface.co"):
                self.assertIn(want, text, name)


class ReadmeButtonSectionTests(unittest.TestCase):
    """The section 'Using the one-click button' must use the words the page and the helper window really use."""

    def setUp(self):
        self.readme = read_text("README.md")
        i = self.readme.index("## Using the one-click button")
        self.section = self.readme[i:self.readme.index("## Transcribing a video", i)]

    def test_the_section_exists_before_the_drag_and_drop_part(self):
        self.assertLess(self.readme.index("## Using the one-click button"), self.readme.index("## Transcribing a video"))

    def test_start_steps_for_windows_and_mac(self):
        self.assertIn("double-click **`start-helper-windows.bat`**", self.section)
        self.assertIn("type `bash ` (with a space after it), drag **`start-helper-mac.command`**", self.section)

    def test_it_quotes_what_the_helper_window_really_says(self):
        server = read_text("vrt_server.py")
        for said in ("Video Redline helper is running.", "ALREADY RUNNING", "NOT ready yet"):
            self.assertIn(said, server)
            self.assertIn(said, self.section)
        # (round 3e: the banner line is split in two so that it fits an 80-column Terminal; the README quotes the two lines as one sentence)
        self.assertIn('"Leave this window open. Go back to the page and click",', server)
        self.assertIn('"Create transcript and find cuts.",', server)
        self.assertIn("Leave this window open. Go back to the page and click Create transcript and find cuts.", self.section)
        V = _import("vrt_server")
        self.assertEqual(V.DEFAULT_PORTS, (47831, 47832, 47833, 47834, 47835))
        self.assertIn("47831 to 47835", self.section)

    def test_it_uses_the_real_names_of_the_page_buttons(self):
        panel = module_file("cleanup-panel.js")
        if not panel:
            self.skipTest("cleanup-panel.js is neither next to the tools folder nor in src/vendor/ here")
        with open(panel, "rb") as f:
            js = f.read().decode("utf-8")
        for label in ("Create transcript and find cuts", "Check again", "I already have a transcript file", "Open transcript file"):
            self.assertIn(label, js)
            self.assertIn(label, self.readme)
        self.assertNotIn("in the **Audio cleanup** section open the transcript file", self.readme)

    def test_the_already_running_advice_also_covers_a_helper_without_a_window(self):
        """With the automatic start the running helper has no window. The helper's banner, start-helper-windows.bat and the README all
        said 'in another window' and sent people to look for it (or to restart the computer)."""
        server = read_text("vrt_server.py")
        self.assertIn("ALREADY RUNNING (%s).", server)
        self.assertIn('"in another window, or running hidden"', server)
        self.assertNotIn("ALREADY RUNNING (in another window).", server)
        self.assertNotIn("ALREADY RUNNING (in another window or in the background)", server)
        self.assertIn("ALREADY RUNNING (in another window, or running hidden)", self.section)
        i = self.section.index("ALREADY RUNNING")
        bullet = self.section[i:self.section.index("\n- ", i)]
        for want in ("without a window", "stop-helper-windows.bat", "restart the computer", "closing this window does not stop it"):
            self.assertIn(want, bullet)
        self.assertNotIn("if your tools folder has that file", bullet)
        # that file stops only a helper of its own folder: a helper that runs from another copy of the tools needs the file of that copy
        self.assertIn("only stop a helper that runs from the same tools folder", bullet)       # (both stop-helper files, since the Mac one)
        self.assertIn("more than one copy of the tools", bullet)
        bat = read_text("start-helper-windows.bat")
        self.assertIn("the helper is already running (in another window, or hidden).", bat)
        self.assertIn("Closing this window does not stop that helper.", bat)
        self.assertNotIn("already running in another window", bat)
        self.assertNotIn("in the background", bat)

    def test_the_already_running_banner_keeps_its_words_and_is_true_for_a_hidden_helper(self):
        """A visible start (start-helper-windows.bat) that finds the hidden helper must not suggest that closing its own window stops
        anything, and must say how the one that runs is stopped: its own window, or stop-helper-windows.bat when it runs hidden."""
        V = _import("vrt_server")
        for win in (True, False):
            with mock.patch.object(V, "IS_WIN", win):
                lines = V.already_running_lines(False)
                text = " ".join(lines)
                self.assertIn("ALREADY RUNNING", lines[0])
                self.assertIn("You do not need to start it again", text)
                self.assertIn("click Create transcript", text)
                self.assertIn("You can close this window: that does not stop the helper.", text)
                self.assertNotIn("You can close this window.", text)
        with mock.patch.object(V, "IS_WIN", True):
            self.assertIn("(in another window, or running hidden)", V.already_running_lines(False)[0])
        with mock.patch.object(V, "IS_WIN", False):
            self.assertIn("(in another Terminal window)", V.already_running_lines(False)[0])
        # the helper that has no window of its own (the hidden start) keeps the short text for its log
        self.assertEqual(V.already_running_lines(True), ["The Video Redline helper is ALREADY RUNNING.",
                                                         "You do not need to start it again. Go back to the Video Redline page",
                                                         "and click Create transcript and find cuts."])
        # how to stop the one that runs: named only when the file is there; true for a window and for a hidden helper
        folder = tempfile.mkdtemp(prefix="stop-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        with mock.patch.object(V, "TOOLS_DIR", folder), mock.patch.object(V, "IS_WIN", True):
            text = V.how_to_stop_running()
            self.assertNotIn("stop-helper-windows", text)
            for want in ("close the window it runs in", "If it runs hidden", "pythonw.exe", "command line", "sign out of Windows"):
                self.assertIn(want, text)
            # Task Manager shows no command line until that column is added; and the helper that runs may belong to another copy of the tools
            for want in ("Task Manager, Details tab", "right-click the column bar", "Select columns", "tick Command line", "another copy of the tools"):
                self.assertIn(want, text)
            self.assertNotIn("this tools folder", text)
            open(os.path.join(folder, "stop-helper-windows.bat"), "w").close()
            # (changed in round 6: the old text was only "...double-click stop-helper-windows.bat.", which sent a person whose helper runs
            # from another copy of the tools to a file that cannot find it - it only stops the helper of its own folder)
            self.assertEqual(V.how_to_stop_running(),
                             "To stop it: close the window it runs in, or, if it runs hidden, double-click stop-helper-windows.bat. "
                             "That file only stops a helper that runs from this same tools folder; for a helper from another copy of the "
                             "tools, use the stop file in that copy.")
        with mock.patch.object(V, "IS_WIN", False):
            self.assertEqual(V.how_to_stop_running(), "To stop it: close the Terminal window it runs in.")
            self.assertNotIn(".bat", V.how_to_stop_running())

    def test_main_prints_the_already_running_banner_with_the_stop_hint_and_returns_10(self):
        V = _import("vrt_server")
        out = io.StringIO()
        with mock.patch.object(V, "bind_server", return_value=(None, 47831)), contextlib.redirect_stdout(out):
            with mock.patch.dict(os.environ):
                os.environ.pop("VRT_BACKGROUND", None)
                code = V.main([])
                V.CON.flush()
        text = out.getvalue()
        self.assertEqual(code, 10)
        self.assertIn("ALREADY RUNNING", text)
        self.assertIn(V.how_to_stop_running(), text)
        self.assertIn("that does not stop the helper", text)
        out = io.StringIO()
        with mock.patch.object(V, "bind_server", return_value=(None, 47831)), contextlib.redirect_stdout(out):
            with mock.patch.dict(os.environ, {"VRT_BACKGROUND": "1"}):
                self.assertEqual(V.main([]), 10)
                V.CON.flush()
        self.assertIn("ALREADY RUNNING", out.getvalue())
        self.assertNotIn("close this window", out.getvalue())

    def test_step_4_of_the_windows_setup_says_that_a_question_follows_all_done(self):
        step = self.readme[self.readme.index("4. When you see **ALL DONE**, setup is finished."):]
        step = step[:step.index("\n")]
        for want in ("setup-autostart-windows.bat", "asks whether the helper should start by itself", "press Enter to skip", "Starting automatically"):
            self.assertIn(want, step)

    def test_the_troubleshooting_list_covers_the_usual_trouble(self):
        for topic in ("closes at once", "ALREADY RUNNING", "47831 to 47835", "connect to programs on this computer",
                      "VPN or firewall", "Check again", "closed in the middle of a transcript"):
            self.assertIn(topic, self.section)

    def test_readme_says_exactly_what_is_checked_and_when(self):
        text = self.readme
        self.assertIn("At setup, before anything is downloaded", text)
        self.assertIn("Each time the helper starts", text)
        self.assertIn("FXICloudDriveDesktop", text)
        self.assertIn("Only the folder's name is looked at", text)

    def test_security_readme_stays_short_plain_and_current(self):
        text = read_text("README-helper-security.md")
        self.assertLessEqual(len(text.rstrip().splitlines()), 20)
        text.encode("ascii")
        for want in ("file://", "at setup", "helper starts", "OneDrive", "3 hours", "10 minutes", "close the helper window"):
            self.assertIn(want, text if want != "close the helper window" else text.lower())

    def test_security_readme_mentions_the_optional_automatic_start_and_keeps_the_manual_route(self):
        text = read_text("README-helper-security.md")
        self.assertIn("Close the helper window when you are not using it.", text)             # the manual route, as it was
        for want in ("AUTOSTART.md", "setup-autostart-windows.bat", "stop-helper-windows.bat", "remove-autostart-windows.bat",
                     "hidden", "no window"):
            self.assertIn(want, text)
        self.assertRegex(text, r"stop-helper-windows\.bat to stop it")                           # that file stops a hidden helper
        self.assertLessEqual(len(text.rstrip().splitlines()), 20)
        # the server's own header says the same
        head = read_text("vrt_server.py").split('"""')[1]
        self.assertRegex(head, r"close the helper\s+window")
        for want in ("stop-helper-windows.bat", "remove-autostart-windows.bat", "AUTOSTART.md", "VRT_BACKGROUND"):
            self.assertIn(want, head)

    def test_no_text_says_that_the_page_can_start_the_helper(self):
        """Round 6 (R6T-1). The host's page does NOT start the helper ('tried and does not work': a page cannot start a program; it sends the
        person to the Video Redline icon). The package said it four times (setup-windows.bat twice, README.md twice), and a test locked it in."""
        said = re.compile(r"(?i)page (can|could|will|may|also)( also)? start|page starts|start it when it is not running|starts the helper from the page")
        for name in ("README.md", "README-helper-security.md", "setup-windows.bat", "start-helper-windows.bat", "transcribe-windows.bat",
                     "vrt_server.py", "transcribe.py") + COMMANDS:
            for n, line in enumerate(read_text(name).splitlines(), 1):
                self.assertIsNone(said.search(line), "%s line %d: %s" % (name, n, line.strip()))
        # what is true instead: the Video Redline icon starts the helper when it is not running, and the helper starts at every sign-in
        # after setup-autostart-windows.bat
        readme = read_text("README.md")
        self.assertIn("It starts the helper if it is not running", readme)
        self.assertIn("each time you sign in to Windows", readme)
        self.assertIn("The **Video Redline** icon starts it again.", readme)

    def test_the_docs_say_that_the_automatic_start_warns_about_a_folder_they_do_not_say_it_refuses_it(self):
        """Round 6 (R6T-4). Run on its own, setup-autostart-windows.bat WARNS about a folder directly on C:, one that other accounts can
        change, or a synchronised one, and asks 'Go on anyway?'. It stops only for a network drive, a percent sign, a path that is too long,
        and when it is run with /yes (which is how setup-windows.bat's offer runs it)."""
        said = re.compile(r"(?i)automatic start[^.]{0,80}\brefuses?\b|\brefuses? such a folder|\brefuses it\b")
        for name in ("README.md", "README-helper-security.md", "setup-windows.bat", "vrt_server.py", "transcribe.py"):
            for n, line in enumerate(read_text(name).splitlines(), 1):
                self.assertIsNone(said.search(line), "%s line %d: %s" % (name, n, line.strip()))
        self.assertIn("the automatic start warns about it", read_text("README-helper-security.md"))
        readme = read_text("README.md")
        self.assertEqual(readme.count("warns you about such a folder"), 2)       # step 1 of the Windows setup, and "Where to put the folder"


# ------------------------------------------------------------------------------------------------
# setup-windows.bat: ends a hidden helper before it repairs the folder, and can offer the automatic start (read as text; the
# behaviour is run in test_windows_scripts.py)
# ------------------------------------------------------------------------------------------------
class SetupBatAutostartTextTests(unittest.TestCase):
    def setUp(self):
        self.bat = read_text("setup-windows.bat")

    def part(self, start, end):
        return self.bat[self.bat.index(start):self.bat.index(end, self.bat.index(start))]

    def test_a_hidden_helper_is_ended_before_the_working_space_is_repaired_or_rebuilt(self):
        bat = self.bat
        repair = bat.index("Repairing the working space")
        call = bat.index("call :stop_helper")
        self.assertLess(repair, call)
        self.assertLess(call, bat.index('"%UV%" venv "%TOOLS%\\venv" --python 3.12 --allow-existing'))     # the repair step
        self.assertLess(call, bat.index("rmdir /s /q \"%TOOLS%\\venv\""))                                    # and the rebuild
        self.assertEqual(bat.count("call :stop_helper"), 1)
        self.assertLess(call, bat.index("[4 of 6]"))

    def test_the_file_is_called_only_when_it_is_in_the_folder_and_otherwise_the_person_is_only_advised(self):
        sub = self.part("\r\n:stop_helper\r\n", "rem ---- subroutine: does the folder path contain")
        self.assertIn('if exist "%TOOLS%\\stop-helper-windows.bat" goto stop_call', sub)
        self.assertIn('pushd "%TOOLS%"', sub)                                                                 # (not a "call" with the whole path: that reads a percent sign again)
        self.assertIn('call .\\stop-helper-windows.bat', sub)
        no_file = sub[:sub.index(":stop_call")]
        self.assertNotIn("stop-helper-windows", no_file.replace('exist "%TOOLS%\\stop-helper-windows.bat" goto stop_call', ""),
                         "without the file the text must not name it as something to run")
        self.assertIn("End it first, the way README.md describes", no_file)
        self.assertIn("exit /b 0", no_file)                                                                   # setup goes on either way
        called = sub[sub.index(":stop_call"):]
        self.assertIn('set "VRT_NO_PAUSE=1"', called)                                                         # it does not wait for a key in the middle
        self.assertLess(called.index("setlocal"), called.index("call "))
        self.assertLess(called.index("call "), called.index("endlocal"))
        self.assertIn("title Video Redline - one-time setup", called)

    def test_the_offer_is_a_plain_question_with_no_as_the_default_and_never_in_the_test_paths(self):
        offer = self.part(":autostart_offer", ":in_zip")
        first = offer.splitlines()[:3]
        self.assertEqual(first[1].strip(), "if defined VRT_NO_PAUSE goto end", "the test switch skips the question")
        self.assertEqual(first[2].strip(), 'if not exist "%TOOLS%\\setup-autostart-windows.bat" goto end')
        for want in ("hidden", "sign in to", '"Video Redline" icon to your Desktop and Start menu', "that icon starts it again",
                     "one start-up setting to YOUR Windows user settings", "No administrator rights", "If you say no, nothing is changed",
                     "setup-autostart-windows.bat", "(Y = yes, Enter = no)"):
            self.assertIn(want, offer)
        self.assertNotIn("page can start", offer)                  # (round 6: the host's page does not start the helper; the icon does)
        self.assertEqual(offer.count("goto autostart_go"), 2)                                                 # Y and yes, nothing else
        self.assertIn('if /i "%ANS%"=="Y" goto autostart_go', offer)
        self.assertIn('if /i "%ANS%"=="yes" goto autostart_go', offer)
        self.assertIn('call .\\setup-autostart-windows.bat /yes', offer)
        self.assertIn('pushd "%TOOLS%"', offer)
        # the folder-check test path never gets there: it ends at :folder_check_only -> :end
        check = self.part(":folder_check_only", ":end\r\n")
        self.assertIn("goto end", check)
        self.assertNotIn("autostart", check)
        # the end of the ALL DONE screen is the only way in
        self.assertEqual(self.bat.count("goto autostart_offer"), 1)
        done = self.part("ALL DONE.", ":autostart_offer")
        self.assertIn("goto autostart_offer", done)
        self.assertLess(self.bat.index("ALL DONE."), self.bat.index("goto autostart_offer"))

    def test_a_refused_automatic_start_says_what_to_do_about_the_folder(self):
        """setup-windows.bat passes /yes, so setup-autostart-windows.bat refuses a folder that is shared (directly on C:) or synchronised
        instead of asking. The person who said yes then needs to know what to do."""
        tail = self.part("The automatic start did not finish", "goto end")
        tail = re.sub(r"\s*\r?\necho\s+", " ", tail)                  # (one sentence may run over several echo lines: the words are pinned, not where the line breaks)
        for want in ("other people can change this folder", "synchronised folder", "your own user folder",
                     '(for example "%EXAMPLE%")', "start-helper-windows.bat", "say yes to the question at its end"):
            self.assertIn(want, tail)

    def test_nothing_in_the_new_lines_breaks_the_rules_of_the_other_batch_files(self):
        raw = self.bat.encode("ascii")                                                                       # plain characters only
        self.assertEqual(raw.count(b"\n"), raw.count(b"\r\n"))                                              # CRLF
        for n, line in enumerate(self.bat.splitlines(), 1):
            for var in ("%TOOLS%", "%EXAMPLE%", "%USERPROFILE%"):                # (the user folder may have an ampersand, a caret or a bracket in its name)
                if re.match(r"\s*(if .* )?echo", line, re.I) and var in line:
                    self.assertRegex(line, r'"[^"]*%s[^"]*"' % var, "line %d echoes %s unquoted: %s" % (n, var, line))
        # the example folder is worked out once, at the top, before TOOLS is (the tests that run parts of this file keep that part)
        self.assertLess(self.bat.index('set "EXAMPLE='), self.bat.index('set "TOOLS=%~dp0"'))
        self.assertNotIn("YourName", self.bat)
        self.assertIsNone(re.search(r"(?i)C:[\\/]+VideoRedline", self.bat))

    def test_the_all_done_screen_has_both_ways_and_names_the_automatic_start_only_when_its_file_is_there(self):
        done = self.part(":all_done", ":autostart_offer")
        # one branch on the file, and the branch without it never names it
        self.assertEqual(done.count('if exist "%TOOLS%\\setup-autostart-windows.bat" goto done_auto'), 1)
        without = done[:done.index(":done_auto")]
        with_it = done[done.index(":done_auto"):]
        self.assertNotIn("setup-autostart-windows", without.replace('if exist "%TOOLS%\\setup-autostart-windows.bat" goto done_auto', ""))
        self.assertIn("this folder does not have it", without)
        self.assertIn('double-click "start-helper-windows.bat"', without)
        self.assertIn("goto done_other", without)
        # (round 3d) the ALL DONE screen sends the person to the icon: setup-autostart-windows.bat adds it, then Video Redline is opened with
        # it; the hand start is the fallback. The lines are echo commands, so read them as one text.
        lines = [l for l in with_it.splitlines() if re.match(r"\s*(if [^e]*)?echo", l, re.I)]
        prose = re.sub(r"\s+", " ", " ".join(re.sub(r"^\s*(if [^e]*)?echo\s*", "", l, flags=re.I).strip() for l in lines))
        self.assertIn('Next: double-click "setup-autostart-windows.bat" in this folder to add the Video Redline icon. After that, open Video Redline with that icon', prose)
        self.assertLess(prose.index("add the Video Redline icon"), prose.index('If you would rather not, double-click "start-helper-windows.bat" each time'))
        self.assertIn("and leave its window open", prose[prose.index("If you would rather not"):])
        self.assertIn("each time you sign in to", prose)
        self.assertNotIn("page can start", with_it)                 # (round 6: it cannot; the icon starts a stopped helper)
        self.assertNotIn("Video Review", self.bat.replace("video-review", ""))
        # the sentence about the question is only printed when the question follows (the test switch skips both)
        self.assertIn("if not defined VRT_NO_PAUSE echo   (Setup asks you about this next, so you need not open the file yourself: answer Y and it does the same.)", with_it)
        self.assertIn("transcribe-windows.bat", done)                                  # drag and drop is still described

    def test_the_tidy_up_does_not_delete_tmp_as_a_whole(self):
        """A helper that runs from this folder (hidden or in a window) keeps its job folder in tmp: the finished transcript that nobody has
        fetched yet would be deleted. The tidy-up uses the helper's own clean-up, which deletes only what no running helper owns."""
        tidy = self.part(":tidy_up", ":all_done")
        self.assertNotIn("rmdir /s /q \"%TOOLS%\\tmp\"", tidy)
        self.assertIn("v.clean_old_job_folders()", tidy)
        self.assertIn("a=v.other_helpers_alive()", tidy)
        self.assertIn("a or v.clean_stale_run_dirs()", tidy)                              # (not clean_stale_run_dirs(0): a young scratch folder may be at work)
        self.assertIn("a or v.clean_spawn_lock()", tidy)
        self.assertIn('set "VRT_TOOLS=%TOOLS%"', tidy)                                    # the folder name travels in a setting, not in the command
        self.assertIn('if exist "%TOOLS%\\tmp" rmdir "%TOOLS%\\tmp"', tidy)               # an empty tmp goes, a full one stays
        self.assertNotIn("/s", tidy.split('if exist "%TOOLS%\\tmp" rmdir')[1])

    def test_the_tidy_up_gives_setup_a_name_that_is_not_a_job_folder_name(self):
        """Round 6 (R6T-2). Setup is no helper and claims no folder, so it is still called 'jobs'. clean_old_job_folders() skips the entry with
        its own name, so the old shared folder tmp\\jobs (a helper from before the per-port folders; a video copy may be in it) stayed behind,
        where the old 'rmdir /s /q tmp' removed it. Setup takes a name that is none of the job folder names."""
        tidy = self.part(":tidy_up", ":all_done")
        self.assertIn("v._instance['name']='setup'", tidy)
        self.assertLess(tidy.index("import vrt_server as v"), tidy.index("v._instance['name']='setup'"))
        self.assertLess(tidy.index("v._instance['name']='setup'"), tidy.index("v.clean_old_job_folders()"))
        V = _import("vrt_server")
        self.assertIsNone(V.JOBS_NAME.fullmatch("setup"))
        self.assertIn("name", V._instance)
        self.assertEqual(self.bat.count("call :stop_helper"), 1, "a helper is stopped only before a repair")


# ------------------------------------------------------------------------------------------------
# Item 5. The folder check in setup-windows.bat (Windows only) - nothing is downloaded
# ------------------------------------------------------------------------------------------------
@unittest.skipUnless(WIN, "Windows batch files")
class WindowsFolderCheckTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="fc-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def make(self, *parts):
        folder = os.path.join(self.root, *parts)
        os.makedirs(folder)
        for name in sorted(os.listdir(TOOLS)):
            full = os.path.join(TOOLS, name)
            if os.path.isfile(full) and name.endswith((".py", ".bat", ".command", ".txt")):
                shutil.copy2(full, folder)
        return folder

    def run_setup(self, folder, stdin=b"", **extra):
        env = {k: v for k, v in os.environ.items() if k.upper() not in ("PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONUSERBASE",
                                                                         "VRT_SKIP_VC_CHECK", "VRT_STOP_AFTER_FOLDER_CHECK")}
        env.update(VRT_NO_PAUSE="1", VRT_STOP_AFTER_FOLDER_CHECK="1", HTTPS_PROXY="http://127.0.0.1:9", HTTP_PROXY="http://127.0.0.1:9",
                   NO_PROXY="")
        for k, v in extra.items():
            if v == "":
                env.pop(k, None)
            else:
                env[k] = v
        line = '"%s"' % os.path.join(folder, "setup-windows.bat")
        r = subprocess.run('cmd /d /s /c "%s"' % line, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env,
                           cwd=folder, timeout=120)
        return r.returncode, r.stdout.decode("utf-8", errors="replace")

    def assertNothingDownloaded(self, folder):
        for sub in ("uv", "python", "venv", "hf-cache", "uv-cache"):
            self.assertFalse(os.path.exists(os.path.join(folder, sub)), sub)

    def test_a_plain_folder_passes_the_check_and_stops_at_the_test_switch(self):
        if cloud_named(self.root):
            self.skipTest("the test folder itself lies in a cloud-looking place")
        folder = self.make("plain tools")
        code, out = self.run_setup(folder)
        self.assertEqual(code, 0, out)
        self.assertNotIn("WARNING", out)
        self.assertIn("Folder check finished", out)
        self.assertNotIn("[1 of 6]", out)
        self.assertNothingDownloaded(folder)

    def test_the_folder_check_test_path_neither_stops_a_helper_nor_offers_the_automatic_start(self):
        if cloud_named(self.root):
            self.skipTest("the test folder itself lies in a cloud-looking place")
        folder = self.make("with the automatic start files")
        for name in ("stop-helper-windows.bat", "setup-autostart-windows.bat", "remove-autostart-windows.bat"):      # stand-ins
            with open(os.path.join(folder, name), "wb") as f:
                f.write(b'@echo off\r\necho STUB %~nx0 RAN\r\necho ran> "%~dp0ran-%~nx0.txt"\r\n')
        code, out = self.run_setup(folder, b"y\r\n")
        self.assertEqual(code, 0, out)
        self.assertIn("Folder check finished", out)
        self.assertNotIn("start the helper by itself", out.lower())
        self.assertNotIn("STUB", out)
        self.assertEqual([n for n in os.listdir(folder) if n.startswith("ran-")], [])
        self.assertNothingDownloaded(folder)

    def test_every_cloud_name_stops_setup_before_anything_is_downloaded(self):
        skip_in_a_cloud_folder(self)
        for name, label in (("OneDrive - Contoso", "OneDrive"), ("onedrive", "OneDrive"), ("Dropbox (Personal)", "Dropbox"),
                            ("iCloudDrive", "iCloud"), ("Mobile Documents", "iCloud"), ("com~apple~CloudDocs", "iCloud"),
                            ("Google Drive", "Google Drive"), ("GoogleDrive", "Google Drive"), ("My Drive", "Google Drive")):
            with self.subTest(folder=name):
                folder = self.make(name, "tools")
                code, out = self.run_setup(folder)
                self.assertEqual(code, 1, out)
                self.assertIn("WARNING: this folder is inside a folder that %s synchronises" % label, out)
                self.assertIn("a copy of it is kept", out)                       # why it matters, in plain words
                self.assertIn('(for example "%s\\VideoRedline")' % os.environ["USERPROFILE"].rstrip("\\"), out)    # the real user folder: the automatic start warns about a folder directly on C:
                self.assertNotIn("YourName", out)
                self.assertIn("Setup was stopped. Nothing was downloaded", out)
                self.assertNotIn("[1 of 6]", out)
                self.assertNotIn("is not recognized", out)
                self.assertNothingDownloaded(folder)

    def test_special_characters_in_the_folder_name_do_not_break_the_check(self):
        skip_in_a_cloud_folder(self)
        for name in ("OneDrive & Tom ^ (100%) ! #1", "Tom & Jerry ^ (100%) ! tools"):
            folder = self.make(name, "t")
            code, out = self.run_setup(folder)
            self.assertNotIn("is not recognized", out)
            self.assertNotIn("unexpected at this time", out)
            self.assertIn(name, out)                                              # the whole name, & ^ ( % ! intact
            self.assertEqual(code, 1 if "OneDrive" in name else 0, out)

    def test_the_example_folder_in_the_advice_is_the_real_user_folder_and_survives_odd_names(self):
        """The advice says 'for example <your user folder>\\VideoRedline': worked out at run time from USERPROFILE and printed inside quotation
        marks, so an ampersand, caret or bracket in the user name cannot break the line. A profile that cannot be a plain local folder
        (none, a network path, no drive letter) gives a placeholder for the name instead. Never a folder directly on the C drive."""
        skip_in_a_cloud_folder(self)
        folder = self.make("OneDrive", "tools")
        placeholder = "C:\\Users\\<your name>\\VideoRedline"
        for profile, want in (("C:\\Users\\pat", "C:\\Users\\pat\\VideoRedline"),
                              ("C:\\Users\\Tom & (Jerry) ^ !x! 100", "C:\\Users\\Tom & (Jerry) ^ !x! 100\\VideoRedline"),
                              ("D:\\Profiles\\pat lee", "D:\\Profiles\\pat lee\\VideoRedline"),
                              ("\\\\server\\share\\pat", placeholder), ("pat", placeholder), ("", placeholder)):
            with self.subTest(profile=profile):
                code, out = self.run_setup(folder, USERPROFILE=profile)
                self.assertEqual(code, 1, out)
                self.assertEqual(out.count('(for example "%s")' % want), 2, out)               # the question, and the line after "Setup was stopped"
                self.assertNotIn("C:\\VideoRedline", out)
                self.assertNotIn("is not recognized", out)
                self.assertNotIn("syntax of the command is incorrect", out)
                self.assertNotIn("unexpected at this time", out)

    def test_the_long_path_note_names_the_same_folder(self):
        skip_in_a_cloud_folder(self)
        folder = self.make("a very long folder name to make the whole path longer than ninety characters", "tools")
        self.assertGreater(len(folder), 90)
        code, out = self.run_setup(folder, VRT_STOP_AFTER_FOLDER_CHECK="", USERPROFILE="C:\\Users\\Pat Lee")
        self.assertIn("NOTE: this folder's path is quite long.", out)
        self.assertIn('inside your own user folder (for example "C:\\Users\\Pat Lee\\VideoRedline") and run this file again.', out)
        self.assertNotIn("is not recognized", out)

    def test_enter_or_nothing_stops_and_only_c_goes_on(self):
        folder = self.make("OneDrive", "t")
        for answer in (b"", b"\r\n", b"x\r\n", b"cancel\r\n", b"no\r\n", b'""\r\n', b"%PATH%\r\n", b"c&echo hi\r\n", b"cc\r\n"):
            code, out = self.run_setup(folder, answer)
            self.assertEqual(code, 1, "%r: %s" % (answer, out))
            self.assertIn("Setup was stopped", out)
            self.assertNotIn("Going on at your request", out)
            self.assertNotIn("\r\nhi\r\n", out)                                 # the text after & was not run as a command
        for answer in (b"C\r\n", b"c\r\n", b"  c  \r\n", b"continue\r\n", b"CONTINUE\r\n"):
            code, out = self.run_setup(folder, answer)
            self.assertEqual(code, 0, "%r: %s" % (answer, out))
            self.assertIn("Going on at your request", out)
            self.assertIn("Folder check finished", out)

    def test_after_continuing_setup_goes_on_to_the_download(self):
        folder = self.make("Dropbox", "t")
        code, out = self.run_setup(folder, b"C\r\n", VRT_STOP_AFTER_FOLDER_CHECK="")
        self.assertIn("[1 of 6] Getting the small installer (uv, 15 MB, from github.com)", out)
        self.assertEqual(code, 1, out)                                           # the (blocked) download then fails, as before
        self.assertIn("a download failed", out)


# ------------------------------------------------------------------------------------------------
# Item 5. The folder check in setup-mac.command (run with whatever bash this computer has; not a Mac)
# ------------------------------------------------------------------------------------------------
@unittest.skipUnless(find_bash(), NO_BASH)
class MacFolderCheckTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="mc-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.home = os.path.join(self.root, "home")
        self.bin = os.path.join(self.root, "bin")
        self.marker = os.path.join(self.root, "defaults-was-asked")
        os.makedirs(self.home)
        os.makedirs(self.bin)

    def fake_defaults(self, answer, exit_code=0):
        path = os.path.join(self.bin, "defaults")
        script = ('#!/bin/bash\necho asked > "%s"\nif [ "$1 $2 $3" = "read com.apple.finder FXICloudDriveDesktop" ]; then echo %s; '
                  'exit %d; fi\nexit 1\n' % (self.marker.replace("\\", "/"), answer, exit_code))
        with open(path, "wb") as f:
            f.write(script.encode("ascii"))
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    def make(self, base, *parts):
        folder = os.path.join(base, *parts)
        os.makedirs(folder)
        for name in sorted(os.listdir(TOOLS)):
            full = os.path.join(TOOLS, name)
            if os.path.isfile(full) and name.endswith((".py", ".command", ".txt")):
                shutil.copy2(full, folder)
        return folder

    def run_setup(self, folder, stdin=b"", **extra):
        env = dict(os.environ, VRT_NO_PAUSE="1", VRT_STOP_AFTER_FOLDER_CHECK="1", HOME=self.home.replace("\\", "/"),
                   HTTPS_PROXY="http://127.0.0.1:9", https_proxy="http://127.0.0.1:9", HTTP_PROXY="http://127.0.0.1:9",
                   http_proxy="http://127.0.0.1:9", ALL_PROXY="http://127.0.0.1:9")
        env["PATH"] = self.bin.replace("\\", "/") + os.pathsep + env.get("PATH", "")
        env.update(extra)
        r = subprocess.run([find_bash(), os.path.join(folder, "setup-mac.command").replace("\\", "/")], input=stdin, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, env=env, timeout=120)
        return r.returncode, r.stdout.decode("utf-8", errors="replace")

    def test_a_plain_folder_passes_and_defaults_is_not_even_asked(self):
        if cloud_named(self.root):
            self.skipTest("the test folder itself lies in a cloud-looking place")
        self.fake_defaults("1")
        folder = self.make(self.home, "VideoRedline", "tools")
        code, out = self.run_setup(folder)
        self.assertEqual(code, 0, out)
        self.assertNotIn("WARNING", out)
        self.assertIn("Folder check finished", out)
        self.assertFalse(os.path.exists(self.marker), "the Finder setting is only asked for the Desktop and Documents folders")

    def test_every_cloud_name_stops_setup_before_anything_is_downloaded(self):
        skip_in_a_cloud_folder(self)
        for name, label in (("OneDrive - Contoso", "OneDrive"), ("DROPBOX", "Dropbox"), ("Mobile Documents", "iCloud"),
                            ("com~apple~CloudDocs", "iCloud"), ("iCloud Drive", "iCloud"), ("Google Drive", "Google Drive"),
                            ("GoogleDrive", "Google Drive"), ("My Drive", "Google Drive")):
            with self.subTest(folder=name):
                folder = self.make(self.root, "cloud", name, "tools")
                code, out = self.run_setup(folder)
                self.assertEqual(code, 1, out)
                self.assertIn("WARNING: this folder is inside a folder that %s synchronises" % label, out)
                self.assertIn("a copy of it is kept", out)
                self.assertIn("~/VideoRedline", out)
                self.assertIn("Setup was stopped. Nothing was downloaded", out)
                for sub in ("uv", "python", "venv", "hf-cache"):
                    self.assertFalse(os.path.exists(os.path.join(folder, sub)), sub)

    def test_enter_or_nothing_stops_and_only_c_goes_on(self):
        folder = self.make(self.root, "OneDrive", "tools")
        for answer in (b"", b"\n", b"x\n", b"cancel\n", b"no\n", b"cc\n"):
            code, out = self.run_setup(folder, answer)
            self.assertEqual(code, 1, "%r: %s" % (answer, out))
            self.assertIn("Setup was stopped", out)
        for answer in (b"C\n", b"c\n", b"  c  \n", b"continue\n", b"Continue\n"):
            code, out = self.run_setup(folder, answer)
            self.assertEqual(code, 0, "%r: %s" % (answer, out))
            self.assertIn("Going on at your request", out)

    def test_desktop_and_documents_stop_only_when_icloud_drive_keeps_them(self):
        skip_in_a_cloud_folder(self)
        for rel in (("Documents", "tools"), ("Documents",), ("Desktop", "VideoRedline", "tools"), ("documents", "TOOLS")):
            folder = self.make(self.home, *rel)
            with self.subTest(folder="/".join(rel), icloud="on"):
                self.fake_defaults("1")
                code, out = self.run_setup(folder)
                self.assertEqual(code, 1, out)
                self.assertIn("WARNING: this folder is inside your Desktop or Documents folder, which iCloud Drive synchronises", out)
                self.assertIn("iCloud could upload that copy", out)
                self.assertIn("Setup was stopped", out)
            for answer, why in (("0", "off"), ("2", "odd answer")):
                with self.subTest(folder="/".join(rel), icloud=why):
                    self.fake_defaults(answer)
                    code, out = self.run_setup(folder)
                    self.assertEqual(code, 0, out)
                    self.assertNotIn("WARNING", out)
            shutil.rmtree(os.path.join(self.home, rel[0]), ignore_errors=True)

    def test_without_defaults_or_when_it_fails_there_is_no_warning_and_no_crash(self):
        skip_in_a_cloud_folder(self)
        folder = self.make(self.home, "Documents", "tools")
        if shutil.which("defaults") is None:                                        # (a real Mac has its own, with a real answer)
            code, out = self.run_setup(folder)                                      # no `defaults` on the path at all
            self.assertEqual(code, 0, out)
            self.assertNotIn("WARNING", out)
            self.assertNotIn("command not found", out)
        self.fake_defaults("", exit_code=1)                                         # the key does not exist: nothing printed, exit 1
        code, out = self.run_setup(folder)
        self.assertEqual(code, 0, out)
        self.assertNotIn("WARNING", out)

    def test_similar_looking_folders_are_not_desktop_or_documents(self):
        skip_in_a_cloud_folder(self)
        self.fake_defaults("1")
        for rel in (("Documents-old", "tools"), ("Desktop2",), ("Projects", "Documents", "tools")):
            folder = self.make(self.home, *rel)
            code, out = self.run_setup(folder)
            self.assertEqual(code, 0, "%s: %s" % (rel, out))
            self.assertNotIn("WARNING", out)

    def test_the_mac_files_still_parse_and_stay_old_bash_friendly(self):
        for name in COMMANDS:
            r = subprocess.run([find_bash(), "-n", os.path.join(TOOLS, name).replace("\\", "/")], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, name + ": " + r.stderr)


# ------------------------------------------------------------------------------------------------
# The last screen of the Mac scripts (the pause) - run to an early exit, so nothing is downloaded and no helper is started
# ------------------------------------------------------------------------------------------------
@unittest.skipUnless(find_bash(), NO_BASH)
class MacPauseScreenTests(unittest.TestCase):
    """Each script is run alone in an empty folder: it stops at 'the other files are missing' and then pauses."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="mp-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def run_alone(self, name, stdin=b"x", pause=True):
        folder = os.path.join(self.root, "alone")
        os.makedirs(folder, exist_ok=True)
        shutil.copy2(os.path.join(TOOLS, name), folder)
        env = {k: v for k, v in os.environ.items() if k != "VRT_NO_PAUSE"}
        if not pause:
            env["VRT_NO_PAUSE"] = "1"
        env.update(HTTPS_PROXY="http://127.0.0.1:9", https_proxy="http://127.0.0.1:9", HTTP_PROXY="http://127.0.0.1:9",
                   http_proxy="http://127.0.0.1:9", ALL_PROXY="http://127.0.0.1:9")
        r = subprocess.run([find_bash(), os.path.join(folder, name).replace("\\", "/")], input=stdin, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, env=env, timeout=120)
        return r.returncode, r.stdout.decode("utf-8", errors="replace")

    def test_the_last_line_asks_for_a_key_to_finish_and_does_not_promise_that_the_window_closes(self):
        for name in COMMANDS:
            with self.subTest(script=name):
                code, out = self.run_alone(name)
                self.assertEqual(code, 1, out)
                self.assertIn("PROBLEM", out)
                last = [l for l in out.splitlines() if l.strip()][-1]
                self.assertIn("Press any key to finish.", last)
                self.assertIn("You can then close this window.", last)
                self.assertNotIn("to close this window", out)

    def test_without_a_key_press_the_script_still_ends_with_its_own_exit_code(self):
        for name in COMMANDS:
            with self.subTest(script=name):
                code, out = self.run_alone(name, stdin=b"")
                self.assertEqual(code, 1, out)

    def test_the_test_switch_still_skips_the_pause(self):
        for name in COMMANDS:
            with self.subTest(script=name):
                code, out = self.run_alone(name, pause=False)
                self.assertEqual(code, 1, out)
                self.assertNotIn("Press any key", out)


# ------------------------------------------------------------------------------------------------
# Which bash the Mac-script tests use (from PowerShell or cmd, plain "bash" is the Linux-subsystem launcher)
# ------------------------------------------------------------------------------------------------
class BashLookupTests(unittest.TestCase):
    WSL = r"C:\Users\someone\AppData\Local\Microsoft\WindowsApps\bash.EXE"

    def fake_run(self, code, calls):
        def run(cmd, *a, **k):
            calls.append(cmd[0])
            return subprocess.CompletedProcess(cmd, code)
        return run

    def test_the_windows_linux_launcher_is_never_started_or_chosen(self):
        calls = []
        with mock.patch.object(_paths, "_BASH", []), mock.patch.object(_paths.shutil, "which", return_value=self.WSL), \
                mock.patch.object(_paths.os.path, "isfile", return_value=True), \
                mock.patch.object(_paths.subprocess, "run", self.fake_run(0, calls)):
            chosen = find_bash()
        self.assertNotIn(self.WSL, calls)                                         # not even to ask it a question (that starts Linux)
        self.assertNotIn("windowsapps", (chosen or "").lower())
        self.assertNotIn("system32", (chosen or "").lower())

    def test_a_bash_that_cannot_see_windows_folders_means_no_bash_so_the_tests_skip_instead_of_failing(self):
        calls = []
        with mock.patch.object(_paths, "_BASH", []), mock.patch.object(_paths.shutil, "which", return_value=r"C:\Odd\bash.exe"), \
                mock.patch.object(_paths.os.path, "isfile", return_value=True), \
                mock.patch.object(_paths.subprocess, "run", self.fake_run(1, calls)):
            self.assertIsNone(find_bash())
        self.assertIn(r"C:\Odd\bash.exe", calls)                                  # it was asked, and it said no
        self.assertIn("Git", NO_BASH)                                             # and the skip message says what to do

    def test_the_bash_the_tests_use_can_open_this_folder(self):
        bash = find_bash()
        if not bash:
            self.skipTest(NO_BASH)
        r = subprocess.run([bash, "-c", 'test -f "$1"', "x", os.path.join(TOOLS, "setup-mac.command").replace("\\", "/")])
        self.assertEqual(r.returncode, 0, bash)


# ------------------------------------------------------------------------------------------------
# Round 3d (the product is now called Video Redline): the texts of the helper and the README
#   1 folder advice   2 the Video Redline icon first   3 the old name and "whoever gave you this tool" gone
#   6 the onnx-asr notice in the source   7 the credits paragraph   P5 the version line   P7 the helper version   8 .gitignore
# Each test below fails on the copy of the files from before the round (set VRT_TOOLS_DIR to it, see _paths.py).
# ------------------------------------------------------------------------------------------------
PACKAGE_TEXT_FILES = ("README.md", "README-helper-security.md", "requirements.txt", "transcribe.py", "vrt_audio.py", "vrt_engines.py",
                      "vrt_env.py", "vrt_merge.py", "vrt_server.py")
MIT_ONNX_ASR = """MIT License

Copyright (c) 2025 Ilya Stupakov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE."""


class RoundThreeDFolderAdviceTests(unittest.TestCase):
    """Item 1: every piece of advice that names a folder says %USERPROFILE%\\VideoRedline (C:\\Users\\<name>\\VideoRedline) on Windows and
    ~/VideoRedline on a Mac, and "a short place inside your own user folder" for long paths. A folder directly on C:\\ is writable by every
    signed-in user, which setup-autostart-windows.bat warns about."""

    def test_the_readme_names_the_user_folder_in_every_place_that_advises_a_folder(self):
        readme = read_text("README.md")
        self.assertIn("`%USERPROFILE%\\VideoRedline`", readme)
        self.assertIn("press the Windows key + R, type `%USERPROFILE%` and press Enter", readme)         # how to get to the user folder
        self.assertIn("use a short place inside your own user folder", readme)                           # the long-path note
        self.assertIn("The tools folder then lies inside `C:\\Users\\<your name>\\VideoRedline`", readme)         # Windows step 1
        self.assertIn("so that the tools folder ends up inside `~/VideoRedline`", readme)                          # the Mac step
        where = readme[readme.index("### Where to put the folder"):readme.index("What is checked, and when:")]
        for want in ("**`C:\\Users\\<your name>\\VideoRedline`**", "`%USERPROFILE%\\VideoRedline`", "**`~/VideoRedline`**",
                     "not directly on the C drive"):
            self.assertIn(want, where)
        self.assertNotIn("\\transcriber", readme)                    # (the old folder name of the tools: the tools folder is called tools)
        self.assertNotIn("/transcriber", readme)

    def test_no_file_of_the_package_names_the_old_folder_or_a_folder_directly_on_c(self):
        bad = re.compile(r"(?i)C:[\\/]+Video(?:Redline|Review)|(?<![A-Za-z])VideoReview(?!Helper)|\bYourName\b")
        for name in PACKAGE_TEXT_FILES + ("setup-windows.bat", "start-helper-windows.bat", "transcribe-windows.bat") + COMMANDS:
            for n, line in enumerate(read_text(name).splitlines(), 1):
                self.assertIsNone(bad.search(line), "%s line %d: %s" % (name, n, line.strip()))
        # ... and where the advice names a folder at all, it is the one inside the user folder
        for name in ("README-helper-security.md", "vrt_server.py", "transcribe.py"):
            self.assertRegex(read_text(name), r"VideoRedline", name)
        security = read_text("README-helper-security.md")
        self.assertIn("C:\\Users\\<your name>\\VideoRedline", security)
        self.assertIn("that is `%USERPROFILE%\\VideoRedline`", security)
        self.assertIn("~/VideoRedline", security)
        self.assertIn("not directly on the C drive of Windows", security)

    def test_the_folder_warning_of_the_helper_ends_with_what_to_do_in_the_new_place_and_names_the_icon_on_windows(self):
        V = self.V
        folder = tempfile.mkdtemp(prefix="warn-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        paths = ("C:\\Users\\me\\OneDrive\\tools", "D:\\Google Drive\\tools")
        with mock.patch.object(V, "IS_WIN", True), mock.patch.object(V, "TOOLS_DIR", folder), \
                mock.patch.object(V, "START_FILE", "start-helper-windows.bat"):
            for path in paths:
                lines = V.sync_warning(path, network=False, icloud_desktop=False)
                self.assertEqual(len(lines), 5)                                            # (round 8: a line "end the helper first" sits before the last)
                self.assertEqual(lines[4], V.move_to_new_place_text())
                self.assertIn("start-helper-windows.bat", lines[4])                       # no autostart file here: the hand start
                self.assertNotIn("setup-autostart", lines[4])
            self.assertEqual(V.sync_warning("C:\\x", network=True)[4], V.move_to_new_place_text())
            open(os.path.join(folder, "setup-autostart-windows.bat"), "w").close()
            for path in paths:
                last = V.sync_warning(path, network=False, icloud_desktop=False)[4]
                self.assertEqual(last, "After the move, run setup-windows.bat there once, then setup-autostart-windows.bat (it makes the Video Redline "
                                       "icon there), and open Video Redline with that icon.")
        with mock.patch.object(V, "IS_WIN", False):
            for lines in (V.sync_warning("/Users/me/Dropbox/tools", network=False),
                          V.sync_warning("/Users/me/Documents/tools", network=False, icloud_desktop=True, home="/Users/me")):
                self.assertEqual(len(lines), 4)                                            # a Mac: no "end the helper first" line, the wording as before
                self.assertEqual(lines[3], "run the setup file there once, and start the helper from there.")
                self.assertTrue(lines[2].endswith("(for example %s)," % V.EXAMPLE_FOLDER), lines[2])         # (the comma: line 4 goes on from it)

    def setUp(self):
        self.V = _import("vrt_server")


class RoundThreeDIconFirstTests(unittest.TestCase):
    """Item 2 and the icon wording. The host's page never starts the helper. On Windows the Video Redline icon does (it starts the helper if
    needed and opens the page); setup-autostart-windows.bat adds the icon; start-helper-windows.bat (a window that stays open) is the fallback.
    A Mac starts the helper by hand, as before."""

    def setUp(self):
        self.V = _import("vrt_server")
        self.folder = tempfile.mkdtemp(prefix="icon-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, self.folder, ignore_errors=True)

    def win(self, with_file):
        """A context in which the helper believes it runs on Windows from a tools folder that has (or lacks) setup-autostart-windows.bat."""
        marker = os.path.join(self.folder, "setup-autostart-windows.bat")
        if with_file:
            open(marker, "w").close()
        elif os.path.exists(marker):
            os.remove(marker)
        stack = contextlib.ExitStack()
        stack.enter_context(mock.patch.object(self.V, "IS_WIN", True))
        stack.enter_context(mock.patch.object(self.V, "TOOLS_DIR", self.folder))
        stack.enter_context(mock.patch.object(self.V, "START_FILE", "start-helper-windows.bat"))
        stack.enter_context(mock.patch.object(self.V, "SETUP_FILE", "setup-windows.bat"))
        self.addCleanup(stack.close)
        return stack

    def test_start_again_text_names_the_icon_first_then_the_file_that_adds_it_then_the_hand_start(self):
        V = self.V
        with self.win(True):
            long_text = V.start_again_text()
            self.assertEqual(long_text, "Then start the helper again: double-click the Video Redline icon on your Desktop. If there is no such icon yet, "
                                        "double-click setup-autostart-windows.bat once (it adds the icon).")
            self.assertEqual(V.start_again_text(short=True), "Then start the helper again: double-click the Video Redline icon on your Desktop.")
            self.assertLess(long_text.index("Video Redline icon"), long_text.index("setup-autostart-windows.bat"))
            self.assertNotIn("start-helper-windows", long_text)
        with self.win(False):                                       # a copy of the tools without the file: it must not be named
            text = V.start_again_text()
            self.assertEqual(text, "Then start the helper again: double-click start-helper-windows.bat and leave its window open.")
            self.assertNotIn("icon", text)
        with mock.patch.object(V, "IS_WIN", False):
            self.assertEqual(V.start_again_text(), "Then start the helper again.")                   # a Mac: by hand, as before
            self.assertEqual(V.start_again_text(short=True), "Then start the helper again.")

    def test_the_texts_that_send_a_person_to_the_setup_file_end_with_the_icon_on_windows_and_are_unchanged_on_a_mac(self):
        V = self.V
        for with_file in (True, False):
            with self.win(with_file), mock.patch.object(V, "_glob_size_ok", return_value=False):
                end = V.start_again_text()
                for text in (V.setup_text(), V.models_problem(),
                             V.explain_failure(1, "A speech model was only partly downloaded.", "", "")[1]):
                    self.assertTrue(text.endswith(" Wait for ALL DONE. " + end), text)
                    self.assertIn("double-click setup-windows.bat", text)
                    self.assertNotIn("then start the helper again.", text)         # (the old end: no word on how)
                vc = V.explain_failure(1, "", "The Microsoft Visual C++ Redistributable is missing", "")
                self.assertEqual(vc[0], "not-ready")
                self.assertTrue(vc[1].endswith(V.start_again_text(short=True)), vc[1])
                self.assertLessEqual(len(vc[1]), 400, len(vc[1]))
                self.assertLessEqual(len(V.setup_text()), 400)
        with mock.patch.object(V, "IS_WIN", False), mock.patch.object(V, "SETUP_FILE", "setup-mac.command"), \
                mock.patch.object(V, "_glob_size_ok", return_value=False):
            self.assertTrue(V.setup_text().endswith("Wait for ALL DONE. Then start the helper again."))
            self.assertTrue(V.models_problem().endswith("Wait for ALL DONE. Then start the helper again."))

    def test_a_moved_folder_sends_a_windows_person_to_the_file_that_makes_the_icon_again(self):
        """The old icon and the start-up setting still point at the old place: AUTOSTART.md says to run setup-autostart-windows.bat again."""
        V = self.V
        with self.win(True):
            text = V.moved_text()
            self.assertIn("Then double-click setup-autostart-windows.bat: it makes the Video Redline icon and starts the helper.", text)
            self.assertLess(text.index("double-click setup-windows.bat"), text.index("setup-autostart-windows.bat"))
            self.assertLessEqual(len(text), 400, len(text))
        with self.win(False):
            self.assertNotIn("setup-autostart", V.moved_text())

    def test_the_text_of_a_helper_without_a_window_says_how_to_start_it_again(self):
        V = self.V
        with self.win(True):
            self.assertEqual(V.how_to_start_background(), "To start it again: double-click the Video Redline icon on your Desktop.")
        with self.win(False):          # (round 8: a copy of the tools without setup-autostart-windows.bat has no icon to name: the hand start, as start_again_text says)
            self.assertEqual(V.how_to_start_background(), "To start it again: double-click start-helper-windows.bat and leave its window open.")
            self.assertNotIn("icon", V.how_to_start_background())
        with mock.patch.object(V, "IS_WIN", False):
            self.assertEqual(V.how_to_start_background(), "")
        src = read_text("vrt_server.py")
        self.assertIn("how_to_stop_background() + \" \"\n                     + how_to_start_background()", src)

    def test_the_header_of_the_helper_puts_the_icon_before_the_hand_start_and_says_the_page_never_starts_it(self):
        head = read_text("vrt_server.py").split('"""')[1]
        flat = re.sub(r"\s+", " ", head)
        self.assertIn("the Video Redline page never starts this helper (neither do its buttons Create transcript and find cuts and Check again)", flat)
        for a, b in (("double-click the Video Redline icon on your Desktop", "setup-autostart-windows.bat"),
                     ("setup-autostart-windows.bat", "double-click start-helper-windows.bat"),
                     ("double-click start-helper-windows.bat", "Mac: open Terminal")):
            self.assertIn(a, flat)
            self.assertIn(b, flat)
            self.assertLess(flat.index(a), flat.index(b), (a, b))
        self.assertIn("leave its window open", flat)
        self.assertNotIn("A web page cannot start programs, so you start this helper once", flat)       # (the old first sentence)

    def test_the_readme_puts_the_icon_first_everywhere_it_tells_a_windows_person_to_start_the_helper(self):
        readme = read_text("README.md")
        # step 4 of the Windows setup: the icon comes next (setup asks; Enter skips it; the file can be run later)
        step = readme[readme.index("4. When you see **ALL DONE**, setup is finished."):]
        step = step[:step.index("\n")]
        self.assertIn("Next comes the **Video Redline** icon.", step)
        self.assertIn("which also adds the icon", step)
        self.assertIn("you can double-click `setup-autostart-windows.bat` yourself later", step)
        self.assertLess(step.index("Video Redline"), step.index("start the helper by hand"))
        # the troubleshooting list starts with the icon, and every "start the helper again" says how on Windows
        trouble = readme[readme.index("### If the button does not work"):readme.index("### Starting automatically (Windows)")]
        first = trouble[trouble.index("- **"):].split("\n")[0]
        self.assertTrue(first.startswith("- **The page says it could not find the helper (Windows).** Double-click the **Video Redline** icon on your Desktop"), first)
        self.assertLess(first.index("Video Redline"), first.index("setup-autostart-windows.bat"))
        self.assertLess(first.index("setup-autostart-windows.bat"), first.index("start-helper-windows.bat"))
        self.assertIn("(This is the window of `start-helper-windows.bat`; the icon has no window.)", trouble)
        for line in trouble.splitlines():
            if re.search(r"(?i)start the helper again", line) and "Windows" not in line:
                self.fail("a Windows person is told to start the helper again without the icon: " + line.strip())
        # moving the folder: the icon and the start-up setting point at the old place until setup-autostart-windows.bat is run again
        self.assertIn("until you do, the **Video Redline** icon and the automatic start still point at the old place", readme)
        self.assertIn("it makes the icon and the start-up setting point at the new place", readme)
        # the helper stopped on purpose: the icon starts it again
        self.assertIn("The **Video Redline** icon starts it again.", readme)
        self.assertIn("the page never starts it by itself", readme)
        self.assertNotRegex(readme, r"(?i)the page (can|will|may) start")

    def test_the_security_readme_names_the_icon_as_something_that_starts_a_helper_without_a_window(self):
        text = read_text("README-helper-security.md")
        self.assertIn("A helper that the Video Redline icon starts, or that starts by itself", text)
        self.assertIn("setup-autostart-windows.bat adds the icon and turns it on", text)
        self.assertIn("(the icon starts it again)", text)
        self.assertLessEqual(len(text.rstrip().splitlines()), 20)

    def test_the_banner_the_readme_quotes_is_the_one_the_helper_prints(self):
        server = read_text("vrt_server.py")
        readme = read_text("README.md")
        for said in ("Video Redline helper is running.", "Video Redline helper is running in the background."):
            self.assertIn('"%s"' % said, server)
            self.assertIn(said, readme)
        self.assertIn('"Leave this window open. Go back to the page and click",', server)               # (two lines since round 3e)
        self.assertIn('"Create transcript and find cuts.",', server)
        self.assertIn("Leave this window open. Go back to the page and click Create transcript and find cuts.", readme)
        self.assertNotIn("Video Review helper", readme)
        self.assertNotIn("Video Review helper", server)


class RoundThreeDNameTests(unittest.TestCase):
    """Item 3 and P6: a person never reads "Video Review" or "whoever gave you this tool" in the helper's texts or in the READMEs."""

    def test_no_person_facing_text_of_the_package_says_video_review_or_whoever_gave_you_this_tool(self):
        # (what stays: the identity string video-review-helper, the file format ids video-review-*, VideoReviewHelper, videoreview://,
        # open_video_review.pyw, video-review.ico - none of them has a space or a capital R after "Video")
        old = re.compile(r"(?i:video review)|Video-Review|\bVideoReview\b|(?i:whoever gave you)")
        for name in PACKAGE_TEXT_FILES + ("setup-windows.bat", "start-helper-windows.bat", "transcribe-windows.bat", "setup-mac.command",
                                          "start-helper-mac.command", "transcribe-mac.command", ".gitignore"):
            for n, line in enumerate(read_text(name).splitlines(), 1):
                m = old.search(line)
                self.assertIsNone(m, "%s line %d: %s" % (name, n, line.strip()))
        for name in PACKAGE_TEXT_FILES:
            read_text(name).encode("ascii")                                                          # plain characters only
        for must in ("the person who invited you to the beta",):
            for name in ("README.md", "transcribe.py"):                # (the helper's own failure text leaves that to the client since round 3e)
                self.assertIn(must, read_text(name), name)

    def test_the_failure_texts_of_the_helper_send_a_person_to_whoever_invited_them_to_the_beta(self):
        V = self.V
        with mock.patch.dict(os.environ):
            os.environ.pop("VRT_BACKGROUND", None)
            window = V.explain_failure(1, "", "", "")[1]
            os.environ["VRT_BACKGROUND"] = "1"
            hidden = V.explain_failure(1, "", "", "")[1]
        # (round 3e: the helper's sentence says what happened and where to look; the client adds what to do, and names the person)
        for text in (window, hidden):
            self.assertTrue(text.startswith("Something went wrong while making the transcript. "), text)
            self.assertNotIn("Try once more", text)
        self.assertIn("logs/last-error.txt", window)
        self.assertIn("logs folder", hidden)
        T = _import("transcribe")
        src = read_text("transcribe.py")
        self.assertEqual(src.count("the person who invited you to the beta"), 2)
        self.assertEqual(T.HELPER_VERSION, V.HELPER_VERSION)

    def setUp(self):
        self.V = _import("vrt_server")

    def test_the_banners_and_the_status_page_say_video_redline(self):
        V = self.V
        for background in (False, True):
            for win in (True, False):
                with mock.patch.object(V, "IS_WIN", win):
                    lines = V.already_running_lines(background)
                    self.assertTrue(lines[0].startswith("The Video Redline helper is ALREADY RUNNING"), lines)
                    self.assertIn("Video Redline page", " ".join(lines))
        out = io.StringIO()
        with mock.patch.object(V, "bind_server", return_value=(None, None)), contextlib.redirect_stdout(out):
            self.assertEqual(V.main([]), 1)
            V.CON.flush()
        self.assertIn("Video Redline helper " + V.HELPER_VERSION, out.getvalue())
        self.assertNotIn("Video Review", out.getvalue())
        src = read_text("vrt_server.py")
        for said in ("This helper only answers the Video Redline page on this computer.",
                     "Video Redline helper is running, but it is NOT ready yet.", "Video Redline helper (local server for the page)."):
            self.assertIn(said, src)


class RoundThreeDHelperVersionTests(unittest.TestCase):
    """P7. The helper changed a lot since 1.0.0 shipped, and a running old helper could not be told apart from a new one. Nothing compares
    the number (the client only passes it on, the host's opener looks at the identity string), so it was raised to 1.1.0."""

    def test_both_files_say_1_1_0(self):
        V = _import("vrt_server")
        T = _import("transcribe")
        self.assertEqual(V.HELPER_VERSION, "1.1.1")
        self.assertEqual(T.HELPER_VERSION, "1.1.1")
        self.assertEqual(V.HELPER_ID, "video-review-helper")                    # the identity string the host's opener checks stays
        for name, want in (("vrt_server.py", 'HELPER_VERSION = "1.1.1"'), ("transcribe.py", 'HELPER_VERSION = "1.1.1"')):
            self.assertIn(want, read_text(name))
        self.check_nothing_compares_the_number()                                   # (so the number can change without anything breaking)

    def check_nothing_compares_the_number(self):
        compares = re.compile(r"HELPER_VERSION\s*(==|!=|<=|>=|<|>)|(==|!=|<=|>=)\s*HELPER_VERSION|\.version\s*(===|!==|==|!=|<|>)")
        for name in PACKAGE_TEXT_FILES:
            for n, line in enumerate(read_text(name).splitlines(), 1):
                self.assertIsNone(compares.search(line), "%s line %d: %s" % (name, n, line.strip()))
        client = module_file("transcriber-client.js")
        if client:
            with open(client, "rb") as f:
                js = f.read().decode("utf-8")
            self.assertIsNone(re.search(r"(?<!typeof )\bs\.version\s*(===|!==|==|!=|<|>)", js))          # it is handed on as a string, never compared

    def test_status_and_the_headers_carry_it(self):
        V = _import("vrt_server")
        with mock.patch.object(V, "READY", _ReadyStub()):
            server = V.HelperServer(("127.0.0.1", 0), V.Handler)
            port = server.server_address[1]
            t = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
            t.start()
            try:
                c = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
                c.request("GET", "/status")
                r = c.getresponse()
                body = json.loads(r.read().decode("ascii"))
                self.assertEqual(body["version"], "1.1.1")
                self.assertEqual(body["helper"], "video-review-helper")
                self.assertEqual(r.getheader("X-Helper"), "video-review-helper/1.1.1")
                self.assertEqual(r.getheader("Server").split()[0], "VideoReviewHelper/1.1.1")      # (the Server header name stays: other code depends on it)
                c.close()
                c = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
                c.request("GET", "/", headers={"Origin": "https://evil.example"})
                r = c.getresponse()
                text = r.read().decode("ascii")
                self.assertEqual(r.status, 403)
                self.assertIn("This helper only answers the Video Redline page on this computer.", text)
                self.assertNotIn("Video Review", text)
                c.close()
            finally:
                server.shutdown()
                server.server_close()

    def test_the_command_line_says_the_same(self):
        for name in ("vrt_server.py", "transcribe.py"):
            r = subprocess.run([sys.executable, "-I", os.path.join(TOOLS, name), "--version"], stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120, cwd=TOOLS)
            self.assertEqual(r.stdout.decode("ascii").strip(), "%s 1.1.1" % name, name)


class RoundThreeDLicenceTests(unittest.TestCase):
    """Items 6, 7, 8 and P5."""

    def test_the_source_carries_the_onnx_asr_copyright_line_and_permission_notice_above_the_function(self):
        src = read_text("vrt_engines.py")
        src.encode("ascii")
        i = src.index("def _tdt_decoding_with_durations(")
        before = src[:i]
        block = before[before.rindex("# ----------------------------------------------------------------------------------------------\n# Parakeet"):]
        for want in ("https://github.com/istupakov/onnx-asr", "MIT licence", "Copyright (c) 2025 Ilya Stupakov", "MODIFIED"):
            self.assertIn(want, block)
        # the licence text is the one of the Appendix of THIRD-PARTY-NOTICES.md, word for word (the comment marks are taken off)
        lines = [re.sub(r"^#\s?", "", l).strip() for l in block.splitlines()]
        got = "\n".join(lines[lines.index("MIT License"):lines.index("SOFTWARE.") + 1])
        self.assertEqual(got, MIT_ONNX_ASR)
        # the notice is a comment directly above the function (no code between them), and it says what the change is
        at = before.index("Copyright (c) 2025 Ilya Stupakov")
        between = before[before.rindex("\n", 0, at) + 1:]
        self.assertTrue(all(l.startswith("#") or not l.strip() for l in between.splitlines()), "code between the notice and the function")
        flat = re.sub(r"\s*\n#\s*", " ", block)                 # (the comment wraps)
        self.assertIn("this copy keeps it and returns it with the start frame", flat)
        self.assertIn("this copy is shortened", flat)
        doc = src[i:src.index('"""', src.index('"""', i) + 3)]
        self.assertIn("MIT licence", doc)
        self.assertIn("MODIFIED", doc)
        self.assertIn("THIRD-PARTY-NOTICES.md", block)
        self.check_the_notice_is_true_about_what_was_changed()

    def check_the_notice_is_true_about_what_was_changed(self):
        """The function returns (start, duration) pairs: that is the change the comment names. A function that returned only the start frame
        would make the comment (and THIRD-PARTY-NOTICES.md) false."""
        src = read_text("vrt_engines.py")
        body = src[src.index("def _tdt_decoding_with_durations("):src.index("# Tokens to words")]
        self.assertIn("stamps.append((t, max(int(step), 0)))", body)

    def test_the_credits_paragraph_points_at_the_notices_file_and_keeps_the_parakeet_credit_line(self):
        readme = read_text("README.md")
        part = readme[readme.index("## Credits and licences"):]
        self.assertIn("Credits and licences for everything this tool uses are in [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) "
                      "(in the folder above this one).", part)
        for gone in ("none of it is changed", "PyAV (BSD", "only wires together", "Check each project"):
            self.assertNotIn(gone, readme)
        quote = [l for l in part.splitlines() if l.startswith("> ")]
        self.assertEqual(len(quote), 1)
        for want in ("**Parakeet TDT 0.6B** (v2, and the optional v3) by **NVIDIA**, licensed under **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/).",
                     "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2 and https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3 .",
                     "published by **Ilya Stupakov (istupakov)**, also under CC BY 4.0:",
                     "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx and https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx .",
                     "Video Redline runs these files as published and does not change them. The models are provided \"as is\", without any warranty "
                     "(see section 5 of the licence)."):
            self.assertIn(want, quote[0])
        # nothing more about licences than that (the notices file says it all)
        self.assertLess(len(part.split()), 220)
        for word in ("MIT", "Apache", "BSD", "GPL", "LGPL"):
            self.assertNotIn(word, part)
        # the developer note points at the notice that sits in the source
        self.assertIn("a modified copy of an onnx-asr function", readme)

    def test_the_readme_has_the_version_line_under_the_title(self):
        lines = read_text("README.md").splitlines()
        self.assertEqual(lines[0], "# Transcription helper for Video Redline")
        self.assertEqual(lines[1], "")
        self.assertEqual(lines[2], "Version 0.1.0-beta")
        self.assertEqual(lines[3], "")

    def test_gitignore_lists_the_icon_pictures_with_a_comment_and_still_lists_logs(self):
        lines = read_text(".gitignore").splitlines()
        self.assertIn("*.ico", lines)
        above = lines[lines.index("*.ico") - 1]
        self.assertTrue(above.startswith("#"), above)
        for word in ("add-desktop-icon-windows.bat", "video-redline.ico", "video-review.ico"):
            self.assertIn(word, above)
        for kept in ("logs/", "venv/", "hf-cache/", "tmp/"):
            self.assertIn(kept, lines)
        read_text(".gitignore").encode("ascii")


class RoundEightPydocsTests(unittest.TestCase):
    """Round 8 (reviewers' findings R8-REV-1, L1, L2, L4, L5, L7): the folder WARNING of the helper says what to move and to end the helper
    first (Windows will not move a folder while the helper runs from it, as AUTOSTART.md says); how a hidden helper is started again does
    not contradict the problem line above it; the README tells the truth about removing the tool, about a busy helper and about what to send."""

    LONG = "C:\\Users\\me\\OneDrive\\tools"

    def setUp(self):
        self.V = _import("vrt_server")
        self.folder = tempfile.mkdtemp(prefix="r8-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, self.folder, ignore_errors=True)

    def win(self, autostart=False, stop_file=False, background=False):
        """A helper that believes it runs on Windows from a tools folder with (or without) the two files of the host, with or without a window."""
        for name, wanted in (("setup-autostart-windows.bat", autostart), ("stop-helper-windows.bat", stop_file)):
            path = os.path.join(self.folder, name)
            if wanted:
                open(path, "w").close()
            elif os.path.exists(path):
                os.remove(path)
        stack = contextlib.ExitStack()
        stack.enter_context(mock.patch.object(self.V, "IS_WIN", True))
        stack.enter_context(mock.patch.object(self.V, "TOOLS_DIR", self.folder))
        stack.enter_context(mock.patch.object(self.V, "START_FILE", "start-helper-windows.bat"))
        stack.enter_context(mock.patch.dict(os.environ, {"VRT_BACKGROUND": "1" if background else ""}))
        self.addCleanup(stack.close)
        return stack

    WHY = "Windows will not move a folder while the helper runs from it."

    def test_the_windows_warning_says_to_end_the_helper_before_the_folder_is_moved(self):
        V = self.V
        with self.win(autostart=True):                                           # a helper with a window of its own: close the window
            self.assertEqual(V.stop_before_moving_text(), "First close this window, which stops the helper. " + self.WHY)
            lines = V.sync_warning(self.LONG, network=False, icloud_desktop=False)
            self.assertEqual(len(lines), 5)
            self.assertIn("move the whole Video Redline folder", lines[2])
            self.assertEqual(lines[3], "First close this window, which stops the helper. " + self.WHY)
            self.assertTrue(lines[4].startswith("After the move, run setup-windows.bat there once"), lines[4])   # the order: move, end the helper first, then set up
            # the same three lines for a network drive and for iCloud's Desktop and Documents
            for other in (V.sync_warning("C:\\x", network=True),
                          V.sync_warning("C:\\Users\\me\\Documents\\tools", network=False, icloud_desktop=True, home="C:\\Users\\me")):
                self.assertEqual(len(other), 5, other)
                self.assertEqual(other[3], V.stop_before_moving_text())
                self.assertEqual(other[4], V.move_to_new_place_text())

    def test_the_warning_of_a_hidden_helper_names_the_file_that_stops_it_or_the_task_manager_way(self):
        V = self.V
        with self.win(stop_file=True, background=True):
            text = V.stop_before_moving_text()
            self.assertEqual(text, "First stop the helper (it runs without a window): double-click stop-helper-windows.bat. " + self.WHY)
            self.assertNotIn("this window", text)                                  # a hidden helper has no window to close
            self.assertEqual(V.sync_warning(self.LONG, network=False, icloud_desktop=False)[3], text)
        with self.win(stop_file=False, background=True):                         # a copy of the tools without the file: it must not be named
            text = V.stop_before_moving_text()
            self.assertNotIn("stop-helper-windows", text)
            self.assertNotIn("this window", text)
            for want in ("pythonw.exe", "command line", "Task Manager, Details tab", "sign out of Windows", self.WHY):
                self.assertIn(want, text)

    def test_a_mac_gets_no_end_the_helper_first_line_and_keeps_its_wording(self):
        V = self.V
        with mock.patch.object(V, "IS_WIN", False):
            self.assertEqual(V.stop_before_moving_text(), "")
            lines = V.sync_warning("/Users/me/Dropbox/tools", network=False)
        self.assertEqual(len(lines), 4)
        self.assertTrue(lines[2].startswith("To avoid that, move the whole Video Redline folder (the one with video-redline.html and tools in it) "
                                            "to a plain local folder (for example "), lines[2])
        self.assertEqual(lines[3], "run the setup file there once, and start the helper from there.")
        for line in lines:
            self.assertNotIn("Windows", line)

    def test_the_warning_says_the_whole_video_redline_folder_not_the_tools_folder_alone(self):
        """Round 8 (L4): the icon that setup-autostart-windows.bat makes in the new place opens video-redline.html from the folder above
        tools, so a tools folder moved alone would leave it without a page."""
        V = self.V
        want = "move the whole Video Redline folder (the one with video-redline.html and tools in it) to a plain local folder (for example "
        for windows in (True, False):
            with mock.patch.object(V, "IS_WIN", windows):
                for lines in (V.sync_warning(self.LONG, network=False, icloud_desktop=False), V.sync_warning("C:\\x", network=True),
                              V.sync_warning("/Users/me/Documents/tools", network=False, icloud_desktop=True, home="/Users/me")):
                    self.assertIn(want, lines[2])
                    self.assertIn("(for example %s)" % V.EXAMPLE_FOLDER, lines[2])
                    self.assertNotIn("whole tools folder", " ".join(lines))
        self.assertNotIn("move the whole tools folder", read_text("vrt_server.py"))

    def test_how_to_start_it_again_in_the_hidden_helper_follows_the_autostart_file(self):
        V = self.V
        with self.win(autostart=True, background=True):
            self.assertIn("Video Redline icon", V.how_to_start_background())
            self.assertIn("Video Redline icon", V.start_again_text(short=True))
        with self.win(autostart=False, background=True):
            self.assertNotIn("icon", V.how_to_start_background())
            self.assertIn("start-helper-windows.bat", V.how_to_start_background())
            self.assertIn("start-helper-windows.bat", V.start_again_text(short=True))                  # (the same remedy as the line above it)

    def test_the_readme_removal_section_sends_a_person_who_turned_on_the_automatic_start_to_remove_autostart_first(self):
        """Round 8 (L1): the icon-first way adds a start-up setting and two icons outside the folder; deleting the folder first leaves the
        setting behind (Windows then cannot find pythonw.exe at sign-in); the host's README says the same: run the remove file first."""
        readme = read_text("README.md")
        part = readme[readme.index("## What was installed, and how to remove it"):readme.index("| Folder | What it holds | Size |")]
        self.assertNotIn("no changes to PATH or the registry", part)
        self.assertNotRegex(part, r"To remove everything, delete the folder\.")
        for want in ("`setup-windows.bat` and `setup-mac.command` do **not** touch the rest of your computer",
                     "The automatic start on Windows is the exception.", "adds one start-up setting for your Windows user",
                     "the **Video Redline** icon on your Desktop and in the Start menu", "`logs\\helper.log`",
                     "stops the helper and removes the start-up setting, the icons and the log",
                     "Windows shows a message at sign-in that it cannot find `pythonw.exe`"):
            self.assertIn(want, part)
        self.assertLess(part.index("first double-click **`remove-autostart-windows.bat`**"), part.index("Then delete the folder."))
        self.assertIn("If you never turned the automatic start on, just delete the folder.", part)

    def test_the_readme_busy_advice_is_the_one_of_the_client_and_the_panel(self):
        """Round 8 (L2): closing the other tab does not stop a transcript (a page that is closed leaves the helper busy for up to 10 minutes);
        transcriber-client.js (HELP.busy) and AUTOSTART.md say: stop-helper-windows.bat, then the icon, then Check again."""
        readme = read_text("README.md")
        self.assertNotIn("close the other Video Redline tab", readme)
        line = [l for l in readme.splitlines() if l.startswith("- **The card keeps showing")][0]
        for want in ("A page that you closed or reloaded in the middle of a transcript leaves the helper busy for up to 10 minutes",
                     "double-click **`stop-helper-windows.bat`** (or close the helper window, if you started the helper by hand)",
                     "double-click the **Video Redline** icon and click **Check again**"):
            self.assertIn(want, line)
        self.assertLess(line.index("stop-helper-windows.bat"), line.index("Video Redline** icon and click"))
        client = ""
        client_path = module_file("transcriber-client.js")
        if client_path:
            with open(client_path, "rb") as f:
                client = f.read().decode("utf-8")
        if client:                                                                   # (the same remedy as the client's own busy advice)
            busy = client[client.index("'busy': 'The helper is already making"):]
            busy = busy[:busy.index("\n")]
            self.assertIn("stop-helper-windows.bat", busy)
            self.assertIn("10 minutes", busy)

    def test_the_readme_something_else_sends_the_files_in_the_logs_folder_not_only_last_error(self):
        """Round 8 (L7): a helper that the icon or the start-up setting starts has no window, so its messages are in logs\\helper.log; the
        helper's own failure text already says 'the files in the logs folder'."""
        readme = read_text("README.md")
        line = [l for l in readme.splitlines() if l.startswith("**Something else.**")][0]
        for want in ("Send the files in the folder `logs` (inside the tools folder) to the person who invited you to the beta",
                     "`helper.log`", "`last-error.txt`, if there is one", "add a photo of it"):
            self.assertIn(want, line)
        self.assertNotIn("Send it to the person", line)
        self.assertIn("The logs folder of the tools folder may say more", read_text("vrt_server.py"))


if __name__ == "__main__":
    unittest.main()
