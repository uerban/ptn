import { describe, it, expect, beforeEach, vi } from "vitest";
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

describe("useRoutingStore.search", () => {
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
