import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEDULE_TILE_SIZE_LABEL } from "@pt/shared";
import { createScheduleTileHandler } from "./scheduleTile.js";
import { createGtfsManifestHandler } from "./gtfsManifest.js";
import { createProducerScheduleTileSource } from "../gtfs/producerScheduleTiles.js";

// generationId-shaped hashes (64 hex). The producer sets the schedule-tile
// bundleHash == generationId (the "bridge" pattern), so reuse them as both.
const GEN_A = "a".repeat(64);
const GEN_B = "b".repeat(64);

/** Write a published generation dir with a schedule-tile bundle + manifest. */
function writeGeneration(
  dataRoot: string,
  generationId: string,
  tileBytes: Record<string, string>, // `<x>_<y>` → body
  subdivisions?: Record<string, unknown>,
): void {
  const tilesDir = join(dataRoot, "generations", generationId, "schedule-tiles");
  const bundleDir = join(tilesDir, generationId, SCHEDULE_TILE_SIZE_LABEL);
  mkdirSync(bundleDir, { recursive: true });
  for (const [coords, body] of Object.entries(tileBytes)) {
    writeFileSync(join(bundleDir, `${coords}.br`), Buffer.from(body));
  }
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    bundleHash: generationId,
    generatedAt: 1,
    tileSize: 6000,
  };
  if (subdivisions) manifest.subdivisions = subdivisions;
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

