# Let the helper start by itself (Windows)

(To open a `.md` file like this one: right-click it, choose **Open with**, then **Notepad**. Or read the same page on GitHub.)

The helper is the small program on your own computer that makes transcripts. Without this page you have to start it yourself, every time, and leave a window open. With it, after one set-up, **you open Video Redline from its icon and "Create transcript and find cuts" works.**

This is for **Windows**. A Mac does not start the helper when you log in. Instead, `setup-mac.command` makes a small app called **Video Redline** in your Video Redline folder: double-click it, and it starts the helper if it is not running and then opens the page (see "Using the one-click button" in `README.md`, this folder). `stop-helper-mac.command` stops the helper again.

## The easy way: the "Video Redline" icon

On Windows, setup puts an icon called **Video Redline** on your Desktop and in the Start menu. **Double-click it to open Video Redline.** If the helper is not running, the icon starts it first (in the background, with no window, usually under a second) and then opens the page. Your browser is never asked anything, and nothing else needs to be started. Use this icon instead of double-clicking `video-redline.html`.

Why an icon? A web page cannot start a program on your computer: browsers do not allow it. So the Video Redline page never starts the helper, and neither do its buttons "Create transcript" and "Check again". The icon does it for you, and it also covers the case where you stopped the helper, or it ended: **to start the helper again, double-click the Video Redline icon.** If the icon is missing (you deleted it), double-click `setup-autostart-windows.bat` once. It makes the icon again (it is safe to run twice).

If your Desktop is kept in OneDrive (File Explorer shows it as `OneDrive > Desktop`), the icon is stored there and OneDrive may copy it to your other computers. On a computer without Video Redline, that icon will not work: delete it there. Setup tells you when your Desktop is in OneDrive.

## Where to keep the folder

Your Video Redline folder is the one that has `video-redline` and `tools` inside it. Keep it inside your own user folder, for example `C:\Users\YourName\VideoRedline`. Not on Desktop or Documents (OneDrive often copies them to the internet), not on a network drive, and not directly on `C:`. While a transcript is made, a copy of the video sits in the `tools` folder, and a sync program would upload it. The helper also runs the programs in this folder every time you sign in, so only you should be able to change the files there. Setup checks this and tells you if the place is wrong.

`setup-autostart-windows.bat` checks:

- On a network drive, with a percent sign (%) in the path, or with a path that is too long (Windows allows about 260 characters in a start-up setting), it **stops** and tells you what to do.
- Inside OneDrive, Dropbox, iCloud or Google Drive, it **warns you and asks** whether to go on. We recommend answering **N** and moving the folder.
- If other people who use this computer can change the files in the folder, it **warns you and asks** the same way. On a computer that only you use, that is fine.

On a computer that several people share, only one person at a time can use the helper: the first person who signs in runs it.

## Turn it on (once)

1. Make sure the one-time setup is done: you ran `setup-windows.bat` and it said ALL DONE.
2. Open the `tools` folder and double-click **`setup-autostart-windows.bat`**.
3. Read the short lines it shows, then press **Y**.
4. Wait for **OK. The helper now starts by itself.** It takes about 10 seconds. It starts the helper the same way Windows will, checks that the helper answers, and puts the icons in place.

If it says PROBLEM instead, read the "WHAT TO DO" line under it. The most common reasons are that the one-time setup has not been run yet, or that the folder is in a bad place (see above).

You can run this file again at any time. It is safe to run twice.

**Before you move, rename or delete the folder**, or copy a newer version of the tools over it: double-click **`stop-helper-windows.bat`** first. While the helper runs, Windows will not move or delete the folder, and it says something like "the folder or a file in it is open in another program". After you have moved it, run `setup-windows.bat` and then `setup-autostart-windows.bat` from the new place (the second one also makes the icons again).

If the folder was moved or deleted anyway (for example at a time when the helper was not running, so Windows allowed it), Windows may show a message that it cannot find a file (`pythonw.exe`) when you sign in or when you click the icon. The start-up setting and the icons still point at the old place. Run `setup-autostart-windows.bat` from the new place, and the message is gone. If the folder is gone for good, see "Uninstall" below.

## If you already set up another copy

