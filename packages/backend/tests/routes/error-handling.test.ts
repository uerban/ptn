import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { RoutingAdapter } from "@pt/shared";
import { searchStops } from "../../src/routes/search.js";
import { planRoute } from "../../src/routes/plan.js";
import { getNearby } from "../../src/routes/nearby.js";

function createFailingAdapter(errorMessage: string): RoutingAdapter {
  return {
    name: "failing-adapter",
    searchStops: vi.fn().mockRejectedValue(new Error(errorMessage)),
    planTrip: vi.fn().mockRejectedValue(new Error(errorMessage)),
    getNearbyStops: vi.fn().mockRejectedValue(new Error(errorMessage)),
    getDepartures: vi.fn().mockRejectedValue(new Error(errorMessage)),
    healthCheck: vi.fn().mockResolvedValue(false),
  };
}

function createMockRegistry(adapter: RoutingAdapter) {
  return {
    get: () => adapter,
    getDefault: () => adapter,
    list: () => [adapter.name],
    all: () => [adapter],
  };
}

describe("Route error handling", () => {
  let app: FastifyInstance;
  const errorMsg = "Transitous API unreachable";

  beforeAll(async () => {
    app = Fastify({ logger: false });
    const adapter = createFailingAdapter(errorMsg);
    app.decorate("adapters", createMockRegistry(adapter));
    app.get("/api/stops/search", searchStops);
    app.get("/api/plan", planRoute);
    app.get("/api/nearby", getNearby);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("searchStops returns 502 with structured error on adapter failure", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/stops/search?q=stotis",
    });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error).toEqual({
      code: "ADAPTER_ERROR",
      message: "Upstream service error",
      details: { adapter: "failing-adapter" },
    });
  });

  it("planRoute returns 502 with structured error on adapter failure", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/plan?fromLat=54.67&fromLon=25.28&toLat=54.64&toLon=25.27",
    });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error).toEqual({
      code: "ADAPTER_ERROR",
      message: "Upstream service error",
      details: { adapter: "failing-adapter" },
    });
  });

  it("getNearby returns 502 with structured error on adapter failure", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/nearby?lat=54.67&lon=25.28",
    });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error).toEqual({
      code: "ADAPTER_ERROR",
      message: "Upstream service error",
      details: { adapter: "failing-adapter" },
    });
  });

  it("handles non-Error throws gracefully", async () => {
    const weirdAdapter: RoutingAdapter = {
      name: "weird-adapter",
      searchStops: vi.fn().mockRejectedValue("string error"),
      planTrip: vi.fn().mockRejectedValue(42),
      getNearbyStops: vi.fn().mockRejectedValue(null),
      getDepartures: vi.fn().mockRejectedValue(undefined),
      healthCheck: vi.fn().mockResolvedValue(true),
    };

    const app2 = Fastify({ logger: false });
    app2.decorate("adapters", createMockRegistry(weirdAdapter));
    app2.get("/api/stops/search", searchStops);
    app2.get("/api/plan", planRoute);
    app2.get("/api/nearby", getNearby);
    await app2.ready();

    const searchRes = await app2.inject({
      method: "GET",
      url: "/api/stops/search?q=test",
    });
    expect(searchRes.statusCode).toBe(502);
    expect(searchRes.json().error.message).toBe("Upstream service error");

    const planRes = await app2.inject({
      method: "GET",
      url: "/api/plan?fromLat=1&fromLon=2&toLat=3&toLon=4",
    });
    expect(planRes.statusCode).toBe(502);
    expect(planRes.json().error.message).toBe("Upstream service error");

    const nearbyRes = await app2.inject({
      method: "GET",
      url: "/api/nearby?lat=1&lon=2",
    });
    expect(nearbyRes.statusCode).toBe(502);
    expect(nearbyRes.json().error.message).toBe("Upstream service error");

    await app2.close();
  });
});
