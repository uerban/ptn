import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerHealthProbes } from "./health.js";

function makeStore(opts: { ready: boolean; lastUpdated: Date | null }) {
  return {
    isReady: () => opts.ready,
    getLastUpdated: () => opts.lastUpdated,
  };
}

describe("/api/health/ready", () => {
  it("includes feedAgeSeconds when GTFS loader has succeeded", async () => {
    const app = Fastify();
    const tenSecondsAgo = new Date(Date.now() - 10_000);
    app.decorate("gtfsStore", makeStore({ ready: true, lastUpdated: tenSecondsAgo }));
    registerHealthProbes(app);
    const r = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body).toHaveProperty("feedAgeSeconds");
    expect(typeof body.feedAgeSeconds).toBe("number");
    expect(body.feedAgeSeconds).toBeGreaterThanOrEqual(10);
    expect(body.feedAgeSeconds).toBeLessThan(15);
    await app.close();
  });

  it("reports feedAgeSeconds=null when loader has never succeeded but store is somehow ready", async () => {
    const app = Fastify();
    app.decorate("gtfsStore", makeStore({ ready: true, lastUpdated: null }));
    registerHealthProbes(app);
    const r = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).feedAgeSeconds).toBeNull();
    await app.close();
  });

  it("reports POI preflight failure without taking transit readiness down", async () => {
    const app = Fastify();
    app.decorate("gtfsStore", makeStore({ ready: true, lastUpdated: null }));
    registerHealthProbes(app, {
      poiTileStatus: () => ({
        configured: true,
        ready: false,
        error: "invalid POI manifest",
      }),
    });

    const r = await app.inject({ method: "GET", url: "/api/health/ready" });

    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({
      status: "ready",
      poiTile: {
        configured: true,
        ready: false,
        error: "invalid POI manifest",
      },
    });
    await app.close();
  });
});
