import { mkdir, writeFile, readFile } from "node:fs/promises";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { join, dirname } from "node:path";
import { tileKeyAt, TILE_EDGE_KM, GLOBAL_ANCHOR, type PoiBundle, type PoiEntry, type TileAnchor } from "@pt/shared";

export interface TileResult {
  cityId: string;
  tileKey: string;
  entryCount: number;
  compressedSize: number;
  outputPath: string;
}

export interface BuildTilesOptions {
  outputDir: string;
  cityId: string;
  entries: PoiEntry[];
  edgeKm?: number;
  anchor?: TileAnchor;
}

export function groupEntriesByTileKey(
  cityId: string,
  entries: PoiEntry[],
  edgeKm: number = TILE_EDGE_KM,
  anchor: TileAnchor = GLOBAL_ANCHOR,
): Map<string, PoiEntry[]> {
  const byTile = new Map<string, PoiEntry[]>();
  for (const entry of entries) {
    const key = tileKeyAt(cityId, entry.lat, entry.lon, edgeKm, anchor);
    let g = byTile.get(key); if (!g) { g = []; byTile.set(key, g); } g.push(entry);
  }
  return byTile;
}

export function tileOutputPath(outputDir: string, tileKey: string): string {
  return join(outputDir, "tiles", `${tileKey}.br`);
}

export function encodeTilePayload(
  tileKey: string,
  entries: PoiEntry[],
): Buffer {
  const json = JSON.stringify({ tileKey, entries });
  return brotliCompressSync(Buffer.from(json), {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
    },
  });
}

export async function buildCityTiles(
  opts: BuildTilesOptions,
): Promise<TileResult[]> {
  const byTile = groupEntriesByTileKey(opts.cityId, opts.entries, opts.edgeKm ?? TILE_EDGE_KM, opts.anchor ?? GLOBAL_ANCHOR);
  const results: TileResult[] = [];
  for (const [tileKey, tileEntries] of byTile) {
    const compressed = encodeTilePayload(tileKey, tileEntries);
    const outputPath = tileOutputPath(opts.outputDir, tileKey);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, compressed);
    results.push({
      cityId: opts.cityId,
      tileKey,
      entryCount: tileEntries.length,
      compressedSize: compressed.length,
      outputPath,
    });
  }
  return results;
}

export async function buildTilesFromBundleFile(
  bundlePath: string,
  outputDir: string,
): Promise<TileResult[]> {
  const compressed = await readFile(bundlePath);
  const json = brotliDecompressSync(compressed).toString("utf-8");
  const bundle = JSON.parse(json) as PoiBundle;
  return buildCityTiles({
    outputDir,
    cityId: bundle.meta.cityId,
    entries: bundle.entries,
  });
}

export function summarizeTileResults(results: TileResult[]): {
  cityId: string;
  tileCount: number;
  totalSize: number;
}[] {
  const byCity = new Map<string, { tileCount: number; totalSize: number }>();
  for (const r of results) {
    const agg = byCity.get(r.cityId) ?? { tileCount: 0, totalSize: 0 };
    agg.tileCount += 1;
    agg.totalSize += r.compressedSize;
    byCity.set(r.cityId, agg);
  }
  return Array.from(byCity, ([cityId, agg]) => ({
    cityId,
    tileCount: agg.tileCount,
    totalSize: agg.totalSize,
  }));
}
