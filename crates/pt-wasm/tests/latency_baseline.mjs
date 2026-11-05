// Latency baseline — Node-host decode + first-query timings.
//
// Advisory only — NOT a hard CI gate. The hard gate is P6's browser-side 4-component cold-start
// budget (`packages/frontend/e2e/core/wasm-engine-coldstart.spec.ts`, per). This script gives an
// engine-correlated baseline so future regressions in pt-core that show up wasm-side are spottable
// here before they hit the P6 hard gate.
//
// Methodology: N=30 measurements + 5 discarded warm-up iterations.
// Reports median (p50) and p95 for decode (`PtRouter::new`) and first
// query (`plan` against a pinned tuple on tiny.ptb).

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = await import("../pkg-node/pt_wasm.js");
const tinyPtb = readFileSync(
  join(here, "../../..", "packages/shared/src/ptb/__fixtures__/tiny.ptb"),
);

const SAMPLES = 30;
const WARMUP = 5;
const decodes = [];
const queries = [];

for (let i = 0; i < SAMPLES + WARMUP; i++) {
  const t0 = performance.now();
  const r = new pkg.PtRouter(tinyPtb, "off");
  const t1 = performance.now();
  r.plan({
    entryStops: [{ stopId: "S1", walkSecs: 0 }],
    exitStops: [{ stopId: "S3", walkSecs: 0 }],
    date: "20260505",
    departureSecs: 28800,
  });
  const t2 = performance.now();
  r.free();
  if (i >= WARMUP) {
    decodes.push(t1 - t0);
    queries.push(t2 - t1);
  }
}

const p = (xs, q) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length * q)];
const fmt = (x) => x.toFixed(2);

console.log(
  `pt-wasm-latency: decode p50=${fmt(p(decodes, 0.5))}ms p95=${fmt(p(decodes, 0.95))}ms; ` +
  `first-plan p50=${fmt(p(queries, 0.5))}ms p95=${fmt(p(queries, 0.95))}ms ` +
  `(N=${SAMPLES} after ${WARMUP} warm-up on tiny.ptb, advisory — hard gate is P6 e2e)`,
);
