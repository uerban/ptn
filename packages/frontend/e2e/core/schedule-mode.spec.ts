import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

test.describe("Schedule-only mode", () => {
  test("shows nearby stops list when schedule mode enabled", async ({ page }) => {
    await mockApi(page);

    // Enable schedule mode via localStorage before navigation
    await page.addInitScript(() => {
      const settings = JSON.parse(localStorage.getItem("ptn-settings") || "{}");
      settings.state = { ...settings.state, scheduleMode: true };
      localStorage.setItem("ptn-settings", JSON.stringify(settings));
    });

    await page.goto("/");

    // Should show schedule view, not map
    await expect(page.locator("section[aria-label='Text mode']")).toBeVisible({ timeout: 10_000 });

    // Should have Plan trip button
    await expect(
      page.getByRole("link", { name: /plan trip/i }).or(page.getByRole("button", { name: /plan trip/i }))
    ).toBeVisible();

    // Should NOT have map canvas
    await expect(page.locator("canvas.maplibregl-canvas")).not.toBeVisible();
  });
});
