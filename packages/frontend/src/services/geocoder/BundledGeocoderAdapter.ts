import Dexie from "dexie";
import { isPoiCategoryEnabled } from "../poiCategoryPreferences.ts";
import type {
  GeocoderAdapter,
  GeocoderCandidate,
  LatLon,
} from "@pt/shared";
import { normalizePoiText } from "@pt/shared/poi";
import { db, type PoiIndexRecord } from "../../db/index.ts";
import { poiCityIds } from "../poiCityMapping.ts";

const MAX_RESULTS = 10;
const REVERSE_RADIUS_M = 500;

export const normalizeQuery = normalizePoiText;

export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function flatAliases(aliases: Record<string, string[]>): string[] {
  const out: string[] = [];
  for (const arr of Object.values(aliases)) {
    for (const a of arr) out.push(a);
  }
  return out;
}

// `wordPrefix` is the "any whitespace-separated token starts with the query"
// tier — it sits between full-string prefix and bare substring so a hit on a
// later word ranks above a hit in the middle of one.
const NAME_WEIGHTS = { exact: 1.0, prefix: 0.85, wordPrefix: 0.7, substring: 0.5 };
const ALIAS_WEIGHTS = { exact: 0.9, prefix: 0.75, wordPrefix: 0.6, substring: 0.4 };

function tieredMatchScore(
  normalizedQuery: string,
  text: string,
  weights: { exact: number; prefix: number; wordPrefix: number; substring: number },
): number {
  const n = normalizeQuery(text);
  if (!n || !normalizedQuery) return 0;
  if (n === normalizedQuery) return weights.exact;
  if (n.startsWith(normalizedQuery)) return weights.prefix;
  if ((" " + n).includes(" " + normalizedQuery)) return weights.wordPrefix;
  if (n.includes(normalizedQuery)) return weights.substring;
  return 0;
}

export function nameMatchScore(normalizedQuery: string, name: string): number {
  return tieredMatchScore(normalizedQuery, name, NAME_WEIGHTS);
}

export function scoreCandidate(
  normalizedQuery: string,
  name: string,
  aliases: string[],
  hint: LatLon | null,
  rankBoost: number,
  lat: number,
  lon: number,
): number {
  let matchScore = nameMatchScore(normalizedQuery, name);

  if (matchScore < NAME_WEIGHTS.exact) {
    for (const alias of aliases) {
      const aliasScore = tieredMatchScore(normalizedQuery, alias, ALIAS_WEIGHTS);
      if (aliasScore > matchScore) matchScore = aliasScore;
      if (matchScore >= ALIAS_WEIGHTS.exact) break;
    }
  }

  if (matchScore === 0) return 0;

  let proximityBonus = 0;
  if (hint) {
    const dist = haversineMeters(hint.lat, hint.lon, lat, lon);
    proximityBonus = Math.max(0, 0.15 * (1 - dist / 50_000));
  }

  return matchScore * rankBoost + proximityBonus;
}

// Dedup by osmId so the same POI appearing in both the bundled index
// (loadSource undefined/"bundle") and a viewport tile (loadSource "tile")
// collapses to one row. Bundle wins regardless of insertion order — it's the
// canonical, k-anonymity-validated source.
export function deduplicateRecords(records: PoiIndexRecord[]): PoiIndexRecord[] {
  const byKey = new Map<string, PoiIndexRecord>();
  for (const rec of records) {
    const key = rec.osmId ?? rec.id;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, rec);
      continue;
    }
    if (existing.loadSource === "tile" && rec.loadSource !== "tile") {
      byKey.set(key, rec);
    }
  }
  return Array.from(byKey.values());
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
}

function neighborBuckets(lat: number, lon: number): string[] {
  const bLat = Math.floor(lat * 100);
  const bLon = Math.floor(lon * 100);
  const buckets: string[] = [];
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLon = -1; dLon <= 1; dLon++) {
      buckets.push(`${bLat + dLat}_${bLon + dLon}`);
    }
  }
  return buckets;
}

export class BundledGeocoderAdapter implements GeocoderAdapter {
  readonly id = "bundled" as const;
  readonly privacyTier = "local" as const;

  constructor(private readonly getCityId: () => string | null) {}

  async isAvailable(): Promise<boolean> {
    const frontendCityId = this.getCityId();
    if (!frontendCityId) return false;
    for (const cityId of poiCityIds(frontendCityId)) {
      const count = await db.poiIndex
        .where("[cityId+name]")
        .between([cityId, Dexie.minKey], [cityId, Dexie.maxKey])
        .limit(1)
        .count();
      if (count > 0) return true;
    }
    return false;
  }

  async forward(
    query: string,
    hint: LatLon | null,
    signal: AbortSignal,
  ): Promise<GeocoderCandidate[]> {
    throwIfAborted(signal);

    const frontendCityId = this.getCityId();
    if (!frontendCityId) return [];

    const nq = normalizeQuery(query);
    if (!nq) return [];

    const allRecords: PoiIndexRecord[] = [];
    for (const cityId of poiCityIds(frontendCityId)) {
      const recs = await db.poiIndex
        .where("[cityId+name]")
        .between([cityId, Dexie.minKey], [cityId, Dexie.maxKey])
        .toArray();
      allRecords.push(...recs);
    }

    throwIfAborted(signal);

    const prefixRecords = deduplicateRecords(allRecords.filter(isPoiCategoryEnabled));
    const scored: Array<{ record: PoiIndexRecord; score: number }> = [];

    for (const rec of prefixRecords) {
      const aliases = flatAliases(rec.aliases);
      const score = scoreCandidate(
        nq,
        rec.name,
        aliases,
        hint,
        rec.rankBoost,
        rec.lat,
        rec.lon,
      );
      if (score > 0) {
        scored.push({ record: rec, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, MAX_RESULTS).map(({ record: r, score }) => ({
      label: r.name,
      lat: r.lat,
      lon: r.lon,
      confidence: score,
      provider: this.id,
      privacyTier: this.privacyTier,
    }));
  }

  async reverse(
    coord: LatLon,
    signal: AbortSignal,
  ): Promise<GeocoderCandidate | null> {
    throwIfAborted(signal);

    const frontendCityId = this.getCityId();
    if (!frontendCityId) return null;

    const buckets = neighborBuckets(coord.lat, coord.lon);
    const candidates: PoiIndexRecord[] = [];

    for (const cityId of poiCityIds(frontendCityId)) {
      for (const bucket of buckets) {
        const recs = await db.poiIndex
          .where("[cityId+geoBucket]")
          .equals([cityId, bucket])
          .toArray();
        candidates.push(...recs);
      }
    }

    throwIfAborted(signal);

    const deduped = deduplicateRecords(candidates.filter(isPoiCategoryEnabled));
    let best: { record: PoiIndexRecord; dist: number } | null = null;

    for (const rec of deduped) {
      const dist = haversineMeters(coord.lat, coord.lon, rec.lat, rec.lon);
      if (dist <= REVERSE_RADIUS_M && (!best || dist < best.dist)) {
        best = { record: rec, dist };
      }
    }

    if (!best) return null;

    return {
      label: best.record.name,
      lat: best.record.lat,
      lon: best.record.lon,
      confidence: 1 - best.dist / REVERSE_RADIUS_M,
      provider: this.id,
      privacyTier: this.privacyTier,
    };
  }
}
