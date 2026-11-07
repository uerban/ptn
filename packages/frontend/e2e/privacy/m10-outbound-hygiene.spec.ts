import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";
import { bootAtPrivacyLevel } from "../../tests/privacy-harness/bootAtLevel";
import { seedNetworkDecisions } from "../helpers/setup-complete";

const ADAPTER_MODULE = "/src/services/geocoder/ThirdPartyGeocoderAdapter.ts";

const NOMINATIM_RESPONSE = [
  {
    display_name: "Gdansk, Pomerania, Poland",
    lat: "54.3520",
    lon: "18.6466",
    importance: 0.8,
  },
];

test.describe("M10 T-4: Outbound hygiene @mock-api", () => {
  test("geocoder fetch sends no referer, no cookies, and is not cached", async ({
    page,
  }) => {
    await bootAtPrivacyLevel(page, "standard");
    await seedNetworkDecisions(page, { "external.place-search@nominatim": "allowed" });
    await mockApi(page);

    const intercepted: Array<{
      url: string;
      headers: Record<string, string>;
    }> = [];

    await page.route("https://nominatim.openstreetmap.org/**", (route) => {
      const req = route.request();
      intercepted.push({
        url: req.url(),
        headers: req.headers(),
      });
      route.fulfill({ json: NOMINATIM_RESPONSE });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.evaluate(async (modulePath) => {
      const mod = (await import(/* @vite-ignore */ modulePath)) as {
        ThirdPartyGeocoderAdapter: new (
          config: {
            provider: string;
            endpoint: string;
          },
          getPolicy: () => {
            m10CoarsenGridDefaultMeters: number;
          },
        ) => {
          forward: (
            q: string,
            hint: null,
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
          m10CoarsenGridDefaultMeters: 500,
        }),
      );
      await adapter.forward("Gdansk", null, new AbortController().signal);
    }, ADAPTER_MODULE);

    expect(intercepted).toHaveLength(1);
    expect(intercepted[0]!.headers).not.toHaveProperty("referer");
    expect(intercepted[0]!.headers).not.toHaveProperty("cookie");

    await page.evaluate(async (modulePath) => {
      const mod = (await import(/* @vite-ignore */ modulePath)) as {
        ThirdPartyGeocoderAdapter: new (
          config: {
            provider: string;
            endpoint: string;
          },
          getPolicy: () => {
            m10CoarsenGridDefaultMeters: number;
          },
        ) => {
          forward: (
            q: string,
            hint: null,
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
          m10CoarsenGridDefaultMeters: 500,
        }),
      );
      await adapter.forward("Gdansk", null, new AbortController().signal);
    }, ADAPTER_MODULE);

    expect(intercepted).toHaveLength(2);
  });
});
