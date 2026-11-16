// Runnable contract test for temporal_baseline.mjs.  It builds a disposable
// web package so CI does not need a developer's locally generated pkg-web.

import {readArtifact} from "./baseline_store.mjs";
import {diffBaselines} from "./baseline_diff.mjs";
import { replayBaseline } from "./baseline_restore.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function runBaseline(queryTuples, objective = "plan", extraArgs = [], packagePath = pkgPath, ptbPath = tinyPtb) {
  const objectiveArgs = ["--objective", objective];
  if (objective !== "plan") {
    objectiveArgs.push("--window-start", "25000", "--window-end", "30000");
  }
  return spawnSync(
    process.execPath,
    [
      script,
      "--pkg", packagePath,
      "--ptb", ptbPath,
      "--query-tuples", queryTuples,
      "--iterations", "2",
      "--warmup", "0",
      "--pattern-mode", "covering-merge",
      ...objectiveArgs,
      ...extraArgs,
    ],
    { cwd: repoRoot, encoding: "utf8", timeout: 20_000 },
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
  assert.equal(report.tuples[0].candidates.length, report.tuples[0].resultCount);
  assert.equal(report.tuples[0].capture.truncated, false);
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


test("optional capture retains artifacts and refuses run replacement", {
  skip: suppliedObjective !== undefined,
}, () => {
  const store = join(tempDir, "captures");
  const args = ["--capture-store", store, "--run-id", "baseline"];
  const first = runBaseline(tuplesPath, "plan", args);
  assert.equal(first.status, 0, first.stderr);
  const record = JSON.parse(readFileSync(join(store, "runs", "baseline.json")));
  assert.equal(record.classification, "partial capture");
  assert.equal(record.replayVerification, "unverified");
  assert.equal(Object.keys(record.artifacts).length, 4);
  const restored = join(tempDir, "restored");
  const verification = replayBaseline(store, "baseline", restored);
  assert.equal(verification.replayVerified, true);
  assert.throws(() => replayBaseline(store, "baseline", restored), /EEXIST/);
  for (const digest of Object.values(record.artifacts)) {
    assert.equal(sha256(readFileSync(join(store, "artifacts", digest))), digest);
  }
  const second = runBaseline(tuplesPath, "plan", args);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /EEXIST/);
  assert.deepEqual(JSON.parse(readFileSync(join(store, "runs", "baseline.json"))), record);
});


test("empty engine result is successful and replayable", {
  skip: suppliedObjective !== undefined,
}, () => {
  const emptyTuples = join(tempDir, "empty-tuples.json");
  writeFileSync(emptyTuples, JSON.stringify({ ptbSha256: tinyPtbSha256, tuples: [{ ...tinyTuple, date: "20300101" }] }));
  const store = join(tempDir, "empty-captures");
  const result = runBaseline(emptyTuples, "plan", ["--capture-store", store, "--run-id", "empty"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.completion, "success");
  assert.deepEqual(report.tuples[0].candidates, []);
  assert.equal(replayBaseline(store, "empty", join(tempDir, "empty-restored")).replayVerified, true);
});


test("planner failure is retained as error and never empty success", () => {
  const fakePkg = join(tempDir, "failing.mjs");
  writeFileSync(fakePkg, 'export function initSync() {} export class PtRouter { plan() { throw new Error("fixture planner failure"); } free() {} }');
  writeFileSync(join(tempDir, "pt_wasm_bg.wasm"), "fixture");
  const store = join(tempDir, "failure-captures");
  const result = runBaseline(tuplesPath, "plan", ["--capture-store", store, "--run-id", "failed"], fakePkg);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.completion, "error");
  assert.match(report.error.message, /fixture planner failure/);
  const record = JSON.parse(readFileSync(join(store, "runs", "failed.json")));
  assert.equal(record.completion, "error");
  assert.throws(() => replayBaseline(store, "failed", join(tempDir, "failed-restored")), /Unsupported/);
});

