import type { StateStorage } from "zustand/middleware";

import { remoteStateStorage } from "@/lib/remote-storage";

// 所有通过该 StateStorage 持久化的 zustand store（canvas/asset/plugin）统一走服务端存储。
export const localForageStorage: StateStorage = remoteStateStorage;
