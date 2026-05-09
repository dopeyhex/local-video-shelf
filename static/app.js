const list = document.getElementById("videoList");
const errorBox = document.getElementById("errorBox");
const librarySummary = document.getElementById("librarySummary");
const tabButtons = Array.from(document.querySelectorAll("[data-tab]"));
const newCount = document.getElementById("newCount");
const watchedCount = document.getElementById("watchedCount");
const player = document.getElementById("player");
const playerLoading = document.getElementById("playerLoading");
const playerUi = document.getElementById("playerUi");
const playerToggle = document.getElementById("playerToggle");
const playerSeek = document.getElementById("playerSeek");
const playerVolume = document.getElementById("playerVolume");
const playerTime = document.getElementById("playerTime");

const DEVICE_STORAGE_KEY = "video_device_id";
const TAB_STORAGE_KEY = "video_active_tab_v1";
const MIN_SAVE_SECONDS = 10;
const SAVE_INTERVAL_MS = 5000;
const END_CLEAR_THRESHOLD_SECONDS = 30;

const getOrCreateDeviceId = () => {
  try {
    const existing = localStorage.getItem(DEVICE_STORAGE_KEY);
    if (existing) return existing;
    const created =
      (crypto && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : "dev-" + Math.random().toString(16).slice(2) + Date.now().toString(16)
      ).replace(/[^a-zA-Z0-9-_]/g, "");
    localStorage.setItem(DEVICE_STORAGE_KEY, created);
    return created;
  } catch (e) {
    return "dev-" + Math.random().toString(16).slice(2);
  }
};

const deviceId = getOrCreateDeviceId();
const readStoredTab = () => {
  try {
    const stored = localStorage.getItem(TAB_STORAGE_KEY);
    return stored === "watched" ? "watched" : "new";
  } catch (e) {
    return "new";
  }
};

let videos = [];
let activeTab = readStoredTab();
let openFolderKey = null;
let currentVideoPath = null;
let lastSavedAt = 0;
let playbackSession = 0;
let uiScrubbing = false;
const VOLUME_STORAGE_KEY = "video_volume_v1";
const UI_AUTOHIDE_MS = 30000;
let uiHideTimer = null;
let audioCtx = null;
let audioGain = null;
let audioSource = null;

const showPlayerUiChrome = () => {
  if (!playerUi) return;
  playerUi.classList.remove("player-ui--hidden");
};

const hidePlayerUiChrome = () => {
  if (!playerUi) return;
  playerUi.classList.add("player-ui--hidden");
};

const scheduleUiAutoHide = () => {
  if (!playerUi) return;
  if (!isIPadLike()) return;
  if (playerUi.hidden) return;

  if (uiHideTimer) {
    window.clearTimeout(uiHideTimer);
    uiHideTimer = null;
  }

  // Only auto-hide while playing; when paused, keep controls visible.
  if (!player || player.paused) return;

  uiHideTimer = window.setTimeout(() => {
    hidePlayerUiChrome();
  }, UI_AUTOHIDE_MS);
};

const bumpUiActivity = () => {
  if (!isIPadLike()) return;
  if (!playerUi || playerUi.hidden) return;
  showPlayerUiChrome();
  scheduleUiAutoHide();
};

const ensureWebAudioVolume = () => {
  // iOS/iPadOS Safari often ignores HTMLMediaElement.volume; WebAudio gain works.
  if (!player) return false;
  if (!isIPadLike()) return false;
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return false;

  try {
    if (!audioCtx) audioCtx = new AudioContextCtor();
    if (!audioGain) {
      audioGain = audioCtx.createGain();
      audioGain.gain.value = 1;
    }
    if (!audioSource) {
      // Can only create one source per media element.
      audioSource = audioCtx.createMediaElementSource(player);
      audioSource.connect(audioGain);
      audioGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === "suspended") {
      // Best-effort; must be user-gesture initiated to succeed on Safari.
      audioCtx.resume().catch(() => {});
    }
    return true;
  } catch (e) {
    return false;
  }
};

