import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RtPoller } from "../../src/services/rtPoller.ts";
import type { RtRouteUpdate } from "@pt/shared";

vi.mock("../../src/services/api.ts", () => ({
  api: {
    fetchRouteRt: vi.fn(),
  },
}));

// Import after mock so we get the mocked version
import { api } from "../../src/services/api.ts";
import { allowFlow, denyFlow, resetFlows } from "../../src/test-helpers/networkDecisions.ts";

const mockUpdate: RtRouteUpdate = {
  routeId: "r1",
  trips: [{ tripId: "t1", delaySeconds: 60, cancelled: false }],
  generatedAt: Date.now(),
};

describe("RtPoller", () => {
  let poller: RtPoller;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(api.fetchRouteRt).mockResolvedValue(mockUpdate);
    resetFlows();
    allowFlow("operator.realtime");
    poller = new RtPoller();
  });

  afterEach(() => {
    poller.stop();
    vi.useRealTimers();
  });

  it("subscribes to a route and receives updates", async () => {
    const callback = vi.fn();
    poller.subscribe("r1", callback);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledWith(mockUpdate);
  });

  it("unsubscribe stops polling for that route", async () => {
    const callback = vi.fn();
    poller.subscribe("r1", callback);
    poller.unsubscribe("r1");
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(callback).not.toHaveBeenCalled();
  });

  it("adapts polling interval", () => {
    poller.setMode("navigating");
    expect(poller.getIntervalMs()).toBe(8_000);
    poller.setMode("transfer");
    expect(poller.getIntervalMs()).toBe(5_000);
    poller.setMode("idle");
    expect(poller.getIntervalMs()).toBe(30_000);
  });

  it("polls a second time within jittered range of base interval", async () => {
    const callback = vi.fn();
    poller.subscribe("r1", callback);
    poller.setMode("navigating"); // base = 8_000 ms, jitter range [5_600, 10_400]

    poller.start();
    await vi.advanceTimersByTimeAsync(0); // immediate first poll
    expect(callback).toHaveBeenCalledTimes(1);

    // Advance just past the maximum jittered interval (+30% = 10_400 ms)
    await vi.advanceTimersByTimeAsync(10_400);
    expect(callback.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not fire again after stop()", async () => {
    const callback = vi.fn();
    poller.subscribe("r1", callback);
    poller.setMode("navigating");

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    const callsAfterStart = callback.mock.calls.length;

    poller.stop();
    await vi.advanceTimersByTimeAsync(15_000); // well past any jittered interval
    expect(callback.mock.calls.length).toBe(callsAfterStart);
  });
});

describe("RtPoller — the real-time decision", () => {
  let poller: RtPoller;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(api.fetchRouteRt).mockReset().mockResolvedValue(mockUpdate);
    resetFlows();
    poller = new RtPoller();
  });

  afterEach(() => {
    poller.stop();
    resetFlows();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("never asks the server while real-time updates are unset", async () => {
    poller.subscribe("r1", vi.fn());
    poller.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.fetchRouteRt).not.toHaveBeenCalled();
  });

  it("never asks the server while real-time updates are denied", async () => {
    denyFlow("operator.realtime");
    poller.subscribe("r1", vi.fn());
    poller.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.fetchRouteRt).not.toHaveBeenCalled();
  });

  it("resumes polling after a grant", async () => {
    const callback = vi.fn();
    poller.subscribe("r1", callback);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.fetchRouteRt).not.toHaveBeenCalled();
    allowFlow("operator.realtime");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.fetchRouteRt).toHaveBeenCalledWith("r1");
    expect(callback).toHaveBeenCalledWith(mockUpdate);
  });

  it("drops a result that lands after the decision is revoked", async () => {
    allowFlow("operator.realtime");
    let resolve!: (u: RtRouteUpdate) => void;
    vi.mocked(api.fetchRouteRt).mockReturnValue(new Promise((r) => { resolve = r; }));
    const callback = vi.fn();
    poller.subscribe("r1", callback);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.fetchRouteRt).toHaveBeenCalledOnce();
    denyFlow("operator.realtime");
    resolve(mockUpdate);
    await vi.advanceTimersByTimeAsync(0);
    expect(callback).not.toHaveBeenCalled();
  });

  it("skips polls while the page is hidden and resumes once it is shown", async () => {
    allowFlow("operator.realtime");
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    poller.subscribe("r1", vi.fn());
    poller.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.fetchRouteRt).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.fetchRouteRt).toHaveBeenCalledWith("r1");
  });
});
