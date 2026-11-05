import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeScheduleTile, SCHEDULE_TILE_SIZE_LABEL } from "@pt/shared";
import type { CanonicalStore, ServiceEntry } from "./canonical/CanonicalStore.js";
import type { GtfsStop, GtfsRoute, GtfsTrip, CompactStopTimes } from "./parser.js";
import { GtfsStore } from "./store.js";

// Wrap the REAL compressTileBytes so tiles still round-trip through the decoder,
// but expose a per-call hook so the test can mutate the store's color maps
// AFTER tile-1's buildTileForCell resolved and BEFORE tile-2's. This simulates
// a mid-build store.swap() landing between two tiles.
const { onCompressCall } = vi.hoisted(() => ({ onCompressCall: { fn: undefined as undefined | (() => void) } }));
vi.mock("./scheduleTileBrotli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scheduleTileBrotli.js")>();
  return {
    ...actual,
    // Stay synchronous — the real compressTileBytes is sync (brotli on the main
    // thread) and buildBundle no longer awaits it. The per-call hook fires after
    // the real compress and before buildBundle's writeFile, simulating a
    // store.swap() landing between two tiles.
    compressTileBytes: (input: Uint8Array): Uint8Array => {
      const out = actual.compressTileBytes(input);
      onCompressCall.fn?.();
      return out;
    },
  };
});

// Import buildBundle AFTER the mock is registered so it binds the wrapped fn.
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

describe("buildBundle color snapshot (real end-to-end, mid-build swap)", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "ptn-colorsnap-")); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); onCompressCall.fn = undefined; });

  it("resolves every tile's color against the captured snapshot, never a mid-build replacement", async () => {
    // Two cells (Vilnius + Krakow), each with its own route that resolves to a
    // sub-mode color via the store's color maps.
    const canonical = mkCanonical({
      stops: [
        { id: "S_V", name: "Vilnius", lat: 54.6892, lon: 25.2798, parentStation: "" },
        { id: "S_K", name: "Krakow", lat: 50.0647, lon: 19.9450, parentStation: "" },
      ],
      routes: [
        { id: "RV", shortName: "V", longName: "Vil", mode: "BUS", color: "000000", textColor: "FFFFFF" },
        { id: "RK", shortName: "K", longName: "Kra", mode: "BUS", color: "000000", textColor: "FFFFFF" },
      ],
      trips: [
        { tripId: "TV", routeId: "RV", serviceId: "SVC", headsign: "V" },
        { tripId: "TK", routeId: "RK", serviceId: "SVC", headsign: "K" },
      ],
      services: [STD_SVC],
      stopTimes: {
        S_V: [{ tripId: "TV", departureSec: 8 * 3600 }],
        S_K: [{ tripId: "TK", departureSec: 9 * 3600 }],
      },
    });

    const store = new GtfsStore();
    // Snapshot-generation colors.
    (store as any).routeSubModeMap = new Map([["RV", "SM_A"], ["RK", "SM_A"]]);
    (store as any).subModeById = new Map([["SM_A", { color: "#aaaaaa" }]]);

    const snap = store.snapshotRouteResolvers();

    // After the FIRST tile compresses, swap the store's color maps to a DIFFERENT
    // generation. A late/live resolver would pick this up for tile-2; the
    // snapshot must not.
    let calls = 0;
    onCompressCall.fn = () => {
      calls++;
      if (calls === 1) {
        (store as any).routeSubModeMap = new Map([["RV", "SM_B"], ["RK", "SM_B"]]);
        (store as any).subModeById = new Map([["SM_B", { color: "#bbbbbb" }]]);
      }
    };

    const result = await buildBundle({
      canonical, bundleHash: "colorsnap", cityId: "vilnius", dataDir,
      resolveRouteColor: snap.resolveRouteColor,
      resolveRouteSubMode: snap.resolveRouteSubMode,
    });
    expect(result.tilesWritten).toBe(2);
    // Sanity: the wrapped compress ran for both cells AND the swap fired.
    expect(calls).toBeGreaterThanOrEqual(2);

    const { decompressTileBytes } = await import("./scheduleTileBrotli.js");
    const tileDir = join(dataDir, "colorsnap", SCHEDULE_TILE_SIZE_LABEL);
    const tileFiles = readdirSync(tileDir).filter((f) => f.endsWith(".br"));
    expect(tileFiles).toHaveLength(2);

    for (const tileFile of tileFiles) {
      const decoded = decodeScheduleTile(decompressTileBytes(readFileSync(join(tileDir, tileFile))));
      for (const route of decoded.routes) {
        // Every route must carry the SNAPSHOT-generation color (#aaaaaa),
        // never the post-swap color (#bbbbbb) and never the raw GTFS fallback.
        expect(route.color).toBe("#aaaaaa");
        expect(route.subMode).toBe("SM_A");
      }
    }
  });
});
