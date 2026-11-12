import { useAssetStore } from "@/stores/use-asset-store";
import { useConfigStore } from "@/stores/use-config-store";
import { usePluginStore } from "@/stores/canvas/use-plugin-store";
import { usePromptSourceStore } from "@/stores/use-prompt-source-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

// 登录后重新从服务端拉取各持久化 store（登录前它们以未认证状态 hydrate 为空）。
export async function rehydrateStores() {
    await Promise.all([
        useCanvasStore.persist.rehydrate(),
        useAssetStore.persist.rehydrate(),
        useConfigStore.persist.rehydrate(),
        usePromptSourceStore.persist.rehydrate(),
        usePluginStore.persist.rehydrate(),
    ]);
}
