@echo off
rem ============================================================================================
rem  Video Redline - make the helper start by itself (Windows)
rem  Double-click this file ONCE (after setup-windows.bat). From then on the helper (the part that makes
rem  transcripts) starts hidden each time you sign in to Windows, so "Create transcript" finds it. It also
rem  puts a "Video Redline" icon on your Desktop and in the Start menu: if the helper is not running (you
rem  stopped it, for example), the icon starts it first. The Video Redline page itself does NOT start the
rem  helper (a web page cannot).
rem  No administrator rights. It adds ONE start-up entry and two icons for YOUR Windows user only. To take
rem  them out again, double-click remove-autostart-windows.bat. See AUTOSTART.md for the details.
rem
rem  Switches (for tests and IT people; you do not need them):
rem    /yes         do not ask the question first
rem    /dryrun      check everything and show what would be written, but change nothing
rem    /allow-sync  go on even when this folder is inside OneDrive, Dropbox, iCloud or Google Drive
rem    /allow-shared  go on even when other people who use this computer can change the files in this folder
rem ============================================================================================
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul 2>&1
title Video Redline - start the helper by itself

rem Settings left on this PC by other software (another Python, CAD or GIS programs) would break our own private
rem Python, so they are cleared for this window only.
set "PYTHONHOME="
set "PYTHONPATH="
set "PYTHONSTARTUP="
set "PYTHONUSERBASE="

