/**
 * B1.5 — unit test for the shared band → flat `{ stopTimes, tripStarts, boarding }`
 * decoder (`@pt/shared` SoT; `loadPtb` calls it on the carry-less materialization
 * path).
 *
 * Two halves:
 *   1. TIMES — materialize == flat carry over the committed Rust-built
 *      `pattern-band-tiny.ptb` (the same oracle the backend test used): trip-idx
 *      order, tripStarts prefix-sum, per-row stopIdx/dep/arrDiff incl. the
 *      NOT_SERVED holes and the lasso repeat.
 *   2. BOARDING — the `0x12 PatternSemantics` → flat `0xFA` expansion. NO committed
 *      band fixture carries a non-default `0x12` (every band is all-regular), so we
 *      prove the mapping with a SYNTHETIC band: load the real fixture, then call
 *      the decoder with a band whose `patternSemantics` + per-pattern `flags` are
 *      hand-set. The `0x13` time slab is read from the REAL buffer (unchanged) —
 *      only the boarding column is synthetic, isolating the `0x12` decode.
 *
 * pattern-band-tiny: single route, five trips, three patterns
 *   A=[0,1,2,4] (trips 0,3,4), B=[0,1,3,4] (trip 1), C=[0,1,2,1,4] lasso (trip 2)
 *   tripStarts = [0,4,8,13,17,21] (4+4+5+4+4 = 21 rows).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPtb, type PtbPatternBand } from "./loader.js";
import { bandToFlatStopTimes } from "./bandToFlatStopTimes.js";

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "packages/shared/src/ptb/__fixtures__/tiny.ptb"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error("bandToFlatStopTimes.test: could not locate repo root from " + process.cwd());
}
const BAND_PTB = resolve(
  findRepoRoot(),
  "packages/frontend/tests/services/__fixtures__/pattern-band-tiny.ptb",
);
// Carry-less PTB v1 fixture whose 0x13 TripTimes region uses the i32-delta variant
// (entryFlags bit1 = 0x0002). One trip, three stops; the >9.1h dwell at stop 2
// has a dep/dwell delta outside i16 range, forcing the whole region to i32.
const I32_PTB = resolve(
  findRepoRoot(),
  "packages/frontend/tests/services/__fixtures__/overnight-i32.ptb",
);

const NOT_SERVED = 0xffffffff;
const PATTERN_FLAG_ALL_REGULAR = 0b0000_0001;

describe("bandToFlatStopTimes (shared) — TIMES materialize == flat carry (pattern-band-tiny v1)", () => {
  it("reproduces the flat carry's tripStarts prefix-sum exactly (trip_idx order)", () => {
    const buf = readFileSync(BAND_PTB);
    const ptnb = loadPtb(buf);
    expect(ptnb.patternBand).toBeDefined();

    const { tripStarts } = bandToFlatStopTimes(ptnb.patternBand!, buf, ptnb.trips.length);
    expect(Array.from(tripStarts)).toEqual(Array.from(ptnb.tripStarts));
    expect(Array.from(tripStarts)).toEqual([0, 4, 8, 13, 17, 21]);
  });

  it("reproduces every flat-carry row (stopIdx / dep incl. NOT_SERVED / arrDiff), in trip_idx order", () => {
    const buf = readFileSync(BAND_PTB);
    const ptnb = loadPtb(buf);
    const { stopTimes } = bandToFlatStopTimes(ptnb.patternBand!, buf, ptnb.trips.length);

    expect(stopTimes.length).toBe(ptnb.stopTimes.length);
    for (let r = 0; r < ptnb.stopTimes.length; r++) {
      const want = ptnb.stopTimes[r]!;
      const got = stopTimes[r]!;
      expect(got.stopIdx).toBe(want.stopIdx);
      expect(got.depSecs).toBe(want.depSecs);
      expect(got.arrDiff).toBe(want.arrDiff);
    }
  });

  it("preserves the express-skip and skip-pos-0 NOT_SERVED sentinels at the right rows", () => {
    const buf = readFileSync(BAND_PTB);
    const ptnb = loadPtb(buf);
    const { stopTimes, tripStarts } = bandToFlatStopTimes(ptnb.patternBand!, buf, ptnb.trips.length);

    const t3 = stopTimes.slice(tripStarts[3]!, tripStarts[4]!);
    expect(t3.map((s) => s.stopIdx)).toEqual([0, 1, 2, 4]);
    expect(t3[2]!.depSecs).toBe(NOT_SERVED);
    expect(t3.filter((_, i) => i !== 2).every((s) => s.depSecs !== NOT_SERVED)).toBe(true);

    const t4 = stopTimes.slice(tripStarts[4]!, tripStarts[5]!);
    expect(t4.map((s) => s.stopIdx)).toEqual([0, 1, 2, 4]);
    expect(t4[0]!.depSecs).toBe(NOT_SERVED);
    expect(t4.slice(1).every((s) => s.depSecs !== NOT_SERVED)).toBe(true);
  });

  it("reproduces the lasso repeated-stop sequence (trip 2 pattern C = [0,1,2,1,4])", () => {
    const buf = readFileSync(BAND_PTB);
    const ptnb = loadPtb(buf);
    const { stopTimes, tripStarts } = bandToFlatStopTimes(ptnb.patternBand!, buf, ptnb.trips.length);

    const t2 = stopTimes.slice(tripStarts[2]!, tripStarts[3]!);
    expect(t2.map((s) => s.stopIdx)).toEqual([0, 1, 2, 1, 4]);
    const flat2 = ptnb.stopTimes.slice(ptnb.tripStarts[2]!, ptnb.tripStarts[3]!);
    expect(t2.map((s) => s.depSecs)).toEqual(flat2.map((s) => s.depSecs));
  });

  it("stopSeq is monotonic non-decreasing per trip (canonical position order)", () => {
    const buf = readFileSync(BAND_PTB);
    const ptnb = loadPtb(buf);
    const { stopTimes, tripStarts } = bandToFlatStopTimes(ptnb.patternBand!, buf, ptnb.trips.length);
    for (let trip = 0; trip < ptnb.trips.length; trip++) {
      const rows = stopTimes.slice(tripStarts[trip]!, tripStarts[trip + 1]!);
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.stopSeq).toBeGreaterThan(rows[i - 1]!.stopSeq);
      }
    }
  });
});

describe("bandToFlatStopTimes (shared) — i32-delta 0x13 variant (overnight-i32)", () => {
  // The Rust oracle decodes this carry-less PTB v1 fixture (0x13 entryFlags=0x0002,
  // i32 deltas) to these EXACT values — the TS i32 decode must match byte-for-byte:
  //   stop 0: dep 36000, arr 36000
  //   stop 1: dep 64800, arr 64620 (dwell -180)
  //   stop 2: dep 91800, arr 91500 (dwell -300, the >9.1h position that overflows i16)
  const EXPECTED = [
    { dep: 36000, arr: 36000 },
    { dep: 64800, arr: 64620 },
    { dep: 91800, arr: 91500 },
  ];

  it("loadPtb attaches the band with i32 entryFlags (0x0002) and does not throw", () => {
    const buf = readFileSync(I32_PTB);
    const ptnb = loadPtb(buf);
    expect(ptnb.patternBand).toBeDefined();
    expect(ptnb.patternBand!.tripTimesEntryFlags).toBe(0x0002);
  });

  it("decodes i32 dep/dwell deltas to the exact Rust-oracle dep AND arr at all three stops", () => {
    const buf = readFileSync(I32_PTB);
    const ptnb = loadPtb(buf);
    const { stopTimes, tripStarts } = bandToFlatStopTimes(
      ptnb.patternBand!,
      buf,
      ptnb.trips.length,
    );

    expect(Array.from(tripStarts)).toEqual([0, 3]);
    expect(stopTimes.length).toBe(3);
    for (let pos = 0; pos < 3; pos++) {
      const row = stopTimes[pos]!;
      // arr = dep + arrDiff (dwell_delta <= 0). The stop-2 arr (91500) specifically
      // catches a mis-strided dwell sub-array — the i16 stride would mis-read it.
      expect(row.depSecs).toBe(EXPECTED[pos]!.dep);
      expect(row.depSecs + row.arrDiff).toBe(EXPECTED[pos]!.arr);
    }
  });

  it("materializes via loadPtb's carry-less path identically (loadPtb stopTimes == decoder)", () => {
    // The fixture is carry-less, so loadPtb itself materializes from the band via
    // bandToFlatStopTimes. Its exposed stopTimes must already carry the i32 values.
    const buf = readFileSync(I32_PTB);
    const ptnb = loadPtb(buf);
    expect(ptnb.stopTimes.length).toBe(3);
    for (let pos = 0; pos < 3; pos++) {
      const row = ptnb.stopTimes[pos]!;
      expect(row.depSecs).toBe(EXPECTED[pos]!.dep);
      expect(row.depSecs + row.arrDiff).toBe(EXPECTED[pos]!.arr);
    }
  });
});

describe("bandToFlatStopTimes (shared) — BOARDING from 0x12 PatternSemantics", () => {
  it("all-regular band (real fixture, no 0x12) ⇒ boarding undefined (omit-when-all-default)", () => {
    const buf = readFileSync(BAND_PTB);
    const ptnb = loadPtb(buf);
    expect(ptnb.patternBand!.patternSemantics).toBeUndefined();
    const { boarding } = bandToFlatStopTimes(ptnb.patternBand!, buf, ptnb.trips.length);
    expect(boarding).toBeUndefined();
  });

  it("non-default 0x12 expands to the flat 0xFA packing at the right rows (synthetic band)", () => {
    // Load the real fixture, then synthesize a band with a non-default 0x12. We
    // make pattern A (idx 0, stops [0,1,2,4], the 4-stop pattern) NON-all-regular
    // with per-position semantics:
    //   pos0 pickup_type=1 (0x12=0b0000_0001=0x01) → flat 0xFA = 0x01 | 0x50 = 0x51
    //   pos1 drop_off_type=1 (0x12=0b0000_0100=0x04) → flat 0xFA = 0x04 | 0x50 = 0x54
    //   pos2 regular (0x00) → flat 0xFA = 0x50
    //   pos3 pickup=2 + drop_off=3 (0x12=0b0000_1110=0x0e) → flat 0xFA = 0x0e | 0x50 = 0x5e
    // Patterns B and C stay all-regular (contribute no 0x12 bytes). The per-pattern
    // 0x12 base is therefore Σ stopCount over EARLIER non-all-regular patterns = 0
    // for A. The time slab still reads from the REAL buffer (unchanged).
    const buf = readFileSync(BAND_PTB);
    const ptnb = loadPtb(buf);
    const real = ptnb.patternBand!;
    expect(real.numPatterns).toBe(3);
    expect(real.patterns[0]!.stopCount).toBe(4); // pattern A

    const semBytes = Uint8Array.from([0x01, 0x04, 0x00, 0x0e]); // pattern A's 4 positions
    // Clone the band; flip pattern A's all-regular flag OFF and attach 0x12.
    const patterns = real.patterns.map((p, i) =>
      i === 0 ? { ...p, flags: p.flags & ~PATTERN_FLAG_ALL_REGULAR } : { ...p },
    );
    const band: PtbPatternBand = {
      ...real,
      patterns,
      patternSemantics: semBytes,
    };

    const { stopTimes, tripStarts, boarding } = bandToFlatStopTimes(band, buf, ptnb.trips.length);
    expect(boarding).toBeDefined();
    expect(boarding!.length).toBe(stopTimes.length);

    // The expected flat 0xFA byte per canonical position of pattern A.
    const EXP_A = [0x51, 0x54, 0x50, 0x5e];

    // Trips on pattern A are 0, 3, 4 (each a 4-row slice). Every A-trip's boarding
    // must equal EXP_A position-for-position — the per-position semantics are
    // SHARED across the pattern's trips (locked-layout invariant), independent of
    // whether the trip serves the position (express-skip rows still carry the
    // position's semantics byte).
    for (const trip of [0, 3, 4]) {
      const lo = tripStarts[trip]!;
      const hi = tripStarts[trip + 1]!;
      const slice = Array.from(boarding!.subarray(lo, hi));
      expect(slice).toEqual(EXP_A);
    }

    // Trips on patterns B (trip 1) and C (trip 2) are all-regular ⇒ every byte 0x50.
    for (const trip of [1, 2]) {
      const lo = tripStarts[trip]!;
      const hi = tripStarts[trip + 1]!;
      const slice = Array.from(boarding!.subarray(lo, hi));
      expect(slice.every((b) => b === 0x50)).toBe(true);
    }
  });

  it("per-pattern 0x12 base skips EARLIER all-regular patterns (base = Σ stopCount over non-all-regular)", () => {
    // Make ONLY pattern C (idx 2, the lasso, stopCount 5) non-all-regular. Patterns
    // A and B stay all-regular and contribute NO 0x12 bytes, so pattern C's base is
    // 0 (NOT 4+4=8) — the Σ-over-earlier-non-all-regular rule. If the decoder
    // wrongly summed ALL earlier stopCounts it would read past the 5-byte 0x12.
    const buf = readFileSync(BAND_PTB);
    const ptnb = loadPtb(buf);
    const real = ptnb.patternBand!;
    expect(real.patterns[2]!.stopCount).toBe(5); // pattern C (lasso)

    // C's 5 positions: pos3 (the lasso revisit of s1) gets drop_off=1.
    const semBytes = Uint8Array.from([0x00, 0x00, 0x00, 0x04, 0x00]);
    const patterns = real.patterns.map((p, i) =>
      i === 2 ? { ...p, flags: p.flags & ~PATTERN_FLAG_ALL_REGULAR } : { ...p },
    );
    const band: PtbPatternBand = { ...real, patterns, patternSemantics: semBytes };

    const { tripStarts, boarding } = bandToFlatStopTimes(band, buf, ptnb.trips.length);
    expect(boarding).toBeDefined();

    // Trip 2 is pattern C; its 5 boarding bytes are EXP_C (base 0, read correctly).
    const EXP_C = [0x50, 0x50, 0x50, 0x54, 0x50];
    const lo = tripStarts[2]!;
    const hi = tripStarts[3]!;
    expect(Array.from(boarding!.subarray(lo, hi))).toEqual(EXP_C);

    // Patterns A (trips 0,3,4) and B (trip 1) are all-regular ⇒ all 0x50.
    for (const trip of [0, 1, 3, 4]) {
      const slice = Array.from(boarding!.subarray(tripStarts[trip]!, tripStarts[trip + 1]!));
      expect(slice.every((b) => b === 0x50)).toBe(true);
    }
  });
});
