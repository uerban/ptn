/** The agency timezone must survive both network activation and an offline
 * restart from the verified raw artifact, independent of the device timezone.
 * Collected only by vitest.tz.config.ts (New York and Vilnius). */
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {URL as NodeURL} from "node:url";
import {clearCityArtifactMemory} from "../services/cityArtifactMemory.ts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

// Real bytes and matching identity are required by activation's integrity gate.
const PTB_BYTES = new Uint8Array(readFileSync(new NodeURL("../../../shared/src/ptb/__fixtures__/tiny-service-pool.ptb", import.meta.url)));
const STUB_GENERATION_ID = createHash("sha256").update(PTB_BYTES).digest("hex");
vi.mock("../services/osrmWasm.ts", () => ({osrmClient: {init: async () => {}}}));
vi.mock("../services/wasmLifecycle.ts", () => ({initOrSwapPtRouter: () => new Promise(() => {})}));

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
      return new Response(PTB_BYTES as unknown as BodyInit, {
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
  const {useGtfsDataStore} = await import("../stores/gtfsDataStore.ts");
  await useGtfsDataStore.getState().reset();
  clearCityArtifactMemory();
  installCatalogFetch();
  await db.delete();
  await db.open();
});
afterEach(async () => {
  const {useGtfsDataStore} = await import("../stores/gtfsDataStore.ts");
  await useGtfsDataStore.getState().reset();
  clearCityArtifactMemory();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("gtfsDataStore agency timezone", () => {
  it("sets bundleCityTzIana on verified network activation", async () => {
    const {useGtfsDataStore} = await import("../stores/gtfsDataStore.ts");
    await useGtfsDataStore.getState().init("vilnius");
    expect(useGtfsDataStore.getState().error).toBeNull();
    expect(useGtfsDataStore.getState().raptorIndex).not.toBeNull();
    expect(useGtfsDataStore.getState().bundleCityTzIana).toBe(FEED_TZ);
  });

  it("restores bundleCityTzIana from durable raw data offline without a fetch", async () => {
    const {useGtfsDataStore} = await import("../stores/gtfsDataStore.ts");
    await useGtfsDataStore.getState().init("vilnius");
    await vi.waitFor(() => expect(useGtfsDataStore.getState().persistence).toBe("stored"));
    // Drop all resident catalog/index/raw state; keep only the committed DB.
    await useGtfsDataStore.getState().reset();
    clearCityArtifactMemory();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    vi.mocked(globalThis.fetch).mockClear();

    await useGtfsDataStore.getState().init("vilnius");
    expect(useGtfsDataStore.getState().error).toBeNull();
    expect(useGtfsDataStore.getState().raptorIndex).not.toBeNull();
    expect(useGtfsDataStore.getState().bundleCityTzIana).toBe(FEED_TZ);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
