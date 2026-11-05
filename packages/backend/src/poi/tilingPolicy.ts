import { POI_TILE_MAX_BYTES } from "@pt/shared";
import type { CityProfile } from "./cityProfiles.js";
import type { TilingPolicy, DeriveConfig } from "./derivePoiTileEdge.js";

export interface ResolvedPolicy {
  policy: TilingPolicy;
  config: DeriveConfig;
  fixedEdgeKm?: number;
  kAnonWaived: boolean;
}
export interface PolicyEnv {
  POI_TILE_POLICY?: string; POI_TILE_MAX_BYTES?: string;
  POI_TILE_EDGE_KM?: string; POI_KANON_WAIVED?: string;
}

/**
 * Precedence: per-city CityProfile override > POI_TILE_* env > default (k-anon-floor).
 * Non-default policies hard-error unless CityProfile.kAnonWaived OR POI_KANON_WAIVED=1.
 */
export function resolveTilingPolicy(profile: CityProfile, env: PolicyEnv): ResolvedPolicy {
  const policy: TilingPolicy =
    profile.tilingPolicy ?? (env.POI_TILE_POLICY as TilingPolicy | undefined) ?? "k-anon-floor";

  if (policy === "k-anon-floor") return { policy, config: {}, kAnonWaived: false };

  const waived = profile.kAnonWaived === true || env.POI_KANON_WAIVED === "1";
  if (!waived)
    throw new Error(
      `Tiling policy '${policy}' for city '${profile.cityId}' ships sub-k tiles and requires ` +
        `POI_KANON_WAIVED=1 or CityProfile.kAnonWaived=true (none set). Refusing to build.`,
    );

  if (policy === "fixed-edge") {
    const fixedEdgeKm = profile.poiTileEdgeKm ?? (env.POI_TILE_EDGE_KM ? Number(env.POI_TILE_EDGE_KM) : undefined);
    if (!fixedEdgeKm || fixedEdgeKm <= 0)
      throw new Error(`fixed-edge policy for '${profile.cityId}' needs a positive poiTileEdgeKm / POI_TILE_EDGE_KM`);
    return { policy, config: { fixedEdgeKm }, fixedEdgeKm, kAnonWaived: true };
  }
  const maxBytes = profile.poiTileMaxBytes ?? (env.POI_TILE_MAX_BYTES ? Number(env.POI_TILE_MAX_BYTES) : POI_TILE_MAX_BYTES);
  return { policy, config: { maxBytes }, kAnonWaived: true };
}
