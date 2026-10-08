const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { nanoid } = require("nanoid");
const mime = require("mime-types");
const QRCode = require("qrcode");

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const META_PATH = path.join(DATA_DIR, "meta.json");
const TTL_HOURS = Number(process.env.TTL_HOURS) > 0 ? Number(process.env.TTL_HOURS) : 24;
const TTL_MS = TTL_HOURS * 60 * 60 * 1000;
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES) || 100 * 1024 * 1024; // 100 MB
const MAX_NOTE_CHARS = Math.min(Number(process.env.MAX_NOTE_CHARS) || 20000, 50000);
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
const DROP_PASSWORD = process.env.DROP_PASSWORD || "";
// Only these kinds are served inline; everything else is forced to download
const INLINE_KINDS = new Set(["image", "video", "audio"]);

// Ensure storage dirs exist (volume mounts can be empty on first boot)
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(META_PATH)) {
    fs.writeFileSync(META_PATH, JSON.stringify({ files: {} }, null, 2));
  }
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch (err) {
  console.error("Storage init failed:", err);
  process.exit(1);
}

function loadMeta() {
  try {
    const meta = JSON.parse(fs.readFileSync(META_PATH, "utf8"));
    if (!meta || typeof meta !== "object") return { files: {} };
    if (!meta.files || typeof meta.files !== "object") meta.files = {};
    return meta;
  } catch {
    return { files: {} };
  }
}

function saveMeta(meta) {
  const tmp = META_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, META_PATH);
}

// Own-property lookup so ids like "__proto__" or "constructor" never resolve
function getEntry(meta, id) {
  return Object.prototype.hasOwnProperty.call(meta.files, id) ? meta.files[id] : null;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function isExpired(entry) {
  return Date.now() >= entry.expiresAt;
}

function deleteFile(id, meta) {
  const entry = meta.files[id];
  if (!entry) return false;
  const filePath = path.join(UPLOAD_DIR, entry.storedName);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error(`Failed to delete file ${id}:`, err.message);
  }
  delete meta.files[id];
  return true;
}

function mediaKind(contentType, name) {
  const ct = (contentType || "").toLowerCase();
  const ext = path.extname(name || "").toLowerCase();
  if (ct.startsWith("image/") || [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".bmp"].includes(ext)) {
    return "image";
  }
  if (ct.startsWith("video/") || [".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"].includes(ext)) {
    return "video";
  }
  if (ct.startsWith("audio/") || [".mp3", ".m4a", ".wav", ".aac", ".ogg"].includes(ext)) {
    return "audio";
  }
  if (ct === "application/pdf" || ext === ".pdf") return "pdf";
  return "file";
}

// Phones and scripts often upload as application/octet-stream; with nosniff that
// stops browsers treating the file as video, so fall back to the extension.
function effectiveType(contentType, name) {
  const ct = (contentType || "").toLowerCase();
  if (ct && ct !== "application/octet-stream") return contentType;
  return mime.lookup(name || "") || "application/octet-stream";
}

function publicNote(meta) {
  const n = meta && meta.note;
  const text = n && typeof n.text === "string" ? n.text : "";
  const updatedAt = n && typeof n.updatedAt === "number" ? n.updatedAt : 0;
  return { text, updatedAt, maxChars: MAX_NOTE_CHARS };
}

function publicFile(entry) {
  const remainingMs = Math.max(0, entry.expiresAt - Date.now());
  const contentType = effectiveType(entry.contentType, entry.originalName);
  const kind = mediaKind(contentType, entry.originalName);
  const isMedia = kind === "image" || kind === "video";
  return {
    id: entry.id,
    name: entry.originalName,
    size: entry.size,
    sizeLabel: formatBytes(entry.size),
    contentType,
    kind,
    isMedia,
    uploadedAt: entry.uploadedAt,
    expiresAt: entry.expiresAt,
    remainingMs,
    // inline = open in browser / preview / Photos-friendly
    previewUrl: `/api/raw/${entry.id}`,
    downloadUrl: `/api/download/${entry.id}`,
  };
}

function resolveEntry(id) {
  const meta = loadMeta();
  const entry = getEntry(meta, id);
  if (!entry) return { error: "File not found or expired", status: 404, meta };
  if (isExpired(entry)) {
    deleteFile(entry.id, meta);
    saveMeta(meta);
    return { error: "File expired", status: 410, meta };
  }
  const filePath = path.join(UPLOAD_DIR, entry.storedName);
  if (!fs.existsSync(filePath)) {
    deleteFile(entry.id, meta);
    saveMeta(meta);
    return { error: "File missing from storage", status: 404, meta };
  }
  return { entry, filePath, meta };
}

