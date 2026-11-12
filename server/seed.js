// 一次性迁移脚本：把飞牛 WebDAV 快照（/vol2/1000/infinite-canvas）导入到指定账号的
// 服务端数据目录。同时可选导入「配置→导出配置」JSON（AI 渠道 + 提示词库）。
//
// 环境变量：
//   DATA_DIR         服务端数据目录（= /data）
//   SEED_SRC         WebDAV 快照根目录（= /seed-src）
//   SEED_CONFIG_FILE 可选：导出配置 JSON 路径（= /seed-config.json）
//   SEED_USER        目标用户名（默认 tianyuan）
//   SEED_PASSWORD    目标用户密码（必填，由部署时用户提供；长度>=8）
//
// 结果写到 <DATA_DIR>/seed-result.json。
"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const DATA_DIR = process.env.DATA_DIR || "/data";
const SEED_SRC = process.env.SEED_SRC || "/seed-src";
const SEED_CONFIG_FILE = process.env.SEED_CONFIG_FILE || "";
const SEED_USER = process.env.SEED_USER || "tianyuan";
const SEED_PASSWORD = process.env.SEED_PASSWORD || "";

const USERS_DIR = path.join(DATA_DIR, "users");
const ROOT_DIR = path.join(DATA_DIR, "data");

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${b64url(salt)}$${b64url(hash)}`;
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function writeKv(userId, ns, key, value) {
  const dir = path.join(ROOT_DIR, userId, "kv", ns);
  await fsp.mkdir(dir, { recursive: true });
  const text = typeof value === "string" ? value : JSON.stringify(value);
  await fsp.writeFile(path.join(dir, `${key}.json`), text);
}

async function writeBlob(userId, ns, key, srcPath, mimeType) {
  const dir = path.join(ROOT_DIR, userId, "blob", ns);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.copyFile(srcPath, path.join(dir, key));
  await fsp.writeFile(path.join(dir, `${key}.meta`), mimeType || "application/octet-stream");
}

async function ensureUser(username, password) {
  const files = await fsp.readdir(USERS_DIR).catch(() => []);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const user = await readJson(path.join(USERS_DIR, file)).catch(() => null);
    if (user && user.username === username) return user;
  }
  if (!password || password.length < 8) throw new Error("SEED_PASSWORD 必须 >= 8 位");
  const user = {
    id: crypto.randomUUID(),
    username,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  await fsp.writeFile(path.join(USERS_DIR, `${user.id}.json`), JSON.stringify(user, null, 2), { mode: 0o600 });
  return user;
}

function blobNamespace(storageKey) {
  return storageKey.startsWith("image:") ? "image_files" : "media_files";
}

async function importDomain(userId, domain, nsForLogs) {
  const manifest = await readJson(path.join(SEED_SRC, domain, "manifest.json"));
  const counts = { files: 0, logs: 0 };
  if (domain === "canvas") {
    const state = { projects: manifest.data?.projects || [], deletedProjects: manifest.data?.deleted || [] };
    await writeKv(userId, "app_state", "infinite-canvas:canvas_store", JSON.stringify({ state, version: 0 }));
    counts.projects = state.projects.length;
  } else if (domain === "assets") {
    const state = { assets: manifest.data?.assets || [] };
    await writeKv(userId, "app_state", "infinite-canvas:asset_store", JSON.stringify({ state, version: 0 }));
    counts.assets = state.assets.length;
  } else {
    // image-workbench / video-workbench
    const logs = manifest.data?.logs || [];
    for (const log of logs) {
      if (log && typeof log === "object" && log.id) {
        await writeKv(userId, nsForLogs, String(log.id), JSON.stringify(log));
        counts.logs += 1;
      }
    }
  }
  for (const f of manifest.files || []) {
    if (!f || !f.storageKey || !f.path) continue;
    const src = path.join(SEED_SRC, f.path);
    try {
      await fsp.access(src);
    } catch {
      continue;
    }
    await writeBlob(userId, blobNamespace(f.storageKey), f.storageKey, src, f.mimeType);
    counts.files += 1;
  }
  return counts;
}

async function main() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(USERS_DIR, { recursive: true });
  await fsp.mkdir(ROOT_DIR, { recursive: true });

  const user = await ensureUser(SEED_USER, SEED_PASSWORD);

  const result = { userId: user.id, username: user.username, counts: {}, configImported: false };

  const canvas = await importDomain(user.id, "canvas", "");
  const assets = await importDomain(user.id, "assets", "");
  const imageLogs = await importDomain(user.id, "image-workbench", "image_generation_logs");
  const videoLogs = await importDomain(user.id, "video-workbench", "video_generation_logs");

  result.counts = {
    projects: canvas.projects || 0,
    assets: assets.assets || 0,
    imageLogs: imageLogs.logs || 0,
    videoLogs: videoLogs.logs || 0,
    canvasFiles: canvas.files || 0,
    assetFiles: assets.files || 0,
    imageLogFiles: imageLogs.files || 0,
    videoLogFiles: videoLogs.files || 0,
  };

  if (SEED_CONFIG_FILE) {
    try {
      const cfg = await readJson(SEED_CONFIG_FILE);
      if (cfg && cfg.config) {
        const configState = { config: cfg.config, webdav: cfg.webdav || {} };
        await writeKv(user.id, "app_state", "infinite-canvas:ai_config_store", JSON.stringify({ state: configState, version: 0 }));
        result.configImported = true;
      }
      if (cfg && cfg.promptSources) {
        await writeKv(user.id, "app_state", "infinite-canvas:prompt_source_store_v2", JSON.stringify({ state: cfg.promptSources, version: 0 }));
      }
    } catch (e) {
      result.configError = String(e && e.message);
    }
  }

  await fsp.writeFile(path.join(DATA_DIR, "seed-result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error("[seed] fatal:", e);
  process.exit(1);
});
