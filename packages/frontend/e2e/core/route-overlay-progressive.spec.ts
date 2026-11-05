import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";
import { REF_URL, REF_FIXED_TIME } from "./route-overlay-refUrl.ts";

/**
 * no-flicker guarantee.

 *
 * The single-transaction gtfsSync means there is no observable intermediate
 * tier in the client — the Dexie transaction only commits once shapes have
 * landed (see `packages/frontend/src/services/gtfsSync.ts`). Asserting
 * observable tier upgrades is therefore obsolete. What the architecture
 * actually promises is a no-flicker guarantee: once a route is activated,
 *
 *   1. `removeSource` is never called on `guidance-leg-*` during the sync —
 *      the persistent source/layer invariant is the point of the refactor
 *      in `rafScheduler.ts`.
 *   2. The leg's `source` property is monotonic-forward in the order
 *      `endpoints (0) ≤ intermediate (1) ≤ shape (2)` — once a higher tier
 *      is painted, setData never rewrites it with a lower tier.
 *   3. The final steady-state source on `guidance-leg-0` is `"shape"` —
 *      the single-transaction sync commits shapes alongside raptor-data,
 *      so the leg must land on the highest tier.*/
test.describe("RouteOverlay no-flicker guarantee @mock-api", () => {
  test.beforeEach(async ({ page }) => {
    // Freeze the in-browser `Date` to a deterministic weekday noon so the
    // fixture's daytime-only trips (0:00–23:00 departures) are always in
    // the future at search time. `setFixedTime` only pins `Date.now()` /
    // `new Date()`; timers / rAF continue to progress.
    await page.clock.setFixedTime(REF_FIXED_TIME);
    await mockApi(page, { catalogNow: REF_FIXED_TIME });

    // Instrument MapLibre source/layer mutations as soon as `__ptnMap`
    // appears on the window. We patch the instance rather than the prototype
    // because `maplibre-gl` is imported as an ES module in the bundle and
    // is never attached to `window` — so there's no prototype handle we can
    // reach from an addInitScript at page-load time.
    await page.addInitScript(() => {
      const w = window as unknown as {
        __ptnMap?: {
          addSource: (id: string, source: unknown) => unknown;
          removeSource: (id: string) => unknown;
          getSource: (id: string) => { setData?: (d: unknown) => unknown } | undefined;
        };
        __ptnLayerTelemetry?: {
          setDataCalls: Record<string, number>;
          removeSourceCalls: string[];
          sourceHistory: Record<string, string[]>;
          installed: boolean;
        };
      };
      w.__ptnLayerTelemetry = {
        setDataCalls: {},
        removeSourceCalls: [],
        sourceHistory: {},
        installed: false,
      };

      const install = () => {
        const map = w.__ptnMap;
        const telemetry = w.__ptnLayerTelemetry!;
        if (!map || telemetry.installed) return !!telemetry.installed;
        telemetry.installed = true;

        const origAddSource = map.addSource.bind(map);
        const origRemoveSource = map.removeSource.bind(map);
        const origGetSource = map.getSource.bind(map);

        map.removeSource = function (id: string) {
          telemetry.removeSourceCalls.push(id);
          return origRemoveSource(id);
        };

        const wrapSource = (id: string) => {
          const src = origGetSource(id);
          if (!src || typeof src.setData !== "function") return;
          const wrapped = src as unknown as {
            setData: (d: unknown) => unknown;
            __ptnWrapped?: boolean;
          };
          if (wrapped.__ptnWrapped) return;
          const origSetData = wrapped.setData.bind(wrapped);
          wrapped.setData = (d: unknown) => {
            telemetry.setDataCalls[id] = (telemetry.setDataCalls[id] ?? 0) + 1;
            const src2 = (d as { properties?: { source?: string } })
              ?.properties?.source;
            if (src2 && id.startsWith("guidance-leg-")) {
              (telemetry.sourceHistory[id] =
                telemetry.sourceHistory[id] ?? []).push(src2);
            }
            return origSetData(d);
          };
          wrapped.__ptnWrapped = true;
        };

        map.addSource = function (id: string, source: unknown) {
          const res = origAddSource(id, source);
          wrapSource(id);
          return res;
        };

        // Also wrap any sources that already exist at install time — the
        // rafScheduler may have run before the install loop caught up.
        // We don't know their ids up front, but guidance-leg-* is the only
        // family we care about; probe indices 0..7 which covers any plausible
        // itinerary leg count.
        for (let i = 0; i < 8; i++) wrapSource(`guidance-leg-${i}`);

        return true;
      };

      if (!install()) {
        const iv = setInterval(() => {
          if (install()) clearInterval(iv);
        }, 20);
      }
    });
  });

  // The post-overlay-ready wait polls for the shape tier to land on
  // guidance-leg-0 rather than sleeping a fixed budget — slower runners
  // (vite-dev under live smoke) must not decide the correctness
  // assertion. The subsequent telemetry read then sees the steady state
  // for assertions (1) no removeSource on guidance-leg-* and
  // (2) monotonic source history per leg.
  test("no removeSource, monotonic source, final tier is shape", async ({
    page,
  }) => {
    await page.goto(REF_URL);
    await page.waitForSelector('[data-testid="itinerary-card"]', {
      timeout: 15_000,
    });
    await page.locator('[data-testid="itinerary-card"]').first().click();

    // Wait for the route overlay to exist — this is the point at which
    // the scheduler has drained at least once and the first-tier source
    // is live on the map.
    await page.waitForFunction(
      () => !!(window as unknown as { __ptnMap?: { getSource: (id: string) => unknown } })
        .__ptnMap?.getSource("guidance-leg-0"),
      { timeout: 15_000 },
    );

    // Wait for guidance-leg-0 to land on the highest tier ("shape").
    // Reaching shape implies the single-transaction sync has committed
    // (raptor-data + shapes together), so the scheduler has drained
    // and the telemetry read below reflects the steady state.
    await page.waitForFunction(
      () => {
        const map = (
          window as unknown as {
            __ptnMap?: {
              getSource: (id: string) => {
                serialize?: () => {
                  data?: { properties?: { source?: string } };
                };
              } | undefined;
            };
          }
        ).__ptnMap;
        return (
          map?.getSource("guidance-leg-0")?.serialize?.().data?.properties
            ?.source === "shape"
        );
      },
      { timeout: 30_000, polling: 100 },
    );

    const telemetry = await page.evaluate(
      () =>
        (window as unknown as {
          __ptnLayerTelemetry: {
            setDataCalls: Record<string, number>;
            removeSourceCalls: string[];
            sourceHistory: Record<string, string[]>;
          };
        }).__ptnLayerTelemetry,
    );

    // 1) No guidance-leg-* sources removed during the sync.
    const guidanceRemovals = telemetry.removeSourceCalls.filter((id) =>
      id.startsWith("guidance-leg-"),
    );
    expect(guidanceRemovals).toEqual([]);

    // 2) Monotonic-forward source history on every guidance leg: once a
    //    higher tier is painted, setData never rewrites it with a lower
    //    tier. Each history entry is the `source` property the scheduler
    //    encoded into the leg's GeoJSON on a setData call.
    const rank: Record<string, number> = {
      endpoints: 0,
      intermediate: 1,
      shape: 2,
    };
    for (const [id, history] of Object.entries(telemetry.sourceHistory)) {
      if (!id.startsWith("guidance-leg-")) continue;
      for (let i = 1; i < history.length; i++) {
        const prev = rank[history[i - 1]] ?? 0;
        const curr = rank[history[i]] ?? 0;
        expect(
          curr,
          `${id} went ${history[i - 1]} -> ${history[i]}`,
        ).toBeGreaterThanOrEqual(prev);
      }
    }

    // 3) Final steady-state source on guidance-leg-0 is "shape" — the
    //    single-transaction sync commits shapes alongside raptor-data, so
    //    the leg must land on the highest tier. Reading via serialize()
    //    picks up the current data regardless of whether the last write
    //    was an addSource or a setData.
    const finalSource = await page.evaluate(() => {
      const map = (
        window as unknown as {
          __ptnMap?: {
            getSource: (id: string) => {
              serialize?: () => {
                data?: { properties?: { source?: string } };
              };
            } | undefined;
          };
        }
      ).__ptnMap;
      const src = map?.getSource("guidance-leg-0");
      return src?.serialize?.().data?.properties?.source;
    });
    expect(finalSource).toBe("shape");
  });
});
