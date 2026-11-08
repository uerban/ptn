import Dexie from "dexie";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { db } from "../db/index.ts";
import {
  clearDownloadedData,
  deletePersonalHistory,
  isPtnOwnedCacheName,
  isPtnOwnedStorageKey,
  resetPtnCompletely,
  unregisterPtnServiceWorker,
  type CacheStorageLike,
} from "./dataDeletion.ts";
import { walkGraphClient } from "./walkGraphClient.ts";
import { getOrFetchWalkRoute, peekWalkRoute } from "./walkRouteCache.ts";
import {openWalkGraphStore, getStoredWalkGraph} from "./walkGraphStore.ts";

function fakeCaches(initial: string[]): {
  storage: CacheStorageLike;
  remaining: Set<string>;
} {
  const remaining = new Set(initial);
  return {
    remaining,
    storage: {
      keys: vi.fn(async () => [...remaining]),
      delete: vi.fn(async (name: string) => remaining.delete(name)),
    },
  };
}

async function seedUserRows(): Promise<void> {
  await db.recentLocations.put({
    id: "recent",
    endpoint: { kind: "stop", stopId: "s1", name: "Stop", lat: 1, lon: 2 },
    usedAt: 1,
    usedAsOrigin: true,
  } as never);
  await db.savedLocations.put({
    id: "saved",
    endpoint: { kind: "stop", stopId: "s1", name: "Stop", lat: 1, lon: 2 },
    alias: "Home",
    savedAt: 1,
    encrypted: false,
  } as never);
  await db.usageStats.put({ stopId: "s1", tapCount: 1, lastTapped: 1 });
}

