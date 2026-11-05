import type { PtAddressIndexHandle } from "../addressIndexWasm.ts";
import { buildAddressIndex } from "../addressIndexWasm.ts";
import type {
  GeocoderAdapter,
  GeocoderCandidate,
  LatLon,
} from "@pt/shared";
import { db, type AddressSearchArtifactRecord } from "../../db/index.ts";
import { haversineMeters } from "./BundledGeocoderAdapter.ts";

const MAX_RESULTS = 10;

export interface AddressSearchCandidate extends GeocoderCandidate {
  provider: "address-bundle";
  privacyTier: "local";
  rowId: number;
  matchedKey: string;
}

interface CachedAddressIndex {
  sha256: string;
  index: PtAddressIndexHandle;
}

const cacheByCity = new Map<string, CachedAddressIndex>();

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
}

/**
 * Build (or reuse) the wasm index for a record.
 *
 * Hands the packed PTAS schema-1 bytes to wasm, which reads the FST in
 * place — no JS-side parse or rebuild. Keyed on sha256 so a corpus swap
 * rebuilds and a re-query does not.
 */
async function indexForRecord(
  record: AddressSearchArtifactRecord,
): Promise<CachedAddressIndex> {
  const cached = cacheByCity.get(record.cityId);
  if (cached?.sha256 === record.sha256) return cached;
  const index = await buildAddressIndex(record.bytes);
  const next = { sha256: record.sha256, index };
  cacheByCity.set(record.cityId, next);
  return next;
}

function scoreMatch(
  exact: boolean,
  row: { lat: number; lon: number },
  hint: LatLon | null,
): number {
  // `exact` means the matched key IS one of the query's normalized variants
  // rather than a longer key it merely prefixes. wasm computes it from the
  // same variant list it searched with, so the two planes agree on the term.
  let score = exact ? 0.92 : 0.82;
  if (hint) {
    const dist = haversineMeters(hint.lat, hint.lon, row.lat, row.lon);
    score += Math.max(0, 0.08 * (1 - dist / 50_000));
  }
  return Math.min(1, score);
}

function toCandidates(
  hits: readonly {
    label: string;
    lat: number;
    lon: number;
    rowId: number;
    matchedKey: string;
    exact: boolean;
  }[],
  hint: LatLon | null,
): AddressSearchCandidate[] {
  const out = hits.map((hit) => ({
    label: hit.label,
    lat: hit.lat,
    lon: hit.lon,
    confidence: scoreMatch(hit.exact, hit, hint),
    provider: "address-bundle" as const,
    privacyTier: "local" as const,
    rowId: hit.rowId,
    matchedKey: hit.matchedKey,
  }));
  out.sort((a, b) => b.confidence - a.confidence || a.label.localeCompare(b.label));
  return out;
}

export async function localAddressCandidates(
  cityId: string,
  query: string,
  hint: LatLon | null,
  signal: AbortSignal,
  limit = MAX_RESULTS,
): Promise<AddressSearchCandidate[]> {
  throwIfAborted(signal);
  const record = await db.addressSearchArtifacts.get(cityId);
  throwIfAborted(signal);
  if (!record || record.rowCount === 0 || record.keyCount === 0) return [];
  const { index } = await indexForRecord(record);
  throwIfAborted(signal);
  return toCandidates(index.search(query, limit), hint);
}

export class AddressSearchGeocoderAdapter implements GeocoderAdapter {
  readonly id = "address-bundle" as const;
  readonly privacyTier = "local" as const;

  constructor(private readonly getCityId: () => string | null) {}

  async isAvailable(): Promise<boolean> {
    const cityId = this.getCityId();
    if (!cityId) return false;
    const record = await db.addressSearchArtifacts.get(cityId);
    return Boolean(record && record.rowCount > 0 && record.keyCount > 0);
  }

  async forward(
    query: string,
    hint: LatLon | null,
    signal: AbortSignal,
  ): Promise<GeocoderCandidate[]> {
    const cityId = this.getCityId();
    if (!cityId) return [];
    return localAddressCandidates(cityId, query, hint, signal);
  }

  async reverse(_coord: LatLon, signal: AbortSignal): Promise<GeocoderCandidate | null> {
    throwIfAborted(signal);
    return null;
  }
}

export function __clearAddressSearchAdapterCacheForTests(): void {
  cacheByCity.clear();
}