const applyVolume = (ratio) => {
  const volume = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 1;
  const hasWebAudio = ensureWebAudioVolume();
  if (hasWebAudio && audioGain) {
    try {
      audioGain.gain.value = volume;
    } catch (e) {}
    try {
      // Keep element volume at 1; gain controls loudness.
      player.volume = 1;
    } catch (e) {}
  } else {
    try {
      player.volume = volume;
    } catch (e) {}
  }

  try {
    player.muted = volume <= 0;
  } catch (e) {}
};

const readEffectiveVolume = () => {
  if (audioGain && typeof audioGain.gain?.value === "number") {
    return audioGain.gain.value;
  }
  return Number.isFinite(player?.volume) ? player.volume : 1;
};

const showLoading = () => {
  if (!playerLoading) return;
  if (!player || player.hidden) return;
  playerLoading.hidden = false;
};

const hideLoading = () => {
  if (!playerLoading) return;
  playerLoading.hidden = true;
};

const encodePath = (path) =>
  String(path || "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

const stripExtension = (name) => {
  const value = String(name || "");
  const index = value.lastIndexOf(".");
  return index > 0 ? value.slice(0, index) : value;
};

const getDisplayName = (video) => stripExtension(video?.name || video?.path || "");

const isVideoWatched = (video) =>
  Boolean(video?.watched) ||
  Number(video?.position_seconds || 0) >= MIN_SAVE_SECONDS;

const normalizeMediaPath = (value) =>
  String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");

const folderPathForVideo = (video) => {
  const path = normalizeMediaPath(video?.path || video?.play_path || "");
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
};

const createFolderNode = ({ key = "", name = "", parentKey = null } = {}) => ({
  key,
  name,
  path: key,
  parentKey,
  count: 0,
  folders: new Map(),
  videos: [],
});

const markLocalWatched = (videoPath) => {
  if (!videoPath) return;
  let changed = false;
  videos = videos.map((video) => {
    const playbackPath = video.play_path || video.path;
    if (playbackPath !== videoPath && video.path !== videoPath) return video;
    if (isVideoWatched(video)) return video;
    changed = true;
    return { ...video, watched: true, position_seconds: MIN_SAVE_SECONDS };
  });
  if (changed) {
    updateLibraryChrome();
    renderLibrary();
  }
};

const showError = (message) => {
  if (!errorBox) return;
  errorBox.textContent = message;
  errorBox.hidden = false;
};

const clearError = () => {
  if (!errorBox) return;
  errorBox.textContent = "";
  errorBox.hidden = true;
};

const setEmptyState = () => {
  clearError();
  if (list) {
    list.textContent = "";
    list.hidden = true;
  }
  if (player) {
    player.pause();
    player.hidden = true;
    player.removeAttribute("src");
    player.load();
  }
  hideLoading();
  if (playerUi) {
    playerUi.hidden = true;
    showPlayerUiChrome();
  }
  if (uiHideTimer) {
    window.clearTimeout(uiHideTimer);
    uiHideTimer = null;
  }
};

const isFullscreen = () =>
  document.fullscreenElement ||
  document.webkitFullscreenElement ||
  document.mozFullScreenElement ||
  document.msFullscreenElement;

const isIPadLike = () => {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  return /iPad/.test(ua) || (platform === "MacIntel" && navigator.maxTouchPoints > 1);
};

const isIPhoneLike = () => {
  const ua = navigator.userAgent || "";
  return /iPhone|iPod/.test(ua);
};

const requestNativeVideoFullscreen = () => {
  if (!player) return false;

  // Inline playback blocks native iOS fullscreen behavior.
  try {
    player.removeAttribute("playsinline");
    player.removeAttribute("webkit-playsinline");
    player.playsInline = false;
  } catch (e) {}

  try {
    if (typeof player.webkitSetPresentationMode === "function") {
      player.webkitSetPresentationMode("fullscreen");
      if (player.webkitPresentationMode === "fullscreen") {
        return true;
      }
    }
  } catch (e) {}

  try {
    if (typeof player.webkitEnterFullscreen === "function") {
      player.webkitEnterFullscreen();
      return true;
    }
  } catch (e) {}

  try {
    if (typeof player.webkitEnterFullScreen === "function") {
      player.webkitEnterFullScreen();
      return true;
    }
  } catch (e) {}

  return false;
};

const configurePlaybackUi = ({ ipadLike }) => {
  if (!player) return;

  if (ipadLike) {
    player.controls = false;
    if (playerUi) playerUi.hidden = false;
    showPlayerUiChrome();
    try {
      player.disablePictureInPicture = true;
      player.setAttribute("disablepictureinpicture", "");
    } catch (e) {}
    try {
      player.disableRemotePlayback = true;
    } catch (e) {}
  } else {
    player.controls = true;
    if (playerUi) playerUi.hidden = true;
    try {
      player.disablePictureInPicture = false;
      player.removeAttribute("disablepictureinpicture");
    } catch (e) {}
  }

  // Always keep volume control in sync (even if the UI is hidden).
  try {
    const stored = localStorage.getItem(VOLUME_STORAGE_KEY);
    const storedNum = stored == null ? NaN : Number(stored);
    const volume = Number.isFinite(storedNum) ? Math.max(0, Math.min(1, storedNum)) : 1;
    applyVolume(volume);
    if (playerVolume) {
      playerVolume.value = String(Math.round(volume * 100));
    }
  } catch (e) {}

  if (ipadLike) {
    scheduleUiAutoHide();
  }
};

const formatTime = (seconds) => {
  const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const total = Math.floor(value);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
};

const updateCustomUi = () => {
  if (!playerUi || playerUi.hidden) return;
  if (!player || player.hidden) return;

  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  const currentTime = Number.isFinite(player.currentTime) ? player.currentTime : 0;

  if (playerToggle) {
    // Keep source ASCII-only: use entities via innerHTML.
    playerToggle.innerHTML = player.paused ? "&#9658;" : "&#10074;&#10074;";
    playerToggle.setAttribute("aria-label", player.paused ? "Play" : "Pause");
  }
  if (playerSeek) {
    if (duration > 0) {
      if (!uiScrubbing) {
        const ratio = Math.max(0, Math.min(1, currentTime / duration));
        playerSeek.value = String(Math.round(ratio * 1000));
      }
      playerSeek.disabled = false;
    } else {
      playerSeek.value = "0";
      playerSeek.disabled = true;
    }
  }
  if (playerVolume) {
    const volume = readEffectiveVolume();
    playerVolume.value = String(Math.round(Math.max(0, Math.min(1, volume)) * 100));
  }
  if (playerTime) {
    playerTime.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
  }
};

const requestBestFullscreen = () => {
  if (!player) return false;
  if (isFullscreen()) return true;

  const ipadLike = isIPadLike();
  const iphoneLike = isIPhoneLike();

  // On iPadOS Safari, Web Fullscreen API can hide browser chrome.
  if (ipadLike) {
    try {
      const root = document.documentElement;
      if (root && typeof root.requestFullscreen === "function") {
        const requestPromise = root.requestFullscreen();
        if (requestPromise && typeof requestPromise.catch === "function") {
          requestPromise.catch(() => {});
        }
        return true;
      }
    } catch (e) {}

    try {
      const root = document.documentElement;
      if (root && typeof root.webkitRequestFullscreen === "function") {
        root.webkitRequestFullscreen();
        return true;
      }
    } catch (e) {}
    return false;
  }

  if (iphoneLike) {
    return requestNativeVideoFullscreen();
  }

  // Prefer native video fullscreen when available.
  if (requestNativeVideoFullscreen()) return true;

  // iPhone Safari doesn't support reliable element fullscreen; iPad we already tried above.
  if (!iphoneLike && !ipadLike) {
    try {
      if (typeof player.requestFullscreen === "function") {
        const requestPromise = player.requestFullscreen();
        if (requestPromise && typeof requestPromise.catch === "function") {
          requestPromise.catch(() => {});
        }
        return true;
      }
    } catch (e) {}

    try {
      const root = document.documentElement;
      if (root && typeof root.requestFullscreen === "function") {
        const requestPromise = root.requestFullscreen();
        if (requestPromise && typeof requestPromise.catch === "function") {
          requestPromise.catch(() => {});
        }
        return true;
      }
    } catch (e) {}
  }

  try {
    if (typeof player.webkitRequestFullscreen === "function") {
      player.webkitRequestFullscreen();
      return true;
    }
  } catch (e) {}

  try {
    const root = document.documentElement;
    if (root && typeof root.webkitRequestFullscreen === "function") {
      root.webkitRequestFullscreen();
      return true;
    }
  } catch (e) {}

  return false;
};

const closePlayer = () => {
  if (!player) return;
  player.pause();
  player.hidden = true;
  player.removeAttribute("src");
  player.load();
  document.body.style.overflow = "";
  currentVideoPath = null;
  if (playerUi) playerUi.hidden = true;
  showPlayerUiChrome();
  hideLoading();
  if (uiHideTimer) {
    window.clearTimeout(uiHideTimer);
    uiHideTimer = null;
  }

  try {
    if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
      document.exitFullscreen();
    }
  } catch (e) {}
};

