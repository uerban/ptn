import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { RoutingAdapter } from "@pt/shared";
import { searchStops } from "../../src/routes/search.js";
import { planRoute } from "../../src/routes/plan.js";
import { getNearby } from "../../src/routes/nearby.js";
import { getAlerts } from "../../src/routes/alerts.js";
import { getHealth } from "../../src/routes/health.js";

function createMockAdapter(): RoutingAdapter {
  return {
    name: "mock-adapter",
    searchStops: vi.fn().mockResolvedValue([
      { id: "stop1", name: "Vilniaus stotis", lat: 54.67, lon: 25.28 },
    ]),
    planTrip: vi.fn().mockResolvedValue({
      itineraries: [
        {
          duration: 1800,
          startTime: "2026-03-09T10:00:00Z",
          endTime: "2026-03-09T10:30:00Z",
          legs: [],
          transfers: 0,
        },
      ],
    }),
    getNearbyStops: vi.fn().mockResolvedValue([
      { id: "nearby1", name: "Nearby stop", lat: 54.67, lon: 25.28 },
    ]),
    getDepartures: vi.fn().mockResolvedValue([
      { routeName: "1", destination: "Center", departureTime: "10:00" },
    ]),
    getAlerts: vi.fn().mockResolvedValue([
      { id: "alert1", message: "Service disruption" },
    ]),
    healthCheck: vi.fn().mockResolvedValue(true),
  };
}

function createMockRegistry(adapter: RoutingAdapter) {
  return {
    get: (name: string) => (name === adapter.name ? adapter : undefined),
    getDefault: () => adapter,
    list: () => [adapter.name],
    all: () => [adapter],
  };
}

describe("Route handlers - success paths", () => {
  let app: FastifyInstance;
  let adapter: RoutingAdapter;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    adapter = createMockAdapter();
    app.decorate("adapters", createMockRegistry(adapter));
    app.get("/api/stops/search", searchStops);
    app.get("/api/plan", planRoute);
    app.get("/api/nearby", getNearby);
    app.get("/api/alerts", getAlerts);
    app.get("/api/health", getHealth);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Search
  it("searchStops returns results with meta", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/stops/search?q=stotis",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe("Vilniaus stotis");
    expect(body.meta.adapter).toBe("mock-adapter");
    expect(body.meta.responseTimeMs).toBeTypeOf("number");
  });

  it("searchStops returns empty for short query", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/stops/search?q=a",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });

  it("searchStops passes limit parameter", async () => {
    await app.inject({
      method: "GET",
      url: "/api/stops/search?q=stotis&limit=5",
    });
    expect(adapter.searchStops).toHaveBeenCalledWith("stotis", 5);
  });

  // Plan
  it("planRoute returns itineraries", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/plan?fromLat=54.67&fromLon=25.28&toLat=54.64&toLon=25.27",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.itineraries).toHaveLength(1);
    expect(body.meta.adapter).toBe("mock-adapter");
  });

  it("planRoute returns 400 for missing params", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/plan?fromLat=54.67",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("MISSING_PARAMS");
  });

  it("planRoute passes optional params", async () => {
    await app.inject({
      method: "GET",
      url: "/api/plan?fromLat=54.67&fromLon=25.28&toLat=54.64&toLon=25.27&departAt=2026-03-09T10:00:00Z&maxTransfers=2&cursor=abc",
    });
    expect(adapter.planTrip).toHaveBeenCalledWith(
      expect.objectContaining({
        departAt: "2026-03-09T10:00:00.000Z",
        maxTransfers: 2,
        cursor: "abc",
      })
    );
  });

  // Nearby
  it("getNearby returns stops", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/nearby?lat=54.67&lon=25.28",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.meta.adapter).toBe("mock-adapter");
  });

  it("getNearby returns 400 for missing params", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/nearby?lat=54.67",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("MISSING_PARAMS");
  });

  it("getNearby passes radius parameter", async () => {
    await app.inject({
      method: "GET",
      url: "/api/nearby?lat=54.67&lon=25.28&radius=500",
    });
    expect(adapter.getNearbyStops).toHaveBeenCalledWith(
      { lat: 54.67, lon: 25.28 },
      500
    );
  });

  // Alerts
  it("getAlerts returns alerts", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/alerts",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });

  // Health
  it("getHealth returns ok when adapter is healthy", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/health",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.adapters["mock-adapter"].healthy).toBe(true);
    expect(body.timestamp).toBeDefined();
  });
});

