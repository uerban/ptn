import { test, expect, type Page } from "@playwright/test";
import { tilesForViewport, type Bbox, type PoiEntry } from "@pt/shared";
import { mockApi } from "../helpers/mock-api";
import { bootAtPrivacyLevel } from "../../tests/privacy-harness/bootAtLevel";
import {
  assertNetworkPattern,
  installNetworkRecorder,
  type CapturedRequest,
} from "../../tests/privacy-harness/assertNetworkPattern";

// M11 T-15 — Standard prefetch.
//
// At `standard`, `policy.m11TileDefense` is `"prefetch"`: the first tile-load
// per city-session fans out to fetch every city tile up-front so subsequent
// viewport changes never surface as network traffic a remote observer can
// correlate to user panning. Post-prefetch `loadViewport` calls within the
// same city+session MUST produce ZERO runtime tile requests (cache-only).
//
// The UI wiring for the defense dispatcher is deferred (notes); this spec orchestrates the
// production `dispatchTileLoad` directly against the real `/api/gtfs/poi-tile/...` URL shape to
// prove the policy branch composes end-to-end.

const CITY_ID = "vilnius";
// Mirrors the `bootAtPrivacyLevel` city seed so the prefetch set matches
// what the production app would have considered "this city's tile space".
const CITY_BBOX: Bbox = {
  minLat: 54.62,
  maxLat: 54.75,
  minLon: 25.15,
  maxLon: 25.42,
};
const VIEWPORT_A: Bbox = {
  minLat: 54.68,
  maxLat: 54.69,
  minLon: 25.27,
  maxLon: 25.28,
};
// Pan within the city interior — any fetches here indicate a cache miss,
// which would mean the prefetch on the initial load was incomplete.
const VIEWPORT_B: Bbox = {
  minLat: 54.7,
  maxLat: 54.71,
  minLon: 25.32,
  maxLon: 25.33,
};

const TILE_DEFENSE_MODULE = "/src/services/tileDefense.ts";
const TILE_PATH_PREFIX = "/api/gtfs/poi-tile/";

function tileKeyFromUrl(url: string): string {
  const idx = url.indexOf(TILE_PATH_PREFIX);
  if (idx === -1) return "";
  return url.slice(idx + TILE_PATH_PREFIX.length);
}

interface DrivenPlan {
  tileKeys: string[];
  decoyKeys: string[];
  markedPrefetched: boolean;
}

async function installOrchestrator(page: Page): Promise<void> {
  await page.evaluate(
    async ({ modulePath }) => {
      const w = window as unknown as {
        __m11Standard?: {
          loadViewport: (real: string[], city: string[]) => Promise<DrivenPlan>;
        };
      };
      if (w.__m11Standard) return;
      const mod = (await import(/* @vite-ignore */ modulePath)) as {
        dispatchTileLoad: (
          real: readonly string[],
          policy: { m11TileDefense: "prefetch" },
          ctx: {
            cityTileKeys: readonly string[];
            cachedKeys: ReadonlySet<string>;
            prefetched: boolean;
          },
        ) => {
          tileKeys: string[];
          decoyKeys: string[];
          markPrefetched: boolean;
          decoyTimerActive: boolean;
        };
      };
      const cached = new Set<string>();
      let prefetched = false;
      w.__m11Standard = {
        async loadViewport(real: string[], city: string[]): Promise<DrivenPlan> {
          const plan = mod.dispatchTileLoad(
            real,
            { m11TileDefense: "prefetch" as const },
            { cityTileKeys: city, cachedKeys: cached, prefetched },
          );
          await Promise.all(
            plan.tileKeys.map(async (key) => {
              const res = await fetch(`/api/gtfs/poi-tile/${key}`);
              if (res.ok) cached.add(key);
            }),
          );
          if (plan.markPrefetched) prefetched = true;
          return {
            tileKeys: plan.tileKeys,
            decoyKeys: plan.decoyKeys,
            markedPrefetched: plan.markPrefetched,
          };
        },
      };
    },
    { modulePath: TILE_DEFENSE_MODULE },
  );
}

