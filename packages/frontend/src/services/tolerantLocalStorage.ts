import { createJSONStorage, type StateStorage } from "zustand/middleware";

function local(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * localStorage for persisted stores that never throws. When the browser
 * refuses a write (storage full, blocked or in a restricted mode), the state
 * stays in memory for this session instead of failing the action that changed
 * it: choosing a city, finishing setup or changing a setting keeps working.
 */
export const tolerantLocalStorage: StateStorage = {
  getItem: (name) => {
    try {
      return local()?.getItem(name) ?? null;
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      local()?.setItem(name, value);
    } catch {
      // Not stored: kept for this session only.
    }
  },
  removeItem: (name) => {
    try {
      local()?.removeItem(name);
    } catch {
      // Nothing to remove when storage is unavailable.
    }
  },
};

export function createTolerantJSONStorage<S>() {
  return createJSONStorage<S>(() => tolerantLocalStorage);
}
