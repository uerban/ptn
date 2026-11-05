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

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
  level: "info" as const, silent: () => {}, child: () => noopLogger,
} as unknown as FastifyBaseLogger;

function makeScheduler(dir: string) {
  return new GtfsScheduler({
    gtfsUrls: ["https://example.test/feed.zip"],
    refreshIntervalHours: 24,
    rtFeedUrls: [],
    cityId: "test", logger: noopLogger, scheduleTileDataDir: dir,
  } as any);
}

const A_BUILD_RESULT = {
  bundleHash: "h", tilesWritten: 1, janitor: { kept: 1, deleted: 0 },
  stats: { subdividedCells: 0, maxDepth: 0, oversizedLeaves: 0, maxLeafBytes: 0, cellCount: 0 },
  subdivisions: {},
};

async function flush(): Promise<void> {
  // The build is dispatched on setImmediate; one tick is enough to observe
  // whether buildAndPublishBundle was invoked (or deliberately skipped).
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe("GtfsScheduler — producer-mode tile-build shed", () => {
  let dir: string;
  const prev = process.env.PT_SCHEDULE_TILE_SOURCE;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ptn-producer-sched-"));
    buildAndPublishBundleMock.mockReset();
    buildAndPublishBundleMock.mockResolvedValue(A_BUILD_RESULT);
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.PT_SCHEDULE_TILE_SOURCE;
    else process.env.PT_SCHEDULE_TILE_SOURCE = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("PT_SCHEDULE_TILE_SOURCE=producer: schedulePublishBundle does NOT build the in-process tile bundle", async () => {
    process.env.PT_SCHEDULE_TILE_SOURCE = "producer";
    const s = makeScheduler(dir);

    (s as any).schedulePublishBundle({ tag: "x" }, []);
    await flush();

    expect(buildAndPublishBundleMock).not.toHaveBeenCalled();
    // The shed is a no-op: it must not wedge the re-entrancy flag.
    expect((s as any)._buildInFlight).toBe(false);
    expect((s as any)._buildPending).toBeNull();
  });

  it("default (backend) mode: schedulePublishBundle still builds the tile bundle exactly once", async () => {
    process.env.PT_SCHEDULE_TILE_SOURCE = "backend";
    const s = makeScheduler(dir);

    (s as any).schedulePublishBundle({ tag: "x" }, []);
    await flush();

    expect(buildAndPublishBundleMock).toHaveBeenCalledTimes(1);
  });

  it("unset PT_SCHEDULE_TILE_SOURCE behaves as backend (builds the tile bundle)", async () => {
    delete process.env.PT_SCHEDULE_TILE_SOURCE;
    const s = makeScheduler(dir);

    (s as any).schedulePublishBundle({ tag: "x" }, []);
    await flush();

    expect(buildAndPublishBundleMock).toHaveBeenCalledTimes(1);
  });
});
