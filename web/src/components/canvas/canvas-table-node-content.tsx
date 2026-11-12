import type { MouseEvent as ReactMouseEvent } from "react";
import { ImagePlus, Plus, Rows3, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { nanoid } from "nanoid";

import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasNodeData, CanvasTableRow } from "@/types/canvas";

type CanvasTableNodeContentProps = {
    node: CanvasNodeData;
    theme: CanvasTheme;
    onRowsChange: (nodeId: string, rows: CanvasTableRow[]) => void;
    onPickReference: (nodeId: string, rowId: string) => void;
    onClearReference: (nodeId: string, rowId: string) => void;
    onImportLines: (nodeId: string) => void;
    onFromImages: (nodeId: string) => void;
};

const stop = (event: ReactMouseEvent) => event.stopPropagation();

export function CanvasTableNodeContent({ node, theme, onRowsChange, onPickReference, onClearReference, onImportLines, onFromImages }: CanvasTableNodeContentProps) {
    const { t } = useTranslation();
    const rows = node.metadata?.rows || [];
    const commit = (next: CanvasTableRow[]) => onRowsChange(node.id, next);
    const updateRow = (rowId: string, patch: Partial<CanvasTableRow>) => commit(rows.map((row) => (row.id === rowId ? { ...row, ...patch } : row)));
    const flatButtonClass = "inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-[11px] transition";
    const flatButtonStyle = { color: theme.toolbar.item, fontSize: 11 };
    const hoverProps = {
        onMouseEnter: (event: ReactMouseEvent<HTMLButtonElement>) => (event.currentTarget.style.background = theme.toolbar.itemHover),
        onMouseLeave: (event: ReactMouseEvent<HTMLButtonElement>) => (event.currentTarget.style.background = "transparent"),
    };

    return (
        <div className="flex h-full w-full select-text flex-col" style={{ color: theme.node.text }} onWheel={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-2">
                <div className="flex min-w-0 items-center gap-0.5">
                    <button type="button" className={flatButtonClass} style={flatButtonStyle} {...hoverProps} onMouseDown={stop} onPointerDown={stop} onClick={() => onImportLines(node.id)}>
                        <Rows3 className="size-3.5 shrink-0" />
                        {t("canvas.table.importLines")}
                    </button>
                    <button type="button" className={flatButtonClass} style={flatButtonStyle} {...hoverProps} data-canvas-keep-selection onMouseDown={stop} onPointerDown={stop} onClick={() => onFromImages(node.id)}>
                        <ImagePlus className="size-3.5 shrink-0" />
                        {t("canvas.table.fromImages")}
                    </button>
                </div>
                <span className="shrink-0" style={{ color: theme.node.muted, fontSize: 11 }}>
                    {t("canvas.table.rows", { count: rows.length })}
                </span>
            </div>

            <div className="flex items-center gap-2 border-b px-3 pb-1.5 font-medium" style={{ borderColor: theme.node.stroke, color: theme.node.muted, fontSize: 11 }}>
                <span className="min-w-0 flex-1">{t("canvas.table.columnPrompt")}</span>
                <span className="w-[88px] shrink-0 text-center">{t("canvas.table.columnReference")}</span>
                <span className="w-6 shrink-0" />
            </div>

            <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-1.5">
                {rows.length ? (
                    <div className="space-y-1.5">
                        {rows.map((row) => (
                            <div key={row.id} className="flex items-center gap-2">
                                <input
                                    value={row.prompt}
                                    placeholder={t("canvas.table.rowPlaceholder")}
                                    className="h-8 min-w-0 flex-1 select-text rounded-md border bg-transparent px-2 text-xs outline-none placeholder:opacity-40"
                                    style={{ borderColor: theme.node.stroke, color: theme.node.text, fontSize: 12 }}
                                    onMouseDown={stop}
                                    onPointerDown={stop}
                                    onChange={(event) => updateRow(row.id, { prompt: event.target.value })}
                                />
                                <div className="flex w-[88px] shrink-0 items-center justify-center">
                                    {row.imageUrl ? (
                                        <div className="relative">
                                            <img src={row.imageUrl} alt="" draggable={false} className="size-7 rounded-md object-cover" style={{ border: `1px solid ${theme.node.stroke}` }} />
                                            <button
                                                type="button"
                                                className="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full border transition"
                                                style={{ background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
                                                {...hoverProps}
                                                aria-label={t("canvas.table.clearReference")}
                                                title={t("canvas.table.clearReference")}
                                                onMouseDown={stop}
                                                onPointerDown={stop}
                                                onClick={() => onClearReference(node.id, row.id)}
                                            >
                                                <X className="size-2.5" />
                                            </button>
                                        </div>
                                    ) : (
                                        <button
                                            type="button"
                                            className="inline-flex h-7 max-w-full items-center gap-1 rounded-md px-1 transition"
                                            style={{ color: theme.node.muted, fontSize: 10 }}
                                            {...hoverProps}
                                            aria-label={t("canvas.table.pickReference")}
                                            title={t("canvas.table.pickReference")}
                                            onMouseDown={stop}
                                            onPointerDown={stop}
                                            onClick={() => onPickReference(node.id, row.id)}
                                        >
                                            <ImagePlus className="size-3 shrink-0" />
                                            <span className="truncate">{t("canvas.table.pickReference")}</span>
                                        </button>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    className="grid size-6 shrink-0 place-items-center rounded-md transition"
                                    style={{ color: theme.node.muted }}
                                    {...hoverProps}
                                    aria-label={t("canvas.table.removeRow")}
                                    title={t("canvas.table.removeRow")}
                                    onMouseDown={stop}
                                    onPointerDown={stop}
                                    onClick={() => commit(rows.filter((item) => item.id !== row.id))}
                                >
                                    <Trash2 className="size-3.5" />
                                </button>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="flex h-full min-h-16 items-center justify-center px-4 text-center" style={{ color: theme.node.placeholder, fontSize: 12 }}>
                        {t("canvas.table.empty")}
                    </div>
                )}
            </div>

            <div className="px-3 pb-2.5">
                <button
                    type="button"
                    className="inline-flex h-7 w-full items-center justify-center gap-1 rounded-md transition"
                    style={{ ...flatButtonStyle, fontSize: 12 }}
                    aria-label={t("canvas.table.addRow")}
                    {...hoverProps}
                    onMouseDown={stop}
                    onPointerDown={stop}
                    onClick={() => commit([...rows, { id: nanoid(), prompt: "" }])}
                >
                    <Plus className="size-3.5" />
                    {t("canvas.table.addRow")}
                </button>
            </div>
        </div>
    );
}