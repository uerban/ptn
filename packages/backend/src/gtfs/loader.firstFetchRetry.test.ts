import { describe, it, expect, vi, afterEach } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { GtfsScheduler } from "./scheduler.js";

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
  level: "info" as const, silent: () => {},
  child: () => noopLogger,
} as unknown as FastifyBaseLogger;

describe("GtfsScheduler cold-start fast-retry", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("caps cold-start retry delay at 30s on every attempt (was 5s,15s,30s,60s,120s,300s)", async () => {
    vi.useFakeTimers();
    const delaysSeen: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      delaysSeen.push(timeout ?? 0);
      return (realSetTimeout as (...a: unknown[]) => ReturnType<typeof setTimeout>)(handler, timeout, ...args);
    }) as unknown as typeof setTimeout);

    const scheduler = new GtfsScheduler({
      gtfsUrls: ["https://127.0.0.1:1/never-resolves.zip"],
      refreshIntervalHours: 24,
      logger: noopLogger,
      rtFeedUrls: [],
    });

    await scheduler.init();

    // Drive 8 retries forward; each tick fails, schedules a new setTimeout.
    // 30 s × 8 covers any timer the cap allows, plus a healthy margin so the
    // last attempts (originally 60s/120s/300s) actually elapse under fake time.
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    scheduler.stop();

    // Filter to retry delays (drop the init `setTimeout(0)` Promise plumbing
    // vitest itself uses and any 0-duration timers from fastify hooks).
    const retryDelays = delaysSeen.filter((d) => d >= 1000);

    // Sanity floor: we should have observed at least 5 retries.
    expect(retryDelays.length).toBeGreaterThanOrEqual(5);

    // Every retry delay must be capped at 30s. Pre-fix this would have produced
    // 60_000, 120_000, 300_000 from INIT_RETRY_DELAYS_MS for attempts 4-6.
    for (const d of retryDelays) {
      expect(d).toBeLessThanOrEqual(30_000);
    }

    // Specifically check attempts 4 onward exist and are still ≤ 30s — pre-fix,
    // attempts[3] would be 60_000.
    expect(retryDelays.slice(3).every((d) => d <= 30_000)).toBe(true);
  });
});
