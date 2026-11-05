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
import { usePrivacyStore } from "../../src/stores/privacyStore.ts";

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

describe("RtPoller — the realTimePolling privacy axis", () => {
  let poller: RtPoller;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(api.fetchRouteRt).mockReset().mockResolvedValue(mockUpdate);
    poller = new RtPoller();
  });

  afterEach(() => {
    poller.stop();
    usePrivacyStore.setState({ level: "standard", overrides: {} });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("never asks the server where live data is switched off", async () => {
    usePrivacyStore.setState({ level: "strict", overrides: {} });
    poller.subscribe("r1", vi.fn());
    poller.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.fetchRouteRt).not.toHaveBeenCalled();
  });

  it("asks only while the app is in the foreground where the level says so", async () => {
    usePrivacyStore.setState({ level: "hardened", overrides: {} });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    poller.subscribe("r1", vi.fn());
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.fetchRouteRt).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.fetchRouteRt).toHaveBeenCalledWith("r1");
  });
});
