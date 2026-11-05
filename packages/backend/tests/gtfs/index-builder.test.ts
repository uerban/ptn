import { describe, it, expect, vi } from "vitest";
import { buildIndexes, buildRouteTripsIndex } from "../../src/gtfs/index-builder.js";
import { buildShapesIndex } from "../../src/gtfs/shapesIndex.js";
import { GtfsStore } from "../../src/gtfs/store.js";
import type {
  GtfsStop,
  GtfsRoute,
  GtfsTrip,
  GtfsStopTime,
  GtfsService,
  GtfsCalendarDate,
  GtfsShapePoint,
} from "../../src/gtfs/parser.js";
import type { GtfsIndexes, TripStopSeqEntry } from "../../src/gtfs/index-builder.js";
import { PatternMode } from "@pt/shared";

// ── Fixtures ───────────────────────────────────────────────────────────────

const stops: GtfsStop[] = [
  { id: "S1", name: "Central Station", lat: 52.52, lon: 13.405, parentStation: "" },
  { id: "S2", name: "North Platform", lat: 52.525, lon: 13.41, parentStation: "S1" },
];

const routes: GtfsRoute[] = [
  { id: "R1", shortName: "U1", longName: "Underground Line 1", mode: "METRO", color: "FF0000", textColor: "FFFFFF" },
  { id: "R2", shortName: "B42", longName: "Bus Line 42", mode: "BUS", color: "0000FF", textColor: "FFFFFF" },
];

const trips: GtfsTrip[] = [
  { tripId: "T1", routeId: "R1", serviceId: "WD", headsign: "Destination A" },
  { tripId: "T2", routeId: "R2", serviceId: "WD", headsign: "Destination B" },
];

// T1 visits S1 then S2; T2 visits S2 only — S1 served by R1, S2 served by both R1 and R2
const stopTimes: GtfsStopTime[] = [
  { tripId: "T1", stopId: "S1", departureTime: "08:05:00", stopSequence: 1 },
  { tripId: "T1", stopId: "S2", departureTime: "08:10:00", stopSequence: 2 },
  { tripId: "T2", stopId: "S2", departureTime: "09:00:00", stopSequence: 1 },
];

const services: GtfsService[] = [
  {
    serviceId: "WD",
    monday: true,
    tuesday: true,
    wednesday: true,
    thursday: true,
    friday: true,
    saturday: false,
    sunday: false,
    startDate: "20240101",
    endDate: "20241231",
  },
];

const calendarDates: GtfsCalendarDate[] = [];

// ── Tests ──────────────────────────────────────────────────────────────────

