const adminList = document.getElementById("adminList");
const adminError = document.getElementById("adminError");
const ffmpegNotice = document.getElementById("ffmpegNotice");

let videos = [];
let ffmpegAvailable = false;
const pollers = new Map();

const clearError = () => {
  adminError.hidden = true;
  adminError.textContent = "";
};

const showError = (message) => {
  adminError.textContent = message;
  adminError.hidden = false;
};

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
};

const updateFfmpegNotice = (available) => {
  ffmpegAvailable = available;
  ffmpegNotice.innerHTML = `
    <strong>FFmpeg status</strong>
    ${
      available
        ? "Found. Conversions and prepare-for-streaming are enabled."
        : "Not found. Install ffmpeg (brew/choco/apt) to enable Convert/Prepare, then reload."
    }
  `;
};

const toneForStatus = (status) => {
  if (status === "error") return "error";
  if (status === "done") return "success";
  if (status === "converting" || status === "preparing") return "warn";
  return "";
};

const badgeText = (kind, video) => {
  if (kind === "convert") {
    if (video.convert_status === "converting") {
      return `Converting… ${Math.floor(video.convert_pct || 0)}%`;
    }
    if (video.convert_status === "error") {
      return video.convert_error || "Conversion failed";
    }
    if (video.mp4_exists) return "MP4 copy ready";
    if (video.is_direct) return "Playable (no conversion needed)";
    return "Needs conversion";
  }

  if (video.ready_status === "preparing") {
    return `Preparing… ${Math.floor(video.ready_pct || 0)}%`;
  }
  if (video.ready_status === "error") {
    return video.ready_error || "Prepare failed";
  }
  if (video.ready_cached) return "Prepared for streaming";
  return "Not prepared";
};

const updateVideo = (path, patch) => {
  const index = videos.findIndex((v) => v.path === path);
  if (index === -1) return;
  videos[index] = { ...videos[index], ...patch };
  renderList();
};

const renderProgress = (progress) => {
  const wrapper = document.createElement("div");
  wrapper.className = "progress";
  const bar = document.createElement("span");
  bar.style.width = `${Math.min(100, Math.max(0, progress || 0))}%`;
  wrapper.appendChild(bar);
  return wrapper;
};

const renderList = () => {
  adminList.textContent = "";
  if (!videos.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No videos found in this folder.";
    adminList.appendChild(empty);
    return;
  }

  videos.forEach((video) => {
    const row = document.createElement("div");
    row.className = "admin-row";

    const info = document.createElement("div");
    info.className = "admin-info";

    const title = document.createElement("div");
    title.className = "admin-name";
    title.textContent = video.name;

    const meta = document.createElement("div");
    meta.className = "admin-meta";
    const extSpan = document.createElement("span");
    const extText = (video.ext || "").toUpperCase().replace(".", "") || "UNKNOWN";
    extSpan.textContent = extText;
    const sizeSpan = document.createElement("span");
    sizeSpan.textContent = formatBytes(video.size);
    meta.appendChild(extSpan);
    meta.appendChild(sizeSpan);
    info.appendChild(title);
    info.appendChild(meta);

    const statusBlock = document.createElement("div");

    const convertBadge = document.createElement("span");
    convertBadge.className = "badge";
    const convertTone = toneForStatus(video.convert_status);
    if (convertTone) convertBadge.dataset.tone = convertTone;
    convertBadge.textContent = badgeText("convert", video);
    statusBlock.appendChild(convertBadge);
    if (video.convert_status === "converting") {
      statusBlock.appendChild(renderProgress(video.convert_pct || 0));
    }

    const readyBadge = document.createElement("span");
    readyBadge.className = "badge";
    const readyTone = toneForStatus(video.ready_status);
    if (readyTone) readyBadge.dataset.tone = readyTone;
    readyBadge.textContent = badgeText("ready", video);
    statusBlock.appendChild(readyBadge);
    if (video.ready_status === "preparing") {
      statusBlock.appendChild(renderProgress(video.ready_pct || 0));
    }

    const actionWrap = document.createElement("div");

    if (!video.is_direct) {
      const convertBtn = document.createElement("button");
      convertBtn.className = "action-btn";
      convertBtn.type = "button";
      convertBtn.textContent =
        video.convert_status === "converting" ? "Converting…" : "Convert to MP4";
      convertBtn.disabled =
        !ffmpegAvailable ||
        video.mp4_exists ||
        video.convert_status === "converting";
      convertBtn.addEventListener("click", () => startConvert(video));
      actionWrap.appendChild(convertBtn);
    } else {
      const prepareBtn = document.createElement("button");
      prepareBtn.className = "action-btn";
      prepareBtn.type = "button";
      prepareBtn.textContent =
        video.ready_status === "preparing"
          ? "Preparing…"
          : video.ready_cached
          ? "Prepared"
          : "Prepare for streaming";
      prepareBtn.disabled =
        !ffmpegAvailable ||
        video.ready_cached ||
        video.ready_status === "preparing";
      prepareBtn.addEventListener("click", () => startPrepare(video));
      actionWrap.appendChild(prepareBtn);
    }

    row.appendChild(info);
    row.appendChild(statusBlock);
    row.appendChild(actionWrap);

    adminList.appendChild(row);
  });
};