rem (this must come before the switches are read: SHIFT also moves the file's own name, and the folder would be lost)
set "TOOLS=%~dp0"
if "%TOOLS:~-1%"=="\" set "TOOLS=%TOOLS:~0,-1%"

set "ASSUME_YES="
set "DRY_RUN="
set "ALLOW_SYNC="
set "ALLOW_SHARED="
:next_arg
if "%~1"=="" goto args_done
if /i "%~1"=="/yes" set "ASSUME_YES=1"
if /i "%~1"=="/dryrun" set "DRY_RUN=1"
if /i "%~1"=="/allow-sync" set "ALLOW_SYNC=1"
if /i "%~1"=="/allow-shared" set "ALLOW_SHARED=1"
shift
goto next_arg
:args_done

set "PY=%TOOLS%\venv\Scripts\python.exe"
set "PYW=%TOOLS%\venv\Scripts\pythonw.exe"
set "LAUNCH=%TOOLS%\helper_launcher.pyw"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

rem The folder and file names travel to PowerShell through these settings, so odd characters in a name cannot break anything.
set "VRT_TOOLS=%TOOLS%"
set "VRT_PYW=%PYW%"
set "VRT_LAUNCH=%LAUNCH%"

rem The helper listens on the first of 5 numbers in a row (47831 to 47835). Developers can move it with VRT_PORT.
set "PORT0=47831"
if defined VRT_PORT set "PORT0=%VRT_PORT%"

rem ---- was this file opened from inside the zip download? --------------------------------------
set "FOLDERNAME=-"
for %%I in ("%TOOLS%") do if not "%%~nxI"=="" set "FOLDERNAME=%%~nxI"
if /i "%FOLDERNAME:~-4%"==".zip" goto in_zip
if /i "%FOLDERNAME:~0,4%"=="Temp" if /i "%FOLDERNAME:~5,1%"=="_" goto in_zip
if /i "%FOLDERNAME:~0,3%"=="7zO" goto in_zip
if /i "%FOLDERNAME:~0,6%"=="Rar$EX" goto in_zip
if not exist "%TOOLS%\transcribe.py" goto not_extracted
if not exist "%TOOLS%\vrt_server.py" goto not_extracted
if not exist "%LAUNCH%" goto not_extracted

if not exist "%PS%" goto no_powershell

rem ---- has the one-time setup been done, and does it still belong to THIS folder? -----------------
if exist "%PYW%" goto check_python
echo.
echo   The one-time setup has not been run yet.
echo   Please double-click "setup-windows.bat" first (in this same folder), then run this file again.
goto fail_end

:check_python
"%PY%" "%TOOLS%\transcribe.py" --check-venv >nul 2>&1
if errorlevel 1 goto moved

rem ---- is this a good place for a helper that runs all the time? ---------------------------------
rem exit 2: a percent sign in the folder path   3: a cloud-synced folder   4: a network drive
"%PS%" -NoProfile -NonInteractive -Command "$t=$env:VRT_TOOLS; if($t -match '%%'){exit 2}; if($t -match '^\\\\'){exit 4}; if(($t -match '^[A-Za-z]:') -and ((New-Object IO.DriveInfo($t.Substring(0,2))).DriveType -eq 'Network')){exit 4}; if($t -match 'onedrive|dropbox|icloud|mobile documents|com~apple~clouddocs|google ?drive|my drive'){exit 3}; exit 0" >nul 2>&1
set "RC=%errorlevel%"
if "%RC%"=="2" goto bad_chars
if "%RC%"=="4" goto net_folder
if "%RC%"=="3" goto sync_folder
:folder_ok

rem Windows allows a start-up entry about 260 characters long. Ours is 61 plus twice the folder path.
if not "%TOOLS:~97,1%"=="" goto too_long

rem ---- can other people who use this computer change the files that a sign-in entry would start? ----
rem exit 5: Everyone, Authenticated Users or the group Users may add, change or delete files in this folder or in venv\Scripts
"%PS%" -NoProfile -NonInteractive -Command "$w=[Security.AccessControl.FileSystemRights]'WriteData,AppendData,Delete,ChangePermissions,TakeOwnership'; $s=@('S-1-1-0','S-1-5-11','S-1-5-32-545'); foreach($d in @($env:VRT_TOOLS,(Join-Path $env:VRT_TOOLS 'venv\Scripts'))){ if(-not (Test-Path -LiteralPath $d)){continue}; foreach($a in (Get-Acl -LiteralPath $d).Access){ if($a.AccessControlType -ne 'Allow'){continue}; if([int]$a.PropagationFlags -band 2){continue}; try{ $id=$a.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }catch{ continue }; if(($s -contains $id) -and (([int]$a.FileSystemRights -band [int]$w) -ne 0)){ exit 5 } } }; exit 0" >nul 2>&1
if "%errorlevel%"=="5" goto shared_folder
:shared_ok

if defined DRY_RUN goto dry_run

echo.
echo  =====================================================================
echo   Video Redline - start the helper by itself
echo  =====================================================================
echo.
echo   After this, the helper (the part that makes transcripts) is already running when you
echo   open Video Redline, so "Create transcript" works without you starting anything.
echo.
echo   1. One start-up setting is added to YOUR Windows user settings. It starts the helper in
echo      the background, with no window, each time you sign in to Windows. No administrator
echo      password is needed. Windows may tell you that a start-up app called "Python" was
echo      added: that is this helper.
echo   2. Two icons called "Video Redline" are put on your Desktop and in your Start menu.
echo      Double-click one to open Video Redline. If the helper is not running (you stopped
echo      it, for example), the icon starts it first. If your Desktop is kept in OneDrive,
echo      its icon is stored there, and OneDrive may copy it to your other computers.
echo   3. The Video Redline page does not start the helper (a web page cannot do that).
echo      Always open Video Redline with the icon.
echo   4. Nothing leaves this computer. A small log is kept in this folder: logs\helper.log
echo   5. To undo all of it: double-click "remove-autostart-windows.bat" (same folder).
echo.
if defined ASSUME_YES goto confirmed
choice /c YN /n /m "  Do you want to do this? (Y = yes, N = no) "
if errorlevel 2 goto cancelled
:confirmed

rem ---- step 1: the start-up entry ----------------------------------------------------------------
echo.
echo  [1 of 4] Adding the start-up entry to your Windows user settings ...
rem Only the Run value is written. (Earlier versions also registered a "videoreview" link so that the page could start the
rem helper. That never worked in a browser and nothing uses it, so it is not registered any more: remove-autostart-windows.bat
rem still takes it out if an earlier version left it behind.)
"%PS%" -NoProfile -NonInteractive -Command "try { $q=[char]34; $c=$q+$env:VRT_PYW+$q+' -E -X utf8 '+$q+$env:VRT_LAUNCH+$q; $g=[Microsoft.Win32.Registry]; $run='HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run'; $g::SetValue($run,'VideoReviewHelper',$c,'String'); if($g::GetValue($run,'VideoReviewHelper','') -ne $c){exit 3}; exit 0 } catch { exit 1 }"
if errorlevel 1 goto reg_fail
rem Windows remembers an entry that was switched off in Settings, Apps, Startup (a mark of its own). A fresh entry must not stay off.
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" /v VideoReviewHelper /f >nul 2>&1
echo        done.

rem ---- step 2: start the helper now ----------------------------------------------------------------
echo.
echo  [2 of 4] Starting the helper now ...
rem A helper that was started from another folder (a copy, or an older place) would keep the numbers busy: stop it.
"%PS%" -NoProfile -NonInteractive -Command "$k=$env:VRT_TOOLS.TrimEnd('\')+'\helper_launcher.pyw'; $seen=@{}; foreach($p in Get-CimInstance Win32_Process){ if($p.CommandLine -and ($p.Name -match '^pythonw?\.exe$')){ $c=$p.CommandLine.Replace('/','\'); if($c.IndexOf($k,[StringComparison]::OrdinalIgnoreCase) -ge 0){continue}; $i=$c.IndexOf('\helper_launcher.pyw',[StringComparison]::OrdinalIgnoreCase); if($i -lt 0){continue}; $ms=[regex]::Matches($c.Substring(0,$i),'(?:^|[\s\x22])([A-Za-z]:\\|\\\\)'); $f=''; if($ms.Count -gt 0){ $s=$ms[$ms.Count-1].Groups[1].Index; $f=$c.Substring($s,$i-$s).TrimEnd('\') }; Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; if(-not $seen.ContainsKey($f.ToLower())){ $seen[$f.ToLower()]=1; if($f){ Write-Host ('        Stopped a helper that was started from another folder: ' + $f) } else { Write-Host '        Stopped a helper that was started from another folder.' } } } }; if($seen.Count -gt 0){ Start-Sleep -Milliseconds 1500 }"
set "HAVE_CURL=1"
where curl.exe >nul 2>&1
if errorlevel 1 set "HAVE_CURL="
rem The helper is ALWAYS started with the command that was just registered, even when a helper already answers (one that was
rem started by hand, for example): that proves the command works on this PC. A launcher that runs writes the line
rem "[launcher] Starting." to logs\helper.log (or video-redline-helper.log in the temp folder); a second launcher then ends by itself.
"%PS%" -NoProfile -NonInteractive -Command "$q=[char]34; $t=$env:VRT_TOOLS; $tmp=$env:TEMP; if(-not $tmp){$tmp=$t}; $logs=@((Join-Path $t 'logs\helper.log'),(Join-Path $tmp 'video-redline-helper.log')); function Count-Starts($f){ if(Test-Path -LiteralPath $f){ @(Select-String -LiteralPath $f -SimpleMatch '[launcher] Starting.' -ErrorAction SilentlyContinue).Count } else { 0 } }; $b0=Count-Starts ($logs[0]); $b1=Count-Starts ($logs[1]); Start-Process -FilePath $env:VRT_PYW -ArgumentList '-E','-X','utf8',($q+$env:VRT_LAUNCH+$q) -WorkingDirectory $t; for($i=0;$i -lt 40;$i++){ Start-Sleep -Milliseconds 500; if(((Count-Starts ($logs[0])) -ne $b0) -or ((Count-Starts ($logs[1])) -ne $b1)){ exit 0 } }; exit 2"
set "RC=%errorlevel%"
if "%RC%"=="2" goto launcher_silent
if not "%RC%"=="0" goto start_fail
echo        started.

rem ---- step 3: does it answer? -------------------------------------------------------------------
:step3
echo.
echo  [3 of 4] Checking that the helper answers ...
set "NOCHECK="
if not defined HAVE_CURL goto no_curl
set "TRIES=0"
:wait_loop
call :probe_all
if defined HELPER_PORT if defined HELPER_READY goto verified
set /a TRIES+=1
if %TRIES% GEQ 40 goto verify_timeout
ping -n 2 127.0.0.1 >nul
goto wait_loop

:verified
echo        The helper answers (connection number %HELPER_PORT% on this computer only).
goto make_icons

:no_curl
set "NOCHECK=1"
echo        This version of Windows has no "curl" program, so I cannot check that the helper answers.

rem ---- step 4: the icons ---------------------------------------------------------------------------
:make_icons
echo.
echo  [4 of 4] Putting a "Video Redline" icon on your Desktop and in the Start menu ...
rem add-desktop-icon-windows.bat ends with 0 when at least one icon exists, and with 1 when none could be made
set "ICON_OK="
if not exist "%TOOLS%\add-desktop-icon-windows.bat" goto icons_done
call "%TOOLS%\add-desktop-icon-windows.bat" /quiet
if not errorlevel 1 set "ICON_OK=1"
:icons_done
echo.
echo  =====================================================================
if defined NOCHECK goto closing_nocheck
echo   OK. The helper now starts by itself.
goto closing_main
:closing_nocheck
echo   The start-up entry is in place and the helper was started, but I could not check that it answers.
if defined ICON_OK echo   Open Video Redline with its icon and press "Create transcript".
if not defined ICON_OK echo   Open Video Redline ^(see below^) and press "Create transcript".
:closing_main
echo.
echo   * Each time you sign in to Windows, it starts in the background, with no window.
if not defined ICON_OK goto closing_no_icon
echo   * The "Video Redline" icon opens Video Redline and starts the helper first if it
echo     is not running. Use that icon to open Video Redline: it always works.
echo   * To stop the helper for now: double-click "stop-helper-windows.bat".
echo     To start it again: double-click the "Video Redline" icon.
goto closing_rest
:closing_no_icon
echo   * No icon could be made, so open Video Redline by double-clicking "video-redline.html"
echo     ^(next to the tools folder^). Opening that file does not start the helper: the helper
echo     starts by itself each time you sign in to Windows.
echo   * If the helper is not running: double-click "start-helper-windows.bat" and leave its
echo     window open, or try "add-desktop-icon-windows.bat" again.
echo   * To stop the helper for now: double-click "stop-helper-windows.bat".
:closing_rest
echo   * To undo all of this: double-click "remove-autostart-windows.bat".
echo   * To move or rename this folder: first double-click "stop-helper-windows.bat"
echo     (Windows will not move it while the helper runs from it). Then run this
echo     file again from the new place. If you moved it without doing that,
echo     Windows may say it cannot find a file when you sign in: run this file again.
echo  =====================================================================
echo.
goto end_ok

:verify_timeout
echo.
if defined HELPER_PORT goto not_ready
echo   PROBLEM: the start-up entry was added, but the helper did not answer within 40 seconds.
echo   WHAT TO DO: wait a minute and run this file again. If it keeps failing, send the file
echo   "logs\helper.log" (in this folder) to the person who invited you to the beta. Its last lines:
echo.
"%PS%" -NoProfile -NonInteractive -Command "$f=Join-Path $env:VRT_TOOLS 'logs\helper.log'; if(Test-Path -LiteralPath $f){ Get-Content -LiteralPath $f -Tail 12 | ForEach-Object { Write-Host ('   ' + $_) } } else { Write-Host '   (there is no log yet: a security program may have blocked the start. Allow this Video Redline folder in it, then run this file again)' }"
goto fail_end

:not_ready
echo   PROBLEM: the helper is running (connection number %HELPER_PORT%), but its speech tools are not ready.
echo   WHAT TO DO: first double-click "stop-helper-windows.bat" (the helper runs from this folder, and the repair
echo   cannot replace files that it is using). Then double-click "setup-windows.bat" and wait for ALL DONE.
echo   Then run this file again. (If you moved or copied this folder, that is usually the reason.)
goto fail_end

:dry_run
echo.
echo   DRY RUN: everything checks out. Nothing was changed and nothing was started.
echo   It would add this start-up entry (name: VideoReviewHelper):
"%PS%" -NoProfile -NonInteractive -Command "$q=[char]34; Write-Host ('     ' + $q + $env:VRT_PYW + $q + ' -E -X utf8 ' + $q + $env:VRT_LAUNCH + $q)"
echo   then start the helper, and put a "Video Redline" icon on your Desktop and in your Start menu.
echo.
goto end_ok

rem ---- subroutines: is a helper answering on any of its 5 numbers? --------------------------------
rem Sets HELPER_PORT (and HELPER_READY=1 when its speech tools are ready) if one answers; clears them if none does.
:probe_all
set "HELPER_PORT="
set "HELPER_READY="
set /a PCUR=PORT0
set /a PEND=PORT0+4
:probe_next
call :probe_one %PCUR%
if defined HELPER_PORT exit /b 0
set /a PCUR+=1
if %PCUR% LEQ %PEND% goto probe_next
exit /b 1

:probe_one
curl.exe -s --max-time 2 "http://127.0.0.1:%~1/status" 2>nul | findstr /c:"video-review-helper" >nul
if errorlevel 1 exit /b 1
set "HELPER_PORT=%~1"
rem (the helper's answer contains the word ready, a quote mark, a colon and the word true: the dot below stands for the quote mark)
curl.exe -s --max-time 2 "http://127.0.0.1:%~1/status" 2>nul | findstr /r /c:"ready.:[ ]*true" >nul
if not errorlevel 1 set "HELPER_READY=1"
exit /b 0

rem ---- problems -------------------------------------------------------------------------------------
:in_zip
echo.
echo   PROBLEM: this file was opened from INSIDE the zip download. Windows unpacks only this one file
echo            and leaves the rest of the tool behind in the zip.
echo   WHAT TO DO: close this window, right-click the zip file you downloaded, choose "Extract All...", and use
echo   the files in the NEW folder. Run "setup-windows.bat" there first, then this file.
goto fail_end

:not_extracted
echo.
echo   PROBLEM: the other files that belong with this one (such as transcribe.py and vrt_server.py) are not in this folder.
echo   WHAT TO DO: use the complete tools folder. If you have the zip download, right-click it, choose "Extract All..."
echo   and run "setup-windows.bat" from the new folder, then this file.
goto fail_end

:no_powershell
echo.
echo   PROBLEM: this file needs "Windows PowerShell", which is part of Windows, and it was not found
echo            (it should be here: "%PS%").
echo   WHAT TO DO: run Windows Update, or ask your IT person to run this for you.
goto fail_end

:moved
echo.
echo   PROBLEM: this tools folder was moved, renamed or copied after setup, so the speech tools cannot find their
echo            private Python any more.
echo   WHAT TO DO: double-click "setup-windows.bat" (in this same folder) once more. It repairs the folder, usually in
echo   under a minute, and keeps the speech models. Then run this file again.
goto fail_end

:bad_chars
echo.
echo   PROBLEM: the name of this folder, or of a folder above it, contains a percent sign (%%).
echo            Windows would misread it in a start-up entry.
echo   WHAT TO DO: move the whole Video Redline folder (the one that has video-redline.html and the tools folder inside it) to a plain folder without that sign (for example %USERPROFILE%\VideoRedline),
echo   run "setup-windows.bat" there once, and then run this file from there.
echo   (If the helper already starts by itself from this folder, double-click "stop-helper-windows.bat" first.
echo   Windows will not move a folder while the helper runs from it.)
goto fail_end

:net_folder
echo.
echo   PROBLEM: this tools folder is on a network drive. The helper would start before the network is ready,
echo            and the videos you send would travel over the network.
echo   WHAT TO DO: move the whole Video Redline folder (the one that has video-redline.html and the tools folder inside it) to a plain folder on this computer's own disk (for example
echo   %USERPROFILE%\VideoRedline), run "setup-windows.bat" there once, and then run this file from there.
echo   (If the helper already starts by itself from this folder, double-click "stop-helper-windows.bat" first.
echo   Windows will not move a folder while the helper runs from it.)
goto fail_end

:sync_folder
echo.
echo   WARNING: this tools folder is inside a folder that OneDrive, Dropbox, iCloud or Google Drive copies to the internet.
echo   While a transcript is being made, a copy of your video sits in this folder, so it could be uploaded.
echo   BETTER: move the whole Video Redline folder (the one that has video-redline.html and the tools folder inside it) to a plain folder on your own disk (for example %USERPROFILE%\VideoRedline),
echo   run "setup-windows.bat" there once, and then run this file from there.
echo   (If the helper already starts by itself from this folder, double-click "stop-helper-windows.bat" first.
echo   Windows will not move a folder while the helper runs from it.)
if defined ALLOW_SYNC goto folder_ok
if defined ASSUME_YES goto sync_refused
echo.
choice /c YN /n /m "  Go on anyway? (Y = yes, N = no) "
if errorlevel 2 goto cancelled
goto folder_ok

:sync_refused
echo.
echo   Stopped. Nothing was changed. (To go on anyway, add /allow-sync.)
goto fail_end

:shared_folder
echo.
echo   WARNING: other people who use this computer can change the files in this tools folder.
echo   This tool starts a program from this folder every time you sign in to Windows, so a change
echo   made by someone else would run as YOU. That is fine on a computer that only you use.
echo   BETTER: move the whole Video Redline folder (the one that has video-redline.html and the tools folder inside it) inside your own user folder (for example %USERPROFILE%\VideoRedline),
echo   run "setup-windows.bat" there once, and then run this file from there.
echo   (If the helper already starts by itself from this folder, double-click "stop-helper-windows.bat" first.
echo   Windows will not move a folder while the helper runs from it.)
if defined ALLOW_SHARED goto shared_ok
if defined ASSUME_YES goto shared_refused
echo.
choice /c YN /n /m "  Go on anyway? (Y = yes, N = no) "
if errorlevel 2 goto cancelled
goto shared_ok

:shared_refused
echo.
echo   Stopped. Nothing was changed. (To go on anyway, add /allow-shared.)
goto fail_end

:too_long
echo.
echo   PROBLEM: the path of this folder is too long. Windows allows only about 260 characters for a start-up entry.
echo            "%TOOLS%"
echo   WHAT TO DO: move the whole Video Redline folder (the one that has video-redline.html and the tools folder inside it) somewhere with a shorter path (for example %USERPROFILE%\VideoRedline),
echo   run "setup-windows.bat" there once, and then run this file from there.
echo   (If the helper already starts by itself from this folder, double-click "stop-helper-windows.bat" first.
echo   Windows will not move a folder while the helper runs from it.)
goto fail_end

:reg_fail
echo.
echo   PROBLEM: Windows did not accept the start-up entry, so nothing was set up.
echo   WHAT TO DO: close this window and run this file again. If it fails again, your company may block
echo   changes to start-up entries: ask your IT person.
goto fail_end

:launcher_silent
echo.
echo   PROBLEM: the start-up entry was added and Windows was asked to start the helper, but nothing
echo            happened within 20 seconds. Security software may be blocking it.
echo   WHAT TO DO: wait a minute and run this file again. If it keeps failing, send the file
echo   "logs\helper.log" (in this folder, if it exists) to the person who invited you to the beta. Or double-click
echo   "start-helper-windows.bat" and leave its window open.
goto fail_end

:start_fail
echo.
echo   PROBLEM: the start-up entry was added, but the helper could not be started just now.
echo   WHAT TO DO: sign out of Windows and sign in again. It starts by itself then. Or double-click
echo   "start-helper-windows.bat" and leave its window open.
goto fail_end

:cancelled
echo.
echo   OK. Nothing was changed.
echo.
if not defined VRT_NO_PAUSE pause
endlocal & exit /b 2

:fail_end
echo.
if not defined VRT_NO_PAUSE pause
endlocal & exit /b 1

:end_ok
if not defined VRT_NO_PAUSE pause
endlocal & exit /b 0
