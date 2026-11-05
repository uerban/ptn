// Runnable contract test for temporal_baseline.mjs.  It builds a disposable
// web package so CI does not need a developer's locally generated pkg-web.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const script = join(here, "temporal_baseline.mjs");
const tinyPtb = join(repoRoot, "packages/shared/src/ptb/__fixtures__/tiny.ptb");
const tempDir = mkdtempSync(join(tmpdir(), "pt-wasm-temporal-baseline-"));
const pkgDir = join(tempDir, "pkg-web");
const suppliedPkg = process.env.PT_WASM_BASELINE_TEST_PKG;
const suppliedObjective = process.env.PT_WASM_BASELINE_TEST_OBJECTIVE;
const pkgPath = suppliedPkg ? resolve(suppliedPkg) : join(pkgDir, "pt_wasm.js");
const tuplesPath = join(tempDir, "tiny-tuples.json");
const badHashTuplesPath = join(tempDir, "tiny-tuples-bad-hash.json");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const tinyPtbSha256 = sha256(readFileSync(tinyPtb));

const tinyTuple = {
  entryStops: [{ stopId: "S1", walkSecs: 0 }],
  exitStops: [{ stopId: "S3", walkSecs: 0 }],
  date: "20260505",
  departureSecs: 28800,
};

writeFileSync(
  tuplesPath,
  `${JSON.stringify({ ptbSha256: tinyPtbSha256, tuples: [tinyTuple] })}\n`,
);
writeFileSync(
  badHashTuplesPath,
  `${JSON.stringify({ ptbSha256: "0".repeat(64), tuples: [tinyTuple] })}\n`,
);

before(() => {
  if (suppliedPkg) return;
  try {
    execFileSync(
      "wasm-pack",
      ["build", "--release", "--target", "web", "--out-dir", pkgDir],
      { cwd: join(repoRoot, "crates/pt-wasm"), stdio: "pipe" },
    );
  } catch (error) {
    const stdout = error.stdout?.toString() ?? "";
    const stderr = error.stderr?.toString() ?? "";
    throw new Error(`wasm-pack web build for temporal baseline test failed:\n${stdout}${stderr}`);
  }
});

after(() => rmSync(tempDir, { recursive: true, force: true }));

function runBaseline(queryTuples, objective = "plan") {
  const objectiveArgs = ["--objective", objective];
  if (objective !== "plan") {
    objectiveArgs.push("--window-start", "25000", "--window-end", "30000");
  }
  return spawnSync(
    process.execPath,
    [
      script,
      "--pkg", pkgPath,
      "--ptb", tinyPtb,
      "--query-tuples", queryTuples,
      "--iterations", "2",
      "--warmup", "0",
      "--pattern-mode", "covering-merge",
      ...objectiveArgs,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

test("temporal baseline emits one matched tiny tuple as machine JSON", {
  skip: suppliedObjective !== undefined,
}, () => {
  const result = runBaseline(tuplesPath);
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.patternMode, "covering-merge");
  assert.equal(report.objective, "plan");
  assert.equal(report.input.ptb.sha256, tinyPtbSha256);
  assert.equal(report.input.queryTuples.ptbSha256, tinyPtbSha256);
  assert.equal(report.tuples.length, 1);
  assert.equal(report.tuples[0].resultCount > 0, true);
  assert.equal(report.tuples[0].p50Ms >= 0, true);
  assert.equal(report.tuples[0].p95Ms >= report.tuples[0].p50Ms, true);
  assert.equal(report.initialization.wasmMs >= 0, true);
  assert.equal(report.initialization.routerMs >= 0, true);
  assert.equal(report.artifact.wasm.sha256.length, 64);
  assert.equal(report.artifact.glue.sha256.length, 64);
  for (const artifact of [report.artifact.wasm, report.artifact.glue]) {
    assert.equal(artifact.rawBytes > 0, true);
    assert.equal(artifact.gzip9Bytes > 0, true);
    assert.equal(artifact.brotli11Bytes > 0, true);
  }
  assert.equal(typeof report.runtime.arch, "string");
  assert.equal(typeof report.runtime.cpu.model, "string");
});

test("temporal baseline rejects a tuple manifest pinned to another PTB", () => {
  const result = runBaseline(badHashTuplesPath);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /ptbSha256.*does not match/i);
});

test("plan baseline rejects a temporal-direct artifact", {
  skip: suppliedObjective === undefined,
}, () => {
  const result = runBaseline(tuplesPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a production pt-wasm artifact/);
});

test("temporal baseline benchmarks a feature-gated direct objective", {
  skip: suppliedObjective === undefined,
}, () => {
  assert.match(suppliedObjective, /^(r3|m4)$/);
  const result = runBaseline(tuplesPath, suppliedObjective);
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  assert.equal(report.objective, suppliedObjective);
  assert.equal(report.input.windowStart, 25000);
  assert.equal(report.input.windowEnd, 30000);
  assert.equal(report.tuples[0].resultCount > 0, true);

  const mismatched = runBaseline(tuplesPath, suppliedObjective === "r3" ? "m4" : "r3");
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /does not match temporal-direct artifact/);
});
