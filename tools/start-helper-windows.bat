@echo off
rem ============================================================================================
rem  Video Redline Tool - start the helper (Windows)
rem  Double-click this file, then LEAVE ITS WINDOW OPEN while you use the Video Redline page.
rem  The page can then make a transcript for you with one click ("Create transcript").
rem  Everything stays on your computer. To stop the helper, simply close this window.
rem  (If a helper is ALREADY running, in another window or hidden, this window only says so; closing it stops nothing.)
rem  This file is the hand start, the way that always works. With setup-autostart-windows.bat (a separate file of the Video Redline
rem  app, in this same folder) the helper starts by itself, hidden, at every sign-in, and the "Video Redline" icon on the Desktop
rem  starts it first if needed and opens the page: for most people that icon is the way to open Video Redline.
rem ============================================================================================
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul 2>&1
title Video Redline helper - leave this window open

rem Settings left on this PC by other software (another Python, CAD or GIS programs) would break our own private
rem Python, so they are cleared for this window only.
set "PYTHONHOME="
set "PYTHONPATH="
set "PYTHONSTARTUP="
set "PYTHONUSERBASE="

set "TOOLS=%~dp0"
if "%TOOLS:~-1%"=="\" set "TOOLS=%TOOLS:~0,-1%"
set "PY=%TOOLS%\venv\Scripts\python.exe"

set "HF_HOME=%TOOLS%\hf-cache"
set "HF_HUB_OFFLINE=1"
set "HF_HUB_DISABLE_TELEMETRY=1"
set "HF_HUB_DISABLE_SYMLINKS_WARNING=1"
set "PYTHONUTF8=1"

rem ---- was this file opened from inside the zip download? --------------------------------------
set "FOLDERNAME=-"
for %%I in ("%TOOLS%") do if not "%%~nxI"=="" set "FOLDERNAME=%%~nxI"
if /i "%FOLDERNAME:~-4%"==".zip" goto in_zip
if /i "%FOLDERNAME:~0,4%"=="Temp" if /i "%FOLDERNAME:~5,1%"=="_" goto in_zip
if /i "%FOLDERNAME:~0,3%"=="7zO" goto in_zip
if /i "%FOLDERNAME:~0,6%"=="Rar$EX" goto in_zip
if not exist "%TOOLS%\transcribe.py" goto not_extracted
if not exist "%TOOLS%\vrt_server.py" goto not_extracted

if exist "%PY%" goto check_python
echo.
echo   The one-time setup has not been run yet.
echo   Please double-click "setup-windows.bat" first (in this same folder), then try again.
echo.
goto end_fail

:check_python
rem Does the private Python still run, and does it belong to THIS folder? (Moving, renaming or copying the folder
rem after setup leaves it pointing at the old place.)
"%PY%" "%TOOLS%\transcribe.py" --check-venv >nul 2>&1
if errorlevel 1 goto moved

echo.
echo   Starting the Video Redline helper. This takes a few seconds ...
echo.
"%PY%" "%TOOLS%\vrt_server.py"
set "RC=%errorlevel%"
echo.
if "%RC%"=="10" goto already
if "%RC%"=="0" goto stopped
echo   PROBLEM: the helper stopped unexpectedly (code %RC%).
echo   WHAT TO DO: double-click "start-helper-windows.bat" again. If it keeps stopping, send a screenshot of this
echo   window to the person who invited you to the beta.
goto finished

:already
title Video Redline helper - already running
echo   Nothing more to do: the helper is already running (in another window, or hidden).
echo   Closing this window does not stop that helper.
rem (the icon is named only when the file that makes it is in this folder. Even then it may not exist yet: a person who starts the helper
rem  by hand and never ran that file has no icon, so the way without it is named too)
if not exist "%TOOLS%\setup-autostart-windows.bat" goto finished
echo   To open Video Redline, double-click the "Video Redline" icon on your Desktop.
echo   No icon yet? Double-click "setup-autostart-windows.bat" (in this same folder) once to add it.
echo   If you would rather not, double-click "video-redline.html" (next to the tools folder) instead.
goto finished

:stopped
echo   The helper has stopped. The Video Redline page can no longer make transcripts.
if exist "%TOOLS%\setup-autostart-windows.bat" goto stopped_icon
echo   To use it again, double-click "start-helper-windows.bat".
goto finished
:stopped_icon
echo   To start it again, double-click the "Video Redline" icon on your Desktop (it starts the helper and
echo   opens Video Redline). No icon yet? Double-click "setup-autostart-windows.bat" (in this same folder)
echo   once: it adds the icon and makes the helper start by itself at every sign-in. Or, if you would
echo   rather not, double-click "start-helper-windows.bat" again and leave its window open.

:finished
echo.
if not defined VRT_NO_PAUSE (
    echo   Press any key to close this window.
    pause >nul
)
endlocal & exit /b %RC%

:in_zip
echo.
echo   PROBLEM: this file was opened from INSIDE the zip download. Windows unpacks only this one file
echo            and leaves the rest of the tool behind in the zip.
echo   WHAT TO DO: close this window, right-click the zip file you downloaded, choose "Extract All...", and use
echo   the files in the NEW folder. Run "setup-windows.bat" there first.
goto end_fail

:not_extracted
echo.
echo   PROBLEM: the other files that belong with this one (such as transcribe.py and vrt_server.py) are not in this folder.
echo   WHAT TO DO: use the complete tool folder. If you have the zip download, right-click it, choose "Extract All..."
echo   and run "setup-windows.bat" from the new folder.
goto end_fail

:moved
echo.
echo   PROBLEM: this tools folder was moved, renamed or copied after setup, so the speech tools cannot find their
echo            private Python any more.
echo   WHAT TO DO: double-click "setup-windows.bat" (in this same folder) once more. It repairs the folder, usually in
echo   under a minute, and keeps the speech models. Please do not move or rename the folder after setup.
goto end_fail

:end_fail
echo.
if not defined VRT_NO_PAUSE pause
endlocal
exit /b 1
