import { describe, it, expect, vi } from "vitest";

// The on-device plan step is `pt-wasm`, whose routing correctness is pinned by
// the engine's own corpus/goldens. These tests own the orchestrator TAIL
// (service-day resolution → stop resolution → plan → compose → RT overlay →
// rank), so the plan step is a deterministic stub. See `stubOnDevicePlanner.ts`.
// `resolveDepartureOnDevice` stands in for `PtRouter.resolveTime`; its default
// is the civil-date frame of a non-DST date.
vi.mock("../../src/services/wasmPlanner.ts", () => ({
  planOnDevice: vi.fn(),
  resolveDepartureOnDevice: vi.fn(async (unix: number) => {
  const d = new Date(unix * 1000);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return { serviceDate: ymd, timeOriginUnix: 0, departureSecs: d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() };
} ),
}));

import { SearchOrchestrator, type SearchConfig } from "../../src/services/searchOrchestrator.ts";
import { planOnDevice, resolveDepartureOnDevice } from "../../src/services/wasmPlanner.ts";
import type { RaptorIndex } from "../../src/services/raptorIndex.ts";
import { planFromIndex } from "./stubOnDevicePlanner.ts";

/** Point `planOnDevice` at `index` for the duration of one test, and return
 *  the index so it can be dropped straight into the `SearchConfig`. */
function usePlannerOver(index: RaptorIndex): RaptorIndex {
  vi.mocked(planOnDevice).mockReset().mockImplementation(async (query) =>
    planFromIndex(index, query),
  );
  vi.mocked(resolveDepartureOnDevice).mockReset().mockImplementation(async (unix) => {
    const d = new Date(unix * 1000);
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    return { serviceDate: ymd, timeOriginUnix: 0, departureSecs: d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() };
  });
  return index;
}

function buildMinimalIndex(): RaptorIndex {
  const routes = [
    {
      id: "R1", shortName: "1", mode: "BUS" as const,
      stopIds: ["S1", "S2", "S3"],
      trips: [
        { tripId: "T1", serviceId: "svc1", headsign: "Centre", departureSecs: [28800, 29400, 30000] },
      ],
    },
  ];
  return {
    routes,
    routeIdToIdx: new Map([["R1", 0]]),
    routesAtStop: new Map([["S1", [0]], ["S2", [0]], ["S3", [0]]]),
    services: new Map([
      ["svc1", { serviceId: "svc1", days: [true, true, true, true, true, true, true], startDate: "20260101", endDate: "20271231", exceptions: {} }],
    ]),
  };
}

// Stops spread far enough apart so origin is near S1, destination is near S3,
// and they don't overlap within the 800m fallback radius.
// S1 -> S2 ~2.2km, S2 -> S3 ~2.2km
const allStops = [
  { id: "S1", name: "Stop A", lat: 54.6800, lon: 25.2797 },
  { id: "S2", name: "Stop B", lat: 54.7000, lon: 25.2797 },
  { id: "S3", name: "Stop C", lat: 54.7200, lon: 25.2797 },
];

