import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyRequest, FastifyReply } from "fastify";
import {
  BUNDLE_HASH_HEADER,
  RT_CACHE_MAX_AGE_S,
  SCHEDULE_TILE_SIZE_LABEL,
  decodeScheduleTile,
  parseTileCoords,
  leafSuffixSet,
  type RtTileResponse,
  type RtTripUpdate,
} from "@pt/shared";
import { decompressTileBytes } from "../gtfs/scheduleTileBrotli.js";
import { TtlLru } from "../util/ttlLru.js";
import { metricsRegistry } from "../metrics/registry.js";
import type { ManifestSnapshot } from "../gtfs/scheduler.js";

export interface RtTileDeps {
  /**
   * Root dir; the schedule tile whose trip set defines membership lives at
   * `<dataDir>/<bundleHash>/<tileSize>/<coords>.br`. A thunk (re-resolved per
   * request) in `PT_SCHEDULE_TILE_SOURCE=producer` mode, where the membership
   * tile comes from the current published GENERATION dir — which rolls under
   * the backend, so the dir must not be frozen at boot (mirrors the
   * schedule-tile route). A plain string in the default `backend` mode.
   */
  dataDir: string | (() => string);
  cityId: string;
  getCurrentBundleHash: () => string | null;
  /** All generation-current RT entries for a trip (bare + date-scoped). */
  getRtEntriesForTrip: (
    tripId: string,
  ) => Array<{ startDate?: string; delaySeconds: number; cancelled: boolean }>;
  /**
   * Optional manifest snapshot (subdivision plans + bundle hash). When present,
   * the route is leaf-aware: a bare coord on a subdivided cell → 404
   * `tile_subdivided` (NO inlined leaves — unlike the schedule-tile route), an
   * unknown leaf → 404 `tile_not_found`. Trip membership comes from the decoded
   * leaf tile (no first-stop filtering). Absent ⇒ no subdivision awareness.
   */
  getManifestSnapshot?: () => ManifestSnapshot | null;
}

interface RtTileParams {
  bundleHash: string;
  tileSize: string;
  tileCoords: string;
}

const BUNDLE_HASH_RE = /^[0-9a-f]{64}$/;
const RT_TILE_TTL_MS = RT_CACHE_MAX_AGE_S * 1000;
// Leaf-aware: worst case `cells_touched × 4^MAX_SUBDIVISION_DEPTH` (= cells × 256)
// within the 5 s TTL. Only a handful of cells subdivide, and only the densest
// cities subdivide at all. 4096 covers the densest city's leaf set within the TTL;
// a too-small LRU silently re-decodes every poll.
const RT_TILE_LRU_SIZE = 4096;

