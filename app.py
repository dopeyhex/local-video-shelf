#!/usr/bin/env python3
import argparse
import hashlib
import ipaddress
import json
import os
import posixpath
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

# Windows subprocess flags to prevent console windows
SUBPROCESS_FLAGS = {}
if sys.platform == "win32":
    SUBPROCESS_FLAGS = {"creationflags": subprocess.CREATE_NO_WINDOW}

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
CACHE_DIR = os.path.join(BASE_DIR, ".cache")
READY_DIR = os.path.join(CACHE_DIR, "ready")
THUMB_DIR = os.path.join(CACHE_DIR, "thumbs")
PROCESS_LOG_PATH = os.path.join(CACHE_DIR, "processing.json")
POSITIONS_PATH = os.path.join(CACHE_DIR, "positions.json")
WATCHED_PATH = os.path.join(CACHE_DIR, "watched.json")
FFMPEG_PATH = shutil.which("ffmpeg")
FFPROBE_PATH = shutil.which("ffprobe")
MEDIA_EXTENSIONS = {
    ".mp4",
    ".m4v",
    ".mov",
    ".mkv",
    ".webm",
    ".avi",
    ".mpg",
    ".mpeg",
    ".wmv",
    ".m2ts",
}

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".avi": "video/x-msvideo",
    ".mpg": "video/mpeg",
    ".mpeg": "video/mpeg",
    ".wmv": "video/x-ms-wmv",
    ".m2ts": "video/MP2T",
}

MEDIA_DIR = None
CHUNK_SIZE = 1024 * 1024  # 1MB
DIRECT_PLAYABLE_EXTENSIONS = {".mp4", ".m4v", ".mov"}
STREAM_READY_EXTENSIONS = {".mp4", ".m4v", ".mov"}
JOBS = set()
JOBS_LOCK = threading.Lock()
POSITIONS_LOCK = threading.Lock()
WATCHED_LOCK = threading.Lock()
WATCHED_THRESHOLD_SECONDS = 10

# Browser/Windows-friendly audio settings.
# Some players on Windows can fail to decode multichannel AAC (or HE-AAC profiles),
# which may appear as "no sound" after conversion.
TARGET_AUDIO_CODEC = "aac"
TARGET_AUDIO_PROFILE = "aac_low"  # AAC-LC
TARGET_AUDIO_BITRATE = "160k"
TARGET_AUDIO_CHANNELS = "2"
TARGET_AUDIO_SAMPLE_RATE = "48000"


def get_primary_ipv4():
    ip = None
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            ip = sock.getsockname()[0]
    except OSError:
        ip = None
    if not ip or ip.startswith("127."):
        try:
            ip = socket.gethostbyname(socket.gethostname())
        except OSError:
            ip = None
    if ip and ip.startswith("127."):
        return None
    return ip


def _add_ipv4_candidate(candidates, ip, priority):
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return
    if address.version != 4:
        return
    if address.is_loopback or address.is_link_local or address.is_multicast:
        return
    existing_priority = candidates.get(ip)
    if existing_priority is None or priority < existing_priority:
        candidates[ip] = priority


def _run_text_command(args, timeout=2):
    try:
        result = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            errors="ignore",
            timeout=timeout,
            **SUBPROCESS_FLAGS,
        )
    except (OSError, subprocess.SubprocessError, subprocess.TimeoutExpired):
        return ""
    return result.stdout or ""


def _interface_priority(name):
    lowered = (name or "").strip().lower()
    if not lowered:
        return 5
    if any(
        token in lowered
        for token in (
            "wi-fi",
            "wifi",
            "wireless",
            "wlan",
            "ethernet",
            "local area",
            "lan",
            "en",
            "eth",
            "беспровод",
            "локальн",
        )
    ):
        return 0
    if any(
        token in lowered
        for token in (
            "vpn",
            "tun",
            "tap",
            "ppp",
            "virtual",
            "vmware",
            "hyper-v",
            "loopback",
            "bluetooth",
            "bridge",
            "docker",
            "tailscale",
            "zerotier",
        )
    ):
        return 10
    return 5


def _parse_ifconfig_ipv4(stdout, candidates):
    current_interface = ""
    for raw_line in stdout.splitlines():
        if raw_line and not raw_line[0].isspace() and ":" in raw_line:
            current_interface = raw_line.split(":", 1)[0]
            continue
        line = raw_line.strip()
        if not line.startswith("inet "):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        _add_ipv4_candidate(
            candidates, parts[1], _interface_priority(current_interface)
        )


def _parse_ip_addr_ipv4(stdout, candidates):
    current_interface = ""
    for raw_line in stdout.splitlines():
        if re.match(r"^\d+:\s", raw_line):
            parts = raw_line.split(":", 2)
            current_interface = parts[1].strip() if len(parts) > 1 else ""
            continue
        line = raw_line.strip()
        if not line.startswith("inet "):
            continue
        address = line.split()[1].split("/", 1)[0]
        _add_ipv4_candidate(candidates, address, _interface_priority(current_interface))


def _parse_windows_ipconfig_ipv4(stdout, candidates):
    current_interface = ""
    for raw_line in stdout.splitlines():
        stripped = raw_line.strip()
        if raw_line and not raw_line[0].isspace() and stripped.endswith(":"):
            current_interface = stripped[:-1]
            continue
        if "ipv4" not in stripped.lower():
            continue
        match = re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", stripped)
        if not match:
            continue
        _add_ipv4_candidate(
            candidates, match.group(0), _interface_priority(current_interface)
        )


def _ipv4_sort_key(ip, priority):
    parts = tuple(int(part) for part in ip.split("."))
    if parts[0] == 192 and parts[1] == 168:
        family_rank = 0
    elif parts[0] == 172 and 16 <= parts[1] <= 31:
        family_rank = 1
    elif parts[0] == 10:
        family_rank = 2
    else:
        family_rank = 3
    return (priority, family_rank, parts)


def get_local_ipv4_addresses():
    candidates = {}
    _add_ipv4_candidate(candidates, get_primary_ipv4(), 20)

    try:
        for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            _add_ipv4_candidate(candidates, item[4][0], 15)
    except (OSError, socket.gaierror):
        pass

    if sys.platform == "win32":
        _parse_windows_ipconfig_ipv4(_run_text_command(["ipconfig"]), candidates)
    else:
        _parse_ifconfig_ipv4(_run_text_command(["ifconfig"]), candidates)
        if shutil.which("ip"):
            _parse_ip_addr_ipv4(_run_text_command(["ip", "-4", "addr"]), candidates)

    return sorted(
        candidates,
        key=lambda ip: _ipv4_sort_key(ip, candidates[ip]),
    )


def ensure_cache_dirs():
    os.makedirs(CACHE_DIR, exist_ok=True)
    os.makedirs(READY_DIR, exist_ok=True)
    os.makedirs(THUMB_DIR, exist_ok=True)