const savePosition = async ({ clear = false } = {}) => {
  if (!currentVideoPath) return;
  if (!player) return;

  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  const currentTime = Number.isFinite(player.currentTime) ? player.currentTime : 0;

  if (!clear) {
    if (currentTime < MIN_SAVE_SECONDS) return;
    if (duration && duration - currentTime < END_CLEAR_THRESHOLD_SECONDS) {
      clear = true;
    }
  }

  const shouldMarkWatched = clear || currentTime >= MIN_SAVE_SECONDS;
  const payload = clear
    ? { device: deviceId, path: currentVideoPath, clear: true, watched: true }
    : {
        device: deviceId,
        path: currentVideoPath,
        seconds: currentTime,
        watched: shouldMarkWatched,
      };

  try {
    if (shouldMarkWatched) {
      markLocalWatched(currentVideoPath);
    }
    await fetch("/api/position", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      keepalive: true,
    });
  } catch (e) {
    // Best-effort only.
  }
};

const restorePosition = async (videoPath) => {
  try {
    const response = await fetch(
      `/api/position?device=${encodeURIComponent(deviceId)}&path=${encodeURIComponent(
        videoPath
      )}`,
      { cache: "no-store" }
    );
    const data = await response.json();
    if (!response.ok || data.error) return 0;
    const seconds = Number(data.seconds);
    return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  } catch (e) {
    return 0;
  }
};

