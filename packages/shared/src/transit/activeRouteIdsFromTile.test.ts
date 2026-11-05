import { describe, it, expect } from "vitest";
import { activeRouteIdsFromTile } from "./activeRouteIdsFromTile.js";
import { getDeparturesFromTile } from "./getDeparturesFromTile.js";
import type { DecodedScheduleTile } from "../types/scheduleTile.js";

// Minimal hand-built tile: stop "S" served by route R1 (dep 12:05) and R2 (dep 23:30).
// now = 12:00, lookahead 2h => only R1 is in-window.
function tile(): DecodedScheduleTile {
  const ALL_DAYS = [true, true, true, true, true, true, true] as const;
  return {
    bundleHash: "h", cityId: "test", tileSize: 6000,
    stringTable: ["t1", "t2", "R1 head", "R2 head"],
    routes: [
      { id: "R1", shortName: "1", longName: "", mode: "BUS" },
      { id: "R2", shortName: "2", longName: "", mode: "BUS" },
    ],
    calendar: [
      { serviceId: "svc", days: ALL_DAYS, startDate: "20260101", endDate: "20271231", added: [], removed: [] },
    ],
    trips: [
      { tripIdIx: 0, routeIx: 0, serviceIx: 0, headsignIx: 2 },
      { tripIdIx: 1, routeIx: 1, serviceIx: 0, headsignIx: 3 },
    ],
    stops: {
      S: {
        tripIxs: Uint32Array.from([0, 1]),
        departureSecs: Uint32Array.from([12 * 3600 + 5 * 60, 23 * 3600 + 30 * 60]),
      },
    },
  };
}

// Use local-time constructor (same pattern as getDeparturesFromTile.test.ts) so that
// `departureSecs` are correctly framed against local midnight regardless of host timezone.
// R1 departs at local 12:05 (inside [12:00, 14:00]), R2 at local 23:30 (outside).
describe("activeRouteIdsFromTile", () => {
  it("returns only routes with an in-window departure at the stop", () => {
    const now = new Date(2026, 5, 16, 12, 0, 0); // local 12:00
    const ids = activeRouteIdsFromTile({ tile: tile(), stopId: "S", now, lookAheadHours: 2 });
    expect([...ids].sort()).toEqual(["R1"]);
  });

  it("returns empty for an unknown stop", () => {
    const now = new Date(2026, 5, 16, 12, 0, 0); // local 12:00
    expect(activeRouteIdsFromTile({ tile: tile(), stopId: "nope", now, lookAheadHours: 2 }).size).toBe(0);
  });

  it("never drops a route the sheet shows (consistency with getDeparturesFromTile)", () => {
    const now = new Date(2026, 5, 16, 12, 0, 0); // local 12:00
    const ids = activeRouteIdsFromTile({ tile: tile(), stopId: "S", now, lookAheadHours: 2 });
    const sheet = getDeparturesFromTile({ tile: tile(), stopId: "S", now, limit: 1000, lookAheadHours: 2 });
    expect(ids).toEqual(new Set(sheet.departures.map((d) => d.routeId)));
  });
});
