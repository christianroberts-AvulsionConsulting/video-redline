@echo off
rem ============================================================================================
rem  Video Redline - switch the automatic start OFF (Windows)
rem  Double-click this file to undo what setup-autostart-windows.bat did:
rem    - the entry that starts the helper when you sign in to Windows,
rem    - the "Video Redline" icon on the Desktop and in the Start menu (and the older "Video Review" icon),
rem    - the helper itself, if it is running from this folder,
rem    - the small log (logs\helper.log) and any copy of a video the helper left behind (the folder tmp),
rem    - the "videoreview" link that older versions registered (nothing uses it any more), if it is still there.
rem  Only entries of the Video Redline helper are touched. No administrator rights. Safe to run twice.
rem  Switch: /yes  (do not ask the question first)
rem  TEST ONLY (nobody needs this): the environment variable VRT_ICON_DIR looks for the icons in the folders
rem  VRT_ICON_DIR\Desktop and VRT_ICON_DIR\Programs instead of the real Desktop and Start menu.
rem  The icon part is the PowerShell text at the end of this file (the same trick as add-desktop-icon-windows.bat).
rem ============================================================================================
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul 2>&1
title Video Redline - switch the automatic start off

set "PYTHONHOME="
set "PYTHONPATH="
set "PYTHONSTARTUP="
set "PYTHONUSERBASE="

