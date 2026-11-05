import { describe, it, expect } from "vitest";
import { GtfsStore } from "../../src/gtfs/store.js";
import { buildIndexes } from "../../src/gtfs/index-builder.js";
import type {
  GtfsStop,
  GtfsRoute,
  GtfsTrip,
  GtfsStopTime,
  GtfsService,
} from "../../src/gtfs/parser.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

const stops: GtfsStop[] = [
  { id: "s1", name: "Stop A", lat: 54.68, lon: 25.28, parentStation: "" },
  { id: "s2", name: "Stop B", lat: 54.69, lon: 25.29, parentStation: "" },
  { id: "s3", name: "Stop C", lat: 55.0, lon: 26.0, parentStation: "" }, // far away
];

const routes: GtfsRoute[] = [
  { id: "r1", shortName: "1", longName: "Line 1", mode: "BUS" as const, color: "FF0000", textColor: "FFFFFF" },
  { id: "r2", shortName: "3", longName: "Line 3", mode: "TRAM" as const, color: "0000FF", textColor: "FFFFFF" },
];

const trips: GtfsTrip[] = [
  { tripId: "t1", routeId: "r1", serviceId: "svc1", headsign: "Centre" },
  { tripId: "t2", routeId: "r2", serviceId: "svc1", headsign: "Station" },
];

const stopTimes: GtfsStopTime[] = [
  { tripId: "t1", stopId: "s1", departureTime: "08:00:00", stopSequence: 1 },
  { tripId: "t1", stopId: "s2", departureTime: "08:10:00", stopSequence: 2 },
  { tripId: "t2", stopId: "s1", departureTime: "08:05:00", stopSequence: 1 },
];

const services: GtfsService[] = [
  {
    serviceId: "svc1",
    monday: true,
    tuesday: true,
    wednesday: true,
    thursday: true,
    friday: true,
    saturday: false,
    sunday: false,
    startDate: "20250101",
    endDate: "20271231",
  },
];

function makeStore(): GtfsStore {
  const { indexes, canonical, routingInput } = buildIndexes(stops, routes, trips, stopTimes, services, []);
  return new GtfsStore(indexes, canonical, routingInput);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("GtfsStore", () => {
  it("getAllStops returns all stops with their routes", () => {
    const store = makeStore();
    const allStops = store.getAllStops();

    expect(allStops).toHaveLength(3);

    const stopA = allStops.find((s) => s.id === "s1");
    expect(stopA).toBeDefined();
    expect(stopA!.name).toBe("Stop A");
    expect(stopA!.location).toEqual({ lat: 54.68, lon: 25.28 });
    // s1 is served by t1 (r1) and t2 (r2)
    expect(stopA!.routes).toHaveLength(2);
    const routeIds = stopA!.routes.map((r) => r.id).sort();
    expect(routeIds).toEqual(["r1", "r2"]);

    // s3 has no stop times, so no routes
    const stopC = allStops.find((s) => s.id === "s3");
    expect(stopC).toBeDefined();
    expect(stopC!.routes).toHaveLength(0);
  });

  it("getNearbyStops filters by distance (includes near, excludes far)", () => {
    const store = makeStore();
    // s1 and s2 are close together (~1.4 km apart), s3 is ~60+ km away
    const nearby = store.getNearbyStops(54.685, 25.285, 5000);

    const nearbyIds = nearby.map((s) => s.id).sort();
    expect(nearbyIds).toContain("s1");
    expect(nearbyIds).toContain("s2");
    expect(nearbyIds).not.toContain("s3");
  });

  it("getDepartures returns departures for a stop on a weekday", () => {
    const store = makeStore();
    // 2025-06-02 is a Monday
    const date = new Date("2025-06-02T07:50:00");
    const departures = store.getDepartures("s1", date, 10);

    expect(departures).toHaveLength(2);
    // Should be sorted by scheduledTime
    expect(departures[0].tripId).toBe("t1");
    expect(departures[0].routeShortName).toBe("1");
    expect(departures[0].headsign).toBe("Centre");
    expect(departures[0].mode).toBe("BUS");
    // routeColor is now normalized to cluster centroid with # prefix
    expect(departures[0].routeColor).toMatch(/^#[0-9a-f]{6}$/i);
    expect(departures[0].routeId).toBe("r1");

    expect(departures[1].tripId).toBe("t2");
    expect(departures[1].routeShortName).toBe("3");
    expect(departures[1].headsign).toBe("Station");
    expect(departures[1].mode).toBe("TRAM");
  });

  it("getDepartures returns empty on Saturday when service is weekday-only", () => {
    const store = makeStore();
    // 2025-06-07 is a Saturday
    const date = new Date("2025-06-07T08:00:00");
    const departures = store.getDepartures("s1", date, 10);

    expect(departures).toHaveLength(0);
  });

  it("isReady reports correctly", () => {
    const emptyStore = new GtfsStore();
    expect(emptyStore.isReady()).toBe(false);

    const loadedStore = makeStore();
    expect(loadedStore.isReady()).toBe(true);
  });
});

describe("getActiveRoutesByStop", () => {
  let store: GtfsStore;

  it("returns routes with departures within the lookahead window", () => {
    store = makeStore();
    const date = new Date("2025-06-02T07:50:00"); // Monday
    const result = store.getActiveRoutesByStop(date, 1);
    expect(result.get("s1")?.has("r1")).toBe(true);
  });

  it("excludes routes outside the lookahead window", () => {
    store = makeStore();
    const date = new Date("2025-06-02T06:00:00");
    const result = store.getActiveRoutesByStop(date, 1);
    expect(result.has("s1")).toBe(false);
  });

  it("caches result within the same 5-minute bucket", () => {
    store = makeStore();
    const date1 = new Date("2025-06-02T07:51:00");
    const date2 = new Date("2025-06-02T07:53:00");
    const r1 = store.getActiveRoutesByStop(date1, 1);
    const r2 = store.getActiveRoutesByStop(date2, 1);
    expect(r1).toBe(r2);
  });

  it("invalidates cache across 5-minute bucket boundary", () => {
    store = makeStore();
    const date1 = new Date("2025-06-02T07:49:00");
    const date2 = new Date("2025-06-02T07:51:00");
    const r1 = store.getActiveRoutesByStop(date1, 1);
    const r2 = store.getActiveRoutesByStop(date2, 1);
    expect(r1).not.toBe(r2);
  });
});
