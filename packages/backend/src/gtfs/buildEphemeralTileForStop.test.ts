import { describe, it, expect } from "vitest";
import { getDeparturesFromTile } from "@pt/shared";
import { buildEphemeralTileForStop } from "./buildEphemeralTileForStop.js";
import type { CanonicalStore, ServiceEntry } from "./canonical/CanonicalStore.js";
import type { GtfsStop, GtfsRoute, GtfsTrip, CompactStopTimes } from "./parser.js";

interface Setup {
  stops: GtfsStop[];
  routes: GtfsRoute[];
  trips: GtfsTrip[];
  services: ServiceEntry[];
  stopTimes: Record<string, { tripId: string; departureSec: number }[]>;
}

function mkCanonical(setup: Setup): CanonicalStore {
  const tripIdToIx = new Map<string, number>();
  const tripIdsByIx: string[] = [];
  for (const trip of setup.trips) {
    const ix = tripIdsByIx.length;
    tripIdToIx.set(trip.tripId, ix);
    tripIdsByIx.push(trip.tripId);
  }

  const stopTimesMap = new Map<string, CompactStopTimes>();
  for (const [stopId, entries] of Object.entries(setup.stopTimes)) {
    const sorted = [...entries].sort((a, b) => a.departureSec - b.departureSec);
    stopTimesMap.set(stopId, {
      tripIdIdx: Uint32Array.from(sorted.map((e) => tripIdToIx.get(e.tripId)!)),
      departureSecs: Uint32Array.from(sorted.map((e) => e.departureSec)),
    });
  }

  const stops = new Map(setup.stops.map((s) => [s.id, s] as const));
  const routes = new Map(setup.routes.map((r) => [r.id, r] as const));
  const trips = new Map(setup.trips.map((t) => [t.tripId, t] as const));
  const services = new Map(setup.services.map((s) => [s.serviceId, s] as const));

  return {
    stopCount: stops.size,
    compactStopTimesCount: stopTimesMap.size,
    getCompactStopTimes: (id) => stopTimesMap.get(id),
    iterCompactStopTimes(cb) { for (const [id, ct] of stopTimesMap) cb(id, ct); },
    getTripIdForIx: (ix) => tripIdsByIx[ix],
    internTripStringCount: () => tripIdsByIx.length,
    getStop: (id) => stops.get(id),
    iterStops(cb) { for (const [id, s] of stops) cb(id, s); },
    getRoute: (id) => routes.get(id),
    iterRoutes(cb) { for (const [id, r] of routes) cb(id, r); },
    getTrip: (id) => trips.get(id),
    iterTrips(cb) { for (const [id, t] of trips) cb(id, t); },
    getService: (id) => services.get(id),
    iterServices(cb) { for (const [id, s] of services) cb(id, s); },
  };
}

const STD_SVC: ServiceEntry = {
  serviceId: "SVC",
  monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: true,
  startDate: "20260101",
  endDate: "20261231",
  exceptions: new Map(),
};

