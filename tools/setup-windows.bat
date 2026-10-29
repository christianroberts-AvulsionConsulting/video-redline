@echo off
rem ============================================================================================
rem  Video Redline - one-time setup for Windows
rem  Double-click this file once. It downloads everything into THIS folder only:
rem  no admin rights, no changes to Windows, no changes to PATH or the registry.
rem  (One exception on a few PCs: the Microsoft Visual C++ runtime, see the check below.)
rem  Before it downloads anything it checks that this folder is not inside OneDrive, Dropbox, iCloud or Google Drive
rem  (see "is this folder inside a cloud-synced folder" below).
rem  If it has to repair or rebuild the working space and stop-helper-windows.bat is in this folder, it first stops the helper
rem  that may be running hidden from this folder (the helper holds files that the repair needs). At the very end (ALL DONE) it
rem  says what to do next: when setup-autostart-windows.bat is in this folder, to double-click it (it adds the Video Redline
rem  icon, which is then the way to open Video Redline, and makes the helper start by itself at every sign-in) or, for anyone who
rem  would rather not, to start the helper by hand with start-helper-windows.bat; without that file only the hand start is named.
rem  It can also offer to run setup-autostart-windows.bat (default: no). Its last tidy-up never deletes the folder tmp as a whole:
rem  a helper that runs from this folder, hidden or in a window, keeps its job folder there.
rem  Test switches (not for users): VRT_STOP_AFTER_FOLDER_CHECK=1 stops right after the folder check, before any download.
rem  VRT_NO_PAUSE=1 skips every "press any key" wait and the question about the automatic start.
rem ============================================================================================
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul 2>&1
title Video Redline - one-time setup

rem Settings left on this PC by other software (another Python, CAD or GIS programs) would break our own private
rem Python, so they are cleared for this window only.
set "PYTHONHOME="
set "PYTHONPATH="
set "PYTHONSTARTUP="
set "PYTHONUSERBASE="

rem The folder that the advice below gives as an example: VideoRedline inside the user's own folder (directly on the C: drive it would
rem be shared with the other accounts of the PC, and the automatic start warns about such a folder, or stops when this file offers it). It is printed inside quotation marks only.
set "EXAMPLE=C:\Users\<your name>\VideoRedline"
if defined USERPROFILE set "EXAMPLE=%USERPROFILE%\VideoRedline"
if not "%EXAMPLE:~1,2%"==":\" set "EXAMPLE=C:\Users\<your name>\VideoRedline"

set "TOOLS=%~dp0"
if "%TOOLS:~-1%"=="\" set "TOOLS=%TOOLS:~0,-1%"

rem ---- was this file opened from inside the zip download? --------------------------------------
rem Windows then unpacks ONLY this file into a temporary folder and leaves the rest of the tool in the zip.
set "FOLDERNAME=-"
for %%I in ("%TOOLS%") do if not "%%~nxI"=="" set "FOLDERNAME=%%~nxI"
if /i "%FOLDERNAME:~-4%"==".zip" goto in_zip
if /i "%FOLDERNAME:~0,4%"=="Temp" if /i "%FOLDERNAME:~5,1%"=="_" goto in_zip
if /i "%FOLDERNAME:~0,3%"=="7zO" goto in_zip
if /i "%FOLDERNAME:~0,6%"=="Rar$EX" goto in_zip
rem (Explorer unpacks a single file together with its folder: <zip>\tools\<file>, so the folder above can be the zip)
for %%I in ("%TOOLS%\..") do set "PARENTDIR=%%~fI"
set "PARENTNAME=-"
for %%I in ("%PARENTDIR%") do if not "%%~nxI"=="" set "PARENTNAME=%%~nxI"
if /i "%PARENTNAME:~-4%"==".zip" goto in_zip
if /i "%PARENTNAME:~0,4%"=="Temp" if /i "%PARENTNAME:~5,1%"=="_" goto in_zip
if /i "%PARENTNAME:~0,3%"=="7zO" goto in_zip
if /i "%PARENTNAME:~0,6%"=="Rar$EX" goto in_zip
if not exist "%TOOLS%\requirements.txt" goto not_extracted
if not exist "%TOOLS%\transcribe.py" goto not_extracted
if not exist "%TOOLS%\vrt_audio.py" goto not_extracted
if not exist "%TOOLS%\vrt_engines.py" goto not_extracted
if not exist "%TOOLS%\vrt_env.py" goto not_extracted
if not exist "%TOOLS%\vrt_merge.py" goto not_extracted

