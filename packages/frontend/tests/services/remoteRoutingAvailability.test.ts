import { afterEach, describe, expect, it, vi } from "vitest";
import {
  probeRemoteRoutingAvailability,
  getRemoteRoutingAvailableSnapshot,
  __resetRemoteRoutingAvailabilityForTest,
} from "../../src/services/remoteRoutingAvailability.ts";

afterEach(() => {
  __resetRemoteRoutingAvailabilityForTest();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("remoteRoutingAvailability", () => {
  it("is optimistically available before any probe for the city", () => {
    expect(getRemoteRoutingAvailableSnapshot("vilnius")).toBe(true);
  });

  it("ok response ⇒ available; non-ok ⇒ unavailable", async () => {
    await probeRemoteRoutingAvailability("vilnius", async () => ({ ok: true }));
    expect(getRemoteRoutingAvailableSnapshot("vilnius")).toBe(true);
    await probeRemoteRoutingAvailability("vilnius", async () => ({ ok: false }));
    expect(getRemoteRoutingAvailableSnapshot("vilnius")).toBe(false);
  });

  // A readiness probe replayed from any cache (HTTP or service worker) reports
  // the backend's state at cache-write time. The SW side is handled by the
  // /health NetworkOnly rule; this is the HTTP-cache half of the same rule.
  it("asks for an uncached response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    await probeRemoteRoutingAvailability("vilnius", fetchImpl);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
  });

  it("fail-closes: a throwing/timed-out probe ⇒ unavailable", async () => {
    await probeRemoteRoutingAvailability("vilnius", async () => { throw new Error("network"); });
    expect(getRemoteRoutingAvailableSnapshot("vilnius")).toBe(false);
  });

  it("snapshot is per-city: a probe for one city does not mark another", async () => {
    await probeRemoteRoutingAvailability("vilnius", async () => ({ ok: false }));
    expect(getRemoteRoutingAvailableSnapshot("vilnius")).toBe(false);
    expect(getRemoteRoutingAvailableSnapshot("krakow")).toBe(true); // pre-probe optimistic
  });

  it("notifies subscribers on a result change", async () => {
    const cb = vi.fn();
    const { subscribeRemoteRoutingAvailable } = await import("../../src/services/remoteRoutingAvailability.ts");
    const unsub = subscribeRemoteRoutingAvailable(cb);
    await probeRemoteRoutingAvailability("vilnius", async () => ({ ok: false }));
    expect(cb).toHaveBeenCalled();
    unsub();
  });

  // Bounded timeout: the probe must fail-closed when the
  // backend hangs past PROBE_TIMEOUT_MS. Inject a fetch that never resolves
  // except by rejecting on the AbortSignal, advance fake timers past the
  // timeout, and assert the probe resolves false + the snapshot is false.
  it("fail-closes on a bounded timeout (probe aborts ⇒ unavailable)", async () => {
    vi.useFakeTimers();
    try {
      const hangingFetch = (_url: string, init: { signal: AbortSignal }) =>
        new Promise<{ ok: boolean; status?: number }>((_, rej) => {
          init.signal.addEventListener("abort", () =>
            rej(new DOMException("aborted", "AbortError")),
          );
        });
      const probe = probeRemoteRoutingAvailability("oslo", hangingFetch);
      // Drive the 3s abort timer.
      await vi.advanceTimersByTimeAsync(3000);
      expect(await probe).toBe(false);
      expect(getRemoteRoutingAvailableSnapshot("oslo")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // Diagnostic warn ONLY on a TRANSITION: a permanent
  // misconfiguration (wrong path ⇒ 404, CSP/CORS block) must be visible and
  // distinguishable from a transient outage, without console spam every tick.
  it("warns once on a non-ok transition, including the city + status", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await probeRemoteRoutingAvailability("vilnius", async () => ({ ok: false, status: 404 }));
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain("vilnius");
    expect(msg).toContain("non-ok status 404");
  });

  it("warns with a network-error reason on a throwing probe", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await probeRemoteRoutingAvailability("vilnius", async () => { throw new Error("ECONNREFUSED"); });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("network error");
  });

  it("does NOT warn on a SECOND consecutive unavailable probe (no transition)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await probeRemoteRoutingAvailability("vilnius", async () => ({ ok: false, status: 503 }));
    expect(warn).toHaveBeenCalledTimes(1);
    // Same value (still unavailable) ⇒ no transition ⇒ no second warn.
    await probeRemoteRoutingAvailability("vilnius", async () => ({ ok: false, status: 503 }));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does NOT warn on an ok probe", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await probeRemoteRoutingAvailability("vilnius", async () => ({ ok: true, status: 200 }));
    expect(warn).not.toHaveBeenCalled();
  });
});
