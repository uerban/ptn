import {
  encodeScheduleTile,
  scheduleCellBounds,
  bisectQuadrant,
  quadrantDigitForPoint,
  type Bbox,
} from "@pt/shared";
import type { CanonicalStore } from "./canonical/CanonicalStore.js";
import type { GtfsStop } from "./parser.js";
import { buildTileForCell } from "./buildTileForCell.js";
import { compressTileBytes } from "./scheduleTileBrotli.js";
import type { RouteResolvers } from "./routeResolvers.js";

export interface SubdivideCellArgs extends RouteResolvers {
  canonical: CanonicalStore;
  /** Stops in the parent 6 km cell, in `groupStopsByCell` order. */
  cellStops: GtfsStop[];
  bundleHash: string;
  cityId: string;
  /** Parent cell coords on the 6 km grid. */
  cellX: number;
  cellY: number;
  /**
   * The ROOT (whole-cell) tile `buildBundle` already encoded + q=11-compressed.
   * When provided, the depth-0 node REUSES these bytes instead of recompressing
   * the densest payload in the city a second time (the double-compress fix). The
   * `compressedBytes` must be the q=11 byte length `buildBundle` measured; `json`
   * is the `encodeScheduleTile` output (kept for parity with `compressNode`'s
   * shape, though the root never re-encodes). Absent ⇒ tests drive the root
   * compress themselves (the `compressNode` path at depth 0).
   */
  precompressedRoot?: {
    json: Uint8Array;
    bytes: Uint8Array;
    compressedBytes: number;
    uncompressed: number;
  };
}

export interface SubdivideCellOptions {
  /** Compressed-byte ceiling per leaf (injectable; production passes the prod cap). */
  cap: number;
  /** Max quadtree depth (injectable; production passes MAX_SUBDIVISION_DEPTH). */
  maxDepth: number;
  /** Awaited between every compress so the event loop drains (Part 2a). */
  yieldFn: () => Promise<void>;
}

/**
 * One subdivision leaf. `bytes` is the final q=11 compressed tile; `oversized`
 * means the leaf could not be brought under `cap` (irreducible mega-station or
 * a guard fired). `stops` preserves the parent's `groupStopsByCell` order via
 * FILTER (never re-sorted) so the wire bytes are deterministic.
 */
export interface Leaf {
  /** Quadtree-path suffix, e.g. "" (root), "2", "0-3". */
  suffix: string;
  bbox: Bbox;
  stops: GtfsStop[];
  bytes: Uint8Array;
  compressedBytes: number;
  oversized: boolean;
}

/**
 * Encode + q=11-compress one node's tile ONCE. `record: false` keeps the subdivision's per-node
 * compresses OUT of the `pt_compressed_tile_bytes` per-6 km-cell pressure histogram — that
 * histogram is meant to track whole-cell build pressure, captured by buildBundle's first
 * compress, not the deep quadtree's sub-cell sizes. The over-cap ROOT is NOT compressed here at
 * all: buildBundle already compressed the whole cell and hands those bytes in via
 * `precompressedRoot`, so the densest payload in the city is never compressed twice. Deeper
 * nodes each compress exactly once via this function.
 */
function compressNode(args: SubdivideCellArgs, stops: GtfsStop[]): { bytes: Uint8Array; compressedBytes: number; uncompressed: number } {
  const tile = buildTileForCell({
    canonical: args.canonical,
    cellStops: stops,
    bundleHash: args.bundleHash,
    cityId: args.cityId,
    // Leaves keep the top-level grid edge — the sub-edge lives only in the manifest bbox.
    tileSize: 6000,
    resolveRouteColor: args.resolveRouteColor,
    resolveRouteSubMode: args.resolveRouteSubMode,
  });
  const json = encodeScheduleTile(tile);
  // A very large cap so the compressor never throws inside subdivision — the
  // caller (recurse) decides over-cap from `compressedBytes` vs `opts.cap`.
  // record:false — keep these out of the per-cell pressure histogram.
  const bytes = compressTileBytes(json, Number.POSITIVE_INFINITY, false);
  return { bytes, compressedBytes: bytes.byteLength, uncompressed: json.byteLength };
}

