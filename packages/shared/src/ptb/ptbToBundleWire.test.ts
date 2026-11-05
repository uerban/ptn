/**
 * Tests for ptbBundleToWire — the PTB→wire adapter.
 *
 * Covers:
 *   - PatternMode.Off: one wire-route per .ptb route, longest-trip canonical (unchanged behavior).
 *   - PatternMode.Unbounded: one wire-route per distinct stop-sequence pattern, same route_id
 *     repeated across a route's patterns.
 *   - Single-pattern route: Unbounded output is byte-identical to Off (no-op split).
 *
 * Every bundle is a committed current PTB v1 fixture: the Rust producer's
 * tiny.ptb, or a `pt-core-emit` fixture under
 * packages/frontend/tests/services/__fixtures__.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ptbBundleToWire, type PtbBundleWire } from "./ptbToBundleWire.js";
import { PatternMode } from "../raptor/patternMode.js";
import { loadPtb, type PtbBundle, type PtbPatternBand } from "./loader.js";
import {
  groupTripsByPattern,
  type PatternGroup,
  type TripForGrouping,
} from "../raptor/patternSignature.js";

const FRONTEND_FIXTURES = fileURLToPath(
  new URL("../../../frontend/tests/services/__fixtures__/", import.meta.url),
);

/** Decode a committed fixture from the engine corpus directory. */
function fixture(name: string): PtbBundle {
  return loadPtb(readFileSync(resolve(FRONTEND_FIXTURES, name)));
}

describe("mixed per-trip boarding restrictions", () => {
  it("preserves the same native groups through the band and flat adapters", () => {
    const ptb = fixture("mixed-boarding.ptb");
    for (const mode of [PatternMode.Unbounded, PatternMode.CoveringMerge]) {
      const band = ptbBundleToWire(ptb, mode);
      const flat = ptbBundleToWire({ ...ptb, patternBand: undefined }, mode);
      expect(flat.routes).toEqual(band.routes);
      expect(band.routes).toHaveLength(3);
      expect(band.routes[0]!.trips[0]!.pickupTypes).toEqual([0, 1, 0]);
      expect(band.routes[1]!.trips[0]!.pickupTypes).toBeUndefined();
      expect(band.routes[2]!.trips[0]!.dropOffTypes).toEqual([0, 1, 0]);
    }
  });
});

/** Decode the producer-built tiny.ptb committed with this package. */
function tiny(): PtbBundle {
  return loadPtb(readFileSync(new URL("./__fixtures__/tiny.ptb", import.meta.url)));
}

/**
 * Attach a `boarding` column to a decoded bundle in memory. `ptbBundleToWire`
 * reads `ptb.boarding?.[r]` from the decoded object, so seeding the column
 * directly exercises the ALIGNMENT threading faithfully: real tripStarts/
 * stopTimes/topology from the loader, `boarding[globalRow]` under test.
 * `loader.test.ts` covers decoding real `0x12` semantics from the committed
 * boarding fixtures. `boarding` is a flat per-stop_time column indexed by the
 * GLOBAL stop_time row: trip by trip, each trip's rows in pattern order.
 */
function withBoarding(ptb: PtbBundle, boarding: number[]): PtbBundle {
  if (boarding.length !== ptb.stopTimes.length) {
    throw new Error(`boarding length ${boarding.length} != stopTimes ${ptb.stopTimes.length}`);
  }
  return { ...ptb, boarding: Uint8Array.from(boarding) };
}

// Packed boarding bytes (LSB-first): [1:0]=pickup_type, [3:2]=drop_off_type.
const DEFAULT = 0x50; // pickup 0 / drop_off 0 (continuous_* 1)
const PICKUP_FORBIDDEN = 0x51; // pickup_type=1 (alight-only)
const DROPOFF_FORBIDDEN = 0x54; // drop_off_type=1 (board-only)
const FREQUENCIES_FIXTURE = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "__fixtures__/frequencies-parity.ptb",
);

