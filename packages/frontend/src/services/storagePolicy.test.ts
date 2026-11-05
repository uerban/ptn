import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  PERSIST_FLAG_KEY,
  __resetStoragePolicyForTests,
  evictionPriority,
  hasEvictor,
  onQuotaNear,
  registerEvictor,
  requestPersist,
  startWatchdog,
  notifyWriteGrew,
} from "./storagePolicy.ts";

vi.mock("./errorReporter.ts", () => ({
  reportError: vi.fn(),
  reportTelemetry: vi.fn(),
}));
import { reportTelemetry } from "./errorReporter.ts";

interface FakeStorageManager {
  estimate: () => Promise<StorageEstimate>;
  persist: () => Promise<boolean>;
  persisted: () => Promise<boolean>;
}

function installFakeStorage(opts: {
  usage?: number;
  quota?: number;
  persist?: () => Promise<boolean>;
}): { manager: FakeStorageManager; persistSpy: ReturnType<typeof vi.fn> } {
  const persistSpy = vi.fn(opts.persist ?? (() => Promise.resolve(true)));
  const manager: FakeStorageManager = {
    estimate: () =>
      Promise.resolve({ usage: opts.usage ?? 0, quota: opts.quota ?? 1_000_000 }),
    persist: persistSpy as unknown as () => Promise<boolean>,
    persisted: () => Promise.resolve(false),
  };
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: manager,
  });
  return { manager, persistSpy };
}

function clearFakeStorage(): void {
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: undefined,
  });
}

beforeEach(() => {
  __resetStoragePolicyForTests();
  globalThis.localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  clearFakeStorage();
});

describe("evictionPriority", () => {
  test("returns scheduleTileCache first, then poiTileCache, geocoderDedup, addressSearch, poiIndex", () => {
    const order = evictionPriority();
    expect(order).toEqual([
      "scheduleTileCache",
      "poiTileCache",
      "geocoderDedup",
      "walkGraphArtifacts",
      "addressSearch",
      "poiIndex",
    ]);
  });

  test("does not include protected buckets (recentLocations, savedLocations)", () => {
    const order = evictionPriority();
    expect(order).not.toContain("recentLocations");
    expect(order).not.toContain("savedLocations");
  });
});

describe("onQuotaNear", () => {
  test("runs evictions in priority order until usage drops below threshold", async () => {
    const calls: string[] = [];
    let usage = 950_000;
    installFakeStorage({ usage, quota: 1_000_000 });
    registerEvictor("poiTileCache", async () => {
      calls.push("poiTileCache");
      usage = 900_000;
    });
    registerEvictor("geocoderDedup", async () => {
      calls.push("geocoderDedup");
      usage = 800_000;
    });
    registerEvictor("poiIndex", async () => {
      calls.push("poiIndex");
      usage = 100_000;
    });
    // re-install with a dynamic estimate so each call sees the latest usage
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        estimate: () => Promise.resolve({ usage, quota: 1_000_000 }),
        persist: () => Promise.resolve(true),
        persisted: () => Promise.resolve(false),
      },
    });

    const evicted = await onQuotaNear();
    // poiTileCache → geocoderDedup, then under threshold (0.8 < 0.85)
    expect(evicted).toEqual(["poiTileCache", "geocoderDedup"]);
    expect(calls).toEqual(["poiTileCache", "geocoderDedup"]);
  });

  test("never evicts protected buckets even when registered", async () => {
    const calls: string[] = [];
    let usage = 990_000;
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        estimate: () => Promise.resolve({ usage, quota: 1_000_000 }),
        persist: () => Promise.resolve(true),
        persisted: () => Promise.resolve(false),
      },
    });
    expect(() =>
      registerEvictor(
        // @ts-expect-error — protected buckets cannot be registered
        "recentLocations",
        async () => calls.push("recentLocations"),
      ),
    ).toThrow(/protected/i);
    expect(() =>
      registerEvictor(
        // @ts-expect-error — protected buckets cannot be registered
        "savedLocations",
        async () => calls.push("savedLocations"),
      ),
    ).toThrow(/protected/i);

    registerEvictor("poiTileCache", async () => {
      calls.push("poiTileCache");
      usage = 100_000;
    });
    await onQuotaNear();
    expect(calls).toEqual(["poiTileCache"]);
  });

  test("returns [] and does nothing when usage is below threshold", async () => {
    installFakeStorage({ usage: 100_000, quota: 1_000_000 });
    const spy = vi.fn();
    registerEvictor("poiTileCache", async () => spy());
    const evicted = await onQuotaNear();
    expect(evicted).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  test("emits storage.evicted telemetry with the evicted buckets when an eviction runs", async () => {
    let usage = 950_000;
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        estimate: () => Promise.resolve({ usage, quota: 1_000_000 }),
        persist: () => Promise.resolve(true),
        persisted: () => Promise.resolve(false),
      },
    });
    registerEvictor("poiTileCache", async () => {
      usage = 100_000;
    });

    await onQuotaNear();

    expect(reportTelemetry).toHaveBeenCalledWith(
      "storage.evicted",
      expect.objectContaining({ buckets: ["poiTileCache"] }),
    );
  });

  test("emits no telemetry when usage is below threshold", async () => {
    installFakeStorage({ usage: 100_000, quota: 1_000_000 });
    registerEvictor("poiTileCache", async () => {});

    await onQuotaNear();

    expect(reportTelemetry).not.toHaveBeenCalled();
  });
});

