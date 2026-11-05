import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { BUNDLE_HASH_HEADER, SCHEDULE_TILE_SIZE_LABEL, parseTileCoords, leafSuffixSet } from "@pt/shared";
import { metricsRegistry } from "../metrics/registry.js";
import type { ManifestSnapshot } from "../gtfs/scheduler.js";

export interface ScheduleTileDeps {
  /**
   * Root directory; bundles live at `<dataDir>/<bundleHash>/...`.
   *
   * Accepts a thunk so the directory can be RE-RESOLVED per request. In
   * `PT_SCHEDULE_TILE_SOURCE=producer` mode the dir is the current published
   * generation's `<genDir>/schedule-tiles`, and the generation rolls under the
   * backend (pt-serve self-reloads, the producer republishes). Freezing the
   * boot-time value would pin the route to a stale — possibly reaped —
   * generation dir. A plain `string` is still accepted for the unchanged
   * `backend`-mode wiring.
   */
  dataDir: string | (() => string);
  /** Resolve the current bundle hash from `<dataDir>/manifest.json`. */
  getCurrentBundleHash: () => string | null;
  /**
   * Optional manifest snapshot (subdivision plans + bundle hash). When present,
   * the route consults `subdivisions[cellKey]` to serve the leaf-coord matrix
   * (bare coord on a subdivided cell → 404 `tile_subdivided`; unknown leaf →
   * 404 `tile_not_found`). Absent ⇒ no subdivision awareness (back-compat).
   */
  getManifestSnapshot?: () => ManifestSnapshot | null;
  /**
   * Byte budget for the in-process tile cache (default 16 MiB — at worst 8
   * tiles at `MAX_COMPRESSED_TILE_BYTES`, typically far more). Tiles are
   * content-addressed by `bundleHash` and immutable, so entries never go
   * stale; the whole cache is purged when the requested (guard-validated)
   * bundle hash rolls, and oldest entries are evicted once the budget is
   * exceeded.
   */
  cacheMaxBytes?: number;
}

interface ScheduleTileParams {
  bundleHash: string;
  tileSize: string;
  tileCoords: string;
}

const BUNDLE_HASH_RE = /^[0-9a-f]{64}$/;
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const DEFAULT_CACHE_MAX_BYTES = 16 * 1024 * 1024;

interface CachedTile {
  buffer: Buffer;
  etag: string;
}

/**
 * Byte-bounded, insertion-order LRU over immutable tiles. Tiles are
 * content-addressed by `bundleHash`, so entries can never go stale — the only
 * invalidation is the wholesale purge when the served bundle hash rolls
 * (`ensureHash`), which also keeps the cache single-hash so retired
 * generations never linger in memory until natural eviction.
 */
class TileLruCache {
  private entries = new Map<string, CachedTile>();
  private bytes = 0;
  private hash: string | null = null;

  constructor(private readonly maxBytes: number) {}

  /** Purge everything when the (guard-validated) bundle hash changes. */
  ensureHash(bundleHash: string): void {
    if (this.hash === bundleHash) return;
    this.hash = bundleHash;
    this.entries.clear();
    this.bytes = 0;
  }

  get(key: string): CachedTile | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    // Refresh recency: Map iterates in insertion order, oldest first.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  set(key: string, tile: CachedTile): void {
    if (tile.buffer.byteLength > this.maxBytes) return; // never cacheable
    const prev = this.entries.get(key);
    if (prev) {
      this.entries.delete(key);
      this.bytes -= prev.buffer.byteLength;
    }
    this.entries.set(key, tile);
    this.bytes += tile.buffer.byteLength;
    for (const [oldestKey, oldest] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      if (oldestKey === key) break; // never evict what we just inserted
      this.entries.delete(oldestKey);
      this.bytes -= oldest.buffer.byteLength;
    }
  }

  stats(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.bytes };
  }
}

const handlerCaches = new WeakMap<object, TileLruCache>();

/** Test-only introspection of a handler's tile cache. */
export function tileCacheStats(handler: object): { entries: number; bytes: number } {
  const cache = handlerCaches.get(handler);
  if (!cache) throw new Error("tileCacheStats: not a schedule-tile handler");
  return cache.stats();
}

