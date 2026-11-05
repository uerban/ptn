import type {
  TripQuery,
  AdapterBenchmarkResult,
  RoutingAdapter,
  CityProfile,
  CityHarnessResult,
  TransportMode,
} from "@pt/shared";

/**
 * Routing engine evaluation harness.
 * Runs the same query against multiple adapters and compares:
 * - Response time
 * - Number of itineraries returned
 * - Errors
 */
export async function benchmarkAdapters(
  adapters: RoutingAdapter[],
  queries: TripQuery[]
): Promise<AdapterBenchmarkResult[]> {
  const results: AdapterBenchmarkResult[] = [];

  for (const query of queries) {
    const promises = adapters.map(async (adapter) => {
      const start = performance.now();
      try {
        const result = await adapter.planTrip(query);
        const elapsed = Math.round(performance.now() - start);
        return {
          adapterName: adapter.name,
          query,
          responseTimeMs: elapsed,
          itineraryCount: result.itineraries.length,
        };
      } catch (err) {
        const elapsed = Math.round(performance.now() - start);
        return {
          adapterName: adapter.name,
          query,
          responseTimeMs: elapsed,
          itineraryCount: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });

    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
  }

  return results;
}

/**
 * Run the full city harness against a single adapter.
 * Exercises every adapter method against real city data:
 * health check, stop search, route planning, nearby stops, departures.
 */
export async function runCityHarness(
  adapter: RoutingAdapter,
  city: CityProfile
): Promise<CityHarnessResult> {
  const result: CityHarnessResult = {
    cityId: city.id,
    adapterName: adapter.name,
    timestamp: new Date().toISOString(),
    healthCheck: { healthy: false, responseTimeMs: 0 },
    searchResults: [],
    scenarioResults: [],
    nearbyResults: [],
    departureResults: [],
  };

  // 1. Health check
  {
    const start = performance.now();
    try {
      const healthy = await adapter.healthCheck();
      result.healthCheck = {
        healthy,
        responseTimeMs: Math.round(performance.now() - start),
      };
    } catch {
      result.healthCheck = {
        healthy: false,
        responseTimeMs: Math.round(performance.now() - start),
      };
    }
  }

  // 2. Stop search queries
  for (const query of city.searchQueries) {
    const start = performance.now();
    try {
      const stops = await adapter.searchStops(query, 10);
      result.searchResults.push({
        query,
        resultCount: stops.length,
        responseTimeMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      result.searchResults.push({
        query,
        resultCount: 0,
        responseTimeMs: Math.round(performance.now() - start),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. Route planning scenarios
  for (const scenario of city.scenarios) {
    const start = performance.now();
    try {
      const tripResult = await adapter.planTrip({
        from: scenario.from.location,
        to: scenario.to.location,
      });
      const modesFound = new Set<TransportMode>();
      for (const it of tripResult.itineraries) {
        for (const leg of it.legs) {
          modesFound.add(leg.mode);
        }
      }
      const first = tripResult.itineraries[0];
      result.scenarioResults.push({
        scenarioId: scenario.id,
        itineraryCount: tripResult.itineraries.length,
        // Reported separately, never rolled into itineraryCount — see the note
        // on the field. A scenario answered only by a walk still counts as
        // zero transit coverage, which is the honest reading.
        directCount: tripResult.direct?.length ?? 0,
        responseTimeMs: Math.round(performance.now() - start),
        modesFound: Array.from(modesFound),
        firstItinerary: first
          ? {
              durationSeconds: first.durationSeconds,
              transfers: first.transfers,
              legs: first.legs.length,
            }
          : undefined,
      });
    } catch (err) {
      result.scenarioResults.push({
        scenarioId: scenario.id,
        itineraryCount: 0,
        directCount: 0,
        responseTimeMs: Math.round(performance.now() - start),
        modesFound: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4. Nearby stops for each landmark
  for (const landmark of city.landmarks) {
    const start = performance.now();
    try {
      const stops = await adapter.getNearbyStops(landmark.location, 500);
      result.nearbyResults.push({
        landmarkName: landmark.name,
        stopCount: stops.length,
        responseTimeMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      result.nearbyResults.push({
        landmarkName: landmark.name,
        stopCount: 0,
        responseTimeMs: Math.round(performance.now() - start),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 5. Departure boards for landmarks with known stop IDs
  for (const landmark of city.landmarks) {
    if (!landmark.stopId) continue;
    const start = performance.now();
    try {
      const departures = await adapter.getDepartures(landmark.stopId, undefined, 10);
      result.departureResults.push({
        landmarkName: landmark.name,
        departureCount: departures.length,
        responseTimeMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      result.departureResults.push({
        landmarkName: landmark.name,
        departureCount: 0,
        responseTimeMs: Math.round(performance.now() - start),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

// --- Formatting ---

export function formatBenchmarkResults(
  results: AdapterBenchmarkResult[]
): string {
  const lines: string[] = ["=== Routing Engine Benchmark ===", ""];

  const byQuery = new Map<string, AdapterBenchmarkResult[]>();
  for (const r of results) {
    const key = `${r.query.from.lat},${r.query.from.lon} -> ${r.query.to.lat},${r.query.to.lon}`;
    if (!byQuery.has(key)) byQuery.set(key, []);
    byQuery.get(key)!.push(r);
  }

  for (const [queryKey, queryResults] of byQuery) {
    lines.push(`Query: ${queryKey}`);
    lines.push("-".repeat(60));
    lines.push(
      "Adapter".padEnd(15) +
        "Time (ms)".padEnd(12) +
        "Results".padEnd(10) +
        "Status"
    );

    for (const r of queryResults) {
      const status = r.error ? `ERROR: ${r.error}` : "OK";
      lines.push(
        r.adapterName.padEnd(15) +
          String(r.responseTimeMs).padEnd(12) +
          String(r.itineraryCount).padEnd(10) +
          status
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function formatCityHarnessResult(result: CityHarnessResult): string {
  const lines: string[] = [];
  const W = 72;

  lines.push("=".repeat(W));
  lines.push(
    `  City Harness: ${result.cityId} | Adapter: ${result.adapterName}`
  );
  lines.push(`  Timestamp: ${result.timestamp}`);
  lines.push("=".repeat(W));

  // Health
  lines.push("");
  lines.push(
    `Health: ${result.healthCheck.healthy ? "OK" : "FAIL"}  (${result.healthCheck.responseTimeMs} ms)`
  );

  // Search
  lines.push("");
  lines.push("--- Stop Search ---");
  lines.push(
    "Query".padEnd(30) + "Results".padEnd(10) + "Time (ms)".padEnd(12) + "Status"
  );
  for (const s of result.searchResults) {
    lines.push(
      s.query.padEnd(30) +
        String(s.resultCount).padEnd(10) +
        String(s.responseTimeMs).padEnd(12) +
        (s.error ? `ERROR: ${s.error}` : "OK")
    );
  }

  // Scenarios
  lines.push("");
  lines.push("--- Route Scenarios ---");
  lines.push(
    "Scenario".padEnd(28) +
      "Itin.".padEnd(8) +
      "Time".padEnd(10) +
      "Dur(min)".padEnd(10) +
      "Xfer".padEnd(7) +
      "Modes"
  );
  for (const s of result.scenarioResults) {
    const dur = s.firstItinerary
      ? String(Math.round(s.firstItinerary.durationSeconds / 60))
      : "-";
    const xfer = s.firstItinerary
      ? String(s.firstItinerary.transfers)
      : "-";
    lines.push(
      s.scenarioId.padEnd(28) +
        String(s.itineraryCount).padEnd(8) +
        `${s.responseTimeMs}ms`.padEnd(10) +
        dur.padEnd(10) +
        xfer.padEnd(7) +
        (s.error ? `ERROR: ${s.error}` : s.modesFound.join(","))
    );
  }

  // Nearby
  lines.push("");
  lines.push("--- Nearby Stops ---");
  lines.push(
    "Landmark".padEnd(30) + "Stops".padEnd(10) + "Time (ms)".padEnd(12) + "Status"
  );
  for (const n of result.nearbyResults) {
    lines.push(
      n.landmarkName.padEnd(30) +
        String(n.stopCount).padEnd(10) +
        String(n.responseTimeMs).padEnd(12) +
        (n.error ? `ERROR: ${n.error}` : "OK")
    );
  }

  // Departures
  if (result.departureResults.length > 0) {
    lines.push("");
    lines.push("--- Departure Boards ---");
    lines.push(
      "Landmark".padEnd(30) + "Deps".padEnd(10) + "Time (ms)".padEnd(12) + "Status"
    );
    for (const d of result.departureResults) {
      lines.push(
        d.landmarkName.padEnd(30) +
          String(d.departureCount).padEnd(10) +
          String(d.responseTimeMs).padEnd(12) +
          (d.error ? `ERROR: ${d.error}` : "OK")
      );
    }
  }

  lines.push("");
  lines.push("=".repeat(W));
  return lines.join("\n");
}
