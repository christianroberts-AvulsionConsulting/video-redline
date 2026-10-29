# Video Redline: notes for developers

This page is for people who build or publish Video Redline. If you only want to use it, read `README.md`.

## How the page is built

`video-redline.html` is generated. The readable sources are in `src/`:

```
src/shell.html      page structure
src/styles.css      the look
src/js/             the app, in the order it is joined
src/vendor/         visuals.js (visual templates), od-parse.js (Open Design reader),
                    od-styles.json (the bundled styles), cleanup.js, transcriber-client.js and
                    cleanup-panel.js (audio cleanup), icons.html, NOTICE-open-design.txt
build.js            joins everything into video-redline.html
make-release-zip.py makes the download ZIP (see Publishing below); it is not part of the ZIP
tools/              the optional transcription helper (Python sources, set-up and start scripts,
                    and the Windows auto-start files: helper_launcher.pyw (starts the helper),
                    open_video_review.pyw (what the Video Redline icon runs: it starts the helper if
                    needed, then opens video-redline.html), add-desktop-icon-windows.bat (makes the icon and
                    its picture video-redline.ico), setup-autostart-windows.bat, stop-helper-windows.bat,
                    remove-autostart-windows.bat, AUTOSTART.md, DEVELOPERS.md);
                    the page never needs it to run, and it is not part of video-redline.html
```

After editing, run `node build.js` (needs [Node.js](https://nodejs.org/)) to rebuild `video-redline.html`. Users never need to do this.

Some names keep their old spelling on purpose, because other things point at them: `open_video_review.pyw` (icons made before the product was renamed run it), the helper's `/status` identity `video-review-helper`, the storage keys `vrt:*`, the session and export format ids, the export file name endings `-review.md` and `-review.json`, the registry names `VideoReviewHelper` and `videoreview://`, the environment variables `VRT_*`, and the file names of the modules in `src/vendor/`. The opener also opens `video-review.html` when `video-redline.html` is missing (an install made before the rename).

## Publishing

The `.command` files in `tools/` lose their executable bit in a ZIP download, which is why the Mac steps in the README use `bash`. If you publish, run `git update-index --chmod=+x tools/*.command` once.

### Publishing checklist (for the maintainer)

To change the version number: edit `VERSION`, the line `Version ...` near the top of `README.md` and of `tools/README.md`, and the test in `tools/tests/test_folders_and_origins.py` that pins the second one; then run `node build.js` (the number is stamped into the footer of the page).

Build the release ZIP from the repository, never from a folder on which the set-up has been run. A set-up folder holds FFmpeg with the GPL programs x264 and x265, files from Intel and NVIDIA, and about 1.3 GB of speech models that need credit (see `THIRD-PARTY-NOTICES.md`, sections 2 and 3). The script `make-release-zip.py` does it: `python make-release-zip.py` writes `dist/video-redline-<VERSION>.zip` (the page, `tools`, `README.md`, `LICENSE`, `THIRD-PARTY-NOTICES.md` and the Open Design notice, no folder around them), puts the right line endings and the executable mark on the Mac scripts, and refuses to finish when a rule below is broken. `python make-release-zip.py --check <zip>` checks a ZIP that you downloaded.

Before you announce a release, run `node build.js --check` (it says whether `video-redline.html` is up to date with `src/`; `make-release-zip.py` runs it for you when Node is installed), then open the ZIP and check (the script already does the first four):

- there is no folder called `venv`, `python`, `uv`, `uv-cache` or `hf-cache`, and no `.onnx`, `.bin` or `.dll` file;
- `LICENSE`, `THIRD-PARTY-NOTICES.md` and `src/vendor/NOTICE-open-design.txt` are inside;
- the ZIP is only a few megabytes;
- the `.bat` files still have Windows line endings (`tools/.gitattributes` asks for it).

Things worth knowing:

- The speech models are fetched at set-up from the newest version of each model page. The licences in `THIRD-PARTY-NOTICES.md` are for the revisions listed there; read the model pages again before a wide public release.
- The 152 style presets carry real brand names as labels for rough look-alikes (the **Styles** tab says so). The button text "Export for Claude" and the preset "Claude (Anthropic)" use Anthropic's name in the same way.
- The name "Video Redline" has had a web search only, not a trademark search. Do one before a wide public launch.
- Not read one by one: the small libraries inside the `av` package, the Intel and NVIDIA files inside the `ctranslate2` package, and the licences of the training data behind the models.
- PyAV's FFmpeg reports itself as "LGPL version 3 or later" and was built without the `--enable-gpl` switch, yet x264 and x265 are inside and working. The PyAV build recipe (https://github.com/PyAV-Org/pyav-ffmpeg) moves them from FFmpeg's "GPL" list to its "version 3" list. The PyAV project gives no statement that justifies the licence of the result. This is another reason never to hand out a set-up folder.

### Optional, later: open it from a web address

Do not do this while the repository is private and the beta is for invited people only: a Pages site can be opened by anyone who has its address, and it would serve the whole branch (the page, the scripts, the tests and these notes). After a public launch, if you would rather open it from a link than from a file, turn on GitHub Pages for the repository (Settings, then Pages, then deploy from the `main` branch). The page will be at `https://<your-name>.github.io/<repository-name>/video-redline.html`. The video is still read on the viewer's own computer and never uploaded. The one-click **Create transcript** button does not work from a web address (the helper only answers pages opened from a file on the computer or from `localhost`); use **I already have a transcript file** there.

## The Windows start-up files

See `tools/DEVELOPERS.md`.
