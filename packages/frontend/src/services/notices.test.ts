import { describe, expect, it } from "vitest";
import type { Departure, Leg, RoutingBundleRoute, RoutingBundleService, ServiceNotice } from "@pt/shared";
import {
  activeNotices,
  noticeText,
  noticesForDeparture,
  noticesForLeg,
  resolveNoticeTrips,
} from "./notices.ts";

const TZ = "Europe/Vilnius";

const christmas: ServiceNotice = {
  id: "xmas", routeIds: ["201"], kind: "seasonal", free: true,
  windows: [{ start: "2026-11-27T22:00:00Z", end: "2026-12-31T22:00:00Z" }],
  displayUntil: "2026-12-31", icon: "🎄", source: "https://example.org/x",
};
const cityFree: ServiceNotice = {
  id: "tree", city: true, kind: "free", free: true,
  windows: [{ start: "2026-11-28T12:00:00Z", end: "2026-11-28T22:00:00Z" }],
  displayUntil: "2026-11-28", source: "https://example.org/t",
  text: { lt: "Nemokamai", en: "Free on lighting night" },
};
const choirDays: ServiceNotice = {
  id: "choir-days", routeIds: ["3G"], kind: "event", free: false,
  windows: [
    { start: "2026-12-02T22:00:00Z", end: "2026-12-03T22:00:00Z" },
    { start: "2026-12-13T22:00:00Z", end: "2026-12-14T22:00:00Z" },
  ],
  displayUntil: "2026-12-14", source: "https://example.org/c",
};
// 18:00 and 18:45 local on Dec 3 (UTC+2) — one vehicle on 1G.
const choirTrips: ServiceNotice = {
  id: "choir-1g", routeIds: ["1G"], kind: "event", free: false,
  windows: [{ start: "2026-12-03T16:00:00Z", end: "2026-12-03T17:27:00Z" }],
  displayUntil: "2026-12-03", icon: "🔔", source: "https://example.org/c",
  trips: ["2026-12-03T16:00:00Z", "2026-12-03T16:45:00Z"],
};

function transit(routeId: string, departureTime: string, extra: Partial<Leg> = {}): Leg {
  return {
    mode: "BUS", routeId, tripId: "t", routeShortName: routeId, departureTime,
    arrivalTime: departureTime, durationSeconds: 0,
    from: { name: "A", location: { lat: 0, lon: 0 } }, to: { name: "B", location: { lat: 0, lon: 0 } },
    ...extra,
  } as Leg;
}

describe("noticesForLeg", () => {
  const all = [christmas, cityFree, choirDays];

  it("a route notice matches only its routes", () => {
    expect(noticesForLeg(all, transit("201", "2026-12-10T10:00:00Z")).map(n => n.id)).toEqual(["xmas"]);
    expect(noticesForLeg(all, transit("4G", "2026-12-10T10:00:00Z"))).toEqual([]);
  });

  it("a city notice matches transit legs only, never walking legs", () => {
    expect(noticesForLeg(all, transit("4G", "2026-11-28T15:00:00Z")).map(n => n.id)).toEqual(["tree"]);
    expect(noticesForLeg(all, { ...transit("4G", "2026-11-28T15:00:00Z"), mode: "WALK", routeId: undefined })).toEqual([]);
  });

  it("boarding inside the window matches and exactly at the end does not", () => {
    expect(noticesForLeg(all, transit("201", "2026-11-27T22:00:00Z"))).toHaveLength(1);
    expect(noticesForLeg(all, transit("201", "2026-12-31T21:59:59Z"))).toHaveLength(1);
    expect(noticesForLeg(all, transit("201", "2026-12-31T22:00:00Z"))).toEqual([]);
  });

  it("boarding before the window does not match even when it arrives inside", () => {
    expect(noticesForLeg(all, transit("4G", "2026-11-28T11:50:00Z", { arrivalTime: "2026-11-28T12:20:00Z" }))).toEqual([]);
  });

  it("uses the scheduled boarding, not the realtime one", () => {
    // Scheduled 21:58, 5 min late: still boards inside.
    expect(noticesForLeg(all, transit("201", "2026-12-31T22:03:00Z", { appliedDelaySeconds: 300 }))).toHaveLength(1);
    // Scheduled 11:58, 5 min late: still outside the tree-lighting window.
    expect(noticesForLeg(all, transit("4G", "2026-11-28T12:03:00Z", { appliedDelaySeconds: 300 }))).toEqual([]);
  });

  it("event-day windows work", () => {
    expect(noticesForLeg(all, transit("3G", "2026-12-14T08:00:00Z")).map(n => n.id)).toEqual(["choir-days"]);
    expect(noticesForLeg(all, transit("3G", "2026-12-15T08:00:00Z"))).toEqual([]);
  });
});