export function createRtTileHandler(deps: RtTileDeps) {
  const cache = new TtlLru<string, RtTileResponse>({ maxSize: RT_TILE_LRU_SIZE, ttlMs: RT_TILE_TTL_MS });
  // Trip MEMBERSHIP is immutable per (bundleHash, coords) — only the RT
  // overlay needs the 5 s freshness above. Cache the decoded trip-id list
  // separately with no TTL so a body-TTL expiry re-merges RT from memory
  // instead of re-reading + brotli-decompressing + JSON-decoding the tile on
  // the request thread every 5 s. Insertion-order LRU, single-hash: purged
  // wholesale when the guard-validated bundle hash rolls (mirrors the
  // schedule-tile route's cache) so retired generations don't linger.
  const membership = new Map<string, string[]>();
  let membershipHash: string | null = null;

  return async function rtTileHandler(
    request: FastifyRequest<{ Params: RtTileParams }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { bundleHash, tileSize, tileCoords } = request.params;

    if (!BUNDLE_HASH_RE.test(bundleHash)) {
      metricsRegistry.rtTileRequestTotal.inc({ status: "400", cache_hit: "n/a" });
      reply.status(400).send({ error: { code: "INVALID_BUNDLE_HASH", message: "bundleHash must be 64 hex chars" } });
      return;
    }
    if (tileSize !== SCHEDULE_TILE_SIZE_LABEL) {
      metricsRegistry.rtTileRequestTotal.inc({ status: "400", cache_hit: "n/a" });
      reply.status(400).send({ error: { code: "TILE_SIZE_MISMATCH", message: `Server uses ${SCHEDULE_TILE_SIZE_LABEL}` } });
      return;
    }
    const parsed = parseTileCoords(tileCoords);
    if (!parsed) {
      metricsRegistry.rtTileRequestTotal.inc({ status: "400", cache_hit: "n/a" });
      reply.status(400).send({ error: { code: "INVALID_TILE_COORDS", message: "tileCoords must be `<x>_<y>` or a leaf" } });
      return;
    }

    const snapshot = deps.getManifestSnapshot?.() ?? null;
    const currentBundleHash = snapshot?.bundleHash ?? deps.getCurrentBundleHash();
    // Resolve the membership-tile dir ONCE per request (a thunk in producer
    // mode re-resolves the current generation's `schedule-tiles` dir). Resolved
    // here — alongside the snapshot/hash above — so a mid-request generation
    // roll can't tear the hash from the dir the tile is read from.
    const dataDir = typeof deps.dataDir === "function" ? deps.dataDir() : deps.dataDir;
    if (currentBundleHash && currentBundleHash !== bundleHash) {
      metricsRegistry.rtTileRequestTotal.inc({ status: "409", cache_hit: "n/a" });
      reply.status(409).header(BUNDLE_HASH_HEADER, currentBundleHash);
      reply.send({ error: "bundle_hash_mismatch", currentBundleHash });
      return;
    }

    // Subdivision matrix (Part 2b-2). Gated BEFORE the cache lookup so a warm
    // entry can't escape a since-subdivided coord. Unlike the schedule-tile
    // route, the RT route does NOT inline the leaf suffixes (clients learn the
    // leaf set from the schedule-tile 404):
    //   - bare coord on a subdivided cell → 404 `tile_subdivided`.
    //   - leaf coord whose suffix isn't in the plan (or the cell isn't
    //     subdivided at all) → 404 `tile_not_found`.
    const plan = snapshot?.subdivisions?.[parsed.cellKey];
    if (parsed.suffix === "" && plan) {
      metricsRegistry.scheduleTile404Total.inc({ reason: "subdivided" });
      metricsRegistry.rtTileRequestTotal.inc({ status: "404", cache_hit: "n/a" });
      reply.status(404).header(BUNDLE_HASH_HEADER, currentBundleHash ?? bundleHash)
        .send({ error: "tile_subdivided" });
      return;
    }
    if (parsed.suffix !== "" && (!plan || !leafSuffixSet(plan).has(parsed.suffix))) {
      metricsRegistry.scheduleTile404Total.inc({ reason: "not_found" });
      metricsRegistry.rtTileRequestTotal.inc({ status: "404", cache_hit: "n/a" });
      reply.status(404).header(BUNDLE_HASH_HEADER, currentBundleHash ?? bundleHash)
        .send({ error: "tile_not_found" });
      return;
    }

    const cacheKey = `${deps.cityId}/${bundleHash}/${tileCoords}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      metricsRegistry.rtTileRequestTotal.inc({ status: "200", cache_hit: "hit" });
      reply.status(200)
        .header("Cache-Control", `public, max-age=${RT_CACHE_MAX_AGE_S}, s-maxage=${RT_CACHE_MAX_AGE_S}`)
        .header("Vary", "Accept-Encoding")
        .header(BUNDLE_HASH_HEADER, bundleHash)
        .send(cached);
      return;
    }

    // The hash guard above ensures only current-bundle requests reach this
    // point — safe to purge on roll and key membership by coords alone.
    if (membershipHash !== bundleHash) {
      membershipHash = bundleHash;
      membership.clear();
    }
    let tripIds = membership.get(cacheKey);
    if (tripIds) {
      // Refresh recency (Map iterates insertion-ordered, oldest first).
      membership.delete(cacheKey);
      membership.set(cacheKey, tripIds);
    } else {
      const tilePath = join(dataDir, bundleHash, tileSize, `${tileCoords}.br`);
      if (!existsSync(tilePath)) {
        // Hash matches current but the schedule tile file isn't on disk yet
        // (build in progress) or no bundle has been published. Either way the
        // client must back off — `bundle_unavailable` is the correct body
        // (sending a different hash would not help, so a `bundle_hash_mismatch`
        // body would be semantically wrong).
        metricsRegistry.rtTileRequestTotal.inc({ status: "409", cache_hit: "n/a" });
        reply.status(409).header(BUNDLE_HASH_HEADER, currentBundleHash ?? "");
        reply.send({ error: "bundle_unavailable" });
        return;
      }

      // Three independent throw sources: `readFile` ENOENT (TOCTOU vs.
      // janitor), `decompressTileBytes` on corrupt brotli, `decodeScheduleTile`
      // on malformed JSON / wire-shape. Without this guard, all surface as
      // Fastify default 500 echoing the absolute filesystem path back to the
      // client, AND the frontend's 409-cascade can't recover (only handles 409).
      try {
        const decoded = decodeScheduleTile(decompressTileBytes(await readFile(tilePath)));
        tripIds = decoded.trips.map((t) => decoded.stringTable[t.tripIdIx]!);
      } catch (err) {
        metricsRegistry.rtTileRequestTotal.inc({ status: "503", cache_hit: "miss" });
        request.log.error({ err, tilePath }, "rt-tile: failed to read or decode schedule tile");
        reply.status(503).send({
          error: { code: "TILE_READ_ERROR", message: "Tile temporarily unavailable" },
        });
        return;
      }
      membership.set(cacheKey, tripIds);
      while (membership.size > RT_TILE_LRU_SIZE) {
        const oldest = membership.keys().next().value;
        if (oldest === undefined) break;
        membership.delete(oldest);
      }
    }

    // Membership = the decoded tile's trip set (the per-leaf `.br` is already
    // leaf-scoped; verified vs subdivideCell). Emit one wire entry per RT entry
    // for each trip — no first-stop ownership/drift filtering (Stage A G1).
    const trips: RtTripUpdate[] = [];
    for (const tripIdStr of tripIds) {
      for (const entry of deps.getRtEntriesForTrip(tripIdStr)) {
        trips.push({
          tripId: tripIdStr,
          delaySeconds: entry.delaySeconds,
          cancelled: entry.cancelled,
          ...(entry.startDate !== undefined ? { startDate: entry.startDate } : {}),
        });
      }
    }

    const body: RtTileResponse = {
      bundleHash,
      generatedAt: Date.now(),
      trips,
    };
    cache.set(cacheKey, body);

    metricsRegistry.rtTileRequestTotal.inc({ status: "200", cache_hit: "miss" });
    reply.status(200)
      .header("Cache-Control", `public, max-age=${RT_CACHE_MAX_AGE_S}, s-maxage=${RT_CACHE_MAX_AGE_S}`)
      .header("Vary", "Accept-Encoding")
      .header(BUNDLE_HASH_HEADER, bundleHash)
      .send(body);
  };
}
