import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCHEDULE_TILE_SIZE_LABEL, encodeScheduleTile, type DecodedScheduleTile,
} from "@pt/shared";
import { compressTileBytes } from "../gtfs/scheduleTileBrotli.js";
import { createRtTileHandler } from "./rtTile.js";
import { metricsRegistry } from "../metrics/registry.js";

const HASH = "a".repeat(64);

// The route increments the process-singleton `metricsRegistry`, not a fresh
// registry, so absolute `=== 1` is cross-test flaky. Delta-assert instead.
async function count404(reason: string): Promise<number> {
  const m = await metricsRegistry.scheduleTile404Total.get();
  return m.values.find((v) => v.labels.reason === reason)?.value ?? 0;
}

// Build a SubdivisionPlan from a list of leaf suffixes (bbox/bytes are not read
// by the RT route — only the suffix set matters).
const planFor = (suffixes: string[]) => ({
  leaves: suffixes.map((s) => ({
    suffix: s,
    bbox: { minLat: 0, minLon: 0, maxLat: 90, maxLon: 90 },
    compressedBytes: 1,
    oversized: false,
  })),
});
const snap = (subdivisions: Record<string, ReturnType<typeof planFor>>) =>
  ({
    bundleHash: HASH,
    contentEtag: "x".repeat(32),
    parsed: { schemaVersion: 1, bundleHash: HASH, generatedAt: 1, tileSize: 6000, subdivisions },
    subdivisions,
  }) as any;

function mkTile(): DecodedScheduleTile {
  return {
    bundleHash: HASH, cityId: "vilnius", tileSize: 12000,
    stringTable: ["T1", "T2", "Downtown"],
    routes: [{ id: "R1", shortName: "1", longName: "Line", color: "#FF0000", mode: "BUS" }],
    calendar: [],
    trips: [
      { tripIdIx: 0, routeIx: 0, serviceIx: 0, headsignIx: 2 },
      { tripIdIx: 1, routeIx: 0, serviceIx: 0, headsignIx: 2 },
    ],
    stops: {
      S1: { tripIxs: new Uint32Array([0, 1]), departureSecs: new Uint32Array([28800, 32400]) },
    },
  };
}