set "UV_VERSION=0.13.6"
set "UV_ZIP_URL=https://github.com/astral-sh/uv/releases/download/%UV_VERSION%/uv-x86_64-pc-windows-msvc.zip"

rem Keep every download inside this folder.
set "UV_PYTHON_INSTALL_DIR=%TOOLS%\python"
set "UV_CACHE_DIR=%TOOLS%\uv-cache"
set "UV_PYTHON_PREFERENCE=only-managed"
set "UV_NO_CONFIG=1"
set "UV_LINK_MODE=copy"
set "UV_HTTP_TIMEOUT=300"
set "UV_SYSTEM_CERTS=1"
set "HF_HOME=%TOOLS%\hf-cache"
set "HF_HUB_DISABLE_TELEMETRY=1"
set "ORT_DISABLE_TELEMETRY=1"
set "HF_HUB_DISABLE_SYMLINKS_WARNING=1"
set "HF_HUB_OFFLINE="
set "UV=%TOOLS%\uv\uv.exe"
set "PY=%TOOLS%\venv\Scripts\python.exe"

echo.
echo  =====================================================================
echo   Video Redline - one-time setup
echo  =====================================================================
echo.
echo   This installs the speech tools that find the "um"s, "uh"s, pauses
echo   and stutters in your videos.
echo.
echo   * It downloads about 1.3 GB, ONCE (from github.com, pypi.org and huggingface.co,
echo     and from the file servers those sites pass you on to).
echo     Allow 5 to 15 minutes.
echo   * Everything goes into this folder:
echo       "%TOOLS%"
echo   * Nothing else on your computer is changed. No admin rights needed
echo     (a few PCs need one free Microsoft component first; this file checks).
echo   * Afterwards your videos never leave your computer.
echo.
if defined VRT_NO_PAUSE goto start
echo   Press any key to start, or close this window to cancel.
pause >nul
:start

rem ---- is this folder inside a cloud-synced folder? (checked BEFORE anything is downloaded) ----------
rem While a video is transcribed it is copied into this folder (tmp, then jobs-PORT), and setup puts about 1.5 GB here.
rem In a OneDrive, Dropbox, iCloud or Google Drive folder that service would upload all of it. The names are the same list
rem as SYNC_SERVICES in vrt_server.py (the helper checks again each time it starts). The folder path is only ever PRINTED
rem by the set command into findstr and never put into a command line, so an ampersand, caret, percent sign, bracket or
rem exclamation mark in a folder name cannot break the check.
set "VRT_CHECK_PATH=%TOOLS%"
set "SYNC_LABEL="
call :sync_key "onedrive" "OneDrive"
call :sync_key "dropbox" "Dropbox"
call :sync_key "icloud" "iCloud"
call :sync_key "mobile documents" "iCloud"
call :sync_key "com~apple~clouddocs" "iCloud"
call :sync_key "google drive" "Google Drive"
call :sync_key "googledrive" "Google Drive"
call :sync_key "my drive" "Google Drive"
set "VRT_CHECK_PATH="
if defined SYNC_LABEL goto sync_ask
:folder_ok
if defined VRT_STOP_AFTER_FOLDER_CHECK goto folder_check_only

rem ---- long folder names can break Windows programs ------------------------------------------
rem (the 91st character of the path exists only when the path is longer than 90 characters)
if not "%TOOLS:~90,1%"=="" echo   NOTE: this folder's path is quite long. If anything fails, move the whole Video Redline folder (the one that has video-redline.html and the tools folder inside it) to a short place inside your own user folder (for example "%EXAMPLE%") and run this file again.

