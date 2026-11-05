/**
 * CPU-phase micro-benchmark for Backend CPU Finalize plan verification.
 *
 * Not part of CI. Run locally against a real GTFS feed (set BENCH_GTFS_URL).
 *
 *   BENCH_GTFS_URL=https://eu.ftp.opendatasoft.com/stif/GTFS/IDFM-gtfs.zip \
 *     pnpm tsx packages/backend/src/gtfs/__bench__/cpuPhases.ts
 *
 * Reports swap() time, three iterations of getActiveRoutesByStop
 * (first-call = uncached, subsequent = cache hit), three iterations of
 * getDepartures on a high-traffic stop, and three iterations of getAllStops.
 */
import { performance } from "node:perf_hooks";
import { GtfsStore } from "../store.js";
import { loadGtfs } from "../loader.js";

async function main(): Promise<void> {
  const url = process.env.BENCH_GTFS_URL;
  if (!url) {
    throw new Error(
      "Set BENCH_GTFS_URL (e.g. https://eu.ftp.opendatasoft.com/stif/GTFS/IDFM-gtfs.zip)",
    );
  }

  console.log(`[bench] Loading GTFS from ${url} ...`);
  const loadStart = performance.now();
  const loaded = await loadGtfs([url]);
  const loadMs = performance.now() - loadStart;
  if (!loaded) throw new Error("loadGtfs returned null — no feed data");
  console.log(`[bench] loadGtfs: ${loadMs.toFixed(0)} ms`);

  const store = new GtfsStore();
  const swapStart = performance.now();
  store.swap(loaded.indexes, loaded.canonical, loaded.routingInput);
  const swapMs = performance.now() - swapStart;
  console.log(`[bench] swap(): ${swapMs.toFixed(0)} ms`);

  const date = new Date();

  console.log("[bench] getActiveRoutesByStop (first=uncached, subsequent=cache hit):");
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const result = store.getActiveRoutesByStop(date, 2);
    const dur = performance.now() - t;
    console.log(`  #${i}: ${dur.toFixed(1)} ms, ${result.size} stops`);
  }

  // Find a stop that actually has some stop-times for a realistic measurement.
  // Iterate until one with > 100 entries is found (fallback: first stop).
  // Uses the columnar CompactStopTimes layout — entry count is tripIdIdx.length.
  let benchStopId: string | null = null;
  loaded.canonical.iterCompactStopTimes((stopId, ct) => {
    if (benchStopId !== null) return;
    if (ct.tripIdIdx.length > 100) { benchStopId = stopId; }
  });
  if (benchStopId === null) {
    loaded.canonical.iterStops((stopId) => {
      benchStopId ??= stopId;
    });
  }
  if (!benchStopId) throw new Error("No stops in loaded indexes");

  console.log(`[bench] getDepartures("${benchStopId}") (window=2h):`);
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const result = store.getDepartures(benchStopId, date, 50, 2);
    const dur = performance.now() - t;
    console.log(`  #${i}: ${dur.toFixed(2)} ms, ${result.length} departures`);
  }

  console.log("[bench] getAllStops (first=miss, subsequent=cache hit):");
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const result = store.getAllStops();
    const dur = performance.now() - t;
    console.log(`  #${i}: ${dur.toFixed(1)} ms, ${result.length} stops`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
