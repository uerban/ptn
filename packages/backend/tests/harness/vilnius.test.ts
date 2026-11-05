import { describe, it, expect } from "vitest";
import { MotisAdapter } from "../../src/adapters/motis.js";
import { vilniusProfile } from "../../src/harness/cities/vilnius.js";
import { runCityHarness } from "../../src/adapters/benchmark.js";

/**
 * Vilnius integration tests.
 *
 * These tests run live queries against the Transitous API for Vilnius.
 * They validate that the MOTIS adapter correctly handles Lithuanian
 * transit data (Susisiekimo paslaugos bus/trolleybus network).
 *
 * Run: INTEGRATION=1 pnpm --filter @pt/backend test -- vilnius
 *
 * What we verify:
 * - Stop search returns results for Lithuanian stop names (diacritics: ė, š, ų, ž)
 * - Route planning works for all 5 Vilnius scenarios
 * - Nearby stops returns results near known landmarks
 * - Response mapping produces valid PTN types
 */
const integration = process.env.INTEGRATION ? describe : describe.skip;

describe("Vilnius city profile", () => {
  it("has valid profile structure", () => {
    expect(vilniusProfile.id).toBe("vilnius");
    expect(vilniusProfile.landmarks.length).toBeGreaterThanOrEqual(5);
    expect(vilniusProfile.scenarios.length).toBeGreaterThanOrEqual(3);
    expect(vilniusProfile.searchQueries.length).toBeGreaterThanOrEqual(3);

    // All landmarks have valid coordinates within Vilnius bbox
    for (const lm of vilniusProfile.landmarks) {
      expect(lm.location.lat).toBeGreaterThan(vilniusProfile.bbox.minLat);
      expect(lm.location.lat).toBeLessThan(vilniusProfile.bbox.maxLat);
      expect(lm.location.lon).toBeGreaterThan(vilniusProfile.bbox.minLon);
      expect(lm.location.lon).toBeLessThan(vilniusProfile.bbox.maxLon);
    }

    // All scenario endpoints are within bbox
    for (const sc of vilniusProfile.scenarios) {
      expect(sc.from.location.lat).toBeGreaterThan(vilniusProfile.bbox.minLat);
      expect(sc.to.location.lat).toBeGreaterThan(vilniusProfile.bbox.minLat);
    }
  });

  it("scenarios have unique IDs", () => {
    const ids = vilniusProfile.scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

integration("Vilnius — MOTIS integration", () => {
  const adapter = new MotisAdapter();

  it("stop search: Lithuanian names with diacritics", async () => {
    // Was "Geležinkelio stotis", which is just Lithuanian for "railway station"
    // and exists in most Lithuanian cities. Upstream ranks the other cities'
    // copies above Vilnius, so this asserted geographic ranking rather than
    // diacritic handling — and it carried only ž of the four characters the
    // comment claimed to cover. "Šeškinė" is a Vilnius district, is one of the
    // profile's own searchQueries, and exercises Š and ė.
    const results = await adapter.searchStops("Šeškinė", 5);
    expect(results.length).toBeGreaterThan(0);

    // Read the envelope from the profile instead of hardcoding it: the copy
    // that used to live here had drifted from the profile it was standing in
    // for (54.6/25.40 against the profile's 54.62/25.42).
    const bbox = vilniusProfile.bbox;
    const inVilnius = results.some(
      (s) =>
        s.location.lat >= bbox.minLat &&
        s.location.lat <= bbox.maxLat &&
        s.location.lon >= bbox.minLon &&
        s.location.lon <= bbox.maxLon
    );
    expect(inVilnius).toBe(true);
  }, 15000);

  it("stop search: Katedros aikštė (cathedral)", async () => {
    const results = await adapter.searchStops("Katedros", 5);
    expect(results.length).toBeGreaterThan(0);
  }, 15000);

  it("route planning: center-short (station to cathedral)", async () => {
    const scenario = vilniusProfile.scenarios.find(
      (s) => s.id === "center-short"
    )!;
    const result = await adapter.planTrip({
      from: scenario.from.location,
      to: scenario.to.location,
    });

    expect(result.itineraries.length).toBeGreaterThanOrEqual(
      scenario.minItineraries ?? 1
    );

    // First itinerary should be reasonable
    const first = result.itineraries[0];
    expect(first.durationSeconds).toBeLessThan(
      scenario.maxDurationSeconds ?? 3600
    );
    expect(first.legs.length).toBeGreaterThan(0);
  }, 20000);

  it("route planning: cross-city (Pilaitė to Antakalnis)", async () => {
    const scenario = vilniusProfile.scenarios.find(
      (s) => s.id === "cross-city-ew"
    )!;
    const result = await adapter.planTrip({
      from: scenario.from.location,
      to: scenario.to.location,
    });

    expect(result.itineraries.length).toBeGreaterThanOrEqual(1);
    const first = result.itineraries[0];
    expect(first.durationSeconds).toBeLessThan(
      scenario.maxDurationSeconds ?? 7200
    );
  }, 20000);

  it("route planning: airport to center", async () => {
    const scenario = vilniusProfile.scenarios.find(
      (s) => s.id === "airport-to-center"
    )!;
    const result = await adapter.planTrip({
      from: scenario.from.location,
      to: scenario.to.location,
    });

    expect(result.itineraries.length).toBeGreaterThanOrEqual(1);
  }, 20000);

  it("nearby stops: train station area", async () => {
    const station = vilniusProfile.landmarks.find(
      (l) => l.role?.includes("train station")
    )!;
    const stops = await adapter.getNearbyStops(station.location, 500);
    expect(stops.length).toBeGreaterThan(0);
  }, 15000);

  it("full city harness completes without critical errors", async () => {
    const result = await runCityHarness(adapter, vilniusProfile);

    expect(result.cityId).toBe("vilnius");
    expect(result.adapterName).toBe("motis");
    expect(result.healthCheck.healthy).toBe(true);

    // At least half of search queries should return results
    const successfulSearches = result.searchResults.filter(
      (s) => s.resultCount > 0
    );
    expect(successfulSearches.length).toBeGreaterThanOrEqual(
      Math.floor(result.searchResults.length / 2)
    );

    // At least half of scenarios should return itineraries
    const successfulScenarios = result.scenarioResults.filter(
      (s) => s.itineraryCount > 0
    );
    expect(successfulScenarios.length).toBeGreaterThanOrEqual(
      Math.floor(result.scenarioResults.length / 2)
    );
  }, 120000);
});
