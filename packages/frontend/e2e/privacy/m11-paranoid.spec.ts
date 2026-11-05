import { test, expect, type Page } from "@playwright/test";
import {
  LEVEL_FLOORS,
  tilesForViewport,
  type Bbox,
  type PoiEntry,
} from "@pt/shared";
import { mockApi } from "../helpers/mock-api";
import { bootAtPrivacyLevel } from "../../tests/privacy-harness/bootAtLevel";
import {
  installNetworkRecorder,
  type CapturedRequest,
} from "../../tests/privacy-harness/assertNetworkPattern";

// M11 T-17 — Paranoid decoy-on-timer.
//
// At `paranoid`, `policy.m11TileDefense` is `"prefetch-padding-decoy"`, adding
// a background decoy loop on top of Strict's per-call padding. The loop MUST
// fire tile fetches on its own jittered interval even while the user is idle,
// and MUST pause while `document.visibilityState === "hidden"` so a
// suspended/backgrounded tab is not leaking ambient traffic.
//
// The UI wiring for the defense dispatcher is deferred (notes); this spec drives the production
// `startDecoyTimer` directly in the page via `page.evaluate` and wires its `onFire` callback to a
// real `fetch('/api/gtfs/poi-tile/{key}')`, so the network recorder observes the same requests
// production would emit. Interval bounds are shrunk from the production 2–5min to ~100–200ms so the
// idle-behaviour assertion completes in seconds instead of minutes. Visibility is driven through an
// injectable `VisibilityTarget` rather than the real `document` — Playwright has no first-class
// control over `document.visibilityState` in the page under test, and the injectable hook is the
// seam the runtime was designed around.

const CITY_ID = "vilnius";
// Mirrors the bbox seeded by `bootAtPrivacyLevel` so the decoy pool matches
// what production would have considered "this city's tile space".
const CITY_BBOX: Bbox = {
  minLat: 54.62,
  maxLat: 54.75,
  minLon: 25.15,
  maxLon: 25.42,
};

const TILE_PATH_PREFIX = "/api/gtfs/poi-tile/";
const TILE_DEFENSE_MODULE = "/src/services/tileDefense.ts";

// Test-only interval bounds. Production uses 2–5 min; real-timer runs cannot
// wait that long, so we compress the loop. The floor stays > 0 so the "below
// floor → no fire" property still holds; the ceiling stays narrow so a few
// wall-clock seconds reliably produce multiple fires.
const TEST_INTERVAL_MIN_MS = 100;
const TEST_INTERVAL_MAX_MS = 200;

// Wall-clock window per idle phase. At 100–200ms interval we expect ~10–20
// fires in 2s, which gives the assertion plenty of headroom over the
// `>= MIN_FIRES_PER_WINDOW` floor without making the test flaky under load.
const IDLE_WINDOW_MS = 2000;
const MIN_FIRES_PER_WINDOW = 3;

function tileKeyFromUrl(url: string): string {
  const idx = url.indexOf(TILE_PATH_PREFIX);
  if (idx === -1) return "";
  return url.slice(idx + TILE_PATH_PREFIX.length);
}

interface InstallOptions {
  cityTileKeys: string[];
  intervalMinMs: number;
  intervalMaxMs: number;
}

async function installDecoyTimer(
  page: Page,
  opts: InstallOptions,
): Promise<void> {
  await page.evaluate(
    async ({ modulePath, cityTileKeys, intervalMinMs, intervalMaxMs }) => {
      interface FakeDoc {
        visibilityState: "visible" | "hidden";
        listeners: Array<() => void>;
        addEventListener(type: "visibilitychange", listener: () => void): void;
        removeEventListener(
          type: "visibilitychange",
          listener: () => void,
        ): void;
        dispatch(): void;
      }
      interface Handle {
        doc: FakeDoc;
        stop(): void;
      }
      const w = window as unknown as { __m11Paranoid?: Handle };
      if (w.__m11Paranoid) return;

      const mod = (await import(/* @vite-ignore */ modulePath)) as {
        startDecoyTimer: (opts: {
          cityTileKeys: readonly string[];
          onFire: (tileKey: string) => void | Promise<void>;
          intervalMinMs?: number;
          intervalMaxMs?: number;
          visibilityTarget?: {
            visibilityState: DocumentVisibilityState;
            addEventListener(
              type: "visibilitychange",
              listener: () => void,
            ): void;
            removeEventListener(
              type: "visibilitychange",
              listener: () => void,
            ): void;
          };
        }) => { stop(): void };
      };

      const doc: FakeDoc = {
        visibilityState: "visible",
        listeners: [],
        addEventListener(_type, listener) {
          this.listeners.push(listener);
        },
        removeEventListener(_type, listener) {
          this.listeners = this.listeners.filter((l) => l !== listener);
        },
        dispatch() {
          for (const l of this.listeners.slice()) l();
        },
      };

      const ctrl = mod.startDecoyTimer({
        cityTileKeys,
        intervalMinMs,
        intervalMaxMs,
        visibilityTarget: doc,
        onFire: async (tileKey: string) => {
          // Route through the real URL shape so the network recorder
          // classifies the request as `tile` and the page.route handler
          // fulfills it — mirrors what production would emit.
          await fetch(`/api/gtfs/poi-tile/${tileKey}`);
        },
      });

      w.__m11Paranoid = {
        doc,
        stop: () => ctrl.stop(),
      };
    },
    {
      modulePath: TILE_DEFENSE_MODULE,
      cityTileKeys: opts.cityTileKeys,
      intervalMinMs: opts.intervalMinMs,
      intervalMaxMs: opts.intervalMaxMs,
    },
  );
}

