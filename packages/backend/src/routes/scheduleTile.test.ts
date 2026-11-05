import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEDULE_TILE_SIZE_LABEL } from "@pt/shared";
import { createScheduleTileHandler, tileCacheStats } from "./scheduleTile.js";
import { metricsRegistry } from "../metrics/registry.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

// The route increments the process-singleton `metricsRegistry`, not a fresh
// registry, so absolute `=== 1` is cross-test flaky. Delta-assert instead.
async function count404(reason: string): Promise<number> {
  const m = await metricsRegistry.scheduleTile404Total.get();
  return m.values.find((v) => v.labels.reason === reason)?.value ?? 0;
}

const planAB = {
  leaves: [
    { suffix: "0", bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 }, compressedBytes: 1, oversized: false },
    { suffix: "3-1", bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 }, compressedBytes: 1, oversized: false },
  ],
};
const snap = (bundleHash: string, subdivisions: Record<string, typeof planAB> = {}) =>
  ({
    bundleHash,
    contentEtag: "x".repeat(32),
    parsed: { schemaVersion: 1, bundleHash, generatedAt: 1, tileSize: 6000, subdivisions },
    subdivisions,
  }) as any;

describe("scheduleTile route", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "ptn-st-"));
    mkdirSync(join(dataDir, HASH_A, SCHEDULE_TILE_SIZE_LABEL), { recursive: true });
    writeFileSync(join(dataDir, HASH_A, SCHEDULE_TILE_SIZE_LABEL, "1_2.br"), Buffer.from("brotli-bytes"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function mkApp(
    currentHash: string | null,
    snapshot: import("../gtfs/scheduler.js").ManifestSnapshot | null = null,
  ) {
    const app = Fastify({ logger: false });
    app.get(
      "/api/gtfs/schedule-tile/:bundleHash/:tileSize/:tileCoords",
      createScheduleTileHandler({
        dataDir,
        getCurrentBundleHash: () => currentHash,
        getManifestSnapshot: () => snapshot,
      }),
    );
    return app;
  }

  it("200 with octet-stream raw body + ETag + immutable cache + X-PT-Bundle-Hash", async () => {
    const app = mkApp(HASH_A);
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${HASH_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers["vary"]).toBeUndefined();
    expect(res.headers["cache-control"]).toMatch(/immutable/);
    expect(res.headers["x-pt-bundle-hash"]).toBe(HASH_A);
    expect(res.headers["etag"]).toMatch(/^"[A-Za-z0-9+/=]{16}"$/);
    expect(res.rawPayload.toString()).toBe("brotli-bytes");
  });

  it("304 when If-None-Match matches the ETag", async () => {
    const app = mkApp(HASH_A);
    const first = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${HASH_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });
    const etag = first.headers["etag"]!;

    const second = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${HASH_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
      headers: { "if-none-match": etag },
    });
    expect(second.statusCode).toBe(304);
  });

  it("serves a cached tile without re-reading disk (file deleted after first hit)", async () => {
    const app = mkApp(HASH_A);
    const url = `/api/gtfs/schedule-tile/${HASH_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`;
    const first = await app.inject({ method: "GET", url });
    expect(first.statusCode).toBe(200);

    rmSync(join(dataDir, HASH_A, SCHEDULE_TILE_SIZE_LABEL, "1_2.br"));

    const second = await app.inject({ method: "GET", url });
    expect(second.statusCode).toBe(200);
    expect(second.rawPayload.toString()).toBe("brotli-bytes");
    expect(second.headers["etag"]).toBe(first.headers["etag"]);

    const third = await app.inject({
      method: "GET",
      url,
      headers: { "if-none-match": first.headers["etag"]! },
    });
    expect(third.statusCode).toBe(304);
  });

  it("purges cached tiles when the requested bundle hash rolls", async () => {
    let currentHash = HASH_A;
    const app = Fastify({ logger: false });
    const handler = createScheduleTileHandler({
      dataDir,
      getCurrentBundleHash: () => currentHash,
      getManifestSnapshot: () => null,
    });
    app.get("/api/gtfs/schedule-tile/:bundleHash/:tileSize/:tileCoords", handler);

    const urlA = `/api/gtfs/schedule-tile/${HASH_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`;
    expect((await app.inject({ method: "GET", url: urlA })).statusCode).toBe(200);

    // Roll the generation: publish HASH_B, retire HASH_A.
    mkdirSync(join(dataDir, HASH_B, SCHEDULE_TILE_SIZE_LABEL), { recursive: true });
    writeFileSync(join(dataDir, HASH_B, SCHEDULE_TILE_SIZE_LABEL, "1_2.br"), Buffer.from("new-bytes"));
    currentHash = HASH_B;

    const urlB = `/api/gtfs/schedule-tile/${HASH_B}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`;
    const resB = await app.inject({ method: "GET", url: urlB });
    expect(resB.statusCode).toBe(200);
    expect(resB.rawPayload.toString()).toBe("new-bytes");

    // Old-hash entries must be gone (single-hash cache): stale hash 409s at
    // the guard, and the cache no longer retains HASH_A bytes.
    expect(tileCacheStats(handler).entries).toBe(1);
  });

  it("evicts oldest entries once the byte budget is exceeded", async () => {
    const app = Fastify({ logger: false });
    const handler = createScheduleTileHandler({
      dataDir,
      getCurrentBundleHash: () => HASH_A,
      getManifestSnapshot: () => null,
      cacheMaxBytes: 25, // "brotli-bytes" = 12 bytes → 2 tiles fit, 3rd evicts
    });
    app.get("/api/gtfs/schedule-tile/:bundleHash/:tileSize/:tileCoords", handler);

    for (const coords of ["1_2", "3_4", "5_6"]) {
      writeFileSync(
        join(dataDir, HASH_A, SCHEDULE_TILE_SIZE_LABEL, `${coords}.br`),
        Buffer.from("brotli-bytes"),
      );
      const res = await app.inject({
        method: "GET",
        url: `/api/gtfs/schedule-tile/${HASH_A}/${SCHEDULE_TILE_SIZE_LABEL}/${coords}`,
      });
      expect(res.statusCode).toBe(200);
    }
    const stats = tileCacheStats(handler);
    expect(stats.entries).toBe(2);
    expect(stats.bytes).toBeLessThanOrEqual(25);

    // Evicted (oldest) tile falls back to disk — file removed → 404 now.
    rmSync(join(dataDir, HASH_A, SCHEDULE_TILE_SIZE_LABEL, "1_2.br"));
    const evicted = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${HASH_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });
    expect(evicted.statusCode).toBe(404);
  });

  it("409 with flat error string + currentBundleHash body when bundleHash is stale", async () => {
    const app = mkApp(HASH_B);
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${HASH_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.headers["x-pt-bundle-hash"]).toBe(HASH_B);
    const body = JSON.parse(res.payload);
    expect(body.currentBundleHash).toBe(HASH_B);
    expect(body.error).toBe("bundle_hash_mismatch");
  });

  it("409 bundle_unavailable when current hash matches but bundle dir is missing (build in progress)", async () => {
    // The previous behaviour emitted `bundle_hash_mismatch` here, which was
    // semantically wrong: the client sent the right hash, but the server's
    // bundle dir hadn't been written yet. Sending a different hash would not
    // help — the correct directive is to back off and retry.
    const app = mkApp(HASH_B);
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${HASH_B}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.headers["x-pt-bundle-hash"]).toBe(HASH_B);
    expect(JSON.parse(res.payload).error).toBe("bundle_unavailable");
  });

  it("409 bundle_unavailable with empty X-PT-Bundle-Hash when no bundle has been published yet (cold start)", async () => {
    const app = mkApp(null);
    // Request HASH_B (no dir created in beforeEach) so the missing-dir
    // branch fires; HASH_A would resolve a real bundle on disk and return 200.
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${HASH_B}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.headers["x-pt-bundle-hash"]).toBe("");
    expect(JSON.parse(res.payload).error).toBe("bundle_unavailable");
  });

  it("304 carries X-PT-Bundle-Hash so revalidating clients keep in-band hash discovery", async () => {
    const app = mkApp(HASH_A);
    const first = await app.inject({ method: "GET", url: `/api/gtfs/schedule-tile/${HASH_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2` });
    const etag = first.headers["etag"]!;
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${HASH_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
      headers: { "if-none-match": etag },
    });
    expect(res.statusCode).toBe(304);
    expect(res.headers["x-pt-bundle-hash"]).toBe(HASH_A);
  });

  it("404 with X-PT-Bundle-Hash when bundleHash matches but cell has no tile", async () => {
    const app = mkApp(HASH_A);
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${HASH_A}/${SCHEDULE_TILE_SIZE_LABEL}/99_99`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers["x-pt-bundle-hash"]).toBe(HASH_A);
    expect(JSON.parse(res.payload).error).toBe("tile_not_found");
  });

  it("404 tile_subdivided with inlined leaves for a bare coord on a subdivided cell", async () => {
    const app = mkApp(HASH_A, snap(HASH_A, { "1_2": planAB }));
    const before = await count404("subdivided");
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${HASH_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers["x-pt-bundle-hash"]).toBe(HASH_A);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe("tile_subdivided");
    expect([...body.leaves].sort()).toEqual(["0", "3-1"]);
    expect((await count404("subdivided")) - before).toBe(1);
  });

  it("404 tile_not_found for a leaf coord whose suffix is not in the plan", async () => {
    const app = mkApp(HASH_A, snap(HASH_A, { "1_2": planAB }));
    const before = await count404("not_found");
    // suffix "1" ∉ {"0","3-1"}
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${HASH_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2-1`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers["x-pt-bundle-hash"]).toBe(HASH_A);
    expect(JSON.parse(res.payload).error).toBe("tile_not_found");
    expect((await count404("not_found")) - before).toBe(1);
  });

  it("404 tile_not_found for a leaf coord against an unsubdivided cell", async () => {
    const app = mkApp(HASH_A, snap(HASH_A, {}));
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${HASH_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2-0`,
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error).toBe("tile_not_found");
  });

  it("200 octet-stream byte-identical for a valid leaf coord", async () => {
    writeFileSync(
      join(dataDir, HASH_A, SCHEDULE_TILE_SIZE_LABEL, "1_2-0.br"),
      Buffer.from("leaf0-bytes"),
    );
    const app = mkApp(HASH_A, snap(HASH_A, { "1_2": planAB }));
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${HASH_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2-0`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.rawPayload.toString()).toBe("leaf0-bytes");
  });

  it("200 for an oversized leaf (oversized is a build label, not a serve gate)", async () => {
    const oversizedPlan = {
      leaves: [
        { suffix: "0", bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 }, compressedBytes: 1, oversized: false },
        { suffix: "3-1", bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 }, compressedBytes: 9_999_999, oversized: true },
      ],
    };
    writeFileSync(
      join(dataDir, HASH_A, SCHEDULE_TILE_SIZE_LABEL, "1_2-3-1.br"),
      Buffer.from("oversized-leaf-bytes"),
    );
    const app = mkApp(HASH_A, snap(HASH_A, { "1_2": oversizedPlan }));
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${HASH_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2-3-1`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.toString()).toBe("oversized-leaf-bytes");
  });

  it("200 for an over-cap single bare cell with NO plan entry (not subdivided)", async () => {
    // `1_2.br` exists (beforeEach); the cell has no subdivision plan, so the
    // bare coord must serve the on-disk tile, not 404.
    const app = mkApp(HASH_A, snap(HASH_A, {}));
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${HASH_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.toString()).toBe("brotli-bytes");
  });

  it("404 tile_not_found + counter when a planned leaf is missing on disk", async () => {
    // suffix "0" ∈ plan so it passes the plan gate, but no `1_2-0.br` is written
    // → the on-disk existsSync arm fires (M3).
    const app = mkApp(HASH_A, snap(HASH_A, { "1_2": planAB }));
    const before = await count404("not_found");
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${HASH_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2-0`,
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error).toBe("tile_not_found");
    expect((await count404("not_found")) - before).toBe(1);
  });

  it("400 INVALID_BUNDLE_HASH when bundleHash isn't 64 hex chars", async () => {
    const app = mkApp(HASH_A);
    // Use a 65-char hex string so Fastify accepts the route param but the
    // handler's regex check rejects it (too long, not exactly 64 chars).
    const tooLong = "0".repeat(65);
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${tooLong}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe("INVALID_BUNDLE_HASH");
  });

  it("400 TILE_SIZE_MISMATCH when tileSize segment is wrong", async () => {
    const app = mkApp(HASH_A);
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${HASH_A}/8km/1_2`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe("TILE_SIZE_MISMATCH");
  });

  it("400 INVALID_TILE_COORDS when tileCoords don't match the pattern", async () => {
    const app = mkApp(HASH_A);
    // Leaf-shaped but suffix digit 9 is out of the 0-3 quadtree range, so the
    // shared parser still rejects it.
    const res = await app.inject({
      method: "GET",
      url: `/api/gtfs/schedule-tile/${HASH_A}/${SCHEDULE_TILE_SIZE_LABEL}/1_2-9`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe("INVALID_TILE_COORDS");
  });
});
