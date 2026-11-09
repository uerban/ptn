import { describe, expect, it } from "vitest";
import type { Alert, Itinerary, Leg } from "@pt/shared";
import {
  alertsByLeg,
  legTargets,
  stopTargets,
  type AlertTargetIndex,
} from "./useServiceAlertSelection.ts";
import { selectAlerts } from "../services/serviceAlertSelection.ts";
import { itineraryAlerts } from "../components/ServiceAlerts/ServiceAlertTripNotes.tsx";

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: "a1",
    cause: "UNKNOWN_CAUSE",
    effect: "DETOUR",
    severity: "WARNING",
    header: [{ text: "Detour" }],
    description: [],
    url: [],
    activePeriods: [],
    informedEntities: [{ routeId: "R1" }],
    ...overrides,
  };
}

const WALK: Leg = {
  mode: "WALK",
  from: { name: "Home", location: { lat: 0, lon: 0 } },
  to: { name: "Stop A", stopId: "SA", location: { lat: 0, lon: 0 } },
  departureTime: "2026-11-08T10:00:00Z",
  arrivalTime: "2026-11-08T10:05:00Z",
  durationSeconds: 300,
};

const RIDE: Leg = {
  mode: "BUS",
  from: { name: "Stop A", stopId: "SA", location: { lat: 0, lon: 0 } },
  to: { name: "Stop B", stopId: "SB", location: { lat: 0, lon: 0 } },
  departureTime: "2026-11-08T10:05:00Z",
  arrivalTime: "2026-11-08T10:25:00Z",
  durationSeconds: 1200,
  routeId: "R1",
  routeShortName: "4G",
  tripId: "T1",
};

const TRIP = { legs: [WALK, RIDE] } as Pick<Itinerary, "legs">;

describe("targets", () => {
  it("describes a stop and each distinct departure there", () => {
    expect(
      stopTargets("S1", [
        { routeId: "R1", tripId: "T1" },
        { routeId: "R1", tripId: "T1" },
        { routeId: "R2", tripId: "T2" },
      ]),
    ).toEqual([
      { stopId: "S1" },
      { stopId: "S1", routeId: "R1", tripId: "T1" },
      { stopId: "S1", routeId: "R2", tripId: "T2" },
    ]);
  });

  it("describes a ride at its boarding and alighting stops; a walk not at all", () => {
    expect(legTargets(WALK)).toEqual([]);
    expect(legTargets(RIDE)).toEqual([
      { routeId: "R1", tripId: "T1", stopId: "SA" },
      { routeId: "R1", tripId: "T1", stopId: "SB" },
    ]);
  });
});

/** Timetable metadata: R1 is agency A's bus (route_type 3), T1 runs direction 1. */
const TIMETABLE = {
  routes: [
    {
      id: "R1",
      shortName: "4G",
      mode: "BUS",
      agencyId: "A",
      routeType: 3,
      stopIds: ["SA", "SB"],
      trips: [{ tripId: "T1", serviceId: "x", headsign: "B", directionId: 1, departureSecs: [0, 60] }],
    },
  ],
  routeIdToIdx: new Map([["R1", 0]]),
} as unknown as AlertTargetIndex;

describe("targets with timetable metadata", () => {
  it("carries agency, route type and direction on departures and rides", () => {
    expect(stopTargets("S1", [{ routeId: "R1", tripId: "T1" }], TIMETABLE)[1]).toEqual({
      stopId: "S1",
      routeId: "R1",
      tripId: "T1",
      agencyId: "A",
      routeType: 3,
      directionId: 1,
    });
    expect(legTargets(RIDE, TIMETABLE)[0]).toMatchObject({ agencyId: "A", routeType: 3, directionId: 1 });
  });

  it("shows agency-wide, route-type and direction alerts on the stop sheet and the ride", () => {
    const agency = alert({ id: "agency", informedEntities: [{ agencyId: "A" }] });
    const buses = alert({ id: "buses", informedEntities: [{ routeType: 3 }] });
    const direction = alert({ id: "dir", informedEntities: [{ routeId: "R1", directionId: 1 }] });
    const otherAgency = alert({ id: "other-agency", informedEntities: [{ agencyId: "B" }] });
    const trams = alert({ id: "trams", informedEntities: [{ routeType: 0 }] });
    const otherDirection = alert({ id: "dir0", informedEntities: [{ routeId: "R1", directionId: 0 }] });
    const all = [agency, buses, direction, otherAgency, trams, otherDirection];

    const targets = stopTargets("S1", [{ routeId: "R1", tripId: "T1" }], TIMETABLE);
    expect(selectAlerts(all, targets).map((a) => a.id)).toEqual(["agency", "buses", "dir"]);
    expect(alertsByLeg(all, TRIP, TIMETABLE)[1].map((a) => a.id)).toEqual(["agency", "buses", "dir"]);
  });
});

describe("alertsByLeg", () => {
  it("assigns route, trip and stop alerts to the ride only", () => {
    const route = alert({ id: "route" });
    const stop = alert({ id: "stop", informedEntities: [{ stopId: "SB" }] });
    const other = alert({ id: "other", informedEntities: [{ routeId: "R9" }] });
    const [walk, ride] = alertsByLeg([route, stop, other], TRIP);
    expect(walk).toEqual([]);
    expect(ride.map((a) => a.id)).toEqual(["route", "stop"]);
  });

  it("ignores a stop the ride only passes, and selectors that only partly match", () => {
    const elsewhere = alert({ informedEntities: [{ routeId: "R1", stopId: "SX" }] });
    const direction = alert({ id: "dir", informedEntities: [{ routeId: "R1", directionId: 1 }] });
    expect(alertsByLeg([elsewhere, direction], TRIP)[1]).toEqual([]);
  });

  it("compares active periods with when the leg runs", () => {
    const during = alert({
      id: "during",
      activePeriods: [{ start: "2026-11-08T10:20:00Z", end: "2026-11-08T11:00:00Z" }],
    });
    const before = alert({
      id: "before",
      activePeriods: [{ start: "2026-11-08T08:00:00Z", end: "2026-11-08T10:00:00Z" }],
    });
    expect(alertsByLeg([during, before], TRIP)[1].map((a) => a.id)).toEqual(["during"]);
  });
});

describe("itineraryAlerts", () => {
  it("lists each alert once with the lines it concerns", () => {
    const second: Leg = { ...RIDE, routeShortName: "7", tripId: "T2" };
    const entries = itineraryAlerts([alert()], { legs: [RIDE, WALK, second] });
    expect(entries).toHaveLength(1);
    expect(entries[0].lines).toEqual(["4G", "7"]);
  });
});
