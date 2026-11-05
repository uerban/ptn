import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  makeGetNextDeparture,
  type RaptorIndexLite,
  type RtStoreLite,
} from "../../src/services/nextDeparture.ts";

// Test clock model: `now()` returns wall-clock Unix epoch ms (matching the
// production default `Date.now`). The factory derives the service-day
// calendar (`new Date(now())`) and the midnight-relative `nowSecs` from
// the same source. Tests pin a real Date and let the factory compute
// `nowSecs` from its hour/minute/second components.

// 2026-06-17 (Wednesday — getDay() === 3) at 08:21:40 local time.
// Midnight-relative seconds = 8*3600 + 21*60 + 40 = 30100.
const PINNED = new Date(2026, 5, 17, 8, 21, 40);
const PINNED_MS = PINNED.getTime();

function makeIndex(): RaptorIndexLite {
  return {
    routes: [
      {
        id: "R1",
        shortName: "R1",
        stopIds: ["S1", "S2"],
        trips: [
          {
            tripId: "T1",
            serviceId: "SVC-DAILY",
            headsign: "Center",
            departureSecs: [30000, 30600],
          },
          {
            tripId: "T2",
            serviceId: "SVC-DAILY",
            headsign: "Center",
            departureSecs: [31200, 31800],
          },
        ],
      },
    ],
    routeIdToIdx: new Map([["R1", 0]]),
    routesAtStop: new Map([
      ["S1", [0]],
      ["S2", [0]],
    ]),
    services: new Map([
      [
        "SVC-DAILY",
        {
          serviceId: "SVC-DAILY",
          days: [true, true, true, true, true, true, true],
          startDate: "20260101",
          endDate: "20271231",
          exceptions: {} as Record<string, number>,
        },
      ],
    ]),
  };
}

