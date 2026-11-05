import { describe, it, expect } from "vitest";
import { MotisAdapter } from "../../src/adapters/motis.js";
import { krakowProfile } from "../../src/harness/cities/krakow.js";
import { runCityHarness } from "../../src/adapters/benchmark.js";
import { walkJourney } from "./mocks.js";

/**
 * Krakow integration tests.
 *
 * These tests run live queries against the Transitous API for the
 * Krakow metropolitan area. They validate bus and tram routing
 * via MPK Krakow (managed by ZTP Krakow).
 *
 * Run: INTEGRATION=1 pnpm --filter @pt/backend test -- krakow
 *
 * What we verify:
 * - Stop search returns results for Krakow stop names
 * - Tram routing across the city (Glowny to Nowa Huta)
 * - Airport bus connection
 * - Hub-to-hub short trips
 */
const integration = process.env.INTEGRATION ? describe : describe.skip;

describe("Krakow city profile", () => {
  it("has valid profile structure", () => {
    expect(krakowProfile.id).toBe("krakow");
    expect(krakowProfile.landmarks.length).toBeGreaterThanOrEqual(5);
    expect(krakowProfile.scenarios.length).toBeGreaterThanOrEqual(4);
    expect(krakowProfile.searchQueries.length).toBeGreaterThanOrEqual(3);

    // Covers the Krakow metro area
    expect(krakowProfile.bbox.minLat).toBeLessThan(50.0);
    expect(krakowProfile.bbox.maxLat).toBeGreaterThan(50.1);

    // All landmarks within bbox
    for (const lm of krakowProfile.landmarks) {
      expect(lm.location.lat).toBeGreaterThan(krakowProfile.bbox.minLat);
      expect(lm.location.lat).toBeLessThan(krakowProfile.bbox.maxLat);
      expect(lm.location.lon).toBeGreaterThan(krakowProfile.bbox.minLon);
      expect(lm.location.lon).toBeLessThan(krakowProfile.bbox.maxLon);
    }
  });

  it("scenarios have unique IDs", () => {
    const ids = krakowProfile.scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes airport scenario", () => {
    const airport = krakowProfile.scenarios.find(
      (s) => s.id === "airport-to-center"
    );
    expect(airport).toBeDefined();
  });

  it("lists MPK Krakow as operator", () => {
    expect(krakowProfile.agencies).toContain("MPK Krakow");
  });

  it("has both bus and tram modes", () => {
    expect(krakowProfile.modes).toContain("BUS");
    expect(krakowProfile.modes).toContain("TRAM");
  });

  it("has GTFS feeds for bus, tram, and trolleybus", () => {
    expect(krakowProfile.gtfsFeeds.length).toBe(3);
    expect(krakowProfile.gtfsFeeds.some((f) => f.includes("GTFS_KRK_A"))).toBe(true);
    expect(krakowProfile.gtfsFeeds.some((f) => f.includes("GTFS_KRK_M"))).toBe(true);
    expect(krakowProfile.gtfsFeeds.some((f) => f.includes("GTFS_KRK_T"))).toBe(true);
  });

  it("has GTFS-RT feeds", () => {
    expect(krakowProfile.gtfsRtFeeds.length).toBeGreaterThanOrEqual(2);
  });
});

