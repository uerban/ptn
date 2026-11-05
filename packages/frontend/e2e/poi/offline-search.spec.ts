import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";
import { waitForActiveServiceWorker } from "../helpers/service-worker";

const POI_FIXTURES = [
  {
    id: "poi-katedra",
    cityId: "vilnius",
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
    cityId: "vilnius",
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
  {
    id: "poi-town-hall",
    cityId: "vilnius",
    name: "Vilniaus rotušė",
    geoBucket: "5467_2528",
    aliases: { lt: ["Rotušė"], en: ["Vilnius Town Hall"] },
    category: "public_building",
    lat: 54.6788,
    lon: 25.2873,
    source: "osm",
    rankBoost: 0.3,
    tier: "strict",
    osmId: "way/123456",
  },
];

async function seedPoiIndex(page: import("@playwright/test").Page) {
  await page.evaluate(async (entries) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("ptn");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const tx = db.transaction("poiIndex", "readwrite");
    const store = tx.objectStore("poiIndex");
    for (const entry of entries) store.put(entry);

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    db.close();
  }, POI_FIXTURES);
}

test.describe("Offline POI search @offline", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "offline",
      "Requires offline project with service workers enabled",
    );
  });

  test("search returns POI results from local Dexie index when offline", async ({
    page,
    context,
  }) => {
    await mockApi(page);

    // Load app online so the SW caches the app shell
    await page.goto("/");

    await waitForActiveServiceWorker(page);

    await page.waitForTimeout(3000);

    // Seed Dexie poiIndex with fixture POIs for Vilnius (the default city)
    await seedPoiIndex(page);

    // Go offline
    await context.setOffline(true);

    // Track network requests that fire while offline
    const offlineRequests: string[] = [];
    page.on("request", (req) => offlineRequests.push(req.url()));

    // Navigate to search page (served from SW cache)
    await page.goto("/search", { waitUntil: "domcontentloaded" });

    // Type a query matching our fixture POI "Vilniaus katedra"
    const toInput = page.getByRole("searchbox", { name: "Where to?" });
    await toInput.fill("Kated");

    // Wait for debounce (300ms) + search execution
    await page.waitForTimeout(600);

    // POI results should appear from local Dexie index
    await expect(page.getByRole("option").first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText("Vilniaus katedra")).toBeVisible();
    // Useful alternate names replace the generic source subtitle.
    const cathedral = page.getByRole("option", { name: /Vilniaus katedra/ });
    await expect(cathedral.getByText("Vilnius Cathedral", { exact: true })).toBeVisible();

    // No stops search API calls should have succeeded (we are offline
    // and the endpoint is not mocked, so API-based stop search would fail;
    // POI results come entirely from the local index)
    const stopSearchCalls = offlineRequests.filter((url) =>
      url.includes("/stops/search"),
    );
    expect(stopSearchCalls).toHaveLength(0);

    await context.setOffline(false);
  });

  test("BundledGeocoderAdapter is registered and returns alias matches offline", async ({
    page,
    context,
  }) => {
    await mockApi(page);

    await page.goto("/");

    await waitForActiveServiceWorker(page);

    await page.waitForTimeout(3000);
    await seedPoiIndex(page);

    await context.setOffline(true);

    await page.goto("/search", { waitUntil: "domcontentloaded" });

    // Search by English alias "Vilnius Cathedral" should match "Vilniaus katedra"
    const toInput = page.getByRole("searchbox", { name: "Where to?" });
    await toInput.fill("Cathedral");
    await page.waitForTimeout(600);

    await expect(page.getByRole("option").first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText("Vilniaus katedra")).toBeVisible();
    await expect(page.getByRole("option", { name: /Vilniaus katedra/ })
      .getByText("Vilnius Cathedral", { exact: true })).toBeVisible();

    await context.setOffline(false);
  });
});
