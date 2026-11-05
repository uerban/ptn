/**
 * Per-phase peak-heap instrumentation for loadGtfs. Bench-only:
 * loadGtfs accepts an optional tracker with NOOP_TRACKER as the
 * default so production paths have zero overhead.
 *
 * for the full design rationale.
 */

import { performance } from "node:perf_hooks";
import { writeHeapSnapshot } from "node:v8";

/**
 * A named, timestamped sample captured inside an active phase via
 * `PhaseTracker.checkpoint(label)`. Used to mark sync-tight phase
 * boundaries (e.g. "pass1-end", "pass2-start") so a `PhaseReport` can
 * be diffed across runs.
 */
export interface PhaseCheckpoint {
  readonly label: string;
  /** Milliseconds since the enclosing phase's `beginPhase` call, from `performance.now()`. */
  readonly atMs: number;
  readonly heapUsedBytes: number;
  readonly heapTotalBytes: number;
  readonly externalBytes: number;
  readonly rssBytes: number;
}

export interface PhaseReport {
  name: string;
  durationMs: number;
  /**
   * Peak `process.memoryUsage().heapUsed` — live object graph in V8's heap.
   * Useful for "how much data is actually alive" but NOT the number V8
   * checks against `--max-old-space-size` when it OOMs.
   */
  peakHeapUsedBytes: number;
  /**
   * Peak `process.memoryUsage().heapTotal` — V8's committed heap (old gen +
   * new gen scratch). V8 grows this in chunks for performance; it can be
   * significantly larger than heapUsed. When heapTotal + external tries to
   * exceed `--max-old-space-size`, V8 OOMs. THIS is the number that matters
   * for predicting whether a build fits under the heap ceiling.
   */
  peakHeapTotalBytes: number;
  /**
   * Peak `process.memoryUsage().external` — off-heap memory V8 tracks
   * (ArrayBuffer backing stores, Buffers, some native-module allocations).
   * Counts against `--max-old-space-size` via
   * `AdjustAmountOfExternalAllocatedMemory`. Relevant here because
   * `Uint32Array` backing stores live in external, not heapTotal.
   */
  peakExternalBytes: number;
  /** Peak `process.memoryUsage().rss` — total resident set size of the process. */
  peakRssBytes: number;
  /**
   * Named checkpoints captured within this phase via `checkpoint(label)`,
   * in call order. Omitted when no checkpoints were recorded so that the
   * report shape stays minimal for phases that don't opt in.
   */
  checkpoints?: readonly PhaseCheckpoint[];
  snapshotPath?: string;
  snapshotError?: string;
}

export interface PhaseTracker {
  /**
   * Start a new phase. If another phase is active, it is closed first
   * and its report is appended to the array returned by getReport().
   */
  beginPhase(name: string): void;

  /** Close the current phase. Idempotent — no-op if no phase is active. */
  endPhase(): void;

  /**
   * Take one manual heap sample. Useful inside a synchronous hot loop
   * where the setInterval sampler may not fire. No-op if no phase active.
   */
  sample(): void;

  /**
   * Record a named sync-tight sample at a phase boundary. No-op outside
   * an active phase. Updates peak counters like `sample()` and also
   * appends a `PhaseCheckpoint` to the current phase's report so
   * boundary points (e.g. end of Pass 1, start of Pass 2) can be diffed
   * across runs.
   */
  checkpoint(label: string): void;

  /**
   * Return the completed phase reports. Implicitly closes any active phase
   * and stops the internal sampling timer.
   *
   * The `readonly` return type prevents callers from mutating the array
   * (no `.push()`, `.splice()`, etc.). It does NOT mean the contents are
   * immutable from the tracker's perspective: the tracker retains the same
   * array internally and WILL append to it if beginPhase is called after
   * getReport (see re-entry below). Copy with `[...report]` if a stable
   * snapshot is needed.
   *
   * Re-entry: calling beginPhase after getReport is supported. The sampling
   * timer is re-created, and the new phase is appended to the same report
   * array already returned.
   */
  getReport(): readonly PhaseReport[];
}

export interface PhaseTrackerOptions {
  /** Heap sampling interval in milliseconds. Default 50. */
  sampleIntervalMs?: number;

  /**
   * If set, every endPhase writes a v8 heap snapshot into this directory
   * named `${index}-${sanitized-phase-name}.heapsnapshot`. The directory
   * must exist beforehand; this module does not create it. If the write
   * fails (missing directory, permission denied, etc.), the error message
   * is recorded on `PhaseReport.snapshotError` and the build continues —
   * snapshot failures never abort the caller.
   */
  snapshotDir?: string;
}

