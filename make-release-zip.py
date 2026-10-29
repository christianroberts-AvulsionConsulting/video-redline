#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Make the release ZIP of Video Redline (for the maintainer; the ZIP itself does not contain this file).

    python make-release-zip.py            writes dist/video-redline-<VERSION>.zip
    python make-release-zip.py --check P  only checks an existing ZIP (P) with the same rules

Why a script and not GitHub's own "Source code (zip)": the ZIP has to hold exactly the files a person needs and nothing
else, with the right line endings (a .bat file with bare LF line endings can fail in odd ways, a .command file with CR
breaks "#!/bin/bash"), forward slashes in the entry names (some Windows tools write backslashes, which Mac and Linux
read as part of the file name) and the "executable" mark on the Mac scripts.

The ZIP is FLAT: no folder around the files. "Extract All..." on Windows and a double-click on a Mac then make one new
folder named like the ZIP, with video-redline.html and tools inside it, which is what README.md and the set-up files say.

Build it from a clean copy of the repository, never from a folder on which set-up has been run (see DEVELOPERS.md).
Only the standard library of Python 3.8 or newer is used.
"""
import argparse
import os
import shutil
import subprocess
import sys
import time
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))

# Files outside tools/ that go into the ZIP.
TOP_FILES = [
    "video-redline.html",
    "README.md",
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
    "src/vendor/NOTICE-open-design.txt",     # the Apache-2.0 notice of the style presets (a copy is also inside the page)
    "sessions/README.txt",                   # makes the empty "sessions" folder exist after the download (File, Save session keeps its files there)
]
TOOLS_DIR = "tools"

# Under tools/: folders and files that are never handed out.
SKIP_DIRS = {"python", "venv", "uv", "uv-cache", "hf-cache", "tmp", "dev", "logs", "__pycache__", "tests", ".git"}
SKIP_NAMES = {".gitignore", ".gitattributes", ".DS_Store", "Thumbs.db"}
SKIP_SUFFIXES = (".pyc", ".ico", ".log", "-transcript.json")

# Line endings by file type. Everything else keeps LF.
CRLF_SUFFIXES = (".bat", ".cmd")
ASCII_ONLY_SUFFIXES = (".bat", ".cmd", ".command", ".py", ".pyw", ".sh")
EXEC_SUFFIXES = (".command", ".sh")

FORBIDDEN_SUFFIXES = (".onnx", ".bin", ".dll", ".exe", ".pyd", ".so", ".dylib", ".whl", ".mp4", ".mov", ".wav", ".mp3")
MAX_FILE_BYTES = 3 * 1024 * 1024
MAX_TOTAL_BYTES = 6 * 1024 * 1024
MUST_HAVE = ["video-redline.html", "README.md", "LICENSE", "THIRD-PARTY-NOTICES.md", "src/vendor/NOTICE-open-design.txt", "sessions/README.txt",
             "tools/setup-windows.bat", "tools/setup-autostart-windows.bat", "tools/add-desktop-icon-windows.bat",
             "tools/stop-helper-windows.bat", "tools/remove-autostart-windows.bat", "tools/start-helper-windows.bat",
             "tools/helper_launcher.pyw", "tools/open_video_review.pyw", "tools/vrt_server.py", "tools/transcribe.py",
             "tools/requirements.txt", "tools/AUTOSTART.md", "tools/README.md", "tools/setup-mac.command",
             "tools/start-helper-mac.command"]


def die(message):
    print("PROBLEM: " + message, file=sys.stderr)
    sys.exit(1)


def read_version():
    path = os.path.join(ROOT, "VERSION")
    if not os.path.isfile(path):
        die("the file VERSION is missing")
    with open(path, encoding="ascii") as f:
        version = f.read().strip()
    if not version or any(c not in "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.+-" for c in version):
        die("VERSION must hold one version such as 0.1.0-beta (found %r)" % version)
    return version


def collect():
    """Return the list of repository-relative paths (forward slashes) that go into the ZIP, sorted."""
    names = list(TOP_FILES)
    tools_root = os.path.join(ROOT, TOOLS_DIR)
    if not os.path.isdir(tools_root):
        die("the folder tools is missing")
    for folder, dirs, files in os.walk(tools_root):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for name in sorted(files):
            if name in SKIP_NAMES or name.endswith(SKIP_SUFFIXES):
                continue
            rel = os.path.relpath(os.path.join(folder, name), ROOT).replace(os.sep, "/")
            names.append(rel)
    return sorted(set(names))


def normalise(rel, data):
    """Line endings for one file: CRLF for batch files, LF for everything else (text files only)."""
    if b"\x00" in data:
        die("%s looks binary; this ZIP holds text files only" % rel)
    text = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    if rel.lower().endswith(CRLF_SUFFIXES):
        text = text.replace(b"\n", b"\r\n")
    return text


def check_entries(entries):
    """entries: dict name -> bytes. Dies with a clear sentence at the first rule that is broken."""
    total = 0
    for name, data in sorted(entries.items()):
        low = name.lower()
        if "\\" in name or name.startswith("/") or ".." in name.split("/"):
            die("bad entry name %r (use forward slashes, no leading slash, no ..)" % name)
        if low.endswith(FORBIDDEN_SUFFIXES):
            die("%s must not be in the ZIP (a program, a model or a media file)" % name)
        for part in name.split("/")[:-1]:
            if part in ("venv", "python", "uv", "uv-cache", "hf-cache", "tmp", "dev", "logs", "__pycache__", "tests", ".git"):
                die("%s is inside a folder (%s) that must not be in the ZIP" % (name, part))
        if len(data) > MAX_FILE_BYTES:
            die("%s is %d bytes: too big for this ZIP" % (name, len(data)))
        total += len(data)
        if low.endswith(ASCII_ONLY_SUFFIXES):
            bad = [i for i, b in enumerate(data) if b > 127]
            if bad:
                die("%s holds a non-ASCII byte (at offset %d); script files must be plain ASCII" % (name, bad[0]))
        if low.endswith(CRLF_SUFFIXES):
            if data.count(b"\n") != data.count(b"\r\n") or data.count(b"\r") != data.count(b"\r\n"):
                die("%s must have Windows line endings (CRLF) on every line" % name)
        else:
            if b"\r" in data:
                die("%s must have LF line endings only" % name)
        if low.endswith(".command") and not data.startswith(b"#!/bin/bash"):
            die("%s must start with #!/bin/bash" % name)
    if total > MAX_TOTAL_BYTES:
        die("the files add up to %d bytes: more than expected for a ZIP without the speech tools" % total)
    for name in MUST_HAVE:
        if name not in entries:
            die("%s is missing from the ZIP" % name)
    return total


def check_page_is_current():
    """video-redline.html is built from src/ by "node build.js". A page that is older than its sources must not be handed out."""
    node = shutil.which("node")
    if not node:
        print("WARNING: Node.js was not found, so I could not check that video-redline.html is up to date with src/ (node build.js --check).")
        return
    result = subprocess.run([node, os.path.join(ROOT, "build.js"), "--check"], cwd=ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        die((result.stderr or result.stdout).strip() or "video-redline.html is not up to date with src/ (run: node build.js)")
    print(result.stdout.strip())


def build(out_dir):
    version = read_version()
    check_page_is_current()
    entries = {}
    for rel in collect():
        path = os.path.join(ROOT, *rel.split("/"))
        if not os.path.isfile(path):
            die("%s is missing in the repository" % rel)
        with open(path, "rb") as f:
            entries[rel] = normalise(rel, f.read())
    total = check_entries(entries)
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "video-redline-%s.zip" % version)
    stamp = time.localtime()[:6]
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name in sorted(entries):
            info = zipfile.ZipInfo(name, date_time=stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3                                     # "Unix": needed for the permission bits below
            mode = 0o755 if name.lower().endswith(EXEC_SUFFIXES) else 0o644
            info.external_attr = (0o100000 | mode) << 16
            z.writestr(info, entries[name])
    print("wrote %s: %d files, %d bytes of text, %d bytes zipped" % (out, len(entries), total, os.path.getsize(out)))
    check_zip(out)
    return out


def check_zip(path):
    """Open a finished ZIP and apply the same rules to what is really inside it."""
    with zipfile.ZipFile(path) as z:
        bad = z.testzip()
        if bad:
            die("%s is damaged inside the ZIP" % bad)
        entries = {}
        for info in z.infolist():
            if info.is_dir():
                die("the ZIP holds a folder entry (%s); it should hold files only" % info.filename)
            entries[info.filename] = z.read(info)
            if info.filename.lower().endswith(EXEC_SUFFIXES) and not (info.external_attr >> 16) & 0o111:
                die("%s has no executable mark" % info.filename)
    total = check_entries(entries)
    print("checked %s: %d files, %d bytes, all rules passed" % (os.path.basename(path), len(entries), total))


def main():
    ap = argparse.ArgumentParser(description="Make (or check) the Video Redline release ZIP.")
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"), help="folder for the ZIP (default: dist)")
    ap.add_argument("--check", metavar="ZIP", help="only check this ZIP")
    args = ap.parse_args()
    if args.check:
        check_zip(args.check)
    else:
        build(args.out)


if __name__ == "__main__":
    main()
