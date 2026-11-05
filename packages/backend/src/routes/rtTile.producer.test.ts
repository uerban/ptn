import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCHEDULE_TILE_SIZE_LABEL, encodeScheduleTile, type DecodedScheduleTile,
} from "@pt/shared";
import { compressTileBytes } from "../gtfs/scheduleTileBrotli.js";
import { createRtTileHandler } from "./rtTile.js";
import { createProducerScheduleTileSource } from "../gtfs/producerScheduleTiles.js";

// generationId-shaped hashes (64 hex). The producer sets the schedule-tile
// bundleHash == generationId (the "bridge" pattern), so reuse them as both.
const GEN_A = "a".repeat(64);
const GEN_B = "b".repeat(64);

/** A DecodedScheduleTile carrying exactly one trip id at coords "1_2". */
function oneTripTile(tripId: string): DecodedScheduleTile {
  return {
    bundleHash: GEN_A, cityId: "testcity", tileSize: 12000,
    stringTable: [tripId, "Downtown"],
    routes: [{ id: "R1", shortName: "1", longName: "Line", color: "#FF0000", mode: "BUS" }],
    calendar: [],
    trips: [{ tripIdIx: 0, routeIx: 0, serviceIx: 0, headsignIx: 1 }],
    stops: { S1: { tripIxs: new Uint32Array([0]), departureSecs: new Uint32Array([28800]) } },
  };
}

/**
 * Write a published generation dir with a real (encoded+compressed) schedule
 * tile + manifest, mirroring scheduleTile.producer.test.ts's `writeGeneration`
 * but with brotli-encoded tiles the rt-tile route can decode.
 */
async function writeGeneration(
  dataRoot: string,
  generationId: string,
  tiles: Record<string, DecodedScheduleTile>, // `<x>_<y>` → decoded tile
): Promise<void> {
  const tilesDir = join(dataRoot, "generations", generationId, "schedule-tiles");
  const bundleDir = join(tilesDir, generationId, SCHEDULE_TILE_SIZE_LABEL);
  mkdirSync(bundleDir, { recursive: true });
  for (const [coords, tile] of Object.entries(tiles)) {
    writeFileSync(join(bundleDir, `${coords}.br`), await compressTileBytes(encodeScheduleTile(tile)));
  }
  writeFileSync(
    join(tilesDir, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, bundleHash: generationId, generatedAt: 1, tileSize: 6000 }),
  );
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