// ---------------------------------------------------------------------------
// Fixtures used below
// ---------------------------------------------------------------------------
//
// branch-pattern.ptb — one route R with two BRANCHING trips:
//   T0: [s0, s1, s2, s4]  (rows 0-3, 25200..26100)
//   T1: [s0, s1, s3, s4]  (rows 4-7, 28800..29700)
//   Both have 4 stops, so under Off the canonical is T0's sequence (first in
//   routeTrips order wins on equal length, strict `>`).
//
// same-pattern-trips.ptb — one route R0 whose trips TA and TB both serve
//   [s0, s1, s2, s3]: a single pattern in every mode.
//
// covering-merge.ptb — one route R0; T0 [s1,s2,s3] (rows 0-2, 1000..1600) is
//   the window [1..4) of T1 [s0..s4] (rows 3-7, 2000..3200) and folds into it
//   under CoveringMerge at offset 1; T2 runs the reverse and T3/T4/T5 a separate
//   transitive fold.
//
// covering-loop.ptb — one route RL; TC [X,Y,Z,Y,W] (rows 0-4, 28800..29200)
//   repeats Y, and TF [Z,Y,W] (rows 5-7, 50000..51200) folds into it at the
//   ONLY matching window, offset 2.

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ptbBundleToWire — PatternMode", () => {
  it("carries PTB frequencies and stamps trips with global PTB trip ordinals", () => {
    const ptb = loadPtb(readFileSync(FREQUENCIES_FIXTURE));
    const wire = ptbBundleToWire(ptb, PatternMode.Off);

    expect(wire.frequencies).toEqual(ptb.frequencies);

    const wireTrips = wire.routes.flatMap((r) => r.trips);
    expect(wireTrips.map((t) => t.ptbTripIdx).sort((a, b) => a - b)).toEqual(
      ptb.trips.map((_t, i) => i),
    );
    for (const row of ptb.frequencies ?? []) {
      expect(wireTrips.some((t) => t.ptbTripIdx === row.tripIdx)).toBe(true);
    }
  });

  it("rejects invalid frequency exact_times values before emitting the routing wire", () => {
    const ptb = loadPtb(readFileSync(FREQUENCIES_FIXTURE));
    ptb.frequencies![0] = { ...ptb.frequencies![0]!, exactTimes: 2 };

    expect(() => ptbBundleToWire(ptb, PatternMode.Off)).toThrow(/frequency exact_times/);
  });

  it("Off mode: one wire-route per .ptb route (unchanged behavior)", () => {
    const wire = ptbBundleToWire(fixture("branch-pattern.ptb"), PatternMode.Off);
    expect(wire.routes).toHaveLength(1);
    // Canonical = T0's sequence (first in route_trips, equal length → strict > never fires for T1)
    expect(wire.routes[0]!.stopIds).toEqual(["s0", "s1", "s2", "s4"]);
    // Both trips are in the single wire-route
    expect(wire.routes[0]!.trips).toHaveLength(2);
    expect(wire.routes[0]!.id).toBe("R");
  });

  it("Off mode is the default (no second arg)", () => {
    const bundle = fixture("branch-pattern.ptb");
    const withOff = ptbBundleToWire(bundle, PatternMode.Off);
    const withDefault = ptbBundleToWire(bundle);
    expect(withDefault).toEqual(withOff);
  });

  it("emits direction/headsign patterns only when the browser catalog opts in", () => {
    const bundle = tiny();
    const engineWire = ptbBundleToWire(bundle, PatternMode.Off);
    const catalog = ptbBundleToWire(bundle, PatternMode.Off, {
      includeDirectionPatterns: true,
    });

    expect(engineWire.routes[0]!.directionPatterns).toBeUndefined();
    // R1: T1 (direction 0) and T2 (direction 1) both run S1→S2→S3.
    expect(catalog.routes[0]!.directionPatterns).toEqual([
      { key: "0", headsign: "", stopIds: ["S1", "S2", "S3"] },
      { key: "1", headsign: "", stopIds: ["S1", "S2", "S3"] },
    ]);
  });

  it("Unbounded mode: one wire-route per pattern, same route_id repeated", () => {
    const wire = ptbBundleToWire(fixture("branch-pattern.ptb"), PatternMode.Unbounded);
    expect(wire.routes).toHaveLength(2);
    // route_id repeated across both patterns
    expect(wire.routes.map((r) => r.id)).toEqual(["R", "R"]);
    // Pattern 0 (T0's sequence): s0→s1→s2→s4
    expect(wire.routes[0]!.stopIds).toEqual(["s0", "s1", "s2", "s4"]);
    // Pattern 1 (T1's sequence): s0→s1→s3→s4 — branch stop s3 is now present
    expect(wire.routes[1]!.stopIds).toEqual(["s0", "s1", "s3", "s4"]);
    // Each pattern carries exactly one trip
    expect(wire.routes[0]!.trips).toHaveLength(1);
    expect(wire.routes[1]!.trips).toHaveLength(1);
    expect(wire.routes[0]!.trips[0]!.tripId).toBe("T0");
    expect(wire.routes[1]!.trips[0]!.tripId).toBe("T1");
  });

  it("Unbounded mode: single-pattern route is byte-identical to Off", () => {
    const bundle = fixture("same-pattern-trips.ptb");
    const off = ptbBundleToWire(bundle, PatternMode.Off);
    const unbounded = ptbBundleToWire(bundle, PatternMode.Unbounded);
    expect(unbounded).toEqual(off);
  });
});

describe("ptbBundleToWire — CoveringMerge fold (-1 holes)", () => {
  it("mid-window fold: folded trip carries -1 at holes and real times inside its window", () => {
    const wire = ptbBundleToWire(fixture("covering-merge.ptb"), PatternMode.CoveringMerge);

    // T0 folds into T1's pattern; the reverse and transitive cases are separate.
    const route = wire.routes.find((r) => r.stopIds.join(",") === "s0,s1,s2,s3,s4")!;
    expect(route).toBeDefined();
    expect(route.trips).toHaveLength(2);

    // The folded T0 rides positions 1,2,3 of the canonical; positions 0 and 4
    // are -1 holes (un-boardable). It does NOT serve position 0, so its
    // departureSecs[0] === -1 → it sorts FIRST.
    const short = route.trips.find((t) => t.tripId === "T0")!;
    expect(short.departureSecs).toEqual([-1, 1000, 1300, 1600, -1]);

    const long = route.trips.find((t) => t.tripId === "T1")!;
    expect(long.departureSecs).toEqual([2000, 2300, 2600, 2900, 3200]);
  });

  it("repeated-stop case: positional fold places the window where the cursor would mis-place it", () => {
    const wire = ptbBundleToWire(fixture("covering-loop.ptb"), PatternMode.CoveringMerge);

    expect(wire.routes).toHaveLength(1);
    const route = wire.routes[0]!;
    // Canonical repeats Y: [X,Y,Z,Y,W].
    expect(route.stopIds).toEqual(["X", "Y", "Z", "Y", "W"]);
    expect(route.trips).toHaveLength(2);

    // TF [Z,Y,W] folds at the ONLY matching window, offset 2 → positions 2,3,4.
    // The holes are positions 0,1. A from-position-0 cursor would have matched
    // TF's Y to position 1 — this asserts the positional branch wins.
    const tf = route.trips.find((t) => t.tripId === "TF")!;
    expect(tf.departureSecs).toEqual([-1, -1, 50000, 50600, 51200]);

    const tc = route.trips.find((t) => t.tripId === "TC")!;
    expect(tc.departureSecs).toEqual([28800, 28900, 29000, 29100, 29200]);
  });
});

