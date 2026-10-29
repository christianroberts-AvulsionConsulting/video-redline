# Video Redline

**Version 0.1.0-beta** (the same number is shown at the bottom of the page, next to **All shortcuts**; please mention it in any report).

Mark up a video, design the visuals you want on it, then hand your notes to an AI editing assistant.

You open a video on your own computer, mark sections on a multi-track timeline, write a comment on each one, draw boxes on the picture to show where a visual should go, and pick **what kind of visual** and **what style** it should have. One button then gives you a markdown file and a JSON file that an assistant such as Claude can read and act on, with exact times, exact box positions and the exact design tokens to use.

Made for **Mac and Windows**. It is one file. The page itself needs nothing installed, no account and no internet. Only the optional transcript maker needs a one-time download of about 1.3 GB. **Your video never leaves your computer.**

**Beta: what has been tried.** The pieces have been tried on Windows 11 with Chrome: the page, the Video Redline icon and the automatic start. This exact download, installed from nothing on a clean PC, is the first test of this beta. Not tried yet: Edge by hand (it uses the same engine as Chrome and should behave the same), Safari, Firefox, any Mac, and a real Windows sign-out and sign-in after the automatic start was set up. If you try one of these, please tell us how it went.

**Questions, bugs or feedback:** open an issue on the Video Redline page on GitHub (the **Issues** tab at the top), or tell the person who invited you to the beta. Please add a photo of the window and the log: on Windows the file `tools\logs\helper.log` (right-click it, choose **Open with**, then **Notepad**); on a Mac a screenshot of the Terminal window, and `tools/logs/last-error.txt` if it exists. The log holds the path of your folder, which includes your Windows user name, but never the names of your videos or what was said; edit the name out if you prefer.

## Get started in 5 steps (Windows)

**You need:** Windows 10 (version 1803 or newer) or 11, 64-bit; Chrome or Edge; about 2 GB of free disk space (1.5 GB stay used); at least 4 GB of memory; and an internet connection for the one-time setup (about 10 minutes, about 1.3 GB of downloads, so use Wi-Fi if your connection is limited). Your video never leaves your computer.

**Words used here.**
- **Helper:** a small program on your own PC that turns the speech in your video into text. It never uses the internet while it works.
- **Video Redline folder:** the folder that has `video-redline` and `tools` inside it.
- **tools folder:** the folder named `tools` inside the Video Redline folder.

Windows may hide the last part of file names (`.bat`, `.html`), so `setup-windows` and `setup-windows.bat` are the same file. To show them, open any folder. On Windows 11 click **View**, then **Show**, then tick **File name extensions**; on Windows 10 click the **View** tab and tick **File name extensions**. To open a `.md` file, right-click it, choose **Open with**, then **Notepad**.

**1. Download and unblock.** You need the file `video-redline-0.1.0-beta.zip`. If someone sent it to you, save it in your **Downloads** folder. If you have access to the Video Redline page on GitHub, click **Releases** (on the right-hand side), open the newest release, and under **Assets** click `video-redline-0.1.0-beta.zip`. (Do not use the green **Code** button: its **Download ZIP** is a different package.) Open your **Downloads** folder, click the ZIP file once, and press **Alt + Enter**. At the bottom of the window that opens, tick **Unblock** (if you do not see that box, carry on), then click **OK**. This stops Windows from showing a warning for every file inside.
*If GitHub shows a 404 page ("Page not found"):* check the address, or ask the person who invited you to the beta for the ZIP.

**2. Unpack it into its own folder.** Press the **Windows key + R**, type `%USERPROFILE%` and press Enter. A window with your personal folders opens. Right-click an empty space, choose **New**, then **Folder**, and type the name `VideoRedline`. Go back to **Downloads**, right-click the ZIP, choose **Extract All...**, click **Browse...**, pick your new `VideoRedline` folder and click **Extract**. Open the folders inside until you see a file called `video-redline` and a folder called `tools` side by side. That place is your Video Redline folder. You will also see a folder `src` and a few text files such as `README` and `LICENSE`: they hold notes and licences, so ignore them. (Do not use Desktop or Documents: on many PCs they are copied to OneDrive, and your videos would be copied along with the speech tools. If your Windows user name has letters outside the usual alphabet, for example Chinese characters, the icon in step 4 cannot be made: tell the person who invited you to the beta.)

