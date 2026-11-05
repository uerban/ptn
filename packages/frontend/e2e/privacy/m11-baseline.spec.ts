import { test, expect, type Page } from "@playwright/test";
import {
  tilesForViewport,
  type Bbox,
  type PoiEntry,
} from "@pt/shared";
import { mockApi } from "../helpers/mock-api";
import { bootAtPrivacyLevel } from "../../tests/privacy-harness/bootAtLevel";
import {
  assertNetworkPattern,
  installNetworkRecorder,
  type CapturedRequest,
} from "../../tests/privacy-harness/assertNetworkPattern";

// M11 T-14 — Baseline on-demand tiles.
//
// At `baseline`, `policy.m11TileDefense` is `"none"`: each viewport load must
// trigger tile fetches for **exactly** the covering tile keys — no prefetch
// of the full city, no random decoy padding, no background decoy timer. This
// spec drives `createTileLoader` directly from the browser (UI wiring is
// deferred to a later milestone) and asserts the request set byte-for-byte
// against `tilesForViewport`.

const CITY_ID = "vilnius";
const BBOX_A: Bbox = {
  minLat: 54.68,
  maxLat: 54.69,
  minLon: 25.27,
  maxLon: 25.28,
};
// Far enough from BBOX_A that "pan" produces at least some new tile keys.
// ~50km shift ensures most covering tiles are fresh (no cache overlap).
const BBOX_B: Bbox = {
  minLat: 55.0,
  maxLat: 55.01,
  minLon: 25.6,
  maxLon: 25.61,
};

const TILE_LOADER_MODULE = "/src/services/tileLoader.ts";
const TILE_PATH_PREFIX = "/api/gtfs/poi-tile/";

function tileKeyFromUrl(url: string): string {
  const idx = url.indexOf(TILE_PATH_PREFIX);
  if (idx === -1) return "";
  return url.slice(idx + TILE_PATH_PREFIX.length);
}

async function driveLoadViewport(page: Page, bbox: Bbox): Promise<void> {
  await page.evaluate(
    async ({ modulePath, cityId, bbox }) => {
      const w = window as unknown as {
        __m11Loader?: { loadViewport: (b: Bbox) => Promise<void> };
      };
      if (!w.__m11Loader) {
        const mod = (await import(/* @vite-ignore */ modulePath)) as {
          createTileLoader: (opts: {
            cityId: string;
            debounceMs?: number;
          }) => { loadViewport: (b: Bbox) => Promise<void>; dispose: () => void };
        };
        // Tight debounce so awaits are quick but the mechanism still runs.
        w.__m11Loader = mod.createTileLoader({ cityId, debounceMs: 20 });
      }
      await w.__m11Loader!.loadViewport(bbox);
    },
    { modulePath: TILE_LOADER_MODULE, cityId: CITY_ID, bbox },
  );
}

async function disposeLoader(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __m11Loader?: { dispose: () => void };
    };
    w.__m11Loader?.dispose();
    delete w.__m11Loader;
  });
}

test.describe("M11 T-14: Baseline on-demand tiles @mock-api", () => {
  test("tiles load only for current viewport — no prefetch, no padding", async ({
    page,
  }) => {
    // baseline → m11TileDefense: "none"
    await bootAtPrivacyLevel(page, "baseline");
    await mockApi(page);

    const fulfilledTiles: string[] = [];
    await page.route(`**${TILE_PATH_PREFIX}**`, (route) => {
      const url = route.request().url();
      const tileKey = tileKeyFromUrl(url);
      fulfilledTiles.push(tileKey);
      const payload: { tileKey: string; entries: PoiEntry[] } = {
        tileKey,
        entries: [],
      };
      route.fulfill({ json: payload });
    });

    const recorder = installNetworkRecorder(page);

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Ignore any traffic made during boot — this spec only cares about
    // tile-loader behavior after the app is idle.
    recorder.reset();
    fulfilledTiles.length = 0;

    // --- First viewport load ---
    await driveLoadViewport(page, BBOX_A);

    const expectedA = tilesForViewport(CITY_ID, BBOX_A);
    expect(expectedA.length).toBeGreaterThan(0);

    const tilesA = recorder.requests.filter(
      (r: CapturedRequest) => r.kind === "tile",
    );
    expect(tilesA.length).toBe(expectedA.length);
    const fetchedKeysA = new Set(tilesA.map((r) => tileKeyFromUrl(r.url)));
    for (const key of expectedA) {
      expect(fetchedKeysA.has(key)).toBe(true);
    }
    // Every fetched key must belong to the viewport tile set — any extra
    // key is a decoy/padding regression.
    for (const key of fetchedKeysA) {
      expect(expectedA).toContain(key);
    }

    // No stray requests to unknown surfaces at baseline.
    assertNetworkPattern(recorder, [
      { kind: "tile", minCount: expectedA.length, maxCount: expectedA.length },
      { kind: "reverse-geocode", maxCount: 0 },
      { kind: "forward-geocode", maxCount: 0 },
    ]);

    // --- Pan the viewport ---
    // Tiles overlapping BBOX_A should be cache hits. Only new keys need a
    // fetch, and no decoys should accompany them.
    recorder.reset();
    await driveLoadViewport(page, BBOX_B);

    const expectedB = tilesForViewport(CITY_ID, BBOX_B);
    const newKeysB = expectedB.filter((k) => !expectedA.includes(k));
    const tilesB = recorder.requests.filter(
      (r: CapturedRequest) => r.kind === "tile",
    );
    const fetchedKeysB = new Set(tilesB.map((r) => tileKeyFromUrl(r.url)));

    expect(tilesB.length).toBe(newKeysB.length);
    for (const key of newKeysB) {
      expect(fetchedKeysB.has(key)).toBe(true);
    }
    for (const key of fetchedKeysB) {
      expect(expectedB).toContain(key);
    }

    await disposeLoader(page);
    recorder.stop();
  });
});
