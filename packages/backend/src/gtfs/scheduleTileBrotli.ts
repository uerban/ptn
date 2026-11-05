import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { metricsRegistry } from "../metrics/registry.js";

/**
 * Build-time per-tile compressed-byte ceiling (2 MiB). The encoder throws
 * rather than silently producing oversized tiles. Combined with
 * `SCHEDULE_TILE_EDGE_KM` in `tileParams.ts`, this caps the schedule-tile
 * data per cell. Cells that exceed the cap need per-cell subdivision
 * (deferred — tracked in the tiled stop schedules backlog notes).
 *
 * TEMP: raised from 1.5 MiB to unblock Paris IDFM (~1.8 MiB worst cell).
 * Headroom is ~11% — one IDFM feed growth bump and we're over again.
 * Revert when per-cell subdivision lands.
 */
export const MAX_COMPRESSED_TILE_BYTES = 2_097_152 as const;

const BROTLI_QUALITY = 11; // max ratio; build is offline so CPU is fine.

/**
 * Brotli-compress a tile's encoded JSON bytes (q=11). SYNCHRONOUS, on the main
 * thread — deliberately. Moving brotli off-thread (libuv pool OR a worker)
 * spread it across extra glibc per-thread malloc arenas that RETAINED the large
 * q=11 working buffers — a ~+70 MB steady-RSS regression on large-tile cities
 * (memory-gate caught it; vilnius's tiny build passed, krakow/tricity blew
 * budget). One thread = one arena = the original footprint. The build avoids
 * monopolising the event loop NOT by going off-thread but by YIELDING BETWEEN
 * TILES — `buildBundle` awaits a `setImmediate` after each tile, so requests see
 * ~1 s latency blips during a build instead of a multi-minute freeze (the
 * "504 storm"). Rejects-via-throw if the output exceeds the cap (the over-cap
 * cell needs per-cell subdivision, Part 2b).
 */
export function compressTileBytes(
  input: Uint8Array,
  cap: number = MAX_COMPRESSED_TILE_BYTES,
  record: boolean = true,
): Uint8Array {
  const compressed = brotliCompressSync(input, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
    },
  });
  // Observe size BEFORE the throw so over-cap cells contribute to the histogram.
  // Otherwise p99 would silently drop the worst offenders and underrepresent
  // build pressure right before the encoder rejects them. `record:false` is
  // passed by subdivideCell so its quadtree trial/leaf compresses do NOT pollute
  // the per-6 km-cell pressure distribution with sub-cell sizes — the per-cell
  // pressure is already captured by buildBundle's first compress of the whole cell.
  if (record) {
    metricsRegistry.compressedTileBytes.observe(compressed.byteLength);
  }

  if (compressed.byteLength > cap) {
    const overPct = Math.round((compressed.byteLength / cap - 1) * 100);
    throw new Error(
      `scheduleTileBrotli: tile exceeds MAX_COMPRESSED_TILE_BYTES ` +
      `(${compressed.byteLength} > ${cap}; ${overPct}% over). ` +
      `Remediation, in order of preference: ` +
      `(1) implement per-cell subdivision; ` +
      `(2) raise the cap if the over-ratio is small (<20%) and re-validate the frontend memory budget; ` +
      `(3) reduce SCHEDULE_TILE_EDGE_KM as a last resort (invalidates every client tile cache globally).`,
    );
  }
  return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
}

/**
 * Brotli-decompress tile bytes. Throws on malformed input. Read path (RT-tile
 * aggregation, round-trip tests).
 */
export function decompressTileBytes(compressed: Uint8Array): Uint8Array {
  const decompressed = brotliDecompressSync(compressed);
  return new Uint8Array(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
}
