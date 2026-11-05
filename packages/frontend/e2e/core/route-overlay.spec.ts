import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";
import { REF_URL, REF_FIXED_TIME } from "./route-overlay-refUrl.ts";

test.describe("RouteOverlay @mock-api", () => {
  test.beforeEach(async ({ page }) => {
    // Freeze the in-browser `Date` to a deterministic weekday noon so the
    // fixture's daytime-only trips (0:00–23:00 departures) are always in
    // the future at search time. Using `setFixedTime` (not `install`) so
    // timers / rAF continue to progress — only `Date.now()` / `new Date()`
    // are pinned. Must be set before any navigation.
    await page.clock.setFixedTime(REF_FIXED_TIME);
    await mockApi(page, { catalogNow: REF_FIXED_TIME });
    await page.goto("/");

    // Wait for map to be available and style to be loaded
    await page.waitForFunction(
      () => {
        const map = (window as any).__ptnMap;
        return map && map.isStyleLoaded();
      },
      { timeout: 15_000 },
    );
  });

  test("setPaintProperty updates opacity without removing layers", async ({
    page,
  }) => {
    // Verify that MapLibre's setPaintProperty keeps layers intact —
    // this is the mechanism the RouteOverlay style-update effect relies on.
    const layerIds = await page.evaluate(() => {
      const map = (window as any).__ptnMap;
      if (!map) throw new Error("Map not available");

      const ids = ["0", "1", "2"];
      const coords = [
        [
          [25.279, 54.687],
          [25.28, 54.688],
        ],
        [
          [25.28, 54.688],
          [25.281, 54.689],
        ],
        [
          [25.281, 54.689],
          [25.282, 54.69],
        ],
      ];

      for (let i = 0; i < ids.length; i++) {
        map.addSource(`guidance-leg-${ids[i]}`, {
          type: "geojson",
          data: {
            type: "Feature",
            geometry: { type: "LineString", coordinates: coords[i] },
            properties: {},
          },
        });
        map.addLayer({
          id: `guidance-leg-layer-${ids[i]}`,
          type: "line",
          source: `guidance-leg-${ids[i]}`,
          paint: {
            "line-color": "#1d4ed8",
            "line-width": 5,
            "line-opacity": 0.4,
          },
        });
      }

      return ids.map((id) => `guidance-leg-layer-${id}`);
    });

    expect(layerIds).toHaveLength(3);

    // Verify all layers exist
    const allExistBefore = await page.evaluate((ids: string[]) => {
      const map = (window as any).__ptnMap;
      return ids.every((id) => map.getLayer(id) !== undefined);
    }, layerIds);
    expect(allExistBefore).toBe(true);

    // Update paint properties in place (same mechanism as RouteOverlay style-update effect)
    await page.evaluate((ids: string[]) => {
      const map = (window as any).__ptnMap;
      const opacities = [0.3, 1.0, 0.7]; // completed, current, upcoming
      ids.forEach((id, i) => {
        map.setPaintProperty(id, "line-opacity", opacities[i]);
      });
    }, layerIds);

    // Verify all layers STILL exist after paint property update (no removal/re-add)
    const allExistAfter = await page.evaluate((ids: string[]) => {
      const map = (window as any).__ptnMap;
      return ids.every((id) => map.getLayer(id) !== undefined);
    }, layerIds);
    expect(allExistAfter).toBe(true);

    // Verify the opacity was actually updated
    const opacities = await page.evaluate((ids: string[]) => {
      const map = (window as any).__ptnMap;
      return ids.map((id) => map.getPaintProperty(id, "line-opacity"));
    }, layerIds);
    expect(opacities).toEqual([0.3, 1.0, 0.7]);

    // Cleanup
    await page.evaluate((ids: string[]) => {
      const map = (window as any).__ptnMap;
      ids.forEach((id) => {
        const sourceId = id.replace("guidance-leg-layer-", "guidance-leg-");
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
      });
    }, layerIds);
  });

  // Happy-path assertion: a shaped Vilnius itinerary renders as a multi-point LineString on
  // `guidance-leg-0`. The mock-api harness now serves a Vilnius-shaped raptor-data fixture plus a
  // hashed shapes.json, and `Search.tsx` parses `fromStopId` / `toStopId` query params — so the
  // flow from REF_URL → auto-search → pick itinerary → guidance mode runs end-to-end.
  test("shaped Vilnius itinerary renders a multi-point LineString", async ({
    page,
  }) => {
    await page.goto(REF_URL);
    // Wait for the search to run and render at least one itinerary card.
    await page.waitForSelector('[data-testid="itinerary-card"]', {
      timeout: 15_000,
    });
    // Pick the first itinerary to enter navigation mode on "/".
    await page.locator('[data-testid="itinerary-card"]').first().click();

    // Wait for the source to exist AND for its LineString to have been
    // populated with at least 3 coordinates — this is the shape-tier
    // geometry (Google's 3-point polyline in the shapes fixture).
    await page.waitForFunction(
      () => {
        const map = (window as any).__ptnMap;
        const src = map?.getSource("guidance-leg-0");
        if (!src) return false;
        const data = (src as any).serialize?.().data;
        const coords = data?.geometry?.coordinates as
          | [number, number][]
          | undefined;
        return Array.isArray(coords) && coords.length > 2;
      },
      { timeout: 15_000 },
    );
    const coords = await page.evaluate(() => {
      const map = (window as any).__ptnMap;
      const src = map.getSource("guidance-leg-0");
      return ((src as any).serialize() as any).data.geometry.coordinates as [
        number,
        number,
      ][];
    });
    expect(coords.length).toBeGreaterThan(2);
  });
});
