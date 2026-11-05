import { describe, it, expect } from "vitest";
import { patternSignature, groupTripsByPattern } from "./patternSignature.js";
import { PatternMode } from "./patternMode.js";

describe("patternSignature", () => {
  it("is the ordered stop-idx sequence, repeats preserved", () => {
    expect(patternSignature([0, 1, 2])).toBe("0,1,2");
    expect(patternSignature([0, 1, 0])).toBe("0,1,0"); // loop repeat kept
  });
  it("distinguishes a branch from the longer sequence", () => {
    expect(patternSignature([0, 1, 2, 4])).not.toBe(patternSignature([0, 1, 3, 4]));
  });
});

describe("groupTripsByPattern", () => {
  it("splits identical sequences by per-trip pickup/drop-off semantics", () => {
    const trips = [
      { tripIdx: 0, stopIdxs: [0, 1, 0] },
      { tripIdx: 1, stopIdxs: [0, 1, 0], boarding: [0, 1, 0] },
      { tripIdx: 2, stopIdxs: [0, 1, 0], boarding: [0, 4, 0] },
      { tripIdx: 3, stopIdxs: [0, 1, 0], boarding: [0, 0, 0] },
    ];
    for (const mode of [PatternMode.Unbounded, PatternMode.CoveringMerge]) {
      expect(groupTripsByPattern(trips, mode).map((g) => g.tripIdxs)).toEqual([[0, 3], [1], [2]]);
    }
  });

  it("groups by signature in first-appearance order; each group keeps its members", () => {
    const trips = [
      { tripIdx: 10, stopIdxs: [0, 1, 2, 4] }, // pattern A
      { tripIdx: 11, stopIdxs: [0, 1, 3, 4] }, // pattern B (branch via s3)
      { tripIdx: 12, stopIdxs: [0, 1, 2, 4] }, // pattern A again
    ];
    const groups = groupTripsByPattern(trips);
    expect(groups.map((g) => g.stopIdxs)).toEqual([[0, 1, 2, 4], [0, 1, 3, 4]]);
    expect(groups.map((g) => g.tripIdxs)).toEqual([[10, 12], [11]]);
  });
  it("single-pattern route yields exactly one group (Off-path no-op shape)", () => {
    const groups = groupTripsByPattern([
      { tripIdx: 0, stopIdxs: [0, 1, 2] },
      { tripIdx: 1, stopIdxs: [0, 1, 2] },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].tripIdxs).toEqual([0, 1]);
  });
  it("accepts mode param defaulting to Off (Revision-2 cross-cutting requirement)", () => {
    const groups = groupTripsByPattern(
      [{ tripIdx: 0, stopIdxs: [0, 1, 2] }],
      PatternMode.Off,
    );
    expect(groups).toHaveLength(1);
  });
  it("group order follows first-appearance (reversed input flips group[0])", () => {
    // B-then-A ordering: group[0] must be the B pattern ([0,1,3,4]), not A.
    const trips = [
      { tripIdx: 11, stopIdxs: [0, 1, 3, 4] }, // pattern B first
      { tripIdx: 10, stopIdxs: [0, 1, 2, 4] }, // pattern A second
      { tripIdx: 12, stopIdxs: [0, 1, 2, 4] }, // pattern A again
    ];
    const groups = groupTripsByPattern(trips);
    expect(groups.map((g) => g.stopIdxs)).toEqual([[0, 1, 3, 4], [0, 1, 2, 4]]);
    expect(groups.map((g) => g.tripIdxs)).toEqual([[11], [10, 12]]);
  });
  it("native members carry offset 0 under Off / Unbounded", () => {
    const input = [
      { tripIdx: 10, stopIdxs: [0, 1, 2, 4] },
      { tripIdx: 11, stopIdxs: [0, 1, 3, 4] },
      { tripIdx: 12, stopIdxs: [0, 1, 2, 4] },
    ];
    for (const mode of [PatternMode.Off, PatternMode.Unbounded]) {
      const groups = groupTripsByPattern(input, mode);
      expect(groups.map((g) => g.offsets)).toEqual([[0, 0], [0]]);
    }
  });
  it("mode identity: branches that don't cover each other are unchanged under CoveringMerge", () => {
    // [0,1,2,4] and [0,1,3,4] differ at position 2 — neither is a contiguous
    // subsequence of the other, so CoveringMerge folds nothing (== Unbounded).
    const input = [
      { tripIdx: 10, stopIdxs: [0, 1, 2, 4] },
      { tripIdx: 11, stopIdxs: [0, 1, 3, 4] },
      { tripIdx: 12, stopIdxs: [0, 1, 2, 4] },
    ];
    const unbounded = groupTripsByPattern(input, PatternMode.Unbounded);
    const covering = groupTripsByPattern(input, PatternMode.CoveringMerge);
    expect(covering).toEqual(unbounded);
  });

  describe("CoveringMerge fold", () => {
    it("folds a contiguous-subsequence pattern into its covering pattern", () => {
      // [1,2,3] is the window [1..4) of [0,1,2,3,4] → fold trip 1 into trip 0's
      // group at offset 1. One group survives; trip 1 carries offset 1.
      const groups = groupTripsByPattern(
        [
          { tripIdx: 0, stopIdxs: [0, 1, 2, 3, 4] },
          { tripIdx: 1, stopIdxs: [1, 2, 3] },
        ],
        PatternMode.CoveringMerge,
      );
      expect(groups).toHaveLength(1);
      expect(groups[0].stopIdxs).toEqual([0, 1, 2, 3, 4]); // surviving longer pattern
      expect(groups[0].tripIdxs).toEqual([0, 1]);
      expect(groups[0].offsets).toEqual([0, 1]); // native trip 0 @0, folded trip 1 @1
    });

    it("folds a prefix (offset 0) and a suffix (offset>0) into the same covering pattern", () => {
      // prefix [0,1,2] @0, suffix [2,3,4] @2, both windows of [0,1,2,3,4].
      const groups = groupTripsByPattern(
        [
          { tripIdx: 0, stopIdxs: [0, 1, 2, 3, 4] },
          { tripIdx: 1, stopIdxs: [0, 1, 2] }, // prefix → offset 0
          { tripIdx: 2, stopIdxs: [2, 3, 4] }, // suffix → offset 2
        ],
        PatternMode.CoveringMerge,
      );
      expect(groups).toHaveLength(1);
      expect(groups[0].stopIdxs).toEqual([0, 1, 2, 3, 4]);
      expect(groups[0].tripIdxs).toEqual([0, 1, 2]);
      expect(groups[0].offsets).toEqual([0, 0, 2]);
    });

    it("does NOT fold an opposite-direction pattern", () => {
      // [4,3,2,1,0] is the reverse of [0,1,2,3,4] — a reverse is NOT a contiguous
      // subsequence, so the two patterns stay distinct.
      const groups = groupTripsByPattern(
        [
          { tripIdx: 0, stopIdxs: [0, 1, 2, 3, 4] },
          { tripIdx: 1, stopIdxs: [4, 3, 2, 1, 0] },
        ],
        PatternMode.CoveringMerge,
      );
      expect(groups).toHaveLength(2);
      expect(groups.map((g) => g.stopIdxs)).toEqual([
        [0, 1, 2, 3, 4],
        [4, 3, 2, 1, 0],
      ]);
      expect(groups.map((g) => g.offsets)).toEqual([[0], [0]]);
    });

    it("tie-break: folds into the FIRST covering pattern in enumeration order", () => {
      // Two distinct covering patterns both contain [1,2] as a window:
      //   H0 = [0,1,2,3] (enumerated first), H1 = [9,1,2,8].
      // G = [1,2] must fold into H0 (first-in-enumeration), NOT H1.
      const groups = groupTripsByPattern(
        [
          { tripIdx: 0, stopIdxs: [0, 1, 2, 3] }, // H0
          { tripIdx: 1, stopIdxs: [9, 1, 2, 8] }, // H1
          { tripIdx: 2, stopIdxs: [1, 2] }, // G — covered by both
        ],
        PatternMode.CoveringMerge,
      );
      expect(groups).toHaveLength(2);
      // H0 absorbed G at offset 1; H1 untouched.
      expect(groups[0].stopIdxs).toEqual([0, 1, 2, 3]);
      expect(groups[0].tripIdxs).toEqual([0, 2]);
      expect(groups[0].offsets).toEqual([0, 1]);
      expect(groups[1].stopIdxs).toEqual([9, 1, 2, 8]);
      expect(groups[1].tripIdxs).toEqual([1]);
      expect(groups[1].offsets).toEqual([0]);
    });

    it("equal-length distinct patterns never fold", () => {
      const groups = groupTripsByPattern(
        [
          { tripIdx: 0, stopIdxs: [0, 1, 2] },
          { tripIdx: 1, stopIdxs: [3, 4, 5] },
        ],
        PatternMode.CoveringMerge,
      );
      expect(groups).toHaveLength(2);
      expect(groups.map((g) => g.offsets)).toEqual([[0], [0]]);
    });

    it("transitive fold composes offsets (k_child + k_parent)", () => {
      // Chain: [1,2] folds into [0,1,2] @1, then [0,1,2] folds into [0,1,2,3] @0.
      // trip0's offset must COMPOSE to 1 (k_child=1 + k_parent=0), NOT be re-set
      // to the parent offset 0. One surviving group:
      //   stopIdxs [0,1,2,3]; tripIdxs [2,1,0] (native first, then the absorbed
      //   members in append order); offsets [0,0,1].
      const groups = groupTripsByPattern(
        [
          { tripIdx: 0, stopIdxs: [1, 2] },
          { tripIdx: 1, stopIdxs: [0, 1, 2] },
          { tripIdx: 2, stopIdxs: [0, 1, 2, 3] },
        ],
        PatternMode.CoveringMerge,
      );
      expect(groups).toHaveLength(1);
      expect(groups[0].stopIdxs).toEqual([0, 1, 2, 3]);
      expect(groups[0].tripIdxs).toEqual([2, 1, 0]);
      expect(groups[0].offsets).toEqual([0, 0, 1]); // trip0 composed to 1
    });

    it("a folded group's members all move (multi-trip source folds wholesale)", () => {
      // Two trips share signature [1,2,3]; that group folds into [0,1,2,3,4] @1.
      const groups = groupTripsByPattern(
        [
          { tripIdx: 0, stopIdxs: [0, 1, 2, 3, 4] },
          { tripIdx: 1, stopIdxs: [1, 2, 3] },
          { tripIdx: 2, stopIdxs: [1, 2, 3] }, // same sig as trip 1 → merged first
        ],
        PatternMode.CoveringMerge,
      );
      expect(groups).toHaveLength(1);
      expect(groups[0].tripIdxs).toEqual([0, 1, 2]);
      expect(groups[0].offsets).toEqual([0, 1, 1]);
    });
  });
});