describe("makeGetNextDeparture", () => {
  it("returns the earliest upcoming departure relative to nowSecs derived from real Date", () => {
    const rtStore: RtStoreLite = {
      getTripDelay: () => null,
      getReceivedAt: () => null,
    };
    const fn = makeGetNextDeparture(makeIndex(), rtStore, () => PINNED_MS);
    const dep = fn("R1", "S2");
    // T1 departs S2 at 30600. nowSecs derived from PINNED = 30100.
    // minutesUntil = floor(500/60) = 8. headsign comes from the winning
    // trip (T1).
    expect(dep).toEqual({
      minutesUntil: 8,
      departureMs: PINNED_MS + 500_000,
      routeShortName: "R1",
      headsign: "Center",
      isApproximate: false,
    });
  });

  it("never offers a cancelled trip — the next one that runs instead", () => {
    const rtStore: RtStoreLite = {
      getTripDelay: (tripId) => (tripId === "T1" ? { delaySeconds: 0, cancelled: true } : null),
      getReceivedAt: () => null,
    };
    const fn = makeGetNextDeparture(makeIndex(), rtStore, () => PINNED_MS);
    // T1 (30600 at S2) is cancelled; T2 leaves S2 at 31800.
    expect(fn("R1", "S2")?.departureMs).toBe(PINNED_MS + 1_700_000);
  });

  it("never offers a deleted trip either", () => {
    const rtStore: RtStoreLite = {
      getTripDelay: (tripId) =>
        tripId === "T1" ? { delaySeconds: 0, cancelled: false, deleted: true } : null,
      getReceivedAt: () => null,
    };
    const fn = makeGetNextDeparture(makeIndex(), rtStore, () => PINNED_MS);
    expect(fn("R1", "S2")?.departureMs).toBe(PINNED_MS + 1_700_000);
  });

  it("keeps skipping a cancelled trip however old the report", () => {
    // A cancellation does not go stale the way a delay estimate does, and
    // the lookup's clock can sit well past the report (asked for "the bus
    // after the one I'll miss").
    const rtStore: RtStoreLite = {
      getTripDelay: (tripId) => (tripId === "T1" ? { delaySeconds: 0, cancelled: true } : null),
      getReceivedAt: () => PINNED_MS - 3_600_000,
    };
    const fn = makeGetNextDeparture(makeIndex(), rtStore, () => PINNED_MS);
    expect(fn("R1", "S2")?.departureMs).toBe(PINNED_MS + 1_700_000);
  });

  it("gives the departure as an instant too, with the RT delay in it", () => {
    const rtStore: RtStoreLite = {
      getTripDelay: (tripId) =>
        tripId === "T1" ? { delaySeconds: 60, cancelled: false } : null,
      getReceivedAt: () => null,
    };
    const fn = makeGetNextDeparture(makeIndex(), rtStore, () => PINNED_MS);
    // 30600 + 60 − 30100 = 560 s from now — to the second, unlike minutesUntil.
    expect(fn("R1", "S2")?.departureMs).toBe(PINNED_MS + 560_000);
  });

  it("applies a fresh RT delay", () => {
    const rtStore: RtStoreLite = {
      getTripDelay: (tripId) =>
        tripId === "T1" ? { delaySeconds: 60, cancelled: false } : null,
      // receivedAt is wall-clock epoch (matches PINNED_MS).
      getReceivedAt: (tripId) => (tripId === "T1" ? PINNED_MS : null),
    };
    const fn = makeGetNextDeparture(makeIndex(), rtStore, () => PINNED_MS);
    const dep = fn("R1", "S2");
    // 30600 + 60 = 30660. floor((30660 - 30100) / 60) = floor(9.33) = 9.
    expect(dep?.minutesUntil).toBe(9);
  });

  it("ignores a stale RT delay (>= 120s old) — wall-clock arithmetic", () => {
    const rtStore: RtStoreLite = {
      getTripDelay: (tripId) =>
        tripId === "T1" ? { delaySeconds: 60, cancelled: false } : null,
      getReceivedAt: (tripId) => (tripId === "T1" ? PINNED_MS - 130_000 : null),
    };
    const fn = makeGetNextDeparture(makeIndex(), rtStore, () => PINNED_MS);
    expect(fn("R1", "S2")?.minutesUntil).toBe(8); // scheduled, no shift
  });

  it("treats null receivedAt as fresh (backwards-compat with rtOverlay policy)", () => {
    // Aligns with rtOverlay's "missing receivedAt = fresh" semantics.
    // Without this alignment, the dashboard and the trip-planner overlay
    // would disagree about freshness when an unstamped writer site emits
    // a delay.
    const rtStore: RtStoreLite = {
      getTripDelay: (tripId) =>
        tripId === "T1" ? { delaySeconds: 60, cancelled: false } : null,
      getReceivedAt: () => null, // explicit null = no stamp
    };
    const fn = makeGetNextDeparture(makeIndex(), rtStore, () => PINNED_MS);
    expect(fn("R1", "S2")?.minutesUntil).toBe(9); // delay applied
  });

  it("returns null when the route does not serve the stop", () => {
    const rtStore: RtStoreLite = { getTripDelay: () => null, getReceivedAt: () => null };
    const fn = makeGetNextDeparture(makeIndex(), rtStore, () => PINNED_MS);
    expect(fn("R1", "S99")).toBeNull();
  });

  it("returns null when the route does not exist", () => {
    const rtStore: RtStoreLite = { getTripDelay: () => null, getReceivedAt: () => null };
    const fn = makeGetNextDeparture(makeIndex(), rtStore, () => PINNED_MS);
    expect(fn("R99", "S1")).toBeNull();
  });

  it("returns null when no trip departs after nowSecs", () => {
    // Late in the day: 23:00 local → nowSecs = 82800; all trips < 82800.
    const lateMs = new Date(2026, 5, 17, 23, 0, 0).getTime();
    const rtStore: RtStoreLite = { getTripDelay: () => null, getReceivedAt: () => null };
    const fn = makeGetNextDeparture(makeIndex(), rtStore, () => lateMs);
    expect(fn("R1", "S2")).toBeNull();
  });

  it("skips trips whose service is not active today", () => {
    const idx = makeIndex();
    idx.services.set("SVC-DAILY", {
      serviceId: "SVC-DAILY",
      days: [false, false, false, false, false, false, false],
      startDate: "20260101",
      endDate: "20271231",
      exceptions: {},
    });
    const rtStore: RtStoreLite = { getTripDelay: () => null, getReceivedAt: () => null };
    const fn = makeGetNextDeparture(idx, rtStore, () => PINNED_MS);
    expect(fn("R1", "S2")).toBeNull();
  });

  it("honors a service exception adding service on a normally-inactive day (exception_type=1)", () => {
    const idx = makeIndex();
    idx.services.set("SVC-DAILY", {
      serviceId: "SVC-DAILY",
      days: [false, false, false, false, false, false, false],
      startDate: "20260101",
      endDate: "20271231",
      exceptions: { "20260617": 1 },
    });
    const rtStore: RtStoreLite = { getTripDelay: () => null, getReceivedAt: () => null };
    const fn = makeGetNextDeparture(idx, rtStore, () => PINNED_MS);
    expect(fn("R1", "S2")?.minutesUntil).toBe(8);
  });

  it("honors exception_type=2 (service removed on a normally-active day)", () => {
    const idx = makeIndex();
    idx.services.set("SVC-DAILY", {
      serviceId: "SVC-DAILY",
      days: [true, true, true, true, true, true, true],
      startDate: "20260101",
      endDate: "20271231",
      exceptions: { "20260617": 2 },
    });
    const rtStore: RtStoreLite = { getTripDelay: () => null, getReceivedAt: () => null };
    const fn = makeGetNextDeparture(idx, rtStore, () => PINNED_MS);
    expect(fn("R1", "S2")).toBeNull();
  });

  it("returns null when dateKey is past endDate", () => {
    const idx = makeIndex();
    idx.services.set("SVC-DAILY", {
      serviceId: "SVC-DAILY",
      days: [true, true, true, true, true, true, true],
      startDate: "20260101",
      endDate: "20260101", // already over
      exceptions: {},
    });
    const rtStore: RtStoreLite = { getTripDelay: () => null, getReceivedAt: () => null };
    const fn = makeGetNextDeparture(idx, rtStore, () => PINNED_MS);
    expect(fn("R1", "S2")).toBeNull();
  });

  it("returns null when dateKey is before startDate", () => {
    const idx = makeIndex();
    idx.services.set("SVC-DAILY", {
      serviceId: "SVC-DAILY",
      days: [true, true, true, true, true, true, true],
      startDate: "20271231", // not yet active
      endDate: "20281231",
      exceptions: {},
    });
    const rtStore: RtStoreLite = { getTripDelay: () => null, getReceivedAt: () => null };
    const fn = makeGetNextDeparture(idx, rtStore, () => PINNED_MS);
    expect(fn("R1", "S2")).toBeNull();
  });

  it("dev-warns on unknown exception_type values (e.g. 0, 3)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const idx = makeIndex();
      idx.services.set("SVC-DAILY", {
        serviceId: "SVC-DAILY",
        days: [true, true, true, true, true, true, true],
        startDate: "20260101",
        endDate: "20271231",
        exceptions: { "20260617": 99 }, // illegal per GTFS
      });
      const rtStore: RtStoreLite = { getTripDelay: () => null, getReceivedAt: () => null };
      const fn = makeGetNextDeparture(idx, rtStore, () => PINNED_MS);
      // Falls through to date-range + days check, which says active.
      expect(fn("R1", "S2")?.minutesUntil).toBe(8);
      // But emits a warning so feed bugs surface.
      expect(warnSpy).toHaveBeenCalled();
      const msg = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(msg).toMatch(/unknown exception_type/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns the WINNING trip's headsign for routes with mixed-direction headsigns", () => {
    // Bidirectional route: T1 outbound to "Center", T2 inbound to "Depot".
    // At nowSecs=30100, the earliest upcoming trip at S2 is T1 (30600 < 31800).
    // The chip must show "Center", not "Depot".
    const idx: RaptorIndexLite = {
      ...makeIndex(),
      routes: [
        {
          id: "R1",
          shortName: "R1",
          stopIds: ["S1", "S2"],
          trips: [
            {
              tripId: "T1",
              serviceId: "SVC-DAILY",
              headsign: "Center",
              departureSecs: [30000, 30600],
            },
            {
              tripId: "T2",
              serviceId: "SVC-DAILY",
              headsign: "Depot",
              departureSecs: [31200, 31800],
            },
          ],
        },
      ],
    };
    const rtStore: RtStoreLite = { getTripDelay: () => null, getReceivedAt: () => null };
    const fn = makeGetNextDeparture(idx, rtStore, () => PINNED_MS);
    expect(fn("R1", "S2")?.headsign).toBe("Center");
  });

  it("falls back to directionPatterns for a return-only stop and flags isApproximate", () => {
    // Canonical sequence covers only the outbound direction; the second
    // `directionPatterns` entry carries the return-only stop "X". Without
    // the helper-based lookup, `route.stopIds.indexOf("X")` returns -1 and
    // the function bails — exactly the sibling-surface bug.
    //
    // Wire-shape contract: `trip.departureSecs[i]` aligns to canonical
    // `route.stopIds[i]`. For the return trip C→B→A→X here, the canonical
    // is [A,B,C] (outbound order) so the per-column times are
    // [time at A, time at B, time at C] = [31800, 31500, 31200] —
    // strictly NOT in travel order. X has no canonical column so the
    // approximate path scans all entries.
    const idx: RaptorIndexLite = {
      routes: [
        {
          id: "R1",
          shortName: "R1",
          stopIds: ["A", "B", "C"],
          directionPatterns: [
            { key: "0", headsign: "Outbound", stopIds: ["A", "B", "C"] },
            { key: "1", headsign: "Inbound", stopIds: ["C", "B", "A", "X"] },
          ],
          trips: [
            {
              tripId: "T1",
              serviceId: "SVC-DAILY",
              headsign: "Outbound",
              departureSecs: [30000, 30300, 30600],
            },
            {
              tripId: "T2",
              serviceId: "SVC-DAILY",
              headsign: "Inbound",
              // Canonical-column-aligned: time at A=31800, B=31500, C=31200.
              departureSecs: [31800, 31500, 31200],
            },
          ],
        },
      ],
      routeIdToIdx: new Map([["R1", 0]]),
      routesAtStop: new Map([["X", [0]]]),
      services: new Map([
        [
          "SVC-DAILY",
          {
            serviceId: "SVC-DAILY",
            days: [true, true, true, true, true, true, true],
            startDate: "20260101",
            endDate: "20271231",
            exceptions: {} as Record<string, number>,
          },
        ],
      ]),
    };
    const rtStore: RtStoreLite = {
      getTripDelay: () => null,
      getReceivedAt: () => null,
    };
    const fn = makeGetNextDeparture(idx, rtStore, () => PINNED_MS);
    const dep = fn("R1", "X");
    expect(dep).not.toBeNull();
    // T2's smallest in-future column is 31200 (the C column); nowSecs = 30100.
    // T1 is filtered out by the matching-headsign set. minutesUntil =
    // floor(1100/60) = 18. Note: reading `departureSecs[0]` (=31800)
    // would give 28 — the bug this test pins.
    expect(dep?.minutesUntil).toBe(18);
    expect(dep?.isApproximate).toBe(true);
    expect(dep?.headsign).toBe("Inbound");
  });

  it("approximate path skips return trips whose only canonical-column visits are sentinel -1s", () => {
    // Tightest reproduction of the canonical-alignment bug: a return trip
    // that visits ONLY the return-only stop "X" plus one canonical stop
    // (the one whose column lines up with a real visit). The other
    // canonical columns hold the `-1` sentinel.
    //
    // With the old `departureSecs[0]` read, the inbound trip's first
    // column would be `-1`, the trip would be silently discarded, and
    // the dashboard would show "no departure" at X even though the bus
    // is on its way. The fix scans every column for the smallest valid
    // entry instead.
    const idx: RaptorIndexLite = {
      routes: [
        {
          id: "R1",
          shortName: "R1",
          // Canonical sequence is the outbound's longest trip: A→B→C.
          stopIds: ["A", "B", "C"],
          directionPatterns: [
            { key: "0", headsign: "Outbound", stopIds: ["A", "B", "C"] },
            // Return trip skips the canonical-A column and only reaches X
            // plus canonical-C as its first stop. Models a real-world
            // bidirectional route where the return short-turn doesn't go
            // all the way back to A.
            { key: "1", headsign: "Inbound", stopIds: ["C", "X"] },
          ],
          trips: [
            {
              tripId: "T-OUT",
              serviceId: "SVC-DAILY",
              headsign: "Outbound",
              departureSecs: [30000, 30300, 30600],
            },
            {
              tripId: "T-IN",
              serviceId: "SVC-DAILY",
              headsign: "Inbound",
              // -1 at A and B (not visited on this return short-turn);
              // 31200 at C (the canonical column the return trip does
              // start from). Old code: dep[0] = -1, trip silently dropped.
              departureSecs: [-1, -1, 31200],
            },
          ],
        },
      ],
      routeIdToIdx: new Map([["R1", 0]]),
      routesAtStop: new Map([["X", [0]]]),
      services: new Map([
        [
          "SVC-DAILY",
          {
            serviceId: "SVC-DAILY",
            days: [true, true, true, true, true, true, true],
            startDate: "20260101",
            endDate: "20271231",
            exceptions: {} as Record<string, number>,
          },
        ],
      ]),
    };
    const rtStore: RtStoreLite = {
      getTripDelay: () => null,
      getReceivedAt: () => null,
    };
    const fn = makeGetNextDeparture(idx, rtStore, () => PINNED_MS);
    const dep = fn("R1", "X");
    expect(dep).not.toBeNull();
    // Only valid column on T-IN is 31200. T-OUT is filtered by
    // matching-headsign. minutesUntil = floor((31200-30100)/60) = 18.
    expect(dep?.minutesUntil).toBe(18);
    expect(dep?.isApproximate).toBe(true);
    expect(dep?.headsign).toBe("Inbound");
  });

  it("approximate path skips outbound trips whose direction pattern does not include the return-only stop", () => {
    // Regression guard: without a headsign-based direction filter, an
    // outbound trip's `departureSecs[0]` can underbid the inbound trip and
    // surface the outbound headsign at the return-only stop. The matching-
    // headsigns set mirrors `hasUpcomingDeparture.ts`'s policy.
    const idx: RaptorIndexLite = {
      routes: [
        {
          id: "R1",
          shortName: "R1",
          stopIds: ["A", "B", "C"],
          directionPatterns: [
            { key: "0", headsign: "Outbound", stopIds: ["A", "B", "C"] },
            { key: "1", headsign: "Inbound", stopIds: ["C", "B", "A", "X"] },
          ],
          trips: [
            // Outbound trip departs SOON (would win on time alone) but
            // does NOT serve return-only stop X. The filter must skip it.
            {
              tripId: "T-OUT",
              serviceId: "SVC-DAILY",
              headsign: "Outbound",
              departureSecs: [30200, 30500, 30800],
            },
            // Inbound trip C→B→A→X with canonical-column-aligned times:
            // [time at A=31800, time at B=31500, time at C=31200].
            {
              tripId: "T-IN",
              serviceId: "SVC-DAILY",
              headsign: "Inbound",
              departureSecs: [31800, 31500, 31200],
            },
          ],
        },
      ],
      routeIdToIdx: new Map([["R1", 0]]),
      routesAtStop: new Map([["X", [0]]]),
      services: new Map([
        [
          "SVC-DAILY",
          {
            serviceId: "SVC-DAILY",
            days: [true, true, true, true, true, true, true],
            startDate: "20260101",
            endDate: "20271231",
            exceptions: {} as Record<string, number>,
          },
        ],
      ]),
    };
    const rtStore: RtStoreLite = {
      getTripDelay: () => null,
      getReceivedAt: () => null,
    };
    const fn = makeGetNextDeparture(idx, rtStore, () => PINNED_MS);
    const dep = fn("R1", "X");
    expect(dep).not.toBeNull();
    // T-IN wins (T-OUT was filtered out despite its earlier departure).
    // Smallest valid column on T-IN is 31200; nowSecs = 30100;
    // floor(1100/60) = 18.
    expect(dep?.minutesUntil).toBe(18);
    expect(dep?.headsign).toBe("Inbound");
    expect(dep?.isApproximate).toBe(true);
  });

  it("approximate path returns null when no trip headsign matches a pattern containing the stop", () => {
    // Fixture state seen in the e2e mock-api JSON: all trips carry the
    // outbound headsign while the inbound pattern lists the return-only
    // stop. The function must return null rather than surfacing an
    // outbound trip's `departureSecs[0]` as the next departure at X.
    const idx: RaptorIndexLite = {
      routes: [
        {
          id: "R1",
          shortName: "R1",
          stopIds: ["A", "B"],
          directionPatterns: [
            { key: "0", headsign: "Outbound", stopIds: ["A", "B"] },
            { key: "1", headsign: "Inbound", stopIds: ["B", "X", "A"] },
          ],
          trips: [
            {
              tripId: "T-OUT-1",
              serviceId: "SVC-DAILY",
              headsign: "Outbound",
              departureSecs: [30200, 30500],
            },
            {
              tripId: "T-OUT-2",
              serviceId: "SVC-DAILY",
              headsign: "Outbound",
              departureSecs: [31200, 31500],
            },
          ],
        },
      ],
      routeIdToIdx: new Map([["R1", 0]]),
      routesAtStop: new Map([["X", [0]]]),
      services: new Map([
        [
          "SVC-DAILY",
          {
            serviceId: "SVC-DAILY",
            days: [true, true, true, true, true, true, true],
            startDate: "20260101",
            endDate: "20271231",
            exceptions: {} as Record<string, number>,
          },
        ],
      ]),
    };
    const rtStore: RtStoreLite = {
      getTripDelay: () => null,
      getReceivedAt: () => null,
    };
    const fn = makeGetNextDeparture(idx, rtStore, () => PINNED_MS);
    expect(fn("R1", "X")).toBeNull();
  });

  it("finds yesterday's overnight tail when called early in the morning (cross-midnight)", () => {
    // Pin to 01:30 local on Wednesday. Yesterday's overnight trip
    // departs S2 at 25:30 = 91800 secs; today-relative that's
    // 91800 - 86400 = 5400 (=01:30). nowSecs = 5400, so dep is "now-ish"
    // → minutesUntil 0.
    const earlyMs = new Date(2026, 5, 17, 1, 0, 0).getTime();
    const idx: RaptorIndexLite = {
      ...makeIndex(),
      routes: [
        {
          id: "R1",
          shortName: "R1",
          stopIds: ["S1", "S2"],
          trips: [
            {
              tripId: "OVERNIGHT-1",
              serviceId: "SVC-DAILY",
              headsign: "Tail",
              departureSecs: [91500, 91800], // 25:25 / 25:30
            },
          ],
        },
      ],
    };
    const rtStore: RtStoreLite = { getTripDelay: () => null, getReceivedAt: () => null };
    const fn = makeGetNextDeparture(idx, rtStore, () => earlyMs);
    const dep = fn("R1", "S2");
    expect(dep).not.toBeNull();
    // 91800 - 86400 = 5400 today-relative; nowSecs at 01:00 = 3600.
    // minutesUntil = floor((5400 - 3600) / 60) = 30.
    expect(dep?.minutesUntil).toBe(30);
    expect(dep?.headsign).toBe("Tail");
  });

  it("approximate path: surfaces yesterday's overnight tail at a return-only stop", () => {
    // Regression guard for the yesterday-branch approximate path. The
    // earlier `dep = trip.departureSecs[0]` read is always pre-midnight
    // for yesterday's trips (a trip starts on its own service day), so
    // the `dep < SECS_PER_DAY` skip unconditionally discarded every
    // overnight tail at a return-only stop. The fix scans the trip's
    // `departureSecs` for the smallest cross-midnight entry. Without it
    // the chip would surface today's morning trip (~3.5h) instead of
    // the overnight bus that actually reaches the stop in ~5 minutes.
    //
    // Wire shape: canonical = [A, B] (outbound order). Inbound trip
    // B→X→A means column 0 = A (last visited), column 1 = B (first
    // visited). For T-NIGHT: A=92100 (25:35, overnight tail), B=85800
    // (23:50). For T-MORNING: A=18600, B=18000. The arrays are length
    // 2 (= stopIds.length) and NOT in travel order.
    const earlyMs = new Date(2026, 5, 17, 1, 30, 0).getTime();
    const idx: RaptorIndexLite = {
      routes: [
        {
          id: "R1",
          shortName: "R1",
          stopIds: ["A", "B"],
          directionPatterns: [
            { key: "0", headsign: "Outbound", stopIds: ["A", "B"] },
            { key: "1", headsign: "Inbound", stopIds: ["B", "X", "A"] },
          ],
          trips: [
            // Yesterday's overnight inbound trip — starts 23:50, reaches
            // canonical A post-midnight at 25:35 (=01:35 today, 5 min out).
            {
              tripId: "T-NIGHT",
              serviceId: "SVC-DAILY",
              headsign: "Inbound",
              departureSecs: [92100, 85800],
            },
            // Today's morning trip — what gets surfaced WITHOUT the fix.
            {
              tripId: "T-MORNING",
              serviceId: "SVC-DAILY",
              headsign: "Inbound",
              departureSecs: [18600, 18000],
            },
          ],
        },
      ],
      routeIdToIdx: new Map([["R1", 0]]),
      routesAtStop: new Map([["X", [0]]]),
      services: new Map([
        [
          "SVC-DAILY",
          {
            serviceId: "SVC-DAILY",
            days: [true, true, true, true, true, true, true],
            startDate: "20260101",
            endDate: "20271231",
            exceptions: {} as Record<string, number>,
          },
        ],
      ]),
    };
    const rtStore: RtStoreLite = { getTripDelay: () => null, getReceivedAt: () => null };
    const fn = makeGetNextDeparture(idx, rtStore, () => earlyMs);
    const dep = fn("R1", "X");
    expect(dep).not.toBeNull();
    // Yesterday-branch finds T-NIGHT's first cross-midnight stop at
    // 92100. todayRelative = 92100 - 86400 = 5700. nowSecs = 5400.
    // minutesUntil = floor((5700 - 5400) / 60) = 5.
    expect(dep?.minutesUntil).toBe(5);
    expect(dep?.isApproximate).toBe(true);
    expect(dep?.headsign).toBe("Inbound");
  });
});

