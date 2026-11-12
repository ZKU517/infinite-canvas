import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Button, Modal, Slider, Tooltip } from "antd";
import { ArrowUpRight, Circle, Eraser, Hash, Minus, Pencil, Redo2, RotateCcw, Square, Type, Undo2, ZoomIn, ZoomOut } from "lucide-react";

import { readImageMeta } from "@/lib/image-utils";
import { useImageEditorViewport } from "@/components/canvas/use-image-editor-viewport";

type AnnotateTool = "pen" | "line" | "arrow" | "rect" | "ellipse" | "text" | "number" | "eraser";
type Point = { x: number; y: number };

type TextOp = { kind: "text"; color: string; fontSize: number; position: Point; text: string };
type NumberOp = { kind: "number"; color: string; radius: number; position: Point; number: number };

type AnnotateOp =
    | { kind: "stroke"; tool: "pen" | "eraser"; color: string; width: number; points: Point[] }
    | { kind: "shape"; shape: "line" | "arrow" | "rect" | "ellipse"; color: string; width: number; start: Point; end: Point }
    | TextOp
    | NumberOp;

type TextDraft = { clientX: number; clientY: number; imagePoint: Point; editingOp: TextOp | null };

const annotateColors = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ffffff", "#111827"];
const lightColors = new Set(["#f59e0b", "#ffffff"]);
const defaultColor = annotateColors[0];
const defaultWidth = 8;
const minWidth = 2;
const maxWidth = 40;
const fallbackTextSize = 72;
const minTextSize = 12;
const maxTextSize = 400;
const maxBackingLongEdge = 3072;
const maxBackingArea = 6_000_000;
const textFontFamily = '"SF Pro Display","PingFang SC","Microsoft YaHei",sans-serif';

export function CanvasNodeAnnotateDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (dataUrl: string) => void }) {
    const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
    const committedCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const imageRef = useRef<HTMLImageElement>(null);
    const cursorRef = useRef<HTMLDivElement>(null);
    const contextRef = useRef<CanvasRenderingContext2D | null>(null);
    const stageSizeRef = useRef({ width: 0, height: 0 });
    const imageSizeRef = useRef({ width: 0, height: 0 });
    const opsRef = useRef<AnnotateOp[]>([]);
    const undoStackRef = useRef<AnnotateOp[][]>([]);
    const redoStackRef = useRef<AnnotateOp[][]>([]);
    const previewOpRef = useRef<AnnotateOp | null>(null);
    const dragRef = useRef<{ mode: "draw" | "move-text"; pointerId: number; textOp?: TextOp; offset?: Point; recorded: boolean; moved: boolean } | null>(null);
    const activeTextRef = useRef<TextOp | null>(null);
    const rafRef = useRef<number | null>(null);
    const lastClientRef = useRef<{ x: number; y: number } | null>(null);
    const cursorVisibleRef = useRef(false);
    const toolRef = useRef<AnnotateTool>("pen");
    const colorRef = useRef(defaultColor);
    const widthRef = useRef(defaultWidth);
    const textSizeRef = useRef(fallbackTextSize);
    const sizeChangingRef = useRef(false);
    const textDraftRef = useRef<TextDraft | null>(null);
    const textInputRef = useRef<HTMLInputElement>(null);

    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [tool, setTool] = useState<AnnotateTool>("pen");
    const [color, setColor] = useState(defaultColor);
    const [lineWidth, setLineWidth] = useState(defaultWidth);
    const [textSize, setTextSize] = useState(fallbackTextSize);
    const [historySize, setHistorySize] = useState(0);
    const [redoSize, setRedoSize] = useState(0);
    const [error, setError] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
    const [textValue, setTextValue] = useState("");
    const viewport = useImageEditorViewport(image, open);
    const stageRef = viewport.stageRef;

    useEffect(() => {
        toolRef.current = tool;
    }, [tool]);
    useEffect(() => {
        colorRef.current = color;
    }, [color]);
    useEffect(() => {
        widthRef.current = lineWidth;
    }, [lineWidth]);

    useEffect(() => {
        if (!open) return;
        opsRef.current = [];
        undoStackRef.current = [];
        redoStackRef.current = [];
        previewOpRef.current = null;
        dragRef.current = null;
        activeTextRef.current = null;
        textDraftRef.current = null;
        setTool("pen");
        setColor(defaultColor);
        setLineWidth(defaultWidth);
        setTextSize(fallbackTextSize);
        textSizeRef.current = fallbackTextSize;
        sizeChangingRef.current = false;
        setHistorySize(0);
        setRedoSize(0);
        setError("");
        setSubmitting(false);
        setTextDraft(null);
        setTextValue("");
        if (cursorRef.current) cursorRef.current.style.opacity = "0";
        void readImageMeta(dataUrl).then((meta) => {
            imageSizeRef.current = { width: meta.width, height: meta.height };
            const adaptive = defaultTextSizeFor(meta.width, meta.height);
            textSizeRef.current = adaptive;
            setTextSize(adaptive);
            setImage({ width: meta.width, height: meta.height });
        });
    }, [dataUrl, open]);

    const render = useCallback(() => {
        rafRef.current = null;
        const overlay = overlayCanvasRef.current;
        const ctx = contextRef.current;
        const size = imageSizeRef.current;
        if (!overlay || !ctx || !size.width) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        const committed = committedCanvasRef.current;
        if (committed) ctx.drawImage(committed, 0, 0);
        ctx.setTransform(overlay.width / size.width, 0, 0, overlay.height / size.height, 0, 0);
        const preview = previewOpRef.current;
        if (preview) renderOp(ctx, preview);
        const active = activeTextRef.current;
        if (active) {
            const bounds = textBounds(active);
            ctx.save();
            ctx.setLineDash([6 * (size.width / overlay.width), 4 * (size.width / overlay.width)]);
            ctx.lineWidth = 2 * (size.width / overlay.width);
            ctx.strokeStyle = "#38bdf8";
            ctx.strokeRect(bounds.x - 4, bounds.y - 4, bounds.w + 8, bounds.h + 8);
            ctx.restore();
        }
        updateCursor();
    }, []);

    const scheduleRender = useCallback(() => {
        if (rafRef.current != null) return;
        rafRef.current = requestAnimationFrame(render);
    }, [render]);

    const updateCursor = useCallback(() => {
        const cursor = cursorRef.current;
        const client = lastClientRef.current;
        if (!cursor || !client) return;
        const size = imageSizeRef.current;
        const stage = stageSizeRef.current;
        const scale = size.width && stage.width ? stage.width / size.width : 1;
        const sizePx = Math.max(6, widthRef.current * scale);
        cursor.style.transform = `translate3d(${client.x}px, ${client.y}px, 0) translate(-50%, -50%)`;
        cursor.style.width = `${sizePx}px`;
        cursor.style.height = `${sizePx}px`;
        cursor.style.borderColor = colorRef.current;
        cursor.style.opacity = cursorVisibleRef.current && (toolRef.current === "pen" || toolRef.current === "eraser") ? "1" : "0";
    }, []);

    const rebuildCommitted = useCallback(() => {
        const committed = committedCanvasRef.current;
        const size = imageSizeRef.current;
        if (!committed || !size.width) return;
        const ctx = committed.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, committed.width, committed.height);
        ctx.setTransform(committed.width / size.width, 0, 0, committed.height / size.height, 0, 0);
        for (const op of opsRef.current) renderOp(ctx, op);
    }, []);

    const syncCanvasSize = useCallback(() => {
        const overlay = overlayCanvasRef.current;
        const stage = stageRef.current;
        const size = imageSizeRef.current;
        if (!overlay || !stage || !size.width) return false;
        const width = stage.clientWidth;
        const height = stage.clientHeight;
        if (!width || !height) return false;
        const backing = backingScale(width, height);
        const nextWidth = Math.max(1, Math.round(width * backing));
        const nextHeight = Math.max(1, Math.round(height * backing));
        stageSizeRef.current = { width, height };
        if (overlay.width !== nextWidth || overlay.height !== nextHeight) {
            overlay.width = nextWidth;
            overlay.height = nextHeight;
        }
        if (!committedCanvasRef.current) committedCanvasRef.current = document.createElement("canvas");
        const committed = committedCanvasRef.current;
        if (committed.width !== nextWidth || committed.height !== nextHeight) {
            committed.width = nextWidth;
            committed.height = nextHeight;
        }
        contextRef.current = overlay.getContext("2d");
        rebuildCommitted();
        render();
        return true;
    }, [rebuildCommitted, render, stageRef]);

    useEffect(() => {
        if (!open) return;
        const stage = stageRef.current;
        if (!stage) return;
        const observer = new ResizeObserver(() => syncCanvasSize());
        observer.observe(stage);
        syncCanvasSize();
        return () => observer.disconnect();
    }, [open, stageRef, syncCanvasSize]);

    const refreshCounts = useCallback(() => {
        setHistorySize(undoStackRef.current.length);
        setRedoSize(redoStackRef.current.length);
    }, []);

    const recordBeforeChange = useCallback(() => {
        undoStackRef.current.push(cloneOps(opsRef.current));
        redoStackRef.current = [];
        refreshCounts();
    }, [refreshCounts]);

    const commitOp = useCallback(
        (op: AnnotateOp) => {
            recordBeforeChange();
            opsRef.current.push(op);
            activeTextRef.current = op.kind === "text" ? op : null;
            rebuildCommitted();
            render();
            setError("");
        },
        [rebuildCommitted, recordBeforeChange, render],
    );

    const applyTextSize = (value: number) => {
        setTextSize(value);
        textSizeRef.current = value;
        const active = activeTextRef.current;
        if (!active) return;
        if (!sizeChangingRef.current) {
            recordBeforeChange();
            sizeChangingRef.current = true;
        }
        active.fontSize = value;
        rebuildCommitted();
        render();
    };

    const endTextSizeChange = () => {
        sizeChangingRef.current = false;
    };

    const undo = useCallback(() => {
        const previous = undoStackRef.current.pop();
        if (!previous) return;
        redoStackRef.current.push(cloneOps(opsRef.current));
        opsRef.current = previous;
        activeTextRef.current = null;
        rebuildCommitted();
        render();
        refreshCounts();
    }, [rebuildCommitted, refreshCounts, render]);

    const redo = useCallback(() => {
        const next = redoStackRef.current.pop();
        if (!next) return;
        undoStackRef.current.push(cloneOps(opsRef.current));
        opsRef.current = next;
        activeTextRef.current = null;
        rebuildCommitted();
        render();
        refreshCounts();
    }, [rebuildCommitted, refreshCounts, render]);

    const clearAll = () => {
        if (!opsRef.current.length) return;
        recordBeforeChange();
        opsRef.current = [];
        activeTextRef.current = null;
        rebuildCommitted();
        render();
    };

    const toImagePoint = (clientX: number, clientY: number): Point | null => {
        const stage = stageRef.current;
        const size = imageSizeRef.current;
        if (!stage || !size.width || !size.height) return null;
        const rect = stage.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return { x: ((clientX - rect.left) / rect.width) * size.width, y: ((clientY - rect.top) / rect.height) * size.height };
    };

    const hitTestText = (point: Point): TextOp | null => {
        for (let index = opsRef.current.length - 1; index >= 0; index -= 1) {
            const op = opsRef.current[index];
            if (op.kind !== "text") continue;
            const bounds = textBounds(op);
            const pad = Math.max(8, op.fontSize * 0.3);
            if (point.x >= bounds.x - pad && point.x <= bounds.x + bounds.w + pad && point.y >= bounds.y - pad && point.y <= bounds.y + bounds.h + pad) return op;
        }
        return null;
    };

    const openTextEditor = (clientX: number, clientY: number, point: Point, editingOp: TextOp | null) => {
        const draft: TextDraft = { clientX, clientY, imagePoint: point, editingOp };
        textDraftRef.current = draft;
        setTextDraft(draft);
        setTextValue(editingOp ? editingOp.text : "");
        requestAnimationFrame(() => textInputRef.current?.focus());
    };

    const startDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (event.button !== 0 || viewport.spacePressed) return;
        const point = toImagePoint(event.clientX, event.clientY);
        if (!point) return;
        event.preventDefault();
        event.stopPropagation();
        lastClientRef.current = { x: event.clientX, y: event.clientY };
        cursorVisibleRef.current = true;
        setError("");

        if (toolRef.current === "text") {
            const existing = hitTestText(point);
            if (existing) {
                activeTextRef.current = existing;
                event.currentTarget.setPointerCapture(event.pointerId);
                dragRef.current = { mode: "move-text", pointerId: event.pointerId, textOp: existing, offset: { x: point.x - existing.position.x, y: point.y - existing.position.y }, recorded: false, moved: false };
                scheduleRender();
                return;
            }
            openTextEditor(event.clientX, event.clientY, point, null);
            return;
        }

        if (toolRef.current === "number") {
            const maxNumber = opsRef.current.reduce((max, op) => (op.kind === "number" && op.number > max ? op.number : max), 0);
            commitOp({ kind: "number", color: colorRef.current, radius: Math.max(14, widthRef.current * 2.6), position: point, number: maxNumber + 1 });
            return;
        }

        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { mode: "draw", pointerId: event.pointerId, recorded: false, moved: false };
        previewOpRef.current = createPreviewOp(toolRef.current, point, point, colorRef.current, widthRef.current);
        scheduleRender();
    };

    const moveDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        lastClientRef.current = { x: event.clientX, y: event.clientY };
        cursorVisibleRef.current = true;
        const drag = dragRef.current;
        if (!drag) {
            scheduleRender();
            return;
        }
        const point = toImagePoint(event.clientX, event.clientY);
        if (!point) return;

        if (drag.mode === "move-text" && drag.textOp) {
            const textOp = drag.textOp;
            const nextX = point.x - (drag.offset?.x || 0);
            const nextY = point.y - (drag.offset?.y || 0);
            if (!drag.recorded) {
                recordBeforeChange();
                drag.recorded = true;
            }
            drag.moved = drag.moved || Math.abs(nextX - textOp.position.x) > 1 || Math.abs(nextY - textOp.position.y) > 1;
            textOp.position = { x: nextX, y: nextY };
            rebuildCommitted();
            scheduleRender();
            return;
        }

        const preview = previewOpRef.current;
        if (!preview) return;
        event.preventDefault();
        if (preview.kind === "stroke") {
            const nativeEvent = event.nativeEvent;
            const samples = typeof nativeEvent.getCoalescedEvents === "function" ? nativeEvent.getCoalescedEvents() : [nativeEvent];
            for (const sample of samples) {
                const samplePoint = toImagePoint(sample.clientX, sample.clientY);
                if (samplePoint) preview.points.push(samplePoint);
            }
            if (!samples.length) preview.points.push(point);
        } else if (preview.kind === "shape") {
            preview.end = point;
        }
        scheduleRender();
    };

    const stopDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (drag?.mode === "move-text") {
            if (!drag.moved) activeTextRef.current = drag.textOp || null;
            scheduleRender();
            return;
        }
        const preview = previewOpRef.current;
        previewOpRef.current = null;
        if (preview) {
            if (preview.kind === "stroke") {
                if (preview.points.length) commitOp(preview);
            } else if (preview.kind === "shape") {
                const dx = preview.end.x - preview.start.x;
                const dy = preview.end.y - preview.start.y;
                const threshold = Math.max(6, imageSizeRef.current.width * 0.005);
                if (Math.hypot(dx, dy) > threshold) commitOp(preview);
            }
        }
        scheduleRender();
    };

    const handleDoubleClick = (event: { clientX: number; clientY: number; preventDefault?: () => void }) => {
        if (toolRef.current !== "text") return;
        const point = toImagePoint(event.clientX, event.clientY);
        if (!point) return;
        const existing = hitTestText(point);
        if (existing) {
            event.preventDefault?.();
            openTextEditor(event.clientX, event.clientY, existing.position, existing);
        }
    };

    const commitText = () => {
        const draft = textDraftRef.current;
        const value = textValue.trim();
        textDraftRef.current = null;
        setTextDraft(null);
        setTextValue("");
        if (!draft) return;
        if (draft.editingOp) {
            recordBeforeChange();
            if (!value) {
                opsRef.current = opsRef.current.filter((op) => op !== draft.editingOp);
                activeTextRef.current = null;
            } else {
                draft.editingOp.text = value;
                activeTextRef.current = draft.editingOp;
            }
            rebuildCommitted();
            render();
            return;
        }
        if (!value) return;
        commitOp({ kind: "text", color: colorRef.current, fontSize: textSizeRef.current, position: draft.imagePoint, text: value });
    };

    useEffect(() => {
        if (!open) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("input,textarea,[contenteditable='true']")) return;
            const key = event.key.toLowerCase();
            const modifier = (event.metaKey || event.ctrlKey) && !event.altKey;
            if (modifier && !event.shiftKey && key === "z") {
                event.preventDefault();
                undo();
            } else if (modifier && ((event.shiftKey && key === "z") || (!event.shiftKey && key === "y"))) {
                event.preventDefault();
                redo();
            }
        };
        window.addEventListener("keydown", handleKeyDown, true);
        return () => window.removeEventListener("keydown", handleKeyDown, true);
    }, [open, redo, undo]);

    const exportImage = () => {
        const element = imageRef.current;
        const size = imageSizeRef.current;
        if (!element || !size.width || !size.height || !element.complete) return;
        if (!opsRef.current.length) {
            setError("请先在图片上绘制标注");
            return;
        }
        setSubmitting(true);
        try {
            const layer = document.createElement("canvas");
            layer.width = size.width;
            layer.height = size.height;
            const layerContext = layer.getContext("2d");
            if (layerContext) {
                for (const op of opsRef.current) renderOp(layerContext, op);
            }
            const canvas = document.createElement("canvas");
            canvas.width = size.width;
            canvas.height = size.height;
            const context = canvas.getContext("2d");
            if (context) {
                context.drawImage(element, 0, 0, size.width, size.height);
                context.drawImage(layer, 0, 0);
            }
            onConfirm(canvas.toDataURL("image/png"));
        } catch (exportError) {
            setSubmitting(false);
            setError(exportError instanceof Error ? exportError.message : String(exportError));
        }
    };

    const tools: Array<{ id: AnnotateTool; label: string; icon: ReactNode }> = [
        { id: "pen", label: "画笔", icon: <Pencil className="size-4" /> },
        { id: "line", label: "直线", icon: <Minus className="size-4" /> },
        { id: "arrow", label: "箭头", icon: <ArrowUpRight className="size-4" /> },
        { id: "rect", label: "矩形", icon: <Square className="size-4" /> },
        { id: "ellipse", label: "椭圆", icon: <Circle className="size-4" /> },
        { id: "text", label: "文字", icon: <Type className="size-4" /> },
        { id: "number", label: "序号", icon: <Hash className="size-4" /> },
        { id: "eraser", label: "橡皮", icon: <Eraser className="size-4" /> },
    ];

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={1040} centered destroyOnHidden transitionName="" maskTransitionName="">
            <div className="grid gap-5 lg:grid-cols-[minmax(420px,1fr)_300px]" data-canvas-no-zoom>
                <div
                    ref={viewport.viewportRef}
                    {...viewport.panHandlers}
                    className={`relative h-[min(70vh,760px)] min-h-[380px] rounded-xl border border-black/10 bg-transparent dark:border-white/10 ${viewport.scrollClassName} ${viewport.isPanning ? "cursor-grabbing" : viewport.spacePressed ? "cursor-grab" : ""}`}
                >
                    <div className="relative" style={viewport.contentStyle}>
                        <div ref={viewport.stageRef} className="absolute isolate overflow-hidden rounded-lg bg-transparent select-none [backface-visibility:hidden] [contain:layout_paint] [transform:translateZ(0)]" style={viewport.stageStyle}>
                            {image ? (
                                <>
                                    <div className="absolute left-0 top-0 [backface-visibility:hidden]" style={viewport.mediaStyle}>
                                        <img ref={imageRef} src={dataUrl} alt="" className="absolute inset-0 block h-full w-full bg-transparent object-contain" draggable={false} />
                                    </div>
                                    <canvas
                                        ref={overlayCanvasRef}
                                        className={`absolute inset-0 h-full w-full touch-none ${tool === "pen" || tool === "eraser" ? "cursor-none" : tool === "text" ? "cursor-text" : "cursor-crosshair"}`}
                                        onPointerDown={startDraw}
                                        onPointerMove={moveDraw}
                                        onPointerUp={stopDraw}
                                        onPointerCancel={stopDraw}
                                        onDoubleClick={handleDoubleClick}
                                        onPointerEnter={(event) => {
                                            lastClientRef.current = { x: event.clientX, y: event.clientY };
                                            cursorVisibleRef.current = true;
                                            scheduleRender();
                                        }}
                                        onPointerLeave={() => {
                                            if (dragRef.current) return;
                                            cursorVisibleRef.current = false;
                                            scheduleRender();
                                        }}
                                        onContextMenu={(event) => event.preventDefault()}
                                    />
                                </>
                            ) : null}
                        </div>
                    </div>
                </div>

                <div ref={cursorRef} className="pointer-events-none fixed left-0 top-0 z-[1100] rounded-full border-2 shadow-[0_0_0_1px_rgba(0,0,0,.75)]" style={{ opacity: 0, width: 0, height: 0, transform: "translate3d(-9999px,-9999px,0)" }} />

                {textDraft ? (
                    <input
                        ref={textInputRef}
                        value={textValue}
                        onChange={(event) => setTextValue(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                commitText();
                            } else if (event.key === "Escape") {
                                event.preventDefault();
                                textDraftRef.current = null;
                                setTextDraft(null);
                                setTextValue("");
                            }
                        }}
                        onBlur={commitText}
                        placeholder="输入标注文字，回车确认"
                        className="fixed z-[1100] w-64 rounded-md border-2 bg-white px-2 py-1 text-sm text-stone-900 shadow-lg outline-none"
                        style={{ left: textDraft.clientX + 8, top: textDraft.clientY + 8, borderColor: color }}
                    />
                ) : null}

                <div className="flex min-h-[380px] flex-col gap-4">
                    <div>
                        <h2 className="text-xl font-semibold">画笔标注</h2>
                        <div className="mt-2 text-sm opacity-60">{image ? `${image.width} x ${image.height}px` : "加载中…"}</div>
                        <div className="mt-2 text-xs leading-5 opacity-55">导出会新建「标注草图」节点，不改动原图。文字工具：单击添加、双击已有文字编辑、按住拖动移动；选中文字后可拖「文字大小」实时调整字号。序号按点击顺序自动递增。滚轮缩放 · 空格/中键拖动画面。</div>
                    </div>

                    <div className="grid grid-cols-4 gap-2">
                        {tools.map((item) => (
                            <Button key={item.id} type={tool === item.id ? "primary" : "default"} icon={item.icon} onClick={() => setTool(item.id)}>
                                {item.label}
                            </Button>
                        ))}
                    </div>

                    <div className="space-y-2">
                        <div className="text-sm font-medium opacity-75">颜色</div>
                        <div className="flex items-center gap-2">
                            {annotateColors.map((item) => (
                                <button
                                    key={item}
                                    type="button"
                                    aria-label={item}
                                    onClick={() => setColor(item)}
                                    className={`size-7 rounded-full border-2 transition ${color === item ? "scale-110 border-stone-900 dark:border-white" : "border-transparent"}`}
                                    style={{ background: item, boxShadow: item === "#ffffff" ? "inset 0 0 0 1px rgba(0,0,0,.2)" : undefined }}
                                />
                            ))}
                        </div>
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span className="font-medium opacity-75">线宽</span>
                            <span className="font-semibold">{lineWidth}px</span>
                        </div>
                        <Slider min={minWidth} max={maxWidth} step={1} value={lineWidth} onChange={setLineWidth} />
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span className="font-medium opacity-75">文字大小</span>
                            <span className="font-semibold">{textSize}px</span>
                        </div>
                        <Slider min={minTextSize} max={maxTextSize} step={2} value={textSize} onChange={applyTextSize} onChangeComplete={endTextSizeChange} />
                    </div>

                    <div className="flex items-center justify-between rounded-lg border border-black/10 px-2 py-1 dark:border-white/10">
                        <Tooltip title="撤销 (Ctrl/Cmd+Z)">
                            <Button type="text" icon={<Undo2 className="size-4" />} disabled={!historySize} onClick={undo} />
                        </Tooltip>
                        <Tooltip title="重做 (Ctrl/Cmd+Shift+Z)">
                            <Button type="text" icon={<Redo2 className="size-4" />} disabled={!redoSize} onClick={redo} />
                        </Tooltip>
                        <Tooltip title="清空标注">
                            <Button type="text" icon={<RotateCcw className="size-4" />} onClick={clearAll} disabled={!historySize} />
                        </Tooltip>
                        <div className="flex items-center gap-1">
                            <Button type="text" icon={<ZoomOut className="size-4" />} disabled={!viewport.canZoomOut} onClick={viewport.zoomOut} />
                            <button type="button" className="min-w-14 text-center text-xs font-semibold tabular-nums opacity-70" onClick={viewport.resetZoom}>
                                {Math.round(viewport.zoom * 100)}%
                            </button>
                            <Button type="text" icon={<ZoomIn className="size-4" />} disabled={!viewport.canZoomIn} onClick={viewport.zoomIn} />
                        </div>
                    </div>

                    {error ? <div className="text-xs font-medium text-[#ef4444]">{error}</div> : null}

                    <div className="mt-auto flex items-center justify-between gap-2">
                        <Button onClick={onClose}>取消</Button>
                        <Button type="primary" loading={submitting} onClick={exportImage}>
                            导出到画布
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function createPreviewOp(tool: AnnotateTool, start: Point, end: Point, color: string, width: number): AnnotateOp | null {
    if (tool === "pen" || tool === "eraser") return { kind: "stroke", tool, color, width, points: [start] };
    if (tool === "line" || tool === "arrow" || tool === "rect" || tool === "ellipse") return { kind: "shape", shape: tool, color, width, start, end };
    return null;
}

