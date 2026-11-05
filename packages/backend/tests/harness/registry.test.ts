import { describe, it, expect } from "vitest";
import {
  cityProfiles,
  getCityProfile,
  listCityIds,
} from "../../src/harness/cities/index.js";

/**
 * Registry-level structural test. Auto-exercises every profile in
 * harness/cities/index.ts via listCityIds() + getCityProfile(), so
 * adding a city and forgetting its per-city test doesn't let bbox /
 * coordinate / unique-id regressions slip through.
 *
 * The per-city test files (vilnius/tricity/krakow/paris/oslo)
 * still carry city-specific assertions (mode coverage, agency names,
 * scenario ids, etc.). This file is the generic safety net.
 */
describe("harness city registry", () => {
  it("exports at least the expected cities", () => {
    const ids = listCityIds().sort();
    expect(ids).toEqual(
      ["krakow", "oslo", "paris", "tbilisi", "tricity", "vilnius"].sort(),
    );
  });

  it("getCityProfile round-trips every registered id", () => {
    for (const id of listCityIds()) {
      const p = getCityProfile(id);
      expect(p, `profile missing for ${id}`).toBeDefined();
      expect(p!.id).toBe(id);
    }
  });

  it("getCityProfile is case-insensitive on lookup", () => {
    expect(getCityProfile("VILNIUS")).toBeDefined();
    expect(getCityProfile("UNKNOWN")).toBeUndefined();
  });

  it("cityProfiles keys match listCityIds", () => {
    expect(Object.keys(cityProfiles).sort()).toEqual(listCityIds().sort());
  });

  describe.each(listCityIds())("%s profile", (cityId) => {
    const p = cityProfiles[cityId]!;

    it("has center, bbox, and a non-empty name", () => {
      expect(p.id).toBe(cityId);
      expect(p.name).toBeTruthy();
      expect(p.bbox.minLat).toBeLessThan(p.bbox.maxLat);
      expect(p.bbox.minLon).toBeLessThan(p.bbox.maxLon);
    });

    it("center lies inside the bbox", () => {
      expect(p.center.lat).toBeGreaterThanOrEqual(p.bbox.minLat);
      expect(p.center.lat).toBeLessThanOrEqual(p.bbox.maxLat);
      expect(p.center.lon).toBeGreaterThanOrEqual(p.bbox.minLon);
      expect(p.center.lon).toBeLessThanOrEqual(p.bbox.maxLon);
    });

    it("landmarks all sit inside the bbox", () => {
      for (const lm of p.landmarks) {
        expect(
          lm.location.lat,
          `${cityId}/${lm.name} lat out of bbox`,
        ).toBeGreaterThanOrEqual(p.bbox.minLat);
        expect(lm.location.lat).toBeLessThanOrEqual(p.bbox.maxLat);
        expect(
          lm.location.lon,
          `${cityId}/${lm.name} lon out of bbox`,
        ).toBeGreaterThanOrEqual(p.bbox.minLon);
        expect(lm.location.lon).toBeLessThanOrEqual(p.bbox.maxLon);
      }
    });

    it("scenarios have unique ids", () => {
      const ids = p.scenarios.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("scenario endpoints all sit inside the bbox", () => {
      for (const s of p.scenarios) {
        for (const endpoint of [s.from, s.to]) {
          expect(
            endpoint.location.lat,
            `${cityId}/${s.id} ${endpoint.name} lat out of bbox`,
          ).toBeGreaterThanOrEqual(p.bbox.minLat);
          expect(endpoint.location.lat).toBeLessThanOrEqual(p.bbox.maxLat);
          expect(
            endpoint.location.lon,
            `${cityId}/${s.id} ${endpoint.name} lon out of bbox`,
          ).toBeGreaterThanOrEqual(p.bbox.minLon);
          expect(endpoint.location.lon).toBeLessThanOrEqual(p.bbox.maxLon);
        }
      }
    });
  });
});
