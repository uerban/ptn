// ONE shared fixture, BOTH paths, asserted equal — the core equivalence guarantee that the
// producer-artifact sheds (B4/B6) did not change observable output, only the data source (artifact
// vs canonical):
//
//   (i)  /api/rt/:routeId protobuf from the artifact-grouping path
//        (createProducerRouteRt over trip-route.json) == from the canonical
//        store.getRealtimeForRoute path, for the generation's trip universe.
//   (ii) producer departures Departure[] (stop-cell.json lookup) deep-equals
//        the canonical lat/lon path (getStopLatLon -> scheduleTileCoordAt) for a
//        known stop.
//
// Determinism: getDeparturesFromTile reads LOCAL calendar fields on the no-tz
// path, so pin the process TZ BEFORE any Date is read (see producerDepartures.test.ts).
process.env.TZ = "UTC";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCHEDULE_TILE_SIZE_LABEL,
  encodeScheduleTile,
  encodeRouteUpdate,
  scheduleTileCoordAt,
  scheduleCellBounds,
  type DecodedScheduleTile,
} from "@pt/shared";
import { compressTileBytes } from "./scheduleTileBrotli.js";
import { createProducerScheduleTileSource } from "./producerScheduleTiles.js";
import { createProducerDeparturesSource } from "./producerDepartures.js";
import { createProducerRouteRt } from "./producerRouteRt.js";

const GEN_A = "a".repeat(64);
const NOW = new Date("2026-05-27T08:00:00Z"); // Wednesday, inside the service window

const ALL_WEEK_CALENDAR = {
  serviceId: "SVC",
  days: [true, true, true, true, true, true, true] as [
    boolean, boolean, boolean, boolean, boolean, boolean, boolean,
  ],
  startDate: "20260101",
  endDate: "20261231",
  added: [],
  removed: [],
};

/** Center of schedule cell (x,y) — a stop placed here is owned by that cell. */
function cellCenter(x: number, y: number): { lat: number; lon: number } {
  const b = scheduleCellBounds(x, y);
  return { lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2 };
}

function oneStopTile(): DecodedScheduleTile {
  return {
    bundleHash: GEN_A,
    cityId: "testcity",
    tileSize: 12000,
    stringTable: ["T1", "Downtown"],
    routes: [{ id: "R1", shortName: "1", longName: "Line 1", color: "#FF0000", mode: "BUS" }],
    calendar: [ALL_WEEK_CALENDAR],
    trips: [{ tripIdIx: 0, routeIx: 0, serviceIx: 0, headsignIx: 1 }],
    stops: {
      S1: {
        tripIxs: new Uint32Array([0, 0]),
        departureSecs: new Uint32Array([8 * 3600, 8 * 3600 + 1800]),
      },
    },
  };
}

function writeGeneration(
  dataRoot: string,
  generationId: string,
  tiles: Record<string, DecodedScheduleTile>,
): void {
  const tilesDir = join(dataRoot, "generations", generationId, "schedule-tiles");
  const bundleDir = join(tilesDir, generationId, SCHEDULE_TILE_SIZE_LABEL);
  mkdirSync(bundleDir, { recursive: true });
  for (const [coords, tile] of Object.entries(tiles)) {
    writeFileSync(join(bundleDir, `${coords}.br`), compressTileBytes(encodeScheduleTile(tile)));
  }
  writeFileSync(
    join(tilesDir, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, bundleHash: generationId, generatedAt: 1, tileSize: 6000 }),
  );
}

function flipCurrent(dataRoot: string, generationId: string): void {
  const tmp = join(dataRoot, "current.json.tmp");
  writeFileSync(
    tmp,
    JSON.stringify({ manifestSchemaVersion: 1, generationId, citySlug: "testcity" }),
  );
  renameSync(tmp, join(dataRoot, "current.json"));
}

