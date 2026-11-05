/**
 * Realign-branch pickup/drop_off coverage.
 *
 * index-builder.ts has two branches in the pattern-realign loop:
 *   offset > 0  — CoveringMerge folded member: row i lands at position offset+i.
 *   offset === 0 — native member (Off/Unbounded) or prefix-fold: uses a
 *                  per-stop occurrence cursor.
 *
 * The per-route canonical fill also has its own loop (lines ~260-294).
 *
 * These tests assert that a non-zero pickup_type / drop_off_type value set on a
 * TripStopSeqEntry arrives at the CORRECT aligned position in the emitted
 * RouteTripEntry.pickupTypes / dropOffTypes Uint8Array — not at some re-computed
 * position, not dropped, and not mixed with a neighbour.
 *
 * GTFS reference: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
 */

import { describe, it, expect } from "vitest";
import { buildRouteTripsIndex } from "../../src/gtfs/index-builder.js";
import type { TripStopSeqEntry } from "../../src/gtfs/index-builder.js";
import { PatternMode } from "@pt/shared";

// ── Fixture: off-canonical branch route under Unbounded (offset === 0 realign) ──
//
// Route R1:
//   LOCAL  : S0 → S1 → S2   (trip TL — canonical, pickup_type=1 at S1)
//   BRANCH : S0 → S3 → S2   (trip TB — off-canonical branch, drop_off_type=1 at S3)
//
// S3 is NOT on the canonical (TL) trip.  Under Unbounded, S3's pattern is a
// genuinely separate pattern ([S0, S3, S2]) built via the offset===0 branch.
// The test asserts:
//   • TL's pickupType=1 at S1 lands at pattern position 1 (S1's position in LOCAL).
//   • TB's dropOffType=1 at S3 lands at pattern position 1 (S3's position in BRANCH).
//   • Neither value leaks to the sibling pattern.

describe("index-builder realign: pickup/drop_off at offset===0 (Unbounded off-canonical branch)", () => {
  const tripsIndex = new Map([
    ["TL", { tripId: "TL", routeId: "R1", serviceId: "WD", headsign: "Local" }],
    ["TB", { tripId: "TB", routeId: "R1", serviceId: "WD", headsign: "Branch" }],
  ]);

  // TL: S0@08:00 → S1@08:10 (pickup_type=1) → S2@08:20
  // TB: S0@09:00 → S3@09:10 (drop_off_type=1) → S2@09:20
  const tripStopSeqs = new Map<string, TripStopSeqEntry[]>([
    ["TL", [
      { stopId: "S0", departureSecs: 28800, seq: 1 },
      { stopId: "S1", departureSecs: 29400, seq: 2, pickupType: 1 },
      { stopId: "S2", departureSecs: 30000, seq: 3 },
    ]],
    ["TB", [
      { stopId: "S0", departureSecs: 32400, seq: 1 },
      { stopId: "S3", departureSecs: 33000, seq: 2, dropOffType: 1 },
      { stopId: "S2", departureSecs: 33600, seq: 3 },
    ]],
  ]);

  it("LOCAL pattern: pickupType=1 at S1 lands at position 1 (not dropped, not shifted)", () => {
    const result = buildRouteTripsIndex(tripStopSeqs, tripsIndex, PatternMode.Unbounded);
    // Two distinct patterns
    expect(result).toHaveLength(2);

    const localPattern = result.find((r) => r.stopIds.includes("S1"))!;
    expect(localPattern, "LOCAL pattern not found").toBeDefined();
    expect(localPattern.stopIds).toEqual(["S0", "S1", "S2"]);

    const tl = localPattern.trips.find((t) => t.tripId === "TL")!;
    expect(tl, "TL trip not in LOCAL pattern").toBeDefined();

    // pickup_type=1 must be at position 1 (S1)
    expect(tl.pickupTypes, "pickupTypes must be defined (has non-zero entry)").toBeDefined();
    expect(tl.pickupTypes![1]).toBe(1); // S1's position
    // Position 0 (S0) must be absent / 0 (regular stop)
    expect(tl.pickupTypes![0] ?? 0).toBe(0);
    // Position 2 (S2) must also be absent / 0
    expect(tl.pickupTypes![2] ?? 0).toBe(0);
    // dropOffTypes must be absent for TL (all default)
    expect(tl.dropOffTypes).toBeUndefined();
  });

  it("BRANCH pattern: dropOffType=1 at S3 lands at position 1 (not dropped, not shifted)", () => {
    const result = buildRouteTripsIndex(tripStopSeqs, tripsIndex, PatternMode.Unbounded);

    const branchPattern = result.find((r) => r.stopIds.includes("S3"))!;
    expect(branchPattern, "BRANCH pattern not found").toBeDefined();
    expect(branchPattern.stopIds).toEqual(["S0", "S3", "S2"]);

    const tb = branchPattern.trips.find((t) => t.tripId === "TB")!;
    expect(tb, "TB trip not in BRANCH pattern").toBeDefined();

    // drop_off_type=1 must be at position 1 (S3)
    expect(tb.dropOffTypes, "dropOffTypes must be defined (has non-zero entry)").toBeDefined();
    expect(tb.dropOffTypes![1]).toBe(1); // S3's position
    // Position 0 (S0) must be 0
    expect(tb.dropOffTypes![0] ?? 0).toBe(0);
    // Position 2 (S2) must be 0
    expect(tb.dropOffTypes![2] ?? 0).toBe(0);
    // pickupTypes must be absent for TB (all default)
    expect(tb.pickupTypes).toBeUndefined();
  });

  it("LOCAL's pickupType does NOT leak into the BRANCH pattern's trip TB", () => {
    const result = buildRouteTripsIndex(tripStopSeqs, tripsIndex, PatternMode.Unbounded);
    const branchPattern = result.find((r) => r.stopIds.includes("S3"))!;
    const tb = branchPattern.trips.find((t) => t.tripId === "TB")!;
    // TB should have no pickupType=1 leaking from TL's S1 flag
    if (tb.pickupTypes) {
      for (let i = 0; i < branchPattern.stopIds.length; i++) {
        expect(tb.pickupTypes[i] ?? 0, `TB.pickupTypes[${i}] should be 0`).toBe(0);
      }
    }
  });
});

