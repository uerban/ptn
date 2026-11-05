import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import { registerHealthProbes } from "./health.js";

function makeStore() {
  return { isReady: () => true, getLastUpdated: () => new Date(Date.now() - 10_000) };
}
function makeScheduler(bundleBuildState: any) {
  return { loaderMode: "ptb", serviceWindowAnchor: null, bundleBuildState };
}
async function ready(bundleBuildState: any) {
  const app = Fastify();
  app.decorate("gtfsStore", makeStore());
  app.decorate("gtfsScheduler", makeScheduler(bundleBuildState));
  registerHealthProbes(app);
  const r = await app.inject({ method: "GET", url: "/api/health/ready" });
  await app.close();
  return r.json();
}

const baseBbs = { configured: true, everBuilt: true, lastBuildStatus: "success" as const, lastSuccessMs: Date.now(), lastFailureMs: null, oversizedLeafCount: 0 };

describe("/api/health/ready scheduleBundle", () => {
  it("never built => failing true, lastSuccessAgeSeconds null (no 56-yr number)", async () => {
    const body = await ready({ configured: true, everBuilt: false, lastBuildStatus: "failure", lastSuccessMs: null, lastFailureMs: Date.now() });
    expect(body.scheduleBundle).toMatchObject({ configured: true, everBuilt: false, lastBuildStatus: "failure", lastSuccessAgeSeconds: null, failing: true });
  });

  it("built-then-failed => failing false (prior bundle still serves)", async () => {
    const body = await ready({ configured: true, everBuilt: true, lastBuildStatus: "failure", lastSuccessMs: Date.now() - 60_000, lastFailureMs: Date.now() });
    expect(body.scheduleBundle.failing).toBe(false);
    expect(body.scheduleBundle.lastSuccessAgeSeconds).toBeGreaterThanOrEqual(59);
  });

  it("not configured => configured false, failing false", async () => {
    const body = await ready({ configured: false, everBuilt: false, lastBuildStatus: null, lastSuccessMs: null, lastFailureMs: null });
    expect(body.scheduleBundle).toMatchObject({ configured: false, failing: false });
  });

  it("is additive — existing ready fields are still present", async () => {
    const body = await ready({ configured: true, everBuilt: false, lastBuildStatus: null, lastSuccessMs: null, lastFailureMs: null });
    expect(body).toHaveProperty("feedAgeSeconds");
    expect(body).toHaveProperty("ingestionPath");
    expect(body).toHaveProperty("serviceWindowAnchor");
    expect(body).toHaveProperty("serviceWindowAgeDays");
    expect(body).toHaveProperty("serviceWindowStale");
  });

  it("surfaces scheduleBundle.oversizedLeafCount from the scheduler build state", async () => {
    const body = await ready({
      configured: true, everBuilt: true, lastBuildStatus: "success",
      lastSuccessMs: Date.now(), lastFailureMs: null, oversizedLeafCount: 3,
    });
    expect(body.scheduleBundle.oversizedLeafCount).toBe(3);
  });

  it("after a simulated restart, /ready reflects oversizedLeafCount hydrated from the on-disk manifest", async () => {
    const { GtfsScheduler } = await import("../gtfs/scheduler.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const noop = { info(){}, warn(){}, error(){}, debug(){}, trace(){}, fatal(){}, level: "info", silent(){}, child(){ return noop; } } as any;
    const dir = mkdtempSync(join(tmpdir(), "ptn-restart-"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      schemaVersion: 1, bundleHash: "abc", generatedAt: 1_700_000_000_000, tileSize: 6000,
      subdivisions: { "906_28": { leaves: [
        { suffix: "0", bbox: { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 }, compressedBytes: 5000, oversized: true },
      ] } },
    }));
    const scheduler = new GtfsScheduler({
      gtfsUrls: ["https://example.test/feed.zip"], refreshIntervalHours: 24, rtFeedUrls: [],
      cityId: "paris", logger: noop, scheduleTileDataDir: dir,
    } as any);
    scheduler.hydrateBundleLastSuccessGauge();
    const app = Fastify();
    app.decorate("gtfsStore", makeStore());
    app.decorate("gtfsScheduler", scheduler as any);
    registerHealthProbes(app);
    const r = await app.inject({ method: "GET", url: "/api/health/ready" });
    await app.close();
    expect(r.json().scheduleBundle.oversizedLeafCount).toBe(1);
  });

  it("503 early-return (store not ready) carries no scheduleBundle", async () => {
    const app = Fastify();
    app.decorate("gtfsStore", { isReady: () => false, getLastUpdated: () => null });
    app.decorate("gtfsScheduler", makeScheduler({ configured: true, everBuilt: false, lastBuildStatus: "failure", lastSuccessMs: null, lastFailureMs: Date.now() }));
    registerHealthProbes(app);
    const r = await app.inject({ method: "GET", url: "/api/health/ready" });
    await app.close();
    expect(r.statusCode).toBe(503);
    expect(r.json()).not.toHaveProperty("scheduleBundle");
  });
});

