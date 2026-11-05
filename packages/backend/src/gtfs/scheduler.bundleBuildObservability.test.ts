import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyBaseLogger } from "fastify";

const { buildAndPublishBundleMock } = vi.hoisted(() => ({
  buildAndPublishBundleMock: vi.fn(),
}));
vi.mock("./buildAndPublishBundle.js", () => ({ buildAndPublishBundle: buildAndPublishBundleMock }));

import { GtfsScheduler } from "./scheduler.js";
import { metricsRegistry } from "../metrics/registry.js";

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
  level: "info" as const, silent: () => {}, child: () => noopLogger,
} as unknown as FastifyBaseLogger;

const OVER_CAP = new Error("scheduleTileBrotli: tile exceeds MAX_COMPRESSED_TILE_BYTES (3402207 > 2097152; 62% over).");

function makeScheduler(dir: string) {
  return new GtfsScheduler({
    gtfsUrls: ["https://example.test/feed.zip"],
    refreshIntervalHours: 24,
    rtFeedUrls: [],
    cityId: "test", logger: noopLogger, scheduleTileDataDir: dir,
  } as any);
}

// Read one labelled value of pt_bundle_build_total.
async function counterVal(status: string): Promise<number> {
  const json = await metricsRegistry.registry.getMetricsAsJSON();
  const m = json.find((x) => x.name === "pt_bundle_build_total");
  const v = m?.values.find((s) => s.labels?.status === status);
  return (v?.value as number) ?? 0;
}

// Read a label-free gauge value.
async function gaugeVal(name: string): Promise<number> {
  const json = await metricsRegistry.registry.getMetricsAsJSON();
  const m = json.find((x) => x.name === name);
  return (m?.values[0]?.value as number) ?? 0;
}

// Poll until `getter` advances past `baseline` (the build runs fire-and-forget
// in setImmediate). THROW on timeout so a wiring regression that never advances
// the counter fails loudly instead of silently returning a stale value.
async function waitForDelta(getter: () => Promise<number>, baseline: number, ms = 3000): Promise<number> {
  const start = Date.now();
  for (;;) {
    const cur = await getter();
    if (cur > baseline) return cur;
    if (Date.now() - start > ms) {
      throw new Error(`waitForDelta: value did not advance past ${baseline} within ${ms}ms (last ${cur})`);
    }
    await new Promise((r) => setImmediate(r));
  }
}

describe("scheduler over-cap build failure → observability wiring", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ptn-overcap-"));
    buildAndPublishBundleMock.mockReset();
    // metricsRegistry is a module-level singleton; reset the gauges this file
    // asserts on so a prior test (or another file, if vitest isolation is off)
    // can't mask a never-advanced assertion.
    metricsRegistry.bundleEverBuilt.set(0);
    metricsRegistry.bundleLastSuccessTimestampSeconds.set(0);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("never-built failure increments the failure counter and advances NEITHER the ever_built nor the staleness gauge", async () => {
    buildAndPublishBundleMock.mockImplementation(() => { throw OVER_CAP; });
    const s = makeScheduler(dir);
    const failBefore = await counterVal("failure");
    const everBefore = await gaugeVal("pt_bundle_ever_built");                 // 0
    const lastBefore = await gaugeVal("pt_bundle_last_success_timestamp_seconds"); // 0

    (s as any).schedulePublishBundle({}, []);
    const failAfter = await waitForDelta(() => counterVal("failure"), failBefore);

    expect(failAfter).toBe(failBefore + 1);
    expect(s.bundleBuildState).toMatchObject({ everBuilt: false, lastBuildStatus: "failure" });
    // The failure arm must NOT touch the success-path gauges (else "never built"
    // would read as built/fresh — the exact silent regression B5 guards).
    expect(await gaugeVal("pt_bundle_ever_built")).toBe(everBefore);
    expect(await gaugeVal("pt_bundle_last_success_timestamp_seconds")).toBe(lastBefore);
  });

  it("success arm wires ever_built=1 + advances last-success; a later refresh failure leaves both intact (built-then-failed)", async () => {
    buildAndPublishBundleMock.mockImplementation(() => ({ bundleHash: "h", tilesWritten: 1, janitor: { kept: 1, deleted: 0 }, stats: { subdividedCells: 0, maxDepth: 0, oversizedLeaves: 0, maxLeafBytes: 0, cellCount: 0 }, subdivisions: {} }));
    const s = makeScheduler(dir);
    const successBefore = await counterVal("success");

    (s as any).schedulePublishBundle({}, []);
    const successAfter = await waitForDelta(() => counterVal("success"), successBefore);

    expect(successAfter).toBe(successBefore + 1);
    expect(s.bundleBuildState.everBuilt).toBe(true);
    expect(await gaugeVal("pt_bundle_ever_built")).toBe(1);
    const lastAfterSuccess = await gaugeVal("pt_bundle_last_success_timestamp_seconds");
    expect(lastAfterSuccess).toBeGreaterThan(0);

    // Refresh-time failure after a prior success: a valid prior bundle still
    // serves, so this is NOT `failing`; ever_built stays 1 and staleness is frozen.
    const failBefore = await counterVal("failure");
    buildAndPublishBundleMock.mockImplementation(() => { throw OVER_CAP; });
    (s as any).schedulePublishBundle({}, []);
    await waitForDelta(() => counterVal("failure"), failBefore);

    expect(s.bundleBuildState).toMatchObject({ everBuilt: true, lastBuildStatus: "failure" });
    expect(await gaugeVal("pt_bundle_ever_built")).toBe(1);
    expect(await gaugeVal("pt_bundle_last_success_timestamp_seconds")).toBe(lastAfterSuccess);
  });
});
