import { describe, it, expect } from "vitest";
import type { RaptorTransitLeg } from "@pt/shared";
import {
  resolveTransitLegDisplay,
  type RouteDisplay,
  type TripDisplay,
} from "../../src/services/legEnrichment.ts";

function transitLeg(overrides: Partial<RaptorTransitLeg> = {}): RaptorTransitLeg {
  return {
    type: "transit",
    fromStopId: "S1",
    toStopId: "S2",
    departSecs: 100,
    arriveSecs: 200,
    routeId: "R1",
    tripId: "T1",
    boardStopIdx: 0,
    alightStopIdx: 1,
    ...overrides,
  };
}

const routes: ReadonlyMap<string, RouteDisplay> = new Map([
  ["R1", { shortName: "42", color: "00AA88" }],
]);
const trips: ReadonlyMap<string, TripDisplay> = new Map([
  ["T1", { headsign: "Downtown" }],
]);

describe("resolveTransitLegDisplay", () => {
  it("backfills route name / colour / headsign from the DB maps when the leg omits them (the pt-serve /plan wire shape)", () => {
    // pt-serve legs carry only routeId/tripId — no routeShortName/routeColor/headsign.
    const leg = transitLeg();
    expect(resolveTransitLegDisplay(leg, routes, trips)).toEqual({
      routeShortName: "42",
      routeColor: "00AA88",
      headsign: "Downtown",
    });
  });

  it("prefers the leg's own values over the DB maps (on-device engine legs are pre-enriched)", () => {
    const leg = transitLeg({
      routeShortName: "ON_LEG",
      routeColor: "FFFFFF",
      headsign: "On-leg headsign",
    });
    expect(resolveTransitLegDisplay(leg, routes, trips)).toEqual({
      routeShortName: "ON_LEG",
      routeColor: "FFFFFF",
      headsign: "On-leg headsign",
    });
  });

  it("fills only the absent fields (partial enrichment)", () => {
    const leg = transitLeg({ routeShortName: "ON_LEG" });
    expect(resolveTransitLegDisplay(leg, routes, trips)).toEqual({
      routeShortName: "ON_LEG", // kept from the leg
      routeColor: "00AA88", // backfilled
      headsign: "Downtown", // backfilled
    });
  });

  it("yields undefined (no throw) when the route/trip is missing from the maps", () => {
    const leg = transitLeg({ routeId: "MISSING", tripId: "MISSING" });
    expect(resolveTransitLegDisplay(leg, routes, trips)).toEqual({
      routeShortName: undefined,
      routeColor: undefined,
      headsign: undefined,
    });
  });
});
