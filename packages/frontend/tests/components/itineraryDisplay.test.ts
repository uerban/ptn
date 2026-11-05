import { describe, it, expect } from "vitest";
import type { Itinerary, Leg } from "@pt/shared";
import { deriveItineraryDisplay, shownTripSpan } from "../../src/components/RouteResults/shared/itineraryDisplay.ts";
import { toSegments, transferRisk } from "../../src/components/RouteResults/shared/legHelpers.ts";
import { place, ride, walk, itinerary, ms } from "./shared-fixtures.ts";

describe("deriveItineraryDisplay — walk-only itinerary", () => {
  it("returns no buffer and unchanged segments", () => {
    const A = place("Home"),
      B = place("Cafe");
    const it = itinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:00:00Z", arrive: "2026-04-25T10:08:00Z", meters: 600 }),
    ]);
    const out = deriveItineraryDisplay(it, {
      referenceNowMs: ms("2026-04-25T09:55:00Z"),
      bufferSeconds: 180,
    });
    expect(out.bufferSeconds).toBe(0);
    expect(out.leadingWaitSeconds).toBe(0);
    expect(out.bufferClamped).toBe(false);
    expect(out.alreadyDeparted).toBe(false);
    expect(out.parseFailed).toBe(false);
    expect(out.segments).toEqual(toSegments(it));
    expect(out.recommendedDepartureMs).toBe(ms("2026-04-25T10:00:00Z"));
  });
});

