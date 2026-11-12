import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { useAuthStore } from "@/stores/use-auth-store";

export function RequireAuth({ children }: { children: ReactNode }) {
    const user = useAuthStore((state) => state.user);
    const status = useAuthStore((state) => state.status);

    if (status === "loading") return null;
    if (!user) return <Navigate to="/login" replace />;
    return <>{children}</>;
}
