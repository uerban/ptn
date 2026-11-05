// Determinism: getDeparturesFromTile reads LOCAL calendar fields (ymdLocal /
// Date#getHours), so the process TZ must be pinned BEFORE any Date is read.
// 2026-05-27T08:00:00Z is a Wednesday; under TZ=UTC the local hour is 08:00,
// matching the `8 * 3600`-second departures the dense fixture emits, and the
// date falls inside the canonical's 20260101..20261231 service window.
process.env.TZ = "UTC";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeScheduleTile,
  getDeparturesFromTile,
  scheduleCellBounds,
  scheduleTileCoordAt,
  leafForPoint,
  leafSuffixSet,
  SCHEDULE_TILE_SIZE_LABEL,
  type BundleManifest,
  type DecodedScheduleTile,
  type SubdivisionPlan,
} from "@pt/shared";
import { decompressTileBytes } from "../gtfs/scheduleTileBrotli.js";
import { buildAndPublishBundle } from "../gtfs/buildAndPublishBundle.js";
import { createScheduleTileHandler } from "./scheduleTile.js";
import { createGtfsManifestHandler } from "./gtfsManifest.js";
import type { ManifestSnapshot } from "../gtfs/scheduler.js";
import type { CanonicalStore, ServiceEntry } from "../gtfs/canonical/CanonicalStore.js";
import type { GtfsStop, GtfsRoute, GtfsTrip, CompactStopTimes } from "../gtfs/parser.js";

// Fixed query instant — see the TZ note at the top of the file.
const NOW = new Date("2026-05-27T08:00:00Z");
// HIGH limit on BOTH sides so a slice can never mask a divergence (a leaf that
// dropped/added a departure relative to the oracle must surface).
const LIMIT = 10_000;
const LOOK_AHEAD_HOURS = 24;

// All-week service so the fixed Wednesday is active.
const STD_SVC: ServiceEntry = {
  serviceId: "SVC",
  monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: true,
  startDate: "20260101", endDate: "20261231",
  exceptions: new Map(),
};

// Adapted from buildBundle.subdivision.test.ts::mkCanonical — accepts explicit
// routes/trips so the DENSE fixture (distinct trip per stop) builds a non-trivial
// string table.
function mkCanonical(
  stops: GtfsStop[],
  stopTimes: Record<string, { tripId: string; departureSec: number }[]>,
  routesArr: GtfsRoute[],
  tripsArr: GtfsTrip[],
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

// A genuinely DENSE cell: `perQuad` stops in EACH quadrant, each a DISTINCT
// trip + route + headsign so the 4-quadrant root tile is over a realistic cap
// while each quadrant leaf clears the single-stop brotli floor and comes under
// it (mirrors buildBundle.subdivision.test.ts::denseCell, cap:400 proven there).
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
      // Two departures per stop so the equality compares a non-trivial array.
      stopTimes[id] = [
        { tripId, departureSec: 8 * 3600 + i },
        { tripId, departureSec: 8 * 3600 + 1800 + i },
      ];
      i++;
    }
  }
  return { stops, routes, trips, stopTimes, cellKey: `${x}_${y}`, x, y };
}

// Build a ManifestSnapshot over an on-disk manifest.json — mirrors
// GtfsScheduler.getManifestSnapshot()/integration.test.ts (no scheduler needed).
function snapshotFor(dir: string): ManifestSnapshot {
  const text = readFileSync(join(dir, "manifest.json"), "utf8");
  const parsed = JSON.parse(text) as BundleManifest;
  return {
    bundleHash: parsed.bundleHash,
    subdivisions: parsed.subdivisions ?? {},
    contentEtag: createHash("sha256").update(text).digest("hex").slice(0, 32),
    parsed,
  };
}

function mkApp(dir: string, snapshot: ManifestSnapshot) {
  const app = Fastify({ logger: false });
  app.get(
    "/api/gtfs/schedule-tile/:bundleHash/:tileSize/:tileCoords",
    createScheduleTileHandler({
      dataDir: dir,
      getCurrentBundleHash: () => snapshot.bundleHash,
      getManifestSnapshot: () => snapshot,
    }),
  );
  app.get("/api/gtfs/manifest", createGtfsManifestHandler({
    getManifestSnapshot: () => snapshot,
  }));
  return app;
}