for (const [id, stage, source] of [
  ["module", "module import", 'throw new Error("fixture module failure");'],
  ["wasm", "wasm initialization", 'export function initSync(){throw new Error("fixture wasm failure");} export class PtRouter {}'],
  ["router", "router initialization", 'export function initSync(){} export class PtRouter {constructor(){throw new Error("fixture router failure");}}'],
  ["contract", "artifact contract", 'export function initSync(){} export class PtRouter {temporalDirectObjective(){return "r3";} free(){throw new Error("fixture cleanup failure");}}'],
  ["cleanup", "router cleanup", 'export function initSync(){} export class PtRouter {plan(){return [];} free(){throw new Error("fixture cleanup failure");}}'],
]) {
  test(`${stage} failure retains available inputs and is not empty success`, () => {
    const fakePkg = join(tempDir, `${id}-failure.mjs`);
    writeFileSync(fakePkg, source);
    writeFileSync(join(tempDir, "pt_wasm_bg.wasm"), "fixture");
    const store = join(tempDir, `${id}-captures`);
    const result = runBaseline(tuplesPath, "plan", ["--capture-store", store, "--run-id", "failure"], fakePkg);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.completion, "error");
    assert.equal(report.error.stage, stage);
    assert.equal(report.error.tupleIndex, undefined);
    if (stage !== "router cleanup") assert.deepEqual(report.tuples, []);
    if (stage === "module import" || stage === "wasm initialization") assert.equal(report.initialization.wasmMs, null);
    if (stage === "router initialization") assert.equal(report.initialization.routerMs, null);
    if (stage === "artifact contract") assert.equal(report.error.cleanupError, "fixture cleanup failure");
    const record = JSON.parse(readFileSync(join(store, "runs", "failure.json")));
    assert.equal(record.completion, "error");
    assert.equal(record.artifacts.glue, sha256(Buffer.from(source)));
    assert.equal(record.artifacts.ptb, tinyPtbSha256);
    assert.equal(record.report.error.stage, stage);
  });
}

for (const name of ["ptb", "queryTuples", "glue", "wasm"]) {
  test(`unread ${name} retains other readable input bytes as a failed attempt`, () => {
    const dir = join(tempDir, `missing-${name}`);
    // Missing engine paths live in their own directory, including the fixed
    // sibling WASM filename; do not affect other fixtures.
    mkdirSync(dir);
    const paths = {ptb: join(dir,"input.ptb"), queryTuples: join(dir,"queries.json"), glue: join(dir,"engine.mjs"), wasm: join(dir,"pt_wasm_bg.wasm")};
    const inputs = {ptb: readFileSync(tinyPtb), queryTuples: readFileSync(tuplesPath), glue: Buffer.from("export function initSync(){} export class PtRouter {}"), wasm: Buffer.from("fixture")};
    for (const [key, path] of Object.entries(paths)) if (key !== name) writeFileSync(path, inputs[key]);
    const store = join(dir, "store");
    const result = runBaseline(paths.queryTuples, "plan", ["--capture-store", store, "--run-id", "failed"], paths.glue, paths.ptb);
    assert.equal(result.status, 1);
    const record = JSON.parse(readFileSync(join(store,"runs","failed.json")));
    assert.equal(record.report.error.stage, "input reading");
    assert.deepEqual(record.report.tuples, []);
    assert.equal(record.artifacts[name], undefined);
    assert.ok(record.missingDependencies.includes(`unread input: ${name}`));
    for (const key of Object.keys(inputs).filter(key => key !== name)) assert.equal(record.artifacts[key], sha256(inputs[key]));
    assert.equal(record.completion, "error");
  });
}

test("invalid query bytes are retained rather than reinterpreted as empty", () => {
  const queryPath = join(tempDir, "malformed.json");
  writeFileSync(queryPath, "{broken");
  const store = join(tempDir, "invalid-query-store");
  const result = runBaseline(queryPath, "plan", ["--capture-store", store, "--run-id", "failed"]);
  assert.equal(result.status, 1);
  const record = JSON.parse(readFileSync(join(store,"runs","failed.json")));
  assert.equal(record.report.error.stage, "query validation");
  assert.equal(record.artifacts.queryTuples, sha256(Buffer.from("{broken")));
  assert.equal(record.completion, "error");
});

test("retains the query bytes consumed even if the source path changes during planning", () => {
  const queryPath = join(tempDir, "changing-queries.json");
  const original = readFileSync(tuplesPath);
  writeFileSync(queryPath, original);
  const fakePkg = join(tempDir, "query-mutator.mjs");
  writeFileSync(fakePkg, `import {writeFileSync} from "node:fs"; export function initSync(){} export class PtRouter {plan(){writeFileSync(${JSON.stringify(queryPath)}, "replaced after input parsing"); return [];} free(){}}`);
  writeFileSync(join(tempDir, "pt_wasm_bg.wasm"), "fixture");
  const store = join(tempDir, "query-snapshot-store");
  const result = runBaseline(queryPath, "plan", ["--capture-store", store, "--run-id", "snapshot"], fakePkg);
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(readFileSync(join(store,"runs","snapshot.json")));
  assert.equal(record.artifacts.queryTuples, sha256(original));
  assert.equal(record.report.input.queryTuples.sha256, sha256(original));
  assert.notEqual(sha256(readFileSync(queryPath)), record.artifacts.queryTuples);
});

