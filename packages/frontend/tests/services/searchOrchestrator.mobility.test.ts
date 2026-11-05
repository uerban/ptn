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

import { SearchOrchestrator, type SearchConfig } from "../../src/services/searchOrchestrator.ts";
import { findReachableStops } from "../../src/services/isochrone.ts";
import { planOnDevice } from "../../src/services/wasmPlanner.ts";
import type { RaptorIndex } from "../../src/services/raptorIndex.ts";

const index: RaptorIndex = {
  routes: [],
  routeIdToIdx: new Map(),
  routesAtStop: new Map(),
  services: new Map([
    [
      "svc1",
      {
        serviceId: "svc1",
        days: [true, true, true, true, true, true, true],
        startDate: "20260101",
        endDate: "20271231",
        exceptions: {},
      },
    ],
  ]),
};

const allStops = [{ id: "S1", name: "S1", lat: 54.68, lon: 25.28 }];

describe("SearchOrchestrator — mobilityProfile forwarding", () => {
  beforeEach(() => {
    vi.mocked(findReachableStops).mockReset().mockResolvedValue([
      { stopId: "S1", walkSecs: 0, distanceMeters: 0 },
    ]);
    vi.mocked(planOnDevice).mockReset().mockResolvedValue([]);
  });

  it("passes mobilityProfile to findReachableStops for both origin and destination", async () => {
    const origin = { lat: 54.68, lon: 25.28 };
    const destination = { lat: 54.70, lon: 25.28 };
    const config: SearchConfig = {
      raptorIndex: index,
      allStops,
      getDelay: () => null,
      osrm: { isReady: () => false, table: vi.fn(), init: vi.fn() } as never,
      mobilityProfile: "wheelchair",
    };

    await new SearchOrchestrator(config).search({
      origin,
      destination,
      departureTime: new Date(2026, 2, 30, 8, 0, 0),
      ranking: "fastest",
    });

    expect(findReachableStops).toHaveBeenCalledTimes(2);
    expect(findReachableStops).toHaveBeenNthCalledWith(
      1,
      origin,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "wheelchair",
    );
    expect(findReachableStops).toHaveBeenNthCalledWith(
      2,
      destination,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "wheelchair",
    );
  });

  it("passes mobilityProfile into the RAPTOR query", async () => {
    const config: SearchConfig = {
      raptorIndex: index,
      allStops,
      getDelay: () => null,
      osrm: { isReady: () => false, table: vi.fn(), init: vi.fn() } as never,
      mobilityProfile: "wheelchair",
    };

    await new SearchOrchestrator(config).search({
      origin: { lat: 54.68, lon: 25.28 },
      destination: { lat: 54.70, lon: 25.28 },
      departureTime: new Date(2026, 2, 30, 8, 0, 0),
      ranking: "fastest",
    });

    const [raptorQuery] = vi.mocked(planOnDevice).mock.calls[0];
    expect(raptorQuery.mobilityProfile).toBe("wheelchair");
  });

  it.each([
    ["default", 1.5, 1.5],
    ["vision_impaired", 3.5 / 3.6, 3.5 / 3.6],
    ["bicycle", 1.0, 1.0],
    // The reach search walks a wheelchair rider at the wheelchair speed;
    // the transfer walks follow it.
    ["wheelchair", 0.75, 0.8],
  ] as const)("sends the %s rider's walking speed and minimum transfer to the engine", async (profile, speed, expected) => {
    const config: SearchConfig = {
      raptorIndex: index,
      allStops,
      getDelay: () => null,
      osrm: { isReady: () => false, table: vi.fn(), init: vi.fn() } as never,
      mobilityProfile: profile,
      walkSpeedMps: speed,
    };
    await new SearchOrchestrator(config).search({
      origin: { lat: 54.68, lon: 25.28 },
      destination: { lat: 54.70, lon: 25.28 },
      departureTime: new Date(2026, 2, 30, 8, 0, 0),
      ranking: "fastest",
    });
    const [raptorQuery] = vi.mocked(planOnDevice).mock.calls[0];
    expect(raptorQuery.walkSpeedMps).toBe(expected);
    expect(raptorQuery.minTransferSecs).toBe(120);
  });

  // (The "forwards mobilityProfile to backend-assist plan on RAPTOR-empty fallback" test was
  // removed with the silent backend-assist auto-fire — see searchOrchestrator.noAutoAssist.test.ts
  // and.)

  it("omits mobilityProfile when the caller did not supply one", async () => {
    const config: SearchConfig = {
      raptorIndex: index,
      allStops,
      getDelay: () => null,
      osrm: { isReady: () => false, table: vi.fn(), init: vi.fn() } as never,
    };

    await new SearchOrchestrator(config).search({
      origin: { lat: 54.68, lon: 25.28 },
      destination: { lat: 54.70, lon: 25.28 },
      departureTime: new Date(2026, 2, 30, 8, 0, 0),
      ranking: "fastest",
    });

    expect(findReachableStops).toHaveBeenCalledTimes(2);
    expect(findReachableStops).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
    );
    expect(findReachableStops).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });
});
