const adminList = document.getElementById("adminList");
const adminError = document.getElementById("adminError");
const ffmpegNotice = document.getElementById("ffmpegNotice");

let videos = [];
let ffmpegAvailable = false;
const pollers = new Map();
const openAdminFolders = new Set();

const normalizeMediaPath = (value) =>
  String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");

const folderPathForVideo = (video) => {
  const path = normalizeMediaPath(video?.path || "");
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
};

const createFolderNode = ({ key = "", name = "", parentKey = null } = {}) => ({
  key,
  name,
  path: key,
  parentKey,
  folders: new Map(),
  videos: [],
  count: 0,
});

const buildFolderTree = () => {
  const root = createFolderNode();

  videos.forEach((video) => {
    const folderParts = folderPathForVideo(video).split("/").filter(Boolean);
    let node = root;
    const ancestry = [root];

    folderParts.forEach((name) => {
      const key = node.key ? `${node.key}/${name}` : name;
      if (!node.folders.has(key)) {
        node.folders.set(
          key,
          createFolderNode({
            key,
            name,
            parentKey: node.key || null,
          })
        );
      }
      node = node.folders.get(key);
      ancestry.push(node);
    });

    node.videos.push(video);
    ancestry.forEach((ancestor) => {
      ancestor.count += 1;
    });
  });

  return root;
};

const folderEntries = (node) => {
  const folders = Array.from(node.folders.values())
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    )
    .map((folder) => ({ type: "folder", folder }));
  const folderVideoPaths = new Set();
  node.folders.forEach((folder) => {
    folder.videos.forEach((video) => folderVideoPaths.add(video.path));
  });
  const directVideos = node.videos
    .filter((video) => !folderVideoPaths.has(video.path))
    .map((video) => ({ type: "video", video }));
  return folders.concat(directVideos);
};

const videosInFolder = (folder) =>
  videos.filter((video) => {
    const path = normalizeMediaPath(video.path);
    return path === folder.path || path.startsWith(`${folder.path}/`);
  });

const isPrepareEligible = (video) =>
  Boolean(video?.is_direct) &&
  !video.ready_cached &&
  video.ready_status !== "preparing";

const folderCacheSummary = (folder) => {
  const directVideos = videosInFolder(folder).filter((video) => video.is_direct);
  const actual = directVideos.reduce((total, video) => {
    const size = Number(video.ready_cache_size);
    return total + (Number.isFinite(size) && size > 0 ? size : 0);
  }, 0);
  const estimatedTotal = directVideos.reduce((total, video) => {
    const cacheSize = Number(video.ready_cache_size);
    if (Number.isFinite(cacheSize) && cacheSize > 0) return total + cacheSize;
    const estimate = Number(video.ready_estimated_cache_size || video.size);
    return total + (Number.isFinite(estimate) && estimate > 0 ? estimate : 0);
  }, 0);
  return { actual, estimatedTotal };
};

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

