import { useEffect, useMemo, useState } from "react";
import { Button, InputNumber, Modal } from "antd";
import { Combine } from "lucide-react";
import { useTranslation } from "react-i18next";

import { MAX_STITCH_PIXELS, MAX_STITCH_SIZE } from "@/lib/canvas/canvas-image-data";
import type { CanvasNodeData, CanvasNodeSplitGrid } from "@/types/canvas";

const maxGridSize = 12;

export type CanvasStitchGrid = {
    rows: number;
    columns: number;
};

export function buildStitchGridCells(nodes: CanvasNodeData[], grid: CanvasStitchGrid): (CanvasNodeData | null)[] {
    const cells: (CanvasNodeData | null)[] = Array.from({ length: grid.rows * grid.columns }, () => null);
    const pending: CanvasNodeData[] = [];
    nodes.forEach((node) => {
        const splitGrid = node.metadata?.splitGrid;
        const index = splitGrid && splitGrid.row >= 0 && splitGrid.row < grid.rows && splitGrid.column >= 0 && splitGrid.column < grid.columns ? splitGrid.row * grid.columns + splitGrid.column : -1;
        if (index >= 0 && !cells[index]) cells[index] = node;
        else pending.push(node);
    });
    pending.forEach((node) => {
        const index = cells.findIndex((cell) => !cell);
        if (index >= 0) cells[index] = node;
    });
    return cells;
}

