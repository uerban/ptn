import { describe, it, expect } from "vitest";
import { MotisAdapter } from "../../src/adapters/motis.js";
import { parisProfile } from "../../src/harness/cities/paris.js";
import { runCityHarness } from "../../src/adapters/benchmark.js";

/**
 * Paris integration tests.
 *
 * These tests run live queries against the Transitous API for the
 * Paris / Ile-de-France area. They validate metro, RER, bus, and tram
 * routing via IDFM (RATP, SNCF Transilien, OPTILE).
 *
 * Run: INTEGRATION=1 pnpm --filter @pt/backend test -- paris
 *
 * What we verify:
 * - Stop search returns results for Paris stop/station names
 * - RER routing (Gare du Nord to CDG Airport)
 * - Metro cross-city routing
 * - Station-to-station connections
 * - Short central trips
 */
const integration = process.env.INTEGRATION ? describe : describe.skip;

// The airport duration bound describes daytime RER service. Omitting departAt
// asks Transitous for "now", so a midnight CI run measures night/replacement
// buses instead. Tomorrow at 10:00 UTC is 11:00/12:00 in Paris across DST and
// stays in the live feed horizon without depending on the runner's timezone.
function airportDaytimeDeparture(now = new Date()): string {
  const departure = new Date(now);
  departure.setUTCDate(departure.getUTCDate() + 1);
  departure.setUTCHours(10, 0, 0, 0);
  return departure.toISOString();
}

describe("Paris city profile", () => {
  it.each([
    ["2026-10-23T22:15:26Z", "2026-10-24T10:00:00.000Z"],
    ["2026-03-28T23:59:59Z", "2026-03-29T10:00:00.000Z"],
    ["2026-10-24T23:59:59Z", "2026-10-25T10:00:00.000Z"],
    ["2026-12-31T23:59:59Z", "2027-01-01T10:00:00.000Z"],
  ])("pins the airport check to upcoming daytime from %s", (now, expected) => {
    const clock = new Date(now);
    expect(airportDaytimeDeparture(clock)).toBe(expected);
    expect(clock.toISOString()).toBe(new Date(now).toISOString());
  });

  it("has valid profile structure", () => {
    expect(parisProfile.id).toBe("paris");
    expect(parisProfile.landmarks.length).toBeGreaterThanOrEqual(5);
    expect(parisProfile.scenarios.length).toBeGreaterThanOrEqual(4);
    expect(parisProfile.searchQueries.length).toBeGreaterThanOrEqual(3);

    // Covers the Paris metro area
    expect(parisProfile.bbox.minLat).toBeLessThan(48.8);
    expect(parisProfile.bbox.maxLat).toBeGreaterThan(49.0);

    // All landmarks within bbox
    for (const lm of parisProfile.landmarks) {
      expect(lm.location.lat).toBeGreaterThan(parisProfile.bbox.minLat);
      expect(lm.location.lat).toBeLessThan(parisProfile.bbox.maxLat);
      expect(lm.location.lon).toBeGreaterThan(parisProfile.bbox.minLon);
      expect(lm.location.lon).toBeLessThan(parisProfile.bbox.maxLon);
    }
  });

  it("scenarios have unique IDs", () => {
    const ids = parisProfile.scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes airport scenario", () => {
    const airport = parisProfile.scenarios.find(
      (s) => s.id === "gare-du-nord-to-cdg"
    );
    expect(airport).toBeDefined();
  });

  it("lists key agencies", () => {
    expect(parisProfile.agencies).toContain("RATP");
    expect(parisProfile.agencies).toContain("SNCF Transilien");
    expect(parisProfile.agencies).toContain("IDFM");
  });

  it("has metro, rail, bus, and tram modes", () => {
    expect(parisProfile.modes).toContain("METRO");
    expect(parisProfile.modes).toContain("RAIL");
    expect(parisProfile.modes).toContain("BUS");
    expect(parisProfile.modes).toContain("TRAM");
  });

  it("has GTFS feed", () => {
    expect(parisProfile.gtfsFeeds.length).toBe(1);
    expect(parisProfile.gtfsFeeds[0]).toContain("IDFM-gtfs.zip");
  });

  it("has empty GTFS-RT feeds (SIRI Lite only)", () => {
    expect(parisProfile.gtfsRtFeeds.length).toBe(0);
  });
});

integration("Paris — MOTIS integration", () => {
  const adapter = new MotisAdapter();

  it("stop search: Chatelet", async () => {
    const results = await adapter.searchStops("Chatelet", 5);
    expect(results.length).toBeGreaterThan(0);

    // Should find stops in the Paris area
    const inParis = results.some(
      (s) =>
        s.location.lat > 48.7 &&
        s.location.lat < 49.1 &&
        s.location.lon > 2.1 &&
        s.location.lon < 2.6
    );
    expect(inParis).toBe(true);
  }, 15000);

  it("stop search: Gare du Nord", async () => {
    const results = await adapter.searchStops("Gare du Nord", 5);
    expect(results.length).toBeGreaterThan(0);
  }, 15000);

  it("stop search: La Defense", async () => {
    const results = await adapter.searchStops("La Defense", 5);
    expect(results.length).toBeGreaterThan(0);
  }, 15000);

  it("route planning: Gare du Nord to CDG Airport (RER B)", async () => {
    const scenario = parisProfile.scenarios.find(
      (s) => s.id === "gare-du-nord-to-cdg"
    )!;
    const result = await adapter.planTrip({
      from: scenario.from.location,
      to: scenario.to.location,
      departAt: airportDaytimeDeparture(),
    });

    expect(result.itineraries.length).toBeGreaterThanOrEqual(1);
    const first = result.itineraries[0];
    expect(first.durationSeconds).toBeLessThan(
      scenario.maxDurationSeconds ?? 3600
    );
  }, 20000);

  it("route planning: Chatelet to La Defense (RER A / Metro 1)", async () => {
    const scenario = parisProfile.scenarios.find(
      (s) => s.id === "chatelet-to-la-defense"
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

  it("route planning: Gare du Nord to Gare de Lyon", async () => {
    const scenario = parisProfile.scenarios.find(
      (s) => s.id === "gare-du-nord-to-gare-de-lyon"
    )!;
    const result = await adapter.planTrip({
      from: scenario.from.location,
      to: scenario.to.location,
    });

    expect(result.itineraries.length).toBeGreaterThanOrEqual(1);
  }, 20000);

  it("route planning: Montparnasse to Nation (cross-city)", async () => {
    const scenario = parisProfile.scenarios.find(
      (s) => s.id === "montparnasse-to-nation"
    )!;
    const result = await adapter.planTrip({
      from: scenario.from.location,
      to: scenario.to.location,
    });

    expect(result.itineraries.length).toBeGreaterThanOrEqual(1);
  }, 20000);

  it("nearby stops: Chatelet area", async () => {
    const chatelet = parisProfile.landmarks.find(
      (l) => l.name === "Chatelet-Les Halles"
    )!;
    const stops = await adapter.getNearbyStops(chatelet.location, 500);
    expect(stops.length).toBeGreaterThan(0);
  }, 15000);

  it("full city harness completes without critical errors", async () => {
    const result = await runCityHarness(adapter, parisProfile);

    expect(result.cityId).toBe("paris");
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
