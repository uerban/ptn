import { createJSONStorage, type StateStorage } from "zustand/middleware";

/**
 * The page's localStorage, or undefined when it is missing or reading the
 * property throws (blocked storage, sandboxed or opaque-origin frames).
 */
export function safeLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

let refusedWrites = 0;

/**
 * How many writes through `tolerantLocalStorage` storage has refused so far.
 * Compare two readings to learn whether the writes in between were stored.
 */
export function refusedWriteCount(): number {
  return refusedWrites;
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
      return safeLocalStorage()?.getItem(name) ?? null;
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      const storage = safeLocalStorage();
      if (storage) storage.setItem(name, value);
      else refusedWrites++;
    } catch {
      // Not stored: kept for this session only.
      refusedWrites++;
    }
  },
  removeItem: (name) => {
    try {
      safeLocalStorage()?.removeItem(name);
    } catch {
      // Nothing to remove when storage is unavailable.
    }
  },
};

export function createTolerantJSONStorage<S>() {
  return createJSONStorage<S>(() => tolerantLocalStorage);
}
