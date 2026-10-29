#!/bin/bash
# ==============================================================================================
#  Video Redline Tool - one-time setup for Mac           *** NOT TESTED ON A MAC ***
#
#  To run it (once): open Terminal (press Command + Space, type Terminal, press Return), type   bash   and a space,
#  drag this file (setup-mac.command) into the Terminal window, then press Return.
#  (Double-clicking the file often does not work: a download leaves it without the "may run as a program" mark, and a
#  Mac may also refuse a file that came from the internet. Running it with bash avoids both.)
#  It downloads everything into THIS folder only. No admin password, no changes to your Mac.
#  Before it downloads anything it checks that this folder is not inside a cloud-synced folder (see below).
#  Test switch (not for users): set VRT_STOP_AFTER_FOLDER_CHECK=1 to stop right after that check, before any download.
#
#  Written for the old bash 3.2 that ships with macOS: no associative arrays, no mapfile, no ${var,,}.
# ==============================================================================================

# Settings left on this Mac by other software (another Python, a developer setup) would break our own private
# Python, so they are cleared for this script only.
unset PYTHONHOME PYTHONPATH PYTHONSTARTUP PYTHONUSERBASE PYTHONEXECUTABLE __PYVENV_LAUNCHER__

# stop if a command we really depend on fails (each step below also checks itself)
TOOLS="$(cd "$(dirname "$0")" && pwd)"
if [ -z "$TOOLS" ] || [ ! -d "$TOOLS" ]; then
    echo "Could not work out which folder this file is in."
    exit 1
fi

UV_VERSION="0.13.6"

# Keep every download inside this folder.
export UV_PYTHON_INSTALL_DIR="$TOOLS/python"
export UV_CACHE_DIR="$TOOLS/uv-cache"
export UV_PYTHON_PREFERENCE="only-managed"
export UV_NO_CONFIG=1
export UV_LINK_MODE=copy
export UV_HTTP_TIMEOUT=300
export UV_SYSTEM_CERTS=1
export HF_HOME="$TOOLS/hf-cache"
export HF_HUB_DISABLE_TELEMETRY=1
export HF_HUB_DISABLE_SYMLINKS_WARNING=1
unset HF_HUB_OFFLINE

UV="$TOOLS/uv/uv"
PY="$TOOLS/venv/bin/python"

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

fail() {
    echo
    echo "   PROBLEM: $1"
    echo "   WHAT TO DO: $2"
    pause_and_exit 1
}

# ---- was this file opened from inside a zip, a disk image or a protected temporary copy? ------------
case "$TOOLS" in
    *.zip|*.zip/*|*/AppTranslocation/*|*/7zO*|*/Rar\$EX*)
        fail "This file is being run from inside a zip download (or another temporary place), so the rest of the tool is missing." \
             "Close this window. Double-click the zip file in Finder to unpack it (a normal folder appears next to it), drag that folder into a folder called VideoRedline in your home folder (~/VideoRedline), and run setup-mac.command from there. On a Mac: open Terminal, type bash and a space, drag setup-mac.command into the window, then press Return." ;;
esac
for needed in requirements.txt transcribe.py vrt_audio.py vrt_engines.py vrt_env.py vrt_merge.py; do
    if [ ! -f "$TOOLS/$needed" ]; then
        fail "The other files that belong with this one (such as $needed) are not in this folder." \
             "Use the complete tool folder: unpack the whole zip download and run setup-mac.command from the unpacked folder. On a Mac: open Terminal, type bash and a space, drag setup-mac.command into the window, then press Return."
    fi
done
if [ ! -w "$TOOLS" ]; then
    fail "This folder is read-only (it may be on a disk image or a locked drive), so nothing can be installed into it." \
         "Drag the whole folder into a folder called VideoRedline in your home folder (~/VideoRedline) and run setup-mac.command from there. On a Mac: open Terminal, type bash and a space, drag setup-mac.command into the window, then press Return."
fi

