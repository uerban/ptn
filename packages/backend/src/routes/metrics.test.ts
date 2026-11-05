import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import { resolveMetricsHost, startMetricsServer } from "./metrics.js";
import { metricsRegistry } from "../metrics/registry.js";
import type { FastifyInstance } from "fastify";

describe("resolveMetricsHost", () => {
  // The whole point of this helper is the loopback-by-default safety property.
  // If a future refactor weakens any of these branches, prod backends could
  // silently bind on all interfaces — so each input that should fall back is
  // its own assertion, not a parameterised loop.
  it("falls back to 127.0.0.1 when METRICS_HOST is unset", () => {
    expect(resolveMetricsHost({})).toBe("127.0.0.1");
  });
  it("falls back to 127.0.0.1 when METRICS_HOST is empty string", () => {
    expect(resolveMetricsHost({ METRICS_HOST: "" })).toBe("127.0.0.1");
  });
  it("falls back to 127.0.0.1 when METRICS_HOST is whitespace only", () => {
    expect(resolveMetricsHost({ METRICS_HOST: "  \t" })).toBe("127.0.0.1");
  });
  it("returns the trimmed value when METRICS_HOST is set", () => {
    expect(resolveMetricsHost({ METRICS_HOST: "0.0.0.0" })).toBe("0.0.0.0");
    expect(resolveMetricsHost({ METRICS_HOST: " 0.0.0.0 " })).toBe("0.0.0.0");
  });
});

describe("metrics server", () => {
  const instances: FastifyInstance[] = [];

  afterEach(async () => {
    for (const i of instances) await i.close();
    instances.length = 0;
  });

  async function start(port: number, host: string = "127.0.0.1") {
    const app = await startMetricsServer({ port, profile: "ride", host });
    instances.push(app);
    return app;
  }

  it("returns the versioned schema with process fields populated and layers null", async () => {
    const app = await start(0);
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health/metrics`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(1);
    expect(body.profile).toBe("ride");
    expect(body.note).toMatch(/internal/i);
    expect(body.process).toBeDefined();
    expect(typeof body.process.heapUsedBytes).toBe("number");
    expect(typeof body.process.heapTotalBytes).toBe("number");
    expect(typeof body.process.rssBytes).toBe("number");
    expect(typeof body.process.externalBytes).toBe("number");
    expect(typeof body.process.arrayBuffersBytes).toBe("number");
    expect(body.identity).toBeNull();
    expect(body.canonical).toBeNull();
    expect(body.mapView).toBeNull();
    expect(body.routingView).toBeNull();
  });

  it("binds to loopback when caller passes 127.0.0.1", async () => {
    const app = await start(0, "127.0.0.1");
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    expect(addr.address).toBe("127.0.0.1");
  });

  it("respects an explicit host override (for cross-container scrape)", async () => {
    const app = await start(0, "0.0.0.0");
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    expect(addr.address).toBe("0.0.0.0");
  });

  it("only exposes /api/health/metrics (other paths 404)", async () => {
    const app = await start(0);
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health/ready`);
    expect(res.status).toBe(404);
  });

  it("flips pt_metrics_sidecar_up to 1 once listen() resolves", async () => {
    await start(0);
    const json = await metricsRegistry.registry.getMetricsAsJSON();
    const m = json.find((x) => x.name === "pt_metrics_sidecar_up");
    expect(m).toBeDefined();
    expect(m!.values[0]?.value).toBe(1);
  });

  it("does not flip pt_metrics_sidecar_up to 1 when listen() rejects (port in use)", async () => {
    // First start reserves a port; second start on the same port must
    // EADDRINUSE. Reset the gauge between so we can observe the
    // failure-path behavior — without this, the first start's set(1)
    // pollutes the assertion.
    const reserver = await start(0);
    const addr = reserver.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");

    metricsRegistry.metricsSidecarUp.set(0);
    await expect(start(addr.port)).rejects.toThrow();

    const json = await metricsRegistry.registry.getMetricsAsJSON();
    const m = json.find((x) => x.name === "pt_metrics_sidecar_up");
    expect(m!.values[0]?.value).toBe(0);
  });
});

// Regression coverage for audit finding B7: the metrics sidecar started in
// index.ts's main() had no shutdown wiring — closing the main app left the
// sidecar listener running. index.ts now registers an onClose hook on the
// main app BEFORE `app.listen` (a nullable `metricsApp` slot, assigned once
// startMetricsServer succeeds), mirroring the async resource cleanup path.
// The pre-listen ordering is load-bearing: Fastify throws
// FST_ERR_INSTANCE_ALREADY_LISTENING on post-listen addHook, so a hook
// registered after listen never runs in production. main() itself is
// side-effectful (binds real ports, loads GTFS, starts the scheduler) and
// isn't invoked in tests, so this test reproduces the exact wiring AND
// listen ordering of index.ts against a minimal stand-in "main" app.
describe("metrics sidecar shutdown wiring (mirrors index.ts onClose)", () => {
  it("closing a LISTENING main app also closes the metrics sidecar (hook wired pre-listen)", async () => {
    const mainApp = Fastify({ logger: false });

    // Pre-listen: nullable slot + hook, exactly as index.ts does.
    let metricsApp: FastifyInstance | null = null;
    mainApp.addHook("onClose", async () => {
      if (metricsApp) await metricsApp.close();
    });

    try {
      // Main app actually listens — this is what made post-listen addHook
      // throw in the original (buggy) wiring; the stand-in must reproduce it.
      await mainApp.listen({ port: 0, host: "127.0.0.1" });

      metricsApp = await startMetricsServer({ port: 0, profile: "ride", host: "127.0.0.1" });

      const addr = metricsApp.server.address();
      if (!addr || typeof addr === "string") throw new Error("no address");
      const port = addr.port;

      // Sanity: sidecar is reachable before shutdown.
      const before = await fetch(`http://127.0.0.1:${port}/api/health/metrics`);
      expect(before.status).toBe(200);

      await mainApp.close();

      // After the main app closes, the sidecar's onClose hook must have run —
      // its listener should no longer accept connections.
      await expect(fetch(`http://127.0.0.1:${port}/api/health/metrics`)).rejects.toThrow();
    } finally {
      // mainApp.close() is idempotent; the hook closes metricsApp with it, so
      // this only matters when an assertion fails mid-test.
      await mainApp.close();
    }
  });

  it("regression guard: addHook after listen throws (why the hook must be pre-listen)", async () => {
    const mainApp = Fastify({ logger: false });
    await mainApp.listen({ port: 0, host: "127.0.0.1" });
    try {
      expect(() => mainApp.addHook("onClose", async () => {})).toThrow(
        /already listening/i,
      );
    } finally {
      await mainApp.close();
    }
  });
});