const NOOP: PhaseTracker = {
  beginPhase() {},
  endPhase() {},
  sample() {},
  checkpoint() {},
  getReport() { return []; },
};

/**
 * Shared no-op tracker used as the default when no instrumentation is
 * requested. Zero allocations, zero timers.
 */
export const NOOP_TRACKER: PhaseTracker = NOOP;

export function createPhaseTracker(opts: PhaseTrackerOptions = {}): PhaseTracker {
  const interval = opts.sampleIntervalMs ?? 50;
  const reports: PhaseReport[] = [];
  let current: {
    name: string;
    startMs: number;
    peakHeapUsed: number;
    peakHeapTotal: number;
    peakExternal: number;
    peakRss: number;
    checkpoints: PhaseCheckpoint[];
  } | null = null;
  let timer: NodeJS.Timeout | null = null;

  function sampleOnce(): void {
    if (!current) return;
    try {
      const m = process.memoryUsage();
      if (m.heapUsed > current.peakHeapUsed) current.peakHeapUsed = m.heapUsed;
      if (m.heapTotal > current.peakHeapTotal) current.peakHeapTotal = m.heapTotal;
      if (m.external > current.peakExternal) current.peakExternal = m.external;
      if (m.rss > current.peakRss) current.peakRss = m.rss;
    } catch {
      // process.memoryUsage() is normally safe but can throw under unusual
      // runtime states (worker-thread teardown, OOM). This is called from
      // setInterval; a throw here would surface as uncaughtException and
      // kill the whole process. Swallow silently — a missed sample is
      // strictly better than a crashed bench.
    }
  }

  function stopTimer(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function closeCurrentPhase(): void {
    if (!current) return;
    sampleOnce(); // capture a final sample before computing the report
    const report: PhaseReport = {
      name: current.name,
      durationMs: performance.now() - current.startMs,
      peakHeapUsedBytes: current.peakHeapUsed,
      peakHeapTotalBytes: current.peakHeapTotal,
      peakExternalBytes: current.peakExternal,
      peakRssBytes: current.peakRss,
    };
    if (current.checkpoints.length > 0) {
      // Only attach checkpoints when the caller actually recorded some,
      // so phases that never call checkpoint() keep a minimal report shape.
      report.checkpoints = current.checkpoints;
    }
    if (opts.snapshotDir) {
      const safe = current.name.replace(/[^a-z0-9_-]/gi, "_");
      const path = `${opts.snapshotDir}/${reports.length}-${safe}.heapsnapshot`;
      try {
        writeHeapSnapshot(path);
        report.snapshotPath = path;
      } catch (err) {
        report.snapshotError = err instanceof Error ? err.message : String(err);
      }
    }
    reports.push(report);
    current = null;
    // Stop the interval when no phase is active. A subsequent beginPhase
    // will recreate it. Prevents the sampler from firing indefinitely if
    // the caller never reaches getReport().
    stopTimer();
  }

  return {
    beginPhase(name: string): void {
      closeCurrentPhase();
      const m0 = process.memoryUsage();
      current = {
        name,
        startMs: performance.now(),
        peakHeapUsed: m0.heapUsed,
        peakHeapTotal: m0.heapTotal,
        peakExternal: m0.external,
        peakRss: m0.rss,
        checkpoints: [],
      };
      timer = setInterval(sampleOnce, interval);
      timer.unref();
    },
    endPhase(): void {
      closeCurrentPhase();
    },
    sample(): void {
      sampleOnce();
    },
    checkpoint(label: string): void {
      if (!current) return;
      try {
        // Single process.memoryUsage() call so the peak counters and the
        // recorded checkpoint values come from the exact same instant. V8
        // can run incremental GC between calls, so two reads could diverge.
        const m = process.memoryUsage();
        if (m.heapUsed > current.peakHeapUsed) current.peakHeapUsed = m.heapUsed;
        if (m.heapTotal > current.peakHeapTotal) current.peakHeapTotal = m.heapTotal;
        if (m.external > current.peakExternal) current.peakExternal = m.external;
        if (m.rss > current.peakRss) current.peakRss = m.rss;
        current.checkpoints.push({
          label,
          atMs: performance.now() - current.startMs,
          heapUsedBytes: m.heapUsed,
          heapTotalBytes: m.heapTotal,
          externalBytes: m.external,
          rssBytes: m.rss,
        });
      } catch {
        // process.memoryUsage() can throw under unusual runtime states
        // (worker-thread teardown, OOM). Swallow silently — a missed
        // checkpoint is strictly better than a crashed bench.
      }
    },
    getReport(): readonly PhaseReport[] {
      closeCurrentPhase();
      stopTimer(); // belt-and-suspenders; closeCurrentPhase already stopped it
      return reports;
    },
  };
}
