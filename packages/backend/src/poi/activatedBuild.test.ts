import { describe, it, expect } from "vitest";
import { deriveCityTiling } from "./buildAllBundles.js";
import { TileKAnonymityViolation } from "./buildBundle.js";
import type { CityProfile } from "./cityProfiles.js";
import { resolvePoiTileDeliveryActive } from "./activation.js";
import type { PoiEntry } from "@pt/shared";

const BBOX = { minLon: 18.4, minLat: 54.28, maxLon: 18.75, maxLat: 54.45 };

function entry(id: string, lat: number, lon: number): PoiEntry {
  return { id, name: id, aliases: {}, category: "landmark", lat, lon, source: "osm", rankBoost: 0.3, tier: "strict" };
}
function subKSpread(): PoiEntry[] {
  const dense = Array.from({ length: 60 }, (_, i) => entry(`d${i}`, 54.30 + i * 1e-6, 18.42 + i * 1e-6));
  const sparse = Array.from({ length: 5 }, (_, i) => entry(`s${i}`, 54.44 + i * 1e-6, 18.74 + i * 1e-6));
  return [...dense, ...sparse];
}

describe("activated build wiring (POI_TILE_DELIVERY_ACTIVE=1) — closes verify-a-new-gate gap", () => {
  // A k-anon-floor city can NEVER hit the rethrow: derivePoiTileEdge climbs the ladder until every
  // tile >= k, so its DERIVED edge has no sub-k tile (it self-corrects to a coarser edge /
  // whole-bbox single tile). The real throw path is the two-level waiver — env POI_KANON_WAIVED=1
  // lets resolveTilingPolicy SELECT the non-default fixed-edge policy, but the activation k-gate
  // keys on the per-CITY profile.kAnonWaived (UNSET here), so it still enforces the per-tile floor.
  // fixed-edge passes the requested 3 km edge straight through, so subKSpread() yields a genuine
  // sub-k (5-entry) tile → assertTilesMeetK throws. Mirrors buildAllBundles.test.ts AC-2a ('s
  // proven mechanism).
  const kanon: CityProfile = {
    cityId: "gdansk", sourcePbf: "x", bbox: BBOX, strictTier: true, looseTier: false,
    tilingPolicy: "fixed-edge", poiTileEdgeKm: 3, // kAnonWaived intentionally UNSET — env waiver only
  };
  const waived: CityProfile = {
    cityId: "vilnius", sourcePbf: "x", bbox: BBOX, strictTier: true, looseTier: false,
    tilingPolicy: "fixed-edge", poiTileEdgeKm: 3, kAnonWaived: true,
  };

  it("env=1 makes resolvePoiTileDeliveryActive true → deriveCityTiling rethrows on a sub-k tile", () => {
    const active = resolvePoiTileDeliveryActive(kanon, { POI_TILE_DELIVERY_ACTIVE: "1" });
    expect(active).toBe(true);
    expect(() => deriveCityTiling(kanon, subKSpread(), { POI_KANON_WAIVED: "1" }, active)).toThrow(TileKAnonymityViolation);
  });

  it("waived city under env=1 does not throw on a sub-k tile (self-host)", () => {
    const active = resolvePoiTileDeliveryActive(waived, { POI_TILE_DELIVERY_ACTIVE: "1" });
    expect(() => deriveCityTiling(waived, subKSpread(), {}, active)).not.toThrow();
  });
});
