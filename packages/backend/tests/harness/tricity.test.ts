import { describe, it, expect } from "vitest";
import { MotisAdapter } from "../../src/adapters/motis.js";
import { tricityProfile } from "../../src/harness/cities/tricity.js";
import { runCityHarness } from "../../src/adapters/benchmark.js";
import { walkJourney } from "./mocks.js";

/**
 * Tricity (Trójmiasto) integration tests.
 *
 * These tests run live queries against the Transitous API for the
 * Gdańsk/Sopot/Gdynia metropolitan area. They validate multi-operator
 * scenarios (ZTM Gdańsk buses/trams + SKM rail + ZKM Gdynia + PKM).
 *
 * Run: INTEGRATION=1 pnpm --filter @pt/backend test -- tricity
 *
 * What we verify:
 * - Stop search returns results for Polish stop names (diacritics: ń, ś, ó, ł)
 * - Cross-city SKM rail routing (Gdańsk ↔ Gdynia, ~35 min)
 * - Airport PKM connection
 * - Multi-operator transfer scenarios (the Jakdojade pain point)
 * - Tram routing within central Gdańsk
 */
const integration = process.env.INTEGRATION ? describe : describe.skip;

describe("Tricity city profile", () => {
  it("has valid profile structure", () => {
    expect(tricityProfile.id).toBe("tricity");
    expect(tricityProfile.landmarks.length).toBeGreaterThanOrEqual(5);
    expect(tricityProfile.scenarios.length).toBeGreaterThanOrEqual(4);
    expect(tricityProfile.searchQueries.length).toBeGreaterThanOrEqual(3);

    // Covers the full Tricity area (Gdańsk south to Gdynia north)
    expect(tricityProfile.bbox.minLat).toBeLessThan(54.34);
    expect(tricityProfile.bbox.maxLat).toBeGreaterThan(54.52);

    // All landmarks within bbox
    for (const lm of tricityProfile.landmarks) {
      expect(lm.location.lat).toBeGreaterThan(tricityProfile.bbox.minLat);
      expect(lm.location.lat).toBeLessThan(tricityProfile.bbox.maxLat);
      expect(lm.location.lon).toBeGreaterThan(tricityProfile.bbox.minLon);
      expect(lm.location.lon).toBeLessThan(tricityProfile.bbox.maxLon);
    }
  });

  it("scenarios have unique IDs", () => {
    const ids = tricityProfile.scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes multi-operator scenario", () => {
    const multiOp = tricityProfile.scenarios.find(
      (s) => s.id === "multi-operator-transfer"
    );
    expect(multiOp).toBeDefined();
  });

  it("lists all key operators", () => {
    expect(tricityProfile.agencies).toContain("ZTM Gdańsk");
    expect(tricityProfile.agencies).toContain("SKM Trójmiasto");
    expect(tricityProfile.agencies).toContain("ZKM Gdynia");
    expect(tricityProfile.agencies).toContain("PKM");
  });
});

