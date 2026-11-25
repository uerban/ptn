import { expect, it } from "vitest";
import { branchDepartureWarning } from "../../src/services/branchDepartureWarning.ts";
import type { RaptorIndex, RaptorIndexRoute } from "../../src/services/raptorIndex.ts";
import { makeMixedItinerary } from "../helpers/makeItinerary.ts";

it("warns only when an exact nearby trip at the same platform and direction skips the planned stop", () => {
  const planned = { ...makeMixedItinerary().legs[0], headsign: "Vaduvos", routeId: "R", tripId: "primary" };
  const pattern = (tripId: string, directionId: 0 | 1, stopIds: string[]): RaptorIndexRoute => ({
    id: "R", shortName: "123", mode: "BUS", stopIds,
    trips: [{ tripId, directionId, serviceId: "daily", headsign: tripId, departureSecs: [10, 20] }],
  });
  const primaryPattern = pattern("primary", 1, ["s1", "s2"]);
  const branch = pattern("branch", 1, ["s1", "s3"]);
  const index: RaptorIndex = {
    routes: [], routesAtStop: new Map(), routeIdToIdx: new Map(), services: new Map(),
    patterns: [primaryPattern, branch], patternsAtStop: new Map([["s1", [0, 1]]]),
  };
  const next = {
    tripId: "branch", headsign: "Riovonys", routeShortName: "123", minutesUntil: 19,
    departureMs: Date.parse(planned.departureTime) + 19 * 60_000, isApproximate: false,
  };
  expect(branchDepartureWarning(index, planned, next)).toBe(true);
  expect(branchDepartureWarning(index, planned, { ...next, isApproximate: true })).toBe(false);
  expect(branchDepartureWarning(index, planned, { ...next, departureMs: next.departureMs + 120_000 })).toBe(false);
  branch.trips[0].directionId = 0;
  expect(branchDepartureWarning(index, planned, next)).toBe(false);
  branch.trips[0].directionId = 1;
  branch.stopIds[1] = "s2";
  expect(branchDepartureWarning(index, planned, next)).toBe(false);
});
