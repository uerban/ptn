import type { Itinerary } from "@pt/shared";
import { describe, expect, it } from "vitest";
import { selectVerifiedLaterJourney } from "../../src/services/verifiedLaterJourney.ts";
import { makeMixedItinerary } from "../helpers/makeItinerary.ts";

const shift = (time: string, minutes: number) =>
  new Date(Date.parse(time) + minutes * 60_000).toISOString();

function journey(minutes: number, tripId: string): Itinerary {
  const original = makeMixedItinerary();
  const legs = original.legs.map((leg, index) => ({
    ...leg,
    departureTime: shift(leg.departureTime, minutes),
    arrivalTime: shift(leg.arrivalTime, minutes),
    ...(leg.mode !== "WALK" ? {
      tripId: index === 0 ? tripId : `${tripId}-onward`,
      boardStopIdx: 0,
      alightStopIdx: 1,
      patternStopIds: [leg.from.stopId!, leg.to.stopId!],
    } : {}),
  }));
  return { ...original, legs, departureTime: legs[0].departureTime, arrivalTime: legs.at(-1)!.arrivalTime };
}

describe("selectVerifiedLaterJourney", () => {
  const primary = journey(0, "missed");
  const viable = journey(8, "later");
  const constraints = { earliestLeaveMs: Date.parse(shift(primary.departureTime, 1)) };

  it("chooses the first viable later departure and preserves its full itinerary", () => {
    expect(selectVerifiedLaterJourney(primary, [primary, journey(15, "other"), viable], constraints)).toBe(viable);
  });

  it("skips a same-line branch that does not serve the planned stop occurrence", () => {
    const wrongBranch = journey(4, "branch");
    wrongBranch.legs[0].patternStopIds = ["s1", "branch-stop"];
    expect(selectVerifiedLaterJourney(primary, [wrongBranch, viable], constraints)).toBe(viable);
  });

  it("rejects a missed downstream connection and an arrival past the deadline", () => {
    const missedTransfer = journey(4, "missed-transfer");
    missedTransfer.legs[1].departureTime = shift(missedTransfer.legs[0].arrivalTime, -1);
    expect(selectVerifiedLaterJourney(primary, [missedTransfer, viable], {
      ...constraints, arriveByMs: Date.parse(shift(viable.arrivalTime, -1)),
    })).toBeNull();
    expect(selectVerifiedLaterJourney(primary, [viable], {
      ...constraints, arriveByMs: Date.parse(viable.arrivalTime),
    })).toBe(viable);
  });

  it("rejects the same trip, cancelled or unreliable plans, and plans that leave too early", () => {
    expect(selectVerifiedLaterJourney(primary, [
      journey(2, "missed"), { ...viable, cancelled: true }, { ...viable, timingUnreliable: true },
      journey(0.5, "too-early"),
    ], constraints)).toBeNull();
  });
});
