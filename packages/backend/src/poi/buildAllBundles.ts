#!/usr/bin/env tsx
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { refreshSnapshot, type SourceSnapshot } from "./sourceSnapshot.js";
import { loadTagSpec } from "./osmTags.js";
import {
  extractTargetsFromPbf,
  type CategorizedOsmFeature,
} from "./osmiumExtract.js";
import {
  CITY_PROFILES,
  citiesForPbf,
  type CityProfile,
} from "./cityProfiles.js";
import {
  buildCityBundle,
  loadLandmarks,
  writeBundleFile,
  assertTilesMeetK,
  TileKAnonymityViolation,
} from "./buildBundle.js";
import { buildCityTiles, type TileResult } from "./buildTiles.js";
import { writeManifest, type BundleEntry, type PoiTileManifest } from "./manifest.js";
import { resolveTilingPolicy, type PolicyEnv } from "./tilingPolicy.js";
import { derivePoiTileEdge } from "./derivePoiTileEdge.js";
import { resolvePoiTileDeliveryActive } from "./activation.js";
import {
  TILE_MIN_K,
  tilesForViewport,
  type LandmarkEntry,
  type LandmarkCityId,
  type PoiEntry,
  type PoiTileBounds,
  type Tier,
} from "@pt/shared";

export interface SubKSkip {
  cityId: string;
  tier: "strict" | "loose";
  totalCount: number;
  bbox: CityProfile["bbox"];
  dropped: Array<{
    id: string;
    name: string;
    category: string;
    source: string;
    wikidataId?: string;
  }>;
  curatedCount: number;
  wikidataCount: number;
}
export interface CityTiling {
  poiTile?: PoiTileManifest;
  skip?: SubKSkip;
}

