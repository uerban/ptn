import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GtfsScheduler } from "./scheduler.js";
import { metricsRegistry } from "../metrics/registry.js";
import type { FastifyBaseLogger } from "fastify";

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
  level: "info" as const, silent: () => {}, child: () => noopLogger,
} as unknown as FastifyBaseLogger;

function makeScheduler(scheduleTileDataDir?: string) {
  // Non-empty gtfsUrls so the fail-closed construction guard (scheduler.ts:89:
  // `gtfsUrls.length === 0 && !ptnBundlePath` throws) passes. init()/loadOnce()
  // are never called here, so nothing is fetched — these are pure-state tests.
  // refreshIntervalHours + rtFeedUrls are required SchedulerOptions fields.
  return new GtfsScheduler({
    gtfsUrls: ["https://example.test/feed.zip"],
    refreshIntervalHours: 24,
    rtFeedUrls: [],
    cityId: "test", logger: noopLogger,
    scheduleTileDataDir,
  } as any);
}

describe("GtfsScheduler.bundleBuildState", () => {
  it("never built: everBuilt=false, lastBuildStatus=null, configured reflects dir", () => {
    const s = makeScheduler("/tmp/does-not-matter");
    expect(s.bundleBuildState).toMatchObject({ configured: true, everBuilt: false, lastBuildStatus: null, lastSuccessMs: null });
  });

  it("configured=false when no scheduleTileDataDir", () => {
    const s = makeScheduler(undefined);
    expect(s.bundleBuildState.configured).toBe(false);
  });

  it("hydrate from a manifest with positive generatedAt sets everBuilt + ever_built gauge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ptn-bundlestate-"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ bundleHash: "abc", generatedAt: 1_700_000_000_000 }));
    const s = makeScheduler(dir);
    s.hydrateBundleLastSuccessGauge();
    expect(s.bundleBuildState).toMatchObject({ everBuilt: true, lastSuccessMs: 1_700_000_000_000 });
    const json = await metricsRegistry.registry.getMetricsAsJSON();
    const everBuilt = json.find((m) => m.name === "pt_bundle_ever_built");
    expect(everBuilt).toBeDefined();
    expect(everBuilt!.values.some((v) => v.value === 1)).toBe(true);
  });

  it("hydrate is a no-op when manifest generatedAt is 0/missing (stays never-built)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ptn-bundlestate-"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ bundleHash: "abc", generatedAt: 0 }));
    const s = makeScheduler(dir);
    s.hydrateBundleLastSuccessGauge();
    expect(s.bundleBuildState.everBuilt).toBe(false);
  });

  it("hydrate rehydrates the oversized-leaf degradation signal from manifest.subdivisions (cold-start degraded)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ptn-bundlestate-"));
    // A manifest with one subdivided cell: 2 leaves, 1 oversized, max 5000 bytes.
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      schemaVersion: 1, bundleHash: "abc", generatedAt: 1_700_000_000_000, tileSize: 6000,
      subdivisions: {
        "906_28": { leaves: [
          { suffix: "0", bbox: { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 }, compressedBytes: 5000, oversized: true },
          { suffix: "3", bbox: { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 }, compressedBytes: 100, oversized: false },
        ] },
      },
    }));
    const s = makeScheduler(dir); // makeScheduler passes cityId: "test"
    s.hydrateBundleLastSuccessGauge();
    expect(s.bundleBuildState.oversizedLeafCount).toBe(1);
    // Only the degradation signal (oversized count) is rehydrated; the trend
    // gauges (max_leaf_bytes / leaves_per_bundle) are build-measured and not
    // reconstructable from the subdivisions-only manifest, so they are NOT set here.
    const json = await metricsRegistry.registry.getMetricsAsJSON();
    const oversized = json.find((m) => m.name === "pt_schedule_tile_oversized_leaves");
    expect(oversized!.values.find((v) => v.labels.city === "test")!.value).toBe(1);
  });
});