describe("/api/health/ready scheduleBundle.scheduleTileSource", () => {
  const origEnv = process.env.PT_SCHEDULE_TILE_SOURCE;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.PT_SCHEDULE_TILE_SOURCE;
    else process.env.PT_SCHEDULE_TILE_SOURCE = origEnv;
  });

  it("defaults to 'backend' when PT_SCHEDULE_TILE_SOURCE is unset", async () => {
    delete process.env.PT_SCHEDULE_TILE_SOURCE;
    const body = await ready(baseBbs);
    expect(body.scheduleBundle.scheduleTileSource).toBe("backend");
  });

  it("reports 'backend' when PT_SCHEDULE_TILE_SOURCE=backend", async () => {
    process.env.PT_SCHEDULE_TILE_SOURCE = "backend";
    const body = await ready(baseBbs);
    expect(body.scheduleBundle.scheduleTileSource).toBe("backend");
  });

  it("reports 'producer' when PT_SCHEDULE_TILE_SOURCE=producer", async () => {
    process.env.PT_SCHEDULE_TILE_SOURCE = "producer";
    const body = await ready(baseBbs);
    expect(body.scheduleBundle.scheduleTileSource).toBe("producer");
  });

  it("reports 'backend' (safe fallback) for unknown PT_SCHEDULE_TILE_SOURCE values", async () => {
    process.env.PT_SCHEDULE_TILE_SOURCE = "unexpected";
    const body = await ready(baseBbs);
    expect(body.scheduleBundle.scheduleTileSource).toBe("backend");
  });

  it("scheduleTileSource is present on the not-configured path too", async () => {
    process.env.PT_SCHEDULE_TILE_SOURCE = "producer";
    const body = await ready({ configured: false, everBuilt: false, lastBuildStatus: null, lastSuccessMs: null, lastFailureMs: null });
    expect(body.scheduleBundle.scheduleTileSource).toBe("producer");
  });
});

describe("/api/health/ready producer-artifact presence", () => {
  async function readyWithArtifacts(producerArtifacts: any) {
    const app = Fastify();
    app.decorate("gtfsStore", makeStore());
    app.decorate("gtfsScheduler", makeScheduler(baseBbs));
    registerHealthProbes(app, { producerArtifacts });
    const r = await app.inject({ method: "GET", url: "/api/health/ready" });
    await app.close();
    return r.json();
  }

  it("reports presence + loaded SHAs + generationId when both artifacts are present", async () => {
    const body = await readyWithArtifacts({
      artifactsPresent: () => ({ tripRoute: true, stopCell: true }),
      loadedShas: () => ({ tripRoute: "a".repeat(64), stopCell: "b".repeat(64) }),
      loadedGenerationId: () => "c".repeat(64),
    });
    expect(body.tripRouteArtifactPresent).toBe(true);
    expect(body.stopCellArtifactPresent).toBe(true);
    expect(body.tripRouteArtifactSha256).toBe("a".repeat(64));
    expect(body.stopCellArtifactSha256).toBe("b".repeat(64));
    expect(body.loadedGenerationId).toBe("c".repeat(64));
  });

  it("reports false presence + null generationId when an artifact is absent", async () => {
    const body = await readyWithArtifacts({
      artifactsPresent: () => ({ tripRoute: false, stopCell: false }),
      loadedShas: () => ({}),
      loadedGenerationId: () => null,
    });
    expect(body.tripRouteArtifactPresent).toBe(false);
    expect(body.stopCellArtifactPresent).toBe(false);
    expect(body.loadedGenerationId).toBeNull();
  });

  it("omits the presence fields entirely in backend mode (no producerArtifacts wired)", async () => {
    const app = Fastify();
    app.decorate("gtfsStore", makeStore());
    app.decorate("gtfsScheduler", makeScheduler(baseBbs));
    registerHealthProbes(app);
    const r = await app.inject({ method: "GET", url: "/api/health/ready" });
    await app.close();
    const body = r.json();
    expect(body).not.toHaveProperty("tripRouteArtifactPresent");
    expect(body).not.toHaveProperty("stopCellArtifactPresent");
  });
});