export function createScheduleTileHandler(deps: ScheduleTileDeps) {
  const cache = new TileLruCache(deps.cacheMaxBytes ?? DEFAULT_CACHE_MAX_BYTES);
  // Concurrent cold misses on the same tile share one read+hash (same
  // pattern as raptorBundle's in-flight dedup).
  const inFlight = new Map<string, Promise<CachedTile>>();

  function serveTile(
    request: FastifyRequest<{ Params: ScheduleTileParams }>,
    reply: FastifyReply,
    tile: CachedTile,
    bundleHashHeader: string,
  ): void {
    if (request.headers["if-none-match"] === tile.etag) {
      metricsRegistry.scheduleTileRequestTotal.inc({ status: "304" });
      reply
        .status(304)
        .header("ETag", tile.etag)
        .header(BUNDLE_HASH_HEADER, bundleHashHeader)
        .send();
      return;
    }
    metricsRegistry.scheduleTileRequestTotal.inc({ status: "200" });
    reply
      .status(200)
      .header("Content-Type", "application/octet-stream")
      .header("Cache-Control", IMMUTABLE_CACHE)
      .header("ETag", tile.etag)
      .header(BUNDLE_HASH_HEADER, bundleHashHeader)
      .send(tile.buffer);
  }

  const handler = async function scheduleTileHandler(
    request: FastifyRequest<{ Params: ScheduleTileParams }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { bundleHash, tileSize, tileCoords } = request.params;

    if (!BUNDLE_HASH_RE.test(bundleHash)) {
      metricsRegistry.scheduleTileRequestTotal.inc({ status: "400" });
      reply.status(400).send({
        error: { code: "INVALID_BUNDLE_HASH", message: "bundleHash must be 64 hex chars" },
      });
      return;
    }
    if (tileSize !== SCHEDULE_TILE_SIZE_LABEL) {
      metricsRegistry.scheduleTileRequestTotal.inc({ status: "400" });
      reply.status(400).send({
        error: { code: "TILE_SIZE_MISMATCH", message: `Server uses ${SCHEDULE_TILE_SIZE_LABEL}; got ${tileSize}` },
      });
      return;
    }
    const parsed = parseTileCoords(tileCoords);
    if (!parsed) {
      metricsRegistry.scheduleTileRequestTotal.inc({ status: "400" });
      reply.status(400).send({
        error: { code: "INVALID_TILE_COORDS", message: "tileCoords must be `<x>_<y>` or a leaf" },
      });
      return;
    }

    // Rare intra-request roll: `getManifestSnapshot()` runs BEFORE `dataDir()`,
    // and each re-resolves the current generation independently. If the
    // generation rolls between these two calls, the snapshot may return the NEW
    // hash while `dataDir()` still resolves the OLD dir, producing a momentary
    // 409. (The reverse — old hash, new dir — can't occur given this call
    // order.) This self-corrects on the next manifest poll — no special
    // handling needed.
    const snapshot = deps.getManifestSnapshot?.() ?? null;
    const currentBundleHash = snapshot?.bundleHash ?? deps.getCurrentBundleHash();

    // 409 Conflict for all bundle-freshness failures. The frontend cascade only handles 409, so
    // every variant uses that status — but there are three semantically distinct sub-cases with
    // different body shapes:
    //
    //   A. Stale URL hash (currentBundleHash known, doesn't match):
    //      → { error: "bundle_hash_mismatch", currentBundleHash }
    //      Client must re-fetch with the new hash.
    //
    //   B. Bundle dir absent, hash matches current (build in progress):
    //      → { error: "bundle_unavailable" }
    //      Client must back off and retry — sending a different hash would
    //      not help. Earlier code emitted "bundle_hash_mismatch" with a
    //      currentBundleHash equal to the requested hash; that confused the
    //      client because the names contradicted.
    //
    //   C. Bundle dir absent, no current hash known (cold start):
    //      → { error: "bundle_unavailable" }
    //      Server hasn't published any bundle yet.
    if (currentBundleHash && currentBundleHash !== bundleHash) {
      metricsRegistry.scheduleTileRequestTotal.inc({ status: "409" });
      reply.status(409).header(BUNDLE_HASH_HEADER, currentBundleHash);
      reply.send({ error: "bundle_hash_mismatch", currentBundleHash });
      return;
    }

    // The hash guard above ensures only current-bundle requests reach this
    // point, so the cache stays single-hash: a roll purges retired tiles
    // instead of letting them age out of the LRU.
    cache.ensureHash(bundleHash);
    const cacheKey = `${tileSize}/${tileCoords}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      // Tiles are immutable per (bundleHash, coords): a hit implies this exact
      // tile existed on disk for this bundle, so the subdivision matrix and
      // on-disk existence checks below were already settled when it was
      // cached. Serving from memory also survives the janitor's rm of a
      // just-retired dir mid-roll.
      serveTile(request, reply, cached, currentBundleHash ?? bundleHash);
      return;
    }

    const dataDir = typeof deps.dataDir === "function" ? deps.dataDir() : deps.dataDir;
    const bundleDir = join(dataDir, bundleHash);
    if (!existsSync(bundleDir)) {
      metricsRegistry.scheduleTileRequestTotal.inc({ status: "409" });
      reply.status(409).header(BUNDLE_HASH_HEADER, currentBundleHash ?? "");
      reply.send({ error: "bundle_unavailable" });
      return;
    }

    // Subdivision matrix (Part 2b-2). A subdivided cell has its bare `<x>_<y>`
    // tile replaced on disk by N leaf tiles `<x>_<y>-<suffix>`, so a request
    // must address a specific leaf:
    //   - bare coord on a subdivided cell → 404 `tile_subdivided` with the
    //     leaf suffixes inlined so the client can re-request the right leaf.
    //   - leaf coord whose suffix isn't in the plan (or the cell isn't
    //     subdivided at all) → 404 `tile_not_found`.
    // An unsubdivided cell (no plan entry) falls through to the on-disk arm,
    // where a bare coord serves its single tile.
    const plan = snapshot?.subdivisions?.[parsed.cellKey];
    if (parsed.suffix === "" && plan) {
      metricsRegistry.scheduleTile404Total.inc({ reason: "subdivided" });
      metricsRegistry.scheduleTileRequestTotal.inc({ status: "404" });
      reply
        .status(404)
        .header(BUNDLE_HASH_HEADER, currentBundleHash ?? bundleHash)
        .send({ error: "tile_subdivided", leaves: [...leafSuffixSet(plan)] });
      return;
    }
    if (parsed.suffix !== "" && (!plan || !leafSuffixSet(plan).has(parsed.suffix))) {
      metricsRegistry.scheduleTile404Total.inc({ reason: "not_found" });
      metricsRegistry.scheduleTileRequestTotal.inc({ status: "404" });
      reply
        .status(404)
        .header(BUNDLE_HASH_HEADER, currentBundleHash ?? bundleHash)
        .send({ error: "tile_not_found" });
      return;
    }

    const tilePath = join(bundleDir, tileSize, `${tileCoords}.br`);
    if (!existsSync(tilePath)) {
      metricsRegistry.scheduleTile404Total.inc({ reason: "not_found" });
      metricsRegistry.scheduleTileRequestTotal.inc({ status: "404" });
      reply
        .status(404)
        .header(BUNDLE_HASH_HEADER, currentBundleHash ?? bundleHash)
        .send({ error: "tile_not_found" });
      return;
    }

    // TOCTOU-safe read: `existsSync` above can race with the bundle janitor's
    // `rmSync(<hash>.old)`. Wrap in try/catch so a transient ENOENT (or any
    // I/O error) returns a structured 503 with no filesystem-path leak,
    // rather than Fastify's default 500 echoing the absolute path back to
    // the client. The read is async (off the event loop) and deduped so
    // concurrent cold misses on one tile share a single read+hash.
    let tile: CachedTile;
    try {
      let pending = inFlight.get(cacheKey);
      if (!pending) {
        pending = readFile(tilePath).then((buffer) => ({
          buffer,
          etag: `"${createHash("sha256").update(buffer).digest("base64").slice(0, 16)}"`,
        }));
        inFlight.set(cacheKey, pending);
        pending.finally(() => inFlight.delete(cacheKey)).catch(() => {});
      }
      tile = await pending;
    } catch (err) {
      metricsRegistry.scheduleTileRequestTotal.inc({ status: "503" });
      request.log.error({ err, tilePath }, "schedule-tile: read failed after existsSync passed");
      reply.status(503).send({
        error: { code: "TILE_READ_ERROR", message: "Tile temporarily unavailable" },
      });
      return;
    }
    cache.set(cacheKey, tile);
    serveTile(request, reply, tile, currentBundleHash ?? bundleHash);
  };

  handlerCaches.set(handler, cache);
  return handler;
}