echo
echo " ====================================================================="
echo "  Video Redline Tool - one-time setup (Mac)"
echo " ====================================================================="
echo
echo "  This installs the speech tools that find the \"um\"s, \"uh\"s, pauses"
echo "  and stutters in your videos."
echo
echo "  * It downloads about 1.3 GB, ONCE (from github.com, pypi.org and huggingface.co)."
echo "    Allow 5 to 15 minutes."
echo "  * Everything goes into this folder:"
echo "      \"$TOOLS\""
echo "  * Nothing else on your Mac is changed. No admin password needed."
echo "  * Afterwards your videos never leave your computer."
echo
if [ -z "$VRT_NO_PAUSE" ]; then
    printf "  Press any key to start, or close this window to cancel. "
    read -r -n 1 -s _ignored
    echo
fi

# ---- is this folder inside a cloud-synced folder? (checked BEFORE anything is downloaded) ----------
# While a video is transcribed it is copied into this folder (tmp/jobs-<port>), and setup puts about 1.5 GB here. In a
# OneDrive, Dropbox, iCloud or Google Drive folder, or in a Desktop or Documents folder that iCloud Drive keeps in iCloud,
# that service would upload all of it. The names are the same list as SYNC_SERVICES in vrt_server.py, and the question
# whether iCloud keeps Desktop and Documents is the same one the helper asks when it starts. Only the folder NAME is looked at.
SYNC_LABEL=""
SYNC_WHAT=""
LOWTOOLS="$(printf '%s' "$TOOLS" | tr '[:upper:]' '[:lower:]')"
case "$LOWTOOLS" in
    *onedrive*)                                              SYNC_LABEL="OneDrive" ;;
    *dropbox*)                                               SYNC_LABEL="Dropbox" ;;
    *icloud*|*"mobile documents"*|*"com~apple~clouddocs"*)   SYNC_LABEL="iCloud" ;;
    *"google drive"*|*googledrive*|*"my drive"*)             SYNC_LABEL="Google Drive" ;;
esac
if [ -n "$SYNC_LABEL" ]; then
    SYNC_WHAT="inside a folder that $SYNC_LABEL synchronises"
elif [ -n "$HOME" ]; then
    LOWHOME="$(printf '%s' "$HOME" | tr '[:upper:]' '[:lower:]')"
    case "$LOWTOOLS" in
        "$LOWHOME/desktop"|"$LOWHOME/desktop/"*|"$LOWHOME/documents"|"$LOWHOME/documents/"*)
            # "defaults" exists on a Mac only. On any other computer, or if it fails, the answer is empty: no warning.
            if [ "$(defaults read com.apple.finder FXICloudDriveDesktop 2>/dev/null)" = "1" ]; then
                SYNC_LABEL="iCloud"
                SYNC_WHAT="inside your Desktop or Documents folder, which iCloud Drive synchronises"
            fi ;;
    esac
fi
if [ -n "$SYNC_LABEL" ]; then
    echo " ---------------------------------------------------------------------"
    echo "  WARNING: this folder is $SYNC_WHAT:"
    echo "      \"$TOOLS\""
    echo
    echo "  Why it matters: while a video is being transcribed, a copy of it is kept"
    echo "  in this folder. $SYNC_LABEL could upload that copy to the internet (and the"
    echo "  1.5 GB of speech tools too)."
    echo
    echo "  WHAT TO DO (recommended): close this window, move the whole Video Redline"
    echo "  folder (the one that has video-redline.html and the tools folder inside it) to"
    echo "  ~/VideoRedline (a folder called VideoRedline in your home folder), and run"
    echo "  setup-mac.command from there."
    echo
    echo "  To stop now, just press Return. To go on anyway, type C and press Return."
    echo " ---------------------------------------------------------------------"
    echo
    ANSWER=""
    printf "  Your choice (Return = stop, C = continue anyway): "
    read -r ANSWER
    ANSWER="$(printf '%s' "$ANSWER" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
    case "$ANSWER" in
        c|continue)
            echo
            echo "  Going on at your request. Remember: videos you transcribe will be kept in this folder for a while."
            echo ;;
        *)
            echo
            echo "  Setup was stopped. Nothing was downloaded and nothing was changed."
            echo "  Move the whole Video Redline folder (the one that has video-redline.html and the tools folder inside it) to ~/VideoRedline and run setup-mac.command from there."
            pause_and_exit 1 ;;
    esac
