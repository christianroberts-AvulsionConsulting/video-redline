r"""Tests for Taste Test: the helper's /taste endpoints, the Obsidian vault that sets itself up, and the profile note in it.

Run from the tools folder:
    venv\Scripts\python.exe -m unittest discover -s tests -p "test_taste.py" -v          (Windows)
    venv/bin/python -m unittest discover -s tests -p "test_taste.py" -v                  (Mac)

Fast, standard library only, and OFFLINE: Taste Test sends nothing anywhere (a test below checks that the module has no network code
in it). Every vault, taste folder and home folder is a throw-away folder in tmp\test-scratch\ (VRT_TASTE_DIR and VRT_TASTE_HOME point
there, VRT_OBSIDIAN_CONFIG stands in for Obsidian's own list of vaults), so the real home folder and the real Obsidian are never touched.
"""
import http.client
import importlib
import json
import os
import shutil
import tempfile
import threading
import unittest
from unittest import mock

import _paths  # noqa: F401  (puts the tools folder on sys.path)
from _paths import SCRATCH

PROFILE = {
    "format": "video-redline-taste-profile/1",
    "updated": "2026-11-03T10:00:00Z",
    "lines": ["Prefers short zooms", "Likes yellow\nheadlines"],
    "settingsText": ["Zoom: 1.5x", "Cut gap: 0.3 s"],
    "rounds": [                                                    # (newest first on purpose: the note lists them newest last)
        {"id": "r2", "date": "2026-11-02T09:00:00Z", "title": "Captions", "summary": "Picked yellow", "undone": True},
        {"id": "r1", "date": "2026-11-01T09:00:00Z", "title": "Zooms", "summary": ["Picked 1.5x", "Picked a fast ease"]},
    ],
    "picks": [{"pair": "zoom-1", "chose": 1, "note": "a `tick` and ``` fence"}],
}

NOTE_TOP = """---
type: video-redline-taste
editor: Rob
channel: Test Channel
updated: 2026-11-03T10:00:00Z
---
"""
READABLE = """# Video Redline taste: Rob

- Prefers short zooms
- Likes yellow headlines

## Settings
- Zoom: 1.5x
- Cut gap: 0.3 s

## Rounds
- 2026-11-01 Zooms: Picked 1.5x; Picked a fast ease
- 2026-11-02 Captions: Picked yellow (undone)"""


def _import(name):
    return importlib.import_module(name)


