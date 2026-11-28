import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAUNCH_WINDOW_MS, UPDATE_CHECK_INTERVAL_MS, watchForUpdates, type Registration } from "./updateChecks.ts";

function worker(state: ServiceWorkerState = "installing") {
  const listeners: Array<() => void> = [];
  const w = {
    state,
    postMessage: vi.fn(),
    addEventListener: vi.fn((_: string, l: () => void) => listeners.push(l)),
    install() {
      w.state = "installed";
      listeners.forEach((l) => l());
    },
  };
  return w;
}

function registration(waiting: ReturnType<typeof worker> | null = null) {
  let found: (() => void) | null = null;
  const r = {
    update: vi.fn(async () => {}),
    waiting,
    installing: null as ReturnType<typeof worker> | null,
    addEventListener: vi.fn((_: "updatefound", l: () => void) => (found = l)),
    removeEventListener: vi.fn(() => (found = null)),
    find(w: ReturnType<typeof worker>) {
      r.installing = w;
      found?.();
    },
  };
  return r;
}

const asReg = (r: ReturnType<typeof registration>) => r as unknown as Registration;

describe("watchForUpdates", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("applies a version already waiting at launch", () => {
    const waiting = worker("installed");
    watchForUpdates(asReg(registration(waiting)));
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
  });

  it("applies a version the launch check finds right away", () => {
    const r = registration();
    let t = 0;
    const stop = watchForUpdates(asReg(r), () => t);
    const w = worker();
    t = 2_000;
    r.find(w);
    w.install();
    expect(w.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    stop();
  });

  it("leaves a version found later to the prompt", () => {
    const r = registration();
    let t = 0;
    const stop = watchForUpdates(asReg(r), () => t);
    const w = worker();
    t = LAUNCH_WINDOW_MS + 1;
    r.find(w);
    w.install();
    expect(w.postMessage).not.toHaveBeenCalled();
    stop();
  });

  it("checks hourly, not on every resume, and stops when asked", () => {
    const r = registration();
    const stop = watchForUpdates(asReg(r));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS - 1);
    expect(r.update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(r.update).toHaveBeenCalledTimes(1);
    stop();
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(r.update).toHaveBeenCalledTimes(1);
    expect(r.removeEventListener).toHaveBeenCalled();
  });

  it("skips the hourly check while offline", () => {
    const r = registration();
    r.update.mockRejectedValue(new Error("network"));
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const stop = watchForUpdates(asReg(r));
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
    expect(r.update).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
    expect(r.update).toHaveBeenCalledTimes(1);
    stop();
    online.mockRestore();
  });
});