**3. Set up the transcript maker (once, about 10 minutes).** Open the `tools` folder and double-click `setup-windows`. A black window opens: that is normal, and it may look quiet for a minute, so leave it open until it says **ALL DONE**. If Windows says **Windows protected your PC**, click **More info**, then **Run anyway**. If it says **Open File - Security Warning**, click **Run**. (Only do this for files from this download.) Press any key when it asks. At the very end it asks **Start the helper by itself? (Y = yes, Enter = no)**: type **Y** and press Enter. That does step 4 for you (about 10 seconds, and it ends with **OK. The helper now starts by itself.**), so you can go on to step 5. If you pressed Enter by mistake, do step 4.

**4. Make the Video Redline icon (once).** Skip this if you answered Y at the end of step 3. In the same `tools` folder, double-click `setup-autostart-windows`. Read the lines it shows, then press the **Y** key. After about 10 seconds it says **OK. The helper now starts by itself.** You now have a **Video Redline** icon on your Desktop and in the Start menu.
*What this changes:* one setting that starts the helper in the background, with no window, each time you sign in to Windows, and the two icons. It needs no administrator password and affects only your Windows user. (Windows may say that a startup app called "Python" was added. That is the helper.) There is only one such setting and one such icon per Windows user: if you already set up another copy of Video Redline (even one called Video Review) in a different folder, this replaces it. Details are in `tools/AUTOSTART.md`.

**5. Get your transcript.** Double-click the **Video Redline** icon. Click **Open video** and choose your video. Click the **Cleanup** tab, then **Create transcript and find cuts**. If your browser asks whether this page may connect to other apps or devices on your computer, click **Allow**. A bar shows the progress. A transcript usually takes about as long as your video, and on a fast computer much less (about 5 minutes for a 30-minute video). Keep working in other programs if you like, but do not close or reload the Video Redline page while the bar is moving.

**Opening Video Redline.** On Windows, after step 4, always use the **Video Redline** icon (on your Desktop, or press the Windows key and type Video Redline). Double-clicking `video-redline` also works, but it does not start the helper. Why an icon? A web page cannot start a program on your computer, so the icon starts the helper for you. The icon opens the page in your default browser: for the beta, make that Chrome or Edge (Firefox and Safari are not tried yet).

**Next time:** just double-click the **Video Redline** icon. That is all.
**Only want to mark up videos, with no transcript?** Do steps 1 and 2, then double-click `video-redline`.
**Do not want the automatic start?** Skip step 4. Each time you want a transcript, double-click `start-helper-windows` in the `tools` folder and leave its window open.
**Stuck?** See *If something goes wrong* below.

**Windows warnings you may see. They are normal for a download.**
- **"Windows protected your PC" (blue window):** Windows does not know the publisher of a downloaded script. Click **More info**, then **Run anyway**.
- **"Open File - Security Warning":** same reason. Click **Run** (or **Open**).
- **"Do you want to allow this app to make changes to your device?":** you will only see this if setup asks you to install one free Microsoft component. Click **Yes** then. If it appears at any other time, click **No** and ask the person who invited you to the beta.
- **"A startup app called Python was added":** that is the Video Redline helper. Nothing to do.
- **Your browser asks about connecting to other apps or devices:** click **Allow**.
- **"How do you want to open this file?" when you open a .md file:** right-click the file, choose **Open with**, then **Notepad**.

Want to see what a `.bat` file does before you run it? Right-click it and choose **Edit** (it opens in Notepad; close it without changing anything). Only click "Run anyway" for files from this download.