def join_path(base, name):
    """Join URL-style paths using forward slashes (platform-independent)."""
    if not base:
        return name
    return posixpath.join(base, name)


def get_parent_path(path):
    """Get parent of a URL-style path (platform-independent)."""
    if not path:
        return None
    # Normalize to forward slashes for consistent handling
    normalized = path.replace("\\", "/").rstrip("/")
    parent = posixpath.dirname(normalized)
    return parent


def _get_media_stat(relative_path):
    if not relative_path:
        return None, None
    normalized = relative_path.strip().replace("\\", "/").strip("/")
    normalized = posixpath.normpath(normalized)
    if normalized in ("", "."):
        return None, None
    file_path = safe_join(MEDIA_DIR, normalized)
    if not file_path or not os.path.isfile(file_path):
        return None, None
    try:
        return file_path, os.stat(file_path)
    except OSError:
        return None, None


def _iter_key_labels(relative_path, include_media_dir_prefix=False):
    """Yield the relative-path labels that may have been used for caching.

    This helps survive restarts when the server is launched with a different --media-dir
    (making relative paths longer/shorter by a leading prefix).
    """
    if not relative_path:
        return
    normalized = relative_path.strip().replace("\\", "/").strip("/")
    normalized = posixpath.normpath(normalized)
    if normalized in ("", "."):
        return
    parts = [part for part in normalized.split("/") if part and part != "."]
    seen = set()
    labels = []
    # Most-specific first: full path, then progressively drop leading folders.
    labels.extend("/".join(parts[index:]) for index in range(len(parts)))
    if include_media_dir_prefix and MEDIA_DIR:
        media_name = os.path.basename(os.path.abspath(MEDIA_DIR))
        if media_name and parts[0] != media_name:
            labels.append("/".join([media_name] + parts))

    for label in labels:
        if label and label not in seen:
            seen.add(label)
            yield label


def _mtime_seconds_candidates(stat):
    # Prefer integer nanoseconds to avoid float rounding differences across runs.
    if hasattr(stat, "st_mtime_ns"):
        base_seconds = int(stat.st_mtime_ns // 1_000_000_000)
    else:
        base_seconds = int(getattr(stat, "st_mtime", 0) or 0)
    # Legacy keys were computed via int(stat.st_mtime) on a float; allow +/- 1s tolerance.
    candidates = [base_seconds, base_seconds - 1, base_seconds + 1]
    seen = set()
    for value in candidates:
        if value < 0:
            continue
        if value in seen:
            continue
        seen.add(value)
        yield value


def _compute_key_from(label, stat, mtime_seconds):
    seed = f"{label}|{stat.st_size}|{mtime_seconds}"
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()


def compute_media_key(relative_path):
    """Compute the primary cache key for a media path."""
    _, stat = _get_media_stat(relative_path)
    if not stat:
        return None
    for label in _iter_key_labels(relative_path):
        for mtime_seconds in _mtime_seconds_candidates(stat):
            return _compute_key_from(label, stat, mtime_seconds)
    return None


def _compute_media_key_candidates(relative_path):
    """Yield candidate keys (most likely first) for cache lookup."""
    _, stat = _get_media_stat(relative_path)
    if not stat:
        return
    for label in _iter_key_labels(relative_path, include_media_dir_prefix=True):
        for mtime_seconds in _mtime_seconds_candidates(stat):
            yield _compute_key_from(label, stat, mtime_seconds)


def safe_join(base_dir, relative_path):
    """Safely join base directory with relative path, preventing directory traversal."""
    if not relative_path:
        return base_dir
    # Normalize slashes to OS-native format first, then strip leading slashes
    relative_path = relative_path.replace("/", os.sep).replace("\\", os.sep)
    relative_path = relative_path.lstrip(os.sep)
    normalized = os.path.normpath(relative_path)
    if normalized.startswith("..") or os.path.isabs(normalized):
        return None
    abs_path = os.path.abspath(os.path.join(base_dir, normalized))
    try:
        # Use normcase for case-insensitive comparison on Windows
        base_normalized = os.path.normcase(os.path.abspath(base_dir))
        path_normalized = os.path.normcase(abs_path)
        common = os.path.commonpath([base_normalized, path_normalized])
    except ValueError:
        return None
    if common != base_normalized:
        return None
    return abs_path


def _is_same_or_inside(path, parent):
    try:
        path_normalized = os.path.normcase(os.path.abspath(path))
        parent_normalized = os.path.normcase(os.path.abspath(parent))
        return (
            os.path.commonpath([path_normalized, parent_normalized])
            == parent_normalized
        )
    except ValueError:
        return False


def _prune_cache_dirs(root, dirnames):
    """Prevent recursive media scans from treating generated cache files as media."""
    cache_path = os.path.abspath(CACHE_DIR)
    dirnames[:] = [
        dirname
        for dirname in dirnames
        if not _is_same_or_inside(os.path.join(root, dirname), cache_path)
    ]


def _build_browse_video_item(
    entry_name,
    item_path,
    stat,
    ext,
    processing_log,
    device_positions,
    device_watched,
):
    play_path = item_path
    play_ext = ext
    prepared = bool(get_ready_cache_path(play_path, play_ext))
    if not prepared:
        return None

    processing = processing_log.get(item_path) or {}
    position_seconds = 0.0
    for position_path in (play_path, item_path):
        try:
            position_seconds = max(
                position_seconds,
                float(device_positions.get(position_path) or 0.0),
            )
        except (TypeError, ValueError):
            pass
    watched = (
        play_path in device_watched
        or item_path in device_watched
        or position_seconds >= WATCHED_THRESHOLD_SECONDS
    )

    return {
        "type": "video",
        "name": entry_name,
        "path": item_path,
        "size": stat.st_size,
        "mtime": int(stat.st_mtime),
        "ext": ext,
        "mp4_exists": False,
        "can_play": True,
        "prepared": prepared,
        "play_path": play_path,
        "play_ext": play_ext,
        "position_seconds": position_seconds,
        "watched": watched,
        "convert_status": processing.get("convert_status"),
        "convert_pct": processing.get("convert_pct", 0),
        "ready_status": processing.get("ready_status"),
        "ready_pct": processing.get("ready_pct", 0),
    }


def browse_media(relative_path, device_id=""):
    relative_path = relative_path.strip().replace("\\", "/")
    safe_path = safe_join(MEDIA_DIR, relative_path)
    if not safe_path or not os.path.isdir(safe_path):
        return {"error": "Invalid media folder."}

    folders = []
    videos = []
    processing_log = load_processing_log()
    device_positions = {}
    device_watched = set()
    if device_id:
        with POSITIONS_LOCK:
            device_positions = load_positions().get(device_id) or {}
        with WATCHED_LOCK:
            device_watched = load_watched().get(device_id) or set()
    try:
        with os.scandir(safe_path) as iterator:
            for entry in iterator:
                if entry.is_dir():
                    if _is_same_or_inside(entry.path, CACHE_DIR):
                        continue
                    item_path = join_path(relative_path, entry.name)
                    folders.append(
                        {"type": "dir", "name": entry.name, "path": item_path}
                    )
                    continue

        for root, dirnames, filenames in os.walk(safe_path):
            _prune_cache_dirs(root, dirnames)
            for filename in filenames:
                ext = os.path.splitext(filename)[1].lower()
                if ext not in DIRECT_PLAYABLE_EXTENSIONS:
                    # The library only lists prepared MP4/MOV files.
                    continue
                full_path = os.path.join(root, filename)
                item_path = os.path.relpath(full_path, MEDIA_DIR).replace("\\", "/")
                stat = os.stat(full_path)
                video = _build_browse_video_item(
                    filename,
                    item_path,
                    stat,
                    ext,
                    processing_log,
                    device_positions,
                    device_watched,
                )
                if video:
                    videos.append(video)
    except OSError:
        return {"error": "Unable to scan media directory."}

    folders.sort(key=lambda item: item["name"].lower())
    videos.sort(key=lambda item: (-item["mtime"], item["name"].lower()))
    return {
        "root": os.path.basename(MEDIA_DIR) or MEDIA_DIR,
        "path": relative_path,
        "parent": get_parent_path(relative_path),
        "count": len(folders) + len(videos),
        "items": folders + videos,
        "ffmpeg_available": bool(FFMPEG_PATH),
    }


def parse_range_header(range_header, file_size):
    """Parse HTTP Range header.

    Returns a tuple: (status, byte_range)
      - ("none", None): no Range header supplied
      - ("ok", (start, end)): satisfiable single-byte range
      - ("invalid", None): malformed range syntax
      - ("unsatisfiable", None): syntactically valid but outside file bounds
    """
    if not range_header:
        return "none", None
    if not range_header.startswith("bytes="):
        return "invalid", None
    if file_size <= 0:
        return "unsatisfiable", None

    byte_range = range_header.split("=", 1)[1].strip()
    if not byte_range or "," in byte_range:
        return "invalid", None

    if byte_range.startswith("-"):
        try:
            suffix = int(byte_range[1:])
        except ValueError:
            return "invalid", None
        if suffix <= 0:
            return "unsatisfiable", None
        if suffix >= file_size:
            return "ok", (0, file_size - 1)
        return "ok", (file_size - suffix, file_size - 1)

    parts = byte_range.split("-", 1)
    if not parts[0]:
        return "invalid", None
    try:
        start = int(parts[0])
    except ValueError:
        return "invalid", None
    if start < 0:
        return "invalid", None
    if start >= file_size:
        return "unsatisfiable", None

    end = file_size - 1
    if len(parts) > 1 and parts[1]:
        try:
            end = int(parts[1])
        except ValueError:
            return "invalid", None
        if end < start:
            return "unsatisfiable", None
    end = min(end, file_size - 1)
    return "ok", (start, end)


def is_safe_media_path(path):
    if not path:
        return False
    if "\x00" in path:
        return False
    return True


def read_text_file(path):
    try:
        with open(path, "r", encoding="utf-8") as file_handle:
            return file_handle.read().strip()
    except OSError:
        return ""


def parse_duration_text(value):
    if not value:
        return 0.0
    parts = value.strip().split(":")
    if len(parts) != 3:
        return 0.0
    try:
        hours = float(parts[0])
        minutes = float(parts[1])
        seconds = float(parts[2])
    except ValueError:
        return 0.0
    return hours * 3600 + minutes * 60 + seconds


def stream_duration_seconds(stream):
    duration = stream.get("duration")
    if duration:
        try:
            return float(duration)
        except (TypeError, ValueError):
            pass
    tags = stream.get("tags") or {}
    tag_duration = tags.get("DURATION")
    if tag_duration:
        parsed = parse_duration_text(tag_duration)
        if parsed:
            return parsed
    duration_ts = stream.get("duration_ts")
    time_base = stream.get("time_base")
    if duration_ts and time_base:
        try:
            numerator, denominator = time_base.split("/", 1)
            return (float(duration_ts) * float(numerator)) / float(denominator)
        except (ValueError, ZeroDivisionError):
            pass
    return 0.0


def probe_streams(file_path):
    if not FFPROBE_PATH:
        return None
    cmd = [
        FFPROBE_PATH,
        "-hide_banner",
        "-loglevel",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        file_path,
    ]
    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        errors="ignore",
        **SUBPROCESS_FLAGS,
    )
    if result.returncode != 0:
        return None
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    return payload.get("streams") or []


