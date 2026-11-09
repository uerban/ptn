import { test, expect } from "@playwright/test";
import { mockApiAtServiceTime } from "../helpers/mock-api";

/** Set up map at zoom 17, centered on the fixture cluster, and wait for markers. */
async function setupMap(page: Parameters<typeof mockApiAtServiceTime>[0]) {
  await mockApiAtServiceTime(page);
  await page.goto("/");

  // Wait for the map source to be POPULATED (not just registered). The source
  // is created with an empty FeatureCollection before stops arrive from the
  // preloader; gating on `getSource()` only would let `jumpTo` race the data.
  // Pattern lifted from stops-cache-poisoning.spec.ts.
  await page.waitForFunction(
    () => {
      const map = (window as any).__ptnMap;
      if (!map || !map.getSource("stops-source")) return false;
      return map.querySourceFeatures("stops-source").length > 0;
    },
    null,
    { timeout: 15_000, polling: 200 }
  );

  // Jump to zoom 17 so all 5 fixture stops render as station-card markers
  await page.evaluate(() => {
    const map = (window as any).__ptnMap;
    if (map) map.jumpTo({ center: [25.2797, 54.6872], zoom: 17 });
  });

  // Wait for at least one marker to appear (container has zero size so use 'attached')
  await page.locator(".stop-marker-container").first().waitFor({ state: "attached", timeout: 10_000 });
}

/** Click a stop marker card via direct DOM click to avoid search bar interception. */
async function clickStopCard(page: Parameters<typeof mockApiAtServiceTime>[0], nth: number) {
  await page.evaluate((index: number) => {
    const cards = document.querySelectorAll(".stop-marker-container .cursor-pointer");
    if (cards[index]) {
      (cards[index] as HTMLElement).click();
    }
  }, nth);
}

test.describe("Popup / sheet independence @mock-api", () => {
  test("'See all' opens sheet and closes popup", async ({ page }) => {
    await setupMap(page);

    // Click the first visible stop marker card
    await page.locator(".stop-marker-container .cursor-pointer").first().click();

    // Popup should appear
    await expect(page.locator("[data-testid='stop-popup']")).toBeVisible({ timeout: 5_000 });

    // Click "See all" to open the departure sheet
    await page.getByRole("button", { name: "See all" }).click();

    // Sheet should be visible, popup should be gone
    await expect(page.locator("[data-testid='departure-sheet']")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("[data-testid='stop-popup']")).not.toBeVisible();
  });

  test("clicking another stop while sheet is open shows popup and keeps sheet", async ({ page }) => {
    await setupMap(page);

    const cards = page.locator(".stop-marker-container .cursor-pointer");
    const markerCount = await cards.count();

    test.skip(markerCount < 2, "Need 2+ markers");

    // Open sheet for the first stop
    await cards.first().click();
    await expect(page.locator("[data-testid='stop-popup']")).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: "See all" }).click();
    await expect(page.locator("[data-testid='departure-sheet']")).toBeVisible({ timeout: 5_000 });

    // Capture sheet stop name
    const sheetStopName = await page.locator("[data-testid='sheet-stop-name']").textContent();

    // Click a different stop marker (use DOM click to avoid search bar overlay)
    await clickStopCard(page, 1);

    // New popup should appear
    await expect(page.locator("[data-testid='stop-popup']")).toBeVisible({ timeout: 5_000 });

    // Sheet should still be visible
    await expect(page.locator("[data-testid='departure-sheet']")).toBeVisible();

    // The popup stop name should differ from the sheet stop name
    const popupStopName = await page.locator("[data-testid='popup-stop-name']").textContent();
    expect(popupStopName).not.toBe(sheetStopName);
  });

  test("clicking same stop as sheet shows 'Expanded below'", async ({ page }) => {
    await setupMap(page);

    const firstCard = page.locator(".stop-marker-container .cursor-pointer").first();

    // Open sheet for the first stop
    await firstCard.click();
    await expect(page.locator("[data-testid='stop-popup']")).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: "See all" }).click();
    await expect(page.locator("[data-testid='departure-sheet']")).toBeVisible({ timeout: 5_000 });

    // Click the same marker again
    await firstCard.click();

    // Popup should appear again, showing "Expanded below" instead of "See all"
    await expect(page.locator("[data-testid='stop-popup']")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("[data-testid='stop-popup']")).toContainText("Expanded below");
    await expect(page.getByRole("button", { name: "See all" })).not.toBeVisible();
  });

  test("map click closes popup but keeps sheet", async ({ page }) => {
    await setupMap(page);

    const cards = page.locator(".stop-marker-container .cursor-pointer");
    const markerCount = await cards.count();
    test.skip(markerCount < 2, "Need 2+ markers");

    const firstCard = cards.first();

    // Open sheet for the first stop
    await firstCard.click();
    await expect(page.locator("[data-testid='stop-popup']")).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: "See all" }).click();
    await expect(page.locator("[data-testid='departure-sheet']")).toBeVisible({ timeout: 5_000 });

    // Click a different stop marker to get a popup while sheet is open
    await clickStopCard(page, 1);
    await expect(page.locator("[data-testid='stop-popup']")).toBeVisible({ timeout: 5_000 });

    // Click an empty area on the map canvas: the first point, scanning from
    // the top left, where nothing sits over the canvas.
    const spot = await page.evaluate(() => {
      const canvas = document.querySelector(".maplibregl-canvas");
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      for (let y = 100; y < rect.height; y += 20) {
        for (let x = 50; x < rect.width; x += 20) {
          if (document.elementFromPoint(rect.left + x, rect.top + y) === canvas) return { x, y };
        }
      }
      return null;
    });
    expect(spot).not.toBeNull();
    await page.locator(".maplibregl-canvas").click({ position: spot! });

    // Popup should be gone, sheet should remain
    await expect(page.locator("[data-testid='stop-popup']")).not.toBeVisible();
    await expect(page.locator("[data-testid='departure-sheet']")).toBeVisible();
  });
});
