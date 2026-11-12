import { useCallback, useEffect, useState } from "react";
import { App, Button, Card, Empty, InputNumber, Switch, Tag, Tooltip } from "antd";
import { Camera, DatabaseBackup, RotateCcw } from "lucide-react";

type SnapshotConfig = { enabled: boolean; intervalMinutes: number; keep: number };
type SnapshotItem = { name: string; kind: string; createdAt: string; files: number; bytes: number };

const kindLabels: Record<string, string> = { auto: "自动", manual: "手动", "pre-restore": "恢复前", unknown: "其它" };
const kindColors: Record<string, string> = { auto: "blue", manual: "green", "pre-restore": "orange", unknown: "default" };

function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "-";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(value: string) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("zh-CN", { hour12: false });
}

export function BackupSettingsPanel() {
    const { message, modal } = App.useApp();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [creating, setCreating] = useState(false);
    const [restoring, setRestoring] = useState<string | null>(null);
    const [config, setConfig] = useState<SnapshotConfig>({ enabled: true, intervalMinutes: 60, keep: 24 });
    const [snapshots, setSnapshots] = useState<SnapshotItem[]>([]);

    const load = useCallback(async () => {
        try {
            const res = await fetch("/api/admin/snapshots", { credentials: "include" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as { config: SnapshotConfig; snapshots: SnapshotItem[] };
            setConfig(data.config);
            setSnapshots(data.snapshots || []);
        } catch (error) {
            message.error(`读取快照信息失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setLoading(false);
        }
    }, [message]);

    useEffect(() => {
        void load();
    }, [load]);

    const saveConfig = async () => {
        setSaving(true);
        try {
            const res = await fetch("/api/admin/snapshots/config", {
                method: "PUT",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(config),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as { config: SnapshotConfig };
            setConfig(data.config);
            message.success("快照设置已保存");
        } catch (error) {
            message.error(`保存失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setSaving(false);
        }
    };

    const createNow = async () => {
        setCreating(true);
        try {
            const res = await fetch("/api/admin/snapshots", { method: "POST", credentials: "include" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as { snapshots: SnapshotItem[] };
            setSnapshots(data.snapshots || []);
            message.success("已创建快照");
        } catch (error) {
            message.error(`创建快照失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setCreating(false);
        }
    };

    const restore = (item: SnapshotItem) => {
        modal.confirm({
            title: `恢复到 ${formatTime(item.createdAt)} 的快照？`,
            content: "恢复会用该快照覆盖当前数据（恢复前会先自动备份当前数据）。恢复后请刷新页面；其他正在编辑的设备/标签页会因为版本不一致而无法保存。",
            okText: "确认恢复",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                setRestoring(item.name);
                try {
                    const res = await fetch("/api/admin/snapshots/restore", {
                        method: "POST",
                        credentials: "include",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name: item.name }),
                    });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const data = (await res.json()) as { snapshots: SnapshotItem[] };
                    setSnapshots(data.snapshots || []);
                    message.success("已恢复到该快照，请刷新页面");
                } catch (error) {
                    message.error(`恢复失败：${error instanceof Error ? error.message : String(error)}`);
                } finally {
                    setRestoring(null);
                }
            },
        });
    };

    return (
        <Card
            className="mt-6"
            title={
                <span className="flex items-center gap-2">
                    <DatabaseBackup className="size-4" />
                    备份与快照
                </span>
            }
            loading={loading}
        >
            <div className="space-y-4">
                <div className="text-xs leading-5 text-stone-500">
                    快照会保存整个数据目录（画布/素材/配置/账号），采用硬链接实现：未变化的图片不会重复占用空间，只会多占发生改动的 JSON。自动快照按设定间隔在服务端运行；「数据写入版本锁」保证任何设备/标签页都无法盲目覆盖服务器数据。
                </div>

                <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                    <span className="flex items-center gap-2 text-sm">
                        <Switch checked={config.enabled} onChange={(enabled) => setConfig((current) => ({ ...current, enabled }))} />
                        启用自动快照
                    </span>
                    <span className="flex items-center gap-2 text-sm">
                        间隔
                        <InputNumber min={1} max={10080} value={config.intervalMinutes} onChange={(value) => setConfig((current) => ({ ...current, intervalMinutes: Number(value) || 60 }))} />
                        分钟
                    </span>
                    <span className="flex items-center gap-2 text-sm">
                        保留
                        <InputNumber min={1} max={200} value={config.keep} onChange={(value) => setConfig((current) => ({ ...current, keep: Number(value) || 24 }))} />
                        份
                    </span>
                    <Button type="primary" loading={saving} onClick={() => void saveConfig()}>
                        保存设置
                    </Button>
                    <Button icon={<Camera className="size-4" />} loading={creating} onClick={() => void createNow()}>
                        立即快照
                    </Button>
                </div>

                <div className="rounded-lg border border-black/10 dark:border-white/10">
                    {snapshots.length ? (
                        <div className="divide-y divide-black/5 dark:divide-white/5">
                            {snapshots.map((item) => (
                                <div key={item.name} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                                    <span className="flex min-w-0 items-center gap-2">
                                        <Tag color={kindColors[item.kind] || "default"} className="!m-0">
                                            {kindLabels[item.kind] || item.kind}
                                        </Tag>
                                        <span className="truncate font-medium">{formatTime(item.createdAt)}</span>
                                        <span className="text-xs text-stone-400">
                                            {item.files} 个文件 · {formatBytes(item.bytes)}
                                        </span>
                                    </span>
                                    <span className="flex items-center gap-2">
                                        <Tooltip title="用该快照覆盖当前数据（会先自动备份当前数据）">
                                            <Button size="small" icon={<RotateCcw className="size-3.5" />} loading={restoring === item.name} onClick={() => restore(item)}>
                                                恢复
                                            </Button>
                                        </Tooltip>
                                    </span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <Empty description="暂无快照" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                    )}
                </div>
            </div>
        </Card>
    );
}
