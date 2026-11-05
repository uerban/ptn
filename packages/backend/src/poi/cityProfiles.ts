import type { LandmarkCityId } from "@pt/shared";
import type { BBox } from "./osmiumExtract.js";

export interface CityProfile {
  readonly cityId: LandmarkCityId;
  readonly sourcePbf: string;
  readonly bbox: BBox;
  readonly strictTier: true;
  readonly looseTier: boolean;
  /**
 * Per-city tiling overrides. Absent ⇒ POI_TILE_* env ⇒ default (k-anon-floor).
 */
  readonly tilingPolicy?: "k-anon-floor" | "byte-budget" | "fixed-edge";
  readonly poiTileEdgeKm?: number;
  readonly poiTileMaxBytes?: number;
  readonly kAnonWaived?: boolean;
  /**
 * Per-city activation override for per-tile POI delivery. Absent ⇒ global
 * POI_TILE_DELIVERY_ACTIVE env ⇒ default-off.
 */
  readonly poiTileDeliveryActive?: boolean;
}

const GEOFABRIK_POMORSKIE =
  "https://download.geofabrik.de/europe/poland/pomorskie-latest.osm.pbf";
const GEOFABRIK_LITHUANIA =
  "https://download.geofabrik.de/europe/lithuania-latest.osm.pbf";

export const CITY_PROFILES: Record<LandmarkCityId, CityProfile> = {
  gdansk: {
    cityId: "gdansk",
    sourcePbf: GEOFABRIK_POMORSKIE,
    bbox: { minLon: 18.4, minLat: 54.28, maxLon: 18.75, maxLat: 54.45 },
    strictTier: true,
    looseTier: true,
    poiTileDeliveryActive: true, // ← per-tile delivery ON for gdansk
  },
  gdynia: {
    cityId: "gdynia",
    sourcePbf: GEOFABRIK_POMORSKIE,
    bbox: { minLon: 18.42, minLat: 54.45, maxLon: 18.62, maxLat: 54.62 },
    strictTier: true,
    // Malls and other everyday destinations are loose-tier OSM features; the
    // curated landmarks that used to cover them are no longer bundled.
    looseTier: true,
    poiTileDeliveryActive: true, // ← per-tile delivery ON for gdynia
  },
  sopot: {
    cityId: "sopot",
    sourcePbf: GEOFABRIK_POMORSKIE,
    bbox: { minLon: 18.52, minLat: 54.40, maxLon: 18.60, maxLat: 54.47 },
    strictTier: true,
    // Not loaded by the client (tricity = gdansk + gdynia, which cover Sopot).
    looseTier: false,
    poiTileDeliveryActive: true, // ← per-tile delivery ON for sopot
  },
  vilnius: {
    cityId: "vilnius",
    sourcePbf: GEOFABRIK_LITHUANIA,
    bbox: { minLon: 25.08, minLat: 54.58, maxLon: 25.48, maxLat: 54.78 },
    strictTier: true,
    looseTier: true,
    poiTileDeliveryActive: true, // ← per-tile delivery ON for vilnius
  },
  tbilisi: {
    cityId: "tbilisi",
    sourcePbf: "https://download.geofabrik.de/europe/georgia-latest.osm.pbf",
    bbox: { minLon: 44.60, minLat: 41.60, maxLon: 45.05, maxLat: 41.85 },
    strictTier: true,
    looseTier: true,
    poiTileDeliveryActive: true,
  },
};

export function getCityProfile(cityId: LandmarkCityId): CityProfile {
  return CITY_PROFILES[cityId];
}

export function citiesForPbf(pbfUrl: string): CityProfile[] {
  return Object.values(CITY_PROFILES).filter((p) => p.sourcePbf === pbfUrl);
}

export function uniquePbfUrls(): string[] {
  return [...new Set(Object.values(CITY_PROFILES).map((p) => p.sourcePbf))];
}
