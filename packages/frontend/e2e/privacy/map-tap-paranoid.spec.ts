import { test, expect, type Page } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";
import { bootAtPrivacyLevel } from "../../tests/privacy-harness/bootAtLevel";
import {
  assertNetworkPattern,
  installNetworkRecorder,
} from "../../tests/privacy-harness/assertNetworkPattern";

/**
 * M7b T-8 — Paranoid map-tap emits zero reverse-geocode and still routes.
 *
 * Contract under test: at privacy level `paranoid` the long-press → "Use as
 * origin" path reduces the tap to a 100m-rounded `mappoint` endpoint, never
 * invokes any reverse-geocode provider, and leaves the routing engine in a
 * state where a route can be computed end-to-end from that origin.
 *
 * Runs under the privacy-harness Playwright config so it is exercised by the
 * `performance` CI job alongside the per-level network baselines.
 */

const ROUTING_STORE_URL = "/src/stores/routingStore.ts";

interface RoutingOriginSnapshot {
  kind: string;
  lat: number;
  lon: number;
}

declare global {
  interface Window {
    __ptnPinOrigin?: RoutingOriginSnapshot | null;
  }
}

/**
 * Latch the endpoint at the moment the action sheet writes it. The store slot
 * is consume-once — `SearchPage` hydrates from it and nulls it — so reading
 * `routingStore.origin` after the navigation would race the consumer.
 */
async function watchRoutingOrigin(page: Page): Promise<void> {
  await page.evaluate(async (moduleUrl) => {
    const mod = (await import(/* @vite-ignore */ moduleUrl)) as {
      useRoutingStore: {
        subscribe: (
          listener: (state: {
            origin: { kind: string; lat: number; lon: number } | null;
          }) => void,
        ) => () => void;
      };
    };
    window.__ptnPinOrigin = null;
    mod.useRoutingStore.subscribe((state) => {
      if (state.origin) {
        window.__ptnPinOrigin = {
          kind: state.origin.kind,
          lat: state.origin.lat,
          lon: state.origin.lon,
        };
      }
    });
  }, ROUTING_STORE_URL);
}

async function readWatchedOrigin(
  page: Page,
): Promise<RoutingOriginSnapshot | null> {
  return await page.evaluate(() => window.__ptnPinOrigin ?? null);
}

async function computeRouteFromOrigin(
  page: Page,
  origin: RoutingOriginSnapshot,
  destination: { lat: number; lon: number },
): Promise<{ error: string | null; loading: boolean }> {
  return await page.evaluate(
    async ({ moduleUrl, org, dest }) => {
      const mod = (await import(/* @vite-ignore */ moduleUrl)) as {
        useRoutingStore: {
          getState: () => {
            search: (
              origin: { kind: string; lat: number; lon: number },
              destination: { kind: string; lat: number; lon: number },
              departureTime: Date,
            ) => Promise<void>;
            loading: boolean;
            error: string | null;
          };
        };
      };
      const state = mod.useRoutingStore.getState();
      const destEndpoint = { kind: "mappoint", lat: dest.lat, lon: dest.lon };
      // Fixed departure within the fixture's service calendar
      // (2026-01-01 → 2027-12-31) so the test is independent of wall-clock
      // drift across time.
      const departure = new Date("2026-06-01T07:30:00Z");
      await state.search(org, destEndpoint, departure);
      const after = mod.useRoutingStore.getState();
      return { error: after.error, loading: after.loading };
    },
    { moduleUrl: ROUTING_STORE_URL, org: origin, dest: destination },
  );
}

