#!/bin/bash
# ==============================================================================================
#  Video Redline Tool - start the helper (Mac)         *** NOT TESTED ON A MAC ***
#
#  To start it: open Terminal (press Command + Space, type Terminal, press Return), type   bash   and a space, drag
#  this file (start-helper-mac.command) into the Terminal window, then press Return. Then LEAVE THAT WINDOW OPEN
#  while you use the Video Redline page. The page can then make a transcript for you with one click ("Create
#  transcript and find cuts"). Everything stays on your Mac. To stop the helper, simply close this window.
#  (Double-clicking the file often does not work: a download leaves it without the "may run as a program" mark, and a
#  Mac may also refuse a file that came from the internet. Running it with bash avoids both.)
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
if [ ! -f "$TOOLS/transcribe.py" ] || [ ! -f "$TOOLS/vrt_server.py" ]; then
    echo
    echo "  PROBLEM: the other files that belong with this one (such as transcribe.py and vrt_server.py) are not in"
    echo "           this folder."
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

echo
echo "  Starting the Video Redline helper. This takes a few seconds ..."
echo

# Ctrl+C stops the helper itself; this script must stay alive to say so, so it only notes the signal.
trap ':' INT
"$PY" "$TOOLS/vrt_server.py"
RC=$?
trap - INT

echo
if [ "$RC" = "10" ]; then
    echo "  Nothing more to do: the helper is already running in another window."
elif [ "$RC" = "0" ]; then
    echo "  The helper has stopped. The Video Redline page can no longer make transcripts."
    echo "  To use it again: open Terminal, type bash and a space, drag start-helper-mac.command into the window,"
    echo "  then press Return."
else
    echo "  PROBLEM: the helper stopped unexpectedly (code $RC)."
    echo "  WHAT TO DO: start it again: open Terminal, type bash and a space, drag start-helper-mac.command into the"
    echo "  window, then press Return. If it keeps stopping, send a screenshot of this window to the person who invited you to the beta."
fi
pause_and_exit "$RC"
