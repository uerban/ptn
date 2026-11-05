import { test, expect, type Page } from "@playwright/test";
import { mockApiAtServiceTime } from "../helpers/mock-api";

/** Navigate to map, zoom into fixture center, click a marker and open the departure sheet. */
async function openSheet(page: Page) {
  // This suite asserts on `fixtures/departures.json` content (the "Centras"
  // line group, the LIVE badge, the cancelled strikethrough, predicted-vs-
  // scheduled times), which only the LEGACY /api/departures path produces.
  //
  // It was already testing the legacy path before the schedule-tile mocks
  // existed — the tile requests fell through, the read path failed, and the
  // cascade dropped to legacy on every run. That was invisible. Now the tile
  // path works by default, so this suite states its dependency explicitly
  // rather than relying on the tile path being broken.
  //
  // FOLLOW-UP: the RT-dependent assertions here (LIVE / cancelled / predicted)
  // are therefore covered ONLY on the legacy path. Covering them on the tile
  // path needs rt-tile fixture trips carrying delaySeconds/cancelled — see
  // e2e/helpers/schedule-tile-fixture.ts `buildFixtureRtTile`, which currently
  // returns an empty overlay.
  await mockApiAtServiceTime(page, { scheduleTile: "unavailable" });
  await page.goto("/");

  // Wait for __ptnMap to be available
  await page.waitForFunction(() => (window as any).__ptnMap !== undefined, {
    timeout: 15_000,
  });

  // Wait for stops-source to be POPULATED (not just registered). The source
  // is created with an empty FeatureCollection before stops arrive from the
  // preloader; gating on `getSource() !== undefined` lets `jumpTo` race the
  // data, leaving no `.stop-marker-container` to wait for. Pattern lifted
  // from stops-cache-poisoning.spec.ts.
  await page.waitForFunction(
    () => {
      const map = (window as any).__ptnMap;
      if (!map || !map.getSource("stops-source")) return false;
      return map.querySourceFeatures("stops-source").length > 0;
    },
    { timeout: 15_000, polling: 200 }
  );

  // Jump to fixture center at zoom 17 so station card markers appear
  await page.evaluate(() => {
    (window as any).__ptnMap.jumpTo({
      center: [25.2797, 54.6872],
      zoom: 17,
    });
  });

  // Wait for at least one stop marker to appear (container has zero size so use 'attached')
  await page.locator(".stop-marker-container").first().waitFor({ state: "attached", timeout: 10_000 });

  // Click the visible card inside the marker container
  await page.locator(".stop-marker-container .cursor-pointer").first().click();

  const popup = page.locator('[data-testid="stop-popup"]');
  await expect(popup).toBeVisible({ timeout: 10_000 });

  // Click "See all" to open the departure sheet
  await popup.getByRole("button", { name: /see all/i }).click();

  // Wait for the sheet to appear
  await expect(page.locator('[data-testid="departure-sheet"]')).toBeVisible({
    timeout: 10_000,
  });
}

test.describe("Departure sheet @mock-api", () => {
  test("shows stop name in header", async ({ page }) => {
    await openSheet(page);

    const sheet = page.locator('[data-testid="departure-sheet"]');
    const stopName = sheet.locator('[data-testid="sheet-stop-name"]');

    await expect(stopName).toBeVisible();
    await expect(stopName).not.toHaveText("");
  });

  test("shows LIVE badge when real-time data is present", async ({ page }) => {
    await openSheet(page);

    const sheet = page.locator('[data-testid="departure-sheet"]');

    // Fixture t1 has predictedTime, so a LIVE badge should appear
    await expect(sheet.getByText("LIVE")).toBeVisible({ timeout: 5_000 });
  });

  test("shows cancelled departures with strikethrough", async ({ page }) => {
    await openSheet(page);

    const sheet = page.locator('[data-testid="departure-sheet"]');

    // Fixture t4 is cancelled — its row should have a line-through element
    await expect(sheet.locator(".line-through").first()).toBeVisible({
      timeout: 5_000,
    });
  });

  test("close button dismisses the sheet", async ({ page }) => {
    await openSheet(page);

    const sheet = page.locator('[data-testid="departure-sheet"]');
    await expect(sheet).toBeVisible();

    // Click the close button
    await sheet.getByRole("button", { name: /close/i }).click();

    await expect(sheet).not.toBeVisible({ timeout: 5_000 });
  });

  test("expanded row shows scheduled time with minute countdown", async ({ page }) => {
    await openSheet(page);

    const sheet = page.locator('[data-testid="departure-sheet"]');

    // Expand the first line group by clicking its toggle button (identified by data-testid)
    const firstGroup = sheet.locator('[data-testid="line-group-toggle"]', { hasText: /Fabijoniškės|Centras|Pilaitė/i }).first();
    await firstGroup.click();

    // Verify schedule rows appear with data-testid
    const scheduleRows = sheet.locator('[data-testid="schedule-row"]');
    await expect(scheduleRows.first()).toBeVisible({ timeout: 5_000 });

    // Verify scheduled-time shows clock format (HH:MM)
    const scheduledTime = sheet.locator('[data-testid="scheduled-time"]').first();
    await expect(scheduledTime).toBeVisible();
    const timeText = await scheduledTime.textContent();
    expect(timeText).toMatch(/\d{1,2}:\d{2}/);

    // Verify countdown shows minutes format (not absolute time)
    const row = scheduleRows.first();
    const rowText = await row.textContent();
    expect(rowText).toMatch(/\d+\s*min|Due/);
  });

  test("expanded row shows predicted time when real-time data differs", async ({ page }) => {
    await openSheet(page);

    const sheet = page.locator('[data-testid="departure-sheet"]');

    // Fixture route "2" (t3) has predictedTime different from scheduledTime with 180s delay
    // Find and expand the line group for route "2"
    const route2Button = sheet.locator('[data-testid="line-group-toggle"]', { hasText: /Centras/i }).first();
    await route2Button.click();

    // Wait for schedule rows to appear
    const scheduleRows = sheet.locator('[data-testid="schedule-row"]');
    await expect(scheduleRows.first()).toBeVisible({ timeout: 5_000 });

    // Fixture t3 has delaySeconds=180 and different predicted/scheduled times
    // so predicted-time should be visible on that row
    const predictedTime = sheet.locator('[data-testid="predicted-time"]');
    await expect(predictedTime.first()).toBeVisible({ timeout: 5_000 });

    // Verify it shows clock format
    const predText = await predictedTime.first().textContent();
    expect(predText).toMatch(/\d{1,2}:\d{2}/);
  });
});
