import { test } from "node:test";
import assert from "node:assert/strict";
import { diffBaselines } from "./baseline_diff.mjs";
const run = candidates => ({ schemaVersion: 1, completion: "success", artifacts: {ptb:"a".repeat(64),queryTuples:"b".repeat(64)}, report: {runtime:{node:"fixture",v8:"fixture",platform:"fixture",arch:"fixture",release:"fixture"},patternMode:"covering-merge",objective:"plan",input:{windowStart:null,windowEnd:null},tuples:[{query:{departureSecs:10},candidates}]} });
test("reports ordering, timing and additions without a quality verdict", () => {
 const a={tripId:"A",arriveSecs:20}, b={tripId:"B",arriveSecs:30};
 assert.equal(diffBaselines(run([a,b]),run([b,a])).tuples[0].orderingOnly,true);
 const timing=diffBaselines(run([a]),run([{...a,arriveSecs:21}]));
 assert.equal(timing.status,"changed/unreviewed");
 assert.deepEqual(timing.tuples[0].removed,[a]);
 assert.equal(timing.tuples[0].added[0].arriveSecs,21);
 assert.equal(diffBaselines(run([a,a]),run([a])).tuples[0].removed.length,1);
 assert.equal(diffBaselines(run([]),run([])).status,"unchanged");
});
test("normalizes property order but retains all fields", () => {
 assert.equal(diffBaselines(run([{a:1,b:2}]),run([{b:2,a:1}])).status,"unchanged");
 assert.equal(diffBaselines(run([{a:1}]),run([{a:1,unknown:2}])).status,"changed/unreviewed");
});
test("rejects confounded comparisons and distinguishes errors from empty", () => {
 const a=run([]), b=run([]); b.artifacts.ptb="c".repeat(64);
 assert.equal(diffBaselines(a,b).status,"incomparable");
 b.artifacts.ptb="a".repeat(64);b.completion="timeout";
 assert.equal(diffBaselines(a,b).reason,"non-success completion");
});


test("reports field paths and rejects runtime-confounded comparisons", () => {
 const before = run([{legs:[{departSecs:10,distanceMeters:50}]}]);
 const after = run([{legs:[{departSecs:11,distanceMeters:60}]}]);
 const diff = diffBaselines(before, after);
 assert.deepEqual(diff.tuples[0].fieldChanges.map(c => c.path), [
   ["0","legs","0","departSecs"], ["0","legs","0","distanceMeters"],
 ]);
 after.report.runtime.node = "different";
 assert.equal(diffBaselines(before, after).reason, "missing or mismatched runtime");
 delete after.report.runtime;
 assert.equal(diffBaselines(before, after).status, "incomparable");
});

test("equally incomplete runtime records cannot establish comparable captures", () => {
 for (const field of ["node", "v8", "platform", "arch", "release"]) {
  for (const value of [undefined, null, "", "  ", 123]) {
   const before = run([]), after = run([]);
   before.report.runtime[field] = value;
   after.report.runtime[field] = value;
   assert.equal(diffBaselines(before, after).reason, "missing or mismatched runtime", `${field}: ${value}`);
  }
 }
 assert.equal(diffBaselines(run([]), run([])).status, "unchanged");
});

test("execution origin changes are incomparable even with equal candidate arrays", () => {
 const before=run([]),after=run([]);
 after.report.glueExecution="snapshot-data-url-v1";
 assert.equal(diffBaselines(before,after).status,"incomparable");
 before.report.glueExecution="snapshot-data-url-v1";
 assert.equal(diffBaselines(before,after).status,"unchanged");
 before.report.glueExecution="unknown";after.report.glueExecution="unknown";
 assert.equal(diffBaselines(before,after).reason,"unsupported glue execution contract");
});

 test("equally missing or malformed input contracts remain incomparable", () => {
  for (const field of ["ptb","queryTuples"]) for (const value of [undefined,null,"","not-a-hash"]) {
   const before=run([]),after=run([]);
   before.artifacts[field]=value;after.artifacts[field]=value;
   assert.equal(diffBaselines(before,after).reason,"missing or unsupported input contract");
  }
  for (const field of ["patternMode","objective"]) for (const value of [undefined,null,"","unknown"]) {
   const before=run([]),after=run([]);
   before.report[field]=value;after.report[field]=value;
   assert.equal(diffBaselines(before,after).reason,"missing or unsupported input contract");
  }
 });
 test("window objectives require a complete finite ordered window", () => {
  for (const input of [{},{windowStart:null,windowEnd:null},{windowStart:10,windowEnd:10},{windowStart:20,windowEnd:10},{windowStart:NaN,windowEnd:20}]) {
   const before=run([]),after=run([]);
   for (const record of [before,after]) {record.report.objective="r3";record.report.input=input;}
   assert.equal(diffBaselines(before,after).reason,"missing or unsupported input contract");
  }
  const before=run([]),after=run([]);
  for (const record of [before,after]) {record.report.objective="m4";record.report.input={windowStart:10,windowEnd:20};}
  assert.equal(diffBaselines(before,after).status,"unchanged");
 });