rem ---- the Microsoft Visual C++ runtime ----------------------------------------------------------
rem The speech engines (onnxruntime, ctranslate2) need it. Most PCs have it; a freshly installed Windows may not.
rem Checking now saves downloading 1.3 GB that could not be used.
if defined VRT_SKIP_VC_CHECK goto vc_ok
set "SYS32=%SystemRoot%\System32"
if defined PROCESSOR_ARCHITEW6432 set "SYS32=%SystemRoot%\Sysnative"
if not exist "%SYS32%\msvcp140.dll" goto vc_missing
if not exist "%SYS32%\msvcp140_1.dll" goto vc_missing
:vc_ok

rem ---- is there room for a fresh install? (about 2 GB; checked before the big download) ----------------------
rem A full drive would otherwise be blamed on the internet. Skipped when the speech models are already there (a repair), on a
rem network path, and when the free space cannot be read. VRT_TEST_FREE_MB=<number> is the test switch for "this many MB are free".
if exist "%TOOLS%\hf-cache\hub" goto space_ok
call :free_mb
if not defined FREE_MB goto space_ok
if %FREE_MB% GEQ 2048 goto space_ok
goto no_space
:space_ok

rem ---- step 1: uv -------------------------------------------------------------------------
echo.
echo  [1 of 6] Getting the small installer (uv, 15 MB, from github.com) ...
if exist "%UV%" goto uv_ok
where curl.exe >nul 2>&1
if errorlevel 1 goto no_curl
if not exist "%TOOLS%\uv" mkdir "%TOOLS%\uv"
curl.exe -L --fail --silent --show-error --retry 3 -o "%TOOLS%\uv\uv-download.zip" "%UV_ZIP_URL%"
if errorlevel 1 goto net_fail
rem check the download against the checksum published next to it
set "EXPECTED="
for /f "tokens=1" %%H in ('curl.exe -L --fail --silent "%UV_ZIP_URL%.sha256"') do if not defined EXPECTED set "EXPECTED=%%H"
set "ACTUAL="
for /f "skip=1 tokens=*" %%H in ('certutil -hashfile "%TOOLS%\uv\uv-download.zip" SHA256') do if not defined ACTUAL set "ACTUAL=%%H"
if defined ACTUAL set "ACTUAL=%ACTUAL: =%"
if not defined EXPECTED goto hash_fail
if /I not "%EXPECTED%"=="%ACTUAL%" goto hash_fail
tar.exe -xf "%TOOLS%\uv\uv-download.zip" -C "%TOOLS%\uv"
if errorlevel 1 goto fail_generic
del "%TOOLS%\uv\uv-download.zip" >nul 2>&1
if not exist "%UV%" goto fail_generic
:uv_ok
echo        done.

rem ---- step 2: python ---------------------------------------------------------------------
echo.
echo  [2 of 6] Getting a private copy of Python (about 25 MB, from github.com) ...
rem (when the folder was moved, this also repairs the python\cpython-3.12-... link that pointed at the old place)
"%UV%" python install 3.12 --no-bin --no-registry
if errorlevel 1 goto net_fail
echo        done.

rem ---- step 3: virtual environment --------------------------------------------------------
echo.
echo  [3 of 6] Preparing the working space ...
if not exist "%PY%" goto venv_make
rem It exists - but does it still work, and does it belong to THIS folder? (Moving, renaming or copying the folder
rem after setup leaves it pointing at the old place; "python.exe" then stops with a cryptic error.)
"%PY%" "%TOOLS%\transcribe.py" --check-venv >nul 2>&1
if not errorlevel 1 goto venv_ok
echo        This folder was moved, renamed or copied after setup. Repairing the working space ...
call :stop_helper
"%UV%" venv "%TOOLS%\venv" --python 3.12 --allow-existing
if errorlevel 1 goto venv_rebuild
"%PY%" "%TOOLS%\transcribe.py" --check-venv >nul 2>&1
if not errorlevel 1 goto venv_ok
:venv_rebuild
echo        Rebuilding it from scratch (this downloads the speech tools again, about 100 MB) ...
if exist "%TOOLS%\venv" rmdir /s /q "%TOOLS%\venv"
:venv_make
"%UV%" venv "%TOOLS%\venv" --python 3.12 --clear
if errorlevel 1 goto fail_generic
:venv_ok
echo        done.

