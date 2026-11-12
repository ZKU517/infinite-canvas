// Infinite Canvas 服务端：多用户 + 注册/登录 + 每用户 KV/Blob 存储 + 静态 SPA。
// 依赖仅 Node 内置模块；无第三方依赖，可直接 `node server.js` 运行。
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

// ---------------------------------------------------------------------------
// 配置（环境变量）
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 3081);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, "dist");
const ALLOW_REGISTRATION = (process.env.ALLOW_REGISTRATION || "true") !== "false";
const SESSION_TTL_SEC = Number(process.env.SESSION_TTL_DAYS || 30) * 24 * 3600;
const MAX_BLOB_BYTES = Number(process.env.MAX_BLOB_BYTES || 5 * 1024 * 1024 * 1024); // 5 GB 上限

const USERS_DIR = path.join(DATA_DIR, "users");
const ROOT_DIR = path.join(DATA_DIR, "data"); // /data/data/<userId>/...
const SECRET_FILE = path.join(DATA_DIR, "secret");
const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
const SNAPSHOT_CONFIG_FILE = path.join(DATA_DIR, "snapshot-config.json");
const COOKIE_NAME = "ic_session";

const DEFAULT_SNAPSHOT_CONFIG = { enabled: true, intervalMinutes: 60, keep: 24 };

const NS_RE = /^[A-Za-z0-9._-]{1,64}$/;
const KEY_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}
function b64urlDecode(str) {
  return Buffer.from(str, "base64url");
}
function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${b64url(salt)}$${b64url(hash)}`;
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split("$");
    // scrypt$N$r$p$salt$hash
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = b64urlDecode(parts[4]);
    const expected = b64urlDecode(parts[5]);
    const actual = crypto.scryptSync(String(password), salt, expected.length, { N, r, p });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

async function ensureDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(USERS_DIR, { recursive: true });
  await fsp.mkdir(ROOT_DIR, { recursive: true });
}

async function readSecret() {
  try {
    return b64urlDecode((await fsp.readFile(SECRET_FILE, "utf8")).trim());
  } catch {
    const secret = crypto.randomBytes(32);
    await fsp.writeFile(SECRET_FILE, b64url(secret), { mode: 0o600 });
    return secret;
  }
}

function signSession(userId) {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const payload = `${userId}.${expiry}`;
  const sig = crypto.createHmac("sha256", sessionSecret).update(payload).digest();
  return `${payload}.${b64url(sig)}`;
}

function verifySession(token) {
  if (!token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const [userId, expiryStr, sig] = parts;
  const payload = `${userId}.${expiryStr}`;
  const expected = crypto.createHmac("sha256", sessionSecret).update(payload).digest();
  const got = b64urlDecode(sig);
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() / 1000 > expiry) return null;
  return userId;
}

// ---------------------------------------------------------------------------
// 用户存储
// ---------------------------------------------------------------------------
async function listUsers() {
  const files = await fsp.readdir(USERS_DIR).catch(() => []);
  const users = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      users.push(JSON.parse(await fsp.readFile(path.join(USERS_DIR, file), "utf8")));
    } catch {
      /* ignore corrupt */
    }
  }
  return users;
}

async function findUserByUsername(username) {
  const users = await listUsers();
  return users.find((u) => u.username === username) || null;
}

async function getUser(userId) {
  if (!userId || !/^[A-Za-z0-9-]{1,64}$/.test(userId)) return null;
  try {
    return JSON.parse(await fsp.readFile(path.join(USERS_DIR, `${userId}.json`), "utf8"));
  } catch {
    return null;
  }
}

async function createUser(username, password) {
  const id = crypto.randomUUID();
  const existing = await listUsers();
  const adminList = String(process.env.ADMIN_USERS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const user = {
    id,
    username,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
    admin: existing.length === 0 || adminList.includes(username),
  };
  const target = path.join(USERS_DIR, `${id}.json`);
  await fsp.writeFile(target, JSON.stringify(user, null, 2), { flag: "wx", mode: 0o600 });
  return user;
}

// 至少保证有一个管理员账号（快照/恢复属于危险操作，只允许管理员）。
async function ensureAdminUser() {
  const users = await listUsers();
  if (!users.length || users.some((user) => user.admin === true)) return;
  const oldest = [...users].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
  oldest.admin = true;
  await atomicWriteFile(path.join(USERS_DIR, `${oldest.id}.json`), JSON.stringify(oldest, null, 2));
}

// ---------------------------------------------------------------------------
// 每用户数据路径 + 原子写
// ---------------------------------------------------------------------------
const writeQueues = new Map(); // path -> Promise 链，串行化同文件写入

function userDir(userId) {
  return path.join(ROOT_DIR, userId);
}

function safeKey(key) {
  const decoded = safeDecode(key);
  if (!decoded) return null;
  if (!KEY_RE.test(decoded)) return null;
  if (decoded === "." || decoded === "..") return null;
  if (decoded.includes("/") || decoded.includes("\\")) return null;
  return decoded;
}

function safeDecode(seg) {
  try {
    const s = decodeURIComponent(seg);
    if (s.includes("\0")) return null;
    return s;
  } catch {
    return null;
  }
}

function kvPath(userId, ns, key) {
  const base = path.join(userDir(userId), "kv", ns);
  const full = path.join(base, `${key}.json`);
  if (!full.startsWith(base + path.sep) || path.basename(full) !== `${key}.json`) throw new Error("bad path");
  return full;
}

function blobPath(userId, ns, key) {
  const base = path.join(userDir(userId), "blob", ns);
  const full = path.join(base, key);
  if (!full.startsWith(base + path.sep) || path.basename(full) !== key) throw new Error("bad path");
  return full;
}

function enqueueWrite(filePath, fn) {
  const prev = writeQueues.get(filePath) || Promise.resolve();
  const next = prev.then(fn, fn);
  writeQueues.set(filePath, next.catch(() => {}));
  return next;
}

async function atomicWriteFile(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${randomHex(6)}`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, filePath);
}

