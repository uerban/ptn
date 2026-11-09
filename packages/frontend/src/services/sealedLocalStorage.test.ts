import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { db } from "../db/index.ts";
import { __resetInstallKeyCacheForTests } from "./installKey.ts";
import { __resetDegradedModeForTests } from "./installKeyDegrade.ts";
import { __resetPersonalStorageForTests } from "./personalStorage.ts";
import {
  __resetSealedLocalStorageForTests,
  isSealedValue,
  mapViewportItem,
  readSealedItem,
  removeSealedItem,
  writeSealedItem,
} from "./sealedLocalStorage.ts";
import { DELAY_REPORTS_STORAGE_KEY, MAP_VIEWPORT_STORAGE_KEY } from "./privacyStorageKeys.ts";
import { LEGACY_FAVORITES_KEY } from "./favoritesMigration.ts";
import { useFavoritesStore } from "../stores/favoritesStore.ts";
import { useDelayReportStore } from "../stores/delayReportStore.ts";
import {
  findLeaks,
  rawLocalStorageText,
  resetPersonalStorage,
} from "../test-helpers/personalStorage.ts";

const KEYS = [LEGACY_FAVORITES_KEY, DELAY_REPORTS_STORAGE_KEY, MAP_VIEWPORT_STORAGE_KEY];

function reload(): void {
  __resetInstallKeyCacheForTests();
  __resetDegradedModeForTests();
  __resetPersonalStorageForTests();
  __resetSealedLocalStorageForTests();
}

beforeEach(async () => {
  for (const k of KEYS) localStorage.removeItem(k);
  await resetPersonalStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sealed localStorage values", () => {
  it("stores favorites sealed and restores them after a reload", async () => {
    await useFavoritesStore.persist.rehydrate();
    useFavoritesStore.getState().addFavorite({
      name: "Dom",
      type: "home",
      location: { lat: 54.3521, lon: 18.6464 },
    });
    await vi.waitFor(() => {
      expect(isSealedValue(localStorage.getItem(LEGACY_FAVORITES_KEY))).toBe(true);
    });
    expect(findLeaks(rawLocalStorageText(), ["Dom", "54.3521", "home"])).toEqual([]);

    reload();
    useFavoritesStore.setState({ favorites: [] });
    await useFavoritesStore.persist.rehydrate();
    expect(useFavoritesStore.getState().favorites.map((f) => f.name)).toEqual(["Dom"]);
  });

  it("stores delay reports sealed", async () => {
    await useDelayReportStore.persist.rehydrate();
    useDelayReportStore.getState().addReport({
      tripId: "trip-9",
      routeId: "R-130",
      routeShortName: "130",
      timestamp: Date.now(),
      category: "major",
      location: { lat: 54.3999, lon: 18.5777 },
    });
    await vi.waitFor(() => {
      expect(isSealedValue(localStorage.getItem(DELAY_REPORTS_STORAGE_KEY))).toBe(true);
    });
    expect(findLeaks(rawLocalStorageText(), ["trip-9", "R-130", "54.3999", "major"])).toEqual([]);
  });

  it("stores the map viewport sealed and loads it after a reload", async () => {
    await mapViewportItem.load();
    mapViewportItem.set(JSON.stringify({ lat: 54.3521, lon: 18.6464, zoom: 15 }));
    await vi.waitFor(() => {
      expect(isSealedValue(localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY))).toBe(true);
    });
    expect(findLeaks(rawLocalStorageText(), ["54.3521", "18.6464"])).toEqual([]);
    reload();
    await mapViewportItem.load();
    expect(JSON.parse(mapViewportItem.get()!)).toMatchObject({ lat: 54.3521 });
  });

  it("never overwrites a value it could not read because the key read failed", async () => {
    expect(await readSealedItem(LEGACY_FAVORITES_KEY)).toBeNull();
    expect(await writeSealedItem(LEGACY_FAVORITES_KEY, "original")).toBe(true);
    const stored = localStorage.getItem(LEGACY_FAVORITES_KEY);

    reload();
    vi.spyOn(db.installKey, "get").mockRejectedValue(new Error("read failed"));
    expect(await readSealedItem(LEGACY_FAVORITES_KEY)).toBeNull();
    expect(await writeSealedItem(LEGACY_FAVORITES_KEY, "replacement")).toBe(false);
    expect(localStorage.getItem(LEGACY_FAVORITES_KEY)).toBe(stored);
  });

  it("never overwrites a value that does not decrypt with the current key", async () => {
    expect(await readSealedItem(MAP_VIEWPORT_STORAGE_KEY)).toBeNull();
    await writeSealedItem(MAP_VIEWPORT_STORAGE_KEY, "old");
    const stored = localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY);
    // A different key (for example after the key row was lost).
    await db.installKey.clear();
    reload();
    expect(await readSealedItem(MAP_VIEWPORT_STORAGE_KEY)).toBeNull();
    expect(await writeSealedItem(MAP_VIEWPORT_STORAGE_KEY, "new")).toBe(false);
    expect(localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY)).toBe(stored);

    // Deleting the unreadable value allows new writes.
    removeSealedItem(MAP_VIEWPORT_STORAGE_KEY);
    expect(await writeSealedItem(MAP_VIEWPORT_STORAGE_KEY, "new")).toBe(true);
    expect(await readSealedItem(MAP_VIEWPORT_STORAGE_KEY)).toBe("new");
  });

  it("leaves legacy plaintext for the storage migration", async () => {
    localStorage.setItem(DELAY_REPORTS_STORAGE_KEY, '{"state":{"reports":[]}}');
    expect(await readSealedItem(DELAY_REPORTS_STORAGE_KEY)).toBeNull();
    expect(await writeSealedItem(DELAY_REPORTS_STORAGE_KEY, "x")).toBe(false);
    expect(localStorage.getItem(DELAY_REPORTS_STORAGE_KEY)).toBe('{"state":{"reports":[]}}');
  });

  it("drops an in-flight write that started before the value was removed", async () => {
    await readSealedItem(LEGACY_FAVORITES_KEY);
    const write = writeSealedItem(LEGACY_FAVORITES_KEY, "late");
    removeSealedItem(LEGACY_FAVORITES_KEY);
    expect(await write).toBe(false);
    expect(localStorage.getItem(LEGACY_FAVORITES_KEY)).toBeNull();
  });

  it("keeps the newest of two overlapping writes, whichever finishes last", async () => {
    await readSealedItem(LEGACY_FAVORITES_KEY);
    const older = writeSealedItem(LEGACY_FAVORITES_KEY, "older");
    const newer = writeSealedItem(LEGACY_FAVORITES_KEY, "newer");
    expect(await newer).toBe(true);
    expect(await older).toBe(false);
    expect(await readSealedItem(LEGACY_FAVORITES_KEY)).toBe("newer");
  });
});