rem ---- step 4: packages -------------------------------------------------------------------
echo.
echo  [4 of 6] Installing the speech tools (about 100 MB download from pypi.org) ...
"%UV%" pip install --python "%PY%" -r "%TOOLS%\requirements.txt"
if errorlevel 1 goto net_fail
rem Can every package really start on this PC? Finding out now saves the 1.1 GB model download below.
"%PY%" "%TOOLS%\transcribe.py" --check-packages
if errorlevel 1 goto pkg_fail
echo        done.

rem ---- step 5: models ---------------------------------------------------------------------
echo.
echo  [5 of 6] Downloading the speech models from huggingface.co. This is the big one: about 1.1 GB, once.
echo           A progress bar is shown for each file. If it stops, run this file again:
echo           it continues where it left off. Models that are already complete are not downloaded again.
echo.
"%PY%" "%TOOLS%\transcribe.py" --download-models
if errorlevel 1 goto model_fail

rem ---- step 6: self-test ------------------------------------------------------------------
echo.
echo  [6 of 6] Quick self-test ...
"%PY%" "%TOOLS%\transcribe.py" --self-test
if errorlevel 1 goto test_fail

rem ---- tidy up ----------------------------------------------------------------------------
:tidy_up
if exist "%TOOLS%\uv-cache" rmdir /s /q "%TOOLS%\uv-cache" >nul 2>&1
rem tmp: a helper that runs from this folder (hidden, or in a window of its own) keeps its job folder tmp\jobs-<port> there, with a finished
rem transcript that nobody has fetched yet. So tmp is not deleted as a whole: the helper's own tidy-up (the one it makes when it starts)
rem deletes only what no running helper owns, and the empty folder tmp goes last. The folder name travels in a setting, not in the command.
rem Setup is no helper and owns no job folder, so it takes a name that is none of the job folder names (the helper's own name is jobs
rem until it claims jobs-<port>): the old shared folder tmp\jobs of a very old helper then counts as somebody else's, like any other.
set "VRT_TOOLS=%TOOLS%"
"%PY%" -c "import os,sys; sys.path.insert(0,os.environ['VRT_TOOLS']); import vrt_server as v; v._instance['name']='setup'; v.clean_old_job_folders(); a=v.other_helpers_alive(); a or v.clean_stale_run_dirs(); a or v.clean_spawn_lock()" >nul 2>&1
set "VRT_TOOLS="
if exist "%TOOLS%\tmp" rmdir "%TOOLS%\tmp" >nul 2>&1

:all_done
echo.
echo  =====================================================================
echo   ALL DONE. Setup is finished and the self-test passed.
echo.
echo   To use the "Create transcript and find cuts" button in Video Redline,
echo   the helper (a small program) has to be running.
echo.
if exist "%TOOLS%\setup-autostart-windows.bat" goto done_auto
echo   Start it by hand each time: double-click "start-helper-windows.bat"
echo   (in this same folder) and leave its window open while you work in
echo   Video Redline.
echo   (Windows can also start the helper by itself when you sign in. The file for that
echo   belongs to the Video Redline download, but this folder does not have it:
echo   copy the complete tools folder from the download to use it.)
goto done_other
:done_auto
echo   Next: double-click "setup-autostart-windows.bat" in this folder to add the
echo   Video Redline icon. After that, open Video Redline with that icon: it starts
echo   the helper if needed. The helper then also starts by itself, hidden, each
echo   time you sign in to Windows.
if not defined VRT_NO_PAUSE echo   (Setup asks you about this next, so you need not open the file yourself: answer Y and it does the same.)
echo   If you would rather not, double-click "start-helper-windows.bat" each time
echo   (in this same folder) and leave its window open while you work in
echo   Video Redline.
:done_other
echo.
echo   Or, without the button: drag a video onto "transcribe-windows.bat"
echo   (in this same folder). See README.md for details.
echo   Please do not move or rename this folder from now on.
echo  =====================================================================
echo.
goto autostart_offer