**Keep the folder where it is.** If you move, rename or delete the Video Redline folder later, double-click `stop-helper-windows` first (Windows will not move a folder while the helper runs from it). After moving it, run `setup-windows`, then `setup-autostart-windows`, again from the new place.

## Get started on a Mac (not tried yet)

**You need:** a Mac with Apple silicon (M1 or newer) and macOS 14 or newer (an Intel Mac is the least tried); Safari 16 or newer, or Chrome; about 2 GB of free disk space (1.5 GB stay used); at least 4 GB of memory; and an internet connection for the one-time setup (about 10 minutes, about 1.3 GB of downloads).

**Easiest: let an AI agent on the Mac do it** (Claude Code or similar). Paste this to it:

> Install Video Redline for me. Work in my home folder, not Desktop or Documents. (1) Run `git clone https://github.com/christianroberts-AvulsionConsulting/video-redline.git ~/VideoRedline`. If the Mac offers to install Apple's command line tools, tell me to click Install and wait, then try again. (2) Run `VRT_NO_PAUSE=1 bash ~/VideoRedline/tools/setup-mac.command`. It downloads about 1.3 GB and takes 5 to 15 minutes; wait for ALL DONE. If it prints PROBLEM, follow its WHAT TO DO line. (3) Start the helper in the background with `VRT_NO_PAUSE=1 nohup bash ~/VideoRedline/tools/start-helper-mac.command > /dev/null 2>&1 &`, then open `~/VideoRedline/video-redline.html` in Chrome or Safari. Tell me exactly what you saw: nobody has tried this on a Mac yet.

Everything is installed inside `~/VideoRedline`; nothing else on the Mac changes. To do it by hand instead, follow the steps below.

1. Get the file `video-redline-0.1.0-beta.zip` the same way as in step 1 above (sent to you, or **Releases**, then **Assets** on the GitHub page). Double-click the ZIP in Finder: a folder called `video-redline-0.1.0-beta` appears next to it. Drag that folder into your home folder (the one with your name; not Desktop or Documents) and rename it `VideoRedline` (click it once, press Return, type the name). Inside it you should see `video-redline.html` and a folder `tools`.
2. Open the **Terminal** app: press Command + Space, type Terminal, press Return.
3. Type `bash ` (with a space after it), then drag `setup-mac.command` from the `tools` folder into the Terminal window (this types its location for you). Press Return. Wait for **ALL DONE** (about 10 minutes).
4. Each time you want a transcript: do the same with `start-helper-mac.command` and leave the Terminal window open. Then double-click `video-redline.html` in your `VideoRedline` folder, click **Open video**, choose your video, click the **Cleanup** tab and press **Create transcript and find cuts**. (Bookmark the page in your browser to open it faster.)

macOS may ask whether Terminal may reach your files, or whether a program may accept incoming network connections, and your browser may ask whether the page may connect to other apps or devices on your computer. Choose **Allow**. None of this has been tried on a Mac yet, so please tell us what you see.

**If something goes wrong on a Mac,** read *If something goes wrong* in `tools/README.md`. Send the person who invited you to the beta a screenshot of the Terminal window.

**Update on a Mac, if you installed with `git clone`:** ask your agent: "Update Video Redline: stop the helper with `pkill -f vrt_server.py`, run `git -C ~/VideoRedline pull`, run `VRT_NO_PAUSE=1 bash ~/VideoRedline/tools/setup-mac.command` (quick when nothing big changed; it keeps the speech models), start the helper again as before, then reload the page. If git pull complains about changed files, stop and tell me instead of discarding anything." Your speech tools and saved sessions are not part of the repository, so the update leaves them alone.

**Update on a Mac, if you installed from the ZIP:** close the Terminal window of the helper; unpack the new ZIP into a temporary folder; in Terminal type `ditto ` (with a space), drag the new unpacked folder into the window, type a space, drag your `VideoRedline` folder into the window, and press Return (`ditto` adds the new files and leaves your speech tools in `tools` alone; do not drag one folder over the other in Finder and choose Replace: that deletes your speech tools and you would download them again); then do step 3 again.

