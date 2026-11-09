import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

test.describe("Top row: city name left, controls right", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
  });

  test("city name sits on one line, left of the mode toggle and schedule button", async ({ page }) => {
    const cityName = page.locator('[data-testid="city-name"]');
    const modeToggle = page.locator('[data-testid="mode-toggle"]');
    const schedule = page.locator('[data-testid="show-schedule-btn"]');

    await expect(cityName).toBeVisible({ timeout: 10_000 });
    await expect(modeToggle).toBeVisible({ timeout: 10_000 });
    await expect(schedule).toBeVisible({ timeout: 10_000 });

    const cityBox = (await cityName.boundingBox())!;
    const toggleBox = (await modeToggle.boundingBox())!;
    const scheduleBox = (await schedule.boundingBox())!;

    expect(cityBox.x + cityBox.width).toBeLessThanOrEqual(toggleBox.x + 1);
    expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(scheduleBox.x + 1);
    // Same row: vertical centres within a few px.
    const centre = (b: { y: number; height: number }) => b.y + b.height / 2;
    expect(Math.abs(centre(cityBox) - centre(toggleBox))).toBeLessThanOrEqual(4);
    expect(Math.abs(centre(scheduleBox) - centre(toggleBox))).toBeLessThanOrEqual(4);
  });

  test("the bikes chip, when shown, sits left of the mode toggle", async ({ page }) => {
    const bikes = page.locator('[data-testid="bike-share-toggle"]');
    if ((await bikes.count()) === 0) test.skip();
    const toggleBox = (await page.locator('[data-testid="mode-toggle"]').boundingBox())!;
    const bikesBox = (await bikes.boundingBox())!;
    expect(bikesBox.x + bikesBox.width).toBeLessThanOrEqual(toggleBox.x + 1);
  });
});