fi
if [ -n "$VRT_STOP_AFTER_FOLDER_CHECK" ]; then
    echo "  Folder check finished (VRT_STOP_AFTER_FOLDER_CHECK is set): stopping before any download."
    pause_and_exit 0
fi

# ---- which kind of Mac? ---------------------------------------------------------------------
ARCH="$(uname -m)"
case "$ARCH" in
    arm64)  UV_FILE="uv-aarch64-apple-darwin.tar.gz" ;;
    x86_64) UV_FILE="uv-x86_64-apple-darwin.tar.gz" ;;
    *) fail "This Mac type ($ARCH) is not supported." "Ask the person who invited you to the beta for help." ;;
esac
UV_URL="https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$UV_FILE"

if [ "$ARCH" = "x86_64" ]; then
    echo "  NOTE: this is an Intel Mac. It should work, but it is the least tested kind of Mac,"
    echo "        and it will be slower than an Apple Silicon (M1 or newer) Mac."
    echo
fi

# ---- step 1: uv -----------------------------------------------------------------------------
echo " [1 of 6] Getting the small installer (uv, about 15 MB, from github.com) ..."
if [ ! -x "$UV" ]; then
    mkdir -p "$TOOLS/uv" || fail "I could not create a folder here." "Make sure this folder is not read-only (move it to ~/VideoRedline, a folder called VideoRedline in your home folder)."
    curl -L --fail --silent --show-error --retry 3 -o "$TOOLS/uv/uv-download.tar.gz" "$UV_URL" ||
        fail "A download failed." "Check your internet connection (and that no VPN or firewall blocks github.com), then run this file again."
    EXPECTED="$(curl -L --fail --silent "$UV_URL.sha256" | awk '{print $1}')"
    ACTUAL="$(shasum -a 256 "$TOOLS/uv/uv-download.tar.gz" | awk '{print $1}')"
    if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
        rm -f "$TOOLS/uv/uv-download.tar.gz"
        fail "The downloaded installer did not pass its safety check, so it was not used." "Run this file again. If it keeps failing, a network filter may be changing downloads."
    fi
    tar -xzf "$TOOLS/uv/uv-download.tar.gz" -C "$TOOLS/uv" --strip-components=1 ||
        fail "I could not unpack the installer." "Run this file again."
    rm -f "$TOOLS/uv/uv-download.tar.gz"
    chmod +x "$TOOLS/uv/uv" 2>/dev/null
    [ -x "$UV" ] || fail "The installer was not unpacked correctly." "Delete the folder named uv inside this folder and run this file again."
fi
echo "       done."

# ---- step 2: python -------------------------------------------------------------------------
echo
echo " [2 of 6] Getting a private copy of Python (about 25 MB, from github.com) ..."
# (when the folder was moved, this also repairs the python/cpython-3.12-... link that pointed at the old place)
"$UV" python install 3.12 --no-bin ||
    fail "A download failed." "Check your internet connection, then run this file again."
echo "       done."

