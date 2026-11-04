"""Taste Test: where an editor's taste profile is kept, in their own Obsidian vault.

Why it exists. The Taste Test tab of the Video Redline page asks an editor short "version 1 or 2?" questions, and the answers become
that editor's taste profile. The profile belongs to the editor, so it is kept in THEIR Obsidian vault: a note they can read and edit,
and that Claude's other tools read. Nothing leaves the computer.

Setting up. Setting up needs only the editor's name. The Obsidian vault sets itself up: no vault folder given -> the helper makes a
vault ("Video Redline Vault" in Documents: a folder with a .obsidian folder in it) and adds it to Obsidian's own list of vaults
(obsidian.json) so it shows in Obsidian's vault switcher. Setting up again keeps the vault. A vault the editor names is used as it is.

What is stored where
    <tools folder>/taste/config.json        the editor's name, the channel and the vault folder
                                            (VRT_TASTE_DIR moves the whole taste folder; that is for tests.)
    ~/.video-redline/taste.json             where the active editor's note is, for Claude's other tools
                                            (VRT_TASTE_HOME stands in for the home folder; that is for tests)
    <vault>/Video Redline/Taste/<editor>.md the profile note: the readable part on top, the data block (JSON) at the end

Only the Python standard library is used (the helper's Python may not have anything more).
"""
from __future__ import annotations

import json
import os
import re
import secrets
import sys
import tempfile
import threading
import time
import unicodedata

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
IS_WIN = os.name == "nt"

FORMAT = "video-redline-taste-profile/1"
MAX_EDITOR = 60
MAX_CHANNEL = 80
MAX_PATH = 1000
MAX_NOTE_READ = 8 * 1024 * 1024                    # a note larger than this is not read back
NOTE_FOLDER = ("Video Redline", "Taste")
VAULT_NAME = "Video Redline Vault"                  # the vault made for an editor who has none (in Documents)

LOCK = threading.Lock()                            # one change to the set-up or to a note at a time

