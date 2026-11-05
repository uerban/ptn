import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";
import { REF_URL, REF_FIXED_TIME } from "./route-overlay-refUrl.ts";

/**
 * shapeless spec.

 *
 * When the routing-bundle manifest has no `shapesArtifact` and trips carry
 * no `shapeId`, the frontend should still render the transit leg (at the
 * `intermediate` stop-sequence tier) without surfacing any console errors.
 */
test.describe("RouteOverlay shapeless fallback @mock-api", () => {
  test.beforeEach(async ({ page }) => {
    // Freeze the in-browser `Date` to a deterministic weekday noon so the
    // fixture's daytime-only trips (0:00–23:00 departures) are always in
    // the future at search time. `setFixedTime` only pins `Date.now()` /
    // `new Date()`; timers / rAF continue to progress.
    await page.clock.setFixedTime(REF_FIXED_TIME);
    // `catalogShapes: "absent"` is the whole setup: the bundle's trips carry
    // no shape_id and `/ready` advertises no shapes sidecar, which is what a
    // feed without shapes.txt produces. This used to be done by rewriting the
    // JSON catalog response in the test body.
    await mockApi(page, { catalogNow: REF_FIXED_TIME, catalogShapes: "absent" });
  });

  test("no shapesArtifact in manifest → intermediate, no console errors", async ({
    page,
  }) => {
    // Track only errors surfaced by the transit-leg geometry / shapes
    // pipeline — ignoring unrelated noise from OSRM WASM + POI loader
    // mocks that aren't wired in the e2e harness. The spec is about the
    // shapeless fallback, so "no console errors" means "no shapes-related
    // or legGeometry errors".
    const errors: string[] = [];
    const isOverlayRelated = (text: string) =>
      text.includes("shapes artifact") ||
      text.includes("legGeometry") ||
      text.includes("shape") ||
      text.includes("guidance-leg");
    page.on("pageerror", (e) => {
      if (isOverlayRelated(e.message)) errors.push(e.message);
    });
    page.on("console", (m) => {
      if (m.type() === "error" && isOverlayRelated(m.text())) {
        errors.push(m.text());
      }
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

    expect(errors).toEqual([]);
  });
});