describe("buildEphemeralTileForStop", () => {
  it("includes a single trip touching the stop in the returned tile", () => {
    const canonical = mkCanonical({
      stops: [{ id: "S1", name: "Stop One", lat: 54.69, lon: 25.27, parentStation: "" }],
      routes: [{ id: "R1", shortName: "1", longName: "Line One", mode: "BUS", color: "FF6600", textColor: "FFFFFF" }],
      trips: [{ tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown" }],
      services: [STD_SVC],
      stopTimes: { S1: [{ tripId: "T1", departureSec: 8 * 3600 }] },
    });

    const tile = buildEphemeralTileForStop({
      canonical,
      stopId: "S1",
      resolveRouteColor: () => undefined,
      resolveRouteSubMode: () => undefined,
    });

    expect(tile).not.toBeNull();
    expect(Object.keys(tile!.stops)).toEqual(["S1"]);
    expect(tile!.trips).toHaveLength(1);
    expect(tile!.routes).toHaveLength(1);
    expect(tile!.routes[0]!.id).toBe("R1");
    expect(tile!.stringTable[tile!.trips[0]!.tripIdIx]).toBe("T1");
    expect(Array.from(tile!.stops.S1!.tripIxs)).toEqual([0]);
    expect(Array.from(tile!.stops.S1!.departureSecs)).toEqual([8 * 3600]);
  });

  it("returns null when the stopId is not present in canonical", () => {
    const canonical = mkCanonical({
      stops: [{ id: "S1", name: "Stop One", lat: 54.69, lon: 25.27, parentStation: "" }],
      routes: [{ id: "R1", shortName: "1", longName: "Line One", mode: "BUS", color: "FF6600", textColor: "FFFFFF" }],
      trips: [{ tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown" }],
      services: [STD_SVC],
      stopTimes: { S1: [{ tripId: "T1", departureSec: 8 * 3600 }] },
    });

    const tile = buildEphemeralTileForStop({
      canonical,
      stopId: "MISSING",
      resolveRouteColor: () => undefined,
      resolveRouteSubMode: () => undefined,
    });

    expect(tile).toBeNull();
  });

  it("uses the 'ephemeral' bundleHash sentinel so hex-only assertions flag it loudly", () => {
    const canonical = mkCanonical({
      stops: [{ id: "S1", name: "Stop One", lat: 54.69, lon: 25.27, parentStation: "" }],
      routes: [{ id: "R1", shortName: "1", longName: "Line One", mode: "BUS", color: "FF6600", textColor: "FFFFFF" }],
      trips: [{ tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown" }],
      services: [STD_SVC],
      stopTimes: { S1: [{ tripId: "T1", departureSec: 8 * 3600 }] },
    });

    const tile = buildEphemeralTileForStop({
      canonical,
      stopId: "S1",
      resolveRouteColor: () => undefined,
      resolveRouteSubMode: () => undefined,
    });

    expect(tile!.bundleHash).toBe("ephemeral");
    expect(tile!.cityId).toBe("ephemeral");
  });

  it("round-trips through getDeparturesFromTile to yield the scheduled departure", () => {
    const canonical = mkCanonical({
      stops: [{ id: "S1", name: "Stop One", lat: 54.69, lon: 25.27, parentStation: "" }],
      routes: [{ id: "R1", shortName: "1", longName: "Line One", mode: "BUS", color: "FF6600", textColor: "FFFFFF" }],
      trips: [{ tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown" }],
      services: [STD_SVC],
      stopTimes: { S1: [{ tripId: "T1", departureSec: 8 * 3600 }] },
    });

    const tile = buildEphemeralTileForStop({
      canonical,
      stopId: "S1",
      resolveRouteColor: () => undefined,
      resolveRouteSubMode: () => undefined,
    });
    expect(tile).not.toBeNull();

    // 2026-05-04 (Mon) at 07:00 local — 08:00 trip is +1h ahead.
    const now = new Date(2026, 4, 4, 7, 0, 0);
    const result = getDeparturesFromTile({
      tile: tile!,
      stopId: "S1",
      now,
      limit: 10,
      lookAheadHours: 2,
    });

    expect(result.serviceState).toBe("active");
    expect(result.departures).toHaveLength(1);
    const dep = result.departures[0]!;
    expect(dep.routeId).toBe("R1");
    expect(dep.tripId).toBe("T1");
    expect(dep.headsign).toBe("Downtown");
    const scheduled = new Date(dep.scheduledTime);
    expect(scheduled.getHours()).toBe(8);
    expect(scheduled.getMinutes()).toBe(0);

    // Tile-shape regression catch: a future refactor that drops a column
    // from `RouteRow` (color / shortName / mode) silently slips through
    // unless we assert here. The fixture's resolvers return undefined so
    // the route's color and subMode flow through the GTFS-fallback path.
    expect(dep.routeShortName).toBe("1");
    expect(dep.routeColor).toBe("#FF6600");
    expect(dep.mode).toBe("BUS");
    expect(dep.subMode).toBe("BUS"); // mode-fallback when no sub-mode override
    expect(dep.predictedTime).toBeUndefined(); // no RT injected
    expect(dep.delaySeconds).toBeUndefined();
    expect(dep.cancelled).toBeUndefined();
  });
});