rem ---- optional: offer the automatic start (Windows) ---------------------------------------------------
rem Only when a person is at the keyboard (VRT_NO_PAUSE is the test switch for "nobody is") and the file that does it is in
rem this folder. Enter, a closed input or anything but a plain Y or yes means NO and changes nothing.
:autostart_offer
if defined VRT_NO_PAUSE goto end
if not exist "%TOOLS%\setup-autostart-windows.bat" goto end
echo  ---------------------------------------------------------------------
echo   Optional: start the helper by itself?
echo.
echo   If you say yes, the helper starts hidden (no window) each time you sign in to
echo   Windows. This adds one start-up setting to YOUR Windows user settings and a
echo   "Video Redline" icon to your Desktop and Start menu. No administrator rights.
echo   Open Video Redline with that icon from then on. If you stop the helper later,
echo   that icon starts it again.
if exist "%TOOLS%\remove-autostart-windows.bat" echo   You can undo it later with remove-autostart-windows.bat (same folder).
echo   If you say no, nothing is changed. You can run setup-autostart-windows.bat any time later.
echo  ---------------------------------------------------------------------
echo.
set "ANS="
set /p "ANS=  Start the helper by itself? (Y = yes, Enter = no): "
if not defined ANS goto end
rem only a plain Y (or the word yes) says yes: anything else, even a word that merely starts with Y, means no
set "ANS=%ANS:"=%"
if not defined ANS goto end
set "ANS=%ANS: =%"
if not defined ANS goto end
if /i "%ANS%"=="Y" goto autostart_go
if /i "%ANS%"=="yes" goto autostart_go
goto end

:autostart_go
echo.
rem (/yes: you have just answered the question, so that file does not ask it again; it is called from inside the folder, see :stop_call)
pushd "%TOOLS%"
call .\setup-autostart-windows.bat /yes
set "AS_RC=%errorlevel%"
popd
title Video Redline - one-time setup
if "%AS_RC%"=="0" goto autostart_done
echo.
echo   Setup itself is finished. The automatic start did not finish: read the lines above to see why. You can run
echo   setup-autostart-windows.bat again whenever you like. Starting the helper by hand (start-helper-windows.bat) works as before.
echo   If the lines above say that other people can change this folder, or that it is inside a synchronised folder,
echo   move the whole Video Redline folder (the one that has video-redline.html and the tools folder inside it)
echo   into your own user folder (for example "%EXAMPLE%"), run setup-windows.bat there once,
echo   and say yes to the question at its end.
echo   Before you move it, double-click stop-helper-windows.bat, because
echo   Windows will not move a folder while the helper runs from it.
goto end

:autostart_done
rem (that file has just waited for a key itself)
endlocal
exit /b 0

:in_zip
echo.
echo   PROBLEM: this file was opened from INSIDE the zip download. Windows unpacks only this one file
echo            and leaves the rest of the tool behind in the zip, so setup cannot work from here.
echo   WHAT TO DO:
echo     1. Close this window.
echo     2. Find the zip file you downloaded, right-click it, choose "Extract All...", click Browse, pick the folder
echo        VideoRedline inside your own user folder (for example "%EXAMPLE%"), and click Extract.
echo        (Make that folder first if it is not there.)
echo     3. Open the new folder that appears, then the folder called tools inside it, and double-click "setup-windows.bat" there.
goto fail_end

:not_extracted
echo.
echo   PROBLEM: the other files that belong with this one (such as requirements.txt and transcribe.py) are not in
echo            this folder. Setup needs the whole tool folder, not just this file.
echo   WHAT TO DO: if you have the zip download, right-click it, choose "Extract All..." and run setup-windows.bat from
echo   the new folder. If you copied this file by itself, copy the complete folder instead.
goto fail_end