describe("buildIndexes", () => {
  it("canonical carries stops keyed by stop_id", () => {
    const { canonical } = buildIndexes(stops, routes, trips, stopTimes, services, calendarDates);

    expect(canonical.stopCount).toBe(2);
    expect(canonical.getStop("S1")).toEqual(stops[0]);
    expect(canonical.getStop("S2")).toEqual(stops[1]);
    expect(canonical.getStop("NONEXISTENT")).toBeUndefined();
  });

  it("canonical carries routes keyed by route_id", () => {
    const { canonical } = buildIndexes(stops, routes, trips, stopTimes, services, calendarDates);

    let routeCount = 0;
    canonical.iterRoutes(() => { routeCount++; });
    expect(routeCount).toBe(2);
    expect(canonical.getRoute("R1")).toEqual(routes[0]);
    expect(canonical.getRoute("R2")).toEqual(routes[1]);
  });

  it("canonical carries trips keyed by trip_id", () => {
    const { canonical } = buildIndexes(stops, routes, trips, stopTimes, services, calendarDates);

    let tripCount = 0;
    canonical.iterTrips(() => { tripCount++; });
    expect(tripCount).toBe(2);
    expect(canonical.getTrip("T1")).toEqual(trips[0]);
    expect(canonical.getTrip("T2")).toEqual(trips[1]);
  });

  it("canonical carries stopTimes keyed by stop_id with entries sorted by departureSecs", () => {
    // Provide stop times out of order to verify sorting
    const outOfOrder: GtfsStopTime[] = [
      { tripId: "T2", stopId: "S2", departureTime: "09:00:00", stopSequence: 1 },
      { tripId: "T1", stopId: "S1", departureTime: "08:05:00", stopSequence: 1 },
      { tripId: "T1", stopId: "S2", departureTime: "08:10:00", stopSequence: 2 },
    ];

    const { canonical } = buildIndexes(stops, routes, trips, outOfOrder, services, calendarDates);

    // S1 has one entry (08:05:00 = 29100 secs)
    const s1Times = canonical.getCompactStopTimes("S1");
    expect(s1Times).toBeDefined();
    expect(s1Times!.tripIdIdx).toHaveLength(1);
    expect(s1Times!.departureSecs[0]).toBe(29100);

    // S2 has two entries, sorted ascending (08:10:00 = 29400, 09:00:00 = 32400)
    const s2Times = canonical.getCompactStopTimes("S2");
    expect(s2Times).toBeDefined();
    expect(s2Times!.tripIdIdx).toHaveLength(2);
    expect(s2Times!.departureSecs[0]).toBe(29400);
    expect(s2Times!.departureSecs[1]).toBe(32400);
  });

  it("canonical carries services with calendar entries and merges calendar_date exceptions", () => {
    const extraDates: GtfsCalendarDate[] = [
      { serviceId: "WD", date: "20240325", exceptionType: 2 },
      { serviceId: "WD", date: "20240401", exceptionType: 1 },
      // A service that exists only in calendar_dates (not in calendar.txt)
      { serviceId: "EXTRA", date: "20240501", exceptionType: 1 },
    ];

    const { canonical } = buildIndexes(stops, routes, trips, stopTimes, services, extraDates);

    // WD comes from calendar.txt
    const wd = canonical.getService("WD");
    expect(wd).toBeDefined();
    expect(wd!.monday).toBe(true);
    expect(wd!.saturday).toBe(false);
    expect(wd!.exceptions.size).toBe(2);
    expect(wd!.exceptions.get("20240325")).toBe(2);
    expect(wd!.exceptions.get("20240401")).toBe(1);

    // EXTRA only exists in calendar_dates — should still be present with a date-only entry
    const extra = canonical.getService("EXTRA");
    expect(extra).toBeDefined();
    expect(extra!.exceptions.size).toBe(1);
    expect(extra!.exceptions.get("20240501")).toBe(1);
  });

  it("derives stopRoutes index mapping stop_id to the set of route_ids that serve it", () => {
    const { indexes } = buildIndexes(stops, routes, trips, stopTimes, services, calendarDates);

    // S1 is only visited by T1 which belongs to R1
    const s1Routes = indexes.stopRoutes.get("S1");
    expect(s1Routes).toBeDefined();
    expect(s1Routes!.size).toBe(1);
    expect(s1Routes!.has("R1")).toBe(true);

    // S2 is visited by T1 (R1) and T2 (R2)
    const s2Routes = indexes.stopRoutes.get("S2");
    expect(s2Routes).toBeDefined();
    expect(s2Routes!.size).toBe(2);
    expect(s2Routes!.has("R1")).toBe(true);
    expect(s2Routes!.has("R2")).toBe(true);
  });

  it("tracks trip counts per (stop, route) pair", () => {
    const { indexes } = buildIndexes(stops, routes, trips, stopTimes, services, calendarDates);

    // S1: R1 has 1 trip (T1)
    expect(indexes.stopRouteTripCounts.get("S1")?.get("R1")).toBe(1);
    // S2: R1 has 1 trip (T1), R2 has 1 trip (T2)
    expect(indexes.stopRouteTripCounts.get("S2")?.get("R1")).toBe(1);
    expect(indexes.stopRouteTripCounts.get("S2")?.get("R2")).toBe(1);
  });

  it("filters stopRoutes by minTripsPerRoute when set", () => {
    // Add extra trips for R1 at S2 so it has 3 trips there, while R2 still has 1
    const moreStopTimes: GtfsStopTime[] = [
      ...stopTimes,
      { tripId: "T1x", stopId: "S2", departureTime: "10:00:00", stopSequence: 1 },
      { tripId: "T1y", stopId: "S2", departureTime: "11:00:00", stopSequence: 1 },
    ];
    const moreTrips: GtfsTrip[] = [
      ...trips,
      { tripId: "T1x", routeId: "R1", serviceId: "WD", headsign: "Destination A" },
      { tripId: "T1y", routeId: "R1", serviceId: "WD", headsign: "Destination A" },
    ];

    // Without filtering (minTripsPerRoute=0), S2 has both R1 and R2
    const { indexes: unfiltered } = buildIndexes(stops, routes, moreTrips, moreStopTimes, services, calendarDates, 0);
    expect(unfiltered.stopRoutes.get("S2")?.size).toBe(2);

    // With threshold=2, R2 (1 trip) is excluded from S2, R1 (3 trips) remains
    const { indexes: filtered } = buildIndexes(stops, routes, moreTrips, moreStopTimes, services, calendarDates, 2);
    expect(filtered.stopRoutes.get("S2")?.size).toBe(1);
    expect(filtered.stopRoutes.get("S2")?.has("R1")).toBe(true);
    expect(filtered.stopRoutes.get("S2")?.has("R2")).toBe(false);

    // S1 had 1 trip for R1 — below threshold, so S1 has no entry in stopRoutes
    expect(filtered.stopRoutes.has("S1")).toBe(false);

    // Raw counts are still preserved regardless of filtering
    expect(filtered.stopRouteTripCounts.get("S2")?.get("R2")).toBe(1);
    expect(filtered.stopRouteTripCounts.get("S1")?.get("R1")).toBe(1);
  });

  it("GtfsIndexes does not carry removed fields", () => {
    const { indexes } = buildIndexes(stops, routes, trips, stopTimes, services, calendarDates);
    const raw = indexes as unknown as Record<string, unknown>;
    expect(raw["stops"]).toBeUndefined();
    expect(raw["routes"]).toBeUndefined();
    expect(raw["trips"]).toBeUndefined();
    expect(raw["services"]).toBeUndefined();
    expect(raw["tripStrings"]).toBeUndefined();
    expect(raw["stopTimes"]).toBeUndefined();
  });
});