integration("Tricity — MOTIS integration", () => {
  const adapter = new MotisAdapter();

  it("stop search: Gdańsk Główny", async () => {
    const results = await adapter.searchStops("Gdańsk Główny", 5);
    expect(results.length).toBeGreaterThan(0);

    // Should find the main station in the Gdańsk area
    const inGdansk = results.some(
      (s) =>
        s.location.lat > 54.3 &&
        s.location.lat < 54.4 &&
        s.location.lon > 18.5 &&
        s.location.lon < 18.75
    );
    expect(inGdansk).toBe(true);
  }, 15000);

  it("stop search: Gdynia Główna (cross-city operator)", async () => {
    const results = await adapter.searchStops("Gdynia Główna", 5);
    expect(results.length).toBeGreaterThan(0);
  }, 15000);

  it("stop search: Sopot (middle city)", async () => {
    const results = await adapter.searchStops("Sopot", 5);
    expect(results.length).toBeGreaterThan(0);
  }, 15000);

  it("route planning: station to Old Town (short walk/bus)", async () => {
    const scenario = tricityProfile.scenarios.find(
      (s) => s.id === "station-to-old-town"
    )!;
    const result = await adapter.planTrip({
      from: scenario.from.location,
      to: scenario.to.location,
    });

    // Same shape as the Krakow station-to-old-town case: the profile declares
    // expectModes: ["WALK"], and a transit-free journey comes back under
    // `direct`, not `itineraries`. Accept either — an empty `itineraries` here
    // means "no transit route", which for a walkable pair is a valid answer
    // rather than a failure.
    const journeys = [...result.itineraries, ...(result.direct ?? [])];
    expect(journeys.length).toBeGreaterThanOrEqual(
      scenario.minItineraries ?? 1
    );

    // Bound the WALK, for the same reason as Krakow's station-to-old-town:
    // minimising over `itineraries` + `direct` makes a WALK scenario's bound
    // depend on transit that happens to be quicker at query time. This one is
    // not currently red — its walk (1104 s) already sits under the bound, so
    // the walk wins the minimum on its own — but that is luck about the size
    // of the number, not a property the assertion enforces.
    const walk = walkJourney(result);
    expect(
      walk,
      "expectModes is [WALK] but upstream returned no transit-free journey"
    ).toBeDefined();
    expect(walk!.durationSeconds).toBeLessThan(
      scenario.maxDurationSeconds ?? 1800
    );
  }, 20000);

  it("route planning: Gdańsk→Gdynia via SKM rail", async () => {
    const scenario = tricityProfile.scenarios.find(
      (s) => s.id === "gdansk-to-gdynia"
    )!;
    const result = await adapter.planTrip({
      from: scenario.from.location,
      to: scenario.to.location,
    });

    expect(result.itineraries.length).toBeGreaterThanOrEqual(1);

    // Should see rail legs (SKM)
    const first = result.itineraries[0];
    const modes = first.legs.map((l) => l.mode);
    // Expect at least one non-WALK mode
    expect(modes.some((m) => m !== "WALK")).toBe(true);
  }, 20000);

  it("route planning: airport connection", async () => {
    const scenario = tricityProfile.scenarios.find(
      (s) => s.id === "airport-to-center"
    )!;
    const result = await adapter.planTrip({
      from: scenario.from.location,
      to: scenario.to.location,
    });

    expect(result.itineraries.length).toBeGreaterThanOrEqual(1);
  }, 20000);

  it("route planning: tram cross-Gdańsk", async () => {
    const scenario = tricityProfile.scenarios.find(
      (s) => s.id === "tram-cross-gdansk"
    )!;
    const result = await adapter.planTrip({
      from: scenario.from.location,
      to: scenario.to.location,
    });

    expect(result.itineraries.length).toBeGreaterThanOrEqual(1);
  }, 20000);

  it("route planning: multi-operator transfer (Wrzeszcz → Gdynia)", async () => {
    const scenario = tricityProfile.scenarios.find(
      (s) => s.id === "multi-operator-transfer"
    )!;
    const result = await adapter.planTrip({
      from: scenario.from.location,
      to: scenario.to.location,
    });

    expect(result.itineraries.length).toBeGreaterThanOrEqual(1);
    // This is the scenario where Jakdojade confuses ticket types.
    // We should be able to return itineraries that cross operator boundaries.
    const first = result.itineraries[0];
    expect(first.durationSeconds).toBeLessThan(3600);
  }, 20000);

  it("nearby stops: Gdańsk Główny area", async () => {
    const station = tricityProfile.landmarks.find(
      (l) => l.name === "Gdańsk Główny"
    )!;
    const stops = await adapter.getNearbyStops(station.location, 500);
    expect(stops.length).toBeGreaterThan(0);
  }, 15000);

  it("full city harness completes without critical errors", async () => {
    const result = await runCityHarness(adapter, tricityProfile);

    expect(result.cityId).toBe("tricity");
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
