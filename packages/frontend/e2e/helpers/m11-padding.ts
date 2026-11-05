import { expect, type Page } from "@playwright/test";
import {
  LEVEL_FLOORS,
  tilesForViewport,
  type Bbox,
  type PoiEntry,
  type PrivacyLevel,
  type PrivacyPolicy,
} from "@pt/shared";
import { mockApi } from "./mock-api";
import { bootAtPrivacyLevel } from "../../tests/privacy-harness/bootAtLevel";
import {
  assertNetworkPattern,
  installNetworkRecorder,
  type CapturedRequest,
} from "../../tests/privacy-harness/assertNetworkPattern";

// Shared scenario for Hardened + Strict — both include per-call padding
// ("prefetch-padding" at Hardened, "prefetch-padding-decoy" at Strict; the
// decoy-on-timer axis is exercised in the Paranoid spec). The assertion is:
// every dynamic (post-prefetch, cache-miss) tile load MUST be accompanied by
// ≥ 2 decoy tile loads whose keys are outside the current viewport. Prefetch
// itself does NOT surface decoys — base covers the whole city on first load,
// so there are no outside-city candidates at that moment. The second phase
// simulates an LRU-eviction (realistic under the Hardened 25MB / Strict 10MB
// budgets) by clearing the orchestrator's mirror cache between calls, which
// brings the dispatcher back to "dynamic load" territory.

const CITY_ID = "vilnius";
const CITY_BBOX: Bbox = {
  minLat: 54.62,
  maxLat: 54.75,
  minLon: 25.15,
  maxLon: 25.42,
};
const VIEWPORT: Bbox = {
  minLat: 54.68,
  maxLat: 54.69,
  minLon: 25.27,
  maxLon: 25.28,
};

const TILE_PATH_PREFIX = "/api/gtfs/poi-tile/";
const TILE_DEFENSE_MODULE = "/src/services/tileDefense.ts";

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

type PaddingStrategy = "prefetch-padding" | "prefetch-padding-decoy";

async function installOrchestrator(
  page: Page,
  strategy: PaddingStrategy,
): Promise<void> {
  await page.evaluate(
    async ({ modulePath, strategy }) => {
      interface Plan {
        tileKeys: string[];
        decoyKeys: string[];
        markedPrefetched: boolean;
      }
      const w = window as unknown as {
        __m11Padding?: {
          loadViewport: (real: string[], city: string[]) => Promise<Plan>;
          clearCache: () => void;
        };
      };
      if (w.__m11Padding) return;
      const mod = (await import(/* @vite-ignore */ modulePath)) as {
        dispatchTileLoad: (
          real: readonly string[],
          policy: { m11TileDefense: PaddingStrategy },
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
      w.__m11Padding = {
        async loadViewport(real: string[], city: string[]): Promise<Plan> {
          const plan = mod.dispatchTileLoad(
            real,
            { m11TileDefense: strategy },
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
        clearCache(): void {
          cached.clear();
        },
      };
    },
    { modulePath: TILE_DEFENSE_MODULE, strategy },
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
        __m11Padding: {
          loadViewport: (r: string[], c: string[]) => Promise<DrivenPlan>;
        };
      };
      return await w.__m11Padding.loadViewport(real, city);
    },
    { real, city },
  );
}

async function clearOrchestratorCache(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __m11Padding: { clearCache: () => void };
    };
    w.__m11Padding.clearCache();
  });
}

function strategyForLevel(
  level: Extract<PrivacyLevel, "hardened" | "strict">,
): PaddingStrategy {
  const strategy: PrivacyPolicy["m11TileDefense"] =
    LEVEL_FLOORS[level].m11TileDefense;
  if (strategy !== "prefetch-padding" && strategy !== "prefetch-padding-decoy") {
    throw new Error(
      `runPaddingScenario: level "${level}" maps to "${strategy}", not a padding strategy. ` +
        `LEVEL_FLOORS may have drifted — update the helper.`,
    );
  }
  return strategy;
}

