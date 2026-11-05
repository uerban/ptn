import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/isochrone.ts", () => ({
  findReachableStops: vi.fn(),
}));
vi.mock("../../src/services/wasmPlanner.ts", () => ({
  planOnDevice: vi.fn(async () => []),
  resolveDepartureOnDevice: vi.fn(async (unix: number) => {
    const d = new Date(unix * 1000);
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    return { serviceDate: ymd, timeOriginUnix: 0, departureSecs: d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() };
  }),
}));

import type { RaptorItinerary } from "@pt/shared";
import { composeItineraries } from "../../src/services/raptorComposer.ts";
import { SearchOrchestrator, type SearchConfig } from "../../src/services/searchOrchestrator.ts";
import { findReachableStops } from "../../src/services/isochrone.ts";
import { planOnDevice } from "../../src/services/wasmPlanner.ts";
import type { RaptorIndex } from "../../src/services/raptorIndex.ts";

const ride: RaptorItinerary = {
  legs: [
    {
      type: "transit",
      fromStopId: "S1",
      toStopId: "S2",
      departSecs: 29100,
      arriveSecs: 30000,
      routeId: "R1",
      tripId: "T1",
      boardStopIdx: 0,
      alightStopIdx: 1,
    },
  ],
  boardSecs: 29100,
  alightSecs: 30000,
  transfers: 0,
};

describe("composeItineraries — walked metres", () => {
  it("sums the entry and exit distances, whatever speed made the seconds", () => {
    // 400 m + 200 m at 3.5 km/h (0.9722 m/s): 411 s + 206 s.
    const [c] = composeItineraries(
      [ride],
      [{ stopId: "S1", walkSecs: 411, distanceMeters: 400 }],
      [{ stopId: "S2", walkSecs: 206, distanceMeters: 200 }],
      28500,
    );
    expect(c.totalWalkSecs).toBe(617);
    expect(c.totalWalkMeters).toBe(600);
  });

  it("counts a run to catch by its distance, not its shorter time", () => {
    const [c] = composeItineraries(
      [ride],
      [{ stopId: "S1", walkSecs: 160, distanceMeters: 400, runToCatch: true }],
      [{ stopId: "S2", walkSecs: 0, distanceMeters: 0 }],
      28500,
    );
    expect(c.totalWalkMeters).toBe(400);
  });

  it("leaves the metres out when an endpoint has no distance", () => {
    const [c] = composeItineraries(
      [ride],
      [{ stopId: "S1", walkSecs: 300 }],
      [{ stopId: "S2", walkSecs: 0, distanceMeters: 0 }],
      28500,
    );
    expect(c.totalWalkMeters).toBeUndefined();
  });
});

const index: RaptorIndex = {
  routes: [],
  routeIdToIdx: new Map(),
  routesAtStop: new Map(),
  services: new Map([
    ["svc1", { serviceId: "svc1", days: [true, true, true, true, true, true, true], startDate: "20260101", endDate: "20271231", exceptions: {} }],
  ]),
};

describe("SearchOrchestrator — walked metres reach the result", () => {
  beforeEach(() => {
    vi.mocked(findReachableStops)
      .mockReset()
      .mockResolvedValueOnce([{ stopId: "S1", walkSecs: 411, distanceMeters: 400 }])
      .mockResolvedValueOnce([{ stopId: "S2", walkSecs: 206, distanceMeters: 200 }]);
    vi.mocked(planOnDevice).mockReset().mockResolvedValue([ride]);
  });

  it("carries the reach search's distances into the composed itinerary", async () => {
    const config: SearchConfig = {
      raptorIndex: index,
      allStops: [
        { id: "S1", name: "S1", lat: 54.68, lon: 25.28 },
        { id: "S2", name: "S2", lat: 54.7, lon: 25.28 },
      ],
      getDelay: () => null,
      osrm: { isReady: () => false, table: vi.fn(), init: vi.fn() } as never,
      walkSpeedMps: 3.5 / 3.6,
      mobilityProfile: "vision_impaired",
    };
    const [result] = await new SearchOrchestrator(config).search({
      origin: { lat: 54.676, lon: 25.28 },
      destination: { lat: 54.702, lon: 25.28 },
      departureTime: new Date(2026, 2, 30, 7, 55, 0),
      ranking: "fastest",
    });
    expect(result.totalWalkSecs).toBe(617);
    expect(result.totalWalkMeters).toBe(600);
  });
});
