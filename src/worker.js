// Drop on Cloudflare Workers.
// Blobs live in R2, file metadata + containers + notepads in D1.
// Static UI in public/ is served through the ASSETS binding.
import QRCode from "qrcode";
import mime from "mime-types";
import { ssoUser, ssoLoginUrl } from "./sso.js";

const DEFAULT_CONTAINER = "main";
const MAX_CONTAINERS = 100;
const MAX_CONTAINER_NAME = 60;
const MAX_JSON_BYTES = 128 * 1024;
const MAX_FILES_PER_FORM = 10;
const CONTAINER_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const FILE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
// Files above this go up in parts (R2 multipart) so no single request
// hits the Workers request-body limit and a dropped part can be retried.
const SINGLE_PUT_MAX = 20 * 1024 * 1024;
const PART_SIZE = 10 * 1024 * 1024;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000; // unfinished multipart uploads are aborted after this
const ORPHAN_GRACE_MS = 60 * 60 * 1000;
const INLINE_KINDS = new Set(["image", "video", "audio"]);

function config(env) {
  const ttlHours = Number(env.TTL_HOURS) > 0 ? Number(env.TTL_HOURS) : 24;
  return {
    ttlHours,
    ttlMs: ttlHours * 60 * 60 * 1000,
    maxFileBytes: Number(env.MAX_FILE_BYTES) || 2 * 1024 * 1024 * 1024,
    maxNoteChars: Math.min(Number(env.MAX_NOTE_CHARS) || 20000, 50000),
  };
}

// ---------- schema (created on first use, so a fresh deploy needs no migration step) ----------

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch([
      env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS containers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          note_text TEXT NOT NULL DEFAULT '',
          note_updated_at INTEGER NOT NULL DEFAULT 0
        )`
      ),
      env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS files (
          id TEXT PRIMARY KEY,
          container_id TEXT NOT NULL,
          name TEXT NOT NULL,
          object_key TEXT NOT NULL,
          size INTEGER NOT NULL,
          content_type TEXT NOT NULL,
          uploaded_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )`
      ),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS files_container ON files (container_id, uploaded_at)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS files_expires ON files (expires_at)"),
      env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS uploads (
          id TEXT PRIMARY KEY,
          container_id TEXT NOT NULL,
          upload_id TEXT NOT NULL,
          object_key TEXT NOT NULL,
          name TEXT NOT NULL,
          size INTEGER NOT NULL,
          content_type TEXT NOT NULL,
          part_size INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )`
      ),
      env.DB.prepare("INSERT OR IGNORE INTO containers (id, name, created_at) VALUES (?, 'Inbox', 0)").bind(
        DEFAULT_CONTAINER
      ),
    ]).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

// ---------- helpers ----------

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
function randomId(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b & 63];
  return out;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      ...headers,
    },
  });
}

function text(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function extname(name) {
  const base = String(name || "").split("/").pop();
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
}

function basename(name) {
  return String(name || "").split(/[\\/]/).pop();
}

function mediaKind(contentType, name) {
  const ct = (contentType || "").toLowerCase();
  const ext = extname(name);
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
  if (ct && ct !== "application/octet-stream") return String(contentType).slice(0, 255);
  return mime.lookup(name || "") || "application/octet-stream";
}

function cleanFileName(name) {
  const base = basename(name).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!base || base.length > 255) return "";
  return base;
}

function objectKeyFor(name) {
  const ext = extname(name).replace(/[^A-Za-z0-9.]/g, "").slice(0, 32);
  return `f/${randomId(16)}${ext}`;
}

function cleanContainerName(name) {
  if (typeof name !== "string") return "";
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_CONTAINER_NAME);
}

function requestContainerId(url) {
  return url.searchParams.get("c") || DEFAULT_CONTAINER;
}

async function readJson(request) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_JSON_BYTES) throw httpError(413, "Payload too large");
  const raw = await request.text();
  if (raw.length > MAX_JSON_BYTES) throw httpError(413, "Payload too large");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "Invalid JSON");
  }
}

function httpError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  err.extra = extra;
  return err;
}

// ---------- data access ----------

async function getContainer(env, id) {
  if (typeof id !== "string" || !CONTAINER_ID_RE.test(id)) return null;
  return env.DB.prepare("SELECT * FROM containers WHERE id = ?").bind(id).first();
}

async function getFileRow(env, id) {
  if (typeof id !== "string" || !FILE_ID_RE.test(id)) return null;
  return env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(id).first();
}

async function deleteObjects(env, keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    await env.BUCKET.delete(keys.slice(i, i + 1000));
  }
}

// Removes expired rows now and their blobs in the background
async function pruneExpired(env, ctx) {
  const { results } = await env.DB.prepare("DELETE FROM files WHERE expires_at <= ? RETURNING object_key")
    .bind(Date.now())
    .all();
  const keys = results.map((r) => r.object_key);
  if (keys.length) {
    const p = deleteObjects(env, keys).catch((err) => console.error("Blob delete failed:", err.message));
    if (ctx) ctx.waitUntil(p);
    else await p;
  }
  return keys.length;
}

async function deleteFileRow(env, ctx, row) {
  await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(row.id).run();
  ctx.waitUntil(env.BUCKET.delete(row.object_key).catch(() => {}));
}

function publicFile(row) {
  const contentType = effectiveType(row.content_type, row.name);
  const kind = mediaKind(contentType, row.name);
  return {
    id: row.id,
    containerId: row.container_id,
    name: row.name,
    size: row.size,
    sizeLabel: formatBytes(row.size),
    contentType,
    kind,
    isMedia: kind === "image" || kind === "video",
    uploadedAt: row.uploaded_at,
    expiresAt: row.expires_at,
    remainingMs: Math.max(0, row.expires_at - Date.now()),
    previewUrl: `/api/raw/${row.id}`,
    downloadUrl: `/api/download/${row.id}`,
  };
}

function publicNote(cfg, container) {
  return {
    text: container.note_text || "",
    updatedAt: container.note_updated_at || 0,
    maxChars: cfg.maxNoteChars,
  };
}

async function listContainers(env) {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.created_at, c.note_text != '' AS has_note,
            (SELECT COUNT(*) FROM files f WHERE f.container_id = c.id) AS file_count
     FROM containers c ORDER BY c.created_at, c.id`
  ).all();
  return results.map((c) => ({
    id: c.id,
    name: c.name,
    createdAt: c.created_at,
    fileCount: c.file_count,
    hasNote: !!c.has_note,
    isDefault: c.id === DEFAULT_CONTAINER,
  }));
}

