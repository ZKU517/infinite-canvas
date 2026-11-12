import { useEffect, useId, useMemo, useState } from "react";
import { Cpu } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { decodeChannelModel, modelOptionLabel, modelOptionName, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

type CanvasGroupedModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    className?: string;
    channelClassName?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
};

/**
 * Model picker that selects a channel first, then a model inside that channel.
 * Channel and model triggers stay inline, so a card with many models still fits one row.
 */
export function CanvasGroupedModelPicker({ config, value, onChange, capability, className, channelClassName, fullWidth = false, placeholder, onMissingConfig }: CanvasGroupedModelPickerProps) {
    const { t } = useTranslation();
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const current = value || "";
    const channels = useMemo(
        () =>
            config.channels
                .map((channel) => ({ channel, models: channel.models.filter((model) => !capability || model.capability === capability) }))
                .filter((entry) => entry.models.length > 0),
        [capability, config.channels],
    );
    const currentChannelId = decodeChannelModel(current)?.channelId;
    const [channelId, setChannelId] = useState(currentChannelId || channels[0]?.channel.id || "");

    // Follow external model changes (global default, retry metadata, channel switch elsewhere).
    useEffect(() => {
        if (currentChannelId && channels.some((entry) => entry.channel.id === currentChannelId)) {
            setChannelId(currentChannelId);
            return;
        }
        if (!channels.some((entry) => entry.channel.id === channelId)) setChannelId(channels[0]?.channel.id || "");
    }, [channelId, channels, currentChannelId]);

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    const activeChannel = channels.find((entry) => entry.channel.id === channelId) || channels[0];
    const models = activeChannel?.models.map((model) => activeChannel.channel.id + "::" + model.name) || [];
    const selectChannel = (nextChannelId: string) => {
        setChannelId(nextChannelId);
        const nextChannel = channels.find((entry) => entry.channel.id === nextChannelId);
        if (!nextChannel) return;
        // Keep the selected model when it belongs to the new channel; otherwise take its first model.
        const keepCurrent = decodeChannelModel(current)?.channelId === nextChannelId;
        if (!keepCurrent) onChange(nextChannel.channel.id + "::" + nextChannel.models[0].name);
    };
    const placeholderText = placeholder || t("settingsPanels.model.select");
    const emptyLabel = capability ? (config.models.length ? t("settingsPanels.model.assign", { capability: i18n.t("settingsPanels.model.capabilities." + capability) }) : t("settingsPanels.model.addFirst")) : t("settingsPanels.model.addFirst");

    return (
        <div className={cn("flex min-w-0 items-center gap-1", fullWidth && "w-full", className)}>
            {channels.length > 1 ? (
                <Select
                    value={activeChannel?.channel.id || ""}
                    onValueChange={selectChannel}
                    onOpenChange={(nextOpen) => {
                        if (nextOpen) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId + "-channel" }));
                    }}
                >
                    <SelectTrigger
                        className={cn("canvas-grouped-channel-picker h-8 w-fit max-w-[132px] shrink-0 gap-1 rounded-full border border-input bg-transparent px-2.5 text-xs font-normal shadow-sm transition-colors", channelClassName)}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        title={activeChannel?.channel.name || t("canvas.groupedModelPicker.channel")}
                    >
                        <span className="canvas-channel-picker-text min-w-0 truncate text-left">{activeChannel?.channel.name || t("canvas.groupedModelPicker.channel")}</span>
                    </SelectTrigger>
                    <SelectContent data-canvas-no-zoom className="z-[1200] w-64 max-w-[calc(100vw-24px)] rounded-xl border border-border/70 bg-popover p-1 shadow-xl" position="popper" align="start" side="bottom" sideOffset={6}>
                        {channels.map((entry) => (
                            <SelectItem key={entry.channel.id} value={entry.channel.id} textValue={entry.channel.name}>
                                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                                    <span className="truncate">{entry.channel.name}</span>
                                    <span className="shrink-0 text-xs opacity-50">{t("canvas.groupedModelPicker.models", { count: entry.models.length })}</span>
                                </span>
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            ) : null}
            <Select
                open={open}
                value={current}
                onOpenChange={(nextOpen) => {
                    if (nextOpen && !models.length && config.channelMode === "local") onMissingConfig?.();
                    if (nextOpen) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                    setOpen(nextOpen);
                }}
                onValueChange={onChange}
            >
                <SelectTrigger
                    className={cn(
                        "canvas-composer-model-picker h-8 min-w-0 gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors",
                        fullWidth ? "w-full justify-start" : "min-w-[9rem] max-w-full justify-start",
                        open && "border-ring ring-2 ring-ring/20",
                    )}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    title={current ? modelOptionLabel(config, current) : placeholderText}
                >
                    <ModelIcon model={current} />
                    <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{current ? modelOptionName(current) : placeholderText}</span>
                </SelectTrigger>
                <SelectContent data-canvas-no-zoom className="z-[1200] w-80 max-w-[calc(100vw-24px)] rounded-xl border border-border/70 bg-popover p-1 shadow-xl" position="popper" align="start" side="bottom" sideOffset={6}>
                    {models.length ? (
                        models.map((model) => (
                            <SelectItem key={model} value={model} textValue={modelOptionName(model)}>
                                <span className="flex min-w-0 items-center gap-2">
                                    <ModelIcon model={model} />
                                    <span className="truncate">{modelOptionName(model)}</span>
                                    {model === current ? <span className="shrink-0 text-xs opacity-45">{t("canvas.groupedModelPicker.current")}</span> : null}
                                </span>
                            </SelectItem>
                        ))
                    ) : (
                        <SelectItem value="__empty__" disabled>
                            {emptyLabel}
                        </SelectItem>
                    )}
                </SelectContent>
            </Select>
        </div>
    );
}

function ModelIcon({ model }: { model: string }) {
    const icon = resolveModelIcon(modelOptionName(model));
    return icon ? <img src={icon} alt="" className="size-4 shrink-0 dark:invert" /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm")) return "/icons/glm.svg";
    return "";
}
