import { describe, it, expect } from "vitest";
import type { Itinerary, Leg } from "@pt/shared";
import {
  peakDelayMinutes,
  rideSeconds,
  toSegments,
  transferRisk,
  TIGHT_WAIT_MIN,
} from "../../src/components/RouteResults/shared/legHelpers.ts";
import type {
  Segment,
  BufferWaitSegment,
  RideSegment,
  WalkSegment,
  WaitSegment,
} from "../../src/components/RouteResults/shared/legHelpers.ts";
import { place, ride, walk, itinerary } from "./shared-fixtures.ts";

describe("toSegments", () => {
  it("synthesizes a wait segment when two transit legs share a stop", () => {
    const stop = place("Stop A", 54.68, 25.28, "A");
    const stop2 = place("Stop B", 54.69, 25.29, "B");
    const it = itinerary([
      ride({
        from: stop,
        to: stop,
        depart: "2026-01-01T10:00:00Z",
        arrive: "2026-01-01T10:15:00Z",
        routeShortName: "3G",
      }),
      ride({
        from: stop,
        to: stop2,
        depart: "2026-01-01T10:17:00Z",
        arrive: "2026-01-01T10:30:00Z",
        routeShortName: "1",
      }),
    ]);
    const segs = toSegments(it);
    expect(segs.map((s) => s.kind)).toEqual(["ride", "wait", "ride"]);
    const wait = segs[1];
    if (wait.kind !== "wait") throw new Error("expected wait");
    expect(wait.minutes).toBe(2);
    expect(wait.sameStop).toBe(true);
    expect(wait.tight).toBe(true); // 2 < TIGHT_WAIT_MIN (3)
  });

  it("marks wait as not-tight when >= TIGHT_WAIT_MIN", () => {
    const a = place("A", 54.68, 25.28, "A");
    const it = itinerary([
      ride({
        from: a,
        to: a,
        depart: "2026-01-01T10:00:00Z",
        arrive: "2026-01-01T10:10:00Z",
      }),
      ride({
        from: a,
        to: place("B", 54.7, 25.3, "B"),
        depart: new Date(
          new Date("2026-01-01T10:10:00Z").getTime() + TIGHT_WAIT_MIN * 60 * 1000,
        ).toISOString(),
        arrive: "2026-01-01T10:30:00Z",
      }),
    ]);
    const wait = toSegments(it).find((s) => s.kind === "wait");
    expect(wait?.kind).toBe("wait");
    if (wait?.kind === "wait") {
      expect(wait.minutes).toBe(TIGHT_WAIT_MIN);
      expect(wait.tight).toBe(false);
    }
  });

  it("marks walk between two rides as transferWalk", () => {
    const a = place("A", 54.68, 25.28, "A");
    const b = place("B", 54.69, 25.29, "B");
    const c = place("C", 54.7, 25.3, "C");
    const it = itinerary([
      ride({
        from: a,
        to: b,
        depart: "2026-01-01T10:00:00Z",
        arrive: "2026-01-01T10:10:00Z",
      }),
      walk({
        from: b,
        to: c,
        depart: "2026-01-01T10:10:00Z",
        arrive: "2026-01-01T10:13:00Z",
        meters: 220,
      }),
      ride({
        from: c,
        to: place("D", 54.71, 25.31, "D"),
        depart: "2026-01-01T10:15:00Z",
        arrive: "2026-01-01T10:25:00Z",
      }),
    ]);
    const walkSeg = toSegments(it).find((s) => s.kind === "walk");
    expect(walkSeg?.kind).toBe("walk");
    if (walkSeg?.kind === "walk") {
      expect(walkSeg.transferWalk).toBe(true);
      expect(walkSeg.meters).toBe(220);
    }
  });

  it("does not mark first-mile / last-mile walks as transferWalk", () => {
    const origin = place("Origin", 0, 0);
    const stop = place("Stop", 54.68, 25.28, "S");
    const dest = place("Dest", 0, 0);
    const it = itinerary([
      walk({
        from: origin,
        to: stop,
        depart: "2026-01-01T10:00:00Z",
        arrive: "2026-01-01T10:05:00Z",
      }),
      ride({
        from: stop,
        to: stop,
        depart: "2026-01-01T10:05:00Z",
        arrive: "2026-01-01T10:20:00Z",
      }),
      walk({
        from: stop,
        to: dest,
        depart: "2026-01-01T10:20:00Z",
        arrive: "2026-01-01T10:22:00Z",
      }),
    ]);
    const walks = toSegments(it).filter((s) => s.kind === "walk");
    expect(walks).toHaveLength(2);
    for (const w of walks) {
      if (w.kind === "walk") expect(w.transferWalk).toBe(false);
    }
  });

  it("falls back to coordinate comparison when stopIds are absent", () => {
    const a = place("A", 54.68, 25.28); // no stopId
    const it = itinerary([
      ride({
        from: a,
        to: a,
        depart: "2026-01-01T10:00:00Z",
        arrive: "2026-01-01T10:10:00Z",
      }),
      ride({
        from: a,
        to: place("B", 54.69, 25.29),
        depart: "2026-01-01T10:11:00Z",
        arrive: "2026-01-01T10:20:00Z",
      }),
    ]);
    const wait = toSegments(it).find((s) => s.kind === "wait");
    expect(wait?.kind).toBe("wait");
    if (wait?.kind === "wait") expect(wait.sameStop).toBe(true);
  });

  it("emits no wait when gap is zero or legs arrive simultaneously", () => {
    const a = place("A", 0, 0, "A");
    const b = place("B", 0, 0, "B");
    const it = itinerary([
      ride({
        from: a,
        to: a,
        depart: "2026-01-01T10:00:00Z",
        arrive: "2026-01-01T10:10:00Z",
      }),
      ride({
        from: a,
        to: b,
        depart: "2026-01-01T10:10:00Z",
        arrive: "2026-01-01T10:20:00Z",
      }),
    ]);
    const kinds = toSegments(it).map((s) => s.kind);
    expect(kinds).toEqual(["ride", "ride"]); // no wait synthesized
  });

  it("returns 0 minutes for malformed ISO timestamps instead of NaN", () => {
    // Direct Leg with bogus ISO to exercise waitMinutes' guard.
    const a = place("A", 0, 0, "A");
    const legs: Leg[] = [
      {
        mode: "BUS",
        from: a,
        to: a,
        departureTime: "not-a-date",
        arrivalTime: "also-not-a-date",
        durationSeconds: 600,
        routeShortName: "3G",
      },
      {
        mode: "BUS",
        from: a,
        to: place("B", 0, 0, "B"),
        departureTime: "still-invalid",
        arrivalTime: "whatever",
        durationSeconds: 500,
        routeShortName: "1",
      },
    ];
    const it: Itinerary = {
      legs,
      departureTime: "2026-01-01T10:00:00Z",
      arrivalTime: "2026-01-01T10:20:00Z",
      durationSeconds: 1200,
      transfers: 1,
      walkingDistanceMeters: 0,
    };
    const segs = toSegments(it);
    for (const s of segs) {
      expect(Number.isFinite(s.minutes)).toBe(true);
    }
  });
});

