import "fake-indexeddb/auto";
import { afterEach, expect, vi } from "vitest";
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

// Async work that outlives its test (a promise settling after unmount, a
// timer firing after cleanup) surfaces as a run-level "Unhandled Rejection"
// with no test attached, sometimes after jsdom is torn down ("window is not
// defined"). Pin such errors to the test that was running, and give pending
// work a few turns after each test to settle while the DOM still exists, so a
// leak fails that test by name instead of the whole run anonymously.
const strayErrors: {test: string; error: unknown}[] = [];
const recordStray = (error: unknown) => {
  strayErrors.push({test: expect.getState().currentTestName ?? "(between tests)", error});
};
process.on("unhandledRejection", recordStray);
process.on("uncaughtException", recordStray);

afterEach(async () => {
  // Under fake timers setTimeout never fires on its own; skip the drain there.
  if (!vi.isFakeTimers()) {
    for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (!strayErrors.length) return;
  const found = strayErrors.splice(0);
  const detail = found
    .map(({test, error}) => `- ${test}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    .join("\n");
  throw new Error(`Unhandled async error(s) during this test:\n${detail}`);
});
