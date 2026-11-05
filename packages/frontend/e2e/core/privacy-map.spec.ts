import { expect, test, type Page } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

const CARTO_TILE_TEMPLATE =
  "https://basemaps.cartocdn.com/privacy-test/{z}/{x}/{y}.png";
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function interceptCarto(page: Page) {
  const requests: string[] = [];
  await page.route("https://basemaps.cartocdn.com/**", async (route) => {
    const url = route.request().url();
    requests.push(url);
    if (url.endsWith("/style.json")) {
      await route.fulfill({
        contentType: "application/json",
        json: {
          version: 8,
          sources: {
            "carto-privacy-test": {
              type: "raster",
              tiles: [CARTO_TILE_TEMPLATE],
              tileSize: 256,
            },
          },
          layers: [
            {
              id: "carto-privacy-test",
              type: "raster",
              source: "carto-privacy-test",
            },
          ],
        },
      });
      return;
    }
    await route.fulfill({ contentType: "image/png", body: TRANSPARENT_PNG });
  });
  return requests;
}

test.describe("Privacy: external basemap @mock-api", () => {
  test("local-only makes no CARTO style or tile requests", async ({ page }) => {
    const cartoRequests = await interceptCarto(page);
    await mockApi(page);
    await page.addInitScript(() => {
      localStorage.setItem(
        "ptn-privacy",
        JSON.stringify({
          state: {
            level: "standard",
            overrides: { basemapMode: "local-only" },
          },
          version: 0,
        }),
      );
    });

    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    await page.waitForTimeout(1_000);

    expect(cartoRequests).toEqual([]);
  });

  test("external detail requests the registered CARTO style and tiles", async ({
    page,
  }) => {
    const cartoRequests = await interceptCarto(page);
    await mockApi(page);

    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    await expect
      .poll(() => cartoRequests.filter((url) => url.endsWith(".png")).length)
      .toBeGreaterThan(0);

    expect(cartoRequests.some((url) => url.endsWith("/style.json"))).toBe(true);
    expect(
      cartoRequests.some((url) => /\/privacy-test\/\d+\/\d+\/\d+\.png$/.test(url)),
    ).toBe(true);
  });
});