describe("ptbBundleToWire — pickupTypes/dropOffTypes alignment", () => {
  it("absent boarding ⇒ no pickupTypes/dropOffTypes on any trip", () => {
    // Default-only column (every byte 0x50) must omit the arrays entirely — the
    // common case.
    const ptb = withBoarding(fixture("branch-pattern.ptb"), new Array(8).fill(DEFAULT));
    const wire = ptbBundleToWire(ptb, PatternMode.Off);
    for (const trip of wire.routes[0]!.trips) {
      expect(trip.pickupTypes).toBeUndefined();
      expect(trip.dropOffTypes).toBeUndefined();
    }
  });

  it("cursor branch (Off): bytes land on the canonical positions of each trip", () => {
    // branch-pattern global rows: T0: 0=s0,1=s1,2=s2,3=s4   T1: 4=s0,5=s1,6=s3,7=s4
    // Canonical (Off, T0 wins) = [s0,s1,s2,s4]. Mark T0 row 2 (s2) pickup-forbidden
    // and T1 row 6 (s3) drop_off-forbidden.
    const boarding = new Array(8).fill(DEFAULT);
    boarding[2] = PICKUP_FORBIDDEN; // T0's s2 → canonical pos 2
    boarding[6] = DROPOFF_FORBIDDEN; // T1's s3 (off-canonical → dropped under Off)
    const wire = ptbBundleToWire(
      withBoarding(fixture("branch-pattern.ptb"), boarding),
      PatternMode.Off,
    );

    expect(wire.routes[0]!.stopIds).toEqual(["s0", "s1", "s2", "s4"]);
    const t0 = wire.routes[0]!.trips.find((t) => t.tripId === "T0")!;
    expect(t0.pickupTypes).toEqual([0, 0, 1, 0]); // s2 alight-only at canonical pos 2
    expect(t0.dropOffTypes).toBeUndefined(); // T0 has no forbidden drop_off

    // T1's s3 is off-canonical under Off → its cursor drops that row (no canonical
    // position), so its drop_off-forbidden byte does NOT land. T1 serves s0,s1,s4.
    const t1 = wire.routes[0]!.trips.find((t) => t.tripId === "T1")!;
    expect(t1.pickupTypes).toBeUndefined();
    expect(t1.dropOffTypes).toBeUndefined();
  });

  it("Unbounded: each pattern carries its own canonical-aligned boarding column", () => {
    // Under Unbounded, T1 gets its own pattern [s0,s1,s3,s4] so s3's byte lands.
    const boarding = new Array(8).fill(DEFAULT);
    boarding[2] = PICKUP_FORBIDDEN; // T0 s2
    boarding[6] = DROPOFF_FORBIDDEN; // T1 s3
    const wire = ptbBundleToWire(
      withBoarding(fixture("branch-pattern.ptb"), boarding),
      PatternMode.Unbounded,
    );

    const t0Route = wire.routes.find((r) => r.stopIds.includes("s2"))!;
    expect(t0Route.trips[0]!.pickupTypes).toEqual([0, 0, 1, 0]); // s2 @ pos 2

    const t1Route = wire.routes.find((r) => r.stopIds.includes("s3"))!;
    expect(t1Route.stopIds).toEqual(["s0", "s1", "s3", "s4"]);
    expect(t1Route.trips[0]!.dropOffTypes).toEqual([0, 0, 1, 0]); // s3 @ pos 2
    expect(t1Route.trips[0]!.pickupTypes).toBeUndefined();
  });

  it("covering-merge fold (offset>0): byte lands at canonical pos = offset+i", () => {
    // covering-merge: T0 [s1,s2,s3] rows 0-2 folds into T1 [s0..s4] at offset 1.
    // Mark T0's FIRST row (s1, the trip's pos 0) pickup-forbidden → it must land
    // at canonical position offset+0 = 1; its row 2 (s3) → position 1+2 = 3.
    const ptb = fixture("covering-merge.ptb");
    const boarding = new Array(ptb.stopTimes.length).fill(DEFAULT);
    boarding[0] = PICKUP_FORBIDDEN; // T0 row i=0 → fold pos = offset(1)+0 = 1
    boarding[2] = DROPOFF_FORBIDDEN; // T0 row i=2 (s3) → fold pos = 1+2 = 3
    const wire = ptbBundleToWire(withBoarding(ptb, boarding), PatternMode.CoveringMerge);

    const route = wire.routes.find((r) => r.stopIds.join(",") === "s0,s1,s2,s3,s4")!;
    const short = route.trips.find((t) => t.tripId === "T0")!;
    // Real departures only inside [offset, offset+len) = positions 1,2,3.
    expect(short.departureSecs).toEqual([-1, 1000, 1300, 1600, -1]);
    // The byte rode the positional fold: pickup at pos 1, drop_off at pos 3.
    expect(short.pickupTypes).toEqual([0, 1, 0, 0, 0]);
    expect(short.dropOffTypes).toEqual([0, 0, 0, 1, 0]);

    // T1 (all-default) carries no arrays.
    const long = route.trips.find((t) => t.tripId === "T1")!;
    expect(long.pickupTypes).toBeUndefined();
    expect(long.dropOffTypes).toBeUndefined();
  });

  it("covering-merge fold over a REPEATED-stop covering pattern places the byte positionally", () => {
    // covering-loop: TC [X,Y,Z,Y,W] rows 0-4; TF [Z,Y,W] rows 5-7 folds at
    // offset 2 (the ONLY matching window). Marking TF's second row (Y) must land
    // at canonical pos offset+1 = 3, NOT pos 1 where a cursor would match the
    // first Y — exactly the desync this test guards.
    const boarding = new Array(8).fill(DEFAULT);
    boarding[6] = PICKUP_FORBIDDEN; // TF row i=1 (Y) → fold pos = offset(2)+1 = 3
    const wire = ptbBundleToWire(
      withBoarding(fixture("covering-loop.ptb"), boarding),
      PatternMode.CoveringMerge,
    );

    const route = wire.routes[0]!;
    expect(route.stopIds).toEqual(["X", "Y", "Z", "Y", "W"]);
    const tf = route.trips.find((t) => t.tripId === "TF")!;
    expect(tf.departureSecs).toEqual([-1, -1, 50000, 50600, 51200]);
    // Positional fold: byte at pos 3 (the second Y), NOT pos 1.
    expect(tf.pickupTypes).toEqual([0, 0, 0, 1, 0]);
  });

  it("boarding is per stop_time: a repeated stop carries it on one occurrence only (lasso)", () => {
    // lasso.ptb: T0 over [s0,s1,s2,s3,s4,s2,s1,s0]. Forbid pickup on the RETURN
    // s1 (row 6) only; the outbound s1 (row 1) stays boardable.
    const boarding = new Array(8).fill(DEFAULT);
    boarding[6] = PICKUP_FORBIDDEN;
    const wire = ptbBundleToWire(withBoarding(fixture("lasso.ptb"), boarding), PatternMode.Off);

    const route = wire.routes[0]!;
    expect(route.stopIds).toEqual(["s0", "s1", "s2", "s3", "s4", "s2", "s1", "s0"]);
    expect(route.trips[0]!.pickupTypes).toEqual([0, 0, 0, 0, 0, 0, 1, 0]);
  });
});

