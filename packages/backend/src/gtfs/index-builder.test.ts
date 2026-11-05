import { describe, it, expect } from "vitest";
import { buildIndexes } from "./index-builder.js";
import { GtfsStore } from "./store.js";
import type { GtfsStop, GtfsRoute, GtfsTrip, GtfsStopTime, GtfsService } from "./parser.js";
import { buildTripStringTable } from "./parser.js";

// ── Fixture factory ──────────────────────────────────────────────────────────

/** Build a synthetic GTFS dataset. stopCount × tripsPerStop stop_times rows. */
export function makeFixture(opts: {
  stopCount: number;
  tripsPerStop: number;
  routeCount?: number;
}): {
  stops: GtfsStop[];
  routes: GtfsRoute[];
  trips: GtfsTrip[];
  stopTimes: GtfsStopTime[];
  services: GtfsService[];
} {
  const { stopCount, tripsPerStop, routeCount = 10 } = opts;

  const stops: GtfsStop[] = Array.from({ length: stopCount }, (_, i) => ({
    id: `S${i}`,
    name: `Stop ${i}`,
    lat: 48.85 + i * 0.001,
    lon: 2.35 + i * 0.001,
    parentStation: "",
  }));

  const routes: GtfsRoute[] = Array.from({ length: routeCount }, (_, i) => ({
    id: `R${i}`,
    shortName: `${i}`,
    longName: `Route ${i}`,
    mode: "BUS" as const,
    color: "FFFFFF",
    textColor: "000000",
  }));

  const tripTotal = stopCount * tripsPerStop;
  const trips: GtfsTrip[] = Array.from({ length: tripTotal }, (_, i) => ({
    tripId: `T${i}`,
    routeId: `R${i % routeCount}`,
    serviceId: "SVC1",
    headsign: `Headsign ${i % 5}`,
  }));

  const stopTimes: GtfsStopTime[] = [];
  for (let s = 0; s < stopCount; s++) {
    for (let t = 0; t < tripsPerStop; t++) {
      const tripIdx = s * tripsPerStop + t;
      stopTimes.push({
        tripId: `T${tripIdx}`,
        stopId: `S${s}`,
        departureTime: `${8 + Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}:00`,
        stopSequence: 1,
      });
    }
  }

  const services: GtfsService[] = [
    {
      serviceId: "SVC1",
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: true,
      saturday: false,
      sunday: false,
      startDate: "20260101",
      endDate: "20261231",
    },
  ];

  return { stops, routes, trips, stopTimes, services };
}

// ── Heap helper ───────────────────────────────────────────────────────────────

/**
 * Returns used heap in bytes after forcing a GC cycle.
 * Requires --expose-gc (Vitest config handles this).
 */
export function usedHeap(): number {
  if (typeof global.gc === "function") global.gc();
  const { heapUsed } = process.memoryUsage();
  return heapUsed;
}

// ── Smoke tests ───────────────────────────────────────────────────────────────

describe("makeFixture", () => {
  it("produces the expected number of stop_times", () => {
    const f = makeFixture({ stopCount: 100, tripsPerStop: 50 });
    expect(f.stopTimes).toHaveLength(5_000);
  });

  it("buildIndexes returns stopTimes for every stop", () => {
    const f = makeFixture({ stopCount: 20, tripsPerStop: 10 });
    const { canonical } = buildIndexes(f.stops, f.routes, f.trips, f.stopTimes, f.services, []);
    expect(canonical.compactStopTimesCount).toBe(20);
    for (let i = 0; i < 20; i++) {
      expect(canonical.getCompactStopTimes(`S${i}`)?.tripIdIdx.length).toBe(10);
    }
  });
});

