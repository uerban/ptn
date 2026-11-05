import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { getVersion } from "./version.js";
import { buildInfo } from "../generated/buildInfo.js";
import { installProductionHttpHook } from "../plugins/productionHttp.js";

describe("GET /api/version", () => {
  it("returns 200 with the BuildInfo shape", async () => {
    const app = Fastify();
    app.get("/api/version", getVersion);
    const res = await app.inject({ method: "GET", url: "/api/version" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      version: buildInfo.version,
      commit: buildInfo.commit,
      builtAt: buildInfo.builtAt,
    });
  });

  it("sets Cache-Control: public, max-age=60", async () => {
    const app = Fastify();
    app.get("/api/version", getVersion);
    const res = await app.inject({ method: "GET", url: "/api/version" });
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
  });
});

describe("response headers (onSend hook)", () => {
  it("sets production build headers and defaults Cache-Control to no-store", async () => {
    const app = Fastify();
    installProductionHttpHook(app, buildInfo);
    app.get("/anything", async () => ({ ok: true }));
    const res = await app.inject({ method: "GET", url: "/anything" });
    expect(res.headers["x-app-version"]).toBe(buildInfo.version);
    expect(res.headers["x-app-commit"]).toBe(buildInfo.commit);
    expect(res.headers["x-api-version"]).toBe("1");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("preserves a route's explicit Cache-Control policy", async () => {
    const app = Fastify();
    installProductionHttpHook(app, buildInfo);
    app.get("/cacheable", async (_request, reply) => {
      reply.header("Cache-Control", "public, max-age=60");
      return { ok: true };
    });
    const res = await app.inject({ method: "GET", url: "/cacheable" });
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
  });
});