describe("index-builder — shapes", () => {
  const CAPS = { shapesCount: 50, pointsPerShape: 1000, shapesEncodedBytes: 1_000_000 };

  const shapePt = (
    shapeId: string,
    lat: number,
    lon: number,
    sequence: number,
  ): GtfsShapePoint => ({ shapeId, lat, lon, sequence });

  it("orphan shapes (no referencing trip) are dropped", () => {
    // Two trips on the existing routes; only T1 references a real shape.
    // `orphan` has points but no trip ever names it — must not survive.
    const tripsWithShape: GtfsTrip[] = [
      { tripId: "T1", routeId: "R1", serviceId: "WD", headsign: "Destination A", shapeId: "real" },
      { tripId: "T2", routeId: "R2", serviceId: "WD", headsign: "Destination B" },
    ];
    const shapePoints: GtfsShapePoint[] = [
      shapePt("real", 52.52, 13.405, 1),
      shapePt("real", 52.525, 13.41, 2),
      shapePt("orphan", 48.85, 2.35, 1),
      shapePt("orphan", 48.86, 2.36, 2),
    ];

    const { shapes, droppedCount } = buildShapesIndex({
      shapePoints,
      trips: tripsWithShape,
      caps: CAPS,
    });

    expect(shapes.map((s) => s.shapeId)).toEqual(["real"]);
    // Orphan is filtered out before any cap check — it's not counted as dropped.
    expect(droppedCount).toBe(0);
  });

  it("trip pointing at a dropped shape still builds, shapeId is undefined on export", () => {
    // T1 references a shape that will be dropped by shapesCount=0 (simulating
    // a cap overrun). The loader's orphan-strip step must clear T1.shapeId so
    // the exported bundle never carries a shapeId the client can't resolve.
    const tripsWithShape: GtfsTrip[] = [
      { tripId: "T1", routeId: "R1", serviceId: "WD", headsign: "Destination A", shapeId: "big" },
      { tripId: "T2", routeId: "R2", serviceId: "WD", headsign: "Destination B" },
    ];
    const shapePoints: GtfsShapePoint[] = [
      shapePt("big", 52.52, 13.405, 1),
      shapePt("big", 52.525, 13.41, 2),
    ];

    // Force a drop by clamping shapesCount to 0. Silence the diagnostic info log.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { shapes, droppedCount } = buildShapesIndex({
      shapePoints,
      trips: tripsWithShape,
      caps: { ...CAPS, shapesCount: 0 },
    });
    info.mockRestore();

    expect(shapes).toHaveLength(0);
    expect(droppedCount).toBe(1);

    // Mirror the loader's orphan-strip pass.
    const kept = new Set(shapes.map((s) => s.shapeId));
    for (const t of tripsWithShape) {
      if (t.shapeId && !kept.has(t.shapeId)) t.shapeId = undefined;
    }

    const { indexes, canonical, routingInput } = buildIndexes(
      stops,
      routes,
      tripsWithShape,
      stopTimes,
      services,
      calendarDates,
    );
    const store = new GtfsStore(indexes, canonical, routingInput, 0);
    store.setShapes(shapes);

    expect(store.getShapes()).toEqual([]);
    // T1 still builds on its route; its shapeId is stripped to undefined.
    expect(canonical.getTrip("T1")?.shapeId).toBeUndefined();
  });

  it("retains shapes and trip references when shapes survive the caps", () => {
    const tripsWithShape: GtfsTrip[] = [
      { tripId: "T1", routeId: "R1", serviceId: "WD", headsign: "Destination A", shapeId: "real" },
      { tripId: "T2", routeId: "R2", serviceId: "WD", headsign: "Destination B" },
    ];
    const shapePoints: GtfsShapePoint[] = [
      shapePt("real", 52.52, 13.405, 1),
      shapePt("real", 52.525, 13.41, 2),
    ];

    const { shapes } = buildShapesIndex({
      shapePoints,
      trips: tripsWithShape,
      caps: CAPS,
    });

    const { indexes, canonical, routingInput } = buildIndexes(
      stops,
      routes,
      tripsWithShape,
      stopTimes,
      services,
      calendarDates,
    );
    const store = new GtfsStore(indexes, canonical, routingInput, 0);
    store.setShapes(shapes);

    expect(store.getShapes()).toEqual(shapes);
    expect(store.getShapesHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(store.getShapesBody()).toContain("real");
    expect(canonical.getTrip("T1")?.shapeId).toBe("real");
  });

  it("emits dwellSecs on trips where arrival_time < departure_time at any stop", () => {
    // Simulate a terminus pause like Vilnius 3G at Oro uostas: trip T1
    // arrives at S2 at 08:20 but the same trip dwells until 08:27 before
    // heading back. The parser stores arrival_time only when it differs
    // from departure_time, so T1's second stop_time should flow through
    // to a non-zero dwellSecs on the wire; T2 (no arrival_time specified)
    // must emit no dwellSecs array at all.
    const dwellTrips: GtfsTrip[] = [
      { tripId: "T1", routeId: "R1", serviceId: "WD", headsign: "Terminus" },
      { tripId: "T2", routeId: "R2", serviceId: "WD", headsign: "Normal" },
    ];
    const dwellStopTimes: GtfsStopTime[] = [
      { tripId: "T1", stopId: "S1", departureTime: "08:00:00", stopSequence: 1 },
      // arrival at 08:20, departure at 08:27 → 7-minute dwell.
      { tripId: "T1", stopId: "S2", arrivalTime: "08:20:00", departureTime: "08:27:00", stopSequence: 2 },
      { tripId: "T2", stopId: "S2", departureTime: "09:00:00", stopSequence: 1 },
    ];

    const { indexes, canonical, routingInput } = buildIndexes(
      stops,
      routes,
      dwellTrips,
      dwellStopTimes,
      services,
      calendarDates,
    );
    const route1 = routingInput.routes.find((r) => r.routeId === "R1");
    const t1 = route1!.trips.find((t) => t.tripId === "T1");
    expect(t1).toBeDefined();
    // stopIds for R1 derives from T1 (the longest trip): [S1, S2].
    expect(route1!.stopIds).toEqual(["S1", "S2"]);
    // Dwell emitted only when any position is non-zero; S1 stays at 0,
    // S2 carries the 7-min pause (420s).
    expect(Array.from(t1!.dwellSecs!)).toEqual([0, 420]);

    // Trips without distinct arrival_time must not carry a dwellSecs
    // array — empty/omitted keeps the wire payload tight for the 99%
    // case of feeds that only populate departure_time.
    const route2 = routingInput.routes.find((r) => r.routeId === "R2");
    const t2 = route2!.trips.find((t) => t.tripId === "T2");
    expect(t2).toBeDefined();
    expect(t2!.dwellSecs).toBeUndefined();
  });
});