describe("buildTripStringTable", () => {
  it("assigns a unique numeric index to each distinct string", () => {
    const ids = ["T1", "T2", "T1", "T3", "T2"];
    const table = buildTripStringTable(ids);
    expect(table.indexOf("T1")).toBe(table.indexOf("T1")); // same index
    expect(table.indexOf("T1")).not.toBe(table.indexOf("T2"));
    expect(table.indexOf("T3")).not.toBe(table.indexOf("T1"));
  });

  it("stringAt round-trips correctly", () => {
    const ids = ["alpha", "beta", "gamma"];
    const table = buildTripStringTable(ids);
    expect(table.stringAt(table.indexOf("alpha"))).toBe("alpha");
    expect(table.stringAt(table.indexOf("gamma"))).toBe("gamma");
  });

  it("intern() on an unknown string appends a new entry", () => {
    const table = buildTripStringTable([]);
    const idx = table.intern("new_trip");
    expect(table.stringAt(idx)).toBe("new_trip");
    expect(table.indexOf("new_trip")).toBe(idx);
  });

  it("intern() returns the same index for the same string", () => {
    const table = buildTripStringTable([]);
    const a = table.intern("T99");
    const b = table.intern("T99");
    expect(a).toBe(b);
  });

  it("size reflects the number of distinct strings", () => {
    const table = buildTripStringTable(["X", "Y", "X", "Z"]);
    expect(table.size).toBe(3);
  });

  it("indexOf returns -1 for an unknown string without interning it", () => {
    const table = buildTripStringTable(["A"]);
    expect(table.indexOf("Z")).toBe(-1);
    expect(table.size).toBe(1); // indexOf is read-only
  });

  it("stringAt throws RangeError on out-of-range index", () => {
    const table = buildTripStringTable(["A"]);
    expect(() => table.stringAt(42)).toThrow(RangeError);
    expect(() => table.stringAt(-1)).toThrow(RangeError);
  });
});

// Helper: assert CompactStopTimes has expected shape
function assertCompact(
  canonical: import("./canonical/CanonicalStore.js").CanonicalStore,
  stopId: string,
  expectedCount: number,
): void {
  const ct = canonical.getCompactStopTimes(stopId);
  expect(ct).toBeDefined();
  expect(ct!.tripIdIdx).toBeInstanceOf(Uint32Array);
  expect(ct!.departureSecs).toBeInstanceOf(Uint32Array);
  expect(ct!.tripIdIdx.length).toBe(expectedCount);
  expect(ct!.departureSecs.length).toBe(expectedCount);
}

describe("CompactStopTimes layout", () => {
  it("stopTimes map values are CompactStopTimes with Uint32Array columns", () => {
    const f = makeFixture({ stopCount: 5, tripsPerStop: 8 });
    const { canonical } = buildIndexes(f.stops, f.routes, f.trips, f.stopTimes, f.services, []);
    assertCompact(canonical, "S0", 8);
    assertCompact(canonical, "S4", 8);
  });

  it("departureSecs column is sorted ascending", () => {
    const f = makeFixture({ stopCount: 3, tripsPerStop: 10 });
    const { canonical } = buildIndexes(f.stops, f.routes, f.trips, f.stopTimes, f.services, []);
    const ct = canonical.getCompactStopTimes("S0")!;
    for (let i = 1; i < ct.departureSecs.length; i++) {
      expect(ct.departureSecs[i]).toBeGreaterThanOrEqual(ct.departureSecs[i - 1]);
    }
  });

  it("tripIdIdx round-trips through canonical getTripIdForIx", () => {
    const f = makeFixture({ stopCount: 2, tripsPerStop: 3 });
    const { canonical } = buildIndexes(f.stops, f.routes, f.trips, f.stopTimes, f.services, []);
    const ct = canonical.getCompactStopTimes("S0")!;
    for (let i = 0; i < ct.tripIdIdx.length; i++) {
      const tripId = canonical.getTripIdForIx(ct.tripIdIdx[i]!);
      expect(tripId).toMatch(/^T\d+$/);
    }
  });

  it("heap-delta: CompactStopTimes uses less heap than IndexedStopTime[] for 50K entries", () => {
    const f = makeFixture({ stopCount: 500, tripsPerStop: 100 });
    const before = usedHeap();
    const { canonical } = buildIndexes(f.stops, f.routes, f.trips, f.stopTimes, f.services, []);
    const after = usedHeap();
    const deltaMB = (after - before) / 1024 / 1024;
    // Total index delta must be under 20 MB for a 50K-entry fixture.
    // Old per-object layout would produce ~45 MB for stopTimes alone.
    expect(deltaMB).toBeLessThan(20);
    expect(canonical.compactStopTimesCount).toBeGreaterThan(0);
  });
});

