import { expect, it } from "vitest";
import { findDirectJourneyCandidate } from "./directJourneyCandidate.ts";
import type { RaptorIndex, RaptorIndexRoute } from "./raptorIndex.ts";

const makeRoute = (id: string, arrival: number): RaptorIndexRoute => ({
  id, shortName: id, mode: "BUS", stopIds: ["origin", "destination"],
  trips: [{ tripId: id + "-trip", serviceId: "weekday", headsign: "Destination",
    departureSecs: [36_300, arrival], dwellSecs: [0, 30] }],
});

it("finds an alternate exact direct trip using the door-arrival deadline and route exclusions", () => {
  const routes = [makeRoute("best", 37_200), makeRoute("backup", 37_100), makeRoute("overrun", 37_201)];
  const index: RaptorIndex = {
    routes, patterns: routes, patternsAtStop: new Map([["origin", [0, 1, 2]]]),
    routeIdToIdx: new Map(), routesAtStop: new Map(),
    services: new Map([["weekday", { serviceId: "weekday", days: Array(7).fill(true),
      startDate: "20261101", endDate: "20261130", exceptions: {} }]]),
  };
  const input = {
    index, entry: [{ stopId: "origin", walkSecs: 300 }], exit: [{ stopId: "destination", walkSecs: 30 }],
    departureMs: Date.parse("2026-11-20T10:00:00Z"), deadlineMs: Date.parse("2026-11-20T10:20:00Z"),
    excludedModes: new Set<"BUS">(), feedTz: "UTC", wheelchair: false,
  };
  expect(findDirectJourneyCandidate({ ...input, excludedRoutes: new Set() })).toEqual({
    routeId: "best", tripId: "best-trip", boardStopId: "origin", alightStopId: "destination",
  });
  expect(findDirectJourneyCandidate({ ...input, excludedRoutes: new Set(["best"]) })?.tripId).toBe("backup-trip");
  expect(findDirectJourneyCandidate({
    ...input, excludedRoutes: new Set(), departureMs: input.departureMs + 1000,
  })).toBeUndefined();
});
