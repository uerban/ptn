import { describe, it, expect } from "vitest";
import { PatternMode } from "@pt/shared";
import {
  activeRouteIdsAtStop,
  hasUpcomingDeparture,
  stopActivityDecidable,
  stopMaybeActive,
} from "../../src/services/hasUpcomingDeparture.ts";
import {
  hydrate,
  type RaptorIndex,
  type RaptorIndexRoute,
  type RaptorIndexService,
} from "../../src/services/raptorIndex.ts";

// Helpers ---------------------------------------------------------------

function fixtureIndex(opts: {
  routes: Array<{
    id: string;
    stopIds: string[];
    /**
     * Optional per-direction stop sequences. When provided, return-only
     * stops (in `directionPatterns[i].stopIds` but not in canonical
     * `stopIds`) are included in `routesAtStop` — mirroring the
     * production `raptorIndex.ts` builder.
     */
    directionPatterns?: Array<{ key: string; headsign: string; stopIds: string[] }>;
    trips: Array<{ tripId: string; serviceId: string; departureSecs: number[]; headsign?: string }>;
  }>;
  services: Array<{
    serviceId: string;
    days: [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
    startDate: string;
    endDate: string;
    exceptions?: Record<string, number>;
  }>;
}): RaptorIndex {
  const routes: RaptorIndexRoute[] = opts.routes.map((r) => ({
    id: r.id,
    shortName: r.id,
    mode: "BUS",
    stopIds: r.stopIds,
    trips: r.trips.map((t) => ({
      tripId: t.tripId,
      serviceId: t.serviceId,
      headsign: t.headsign ?? "",
      departureSecs: t.departureSecs,
    })),
    ...(r.directionPatterns ? { directionPatterns: r.directionPatterns } : {}),
  }));
  const routeIdToIdx = new Map<string, number>();
  const routesAtStop = new Map<string, number[]>();
  for (let i = 0; i < routes.length; i++) {
    routeIdToIdx.set(routes[i].id, i);
    const stopSet = new Set<string>(routes[i].stopIds);
    for (const dp of routes[i].directionPatterns ?? []) {
      for (const sid of dp.stopIds) stopSet.add(sid);
    }
    for (const stopId of stopSet) {
      let arr = routesAtStop.get(stopId);
      if (!arr) { arr = []; routesAtStop.set(stopId, arr); }
      arr.push(i);
    }
  }
  const services = new Map<string, RaptorIndexService>();
  for (const s of opts.services) {
    services.set(s.serviceId, {
      serviceId: s.serviceId,
      days: s.days,
      startDate: s.startDate,
      endDate: s.endDate,
      exceptions: s.exceptions ?? {},
    });
  }
  return { routes, routeIdToIdx, routesAtStop, services };
}

// A Wednesday in 2026 — any permutation works as long as tests pick the
// right day-of-week for the service.
const WEDNESDAY_10_00 = new Date(2026, 3, 22, 10, 0, 0); // Apr 22, 2026 is a Wednesday
const WEDNESDAY_0_30 = new Date(2026, 3, 22, 0, 30, 0);
const DAY_MASK_MON_FRI: [boolean, boolean, boolean, boolean, boolean, boolean, boolean] = [
  true, true, true, true, true, false, false,
];
const DAY_MASK_WEEKEND_ONLY: [boolean, boolean, boolean, boolean, boolean, boolean, boolean] = [
  false, false, false, false, false, true, true,
];

// Tests -----------------------------------------------------------------

describe("hasUpcomingDeparture", () => {
  it("returns false when the stop is unknown to the index", () => {
    const idx = fixtureIndex({ routes: [], services: [] });
    expect(hasUpcomingDeparture("ghost", WEDNESDAY_10_00, 2, idx)).toBe(false);
  });

  it("returns true when a trip departs inside the lookahead window", () => {
    const idx = fixtureIndex({
      routes: [
        {
          id: "r1",
          stopIds: ["s1", "s2"],
          trips: [
            // 10:30 at s1 = 10*3600 + 30*60 = 37800 secs since midnight
            { tripId: "t1", serviceId: "svc", departureSecs: [37800, 38400] },
          ],
        },
      ],
      services: [
        { serviceId: "svc", days: DAY_MASK_MON_FRI, startDate: "20260101", endDate: "20271231" },
      ],
    });
    expect(hasUpcomingDeparture("s1", WEDNESDAY_10_00, 2, idx)).toBe(true);
  });

  it("returns false when the only trip is outside the window", () => {
    const idx = fixtureIndex({
      routes: [
        {
          id: "r1",
          stopIds: ["s1"],
          // 15:00 — 5 hours away from 10:00, outside a 2h window
          trips: [{ tripId: "t1", serviceId: "svc", departureSecs: [54000] }],
        },
      ],
      services: [
        { serviceId: "svc", days: DAY_MASK_MON_FRI, startDate: "20260101", endDate: "20271231" },
      ],
    });
    expect(hasUpcomingDeparture("s1", WEDNESDAY_10_00, 2, idx)).toBe(false);
  });

  it("ignores trips on inactive services (night-only stop at midday)", () => {
    const idx = fixtureIndex({
      routes: [
        {
          id: "rN6",
          stopIds: ["s1"],
          // 10:30 within window, but the service only runs weekends
          trips: [{ tripId: "night-1", serviceId: "night", departureSecs: [37800] }],
        },
      ],
      services: [
        { serviceId: "night", days: DAY_MASK_WEEKEND_ONLY, startDate: "20260101", endDate: "20271231" },
      ],
    });
    expect(hasUpcomingDeparture("s1", WEDNESDAY_10_00, 2, idx)).toBe(false);
  });

  it("handles cross-midnight: 0:30 AM today picks up yesterday's overnight trip (dep > 86400)", () => {
    const idx = fixtureIndex({
      routes: [
        {
          id: "rLate",
          stopIds: ["s1"],
          // Tuesday's service, departure at 25:00 = 90000 s = 1:00 AM Wed
          trips: [{ tripId: "late-1", serviceId: "svc", departureSecs: [90000] }],
        },
      ],
      services: [
        { serviceId: "svc", days: DAY_MASK_MON_FRI, startDate: "20260101", endDate: "20271231" },
      ],
    });
    expect(hasUpcomingDeparture("s1", WEDNESDAY_0_30, 2, idx)).toBe(true);
  });

  it("short-circuits across multiple routes at the same stop", () => {
    const idx = fixtureIndex({
      routes: [
        // Route 1: dep outside window
        {
          id: "r1",
          stopIds: ["s1"],
          trips: [{ tripId: "t1", serviceId: "svc", departureSecs: [54000] }],
        },
        // Route 2: dep inside window — should be the answer
        {
          id: "r2",
          stopIds: ["s1"],
          trips: [{ tripId: "t2", serviceId: "svc", departureSecs: [37800] }],
        },
      ],
      services: [
        { serviceId: "svc", days: DAY_MASK_MON_FRI, startDate: "20260101", endDate: "20271231" },
      ],
    });
    expect(hasUpcomingDeparture("s1", WEDNESDAY_10_00, 2, idx)).toBe(true);
  });

  it("respects calendar_dates exception type 2 (service removed today)", () => {
    const idx = fixtureIndex({
      routes: [
        {
          id: "r1",
          stopIds: ["s1"],
          trips: [{ tripId: "t1", serviceId: "svc", departureSecs: [37800] }],
        },
      ],
      services: [
        {
          serviceId: "svc",
          days: DAY_MASK_MON_FRI,
          startDate: "20260101",
          endDate: "20271231",
          exceptions: { "20260422": 2 }, // removed for Apr 22
        },
      ],
    });
    expect(hasUpcomingDeparture("s1", WEDNESDAY_10_00, 2, idx)).toBe(false);
  });

  it("excludes trips whose departureSecs[stopIdx] is undefined (sparse columnar)", () => {
    const idx: RaptorIndex = fixtureIndex({
      routes: [
        {
          id: "r1",
          stopIds: ["s1", "s2"],
          trips: [{ tripId: "t1", serviceId: "svc", departureSecs: [37800] }], // only s1, not s2
        },
      ],
      services: [
        { serviceId: "svc", days: DAY_MASK_MON_FRI, startDate: "20260101", endDate: "20271231" },
      ],
    });
    expect(hasUpcomingDeparture("s2", WEDNESDAY_10_00, 2, idx)).toBe(false);
    expect(hasUpcomingDeparture("s1", WEDNESDAY_10_00, 2, idx)).toBe(true);
  });
});

describe("activeRouteIdsAtStop", () => {
  it("returns an empty set when the stop is unknown to the index", () => {
    const idx = fixtureIndex({ routes: [], services: [] });
    expect(activeRouteIdsAtStop("ghost", WEDNESDAY_10_00, 2, idx).size).toBe(0);
  });

  it("returns only routes with an in-window departure, omitting out-of-window routes at the same stop", () => {
    const idx = fixtureIndex({
      routes: [
        // In-window — should be in the set
        {
          id: "r-day",
          stopIds: ["s1"],
          trips: [{ tripId: "t-day", serviceId: "svc", departureSecs: [37800] }],
        },
        // Out-of-window (15:00) — should be excluded
        {
          id: "r-evening",
          stopIds: ["s1"],
          trips: [{ tripId: "t-evening", serviceId: "svc", departureSecs: [54000] }],
        },
      ],
      services: [
        { serviceId: "svc", days: DAY_MASK_MON_FRI, startDate: "20260101", endDate: "20271231" },
      ],
    });
    const active = activeRouteIdsAtStop("s1", WEDNESDAY_10_00, 2, idx);
    expect(Array.from(active).sort()).toEqual(["r-day"]);
  });

  it("excludes routes whose only in-window trip belongs to an inactive service (night-only at midday)", () => {
    const idx = fixtureIndex({
      routes: [
        {
          id: "r-night",
          stopIds: ["s1"],
          trips: [{ tripId: "t-n", serviceId: "night", departureSecs: [37800] }],
        },
        {
          id: "r-day",
          stopIds: ["s1"],
          trips: [{ tripId: "t-d", serviceId: "weekday", departureSecs: [37800] }],
        },
      ],
      services: [
        { serviceId: "night", days: DAY_MASK_WEEKEND_ONLY, startDate: "20260101", endDate: "20271231" },
        { serviceId: "weekday", days: DAY_MASK_MON_FRI, startDate: "20260101", endDate: "20271231" },
      ],
    });
    const active = activeRouteIdsAtStop("s1", WEDNESDAY_10_00, 2, idx);
    expect(Array.from(active).sort()).toEqual(["r-day"]);
  });

  it("includes routes whose only matching trip is yesterday's overnight (cross-midnight)", () => {
    const idx = fixtureIndex({
      routes: [
        {
          id: "r-late",
          stopIds: ["s1"],
          trips: [{ tripId: "late-1", serviceId: "svc", departureSecs: [90000] }],
        },
      ],
      services: [
        { serviceId: "svc", days: DAY_MASK_MON_FRI, startDate: "20260101", endDate: "20271231" },
      ],
    });
    const active = activeRouteIdsAtStop("s1", WEDNESDAY_0_30, 2, idx);
    expect(Array.from(active).sort()).toEqual(["r-late"]);
  });

  it("counts a route as active at a return-only stop when a matching-direction trip is in-window", () => {
    // Bidirectional route r1. Canonical sequence (longest single trip) is
    // the forward direction ["s1", "s2"]. The return direction visits
    // ["s2-rev", "s1-rev"] — distinct stop_ids because each side of the
    // road is its own GTFS stop. Per-trip `departureSecs` is keyed by
    // the canonical sequence (wire format), so there is no exact time at
    // the return-only stops. The reverse trip's `headsign` matches the
    // headsign of the direction pattern that contains s1-rev — that is
    // the link the filter uses to know the trip serves the return-only
    // stop. The time axis remains over-approximated.
    const idx = fixtureIndex({
      routes: [
        {
          id: "r1",
          stopIds: ["s1", "s2"],
          directionPatterns: [
            { key: "0", headsign: "to-s2", stopIds: ["s1", "s2"] },
            { key: "1", headsign: "to-s1", stopIds: ["s2-rev", "s1-rev"] },
          ],
          // Reverse-direction trip — headsign matches dp[1] which contains
          // s1-rev. Canonical departure 10:30 falls inside the 2h window.
          trips: [
            { tripId: "t-rev", serviceId: "svc", headsign: "to-s1", departureSecs: [37800, 38400] },
          ],
        },
      ],
      services: [
        { serviceId: "svc", days: DAY_MASK_MON_FRI, startDate: "20260101", endDate: "20271231" },
      ],
    });
    const active = activeRouteIdsAtStop("s1-rev", WEDNESDAY_10_00, 2, idx);
    expect(Array.from(active).sort()).toEqual(["r1"]);
  });

  it("excludes a return-only stop's route when only opposite-direction trips are in-window", () => {
    // Regression for: urban-mode badge `40` showing at `Ukmergės st.` (a
    // return-only stop on the reverse direction of Vilnius bus 40) even
    // when no trip in the reverse direction is in the lookahead window.
    // The route's reverse direction visits ["s2-rev", "s1-rev"]; only a
    // forward trip (headsign "to-s2") departs in window. The previous
    // over-approximation counted any in-window trip on the canonical
    // sequence as activity at every return-only stop — which lit up the
    // badge for trips that don't actually visit the stop. Narrow to trips
    // whose headsign matches a direction pattern that contains the stop.
    const idx = fixtureIndex({
      routes: [
        {
          id: "r1",
          stopIds: ["s1", "s2"],
          directionPatterns: [
            { key: "0", headsign: "to-s2", stopIds: ["s1", "s2"] },
            { key: "1", headsign: "to-s1", stopIds: ["s2-rev", "s1-rev"] },
          ],
          trips: [
            // Forward trip — in-window, but doesn't visit s1-rev.
            {
              tripId: "t-fwd",
              serviceId: "svc",
              headsign: "to-s2",
              departureSecs: [37800, 38400],
            },
            // Reverse trip — out-of-window (15:00, beyond a 2h window from 10:00).
            {
              tripId: "t-rev",
              serviceId: "svc",
              headsign: "to-s1",
              departureSecs: [54000, 54600],
            },
          ],
        },
      ],
      services: [
        { serviceId: "svc", days: DAY_MASK_MON_FRI, startDate: "20260101", endDate: "20271231" },
      ],
    });
    // s1-rev is a return-only stop on the reverse direction (headsign "to-s1").
    // Only the reverse trip serves it; that trip is out of window → no
    // active route at s1-rev.
    expect(activeRouteIdsAtStop("s1-rev", WEDNESDAY_10_00, 2, idx).size).toBe(0);
    // Sanity: s1 (canonical) IS active because the forward trip departs in window.
    expect(Array.from(activeRouteIdsAtStop("s1", WEDNESDAY_10_00, 2, idx))).toEqual(["r1"]);
  });

  it("excludes a return-only stop's route when the only matching-direction trip is out of window", () => {
    // Same pattern as the matching-direction positive test, but the only
    // reverse-direction trip is at 15:00 — outside the 2h window from
    // 10:00. Isolates the time-axis check from the direction-match check.
    const idx = fixtureIndex({
      routes: [
        {
          id: "r1",
          stopIds: ["s1", "s2"],
          directionPatterns: [
            { key: "0", headsign: "to-s2", stopIds: ["s1", "s2"] },
            { key: "1", headsign: "to-s1", stopIds: ["s2-rev", "s1-rev"] },
          ],
          trips: [
            { tripId: "t-rev", serviceId: "svc", headsign: "to-s1", departureSecs: [54000, 54600] },
          ],
        },
      ],
      services: [
        { serviceId: "svc", days: DAY_MASK_MON_FRI, startDate: "20260101", endDate: "20271231" },
      ],
    });
    expect(activeRouteIdsAtStop("s1-rev", WEDNESDAY_10_00, 2, idx).size).toBe(0);
  });
});

// Pattern-exact path ------------------------------------------------------
//
// Production hydrates the index with PATTERN_MODE (CoveringMerge), which
// populates `patterns`/`patternsAtStop`: one route-shaped entry per trip
// pattern, whose trips' `departureSecs` are aligned to the PATTERN's OWN
// stop sequence. That makes departure times readable at EVERY served stop —
// including "return-only" stops the canonical-column model could not read.
// These tests pin the exact-read semantics that replace the headsign
// over-approximation (and the structural fail-open in `stopMaybeActive`).

/** Build a production-shaped index through the real `hydrate` with
 *  per-pattern route records (the CoveringMerge wire shape). */
function patternFixture(opts: {
  records: Array<{
    id: string;
    stopIds: string[];
    directionPatterns?: Array<{ key: string; headsign: string; stopIds: string[] }>;
    trips: Array<{
      tripId: string;
      serviceId: string;
      headsign?: string;
      ptbTripIdx?: number;
      departureSecs: number[];
    }>;
  }>;
  services: Array<{
    serviceId: string;
    days: [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
    startDate: string;
    endDate: string;
    exceptions?: Record<string, number>;
  }>;
  frequencies?: Array<{
    tripIdx: number;
    startSecs: number;
    endSecs: number;
    headwaySecs: number;
    exactTimes: 0 | 1;
  }>;
}): RaptorIndex {
  return hydrate(
    {
      routeRecords: opts.records.map((r) => ({
        id: r.id,
        shortName: r.id,
        mode: "BUS" as const,
        stopIds: r.stopIds,
        ...(r.directionPatterns ? { directionPatterns: r.directionPatterns } : {}),
        trips: r.trips.map((t) => ({
          tripId: t.tripId,
          serviceId: t.serviceId,
          headsign: t.headsign ?? "",
          ...(t.ptbTripIdx !== undefined ? { ptbTripIdx: t.ptbTripIdx } : {}),
          departureSecs: t.departureSecs,
        })),
      })),
      tripRecords: [],
      serviceRecords: opts.services.map((s) => ({
        serviceId: s.serviceId,
        days: s.days,
        startDate: s.startDate,
        endDate: s.endDate,
        exceptions: s.exceptions ?? {},
      })),
      stopRecords: [],
      ...(opts.frequencies ? { frequencyRecords: opts.frequencies } : {}),
    },
    undefined,
    PatternMode.CoveringMerge,
  );
}

/** Bidirectional route r1: forward pattern s1→s2, reverse pattern
 *  s2-rev→s1-rev (opposite-side-of-road sibling stop_ids). Direction
 *  patterns mirror the network wire so the LEGACY fallback also sees the
 *  reverse stops — the tests assert the pattern path overrides it. */
function bidiFixture(trips: {
  fwd?: Array<{ tripId: string; departureSecs: number[] }>;
  rev?: Array<{ tripId: string; departureSecs: number[] }>;
}): RaptorIndex {
  return patternFixture({
    records: [
      {
        id: "r1",
        stopIds: ["s1", "s2"],
        directionPatterns: [
          { key: "0", headsign: "to-s2", stopIds: ["s1", "s2"] },
          { key: "1", headsign: "to-s1", stopIds: ["s2-rev", "s1-rev"] },
        ],
        trips: (trips.fwd ?? []).map((t) => ({ ...t, serviceId: "svc", headsign: "to-s2" })),
      },
      {
        id: "r1",
        stopIds: ["s2-rev", "s1-rev"],
        trips: (trips.rev ?? []).map((t) => ({ ...t, serviceId: "svc", headsign: "to-s1" })),
      },
    ],
    services: [
      { serviceId: "svc", days: DAY_MASK_MON_FRI, startDate: "20260101", endDate: "20271231" },
    ],
  });
}

describe("activeRouteIdsAtStop / stopMaybeActive — pattern-exact path", () => {
  it("night: a reverse-only stop with no in-window trip in ANY direction is inactive AND not maybe-active", () => {
    // The urban-mode night-blip regression: `stopMaybeActive` used to fail
    // open on the TIME-INVARIANT "return-only for some route" property, so
    // every opposite-side sibling stop stayed visible at night and its
    // hide/show then depended on the viewport-transient schedule-tile verdict
    // (evaluated only at card zoom, evicted on pan) — stops blipped between
    // states on zoom. With pattern times readable the answer is exact.
    const idx = bidiFixture({
      fwd: [{ tripId: "t-fwd", departureSecs: [54000, 54600] }], // 15:00 — out of window
      rev: [{ tripId: "t-rev", departureSecs: [54900, 55500] }], // 15:15 — out of window
    });
    expect(activeRouteIdsAtStop("s1-rev", WEDNESDAY_10_00, 2, idx).size).toBe(0);
    expect(stopMaybeActive("s1-rev", WEDNESDAY_10_00, 2, idx)).toBe(false);
  });

  it("reads the exact pattern column: a reverse trip in-window at the sibling stop activates it", () => {
    const idx = bidiFixture({
      rev: [{ tripId: "t-rev", departureSecs: [37800, 38400] }], // 10:30 / 10:40
    });
    expect(Array.from(activeRouteIdsAtStop("s1-rev", WEDNESDAY_10_00, 2, idx))).toEqual(["r1"]);
    expect(stopMaybeActive("s1-rev", WEDNESDAY_10_00, 2, idx)).toBe(true);
  });

  it("is exact on the time axis: in-window at an EARLIER column does not activate a LATER out-of-window column", () => {
    // Reverse trip departs s2-rev at 11:30 (in a 2h window from 10:00) but
    // reaches s1-rev only at 12:30 (outside it). The old headsign fallback
    // counted ANY in-window departure on the trip as activity at every stop
    // it serves; the pattern read must use the stop's own column.
    const idx = bidiFixture({
      rev: [{ tripId: "t-rev", departureSecs: [41400, 45000] }], // 11:30 / 12:30
    });
    expect(activeRouteIdsAtStop("s1-rev", WEDNESDAY_10_00, 2, idx).size).toBe(0);
    expect(Array.from(activeRouteIdsAtStop("s2-rev", WEDNESDAY_10_00, 2, idx))).toEqual(["r1"]);
  });

  it("lasso/loop: a stop repeated within one pattern is active when ANY occurrence is in-window", () => {
    // GTFS loop trips include the first/last stop twice in stop_times, and a
    // lasso trip revisits its stem stops within a single trip_id:
    // https://gtfs.org/documentation/schedule/schedule-best-practices/#loop-routes
    // https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
    // Occurrence 1 of "A" (10:00) has already departed at now=10:10; the
    // return visit at 11:00 is in-window — the stop is active. A first-
    // occurrence-only read (indexOf) misses it.
    const idx = patternFixture({
      records: [
        {
          id: "loop",
          stopIds: ["A", "B", "A"],
          trips: [{ tripId: "t-loop", serviceId: "svc", departureSecs: [36000, 37800, 39600] }],
        },
      ],
      services: [
        { serviceId: "svc", days: DAY_MASK_MON_FRI, startDate: "20260101", endDate: "20271231" },
      ],
    });
    const now = new Date(2026, 3, 22, 10, 10, 0); // Wed 10:10
    expect(Array.from(activeRouteIdsAtStop("A", now, 2, idx))).toEqual(["loop"]);
    expect(stopMaybeActive("A", now, 2, idx)).toBe(true);
  });

  it("frequency-based trip: active via headway-window intersection at the stop's column offset", () => {
    // frequencies.txt redefines the trip's template times as relative offsets
    // (https://gtfs.org/documentation/schedule/reference/#frequenciestxt), so
    // activity must come from the service windows, not the template clock
    // times. Template departs f1 06:00 / f2 06:05 (long past); the window
    // runs 11:00–13:00 → departures at f2 exist from ~11:05 — inside a 2h
    // window from 10:00.
    const idx = patternFixture({
      records: [
        {
          id: "freq",
          stopIds: ["f1", "f2"],
          trips: [
            { tripId: "t-freq", serviceId: "svc", ptbTripIdx: 7, departureSecs: [21600, 21900] },
          ],
        },
      ],
      services: [
        { serviceId: "svc", days: DAY_MASK_MON_FRI, startDate: "20260101", endDate: "20271231" },
      ],
      frequencies: [
        { tripIdx: 7, startSecs: 39600, endSecs: 46800, headwaySecs: 600, exactTimes: 0 },
      ],
    });
    expect(Array.from(activeRouteIdsAtStop("f2", WEDNESDAY_10_00, 2, idx))).toEqual(["freq"]);
    // A window entirely beyond the lookahead does NOT activate the stop.
    const idxLate = patternFixture({
      records: [
        {
          id: "freq",
          stopIds: ["f1", "f2"],
          trips: [
            { tripId: "t-freq", serviceId: "svc", ptbTripIdx: 7, departureSecs: [21600, 21900] },
          ],
        },
      ],
      services: [
        { serviceId: "svc", days: DAY_MASK_MON_FRI, startDate: "20260101", endDate: "20271231" },
      ],
      frequencies: [
        { tripIdx: 7, startSecs: 46800, endSecs: 54000, headwaySecs: 600, exactTimes: 0 },
      ],
    });
    expect(activeRouteIdsAtStop("f2", WEDNESDAY_10_00, 2, idxLate).size).toBe(0);
  });

  it("skips the -1 unserved sentinel: a folded member's absent column never activates a stop", () => {
    // CoveringMerge folds a shorter trip onto a covering pattern; positions
    // the member does not serve carry the -1 sentinel. A hand-built index
    // pins the guard without depending on producer-side folding.
    const pattern: RaptorIndexRoute = {
      id: "rF",
      shortName: "rF",
      mode: "BUS",
      stopIds: ["p", "q"],
      trips: [
        { tripId: "t-folded", serviceId: "svc", headsign: "", departureSecs: [-1, 37800] },
      ],
    };
    const services = new Map<string, RaptorIndexService>([
      [
        "svc",
        {
          serviceId: "svc",
          days: [true, true, true, true, true, false, false],
          startDate: "20260101",
          endDate: "20271231",
          exceptions: {},
        },
      ],
    ]);
    const idx: RaptorIndex = {
      routes: [pattern],
      routeIdToIdx: new Map([["rF", 0]]),
      routesAtStop: new Map([
        ["p", [0]],
        ["q", [0]],
      ]),
      services,
      patterns: [pattern],
      patternsAtStop: new Map([
        ["p", [0]],
        ["q", [0]],
      ]),
    };
    expect(activeRouteIdsAtStop("p", WEDNESDAY_10_00, 2, idx).size).toBe(0);
    expect(stopMaybeActive("p", WEDNESDAY_10_00, 2, idx)).toBe(false);
    expect(Array.from(activeRouteIdsAtStop("q", WEDNESDAY_10_00, 2, idx))).toEqual(["rF"]);
  });

  it("cross-midnight: yesterday's overnight trip activates a reverse-pattern stop at 0:30", () => {
    const idx = bidiFixture({
      rev: [{ tripId: "t-night", departureSecs: [89700, 90000] }], // 24:55 / 25:00
    });
    expect(Array.from(activeRouteIdsAtStop("s1-rev", WEDNESDAY_0_30, 2, idx))).toEqual(["r1"]);
  });

  it("per-ROUTE wire: a reverse-only stop the patterns don't cover keeps the legacy fail-open treatment", () => {
    // Wire-shape skew belt: a stale cached bundle may carry ONE record per
    // route_id (reverse stops only in `directionPatterns`, trips canonical-
    // aligned). Hydrating it with CoveringMerge still populates `patterns`,
    // but they cover canonical sequences only — so a reverse-only stop must
    // NOT be read as exactly-inactive ("not served by any pattern"): it is
    // undecidable and falls back to the headsign fallback + structural
    // fail-open, exactly the pre-pattern behavior.
    const idx = patternFixture({
      records: [
        {
          id: "r1",
          stopIds: ["s1", "s2"],
          directionPatterns: [
            { key: "0", headsign: "to-s2", stopIds: ["s1", "s2"] },
            { key: "1", headsign: "to-s1", stopIds: ["s2-rev", "s1-rev"] },
          ],
          trips: [
            // Reverse trip, canonical-aligned times, in-window.
            { tripId: "t-rev", serviceId: "svc", headsign: "to-s1", departureSecs: [37800, 38400] },
          ],
        },
      ],
      services: [
        { serviceId: "svc", days: DAY_MASK_MON_FRI, startDate: "20260101", endDate: "20271231" },
      ],
    });
    expect(stopActivityDecidable("s1-rev", idx)).toBe(false);
    expect(stopActivityDecidable("s1", idx)).toBe(true);
    // Headsign fallback still fires (time-axis over-approximation preserved).
    expect(Array.from(activeRouteIdsAtStop("s1-rev", WEDNESDAY_10_00, 2, idx))).toEqual(["r1"]);
    // Structural fail-open still holds when nothing is in-window.
    const idxNight = patternFixture({
      records: [
        {
          id: "r1",
          stopIds: ["s1", "s2"],
          directionPatterns: [
            { key: "0", headsign: "to-s2", stopIds: ["s1", "s2"] },
            { key: "1", headsign: "to-s1", stopIds: ["s2-rev", "s1-rev"] },
          ],
          trips: [
            { tripId: "t-rev", serviceId: "svc", headsign: "to-s1", departureSecs: [54000, 54600] },
          ],
        },
      ],
      services: [
        { serviceId: "svc", days: DAY_MASK_MON_FRI, startDate: "20260101", endDate: "20271231" },
      ],
    });
    expect(stopMaybeActive("s1-rev", WEDNESDAY_10_00, 2, idxNight)).toBe(true); // indeterminate ⇒ keep
  });
});
