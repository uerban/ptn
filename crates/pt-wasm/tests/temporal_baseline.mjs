#!/usr/bin/env node
// Matched WASM baseline for the temporal-routing experiment. This deliberately
// has no project-package imports: callers provide both the generated web glue
// and the exact PTB/query manifest they want to compare.
//
// Usage:
//   node crates/pt-wasm/tests/temporal_baseline.mjs \
//     --pkg path/to/pt_wasm.js --ptb path/to/bundle.ptb \
//     --query-tuples path/to/tuples.json --iterations 100 --warmup 20 \
//     --pattern-mode covering-merge --objective plan
// Direct-profile packages additionally use:
//     --objective r3|m4 --window-start 25000 --window-end 90000

import { retainArtifact, retainRun } from "./baseline_store.mjs";
import { captureCandidates, assertCandidateEquality } from "./baseline_candidates.mjs";
import {publishInputs, publishTuple, publishReport, superviseBaseline} from "./baseline_supervisor.mjs";
import {GLUE_EXECUTION, importBaselineGlue} from "./baseline_glue.mjs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

const USAGE =
  "usage: temporal_baseline.mjs --pkg <path/to/pt_wasm.js> --ptb <bundle.ptb> " +
  "--query-tuples <tuples.json> --iterations <positive integer> " +
  "--warmup <non-negative integer> --pattern-mode covering-merge " +
  "--objective plan|r3|m4 [--window-start <seconds> --window-end <seconds>] [--capture-store <directory> --run-id <id>] [--timeout-ms <positive milliseconds>] [--glue-execution snapshot|file (default: snapshot)]";

function fail(message) {
  throw new Error(message);
}

function parseInteger(value, name, { min }) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    fail(`${name} must be an integer >= ${min}, got: ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    fail(`${name} must be an integer >= ${min}, got: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const allowed = new Set([
    "pkg",
    "ptb",
    "query-tuples",
    "iterations",
    "warmup",
    "pattern-mode",
    "objective",
    "window-start",
    "window-end",
    "capture-store",
    "run-id",
    "timeout-ms",
    "glue-execution",
  ]);
  const values = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}\n${USAGE}`);
    const name = arg.slice(2);
    if (!allowed.has(name)) fail(`unknown option: ${arg}\n${USAGE}`);
    if (values.has(name)) fail(`option specified more than once: ${arg}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${arg}`);
    values.set(name, value);
    index += 1;
  }

  for (const name of ["pkg", "ptb", "query-tuples", "iterations", "warmup", "pattern-mode", "objective"]) {
    if (!values.has(name)) fail(`missing required option: --${name}\n${USAGE}`);
  }

  if (values.has("capture-store") !== values.has("run-id")) {
    fail("--capture-store and --run-id must be supplied together");
  }
  const patternMode = values.get("pattern-mode");
  if (patternMode !== "covering-merge") {
    fail(`--pattern-mode must be covering-merge for the matched baseline, got: ${patternMode}`);
  }

  const objective = values.get("objective");
  if (!["plan", "r3", "m4"].includes(objective)) {
    fail(`--objective must be plan, r3, or m4, got: ${objective}`);
  }
  const hasWindowStart = values.has("window-start");
  const hasWindowEnd = values.has("window-end");
  if (objective === "plan" && (hasWindowStart || hasWindowEnd)) {
    fail("--window-start and --window-end apply only to r3 or m4 objectives");
  }
  if (objective !== "plan" && (!hasWindowStart || !hasWindowEnd)) {
    fail(`--objective ${objective} requires --window-start and --window-end`);
  }
  const windowStart = hasWindowStart
    ? parseInteger(values.get("window-start"), "--window-start", { min: 0 })
    : null;
  const windowEnd = hasWindowEnd
    ? parseInteger(values.get("window-end"), "--window-end", { min: 1 })
    : null;
  if (windowStart !== null && windowStart >= windowEnd) {
    fail("--window-start must be less than --window-end");
  }

  const timeoutMs = values.has("timeout-ms") ? parseInteger(values.get("timeout-ms"), "--timeout-ms", {min: 1}) : null;
  if (timeoutMs !== null && timeoutMs > 2147483647) fail("--timeout-ms exceeds the timer limit");
  const glueExecution = values.get("glue-execution") ?? "snapshot";
  if (!Object.hasOwn(GLUE_EXECUTION, glueExecution)) fail("--glue-execution must be snapshot or file");
  return {
    timeoutMs,
    glueExecution,
    captureStore: values.has("capture-store") ? resolve(values.get("capture-store")) : null,
    runId: values.get("run-id"),
    pkgPath: resolve(values.get("pkg")),
    ptbPath: resolve(values.get("ptb")),
    queryTuplesPath: resolve(values.get("query-tuples")),
    iterations: parseInteger(values.get("iterations"), "--iterations", { min: 1 }),
    warmup: parseInteger(values.get("warmup"), "--warmup", { min: 0 }),
    patternMode,
    objective,
    windowStart,
    windowEnd,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactMetrics(path, bytes) {
  return {
    path,
    sha256: sha256(bytes),
    rawBytes: bytes.byteLength,
    gzip9Bytes: gzipSync(bytes, { level: 9 }).byteLength,
    brotli11Bytes: brotliCompressSync(bytes, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
  };
}

function requiredObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function validateStopWalks(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must be a non-empty array`);
  }
  for (const [index, stopWalk] of value.entries()) {
    requiredObject(stopWalk, `${label}[${index}]`);
    if (typeof stopWalk.stopId !== "string" || stopWalk.stopId.length === 0) {
      fail(`${label}[${index}].stopId must be a non-empty string`);
    }
    if (!Number.isSafeInteger(stopWalk.walkSecs) || stopWalk.walkSecs < 0) {
      fail(`${label}[${index}].walkSecs must be a non-negative integer`);
    }
  }
}

