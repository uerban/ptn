import { expect, it } from "vitest";
import { transferWaitingSeconds } from "../../src/components/RouteResults/shared/transferWaiting.ts";
import { makeMixedItinerary } from "../helpers/makeItinerary.ts";

it("excludes access time, transfer walking and confirmed vehicle continuations", () => {
  const itinerary = makeMixedItinerary();
  const [first, second, walk] = itinerary.legs;
  const continuation = { ...first, inSeat: true, departureTime: first.arrivalTime, arrivalTime: first.arrivalTime };
  const transferWalk = { ...walk, departureTime: first.arrivalTime,
    arrivalTime: new Date(Date.parse(first.arrivalTime) + 45_000).toISOString() };
  itinerary.legs = [walk, first, continuation, transferWalk, second, walk];
  const display = { firstTransitDepartureMs: Date.parse(first.departureTime), catchStatus: null };
  expect(transferWaitingSeconds(itinerary, display)).toBe(75);
  expect(transferWaitingSeconds({ ...itinerary, timingUnreliable: true }, display)).toBeNull();
});

it("uses the first-ride delay and suppresses a now-impossible inter-vehicle gap", () => {
  const itinerary = makeMixedItinerary();
  const first = Date.parse(itinerary.legs[0].departureTime);
  expect(transferWaitingSeconds(itinerary, { firstTransitDepartureMs: first + 60_000, catchStatus: null })).toBe(60);
  expect(transferWaitingSeconds(itinerary, { firstTransitDepartureMs: first + 180_000, catchStatus: null })).toBeNull();
});
