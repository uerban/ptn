import type { PoiEntry } from "@pt/shared";

/** COMMITTED vilnius × k-anon-floor strict fixture for the PR-gated AC-B1.
 *  Hermetic (no OSM/nightly coupling) — mirrors gdanskStrictFixture.ts.
 *
 *  100 entries: TWO well-separated clusters of 50 each inside the vilnius
 *  PROFILE bbox (minLon 25.08, minLat 54.58, maxLon 25.48, maxLat 54.78 — the
 *  BACKEND CityProfile bbox, the grid origin for tile derivation; distinct from
 *  the frontend CityConfig bbox). The grid origin (anchor) is
 *  { minLat: 54.58, minLon: 25.08, refLat: 54.68 }.
 *
 *  WEST cluster: 50 POIs in a 5×10 micro-grid around (54.595, 25.10).
 *  EAST cluster: 50 POIs in a 5×10 micro-grid around (54.595, 25.35).
 *  At anchor refLat 54.68 the 12 km lon step is ≈ 0.1865°, so the x-cell
 *  boundaries fall at lon 25.08, 25.2665, 25.4529, … . The WEST micro-grid
 *  (lon 25.100..25.103) lands entirely in x-cell 0; the EAST micro-grid
 *  (lon 25.350..25.353) lands entirely in x-cell 1 — distinct 12 km x-cells,
 *  each micro-grid spanning < 0.004° so all 50 of a cluster share one cell.
 *  derivePoiTileEdge therefore settles at the FINEST ladder edge 12 (each cell
 *  holds 50 >= TILE_MIN_K), producing EXACTLY TWO tiles. These coordinates are
 *  PINNED — do NOT regenerate or "tune to 12". The EAST base lon is 25.35 (NOT
 *  25.45): a base near 25.45 straddles the x=1/x=2 boundary at ≈ 25.4529 and
 *  splits the cluster into a sub-k cell. Verify with tileCoordAt(lat, lon, 12,
 *  anchor) before editing — confirm WEST shares one {x,y} and EAST another.
 */
function cluster(prefix: string, baseLat: number, baseLon: number): PoiEntry[] {
  return Array.from({ length: 50 }, (_, i) => {
    const row = i % 10;             // 0..9  → lat micro-step
    const col = Math.floor(i / 10); // 0..4  → lon micro-step
    return {
      id: `${prefix}${i}`,
      name: `Vilnius POI ${prefix}${i}`,
      aliases: {},
      category: "landmark",
      lat: baseLat + row * 0.0008,  // < 0.01° total → stays in one cell
      lon: baseLon + col * 0.0008,  // < 0.01° total → stays in one cell
      source: "osm" as const,
      rankBoost: 0.3,
      tier: "strict" as const,
    };
  });
}

export const VILNIUS_STRICT_FIXTURE: PoiEntry[] = [
  ...cluster("w", 54.595, 25.10), // WEST cell
  ...cluster("e", 54.595, 25.35), // EAST cell
];
