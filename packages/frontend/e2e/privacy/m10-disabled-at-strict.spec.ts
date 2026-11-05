import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";
import { bootAtPrivacyLevel } from "../../tests/privacy-harness/bootAtLevel";
import {
  installNetworkRecorder,
  assertNetworkPattern,
} from "../../tests/privacy-harness/assertNetworkPattern";

const ADAPTER_MODULE = "/src/services/geocoder/ThirdPartyGeocoderAdapter.ts";

const NOMINATIM_RESPONSE = [
  {
    display_name: "Gdansk, Pomerania, Poland",
    lat: "54.3520",
    lon: "18.6466",
    importance: 0.8,
  },
];

const PROVIDER_ENDPOINTS = [
  "https://api.mapbox.com/**",
  "https://nominatim.openstreetmap.org/**",
  "https://photon.komoot.io/**",
];

test.describe("M10 T-14: Provider disabled at Strict/Paranoid @mock-api", () => {
  for (const level of ["strict", "paranoid"] as const) {
    test(`Settings third-party section is locked at ${level}`, async ({
      page,
    }) => {
      await bootAtPrivacyLevel(page, level);
      await mockApi(page);

      await page.goto("/settings");
      await page.waitForLoadState("networkidle");

      const lockedSection = page.locator(
        "text=Third-party geocoding is disabled",
      );
      await expect(lockedSection).toBeVisible({ timeout: 10_000 });

      const providerRadios = page.locator(
        'input[name="third-party-provider"]',
      );
      await expect(providerRadios).toHaveCount(0);
    });

    test(`ThirdPartyGeocoderAdapter.isAvailable() returns false at ${level}`, async ({
      page,
    }) => {
      await bootAtPrivacyLevel(page, level);
      await mockApi(page);

      await page.goto("/");
      await page.waitForLoadState("networkidle");

      const result = await page.evaluate(async (modulePath) => {
        const mod = (await import(/* @vite-ignore */ modulePath)) as {
          ThirdPartyGeocoderAdapter: new (
            config: { provider: string; endpoint: string },
            getPolicy: () => {
              m10ThirdPartyEnabled: boolean;
              m10CoarsenGridDefaultMeters: number;
            },
          ) => {
            isAvailable: () => boolean;
            unavailableReason: string | null;
          };
        };
        const adapter = new mod.ThirdPartyGeocoderAdapter(
          {
            provider: "nominatim",
            endpoint: "https://nominatim.openstreetmap.org",
          },
          () => ({
            m10ThirdPartyEnabled: false,
            m10CoarsenGridDefaultMeters: 500,
          }),
        );
        return {
          available: adapter.isAvailable(),
          reason: adapter.unavailableReason,
        };
      }, ADAPTER_MODULE);

      expect(result.available).toBe(false);
      expect(result.reason).toContain("disabled");
    });

    test(`no outbound requests to allowlisted providers at ${level}`, async ({
      page,
    }) => {
      await bootAtPrivacyLevel(page, level);
      await mockApi(page);

      for (const endpoint of PROVIDER_ENDPOINTS) {
        await page.route(endpoint, (route) => {
          route.fulfill({ json: NOMINATIM_RESPONSE });
        });
      }

      const recorder = installNetworkRecorder(page);

      await page.goto("/");
      await page.waitForLoadState("networkidle");

      await page.waitForTimeout(2000);

      assertNetworkPattern(recorder, [
        { kind: "forward-geocode", minCount: 0, maxCount: 0 },
      ]);

      const providerRequests = recorder.requests.filter(
        (r) =>
          r.url.includes("api.mapbox.com") ||
          r.url.includes("nominatim.openstreetmap.org") ||
          r.url.includes("photon.komoot.io"),
      );
      expect(providerRequests).toHaveLength(0);

      recorder.stop();
    });
  }
});
