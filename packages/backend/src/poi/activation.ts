import type { CityProfile } from "./cityProfiles.js";

export interface PoiActivationEnv {
  POI_TILE_DELIVERY_ACTIVE?: string;
}

/**
 * Precedence (mirrors resolveTilingPolicy's shape): per-city CityProfile.poiTileDeliveryActive
 * (if defined) wins; else global POI_TILE_DELIVERY_ACTIVE === "1"; else false (default-off).
 */
export function resolvePoiTileDeliveryActive(
  profile: Pick<CityProfile, "poiTileDeliveryActive">,
  env: PoiActivationEnv,
): boolean {
  if (profile.poiTileDeliveryActive !== undefined) {
    return profile.poiTileDeliveryActive;
  }
  return env.POI_TILE_DELIVERY_ACTIVE === "1";
}
