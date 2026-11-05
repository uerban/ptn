import { describe, it, expect } from "vitest";
import { buildTripTimeline, estimateVehicle, type TripTimeline } from "./tripTimeline.ts";
import { pattern, patternIndex } from "../test-helpers/patternIndex.ts";

const VILNIUS = "Europe/Vilnius"; // June 2026 = EEST, UTC+3

const NAMES = new Map([
  ["A", "Alpha"],
  ["B", "Bravo"],
  ["S", "Station"],
  ["C", "Charlie"],
  ["D", "Delta"],
  ["T", "Terminal"],
  ["X", "Crossing"],
  ["L1", "Loop one"],
  ["L2", "Loop two"],
]);

/** `[stopId, ISO]` pairs, so a failure shows which stop drifted. */
function times(timeline: TripTimeline | null): [string, string][] {
  return (timeline?.stops ?? []).map((s) => [s.stopId, s.scheduled.toISOString()]);
}

// Line 1: A 08:00, B 08:02, S 08:04, C 08:06, D 08:10 (Vilnius wall clock).
const LINE_ONE = pattern("1", ["A", "B", "S", "C", "D"], [
  { tripId: "t1", departureSecs: [28800, 28920, 29040, 29160, 29400] },
]);

// Lasso (https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes):
// one trip T → X → S → loop → S → X → T, so S (and X, T) appear twice.
const LASSO = pattern("9", ["T", "X", "S", "L1", "L2", "S", "X", "T"], [
  { tripId: "lasso", departureSecs: [28800, 29100, 29400, 29700, 30000, 30300, 30600, 30900] },
]);