:vc_missing
echo.
echo   PROBLEM: this PC is missing a free Microsoft component that the speech tools need
echo            ("Microsoft Visual C++ Redistributable 2015-2022", 64-bit).
echo   WHAT TO DO (about 2 minutes, internet needed once):
echo     1. Copy this web address into your web browser and press Enter:
echo           https://aka.ms/vs/17/release/vc_redist.x64.exe
echo        A file called vc_redist.x64.exe downloads.
echo     2. Open that file, tick "I agree to the license terms", click Install, and click Yes when Windows asks for
echo        permission. This one step needs an administrator - ask your IT person if you do not have the rights.
echo     3. Close this window and double-click setup-windows.bat again.
goto fail_end

:no_curl
echo.
echo   PROBLEM: this version of Windows has no "curl" program (it is built in to Windows 10 version 1803 and later).
echo   WHAT TO DO: run Windows Update, or ask your IT person to run setup for you.
goto fail_end

:no_space
echo.
echo   PROBLEM: the drive this folder is on has only about %FREE_MB% MB free. Setup needs about 2 GB (it downloads 1.3 GB).
echo   WHAT TO DO: free up some space on that drive (empty the Recycle Bin, delete files you do not need), then
echo   double-click this file again. Nothing was downloaded.
goto fail_end

:net_fail
echo.
echo   PROBLEM: a download failed.
echo   WHAT TO DO: check that this computer is connected to the internet and that a firewall or VPN is not blocking
echo   github.com, githubusercontent.com, pypi.org, pythonhosted.org, huggingface.co or hf.co (each site passes
echo   the files on to a file server of its own). Then double-click this file again - it picks up where it stopped.
call :space_note
goto fail_end

:hash_fail
echo.
echo   PROBLEM: the downloaded installer did not pass its safety check, so it was not used.
echo   WHAT TO DO: delete the folder "uv" inside this folder and run this file again. If it keeps failing, a network
echo   filter may be changing downloads.
del "%TOOLS%\uv\uv-download.zip" >nul 2>&1
goto fail_end

:pkg_fail
echo.
echo   PROBLEM: the speech tools were installed but cannot start on this computer.
echo   WHAT TO DO: follow the "WHAT TO DO" lines just above this message, then double-click this file again.
goto fail_end

:model_fail
echo.
echo   PROBLEM: the speech models could not be downloaded completely.
echo   WHAT TO DO: check the internet connection (and that a firewall or VPN is not blocking huggingface.co or hf.co, the
echo   file server the models come from) and run this file again. It continues where it left off.
call :space_note
goto fail_end

:test_fail
echo.
echo   PROBLEM: the self-test did not pass.
echo   WHAT TO DO: if the lines above mention a missing Microsoft component, follow them first. Otherwise run this
echo   file once more. If it fails again, send the file "logs\last-error.txt" (in this folder) to
echo   the person who invited you to the beta.
goto fail_end

:fail_generic
echo.
echo   PROBLEM: something went wrong during setup.
echo   WHAT TO DO: run this file again. If it fails again, send a photo or copy of this window to the person who invited you to the beta.
goto fail_end

:fail_end
echo.
if not defined VRT_NO_PAUSE pause
endlocal
exit /b 1

:sync_ask
echo.
echo  ---------------------------------------------------------------------
echo   WARNING: this folder is inside a folder that %SYNC_LABEL% synchronises:
echo       "%TOOLS%"
echo.
echo   Why it matters: while a video is being transcribed, a copy of it is kept
echo   in this folder. %SYNC_LABEL% could upload that copy to the internet (and the
echo   1.5 GB of speech tools too).
echo.
echo   WHAT TO DO (recommended): close this window, move the whole Video Redline
echo   folder (the one that has video-redline.html and the tools folder inside it)
echo   into your own user folder (for example "%EXAMPLE%"), and run
echo   setup-windows.bat from there.
echo.
echo   If a Video Redline helper already runs from this folder (it may run without a
echo   window), double-click stop-helper-windows.bat first: Windows will not move a
echo   folder while the helper runs from it.
echo.
echo   To stop now, just press Enter. To go on anyway, type C and press Enter.
echo  ---------------------------------------------------------------------
echo.
set "ANS="
set /p "ANS=  Your choice (Enter = stop, C = continue anyway): "
if not defined ANS goto sync_stop
rem only a plain C (or the word continue) goes on: anything else, even a word that merely starts with C, stops
set "ANS=%ANS:"=%"
if not defined ANS goto sync_stop
set "ANS=%ANS: =%"
if not defined ANS goto sync_stop
if /i "%ANS%"=="C" goto sync_go
if /i "%ANS%"=="continue" goto sync_go
:sync_stop
echo.
echo   Setup was stopped. Nothing was downloaded and nothing was changed.
echo   Move the whole Video Redline folder (the one that has video-redline.html and the tools folder inside it) into your own user folder (for example "%EXAMPLE%") and run setup-windows.bat from there.
echo   Before you move it, double-click stop-helper-windows.bat, because Windows will not move a folder while the helper runs from it.
goto fail_end