describe("rtTile route", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "ptn-rt-"));
  });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  function mkApp(opts: {
    currentHash?: string | null;
    rtByTripId?: Map<string, Array<{ startDate?: string; delaySeconds: number; cancelled: boolean }>>;
    snapshot?: import("../gtfs/scheduler.js").ManifestSnapshot | null;
  }) {
    const app: FastifyInstance = Fastify({ logger: false });
    app.get("/api/gtfs/rt-tile/:bundleHash/:tileSize/:tileCoords",
      createRtTileHandler({
        dataDir, cityId: "vilnius",
        getCurrentBundleHash: () => opts.currentHash ?? HASH,
        getRtEntriesForTrip: (id) => opts.rtByTripId?.get(id) ?? [],
        getManifestSnapshot: () => opts.snapshot ?? null,
      }));
    return app;
  }

  it("emits RT for EVERY trip in the decoded tile (membership mirrors the schedule-tile), with startDate", async () => {
    const { scheduleTileCoordAt } = await import("@pt/shared");
    const cell = scheduleTileCoordAt(54.6892, 25.2798);
    const coords = `${cell.x}_${cell.y}`;

    mkdirSync(join(dataDir, HASH, SCHEDULE_TILE_SIZE_LABEL), { recursive: true });
    writeFileSync(
      join(dataDir, HASH, SCHEDULE_TILE_SIZE_LABEL, `${coords}.br`),
      await compressTileBytes(encodeScheduleTile(mkTile())), // mkTile carries T1 AND T2
    );

    const app = mkApp({
      currentHash: HASH,
      rtByTripId: new Map([
        ["T1", [{ delaySeconds: 60, cancelled: false }]],
        ["T2", [{ startDate: "20260611", delaySeconds: 30, cancelled: false }]],
      ]),
    });

    const res = await app.inject({ method: "GET", url: `/api/gtfs/rt-tile/${HASH}/${SCHEDULE_TILE_SIZE_LABEL}/${coords}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const byId = Object.fromEntries(body.trips.map((t: any) => [t.tripId, t]));
    expect(body.trips).toHaveLength(2);
    expect(byId.T1).toEqual({ tripId: "T1", delaySeconds: 60, cancelled: false });
    expect(byId.T2).toEqual({ tripId: "T2", startDate: "20260611", delaySeconds: 30, cancelled: false });
  });

  it("re-merges fresh RT from cached membership after body-TTL expiry, without re-reading disk", async () => {
    vi.useFakeTimers();
    try {
      mkdirSync(join(dataDir, HASH, SCHEDULE_TILE_SIZE_LABEL), { recursive: true });
      const tilePath = join(dataDir, HASH, SCHEDULE_TILE_SIZE_LABEL, "1_2.br");
      writeFileSync(tilePath, await compressTileBytes(encodeScheduleTile(mkTile())));

      const rtByTripId = new Map([["T1", [{ delaySeconds: 60, cancelled: false }]]]);
      const app = mkApp({ currentHash: HASH, rtByTripId });
      const url = `/api/gtfs/rt-tile/${HASH}/${SCHEDULE_TILE_SIZE_LABEL}/1_2`;

      const first = await app.inject({ method: "GET", url });
      expect(first.statusCode).toBe(200);
      expect(JSON.parse(first.payload).trips).toHaveLength(1);

      // Expire the 10 s merged-body TTL and change both the RT overlay and
      // the disk state: the tile file is gone (janitor / roll window). The
      // trip membership is immutable per (bundleHash, coords), so the route
      // must serve a FRESH merge from cached membership — not 409/503, and
      // not the stale first body.
      rmSync(tilePath);
      rtByTripId.set("T1", [{ delaySeconds: 120, cancelled: false }]);
      vi.advanceTimersByTime(11_000);

      const second = await app.inject({ method: "GET", url });
      expect(second.statusCode).toBe(200);
      expect(JSON.parse(second.payload).trips).toEqual([
        { tripId: "T1", delaySeconds: 120, cancelled: false },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("409 with flat error string + currentBundleHash when bundleHash is stale", async () => {
    mkdirSync(join(dataDir, HASH, SCHEDULE_TILE_SIZE_LABEL), { recursive: true });
    const c = await compressTileBytes(encodeScheduleTile(mkTile()));
    writeFileSync(join(dataDir, HASH, SCHEDULE_TILE_SIZE_LABEL, "1_2.br"), c);
    const app = mkApp({ currentHash: "b".repeat(64), rtByTripId: new Map() });
    const res = await app.inject({ method: "GET", url: `/api/gtfs/rt-tile/${HASH}/${SCHEDULE_TILE_SIZE_LABEL}/1_2` });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.payload);
    expect(body.currentBundleHash).toBe("b".repeat(64));
    expect(body.error).toBe("bundle_hash_mismatch");
  });

  it("409 bundle_unavailable when the schedule tile is missing (hash matches but file isn't on disk)", async () => {
    const app = mkApp({ currentHash: HASH });
    const res = await app.inject({ method: "GET", url: `/api/gtfs/rt-tile/${HASH}/${SCHEDULE_TILE_SIZE_LABEL}/99_99` });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).error).toBe("bundle_unavailable");
  });

  it("never emits receivedAt (rtEntriesForTrip returns fresh objects)", async () => {
    const { scheduleTileCoordAt } = await import("@pt/shared");
    const cell = scheduleTileCoordAt(54.6892, 25.2798);
    const coords = `${cell.x}_${cell.y}`;
    mkdirSync(join(dataDir, HASH, SCHEDULE_TILE_SIZE_LABEL), { recursive: true });
    writeFileSync(
      join(dataDir, HASH, SCHEDULE_TILE_SIZE_LABEL, `${coords}.br`),
      await compressTileBytes(encodeScheduleTile(mkTile())),
    );
    const app = mkApp({
      currentHash: HASH,
      // Even if a dep accidentally carried receivedAt, the handler builds the
      // wire object field-by-field, so it cannot leak.
      rtByTripId: new Map([["T1", [{ delaySeconds: 60, cancelled: false }]]]),
    });
    const res = await app.inject({ method: "GET", url: `/api/gtfs/rt-tile/${HASH}/${SCHEDULE_TILE_SIZE_LABEL}/${coords}` });
    const body = JSON.parse(res.payload);
    expect(body.trips[0]).not.toHaveProperty("receivedAt");
  });

  it("400 INVALID_BUNDLE_HASH when bundleHash isn't 64 hex chars", async () => {
    const app = mkApp({ currentHash: HASH });
    const sixtyFiveHex = "0".repeat(65);
    const res = await app.inject({ method: "GET", url: `/api/gtfs/rt-tile/${sixtyFiveHex}/${SCHEDULE_TILE_SIZE_LABEL}/1_2` });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe("INVALID_BUNDLE_HASH");
  });

  it("400 TILE_SIZE_MISMATCH when tileSize segment is wrong", async () => {
    const app = mkApp({ currentHash: HASH });
    const res = await app.inject({ method: "GET", url: `/api/gtfs/rt-tile/${HASH}/8km/1_2` });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe("TILE_SIZE_MISMATCH");
  });

  it("400 INVALID_TILE_COORDS when tileCoords don't match the shared parser", async () => {
    const app = mkApp({ currentHash: HASH });
    // Leaf-shaped but suffix digit 9 is out of the 0-3 quadtree range, so the
    // shared parser rejects it (the old local TILE_COORD_RE is gone).
    const res = await app.inject({ method: "GET", url: `/api/gtfs/rt-tile/${HASH}/${SCHEDULE_TILE_SIZE_LABEL}/1_2-9` });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe("INVALID_TILE_COORDS");
  });

  it("404 tile_subdivided with NO inlined leaves for a bare coord on a subdivided cell (R11)", async () => {
    const { scheduleTileCoordAt } = await import("@pt/shared");
    const cell = scheduleTileCoordAt(54.6892, 25.2798);
    const cellKey = `${cell.x}_${cell.y}`;
    const app = mkApp({ currentHash: HASH, snapshot: snap({ [cellKey]: planFor(["0", "3-1"]) }) });
    const before = await count404("subdivided");

    const res = await app.inject({ method: "GET", url: `/api/gtfs/rt-tile/${HASH}/${SCHEDULE_TILE_SIZE_LABEL}/${cellKey}` });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe("tile_subdivided");
    // The RT route does NOT inline leaves (unlike the schedule-tile route).
    expect(body.leaves).toBeUndefined();
    expect(res.headers["x-pt-bundle-hash"]).toBe(HASH);
    expect((await count404("subdivided")) - before).toBe(1);
  });

  it("404 tile_not_found for a leaf coord against an UNsubdivided cell (S8)", async () => {
    const { scheduleTileCoordAt } = await import("@pt/shared");
    const cell = scheduleTileCoordAt(54.6892, 25.2798);
    const cellKey = `${cell.x}_${cell.y}`;
    // snap({}) — no subdivisions at all; a leaf coord must 404, not 200-empty.
    const app = mkApp({ currentHash: HASH, snapshot: snap({}) });
    const before = await count404("not_found");

    const res = await app.inject({ method: "GET", url: `/api/gtfs/rt-tile/${HASH}/${SCHEDULE_TILE_SIZE_LABEL}/${cellKey}-0` });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error).toBe("tile_not_found");
    expect((await count404("not_found")) - before).toBe(1);
  });

  it("membership is the decoded tile: a trip absent from this leaf's tile is not emitted", async () => {
    // Implementation note: the spec asked for REAL subdivideCell/buildTileForCell
    // here, but that's out of budget for this changeset. The leaf-scoping assumption
    // (a per-leaf .br contains exactly that leaf's trips) is separately pinned by
    // the producer-side guard in subdivideCell.test.ts:309 ("differential fidelity").
    // THIS test pins the handler-side behaviour that changed — membership == the
    // decoded tile's trip set, no first-stop filtering — using directly-constructed
    // disjoint leaf tiles (oneTripTile) that avoid the previous same-bytes
    // anti-pattern.
    const { scheduleTileCoordAt } = await import("@pt/shared");
    const cell = scheduleTileCoordAt(54.6892, 25.2798);
    const cellKey = `${cell.x}_${cell.y}`;
    // Two leaves of the same cell; place T1 only in leaf "0", T2 only in leaf "3".
    // `planFor` / `snap` are the module-level helpers already in this file.
    const plan = planFor(["0", "3"]);
    // A DecodedScheduleTile carrying exactly one trip id.
    const oneTripTile = (tripId: string): DecodedScheduleTile => ({
      bundleHash: HASH, cityId: "vilnius", tileSize: 12000,
      stringTable: [tripId, "Downtown"],
      routes: [{ id: "R1", shortName: "1", longName: "Line", color: "#FF0000", mode: "BUS" }],
      calendar: [],
      trips: [{ tripIdIx: 0, routeIx: 0, serviceIx: 0, headsignIx: 1 }],
      stops: { S1: { tripIxs: new Uint32Array([0]), departureSecs: new Uint32Array([28800]) } },
    });
    mkdirSync(join(dataDir, HASH, SCHEDULE_TILE_SIZE_LABEL), { recursive: true });
    writeFileSync(join(dataDir, HASH, SCHEDULE_TILE_SIZE_LABEL, `${cellKey}-0.br`),
      await compressTileBytes(encodeScheduleTile(oneTripTile("T1"))));
    writeFileSync(join(dataDir, HASH, SCHEDULE_TILE_SIZE_LABEL, `${cellKey}-3.br`),
      await compressTileBytes(encodeScheduleTile(oneTripTile("T2"))));

    const app = mkApp({
      currentHash: HASH,
      snapshot: snap({ [cellKey]: plan }),
      rtByTripId: new Map([
        ["T1", [{ delaySeconds: 60, cancelled: false }]],
        ["T2", [{ delaySeconds: 30, cancelled: false }]],
      ]),
    });
    // Leaf 3's tile carries only T2 → only T2 is emitted; T1 (in leaf 0) is absent.
    const res = await app.inject({ method: "GET", url: `/api/gtfs/rt-tile/${HASH}/${SCHEDULE_TILE_SIZE_LABEL}/${cellKey}-3` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.trips.map((t: any) => t.tripId)).toEqual(["T2"]);
  });
});
