import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import { AppProviders } from "@/components/layout/app-providers";
import "@/i18n";
import { initAnalytics } from "@/lib/analytics";
import { rehydrateStores } from "@/lib/rehydrate";
import { hasStorageFailure, storageFailureTargets } from "@/lib/remote-storage";
import { router } from "@/router";
import { useAuthStore } from "@/stores/use-auth-store";

initAnalytics();

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

function renderApp() {
    createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
            <AppProviders>
                <RouterProvider router={router} />
            </AppProviders>
        </React.StrictMode>,
    );
}

// 数据加载失败时不要进入应用：此时任何自动保存都可能把服务器上的数据覆盖成空。
function renderStorageError(targets: string[]) {
    const root = document.getElementById("root");
    if (!root) return;
    root.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.style.cssText = "min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,'PingFang SC','Microsoft YaHei',sans-serif;background:#fafaf9;color:#1c1917;";
    const card = document.createElement("div");
    card.style.cssText = "max-width:560px;border:1px solid #e7e5e4;border-radius:16px;padding:24px;background:#fff;box-shadow:0 10px 30px rgba(0,0,0,.06);";
    const title = document.createElement("div");
    title.textContent = "数据加载失败，已暂停写入";
    title.style.cssText = "font-size:18px;font-weight:600;margin-bottom:8px;";
    const desc = document.createElement("div");
    desc.textContent = "为避免把服务器上的画布数据覆盖成空数据，本次加载未成功时不会保存任何改动。常见原因：网络抖动、浏览器扩展拦截请求或会话失效。请恢复网络后重新加载。";
    desc.style.cssText = "font-size:14px;line-height:1.7;color:#57534e;";
    const meta = document.createElement("div");
    meta.textContent = targets.join("　");
    meta.style.cssText = "font-size:12px;color:#a8a29e;margin-top:12px;word-break:break-all;";
    const button = document.createElement("button");
    button.textContent = "重新加载";
    button.style.cssText = "margin-top:18px;height:36px;padding:0 18px;border-radius:8px;border:none;background:#1c1917;color:#fff;font-size:14px;cursor:pointer;";
    button.onclick = () => window.location.reload();
    card.append(title, desc, meta, button);
    wrap.appendChild(card);
    root.appendChild(wrap);
}

async function bootstrap() {
    const user = await useAuthStore.getState().fetchMe();
    if (user) {
        // 已有会话：确保各 store 以登录态完成 hydrate。
        await rehydrateStores().catch(() => undefined);
        if (hasStorageFailure()) {
            renderStorageError(storageFailureTargets());
            return;
        }
    }
    renderApp();
}

void bootstrap();
