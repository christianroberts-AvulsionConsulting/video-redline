@echo off
rem ============================================================================================
rem  Video Redline - put a "Video Redline" icon on the Desktop and in the Start menu (Windows)
rem  Double-click the icon, wait a moment, and Video Redline opens. If the helper is not running, the
rem  icon starts it first. Nothing else to do. To take the icon away again, delete it like any other
rem  icon. To remove everything (also the start at sign-in): remove-autostart-windows.bat.
rem  Switch /quiet = no questions and no pause (setup-autostart-windows.bat uses it, and reads the exit code of this file:
rem  0 = at least one icon exists now, 1 = no icon could be made).
rem  The picture is drawn by the PowerShell part at the end of this file (a blue round play button, in six sizes).
rem  TEST ONLY (nobody needs this): the environment variable VRT_ICON_DIR sends the icons to the folders
rem  VRT_ICON_DIR\Desktop and VRT_ICON_DIR\Programs instead of the real Desktop and Start menu.
rem ============================================================================================
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul 2>&1

set "QUIET="
if /i "%~1"=="/quiet" set "QUIET=1"
set "TOOLS=%~dp0"
if "%TOOLS:~-1%"=="\" set "TOOLS=%TOOLS:~0,-1%"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "PYW=%TOOLS%\venv\Scripts\pythonw.exe"
set "OPEN=%TOOLS%\open_video_review.pyw"

if not exist "%PYW%" goto no_setup
if not exist "%OPEN%" goto not_extracted
if not exist "%PS%" goto no_powershell
rem The folder and file names travel to PowerShell through these settings, so odd characters in a name cannot break anything.
set "VRT_TOOLS=%TOOLS%"
set "VRT_PYW=%PYW%"
set "VRT_OPEN=%OPEN%"
set "VRT_SELF=%~f0"
set "VRT_QUIET="
if defined QUIET set "VRT_QUIET=1"

if not defined QUIET (
    echo.
    echo  =====================================================================
    echo   Video Redline - put a "Video Redline" icon on your Desktop
    echo  =====================================================================
    echo.
)

rem The PowerShell part is at the end of this file, after the line that holds the marker. The marker is built from two pieces
rem here so that this line is not mistaken for it. Exit codes: 0 = made on the Desktop and in the Start menu, 3 = made in one of them,
rem 2 = made in neither (the folders were not found), 1 = something unexpected. It always says in words what happened.
"%PS%" -NoProfile -NonInteractive -Command "$m='##PS-CODE'+'-FROM-HERE##'; $t=[IO.File]::ReadAllText($env:VRT_SELF); . ([scriptblock]::Create($t.Substring($t.LastIndexOf($m,[StringComparison]::Ordinal))))"
set "PSRC=%errorlevel%"
if "%PSRC%"=="0" goto made_all
if "%PSRC%"=="3" goto made_some
goto failed

:made_all
if not defined QUIET (
    echo.
    echo  =====================================================================
    echo   Done. Look for the "Video Redline" icon on your Desktop and in the Start menu.
    echo   Double-click it to open Video Redline. It starts the helper first if needed.
    echo   To take the icon away again, delete it like any other icon.
    echo   To remove everything, also the start at sign-in: "remove-autostart-windows.bat".
    echo  =====================================================================
    echo.
) else (
    echo        The "Video Redline" icon is on your Desktop and in the Start menu.
)
set "RC=0"
goto the_end

:made_some
if not defined QUIET (
    echo.
    echo  =====================================================================
    echo   Done, but the icon could not be made in every place ^(see the list above^).
    echo   Double-click the icon that was made to open Video Redline.
    echo  =====================================================================
    echo.
) else (
    echo        The "Video Redline" icon was made, but not in every place ^(see the list above^).
)
set "RC=0"
goto the_end

:no_setup
echo.
echo   The one-time setup has not been run yet. Please double-click "setup-windows.bat" (same folder) first.
set "RC=1"
goto the_end

:not_extracted
echo.
echo   The file "open_video_review.pyw" is missing from this folder. Please use the complete tools folder.
set "RC=1"
goto the_end

:no_powershell
echo.
echo   Windows PowerShell was not found, so I cannot make the icon.
set "RC=1"
goto the_end

