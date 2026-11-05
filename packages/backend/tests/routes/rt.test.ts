import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { encodeRouteUpdate, decodeRouteUpdate } from "@pt/shared";
import { getRouteRt } from "../../src/routes/rt.js";
import { GtfsStore } from "../../src/gtfs/store.js";
import { buildIndexes } from "../../src/gtfs/index-builder.js";
import type {
  GtfsStop,
  GtfsRoute,
  GtfsTrip,
  GtfsStopTime,
  GtfsService,
} from "../../src/gtfs/parser.js";

// ── Protobuf roundtrip ────────────────────────────────────────────────────

describe("RouteUpdate protobuf roundtrip", () => {
  it("encodes and decodes correctly", () => {
    const original = {
      routeId: "r1",
      trips: [
        { tripId: "t1", delaySeconds: 120, cancelled: false },
        { tripId: "t2", delaySeconds: -30, cancelled: true },
      ],
      generatedAt: Date.now(),
    };

    const encoded = encodeRouteUpdate(original);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(0);
    expect(encoded.length).toBeLessThan(200);

    const decoded = decodeRouteUpdate(encoded);
    expect(decoded.routeId).toBe("r1");
    expect(decoded.trips).toHaveLength(2);
    expect(decoded.trips[0].tripId).toBe("t1");
    expect(decoded.trips[0].delaySeconds).toBe(120);
    expect(decoded.trips[1].cancelled).toBe(true);
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────────

const stops: GtfsStop[] = [
  { id: "s1", name: "Stop A", lat: 54.68, lon: 25.28, parentStation: "" },
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
  { tripId: "t2", stopId: "s1", departureTime: "09:00:00", stopSequence: 1 },
];

const services: GtfsService[] = [
  {
    serviceId: "svc1",
    monday: true, tuesday: true, wednesday: true,
    thursday: true, friday: true, saturday: false, sunday: false,
    startDate: "20250101", endDate: "20271231",
  },
];

function makeStore(): GtfsStore {
  const { indexes, canonical, routingInput } = buildIndexes(stops, routes, trips, stopTimes, services, []);
  const store = new GtfsStore(indexes, canonical, routingInput);
  store.setRealtimeUpdates(
    new Map([
      ["t1", { delaySeconds: 60, cancelled: false }],
      ["t2", { delaySeconds: -15, cancelled: true }],
    ]),
  );
  return store;
}

// ── Endpoint tests ────────────────────────────────────────────────────────

describe("GET /api/rt/:routeId", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.decorate("gtfsStore", makeStore());
    app.get("/api/rt/:routeId", getRouteRt);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns protobuf with correct headers", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/rt/r1",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/x-protobuf");
    expect(res.headers["cache-control"]).toContain("max-age=");

    const decoded = decodeRouteUpdate(new Uint8Array(res.rawPayload));
    expect(decoded.routeId).toBe("r1");
    expect(decoded.trips).toHaveLength(1);
    expect(decoded.trips[0].tripId).toBe("t1");
    expect(decoded.trips[0].delaySeconds).toBe(60);
    expect(decoded.trips[0].cancelled).toBe(false);
  });

  it("returns empty trips for unknown route", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/rt/nonexistent",
    });

    expect(res.statusCode).toBe(200);
    const decoded = decodeRouteUpdate(new Uint8Array(res.rawPayload));
    expect(decoded.routeId).toBe("nonexistent");
    // Protobuf repeated fields may decode as undefined when empty
    expect(decoded.trips ?? []).toHaveLength(0);
  });

  it("returns 503 when store is not ready", async () => {
    const notReadyApp = Fastify({ logger: false });
    notReadyApp.decorate("gtfsStore", new GtfsStore());
    notReadyApp.get("/api/rt/:routeId", getRouteRt);
    await notReadyApp.ready();

    const res = await notReadyApp.inject({
      method: "GET",
      url: "/api/rt/r1",
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("LOADING");

    await notReadyApp.close();
  });
});