const openPlayer = (video) => {
  if (!player) return;
  const playbackPath = video.play_path || video.path;
  if (!playbackPath) return;
  playbackSession += 1;
  const session = playbackSession;
  const ipadLike = isIPadLike();

  clearError();
  currentVideoPath = playbackPath;
  player.hidden = false;
  document.body.style.overflow = "hidden";
  showLoading();
  player.src = `/media/${encodePath(playbackPath)}?playback=${Date.now()}`;
  player.preload = "auto";

  // Avoid "double overlays" on iPadOS: use inline video + Web Fullscreen.
  if (ipadLike) {
    try {
      player.playsInline = true;
      player.setAttribute("playsinline", "");
      player.setAttribute("webkit-playsinline", "");
    } catch (e) {}
  } else {
    try {
      player.playsInline = false;
      player.removeAttribute("playsinline");
      player.removeAttribute("webkit-playsinline");
    } catch (e) {}
  }

  configurePlaybackUi({ ipadLike });

  player.load();

  // Restore saved position after metadata is loaded (so duration/currentTime work reliably).
  player.addEventListener(
    "loadedmetadata",
    async () => {
      if (session !== playbackSession || currentVideoPath !== playbackPath) return;
      const saved = await restorePosition(playbackPath);
      if (!saved || saved < MIN_SAVE_SECONDS) return;
      const duration = Number.isFinite(player.duration) ? player.duration : 0;
      if (duration && duration - saved < END_CLEAR_THRESHOLD_SECONDS) return;
      try {
        player.currentTime = saved;
      } catch (e) {}
      updateCustomUi();
    },
    { once: true }
  );

  updateCustomUi();

  // For iPad, request fullscreen before play() to maximize "user gesture" reliability.
  let fullscreenEntered = ipadLike ? requestBestFullscreen() : false;
  if (ipadLike) {
    bumpUiActivity();
    // Prepare WebAudio volume in the same user gesture if possible.
    ensureWebAudioVolume();
  }

  // Must be triggered from the click gesture; some browsers will ignore otherwise.
  let playPromise = null;
  try {
    playPromise = player.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {});
    }
  } catch (e) {}

  if (ipadLike) {
    scheduleUiAutoHide();
  }

  if (!fullscreenEntered) {
    fullscreenEntered = requestBestFullscreen() || fullscreenEntered;
  }

  if (!fullscreenEntered) {
    const retryFullscreen = () => {
      if (isFullscreen()) return;
      fullscreenEntered = requestBestFullscreen() || fullscreenEntered;
    };
    player.addEventListener("playing", retryFullscreen, { once: true });
    player.addEventListener("canplay", retryFullscreen, { once: true });
    player.addEventListener("loadeddata", retryFullscreen, { once: true });
    window.setTimeout(retryFullscreen, 150);

    try {
      if (playPromise && typeof playPromise.then === "function") {
        playPromise.then(retryFullscreen).catch(() => {});
      }
    } catch (e) {}
  }
};