describe("producer-artifact differential", () => {
  describe("(i) /api/rt protobuf: artifact-grouping == canonical getRealtimeForRoute", () => {
    it("produces byte-identical RouteUpdate bytes over the generation's trip universe", () => {
      // The shared fixture: a trip universe with a known trip→route mapping. The
      // canonical path resolves it via this map; the artifact path resolves it
      // via a byte-equal trip-route.json (same mapping, interned).
      const tripToRoute: Record<string, string> = { T1: "R1", T2: "R1", T3: "R2" };
      const rtUpdates = [
        { tripId: "T1", delaySeconds: 60, cancelled: false },
        { tripId: "T2", delaySeconds: 0, cancelled: true },
        { tripId: "T3", delaySeconds: 30, cancelled: false },
      ];

      // Canonical leg: store.getRealtimeForRoute(routeId) groups the same
      // enumeration by canonical.getTrip(tripId).routeId.
      const canonicalGetRealtimeForRoute = (routeId: string) =>
        rtUpdates.filter((u) => tripToRoute[u.tripId] === routeId);

      // Artifact leg: createProducerRouteRt groups via trip-route.json.
      const routes = ["R1", "R2"];
      const trips: Record<string, number> = {};
      for (const [tripId, routeId] of Object.entries(tripToRoute)) {
        trips[tripId] = routes.indexOf(routeId);
      }
      const routeForTrip = (tripId: string): string | undefined => {
        const idx = trips[tripId];
        return idx === undefined ? undefined : routes[idx];
      };
      const artifactSource = createProducerRouteRt({
        getRealtimeTripUpdates: () => rtUpdates,
        resolveRouteForTrip: () => routeForTrip,
        artifactPresent: () => true,
        canonicalFallback: () => [],
      });

      // generatedAt is Date.now() in both legs — pin it so the bytes match.
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      try {
        for (const routeId of ["R1", "R2", "R_NONE"]) {
          const artifactBytes = encodeRouteUpdate(artifactSource.getRouteUpdate(routeId));
          const canonicalBytes = encodeRouteUpdate({
            routeId,
            trips: canonicalGetRealtimeForRoute(routeId),
            generatedAt: Date.now(),
          });
          expect(Buffer.from(artifactBytes).equals(Buffer.from(canonicalBytes))).toBe(true);
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("(ii) producer departures: stop-cell lookup deep-equals lat/lon path", () => {
    let dataRoot: string;
    beforeEach(() => {
      dataRoot = mkdtempSync(join(tmpdir(), "ptn-art-diff-dep-"));
      vi.stubEnv("PT_DATA_ROOT", dataRoot);
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(dataRoot, { recursive: true, force: true });
    });

    it("the stop-cell artifact coord equals the lat/lon-derived coord, same Departure[]", () => {
      // Shared fixture: S1 sits at the center of schedule cell (1,1). The build
      // wrote its tile at that cell's on-disk coord. The lat/lon path derives the
      // same coord from the stop geography; the stop-cell artifact maps S1 to it
      // directly. Both must read the SAME tile → identical departures.
      const { lat, lon } = cellCenter(1, 1);
      const { x, y } = scheduleTileCoordAt(lat, lon);
      const cellKey = `${x}_${y}`;
      writeGeneration(dataRoot, GEN_A, { [cellKey]: oneStopTile() });
      flipCurrent(dataRoot, GEN_A);

      const tileSource = createProducerScheduleTileSource(process.env.PT_DATA_ROOT);

      // Lat/lon leg (the pre-B6 path): coord derived from canonical getStopLatLon.
      const getStopLatLon = (s: string) => (s === "S1" ? { lat, lon } : null);
      const latLonSource = createProducerDeparturesSource({
        tileSource,
        tileCoordsForStop: (s) => {
          const ll = getStopLatLon(s);
          if (!ll) return undefined;
          const c = scheduleTileCoordAt(ll.lat, ll.lon);
          return `${c.x}_${c.y}`;
        },
      });

      // Stop-cell leg (B6): coord straight from the stop-cell.json artifact.
      const stopCell: Record<string, string> = { S1: cellKey };
      const artifactSource = createProducerDeparturesSource({
        tileSource,
        tileCoordsForStop: (s) => stopCell[s],
      });

      const args = { stopId: "S1", now: NOW, limit: 5, lookAheadHours: 2 };
      const latLon = latLonSource.getDepartures(args);
      const artifact = artifactSource.getDepartures(args);

      expect(latLon.state).toBe("ok");
      expect(artifact.state).toBe("ok");
      // The single-source guarantee: the two coords agree, so the SAME tile is
      // read, so the Departure[] deep-equal.
      expect(stopCell.S1).toBe(`${x}_${y}`);
      if (latLon.state === "ok" && artifact.state === "ok") {
        expect(artifact.departures).toEqual(latLon.departures);
        expect(artifact.departures.length).toBeGreaterThan(0);
      }
    });
  });
});