// ---------------------------------------------------------------------------
// 快照 / 备份（硬链接实现，未变化的媒体文件不重复占空间）
// ---------------------------------------------------------------------------
function fileEtag(stat) {
  return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

function normalizeSnapshotConfig(raw) {
  const interval = Number(raw?.intervalMinutes);
  const keep = Number(raw?.keep);
  return {
    enabled: raw?.enabled !== false,
    intervalMinutes: Number.isFinite(interval) ? Math.min(10080, Math.max(1, Math.round(interval))) : DEFAULT_SNAPSHOT_CONFIG.intervalMinutes,
    keep: Number.isFinite(keep) ? Math.min(200, Math.max(1, Math.round(keep))) : DEFAULT_SNAPSHOT_CONFIG.keep,
  };
}

async function readSnapshotConfig() {
  try {
    return normalizeSnapshotConfig(JSON.parse(await fsp.readFile(SNAPSHOT_CONFIG_FILE, "utf8")));
  } catch {
    return { ...DEFAULT_SNAPSHOT_CONFIG };
  }
}

async function writeSnapshotConfig(config) {
  const normalized = normalizeSnapshotConfig(config);
  await atomicWriteFile(SNAPSHOT_CONFIG_FILE, JSON.stringify(normalized, null, 2));
  return normalized;
}

async function hardlinkTree(src, dest, options = {}) {
  const entries = await fsp.readdir(src, { withFileTypes: true }).catch(() => []);
  await fsp.mkdir(dest, { recursive: true });
  let failures = 0;
  let files = 0;
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      const nested = await hardlinkTree(from, to, options);
      failures += nested.failures;
      files += nested.files;
      continue;
    }
    if (!entry.isFile()) continue;
    files += 1;
    try {
      await fsp.link(from, to);
    } catch {
      try {
        await fsp.copyFile(from, to);
      } catch {
        failures += 1;
      }
    }
  }
  if (options.strict && failures > 0) throw Object.assign(new Error("restore_copy_failed"), { status: 500 });
  return { failures, files };
}

async function dirStats(dir, stats = { files: 0, bytes: 0 }) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await dirStats(full, stats);
    } else if (entry.isFile()) {
      const stat = await fsp.stat(full).catch(() => null);
      if (stat) {
        stats.files += 1;
        stats.bytes += stat.size;
      }
    }
  }
  return stats;
}

