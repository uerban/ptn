import { test, expect, type Page } from "@playwright/test";
import { mockApiAtServiceTime } from "../helpers/mock-api";

/** Navigate to map, zoom into fixture center, and wait for station card markers. */
async function openMap(page: Page) {
  await mockApiAtServiceTime(page);
  await page.goto("/");

  // Wait for __ptnMap to be available
  await page.waitForFunction(() => (window as unknown as Record<string, unknown>).__ptnMap !== undefined, {
    timeout: 15_000,
  });

  // Wait for stops-source to be POPULATED (not just registered). The source
  // is added with an empty FeatureCollection in TransitMap's first effect run
  // before stops arrive from the preloader; gating on `getSource() !== undefined`
  // satisfies as soon as the empty source exists, so a subsequent `jumpTo` runs
  // updateMarkers with `stopsRef.current === []` and no `.stop-marker-container`
  // is created. Wait for actual features so the marker render after `jumpTo`
  // is essentially synchronous. Pattern lifted from stops-cache-poisoning.spec.ts.
  await page.waitForFunction(
    () => {
      const map = (window as unknown as Record<string, {
        getSource: (id: string) => unknown;
        querySourceFeatures: (id: string) => unknown[];
      }>).__ptnMap;
      if (!map || !map.getSource("stops-source")) return false;
      return map.querySourceFeatures("stops-source").length > 0;
    },
    { timeout: 15_000, polling: 200 }
  );

  // Jump to fixture center at zoom 17 so station cards appear
  await page.evaluate(() => {
    (window as unknown as Record<string, { jumpTo: (opts: { center: number[]; zoom: number }) => void }>).__ptnMap.jumpTo({
      center: [25.2797, 54.6872],
      zoom: 17,
    });
  });

  // Wait for at least one stop marker to appear (container has zero size so use 'attached')
  await page.locator(".stop-marker-container").first().waitFor({ state: "attached", timeout: 10_000 });
}

test.describe("Stop popup @mock-api", () => {
  test("clicking a station card opens the popup", async ({ page }) => {
    await openMap(page);

    // Click the visible card inside the marker container
    await page.locator(".stop-marker-container .cursor-pointer").first().click();

    await expect(page.locator('[data-testid="stop-popup"]')).toBeVisible({
      timeout: 10_000,
    });
  });

  test("popup shows stop name and departure times", async ({ page }) => {
    await openMap(page);

    await page.locator(".stop-marker-container .cursor-pointer").first().click();

    const popup = page.locator('[data-testid="stop-popup"]');
    await expect(popup).toBeVisible({ timeout: 10_000 });

    // Stop name should be non-empty
    const stopName = popup.locator('[data-testid="popup-stop-name"]');
    await expect(stopName).toBeVisible();
    await expect(stopName).not.toHaveText("");

    // At least one departure indicator ("Due" or "min") should be visible
    const hasDueOrMin = popup.getByText(/Due|\d+\s*min/);
    await expect(hasDueOrMin.first()).toBeVisible({ timeout: 5_000 });
  });

  test("popup sorts departures in ascending time order", async ({ page }) => {
    await openMap(page);

    await page.locator(".stop-marker-container .cursor-pointer").first().click();

    const popup = page.locator('[data-testid="stop-popup"]');
    await expect(popup).toBeVisible({ timeout: 10_000 });

    // Wait for at least one departure indicator to render (async fetch)
    const hasDueOrMin = popup.getByText(/Due|\d+\s*min/);
    await expect(hasDueOrMin.first()).toBeVisible({ timeout: 5_000 });

    const popupText = await popup.innerText();

    // Extract all minute values shown in the popup ("Due" counts as 0, "X min" as X)
    const timeTokens: number[] = [];
    for (const match of popupText.matchAll(/\bDue\b|(\d+)\s*min/g)) {
      if (match[0] === "Due") {
        timeTokens.push(0);
      } else if (match[1] !== undefined) {
        timeTokens.push(parseInt(match[1], 10));
      }
    }

    // There should be at least one time entry visible
    expect(timeTokens.length).toBeGreaterThan(0);

    // Route groups must appear in ascending order by their first (soonest) time
    for (let i = 1; i < timeTokens.length; i++) {
      expect(timeTokens[i]).toBeGreaterThanOrEqual(timeTokens[i - 1]);
    }
  });

  // Regression for PR #171 → #185: when the user pans the map far enough
  // that the marker's stop leaves the buffered viewport, `updateMarkers`'
  // winner-cleanup branch calls `marker.remove()` and detaches the outer
  // `.stop-marker-container` element. PR #171 attached the click listener
  // to that element directly, so a tap on the recreated marker after a
  // pan-back stopped opening the popup. The delegated listener on the
  // map's canvas container survives the detach/re-add cycle.
  //
  // The post-pan-back precondition uses `waitForFunction` polling on the
  // marker-container count rather than a fixed `waitFor({state:"attached"})`
  // timeout — a slow runner under vite-dev live smoke must not decide the
  // correctness assertion. Unit coverage for the underlying delegation
  // lives in `markerClickDelegation.test.tsx`.
  test("click still works on a marker recreated by pan-away + pan-back", async ({ page }) => {
    await openMap(page);

    // Pan to an empty region of the world — no fixture stops within
    // the buffered viewport — forcing the winner-cleanup branch to
    // detach every marker. MARKER_DEBOUNCE_MS = 150 ms in TransitMap;
    // 400 ms gives one full debounce-tick worth of slack.
    await page.evaluate(() => {
      (window as unknown as Record<string, { jumpTo: (opts: { center: number[]; zoom: number }) => void }>).__ptnMap.jumpTo({
        center: [0, 0],
        zoom: 17,
      });
    });
    await page.waitForFunction(
      () => document.querySelectorAll(".stop-marker-container").length === 0,
      { timeout: 5_000, polling: 100 },
    );

    // Pan back; markers re-enter the create-path with fresh `el`s.
    await page.evaluate(() => {
      (window as unknown as Record<string, { jumpTo: (opts: { center: number[]; zoom: number }) => void }>).__ptnMap.jumpTo({
        center: [25.2797, 54.6872],
        zoom: 17,
      });
    });
    await page.waitForFunction(
      () => document.querySelectorAll(".stop-marker-container").length > 0,
      { timeout: 30_000, polling: 100 },
    );

    // The recreated marker's click must still route through the
    // delegated listener. Pre-fix, this is where the regression bites:
    // the recreated `el` carries no listener of its own.
    await page.locator(".stop-marker-container .cursor-pointer").first().click();
    await expect(page.locator('[data-testid="stop-popup"]')).toBeVisible({
      timeout: 10_000,
    });
  });

  test('"See all" opens the departure sheet', async ({ page }) => {
    await openMap(page);

    await page.locator(".stop-marker-container .cursor-pointer").first().click();

    const popup = page.locator('[data-testid="stop-popup"]');
    await expect(popup).toBeVisible({ timeout: 10_000 });

    // Click the "See all" button in the popup
    await popup.getByRole("button", { name: /see all/i }).click();

    // Sheet should appear
    await expect(page.locator('[data-testid="departure-sheet"]')).toBeVisible({
      timeout: 10_000,
    });

    // Popup should be hidden after "See all"
    await expect(popup).not.toBeVisible();
  });
});