**Uninstall on a Mac:** close the Terminal window of the helper, then drag the `VideoRedline` folder to the Bin and empty it. Nothing is installed anywhere else.

## If something goes wrong (Windows)

| What you see | What to do |
|---|---|
| A black window says **PROBLEM** | Read the line under **WHAT TO DO** and do that. Running the same file again fixes most problems. |
| The page says it cannot find the helper | Double-click the **Video Redline** icon, then click **Check again** in the page. |
| Setup says **a download failed** | Check your internet connection, switch off any VPN, and double-click `setup-windows` again. It continues where it stopped. |
| Setup says a **free Microsoft component** is missing | Follow the 3 steps it shows. One of them needs you to click **Yes** once. Then run `setup-windows` again. |
| Setup says the folder was **moved, renamed or copied** | Double-click `setup-windows` again. It repairs the folder. |
| Windows says the folder is **in use** when you move or delete it | Double-click `stop-helper-windows` first. |
| The page says the helper is **busy** | Wait until the other transcript has finished (one left behind by a page you closed ends by itself after about 10 minutes), or double-click `stop-helper-windows`, then the **Video Redline** icon, then **Check again**. |
| You clicked **Block** when your browser asked about connecting to other apps | Click the small icon at the left of the address bar, switch the permission back on, reload the page, then click **Check again**. |
| A security program removed or blocked a file (for example `pythonw.exe` or `helper_launcher.pyw`), or the icon says nothing happened | In that program, allow your `VideoRedline` folder, then double-click `setup-windows` again. |
| The icon opens the page but says the helper did not start | Restart your computer, then click the icon again. |
| Nothing helps | Double-click `start-helper-windows` and leave its window open. Take a photo of the window. Send it, and the file `tools\logs\helper.log` (right-click, **Open with**, **Notepad**), to the person who invited you to the beta. |

On a Mac, see the Mac steps above. `tools/AUTOSTART.md` has a longer table for Windows. To open a `.md` file, right-click it, choose **Open with**, then **Notepad**.

## Update to a newer beta (Windows)

1. In Video Redline, use **File, Save session** for any video you are still working on. (Your markers are normally kept in your browser too, but this is a safe copy. It goes into the `sessions` folder, which step 4 leaves alone.)
2. Open your Video Redline folder, open `tools`, and double-click `stop-helper-windows` (it also stops a helper you started by hand). Windows cannot replace files while the helper is running.
3. Download the new ZIP from **Releases** (or take the one you were sent) and unblock it (step 1). Extract it into a temporary folder, for example inside Downloads. Do not extract it into your Video Redline folder.
4. Open the new folder until you see `video-redline` and `tools`. Select everything (Ctrl + A), copy (Ctrl + C), go to your own Video Redline folder, and paste (Ctrl + V). When Windows asks, choose **Replace the files in the destination**. Your speech tools (the folders `venv`, `python`, `hf-cache` and `uv` inside `tools`) are not in the ZIP, so they stay, and you do not download them again.
5. Open `tools` and double-click `setup-windows` once more. When nothing big changed it finishes quickly. Wait for **ALL DONE**.
6. Double-click the **Video Redline** icon. Delete the temporary folder and the ZIP.

If Windows says the folder was moved or copied, double-click `setup-windows` again.

## Uninstall completely (Windows)

1. Open your Video Redline folder, open `tools`, double-click `remove-autostart-windows`, and press **Y**. It stops the helper and removes the start-up setting and the **Video Redline** icons. Do this **before** step 3.
2. Close the Video Redline page in your browser.
3. Your saved sessions are in the `sessions` folder inside it: copy that folder somewhere safe first if you want to keep them. Then delete the whole `VideoRedline` folder (right-click it, **Delete**). Then right-click the **Recycle Bin** and choose **Empty Recycle Bin** to get the space back (about 1.5 GB). If Windows says a file is in use, restart your computer and try again.
4. Delete the ZIP file and any other extracted copy in your **Downloads** folder.
5. Check: open **Settings**, then **Apps**, then **Startup**. There should be no "Python" entry from Video Redline.

