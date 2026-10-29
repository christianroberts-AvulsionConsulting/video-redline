# Transcription helper for the Video Redline Tool

Version 0.1.0-beta

This small tool listens to your video and writes a **transcript file**: every word with its exact time, plus where the quiet gaps are and where there are non-word sounds (breaths, clicks, coughs, humming). The Video Redline page reads that file and uses it for **Audio cleanup**: it finds the "um"s, "uh"s, long pauses and stutters for you, so you can cut them in a few clicks.

Everything runs **on your own computer**. Your video is never uploaded anywhere. After the one-time setup it works with the internet switched off.

It uses two free, open-source speech engines side by side, because each is good at something different:

| Engine | What it is good at |
| --- | --- |
| **NVIDIA Parakeet** | Exact timing of every word. |
| **OpenAI Whisper** | Hearing the "um"s and "uh"s that Parakeet often leaves out. |

The tool combines them: Parakeet's words and timing are the backbone, and anything only Whisper heard (an "um", a repeated word) is added if there is real sound in the audio at that spot.

---

## What you need

- A Windows 10 or 11 PC, **or** a Mac (see the Mac notes below: the Mac scripts have not been tested yet).
- About **2 GB of free disk space** during setup (1.5 GB left afterwards).
- A computer with at least **4 GB of memory** (the speech models need about 2 GB while running).
- An internet connection **for the one-time setup only**.
- Nothing else to install by hand: no Python, no ffmpeg. No administrator password is needed, with **one exception on Windows**: the speech engines need Microsoft's free *Visual C++ Redistributable 2015-2022 (64-bit)*. Most PCs already have it. A freshly installed Windows may not. Setup checks this first, before it downloads anything, and tells you exactly what to click (installing it asks for an administrator's OK once).

## One-time setup (about 10 minutes)

### Windows

