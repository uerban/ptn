// Determinism: getDeparturesFromTile reads LOCAL calendar fields on the no-tz
// path, so the process TZ must be pinned BEFORE any Date is read (see
// departures.producer.test.ts for the full rationale).
process.env.TZ = "UTC";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCHEDULE_TILE_SIZE_LABEL,
  encodeScheduleTile,
  scheduleTileCoordAt,
  scheduleCellBounds,
  type DecodedScheduleTile,
} from "@pt/shared";
import { compressTileBytes } from "./scheduleTileBrotli.js";
import { createProducerScheduleTileSource } from "./producerScheduleTiles.js";
import { createProducerDeparturesSource } from "./producerDepartures.js";
import { createProducerRouteRt } from "./producerRouteRt.js";

const GEN_A = "a".repeat(64);
const NOW = new Date("2026-05-27T08:00:00Z");

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

function stopAtCellCenter(x: number, y: number): { lat: number; lon: number } {
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

function writeGeneration(dataRoot: string, generationId: string, tiles: Record<string, DecodedScheduleTile>): void {
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
    JSON.stringify({ manifestSchemaVersion: 1, generationId, citySlug: "testcity", createdAt: "2026-06-21T00:00:00Z" }),
  );
  renameSync(tmp, join(dataRoot, "current.json"));
}

describe("producer-artifact served/fallback counting", () => {
  describe("B6 stop-cell departures", () => {
    let dataRoot: string;
    beforeEach(() => {
      dataRoot = mkdtempSync(join(tmpdir(), "ptn-art-metrics-"));
      vi.stubEnv("PT_SCHEDULE_TILE_SOURCE", "producer");
      vi.stubEnv("PT_DATA_ROOT", dataRoot);
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(dataRoot, { recursive: true, force: true });
    });

    it('counts "served" when the stop resolves to a real on-disk tile', () => {
      const { x, y } = scheduleTileCoordAt(stopAtCellCenter(1, 1).lat, stopAtCellCenter(1, 1).lon);
      const cellKey = `${x}_${y}`;
      writeGeneration(dataRoot, GEN_A, { [cellKey]: oneStopTile() });
      flipCurrent(dataRoot, GEN_A);

      const onArtifactResult = vi.fn();
      const src = createProducerDeparturesSource({
        tileSource: createProducerScheduleTileSource(process.env.PT_DATA_ROOT),
        tileCoordsForStop: (s) => (s === "S1" ? cellKey : undefined),
        onArtifactResult,
      });
      const out = src.getDepartures({ stopId: "S1", now: NOW, limit: 5, lookAheadHours: 1 });
      expect(out.state).toBe("ok");
      expect(onArtifactResult).toHaveBeenCalledWith("served");
      expect(onArtifactResult).not.toHaveBeenCalledWith("fallback");
    });

    it('counts "fallback" when the stop is absent from stop-cell (ENOENT-class miss), even while log-quiet', () => {
      writeGeneration(dataRoot, GEN_A, { "1_1": oneStopTile() });
      flipCurrent(dataRoot, GEN_A);

      const onArtifactResult = vi.fn();
      const warn = vi.fn();
      const src = createProducerDeparturesSource({
        tileSource: createProducerScheduleTileSource(process.env.PT_DATA_ROOT),
        tileCoordsForStop: () => undefined, // artifact absent / unknown stop
        onArtifactResult,
        log: { warn },
      });
      const out = src.getDepartures({ stopId: "ZZZ", now: NOW, limit: 5, lookAheadHours: 1 });
      expect(out.state).toBe("unavailable");
      expect(onArtifactResult).toHaveBeenCalledWith("fallback");
      // Absent-artifact path stays log-quiet (it's a fallback count, not a warn).
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("B4 trip-route RT grouping", () => {
    it('counts "served" per trip the artifact resolves and "fallback" per unknown trip', () => {
      const onArtifactResult = vi.fn();
      const updates = [
        { tripId: "T1", delaySeconds: 60, cancelled: false },
        { tripId: "T2", delaySeconds: 0, cancelled: true },
        { tripId: "GHOST", delaySeconds: 5, cancelled: false },
      ];
      const src = createProducerRouteRt({
        getRealtimeTripUpdates: () => updates,
        resolveRouteForTrip: () => (t) => ({ T1: "R9", T2: "R9" } as Record<string, string>)[t],
        artifactPresent: () => true,
        canonicalFallback: () => [],
        onArtifactResult,
      });
      const out = src.getRouteUpdate("R9");
      expect(out.trips.map((t) => t.tripId).sort()).toEqual(["T1", "T2"]);
      // T1, T2 resolved -> served; GHOST unknown -> fallback.
      const calls = onArtifactResult.mock.calls.map((c) => c[0]);
      expect(calls.filter((r) => r === "served").length).toBe(2);
      expect(calls.filter((r) => r === "fallback").length).toBe(1);
    });

    // B1: a WHOLLY-ABSENT artifact must NOT serve empty RT for every route. It
    // falls through to the canonical RT-by-route path and counts a SINGLE
    // `fallback` per request (the canonical path answered, not the artifact) —
    // NOT one fallback per enumerated trip (the old city-wide-blackout shape).
    it('falls back to canonical + counts one "fallback" when the whole artifact is absent', () => {
      const onArtifactResult = vi.fn();
      const canonicalTrips = [{ tripId: "C1", delaySeconds: 9, cancelled: false }];
      const src = createProducerRouteRt({
        getRealtimeTripUpdates: () => {
          throw new Error("enumeration must not run on the wholly-absent path");
        },
        resolveRouteForTrip: () => () => undefined,
        artifactPresent: () => false, // artifact wholly absent
        canonicalFallback: (routeId) => (routeId === "R9" ? canonicalTrips : []),
        onArtifactResult,
      });
      const out = src.getRouteUpdate("R9");
      expect(out.trips).toEqual(canonicalTrips); // canonical-backed, NOT []
      const calls = onArtifactResult.mock.calls.map((c) => c[0]);
      expect(calls).toEqual(["fallback"]); // exactly one
    });
  });
});
