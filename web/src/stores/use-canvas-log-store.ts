import { create } from "zustand";

export type CanvasLogLevel = "error" | "warn" | "info";
export type CanvasLogSource = "generate" | "runtime" | "network";

export type CanvasLogEntry = {
    id: string;
    ts: number;
    level: CanvasLogLevel;
    source: CanvasLogSource;
    title: string;
    message: string;
    detail?: string;
};

type CanvasLogStore = {
    entries: CanvasLogEntry[];
    push: (entry: Omit<CanvasLogEntry, "id" | "ts"> & { ts?: number }) => void;
    clear: () => void;
};

const MAX_ENTRIES = 300;
let seq = 0;

export const useCanvasLogStore = create<CanvasLogStore>()((set) => ({
    entries: [],
    push: (entry) =>
        set((state) => {
            const next: CanvasLogEntry = {
                ...entry,
                id: `log-${Date.now()}-${seq++}`,
                ts: entry.ts ?? Date.now(),
            };
            return { entries: [next, ...state.entries].slice(0, MAX_ENTRIES) };
        }),
    clear: () => set({ entries: [] }),
}));

// 全局兜底：未捕获的运行时错误 / 未处理的 Promise 拒绝，也记进画布日志。
if (typeof window !== "undefined") {
    window.addEventListener("unhandledrejection", (event) => {
        const reason = event.reason;
        const message = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : safeStringify(reason);
        useCanvasLogStore.getState().push({
            level: "error",
            source: "runtime",
            title: "未处理的异步错误",
            message: message || "未知错误",
            detail: reason instanceof Error ? reason.stack : undefined,
        });
    });
    window.addEventListener("error", (event) => {
        const error = event.error;
        const message = error instanceof Error ? error.message : event.message || "未知错误";
        useCanvasLogStore.getState().push({
            level: "error",
            source: "runtime",
            title: "运行时错误",
            message,
            detail: error instanceof Error ? error.stack : `${event.filename || ""}:${event.lineno || 0}`,
        });
    });

    // 存储层上报的保存失败/补传结果（不是未捕获异常，单独归类，避免吓人）。
    window.addEventListener("ic:storage-error", (event) => {
        const detail = (event as CustomEvent<{ message?: string; detail?: string }>).detail;
        const message = detail?.message || "数据保存失败";
        useCanvasLogStore.getState().push({
            level: message.includes("成功") ? "info" : "warn",
            source: "network",
            title: message.includes("成功") ? "数据补传" : "数据保存",
            message,
            detail: detail?.detail,
        });
    });
}

function safeStringify(value: unknown) {
    try {
        return JSON.stringify(value ?? "");
    } catch {
        return String(value ?? "");
    }
}
