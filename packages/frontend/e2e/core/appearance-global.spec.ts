import { test, expect } from "@playwright/test";
import { seedCompletedSetup } from "../helpers/setup-complete";

test.describe("global appearance propagation", () => {
  test.beforeEach(async ({ page }) => {
    await seedCompletedSetup(page, { cityId: "vilnius" });
  });

  test("data-variant defaults to consumer on first paint", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-variant", "consumer");
  });

  test("switching appearance in Settings updates data-variant app-wide", async ({ page }) => {
    await page.goto("/settings");
    await page.locator('input[name="routeSearchVariant"][value="accessible"]').check();
    await expect(page.locator("html")).toHaveAttribute("data-variant", "accessible");

    // Navigate elsewhere; attribute survives through client-side routing + persistence.
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-variant", "accessible");
  });

  test("vision_impaired mobility auto-upgrades regardless of stored variant", async ({ page }) => {
    await page.goto("/settings");
    await page.locator('input[name="routeSearchVariant"][value="power"]').check();
    // Anchor on the stable testid added above — locale-agnostic.
    await page.locator('[data-testid="mobility-vision_impaired"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-variant", "accessible");
  });
});
