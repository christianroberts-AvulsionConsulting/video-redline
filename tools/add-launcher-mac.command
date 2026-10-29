#!/bin/bash
# ==============================================================================================
#  Video Redline - make the "Video Redline" app (Mac)                           *** NOT TESTED ON A MAC ***
#
#  setup-mac.command runs this file as its last step; you can also run it yourself (it is safe to run twice): open Terminal,
#  type   bash   and a space, drag this file into the Terminal window, then press Return.
#  It makes ONE small app, "Video Redline.app", in the Video Redline folder, next to video-redline.html. Double-click it to open
#  Video Redline: it starts the helper (the part that makes transcripts) if it is not running, then opens the page. A web page
#  cannot start a program, so this app is how the helper gets started. Drag the app into your Dock to keep it at hand.
#  The app is only a few lines of text that start open-video-redline-mac.command in the tools folder. It is made here, on your
#  Mac, so nothing is downloaded and the Mac does not treat it as a download from the internet.
#  No admin password, nothing outside the Video Redline folder is changed.
#
#  Switch (for setup-mac.command; you do not need it):  --quiet   print less and never wait for a key
#
#  Written for the old bash 3.2 that ships with macOS.
# ==============================================================================================

unset PYTHONHOME PYTHONPATH PYTHONSTARTUP PYTHONUSERBASE PYTHONEXECUTABLE __PYVENV_LAUNCHER__

TOOLS="$(cd "$(dirname "$0")" && pwd)"
if [ -z "$TOOLS" ] || [ ! -d "$TOOLS" ]; then
    echo "Could not work out which folder this file is in."
    exit 1
fi
ROOT="$(dirname "$TOOLS")"
APP="$ROOT/Video Redline.app"
APP_ID="local.videoredline.launcher"
STUB_NAME="video-redline-launcher"

QUIET=""
if [ "$1" = "--quiet" ]; then QUIET=1; fi

pause_and_exit() {
    code="$1"
    if [ -z "$QUIET" ] && [ -z "$VRT_NO_PAUSE" ]; then
        echo
        printf "Press any key to finish. You can then close this window. "
        read -r -n 1 -s _ignored
        echo
    fi
    exit "$code"
}

fail() {
    echo
    echo "   PROBLEM: $1"
    echo "   WHAT TO DO: $2"
    pause_and_exit 1
}

case "$TOOLS" in
    *.zip|*.zip/*|*/AppTranslocation/*|*/7zO*|*/Rar\$EX*)
        fail "This file is being run from inside a zip download (or another temporary place), so the rest of the tool is missing." \
             "Double-click the zip file in Finder to unpack it, drag the unpacked folder into a folder called VideoRedline in your home folder (~/VideoRedline), run setup-mac.command there, and it makes the app." ;;
esac
for needed in open-video-redline-mac.command open_video_review.pyw helper_launcher.pyw; do
    if [ ! -f "$TOOLS/$needed" ]; then
        fail "A file that belongs with this one ($needed) is not in the tools folder." \
             "Use the complete tool folder: unpack the whole download again and run setup-mac.command from the unpacked folder."
    fi
done
if [ ! -w "$ROOT" ]; then
    fail "The Video Redline folder is read-only, so the app cannot be made in it." \
         "Drag the whole folder into a folder called VideoRedline in your home folder (~/VideoRedline) and run setup-mac.command from there."
fi

# Never replace something that this tool did not make.
if [ -e "$APP" ] || [ -L "$APP" ]; then
    if [ -f "$APP/Contents/Info.plist" ] && grep -q "$APP_ID" "$APP/Contents/Info.plist" 2>/dev/null; then
        rm -rf "$APP"
    else
        fail "There is already something called \"Video Redline.app\" in the Video Redline folder that this tool did not make, so it was left alone:  $APP" \
             "Rename or move that one, then run this file again."
    fi
fi

mkdir -p "$APP/Contents/MacOS" ||
    fail "I could not create the app folder in the Video Redline folder." "Make sure that folder is not read-only, then run this file again."

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>Video Redline</string>
    <key>CFBundleDisplayName</key>
    <string>Video Redline</string>
    <key>CFBundleIdentifier</key>
    <string>local.videoredline.launcher</string>
    <key>CFBundleExecutable</key>
    <string>video-redline-launcher</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
</dict>
</plist>
PLIST
if [ $? -ne 0 ]; then
    fail "I could not write the app's information file." "Make sure the Video Redline folder is not read-only, then run this file again."
fi
# "plutil" is part of macOS; if it is there, let it check the file we just wrote
if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$APP/Contents/Info.plist" >/dev/null 2>&1 ||
        fail "The app's information file did not pass the Mac's own check." "Run this file again. If it keeps failing, tell the person who invited you to the beta."
fi

# The program inside the app: it only starts the real launcher in the tools folder. The folder's full path is written into it
# now (printf %q makes any odd character in the path safe), so the app keeps working if you copy it to another place.
STUB="$APP/Contents/MacOS/$STUB_NAME"
{
    echo '#!/bin/bash'
    echo '# Made by add-launcher-mac.command: it only starts the real launcher in the tools folder.'
    printf 'T=%q\n' "$TOOLS/open-video-redline-mac.command"
    cat <<'STUBEND'
if [ ! -f "$T" ]; then
    osascript -e 'display dialog "Video Redline cannot find its tools folder. It was probably moved or renamed. Open Terminal, type bash and a space, drag setup-mac.command (in the tools folder of your Video Redline folder) into the window, and press Return. That makes this app again." with title "Video Redline" buttons {"OK"} default button "OK" with icon caution' >/dev/null 2>&1
    exit 1
fi
exec /bin/bash "$T"
STUBEND
} > "$STUB" ||
    fail "I could not write the program inside the app." "Make sure the Video Redline folder is not read-only, then run this file again."
chmod +x "$STUB" 2>/dev/null
if [ ! -x "$STUB" ]; then
    fail "The program inside the app could not be marked as runnable." "Run this file again."
fi
touch "$APP" 2>/dev/null

if [ -n "$QUIET" ]; then
    echo "       done: \"Video Redline.app\" is in the Video Redline folder."
    exit 0
fi

echo
echo " ====================================================================="
echo "  The \"Video Redline\" app is ready."
echo
echo "  It is in your Video Redline folder, next to video-redline.html:"
echo "      \"$APP\""
echo
echo "  * Double-click it to open Video Redline. It starts the helper (the part"
echo "    that makes transcripts) if it is not running, then opens the page."
echo "    Open Video Redline this way, not by double-clicking video-redline.html."
echo "  * Drag it into your Dock to keep it at hand."
echo "  * The first time, your Mac may ask whether the app may open your web"
echo "    browser, or your browser may ask whether the page may connect to other"
echo "    apps on your computer. Choose Allow."
echo "  * To stop the helper: run stop-helper-mac.command (same way as this file)."
echo "  * If the Mac refuses to open the app, open Terminal, type bash and a space,"
echo "    drag open-video-redline-mac.command (in the tools folder) into the window,"
echo "    and press Return. It does the same thing."
echo " ====================================================================="
pause_and_exit 0