describe("makeGetNextDeparture — Home.tsx integration regression guard", () => {
  // Pins the bug fixed during PR D review: rev-1 of D5 passed a
  // midnight-relative ms count as the `now` clock. Inside the factory,
  // `new Date(midnightRelativeMs)` was interpreted as Unix epoch
  // (~Jan 1 1970), so `dateKey = "19700101"` lexicographically <
  // startDate "20260101" for every loaded service → all trips skipped →
  // dashboard rendered the empty-state for every stop. D-018 would have
  // shipped "fixed" while still being broken.
  //
  // Locking in: when called with a real `Date.now` clock against today's
  // dateKey-active services, getNextDeparture MUST return non-null for a
  // route that has upcoming trips. This is the smallest surface that
  // catches the regression without rendering HomePage.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 17, 8, 21, 40));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("with default Date.now clock and active service today, finds the upcoming departure", () => {
    const rtStore: RtStoreLite = { getTripDelay: () => null, getReceivedAt: () => null };
    // No `now` passed — factory uses default Date.now. Critical: a
    // regression that re-introduces the midnight-relative-as-epoch bug
    // would make this test fail (every service would look out of date
    // range).
    const fn = makeGetNextDeparture(makeIndex(), rtStore);
    expect(fn("R1", "S2")?.minutesUntil).toBe(8);
  });

  it("freshness guard arithmetic uses wall-clock epoch, not midnight-relative", () => {
    // Sub-regression: rev-1 also had `nowMs - receivedAt` mixing
    // midnight-relative ms (~8.6e7) against epoch ms (~1.7e12), making
    // the diff a large negative number that always satisfied the
    // freshness condition. With wall-clock-epoch nowMs the arithmetic
    // is correct.
    const wallClockMs = Date.now();
    const rtStore: RtStoreLite = {
      getTripDelay: (tripId) =>
        tripId === "T1" ? { delaySeconds: 60, cancelled: false } : null,
      // Stamp 200s ago — clearly stale.
      getReceivedAt: (tripId) => (tripId === "T1" ? wallClockMs - 200_000 : null),
    };
    const fn = makeGetNextDeparture(makeIndex(), rtStore);
    // Schedule applies, not delayed schedule (200s > 120s window).
    expect(fn("R1", "S2")?.minutesUntil).toBe(8);
  });
});