async function listSnapshots() {
  const entries = await fsp.readdir(SNAPSHOT_DIR, { withFileTypes: true }).catch(() => []);
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(SNAPSHOT_DIR, entry.name);
    let meta = { name: entry.name, kind: "unknown", createdAt: "" };
    try {
      meta = { ...meta, ...JSON.parse(await fsp.readFile(path.join(dir, "meta.json"), "utf8")) };
    } catch {
      /* ignore */
    }
    const stats = await dirStats(dir);
    items.push({ ...meta, ...stats });
  }
  items.sort((a, b) => String(b.createdAt || b.name).localeCompare(String(a.createdAt || a.name)));
  return items;
}

async function applySnapshotRetention() {
  const config = await readSnapshotConfig();
  const items = await listSnapshots();
  for (const item of items.slice(config.keep)) {
    await fsp.rm(path.join(SNAPSHOT_DIR, item.name), { recursive: true, force: true }).catch(() => {});
  }
}

async function createSnapshot(kind = "auto", options = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${kind}-${stamp}`;
  const dir = path.join(SNAPSHOT_DIR, name);
  await fsp.mkdir(dir, { recursive: true });
  await hardlinkTree(ROOT_DIR, path.join(dir, "data"));
  await hardlinkTree(USERS_DIR, path.join(dir, "users"));
  const meta = { name, kind, createdAt: new Date().toISOString() };
  await fsp.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  if (!options.skipRetention) await applySnapshotRetention();
  return { ...meta, ...(await dirStats(dir)) };
}

async function restoreSnapshot(name) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) throw Object.assign(new Error("invalid_snapshot"), { status: 400 });
  const dir = path.join(SNAPSHOT_DIR, name);
  try {
    await fsp.access(path.join(dir, "data"));
  } catch {
    throw Object.assign(new Error("snapshot_not_found"), { status: 404 });
  }
  const safety = await createSnapshot("pre-restore", { skipRetention: true });

  // 先把快照内容构建到临时目录并校验，再原子替换；失败则回滚，避免恢复中途失败清空数据。
  const staging = path.join(DATA_DIR, `.restore-${randomHex(4)}`);
  const stagingData = path.join(staging, "data");
  const stagingUsers = path.join(staging, "users");
  const liveBackup = path.join(staging, "live");
  let movedLive = false;
  try {
    await fsp.mkdir(staging, { recursive: true });
    const dataResult = await hardlinkTree(path.join(dir, "data"), stagingData, { strict: true });
    const userResult = await hardlinkTree(path.join(dir, "users"), stagingUsers, { strict: true });
    if (userResult.files === 0) throw Object.assign(new Error("snapshot_empty_users"), { status: 500 });
    if (dataResult.files === 0) throw Object.assign(new Error("snapshot_empty_data"), { status: 500 });

    await fsp.mkdir(liveBackup, { recursive: true });
    await fsp.rename(ROOT_DIR, path.join(liveBackup, "data"));
    await fsp.rename(USERS_DIR, path.join(liveBackup, "users"));
    movedLive = true;
    await fsp.rename(stagingData, ROOT_DIR);
    await fsp.rename(stagingUsers, USERS_DIR);
    await fsp.rm(liveBackup, { recursive: true, force: true }).catch(() => {});
  } catch (error) {
    if (movedLive) {
      await fsp.rename(path.join(liveBackup, "data"), ROOT_DIR).catch(() => {});
      await fsp.rename(path.join(liveBackup, "users"), USERS_DIR).catch(() => {});
    }
    throw error;
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
  await applySnapshotRetention();
  return safety;
}

let lastAutoSnapshotAt = 0;

async function maybeAutoSnapshot() {
  const config = await readSnapshotConfig();
  if (!config.enabled) return;
  if (Date.now() - lastAutoSnapshotAt < config.intervalMinutes * 60_000) return;
  lastAutoSnapshotAt = Date.now();
  await createSnapshot("auto");
}

// ---------------------------------------------------------------------------
// HTTP 辅助
// ---------------------------------------------------------------------------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
}

function sendEmpty(res, code, headers = {}) {
  res.writeHead(code, headers);
  res.end();
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function setSessionCookie(res, userId) {
  const token = signSession(userId);
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SEC}`,
  );
}

