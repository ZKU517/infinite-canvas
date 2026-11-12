import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Input, Modal, Slider, Tooltip } from "antd";
import { Brush, Eraser, ImagePlus, Redo2, RotateCcw, Undo2, WandSparkles, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";

import { readImageMeta } from "@/lib/image-utils";
import { useImageEditorViewport } from "@/components/canvas/use-image-editor-viewport";

export type CanvasImageMaskEditPayload = {
    prompt: string;
    maskDataUrl: string;
    generate: boolean;
};

type DrawMode = "paint" | "erase";
type Point = { x: number; y: number };
type MaskStroke = { mode: DrawMode; size: number; points: Point[] };

const defaultBrushSize = 100;
const minBrushSize = 8;
const maxBrushSize = 160;
const maskOverlayColor = "#2563eb";
const maskOverlayAlpha = 0.4;
const maxBackingLongEdge = 3072;
const maxBackingArea = 6_000_000;

export function CanvasNodeMaskEditDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (payload: CanvasImageMaskEditPayload) => void }) {
    const { t } = useTranslation();
    const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
    const imageRef = useRef<HTMLImageElement>(null);
    const cursorRef = useRef<HTMLDivElement>(null);
    const cursorLabelRef = useRef<HTMLSpanElement>(null);
    const contextRef = useRef<CanvasRenderingContext2D | null>(null);
    const stageSizeRef = useRef({ width: 0, height: 0 });
    const imageSizeRef = useRef({ width: 0, height: 0 });
    const strokesRef = useRef<MaskStroke[]>([]);
    const redoRef = useRef<MaskStroke[]>([]);
    const activeStrokeRef = useRef<MaskStroke | null>(null);
    const renderedPointsRef = useRef(0);
    const drawingRef = useRef(false);
    const brushAdjustRef = useRef<{ pointerId: number; startX: number; startSize: number } | null>(null);
    const brushSizeRef = useRef(defaultBrushSize);
    const lastClientRef = useRef<{ x: number; y: number } | null>(null);
    const cursorVisibleRef = useRef(false);
    const rafRef = useRef<number | null>(null);
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [prompt, setPrompt] = useState("");
    const [brushSize, setBrushSize] = useState(defaultBrushSize);
    const [mode, setMode] = useState<DrawMode>("paint");
    const [error, setError] = useState("");
    const [historySize, setHistorySize] = useState(0);
    const [redoSize, setRedoSize] = useState(0);
    const [submitting, setSubmitting] = useState(false);
    const viewport = useImageEditorViewport(image, open);
    const stageRef = viewport.stageRef;

    useEffect(() => {
        brushSizeRef.current = brushSize;
    }, [brushSize]);

    const resetSession = useCallback(() => {
        if (rafRef.current != null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        strokesRef.current = [];
        redoRef.current = [];
        activeStrokeRef.current = null;
        renderedPointsRef.current = 0;
        drawingRef.current = false;
        brushAdjustRef.current = null;
        lastClientRef.current = null;
        cursorVisibleRef.current = false;
        setPrompt("");
        setBrushSize(defaultBrushSize);
        setMode("paint");
        setError("");
        setHistorySize(0);
        setRedoSize(0);
        setSubmitting(false);
        if (cursorRef.current) cursorRef.current.style.opacity = "0";
    }, []);

    useEffect(() => {
        if (!open) return;
        resetSession();
        void readImageMeta(dataUrl).then((meta) => {
            imageSizeRef.current = { width: meta.width, height: meta.height };
            setImage({ width: meta.width, height: meta.height });
        });
    }, [dataUrl, open, resetSession]);

    const replayAll = useCallback(() => {
        const canvas = overlayCanvasRef.current;
        const ctx = contextRef.current;
        const size = imageSizeRef.current;
        if (!canvas || !ctx || !size.width || !size.height) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(canvas.width / size.width, 0, 0, canvas.height / size.height, 0, 0);
        const all = activeStrokeRef.current ? [...strokesRef.current, activeStrokeRef.current] : strokesRef.current;
        for (const stroke of all) {
            applyStrokeStyle(ctx, stroke, maskOverlayColor);
            drawStrokePath(ctx, stroke);
        }
    }, []);

    const syncCanvasSize = useCallback(() => {
        const canvas = overlayCanvasRef.current;
        const stage = stageRef.current;
        const size = imageSizeRef.current;
        if (!canvas || !stage || !size.width || !size.height) return false;
        const width = stage.clientWidth;
        const height = stage.clientHeight;
        if (!width || !height) return false;
        const backing = backingScale(width, height);
        const nextWidth = Math.max(1, Math.round(width * backing));
        const nextHeight = Math.max(1, Math.round(height * backing));
        stageSizeRef.current = { width, height };
        if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
            canvas.width = nextWidth;
            canvas.height = nextHeight;
        }
        contextRef.current = canvas.getContext("2d");
        replayAll();
        return true;
    }, [replayAll, stageRef]);

    useEffect(() => {
        if (!open) return;
        const stage = stageRef.current;
        if (!stage) return;
        const observer = new ResizeObserver(() => syncCanvasSize());
        observer.observe(stage);
        syncCanvasSize();
        return () => observer.disconnect();
    }, [open, stageRef, syncCanvasSize]);

    const updateCursor = useCallback(() => {
        const cursor = cursorRef.current;
        const client = lastClientRef.current;
        if (!cursor || !client) return;
        const size = imageSizeRef.current;
        const stage = stageSizeRef.current;
        const scale = size.width && stage.width ? stage.width / size.width : 1;
        const sizePx = Math.max(4, brushSizeRef.current * scale);
        const adjusting = Boolean(brushAdjustRef.current);
        cursor.style.transform = `translate3d(${client.x}px, ${client.y}px, 0) translate(-50%, -50%)`;
        cursor.style.width = `${sizePx}px`;
        cursor.style.height = `${sizePx}px`;
        cursor.style.opacity = cursorVisibleRef.current ? "1" : "0";
        cursor.style.borderColor = adjusting ? "#fbbf24" : "rgba(255,255,255,.9)";
        const label = cursorLabelRef.current;
        if (label) {
            label.style.display = adjusting ? "block" : "none";
            if (adjusting) label.textContent = `${Math.round(brushSizeRef.current)}px`;
        }
    }, []);

    const flush = useCallback(() => {
        rafRef.current = null;
        const ctx = contextRef.current;
        const canvas = overlayCanvasRef.current;
        const size = imageSizeRef.current;
        const stroke = activeStrokeRef.current;
        if (ctx && canvas && size.width && size.height) {
            ctx.setTransform(canvas.width / size.width, 0, 0, canvas.height / size.height, 0, 0);
            if (stroke) {
                applyStrokeStyle(ctx, stroke, maskOverlayColor);
                drawStrokeIncremental(ctx, stroke, renderedPointsRef.current);
                renderedPointsRef.current = stroke.points.length;
            }
        }
        updateCursor();
    }, [updateCursor]);

    const scheduleFlush = useCallback(() => {
        if (rafRef.current != null) return;
        rafRef.current = requestAnimationFrame(flush);
    }, [flush]);

    const toImagePoint = (clientX: number, clientY: number) => {
        const stage = stageRef.current;
        const size = imageSizeRef.current;
        if (!stage || !size.width || !size.height) return null;
        const rect = stage.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return {
            x: ((clientX - rect.left) / rect.width) * size.width,
            y: ((clientY - rect.top) / rect.height) * size.height,
        };
    };

    const startDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const point = toImagePoint(event.clientX, event.clientY);
        if (!point) return;

        if ((event.button === 0 || event.button === 2) && event.altKey) {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            brushAdjustRef.current = { pointerId: event.pointerId, startX: event.clientX, startSize: brushSizeRef.current };
            lastClientRef.current = { x: event.clientX, y: event.clientY };
            cursorVisibleRef.current = true;
            scheduleFlush();
            return;
        }

        if (event.button !== 0 || viewport.spacePressed) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drawingRef.current = true;
        activeStrokeRef.current = { mode, size: brushSizeRef.current, points: [point] };
        renderedPointsRef.current = 0;
        lastClientRef.current = { x: event.clientX, y: event.clientY };
        cursorVisibleRef.current = true;
        if (mode === "paint") setError("");
        scheduleFlush();
    };

    const moveDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const adjusting = brushAdjustRef.current;
        if (adjusting && event.pointerId === adjusting.pointerId) {
            event.preventDefault();
            event.stopPropagation();
            const nextSize = clampBrushSize(adjusting.startSize + event.clientX - adjusting.startX);
            brushSizeRef.current = nextSize;
            lastClientRef.current = { x: adjusting.startX, y: event.clientY };
            scheduleFlush();
            return;
        }

        lastClientRef.current = { x: event.clientX, y: event.clientY };
        if (!drawingRef.current) {
            cursorVisibleRef.current = true;
            scheduleFlush();
            return;
        }
        const stroke = activeStrokeRef.current;
        if (!stroke) return;
        event.preventDefault();
        const nativeEvent = event.nativeEvent;
        const samples = typeof nativeEvent.getCoalescedEvents === "function" ? nativeEvent.getCoalescedEvents() : [nativeEvent];
        for (const sample of samples) {
            const point = toImagePoint(sample.clientX, sample.clientY);
            if (point) stroke.points.push(point);
        }
        if (!samples.length) {
            const point = toImagePoint(event.clientX, event.clientY);
            if (point) stroke.points.push(point);
        }
        scheduleFlush();
    };

    const stopDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const adjusting = brushAdjustRef.current;
        if (adjusting && event.pointerId === adjusting.pointerId) {
            brushAdjustRef.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            setBrushSize(brushSizeRef.current);
            scheduleFlush();
            return;
        }

        const stroke = activeStrokeRef.current;
        drawingRef.current = false;
        activeStrokeRef.current = null;
        renderedPointsRef.current = 0;
        if (stroke?.points.length) {
            const ctx = contextRef.current;
            const canvas = overlayCanvasRef.current;
            const size = imageSizeRef.current;
            if (ctx && canvas && size.width && size.height) {
                ctx.setTransform(canvas.width / size.width, 0, 0, canvas.height / size.height, 0, 0);
                applyStrokeStyle(ctx, stroke, maskOverlayColor);
                drawStrokePath(ctx, stroke);
            }
            strokesRef.current.push(stroke);
            redoRef.current = [];
            setHistorySize(strokesRef.current.length);
            setRedoSize(0);
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        scheduleFlush();
    };

    const undoMask = useCallback(() => {
        if (drawingRef.current || !strokesRef.current.length) return;
        const stroke = strokesRef.current.pop();
        if (stroke) redoRef.current.push(stroke);
        setHistorySize(strokesRef.current.length);
        setRedoSize(redoRef.current.length);
        replayAll();
        setError("");
    }, [replayAll]);

    const redoMask = useCallback(() => {
        if (drawingRef.current || !redoRef.current.length) return;
        const stroke = redoRef.current.pop();
        if (stroke) strokesRef.current.push(stroke);
        setHistorySize(strokesRef.current.length);
        setRedoSize(redoRef.current.length);
        replayAll();
        setError("");
    }, [replayAll]);

    const resetMask = () => {
        strokesRef.current = [];
        redoRef.current = [];
        activeStrokeRef.current = null;
        renderedPointsRef.current = 0;
        setHistorySize(0);
        setRedoSize(0);
        replayAll();
        setError("");
    };

    useEffect(() => {
        if (!open) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("input,textarea,[contenteditable='true']")) return;
            const key = event.key.toLowerCase();
            const modifier = (event.metaKey || event.ctrlKey) && !event.altKey;
            const isUndo = modifier && !event.shiftKey && key === "z";
            const isRedo = modifier && ((event.shiftKey && key === "z") || (!event.shiftKey && key === "y"));
            if (isUndo || isRedo) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                if (isRedo) redoMask();
                else undoMask();
                return;
            }
            if (modifier || event.altKey) return;
            if (key === "b") {
                event.preventDefault();
                setMode("paint");
            } else if (key === "e") {
                event.preventDefault();
                setMode("erase");
            } else if (key === "[" || key === "]") {
                event.preventDefault();
                const step = key === "]" ? 10 : -10;
                setBrushSize((current) => clampBrushSize(current + step));
            }
        };
        window.addEventListener("keydown", handleKeyDown, true);
        return () => window.removeEventListener("keydown", handleKeyDown, true);
    }, [open, redoMask, undoMask]);

    const submit = (generate: boolean) => {
        const nextPrompt = prompt.trim();
        if (!nextPrompt) return setError(t("canvas.editors.maskPromptRequired"));
        const strokes = activeStrokeRef.current?.points.length ? [...strokesRef.current, activeStrokeRef.current] : strokesRef.current;
        if (!strokes.some((stroke) => stroke.mode === "paint" && stroke.points.length)) return setError(t("canvas.editors.maskRequired"));
        const element = imageRef.current;
        const size = imageSizeRef.current;
        if (!element || !size.width || !size.height || !element.complete || !element.naturalWidth) return;
        setSubmitting(true);
        try {
            const maskCanvas = rasterizeStrokes(strokes, size.width, size.height);
            onConfirm({ prompt: nextPrompt, maskDataUrl: buildMaskOverlay(element, maskCanvas), generate });
        } catch (submitError) {
            setSubmitting(false);
            setError(submitError instanceof Error ? submitError.message : String(submitError));
        }
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={980} centered destroyOnHidden transitionName="" maskTransitionName="">
            <div className="grid gap-5 lg:grid-cols-[minmax(360px,1fr)_320px]" data-canvas-no-zoom>
                <div
                    ref={viewport.viewportRef}
                    {...viewport.panHandlers}
                    className={`relative h-[min(68vh,720px)] min-h-[360px] rounded-xl border border-black/10 bg-transparent dark:border-white/10 ${viewport.scrollClassName} ${viewport.isPanning ? "cursor-grabbing" : viewport.spacePressed ? "cursor-grab" : ""}`}
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
                                        className="absolute inset-0 h-full w-full cursor-none touch-none"
                                        style={{ opacity: maskOverlayAlpha }}
                                        onPointerDown={startDraw}
                                        onPointerMove={moveDraw}
                                        onPointerUp={stopDraw}
                                        onPointerCancel={stopDraw}
                                        onPointerEnter={(event) => {
                                            lastClientRef.current = { x: event.clientX, y: event.clientY };
                                            cursorVisibleRef.current = true;
                                            scheduleFlush();
                                        }}
                                        onPointerLeave={() => {
                                            if (drawingRef.current || brushAdjustRef.current) return;
                                            cursorVisibleRef.current = false;
                                            scheduleFlush();
                                        }}
                                        onContextMenu={(event) => event.preventDefault()}
                                    />
                                </>
                            ) : null}
                        </div>
                    </div>
                </div>

                <div ref={cursorRef} className="pointer-events-none fixed left-0 top-0 z-[1100] rounded-full border-2 shadow-[0_0_0_1px_rgba(0,0,0,.8)]" style={{ opacity: 0, width: 0, height: 0, transform: "translate3d(-9999px,-9999px,0)", borderColor: "rgba(255,255,255,.9)" }}>
                    <span ref={cursorLabelRef} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded bg-black/75 px-1.5 py-0.5 text-xs font-semibold text-white" style={{ display: "none" }} />
                </div>

                <div className="flex min-h-[360px] flex-col gap-5">
                    <div>
                        <h2 className="text-xl font-semibold">{t("canvas.editors.maskTitle")}</h2>
                        <div className="mt-2 text-sm opacity-60">{image ? `${image.width} x ${image.height}px` : t("canvas.editors.loading")}</div>
                        <div className="mt-2 text-xs leading-5 opacity-55">{t("canvas.editors.maskHint")}</div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <Button type={mode === "paint" ? "primary" : "default"} icon={<Brush className="size-4" />} onClick={() => setMode("paint")}>
                            {t("canvas.editors.brush")}
                        </Button>
                        <Button type={mode === "erase" ? "primary" : "default"} icon={<Eraser className="size-4" />} onClick={() => setMode("erase")}>
                            {t("canvas.editors.erase")}
                        </Button>
                    </div>

                    <div className="flex items-center justify-between rounded-lg border border-black/10 px-2 py-1 dark:border-white/10">
                        <Tooltip title={t("canvas.editors.undoMaskTitle")}>
                            <Button type="text" icon={<Undo2 className="size-4" />} disabled={!historySize} aria-label={t("canvas.editors.undoMask")} onClick={undoMask} />
                        </Tooltip>
                        <Tooltip title={t("canvas.editors.redoMaskTitle")}>
                            <Button type="text" icon={<Redo2 className="size-4" />} disabled={!redoSize} aria-label={t("canvas.editors.redoMask")} onClick={redoMask} />
                        </Tooltip>
                        <div className="flex items-center gap-1">
                            <Tooltip title={t("canvas.editors.zoomOut")}>
                                <Button type="text" icon={<ZoomOut className="size-4" />} disabled={!viewport.canZoomOut} aria-label={t("canvas.editors.zoomOut")} onClick={viewport.zoomOut} />
                            </Tooltip>
                            <button type="button" className="min-w-14 text-center text-xs font-semibold tabular-nums opacity-70" onClick={viewport.resetZoom}>
                                {Math.round(viewport.zoom * 100)}%
                            </button>
                            <Tooltip title={t("canvas.editors.zoomIn")}>
                                <Button type="text" icon={<ZoomIn className="size-4" />} disabled={!viewport.canZoomIn} aria-label={t("canvas.editors.zoomIn")} onClick={viewport.zoomIn} />
                            </Tooltip>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span className="font-medium opacity-75">{t("canvas.editors.brushSize")}</span>
                            <span className="font-semibold">{brushSize}px</span>
                        </div>
                        <Slider min={minBrushSize} max={maxBrushSize} step={2} value={brushSize} onChange={setBrushSize} />
                    </div>

                    <div className="space-y-2">
                        <div className="text-sm font-medium opacity-75">{t("canvas.editors.editInstructions")}</div>
                        <Input.TextArea
                            rows={6}
                            value={prompt}
                            status={error && !prompt.trim() ? "error" : undefined}
                            placeholder={t("canvas.editors.maskPlaceholder")}
                            onChange={(event) => {
                                setPrompt(event.target.value);
                                setError("");
                            }}
                        />
                        {error ? <div className="text-xs font-medium text-[#ef4444]">{error}</div> : null}
                    </div>

                    <div className="mt-auto flex items-center justify-between gap-2">
                        <Button icon={<RotateCcw className="size-4" />} onClick={resetMask}>
                            {t("canvas.editors.reset")}
                        </Button>
                        <div className="flex items-center gap-2">
                            <Button icon={<ImagePlus className="size-4" />} loading={submitting} onClick={() => submit(false)}>
                                {t("canvas.editors.maskExport")}
                            </Button>
                            <Button type="primary" icon={<WandSparkles className="size-4" />} loading={submitting} onClick={() => submit(true)}>
                                {t("canvas.editors.maskGenerate")}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function backingScale(width: number, height: number) {
    const dpr = typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const longEdge = Math.max(width, height, 1);
    let scale = Math.min(dpr, maxBackingLongEdge / longEdge);
    const area = width * height * scale * scale;
    if (area > maxBackingArea) scale = Math.sqrt(maxBackingArea / (width * height));
    return Math.max(0.5, scale);
}

