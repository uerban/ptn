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
    ...input, excludedRoutes: new Set(), isTripUnavailable: tripId => tripId === "best-trip",
  })?.tripId).toBe("backup-trip");
  expect(findDirectJourneyCandidate({
    ...input, excludedRoutes: new Set(), departureMs: input.departureMs + 1000,
  })).toBeUndefined();
});

it.each([
  { departure: "2026-11-21T00:05:00Z", deadline: "2026-11-21T00:30:00Z", board: 87_000, arrival: 88_200,
    serviceDate: "20261120" },
  { departure: "2026-11-20T23:55:00Z", deadline: "2026-11-21T00:30:00Z", board: 600, arrival: 1_800,
    serviceDate: "20261121" },
])("finds a direct option across the service-day boundary for $departure", ({ departure, deadline, board, arrival, serviceDate }) => {
  const route = makeRoute("overnight", arrival);
  route.trips[0].departureSecs[0] = board;
  const index: RaptorIndex = {
    routes: [route], patterns: [route], patternsAtStop: new Map([["origin", [0]]]),
    routeIdToIdx: new Map(), routesAtStop: new Map(),
    services: new Map([["weekday", { serviceId: "weekday", days: Array(7).fill(true),
      startDate: serviceDate, endDate: serviceDate, exceptions: {} }]]),
  };
  const input = {
    index, entry: [{ stopId: "origin", walkSecs: 60 }], exit: [{ stopId: "destination", walkSecs: 30 }],
    departureMs: Date.parse(departure), deadlineMs: Date.parse(deadline),
    excludedRoutes: new Set<string>(), excludedModes: new Set<"BUS">(), feedTz: "UTC", wheelchair: false,
  };
  expect(findDirectJourneyCandidate(input)?.tripId).toBe("overnight-trip");
  expect(findDirectJourneyCandidate({ ...input, deadlineMs: input.deadlineMs - 1000 })).toBeUndefined();
});