function streamFile(res, entry, disposition) {
  const filename = entry.originalName;
  res.setHeader(
    "Content-Disposition",
    `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.setHeader("Content-Type", effectiveType(entry.contentType, filename));
  res.setHeader("Cache-Control", "private, max-age=60");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Uploaded HTML/SVG opened directly must never run script on this origin
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  // sendFile handles Range requests, which iOS Safari needs to play video
  res.sendFile(entry.storedName, { root: UPLOAD_DIR, cacheControl: false }, (err) => {
    if (err && !res.headersSent) {
      res.status(err.status || 500).json({ error: "Could not read file" });
    }
  });
}

function listActiveFiles() {
  const meta = loadMeta();
  let dirty = false;
  const files = [];

  for (const [id, entry] of Object.entries(meta.files)) {
    if (isExpired(entry)) {
      deleteFile(id, meta);
      dirty = true;
      continue;
    }
    files.push(publicFile(entry));
  }

  if (dirty) saveMeta(meta);

  files.sort((a, b) => b.uploadedAt - a.uploadedAt);
  return files;
}

function cleanupExpired() {
  const meta = loadMeta();
  let removed = 0;
  for (const [id, entry] of Object.entries(meta.files)) {
    if (isExpired(entry)) {
      deleteFile(id, meta);
      removed++;
    }
  }
  try {
    const known = new Set(Object.values(meta.files).map((e) => e.storedName));
    for (const name of fs.readdirSync(UPLOAD_DIR)) {
      if (!known.has(name)) {
        fs.unlinkSync(path.join(UPLOAD_DIR, name));
        removed++;
      }
    }
  } catch (err) {
    console.error("Orphan cleanup error:", err.message);
  }
  if (removed > 0) {
    saveMeta(meta);
    console.log(`Cleanup: removed ${removed} expired/orphan item(s)`);
  }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).replace(/[^A-Za-z0-9.]/g, "").slice(0, 32);
    cb(null, `${nanoid(16)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: 10 },
  fileFilter: (_req, file, cb) => {
    if (!file.originalname || file.originalname.length > 255) {
      return cb(new Error("Invalid filename"));
    }
    cb(null, true);
  },
});

