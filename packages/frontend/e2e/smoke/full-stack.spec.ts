import { test, expect } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL;

test.describe("Full stack smoke tests", () => {
  test.skip(!baseURL, "Smoke tests require E2E_BASE_URL to be set");

  test("health endpoint returns ok", async ({ request }) => {
    const response = await request.get(`${baseURL}/api/health/live`);
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.status).toBe("ok");
  });

  test("stops load on the map", async ({ page }) => {
    await page.goto("/");
    // Wait for GTFS data to load and stops to render
    await page.waitForFunction(
      () => (window as any).__ptnMap?.getSource("stops-source"),
      null,
      { timeout: 30_000 }
    );

    // Zoom to station card level
    await page.evaluate(() => {
      const map = (window as any).__ptnMap;
      if (map) map.jumpTo({ center: [25.2797, 54.6872], zoom: 17 });
    });

    // Station card markers should be visible
    const markers = page.locator(".stop-marker-container");
    await expect(markers.first()).toBeVisible({ timeout: 15_000 });
  });

  test("clicking a stop shows real departures", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(
      () => (window as any).__ptnMap?.getSource("stops-source"),
      null,
      { timeout: 30_000 }
    );

    await page.evaluate(() => {
      const map = (window as any).__ptnMap;
      if (map) map.jumpTo({ center: [25.2797, 54.6872], zoom: 17 });
    });

    const marker = page.locator(".stop-marker-container").first();
    await expect(marker).toBeVisible({ timeout: 15_000 });
    await marker.click();

    const popup = page.locator('[data-testid="stop-popup"]');
    await expect(popup).toBeVisible({ timeout: 5000 });

    const stopName = popup.locator('[data-testid="popup-stop-name"]');
    await expect(stopName).toHaveText(/.+/);
  });
});