const createVideoCard = (video) => {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "row";
  if (isVideoWatched(video)) {
    card.dataset.state = "watched";
  }

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  const img = new Image();
  img.loading = "lazy";
  img.alt = "";
  img.src = `/thumb/${encodePath(video.path)}`;
  img.addEventListener("error", () => {
    img.remove();
  });
  thumb.appendChild(img);
  card.appendChild(thumb);

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = getDisplayName(video);
  card.appendChild(title);

  card.addEventListener("click", () => {
    openPlayer(video);
  });

  return card;
};

const buildFolderTree = (tabVideos) => {
  const root = createFolderNode();

  tabVideos.forEach((video) => {
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

const findFolderNode = (root, key) => {
  if (!key) return root;
  const parts = normalizeMediaPath(key).split("/").filter(Boolean);
  let node = root;
  let currentKey = "";
  for (const name of parts) {
    currentKey = currentKey ? `${currentKey}/${name}` : name;
    node = node.folders.get(currentKey);
    if (!node) return null;
  }
  return node;
};

const folderNodeEntries = (node) => {
  const folderEntries = Array.from(node.folders.values())
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    )
    .map((group) => ({ type: "folder", group }));

  const videoEntries = node.videos.map((video) => ({ type: "video", video }));
  return folderEntries.concat(videoEntries);
};

const createFolderCard = (group) => {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "folder-card";

  const tab = document.createElement("span");
  tab.className = "folder-card__tab";
  card.appendChild(tab);

  const body = document.createElement("span");
  body.className = "folder-card__body";

  const label = document.createElement("span");
  label.className = "folder-card__label";
  label.textContent = group.name;

  const count = document.createElement("span");
  count.className = "folder-card__count";
  count.textContent =
    group.path && group.path !== group.name
      ? `${group.path} · ${group.count} видео`
      : `${group.count} видео`;

  body.appendChild(label);
  body.appendChild(count);
  card.appendChild(body);

  card.addEventListener("click", () => {
    openFolderKey = group.key;
    renderLibrary();
  });

  return card;
};

const renderFolderEntries = (container, entries) => {
  entries.forEach((entry) => {
    if (entry.type === "video") {
      container.appendChild(createVideoCard(entry.video));
      return;
    }
    container.appendChild(createFolderCard(entry.group));
  });
};

const createFolderPanel = (group) => {
  const panel = document.createElement("section");
  panel.className = "folder-panel";
  panel.setAttribute("aria-label", `Папка ${group.path || group.name}`);

  const header = document.createElement("div");
  header.className = "folder-panel__header";

  const titleWrap = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = group.name;
  const meta = document.createElement("p");
  meta.textContent =
    group.path && group.path !== group.name
      ? `${group.path} · ${group.count} видео`
      : `${group.count} видео`;
  titleWrap.appendChild(title);
  titleWrap.appendChild(meta);

  const closeButton = document.createElement("button");
  closeButton.className = "folder-close";
  closeButton.type = "button";
  closeButton.textContent = group.parentKey ? "Назад" : "Закрыть";
  closeButton.addEventListener("click", () => {
    openFolderKey = group.parentKey || null;
    renderLibrary();
  });

  header.appendChild(titleWrap);
  header.appendChild(closeButton);
  panel.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "folder-panel__grid";
  renderFolderEntries(grid, folderNodeEntries(group));
  panel.appendChild(grid);

  return panel;
};

const updateLibraryChrome = () => {
  const watchedTotal = videos.filter(isVideoWatched).length;
  const newTotal = Math.max(0, videos.length - watchedTotal);

  if (newCount) newCount.textContent = String(newTotal);
  if (watchedCount) watchedCount.textContent = String(watchedTotal);
  if (librarySummary) {
    librarySummary.textContent = videos.length
      ? `${videos.length} подготовленных видео`
      : "Подготовленных видео пока нет";
  }

  tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === activeTab;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });
};

