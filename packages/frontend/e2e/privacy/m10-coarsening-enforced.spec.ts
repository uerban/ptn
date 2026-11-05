import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";
import { bootAtPrivacyLevel } from "../../tests/privacy-harness/bootAtLevel";

const ADAPTER_MODULE = "/src/services/geocoder/ThirdPartyGeocoderAdapter.ts";
const EARTH_LAT_METERS_PER_DEG = 111_320;

const PRECISE_HINT = { lat: 54.352167891234, lon: 18.646289012345 };

const NOMINATIM_RESPONSE = [
  {
    display_name: "Gdansk, Pomerania, Poland",
    lat: "54.3520",
    lon: "18.6466",
    importance: 0.8,
  },
];

const PHOTON_RESPONSE = {
  features: [
    {
      geometry: { type: "Point", coordinates: [18.6466, 54.352] },
      properties: { name: "Gdansk", city: "Gdansk", country: "Poland" },
    },
  ],
};

function maxAllowedDecimalPlaces(gridMeters: number): number {
  const gridDeg = gridMeters / EARTH_LAT_METERS_PER_DEG;
  return -Math.floor(Math.log10(gridDeg)) + 1;
}

function assertUrlPrecision(url: string, gridMeters: number): void {
  const maxDec = maxAllowedDecimalPlaces(gridMeters);
  const floats = [...url.matchAll(/\d+\.\d+/g)].map((m) => m[0]);
  expect(floats.length).toBeGreaterThan(0);
  for (const f of floats) {
    const decimals = f.length - f.indexOf(".") - 1;
    expect(
      decimals,
      `"${f}" has ${decimals} decimals, max ${maxDec} for ${gridMeters}m grid`,
    ).toBeLessThanOrEqual(maxDec);
  }
}

test.describe("M10 T-15: Coarsening enforced end-to-end @mock-api", () => {
  const GRID_CASES = [
    { label: "500m default", gridMeters: 500 },
    { label: "200m floor", gridMeters: 200 },
    { label: "1000m hardened", gridMeters: 1000 },
  ] as const;

  for (const { label, gridMeters } of GRID_CASES) {
    test(`forward geocode coords coarsened at ${label}`, async ({ page }) => {
      await bootAtPrivacyLevel(page, "standard", {
        m10ThirdPartyEnabled: true,
        m10CoarsenGridDefaultMeters: gridMeters,
      });
      await mockApi(page);

      const intercepted: Array<{ url: string }> = [];
      await page.route("https://nominatim.openstreetmap.org/**", (route) => {
        intercepted.push({ url: route.request().url() });
        route.fulfill({ json: NOMINATIM_RESPONSE });
      });

      await page.goto("/");
      await page.waitForLoadState("networkidle");

      await page.evaluate(
        async ({ modulePath, hint, grid }) => {
          const mod = (await import(/* @vite-ignore */ modulePath)) as {
            ThirdPartyGeocoderAdapter: new (
              config: { provider: string; endpoint: string },
              getPolicy: () => {
                m10ThirdPartyEnabled: boolean;
                m10CoarsenGridDefaultMeters: number;
              },
            ) => {
              forward: (
                q: string,
                hint: { lat: number; lon: number } | null,
                signal: AbortSignal,
              ) => Promise<unknown>;
            };
          };
          const adapter = new mod.ThirdPartyGeocoderAdapter(
            {
              provider: "nominatim",
              endpoint: "https://nominatim.openstreetmap.org",
            },
            () => ({
              m10ThirdPartyEnabled: true,
              m10CoarsenGridDefaultMeters: grid,
            }),
          );
          await adapter.forward("Gdansk", hint, new AbortController().signal);
        },
        { modulePath: ADAPTER_MODULE, hint: PRECISE_HINT, grid: gridMeters },
      );

      expect(intercepted).toHaveLength(1);
      assertUrlPrecision(intercepted[0]!.url, gridMeters);
      expect(intercepted[0]!.url).not.toContain("352167");
      expect(intercepted[0]!.url).not.toContain("646289");
    });

    test(`reverse geocode coords coarsened at ${label}`, async ({ page }) => {
      await bootAtPrivacyLevel(page, "standard", {
        m10ThirdPartyEnabled: true,
        m10CoarsenGridDefaultMeters: gridMeters,
      });
      await mockApi(page);

      const intercepted: Array<{ url: string }> = [];
      await page.route("https://photon.komoot.io/**", (route) => {
        intercepted.push({ url: route.request().url() });
        route.fulfill({ json: PHOTON_RESPONSE });
      });

      await page.goto("/");
      await page.waitForLoadState("networkidle");

      await page.evaluate(
        async ({ modulePath, coord, grid }) => {
          const mod = (await import(/* @vite-ignore */ modulePath)) as {
            ThirdPartyGeocoderAdapter: new (
              config: { provider: string; endpoint: string },
              getPolicy: () => {
                m10ThirdPartyEnabled: boolean;
                m10CoarsenGridDefaultMeters: number;
              },
            ) => {
              reverse: (
                coord: { lat: number; lon: number },
                signal: AbortSignal,
              ) => Promise<unknown>;
            };
          };
          const adapter = new mod.ThirdPartyGeocoderAdapter(
            {
              provider: "photon",
              endpoint: "https://photon.komoot.io",
            },
            () => ({
              m10ThirdPartyEnabled: true,
              m10CoarsenGridDefaultMeters: grid,
            }),
          );
          await adapter.reverse(coord, new AbortController().signal);
        },
        { modulePath: ADAPTER_MODULE, coord: PRECISE_HINT, grid: gridMeters },
      );

      expect(intercepted).toHaveLength(1);
      assertUrlPrecision(intercepted[0]!.url, gridMeters);
      expect(intercepted[0]!.url).not.toContain("352167");
      expect(intercepted[0]!.url).not.toContain("646289");
    });
  }
});
