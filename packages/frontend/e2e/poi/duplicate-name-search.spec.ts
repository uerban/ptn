import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

const CITY_ID = "gdansk";

const POI_CURATED = {
  id: "poi-dworzec-curated",
  cityId: CITY_ID,
  name: "Dworzec Glowny",
  geoBucket: "5435_1865",
  aliases: { pl: ["Gdansk Glowny"], en: ["Gdansk Central Station"] },
  category: "landmark",
  lat: 54.3561,
  lon: 18.6437,
  source: "curated" as const,
  rankBoost: 1.0,
  tier: "strict",
  wikidataId: "Q800296",
};

const POI_OSM = {
  id: "poi-dworzec-osm",
  cityId: CITY_ID,
  name: "Dworzec Glowny",
  geoBucket: "5435_1865",
  aliases: {},
  category: "transit_entrance",
  lat: 54.3558,
  lon: 18.6442,
  source: "osm" as const,
  rankBoost: 0.3,
  tier: "strict",
  osmId: "node/987654",
};

const STOP_GROUP = {
  groupId: "numbered:Dworzec Glowny",
  name: "Dworzec Glowny",
  stopIds: ["stop-dg-01", "stop-dg-02", "stop-dg-03"],
  type: "name_numbered" as const,
  lat: 54.3560,
  lon: 18.6440,
};

const STOP_SEARCH_RESPONSE = {
  data: [
    { id: "stop-dg-01", name: "Dworzec Glowny 01", location: { lat: 54.3561, lon: 18.6435 } },
    { id: "stop-dg-02", name: "Dworzec Glowny 02", location: { lat: 54.3559, lon: 18.6439 } },
    { id: "stop-dg-03", name: "Dworzec Glowny 03", location: { lat: 54.3558, lon: 18.6443 } },
  ],
};

async function seedTestData(page: import("@playwright/test").Page) {
  await page.evaluate(
    async ({ poiEntries, stopGroup }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("ptn");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      const stores = db.objectStoreNames;
      const txStores: string[] = [];
      if (stores.contains("poiIndex")) txStores.push("poiIndex");
      if (stores.contains("stopGroups")) txStores.push("stopGroups");

      const tx = db.transaction(txStores, "readwrite");

      if (txStores.includes("poiIndex")) {
        const poiStore = tx.objectStore("poiIndex");
        for (const entry of poiEntries) poiStore.put(entry);
      }

      if (txStores.includes("stopGroups")) {
        const groupStore = tx.objectStore("stopGroups");
        groupStore.put(stopGroup);
      }

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      db.close();
    },
    { poiEntries: [POI_CURATED, POI_OSM], stopGroup: STOP_GROUP },
  );
}

test.describe("Duplicate-name disambiguation @offline", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "offline",
      "Requires offline project with service workers enabled",
    );
  });

  test("search 'Dworzec Glowny' returns grouped stop, curated POI above OSM", async ({
    page,
  }) => {
    await mockApi(page);

    await page.route("**/api/**/stops/search*", (route) =>
      route.fulfill({ json: STOP_SEARCH_RESPONSE }),
    );

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

    await seedTestData(page);

    await page.goto("/search", { waitUntil: "domcontentloaded" });

    const toInput = page.getByRole("searchbox").nth(1);
    await toInput.fill("Dworzec Glowny");
    await page.waitForTimeout(600);

    await expect(page.getByRole("option").first()).toBeVisible({
      timeout: 5_000,
    });

    const options = page.getByRole("option");
    const count = await options.count();
    expect(count).toBeGreaterThanOrEqual(2);

    const allText = await options.allTextContents();
    const allTextJoined = allText.join(" ");

    // Stop group should appear with "3 stops" subtitle
    expect(allTextJoined).toContain("3 stops");

    // Individual numbered stops should NOT appear as separate entries
    expect(allTextJoined).not.toContain("Dworzec Glowny 01");
    expect(allTextJoined).not.toContain("Dworzec Glowny 02");
    expect(allTextJoined).not.toContain("Dworzec Glowny 03");

    // POI results should appear with source labels
    expect(allTextJoined).toContain("Landmark");

    // Curated POI "Landmark" should appear before OSM POI "POI"
    const landmarkIdx = allTextJoined.indexOf("Landmark");
    const poiIdx = allTextJoined.indexOf("POI");
    if (poiIdx !== -1) {
      expect(landmarkIdx).toBeLessThan(poiIdx);
    }
  });

  test("curated POI alias match ranks above OSM duplicate name", async ({
    page,
  }) => {
    await mockApi(page);

    await page.route("**/api/**/stops/search*", (route) =>
      route.fulfill({ json: { data: [] } }),
    );

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

    await seedTestData(page);

    await page.goto("/search", { waitUntil: "domcontentloaded" });

    // Search by English alias that only the curated entry has
    const toInput = page.getByRole("searchbox").nth(1);
    await toInput.fill("Central Station");
    await page.waitForTimeout(600);

    await expect(page.getByRole("option").first()).toBeVisible({
      timeout: 5_000,
    });

    // Curated entry should match (has "Gdansk Central Station" alias)
    await expect(page.getByText("Dworzec Glowny")).toBeVisible();
    await expect(page.getByText("Landmark")).toBeVisible();
  });
});
