// `reachableStops` is the entry/exit resolution `search` plans from, exposed
// for the opt-in arrive-by experiment. Both must give the same stops.
import { describe, it, expect, vi } from "vitest";
import type { RaptorQuery } from "@pt/shared";
import { SearchOrchestrator, type SearchConfig } from "../../src/services/searchOrchestrator.ts";
import type { RaptorIndex } from "../../src/services/raptorIndex.ts";

vi.mock("../../src/services/wasmPlanner.ts", () => ({ planOnDevice: vi.fn(async () => []), resolveDepartureOnDevice: vi.fn() }));

const index: RaptorIndex = {
  routes: [], routeIdToIdx: new Map(), routesAtStop: new Map(),
  services: new Map([["svc1", { serviceId: "svc1", days: [true, true, true, true, true, true, true], startDate: "20260101", endDate: "20271231", exceptions: {} }]]),
} as unknown as RaptorIndex;
const allStops = [
  { id: "S1", name: "S1", lat: 54.6800, lon: 25.2800 },
  { id: "S2", name: "S2", lat: 54.6830, lon: 25.2800 },
  { id: "S3", name: "S3", lat: 54.7000, lon: 25.2800 },
  { id: "S4", name: "S4", lat: 54.7030, lon: 25.2820 },
  { id: "FAR", name: "FAR", lat: 54.9000, lon: 25.2800 },
];
const query = {
  origin: { lat: 54.6801, lon: 25.2801 }, destination: { lat: 54.7001, lon: 25.2801 },
  originStopId: "S1", destStopIds: ["S4"],
};

describe("SearchOrchestrator.reachableStops", () => {
  it("returns the stops search plans from, after the same OSRM wait", async () => {
    let planned: RaptorQuery | null = null;
    const osrm = { isReady: () => false, table: vi.fn(), init: vi.fn(async () => { throw new Error("no osrm"); }) };
    const config: SearchConfig = {
      raptorIndex: index, allStops, getDelay: () => null, cityId: "vilnius", feedTz: "Europe/Vilnius",
      osrm: osrm as never, runToCatch: true,
      stopPlanner: async (q) => { planned = q; return []; },
    };
    const orchestrator = new SearchOrchestrator(config);
    const { entryStops, exitStops } = await orchestrator.reachableStops(query);
    expect(osrm.init).toHaveBeenCalledTimes(1);
    await orchestrator.search({ ...query, departureTime: new Date("2026-10-12T08:00:00+03:00"), ranking: "fastest" });
    expect(osrm.init).toHaveBeenCalledTimes(2);
    expect(planned).not.toBeNull();
    const walks = (stops: { stopId: string; walkSecs: number }[]) => stops.map((s) => ({ stopId: s.stopId, walkSecs: s.walkSecs }));
    expect(walks(entryStops)).toEqual(planned!.entryStops);
    expect(walks(exitStops)).toEqual(planned!.exitStops);
    expect(entryStops.map((s) => s.stopId)).toEqual(["S1", "S2"]);
    expect(exitStops.find((s) => s.stopId === "S4")?.walkSecs).toBe(0);
    expect(entryStops.concat(exitStops).some((s) => s.stopId === "FAR")).toBe(false);
  });
});