test.describe("Privacy: map-tap at Paranoid @mock-api", () => {
  test("long-press → Use as origin fires zero reverse-geocode and route computes", async ({
    page,
  }) => {
    await bootAtPrivacyLevel(page, "paranoid");
    // The harness's own catalog is Vilnius-anchored and already carries the
    // Gedimino pr. / Lukiskiu aikste pair at the coordinates this test
    // long-presses near, so `resolveToEntryStops` finds entry stops without an
    // override. The spec used to substitute its own graph over
    // `/gtfs/raptor-data`, back when that endpoint served the catalog.
    await mockApi(page);

    const recorder = installNetworkRecorder(page);

    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({
      timeout: 20_000,
    });

    // Let GTFS finish hydrating so the action sheet has stop data
    // (`useLiveQuery(db.stopGroups.toArray())`) AND the routing search can run
    // against a built `raptorIndex`. stopGroups are written inside
    // `syncGtfsData` but `raptorIndex` is only set afterward via
    // `buildRaptorIndex`; waiting only on stopGroups would race with the
    // subsequent `routingStore.search` call and trip the GTFS-not-loaded path.
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(
      async () => {
        const [dbMod, gtfsMod] = await Promise.all([
          import(/* @vite-ignore */ "/src/db/index.ts") as Promise<{
            db: { stopGroups: { count: () => Promise<number> } };
          }>,
          import(/* @vite-ignore */ "/src/stores/gtfsDataStore.ts") as Promise<{
            useGtfsDataStore: {
              getState: () => { raptorIndex: unknown | null };
            };
          }>,
        ]);
        const stopCount = await dbMod.db.stopGroups.count();
        const raptorReady =
          gtfsMod.useGtfsDataStore.getState().raptorIndex !== null;
        return stopCount > 0 && raptorReady;
      },
      null,
      { timeout: 20_000 },
    );

    // Long-press on the map center. maplibregl listens to `mousedown` and
    // starts the 500ms timer; we hold for 700ms with no movement.
    const canvas = page.locator(".maplibregl-canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Map canvas has no bounding box");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();

    const sheet = page.getByRole("dialog", { name: /Dropped pin/i });
    await expect(sheet).toBeVisible({ timeout: 5_000 });

    await watchRoutingOrigin(page);

    // "Use as origin" on the tapped-point row. If a nearby stop is within the
    // Paranoid 100m snap radius the first origin button is the tapped-point
    // variant; either way we want to exercise the dispatch path.
    await sheet
      .getByRole("button", { name: /^Use as origin$/i })
      .first()
      .click();

    // Action sheet clears itself once the endpoint is consumed.
    await expect(sheet).toBeHidden();

    // The user-visible half of the contract: the action lands on the planner
    // with the pin already in the From field. Asserting only the store slot
    // let the whole handoff ship dead — the buttons set state nothing read.
    await expect(page).toHaveURL(/\/search/);
    // Single-field picking opens To after an origin handoff. Switch back to
    // From to inspect the retained pin through the same action a user sees.
    await page.getByRole("button", { name: /^Edit origin: Dropped pin/i }).click();
    const fromInput = page.getByRole("searchbox", { name: "From", exact: true });
    await expect(fromInput).toBeVisible();
    await expect(fromInput).toHaveValue(/Dropped pin/i, { timeout: 5_000 });

    // The dispatched endpoint must be the snap-rounded-100m payload produced
    // by `persistMapTap`. Verify idempotency: the coord must already sit on
    // the 100m grid (re-snapping is a no-op).
    const origin = await readWatchedOrigin(page);
    expect(origin).not.toBeNull();
    expect(origin!.kind).toBe("mappoint");
    const EARTH_LAT_METERS_PER_DEG = 111_320;
    const latStep = 100 / EARTH_LAT_METERS_PER_DEG;
    const lonStep =
      100 /
      (EARTH_LAT_METERS_PER_DEG * Math.cos((origin!.lat * Math.PI) / 180));
    const reSnappedLat = Math.round(origin!.lat / latStep) * latStep;
    const reSnappedLon = Math.round(origin!.lon / lonStep) * lonStep;
    expect(Math.abs(origin!.lat - reSnappedLat)).toBeLessThan(1e-9);
    expect(Math.abs(origin!.lon - reSnappedLon)).toBeLessThan(1e-9);

    // End-to-end: feed the stored origin back into `routingStore.search` with a
    // destination that exists in the (overridden) RAPTOR graph. The search
    // path exercises `resolveToEntryStops` → orchestrator → RAPTOR, proving
    // routing still works after the privacy-rounded origin. A specific error
    // would indicate `resolveToEntryStops` rejected the snapped coord — the
    // regression we actually care about.
    const outcome = await computeRouteFromOrigin(page, origin!, {
      lat: 54.6876,
      lon: 25.2808,
    });
    expect(outcome.error).toBeNull();
    expect(outcome.loading).toBe(false);

    // The load-bearing assertion: Paranoid must never have hit a
    // reverse-geocode provider across the entire flow.
    assertNetworkPattern(recorder, [
      { kind: "reverse-geocode", maxCount: 0 },
      { kind: "forward-geocode", maxCount: 0 },
    ]);

    recorder.stop();
  });
});