function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(Object.assign(new Error("invalid json"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
async function handleAuth(req, res, pathname, segments) {
  if (pathname === "/api/auth/register" && req.method === "POST") {
    if (!ALLOW_REGISTRATION) return sendJSON(res, 403, { error: "registration_disabled" });
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJSON(res, e.status || 400, { error: e.message });
    }
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!USERNAME_RE.test(username)) return sendJSON(res, 400, { error: "invalid_username" });
    if (password.length < 8 || password.length > 128) return sendJSON(res, 400, { error: "invalid_password" });
    if (await findUserByUsername(username)) return sendJSON(res, 409, { error: "username_taken" });
    let user;
    try {
      user = await createUser(username, password);
    } catch {
      return sendJSON(res, 409, { error: "username_taken" });
    }
    setSessionCookie(res, user.id);
    return sendJSON(res, 200, { user: publicUser(user) });
  }

  if (pathname === "/api/auth/login" && req.method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJSON(res, e.status || 400, { error: e.message });
    }
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const user = await findUserByUsername(username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return sendJSON(res, 401, { error: "invalid_credentials" });
    }
    setSessionCookie(res, user.id);
    return sendJSON(res, 200, { user: publicUser(user) });
  }

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === "/api/auth/me" && req.method === "GET") {
    const userId = verifySession(parseCookies(req)[COOKIE_NAME]);
    if (!userId) return sendJSON(res, 401, { error: "unauthenticated" });
    const user = await getUser(userId);
    if (!user) return sendJSON(res, 401, { error: "unauthenticated" });
    return sendJSON(res, 200, { user: publicUser(user) });
  }

  if (pathname === "/api/auth/change-password" && req.method === "POST") {
    const userId = getAuthUserId(req);
    if (!userId) return sendJSON(res, 401, { error: "unauthenticated" });
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJSON(res, e.status || 400, { error: e.message });
    }
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    const user = await getUser(userId);
    if (!user || !verifyPassword(currentPassword, user.passwordHash)) {
      return sendJSON(res, 401, { error: "invalid_credentials" });
    }
    if (newPassword.length < 8 || newPassword.length > 128) {
      return sendJSON(res, 400, { error: "invalid_password" });
    }
    user.passwordHash = hashPassword(newPassword);
    await atomicWriteFile(path.join(USERS_DIR, `${user.id}.json`), JSON.stringify(user, null, 2));
    return sendJSON(res, 200, { ok: true });
  }

  return null;
}

