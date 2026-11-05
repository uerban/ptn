import type { PoiEntry } from "@pt/shared";

/** COMMITTED gdansk × k-anon-floor strict fixture for the PR-gated AC-16.
 *  Hermetic (no OSM/nightly coupling). 50 entries (= TILE_MIN_K) on a 10×5 grid
 *  spanning the FULL gdansk bbox corner-to-corner (lat 54.281..54.4484,
 *  lon 18.402..18.748). VERIFIED against the real KANON_LADDER/TILE_MIN_K:
 *  derivePoiTileEdge climbs to ladder edge 24, where the whole bbox is one tile
 *  ("c/24km/0_0") holding all 50 entries (minCount 50 ≥ k). edgeKm = 24, a single
 *  tile. These coordinates are PINNED — do NOT regenerate or "tune to 24". */
export const GDANSK_STRICT_FIXTURE: PoiEntry[] = Array.from({ length: 50 }, (_, i) => {
  const row = i % 10;             // 0..9  → lat
  const col = Math.floor(i / 10); // 0..4  → lon
  return {
    id: `gd${i}`,
    name: `Gdansk POI ${i}`,
    aliases: {},
    category: "landmark",
    lat: 54.281 + row * 0.0186,   // 54.281 .. 54.4484
    lon: 18.402 + col * 0.0865,   // 18.402 .. 18.748
    source: "osm" as const,
    rankBoost: 0.3,
    tier: "strict" as const,
  };
});
