import type { TileAnchor } from "./tileKey.js";

/** The only POI `manifest.json` schemaVersion; readers reject every other value. */
export const POI_MANIFEST_SCHEMA_VERSION = 1;

export interface PoiTileBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Frontend-readable POI manifest reader types — the single source of truth for
 *  the on-disk `manifest.json` wire shape. The backend writer types
 *  (`packages/backend/src/poi/manifest.ts`) `extends`/re-export these so the
 *  frontend can read the manifest without importing from `@pt/backend`.
 *  Writer-only fields (`sha256`, `generatedAt`) are OPTIONAL here so the backend
 *  `Manifest`/`ManifestBundle` stay structurally assignable to these reader
 *  types (AC-20). */
export interface PoiTileManifest {
  edgeKm: number;
  anchor: TileAnchor;
  /** Inclusive client-serving grid derived from the city bbox, including the
   * viewport overlap halo. Empty coordinates inside this grid are valid. */
  tileBounds: PoiTileBounds;
  tilingPolicy: "k-anon-floor" | "byte-budget" | "fixed-edge";
  kAnonWaived: boolean;
  /** Build-time activation decision consumed by frontend and both servers.
   * Required on every `poiTile` object. */
  deliveryActive: boolean;
}

export interface PoiManifestBundle {
  cityId: string;
  filename: string;
  sizeBytes: number;
  /** Compressed-byte digest; required for managed browser bundle discovery. */
  readonly sha256?: string;
  readonly poiTile?: PoiTileManifest;
}

export interface PoiManifest {
  /** Deployment activation order, independent of immutable source build dates. */
  readonly activationRevision?: number;
  /** Same-origin immutable aggregate directory for all advertised bundle files. */
  readonly baseUrl?: string;
  readonly schemaVersion: number;
  /** Writer-only on the build side; absent/ignored by the frontend reader. */
  readonly generatedAt?: number;
  readonly bundles: readonly PoiManifestBundle[];
}

/** Select the one strict bundle record that owns a city's tile contract.
 * Loose-tier records share `cityId`, so matching on city alone is ambiguous. */
export function selectStrictPoiManifestBundle(
  manifest: PoiManifest,
  cityId: string,
): PoiManifestBundle | null {
  if (manifest.schemaVersion !== POI_MANIFEST_SCHEMA_VERSION) return null;
  const matches = manifest.bundles.filter(
    (bundle) => bundle.cityId === cityId && bundle.filename === `${cityId}.br`,
  );
  if (matches.length > 1) {
    throw new Error(`duplicate strict manifest record for ${cityId}`);
  }
  return matches[0] ?? null;
}