:failed
if defined QUIET goto failed_quiet
echo.
echo   The icon could not be made. Video Redline itself still works: double-click "video-redline.html"
echo   (next to the tools folder) to open it. The helper, the part that makes transcripts, then starts
echo   by itself when you sign in to Windows if you ran "setup-autostart-windows.bat". If not,
echo   double-click "start-helper-windows.bat" and leave its window open.
set "RC=1"
goto the_end

:failed_quiet
rem (a short text: the file that called this one with /quiet says what to do instead)
echo        No icon was made.
set "RC=1"

:the_end
if not defined QUIET if not defined VRT_NO_PAUSE pause
endlocal & exit /b %RC%

##PS-CODE-FROM-HERE##
# Everything below this line is PowerShell, not batch: the batch part above never gets here. It is started by the line
# that holds the marker, with VRT_TOOLS, VRT_PYW and VRT_OPEN set.
$ErrorActionPreference = 'Stop'
function Say($text) { Write-Host ('        ' + $text) }
# True if the file can be opened for reading. A shortcut that another program has open exclusively cannot, and CreateShortcut() does not
# complain about that: it just shows an empty shortcut, which must not be mistaken for "not ours".
function Test-Readable($path) { try { $f = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite'); $f.Dispose(); return $true } catch { return $false } }
try {
  $q = [char]34
  $tools = $env:VRT_TOOLS
  $ico = Join-Path $tools 'video-redline.ico'
  $oldIco = Join-Path $tools 'video-review.ico'      # from before the rename

  # ---- 1. the picture: a blue round play button in six sizes, each one a PNG picture inside the .ico file
  # Nothing in this part may stop the icons from being made: if the picture cannot be saved, the icons use the old picture or the plain one.
  try {
    Add-Type -AssemblyName System.Drawing
    $sizes = 16, 32, 48, 64, 128, 256
    $pngs = @()
    foreach ($s in $sizes) {
      $big = $s * 4                                   # draw it four times as large, then shrink it: smooth edges even at 16 pixels
      $src = New-Object System.Drawing.Bitmap $big, $big, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $g = [System.Drawing.Graphics]::FromImage($src)
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $g.Clear([System.Drawing.Color]::Transparent)
      $u = $big / 256.0
      $circle = [System.Drawing.RectangleF]::new(8 * $u, 8 * $u, 240 * $u, 240 * $u)
      $paint = New-Object System.Drawing.Drawing2D.LinearGradientBrush $circle, ([System.Drawing.Color]::FromArgb(255, 66, 135, 208)), ([System.Drawing.Color]::FromArgb(255, 30, 88, 158)), 90.0
      $g.FillEllipse($paint, $circle)
      $tri = [System.Drawing.PointF[]]@([System.Drawing.PointF]::new(100 * $u, 72 * $u), [System.Drawing.PointF]::new(100 * $u, 184 * $u), [System.Drawing.PointF]::new(188 * $u, 128 * $u))
      $g.FillPolygon([System.Drawing.Brushes]::White, $tri)
      $g.Dispose(); $paint.Dispose()
      $dst = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $h = [System.Drawing.Graphics]::FromImage($dst)
      $h.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $h.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $h.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $h.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $h.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $h.Clear([System.Drawing.Color]::Transparent)
      $edge = New-Object System.Drawing.Imaging.ImageAttributes
      $edge.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)   # no pale line along the edge
      $h.DrawImage($src, [System.Drawing.Rectangle]::new(0, 0, $s, $s), 0, 0, $big, $big, [System.Drawing.GraphicsUnit]::Pixel, $edge)
      $h.Dispose(); $edge.Dispose(); $src.Dispose()
      $ms = New-Object System.IO.MemoryStream
      $dst.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      $dst.Dispose()
      $pngs += , ($ms.ToArray())
    }
    # the .ico container, byte by byte: a 6-byte header, one 16-byte entry per picture, then the pictures
    $out = New-Object System.IO.MemoryStream
    $w = New-Object System.IO.BinaryWriter $out
    $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
      $side = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }          # 0 means 256
      $w.Write([byte]$side); $w.Write([byte]$side); $w.Write([byte]0); $w.Write([byte]0)
      $w.Write([uint16]1); $w.Write([uint16]32)                           # one plane, 32 bits per pixel
      $w.Write([uint32]$pngs[$i].Length); $w.Write([uint32]$offset)
      $offset += $pngs[$i].Length
    }
    foreach ($p in $pngs) { $w.Write([byte[]]$p) }
    $w.Flush()
    $tmp = $ico + '.tmp'
    try {
      [System.IO.File]::WriteAllBytes($tmp, $out.ToArray())
      Move-Item -LiteralPath $tmp -Destination $ico -Force               # the old picture stays if this fails
    } catch {
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      throw
    }
  } catch {
    Say 'Windows could not save the picture for the icon (another program may be using the file), so the icon is made with the older or the plain picture.'
  }
  $useIco = ''
  foreach ($c in @($ico, $oldIco)) { if (-not $useIco -and (Test-Path -LiteralPath $c -PathType Leaf)) { $useIco = $c } }

  # ---- 2. the icons: one on the Desktop, one in the Start menu
  if ($env:VRT_ICON_DIR) { $desktop = Join-Path $env:VRT_ICON_DIR 'Desktop'; $programs = Join-Path $env:VRT_ICON_DIR 'Programs' }
  else { $desktop = [Environment]::GetFolderPath('Desktop'); $programs = [Environment]::GetFolderPath('Programs') }
  $places = @(@{ Name = 'Desktop'; Dir = $desktop }, @{ Name = 'Start menu'; Dir = $programs })
  $sh = New-Object -ComObject WScript.Shell
  $made = 0; $notMade = 0; $desktopMade = $false
  foreach ($pl in $places) {
    $d = $pl.Dir
    if (-not $d -or -not (Test-Path -LiteralPath $d -PathType Container)) {
      Say ($pl.Name + ': I could not find this folder, so there is no icon there.'); $notMade++; continue
    }
    $p = Join-Path $d 'Video Redline.lnk'
    try {
      $s = $sh.CreateShortcut($p)
      $s.TargetPath = $env:VRT_PYW
      $s.Arguments = '-E -X utf8 ' + $q + $env:VRT_OPEN + $q
      $s.WorkingDirectory = $tools
      if ($useIco) { $s.IconLocation = $useIco }
      $s.Description = 'Open Video Redline (starts its helper first if needed)'
      $s.Save()
      Say ($pl.Name + ': icon made. ' + $p)
      $made++
      if ($pl.Name -eq 'Desktop') { $desktopMade = $true }
    } catch {
      Say ($pl.Name + ': Windows would not let me save the icon in ' + $d + '.'); $notMade++; continue
    }
    # the icon from before the product was renamed ("Video Review"): replaced by the new one, but only if it is ours
    $old = Join-Path $d 'Video Review.lnk'
    if (Test-Path -LiteralPath $old) {
      $ours = $false; $unreadable = $false
      if (-not (Test-Readable $old)) { $unreadable = $true }
      else { try { $ours = ([string]$sh.CreateShortcut($old).Arguments) -like '*open_video_review.pyw*' } catch { $unreadable = $true } }
      if ($unreadable) {
        Say ($pl.Name + ': there is an older icon called "Video Review", but another program is using it, so I could not check it and left it alone. If it is the old Video Redline icon, you can delete it yourself: ' + $old)
      }
      elseif ($ours) {
        try { Remove-Item -LiteralPath $old -Force -ErrorAction Stop; Say ($pl.Name + ': the old "Video Review" icon was replaced.') }
        catch { Say ($pl.Name + ': the old "Video Review" icon is still there, because Windows would not delete it. You can delete it yourself: ' + $old) }
      }
    }
  }
  # (The old picture video-review.ico is left where it is: an old icon that could not be replaced, or a copy of the icon somewhere
  # else, may still use it. remove-autostart-windows.bat deletes both pictures.)
  if ($desktopMade -and ($desktop -match 'onedrive')) {
    Say ('Your Desktop is kept in OneDrive (' + $desktop + '), so this icon is stored in OneDrive and may also appear on your other computers. It only works on a computer where Video Redline is set up in the same place; anywhere else you can simply delete it.')
  }
  if ($made -eq 0) { Say 'No icon could be made, because neither your Desktop folder nor your Start menu folder could be used.'; exit 2 }
  if ($notMade -gt 0) { exit 3 }
  exit 0
} catch {
  if ($env:VRT_QUIET) { Say 'Something unexpected went wrong while making the icon.' }
  else { Say 'Something unexpected went wrong while making the icon. Please close this window and try again.' }
  exit 1
}