rem (this must come before the switch is read: SHIFT also moves the file's own name, and the folder would be lost)
set "TOOLS=%~dp0"
if "%TOOLS:~-1%"=="\" set "TOOLS=%TOOLS:~0,-1%"
set "SELF=%~f0"

set "ASSUME_YES="
:next_arg
if "%~1"=="" goto args_done
if /i "%~1"=="/yes" set "ASSUME_YES=1"
shift
goto next_arg
:args_done

set "PY=%TOOLS%\venv\Scripts\python.exe"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "VRT_TOOLS=%TOOLS%"
set "RUNKEY=HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
set "LINKKEY=HKCU\Software\Classes\videoreview"
set "APPROVEDKEY=HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"

echo.
echo  =====================================================================
echo   Video Redline - switch the automatic start off
echo  =====================================================================
echo.
echo   This takes out what "setup-autostart-windows.bat" added:
echo   1. The entry that starts the helper when you sign in to Windows.
echo   2. The "Video Redline" icon on the Desktop and in the Start menu.
echo   3. The helper itself, if it is running from this folder, its small log, and any copy of a video it left behind.
reg query "%LINKKEY%" >nul 2>&1
if not errorlevel 1 echo   4. The "videoreview" link that an older version added (nothing uses it any more).
echo   Nothing else is touched. After this, start the helper by hand when you need it
echo   ("start-helper-windows.bat", and leave its window open), or run "setup-autostart-windows.bat" again.
echo.
if defined ASSUME_YES goto confirmed
choice /c YN /n /m "  Do you want to do this? (Y = yes, N = no) "
if errorlevel 2 goto cancelled
:confirmed
echo.

rem ---- 1. the helper that runs from this folder (the hidden one, or one started by hand with start-helper-windows.bat) ----
if not exist "%PS%" goto skip_stop
"%PS%" -NoProfile -NonInteractive -Command "$t=$env:VRT_TOOLS.TrimEnd('\'); $keys=@(($t+'\helper_launcher.pyw'),($t+'\vrt_server.py')); $n=0; foreach($p in Get-CimInstance Win32_Process){ if($p.CommandLine -and ($p.Name -match '^pythonw?\.exe$')){ $c=$p.CommandLine.Replace('/','\'); foreach($k in $keys){ if($c.IndexOf($k,[StringComparison]::OrdinalIgnoreCase) -ge 0){ Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $n++; break } } } }; Start-Sleep -Milliseconds 700; exit $n"
if errorlevel 1 (echo   - The helper that was running from this folder: stopped.) else (echo   - The helper: it was not running from this folder.)
goto stop_done
:skip_stop
echo   - The helper: I could not look for it (Windows PowerShell was not found). If it is running, sign out of Windows and sign in again.
:stop_done

rem ---- 2. the sign-in entry --------------------------------------------------------------------
reg query "%RUNKEY%" /v VideoReviewHelper >nul 2>&1
if errorlevel 1 goto run_absent
reg query "%RUNKEY%" /v VideoReviewHelper 2>nul | findstr /i /c:"helper_launcher.pyw" >nul
if errorlevel 1 goto run_foreign
reg delete "%RUNKEY%" /v VideoReviewHelper /f >nul 2>&1
reg delete "%APPROVEDKEY%" /v VideoReviewHelper /f >nul 2>&1
echo   - The entry that starts the helper at sign-in: removed.
goto run_done
:run_absent
rem (Windows keeps its own mark for an entry that was switched off in Settings, Apps, Startup: it is taken away too)
reg delete "%APPROVEDKEY%" /v VideoReviewHelper /f >nul 2>&1
echo   - The entry that starts the helper at sign-in: it was not there.
goto run_done
:run_foreign
echo   - The entry named VideoReviewHelper does not point at the Video Redline helper, so I left it alone.
:run_done

rem ---- 3. the link (older versions only: setup does not register it any more, and nothing uses it) ------------------
reg query "%LINKKEY%" >nul 2>&1
if errorlevel 1 goto link_absent
reg query "%LINKKEY%\shell\open\command" /ve >nul 2>&1
if errorlevel 1 goto link_delete
reg query "%LINKKEY%\shell\open\command" /ve 2>nul | findstr /i /c:"helper_launcher.pyw" >nul
if errorlevel 1 goto link_foreign
:link_delete
reg delete "%LINKKEY%" /f >nul 2>&1
echo   - The "videoreview" link that an older version added: removed.
goto link_done
:link_absent
rem (nothing to say: only an older private version ever added this link)
goto link_done
:link_foreign
echo   - The "videoreview" link belongs to another program, so I left it alone.
:link_done

rem ---- 3b. the "Video Redline" icon, and the older "Video Review" icon (only ours: the shortcut must start open_video_review.pyw) ----
rem The PowerShell text at the end of this file says in words, for the Desktop and the Start menu, whether it removed the icon, did not find it,
rem or could not delete it (exit code 10: Windows or OneDrive was using it; 1: something unexpected). The picture file is kept then.
set "ICONFAIL="
if not exist "%PS%" goto icon_nops
set "VRT_SELF=%SELF%"
"%PS%" -NoProfile -NonInteractive -Command "$m='##PS-CODE'+'-FROM-HERE##'; $t=[IO.File]::ReadAllText($env:VRT_SELF); . ([scriptblock]::Create($t.Substring($t.LastIndexOf($m,[StringComparison]::Ordinal))))"
if errorlevel 1 set "ICONFAIL=1"
goto icon_done
:icon_nops
set "ICONFAIL=1"
echo   - The "Video Redline" icon: I could not look for it (Windows PowerShell was not found). If it is on your Desktop or in your Start menu, delete it yourself.
:icon_done
if not defined ICONFAIL del /q "%TOOLS%\video-redline.ico" "%TOOLS%\video-review.ico" >nul 2>&1

rem ---- 4. the log, and any copy of a video (and of its sound) that the stopped helper left behind -----------
del /q "%TOOLS%\logs\helper.log" "%TOOLS%\logs\helper.log.1" >nul 2>&1
del /q "%TEMP%\video-redline-helper.log" "%TEMP%\video-review-helper.log" >nul 2>&1
call :tidy
if "%TIDY%"=="0" goto tidy_ok
if "%TIDY%"=="4" goto tidy_running
rem 3: Windows would not let go of something, 9: the private Python could not be asked. Delete the folders directly
rem (Windows never deletes a file that a running program still has open).
for /d %%D in ("%TOOLS%\tmp\run-*" "%TOOLS%\tmp\jobs-*") do rd /s /q "%%D" >nul 2>&1
dir /b /ad "%TOOLS%\tmp\run-*" "%TOOLS%\tmp\jobs-*" >nul 2>&1
if errorlevel 1 goto tidy_ok
echo   - The log: cleared. Some temporary files of a video are still there, because Windows would not let me delete them.
echo     They are in the folder "tmp" inside the tools folder. It is safe to delete that folder yourself.
goto tidy_done
:tidy_running
echo   - The log: cleared. A helper is still running from this folder, so I left its temporary files alone.
echo     If you started it by hand, close its window.
goto tidy_done
:tidy_ok
echo   - The log and any left-over temporary files: cleared.
:tidy_done

rem ---- did it work? -------------------------------------------------------------------------------
reg query "%RUNKEY%" /v VideoReviewHelper >nul 2>&1
if not errorlevel 1 goto still_there
reg query "%LINKKEY%" >nul 2>&1
if not errorlevel 1 goto still_there
echo.
echo  =====================================================================
if defined ICONFAIL (
    echo   The helper no longer starts by itself, but an icon could not be deleted ^(see the lines above^).
    echo   Please delete that icon yourself: right-click it, then choose Delete.
) else (
    echo   Done. The helper no longer starts by itself.
    echo   If you renamed or moved the "Video Redline" icon, I could not find it: please delete it yourself.
)
echo   ^(If you ever want it all back, run "setup-autostart-windows.bat" again.^)
echo  =====================================================================
echo.
goto end_ok

:still_there
echo.
echo   Some entries are still there. If they belong to another program, that is fine.
echo   Otherwise close this window and run this file again.
if defined ICONFAIL echo   Also, an icon could not be deleted ^(see the lines above^): please delete it yourself.
echo.
goto end_ok

:cancelled
echo.
echo   OK. Nothing was changed.
echo.
if not defined VRT_NO_PAUSE pause
endlocal & exit /b 2

:end_ok
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

##PS-CODE-FROM-HERE##
# Everything below this line is PowerShell, not batch: the batch part above never gets here. It is started by the line
# that holds the marker. It removes the "Video Redline" icon and the older "Video Review" icon, but only shortcuts that start
# open_video_review.pyw (never anything else), and says in words what happened. Exit codes: 0 = fine, 10 = an icon could not be deleted
# or could not be checked (another program has it open), 1 = something unexpected.
$ErrorActionPreference = 'Stop'
function Say($text) { Write-Host ('  - ' + $text) }
# True if the file can be opened for reading. A shortcut that another program has open exclusively cannot, and CreateShortcut() does not
# complain about that: it just shows an empty shortcut, which must not be mistaken for "not ours" (or for "not there").
function Test-Readable($path) { try { $f = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite'); $f.Dispose(); return $true } catch { return $false } }
try {
  if ($env:VRT_ICON_DIR) { $desktop = Join-Path $env:VRT_ICON_DIR 'Desktop'; $programs = Join-Path $env:VRT_ICON_DIR 'Programs' }
  else { $desktop = [Environment]::GetFolderPath('Desktop'); $programs = [Environment]::GetFolderPath('Programs') }
  $places = @(@{ Where = 'on the Desktop'; Dir = $desktop }, @{ Where = 'in the Start menu'; Dir = $programs })
  $sh = New-Object -ComObject WScript.Shell
  $failed = 0
  foreach ($pl in $places) {
    $removed = 0; $stuck = @(); $unchecked = @()
    foreach ($name in 'Video Redline.lnk', 'Video Review.lnk') {
      if (-not $pl.Dir) { continue }
      $p = Join-Path $pl.Dir $name
      if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { continue }
      $ours = $false; $unreadable = $false
      if (-not (Test-Readable $p)) { $unreadable = $true }
      else { try { $ours = ([string]$sh.CreateShortcut($p).Arguments) -like '*open_video_review.pyw*' } catch { $unreadable = $true } }
      if ($unreadable) { $unchecked += $p; continue }          # another program has it open: it could not be checked, so it is not "not there"
      if (-not $ours) { continue }
      try { Remove-Item -LiteralPath $p -Force -ErrorAction Stop; $removed++ } catch { $stuck += $p }
    }
    if ($stuck.Count -gt 0) {
      $failed++
      Say ('The "Video Redline" icon ' + $pl.Where + ': I could not delete it, because Windows or OneDrive is using it. Please delete it yourself: ' + $stuck[0])
    }
    elseif ($unchecked.Count -gt 0) {
      $failed++
      Say ('The "Video Redline" icon ' + $pl.Where + ': I could not delete or check it, because another program is using it. Please delete it yourself: ' + $unchecked[0])
    }
    elseif ($removed -gt 0) { Say ('The "Video Redline" icon ' + $pl.Where + ': removed.') }
    else { Say ('The "Video Redline" icon ' + $pl.Where + ': it was not there.') }
  }
  if ($failed -gt 0) { exit 10 }
  exit 0
} catch {
  Say 'The "Video Redline" icon: I could not look for it because something unexpected went wrong. If it is on your Desktop or in your Start menu, please delete it yourself.'
  exit 1
}
