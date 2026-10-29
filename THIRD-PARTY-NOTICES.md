# Third-party notices

**Video Redline** is released under the MIT licence (see `LICENSE`). That licence covers Video Redline's own code only. This page lists the work of other people that is **in the download**, and the work that the **optional speech helper downloads onto your own computer** when you run its set-up. For each item it says what it is, where it comes from, which licence it has, and what credit is required.

Checked on 28 October 2026 against the files in this project, the licence records inside the installed packages and the publishers' own pages. This is a plain-language summary, not legal advice. Where a licence matters for a decision, read the licence itself (links are given).

## The short version

- **In the download** there are only two pieces of other people's work: the 152 look-and-feel presets from **Open Design** (Apache-2.0) and one short function, shortened and changed, from **onnx-asr** (MIT). Credits for both are in section 1.
- **Everything else is not in the download.** If you choose to run the helper's set-up, your computer fetches it from github.com, pypi.org and huggingface.co (about 1.3 GB). Section 2 lists all of it.
- **The speech models** may all be used commercially. The two Parakeet models need credit (CC BY 4.0); the Whisper and Silero models are MIT. Credit lines are in section 2.4.
- **Nothing in the download is under GPL, LGPL or non-commercial terms.** One thing the set-up fetches from PyPI, a copy of FFmpeg packed inside the `av` package, contains GPL-licensed parts. It stays on your own computer and Video Redline never uses it. Section 3 explains.
- The MIT licence of Video Redline is compatible with all of the above (section 4).

---

## 1. Included in the download

### 1.1 Open Design style presets

| | |
|---|---|
| What | 152 visual style presets (colours, fonts, corner radius, shadow, a short description). They fill the **Styles** tab and the style details in the export. File in the source repository: `src/vendor/od-styles.json` (in the ZIP download the presets are built into `video-redline.html`). |
| From | **Open Design**, folder `design-systems/` of https://github.com/nexu-io/open-design . Copyright 2026 Open Design contributors. |
| Licence | **Apache License, Version 2.0**: https://www.apache.org/licenses/LICENSE-2.0 |
| Changed? | **Yes.** The presets are condensed and re-expressed, not copied word for word (shortened text, colours converted to hex, font lists shortened, a few values corrected). `src/vendor/NOTICE-open-design.txt`, section 3, lists exactly what was changed. Apache-2.0 requires saying so. |
| Where the credit and licence text are | `src/vendor/NOTICE-open-design.txt` (it contains the full Apache-2.0 text). The same text is also stored inside `video-redline.html` (in the hidden block `od-notice`), so it travels with the single file. The Open Design repository has no NOTICE file of its own, so there is nothing more to pass on. |
| Not an official Open Design file | Open Design has not reviewed or endorsed these presets. |

**Material that Open Design itself took from other projects (all MIT).** Open Design says some of its packages come from these projects. Their copyright lines are kept in `src/vendor/NOTICE-open-design.txt`, because some of that material is carried into the presets:

| Project | Copyright line |
|---|---|
| VoltAgent/awesome-design-md | Copyright (c) 2026 VoltAgent |
| bergside/awesome-design-skills | Copyright (c) 2026 Bergside |
| tw93/kami | Copyright (c) 2026 Tw93 |
| Tom-Opencart/tom-modern-html-style-rule | Copyright (c) 2026 Tom-Opencart |
| cloudflare/kumo | Copyright (c) 2026 Cloudflare, Inc. |

**Brand names.** Many preset names are company or product names (for example Airbnb, Apple, Stripe, Nike, BMW, Spotify). Those names belong to their owners. The presets are rough look-alikes of publicly visible design, rebuilt from Open Design's own reading of it. No logos, trademarks, typefaces or images are included, and no affiliation or endorsement is implied. Open Design says the same about its own brand-referencing packages.

### 1.2 One function adapted (shortened and changed) from onnx-asr

| | |
|---|---|
| What | In `tools/vrt_engines.py`, the function `_tdt_decoding_with_durations` (about 25 lines) is a shortened and modified copy of a decoding loop from onnx-asr. The change that matters: it keeps each word piece's predicted length, which the original throws away and which is needed for exact word end times. It is also shortened: the original's type annotations, its assertions and its clamp of the encoder lengths for TensorRT low-precision models (never used here) are left out, one option (`strict=True` on a `zip`) is dropped and two variables have other names. |
| Where the notice is | Above the function in `tools/vrt_engines.py`: it says that the code is modified, lists the main changes and carries the copyright line and permission text. |
| From | **onnx-asr**, https://github.com/istupakov/onnx-asr |
| Licence | **MIT**, Copyright (c) 2025 Ilya Stupakov |
| What MIT asks | The copyright line and the permission text must stay with copies and substantial parts. They are reproduced in full in the **Appendix** at the end of this file. |