const cacheLabelForVideo = (video) => {
  const cacheSize = Number(video?.ready_cache_size);
  if (Number.isFinite(cacheSize) && cacheSize > 0) {
    return `Cache: ${formatBytes(cacheSize)}`;
  }
  const estimatedSize = Number(video?.ready_estimated_cache_size || video?.size);
  if (video?.is_direct && Number.isFinite(estimatedSize) && estimatedSize > 0) {
    return `Cache estimate: ~${formatBytes(estimatedSize)}`;
  }
  return "";
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

const applyStatusPatch = (path, patch) => {
  const current = videos.find((v) => v.path === path);
  if (!current) return false;

  const normalizedPatch = { ...patch };
  if (
    current.convert_status === "converting" &&
    normalizedPatch.convert_status === "idle"
  ) {
    delete normalizedPatch.convert_status;
  }
  if (
    current.ready_status === "preparing" &&
    normalizedPatch.ready_status === "idle"
  ) {
    delete normalizedPatch.ready_status;
  }

  updateVideo(path, normalizedPatch);
  return true;
};

const renderProgress = (progress) => {
  const wrapper = document.createElement("div");
  wrapper.className = "progress";
  const bar = document.createElement("span");
  bar.style.width = `${Math.min(100, Math.max(0, progress || 0))}%`;
  wrapper.appendChild(bar);
  return wrapper;
};

const createVideoRow = (video, depth = 0) => {
  const row = document.createElement("div");
  row.className = "admin-row";
  row.style.setProperty("--admin-depth", String(depth));

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
  const cacheLabel = cacheLabelForVideo(video);
  if (cacheLabel) {
    const cacheSpan = document.createElement("span");
    cacheSpan.textContent = cacheLabel;
    meta.appendChild(cacheSpan);
  }
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

  return row;
};

const createFolderRow = (folder, depth = 0) => {
  const row = document.createElement("div");
  row.className = "admin-row admin-folder-row";
  row.style.setProperty("--admin-depth", String(depth));

  const isOpen = openAdminFolders.has(folder.key);
  const folderVideos = videosInFolder(folder);
  const directVideos = folderVideos.filter((video) => video.is_direct);
  const eligible = folderVideos.filter(isPrepareEligible);
  const cacheSummary = folderCacheSummary(folder);
  const preparing = folderVideos.filter(
    (video) => video.ready_status === "preparing"
  ).length;

  const info = document.createElement("div");
  info.className = "admin-info admin-folder-info";

  const toggle = document.createElement("button");
  toggle.className = "admin-folder-toggle";
  toggle.type = "button";
  toggle.textContent = isOpen ? "-" : "+";
  toggle.setAttribute(
    "aria-label",
    isOpen ? `Hide ${folder.name}` : `Show ${folder.name}`
  );
  toggle.addEventListener("click", () => {
    if (isOpen) {
      openAdminFolders.delete(folder.key);
    } else {
      openAdminFolders.add(folder.key);
    }
    renderList();
  });

  const titleWrap = document.createElement("div");
  const title = document.createElement("div");
  title.className = "admin-name";
  title.textContent = folder.name;

  const meta = document.createElement("div");
  meta.className = "admin-meta";
  const type = document.createElement("span");
  type.textContent = "Folder";
  const count = document.createElement("span");
  count.textContent = `${folder.count} videos`;
  const path = document.createElement("span");
  path.textContent = folder.path;
  meta.appendChild(type);
  meta.appendChild(count);
  meta.appendChild(path);
  if (cacheSummary.actual > 0) {
    const cache = document.createElement("span");
    cache.textContent = `Cache: ${formatBytes(cacheSummary.actual)}`;
    meta.appendChild(cache);
  }
  if (cacheSummary.estimatedTotal > 0) {
    const estimate = document.createElement("span");
    estimate.textContent = `Total estimate: ~${formatBytes(
      cacheSummary.estimatedTotal
    )}`;
    meta.appendChild(estimate);
  }
  titleWrap.appendChild(title);
  titleWrap.appendChild(meta);
  info.appendChild(toggle);
  info.appendChild(titleWrap);

  const statusBlock = document.createElement("div");
  const readyBadge = document.createElement("span");
  readyBadge.className = "badge";
  if (!eligible.length && !preparing) readyBadge.dataset.tone = "success";
  if (preparing) readyBadge.dataset.tone = "warn";
  readyBadge.textContent = preparing
    ? `Preparing ${preparing}`
    : eligible.length
    ? `${eligible.length} not prepared`
    : directVideos.length
    ? "MP4/MOV prepared"
    : "No MP4/MOV";
  statusBlock.appendChild(readyBadge);

  const actionWrap = document.createElement("div");
  const prepareBtn = document.createElement("button");
  prepareBtn.className = "action-btn";
  prepareBtn.type = "button";
  prepareBtn.textContent = "Prepare all contents";
  prepareBtn.disabled = !ffmpegAvailable || !eligible.length;
  prepareBtn.addEventListener("click", () => startPrepareFolder(folder));
  actionWrap.appendChild(prepareBtn);

  row.appendChild(info);
  row.appendChild(statusBlock);
  row.appendChild(actionWrap);

  return row;
};

const renderNode = (node, container, depth = 0) => {
  folderEntries(node).forEach((entry) => {
    if (entry.type === "video") {
      container.appendChild(createVideoRow(entry.video, depth));
      return;
    }
    container.appendChild(createFolderRow(entry.folder, depth));
    if (openAdminFolders.has(entry.folder.key)) {
      renderNode(entry.folder, container, depth + 1);
    }
  });
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

  renderNode(buildFolderTree(), adminList);
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

const startPrepare = async (video, { quiet = false } = {}) => {
  if (!ffmpegAvailable) {
    showError("Install ffmpeg to enable prepare-for-streaming.");
    return false;
  }
  if (!quiet) clearError();
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
    return true;
  } catch (error) {
    updateVideo(video.path, {
      ready_status: "error",
      ready_error: error.message,
      ready_pct: 0,
    });
    if (!quiet) showError(error.message);
    return false;
  }
};

const startPrepareFolder = async (folder) => {
  if (!ffmpegAvailable) {
    showError("Install ffmpeg to enable prepare-for-streaming.");
    return;
  }

  const eligible = videosInFolder(folder).filter(isPrepareEligible);
  if (!eligible.length) return;

  clearError();
  let failed = 0;
  for (const video of eligible) {
    const started = await startPrepare(video, { quiet: true });
    if (!started) failed += 1;
  }
  if (failed) {
    showError(`Could not start prepare for ${failed} item(s).`);
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
        const current = videos.find((v) => v.path === path);
        applyStatusPatch(path, {
          convert_status: data.status,
          convert_pct: data.progress,
          convert_error: data.error,
          ...(data.status === "done" ? { mp4_exists: true } : {}),
        });
        if (
          data.status === "converting" ||
          (data.status === "idle" && current?.convert_status === "converting")
        ) {
          pollers.set(key, setTimeout(tick, 1200));
          return;
        }
      } else {
        const current = videos.find((v) => v.path === path);
        applyStatusPatch(path, {
          ready_status: data.status,
          ready_pct: data.progress,
          ready_error: data.error,
          ...(data.cache_size ? { ready_cache_size: data.cache_size } : {}),
          ...(data.status === "done" ? { ready_cached: true, ready_pct: 100 } : {}),
        });
        if (
          data.status === "preparing" ||
          (data.status === "idle" && current?.ready_status === "preparing")
        ) {
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
