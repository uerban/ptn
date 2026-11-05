// H62: test real thrown WASM Errors, including their structured metadata.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { test } from "node:test";

const glue = process.env.PT_WASM_DEADLINE_PKG
  ?? fileURLToPath(new URL("../pkg-deadline/pt_wasm.js", import.meta.url));
const pkg = await import(pathToFileURL(resolve(glue)).href);
pkg.initSync({ module: readFileSync(glue.replace(/\.js$/, "_bg.wasm")) });
const bytes = readFileSync(new URL("../../../packages/shared/src/ptb/__fixtures__/tiny-v2.ptb", import.meta.url));
const query = { date: "20260507", departureSecs: 0, maxRounds: 4,
  entryStops: [{ stopId: "S3", walkSecs: 20 }], exitStops: [{ stopId: "S4", walkSecs: 40 }] };
const options = { windowStart: 0, windowEnd: 86401, arrivalDeadline: 86400,
  objective: "m4", validation: "session", catalogue: "fresh", lookup: "lazy-cached",
  traversal: "arrival-first", witnessComparison: "materialized-date-memo", frontierStorage: "event-indexed",
  prefixBound: true, pointBound: true, prefixCertificate: "timetable", prefixSetup: "prepared",
  maxSegments: 250000, maxFrontierWidth: 64, maxStopScans: 10000000, maxLookupWork: 10000000 };

for (const [field, tag] of [["maxLookupWork", "lookup-work"], ["maxStopScans", "stop-scans"], ["maxSegments", "segments"]]) {
  test(`real ${field} exhaustion carries the typed resource tag`, () => {
    const owner = pkg.TemporalDeadlineProbe.withImmutableBinding(bytes, new Uint8Array(), "covering-merge");
    try {
      assert.throws(() => {
        owner.prepare(query, { ...options, [field]: 1 });
        owner.run_winner_journeys("portfolio", "row-prefix");
      }, (error) => error instanceof Error && error.ptnResourceLimit === tag);
    } finally { owner.free(); }
  });
}

test("invalid requests carry no resource tag, even after a resource failure", () => {
  const owner = pkg.TemporalDeadlineProbe.withImmutableBinding(bytes, new Uint8Array(), "covering-merge");
  try {
    assert.throws(() => {
      owner.prepare(query, { ...options, maxStopScans: 1 });
      owner.run_winner_journeys("portfolio", "row-prefix");
    });
    assert.throws(() => owner.prepare({ ...query, date: "bad" }, options),
      (error) => error instanceof Error && error.ptnResourceLimit === undefined);
    assert.throws(() => owner.run_winner_journeys("portfolio", "row-prefix"),
      (error) => error instanceof Error && error.ptnResourceLimit === undefined);
    owner.prepare(query, options);
    const result = owner.run_winner_journeys("portfolio", "row-prefix");
    assert.equal(result.complete, true);
  } finally { owner.free(); }
});