const renderVideos = (tabVideos) => {
  if (!list) return;
  list.textContent = "";
  list.hidden = false;

  if (!tabVideos.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent =
      activeTab === "watched"
        ? "Просмотренных видео пока нет."
        : "Новых видео пока нет.";
    list.appendChild(empty);
    openFolderKey = null;
    return;
  }

  const tree = buildFolderTree(tabVideos);
  let currentFolder = openFolderKey ? findFolderNode(tree, openFolderKey) : null;
  if (openFolderKey && !currentFolder) {
    openFolderKey = null;
    currentFolder = null;
  }

  if (currentFolder) {
    list.appendChild(createFolderPanel(currentFolder));
    return;
  }

  renderFolderEntries(list, folderNodeEntries(tree));
};

const renderLibrary = () => {
  updateLibraryChrome();
  const tabVideos = videos.filter((video) =>
    activeTab === "watched" ? isVideoWatched(video) : !isVideoWatched(video)
  );
  renderVideos(tabVideos);
};

const setActiveTab = (tab) => {
  activeTab = tab === "watched" ? "watched" : "new";
  openFolderKey = null;
  try {
    localStorage.setItem(TAB_STORAGE_KEY, activeTab);
  } catch (e) {}
  renderLibrary();
};

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setActiveTab(button.dataset.tab);
  });
});

const loadVideos = async () => {
  setEmptyState();
  updateLibraryChrome();

  try {
    const response = await fetch(
      `/api/browse?device=${encodeURIComponent(deviceId)}`,
      { cache: "no-store" }
    );
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || "Unable to load videos.");
    }

    videos = (data.items || []).filter(
      (item) => item.type === "video" && item.can_play
    );
    renderLibrary();
  } catch (error) {
    videos = [];
    setEmptyState();
    updateLibraryChrome();
    showError(error.message || "Unable to load media library.");
  }
};

window.addEventListener("load", loadVideos);

