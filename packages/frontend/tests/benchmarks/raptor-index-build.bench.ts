// This synthetic bench measures the patterns-ON SCAN delta: the fixture fans
// a route out into `patternsPerRoute` distinct served-stop-index variants;
// under PatternMode.Unbounded the index's patterns[]/patternsAtStop CSR fans
// out past the GTFS-route count, so each build (and each scan, in
// raptor-search.bench.ts) does proportionally more work — the regression the
// bench exists to catch.
import { bench, describe } from "vitest";
import { PatternMode } from "@pt/shared";
import { hydrate, rawFromBundle } from "../../src/services/raptorIndex.ts";
import {
  generateSyntheticGtfs,
  syntheticToBundleWire,
  PATTERN_FANOUT_SCALE,
} from "./fixtures/synthetic-gtfs.ts";

// p99 of 10 samples = max, so the metric is single-worst-sample sensitive.
// Budget 75ms keeps headroom over the measured baseline. Keep in sync with
// scripts/check-bench-budgets.mjs key
// "hydrate patterns-ON index at pattern-fanout scale". Bench purpose: catch
// algorithmic regressions (accidental O(n²)) in the patterns-ON index build
// over the per-pattern wire, not absolute browser-runtime truth.
const BUDGET_MS = 75;

// Build the per-pattern WIRE once. The legacy Dexie path (db.gtfsRoutes
// PK=route_id) can't hold same-id pattern variants, so the patterns-ON code
// path is reachable ONLY via the wire → rawFromBundle → hydrate(...,
// Unbounded) seam. We deliberately do NOT seed Dexie here: buildRaptorIndex's
// blob/legacy paths are single-pattern and would never populate patternsAtStop.
const gtfs = generateSyntheticGtfs(PATTERN_FANOUT_SCALE);
const wire = syntheticToBundleWire(gtfs, PatternMode.Unbounded);

// Sanity check: the index MUST carry a populated patternsAtStop (else the
// bench silently measures the Off path and the SCAN delta is invisible).
// Also assert the fan-out actually happened — patterns must outnumber the
// GTFS routes by ~patternsPerRoute.
const sampleIndex = hydrate(rawFromBundle(wire, PatternMode.Unbounded), undefined, PatternMode.Unbounded);
if (!sampleIndex.patternsAtStop || sampleIndex.patternsAtStop.size === 0) {
  throw new Error(
    `buildRaptorIndex bench setup: patternsAtStop is empty — the patterns-ON path did not run, bench would measure the legacy Off path`,
  );
}
if (!sampleIndex.patterns || sampleIndex.patterns.length <= sampleIndex.routes.length) {
  throw new Error(
    `buildRaptorIndex bench setup: patterns (${sampleIndex.patterns?.length}) did not fan out past routes (${sampleIndex.routes.length}) — patternsPerRoute fan-out missing`,
  );
}
const expectedPatterns = PATTERN_FANOUT_SCALE.routes * (PATTERN_FANOUT_SCALE.patternsPerRoute ?? 1);
if (sampleIndex.patterns.length < expectedPatterns) {
  throw new Error(
    `buildRaptorIndex bench setup: produced ${sampleIndex.patterns.length} patterns vs expected ${expectedPatterns} (routes×patternsPerRoute) — variant fan-out understated`,
  );
}

describe("hydrate patterns-ON index", () => {
  bench(
    `hydrate patterns-ON index at pattern-fanout scale (budget ${BUDGET_MS}ms)`,
    () => {
      // Build the patterns-ON index from the wire. Includes rawFromBundle
      // (wire → flat records) + the production hydrate() grouping/CSR code
      // (buildPatternAtStop + aggregateDisplay), so the bench tracks the
      // shipped index build over the per-pattern wire.
      hydrate(rawFromBundle(wire, PatternMode.Unbounded), undefined, PatternMode.Unbounded);
    },
    { iterations: 10, warmupIterations: 2 },
  );
});
