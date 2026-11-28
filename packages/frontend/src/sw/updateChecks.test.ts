import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UPDATE_CHECK_INTERVAL_MS, watchForUpdates } from "./updateChecks.ts";

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("watchForUpdates", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("checks when a resumed app becomes visible", () => {
    const update = vi.fn(async () => {});
    const stop = watchForUpdates({ update });
    setVisibility("hidden");
    expect(update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(61_000);
    setVisibility("visible");
    expect(update).toHaveBeenCalledTimes(1);
    stop();
  });

  it("throttles bursts of visibility changes", () => {
    const update = vi.fn(async () => {});
    const stop = watchForUpdates({ update });
    vi.advanceTimersByTime(61_000);
    setVisibility("visible");
    setVisibility("visible");
    expect(update).toHaveBeenCalledTimes(1);
    stop();
  });

  it("checks periodically while open and stops when asked", () => {
    const update = vi.fn(async () => {});
    const stop = watchForUpdates({ update });
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
    expect(update).toHaveBeenCalledTimes(1);
    stop();
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS * 2);
    setVisibility("visible");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("skips checks while offline and swallows failures", async () => {
    const update = vi.fn(async () => {
      throw new Error("network");
    });
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const stop = watchForUpdates({ update });
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
    expect(update).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
    expect(update).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    stop();
    online.mockRestore();
  });
});
