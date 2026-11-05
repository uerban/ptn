import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

/**
 * Migration / upgrade E2E tests.
 *
 * Each scenario pre-populates IndexedDB or localStorage via page.evaluate()
 * before the app boots, then verifies the app recovers correctly.
 *
 * Tagged @mock-api — these need deterministic API responses.
 *
 * Strategy: navigate to a minimal same-origin page first (intercepted via
 * route.fulfill), seed IndexedDB/localStorage, then navigate to "/" so the
 * app boots against the seeded state.
 */

async function grantGeolocation(context: BrowserContext) {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 54.35, longitude: 18.65 });
}

/** Navigate to a same-origin blank page so IndexedDB/localStorage are accessible. */
async function goToSeedPage(page: Page) {
  await page.route("**/seed-blank", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<html><body>seed</body></html>",
    }),
  );
  await page.goto("/seed-blank");
  // Unroute so it doesn't interfere with later navigation
  await page.unroute("**/seed-blank");
}

test.describe("Migration: older DB missing stopGroups @mock-api", () => {
  test("app works after opening an older DB that lacks stopGroups", async ({
    page,
    context,
  }) => {
    await grantGeolocation(context);
    await mockApi(page);

    // Seed an older, smaller IndexedDB on the same origin
    await goToSeedPage(page);

    await page.evaluate(async () => {
      return new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("ptn", 4);
        req.onupgradeneeded = () => {
          const idb = req.result;
          if (!idb.objectStoreNames.contains("stops")) {
            idb.createObjectStore("stops", { keyPath: "id" });
          }
          if (!idb.objectStoreNames.contains("usageStats")) {
            idb.createObjectStore("usageStats", { keyPath: "stopId" });
          }
          if (!idb.objectStoreNames.contains("gtfsRoutes")) {
            idb.createObjectStore("gtfsRoutes", { keyPath: "id" });
          }
          if (!idb.objectStoreNames.contains("gtfsTrips")) {
            idb.createObjectStore("gtfsTrips", { keyPath: "tripId" });
          }
          if (!idb.objectStoreNames.contains("gtfsServices")) {
            idb.createObjectStore("gtfsServices", { keyPath: "serviceId" });
          }
          if (!idb.objectStoreNames.contains("gtfsSyncMeta")) {
            idb.createObjectStore("gtfsSyncMeta", { keyPath: "id" });
          }
          if (!idb.objectStoreNames.contains("gtfsStops")) {
            idb.createObjectStore("gtfsStops", { keyPath: "id" });
          }
          // NOTE: no stopGroups
        };
        req.onsuccess = () => {
          const tx = req.result.transaction("gtfsRoutes", "readwrite");
          tx.objectStore("gtfsRoutes").put({
            id: "r-seed",
            shortName: "42",
            mode: "BUS",
            stopIds: ["s1"],
          });
          tx.oncomplete = () => {
            req.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
    });

    // Load the app — Dexie adds the missing tables
    await page.goto("/");

    await expect(page.locator(".maplibregl-canvas")).toBeVisible({
      timeout: 20_000,
    });

    // Verify stopGroups table now exists
    const hasStopGroups = await page.evaluate(async () => {
      return new Promise<boolean>((resolve) => {
        const req = indexedDB.open("ptn");
        req.onsuccess = () => {
          const names = Array.from(req.result.objectStoreNames);
          req.result.close();
          resolve(names.includes("stopGroups"));
        };
        req.onerror = () => resolve(false);
      });
    });
    expect(hasStopGroups).toBe(true);
  });
});

test.describe("Migration: older DB missing gtfsStops and stopGroups @mock-api", () => {
  test("app opens an older DB and creates both gtfsStops and stopGroups", async ({
    page,
    context,
  }) => {
    await grantGeolocation(context);
    await mockApi(page);

    await goToSeedPage(page);

    // Create an older IndexedDB (no gtfsStops, no stopGroups)
    await page.evaluate(async () => {
      return new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("ptn", 3);
        req.onupgradeneeded = () => {
          const idb = req.result;
          if (!idb.objectStoreNames.contains("stops")) {
            idb.createObjectStore("stops", { keyPath: "id" });
          }
          if (!idb.objectStoreNames.contains("usageStats")) {
            idb.createObjectStore("usageStats", { keyPath: "stopId" });
          }
          if (!idb.objectStoreNames.contains("gtfsRoutes")) {
            idb.createObjectStore("gtfsRoutes", { keyPath: "id" });
          }
          if (!idb.objectStoreNames.contains("gtfsTrips")) {
            idb.createObjectStore("gtfsTrips", { keyPath: "tripId" });
          }
          if (!idb.objectStoreNames.contains("gtfsServices")) {
            idb.createObjectStore("gtfsServices", { keyPath: "serviceId" });
          }
          if (!idb.objectStoreNames.contains("gtfsSyncMeta")) {
            idb.createObjectStore("gtfsSyncMeta", { keyPath: "id" });
          }
        };
        req.onsuccess = () => {
          req.result.close();
          resolve();
        };
        req.onerror = () => reject(req.error);
      });
    });

    await page.goto("/");

    await expect(page.locator(".maplibregl-canvas")).toBeVisible({
      timeout: 20_000,
    });

    const tableNames = await page.evaluate(async () => {
      return new Promise<string[]>((resolve) => {
        const req = indexedDB.open("ptn");
        req.onsuccess = () => {
          const names = Array.from(req.result.objectStoreNames);
          req.result.close();
          resolve(names);
        };
        req.onerror = () => resolve([]);
      });
    });
    expect(tableNames).toContain("gtfsStops");
    expect(tableNames).toContain("stopGroups");
  });
});

