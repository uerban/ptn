import { describe, it, expect } from "vitest";
import { validateCityBbox } from "./validateCityBbox.js";
import { createCanonicalStore } from "./canonical/CanonicalStore.js";
import { buildTripStringTable } from "./parser.js";
import type { GtfsStop } from "./parser.js";

function canonicalWithStops(stops: Array<{ id: string; lat: number; lon: number }>) {
  return createCanonicalStore({
    stopTimes: new Map(),
    tripStrings: buildTripStringTable([]),
    stops: new Map(stops.map((s) => [s.id, { id: s.id, name: `Stop ${s.id}`, lat: s.lat, lon: s.lon, parentStation: "" }])),
    routes: new Map(),
    trips: new Map(),
    services: new Map(),
  });
}

function stopAt(id: string, lat: number, lon: number): GtfsStop {
  return { id, name: `Stop ${id}`, lat, lon } as GtfsStop;
}

// Reference centers (from harness/cities/*.ts)
const VILNIUS = { lat: 54.6872, lon: 25.2797 };
const TRICITY = { lat: 54.352, lon: 18.6466 };
const PARIS = { lat: 48.8566, lon: 2.3522 };

describe("validateCityBbox", () => {
  it("passes when stops centroid matches the city center", () => {
    const canonical = canonicalWithStops([
      stopAt("s1", VILNIUS.lat, VILNIUS.lon),
      stopAt("s2", VILNIUS.lat + 0.01, VILNIUS.lon + 0.01),
      stopAt("s3", VILNIUS.lat - 0.02, VILNIUS.lon + 0.02),
    ]);
    const result = validateCityBbox(canonical, "vilnius");
    expect(result).not.toBeNull();
    expect(result!.cityId).toBe("vilnius");
    expect(result!.distanceKm).toBeLessThan(5);
    expect(result!.stopCount).toBe(3);
  });

  it("throws when stops belong to a different city", () => {
    // Tricity stops loaded but CITY_ID=vilnius — staging bug scenario.
    const canonical = canonicalWithStops([
      stopAt("s1", TRICITY.lat, TRICITY.lon),
      stopAt("s2", TRICITY.lat + 0.01, TRICITY.lon + 0.01),
    ]);
    expect(() => validateCityBbox(canonical, "vilnius")).toThrow(
      /City validation failed for 'vilnius'/,
    );
  });

  it("error message includes actionable diagnostic", () => {
    const canonical = canonicalWithStops([stopAt("s1", PARIS.lat, PARIS.lon)]);
    try {
      validateCityBbox(canonical, "vilnius");
      expect.fail("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/centroid/);
      expect(msg).toMatch(/declared center/);
      expect(msg).toMatch(/CITY_ID/);
      expect(msg).toMatch(/GTFS_STATIC_URL/);
    }
  });

  it("tolerates suburban outliers as long as centroid stays close", () => {
    // Mostly Vilnius stops + one airport stop ~9 km from center.
    const canonical = canonicalWithStops([
      stopAt("s1", VILNIUS.lat, VILNIUS.lon),
      stopAt("s2", VILNIUS.lat + 0.01, VILNIUS.lon + 0.01),
      stopAt("s3", VILNIUS.lat - 0.02, VILNIUS.lon + 0.02),
      stopAt("airport", 54.6341, 25.2858), // Vilnius International Airport
    ]);
    expect(() => validateCityBbox(canonical, "vilnius")).not.toThrow();
  });

  it("passes through when cityId is unknown", () => {
    const canonical = canonicalWithStops([stopAt("s1", 0, 0)]);
    expect(validateCityBbox(canonical, "atlantis")).toBeNull();
  });

  it("throws when no stops loaded", () => {
    const canonical = canonicalWithStops([]);
    expect(() => validateCityBbox(canonical, "vilnius")).toThrow(/no stops loaded/);
  });

  it("custom maxCentroidDistanceKm respected", () => {
    const canonical = canonicalWithStops([
      stopAt("s1", VILNIUS.lat + 3, VILNIUS.lon), // ~333 km north
    ]);
    expect(() => validateCityBbox(canonical, "vilnius", { maxCentroidDistanceKm: 400 })).not.toThrow();
    expect(() => validateCityBbox(canonical, "vilnius", { maxCentroidDistanceKm: 100 })).toThrow();
  });

  it("uses 200 km default", () => {
    // Stop ~220 km from Vilnius — outside default, inside custom.
    const farLat = VILNIUS.lat + 2;
    const canonical = canonicalWithStops([stopAt("s1", farLat, VILNIUS.lon)]);
    expect(() => validateCityBbox(canonical, "vilnius")).toThrow();
  });
});
