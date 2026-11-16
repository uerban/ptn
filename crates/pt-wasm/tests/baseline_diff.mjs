import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// v1 ignores object property order only. No candidate field is hidden.
export function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, normalize(value[k])]));
  return value;
}
const key = value => JSON.stringify(normalize(value));
function difference(left, right) {
  const remaining = right.map(key);
  return left.filter(candidate => {
    const index = remaining.indexOf(key(candidate));
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
}
// Paths are positional: a reorder may produce many field changes. Identity
// matching and subjective usefulness are deliberately separate concerns.
export function changedFields(before, after, path = []) {
  if (isDeepStrictEqual(normalize(before), normalize(after))) return [];
  if (before && after && typeof before === "object" && typeof after === "object"
      && Array.isArray(before) === Array.isArray(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap(k => changedFields(before[k], after[k], [...path, k]));
  }
  return [{ path, beforePresent: before !== undefined, afterPresent: after !== undefined,
    ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) }];
}
export function diffBaselines(before, after) {
  if (before.schemaVersion !== 1 || after.schemaVersion !== 1) throw new Error("Unsupported baseline schema");
  const contract = run => ({
    ptb: run.artifacts.ptb, queryTuples: run.artifacts.queryTuples,
    patternMode: run.report.patternMode, objective: run.report.objective,
    windowStart: run.report.input.windowStart, windowEnd: run.report.input.windowEnd,
  });
  if (!isDeepStrictEqual(normalize(contract(before)), normalize(contract(after)))) {
    return { schemaVersion: 1, normalizerVersion: 1, status: "incomparable", reason: "mismatched inputs or planning settings" };
  }
  const runtime = run => {
    const value = run.report.runtime;
    const fields = ["node", "v8", "platform", "arch", "release"];
    if (!value || !fields.every(field => typeof value[field] === "string" && value[field].trim().length > 0)) return null;
    return Object.fromEntries(fields.map(field => [field, value[field]]));
  };
  if (!runtime(before) || !runtime(after)
      || !isDeepStrictEqual(runtime(before), runtime(after))) {
    return { schemaVersion: 1, normalizerVersion: 1, status: "incomparable", reason: "missing or mismatched runtime" };
  }
  if (before.completion !== "success" || after.completion !== "success") {
    return { schemaVersion: 1, normalizerVersion: 1, status: "incomparable", reason: "non-success completion", before: before.completion, after: after.completion };
  }
  if (before.report.tuples.length !== after.report.tuples.length) throw new Error("Mismatched tuple count");
  const tuples = before.report.tuples.map((tuple, index) => {
    const next = after.report.tuples[index];
    if (!isDeepStrictEqual(normalize(tuple.query), normalize(next.query))) throw new Error("Mismatched tuple query");
    if (!Array.isArray(tuple.candidates) || !Array.isArray(next.candidates)) throw new Error("Missing captured candidates");
    const added = difference(next.candidates, tuple.candidates);
    const removed = difference(tuple.candidates, next.candidates);
    const changed = key(tuple.candidates) !== key(next.candidates);
    return { index, status: changed ? "changed/unreviewed" : "unchanged", added, removed,
      orderingOnly: changed && added.length === 0 && removed.length === 0,
      fieldChanges: changedFields(tuple.candidates, next.candidates),
      before: tuple.candidates, after: next.candidates };
  });
  return { schemaVersion: 1, normalizerVersion: 1, status: tuples.some(t => t.status !== "unchanged") ? "changed/unreviewed" : "unchanged", tuples };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error("usage: baseline_diff.mjs <before-run.json> <after-run.json>");
    console.log(JSON.stringify(diffBaselines(...process.argv.slice(2).map(p => JSON.parse(readFileSync(p))))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
