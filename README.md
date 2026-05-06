# Local Video Shelf

The simplest “just works” web server to watch the videos on your PC from:

- Safari on iPhone/iPad
- Safari/Chrome/Firefox on other devices in your Wi‑Fi/LAN

It’s a single `app.py` (no pip dependencies) plus a tiny web UI.

## Quick start

1) Put your videos in a folder (example: `./videos`).
2) Run the server:

```bash
python3 app.py --host 0.0.0.0 --port 1337 --media-dir ./videos
```

3) Open the UI:

- On the same computer: `http://localhost:1337`
- On your phone/tablet/another PC: `http://<your-computer-lan-ip>:1337`

The server prints a usable LAN IP when it starts.

## Command-line options (explained)

```bash
python3 app.py --host 0.0.0.0 --port 1337 --media-dir ./videos
```

- `python3 app.py`: starts the server.
- `--host 0.0.0.0`: bind to *all* network interfaces (needed to access from other devices).
  - Use `--host 127.0.0.1` if you want “this computer only”.
- `--port 1337`: TCP port to listen on.
  - Change it if `1337` is busy: `--port 8000`
- `--media-dir ./videos`: the folder that contains your videos.
  - Default: current directory.

Stop the server with `Ctrl+C`.

## What files show up in the library

The main page (`/` or `/index.html`) shows **prepared** videos from the *top level* of `--media-dir`.

The library is split into two tabs:

- **New**: videos this device has not started yet.
- **Watched**: videos this device has played for at least 10 seconds, or finished.

Videos with the same first word in their title are grouped into a virtual folder on the same page. For example:

- `Italy: day 1.mp4`
- `Italy: day 2.mp4`

will appear in a folder named `Italy` in the web interface.

“Prepared” means:

- The file is `.mp4`, `.m4v`, or `.mov`, and
- You clicked **Prepare for streaming** in `/admin.html` (this creates a cached copy in `./.cache/ready/`)

If you don’t see a video:

- Convert it to MP4 in `/admin.html` (if it’s MKV/AVI/WMV/etc.)
- Then prepare the resulting MP4/MOV in `/admin.html`

## Admin panel (Convert + Prepare)

Open:

- `http://<your-computer-lan-ip>:1337/admin.html`

The admin page has two actions:

- **Convert to MP4** (for non‑MP4/MOV files like MKV/AVI/WMV)
- **Prepare for streaming** (for MP4/MOV): creates a cached “fast start” copy so playback can begin sooner

### Requirements

- `ffmpeg` must be installed and on your `PATH` (it usually includes `ffprobe` too).

### What it does

- Finds videos in your media folder (this page scans **recursively**, including subfolders).
- For each non‑MP4/MOV file, you can click **Convert to MP4**.
- The server runs `ffmpeg` in the background and writes a new file next to the original:
  - `Some.Video.mkv` → `Some.Video.mp4`
- The original file is kept (nothing is deleted).
- For MP4/MOV files, **Prepare for streaming** creates a cached copy in `./.cache/ready/` (your originals are not modified).
- Both jobs write progress to `./.cache/processing.json`:
  - `convert_pct` and `ready_pct` track percent
  - `convert_status` / `ready_status` track state (`idle`, `converting`/`preparing`, `done`, `error`)

### Conversion settings (the “algorithm”)

When you click **Convert**:

- The server picks the “best” streams (when `ffprobe` is available):
  - Prefer streams marked as *default*
  - Otherwise choose the longest-duration stream
- It re-encodes to a Safari-friendly baseline:
  - Video: H.264 (`libx264`), `yuv420p`
  - Audio: AAC (stereo / AAC-LC)
  - Adds “fast start” metadata (`-movflags +faststart`) so Safari can start sooner
- Progress:
  - `ffprobe` is used to get total duration
  - `ffmpeg -progress pipe:1` is parsed, and the admin UI polls `/api/admin/convert-status`

After conversion, the main library will treat the video as “ready” (because an `.mp4` copy exists) and play the MP4 automatically.

## Notes

- Video playback is direct HTTP streaming (`/media/...`) with HTTP Range requests (seeking/buffering is handled by the browser).
- The server remembers playback position **per device** and **video** (stored in `./.cache/positions.json`) so you can resume where you left off.
- The watched/new split is also per device (stored in `./.cache/watched.json`).

## Install notes (macOS / Linux / Windows)

### macOS

- Python: already installed on most macs; otherwise install Python 3 from python.org.
- FFmpeg (for conversions + prepare):
  - Homebrew: `brew install ffmpeg`

### Linux

- Python: `python3 --version`
- FFmpeg:
  - Debian/Ubuntu: `sudo apt install ffmpeg`
  - Fedora: `sudo dnf install ffmpeg`
  - Arch: `sudo pacman -S ffmpeg`

### Windows

- Run:
  - `py -3 app.py --host 0.0.0.0 --port 1337 --media-dir "C:\\path\\to\\videos"`
- Allow the app through Windows Firewall if prompted (so your phone can connect).
- If another device still cannot open the page, run Terminal/PowerShell as Administrator:
  - `netsh advfirewall firewall add rule name="Local Video Shelf 1337" dir=in action=allow protocol=TCP localport=1337`
- Make sure the current Windows network profile is **Private**, not **Public**.
- FFmpeg (for conversions + prepare):
  - Chocolatey: `choco install ffmpeg`
  - Or download a static build and add its `bin` folder (with `ffmpeg.exe` and `ffprobe.exe`) to your `PATH`.

## Troubleshooting

- Phone can’t open the page:
  - Make sure you started with `--host 0.0.0.0`
  - Make sure both devices are on the same Wi‑Fi/LAN
  - Check firewall rules on your computer
  - On Windows, confirm the server is listening externally:
    - `netstat -ano | findstr :1337`
    - It should show `0.0.0.0:1337` in `LISTENING`, not only `127.0.0.1:1337`
- Safari shows a black screen / won’t play:
  - Convert to MP4 in `/admin.html` (H.264 + AAC is the most reliable)
- “Convert to MP4” button is disabled:
  - Install `ffmpeg`, then reload the admin page

## Security note

This server has **no authentication**. Treat it as a LAN-only tool and don’t expose it directly to the internet.
