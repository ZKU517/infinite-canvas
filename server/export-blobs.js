// 从数据目录导出所有媒体 blob 为可直接使用的图片/视频文件（带正确扩展名）。
// 用法：DATA_DIR=/data USER_ID=<uid> OUT_DIR=/out node export-blobs.js
"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");

const DATA_DIR = process.env.DATA_DIR || "/data";
const USER_ID = process.env.USER_ID || "";
const OUT_DIR = process.env.OUT_DIR || "/out";

const NAMESPACES = ["image_files", "media_files"];

function extFor(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("webm")) return "webm";
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  return "bin";
}

async function readReferencedKeys() {
  const keys = new Set();
  try {
    const raw = await fsp.readFile(path.join(DATA_DIR, "data", USER_ID, "kv", "app_state", "infinite-canvas:canvas_store.json"), "utf8");
    for (const match of raw.matchAll(/"storageKey":"((?:image|video|audio|file|video-reference|audio-reference):[^"]*)"/g)) {
      keys.add(match[1]);
    }
  } catch {
    /* ignore */
  }
  return keys;
}

async function main() {
  if (!USER_ID) throw new Error("USER_ID required");
  const referenced = await readReferencedKeys();
  await fsp.mkdir(OUT_DIR, { recursive: true });

  const manifest = [];
  let index = 0;
  for (const ns of NAMESPACES) {
    const dir = path.join(DATA_DIR, "data", USER_ID, "blob", ns);
    let entries = [];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue;
    }
    const files = [];
    for (const name of entries) {
      if (name.endsWith(".meta") || name.endsWith(".tmp")) continue;
      const stat = await fsp.stat(path.join(dir, name)).catch(() => null);
      if (!stat) continue;
      files.push({ name, stat });
    }
    files.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
    for (const { name, stat } of files) {
      let mime = "application/octet-stream";
      try {
        mime = (await fsp.readFile(path.join(dir, `${name}.meta`), "utf8")).trim() || mime;
      } catch {
        /* ignore */
      }
      index += 1;
      const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
      const file = `${String(index).padStart(3, "0")}_${safe}.${extFor(mime)}`;
      await fsp.copyFile(path.join(dir, name), path.join(OUT_DIR, file));
      manifest.push({
        index,
        storageKey: name,
        namespace: ns,
        file,
        bytes: stat.size,
        mtime: new Date(stat.mtimeMs).toISOString(),
        mime,
        referencedByCurrentCanvas: referenced.has(name),
      });
    }
  }

  await fsp.writeFile(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  const referencedCount = manifest.filter((item) => item.referencedByCurrentCanvas).length;
  console.log(
    JSON.stringify(
      {
        exported: manifest.length,
        referencedByCurrentCanvas: referencedCount,
        orphan: manifest.length - referencedCount,
        outDir: OUT_DIR,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("[export-blobs] fatal:", error);
  process.exit(1);
});
