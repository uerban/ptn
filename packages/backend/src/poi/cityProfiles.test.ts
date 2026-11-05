import { describe, it, expect } from "vitest";
import { LANDMARK_CITY_IDS, type LandmarkCityId } from "@pt/shared";
import {
  CITY_PROFILES,
  getCityProfile,
  citiesForPbf,
  uniquePbfUrls,
  type CityProfile,
} from "./cityProfiles.js";

describe("CITY_PROFILES", () => {
  it("has a profile for every LandmarkCityId", () => {
    for (const cityId of LANDMARK_CITY_IDS) {
      expect(CITY_PROFILES[cityId]).toBeDefined();
      expect(CITY_PROFILES[cityId].cityId).toBe(cityId);
    }
  });

  it("every profile has strictTier true", () => {
    for (const profile of Object.values(CITY_PROFILES)) {
      expect(profile.strictTier).toBe(true);
    }
  });

  it("every profile has a valid bbox with min < max", () => {
    for (const profile of Object.values(CITY_PROFILES)) {
      expect(profile.bbox.minLon).toBeLessThan(profile.bbox.maxLon);
      expect(profile.bbox.minLat).toBeLessThan(profile.bbox.maxLat);
    }
  });

  it("every profile has a sourcePbf URL", () => {
    for (const profile of Object.values(CITY_PROFILES)) {
      expect(profile.sourcePbf).toMatch(/^https:\/\/download\.geofabrik\.de\//);
      expect(profile.sourcePbf).toMatch(/\.osm\.pbf$/);
    }
  });

  it("tricity cities share the pomorskie PBF", () => {
    const pomorskie = CITY_PROFILES.gdansk.sourcePbf;
    expect(CITY_PROFILES.gdynia.sourcePbf).toBe(pomorskie);
    expect(CITY_PROFILES.sopot.sourcePbf).toBe(pomorskie);
    expect(pomorskie).toContain("pomorskie");
  });

  it("vilnius uses the lithuania PBF", () => {
    expect(CITY_PROFILES.vilnius.sourcePbf).toContain("lithuania");
  });

  it("gdansk bbox is south of gdynia bbox", () => {
    expect(CITY_PROFILES.gdansk.bbox.maxLat).toBeLessThanOrEqual(
      CITY_PROFILES.gdynia.bbox.minLat,
    );
  });

  it("looseTier is enabled for every city the client loads", () => {
    expect(CITY_PROFILES.gdansk.looseTier).toBe(true);
    expect(CITY_PROFILES.gdynia.looseTier).toBe(true);
    expect(CITY_PROFILES.sopot.looseTier).toBe(false);
    expect(CITY_PROFILES.vilnius.looseTier).toBe(true);
    expect(CITY_PROFILES.tbilisi.looseTier).toBe(true);
  });
});

describe("getCityProfile", () => {
  it("returns the profile for a known city", () => {
    const profile = getCityProfile("gdansk");
    expect(profile.cityId).toBe("gdansk");
    expect(profile.strictTier).toBe(true);
  });
});

describe("citiesForPbf", () => {
  it("groups tricity cities under pomorskie", () => {
    const pomorskieCities = citiesForPbf(CITY_PROFILES.gdansk.sourcePbf);
    const ids = pomorskieCities.map((p) => p.cityId).sort();
    expect(ids).toEqual(["gdansk", "gdynia", "sopot"]);
  });

  it("returns only vilnius for lithuania PBF", () => {
    const ltCities = citiesForPbf(CITY_PROFILES.vilnius.sourcePbf);
    expect(ltCities).toHaveLength(1);
    expect(ltCities[0].cityId).toBe("vilnius");
  });

  it("returns empty array for unknown PBF", () => {
    expect(citiesForPbf("https://example.com/unknown.osm.pbf")).toEqual([]);
  });
});

describe("uniquePbfUrls", () => {
  it("returns exactly three unique PBF URLs", () => {
    const urls = uniquePbfUrls();
    expect(urls).toHaveLength(3);
    expect(urls).toContain(CITY_PROFILES.gdansk.sourcePbf);
    expect(urls).toContain(CITY_PROFILES.vilnius.sourcePbf);
  });
});

describe("CityProfile tiling overrides (optional)", () => {
  it("existing profiles have no overrides; overrides compile when set", () => {
    expect(CITY_PROFILES.gdansk.tilingPolicy).toBeUndefined();
    const probe: CityProfile = {
      ...CITY_PROFILES.gdansk,
      tilingPolicy: "byte-budget", poiTileEdgeKm: 6, poiTileMaxBytes: 32768, kAnonWaived: true,
    };
    expect(probe.kAnonWaived).toBe(true);
  });
});
