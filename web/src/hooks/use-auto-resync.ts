import { useEffect } from "react";

import { rehydrateStores } from "@/lib/rehydrate";

// 换设备/多标签接力编辑的静默同步：
// - 标签页重新获得焦点/回到前台时，自动拉取最新数据（主路径，避免切回后第一次保存被版本锁拦截）。
// - 写入发生版本冲突（409/412/428）时，兜底自动拉取最新数据。
// rehydrate 成功后会重新读取各 store：清除写锁、更新版本号，之后即可继续保存。
export function useAutoResync() {
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let lastSyncAt = 0;

        const scheduleSync = (force: boolean) => {
            if (!force && Date.now() - lastSyncAt < 1500) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(
                () => {
                    timer = null;
                    lastSyncAt = Date.now();
                    void rehydrateStores().catch(() => {});
                },
                force ? 0 : 400,
            );
        };

        const onConflict = () => scheduleSync(true);
        const onFocus = () => scheduleSync(false);
        const onVisible = () => {
            if (document.visibilityState === "visible") scheduleSync(false);
        };

        window.addEventListener("ic:data-conflict", onConflict);
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onVisible);

        return () => {
            if (timer) clearTimeout(timer);
            window.removeEventListener("ic:data-conflict", onConflict);
            window.removeEventListener("focus", onFocus);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, []);
}
