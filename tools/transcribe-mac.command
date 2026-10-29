#!/bin/bash
# ==============================================================================================
#  Video Redline - transcribe a video (Mac)         *** NOT TESTED ON A MAC ***
#
#  To use it: open Terminal (press Command + Space, type Terminal, press Return), type   bash   and a space, drag this
#  file (transcribe-mac.command) into the Terminal window, type another space, drag your video into the window too,
#  then press Return. (You can drag in several videos. If you press Return without a video, the window asks you to drag
#  one in.) Dropping a video onto the file in Finder does nothing.
#  (Double-clicking the file often does not work: a download leaves it without the "may run as a program" mark, and a
#  Mac may also refuse a file that came from the internet. Running it with bash avoids both.)
#  It writes "<video name>-transcript.json" next to the video.
#
#  Written for the old bash 3.2 that ships with macOS.
# ==============================================================================================

# Settings left on this Mac by other software (another Python, a developer setup) would break our own private
# Python, so they are cleared for this script only.
unset PYTHONHOME PYTHONPATH PYTHONSTARTUP PYTHONUSERBASE PYTHONEXECUTABLE __PYVENV_LAUNCHER__

TOOLS="$(cd "$(dirname "$0")" && pwd)"
PY="$TOOLS/venv/bin/python"

export HF_HOME="$TOOLS/hf-cache"
export HF_HUB_OFFLINE=1
export HF_HUB_DISABLE_TELEMETRY=1
export ORT_DISABLE_TELEMETRY=1
export HF_HUB_DISABLE_SYMLINKS_WARNING=1
export PYTHONUTF8=1

pause_and_exit() {
    code="$1"
    echo
    if [ -z "$VRT_NO_PAUSE" ]; then
        printf "Press any key to finish. You can then close this window. "
        read -r -n 1 -s _ignored
        echo
    fi
    exit "$code"
}

# ---- was this file opened from inside a zip, a disk image or a protected temporary copy? ------------
case "$TOOLS" in
    *.zip|*.zip/*|*/AppTranslocation/*|*/7zO*|*/Rar\$EX*)
        echo
        echo "  PROBLEM: this file is being run from inside a zip download (or another temporary place), so the"
        echo "           rest of the tool is missing."
        echo "  WHAT TO DO: close this window. Double-click the zip file in Finder to unpack it, drag the unpacked"
        echo "  folder into a folder called VideoRedline in your home folder (~/VideoRedline), run setup-mac.command there"
        echo "  first, then use this file from there."
        echo "  On a Mac: open Terminal, type bash and a space, drag setup-mac.command into the window, then press Return."
        pause_and_exit 1 ;;
esac
if [ ! -f "$TOOLS/transcribe.py" ]; then
    echo
    echo "  PROBLEM: the other files that belong with this one (such as transcribe.py) are not in this folder."
    echo "  WHAT TO DO: use the complete tool folder: unpack the whole zip download and run setup-mac.command from it."
    echo "  On a Mac: open Terminal, type bash and a space, drag setup-mac.command into the window, then press Return."
    pause_and_exit 1
fi

# -L as well as -e: after the folder was moved, venv/bin/python is a link to the old place that leads nowhere
if [ ! -e "$PY" ] && [ ! -L "$PY" ]; then
    echo
    echo "  The one-time setup has not been run yet."
    echo "  Please run \"setup-mac.command\" first (in this same folder), then try again."
    echo "  On a Mac: open Terminal, type bash and a space, drag setup-mac.command into the window, then press Return."
    pause_and_exit 1
fi

# Does the private Python still run, and does it belong to THIS folder?
if ! "$PY" "$TOOLS/transcribe.py" --check-venv >/dev/null 2>&1; then
    echo
    echo "  PROBLEM: this tools folder was moved, renamed or copied after setup, so the speech tools cannot find"
    echo "           their private Python any more."
    echo "  WHAT TO DO: run \"setup-mac.command\" (in this same folder) once more."
    echo "  On a Mac: open Terminal, type bash and a space, drag setup-mac.command into the window, then press Return."
    echo "  It repairs the folder, usually in under a minute, and keeps the speech models. Please do not move or rename"
    echo "  the folder after setup."
    pause_and_exit 1
fi

FAILED=0

run_one() {
    echo
    echo " ---------------------------------------------------------------------"
    echo "  Working on: $1"
    echo " ---------------------------------------------------------------------"
    "$PY" "$TOOLS/transcribe.py" "$1" || FAILED=1
}

if [ "$#" -gt 0 ]; then
    for f in "$@"; do
        run_one "$f"
    done
else
    echo
    echo "  Drag your video file into this window, then press Return."
    echo
    printf "  Video file: "
    IFS= read -r VIDEO
    # Terminal adds a backslash before spaces and a space at the end when you drag a file in: undo both.
    VIDEO="$(printf '%s' "$VIDEO" | sed -e 's/[[:space:]]*$//' -e "s/^'//" -e "s/'\$//" -e 's/^"//' -e 's/"$//' -e 's/\\\(.\)/\1/g')"
    if [ -z "$VIDEO" ]; then
        echo "  No file was given."
        pause_and_exit 1
    fi
    run_one "$VIDEO"
fi

echo
if [ "$FAILED" = "1" ]; then
    echo "  Something did not work - see the PROBLEM / WHAT TO DO lines above."
else
    echo "  All finished. The transcript file(s) are next to your video(s)."
fi
pause_and_exit "$FAILED"