There is one start-up setting and one "Video Redline" icon per Windows user. If another copy of Video Redline (or Video Review) is already set up on this PC in a different folder, running `setup-autostart-windows.bat` here **replaces** its start-up setting and icon, and stops its hidden helper. (A helper that someone started by hand with `start-helper-windows.bat` in another folder is not stopped: close its window yourself, or the page may use that one.) Do this on purpose, or run `remove-autostart-windows.bat` in the old folder first. Afterwards `remove-autostart-windows.bat` in this folder removes the setting that now belongs to this copy.

## What it does

It adds **one start-up setting and two icons** for **your Windows user only**. It needs no administrator password and changes nothing for other users.

- **A start-up setting.** Every time you sign in to Windows, the helper starts by itself, in the background, with no window. It uses almost no power while it waits (about 30 MB of memory). Windows may tell you that a start-up app called "Python" was added: that is this helper.
- **Two "Video Redline" icons**, one on your Desktop and one in the Start menu. They start the helper if needed and open the page.

Nothing else is changed. Everything stays in this folder, except that setting and those icons.

## Will my browser ask me something?

Maybe, the first time you press **Create transcript and find cuts**. Some browsers ask whether the page may connect to other apps or devices on your computer. The wording differs, but choose **Allow**. The helper only talks to your own computer. If you clicked Block by mistake, click the small icon at the left of the address bar, switch the permission back on, reload the page and click **Check again**.

Opening Video Redline with the icon, or with the helper already running, asks nothing.

## How to see that it is running

Open Video Redline with the icon, open a video, go to the **Cleanup** tab and press **Create transcript and find cuts**. A progress bar means it works. (Advanced ways to check are at the end of this page.)

## Stop it, turn it off, or uninstall

| I want to... | Double-click | What happens |
|---|---|---|
| Stop the helper for now | `stop-helper-windows.bat` | The helper stops, and any copy of a video it was working on is deleted. The Video Redline icon starts it again. If you ran `setup-autostart-windows.bat`, it also starts at your next sign-in. |
| Stop it starting by itself and remove the icons | `remove-autostart-windows.bat` | The helper is stopped and nothing starts at sign-in. The icons, the log and any left-over video copies are removed. The folder stays. |
| Remove everything | `remove-autostart-windows.bat`, then delete the Video Redline folder | See *Uninstall completely* in the main `README.md`. |

**Stop it for now.** Use `stop-helper-windows.bat` too when the page says the helper is busy and you do not want to wait. A page that you closed or reloaded in the middle of a transcript leaves the helper busy for up to 10 minutes. Stopping it clears that at once; then double-click the **Video Redline** icon and press **Check again**. Use it before you move the folder, and after you copy a newer version of the tools over the old one (the old helper keeps running until you stop it). It also stops a helper that you started by hand with `start-helper-windows.bat`; its window can then be closed.

**Turn it off.** `remove-autostart-windows.bat` stops the helper, removes the start-up setting and the icons (and the mark Windows keeps when a start-up entry was switched off in Settings), deletes the log and any left-over copy of a video, and then shows what it removed. It only removes an icon that starts this tool. If it cannot delete an icon, or cannot check it because another program is using it, it says so and tells you to delete it yourself, and it never says "removed" when it was not. If you renamed or moved the icon, it cannot find it: delete it yourself. You can turn it on again later with `setup-autostart-windows.bat`.

Windows may also list the start-up setting (it can appear as "Python") under Settings, Apps, Startup, where you can switch it off. That only stops the start at sign-in; the icon still starts the helper. If you switched it off there and later run `setup-autostart-windows.bat` again, setup switches it back on.

**Uninstall.** If you deleted or moved the folder without removing it first, Windows still has the start-up setting. Download the ZIP again, unpack it, and run `remove-autostart-windows.bat` from that copy. If that does not work, see `DEVELOPERS.md` in this folder, or ask the person who invited you to the beta.

## The log

The helper has no window, so it writes a short log: `logs\helper.log` in the `tools` folder. It says when the helper started and stopped, and whether transcripts worked. It never contains the names of your videos or what was said, but it does contain the path of the folder, and that path includes your Windows user name; you may edit that out before you send the file. It stays small: when it passes 1 MB, it is renamed to `helper.log.1` and a new one is started. You can delete it at any time. If something goes wrong, this is the file to send to the person who invited you to the beta. (If the `tools` folder cannot be written, for example because it belongs to another user, the log goes to `video-redline-helper.log` in your temp folder instead, and the message that the icon shows names the file that was really written.)