CONTROL = re.compile(r"[\x00-\x1f\x7f]")
BAD_FILE_CHARS = re.compile(r'[\\/:*?"<>|#^\[\]\x00-\x1f\x7f]')     # not allowed in a Windows file name or an Obsidian link
RESERVED_NAMES = {"con", "prn", "aux", "nul"} | {"com%d" % i for i in range(1, 10)} | {"lpt%d" % i for i in range(1, 10)}
ISO_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9:.]+(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?")
PLAIN_YAML = re.compile(r"[A-Za-z][A-Za-z0-9 _.,'()+-]*")
YAML_WORDS = {"true", "false", "yes", "no", "on", "off", "null", "y", "n"}
JSON_BLOCK = re.compile(r"^```json[ \t]*\r?\n(.*?)\r?\n```[ \t]*$", re.M | re.S)

NOT_SET_UP = "Taste Test is not set up yet. Type your name and press Save: the Obsidian vault sets itself up."


class TasteError(Exception):
    """A request that cannot be done, with the HTTP status, a short code and a plain-language message for the page."""

    def __init__(self, status, code, message):
        Exception.__init__(self, message)
        self.status, self.code, self.message = status, code, message


# ---- where things are kept ---------------------------------------------------------------------------------------------------
def taste_dir():
    return os.environ.get("VRT_TASTE_DIR") or os.path.join(TOOLS_DIR, "taste")


def home_dir():
    return os.environ.get("VRT_TASTE_HOME") or os.path.expanduser("~")


def config_path():
    return os.path.join(taste_dir(), "config.json")


def pointer_path():
    return os.path.join(home_dir(), ".video-redline", "taste.json")


def note_file_name(editor):
    """The editor's name made safe as a file name on Windows and a Mac, and as an Obsidian link (without .md)."""
    name = BAD_FILE_CHARS.sub("-", editor)
    name = re.sub(r"\s+", " ", name).strip(" .")             # Windows drops dots and spaces at the end; a dot at the start hides it
    if not name:
        name = "Editor"
    if name.split(".")[0].strip().lower() in RESERVED_NAMES:  # CON, NUL, COM1 ... cannot be file names on Windows
        name = "Editor " + name
    return name[:80]


def note_path(cfg):
    return os.path.join(cfg["vault"], *(NOTE_FOLDER + (note_file_name(cfg["editor"]) + ".md",)))


def vault_name(vault):
    if not vault:
        return ""
    return os.path.basename(os.path.normpath(vault)) or vault


def note_label(cfg):
    """The note as the page shows it: the vault's name, then the path inside the vault (never the full path on this computer)."""
    return "/".join((vault_name(cfg["vault"]),) + NOTE_FOLDER + (note_file_name(cfg["editor"]) + ".md",))


def is_vault(folder):
    try:
        return bool(folder) and os.path.isdir(folder) and os.path.isdir(os.path.join(folder, ".obsidian"))
    except (OSError, ValueError):
        return False


# ---- Obsidian sets itself up ---------------------------------------------------------------------------------------------------
def vault_parent():
    """Where a new vault is made: the Documents folder when there is one, else the home folder."""
    docs = os.path.join(home_dir(), "Documents")
    return docs if os.path.isdir(docs) else home_dir()


def where(folder):
    """A folder in words for the page, never its full path."""
    return "your Documents folder" if os.path.basename(os.path.normpath(folder)) == "Documents" else "your user folder"


def make_vault():
    """(path, True) of a vault just made, or (path, False) of one made by an earlier set-up. An Obsidian vault is any folder with a
    .obsidian folder in it, so that is all that is made. A folder of that name that already holds the editor's own files is left
    alone and the next free name is used."""
    parent = vault_parent()
    for n in range(1, 50):
        path = os.path.join(parent, VAULT_NAME if n == 1 else "%s %d" % (VAULT_NAME, n))
        try:
            if is_vault(path):
                return path, False
            if os.path.exists(path) and not (os.path.isdir(path) and not os.listdir(path)):
                continue
            os.makedirs(os.path.join(path, ".obsidian"), exist_ok=True)
        except OSError:
            break
        return path, True
    raise TasteError(500, "vault-failed", "Video Redline could not make an Obsidian vault in %s. Check that the folder is not "
                                          "read-only, or paste the full path of a vault you already have." % where(parent))


def obsidian_config_path():
    """Obsidian's own list of vaults (obsidian.json). VRT_OBSIDIAN_CONFIG stands in for it; that is for tests."""
    if os.environ.get("VRT_OBSIDIAN_CONFIG"):
        return os.environ["VRT_OBSIDIAN_CONFIG"]
    if IS_WIN:
        base = os.environ.get("APPDATA") or os.path.join(home_dir(), "AppData", "Roaming")
    elif sys.platform == "darwin":
        base = os.path.join(home_dir(), "Library", "Application Support")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home_dir(), ".config")
    return os.path.join(base, "obsidian", "obsidian.json")


def register_with_obsidian(vault):
    """Adds the vault to Obsidian's list of vaults so it shows in Obsidian's vault switcher. Nothing else in that file is changed.
    Returns "added", "already", "no-obsidian" (the file is not there: Obsidian is not installed, or has never been opened) or
    "failed". Never raises."""
    path = obsidian_config_path()
    try:
        if not os.path.isfile(path):
            return "no-obsidian"
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        vaults = data.get("vaults", {}) if isinstance(data, dict) else None
        if not isinstance(vaults, dict):
            return "failed"
        same = os.path.normcase(os.path.normpath(vault))
        for v in vaults.values():
            if isinstance(v, dict) and isinstance(v.get("path"), str) and os.path.normcase(os.path.normpath(v["path"])) == same:
                return "already"
        vid = secrets.token_hex(8)                                          # (Obsidian's own ids are 16 hex digits)
        while vid in vaults:
            vid = secrets.token_hex(8)
        vaults[vid] = {"path": vault, "ts": int(time.time() * 1000)}
        data["vaults"] = vaults
        write_atomic(path, _json_bytes(data, pretty=False))
        return "added"
    except (OSError, ValueError):
        return "failed"


