import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "../../src/db/index.ts";
import type { RoutingBundleData } from "@pt/shared";
import {
  installPtbCatalogFetch,
  ptbCatalogState,
  resetPtbCatalogState,
} from "../helpers/ptbCatalog.ts";

const mockData: RoutingBundleData = {
  stops: [{ id: "s1", name: "Stop A", lat: 54.68, lon: 25.28 }],
  routes: [{
    id: "r1", shortName: "1", mode: "BUS", stopIds: ["s1"],
    trips: [{ tripId: "t1", serviceId: "svc1", headsign: "Centre", departureSecs: [28800] }],
  }],
  calendar: [{
    serviceId: "svc1", days: [true, true, true, true, true, false, false],
    startDate: "20250101", endDate: "20271231", exceptions: {},
  }],
  meta: { generatedAt: new Date().toISOString(), cityId: "vilnius" },
};

vi.mock("../../src/services/ptbCatalogWorkerClient.ts", async () => {
  const { ptbCatalogState } = await import("../helpers/ptbCatalog.ts");
  return { decodePtbCatalogInWorker: async () => ptbCatalogState.wire };
});

// jsdom cannot build the wasm router, and the real attempt fails late — after
// the file's last test — which Vitest 4 reports as a teardown error. Fail it up
// front instead; no case here depends on the router.
vi.mock("../../src/services/wasmLifecycle.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/wasmLifecycle.ts")>()),
  initOrSwapPtRouter: async () => {
    throw new Error("no wasm router in jsdom");
  },
}));

beforeEach(async () => {
  resetPtbCatalogState();
  ptbCatalogState.wire = mockData;
  installPtbCatalogFetch();
  await db.delete();
  await db.open();
  // Reset store state between tests
  const { useGtfsDataStore } = await import("../../src/stores/gtfsDataStore.ts");
  useGtfsDataStore.setState({ raptorIndex: null, loadedCityId: null, syncing: false, error: null });
});

describe("useGtfsDataStore", () => {
  it("init syncs and builds RAPTOR index", async () => {
    const { useGtfsDataStore } = await import("../../src/stores/gtfsDataStore.ts");
    await useGtfsDataStore.getState().init("vilnius");
    const { raptorIndex } = useGtfsDataStore.getState();
    expect(raptorIndex).not.toBeNull();
    expect(raptorIndex!.routes).toHaveLength(1);
    expect(raptorIndex!.routesAtStop.get("s1")).toBeDefined();
  });

  it("reset clears everything", async () => {
    const { useGtfsDataStore } = await import("../../src/stores/gtfsDataStore.ts");
    await useGtfsDataStore.getState().init("vilnius");
    await useGtfsDataStore.getState().reset();
    expect(useGtfsDataStore.getState().raptorIndex).toBeNull();
    expect(await db.gtfsRoutes.toArray()).toHaveLength(0);
  });

  it("bumping the generation aborts the previous generation's fetch signal (F9)", async () => {
    const { useGtfsDataStore } = await import("../../src/stores/gtfsDataStore.ts");
    await useGtfsDataStore.getState().init("vilnius");
    const firstSignal = useGtfsDataStore.getState().getInitAbortSignal();
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    expect(firstSignal!.aborted).toBe(false);

    // A reset (or a new init/refresh) bumps the generation — the previous
    // generation's in-flight transfers/OSRM downloads must be aborted.
    await useGtfsDataStore.getState().reset();
    expect(firstSignal!.aborted).toBe(true);

    // The new generation gets a fresh, un-aborted signal.
    const secondSignal = useGtfsDataStore.getState().getInitAbortSignal();
    expect(secondSignal).not.toBe(firstSignal);
    expect(secondSignal!.aborted).toBe(false);
  });
});
