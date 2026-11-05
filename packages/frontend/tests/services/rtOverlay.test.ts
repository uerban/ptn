import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { applyRtOverlay } from "../../src/services/rtOverlay.ts";
import type { ComposedItinerary } from "@pt/shared";

/**
 * Builds a two-transit-leg itinerary chaining tripA → tripB. The leg times
 * are realistic for a same-stop transfer with a 3-min buffer: tripA alights
 * at 05:34, tripB departs at 05:37.
 */
function twoLegItinerary(): ComposedItinerary {
  return {
    sourceWalkSecs: 0,
    destWalkSecs: 180,
    departureSecs: 5 * 3600, // 05:00
    arrivalSecs: 5 * 3600 + 60 * 60, // 06:00 (set by tripB.arrive 05:57 + 180 walk)
    totalSecs: 3600,
    transfers: 1,
    totalWalkSecs: 180,
    legs: [
      {
        type: "transit",
        fromStopId: "A",
        toStopId: "B",
        departSecs: 5 * 3600 + 8 * 60, // 05:08
        arriveSecs: 5 * 3600 + 34 * 60, // 05:34
        routeId: "3G",
        tripId: "tripA",
        boardStopIdx: 0,
        alightStopIdx: 5,
      },
      {
        type: "transit",
        fromStopId: "B",
        toStopId: "C",
        departSecs: 5 * 3600 + 37 * 60, // 05:37 (3-min buffer over tripA arrive)
        arriveSecs: 5 * 3600 + 57 * 60, // 05:57
        routeId: "1",
        tripId: "tripB",
        boardStopIdx: 0,
        alightStopIdx: 4,
      },
    ],
  };
}

describe("applyRtOverlay — consistency under RT delay", () => {
  it("passes an itinerary through unchanged when no trip has a delay", () => {
    const itins = [twoLegItinerary()];
    const [result] = applyRtOverlay(itins, () => null);

    expect(result.cancelled).toBeUndefined();
    expect(result.legs[0].departSecs).toBe(5 * 3600 + 8 * 60);
    expect(result.legs[1].departSecs).toBe(5 * 3600 + 37 * 60);
    expect(result.arrivalSecs).toBe(5 * 3600 + 60 * 60);
  });

  it("shifts each leg by its own delay when connections remain viable", () => {
    const itins = [twoLegItinerary()];
    // tripA runs 60s late — transfer buffer shrinks to 2 min but survives.
    const [result] = applyRtOverlay(itins, (tripId) =>
      tripId === "tripA" ? { delaySeconds: 60, cancelled: false } : null,
    );

    expect(result.cancelled).toBeUndefined();
    expect(result.legs[0].arriveSecs).toBe(5 * 3600 + 34 * 60 + 60);
    expect(result.legs[1].departSecs).toBe(5 * 3600 + 37 * 60);
    // Arrival recomputes off the *last* leg — tripB was not delayed, so this
    // stays put. The transfer is tight but not missed.
  });

  it("tests the connection against the rider's minimum transfer", () => {
    // tripA 60 s late leaves a 120 s connection: kept at a 120 s minimum,
    // broken at 180 s.
    const late = (tripId: string) => (tripId === "tripA" ? { delaySeconds: 60, cancelled: false } : null);
    expect(applyRtOverlay([twoLegItinerary()], late, 120)[0].timingUnreliable).toBeUndefined();
    expect(applyRtOverlay([twoLegItinerary()], late, 180)[0].timingUnreliable).toBe(true);
  });

  it("records on each shifted leg the delay folded into its times", () => {
    const [result] = applyRtOverlay([twoLegItinerary()], (tripId) =>
      tripId === "tripA" ? { delaySeconds: 60, cancelled: false } : null,
    );
    const [a, b] = result.legs;
    expect(a.type === "transit" && a.appliedDelaySeconds).toBe(60);
    // No RT for tripB: nothing folded in.
    expect(b.type === "transit" && b.appliedDelaySeconds).toBeUndefined();
  });

  it("drops an itinerary that rides a deleted trip — it is never offered", () => {
    const keep = twoLegItinerary();
    const drop = twoLegItinerary();
    const out = applyRtOverlay([drop, keep], (tripId) =>
      tripId === "tripB" ? { delaySeconds: 0, cancelled: false, deleted: true } : null,
    );
    // Both itineraries ride tripB here, so both go.
    expect(out).toHaveLength(0);
    const other = applyRtOverlay([keep], (tripId) =>
      tripId === "someone-else" ? { delaySeconds: 0, cancelled: false, deleted: true } : null,
    );
    expect(other).toHaveLength(1);
  });

  it("marks a delay-broken chain timingUnreliable, NOT cancelled, and reverts to scheduled times", () => {
    const itins = [twoLegItinerary()];
    // tripA 2h late — tripA's post-shift arrive (07:34) is well past tripB's
    // scheduled board (05:37). The transfer is physically impossible. Rather
    // than emit chronologically inconsistent legs (3G at 07:08–07:34 between
    // a 05:37 bus and a 06:00 walk, as happened in the Oro-uostas screenshot),
    // the overlay preserves every leg's scheduled time and surfaces the
    // unviability via `timingUnreliable`.
    const [result] = applyRtOverlay(itins, (tripId) =>
      tripId === "tripA" ? { delaySeconds: 7200, cancelled: false } : null,
    );

    expect(result.timingUnreliable).toBe(true);
    // Nothing was cancelled — the operator still plans to run both trips.
    // Conflating the two is what made the banner unable to say which.
    expect(result.cancelled).toBeUndefined();
    // Legs show scheduled times — consistent and chainable, even though the
    // itinerary as a whole has been invalidated by the RT feed.
    expect(result.legs[0].departSecs).toBe(5 * 3600 + 8 * 60);
    expect(result.legs[0].arriveSecs).toBe(5 * 3600 + 34 * 60);
    expect(result.legs[1].departSecs).toBe(5 * 3600 + 37 * 60);
    expect(result.legs[1].arriveSecs).toBe(5 * 3600 + 57 * 60);
    // Arrival stays at the scheduled value rather than drifting.
    expect(result.arrivalSecs).toBe(5 * 3600 + 60 * 60);
    // Scheduled times carry no folded-in delay.
    expect(result.legs.every((l) => l.type !== "transit" || l.appliedDelaySeconds === undefined)).toBe(true);
  });

  it("detects broken chains beyond the immediately-delayed hop", () => {
    // Three-leg case. A delay on the middle leg must still propagate
    // detection through to the next transfer.
    const base = twoLegItinerary();
    const threeLeg: ComposedItinerary = {
      ...base,
      transfers: 2,
      legs: [
        base.legs[0],
        base.legs[1],
        {
          type: "transit",
          fromStopId: "C",
          toStopId: "D",
          departSecs: 5 * 3600 + 60 * 60, // 06:00
          arriveSecs: 5 * 3600 + 70 * 60, // 06:10
          routeId: "X",
          tripId: "tripC",
          boardStopIdx: 0,
          alightStopIdx: 2,
        },
      ],
    };

    const [result] = applyRtOverlay([threeLeg], (tripId) =>
      tripId === "tripB" ? { delaySeconds: 600, cancelled: false } : null,
    );

    // tripB would alight 05:57 + 600 = 06:07, past tripC board 06:00 +
    // MIN_TRANSFER. The overlay reverts rather than letting the user see a
    // tripB pushed into the future past tripC, and flags the chain as
    // unreliable — no trip here was cancelled.
    expect(result.timingUnreliable).toBe(true);
    expect(result.cancelled).toBeUndefined();
    expect(result.legs[1].arriveSecs).toBe(5 * 3600 + 57 * 60);
  });

  it("preserves the existing cancelled flag from a cancelled trip update", () => {
    // Regression guard: the "cancelled" channel must still fire when a
    // trip_update sets cancelled=true, independently of delay-driven
    // inconsistency.
    const itins = [twoLegItinerary()];
    const [result] = applyRtOverlay(itins, (tripId) =>
      tripId === "tripA" ? { delaySeconds: 0, cancelled: true } : null,
    );

    expect(result.cancelled).toBe(true);
    // A zero-delay cancellation breaks no transfer, so the other channel
    // stays quiet.
    expect(result.timingUnreliable).toBeUndefined();
  });

  it("raises both channels when a cancelled trip is also late enough to break the chain", () => {
    // The two signals are independent, not mutually exclusive — the UI
    // decides which to show, the overlay reports both truthfully.
    const itins = [twoLegItinerary()];
    const [result] = applyRtOverlay(itins, (tripId) =>
      tripId === "tripA" ? { delaySeconds: 7200, cancelled: true } : null,
    );

    expect(result.cancelled).toBe(true);
    expect(result.timingUnreliable).toBe(true);
  });
});

