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

// A controllable deferred: the mock blocks until `release()` is called, while
// tracking concurrent in-flight count (entry ++, exit --).
function makeDeferredMock() {
  let peak = 0;
  let active = 0;
  const releasers: (() => void)[] = [];
  buildAndPublishBundleMock.mockImplementation(() => {
    active++;
    peak = Math.max(peak, active);
    return new Promise((resolve) => {
      releasers.push(() => { active--; resolve({ bundleHash: "h", tilesWritten: 1, janitor: { kept: 1, deleted: 0 }, stats: { subdividedCells: 0, maxDepth: 0, oversizedLeaves: 0, maxLeafBytes: 0, cellCount: 0 }, subdivisions: {} }); });
    });
  });
  return {
    get peak() { return peak; },
    get pending() { return releasers.length; },
    get active() { return active; },
    releaseOne() { releasers.shift()?.(); },
    releaseAll() { while (releasers.length) releasers.shift()?.(); },
  };
}

// Drain every build to completion: each release may re-dispatch a coalesced
// follow-up (its own setImmediate + mock call), so poll until no build is in
// flight and no releaser is queued.
async function drainBuilds(d: ReturnType<typeof makeDeferredMock>, s: GtfsScheduler): Promise<void> {
  for (let i = 0; i < 100; i++) {
    d.releaseAll();
    await new Promise((r) => setImmediate(r));
    if (!(s as any)._buildInFlight && d.pending === 0) return;
  }
  throw new Error("drainBuilds: builds did not settle");
}

async function counterVal(name: string, label?: { key: string; value: string }): Promise<number> {
  const json = await metricsRegistry.registry.getMetricsAsJSON();
  const m = json.find((x) => x.name === name);
  if (!m) return 0;
  if (!label) return (m.values[0]?.value as number) ?? 0;
  const v = m.values.find((s) => s.labels?.[label.key] === label.value);
  return (v?.value as number) ?? 0;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > ms) throw new Error(`waitFor: predicate did not become true within ${ms}ms`);
    await new Promise((r) => setImmediate(r));
  }
}

