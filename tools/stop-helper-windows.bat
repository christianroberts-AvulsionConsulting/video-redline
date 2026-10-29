@echo off
rem ============================================================================================
rem  Video Redline - stop the helper that runs by itself (Windows)
rem  Double-click this file to stop the helper that runs from THIS folder (the hidden one, and one that was
rem  started by hand with start-helper-windows.bat).
rem  Use it when the page says the helper is busy and you want a fresh start, when you want
rem  the helper off for now, or before you move, rename or replace this folder (Windows will not
rem  move a folder while the helper runs from it). Nothing is removed: the helper starts again when you
rem  double-click the "Video Redline" icon, and, if you ran setup-autostart-windows.bat, the next time
rem  you sign in to Windows. (The Video Redline page does NOT start it: a web page cannot.)
rem  (To switch the automatic start off for good, use remove-autostart-windows.bat.)
rem ============================================================================================
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul 2>&1
title Video Redline - stop the helper

set "PYTHONHOME="
set "PYTHONPATH="
set "PYTHONSTARTUP="
set "PYTHONUSERBASE="

set "TOOLS=%~dp0"
if "%TOOLS:~-1%"=="\" set "TOOLS=%TOOLS:~0,-1%"
set "PY=%TOOLS%\venv\Scripts\python.exe"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "VRT_TOOLS=%TOOLS%"

if not exist "%PS%" goto no_powershell

echo.
echo   Stopping the Video Redline helper ...

rem Only programs that run THIS folder's helper_launcher.pyw (the hidden helper) or vrt_server.py (a helper started by hand)
rem are stopped (never other Python programs).
"%PS%" -NoProfile -NonInteractive -Command "$t=$env:VRT_TOOLS.TrimEnd('\'); $keys=@(($t+'\helper_launcher.pyw'),($t+'\vrt_server.py')); $n=0; foreach($p in Get-CimInstance Win32_Process){ if($p.CommandLine -and ($p.Name -match '^pythonw?\.exe$')){ $c=$p.CommandLine.Replace('/','\'); foreach($k in $keys){ if($c.IndexOf($k,[StringComparison]::OrdinalIgnoreCase) -ge 0){ Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $n++; break } } } }; Start-Sleep -Milliseconds 700; exit $n"
set "RC=%errorlevel%"

rem A helper that is stopped in the middle of a transcript leaves a copy of the video (tmp\jobs-*) and the sound taken from it
rem (tmp\run-*) behind. Clear both (see :tidy at the end of this file).
call :tidy

echo.
if "%RC%"=="0" goto not_running
echo   The helper has been stopped.
rem (setup-windows.bat calls this file in the middle of a repair and sets VRT_NO_PAUSE: no advice on how to start it again then)
if defined VRT_NO_PAUSE goto end_ok
echo   To start it again, double-click the "Video Redline" icon on your Desktop (it opens Video Redline too,
echo   and you can close that page). If you ran setup-autostart-windows.bat, it also starts by itself
echo   the next time you sign in to Windows.
echo   No icon? Double-click setup-autostart-windows.bat once (same folder), or double-click
echo   start-helper-windows.bat and leave its window open.
echo   (A helper window that you opened yourself with start-helper-windows.bat can be closed now.)
goto end_ok

:not_running
echo   The helper was not running. Nothing to stop.
if defined VRT_NO_PAUSE goto end_ok
echo   To start it, double-click the "Video Redline" icon on your Desktop.
echo   No icon? Double-click setup-autostart-windows.bat once (same folder), or double-click
echo   start-helper-windows.bat and leave its window open.
goto end_ok

:no_powershell
echo.
echo   PROBLEM: this file needs "Windows PowerShell", which is part of Windows, and it was not found.
echo   WHAT TO DO: close the helper in Task Manager instead: look for "pythonw.exe" with the Video Redline
echo   folder in its command line, or sign out of Windows and sign in again.
echo.
if not defined VRT_NO_PAUSE pause
endlocal & exit /b 1

:end_ok
if "%TIDY%"=="3" goto note_left
if "%TIDY%"=="4" goto note_running
goto end_pause
:note_left
echo.
echo   Windows would not let me delete everything the helper was working on. It is in the folder "tmp"
echo   inside the tools folder. It is safe to delete that folder yourself while no helper is running.
goto end_pause
:note_running
echo.
echo   A helper is still running from this folder, so I left its temporary files alone.
echo   If you started it by hand, close its window to stop it.
:end_pause
echo.
if not defined VRT_NO_PAUSE pause
endlocal & exit /b 0

rem ---- subroutine: delete what a stopped helper left in tmp\ --------------------------------------
rem Sets TIDY: 0 = nothing is left, 3 = Windows would not let go of something, 4 = a helper is still running from this
rem folder (for example one started by hand: its files are not touched), 9 = I could not try (no private Python: setup-windows.bat has not been run, or did not finish).
rem This is the same tidy-up that setup-windows.bat makes at its end (both ask the helper's own functions in vrt_server.py).
rem clean_stale_run_dirs(0) deletes every tmp\run-* folder; the guard is other_helpers_alive(), as in vrt_server.main().
:tidy
set "TIDY=9"
if not exist "%PY%" exit /b 0
if not exist "%TOOLS%\vrt_server.py" exit /b 0
set "TRY=0"
:tidy_again
"%PY%" -c "import os,sys; sys.path.insert(0,os.environ['VRT_TOOLS']); import vrt_server as v; v.clean_old_job_folders(); a=v.other_helpers_alive(); a or v.clean_stale_run_dirs(0); sys.exit(4 if a else 3 if (v.run_dir_names() or [n for n in v._other_job_names() if os.path.isdir(os.path.join(v.TMP_DIR,n))]) else 0)" >nul 2>&1
set "TIDY=%errorlevel%"
if "%TIDY%"=="0" exit /b 0
if "%TIDY%"=="4" exit /b 0
if not "%TIDY%"=="3" goto tidy_unknown
rem Windows may still be closing the files of the process that was just stopped: wait a moment and try once more.
set /a TRY+=1
if %TRY% GEQ 3 exit /b 0
ping -n 3 127.0.0.1 >nul
goto tidy_again
:tidy_unknown
set "TIDY=9"
exit /b 0
