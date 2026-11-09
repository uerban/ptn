import { expect, test, type Page } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

/**
 * Progressive map and the contextual choice behind **More map detail**:
 * the transit map and the local minimal map come without asking, the
 * provider is contacted only after **Use detailed maps**, and a decision
 * made in another tab is followed at once.
 */

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
            "carto-test": {
              type: "raster",
              tiles: ["https://basemaps.cartocdn.com/test/{z}/{x}/{y}.png"],
              tileSize: 256,
            },
          },
          layers: [{ id: "carto-test", type: "raster", source: "carto-test" }],
        },
      });
      return;
    }
    await route.fulfill({ contentType: "image/png", body: TRANSPARENT_PNG });
  });
  return requests;
}

async function openMap(page: Page) {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
}

test.describe("Detailed maps, asked once @mock-api", () => {
  test("asks before contacting the provider; Use detailed maps loads it", async ({ page }) => {
    const carto = await interceptCarto(page);
    await mockApi(page);
    await openMap(page);

    const disclosure = page.getByTestId("flow-disclosure");
    await expect(disclosure).toBeVisible();
    await expect(disclosure).toContainText("CARTO");
    await page.waitForTimeout(500);
    expect(carto).toEqual([]);
    await expect(page.getByTestId("more-map-detail")).toHaveCount(0);

    await disclosure.getByRole("button", { name: "Use detailed maps" }).click();
    await expect(disclosure).toBeHidden();
    await expect.poll(() => carto.filter((url) => url.endsWith(".png")).length).toBeGreaterThan(0);
  });

  test("Not now keeps the provider silent and is not asked again after a reload", async ({
    page,
  }) => {
    const carto = await interceptCarto(page);
    await mockApi(page);
    await openMap(page);

    await page.getByRole("button", { name: "Not now" }).click();
    await expect(page.getByTestId("flow-disclosure")).toBeHidden();

    await page.reload();
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByTestId("flow-disclosure")).toHaveCount(0);
    expect(carto).toEqual([]);
  });

  test("a revocation in another tab stops the detailed map here", async ({ page, context }) => {
    const carto = await interceptCarto(page);
    await mockApi(page);
    await openMap(page);
    await page.getByRole("button", { name: "Use detailed maps" }).click();
    await expect.poll(() => carto.length).toBeGreaterThan(0);

    const other = await context.newPage();
    await interceptCarto(other);
    await mockApi(other);
    await other.goto("/settings");
    await other.evaluate(() => {
      const key = "ptn-network-decisions";
      const stored = JSON.parse(localStorage.getItem(key) ?? "{}");
      stored.state.decisions["external.detailed-basemap@carto"] = {
        value: "denied",
        source: "settings",
        decidedAt: Date.now(),
      };
      localStorage.setItem(key, JSON.stringify(stored));
    });

    await expect(page.getByTestId("map-detail-control")).toHaveAttribute(
      "data-detailed-state",
      "off",
    );
    const before = carto.length;
    await page.evaluate(() => {
      (window as unknown as { __ptnMap: { jumpTo: (o: unknown) => void } }).__ptnMap.jumpTo({
        center: [25.3, 54.7],
        zoom: 14,
      });
    });
    await page.waitForTimeout(500);
    expect(carto.length).toBe(before);
  });

  test("a city without a minimal map shows transit routes only", async ({ page }) => {
    const carto = await interceptCarto(page);
    await mockApi(page);
    await page.route(/\.micromap\.br(\?|$)/, (route) => route.fulfill({ status: 404, body: "" }));
    await openMap(page);

    const status = page.getByTestId("map-status");
    await expect(status).toContainText("Transit routes only");
    await expect(page.getByTestId("map-detail-control")).toHaveAttribute(
      "data-micromap-state",
      "absent",
    );
    expect(carto).toEqual([]);
  });

  test("a failed minimal map can be retried", async ({ page }) => {
    await interceptCarto(page);
    await mockApi(page);
    let fail = true;
    await page.route(/\.micromap\.br(\?|$)/, async (route) => {
      if (fail) {
        await route.fulfill({ status: 500, body: "" });
        return;
      }
      await route.fallback();
    });
    await openMap(page);

    const status = page.getByTestId("map-status");
    await expect(status).toContainText("Transit routes only");
    fail = false;
    await status.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("map-detail-control")).toHaveAttribute(
      "data-micromap-state",
      "ready",
    );
    await expect(status).toBeHidden();
  });
});
