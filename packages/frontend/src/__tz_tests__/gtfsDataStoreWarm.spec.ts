/**
 * [R-fold v4 BLOCKING #8 complement / test-side of BLOCKING #1] The `gtfsDataStore`
 * warm-restart path (`!needsSync` + `!raptorIndex`) must set `bundleCityTzIana` from
 * the rebuilt index, exactly like the fresh-sync path — else a warm start would
 * leave `bundleCityTzIana=null`, the drift guard would read "can't cross-check", and
 * a real config-vs-bundle tz drift would ship undetected. This test drives that warm
 * branch and asserts `bundleCityTzIana` is populated. It lives in `__tz_tests__` so
 * it runs under the non-UTC zones alongside the rendered drift-surface test (#8).
 *
 * `.spec.ts` under `src/__tz_tests__/` → collected ONLY by `vitest.tz.config.ts`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "../db/index.ts";
import type { RoutingBundleData } from "@pt/shared";

const FEED_TZ = "Europe/Vilnius";

const mockData: RoutingBundleData = {
  stops: [{ id: "s1", name: "Stop A", lat: 54.68, lon: 25.28 }],
  routes: [
    {
      id: "r1",
      shortName: "1",
      mode: "BUS",
      stopIds: ["s1"],
      trips: [{ tripId: "t1", serviceId: "svc1", headsign: "Centre", departureSecs: [28800] }],
    },
  ],
  calendar: [
    {
      serviceId: "svc1",
      days: [true, true, true, true, true, false, false],
      startDate: "20250101",
      endDate: "20271231",
      exceptions: {},
    },
  ],
  // The agency tz the warm path must surface onto the index → store.
  meta: { generatedAt: new Date().toISOString(), cityId: "vilnius", cityTzIana: FEED_TZ },
};

// Catalog transport is PTB bytes; stub the decode so this suite keeps handing
// the store a wire object with the agency tz it is asserting on. The stub is
// inline rather than shared with `tests/helpers/ptbCatalog.ts` because this
// suite lives under `src/`, whose tsconfig rootDir cannot reach `tests/`.
vi.mock("../services/ptbCatalogWorkerClient.ts", () => ({
  decodePtbCatalogInWorker: async () => mockData,
}));

const STUB_GENERATION_ID = "d".repeat(64);

/** Serve `/ready` + `/raptor-bundle` — the two halves of a catalog fetch. */
function installCatalogFetch(cityId = "vilnius"): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(`/api/${cityId}/ready`)) {
      return new Response(JSON.stringify({
        status: "ready",
        city: cityId,
        servingGenerationId: STUB_GENERATION_ID,
        generationAgeSecs: 60,
        cityTzIana: FEED_TZ,
        servingShapesJsonSha256: null,
        servingShapesJsonSizeBytes: null,
        nowUnixSecs: 1_800_000_000,
        patternMode: "covering-merge",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith(`/api/${cityId}/raptor-bundle`)) {
      return new Response(new Uint8Array([1, 2, 3, 4]) as unknown as BodyInit, {
        status: 200,
        headers: {
          etag: `"${STUB_GENERATION_ID}"`,
          "content-type": "application/octet-stream",
          "x-pt-raptor-bundle-provenance": "transfers-v1",
        },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
}

beforeEach(async () => {
  installCatalogFetch();
  await db.delete();
  await db.open();
  const { useGtfsDataStore } = await import("../stores/gtfsDataStore.ts");
  useGtfsDataStore.setState({
    raptorIndex: null,
    loadedCityId: null,
    syncing: false,
    error: null,
    bundleCityTzIana: null,
  });
});

describe("gtfsDataStore warm path sets bundleCityTzIana", () => {
  it("fresh sync sets bundleCityTzIana from meta.cityTzIana", async () => {
    const { useGtfsDataStore } = await import("../stores/gtfsDataStore.ts");
    await useGtfsDataStore.getState().init("vilnius");
    expect(useGtfsDataStore.getState().raptorIndex).not.toBeNull();
    expect(useGtfsDataStore.getState().bundleCityTzIana).toBe(FEED_TZ);
  });

  it("WARM restart (!needsSync + !raptorIndex) re-sets bundleCityTzIana", async () => {
    const { useGtfsDataStore } = await import("../stores/gtfsDataStore.ts");
    // 1. Prime: fresh sync populates IndexedDB + the bundle blob.
    await useGtfsDataStore.getState().init("vilnius");
    expect(useGtfsDataStore.getState().bundleCityTzIana).toBe(FEED_TZ);

    // 2. Simulate a warm restart: the synced data is still on disk (sync meta is
    //    fresh → needsSync=false) but the in-memory index is gone (null) and so is
    //    the tz. This is exactly the `else if (!get().raptorIndex)` branch.
    useGtfsDataStore.setState({ raptorIndex: null, bundleCityTzIana: null });

    // 3. Re-init: needsSync=false (fresh meta), no raptorIndex → rebuild branch.
    await useGtfsDataStore.getState().init("vilnius");
    expect(useGtfsDataStore.getState().raptorIndex).not.toBeNull();
    expect(useGtfsDataStore.getState().bundleCityTzIana).toBe(FEED_TZ);
  });
});