if (player) {
  // Loading indicator: show when buffering/loading, hide once frames are available.
  player.addEventListener("loadstart", showLoading);
  player.addEventListener("waiting", showLoading);
  player.addEventListener("stalled", showLoading);
  player.addEventListener("seeking", showLoading);
  // Safari can resume after seek without firing playing/canplay reliably.
  player.addEventListener("seeked", hideLoading);
  player.addEventListener("canplay", hideLoading);
  player.addEventListener("loadeddata", hideLoading);
  player.addEventListener("playing", hideLoading);
  player.addEventListener("canplaythrough", hideLoading);
  player.addEventListener("error", hideLoading);
  player.addEventListener("timeupdate", () => {
    // If playback is progressing, make sure the spinner isn't stuck.
    try {
      if (!player.seeking && (player.readyState || 0) >= 2) {
        hideLoading();
      }
    } catch (e) {}
  });

  if (playerToggle) {
    playerToggle.addEventListener("click", () => {
      if (!player) return;
      ensureWebAudioVolume();
      try {
        if (player.paused) {
          const p = player.play();
          if (p && typeof p.catch === "function") p.catch(() => {});
        } else {
          player.pause();
        }
      } catch (e) {}
      bumpUiActivity();
      updateCustomUi();
    });
  }

  if (playerSeek) {
    const seekFromUi = () => {
      const duration = Number.isFinite(player.duration) ? player.duration : 0;
      if (!(duration > 0)) return;
      const raw = Number(playerSeek.value);
      const ratio = Number.isFinite(raw) ? Math.max(0, Math.min(1000, raw)) / 1000 : 0;
      try {
        player.currentTime = ratio * duration;
      } catch (e) {}
      updateCustomUi();
    };

    playerSeek.addEventListener("input", () => {
      uiScrubbing = true;
      bumpUiActivity();
      seekFromUi();
    });
    playerSeek.addEventListener("change", () => {
      seekFromUi();
      uiScrubbing = false;
      bumpUiActivity();
    });
  }

  if (playerVolume) {
    const setVolumeFromUi = () => {
      const raw = Number(playerVolume.value);
      const ratio = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) / 100 : 1;
      ensureWebAudioVolume();
      applyVolume(ratio);
      try {
        localStorage.setItem(VOLUME_STORAGE_KEY, String(ratio));
      } catch (e) {}
      bumpUiActivity();
      updateCustomUi();
    };

    playerVolume.addEventListener("input", setVolumeFromUi);
    playerVolume.addEventListener("change", setVolumeFromUi);
  }

  // Tap video to re-show controls on iPad.
  const onVideoTap = () => {
    if (!isIPadLike()) return;
    if (!playerUi || playerUi.hidden) return;
    bumpUiActivity();
  };
  player.addEventListener("click", onVideoTap);
  player.addEventListener("touchstart", onVideoTap, { passive: true });

  player.addEventListener("loadedmetadata", updateCustomUi);
  player.addEventListener("durationchange", updateCustomUi);
  player.addEventListener("timeupdate", updateCustomUi);
  player.addEventListener("play", updateCustomUi);
  player.addEventListener("pause", updateCustomUi);
  player.addEventListener("volumechange", updateCustomUi);

  player.addEventListener("play", scheduleUiAutoHide);
  player.addEventListener("pause", () => {
    if (isIPadLike()) showPlayerUiChrome();
  });

  player.addEventListener("ended", () => {
    savePosition({ clear: true });
    closePlayer();
  });
  player.addEventListener("webkitendfullscreen", closePlayer);
  document.addEventListener("fullscreenchange", () => {
    if (!isFullscreen() && !player.hidden) {
      closePlayer();
    }
  });

  player.addEventListener("pause", () => {
    savePosition();
  });

  player.addEventListener("timeupdate", () => {
    const now = Date.now();
    if (now - lastSavedAt < SAVE_INTERVAL_MS) return;
    lastSavedAt = now;
    savePosition();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      savePosition();
    }
    if (document.visibilityState === "visible") {
      scheduleUiAutoHide();
    }
  });

  window.addEventListener("beforeunload", () => {
    savePosition();
  });
}
