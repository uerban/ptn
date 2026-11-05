/**
 * GTFS index build memory benchmark.
 *
 * Runs loadGtfs against a local GTFS zip and prints a per-phase peak-heap
 * profile so memory-optimization PRs can target the right phase.
 *
 * Usage:
 *   pnpm exec tsx --expose-gc src/gtfs/memory-bench.ts /path/to/gtfs.zip
 *
 * Mode-C (heap snapshots per phase):
 *   SNAPSHOT_DIR=/tmp/ptn-heap pnpm exec tsx --expose-gc \
 *     src/gtfs/memory-bench.ts /path/to/gtfs.zip
 *   (directory must exist; tracker surfaces per-phase errors via
 *   PhaseReport.snapshotError otherwise)
 */
import { loadGtfs } from "./loader.js";
import { createPhaseTracker, type PhaseReport, type PhaseTracker } from "./phaseTracker.js";

const MB = 1024 * 1024;

function printReport(report: readonly PhaseReport[]): void {
  console.table(
    report.map((p) => ({
      phase: p.name,
      duration_s: (p.durationMs / 1000).toFixed(1),
      // heapUsed is the live object graph — useful but NOT what V8 enforces the limit against.
      heap_used_MB: (p.peakHeapUsedBytes / MB).toFixed(0),
      // heapTotal is V8's committed heap — races against --max-old-space-size as the app allocates.
      heap_total_MB: (p.peakHeapTotalBytes / MB).toFixed(0),
      // external includes ArrayBuffer backing (Uint32Array, etc.); counts against the V8 limit too.
      external_MB: (p.peakExternalBytes / MB).toFixed(0),
      // v8_limit_approx_MB = heapTotal + external — the sum V8 compares to max-old-space-size.
      v8_limit_approx_MB: ((p.peakHeapTotalBytes + p.peakExternalBytes) / MB).toFixed(0),
      rss_MB: (p.peakRssBytes / MB).toFixed(0),
      snapshot: p.snapshotPath ?? (p.snapshotError ? `ERR: ${p.snapshotError}` : ""),
    })),
  );
}

async function main(): Promise<void> {
  const zipPath = process.argv[2];
  if (!zipPath) {
    console.error("Usage: memory-bench.ts <path-to-gtfs.zip>");
    process.exit(1);
  }

  const snapshotDir = process.env.SNAPSHOT_DIR;
  const tracker: PhaseTracker = createPhaseTracker({
    sampleIntervalMs: 50,
    ...(snapshotDir ? { snapshotDir } : {}),
  });

  try {
    const t0 = Date.now();
    const result = await loadGtfs([`file://${zipPath}`], undefined, 0, tracker);
    const totalS = ((Date.now() - t0) / 1000).toFixed(1);

    if (!result) {
      console.log("loadGtfs returned null (304 Not Modified — cannot happen on first load)");
      return;
    }

    printReport(tracker.getReport());

    const { canonical } = result;
    let stopTimeEntries = 0;
    canonical.iterCompactStopTimes((_stopId, ct) => { stopTimeEntries += ct.tripIdIdx.length; });

    let routeCount = 0;
    canonical.iterRoutes(() => { routeCount++; });
    let tripCount = 0;
    canonical.iterTrips(() => { tripCount++; });

    console.log(
      `stops=${canonical.stopCount} routes=${routeCount} trips=${tripCount}`,
    );
    console.log(`stopTimes entries=${stopTimeEntries}`);
    console.log(`elapsed=${totalS}s`);
  } catch (err) {
    // Surface whatever phases completed before the crash — diagnosing a mid-
    // build OOM is much easier when you can see which phase was executing.
    // tracker.getReport() implicitly closes the in-flight phase.
    const partial = tracker.getReport();
    if (partial.length > 0) {
      console.error("Partial phase report before crash:");
      printReport(partial);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