1. **Unpack the zip first.** Right-click the zip file you downloaded, choose **Extract All...** and click **Extract**, then open the new folder. Do **not** double-click `setup-windows.bat` while you are still looking inside the zip: Windows then unpacks only that one file and leaves the rest behind. (The file notices this and tells you to extract first.)
   Put the extracted folder inside a plain folder in your own user folder: make a folder called `VideoRedline` there (to open your user folder, press the Windows key + R, type `%USERPROFILE%` and press Enter) and put it in, so that the tools folder ends up inside `C:\Users\<your name>\VideoRedline` (with your own Windows user name instead of `<your name>`), and **do not move or rename it after setup**. Do not put it directly on the C drive (a folder right under `C:\`): on most PCs every account on the PC can change files there, and the automatic start (see "Starting automatically (Windows)" below) warns you about such a folder. Avoid your Desktop, your Documents folder, OneDrive, Dropbox and Google Drive: on many PCs those are copied to the cloud, and your videos are copied into this folder while they are transcribed (see "Where to put the folder" below). Very long folder paths can also confuse Windows programs, so use a short place inside your own user folder.
2. Open the **`tools`** folder inside it and double-click **`setup-windows.bat`**.
   - If Windows says *"Windows protected your PC"*, click **More info**, then **Run anyway**. (This happens to any script you download.)
   - Press any key when it asks.
3. Wait. It shows 6 numbered steps. Step 5 downloads the speech models (about 1.2 GB) and shows a progress bar for each file. If your internet drops, just double-click the setup file again: it continues where it stopped, and a model that was only half downloaded is fetched again. A model that is already complete is not downloaded again.
4. When you see **ALL DONE**, setup is finished. You never need to do it again. Next comes the **Video Redline** icon. If your tools folder has `setup-autostart-windows.bat`, setup asks whether the helper should start by itself each time you sign in to Windows (see "Starting automatically (Windows)" below): press **Y** to turn it on, which also adds the icon (the easy way). Or press Enter to skip it; you can double-click `setup-autostart-windows.bat` yourself later, and it does the same. If you would rather not have the icon, start the helper by hand each time (see "Using the one-click button" below).
   (Running the setup file again later is always safe. It also repairs the folder if you moved or renamed it by mistake; see "If something goes wrong".)

### Mac (not tested yet)

The Mac scripts were written carefully but **have not been run on a Mac**. If something does not work, the Troubleshooting section below is the place to start.

1. Double-click the zip file in Finder to unpack it. Make a folder called **VideoRedline** in your home folder (the one with your name on it) and drag the unpacked folder into it, so that the tools folder ends up inside `~/VideoRedline`. Do not move or rename it after setup. Avoid Desktop and Documents: with iCloud Drive turned on for them, your videos would be uploaded (see "Where to put the folder" below).
2. Open the **Terminal** app (press Command + Space, type *Terminal*, press Return).
3. Type `bash ` (with a space after it), then drag the file **`setup-mac.command`** from the folder into the Terminal window, and press Return.
   - Please do not double-click `setup-mac.command`. A file from a download is usually not marked as a program, so the Mac refuses to open it (it may show a permission message), and it may also say the file is from an unidentified developer. Running it with `bash` as above avoids both.
4. Wait for the 6 numbered steps to finish. Step 5 downloads about 1.2 GB.
5. When you see **ALL DONE**, you are finished.

*Apple Silicon Macs (M1 or newer) need macOS 14 or newer. Intel Macs use an older speech-engine build that should work but is the least tested kind of Mac.*

### Where to put the folder (and what setup checks)

Use a plain folder inside your own user folder: **`C:\Users\<your name>\VideoRedline`** on Windows (that is `%USERPROFILE%\VideoRedline`, with your own Windows user name instead of `<your name>`; keep the path short, and not directly on the C drive: on most PCs every account on the PC can change files there, and the automatic start warns you about such a folder), **`~/VideoRedline`** (a folder called VideoRedline in your home folder) on a Mac. Not OneDrive, Dropbox, iCloud Drive or Google Drive, and not your Desktop or Documents folders either, because on many computers those are copied to the cloud. This matters because the video you transcribe is copied into this folder while it is processed, and the folder holds about 1.5 GB of speech tools. A sync program would upload all of it.

What is checked, and when:

- **At setup, before anything is downloaded:** `setup-windows.bat` and `setup-mac.command` look at the folder's path. If it contains OneDrive, Dropbox, iCloud, Mobile Documents, com~apple~CloudDocs, Google Drive, GoogleDrive or My Drive (capital letters do not matter), they explain the problem and stop, unless you type C to go on anyway. On a Mac they also stop and ask when the folder is inside your Desktop or Documents folder and iCloud Drive is set to keep those folders (they ask the Mac with `defaults read com.apple.finder FXICloudDriveDesktop`; the answer 1 means yes).
- **Each time the helper starts:** the helper makes the same checks, and also looks for a network drive (a mapped drive or `\\server\share` on Windows, a mounted share on a Mac). If one applies, its start-up text shows a WARNING box (in its window, or in the log of a helper that starts by itself). The helper still starts: it only tells you.
- Only the folder's name is looked at. A cloud folder that has a different name, or a link that points into one, is not noticed.

## Using the one-click button

After setup, the Video Redline page can make the transcript for you. A web page cannot start programs, so a small **helper** has to be running first, and the page never starts it by itself (neither do its buttons **Create transcript and find cuts** and **Check again**). On Windows the easy way is the **Video Redline** icon; starting the helper by hand always works too.

**1. Get the helper running** (once, or each time you want to use the button):

- **Windows, the Video Redline icon (the easy way):** double-click the **Video Redline** icon on your Desktop (or in the Start menu). It starts the helper if it is not running (hidden, with no window, usually in under a second) and opens Video Redline. Use it each time you open Video Redline, and also to start the helper again after `stop-helper-windows.bat` or when it ended. If there is no such icon yet, double-click **`setup-autostart-windows.bat`** once (see `AUTOSTART.md`): it adds the icon, and it makes the helper start by itself, hidden and with no window, each time you sign in to Windows. `setup-windows.bat` offers this when it ends. If you deleted the icon, double-click `add-desktop-icon-windows.bat` to make it again. These files come with the Video Redline app: if your tools folder does not have `setup-autostart-windows.bat`, use the next way.
- **Windows, by hand (always works, and the way if you would rather not have the icon):** double-click **`start-helper-windows.bat`** each time you want to use the button, and leave its window open.
- **Mac:** open **Terminal**, type `bash ` (with a space after it), drag **`start-helper-mac.command`** into the Terminal window, and press Return. (Do not double-click it on a Mac: see the Mac setup steps above.)

**2. Look at the helper window** (only if you started the helper by hand: a helper that starts by itself has no window). After a few seconds it says **Video Redline helper is running.** and **Leave this window open. Go back to the page and click Create transcript.** Its last line gives the connection number (normally 47831). Leave the window open. If it says it is running but **NOT ready yet**, setup has not been finished: the window says what to do.

**3. In Video Redline** (on Windows, opened with its icon), open your video, go to the **Audio cleanup** panel and click **Create transcript and find cuts**. A bar shows the progress, and you can press **Cancel**. When it is done, the page applies the cuts it is sure about and queues the rest for you to Accept or Reject.

**4. Stop the helper when you are finished** (you do not have to: a helper that is waiting uses almost no power). If you started it by hand, close its window: that stops it. A helper that starts by itself has no window: double-click **`stop-helper-windows.bat`** to stop it for now (see "Starting automatically (Windows)" below). The **Video Redline** icon starts it again.

Already have a transcript file (made the drag-and-drop way below, or by someone else)? Click **I already have a transcript file** in the panel, or **Open transcript file...** at the top of it, and choose the `...-transcript.json` file. That needs no helper.

### If the button does not work

- **The page says it could not find the helper (Windows).** Double-click the **Video Redline** icon on your Desktop: it starts the helper (the page cannot). Then click **Check again** (you can close the new page that the icon opens). If there is no such icon yet, double-click `setup-autostart-windows.bat` once: it adds the icon. If you would rather not, double-click `start-helper-windows.bat` and leave its window open. On a Mac, start the helper as in step 1 above.
- **The helper window closes at once (Windows).** It closed before you could read it. (This is the window of `start-helper-windows.bat`; the icon has no window.) Open the tools folder in File Explorer, click the address bar, type `cmd` and press Enter, then type `start-helper-windows.bat` and press Enter. That window stays open and shows the message. (On a Mac the Terminal window stays open by itself.)
- **It says the helper is ALREADY RUNNING (in another window, or running hidden).** That is fine: one helper is enough, and closing this window does not stop it. Go back to the page and click **Check again**. To stop that helper (you rarely need to): close the window it runs in. If you cannot find a window, the helper may be running without a window (the automatic start): double-click **`stop-helper-windows.bat`** (if your tools folder has that file) to stop it, then start the helper again (on Windows: double-click the **Video Redline** icon, or `start-helper-windows.bat` if you have no icon). That file only stops a helper that runs from the same tools folder: if you have more than one copy of the tools, use the file in the copy the helper runs from. Or restart the computer (a helper that starts by itself comes back when you sign in).
- **It says the connection numbers (47831 to 47835) are used by other programs.** The helper tries five numbers in a row and something else is using all of them. Close other programs or restart the computer, then start the helper again (on Windows: double-click the **Video Redline** icon, or `start-helper-windows.bat` if you have no icon).
- **The browser asks whether this page may connect to programs on this computer.** Choose **Allow** (the wording differs from browser to browser). The helper only talks to your own computer. If you chose Block by mistake, click the small icon at the left of the address bar, switch that permission back on, reload the page and click **Check again**.
- **The page still cannot find the helper (VPN or firewall).** With the helper running, type `http://127.0.0.1:47831` into the browser's address bar (if you started the helper by hand and its window gives another connection number, use that one). If you see "Video Redline helper is running." (or "Video Redline helper is running in the background." when it started by itself), the helper is fine: check the permission question above. If you see an error, a VPN, firewall or security program is probably blocking your browser from reaching this computer: allow 127.0.0.1 in it, or switch the VPN off for a moment.
- **The card keeps showing "Check again".** The card shows its steps and **Check again** when it cannot find a helper that is ready. Make sure the helper is running (on Windows, double-click the **Video Redline** icon; if you started the helper by hand, its window is open and says **Video Redline helper is running.**), wait a few seconds if it has only just started, then click **Check again**. The button stays grey until a video is open. If the card says the helper is busy, wait for the other transcript to finish. A page that you closed or reloaded in the middle of a transcript leaves the helper busy for up to 10 minutes (it then stops that transcript by itself). To clear it at once on Windows, double-click **`stop-helper-windows.bat`** (or close the helper window, if you started the helper by hand), then double-click the **Video Redline** icon and click **Check again**. On a Mac, close the Terminal window of the helper, start the helper again as in step 1 above, and click **Check again**.
- **The helper was closed in the middle of a transcript** (or stopped with `stop-helper-windows.bat`). The page notices after a short while and says the connection to the helper was lost. Nothing is kept from that run and your video is not changed. Start the helper again (on Windows: double-click the **Video Redline** icon, or `start-helper-windows.bat` if you have no icon) and click **Create transcript and find cuts** again.

### Starting automatically (Windows)

After the one-time setup, double-click **`setup-autostart-windows.bat`** once. It puts the **Video Redline** icon on your Desktop and in the Start menu: double-click it to open Video Redline. If the helper is not running, the icon starts it first (hidden, with no window), also after you stopped it or it ended. The same file makes the helper start by itself, hidden, each time you sign in to Windows. To stop it for now, double-click **`stop-helper-windows.bat`**; to turn the automatic start off for good, double-click **`remove-autostart-windows.bat`**. **`AUTOSTART.md`** explains all of it. Keep the tools folder in your own user folder (for example `C:\Users\<your name>\VideoRedline`): for a folder directly on the C drive, where other accounts can change it, or inside OneDrive and the like, the automatic start warns you and asks whether to go on; for a network drive, a percent sign or a very long path it stops and says why. `setup-windows.bat` offers the automatic start when it ends (press Y to turn it on, Enter to skip it); run that way, it stops instead of asking. If your tools folder does not have these files, start the helper by hand as described above. On a Mac the helper still has to be started by hand.

## Transcribing a video (drag and drop, without the helper)

This way needs no helper and no browser: it writes a transcript file that you then open in the page.

### Windows

1. **Drag your video file onto `transcribe-windows.bat`** (you can drop several videos at once).
   - Or double-click `transcribe-windows.bat`, drag the video into the black window, and press Enter.
2. A window shows what it is doing, with a percentage and a rough "time left".
3. When it says **All finished**, press any key. A new file called **`<your video name>-transcript.json`** now sits right next to your video.

### Mac

1. Open **Terminal**, type `bash ` (with a space after it), drag **`transcribe-mac.command`** into the window, type another space, drag your video into the window too (you can add more videos the same way) and press Return. If you press Return without a video, the window asks you to drag one in. (Dropping a video onto the `.command` file in Finder does nothing.)
2. A window shows what it is doing, with a percentage and a rough "time left".
3. When it says **All finished**, the file **`<your video name>-transcript.json`** is next to your video.

### Then

Open the Video Redline page, open the same video, go to the **Audio cleanup** panel and click **I already have a transcript file** (or **Open transcript file...** at the top of the panel), then choose the `...-transcript.json` file. The page does the rest: it applies the changes it is confident about and queues anything it is unsure of for you to Accept or Reject.

## How long does it take?

The work is done by your computer's processor, so it depends on how fast your computer is. The first 10 seconds or so are spent loading the models.

| Computer | Speed | A 30-minute video takes about |
| --- | --- | --- |
| Fast desktop (measured: Intel i9-13900K, using 8 threads) | about 6 to 7 times faster than the video's length. A 41-minute, 2.1 GB test video took just under 6 minutes. | **about 5 minutes** |
| Ordinary laptop (estimate only, not measured) | about as fast as the video's length, or up to 2x slower | 15 to 45 minutes |

Ways to go faster on a slow computer (add them in the *Options* section below): use a smaller Whisper model (`--whisper base.en`: its part of the work ran about 2 times faster in our test, and on the test clip it still caught all 14 "um"s, but a smaller model is generally less careful with real speech), or skip Whisper entirely (`--no-whisper`, much faster, but it will miss some "um"s and "uh"s).

You can keep working in other programs while it runs, but it will use most of your processor.

## What is in the transcript file?

It is a plain text (JSON) file. The Video Redline page reads it; you do not need to open it. In short:

- **words**: every word with start and end time (in seconds), a confidence from 0 to 1, and which engine heard it (`parakeet`, `whisper` or `both`). "um"s and "uh"s are listed as words.
- **silences**: every quiet stretch of 0.3 seconds or longer (the page decides which are long enough to count as dead space).
- **sounds**: audible things that no engine turned into a word: breaths, mouth clicks, coughs, humming, a stray stutter fragment.
- **engines**: exactly which models and settings made the file.

## Options (advanced, optional)

These go after the video name when you run `transcribe.py` yourself (open a Command Prompt or Terminal in this folder):

```
venv\Scripts\python.exe transcribe.py "my video.mp4" --whisper base.en        (Windows)
venv/bin/python transcribe.py "my video.mp4" --whisper base.en                (Mac)
```

| Option | What it does |
| --- | --- |
| `--out FILE` | Save the transcript somewhere else. |
| `--parakeet v2` or `v3` | `v2` (default) is English only. `v3` understands 25 European languages. Needs a one-time extra download: `--download-models --parakeet v3`. |
| `--whisper MODEL` | `tiny.en`, `base.en`, **`small.en` (default)**, `medium.en`, `large-v3` ... Bigger is more careful and slower. Needs a one-time download of that model (`--download-models --whisper medium.en`). Names without `.en` (like `small`) work for other languages. |
| `--no-whisper` | Skip Whisper (faster, but misses more "um"s). |
| `--no-parakeet` | Skip Parakeet (Whisper timing only: less exact). |
| `--threads N` | How many processor threads to use (default: up to 8, leaving a couple free). |
| `--machine` | For other programs: progress lines start with `PROGRESS ` followed by a JSON object (`stage`, `percent`, `elapsed`, `remaining` in seconds, `detail`). Other lines are ordinary messages and can be ignored. |
| `--self-test` | Quick check that everything works. |
| `--check-venv`, `--check-packages` | Used by the setup file: is the private Python really this folder's own, and can every speech package start on this computer? |

## If something goes wrong

**It says the setup has not been run.** Run the setup file first: double-click `setup-windows.bat`, or on a Mac run `setup-mac.command` with `bash` as described under "Mac" above.

**Setup says "this file was opened from INSIDE the zip download".** You double-clicked `setup-windows.bat` (or `transcribe-windows.bat`) inside the zip, so Windows unpacked only that file. Close the window, right-click the zip, choose *Extract All...*, and open the file from the new folder. On a Mac, unpack the zip in Finder and run `setup-mac.command` (with `bash`, as above) from the unpacked folder.

**Setup stops with "a download failed".** Check that you are online and that no VPN or firewall blocks `github.com`, `pypi.org` and `huggingface.co`. Run the setup file again (double-click it on Windows; on a Mac use `bash` as above); it continues where it stopped.

**It says "missing a free Microsoft component" (Visual C++ Redistributable).** Windows only. Copy `https://aka.ms/vs/17/release/vc_redist.x64.exe` into your web browser, open the file that downloads, tick *I agree*, click *Install* and click *Yes* when Windows asks for permission (this one step needs an administrator; ask your IT person if you do not have the rights). Then run the setup file again. The same message can appear later, when the tool starts, if the component is damaged or too old.

**It says "this tools folder was moved, renamed or copied after setup".** The private Python inside the folder remembers where it was installed. If a helper is running, end it first: close its window, or double-click stop-helper-windows.bat (if your tools folder has that file). Run the setup file once more (double-click on Windows, `bash` on a Mac): it repairs the folder, normally in under a minute and without downloading anything big (if that repair does not work it rebuilds the working space, about a 100 MB download). The speech models are kept. On Windows, then double-click `setup-autostart-windows.bat` once more (if your tools folder has it): until you do, the **Video Redline** icon and the automatic start still point at the old place. To avoid all this, do not move or rename the folder after setup, and copy it only before you run setup.

**You want to move, rename or replace the tools folder (for example with a newer copy).** If a helper is running, end it first: close its window, or double-click stop-helper-windows.bat (if your tools folder has that file). Windows will not move or delete a folder while a helper runs from it, and setup cannot repair files that the helper is using. Afterwards run the setup file in the new place (it repairs the folder and keeps the speech models). If you use the **Video Redline** icon or the automatic start, run `setup-autostart-windows.bat` again from there: it makes the icon and the start-up setting point at the new place. When `setup-windows.bat` has to repair the folder and `stop-helper-windows.bat` is in the same folder, it runs that file for you first.

**It says a speech model "was only partly downloaded".** The download was interrupted (the window was closed or the connection dropped). Run the setup file again: it fetches the missing part.

**A line starting with "Note:" appears before the work starts.** The audio in your file has a timing problem (a gap in its timestamps, damaged pieces, or two recordings joined together). The tool puts the words back on the right time where it can and tells you what it did. Words said inside a damaged stretch are missing. If the picture and the words drift apart anyway, re-export the recording from your recorder.

**Windows says "Windows protected your PC".** Click *More info*, then *Run anyway*. If you downloaded the folder as a zip file, right-click the zip, choose *Properties*, tick *Unblock*, press OK, then extract it again.

**A Mac says the file "cannot be opened", shows a permission message, or says it "is from an unidentified developer".** Do not double-click these files on a Mac. Open Terminal, type `bash ` (with a space after it), drag the file into the window and press Return. A file run this way should not be stopped by those messages.

**"I could not open that file as a video".** The file may be damaged, still being recorded or copied, or a format I do not know. Try opening it in a video player first. Screen recordings in `.mp4`, `.mov`, `.mkv`, `.webm`, `.avi` and audio files (`.wav`, `.mp3`, `.m4a`) are fine.

**"This file has no audio track".** The recording has no sound (for example, a screen recording made with the microphone off).

**It is very slow.** See "How long does it take?" above. Close other heavy programs, or use `--whisper base.en`.

**The computer ran out of memory.** Close other programs and try again. A long video does not need much more memory (the audio is read in small pieces: the 41-minute test used 2.3 GB at most, of which about 1.9 GB is just the two speech models).

**The words are wrong or in the wrong language.** The default model is for English. For other European languages use `--parakeet v3` and a Whisper model without `.en` (for example `--whisper small`).

**Something else.** Send the files in the folder `logs` (inside the tools folder) to the person who invited you to the beta: `helper.log` (a helper that starts by itself or with the **Video Redline** icon has no window, so it writes its messages there) and `last-error.txt`, if there is one. If a window showed the problem, add a photo of it.

## What was installed, and how to remove it

Everything lives inside this one folder. `setup-windows.bat` and `setup-mac.command` do **not** touch the rest of your computer: no system-wide install, no changes to PATH or to the registry, no administrator rights. (The one thing outside the folder is Microsoft's Visual C++ Redistributable on the few Windows PCs that lack it: setup only checks for it and tells you how to install it yourself.)

The automatic start on Windows is the exception. `setup-autostart-windows.bat` (which `setup-windows.bat` offers when it ends) adds one start-up setting for your Windows user, plus the **Video Redline** icon on your Desktop and in the Start menu. The helper that it starts keeps a small log in `logs\helper.log` inside this folder.

**To remove everything:** if you ran `setup-autostart-windows.bat` (or pressed **Y** at the end of setup), first double-click **`remove-autostart-windows.bat`** (if your tools folder has that file). It stops the helper and removes the start-up setting, the icons and the log. Then delete the folder. If you delete the folder first, the start-up setting stays behind, and Windows shows a message at sign-in that it cannot find `pythonw.exe`; to clean that up, unpack the tools again and double-click `remove-autostart-windows.bat` in that new copy. If you never turned the automatic start on, just delete the folder.

| Folder | What it holds | Size |
| --- | --- | --- |
| `uv/` | The small installer used by setup | about 50 MB |
| `python/` | A private copy of Python 3.12 | about 70 MB |
| `venv/` | The speech-tool packages (list in `requirements.txt`) | about 250 MB |
| `hf-cache/` | The speech models (Parakeet, Whisper, voice detector) | about 1.1 GB |

Setup prints every download as it goes, with its size and where it comes from: github.com (the small installer and the private Python), pypi.org (the packages) and huggingface.co (the speech models).

## How good is it? (please read)

The tool was tested on one **synthetic** clip: 112 seconds of a computer-generated voice reading an Excel tutorial, with 14 "um"/"uh"/"erm" sounds, 8 long pauses, 3 stutters, 4 repeats, 3 false starts and 8 non-word sounds inserted at known places. On that clip it found all 14 fillers, all 8 pauses, and all 8 non-word sounds. **This proves the pipeline works. It does not prove it will be that accurate on a real person talking.** The computer voice is clean and steady; the "um"s were synthetic; real "um"s trail off, vary in pitch and blend into the next word; real rooms have fans and keyboards. Expect real speech to be harder. Known weak spots:

- **Stutters and repeated words** ("the, the, the data") are often smoothed away by both engines. The tool surfaces some of them as short unexplained sounds, but it will miss others.
- A real "um" that runs straight into the next word, with no gap, can be missed or have rough edges.
- Whisper sometimes invents an "um" in a noisy gap. The tool throws those away when there is no sound at that spot, but a loud noise can fool it.
- Background music, several people talking at once, or very noisy recordings reduce accuracy.
- Non-English speech needs the `--parakeet v3` and non-`.en` Whisper options and has **not been tried on real recordings**. Words in other alphabets (Cyrillic, Greek, Chinese, Japanese ...) are no longer thrown away by the merge step, which was checked with made-up word lists only. The list of "um"-like fillers is English only.
- **Numbers, prices and percentages** ("had 150 orders in 2024", "$45.50", "12%") are now separate words with their own timing. This is checked on two made-up clips read by the Windows computer voice (`audio-test/numbers`), not on real people. Whisper writes "2,024" as two pieces, so a number with a thousands comma is taken from Parakeet alone.
- **A word at the join of two speech chunks** is kept once, not twice. Checked on one made-up 115-second clip (`audio-test/continuous`); how often this happens in real recordings is not known.

## For developers

- `transcribe.py`: the command line and the pipeline. `vrt_audio.py`: streaming decode (PyAV), energy envelope, silences, sounds, filler edge snapping (numpy only). `vrt_engines.py`: Parakeet (onnx-asr, with a patched TDT loop that also returns token durations: that loop is a modified copy of an onnx-asr function, and the copyright line and permission notice that go with it are in the comment above it in the file) and Whisper (faster-whisper, one call per window of at most 24 seconds so every window gets the verbatim prompt). `vrt_merge.py`: the merge rules.
- Parakeet runs the int8 ONNX model with Silero VAD chunking. Whisper runs int8 on the CPU with `word_timestamps=True`, `vad_filter=False`, `condition_on_previous_text=False`, `no_speech_threshold=None`, `log_prob_threshold=None`, and the prompt "Umm, let me think like, hmm... Okay, here's what I'm, like, thinking."
- Output format: `{"format":"video-review-transcript","version":1,"video","engines","words","silences","sounds"}`. Each word is `{w, s, e, c, src}`; `w` keeps the engine's own capitalisation and punctuation.
- Why Parakeet v2 is the default: it is the English-only model, and v3 is the 25-language one. On the synthetic test clip the two were equal (11 of 14 fillers on their own, 271 of 274 ordinary words the same), so the choice rests on the usual trade (a multilingual model may give up a little English accuracy) and is **not** something this test proved. Switch with `--parakeet v3` if you record in another European language.
- `vrt_env.py`: checks that need no heavy imports (missing Visual C++ runtime, folder moved after setup, `--check-packages`).
- `vrt_server.py` (started by `start-helper-windows.bat` / `start-helper-mac.command`): the small local server the Video Redline page uses. It has no password on purpose; `README-helper-security.md` says in plain words what that allows and what limits the damage (disk guard, abandoned-job guard, 3-hour limit). Each running helper keeps its jobs in its own `tmp/jobs-<port>/` folder, held by a lock file `tmp/jobs-<port>.lock`; on start it deletes only the folders whose lock nobody holds. The lock file also holds a random word of that helper, and the helper writes the same word and its folder name into `vrt-owner.txt` inside the scratch folder (`tmp/run-*`) that its job makes; so a helper that starts later can delete the scratch audio of a helper that was killed in the middle of a job at once, while a folder of a running helper, or a folder without that mark (the drag-and-drop launcher makes those), keeps the old rule (deleted only when no helper runs and it is more than 5 minutes old). `GET /status` also says `syncWarning` (true or false: the tools folder is in a cloud-synced folder or on a network drive, the same check as the WARNING box; never the folder name). The check is made before the helper starts to answer, so even the first answer has the right value (the start waits for it for one second at most). The lock file `tmp/spawn.lock`, which the helpers share while a job starts, is deleted at start-up and after each job when no other helper runs. The tidy-up at the end of `setup-windows.bat` uses the same functions, so it never deletes the job folder of a helper that is running. When several helpers start at the same moment, a port that is in use is looked at for up to `VRT_PORT_PROBE_S` seconds (default 4) before the next port is tried, so the slow winner is found as "already running". If the helper is started without a window (the Windows automatic start), set the environment variable `VRT_BACKGROUND=1` first (any value except empty, 0, false or no): its window texts then say that it runs in the background and how to stop it (`stop-helper-windows.bat`, or, when that file is not in the folder, the `pythonw.exe` program that has the tools folder in its command line, which Task Manager shows on the Details tab once the Command line column is added; on a Mac: end the python process called `vrt_server.py`) instead of "leave this window open". A helper that is started by hand and finds one already running says ALREADY RUNNING (in another window, or running hidden), that closing its own window stops nothing, and how to stop the one that runs (and that `stop-helper-windows.bat` only stops a helper of its own tools folder).
- Word joining: `vrt_engines.tokens_to_words` turns Parakeet's tokens into words. The bare space token that comes before digits is the word-start marker and is remembered (it used to be dropped, which glued `150` to `had`); "$" and "(" after a marker start a new word; "1,250" and "10:30" stay whole. `add_chunk_words` removes the copy of a word that two overlapping speech chunks both heard (one to one, so a real repeat survives).
- `vrt_audio.decode_to_pcm` places every decoded frame by its own timestamp: a gap becomes silence, a small overlap is trimmed, a huge jump is not filled with hours of silence. It returns `warnings` (plain sentences the launcher prints as "Note: ...").
- `dev/evaluate.py` compares an output file with the ground truth of the synthetic test clip.
- **Tests** are in `tests/`. From this folder: `venv\Scripts\python.exe -m unittest discover -s tests -v` (Mac: `venv/bin/python`). `test_helper.py` is fast and needs no models; `test_folders_and_origins.py` is fast too (the folder check, the `file://` page origin, the wording of the launcher texts; it runs the helper inside the test on a spare port, never on 47831 to 47835, and nothing is downloaded); `test_windows_scripts.py` builds a throw-away install in `tmp\test-scratch\` and runs the real batch files in it offline (a few minutes, Windows only); `test_real_models.py` runs the real models on the clips in `audio-test\` (skipped when they are missing). Set `VRT_TOOLS_DIR` to another copy of the code to run the same tests against it. All audio in the tests is synthetic. The Mac scripts are only syntax-checked and smoke-tested with whatever bash the computer has; they have never run on a Mac.
- `.gitignore` keeps the download (`python/`, `venv/`, `uv/`, `hf-cache/` ...) and the icon pictures that `add-desktop-icon-windows.bat` writes into this folder (`*.ico`) out of version control; the 652 MB Parakeet file alone is more than GitHub accepts. It lists `dev/` as well, so use `git add -f dev/evaluate.py` if you want that tool committed. `.gitattributes` keeps LF line endings in the `.command` files (a CR breaks `#!/bin/bash`) and in the `.py` and `.pyw` files, and CRLF in the `.bat` files. After the first commit, from the top folder of the repository (the one that contains `tools/`), run `git update-index --chmod=+x tools/setup-mac.command tools/transcribe-mac.command tools/start-helper-mac.command`, because a file committed from Windows loses its executable bit. Even then, a browser-downloaded ZIP can leave the files without it, which is why this README tells Mac users to run them with `bash`.
- Pinned versions are in `requirements.txt`.

## Credits and licences

Credits and licences for everything this tool uses are in [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) (in the folder above this one).

> **Parakeet TDT 0.6B** (v2, and the optional v3) by **NVIDIA**, licensed under **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/). Sources: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2 and https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3 . The model pages give no separate copyright line, so NVIDIA is named as the creator. Converted to ONNX format (including the smaller 8-bit "int8" files this tool uses) and published by **Ilya Stupakov (istupakov)**, also under CC BY 4.0: https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx and https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx . Video Redline runs these files as published and does not change them. The models are provided "as is", without any warranty (see section 5 of the licence).