import { mergeSmallFiles } from "./loader.js";

describe("mergeSmallFiles — perFeed nullability", () => {
  it("merged result is complete after source accumulator is cleared", () => {
    const feed1 = {
      stops: [{ id: "S1", name: "Stop 1", lat: 0, lon: 0, parentStation: "" }],
      routes: [{ id: "R1", shortName: "1", longName: "", mode: "BUS" as const, color: "", textColor: "" }],
      trips: [{ tripId: "T1", routeId: "R1", serviceId: "SVC1", headsign: "" }],
      calendar: [],
      calendarDates: [],
    };
    const feed2 = {
      stops: [{ id: "S2", name: "Stop 2", lat: 1, lon: 1, parentStation: "" }],
      routes: [{ id: "R2", shortName: "2", longName: "", mode: "BUS" as const, color: "", textColor: "" }],
      trips: [{ tripId: "T2", routeId: "R2", serviceId: "SVC1", headsign: "" }],
      calendar: [],
      calendarDates: [],
    };

    const perFeed = [feed1, feed2];
    const merged = mergeSmallFiles(perFeed, ["feed1", "feed2"]);

    // Simulate the fix: clear the accumulator
    (perFeed as unknown[]).length = 0;

    // merged must still be complete after clearing
    expect(merged.stops).toHaveLength(2);
    expect(merged.routes).toHaveLength(2);
    expect(merged.trips).toHaveLength(2);
    expect(merged.stops.map((s) => s.id).sort()).toEqual(["S1", "S2"]);
  });
});

describe("GtfsStore fidelity after CompactStopTimes migration", () => {
  it("getDepartures returns the expected trips with tripId resolved via tripStrings", () => {
    const stops = [{
      id: "A", name: "Alpha", lat: 48.85, lon: 2.35, parentStation: "",
    }];
    const routes = [{
      id: "R1", shortName: "1", longName: "Route 1", mode: "BUS" as const,
      color: "", textColor: "",
    }];
    const trips = [
      { tripId: "TRIP_MORNING", routeId: "R1", serviceId: "SVC1", headsign: "City" },
      { tripId: "TRIP_NOON",    routeId: "R1", serviceId: "SVC1", headsign: "City" },
    ];
    const stopTimes = [
      { tripId: "TRIP_MORNING", stopId: "A", departureTime: "08:00:00", stopSequence: 1 },
      { tripId: "TRIP_NOON",    stopId: "A", departureTime: "12:00:00", stopSequence: 1 },
    ];
    const services = [{
      serviceId: "SVC1",
      monday: true, tuesday: true, wednesday: true,
      thursday: true, friday: true, saturday: true, sunday: true,
      startDate: "20260101", endDate: "20261231",
    }];

    const { indexes, canonical, routingInput } = buildIndexes(stops, routes, trips, stopTimes, services, []);
    const store = new GtfsStore();
    store.swap(indexes, canonical, routingInput);

    // Signature: getDepartures(stopId, date, limit, lookAheadHours?)
    const baseDate = new Date("2026-04-20T07:50:00Z");
    const departures = store.getDepartures("A", baseDate, 100, 12);
    const tripIds = departures.map((d) => d.tripId).sort();
    expect(tripIds).toContain("TRIP_MORNING");
    expect(tripIds).toContain("TRIP_NOON");
  });

  it("getDepartures returns departures sorted by scheduledTime ascending", () => {
    const f = makeFixture({ stopCount: 1, tripsPerStop: 20 });
    const { indexes, canonical, routingInput } = buildIndexes(f.stops, f.routes, f.trips, f.stopTimes, f.services, []);
    const store = new GtfsStore();
    store.swap(indexes, canonical, routingInput);
    const deps = store.getDepartures("S0", new Date("2026-04-20T06:00:00Z"), 100, 12);
    for (let i = 1; i < deps.length; i++) {
      expect(new Date(deps[i].scheduledTime).getTime())
        .toBeGreaterThanOrEqual(new Date(deps[i - 1].scheduledTime).getTime());
    }
  });
});