function adminUsernames() {
  return String(process.env.ADMIN_USERS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAdminUser(user) {
  if (!user) return false;
  return user.admin === true || adminUsernames().includes(user.username);
}

function publicUser(user) {
  return { id: user.id, username: user.username, createdAt: user.createdAt, admin: isAdminUser(user) };
}

function getAuthUserId(req) {
  return verifySession(parseCookies(req)[COOKIE_NAME]);
}

// ---------------------------------------------------------------------------
// 管理接口：快照配置 / 快照列表 / 立即快照 / 恢复
// ---------------------------------------------------------------------------
async function handleAdmin(req, res, pathname) {
  const userId = getAuthUserId(req);
  if (!userId) return sendJSON(res, 401, { error: "unauthenticated" });
  const user = await getUser(userId);
  if (!isAdminUser(user)) return sendJSON(res, 403, { error: "forbidden" });

  if (pathname === "/api/admin/snapshots" && req.method === "GET") {
    return sendJSON(res, 200, { config: await readSnapshotConfig(), snapshots: await listSnapshots() });
  }
  if (pathname === "/api/admin/snapshots/config" && req.method === "PUT") {
    const body = await readJsonBody(req).catch(() => ({}));
    const config = await writeSnapshotConfig(body);
    return sendJSON(res, 200, { config });
  }
  if (pathname === "/api/admin/snapshots" && req.method === "POST") {
    const snapshot = await createSnapshot("manual");
    return sendJSON(res, 200, { snapshot, config: await readSnapshotConfig(), snapshots: await listSnapshots() });
  }
  if (pathname === "/api/admin/snapshots/restore" && req.method === "POST") {
    const body = await readJsonBody(req).catch(() => ({}));
    const safety = await restoreSnapshot(String(body.name || ""));
    return sendJSON(res, 200, { restored: String(body.name || ""), safetySnapshot: safety, snapshots: await listSnapshots() });
  }
  return null;
}

async function handleData(req, res, pathname, segments) {
  // segments 形如 ["api","kv","<ns>","<key>"] 或 ["api","kv","<ns>"]
  if (pathname === "/api/meta" && req.method === "GET") {
    const userId = getAuthUserId(req);
    if (!userId) return sendJSON(res, 401, { error: "unauthenticated" });
    const dir = userDir(userId);
    let initialized = false;
    try {
      await fsp.access(dir);
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      initialized = entries.length > 0;
    } catch {
      initialized = false;
    }
    return sendJSON(res, 200, { initialized });
  }

  const kind = segments[1]; // "kv" | "blob"
  if (kind !== "kv" && kind !== "blob") return null;

  const userId = getAuthUserId(req);
  if (!userId) return sendJSON(res, 401, { error: "unauthenticated" });

  const ns = segments[2];
  const keySeg = segments[3];

  if (ns === undefined || !NS_RE.test(ns)) return sendJSON(res, 400, { error: "invalid_namespace" });

  if (kind === "kv") return handleKv(req, res, userId, ns, keySeg);
  return handleBlob(req, res, userId, ns, keySeg);
}

// 判断一个 zustand persist 值是否为空状态（用于阻止「加载失败后回写空数据」覆盖真数据）。
function isEmptyPersistedState(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("state" in parsed)) return false;
    const state = parsed.state;
    if (!state || typeof state !== "object") return false;
    const values = Object.values(state);
    if (!values.length) return true;
    return values.every((value) => {
      if (Array.isArray(value)) return value.length === 0;
      if (value && typeof value === "object") return Object.keys(value).length === 0;
      return value === "" || value == null;
    });
  } catch {
    return false;
  }
}

async function handleKv(req, res, userId, ns, keySeg) {
  const base = path.join(userDir(userId), "kv", ns);

  // 列表
  if (keySeg === undefined) {
    if (req.method !== "GET") return sendJSON(res, 405, { error: "method_not_allowed" });
    let files = [];
    try {
      files = (await fsp.readdir(base)).filter((f) => f.endsWith(".json"));
    } catch {
      files = [];
    }
    const keys = files.map((f) => f.slice(0, -".json".length));
    return sendJSON(res, 200, { keys });
  }

  const key = safeKey(keySeg);
  if (!key) return sendJSON(res, 400, { error: "invalid_key" });
  const filePath = path.join(base, `${key}.json`);

  if (req.method === "GET") {
    const wantBackup = new URL(req.url, "http://localhost").searchParams.get("backup") === "1";
    const target = wantBackup ? `${filePath}.bak` : filePath;
    try {
      const data = await fsp.readFile(target, "utf8");
      const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(data) };
      if (ns === "app_state" && !wantBackup) {
        const stat = await fsp.stat(target);
        headers.ETag = fileEtag(stat);
      }
      res.writeHead(200, headers);
      return res.end(data);
    } catch {
      return sendJSON(res, 404, { error: "not_found" });
    }
  }

  if (req.method === "PUT") {
    const body = await readBodyText(req, 512 * 1024 * 1024);
    const forceWrite = String(req.headers["x-ic-force-write"] || "") === "1";
    const newEtag = await enqueueWrite(filePath, async () => {
      let existing = null;
      let existingStat = null;
      try {
        existingStat = await fsp.stat(filePath);
        existing = await fsp.readFile(filePath, "utf8");
      } catch {
        existing = null;
        existingStat = null;
      }
      // 写入版本锁：客户端必须持有服务器当前版本才允许覆盖，杜绝“盲目整份覆盖”。
      if (ns === "app_state" && !forceWrite) {
        const ifMatch = String(req.headers["if-match"] || "");
        const ifNoneMatch = String(req.headers["if-none-match"] || "");
        if (existingStat) {
          if (!ifMatch) throw Object.assign(new Error("precondition_required"), { status: 428 });
          if (ifMatch !== fileEtag(existingStat)) throw Object.assign(new Error("version_conflict"), { status: 409 });
        } else if (ifNoneMatch !== "*") {
          throw Object.assign(new Error("precondition_required"), { status: 428 });
        }
      }
      const existingEmpty = existing === null ? true : isEmptyPersistedState(existing);
      // 只在现有版本非空时更新 .bak，避免连续的空写入把好备份冲掉。
      if (existing !== null && !existingEmpty) {
        try {
          await fsp.writeFile(`${filePath}.bak`, existing);
        } catch {
          /* ignore */
        }
      }
      // 保护：不能用空状态覆盖一份明显有内容的存储（常见于前端加载失败后回写空数据）。
      const newEmpty = isEmptyPersistedState(body);
      if (!forceWrite && !existingEmpty && Buffer.byteLength(existing || "") >= 2048 && newEmpty) {
        throw Object.assign(new Error("refuse_empty_overwrite"), { status: 409 });
      }
      await atomicWriteFile(filePath, body);
      const stat = await fsp.stat(filePath);
      return fileEtag(stat);
    });
    return sendEmpty(res, 204, ns === "app_state" ? { ETag: newEtag } : {});
  }

  if (req.method === "DELETE") {
    await enqueueWrite(filePath, async () => {
      if (ns === "app_state") {
        let stat = null;
        try {
          stat = await fsp.stat(filePath);
        } catch {
          stat = null;
        }
        if (stat) {
          const ifMatch = String(req.headers["if-match"] || "");
          if (!ifMatch || ifMatch !== fileEtag(stat)) throw Object.assign(new Error("version_conflict"), { status: 409 });
        }
      }
      await fsp.rm(filePath, { force: true });
    });
    return sendEmpty(res, 204);
  }

  return sendJSON(res, 405, { error: "method_not_allowed" });
}

