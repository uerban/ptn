import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";
import { REF_URL, REF_FIXED_TIME } from "./route-overlay-refUrl.ts";

/**
 * layer-stacking regression: stop popup remains tappable when the transit polyline runs
 * underneath the marker.

 *
 * Phase 1 inserts each `guidance-leg-layer-*` below the `stops-clusters`
 * stop layer via `beforeId` in `rafScheduler.ts:99–117`, so tap targets
 * fall on stop markers (HTML `.stop-marker-container` overlays + map
 * canvas hit on stops layer) instead of the overlay polyline. There was
 * no automated guard against a regression that flipped the order — this
 * spec adds one.
 *
 * Two assertions:
 *   1. Layer-stacking invariant: every `guidance-leg-layer-*` registered
 *      on the map is positioned strictly below `stops-clusters` in the
 *      style's `layers` array.
 *   2. End-to-end behaviour: at a 360x740 viewport (mobile QA target),
 *      tapping the visible station card after the overlay loads opens
 *      the stop popup. If the polyline drifted on top of the marker the
 *      tap would land on the line and the popup would never appear.
 */
test.describe("RouteOverlay popup-vs-polyline stacking @mock-api", () => {
  test.beforeEach(async ({ page }) => {
    // Match the deterministic-time pattern used by the rest of the
    // route-overlay specs — the Vilnius fixture's daytime trips need to
    // be in the future when the auto-search fires.
    await page.clock.setFixedTime(REF_FIXED_TIME);
    await mockApi(page, { catalogNow: REF_FIXED_TIME });
  });

  test("stop popup remains tappable under transit polyline at 360x740", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(REF_URL);

    // Pick the first itinerary to enter guidance mode — `itinerary-card`
    // is the existing testid (Search/RouteResults), not `route-result-card`
    // from the original plan-doc pseudo-code.
    await page.waitForSelector('[data-testid="itinerary-card"]', {
      timeout: 15_000,
    });
    await page.locator('[data-testid="itinerary-card"]').first().click();

    // Wait for the route-overlay leg source to be live on the map — the
    // analogue of `data-testid="route-overlay"` in the original pseudo-
    // code. The overlay is a MapLibre source/layer pair, not a DOM
    // element, so we probe via __ptnMap.
    await page.waitForFunction(
      () => {
        const map = (window as unknown as {
          __ptnMap?: { getSource: (id: string) => unknown };
        }).__ptnMap;
        return !!map?.getSource("guidance-leg-0");
      },
      { timeout: 15_000 },
    );

    // Layer-stacking invariant: every guidance-leg-layer-* sits strictly
    // below `stops-clusters` in the style's layer array.
    const stacking = await page.evaluate(() => {
      const map = (window as unknown as {
        __ptnMap?: {
          getStyle: () => { layers: { id: string }[] };
        };
      }).__ptnMap;
      const style = map?.getStyle();
      const layers = style?.layers ?? [];
      const stopsIdx = layers.findIndex((l) => l.id === "stops-clusters");
      const legIdxs = layers
        .map((l, i) => (l.id.startsWith("guidance-leg-layer-") ? i : -1))
        .filter((i) => i >= 0);
      return { stopsIdx, legIdxs, layerIds: layers.map((l) => l.id) };
    });
    expect(
      stacking.stopsIdx,
      `stops-clusters must exist; found layers: ${stacking.layerIds.join(", ")}`,
    ).toBeGreaterThan(-1);
    expect(
      stacking.legIdxs.length,
      "expected at least one guidance-leg-layer-* on the map",
    ).toBeGreaterThan(0);
    for (const legIdx of stacking.legIdxs) {
      expect(
        legIdx,
        `guidance leg layer at index ${legIdx} must be below stops-clusters at ${stacking.stopsIdx}`,
      ).toBeLessThan(stacking.stopsIdx);
    }

    // Behavioural check: bring stop markers into view and tap one.
    // After the overlay mounts the map jumps to the route bounds; we
    // re-zoom into a known cluster of fixture stops at zoom 17 so the
    // station-card markers (ZOOM_DOTS_MIN <= z and HTML markers from
    // `updateMarkers`) are rendered. Without this, the overlay-fitted
    // viewport may sit at a zoom below the marker-render threshold.
    await page.evaluate(() => {
      (window as unknown as {
        __ptnMap: { jumpTo: (o: { center: number[]; zoom: number }) => void };
      }).__ptnMap.jumpTo({
        center: [25.2797, 54.6872],
        zoom: 17,
      });
    });

    await page
      .locator(".stop-marker-container")
      .first()
      .waitFor({ state: "attached", timeout: 10_000 });

    // Click the visible card; if the leg polyline had drifted above the
    // marker container in z-order, this click would land on the canvas
    // (or an interactive map layer) instead and the popup would never
    // open.
    await page
      .locator(".stop-marker-container .cursor-pointer")
      .first()
      .click();

    await expect(
      page.locator('[data-testid="stop-popup"]'),
    ).toBeVisible({ timeout: 10_000 });
  });

  // Vitest covers the class names; this asserts the actual layout box obeys the floor against a
  // live MapLibre marker.
  test("station-card click target ≥ 44x44 px on 360 viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/");

    await page.waitForFunction(
      () => (window as unknown as Record<string, unknown>).__ptnMap !== undefined,
      { timeout: 15_000 },
    );
    // Wait for stops-source to be POPULATED (not just registered). See
    // stops-cache-poisoning.spec.ts for the rationale: source is created
    // empty before stops arrive from the preloader, so gating on
    // `getSource() !== undefined` would let `jumpTo` race the data.
    await page.waitForFunction(
      () => {
        const map = (window as unknown as {
          __ptnMap?: {
            getSource: (id: string) => unknown;
            querySourceFeatures: (id: string) => unknown[];
          };
        }).__ptnMap;
        if (!map || !map.getSource("stops-source")) return false;
        return map.querySourceFeatures("stops-source").length > 0;
      },
      { timeout: 15_000, polling: 200 },
    );

    await page.evaluate(() => {
      (window as unknown as {
        __ptnMap: { jumpTo: (o: { center: number[]; zoom: number }) => void };
      }).__ptnMap.jumpTo({
        center: [25.2797, 54.6872],
        zoom: 17,
      });
    });

    await page
      .locator(".stop-marker-container")
      .first()
      .waitFor({ state: "attached", timeout: 10_000 });

    const card = page.locator(".stop-marker-container .cursor-pointer").first();
    const box = await card.boundingBox();
    expect(box, "click target must have a layout box").not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});
