import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

const CITY_ID = "vilnius";

const BUNDLE_V1_ENTRIES = [
  {
    id: "poi-katedra",
    cityId: CITY_ID,
    name: "Vilniaus katedra",
    geoBucket: "5468_2528",
    aliases: { lt: ["Arkikatedra bazilika"], en: ["Vilnius Cathedral"] },
    category: "landmark",
    lat: 54.6856,
    lon: 25.2877,
    source: "curated",
    rankBoost: 1.0,
    tier: "strict",
    wikidataId: "Q220839",
  },
  {
    id: "poi-gediminas",
    cityId: CITY_ID,
    name: "Gedimino pilis",
    geoBucket: "5468_2529",
    aliases: { lt: ["Gedimino bokštas"], en: ["Gediminas Castle Tower"] },
    category: "landmark",
    lat: 54.6862,
    lon: 25.2906,
    source: "curated",
    rankBoost: 1.0,
    tier: "strict",
    wikidataId: "Q3117991",
  },
];

const BUNDLE_V2_ENTRIES = [
  {
    id: "poi-gate-of-dawn",
    cityId: CITY_ID,
    name: "Aušros Vartai",
    geoBucket: "5467_2528",
    aliases: { lt: ["Aušros vartai"], en: ["Gate of Dawn"] },
    category: "landmark",
    lat: 54.6741,
    lon: 25.2889,
    source: "curated",
    rankBoost: 1.0,
    tier: "strict",
    wikidataId: "Q583158",
  },
  {
    id: "poi-uzupis",
    cityId: CITY_ID,
    name: "Užupis",
    geoBucket: "5468_2529",
    aliases: { lt: [], en: ["Uzupis Republic"] },
    category: "named_square",
    lat: 54.6808,
    lon: 25.2972,
    source: "osm",
    rankBoost: 0.3,
    tier: "strict",
    osmId: "way/789012",
  },
];

const HASH_V1 = "abc123-v1";
const HASH_V2 = "def456-v2";

async function seedPoiData(
  page: import("@playwright/test").Page,
  entries: typeof BUNDLE_V1_ENTRIES,
  hash: string,
) {
  await page.evaluate(
    async ({ entries, hash, cityId }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("ptn");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      const tx = db.transaction(["poiIndex", "poiSyncMeta"], "readwrite");
      const poiStore = tx.objectStore("poiIndex");
      const metaStore = tx.objectStore("poiSyncMeta");

      for (const entry of entries) poiStore.put(entry);

      metaStore.put({
        cityId,
        activeBundleHash: hash,
        entryCount: entries.length,
        installedAt: Date.now(),
        tier: "strict",
        sourcePbfTimestamp: "2026-04-01T00:00:00Z",
        bundleGeneratedAt: "2026-04-01T12:00:00Z",
      });

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      db.close();
    },
    { entries, hash, cityId: CITY_ID },
  );
}