// ── Per-pattern route modeling (Phase 4A) ─────────────────────────────────

describe("buildRouteTripsIndex — per-pattern (Unbounded)", () => {
  // Route R1 has two patterns:
  //   Pattern A: S1 → S2 → S3  (full route, trips T1, T3)
  //   Pattern B: S1 → S2       (branch/short, trip T2)
  // Branch stop S3 must be present in the wire under Unbounded.
  const tripsIndex = new Map([
    ["T1", { tripId: "T1", routeId: "R1", serviceId: "WD", headsign: "Full" }],
    ["T2", { tripId: "T2", routeId: "R1", serviceId: "WD", headsign: "Short" }],
    ["T3", { tripId: "T3", routeId: "R1", serviceId: "WD", headsign: "Full" }],
  ]);

  // T1: S1@08:00 → S2@08:10 → S3@08:20
  // T2: S1@09:00 → S2@09:10  (no S3)
  // T3: S1@10:00 → S2@10:10 → S3@10:20
  const tripStopSeqs = new Map<string, TripStopSeqEntry[]>([
    ["T1", [
      { stopId: "S1", departureSecs: 28800, seq: 1 },
      { stopId: "S2", departureSecs: 29400, seq: 2 },
      { stopId: "S3", departureSecs: 30000, seq: 3 },
    ]],
    ["T2", [
      { stopId: "S1", departureSecs: 32400, seq: 1 },
      { stopId: "S2", departureSecs: 33000, seq: 2 },
    ]],
    ["T3", [
      { stopId: "S1", departureSecs: 36000, seq: 1 },
      { stopId: "S2", departureSecs: 36600, seq: 2 },
      { stopId: "S3", departureSecs: 37200, seq: 3 },
    ]],
  ]);

  it("Off (default) → 1 record for R1, byte-identical to pre-pattern (longest canonical)", () => {
    const result = buildRouteTripsIndex(tripStopSeqs, tripsIndex, PatternMode.Off);
    // Off: single canonical record (longest trip = T1/T3 = S1→S2→S3)
    expect(result).toHaveLength(1);
    expect(result[0]!.routeId).toBe("R1");
    expect(result[0]!.stopIds).toEqual(["S1", "S2", "S3"]);
    expect(result[0]!.trips).toHaveLength(3);
  });

  it("Unbounded → 2 wire-routes for R1 (one per pattern), branch stop present", () => {
    const result = buildRouteTripsIndex(tripStopSeqs, tripsIndex, PatternMode.Unbounded);
    // Unbounded: 2 patterns
    //   Pattern 0: S1 → S2 → S3  (T1, T3)
    //   Pattern 1: S1 → S2       (T2)
    expect(result).toHaveLength(2);

    // Both records carry the bare route_id (repeated)
    expect(result[0]!.routeId).toBe("R1");
    expect(result[1]!.routeId).toBe("R1");

    // Pattern 0 includes branch stop S3
    expect(result[0]!.stopIds).toEqual(["S1", "S2", "S3"]);
    expect(result[0]!.trips).toHaveLength(2); // T1, T3

    // Pattern 1 is the short-turn: S1→S2 only
    expect(result[1]!.stopIds).toEqual(["S1", "S2"]);
    expect(result[1]!.trips).toHaveLength(1); // T2
  });

  it("Unbounded → per-pattern aligned departureSecs (no unserved holes within pattern)", () => {
    const result = buildRouteTripsIndex(tripStopSeqs, tripsIndex, PatternMode.Unbounded);
    const fullPattern = result[0]!;
    // Pattern S1→S2→S3: T1 serves all three stops — no sentinel in any position
    const t1 = fullPattern.trips.find((t) => t.tripId === "T1")!;
    expect(t1.departureSecs[0]).toBe(28800); // S1
    expect(t1.departureSecs[1]).toBe(29400); // S2
    expect(t1.departureSecs[2]).toBe(30000); // S3
  });

  it("per-stop union of route_ids under Unbounded equals the raw all-trips union", () => {
    // Build the routing wire from both modes and verify per-stop routeId union parity.
    // Off:       stopIds union for R1 = {S1, S2, S3}
    // Unbounded: pattern-0 stopIds = {S1, S2, S3}, pattern-1 stopIds = {S1, S2}
    //            union = {S1, S2, S3}  ← same
    const offResult = buildRouteTripsIndex(tripStopSeqs, tripsIndex, PatternMode.Off);
    const unboundedResult = buildRouteTripsIndex(tripStopSeqs, tripsIndex, PatternMode.Unbounded);

    // Compute per-stop routeId union for each mode
    const stopRouteUnion = (records: ReturnType<typeof buildRouteTripsIndex>): Map<string, Set<string>> => {
      const m = new Map<string, Set<string>>();
      for (const rec of records) {
        for (const sid of rec.stopIds) {
          if (!m.has(sid)) m.set(sid, new Set());
          m.get(sid)!.add(rec.routeId);
        }
      }
      return m;
    };

    const offUnion = stopRouteUnion(offResult);
    const unboundedUnion = stopRouteUnion(unboundedResult);

    // The union of stopIds across all patterns must equal the Off canonical union.
    for (const [stopId, routeIds] of offUnion) {
      const ubRoutes = unboundedUnion.get(stopId);
      expect(ubRoutes, `stop ${stopId} missing under Unbounded`).toBeDefined();
      for (const rid of routeIds) {
        expect(ubRoutes!.has(rid), `routeId ${rid} missing at stop ${stopId} under Unbounded`).toBe(true);
      }
    }
  });

  it("minTripsPerRoute threshold does NOT suppress branch pattern from routing wire", () => {
    // T2 is the only trip in its short-turn pattern. Even with minTripsPerRoute=2
    // (which would filter it from MapView's stopRoutes), the routing wire must
    // still carry T2's pattern so RAPTOR can board at its stops.
    // Note: minTripsPerRoute is enforced at GtfsIndexes.stopRoutes level (MapView),
    // NOT at the routing wire level — this test confirms the wire is unaffected.
    const result = buildRouteTripsIndex(tripStopSeqs, tripsIndex, PatternMode.Unbounded);
    // The short-turn pattern (T2 only) must be present regardless.
    const shortPattern = result.find((r) => r.stopIds.length === 2);
    expect(shortPattern).toBeDefined();
    expect(shortPattern!.trips.find((t) => t.tripId === "T2")).toBeDefined();
  });
});