describe("deriveItineraryDisplay — walk → ride, ample slack", () => {
  it("applies full buffer; splices BufferWaitSegment between walk and ride; computes leadingWait", () => {
    const Home = place("Home"),
      Stop = place("Centre Stop", 0, 0, "S1"),
      Dest = place("Office");
    const it = itinerary([
      walk({ from: Home, to: Stop, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z", meters: 350 }),
      ride({ from: Stop, to: Dest, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "42" }),
    ]);
    const out = deriveItineraryDisplay(it, {
      referenceNowMs: ms("2026-04-25T10:00:00Z"), // 30 min before bus
      bufferSeconds: 180, // 3 min buffer
    });

    expect(out.bufferSeconds).toBe(180);
    expect(out.bufferClamped).toBe(false);
    expect(out.alreadyDeparted).toBe(false);
    expect(out.parseFailed).toBe(false);
    expect(out.recommendedDepartureMs).toBe(ms("2026-04-25T10:22:00Z")); // 10:30 − 3 min buffer − 5 min walk
    expect(out.leadingWaitSeconds).toBe(22 * 60); // 22 min from 10:00 to 10:22
    expect(out.firstTransitDepartureMs).toBe(ms("2026-04-25T10:30:00Z"));

    // Buffer-wait segment spliced between walk (idx 0) and ride (idx 1)
    expect(out.segments).toHaveLength(3);
    expect(out.segments[0].kind).toBe("walk");
    expect(out.segments[1]).toEqual({ kind: "buffer-wait", seconds: 180, atStopName: "Centre Stop" });
    expect(out.segments[2].kind).toBe("ride");
  });
});

describe("deriveItineraryDisplay — leave time counts the walk to the stop", () => {
  // The on-device planner starts the first-mile walk at the query time and
  // leaves the rest of the gap unrepresented: a 4-min walk from 17:32, then the
  // bus at 17:41. Leaving at "bus − buffer" (17:38) would put the rider at the
  // stop at 17:42, a minute after the bus.
  const Home = place("Home"),
    Stop = place("Oro uostas", 0, 0, "S1"),
    Dest = place("Airport");
  const trip = itinerary([
    walk({ from: Home, to: Stop, depart: "2026-09-25T17:32:00Z", arrive: "2026-09-25T17:36:00Z", meters: 279 }),
    ride({ from: Stop, to: Dest, depart: "2026-09-25T17:41:00Z", arrive: "2026-09-25T18:21:00Z", routeShortName: "3G" }),
  ]);

  it("leave = first departure − buffer − walk", () => {
    const out = deriveItineraryDisplay(trip, { referenceNowMs: ms("2026-09-25T17:32:00Z"), bufferSeconds: 180 });
    expect(out.recommendedDepartureMs).toBe(ms("2026-09-25T17:34:00Z"));
    expect(out.leadingWaitSeconds).toBe(2 * 60);
    expect(out.bufferSeconds).toBe(180);
    expect(out.bufferClamped).toBe(false);
  });

  it("clamps the buffer to the slack left after walking, not before", () => {
    // 17:36: 4 min to walk, 5 min to the bus → 1 min left for the buffer.
    const out = deriveItineraryDisplay(trip, { referenceNowMs: ms("2026-09-25T17:36:00Z"), bufferSeconds: 180 });
    expect(out.bufferSeconds).toBe(60);
    expect(out.bufferClamped).toBe(true);
    expect(out.recommendedDepartureMs).toBe(ms("2026-09-25T17:36:00Z"));
    expect(out.leadingWaitSeconds).toBe(0);
  });

  it("says leave now, not a past time, once the walk no longer fits", () => {
    const out = deriveItineraryDisplay(trip, { referenceNowMs: ms("2026-09-25T17:39:00Z"), bufferSeconds: 180 });
    expect(out.alreadyDeparted).toBe(false);
    expect(out.bufferSeconds).toBe(0);
    expect(out.recommendedDepartureMs).toBe(ms("2026-09-25T17:39:00Z"));
    expect(out.leadingWaitSeconds).toBe(0);
    expect(out.segments.find((s) => s.kind === "buffer-wait")).toBeUndefined();
  });

  it("still subtracts the walk with the buffer turned off", () => {
    const out = deriveItineraryDisplay(trip, { referenceNowMs: ms("2026-09-25T17:32:00Z"), bufferSeconds: 0 });
    expect(out.recommendedDepartureMs).toBe(ms("2026-09-25T17:37:00Z"));
    expect(out.leadingWaitSeconds).toBe(0);
  });

  it("re-times the walk row to start at the leave time and end at the buffer", () => {
    const out = deriveItineraryDisplay(trip, { referenceNowMs: ms("2026-09-25T17:32:00Z"), bufferSeconds: 180 });
    expect(out.legs[0].departureTime).toBe("2026-09-25T17:34:00.000Z");
    expect(out.legs[0].arrivalTime).toBe("2026-09-25T17:38:00.000Z");
    expect(out.legs[0].durationSeconds).toBe(240);
    // The ride keeps its engine times — only the walk moves.
    expect(out.legs[1]).toBe(trip.legs[1]);
  });

  it("walks from now when the walk no longer fits", () => {
    const out = deriveItineraryDisplay(trip, { referenceNowMs: ms("2026-09-25T17:39:00Z"), bufferSeconds: 180 });
    expect(out.legs[0].departureTime).toBe("2026-09-25T17:39:00.000Z");
    expect(out.legs[0].arrivalTime).toBe("2026-09-25T17:43:00.000Z");
  });

  it("keeps engine times once the first ride has departed", () => {
    const out = deriveItineraryDisplay(trip, { referenceNowMs: ms("2026-09-25T17:45:00Z"), bufferSeconds: 180 });
    expect(out.legs).toBe(trip.legs);
  });

  it("fails soft when the walk's duration is unusable", () => {
    const broken = itinerary([{ ...trip.legs[0], durationSeconds: NaN }, trip.legs[1]]);
    const out = deriveItineraryDisplay(broken, { referenceNowMs: ms("2026-09-25T17:32:00Z"), bufferSeconds: 180 });
    expect(out.parseFailed).toBe(true);
    expect(out.bufferSeconds).toBe(0);
    expect(out.leadingWaitSeconds).toBe(0);
  });
});

describe("deriveItineraryDisplay — clamping cases", () => {
  const Home = place("Home"),
    Stop = place("Stop A", 0, 0, "S1"),
    Dest = place("Office");
  function setup(opts: { walkDepart: string; walkArrive: string; rideDepart: string; rideArrive: string }) {
    return itinerary([
      walk({ from: Home, to: Stop, depart: opts.walkDepart, arrive: opts.walkArrive }),
      ride({ from: Stop, to: Dest, depart: opts.rideDepart, arrive: opts.rideArrive, routeShortName: "42" }),
    ]);
  }

  it("exact-fit: referenceNow == firstTransitDep − walk − bufferSeconds → full buffer, leadingWait=0", () => {
    const it = setup({
      walkDepart: "2026-04-25T10:25:00Z",
      walkArrive: "2026-04-25T10:30:00Z",
      rideDepart: "2026-04-25T10:30:00Z",
      rideArrive: "2026-04-25T10:54:00Z",
    });
    const out = deriveItineraryDisplay(it, { referenceNowMs: ms("2026-04-25T10:22:00Z"), bufferSeconds: 180 });
    expect(out.bufferSeconds).toBe(180);
    expect(out.bufferClamped).toBe(false);
    expect(out.leadingWaitSeconds).toBe(0);
  });

  it("tight slack ≥ 60s: shrinks buffer; bufferClamped=true; segment still emitted", () => {
    const it = setup({
      walkDepart: "2026-04-25T10:25:00Z",
      walkArrive: "2026-04-25T10:30:00Z",
      rideDepart: "2026-04-25T10:30:00Z",
      rideArrive: "2026-04-25T10:54:00Z",
    });
    // referenceNow at 10:23:30 + 5 min walk → slack = 90s, requested 180s → applied 90s
    const out = deriveItineraryDisplay(it, { referenceNowMs: ms("2026-04-25T10:23:30Z"), bufferSeconds: 180 });
    expect(out.bufferSeconds).toBe(90);
    expect(out.bufferClamped).toBe(true);
    expect(out.leadingWaitSeconds).toBe(0);
    expect(out.segments.find((s) => s.kind === "buffer-wait")).toEqual({
      kind: "buffer-wait",
      seconds: 90,
      atStopName: "Stop A",
    });
  });

  it("sub-minute slack: applied buffer < 60s → no BufferWaitSegment but bufferSeconds preserved", () => {
    const it = setup({
      walkDepart: "2026-04-25T10:25:00Z",
      walkArrive: "2026-04-25T10:30:00Z",
      rideDepart: "2026-04-25T10:30:00Z",
      rideArrive: "2026-04-25T10:54:00Z",
    });
    // referenceNow at 10:24:45 + 5 min walk → slack = 15s
    const out = deriveItineraryDisplay(it, { referenceNowMs: ms("2026-04-25T10:24:45Z"), bufferSeconds: 180 });
    expect(out.bufferSeconds).toBe(15);
    expect(out.bufferClamped).toBe(true);
    expect(out.segments.find((s) => s.kind === "buffer-wait")).toBeUndefined();
  });
});

describe("deriveItineraryDisplay — past departure", () => {
  it("sets alreadyDeparted when firstTransitDep ≤ referenceNow; segments unchanged; no buffer", () => {
    const Home = place("Home"),
      Stop = place("Stop A"),
      Dest = place("Office");
    const it = itinerary([
      walk({ from: Home, to: Stop, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({ from: Stop, to: Dest, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "42" }),
    ]);
    const out = deriveItineraryDisplay(it, { referenceNowMs: ms("2026-04-25T10:35:00Z"), bufferSeconds: 180 });
    expect(out.alreadyDeparted).toBe(true);
    expect(out.parseFailed).toBe(false);
    expect(out.bufferSeconds).toBe(0);
    expect(out.leadingWaitSeconds).toBe(0);
    expect(out.segments).toEqual(toSegments(it));
  });

  it("alreadyDeparted=true at exact equality (firstTransitDep === referenceNow)", () => {
    const Home = place("Home"),
      Stop = place("Stop A"),
      Dest = place("Office");
    const it = itinerary([
      walk({ from: Home, to: Stop, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({ from: Stop, to: Dest, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "42" }),
    ]);
    const out = deriveItineraryDisplay(it, { referenceNowMs: ms("2026-04-25T10:30:00Z"), bufferSeconds: 180 });
    expect(out.alreadyDeparted).toBe(true);
  });
});

describe("deriveItineraryDisplay — malformed ISO", () => {
  it("sets parseFailed when first transit leg's departureTime is unparseable", () => {
    const Home = place("Home"),
      Stop = place("Stop A"),
      Dest = place("Office");
    const badLeg: Leg = {
      mode: "BUS",
      from: Stop,
      to: Dest,
      departureTime: "not-a-date",
      arrivalTime: "2026-04-25T10:54:00Z",
      durationSeconds: 1440,
      routeShortName: "42",
    };
    const it: Itinerary = {
      legs: [walk({ from: Home, to: Stop, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }), badLeg],
      departureTime: "2026-04-25T10:25:00Z",
      arrivalTime: "2026-04-25T10:54:00Z",
      durationSeconds: 1740,
      transfers: 0,
      walkingDistanceMeters: 0,
    };
    const out = deriveItineraryDisplay(it, { referenceNowMs: ms("2026-04-25T10:00:00Z"), bufferSeconds: 180 });
    expect(out.parseFailed).toBe(true);
    expect(out.alreadyDeparted).toBe(false);
    expect(out.bufferSeconds).toBe(0);
    expect(out.leadingWaitSeconds).toBe(0);
  });
});

describe("deriveItineraryDisplay — bufferSeconds=0 (caller disabled)", () => {
  it("returns no segment, bufferSeconds=0, leadingWaitSeconds=0 (NOT raw gap)", () => {
    const Home = place("Home"),
      Stop = place("Stop A"),
      Dest = place("Office");
    const it = itinerary([
      walk({ from: Home, to: Stop, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({ from: Stop, to: Dest, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "42" }),
    ]);
    // referenceNow 30 min before bus, but caller passed bufferSeconds=0
    const out = deriveItineraryDisplay(it, { referenceNowMs: ms("2026-04-25T10:00:00Z"), bufferSeconds: 0 });
    expect(out.bufferSeconds).toBe(0);
    expect(out.leadingWaitSeconds).toBe(0);
    expect(out.bufferClamped).toBe(false);
    expect(out.segments.find((s) => s.kind === "buffer-wait")).toBeUndefined();
    expect(out.recommendedDepartureMs).toBe(ms("2026-04-25T10:25:00Z")); // 10:30 − 5 min walk
  });
});

describe("deriveItineraryDisplay — ride-first (no leading walk)", () => {
  it("prepends BufferWaitSegment before legs[0] using its from.name", () => {
    const Stop = place("Boarding Stop", 0, 0, "S1"),
      Dest = place("Destination");
    const it = itinerary([
      ride({ from: Stop, to: Dest, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "42" }),
    ]);
    const out = deriveItineraryDisplay(it, { referenceNowMs: ms("2026-04-25T10:00:00Z"), bufferSeconds: 180 });
    expect(out.bufferSeconds).toBe(180);
    expect(out.recommendedDepartureMs).toBe(ms("2026-04-25T10:27:00Z"));
    expect(out.segments[0]).toEqual({ kind: "buffer-wait", seconds: 180, atStopName: "Boarding Stop" });
    expect(out.segments[1].kind).toBe("ride");
    expect(out.segments).toHaveLength(2);
  });
});

describe("deriveItineraryDisplay — multi-transit + transferRisk regression", () => {
  it("only the first ride gets a BufferWaitSegment; mid-trip WaitSegment unchanged; transferRisk identical", () => {
    const Home = place("Home"),
      S1 = place("Stop A"),
      S2 = place("Stop B"),
      Dest = place("Office");
    const it = itinerary([
      walk({ from: Home, to: S1, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({ from: S1, to: S2, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:40:00Z", routeShortName: "42" }),
      ride({ from: S2, to: Dest, depart: "2026-04-25T10:42:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "7" }),
    ]);
    const out = deriveItineraryDisplay(it, { referenceNowMs: ms("2026-04-25T10:00:00Z"), bufferSeconds: 180 });

    const bufferSegs = out.segments.filter((s) => s.kind === "buffer-wait");
    expect(bufferSegs).toHaveLength(1);
    expect((bufferSegs[0] as { atStopName: string }).atStopName).toBe("Stop A");

    const transferWaits = out.segments.filter((s) => s.kind === "wait");
    expect(transferWaits).toHaveLength(1); // 2-min wait between rides

    // BufferWaitSegment must be invisible to transferRisk: passing the spliced
    // display segments must yield the same risk classification as the raw
    // itinerary. Locks the "buffer-wait is filtered out by kind" invariant
    // at the integration level (the unit-level overload tests live in
    // legHelpers.test.ts).
    expect(transferRisk(out.segments)).toBe(transferRisk(it));
  });
});

describe("deriveItineraryDisplay — RT delay re-derivation contract", () => {
  it("shifting referenceNowMs forward simulates RT delay; leadingWait shrinks then alreadyDeparted flips", () => {
    const Home = place("Home"),
      Stop = place("Stop A"),
      Dest = place("Office");
    const it = itinerary([
      walk({ from: Home, to: Stop, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({ from: Stop, to: Dest, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "42" }),
    ]);
    const initial = deriveItineraryDisplay(it, { referenceNowMs: ms("2026-04-25T10:00:00Z"), bufferSeconds: 180 });
    const later = deriveItineraryDisplay(it, { referenceNowMs: ms("2026-04-25T10:20:00Z"), bufferSeconds: 180 });
    const past = deriveItineraryDisplay(it, { referenceNowMs: ms("2026-04-25T10:35:00Z"), bufferSeconds: 180 });

    expect(later.leadingWaitSeconds).toBeLessThan(initial.leadingWaitSeconds);
    expect(past.alreadyDeparted).toBe(true);
    expect(past.leadingWaitSeconds).toBe(0);
  });
});

describe("deriveItineraryDisplay — catch status", () => {
  // 4-min walk (8 min for a run-to-catch leg read at walking pace), bus 17:41.
  const Home = place("Home"),
    Stop = place("Oro uostas", 0, 0, "S1"),
    Dest = place("Airport");
  const bus = ride({ from: Stop, to: Dest, depart: "2026-09-25T17:41:00Z", arrive: "2026-09-25T18:21:00Z", routeShortName: "3G" });
  const walkTrip = itinerary([
    walk({ from: Home, to: Stop, depart: "2026-09-25T17:32:00Z", arrive: "2026-09-25T17:36:00Z" }),
    bus,
  ]);
  // The planner reached this stop only at a run: 4 min running = 8 min walking.
  const runTrip = itinerary([
    { ...walk({ from: Home, to: Stop, depart: "2026-09-25T17:32:00Z", arrive: "2026-09-25T17:36:00Z" }), runToCatch: true },
    bus,
  ]);
  const at = (iso: string, extra: { bufferSeconds?: number; runSpeedRatio?: number } = {}) => ({
    referenceNowMs: ms(iso),
    bufferSeconds: extra.bufferSeconds ?? 180,
    ...(extra.runSpeedRatio !== undefined ? { runSpeedRatio: extra.runSpeedRatio } : {}),
  });

  it("on-time while a minute or more is left at the stop after walking", () => {
    expect(deriveItineraryDisplay(walkTrip, at("2026-09-25T17:32:00Z")).catchStatus).toBe("on-time");
    expect(deriveItineraryDisplay(walkTrip, at("2026-09-25T17:36:00Z")).catchStatus).toBe("on-time");
  });

  it("tight when walking gets there with under a minute to spare", () => {
    const out = deriveItineraryDisplay(walkTrip, at("2026-09-25T17:36:30Z"));
    expect(out.catchStatus).toBe("tight");
    expect(out.recommendedDepartureMs).toBe(ms("2026-09-25T17:36:30Z"));
  });

  it("tight is reported with the buffer turned off, too", () => {
    const out = deriveItineraryDisplay(walkTrip, at("2026-09-25T17:36:30Z", { bufferSeconds: 0 }));
    expect(out.catchStatus).toBe("tight");
    expect(out.bufferSeconds).toBe(0);
  });

  it("hurry when only a run still makes it (run-to-catch on)", () => {
    // 17:38: 4 min walking lands at 17:42, 2 min running at 17:40.
    const out = deriveItineraryDisplay(walkTrip, at("2026-09-25T17:38:00Z", { runSpeedRatio: 2 }));
    expect(out.catchStatus).toBe("hurry");
    expect(out.recommendedDepartureMs).toBe(ms("2026-09-25T17:38:00Z"));
    expect(out.bufferSeconds).toBe(0);
    expect(out.segments.find((s) => s.kind === "buffer-wait")).toBeUndefined();
    // The walk row is the run: 17:38–17:40.
    expect(out.legs[0].arrivalTime).toBe("2026-09-25T17:40:00.000Z");
  });

  it("likely-miss when walking no longer fits and run-to-catch is off", () => {
    const out = deriveItineraryDisplay(walkTrip, at("2026-09-25T17:38:00Z"));
    expect(out.catchStatus).toBe("likely-miss");
    expect(out.bufferSeconds).toBe(0);
  });

  it("likely-miss when not even a run fits", () => {
    const out = deriveItineraryDisplay(walkTrip, at("2026-09-25T17:40:00Z", { runSpeedRatio: 2 }));
    expect(out.catchStatus).toBe("likely-miss");
  });

  it("departed once the first ride has left", () => {
    expect(deriveItineraryDisplay(walkTrip, at("2026-09-25T17:41:00Z")).catchStatus).toBe("departed");
  });

  it("no status without a ride to catch", () => {
    const walkOnly = itinerary([walk({ from: Home, to: Dest, depart: "2026-09-25T17:32:00Z", arrive: "2026-09-25T17:40:00Z" })]);
    expect(deriveItineraryDisplay(walkOnly, at("2026-09-25T17:32:00Z")).catchStatus).toBeNull();
  });

  it("a run-to-catch leg with time to spare is walked: leave earlier, walk row at walking pace", () => {
    // Walking it takes 8 min: 17:41 − 3 min buffer − 8 min walk = leave 17:30.
    const out = deriveItineraryDisplay(runTrip, at("2026-09-25T17:28:00Z", { runSpeedRatio: 2 }));
    expect(out.catchStatus).toBe("on-time");
    expect(out.recommendedDepartureMs).toBe(ms("2026-09-25T17:30:00Z"));
    expect(out.legs[0].departureTime).toBe("2026-09-25T17:30:00.000Z");
    expect(out.legs[0].arrivalTime).toBe("2026-09-25T17:38:00.000Z");
    expect(out.legs[0].durationSeconds).toBe(480);
    expect(out.legs[0].runToCatch).toBeUndefined();
  });

  it("a run-to-catch leg that only fits at a run is a hurry", () => {
    // 17:34: walking (8 min) lands 17:42, after the bus; running (4 min) 17:38.
    const out = deriveItineraryDisplay(runTrip, at("2026-09-25T17:34:00Z", { runSpeedRatio: 2 }));
    expect(out.catchStatus).toBe("hurry");
    expect(out.legs[0].durationSeconds).toBe(240);
    expect(out.legs[0].runToCatch).toBe(true);
  });

  it("without a run ratio, a run-to-catch leg is read at face value", () => {
    const out = deriveItineraryDisplay(runTrip, at("2026-09-25T17:32:00Z"));
    expect(out.catchStatus).toBe("on-time");
    expect(out.recommendedDepartureMs).toBe(ms("2026-09-25T17:34:00Z"));
  });
});

describe("deriveItineraryDisplay — guidance: the rider is on the way", () => {
  // 4-min walk to a 17:41 bus.
  const Home = place("Home"),
    Stop = place("Oro uostas", 0, 0, "S1"),
    Dest = place("Airport");
  const trip = itinerary([
    walk({ from: Home, to: Stop, depart: "2026-09-25T17:32:00Z", arrive: "2026-09-25T17:36:00Z" }),
    ride({ from: Stop, to: Dest, depart: "2026-09-25T17:41:00Z", arrive: "2026-09-25T18:21:00Z", routeShortName: "3G" }),
  ]);

  it("counts only the walk still ahead: half-way at 17:38 is on time, not a miss", () => {
    const out = deriveItineraryDisplay(trip, {
      referenceNowMs: ms("2026-09-25T17:38:00Z"),
      bufferSeconds: 180,
      underway: { legIndex: 0, remainingFraction: 0.5 },
    });
    expect(out.catchStatus).toBe("on-time");
    // 2 min still to walk, 1 min left over at the stop.
    expect(out.bufferSeconds).toBe(60);
    // The walk row ends when the rider reaches the stop: 17:40.
    expect(out.legs[0].arrivalTime).toBe("2026-09-25T17:40:00.000Z");
    expect(out.legs[0].departureTime).toBe("2026-09-25T17:36:00.000Z");
  });

  it("waits at the stop once the walk is behind them", () => {
    const out = deriveItineraryDisplay(trip, {
      referenceNowMs: ms("2026-09-25T17:40:30Z"),
      bufferSeconds: 180,
      underway: { legIndex: 1, remainingFraction: 1 },
    });
    // 30 s to the bus with nothing left to walk.
    expect(out.catchStatus).toBe("tight");
    expect(out.legs[0].arrivalTime).toBe("2026-09-25T17:40:30.000Z");
  });

  it("an unmoved rider at the start of the walk is the plan", () => {
    const planned = deriveItineraryDisplay(trip, { referenceNowMs: ms("2026-09-25T17:32:00Z"), bufferSeconds: 180 });
    const underway = deriveItineraryDisplay(trip, {
      referenceNowMs: ms("2026-09-25T17:32:00Z"),
      bufferSeconds: 180,
      underway: { legIndex: 0, remainingFraction: 1 },
    });
    expect(underway.recommendedDepartureMs).toBe(planned.recommendedDepartureMs);
    expect(underway.legs[0]).toEqual(planned.legs[0]);
  });
});

describe("deriveItineraryDisplay — live RT correction of the first departure", () => {
  const Home = place("Home"),
    Stop = place("Oro uostas", 0, 0, "S1"),
    Dest = place("Airport");
  const trip = itinerary([
    walk({ from: Home, to: Stop, depart: "2026-09-25T17:30:00Z", arrive: "2026-09-25T17:34:00Z" }),
    ride({ from: Stop, to: Dest, depart: "2026-09-25T17:41:00Z", arrive: "2026-09-25T18:21:00Z", routeShortName: "3G" }),
  ]);

  it("a bus running 2 min early moves the leave time 2 min earlier", () => {
    const out = deriveItineraryDisplay(trip, {
      referenceNowMs: ms("2026-09-25T17:30:00Z"),
      bufferSeconds: 180,
      firstDepartureShiftSeconds: -120,
    });
    expect(out.firstTransitDepartureMs).toBe(ms("2026-09-25T17:39:00Z"));
    expect(out.recommendedDepartureMs).toBe(ms("2026-09-25T17:32:00Z"));
  });

  it("a bus running 5 min late buys 5 min at home", () => {
    const out = deriveItineraryDisplay(trip, {
      referenceNowMs: ms("2026-09-25T17:30:00Z"),
      bufferSeconds: 180,
      firstDepartureShiftSeconds: 300,
    });
    expect(out.recommendedDepartureMs).toBe(ms("2026-09-25T17:39:00Z"));
  });

  it("an early bus can turn a comfortable catch into a hurry", () => {
    // 17:35 with a 4-min walk: fine for 17:41, a run for 17:38.
    const out = deriveItineraryDisplay(trip, {
      referenceNowMs: ms("2026-09-25T17:35:00Z"),
      bufferSeconds: 180,
      runSpeedRatio: 2,
      firstDepartureShiftSeconds: -180,
    });
    expect(out.catchStatus).toBe("hurry");
  });
});

describe("shownTripSpan — what a header says about the trip", () => {
  const Home = place("Home"),
    Stop = place("Oro uostas", 0, 0, "S1"),
    Mid = place("Mid", 0, 0, "S2"),
    Dest = place("Airport");
  const walkToBus = itinerary([
    walk({ from: Home, to: Stop, depart: "2026-09-25T17:32:00Z", arrive: "2026-09-25T17:36:00Z" }),
    ride({ from: Stop, to: Dest, depart: "2026-09-25T17:41:00Z", arrive: "2026-09-25T18:21:00Z", routeShortName: "3G" }),
  ]);

  it("starts when the rider sets off, not when the planner started counting", () => {
    const d = deriveItineraryDisplay(walkToBus, { referenceNowMs: ms("2026-09-25T17:32:00Z"), bufferSeconds: 180 });
    expect(shownTripSpan(walkToBus, d)).toEqual({
      departureTime: "2026-09-25T17:34:00.000Z",
      arrivalTime: "2026-09-25T18:21:00Z",
      durationSeconds: 47 * 60,
    });
  });

  it("a trip that starts on the bus starts when the bus leaves", () => {
    const rideFirst = { ...itinerary([ride({ from: Stop, to: Dest, depart: "2026-09-25T23:03:00Z", arrive: "2026-09-25T23:29:00Z" })]), departureTime: "2026-09-25T21:39:00Z" };
    const d = deriveItineraryDisplay(rideFirst, { referenceNowMs: ms("2026-09-25T21:39:00Z"), bufferSeconds: 180 });
    expect(shownTripSpan(rideFirst, d).departureTime).toBe("2026-09-25T23:03:00Z");
    expect(shownTripSpan(rideFirst, d).durationSeconds).toBe(26 * 60);
  });

  it("a single-ride trip arrives as early as live data moves the ride", () => {
    const d = deriveItineraryDisplay(walkToBus, {
      referenceNowMs: ms("2026-09-25T17:30:00Z"),
      bufferSeconds: 180,
      firstDepartureShiftSeconds: -120,
    });
    expect(shownTripSpan(walkToBus, d).arrivalTime).toBe("2026-09-25T18:19:00.000Z");
  });

  it("with a transfer, the timetable still decides the arrival", () => {
    const twoRides = itinerary([
      walk({ from: Home, to: Stop, depart: "2026-09-25T17:32:00Z", arrive: "2026-09-25T17:36:00Z" }),
      ride({ from: Stop, to: Mid, depart: "2026-09-25T17:41:00Z", arrive: "2026-09-25T17:55:00Z" }),
      ride({ from: Mid, to: Dest, depart: "2026-09-25T18:00:00Z", arrive: "2026-09-25T18:21:00Z" }),
    ]);
    const d = deriveItineraryDisplay(twoRides, {
      referenceNowMs: ms("2026-09-25T17:30:00Z"),
      bufferSeconds: 180,
      firstDepartureShiftSeconds: -120,
    });
    expect(shownTripSpan(twoRides, d).arrivalTime).toBe("2026-09-25T18:21:00Z");
  });

  it("keeps the itinerary's own times once the bus has gone", () => {
    const d = deriveItineraryDisplay(walkToBus, { referenceNowMs: ms("2026-09-25T17:45:00Z"), bufferSeconds: 180 });
    expect(shownTripSpan(walkToBus, d)).toEqual({
      departureTime: walkToBus.departureTime,
      arrivalTime: walkToBus.arrivalTime,
      durationSeconds: walkToBus.durationSeconds,
    });
  });
});

describe("deriveItineraryDisplay — the first ride is cancelled", () => {
  const Home = place("Home"),
    Stop = place("Oro uostas", 0, 0, "S1"),
    Dest = place("Airport");
  const trip = itinerary([
    walk({ from: Home, to: Stop, depart: "2026-09-25T17:32:00Z", arrive: "2026-09-25T17:36:00Z" }),
    ride({ from: Stop, to: Dest, depart: "2026-09-25T17:41:00Z", arrive: "2026-09-25T18:21:00Z", routeShortName: "3G" }),
  ]);

  it("says so instead of a leave time, whatever the walk", () => {
    const out = deriveItineraryDisplay(trip, {
      referenceNowMs: ms("2026-09-25T17:32:00Z"),
      bufferSeconds: 180,
      firstRideCancelled: true,
    });
    expect(out.catchStatus).toBe("cancelled");
    expect(out.bufferSeconds).toBe(0);
    expect(out.leadingWaitSeconds).toBe(0);
    expect(out.alreadyDeparted).toBe(false);
    // Nothing to re-time a walk to: the rows keep the plan.
    expect(out.legs).toBe(trip.legs);
    expect(out.segments.find((s) => s.kind === "buffer-wait")).toBeUndefined();
    // Kept so the next departure can be looked up from it.
    expect(out.firstTransitDepartureMs).toBe(ms("2026-09-25T17:41:00Z"));
  });

  it("stays cancelled after its time — it never left", () => {
    const out = deriveItineraryDisplay(trip, {
      referenceNowMs: ms("2026-09-25T17:45:00Z"),
      bufferSeconds: 180,
      firstRideCancelled: true,
    });
    expect(out.catchStatus).toBe("cancelled");
    expect(out.alreadyDeparted).toBe(false);
  });

  it("the header keeps the plan's own times", () => {
    const d = deriveItineraryDisplay(trip, {
      referenceNowMs: ms("2026-09-25T17:32:00Z"),
      bufferSeconds: 180,
      firstRideCancelled: true,
    });
    expect(shownTripSpan(trip, d).departureTime).toBe(trip.departureTime);
  });
});

describe("deriveItineraryDisplay — the first ride is removed (DELETED)", () => {
  const trip = itinerary([
    walk({ from: place("Home"), to: place("Stop", 0, 0, "S1"), depart: "2026-09-25T17:32:00Z", arrive: "2026-09-25T17:36:00Z" }),
    ride({ from: place("Stop", 0, 0, "S1"), to: place("Airport"), depart: "2026-09-25T17:41:00Z", arrive: "2026-09-25T18:21:00Z", routeShortName: "3G" }),
  ]);

  it("says so — neither a leave time nor 'cancelled'", () => {
    const out = deriveItineraryDisplay(trip, {
      referenceNowMs: ms("2026-09-25T17:32:00Z"),
      bufferSeconds: 180,
      firstRideRemoved: true,
    });
    expect(out.catchStatus).toBe("removed");
    expect(out.bufferSeconds).toBe(0);
    expect(out.leadingWaitSeconds).toBe(0);
    expect(out.legs).toBe(trip.legs);
    expect(out.firstTransitDepartureMs).toBe(ms("2026-09-25T17:41:00Z"));
    expect(shownTripSpan(trip, out).departureTime).toBe(trip.departureTime);
  });
});
