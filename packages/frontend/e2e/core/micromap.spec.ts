import { expect, test, type Page } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

/**
 * Offline micromap end-to-end.
 *
 * Two things worth proving in a real browser that unit tests cannot: the
 * artifact actually decodes and reaches MapLibre as layers, and the mode is
 * genuinely offline — zero requests to the external basemap provider.
 */

const MICROMAP_LAYERS = [
  "micromap-areas-fill",
  "micromap-waterways-line",
  "micromap-roads-line",
  "micromap-places-label",
];

/** Swallow every CARTO call and record it, so "no external basemap" is checked
 *  rather than assumed (mirrors privacy-map.spec.ts). */
async function interceptCarto(page: Page) {
  const requests: string[] = [];
  await page.route("https://basemaps.cartocdn.com/**", async (route) => {
    requests.push(route.request().url());
    if (route.request().url().endsWith("/style.json")) {
      await route.fulfill({
        contentType: "application/json",
        json: { version: 8, sources: {}, layers: [] },
      });
      return;
    }
    await route.fulfill({ contentType: "image/png", body: Buffer.alloc(0) });
  });
  return requests;
}

async function seedStores(
  page: Page,
  mapDetailMode: "detailed" | "micromap" | "gtfs-only",
) {
  await page.addInitScript(
    ({ mode }) => {
      localStorage.setItem(
        "ptn-city",
        JSON.stringify({
          state: {
            activeCity: {
              id: "vilnius",
              name: "Vilnius",
              center: { lat: 54.6872, lon: 25.2797 },
              bbox: { minLat: 54.62, minLon: 25.15, maxLat: 54.75, maxLon: 25.42 },
              available: true,
            },
          },
          version: 0,
        }),
      );
      localStorage.setItem(
        "ptn-settings",
        JSON.stringify({ state: { scheduleMode: false, mapDetailMode: mode }, version: 0 }),
      );
    },
    { mode: mapDetailMode },
  );
}

/** Layer ids currently installed in MapLibre. */
async function styleLayerIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const map = (window as unknown as { __ptnMap?: { getStyle: () => { layers?: { id: string }[] } } })
      .__ptnMap;
    return (map?.getStyle().layers ?? []).map((layer) => layer.id);
  });
}

test.describe("Offline micromap @mock-api", () => {
  test("draws the artifact and makes no external basemap request", async ({
    page,
  }) => {
    const cartoRequests = await interceptCarto(page);
    await mockApi(page);
    await seedStores(page, "micromap");

    const artifactResponses: number[] = [];
    page.on("response", (response) => {
      if (response.url().includes("/micromap/vilnius.micromap.br")) {
        artifactResponses.push(response.status());
      }
    });

    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();

    await expect
      .poll(async () => (await styleLayerIds(page)).filter((id) => id.startsWith("micromap-")).length)
      .toBeGreaterThan(0);

    const layerIds = await styleLayerIds(page);
    for (const layer of MICROMAP_LAYERS) {
      expect(layerIds, `expected ${layer} on the map`).toContain(layer);
    }

    // Below the transit layers — the micromap must never cover stops.
    const stopsIdx = layerIds.findIndex((id) => id.startsWith("stops-"));
    if (stopsIdx >= 0) {
      for (const layer of MICROMAP_LAYERS) {
        expect(layerIds.indexOf(layer)).toBeLessThan(stopsIdx);
      }
    }

    expect(artifactResponses).toEqual([200]);
    expect(cartoRequests).toEqual([]);
  });

  test("detailed mode loads the external basemap and no micromap", async ({
    page,
  }) => {
    const cartoRequests = await interceptCarto(page);
    await mockApi(page);
    await seedStores(page, "detailed");

    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    await expect
      .poll(() => cartoRequests.filter((url) => url.endsWith("/style.json")).length)
      .toBeGreaterThan(0);

    expect((await styleLayerIds(page)).filter((id) => id.startsWith("micromap-"))).toEqual([]);
  });

  test("one Settings control switches the map without rewriting the provider decision", async ({
    page,
  }) => {
    await mockApi(page);
    await seedStores(page, "detailed");

    await page.goto("/settings");
    const group = page.getByRole("radiogroup", { name: "Map" });
    await expect(group).toBeVisible();
    await expect(group.getByRole("radio")).toHaveCount(3);

    await group.getByRole("radio").nth(1).check();

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const settings = JSON.parse(localStorage.getItem("ptn-settings") ?? "{}");
          const privacy = JSON.parse(localStorage.getItem("ptn-privacy") ?? "{}");
          const network = JSON.parse(localStorage.getItem("ptn-network-decisions") ?? "{}");
          return {
            mode: settings?.state?.mapDetailMode,
            axis: privacy?.state?.overrides?.basemapMode,
            basemap: network?.state?.decisions?.["external.detailed-basemap@carto"]?.value,
          };
        }),
      )
      .toEqual({ mode: "micromap", axis: undefined, basemap: "allowed" });

    // The privacy centre keeps the axis copy but must not offer a second
    // control for the same decision.
    await expect(
      page.locator('input[name="policy-axis-basemapMode"]'),
    ).toHaveCount(0);
  });
});