async function handleBlob(req, res, userId, ns, keySeg) {
  const base = path.join(userDir(userId), "blob", ns);

  if (keySeg === undefined) {
    if (req.method !== "GET") return sendJSON(res, 405, { error: "method_not_allowed" });
    let files = [];
    try {
      files = (await fsp.readdir(base)).filter((f) => !f.endsWith(".meta") && !f.endsWith(".tmp"));
    } catch {
      files = [];
    }
    return sendJSON(res, 200, { keys: files });
  }

  const key = safeKey(keySeg);
  if (!key) return sendJSON(res, 400, { error: "invalid_key" });
  const filePath = path.join(base, key);
  const metaPath = `${filePath}.meta`;

  if (req.method === "GET") {
    try {
      const stat = await fsp.stat(filePath);
      let contentType = "application/octet-stream";
      try {
        contentType = (await fsp.readFile(metaPath, "utf8")).trim() || contentType;
      } catch {
        /* ignore */
      }
      const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { ETag: etag, "Cache-Control": "public, max-age=86400" });
        return res.end();
      }
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": stat.size,
        ETag: etag,
        "Cache-Control": "public, max-age=86400",
        "Accept-Ranges": "bytes",
      });
      const stream = fs.createReadStream(filePath);
      stream.on("error", () => res.destroy());
      return stream.pipe(res);
    } catch {
      return sendJSON(res, 404, { error: "not_found" });
    }
  }

  if (req.method === "PUT") {
    const contentType = String(req.headers["content-type"] || "application/octet-stream");
    await enqueueWrite(filePath, () => writeBlobStream(req, filePath, metaPath, contentType));
    return sendEmpty(res, 204);
  }

  if (req.method === "DELETE") {
    await enqueueWrite(filePath, async () => {
      await fsp.rm(filePath, { force: true });
      await fsp.rm(metaPath, { force: true });
    });
    return sendEmpty(res, 204);
  }

  return sendJSON(res, 405, { error: "method_not_allowed" });
}