describe("privacy data deletion boundaries", () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await db.delete();
    await db.open();
  });

  it("deletes personal history while preserving public downloads and settings", async () => {
    await seedUserRows();
    await db.stops.put({
      id: "s1",
      name: "Stop",
      location: { lat: 1, lon: 2 },
      lastSeen: Date.now(),
    });
    localStorage.setItem("ptn-map-viewport", "viewport");
    localStorage.setItem("ptn-delay-reports", "reports");
    localStorage.setItem("ptn-favorites", "favorites");
    localStorage.setItem("ptn-settings", "settings");

    await deletePersonalHistory();

    expect(await db.recentLocations.count()).toBe(0);
    expect(await db.savedLocations.count()).toBe(0);
    expect(await db.usageStats.count()).toBe(0);
    expect(await db.stops.count()).toBe(1);
    expect(localStorage.getItem("ptn-map-viewport")).toBeNull();
    expect(localStorage.getItem("ptn-delay-reports")).toBeNull();
    expect(localStorage.getItem("ptn-favorites")).toBeNull();
    expect(localStorage.getItem("ptn-settings")).toBe("settings");
  });

  it("clears every server-derived table and only PTN-owned caches", async () => {
    await seedUserRows();
    await db.stops.put({
      id: "s1",
      name: "Stop",
      location: { lat: 1, lon: 2 },
      lastSeen: Date.now(),
    });
    await db.gtfsStops.put({ id: "g1", name: "GTFS", lat: 1, lon: 2 });
    await db.offlineCities.put({cityId: "vilnius", city: {id: "vilnius"} as never, preparedAt: 1, sizeBytes: 1, tables: {}});
    await db.offlineCityMetadata.put({cityId: "vilnius", state: "legacy"});
    await db.offlineTransfers.put({hash: "transfer", bytes: new Uint8Array([1])});
    await db.cityShapes.put({hash: "shape", bytes: new Uint8Array([2])});
    const caches = fakeCaches([
      "api-general-cache",
      "carto-tiles",
      `workbox-precache-v2-${location.origin}/`,
      `workbox-precache-v2-${location.origin}/another-app/`,
      "another-app-cache",
    ]);

    await clearDownloadedData({
      cacheStorage: caches.storage,
      ptnScope: `${location.origin}/`,
      stopDownloadedRuntime: vi.fn(async () => {}),
    });

    expect(await db.stops.count()).toBe(0);
    expect(await db.gtfsStops.count()).toBe(0);
    expect(await db.offlineCities.count()).toBe(0);
    expect(await db.offlineCityMetadata.count()).toBe(0);
    expect(await db.offlineTransfers.count()).toBe(0);
    expect(await db.cityShapes.count()).toBe(0);
    expect(await db.recentLocations.count()).toBe(1);
    expect(await db.savedLocations.count()).toBe(1);
    expect(await db.usageStats.count()).toBe(1);
    expect([...caches.remaining]).toEqual([
      `workbox-precache-v2-${location.origin}/another-app/`,
      "another-app-cache",
    ]);
  });

  it.each(["downloaded", "complete"])("clears the separate graph cache during %s cleanup", async mode => {
    const database = await openWalkGraphStore();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction("graphs", "readwrite");
      tx.objectStore("graphs").put({cityId: "oslo"});
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    database.close();
    const cacheStorage = fakeCaches([]).storage;
    if (mode === "downloaded") await clearDownloadedData({cacheStorage, stopDownloadedRuntime: async () => {}});
    else await resetPtnCompletely({cacheStorage, stopRuntime: async () => {}, resetMemory: () => {}, reload: () => {}});
    expect(await getStoredWalkGraph("oslo")).toBeUndefined();
  });

  it("complete reset clears network decisions and the setup record, so setup runs next launch", async () => {
    localStorage.setItem("ptn-onboarding", JSON.stringify({ version: 1 }));
    localStorage.setItem("ptn-network-decisions", JSON.stringify({ state: { decisions: {} }, version: 1 }));
    localStorage.setItem("ptn-realtime-availability", "{}");
    await resetPtnCompletely({
      localStorage,
      sessionStorage,
      cacheStorage: fakeCaches([]).storage,
      stopRuntime: async () => {},
      resetMemory: () => {},
      reload: () => {},
    });
    expect(localStorage.getItem("ptn-onboarding")).toBeNull();
    expect(localStorage.getItem("ptn-network-decisions")).toBeNull();
    const { classifyInstallation } = await import("./installClassifier.ts");
    const result = classifyInstallation(localStorage);
    expect(result.status).toBe("classified");
    if (result.status === "classified") expect(result.record.install.kind).toBe("new");
    localStorage.clear();
  });

  it("complete reset removes only PTN keys/caches, deletes the DB, and reloads", async () => {
    await seedUserRows();
    localStorage.setItem("ptn-settings", "owned");
    localStorage.setItem("unrelated", "keep");
    sessionStorage.setItem("ptn_debug", "1");
    sessionStorage.setItem("other-session", "keep");
    const caches = fakeCaches(["carto-style", "other-cache"]);
    const stopRuntime = vi.fn(async () => {});
    const resetMemory = vi.fn();
    const reload = vi.fn();

    await resetPtnCompletely({
      localStorage,
      sessionStorage,
      cacheStorage: caches.storage,
      stopRuntime,
      resetMemory,
      reload,
    });

    expect(stopRuntime).toHaveBeenCalledOnce();
    expect(resetMemory).toHaveBeenCalledOnce();
    expect(await Dexie.exists("ptn")).toBe(false);
    expect(localStorage.getItem("ptn-settings")).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("keep");
    expect(sessionStorage.getItem("ptn_debug")).toBeNull();
    expect(sessionStorage.getItem("other-session")).toBe("keep");
    expect([...caches.remaining]).toEqual(["other-cache"]);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("uses explicit ownership allowlists", () => {
    expect(isPtnOwnedCacheName("carto-tiles")).toBe(true);
    expect(isPtnOwnedCacheName("api-stops-cache-v1")).toBe(true);
    expect(isPtnOwnedCacheName("api-stops-cache")).toBe(true);
    const ownScope = `${location.origin}/`;
    expect(
      isPtnOwnedCacheName(`workbox-precache-v2-${ownScope}`, ownScope),
    ).toBe(true);
    expect(
      isPtnOwnedCacheName(
        `workbox-precache-v2-${location.origin}/another-app/`,
        ownScope,
      ),
    ).toBe(false);
    expect(isPtnOwnedCacheName("photos-cache")).toBe(false);
    expect(isPtnOwnedStorageKey("ptn-settings")).toBe(true);
    expect(isPtnOwnedStorageKey("ptn:dataSchemaVersion")).toBe(true);
    expect(isPtnOwnedStorageKey("ptn_debug")).toBe(true);
    expect(isPtnOwnedStorageKey("another-app")).toBe(false);
  });

  it("unregisters only the service worker for PTN's own scope", async () => {
    const unregisterOwn = vi.fn(async () => true);
    const unregisterOther = vi.fn(async () => true);
    await unregisterPtnServiceWorker({
      getRegistrations: async () => [
        { scope: `${location.origin}/`, unregister: unregisterOwn },
        {
          scope: `${location.origin}/another-app/`,
          unregister: unregisterOther,
        },
      ],
    });
    expect(unregisterOwn).toHaveBeenCalledOnce();
    expect(unregisterOther).not.toHaveBeenCalled();
  });

  it("complete reset frees the walk graph and forgets cached walk routes", async () => {
    const from = { lat: 54.68, lon: 25.28 };
    const to = { lat: 54.681, lon: 25.281 };
    const route = { coords: [[25.28, 54.68], [25.281, 54.681]] as [number, number][], distanceMeters: 130, steps: [] };
    await getOrFetchWalkRoute("vilnius", from, to, "default", { routeFor: async () => route });
    expect(peekWalkRoute("vilnius", from, to, "default")).toBe(route);
    const destroy = vi.spyOn(walkGraphClient, "destroy");
    try {
      // No stopRuntime override: the real stopPtnRuntime runs.
      await resetPtnCompletely({
        localStorage,
        sessionStorage,
        cacheStorage: fakeCaches([]).storage,
        resetMemory: vi.fn(),
        reload: vi.fn(),
      });
      expect(destroy).toHaveBeenCalledOnce();
      expect(peekWalkRoute("vilnius", from, to, "default")).toBeUndefined();
    } finally {
      destroy.mockRestore();
    }
  });
});