class TasteBase(unittest.TestCase):
    """A helper on a spare port; every test gets its own vault, taste folder and home folder."""

    @classmethod
    def setUpClass(cls):
        cls.V = _import("vrt_server")
        cls.T = _import("vrt_taste")
        cls.origins = mock.patch.object(cls.V, "EXTRA_ORIGINS", set())
        cls.origins.start()
        cls.server = cls.V.HelperServer(("127.0.0.1", 0), cls.V.Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.origins.stop()

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="taste-", dir=SCRATCH)
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.vault = os.path.join(self.root, "My Vault")
        os.makedirs(os.path.join(self.vault, ".obsidian"))
        self.taste = os.path.join(self.root, "taste")
        self.home = os.path.join(self.root, "home")
        os.makedirs(self.home)
        self.obsidian = os.path.join(self.root, "obsidian-config", "obsidian.json")      # (not there: Obsidian is not installed)
        p = mock.patch.dict(os.environ, {"VRT_TASTE_DIR": self.taste, "VRT_TASTE_HOME": self.home, "VRT_OBSIDIAN_CONFIG": self.obsidian})
        p.start()
        self.addCleanup(p.stop)
        self.seen = []                                             # every answer's raw text (it must hold no full path)

    def ask(self, method, path, body=None, origin="null", raw=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        try:
            data = raw if raw is not None else (None if body is None else json.dumps(body).encode("utf-8"))
            h = {"Origin": origin} if origin is not None else {}
            if data is not None:
                h["Content-Type"] = "application/json"
            h.update(headers or {})
            c.request(method, path, body=data, headers=h)
            r = c.getresponse()
            text = r.read().decode("utf-8")
            self.seen.append(text)
            return r.status, (json.loads(text) if text.strip() else None), dict((k.lower(), v) for k, v in r.getheaders())
        finally:
            c.close()

    def set_up(self, editor="Rob", channel="Test Channel", **extra):
        """Set up with the vault in self.vault (the editor named it)."""
        body = {"editor": editor, "channel": channel, "vault": self.vault}
        body.update(extra)
        return self.ask("POST", "/taste/setup", body)

    def install_obsidian(self, vaults=None):
        """Obsidian's own list of vaults, as an Obsidian that has been opened before leaves it."""
        os.makedirs(os.path.dirname(self.obsidian))
        with open(self.obsidian, "w", encoding="utf-8") as f:
            json.dump({"vaults": vaults or {}, "frame": "hidden", "updateDisabled": True}, f)

    def note_file(self, name="Rob"):
        return os.path.join(self.vault, "Video Redline", "Taste", name + ".md")

    def read(self, path):
        with open(path, "r", encoding="utf-8") as f:
            return f.read()


class SetupTests(TasteBase):
    def test_nothing_is_set_up_at_first(self):
        st, d, h = self.ask("GET", "/taste")
        self.assertEqual(st, 200)
        self.assertEqual(h.get("access-control-allow-origin"), "null")
        self.assertEqual({k: d[k] for k in ("ok", "setUp", "editor", "channel", "vault", "noteExists", "profile")},
                         {"ok": True, "setUp": False, "editor": "", "channel": "", "vault": "", "noteExists": False, "profile": None})
        self.assertIn("not set up", d["problem"])
        self.assertIn("Obsidian vault sets itself up", d["problem"])

    def test_a_folder_without_an_obsidian_folder_is_refused_and_nothing_is_saved(self):
        plain = os.path.join(self.root, "Just a folder")
        os.makedirs(plain)
        st, d, _ = self.ask("POST", "/taste/setup", {"editor": "Rob", "vault": plain})
        self.assertEqual(st, 400)
        self.assertEqual(d, {"error": "not-a-vault", "message": "That folder is not an Obsidian vault: it has no .obsidian folder inside."})
        self.assertFalse(os.path.exists(self.taste))
        self.assertFalse(os.path.exists(os.path.join(self.home, ".video-redline")))

    def test_bad_set_ups_are_refused_in_plain_words(self):
        cases = [({"vault": self.vault}, "bad-editor"),
                 ({"editor": "", "vault": self.vault}, "bad-editor"),
                 ({"editor": "R" * 61, "vault": self.vault}, "bad-editor"),
                 ({"editor": "Rob\nSmith", "vault": self.vault}, "bad-editor"),
                 ({"editor": 7, "vault": self.vault}, "bad-editor"),
                 ({"editor": "Rob", "channel": "C" * 81, "vault": self.vault}, "bad-channel"),
                 ({"editor": "Rob", "vault": 7}, "bad-vault"),
                 ({"editor": "Rob", "vault": "My Vault"}, "bad-vault"),
                 ({"editor": "Rob", "vault": os.path.join(self.root, "not there")}, "no-folder")]
        for body, code in cases:
            st, d, _ = self.ask("POST", "/taste/setup", body)
            self.assertEqual((st, d["error"]), (400, code), body)
            self.assertTrue(d["message"].endswith("."), d)
        self.assertFalse(os.path.exists(os.path.join(self.taste, "config.json")))
        self.assertEqual(self.ask("POST", "/taste/setup", raw=b"not json")[0], 400)
        self.assertEqual(self.ask("POST", "/taste/setup", raw=b"[1, 2]")[0], 400)

    def test_a_name_is_all_it_takes_and_the_set_up_is_kept_privately(self):
        st, d, _ = self.set_up()
        self.assertEqual(st, 200, d)
        self.assertTrue(d["setUp"])
        self.assertNotIn("problem", d)
        self.assertEqual((d["editor"], d["channel"], d["vault"]), ("Rob", "Test Channel", "My Vault"))
        self.assertEqual(d["result"], {"vault": {"created": False, "message": "Using the Obsidian vault “My Vault”."}})
        with open(os.path.join(self.taste, "config.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f), {"editor": "Rob", "channel": "Test Channel", "vault": self.vault})
        if os.name != "nt":
            self.assertEqual(os.stat(os.path.join(self.taste, "config.json")).st_mode & 0o777, 0o600)
            self.assertEqual(os.stat(self.taste).st_mode & 0o777, 0o700)
        st, d, _ = self.ask("POST", "/taste/profile", {"profile": PROFILE})          # the picks reach the vault
        self.assertEqual(st, 200, d)
        self.assertIn("- Prefers short zooms\n", self.read(self.note_file()))
        self.ask("GET", "/taste")
        self.ask("POST", "/taste/setup", {"editor": "Rob", "vault": self.root})          # an error answer
        self.assertEqual(os.listdir(self.taste), ["config.json"])                       # (no temporary file left)

    def test_the_pointer_for_claudes_tools_says_where_the_note_is(self):
        self.set_up(editor="Rob")
        with open(os.path.join(self.home, ".video-redline", "taste.json"), encoding="utf-8") as f:
            pointer = json.load(f)
        self.assertEqual(pointer, {"editor": "Rob", "channel": "Test Channel", "vault": self.vault, "note": self.note_file()})
        self.assertTrue(os.path.isabs(pointer["note"]))
        self.set_up(editor="Pat Lee")                              # another editor: the pointer follows
        with open(os.path.join(self.home, ".video-redline", "taste.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["note"], self.note_file("Pat Lee"))

    def test_only_the_vault_folder_name_is_given_to_the_page(self):
        st, d, _ = self.set_up()
        self.assertEqual(d["vault"], "My Vault")
        for raw in self.seen + [json.dumps(self.ask("GET", "/taste")[1])]:
            self.assertNotIn(self.root.replace("\\", "\\\\"), raw)
            self.assertNotIn(self.root, raw)

    def test_a_path_in_quotation_marks_is_accepted(self):
        st, d, _ = self.ask("POST", "/taste/setup", {"editor": "Rob", "vault": '"%s"' % self.vault})
        self.assertEqual(st, 200, d)
        self.assertTrue(d["setUp"])

    def test_a_vault_that_disappeared_is_reported(self):
        self.set_up()
        shutil.rmtree(os.path.join(self.vault, ".obsidian"))
        st, d, _ = self.ask("GET", "/taste")
        self.assertFalse(d["setUp"])
        self.assertIn("My Vault", d["problem"])
        self.assertEqual(self.ask("POST", "/taste/profile", {"profile": PROFILE})[0], 409)

    def test_nothing_is_sent_anywhere(self):
        """The module has no network code, mentions no outside service, and an old page that still sends a key changes nothing."""
        with open(self.T.__file__.replace(".pyc", ".py"), encoding="utf-8") as f:
            source = f.read().lower()
        for word in ("pinecone", "urllib", "http.client", "socket", "urlopen", "api-key"):
            self.assertNotIn(word, source, word)
        for name in ("http_call", "send_to_pinecone", "connect_pinecone", "load_key", "editor_slug"):
            self.assertFalse(hasattr(self.T, name), name)
        old_key = "pcsk_TEST_ONLY_" + "k3y" * 12
        st, d, _ = self.set_up(pineconeKey=old_key)
        self.assertEqual(st, 200, d)
        self.assertNotIn("pinecone", d)
        self.assertNotIn("pinecone", d["result"])
        self.assertEqual(os.listdir(self.taste), ["config.json"])
        self.assertNotIn(old_key, self.read(os.path.join(self.taste, "config.json")))
        self.assertNotIn(old_key, self.read(os.path.join(self.home, ".video-redline", "taste.json")))
        self.assertNotIn(old_key, "".join(self.seen))

    def test_a_key_file_left_by_an_older_version_is_not_touched(self):
        os.makedirs(self.taste)
        old = os.path.join(self.taste, "pinecone-key")
        with open(old, "w") as f:
            f.write("pcsk_TEST_ONLY_left_behind\n")
        self.assertTrue(self.set_up()[1]["setUp"])
        self.ask("POST", "/taste/profile", {"profile": PROFILE})
        self.assertEqual(self.read(old), "pcsk_TEST_ONLY_left_behind\n")
        self.assertNotIn("pcsk_TEST_ONLY_left_behind", self.read(self.note_file()))
        self.assertNotIn("pcsk_TEST_ONLY_left_behind", "".join(self.seen))


class ProfileTests(TasteBase):
    def test_a_profile_is_written_and_read_back(self):
        self.set_up()
        st, d, _ = self.ask("POST", "/taste/profile", {"profile": PROFILE})
        self.assertEqual(st, 200, d)
        self.assertEqual(d, {"ok": True, "note": "My Vault/Video Redline/Taste/Rob.md"})
        st, d, _ = self.ask("GET", "/taste")
        self.assertTrue(d["setUp"])
        self.assertTrue(d["noteExists"])
        self.assertEqual(d["profile"], PROFILE)

    def test_the_note_has_the_promised_layout(self):
        self.set_up()
        self.ask("POST", "/taste/profile", {"profile": PROFILE})
        text = self.read(self.note_file())
        data = json.dumps(PROFILE, ensure_ascii=False, indent=2).replace("`", "\\u0060")
        self.assertEqual(text, NOTE_TOP + READABLE + "\n\n## Data\nWritten by Video Redline, which rewrites this note every time picks are "
                         "saved: change your taste in the Taste tab, not here. The block below is what Redline and Claude read.\n\n```json\n" + data + "\n```\n")
        self.assertEqual(text.count("```"), 2)                     # the ``` inside the profile cannot end the block early

    def test_an_empty_profile_says_no_picks_yet_and_the_time_is_filled_in(self):
        self.set_up()
        st, d, _ = self.ask("POST", "/taste/profile", {"profile": {"format": "video-redline-taste-profile/1"}})
        self.assertEqual(st, 200, d)
        text = self.read(self.note_file())
        self.assertIn("# Video Redline taste: Rob\n\nNo picks yet.\n\n## Settings\n\n## Rounds\n\n## Data\n", text)
        self.assertRegex(text, r"\nupdated: 20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\n")

    def test_names_that_need_quotation_marks_get_them(self):
        self.set_up(editor="Rob: the #1", channel="")
        self.ask("POST", "/taste/profile", {"profile": PROFILE})
        text = self.read(self.note_file("Rob- the -1"))
        self.assertIn('\neditor: "Rob: the #1"\nchannel: ""\n', text)
        self.assertIn("\n# Video Redline taste: Rob: the #1\n", text)

    def test_the_editor_name_cannot_lead_the_note_out_of_its_folder(self):
        for editor in ("../../evil", "..\\..\\evil", "CON", "a/b:c*d?e\"f<g>h|i", "   ...   x"):
            self.set_up(editor=editor)
            st, d, _ = self.ask("POST", "/taste/profile", {"profile": PROFILE})
            self.assertEqual(st, 200, (editor, d))
            folder = os.path.join(self.vault, "Video Redline", "Taste")
            name = d["note"].split("/")[-1]
            self.assertEqual(d["note"], "My Vault/Video Redline/Taste/" + name)
            self.assertTrue(os.path.isfile(os.path.join(folder, name)), (editor, name))
            self.assertNotIn("/", name[:-3])
            self.assertNotIn("\\", name)
            self.assertFalse(name.startswith("."), name)
        self.assertFalse(os.path.exists(os.path.join(self.root, "evil.md")))
        self.assertIn("Editor CON.md", os.listdir(folder))

    def test_bad_profiles_are_refused(self):
        self.set_up()
        bad = [{}, {"profile": "x"}, {"profile": {"format": "something-else/1"}},
               {"profile": {"format": "video-redline-taste-profile/1", "lines": "not a list"}},
               {"profile": {"format": "video-redline-taste-profile/1", "settingsText": [1, 2]}},
               {"profile": {"format": "video-redline-taste-profile/1", "rounds": {"r1": {}}}}]
        for body in bad:
            st, d, _ = self.ask("POST", "/taste/profile", body)
            self.assertEqual((st, d["error"]), (400, "bad-profile"), body)
        self.assertFalse(os.path.exists(self.note_file()))
        big = json.dumps({"profile": dict(PROFILE, padding="x" * (2 * 1024 * 1024))}).encode()
        self.assertEqual(self.ask("POST", "/taste/profile", raw=big)[0], 413)

    def test_a_profile_before_any_set_up_is_refused(self):
        st, d, _ = self.ask("POST", "/taste/profile", {"profile": PROFILE})
        self.assertEqual((st, d["error"]), (409, "not-set-up"))

    def test_a_request_without_a_length_is_refused(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        try:
            c.putrequest("POST", "/taste/profile")
            c.putheader("Origin", "null")
            c.putheader("Transfer-Encoding", "chunked")
            c.endheaders()
            c.send(b"0\r\n\r\n")
            r = c.getresponse()
            self.assertEqual(r.status, 411)
            r.read()
        finally:
            c.close()

    def test_a_missing_or_broken_data_block_reads_as_no_profile(self):
        self.set_up()
        os.makedirs(os.path.dirname(self.note_file()))
        for text in ("# Just my own notes\n", "```json\n{ not json\n```\n", "```json\n[1, 2]\n```\n"):
            with open(self.note_file(), "w", encoding="utf-8") as f:
                f.write(text)
            st, d, _ = self.ask("GET", "/taste")
            self.assertEqual((st, d["noteExists"], d["profile"]), (200, True, None), text)
        with open(self.note_file(), "w", encoding="utf-8", newline="\r\n") as f:     # (the last block counts; Windows line ends too)
            f.write('```json\n{"format": "old"}\n```\n\nmore\n\n```json\n{"format": "new"}\n```\n')
        self.assertEqual(self.ask("GET", "/taste")[1]["profile"], {"format": "new"})

    def test_the_note_is_replaced_in_one_step(self):
        self.set_up()
        self.assertEqual(self.ask("POST", "/taste/profile", {"profile": PROFILE})[0], 200)
        before = self.read(self.note_file())
        folder = os.path.dirname(self.note_file())
        real_replace = os.replace
        renames = []

        def replace(src, dst):
            renames.append((src, dst))
            if str(dst).endswith(".md"):
                raise OSError("disk went away")
            return real_replace(src, dst)

        with mock.patch.object(self.T.os, "replace", side_effect=replace):
            st, d, _ = self.ask("POST", "/taste/profile", {"profile": dict(PROFILE, lines=["A newer pick"])})
        self.assertEqual((st, d["error"]), (500, "note-failed"))
        self.assertEqual(self.read(self.note_file()), before)               # the old note is untouched ...
        self.assertEqual(os.listdir(folder), ["Rob.md"])                     # ... and no half-written file is left
        src, dst = renames[0]
        self.assertEqual(os.path.dirname(src), folder)                       # the new text is written next to the note first
        self.assertTrue(os.path.basename(src).startswith(".Rob.md."), src)   # (a dot file: Obsidian does not show it)
        self.assertEqual(dst, self.note_file())
        self.assertEqual(self.ask("POST", "/taste/profile", {"profile": dict(PROFILE, lines=["A newer pick"])})[0], 200)
        self.assertIn("- A newer pick\n", self.read(self.note_file()))
        self.assertEqual(os.listdir(folder), ["Rob.md"])


class AutoSetupTests(TasteBase):
    """The Obsidian vault sets itself up: the editor types a name and nothing else."""

    def name_only(self, **extra):
        body = {"editor": "Rob", "channel": "Test Channel"}
        body.update(extra)
        return self.ask("POST", "/taste/setup", body)

    def documents(self):
        return os.path.join(self.home, "Documents")

    def made_vault(self):
        return os.path.join(self.documents(), "Video Redline Vault")

    def listed(self):
        with open(self.obsidian, encoding="utf-8") as f:
            return json.load(f)

    def test_a_name_alone_makes_a_vault_and_adds_it_to_obsidian(self):
        os.makedirs(self.documents())
        theirs = {"path": os.path.join(self.root, "Other vault"), "ts": 1700000000000, "open": True}
        self.install_obsidian({"abc123abc123abc1": theirs})
        st, d, _ = self.name_only()
        self.assertEqual(st, 200, d)
        self.assertTrue(d["setUp"])
        self.assertEqual(d["vault"], "Video Redline Vault")
        self.assertTrue(os.path.isdir(os.path.join(self.made_vault(), ".obsidian")))
        self.assertEqual(d["result"], {"vault": {"created": True, "message":
                         "Made the Obsidian vault “Video Redline Vault” in your Documents folder. It is in Obsidian's list of vaults "
                         "now (if Obsidian is open, close and reopen it to see it)."}})
        data = self.listed()
        self.assertEqual((data["frame"], data["updateDisabled"]), ("hidden", True))              # the rest of the file is as it was
        self.assertEqual(data["vaults"]["abc123abc123abc1"], theirs)
        added = [(k, v) for k, v in data["vaults"].items() if k != "abc123abc123abc1"]
        self.assertEqual(len(added), 1)
        self.assertRegex(added[0][0], r"^[0-9a-f]{16}$")
        self.assertEqual(added[0][1]["path"], self.made_vault())
        self.assertIsInstance(added[0][1]["ts"], int)
        self.assertNotIn("open", added[0][1])
        self.assertEqual(self.ask("POST", "/taste/profile", {"profile": PROFILE})[0], 200)       # and the picks go into it
        self.assertTrue(os.path.isfile(os.path.join(self.made_vault(), "Video Redline", "Taste", "Rob.md")))
        for raw in self.seen:
            self.assertNotIn(self.root, raw)                                  # (only words for places, never a full path)

    def test_setting_up_again_keeps_the_vault_and_lists_it_once(self):
        os.makedirs(self.documents())
        self.install_obsidian()
        self.name_only()
        st, d, _ = self.name_only(channel="Another Channel")
        self.assertEqual((st, d["channel"], d["vault"]), (200, "Another Channel", "Video Redline Vault"))
        self.assertEqual(d["result"]["vault"], {"created": False, "message": "Using the Obsidian vault “Video Redline Vault”."})
        self.assertEqual(len(self.listed()["vaults"]), 1)
        self.assertEqual(os.listdir(self.documents()), ["Video Redline Vault"])

    def test_obsidian_that_is_not_installed_yet_is_told_how_to_open_the_vault(self):
        st, d, _ = self.name_only()
        self.assertEqual(st, 200, d)
        self.assertTrue(d["setUp"])
        self.assertIn("obsidian.md", d["result"]["vault"]["message"])
        self.assertIn("Open folder as vault", d["result"]["vault"]["message"])
        self.assertTrue(os.path.isdir(os.path.join(self.home, "Video Redline Vault", ".obsidian")))     # (no Documents folder here)
        self.assertIn("in your user folder", d["result"]["vault"]["message"])
        self.assertFalse(os.path.exists(os.path.dirname(self.obsidian)))          # Obsidian's folder is not made for it

    def test_an_obsidian_list_that_cannot_be_read_is_left_alone(self):
        for text in ("{ not json", '{"vaults": [1, 2]}', "[1, 2]"):
            os.makedirs(os.path.dirname(self.obsidian), exist_ok=True)
            with open(self.obsidian, "w", encoding="utf-8") as f:
                f.write(text)
            shutil.rmtree(os.path.join(self.home, "Video Redline Vault"), ignore_errors=True)
            st, d, _ = self.name_only()
            self.assertEqual(st, 200, text)
            self.assertTrue(d["setUp"])
            self.assertIn("could not be added to Obsidian's list", d["result"]["vault"]["message"])
            self.assertEqual(self.read(self.obsidian), text)

    def test_a_folder_of_the_editors_own_with_that_name_is_not_taken_over(self):
        mine = self.made_vault()
        os.makedirs(mine)
        with open(os.path.join(mine, "taxes.docx"), "w") as f:
            f.write("mine")
        st, d, _ = self.name_only()
        self.assertEqual((st, d["vault"]), (200, "Video Redline Vault 2"))
        self.assertEqual(os.listdir(mine), ["taxes.docx"])                      # no .obsidian folder put into it
        self.assertTrue(os.path.isdir(os.path.join(self.documents(), "Video Redline Vault 2", ".obsidian")))

    def test_an_empty_folder_of_that_name_becomes_the_vault(self):
        os.makedirs(self.made_vault())
        st, d, _ = self.name_only()
        self.assertEqual((st, d["vault"]), (200, "Video Redline Vault"))
        self.assertTrue(os.path.isdir(os.path.join(self.made_vault(), ".obsidian")))

    def test_a_vault_the_editor_names_is_used_as_it_is_and_obsidian_is_left_alone(self):
        self.install_obsidian()
        before = self.read(self.obsidian)
        st, d, _ = self.set_up()
        self.assertEqual(d["vault"], "My Vault")
        self.assertEqual(d["result"]["vault"]["created"], False)
        self.assertEqual(self.read(self.obsidian), before)
        self.assertFalse(os.path.exists(self.documents()))
        self.assertFalse(os.path.exists(os.path.join(self.home, "Video Redline Vault")))

    def test_a_blank_vault_keeps_the_one_chosen_before(self):
        self.set_up()
        st, d, _ = self.name_only(vault="  ")
        self.assertEqual((st, d["vault"]), (200, "My Vault"))
        self.assertFalse(os.path.exists(os.path.join(self.home, "Video Redline Vault")))

    def test_a_vault_that_vanished_is_made_again(self):
        self.set_up()
        shutil.rmtree(os.path.join(self.vault, ".obsidian"))
        self.assertFalse(self.ask("GET", "/taste")[1]["setUp"])
        st, d, _ = self.name_only()
        self.assertEqual((st, d["setUp"], d["vault"]), (200, True, "Video Redline Vault"))

    def test_a_vault_that_cannot_be_made_is_reported_and_nothing_is_saved(self):
        real = os.makedirs

        def refuse(path, *a, **k):
            if "Video Redline Vault" in str(path):
                raise OSError("read-only")
            return real(path, *a, **k)
        with mock.patch.object(self.T.os, "makedirs", side_effect=refuse):
            st, d, _ = self.name_only()
        self.assertEqual((st, d["error"]), (500, "vault-failed"))
        self.assertIn("paste the full path of a vault you already have", d["message"])
        self.assertFalse(os.path.exists(os.path.join(self.taste, "config.json")))


class HttpTests(TasteBase):
    def test_methods_addresses_and_origins_are_checked(self):
        self.assertEqual(self.ask("DELETE", "/taste")[0], 405)
        self.assertEqual(self.ask("POST", "/taste", {})[0], 405)
        self.assertEqual(self.ask("GET", "/taste/setup")[0], 405)
        self.assertEqual(self.ask("GET", "/taste/profile")[0], 405)
        self.assertEqual(self.ask("GET", "/taste/nothing")[0], 404)
        self.assertEqual(self.ask("GET", "/taste", origin="https://example.com")[0], 403)
        st, d, _ = self.ask("POST", "/taste/setup", {"editor": "Rob", "vault": self.vault}, origin="https://example.com")
        self.assertEqual((st, d["error"]), (403, "bad-origin"))
        self.assertFalse(os.path.exists(self.taste))
        self.assertEqual(self.ask("GET", "/taste", headers={"Host": "evil.example.com"})[0], 403)

    def test_the_page_may_send_json_to_these_addresses(self):
        st, _, h = self.ask("OPTIONS", "/taste/profile", headers={"Access-Control-Request-Method": "POST",
                                                                  "Access-Control-Request-Headers": "content-type"})
        self.assertEqual(st, 204)
        self.assertEqual(h.get("access-control-allow-origin"), "null")
        self.assertIn("POST", h.get("access-control-allow-methods", ""))
        self.assertIn("content-type", h.get("access-control-allow-headers", "").lower())


if __name__ == "__main__":
    unittest.main()