describe("makeGetNextDeparture — Mon-first weekday index [R-fold #6]", () => {
  // Regression for the pre-existing weekday bug: `isServiceActive` indexes
  // `service.days[dayOfWeek]` where `days` is Mon-first, but the factory used
  // to pass the JS `getDay()` (Sun=0) unconverted — so on a Wednesday it read
  // the Thursday slot. A non-all-true mask exposes it (the existing suite hides
  // it with all-true masks). `feedTz` is supplied so the service date resolves
  // deterministically regardless of the test runner's TZ.
  const FEED_TZ = "Europe/Vilnius";
  // 2026-01-14 is a Wednesday (Mon-first idx 2). 08:00 UTC = 10:00 Vilnius.
  const WED_0800 = Date.UTC(2026, 0, 14, 8, 0, 0);
  const rtStore: RtStoreLite = { getTripDelay: () => null, getReceivedAt: () => null };

  function indexForMask(days: boolean[]): RaptorIndexLite {
    return {
      routes: [
        {
          id: "R1",
          shortName: "R1",
          stopIds: ["s", "s2"],
          trips: [
            {
              tripId: "T1",
              serviceId: "svc",
              headsign: "Center",
              // 09:00 / 09:10 — both after the 10:00-Vilnius now (nowSecs 36000).
              departureSecs: [36600, 37200],
            },
          ],
        },
      ],
      routeIdToIdx: new Map([["R1", 0]]),
      routesAtStop: new Map([
        ["s", [0]],
        ["s2", [0]],
      ]),
      services: new Map([
        ["svc", { serviceId: "svc", days, startDate: "20260101", endDate: "20261231", exceptions: {} }],
      ]),
    };
  }

  it("matches a Wednesday-only service on a Wednesday (Mon-first index)", () => {
    const idx = indexForMask([false, false, true, false, false, false, false]);
    const get = makeGetNextDeparture(idx, rtStore, () => WED_0800, undefined, FEED_TZ);
    expect(get("R1", "s2")).not.toBeNull();
  });

  it("does NOT match a Thursday-only service on a Wednesday (old getDay() bug)", () => {
    // The OLD getDay()-indexed code read days[3] (the Thursday slot) on a
    // Wednesday and wrongly matched this mask.
    const idx = indexForMask([false, false, false, true, false, false, false]);
    const get = makeGetNextDeparture(idx, rtStore, () => WED_0800, undefined, FEED_TZ);
    expect(get("R1", "s2")).toBeNull();
  });
});