/**
 * Subdivide one over-cap 6 km cell into a deterministic quadtree of leaves,
 * best-effort: never throws on size; an irreducible node is emitted as an
 * oversized leaf. Async — yields between every compress so it preserves Part
 * 2a's non-blocking guarantee on the densest city cell.
 *
 * Termination guard (recurse only when ALL hold; else emit the node as a leaf):
 *   1. node is over-cap, AND
 *   2. depth < maxDepth, AND
 *   3. node has > 1 stop, AND
 *   4. the split makes progress (stops do NOT all fall in one child quadrant).
 *
 * Fixed pre-order 0→3 emission; empty quadrants dropped (no leaf); stop order
 * preserved by FILTER. Each node compresses AT MOST ONCE: the over-cap root is
 * compressed once in buildBundle and reused here (via `precompressedRoot`, NOT
 * recompressed); each descended node compresses once at its own level. The cheap
 * `uncompressed <= cap` short-circuit (brotli only shrinks) lets a node emit
 * without a fresh compress when it obviously fits.
 */
export async function subdivideCell(
  args: SubdivideCellArgs,
  opts: SubdivideCellOptions,
): Promise<Leaf[]> {
  const cellBounds = scheduleCellBounds(args.cellX, args.cellY);
  const leaves: Leaf[] = [];

  // Compress a node ONCE. At depth 0, reuse buildBundle's already-compressed root
  // bytes (`precompressedRoot`) instead of recompressing the densest cell in the
  // city; deeper nodes compress via `compressNode` (record:false). The yield keeps
  // the Part 2a non-blocking guarantee around every real compress.
  async function compressFor(depth: number, stops: GtfsStop[]): Promise<{ bytes: Uint8Array; compressedBytes: number; uncompressed: number }> {
    if (depth === 0 && args.precompressedRoot) {
      return {
        bytes: args.precompressedRoot.bytes,
        compressedBytes: args.precompressedRoot.compressedBytes,
        uncompressed: args.precompressedRoot.uncompressed,
      };
    }
    await opts.yieldFn();
    return compressNode(args, stops);
  }

  // Recurse on a node = (its stops, its bbox, its accumulated suffix digits).
  async function recurse(stops: GtfsStop[], bbox: Bbox, digits: number[]): Promise<void> {
    const depth = digits.length;
    const suffix = digits.join("-");

    // Partition stops into the four child quadrants. FILTER preserves parent
    // order; empty quadrants are dropped in the descent loop below.
    const quadrants: GtfsStop[][] = [[], [], [], []];
    for (const s of stops) quadrants[quadrantDigitForPoint(bbox, s.lat, s.lon)]!.push(s);
    // Recurse whenever there is more than one stop and depth budget remains. A
    // localized cluster whose stops all land in ONE first-level quadrant is NOT
    // irreducible: descending halves the bbox, so it separates at a deeper level.
    // `maxDepth` is the real termination backstop — truly coincident stops recurse
    // to maxDepth and are emitted oversized there (bounded, never infinite). A
    // prior `occupied > 1` guard was too strong: it wrote a dense one-corner
    // district as a single oversized leaf when a deeper split would have split it.
    const canSplit = depth < opts.maxDepth && stops.length > 1;

    if (canSplit) {
      // Compress this node ONCE to decide fit-vs-split (root reuses buildBundle's
      // bytes). brotli q=11 only ever SHRINKS, so `uncompressed <= cap` is a cheap
      // certain-fit short-circuit; otherwise the compressed length decides.
      const node = await compressFor(depth, stops);
      if (node.uncompressed <= opts.cap || node.compressedBytes <= opts.cap) {
        // Fits under cap ⇒ emit as a leaf, no split.
        leaves.push({ suffix, bbox, stops, bytes: node.bytes, compressedBytes: node.compressedBytes, oversized: false });
        return;
      }
      // Over-cap and splittable — descend pre-order 0→3, dropping empty quadrants.
      for (let digit = 0; digit <= 3; digit++) {
        const q = digit as 0 | 1 | 2 | 3;
        const childStops = quadrants[q];
        if (childStops.length === 0) continue; // drop empty quadrant
        await recurse(childStops, bisectQuadrant(bbox, q), [...digits, q]);
      }
      return;
    }

    // Cannot split further (max depth reached, or a single stop) — emit as a
    // leaf (oversized iff still over cap). The under-cap fit case returns above.
    const { bytes, compressedBytes } = await compressFor(depth, stops);
    leaves.push({
      suffix, bbox, stops, bytes, compressedBytes,
      oversized: compressedBytes > opts.cap,
    });
  }

  await recurse(args.cellStops, cellBounds, []);
  return leaves;
}
