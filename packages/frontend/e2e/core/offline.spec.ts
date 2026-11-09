import { test, expect } from "@playwright/test";
import {
  mockApi,
  PTB_MATCHED_FIXED_TIME,
  PTB_MATCHED_STOP_QUERY,
} from "../helpers/mock-api";
import { setFixedDate } from "../helpers/fixed-date";
import { waitForActiveServiceWorker } from "../helpers/service-worker";

test.describe("Offline behavior @offline", () => {
  // Offline tests require service workers (only available in the "offline" project)
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "offline", "Requires offline project with service workers enabled");
  });
  // TS-073: App loads from service worker cache offline
  test("TS-073: app shell loads from cache when offline", async ({
    page,
    context,
  }) => {
    await mockApi(page);

    // Step 1: Load app normally to populate service worker cache
    await page.goto("/");

    // A waiting worker cannot serve an offline navigation yet.
    await waitForActiveServiceWorker(page);

    // Give Workbox time to precache assets
    await page.waitForTimeout(3000);

    // Step 2: Go offline
    await context.setOffline(true);
    // API fixtures must not make an uncached offline request succeed.
    await page.route("**/api/**", route => route.abort());

    // Step 3: Reload -- should serve from cache
    await page.reload({ waitUntil: "domcontentloaded" });

    // Step 4: Assert app shell rendered (not browser offline error page)
    // The nav bar with Map/Search/Settings links should be visible
    await expect(
      page.getByRole("link", { name: "Settings" }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // The page should NOT show Chrome's offline dinosaur or error
    await expect(page.locator("text=ERR_INTERNET_DISCONNECTED")).not.toBeVisible();

    // Restore online for cleanup
    await context.setOffline(false);
  });

  // TS-074: On-device RAPTOR routing works offline
  test("TS-074: RAPTOR routing works offline after GTFS cache", async ({
    page,
    context,
  }) => {
    await setFixedDate(page, PTB_MATCHED_FIXED_TIME);
    await mockApi(page, { routingFixture: "ptb-matched" });

    // Ensure RAPTOR adapter is preferred
    await page.addInitScript(() => {
      const settings = {
        state: { preferredAdapter: "raptor" },
        version: 0,
      };
      localStorage.setItem("ptn-settings", JSON.stringify(settings));
    });

    // Step 1: Establish a valid route online so the matched GTFS and PTB
    // fixtures are persisted in IndexedDB. The same stop pair is planned
    // again after a full offline reload below.
    const routeUrl = `/search?ptn_debug=1&${PTB_MATCHED_STOP_QUERY}`;
    await page.goto(routeUrl);
    await expect(
      page.locator("[data-testid='itinerary-card']").first(),
    ).toBeVisible({ timeout: 20_000 });

    await waitForActiveServiceWorker(page);

    // Step 2: Go offline
    await context.setOffline(true);
    // API fixtures must not make an uncached offline request succeed.
    await page.route("**/api/**", route => route.abort());

    // Track any network requests that escape (should be none for routing)
    const networkRequests: string[] = [];
    page.on("request", (req) => {
      networkRequests.push(req.url());
    });

    // Step 3: Reload the route while offline. This clears in-memory results,
    // forcing the app shell, GTFS, PTB bytes, and route plan through caches.
    await page.reload({ waitUntil: "domcontentloaded" });

    // Step 4: Require a real itinerary from the cached Wasm engine.
    await expect(
      page.locator("[data-testid='itinerary-card']").first(),
    ).toBeVisible({ timeout: 20_000 });

    // Step 5: Assert no /api/plan calls were made (RAPTOR is on-device).
    // Check after the itinerary renders so late requests are included.
    const planCalls = networkRequests.filter((url) => url.includes("/plan"));
    expect(planCalls).toHaveLength(0);

    // Restore online for cleanup
    await context.setOffline(false);
  });

  // TS-075: Schedule-only mode fully offline
  test("TS-075: schedule mode shows nearby stops offline", async ({
    page,
    context,
  }) => {
    await mockApi(page);

    // Enable schedule mode
    await page.addInitScript(() => {
      const settings = JSON.parse(localStorage.getItem("ptn-settings") || "{}");
      settings.state = { ...settings.state, scheduleMode: true };
      localStorage.setItem("ptn-settings", JSON.stringify(settings));
    });

    // Step 1: Load app in schedule mode to populate IndexedDB
    await page.goto("/");

    // Wait for schedule view to render with nearby stops
    await expect(
      page.locator("section[aria-label='Text mode']"),
    ).toBeVisible({ timeout: 10_000 });

    // Wait for GTFS data to sync into IndexedDB
    await page.waitForTimeout(3000);

    // Wait for the service worker to cache the app shell.
    await waitForActiveServiceWorker(page);

    // Give extra time for precache to complete
    await page.waitForTimeout(2000);

    // Step 2: Go offline
    await context.setOffline(true);
    // API fixtures must not make an uncached offline request succeed.
    await page.route("**/api/**", route => route.abort());

    // Track network requests to verify no map tiles requested
    const tileRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("tile") || url.includes(".pbf") || url.includes("mapbox") || url.includes("maptiler")) {
        tileRequests.push(url);
      }
    });

    // Step 3: Reload page while offline
    await page.reload({ waitUntil: "domcontentloaded" });

    // Step 4: Schedule view should render from cache
    await expect(
      page.locator("section[aria-label='Text mode']"),
    ).toBeVisible({ timeout: 10_000 });

    // Step 5: Nearby stops list should be visible (data from IndexedDB)
    // Either shows stops or the "locating" / empty state -- but NOT a crash
    const nearbyList = page.locator("[data-testid='nearby-stops-list']");
    const nearbyEmpty = page.locator("[data-testid='nearby-empty']");
    const nearbyLoading = page.locator("[data-testid='nearby-loading']");
    await expect(
      nearbyList.or(nearbyEmpty).or(nearbyLoading),
    ).toBeVisible({ timeout: 10_000 });

    // Step 6: No map tile requests should have been made
    expect(tileRequests).toHaveLength(0);

    // Restore online for cleanup
    await context.setOffline(false);
  });
});
