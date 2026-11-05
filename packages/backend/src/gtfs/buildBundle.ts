import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  encodeScheduleTile,
  SCHEDULE_TILE_SIZE_LABEL,
  SCHEDULE_TILE_EDGE_METERS,
  MAX_SUBDIVISION_DEPTH,
  type SubdivisionPlan,
} from "@pt/shared";
import type { CanonicalStore } from "./canonical/CanonicalStore.js";
import { groupStopsByCell } from "./groupStopsByCell.js";
import { buildTileForCell } from "./buildTileForCell.js";
import { compressTileBytes, MAX_COMPRESSED_TILE_BYTES } from "./scheduleTileBrotli.js";
import { subdivideCell, type Leaf } from "./subdivideCell.js";
import type { RouteResolvers } from "./routeResolvers.js";

export interface BuildBundleInput extends RouteResolvers {
  canonical: CanonicalStore;
  bundleHash: string;
  cityId: string;
  dataDir: string;
  /** Per-leaf compressed-byte ceiling. Defaults to the production cap; tests inject a tiny cap. */
  cap?: number;
  /** Max quadtree depth. Defaults to MAX_SUBDIVISION_DEPTH; tests may lower it. */
  maxDepth?: number;
}

export interface BuildBundleSubdivisionStats {
  subdividedCells: number;
  maxDepth: number;
  oversizedLeaves: number;
  maxLeafBytes: number;
  /**
   * Total number of TOP-LEVEL 6 km cells in this build (= `cells.size`), NOT the
   * leaf count. The scheduler's soft-ceiling check reads this directly instead of
   * reconstructing it arithmetically from `tilesWritten` and the plan.
   */
  cellCount: number;
}

export interface BuildBundleResult {
  bundleHash: string;
  tilesWritten: number;
  /** Per-cell subdivision plans, keyed by `<x>_<y>`. Absent key ⇒ unsplit. */
  subdivisions: Record<string, SubdivisionPlan>;
  stats: BuildBundleSubdivisionStats;
  /**
   * Per-stop assignment to the EXACT on-disk `.br` filename (sans extension)
   * its departures were written to: bare `${x}_${y}` for an unsubdivided or
   * irreducible-oversized cell, `${x}_${y}-${suffix}` for a subdivided one.
   *
   * This single-sources the stop→tile bucketing the producer-mode departures
   * read path (`producerDepartures.ts`) would otherwise re-derive via
   * `leafForPoint`. It is taken straight from the assignment this build already
   * computed — `cellStops` per `cellKey` for the bare cases, and
   * `subdivideCell`'s `Leaf.stops` per leaf suffix for the subdivided case —
   * NOT re-derived. A stop `subdivideCell` could not place in any leaf
   * (null-leaf) is simply never set → omitted (the consumer returns
   * `unavailable` for it, matching the legacy `leafForPoint === null` path).
   */
  stopTileCoords: Map<string, string>;
}

/**
 * Build a complete schedule-tile bundle and write it atomically.
 *
 *   1. Group stops by cell.
 *   2. For each cell, build the decoded tile, JSON-encode, brotli-compress.
 *   3. Write bytes to `<dataDir>/<bundleHash>.tmp/<SCHEDULE_TILE_SIZE_LABEL>/<x_y>.br`.
 *   4. Two-phase swap: rename existing final → .old; rename tmp → final;
 *      remove .old. There is a brief window between the two renames where
 *      `finalDir` does not exist — POSIX rename(2) is atomic for replacing a
 *      single path, but cannot atomically swap one non-empty directory with
 *      another. PR 3's serving layer must handle ENOENT during this window
 *      with retry or 503 (Service Unavailable); the manifest re-fetch flow
 *      planned for PR 3 is expected to cover the recovery.
 *   5. On any error: remove the tmp directory and re-throw. The final
 *      directory is never created in the failure path. (If the crash falls
 *      between the two renames, `<finalDir>.old` survives as an orphan; it
 *      is cleaned up on the next build's pre-flight.)
 *
 * Per-bundle metadata is NOT written here. The orchestrator
 * (`buildAndPublishBundle`) writes the canonical, typed `manifest.json`
 * at the dataDir root after this function returns. The bundle directory
 * itself only carries the compressed `.br` tile files — bundleHash is
 * implicit in the directory name.
 *
 * Idempotent: repeated calls with the same `bundleHash` replace the dir
 * with identical bytes (assuming canonical inputs have not changed).
 *
 * INVARIANT: at most one `buildBundle` executes per `dataDir` at a time
 * (guaranteed by the scheduler's synchronous re-entrancy guard in
 * `schedulePublishBundle`). `buildBundle` itself is NOT internally
 * re-entrancy-safe — concurrent calls for the same `dataDir` would race the
 * tmp/old/final dirs — and does not need to be.
 */
