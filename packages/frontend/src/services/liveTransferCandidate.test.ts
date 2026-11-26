import { expect, it } from "vitest";
import { findLiveTransferCandidate, liveTransferRouteIds } from "./liveTransferCandidate.ts";
import type { RaptorIndex, RaptorIndexRoute } from "./raptorIndex.ts";

const nowMs = Date.parse("2026-11-20T13:17:00Z");
const scheduled = Date.parse("2026-11-20T13:18:00Z");
const pattern: RaptorIndexRoute = {
  id: "vilnius_trol_4", shortName: "4", mode: "TROLLEYBUS", stopIds: ["5264", "683"],
  trips: [
    { tripId: "T4-03-1-260925-ab-1450", serviceId: "fri", headsign: "Vilkpėdė", departureSecs: [55_080, 55_320] },
    { tripId: "T4-11-1-260925-ab-1500", serviceId: "fri", headsign: "Vilkpėdė", departureSecs: [55_680, 55_920] },
  ],
};
const index: RaptorIndex = {
  routes: [pattern], routeIdToIdx: new Map([[pattern.id, 0]]), routesAtStop: new Map([["5264", [0]]]),
  patterns: [pattern], patternsAtStop: new Map([["5264", [0]]]),
  services: new Map([["fri", {
    serviceId: "fri", days: [false, false, false, false, true, false, false],
    startDate: "20261101", endDate: "20261130", exceptions: {},
  }]]),
};

function discover({
  incomingDelay = -30, outgoingDelay = 90, updateAgeMs = 20_000, cancelled = false,
  transferFloor = 120, alightStop = "683",
} = {}) {
  return findLiveTransferCandidate({
    index, incoming: { routeId: "vilnius_expressbus_3G", tripId: "incoming", toStopId: "5264" },
    realtime: {
      getTripDelay: tripId => tripId === "incoming" ? { delaySeconds: incomingDelay, cancelled: false }
        : tripId === pattern.trips[0].tripId ? { delaySeconds: outgoingDelay, cancelled } : null,
      getReceivedAt: () => nowMs - updateAgeMs,
    },
    incomingScheduledArrivalMs: scheduled, alightStopIds: new Set([alightStop]),
    minTransferSecs: transferFloor, feedTz: "Europe/Vilnius", nowMs, latestBoardMs: nowMs + 600_000,
  });
}

it("finds the delayed exact trip at the transfer floor, after its scheduled boarding", () => {
  expect(discover()).toEqual({
    firstRide: { routeId: pattern.id, tripId: pattern.trips[0].tripId, boardStopId: "5264", alightStopId: "683" },
    scheduledBoardMs: scheduled, predictedBoardMs: scheduled + 90_000, predictedAlightMs: scheduled + 330_000,
  });
});

it.each([
  { outgoingDelay: 89 },
  { updateAgeMs: 120_000 },
  { incomingDelay: 0 },
  { cancelled: true },
  { transferFloor: 121 },
  { alightStop: "wrong-branch" },
])("rejects an ineligible delayed departure with %j", (overrides) => {
  expect(discover(overrides)).toBeNull();
});

it("prioritizes timetable proximity before capping live route acquisition", () => {
  const makePattern = (id: string, boardSecs: number): RaptorIndexRoute => ({
    ...pattern, id, trips: [{ ...pattern.trips[0], departureSecs: [boardSecs, boardSecs + 240] }],
  });
  const patterns = [makePattern("far", 54_000), makePattern("close", 55_080), makePattern("next", 55_200)];
  const feed = { ...index, patterns, patternsAtStop: new Map([["5264", [0, 1, 2]]]) };
  const choose = (excludedRoutes: string[] = []) => liveTransferRouteIds(
    feed, "5264", new Set(["683"]), new Set(excludedRoutes), new Set(),
    scheduled, scheduled + 600_000, "Europe/Vilnius",
  );
  expect(choose()).toEqual(["close", "next"]);
  expect(choose(["close"])).toEqual(["next", "far"]);
});
