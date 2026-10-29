"""Where the code under test lives (shared by the test files).

By default the tests check the code in the tools folder that contains this tests/ folder. Set the environment variable
VRT_TOOLS_DIR to another copy of the helper to run the same tests against it (that is how the tests were shown to FAIL
on the code from before the fixes). The private Python, the packages and the speech models always come from REAL.

All audio used by the tests is synthetic (generated tones and noise, or the Windows text-to-speech voice). Passing tests
prove that the code paths work; they say nothing about accuracy on real people talking.
"""
import importlib
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REAL = os.path.abspath(os.path.join(HERE, ".."))                       # the real tools folder (venv, models)
TOOLS = os.path.abspath(os.environ.get("VRT_TOOLS_DIR") or REAL)       # the code under test
AUDIO_TEST = os.path.abspath(os.path.join(REAL, "..", "..", "audio-test"))
SCRATCH = os.path.join(REAL, "tmp", "test-scratch")                   # throw-away files (tmp/ is not in version control)

os.environ.setdefault("HF_HOME", os.path.join(REAL, "hf-cache"))
os.environ.setdefault("HF_HUB_OFFLINE", "1")
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)
os.makedirs(SCRATCH, exist_ok=True)

NO_BASH = ("needs a bash that can open Windows folders (Git for Windows has one; the 'bash' app that Windows itself offers starts "
           "Linux, which cannot see them). Run the tests from Git Bash, or install Git for Windows.")
_BASH = []                                                             # [] = not looked up yet, then [path or None]


def module_file(name):
    """transcriber-client.js or cleanup-panel.js: next to the tools folder in the author's working copy, in src/vendor/ in the repository.
    The path, or None when the file is in neither place."""
    for parts in (("..", name), ("..", "src", "vendor", name)):
        path = os.path.abspath(os.path.join(REAL, *parts))
        if os.path.isfile(path):
            return path
    return None


def cloud_named(path):
    """True if the path lies in a cloud-looking place (then 'a plain folder gives no warning' cannot be tested, and
    setup-windows.bat / setup-mac.command stop at their folder question). Code from before the folder check has no list: False."""
    V = importlib.import_module("vrt_server")
    low = path.replace("\\", "/").lower()
    return any(key in low for key, _ in getattr(V, "SYNC_SERVICES", ()))


def _sees_folders(bash):
    """Can this bash open a Windows-style path such as C:/Users/...? (The WSL launcher cannot: every script then ends with
    'No such file or directory' and exit code 127, which looks like a broken Mac script.)"""
    try:
        r = subprocess.run([bash, "-c", 'test -d "$1"', "x", SCRATCH.replace("\\", "/")], stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return False
    return r.returncode == 0


def find_bash():
    """The bash that the Mac-script tests run the scripts with, or None (then those tests skip with NO_BASH).

    Not simply shutil.which("bash"): from PowerShell or cmd that finds the WSL launcher in WindowsApps or System32. Such a
    candidate is never started; Git for Windows' own bash is looked for instead, and every candidate has to pass _sees_folders."""
    if _BASH:
        return _BASH[0]
    guess = []
    found = shutil.which("bash")
    if found:
        guess.append(found)
    git = shutil.which("git")
    if git:                                                            # ...\Git\cmd\git.exe -> ...\Git\bin\bash.exe
        guess.append(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(git))), "bin", "bash.exe"))
    for var, sub in (("ProgramFiles", "Git"), ("ProgramW6432", "Git"), ("ProgramFiles(x86)", "Git"),
                     ("LocalAppData", os.path.join("Programs", "Git"))):
        if os.environ.get(var):
            guess.append(os.path.join(os.environ[var], sub, "bin", "bash.exe"))
            guess.append(os.path.join(os.environ[var], sub, "usr", "bin", "bash.exe"))
    chosen = None
    seen = set()
    for cand in guess:
        key = os.path.normcase(os.path.abspath(cand))
        low = key.lower().replace("/", "\\")
        if key in seen or "\\windowsapps\\" in low or "\\system32\\" in low or not os.path.isfile(cand):
            continue
        seen.add(key)
        if _sees_folders(cand):
            chosen = cand
            break
    _BASH.append(chosen)
    return chosen