async function insertFile(env, cfg, container, { name, key, size, contentType }) {
  const now = Date.now();
  const row = {
    id: randomId(10),
    container_id: container.id,
    name,
    object_key: key,
    size,
    content_type: contentType,
    uploaded_at: now,
    expires_at: now + cfg.ttlMs,
  };
  await env.DB.prepare(
    `INSERT INTO files (id, container_id, name, object_key, size, content_type, uploaded_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(row.id, row.container_id, row.name, row.object_key, row.size, row.content_type, row.uploaded_at, row.expires_at)
    .run();
  return publicFile(row);
}

// ---------- auth ----------
// Single sign-on: the jb_sso cookie from auth.thejonbroadbent.com (browsers) or
// "Authorization: Bearer v1.…" (scripts; token in ~/.config/jb/sso-token). See ATHENS_BRIDGE/JB_SSO.

function signInRequired(request, url) {
  const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
  const navigating = request.headers.get("sec-fetch-mode") === "navigate" || /text\/html/.test(request.headers.get("accept") || "");
  if ((request.method === "GET" || request.method === "HEAD") && (!isApi || navigating)) {
    return new Response(null, { status: 302, headers: { location: ssoLoginUrl(request.url), "cache-control": "no-store" } });
  }
  return json({ error: "Sign in required", login: ssoLoginUrl(url.origin + "/") }, 401);
}

// ---------- file serving ----------

// Single "bytes=" range only; anything else is served whole.
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start;
  let end;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return { invalid: true };
  return { offset: start, length: end - start + 1 };
}

async function serveFile(request, env, ctx, id, disposition) {
  const row = await getFileRow(env, id);
  if (!row) return json({ error: "File not found or expired" }, 404);
  if (row.expires_at <= Date.now()) {
    await deleteFileRow(env, ctx, row);
    return json({ error: "File expired" }, 410);
  }
  const kind = mediaKind(row.content_type, row.name);
  const mode = disposition === "auto" ? (INLINE_KINDS.has(kind) ? "inline" : "attachment") : disposition;

  const range = parseRange(request.headers.get("range"), row.size);
  if (range && range.invalid) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${row.size}` } });
  }
  const isHead = request.method === "HEAD";
  const obj = isHead
    ? await env.BUCKET.head(row.object_key)
    : await env.BUCKET.get(row.object_key, range ? { range: { offset: range.offset, length: range.length } } : {});
  if (!obj) {
    await deleteFileRow(env, ctx, row);
    return json({ error: "File missing from storage" }, 404);
  }

  const headers = new Headers({
    "Content-Disposition": `${mode}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    "Content-Type": effectiveType(row.content_type, row.name),
    "Cache-Control": "private, max-age=60",
    "X-Content-Type-Options": "nosniff",
    // Uploaded HTML/SVG opened directly must never run script on this origin
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "Accept-Ranges": "bytes",
    ETag: obj.httpEtag,
  });
  let status = 200;
  if (range) {
    status = 206;
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${row.size}`);
    headers.set("Content-Length", String(range.length));
  } else {
    headers.set("Content-Length", String(row.size));
  }
  return new Response(isHead ? null : obj.body, { status, headers });
}

