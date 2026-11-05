import { describe, it, expect } from "vitest";
import { resolvePoiTileDeliveryActive } from "./activation.js";
import { CITY_PROFILES } from "./cityProfiles.js";

describe("resolvePoiTileDeliveryActive (AC-1)", () => {
  it("per-city true wins over empty env", () => {
    expect(resolvePoiTileDeliveryActive({ poiTileDeliveryActive: true }, {})).toBe(true);
  });
  it("per-city false wins over global env=1", () => {
    expect(
      resolvePoiTileDeliveryActive(
        { poiTileDeliveryActive: false },
        { POI_TILE_DELIVERY_ACTIVE: "1" },
      ),
    ).toBe(false);
  });
  it("global env=1 with no per-city override → true", () => {
    expect(resolvePoiTileDeliveryActive({}, { POI_TILE_DELIVERY_ACTIVE: "1" })).toBe(true);
  });
  it("nothing set → false (default-off)", () => {
    expect(resolvePoiTileDeliveryActive({}, {})).toBe(false);
  });
  it("global env other than '1' → false", () => {
    expect(resolvePoiTileDeliveryActive({}, { POI_TILE_DELIVERY_ACTIVE: "true" })).toBe(false);
  });
});

describe("resolvePoiTileDeliveryActive over the REAL CITY_PROFILES (AC-6 / AC-7)", () => {
  it("AC-6: gdansk profile resolves active even with an explicitly-OFF env", () => {
    // Per-city short-circuit precedes the env read; pass a Pick matching the
    // resolver's parameter type. The realistic OFF env proves per-city wins.
    expect(
      resolvePoiTileDeliveryActive(
        { poiTileDeliveryActive: CITY_PROFILES.gdansk.poiTileDeliveryActive },
        { POI_TILE_DELIVERY_ACTIVE: "0" },
      ),
    ).toBe(true);
  });

  it("AC-A1: gdynia / sopot / vilnius now resolve ACTIVE (per-city flag set, env unset)", () => {
    for (const id of ["gdynia", "sopot", "vilnius"] as const) {
      expect(
        resolvePoiTileDeliveryActive(
          { poiTileDeliveryActive: CITY_PROFILES[id].poiTileDeliveryActive },
          {},
        ),
      ).toBe(true);
    }
    // env-independence: vilnius (prod city) stays active even with an explicitly-OFF env.
    expect(
      resolvePoiTileDeliveryActive(
        { poiTileDeliveryActive: CITY_PROFILES.vilnius.poiTileDeliveryActive },
        { POI_TILE_DELIVERY_ACTIVE: "0" },
      ),
    ).toBe(true);
  });
});
