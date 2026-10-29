#!/bin/bash
# ==============================================================================================
#  Video Redline - stop the helper (Mac)                                         *** NOT TESTED ON A MAC ***
#
#  To run it: open Terminal (press Command + Space, type Terminal, press Return), type   bash   and a space, drag this file
#  (stop-helper-mac.command) into the Terminal window, then press Return.
#  It stops the helper that runs from THIS folder (the one the "Video Redline" app started, and one that was started by hand
#  with start-helper-mac.command). Use it when the page says the helper is busy and you want a fresh start, before you replace
#  the files in this folder with a newer version, or when you want the helper off for now. Nothing is removed: the "Video Redline"
#  app starts the helper again the next time you open it.
#  Only programs that run THIS folder's helper_launcher.pyw or vrt_server.py are stopped, never other programs.
#
#  Written for the old bash 3.2 that ships with macOS.
# ==============================================================================================

unset PYTHONHOME PYTHONPATH PYTHONSTARTUP PYTHONUSERBASE PYTHONEXECUTABLE __PYVENV_LAUNCHER__

TOOLS="$(cd "$(dirname "$0")" && pwd)"
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

# The process numbers of the helpers that run from this folder, one per line. The command line of a process is compared as plain
# text (no pattern), so a folder name with odd characters cannot match anything else.
find_pids() {
    ps -axo pid=,command= 2>/dev/null | while IFS= read -r line; do
        line="${line#"${line%%[![:space:]]*}"}"
        pid="${line%% *}"
        cmd="${line#* }"
        case "$pid" in
            ''|*[!0-9]*) continue ;;
        esac
        if [ "$pid" = "$$" ]; then continue; fi
        case "$cmd" in
            *"$TOOLS/helper_launcher.pyw"*|*"$TOOLS/vrt_server.py"*) echo "$pid" ;;
        esac
    done
}

echo
echo "  Stopping the Video Redline helper ..."

PIDS="$(find_pids)"
STOPPED=0
if [ -n "$PIDS" ]; then
    STOPPED=1
    # a polite stop first: the helper then also stops the transcript it is working on
    kill -TERM $PIDS 2>/dev/null
    tries=0
    while [ "$tries" -lt 8 ]; do
        sleep 1
        PIDS="$(find_pids)"
        if [ -z "$PIDS" ]; then break; fi
        tries=$((tries + 1))
    done
    if [ -n "$PIDS" ]; then
        kill -KILL $PIDS 2>/dev/null
        sleep 1
    fi
fi

# A helper that is stopped in the middle of a transcript leaves a copy of the video (tmp/jobs-*) and the sound taken from it
# (tmp/run-*) behind. The helper's own functions delete both, and only when no other helper runs from this folder (the same
# tidy-up that setup-mac.command makes at its end).
if [ -x "$PY" ] && [ -f "$TOOLS/vrt_server.py" ]; then
    VRT_TOOLS="$TOOLS" "$PY" -c "import os,sys; sys.path.insert(0,os.environ['VRT_TOOLS']); import vrt_server as v; v.clean_old_job_folders(); a=v.other_helpers_alive(); a or v.clean_stale_run_dirs(0); a or v.clean_spawn_lock()" >/dev/null 2>&1
    rmdir "$TOOLS/tmp" 2>/dev/null
fi

echo
if [ "$STOPPED" = "0" ]; then
    echo "  The helper was not running. Nothing to stop."
else
    if [ -n "$(find_pids)" ]; then
        echo "  PROBLEM: the helper did not stop."
        echo "  WHAT TO DO: log out of your Mac and log in again, or restart it."
        pause_and_exit 1
    fi
    echo "  The helper has been stopped."
fi
# (a helper that was started by hand in a Terminal window shows its own message there; that window can be closed now)
echo "  To start it again, open the \"Video Redline\" app in your Video Redline folder (it opens Video Redline too,"
echo "  and you can close that page). No app there? Run setup-mac.command once more: it makes the app."
pause_and_exit 0
