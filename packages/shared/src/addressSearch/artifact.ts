/**
 * Schema version of the artifact that SHIPS — the packed binary one
 * (`crates/pt-geocode/src/artifact.rs`, magic `PTAS`). Advertised by the
 * `/address-search/manifest` route and checked by the PWA loader, which refuses
 * any other value outright: there is no compatibility reader.
 */
export const ADDRESS_SEARCH_ARTIFACT_SCHEMA_VERSION = 1 as const;

/**
 * Schema version of the JSON the EXTRACTOR emits
 * (`packages/backend/scripts/extract-addr-fixture.ts`).
 *
 * A SEPARATE contract from the packed artifact above, sharing a number by
 * coincidence and bumped independently. That JSON is an intermediate, never
 * served and never committed: `pt-producer pack-address-search` reads it and
 * writes the packed artifact, and its input parser is versioned against this.
 */
export const ADDRESS_SEARCH_EXTRACT_SCHEMA_VERSION = 1 as const;

export interface AddressSearchRow {
  /** Locale-correct display label. Never use normalized keys as UI text. */
  label: string;
  lat: number;
  lon: number;
}

export interface AddressSearchKey {
  /** Aggressively normalized lookup key generated from AddressSearchRow.label. */
  key: string;
  /** Index into AddressSearchArtifact.rows. */
  rowId: number;
}

export interface AddressSearchBuildStats {
  rawFeatureCount: number;
  rowCount: number;
  keyCount: number;
  skippedNoStreet: number;
  /** Rows whose every key lost all letters to normalization (non-Latin script, no alias). */
  omittedNoLetters?: number;
}

/**
 * The extractor's JSON intermediate. NOT the wire format — see
 * `ADDRESS_SEARCH_EXTRACT_SCHEMA_VERSION`.
 */
export interface AddressSearchArtifact {
  schemaVersion: typeof ADDRESS_SEARCH_EXTRACT_SCHEMA_VERSION;
  cityId?: string;
  source?: string;
  generatedAt: string;
  rows: AddressSearchRow[];
  keys: AddressSearchKey[];
  stats: AddressSearchBuildStats;
}

/**
 * The `/address-search/manifest` payload. Its `schemaVersion` describes the
 * PACKED artifact it points at — see
 * `ADDRESS_SEARCH_ARTIFACT_SCHEMA_VERSION`.
 */
export interface AddressSearchArtifactManifest {
  schemaVersion: typeof ADDRESS_SEARCH_ARTIFACT_SCHEMA_VERSION;
  cityId: string;
  generatedAt: string;
  artifactUrl: string;
  sha256: string;
  sizeBytes: number;
  rowCount: number;
  keyCount: number;
  source?: string;
  bundleGenerationId?: string;
}

export interface AddressSearchResult {
  label: string;
  lat: number;
  lon: number;
  confidence: number;
  matchedKey?: string;
}

export interface AddressSearchResponse {
  data: AddressSearchResult[];
  meta: {
    provider: "ptn-fst";
    queryVariants: string[];
  };
}