describe("buildTripTimeline", () => {
  it("builds every stop of the trip with times relative to the boarding stop", () => {
    const timeline = buildTripTimeline(patternIndex([LINE_ONE]), {
      tripId: "t1",
      stopId: "S",
      scheduledTime: "2026-06-15T05:04:00.000Z", // 08:04 Vilnius
      tz: VILNIUS,
      stopNames: NAMES,
    });
    expect(timeline?.boardingIndex).toBe(2);
    expect(timeline?.stops.map((s) => s.name)).toEqual(["Alpha", "Bravo", "Station", "Charlie", "Delta"]);
    expect(times(timeline)).toEqual([
      ["A", "2026-06-15T05:00:00.000Z"],
      ["B", "2026-06-15T05:02:00.000Z"],
      ["S", "2026-06-15T05:04:00.000Z"],
      ["C", "2026-06-15T05:06:00.000Z"],
      ["D", "2026-06-15T05:10:00.000Z"],
    ]);
  });

  it("anchors on the departure's own instant, not on the trip's service-day times", () => {
    // A departure 90 min after the template trip (e.g. a frequencies.txt run
    // read against its template times) shifts the whole timeline with it.
    const timeline = buildTripTimeline(patternIndex([LINE_ONE]), {
      tripId: "t1",
      stopId: "S",
      scheduledTime: "2026-06-15T06:34:00.000Z",
      tz: VILNIUS,
      stopNames: NAMES,
    });
    expect(timeline?.boardingIndex).toBe(2);
    expect(times(timeline)[0]).toEqual(["A", "2026-06-15T06:30:00.000Z"]);
    expect(times(timeline)[4]).toEqual(["D", "2026-06-15T06:40:00.000Z"]);
  });

  it("handles times past 24:00 across midnight", () => {
    // N1 23:50, N2 24:10, N3 25:10 on service day 2026-06-15.
    const night = pattern("N", ["N1", "N2", "N3"], [
      { tripId: "n1", departureSecs: [85800, 87000, 90600] },
    ]);
    const timeline = buildTripTimeline(patternIndex([night]), {
      tripId: "n1",
      stopId: "N2",
      scheduledTime: "2026-06-15T21:10:00.000Z", // 2026-06-16 00:10 Vilnius
      tz: VILNIUS,
      stopNames: NAMES,
    });
    expect(timeline?.boardingIndex).toBe(1);
    expect(times(timeline)).toEqual([
      ["N1", "2026-06-15T20:50:00.000Z"],
      ["N2", "2026-06-15T21:10:00.000Z"],
      ["N3", "2026-06-15T22:10:00.000Z"],
    ]);
  });

  it("omits the positions the trip skips (-1) and indexes boarding in the kept list", () => {
    // A CoveringMerge folded trip: holes at the pattern positions it does not serve.
    const folded = pattern("R", ["s0", "s1", "s2", "s3", "s4"], [
      { tripId: "short", departureSecs: [-1, 29000, 29300, -1, 29900] },
    ]);
    const timeline = buildTripTimeline(patternIndex([folded]), {
      tripId: "short",
      stopId: "s2",
      scheduledTime: "2026-06-15T05:08:20.000Z", // 29300 = 08:08:20 Vilnius
      tz: VILNIUS,
      stopNames: NAMES,
    });
    expect(timeline?.boardingIndex).toBe(1);
    expect(times(timeline)).toEqual([
      ["s1", "2026-06-15T05:03:20.000Z"],
      ["s2", "2026-06-15T05:08:20.000Z"],
      ["s4", "2026-06-15T05:18:20.000Z"],
    ]);
  });

  it("falls back to the stop id when a stop has no name", () => {
    const timeline = buildTripTimeline(patternIndex([LINE_ONE]), {
      tripId: "t1",
      stopId: "S",
      scheduledTime: "2026-06-15T05:04:00.000Z",
      tz: VILNIUS,
      stopNames: new Map([["S", "Station"]]),
    });
    expect(timeline?.stops.map((s) => s.name)).toEqual(["A", "B", "Station", "C", "D"]);
  });

  it("finds the trip in any pattern and uses that pattern's own stops", () => {
    const other = pattern("2", ["Q", "S", "R"], [{ tripId: "t2", departureSecs: [30000, 30300, 30600] }]);
    const timeline = buildTripTimeline(patternIndex([LINE_ONE, other]), {
      tripId: "t2",
      stopId: "S",
      scheduledTime: "2026-06-15T05:25:00.000Z",
      tz: VILNIUS,
      stopNames: NAMES,
    });
    expect(timeline?.boardingIndex).toBe(1);
    expect(timeline?.stops.map((s) => s.stopId)).toEqual(["Q", "S", "R"]);
  });

  describe("lasso trip visiting the boarding stop twice", () => {
    it("picks the second occurrence when the departure's city time of day matches it", () => {
      const timeline = buildTripTimeline(patternIndex([LASSO]), {
        tripId: "lasso",
        stopId: "S",
        scheduledTime: "2026-06-15T05:25:00.000Z", // 08:25 Vilnius = position 5
        tz: VILNIUS,
        stopNames: NAMES,
      });
      expect(timeline?.boardingIndex).toBe(5);
      expect(times(timeline)[0]).toEqual(["T", "2026-06-15T05:00:00.000Z"]);
      expect(times(timeline)[5]).toEqual(["S", "2026-06-15T05:25:00.000Z"]);
      expect(times(timeline)[7]).toEqual(["T", "2026-06-15T05:35:00.000Z"]);
    });

    it("picks the first occurrence when the time of day matches it", () => {
      const timeline = buildTripTimeline(patternIndex([LASSO]), {
        tripId: "lasso",
        stopId: "S",
        scheduledTime: "2026-06-15T05:10:00.000Z", // 08:10 Vilnius = position 2
        tz: VILNIUS,
        stopNames: NAMES,
      });
      expect(timeline?.boardingIndex).toBe(2);
      expect(times(timeline)[7]).toEqual(["T", "2026-06-15T05:35:00.000Z"]);
    });

    it("falls back to the first occurrence when no occurrence matches", () => {
      const timeline = buildTripTimeline(patternIndex([LASSO]), {
        tripId: "lasso",
        stopId: "S",
        scheduledTime: "2026-06-15T05:13:00.000Z", // 08:13 matches neither
        tz: VILNIUS,
        stopNames: NAMES,
      });
      expect(timeline?.boardingIndex).toBe(2);
      expect(times(timeline)[0]).toEqual(["T", "2026-06-15T05:03:00.000Z"]);
      expect(times(timeline)[2]).toEqual(["S", "2026-06-15T05:13:00.000Z"]);
    });

    it("reads the time of day in the given zone", () => {
      // The same instant, 05:25Z, is 08:25 in Vilnius (position 5) but 05:25
      // in UTC, which matches no occurrence and falls back to the first.
      const args = { tripId: "lasso", stopId: "S", scheduledTime: "2026-06-15T05:25:00.000Z", stopNames: NAMES };
      expect(buildTripTimeline(patternIndex([LASSO]), { ...args, tz: VILNIUS })?.boardingIndex).toBe(5);
      expect(buildTripTimeline(patternIndex([LASSO]), { ...args, tz: "UTC" })?.boardingIndex).toBe(2);
    });

    it("matches an occurrence past 24:00 by its wall-clock time of day", () => {
      // Night lasso: S at 24:40 and 25:10 on service day 2026-06-15.
      const nightLasso = pattern("N9", ["T", "S", "L1", "S", "T"], [
        { tripId: "nl", departureSecs: [88200, 88800, 89700, 90600, 91200] },
      ]);
      const timeline = buildTripTimeline(patternIndex([nightLasso]), {
        tripId: "nl",
        stopId: "S",
        scheduledTime: "2026-06-15T22:10:00.000Z", // 2026-06-16 01:10 Vilnius = 25:10
        tz: VILNIUS,
        stopNames: NAMES,
      });
      expect(timeline?.boardingIndex).toBe(3);
      expect(times(timeline)[0]).toEqual(["T", "2026-06-15T21:30:00.000Z"]);
      expect(times(timeline)[4]).toEqual(["T", "2026-06-15T22:20:00.000Z"]);
    });
  });

  describe("no timeline", () => {
    const args = {
      tripId: "t1",
      stopId: "S",
      scheduledTime: "2026-06-15T05:04:00.000Z",
      tz: VILNIUS,
      stopNames: NAMES,
    };

    it("returns null for a trip that is in no pattern", () => {
      expect(buildTripTimeline(patternIndex([LINE_ONE]), { ...args, tripId: "ghost" })).toBeNull();
    });

    it("returns null when patterns are absent (PatternMode Off / Dexie fallback)", () => {
      expect(buildTripTimeline({}, args)).toBeNull();
    });

    it("returns null without an index", () => {
      expect(buildTripTimeline(null, args)).toBeNull();
    });

    it("returns null when the trip does not serve the boarding stop", () => {
      expect(buildTripTimeline(patternIndex([LINE_ONE]), { ...args, stopId: "elsewhere" })).toBeNull();
    });

    it("returns null when the boarding stop is only at a position the trip skips", () => {
      const folded = pattern("R", ["s0", "s1", "s2"], [{ tripId: "short", departureSecs: [-1, 29000, 29300] }]);
      expect(buildTripTimeline(patternIndex([folded]), { ...args, tripId: "short", stopId: "s0" })).toBeNull();
    });

    it("returns null for an unparseable scheduled time", () => {
      expect(buildTripTimeline(patternIndex([LINE_ONE]), { ...args, scheduledTime: "not a time" })).toBeNull();
    });
  });
});