function renderOp(context: CanvasRenderingContext2D, op: AnnotateOp) {
    context.save();
    if (op.kind === "stroke") {
        context.lineCap = "round";
        context.lineJoin = "round";
        context.lineWidth = op.width;
        context.strokeStyle = op.color;
        context.fillStyle = op.color;
        context.globalCompositeOperation = op.tool === "eraser" ? "destination-out" : "source-over";
        const points = op.points;
        if (points.length === 1) {
            context.beginPath();
            context.arc(points[0].x, points[0].y, op.width / 2, 0, Math.PI * 2);
            context.fill();
        } else if (points.length > 1) {
            context.beginPath();
            context.moveTo(points[0].x, points[0].y);
            for (let index = 1; index < points.length; index += 1) {
                const previous = points[index - 1];
                const mid = { x: (previous.x + points[index].x) / 2, y: (previous.y + points[index].y) / 2 };
                context.quadraticCurveTo(previous.x, previous.y, mid.x, mid.y);
            }
            const last = points[points.length - 1];
            context.lineTo(last.x, last.y);
            context.stroke();
        }
    } else if (op.kind === "shape") {
        context.lineCap = "round";
        context.lineJoin = "round";
        context.lineWidth = op.width;
        context.strokeStyle = op.color;
        context.fillStyle = op.color;
        context.globalCompositeOperation = "source-over";
        const { start, end } = op;
        if (op.shape === "line") {
            context.beginPath();
            context.moveTo(start.x, start.y);
            context.lineTo(end.x, end.y);
            context.stroke();
        } else if (op.shape === "arrow") {
            drawArrow(context, start, end, op.width, op.color);
        } else if (op.shape === "rect") {
            context.strokeRect(Math.min(start.x, end.x), Math.min(start.y, end.y), Math.abs(end.x - start.x), Math.abs(end.y - start.y));
        } else {
            const cx = (start.x + end.x) / 2;
            const cy = (start.y + end.y) / 2;
            context.beginPath();
            context.ellipse(cx, cy, Math.abs(end.x - start.x) / 2, Math.abs(end.y - start.y) / 2, 0, 0, Math.PI * 2);
            context.stroke();
        }
    } else if (op.kind === "text") {
        context.globalCompositeOperation = "source-over";
        context.fillStyle = op.color;
        context.textBaseline = "top";
        context.font = fontFor(op.fontSize);
        context.fillText(op.text, op.position.x, op.position.y);
    } else {
        const { radius, color: badgeColor, position, number } = op;
        context.globalCompositeOperation = "source-over";
        context.beginPath();
        context.arc(position.x, position.y, radius, 0, Math.PI * 2);
        context.fillStyle = badgeColor;
        context.fill();
        context.lineWidth = Math.max(2, radius * 0.14);
        context.strokeStyle = "rgba(255,255,255,.92)";
        context.stroke();
        context.fillStyle = lightColors.has(badgeColor) ? "#111827" : "#ffffff";
        context.font = `700 ${Math.round(radius * 1.15)}px ${textFontFamily}`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(String(number), position.x, position.y + radius * 0.04);
    }
    context.restore();
}