describe("buildIndexes — per-pattern mode threads into routingInput", () => {
  it("Off → routingInput.routes has 1 entry for a 2-pattern route", () => {
    const localStops: GtfsStop[] = [
      { id: "S1", name: "A", lat: 1, lon: 1, parentStation: "" },
      { id: "S2", name: "B", lat: 2, lon: 2, parentStation: "" },
      { id: "S3", name: "C", lat: 3, lon: 3, parentStation: "" },
    ];
    const localRoutes: GtfsRoute[] = [
      { id: "R1", shortName: "1", longName: "", mode: "BUS", color: "", textColor: "" },
    ];
    const localTrips: GtfsTrip[] = [
      { tripId: "T1", routeId: "R1", serviceId: "WD", headsign: "Full" },
      { tripId: "T2", routeId: "R1", serviceId: "WD", headsign: "Short" },
    ];
    const localStopTimes: GtfsStopTime[] = [
      { tripId: "T1", stopId: "S1", departureTime: "08:00:00", stopSequence: 1 },
      { tripId: "T1", stopId: "S2", departureTime: "08:10:00", stopSequence: 2 },
      { tripId: "T1", stopId: "S3", departureTime: "08:20:00", stopSequence: 3 },
      { tripId: "T2", stopId: "S1", departureTime: "09:00:00", stopSequence: 1 },
      { tripId: "T2", stopId: "S2", departureTime: "09:10:00", stopSequence: 2 },
    ];
    const { routingInput } = buildIndexes(localStops, localRoutes, localTrips, localStopTimes, services, calendarDates, 0, PatternMode.Off);
    // Off: single record per route_id
    expect(routingInput.routes).toHaveLength(1);
    expect(routingInput.routes[0]!.routeId).toBe("R1");
    // Canonical stopIds = longest trip (T1): S1→S2→S3
    expect(routingInput.routes[0]!.stopIds).toEqual(["S1", "S2", "S3"]);
  });

  it("Unbounded → routingInput.routes has 2 entries for a 2-pattern route", () => {
    const localStops: GtfsStop[] = [
      { id: "S1", name: "A", lat: 1, lon: 1, parentStation: "" },
      { id: "S2", name: "B", lat: 2, lon: 2, parentStation: "" },
      { id: "S3", name: "C", lat: 3, lon: 3, parentStation: "" },
    ];
    const localRoutes: GtfsRoute[] = [
      { id: "R1", shortName: "1", longName: "", mode: "BUS", color: "", textColor: "" },
    ];
    const localTrips: GtfsTrip[] = [
      { tripId: "T1", routeId: "R1", serviceId: "WD", headsign: "Full" },
      { tripId: "T2", routeId: "R1", serviceId: "WD", headsign: "Short" },
    ];
    const localStopTimes: GtfsStopTime[] = [
      { tripId: "T1", stopId: "S1", departureTime: "08:00:00", stopSequence: 1 },
      { tripId: "T1", stopId: "S2", departureTime: "08:10:00", stopSequence: 2 },
      { tripId: "T1", stopId: "S3", departureTime: "08:20:00", stopSequence: 3 },
      { tripId: "T2", stopId: "S1", departureTime: "09:00:00", stopSequence: 1 },
      { tripId: "T2", stopId: "S2", departureTime: "09:10:00", stopSequence: 2 },
    ];
    const { routingInput } = buildIndexes(localStops, localRoutes, localTrips, localStopTimes, services, calendarDates, 0, PatternMode.Unbounded);
    // Unbounded: 2 records, both with routeId="R1"
    expect(routingInput.routes).toHaveLength(2);
    expect(routingInput.routes[0]!.routeId).toBe("R1");
    expect(routingInput.routes[1]!.routeId).toBe("R1");
    // Pattern 0 has branch stop S3; pattern 1 does not
    expect(routingInput.routes[0]!.stopIds).toEqual(["S1", "S2", "S3"]);
    expect(routingInput.routes[1]!.stopIds).toEqual(["S1", "S2"]);
  });
});

