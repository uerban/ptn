import { expect, it, vi } from "vitest";
import { probeInterchangeableRide } from "../../src/services/interchangeableRideProbe.ts";
import type { RaptorIndex } from "../../src/services/raptorIndex.ts";
import { transferRouteScopedKey, transferTripScopedKey } from "../../src/services/transferRuleKeys.ts";
import { makeMixedItinerary } from "../helpers/makeItinerary.ts";

it("discovers a compatible line using the rider transfer floor and preserves the fixed first ride", async () => {
  const primary = makeMixedItinerary();
  const replacement = { ...primary.legs[1], routeId: "ALT", tripId: "T3" };
  const index: RaptorIndex = {
    routes: [], routesAtStop: new Map(), routeIdToIdx: new Map(), services: new Map(),
    patternsAtStop: new Map([["s2", [0]]]),
    patterns: [{ id: "ALT", shortName: "4", mode: "TRAM", stopIds: ["s2", "s3"], trips: [] }],
  };
  const probe = vi.fn<Parameters<typeof probeInterchangeableRide>[6]>(async () => [{ ...primary, legs: [replacement] }]);
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

  const fixed = primary.legs[0];
  const routeRule = transferRouteScopedKey("s2", "s2", fixed.routeId!, "ALT");
  index.transferRulesRouteScoped = new Map([[routeRule, { type: 1 }]]);
  expect(await probeInterchangeableRide(primary, index, 121, new Set(), new Set(), signal, probe)).toHaveLength(1);
  expect(probe.mock.lastCall?.[2]).toEqual(new Date(fixed.arrivalTime));

  const tripRule = transferTripScopedKey("s2", "s2", fixed.tripId!, "T3");
  index.transferRulesTripScoped = new Map([[tripRule, { type: 3 }]]);
  expect(await probeInterchangeableRide(primary, index, 121, new Set(), new Set(), signal, probe)).toEqual([]);

  index.transferRulesRouteScoped.set(routeRule, { type: 3 });
  probe.mockClear();
  expect(await probeInterchangeableRide(primary, index, 120, new Set(), new Set(), signal, probe)).toEqual([]);
  expect(probe).not.toHaveBeenCalled();
});

it("discovers an earlier timed trip without admitting a competing trip below the broader floor", async () => {
  const primary = makeMixedItinerary();
  const fixed = primary.legs[0];
  const timed = { ...primary.legs[1], routeId: "ALT", tripId: "timed",
    departureTime: "2026-04-23T12:09:00Z", arrivalTime: "2026-04-23T12:17:00Z" };
  const competing = { ...timed, tripId: "competing", departureTime: "2026-04-23T12:08:30Z" };
  const index: RaptorIndex = {
    routes: [], routesAtStop: new Map(), routeIdToIdx: new Map(),
    services: new Map([["active", { serviceId: "active", days: Array(7).fill(true),
      startDate: "20260423", endDate: "20260423", exceptions: {} }]]),
    patternsAtStop: new Map([["s2", [0]]]),
    patterns: [{ id: "ALT", shortName: "4", mode: "TRAM", stopIds: ["s2", "s3"], trips: [
      { tripId: "competing", serviceId: "active", headsign: "C", departureSecs: [43710, 44220] },
      { tripId: "timed", serviceId: "active", headsign: "C", departureSecs: [43740, 44220] },
    ] }],
    transferRulesTripScoped: new Map([[transferTripScopedKey("s2", "s2", fixed.tripId!, "timed"), { type: 1 }]]),
  };
  const probe = vi.fn<Parameters<typeof probeInterchangeableRide>[6]>(async (_from, _to, at, constraint) => {
    const ride = constraint.tripId === timed.tripId ? timed : competing;
    return Date.parse(ride.departureTime) >= at.getTime() ? [{ ...primary, legs: [ride] }] : [];
  });
  const options = await probeInterchangeableRide(primary, index, 120, new Set(), new Set(),
    new AbortController().signal, probe, "UTC");
  expect(options.map(plan => plan.legs[1].tripId)).toEqual(["timed"]);
  expect(probe).toHaveBeenCalledTimes(1);

  index.transferRulesRouteScoped = new Map([[transferRouteScopedKey("s2", "s2", fixed.routeId!, "ALT"), { type: 3 }]]);
  probe.mockClear();
  const allowed = await probeInterchangeableRide(primary, index, 120, new Set(), new Set(),
    new AbortController().signal, probe, "UTC");
  expect(allowed.map(plan => plan.legs[1].tripId)).toEqual(["timed"]);
  expect(probe).toHaveBeenCalledTimes(1);
});

it("uses the normal route after a failed exact result within a shared three-call cap", async () => {
  const primary = makeMixedItinerary();
  const fixed = primary.legs[0];
  const timed = { ...primary.legs[1], routeId: "ALT", tripId: "timed",
    departureTime: "2026-04-23T12:09:00Z", arrivalTime: "2026-04-23T12:17:00Z" };
  const competing = { ...timed, tripId: "competing", departureTime: "2026-04-23T12:08:30Z" };
  const index: RaptorIndex = {
    routes: [], routesAtStop: new Map(), routeIdToIdx: new Map(),
    services: new Map([["active", { serviceId: "active", days: Array(7).fill(true),
      startDate: "20260423", endDate: "20260423", exceptions: {} }]]),
    patternsAtStop: new Map([["s2", [0]]]),
    patterns: [{ id: "ALT", shortName: "4", mode: "TRAM", stopIds: ["s2", "s3"], trips: [
      { tripId: "competing", serviceId: "active", headsign: "C", departureSecs: [43710, 44220] },
      { tripId: "timed", serviceId: "active", headsign: "C", departureSecs: [43740, 44220] },
    ] }],
    transferRulesTripScoped: new Map([[transferTripScopedKey("s2", "s2", fixed.tripId!, "timed"), { type: 1 }]]),
  };
  for (const id of ["ALT2", "ALT3"]) {
    index.patterns!.push({ id, shortName: id, mode: "BUS", stopIds: ["s2", "s3"], trips: [] });
  }
  index.patternsAtStop!.set("s2", [0, 1, 2]);
  const unusedTimetable = vi.fn(() => []);
  Object.defineProperty(index.patterns![2], "trips", { get: unusedTimetable });
  const probe = vi.fn<Parameters<typeof probeInterchangeableRide>[6]>(async (_from, _to, _at, constraint) => {
    if (constraint.tripId) return [{ ...primary, legs: [competing] }];
    const ride = { ...primary.legs[1], tripId: constraint.routeId + "-regular", routeId: constraint.routeId };
    return [{ ...primary, legs: [ride] }];
  });
  const options = await probeInterchangeableRide(primary, index, 120, new Set(), new Set(),
    new AbortController().signal, probe, "UTC");
  expect(unusedTimetable).not.toHaveBeenCalled();
  expect(options.map(plan => plan.legs[1].tripId)).toEqual(["ALT-regular", "ALT2-regular"]);
  expect(probe.mock.calls.map(([, , at, constraint]) => [at.toISOString(), constraint.routeId, constraint.tripId])).toEqual([
    ["2026-04-23T12:08:00.000Z", "ALT", "timed"],
    ["2026-04-23T12:10:00.000Z", "ALT", undefined],
    ["2026-04-23T12:10:00.000Z", "ALT2", undefined],
  ]);
});