describe("rtOverlay 120s freshness guard", () => {
  const fixedNow = 1745625600000; // 2025-04-26T00:00:00Z, deterministic

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Single-leg itinerary fixture: leg with tripId T1, scheduled departSecs
  // 30000, arriveSecs 30600.
  const itineraries = [
    {
      legs: [
        {
          type: "transit" as const,
          tripId: "T1",
          departSecs: 30000,
          arriveSecs: 30600,
        },
      ],
      departureSecs: 30000,
      destWalkSecs: 0,
      arrivalSecs: 30600,
      totalSecs: 600,
    },
  ];

  function makeGetDelay(ageSecs: number) {
    const receivedAt = fixedNow - ageSecs * 1000;
    return (tripId: string) =>
      tripId === "T1"
        ? { delaySeconds: 60, cancelled: false, receivedAt }
        : null;
  }

  it("honors a 90 s old update (well within window)", () => {
    const out = applyRtOverlay(itineraries as never, makeGetDelay(90));
    expect(out[0].legs[0].departSecs).toBe(30060); // 30000 + 60
  });

  it("honors a 119 s old update (boundary, exclusive)", () => {
    const out = applyRtOverlay(itineraries as never, makeGetDelay(119));
    expect(out[0].legs[0].departSecs).toBe(30060);
  });

  it("rejects a 120 s old update (boundary, inclusive)", () => {
    const out = applyRtOverlay(itineraries as never, makeGetDelay(120));
    expect(out[0].legs[0].departSecs).toBe(30000); // scheduled, no shift
  });

  it("rejects a 130 s old update", () => {
    const out = applyRtOverlay(itineraries as never, makeGetDelay(130));
    expect(out[0].legs[0].departSecs).toBe(30000);
  });

  it("honors an update with undefined receivedAt (backwards-compat)", () => {
    // Missing receivedAt is treated as fresh. Some seeded data and any
    // forgotten writer site (or a future caller passing the legacy shape)
    // must not silently drop RT corrections.
    const getDelay = (tripId: string) =>
      tripId === "T1" ? { delaySeconds: 60, cancelled: false } : null;
    const out = applyRtOverlay(itineraries as never, getDelay);
    expect(out[0].legs[0].departSecs).toBe(30060);
  });
});
