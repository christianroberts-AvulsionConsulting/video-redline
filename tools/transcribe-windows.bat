@echo off
rem ============================================================================================
rem  Video Redline Tool - transcribe a video (Windows)
rem  Drag a video onto this file, or double-click it and drop a video into the window.
rem  Writes "<video name>-transcript.json" next to the video.
rem ============================================================================================
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul 2>&1
title Video Redline Tool - transcribing

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

set "FAILED=0"
if not "%~1"=="" goto next_file

echo.
echo   Drag your video file into this window, then press Enter.
echo   (Or close this window and drag the video onto "transcribe-windows.bat" instead.)
echo.
set "VIDEO="
set /p "VIDEO=  Video file: "
if not defined VIDEO goto end_fail
set "VIDEO=%VIDEO:"=%"
echo.
echo   Working on: "%VIDEO%"
"%PY%" "%TOOLS%\transcribe.py" "%VIDEO%"
if errorlevel 1 set "FAILED=1"
goto finished

:next_file
if "%~1"=="" goto finished
echo.
echo  ---------------------------------------------------------------------
echo   Working on: "%~1"
echo  ---------------------------------------------------------------------
"%PY%" "%TOOLS%\transcribe.py" "%~1"
if errorlevel 1 set "FAILED=1"
shift
goto next_file

:finished
echo.
if "%FAILED%"=="1" echo   Something did not work - see the PROBLEM / WHAT TO DO lines above.
if "%FAILED%"=="0" echo   All finished. The transcript file(s) are next to your video(s).
echo.
if not defined VRT_NO_PAUSE (
    echo   Press any key to close this window.
    pause >nul
)
endlocal & exit /b %FAILED%

:in_zip
echo.
echo   PROBLEM: this file was opened from INSIDE the zip download. Windows unpacks only this one file
echo            and leaves the rest of the tool behind in the zip.
echo   WHAT TO DO: close this window, right-click the zip file you downloaded, choose "Extract All...", and use
echo   the files in the NEW folder. Run "setup-windows.bat" there first.
goto end_fail

:not_extracted
echo.
echo   PROBLEM: the other files that belong with this one (such as transcribe.py) are not in this folder.
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