// ── Per-pattern route modeling: off-canonical branch + disjoint directions ──
//
// The short-turn fixture above (Pattern B = prefix of Pattern A) cannot expose
// the canonical-position derivation bug: every short-turn stop is also on the
// longest trip. These fixtures exercise stops that are NOT on the route's
// longest trip, which the old canonical-position derivation silently dropped
// from the pattern signature (BUG 1).

describe("buildRouteTripsIndex — true off-canonical branch (Unbounded)", () => {
  // Route R1 has two genuinely branching patterns that share a stem but diverge:
  //   LOCAL  : S0 → S1 → S2 → S4   (longest, trips T1, T3)
  //   BRANCH : S0 → S1 → S3 → S4   (trip T2) — S3 is NOT on the longest trip
  // Under the longest-trip canonical [S0,S1,S2,S4], S3 has no canonical
  // position, so a canonical-position signature derivation drops it entirely
  // and the BRANCH pattern collapses to [S0,S1,S4] — S3 becomes unroutable.
  const tripsIndex = new Map([
    ["T1", { tripId: "T1", routeId: "R1", serviceId: "WD", headsign: "Local" }],
    ["T2", { tripId: "T2", routeId: "R1", serviceId: "WD", headsign: "Branch" }],
    ["T3", { tripId: "T3", routeId: "R1", serviceId: "WD", headsign: "Local" }],
  ]);

  const tripStopSeqs = new Map<string, TripStopSeqEntry[]>([
    ["T1", [
      { stopId: "S0", departureSecs: 28800, seq: 1 },
      { stopId: "S1", departureSecs: 29400, seq: 2 },
      { stopId: "S2", departureSecs: 30000, seq: 3 },
      { stopId: "S4", departureSecs: 30600, seq: 4 },
    ]],
    ["T2", [
      { stopId: "S0", departureSecs: 32400, seq: 1 },
      { stopId: "S1", departureSecs: 33000, seq: 2 },
      { stopId: "S3", departureSecs: 33600, seq: 3 },
      { stopId: "S4", departureSecs: 34200, seq: 4 },
    ]],
    ["T3", [
      { stopId: "S0", departureSecs: 36000, seq: 1 },
      { stopId: "S1", departureSecs: 36600, seq: 2 },
      { stopId: "S2", departureSecs: 37200, seq: 3 },
      { stopId: "S4", departureSecs: 37800, seq: 4 },
    ]],
  ]);

  it("Unbounded → the BRANCH pattern's stopIds CONTAIN S3 (off-canonical stop routable)", () => {
    const result = buildRouteTripsIndex(tripStopSeqs, tripsIndex, PatternMode.Unbounded);
    // Two distinct served-stop signatures → two patterns.
    expect(result).toHaveLength(2);

    // Some emitted pattern must carry the off-canonical branch stop S3.
    const branchPattern = result.find((r) => r.stopIds.includes("S3"));
    expect(branchPattern, "no pattern carries off-canonical stop S3").toBeDefined();

    // The branch pattern's full served sequence is preserved, not collapsed
    // onto the longest-trip canonical.
    expect(branchPattern!.stopIds).toEqual(["S0", "S1", "S3", "S4"]);

    // S3 is served (departure aligned to its pattern position, not a hole).
    const t2 = branchPattern!.trips.find((t) => t.tripId === "T2")!;
    const s3Pos = branchPattern!.stopIds.indexOf("S3");
    expect(t2.departureSecs[s3Pos]).toBe(33600);
  });

  it("Unbounded → S3 is covered by exactly the branch pattern (routable in RAPTOR)", () => {
    const result = buildRouteTripsIndex(tripStopSeqs, tripsIndex, PatternMode.Unbounded);
    // Build the per-stop routeId union across all patterns; S3 must appear.
    const coveredStops = new Set<string>();
    for (const rec of result) for (const sid of rec.stopIds) coveredStops.add(sid);
    expect(coveredStops.has("S3")).toBe(true);
    // The LOCAL pattern (which serves S2 but not S3) is also present.
    const localPattern = result.find((r) => r.stopIds.includes("S2"));
    expect(localPattern!.stopIds).toEqual(["S0", "S1", "S2", "S4"]);
  });
});