def select_stream_index(streams, codec_type, allow_attached_pic=False):
    candidates = []
    for stream in streams:
        if stream.get("codec_type") != codec_type:
            continue
        if (
            codec_type == "video"
            and not allow_attached_pic
            and stream.get("disposition", {}).get("attached_pic") == 1
        ):
            continue
        try:
            index = int(stream.get("index"))
        except (TypeError, ValueError):
            continue
        default_stream = bool(stream.get("disposition", {}).get("default"))
        duration = stream_duration_seconds(stream)
        candidates.append((default_stream, duration, index))

    if not candidates and codec_type == "video" and not allow_attached_pic:
        return select_stream_index(streams, codec_type, allow_attached_pic=True)
    if not candidates:
        return None

    default_candidates = [item for item in candidates if item[0]]
    if default_candidates:
        candidates = default_candidates
    candidates.sort(key=lambda item: (-item[1], item[2]))
    return candidates[0][2]


def build_stream_maps(file_path):
    streams = probe_streams(file_path)
    if not streams:
        return [], []
    video_index = select_stream_index(streams, "video")
    if video_index is None:
        return [], []
    video_map = ["-map", f"0:{video_index}"]
    audio_index = select_stream_index(streams, "audio")
    av_map = list(video_map)
    if audio_index is not None:
        av_map.extend(["-map", f"0:{audio_index}"])
    else:
        av_map.extend(["-map", "0:a:0?"])
    return video_map, av_map


def get_ready_cache_path(relative_path, ext):
    """Return a prepared 'faststart' copy path if it exists, otherwise None."""
    if ext not in STREAM_READY_EXTENSIONS:
        return None
    for key in _compute_media_key_candidates(relative_path) or ():
        cached = os.path.join(READY_DIR, f"{key}{ext}")
        if os.path.isfile(cached):
            return cached
    return None


def get_thumb_cache_path(relative_path):
    key = compute_media_key(relative_path)
    if not key:
        return None
    return os.path.join(THUMB_DIR, f"{key}.jpg")


