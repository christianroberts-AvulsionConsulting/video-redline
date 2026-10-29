# Video Redline helper: what it allows and what it cannot do

The helper is a small program that runs only on your own computer. The Video Redline page uses it to make a transcript. Nothing is sent over the internet.

**What it allows**
- Only this computer can reach it. Other computers on your network cannot.
- Any page opened from a file on this computer (the browser calls such a page "null", and Safari may call it "file://"), and any program running here, can ask it to make a transcript. Ordinary websites are refused.
- There is no password or code to type. That keeps it easy to use, but a hostile web page could also try to use it.

**What it cannot do**
- It cannot read your other files, start other programs or change settings. It only works on the video it is given.
- A page cannot collect a transcript that another page started.
- It limits the damage: it stops a job when your drive is filling up, when nobody has checked on the job for 10 minutes (the page was closed), or when a job runs longer than 3 hours.

**What to do**
- Close the helper window when you are not using it. A helper that the Video Redline icon starts, or that starts by itself (the optional automatic start on Windows: see AUTOSTART.md; setup-autostart-windows.bat adds the icon and turns it on) runs hidden and has no window to close: double-click stop-helper-windows.bat to stop it for now (the icon starts it again), or remove-autostart-windows.bat to turn the automatic start off for good.
- Keep the tools folder out of OneDrive, Dropbox, iCloud and Google Drive, and on a Mac out of Desktop and Documents when iCloud Drive keeps them. The video is kept in the folder while it is processed, and those programs would upload a copy. A plain folder inside your own user folder, such as `C:\Users\<your name>\VideoRedline` (Windows, with your own user name: that is `%USERPROFILE%\VideoRedline`) or ~/VideoRedline (Mac), is safe (not directly on the C drive of Windows: other accounts of the PC can change files there, and the automatic start warns about it).
- What is checked, and when (only the folder name is looked at): at setup, before anything is downloaded, for OneDrive, Dropbox, iCloud, Google Drive and "My Drive" in the path, and on a Mac for Desktop or Documents with iCloud Drive on; setup then asks whether to stop (the default) or go on. Each time the helper starts, the same, plus network drives; it prints a WARNING (and tells the page yes or no, never the folder name) but still starts. A cloud folder under another name is not noticed.