function validateTuple(value, index) {
  const tuple = requiredObject(value, `tuples[${index}]`);
  validateStopWalks(tuple.entryStops, `tuples[${index}].entryStops`);
  validateStopWalks(tuple.exitStops, `tuples[${index}].exitStops`);
  if (typeof tuple.date !== "string" || !/^[0-9]{8}$/.test(tuple.date)) {
    fail(`tuples[${index}].date must be an eight-digit YYYYMMDD string`);
  }
  if (!Number.isSafeInteger(tuple.departureSecs) || tuple.departureSecs < 0) {
    fail(`tuples[${index}].departureSecs must be a non-negative integer`);
  }
  return tuple;
}

function loadTupleManifest(path, ptbHash, raw = readFileSync(path)) {
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    fail(`could not parse query-tuples JSON at ${path}: ${error.message}`);
  }
  const manifest = requiredObject(parsed, "query-tuples manifest");
  if (!Array.isArray(manifest.tuples) || manifest.tuples.length === 0) {
    fail("query-tuples manifest must contain a non-empty tuples array");
  }

  if (Object.hasOwn(manifest, "ptbSha256")) {
    if (typeof manifest.ptbSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(manifest.ptbSha256)) {
      fail("query-tuples ptbSha256 must be a 64-character hexadecimal SHA-256");
    }
    if (manifest.ptbSha256.toLowerCase() !== ptbHash) {
      fail(
        `query-tuples ptbSha256 does not match --ptb ` +
          `(manifest ${manifest.ptbSha256.toLowerCase()}, actual ${ptbHash})`,
      );
    }
  }

  return {
    tuples: manifest.tuples.map(validateTuple),
    sha256: sha256(raw),
    ptbSha256: manifest.ptbSha256?.toLowerCase() ?? null,
  };
}

function percentileNearestRank(samples, percentile) {
  const sorted = samples.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)];
}

function planCandidates(router, tuple, label, options) {
  const result = options.objective === "plan"
    ? router.plan(tuple)
    : router.planTemporalDirect(tuple, {
        startSecs: options.windowStart,
        endSecs: options.windowEnd,
      });
  if (!Array.isArray(result)) fail(`${label} returned a non-array result`);
  return result;
}

function benchmarkTuple(router, tuple, index, options) {
  const { warmup, iterations } = options;
  for (let iteration = 0; iteration < warmup; iteration += 1) {
    planCandidates(router, tuple, `tuples[${index}] warmup ${iteration}`, options);
  }

  const samples = [];
  let expectedCandidates;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = performance.now();
    const result = planCandidates(router, tuple, `tuples[${index}] iteration ${iteration}`, options);
    samples.push(performance.now() - startedAt);
    // Snapshot/compare outside the timed planner call.
    const candidates = captureCandidates(result, `tuples[${index}] iteration ${iteration}`);
    if (expectedCandidates === undefined) expectedCandidates = candidates;
    else assertCandidateEquality(expectedCandidates, candidates, `tuples[${index}] iteration ${iteration}`);
  }

  return {
    index,
    query: tuple,
    p50Ms: percentileNearestRank(samples, 0.5),
    p95Ms: percentileNearestRank(samples, 0.95),
    resultCount: expectedCandidates.length,
    candidates: expectedCandidates,
    capture: { equivalence: "exact", truncated: false, boundary: "stop-level engine" },
  };
}

function runtimeMetadata() {
  const hostCpus = cpus();
  const firstCpu = hostCpus[0];
  return {
    node: process.version,
    v8: process.versions.v8,
    platform: platform(),
    release: release(),
    arch: process.arch,
    cpu: {
      model: firstCpu?.model ?? "unknown",
      logicalCores: hostCpus.length,
      speedMHz: firstCpu?.speed ?? null,
    },
  };
}