describe("transferRisk", () => {
  it("returns 'tight' when a wait is < TIGHT_WAIT_MIN without delay", () => {
    const a = place("A", 54.68, 25.28, "A");
    const it = itinerary([
      ride({
        from: a,
        to: a,
        depart: "2026-01-01T10:00:00Z",
        arrive: "2026-01-01T10:10:00Z",
      }),
      ride({
        from: a,
        to: place("B", 0, 0, "B"),
        depart: "2026-01-01T10:12:00Z",
        arrive: "2026-01-01T10:20:00Z",
      }),
    ]);
    expect(transferRisk(it)).toBe("tight");
  });

  it("returns 'miss' when upstream delay consumes the tight wait", () => {
    const a = place("A", 54.68, 25.28, "A");
    const it = itinerary([
      ride({
        from: a,
        to: a,
        depart: "2026-01-01T10:00:00Z",
        arrive: "2026-01-01T10:10:00Z",
        delaySeconds: 180, // +3m delay, tight wait is 2m → miss
      }),
      ride({
        from: a,
        to: place("B", 0, 0, "B"),
        depart: "2026-01-01T10:12:00Z",
        arrive: "2026-01-01T10:20:00Z",
      }),
    ]);
    expect(transferRisk(it)).toBe("miss");
  });

  it("returns null when no tight waits present", () => {
    const a = place("A", 54.68, 25.28, "A");
    const it = itinerary([
      ride({
        from: a,
        to: a,
        depart: "2026-01-01T10:00:00Z",
        arrive: "2026-01-01T10:10:00Z",
      }),
      ride({
        from: a,
        to: place("B", 0, 0, "B"),
        depart: "2026-01-01T10:20:00Z",
        arrive: "2026-01-01T10:30:00Z",
      }),
    ]);
    expect(transferRisk(it)).toBeNull();
  });
});

