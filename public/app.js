(() => {
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  const browseBtn = document.getElementById("browseBtn");
  const progressPanel = document.getElementById("progressPanel");
  const progressName = document.getElementById("progressName");
  const progressPct = document.getElementById("progressPct");
  const progressBar = document.getElementById("progressBar");
  const errorPanel = document.getElementById("errorPanel");
  const errorText = document.getElementById("errorText");
  const errorDismiss = document.getElementById("errorDismiss");
  const fileList = document.getElementById("fileList");
  const emptyState = document.getElementById("emptyState");
  const emptyTitle = document.getElementById("emptyTitle");
  const emptyHint = document.getElementById("emptyHint");
  const fileCount = document.getElementById("fileCount");
  const refreshBtn = document.getElementById("refreshBtn");
  const statusLine = document.getElementById("statusLine");
  const pageUrl = document.getElementById("pageUrl");
  const viewer = document.getElementById("viewer");
  const viewerBody = document.getElementById("viewerBody");
  const viewerTitle = document.getElementById("viewerTitle");
  const viewerClose = document.getElementById("viewerClose");
  const viewerSave = document.getElementById("viewerSave");
  const viewerHint = document.getElementById("viewerHint");
  const noteInput = document.getElementById("noteInput");
  const noteCopy = document.getElementById("noteCopy");
  const noteClear = document.getElementById("noteClear");
  const noteStatus = document.getElementById("noteStatus");
  const noteCount = document.getElementById("noteCount");
  const tagline = document.getElementById("tagline");
  const dropHint = document.getElementById("dropHint");

  const POLL_MS = 3000;
  const NOTE_SAVE_MS = 450;
  let pollTimer = null;
  let knownIds = new Set();
  let hasLoadedOnce = false;
  let loadInFlight = false;
  let filesById = {};
  let lastListKey = null;
  // Phone save state: the share sheet needs the whole file in memory first
  let saveProgress = {}; // id -> percent while downloading
  let preparedFile = null; // { id, file } kept so a second tap shares instantly
  let activeViewerFile = null;
  let noteDirty = false;
  let noteSaving = false;
  let noteTimer = null;
  let noteRetryTimer = null;
  let lastNoteUpdatedAt = 0;
  let lastSavedText = "";
  let maxNoteChars = 20000;

  if (pageUrl) pageUrl.textContent = location.origin + "/";

  var qrImg = document.getElementById("qrImg");
  if (qrImg) {
    qrImg.addEventListener("error", function () {
      var card = qrImg.closest(".qr-card");
      if (card) card.classList.add("hidden");
    });
  }

  function show(el) {
    el.classList.remove("hidden");
  }

  function hide(el) {
    el.classList.add("hidden");
  }

  function showError(msg) {
    errorText.textContent = msg;
    show(errorPanel);
  }

  function setStatus(text, kind) {
    statusLine.textContent = text;
    statusLine.classList.remove("ok", "bad");
    if (kind) statusLine.classList.add(kind);
  }

  function setNoteStatus(text, kind) {
    noteStatus.textContent = text;
    noteStatus.classList.remove("ok", "bad", "busy");
    if (kind) noteStatus.classList.add(kind);
  }

  function updateNoteCount() {
    var n = noteInput.value.length;
    noteCount.textContent = n ? n.toLocaleString() : "";
  }

  function applyRemoteNote(note) {
    if (!note) return;
    if (typeof note.maxChars === "number" && note.maxChars > 0) {
      maxNoteChars = note.maxChars;
      noteInput.maxLength = maxNoteChars;
    }
    if (noteDirty || noteSaving) return;
    var text = typeof note.text === "string" ? note.text : "";
    var remoteAt = note.updatedAt || 0;
    if (remoteAt < lastNoteUpdatedAt) return;
    if (remoteAt === lastNoteUpdatedAt && noteInput.value === text) return;
    if (noteInput.value === text) {
      lastNoteUpdatedAt = remoteAt;
      lastSavedText = text;
      return;
    }
    noteInput.value = text;
    lastNoteUpdatedAt = remoteAt;
    lastSavedText = text;
    updateNoteCount();
    setNoteStatus(
      text ? "Saved · live on every device" : "Shared · live on every device",
      text ? "ok" : null
    );
  }

  function scheduleNoteRetry() {
    if (noteRetryTimer) return;
    noteRetryTimer = setTimeout(function () {
      noteRetryTimer = null;
      if (noteDirty) saveNote();
    }, 2000);
  }

  function scheduleNoteSave() {
    noteDirty = true;
    setNoteStatus("Typing…", "busy");
    updateNoteCount();
    if (noteTimer) clearTimeout(noteTimer);
    if (noteRetryTimer) {
      clearTimeout(noteRetryTimer);
      noteRetryTimer = null;
    }
    noteTimer = setTimeout(saveNote, NOTE_SAVE_MS);
  }

  function noteBody(text) {
    if (text.length > maxNoteChars) {
      text = text.slice(0, maxNoteChars);
      if (noteInput.value !== text) {
        noteInput.value = text;
        updateNoteCount();
      }
    }
    return text;
  }

  function flushNoteKeepalive() {
    if (noteTimer) clearTimeout(noteTimer);
    var text = noteBody(noteInput.value);
    if (!noteDirty && text === lastSavedText) return;
    try {
      fetch("/api/note", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        keepalive: true,
        body: JSON.stringify({ text: text }),
      });
    } catch (e) {}
  }

  async function saveNote() {
    if (noteSaving) return;
    var text = noteBody(noteInput.value);
    if (text === lastSavedText && !noteDirty) return;
    noteSaving = true;
    noteDirty = false;
    var retryAfter = false;
    setNoteStatus("Saving…", "busy");
    try {
      var res = await fetch("/api/note", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        body: JSON.stringify({ text: text }),
      });
      var data = {};
      try {
        data = await res.json();
      } catch (e) {}
      if (!res.ok) {
        noteDirty = true;
        setNoteStatus((data && data.error) || "Save failed", "bad");
        scheduleNoteRetry();
        return;
      }
      if (noteRetryTimer) {
        clearTimeout(noteRetryTimer);
        noteRetryTimer = null;
      }
      lastNoteUpdatedAt = Math.max(lastNoteUpdatedAt, data.updatedAt || Date.now());
      lastSavedText = typeof data.text === "string" ? data.text : text;
      if (noteInput.value !== lastSavedText) {
        noteDirty = true;
        retryAfter = true;
      } else {
        noteDirty = false;
        setNoteStatus("Saved", "ok");
      }
    } catch (e) {
      noteDirty = true;
      setNoteStatus("Save failed — check connection", "bad");
      scheduleNoteRetry();
    } finally {
      noteSaving = false;
      if (retryAfter) {
        if (noteTimer) clearTimeout(noteTimer);
        saveNote();
      }
    }
  }

  async function copyNote() {
    var text = noteInput.value;
    if (!text) {
      setNoteStatus("Nothing to copy", "bad");
      return;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        noteInput.focus();
        noteInput.select();
        document.execCommand("copy");
        var end = noteInput.value.length;
        noteInput.setSelectionRange(end, end);
      }
      noteCopy.textContent = "Copied";
      setNoteStatus("Copied", "ok");
      setTimeout(function () {
        noteCopy.textContent = "Copy";
      }, 1200);
    } catch (e) {
      noteInput.focus();
      noteInput.select();
      setNoteStatus("Select the text and copy it", "bad");
    }
  }

  function clearNote() {
    if (!noteInput.value) return;
    if (noteInput.value.length > 80 && !window.confirm("Clear the notepad on every device?")) {
      return;
    }
    noteInput.value = "";
    updateNoteCount();
    if (noteTimer) clearTimeout(noteTimer);
    noteDirty = true;
    saveNote();
    noteInput.focus();
  }

  function formatRemaining(ms) {
    if (ms <= 0) return "Expired";
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    if (h >= 20) return h + "h left";
    if (h > 0) return h + "h " + m + "m left";
    if (m > 0) return m + "m left";
    return "<1m left";
  }

  function formatSize(n) {
    if (n >= 1024 * 1024 * 1024) return +(n / (1024 * 1024 * 1024)).toFixed(1) + "\u00a0GB";
    return Math.round(n / (1024 * 1024)) + "\u00a0MB";
  }

  function formatTtl(h) {
    if (h > 24 && h % 24 === 0) return h / 24 + " days";
    return h + (h === 1 ? " hour" : " hours");
  }

  // Server config (max size, TTL) is env-driven, so the copy follows it
  function applyLimits(data) {
    if (data.maxFileBytes > 0) {
      dropHint.textContent = "Photos, videos, anything · max " + formatSize(data.maxFileBytes);
    }
    if (data.ttlHours > 0) {
      tagline.textContent = "Same page on every device · files gone in " + formatTtl(data.ttlHours);
    }
  }

  function formatWhen(ts) {
    try {
      return new Date(ts).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch (e) {
      return "";
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  function kindIcon(kind) {
    if (kind === "video") return "🎬";
    if (kind === "audio") return "🎵";
    if (kind === "pdf") return "📕";
    return "📄";
  }

  function isMobile() {
    return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
      (navigator.maxTouchPoints > 1 && /MacIntel/.test(navigator.platform));
  }

  function canShareFiles() {
    try {
      return !!(navigator.share && navigator.canShare);
    } catch (e) {
      return false;
    }
  }

  function openPicker() {
    fileInput.click();
  }

  browseBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    openPicker();
  });

  dropzone.addEventListener("click", openPicker);
  dropzone.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPicker();
    }
  });

  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files.length) {
      uploadFiles(Array.prototype.slice.call(fileInput.files));
    }
  });

  ["dragenter", "dragover"].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove("dragover");
    });
  });

  dropzone.addEventListener("drop", function (e) {
    var files = e.dataTransfer && e.dataTransfer.files
      ? Array.prototype.slice.call(e.dataTransfer.files)
      : [];
    if (files.length) uploadFiles(files);
  });

  ["dragover", "drop"].forEach(function (evt) {
    window.addEventListener(evt, function (e) {
      e.preventDefault();
    });
  });

  errorDismiss.addEventListener("click", function () {
    hide(errorPanel);
  });
  refreshBtn.addEventListener("click", function () {
    loadFiles({ forceError: true });
  });

  viewerClose.addEventListener("click", closeViewer);
  viewer.addEventListener("click", function (e) {
    if (e.target === viewer) closeViewer();
  });
  viewerSave.addEventListener("click", function () {
    if (activeViewerFile) saveMedia(activeViewerFile);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !viewer.classList.contains("hidden")) closeViewer();
    if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S") && document.activeElement === noteInput) {
      e.preventDefault();
      if (noteTimer) clearTimeout(noteTimer);
      saveNote();
    }
  });

  noteInput.addEventListener("input", scheduleNoteSave);
  noteInput.addEventListener("blur", function () {
    if (noteTimer) clearTimeout(noteTimer);
    if (noteDirty) saveNote();
  });
  noteCopy.addEventListener("click", copyNote);
  noteClear.addEventListener("click", clearNote);

  function thumbHtml(f) {
    var raw = f.previewUrl + "?t=" + encodeURIComponent(String(f.uploadedAt));
    if (f.kind === "image") {
      return (
        '<button type="button" class="thumb thumb-btn" data-open="' + escapeAttr(f.id) + '" aria-label="Preview ' + escapeAttr(f.name) + '">' +
          '<img src="' + escapeAttr(raw) + '" alt="" loading="lazy" decoding="async" />' +
        "</button>"
      );
    }
    if (f.kind === "video") {
      return (
        '<button type="button" class="thumb thumb-btn video" data-open="' + escapeAttr(f.id) + '" aria-label="Preview ' + escapeAttr(f.name) + '">' +
          '<video src="' + escapeAttr(raw) + '#t=0.1" muted playsinline preload="metadata"></video>' +
          '<span class="play-badge">▶</span>' +
        "</button>"
      );
    }
    return (
      '<div class="thumb icon-only" aria-hidden="true">' +
        '<span class="kind-emoji">' + kindIcon(f.kind) + "</span>" +
      "</div>"
    );
  }

  function saveLabel(f) {
    if (typeof saveProgress[f.id] === "number") return "Loading " + saveProgress[f.id] + "%";
    if (preparedFile && preparedFile.id === f.id) return "Tap to save";
    return "Save to Photos";
  }

  // Repaint every Save button for this file (list row and viewer)
  function refreshSaveButtons(id) {
    var f = filesById[id] || (activeViewerFile && activeViewerFile.id === id ? activeViewerFile : null);
    if (!f) return;
    var busy = typeof saveProgress[id] === "number";
    var btns = Array.prototype.slice.call(fileList.querySelectorAll("[data-save]")).filter(function (b) {
      return b.getAttribute("data-save") === id;
    });
    if (activeViewerFile && activeViewerFile.id === id) btns.push(viewerSave);
    for (var i = 0; i < btns.length; i++) {
      btns[i].textContent = saveLabel(f);
      btns[i].disabled = busy;
    }
  }

  function primaryActionHtml(f) {
    // On phones media goes through the share sheet → Photos. Everywhere else a
    // plain link hands the file to the browser's download manager immediately.
    if (f.isMedia && isMobile()) {
      return (
        '<button type="button" class="btn primary sm" data-save="' + escapeAttr(f.id) + '"' +
          (typeof saveProgress[f.id] === "number" ? " disabled" : "") + ">" +
          escapeHtml(saveLabel(f)) +
        "</button>"
      );
    }
    return (
      '<a class="btn primary sm" href="' + escapeAttr(f.downloadUrl) + '" download="' + escapeAttr(f.name) + '">' +
        (f.isMedia ? "Save" : "Download") +
      "</a>"
    );
  }

  function renderFiles(files) {
    fileCount.textContent = String(files.length);
    filesById = {};
    for (var i = 0; i < files.length; i++) filesById[files[i].id] = files[i];

    // Rebuilding the list recreates every video thumbnail, which re-requests the
    // video from the server, so only re-render when something visible changed
    var listKey = files.map(function (f) {
      return f.id + ":" + formatRemaining(f.remainingMs);
    }).join("|");
    if (listKey === lastListKey) return;
    lastListKey = listKey;

    if (!files.length) {
      show(emptyState);
      emptyTitle.textContent = "No files yet.";
      emptyHint.textContent = "Upload from this phone or your PC — they show up here.";
      fileList.innerHTML = "";
      knownIds = new Set();
      return;
    }

    hide(emptyState);

    var nextIds = new Set();
    var html = "";
    for (var j = 0; j < files.length; j++) {
      var f = files[j];
      nextIds.add(f.id);
      var isNew = knownIds.size > 0 && !knownIds.has(f.id);
      html +=
        '<li class="file-row' + (isNew ? " is-new" : "") + '" data-id="' + escapeAttr(f.id) + '">' +
          '<div class="file-main">' +
            thumbHtml(f) +
            '<div class="file-info">' +
              '<div class="file-name truncate" title="' + escapeAttr(f.name) + '">' + escapeHtml(f.name) + "</div>" +
              '<div class="file-meta">' +
                "<span>" + escapeHtml(f.sizeLabel) + "</span>" +
                '<span class="dot">·</span>' +
                "<span>" + escapeHtml(formatWhen(f.uploadedAt)) + "</span>" +
                '<span class="dot">·</span>' +
                '<span class="ttl">' + escapeHtml(formatRemaining(f.remainingMs)) + "</span>" +
              "</div>" +
            "</div>" +
          "</div>" +
          '<div class="file-actions">' +
            primaryActionHtml(f) +
            (f.isMedia
              ? '<button type="button" class="btn ghost sm" data-open="' + escapeAttr(f.id) + '">View</button>'
              : "") +
            '<button type="button" class="btn ghost sm danger-btn" data-delete="' + escapeAttr(f.id) + '" aria-label="Delete ' + escapeAttr(f.name) + '">Delete</button>' +
          "</div>" +
        "</li>";
    }

    fileList.innerHTML = html;
    knownIds = nextIds;
    wireFileActions();
  }

  function wireFileActions() {
    var dels = fileList.querySelectorAll("[data-delete]");
    for (var i = 0; i < dels.length; i++) {
      dels[i].addEventListener("click", function (ev) {
        deleteFile(ev.currentTarget.getAttribute("data-delete"));
      });
    }
    var opens = fileList.querySelectorAll("[data-open]");
    for (var o = 0; o < opens.length; o++) {
      opens[o].addEventListener("click", function (ev) {
        var id = ev.currentTarget.getAttribute("data-open");
        if (filesById[id]) openViewer(filesById[id]);
      });
    }
    var saves = fileList.querySelectorAll("[data-save]");
    for (var s = 0; s < saves.length; s++) {
      saves[s].addEventListener("click", function (ev) {
        var id = ev.currentTarget.getAttribute("data-save");
        if (filesById[id]) saveMedia(filesById[id]);
      });
    }
  }

  function openViewer(f) {
    activeViewerFile = f;
    viewerTitle.textContent = f.name;
    viewerSave.textContent = isMobile() && f.isMedia ? saveLabel(f) : "Save";
    viewerSave.disabled = typeof saveProgress[f.id] === "number";
    viewerBody.innerHTML = "";
    var src = f.previewUrl + "?t=" + encodeURIComponent(String(f.uploadedAt));

    if (f.kind === "image") {
      var img = document.createElement("img");
      img.src = src;
      img.alt = f.name;
      // Helps iOS offer "Add to Photos" on long-press
      img.setAttribute("decoding", "async");
      viewerBody.appendChild(img);
      viewerHint.innerHTML =
        "Long-press the photo → <strong>Add to Photos</strong>, or tap Save for the share sheet.";
    } else if (f.kind === "video") {
      var video = document.createElement("video");
      video.src = src;
      video.controls = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      // Start playing straight away; the browser streams via Range requests
      video.preload = "auto";
      video.autoplay = true;
      viewerBody.appendChild(video);
      var playing = video.play();
      if (playing && playing.catch) playing.catch(function () {});
      viewerHint.innerHTML =
        "Tap Save → share sheet → <strong>Save Video</strong> / Photos. Or use the share icon in the player if shown.";
    } else {
      viewerBody.innerHTML = "<p class='muted'>No preview for this file type.</p>";
    }

    show(viewer);
    document.body.classList.add("viewer-open");
  }

  function closeViewer() {
    hide(viewer);
    viewerBody.innerHTML = "";
    activeViewerFile = null;
    document.body.classList.remove("viewer-open");
  }

  function startDownload(f) {
    var a = document.createElement("a");
    a.href = f.downloadUrl;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function shareSupported(f) {
    if (!canShareFiles()) return false;
    try {
      var probe = new File([], f.name, { type: f.contentType || "application/octet-stream" });
      return navigator.canShare({ files: [probe] });
    } catch (e) {
      return false;
    }
  }

  // Download into memory, reporting progress on the Save button
  async function fetchAsFile(f) {
    var res = await fetch(f.downloadUrl, { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) throw new Error("Could not fetch file");
    var total = Number(res.headers.get("Content-Length")) || f.size || 0;
    var type = f.contentType || "application/octet-stream";
    if (!res.body || !res.body.getReader) {
      return new File([await res.blob()], f.name, { type: type });
    }
    var reader = res.body.getReader();
    var chunks = [];
    var loaded = 0;
    for (;;) {
      var step = await reader.read();
      if (step.done) break;
      chunks.push(step.value);
      loaded += step.value.length;
      var pct = total ? Math.min(99, Math.floor((loaded / total) * 100)) : 0;
      if (pct !== saveProgress[f.id]) {
        saveProgress[f.id] = pct;
        refreshSaveButtons(f.id);
      }
    }
    // iOS is picky about HEIC/video types — use server type when present
    return new File(chunks, f.name, { type: type });
  }

  async function shareFile(f, file) {
    try {
      await navigator.share({ files: [file], title: f.name });
      preparedFile = null;
      setStatus("Shared — pick Photos / Save Image", "ok");
    } catch (err) {
      if (err && err.name === "AbortError") {
        // Sheet dismissed; keep the file so another tap reopens it instantly
        preparedFile = { id: f.id, file: file };
      } else if (err && err.name === "NotAllowedError") {
        // The tap "expired" while a big file downloaded; the next tap shares it
        preparedFile = { id: f.id, file: file };
        setStatus("Ready — tap Save again", "ok");
      } else {
        preparedFile = null;
        showError((err && err.message) || "Save failed");
      }
    }
    refreshSaveButtons(f.id);
  }

  async function saveMedia(f) {
    if (typeof saveProgress[f.id] === "number") return;

    // Desktop (or no share sheet): hand off to the browser's download manager
    if (!isMobile() || !shareSupported(f)) {
      if (isMobile() && f.isMedia && !(activeViewerFile && activeViewerFile.id === f.id)) {
        openViewer(f);
        showError("Your browser can't save straight to Photos. Long-press the media → Add to Photos.");
        return;
      }
      startDownload(f);
      return;
    }

    if (preparedFile && preparedFile.id === f.id) {
      return shareFile(f, preparedFile.file);
    }

    preparedFile = null; // free the previous file's memory
    saveProgress[f.id] = 0;
    refreshSaveButtons(f.id);
    var file;
    try {
      file = await fetchAsFile(f);
    } catch (err) {
      showError((err && err.message) || "Download failed");
      return;
    } finally {
      delete saveProgress[f.id];
      refreshSaveButtons(f.id);
    }
    await shareFile(f, file);
  }

  async function loadFiles(opts) {
    opts = opts || {};
    if (loadInFlight) return;
    loadInFlight = true;
    if (opts.forceError) refreshBtn.classList.add("spinning");

    try {
      var url = "/api/files?t=" + Date.now();
      var res = await fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });

      if (!res.ok) throw new Error("Server returned " + res.status);

      var data = await res.json();
      var files = data.files || [];
      renderFiles(files);
      applyRemoteNote(data.note);
      applyLimits(data);
      hasLoadedOnce = true;
      hide(errorPanel);
      setStatus(files.length + " file" + (files.length === 1 ? "" : "s") + " · live", "ok");
    } catch (err) {
      var msg = (err && err.message) || "Could not load files";
      setStatus("Offline / failed to load", "bad");
      lastListKey = null; // the error overlays the list, so redraw on recovery
      emptyTitle.textContent = "Can't reach the inbox";
      emptyHint.textContent = msg + " — tap Refresh. Check you're on " + location.host;
      show(emptyState);
      if (!hasLoadedOnce || opts.forceError) {
        showError(msg + ". Make sure this page is " + location.origin + "/");
      }
    } finally {
      loadInFlight = false;
      refreshBtn.classList.remove("spinning");
    }
  }

  async function deleteFile(id) {
    if (!id) return;
    try {
      var res = await fetch("/api/file/" + encodeURIComponent(id) + "?t=" + Date.now(), {
        method: "DELETE",
        cache: "no-store",
      });
      if (!res.ok) {
        var data = {};
        try {
          data = await res.json();
        } catch (e) {}
        showError(data.error || "Delete failed");
        return;
      }
      if (activeViewerFile && activeViewerFile.id === id) closeViewer();
      if (preparedFile && preparedFile.id === id) preparedFile = null;
      await loadFiles({ forceError: true });
    } catch (e) {
      showError("Network error while deleting.");
    }
  }

  function uploadFiles(files) {
    hide(errorPanel);
    show(progressPanel);

    var label = files.length === 1 ? files[0].name : files.length + " files";
    progressName.textContent = label;
    progressBar.style.width = "0%";
    progressPct.textContent = "0%";

    var form = new FormData();
    for (var i = 0; i < files.length; i++) form.append("file", files[i]);

    var xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");

    xhr.upload.addEventListener("progress", function (e) {
      if (!e.lengthComputable) return;
      var pct = Math.round((e.loaded / e.total) * 100);
      progressBar.style.width = pct + "%";
      progressPct.textContent = pct + "%";
    });

    xhr.addEventListener("load", function () {
      hide(progressPanel);
      fileInput.value = "";
      var data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (e) {
        showError("Unexpected server response.");
        return;
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        loadFiles({ forceError: true });
      } else {
        showError((data && data.error) || "Upload failed.");
      }
    });

    xhr.addEventListener("error", function () {
      hide(progressPanel);
      fileInput.value = "";
      showError("Network error. Check your connection and try again.");
    });

    xhr.send(form);
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      if (document.hidden) return;
      // Don't thrash list while viewer is open
      if (!viewer.classList.contains("hidden")) return;
      loadFiles();
    }, POLL_MS);
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (noteTimer) clearTimeout(noteTimer);
      if (noteDirty) saveNote();
      return;
    }
    if (noteDirty) saveNote();
    loadFiles({ forceError: !hasLoadedOnce });
  });

  window.addEventListener("pagehide", flushNoteKeepalive);

  loadFiles({ forceError: true });
  setTimeout(function () {
    if (!hasLoadedOnce) loadFiles({ forceError: true });
  }, 1200);
  setTimeout(function () {
    if (!hasLoadedOnce) loadFiles({ forceError: true });
  }, 3000);
  startPolling();
})();
