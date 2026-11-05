import { describe, it, expect } from "vitest";
import { osloProfile } from "../../src/harness/cities/oslo.js";

/**
 * Oslo city profile structural tests.
 *
 * Structural-only for now. The Ruter feed is
 * a real, public GTFS source so a Paris-style INTEGRATION=1 block can be
 * added once Transitous coverage of Norway is verified end-to-end against
 * the harness scenarios. Until then, these checks defend against typos
 * in lat/lon + Norwegian-character stop names that visual review misses.
 */
describe("Oslo city profile", () => {
  it("has valid profile structure", () => {
    expect(osloProfile.id).toBe("oslo");
    expect(osloProfile.landmarks.length).toBeGreaterThanOrEqual(5);
    expect(osloProfile.scenarios.length).toBeGreaterThanOrEqual(4);
    expect(osloProfile.searchQueries.length).toBeGreaterThanOrEqual(3);

    // bbox covers central Oslo + western suburb corridor (Lysaker, Sandvika).
    expect(osloProfile.bbox.minLat).toBeLessThan(59.9);
    expect(osloProfile.bbox.maxLat).toBeGreaterThan(60.0);
    // Sandvika at lon 10.53 must fit; western edge generous.
    expect(osloProfile.bbox.minLon).toBeLessThan(10.55);
  });

  it("every landmark sits inside the bbox", () => {
    for (const lm of osloProfile.landmarks) {
      expect(lm.location.lat).toBeGreaterThanOrEqual(osloProfile.bbox.minLat);
      expect(lm.location.lat).toBeLessThanOrEqual(osloProfile.bbox.maxLat);
      expect(lm.location.lon).toBeGreaterThanOrEqual(osloProfile.bbox.minLon);
      expect(lm.location.lon).toBeLessThanOrEqual(osloProfile.bbox.maxLon);
    }
  });

  it("every scenario endpoint sits inside the bbox", () => {
    for (const s of osloProfile.scenarios) {
      for (const endpoint of [s.from, s.to]) {
        expect(endpoint.location.lat).toBeGreaterThanOrEqual(osloProfile.bbox.minLat);
        expect(endpoint.location.lat).toBeLessThanOrEqual(osloProfile.bbox.maxLat);
        expect(endpoint.location.lon).toBeGreaterThanOrEqual(osloProfile.bbox.minLon);
        expect(endpoint.location.lon).toBeLessThanOrEqual(osloProfile.bbox.maxLon);
      }
    }
  });

  it("scenarios have unique IDs", () => {
    const ids = osloProfile.scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("landmarks have unique names", () => {
    const names = osloProfile.landmarks.map((l) => l.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("center sits inside the bbox", () => {
    expect(osloProfile.center.lat).toBeGreaterThanOrEqual(osloProfile.bbox.minLat);
    expect(osloProfile.center.lat).toBeLessThanOrEqual(osloProfile.bbox.maxLat);
    expect(osloProfile.center.lon).toBeGreaterThanOrEqual(osloProfile.bbox.minLon);
    expect(osloProfile.center.lon).toBeLessThanOrEqual(osloProfile.bbox.maxLon);
  });

  it("lists Ruter as the contracting authority", () => {
    expect(osloProfile.agencies).toContain("Ruter");
  });

  it("covers bus, tram, metro, and ferry modes", () => {
    expect(osloProfile.modes).toContain("BUS");
    expect(osloProfile.modes).toContain("TRAM");
    expect(osloProfile.modes).toContain("METRO");
    expect(osloProfile.modes).toContain("FERRY");
  });

  it("uses Entur's RUT-aggregated GTFS feed", () => {
    expect(osloProfile.gtfsFeeds).toHaveLength(1);
    expect(osloProfile.gtfsFeeds[0]).toContain("rb_rut-aggregated-gtfs.zip");
  });

  it("has empty GTFS-RT feeds (Entur RT requires ET-Client-Name header)", () => {
    expect(osloProfile.gtfsRtFeeds).toHaveLength(0);
  });

  it("includes a Norwegian diacritic in at least one search query", () => {
    // Tøyen, Bærum, Skøyen, etc. — exercising æ/ø/å through the
    // search path is the whole reason Oslo earns its slot in the
    // multi-city Unicode coverage matrix alongside Lithuanian and
    // Polish diacritics.
    const hasDiacritic = osloProfile.searchQueries.some((q) =>
      /[æøåÆØÅ]/.test(q),
    );
    expect(hasDiacritic).toBe(true);
  });
});
