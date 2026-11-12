// 把未被当前画布引用的图片 blob 重建为一个新的画布项目（节点直接引用原 blob，不重复占用空间）。
// 用法：DATA_DIR=/data USER_ID=<uid> node recover-canvas.js
"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const DATA_DIR = process.env.DATA_DIR || "/data";
const USER_ID = process.env.USER_ID || "";
const STORE = path.join(DATA_DIR, "data", USER_ID, "kv", "app_state", "infinite-canvas:canvas_store.json");
const BLOB_DIR = path.join(DATA_DIR, "data", USER_ID, "blob", "image_files");
const PREVIEW_DIR = path.join(DATA_DIR, "data", USER_ID, "blob", "image_previews");
const MAX_NODE = 640;
const GAP_X = 96;
const GAP_Y = 96;
const COLUMNS = 4;

function imageSize(buffer, mime) {
  try {
    if (buffer.length > 24 && buffer.toString("ascii", 1, 4) === "PNG") {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
    if (isJpeg) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
        offset += 2 + length;
      }
    }
    if (buffer.length > 10 && buffer.toString("ascii", 0, 3) === "GIF") {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
  } catch {
    /* ignore */
  }
  return { width: 640, height: 480 };
}

function fit(width, height) {
  const scale = Math.min(1, MAX_NODE / Math.max(width, height));
  return { width: Math.max(80, Math.round(width * scale)), height: Math.max(60, Math.round(height * scale)) };
}

async function main() {
  if (!USER_ID) throw new Error("USER_ID required");

  let store = { state: { projects: [], deletedProjects: [] }, version: 0 };
  try {
    store = JSON.parse(await fsp.readFile(STORE, "utf8"));
  } catch {
    /* fresh store */
  }
  const projects = (Array.isArray(store.state?.projects) ? store.state.projects : []).filter((project) => !String(project?.id || "").startsWith("recovered-"));
  const deleted = Array.isArray(store.state?.deletedProjects) ? store.state.deletedProjects : [];
  const referenced = new Set();
  for (const project of projects) {
    const raw = JSON.stringify(project);
    for (const match of raw.matchAll(/"storageKey":"((?:image|video|audio|file)[^"]*)"/g)) referenced.add(match[1]);
  }

  let files = [];
  try {
    files = await fsp.readdir(BLOB_DIR);
  } catch {
    files = [];
  }
  const blobs = [];
  for (const name of files) {
    if (name.endsWith(".meta") || name.endsWith(".tmp")) continue;
    const full = path.join(BLOB_DIR, name);
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat) continue;
    if (referenced.has(name)) continue;
    blobs.push({ name, full, stat });
  }
  blobs.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
  if (!blobs.length) {
    console.log(JSON.stringify({ created: false, orphans: 0 }, null, 2));
    return;
  }

  const nodes = [];
  for (let index = 0; index < blobs.length; index += 1) {
    const blob = blobs[index];
    const buffer = await fsp.readFile(blob.full);
    let mime = "application/octet-stream";
    try {
      mime = (await fsp.readFile(`${blob.full}.meta`, "utf8")).trim() || mime;
    } catch {
      /* ignore */
    }
    const natural = imageSize(buffer, mime);
    const size = fit(natural.width, natural.height);
    // 画布显示用缩略图（体积小），storageKey 仍指向原图，导出/参考图时用的还是原图。
    const hasPreview = await fsp.access(path.join(PREVIEW_DIR, blob.name)).then(() => true).catch(() => false);
    const content = hasPreview ? `/api/blob/image_previews/${encodeURIComponent(blob.name)}` : `/api/blob/image_files/${encodeURIComponent(blob.name)}`;
    const column = index % COLUMNS;
    const row = Math.floor(index / COLUMNS);
    nodes.push({
      id: `restore-${crypto.randomUUID().slice(0, 8)}`,
      type: "image",
      title: `恢复图片 ${index + 1}`,
      position: { x: 80 + column * (MAX_NODE + GAP_X), y: 80 + row * (MAX_NODE + GAP_Y) },
      width: size.width,
      height: size.height,
      metadata: {
        content,
        storageKey: blob.name,
        status: "success",
        naturalWidth: natural.width,
        naturalHeight: natural.height,
        bytes: blob.stat.size,
        mimeType: mime,
        prompt: "",
      },
    });
  }

  const now = new Date().toISOString();
  const project = {
    id: `recovered-${crypto.randomUUID().slice(0, 8)}`,
    title: `素材恢复（${nodes.length} 张孤立图片）`,
    createdAt: now,
    updatedAt: now,
    nodes,
    connections: [],
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "lines",
    showImageInfo: false,
    viewport: { x: 0, y: 0, k: 1 },
  };

  if (await fsp.stat(STORE).catch(() => null)) {
    await fsp.copyFile(STORE, `${STORE}.bak-manual-${Date.now()}`);
  }
  const next = { state: { projects: [project, ...projects], deletedProjects: deleted }, version: store.version ?? 0 };
  await fsp.mkdir(path.dirname(STORE), { recursive: true });
  await fsp.writeFile(STORE, JSON.stringify(next));
  console.log(JSON.stringify({ created: true, projectId: project.id, nodes: nodes.length, title: project.title, referencedBefore: referenced.size }, null, 2));
}

main().catch((error) => {
  console.error("[recover-canvas] fatal:", error);
  process.exit(1);
});