integration("Krakow — MOTIS integration", () => {
  const adapter = new MotisAdapter();

  it("stop search: Krakow Glowny", async () => {
    const results = await adapter.searchStops("Krakow Glowny", 5);
    expect(results.length).toBeGreaterThan(0);

    // Should find stops in the Krakow area
    const inKrakow = results.some(
      (s) =>
        s.location.lat > 50.0 &&
        s.location.lat < 50.1 &&
        s.location.lon > 19.8 &&
        s.location.lon < 20.1
    );
    expect(inKrakow).toBe(true);
  }, 15000);

  it("stop search: Rynek Glowny", async () => {
    const results = await adapter.searchStops("Rynek Glowny", 5);
    expect(results.length).toBeGreaterThan(0);
  }, 15000);

  it("stop search: Nowa Huta", async () => {
    const results = await adapter.searchStops("Nowa Huta", 5);
    expect(results.length).toBeGreaterThan(0);
  }, 15000);

  it("route planning: station to Old Town (short walk)", async () => {
    const scenario = krakowProfile.scenarios.find(
      (s) => s.id === "station-to-old-town"
    )!;
    const result = await adapter.planTrip({
      from: scenario.from.location,
      to: scenario.to.location,
    });

    // The profile declares expectModes: ["WALK"] for this pair — it is 1.1 km
    // across the city centre, and upstream answers it by walking. A transit-free
    // journey arrives under `direct`, never in `itineraries`, so asserting on
    // `itineraries` here would be asserting that a walk is a transit route.
    // `itineraries` may legitimately be empty; what must hold is that a usable
    // answer came back at all.
    const journeys = [...result.itineraries, ...(result.direct ?? [])];
    expect(journeys.length).toBeGreaterThanOrEqual(
      scenario.minItineraries ?? 1
    );

    // Bound the WALK, not the fastest journey overall.
    //
    // This previously took the minimum over `itineraries` + `direct`, which
    // made a WALK scenario's duration assertion depend on whether some transit
    // option happened to be quicker than walking at query time. That is what
    // made the nightly intermittent: the walk is 1288 s, so once the bound sat
    // below it the test passed only on nights when a train fell in the window
    // (1140 s) and failed when the best on offer was a tram (1260 s).
    //
    // The scenario declares expectModes ["WALK"], so the walk is the subject.
    // It is also the only part of the answer that is stable, which is what
    // makes a numeric bound meaningful at all.
    const walk = walkJourney(result);
    expect(
      walk,
      "expectModes is [WALK] but upstream returned no transit-free journey"
    ).toBeDefined();
    expect(walk!.durationSeconds).toBeLessThan(
      scenario.maxDurationSeconds ?? 1800
    );
  }, 20000);

  it("route planning: Krakow Glowny to Nowa Huta via tram", async () => {
    const scenario = krakowProfile.scenarios.find(
      (s) => s.id === "station-to-nowa-huta"
    )!;
    const result = await adapter.planTrip({
      from: scenario.from.location,
      to: scenario.to.location,
    });

    expect(result.itineraries.length).toBeGreaterThanOrEqual(1);

    // Should see transit legs
    const first = result.itineraries[0];
    const modes = first.legs.map((l) => l.mode);
    expect(modes.some((m) => m !== "WALK")).toBe(true);
  }, 20000);

  it("route planning: airport connection", async () => {
    const scenario = krakowProfile.scenarios.find(
      (s) => s.id === "airport-to-center"
    )!;
    const result = await adapter.planTrip({
      from: scenario.from.location,
      to: scenario.to.location,
    });

    expect(result.itineraries.length).toBeGreaterThanOrEqual(1);
  }, 20000);

  it("route planning: Bronowice to Kurdwanow (tram cross-city)", async () => {
    const scenario = krakowProfile.scenarios.find(
      (s) => s.id === "tram-north-south"
    )!;
    const result = await adapter.planTrip({
      from: scenario.from.location,
      to: scenario.to.location,
    });

    expect(result.itineraries.length).toBeGreaterThanOrEqual(1);
  }, 20000);

  it("nearby stops: Krakow Glowny area", async () => {
    const station = krakowProfile.landmarks.find(
      (l) => l.name === "Krakow Glowny"
    )!;
    const stops = await adapter.getNearbyStops(station.location, 500);
    expect(stops.length).toBeGreaterThan(0);
  }, 15000);

  it("full city harness completes without critical errors", async () => {
    const result = await runCityHarness(adapter, krakowProfile);

    expect(result.cityId).toBe("krakow");
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