function clampBrushSize(value: number) {
    return Math.min(maxBrushSize, Math.max(minBrushSize, Math.round(value / 2) * 2));
}

function midpoint(a: Point, b: Point): Point {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function applyStrokeStyle(context: CanvasRenderingContext2D, stroke: MaskStroke, color: string) {
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = stroke.size;
    context.globalCompositeOperation = stroke.mode === "paint" ? "source-over" : "destination-out";
    context.strokeStyle = color;
    context.fillStyle = color;
}

function drawStrokePath(context: CanvasRenderingContext2D, stroke: MaskStroke) {
    const points = stroke.points;
    if (!points.length) return;
    if (points.length === 1) {
        context.beginPath();
        context.arc(points[0].x, points[0].y, stroke.size / 2, 0, Math.PI * 2);
        context.fill();
        return;
    }
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
        const mid = midpoint(points[index - 1], points[index]);
        context.quadraticCurveTo(points[index - 1].x, points[index - 1].y, mid.x, mid.y);
    }
    const last = points[points.length - 1];
    context.lineTo(last.x, last.y);
    context.stroke();
}

// 只绘制尚未画出的笔迹段（与 drawStrokePath 的曲线算法一致，避免重绘整笔）。
function drawStrokeIncremental(context: CanvasRenderingContext2D, stroke: MaskStroke, renderedPoints: number) {
    const points = stroke.points;
    if (points.length === 1 && renderedPoints === 0) {
        context.beginPath();
        context.arc(points[0].x, points[0].y, stroke.size / 2, 0, Math.PI * 2);
        context.fill();
        return;
    }
    for (let index = Math.max(1, renderedPoints); index < points.length; index += 1) {
        const previous = points[index - 1];
        const start = index >= 2 ? midpoint(points[index - 2], points[index - 1]) : previous;
        const end = midpoint(previous, points[index]);
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.quadraticCurveTo(previous.x, previous.y, end.x, end.y);
        context.stroke();
    }
}

function rasterizeStrokes(strokes: MaskStroke[], width: number, height: number) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const context = canvas.getContext("2d");
    if (!context) return canvas;
    for (const stroke of strokes) {
        applyStrokeStyle(context, stroke, "#000");
        drawStrokePath(context, stroke);
    }
    return canvas;
}

function buildMaskOverlay(image: HTMLImageElement, selectionCanvas: HTMLCanvasElement) {
    const canvas = document.createElement("canvas");
    canvas.width = selectionCanvas.width;
    canvas.height = selectionCanvas.height;
    const context = canvas.getContext("2d");
    if (!context) return selectionCanvas.toDataURL("image/png");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const overlay = document.createElement("canvas");
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    const overlayContext = overlay.getContext("2d");
    if (!overlayContext) return canvas.toDataURL("image/png");
    overlayContext.drawImage(selectionCanvas, 0, 0);
    overlayContext.globalCompositeOperation = "source-in";
    overlayContext.fillStyle = maskOverlayColor;
    overlayContext.fillRect(0, 0, overlay.width, overlay.height);
    context.globalAlpha = maskOverlayAlpha;
    context.drawImage(overlay, 0, 0);
    return canvas.toDataURL("image/png");
}