describe("GtfsScheduler async-build concurrency / lifecycle", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ptn-asyncbuild-"));
    buildAndPublishBundleMock.mockReset();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("single-flight: two same-tick triggers never run concurrently (peak === 1) and coalesce to one follow-up", async () => {
    const d = makeDeferredMock();
    const s = makeScheduler(dir);

    // Two calls in the SAME synchronous tick (no flush between).
    (s as any).schedulePublishBundle({ tag: "first" }, []);
    (s as any).schedulePublishBundle({ tag: "second" }, []);

    // The first build is in flight; the second was coalesced (not started).
    await waitFor(() => d.pending === 1);
    expect(d.peak).toBe(1);
    expect((s as any)._buildPending).not.toBeNull();

    // Release the in-flight build → the coalesced build drains.
    d.releaseOne();
    await waitFor(() => d.pending === 1);
    expect(d.peak).toBe(1);
    // The follow-up carried the LATEST args.
    expect(buildAndPublishBundleMock.mock.calls[1]![0].canonical).toMatchObject({ tag: "second" });

    await drainBuilds(d, s);
  });

  it("the same-tick coalesced call increments pt_bundle_build_coalesced_total", async () => {
    const d = makeDeferredMock();
    const s = makeScheduler(dir);
    const before = await counterVal("pt_bundle_build_coalesced_total");

    (s as any).schedulePublishBundle({}, []);
    (s as any).schedulePublishBundle({}, []);

    await waitFor(() => d.pending === 1);
    expect(await counterVal("pt_bundle_build_coalesced_total")).toBe(before + 1);

    await drainBuilds(d, s);
  });

  it("a throw from the success-arm still releases _buildInFlight and drains a queued pending", async () => {
    // First build resolves; the success-arm metric write throws ONCE. The
    // finally must still release the flag and drain the coalesced build.
    buildAndPublishBundleMock
      .mockResolvedValueOnce({ bundleHash: "h", tilesWritten: 1, janitor: { kept: 1, deleted: 0 }, stats: { subdividedCells: 0, maxDepth: 0, oversizedLeaves: 0, maxLeafBytes: 0, cellCount: 0 }, subdivisions: {} })
      .mockResolvedValueOnce({ bundleHash: "h2", tilesWritten: 1, janitor: { kept: 1, deleted: 0 }, stats: { subdividedCells: 0, maxDepth: 0, oversizedLeaves: 0, maxLeafBytes: 0, cellCount: 0 }, subdivisions: {} });
    const spy = vi.spyOn(metricsRegistry.bundleBuildTotal, "inc").mockImplementationOnce(() => {
      throw new Error("boom in success arm");
    });

    const s = makeScheduler(dir);
    (s as any).schedulePublishBundle({ tag: "a" }, []);
    (s as any).schedulePublishBundle({ tag: "b" }, []);

    // Both builds eventually run (the second drained after the throw), and the
    // flag is released.
    await waitFor(() => buildAndPublishBundleMock.mock.calls.length === 2);
    await waitFor(() => (s as any)._buildInFlight === false);
    expect((s as any)._buildPending).toBeNull();
    spy.mockRestore();
  });

  it("a build queued during a FAILING build runs after, fires the failure arm (failure delta +2), no unhandled rejection", async () => {
    buildAndPublishBundleMock.mockRejectedValue(OVER_CAP);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);

    const failBefore = await counterVal("pt_bundle_build_total", { key: "status", value: "failure" });
    const s = makeScheduler(dir);
    (s as any).schedulePublishBundle({}, []);
    (s as any).schedulePublishBundle({}, []);

    await waitFor(async () =>
      (await counterVal("pt_bundle_build_total", { key: "status", value: "failure" })) >= failBefore + 2,
    );
    await waitFor(() => (s as any)._buildInFlight === false);

    // Let any stray microtasks settle, then assert zero unhandled rejections.
    await new Promise((r) => setImmediate(r));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it("unhandled-rejection: a rejecting build + coalesced rejecting build produce zero unhandled rejections", async () => {
    buildAndPublishBundleMock.mockRejectedValue(OVER_CAP);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);

    const s = makeScheduler(dir);
    (s as any).schedulePublishBundle({}, []);
    (s as any).schedulePublishBundle({}, []);

    await waitFor(() => buildAndPublishBundleMock.mock.calls.length === 2);
    await waitFor(() => (s as any)._buildInFlight === false);
    await new Promise((r) => setImmediate(r));

    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it("shutdown: after stop() no new/coalesced build starts; an in-flight build still resolves", async () => {
    const d = makeDeferredMock();
    const s = makeScheduler(dir);

    // Start one build, then queue a second (coalesced).
    (s as any).schedulePublishBundle({}, []);
    (s as any).schedulePublishBundle({}, []);
    await waitFor(() => d.pending === 1);
    expect((s as any)._buildPending).not.toBeNull();

    // Stop while a build is in flight.
    s.stop();
    expect((s as any)._stopped).toBe(true);

    // A new trigger after stop() starts nothing.
    const callsBefore = buildAndPublishBundleMock.mock.calls.length;
    (s as any).schedulePublishBundle({}, []);
    expect(buildAndPublishBundleMock.mock.calls.length).toBe(callsBefore);

    // The in-flight build still resolves its atomic swap, but the coalesced
    // follow-up is dropped (no new build launches).
    d.releaseAll();
    await waitFor(() => (s as any)._buildInFlight === false);
    expect(buildAndPublishBundleMock.mock.calls.length).toBe(callsBefore);
    expect((s as any)._buildPending).toBeNull();
  });

  it("stop() in the same tick as a trigger aborts the GATED-but-not-started build (no build, no snapshot)", async () => {
    // Distinct from the shutdown test above (which stops an ALREADY in-flight
    // build): here stop() lands AFTER the sync gate set _buildInFlight=true and
    // queued the setImmediate, but BEFORE that callback runs. The callback's
    // _stopped prologue check must abort before snapshotting or building — else
    // a "stopped" scheduler still spins up one full build + mutates the bundle dir.
    buildAndPublishBundleMock.mockResolvedValue({ bundleHash: "h", tilesWritten: 1, janitor: { kept: 1, deleted: 0 }, stats: { subdividedCells: 0, maxDepth: 0, oversizedLeaves: 0, maxLeafBytes: 0, cellCount: 0 }, subdivisions: {} });
    const s = makeScheduler(dir);
    const snapSpy = vi.spyOn((s as any).store, "snapshotRouteResolvers");

    (s as any).schedulePublishBundle({}, []);
    expect((s as any)._buildInFlight).toBe(true); // gated synchronously
    s.stop(); // same tick, before the queued setImmediate fires

    // Let the queued setImmediate (and any follow-up) run.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(buildAndPublishBundleMock).not.toHaveBeenCalled();
    expect(snapSpy).not.toHaveBeenCalled();
    expect((s as any)._buildInFlight).toBe(false); // released by the early abort
    expect((s as any)._buildPending).toBeNull();
  });

  it("snapshots resolvers in the build setImmediate PROLOGUE, not at dispatch", async () => {
    buildAndPublishBundleMock.mockResolvedValue({ bundleHash: "h", tilesWritten: 1, janitor: { kept: 1, deleted: 0 }, stats: { subdividedCells: 0, maxDepth: 0, oversizedLeaves: 0, maxLeafBytes: 0, cellCount: 0 }, subdivisions: {} });
    const s = makeScheduler(dir);
    const snapSpy = vi.spyOn((s as any).store, "snapshotRouteResolvers");

    (s as any).schedulePublishBundle({}, []);
    // Dispatch is synchronous; the snapshot must NOT be taken yet. It must run
    // in the build's own setImmediate prologue instead, so each coalesced
    // re-dispatch snapshots its own build's current resolvers rather than one
    // snapshot shared across several coalesced dispatches (see the next test).
    expect(snapSpy).not.toHaveBeenCalled();

    await waitFor(() => (s as any)._buildInFlight === false);
    expect(snapSpy).toHaveBeenCalledTimes(1);
  });

  it("re-snapshots for each coalesced re-dispatched build (per-build generation)", async () => {
    const d = makeDeferredMock();
    const s = makeScheduler(dir);
    const snapSpy = vi.spyOn((s as any).store, "snapshotRouteResolvers");

    (s as any).schedulePublishBundle({ tag: "first" }, []);   // build 1
    (s as any).schedulePublishBundle({ tag: "second" }, []);  // coalesced -> build 2
    await drainBuilds(d, s);

    // One snapshot per executed build (build 1 + the coalesced re-dispatch).
    // Resolvers are intentionally NOT carried in the coalesce slot: snapshotting at
    // the coalesce point (dispatch) would read empty maps; each build snapshots its
    // own generation in its prologue instead.
    expect(snapSpy).toHaveBeenCalledTimes(2);
  });
});