:sync_go
echo.
echo   Going on at your request. Remember: videos you transcribe will be kept in this folder for a while.
goto folder_ok

:folder_check_only
echo.
echo   Folder check finished (VRT_STOP_AFTER_FOLDER_CHECK is set): stopping before any download.
goto end

:end
if not defined VRT_NO_PAUSE pause
endlocal
exit /b 0

rem ---- subroutine: end a helper that may be running (hidden) from this folder, before the working space is repaired ----------
rem Such a helper holds files of venv and python, so a repair or rebuild would fail or be left half done. stop-helper-windows.bat
rem (one of the Windows start-up files; it stops only the helper of THIS folder) is called when it is in this folder; if
rem not, there is nothing to call and the person is only told what to do. Either way setup goes on.
:stop_helper
if exist "%TOOLS%\stop-helper-windows.bat" goto stop_call
echo        If a helper is running from this folder (for example one that started by itself, without a window), it holds
echo        files that this repair needs. End it first, the way README.md describes. If the repair fails, do that and run
echo        this file again.
exit /b 0
:stop_call
echo        A helper may be running from this folder and holding files that this repair needs. Stopping it first ...
setlocal
rem (that file waits for a key at its end unless told not to)
set "VRT_NO_PAUSE=1"
rem (called by its short name from inside the folder: a "call" with the whole path would read a percent sign in the folder name again)
pushd "%TOOLS%"
call .\stop-helper-windows.bat
popd
endlocal
title Video Redline - one-time setup
exit /b 0

rem ---- subroutine: does the folder path contain this name? (case does not matter) ------------------
rem %1 = the name to look for (in quotes), %2 = what to call it. Sets SYNC_LABEL the first time something matches.
:sync_key
set VRT_CHECK_PATH | findstr /i /c:%1 >nul 2>&1
if not errorlevel 1 if not defined SYNC_LABEL set "SYNC_LABEL=%~2"
exit /b 0

rem ---- subroutine: whole megabytes free on the drive of this folder -> FREE_MB (empty when it cannot be read) ----------
:free_mb
set "FREE_MB="
if defined VRT_TEST_FREE_MB set "FREE_MB=%VRT_TEST_FREE_MB%"
if not defined VRT_TEST_FREE_MB if "%TOOLS:~1,1%"==":" for /f "usebackq delims=" %%A in (`powershell -NoProfile -NonInteractive -Command "try { [math]::Floor([IO.DriveInfo]::new('%TOOLS:~0,2%').AvailableFreeSpace / 1MB) } catch { }" 2^>nul`) do set "FREE_MB=%%A"
if not defined FREE_MB exit /b 0
echo %FREE_MB%| findstr /r "^[0-9][0-9]*$" >nul || set "FREE_MB="
exit /b 0

rem ---- subroutine: a nearly full drive is said out loud after a failed download ---------------------------------------
:space_note
call :free_mb
if not defined FREE_MB exit /b 0
if %FREE_MB% GEQ 1024 exit /b 0
echo.
echo   NOTE: the drive this folder is on has only about %FREE_MB% MB free. A nearly full drive also makes downloads fail:
echo   free up some space (setup needs about 2 GB), then run this file again.
exit /b 0
