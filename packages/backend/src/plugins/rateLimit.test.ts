import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerRateLimit, rateLimitForRoute, RATE_LIMIT_DEFAULTS } from "./rateLimit.js";

describe("registerRateLimit", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    for (const a of apps) await a.close();
    apps.length = 0;
    delete process.env.PT_RATELIMIT_DISABLED;
  });

  async function start(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await registerRateLimit(app);
    apps.push(app);
    return app;
  }

  it("defaults object exposes spec-required limits", () => {
    expect(RATE_LIMIT_DEFAULTS.stopsBbox).toEqual({ max: 60, timeWindow: "1 minute" });
    expect(RATE_LIMIT_DEFAULTS.routeById).toEqual({ max: 60, timeWindow: "1 minute" });
    expect(RATE_LIMIT_DEFAULTS.plan).toEqual({ max: 20, timeWindow: "1 minute" });
    expect(RATE_LIMIT_DEFAULTS.routingBundle).toEqual({ max: 10, timeWindow: "1 minute" });
  });

  it("rate-limits a route decorated with rateLimitForRoute", async () => {
    const app = await start();
    app.get("/api/plan", { config: { rateLimit: rateLimitForRoute("plan") } }, async () => ({ ok: true }));
    const addr = await app.listen({ port: 0, host: "127.0.0.1" });

    const url = `${addr}/api/plan`;
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await fetch(url);
      statuses.push(res.status);
    }
    const limited = statuses.filter((s) => s === 429);
    expect(limited.length).toBeGreaterThan(0);
  });

  it("PT_RATELIMIT_DISABLED=1 disables enforcement", async () => {
    process.env.PT_RATELIMIT_DISABLED = "1";
    const app = await start();
    app.get("/api/plan", { config: { rateLimit: rateLimitForRoute("plan") } }, async () => ({ ok: true }));
    const addr = await app.listen({ port: 0, host: "127.0.0.1" });
    const url = `${addr}/api/plan`;
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await fetch(url);
      statuses.push(res.status);
    }
    const limited = statuses.filter((s) => s === 429);
    expect(limited.length).toBe(0);
  });
});
