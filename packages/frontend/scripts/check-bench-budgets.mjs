#!/usr/bin/env node
// Post-processes the JSON output of `vitest bench` and fails the CI run if
// any benchmark's measured metric exceeds its budget. Budgets are matched
// against bench names — keep the keys here in sync with the `bench(name,...)`
// calls in tests/benchmarks/*.bench.ts.
//
// Silent-failure invariants this script must preserve:
//   (a) NaN must never be treated as "within budget" (typeof NaN === "number")
//   (b) every budget key must be matched by exactly one benchmark
//   (c) if vitest's JSON shape drifts and no benchmarks are found, fail loud
//   (d) double-matches (two benchmarks both matching one budget key) must fail

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const RESULTS_PATH = "tests/benchmarks/.results.json";

// The bench exercises the PatternMode.Unbounded SCAN path: the synthetic
// fixture (PATTERN_FANOUT_SCALE = GDANSK_SCALE × patternsPerRoute:4) fans each
// GTFS route into 4 distinct served-stop-index variants, so the index's
// patterns[]/patternsAtStop CSR fans out to ~4× the route count and every
// RAPTOR round scans ~4× more route objects. The bench is driven through the
// per-pattern WIRE (syntheticToBundleWire → rawFromBundle → hydrate(...,
// Unbounded)) because the legacy Dexie tables (PK=route_id) can't hold
// same-id pattern variants. 75 ms preserves headroom over the measured p99
// (single-worst-sample of 10). Keep in sync with BUDGET_MS in
// tests/benchmarks/raptor-index-build.bench.ts.
//
// Search-time routing performance is NOT benched here: the on-device engine is
// `pt-wasm`/`pt-core`, whose latency baseline lives in
// `crates/pt-wasm/tests/latency_baseline.mjs` and whose cold-start budget is
// the browser e2e (`e2e/core/wasm-engine-coldstart.spec.ts`). What remains here
// is the host-side index build the engine is fed from.
const BUDGETS_MS = {
  "hydrate patterns-ON index at pattern-fanout scale": 75,
};

/** Which numeric field of each benchmark to compare against its budget. */
const METRIC_FOR = {
  "hydrate patterns-ON index at pattern-fanout scale": "p99",
};

if (!existsSync(RESULTS_PATH)) {
  console.error(`No benchmark results at ${RESULTS_PATH} — did 'vitest bench --run' succeed?`);
  process.exit(1);
}

const raw = JSON.parse(await readFile(RESULTS_PATH, "utf8"));

const failures = [];
const checked = [];

// Vitest bench JSON: files[].groups[].benchmarks[] — each benchmark has
// `mean`, `p99`, `p95`, etc. as top-level numeric properties (all in ms).
for (const file of raw.files ?? []) {
  for (const group of file.groups ?? []) {
    for (const b of group.benchmarks ?? []) {
      if (typeof b.name !== "string") {
        failures.push(`Unnamed benchmark in ${file.filepath ?? "(unknown file)"} — refusing to evaluate budgets against unidentifiable data`);
        continue;
      }
      const matches = Object.keys(BUDGETS_MS).filter((key) => b.name.includes(key));
      if (matches.length === 0) continue;
      if (matches.length > 1) {
        failures.push(`Benchmark "${b.name}" matches multiple budget keys: ${matches.join(", ")} — tighten the keys`);
        continue;
      }
      const key = matches[0];
      const budget = BUDGETS_MS[key];
      const metricName = METRIC_FOR[key];
      const metric = b[metricName];
      checked.push({ key, metricName, metric, budget });
      if (typeof metric !== "number" || !Number.isFinite(metric)) {
        failures.push(`${key}: ${metricName} is not a finite number (got ${JSON.stringify({ mean: b.mean, p99: b.p99, p95: b.p95 })})`);
      } else if (metric > budget) {
        failures.push(`${key}: ${metricName}=${metric.toFixed(2)}ms > budget ${budget}ms`);
      }
    }
  }
}

// Fail loudly if a budget key has no matching benchmark — protects against
// someone renaming one bench while leaving another intact (silent partial drift).
const matchedKeys = new Set(checked.map((c) => c.key));
for (const key of Object.keys(BUDGETS_MS)) {
  if (checked.filter(row => row.key === key).length > 1) failures.push(`Duplicate results for budget key: ${key}`);
}
const missing = Object.keys(BUDGETS_MS).filter((k) => !matchedKeys.has(k));
if (missing.length) {
  failures.push(`No benchmark found for budget key(s): ${missing.join(", ")} — bench name may have drifted or the JSON shape changed`);
}

for (const { key, metricName, metric, budget } of checked) {
  const ok = typeof metric === "number" && Number.isFinite(metric) && metric <= budget;
  const display = typeof metric === "number" && Number.isFinite(metric) ? `${metric.toFixed(2)}ms` : "n/a";
  console.log(`  ${ok ? "✅" : "❌"} ${key} (${metricName}): ${display} / ${budget}ms`);
}

if (failures.length) {
  console.error("\nPerformance budget check failed:");
  for (const f of failures) console.error("  ❌", f);
  process.exit(1);
}

console.log("\n✅ All performance budgets within limits");