for (const [id, source, completion] of [
  ["blocked-init", 'export function initSync(){console.log("entered init");while(true){}} export class PtRouter {}', "timeout"],
  ["blocked-plan", 'export function initSync(){} export class PtRouter {plan(){console.error("entered planner");while(true){}} free(){}}', "timeout"],
  ["crash", 'export function initSync(){process.exit(23);} export class PtRouter {}', "error"],
  ["killed", 'export function initSync(){process.kill(process.pid,"SIGKILL");} export class PtRouter {}', "error"],
  ["init-error", 'export function initSync(){throw new Error("supervised init failure");} export class PtRouter {}', "error"],
  ["empty", 'export function initSync(){} export class PtRouter {plan(){return [];} free(){}}', "success"],
]) {
  test(`supervised ${id} distinguishes timeout, failure and empty success`, () => {
    const fakePkg = join(tempDir, `supervised-${id}.mjs`);
    writeFileSync(fakePkg, source);
    writeFileSync(join(tempDir, "pt_wasm_bg.wasm"), "fixture");
    const store = join(tempDir, `supervised-${id}-store`);
    const args = ["--capture-store", store, "--run-id", "attempt", "--timeout-ms", completion === "timeout" ? "500" : "5000"];
    const result = runBaseline(tuplesPath, "plan", args, fakePkg);
    assert.equal(result.status, completion === "success" ? 0 : 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.completion, completion);
    const recordPath = join(store, "runs", "attempt.json");
    const record = JSON.parse(readFileSync(recordPath));
    assert.equal(record.completion, completion);
    assert.equal(record.artifacts.glue, sha256(Buffer.from(source)));
    assert.equal(record.artifacts.ptb, tinyPtbSha256);
    assert.ok(record.artifacts.childStdout);
    assert.ok(record.artifacts.childStderr);
    if (completion === "timeout") {
      assert.equal(diffBaselines(record, record).reason, "non-success completion");
      assert.equal(report.supervision.signal, "SIGKILL");
      assert.deepEqual(report.tuples, []);
      assert.throws(() => replayBaseline(store, "attempt", join(tempDir, `no-replay-${id}`)), /Unsupported/);
    }
    if (id === "blocked-init") {
      assert.match(readArtifact(store, record.artifacts.childStdout).toString(), /entered init/);
      const original = readFileSync(recordPath);
      assert.equal(runBaseline(tuplesPath, "plan", args, fakePkg).status, 1);
      assert.deepEqual(readFileSync(recordPath), original);
    }
    if (id === "blocked-plan") assert.match(readArtifact(store, record.artifacts.childStderr).toString(), /entered planner/);
    if (id === "crash") assert.equal(report.supervision.exitCode, 23);
    if (id === "killed") assert.equal(report.supervision.signal, "SIGKILL");
    if (id === "init-error") assert.equal(report.error.stage, "wasm initialization");
    if (id === "empty") {
      assert.deepEqual(report.tuples[0].candidates, []);
      assert.equal(replayBaseline(store, "attempt", join(tempDir, "supervised-empty-restored")).replayVerified, true);
    }
  });
}

test("supervisor retains completed tuples before a subsequent query blocks", () => {
  const queries = join(tempDir, "partial-timeout-queries.json");
  writeFileSync(queries, JSON.stringify({ptbSha256: tinyPtbSha256, tuples: [tinyTuple, tinyTuple]}));
  const fakePkg = join(tempDir, "partial-timeout.mjs");
  writeFileSync(fakePkg, 'export function initSync(){} export class PtRouter {n=0; plan(){if(++this.n>2)while(true){} return [];} free(){}}');
  writeFileSync(join(tempDir, "pt_wasm_bg.wasm"), "fixture");
  const store = join(tempDir, "partial-timeout-store");
  const result = runBaseline(queries, "plan", ["--capture-store", store, "--run-id", "partial", "--timeout-ms", "500"], fakePkg);
  assert.equal(result.status, 1, result.stderr);
  const record = JSON.parse(readFileSync(join(store,"runs","partial.json")));
  assert.equal(record.completion, "timeout");
  assert.equal(record.report.tuples.length, 1);
  assert.deepEqual(record.report.tuples[0].candidates, []);
});

test("a deadline before a final report still records an incomplete timed-out attempt", () => {
  const store = join(tempDir, "early-timeout-store");
  const result = runBaseline(tuplesPath, "plan", ["--capture-store", store, "--run-id", "early", "--timeout-ms", "1"]);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.completion, "timeout");
  assert.equal(report.supervision.timeoutMs, 1);
  assert.equal(report.runtimeSource, "supervisor");
  const record = JSON.parse(readFileSync(join(store,"runs","early.json")));
  assert.equal(record.completion, "timeout");
  for (const name of ["ptb", "queryTuples", "glue", "wasm"]) {
    if (!record.artifacts[name]) assert.ok(record.missingDependencies.includes(`unobserved input: ${name}`));
  }
});

test("deadline values reject timer overflow rather than becoming a one-millisecond timeout", () => {
  const result = runBaseline(tuplesPath, "plan", ["--timeout-ms", "2147483648"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /timer limit/);
});
