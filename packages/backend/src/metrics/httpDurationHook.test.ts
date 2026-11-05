import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { installHttpDurationHook } from "./httpDurationHook.js";
import { metricsRegistry } from "./registry.js";

async function countObservations(route: string): Promise<number> {
  const json = await metricsRegistry.registry.getMetricsAsJSON();
  const m = json.find((x) => x.name === "pt_http_request_duration_seconds");
  if (!m) return 0;
  // prom-client's per-bucket series carry a `metricName` field at runtime
  // (e.g. `..._bucket`, `..._count`, `..._sum`) but the JSON return type
  // doesn't surface it. Cast through `unknown` to read it.
  return m.values
    .filter((v) => {
      const named = v as unknown as { metricName?: string };
      return (
        named.metricName?.endsWith("_count") && v.labels?.route === route
      );
    })
    .reduce((sum, v) => sum + (v.value ?? 0), 0);
}

describe("installHttpDurationHook", () => {
  it("records duration with method/route/status_code labels for a matched route", async () => {
    const app = Fastify({ logger: false });
    installHttpDurationHook(app);
    app.get("/api/echo", async () => ({ ok: true }));
    await app.ready();

    const before = await countObservations("/api/echo");
    const res = await app.inject({ method: "GET", url: "/api/echo" });
    expect(res.statusCode).toBe(200);

    const after = await countObservations("/api/echo");
    expect(after).toBe(before + 1);

    await app.close();
  });

  it("skips routes in the skip set (default: health probes)", async () => {
    const app = Fastify({ logger: false });
    installHttpDurationHook(app);
    app.get("/api/health", async () => "ok");
    await app.ready();

    const before = await countObservations("/api/health");
    await app.inject({ method: "GET", url: "/api/health" });
    const after = await countObservations("/api/health");
    expect(after).toBe(before);

    await app.close();
  });

  it("uses the matched route TEMPLATE as the label, not the raw URL", async () => {
    // Without this, two requests to `/api/foo/abc` and `/api/foo/xyz` would
    // create two label tuples — cardinality grows unbounded with request volume.
    const app = Fastify({ logger: false });
    installHttpDurationHook(app);
    app.get("/api/foo/:id", async () => ({ ok: true }));
    await app.ready();

    await app.inject({ method: "GET", url: "/api/foo/abc" });
    await app.inject({ method: "GET", url: "/api/foo/xyz" });

    const json = await metricsRegistry.registry.getMetricsAsJSON();
    const m = json.find((x) => x.name === "pt_http_request_duration_seconds");
    const labels = m!.values
      .map((v) => v.labels?.route)
      .filter((r) => r === "/api/foo/:id" || r === "/api/foo/abc" || r === "/api/foo/xyz");
    expect(labels).toContain("/api/foo/:id");
    expect(labels).not.toContain("/api/foo/abc");
    expect(labels).not.toContain("/api/foo/xyz");

    await app.close();
  });

  it("emits status_code for error responses too (so per-route error rate is derivable)", async () => {
    const app = Fastify({ logger: false });
    installHttpDurationHook(app);
    app.get("/api/boom", async () => {
      throw new Error("boom");
    });
    await app.ready();

    await app.inject({ method: "GET", url: "/api/boom" });

    const json = await metricsRegistry.registry.getMetricsAsJSON();
    const m = json.find((x) => x.name === "pt_http_request_duration_seconds");
    const errorSamples = m!.values.filter(
      (v) =>
        v.labels?.route === "/api/boom" && v.labels?.status_code === "500",
    );
    expect(errorSamples.length).toBeGreaterThan(0);

    await app.close();
  });
});
