import { create } from "zustand";

export type AuthUser = { id: string; username: string; createdAt: string; admin?: boolean };

type AuthStore = {
    user: AuthUser | null;
    status: "loading" | "ready";
    fetchMe: () => Promise<AuthUser | null>;
    login: (username: string, password: string) => Promise<AuthUser>;
    register: (username: string, password: string) => Promise<AuthUser>;
    changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
    logout: () => Promise<void>;
};

async function authFetch(path: string, init?: RequestInit) {
    const res = await fetch(path, {
        ...init,
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
        const code = typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
        throw new Error(code);
    }
    return data;
}

export function authErrorMessage(code: string) {
    switch (code) {
        case "invalid_credentials":
            return "用户名或密码错误";
        case "username_taken":
            return "用户名已被占用";
        case "invalid_username":
            return "用户名格式不正确（3-32 位字母、数字、_ 或 -）";
        case "invalid_password":
            return "密码至少 8 位";
        case "registration_disabled":
            return "注册已关闭";
        default:
            return code || "操作失败";
    }
}

export const useAuthStore = create<AuthStore>()((set) => ({
    user: null,
    status: "loading",
    fetchMe: async () => {
        try {
            const res = await fetch("/api/auth/me", { credentials: "include" });
            if (!res.ok) {
                set({ user: null, status: "ready" });
                return null;
            }
            const data = (await res.json()) as { user: AuthUser };
            set({ user: data.user, status: "ready" });
            return data.user;
        } catch {
            set({ user: null, status: "ready" });
            return null;
        }
    },
    login: async (username, password) => {
        const data = (await authFetch("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) })) as { user: AuthUser };
        set({ user: data.user, status: "ready" });
        return data.user;
    },
    register: async (username, password) => {
        const data = (await authFetch("/api/auth/register", { method: "POST", body: JSON.stringify({ username, password }) })) as { user: AuthUser };
        set({ user: data.user, status: "ready" });
        return data.user;
    },
    changePassword: async (currentPassword, newPassword) => {
        await authFetch("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
    },
    logout: async () => {
        try {
            await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
        } catch {
            /* ignore */
        }
        set({ user: null, status: "ready" });
    },
}));

if (typeof window !== "undefined") {
    window.addEventListener("ic:unauthorized", () => useAuthStore.setState({ user: null, status: "ready" }));
}
