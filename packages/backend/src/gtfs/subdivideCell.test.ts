import { describe, it, expect } from "vitest";
import { subdivideCell } from "./subdivideCell.js";
import { compressTileBytes } from "./scheduleTileBrotli.js";
import { buildTileForCell } from "./buildTileForCell.js";
import {
  encodeScheduleTile, scheduleCellBounds, scheduleTileCoordAt, leafSuffixForPoint,
  bisectQuadrant, MAX_SUBDIVISION_DEPTH, decodeScheduleTile,
} from "@pt/shared";
import { decompressTileBytes } from "./scheduleTileBrotli.js";
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

const ROUTE: GtfsRoute = { id: "R1", shortName: "1", longName: "Line", mode: "BUS", color: "FF6600", textColor: "FFFFFF" };
const TRIP: GtfsTrip = { tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown" };

// Place N stops spread across all four quadrants of cell (x,y), one trip each.
function spreadCell(x: number, y: number, n: number) {
  const b = scheduleCellBounds(x, y);
  const stops: GtfsStop[] = [];
  const stopTimes: Record<string, { tripId: string; departureSec: number }[]> = {};
  const quarterLat = (b.maxLat - b.minLat) / 4;
  const quarterLon = (b.maxLon - b.minLon) / 4;
  for (let i = 0; i < n; i++) {
    // Alternate quadrants: SW, SE, NW, NE so a split always makes progress.
    const north = (i % 4) >= 2;
    const east = (i % 4) % 2 === 1;
    const lat = b.minLat + (north ? 3 : 1) * quarterLat;
    const lon = b.minLon + (east ? 3 : 1) * quarterLon;
    const id = `S${i}`;
    stops.push({ id, name: id, lat, lon, parentStation: "" });
    stopTimes[id] = [{ tripId: "T1", departureSec: 8 * 3600 + i }];
  }
  return { stops, stopTimes };
}

// A DENSE cell: `perQuad` stops in EACH of the four quadrants, every stop on a
// DISTINCT trip (T0..T{N-1}) with a distinct headsign, and a distinct route per
// trip — so the encoded payload's string table is non-trivial (≈ the real-feed
// shape) and a 10-stop quadrant compresses to a few hundred bytes rather than the
// ~236-251 B single-stop brotli FLOOR. This is what lets the happy-path
// (leaves come UNDER a realistic cap) actually be asserted: with `cap:120` even a
// single stop is already oversized, so cap=120 only ever exercises the
// OVERSIZED path.
//
// MEASURED TARGETS (executor: confirm on your machine; nudge perQuad/cap if the
// brotli floor differs — keep concrete numbers, do not switch to a fuzzy range):
//   - 4-quadrant root (40 stops)        ≈ 586 B brotli
//   - one 10-stop quadrant              ≈ 341 B brotli
// so `cap:400` splits the root (586 > 400) but each 10-stop quadrant leaf (341)
// comes UNDER cap → `leaves.every(l => !l.oversized)`.
function denseSpread(x: number, y: number, perQuad: number) {
  const b = scheduleCellBounds(x, y);
  const qLat = (b.maxLat - b.minLat) / 4;
  const qLon = (b.maxLon - b.minLon) / 4;
  const stops: GtfsStop[] = [];
  const routes: GtfsRoute[] = [];
  const trips: GtfsTrip[] = [];
  const stopTimes: Record<string, { tripId: string; departureSec: number }[]> = {};
  let n = 0;
  for (let q = 0 as 0 | 1 | 2 | 3; q <= 3; q = (q + 1) as 0 | 1 | 2 | 3) {
    const north = (q & 2) !== 0;
    const east = (q & 1) !== 0;
    for (let k = 0; k < perQuad; k++) {
      const id = `S${n}`;
      const tripId = `T${n}`;
      const routeId = `R${n}`;
      // Jitter within the quadrant so stops are not all coincident (distinct coords).
      const lat = b.minLat + (north ? 3 : 1) * qLat + (k - perQuad / 2) * (qLat / (perQuad * 4));
      const lon = b.minLon + (east ? 3 : 1) * qLon + (k - perQuad / 2) * (qLon / (perQuad * 4));
      stops.push({ id, name: `Stop ${id}`, lat, lon, parentStation: "" });
      routes.push({ id: routeId, shortName: `${n}`, longName: `Line ${n}`, mode: "BUS", color: "FF6600", textColor: "FFFFFF" });
      trips.push({ tripId, routeId, serviceId: "SVC", headsign: `Headsign ${n}` });
      stopTimes[id] = [{ tripId, departureSec: 8 * 3600 + n }];
      n++;
    }
  }
  return { stops, routes, trips, stopTimes };
}

// Like denseSpread but confines ALL stops to a single top-level quadrant of the
// cell, spread across THAT quadrant's four sub-quadrants. Used to prove a dense
// one-corner district still subdivides: at depth 0 every stop is in `topQuadrant`,
// so the first split descends into that one quadrant (bbox halves) and the cluster
// separates at depth 2. Tile bytes are position-independent, so the 40-stop /
// 10-stop byte profile matches `denseSpread` — cap:400 splits the same way.
function denseInQuadrant(x: number, y: number, topQuadrant: 0 | 1 | 2 | 3, perSubQuad: number) {
  const top = bisectQuadrant(scheduleCellBounds(x, y), topQuadrant);
  const qLat = (top.maxLat - top.minLat) / 4;
  const qLon = (top.maxLon - top.minLon) / 4;
  const stops: GtfsStop[] = [];
  const routes: GtfsRoute[] = [];
  const trips: GtfsTrip[] = [];
  const stopTimes: Record<string, { tripId: string; departureSec: number }[]> = {};
  let n = 0;
  for (let q = 0 as 0 | 1 | 2 | 3; q <= 3; q = (q + 1) as 0 | 1 | 2 | 3) {
    const north = (q & 2) !== 0;
    const east = (q & 1) !== 0;
    for (let k = 0; k < perSubQuad; k++) {
      const id = `S${n}`, tripId = `T${n}`, routeId = `R${n}`;
      const lat = top.minLat + (north ? 3 : 1) * qLat + (k - perSubQuad / 2) * (qLat / (perSubQuad * 4));
      const lon = top.minLon + (east ? 3 : 1) * qLon + (k - perSubQuad / 2) * (qLon / (perSubQuad * 4));
      stops.push({ id, name: `Stop ${id}`, lat, lon, parentStation: "" });
      routes.push({ id: routeId, shortName: `${n}`, longName: `Line ${n}`, mode: "BUS", color: "FF6600", textColor: "FFFFFF" });
      trips.push({ tripId, routeId, serviceId: "SVC", headsign: `Headsign ${n}` });
      stopTimes[id] = [{ tripId, departureSec: 8 * 3600 + n }];
      n++;
    }
  }
  return { stops, routes, trips, stopTimes };
}

function args(canonical: CanonicalStore, cellStops: GtfsStop[], x: number, y: number) {
  return {
    canonical, cellStops, bundleHash: "h", cityId: "paris",
    cellX: x, cellY: y,
    resolveRouteColor: () => undefined, resolveRouteSubMode: () => undefined,
  };
}
const noYield = async () => {};

describe("subdivideCell", () => {
  it("under-cap cell returns a single root leaf (suffix '')", async () => {
    const x = 906, y = 28;
    const { stops, stopTimes } = spreadCell(x, y, 4);
    const canonical = mkCanonical({ stops, routes: [ROUTE], trips: [TRIP], services: [STD_SVC], stopTimes });
    const leaves = await subdivideCell(args(canonical, stops, x, y), { cap: 10_000_000, maxDepth: MAX_SUBDIVISION_DEPTH, yieldFn: noYield });
    expect(leaves).toHaveLength(1);
    expect(leaves[0]!.suffix).toBe("");
    expect(leaves[0]!.oversized).toBe(false);
    expect(leaves[0]!.stops.map((s) => s.id).sort()).toEqual(["S0", "S1", "S2", "S3"]);
  });

  it("over-cap cell splits into leaves that come UNDER cap (the happy path)", async () => {
    // DENSE fixture: 40 stops (10/quadrant), each a distinct trip+route+headsign,
    // so a 10-stop quadrant leaf compresses to a few hundred bytes — well clear of
    // the ~236-251 B single-stop brotli floor. With cap:400 the 4-quadrant root
    // (≈586 B) is over-cap and splits, but each 10-stop quadrant (≈341 B) lands
    // UNDER cap → every leaf is NOT oversized. (Executor: confirm the byte sizes
    // hold on your machine; nudge perQuad/cap if your brotli floor differs — keep
    // concrete numbers.)
    const x = 906, y = 28;
    const { stops, routes, trips, stopTimes } = denseSpread(x, y, 10);
    const canonical = mkCanonical({ stops, routes, trips, services: [STD_SVC], stopTimes });
    const leaves = await subdivideCell(args(canonical, stops, x, y), { cap: 400, maxDepth: 4, yieldFn: noYield });
    expect(leaves.length).toBeGreaterThan(1);
    expect(leaves.every((l) => l.oversized === false)).toBe(true);
    expect(leaves.every((l) => l.compressedBytes <= 400)).toBe(true);
  });

  it("a dense cluster entirely within ONE top-level quadrant still subdivides (regression: occupied>1 guard was too strong)", async () => {
    // All 40 stops fall in the cell's NE (quadrant 3) at depth 0 — a dense district
    // in one corner of the 6 km cell. A prior `occupied > 1` recursion guard would
    // have emitted this as a SINGLE oversized leaf. Correctly, depth 0 descends into
    // quadrant 3 (the bbox halves) and the cluster separates across quadrant 3's
    // sub-quadrants at depth 2, each leaf landing UNDER cap. Proof of the fix: every
    // leaf is NOT oversized, and the suffixes start with the top quadrant digit "3-".
    const x = 906, y = 28;
    const { stops, routes, trips, stopTimes } = denseInQuadrant(x, y, 3, 10);
    const canonical = mkCanonical({ stops, routes, trips, services: [STD_SVC], stopTimes });
    const leaves = await subdivideCell(args(canonical, stops, x, y), { cap: 400, maxDepth: 4, yieldFn: noYield });
    expect(leaves.length).toBeGreaterThan(1);
    expect(leaves.every((l) => l.oversized === false)).toBe(true);
    expect(leaves.every((l) => l.compressedBytes <= 400)).toBe(true);
    expect(leaves.every((l) => l.suffix.startsWith("3-"))).toBe(true);
  });

  it("over-cap cell with stops spread across quadrants splits into >1 OVERSIZED leaf (the path — single-stop floor exceeds the tiny cap)", async () => {
    const x = 906, y = 28;
    const { stops, stopTimes } = spreadCell(x, y, 4);
    const canonical = mkCanonical({ stops, routes: [ROUTE], trips: [TRIP], services: [STD_SVC], stopTimes });
    // cap:120 is BELOW the ~236-251 B single-stop brotli floor, so the root splits
    // all the way down to one stop per leaf and EVERY leaf stays oversized — this
    // honestly exercises the oversized-leaf path, not a "leaf under cap" path.
    const leaves = await subdivideCell(args(canonical, stops, x, y), { cap: 120, maxDepth: MAX_SUBDIVISION_DEPTH, yieldFn: noYield });
    expect(leaves.length).toBeGreaterThan(1);
    expect(leaves.every((l) => l.oversized === true)).toBe(true);
    for (const leaf of leaves) {
      expect(leaf.suffix.length).toBeGreaterThan(0);
      expect(leaf.compressedBytes).toBeGreaterThan(0);
    }
    // Emission order is fixed pre-order 0→3 (suffixes sort lexically by digit path).
    const suffixes = leaves.map((l) => l.suffix);
    expect([...suffixes]).toEqual([...suffixes].sort());
  });

  it("termination — single over-cap stop emits one oversized leaf (guard 3: >1 stop is false)", async () => {
    const x = 906, y = 28;
    const b = scheduleCellBounds(x, y);
    const stops: GtfsStop[] = [{ id: "MEGA", name: "MEGA", lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2, parentStation: "" }];
    const stopTimes = { MEGA: Array.from({ length: 50 }, (_, i) => ({ tripId: "T1", departureSec: 8 * 3600 + i })) };
    const canonical = mkCanonical({ stops, routes: [ROUTE], trips: [TRIP], services: [STD_SVC], stopTimes });
    const leaves = await subdivideCell(args(canonical, stops, x, y), { cap: 1, maxDepth: MAX_SUBDIVISION_DEPTH, yieldFn: noYield });
    expect(leaves).toHaveLength(1);
    expect(leaves[0]!.oversized).toBe(true);
    expect(leaves[0]!.stops).toHaveLength(1);
  });

  it("termination — all-coincident stops recurse to maxDepth then emit ONE oversized leaf (no infinite recursion)", async () => {
    const x = 906, y = 28;
    const b = scheduleCellBounds(x, y);
    const lat = (b.minLat + b.maxLat) / 2, lon = (b.minLon + b.maxLon) / 2;
    const stops: GtfsStop[] = Array.from({ length: 5 }, (_, i) => ({ id: `C${i}`, name: `C${i}`, lat, lon, parentStation: "" }));
    const stopTimes: Record<string, { tripId: string; departureSec: number }[]> = {};
    for (const s of stops) stopTimes[s.id] = [{ tripId: "T1", departureSec: 8 * 3600 }];
    const canonical = mkCanonical({ stops, routes: [ROUTE], trips: [TRIP], services: [STD_SVC], stopTimes });
    const leaves = await subdivideCell(args(canonical, stops, x, y), { cap: 1, maxDepth: MAX_SUBDIVISION_DEPTH, yieldFn: noYield });
    expect(leaves).toHaveLength(1);
    expect(leaves[0]!.oversized).toBe(true);
    expect(leaves[0]!.stops).toHaveLength(5);
  });

  it("termination — max depth halts recursion (guard 2)", async () => {
    const x = 906, y = 28;
    const { stops, stopTimes } = spreadCell(x, y, 4);
    const canonical = mkCanonical({ stops, routes: [ROUTE], trips: [TRIP], services: [STD_SVC], stopTimes });
    const leaves = await subdivideCell(args(canonical, stops, x, y), { cap: 1, maxDepth: 1, yieldFn: noYield });
    // With maxDepth=1 every leaf suffix has exactly one digit; recursion stops there.
    for (const leaf of leaves) expect(leaf.suffix).toMatch(/^[0-3]$/);
  });

  it("empty quadrants are dropped — a parent whose stops fall in 2 of 4 quadrants yields exactly 2 non-empty leaves", async () => {
    const x = 906, y = 28;
    const b = scheduleCellBounds(x, y);
    const quarterLat = (b.maxLat - b.minLat) / 4, quarterLon = (b.maxLon - b.minLon) / 4;
    // Two stops in SW, two in NE — SE and NW are empty.
    const sw = { lat: b.minLat + quarterLat, lon: b.minLon + quarterLon };
    const ne = { lat: b.minLat + 3 * quarterLat, lon: b.minLon + 3 * quarterLon };
    const stops: GtfsStop[] = [
      { id: "A", name: "A", lat: sw.lat, lon: sw.lon, parentStation: "" },
      { id: "B", name: "B", lat: sw.lat, lon: sw.lon, parentStation: "" },
      { id: "C", name: "C", lat: ne.lat, lon: ne.lon, parentStation: "" },
      { id: "D", name: "D", lat: ne.lat, lon: ne.lon, parentStation: "" },
    ];
    const stopTimes: Record<string, { tripId: string; departureSec: number }[]> = {};
    for (const s of stops) stopTimes[s.id] = [{ tripId: "T1", departureSec: 8 * 3600 }];
    const canonical = mkCanonical({ stops, routes: [ROUTE], trips: [TRIP], services: [STD_SVC], stopTimes });
    const leaves = await subdivideCell(args(canonical, stops, x, y), { cap: 120, maxDepth: 1, yieldFn: noYield });
    expect(leaves).toHaveLength(2);
    expect(leaves.map((l) => l.suffix).sort()).toEqual(["0", "3"]); // SW=0, NE=3
  });

  it("determinism — two runs over the same inputs produce byte-identical leaf files and suffixes", async () => {
    const x = 906, y = 28;
    const { stops, stopTimes } = spreadCell(x, y, 4);
    const canonical = mkCanonical({ stops, routes: [ROUTE], trips: [TRIP], services: [STD_SVC], stopTimes });
    const opts = { cap: 120, maxDepth: MAX_SUBDIVISION_DEPTH, yieldFn: noYield };
    const a = await subdivideCell(args(canonical, stops, x, y), opts);
    const b = await subdivideCell(args(canonical, stops, x, y), opts);
    expect(a.map((l) => l.suffix)).toEqual(b.map((l) => l.suffix));
    for (let i = 0; i < a.length; i++) {
      expect(Buffer.compare(Buffer.from(a[i]!.bytes), Buffer.from(b[i]!.bytes))).toBe(0);
    }
  });

  it("determinism — shuffling input stop order yields an identical split", async () => {
    const x = 906, y = 28;
    const { stops, stopTimes } = spreadCell(x, y, 4);
    const canonical = mkCanonical({ stops, routes: [ROUTE], trips: [TRIP], services: [STD_SVC], stopTimes });
    const opts = { cap: 120, maxDepth: MAX_SUBDIVISION_DEPTH, yieldFn: noYield };
    const a = await subdivideCell(args(canonical, stops, x, y), opts);
    const shuffled = [...stops].reverse();
    const b = await subdivideCell(args(canonical, shuffled, x, y), opts);
    expect(a.map((l) => l.suffix).sort()).toEqual(b.map((l) => l.suffix).sort());
  });

  it("differential fidelity — each stop's (tripId, departureSec) in its owning leaf equals the unsplit tile's", async () => {
    const x = 906, y = 28;
    const { stops, stopTimes } = spreadCell(x, y, 4);
    const canonical = mkCanonical({ stops, routes: [ROUTE], trips: [TRIP], services: [STD_SVC], stopTimes });
    // Unsplit reference.
    const unsplit = decodeScheduleTile(decompressTileBytes(compressTileBytes(encodeScheduleTile(
      buildTileForCell({ canonical, cellStops: stops, bundleHash: "h", cityId: "paris", tileSize: 6000, resolveRouteColor: () => undefined, resolveRouteSubMode: () => undefined }),
    ))));
    const refFor = (tile: ReturnType<typeof decodeScheduleTile>, stopId: string) =>
      Array.from(tile.stops[stopId]!.tripIxs).map((ix, k) => [tile.stringTable[tile.trips[ix]!.tripIdIx], tile.stops[stopId]!.departureSecs[k]]);

    const leaves = await subdivideCell(args(canonical, stops, x, y), { cap: 120, maxDepth: MAX_SUBDIVISION_DEPTH, yieldFn: noYield });
    for (const stop of stops) {
      const owning = leaves.find((l) => l.stops.some((s) => s.id === stop.id));
      expect(owning, stop.id).toBeDefined();
      const leafTile = decodeScheduleTile(decompressTileBytes(owning!.bytes));
      expect(refFor(leafTile, stop.id)).toEqual(refFor(unsplit, stop.id));
    }
  });

  it("ownership cross-check — the leaf the build wrote a stop into equals leafSuffixForPoint(stop)", async () => {
    const x = 906, y = 28;
    const { stops, stopTimes } = spreadCell(x, y, 4);
    const canonical = mkCanonical({ stops, routes: [ROUTE], trips: [TRIP], services: [STD_SVC], stopTimes });
    const cellBounds = scheduleCellBounds(x, y);
    const leaves = await subdivideCell(args(canonical, stops, x, y), { cap: 120, maxDepth: MAX_SUBDIVISION_DEPTH, yieldFn: noYield });
    for (const leaf of leaves) {
      const depth = leaf.suffix === "" ? 0 : leaf.suffix.split("-").length;
      for (const stop of leaf.stops) {
        expect(leafSuffixForPoint(cellBounds, stop.lat, stop.lon, depth)).toBe(leaf.suffix);
      }
    }
  });

  it("yields to the event loop between compress calls (Part 2a stall guard)", async () => {
    const x = 906, y = 28;
    const { stops, stopTimes } = spreadCell(x, y, 4);
    const canonical = mkCanonical({ stops, routes: [ROUTE], trips: [TRIP], services: [STD_SVC], stopTimes });
    let yields = 0;
    await subdivideCell(args(canonical, stops, x, y), { cap: 120, maxDepth: MAX_SUBDIVISION_DEPTH, yieldFn: async () => { yields++; } });
    expect(yields).toBeGreaterThan(0);
  });
});