def _find_existing_thumb(relative_path):
    for key in _compute_media_key_candidates(relative_path) or ():
        candidate = os.path.join(THUMB_DIR, f"{key}.jpg")
        try:
            if os.path.isfile(candidate) and os.path.getsize(candidate) > 0:
                return candidate
        except OSError:
            continue
    return None


def ensure_thumbnail(relative_path):
    """Return path to thumbnail image. Uses sidecar image or generates cached JPEG via ffmpeg."""
    relative_path = relative_path.strip().replace("\\", "/")
    file_path = safe_join(MEDIA_DIR, relative_path)
    if not file_path or not os.path.isfile(file_path):
        return None, "file not found"

    ext = os.path.splitext(file_path)[1].lower()
    if ext not in DIRECT_PLAYABLE_EXTENSIONS:
        return None, "unsupported video type"

    # Sidecar thumbnails: Movie.mp4 + Movie.jpg/png/jpeg
    base_name = os.path.splitext(file_path)[0]
    for thumb_ext in (".png", ".jpg", ".jpeg"):
        sidecar = base_name + thumb_ext
        if os.path.isfile(sidecar):
            return sidecar, None

    if not FFMPEG_PATH:
        return None, "ffmpeg not available"

    ensure_cache_dirs()
    existing = _find_existing_thumb(relative_path)
    if existing:
        return existing, None

    thumb_path = get_thumb_cache_path(relative_path)
    if not thumb_path:
        return None, "invalid media key"
    if os.path.isfile(thumb_path) and os.path.getsize(thumb_path) > 0:
        return thumb_path, None

    cmd = [
        FFMPEG_PATH,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        "00:00:03",
        "-i",
        file_path,
        "-frames:v",
        "1",
        "-vf",
        "scale=320:-2",
        "-q:v",
        "6",
        thumb_path,
    ]
    result = subprocess.run(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        errors="ignore",
        **SUBPROCESS_FLAGS,
    )
    if result.returncode == 0 and os.path.isfile(thumb_path) and os.path.getsize(thumb_path) > 0:
        return thumb_path, None
    if os.path.isfile(thumb_path):
        try:
            os.remove(thumb_path)
        except OSError:
            pass
    return None, summarize_ffmpeg_error(result.stderr or "") or "thumbnail failed"


def summarize_ffmpeg_error(stderr_text):
    if not stderr_text:
        return "ffmpeg failed with no output"
    cleaned = stderr_text.encode("ascii", "ignore").decode("ascii")
    lines = [line.strip() for line in cleaned.splitlines() if line.strip()]
    if not lines:
        return "ffmpeg failed with no output"
    tail = lines[-6:]
    message = " | ".join(tail)
    return message[-800:]


def load_processing_log():
    def normalize_entry(value):
        entry = {
            "convert_status": "idle",
            "convert_pct": 0,
            "convert_error": None,
            "ready_status": "idle",
            "ready_pct": 0,
            "ready_error": None,
            "updated_at": 0,
        }
        if isinstance(value, int):
            # Legacy format: {path: percent}
            pct = max(0, min(100, int(value)))
            entry["convert_pct"] = pct
            entry["convert_status"] = "done" if pct >= 100 else "idle"
            entry["updated_at"] = int(time.time())
            return entry
        if not isinstance(value, dict):
            return entry
        for key in ("convert_status", "ready_status"):
            if isinstance(value.get(key), str):
                entry[key] = value[key]
        for key in ("convert_pct", "ready_pct", "updated_at"):
            if isinstance(value.get(key), (int, float)):
                entry[key] = int(value[key])
        for key in ("convert_error", "ready_error"):
            if value.get(key) is None or isinstance(value.get(key), str):
                entry[key] = value.get(key)
        return entry

    try:
        with open(PROCESS_LOG_PATH, "r", encoding="utf-8") as handle:
            data = json.load(handle)
            if not isinstance(data, dict):
                return {}
            return {path: normalize_entry(value) for path, value in data.items()}
    except (OSError, json.JSONDecodeError):
        return {}


def write_processing_log(data):
    ensure_cache_dirs()
    tmp_path = PROCESS_LOG_PATH + ".tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=True)
        os.replace(tmp_path, PROCESS_LOG_PATH)
    except OSError:
        # Windows can fail replacing an open file (e.g. if it's open in an editor).
        # Fall back to in-place overwrite.
        try:
            with open(PROCESS_LOG_PATH, "w", encoding="utf-8") as handle:
                json.dump(data, handle, indent=2, sort_keys=True)
        except OSError:
            pass


_MISSING = object()


def update_processing(path, kind, *, status=None, pct=None, error=_MISSING, threshold=1):
    """Update processing.json for a single file.

    kind: "convert" or "ready"
    """
    if kind not in ("convert", "ready"):
        raise ValueError("kind must be 'convert' or 'ready'")
    if not path:
        return

    data = load_processing_log()
    entry = data.get(path) or {}
    # Ensure missing keys exist (load_processing_log normalizes existing entries)
    if not isinstance(entry, dict) or "convert_pct" not in entry:
        entry = {
            "convert_status": "idle",
            "convert_pct": 0,
            "convert_error": None,
            "ready_status": "idle",
            "ready_pct": 0,
            "ready_error": None,
            "updated_at": 0,
        }

    pct_key = f"{kind}_pct"
    status_key = f"{kind}_status"
    error_key = f"{kind}_error"

    changed = False

    if pct is not None:
        try:
            pct_val = int(max(0, min(100, pct)))
        except (TypeError, ValueError):
            pct_val = 0
        previous = entry.get(pct_key)
        if previous != pct_val and (
            previous is None
            or not (
                isinstance(previous, int)
                and abs(previous - pct_val) < threshold
                and pct_val != 100
            )
        ):
            entry[pct_key] = pct_val
            changed = True

    if status is not None:
        entry[status_key] = str(status)
        changed = True
    if error is not _MISSING:
        entry[error_key] = error
        changed = True

    if changed:
        entry["updated_at"] = int(time.time())
        data[path] = entry
        write_processing_log(data)


def load_positions():
    try:
        with open(POSITIONS_PATH, "r", encoding="utf-8") as handle:
            data = json.load(handle)
            if not isinstance(data, dict):
                return {}
            # Ensure nested dicts
            normalized = {}
            for device_id, items in data.items():
                if not isinstance(device_id, str) or not isinstance(items, dict):
                    continue
                normalized_items = {}
                for rel_path, seconds in items.items():
                    if not isinstance(rel_path, str):
                        continue
                    try:
                        normalized_items[rel_path] = float(seconds)
                    except (TypeError, ValueError):
                        continue
                if normalized_items:
                    normalized[device_id] = normalized_items
            return normalized
    except (OSError, json.JSONDecodeError):
        return {}