async function readPoiIndex(page: import("@playwright/test").Page) {
  return page.evaluate(async (cityId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("ptn");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const tx = db.transaction(["poiIndex", "poiSyncMeta"], "readonly");
    const poiStore = tx.objectStore("poiIndex");
    const metaStore = tx.objectStore("poiSyncMeta");

    const allEntries = await new Promise<
      Array<{ id: string; name: string; cityId: string }>
    >((resolve, reject) => {
      const req = poiStore.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const meta = await new Promise<{
      activeBundleHash: string;
      entryCount: number;
    } | null>((resolve, reject) => {
      const req = metaStore.get(cityId);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });

    db.close();

    const cityEntries = allEntries.filter((e) => e.cityId === cityId);
    return {
      entryIds: cityEntries.map((e) => e.id).sort(),
      entryNames: cityEntries.map((e) => e.name).sort(),
      entryCount: cityEntries.length,
      meta,
    };
  }, CITY_ID);
}

test.describe("Bundle hash-triggered rebuild @offline", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "offline",
      "Requires offline project with service workers enabled",
    );
  });

  test("replacing bundle content triggers Dexie index rebuild with new entries", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/");

    await page.waitForFunction(
      async () => {
        const reg = await navigator.serviceWorker?.getRegistration();
        return (
          reg?.active?.state === "activated" ||
          reg?.waiting?.state === "installed"
        );
      },
      { timeout: 15_000 },
    );
    await page.waitForTimeout(3000);

    // Seed initial V1 data
    await seedPoiData(page, BUNDLE_V1_ENTRIES, HASH_V1);

    // Verify V1 data is in the index
    const v1State = await readPoiIndex(page);
    expect(v1State.entryCount).toBe(2);
    expect(v1State.entryIds).toEqual(["poi-gediminas", "poi-katedra"]);
    expect(v1State.meta?.activeBundleHash).toBe(HASH_V1);

    // Simulate bundle replacement: clear old data and seed V2
    // (this mimics what syncPoiBundle does when the hash changes)
    await page.evaluate(
      async ({ entries, hash, cityId }) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open("ptn");
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });

        const tx = db.transaction(["poiIndex", "poiSyncMeta"], "readwrite");
        const poiStore = tx.objectStore("poiIndex");
        const metaStore = tx.objectStore("poiSyncMeta");

        // Wipe all existing POI entries (single city in test)
        poiStore.clear();

        // Insert new entries
        for (const entry of entries) poiStore.put(entry);

        // Update sync meta with new hash
        metaStore.put({
          cityId,
          activeBundleHash: hash,
          entryCount: entries.length,
          installedAt: Date.now(),
          tier: "strict",
          sourcePbfTimestamp: "2026-04-10T00:00:00Z",
          bundleGeneratedAt: "2026-04-10T12:00:00Z",
        });

        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });

        db.close();
      },
      { entries: BUNDLE_V2_ENTRIES, hash: HASH_V2, cityId: CITY_ID },
    );

    // Verify V2 data replaced V1 in the index
    const v2State = await readPoiIndex(page);
    expect(v2State.entryCount).toBe(2);
    expect(v2State.entryIds).toEqual(["poi-gate-of-dawn", "poi-uzupis"]);
    expect(v2State.entryNames).toEqual(["Aušros Vartai", "Užupis"]);
    expect(v2State.meta?.activeBundleHash).toBe(HASH_V2);
    expect(v2State.meta?.entryCount).toBe(2);

    // V1 entries must be completely gone
    const v1Absent = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("ptn");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const tx = db.transaction("poiIndex", "readonly");
      const store = tx.objectStore("poiIndex");
      const katedra = await new Promise((resolve, reject) => {
        const req = store.get("poi-katedra");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const gediminas = await new Promise((resolve, reject) => {
        const req = store.get("poi-gediminas");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return { katedra, gediminas };
    });
    expect(v1Absent.katedra).toBeUndefined();
    expect(v1Absent.gediminas).toBeUndefined();

    // Search for V2 POI to confirm search works against rebuilt index
    await page.goto("/search", { waitUntil: "domcontentloaded" });
    const toInput = page.getByRole("searchbox").nth(1);
    await toInput.fill("Aušros");
    await page.waitForTimeout(600);

    await expect(page.getByRole("option").first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText("Aušros Vartai")).toBeVisible();

    // Search for V1 POI should NOT return results
    await toInput.fill("");
    await page.waitForTimeout(200);
    await toInput.fill("Katedra");
    await page.waitForTimeout(600);

    const katedraResults = page.getByText("Vilniaus katedra");
    await expect(katedraResults).toHaveCount(0);
  });

  test("poiSyncMeta hash prevents redundant rebuild when hash unchanged", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/");

    await page.waitForFunction(
      async () => {
        const reg = await navigator.serviceWorker?.getRegistration();
        return (
          reg?.active?.state === "activated" ||
          reg?.waiting?.state === "installed"
        );
      },
      { timeout: 15_000 },
    );
    await page.waitForTimeout(3000);

    // Seed data with a known hash
    await seedPoiData(page, BUNDLE_V1_ENTRIES, HASH_V1);

    const beforeTimestamp = await page.evaluate(async (cityId) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("ptn");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const tx = db.transaction("poiSyncMeta", "readonly");
      const store = tx.objectStore("poiSyncMeta");
      const meta = await new Promise<{ installedAt: number }>((resolve, reject) => {
        const req = store.get(cityId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return meta.installedAt;
    }, CITY_ID);

    // Wait a moment to make timestamps distinguishable
    await page.waitForTimeout(100);

    // Re-seed with the SAME hash — simulates "no change" scenario
    await seedPoiData(page, BUNDLE_V1_ENTRIES, HASH_V1);

    const afterMeta = await page.evaluate(async (cityId) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("ptn");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const tx = db.transaction("poiSyncMeta", "readonly");
      const store = tx.objectStore("poiSyncMeta");
      const meta = await new Promise<{
        activeBundleHash: string;
        installedAt: number;
        entryCount: number;
      }>((resolve, reject) => {
        const req = store.get(cityId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return meta;
    }, CITY_ID);

    // Hash and entry count stay the same; data is still correct
    expect(afterMeta.activeBundleHash).toBe(HASH_V1);
    expect(afterMeta.entryCount).toBe(2);

    // Entries remain intact
    const state = await readPoiIndex(page);
    expect(state.entryCount).toBe(2);
    expect(state.entryIds).toEqual(["poi-gediminas", "poi-katedra"]);
  });
});
