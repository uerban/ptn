import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { registerHealthProbes } from "../../src/routes/health.js";

function createMockStore(ready: boolean) {
  return { isReady: () => ready };
}

function createMockScheduler(
  loaderMode: "ptb" | "ptb_fallback" | "gtfs-network",
  serviceWindowAnchor: number | null = null,
) {
  return { loaderMode, serviceWindowAnchor };
}

function createMockAdapter(name: string, healthy: boolean) {
  return {
    name,
    healthCheck: healthy
      ? vi.fn().mockResolvedValue(true)
      : vi.fn().mockRejectedValue(new Error("unhealthy")),
  };
}

function createMockRegistry(adapters: ReturnType<typeof createMockAdapter>[]) {
  return { all: () => adapters };
}

describe("/api/health/ready", () => {
  it("returns 503 when GTFS store is not ready", async () => {
    const app = Fastify({ logger: false });
    app.decorate("gtfsStore", createMockStore(false));
    app.decorate("adapters", createMockRegistry([]));
    registerHealthProbes(app);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("not_ready");
    expect(body.reason).toBe("GTFS data not loaded");

    await app.close();
  });

  it("returns 200 when GTFS store is ready", async () => {
    const app = Fastify({ logger: false });
    app.decorate("gtfsStore", createMockStore(true));
    app.decorate("adapters", createMockRegistry([]));
    registerHealthProbes(app);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ready");

    await app.close();
  });

  it.each([
    { loaderMode: "ptb" as const },
    { loaderMode: "ptb_fallback" as const },
    { loaderMode: "gtfs-network" as const },
  ])("includes ingestionPath=$loaderMode in the ready response", async ({ loaderMode }) => {
    const app = Fastify({ logger: false });
    app.decorate("gtfsStore", createMockStore(true));
    app.decorate("gtfsScheduler", createMockScheduler(loaderMode));
    app.decorate("adapters", createMockRegistry([]));
    registerHealthProbes(app);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ingestionPath).toBe(loaderMode);

    await app.close();
  });

  it("reports ingestionPath=unknown when gtfsScheduler is not decorated", async () => {
    // Backward-compat: health probe reads loaderMode defensively; no throw when
    // the scheduler decoration is absent (e.g. in older integration test harnesses).
    const app = Fastify({ logger: false });
    app.decorate("gtfsStore", createMockStore(true));
    // intentionally omit gtfsScheduler decoration
    app.decorate("adapters", createMockRegistry([]));
    registerHealthProbes(app);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ingestionPath).toBe("unknown");

    await app.close();
  });

  it("includes serviceWindowAnchor=null and serviceWindowStale=false when scheduler has no anchor", async () => {
    const app = Fastify({ logger: false });
    app.decorate("gtfsStore", createMockStore(true));
    app.decorate("gtfsScheduler", createMockScheduler("gtfs-network", null));
    app.decorate("adapters", createMockRegistry([]));
    registerHealthProbes(app);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.serviceWindowAnchor).toBeNull();
    expect(body.serviceWindowAgeDays).toBeNull();
    expect(body.serviceWindowStale).toBe(false);

    await app.close();
  });

  it("reports serviceWindowAgeDays and serviceWindowStale=false for a fresh ptb anchor", async () => {
    // Anchor is today — age should be 0 days and NOT stale.
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const d = String(today.getDate()).padStart(2, "0");
    const todayYYYYMMDD = Number(`${y}${m}${d}`);

    const app = Fastify({ logger: false });
    app.decorate("gtfsStore", createMockStore(true));
    app.decorate("gtfsScheduler", createMockScheduler("ptb", todayYYYYMMDD));
    app.decorate("adapters", createMockRegistry([]));
    registerHealthProbes(app);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.serviceWindowAnchor).toBe(todayYYYYMMDD);
    expect(body.serviceWindowAgeDays).toBe(0);
    expect(body.serviceWindowStale).toBe(false);

    await app.close();
  });

  it("reports serviceWindowStale=true for an old ptb anchor (>80 days)", async () => {
    // Anchor is 90 days ago — should be stale.
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const y = ninetyDaysAgo.getFullYear();
    const m = String(ninetyDaysAgo.getMonth() + 1).padStart(2, "0");
    const d = String(ninetyDaysAgo.getDate()).padStart(2, "0");
    const oldAnchor = Number(`${y}${m}${d}`);

    const app = Fastify({ logger: false });
    app.decorate("gtfsStore", createMockStore(true));
    app.decorate("gtfsScheduler", createMockScheduler("ptb", oldAnchor));
    app.decorate("adapters", createMockRegistry([]));
    registerHealthProbes(app);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.serviceWindowAnchor).toBe(oldAnchor);
    expect(body.serviceWindowAgeDays).toBeGreaterThan(80);
    expect(body.serviceWindowStale).toBe(true);

    await app.close();
  });
});

describe("/api/health/startup", () => {
  it("returns 200 when GTFS and all adapters are healthy", async () => {
    const app = Fastify({ logger: false });
    const adapter = createMockAdapter("mock-adapter", true);
    app.decorate("gtfsStore", createMockStore(true));
    app.decorate("adapters", createMockRegistry([adapter]));
    registerHealthProbes(app);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/health/startup" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("started");
    expect(body.adapters).toHaveLength(1);
    expect(body.adapters[0].name).toBe("mock-adapter");
    expect(body.adapters[0].healthy).toBe(true);

    await app.close();
  });

  it("returns 503 when GTFS is not ready", async () => {
    const app = Fastify({ logger: false });
    const adapter = createMockAdapter("mock-adapter", true);
    app.decorate("gtfsStore", createMockStore(false));
    app.decorate("adapters", createMockRegistry([adapter]));
    registerHealthProbes(app);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/health/startup" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("starting");
    expect(body.gtfs).toBe("loading");

    await app.close();
  });

  it("returns 503 when an adapter is unhealthy", async () => {
    const app = Fastify({ logger: false });
    const adapter = createMockAdapter("mock-adapter", false);
    app.decorate("gtfsStore", createMockStore(true));
    app.decorate("adapters", createMockRegistry([adapter]));
    registerHealthProbes(app);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/health/startup" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("starting");
    expect(body.gtfs).toBe("loaded");
    expect(body.adapters[0].healthy).toBe(false);

    await app.close();
  });
});
