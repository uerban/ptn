import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "../../src/db/index.ts";
import type { BaseEndpoint, RoutingBundleData } from "@pt/shared";
import {
  installPtbCatalogFetch,
  ptbCatalogState,
  resetPtbCatalogState,
} from "../helpers/ptbCatalog.ts";

const mockData: RoutingBundleData = {
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
  api: {
    plan: vi.fn(),
  },
}));

vi.mock("../../src/services/ptbCatalogWorkerClient.ts", async () => {
  const { ptbCatalogState } = await import("../helpers/ptbCatalog.ts");
  return { decodePtbCatalogInWorker: async () => ptbCatalogState.wire };
});

beforeEach(async () => {
  resetPtbCatalogState();
  ptbCatalogState.wire = mockData;
  installPtbCatalogFetch();
  await db.delete();
  await db.open();
  const { useGtfsDataStore } = await import("../../src/stores/gtfsDataStore.ts");
  useGtfsDataStore.setState({ raptorIndex: null, loadedCityId: null, syncing: false, error: null });
  const { useRoutingStore } = await import("../../src/stores/routingStore.ts");
  useRoutingStore.setState({ results: [], error: null, loading: false });
});

afterEach(async () => {
  const {walkGraphClient} = await import("../../src/services/walkGraphClient.ts");
  expect(walkGraphClient.hasActiveSearch()).toBe(false);
});