describe("makeGetNextDeparture — pattern-exact path (PR #395 follow-up)", () => {
  // When the index carries `patterns`/`patternsAtStop` (production
  // per-pattern wire), each pattern's trips store `departureSecs` aligned
  // to the pattern's OWN stop sequence — the displayed time at a
  // return-direction stop is readable EXACTLY instead of via the
  // canonical+positional approximation.
  const rtStore: RtStoreLite = { getTripDelay: () => null, getReceivedAt: () => null };

  // Canonical display route R1 is outbound A→B→C. The return direction
  // C→X→A exists only as a direction pattern; its display trip is
  // re-aligned to canonical columns (A=31000, B=-1 sentinel, C=30000),
  // so the legacy positional path at X reads 31000 (wrong: that's the
  // arrival back at A). The per-pattern wire stores the return pattern's
  // own columns, where X really departs at 30500.
  function makePatternModeIndex(): RaptorIndexLite {
    return {
      routes: [
        {
          id: "R1",
          shortName: "1",
          stopIds: ["A", "B", "C"],
          directionPatterns: [
            { key: "0", headsign: "Center", stopIds: ["A", "B", "C"] },
            { key: "1", headsign: "Airport", stopIds: ["C", "X", "A"] },
          ],
          trips: [
            {
              tripId: "T-OUT",
              serviceId: "SVC-DAILY",
              headsign: "Center",
              departureSecs: [29900, 30200, 30800],
            },
            {
              tripId: "T-RET",
              serviceId: "SVC-DAILY",
              headsign: "Airport",
              departureSecs: [31000, -1, 30000],
            },
          ],
        },
      ],
      routeIdToIdx: new Map([["R1", 0]]),
      routesAtStop: new Map([
        ["A", [0]],
        ["B", [0]],
        ["C", [0]],
        ["X", [0]],
      ]),
      services: new Map([
        [
          "SVC-DAILY",
          {
            serviceId: "SVC-DAILY",
            days: [true, true, true, true, true, true, true],
            startDate: "20260101",
            endDate: "20271231",
            exceptions: {} as Record<string, number>,
          },
        ],
      ]),
      patterns: [
        {
          id: "R1",
          shortName: "1",
          stopIds: ["A", "B", "C"],
          trips: [
            {
              tripId: "T-OUT",
              serviceId: "SVC-DAILY",
              headsign: "Center",
              departureSecs: [29900, 30200, 30800],
            },
          ],
        },
        {
          id: "R1",
          shortName: "1",
          stopIds: ["C", "X", "A"],
          trips: [
            {
              tripId: "T-RET",
              serviceId: "SVC-DAILY",
              headsign: "Airport",
              departureSecs: [30000, 30500, 31000],
            },
          ],
        },
      ],
      patternsAtStop: new Map([
        ["A", [0, 1]],
        ["B", [0]],
        ["C", [0, 1]],
        ["X", [1]],
      ]),
    };
  }

  it("reads the exact pattern-column time at a return-only stop (no ~ approximation)", () => {
    const fn = makeGetNextDeparture(makePatternModeIndex(), rtStore, () => PINNED_MS);
    // nowSecs = 30100. Pattern column for X = 30500 → floor(400/60) = 6.
    // The legacy positional path would have returned 31000 → 15 min, ~-flagged.
    expect(fn("R1", "X")).toMatchObject({
      minutesUntil: 6,
      routeShortName: "1",
      headsign: "Airport",
      isApproximate: false,
    });
  });

  it("canonical stop also reads via the pattern path (both patterns considered)", () => {
    const fn = makeGetNextDeparture(makePatternModeIndex(), rtStore, () => PINNED_MS);
    // At C: outbound column 2 = 30800 (T-OUT), return column 0 = 30000 (past).
    // Earliest upcoming = 30800 → floor(700/60) = 11.
    expect(fn("R1", "C")).toMatchObject({
      minutesUntil: 11,
      routeShortName: "1",
      headsign: "Center",
      isApproximate: false,
    });
  });

  it("checks EVERY occurrence of the stop in a loop/lasso pattern", () => {
    // Lasso: A→B→A in a single trip (repeated first/last stop per GTFS
    // best-practices #loop-routes). First occurrence departed (29000 < now),
    // second occurrence 30400 is upcoming — must be found.
    const idx = makePatternModeIndex();
    idx.routes.push({
      id: "R2",
      shortName: "2",
      stopIds: ["A", "B"],
      trips: [
        {
          tripId: "T-L",
          serviceId: "SVC-DAILY",
          headsign: "Loop",
          departureSecs: [29000, 29800],
        },
      ],
    });
    idx.routeIdToIdx.set("R2", 1);
    idx.patterns!.push({
      id: "R2",
      shortName: "2",
      stopIds: ["A", "B", "A"],
      trips: [
        {
          tripId: "T-L",
          serviceId: "SVC-DAILY",
          headsign: "Loop",
          departureSecs: [29000, 29800, 30400],
        },
      ],
    });
    idx.patternsAtStop!.get("A")!.push(2);
    idx.patternsAtStop!.get("B")!.push(2);
    const fn = makeGetNextDeparture(idx, rtStore, () => PINNED_MS);
    // 30400 - 30100 = 300 → 5 min.
    expect(fn("R2", "A")).toMatchObject({
      minutesUntil: 5,
      routeShortName: "2",
      headsign: "Loop",
      isApproximate: false,
    });
  });

  it("skips -1 fold sentinels in pattern columns (covering-merge folded member)", () => {
    const idx = makePatternModeIndex();
    // Folded member trip doesn't serve X (column -1); a later trip does.
    idx.patterns![1].trips = [
      {
        tripId: "T-FOLD",
        serviceId: "SVC-DAILY",
        headsign: "Airport",
        departureSecs: [30050, -1, 30900],
      },
      {
        tripId: "T-RET",
        serviceId: "SVC-DAILY",
        headsign: "Airport",
        departureSecs: [30200, 30700, 31200],
      },
    ];
    const fn = makeGetNextDeparture(idx, rtStore, () => PINNED_MS);
    // T-FOLD's X column is -1 (unserved) — must not be read as a
    // departure. T-RET's exact X column 30700 wins → floor(600/60) = 10.
    expect(fn("R1", "X")?.minutesUntil).toBe(10);
    expect(fn("R1", "X")?.isApproximate).toBe(false);
  });

  it("surfaces yesterday's overnight tail (dep >= 86400) on the pattern path", () => {
    // 2026-06-18 (Thursday) 04:10:00 → nowSecs = 15000. Yesterday
    // (Wednesday) service's trip departs X at 104400 (= 29:00, i.e. 05:00
    // Thursday) → today-relative 18000 → 50 min away.
    const EARLY = new Date(2026, 5, 18, 4, 10, 0).getTime();
    const idx = makePatternModeIndex();
    idx.services.set("SVC-WED", {
      serviceId: "SVC-WED",
      days: [false, false, true, false, false, false, false],
      startDate: "20260101",
      endDate: "20271231",
      exceptions: {} as Record<string, number>,
    });
    idx.patterns![1].trips = [
      {
        tripId: "T-NIGHT",
        serviceId: "SVC-WED",
        headsign: "Airport",
        departureSecs: [103800, 104400, 105000],
      },
    ];
    // Keep the display route consistent (not read by the exact path).
    idx.routes[0].trips = idx.routes[0].trips.filter((t) => t.tripId === "T-OUT");
    const fn = makeGetNextDeparture(idx, rtStore, () => EARLY);
    expect(fn("R1", "X")?.minutesUntil).toBe(50);
    expect(fn("R1", "X")?.isApproximate).toBe(false);
  });

  it("frequency-based trip: next time comes from the service window, not template clock times", () => {
    const idx = makePatternModeIndex();
    // Template return trip: C=30000, X=30300 → X offset past first stop = 300.
    // Window 30000..43200 every 600 s, exact_times=0 → departures at X are
    // 30300, 30900, 31500, … The next one ≥ now(30100) is 30300 → 3 min.
    // The template's own X clock time is irrelevant.
    idx.patterns![1].trips = [
      {
        tripId: "T-FREQ",
        serviceId: "SVC-DAILY",
        headsign: "Airport",
        ptbTripIdx: 7,
        departureSecs: [30000, 30300, 30600],
      },
    ];
    idx.frequenciesByTrip = new Map([
      [7, [{ startSecs: 30000, endSecs: 43200, headwaySecs: 600, exactTimes: 0 }]],
    ]);
    const fn = makeGetNextDeparture(idx, rtStore, () => PINNED_MS);
    const dep = fn("R1", "X");
    expect(dep?.minutesUntil).toBe(3);
    // exact_times=0 is headway-based (no fixed schedule) → keep the ~ flag.
    expect(dep?.isApproximate).toBe(true);
  });

  it("frequency exact_times=1 is a real schedule → not flagged approximate", () => {
    const idx = makePatternModeIndex();
    idx.patterns![1].trips = [
      {
        tripId: "T-FREQ",
        serviceId: "SVC-DAILY",
        headsign: "Airport",
        ptbTripIdx: 7,
        departureSecs: [30000, 30300, 30600],
      },
    ];
    idx.frequenciesByTrip = new Map([
      [7, [{ startSecs: 30000, endSecs: 43200, headwaySecs: 600, exactTimes: 1 }]],
    ]);
    const fn = makeGetNextDeparture(idx, rtStore, () => PINNED_MS);
    const dep = fn("R1", "X");
    expect(dep?.minutesUntil).toBe(3);
    expect(dep?.isApproximate).toBe(false);
  });

  it("frequency window fully past → null (no fallback to template clock times)", () => {
    const idx = makePatternModeIndex();
    idx.patterns![1].trips = [
      {
        tripId: "T-FREQ",
        serviceId: "SVC-DAILY",
        headsign: "Airport",
        ptbTripIdx: 7,
        // Template columns are in the future — must NOT be surfaced.
        departureSecs: [30000, 30300, 30600],
      },
    ];
    // Window ended hours before now (30100).
    idx.frequenciesByTrip = new Map([
      [7, [{ startSecs: 10000, endSecs: 20000, headwaySecs: 600, exactTimes: 0 }]],
    ]);
    // Remove the outbound pattern's coverage of X so only the freq trip counts.
    const fn = makeGetNextDeparture(idx, rtStore, () => PINNED_MS);
    expect(fn("R1", "X")).toBeNull();
  });

  it("covered stop with no upcoming pattern departure → null (exact, no legacy fallback)", () => {
    const idx = makePatternModeIndex();
    // All return-pattern departures in the past; the display route's
    // canonical-aligned T-RET still shows 31000 at column A — the legacy
    // positional path would wrongly surface it.
    idx.patterns![1].trips = [
      {
        tripId: "T-RET",
        serviceId: "SVC-DAILY",
        headsign: "Airport",
        departureSecs: [8000, 8500, 9000],
      },
    ];
    const fn = makeGetNextDeparture(idx, rtStore, () => PINNED_MS);
    expect(fn("R1", "X")).toBeNull();
  });

  it("applies RT delay to the pattern-path winner", () => {
    const rt: RtStoreLite = {
      getTripDelay: (tripId) =>
        tripId === "T-RET" ? { delaySeconds: 60, cancelled: false } : null,
      getReceivedAt: (tripId) => (tripId === "T-RET" ? PINNED_MS : null),
    };
    const fn = makeGetNextDeparture(makePatternModeIndex(), rt, () => PINNED_MS);
    // 30500 + 60 = 30560 → floor(460/60) = 7.
    expect(fn("R1", "X")?.minutesUntil).toBe(7);
  });

  it("stop absent from patternsAtStop → legacy positional fallback (stale per-route wire)", () => {
    const idx = makePatternModeIndex();
    // Simulate a per-route wire: X lives only in directionPatterns.
    idx.patternsAtStop!.delete("X");
    const fn = makeGetNextDeparture(idx, rtStore, () => PINNED_MS);
    const dep = fn("R1", "X");
    // Positional approximation: earliest in-future canonical column of the
    // headsign-matched T-RET = 31000 → 15 min, ~-flagged.
    expect(dep?.minutesUntil).toBe(15);
    expect(dep?.isApproximate).toBe(true);
  });

  it("stop covered only by ANOTHER route's patterns → legacy fallback for this route", () => {
    const idx = makePatternModeIndex();
    // X is in patternsAtStop, but only via R9's pattern — R1's patterns
    // don't contain it (per-route wire whose return stops live only in
    // directionPatterns). Must degrade to the legacy path, not read
    // "no pattern serves X" as exact inactivity.
    idx.patterns![1] = {
      id: "R9",
      shortName: "9",
      stopIds: ["C", "X", "A"],
      trips: [],
    };
    const fn = makeGetNextDeparture(idx, rtStore, () => PINNED_MS);
    const dep = fn("R1", "X");
    expect(dep?.minutesUntil).toBe(15);
    expect(dep?.isApproximate).toBe(true);
  });

  it("PatternMode.Off index (no patterns) → legacy behavior unchanged", () => {
    const idx = makePatternModeIndex();
    delete idx.patterns;
    delete idx.patternsAtStop;
    const fn = makeGetNextDeparture(idx, rtStore, () => PINNED_MS);
    const dep = fn("R1", "X");
    expect(dep?.minutesUntil).toBe(15);
    expect(dep?.isApproximate).toBe(true);
  });
});
