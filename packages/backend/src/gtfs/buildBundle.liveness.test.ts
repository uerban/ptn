import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalStore, ServiceEntry } from "./canonical/CanonicalStore.js";
import type { GtfsStop, GtfsRoute, GtfsTrip, CompactStopTimes } from "./parser.js";

// This test must ISOLATE the explicit `await setImmediate` yield in buildBundle —
// it should FAIL if that line is deleted. Two mocks make the explicit yield the
// ONLY macrotask boundary in the build:
//   1. compressTileBytes → a SYNCHRONOUS no-op. Real brotli is sync on the main
//      thread (see scheduleTileBrotli.ts: off-thread regressed steady RSS via
//      extra glibc arenas); the mock keeps it sync and non-yielding.
//   2. node:fs/promises (rm/mkdir/writeFile/rename) → MICROTASK-resolved no-ops.
//      The real fs/promises calls hit the libuv pool and yield a MACROTASK per
//      tile, which would let the heartbeat tick even with the explicit yield
//      removed (the bug a review flagged: the test would pass vacuously). Mocking
//      them to `Promise.resolve()` (a microtask) removes that incidental yield,
//      so the per-tile `await setImmediate` is the only thing that hands the loop
//      a macrotask turn. Remove it and the whole build collapses into one
//      microtask drain → the setImmediate heartbeat never runs before the build
//      resolves → `ticksAtResolve` is ~0 → this test fails. (The test asserts on
//      tilesWritten + heartbeat only; no on-disk state, so no-op fs is fine.)
vi.mock("./scheduleTileBrotli.js", () => ({
  compressTileBytes: (input: Uint8Array) => new Uint8Array(input.byteLength),
  MAX_COMPRESSED_TILE_BYTES: 2_097_152,
}));
vi.mock("node:fs/promises", () => ({
  rm: () => Promise.resolve(),
  mkdir: () => Promise.resolve(undefined),
  writeFile: () => Promise.resolve(),
  rename: () => Promise.resolve(),
}));

const { buildBundle } = await import("./buildBundle.js");

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

describe("buildBundle event-loop liveness", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "ptn-liveness-")); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it("yields the event loop between tiles: a setImmediate heartbeat ticks ≥ cell count while the build is pending", async () => {
    // ≥8 cells spread far apart so groupStopsByCell yields one cell each.
    const N = 10;
    const stops: GtfsStop[] = [];
    const routes: GtfsRoute[] = [];
    const trips: GtfsTrip[] = [];
    const stopTimes: Record<string, { tripId: string; departureSec: number }[]> = {};
    for (let i = 0; i < N; i++) {
      // Spread latitude by ~1 degree per stop → distinct cells.
      const lat = 40 + i;
      stops.push({ id: `S${i}`, name: `S${i}`, lat, lon: 20, parentStation: "" });
      routes.push({ id: `R${i}`, shortName: `${i}`, longName: "L", mode: "BUS", color: "FF0000", textColor: "FFFFFF" });
      trips.push({ tripId: `T${i}`, routeId: `R${i}`, serviceId: "SVC", headsign: "H" });
      stopTimes[`S${i}`] = [{ tripId: `T${i}`, departureSec: 8 * 3600 }];
    }
    const canonical = mkCanonical({ stops, routes, trips, services: [STD_SVC], stopTimes });

    // Heartbeat via setImmediate (NOT setTimeout): the build yields with
    // `await setImmediate` after each tile, which fires in the check phase —
    // sub-millisecond. A setTimeout(0) heartbeat is clamped to ~1 ms and can't
    // keep up with the build's faster yields, so it under-counts. A setImmediate
    // heartbeat shares the check phase and interleaves FIFO with the build's
    // per-tile yields; it ticking once per tile proves the loop completes a full
    // cycle — including the poll phase where queued HTTP requests are serviced —
    // between tiles, instead of freezing for the whole build (the "504 storm").
    let ticks = 0;
    let resolved = false;
    let ticksAtResolve = -1;
    const heartbeat = () => {
      ticks++;
      if (!resolved) setImmediate(heartbeat);
    };
    setImmediate(heartbeat);

    const buildPromise = buildBundle({
      canonical, bundleHash: "live", cityId: "vilnius", dataDir,
      resolveRouteColor: () => undefined, resolveRouteSubMode: () => undefined,
    }).then((r) => { resolved = true; ticksAtResolve = ticks; return r; });

    const result = await buildPromise;
    expect(result.tilesWritten).toBe(N);

    // The heartbeat interleaved at least once per cell before the build resolved
    // — the build awaited a setImmediate after each tile, so the heartbeat's own
    // setImmediate ran at least once per cell.
    expect(ticksAtResolve).toBeGreaterThanOrEqual(N);
  });
});