describe("Route handlers - strict numeric validation", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    const adapter = createMockAdapter();
    app.decorate("adapters", createMockRegistry(adapter));
    app.get("/api/stops/search", searchStops);
    app.get("/api/plan", planRoute);
    app.get("/api/nearby", getNearby);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // Search - limit validation
  it("rejects limit=10abc as invalid", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stops/search?q=stotis&limit=10abc" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_PARAMS");
  });

  it("rejects limit=0 as out of range", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stops/search?q=stotis&limit=0" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects limit=101 as out of range", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stops/search?q=stotis&limit=101" });
    expect(res.statusCode).toBe(400);
  });

  // Plan - coordinate validation
  it("rejects malformed coordinate like 54.67foo", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/plan?fromLat=54.67foo&fromLon=25.28&toLat=54.64&toLon=25.27",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_PARAMS");
  });

  it("rejects latitude out of range (91)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/plan?fromLat=91&fromLon=25.28&toLat=54.64&toLon=25.27",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_PARAMS");
  });

  it("rejects longitude out of range (-181)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/plan?fromLat=54.67&fromLon=-181&toLat=54.64&toLon=25.27",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_PARAMS");
  });

  it("rejects maxTransfers=2abc", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/plan?fromLat=54.67&fromLon=25.28&toLat=54.64&toLon=25.27&maxTransfers=2abc",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_PARAMS");
  });

  it("rejects maxTransfers=11 as out of range", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/plan?fromLat=54.67&fromLon=25.28&toLat=54.64&toLon=25.27&maxTransfers=11",
    });
    expect(res.statusCode).toBe(400);
  });

  // Nearby - coordinate and radius validation
  it("rejects nearby lat=91 as out of range", async () => {
    const res = await app.inject({ method: "GET", url: "/api/nearby?lat=91&lon=25.28" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_PARAMS");
  });

  it("rejects nearby radius=50001 as out of range", async () => {
    const res = await app.inject({ method: "GET", url: "/api/nearby?lat=54.67&lon=25.28&radius=50001" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects nearby radius=abc", async () => {
    const res = await app.inject({ method: "GET", url: "/api/nearby?lat=54.67&lon=25.28&radius=abc" });
    expect(res.statusCode).toBe(400);
  });
});

describe("Health endpoint - degraded and down states", () => {
  it("returns 503 and degraded when some adapters are unhealthy", async () => {
    const healthyAdapter: RoutingAdapter = {
      name: "healthy",
      searchStops: vi.fn(),
      planTrip: vi.fn(),
      getNearbyStops: vi.fn(),
      getDepartures: vi.fn(),
      getAlerts: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
    };
    const unhealthyAdapter: RoutingAdapter = {
      name: "unhealthy",
      searchStops: vi.fn(),
      planTrip: vi.fn(),
      getNearbyStops: vi.fn(),
      getDepartures: vi.fn(),
      getAlerts: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(false),
    };

    const app = Fastify({ logger: false });
    app.decorate("adapters", {
      get: () => healthyAdapter,
      getDefault: () => healthyAdapter,
      list: () => ["healthy", "unhealthy"],
      all: () => [healthyAdapter, unhealthyAdapter],
    });
    app.get("/api/health", getHealth);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("degraded");
    expect(body.adapters["healthy"].healthy).toBe(true);
    expect(body.adapters["unhealthy"].healthy).toBe(false);

    await app.close();
  });

  it("returns 503 and down when all adapters are unhealthy", async () => {
    const downAdapter: RoutingAdapter = {
      name: "down-adapter",
      searchStops: vi.fn(),
      planTrip: vi.fn(),
      getNearbyStops: vi.fn(),
      getDepartures: vi.fn(),
      getAlerts: vi.fn(),
      healthCheck: vi.fn().mockRejectedValue(new Error("connection refused")),
    };

    const app = Fastify({ logger: false });
    app.decorate("adapters", {
      get: () => downAdapter,
      getDefault: () => downAdapter,
      list: () => ["down-adapter"],
      all: () => [downAdapter],
    });
    app.get("/api/health", getHealth);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("down");
    expect(body.adapters["down-adapter"].healthy).toBe(false);

    await app.close();
  });
});
