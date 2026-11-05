import "fake-indexeddb/auto";
import { expect } from "vitest";
import { toHaveNoViolations } from "jest-axe";

// Register the jest-axe accessibility matcher with vitest's expect.
// jest-axe ships its matcher under a jest namespace, but it works fine
// as a plain matcher object — vitest's expect.extend accepts the same shape.
expect.extend(toHaveNoViolations);

// `localStorage` / `sessionStorage` shim for the test environment.
//
// Two failure modes this addresses:
//
// 1. **Node 22+ run without `--localstorage-file`** ships an experimental
//    built-in `localStorage` global that lacks `.getItem` / `.setItem` /
//    etc. JSDOM detects "user already provided localStorage" and skips
//    installing its own implementation, so `window.localStorage` ends up
//    pointing at the broken host stub. Module-init code that calls
//    `localStorage.getItem(...)` at import time (e.g. `settingsStore.ts`
//    hydrating saved state) then crashes with
//    `TypeError: localStorage.getItem is not a function`.
//
// 2. **Some vitest + JSDOM combinations** don't expose a working storage
//    global at all, regardless of Node version.
//
// The shim is installed unconditionally — it always replaces both
// `globalThis.{local,session}Storage` and `window.{local,session}Storage`
// with a small Map-backed implementation that satisfies the DOM Storage
// interface contract. This is simpler than detecting which failure mode
// is active and keeps test runs deterministic across Node / JSDOM
// versions.
function makeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string): string | null {
      return data.has(key) ? data.get(key)! : null;
    },
    key(index: number): string | null {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      data.delete(key);
    },
    setItem(key: string, value: string): void {
      data.set(key, String(value));
    },
  };
}

const localStorageShim = makeStorage();
const sessionStorageShim = makeStorage();
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageShim,
  writable: true,
  configurable: true,
});
Object.defineProperty(globalThis, "sessionStorage", {
  value: sessionStorageShim,
  writable: true,
  configurable: true,
});
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    value: localStorageShim,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "sessionStorage", {
    value: sessionStorageShim,
    writable: true,
    configurable: true,
  });
}

// jsdom does not implement document.execCommand — stub it so vi.spyOn can intercept it.
if (typeof document !== "undefined" && !("execCommand" in document)) {
  Object.defineProperty(document, "execCommand", {
    value: (_command: string) => false,
    writable: true,
    configurable: true,
  });
}

// jsdom does not implement window.matchMedia
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
