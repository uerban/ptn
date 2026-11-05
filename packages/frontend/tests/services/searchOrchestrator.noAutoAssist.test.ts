import { describe, it, expect, vi } from "vitest";

// Deterministic stand-in for the on-device `pt-wasm` plan step (see
// `stubOnDevicePlanner.ts`) — this test owns the host rule, not the routing.
vi.mock("../../src/services/wasmPlanner.ts", () => ({ planOnDevice: vi.fn(), resolveDepartureOnDevice: vi.fn(async (unix: number) => {
    const d = new Date(unix * 1000);
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    return { serviceDate: ymd, timeOriginUnix: 0, departureSecs: d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() };
  }) }));

import { SearchOrchestrator, type SearchConfig } from "../../src/services/searchOrchestrator.ts";
import { planOnDevice } from "../../src/services/wasmPlanner.ts";
import type { RaptorIndex } from "../../src/services/raptorIndex.ts";
import { planFromIndex } from "./stubOnDevicePlanner.ts";
import type { LatLon } from "@pt/shared";

// On-device routing failure UX (S1): an empty on-device RAPTOR result must NEVER auto-fire a server
// query. The `backendAssist.plan` transport is kept in `SearchConfig` for S2 (explicit user
// consent), but `search()` must not invoke it silently. An empty on-device result returns `[]`.

// Index with an active service but a trip whose departures (~01:00) are all in
// the past for an 08:00 query, so on-device RAPTOR returns []. The empty-
// services guard passes (service is active), so the orchestrator runs RAPTOR
// and gets nothing — the point at which the OLD code would have auto-fired
// backend-assist.
function buildNoMatchIndex(): RaptorIndex {
  const routes = [
    {
      id: "R1", shortName: "1", mode: "BUS" as const,
      stopIds: ["S1", "S2", "S3"],
      trips: [
        { tripId: "T_PAST", serviceId: "svc1", headsign: "Past", departureSecs: [3600, 4200, 4800] },
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

// Origin near S1, destination near S3 (≥2km from S2, outside the 800m radius),
// so the radius fallback yields entryStops=[S1], exitStops=[S3] — real entry/exit
// stops with an empty RAPTOR result, the exact precondition for the removed
// auto-fire block.
const allStops = [
  { id: "S1", name: "Stop A", lat: 54.6800, lon: 25.2797 },
  { id: "S2", name: "Stop B", lat: 54.7000, lon: 25.2797 },
  { id: "S3", name: "Stop C", lat: 54.7200, lon: 25.2797 },
];
const origin: LatLon = { lat: 54.6800, lon: 25.2797 };
const destination: LatLon = { lat: 54.7200, lon: 25.2797 };

describe("SearchOrchestrator — no silent backend-assist auto-fire (S1)", () => {
  it("does NOT call backendAssist.plan and returns [] when on-device RAPTOR is empty", async () => {
    const plan = vi.fn();
    const index = buildNoMatchIndex();
    vi.mocked(planOnDevice).mockReset().mockImplementation(async (q) => planFromIndex(index, q));
    const config: SearchConfig = {
      raptorIndex: index,
      allStops,
      getDelay: () => null,
      osrm: { isReady: () => false, table: vi.fn(), init: vi.fn() } as any,
      // enabled:true with a spy plan — the OLD code would silently fire this.
      backendAssist: { enabled: true, plan },
    };

    const results = await new SearchOrchestrator(config).search({
      origin,
      destination,
      departureTime: new Date(2026, 2, 30, 8, 0, 0), // Mon 08:00
      ranking: "fastest",
    });

    expect(plan).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });
});