describe("useRoutingStore.search", () => {
  it("returns a local probe without replacing the active search or dispatching remotely", async () => {
    const { useGtfsDataStore } = await import("../../src/stores/gtfsDataStore.ts");
    const { useRoutingStore } = await import("../../src/stores/routingStore.ts");
    const { SearchOrchestrator } = await import("../../src/services/searchOrchestrator.ts");
    const { api } = await import("../../src/services/api.ts");
    await useGtfsDataStore.getState().init("vilnius");

    const search = vi.spyOn(SearchOrchestrator.prototype, "search");
    const expected: Awaited<ReturnType<SearchOrchestrator["search"]>> = [];
    search.mockResolvedValue(expected);
    const endpoint: BaseEndpoint = { kind: "stop", stopId: "s1", name: "Stop A", lat: 54.68, lon: 25.28 };
    const at = new Date("2026-04-13T08:00:00Z");
    const controller = new AbortController();
    const activeState = useRoutingStore.getState();
    try {
      expect(await activeState.search(endpoint, endpoint, at, {
        probe: controller.signal, firstRide: { routeId: "r1", direct: false },
      })).toBe(expected);
      expect(search).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ departureTime: at, originStopId: "s1", firstRouteId: "r1" }));
      expect(useRoutingStore.getState()).toBe(activeState);
      expect(api.plan).not.toHaveBeenCalled();
      search.mockImplementationOnce(async () => {
        controller.abort();
        return expected;
      });
      expect(await activeState.search(endpoint, endpoint, at, { probe: controller.signal })).toBeUndefined();
      expect(useRoutingStore.getState()).toBe(activeState);
    } finally {
      search.mockRestore();
    }
  });

  it("rejects a foreign resident index before the city lifecycle effect runs", async () => {
    const {useGtfsDataStore} = await import("../../src/stores/gtfsDataStore.ts");
    const {useCityStore} = await import("../../src/stores/cityStore.ts");
    const {useRoutingStore} = await import("../../src/stores/routingStore.ts");
    const {SearchOrchestrator} = await import("../../src/services/searchOrchestrator.ts");
    await useGtfsDataStore.getState().init("vilnius");
    const original = useCityStore.getState().activeCity;
    const search = vi.spyOn(SearchOrchestrator.prototype, "search").mockResolvedValue([]);
    try {
      useCityStore.setState({activeCity: {...original, id: "other"}});
      const group: BaseEndpoint = {kind: "stopGroup", stopIds: ["s1"], lat: 54.68, lon: 25.28, label: "Reused id"};
      await useRoutingStore.getState().search(group, group, new Date());
      expect(search).not.toHaveBeenCalled();
      expect(useRoutingStore.getState().error).toMatch(/GTFS data not loaded/);
      expect(useRoutingStore.getState().results).toEqual([]);
    } finally {useCityStore.setState({activeCity: original}); search.mockRestore();}
  });

  it("accepts BaseEndpoint for origin/destination", async () => {
    const { useGtfsDataStore } = await import("../../src/stores/gtfsDataStore.ts");
    await useGtfsDataStore.getState().init("vilnius");

    const { useRoutingStore } = await import("../../src/stores/routingStore.ts");
    const store = useRoutingStore.getState();

    const origin: BaseEndpoint = {
      kind: "stop", stopId: "s1", name: "Stop A", lat: 54.68, lon: 25.28,
    };
    const destination: BaseEndpoint = {
      kind: "mappoint", lat: 54.69, lon: 25.28,
    };

    await expect(store.search(origin, destination, new Date("2026-04-13T08:00:00Z"))).resolves.toBeUndefined();

    const state = useRoutingStore.getState();
    expect(state.loading).toBe(false);
    // Either results populated or an error populated — not a type-level failure.
    expect(Array.isArray(state.results)).toBe(true);
  });

  it("short-circuits when raptorIndex not loaded", async () => {
    const { useRoutingStore } = await import("../../src/stores/routingStore.ts");
    const store = useRoutingStore.getState();

    const origin: BaseEndpoint = { kind: "mappoint", lat: 54.68, lon: 25.28 };
    const destination: BaseEndpoint = { kind: "mappoint", lat: 54.69, lon: 25.28 };

    await store.search(origin, destination, new Date());
    expect(useRoutingStore.getState().error).toMatch(/GTFS data not loaded/);
  });

  it("sets an error when origin cannot be resolved to any stop", async () => {
    const { useGtfsDataStore } = await import("../../src/stores/gtfsDataStore.ts");
    await useGtfsDataStore.getState().init("vilnius");

    const { useRoutingStore } = await import("../../src/stores/routingStore.ts");
    const store = useRoutingStore.getState();

    const origin: BaseEndpoint = { kind: "mappoint", lat: 0, lon: 0 };
    const destination: BaseEndpoint = { kind: "mappoint", lat: 54.68, lon: 25.28 };

    await store.search(origin, destination, new Date("2026-04-13T08:00:00Z"));
    const state = useRoutingStore.getState();
    expect(state.error).toBeTruthy();
    expect(state.results).toEqual([]);
  });

  it("forwards stopGroup member ids as originStopIds/destStopIds to the orchestrator", async () => {
    const { useGtfsDataStore } = await import("../../src/stores/gtfsDataStore.ts");
    await useGtfsDataStore.getState().init("vilnius");

    const { useRoutingStore } = await import("../../src/stores/routingStore.ts");
    const { SearchOrchestrator } = await import("../../src/services/searchOrchestrator.ts");

    // Spy on the prototype so we capture the query passed to the orchestrator
    // without running a full search. `resolveToEntryStops` forces every
    // stopGroup member to walkSecs:0 regardless of radius, so the empty-guard
    // in routingStore passes with these arbitrary member ids and the
    // orchestrator.search call is reached.
    const searchSpy = vi
      .spyOn(SearchOrchestrator.prototype, "search")
      .mockResolvedValue([]);

    const origin = {
      kind: "stopGroup", stopIds: ["A", "B"], lat: 54.7, lon: 25.3, label: "G",
    } as const;
    const destination = {
      kind: "stopGroup", stopIds: ["C"], lat: 54.71, lon: 25.31, label: "H",
    } as const;

    await useRoutingStore.getState().search(origin, destination, new Date("2026-04-13T08:00:00Z"));

    expect(searchSpy).toHaveBeenCalledTimes(1);
    const query = searchSpy.mock.calls[0][0];
    expect(query.originStopIds).toEqual(["A", "B"]);
    expect(query.destStopIds).toEqual(["C"]);

    searchSpy.mockRestore();
  });

  it("leaves originStopIds/destStopIds undefined and keeps the singular originStopId for a non-group endpoint", async () => {
    const { useGtfsDataStore } = await import("../../src/stores/gtfsDataStore.ts");
    await useGtfsDataStore.getState().init("vilnius");

    const { useRoutingStore } = await import("../../src/stores/routingStore.ts");
    const { SearchOrchestrator } = await import("../../src/services/searchOrchestrator.ts");

    const searchSpy = vi
      .spyOn(SearchOrchestrator.prototype, "search")
      .mockResolvedValue([]);

    const origin: BaseEndpoint = {
      kind: "stop", stopId: "s1", name: "Stop A", lat: 54.68, lon: 25.28,
    };
    const destination: BaseEndpoint = { kind: "mappoint", lat: 54.69, lon: 25.28 };

    await useRoutingStore.getState().search(origin, destination, new Date("2026-04-13T08:00:00Z"));

    expect(searchSpy).toHaveBeenCalledTimes(1);
    const query = searchSpy.mock.calls[0][0];
    // The plural list stays undefined for non-group endpoints …
    expect(query.originStopIds).toBeUndefined();
    expect(query.destStopIds).toBeUndefined();
    // … and the singular stop path is not regressed.
    expect(query.originStopId).toBe("s1");

    searchSpy.mockRestore();
  });
});