const startConvert = async (video) => {
  if (!ffmpegAvailable) {
    showError("Install ffmpeg to enable conversions.");
    return;
  }
  clearError();
  updateVideo(video.path, {
    convert_status: "converting",
    convert_pct: 0,
    convert_error: null,
  });

  try {
    const response = await fetch("/api/admin/convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: video.path }),
    });
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || "Unable to start conversion");
    }
    pollStatus("convert", video.path);
  } catch (error) {
    updateVideo(video.path, {
      convert_status: "error",
      convert_error: error.message,
      convert_pct: 0,
    });
    showError(error.message);
  }
};

const startPrepare = async (video) => {
  if (!ffmpegAvailable) {
    showError("Install ffmpeg to enable prepare-for-streaming.");
    return;
  }
  clearError();
  updateVideo(video.path, {
    ready_status: "preparing",
    ready_pct: 0,
    ready_error: null,
  });

  try {
    const response = await fetch("/api/admin/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: video.path }),
    });
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || "Unable to start prepare");
    }
    pollStatus("ready", video.path);
  } catch (error) {
    updateVideo(video.path, {
      ready_status: "error",
      ready_error: error.message,
      ready_pct: 0,
    });
    showError(error.message);
  }
};

const pollStatus = (kind, path) => {
  const key = `${kind}:${path}`;
  if (pollers.has(key)) return;

  const endpoint =
    kind === "convert"
      ? `/api/admin/convert-status?path=${encodeURIComponent(path)}`
      : `/api/admin/prepare-status?path=${encodeURIComponent(path)}`;

  const tick = async () => {
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || data.error) {
        throw new Error(data.error || "Status unavailable");
      }

      if (kind === "convert") {
        updateVideo(path, {
          convert_status: data.status,
          convert_pct: data.progress,
          convert_error: data.error,
          ...(data.status === "done" ? { mp4_exists: true } : {}),
        });
        if (data.status === "converting") {
          pollers.set(key, setTimeout(tick, 1200));
          return;
        }
      } else {
        updateVideo(path, {
          ready_status: data.status,
          ready_pct: data.progress,
          ready_error: data.error,
          ...(data.status === "done" ? { ready_cached: true } : {}),
        });
        if (data.status === "preparing") {
          pollers.set(key, setTimeout(tick, 1200));
          return;
        }
      }

      pollers.delete(key);
    } catch (error) {
      pollers.delete(key);
      showError(error.message);
    }
  };

  tick();
};

const loadVideos = async () => {
  adminList.innerHTML = "<div class='empty'>Loading...</div>";
  clearError();
  try {
    const response = await fetch("/api/admin/videos", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || "Unable to load videos");
    }
    videos = data.videos || [];
    updateFfmpegNotice(Boolean(data.ffmpeg_available));
    renderList();

    videos
      .filter((v) => v.convert_status === "converting")
      .forEach((v) => pollStatus("convert", v.path));
    videos
      .filter((v) => v.ready_status === "preparing")
      .forEach((v) => pollStatus("ready", v.path));
  } catch (error) {
    showError(error.message);
    adminList.innerHTML = "<div class='empty'>Could not load admin data.</div>";
  }
};

window.addEventListener("load", loadVideos);