describe("requestPersist", () => {
  test("fires navigator.storage.persist on first call", async () => {
    const { persistSpy } = installFakeStorage({});
    const result = await requestPersist();
    expect(result).toBe(true);
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(globalThis.localStorage.getItem(PERSIST_FLAG_KEY)).not.toBeNull();
  });

  test("does not fire a second time within the same install", async () => {
    const { persistSpy } = installFakeStorage({});
    await requestPersist();
    await requestPersist();
    await requestPersist();
    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  test("does not fire before any save (i.e. requestPersist is the explicit gate)", async () => {
    const { persistSpy } = installFakeStorage({});
    // startWatchdog must not request persistence by itself
    await startWatchdog();
    expect(persistSpy).not.toHaveBeenCalled();
    // notifyWriteGrew must not request persistence by itself either
    await notifyWriteGrew();
    expect(persistSpy).not.toHaveBeenCalled();
  });

  test("returns false (without throwing) when navigator.storage.persist is unavailable", async () => {
    clearFakeStorage();
    const result = await requestPersist();
    expect(result).toBe(false);
    // Flag is still set so we never retry the missing API every save.
    expect(globalThis.localStorage.getItem(PERSIST_FLAG_KEY)).not.toBeNull();
  });
});

describe("hasEvictor", () => {
  test("returns false before any evictor is registered for that bucket", () => {
    expect(hasEvictor("scheduleTileCache")).toBe(false);
  });

  test("returns true after registerEvictor for that bucket", () => {
    expect(hasEvictor("scheduleTileCache")).toBe(false);
    registerEvictor("scheduleTileCache", async () => {});
    expect(hasEvictor("scheduleTileCache")).toBe(true);
  });

  test("returns false for a bucket that has not been registered even if others have", () => {
    registerEvictor("poiTileCache", async () => {});
    expect(hasEvictor("scheduleTileCache")).toBe(false);
    expect(hasEvictor("poiTileCache")).toBe(true);
  });
});

describe("startWatchdog and notifyWriteGrew", () => {
  test("startWatchdog triggers eviction when boot sees high usage", async () => {
    let usage = 950_000;
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        estimate: () => Promise.resolve({ usage, quota: 1_000_000 }),
        persist: () => Promise.resolve(true),
        persisted: () => Promise.resolve(false),
      },
    });
    const evictSpy = vi.fn(async () => {
      usage = 100_000;
    });
    registerEvictor("poiTileCache", evictSpy);
    await startWatchdog();
    expect(evictSpy).toHaveBeenCalledTimes(1);
  });

  test("notifyWriteGrew triggers eviction when post-write usage crosses threshold", async () => {
    let usage = 950_000;
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        estimate: () => Promise.resolve({ usage, quota: 1_000_000 }),
        persist: () => Promise.resolve(true),
        persisted: () => Promise.resolve(false),
      },
    });
    const evictSpy = vi.fn(async () => {
      usage = 100_000;
    });
    registerEvictor("poiTileCache", evictSpy);
    await notifyWriteGrew();
    expect(evictSpy).toHaveBeenCalledTimes(1);
  });

  test("startWatchdog is a no-op when navigator.storage is unavailable", async () => {
    clearFakeStorage();
    const evictSpy = vi.fn();
    registerEvictor("poiTileCache", evictSpy);
    await expect(startWatchdog()).resolves.toBeUndefined();
    expect(evictSpy).not.toHaveBeenCalled();
  });
});