describe("SearchOrchestrator", () => {
  it("returns composed itineraries for a valid query", async () => {
    const config: SearchConfig = {
      raptorIndex: usePlannerOver(buildMinimalIndex()),
      allStops,
      getDelay: () => null,
      osrm: { isReady: () => false, table: vi.fn(), init: vi.fn() } as any,
    };

    const orchestrator = new SearchOrchestrator(config);

    const results = await orchestrator.search({
      origin: { lat: 54.6800, lon: 25.2797 },      // near S1
      destination: { lat: 54.7200, lon: 25.2797 },  // near S3
      departureTime: new Date(2026, 2, 30, 7, 55, 0), // Mon 07:55
      ranking: "fastest",
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].totalSecs).toBeGreaterThan(0);
    expect(results[0].legs.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty when no transit path exists", async () => {
    const config: SearchConfig = {
      raptorIndex: usePlannerOver(buildMinimalIndex()),
      allStops,
      getDelay: () => null,
      osrm: { isReady: () => false, table: vi.fn(), init: vi.fn() } as any,
    };

    const orchestrator = new SearchOrchestrator(config);

    // Origin and destination far from any stops
    const results = await orchestrator.search({
      origin: { lat: 0, lon: 0 },
      destination: { lat: 1, lon: 1 },
      departureTime: new Date(2026, 2, 30, 8, 0, 0),
      ranking: "fastest",
    });

    expect(results).toHaveLength(0);
  });

  it("applies RT overlay to results", async () => {
    const getDelay = (tripId: string) =>
      tripId === "T1" ? { delaySeconds: 120, cancelled: false } : null;

    const config: SearchConfig = {
      raptorIndex: usePlannerOver(buildMinimalIndex()),
      allStops,
      getDelay,
      osrm: { isReady: () => false, table: vi.fn(), init: vi.fn() } as any,
    };

    const orchestrator = new SearchOrchestrator(config);

    const results = await orchestrator.search({
      origin: { lat: 54.6800, lon: 25.2797 },      // near S1
      destination: { lat: 54.7200, lon: 25.2797 },  // near S3
      departureTime: new Date(2026, 2, 30, 7, 55, 0),
      ranking: "fastest",
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    // RT delay should shift the transit legs
    const transitLeg = results[0].legs.find((l) => l.tripId === "T1");
    expect(transitLeg).toBeDefined();
    expect(transitLeg!.departSecs).toBe(28800 + 120); // shifted by 120s
  });
});

describe("SearchOrchestrator — service-day time (PTB v2 contract)", () => {
  // Trip whose GTFS times run past midnight (>= 86400) on its own service day.
  function buildOvernightIndex(): RaptorIndex {
    return {
      routes: [
        {
          id: "R_NIGHT", shortName: "N1", mode: "BUS" as const,
          stopIds: ["S1", "S2", "S3"],
          trips: [
            { tripId: "T_NIGHT", serviceId: "svcNight", headsign: "Night", departureSecs: [86400, 87000, 87600] },
          ],
        },
      ],
      routeIdToIdx: new Map([["R_NIGHT", 0]]),
      routesAtStop: new Map([["S1", [0]], ["S2", [0]], ["S3", [0]]]),
      services: new Map([
        ["svcNight", { serviceId: "svcNight", days: [true, true, true, true, true, true, true], startDate: "20260101", endDate: "20271231", exceptions: {} }],
      ]),
    };
  }

  const searchConfig = (index: RaptorIndex): SearchConfig => ({
    raptorIndex: usePlannerOver(index),
    allStops,
    getDelay: () => null,
    osrm: { isReady: () => false, table: vi.fn(), init: vi.fn() } as any,
  });

  it("plans once, in the service day and GTFS Time that the bundle resolved", async () => {
    // Spring-forward date: 00:30 wall clock is GTFS 01:30 (5400 s) of 2026-03-29.
    // The orchestrator must hand the engine the resolved frame, not 1800 s.
    const orchestrator = new SearchOrchestrator(searchConfig(buildOvernightIndex()));
    vi.mocked(resolveDepartureOnDevice).mockReset().mockResolvedValue({
      serviceDate: "20260329", timeOriginUnix: 0, departureSecs: 5400,
    });
    await orchestrator.search({
      origin: { lat: 54.6800, lon: 25.2797 },
      destination: { lat: 54.7200, lon: 25.2797 },
      departureTime: new Date(2026, 2, 29, 0, 30, 0),
      ranking: "fastest",
    });
    expect(planOnDevice).toHaveBeenCalledTimes(1);
    const [query, , date] = vi.mocked(planOnDevice).mock.calls[0]!;
    expect(date).toBe("20260329");
    expect(query.departureSecs).toBe(5400);
  });

  it("does not short-circuit an early-morning query whose calendar day has no services", async () => {
    // Only a Sunday service exists, and the search is Monday 00:30. The engine
    // scans the service days its horizon reaches, so the orchestrator must still
    // plan rather than return [] on an empty current-day set.
    const index = buildOvernightIndex();
    index.services = new Map([
      ["svcNight", { serviceId: "svcNight", days: [false, false, false, false, false, false, true], startDate: "20260101", endDate: "20271231", exceptions: {} }],
    ]);
    index.routes[0]!.trips[0]!.serviceId = "svcNight";
    const orchestrator = new SearchOrchestrator(searchConfig(index));
    await orchestrator.search({
      origin: { lat: 54.6800, lon: 25.2797 },
      destination: { lat: 54.7200, lon: 25.2797 },
      departureTime: new Date(2026, 2, 30, 0, 30, 0),
      ranking: "fastest",
    });
    expect(planOnDevice).toHaveBeenCalledTimes(1);
  });

  it("returns the engine's overnight itinerary in the query's frame, with no re-run", async () => {
    const orchestrator = new SearchOrchestrator(searchConfig(buildOvernightIndex()));
    const results = await orchestrator.search({
      origin: { lat: 54.6800, lon: 25.2797 },
      destination: { lat: 54.7200, lon: 25.2797 },
      departureTime: new Date(2026, 2, 30, 23, 30, 0),
      ranking: "fastest",
    });
    expect(planOnDevice).toHaveBeenCalledTimes(1);
    const transitLeg = results[0]?.legs.find((l) => l.tripId === "T_NIGHT");
    expect(transitLeg).toBeDefined();
    // Times stay in the service-day frame (past 86400), never rewritten by a fallback.
    expect(transitLeg!.departSecs).toBe(86400);
  });
});

describe("SearchOrchestrator — run-to-catch access", () => {
  // Radius fallback: 300 m at walking pace, 600 m at a run (2 × 1.25 m/s).
  const base = {
    allStops,
    getDelay: () => null,
    osrm: { isReady: () => false, table: vi.fn(), init: vi.fn() } as any,
    walkSpeedMps: 1.25,
    fallbackRadiusMeters: 300,
    runToCatch: true,
  };
  const query = (originLat: number) => ({
    origin: { lat: originLat, lon: 25.2797 },
    destination: { lat: 54.7200, lon: 25.2797 }, // at S3
    departureTime: new Date(2026, 2, 30, 7, 55, 0),
    ranking: "fastest" as const,
  });

  it("marks an itinerary that boards at a stop only a run reaches", async () => {
    const orchestrator = new SearchOrchestrator({ ...base, raptorIndex: usePlannerOver(buildMinimalIndex()) });
    // ~450 m south of S1: outside the walk radius, inside the run radius.
    const results = await orchestrator.search(query(54.6760));
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].sourceRunToCatch).toBe(true);
  });

  it("leaves an itinerary boarding within walking reach unmarked", async () => {
    const orchestrator = new SearchOrchestrator({ ...base, raptorIndex: usePlannerOver(buildMinimalIndex()) });
    const results = await orchestrator.search(query(54.6799));
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].sourceRunToCatch).toBeFalsy();
  });
});
