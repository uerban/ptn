/**
 * Tile system parameters.
 *
 * Two independent tile axes share the same coordinate math but use
 * different edge sizes:
 *
 *   - POI tiles (`TILE_EDGE_KM`, 12 km). Sparse landmark corpus
 *     (~300 entries/city). Edge size locked against the real-bundle
 *     sweep in the README notes; keeps
 *     `min_k` well above the privacy floor at this density.
 *   - Schedule + RT tiles (`SCHEDULE_TILE_EDGE_KM`, 6 km). Dense
 *     transit-feed corpus (10³ to 10⁵ stops/city). Smaller edge keeps
 *     per-cell compressed payload under `MAX_COMPRESSED_TILE_BYTES`
 *     across production cities. Pending per-cell subdivision (see
 *     the tiled stop schedules backlog notes), this is the
 *     coarsest size that builds end-to-end.
 *
 * Re-running the M11 sweep is required if either axis materially
 * changes — denser POI tier, or a city whose worst schedule cell still
 * busts the cap at 6 km.
 */

// `as const` on every edge-related numeric pins the literal type so consumers
// can narrow against it (route handlers, manifest writers). The KM and METERS
// pair must stay in sync; the runtime test in `tileParams.test.ts` enforces
// this since the type system can't from two independent literals.
export const TILE_EDGE_KM = 12 as const;
export const TILE_EDGE_METERS = 12_000 as const;

export const SCHEDULE_TILE_EDGE_KM = 6 as const;
export const SCHEDULE_TILE_EDGE_METERS = 6_000 as const;

/**
 * Maximum quadtree subdivision depth for an over-cap schedule-tile cell. 4 ⇒ a
 * minimum sub-cell of ≈375 m at the 6 km grid. A recursion guard (one of four —
 * see `subdivideCell.ts`); injectable in tests. Included in the bundle hash so a
 * change invalidates the on-disk leaf set. Pin after the Paris staging run.
 */
export const MAX_SUBDIVISION_DEPTH = 4 as const;

/**
 * Version tag covering ANY tile-byte-affecting pipeline that the bundle hash does
 * NOT otherwise capture. Bump MANUALLY when a change could shift a cell's
 * compressed size at the cap boundary (and thus which cells/leaves split) without
 * changing the GTFS feed — i.e.:
 *   - the subdivision algorithm itself,
 *   - the build image's Node/brotli toolchain, OR
 *   - the route-color / sub-mode resolver pipeline (whose output IS serialised into
 *     the tile bytes but is NOT a `computeBundleHash` input).
 * Folded into the bundle hash so a bump invalidates every city's bundle once,
 * forcing a clean leaf-set roll. Mirrors `SCHEDULE_TILE_WIRE_VERSION` discipline.
 */
export const SUBDIVISION_ALGO_VERSION = "1" as const;

export const TILE_OVERLAP_RATIO = 0.5;

export const TILE_MIN_K = 50;

export const TILE_CACHE_LRU_N = 5;

export const TILE_CACHE_BUDGET_BYTES = 5_000_000;

/**
 * Default per-tile compressed-byte budget for the `byte-budget` tiling policy (trusted
 * self-host). 64 KB — above the measured ~58 KB loose whole-bundle. Tune against real big-city
 * data (deferred).
 */
export const POI_TILE_MAX_BYTES = 65536 as const;

/**
 * Conservative per-tile UPPER-BOUND byte estimate for the prefetch ADMISSION check
 * (`currentCacheBytes + estTileBytes <= budget`) BEFORE a fetch. The ACTUAL post-decode
 * byteSize drives eviction (estimate-guards-admission, actual-guards-eviction). Placeholder ==
 * the byte-budget cap; a tuned value (set against a real big-city corpus).
 */
export const PREFETCH_EST_TILE_BYTES = POI_TILE_MAX_BYTES;

/** Schedule-tile compressed-byte cache budget = 8 × the per-leaf compressed cap
 *  (MAX_COMPRESSED_TILE_BYTES = 2_097_152 ≈ 2 MiB, scheduleTileBrotli.ts:15).
 *  16_777_216 ≈ 8 × 2 MiB — room for ~8 worst-case leaves' compressed bytes.
 *  Distinct from the POI `TILE_CACHE_BUDGET_BYTES` (5 MB) — schedule leaves are
 *  the densest payload class (R18). Governs COMPRESSED bytes only; decoded tiles
 *  are never retained. */
export const SCHEDULE_TILE_CACHE_BUDGET_BYTES = 16_777_216;
