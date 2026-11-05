import {
  tileKeyAt, TILE_MIN_K, POI_TILE_MAX_BYTES,
  type PoiEntry, type TileAnchor, type Bbox,
} from "@pt/shared";

export type TilingPolicy = "k-anon-floor" | "byte-budget" | "fixed-edge";
export interface DerivedEdge { edgeKm: number; anchor: TileAnchor; kAnonWaived: boolean; }
export interface DeriveConfig { maxBytes?: number; fixedEdgeKm?: number; }

export const KANON_LADDER = [12, 16, 20, 24, 32, 48, 64, 96] as const;
export const BYTE_LADDER = [3, 6, 8, 12, 16, 20, 24, 32, 48, 64, 96] as const;
const KM_PER_DEG_LAT = 111.32;
// Deterministic stand-in for brotli q11 (~0.4 ratio on POI JSON). Avoids
// non-deterministic/expensive compression while keeping derivation pure.
const BROTLI_RATIO = 0.4;

function anchorFor(bbox: Bbox): TileAnchor {
  return { minLat: bbox.minLat, minLon: bbox.minLon, refLat: (bbox.minLat + bbox.maxLat) / 2 };
}
function groups(entries: PoiEntry[], edgeKm: number, anchor: TileAnchor): PoiEntry[][] {
  const m = new Map<string, PoiEntry[]>();
  for (const e of entries) {
    const k = tileKeyAt("c", e.lat, e.lon, edgeKm, anchor);
    let g = m.get(k); if (!g) { g = []; m.set(k, g); } g.push(e);
  }
  return [...m.values()];
}
function estBytes(g: PoiEntry[]): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(g), "utf8") * BROTLI_RATIO);
}

/**
 * Pure, deterministic per-city POI tile-edge derivation.
 */
export function derivePoiTileEdge(
  entries: PoiEntry[], policy: TilingPolicy, bbox: Bbox, config: DeriveConfig,
): DerivedEdge {
  const anchor = anchorFor(bbox);

  if (policy === "fixed-edge") {
    if (!config.fixedEdgeKm || config.fixedEdgeKm <= 0)
      throw new Error("fixed-edge policy requires a positive fixedEdgeKm");
    return { edgeKm: config.fixedEdgeKm, anchor, kAnonWaived: true };
  }

  if (policy === "byte-budget") {
    const cap = config.maxBytes ?? POI_TILE_MAX_BYTES;
    let chosen: number = BYTE_LADDER[0]; // finest fallback if none pass
    for (const edge of BYTE_LADDER) {           // scan ALL (robust; sizes are monotonic)
      const sizes = groups(entries, edge, anchor).map(estBytes);
      if (sizes.length === 0 || Math.max(...sizes) <= cap) chosen = edge; // keep largest passing
    }
    return { edgeKm: chosen, anchor, kAnonWaived: true };
  }

  // k-anon-floor
  if (entries.length < TILE_MIN_K)
    throw new Error(
      `derivePoiTileEdge: city has ${entries.length} POIs (< k=${TILE_MIN_K}); cannot satisfy the floor even as one tile`,
    );
  for (const edge of KANON_LADDER) {
    const counts = groups(entries, edge, anchor).map((g) => g.length);
    if (counts.length === 0 || Math.min(...counts) >= TILE_MIN_K)
      return { edgeKm: edge, anchor, kAnonWaived: false };
  }
  // Whole-bbox single tile: edge >= max span (lon span scaled at refLat) ⇒ origin-relative 0_0.
  const latKm = (bbox.maxLat - bbox.minLat) * KM_PER_DEG_LAT;
  const lonKm = (bbox.maxLon - bbox.minLon) * KM_PER_DEG_LAT * Math.cos((anchor.refLat * Math.PI) / 180);
  return { edgeKm: Math.ceil(Math.max(latKm, lonKm)) + 1, anchor, kAnonWaived: false };
}