describe("rtTile route — PT_SCHEDULE_TILE_SOURCE=producer", () => {
  let dataRoot: string;
  let backendDataDir: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), "ptn-rt-prod-root-"));
    // A SEPARATE backend in-process dir to prove the rt-tile route does NOT
    // serve its membership tile from there in producer mode (it must read the
    // producer gen dir, where the only schedule tiles now exist after Part A
    // disabled the backend build).
    backendDataDir = mkdtempSync(join(tmpdir(), "ptn-rt-backend-tiles-"));
    vi.stubEnv("PT_SCHEDULE_TILE_SOURCE", "producer");
    vi.stubEnv("PT_DATA_ROOT", dataRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(backendDataDir, { recursive: true, force: true });
  });

  /**
   * Wire the rt-tile route exactly as index.ts must in producer mode: the
   * route's bundleHash + manifest snapshot + tile dir all come from the
   * producer source, NOT the backend scheduler (whose manifest goes stale once
   * Part A disables the in-process build).
   */
  function mkApp(
    rtByTripId?: Map<string, Array<{ startDate?: string; delaySeconds: number; cancelled: boolean }>>,
  ) {
    const source = createProducerScheduleTileSource(process.env.PT_DATA_ROOT);
    const app = Fastify({ logger: false });
    app.get(
      "/api/gtfs/rt-tile/:bundleHash/:tileSize/:tileCoords",
      createRtTileHandler({
        dataDir: () => source.resolveDataDir() ?? backendDataDir,
        cityId: "testcity",
        getCurrentBundleHash: () => source.getCurrentBundleHash(),
        getManifestSnapshot: () => source.getManifestSnapshot(),
        getRtEntriesForTrip: (id) => rtByTripId?.get(id) ?? [],
      }),
    );
    return app;
  }

  it("a request carrying the PRODUCER hash does NOT 409 — it serves RT merged over the producer gen-dir tile", async () => {
    await writeGeneration(dataRoot, GEN_A, { "1_2": oneTripTile("T1") });
    flipCurrent(dataRoot, GEN_A);

    const app = mkApp(new Map([["T1", [{ delaySeconds: 60, cancelled: false }]]]));
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/rt-tile/${GEN_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-pt-bundle-hash"]).toBe(GEN_A);
    const body = JSON.parse(res.payload);
    expect(body.bundleHash).toBe(GEN_A);
    // Trip membership came from the PRODUCER gen-dir tile; RT delay merged Node-side.
    expect(body.trips).toEqual([{ tripId: "T1", delaySeconds: 60, cancelled: false }]);
  });

  it("the rt-tile current hash comes from the producer manifest, not the (now-stale) backend scheduler", () => {
    const source = createProducerScheduleTileSource(process.env.PT_DATA_ROOT);
    // No backend manifest is wired at all — the only hash source is the producer.
    expect(source.getCurrentBundleHash()).toBeNull(); // cold (no current.json yet)
  });

  it("a STALE hash 409s with the producer hash in X-PT-Bundle-Hash (matches the schedule-tile route)", async () => {
    await writeGeneration(dataRoot, GEN_A, { "1_2": oneTripTile("T1") });
    flipCurrent(dataRoot, GEN_A);

    const app = mkApp();
    // Client still holds GEN_B (a stale/old generation).
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/rt-tile/${GEN_B}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.headers["x-pt-bundle-hash"]).toBe(GEN_A);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe("bundle_hash_mismatch");
    expect(body.currentBundleHash).toBe(GEN_A);
  });

  it("re-points to the new gen-dir hash + tiles after a generation roll (no boot-time freeze)", async () => {
    await writeGeneration(dataRoot, GEN_A, { "1_2": oneTripTile("T1") });
    flipCurrent(dataRoot, GEN_A);

    const app = mkApp(new Map([
      ["T1", [{ delaySeconds: 60, cancelled: false }]],
      ["T2", [{ delaySeconds: 30, cancelled: false }]],
    ]));

    const first = await app.inject({
      method: "GET",
      url: `/api/gtfs/rt-tile/${GEN_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.payload).trips.map((t: any) => t.tripId)).toEqual(["T1"]);

    // Producer publishes a new generation (different tile membership) + flips.
    await writeGeneration(dataRoot, GEN_B, { "1_2": oneTripTile("T2") });
    flipCurrent(dataRoot, GEN_B);

    // Old hash is now stale → 409 carrying the NEW hash.
    const stale = await app.inject({
      method: "GET",
      url: `/api/gtfs/rt-tile/${GEN_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.headers["x-pt-bundle-hash"]).toBe(GEN_B);

    // New hash serves the NEW gen-dir tile (membership now T2).
    const fresh = await app.inject({
      method: "GET",
      url: `/api/gtfs/rt-tile/${GEN_B}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.headers["x-pt-bundle-hash"]).toBe(GEN_B);
    expect(JSON.parse(fresh.payload).trips.map((t: any) => t.tripId)).toEqual(["T2"]);
  });

  it("cold start (no current.json yet) returns 409 bundle_unavailable, not bundle_hash_mismatch", async () => {
    // Producer mode is configured but no generation has been published yet —
    // current.json is absent. A request must get bundle_unavailable (back off
    // and retry), NOT bundle_hash_mismatch (no current hash is known to compare
    // against, so the membership tile simply isn't on disk).
    const app = mkApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/rt-tile/${GEN_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).error).toBe("bundle_unavailable");
  });
});
