import { describe, it, expect, beforeEach, vi } from "vitest";
import "fake-indexeddb/auto";
import type { FavoritePlace } from "@pt/shared";
import { db } from "../db/index.ts";
import {
  decrypt,
  __clearRamStoreForTests,
  type EncryptedRecord,
} from "./cryptoBox.ts";
import {
  getOrCreateInstallKey,
  __resetInstallKeyCacheForTests,
} from "./installKey.ts";
import { __resetDegradedModeForTests } from "./installKeyDegrade.ts";
import {
  LEGACY_FAVORITES_KEY,
  migrateFavoritesToSaves,
} from "./favoritesMigration.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";

function seedLegacyFavorites(favs: FavoritePlace[]): void {
  const envelope = { state: { favorites: favs }, version: 0 };
  localStorage.setItem(LEGACY_FAVORITES_KEY, JSON.stringify(envelope));
}

function home(overrides: Partial<FavoritePlace> = {}): FavoritePlace {
  return {
    id: "fav-home",
    name: "Dom",
    type: "home",
    location: { lat: 54.35, lon: 18.65 },
    sortOrder: 0,
    createdAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

function work(overrides: Partial<FavoritePlace> = {}): FavoritePlace {
  return {
    id: "fav-work",
    name: "Biuro",
    type: "work",
    location: { lat: 54.36, lon: 18.66 },
    sortOrder: 1,
    createdAt: "2026-01-02T10:00:00.000Z",
    ...overrides,
  };
}

function stopFav(overrides: Partial<FavoritePlace> = {}): FavoritePlace {
  return {
    id: "fav-stop",
    name: "Central",
    type: "stop",
    location: { lat: 54.37, lon: 18.67 },
    stopId: "S-42",
    sortOrder: 2,
    createdAt: "2026-01-03T10:00:00.000Z",
    ...overrides,
  };
}

function placeFav(overrides: Partial<FavoritePlace> = {}): FavoritePlace {
  return {
    id: "fav-place",
    name: "Rynek",
    type: "place",
    location: { lat: 54.38, lon: 18.68 },
    sortOrder: 3,
    createdAt: "2026-01-04T10:00:00.000Z",
    ...overrides,
  };
}

describe("migrateFavoritesToSaves", () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.savedLocations.clear();
    await db.installKey.clear();
    localStorage.removeItem(LEGACY_FAVORITES_KEY);
    __clearRamStoreForTests();
    __resetInstallKeyCacheForTests();
    __resetDegradedModeForTests();
    useSettingsStore.setState({ enableFavoritesMigration: true });
  });

  it("skips when the flag is off", async () => {
    useSettingsStore.setState({ enableFavoritesMigration: false });
    seedLegacyFavorites([home()]);
    const result = await migrateFavoritesToSaves();
    expect(result).toEqual({
      migrated: 0,
      legacyCleared: false,
      skipped: true,
    });
    expect(await db.savedLocations.count()).toBe(0);
    expect(localStorage.getItem(LEGACY_FAVORITES_KEY)).not.toBeNull();
  });

  it("returns zero-migrated + no-clear when no legacy key present", async () => {
    const result = await migrateFavoritesToSaves();
    expect(result).toEqual({
      migrated: 0,
      legacyCleared: false,
      skipped: false,
    });
  });

  it("maps home/work to encrypted rows", async () => {
    seedLegacyFavorites([home(), work()]);
    const result = await migrateFavoritesToSaves();
    expect(result.migrated).toBe(2);
    expect(result.legacyCleared).toBe(true);

    const rows = await db.savedLocations.toArray();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.encrypted).toBe(true);
      // Ciphertext must not contain the plaintext label.
      expect(JSON.stringify(row.endpoint)).not.toContain("Dom");
      expect(JSON.stringify(row.endpoint)).not.toContain("Biuro");
    }

    const homeRow = rows.find((r) => r.id === "fav-home")!;
    const key = await getOrCreateInstallKey();
    const decrypted = (await decrypt(
      homeRow.endpoint as EncryptedRecord,
      key,
    )) as { kind: string; label?: string; lat: number; lon: number };
    expect(decrypted.kind).toBe("geocoded");
    expect(decrypted.label).toBe("Dom");
    expect(decrypted.lat).toBe(54.35);
  });

  it("maps stop/place to plaintext rows", async () => {
    seedLegacyFavorites([stopFav(), placeFav()]);
    const result = await migrateFavoritesToSaves();
    expect(result.migrated).toBe(2);

    const rows = await db.savedLocations.toArray();
    const stopRow = rows.find((r) => r.id === "fav-stop")!;
    expect(stopRow.encrypted).toBe(false);
    expect(stopRow.alias).toBe("Central");
    const stopEp = stopRow.endpoint as {
      kind: string;
      stopId: string;
      name: string;
    };
    expect(stopEp.kind).toBe("stop");
    expect(stopEp.stopId).toBe("S-42");
    expect(stopEp.name).toBe("Central");

    const placeRow = rows.find((r) => r.id === "fav-place")!;
    expect(placeRow.encrypted).toBe(false);
    const placeEp = placeRow.endpoint as {
      kind: string;
      provider: string;
      label: string;
    };
    expect(placeEp.kind).toBe("geocoded");
    expect(placeEp.provider).toBe("legacy-favorite");
    expect(placeEp.label).toBe("Rynek");
  });

  it("clears the legacy key only after all writes succeed", async () => {
    seedLegacyFavorites([home(), stopFav()]);
    await migrateFavoritesToSaves();
    expect(localStorage.getItem(LEGACY_FAVORITES_KEY)).toBeNull();
  });

  it("is idempotent: second run is a no-op", async () => {
    seedLegacyFavorites([home()]);
    const first = await migrateFavoritesToSaves();
    expect(first.migrated).toBe(1);
    expect(first.legacyCleared).toBe(true);

    const second = await migrateFavoritesToSaves();
    expect(second.migrated).toBe(0);
    expect(second.legacyCleared).toBe(false);
    expect(second.skipped).toBe(false);

    expect(await db.savedLocations.count()).toBe(1);
  });

  it("leaves legacy key intact on mid-write failure", async () => {
    seedLegacyFavorites([home(), work(), stopFav()]);
    const originalPut = db.savedLocations.put.bind(db.savedLocations);
    let callCount = 0;
    const spy = vi
      .spyOn(db.savedLocations, "put")
      .mockImplementation(((
        ...args: Parameters<typeof originalPut>
      ) => {
        callCount += 1;
        if (callCount === 2) {
          return Promise.reject(
            new Error("simulated write failure"),
          ) as ReturnType<typeof originalPut>;
        }
        return originalPut(...args);
      }) as typeof originalPut);

    await expect(migrateFavoritesToSaves()).rejects.toThrow(
      "simulated write failure",
    );
    expect(localStorage.getItem(LEGACY_FAVORITES_KEY)).not.toBeNull();
    spy.mockRestore();
  });

  it("preserves FavoritePlace.id on the SavedRecord", async () => {
    seedLegacyFavorites([home({ id: "abc-123" })]);
    await migrateFavoritesToSaves();
    const row = await db.savedLocations.get("abc-123");
    expect(row).not.toBeUndefined();
  });

  it("parses createdAt ISO into savedAt epoch ms", async () => {
    seedLegacyFavorites([
      placeFav({ id: "epoch-1", createdAt: "2026-01-04T10:00:00.000Z" }),
    ]);
    await migrateFavoritesToSaves();
    const row = (await db.savedLocations.get("epoch-1"))!;
    expect(row.savedAt).toBe(Date.parse("2026-01-04T10:00:00.000Z"));
  });

  it("accepts the force opt even when flag is off", async () => {
    useSettingsStore.setState({ enableFavoritesMigration: false });
    seedLegacyFavorites([stopFav()]);
    const result = await migrateFavoritesToSaves({ force: true });
    expect(result.skipped).toBe(false);
    expect(result.migrated).toBe(1);
  });

  it("is a no-op when legacy envelope is malformed JSON", async () => {
    localStorage.setItem(LEGACY_FAVORITES_KEY, "not json");
    const result = await migrateFavoritesToSaves();
    expect(result.migrated).toBe(0);
    expect(result.legacyCleared).toBe(false);
  });

  it("is a no-op when favorites array is empty", async () => {
    seedLegacyFavorites([]);
    const result = await migrateFavoritesToSaves();
    expect(result.migrated).toBe(0);
    expect(result.legacyCleared).toBe(false);
  });
});