function drawArrow(context: CanvasRenderingContext2D, start: Point, end: Point, width: number, color: string) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) return;
    const ux = dx / length;
    const uy = dy / length;
    const headLength = Math.min(Math.max(width * 4, length * 0.18), length * 0.55);
    const halfWidth = headLength * 0.52;
    const baseX = end.x - ux * headLength;
    const baseY = end.y - uy * headLength;
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(baseX, baseY);
    context.lineWidth = width;
    context.strokeStyle = color;
    context.lineCap = "round";
    context.stroke();
    context.beginPath();
    context.moveTo(end.x, end.y);
    context.lineTo(baseX - uy * halfWidth, baseY + ux * halfWidth);
    context.lineTo(baseX + uy * halfWidth, baseY - ux * halfWidth);
    context.closePath();
    context.fillStyle = color;
    context.fill();
}

function fontFor(fontSize: number) {
    return `600 ${fontSize}px ${textFontFamily}`;
}

let measureContext: CanvasRenderingContext2D | null = null;
function measureTextWidth(text: string, fontSize: number) {
    if (!measureContext) measureContext = document.createElement("canvas").getContext("2d");
    if (!measureContext) return text.length * fontSize * 0.6;
    measureContext.font = fontFor(fontSize);
    return measureContext.measureText(text).width;
}

function textBounds(op: TextOp) {
    return { x: op.position.x, y: op.position.y, w: Math.max(8, measureTextWidth(op.text, op.fontSize)), h: op.fontSize * 1.25 };
}

function cloneOps(ops: AnnotateOp[]): AnnotateOp[] {
    return ops.map((op) => {
        if (op.kind === "stroke") return { ...op, points: op.points.map((point) => ({ ...point })) };
        if (op.kind === "shape") return { ...op, start: { ...op.start }, end: { ...op.end } };
        if (op.kind === "text") return { ...op, position: { ...op.position } };
        return { ...op, position: { ...op.position } };
    });
}

function defaultTextSizeFor(width: number, height: number) {
    const base = Math.min(width || 0, height || 0) * 0.035;
    return Math.min(maxTextSize, Math.max(minTextSize, Math.round(base / 2) * 2));
}

function backingScale(width: number, height: number) {
    const dpr = typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const longEdge = Math.max(width, height, 1);
    let scale = Math.min(dpr, maxBackingLongEdge / longEdge);
    const area = width * height * scale * scale;
    if (area > maxBackingArea) scale = Math.sqrt(maxBackingArea / (width * height));
    return Math.max(0.5, scale);
}