describe("ptbBundleToWire — calendar endDate follows runtime windowDays", () => {
  // The wire calendar is range-based (`startDate`/`endDate` + weekly `days[]`),
  // so the ONLY way a window longer than 90 days reaches the on-device engine is
  // by widening `endDate` to `feedStartDate + windowDays - 1`. A hardcoded 90
  // would silently truncate the on-disk window (days 90..N-1 dropped) — the I18
  // correctness bug this guards.
  //
  // Dates computed in UTC to mirror ptbToBundleWire's `addDays` (Date.UTC based)
  // and to stay stable on the UTC+3 dev box vs UTC CI.

  it("400-day fixture: endDate = feedStartDate + 399 (NOT +89)", () => {
    const w400 = fileURLToPath(new URL("./__fixtures__/window400.ptb", import.meta.url));
    const bundle = loadPtb(readFileSync(w400));
    expect(bundle.windowDays).toBe(400);
    expect(bundle.feedStartDate).toBe(20260619);

    const wire = ptbBundleToWire(bundle, PatternMode.Off);
    expect(wire.calendar.length).toBeGreaterThan(0);
    for (const svc of wire.calendar) {
      expect(svc.startDate).toBe("20260619");
      // feedStartDate(20260619) + 399 days = 20270723 (UTC). The buggy hardcoded
      // 90 would yield 20260916 (feedStartDate + 89) and drop days 90..399.
      expect(svc.endDate).toBe("20270723");
    }
  });

  it("90-day fixture: endDate = feedStartDate + 89 (unchanged behavior)", () => {
    const bundle = fixture("branch-pattern.ptb");
    expect(bundle.windowDays).toBe(90);
    expect(bundle.feedStartDate).toBe(20260501);

    const wire = ptbBundleToWire(bundle, PatternMode.Off);
    expect(wire.calendar.length).toBeGreaterThan(0);
    for (const svc of wire.calendar) {
      expect(svc.startDate).toBe("20260501");
      // feedStartDate(20260501) + 89 days = 20260729 (UTC).
      expect(svc.endDate).toBe("20260729");
    }
  });
});