describe("peakDelayMinutes", () => {
  it("returns the largest delay across ride legs, ignoring walks", () => {
    const a = place("A", 0, 0, "A");
    const it = itinerary([
      walk({
        from: a,
        to: a,
        depart: "2026-01-01T10:00:00Z",
        arrive: "2026-01-01T10:02:00Z",
      }),
      ride({
        from: a,
        to: a,
        depart: "2026-01-01T10:02:00Z",
        arrive: "2026-01-01T10:10:00Z",
        routeShortName: "3G",
        delaySeconds: 90, // 1.5 → 2 min rounded
      }),
      ride({
        from: a,
        to: place("B", 0, 0, "B"),
        depart: "2026-01-01T10:11:00Z",
        arrive: "2026-01-01T10:20:00Z",
        routeShortName: "1",
        delaySeconds: 240, // 4 min
      }),
    ]);
    const { minutes, line } = peakDelayMinutes(it);
    expect(minutes).toBe(4);
    expect(line).toBe("1");
  });

  it("returns 0 when no delays are reported", () => {
    const a = place("A", 0, 0, "A");
    const it = itinerary([
      ride({
        from: a,
        to: place("B", 0, 0, "B"),
        depart: "2026-01-01T10:00:00Z",
        arrive: "2026-01-01T10:10:00Z",
      }),
    ]);
    const { minutes, line } = peakDelayMinutes(it);
    expect(minutes).toBe(0);
    expect(line).toBeNull();
  });
});

describe("rideSeconds", () => {
  it("sums only non-walking leg durations", () => {
    const a = place("A", 0, 0);
    const it = itinerary([
      walk({
        from: a,
        to: a,
        depart: "2026-01-01T10:00:00Z",
        arrive: "2026-01-01T10:05:00Z",
      }),
      ride({
        from: a,
        to: a,
        depart: "2026-01-01T10:05:00Z",
        arrive: "2026-01-01T10:15:00Z",
      }),
      walk({
        from: a,
        to: a,
        depart: "2026-01-01T10:15:00Z",
        arrive: "2026-01-01T10:17:00Z",
      }),
    ]);
    expect(rideSeconds(it)).toBe(600);
  });
});

describe("Segment union exports", () => {
  it("exposes RideSegment, WalkSegment, WaitSegment, BufferWaitSegment as exported types", () => {
    // Type-level assertion: if these compile, the export shape is correct.
    const r: RideSegment = { kind: "ride", leg: {} as Leg, minutes: 0 };
    const w: WalkSegment = { kind: "walk", leg: {} as Leg, minutes: 0, meters: 0, transferWalk: false };
    const wait: WaitSegment = { kind: "wait", minutes: 0, atStopName: "", sameStop: true, tight: false };
    const buf: BufferWaitSegment = { kind: "buffer-wait", seconds: 180, atStopName: "Stop A" };
    const segs: Segment[] = [r, w, wait, buf];
    expect(segs).toHaveLength(4);
  });
});

describe("transferRisk(segments) overload", () => {
  it("accepts a Segment[] and returns the same result as transferRisk(itinerary)", () => {
    const A = place("A"), B = place("B"), C = place("C");
    const it = itinerary([
      ride({ from: A, to: B, depart: "2026-04-25T10:00:00Z", arrive: "2026-04-25T10:10:00Z", routeShortName: "1" }),
      ride({ from: B, to: C, depart: "2026-04-25T10:11:00Z", arrive: "2026-04-25T10:20:00Z", routeShortName: "2" }),
    ]);
    const segments = toSegments(it);
    expect(transferRisk(segments)).toBe(transferRisk(it));
  });

  it("BufferWaitSegment in segments is invisible (treated as no risk)", () => {
    const A = place("A"), B = place("B"), C = place("C");
    const it = itinerary([
      ride({ from: A, to: B, depart: "2026-04-25T10:00:00Z", arrive: "2026-04-25T10:10:00Z", routeShortName: "1" }),
      ride({ from: B, to: C, depart: "2026-04-25T10:15:00Z", arrive: "2026-04-25T10:20:00Z", routeShortName: "2" }),
    ]);
    const segments: Segment[] = [
      { kind: "buffer-wait", seconds: 180, atStopName: "A" },
      ...toSegments(it),
    ];
    expect(transferRisk(segments)).toBe(transferRisk(it));
  });
});
