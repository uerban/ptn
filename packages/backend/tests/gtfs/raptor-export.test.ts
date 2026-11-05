import { describe, it, expect } from "vitest";
import { buildIndexes } from "../../src/gtfs/index-builder.js";
import type {
  GtfsStop, GtfsRoute, GtfsTrip, GtfsStopTime, GtfsService,
} from "../../src/gtfs/parser.js";

const stops: GtfsStop[] = [
  { id: "s1", name: "Stop A", lat: 54.68, lon: 25.28, parentStation: "" },
  { id: "s2", name: "Stop B", lat: 54.69, lon: 25.29, parentStation: "" },
  { id: "s3", name: "Stop C", lat: 54.70, lon: 25.30, parentStation: "" },
];

const routes: GtfsRoute[] = [
  { id: "r1", shortName: "1", longName: "Line 1", mode: "BUS", color: "FF0000", textColor: "FFFFFF" },
];

const trips: GtfsTrip[] = [
  { tripId: "t1", routeId: "r1", serviceId: "svc1", headsign: "Centre" },
  { tripId: "t2", routeId: "r1", serviceId: "svc1", headsign: "Centre" },
];

const stopTimes: GtfsStopTime[] = [
  { tripId: "t1", stopId: "s1", departureTime: "08:00:00", stopSequence: 1 },
  { tripId: "t1", stopId: "s2", departureTime: "08:10:00", stopSequence: 2 },
  { tripId: "t1", stopId: "s3", departureTime: "08:20:00", stopSequence: 3 },
  { tripId: "t2", stopId: "s1", departureTime: "09:00:00", stopSequence: 1 },
  { tripId: "t2", stopId: "s2", departureTime: "09:10:00", stopSequence: 2 },
  { tripId: "t2", stopId: "s3", departureTime: "09:20:00", stopSequence: 3 },
];

const services: GtfsService[] = [
  {
    serviceId: "svc1",
    monday: true, tuesday: true, wednesday: true, thursday: true, friday: true,
    saturday: false, sunday: false,
    startDate: "20250101", endDate: "20271231",
  },
];

describe("routeTrips / routingInput", () => {
  it("indexes.routeTrips contains ordered stop sequence per route (stopIds only)", () => {
    const { indexes } = buildIndexes(stops, routes, trips, stopTimes, services, []);

    expect(indexes.routeTrips).toBeDefined();
    // routeTrips is now an ordered array; Off mode has one entry per route_id
    const r1 = indexes.routeTrips.find((r) => r.routeId === "r1");
    expect(r1).toBeDefined();
    expect(r1!.stopIds).toEqual(["s1", "s2", "s3"]);
  });

  it("routingInput.routes contains trip departure times per route", () => {
    const { routingInput } = buildIndexes(stops, routes, trips, stopTimes, services, []);

    // routingInput.routes is an ordered array; Off mode has one entry per route_id
    const r1 = routingInput.routes.find((r) => r.routeId === "r1");
    expect(r1).toBeDefined();
    expect(r1!.stopIds).toEqual(["s1", "s2", "s3"]);
    expect(r1!.trips).toHaveLength(2);

    const trip1 = r1!.trips.find((t) => t.tripId === "t1");
    expect(trip1).toBeDefined();
    expect(Array.from(trip1!.departureSecs)).toEqual([28800, 29400, 30000]); // 8:00, 8:10, 8:20

    const trip2 = r1!.trips.find((t) => t.tripId === "t2");
    expect(trip2).toBeDefined();
    expect(Array.from(trip2!.departureSecs)).toEqual([32400, 33000, 33600]); // 9:00, 9:10, 9:20
  });
});
