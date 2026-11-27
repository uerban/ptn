import type { Itinerary } from "@pt/shared";
import { describe, expect, it } from "vitest";
import { interchangeableRide, selectVerifiedDifferentJourneys, selectVerifiedLaterJourney } from "../../src/services/verifiedLaterJourney.ts";
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

  it("allows an initial wait at the boarding stop before the first leg", () => {
    const waiting = { ...viable, departureTime: shift(viable.departureTime, -8) };
    expect(selectVerifiedLaterJourney(primary, [waiting], constraints)).toBe(waiting);
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

describe("interchangeableRide", () => {
  const primary = journey(8, "first");
  const constraints = { earliestLeaveMs: Date.parse(primary.departureTime) - 60_000 };
  const withReplacement = () => {
    const candidate = journey(8, "other");
    candidate.legs[1] = { ...primary.legs[1] };
    candidate.legs[0].routeId = "r4";
    return candidate;
  };

  it("keeps the fixed onward trip and selects a concrete ride on another line", () => {
    const candidate = withReplacement();
    expect(interchangeableRide(primary, candidate, constraints)).toBe(candidate.legs[0]);
  });

  it("rejects a changed onward trip, wrong branch, impossible transfer or late arrival", () => {
    expect(interchangeableRide(primary, journey(8, "both changed"), constraints)).toBeNull();
    const wrongBranch = withReplacement();
    wrongBranch.legs[0].patternStopIds = ["s1", "wrong"];
    expect(interchangeableRide(primary, wrongBranch, constraints)).toBeNull();
    const missed = withReplacement();
    missed.legs[0].arrivalTime = shift(missed.legs[1].departureTime, 1);
    expect(interchangeableRide(primary, missed, constraints)).toBeNull();
    expect(interchangeableRide(primary, withReplacement(), {
      ...constraints, arriveByMs: Date.parse(primary.arrivalTime) - 1,
    })).toBeNull();
  });
});

it("only offers the different-route journey when every ride avoids the excluded line and meets the deadline", () => {
  const candidate = journey(8, "different");
  const excluded = "primary-line";
  const constraints = { earliestLeaveMs: Date.parse(candidate.departureTime), arriveByMs: Date.parse(candidate.arrivalTime) };
  const shared = { ...candidate, legs: [candidate.legs[0], { ...candidate.legs[1], routeId: excluded }, candidate.legs[2]] };
  expect(selectVerifiedDifferentJourneys(excluded, [shared, candidate], constraints)).toEqual([candidate]);
  expect(selectVerifiedDifferentJourneys(excluded, [candidate], { ...constraints, arriveByMs: constraints.arriveByMs - 1 })).toEqual([]);
  expect(selectVerifiedDifferentJourneys(excluded, [candidate], { ...constraints, earliestLeaveMs: constraints.earliestLeaveMs + 1 })).toEqual([]);
  const lessWalking = { ...candidate, walkingDistanceMeters: 0, legs: candidate.legs.map(leg =>
    leg.mode === "WALK" ? leg : { ...leg, routeId: "direct-choice" }) };
  const longerWalk = { ...candidate, walkingDistanceMeters: 500 };
  const sameChain = { ...candidate, walkingDistanceMeters: 10 };
  expect(selectVerifiedDifferentJourneys(excluded, [longerWalk, sameChain, lessWalking], constraints))
    .toEqual([longerWalk, lessWalking]);

});