// ---------- QR ----------

async function qrSvg(url) {
  const c = url.searchParams.get("c") || "";
  const target = c && c !== DEFAULT_CONTAINER && CONTAINER_ID_RE.test(c) ? "/c/" + c : "/";
  const svg = await QRCode.toString(url.origin + target, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    width: 256,
    color: { dark: "#0c0f14", light: "#ffffff" },
  });
  return new Response(svg, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=300", Vary: "Host" },
  });
}

// ---------- static assets ----------

async function serveAsset(request, env, pathname) {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = pathname;
  const res = await env.ASSETS.fetch(new Request(assetUrl, request));
  if (!res.ok) return res;
  const out = new Response(res.body, res);
  // Don't cache the app shell so phones pick up UI updates immediately
  const ct = out.headers.get("content-type") || "";
  if (/text\/html|javascript|text\/css/.test(ct)) out.headers.set("Cache-Control", "no-store");
  return out;
}

// ---------- API ----------

async function handleApi(request, env, ctx, url, cfg) {
  const { pathname } = url;
  const method = request.method;
  const parts = pathname.split("/").filter(Boolean); // ["api", ...]

  // GET /api/files?c=
  if (pathname === "/api/files" && method === "GET") {
    const container = await getContainer(env, requestContainerId(url));
    if (!container) return json({ error: "Container not found", code: "container_not_found" }, 404);
    await pruneExpired(env, ctx);
    const [{ results }, containers] = await Promise.all([
      env.DB.prepare("SELECT * FROM files WHERE container_id = ? ORDER BY uploaded_at DESC").bind(container.id).all(),
      listContainers(env),
    ]);
    const files = results.map(publicFile);
    return json(
      {
        container: { id: container.id, name: container.name, isDefault: container.id === DEFAULT_CONTAINER },
        containers,
        files,
        count: files.length,
        note: publicNote(cfg, container),
        maxFileBytes: cfg.maxFileBytes,
        ttlHours: cfg.ttlHours,
        serverTime: Date.now(),
        upload: { singlePutMax: SINGLE_PUT_MAX, partSize: PART_SIZE },
      },
      200,
      { Pragma: "no-cache" }
    );
  }

  // Containers
  if (pathname === "/api/containers") {
    if (method === "GET") {
      await pruneExpired(env, ctx);
      return json({ containers: await listContainers(env) });
    }
    if (method === "POST") {
      const body = await readJson(request);
      const name = cleanContainerName(body && body.name);
      if (!name) return json({ error: "Name is required" }, 400);
      const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM containers").first();
      if (n >= MAX_CONTAINERS) return json({ error: `Too many containers (max ${MAX_CONTAINERS}).` }, 400);
      const id = randomId(8);
      const createdAt = Date.now();
      await env.DB.prepare("INSERT INTO containers (id, name, created_at) VALUES (?, ?, ?)").bind(id, name, createdAt).run();
      return json({ container: { id, name, createdAt, fileCount: 0, hasNote: false, isDefault: false } }, 201);
    }
  }

  if (parts[1] === "containers" && parts.length === 3) {
    const container = await getContainer(env, parts[2]);
    if (method === "PATCH") {
      const body = await readJson(request);
      const name = cleanContainerName(body && body.name);
      if (!name) return json({ error: "Name is required" }, 400);
      if (!container) return json({ error: "Container not found" }, 404);
      await env.DB.prepare("UPDATE containers SET name = ? WHERE id = ?").bind(name, container.id).run();
      return json({ ok: true, id: container.id, name });
    }
    if (method === "DELETE") {
      if (!container) return json({ error: "Container not found" }, 404);
      if (container.id === DEFAULT_CONTAINER) {
        return json({ error: "The default container can't be deleted" }, 400);
      }
      const [removed, pending] = await env.DB.batch([
        env.DB.prepare("DELETE FROM files WHERE container_id = ? RETURNING object_key").bind(container.id),
        env.DB.prepare("DELETE FROM uploads WHERE container_id = ? RETURNING object_key, upload_id").bind(container.id),
        env.DB.prepare("DELETE FROM containers WHERE id = ?").bind(container.id),
      ]);
      const keys = removed.results.map((r) => r.object_key);
      ctx.waitUntil(
        Promise.all([
          deleteObjects(env, keys),
          ...pending.results.map((u) => env.BUCKET.resumeMultipartUpload(u.object_key, u.upload_id).abort().catch(() => {})),
        ]).catch((err) => console.error("Container blob cleanup failed:", err.message))
      );
      return json({ ok: true, id: container.id, removedFiles: keys.length });
    }
  }

  // Notepad
  if (pathname === "/api/note") {
    if (method === "GET") {
      const container = await getContainer(env, requestContainerId(url));
      if (!container) return json({ error: "Container not found" }, 404);
      return json(publicNote(cfg, container), 200, { Pragma: "no-cache" });
    }
    if (method === "PUT") {
      const body = await readJson(request);
      const textValue = body && typeof body.text === "string" ? body.text : null;
      if (textValue === null) return json({ error: "text is required" }, 400);
      if (textValue.length > cfg.maxNoteChars) {
        return json({ error: `Note too long. Max ${cfg.maxNoteChars.toLocaleString("en-US")} characters.` }, 400);
      }
      const now = Date.now();
      const container = await env.DB.prepare(
        "UPDATE containers SET note_text = ?, note_updated_at = ? WHERE id = ? RETURNING *"
      )
        .bind(textValue, now, CONTAINER_ID_RE.test(requestContainerId(url)) ? requestContainerId(url) : "")
        .first();
      if (!container) return json({ error: "Container not found" }, 404);
      return json(publicNote(cfg, container));
    }
  }

  // Single-request upload: PUT /api/upload?c=&name=  (raw body, streamed to R2)
  if (pathname === "/api/upload" && method === "PUT") {
    const name = cleanFileName(url.searchParams.get("name"));
    if (!name) return json({ error: "Invalid filename" }, 400);
    const size = Number(request.headers.get("content-length"));
    if (!Number.isFinite(size) || size < 0 || !request.headers.has("content-length")) {
      return json({ error: "Content-Length is required" }, 411);
    }
    if (size > cfg.maxFileBytes) return json({ error: `File too large. Max ${formatBytes(cfg.maxFileBytes)}.` }, 413);
    const container = await getContainer(env, requestContainerId(url));
    if (!container) return json({ error: "Container not found" }, 404);
    const contentType = effectiveType(request.headers.get("content-type"), name);
    const key = objectKeyFor(name);
    const obj = await env.BUCKET.put(key, request.body || new Uint8Array(0), { httpMetadata: { contentType } });
    if (!obj || obj.size !== size) {
      ctx.waitUntil(env.BUCKET.delete(key).catch(() => {}));
      return json({ error: "Upload was incomplete. Try again." }, 400);
    }
    const file = await insertFile(env, cfg, container, { name, key, size, contentType });
    return json({ files: [file], file, count: 1 }, 201);
  }

  // Multipart form upload (scripts / curl -F). Buffered in memory, so keep these small.
  if (pathname === "/api/upload" && method === "POST") {
    const container = await getContainer(env, requestContainerId(url));
    if (!container) return json({ error: "Container not found" }, 404);
    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ error: "Expected multipart/form-data with field \"file\"" }, 400);
    }
    const incoming = form.getAll("file").filter((f) => f && typeof f === "object" && "arrayBuffer" in f);
    if (!incoming.length) return json({ error: "No file provided" }, 400);
    if (incoming.length > MAX_FILES_PER_FORM) return json({ error: "Too many files (max 10 at once)." }, 400);
    for (const f of incoming) {
      if (!cleanFileName(f.name)) return json({ error: "Invalid filename" }, 400);
      if (f.size > cfg.maxFileBytes) return json({ error: `File too large. Max ${formatBytes(cfg.maxFileBytes)}.` }, 413);
    }
    const created = [];
    for (const f of incoming) {
      const name = cleanFileName(f.name);
      const contentType = effectiveType(f.type, name);
      const key = objectKeyFor(name);
      await env.BUCKET.put(key, f.stream(), { httpMetadata: { contentType } });
      created.push(await insertFile(env, cfg, container, { name, key, size: f.size, contentType }));
    }
    return json({ files: created, file: created[0], count: created.length }, 201);
  }

  // Chunked upload for large files
  // POST /api/uploads?c=                      { name, size, type } -> { id, partSize, partCount }
  // PUT  /api/uploads/:id/:partNumber         raw chunk            -> { partNumber, etag }
  // POST /api/uploads/:id/complete            { parts: [{ partNumber, etag }] } -> { file }
  // DELETE /api/uploads/:id                   abort
  if (pathname === "/api/uploads" && method === "POST") {
    const body = await readJson(request);
    const name = cleanFileName(body && body.name);
    const size = Number(body && body.size);
    if (!name) return json({ error: "Invalid filename" }, 400);
    if (!Number.isInteger(size) || size <= 0) return json({ error: "size is required" }, 400);
    if (size > cfg.maxFileBytes) return json({ error: `File too large. Max ${formatBytes(cfg.maxFileBytes)}.` }, 413);
    const container = await getContainer(env, requestContainerId(url));
    if (!container) return json({ error: "Container not found" }, 404);
    const contentType = effectiveType(body.type, name);
    const key = objectKeyFor(name);
    const mpu = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType } });
    const id = randomId(12);
    await env.DB.prepare(
      `INSERT INTO uploads (id, container_id, upload_id, object_key, name, size, content_type, part_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, container.id, mpu.uploadId, key, name, size, contentType, PART_SIZE, Date.now())
      .run();
    return json({ id, partSize: PART_SIZE, partCount: Math.ceil(size / PART_SIZE) }, 201);
  }

  if (parts[1] === "uploads" && parts.length >= 3) {
    const up =
      FILE_ID_RE.test(parts[2]) && (await env.DB.prepare("SELECT * FROM uploads WHERE id = ?").bind(parts[2]).first());
    if (!up) return json({ error: "Upload not found or expired" }, 404);
    const partCount = Math.ceil(up.size / up.part_size);

    if (parts.length === 4 && parts[3] !== "complete" && method === "PUT") {
      const partNumber = Number(parts[3]);
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > partCount) {
        return json({ error: "Invalid part number" }, 400);
      }
      const expected = partNumber < partCount ? up.part_size : up.size - up.part_size * (partCount - 1);
      const len = Number(request.headers.get("content-length"));
      if (len !== expected) return json({ error: `Part ${partNumber} must be ${expected} bytes` }, 400);
      const mpu = env.BUCKET.resumeMultipartUpload(up.object_key, up.upload_id);
      const part = await mpu.uploadPart(partNumber, request.body);
      return json({ partNumber: part.partNumber, etag: part.etag });
    }

    if (parts.length === 4 && parts[3] === "complete" && method === "POST") {
      const body = await readJson(request);
      const list = Array.isArray(body && body.parts) ? body.parts : [];
      const clean = list
        .map((p) => ({ partNumber: Number(p && p.partNumber), etag: String((p && p.etag) || "") }))
        .filter((p) => Number.isInteger(p.partNumber) && p.etag)
        .sort((a, b) => a.partNumber - b.partNumber);
      if (clean.length !== partCount || clean.some((p, i) => p.partNumber !== i + 1)) {
        return json({ error: "Missing parts" }, 400);
      }
      const container = await getContainer(env, up.container_id);
      const mpu = env.BUCKET.resumeMultipartUpload(up.object_key, up.upload_id);
      if (!container) {
        ctx.waitUntil(mpu.abort().catch(() => {}));
        await env.DB.prepare("DELETE FROM uploads WHERE id = ?").bind(up.id).run();
        return json({ error: "Container not found" }, 404);
      }
      let obj;
      try {
        obj = await mpu.complete(clean);
      } catch (err) {
        return json({ error: "Could not finish the upload. Try again." }, 400);
      }
      await env.DB.prepare("DELETE FROM uploads WHERE id = ?").bind(up.id).run();
      if (obj.size !== up.size) {
        ctx.waitUntil(env.BUCKET.delete(up.object_key).catch(() => {}));
        return json({ error: "Upload was incomplete. Try again." }, 400);
      }
      const file = await insertFile(env, cfg, container, {
        name: up.name,
        key: up.object_key,
        size: up.size,
        contentType: up.content_type,
      });
      return json({ files: [file], file, count: 1 }, 201);
    }

    if (parts.length === 3 && method === "DELETE") {
      await env.DB.prepare("DELETE FROM uploads WHERE id = ?").bind(up.id).run();
      ctx.waitUntil(env.BUCKET.resumeMultipartUpload(up.object_key, up.upload_id).abort().catch(() => {}));
      return json({ ok: true });
    }
  }

  // Files
  if (parts[1] === "file" && parts.length === 3) {
    const row = await getFileRow(env, parts[2]);
    if (method === "GET") {
      if (!row) return json({ error: "File not found or expired" }, 404);
      if (row.expires_at <= Date.now()) {
        await deleteFileRow(env, ctx, row);
        return json({ error: "File expired" }, 410);
      }
      return json(publicFile(row));
    }
    if (method === "DELETE") {
      if (!row) return json({ error: "File not found" }, 404);
      await deleteFileRow(env, ctx, row);
      return json({ ok: true, id: row.id });
    }
  }

  if ((parts[1] === "raw" || parts[1] === "download") && parts.length === 3 && (method === "GET" || method === "HEAD")) {
    return serveFile(request, env, ctx, parts[2], parts[1] === "raw" ? "auto" : "attachment");
  }

  return json({ error: "Not found" }, 404);
}

// ---------- scheduled sweep ----------

async function sweep(env) {
  await ensureSchema(env);
  let removed = await pruneExpired(env, null);

  // Abort multipart uploads nobody finished
  const { results: stale } = await env.DB.prepare(
    "DELETE FROM uploads WHERE created_at <= ? RETURNING object_key, upload_id"
  )
    .bind(Date.now() - UPLOAD_TTL_MS)
    .all();
  for (const u of stale) {
    await env.BUCKET.resumeMultipartUpload(u.object_key, u.upload_id).abort().catch(() => {});
  }

  // Delete blobs with no metadata row (e.g. a crash between R2 put and D1 insert)
  const { results: rows } = await env.DB.prepare("SELECT object_key FROM files").all();
  const known = new Set(rows.map((r) => r.object_key));
  const orphans = [];
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix: "f/", cursor, limit: 1000 });
    for (const o of page.objects) {
      if (!known.has(o.key) && Date.now() - o.uploaded.getTime() > ORPHAN_GRACE_MS) orphans.push(o.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (orphans.length) await deleteObjects(env, orphans);
  removed += orphans.length + stale.length;
  if (removed > 0) console.log(`Cleanup: removed ${removed} expired/orphan item(s)`);
}

// ---------- entry ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cfg = config(env);

    if (url.pathname === "/health") return json({ ok: true });

    // Public by default. Set SSO_REQUIRED="true" to require a thejonbroadbent.com sign-in again.
    if (env.SSO_REQUIRED === "true" && !(await ssoUser(request, env.SSO_SECRET))) return signInRequired(request, url);

    try {
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        await ensureSchema(env);
        return await handleApi(request, env, ctx, url, cfg);
      }
      if (url.pathname === "/qr.svg") return await qrSvg(url);
      // Container links open the same app; the client reads the id from the path
      if (/^\/c\/[^/]+\/?$/.test(url.pathname)) return await serveAsset(request, env, "/");
      return await serveAsset(request, env, url.pathname);
    } catch (err) {
      if (err.status) return json({ error: err.message, ...(err.extra || {}) }, err.status);
      console.error("Unhandled error:", err && err.stack ? err.stack : err);
      return json({ error: "Server error" }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sweep(env));
  },
};
