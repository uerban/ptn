import { describe, it, expect } from "vitest";
import { benchmarkAdapters, formatBenchmarkResults } from "../../src/adapters/benchmark.js";
import type { RoutingAdapter, TripQuery, TripResult } from "@pt/shared";

/** Fake adapter for unit testing without network */
function createFakeAdapter(
  name: string,
  delay: number,
  resultCount: number
): RoutingAdapter {
  return {
    name,
    async planTrip(_query: TripQuery): Promise<TripResult> {
      await new Promise((r) => setTimeout(r, delay));
      return {
        itineraries: Array.from({ length: resultCount }, () => ({
          legs: [],
          departureTime: new Date().toISOString(),
          arrivalTime: new Date().toISOString(),
          durationSeconds: 600,
          transfers: 0,
          walkingDistanceMeters: 200,
        })),
      };
    },
    async getNearbyStops() { return []; },
    async getDepartures() { return []; },
    async searchStops() { return []; },
    async getAlerts() { return []; },
    async healthCheck() { return true; },
  };
}

describe("benchmarkAdapters", () => {
  it("benchmarks multiple adapters and returns results", async () => {
    const adapters = [
      createFakeAdapter("fast-engine", 10, 3),
      createFakeAdapter("slow-engine", 50, 2),
    ];
    const queries = [
      {
        from: { lat: 52.525, lon: 13.369 },
        to: { lat: 52.5219, lon: 13.4132 },
      },
    ];

    const results = await benchmarkAdapters(adapters, queries);
    expect(results.length).toBe(2);

    const fast = results.find((r) => r.adapterName === "fast-engine")!;
    const slow = results.find((r) => r.adapterName === "slow-engine")!;

    expect(fast.itineraryCount).toBe(3);
    expect(slow.itineraryCount).toBe(2);
    expect(fast.error).toBeUndefined();
    expect(slow.error).toBeUndefined();
  });

  it("captures errors from failing adapters", async () => {
    const failing: RoutingAdapter = {
      name: "broken",
      async planTrip() { throw new Error("Connection refused"); },
      async getNearbyStops() { return []; },
      async getDepartures() { return []; },
      async searchStops() { return []; },
      async getAlerts() { return []; },
      async healthCheck() { return false; },
    };

    const results = await benchmarkAdapters([failing], [
      { from: { lat: 0, lon: 0 }, to: { lat: 1, lon: 1 } },
    ]);

    expect(results.length).toBe(1);
    expect(results[0].itineraryCount).toBe(0);
    expect(results[0].error).toBe("Connection refused");
  });

  it("formatBenchmarkResults produces readable output", () => {
    const results = [
      {
        adapterName: "motis",
        query: { from: { lat: 52.5, lon: 13.4 }, to: { lat: 52.52, lon: 13.41 } },
        responseTimeMs: 120,
        itineraryCount: 5,
      },
      {
        adapterName: "otp",
        query: { from: { lat: 52.5, lon: 13.4 }, to: { lat: 52.52, lon: 13.41 } },
        responseTimeMs: 350,
        itineraryCount: 3,
        error: "Timeout",
      },
    ];

    const output = formatBenchmarkResults(results);
    expect(output).toContain("motis");
    expect(output).toContain("otp");
    expect(output).toContain("OK");
    expect(output).toContain("ERROR: Timeout");
    expect(output).toContain("120");
    expect(output).toContain("350");
  });
});