describe("ptbBundleToWire — per-day fidelity via base + computed exceptions (Step A.11)", () => {
  // The wire calendar must be an EXACT representation of the per-day bitmask:
  // weekly `days[]` base + `exceptions[]` that diff the bitmask against the base.
  // A clean weekly feed yields few/zero exceptions; a non-weekly feed yields the
  // exceptions needed to make the resolved active-set equal the bitmask EXACTLY.
  //
  // Dates computed in UTC to mirror ptbToBundleWire's `addDays` (Date.UTC based)
  // and to stay stable on the UTC+3 dev box vs UTC CI (MEMORY tz landmine).

  const FEED_START = 20260601; // a Monday — day-offset n has weekday n % 7 (0=Mon)

  /**
   * A single-service, single-route bundle whose decoded service window is
   * replaced by `bitmask` anchored at FEED_START. `ptbBundleToWire` derives the
   * calendar from these decoded fields, so substituting them tests the
   * derivation for any day pattern.
   */
  function bundleWithBitmask(bitmask: Uint8Array): PtbBundle {
    const ptb = fixture("bikes-skip.ptb"); // one route, one trip, one service, 90 days
    expect(ptb.numServices).toBe(1);
    expect(ptb.windowDays).toBe(90);
    return { ...ptb, feedStartDate: FEED_START, serviceBitmasks: bitmask };
  }

  /** UTC Mon-first (0=Mon..6=Sun) weekday of a YYYYMMDD integer. */
  function monFirst(ymd: number): number {
    const jsDay = new Date(
      Date.UTC(Math.floor(ymd / 10000), Math.floor((ymd % 10000) / 100) - 1, ymd % 100),
    ).getUTCDay();
    return jsDay === 0 ? 6 : jsDay - 1;
  }
  /** Add n days to a YYYYMMDD integer in UTC. */
  function addDays(ymd: number, n: number): number {
    const dt = new Date(
      Date.UTC(Math.floor(ymd / 10000), Math.floor((ymd % 10000) / 100) - 1, (ymd % 100) + n),
    );
    return dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate();
  }

  /**
   * Resolve whether a wire calendar entry is active on `ymd`, mirroring the GTFS
   * calendar semantics `serviceDay.ts::resolveActiveServicesForYmd` implements
   * (verified there): exception 1 ⇒ active regardless of weekday; exception 2 ⇒
   * inactive regardless of weekday; otherwise [startDate,endDate] range + weekday.
   */
  function wireActive(svc: PtbBundleWire["calendar"][number], ymd: number): boolean {
    const dateStr = String(ymd).padStart(8, "0");
    const exc = svc.exceptions[dateStr];
    if (exc === 2) return false;
    if (exc === 1) return true;
    if (dateStr < svc.startDate || dateStr > svc.endDate) return false;
    return svc.days[monFirst(ymd)] === true;
  }

  it("a NON-weekly bitmask round-trips to an EXACT active-set via base + exceptions", () => {
    // Deliberately non-weekly: active Mon/Wed/Fri for the first 6 weeks, then
    // Mondays-only for the rest of the 90-day window. The weekly base alone
    // (first-occurrence-per-weekday) marks every Wed/Fri active across the WHOLE
    // window — wrong past week 6 — so exceptions are load-bearing.
    const bitmask = new Uint8Array(12);
    for (let n = 0; n < 90; n++) {
      const wd = n % 7; // 0=Mon..6=Sun (FEED_START is Monday)
      const active = n < 42 ? wd === 0 || wd === 2 || wd === 4 : wd === 0;
      if (active) bitmask[n >> 3]! |= 1 << (n & 7);
    }
    const wire = ptbBundleToWire(bundleWithBitmask(bitmask), PatternMode.Off);
    expect(wire.calendar).toHaveLength(1);
    const svc = wire.calendar[0]!;

    // EXACTNESS: resolve the wire (base+exceptions) on every window day and compare
    // to the bitmask bit. This is the per-day-fidelity guarantee.
    for (let n = 0; n < 90; n++) {
      const ymd = addDays(FEED_START, n);
      const bit = ((bitmask[n >> 3]! >> (n & 7)) & 1) === 1;
      expect(wireActive(svc, ymd), `wire active != bitmask on offset ${n} (${ymd})`).toBe(bit);
    }
    // The exceptions must be load-bearing (a non-weekly feed cannot be exact via
    // the weekly base alone) and bounded by windowDays.
    expect(Object.keys(svc.exceptions).length).toBeGreaterThan(0);
    expect(Object.keys(svc.exceptions).length).toBeLessThanOrEqual(90);
    // Every recorded exception value is a valid GTFS type (1=added, 2=removed).
    for (const v of Object.values(svc.exceptions)) expect([1, 2]).toContain(v);
  });

  it("an ALL-ACTIVE bitmask yields ZERO exceptions (clean weekly ⇒ base alone is exact)", () => {
    const wire = ptbBundleToWire(bundleWithBitmask(new Uint8Array(12).fill(0xff)), PatternMode.Off);
    const svc = wire.calendar[0]!;
    expect(svc.days).toEqual([true, true, true, true, true, true, true]);
    expect(svc.exceptions).toEqual({});
  });

  it("a clean weekly (Mon/Wed/Fri) bitmask yields only the sparse-tail removals, never an added/removed mismatch", () => {
    // Active Mon/Wed/Fri EVERY week across the full 90-day window. The weekly base
    // captures it exactly within the boundary; the only exceptions are the
    // ~13-day margin tail (days past the last clean week the bitmask can hold).
    const bitmask = new Uint8Array(12);
    for (let n = 0; n < 90; n++) {
      const wd = n % 7;
      if (wd === 0 || wd === 2 || wd === 4) bitmask[n >> 3]! |= 1 << (n & 7);
    }
    const wire = ptbBundleToWire(bundleWithBitmask(bitmask), PatternMode.Off);
    const svc = wire.calendar[0]!;
    // Base captures Mon/Wed/Fri.
    expect(svc.days).toEqual([true, false, true, false, true, false, false]);
    // Round-trip exact (same exactness proof as above).
    for (let n = 0; n < 90; n++) {
      const ymd = addDays(FEED_START, n);
      const bit = ((bitmask[n >> 3]! >> (n & 7)) & 1) === 1;
      expect(wireActive(svc, ymd)).toBe(bit);
    }
  });
});

