import { describe, it, expect } from "vitest";
import { CITIES, findNearestCity, findCityByLocation } from "../../src/config/cities.ts";

describe("CITIES config", () => {
  it("contains all 6 configured cities", () => {
    // toHaveLength guards against silent dedup or entry-drop regressions
    // (toContain alone would pass if one entry disappeared).
    expect(CITIES).toHaveLength(6);
    const ids = CITIES.map((c) => c.id);
    expect(ids).toContain("vilnius");
    expect(ids).toContain("tricity");
    expect(ids).toContain("krakow");
    expect(ids).toContain("paris");
    expect(ids).toContain("oslo");
    expect(ids).toContain("tbilisi");
  });

  it("krakow is available", () => {
    const krakow = CITIES.find((c) => c.id === "krakow")!;
    expect(krakow).toBeDefined();
    expect(krakow.available).toBe(true);
    expect(krakow.name).toBe("Krakow");
  });

  it("paris is available", () => {
    const paris = CITIES.find((c) => c.id === "paris")!;
    expect(paris).toBeDefined();
    expect(paris.available).toBe(true);
    expect(paris.name).toBe("Paris");
  });

  it("oslo is available", () => {
    const oslo = CITIES.find((c) => c.id === "oslo")!;
    expect(oslo).toBeDefined();
    expect(oslo.available).toBe(true);
    expect(oslo.name).toBe("Oslo");
  });

  it("every city has valid center inside its bbox", () => {
    for (const city of CITIES) {
      expect(city.center.lat).toBeGreaterThanOrEqual(city.bbox.minLat);
      expect(city.center.lat).toBeLessThanOrEqual(city.bbox.maxLat);
      expect(city.center.lon).toBeGreaterThanOrEqual(city.bbox.minLon);
      expect(city.center.lon).toBeLessThanOrEqual(city.bbox.maxLon);
    }
  });
});

describe("findNearestCity", () => {
  it("returns krakow for coordinates near Krakow center", () => {
    const nearest = findNearestCity(50.06, 19.94);
    expect(nearest.id).toBe("krakow");
  });

  it("returns paris for coordinates near Paris center", () => {
    const nearest = findNearestCity(48.85, 2.35);
    expect(nearest.id).toBe("paris");
  });

  it("returns oslo for coordinates near Oslo center", () => {
    const nearest = findNearestCity(59.91, 10.75);
    expect(nearest.id).toBe("oslo");
  });

  it("every returned city is available", () => {
    // Guards the findNearestCity filter: if someone adds an unavailable
    // city later, the helper must still only return available ones.
    // (Yerevan was previously the unavailable test fixture; removed 2026-04-19.)
    const sampled = [
      findNearestCity(50.06, 19.94),
      findNearestCity(48.85, 2.35),
      findNearestCity(54.68, 25.28),
      findNearestCity(0, 0),
    ];
    for (const c of sampled) expect(c.available).toBe(true);
  });
});

describe("findCityByLocation", () => {
  it("finds krakow by location inside its bbox", () => {
    const city = findCityByLocation(50.06, 19.94);
    expect(city).not.toBeNull();
    expect(city!.id).toBe("krakow");
  });

  it("finds paris by location inside its bbox", () => {
    const city = findCityByLocation(48.86, 2.35);
    expect(city).not.toBeNull();
    expect(city!.id).toBe("paris");
  });

  it("finds oslo by location inside its bbox", () => {
    const city = findCityByLocation(59.91, 10.75);
    expect(city).not.toBeNull();
    expect(city!.id).toBe("oslo");
  });

  it("returns null for a location outside all bboxes", () => {
    const city = findCityByLocation(0, 0);
    expect(city).toBeNull();
  });
});
