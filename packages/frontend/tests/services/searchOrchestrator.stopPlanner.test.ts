// packages/frontend/tests/services/searchOrchestrator.stopPlanner.test.ts
import { describe, it, expect, vi } from "vitest";
import { SearchOrchestrator, type SearchConfig } from "../../src/services/searchOrchestrator.ts";
import type { RaptorIndex } from "../../src/services/raptorIndex.ts";

vi.mock("../../src/services/isochrone.ts", () => ({ findReachableStops: vi.fn() }));
import { findReachableStops } from "../../src/services/isochrone.ts";
// Mock the on-device plan path so we can assert the remote (stopPlanner) path
// bypasses it (the remote planner is authoritative).
vi.mock("../../src/services/wasmPlanner.ts", () => ({ planOnDevice: vi.fn(async () => []), resolveDepartureOnDevice: vi.fn() }));
import { planOnDevice } from "../../src/services/wasmPlanner.ts";

const index: RaptorIndex = {
  routes: [], routeIdToIdx: new Map(), routesAtStop: new Map(),
  services: new Map([["svc1", { serviceId: "svc1", days: [true,true,true,true,true,true,true], startDate: "20260101", endDate: "20271231", exceptions: {} }]]),
} as unknown as RaptorIndex;
const allStops = [{ id: "S1", name: "S1", lat: 54.68, lon: 25.28 }];

describe("SearchOrchestrator stopPlanner injection", () => {
  it("uses the injected stopPlanner instead of on-device dispatch, and composes its result", async () => {
    vi.mocked(findReachableStops).mockReset().mockResolvedValue([{ stopId: "S1", walkSecs: 0, distanceMeters: 0 }]);
    const stopPlanner = vi.fn(async () => [{ legs: [], boardSecs: 100, alightSecs: 200, transfers: 0 }]);
    const config: SearchConfig = {
      raptorIndex: index, allStops, getDelay: () => null,
      osrm: { isReady: () => false, table: vi.fn(), init: vi.fn() } as never,
      stopPlanner,
    };
    const results = await new SearchOrchestrator(config).search({
      origin: { lat: 54.68, lon: 25.28 }, destination: { lat: 54.70, lon: 25.28 },
      departureTime: new Date(2026, 2, 30, 8, 0, 0), ranking: "fastest",
    });
    expect(stopPlanner).toHaveBeenCalledTimes(1);
    expect(Array.isArray(results)).toBe(true);
  });

  // The remote planner is authoritative: when `stopPlanner` is injected, the
  // orchestrator must NOT touch the on-device `planOnDevice` (it uses the
  // injected planner instead).
  it("skips on-device planOnDevice when stopPlanner is injected", async () => {
    vi.mocked(findReachableStops).mockReset().mockResolvedValue([{ stopId: "S1", walkSecs: 0, distanceMeters: 0 }]);
    vi.mocked(planOnDevice).mockClear();
    const stopPlanner = vi.fn(async () => [{ legs: [], boardSecs: 100, alightSecs: 200, transfers: 0 }]);
    const config: SearchConfig = {
      raptorIndex: index, allStops, getDelay: () => null,
      osrm: { isReady: () => false, table: vi.fn(), init: vi.fn() } as never,
      stopPlanner,
    };
    await new SearchOrchestrator(config).search({
      origin: { lat: 54.68, lon: 25.28 }, destination: { lat: 54.70, lon: 25.28 },
      departureTime: new Date(2026, 2, 30, 8, 0, 0), ranking: "fastest",
    });
    expect(stopPlanner).toHaveBeenCalledTimes(1);
    expect(planOnDevice).not.toHaveBeenCalled();
  });
});
