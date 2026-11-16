import { test } from "node:test";
import assert from "node:assert/strict";
import { diffBaselines } from "./baseline_diff.mjs";
const run = candidates => ({ schemaVersion: 1, completion: "success", artifacts: {ptb:"p",queryTuples:"q"}, report: {runtime:{node:"fixture",v8:"fixture",platform:"fixture",arch:"fixture",release:"fixture"},patternMode:"covering-merge",objective:"plan",input:{},tuples:[{query:{departureSecs:10},candidates}]} });
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
 const a=run([]), b=run([]); b.artifacts.ptb="other";
 assert.equal(diffBaselines(a,b).status,"incomparable");
 b.artifacts.ptb="p";b.completion="timeout";
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
