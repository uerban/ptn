import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerRoutingBundleRoutes } from "./routingBundle.js";

describe("routing-bundle endpoints", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    for (const a of apps) await a.close();
    apps.length = 0;
  });

  async function start(): Promise<{ app: FastifyInstance; url: string }> {
    const app = Fastify({ logger: false });
    registerRoutingBundleRoutes(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    apps.push(app);
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    return { app, url: `http://127.0.0.1:${addr.port}` };
  }

  it("GET /api/routing-bundle/version returns the versioned scaffolding shape", async () => {
    const { url } = await start();
    const res = await fetch(`${url}/api/routing-bundle/version`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.version).toBe(1);
    expect(body.schema).toBe("unstable");
    expect(body.ready).toBe(false);
    expect(body.note).toMatch(/serializer|stub|future/i);
  });

  it("GET /api/routing-bundle/fetch returns 404 with a serializer-not-implemented body", async () => {
    const { url } = await start();
    const res = await fetch(`${url}/api/routing-bundle/fetch`);
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toMatch(/not.implemented|stub|serializer/i);
    expect(body.version_endpoint).toBe("/api/routing-bundle/version");
  });
});