function servingTileBounds(
  profile: CityProfile,
  edgeKm: number,
  anchor: PoiTileManifest["anchor"],
): PoiTileBounds {
  const bounds: PoiTileBounds = {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
  for (const key of tilesForViewport(profile.cityId, profile.bbox, edgeKm, anchor)) {
    const coords = key.split("/").at(-1);
    const match = coords ? /^(-?\d+)_(-?\d+)$/.exec(coords) : null;
    if (!match) {
      throw new Error(`invalid generated POI tile key for ${profile.cityId}: ${key}`);
    }
    const x = Number(match[1]);
    const y = Number(match[2]);
    bounds.minX = Math.min(bounds.minX, x);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxY = Math.max(bounds.maxY, y);
  }
  if (!Number.isFinite(bounds.minX)) {
    throw new Error(`empty POI serving grid for ${profile.cityId}`);
  }
  return bounds;
}

/**
 * Resolve policy + derive the edge for one city's strict entries. On a < k-total city under
 * k-anon-floor (the plain Error from derivePoiTileEdge), returns a structured skip record
 * (warn-and-skip). When `deliveryActive` is true and the city is NOT explicitly waived, the
 * per-tile floor is enforced and a TileKAnonymityViolation is RETHROWN (fails the build).
 */
export function deriveCityTiling(
  profile: CityProfile,
  entries: PoiEntry[],
  env: PolicyEnv,
  deliveryActive: boolean,
): CityTiling {
  const resolved = resolveTilingPolicy(profile, env); // hard-errors on unwaived non-default policy
  try {
    const d = derivePoiTileEdge(entries, resolved.policy, profile.bbox, resolved.config);
    // Gate on the per-CITY intent flag, NOT the derived edge's kAnonWaived (derivePoiTileEdge
    // hardcodes kAnonWaived:true for byte-budget/fixed-edge, which would make a `!d.kAnonWaived`
    // clause a no-op).
    if (
      resolved.policy === "k-anon-floor" ||
      (deliveryActive && profile.kAnonWaived !== true)
    ) {
      assertTilesMeetK(profile.cityId, entries, d.edgeKm, d.anchor);
    }
    return {
      poiTile: {
        edgeKm: d.edgeKm,
        anchor: d.anchor,
        tileBounds: servingTileBounds(profile, d.edgeKm, d.anchor),
        tilingPolicy: resolved.policy,
        kAnonWaived: d.kAnonWaived,
        deliveryActive,
      },
    };
  } catch (err) {
    // distinguish failure classes by TYPE, not message. A per-tile floor breach
    // (TileKAnonymityViolation) ALWAYS rethrows (fails the build). Only the sub-k-TOTAL case (the
    // plain Error derivePoiTileEdge throws — "cannot satisfy the floor … even as one tile") stays
    // warn-and-skip.
    if (err instanceof TileKAnonymityViolation) throw err;
    if (err instanceof Error && /< ?k|below k|cannot satisfy/i.test(err.message)) {
      const skip: SubKSkip = {
        cityId: profile.cityId,
        tier: "strict",
        totalCount: entries.length,
        bbox: profile.bbox,
        dropped: entries.map((e) => ({
          id: e.id,
          name: e.name,
          category: e.category,
          source: e.source,
          ...(e.wikidataId ? { wikidataId: e.wikidataId } : {}),
        })),
        curatedCount: entries.filter((e) => e.source === "curated").length,
        wikidataCount: entries.filter((e) => e.wikidataId).length,
      };
      console.warn(
        `[poi] ${profile.cityId}: ${entries.length} POIs < k=${TILE_MIN_K} — warn-and-skip; city omitted. ${skip.curatedCount} curated / ${skip.wikidataCount} Wikidata affected.`,
      );
      return { skip };
    }
    throw err;
  }
}

export const SIZE_LIMITS = {
  strict: 500 * 1024,
  loose: 2 * 1024 * 1024,
} as const;

export interface BundleResult {
  cityId: string;
  tier: Tier;
  entryCount: number;
  compressedSize: number;
  outputPath: string;
}

export interface SizeViolation {
  cityId: string;
  tier: Tier;
  actual: number;
  limit: number;
}

export function checkSizeLimits(results: BundleResult[]): SizeViolation[] {
  const violations: SizeViolation[] = [];
  for (const r of results) {
    const limit = SIZE_LIMITS[r.tier];
    if (r.compressedSize > limit) {
      violations.push({
        cityId: r.cityId,
        tier: r.tier,
        actual: r.compressedSize,
        limit,
      });
    }
  }
  return violations;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} kB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

export interface DownloadResult {
  path: string;
  lastModified: string | null;
}

export async function downloadPbf(
  url: string,
  cacheDir: string,
): Promise<DownloadResult> {
  const snapshot = await refreshSnapshot(url, cacheDir);
  return { path: snapshot.path, lastModified: snapshot.snapshotAt };
}

export function selectPoiCities(value?: string): LandmarkCityId[] | undefined {
  if (value === undefined) return undefined;
  const cities = value.split(",").map((city) => city.trim());
  if (cities.some((city) => !Object.hasOwn(CITY_PROFILES, city))) {
    throw new Error("POI_CITIES must contain known corpus IDs");
  }
  return [...new Set(cities)] as LandmarkCityId[];
}

export interface BuildAllOptions {
  /** Corpus IDs, not deployment cities: tricity expands to gdansk/gdynia/sopot. */
  cityIds?: LandmarkCityId[];
  /** A builder freezes each regional snapshot once, shared with all components. */
  sourceSnapshots?: Readonly<Record<string, SourceSnapshot>>;
  outputDir: string;
  pbfCacheDir: string;
  /** Hand-curated landmark files. Unset in production: OpenStreetMap is the
   *  source of truth, and the curated coordinates drifted (Vilnius "Panorama"
   *  sat 3.5 km from the mall and was listed twice). Tests still use them as a
   *  PBF-free corpus. */
  landmarksDir?: string;
  skipDownload?: boolean;
  skipKAnonymityValidation?: boolean;
  emitTiles?: boolean;
}

export interface BuildAllResult {
  bundles: BundleResult[];
  tiles: TileResult[];
}

export async function buildAllBundles(
  opts: BuildAllOptions,
): Promise<BundleResult[]> {
  const { bundles } = await buildAll(opts);
  return bundles;
}

export async function buildAll(
  opts: BuildAllOptions,
): Promise<BuildAllResult> {
  const tagSpec = loadTagSpec();
  const results: BundleResult[] = [];
  const tileResults: TileResult[] = [];
  const manifestEntries: BundleEntry[] = [];
  const skips: SubKSkip[] = [];

  const landmarksByCity = new Map<LandmarkCityId, LandmarkEntry[]>();
  const cityIds = opts.cityIds ?? Object.keys(CITY_PROFILES) as LandmarkCityId[];
  if (cityIds.length === 0 || cityIds.some((id) => !Object.hasOwn(CITY_PROFILES, id))) {
    throw new Error("select at least one known POI corpus");
  }
  const selected = new Set(cityIds);
  for (const cityId of cityIds) {
    if (!opts.landmarksDir) {
      landmarksByCity.set(cityId, []);
      continue;
    }
    const filePath = join(opts.landmarksDir, `${cityId}.json`);
    if (existsSync(filePath)) {
      landmarksByCity.set(cityId, await loadLandmarks(filePath, cityId));
    } else {
      console.warn(`  Warning: no landmark file for ${cityId} at ${filePath}`);
      landmarksByCity.set(cityId, []);
    }
  }

  await mkdir(opts.outputDir, { recursive: true });

  const pbfUrls = [...new Set(cityIds.map((id) => CITY_PROFILES[id].sourcePbf))];
  for (const pbfUrl of pbfUrls) {
    let pbfPath: string | undefined;
    let pbfTimestamp: string | undefined;
    if (opts.sourceSnapshots) {
      const snapshot = opts.sourceSnapshots[pbfUrl];
      if (!snapshot || snapshot.url !== pbfUrl) throw new Error(`missing frozen source ${pbfUrl}`);
      pbfPath = snapshot.path;
      pbfTimestamp = snapshot.snapshotAt;
    } else if (!opts.skipDownload) {
      const result = await downloadPbf(pbfUrl, opts.pbfCacheDir);
      pbfPath = result.path;
      pbfTimestamp = result.lastModified ?? undefined;
    }

    const cities = citiesForPbf(pbfUrl).filter((profile) => selected.has(profile.cityId));
    const tiersFor = (profile: (typeof cities)[number]): Tier[] =>
      profile.looseTier ? ["strict", "loose"] : ["strict"];

    // One osmium pass per source file feeds every city and tier cut from it.
    let osmByTarget: Map<string, CategorizedOsmFeature[]> | undefined;
    if (pbfPath) {
      console.log(`  Reading ${basename(pbfPath)}...`);
      osmByTarget = await extractTargetsFromPbf(
        pbfPath,
        tagSpec,
        cities.flatMap((profile) =>
          tiersFor(profile).map((tier) => ({
            key: `${profile.cityId}/${tier}`,
            bbox: profile.bbox,
            tier,
          })),
        ),
      );
    }

    for (const profile of cities) {
      for (const tier of tiersFor(profile)) {
        const suffix = tier === "loose" ? ".loose" : "";
        const outputPath = join(opts.outputDir, `${profile.cityId}${suffix}.br`);
        console.log(`  Building ${profile.cityId} (${tier})...`);

        const buildOpts = {
          tagSpec,
          tier,
          landmarkEntries: landmarksByCity.get(profile.cityId) ?? [],
          ...(osmByTarget
            ? { osmFeatures: osmByTarget.get(`${profile.cityId}/${tier}`) ?? [] }
            : {}),
          ...(pbfTimestamp ? { sourcePbfTimestamp: pbfTimestamp } : {}),
          ...(opts.skipKAnonymityValidation
            ? { skipKAnonymityValidation: true }
            : {}),
        };
        let built: Awaited<ReturnType<typeof buildCityBundle>>;
        try {
          built = await buildCityBundle(profile.cityId, buildOpts);
        } catch (err) {
          // A strict tier with fewer than k POIs in total (Sopot without the
          // curated landmarks) goes to the warn-and-skip path below, like any
          // other sub-k city, instead of failing every city's build.
          if (
            !(err instanceof TileKAnonymityViolation) ||
            tier !== "strict" ||
            resolveTilingPolicy(profile, process.env as PolicyEnv).policy !== "k-anon-floor"
          ) {
            throw err;
          }
          built = await buildCityBundle(profile.cityId, { ...buildOpts, skipKAnonymityValidation: true });
        }
        const { bundle, compressed } = built;

        // Derive per-city tiling ONCE on the strict tier. A < k-total city under
        // k-anon-floor is warn-and-skipped: its strict bundle, tiles, and manifest
        // entry are all omitted. Loose tier is untouched (Phase-0 behaviour).
        let cityPoiTile: PoiTileManifest | undefined;
        if (tier === "strict") {
          const deliveryActive = resolvePoiTileDeliveryActive(
            profile,
            process.env as PolicyEnv & { POI_TILE_DELIVERY_ACTIVE?: string },
          );
          const tiling = deriveCityTiling(
            profile,
            bundle.entries,
            process.env as PolicyEnv,
            deliveryActive,
          );
          if (tiling.skip) {
            skips.push(tiling.skip);
            continue;
          }
          cityPoiTile = tiling.poiTile;
        }

        await writeBundleFile(outputPath, compressed);

        manifestEntries.push({
          cityId: profile.cityId,
          filename: basename(outputPath),
          // Use the in-memory length we already have rather than a sync
          // disk stat — same value, no syscall, no `node:fs` sync call
          // mid-async-loop.
          sizeBytes: compressed.length,
          ...(cityPoiTile ? { poiTile: cityPoiTile } : {}),
        });

        const result: BundleResult = {
          cityId: profile.cityId,
          tier,
          entryCount: bundle.meta.entryCount,
          compressedSize: compressed.length,
          outputPath,
        };
        results.push(result);
        console.log(
          `    ${result.entryCount} entries, ${formatSize(result.compressedSize)}`,
        );

        if (opts.emitTiles && tier === "strict" && cityPoiTile) {
          const tiles = await buildCityTiles({
            outputDir: opts.outputDir,
            cityId: profile.cityId,
            entries: bundle.entries,
            edgeKm: cityPoiTile.edgeKm,
            anchor: cityPoiTile.anchor,
          });
          tileResults.push(...tiles);
          const totalTileBytes = tiles.reduce(
            (sum, t) => sum + t.compressedSize,
            0,
          );
          console.log(
            `    ${tiles.length} tile(s), ${formatSize(totalTileBytes)}`,
          );
        }
      }
    }
  }

  if (skips.length) {
    await writeFile(
      join(opts.outputDir, "poi-sub-k-skips.json"),
      JSON.stringify(skips, null, 2),
    );
    console.warn(
      `[poi] ${skips.length} city/cities warn-and-skipped (< k); see poi-sub-k-skips.json`,
    );
  }

  writeManifest(opts.outputDir, manifestEntries);

  return { bundles: results, tiles: tileResults };
}

function printSummary(
  results: BundleResult[],
  violations: SizeViolation[],
  tiles: TileResult[] = [],
): void {
  console.log("\n--- POI Bundle Summary ---");
  for (const r of results) {
    const flag = violations.some(
      (v) => v.cityId === r.cityId && v.tier === r.tier,
    )
      ? " OVER LIMIT"
      : "";
    console.log(
      `  ${r.cityId} (${r.tier}): ${r.entryCount} entries, ${formatSize(r.compressedSize)}${flag}`,
    );
  }
  if (violations.length > 0) {
    console.error("\nSize limit violations:");
    for (const v of violations) {
      console.error(
        `  ${v.cityId} (${v.tier}): ${formatSize(v.actual)} > ${formatSize(v.limit)}`,
      );
    }
  }
  if (tiles.length > 0) {
    console.log("\n--- POI Tile Summary ---");
    const byCity = new Map<string, { count: number; size: number }>();
    for (const t of tiles) {
      const agg = byCity.get(t.cityId) ?? { count: 0, size: 0 };
      agg.count += 1;
      agg.size += t.compressedSize;
      byCity.set(t.cityId, agg);
    }
    for (const [cityId, agg] of byCity) {
      console.log(
        `  ${cityId}: ${agg.count} tile(s), ${formatSize(agg.size)}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const rootDir = resolve(import.meta.dirname, "../../../..");
  const outputDir =
    process.env.POI_OUTPUT_DIR ??
    join(rootDir, "packages/frontend/public/poi");
  const pbfCacheDir =
    process.env.POI_PBF_CACHE_DIR ?? join(rootDir, ".poi-pbf-cache");
  // Opt-in only: production bundles are built from OpenStreetMap alone.
  const landmarksDir = process.env.POI_LANDMARKS_DIR || undefined;

  console.log("Building POI bundles...");
  console.log(`  Output:    ${outputDir}`);
  console.log(`  PBF cache: ${pbfCacheDir}`);
  console.log(`  Landmarks: ${landmarksDir ?? "none (OpenStreetMap only)"}`);

  const { bundles: results, tiles } = await buildAll({
    outputDir,
    pbfCacheDir,
    landmarksDir,
    emitTiles: true,
    cityIds: selectPoiCities(process.env.POI_CITIES),
  });

  const violations = checkSizeLimits(results);
  printSummary(results, violations, tiles);

  if (violations.length > 0) {
    process.exit(1);
  }

  console.log("\nAll bundles built successfully.");
}

const isDirectRun =
  /(?:^|[/\\])buildAllBundles\.(?:ts|js|mjs)$/.test(process.argv[1] ?? "") &&
  process.argv[1] &&
  resolve(process.argv[1]).replace(/\.(ts|js|mjs)$/, "") ===
    resolve(import.meta.filename).replace(/\.(ts|js|mjs)$/, "");

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