Your markers stay in your browser. They take almost no space, so you can leave them. If you installed the free Microsoft Visual C++ component, leave it: other programs use it.

## The screen

Laid out like a video editor:

- **Left panel** runs the full height of the window and has four tabs: **Cleanup** (finds ums, dead air and stutters from a transcript; its heading says Audio cleanup; the page opens on this tab), **Markers** (your list), **Styles** (the look of a visual; the **Filter** button narrows the list) and **Visuals** (designs you saved).
- **Middle** is the video with the play controls under it.
- **Right panel** shows the **Properties** of the marker you selected: type, comment, times, its visual and boxes.
- **Bottom** is the timeline, under the video and the properties, one track per marker type. Drag the bar above it to make it taller or shorter.
- The strip at the very bottom always shows the main shortcuts. Press **?** for the full list.

## Use it

1. Click **Open video** (or drop the video onto the page). Check the **Frame rate** box matches your video (30, 29.97, 60 and so on). Browsers cannot always tell. Use a current Chrome or Edge, or Safari 16 or newer. If the video will not play, open the page in Chrome or Safari, and use an `.mp4` (H.264) or `.mov` video.
2. Play with **Space**. Step one frame with the **←** and **→** arrow keys, one second with **Shift** and the arrows.
3. Press **M** to drop a one-second marker at the playhead. Or drag on a timeline track to mark a stretch of any length (a marker made on the *list* track becomes a list marker). Or press **I** at the start and **O** at the end, then **M**.
4. With a marker selected, use the **Properties** panel: pick a **type**, type exact **Start** and **End** times if you like (`1:23.45` or `83.5`), and write a comment.

   | Type | What it tells the assistant |
   |---|---|
   | cut | Remove this sound or section |
   | visual | Add a picture, screenshot or clip over the video |
   | list | Show a list on screen |
   | diagram | Show a diagram on screen |
   | note | A comment only, no edit |
   | custom | Type your own |

5. To show where a visual should sit, **drag on the video** to draw a box. Drag the box to move it, drag its corners to resize it, and click the × to delete it. The box only shows while the playhead is inside that marker.
6. Click **Export for Claude**. Two files land in your Downloads folder: `<video name>-review.md` and `<video name>-review.json`. Give both to Claude. (Your browser may ask whether to allow multiple downloads. Say yes.) **Copy markdown** puts the same notes on your clipboard instead.

### Zooming the timeline

Use the zoom slider and buttons above the timeline, the **+** and **-** keys (**0** shows the whole video again), or hold **Ctrl** (**⌘** on a Mac) and turn the mouse wheel. **Zoom to marker** fills the timeline with the selected marker. Scroll sideways to move along the timeline.

### Zooming the picture

To look closely at part of the video, turn the **mouse wheel** over the picture (it zooms in at the mouse), or use the **+** and **−** buttons at the bottom right of the picture. **Fit** shows the whole picture again. Drag to move a zoomed picture. If a marker is picked, a drag draws a box instead, so hold **Shift** (or use the middle mouse button) to move the picture. Boxes still line up with the video at any zoom. Opening another video starts at the whole picture again.

## Visuals and styles

For the types **visual**, **list** and **diagram**, the Properties panel has a **Visual** section. The quick way to use it:

1. Pick the marker's **type** (for example *list*) and write what you want in the **Comment**, for example "a list of the three golden rules".
2. **Drag a box on the video** where the visual should go. Drag its corners to change the size.
3. That is all. By default **AI writes it from my comment**: the words are not typed by you. The box shows a dashed outline and a skeleton preview, and the export tells the assistant to write the text from your comment and from what is said at that moment.

Optional choices in the same section:

