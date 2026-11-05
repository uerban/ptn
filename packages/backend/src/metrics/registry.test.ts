import { describe, it, expect } from "vitest";
import { createMetricsRegistry, metricsRegistry } from "./registry.js";

describe("metricsRegistry", () => {
  it("exposes prom-format output via registry.metrics()", async () => {
    metricsRegistry.scheduleTileRequestTotal.inc({ status: "200" });
    const text = await metricsRegistry.registry.metrics();
    expect(text).toContain("pt_schedule_tile_request_total");
  });

  it("emitTelemetry routes each allowlisted event to its named counter", async () => {
    metricsRegistry.emitTelemetry({ event: "absurd_countdown", value: 1 });
    metricsRegistry.emitTelemetry({ event: "sanity_clamp", value: 3 });
    const json = await metricsRegistry.registry.getMetricsAsJSON();
    expect(json.find((m) => m.name === "pt_absurd_countdown_total")).toBeDefined();
    expect(json.find((m) => m.name === "pt_sanity_clamp_total")).toBeDefined();
  });

  it("httpRequestDurationSeconds records observations under method/route/status_code", async () => {
    metricsRegistry.httpRequestDurationSeconds.observe(
      { method: "GET", route: "/api/plan", status_code: "200" },
      0.042,
    );
    const json = await metricsRegistry.registry.getMetricsAsJSON();
    const m = json.find((x) => x.name === "pt_http_request_duration_seconds");
    expect(m).toBeDefined();
    // Sample with all three labels populated should be present.
    const labelled = m!.values.find(
      (v) =>
        v.labels?.method === "GET" &&
        v.labels?.route === "/api/plan" &&
        v.labels?.status_code === "200",
    );
    expect(labelled).toBeDefined();
  });

  it("bundleBuildDurationSeconds records observations under status", async () => {
    metricsRegistry.bundleBuildDurationSeconds.observe({ status: "success" }, 12.5);
    metricsRegistry.bundleBuildDurationSeconds.observe({ status: "failure" }, 3.2);
    const json = await metricsRegistry.registry.getMetricsAsJSON();
    const m = json.find((x) => x.name === "pt_bundle_build_duration_seconds");
    expect(m).toBeDefined();
    const labels = new Set(m!.values.map((v) => v.labels?.status).filter(Boolean));
    expect(labels.has("success")).toBe(true);
    expect(labels.has("failure")).toBe(true);
  });

  it("compressedTileBytes records observations across the bucket range", async () => {
    metricsRegistry.compressedTileBytes.observe(50_000); // small cell
    metricsRegistry.compressedTileBytes.observe(1_400_000); // near-cap
    const json = await metricsRegistry.registry.getMetricsAsJSON();
    const m = json.find((x) => x.name === "pt_compressed_tile_bytes");
    expect(m).toBeDefined();
  });

  it("metricsSidecarUp gauge defaults to 0 (sidecar hasn't bound yet)", async () => {
    // Use a fresh registry — the singleton may have been flipped to 1 by an
    // earlier test in the same suite that exercises startMetricsServer.
    const fresh = createMetricsRegistry();
    const json = await fresh.registry.getMetricsAsJSON();
    const m = json.find((x) => x.name === "pt_metrics_sidecar_up");
    expect(m).toBeDefined();
    expect(m!.values[0]?.value).toBe(0);
  });

  it("emits pt_bundle_ever_built with no city label", async () => {
    metricsRegistry.bundleEverBuilt.set(1);
    const json = await metricsRegistry.registry.getMetricsAsJSON();
    const m = json.find((x) => x.name === "pt_bundle_ever_built");
    expect(m).toBeDefined();
    for (const v of m!.values) {
      expect(v.labels).not.toHaveProperty("city");
    }
  });

  it("pt_bundle_ever_built defaults to 0 (never-built) on a fresh registry", async () => {
    const reg = createMetricsRegistry();
    const json = await reg.registry.getMetricsAsJSON();
    const m = json.find((x) => x.name === "pt_bundle_ever_built");
    expect(m).toBeDefined();
    expect(m!.values[0]?.value).toBe(0);
  });

  it("pt_schedule_tile_source reports source=\"producer\" when PT_SCHEDULE_TILE_SOURCE=producer", async () => {
    const prev = process.env.PT_SCHEDULE_TILE_SOURCE;
    process.env.PT_SCHEDULE_TILE_SOURCE = "producer";
    try {
      // A fresh registry reads the env at construction time, like the singleton
      // does at process start.
      const reg = createMetricsRegistry();
      const json = await reg.registry.getMetricsAsJSON();
      const m = json.find((x) => x.name === "pt_schedule_tile_source");
      expect(m).toBeDefined();
      const v = m!.values.find((x) => x.labels?.source === "producer");
      expect(v).toBeDefined();
      expect(v!.value).toBe(1);
      // Only the producer series is present — no stray backend series.
      expect(m!.values.some((x) => x.labels?.source === "backend")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.PT_SCHEDULE_TILE_SOURCE;
      else process.env.PT_SCHEDULE_TILE_SOURCE = prev;
    }
  });

  it("pt_schedule_tile_source defaults to source=\"backend\" when the env is unset or other", async () => {
    const prev = process.env.PT_SCHEDULE_TILE_SOURCE;
    delete process.env.PT_SCHEDULE_TILE_SOURCE;
    try {
      const reg = createMetricsRegistry();
      const json = await reg.registry.getMetricsAsJSON();
      const m = json.find((x) => x.name === "pt_schedule_tile_source");
      expect(m).toBeDefined();
      const v = m!.values.find((x) => x.labels?.source === "backend");
      expect(v).toBeDefined();
      expect(v!.value).toBe(1);
      expect(m!.values.some((x) => x.labels?.source === "producer")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.PT_SCHEDULE_TILE_SOURCE;
      else process.env.PT_SCHEDULE_TILE_SOURCE = prev;
    }
  });

  it("emits pt_bundle_build_coalesced_total", async () => {
    metricsRegistry.bundleBuildCoalescedTotal.inc();
    expect(await metricsRegistry.registry.metrics()).toContain("pt_bundle_build_coalesced_total");
  });

  it("scheduleTile404Total exposes exactly the {subdivided, not_found} reasons", async () => {
    const reg = createMetricsRegistry();
    reg.scheduleTile404Total.inc({ reason: "subdivided" });
    reg.scheduleTile404Total.inc({ reason: "not_found" });
    const metrics = await reg.registry.metrics();
    expect(metrics).toContain('pt_schedule_tile_404_total{reason="subdivided"} 1');
    expect(metrics).toContain('pt_schedule_tile_404_total{reason="not_found"} 1');
  });

  it("scheduleTileRequestTotal label shape is unchanged (status only)", () => {
    const reg = createMetricsRegistry();
    expect(() => reg.scheduleTileRequestTotal.inc({ status: "200" })).not.toThrow();
  });

  it("pt_producer_artifact_served_total has the bounded {artifact, result} label space", async () => {
    const reg = createMetricsRegistry();
    reg.producerArtifactServedTotal.inc({ artifact: "trip_route", result: "served" });
    reg.producerArtifactServedTotal.inc({ artifact: "trip_route", result: "fallback" });
    reg.producerArtifactServedTotal.inc({ artifact: "stop_cell", result: "served" });
    reg.producerArtifactServedTotal.inc({ artifact: "stop_cell", result: "fallback" });
    const text = await reg.registry.metrics();
    expect(text).toContain('pt_producer_artifact_served_total{artifact="trip_route",result="served"} 1');
    expect(text).toContain('pt_producer_artifact_served_total{artifact="trip_route",result="fallback"} 1');
    expect(text).toContain('pt_producer_artifact_served_total{artifact="stop_cell",result="served"} 1');
    expect(text).toContain('pt_producer_artifact_served_total{artifact="stop_cell",result="fallback"} 1');
  });
});
