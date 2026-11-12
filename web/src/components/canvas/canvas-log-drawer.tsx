import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Drawer, Empty, Tag, Tooltip } from "antd";
import { ScrollText, Trash2 } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useCanvasLogStore, type CanvasLogEntry } from "@/stores/use-canvas-log-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData } from "@/types/canvas";

type FailedEntry = { key: string; title: string; message: string; detail?: string };

function collectFailedNodes(nodes: CanvasNodeData[]): FailedEntry[] {
    const out: FailedEntry[] = [];
    for (const node of nodes) {
        const meta = node.metadata;
        if (!meta) continue;
        const title = node.title || node.type;
        const detail = [meta.prompt || meta.composerContent, meta.model ? `模型：${meta.model}` : ""].filter(Boolean).join("\n") || undefined;
        if (meta.status === "error" && meta.errorDetails) {
            out.push({ key: `${node.id}:node`, title, message: meta.errorDetails, detail });
        }
        for (const image of meta.images || []) {
            if (image.status === "error" && image.errorDetails) {
                out.push({ key: `${node.id}:image:${image.id}`, title, message: image.errorDetails, detail });
            }
        }
        for (const text of meta.texts || []) {
            if (text.status === "error" && text.errorDetails) {
                out.push({ key: `${node.id}:text:${text.id}`, title, message: text.errorDetails, detail });
            }
        }
    }
    return out;
}

const levelMeta: Record<CanvasLogEntry["level"], { text: string; color: string }> = {
    error: { text: "失败", color: "red" },
    warn: { text: "警告", color: "orange" },
    info: { text: "信息", color: "blue" },
};

export function CanvasLogButton({ nodes }: { nodes: CanvasNodeData[] }) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const { message } = App.useApp();
    const [open, setOpen] = useState(false);
    const entries = useCanvasLogStore((state) => state.entries);
    const push = useCanvasLogStore((state) => state.push);
    const clear = useCanvasLogStore((state) => state.clear);
    const seenRef = useRef<Set<string>>(new Set());

    const failed = useMemo(() => collectFailedNodes(nodes), [nodes]);
    const errorCount = entries.filter((entry) => entry.level === "error").length;

    useEffect(() => {
        for (const item of failed) {
            const dedupe = `${item.key}:${item.message}`;
            if (seenRef.current.has(dedupe)) continue;
            seenRef.current.add(dedupe);
            push({ level: "error", source: "generate", title: item.title, message: item.message, detail: item.detail });
        }
    }, [failed, push]);

    const copyAll = async () => {
        if (!entries.length) return;
        const text = entries
            .map((entry) => `[${new Date(entry.ts).toLocaleString("zh-CN", { hour12: false })}] ${levelMeta[entry.level].text} · ${entry.title}\n${entry.message}${entry.detail ? `\n${entry.detail}` : ""}`)
            .join("\n\n");
        try {
            await navigator.clipboard.writeText(text);
            message.success("日志已复制");
        } catch {
            message.error("复制失败，请手动选择文本");
        }
    };

    return (
        <>
            <Tooltip title="日志">
                <button
                    type="button"
                    onClick={() => setOpen(true)}
                    aria-label="日志"
                    className="relative grid size-7 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10"
                    style={{ color: theme.node.text }}
                >
                    <ScrollText className="size-4" />
                    {errorCount > 0 ? <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-red-500" /> : null}
                </button>
            </Tooltip>

            <Drawer
                title={
                    <div className="flex items-center justify-between gap-3">
                        <span>生成日志</span>
                        <span className="flex items-center gap-2">
                            <Button size="small" onClick={() => void copyAll()} disabled={!entries.length}>
                                复制全部
                            </Button>
                            <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => clear()} disabled={!entries.length}>
                                清空
                            </Button>
                        </span>
                    </div>
                }
                placement="right"
                width={460}
                open={open}
                onClose={() => setOpen(false)}
                styles={{ body: { padding: 12 } }}
            >
                {entries.length ? (
                    <div className="flex flex-col gap-2">
                        {entries.map((entry) => (
                            <div key={entry.id} className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: theme.node.stroke }}>
                                <div className="flex items-center justify-between gap-2">
                                    <span className="flex min-w-0 items-center gap-2">
                                        <Tag color={levelMeta[entry.level].color} className="!m-0">
                                            {levelMeta[entry.level].text}
                                        </Tag>
                                        <span className="truncate font-medium">{entry.title}</span>
                                    </span>
                                    <span className="shrink-0 text-xs opacity-50">{new Date(entry.ts).toLocaleTimeString("zh-CN", { hour12: false })}</span>
                                </div>
                                <div className="mt-1 whitespace-pre-wrap break-words text-red-500">{entry.message}</div>
                                {entry.detail ? <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs opacity-60">{entry.detail}</pre> : null}
                            </div>
                        ))}
                    </div>
                ) : (
                    <Empty description="暂无日志。生成失败时会记录原因。" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                )}
            </Drawer>
        </>
    );
}
