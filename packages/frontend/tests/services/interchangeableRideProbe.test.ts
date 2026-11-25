import { expect, it, vi } from "vitest";
import { probeInterchangeableRide } from "../../src/services/interchangeableRideProbe.ts";
import type { RaptorIndex } from "../../src/services/raptorIndex.ts";
import { makeMixedItinerary } from "../helpers/makeItinerary.ts";

it("discovers a compatible line using the rider transfer floor and preserves the fixed first ride", async () => {
  const primary = makeMixedItinerary();
  const replacement = { ...primary.legs[1], routeId: "ALT", tripId: "T3" };
  const index: RaptorIndex = {
    routes: [], routesAtStop: new Map(), routeIdToIdx: new Map(), services: new Map(),
    patternsAtStop: new Map([["s2", [0]]]),
    patterns: [{ id: "ALT", shortName: "4", mode: "TRAM", stopIds: ["s2", "s3"], trips: [] }],
  };
  const probe = vi.fn(async () => [{ ...primary, legs: [replacement] }]);
  const signal = new AbortController().signal;
  const options = await probeInterchangeableRide(primary, index, 120, new Set(), new Set(), signal, probe);
  expect(probe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ stopId: "s2" }),
    expect.objectContaining({ stopId: "s3" }), new Date(primary.legs[1].departureTime),
    { routeId: "ALT", boardStopId: "s2", alightStopId: "s3" });
  expect(options[0].legs[0]).toBe(primary.legs[0]);
  expect(options[0].legs[1]).toBe(replacement);
  const onward = { ...primary.legs[2], mode: "BUS" as const, routeId: "FIXED", tripId: "fixed" };
  const tight = { ...primary, legs: [...primary.legs.slice(0, 2), onward] };
  expect(await probeInterchangeableRide(tight, index, 120, new Set(), new Set(), signal, probe)).toEqual([]);
  const safe = { ...tight, legs: [...primary.legs.slice(0, 2), {
    ...onward, departureTime: new Date(Date.parse(replacement.arrivalTime) + 120_000).toISOString(),
  }] };
  const [withOnward] = await probeInterchangeableRide(safe, index, 120, new Set(), new Set(), signal, probe);
  expect(withOnward.legs[2]).toBe(safe.legs[2]);
  expect(await probeInterchangeableRide(primary, index, 121, new Set(), new Set(), signal, probe)).toEqual([]);
  expect(await probeInterchangeableRide(primary, index, 120, new Set(["ALT"]), new Set(), signal, probe)).toEqual([]);
});
