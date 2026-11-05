import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

test.describe("City name / urban-mode pill stacking", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
  });

  test("city name appears above or at the same level as mode toggle", async ({ page }) => {
    const cityName = page.locator('[data-testid="city-name"]');
    const modeToggle = page.locator('[data-testid="mode-toggle"]');

    await expect(cityName).toBeVisible({ timeout: 10_000 });
    await expect(modeToggle).toBeVisible({ timeout: 10_000 });

    const cityBox = await cityName.boundingBox();
    const toggleBox = await modeToggle.boundingBox();

    expect(cityBox).not.toBeNull();
    expect(toggleBox).not.toBeNull();

    // City name should be above or at the same vertical position as the pill.
    // Allow a small tolerance (2px) for sub-pixel alignment differences on
    // desktop flex-row layout where items share a baseline.
    expect(cityBox!.y).toBeLessThanOrEqual(toggleBox!.y + 2);
  });
});
