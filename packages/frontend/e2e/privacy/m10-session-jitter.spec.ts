import { test, expect, type Page } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";
import { bootAtPrivacyLevel } from "../../tests/privacy-harness/bootAtLevel";
import { decideAfterSetup } from "../helpers/setup-complete";

const ADAPTER_MODULE = "/src/services/geocoder/ThirdPartyGeocoderAdapter.ts";
const COORD_PRIVACY_MODULE = "/src/services/coordPrivacy.ts";

// Lat placed at a 500m grid-cell boundary (position ≈ 0.5) so jitter seeds 0.1 vs 0.9
// deterministically snap to adjacent cells. 54.3500 / (500/111320) ≈ 12100.49.
const HINT = { lat: 54.35, lon: 18.604 };
const GRID = 500;

const NOMINATIM_RESPONSE = [
  {
    display_name: "Gdansk, Pomerania, Poland",
    lat: "54.3520",
    lon: "18.6466",
    importance: 0.8,
  },
];

function extractFloats(url: string): string[] {
  return [...url.matchAll(/\d+\.\d+/g)].map((m) => m[0]);
}

async function triggerForward(page: Page): Promise<void> {
  await page.evaluate(
    async ({ modulePath, hint, grid }) => {
      const mod = (await import(/* @vite-ignore */ modulePath)) as {
        ThirdPartyGeocoderAdapter: new (
          config: { provider: string; endpoint: string },
          getPolicy: () => {
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
          m10CoarsenGridDefaultMeters: grid,
        }),
      );
      await adapter.forward("Gdansk", hint, new AbortController().signal);
    },
    { modulePath: ADAPTER_MODULE, hint: HINT, grid: GRID },
  );
}

async function triggerSeededForward(
  page: Page,
  seed: number,
): Promise<void> {
  await page.evaluate(
    async ({ adapterPath, cpPath, hint, grid, s }) => {
      Math.random = () => s;

      const cp = (await import(/* @vite-ignore */ cpPath)) as {
        _resetSessionJitter: () => void;
      };
      cp._resetSessionJitter();

      const mod = (await import(/* @vite-ignore */ adapterPath)) as {
        ThirdPartyGeocoderAdapter: new (
          config: { provider: string; endpoint: string },
          getPolicy: () => {
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
          m10CoarsenGridDefaultMeters: grid,
        }),
      );
      await adapter.forward("Gdansk", hint, new AbortController().signal);
    },
    {
      adapterPath: ADAPTER_MODULE,
      cpPath: COORD_PRIVACY_MODULE,
      hint: HINT,
      grid: GRID,
      s: seed,
    },
  );
}

test.describe("M10 T-16: Per-session jitter across sessions @mock-api", () => {
  test("same query twice in same session → identical outbound coords", async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await bootAtPrivacyLevel(page, "standard", {
      m10CoarsenGridDefaultMeters: GRID,
    });
    await mockApi(page);

    const urls: string[] = [];
    await page.route("https://nominatim.openstreetmap.org/**", (route) => {
      urls.push(route.request().url());
      route.fulfill({ json: NOMINATIM_RESPONSE });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await decideAfterSetup(page, { "external.place-search@nominatim": "allowed" });

    await triggerForward(page);
    await triggerForward(page);

    expect(urls).toHaveLength(2);
    expect(extractFloats(urls[0]!)).toEqual(extractFloats(urls[1]!));

    await ctx.close();
  });

  test("new session (context.close + browser.newContext) → different snapped coords", async ({
    browser,
  }) => {
    async function queryInSeededSession(seed: number): Promise<string> {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();

      await bootAtPrivacyLevel(page, "standard", {
        m10CoarsenGridDefaultMeters: GRID,
      });
      await mockApi(page);

      let capturedUrl = "";
      await page.route("https://nominatim.openstreetmap.org/**", (route) => {
        capturedUrl = route.request().url();
        route.fulfill({ json: NOMINATIM_RESPONSE });
      });

      await page.goto("/");
      await page.waitForLoadState("networkidle");
      await decideAfterSetup(page, { "external.place-search@nominatim": "allowed" });

      await triggerSeededForward(page, seed);

      await ctx.close();
      return capturedUrl;
    }

    const urlA = await queryInSeededSession(0.1);
    const urlB = await queryInSeededSession(0.9);

    expect(urlA).toBeTruthy();
    expect(urlB).toBeTruthy();

    const coordsA = extractFloats(urlA);
    const coordsB = extractFloats(urlB);
    expect(coordsA.join(",")).not.toEqual(coordsB.join(","));
  });
});
