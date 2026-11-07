import { describe, it, expect, beforeEach, vi } from "vitest";
import "fake-indexeddb/auto";
import type { FavoritePlace } from "@pt/shared";
import { db } from "../db/index.ts";
import { getOrCreateInstallKey } from "./installKey.ts";
import {
  LEGACY_FAVORITES_KEY,
  migrateFavoritesToSaves,
} from "./favoritesMigration.ts";
import { listSaves } from "./saves.ts";
import { sealString } from "./sealedLocalStorage.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import {
  findLeaks,
  rawLocalStorageText,
  rawTableText,
  resetPersonalStorage,
} from "../test-helpers/personalStorage.ts";

async function seedLegacyFavorites(favs: FavoritePlace[]): Promise<void> {
  const envelope = { state: { favorites: favs }, version: 0 };
  const sealed = await sealString(JSON.stringify(envelope), await getOrCreateInstallKey());
  localStorage.setItem(LEGACY_FAVORITES_KEY, sealed);
}

async function saveById(id: string) {
  return (await listSaves()).find((s) => s.id === id);
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
    await resetPersonalStorage();
    localStorage.removeItem(LEGACY_FAVORITES_KEY);
    useSettingsStore.setState({ enableFavoritesMigration: true });
  });

  it("skips when the flag is off", async () => {
    useSettingsStore.setState({ enableFavoritesMigration: false });
    await seedLegacyFavorites([home()]);
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

  it("writes every favorite as a sealed save with no readable field", async () => {
    await seedLegacyFavorites([home(), work(), stopFav(), placeFav()]);
    const result = await migrateFavoritesToSaves();
    expect(result.migrated).toBe(4);
    expect(result.legacyCleared).toBe(true);

    const raw = (await rawTableText("savedLocations")) + rawLocalStorageText();
    expect(findLeaks(raw, ["Dom", "Biuro", "Central", "Rynek", "S-42", "54.35"])).toEqual([]);
    expect(await db.savedLocations.count()).toBe(4);
  });

  it("keeps endpoints, labels and kinds of every favorite", async () => {
    await seedLegacyFavorites([home(), stopFav(), placeFav()]);
    await migrateFavoritesToSaves();

    const homeSave = (await saveById("fav-home"))!;
    expect(homeSave.origin).toMatchObject({ kind: "geocoded", label: "Dom", lat: 54.35 });
    expect(homeSave.placeType).toBe("home");

    const stopSave = (await saveById("fav-stop"))!;
    expect(stopSave.alias).toBe("Central");
    expect(stopSave.origin).toMatchObject({ kind: "stop", stopId: "S-42", name: "Central" });

    const placeSave = (await saveById("fav-place"))!;
    expect(placeSave.origin).toMatchObject({
      kind: "geocoded",
      provider: "legacy-favorite",
      label: "Rynek",
    });
  });

  it("clears the legacy key only after all writes succeed", async () => {
    await seedLegacyFavorites([home(), stopFav()]);
    await migrateFavoritesToSaves();
    expect(localStorage.getItem(LEGACY_FAVORITES_KEY)).toBeNull();
  });

  it("is idempotent: second run is a no-op", async () => {
    await seedLegacyFavorites([home()]);
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
    await seedLegacyFavorites([home(), work(), stopFav()]);
    const originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let callCount = 0;
    const spy = vi
      .spyOn(crypto.subtle, "encrypt")
      .mockImplementation((...args: Parameters<SubtleCrypto["encrypt"]>) => {
        callCount += 1;
        if (callCount === 2) return Promise.reject(new Error("simulated write failure"));
        return originalEncrypt(...args);
      });

    await expect(migrateFavoritesToSaves()).rejects.toThrow(
      "simulated write failure",
    );
    expect(localStorage.getItem(LEGACY_FAVORITES_KEY)).not.toBeNull();
    spy.mockRestore();
  });

  it("keeps the sealed source when saves could only be kept for this session", async () => {
    await seedLegacyFavorites([home()]);
    localStorage.removeItem("ptn-personal-storage");
    const { usePersonalStorageStatus } = await import("./personalStorage.ts");
    usePersonalStorageStatus.setState({ migration: "failed" });
    const result = await migrateFavoritesToSaves();
    expect(result.legacyCleared).toBe(false);
    expect(await db.savedLocations.count()).toBe(0);
  });

  it("preserves FavoritePlace.id on the SavedRecord", async () => {
    await seedLegacyFavorites([home({ id: "abc-123" })]);
    await migrateFavoritesToSaves();
    expect(await db.savedLocations.get("abc-123")).not.toBeUndefined();
    expect((await saveById("abc-123"))?.alias).toBe("Dom");
  });

  it("parses createdAt ISO into savedAt epoch ms", async () => {
    await seedLegacyFavorites([
      placeFav({ id: "epoch-1", createdAt: "2026-01-04T10:00:00.000Z" }),
    ]);
    await migrateFavoritesToSaves();
    const save = (await saveById("epoch-1"))!;
    expect(save.savedAt).toBe(Date.parse("2026-01-04T10:00:00.000Z"));
  });

  it("accepts the force opt even when flag is off", async () => {
    useSettingsStore.setState({ enableFavoritesMigration: false });
    await seedLegacyFavorites([stopFav()]);
    const result = await migrateFavoritesToSaves({ force: true });
    expect(result.skipped).toBe(false);
    expect(result.migrated).toBe(1);
  });

  it("is a no-op when legacy envelope is malformed JSON", async () => {
    localStorage.setItem(
      LEGACY_FAVORITES_KEY,
      await sealString("not json", await getOrCreateInstallKey()),
    );
    const result = await migrateFavoritesToSaves();
    expect(result.migrated).toBe(0);
    expect(result.legacyCleared).toBe(false);
  });

  it("is a no-op when favorites array is empty", async () => {
    await seedLegacyFavorites([]);
    const result = await migrateFavoritesToSaves();
    expect(result.migrated).toBe(0);
    expect(result.legacyCleared).toBe(false);
  });
});
