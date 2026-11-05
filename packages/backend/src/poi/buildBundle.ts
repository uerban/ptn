import { readFile, writeFile, mkdir } from "node:fs/promises";
import { brotliCompressSync, constants } from "node:zlib";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type {
  LandmarkEntry,
  LandmarkCityId,
  PoiEntry,
  PoiBundle,
  Tier,
  TileAnchor,
} from "@pt/shared";
export type { PoiEntry, PoiBundle, Tier };
import {
  validateLandmarkFile,
  normalizePoiText,
  tileKeyAt,
  TILE_MIN_K,
} from "@pt/shared";
import type { TagSpec } from "./osmTags.js";
import type {
  CategorizedOsmFeature,
  ExtractOptions,
} from "./osmiumExtract.js";
import { extractFromPbf } from "./osmiumExtract.js";

export const normalizeName = normalizePoiText;

export function curatedToPoiEntry(entry: LandmarkEntry): PoiEntry {
  const aliases: Record<string, string[]> = {};
  for (const [lang, langAliases] of Object.entries(entry.aliases)) {
    if (langAliases && langAliases.length > 0) {
      aliases[lang] = [...langAliases];
    }
  }
  return {
    id: entry.id,
    name: entry.canonicalName,
    aliases,
    category: entry.category,
    lat: entry.lat,
    lon: entry.lon,
    source: "curated",
    rankBoost: 1.0,
    ...(entry.wikidataId ? { wikidataId: entry.wikidataId } : {}),
    nearestStopGroupId: entry.nearestStopGroupId,
    tier: "strict",
  };
}

function extractOsmAliases(
  tags: Record<string, string>,
): Record<string, string[]> {
  const aliases: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(tags)) {
    const match = key.match(/^name:([a-z]{2,3}(?:[-_][a-zA-Z0-9]+)*)$/);
    if (match && value) {
      aliases[match[1]] = [value];
    }
  }
  return aliases;
}

/** Base OSM rank boost; curated landmarks use 1.0. */
export const OSM_RANK_BOOST = 0.3;

/** Places people travel to (malls) beat places to stay or bus-stop
 *  copies when the name matches equally well. Without this a search for
 *  "Tbilisi" filled all 15 slots with "Tbilisi … Hotel" and hid "Galleria
 *  Tbilisi", which only matches on its second word. */
export function osmRankBoost(feature: CategorizedOsmFeature): number {
  const t = feature.tags;
  if (t.shop === "mall") return 0.45;
  if (/^(hotel|hostel|guest_house|apartment|motel|camp_site|caravan_site|chalet)$/.test(t.tourism ?? "")) return 0.2;
  if (t.amenity === "kindergarten") return 0.2;
  // Real stops come from GTFS; the OSM copy only helps when a name differs.
  if (feature.category === "named_bus_stop") return 0.2;
  return OSM_RANK_BOOST;
}

export function osmToPoiEntry(feature: CategorizedOsmFeature): PoiEntry {
  const street = feature.tags["addr:street"]?.trim();
  const houseNumber = feature.tags["addr:housenumber"]?.trim();
  const locality = feature.tags["addr:suburb"]?.trim() || feature.tags["addr:city"]?.trim();
  const address = {
    ...(street ? { street } : {}),
    ...(houseNumber ? { houseNumber } : {}),
    ...(locality ? { locality } : {}),
  };
  return {
    id: `osm-${feature.id}`,
    name: feature.tags.name ?? "",
    aliases: extractOsmAliases(feature.tags),
    ...(Object.keys(address).length ? { address } : {}),
    category: feature.category,
    lat: feature.lat,
    lon: feature.lon,
    source: "osm",
    rankBoost: osmRankBoost(feature),
    osmId: feature.id,
    ...(feature.tags.wikidata ? { wikidataId: feature.tags.wikidata } : {}),
    tier: feature.tier,
  };
}

