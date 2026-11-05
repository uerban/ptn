import { describe, it, expect, afterEach, vi } from "vitest";
import { render } from "@testing-library/react";
import {
  useRemoteRoutingAvailable,
  __resetRemoteRoutingAvailabilityForTest,
} from "../../src/services/remoteRoutingAvailability.ts";

// The hook drives `probeRemoteRoutingAvailability` (an intra-module call we
// can't `vi.spyOn`), so we observe its lifecycle through the global `fetch`
// the default probe issues: one `fetch` per probe. Fake timers let us tick the
// 60s background interval deterministically.
afterEach(() => {
  __resetRemoteRoutingAvailabilityForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

function Probe({ cityId }: { cityId: string }) {
  useRemoteRoutingAvailable(cityId);
  return null;
}

describe("useRemoteRoutingAvailable lifecycle", () => {
  it("probes on mount, on the 60s interval, stops after unmount, and re-probes on cityId change", () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);

    // Mount ⇒ one probe (one fetch).
    const { rerender, unmount } = render(<Probe cityId="vilnius" />);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("/api/vilnius/health/ready");

    // Background interval tick ⇒ a second probe.
    vi.advanceTimersByTime(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // cityId change ⇒ the effect re-runs with a fresh probe for the new city.
    rerender(<Probe cityId="krakow" />);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(String(fetchSpy.mock.calls[2][0])).toContain("/api/krakow/health/ready");

    // Unmount clears the interval — no further probes after another 60s.
    unmount();
    const afterUnmount = fetchSpy.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(afterUnmount);
  });
});
