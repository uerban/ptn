import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerRtHealthRoute } from "./rtHealth.js";
import type { GtfsRealtimePoller, FeedHealth } from "../gtfs/realtime.js";

function makePoller(health: FeedHealth[]): GtfsRealtimePoller {
  return {
    getFeedHealth: () => health,
    getFeedUrls: () => health.map((h) => h.url),
  } as unknown as GtfsRealtimePoller;
}

describe("GET /api/health/rt", () => {
  it("returns 200 with per-feed status when a poller is registered", async () => {
    const app = Fastify();
    const poller = makePoller([
      { url: "http://a.test/a.pb", status: "ok", lastFetchedAt: 1, lastError: null, entryCount: 42 },
      { url: "http://a.test/b.pb", status: "failed", lastFetchedAt: 2, lastError: "HTTP 503", entryCount: 0 },
    ]);
    registerRtHealthRoute(app, () => poller);
    const res = await app.inject({ method: "GET", url: "/api/health/rt" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.feeds).toHaveLength(2);
    expect(body.feeds[0].status).toBe("ok");
    expect(body.feeds[1].lastError).toBe("HTTP 503");
    expect(body.overall).toBe("degraded");
  });

  it("returns overall=ok when every feed is ok", async () => {
    const app = Fastify();
    const poller = makePoller([
      { url: "http://a.test/a.pb", status: "ok", lastFetchedAt: 1, lastError: null, entryCount: 10 },
    ]);
    registerRtHealthRoute(app, () => poller);
    const res = await app.inject({ method: "GET", url: "/api/health/rt" });
    expect(res.json().overall).toBe("ok");
  });

  it("returns overall=failed when every feed is non-ok", async () => {
    const app = Fastify();
    const poller = makePoller([
      { url: "http://a.test/a.pb", status: "failed", lastFetchedAt: 1, lastError: "HTTP 503", entryCount: 0 },
      { url: "http://a.test/b.pb", status: "pending", lastFetchedAt: null, lastError: null, entryCount: 0 },
    ]);
    registerRtHealthRoute(app, () => poller);
    const res = await app.inject({ method: "GET", url: "/api/health/rt" });
    expect(res.json().overall).toBe("failed");
  });

  it("returns 503 with overall=disabled when no poller is registered", async () => {
    const app = Fastify();
    registerRtHealthRoute(app, () => null);
    const res = await app.inject({ method: "GET", url: "/api/health/rt" });
    expect(res.statusCode).toBe(503);
    expect(res.json().overall).toBe("disabled");
  });

  it("returns 503 with overall=disabled when poller has zero feeds", async () => {
    const app = Fastify();
    const poller = makePoller([]);
    registerRtHealthRoute(app, () => poller);
    const res = await app.inject({ method: "GET", url: "/api/health/rt" });
    expect(res.statusCode).toBe(503);
    expect(res.json().overall).toBe("disabled");
  });
});

describe("GET /api/health/rt registration timing", () => {
  it("can be registered before app.listen() with a null-returning thunk", async () => {
    const app = Fastify();
    // Register BEFORE listen, with a thunk that returns null initially.
    let poller: GtfsRealtimePoller | null = null;
    registerRtHealthRoute(app, () => poller);

    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      // Request while poller is still null — should get disabled/503.
      const res = await app.inject({ method: "GET", url: "/api/health/rt" });
      expect(res.statusCode).toBe(503);
      expect(res.json().overall).toBe("disabled");

      // Now assign a poller and request again — should pick up live value.
      poller = {
        getFeedHealth: () => [
          { url: "http://a.test/a.pb", status: "ok", lastFetchedAt: 1, lastError: null, entryCount: 3 },
        ],
        getFeedUrls: () => ["http://a.test/a.pb"],
      } as unknown as GtfsRealtimePoller;

      const res2 = await app.inject({ method: "GET", url: "/api/health/rt" });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().overall).toBe("ok");
    } finally {
      await app.close();
    }
  });
});