function passwordMatches(req) {
  const [scheme, encoded] = String(req.get("authorization") || "").split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const supplied = decoded.slice(decoded.indexOf(":") + 1); // username is ignored
  const a = crypto.createHash("sha256").update(supplied).digest();
  const b = crypto.createHash("sha256").update(DROP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

const app = express();
app.set("trust proxy", 1);

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Optional shared password (HTTP Basic auth). Everything except /health is behind it.
if (DROP_PASSWORD) {
  app.use((req, res, next) => {
    if (passwordMatches(req)) return next();
    res.setHeader("WWW-Authenticate", 'Basic realm="Drop", charset="UTF-8"');
    res.status(401).type("text/plain").send("Password required");
  });
}

app.use(express.json({ limit: "128kb" }));

// Don't cache the app shell so phones pick up UI updates immediately
app.use(
  express.static(path.join(__dirname, "public"), {
    maxAge: 0,
    etag: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html") || filePath.endsWith(".js") || filePath.endsWith(".css")) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  })
);

function requestOrigin(req) {
  const proto = req.protocol === "https" ? "https" : req.protocol === "http" ? "http" : "";
  const host = String(req.get("host") || "").trim();
  if (!proto) return "";
  if (!/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host)) return "";
  return proto + "://" + host;
}

// Phone-camera QR for the current origin. Generated here so the URL never leaves this box.
app.get("/qr.svg", async (req, res) => {
  const origin = requestOrigin(req);
  if (!origin) {
    return res.status(400).type("text/plain").send("Invalid origin");
  }
  try {
    const svg = await QRCode.toString(origin + "/", {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      width: 256,
      color: { dark: "#0c0f14", light: "#ffffff" },
    });
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("Vary", "Host");
    res.type("image/svg+xml").send(svg);
  } catch (err) {
    console.error("QR generation failed:", err.message);
    res.status(500).type("text/plain").send("QR failed");
  }
});

// Shared inbox — every device sees the same list
app.get("/api/files", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  const files = listActiveFiles();
  const meta = loadMeta();
  res.json({
    files,
    count: files.length,
    note: publicNote(meta),
    maxFileBytes: MAX_FILE_BYTES,
    ttlHours: TTL_HOURS,
    serverTime: Date.now(),
  });
});

app.get("/api/note", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.json(publicNote(loadMeta()));
});

app.put("/api/note", (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  const text = req.body && typeof req.body.text === "string" ? req.body.text : null;
  if (text === null) {
    return res.status(400).json({ error: "text is required" });
  }
  if (text.length > MAX_NOTE_CHARS) {
    return res.status(400).json({
      error: `Note too long. Max ${MAX_NOTE_CHARS.toLocaleString()} characters.`,
    });
  }

  const meta = loadMeta();
  meta.note = { text, updatedAt: Date.now() };
  saveMeta(meta);
  res.json(publicNote(meta));
});

app.post("/api/upload", (req, res) => {
  // Accept one or many files under field name "file"
  upload.array("file", 10)(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          error: `File too large. Max ${formatBytes(MAX_FILE_BYTES)}.`,
        });
      }
      if (err.code === "LIMIT_FILE_COUNT") {
        return res.status(400).json({ error: "Too many files (max 10 at once)." });
      }
      return res.status(400).json({ error: err.message });
    }
    if (err) {
      return res.status(400).json({ error: err.message || "Upload failed" });
    }

    const incoming = req.files && req.files.length ? req.files : req.file ? [req.file] : [];
    if (!incoming.length) {
      return res.status(400).json({ error: "No file provided" });
    }

    const meta = loadMeta();
    const now = Date.now();
    const created = [];

    for (const f of incoming) {
      const id = nanoid(10);
      const originalName = path.basename(f.originalname);
      const contentType = effectiveType(f.mimetype, originalName);

      meta.files[id] = {
        id,
        originalName,
        storedName: f.filename,
        size: f.size,
        contentType,
        uploadedAt: now,
        expiresAt: now + TTL_MS,
      };
      created.push(publicFile(meta.files[id]));
    }

    saveMeta(meta);

    res.status(201).json({
      files: created,
      file: created[0], // convenience for single-file clients
      count: created.length,
    });
  });
});

app.get("/api/file/:id", (req, res) => {
  const meta = loadMeta();
  const entry = getEntry(meta, req.params.id);
  if (!entry) {
    return res.status(404).json({ error: "File not found or expired" });
  }
  if (isExpired(entry)) {
    deleteFile(entry.id, meta);
    saveMeta(meta);
    return res.status(410).json({ error: "File expired" });
  }
  res.json(publicFile(entry));
});

app.delete("/api/file/:id", (req, res) => {
  const meta = loadMeta();
  const entry = getEntry(meta, req.params.id);
  if (!entry) {
    return res.status(404).json({ error: "File not found" });
  }
  deleteFile(entry.id, meta);
  saveMeta(meta);
  res.json({ ok: true, id: req.params.id });
});

// Inline media — used for previews + Photos-friendly open on phones
app.get("/api/raw/:id", (req, res) => {
  const resolved = resolveEntry(req.params.id);
  if (resolved.error) {
    return res.status(resolved.status).json({ error: resolved.error });
  }
  const { entry } = resolved;
  const kind = mediaKind(entry.contentType, entry.originalName);
  streamFile(res, entry, INLINE_KINDS.has(kind) ? "inline" : "attachment");
});

// Forced download (Files app / desktop download folder)
app.get("/api/download/:id", (req, res) => {
  const resolved = resolveEntry(req.params.id);
  if (resolved.error) {
    return res.status(resolved.status).json({ error: resolved.error });
  }
  streamFile(res, resolved.entry, "attachment");
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err, _req, res, next) => {
  if (!err) return next();
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  if (err.status === 413 || err.type === "entity.too.large") {
    return res.status(413).json({ error: "Payload too large" });
  }
  next(err);
});

cleanupExpired();
setInterval(cleanupExpired, CLEANUP_INTERVAL_MS).unref();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`File share listening on :${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Max file: ${formatBytes(MAX_FILE_BYTES)}, TTL: ${TTL_HOURS}h`);
  console.log(DROP_PASSWORD ? "Password: on" : "Password: off (anyone with the URL has access)");
});