- **What kind of visual?** bullet list, numbered steps, flow diagram, callout, highlight ring, lower third, title card, big number, quote, or keyboard shortcut keys (great for Excel and Word lessons).
- **Style**: pick from about 150 design systems (Minimal, Glassmorphism, Brutalism, Editorial and many more), or one you imported. If you do not choose, the default style is used.
- **Who writes the words?** Choose **I will type it** to type the title and text yourself. Switching back to AI keeps what you typed, but it is not exported while AI writes the text.
- **More options**: alignment, panel (solid, soft or none), text size, accent colour, and the designer window.

The visual is drawn live inside the box you drew, on top of the video, so you see how it will sit over the real picture. Use the eye button on the video to switch between the styled preview and plain boxes.

**Note for the AI.** A library visual can carry a note for the editing assistant, for things the picture cannot show, such as "turn the number slowly around its vertical axis in 3D" or "fade in slowly". Write it in the designer (Visuals tab, **New** or **Edit**). Each time you press **Use**, the note is added to the marker's **Comment**, so it goes out with **Export for Claude** and you never have to type it again. Pressing **Use** again on the same marker does not add it twice, and using a different visual takes the old note out again while it is still unchanged in the Comment. Notes are saved in the library file and can be written by the **Make with AI** prompt (ask it for "a 3D rotating number" and it puts the motion in the note). Nothing moves inside this tool; the preview stays still.

**Visuals tab.** Save any visual you like to your library with **Save** and use it again on any video (a saved visual remembers whether AI or you writes the words). Each saved visual is one row with **Use**, **Edit**, **Duplicate** and **Delete** buttons. The tab starts with a few examples. **New** opens a larger designer window that shows your design on top of the frame the video is paused on.

**Make visuals with an AI.** Press **Make with AI** at the top of the Visuals tab or the Styles tab (both open the same window) to let any AI assistant (Claude, ChatGPT, Gemini or another) write visuals for your library. Say what you want, press **Copy prompt** and paste it into the assistant. It answers with a block of text: copy all of it, paste it into the box at the bottom of the same window and press **Add to my library**. (You can also save it as a file that ends in `.json`, for example `my-visuals.json`, and load it with the upload icon at the top of the Visuals tab.) The new visuals are added at the bottom of your list and nothing is replaced (if you started from the Styles tab, the Visuals tab opens so you can see them). If the AI used a kind of visual this tool does not have, you are told, and that visual is shown as a title card. The prompt explains the file format, lists the kinds and styles this tool has and includes an example, so the assistant stays within what the tool understands. It cannot add a brand-new kind of visual: a kind the tool does not know is shown as a title card. This page sends nothing anywhere; you do the copying and the loading.

**Styles tab.** Browse, search and star styles. Click a style to apply it to the selected visual (or, with nothing selected, to make it the style for new visuals). **Import** adds another design system: pick the `DESIGN.md` and `tokens.css` files from any folder in the Open Design repository.

When you export, each visual is described in plain words (kind, options, which box it goes in), and the styles used are listed with their colours, fonts, corner radius and shadow so the assistant can build the overlay to match. If you typed the words, they are included. If you chose **AI writes it from my comment**, the export says what to write (for example "a heading and 3 to 6 short bullets") and, when a transcript is loaded in the Cleanup tab, adds the words spoken during that marker (for a very long marker only the first 1,200 characters or so, about 90 seconds of speech, and the export says that it was cut short).

## Audio cleanup (the Cleanup tab)

Finds the things you would otherwise cut by hand: long dead air, ums and ers, stutters, repeated words, false starts, and other sounds that are not words (breaths, clicks, coughs).

### Get a transcript

Cleanup works from a **transcript with word times**. There are two ways to get one.

**A. Let the helper make it (one click).** Follow *Get started in 5 steps* above (or the Mac steps). The helper runs only on your computer (nothing is uploaded) and works without internet after the one-time setup.

