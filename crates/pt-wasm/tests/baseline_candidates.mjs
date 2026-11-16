import { isDeepStrictEqual } from "node:util";

/** Retain an independent ordered copy before a router can reuse its objects. */
export function captureCandidates(result, label) {
  if (!Array.isArray(result)) throw new Error(`${label} returned a non-array result`);
  return structuredClone(result);
}

/** Exact comparison: timing and ordering changes must remain observable. */
export function assertCandidateEquality(expected, actual, label) {
  if (!isDeepStrictEqual(expected, actual)) {
    throw new Error(`${label} returned non-deterministic candidates (including order or timing)`);
  }
}