export function mergeEntries(
  curated: PoiEntry[],
  osm: PoiEntry[],
): PoiEntry[] {
  const byWikidata = new Map<string, number>();
  const byNormName = new Map<string, number>();

  const result = curated.map((e, i) => {
    const entry = { ...e, aliases: { ...e.aliases } };
    if (entry.wikidataId) byWikidata.set(entry.wikidataId, i);
    byNormName.set(normalizeName(entry.name), i);
    return entry;
  });

  const seenOsmIds = new Set<string>();

  for (const osmEntry of osm) {
    if (osmEntry.osmId) {
      if (seenOsmIds.has(osmEntry.osmId)) continue;
      seenOsmIds.add(osmEntry.osmId);
    }

    let matchIdx: number | undefined;
    if (osmEntry.wikidataId) {
      matchIdx = byWikidata.get(osmEntry.wikidataId);
    }
    if (matchIdx === undefined) {
      matchIdx = byNormName.get(normalizeName(osmEntry.name));
    }

    if (matchIdx !== undefined) {
      const target = result[matchIdx];
      // A landmark can match several entrances/buildings. Keep one address
      // intact rather than mixing a street and house number from different ones.
      if (!target.address && osmEntry.address) target.address = { ...osmEntry.address };
      for (const [lang, osmAliases] of Object.entries(osmEntry.aliases)) {
        if (!target.aliases[lang] || target.aliases[lang].length === 0) {
          target.aliases[lang] = osmAliases;
        }
      }
    } else {
      result.push(osmEntry);
    }
  }

  return result;
}

export function contentHash(entries: PoiEntry[]): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(entries));
  return hash.digest("hex").slice(0, 16);
}

export function createBundle(
  cityId: string,
  tier: Tier,
  entries: PoiEntry[],
  opts: { sourcePbfTimestamp?: string; bundleGeneratedAt?: string } = {},
): PoiBundle {
  return {
    meta: {
      cityId,
      version: contentHash(entries),
      attribution: "\u00a9 OpenStreetMap contributors",
      licenseUrl: "https://opendatacommons.org/licenses/odbl/",
      sourcePbfTimestamp: opts.sourcePbfTimestamp ?? new Date().toISOString(),
      bundleGeneratedAt: opts.bundleGeneratedAt ?? new Date().toISOString(),
      tier,
      entryCount: entries.length,
    },
    entries,
  };
}

export function compressBundle(bundle: PoiBundle): Buffer {
  const json = JSON.stringify(bundle);
  return brotliCompressSync(Buffer.from(json), {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
    },
  });
}

export interface BuildOptions {
  tagSpec: TagSpec;
  tier: Tier;
  landmarkEntries: LandmarkEntry[];
  osmFeatures?:
    | AsyncIterable<CategorizedOsmFeature>
    | Iterable<CategorizedOsmFeature>;
  pbfPath?: string;
  extractOpts?: ExtractOptions;
  sourcePbfTimestamp?: string;
  bundleGeneratedAt?: string;
  skipKAnonymityValidation?: boolean;
}

export class TileKAnonymityViolation extends Error {
  readonly cityId: string;
  readonly violations: ReadonlyArray<{ tileKey: string; count: number }>;
  constructor(
    cityId: string,
    violations: ReadonlyArray<{ tileKey: string; count: number }>,
  ) {
    super(
      `TileKAnonymityViolation: ${cityId} has ${violations.length} tile(s) below k=${TILE_MIN_K}: ` +
        violations
          .map((v) => `${v.tileKey} (${v.count})`)
          .join(", "),
    );
    this.name = "TileKAnonymityViolation";
    this.cityId = cityId;
    this.violations = violations;
  }
}

/** Phase-1 per-tile floor (k-anon-floor): assert every tile at the DERIVED edge+anchor
 *  has >= TILE_MIN_K. The derivation guarantees this; a failure means the derivation
 *  is wrong. Hard error (the Phase-0 whole-bundle gate + global-grid warn still apply). */
export function assertTilesMeetK(cityId: string, entries: PoiEntry[], edgeKm: number, anchor: TileAnchor): void {
  const byTile = new Map<string, number>();
  for (const e of entries) {
    const k = tileKeyAt(cityId, e.lat, e.lon, edgeKm, anchor);
    byTile.set(k, (byTile.get(k) ?? 0) + 1);
  }
  const violations = [...byTile.entries()].filter(([, c]) => c < TILE_MIN_K).map(([tileKey, count]) => ({ tileKey, count }));
  if (violations.length > 0) throw new TileKAnonymityViolation(cityId, violations);
}

