"""Checks about the computer and the install, with no heavy imports (so they still work when numpy or onnxruntime
cannot even be loaded).

* A Windows PC without the Microsoft Visual C++ runtime: numpy, onnxruntime and ctranslate2 then fail to import with
  "DLL load failed". is_missing_runtime() recognises that and missing_runtime_texts() says what to do.
* A tools folder that was moved or copied after setup: the private Python in venv/ still points at the OLD folder.
  venv_problem() recognises that.
"""
from __future__ import annotations

import os
import sys

VCREDIST_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe"


def is_missing_runtime(exc):
    """True when `exc` (or the error that caused it) is Windows saying a DLL could not be loaded.

    On a PC without the Microsoft Visual C++ 2015-2022 runtime this is how numpy, onnxruntime and ctranslate2 fail
    when they are imported ("DLL load failed while importing onnxruntime_pybind11_state").
    """
    if not sys.platform.startswith("win"):
        return False
    e = exc
    for _ in range(6):
        if e is None:
            break
        if isinstance(e, (ImportError, OSError)):
            text = str(e).lower()
            if ("dll load failed" in text or "dynamic link library" in text
                    or "specified module could not be found" in text
                    or getattr(e, "winerror", None) in (126, 127, 1114)):
                return True
        e = e.__cause__ or e.__context__
    return False


def missing_runtime_texts():
    """(problem, what_to_do) in plain language for a PC that lacks the Visual C++ runtime."""
    return (
        "This computer is missing a free Microsoft component (the \"Microsoft Visual C++ Redistributable\") that the "
        "speech engines need.",
        "1) Copy this web address into your web browser and press Enter: %s  (a file called vc_redist.x64.exe "
        "downloads).  2) Open that file, tick \"I agree to the license terms\", click Install, and click Yes when Windows "
        "asks for permission. This one step needs an administrator: ask your IT person if you do not have the rights.  "
        "3) Then run the setup file (or this program) again." % VCREDIST_URL)


def describe_import_failure(exc, what):
    """(problem, what_to_do) for a failed `import` of a package the helper needs (`what` = plain name of the part)."""
    if is_missing_runtime(exc):
        return missing_runtime_texts()
    return ("%s is not installed correctly." % what, "Please run the setup file again.")


def check_packages():
    """Import every package the helper needs. Returns None if all load, else (problem, what_to_do) in plain language."""
    for module, what in (("numpy", "The number-crunching part (numpy)"), ("av", "The audio decoder (PyAV)"),
                         ("onnxruntime", "The Parakeet engine runtime (onnxruntime)"),
                         ("onnx_asr", "The Parakeet speech engine (onnx-asr)"),
                         ("ctranslate2", "The Whisper engine runtime (ctranslate2)"),
                         ("faster_whisper", "The Whisper speech engine (faster-whisper)")):
        try:
            __import__(module)
        except Exception as e:
            return describe_import_failure(e, what)
    return None


def _real(path):
    return os.path.normcase(os.path.realpath(path))


def venv_problem(tools_dir, prefix=None, base_prefix=None):
    """None if the private Python belongs to this folder, else a plain-language (problem, what_to_do).

    The private Python is a uv-managed copy in <tools>/python/cpython-*, and <tools>/venv points at it with an absolute
    path. When the folder is copied, that path still leads into the OLD folder (it works until the old one is deleted).
    Anything else (a developer running with their own Python or venv) is left alone.
    """
    prefix = sys.prefix if prefix is None else prefix
    base_prefix = getattr(sys, "base_prefix", sys.prefix) if base_prefix is None else base_prefix
    if _real(prefix) == _real(base_prefix):
        return None                                      # not a virtual environment
    if _real(prefix) != _real(os.path.join(tools_dir, "venv")):
        return None                                      # some other environment: not ours to judge
    base = os.path.realpath(base_prefix)
    parent = os.path.dirname(base)
    if os.path.basename(parent).lower() != "python" or not os.path.basename(base).lower().startswith("cpython-"):
        return None                                      # not the layout setup creates
    if _real(os.path.dirname(parent)) == _real(tools_dir):
        return None
    if sys.platform.startswith("win"):
        again = "Double-click the setup file (setup-windows.bat) once more."
    else:                                                # a downloaded .command file is not marked as a program: use bash
        again = ("Run the setup file once more. On a Mac: open Terminal, type bash and a space, drag setup-mac.command into "
                 "the window, then press Return.")
    return ("This tools folder was moved or copied after setup, so the speech tools still point at its old place.",
            again + " It repairs this folder, usually in under a minute, and keeps the speech models. Please do not "
            "move the folder after setup.")
