import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerCityGuard } from "./cityGuard.js";

describe("registerCityGuard", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    for (const a of apps) await a.close();
    apps.length = 0;
  });

  async function start(cityId: string): Promise<{ app: FastifyInstance; url: string }> {
    const app = Fastify({ logger: false });
    await registerCityGuard(app, { cityId });
    app.get("/api/ping", async () => ({ ok: true }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    apps.push(app);
    return { app, url: `http://127.0.0.1:${addr.port}` };
  }

  it("passes requests with matching X-PT-Expected-City header", async () => {
    const { url } = await start("vilnius");
    const res = await fetch(`${url}/api/ping`, {
      headers: { "X-PT-Expected-City": "vilnius" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("passes requests with no X-PT-Expected-City header", async () => {
    const { url } = await start("vilnius");
    const res = await fetch(`${url}/api/ping`);
    expect(res.status).toBe(200);
  });

  it("rejects mismatch with 502", async () => {
    const { url } = await start("vilnius");
    const res = await fetch(`${url}/api/ping`, {
      headers: { "X-PT-Expected-City": "tricity" },
    });
    expect(res.status).toBe(502);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("Backend misroute");
    expect(body.expected).toBe("tricity");
    expect(body.actual).toBe("vilnius");
  });

  it("case-insensitive match", async () => {
    const { url } = await start("vilnius");
    const res = await fetch(`${url}/api/ping`, {
      headers: { "X-PT-Expected-City": "VILNIUS" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects every route (not just the registered one)", async () => {
    const app = Fastify({ logger: false });
    await registerCityGuard(app, { cityId: "vilnius" });
    app.get("/health", async () => ({ status: "ok" }));
    app.get("/api/ping", async () => ({ ok: true }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    apps.push(app);
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const url = `http://127.0.0.1:${addr.port}`;

    const healthRes = await fetch(`${url}/health`, {
      headers: { "X-PT-Expected-City": "paris" },
    });
    expect(healthRes.status).toBe(502);

    const apiRes = await fetch(`${url}/api/ping`, {
      headers: { "X-PT-Expected-City": "paris" },
    });
    expect(apiRes.status).toBe(502);
  });
});
