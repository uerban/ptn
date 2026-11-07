import { test, expect, type Page } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";
import { rawStorageDump, rowShapes } from "../helpers/raw-storage";

/**
 * Upgrading a device that stored personal data in plaintext.
 *
 * Seeds the IndexedDB schema and localStorage values an earlier version
 * wrote (recents keyed by endpoint fingerprint, a saved pair, stop-use
 * counts, favorites and the last map area), boots the app, and asserts that
 * start-up encrypted every record: nothing readable remains in IndexedDB or
 * localStorage, and the rider's saves, recents and favorites are all still
 * there after a reload.
 *
 * Tagged @mock-api: it boots the real app against deterministic fixtures and
 * reads the result through `/src/...` dynamic imports served by Vite.
 */

const SENSITIVE = [
  "Oliwa Klinika",
  "Therapist",
  "S-77",
  "Babcia",
  "stop:S-77",
  "54.4111",
  "54.3888",
];

async function goToSeedPage(page: Page) {
  await page.route("**/seed-blank", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<html><body>seed</body></html>",
    }),
  );
  await page.goto("/seed-blank");
  await page.unroute("**/seed-blank");
}

async function seedLegacyProfile(page: Page) {
  await goToSeedPage(page);
  await page.evaluate(async () => {
    localStorage.setItem(
      "ptn-favorites",
      JSON.stringify({
        state: {
          favorites: [
            {
              id: "fav-1",
              name: "Babcia",
              type: "place",
              location: { lat: 54.3888, lon: 18.5999 },
              sortOrder: 0,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        version: 0,
      }),
    );
    localStorage.setItem(
      "ptn-map-viewport",
      JSON.stringify({ lat: 54.4111, lon: 18.5678, zoom: 14 }),
    );
    // History written under optional-storage choices that were granted.
    localStorage.setItem("ptn-privacy-data-migration", "1");
    localStorage.setItem(
      "ptn-privacy-choices",
      JSON.stringify({ state: { choices: { recents: "enabled" } }, version: 1 }),
    );

    await new Promise<void>((resolve, reject) => {
      // Version 2 of the schema (Dexie stores verno × 10).
      const req = indexedDB.open("ptn", 20);
      req.onupgradeneeded = () => {
        const idb = req.result;
        idb.createObjectStore("recentLocations", { keyPath: "id" }).createIndex("usedAt", "usedAt");
        idb.createObjectStore("savedLocations", { keyPath: "id" }).createIndex("savedAt", "savedAt");
        idb.createObjectStore("usageStats", { keyPath: "stopId" }).createIndex("lastTapped", "lastTapped");
      };
      req.onsuccess = () => {
        const idb = req.result;
        const tx = idb.transaction(["recentLocations", "savedLocations", "usageStats"], "readwrite");
        const stop = { kind: "stop", stopId: "S-77", name: "Oliwa Klinika", lat: 54.4111, lon: 18.5678 };
        tx.objectStore("recentLocations").put({
          id: "stop:S-77",
          endpoint: stop,
          usedAt: Date.now() - 1000,
          usedAsOrigin: true,
        });
        tx.objectStore("savedLocations").put({
          id: "save-1",
          endpoint: stop,
          alias: "Therapist",
          savedAt: 1_700_000_000_000,
          encrypted: false,
        });
        tx.objectStore("usageStats").put({ stopId: "S-77", tapCount: 4, lastTapped: Date.now() });
        tx.oncomplete = () => {
          idb.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  });
}

async function readPersonalData(page: Page) {
  return await page.evaluate(async () => {
    const saves = (await import(/* @vite-ignore */ "/src/services/saves.ts")) as {
      listSaves: () => Promise<{ id: string; alias: string; origin: { name?: string } }[]>;
    };
    const recents = (await import(/* @vite-ignore */ "/src/services/recents.ts")) as {
      listRecents: () => Promise<{ base: { name?: string } }[]>;
    };
    const favorites = (await import(/* @vite-ignore */ "/src/stores/favoritesStore.ts")) as {
      useFavoritesStore: { getState: () => { favorites: { name: string }[] } };
    };
    return {
      saves: await saves.listSaves(),
      recents: await recents.listRecents(),
      favorites: favorites.useFavoritesStore.getState().favorites.map((f) => f.name),
    };
  });
}

test.describe("Migration: personal data is encrypted on upgrade @mock-api", () => {
  test("plaintext records from an earlier version are encrypted and still shown", async ({
    page,
  }) => {
    await mockApi(page);
    await seedLegacyProfile(page);

    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("ptn-personal-storage")), {
        timeout: 15_000,
      })
      .toBe("1");

    const raw = await rawStorageDump(page);
    for (const needle of SENSITIVE) expect(raw, needle).not.toContain(needle);
    for (const shape of await rowShapes(page, "savedLocations")) {
      expect(shape).toEqual(["id", "sealed"]);
    }
    for (const shape of await rowShapes(page, "recentLocations")) {
      expect(shape).toEqual(["id", "sealed"]);
    }

    await page.reload();
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => (await readPersonalData(page)).favorites, { timeout: 10_000 })
      .toEqual(["Babcia"]);
    const data = await readPersonalData(page);
    expect(data.saves.map((s) => s.alias)).toEqual(["Therapist"]);
    expect(data.saves[0]!.origin.name).toBe("Oliwa Klinika");
    expect(data.recents.map((r) => r.base.name)).toEqual(["Oliwa Klinika"]);

    // Still nothing readable after the app ran on the converted data.
    const after = await rawStorageDump(page);
    for (const needle of SENSITIVE) expect(after, needle).not.toContain(needle);
  });
});
