import { describe, expect, it } from "vitest";
import { DEFAULT_WALK_SPEED_MPS } from "@pt/shared/constants";
import { serviceDayOriginUnix } from "@pt/shared/time";
import type { ArriveByConnection, ArriveByJourneyOption, ArriveByRide } from "../../services/temporalArriveByJourneys.ts";
import type { ArriveBySelector, ArriveByTransitWitness } from "../../services/temporalArriveByResults.ts";
import { arriveByCards, arriveByItinerary, orderArriveByCards, type ArriveByDisplayContext } from "./arriveByItineraries.ts";

const TZ = "Europe/Vilnius";
const DATE = 20261012;

function witness(boardSecs: number, alightSecs: number, inSeat = false): ArriveByTransitWitness {
  return { serviceDate: DATE, routeIdx: 1, readerRouteIdx: 1, tripIdx: 1, boardPosition: 1, alightPosition: 4,
    boardSecs, alightSecs, frequencyOffsetSecs: 0, frequencyInstance: false, inSeat };
}
function ride(id: string, from: string, to: string, w: ArriveByTransitWitness, color: string | null = "123456"): ArriveByRide {
  return { witness: w, routeId: `route-${id}`, routeShortName: id, routeColor: color, tripId: `trip-${id}`,
    mode: "BUS", routeType: 3, fromStopId: from, toStopId: to, patternStopIds: ["X", from, "Y", "Z", to], approximate: false };
}
function connection(from: string, to: string, arrivalSecs: number, boardingSecs: number, walkSecs: number,
  kind: ArriveByConnection["kind"]): ArriveByConnection {
  return { fromStopId: from, toStopId: to, arrivalSecs, boardingSecs, walkSecs, minimumElapsedSecs: walkSecs,
    kind, spendsTransfer: kind !== "in-seat" && kind !== "derived" };
}

/** Walk 300 s to A, ride 1 to B, walk 120 s to C, ride 2 to D, walk 60 s to exit E, 90 s on. */
function twoRides(selectors: ArriveBySelector[] = ["latest-departure"], kind: ArriveByConnection["kind"] = "footpath",
  departureSecs = 30000): ArriveByJourneyOption {
  const d = departureSecs;
  const w1 = witness(d + 300, d + 1200), w2 = witness(d + 1500, d + 2400, kind === "in-seat");
  const walk = kind === "footpath" ? 120 : 0;
  return {
    selectors,
    journey: {
      point: { departureSecs: d, arrivalSecs: d + 2550, actualTransfers: kind === "in-seat" ? 0 : 1,
        totalWalkSecs: 300 + walk + 60 + 90, transitRounds: 2, serviceDate: DATE, witnessLegs: 2, witness: [w1, w2] },
      access: { stopId: "A", walkSecs: 300 },
      rides: [ride("1", "A", "B", w1), ride("2", kind === "footpath" ? "C" : "B", "D", w2, null)],
      connections: [connection("B", kind === "footpath" ? "C" : "B", d + 1200, d + 1500, walk, kind)],
      egress: { fromStopId: "D", exitStopId: "E", physicalWalkSecs: 60, callerWalkSecs: 90 },
    },
  };
}

const ctx: ArriveByDisplayContext = {
  serviceDate: DATE, tz: TZ, origin: { lat: 1, lon: 2 }, destination: { lat: 3, lon: 4 },
  labels: { origin: "Origin", destination: "Destination" },
  stops: new Map(["A", "B", "C", "D", "E"].map((id, i) => [id, { name: `Stop ${id}`, lat: 10 + i, lon: 20 + i }])),
  headsigns: new Map([["trip-1", "North"]]),
  routeColors: new Map([["route-2", "abcdef"]]),
  runToCatchStops: new Set(["A"]),
};
const at = (secs: number, date = DATE): string => new Date((serviceDayOriginUnix(date, TZ) + secs) * 1000).toISOString();

