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

// Read one labelled value of pt_bundle_build_total.
async function counterVal(status: string): Promise<number> {
  const json = await metricsRegistry.registry.getMetricsAsJSON();
  const m = json.find((x) => x.name === "pt_bundle_build_total");
  const v = m?.values.find((s) => s.labels?.status === status);
  return (v?.value as number) ?? 0;
}

// Poll until `getter` advances past `baseline` (the build runs fire-and-forget
// in setImmediate). THROW on timeout so a wiring regression fails loudly.
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

describe("scheduler subdivision success-arm observability", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ptn-subdiv-"));
    buildAndPublishBundleMock.mockReset();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("on a subdivided successful publish: records oversizedLeafCount, sets all three gauges + the counter, and warns per cell", async () => {
    // Capturing logger — noopLogger.warn is a no-op and can't be asserted.
    const warn = vi.fn();
    const logger = { ...noopLogger, warn, child: () => logger } as unknown as FastifyBaseLogger;

    buildAndPublishBundleMock.mockImplementation(() => ({
      bundleHash: "h", tilesWritten: 3, janitor: { kept: 1, deleted: 0 },
      subdivisions: { "906_28": { leaves: [
        { suffix: "0", bbox: { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 }, compressedBytes: 999, oversized: true },
        { suffix: "3", bbox: { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 }, compressedBytes: 100, oversized: false },
      ] } },
      stats: { subdividedCells: 1, maxDepth: 2, oversizedLeaves: 1, maxLeafBytes: 999, cellCount: 1 },
    }));
    const s = new GtfsScheduler({
      gtfsUrls: ["https://example.test/feed.zip"], refreshIntervalHours: 24, rtFeedUrls: [],
      cityId: "test", logger, scheduleTileDataDir: dir,
    } as any);

    const successBefore = await counterVal("success");
    (s as any).schedulePublishBundle({}, []);
    await waitForDelta(() => counterVal("success"), successBefore);

    // Health-field state.
    expect(s.bundleBuildState.oversizedLeafCount).toBe(1);

    // Gauge VALUES under the {city:"test"} label (matches the scheduler's cityId).
    const json = await metricsRegistry.registry.getMetricsAsJSON();
    const val = (name: string) => json.find((m) => m.name === name)!.values.find((v) => v.labels.city === "test")!.value;
    expect(val("pt_schedule_tile_oversized_leaves")).toBe(1);
    expect(val("pt_schedule_tile_max_leaf_bytes")).toBe(999);
    expect(val("pt_schedule_tile_leaves_per_bundle")).toBe(3); // tilesWritten

    // Cumulative counter advanced by oversizedLeaves (1).
    expect(val("pt_schedule_tile_oversized_leaf_total")).toBeGreaterThanOrEqual(1);

    // Per-cell warn fired.
    expect(warn).toHaveBeenCalled();
    const warnMsgs = warn.mock.calls.map((c) => c[1] ?? c[0]);
    expect(warnMsgs.some((m) => typeof m === "string" && /subdivid/i.test(m))).toBe(true);
  });
});
