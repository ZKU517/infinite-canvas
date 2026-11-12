import type { StateStorage } from "zustand/middleware";

// 服务端数据接口的浏览器侧适配。
// - remoteStateStorage: zustand persist 用的 StateStorage（走 /api/kv/app_state/<key>）
// - RemoteStore: 替代 localforage 实例（按命名空间走 /api/kv 或 /api/blob）
// 写操作带重试与后台补传：网络抖动不会变成未捕获异常，也不会静默丢改动。

const BLOB_NAMESPACES = new Set(["image_files", "image_previews", "media_files"]);
const WRITE_ATTEMPTS = 3;
const RETRY_DELAYS = [300, 1000, 2500];

function apiUrl(base: string, key?: string) {
  return key === undefined ? base : `${base}/${encodeURIComponent(key)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reportStorageError(message: string, detail?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("ic:storage-error", { detail: { message, detail } }));
}

// 读取失败的记录：一旦某个持久化键/命名空间读取失败（网络/401/5xx/损坏），
// 就禁止后续写入/删除，避免把服务器上的真实数据覆盖成空状态。
const failedStateKeys = new Set<string>();
const failedNamespaces = new Set<string>();

// 每个 app_state 键在读取时拿到的版本（ETag）；写入时必须带上，服务器据此拒绝“盲目覆盖”。
const stateEtags = new Map<string, string | null>();

export function hasStorageFailure() {
  // 只有持久化状态（app_state）读取失败才需要阻断进入应用；
  // 单个 blob 读取失败只影响删除保护，不影响页面可用性。
  return failedStateKeys.size > 0;
}

export function storageFailureTargets() {
  return [...failedStateKeys];
}

type ReadResult = { status: "ok" | "missing" | "error"; text?: string; etag?: string | null };

async function readRaw(url: string): Promise<ReadResult> {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (res.status === 401) {
      if (typeof window !== "undefined") window.dispatchEvent(new Event("ic:unauthorized"));
      return { status: "error" };
    }
    if (res.status === 404) return { status: "missing", etag: null };
    if (!res.ok) return { status: "error" };
    return { status: "ok", text: await res.text(), etag: res.headers.get("etag") };
  } catch {
    return { status: "error" };
  }
}

// 后台补传队列：重试耗尽后保留最后一次写入，稍后继续尝试。
const pendingWrites = new Map<string, { path: string; init: RequestInit }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function enqueuePending(key: string, path: string, init: RequestInit) {
  pendingWrites.set(key, { path, init });
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer || typeof window === "undefined") return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    for (const [key, item] of Array.from(pendingWrites.entries())) {
      try {
        const res = await fetch(item.path, { ...item.init, credentials: "include" });
        if (res.ok || res.status === 204) {
          pendingWrites.delete(key);
          reportStorageError("之前未保存的改动已补传成功", item.path);
        } else if (res.status === 409 || res.status === 412 || res.status === 428) {
          pendingWrites.delete(key);
          reportStorageError("待补传的数据与服务器版本不一致，已停止补传；请刷新页面后重试", item.path);
        }
      } catch {
        /* 保留，下轮继续 */
      }
    }
    if (pendingWrites.size) scheduleFlush();
  }, 3000);
}

async function requestWithRetry(path: string, init: RequestInit, label: string): Promise<boolean> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(path, { ...init, credentials: "include" });
      if (res.status === 401) {
        if (typeof window !== "undefined") window.dispatchEvent(new Event("ic:unauthorized"));
        return false;
      }
      if (res.ok || res.status === 204) return true;
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      // 4xx：请求本身有问题，重试无意义，直接上报。
      reportStorageError(`保存失败：HTTP ${res.status}`, label);
      return false;
    } catch (error) {
      if (attempt === WRITE_ATTEMPTS - 1) break;
      await sleep(RETRY_DELAYS[attempt] ?? 2500);
    }
  }
  reportStorageError("数据保存失败，网络异常，已转入后台重试", label);
  enqueuePending(`${init.method || "PUT"}:${path}`, path, init);
  return false;
}

async function readText(path: string): Promise<string | null> {
  const result = await readRaw(path);
  if (result.status !== "ok") return null;
  return result.text ?? null;
}

// app_state 写入：必须带版本（If-Match），首次创建带 If-None-Match: *。
// 版本不一致时服务器返回 409 —— 说明别的设备/标签页改过，本页停止保存，避免覆盖。
async function writeState(name: string, init: RequestInit): Promise<void> {
  const url = apiUrl("/api/kv/app_state", name);
  if (failedStateKeys.has(name)) {
    reportStorageError("该数据未能从服务器加载成功，已阻止本次保存以避免覆盖服务器数据，请刷新重试", `state:${name}`);
    return;
  }
  const etag = stateEtags.get(name) ?? null;
  if (init.method === "DELETE" && !etag) return;
  const headers: Record<string, string> = { ...((init.headers as Record<string, string> | undefined) || {}) };
  if (etag) headers["If-Match"] = etag;
  else headers["If-None-Match"] = "*";

  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, { ...init, headers, credentials: "include" });
      if (res.status === 401) {
        if (typeof window !== "undefined") window.dispatchEvent(new Event("ic:unauthorized"));
        return;
      }
      if (res.status === 409 || res.status === 412 || res.status === 428) {
        failedStateKeys.add(name);
        reportStorageError("检测到服务器数据已被其他设备/标签页更新，已自动加载最新数据", `state:${name}`);
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("ic:data-conflict", { detail: { store: name } }));
        return;
      }
      if (res.ok || res.status === 204) {
        const nextEtag = res.headers.get("etag");
        if (nextEtag) stateEtags.set(name, nextEtag);
        return;
      }
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      reportStorageError(`保存失败：HTTP ${res.status}`, `state:${name}`);
      return;
    } catch {
      if (attempt === WRITE_ATTEMPTS - 1) {
        reportStorageError("数据保存失败，网络异常，已转入后台重试", `state:${name}`);
        enqueuePending(`${init.method || "PUT"}:${url}`, url, { ...init, headers });
        return;
      }
      await sleep(RETRY_DELAYS[attempt] ?? 2500);
    }
  }
}

export const remoteStateStorage: StateStorage = {
  getItem: async (name) => {
    const url = apiUrl("/api/kv/app_state", name);
    const result = await readRaw(url);
    if (result.status === "error") {
      failedStateKeys.add(name);
      return null;
    }
    failedStateKeys.delete(name);
    stateEtags.set(name, result.status === "missing" ? null : result.etag ?? null);
    if (result.status === "missing") return null;
    const text = result.text ?? "";
    try {
      JSON.parse(text);
    } catch {
      failedStateKeys.add(name);
      return null;
    }
    return text;
  },
  setItem: async (name, value) => {
    await writeState(name, { method: "PUT", headers: { "Content-Type": "application/json; charset=utf-8" }, body: value });
  },
  removeItem: async (name) => {
    await writeState(name, { method: "DELETE" });
  },
};

export type RemoteStoreKind = "json" | "blob";

export class RemoteStore {
  private readonly ns: string;
  private readonly kind: RemoteStoreKind;
  private readonly base: string;

  constructor(storeName: string, kind: RemoteStoreKind) {
    this.ns = storeName;
    this.kind = kind;
    this.base = this.kind === "blob" ? `/api/blob/${this.ns}` : `/api/kv/${this.ns}`;
  }

  async getItem<T = unknown>(key: string): Promise<T | null> {
    const url = apiUrl(this.base, key);
    if (this.kind === "blob") {
      try {
        const res = await fetch(url, { credentials: "include" });
        if (res.status === 401) {
          if (typeof window !== "undefined") window.dispatchEvent(new Event("ic:unauthorized"));
          failedNamespaces.add(this.base);
          return null;
        }
        if (res.status === 404) {
          failedNamespaces.delete(this.base);
          return null;
        }
        if (!res.ok) {
          failedNamespaces.add(this.base);
          return null;
        }
        failedNamespaces.delete(this.base);
        return (await res.blob()) as unknown as T;
      } catch {
        failedNamespaces.add(this.base);
        return null;
      }
    }
    const result = await readRaw(url);
    if (result.status === "error") {
      failedNamespaces.add(this.base);
      return null;
    }
    failedNamespaces.delete(this.base);
    if (result.status === "missing") return null;
    try {
      return JSON.parse(result.text ?? "") as T;
    } catch {
      return null;
    }
  }

  async setItem<T = unknown>(key: string, value: T): Promise<T> {
    const url = apiUrl(this.base, key);
    if (this.kind === "blob") {
      const blob = value as unknown as Blob;
      const headers: Record<string, string> = {};
      if (blob && typeof blob === "object" && "type" in blob && typeof (blob as Blob).type === "string" && (blob as Blob).type) {
        headers["Content-Type"] = (blob as Blob).type;
      }
      await requestWithRetry(url, { method: "PUT", headers, body: blob as BodyInit }, `blob:${this.ns}/${key}`);
      return value;
    }
    await requestWithRetry(url, { method: "PUT", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(value) }, `kv:${this.ns}/${key}`);
    return value;
  }

  async removeItem(key: string): Promise<void> {
    if (failedNamespaces.has(this.base)) {
      reportStorageError("该数据未能从服务器加载成功，已阻止删除操作", `${this.ns}/${key}`);
      return;
    }
    await requestWithRetry(apiUrl(this.base, key), { method: "DELETE" }, `delete:${this.ns}/${key}`);
  }

  async keys(): Promise<string[]> {
    try {
      const res = await fetch(this.base, { credentials: "include" });
      if (!res.ok) {
        failedNamespaces.add(this.base);
        return [];
      }
      const data = (await res.json()) as { keys?: string[] };
      failedNamespaces.delete(this.base);
      return Array.isArray(data.keys) ? data.keys : [];
    } catch {
      failedNamespaces.add(this.base);
      return [];
    }
  }

  async clear(): Promise<void> {
    if (failedNamespaces.has(this.base)) {
      reportStorageError("该数据未能从服务器加载成功，已阻止清空操作", this.ns);
      return;
    }
    const keys = await this.keys();
    await Promise.all(keys.map((key) => this.removeItem(key)));
  }

  async iterate<T = unknown, U = void>(iteratee: (value: T, key: string, iterationNumber: number) => U): Promise<U> {
    const keys = await this.keys();
    let result: U = undefined as unknown as U;
    let index = 0;
    for (const key of keys) {
      const value = await this.getItem<T>(key);
      if (value === null) continue;
      result = iteratee(value, key, index);
      index += 1;
    }
    return result;
  }
}

export function createRemoteStore(storeName: string, kind?: RemoteStoreKind): RemoteStore {
  return new RemoteStore(storeName, kind ?? (BLOB_NAMESPACES.has(storeName) ? "blob" : "json"));
}
