import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

/** Grant geolocation permission and provide a fake position */
async function grantGeolocation(context: import("@playwright/test").BrowserContext) {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 54.6872, longitude: 25.2797 });
}

test.describe("Map loading @mock-api", () => {
  test.beforeEach(async ({ page, context }) => {
    await grantGeolocation(context);
    await mockApi(page);
    await page.goto("/");
  });

  test("renders the MapLibre canvas", async ({ page }) => {
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("exposes map instance for testing", async ({ page }) => {
    // Wait for __ptnMap to be set (map initialises asynchronously)
    await page.waitForFunction(() => (window as any).__ptnMap !== undefined, {
      timeout: 15_000,
    });
    const hasMap = await page.evaluate(() => {
      return (window as any).__ptnMap !== undefined;
    });
    expect(hasMap).toBe(true);
  });

  test("loads stop features into GeoJSON source", async ({ page }) => {
    // Wait until the stops-source is present and has rendered features
    await page.waitForFunction(
      () => {
        const map = (window as any).__ptnMap;
        if (!map) return false;
        const source = map.getSource("stops-source");
        if (!source) return false;
        return map.querySourceFeatures("stops-source").length > 0;
      },
      { timeout: 20_000, polling: 300 }
    );

    const featureCount = await page.evaluate(() => {
      const map = (window as any).__ptnMap;
      return map ? map.querySourceFeatures("stops-source").length : 0;
    });
    expect(featureCount).toBeGreaterThan(0);
  });

  test("shows live position without a locate tap and follows location updates without moving the camera", async ({ page, context }) => {
    const dot = page.locator(".user-position-marker");
    await expect(dot).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(() => (window as any).__ptnMap?.loaded());
    const initial = await page.evaluate(() => {
      const map = (window as any).__ptnMap;
      return { center: map.getCenter().toArray(), zoom: map.getZoom() };
    });
    const transform = await dot.getAttribute("style");
    await context.setGeolocation({ latitude: 54.689, longitude: 25.281 });
    await expect.poll(() => dot.getAttribute("style")).not.toBe(transform);
    expect(await page.evaluate(() => {
      const map = (window as any).__ptnMap;
      return { center: map.getCenter().toArray(), zoom: map.getZoom() };
    })).toEqual(initial);
  });

  test("recenter immediately uses the shared watch instead of requesting another GPS fix", async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__positionRequests = 0;
      (window as any).__positionWatches = 0;
      const watch = navigator.geolocation.watchPosition.bind(navigator.geolocation);
      navigator.geolocation.watchPosition = (...args: Parameters<typeof watch>) => {
        (window as any).__positionWatches++;
        return watch(...args);
      };
      // Any accidental one-shot request would recreate the Android delay.
      navigator.geolocation.getCurrentPosition = (success) => {
        (window as any).__positionRequests++;
        setTimeout(() => success({
          coords: { latitude: 54.6872, longitude: 25.2797, accuracy: 10 },
          timestamp: Date.now(),
        } as GeolocationPosition), 7_000);
      };
    });
    await page.reload();
    await expect(page.locator(".user-position-marker")).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(() => (window as any).__ptnMap?.loaded());
    await page.evaluate(() => {
      (window as any).__locationCameraStarts = 0;
      (window as any).__ptnMap.on("movestart", (event: { geolocateSource?: boolean }) => {
        if (event.geolocateSource) (window as any).__locationCameraStarts++;
      });
    });
    const button = page.locator(".maplibregl-ctrl-geolocate");
    for (const expected of [1, 2]) {
      await button.click();
      await expect.poll(
        () => page.evaluate(() => (window as any).__locationCameraStarts),
        { timeout: 2_000 },
      ).toBe(expected);
      await page.waitForFunction(() => !(window as any).__ptnMap.isMoving());
      await page.evaluate(() => (window as any).__ptnMap.jumpTo({ center: [25.23, 54.64] }));
    }
    expect(await page.evaluate(() => (window as any).__positionRequests)).toBe(0);
    expect(await page.evaluate(() => (window as any).__positionWatches)).toBe(1);
  });

  test("GPS pause stops updates, mutes the dot, and Locate me resumes", async ({ page, context }) => {
    const dot = page.locator(".user-position-marker");
    await expect(dot).toBeVisible({ timeout: 15_000 });
    const toggle = page.getByTestId("gps-pause-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(dot).toHaveAttribute("data-paused", "true");
    const frozen = await dot.getAttribute("style");
    await context.setGeolocation({ latitude: 54.689, longitude: 25.281 });
    await page.waitForTimeout(1_000);
    expect(await dot.getAttribute("style")).toBe(frozen);
    await page.locator(".maplibregl-ctrl-geolocate").click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(dot).toHaveAttribute("data-paused", "false");
    await expect.poll(() => dot.getAttribute("style")).not.toBe(frozen);
  });

  test("waits for an explicit locate action when permission is not preapproved", async ({ page }) => {
    await page.addInitScript(() => {
      const query = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (descriptor) => descriptor.name === "geolocation"
        ? Promise.resolve(Object.assign(new EventTarget(), { state: "prompt", onchange: null }) as PermissionStatus)
        : query(descriptor);
      (window as any).__positionWatches = 0;
      const watch = navigator.geolocation.watchPosition.bind(navigator.geolocation);
      navigator.geolocation.watchPosition = (...args: Parameters<typeof watch>) => {
        (window as any).__positionWatches++;
        return watch(...args);
      };
    });
    await page.reload();
    await page.waitForFunction(() => (window as any).__ptnMap?.loaded());
    expect(await page.evaluate(() => (window as any).__positionWatches)).toBe(0);
    await expect(page.locator(".user-position-marker")).toHaveCount(0);
    await page.locator(".maplibregl-ctrl-geolocate").click();
    await expect(page.locator(".user-position-marker")).toBeVisible();
    expect(await page.evaluate(() => (window as any).__positionWatches)).toBe(1);
  });

  test("GPS settings stop tracking, persist, and distinguish temporary from complete off", async ({ page }) => {
    await expect(page.locator(".user-position-marker")).toBeVisible({ timeout: 15_000 });
    await page.goto("/settings");
    await page.locator('input[name="gpsMode"][value="until-locate"]').check();
    await page.goto("/");
    await expect(page.locator(".maplibregl-ctrl-geolocate")).toBeEnabled();
    await expect(page.locator(".user-position-marker")).toHaveCount(0);
    await page.locator(".maplibregl-ctrl-geolocate").click();
    await expect(page.locator(".user-position-marker")).toBeVisible();
    await page.goto("/settings");
    await expect(page.locator('input[name="gpsMode"][value="enabled"]')).toBeChecked();
    await page.locator('input[name="gpsMode"][value="disabled"]').check();
    await page.goto("/");
    await expect(page.locator(".maplibregl-ctrl-geolocate")).toBeDisabled();
    await expect(page.locator(".user-position-marker")).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".maplibregl-ctrl-geolocate")).toBeDisabled();
    await expect(page.locator(".user-position-marker")).toHaveCount(0);
  });
});
