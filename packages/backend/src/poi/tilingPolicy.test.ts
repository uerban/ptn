import { describe, it, expect } from "vitest";
import { resolveTilingPolicy } from "./tilingPolicy.js";
import type { CityProfile } from "./cityProfiles.js";

const base: CityProfile = {
  cityId: "gdansk", sourcePbf: "x",
  bbox: { minLon: 18.4, minLat: 54.28, maxLon: 18.75, maxLat: 54.45 },
  strictTier: true, looseTier: true,
};

describe("resolveTilingPolicy", () => {
  it("defaults to k-anon-floor, no waiver needed", () => {
    expect(resolveTilingPolicy(base, {})).toMatchObject({ policy: "k-anon-floor", kAnonWaived: false });
  });
  it("env byte-budget without waiver hard-errors naming policy + city", () => {
    expect(() => resolveTilingPolicy(base, { POI_TILE_POLICY: "byte-budget" }))
      .toThrow(/byte-budget.*gdansk|gdansk.*byte-budget/i);
  });
  it("env byte-budget + POI_KANON_WAIVED=1 allowed", () => {
    expect(resolveTilingPolicy(base, { POI_TILE_POLICY: "byte-budget", POI_KANON_WAIVED: "1" }))
      .toMatchObject({ policy: "byte-budget", kAnonWaived: true });
  });
  it("per-city override beats env; its kAnonWaived satisfies the gate; fixedEdgeKm is top-level", () => {
    const p: CityProfile = { ...base, tilingPolicy: "fixed-edge", poiTileEdgeKm: 6, kAnonWaived: true };
    expect(resolveTilingPolicy(p, { POI_TILE_POLICY: "k-anon-floor" }))
      .toMatchObject({ policy: "fixed-edge", fixedEdgeKm: 6, kAnonWaived: true });
  });
  it("per-city non-default policy WITHOUT per-city flag and WITHOUT env waiver hard-errors", () => {
    expect(() => resolveTilingPolicy({ ...base, tilingPolicy: "byte-budget" }, {}))
      .toThrow(/byte-budget.*gdansk|gdansk.*byte-budget/i);
  });
});