describe("buildRouteTripsIndex — disjoint directions (Unbounded)", () => {
  // Route R2 is bidirectional with dir-0 and dir-1 sharing NO stops (the
  // Vilnius 1G shape). Under a longest-trip canonical built from dir-0, every
  // dir-1 stop is off-canonical, so a canonical-position signature derivation
  // yields the EMPTY signature [] for dir-1 — the whole opposite direction
  // becomes unroutable.
  const tripsIndex = new Map([
    ["D0", { tripId: "D0", routeId: "R2", serviceId: "WD", headsign: "Outbound" }],
    ["D1", { tripId: "D1", routeId: "R2", serviceId: "WD", headsign: "Inbound" }],
  ]);

  const tripStopSeqs = new Map<string, TripStopSeqEntry[]>([
    ["D0", [
      { stopId: "A1", departureSecs: 28800, seq: 1 },
      { stopId: "A2", departureSecs: 29400, seq: 2 },
      { stopId: "A3", departureSecs: 30000, seq: 3 },
    ]],
    ["D1", [
      { stopId: "B1", departureSecs: 32400, seq: 1 },
      { stopId: "B2", departureSecs: 33000, seq: 2 },
      { stopId: "B3", departureSecs: 33600, seq: 3 },
    ]],
  ]);

  it("Unbounded → BOTH directions emit non-empty patterns (neither signature is [])", () => {
    const result = buildRouteTripsIndex(tripStopSeqs, tripsIndex, PatternMode.Unbounded);
    expect(result).toHaveLength(2);

    // No pattern may have an empty stop sequence.
    for (const rec of result) {
      expect(rec.stopIds.length, `pattern for ${rec.routeId} has empty stopIds`).toBeGreaterThan(0);
    }

    // Each direction's own stops are all present somewhere.
    const coveredStops = new Set<string>();
    for (const rec of result) for (const sid of rec.stopIds) coveredStops.add(sid);
    for (const sid of ["A1", "A2", "A3", "B1", "B2", "B3"]) {
      expect(coveredStops.has(sid), `disjoint-direction stop ${sid} unroutable`).toBe(true);
    }

    // The two patterns are exactly the two direction sequences.
    const seqs = result.map((r) => r.stopIds.join(","));
    expect(seqs).toContain("A1,A2,A3");
    expect(seqs).toContain("B1,B2,B3");
  });
});

