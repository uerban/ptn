// Determinism: getDeparturesFromTile reads LOCAL calendar fields (ymdLocal /
// Date#getHours) on the no-tz path, so the process TZ must be pinned BEFORE any
// Date is read. 2026-05-27T08:00:00Z is a Wednesday; under TZ=UTC the local hour
// is 08:00, matching the `8 * 3600`-second departures the fixture emits, and the
// date falls inside the fixture's 20260101..20261231 service window.
process.env.TZ = "UTC";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCHEDULE_TILE_SIZE_LABEL,
  encodeScheduleTile,
  type DecodedScheduleTile,
} from "@pt/shared";
import { compressTileBytes } from "./scheduleTileBrotli.js";
import { createProducerScheduleTileSource } from "./producerScheduleTiles.js";
import { createProducerDeparturesSource } from "./producerDepartures.js";

// generationId-shaped hash (64 hex). The producer sets the schedule-tile
// bundleHash == generationId (the "bridge" pattern), so reuse it as both.
const GEN_A = "a".repeat(64);

// Fixed query instant (see the TZ note above). 2026-05-27 is a Wednesday.
const NOW = new Date("2026-05-27T08:00:00Z");

// All-week service so the fixed Wednesday is active.
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

/**
 * A DecodedScheduleTile carrying one stop `S1` with two BUS departures at
 * 08:00:00 + 08:30:00 local, both on the all-week SVC service.
 */
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

/** Write a published generation dir with a real brotli-encoded schedule tile + manifest. */
function writeGeneration(
  dataRoot: string,
  generationId: string,
  tiles: Record<string, DecodedScheduleTile>, // `<x>_<y>` (or leaf coord) → decoded tile
): void {
  const tilesDir = join(dataRoot, "generations", generationId, "schedule-tiles");
  const bundleDir = join(tilesDir, generationId, SCHEDULE_TILE_SIZE_LABEL);
  mkdirSync(bundleDir, { recursive: true });
  for (const [coords, tile] of Object.entries(tiles)) {
    writeFileSync(join(bundleDir, `${coords}.br`), compressTileBytes(encodeScheduleTile(tile)));
  }
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    bundleHash: generationId,
    generatedAt: 1,
    tileSize: 6000,
  };
  writeFileSync(join(tilesDir, "manifest.json"), JSON.stringify(manifest));
}

/** Atomically flip `current.json` to point at `generationId`. */
function flipCurrent(dataRoot: string, generationId: string): void {
  const tmp = join(dataRoot, "current.json.tmp");
  writeFileSync(
    tmp,
    JSON.stringify({
      manifestSchemaVersion: 1,
      generationId,
      citySlug: "testcity",
      createdAt: "2026-06-21T00:00:00Z",
    }),
  );
  renameSync(tmp, join(dataRoot, "current.json"));
}

describe("createProducerDeparturesSource — B6 stop-cell lookup", () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), "ptn-prod-dep-source-"));
    vi.stubEnv("PT_DATA_ROOT", dataRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("resolves the tile from stop-cell, never calling lat/lon", () => {
    // S1's tile lives at on-disk coord `3_4`. Write it there directly.
    writeGeneration(dataRoot, GEN_A, { "3_4": oneStopTile() });
    flipCurrent(dataRoot, GEN_A);

    const tileSource = createProducerScheduleTileSource(process.env.PT_DATA_ROOT);
    const log = { warn: vi.fn() };
    const tileCoordsForStop = vi.fn((s: string) => (s === "S1" ? "3_4" : undefined));
    const src = createProducerDeparturesSource({ tileSource, tileCoordsForStop, log });
    const now = NOW;

    // S1 maps to 3_4 -> reads <dir>/<hash>/<size>/3_4.br -> ok
    expect(src.getDepartures({ stopId: "S1", now, limit: 5, lookAheadHours: 2 }).state).toBe("ok");
    // unknown stop -> unavailable, and lat/lon never consulted
    expect(
      src.getDepartures({ stopId: "ZZZ", now, limit: 5, lookAheadHours: 2 }).state,
    ).toBe("unavailable");
    // tileCoordsForStop was consulted for both stops.
    expect(tileCoordsForStop).toHaveBeenCalledWith("S1");
    expect(tileCoordsForStop).toHaveBeenCalledWith("ZZZ");
  });
});