function writeBlobStream(req, filePath, metaPath, contentType) {
  return new Promise((resolve, reject) => {
    fsp.mkdir(path.dirname(filePath), { recursive: true }).then(() => {
      const tmp = `${filePath}.tmp-${randomHex(6)}`;
      const ws = fs.createWriteStream(tmp);
      let size = 0;
      let aborted = false;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BLOB_BYTES) {
          aborted = true;
          ws.destroy();
          req.destroy();
          fsp.rm(tmp, { force: true }).catch(() => {});
          reject(Object.assign(new Error("blob too large"), { status: 413 }));
          return;
        }
        ws.write(chunk);
      });
      req.on("end", () => {
        if (aborted) return;
        ws.end(async () => {
          try {
            await fsp.writeFile(metaPath, contentType);
            await fsp.rename(tmp, filePath);
            resolve();
          } catch (e) {
            await fsp.rm(tmp, { force: true }).catch(() => {});
            reject(e);
          }
        });
      });
      req.on("error", (e) => {
        if (!aborted) {
          aborted = true;
          ws.destroy();
          fsp.rm(tmp, { force: true }).catch(() => {});
          reject(e);
        }
      });
    }).catch(reject);
  });
}

function readBodyText(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// 静态资源 + SPA 回退
// ---------------------------------------------------------------------------
async function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  rel = rel.replace(/^\/+/, "");
  if (rel.split("/").some((s) => s === "..")) rel = "";
  let filePath = path.join(STATIC_DIR, rel);
  if (!filePath.startsWith(STATIC_DIR)) filePath = path.join(STATIC_DIR, "index.html");

  let stat = null;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    filePath = path.join(STATIC_DIR, "index.html");
    try {
      stat = await fsp.stat(filePath);
    } catch {
      sendJSON(res, 404, { error: "not_found" });
      return;
    }
  }

  if (stat.isDirectory()) {
    filePath = path.join(filePath, "index.html");
    try {
      stat = await fsp.stat(filePath);
    } catch {
      sendJSON(res, 404, { error: "not_found" });
      return;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const cache = ext === ".html" || filePath.endsWith("/index.html") ? "no-store" : "public, max-age=86400";
  res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Cache-Control": cache });
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// 主服务
// ---------------------------------------------------------------------------
let sessionSecret;

async function main() {
  await ensureDirs();
  await ensureAdminUser();
  sessionSecret = await readSecret();

  // 快照：首次启动先建一份，之后按配置的间隔自动创建。
  await fsp.mkdir(SNAPSHOT_DIR, { recursive: true });
  try {
    const existingSnapshots = await listSnapshots();
    if (existingSnapshots.length) {
      lastAutoSnapshotAt = new Date(existingSnapshots[0].createdAt || Date.now()).getTime();
    } else {
      await createSnapshot("auto");
      lastAutoSnapshotAt = Date.now();
    }
  } catch (error) {
    console.error("[infinite-canvas-server] init snapshot failed:", error);
  }
  setInterval(() => {
    maybeAutoSnapshot().catch((error) => console.error("[infinite-canvas-server] snapshot failed:", error));
  }, 60_000);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;
    const segments = pathname.split("/").filter(Boolean); // e.g. ["api","kv","ns","key"]

    try {
      if (pathname === "/healthz") {
        return sendJSON(res, 200, { ok: true });
      }

      if (segments[0] === "api" && segments[1] === "auth") {
        const handled = await handleAuth(req, res, pathname, segments);
        if (handled !== null) return;
      }

      if (segments[0] === "api" && segments[1] === "admin") {
        const handled = await handleAdmin(req, res, pathname);
        if (handled !== null) return;
        return sendJSON(res, 404, { error: "not_found" });
      }

      if (segments[0] === "api") {
        const handled = await handleData(req, res, pathname, segments);
        if (handled !== null) return;
        return sendJSON(res, 404, { error: "not_found" });
      }

      if (req.method === "GET" || req.method === "HEAD") {
        return await serveStatic(req, res, pathname);
      }

      sendJSON(res, 404, { error: "not_found" });
    } catch (e) {
      const status = e.status || 500;
      if (!res.headersSent) sendJSON(res, status, { error: e.message || "internal_error" });
      else res.destroy();
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[infinite-canvas-server] listening on :${PORT}, data=${DATA_DIR}, static=${STATIC_DIR}, registration=${ALLOW_REGISTRATION}`);
  });
}

main().catch((e) => {
  console.error("[infinite-canvas-server] fatal:", e);
  process.exit(1);
});
