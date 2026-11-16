import assert from "node:assert/strict";
import { test } from "node:test";
import { captureCandidates, assertCandidateEquality } from "./baseline_candidates.mjs";

test("retains all ordered candidates independently of router mutation", () => {
  const raw = [{ legs: [{ tripId: "A", departSecs: 10 }] }, { legs: [{ tripId: "B", departSecs: 20 }] }];
  const snapshot = captureCandidates(raw, "query");
  raw[0].legs[0].departSecs = 99;
  assert.equal(snapshot[0].legs[0].departSecs, 10);
  assert.equal(snapshot[1].legs[0].tripId, "B");
});
test("observes same-count order and timing differences", () => {
  const expected = [{ tripId: "A", time: 10 }, { tripId: "B", time: 20 }];
  assertCandidateEquality(expected, structuredClone(expected), "query");
  assert.throws(() => assertCandidateEquality(expected, [...expected].reverse(), "query"), /non-deterministic/);
  assert.throws(() => assertCandidateEquality(expected, [{ tripId: "A", time: 11 }, expected[1]], "query"), /non-deterministic/);
});
test("empty success is distinct from malformed output or planner failure", () => {
  assert.deepEqual(captureCandidates([], "query"), []);
  assert.throws(() => captureCandidates(null, "query"), /non-array/);
});