describe("scheduleTile route — PT_SCHEDULE_TILE_SOURCE=producer", () => {
  let dataRoot: string;
  let backendDataDir: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), "ptn-prod-root-"));
    // A SEPARATE backend in-process data dir, to prove the route does NOT
    // serve from it in producer mode.
    backendDataDir = mkdtempSync(join(tmpdir(), "ptn-backend-tiles-"));
    vi.stubEnv("PT_SCHEDULE_TILE_SOURCE", "producer");
    vi.stubEnv("PT_DATA_ROOT", dataRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(backendDataDir, { recursive: true, force: true });
  });

  /**
   * Wire the routes exactly as index.ts does in producer mode: the route's
   * `dataDir` is a thunk over the producer source (re-resolves the gen dir per
   * request), and `getCurrentBundleHash` reads the gen-dir manifest — NOT the
   * backend's SCHEDULE_TILE_DATA_DIR.
   */
  function mkApp() {
    const source = createProducerScheduleTileSource(process.env.PT_DATA_ROOT);
    const app = Fastify({ logger: false });
    app.get(
      "/api/gtfs/schedule-tile/:bundleHash/:tileSize/:tileCoords",
      createScheduleTileHandler({
        // Thunk: re-resolve the gen dir per request. Falls back to the
        // (empty) backend dir only when the producer source can't resolve.
        dataDir: () => source.resolveDataDir() ?? backendDataDir,
        getCurrentBundleHash: () => source.getCurrentBundleHash(),
        // Wire getManifestSnapshot so subdivision plans are consulted, exactly
        // as index.ts does (line 323).
        getManifestSnapshot: () => source.getManifestSnapshot(),
      }),
    );
    // Producer-mode manifest advertise: bundleHash comes from the gen-dir
    // schedule-tiles/manifest.json, surfaced as X-PT-Bundle-Hash.
    app.get(
      "/api/gtfs/manifest",
      createGtfsManifestHandler({
        getManifestSnapshot: () => {
          const hash = source.getCurrentBundleHash();
          if (!hash) return null;
          return {
            bundleHash: hash,
            contentEtag: "e".repeat(32),
            parsed: { schemaVersion: 1, bundleHash: hash, generatedAt: 1, tileSize: 6000 },
          };
        },
      }),
    );
    return app;
  }

  it("serves a 200 .br tile from the producer gen-dir bundle for the current hash", async () => {
    writeGeneration(dataRoot, GEN_A, { "1_2": "producer-brotli-bytes" });
    flipCurrent(dataRoot, GEN_A);

    const app = mkApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${GEN_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["x-pt-bundle-hash"]).toBe(GEN_A);
    expect(res.rawPayload.toString()).toBe("producer-brotli-bytes");
  });

  it("getCurrentBundleHash() resolves from the gen-dir manifest, NOT the backend dir", async () => {
    // Backend dir has a DIFFERENT hash on disk; producer mode must ignore it.
    mkdirSync(join(backendDataDir, GEN_B, SCHEDULE_TILE_SIZE_LABEL), { recursive: true });
    writeFileSync(
      join(backendDataDir, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, bundleHash: GEN_B, generatedAt: 1, tileSize: 6000 }),
    );
    writeGeneration(dataRoot, GEN_A, { "1_2": "x" });
    flipCurrent(dataRoot, GEN_A);

    const source = createProducerScheduleTileSource(process.env.PT_DATA_ROOT);
    expect(source.getCurrentBundleHash()).toBe(GEN_A);
  });

  it("advertises the producer bundleHash on /api/gtfs/manifest", async () => {
    writeGeneration(dataRoot, GEN_A, { "1_2": "x" });
    flipCurrent(dataRoot, GEN_A);

    const app = mkApp();
    const res = await app.inject({ method: "GET", url: "/api/gtfs/manifest" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-pt-bundle-hash"]).toBe(GEN_A);
    expect(JSON.parse(res.payload).bundleHash).toBe(GEN_A);
  });

  it("re-advertises the new hash after a generation roll (no boot-time freeze)", async () => {
    writeGeneration(dataRoot, GEN_A, { "1_2": "gen-a-bytes" });
    flipCurrent(dataRoot, GEN_A);

    const app = mkApp();
    const first = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${GEN_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-pt-bundle-hash"]).toBe(GEN_A);

    // Producer publishes a new generation and flips current.json.
    writeGeneration(dataRoot, GEN_B, { "1_2": "gen-b-bytes" });
    flipCurrent(dataRoot, GEN_B);

    // Old hash is now stale → 409 carrying the NEW hash.
    const stale = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${GEN_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.headers["x-pt-bundle-hash"]).toBe(GEN_B);

    // New hash serves the new gen-dir bytes.
    const fresh = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${GEN_B}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.headers["x-pt-bundle-hash"]).toBe(GEN_B);
    expect(fresh.rawPayload.toString()).toBe("gen-b-bytes");

    // And the manifest re-advertises the new hash.
    const manifest = await app.inject({ method: "GET", url: "/api/gtfs/manifest" });
    expect(manifest.headers["x-pt-bundle-hash"]).toBe(GEN_B);
  });

  it("cold start (no current.json yet) returns 409 bundle_unavailable, not bundle_hash_mismatch", async () => {
    // Producer mode is configured but no generation has been published yet —
    // current.json is absent. A request must get bundle_unavailable (back off
    // and retry), NOT bundle_hash_mismatch (which would tell the client to
    // re-fetch a different hash that doesn't exist).
    const app = mkApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${GEN_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).error).toBe("bundle_unavailable");
  });

  it("bare coord on a subdivided cell returns 404 tile_subdivided with leaf suffixes", async () => {
    // Write a gen-dir manifest that marks cell "1_2" as subdivided with two
    // leaves ("0" and "3-1"). The bare coord tile file is present on disk —
    // the route must consult the subdivision plan BEFORE falling through to
    // the on-disk arm, exactly as the backend-mode tests verify.
    const subdivisionPlan = {
      "1_2": {
        leaves: [
          { suffix: "0", bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 }, compressedBytes: 1, oversized: false },
          { suffix: "3-1", bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 }, compressedBytes: 1, oversized: false },
        ],
      },
    };
    writeGeneration(dataRoot, GEN_A, { "1_2": "bare-tile-bytes" }, subdivisionPlan);
    flipCurrent(dataRoot, GEN_A);

    const app = mkApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${GEN_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers["x-pt-bundle-hash"]).toBe(GEN_A);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe("tile_subdivided");
    expect([...body.leaves].sort()).toEqual(["0", "3-1"]);
  });
});