### 1.3 What is not included

The Video Redline page loads nothing from the internet (it only talks to the helper on your own computer) and contains no third-party fonts, icon packs, images, scripts or libraries. One credit for published knowledge: the colour conversion in `src/vendor/od-parse.js` uses the OKLab formulas and constants published by Björn Ottosson (https://bottosson.github.io/posts/oklab/; the same constants are in the CSS Color Module Level 4), to turn the presets' colours into hex. The helper's web server (`tools/vrt_server.py`) uses only what ships with Python. The download holds no audio, video, image or font files at all.

---

## 2. Downloaded onto your computer by the optional set-up

This only happens if you run `tools/setup-windows.bat` or `tools/setup-mac.command`. Video Redline itself works without any of it. Everything below goes into the `tools` folder on your computer. **None of it is in the download**, and Video Redline does not change any of it.

### 2.1 Set-up tools

| Item | What it is | Where from | Licence | Notes |
|---|---|---|---|---|
| **uv 0.13.6** | A small installer program that fetches Python and the packages | github.com/astral-sh/uv (release file checked against its published SHA-256 before use) | **Apache-2.0 or MIT**, your choice | Stays in `tools/uv/` so that set-up can be run again to repair the folder. |
| **Python 3.12.16** | A private copy of Python, used only by the helper | github.com/astral-sh/python-build-standalone (fetched by uv) | **Python Software Foundation licence** for Python itself. The build also contains standard open-source parts (for example OpenSSL, SQLite, Tcl/Tk, zlib), each with its own permissive licence file kept in the python-build-standalone project. The project's own build scripts are MPL-2.0. | Not your system Python; nothing outside the folder is changed. |
| **Microsoft Visual C++ Redistributable 2015-2022** (Windows only) | A free Microsoft component that the speech engines need | Microsoft (you download and install it yourself if set-up says it is missing) | Microsoft's own licence terms, which you accept when you install it | Not downloaded or passed on by this project. |

### 2.2 Python packages (exactly the versions in `tools/requirements.txt`)

All come from pypi.org. Licences below are as stated inside the installed packages (Windows, read 27 October 2026). A Mac gets the same packages; an Intel Mac gets ONNX Runtime 1.23.2 instead of 1.31.1 (same project, also MIT). The review of these packages, and of what is packed inside them (2.3), was made on a Windows installation: the Mac builds have not been looked at one by one.

| Package | Version | What it does here | Licence |
|---|---|---|---|
| onnx-asr | 0.12.0 | Runs the Parakeet model | MIT, Copyright (c) 2025 Ilya Stupakov |
| faster-whisper | 1.2.1 | Runs the Whisper model | MIT, Copyright (c) 2023 SYSTRAN |
| ctranslate2 | 4.8.4 | Engine under faster-whisper | MIT (OpenNMT). See 2.3 for what its Windows package carries |
| onnxruntime | 1.31.1 | Engine under Parakeet and the voice detector | MIT, Copyright (c) Microsoft Corporation. The package carries its own `ThirdPartyNotices.txt` |
| av (PyAV) | 19.0.2 | Opens video and audio files and reads the sound | BSD-3-Clause. **Contains FFmpeg, see 2.3** |
| numpy | 2.5.4 | Sound measurements | BSD-3-Clause, with MIT, 0BSD, Zlib and CC0 parts; the package carries OpenBLAS (BSD) and the GCC runtime library (GPL-3 with the GCC runtime exception, which allows use in any program) |
| huggingface-hub | 2.3.0 | Downloads the models | Apache-2.0 |
| tokenizers | 0.23.3 | Text pieces for Whisper | Apache-2.0 |
| hf-xet | 1.7.0 | Faster model download | Apache-2.0 |
| protobuf | 7.36.2 | Reads ONNX files | BSD-3-Clause |
| flatbuffers | 25.12.19 | Reads ONNX Runtime files | Apache-2.0 |
| packaging | 26.3 | Version checks | Apache-2.0 or BSD-2-Clause |
| tqdm | 4.70.1 | Progress bars | MPL-2.0 and MIT |
| fsspec | 2026.9.0 | File access helper | BSD-3-Clause |
| filelock | 4.2.4 | File locks | MIT |
| pyyaml | 6.0.3 | Reads model info files | MIT |
| typing-extensions | 4.16.0 | Python helper | PSF-2.0 |
| anyio | 4.15.1 | Networking helper | MIT |
| httpx2 | 2.16.0 | Web client used for downloads | BSD-3-Clause |
| httpcore2 | 2.16.0 | Under httpx2 | BSD-3-Clause |
| h11 | 0.16.0 | Under httpcore2 | MIT |
| idna | 3.20 | Web address helper | BSD-3-Clause |
| click | 8.5.0 | Command-line helper | BSD-3-Clause |
| colorama | 0.4.6 | Colours in the Windows console | BSD-3-Clause |
| truststore | 0.10.5 | Uses the system's trusted certificates | MIT |

The MPL-2.0 part of tqdm only asks anything of someone who changes and passes on tqdm's own files. Nobody does that here.

### 2.3 Programs packed inside some of those packages

Some packages carry other people's programs inside them. They arrive with the package from pypi.org and are put there by the package's maintainers, not by this project.

| Inside | Carried by | What it is | Licence | Used by Video Redline? |
|---|---|---|---|---|
| **FFmpeg 9.0.2** (the `avcodec`, `avformat`, `avutil`, `swresample` ... files) | `av` (PyAV) | The standard tool for reading audio and video files | **LGPL 3 or later** for FFmpeg itself (this PyAV build reports "LGPL version 3 or later" and is configured with `--enable-version3`). Some optional parts of FFmpeg are GPL (https://ffmpeg.org/legal.html) | **Yes**, to open your video and read its first sound track. No video is decoded or encoded. |
| **x264** and **x265** (`libx264`, `libx265` files) | `av` | Video encoders for H.264 and H.265 | **GPL**. x264 is also sold under a separate commercial licence; x265 is GPL version 2 and also sold commercially | **No.** Present in the package, never called. See section 3. |
| LAME (MP3), libiconv, dav1d, libvpx, Opus, WebP, SVT-AV1, VMAF, oneVPL, zlib and the MinGW runtime libraries | `av` | Smaller libraries used by FFmpeg | A mix of permissive licences and a few LGPL ones. | Only as part of FFmpeg |
| Intel OpenMP runtime (`libiomp5md.dll`), and, according to the CTranslate2 build script, Intel's oneAPI maths library | `ctranslate2` (Windows) | Maths speed-up | Intel's own licences. | Yes, in the CPU speech engine |
| NVIDIA cuDNN library file (`cudnn64_9.dll`) | `ctranslate2` (Windows) | Graphics-card support | NVIDIA's cuDNN licence. | **No.** The helper runs on the CPU only. |

The installed `ctranslate2` package does not include licence texts for the Intel and NVIDIA files.

### 2.4 Speech models

All come from huggingface.co and are stored in `tools/hf-cache/`. The set-up downloads the first three by default. The others are only downloaded if you ask for them (`transcribe.py --download-models --whisper ...` or `--parakeet v3`). Revision numbers are the versions checked on 28 October 2026.

| Model | Made by | Downloaded as | Licence | By default? |
|---|---|---|---|---|
| **Parakeet TDT 0.6B v2** (English) | NVIDIA | ONNX version by istupakov, `istupakov/parakeet-tdt-0.6b-v2-onnx`, revision `0bbb45a3`, about 660 MB | **CC BY 4.0** (NVIDIA's model and istupakov's version both say so) | Yes |
| **Silero VAD 6.2** (finds where speech is) | Silero Team | ONNX version by istupakov, `istupakov/silero-vad-onnx`, revision `b3e3ee3c`, 2 MB | **MIT**, Copyright (c) 2020-present Silero Team | Yes |
| **Whisper small.en** (English) | OpenAI | CTranslate2 version by SYSTRAN, `Systran/faster-whisper-small.en`, revision `d1d751a5`, about 486 MB | **MIT** (see the Whisper note below) | Yes |
| Parakeet TDT 0.6B v3 (25 European languages) | NVIDIA | `istupakov/parakeet-tdt-0.6b-v3-onnx`, revision `8f23f0c0`, about 670 MB | **CC BY 4.0** | Only with `--parakeet v3` |
| Other Whisper sizes: tiny, base, small, medium (each also as .en), large-v1, large-v2, large-v3 | OpenAI | `Systran/faster-whisper-...` | **MIT** (checked on every repository's page) | Only if you ask |
| Whisper large-v3-turbo | OpenAI (converted by Mobius Labs) | `faster-whisper-large-v3-turbo` (the old address `mobiuslabsgmbh/...` now forwards to `dropbox-dash/faster-whisper-large-v3-turbo`) | **MIT** | Only if you ask |
| distil-large-v3 | The Distil-Whisper project (Hugging Face) | `Systran/faster-distil-whisper-large-v3` | **MIT** | Only if you ask |

**Whisper note.** OpenAI's own GitHub project says its code and model files are MIT, Copyright (c) 2022 OpenAI. The Hugging Face page of the original model (`openai/whisper-small.en`) lists Apache-2.0 instead. Both are permissive and allow what this tool does. SYSTRAN's converted copies say MIT.

**CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/) allows any use, including commercial use. NVIDIA's own model page says the model is "ready for commercial/non-commercial use". The condition is credit: whoever passes the models on has to name the creator, link to the licence, say that the files were changed, and not remove earlier change notes. Video Redline does not pass the models on (each computer fetches them directly from Hugging Face), but they are credited here anyway.

None of the licences above claims any rights over the transcripts you make with these models.

#### Credit lines (copy as they are)

> **Parakeet TDT 0.6B** (v2, and the optional v3) by **NVIDIA**, licensed under **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/). Sources: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2 and https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3 . The model pages give no separate copyright line, so NVIDIA is named as the creator. Converted to ONNX format (including the smaller 8-bit "int8" files this tool uses) and published by **Ilya Stupakov (istupakov)**, also under CC BY 4.0: https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx and https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx . Video Redline runs these files as published and does not change them. The models are provided "as is", without any warranty (see section 5 of the licence).

> **Whisper** by **OpenAI**, MIT licence, Copyright (c) 2022 OpenAI (https://github.com/openai/whisper). Converted for faster-whisper by **SYSTRAN** (MIT, https://github.com/SYSTRAN/faster-whisper); the optional large-v3-turbo model was converted by **Mobius Labs** (https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo).

> **Silero VAD**, MIT licence, Copyright (c) 2020-present Silero Team (https://github.com/snakers4/silero-vad), in the ONNX version published by istupakov (https://huggingface.co/istupakov/silero-vad-onnx).

> **onnx-asr** by Ilya Stupakov, MIT licence (https://github.com/istupakov/onnx-asr).

---

## 3. About the programs inside the `av` package

The helper uses PyAV (the `av` package) to open a video and read its sound. PyAV's own code is BSD-licensed. The copy on PyPI has a complete FFmpeg packed inside it, which also contains the video encoders **x264** and **x265**. Those two are **GPL** programs. FFmpeg itself is LGPL (https://ffmpeg.org/legal.html).

- **They are not in this download.** Each person's computer fetches the `av` package from PyPI when that person runs the set-up. PyAV's maintainers are the ones passing it on.
- **Video Redline never makes video.** It opens your recording and reads the first sound track. x264 and x265 are present in the package but never called.
- **Please do not hand out a folder on which the set-up has already been run.** That folder holds FFmpeg, x264, x265, files from Intel and NVIDIA, and about 1.3 GB of speech models that need credit. Hand out the download instead, and let each computer fetch its own copy.
- Video formats such as H.264, H.265 and AAC are covered by patents in some countries. Video Redline only reads recordings you already have, on your own computer.

---

## 4. Is the MIT licence compatible with all of this?

Yes.

- MIT is a permissive licence. It lets other people use, copy, change and pass on Video Redline's code if they keep the copyright line and licence text.
- **Open Design presets (Apache-2.0)** may be included in an MIT project. They stay under Apache-2.0, which is why `LICENSE` says it covers Video Redline's code only. The notice file keeps the Apache-2.0 text and the change statement together with them.
- **The adapted onnx-asr function (MIT)** is the same licence family. It only needs its copyright line kept, which the Appendix does.
- **Nothing GPL or non-commercial is copied into the project.** The GPL parts (x264, x265, inside the `av` package) are never copied or linked into Video Redline's code in what is handed out; they only appear on a person's own computer when that person's set-up downloads them.
- **The downloaded packages and models** are separate programs and data under their own licences. They are not combined with Video Redline into one handed-out work, so their licences do not reach back into Video Redline's code, and the MIT licence does not conflict with them.

This is a plain-language summary, not legal advice.

---

## Appendix: MIT licence text for the onnx-asr function (section 1.2)

```
MIT License

Copyright (c) 2025 Ilya Stupakov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The full Apache-2.0 text for the Open Design presets is in `src/vendor/NOTICE-open-design.txt`.
