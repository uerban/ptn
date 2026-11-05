import type {
  GtfsStop,
  GtfsRoute,
  GtfsTrip,
  GtfsStopTime,
  GtfsService,
} from "../parser.js";

// Fixture: one tiny city — 3 stops, 1 route, 1 trip, 1 always-on service.
// Sized so it compiles cleanly into GtfsIndexes for store-level tests.

export const fixtureStops: GtfsStop[] = [
  { id: "S_A", name: "Stop A", lat: 48.85, lon: 2.35, parentStation: "" },
  { id: "S_B", name: "Stop B", lat: 48.86, lon: 2.36, parentStation: "" },
  { id: "S_C", name: "Stop C", lat: 48.87, lon: 2.37, parentStation: "" },
];

export const fixtureRoutes: GtfsRoute[] = [
  {
    id: "R1",
    shortName: "1",
    longName: "Line One",
    mode: "BUS",
    color: "FF0000",
    textColor: "FFFFFF",
  },
];

export const fixtureTrips: GtfsTrip[] = [
  { tripId: "T1", routeId: "R1", serviceId: "SVC1", headsign: "Stop C" },
];

export const fixtureStopTimes: GtfsStopTime[] = [
  { tripId: "T1", stopId: "S_A", departureTime: "08:00:00", stopSequence: 1 },
  { tripId: "T1", stopId: "S_B", departureTime: "08:10:00", stopSequence: 2 },
  { tripId: "T1", stopId: "S_C", departureTime: "08:20:00", stopSequence: 3 },
];

export const fixtureServices: GtfsService[] = [
  {
    serviceId: "SVC1",
    monday: true,
    tuesday: true,
    wednesday: true,
    thursday: true,
    friday: true,
    saturday: true,
    sunday: true,
    startDate: "20200101",
    endDate: "20991231",
  },
];
