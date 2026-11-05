import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle } from "./buildBundle.js";
import { decompressTileBytes } from "./scheduleTileBrotli.js";
import { decodeScheduleTile, SCHEDULE_TILE_SIZE_LABEL } from "@pt/shared";
import type { CanonicalStore, ServiceEntry } from "./canonical/CanonicalStore.js";
import type { GtfsStop, GtfsRoute, GtfsTrip, CompactStopTimes } from "./parser.js";

const STD_SVC: ServiceEntry = {
  serviceId: "SVC",
  monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: true,
  startDate: "20260101", endDate: "20261231",
  exceptions: new Map(),
};

function mkCanonical(setup: {
  stops: GtfsStop[]; routes: GtfsRoute[]; trips: GtfsTrip[]; services: ServiceEntry[];
  stopTimes: Record<string, { tripId: string; departureSec: number }[]>;
}): CanonicalStore {
  const tripIdToIx = new Map<string, number>();
  const tripIdsByIx: string[] = [];
  for (const t of setup.trips) { tripIdToIx.set(t.tripId, tripIdsByIx.length); tripIdsByIx.push(t.tripId); }
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
    stopCount: stops.size, compactStopTimesCount: stopTimesMap.size,
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

describe("buildBundle", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "ptn-build-")); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it("writes one .br tile per cell under <dataDir>/<bundleHash>/<SCHEDULE_TILE_SIZE_LABEL>/", async () => {
    const canonical = mkCanonical({
      stops: [
        { id: "S1", name: "S1", lat: 54.6892, lon: 25.2798, parentStation: "" },
        { id: "S2", name: "S2", lat: 54.6892, lon: 25.2799, parentStation: "" },
        { id: "S_K", name: "Krakow", lat: 50.0647, lon: 19.9450, parentStation: "" },
      ],
      routes: [{ id: "R1", shortName: "1", longName: "Line", mode: "BUS", color: "FF6600", textColor: "FFFFFF" }],
      trips: [{ tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown" }],
      services: [STD_SVC],
      stopTimes: {
        S1: [{ tripId: "T1", departureSec: 8 * 3600 }],
        S2: [{ tripId: "T1", departureSec: 8 * 3600 + 300 }],
        S_K: [{ tripId: "T1", departureSec: 9 * 3600 }],
      },
    });

    const result = await buildBundle({
      canonical, bundleHash: "deadbeefcafef00d", cityId: "vilnius", dataDir,
      resolveRouteColor: () => undefined, resolveRouteSubMode: () => undefined,
    });

    expect(result.tilesWritten).toBe(2);
    expect(result.bundleHash).toBe("deadbeefcafef00d");

    const bundleDir = join(dataDir, "deadbeefcafef00d");
    const tileDir = join(bundleDir, SCHEDULE_TILE_SIZE_LABEL);
    expect(statSync(bundleDir).isDirectory()).toBe(true);
    expect(statSync(tileDir).isDirectory()).toBe(true);
    const tileFiles = readdirSync(tileDir).filter((f) => f.endsWith(".br"));
    expect(tileFiles).toHaveLength(2);

    // Bundle dir contains only the tile-size sub-directory; the canonical
    // typed manifest lives at the dataDir root and is written by
    // `buildAndPublishBundle`, not by `buildBundle` directly.
    const bundleEntries = readdirSync(bundleDir);
    expect(bundleEntries).toEqual([SCHEDULE_TILE_SIZE_LABEL]);
  });

  it("written tile decodes back to a structurally-identical DecodedScheduleTile", async () => {
    const canonical = mkCanonical({
      stops: [{ id: "S1", name: "S1", lat: 54.6892, lon: 25.2798, parentStation: "" }],
      routes: [{ id: "R1", shortName: "1", longName: "Line", mode: "BUS", color: "FF6600", textColor: "FFFFFF" }],
      trips: [{ tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown" }],
      services: [STD_SVC],
      stopTimes: { S1: [{ tripId: "T1", departureSec: 8 * 3600 }] },
    });

    await buildBundle({
      canonical, bundleHash: "abc", cityId: "vilnius", dataDir,
      resolveRouteColor: () => undefined, resolveRouteSubMode: () => undefined,
    });

    const tileDir = join(dataDir, "abc", SCHEDULE_TILE_SIZE_LABEL);
    const [tileFile] = readdirSync(tileDir);
    const compressed = readFileSync(join(tileDir, tileFile!));
    const decompressed = decompressTileBytes(compressed);
    const decoded = decodeScheduleTile(decompressed);

    expect(decoded.bundleHash).toBe("abc");
    expect(decoded.cityId).toBe("vilnius");
    expect(decoded.routes[0]!.color).toBe("#FF6600");
    expect(Array.from(decoded.stops.S1!.departureSecs)).toEqual([8 * 3600]);
  });

  it("uses an atomic .tmp directory + rename: a mid-build crash leaves no half-written final dir", async () => {
    let cellsBuilt = 0;
    const canonical = mkCanonical({
      stops: [
        { id: "S1", name: "S1", lat: 54.6892, lon: 25.2798, parentStation: "" },
        { id: "S2", name: "S2", lat: 50.0647, lon: 19.9450, parentStation: "" },
      ],
      routes: [{ id: "R1", shortName: "1", longName: "Line", mode: "BUS", color: "FF6600", textColor: "FFFFFF" }],
      trips: [{ tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown" }],
      services: [STD_SVC],
      stopTimes: {
        S1: [{ tripId: "T1", departureSec: 8 * 3600 }],
        S2: [{ tripId: "T1", departureSec: 9 * 3600 }],
      },
    });
    const original = canonical.getCompactStopTimes.bind(canonical);
    (canonical as { getCompactStopTimes: typeof canonical.getCompactStopTimes }).getCompactStopTimes = (id) => {
      cellsBuilt++;
      if (cellsBuilt > 1) throw new Error("simulated mid-build crash");
      return original(id);
    };

    const err = await buildBundle({
      canonical, bundleHash: "halfbuilt", cityId: "vilnius", dataDir,
      resolveRouteColor: () => undefined, resolveRouteSubMode: () => undefined,
    }).then(
      () => { throw new Error("expected buildBundle to reject"); },
      (e: unknown) => e as Error,
    );
    // The per-cell catch enriches the error with the cellKey + bundle context —
    // the breadcrumb operators rely on to find which cell blew the cap — and
    // preserves the original via `cause`. Guard both so a refactor can't silently
    // drop the enrichment.
    expect(err.message).toMatch(/failed building tile for cell "/);
    expect(err.message).toMatch(/bundleHash=halfbuilt, cityId=vilnius/);
    expect((err.cause as Error | undefined)?.message).toMatch(/simulated mid-build/);

    expect(() => statSync(join(dataDir, "halfbuilt"))).toThrow();
    expect(() => statSync(join(dataDir, "halfbuilt.tmp"))).toThrow();
  });

  it("is idempotent: writing the same bundleHash twice replaces the dir atomically with identical bytes", async () => {
    const canonical = mkCanonical({
      stops: [{ id: "S1", name: "S1", lat: 54.6892, lon: 25.2798, parentStation: "" }],
      routes: [{ id: "R1", shortName: "1", longName: "Line", mode: "BUS", color: "FF6600", textColor: "FFFFFF" }],
      trips: [{ tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown" }],
      services: [STD_SVC],
      stopTimes: { S1: [{ tripId: "T1", departureSec: 8 * 3600 }] },
    });

    const opts = {
      canonical, bundleHash: "samehash", cityId: "vilnius", dataDir,
      resolveRouteColor: () => undefined, resolveRouteSubMode: () => undefined,
    };

    await buildBundle(opts);
    const tileDir = join(dataDir, "samehash", SCHEDULE_TILE_SIZE_LABEL);
    const [tileFile] = readdirSync(tileDir);
    const firstBytes = readFileSync(join(tileDir, tileFile!));

    await buildBundle(opts);
    const secondBytes = readFileSync(join(tileDir, tileFile!));

    expect(Buffer.compare(firstBytes, secondBytes)).toBe(0);
  });

  it("a trip touching stops in two cells appears in both tiles' decoded `trips` arrays", async () => {
    // Vilnius S1 lands in one cell; Krakow S_K lands in another. The shared
    // trip T1 visits both, so each tile must independently carry T1 in its
    // trips array — `buildTileForCell` is invoked twice and must NOT share
    // intern state across cells (which would silently empty the second
    // cell's trip list while the file count assertion still passes).
    const canonical = mkCanonical({
      stops: [
        { id: "S1", name: "S1", lat: 54.6892, lon: 25.2798, parentStation: "" },
        { id: "S_K", name: "Krakow", lat: 50.0647, lon: 19.9450, parentStation: "" },
      ],
      routes: [{ id: "R1", shortName: "1", longName: "Line", mode: "BUS", color: "FF6600", textColor: "FFFFFF" }],
      trips: [{ tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown" }],
      services: [STD_SVC],
      stopTimes: {
        S1: [{ tripId: "T1", departureSec: 8 * 3600 }],
        S_K: [{ tripId: "T1", departureSec: 12 * 3600 }],
      },
    });

    await buildBundle({
      canonical, bundleHash: "twocells", cityId: "vilnius", dataDir,
      resolveRouteColor: () => undefined, resolveRouteSubMode: () => undefined,
    });

    const tileDir = join(dataDir, "twocells", SCHEDULE_TILE_SIZE_LABEL);
    const tileFiles = readdirSync(tileDir).filter((f) => f.endsWith(".br"));
    expect(tileFiles).toHaveLength(2);

    let foundInS1Cell = false;
    let foundInSKCell = false;
    for (const tileFile of tileFiles) {
      const decoded = decodeScheduleTile(decompressTileBytes(readFileSync(join(tileDir, tileFile))));
      const tripIds = decoded.trips.map((t) => decoded.stringTable[t.tripIdIx]);
      expect(tripIds).toContain("T1");
      if (decoded.stops.S1) foundInS1Cell = true;
      if (decoded.stops.S_K) foundInSKCell = true;
    }
    expect(foundInS1Cell).toBe(true);
    expect(foundInSKCell).toBe(true);
  });
});
