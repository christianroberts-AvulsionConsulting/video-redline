#!/bin/bash
# ==============================================================================================
#  Video Redline - open the tool and make sure its helper is running (Mac)      *** NOT TESTED ON A MAC ***
#
#  This is what the "Video Redline" app runs (setup-mac.command makes that app, next to video-redline.html). It does what the
#  "Video Redline" icon does on Windows, in one step:
#    1. it looks for a helper that is already running (it asks 127.0.0.1, your own Mac only);
#    2. if there is none, it starts the helper in the background, with no Terminal window;
#    3. it opens video-redline.html in your web browser.
#  A web page cannot start a program on your Mac, so open Video Redline with that app instead of double-clicking the page
#  itself. The real work is done by open_video_review.pyw, the same file the Windows icon runs.
#
#  You can also run this file by hand (for example if the Mac refuses to open the app): open Terminal, type   bash   and a space,
#  drag this file into the Terminal window, then press Return.
#
#  Written for the old bash 3.2 that ships with macOS.
# ==============================================================================================

# Settings left on this Mac by other software (another Python, a developer setup) would break our own private
# Python, so they are cleared for this script only.
unset PYTHONHOME PYTHONPATH PYTHONSTARTUP PYTHONUSERBASE PYTHONEXECUTABLE __PYVENV_LAUNCHER__

TOOLS="$(cd "$(dirname "$0")" && pwd)"
PY="$TOOLS/venv/bin/python"
OPENER="$TOOLS/open_video_review.pyw"

# A plain Mac message box. The app runs this file without a Terminal window, so there is nowhere to print to; run by hand in
# Terminal, the text is printed instead.
say() {
    if [ -t 1 ]; then
        echo
        echo "  $1"
        echo
    else
        osascript -e 'on run argv' \
                  -e 'display dialog (item 1 of argv) with title "Video Redline" buttons {"OK"} default button "OK" with icon caution' \
                  -e 'end run' "$1" >/dev/null 2>&1
    fi
}

case "$TOOLS" in
    *.zip|*.zip/*|*/AppTranslocation/*|*/7zO*|*/Rar\$EX*)
        say "This file is being run from inside a zip download (or another temporary place), so the rest of Video Redline is missing. Double-click the zip file in Finder to unpack it, drag the unpacked folder into a folder called VideoRedline in your home folder (~/VideoRedline), run setup-mac.command there once, and use the Video Redline app from there."
        exit 1 ;;
esac

if [ ! -f "$OPENER" ] || [ ! -f "$TOOLS/helper_launcher.pyw" ]; then
    say "Part of the tools folder is missing (open_video_review.pyw or helper_launcher.pyw), so Video Redline cannot start its helper. Please copy the complete tools folder again (all of its files together) into the Video Redline folder."
    exit 1
fi

# -x follows a link: after the folder was moved, venv/bin/python is a link to the old place that leads nowhere
if [ ! -x "$PY" ]; then
    say "The one-time setup has not been run yet, or this folder was moved or renamed after setup. Open Terminal, type bash and a space, drag setup-mac.command (in the tools folder) into the window, and press Return. It repairs the folder and keeps the speech models. Then open Video Redline again."
    exit 1
fi

cd "$TOOLS" || exit 1
exec "$PY" -E -X utf8 "$OPENER"