it("retains a pedestrian result when origin has no reachable stops", async () => {
 const {useGtfsDataStore}=await import("../../src/stores/gtfsDataStore.ts");
 await useGtfsDataStore.getState().init("vilnius");
 const {useRoutingStore}=await import("../../src/stores/routingStore.ts");
 const {SearchOrchestrator}=await import("../../src/services/searchOrchestrator.ts");
 const {directWalkCandidate}=await import("../../src/services/directWalkCandidate.ts");
 const origin={kind:"mappoint" as const,lat:0,lon:0}, destination={kind:"mappoint" as const,lat:0,lon:0.0001};
 const {walkGraphClient}=await import("../../src/services/walkGraphClient.ts");
 const graph=vi.spyOn(walkGraphClient,"routeFor").mockResolvedValue({distanceMeters:15,coords:[[0,0],[0.0001,0]],steps:[]});
 const candidate=directWalkCandidate(origin,destination,{distanceMeters:15,coords:[[0,0],[0.0001,0]],steps:[]},28800,1.5)!;
 const search=vi.spyOn(SearchOrchestrator.prototype,"search").mockResolvedValue([candidate]);
 try {
  await useRoutingStore.getState().search(origin,destination,new Date("2026-04-13T08:00:00Z"));
  expect(search).toHaveBeenCalled();
  expect(useRoutingStore.getState().results).toEqual([candidate]);
  expect(useRoutingStore.getState().error).toBeNull();
 } finally {search.mockRestore();graph.mockRestore();}
});

it("does not publish pedestrian evidence invalidated before search completes", async () => {
  const {useGtfsDataStore} = await import("../../src/stores/gtfsDataStore.ts");
  await useGtfsDataStore.getState().init("vilnius");
  const {useRoutingStore} = await import("../../src/stores/routingStore.ts");
  const {SearchOrchestrator} = await import("../../src/services/searchOrchestrator.ts");
  const {walkGraphClient} = await import("../../src/services/walkGraphClient.ts");
  const {StaleWasmInitError} = await import("../../src/services/raptorWasm.ts");
  const {api} = await import("../../src/services/api.ts");
  vi.mocked(api.plan).mockClear();
  const graph = vi.spyOn(walkGraphClient, "routeFor").mockResolvedValue({
    distanceMeters: 15, coords: [[0, 0], [0.0001, 0]], steps: [],
  });
  const search = vi.spyOn(SearchOrchestrator.prototype, "search").mockImplementation(async () => {
    walkGraphClient.destroy();
    return [];
  });
  try {
    await expect(useRoutingStore.getState().search(
      {kind: "mappoint", lat: 0, lon: 0}, {kind: "mappoint", lat: 0, lon: 0.0001},
      new Date("2026-04-13T08:00:00Z"),
    )).rejects.toBeInstanceOf(StaleWasmInitError);
    expect(useRoutingStore.getState().results).toEqual([]);
    expect(useRoutingStore.getState().loading).toBe(false);
    expect(useRoutingStore.getState().error).toBeNull();
    expect(api.plan).not.toHaveBeenCalled();
  } finally {
    graph.mockRestore();
    search.mockRestore();
  }
});

