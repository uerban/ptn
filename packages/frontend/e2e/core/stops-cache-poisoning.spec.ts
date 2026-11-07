import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { seedCompletedSetup } from "../helpers/setup-complete";

/**
 * Regression test for the PWA stops loader cache-poisoning bug.
 *
 * Production symptom: Workbox NetworkFirst SW had cached `{ "data": [] }`
 * for `/api/<city>/stops/all` during an earlier moment of badness. The
 * preloader treated an empty response as silent success, so the map only
 * ever showed stops near the user (from `/stops/nearby`). Reload + clear
 * cache + restart didn't help — only a full PWA reinstall.
 *
 * The fix: empty-data is treated as a retryable failure, retries pass
 * `{ bypassCache: true }` which appends a `?_r=<ts>` cache-buster, and
 * `stopStore.upsertStops` now updates in-memory state before persisting
 * to IDB. This spec asserts the recovery end-to-end: serve empty data on
 * the first hit, full city on the bypass-cache retry, confirm the map
 * loads city-wide stops.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const stopsAll = JSON.parse(readFileSync(join(fixturesDir, "stops-all.json"), "utf-8"));
const stopsNearby = JSON.parse(readFileSync(join(fixturesDir, "stops-nearby.json"), "utf-8"));
const colorConfig = JSON.parse(readFileSync(join(fixturesDir, "color-config.json"), "utf-8"));
const departuresFixture = JSON.parse(readFileSync(join(fixturesDir, "departures.json"), "utf-8"));

test.describe("Stops cache-poisoning recovery @mock-api", () => {
  test("retries /stops/all with bypassCache after an empty first response", async ({ page, context }) => {
    await context.grantPermissions(["geolocation"]);
    // The map follows the device position, so it must sit where the stop
    // fixtures are or querySourceFeatures sees no rendered tiles.
    await context.setGeolocation({ latitude: 54.6872, longitude: 25.2797 });

    // Reproduce the SW cache-poisoning condition without involving a real SW:
    // first /stops/all hit returns 200 + empty data, subsequent hits return
    // the full fixture. We assert both that the second request carries the
    // `_r=` cache-buster (proving bypassCache propagation) AND that the map
    // ends up rendering the full stop set (proving the in-memory recovery
    // actually lands).
    const stopsAllUrls: string[] = [];
    await page.route("**/api/**/stops/all*", (route) => {
      const url = route.request().url();
      stopsAllUrls.push(url);
      // Empty until a request carries the cache-buster — proves recovery is
      // driven by `?_r=` (the bypassCache:true → retry path) rather than any
      // ambient StrictMode double-mount or unrelated re-fetch.
      if (!/[?&]_r=\d+/.test(url)) {
        return route.fulfill({ json: { data: [] } });
      }
      return route.fulfill({ json: stopsAll });
    });

    // The other endpoints can use the standard mocks; we only need to
    // tamper with /stops/all. Inline them here since mockApi() would
    // overwrite the route above.
    await page.route("**/api/**/stops/nearby*", (route) => route.fulfill({ json: stopsNearby }));
    await page.route("**/api/**/color-config", (route) => route.fulfill({ json: colorConfig }));
    await page.route("**/api/**/departures*", (route) => route.fulfill({ json: departuresFixture }));
    await page.route("**/api/**/health**", (route) => route.fulfill({ json: { status: "ok" } }));
    // No catalog stub: this spec asserts the /stops/all recovery path and the
    // map source, neither of which reads the routing catalog. It used to stub
    // `/gtfs/raptor-data` only because that endpoint existed.
    // Block shapes — not needed for this test, and the hash check would
    // require running mockApi for the SHAPES_BODY constant.
    await page.route("**/gtfs/shapes/shapes-*.json", (route) => route.fulfill({ status: 404 }));

    await seedCompletedSetup(page, { cityId: "vilnius" });
    await page.goto("/");

    // Wait for at least one cache-bypassed request. Retry backoffs are
    // 1s + 4s, so a single retry is < 2s in the happy case.
    await expect
      .poll(() => stopsAllUrls.some((u) => /[?&]_r=\d+/.test(u)), { timeout: 15_000 })
      .toBe(true);

    // Initial attempt must be without bypass (proves the bypass kicks in
    // only on the retry, not by default).
    expect(stopsAllUrls[0]).not.toMatch(/_r=/);

    // Recovered data lands in the map source. The source is added in a
    // separate React effect after stopStore updates.
    await page.waitForFunction(
      () => {
        const map = (window as any).__ptnMap;
        if (!map) return false;
        if (!map.getSource("stops-source")) return false;
        return map.querySourceFeatures("stops-source").length > 0;
      },
      undefined,
      { timeout: 15_000, polling: 250 },
    );
  });
});
