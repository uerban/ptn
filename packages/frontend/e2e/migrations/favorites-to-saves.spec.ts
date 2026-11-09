import { test, expect, type Page } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";
import { rawStorageDump, rowShapes } from "../helpers/raw-storage";

/**
 * Favorites → saved places migration.
 *
 * Seeds the legacy `ptn-favorites` localStorage envelope in plaintext (and
 * the `enableFavoritesMigration` flag on `ptn-settings`) via `addInitScript`
 * so both are present before the first boot. The app encrypts the envelope
 * at start-up; the spec then runs the real migration service via a dynamic
 * import and asserts:
 *   1. every legacy entry lands in `savedLocations` with its label and kind,
 *   2. stored rows hold only an id and a sealed payload, and no label or
 *      coordinate appears anywhere in IndexedDB or localStorage,
 *   3. the legacy `ptn-favorites` key is removed once writes succeed.
 *
 * Tagged @mock-api because it boots the real app against deterministic
 * fixtures (required for `/src/...` dynamic imports served by Vite).
 */

const FAVORITES_MIGRATION_MODULE_URL = "/src/services/favoritesMigration.ts";
const SAVES_MODULE_URL = "/src/services/saves.ts";
const SENSITIVE = ["Dom", "Biuro", "Central", "Rynek", "S-42", "54.35", "54.37"];

interface SeededFavorite {
  id: string;
  name: string;
  type: "home" | "work" | "stop" | "place";
  location: { lat: number; lon: number };
  stopId?: string;
  sortOrder: number;
  createdAt: string;
}

const SEED_FAVORITES: SeededFavorite[] = [
  {
    id: "fav-home",
    name: "Dom",
    type: "home",
    location: { lat: 54.35, lon: 18.65 },
    sortOrder: 0,
    createdAt: "2026-01-01T10:00:00.000Z",
  },
  {
    id: "fav-work",
    name: "Biuro",
    type: "work",
    location: { lat: 54.36, lon: 18.66 },
    sortOrder: 1,
    createdAt: "2026-01-02T10:00:00.000Z",
  },
  {
    id: "fav-stop",
    name: "Central",
    type: "stop",
    stopId: "S-42",
    location: { lat: 54.37, lon: 18.67 },
    sortOrder: 2,
    createdAt: "2026-01-03T10:00:00.000Z",
  },
  {
    id: "fav-place",
    name: "Rynek",
    type: "place",
    location: { lat: 54.38, lon: 18.68 },
    sortOrder: 3,
    createdAt: "2026-01-04T10:00:00.000Z",
  },
];

async function seedStorage(
  page: Page,
  favorites: SeededFavorite[],
  flagOn: boolean,
): Promise<void> {
  await page.addInitScript(
    ({ favs, flag }) => {
      localStorage.setItem(
        "ptn-favorites",
        JSON.stringify({ state: { favorites: favs }, version: 0 }),
      );
      localStorage.setItem(
        "ptn-settings",
        JSON.stringify({
          state: { enableFavoritesMigration: flag },
          version: 0,
        }),
      );
    },
    { favs: favorites, flag: flagOn },
  );
}

async function runMigration(page: Page): Promise<{
  migrated: number;
  legacyCleared: boolean;
  skipped: boolean;
}> {
  return await page.evaluate(async (moduleUrl) => {
    const mod = (await import(/* @vite-ignore */ moduleUrl)) as {
      migrateFavoritesToSaves: () => Promise<{
        migrated: number;
        legacyCleared: boolean;
        skipped: boolean;
      }>;
    };
    return await mod.migrateFavoritesToSaves();
  }, FAVORITES_MIGRATION_MODULE_URL);
}

interface ResolvedRow {
  id: string;
  alias: string;
  placeType?: string;
  origin: { kind: string; label?: string; name?: string; stopId?: string; lat: number };
}

async function readSaves(page: Page): Promise<ResolvedRow[]> {
  return await page.evaluate(async (moduleUrl) => {
    const mod = (await import(/* @vite-ignore */ moduleUrl)) as {
      listSaves: () => Promise<ResolvedRow[]>;
    };
    return await mod.listSaves();
  }, SAVES_MODULE_URL);
}

async function readLegacyFavoritesKey(page: Page): Promise<string | null> {
  return await page.evaluate(() => localStorage.getItem("ptn-favorites"));
}

test.describe("Migration: favorites → savedLocations @mock-api", () => {
  test("with flag ON, legacy favorites migrate and the localStorage key is cleared", async ({
    page,
  }) => {
    await mockApi(page);
    await seedStorage(page, SEED_FAVORITES, true);

    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({
      timeout: 20_000,
    });

    // The envelope is still there, but encrypted at start-up.
    const preLegacy = await readLegacyFavoritesKey(page);
    expect(preLegacy).not.toBeNull();
    expect(preLegacy).not.toContain("Dom");

    const result = await runMigration(page);
    expect(result.skipped).toBe(false);
    expect(result.migrated).toBe(SEED_FAVORITES.length);
    expect(result.legacyCleared).toBe(true);

    const shapes = await rowShapes(page, "savedLocations");
    expect(shapes).toHaveLength(SEED_FAVORITES.length);
    for (const shape of shapes) expect(shape).toEqual(["id", "sealed"]);
    const raw = await rawStorageDump(page);
    for (const needle of SENSITIVE) expect(raw).not.toContain(needle);

    const byId = new Map((await readSaves(page)).map((r) => [r.id, r]));
    expect(byId.get("fav-home")).toMatchObject({ alias: "Dom", placeType: "home" });
    expect(byId.get("fav-home")!.origin.lat).toBeCloseTo(54.35);
    expect(byId.get("fav-work")!.origin.label).toBe("Biuro");
    expect(byId.get("fav-stop")!.origin).toMatchObject({ kind: "stop", stopId: "S-42" });
    expect(byId.get("fav-place")!.origin).toMatchObject({ kind: "geocoded", label: "Rynek" });

    // Legacy key is removed only after every row is written.
    expect(await readLegacyFavoritesKey(page)).toBeNull();
  });

  test("with flag OFF, migration is skipped and legacy key is preserved", async ({
    page,
  }) => {
    await mockApi(page);
    await seedStorage(page, SEED_FAVORITES, false);

    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({
      timeout: 20_000,
    });

    const result = await runMigration(page);
    expect(result.skipped).toBe(true);
    expect(result.migrated).toBe(0);

    const postLegacy = await readLegacyFavoritesKey(page);
    expect(postLegacy).not.toBeNull();
    // Kept, but encrypted.
    expect(postLegacy).not.toContain("Dom");
    // `savedLocations` stays empty because the flag was off.
    expect(await readSaves(page)).toHaveLength(0);
  });
});