function retainReport(options, report, bytes, missingInputs = []) {
  report.glueExecution = GLUE_EXECUTION[options.glueExecution];
  if (publishReport(report)) return;
  if (!options.captureStore) return;
  const artifacts = Object.fromEntries(Object.entries(bytes)
    .map(([name, value]) => [name, retainArtifact(options.captureStore, value)]));
  retainRun(options.captureStore, options.runId, {
    schemaVersion: 1,
    classification: "partial capture",
    scope: "stop-level compiled engine",
    replayVerification: "unverified",
    missingDependencies: ["source GTFS and producer provenance", ...missingInputs.map(name => `${options.timeoutMs ? "unobserved" : "unread"} input: ${name}`)],
    unsupported: ["frontend geometry", "real-time composition", "feed rebuild",
      "external glue module/file dependency capture",
      ...(options.glueExecution === "snapshot" ? ["file-relative import.meta.url semantics"] : ["legacy file import byte identity"]),
      ...(options.timeoutMs ? ["supervisor termination", "engine-created subprocess cleanup", "interrupted tuple iterations"] : ["process termination/timeouts"])],
    completion: report.completion,
    artifacts,
    report,
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const options = parseArgs(argv);
  if (options.timeoutMs !== null) {
    const childArgs = [];
    for (let i = 0; i < argv.length; i += 2) {
      if (argv[i] !== "--timeout-ms") childArgs.push(argv[i], argv[i + 1]);
    }
    const outcome = await superviseBaseline(fileURLToPath(import.meta.url), childArgs, options.timeoutMs);
    const complete = outcome.exitCode === 0 && outcome.report?.completion === "success";
    const completion = outcome.timedOut ? "timeout" : complete ? "success" : "error";
    const report = outcome.report ?? {
      schemaVersion: 1, patternMode: options.patternMode, objective: options.objective,
      input: {
        ptb: {path: options.ptbPath, sha256: outcome.bytes.ptb ? sha256(outcome.bytes.ptb) : null},
        queryTuples: {path: options.queryTuplesPath, sha256: outcome.bytes.queryTuples ? sha256(outcome.bytes.queryTuples) : null, tupleCount: null},
        iterations: options.iterations, warmup: options.warmup,
        windowStart: options.windowStart, windowEnd: options.windowEnd,
      },
      runtime: runtimeMetadata(), runtimeSource: "supervisor",
      initialization: {wasmMs: null, routerMs: null, totalMs: null}, tuples: outcome.tuples,
    };
    if (outcome.timedOut || (!complete && report.completion !== "error")) {
      report.error = {stage: "supervised execution", message: outcome.timedOut
        ? `Child exceeded ${options.timeoutMs} ms wall-clock deadline`
        : outcome.processError ?? `Child exited without successful completion (code ${outcome.exitCode}, signal ${outcome.signal})`,
        ...(report.error ? {childError: report.error} : {})};
    }
    report.completion = completion;
    report.supervision = {timeoutMs: options.timeoutMs, exitCode: outcome.exitCode, signal: outcome.signal};
    const missing = ["ptb", "queryTuples", "glue", "wasm"].filter(name => !outcome.bytes[name]);
    retainReport(options, report, {...outcome.bytes, childStdout: outcome.stdout, childStderr: outcome.stderr}, missing);
    console.log(JSON.stringify(report));
    if (outcome.stderr.length) process.stderr.write(outcome.stderr);
    if (completion !== "success") {
      console.error(`temporal-baseline: ${completion}: ${report.error.message}`);
      process.exitCode = 1;
    }
    return;
  }
  const wasmPath = join(dirname(options.pkgPath), "pt_wasm_bg.wasm");
  const paths = {ptb: options.ptbPath, queryTuples: options.queryTuplesPath, glue: options.pkgPath, wasm: wasmPath};
  const bytes = {};
  const readErrors = [];
  for (const [name, path] of Object.entries(paths)) {
    try { bytes[name] = readFileSync(path); }
    catch (error) { readErrors.push({name, message: error.message}); }
  }
  await publishInputs(bytes, readErrors.map(error => error.name));
  let manifest;
  let inputError;
  if (readErrors.length) {
    inputError = {stage: "input reading", message: readErrors.map(e => `${e.name}: ${e.message}`).join("; "), failures: readErrors};
  } else {
    try { manifest = loadTupleManifest(options.queryTuplesPath, sha256(bytes.ptb), bytes.queryTuples); }
    catch (error) { inputError = {stage: "query validation", message: error.message}; }
  }
  if (inputError) {
    const report = {
      schemaVersion: 1, completion: "error", error: inputError,
      patternMode: options.patternMode, objective: options.objective,
      input: {
        ptb: {path: options.ptbPath, sha256: bytes.ptb ? sha256(bytes.ptb) : null},
        queryTuples: {path: options.queryTuplesPath, sha256: bytes.queryTuples ? sha256(bytes.queryTuples) : null, tupleCount: null},
        iterations: options.iterations, warmup: options.warmup,
        windowStart: options.windowStart, windowEnd: options.windowEnd,
      },
      runtime: runtimeMetadata(), initialization: {wasmMs: null, routerMs: null, totalMs: null},
      tuples: [],
    };
    retainReport(options, report, bytes, readErrors.map(error => error.name));
    console.log(JSON.stringify(report));
    console.error(`temporal-baseline: ${inputError.stage}: ${inputError.message}`);
    process.exitCode = 1;
    return;
  }
  const {ptb: ptbBytes, glue: glueBytes, wasm: wasmBytes} = bytes;
  const ptbHash = sha256(ptbBytes);
  const artifact = {
    wasm: artifactMetrics(wasmPath, wasmBytes),
    glue: artifactMetrics(options.pkgPath, glueBytes),
  };

  const tuples = [];
  let completion = "success";
  let planningError;
  let router;
  let wasmInitMs = null;
  let routerInitMs = null;
  let stage = "module import";
  try {
    const pkg = await importBaselineGlue(glueBytes, options.pkgPath, options.glueExecution);
    if (typeof pkg.initSync !== "function") {
      fail(`--pkg does not export initSync; expected a wasm-pack --target web package: ${options.pkgPath}`);
    }
    if (typeof pkg.PtRouter !== "function") {
      fail(`--pkg does not export PtRouter: ${options.pkgPath}`);
    }

    stage = "wasm initialization";
    const wasmInitStartedAt = performance.now();
    pkg.initSync({ module: wasmBytes });
    wasmInitMs = performance.now() - wasmInitStartedAt;

    stage = "router initialization";
    const routerInitStartedAt = performance.now();
    router = new pkg.PtRouter(ptbBytes, options.patternMode);
    routerInitMs = performance.now() - routerInitStartedAt;
    stage = "artifact contract";
    const artifactObjective = typeof router.temporalDirectObjective === "function"
      ? router.temporalDirectObjective()
      : null;
    if (options.objective === "plan" && artifactObjective !== null) {
      fail(
        `--objective plan requires a production pt-wasm artifact, got temporal-direct ${artifactObjective}`,
      );
    }
    if (options.objective !== "plan" && typeof router.planTemporalDirect !== "function") {
      fail(`--objective ${options.objective} requires a temporal-direct pt-wasm package`);
    }
    if (options.objective !== "plan") {
      if (artifactObjective !== options.objective) {
        fail(
          `--objective ${options.objective} does not match temporal-direct artifact ` +
            `${artifactObjective ?? "without objective metadata"}`,
        );
      }
    }

    stage = "planning";
    for (const [index, tuple] of manifest.tuples.entries()) {
      tuples.push(benchmarkTuple(router, tuple, index, options));
      await publishTuple(tuples[tuples.length - 1]);
    }
  } catch (error) {
    completion = "error";
    planningError = { stage, ...(stage === "planning" ? { tupleIndex: tuples.length } : {}), message: error.message };
  } finally {
    try { router?.free(); }
    catch (error) {
      completion = "error";
      if (planningError) planningError.cleanupError = error.message;
      else planningError = { stage: "router cleanup", message: error.message };
    }
  }

  const report = {
      completion,
      ...(planningError ? { error: planningError } : {}),
      schemaVersion: 1,
      patternMode: options.patternMode,
      objective: options.objective,
      input: {
        ptb: { path: options.ptbPath, sha256: ptbHash },
        queryTuples: {
          path: options.queryTuplesPath,
          sha256: manifest.sha256,
          ptbSha256: manifest.ptbSha256,
          tupleCount: manifest.tuples.length,
        },
        iterations: options.iterations,
        warmup: options.warmup,
        windowStart: options.windowStart,
        windowEnd: options.windowEnd,
      },
      artifact,
      runtime: runtimeMetadata(),
      initialization: {
        wasmMs: wasmInitMs,
        routerMs: routerInitMs,
        totalMs: wasmInitMs !== null && routerInitMs !== null ? wasmInitMs + routerInitMs : null,
      },
      percentileMethod: "nearest-rank",
      tuples,
    };
  retainReport(options, report, bytes);
  console.log(JSON.stringify(report));
  if (completion !== "success") {
    console.error(`temporal-baseline: ${planningError.stage}: ${planningError.message}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`temporal-baseline: ${error.message}`);
  process.exitCode = 1;
});