export function CanvasNodeStitchDialog({ nodes, open, onClose, onConfirm }: { nodes: CanvasNodeData[]; open: boolean; onClose: () => void; onConfirm: (grid: CanvasStitchGrid) => void }) {
    const { t } = useTranslation();
    const [grid, setGrid] = useState<CanvasStitchGrid>({ rows: 1, columns: 1 });
    const hasSplitGrid = nodes.some((node) => Boolean(node.metadata?.splitGrid));
    const cells = useMemo(() => buildStitchGridCells(nodes, grid), [nodes, grid]);
    const missing = cells.filter((cell) => !cell).length;
    const outputSize = useMemo(() => measureStitchOutputSize(cells, grid), [cells, grid]);
    const tooLarge = outputSize.width > MAX_STITCH_SIZE || outputSize.height > MAX_STITCH_SIZE || outputSize.width * outputSize.height > MAX_STITCH_PIXELS;

    useEffect(() => {
        if (open) setGrid(inferStitchGrid(nodes));
    }, [nodes, open]);

    const updateGrid = (key: "rows" | "columns", value: string | number | null) => {
        const count = Math.min(maxGridSize, Math.max(1, Math.round(Number(value) || 1)));
        setGrid((current) => ({ ...current, [key]: count }));
    };

    return (
        <Modal title={null} open={open && nodes.length > 0} onCancel={onClose} footer={null} width={780} centered destroyOnHidden transitionName="" maskTransitionName="">
            <div className="space-y-5" data-canvas-no-zoom>
                <div>
                    <h2 className="text-xl font-semibold">{t("canvas.editors.stitchTitle")}</h2>
                    <p className="mt-1 text-sm opacity-60">{t("canvas.editors.stitchDescription")}</p>
                    <p className="mt-2 text-xs leading-5 opacity-55">{t("canvas.editors.stitchHint")}</p>
                </div>
                <div className="grid gap-6 md:grid-cols-[minmax(260px,1fr)_280px]">
                    <div className="rounded-xl border p-4">
                        <div className="mb-3 flex items-center justify-between text-sm">
                            <span className="opacity-60">{t("canvas.editors.stitchPreview")}</span>
                            <span className="font-semibold tabular-nums">{grid.rows + " x " + grid.columns}</span>
                        </div>
                        <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))` }}>
                            {cells.map((cell, index) => (
                                <div key={index} className={`relative aspect-square overflow-hidden rounded-md ${cell?.metadata?.content ? "border bg-black/5" : "border border-dashed bg-black/[0.02]"}`}>
                                    {cell?.metadata?.content ? (
                                        <img src={cell.metadata.content} alt="" className="size-full object-cover" draggable={false} />
                                    ) : (
                                        <span className="absolute inset-0 flex items-center justify-center p-1 text-center text-[11px] leading-4 opacity-45">{t("canvas.editors.stitchMissingHint")}</span>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="space-y-5 py-2">
                        <NumberField label={t("canvas.editors.stitchRows")} value={grid.rows} onChange={(value) => updateGrid("rows", value)} />
                        <NumberField label={t("canvas.editors.stitchColumns")} value={grid.columns} onChange={(value) => updateGrid("columns", value)} />
                        {hasSplitGrid ? null : <p className="rounded-lg border border-dashed px-3 py-2 text-xs leading-5 opacity-60">{t("canvas.editors.stitchFallback")}</p>}
                        <div className="rounded-xl border px-4 py-3 text-sm">
                            <div className="flex items-center justify-between">
                                <span className="opacity-60">{t("canvas.editors.stitchGrid")}</span>
                                <span className="font-semibold tabular-nums">{grid.rows + " x " + grid.columns}</span>
                            </div>
                            {missing > 0 ? (
                                <div className="mt-2 flex items-center justify-between gap-3 text-amber-600 dark:text-amber-400">
                                    <span>{t("canvas.editors.stitchMissing", { count: missing })}</span>
                                    <span className="shrink-0 text-xs opacity-80">{t("canvas.editors.stitchMissingHint")}</span>
                                </div>
                            ) : null}
                            <div className="mt-2 flex items-center justify-between">
                                <span className="opacity-60">{t("canvas.editors.stitchOutputSize")}</span>
                                <span className={`font-semibold tabular-nums ${tooLarge ? "text-red-500" : ""}`}>{outputSize.width + " x " + outputSize.height + " px"}</span>
                            </div>
                            {tooLarge ? <p className="mt-2 text-xs leading-5 text-red-500">{t("canvas.editors.stitchTooLarge")}</p> : null}
                        </div>
                        <Button type="primary" size="large" className="w-full" icon={<Combine className="size-4" />} onClick={() => onConfirm(grid)}>
                            {t("canvas.editors.stitchConfirm")}
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function inferStitchGrid(nodes: CanvasNodeData[]): CanvasStitchGrid {
    const grids = nodes.map((node) => node.metadata?.splitGrid).filter((grid): grid is CanvasNodeSplitGrid => Boolean(grid));
    if (grids.length) return { rows: Math.max(...grids.map((grid) => grid.rows)), columns: Math.max(...grids.map((grid) => grid.columns)) };
    const count = Math.max(1, nodes.length);
    const columns = count <= 4 ? Math.min(2, count) : Math.ceil(Math.sqrt(count));
    return { rows: Math.ceil(count / columns), columns };
}

function measureStitchOutputSize(cells: (CanvasNodeData | null)[], grid: CanvasStitchGrid) {
    const columnWidths = Array.from({ length: grid.columns }, () => 0);
    const rowHeights = Array.from({ length: grid.rows }, () => 0);
    cells.forEach((cell, index) => {
        if (!cell) return;
        const row = Math.floor(index / grid.columns);
        const column = index % grid.columns;
        columnWidths[column] = Math.max(columnWidths[column], cell.metadata?.naturalWidth || cell.width);
        rowHeights[row] = Math.max(rowHeights[row], cell.metadata?.naturalHeight || cell.height);
    });
    return { width: columnWidths.reduce((total, value) => total + value, 0), height: rowHeights.reduce((total, value) => total + value, 0) };
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: string | number | null) => void }) {
    return (
        <label className="block space-y-2">
            <span className="font-medium opacity-75">{label}</span>
            <InputNumber className="w-full" min={1} max={maxGridSize} precision={0} value={value} onChange={onChange} />
        </label>
    );
}