def write_positions(data):
    ensure_cache_dirs()
    tmp_path = POSITIONS_PATH + ".tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=True)
        os.replace(tmp_path, POSITIONS_PATH)
    except OSError:
        try:
            with open(POSITIONS_PATH, "w", encoding="utf-8") as handle:
                json.dump(data, handle, indent=2, sort_keys=True)
        except OSError:
            pass


def load_watched():
    try:
        with open(WATCHED_PATH, "r", encoding="utf-8") as handle:
            data = json.load(handle)
            if not isinstance(data, dict):
                return {}
            normalized = {}
            for device_id, items in data.items():
                if not isinstance(device_id, str):
                    continue
                if isinstance(items, dict):
                    raw_paths = items.keys()
                elif isinstance(items, list):
                    raw_paths = items
                else:
                    continue
                paths = set()
                for rel_path in raw_paths:
                    if not isinstance(rel_path, str):
                        continue
                    rel_path = rel_path.strip().replace("\\", "/")
                    if rel_path and is_safe_media_path(rel_path):
                        paths.add(rel_path)
                if paths:
                    normalized[device_id] = paths
            return normalized
    except (OSError, json.JSONDecodeError):
        return {}


def write_watched(data):
    ensure_cache_dirs()
    serializable = {}
    for device_id, paths in data.items():
        if not isinstance(device_id, str):
            continue
        clean_paths = sorted(
            path
            for path in paths
            if isinstance(path, str) and path and is_safe_media_path(path)
        )
        if clean_paths:
            serializable[device_id] = clean_paths

    tmp_path = WATCHED_PATH + ".tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(serializable, handle, indent=2, sort_keys=True)
        os.replace(tmp_path, WATCHED_PATH)
    except OSError:
        try:
            with open(WATCHED_PATH, "w", encoding="utf-8") as handle:
                json.dump(serializable, handle, indent=2, sort_keys=True)
        except OSError:
            pass


def is_safe_device_id(device_id):
    if not device_id or not isinstance(device_id, str):
        return False
    if len(device_id) > 80:
        return False
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
    return all(char in allowed for char in device_id)