describe("RouteSchedule.directionPatterns — bidirectional routes preserve return-only stops", () => {
  it("emits one stop sequence per direction when stop_ids differ across directions", () => {
    // Synthesise a route shaped like the Vilnius-69 / Kernavės-g. defect:
    // outbound (direction 0) stops at A→K_OUT→C, return (direction 1) stops at
    // C→K_IN→A. Stops K_OUT and K_IN are the two sides of the same street and
    // have distinct stop_ids. Without per-direction patterns, the canonical
    // stopIds (longest trip = either direction here) would drop the other
    // direction's middle stop.
    const stops: GtfsStop[] = [
      { id: "A",     name: "A",       lat: 54.0, lon: 25.0, parentStation: "" },
      { id: "K_OUT", name: "Kernavės out", lat: 54.1, lon: 25.1, parentStation: "" },
      { id: "K_IN",  name: "Kernavės in",  lat: 54.1, lon: 25.1, parentStation: "" },
      { id: "C",     name: "C",       lat: 54.2, lon: 25.2, parentStation: "" },
    ];
    const routes: GtfsRoute[] = [
      { id: "R69", shortName: "69", longName: "69", mode: "BUS" as const, color: "", textColor: "" },
    ];
    const trips: GtfsTrip[] = [
      { tripId: "T_OUT", routeId: "R69", serviceId: "SVC1", headsign: "Lazdynėliai", directionId: 0 },
      { tripId: "T_IN",  routeId: "R69", serviceId: "SVC1", headsign: "Centras",     directionId: 1 },
    ];
    const stopTimes: GtfsStopTime[] = [
      { tripId: "T_OUT", stopId: "A",     departureTime: "08:00:00", stopSequence: 1 },
      { tripId: "T_OUT", stopId: "K_OUT", departureTime: "08:05:00", stopSequence: 2 },
      { tripId: "T_OUT", stopId: "C",     departureTime: "08:10:00", stopSequence: 3 },
      { tripId: "T_IN",  stopId: "C",     departureTime: "09:00:00", stopSequence: 1 },
      { tripId: "T_IN",  stopId: "K_IN",  departureTime: "09:05:00", stopSequence: 2 },
      { tripId: "T_IN",  stopId: "A",     departureTime: "09:10:00", stopSequence: 3 },
    ];
    const services: GtfsService[] = [{
      serviceId: "SVC1",
      monday: true, tuesday: true, wednesday: true,
      thursday: true, friday: true, saturday: true, sunday: true,
      startDate: "20260101", endDate: "20261231",
    }];

    const { routingInput } = buildIndexes(stops, routes, trips, stopTimes, services, []);
    const route = routingInput.routes.find((r) => r.routeId === "R69");
    expect(route).toBeDefined();

    const patterns = route!.directionPatterns;
    expect(patterns).toBeDefined();
    expect(patterns).toHaveLength(2);

    const outbound = patterns!.find((p) => p.headsign === "Lazdynėliai");
    const inbound = patterns!.find((p) => p.headsign === "Centras");
    expect(outbound).toBeDefined();
    expect(inbound).toBeDefined();
    // Verify each direction's full stop sequence is preserved — the return-
    // only stop (K_IN) survives, which would not be the case if the index
    // collapsed everything to the canonical longest-trip stopIds.
    expect(outbound!.stopIds).toEqual(["A", "K_OUT", "C"]);
    expect(inbound!.stopIds).toEqual(["C", "K_IN", "A"]);
  });

  it("emits one pattern per headsign within the same direction (express-variant case)", () => {
    // Direction 0 has two headsigns: full route ("Centras") and a branched
    // variant ("Centras via Saulėtekis"). Each variant has its own stop
    // sequence — the variant detours through V instead of B. Without
    // per-headsign bucketing the frontend's headsign-keyed lookup would
    // miss the second variant and fall back to the canonical-stopIds path
    // that drops return-only stops.
    const stops: GtfsStop[] = [
      { id: "A", name: "A", lat: 54.0, lon: 25.0, parentStation: "" },
      { id: "B", name: "B", lat: 54.1, lon: 25.1, parentStation: "" },
      { id: "V", name: "V", lat: 54.1, lon: 25.2, parentStation: "" },
      { id: "C", name: "C", lat: 54.2, lon: 25.2, parentStation: "" },
    ];
    const routes: GtfsRoute[] = [
      { id: "RX", shortName: "X", longName: "X", mode: "BUS" as const, color: "", textColor: "" },
    ];
    const trips: GtfsTrip[] = [
      { tripId: "T_FULL",   routeId: "RX", serviceId: "SVC1", headsign: "Centras",                  directionId: 0 },
      { tripId: "T_BRANCH", routeId: "RX", serviceId: "SVC1", headsign: "Centras via Saulėtekis",  directionId: 0 },
    ];
    const stopTimes: GtfsStopTime[] = [
      { tripId: "T_FULL",   stopId: "A", departureTime: "08:00:00", stopSequence: 1 },
      { tripId: "T_FULL",   stopId: "B", departureTime: "08:05:00", stopSequence: 2 },
      { tripId: "T_FULL",   stopId: "C", departureTime: "08:10:00", stopSequence: 3 },
      { tripId: "T_BRANCH", stopId: "A", departureTime: "09:00:00", stopSequence: 1 },
      { tripId: "T_BRANCH", stopId: "V", departureTime: "09:05:00", stopSequence: 2 },
      { tripId: "T_BRANCH", stopId: "C", departureTime: "09:10:00", stopSequence: 3 },
    ];
    const services: GtfsService[] = [{
      serviceId: "SVC1",
      monday: true, tuesday: true, wednesday: true,
      thursday: true, friday: true, saturday: true, sunday: true,
      startDate: "20260101", endDate: "20261231",
    }];

    const { routingInput } = buildIndexes(stops, routes, trips, stopTimes, services, []);
    const patterns = routingInput.routes.find((r) => r.routeId === "RX")!.directionPatterns;
    expect(patterns).toHaveLength(2);

    const full = patterns!.find((p) => p.headsign === "Centras")!;
    const branch = patterns!.find((p) => p.headsign === "Centras via Saulėtekis")!;
    expect(full.stopIds).toEqual(["A", "B", "C"]);
    expect(branch.stopIds).toEqual(["A", "V", "C"]);
    // Both share direction_id 0 — the `key` field is identical, but the
    // patterns are distinct entries keyed by headsign in the wire format.
    expect(full.key).toBe("0");
    expect(branch.key).toBe("0");
  });

  it("falls back to headsign grouping when direction_id is absent", () => {
    const stops: GtfsStop[] = [
      { id: "A", name: "A", lat: 54.0, lon: 25.0, parentStation: "" },
      { id: "B", name: "B", lat: 54.1, lon: 25.1, parentStation: "" },
    ];
    const routes: GtfsRoute[] = [
      { id: "R1", shortName: "1", longName: "1", mode: "BUS" as const, color: "", textColor: "" },
    ];
    const trips: GtfsTrip[] = [
      { tripId: "T1", routeId: "R1", serviceId: "SVC1", headsign: "North" },
      { tripId: "T2", routeId: "R1", serviceId: "SVC1", headsign: "South" },
    ];
    const stopTimes: GtfsStopTime[] = [
      { tripId: "T1", stopId: "A", departureTime: "08:00:00", stopSequence: 1 },
      { tripId: "T1", stopId: "B", departureTime: "08:05:00", stopSequence: 2 },
      { tripId: "T2", stopId: "B", departureTime: "09:00:00", stopSequence: 1 },
      { tripId: "T2", stopId: "A", departureTime: "09:05:00", stopSequence: 2 },
    ];
    const services: GtfsService[] = [{
      serviceId: "SVC1",
      monday: true, tuesday: true, wednesday: true,
      thursday: true, friday: true, saturday: true, sunday: true,
      startDate: "20260101", endDate: "20261231",
    }];

    const { routingInput } = buildIndexes(stops, routes, trips, stopTimes, services, []);
    const patterns = routingInput.routes.find((r) => r.routeId === "R1")!.directionPatterns;
    expect(patterns).toHaveLength(2);
    const headsigns = patterns!.map((p) => p.headsign).sort();
    expect(headsigns).toEqual(["North", "South"]);
  });
});