export async function buildBundle(input: BuildBundleInput): Promise<BuildBundleResult> {
  const { canonical, bundleHash, cityId, dataDir } = input;
  const finalDir = join(dataDir, bundleHash);
  const tmpDir = `${finalDir}.tmp`;
  const tileSubDir = join(tmpDir, SCHEDULE_TILE_SIZE_LABEL);

  // force:true swallows ENOENT — no existsSync producer-then-act (which widens
  // TOCTOU under async).
  await fs.rm(tmpDir, { recursive: true, force: true });

  try {
    await fs.mkdir(tileSubDir, { recursive: true });

    const cells = groupStopsByCell(canonical);
    let tilesWritten = 0;
    const cap = input.cap ?? MAX_COMPRESSED_TILE_BYTES;
    const maxDepth = input.maxDepth ?? MAX_SUBDIVISION_DEPTH;
    const yieldFn = () => new Promise<void>((resolve) => setImmediate(resolve));
    const subdivisions: Record<string, SubdivisionPlan> = {};
    // Per-stop → on-disk tile filename (sans `.br`). Recorded at the SAME point
    // each `.br` file is named, single-sourcing the bucketing the read side
    // would otherwise re-derive. See BuildBundleResult.stopTileCoords.
    const stopTileCoords = new Map<string, string>();
    const stats: BuildBundleSubdivisionStats = {
      subdividedCells: 0, maxDepth: 0, oversizedLeaves: 0, maxLeafBytes: 0, cellCount: cells.size,
    };

    for (const [cellKey, cellStops] of cells) {
      try {
        const tile = buildTileForCell({
          canonical,
          cellStops,
          bundleHash,
          cityId,
          tileSize: SCHEDULE_TILE_EDGE_METERS,
          resolveRouteColor: input.resolveRouteColor,
          resolveRouteSubMode: input.resolveRouteSubMode,
        });
        const json = encodeScheduleTile(tile);
        // Compress the WHOLE cell ONCE with no throwing ceiling, then branch on
        // size. This is the single q=11 the densest cell pays at the top level —
        // when it is over-cap we hand these exact bytes to subdivideCell as the
        // root so it is NOT recompressed (the double-compress fix). record:true
        // (default) keeps this in the per-6 km-cell pressure histogram.
        const compressed = compressTileBytes(json, Number.POSITIVE_INFINITY);
        if (compressed.byteLength <= cap) {
          await fs.writeFile(join(tileSubDir, `${cellKey}.br`), compressed);
          // Unsubdivided cell: every stop in it lives in the bare `${cellKey}.br`.
          for (const s of cellStops) stopTileCoords.set(s.id, cellKey);
          tilesWritten++;
          if (compressed.byteLength > stats.maxLeafBytes) stats.maxLeafBytes = compressed.byteLength;
          // Yield between tiles so the event loop drains pending requests between
          // the synchronous ~1 s brotli blocks.
          await yieldFn();
          continue;
        }
        // Over-cap: subdivide best-effort instead of aborting the whole city.
        const [x, y] = cellKey.split("_").map(Number);
        const leaves: Leaf[] = await subdivideCell(
          {
            canonical, cellStops, bundleHash, cityId, cellX: x!, cellY: y!,
            resolveRouteColor: input.resolveRouteColor,
            resolveRouteSubMode: input.resolveRouteSubMode,
            // Reuse the root compress above — do not recompress the whole cell.
            precompressedRoot: {
              json, bytes: compressed, compressedBytes: compressed.byteLength, uncompressed: json.byteLength,
            },
          },
          { cap, maxDepth, yieldFn },
        );
        // A lone empty-suffix leaf means the cell was over-cap but could not be
        // subdivided at all (e.g. a single stop whose own departures exceed the
        // cap). It is one irreducible oversized tile, NOT a subdivision: write it
        // under the normal bare `<cell>.br` name (which the read-side leaf regex
        // matches — `<cell>-.br` would not) and record NO subdivisions entry, but
        // still count it oversized so the degradation gauge/alarm fires.
        if (leaves.length === 1 && leaves[0]!.suffix === "") {
          const only = leaves[0]!;
          await fs.writeFile(join(tileSubDir, `${cellKey}.br`), only.bytes);
          // Irreducible-oversized cell: written under the bare `${cellKey}.br`
          // (NOT `${cellKey}-.br`), so its stops map to the bare cellKey.
          for (const s of cellStops) stopTileCoords.set(s.id, cellKey);
          tilesWritten++;
          if (only.oversized) stats.oversizedLeaves++;
          if (only.compressedBytes > stats.maxLeafBytes) stats.maxLeafBytes = only.compressedBytes;
          await yieldFn();
          continue;
        }
        // Bijection: every recorded leaf must be written; assert below the loop.
        subdivisions[cellKey] = {
          leaves: leaves.map((l) => ({
            suffix: l.suffix, bbox: l.bbox, compressedBytes: l.compressedBytes, oversized: l.oversized,
          })),
        };
        stats.subdividedCells++;
        for (const leaf of leaves) {
          const leafCoords = `${cellKey}-${leaf.suffix}`;
          await fs.writeFile(join(tileSubDir, `${leafCoords}.br`), leaf.bytes);
          // Subdivided cell: each leaf's `stops` (the exact set subdivideCell
          // assigned to this suffix) maps to the leaf's on-disk coord — the
          // single-source for the read side, NOT re-derived via leafForPoint.
          for (const s of leaf.stops) stopTileCoords.set(s.id, leafCoords);
          tilesWritten++;
          const depth = leaf.suffix === "" ? 0 : leaf.suffix.split("-").length;
          if (depth > stats.maxDepth) stats.maxDepth = depth;
          if (leaf.oversized) stats.oversizedLeaves++;
          if (leaf.compressedBytes > stats.maxLeafBytes) stats.maxLeafBytes = leaf.compressedBytes;
          await yieldFn();
        }
      } catch (err) {
        // Enrich the per-cell error with cellKey + bundle context. The outer
        // catch handles tmpDir cleanup; re-throwing the wrapped error means
        // operators see "which cell exceeded the cap" without re-running the
        // build with extra instrumentation.
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `buildBundle: failed building tile for cell "${cellKey}" ` +
            `(bundleHash=${bundleHash}, cityId=${cityId}): ${msg}`,
          { cause: err },
        );
      }
    }

    // Bijection guard: every planned leaf file exists on disk before the swap.
    for (const [cellKey, plan] of Object.entries(subdivisions)) {
      for (const leaf of plan.leaves) {
        const p = join(tileSubDir, `${cellKey}-${leaf.suffix}.br`);
        if (!existsSync(p)) {
          throw new Error(
            `buildBundle: subdivision plan/disk mismatch — planned leaf ${cellKey}-${leaf.suffix}.br ` +
              `was not written (bundleHash=${bundleHash}, cityId=${cityId})`,
          );
        }
      }
    }

    // Two-phase swap. The naive `rm(finalDir); rename(tmpDir, finalDir)`
    // leaves the bundle dir absent during the rm→rename window — concurrent
    // schedule-tile/RT-tile readers see ENOENT and would have to emit 503
    // Service Unavailable until the next read attempt succeeds.
    //
    // Error-tolerant, producer-free (no existsSync — TOCTOU-free under async):
    // force:true swallows ENOENT on rm; rename(finalDir, oldDir) is guarded
    // for the first-build "no finalDir yet" case; the two renames stay
    // back-to-back so the "no finalDir" window stays minimal.
    const oldDir = `${finalDir}.old`;
    await fs.rm(oldDir, { recursive: true, force: true });
    await fs.rename(finalDir, oldDir).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
    await fs.rename(tmpDir, finalDir);
    await fs.rm(oldDir, { recursive: true, force: true });

    return { bundleHash, tilesWritten, subdivisions, stats, stopTileCoords };
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    throw err;
  }
}