# ---- step 3: virtual environment ------------------------------------------------------------
echo
echo " [3 of 6] Preparing the working space ..."
NEED_VENV=1
# -L as well as -e: after the folder was moved, venv/bin/python is a link to the old place that leads nowhere
if [ -e "$PY" ] || [ -L "$PY" ]; then
    # It exists - but does it still work, and does it belong to THIS folder?
    if "$PY" "$TOOLS/transcribe.py" --check-venv >/dev/null 2>&1; then
        NEED_VENV=0
    else
        echo "       This folder was moved, renamed or copied after setup. Repairing the working space ..."
        if "$UV" venv "$TOOLS/venv" --python 3.12 --allow-existing && "$PY" "$TOOLS/transcribe.py" --check-venv >/dev/null 2>&1; then
            NEED_VENV=0
        else
            echo "       Rebuilding it from scratch (this downloads the speech tools again, about 100 MB) ..."
            rm -rf "$TOOLS/venv"
        fi
    fi
fi
if [ "$NEED_VENV" = "1" ]; then
    "$UV" venv "$TOOLS/venv" --python 3.12 --clear || fail "Something went wrong preparing the working space." "Run this file again."
fi
echo "       done."

# ---- step 4: packages -----------------------------------------------------------------------
echo
echo " [4 of 6] Installing the speech tools (about 100 MB download from pypi.org) ..."
"$UV" pip install --python "$PY" -r "$TOOLS/requirements.txt" ||
    fail "A download or install failed. (Apple Silicon Macs need macOS 14 or newer for this step.)" "Check your internet connection and run this file again. If your Mac is older than macOS 14, ask the person who invited you to the beta for help."
# Can every package really start on this Mac? Finding out now saves the 1.2 GB model download below.
"$PY" "$TOOLS/transcribe.py" --check-packages ||
    fail "The speech tools were installed but cannot start on this Mac." "Follow the WHAT TO DO line just above this message, then run this file again."
echo "       done."

# ---- step 5: models -------------------------------------------------------------------------
echo
echo " [5 of 6] Downloading the speech models from huggingface.co. This is the big one: about 1.2 GB, once."
echo "          A progress bar is shown for each file. If it stops, run this file again:"
echo "          it continues where it left off. Models that are already complete are not downloaded again."
echo
"$PY" "$TOOLS/transcribe.py" --download-models ||
    fail "The speech models could not be downloaded completely." "Check the internet connection and run this file again. It continues where it left off."

# ---- step 6: self-test ----------------------------------------------------------------------
echo
echo " [6 of 6] Quick self-test ..."
"$PY" "$TOOLS/transcribe.py" --self-test ||
    fail "The self-test did not pass." "Run this file once more. If it fails again, send the file logs/last-error.txt (in this folder) to the person who invited you to the beta."

# ---- tidy up --------------------------------------------------------------------------------
rm -rf "$TOOLS/uv-cache" 2>/dev/null
# tmp is not deleted as a whole: a helper that runs from this folder keeps its job folder tmp/jobs-<port> there, with a finished
# transcript that nobody has fetched yet. The helper's own tidy-up (the one it makes when it starts) deletes only what no running
# helper owns, and the empty folder tmp goes last. Setup is no helper and owns no job folder (the same as setup-windows.bat does it).
VRT_TOOLS="$TOOLS" "$PY" -c "import os,sys; sys.path.insert(0,os.environ['VRT_TOOLS']); import vrt_server as v; v._instance['name']='setup'; v.clean_old_job_folders(); a=v.other_helpers_alive(); a or v.clean_stale_run_dirs(); a or v.clean_spawn_lock()" >/dev/null 2>&1
rmdir "$TOOLS/tmp" 2>/dev/null

echo
echo " ====================================================================="
echo "  ALL DONE. Setup is finished and the self-test passed."
echo
echo "  To use the \"Create transcript and find cuts\" button in Video Redline:"
echo "  on a Mac, open Terminal, type bash and a space, drag \"start-helper-mac.command\""
echo "  (in this same folder) into the window, then press Return. Leave that window"
echo "  open while you work in Video Redline."
echo
echo "  Or, without the button: open Terminal, type bash and a space, drag"
echo "  \"transcribe-mac.command\" into the window, type another space, drag your"
echo "  video into the window too, then press Return. See README.md for details."
echo "  Please do not move or rename this folder from now on."
echo " ====================================================================="
pause_and_exit 0