describe("buildRouteTripsIndex — CoveringMerge folded member honors offset (positional)", () => {
  // A covering pattern that REPEATS a stop (lasso/loop) plus a short folded
  // trip whose served sequence is a contiguous subsequence of the covering
  // pattern starting at a non-zero offset. A from-position-0 cursor would
  // re-seek the folded rows to the FIRST occurrence of each stop (wrong
  // window); the offset-honoring positional branch must place row i at
  // pattern position offset+i and leave the other positions as sentinel holes.
  //
  //   COVER : X → Y → Z → Y → W   (trip TC) — Y repeats (positions 1 and 3)
  //   FOLD  : Z → Y → W           (trip TF) — contiguous window at offset 2
  const tripsIndex = new Map([
    ["TC", { tripId: "TC", routeId: "RL", serviceId: "WD", headsign: "Loop" }],
    ["TF", { tripId: "TF", routeId: "RL", serviceId: "WD", headsign: "Short" }],
  ]);

  const tripStopSeqs = new Map<string, TripStopSeqEntry[]>([
    ["TC", [
      { stopId: "X", departureSecs: 28800, seq: 1 },
      { stopId: "Y", departureSecs: 29400, seq: 2 },
      { stopId: "Z", departureSecs: 30000, seq: 3 },
      { stopId: "Y", departureSecs: 30600, seq: 4 },
      { stopId: "W", departureSecs: 31200, seq: 5 },
    ]],
    ["TF", [
      { stopId: "Z", departureSecs: 50000, seq: 1 },
      { stopId: "Y", departureSecs: 50600, seq: 2 },
      { stopId: "W", departureSecs: 51200, seq: 3 },
    ]],
  ]);

  it("CoveringMerge → folded trip's rows land at the covering window [offset, offset+len), holes elsewhere", () => {
    const result = buildRouteTripsIndex(tripStopSeqs, tripsIndex, PatternMode.CoveringMerge);
    // The fold collapses both trips into the single covering pattern.
    expect(result).toHaveLength(1);
    const cover = result[0]!;
    expect(cover.stopIds).toEqual(["X", "Y", "Z", "Y", "W"]);

    const tf = cover.trips.find((t) => t.tripId === "TF")!;
    // Folded window starts at offset 2 (Z is at covering position 2).
    // Positions 0 (X) and 1 (first Y) are NOT served by TF — holes.
    expect(tf.departureSecs[0]).toBe(0xffffffff); // X — unserved
    expect(tf.departureSecs[1]).toBe(0xffffffff); // first Y — unserved
    expect(tf.departureSecs[2]).toBe(50000);      // Z
    expect(tf.departureSecs[3]).toBe(50600);      // second Y (the served one)
    expect(tf.departureSecs[4]).toBe(51200);      // W
  });
});