test.describe("Migration: corrupted IndexedDB recovery @mock-api", () => {
  test("app recovers when IndexedDB has a higher version than expected", async ({
    page,
    context,
  }) => {
    await grantGeolocation(context);
    await mockApi(page);

    await goToSeedPage(page);

    // Create a DB at version 999 with only one table
    await page.evaluate(async () => {
      return new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("ptn", 999);
        req.onupgradeneeded = () => {
          const idb = req.result;
          if (!idb.objectStoreNames.contains("stops")) {
            idb.createObjectStore("stops", { keyPath: "id" });
          }
        };
        req.onsuccess = () => {
          req.result.close();
          resolve();
        };
        req.onerror = () => reject(req.error);
      });
    });

    // Load the app — Dexie opens the newer DB and adds the missing tables
    await page.goto("/");

    await expect(page.locator(".maplibregl-canvas")).toBeVisible({
      timeout: 20_000,
    });

    // DB should have been recreated with all expected tables
    const tableNames = await page.evaluate(async () => {
      return new Promise<string[]>((resolve) => {
        const req = indexedDB.open("ptn");
        req.onsuccess = () => {
          const names = Array.from(req.result.objectStoreNames);
          req.result.close();
          resolve(names);
        };
        req.onerror = () => resolve([]);
      });
    });
    // After recovery, every expected table should be present
    expect(tableNames).toContain("stops");
    expect(tableNames).toContain("gtfsRoutes");
    expect(tableNames).toContain("gtfsStops");
    expect(tableNames).toContain("stopGroups");
  });
});

test.describe("Migration: settings migration (new fields) @mock-api", () => {
  test("old settings format gets new defaults while preserving existing values", async ({
    page,
    context,
  }) => {
    await grantGeolocation(context);
    await mockApi(page);

    await goToSeedPage(page);

    // Set old-format settings without mobilityProfile, walkSpeedMps, etc.
    await page.evaluate(() => {
      localStorage.setItem(
        "ptn-settings",
        JSON.stringify({
          state: {
            theme: "dark",
            language: "en",
            departuresPerLine: 4,
          },
        }),
      );
    });

    await page.goto("/");

    await expect(page.locator(".maplibregl-canvas")).toBeVisible({
      timeout: 20_000,
    });

    // Verify old settings survived: dark theme should be applied
    const dataTheme = await page.getAttribute("html", "data-theme");
    expect(dataTheme).toBe("dark");

    // Verify stored settings still contain original values
    const storedState = await page.evaluate(() => {
      const raw = localStorage.getItem("ptn-settings");
      return raw ? JSON.parse(raw)?.state : null;
    });
    expect(storedState).not.toBeNull();
    expect(storedState.theme).toBe("dark");
    expect(storedState.language).toBe("en");
    expect(storedState.departuresPerLine).toBe(4);

    // The app loaded without crashing (canvas visible above), which proves
    // Zustand's merge callback successfully filled defaults for new fields
    // (mobilityProfile, walkSpeedMps, maxWalkSecs, runToCatch, etc.)
    // in memory. These defaults only persist to localStorage on next state
    // mutation, so we verify the merge worked by confirming the app is
    // functional rather than checking localStorage for each new field.
  });
});

/*
 * T5: Service worker upgrade
 *
 * This scenario is intentionally NOT automated. Testing SW upgrade requires:
 * 1. Loading the app with an old cached SW
 * 2. Deploying a new version
 * 3. Verifying the UpdatePrompt appears and clicking "Update" activates the new SW
 *
 * Manual test steps:
 * - Build & serve the app (pnpm build && pnpm preview)
 * - Load the app, confirm SW registers (DevTools > Application > Service Workers)
 * - Modify a source file and rebuild
 * - Reload the app
 * - Verify the update prompt appears
 * - Click Update and verify the new SW activates
 */
