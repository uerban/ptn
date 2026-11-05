import { describe, it, expect } from "vitest";
import { pairSortByB } from "./index-builder.js";

describe("pairSortByB", () => {
  it("sorts a 4-element pair correctly", () => {
    // (100, 5), (200, 3), (300, 7), (400, 1) — keyed by b
    const a = new Uint32Array([100, 200, 300, 400]);
    const b = new Uint32Array([5, 3, 7, 1]);
    pairSortByB(a, b, 0, 4);
    expect(Array.from(b)).toEqual([1, 3, 5, 7]);
    expect(Array.from(a)).toEqual([400, 200, 100, 300]);
  });

  it("sorts a 50-element randomized pair (exercises quicksort path past the 16-element insertion-sort threshold)", () => {
    // Deterministic pseudo-random pairs so the test is reproducible.
    const n = 50;
    const a = new Uint32Array(n);
    const b = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      a[i] = i * 1000;
      b[i] = ((i * 2654435761) >>> 0) % 10000; // Knuth multiplicative hash, mod 10k
    }
    // Capture the expected parallel ordering by sorting index array by b.
    const expectedOrder = Array.from({ length: n }, (_, i) => i);
    expectedOrder.sort((x, y) => b[x]! - b[y]!);
    const expectedB = expectedOrder.map((i) => b[i]!);
    const expectedA = expectedOrder.map((i) => a[i]!);

    pairSortByB(a, b, 0, n);

    expect(Array.from(b)).toEqual(expectedB);
    expect(Array.from(a)).toEqual(expectedA);
  });

  it("handles all-equal b values without crashing or losing elements", () => {
    const a = new Uint32Array([10, 20, 30, 40, 50]);
    const b = new Uint32Array([7, 7, 7, 7, 7]);
    pairSortByB(a, b, 0, 5);
    expect(Array.from(b)).toEqual([7, 7, 7, 7, 7]);
    // Order of a is unspecified (sort is not stable), but every original
    // value must be present exactly once.
    expect(Array.from(a).sort((x, y) => x - y)).toEqual([10, 20, 30, 40, 50]);
  });

  it("handles already-sorted input without degrading (correctness, not runtime)", () => {
    const a = new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    const b = new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    pairSortByB(a, b, 0, 20);
    expect(Array.from(b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(Array.from(a)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it("handles empty and single-element ranges as no-ops", () => {
    const a = new Uint32Array([42]);
    const b = new Uint32Array([99]);
    expect(() => pairSortByB(a, b, 0, 0)).not.toThrow();
    expect(() => pairSortByB(a, b, 0, 1)).not.toThrow();
    expect(Array.from(a)).toEqual([42]);
    expect(Array.from(b)).toEqual([99]);
  });
});

import { U32PairBuilder } from "./index-builder.js";

describe("U32PairBuilder — constructor guard", () => {
  it("throws RangeError on initialCap < 1", () => {
    expect(() => new U32PairBuilder(0)).toThrow(RangeError);
    expect(() => new U32PairBuilder(-1)).toThrow(RangeError);
    expect(() => new U32PairBuilder(0)).toThrow(/initialCap.*>= 1/);
  });

  it("accepts default construction and small initial caps", () => {
    expect(() => new U32PairBuilder()).not.toThrow();
    expect(() => new U32PairBuilder(1)).not.toThrow();
    expect(() => new U32PairBuilder(16)).not.toThrow();
  });
});

describe("U32PairBuilder — empty", () => {
  it("finalize on fresh builder returns zero-length arrays", () => {
    const b = new U32PairBuilder();
    const result = b.finalize();
    expect(result.tripIdIdx.length).toBe(0);
    expect(result.departureSecs.length).toBe(0);
  });
});

describe("U32PairBuilder — push + finalize without growth", () => {
  it("sorts 8 pairs pushed out of departureSecs order", () => {
    const b = new U32PairBuilder(16);
    // (tripIdIdx, departureSecs) pairs pushed out of order
    b.push(100, 80);
    b.push(101, 20);
    b.push(102, 50);
    b.push(103, 10);
    b.push(104, 70);
    b.push(105, 30);
    b.push(106, 60);
    b.push(107, 40);

    const { tripIdIdx, departureSecs } = b.finalize();
    expect(tripIdIdx.length).toBe(8);
    expect(departureSecs.length).toBe(8);
    expect(Array.from(departureSecs)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
    expect(Array.from(tripIdIdx)).toEqual([103, 101, 105, 107, 102, 106, 104, 100]);
  });
});

describe("U32PairBuilder — push triggers doubling", () => {
  it("returns exact-length arrays (not doubling-rounded) after growth", () => {
    const b = new U32PairBuilder(4);
    for (let i = 0; i < 12; i++) b.push(1000 + i, i);
    const { tripIdIdx, departureSecs } = b.finalize();
    expect(tripIdIdx.length).toBe(12);
    expect(departureSecs.length).toBe(12);
    expect(Array.from(departureSecs)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});

describe("U32PairBuilder — known-ordering sort correctness", () => {
  it("parallel-reorders tripIdIdx to match sorted departureSecs", () => {
    const b = new U32PairBuilder();
    b.push(100, 5);
    b.push(200, 3);
    b.push(300, 7);
    b.push(400, 1);
    const { tripIdIdx, departureSecs } = b.finalize();
    expect(Array.from(departureSecs)).toEqual([1, 3, 5, 7]);
    expect(Array.from(tripIdIdx)).toEqual([400, 200, 100, 300]);
  });
});

describe("U32PairBuilder — duplicate departureSecs", () => {
  it("exercises Hoare partition all-equal-pivot path without throwing", () => {
    const b = new U32PairBuilder();
    // All 10 pairs share the same departureSecs
    for (let i = 0; i < 10; i++) b.push(1000 + i, 42);
    const { tripIdIdx, departureSecs } = b.finalize();
    expect(departureSecs.length).toBe(10);
    expect(Array.from(departureSecs)).toEqual([42, 42, 42, 42, 42, 42, 42, 42, 42, 42]);
    // Order of tripIdIdx is unspecified (sort is not stable), but every
    // original value must be present exactly once.
    expect(Array.from(tripIdIdx).sort((x, y) => x - y)).toEqual(
      [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009],
    );
  });
});

describe("U32PairBuilder — growth sequence", () => {
  it("returns exact-length arrays across many growth boundaries", () => {
    for (const n of [1, 2, 4, 8, 16, 32, 64, 128, 256, 512]) {
      const b = new U32PairBuilder();
      for (let i = 0; i < n; i++) b.push(i, n - i); // descending b
      const { tripIdIdx, departureSecs } = b.finalize();
      expect(departureSecs.length).toBe(n);
      expect(tripIdIdx.length).toBe(n);
      // departureSecs should be sorted ascending (we pushed in descending order)
      for (let i = 1; i < departureSecs.length; i++) {
        expect(departureSecs[i]!).toBeGreaterThanOrEqual(departureSecs[i - 1]!);
      }
    }
  });
});

describe("U32PairBuilder — terminal finalize", () => {
  it("throws on push after finalize", () => {
    const b = new U32PairBuilder();
    b.push(1, 2);
    b.finalize();
    expect(() => b.push(3, 4)).toThrow(/push after finalize/);
  });
});
