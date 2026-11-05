import { describe, it, expect } from "vitest";
import { buildIdentity } from "./buildIdentity.js";
import type { GtfsStop, GtfsRoute, GtfsTrip, GtfsService, GtfsCalendarDate } from "../parser.js";

const stop = (id: string, lat = 0, lon = 0): GtfsStop => ({
  id, name: `Stop ${id}`, lat, lon,
} as GtfsStop);

const route = (id: string): GtfsRoute => ({
  id, shortName: `R${id}`, longName: `Route ${id}`, color: "",
} as GtfsRoute);

const trip = (tripId: string, routeId: string, serviceId: string, headsign: string): GtfsTrip => ({
  tripId, routeId, serviceId, headsign, directionId: 0,
} as GtfsTrip);

const svc = (serviceId: string): GtfsService => ({
  serviceId,
  monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false,
  startDate: "20260420", endDate: "20260531",
} as GtfsService);

describe("buildIdentity", () => {
  it("interns stops, routes, services, trips, headsigns with distinct ix", () => {
    const id = buildIdentity({
      stops: [stop("s1"), stop("s2")],
      routes: [route("r1")],
      trips: [trip("t1", "r1", "svc", "Downtown")],
      services: [svc("svc")],
      calendarDates: [],
      buildDateIso: "2026-04-20",
      horizonDays: 90,
    });
    expect(id.stops.size).toBe(2);
    expect(id.routes.size).toBe(1);
    expect(id.services.size).toBe(1);
    expect(id.trips.size).toBe(1);
    expect(id.headsigns.size).toBe(1);
    expect(id.stops.indexOf("s1")).toBe(0);
    expect(id.stops.indexOf("s2")).toBe(1);
    expect(id.stops.indexOf("unknown")).toBe(-1);
  });

  it("interns distinct headsigns once", () => {
    const id = buildIdentity({
      stops: [stop("s1")], routes: [route("r1")],
      trips: [
        trip("t1", "r1", "svc", "Downtown"),
        trip("t2", "r1", "svc", "Downtown"),
        trip("t3", "r1", "svc", "Airport"),
      ],
      services: [svc("svc")], calendarDates: [],
      buildDateIso: "2026-04-20", horizonDays: 90,
    });
    expect(id.headsigns.size).toBe(2);
    expect(id.headsigns.indexOf("Downtown")).toBe(0);
    expect(id.headsigns.indexOf("Airport")).toBe(1);
  });

  it("populates bitmasks for every service referenced in calendar or calendar_dates", () => {
    const id = buildIdentity({
      stops: [stop("s1")], routes: [route("r1")],
      trips: [trip("t1", "r1", "svc_A", "Downtown")],
      services: [svc("svc_A")],
      calendarDates: [{ serviceId: "svc_B", date: "20260425", exceptionType: 1 }],
      buildDateIso: "2026-04-20", horizonDays: 30,
    });
    expect(id.bitmasks.has("svc_A")).toBe(true);
    expect(id.bitmasks.has("svc_B")).toBe(true);
    expect(id.bitmasks.get("svc_A")!.horizonDays).toBe(30);
  });

  it("captures buildDateIso and horizonDays on the result", () => {
    const id = buildIdentity({
      stops: [stop("s1")], routes: [route("r1")],
      trips: [trip("t1", "r1", "svc", "H")],
      services: [svc("svc")], calendarDates: [],
      buildDateIso: "2026-04-20", horizonDays: 14,
    });
    expect(id.buildDateIso).toBe("2026-04-20");
    expect(id.horizonDays).toBe(14);
  });

  it("dedups duplicate stop ids (first occurrence wins)", () => {
    const id = buildIdentity({
      stops: [stop("s1"), stop("s1")],
      routes: [route("r1")],
      trips: [trip("t1", "r1", "svc", "H")],
      services: [svc("svc")], calendarDates: [],
      buildDateIso: "2026-04-20", horizonDays: 30,
    });
    expect(id.stops.size).toBe(1);
  });

  it("empty headsign is treated as a distinct value", () => {
    const id = buildIdentity({
      stops: [stop("s1")], routes: [route("r1")],
      trips: [
        trip("t1", "r1", "svc", ""),
        trip("t2", "r1", "svc", "Downtown"),
      ],
      services: [svc("svc")], calendarDates: [],
      buildDateIso: "2026-04-20", horizonDays: 30,
    });
    expect(id.headsigns.size).toBe(2);
    expect(id.headsigns.indexOf("")).toBe(0);
  });
});