/** 2026-06-15 UTC wall clock, `"05:02:30"` → that instant. */
function utc(hms: string): Date {
  return new Date(`2026-06-15T${hms}.000Z`);
}

/** A hand-built timeline, boarding at `boardingIndex`. */
function timelineOf(stops: [string, string][], boardingIndex = 0): TripTimeline {
  return {
    stops: stops.map(([stopId, hms]) => ({ stopId, name: stopId, scheduled: utc(hms) })),
    boardingIndex,
  };
}

describe("estimateVehicle", () => {
  // A 05:00, B 05:02, S 05:04 (boarding), C 05:06, D 05:10.
  const TRIP = timelineOf(
    [
      ["A", "05:00:00"],
      ["B", "05:02:00"],
      ["S", "05:04:00"],
      ["C", "05:06:00"],
      ["D", "05:10:00"],
    ],
    2,
  );
  const at = (hms: string, delay?: number) => estimateVehicle(TRIP, utc(hms), delay);

  it("is not started before the first stop, with the first stop's time", () => {
    expect(at("04:50:00")).toEqual({ kind: "not_started", firstStopId: "A", departs: utc("05:00:00") });
    expect(at("04:59:29")).toEqual({ kind: "not_started", firstStopId: "A", departs: utc("05:00:00") });
  });

  it("is at a stop within ±30 s of its time, inclusive", () => {
    expect(at("05:01:30")).toEqual({ kind: "at_stop", index: 1 });
    expect(at("05:02:00")).toEqual({ kind: "at_stop", index: 1 });
    expect(at("05:02:30")).toEqual({ kind: "at_stop", index: 1 });
    expect(at("05:04:10")).toEqual({ kind: "at_stop", index: 2 });
  });

  it("is at the first and last stops inside their windows, not not-started or finished", () => {
    expect(at("04:59:30")).toEqual({ kind: "at_stop", index: 0 });
    expect(at("05:00:20")).toEqual({ kind: "at_stop", index: 0 });
    expect(at("05:09:40")).toEqual({ kind: "at_stop", index: 4 });
    expect(at("05:10:30")).toEqual({ kind: "at_stop", index: 4 });
  });

  it("is between two stops mid-segment", () => {
    expect(at("05:01:00")).toEqual({ kind: "between", fromIndex: 0, toIndex: 1 });
    expect(at("05:02:31")).toEqual({ kind: "between", fromIndex: 1, toIndex: 2 });
    expect(at("05:03:29")).toEqual({ kind: "between", fromIndex: 1, toIndex: 2 });
    expect(at("05:08:00")).toEqual({ kind: "between", fromIndex: 3, toIndex: 4 });
  });

  it("is finished after the last stop", () => {
    expect(at("05:10:31")).toEqual({ kind: "finished" });
    expect(at("06:00:00")).toEqual({ kind: "finished" });
  });

  it("shifts every boundary by a +180 s delay", () => {
    // Delayed: A 05:03, B 05:05, S 05:07, C 05:09, D 05:13.
    expect(at("05:00:00", 180)).toEqual({ kind: "not_started", firstStopId: "A", departs: utc("05:03:00") });
    expect(at("05:02:40", 180)).toEqual({ kind: "at_stop", index: 0 });
    expect(at("05:04:00", 180)).toEqual({ kind: "between", fromIndex: 0, toIndex: 1 });
    expect(at("05:05:00", 180)).toEqual({ kind: "at_stop", index: 1 });
    expect(at("05:07:30", 180)).toEqual({ kind: "at_stop", index: 2 });
    expect(at("05:12:00", 180)).toEqual({ kind: "between", fromIndex: 3, toIndex: 4 });
    expect(at("05:13:30", 180)).toEqual({ kind: "at_stop", index: 4 });
    expect(at("05:13:31", 180)).toEqual({ kind: "finished" });
    // The same instants on the timetable alone read differently.
    expect(at("05:00:00")).toEqual({ kind: "at_stop", index: 0 });
    expect(at("05:04:00")).toEqual({ kind: "at_stop", index: 2 });
    expect(at("05:05:00")).toEqual({ kind: "between", fromIndex: 2, toIndex: 3 });
    expect(at("05:12:00")).toEqual({ kind: "finished" });
  });

  it("shifts every boundary earlier for a negative delay (running early)", () => {
    expect(at("04:58:50", -60)).toEqual({ kind: "at_stop", index: 0 });
    expect(at("05:01:00", -60)).toEqual({ kind: "at_stop", index: 1 });
    expect(at("05:09:31", -60)).toEqual({ kind: "finished" });
  });

  it("reads an undefined delay as the timetable alone", () => {
    for (let s = 4 * 3600 + 58 * 60; s <= 5 * 3600 + 12 * 60; s += 5) {
      const now = new Date(Date.UTC(2026, 5, 15) + s * 1000);
      expect(estimateVehicle(TRIP, now, undefined)).toEqual(estimateVehicle(TRIP, now, 0));
    }
    expect(at("05:04:00", undefined)).toEqual({ kind: "at_stop", index: 2 });
  });

  it("reads a non-finite delay as the timetable alone", () => {
    expect(at("05:04:00", Number.NaN)).toEqual({ kind: "at_stop", index: 2 });
    expect(at("05:04:00", Number.POSITIVE_INFINITY)).toEqual({ kind: "at_stop", index: 2 });
  });

  it("picks the nearer stop when two windows overlap", () => {
    // B and B2 are 40 s apart: their ±30 s windows overlap.
    const close = timelineOf([
      ["A", "05:00:00"],
      ["B", "05:02:00"],
      ["B2", "05:02:40"],
      ["D", "05:10:00"],
    ]);
    expect(estimateVehicle(close, utc("05:02:15"), undefined)).toEqual({ kind: "at_stop", index: 1 });
    expect(estimateVehicle(close, utc("05:02:25"), undefined)).toEqual({ kind: "at_stop", index: 2 });
    expect(estimateVehicle(close, utc("05:02:35"), undefined)).toEqual({ kind: "at_stop", index: 2 });
  });

  it("is at the first of stops sharing one time while approaching and the last once past", () => {
    // Minute-resolution timetables often give neighbouring stops the same time.
    const same = timelineOf([
      ["A", "05:00:00"],
      ["X", "05:02:00"],
      ["Y", "05:02:00"],
      ["D", "05:10:00"],
    ]);
    expect(estimateVehicle(same, utc("05:01:50"), undefined)).toEqual({ kind: "at_stop", index: 1 });
    expect(estimateVehicle(same, utc("05:02:00"), undefined)).toEqual({ kind: "at_stop", index: 2 });
    expect(estimateVehicle(same, utc("05:02:10"), undefined)).toEqual({ kind: "at_stop", index: 2 });
    expect(estimateVehicle(same, utc("05:03:00"), undefined)).toEqual({ kind: "between", fromIndex: 2, toIndex: 3 });
  });

  it("estimates a timeline built from the index, past 24:00", () => {
    // N1 23:50, N2 24:10, N3 25:10 on service day 2026-06-15 (Vilnius).
    const night = pattern("N", ["N1", "N2", "N3"], [{ tripId: "n1", departureSecs: [85800, 87000, 90600] }]);
    const timeline = buildTripTimeline(patternIndex([night]), {
      tripId: "n1",
      stopId: "N2",
      scheduledTime: "2026-06-15T21:10:00.000Z",
      tz: VILNIUS,
      stopNames: NAMES,
    });
    expect(timeline).not.toBeNull();
    const tl = timeline as TripTimeline;
    expect(estimateVehicle(tl, new Date("2026-06-15T21:40:00.000Z"), 120)).toEqual({
      kind: "between",
      fromIndex: 1,
      toIndex: 2,
    });
    expect(estimateVehicle(tl, new Date("2026-06-15T22:12:00.000Z"), 120)).toEqual({ kind: "at_stop", index: 2 });
    expect(estimateVehicle(tl, new Date("2026-06-15T22:12:31.000Z"), 120)).toEqual({ kind: "finished" });
  });

  it("is finished for a timeline with no stops", () => {
    expect(estimateVehicle({ stops: [], boardingIndex: 0 }, utc("05:00:00"), undefined)).toEqual({ kind: "finished" });
  });
});
