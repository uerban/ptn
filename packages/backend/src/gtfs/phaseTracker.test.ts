import { describe, it, expect } from "vitest";
import { NOOP_TRACKER, createPhaseTracker } from "./phaseTracker.js";

describe("NOOP_TRACKER", () => {
  it("is idempotent and returns empty report", () => {
    NOOP_TRACKER.beginPhase("x");
    NOOP_TRACKER.endPhase();
    NOOP_TRACKER.sample();
    NOOP_TRACKER.beginPhase("y");
    expect(NOOP_TRACKER.getReport()).toEqual([]);
  });

  it("createPhaseTracker is exported", () => {
    // Smoke check: import works, factory callable, returns something.
    // Behavior validated in later tasks.
    const t = createPhaseTracker();
    expect(typeof t.beginPhase).toBe("function");
    expect(typeof t.endPhase).toBe("function");
    expect(typeof t.sample).toBe("function");
    expect(typeof t.getReport).toBe("function");
  });
});

describe("createPhaseTracker — happy path", () => {
  it("records distinct phases in order with positive durations", async () => {
    const t = createPhaseTracker({ sampleIntervalMs: 5 });
    t.beginPhase("A");
    await new Promise((r) => setTimeout(r, 30));
    t.beginPhase("B"); // implicitly ends A

    // Allocate visible chunks so B's peak exceeds pre-B baseline.
    const buf: number[] = [];
    for (let i = 0; i < 100_000; i++) buf.push(i);

    await new Promise((r) => setTimeout(r, 30));
    t.endPhase();

    const report = t.getReport();
    expect(report.map((r) => r.name)).toEqual(["A", "B"]);
    expect(report[0]!.durationMs).toBeGreaterThan(0);
    expect(report[1]!.durationMs).toBeGreaterThan(0);
    expect(report[1]!.peakHeapUsedBytes).toBeGreaterThan(0);
    // heapTotal >= heapUsed always; regression guard against anyone
    // accidentally sampling heapUsed into the heapTotal field.
    expect(report[1]!.peakHeapTotalBytes).toBeGreaterThanOrEqual(report[1]!.peakHeapUsedBytes);
    // external is per-process — always positive on a running Node process.
    expect(report[1]!.peakExternalBytes).toBeGreaterThan(0);
    // rss is per-process; regression guard against someone dropping the
    // `m.rss > current.peakRss` branch.
    expect(report[1]!.peakRssBytes).toBeGreaterThan(0);
    // Touch buf to keep the allocation alive through the assertions.
    expect(buf.length).toBe(100_000);
  });
});

describe("createPhaseTracker — implicit close", () => {
  it("getReport() implicitly closes an active phase", async () => {
    const t = createPhaseTracker({ sampleIntervalMs: 5 });
    t.beginPhase("A");
    await new Promise((r) => setTimeout(r, 10));
    // No explicit endPhase — getReport must still produce a row for A.
    const report = t.getReport();
    expect(report).toHaveLength(1);
    expect(report[0]!.name).toBe("A");
    expect(report[0]!.durationMs).toBeGreaterThan(0);
  });
});

describe("createPhaseTracker — sample()", () => {
  it("sample() is a no-op when no phase is active", () => {
    const t = createPhaseTracker();
    expect(() => t.sample()).not.toThrow();
    expect(t.getReport()).toEqual([]);

    t.beginPhase("A");
    t.endPhase();
    // Between phases: sample is still a no-op, no extra entries.
    expect(() => t.sample()).not.toThrow();
    const report = t.getReport();
    expect(report).toHaveLength(1);
    expect(report[0]!.name).toBe("A");
  });
});

describe("createPhaseTracker — sample() in sync burst", () => {
  it("records peak when called inside a synchronous allocation loop", () => {
    // sampleIntervalMs so large the setInterval sampler effectively never fires
    // for the duration of this test — forcing sample() to be the only path
    // that can record the peak.
    const t = createPhaseTracker({ sampleIntervalMs: 1_000_000 });
    t.beginPhase("synchronous-burst");
    const baseline = process.memoryUsage().heapUsed;

    // Allocate a measurable chunk without yielding.
    const hogs: number[][] = [];
    for (let i = 0; i < 50; i++) {
      hogs.push(new Array(100_000).fill(i));
      t.sample(); // manual sample inside the synchronous loop
    }
    t.endPhase();

    const report = t.getReport();
    expect(report).toHaveLength(1);
    // The peak recorded via sample() must exceed the pre-burst baseline.
    expect(report[0]!.peakHeapUsedBytes).toBeGreaterThan(baseline);
    // Keep hogs live until after the assertions.
    expect(hogs.length).toBe(50);
  });
});

describe("createPhaseTracker — snapshot failure path", () => {
  it("records snapshotError when snapshotDir does not exist, without throwing", () => {
    // Directory name is randomized to avoid colliding with anything on disk.
    const bogusDir = `/tmp/ptn-phase-tracker-missing-${Math.random().toString(36).slice(2)}`;
    const t = createPhaseTracker({ snapshotDir: bogusDir });
    expect(() => {
      t.beginPhase("P");
      t.endPhase();
    }).not.toThrow();
    const [report] = t.getReport();
    expect(report).toBeDefined();
    expect(report!.snapshotPath).toBeUndefined();
    expect(report!.snapshotError).toBeDefined();
    // ENOENT is the expected cause; message format varies across Node versions
    // so match loosely.
    expect(report!.snapshotError).toMatch(/enoent|no such file|cannot open/i);
  });
});

describe("PhaseTracker.checkpoint", () => {
  it("records named checkpoints inside the active phase", () => {
    const tracker = createPhaseTracker({ sampleIntervalMs: 10_000 });
    tracker.beginPhase("build");
    tracker.checkpoint("pass1-end");
    tracker.checkpoint("pass2-start");
    tracker.endPhase();

    const [report] = tracker.getReport();
    expect(report.name).toBe("build");
    expect(report.checkpoints).toBeDefined();
    expect(report.checkpoints!.map((c) => c.label)).toEqual(["pass1-end", "pass2-start"]);
    for (const c of report.checkpoints!) {
      expect(typeof c.atMs).toBe("number");
      expect(typeof c.heapUsedBytes).toBe("number");
      expect(typeof c.rssBytes).toBe("number");
    }
  });

  it("is a no-op outside a phase (no throw, no record)", () => {
    const tracker = createPhaseTracker({ sampleIntervalMs: 10_000 });
    expect(() => tracker.checkpoint("stray")).not.toThrow();
    expect(tracker.getReport()).toEqual([]);
  });

  it("updates peak values when checkpoint samples higher than interval sampler has seen", () => {
    const tracker = createPhaseTracker({ sampleIntervalMs: 10_000 });
    tracker.beginPhase("p");
    const hog: number[][] = [];
    for (let i = 0; i < 1000; i++) hog.push(new Array(1000).fill(i));
    tracker.checkpoint("after-alloc");
    tracker.endPhase();
    const [report] = tracker.getReport();
    hog.length = 0;
    expect(report.peakHeapUsedBytes).toBeGreaterThan(0);
    expect(report.checkpoints![0].heapUsedBytes).toBeGreaterThan(0);
  });
});