it.each([
  {run:false,profile:"default" as const,planned:false},
  {run:true,profile:"default" as const,planned:true},
  {run:true,profile:"wheelchair" as const,planned:false},
])("preflight respects run=$run and profile=$profile",async({run,profile,planned})=>{
  const {useGtfsDataStore}=await import("../../src/stores/gtfsDataStore.ts");
  await useGtfsDataStore.getState().init("vilnius");
  const {useRoutingStore}=await import("../../src/stores/routingStore.ts");
  const {useSettingsStore}=await import("../../src/stores/settingsStore.ts");
  const {SearchOrchestrator}=await import("../../src/services/searchOrchestrator.ts");
  const {walkGraphClient}=await import("../../src/services/walkGraphClient.ts");
  const settings=useSettingsStore.getState();
  const graph=vi.spyOn(walkGraphClient,"routeFor").mockResolvedValue(null);
  const search=vi.spyOn(SearchOrchestrator.prototype,"search").mockResolvedValue([]);
  try {
    useSettingsStore.setState({runToCatch:run,mobilityProfile:profile,walkSpeedMps:1.25,maxWalkSecs:200});
    await useRoutingStore.getState().search(
      {kind:"mappoint",lat:54.6764,lon:25.28}, {kind:"mappoint",lat:54.69,lon:25.28},
      new Date("2026-04-13T08:00:00Z"),
    );
    expect(search.mock.calls.length>0).toBe(planned);
  } finally {useSettingsStore.setState(settings);search.mockRestore();graph.mockRestore();}
});

function pendingValue<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function overlappingRoutingSearches() {
  const { useGtfsDataStore } = await import("../../src/stores/gtfsDataStore.ts");
  const { useRoutingStore } = await import("../../src/stores/routingStore.ts");
  const { SearchOrchestrator } = await import("../../src/services/searchOrchestrator.ts");
  const { directWalkCandidate } = await import("../../src/services/directWalkCandidate.ts");
  await useGtfsDataStore.getState().init("vilnius");
  const origin: BaseEndpoint = { kind: "stop", stopId: "s1", name: "Stop A", lat: 54.68, lon: 25.28 };
  const destination: BaseEndpoint = { kind: "stop", stopId: "s2", name: "Stop B", lat: 54.69, lon: 25.28 };
  const olderResult = directWalkCandidate(origin, destination, {
    distanceMeters: 1200, coords: [[25.28, 54.68], [25.28, 54.69]], steps: [],
  }, 28800, 1.25)!;
  const newerResult = directWalkCandidate(destination, origin, {
    distanceMeters: 1300, coords: [[25.28, 54.69], [25.28, 54.68]], steps: [],
  }, 28920, 1.25)!;
  type Results = Awaited<ReturnType<InstanceType<typeof SearchOrchestrator>["search"]>>;
  const older = pendingValue<Results>(), newer = pendingValue<Results>();
  const olderStarted = pendingValue<void>(), newerStarted = pendingValue<void>();
  const search = vi.spyOn(SearchOrchestrator.prototype, "search")
    .mockImplementationOnce(() => { olderStarted.resolve(); return older.promise; })
    .mockImplementationOnce(() => { newerStarted.resolve(); return newer.promise; });
  const store = useRoutingStore.getState();
  const olderSearch = store.search(origin, destination, new Date("2026-04-13T08:00:00Z"));
  await olderStarted.promise;
  const newerSearch = store.search(destination, origin, new Date("2026-04-13T08:02:00Z"));
  await newerStarted.promise;
  return { older, newer, olderSearch, newerSearch, olderResult, newerResult, useRoutingStore,
    async cleanup() {
      older.resolve([olderResult]); newer.resolve([newerResult]);
      await Promise.allSettled([olderSearch, newerSearch]); search.mockRestore();
    },
  };
}

it("keeps newer routing results when an older request finishes last", async () => {
  const run = await overlappingRoutingSearches();
  try {
    run.newer.resolve([run.newerResult]); await run.newerSearch;
    run.older.resolve([run.olderResult]); await run.olderSearch;
    expect(run.useRoutingStore.getState().results).toEqual([run.newerResult]);
  } finally { await run.cleanup(); }
});

it("keeps the newer consumer's results when both requests settle in one turn", async () => {
  const run = await overlappingRoutingSearches();
  try {
    // This is Search.tsx's contract: read the shared store in search().then().
    const consumed = run.newerSearch.then(() => run.useRoutingStore.getState().results);
    run.newer.resolve([run.newerResult]); run.older.resolve([run.olderResult]);
    expect(await consumed).toEqual([run.newerResult]);
    await run.olderSearch;
  } finally { await run.cleanup(); }
});

it.each(["generic", "engine"])("ignores an obsolete %s failure after newer success", async (kind) => {
  const run = await overlappingRoutingSearches();
  const { PtWasmQueryError } = await import("../../src/services/raptorWasm.ts");
  try {
    run.newer.resolve([run.newerResult]); await run.newerSearch;
    run.older.reject(kind === "engine" ? new PtWasmQueryError("old engine") : new Error("old network"));
    await run.olderSearch;
    expect(run.useRoutingStore.getState()).toMatchObject({
      results: [run.newerResult], error: null, engineError: null, engineFailureKind: null, loading: false,
    });
  } finally { await run.cleanup(); }
});

