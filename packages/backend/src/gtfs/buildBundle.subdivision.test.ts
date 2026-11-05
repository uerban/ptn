import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle } from "./buildBundle.js";
import { scheduleCellBounds, SCHEDULE_TILE_SIZE_LABEL, MAX_SUBDIVISION_DEPTH } from "@pt/shared";
import type { CanonicalStore, ServiceEntry } from "./canonical/CanonicalStore.js";
import type { GtfsStop, GtfsRoute, GtfsTrip, CompactStopTimes } from "./parser.js";

const STD_SVC: ServiceEntry = {
  serviceId: "SVC",
  monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: true,
  startDate: "20260101", endDate: "20261231",
  exceptions: new Map(),
};
const ROUTE: GtfsRoute = { id: "R1", shortName: "1", longName: "Line", mode: "BUS", color: "FF6600", textColor: "FFFFFF" };
const TRIP: GtfsTrip = { tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown" };

// Accepts an explicit routes/trips/tripIdsByIx set so the DENSE fixture (distinct
// trip per stop) can build a non-trivial string table; defaults to the single
// R1/T1 pair for the sparse cases.
function mkCanonical(
  stops: GtfsStop[],
  stopTimes: Record<string, { tripId: string; departureSec: number }[]>,
  routesArr: GtfsRoute[] = [ROUTE],
  tripsArr: GtfsTrip[] = [TRIP],
): CanonicalStore {
  const tripIdsByIx: string[] = [];
  const tripIdToIx = new Map<string, number>();
  for (const t of tripsArr) { tripIdToIx.set(t.tripId, tripIdsByIx.length); tripIdsByIx.push(t.tripId); }
  const stopTimesMap = new Map<string, CompactStopTimes>();
  for (const [id, entries] of Object.entries(stopTimes)) {
    const sorted = [...entries].sort((a, b) => a.departureSec - b.departureSec);
    stopTimesMap.set(id, {
      tripIdIdx: Uint32Array.from(sorted.map((e) => tripIdToIx.get(e.tripId) ?? 0)),
      departureSecs: Uint32Array.from(sorted.map((e) => e.departureSec)),
    });
  }
  const stopMap = new Map(stops.map((s) => [s.id, s] as const));
  const routes = new Map(routesArr.map((r) => [r.id, r] as const));
  const trips = new Map(tripsArr.map((t) => [t.tripId, t] as const));
  const services = new Map([["SVC", STD_SVC]]);
  return {
    stopCount: stopMap.size, compactStopTimesCount: stopTimesMap.size,
    getCompactStopTimes: (id) => stopTimesMap.get(id),
    iterCompactStopTimes(cb) { for (const [id, ct] of stopTimesMap) cb(id, ct); },
    getTripIdForIx: (ix) => tripIdsByIx[ix],
    internTripStringCount: () => tripIdsByIx.length,
    getStop: (id) => stopMap.get(id),
    iterStops(cb) { for (const [id, s] of stopMap) cb(id, s); },
    getRoute: (id) => routes.get(id),
    iterRoutes(cb) { for (const [id, r] of routes) cb(id, r); },
    getTrip: (id) => trips.get(id),
    iterTrips(cb) { for (const [id, t] of trips) cb(id, t); },
    getService: (id) => services.get(id),
    iterServices(cb) { for (const [id, s] of services) cb(id, s); },
  };
}

// A SPARSE dense cell: stops span all four quadrants, all on the single T1 trip
// (small payload — used for the OVERSIZED-path test with cap:120).
function sparseCell(x: number, y: number, n: number) {
  const b = scheduleCellBounds(x, y);
  const qLat = (b.maxLat - b.minLat) / 4, qLon = (b.maxLon - b.minLon) / 4;
  const stops: GtfsStop[] = [];
  const stopTimes: Record<string, { tripId: string; departureSec: number }[]> = {};
  for (let i = 0; i < n; i++) {
    const north = (i % 4) >= 2, east = (i % 4) % 2 === 1;
    const id = `S${i}`;
    stops.push({ id, name: id, lat: b.minLat + (north ? 3 : 1) * qLat, lon: b.minLon + (east ? 3 : 1) * qLon, parentStation: "" });
    stopTimes[id] = [{ tripId: "T1", departureSec: 8 * 3600 + i }];
  }
  return { stops, stopTimes, cellKey: `${x}_${y}` };
}

// A genuinely DENSE cell: `perQuad` stops in EACH quadrant, each a DISTINCT trip
// + route + headsign so a 10-stop quadrant leaf clears the single-stop brotli
// floor and comes UNDER a realistic cap (cap:400) — exercises
function denseCell(x: number, y: number, perQuad: number) {
  const b = scheduleCellBounds(x, y);
  const qLat = (b.maxLat - b.minLat) / 4, qLon = (b.maxLon - b.minLon) / 4;
  const stops: GtfsStop[] = [];
  const routes: GtfsRoute[] = [];
  const trips: GtfsTrip[] = [];
  const stopTimes: Record<string, { tripId: string; departureSec: number }[]> = {};
  let i = 0;
  for (let q = 0 as 0 | 1 | 2 | 3; q <= 3; q = (q + 1) as 0 | 1 | 2 | 3) {
    const north = (q & 2) !== 0, east = (q & 1) !== 0;
    for (let k = 0; k < perQuad; k++) {
      const id = `S${i}`, tripId = `T${i}`, routeId = `R${i}`;
      const lat = b.minLat + (north ? 3 : 1) * qLat + (k - perQuad / 2) * (qLat / (perQuad * 4));
      const lon = b.minLon + (east ? 3 : 1) * qLon + (k - perQuad / 2) * (qLon / (perQuad * 4));
      stops.push({ id, name: `Stop ${id}`, lat, lon, parentStation: "" });
      routes.push({ id: routeId, shortName: `${i}`, longName: `Line ${i}`, mode: "BUS", color: "FF6600", textColor: "FFFFFF" });
      trips.push({ tripId, routeId, serviceId: "SVC", headsign: `Headsign ${i}` });
      stopTimes[id] = [{ tripId, departureSec: 8 * 3600 + i }];
      i++;
    }
  }
  return { stops, routes, trips, stopTimes, cellKey: `${x}_${y}` };
}

describe("buildBundle — per-cell subdivision", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "ptn-subdiv-")); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it("an over-cap cell writes >1 `<cell>-<suffix>.br` leaf and NO bare `<cell>.br`", async () => {
    const { stops, stopTimes, cellKey } = sparseCell(906, 28, 4);
    const canonical = mkCanonical(stops, stopTimes);
    const result = await buildBundle({
      canonical, bundleHash: "subdiv01", cityId: "paris", dataDir,
      cap: 120, maxDepth: MAX_SUBDIVISION_DEPTH,
      resolveRouteColor: () => undefined, resolveRouteSubMode: () => undefined,
    });

    const tileDir = join(dataDir, "subdiv01", SCHEDULE_TILE_SIZE_LABEL);
    const files = readdirSync(tileDir).filter((f) => f.endsWith(".br"));
    const leafFiles = files.filter((f) => f.startsWith(`${cellKey}-`));
    expect(leafFiles.length).toBeGreaterThan(1);
    expect(existsSync(join(tileDir, `${cellKey}.br`))).toBe(false);

    // The result carries the plan + stats.
    expect(result.subdivisions[cellKey]).toBeDefined();
    expect(result.subdivisions[cellKey]!.leaves.length).toBe(leafFiles.length);
    expect(result.stats.subdividedCells).toBe(1);
    expect(result.stats.maxDepth).toBeGreaterThanOrEqual(1);
    expect(result.stats.maxLeafBytes).toBeGreaterThan(0);
    expect(result.stats.cellCount).toBe(1);
  });

  it("a DENSE over-cap cell subdivides into UNDER-cap leaves ( happy path)", async () => {
    // 40 stops (10/quadrant), distinct trip/route/headsign each → a 10-stop
    // quadrant leaf (~341 B) is under cap:400, while the 4-quadrant root (~586 B)
    // is over → splits to non-oversized leaves. (Executor: confirm the byte sizes
    // hold; nudge perQuad/cap if your brotli floor differs — keep concrete numbers.)
    const { stops, routes, trips, stopTimes, cellKey } = denseCell(906, 28, 10);
    const canonical = mkCanonical(stops, stopTimes, routes, trips);
    const result = await buildBundle({
      canonical, bundleHash: "dense01", cityId: "paris", dataDir,
      cap: 400, maxDepth: 4,
      resolveRouteColor: () => undefined, resolveRouteSubMode: () => undefined,
    });
    const plan = result.subdivisions[cellKey];
    expect(plan).toBeDefined();
    expect(plan!.leaves.length).toBeGreaterThan(1);
    expect(plan!.leaves.some((l) => l.oversized === false)).toBe(true);
    // No leaf could be brought under cap only if it is irreducible; with this
    // fixture every leaf fits, so oversizedLeaves must be consistent (0 here).
    expect(result.stats.oversizedLeaves).toBe(plan!.leaves.filter((l) => l.oversized).length);
    expect(result.stats.oversizedLeaves).toBe(0);
  });

  it("the recorded plan is a bijection with on-disk leaf files", async () => {
    const { stops, stopTimes, cellKey } = sparseCell(906, 28, 4);
    const canonical = mkCanonical(stops, stopTimes);
    const result = await buildBundle({
      canonical, bundleHash: "subdiv02", cityId: "paris", dataDir,
      cap: 120, maxDepth: MAX_SUBDIVISION_DEPTH,
      resolveRouteColor: () => undefined, resolveRouteSubMode: () => undefined,
    });
    const tileDir = join(dataDir, "subdiv02", SCHEDULE_TILE_SIZE_LABEL);
    const onDisk = new Set(readdirSync(tileDir).filter((f) => f.endsWith(".br")));
    const planned = new Set(result.subdivisions[cellKey]!.leaves.map((l) => `${cellKey}-${l.suffix}.br`));
    expect(planned).toEqual(onDisk);
  });

  it("under-cap cells are unaffected — bare `<cell>.br` only, no subdivisions entry", async () => {
    const stops: GtfsStop[] = [{ id: "S1", name: "S1", lat: 54.6892, lon: 25.2798, parentStation: "" }];
    const canonical = mkCanonical(stops, { S1: [{ tripId: "T1", departureSec: 8 * 3600 }] });
    const result = await buildBundle({
      canonical, bundleHash: "plain01", cityId: "vilnius", dataDir,
      resolveRouteColor: () => undefined, resolveRouteSubMode: () => undefined,
    });
    expect(Object.keys(result.subdivisions)).toHaveLength(0);
    expect(result.stats.subdividedCells).toBe(0);
    expect(result.stats.cellCount).toBe(1);
    const tileDir = join(dataDir, "plain01", SCHEDULE_TILE_SIZE_LABEL);
    expect(readdirSync(tileDir).filter((f) => f.endsWith(".br"))).toHaveLength(1);
  });

  it("returns stopTileCoords matching the on-disk tile filenames (subdivided cell)", async () => {
    // A subdivided cell: every mapped stop's coord must be a tile that was
    // written, and the subdivided cell's stops carry a `-<suffix>` coord (NOT
    // the bare cellKey) — single-sourcing the build's own leaf assignment.
    const { stops, stopTimes, cellKey } = sparseCell(906, 28, 4);
    const canonical = mkCanonical(stops, stopTimes);
    const result = await buildBundle({
      canonical, bundleHash: "coords01", cityId: "paris", dataDir,
      cap: 120, maxDepth: MAX_SUBDIVISION_DEPTH,
      resolveRouteColor: () => undefined, resolveRouteSubMode: () => undefined,
    });

    const tileDir = join(dataDir, "coords01", SCHEDULE_TILE_SIZE_LABEL);
    const writtenCoords = new Set(
      readdirSync(tileDir).filter((f) => f.endsWith(".br")).map((f) => f.slice(0, -3)),
    );

    // Every stop in the cell is mapped.
    expect(result.stopTileCoords.size).toBe(stops.length);
    // Every mapped coord is a tile that was actually written.
    for (const coords of result.stopTileCoords.values()) {
      expect(writtenCoords.has(coords)).toBe(true);
    }
    // The subdivided cell's stops carry a `-<suffix>` coord, not the bare cellKey.
    expect(result.subdivisions[cellKey]).toBeDefined();
    const subdividedStops = [...result.stopTileCoords.values()].filter((c) =>
      c.startsWith(`${cellKey}-`),
    );
    expect(subdividedStops.length).toBeGreaterThan(0);
    // No stop in this single-cell build carries the bare cellKey (the cell split).
    expect([...result.stopTileCoords.values()].some((c) => c === cellKey)).toBe(false);
  });

  it("maps every stop in an unsubdivided cell to the bare cellKey", async () => {
    const stops: GtfsStop[] = [{ id: "S1", name: "S1", lat: 54.6892, lon: 25.2798, parentStation: "" }];
    const canonical = mkCanonical(stops, { S1: [{ tripId: "T1", departureSec: 8 * 3600 }] });
    const result = await buildBundle({
      canonical, bundleHash: "coords02", cityId: "vilnius", dataDir,
      resolveRouteColor: () => undefined, resolveRouteSubMode: () => undefined,
    });
    expect(Object.keys(result.subdivisions)).toHaveLength(0);
    const cellKey = [...result.stopTileCoords.values()][0]!;
    expect(result.stopTileCoords.get("S1")).toBe(cellKey);
    // The mapped coord is the bare on-disk tile.
    const tileDir = join(dataDir, "coords02", SCHEDULE_TILE_SIZE_LABEL);
    expect(existsSync(join(tileDir, `${cellKey}.br`))).toBe(true);
  });

  it("maps an irreducible-oversized stop to the bare cellKey", async () => {
    // One stop whose own tile exceeds the (tiny) cap → bare `<cell>.br`, NO
    // subdivisions entry. The stop must still be mapped to the bare cellKey.
    const b = scheduleCellBounds(906, 28);
    const stops: GtfsStop[] = [
      { id: "MEGA", name: "MEGA", lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2, parentStation: "" },
    ];
    const stopTimes = { MEGA: Array.from({ length: 50 }, (_, i) => ({ tripId: "T1", departureSec: 8 * 3600 + i })) };
    const canonical = mkCanonical(stops, stopTimes);
    const result = await buildBundle({
      canonical, bundleHash: "coords03", cityId: "paris", dataDir,
      cap: 1, maxDepth: MAX_SUBDIVISION_DEPTH,
      resolveRouteColor: () => undefined, resolveRouteSubMode: () => undefined,
    });
    expect(result.subdivisions["906_28"]).toBeUndefined();
    expect(result.stopTileCoords.get("MEGA")).toBe("906_28");
  });

  it("a single over-cap stop (unsplittable) writes the BARE `<cell>.br` + NO subdivisions entry, counted oversized", async () => {
    // One stop whose own tile exceeds the (tiny) cap. subdivideCell cannot split a
    // single stop, so it returns one empty-suffix leaf; buildBundle must write the
    // bare `<cell>.br` (NOT `<cell>-.br`, which the read-side leaf regex rejects)
    // and record no subdivisions entry — but still count it oversized so the alarm
    // fires. This pins the empty-suffix contract-freeze fix.
    const b = scheduleCellBounds(906, 28);
    const stops: GtfsStop[] = [
      { id: "MEGA", name: "MEGA", lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2, parentStation: "" },
    ];
    const stopTimes = { MEGA: Array.from({ length: 50 }, (_, i) => ({ tripId: "T1", departureSec: 8 * 3600 + i })) };
    const canonical = mkCanonical(stops, stopTimes);
    const result = await buildBundle({
      canonical, bundleHash: "mega01", cityId: "paris", dataDir,
      cap: 1, maxDepth: MAX_SUBDIVISION_DEPTH,
      resolveRouteColor: () => undefined, resolveRouteSubMode: () => undefined,
    });
    const tileDir = join(dataDir, "mega01", SCHEDULE_TILE_SIZE_LABEL);
    const files = readdirSync(tileDir).filter((f) => f.endsWith(".br"));
    expect(files).toEqual(["906_28.br"]); // bare file only
    expect(existsSync(join(tileDir, "906_28-.br"))).toBe(false); // NOT the dash form
    expect(result.subdivisions["906_28"]).toBeUndefined(); // not recorded as subdivided
    expect(result.stats.subdividedCells).toBe(0);
    expect(result.stats.oversizedLeaves).toBe(1); // still alarmed
  });
});