export async function runPaddingScenario(
  page: Page,
  level: Extract<PrivacyLevel, "hardened" | "strict">,
): Promise<void> {
  const strategy = strategyForLevel(level);
  await bootAtPrivacyLevel(page, level);
  await mockApi(page);

  await page.route(`**${TILE_PATH_PREFIX}**`, (route) => {
    const url = route.request().url();
    const tileKey = tileKeyFromUrl(url);
    const payload: { tileKey: string; entries: PoiEntry[] } = {
      tileKey,
      entries: [],
    };
    route.fulfill({ json: payload });
  });

  const recorder = installNetworkRecorder(page);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await installOrchestrator(page, strategy);
  // Drop any boot-time traffic — this spec only cares about defense-layer
  // behavior once the app is idle.
  recorder.reset();

  const cityTiles = tilesForViewport(CITY_ID, CITY_BBOX);
  const real = tilesForViewport(CITY_ID, VIEWPORT);

  // Precondition: viewport lives inside the city's tile space.
  expect(cityTiles.length).toBeGreaterThan(real.length);
  for (const key of real) expect(cityTiles).toContain(key);

  // --- Phase 1: initial prefetch ---
  // First load with prefetched=false triggers a full-city prefetch. Because
  // base covers every tile in cityTileKeys, there are no outside-base
  // candidates for decoys — padding is a no-op here. The M11 spec accepts
  // this: "silence is its own padding" while the prefetch is inflight.
  const phase1 = await driveLoad(page, real, cityTiles);
  const expectedPhase1 = Array.from(new Set([...cityTiles, ...real]));
  expect(phase1.tileKeys.length).toBe(expectedPhase1.length);
  expect(phase1.markedPrefetched).toBe(true);
  expect(phase1.decoyKeys).toEqual([]);

  const tilesPhase1 = recorder.requests.filter(
    (r: CapturedRequest) => r.kind === "tile",
  );
  expect(tilesPhase1.length).toBe(expectedPhase1.length);

  // --- Phase 2: dynamic load after cache eviction ---
  // Simulate LRU eviction (realistic under Hardened's 25MB / Strict's 10MB
  // budgets) by clearing the orchestrator's mirror cache. With prefetched
  // still set, the dispatcher must NOT prefetch again — it must treat this
  // as a dynamic load and pad with decoys.
  await clearOrchestratorCache(page);
  recorder.reset();

  const phase2 = await driveLoad(page, real, cityTiles);
  expect(phase2.markedPrefetched).toBe(false);
  expect(phase2.decoyKeys.length).toBeGreaterThanOrEqual(2);

  // Every decoy must live in the city tile space but OUTSIDE the current
  // viewport — that is the defining property of padding.
  for (const decoy of phase2.decoyKeys) {
    expect(cityTiles).toContain(decoy);
    expect(real).not.toContain(decoy);
  }

  // Every real viewport tile must show up in the load plan.
  for (const key of real) {
    expect(phase2.tileKeys).toContain(key);
  }
  // Plan = real ∪ decoys (dispatcher splits the two for accounting; the
  // tileKeys array is the union that actually hits the network).
  expect(phase2.tileKeys.length).toBe(real.length + phase2.decoyKeys.length);

  const tilesPhase2 = recorder.requests.filter(
    (r: CapturedRequest) => r.kind === "tile",
  );
  expect(tilesPhase2.length).toBe(phase2.tileKeys.length);
  const fetchedKeys = new Set(tilesPhase2.map((r) => tileKeyFromUrl(r.url)));
  for (const key of phase2.tileKeys) {
    expect(fetchedKeys.has(key)).toBe(true);
  }

  // The network recorder's tile bucket must match the plan byte-for-byte —
  // any extra request would indicate padding drift.
  assertNetworkPattern(recorder, [
    {
      kind: "tile",
      minCount: real.length + phase2.decoyKeys.length,
      maxCount: real.length + phase2.decoyKeys.length,
    },
  ]);

  recorder.stop();
}