it("does not clear newer loading when an obsolete request reports stale WASM", async () => {
  const run = await overlappingRoutingSearches();
  const { StaleWasmInitError } = await import("../../src/services/raptorWasm.ts");
  const { walkGraphClient } = await import("../../src/services/walkGraphClient.ts");
  try {
    run.older.reject(new StaleWasmInitError()); await run.olderSearch.catch(() => {});
    expect(run.useRoutingStore.getState().loading).toBe(true);
    expect(walkGraphClient.hasActiveSearch()).toBe(true);
    run.newer.resolve([run.newerResult]); await run.newerSearch;
    expect(run.useRoutingStore.getState().results).toEqual([run.newerResult]);
  } finally { await run.cleanup(); }
});

it("does not repopulate cleared routing state from pending requests", async () => {
  const run = await overlappingRoutingSearches();
  try {
    run.useRoutingStore.getState().clear();
    const loadingAfterClear = run.useRoutingStore.getState().loading;
    run.older.resolve([run.olderResult]); run.newer.resolve([run.newerResult]);
    await Promise.all([run.olderSearch, run.newerSearch]);
    expect(run.useRoutingStore.getState().results).toEqual([]);
    expect(loadingAfterClear).toBe(false);
  } finally { await run.cleanup(); }
});

it("still publishes the current request's failure after an older success", async () => {
  const run = await overlappingRoutingSearches();
  try {
    run.older.resolve([run.olderResult]); await run.olderSearch;
    run.newer.reject(new Error("current network")); await run.newerSearch;
    expect(run.useRoutingStore.getState()).toMatchObject({ error: "current network", engineError: null, loading: false });
  } finally { await run.cleanup(); }
});

it("keeps a newer unloaded-index rejection after older searches complete", async () => {
  const run = await overlappingRoutingSearches();
  const { useGtfsDataStore } = await import("../../src/stores/gtfsDataStore.ts");
  try {
    useGtfsDataStore.setState({ raptorIndex: null });
    await run.useRoutingStore.getState().search(
      { kind: "mappoint", lat: 54.68, lon: 25.28 },
      { kind: "mappoint", lat: 54.69, lon: 25.28 }, new Date("2026-04-13T08:03:00Z"),
    );
    run.older.resolve([run.olderResult]); run.newer.resolve([run.newerResult]);
    await Promise.all([run.olderSearch, run.newerSearch]);
    expect(run.useRoutingStore.getState().results).toEqual([]);
    expect(run.useRoutingStore.getState().error).toMatch(/GTFS data not loaded/);
  } finally { await run.cleanup(); }
});

it.each(["invalidated completion", "stale rejection", "wasm rejection"])("finishes loading when the current city data becomes stale: %s", async (mode) => {
  const run = await overlappingRoutingSearches();
  const { invalidateCityData, StaleCityDataError } = await import("../../src/services/cityData.ts");
  const { StaleWasmInitError } = await import("../../src/services/raptorWasm.ts");
  const { api } = await import("../../src/services/api.ts");
  vi.mocked(api.plan).mockClear();
  const success = vi.fn();
  const completion = run.newerSearch.then(success);
  const reason = mode === "wasm rejection" ? new StaleWasmInitError("active stale WASM") : new StaleCityDataError();
  try {
    if (mode === "invalidated completion") invalidateCityData();
    run.older.resolve([run.olderResult]); await run.olderSearch;
    // An obsolete request must not finish the newer request's loading first.
    expect(run.useRoutingStore.getState().loading).toBe(true);
    if (mode === "invalidated completion") run.newer.resolve([run.newerResult]);
    else run.newer.reject(reason);
    await expect(completion).rejects.toBeInstanceOf(StaleWasmInitError);
    if (mode === "wasm rejection") await expect(completion).rejects.toBe(reason);
    expect(success).not.toHaveBeenCalled();
    expect(run.useRoutingStore.getState()).toMatchObject({
      loading: false, results: [], error: null, engineError: null, engineFailureKind: null,
    });
    expect(api.plan).not.toHaveBeenCalled();
  } finally { await run.cleanup(); }
});