1. In the app, open your video, go to the **Cleanup** tab and press **Create transcript and find cuts**. A progress bar shows how far it is. When it finishes, the words appear in the Cleanup tab, the cuts it is sure about are applied, and Video Redline also uses the words in your export.
2. To keep a transcript as a file, drag your video onto `tools\transcribe-windows` (Mac: see `tools/README.md`). It writes `<video name>-transcript.json` next to the video. The page itself has no button that saves the transcript as a file.
3. If the helper cannot be found, the same card shows the steps in plain words and a **Check again** button. On Windows: double-click the **Video Redline** icon (no icon? double-click `setup-autostart-windows` in the `tools` folder once), then press **Check again**. On a Mac: start the helper again as in the Mac steps, then press **Check again**. If your browser asks whether the page may connect to other apps or devices on your computer, choose **Allow**. A VPN or firewall can also block it.

`tools/README.md` has more about the setup, and `tools/README-helper-security.md` says what the helper allows. With the automatic start the helper stays available while you are signed in; `tools/AUTOSTART.md` covers what that means.

**B. Bring your own transcript.** Press **I already have a transcript file** (or drop the file onto the page) and pick a transcript made elsewhere: the tool's own JSON, Whisper JSON, SRT or VTT. You can also make one from a video yourself: drag the video onto `tools\transcribe-windows` (on a Mac, see `tools/README.md`). Later, to open a different transcript, use **Open transcript file...** at the top of the panel.

### Review the cuts