## Your privacy

- **Your video stays on your computer.** The helper listens only on your own computer. Other computers cannot reach it. It does not use the internet while it makes a transcript, and the helper itself sends nothing anywhere. The speech engine it uses (Microsoft's ONNX Runtime) has usage reporting of its own, and the helper asks it to stop as far as that can be asked; `tools/README.md` says what that means on Windows and on a Mac.
- **A copy of your video, and of its sound, is kept in this folder only while a transcript is being made.** Then it is deleted. If the helper is stopped in the middle, the leftover copy is deleted when you run `stop-helper-windows.bat` or `remove-autostart-windows.bat`, or the next time the helper starts.
- **Any page you open from a file on this computer, and any program on this computer, can ask the helper to make a transcript.** There is no password. A hostile web page could also try to use it: it cannot read your files, and your browser may ask before a page may connect. The helper cannot read your other files, start other programs or change settings. It stops a job when your disk is filling up, when nobody has asked about the job for 10 minutes, or after 3 hours. If a page ever keeps the helper busy, `stop-helper-windows.bat` clears that. See `README-helper-security.md`.
- Because the helper now runs all the time, not only while a window is open, it is **worth keeping the folder in a safe place** (see "Where to keep the folder").

## If something does not work

| What you see | What to do |
|---|---|
| The page says it could not find the helper | Double-click the **Video Redline** icon on your Desktop. It starts the helper. Then press **Check again** (you can close the new page the icon opens). If there is no icon, double-click `setup-autostart-windows.bat` once. |
| The page says it could not find the helper, although the helper is running | Your browser, a VPN or a firewall may be blocking the connection. If your browser asks whether this page may connect to other apps or devices on your computer, choose **Allow**. Then press **Check again**. |
| The icon opens Video Redline but says the helper did not start | Restart your computer, then click the icon again. If it still does not work, send the file that the message names (usually `logs\helper.log` in the `tools` folder) to the person who invited you to the beta. If the message says the folder cannot be written, ask the person who invited you to the beta (or whoever installed Video Redline) to give your Windows account permission to change that folder. |
| The icon says it cannot find the Video Redline page | `video-redline.html` has to be in the folder above the `tools` folder. Put it back there, or download Video Redline again. |
| The setup file says the speech tools are not ready | Double-click `stop-helper-windows.bat`, then `setup-windows.bat`, and wait for ALL DONE. Then run `setup-autostart-windows.bat` again. |
| It worked before, now it does not | Look at the end of `logs\helper.log`. If you moved or copied the folder, run `setup-autostart-windows.bat` again from the new place. |
| Windows says it cannot find `pythonw.exe` | The folder was moved or deleted. Run `setup-autostart-windows.bat` again from the new place (see "Turn it on"). |
| Windows says the folder is in use when you move or delete it | Double-click `stop-helper-windows.bat` first. |
| The page says the helper is busy | Wait, or double-click `stop-helper-windows.bat`, then double-click the **Video Redline** icon, and press **Check again**. |
| The page says the connection to the helper was lost | The helper stopped in the middle of a transcript (it was stopped, or the computer signed out). Double-click the **Video Redline** icon, then press **Create transcript** again. |
| Nothing helps | Double-click `start-helper-windows.bat` and leave its window open. That always works, and its window shows what is wrong. Send a photo of it, and the file `logs\helper.log`, to the person who invited you to the beta. |

## Advanced, and older versions

- **Check by hand.** Open `http://127.0.0.1:47831/status` in your browser. If you see text that starts with `{"ok":true`, the helper is running. The helper listens on `127.0.0.1`, on five numbers in a row: 47831 to 47835. If another program uses the first number, the helper takes the next one, so the last digits can be 47832 to 47835.
- **If you used an earlier private build.** It may have left an icon called **Video Review**, or a link called `videoreview` in Windows. Neither does any harm. `setup-autostart-windows.bat` replaces the old icon with the **Video Redline** icon, and `remove-autostart-windows.bat` removes the icon and the link.
- **Starting it by hand.** `start-helper-windows.bat` still works as before: it opens a window that you leave open. It works next to the automatic start.

Developing or testing these files? See `DEVELOPERS.md` in this folder.