async function setVisibility(
  page: Page,
  state: "visible" | "hidden",
): Promise<void> {
  await page.evaluate((state) => {
    const w = window as unknown as {
      __m11Paranoid: {
        doc: {
          visibilityState: "visible" | "hidden";
          dispatch: () => void;
        };
      };
    };
    w.__m11Paranoid.doc.visibilityState = state;
    w.__m11Paranoid.doc.dispatch();
  }, state);
}

async function teardownDecoyTimer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __m11Paranoid?: { stop: () => void };
    };
    w.__m11Paranoid?.stop();
    delete (window as unknown as { __m11Paranoid?: unknown }).__m11Paranoid;
  });
}

test.describe("M11 T-17: Paranoid decoy timer @mock-api", () => {
  test("fires decoys during idle sessions and pauses while tab is hidden", async ({
    page,
  }) => {
    // Precondition: Paranoid's canonical strategy is the decoy-on-timer one.
    // A drift here would silently disable the loop; fail loud instead.
    expect(LEVEL_FLOORS.paranoid.m11TileDefense).toBe(
      "prefetch-padding-decoy",
    );

    await bootAtPrivacyLevel(page, "paranoid");
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

    const cityTiles = tilesForViewport(CITY_ID, CITY_BBOX);
    expect(cityTiles.length).toBeGreaterThan(0);

    // Drop boot traffic — this spec only cares about decoy-timer behaviour.
    recorder.reset();

    await installDecoyTimer(page, {
      cityTileKeys: cityTiles,
      intervalMinMs: TEST_INTERVAL_MIN_MS,
      intervalMaxMs: TEST_INTERVAL_MAX_MS,
    });

    // --- Phase 1: idle visible tab must keep firing decoys ---
    // No user action — no viewport load, no panning, nothing. The only
    // traffic that can land in the `tile` bucket during this window is
    // decoy-timer output.
    await page.waitForTimeout(IDLE_WINDOW_MS);

    const phase1 = recorder.requests.filter(
      (r: CapturedRequest) => r.kind === "tile",
    );
    expect(phase1.length).toBeGreaterThanOrEqual(MIN_FIRES_PER_WINDOW);
    // Every fired key must live inside the city tile space. Anything else
    // is either a routing bug or a leak of some unrelated endpoint into
    // the tile bucket.
    for (const req of phase1) {
      const key = tileKeyFromUrl(req.url);
      expect(cityTiles).toContain(key);
    }

    // --- Phase 2: hidden tab must halt the loop ---
    // Fire a visibilitychange → "hidden" event. The timer must clear its
    // pending setTimeout and stop scheduling new ones until visibility
    // returns. Assertion: zero tile requests in the next idle window.
    recorder.reset();
    await setVisibility(page, "hidden");
    await page.waitForTimeout(IDLE_WINDOW_MS);

    const phase2 = recorder.requests.filter(
      (r: CapturedRequest) => r.kind === "tile",
    );
    expect(phase2).toEqual([]);

    // --- Phase 3: visible again must resume the loop ---
    // Regression guard for a teardown-instead-of-pause bug: the timer has
    // to come back to life on visibilitychange → "visible", not stay
    // permanently dead after one hide.
    recorder.reset();
    await setVisibility(page, "visible");
    await page.waitForTimeout(IDLE_WINDOW_MS);

    const phase3 = recorder.requests.filter(
      (r: CapturedRequest) => r.kind === "tile",
    );
    expect(phase3.length).toBeGreaterThanOrEqual(MIN_FIRES_PER_WINDOW);

    await teardownDecoyTimer(page);
    recorder.stop();
  });
});
