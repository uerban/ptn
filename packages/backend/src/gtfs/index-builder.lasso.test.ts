import { describe, it, expect } from "vitest";
import {
  buildRouteTripsIndex,
  UNSERVED_STOP_SENTINEL,
  type TripStopSeqEntry,
} from "./index-builder.js";
import type { GtfsTrip } from "./parser.js";

// Lasso / loop route alignment.
//
// GTFS best-practices model a lasso (Vilnius 6G) as ONE trip whose stop_times
// revisits a stop: stem out → loop → stem back. See
// https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
// (and #loop-routes: "Include the first/last stop twice in stop_times.txt").
// The canonical stop pattern therefore contains repeats, and each repeated
// stop must keep BOTH of its departure times — one per occurrence.

function tripsIndexFor(routeId: string, tripIds: string[]): Map<string, GtfsTrip> {
  return new Map(
    tripIds.map((tripId) => [
      tripId,
      { tripId, routeId, serviceId: "SVC", headsign: "Loop" } as GtfsTrip,
    ]),
  );
}

describe("buildRouteTripsIndex — lasso / loop routes", () => {
  it("serves the outbound stem of a lasso route whose stops are revisited later", () => {
    // 6G-style lasso: stem (T,S,N) → apex (L,P) → stem back (N,S,T).
    // T, S, N each appear twice in the single trip.
    const seq: TripStopSeqEntry[] = [
      { stopId: "T", departureSecs: 0, seq: 1 },
      { stopId: "S", departureSecs: 60, seq: 2 },
      { stopId: "N", departureSecs: 120, seq: 3 },
      { stopId: "L", departureSecs: 180, seq: 4 },
      { stopId: "P", departureSecs: 240, seq: 5 },
      { stopId: "N", departureSecs: 300, seq: 6 },
      { stopId: "S", departureSecs: 360, seq: 7 },
      { stopId: "T", departureSecs: 420, seq: 8 },
    ];
    const routeTrips = buildRouteTripsIndex(
      new Map([["trip1", seq]]),
      tripsIndexFor("6G", ["trip1"]),
    );

    const data = routeTrips.find((r) => r.routeId === "6G")!;
    expect(data.stopIds).toEqual(["T", "S", "N", "L", "P", "N", "S", "T"]);

    const dep = Array.from(data.trips[0]!.departureSecs);
    // Every position served, in stop_seq order — both legs of the lasso.
    expect(dep).toEqual([0, 60, 120, 180, 240, 300, 360, 420]);
    expect(dep).not.toContain(UNSERVED_STOP_SENTINEL);
  });

  it("leaves non-repeated routes unchanged (each stop maps to its single position)", () => {
    // Plain A→B→C→D line, no repeats — regression guard that the fix degrades
    // to the previous single-position behaviour.
    const seq: TripStopSeqEntry[] = [
      { stopId: "A", departureSecs: 0, seq: 1 },
      { stopId: "B", departureSecs: 100, seq: 2 },
      { stopId: "C", departureSecs: 200, seq: 3 },
      { stopId: "D", departureSecs: 300, seq: 4 },
    ];
    const routeTrips = buildRouteTripsIndex(
      new Map([["t", seq]]),
      tripsIndexFor("R", ["t"]),
    );
    const data = routeTrips.find((r) => r.routeId === "R")!;
    expect(data.stopIds).toEqual(["A", "B", "C", "D"]);
    expect(Array.from(data.trips[0]!.departureSecs)).toEqual([0, 100, 200, 300]);
  });

  it("aligns a short variant trip's repeats to its own occurrence order", () => {
    // Canonical (longest) is the full lasso; a short variant skips the apex
    // detour (L,P) but still revisits T,S,N. Its rows must take the next
    // occurrence per stop, not collapse onto the return leg.
    const full: TripStopSeqEntry[] = [
      { stopId: "T", departureSecs: 0, seq: 1 },
      { stopId: "S", departureSecs: 60, seq: 2 },
      { stopId: "N", departureSecs: 120, seq: 3 },
      { stopId: "L", departureSecs: 180, seq: 4 },
      { stopId: "P", departureSecs: 240, seq: 5 },
      { stopId: "N", departureSecs: 300, seq: 6 },
      { stopId: "S", departureSecs: 360, seq: 7 },
      { stopId: "T", departureSecs: 420, seq: 8 },
    ];
    const short: TripStopSeqEntry[] = [
      { stopId: "T", departureSecs: 1000, seq: 1 },
      { stopId: "S", departureSecs: 1060, seq: 2 },
      { stopId: "N", departureSecs: 1120, seq: 3 },
      { stopId: "N", departureSecs: 1180, seq: 4 },
      { stopId: "S", departureSecs: 1240, seq: 5 },
      { stopId: "T", departureSecs: 1300, seq: 6 },
    ];
    const routeTrips = buildRouteTripsIndex(
      new Map([
        ["full", full],
        ["short", short],
      ]),
      tripsIndexFor("6G", ["full", "short"]),
    );
    const data = routeTrips.find((r) => r.routeId === "6G")!;
    expect(data.stopIds).toEqual(["T", "S", "N", "L", "P", "N", "S", "T"]);

    const shortTrip = data.trips.find((t) => t.tripId === "short")!;
    const dep = Array.from(shortTrip.departureSecs);
    const S = UNSERVED_STOP_SENTINEL;
    // outbound T,S,N filled; apex L,P skipped (sentinel); return N,S,T filled.
    expect(dep).toEqual([1000, 1060, 1120, S, S, 1180, 1240, 1300]);
  });

  it("handles a stop visited three times in one trip (hub passed thrice)", () => {
    // Canonical [H,A,H,B,H] — H repeats at positions 0,2,4. Each occurrence must
    // keep its own departure (exercises cursor index k=2, beyond the 2-occurrence
    // lasso shape).
    const seq: TripStopSeqEntry[] = [
      { stopId: "H", departureSecs: 0, seq: 1 },
      { stopId: "A", departureSecs: 100, seq: 2 },
      { stopId: "H", departureSecs: 200, seq: 3 },
      { stopId: "B", departureSecs: 300, seq: 4 },
      { stopId: "H", departureSecs: 400, seq: 5 },
    ];
    const routeTrips = buildRouteTripsIndex(
      new Map([["t", seq]]),
      tripsIndexFor("R", ["t"]),
    );
    const data = routeTrips.find((r) => r.routeId === "R")!;
    expect(data.stopIds).toEqual(["H", "A", "H", "B", "H"]);
    expect(Array.from(data.trips[0]!.departureSecs)).toEqual([0, 100, 200, 300, 400]);
  });
});
