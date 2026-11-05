import { describe, it, expect, vi, beforeEach } from "vitest";

const MOCK_CATALOG = {
  stops: [
    { id: "s1", name: "Stop A", lat: 54.68, lon: 25.28 },
    { id: "s2", name: "Stop B", lat: 54.69, lon: 25.28 },
  ],
  routes: [{
    id: "r1", shortName: "1", mode: "BUS", stopIds: ["s1", "s2"],
    trips: [{ tripId: "t1", serviceId: "svc1", headsign: "Centre", departureSecs: [28800, 28920] }],
  }],
  calendar: [{
    serviceId: "svc1", days: [true, true, true, true, true, true, true],
    startDate: "20250101", endDate: "20271231", exceptions: {},
  }],
  meta: { generatedAt: new Date().toISOString(), cityId: "vilnius" },
};

vi.mock("../../src/services/api.ts", () => ({
  api: { plan: vi.fn().mockResolvedValue([]) },
}));

// The catalog reaches the store as PTB bytes; stub the decode so this suite
// keeps handing it a plain wire object.
vi.mock("../../src/services/ptbCatalogWorkerClient.ts", async () => {
  const { ptbCatalogState } = await import("../helpers/ptbCatalog.ts");
  return { decodePtbCatalogInWorker: async () => ptbCatalogState.wire };
});

vi.mock("../../src/services/routingSource.ts", async (orig) => ({
  ...(await orig<typeof import("../../src/services/routingSource.ts")>()),
  makeRemoteStopPlanner: vi.fn(() => vi.fn(async () => [])),
}));

import { db } from "../../src/db/index.ts";
import { useRoutingStore } from "../../src/stores/routingStore.ts";
import { makeRemoteStopPlanner } from "../../src/services/routingSource.ts";
import {
  installPtbCatalogFetch,
  ptbCatalogState,
  resetPtbCatalogState,
} from "../helpers/ptbCatalog.ts";

beforeEach(async () => {
  resetPtbCatalogState();
  ptbCatalogState.wire = MOCK_CATALOG;
  installPtbCatalogFetch();
  vi.clearAllMocks();
  await db.delete();
  await db.open();
  const { useGtfsDataStore } = await import("../../src/stores/gtfsDataStore.ts");
  useGtfsDataStore.setState({ raptorIndex: null, loadedCityId: null, syncing: false, error: null });
  useRoutingStore.setState({ results: [], error: null, loading: false });
});

describe("routingStore.search remote opt-in", () => {
  it("builds a remote StopPlanner only when { remote: true } is passed", async () => {
    const { useGtfsDataStore } = await import("../../src/stores/gtfsDataStore.ts");
    await useGtfsDataStore.getState().init("vilnius");

    const { SearchOrchestrator } = await import("../../src/services/searchOrchestrator.ts");
    const searchSpy = vi
      .spyOn(SearchOrchestrator.prototype, "search")
      .mockResolvedValue([]);

    const from = { kind: "stop", stopId: "A", lat: 0, lon: 0 } as never;
    const to = { kind: "stop", stopId: "B", lat: 0, lon: 0 } as never;

    await useRoutingStore.getState().search(from, to, new Date(), { remote: true });
    expect(makeRemoteStopPlanner).toHaveBeenCalled();

    vi.clearAllMocks();

    await useRoutingStore.getState().search(from, to, new Date());
    expect(makeRemoteStopPlanner).not.toHaveBeenCalled();

    searchSpy.mockRestore();
  });
});