class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 300  # 5 minute socket timeout for long video streams

    def setup(self):
        super().setup()
        # Enable TCP keepalive to prevent connection drops
        try:
            self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            if sys.platform == "win32":
                # Windows: keepalive time in milliseconds
                self.connection.ioctl(socket.SIO_KEEPALIVE_VALS, (1, 30000, 5000))
            elif sys.platform == "darwin":
                # macOS: TCP_KEEPALIVE in seconds
                self.connection.setsockopt(socket.IPPROTO_TCP, 0x10, 30)  # TCP_KEEPALIVE
            else:
                # Linux
                self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 30)
                self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 5)
                self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 5)
        except (OSError, AttributeError):
            pass  # Keepalive not supported on this platform

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionResetError, BrokenPipeError, TimeoutError, OSError):
            self.close_connection = True

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self.handle_health()
            return
        if parsed.path == "/api/browse":
            self.handle_browse(parsed.query)
            return
        if parsed.path == "/api/position":
            self.handle_get_position(parsed.query)
            return
        if parsed.path.startswith("/thumb/"):
            self.handle_thumb(parsed.path)
            return
        if parsed.path.startswith("/media/"):
            self.handle_media(parsed.path, head_only=False)
            return
        if parsed.path == "/api/admin/videos":
            self.handle_admin_videos()
            return
        if parsed.path == "/api/admin/convert-status":
            self.handle_convert_status(parsed.query)
            return
        if parsed.path == "/api/admin/prepare-status":
            self.handle_prepare_status(parsed.query)
            return
        self.serve_static(parsed.path, head_only=False)

    def do_HEAD(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/thumb/"):
            self.handle_thumb(parsed.path, head_only=True)
            return
        if parsed.path.startswith("/media/"):
            self.handle_media(parsed.path, head_only=True)
            return
        self.serve_static(parsed.path, head_only=True)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/admin/convert":
            self.handle_start_convert()
            return
        if parsed.path == "/api/admin/prepare":
            self.handle_start_prepare()
            return
        if parsed.path == "/api/position":
            self.handle_set_position()
            return
        self.send_error(404)

    def handle_health(self):
        payload = {
            "status": "ok",
            "server": "video",
            "version": 2,
            "ffmpeg_available": bool(FFMPEG_PATH),
        }
        self.send_json(payload, status=200)

    def handle_browse(self, query):
        params = parse_qs(query)
        relative_path = params.get("path", [""])[0].strip()
        device_id = params.get("device", [""])[0].strip()
        if device_id and not is_safe_device_id(device_id):
            self.send_json({"error": "Invalid device id"}, status=400)
            return
        payload = browse_media(relative_path, device_id=device_id)
        status = 200 if "error" not in payload else 400
        self.send_json(payload, status=status)

    def handle_media(self, path, head_only=False):
        relative_path = unquote(path[len("/media/") :])
        if not is_safe_media_path(relative_path):
            self.send_error(400)
            return
        file_path = safe_join(MEDIA_DIR, relative_path)
        if not file_path or not os.path.isfile(file_path):
            self.send_error(404)
            return
        ext = os.path.splitext(file_path)[1].lower()
        if ext not in MEDIA_EXTENSIONS:
            self.send_error(400)
            return
        if ext not in DIRECT_PLAYABLE_EXTENSIONS:
            self.send_error(400)
            return
        ready_path = get_ready_cache_path(relative_path, ext)
        if ready_path:
            file_path = ready_path

        file_size = os.path.getsize(file_path)
        range_header = self.headers.get("Range")
        range_status, byte_range = parse_range_header(range_header, file_size)
        content_type = CONTENT_TYPES.get(ext.lower(), "application/octet-stream")
        try:
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass

        if range_status == "unsatisfiable":
            self.send_response(416)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Disposition", "inline")
            self.send_header("Content-Range", f"bytes */{file_size}")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.send_cors_headers()
            self.end_headers()
            return

        # Some browsers occasionally send unsupported/malformed Range headers (e.g. multi-range).
        # Treat them as "no range" instead of hard-failing the request.
        if range_status == "invalid":
            byte_range = None

        if range_status == "ok" and byte_range:
            start, end = byte_range
            length = end - start + 1
            self.send_response(206)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Disposition", "inline")
            self.send_header("Content-Length", str(length))
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "no-store")
            self.send_cors_headers()
            self.end_headers()
            if head_only:
                return
            with open(file_path, "rb") as file_handle:
                file_handle.seek(start)
                self.stream_file(file_handle, length)
            return

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Disposition", "inline")
        self.send_header("Content-Length", str(file_size))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        self.send_cors_headers()
        self.end_headers()
        if head_only:
            return
        with open(file_path, "rb") as file_handle:
            self.stream_file(file_handle)

    def handle_thumb(self, path, head_only=False):
        relative_path = unquote(path[len("/thumb/") :])
        if not is_safe_media_path(relative_path):
            self.send_error(400)
            return
        thumb_path, error = ensure_thumbnail(relative_path)
        if not thumb_path:
            self.send_error(404, error or "thumbnail not available")
            return
        self.send_file(thumb_path, head_only=head_only)

    def handle_get_position(self, query):
        params = parse_qs(query)
        device_id = params.get("device", [""])[0].strip()
        rel_path = params.get("path", [""])[0].strip().replace("\\", "/")
        if not is_safe_device_id(device_id):
            self.send_json({"error": "Invalid device id"}, status=400)
            return
        if not rel_path or not is_safe_media_path(rel_path):
            self.send_json({"error": "Invalid path"}, status=400)
            return
        file_path = safe_join(MEDIA_DIR, rel_path)
        if not file_path or not os.path.isfile(file_path):
            self.send_json({"error": "File not found"}, status=404)
            return
        ext = os.path.splitext(file_path)[1].lower()
        if ext not in DIRECT_PLAYABLE_EXTENSIONS:
            self.send_json({"error": "Unsupported type"}, status=400)
            return

        with POSITIONS_LOCK:
            data = load_positions()
            seconds = (data.get(device_id) or {}).get(rel_path)
        try:
            seconds_val = float(seconds) if seconds is not None else 0.0
        except (TypeError, ValueError):
            seconds_val = 0.0
        self.send_json({"device": device_id, "path": rel_path, "seconds": seconds_val})

    def handle_set_position(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8", errors="ignore")
        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self.send_json({"error": "Invalid JSON"}, status=400)
            return

        device_id = str(data.get("device") or "").strip()
        rel_path = str(data.get("path") or "").strip().replace("\\", "/")
        clear_flag = bool(data.get("clear"))
        mark_watched = clear_flag or bool(data.get("watched"))
        if not is_safe_device_id(device_id):
            self.send_json({"error": "Invalid device id"}, status=400)
            return
        if not rel_path or not is_safe_media_path(rel_path):
            self.send_json({"error": "Invalid path"}, status=400)
            return
        file_path = safe_join(MEDIA_DIR, rel_path)
        if not file_path or not os.path.isfile(file_path):
            self.send_json({"error": "File not found"}, status=404)
            return
        ext = os.path.splitext(file_path)[1].lower()
        if ext not in DIRECT_PLAYABLE_EXTENSIONS:
            self.send_json({"error": "Unsupported type"}, status=400)
            return

        with POSITIONS_LOCK:
            positions = load_positions()
            device_positions = positions.get(device_id) or {}
            if clear_flag:
                device_positions.pop(rel_path, None)
            else:
                try:
                    seconds = float(data.get("seconds", 0))
                except (TypeError, ValueError):
                    seconds = 0.0
                seconds = max(0.0, min(60.0 * 60.0 * 24.0, seconds))
                if seconds >= WATCHED_THRESHOLD_SECONDS:
                    mark_watched = True
                device_positions[rel_path] = seconds
            if device_positions:
                positions[device_id] = device_positions
            else:
                positions.pop(device_id, None)
            write_positions(positions)

        if mark_watched:
            with WATCHED_LOCK:
                watched = load_watched()
                device_watched = watched.get(device_id) or set()
                device_watched.add(rel_path)
                watched[device_id] = device_watched
                write_watched(watched)

        self.send_json({"status": "ok", "device": device_id, "path": rel_path})

    def serve_static(self, path, head_only=False):
        if path == "/":
            path = "/index.html"
        # Convert URL path to OS-native format and strip leading slashes
        safe_path = path.replace("/", os.sep).lstrip(os.sep)
        safe_path = os.path.normpath(safe_path)
        if ".." in safe_path.split(os.sep):
            self.send_error(403)
            return
        file_path = os.path.join(STATIC_DIR, safe_path)
        if not os.path.isfile(file_path):
            self.send_error(404)
            return
        self.send_file(file_path, head_only=head_only)

    def send_file(self, file_path, head_only=False):
        file_size = os.path.getsize(file_path)
        _, ext = os.path.splitext(file_path)
        content_type = CONTENT_TYPES.get(ext.lower(), "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(file_size))
        self.send_header("Cache-Control", "no-store")
        self.send_cors_headers()
        self.end_headers()
        if head_only:
            return
        with open(file_path, "rb") as file_handle:
            data = file_handle.read()
        self.wfile.write(data)

    def stream_file(self, file_handle, length=None):
        remaining = length
        while True:
            if remaining is None:
                chunk = file_handle.read(CHUNK_SIZE)
            else:
                if remaining <= 0:
                    break
                chunk = file_handle.read(min(CHUNK_SIZE, remaining))
            if not chunk:
                break
            try:
                self.wfile.write(chunk)
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
                self.close_connection = True
                break
            if remaining is not None:
                remaining -= len(chunk)

    def send_json(self, data, status=200):
        payload = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(payload)

    def handle_admin_videos(self):
        """List all videos with their format info and processing status."""
        if not MEDIA_DIR:
            self.send_json({"error": "Media directory not set"}, 500)
            return

        videos = []
        processing_log = load_processing_log()
        log_changed = False
        seen_paths = set()

        for root, dirnames, files in os.walk(MEDIA_DIR):
            _prune_cache_dirs(root, dirnames)
            for filename in files:
                ext = os.path.splitext(filename)[1].lower()
                if ext not in MEDIA_EXTENSIONS:
                    continue

                full_path = os.path.join(root, filename)
                rel_path = os.path.relpath(full_path, MEDIA_DIR).replace("\\", "/")
                seen_paths.add(rel_path)
                stat = os.stat(full_path)

                if rel_path not in processing_log:
                    processing_log[rel_path] = {
                        "convert_status": "idle",
                        "convert_pct": 0,
                        "convert_error": None,
                        "ready_status": "idle",
                        "ready_pct": 0,
                        "ready_error": None,
                        "updated_at": int(time.time()),
                    }
                    log_changed = True

                processing = processing_log.get(rel_path) or {}

                base_name = os.path.splitext(full_path)[0]
                mp4_exists = os.path.isfile(base_name + ".mp4") and ext != ".mp4"
                is_direct = ext in DIRECT_PLAYABLE_EXTENSIONS
                ready_cached = (
                    bool(get_ready_cache_path(rel_path, ext)) if is_direct else False
                )

                # If the server restarted mid-job, the persisted status can be stale.
                # Reconcile "in progress" statuses with what's actually on disk.
                convert_job_active = False
                ready_job_active = False
                with JOBS_LOCK:
                    convert_job_active = ("convert", rel_path) in JOBS
                    ready_job_active = ("ready", rel_path) in JOBS

                if processing.get("convert_status") == "converting" and not convert_job_active:
                    if mp4_exists:
                        processing["convert_status"] = "done"
                        processing["convert_pct"] = 100
                        processing["convert_error"] = None
                    else:
                        processing["convert_status"] = "error"
                        processing["convert_pct"] = 0
                        processing["convert_error"] = "Interrupted (server restarted)"
                    processing["updated_at"] = int(time.time())
                    processing_log[rel_path] = processing
                    log_changed = True

                if processing.get("ready_status") == "preparing" and not ready_job_active:
                    if ready_cached:
                        processing["ready_status"] = "done"
                        processing["ready_pct"] = 100
                        processing["ready_error"] = None
                    else:
                        processing["ready_status"] = "error"
                        processing["ready_pct"] = 0
                        processing["ready_error"] = "Interrupted (server restarted)"
                    processing["updated_at"] = int(time.time())
                    processing_log[rel_path] = processing
                    log_changed = True

                videos.append(
                    {
                        "name": filename,
                        "path": rel_path,
                        "ext": ext,
                        "size": stat.st_size,
                        "is_direct": is_direct,
                        "mp4_exists": mp4_exists,
                        "ready_cached": ready_cached,
                        "convert_status": processing.get("convert_status", "idle"),
                        "convert_pct": int(processing.get("convert_pct", 0) or 0),
                        "convert_error": processing.get("convert_error"),
                        "ready_status": processing.get("ready_status", "idle"),
                        "ready_pct": int(processing.get("ready_pct", 0) or 0),
                        "ready_error": processing.get("ready_error"),
                    }
                )

        stale = [path for path in processing_log.keys() if path not in seen_paths]
        if stale:
            for path in stale:
                processing_log.pop(path, None)
            log_changed = True

        if log_changed:
            write_processing_log(processing_log)

        videos.sort(key=lambda v: v["name"].lower())
        self.send_json({"videos": videos, "ffmpeg_available": bool(FFMPEG_PATH)})

    def handle_start_convert(self):
        """Start converting a video to MP4."""
        if not FFMPEG_PATH:
            self.send_json({"error": "FFmpeg not available"}, 500)
            return
        
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8")
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_json({"error": "Invalid JSON"}, 400)
            return
        
        rel_path = data.get("path", "").strip().replace("\\", "/")
        if not rel_path or not is_safe_media_path(rel_path):
            self.send_json({"error": "Invalid path"}, 400)
            return
        
        file_path = safe_join(MEDIA_DIR, rel_path)
        if not file_path or not os.path.isfile(file_path):
            self.send_json({"error": "File not found"}, 404)
            return
        
        ext = os.path.splitext(file_path)[1].lower()
        if ext in DIRECT_PLAYABLE_EXTENSIONS:
            self.send_json({"error": "Already in a playable format (mp4/mov)."}, 400)
            return

        output_path = os.path.splitext(file_path)[0] + ".mp4"
        if os.path.isfile(output_path):
            self.send_json({"error": "MP4 copy already exists next to this file."}, 409)
            return

        with JOBS_LOCK:
            job_key = ("convert", rel_path)
            if job_key in JOBS:
                self.send_json({"error": "Conversion already in progress"}, 409)
                return
            JOBS.add(job_key)
        
        # Start conversion in background
        update_processing(rel_path, "convert", status="converting", pct=0, error=None, threshold=0)
        threading.Thread(
            target=self._run_conversion,
            args=(rel_path, file_path, job_key),
            daemon=True
        ).start()
        
        self.send_json({"status": "started", "path": rel_path})

    def _run_conversion(self, rel_path, input_path, job_key):
        """Background worker for video conversion."""
        output_path = os.path.splitext(input_path)[0] + ".mp4"

        # Get video duration for progress calculation
        duration = self._get_video_duration(input_path)
        
        _, av_map = build_stream_maps(input_path)
        cmd = [
            FFMPEG_PATH,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i", input_path,
        ]
        if av_map:
            cmd.extend(av_map)
        cmd.extend([
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-c:a", TARGET_AUDIO_CODEC,
            "-profile:a", TARGET_AUDIO_PROFILE,
            "-b:a", TARGET_AUDIO_BITRATE,
            "-ac", TARGET_AUDIO_CHANNELS,
            "-ar", TARGET_AUDIO_SAMPLE_RATE,
            "-movflags", "+faststart",
            "-progress", "pipe:1",
            output_path,
        ])
        
        try:
            update_processing(rel_path, "convert", status="converting", pct=0, error=None, threshold=0)
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                errors="ignore",
                **SUBPROCESS_FLAGS,
            )

            current_time = 0
            last_logged = -5
            output_tail = []
            for line in process.stdout:
                output_tail.append(line)
                if len(output_tail) > 80:
                    output_tail = output_tail[-80:]
                if line.startswith("out_time_ms="):
                    try:
                        time_ms = int(line.split("=")[1].strip())
                        current_time = time_ms / 1000000.0
                        if duration > 0:
                            progress = min(99, (current_time / duration) * 100)
                            progress_int = int(progress)
                            if progress_int - last_logged >= 5:
                                update_processing(rel_path, "convert", pct=progress_int, threshold=0)
                                last_logged = progress_int
                        else:
                            # No duration available (missing ffprobe) — show minimal activity.
                            if last_logged < 1:
                                update_processing(rel_path, "convert", pct=1, threshold=0)
                                last_logged = 1
                    except (ValueError, IndexError):
                        pass
            
            process.wait()
            
            if process.returncode == 0 and os.path.isfile(output_path):
                update_processing(rel_path, "convert", status="done", pct=100, error=None, threshold=0)
            else:
                error_msg = summarize_ffmpeg_error("".join(output_tail)) or "Conversion failed"
                update_processing(rel_path, "convert", status="error", pct=0, error=error_msg, threshold=0)
                if os.path.isfile(output_path):
                    try:
                        os.remove(output_path)
                    except OSError:
                        pass
        except Exception as e:
            update_processing(rel_path, "convert", status="error", pct=0, error=str(e), threshold=0)
        finally:
            with JOBS_LOCK:
                JOBS.discard(job_key)

    def _get_video_duration(self, file_path):
        """Get video duration in seconds using ffprobe."""
        if not FFPROBE_PATH:
            return 0
        try:
            result = subprocess.run(
                [FFPROBE_PATH, "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", file_path],
                capture_output=True, text=True, errors="ignore",
                **SUBPROCESS_FLAGS,
            )
            return float(result.stdout.strip())
        except (ValueError, subprocess.SubprocessError):
            return 0

    def handle_convert_status(self, query):
        """Get conversion status for a video."""
        params = parse_qs(query)
        rel_path = params.get("path", [""])[0].strip().replace("\\", "/")
        
        if not rel_path:
            self.send_json({"error": "Path required"}, 400)
            return

        processing = load_processing_log().get(rel_path) or {}
        self.send_json(
            {
                "path": rel_path,
                "status": processing.get("convert_status", "idle"),
                "progress": processing.get("convert_pct", 0),
                "error": processing.get("convert_error"),
            }
        )

    def handle_start_prepare(self):
        """Prepare a playable MP4/MOV for streaming by creating a faststart copy in .cache."""
        if not FFMPEG_PATH:
            self.send_json({"error": "FFmpeg not available"}, 500)
            return

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8")
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_json({"error": "Invalid JSON"}, 400)
            return

        rel_path = data.get("path", "").strip().replace("\\", "/")
        if not rel_path or not is_safe_media_path(rel_path):
            self.send_json({"error": "Invalid path"}, 400)
            return

        file_path = safe_join(MEDIA_DIR, rel_path)
        if not file_path or not os.path.isfile(file_path):
            self.send_json({"error": "File not found"}, 404)
            return

        ext = os.path.splitext(file_path)[1].lower()
        if ext not in STREAM_READY_EXTENSIONS:
            self.send_json({"error": "Only MP4/MOV can be prepared for streaming."}, 400)
            return

        with JOBS_LOCK:
            job_key = ("ready", rel_path)
            if job_key in JOBS:
                self.send_json({"error": "Prepare already in progress"}, 409)
                return
            JOBS.add(job_key)

        update_processing(rel_path, "ready", status="preparing", pct=0, error=None, threshold=0)
        threading.Thread(
            target=self._run_prepare,
            args=(rel_path, file_path, ext, job_key),
            daemon=True,
        ).start()
        self.send_json({"status": "started", "path": rel_path})

    def _run_prepare(self, rel_path, input_path, ext, job_key):
        ensure_cache_dirs()
        key = compute_media_key(rel_path)
        if not key:
            update_processing(rel_path, "ready", status="error", pct=0, error="Invalid media key", threshold=0)
            with JOBS_LOCK:
                JOBS.discard(job_key)
            return

        output_path = os.path.join(READY_DIR, f"{key}{ext}")
        duration = self._get_video_duration(input_path)
        cmd = [
            FFMPEG_PATH,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            input_path,
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:1",
            output_path,
        ]

        try:
            update_processing(rel_path, "ready", status="preparing", pct=0, error=None, threshold=0)
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                errors="ignore",
                **SUBPROCESS_FLAGS,
            )

            current_time = 0
            last_logged = -5
            output_tail = []
            for line in process.stdout:
                output_tail.append(line)
                if len(output_tail) > 80:
                    output_tail = output_tail[-80:]
                if line.startswith("out_time_ms="):
                    try:
                        time_ms = int(line.split("=", 1)[1].strip())
                        current_time = time_ms / 1000000.0
                        if duration > 0:
                            progress = min(99, (current_time / duration) * 100)
                            progress_int = int(progress)
                            if progress_int - last_logged >= 5:
                                update_processing(rel_path, "ready", pct=progress_int, threshold=0)
                                last_logged = progress_int
                        else:
                            if last_logged < 1:
                                update_processing(rel_path, "ready", pct=1, threshold=0)
                                last_logged = 1
                    except (ValueError, IndexError):
                        pass

            process.wait()
            if process.returncode == 0 and os.path.isfile(output_path):
                update_processing(rel_path, "ready", status="done", pct=100, error=None, threshold=0)
            else:
                error_msg = summarize_ffmpeg_error("".join(output_tail)) or "Prepare failed"
                update_processing(rel_path, "ready", status="error", pct=0, error=error_msg, threshold=0)
                if os.path.isfile(output_path):
                    try:
                        os.remove(output_path)
                    except OSError:
                        pass
        except Exception as e:
            update_processing(rel_path, "ready", status="error", pct=0, error=str(e), threshold=0)
            if os.path.isfile(output_path):
                try:
                    os.remove(output_path)
                except OSError:
                    pass
        finally:
            with JOBS_LOCK:
                JOBS.discard(job_key)

    def handle_prepare_status(self, query):
        params = parse_qs(query)
        rel_path = params.get("path", [""])[0].strip().replace("\\", "/")
        if not rel_path:
            self.send_json({"error": "Path required"}, 400)
            return
        processing = load_processing_log().get(rel_path) or {}
        self.send_json(
            {
                "path": rel_path,
                "status": processing.get("ready_status", "idle"),
                "progress": processing.get("ready_pct", 0),
                "error": processing.get("ready_error"),
            }
        )

    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length")
        self.send_header("Connection", "keep-alive")
        self.send_header("Keep-Alive", "timeout=300")


