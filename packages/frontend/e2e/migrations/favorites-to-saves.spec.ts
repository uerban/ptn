import { test, expect, type Page } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

/**
 * M8c T-17 — favorites → savedLocations migration E2E.
 *
 * Seeds the legacy `ptn-favorites` localStorage envelope (and the
 * `enableFavoritesMigration` flag on `ptn-settings`) via `addInitScript` so
 * both are present before the first boot, then runs the real migration
 * service via a dynamic import and asserts:
 *   1. every legacy entry lands in `savedLocations`,
 *   2. rows that originated from `home`/`work` are encrypted (no plaintext
 *      label leaks into `endpoint`), and `stop`/`place` rows are plaintext,
 *   3. the legacy `ptn-favorites` key is removed once writes succeed.
 *
 * The migration isn't wired into app boot yet (it's flag-gated until this
 * spec lands), so we invoke it directly via dynamic import — same pattern as
 * `install-key-destruction.spec.ts`.
 *
 * Tagged @mock-api because it boots the real app against deterministic
 * fixtures (required for `/src/...` dynamic imports served by Vite).
 */

const FAVORITES_MIGRATION_MODULE_URL = "/src/services/favoritesMigration.ts";
const CRYPTO_BOX_MODULE_URL = "/src/services/cryptoBox.ts";
const INSTALL_KEY_MODULE_URL = "/src/services/installKey.ts";

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

interface SavedRow {
  id: string;
  alias: string;
  encrypted: boolean;
  endpointJson: string;
  endpointKind?: string;
  endpointLabel?: string;
  decryptedLabel?: string;
  decryptedLat?: number;
  decryptedLon?: number;
}

async function readSavedRows(page: Page): Promise<SavedRow[]> {
  return await page.evaluate(
    async ({ cryptoUrl, keyUrl }) => {
      const crypto = (await import(/* @vite-ignore */ cryptoUrl)) as {
        decrypt: (
          rec: { iv: ArrayBuffer; ct: ArrayBuffer },
          key: CryptoKey,
        ) => Promise<unknown>;
      };
      const installKey = (await import(/* @vite-ignore */ keyUrl)) as {
        getOrCreateInstallKey: () => Promise<CryptoKey>;
      };

      return await new Promise<SavedRow[]>((resolve, reject) => {
        const req = indexedDB.open("ptn");
        req.onsuccess = async () => {
          try {
            const idb = req.result;
            const tx = idb.transaction("savedLocations", "readonly");
            const store = tx.objectStore("savedLocations");
            const all = await new Promise<unknown[]>((res, rej) => {
              const r = store.getAll();
              r.onsuccess = () => res(r.result as unknown[]);
              r.onerror = () => rej(r.error);
            });
            const key = await installKey.getOrCreateInstallKey();
            const rows: SavedRow[] = [];
            for (const raw of all) {
              const row = raw as {
                id: string;
                alias: string;
                encrypted: boolean;
                endpoint:
                  | { kind: string; label?: string }
                  | { iv: ArrayBuffer; ct: ArrayBuffer };
              };
              const endpointJson = JSON.stringify(row.endpoint);
              const out: SavedRow = {
                id: row.id,
                alias: row.alias,
                encrypted: row.encrypted,
                endpointJson,
              };
              if (row.encrypted) {
                const decoded = (await crypto.decrypt(
                  row.endpoint as { iv: ArrayBuffer; ct: ArrayBuffer },
                  key,
                )) as { kind: string; label?: string; lat: number; lon: number };
                out.decryptedLabel = decoded.label;
                out.decryptedLat = decoded.lat;
                out.decryptedLon = decoded.lon;
                out.endpointKind = decoded.kind;
              } else {
                const ep = row.endpoint as { kind: string; label?: string };
                out.endpointKind = ep.kind;
                out.endpointLabel = ep.label;
              }
              rows.push(out);
            }
            idb.close();
            resolve(rows);
          } catch (e) {
            reject(e);
          }
        };
        req.onerror = () => reject(req.error);
      });
    },
    { cryptoUrl: CRYPTO_BOX_MODULE_URL, keyUrl: INSTALL_KEY_MODULE_URL },
  );
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

    // Sanity: seeded envelope is present before the migration runs.
    const preLegacy = await readLegacyFavoritesKey(page);
    expect(preLegacy).not.toBeNull();

    const result = await runMigration(page);
    expect(result.skipped).toBe(false);
    expect(result.migrated).toBe(SEED_FAVORITES.length);
    expect(result.legacyCleared).toBe(true);

    const rows = await readSavedRows(page);
    expect(rows).toHaveLength(SEED_FAVORITES.length);
    const byId = new Map(rows.map((r) => [r.id, r]));

    const homeRow = byId.get("fav-home")!;
    expect(homeRow.encrypted).toBe(true);
    // Ciphertext must not leak the plaintext alias.
    expect(homeRow.endpointJson).not.toContain("Dom");
    expect(homeRow.decryptedLabel).toBe("Dom");
    expect(homeRow.decryptedLat).toBeCloseTo(54.35);

    const workRow = byId.get("fav-work")!;
    expect(workRow.encrypted).toBe(true);
    expect(workRow.endpointJson).not.toContain("Biuro");
    expect(workRow.decryptedLabel).toBe("Biuro");

    const stopRow = byId.get("fav-stop")!;
    expect(stopRow.encrypted).toBe(false);
    expect(stopRow.endpointKind).toBe("stop");
    expect(stopRow.alias).toBe("Central");

    const placeRow = byId.get("fav-place")!;
    expect(placeRow.encrypted).toBe(false);
    expect(placeRow.endpointKind).toBe("geocoded");
    expect(placeRow.endpointLabel).toBe("Rynek");

    // Legacy key is removed only after every row is written.
    const postLegacy = await readLegacyFavoritesKey(page);
    expect(postLegacy).toBeNull();
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
    // `savedLocations` stays empty because the flag was off.
    const rows = await readSavedRows(page);
    expect(rows).toHaveLength(0);
  });
});