def vault_message(vault, created, registered):
    name = "“%s”" % vault_name(vault)
    if not created:
        return "Using the Obsidian vault %s." % name + (" It is now in Obsidian's list of vaults." if registered == "added" else "")
    made = "Made the Obsidian vault %s in %s." % (name, where(os.path.dirname(vault)))
    if registered == "added":
        return made + " It is in Obsidian's list of vaults now (if Obsidian is open, close and reopen it to see it)."
    if registered == "no-obsidian":
        return made + (" Obsidian is not set up on this computer yet: install it from obsidian.md, choose Open folder as vault and "
                       "pick that folder. Your notes are saved there already.")
    if registered == "failed":
        return made + " It could not be added to Obsidian's list, so in Obsidian choose Open folder as vault and pick it."
    return made


# ---- files ---------------------------------------------------------------------------------------------------------------------
def make_private_dir(path):
    """A folder only the current user can enter (mode 0700 where the operating system has such modes)."""
    os.makedirs(path, mode=0o700, exist_ok=True)
    if not IS_WIN:
        try:
            os.chmod(path, 0o700)
        except OSError:
            pass


def write_atomic(path, data, private=False):
    """Write the whole file or nothing: a temporary file next to it first, then one rename over the old one. Obsidian (or anything
    else that reads the file) sees either the old note or the new one, never half of one. The temporary name starts with a dot, so
    Obsidian does not show it."""
    folder = os.path.dirname(path)
    mode = 0o600 if private else 0o644
    if not private:
        try:
            mode = os.stat(path).st_mode & 0o777            # a note that is already there keeps its permissions
        except OSError:
            pass
    fd, tmp = tempfile.mkstemp(prefix="." + os.path.basename(path) + ".", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if private or not IS_WIN:
            os.chmod(tmp, mode)
        for attempt in range(10):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:                          # Windows: a virus scanner or a sync program has the old file open
                if attempt == 9:
                    raise
                time.sleep(0.1)
        if private:
            os.chmod(path, 0o600)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _json_bytes(obj, pretty=True):
    return (json.dumps(obj, ensure_ascii=False, indent=2 if pretty else None) + "\n").encode("utf-8")


def load_config():
    """The saved set-up as {editor, channel, vault}, or {} when there is none (or it is damaged)."""
    try:
        with open(config_path(), "r", encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return {}
    if not isinstance(d, dict):
        return {}
    editor, channel, vault = d.get("editor"), d.get("channel", ""), d.get("vault")
    if not (isinstance(editor, str) and editor and isinstance(vault, str) and vault and isinstance(channel, str)):
        return {}
    return {"editor": editor, "channel": channel, "vault": vault}


def write_pointer(cfg):
    """~/.video-redline/taste.json: which editor is active and where their note is, for Claude's other tools."""
    path = pointer_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    write_atomic(path, _json_bytes({"editor": cfg["editor"], "channel": cfg["channel"], "vault": cfg["vault"],
                                    "note": os.path.abspath(note_path(cfg))}))


def read_profile(path):
    """The profile in the last ```json block of the note, or None when there is no such block or it cannot be read."""
    try:
        if os.path.getsize(path) > MAX_NOTE_READ:
            return None
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return None
    blocks = JSON_BLOCK.findall(text)
    if not blocks:
        return None
    try:
        d = json.loads(blocks[-1])
    except ValueError:
        return None
    return d if isinstance(d, dict) else None


# ---- checking what the page sent ------------------------------------------------------------------------------------------------
def _text_field(value, low, high, code, message):
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise TasteError(400, code, message)
    value = unicodedata.normalize("NFC", value).strip()
    if not low <= len(value) <= high:
        raise TasteError(400, code, message)
    if CONTROL.search(value):
        raise TasteError(400, code, "Names cannot have line breaks or tabs in them.")
    return value


def clean_vault(value):
    if not isinstance(value, str) or not value.strip():
        raise TasteError(400, "bad-vault", "Paste the full path of the folder that holds your Obsidian vault.")
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":          # "Copy as path" on Windows adds quotation marks
        value = value[1:-1].strip()
    value = os.path.expanduser(value)
    if len(value) > MAX_PATH or CONTROL.search(value):
        raise TasteError(400, "bad-vault", "That folder path cannot be right. Paste the full path of your Obsidian vault folder.")
    if not os.path.isabs(value):
        raise TasteError(400, "bad-vault", "That is not a full folder path. Paste the whole path of your Obsidian vault folder, "
                                           "starting with the drive letter on Windows or with / on a Mac.")
    value = os.path.normpath(value)
    try:
        found = os.path.isdir(value)
    except (OSError, ValueError):
        found = False
    if not found:
        raise TasteError(400, "no-folder", "That folder could not be found. Check the path and try again.")
    if not is_vault(value):
        raise TasteError(400, "not-a-vault", "That folder is not an Obsidian vault: it has no .obsidian folder inside.")
    return value


def clean_profile(value):
    if not isinstance(value, dict):
        raise TasteError(400, "bad-profile", "The taste profile is missing from the request.")
    if value.get("format") != FORMAT:
        raise TasteError(400, "bad-profile", "That is not a Video Redline taste profile this helper can save. Update the helper "
                                             "if the page is newer.")
    for name in ("lines", "settingsText"):
        v = value.get(name)
        if v is not None and not (isinstance(v, list) and all(isinstance(x, str) for x in v)):
            raise TasteError(400, "bad-profile", "The taste profile is damaged (%s must be a list of texts)." % name)
    if value.get("rounds") is not None and not isinstance(value.get("rounds"), list):
        raise TasteError(400, "bad-profile", "The taste profile is damaged (rounds must be a list).")
    return value


# ---- the note --------------------------------------------------------------------------------------------------------------------
def one_line(value):
    """A text as one tidy line: whitespace and line breaks become single spaces; ``` cannot open a code block in the note."""
    if isinstance(value, bool) or value is None:
        return ""
    if isinstance(value, (int, float)):
        value = str(value)
    if not isinstance(value, str):
        return ""
    return re.sub(r"`{3,}", "``", re.sub(r"\s+", " ", value)).strip()


def yaml_text(value):
    """A value for the note's properties: as it is when that is safe, else in quotation marks."""
    if value == "":
        return '""'
    if ISO_DATE.fullmatch(value):
        return value
    if PLAIN_YAML.fullmatch(value) and value.lower() not in YAML_WORDS and not value.endswith(" "):
        return value
    return json.dumps(value, ensure_ascii=False)


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def updated_of(profile):
    u = one_line(profile.get("updated"))
    return u if u and len(u) <= 64 else now_iso()


def rounds_of(profile):
    """The rounds as [{id, title, summary, date, undone}], newest last, every id plain letters, digits, dots and dashes and used once."""
    out, seen = [], set()
    raw = [r for r in (profile.get("rounds") or []) if isinstance(r, dict)]
    if raw and all(isinstance(r.get("date"), str) and r.get("date") for r in raw):
        raw = sorted(raw, key=lambda r: r["date"])                 # (stable: rounds of the same moment keep the page's order)
    for i, r in enumerate(raw, 1):
        rid = re.sub(r"[^A-Za-z0-9_.-]+", "-", one_line(r.get("id"))).strip("-")[:64] or str(i)
        base, n = rid, 2
        while rid in seen:
            rid, n = "%s-%d" % (base, n), n + 1
        seen.add(rid)
        summary = r.get("summary")
        parts = summary if isinstance(summary, list) else [summary]
        summary = "; ".join(p for p in (one_line(x) for x in parts if isinstance(x, str)) if p)
        date = one_line(r.get("date"))
        if ISO_DATE.match(date):
            date = date[:10]
        out.append({"id": rid, "title": one_line(r.get("title")) or "Round %d" % i, "summary": summary, "date": date,
                    "undone": bool(r.get("undone")) or one_line(r.get("status")).lower() == "undone"})
    return out


def render_note(cfg, profile, updated):
    """The whole note: the properties, the readable part, then the data block under "## Data"."""
    readable = ["# Video Redline taste: " + one_line(cfg["editor"]), ""]
    picks = [t for t in (one_line(x) for x in profile.get("lines") or []) if t]
    readable += ["- " + t for t in picks] or ["No picks yet."]
    readable += ["", "## Settings"]
    readable += ["- " + t for t in (one_line(x) for x in profile.get("settingsText") or []) if t]
    readable += ["", "## Rounds"]
    for r in rounds_of(profile):
        line = "- " + (r["date"] + " " if r["date"] else "") + r["title"] + (": " + r["summary"] if r["summary"] else "")
        readable.append(line + (" (undone)" if r["undone"] else ""))
    data = json.dumps(profile, ensure_ascii=False, indent=2).replace("`", "\\u0060")    # (a ` can only be inside a JSON text)
    head = ["---", "type: video-redline-taste", "editor: " + yaml_text(cfg["editor"]), "channel: " + yaml_text(cfg["channel"]),
            "updated: " + yaml_text(updated), "---"]
    tail = ["## Data", "Written by Video Redline, which rewrites this note every time picks are saved: change your taste in the Taste tab, not here. The block below is what Redline and Claude read.", "",
            "```json", data, "```"]
    return "\n".join(head + readable + [""] + tail) + "\n"


# ---- what the routes do ----------------------------------------------------------------------------------------------------------
def status():
    """GET /taste. Names the vault by its folder name only, never its full path."""
    cfg = load_config()
    out = {"ok": True, "setUp": False, "editor": cfg.get("editor", ""), "channel": cfg.get("channel", ""),
           "vault": vault_name(cfg.get("vault")), "noteExists": False, "profile": None}
    if not cfg:
        out["problem"] = NOT_SET_UP
        return out
    if not is_vault(cfg["vault"]):
        out["problem"] = ("The Obsidian vault %s can no longer be found (or it has no .obsidian folder any more). Press Save and "
                          "a new one is made, or paste the folder of a vault you have." % out["vault"])
        return out
    path = note_path(cfg)
    out["noteExists"] = os.path.isfile(path)
    if out["noteExists"]:
        out["profile"] = read_profile(path)
    out["setUp"] = True
    return out


def setup(body):
    """POST /taste/setup. Only the editor's name is needed. No vault given: the vault kept by an earlier set-up, or a new one is
    made and added to Obsidian. Answers like GET /taste, plus result: { vault: { created, message } }."""
    editor = _text_field(body.get("editor"), 1, MAX_EDITOR, "bad-editor", "Type the editor's name (1 to %d characters)." % MAX_EDITOR)
    channel = _text_field(body.get("channel"), 0, MAX_CHANNEL, "bad-channel",
                          "The channel name can be at most %d characters long." % MAX_CHANNEL)
    given = body.get("vault")
    automatic = given is None or (isinstance(given, str) and not given.strip())
    vault = None if automatic else clean_vault(given)
    with LOCK:
        created, registered = False, ""
        if automatic:
            old = load_config().get("vault")
            vault, created = (old, False) if is_vault(old) else make_vault()
        cfg = {"editor": editor, "channel": channel, "vault": vault}
        try:
            make_private_dir(taste_dir())
            write_atomic(config_path(), _json_bytes(cfg), private=True)
        except OSError:
            raise TasteError(500, "save-failed", "The helper could not save the Taste Test set-up in its tools folder. Check that the "
                                                 "tools folder is not read-only, then try again.")
        try:
            write_pointer(cfg)
        except OSError:
            raise TasteError(500, "save-failed", "The set-up was saved, but the helper could not write the small file in your user "
                                                 "folder (.video-redline/taste.json) that tells Claude where your taste note is. "
                                                 "Try again.")
        if automatic:
            registered = register_with_obsidian(vault)
    out = status()
    out["result"] = {"vault": {"created": created, "message": vault_message(vault, created, registered)}}
    return out


def save_profile(body):
    """POST /taste/profile. Writes the editor's note in the vault (the whole note is replaced) -> { ok, note }."""
    profile = clean_profile(body.get("profile"))
    with LOCK:
        cfg = load_config()
        if not cfg or not is_vault(cfg["vault"]):
            raise TasteError(409, "not-set-up", NOT_SET_UP)
        updated = updated_of(profile)
        note = render_note(cfg, profile, updated)
        path = note_path(cfg)
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            write_atomic(path, note.encode("utf-8"))
        except OSError:
            raise TasteError(500, "note-failed", "Video Redline could not write the taste note into your Obsidian vault. Check that "
                                                 "the vault folder is still there and is not read-only, then try again.")
        try:
            write_pointer(cfg)                       # (keeps Claude's pointer right even if someone deleted it)
        except OSError:
            pass
    return {"ok": True, "note": note_label(cfg)}
