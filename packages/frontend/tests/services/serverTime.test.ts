import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServerTimeSyncer } from "../../src/services/serverTime.ts";

const reportErrorMock = vi.fn();
vi.mock("../../src/services/errorReporter.ts", () => ({
  reportError: (...args: unknown[]) => reportErrorMock(...args),
}));

describe("ServerTimeSyncer", () => {
  beforeEach(() => {
    vi.useRealTimers();
    reportErrorMock.mockClear();
  });

  it("computes offset from server timestamp", () => {
    const syncer = new ServerTimeSyncer();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));
    syncer.update("2026-04-10T12:00:01.000Z");
    expect(syncer.now()).toBe(new Date("2026-04-10T12:00:01.000Z").getTime());
    vi.useRealTimers();
  });

  it("returns client time when no server time received", () => {
    const syncer = new ServerTimeSyncer();
    const before = Date.now();
    const result = syncer.now();
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });

  it("ignores invalid timestamps", () => {
    const syncer = new ServerTimeSyncer();
    syncer.update("not-a-date");
    const before = Date.now();
    expect(syncer.now()).toBeGreaterThanOrEqual(before - 1);
  });

  it("ignores implausibly stale timestamps from cached SW responses", () => {
    // Reproduces the bug where a service-worker fallback returned a response
    // whose Date header was days old, dragging serverTime.now() into the past
    // and inflating departure countdowns to thousands of minutes.
    const syncer = new ServerTimeSyncer();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));
    syncer.update("2026-04-10T12:00:00.500Z");
    const goodOffset = syncer.now() - Date.now();

    syncer.update("2026-04-04T12:00:00.000Z");
    expect(syncer.now() - Date.now()).toBe(goodOffset);
    vi.useRealTimers();
  });

  it("does not poison a never-synced syncer with a stale update (cold-load + warm SW cache)", () => {
    // Real production cold-load path: page reloads with a warm SW cache, and
    // the first update() the syncer ever sees carries an old Date header. If
    // the threshold check were absent OR the offset were applied before the
    // check, now() would return a poisoned time on first call.
    const syncer = new ServerTimeSyncer();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    syncer.update("2026-04-04T12:00:00.000Z"); // 6 days stale, never synced

    // synced must remain false → now() returns raw client time, not a
    // poisoned offset.
    expect(syncer.now()).toBe(Date.now());
    vi.useRealTimers();
  });

  it("reports implausible offset rejection so genuine clock skew is observable in telemetry", () => {
    // The threshold check intentionally collapses two distinct failure modes
    // (real clock skew, stale SW cache) into one rejection. Telemetry must
    // capture the rejection so a >5min skew that's actually a misconfigured
    // device clock or backend NTP drift doesn't silently leave users on
    // local time forever.
    const syncer = new ServerTimeSyncer();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    syncer.update("2026-04-04T12:00:00.000Z");

    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const [errArg, extraArg] = reportErrorMock.mock.calls[0];
    expect(errArg).toBeInstanceOf(Error);
    expect(extraArg).toMatchObject({
      context: { where: "serverTime.implausibleOffset" },
    });
    vi.useRealTimers();
  });

  it("accepts an offset just under the threshold (4min59s)", () => {
    const syncer = new ServerTimeSyncer();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));
    // Server reports 4min59s in the future — within 5-minute threshold.
    syncer.update("2026-04-10T12:04:59.000Z");
    expect(syncer.now() - Date.now()).toBe(4 * 60 * 1000 + 59 * 1000);
    expect(reportErrorMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("rejects an offset just over the threshold (5min1s) in either direction", () => {
    const syncer = new ServerTimeSyncer();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));
    // Positive direction: server clock 5min1s ahead.
    syncer.update("2026-04-10T12:05:01.000Z");
    expect(syncer.now()).toBe(Date.now()); // no offset applied
    expect(reportErrorMock).toHaveBeenCalledTimes(1);

    // Negative direction: server clock 5min1s behind.
    reportErrorMock.mockClear();
    syncer.update("2026-04-10T11:54:59.000Z");
    expect(syncer.now()).toBe(Date.now());
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