describe("ptbBundleToWire — existing behavior (regression, defaults to Off)", () => {
  it("produces the expected wire shape for tiny.ptb", () => {
    const bundle = tiny();
    const wire = ptbBundleToWire(bundle);
    // tiny-gtfs has 2 routes (R1, R2) with 2 trips each.
    expect(wire.routes).toHaveLength(2);
    expect(wire.routes[0]!.id).toBe("R1");
    expect(wire.routes[1]!.id).toBe("R2");
    // R1's trips: T1 (07:00), T2 (08:00) — canonical S1→S2→S3 (3 stops)
    expect(wire.routes[0]!.stopIds).toEqual(["S1", "S2", "S3"]);
    expect(wire.routes[0]!.trips).toHaveLength(2);
    expect(wire.routes[0]!.trips.map((trip) => trip.directionId)).toEqual([0, 1]);
    // R2's trips: T3 (09:00 reverse), T4 (10:00) — canonical is the longest; both 3-stop
    // T3's sorted sequence is S3→S2→S1 (seqs 1,2,3), T4 is S1→S2→S3 — first trip wins tie
    expect(wire.routes[1]!.stopIds).toEqual(["S3", "S2", "S1"]);
    expect(wire.routes[1]!.trips).toHaveLength(2);
    expect(wire.routes[1]!.trips.map((trip) => trip.directionId)).toEqual([0, 1]);
    // Calendar derived from 2 services
    expect(wire.calendar).toHaveLength(2);
    // Stops round-trip
    expect(wire.stops.map((s) => s.id)).toEqual(["S1", "S2", "S3"]);
  });

  it("uses direction_id as direction-pattern identity when present", () => {
    const bundle = tiny();
    const wire = ptbBundleToWire(bundle, PatternMode.Off, {
      includeDirectionPatterns: true,
    });
    expect(wire.routes[0]!.directionPatterns?.map((pattern) => pattern.key)).toEqual(["0", "1"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B1.4 Task A — band-sourced grouping over the committed current v1 fixture.
//
// The Rust-built `pattern-band-tiny.ptb` carries the `0x10`-`0x14` pattern band
// under current PTB v1. It lives under
// packages/frontend/tests/services/__fixtures__. We locate it via the same
// repo-root walk
// patternBandDecode.test.ts / crates/pt-core/tests/raptor_behavior.rs use.
//
// After the B1.4 cutover, `ptbBundleToWire(bundle, Unbounded|CoveringMerge)`
// sources its per-route GROUPING from the band's `0x14 TripMeta.pattern_idx` +
// `0x11 PatternStops` (mirroring Rust `build_from_band`), NOT from
// `groupTripsByPattern` over flat signatures. The band-sourced grouping MUST be
// EQUIVALENT to `groupTripsByPattern(.., mode)` over the flat per-trip stop-idx
// sequences (the equivalence anchor — the band IS the grouping). The loader
// materializes the flat timetable view from the carry-less band, so the per-trip
// `departureSecs`/`dwellSecs` arrays match the longest-canonical flat emission for
// each group.
// ─────────────────────────────────────────────────────────────────────────────

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "packages/shared/src/ptb/__fixtures__/tiny.ptb"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error("ptbToBundleWire.test: could not locate repo root from " + process.cwd());
}
const BAND_PTB = resolve(
  findRepoRoot(),
  "packages/frontend/tests/services/__fixtures__/pattern-band-tiny.ptb",
);

/**
 * Build the route_trips-ordered `TripForGrouping[]` from the FLAT carry of the
 * decoded bundle — each trip's stop-idx sequence is its `stopTimes` slice
 * (tripStarts prefix-sum), sorted by `stop_seq` (Pin 1, repeats preserved),
 * iterated in `routeTripsValues` order. This is the INDEPENDENT decode the
 * equivalence anchor folds against (NOT a band read).
 */
function tripsFromFlatCarry(ptb: PtbBundle): TripForGrouping[] {
  const out: TripForGrouping[] = [];
  for (const tripIdx of Array.from(ptb.routeTripsValues)) {
    const lo = ptb.tripStarts[tripIdx]!;
    const hi = ptb.tripStarts[tripIdx + 1]!;
    const rows = ptb.stopTimes.slice(lo, hi).sort((a, b) => a.stopSeq - b.stopSeq);
    out.push({ tripIdx, stopIdxs: rows.map((r) => r.stopIdx) });
  }
  return out;
}

/** Map a wire-route's `stopIds` back to stop ORDINALS for sequence comparison. */
function stopIdxsOf(wire: PtbBundleWire, stopIds: string[]): number[] {
  const ordinalOf = new Map(wire.stops.map((s, i) => [s.id, i] as const));
  return stopIds.map((id) => {
    const i = ordinalOf.get(id);
    if (i === undefined) throw new Error(`unknown stop id ${id}`);
    return i;
  });
}

describe("ptbBundleToWire — band-sourced grouping (B1.4, pattern-band-tiny.ptb v1)", () => {
  it("loads as a v1 bundle that carries the pattern band", () => {
    const ptb = loadPtb(readFileSync(BAND_PTB));
    expect(ptb.version).toBe(1);
    expect(ptb.patternBand).toBeDefined();
    expect(ptb.patternBand!.numPatterns).toBe(3);
  });

  for (const mode of [PatternMode.Unbounded, PatternMode.CoveringMerge] as const) {
    const label = mode === PatternMode.Unbounded ? "Unbounded" : "CoveringMerge";

    it(`[${label}] the band-sourced wire grouping equals groupTripsByPattern(flat, ${label})`, () => {
      const ptb = loadPtb(readFileSync(BAND_PTB));
      const wire = ptbBundleToWire(ptb, mode);
      const groups: PatternGroup[] = groupTripsByPattern(tripsFromFlatCarry(ptb), mode);

      // One wire-route per surviving group, in enumeration order.
      expect(wire.routes).toHaveLength(groups.length);

      for (let g = 0; g < groups.length; g++) {
        const route = wire.routes[g]!;
        // Same route_id repeated across a route's patterns.
        expect(route.id).toBe("R0");
        // Per-group canonical stop sequence (order + repeats), via ordinal map.
        expect(stopIdxsOf(wire, route.stopIds)).toEqual(groups[g]!.stopIdxs);
        // Per-group member TRIP set (the wire sorts trips by departureSecs[0], so
        // compare as a set against the band/grouping membership).
        const wireTripIds = route.trips.map((t) => t.tripId).sort();
        const groupTripIds = groups[g]!.tripIdxs.map((t) => ptb.trips[t]!.tripId).sort();
        expect(wireTripIds).toEqual(groupTripIds);
      }
    });

    it(`[${label}] departures stay sourced from the flat rows (board/alight times match the flat-carry emission)`, () => {
      const ptb = loadPtb(readFileSync(BAND_PTB));
      const wire = ptbBundleToWire(ptb, mode);
      // Departures are read from the flat 0xF4 rows via the UNCHANGED emitWireRoute
      // cursor (Design A: band for grouping, flat for times). Pattern A
      // [s0,s1,s2,s4] carries trips 0 (LOCAL, s0@25200), 3 (EXPRESS-SKIP, s0@36000
      // but s2 sentinel-poked → -1 hole at pos 2) and 4 (SKIP-POS-0, boards s1 →
      // pos 0 is the -1 hole). Sorted by departureSecs[0] (sentinel -1 first), the
      // order is trip4(-1), trip0(25200), trip3(36000).
      const patternA = wire.routes.find(
        (r) => stopIdxsOf(wire, r.stopIds).join(",") === [0, 1, 2, 4].join(","),
      );
      expect(patternA, "pattern A [s0,s1,s2,s4] present").toBeDefined();
      // Pos-0 departures, in the wire's sorted trip order, taken from the FLAT rows.
      const pos0 = patternA!.trips.map((t) => t.departureSecs[0]);
      expect(pos0).toEqual([-1, 25200, 36000]);
      // The express-skip trip (s0@36000) has its s2 (pos 2) sentinel-poked → -1
      // hole in the flat carry; the band path must preserve it (no band-synthesised
      // time). That trip is index 2 in the sorted order.
      const expressTrip = patternA!.trips.find((t) => t.departureSecs[0] === 36000)!;
      expect(expressTrip.departureSecs[2]).toBe(-1);
      // And a served interior stop carries its real flat departure (trip 0 s1@25500).
      const localTrip = patternA!.trips.find((t) => t.departureSecs[0] === 25200)!;
      expect(localTrip.departureSecs[1]).toBe(25500);
    });
  }

  it("[Off] stays flat (longest-trip lasso canonical) regardless of band presence", () => {
    const ptb = loadPtb(readFileSync(BAND_PTB));
    const wire = ptbBundleToWire(ptb, PatternMode.Off);
    // Off path: ONE wire-route, canonical = the longest trip (the lasso
    // [s0,s1,s2,s1,s4], 5 stops > the 4-stop patterns A/B). The band is ignored.
    expect(wire.routes).toHaveLength(1);
    expect(stopIdxsOf(wire, wire.routes[0]!.stopIds)).toEqual([0, 1, 2, 1, 4]);
  });

  // ── DISTINCT-SAME-STOP: the test that DISTINGUISHES pattern_idx grouping from
  // signature re-grouping ─────────────────────────────────────────────────────
  //
  // The committed band fixtures all have distinct `pattern_idx` ⟹ distinct `0x11`
  // stop signatures, so pattern_idx grouping and `stopIdxs.join(",")` re-signing
  // coincide there. The locked-layout spec
  // ALSO allows TWO DISTINCT patterns over the SAME stop sequence (semantics-annotated
  // vs plain). The pre-fix `groupFromBand` re-signed each pattern's `0x11` slice
  // and fed it to `groupTripsByPattern`, which keys on `stopIdxs.join(",")` — so
  // two same-stop patterns COLLAPSED into one wire-route, diverging from Rust
  // `build_from_band` (which groups by `pattern_idx`). This test hand-builds that
  // case and asserts the band path keeps them as 2 SEPARATE wire-routes.
  //
  // Exactly as `withBoarding` hand-attaches `boarding`, we decode a committed
  // bundle then replace its `patternBand` with a synthetic one whose two patterns
  // share the SAME `0x11` stop sequence. No committed bundle distinguishes
  // pattern_idx from the `0x11` signature yet, so this hand-built band is the only
  // way to exercise the divergence today.
  it("[Unbounded] two DISTINCT pattern_idx over the SAME stops stay 2 wire-routes (signature re-grouping would merge to 1)", () => {
    // same-pattern-trips: trips TA, TB BOTH serve [s0,s1,s2,s3] (stop idx
    // [0,1,2,3]); identical stop sequence by construction.
    const ptb = fixture("same-pattern-trips.ptb");
    expect(ptb.trips.map((t) => t.tripId)).toEqual(["TA", "TB"]);
    const sameStops = Uint32Array.from([0, 1, 2, 3]);

    // Synthetic band: 2 DISTINCT patterns, IDENTICAL `0x11` slice [0,1,2,3].
    // Pattern 0 ← trip 0 (TA); pattern 1 ← trip 1 (TB). The grouping fields read by
    // `groupFromBand`/`tripPatternFromBand` are `numPatterns`, `patterns[]`,
    // `patternStops`, `patternTrips*`; the rest are inert for the wire grouping but
    // required by the type, so they get minimal-valid placeholders.
    const band: PtbPatternBand = {
      numPatterns: 2,
      patterns: [
        { stopsOff: 0, stopCount: 4, flags: 0 }, // pattern 0 → [0,1,2,3]
        { stopsOff: 4, stopCount: 4, flags: 0 }, // pattern 1 → [0,1,2,3] (SAME stops)
      ],
      patternStops: Uint32Array.from([...sameStops, ...sameStops]),
      patternSemantics: undefined,
      tripTimes: { offset: 0, length: 0 },
      tripMeta: { offset: 0, length: 0 },
      patternsAtStopOffsets: Uint32Array.from([0, 0, 0, 0, 0]),
      patternsAtStopValues: Uint32Array.from([]),
      patternTripsOffsets: Uint32Array.from([0, 1, 2]), // pattern 0 → [trip 0], pattern 1 → [trip 1]
      patternTripsValues: Uint32Array.from([0, 1]),
      tripTimesEntryFlags: 0,
    };
    const withBand: PtbBundle = { ...ptb, patternBand: band };

    // Faithful (pattern_idx) grouping: 2 distinct patterns ⟹ 2 wire-routes, even
    // though their stop sequences are identical.
    const wire = ptbBundleToWire(withBand, PatternMode.Unbounded);
    expect(wire.routes).toHaveLength(2);
    expect(wire.routes.map((r) => r.id)).toEqual(["R0", "R0"]);
    expect(stopIdxsOf(wire, wire.routes[0]!.stopIds)).toEqual([0, 1, 2, 3]);
    expect(stopIdxsOf(wire, wire.routes[1]!.stopIds)).toEqual([0, 1, 2, 3]);
    // Each pattern carries exactly its own trip (TA on pattern 0, TB on pattern 1).
    expect(wire.routes[0]!.trips.map((t) => t.tripId)).toEqual(["TA"]);
    expect(wire.routes[1]!.trips.map((t) => t.tripId)).toEqual(["TB"]);

    // Counter-proof: signature re-grouping (the PRE-FIX behavior) over the SAME
    // band-sourced `stopIdxs` would key both patterns to "0,1,2,3" and collapse
    // them to ONE group — i.e. the bug this fix removes.
    const reSigned = groupTripsByPattern(
      [
        { tripIdx: 0, stopIdxs: [0, 1, 2, 3] },
        { tripIdx: 1, stopIdxs: [0, 1, 2, 3] },
      ],
      PatternMode.Unbounded,
    );
    expect(reSigned).toHaveLength(1); // the wrong (collapsed) result the fix avoids
  });

  // ── FAIL-CLOSED: a trip claimed by NO pattern (`0x46` omits it) must THROW, not
  // silently default to pattern 0 ─────────────────────────────────────────────
  //
  // `tripPatternFromBand` zero-inits its `trip_idx → pattern_idx` map and only
  // writes the trips present in some `0x46 PatternTrips` slice. A trip absent from
  // every slice would keep the zero-init value (pattern 0) and silently fold into
  // pattern 0's group — diverging from Rust `build_from_band`, which ERRORS on an
  // out-of-range `0x14` pattern_idx (`Corrupt("0x14 trip pattern_idx out of
  // range")`). The real load path can't hit this (the loader cross-checks
  // `0x14 ↔ 0x46` set-identity at decode), but the hand-constructed band path can,
  // so the guard must be symmetric: init the sentinel `0xffffffff` and throw when a
  // trip is claimed by no pattern.
  it("[Unbounded] a trip omitted from every 0x46 slice THROWS (fail-closed, not silent pattern 0)", () => {
    // Two trips TA, TB (route_trips [0, 1]); band has ONE pattern claiming ONLY
    // trip 0. Trip 1 (TB) is claimed by no pattern → must throw, not default to 0.
    const ptb = fixture("same-pattern-trips.ptb");
    expect(ptb.trips.map((t) => t.tripId)).toEqual(["TA", "TB"]);
    const band: PtbPatternBand = {
      numPatterns: 1,
      patterns: [{ stopsOff: 0, stopCount: 4, flags: 0 }], // pattern 0 → [0,1,2,3]
      patternStops: Uint32Array.from([0, 1, 2, 3]),
      patternSemantics: undefined,
      tripTimes: { offset: 0, length: 0 },
      tripMeta: { offset: 0, length: 0 },
      patternsAtStopOffsets: Uint32Array.from([0, 0, 0, 0, 0]),
      patternsAtStopValues: Uint32Array.from([]),
      // Pattern 0 claims ONLY trip 0; trip 1 (TB) is claimed by NO pattern.
      patternTripsOffsets: Uint32Array.from([0, 1]),
      patternTripsValues: Uint32Array.from([0]),
      tripTimesEntryFlags: 0,
    };
    const withBand: PtbBundle = { ...ptb, patternBand: band };
    expect(() => ptbBundleToWire(withBand, PatternMode.Unbounded)).toThrow(/ptb:/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The current PTB v1 engine-regression cohort decodes its pattern band.
//
// The engine-regression gate (crates/pt-core/tests/raptor_behavior.rs) routes the
// current PTB v1 carry-less band cohort through
// `ptbBundleToWire(.., Unbounded|CoveringMerge)`, which sources its grouping from
// the band ONLY when `ptb.patternBand` is defined — else it silently falls back to
// the FLAT `groupTripsByPattern` path. A fixture that decoded to `patternBand
// === undefined` (a loader regression, or a fixture rebuilt without `0x10`) would
// make the gate exercise the FLAT path while still passing — the band path goes
// untested with no signal. Pin the band presence + per-fixture pattern count here
// so a band-absent regression fails loudly. (2/2/3/6 = the Unbounded pattern count
// of branch/lasso/converging/covering-merge, before any CoveringMerge fold.)
// ─────────────────────────────────────────────────────────────────────────────
describe("ptbBundleToWire — current PTB v1 cohort decodes its pattern band (band-on-both)", () => {
  const COHORT: ReadonlyArray<readonly [string, number]> = [
    ["branch-pattern.ptb", 2],
    ["lasso-multipattern.ptb", 2],
    ["converging-multipattern.ptb", 3],
    ["covering-merge.ptb", 6],
  ];
  const fixDir = resolve(findRepoRoot(), "packages/frontend/tests/services/__fixtures__");

  for (const [file, expectedPatterns] of COHORT) {
    it(`${file} loads as current PTB v1 with a decoded band of ${expectedPatterns} patterns`, () => {
      const ptb = loadPtb(readFileSync(resolve(fixDir, file)));
      expect(ptb.version).toBe(1);
      expect(ptb.patternBand, `${file}: expected a decoded pattern band (band-on-both)`).toBeDefined();
      expect(ptb.patternBand!.numPatterns, `${file}: band pattern count`).toBe(expectedPatterns);
    });
  }
});