export function validateTileKAnonymity(
  cityId: string,
  entries: PoiEntry[],
): void {
  if (entries.length === 0) return;

  // The LIVE delivery unit is the whole-city bundle: poiLoader fetches
  // `/poi/<city>.br` → `db.poiIndex` → BundledGeocoderAdapter / searchSuggestions
  // scan it client-side. The per-tile path (backend `poiTile.ts`, frontend
  // `tileLoader.ts` + `db.poiTileCache`) is dormant prototype — nothing live
  // consumes it. So the HARD k-anonymity gate is on the unit we actually ship:
  // the whole bundle must hold >= k POIs (a city with fewer can't be served
  // privately at all). Per-tile sub-k slices are WARNED, not thrown, because
  // they are not shipped today; per-tile enforcement (with a city-anchored,
  // auto-derived edge so every tile reaches k) returns when per-tile delivery is
  // activated — see the poi adaptive tiling notes.
  if (entries.length < TILE_MIN_K) {
    throw new TileKAnonymityViolation(cityId, [
      { tileKey: `${cityId}/whole-bundle`, count: entries.length },
    ]);
  }

  const byTile = new Map<string, number>();
  for (const e of entries) {
    const key = tileKeyAt(cityId, e.lat, e.lon);
    byTile.set(key, (byTile.get(key) ?? 0) + 1);
  }
  const subK: Array<{ tileKey: string; count: number }> = [];
  for (const [tileKey, count] of byTile) {
    if (count < TILE_MIN_K) subK.push({ tileKey, count });
  }
  if (subK.length > 0) {
    // Not fatal: the whole bundle (what ships) holds all POIs; these slices only
    // matter once per-tile delivery is live. Surface them so counts/locations are
    // visible — no POIs are dropped here.
    console.warn(
      `[poi] ${cityId}: ${subK.length} per-tile slice(s) below k=${TILE_MIN_K} ` +
        `(per-tile delivery is dormant; whole bundle ships all ${entries.length} POIs): ` +
        subK
          .sort((a, b) => a.count - b.count)
          .map((v) => `${v.tileKey}(${v.count})`)
          .join(", "),
    );
  }
}

async function collectOsmEntries(
  source:
    | AsyncIterable<CategorizedOsmFeature>
    | Iterable<CategorizedOsmFeature>,
): Promise<PoiEntry[]> {
  const out: PoiEntry[] = [];
  for await (const feature of source as AsyncIterable<CategorizedOsmFeature>) {
    out.push(osmToPoiEntry(feature));
  }
  return out;
}

export async function buildCityBundle(
  cityId: string,
  opts: BuildOptions,
): Promise<{ bundle: PoiBundle; compressed: Buffer }> {
  const curated = opts.landmarkEntries
    .filter((e) => e.city === cityId)
    .map(curatedToPoiEntry);

  let osmEntries: PoiEntry[];
  if (opts.osmFeatures) {
    osmEntries = await collectOsmEntries(opts.osmFeatures);
  } else if (opts.pbfPath) {
    osmEntries = await collectOsmEntries(
      extractFromPbf(opts.pbfPath, opts.tagSpec, opts.tier, opts.extractOpts),
    );
  } else {
    osmEntries = [];
  }

  let merged = mergeEntries(curated, osmEntries);
  if (opts.tier === "loose") {
    merged = merged.filter((e) => e.tier === "loose");
  }

  if (!opts.skipKAnonymityValidation) {
    validateTileKAnonymity(cityId, merged);
  }

  const bundle = createBundle(cityId, opts.tier, merged, {
    sourcePbfTimestamp: opts.sourcePbfTimestamp,
    bundleGeneratedAt: opts.bundleGeneratedAt,
  });

  const compressed = compressBundle(bundle);
  return { bundle, compressed };
}

export async function loadLandmarks(
  filePath: string,
  expectedCity?: LandmarkCityId,
): Promise<LandmarkEntry[]> {
  const raw = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
  const result = validateLandmarkFile(raw, { expectedCity });
  if (!result.ok) {
    const msgs = result.issues.map((i) => `  ${i.path}: ${i.message}`);
    throw new Error(`Invalid landmark file ${filePath}:\n${msgs.join("\n")}`);
  }
  return [...result.value.entries];
}

export async function writeBundleFile(
  outputPath: string,
  compressed: Buffer,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, compressed);
}
