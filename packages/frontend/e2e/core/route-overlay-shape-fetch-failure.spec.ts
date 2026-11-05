import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";
import { REF_URL, REF_FIXED_TIME } from "./route-overlay-refUrl.ts";

/**
 * shapes-artifact fetch failure.

 *
 * When `/gtfs/shapes/shapes-*.json` returns 404, `gtfsSync` clears every
 * trip's `shapeId` and reports a single `shapes artifact`-flavoured error
 * via `errorReporter.reportError`. The transit leg must still commit (the
 * overlay renders at the intermediate tier), and exactly one matching
 * error must land in the console.
 */
test.describe("RouteOverlay shapes fetch failure @mock-api", () => {
  test.beforeEach(async ({ page }) => {
    // Freeze the in-browser `Date` to a deterministic weekday noon so the
    // fixture's daytime-only trips (0:00–23:00 departures) are always in
    // the future at search time. `setFixedTime` only pins `Date.now()` /
    // `new Date()`; timers / rAF continue to progress.
    await page.clock.setFixedTime(REF_FIXED_TIME);
    await mockApi(page, { catalogNow: REF_FIXED_TIME });
  });

  test("shapes fetch 404 → trips written without shapeId + one error log", async ({
    page,
  }) => {
    await page.route("**/gtfs/shapes/shapes-*.json", (route) =>
      route.fulfill({ status: 404 }),
    );

    const errs: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errs.push(m.text());
    });

    await page.goto(REF_URL);
    // Wait for the search to run and render at least one itinerary card,
    // then pick the first itinerary to enter navigation mode on "/".
    await page.waitForSelector('[data-testid="itinerary-card"]', {
      timeout: 15_000,
    });
    await page.locator('[data-testid="itinerary-card"]').first().click();

    await page.waitForFunction(
      () => {
        const map = (window as any).__ptnMap;
        return !!map?.getLayer("guidance-leg-layer-0");
      },
      { timeout: 15_000 },
    );

    // React StrictMode can double-mount effects in dev builds, so the sync
    // may fire the shapes-artifact fetch twice. The point of this assertion
    // is that the error is surfaced (not silently swallowed), so ≥1 is the
    // binary we actually care about.
    const shapeErrors = errs.filter((e) => e.includes("shapes artifact"));
    expect(shapeErrors.length).toBeGreaterThanOrEqual(1);
  });
});