async function driveLoad(
  page: Page,
  real: string[],
  city: string[],
): Promise<DrivenPlan> {
  return await page.evaluate(
    async ({ real, city }) => {
      const w = window as unknown as {
        __m11Standard: {
          loadViewport: (r: string[], c: string[]) => Promise<DrivenPlan>;
        };
      };
      return await w.__m11Standard.loadViewport(real, city);
    },
    { real, city },
  );
}

test.describe("M11 T-15: Standard prefetch @mock-api", () => {
  test("initial load prefetches city tiles; panning stays offline", async ({
    page,
  }) => {
    // standard → m11TileDefense: "prefetch"
    await bootAtPrivacyLevel(page, "standard");
    await mockApi(page);

    const fulfilled: string[] = [];
    await page.route(`**${TILE_PATH_PREFIX}**`, (route) => {
      const url = route.request().url();
      const tileKey = tileKeyFromUrl(url);
      fulfilled.push(tileKey);
      const payload: { tileKey: string; entries: PoiEntry[] } = {
        tileKey,
        entries: [],
      };
      route.fulfill({ json: payload });
    });

    const recorder = installNetworkRecorder(page);

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await installOrchestrator(page);

    // Drop any traffic from boot — this spec only cares about defense-layer
    // behavior once the app is idle.
    recorder.reset();
    fulfilled.length = 0;

    const cityTiles = tilesForViewport(CITY_ID, CITY_BBOX);
    const realA = tilesForViewport(CITY_ID, VIEWPORT_A);
    const realB = tilesForViewport(CITY_ID, VIEWPORT_B);

    // Precondition: the two inner viewports must be fully contained in the
    // city's tile space, otherwise the "panning stays offline" assertion
    // would be meaningless.
    expect(cityTiles.length).toBeGreaterThan(realA.length);
    for (const key of realA) expect(cityTiles).toContain(key);
    for (const key of realB) expect(cityTiles).toContain(key);

    // --- Initial city load: expect a full prefetch ---
    const firstPlan = await driveLoad(page, realA, cityTiles);

    // With prefetched=false, dispatcher returns union(cityTiles, realA).
    // Since realA ⊂ cityTiles, the union equals cityTiles.
    const expectedFirstCall = Array.from(new Set([...cityTiles, ...realA]));
    expect(firstPlan.tileKeys.length).toBe(expectedFirstCall.length);
    expect(firstPlan.decoyKeys).toEqual([]);
    expect(firstPlan.markedPrefetched).toBe(true);

    const tilesA = recorder.requests.filter(
      (r: CapturedRequest) => r.kind === "tile",
    );
    expect(tilesA.length).toBe(expectedFirstCall.length);
    const fetchedKeysA = new Set(tilesA.map((r) => tileKeyFromUrl(r.url)));
    for (const key of cityTiles) {
      expect(fetchedKeysA.has(key)).toBe(true);
    }
    // Every request must belong to the prefetched city set — any extra key
    // is a padding/decoy regression (wrong for Standard).
    for (const key of fetchedKeysA) {
      expect(expectedFirstCall).toContain(key);
    }

    assertNetworkPattern(recorder, [
      {
        kind: "tile",
        minCount: expectedFirstCall.length,
        maxCount: expectedFirstCall.length,
      },
      { kind: "reverse-geocode", maxCount: 0 },
      { kind: "forward-geocode", maxCount: 0 },
    ]);

    // --- Pan inside the city: expect zero runtime tile requests ---
    recorder.reset();
    fulfilled.length = 0;

    const secondPlan = await driveLoad(page, realB, cityTiles);
    expect(secondPlan.tileKeys).toEqual([]);
    expect(secondPlan.decoyKeys).toEqual([]);
    expect(secondPlan.markedPrefetched).toBe(false);

    const tilesB = recorder.requests.filter(
      (r: CapturedRequest) => r.kind === "tile",
    );
    expect(tilesB).toEqual([]);

    assertNetworkPattern(recorder, [{ kind: "tile", minCount: 0, maxCount: 0 }]);

    recorder.stop();
  });
});