def run_server(host, port, media_dir):
    global MEDIA_DIR
    MEDIA_DIR = media_dir
    ensure_cache_dirs()
    server = ThreadingHTTPServer((host, port), RequestHandler)

    normalized_host = (host or "").strip().lower()
    is_loopback = (
        normalized_host in ("localhost", "::1")
        or normalized_host.startswith("127.")
    )
    if normalized_host in ("0.0.0.0", "::", ""):
        print(f"Local URL: http://127.0.0.1:{port}")
        display_ips = get_local_ipv4_addresses()
        if display_ips:
            print("LAN URLs:")
            for display_ip in display_ips:
                print(f"  http://{display_ip}:{port}")
        else:
            print("LAN URL: unavailable (could not detect a non-loopback IP).")
        if sys.platform == "win32":
            print(
                "Windows note: if other devices still cannot connect, allow Python in Windows Defender Firewall on private networks."
            )
            print("Windows quick fix (run Terminal/PowerShell as Administrator):")
            print(
                f'  netsh advfirewall firewall add rule name="Local Video Shelf {port}" dir=in action=allow protocol=TCP localport={port}'
            )
            print("Also make sure your current network is marked as Private, not Public.")
    elif is_loopback:
        print(f"Local URL: http://{host}:{port}")
        print("LAN access: disabled. Restart with --host 0.0.0.0 to allow other devices.")
    else:
        print(f"Video server: http://{host}:{port}")
    print(f"Serving media from: {media_dir}")
    if not FFMPEG_PATH:
        print("FFmpeg: not found (admin convert/prepare disabled).")

    server.serve_forever()


def main():
    parser = argparse.ArgumentParser(description="Simple LAN video server.")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind.")
    parser.add_argument("--port", type=int, default=1337, help="Port to bind.")
    parser.add_argument(
        "--media-dir",
        default=os.getcwd(),
        help="Folder with video files to share.",
    )
    args = parser.parse_args()
    media_dir = os.path.abspath(args.media_dir)
    if not os.path.isdir(media_dir):
        raise SystemExit(f"Media directory not found: {media_dir}")
    run_server(args.host, args.port, media_dir)


if __name__ == "__main__":
    main()