// ── Fixture: CoveringMerge folded member with pickup_type at the folded window (offset > 0) ──
//
// Route RL:
//   COVER : X → Y → Z → Y → W   (trip TC)            — Y repeats (lasso/loop)
//   FOLD  : Z → Y → W           (trip TF, offset=2)  — contiguous window [2, 4]
//              ^-- pickup_type=1 at Z (position 2 in covering, position 0 in TF's own seq)
//
// The offset>0 branch must place row 0's pickupType at covering position offset+0 = 2.
// A naive from-position-0 cursor would place it at covering position 2 (Z@first) — same
// in this case — but the key assertion is that the Uint8Array slot matches offset+i, NOT
// a re-searched position.

describe("index-builder realign: pickup/drop_off at offset>0 (CoveringMerge folded member)", () => {
  const tripsIndex = new Map([
    ["TC", { tripId: "TC", routeId: "RL", serviceId: "WD", headsign: "Loop" }],
    ["TF", { tripId: "TF", routeId: "RL", serviceId: "WD", headsign: "Short" }],
  ]);

  // TC: X@08:00 → Y@08:10 → Z@08:20 → Y@08:30 → W@08:40   (no flags)
  // TF: Z@13:53 (pickup_type=1) → Y@13:56 → W@13:59
  //     Folded window offset=2: covering positions [2, 3, 4] = [Z, Y(2nd), W]
  const tripStopSeqs = new Map<string, TripStopSeqEntry[]>([
    ["TC", [
      { stopId: "X", departureSecs: 28800, seq: 1 },
      { stopId: "Y", departureSecs: 29400, seq: 2 },
      { stopId: "Z", departureSecs: 30000, seq: 3 },
      { stopId: "Y", departureSecs: 30600, seq: 4 },
      { stopId: "W", departureSecs: 31200, seq: 5 },
    ]],
    ["TF", [
      { stopId: "Z", departureSecs: 50000, seq: 1, pickupType: 1 }, // boarding forbidden at Z
      { stopId: "Y", departureSecs: 50600, seq: 2 },
      { stopId: "W", departureSecs: 51200, seq: 3 },
    ]],
  ]);

  it("folded trip TF's pickupType=1 at Z lands at covering position 2 (offset+0=2), not at position 4", () => {
    const result = buildRouteTripsIndex(tripStopSeqs, tripsIndex, PatternMode.CoveringMerge);
    // CoveringMerge collapses both into one covering pattern
    expect(result).toHaveLength(1);
    const cover = result[0]!;
    expect(cover.stopIds).toEqual(["X", "Y", "Z", "Y", "W"]);

    const tf = cover.trips.find((t) => t.tripId === "TF")!;
    expect(tf, "TF trip not in covering pattern").toBeDefined();

    // TF's folded window: offset=2, so:
    //   position 2 = Z  (TF row 0, pickupType=1)
    //   position 3 = Y  (TF row 1, no flag)
    //   position 4 = W  (TF row 2, no flag)
    expect(tf.pickupTypes, "pickupTypes must be defined for TF").toBeDefined();
    expect(tf.pickupTypes![2]).toBe(1);  // Z at covering position 2 ← offset+0
    expect(tf.pickupTypes![3] ?? 0).toBe(0); // second Y — no flag
    expect(tf.pickupTypes![4] ?? 0).toBe(0); // W — no flag
    // Pre-window positions (0=X, 1=first-Y) must be 0 (unserved, no flag)
    expect(tf.pickupTypes![0] ?? 0).toBe(0);
    expect(tf.pickupTypes![1] ?? 0).toBe(0);
  });

  it("covering trip TC has no pickup flags (all positions 0)", () => {
    const result = buildRouteTripsIndex(tripStopSeqs, tripsIndex, PatternMode.CoveringMerge);
    const cover = result[0]!;
    const tc = cover.trips.find((t) => t.tripId === "TC")!;
    // TC has no pickup_type flags
    expect(tc.pickupTypes).toBeUndefined();
    expect(tc.dropOffTypes).toBeUndefined();
  });
});