describe("arriveByItinerary", () => {
  it("keeps the engine's movements, times and walks", () => {
    const it = arriveByItinerary(twoRides(), ctx);
    expect(it.legs.map((l) => [l.mode, l.from.name, l.to.name, l.departureTime, l.arrivalTime, l.durationSeconds])).toEqual([
      ["WALK", "Origin", "Stop A", at(30000), at(30300), 300],
      ["BUS", "Stop A", "Stop B", at(30300), at(31200), 900],
      ["WALK", "Stop B", "Stop C", at(31200), at(31320), 120],
      ["BUS", "Stop C", "Stop D", at(31500), at(32400), 900],
      ["WALK", "Stop D", "Stop E", at(32400), at(32460), 60],
      ["WALK", "Stop E", "Destination", at(32460), at(32550), 90],
    ]);
    expect(it.legs[0]).toMatchObject({ runToCatch: true, from: { location: { lat: 1, lon: 2 } } });
    expect(it.legs[1]).toMatchObject({ routeShortName: "1", routeColor: "123456", headsign: "North", tripId: "trip-1",
      routeId: "route-1", boardStopIdx: 1, alightStopIdx: 4, intermediateStops: 2, approximate: false,
      patternStopIds: ["X", "A", "Y", "Z", "B"], from: { stopId: "A", location: { lat: 10, lon: 20 } } });
    expect(it.legs[3]).toMatchObject({ routeColor: "abcdef" });
    expect(it.legs[3]).not.toHaveProperty("headsign");
    expect(it).toMatchObject({ departureTime: at(30000), arrivalTime: at(32550), durationSeconds: 2550, transfers: 1,
      walkingDistanceMeters: Math.round(570 * DEFAULT_WALK_SPEED_MPS) });
  });

  it("draws no walk for an in-seat continuation and counts no transfer", () => {
    const it = arriveByItinerary(twoRides(["latest-departure"], "in-seat"), ctx);
    expect(it.legs.map((l) => l.mode)).toEqual(["WALK", "BUS", "BUS", "WALK", "WALK"]);
    expect(it.transfers).toBe(0);
  });

  it("projects a time past 24:00 into the next civil day of the same frame", () => {
    const it = arriveByItinerary(twoRides(["latest-departure"], "footpath", 90000), ctx);
    expect(it.departureTime).toBe(at(90000));
    expect(it.departureTime.slice(0, 10)).toBe("2026-10-12");
    expect(new Date(it.arrivalTime).getTime() - new Date(it.departureTime).getTime()).toBe(2550_000);
  });

  it("uses the frame's origin on a DST date", () => {
    const fallBack = { ...ctx, serviceDate: 20261025 };
    const it = arriveByItinerary(twoRides(), fallBack);
    expect(it.departureTime).toBe(at(30000, 20261025));
    // The Vilnius frame of 2026-10-25 starts at noon EET minus 12 h, 01:00 EEST, not civil midnight.
    expect(serviceDayOriginUnix(20261025, TZ)).toBe(Date.parse("2026-10-24T22:00:00Z") / 1000);
  });

  it("omits zero-second walks", () => {
    const o = twoRides();
    const j = { ...o.journey, access: { stopId: "A", walkSecs: 0 },
      egress: { fromStopId: "D", exitStopId: "D", physicalWalkSecs: 0, callerWalkSecs: 0 } };
    const it = arriveByItinerary({ ...o, journey: j }, ctx);
    expect(it.legs.map((l) => l.mode)).toEqual(["BUS", "WALK", "BUS"]);
  });
});

describe("orderArriveByCards", () => {
  const option = (selectors: ArriveBySelector[], dep: number, dur: number, transfers: number, walk: number): ArriveByJourneyOption => {
    const o = twoRides(selectors, "footpath", dep);
    return { ...o, journey: { ...o.journey, point: { ...o.journey.point, arrivalSecs: dep + dur, actualTransfers: transfers, totalWalkSecs: walk } } };
  };
  const options = [
    option(["latest-departure"], 36000, 3000, 2, 400),
    option(["fewest-transfers"], 30000, 3000, 0, 500),
    option(["fastest"], 32000, 2000, 1, 600),
    option(["least-walking"], 30000, 2500, 2, 100),
  ];
  const cards = arriveByCards(options, ctx);
  const deps = (ranking: Parameters<typeof orderArriveByCards>[1]) =>
    orderArriveByCards(cards, ranking).map((c) => c.option.selectors[0]);

  it("puts the latest departure first, then descending departure", () => {
    expect(deps("fastest")).toEqual(["latest-departure", "fastest", "least-walking", "fewest-transfers"]);
  });
  it("resolves equal departures by the selected sort", () => {
    expect(deps("fewest_transfers")).toEqual(["latest-departure", "fastest", "fewest-transfers", "least-walking"]);
    expect(deps("least_walking")).toEqual(["latest-departure", "fastest", "least-walking", "fewest-transfers"]);
  });
  it("keeps a latest-only stage as one card and an empty result empty", () => {
    expect(orderArriveByCards(cards.slice(0, 1), "fastest")).toHaveLength(1);
    expect(orderArriveByCards([], "fastest")).toEqual([]);
  });
});
