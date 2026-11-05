import { describe, it, expect } from "vitest";
import { buildTileForCell } from "./buildTileForCell.js";
import type { CanonicalStore, ServiceEntry } from "./canonical/CanonicalStore.js";
import type { GtfsStop, GtfsRoute, GtfsTrip, CompactStopTimes } from "./parser.js";

interface Setup {
  stops: GtfsStop[];
  routes: GtfsRoute[];
  trips: GtfsTrip[];
  services: ServiceEntry[];
  /** Per-stop CompactStopTimes; trip-id strings (resolved from idx via tripStrings). */
  stopTimes: Record<string, { tripId: string; departureSec: number }[]>;
}

function mkCanonical(setup: Setup): CanonicalStore {
  // Intern trip IDs into a flat array; CompactStopTimes uses indices into it.
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

describe("buildTileForCell", () => {
  it("composes a single-trip single-stop tile with correct metadata", () => {
    const canonical = mkCanonical({
      stops: [{ id: "S1", name: "Stop One", lat: 54.69, lon: 25.27, parentStation: "" }],
      routes: [{ id: "R1", shortName: "1", longName: "Line One", mode: "BUS", color: "FF6600", textColor: "FFFFFF" }],
      trips: [{ tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown" }],
      services: [STD_SVC],
      stopTimes: { S1: [{ tripId: "T1", departureSec: 8 * 3600 }] },
    });
    const stops = [canonical.getStop("S1")!];

    const tile = buildTileForCell({
      canonical,
      cellStops: stops,
      bundleHash: "deadbeef",
      cityId: "vilnius",
      tileSize: 12000,
      resolveRouteColor: () => undefined,
      resolveRouteSubMode: () => undefined,
    });

    expect(tile.bundleHash).toBe("deadbeef");
    expect(tile.cityId).toBe("vilnius");
    expect(tile.tileSize).toBe(12000);
    expect(tile.routes).toHaveLength(1);
    expect(tile.routes[0]!.id).toBe("R1");
    expect(tile.routes[0]!.color).toBe("#FF6600");
    expect(tile.routes[0]!.subMode).toBeUndefined();
    expect(tile.calendar).toHaveLength(1);
    expect(tile.calendar[0]!.serviceId).toBe("SVC");
    expect(tile.calendar[0]!.days).toEqual([true, true, true, true, true, true, true]);
    expect(tile.trips).toHaveLength(1);
    expect(tile.stringTable[tile.trips[0]!.tripIdIx]).toBe("T1");
    expect(tile.stringTable[tile.trips[0]!.headsignIx]).toBe("Downtown");
    expect(Array.from(tile.stops.S1!.tripIxs)).toEqual([0]);
    expect(Array.from(tile.stops.S1!.departureSecs)).toEqual([8 * 3600]);
  });

  it("applies sub-mode color override when resolveRouteColor returns a value", () => {
    const canonical = mkCanonical({
      stops: [{ id: "S1", name: "S", lat: 54.69, lon: 25.27, parentStation: "" }],
      routes: [{ id: "R_EXP", shortName: "X1", longName: "Express", mode: "BUS", color: "AAAAAA", textColor: "FFFFFF" }],
      trips: [{ tripId: "T1", routeId: "R_EXP", serviceId: "SVC", headsign: "Express" }],
      services: [STD_SVC],
      stopTimes: { S1: [{ tripId: "T1", departureSec: 9 * 3600 }] },
    });

    const tile = buildTileForCell({
      canonical,
      cellStops: [canonical.getStop("S1")!],
      bundleHash: "x",
      cityId: "vilnius",
      tileSize: 12000,
      resolveRouteColor: (rid) => rid === "R_EXP" ? "#FFCC00" : undefined,
      resolveRouteSubMode: (rid) => rid === "R_EXP" ? "EXPRESS_BUS" : undefined,
    });

    expect(tile.routes[0]!.color).toBe("#FFCC00");
    expect(tile.routes[0]!.subMode).toBe("EXPRESS_BUS");
  });

  it("intern-dedupes repeated headsigns across trips", () => {
    const canonical = mkCanonical({
      stops: [{ id: "S1", name: "S", lat: 54.69, lon: 25.27, parentStation: "" }],
      routes: [{ id: "R1", shortName: "1", longName: "Line", mode: "BUS", color: "FF6600", textColor: "FFFFFF" }],
      trips: [
        { tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown" },
        { tripId: "T2", routeId: "R1", serviceId: "SVC", headsign: "Downtown" },
        { tripId: "T3", routeId: "R1", serviceId: "SVC", headsign: "Airport" },
      ],
      services: [STD_SVC],
      stopTimes: {
        S1: [
          { tripId: "T1", departureSec: 8 * 3600 },
          { tripId: "T2", departureSec: 9 * 3600 },
          { tripId: "T3", departureSec: 10 * 3600 },
        ],
      },
    });

    const tile = buildTileForCell({
      canonical,
      cellStops: [canonical.getStop("S1")!],
      bundleHash: "x", cityId: "vilnius", tileSize: 12000,
      resolveRouteColor: () => undefined,
      resolveRouteSubMode: () => undefined,
    });

    const downtownCount = tile.stringTable.filter((s) => s === "Downtown").length;
    expect(downtownCount).toBe(1);
    const airportCount = tile.stringTable.filter((s) => s === "Airport").length;
    expect(airportCount).toBe(1);
  });

  it("sorts each stop's columns ascending by departureSec (preserves CompactStopTimes order)", () => {
    const canonical = mkCanonical({
      stops: [{ id: "S1", name: "S", lat: 54.69, lon: 25.27, parentStation: "" }],
      routes: [{ id: "R1", shortName: "1", longName: "Line", mode: "BUS", color: "FF6600", textColor: "FFFFFF" }],
      trips: [
        { tripId: "T_LATE", routeId: "R1", serviceId: "SVC", headsign: "A" },
        { tripId: "T_EARLY", routeId: "R1", serviceId: "SVC", headsign: "A" },
      ],
      services: [STD_SVC],
      stopTimes: {
        S1: [
          { tripId: "T_LATE", departureSec: 9 * 3600 },
          { tripId: "T_EARLY", departureSec: 7 * 3600 },
        ],
      },
    });

    const tile = buildTileForCell({
      canonical,
      cellStops: [canonical.getStop("S1")!],
      bundleHash: "x", cityId: "vilnius", tileSize: 12000,
      resolveRouteColor: () => undefined,
      resolveRouteSubMode: () => undefined,
    });

    expect(Array.from(tile.stops.S1!.departureSecs)).toEqual([7 * 3600, 9 * 3600]);
    const tripIxs = Array.from(tile.stops.S1!.tripIxs);
    expect(tile.stringTable[tile.trips[tripIxs[0]!]!.tripIdIx]).toBe("T_EARLY");
    expect(tile.stringTable[tile.trips[tripIxs[1]!]!.tripIdIx]).toBe("T_LATE");
  });

  it("NFC-normalises stop and headsign strings before interning", () => {
    const NFC_E = "Café";
    const NFD_E = NFC_E.normalize("NFD");
    expect(NFC_E).not.toBe(NFD_E);
    expect(NFC_E.length).toBe(4);
    expect(NFD_E.length).toBe(5);

    const canonical = mkCanonical({
      stops: [{ id: "S1", name: "S", lat: 54.69, lon: 25.27, parentStation: "" }],
      routes: [{ id: "R1", shortName: "1", longName: "Line", mode: "BUS", color: "FF6600", textColor: "FFFFFF" }],
      trips: [
        { tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: NFC_E },
        { tripId: "T2", routeId: "R1", serviceId: "SVC", headsign: NFD_E },
      ],
      services: [STD_SVC],
      stopTimes: {
        S1: [
          { tripId: "T1", departureSec: 8 * 3600 },
          { tripId: "T2", departureSec: 9 * 3600 },
        ],
      },
    });

    const tile = buildTileForCell({
      canonical,
      cellStops: [canonical.getStop("S1")!],
      bundleHash: "x", cityId: "vilnius", tileSize: 12000,
      resolveRouteColor: () => undefined,
      resolveRouteSubMode: () => undefined,
    });

    const cafeCount = tile.stringTable.filter((s) => s === NFC_E).length;
    expect(cafeCount).toBe(1);
    expect(tile.stringTable.includes(NFD_E)).toBe(false);
  });

  it("aggregates trips across multiple cell stops (a trip touching two stops appears once in trips)", () => {
    const canonical = mkCanonical({
      stops: [
        { id: "S1", name: "S1", lat: 54.69, lon: 25.27, parentStation: "" },
        { id: "S2", name: "S2", lat: 54.6901, lon: 25.2701, parentStation: "" },
      ],
      routes: [{ id: "R1", shortName: "1", longName: "Line", mode: "BUS", color: "FF6600", textColor: "FFFFFF" }],
      trips: [{ tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown" }],
      services: [STD_SVC],
      stopTimes: {
        S1: [{ tripId: "T1", departureSec: 8 * 3600 }],
        S2: [{ tripId: "T1", departureSec: 8 * 3600 + 300 }],
      },
    });

    const tile = buildTileForCell({
      canonical,
      cellStops: [canonical.getStop("S1")!, canonical.getStop("S2")!],
      bundleHash: "x", cityId: "vilnius", tileSize: 12000,
      resolveRouteColor: () => undefined,
      resolveRouteSubMode: () => undefined,
    });

    expect(tile.trips).toHaveLength(1);
    expect(Array.from(tile.stops.S1!.tripIxs)).toEqual([0]);
    expect(Array.from(tile.stops.S2!.tripIxs)).toEqual([0]);
    expect(tile.stops.S1!.departureSecs[0]).toBe(8 * 3600);
    expect(tile.stops.S2!.departureSecs[0]).toBe(8 * 3600 + 300);
  });
});