const tileUrl = (hash: string, coords: string) =>
  `/api/gtfs/schedule-tile/${hash}/${SCHEDULE_TILE_SIZE_LABEL}/${coords}`;

describe("schedule-tile read path — e2e build→serve→consume contract (subdivided leaves vs whole-cell oracle)", () => {
  let lowDir: string;
  let highDir: string;
  beforeEach(() => {
    lowDir = mkdtempSync(join(tmpdir(), "ptn-e2e-low-"));
    highDir = mkdtempSync(join(tmpdir(), "ptn-e2e-high-"));
  });
  afterEach(() => {
    rmSync(lowDir, { recursive: true, force: true });
    rmSync(highDir, { recursive: true, force: true });
  });

  it("every cell stop's departures from its owning LEAF tile deep-equal the whole-cell oracle's", async () => {
    // The dense cell lives at a real Paris-grid coord; (906,28) is the same cell
    // the unit subdivision tests use. 10 stops/quadrant = 40 stops total.
    const { stops, routes, trips, stopTimes, cellKey, x, y } = denseCell(906, 28, 10);
    const canonical = mkCanonical(stops, stopTimes, routes, trips);

    const baseInput = {
      cityId: "paris",
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      rtFeedUrls: [],
      minTripsPerRoute: 1,
      resolveRouteColor: () => undefined,
      resolveRouteSubMode: () => undefined,
    } as const;

    // LOW cap → the dense cell subdivides into ≥2 leaves (the plan under test).
    const lowResult = await buildAndPublishBundle({
      ...baseInput,
      canonical: mkCanonical(stops, stopTimes, routes, trips),
      dataDir: lowDir,
      maxCompressedTileBytes: 400,
    });
    // HIGH cap → one whole-cell `<cell>.br`, no subdivision: the oracle. The cap
    // is a bundleHash input, so low/high dirs+hashes differ (no collision).
    const highResult = await buildAndPublishBundle({
      ...baseInput,
      canonical,
      dataDir: highDir,
      maxCompressedTileBytes: Number.POSITIVE_INFINITY,
    });

    // --- Precondition: the LOW build actually subdivided this cell. ---
    const lowPlan: SubdivisionPlan | undefined = lowResult.subdivisions[cellKey];
    expect(lowPlan, "low-cap build must subdivide the dense cell").toBeDefined();
    expect(lowPlan!.leaves.length).toBeGreaterThan(1);
    // --- Precondition: the HIGH build did NOT subdivide it (true oracle). ---
    expect(highResult.subdivisions[cellKey]).toBeUndefined();

    const lowSnapshot = snapshotFor(lowDir);
    const highSnapshot = snapshotFor(highDir);
    const lowApp = mkApp(lowDir, lowSnapshot);
    const highApp = mkApp(highDir, highSnapshot);

    // === 1. Bare cell on the subdivided side → 404 tile_subdivided + inlined leaves ===
    const bareRes = await lowApp.inject({
      method: "GET",
      url: tileUrl(lowSnapshot.bundleHash, cellKey),
    });
    expect(bareRes.statusCode).toBe(404);
    const bareBody = JSON.parse(bareRes.payload);
    expect(bareBody.error).toBe("tile_subdivided");
    expect([...bareBody.leaves].sort()).toEqual(
      lowPlan!.leaves.map((l) => l.suffix).sort(),
    );

    // === 2. Whole-cell oracle: bare cell on the HIGH side → 200, decode ONCE ===
    const oracleRes = await highApp.inject({
      method: "GET",
      url: tileUrl(highSnapshot.bundleHash, cellKey),
    });
    expect(oracleRes.statusCode).toBe(200);
    expect(oracleRes.headers["content-type"]).toBe("application/octet-stream");
    const wholeTile: DecodedScheduleTile = decodeScheduleTile(
      decompressTileBytes(oracleRes.rawPayload),
    );

    // Memoize leaf-tile decodes — many stops share one owning leaf.
    const leafTileCache = new Map<string, DecodedScheduleTile>();
    const leafSuffixes = leafSuffixSet(lowPlan!);
    const cellBounds = scheduleCellBounds(x, y);

    // === 3. Per-stop equality over EVERY stop in the cell ===
    let stopsCompared = 0;
    let stopsWithDepartures = 0;
    for (const stop of stops) {
      const owningSuffix = leafForPoint(cellBounds, stop.lat, stop.lon, leafSuffixes);
      // Every stop in a subdivided cell MUST resolve to exactly one leaf.
      expect(owningSuffix, `stop ${stop.id} (${stop.lat},${stop.lon}) resolved no owning leaf`).not.toBeNull();

      // Independent geometric self-check: the stop must lie inside the leaf's
      // RECORDED bbox by plain inequality — a descent bug can't validate itself.
      const owningLeaf = lowPlan!.leaves.find((l) => l.suffix === owningSuffix);
      expect(owningLeaf, `plan has no leaf for suffix ${owningSuffix}`).toBeDefined();
      const bb = owningLeaf!.bbox;
      expect(stop.lat).toBeGreaterThanOrEqual(bb.minLat);
      expect(stop.lat).toBeLessThanOrEqual(bb.maxLat);
      expect(stop.lon).toBeGreaterThanOrEqual(bb.minLon);
      expect(stop.lon).toBeLessThanOrEqual(bb.maxLon);

      // Serve + decode the owning leaf tile (memoized).
      let leafTile = leafTileCache.get(owningSuffix!);
      if (!leafTile) {
        const leafRes = await lowApp.inject({
          method: "GET",
          url: tileUrl(lowSnapshot.bundleHash, `${cellKey}-${owningSuffix}`),
        });
        expect(leafRes.statusCode, `leaf ${cellKey}-${owningSuffix} did not serve 200`).toBe(200);
        expect(leafRes.headers["content-type"]).toBe("application/octet-stream");
        leafTile = decodeScheduleTile(decompressTileBytes(leafRes.rawPayload));
        leafTileCache.set(owningSuffix!, leafTile);
      }

      const fromLeaf = getDeparturesFromTile({
        tile: leafTile, stopId: stop.id, now: NOW, limit: LIMIT, lookAheadHours: LOOK_AHEAD_HOURS,
      });
      const fromWhole = getDeparturesFromTile({
        tile: wholeTile, stopId: stop.id, now: NOW, limit: LIMIT, lookAheadHours: LOOK_AHEAD_HOURS,
      });
      expect(fromLeaf, `departures mismatch for stop ${stop.id} (leaf ${owningSuffix})`).toEqual(fromWhole);

      if (fromWhole.departures.length > 0) stopsWithDepartures++;
      stopsCompared++;
    }

    // === 4. Coverage + non-vacuity guards ===
    expect(stopsCompared).toBe(stops.length);
    // ≥1 stop must yield >0 departures or the equality is trivially comparing empties.
    expect(stopsWithDepartures, "non-vacuity: at least one stop must have departures").toBeGreaterThan(0);
    // More than one leaf must have actually been fetched (the subdivision is real).
    expect(leafTileCache.size).toBeGreaterThan(1);

    // === 5. Oversized-leaf serve check (only if naturally produced) ===
    const oversizedLeaf = lowPlan!.leaves.find((l) => l.oversized);
    if (oversizedLeaf) {
      const onDisk = join(lowDir, lowSnapshot.bundleHash, SCHEDULE_TILE_SIZE_LABEL, `${cellKey}-${oversizedLeaf.suffix}.br`);
      expect(existsSync(onDisk)).toBe(true);
      const ovRes = await lowApp.inject({
        method: "GET",
        url: tileUrl(lowSnapshot.bundleHash, `${cellKey}-${oversizedLeaf.suffix}`),
      });
      expect(ovRes.statusCode).toBe(200);
      expect(Buffer.from(ovRes.rawPayload)).toEqual(readFileSync(onDisk));
    }
    // (If no oversized leaf is produced — the case here, every quadrant fits
    // under cap:400 — the build-side oversized path is already covered by
    // buildBundle.subdivision.test.ts ; we don't contort the fixture.)
  });
});