1. **How much should I do on my own?** Once a transcript is loaded, this box is folded into one line, **Cleanup level: Balanced - change**. Click it, then choose **Careful**, **Balanced** (the default) or **Thorough**. Your accept and reject choices are kept when you change it.
2. Confident cuts are applied right away as **cut markers** (they appear on the timeline's cut track). Less certain ones wait under **Needs your decision**, each with a plain-language reason and a **Preview** button. Press **Accept** or **Reject** (keys: `J` next, `K` previous, `A` accept, `R` reject, `Z` undo your last decision, `Space` preview). The filter chips above the list narrow it to pauses, ums, repeats, false starts or sounds, and **Accept all** / **Reject all** act on the cards you are looking at (after asking you to confirm).
3. Select words in the transcript and press **Cut selection** to cut by hand. **Advanced**, in the same box under the level (click the **Cleanup level** line to open it), changes the finer settings.
4. Press **Skip cuts** above the timeline and play: the video jumps over every cut marker, so you hear it the way it will sound after editing.

Everything is worked out on your computer. Each video keeps its own transcript and decisions. Undo and Redo work on the cuts too: undoing a delete brings the cut back and keeps it, and redo puts back what you undid. If you undo an **Accept**, the cut goes away and its card goes back to **Needs your decision**. If you undo cuts that were applied on their own (or delete one by hand), they move to the **Rejected** list under the queue, where **Restore** brings each one back. A transcript loaded here also feeds the export: a visual that AI writes from your comment gets the words spoken during its marker.

### Teach it your ums

Sometimes the speech tools write "um" where there is really a sound effect (a whoosh, a pop, a bell), and because there is a sound there, the cleanup believes it. **Teach it your ums** (a fold in the Cleanup tab, under *Cut a time range*) lets the tool learn what *your* ums sound like, so it stops cutting the other sounds on its own. It needs the helper to be running, like **Create transcript and find cuts**.

1. **A recording of your ums.** Press **Choose a recording of your ums** and pick one long recording (an audio or video file) of you saying um, uh, er and hmm, with about a second of quiet between each, in a quiet room. Use the same microphone and room as your videos if you can: otherwise it may learn the room instead of the um. The helper finds each separate sound, keeps a short list of numbers that describes it (never the audio) and leaves out any that look nothing like the rest (a cough, a click).
2. **A recording of sounds that are not ums** (recommended). Press **Choose a recording of sounds that are not ums** and pick a recording of the sound effects, breaths, clicks and laughs that get mistaken for ums. With only ums to learn from, it can hold back sounds that look very different; with both, it learns where the line is and tells you how it did on sounds it had not seen.
3. **Your Accept and Reject choices teach it too.** An um you **Accept** counts as an um; a card you **Reject** counts as "not an um". (If you reject a real um only because you want to keep it, it learns the wrong thing: use Accept and Reject for what the sound *is*.) An automatic cut you remove counts as "not an um" only when you remove a few of them, not when you undo most of the automatic cuts at once.

It starts to work once it has at least 10 ums. From then on a sound that looks clearly unlike your ums is **never applied on its own**: it waits under **Needs your decision**, and its card says so ("It does not sound much like the ums you taught the tool"). It can only hold a cut back, never add one. When you teach it a new recording, the cuts of the open video are checked again (your Accept and Reject choices are kept). **Use what it learned when cleaning up** switches it off for a video, and **Forget** (for one recording, or everything) deletes what it learned. All of it stays in the `teach` folder inside `tools`: numbers only, never audio, and never uploaded. Each computer learns from its own recordings.

## Good to know

- **Saving is automatic.** Your markers are kept in this browser, matched by the video's file name and length. Open the same video again and they come back. If the browser cannot save (its storage is full or blocked), a message tells you once, and **File, Save session** is then the only copy. To make room, save a session file first, then delete this page's data in your browser's site settings (a transcript can take up to half a megabyte, and a browser keeps only about 5 MB for all pages opened from files). **File, Save session** also keeps a named copy in the `sessions` folder that came with Video Redline (in Chrome, Edge and other Chromium browsers: the first time, pick that folder; the browser remembers it, and after a restart it may ask once for your OK). The **File** menu then lists every saved session. Click one to open it: it opens its video too (the browser remembers each video you opened with **Open video** or by dropping it on the page; the first time, or after you moved the video, it asks you to pick the video, and after a restart it may ask once for your OK). Or use the small buttons at the side of its row to rename it, make a copy of it, or delete it (a deleted session is gone for good). Saving again updates the session you opened or saved last instead of making a new one. **Download session file** and **Load session from file** make a backup file or move your work to another computer, and are what Firefox and Safari use. A session holds your markers, including the cuts the Cleanup tab made, but not the transcript or your reject choices: on another computer, open the transcript file again. The cuts from the session stay as they are and the ones you accepted still count as accepted; the cards you rejected wait in the queue again. (Cleanup asks a question only when most of the session's cuts fit nothing in the transcript you open, for example because they were made from a different transcript.) Your visual library is kept in the browser too; the Visuals tab can save it to a file (`video-redline-library.json`) and load it back. Different browsers do not share saved work.
- **Undo and Redo** work with `Ctrl+Z` / `Ctrl+Shift+Z` on Windows and `⌘Z` / `⌘⇧Z` on a Mac.
- Typing in a comment, time, search or style box never triggers shortcuts, so you can type spaces and the letter M freely. Press **Esc** to leave the box (Esc in a time box cancels the edit).
- The **Delete** (or **Backspace**) key removes the box you last clicked, or else the selected marker. You can also right-click a marker on the timeline and choose **Delete marker**, or use the Delete button on its card. **Undo** brings a deleted marker back.
- Times are in seconds from the start of the video and snap to whole frames. Box numbers are in the video's own pixels, from the top-left corner, even if the video is shown smaller on screen.

## Developing or publishing Video Redline?

See `DEVELOPERS.md` in the repository on GitHub (it is not part of the ZIP) and `tools/DEVELOPERS.md` for the Windows start-up files.

## Credits and licence notes

The built-in styles are derived from the design systems published by [Open Design](https://github.com/nexu-io/open-design) (Apache-2.0). Only compact design tokens (colours, fonts, corner radius, shadow) and short descriptions are included; see `src/vendor/NOTICE-open-design.txt`. Brand names belong to their owners and the values are approximations: the styles are rough look-alikes, not official and not affiliated with them. Credits for everything else, including the speech tools and models the optional helper downloads, are in `THIRD-PARTY-NOTICES.md`.
