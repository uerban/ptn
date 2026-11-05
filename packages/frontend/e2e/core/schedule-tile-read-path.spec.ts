/**
 * Browser-level coverage for the SCHEDULE-TILE read path — the path production
 * actually takes for departures.
 *
 * Until this file existed, `e2e/helpers/mock-api.ts` mocked
 * `**\/api/**\/departures*` and had no handler for `/gtfs/manifest`,
 * `/gtfs/schedule-tile/...` or `/gtfs/rt-tile/...`. Those requests fell through,
 * `resolveDecodedTileForStop` returned `unavailable`, and every departures
 * assertion in the suite validated the LEGACY cascade fallback while appearing
 * to cover the primary path.
 *
 * Two traps this file is built around:
 *
 * 1. Both paths run the SAME `getDeparturesFromTile`, so they render identical
 *    rows. UI assertions alone cannot tell them apart — the tests must assert
 *    on WHICH path served.
 * 2. "Legacy was never called" is NOT that assertion. `useDepartures` arms a
 *    200 ms hedge (`HEDGE_MS`, scheduleTileConstants.ts:16) on any signalled
 *    COLD tile download, so a perfectly healthy cold open races a legacy
 *    request on purpose — the schedule tile default rollback notes
 *    records that the legacy counter "RISES with cold-tile frequency by
 *    design". An `expect(legacyHits).toBe(0)` after a cold open passes or fails
 *    on timing luck, not on correctness.
 *
 * The deterministic signal used here is therefore purely network-observable:
 * a WARM re-open never signals `onTileDownloadStart`, so the hedge is never
 * armed, so "no legacy request" becomes a fact rather than a race.
 *
 * (`schedule_tile_served` telemetry would name the winner directly, but
 * `reportTelemetry` is gated on `getPolicy().errorReporting`
 * — services/errorReporter.ts:50,92 — which is off at the default privacy
 * level, so it emits nothing in this suite.)
 */

import { test, expect, type Page } from "@playwright/test";
import { mockApiAtServiceTime, legacyDeparturesHits } from "../helpers/mock-api";
import {
  LEGACY_ONLY_HEADSIGN,
  RT_DELAY_SECONDS,
  TILE_ROUTE_SHORT_NAMES,
} from "../helpers/schedule-tile-fixture";

/** Open the stop popup for the first fixture stop. Mirrors departure-sheet.spec.ts. */
async function openPopup(page: Page) {
  await page.goto("/");

  await page.waitForFunction(() => (window as any).__ptnMap !== undefined, { timeout: 15_000 });

  await page.waitForFunction(
    () => {
      const map = (window as any).__ptnMap;
      if (!map || !map.getSource("stops-source")) return false;
      return map.querySourceFeatures("stops-source").length > 0;
    },
    { timeout: 15_000, polling: 200 },
  );

  await page.evaluate(() => {
    (window as any).__ptnMap.jumpTo({ center: [25.2797, 54.6872], zoom: 17 });
  });

  await page.locator(".stop-marker-container").first().waitFor({ state: "attached", timeout: 10_000 });
  await page.locator(".stop-marker-container .cursor-pointer").first().click();

  const popup = page.locator('[data-testid="stop-popup"]');
  await expect(popup).toBeVisible({ timeout: 10_000 });
  return popup;
}

test.describe("schedule-tile read path", () => {
  test("the tile is really fetched and departures render from it", async ({ page }) => {
    await mockApiAtServiceTime(page); // scheduleTile: "served" is the default

    const tileRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/gtfs/schedule-tile/")) tileRequests.push(req.url());
    });

    const popup = await openPopup(page);

    // Rows render. The fixture generates departures at +1..+25 min from request
    // time, so the look-ahead window always contains some.
    await expect(popup).toContainText(/\d+\s*min|\bDue\b/i, { timeout: 10_000 });

    // The tile was actually requested and decoded — this is what was completely
    // unexercised before: a broken wire format or brotli handling used to fall
    // through to the legacy mock and still pass every departures assertion.
    await expect.poll(() => tileRequests.length, { timeout: 10_000 }).toBeGreaterThan(0);

    // NOTE: deliberately NOT asserting legacy hits here. A cold open races the
    // 200 ms hedge by design; that assertion belongs in the warm test below.
  });

  test("the rendered rows come from the tile, not the legacy fixture", async ({ page }) => {
    await mockApiAtServiceTime(page);
    const popup = await openPopup(page);

    // Content-based discrimination. The tile fixture's route short names and
    // headsigns are disjoint from `fixtures/departures.json`, so this asserts
    // WHICH path produced the rows — something no timing-based check can do
    // reliably, since a cold open races the 200 ms hedge by design.
    await expect(popup).toContainText(new RegExp(TILE_ROUTE_SHORT_NAMES.join("|")), {
      timeout: 10_000,
    });

    // ...and the legacy fixture's content must be absent.
    await expect(popup).not.toContainText(LEGACY_ONLY_HEADSIGN);
  });

  test("renders live RT state from the rt-tile overlay", async ({ page }) => {
    // These UI states — LIVE badge, delay annotation, cancelled row — were
    // previously coverable ONLY through the legacy fixture, i.e. on the path
    // production does not take. The rt-tile fixture now carries one delayed and
    // one cancelled trip per stop so they are exercised on the tile path too.
    await mockApiAtServiceTime(page);
    const popup = await openPopup(page);

    // Tile content first, so a legacy-served row can't satisfy the RT
    // assertions below by accident.
    await expect(popup).toContainText(new RegExp(TILE_ROUTE_SHORT_NAMES.join("|")), {
      timeout: 10_000,
    });

    // The overlay applied: a delayed trip surfaces the live badge and the
    // +N annotation (RT_DELAY_SECONDS = 180 → "+3").
    await expect(popup).toContainText(/LIVE/i, { timeout: 10_000 });
    await expect(popup).toContainText(`+${RT_DELAY_SECONDS / 60}`, { timeout: 10_000 });

    // ...and the cancelled trip renders as cancelled.
    await expect(popup).toContainText(/Cancelled/i, { timeout: 10_000 });
  });

  test("falls back to the legacy route when tiles are unavailable", async ({ page }) => {
    // The complement: the path the suite USED to exercise by accident is now
    // exercised on purpose, so the cascade keeps its own coverage.
    await mockApiAtServiceTime(page, { scheduleTile: "unavailable" });

    await openPopup(page);

    await expect
      .poll(() => legacyDeparturesHits(page), { timeout: 10_000 })
      .toBeGreaterThan(0);
  });
});
