import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readArtifact } from "./baseline_store.mjs";
import { assertCandidateEquality } from "./baseline_candidates.mjs";

// Retained JS is executable code. Restore only captures from trusted local runs.
export function restoreBaseline(store, runId, destination) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) throw new Error("Invalid run ID");
  const record = JSON.parse(readFileSync(join(store, "runs", `${runId}.json`)));
  if (record.schemaVersion !== 1 || record.completion !== "success") throw new Error("Unsupported run manifest");
  const names = { ptb: "bundle.ptb", queryTuples: "queries.json", glue: "pt_wasm.mjs", wasm: "pt_wasm_bg.wasm" };
  // Verify the entire declared snapshot, including retained source/provenance
  // inputs that the narrower engine replay does not itself execute.
  const bytes = {};
  for (const [name, digest] of Object.entries(record.artifacts)) {
    const value = readArtifact(store, digest);
    if (Object.hasOwn(names, name)) bytes[name] = value;
  }
  for (const name of Object.keys(names)) {
    if (!bytes[name]) throw new Error(`Missing required replay artifact: ${name}`);
  }
  // A fresh directory prevents overwriting any previous restore evidence.
  mkdirSync(destination);
  for (const [name, filename] of Object.entries(names)) writeFileSync(join(destination, filename), bytes[name], { flag: "wx" });
  return record;
}

export function replayBaseline(store, runId, destination) {
  const record = restoreBaseline(store, runId, destination);
  const report = record.report;
  const args = [join(dirname(fileURLToPath(import.meta.url)), "temporal_baseline.mjs"),
    "--pkg", join(destination, "pt_wasm.mjs"), "--ptb", join(destination, "bundle.ptb"),
    "--query-tuples", join(destination, "queries.json"), "--iterations", "2", "--warmup", "0",
    "--pattern-mode", report.patternMode, "--objective", report.objective];
  if (report.objective !== "plan") args.push("--window-start", String(report.input.windowStart), "--window-end", String(report.input.windowEnd));
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Replay failed: ${result.stderr || result.error?.message}`);
  const actual = JSON.parse(result.stdout);
  assertCandidateEquality(report.tuples.map(t => t.candidates), actual.tuples.map(t => t.candidates), "restored replay");
  const verification = { schemaVersion: 1, scope: record.scope, equivalence: "exact ordered candidates", replayVerified: true, report: actual };
  writeFileSync(join(destination, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`, { flag: "wx" });
  return verification;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 5) throw new Error("usage: baseline_restore.mjs <store> <run-id> <fresh-destination>");
    console.log(JSON.stringify(replayBaseline(resolve(process.argv[2]), process.argv[3], resolve(process.argv[4]))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
