import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

/**
 * iOS Safari auto-zooms the visual viewport whenever a focused form control's
 * computed font-size is < 16px, and — because the viewport meta intentionally
 * omits `maximum-scale` (kept that way so the page stays accessible-zoomable
 * and the Lighthouse `meta-viewport` a11y audit, a hard ≥0.95 gate, passes) —
 * never restores the zoom afterward. On a full-screen MapLibre PWA the only
 * non-map surface to pinch back out over is the header, so the page stays
 * stuck zoomed-in and the autocomplete / saved-places list gets magnified off
 * the screen.
 *
 * The fix (src/index.css) raises form-control text to the 16px threshold on
 * coarse-pointer (touch) devices only. This guards both halves:
 *   - touch  → search inputs MUST be ≥16px (no auto-zoom trigger)
 *   - fine   → desktop keeps the compact text-sm/14px design (rule must not leak)
 *
 * Runs under both pr-chromium (Desktop Chrome, fine pointer) and pr-webkit
 * (iPhone 14, coarse pointer), so the single assertion exercises both branches.
 */
test.describe("search input font-size (iOS auto-zoom guard) @mock-api", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("search inputs clear the 16px no-zoom floor on touch", async ({ page }) => {
    await page.goto("/search");

    // The "To" field is always an <input role=searchbox> (the "From" field can
    // swap to a live-GPS pill button once geolocation resolves), and is last in
    // DOM order — i18n-independent selector.
    const toInput = page.locator('input[role="searchbox"]').last();
    await expect(toInput).toBeVisible();

    const fontPx = await toInput.evaluate(
      (el) => parseFloat(getComputedStyle(el).fontSize),
    );
    const coarse = await page.evaluate(
      () => window.matchMedia("(pointer: coarse)").matches,
    );

    if (coarse) {
      // iOS would auto-zoom anything below 16px; the unlayered rule must win
      // over Tailwind's `.text-sm` utility (= 14px) on the input.
      expect(fontPx).toBeGreaterThanOrEqual(16);
    } else {
      // Fine pointer (no auto-zoom risk): the compact design is preserved.
      expect(fontPx).toBeLessThan(16);
    }
  });
});