describe("trip-level notices", () => {
  const route: RoutingBundleRoute = {
    id: "1G", shortName: "1G", mode: "BUS", stopIds: ["s1", "s2"],
    trips: [
      { tripId: "a-1800", serviceId: "wk", headsign: "X", departureSecs: [64800, 65400] },
      { tripId: "b-1810", serviceId: "wk", headsign: "X", departureSecs: [65400, 66000] },
      { tripId: "a-1845", serviceId: "wk", headsign: "Y", departureSecs: [-1, 67500, 68100] },
      { tripId: "off-1800", serviceId: "sat", headsign: "X", departureSecs: [64800, 65400] },
    ],
  };
  const calendar: RoutingBundleService[] = [
    { serviceId: "wk", days: [true, true, true, true, true, false, false], startDate: "20261101", endDate: "20261231", exceptions: {} },
    { serviceId: "sat", days: [false, false, false, false, false, true, false], startDate: "20261101", endDate: "20261231", exceptions: {} },
  ];
  const trips = resolveNoticeTrips([choirTrips, christmas], [route], calendar, TZ);

  it("resolves each listed start to the trip that leaves its first stop then", () => {
    expect([...(trips.get("choir-1g") ?? [])].sort()).toEqual(["a-1800", "a-1845"]);
    expect(trips.has("xmas")).toBe(false);
  });

  it("matches only the listed trips, not other departures of the route in the window", () => {
    const leg = (tripId: string) => transit("1G", "2026-12-03T16:20:00Z", { tripId });
    expect(noticesForLeg([choirTrips], leg("a-1800"), trips).map(n => n.id)).toEqual(["choir-1g"]);
    expect(noticesForLeg([choirTrips], leg("b-1810"), trips)).toEqual([]);
    expect(noticesForLeg([choirTrips], leg("a-1800"))).toEqual([]); // unresolved: never guess
  });

  it("finds a start on any of the route's stop patterns", () => {
    // The wire carries one entry per stop pattern, all with the route's id:
    // here the return trip lives on the second one.
    const back: ServiceNotice = { ...choirTrips, id: "back", trips: ["2026-12-03T16:00:00Z", "2026-12-03T17:00:00Z"] };
    const out: RoutingBundleRoute = { ...route, trips: [route.trips[0]!] };
    const ret: RoutingBundleRoute = { ...route, stopIds: ["s2", "s1"], trips: [{ tripId: "r-1900", serviceId: "wk", headsign: "Z", departureSecs: [68400, 69000] }] };
    expect([...(resolveNoticeTrips([back], [out, ret], calendar, TZ).get("back") ?? [])].sort()).toEqual(["a-1800", "r-1900"]);
  });

  it("a start past midnight matches the previous service day at 24:xx", () => {
    const late: ServiceNotice = { ...choirTrips, id: "late", windows: [{ start: "2026-12-03T22:00:00Z", end: "2026-12-03T23:00:00Z" }], trips: ["2026-12-03T22:10:00Z"] };
    const night: RoutingBundleRoute = { ...route, trips: [{ tripId: "n-2410", serviceId: "wk", headsign: "N", departureSecs: [87000] }] };
    expect([...(resolveNoticeTrips([late], [night], calendar, TZ).get("late") ?? [])]).toEqual(["n-2410"]);
  });
});

describe("noticesForDeparture", () => {
  const departure = (routeId: string, scheduledTime: string, extra: Partial<Departure> = {}): Departure => ({
    routeId, routeShortName: routeId, mode: "BUS", headsign: "X", scheduledTime, tripId: "t", ...extra,
  });

  it("uses the scheduled departure and ignores the prediction", () => {
    expect(noticesForDeparture([christmas], departure("201", "2026-12-31T21:58:00Z", { predictedTime: "2026-12-31T22:05:00Z" }))).toHaveLength(1);
    expect(noticesForDeparture([christmas], departure("201", "2026-12-31T22:00:00Z"))).toEqual([]);
  });

  it("trip notices need the departure's trip", () => {
    const trips = new Map([["choir-1g", new Set(["a-1800"])]]);
    expect(noticesForDeparture([choirTrips], departure("1G", "2026-12-03T16:30:00Z", { tripId: "a-1800" }), trips)).toHaveLength(1);
    expect(noticesForDeparture([choirTrips], departure("1G", "2026-12-03T16:30:00Z", { tripId: "z" }), trips)).toEqual([]);
  });
});

describe("activeNotices", () => {
  const all = [christmas, cityFree, choirDays];

  it("lists notices active now or starting within 24h, soonest first", () => {
    expect(activeNotices(all, Date.parse("2026-11-27T11:00:00Z")).map(n => n.id)).toEqual(["xmas"]);
    expect(activeNotices(all, Date.parse("2026-11-28T00:00:00Z")).map(n => n.id)).toEqual(["xmas", "tree"]);
    expect(activeNotices(all, Date.parse("2026-12-02T23:00:00Z")).map(n => n.id)).toEqual(["xmas", "choir-days"]);
  });

  it("is empty when there are none", () => {
    expect(activeNotices([], Date.now())).toEqual([]);
    expect(activeNotices(all, Date.parse("2027-01-05T00:00:00Z"))).toEqual([]);
  });
});

describe("noticeText", () => {
  it("prefers the user's locale, then its language, then the entry's first language", () => {
    expect(noticeText(cityFree, "en")).toBe("Free on lighting night");
    expect(noticeText(cityFree, "en-GB")).toBe("Free on lighting night");
    expect(noticeText(cityFree, "pl")).toBe("Nemokamai");
    expect(noticeText(christmas, "en")).toBeUndefined();
  });
});
