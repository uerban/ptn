import type { CanonicalStore } from "./canonical/CanonicalStore.js";
import { computeBundleHash, type ComputeBundleHashFeedFile } from "./computeBundleHash.js";
import { buildBundle } from "./buildBundle.js";
import type { BuildBundleSubdivisionStats } from "./buildBundle.js";
import { writeBundleManifest } from "./writeBundleManifest.js";
import { sweepBundleJanitor } from "./bundleJanitor.js";
import { SCHEDULE_TILE_EDGE_METERS, MAX_SUBDIVISION_DEPTH, SUBDIVISION_ALGO_VERSION } from "@pt/shared";
import type { SubdivisionPlan } from "@pt/shared";
import { MAX_COMPRESSED_TILE_BYTES } from "./scheduleTileBrotli.js";
import type { RouteResolvers } from "./routeResolvers.js";

export interface BuildAndPublishBundleInput extends RouteResolvers {
  canonical: CanonicalStore;
  cityId: string;
  dataDir: string;
  /** Hash inputs for `computeBundleHash`. */
  feedFiles: readonly ComputeBundleHashFeedFile[];
  rtFeedUrls: readonly string[];
  minTripsPerRoute: number;
  /** Optional generatedAt (Unix ms); defaults to `Date.now()`. */
  generatedAt?: number;
  /***/
  keepBundleCount?: number;
  /** Per-leaf compressed-byte cap. Defaults to the production cap; tests inject a tiny cap. */
  maxCompressedTileBytes?: number;
  /** Max quadtree depth. Defaults to MAX_SUBDIVISION_DEPTH. */
  maxSubdivisionDepth?: number;
}

export interface BuildAndPublishBundleResult {
  bundleHash: string;
  tilesWritten: number;
  janitor: { kept: string[]; deleted: string[] };
  subdivisions: Record<string, SubdivisionPlan>;
  stats: BuildBundleSubdivisionStats;
}

/**
 * Pipeline: compute hash → buildBundle → writeBundleManifest → sweepJanitor.
 *
 * Manifest is written AFTER the bundle's atomic rename so the file never
 * points to a directory that doesn't exist. Janitor runs LAST so the
 * just-written bundle is always retained — provided `keepBundleCount >= 1`.
 *
 * Wired from `GtfsScheduler.schedulePublishBundle` after each successful
 * `swap()`, on `setImmediate` so the build's start is decoupled from the
 * synchronous swap() call path (see schedulePublishBundle's doc comment).
 * Brotli q=11 stays SYNCHRONOUS on the main thread
 * (off-thread compression regressed steady RSS via extra glibc arenas — see
 * `scheduleTileBrotli.ts`); instead `buildBundle` awaits a `setImmediate`
 * between tiles so the event loop drains between the per-cell ~1 s blocks,
 * turning a multi-minute freeze on large feeds (Paris IDFM ~500+ cells) into
 * brief per-tile latency blips. `computeBundleHash`, `writeBundleManifest` and
 * `sweepBundleJanitor` stay synchronous (fast, post-swap, not the blocker).
 */
export async function buildAndPublishBundle(
  input: BuildAndPublishBundleInput,
): Promise<BuildAndPublishBundleResult> {
  const generatedAt = input.generatedAt ?? Date.now();
  const keepBundleCount = input.keepBundleCount ?? 2;

  // Guard against `keepBundleCount: 0`. The orchestrator writes the manifest
  // BEFORE the janitor sweep; if the sweep then deletes everything, the
  // manifest points at a now-absent bundle dir until the next build. The
  // janitor itself accepts `keepCount: 0` (a valid full-purge mode for
  // standalone callers), but the orchestrator must always retain at least
  // the bundle it just wrote.
  if (keepBundleCount < 1) {
    throw new RangeError(
      `buildAndPublishBundle: keepBundleCount must be >= 1, got ${keepBundleCount}. ` +
        `keepBundleCount=0 would delete the just-written bundle, leaving the ` +
        `manifest pointing at a missing directory.`,
    );
  }

  const cap = input.maxCompressedTileBytes ?? MAX_COMPRESSED_TILE_BYTES;
  const maxDepth = input.maxSubdivisionDepth ?? MAX_SUBDIVISION_DEPTH;

  const bundleHash = computeBundleHash({
    feedFiles: input.feedFiles,
    tileSize: SCHEDULE_TILE_EDGE_METERS,
    minTripsPerRoute: input.minTripsPerRoute,
    rtFeedUrls: input.rtFeedUrls,
    maxCompressedTileBytes: cap,
    maxSubdivisionDepth: maxDepth,
    subdivisionAlgoVersion: SUBDIVISION_ALGO_VERSION,
  });

  const buildResult = await buildBundle({
    canonical: input.canonical,
    bundleHash,
    cityId: input.cityId,
    dataDir: input.dataDir,
    cap,
    maxDepth,
    resolveRouteColor: input.resolveRouteColor,
    resolveRouteSubMode: input.resolveRouteSubMode,
  });

  writeBundleManifest({
    dataDir: input.dataDir,
    bundleHash,
    generatedAt,
    tileSize: SCHEDULE_TILE_EDGE_METERS,
    subdivisions: buildResult.subdivisions,
  });

  const janitor = sweepBundleJanitor({
    dataDir: input.dataDir,
    keepCount: keepBundleCount,
  });

  return {
    bundleHash: buildResult.bundleHash,
    tilesWritten: buildResult.tilesWritten,
    janitor,
    subdivisions: buildResult.subdivisions,
    stats: buildResult.stats,
  };
}
