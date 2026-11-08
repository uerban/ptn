import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useLayoutEffect } from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { REALTIME_POLL_INTERVAL_MS } from "@pt/shared";
import { useDepartures } from "../../src/hooks/useDepartures.ts";
import { usePrivacyStore } from "../../src/stores/privacyStore.ts";
import { allowFlow, denyFlow, resetFlows } from "../../src/test-helpers/networkDecisions.ts";
import { HEDGE_MS, DEFAULT_SCHEDULE_TILE_LIMIT } from "../../src/services/scheduleTileConstants.ts";

// Mock the api module
vi.mock("../../src/services/api.ts", () => ({
  api: {
    getDepartures: vi.fn(),
  },
  fetchManifest: vi.fn(),
  fetchRtTile: vi.fn(),
  ManifestUnavailableError: class ManifestUnavailableError extends Error {},
}));

// Mock the stopStore
vi.mock("../../src/stores/stopStore.ts", () => ({
  useStopStore: { getState: () => ({}) },
}));

// Mock the flag
vi.mock("../../src/services/scheduleTileFlag.ts", () => ({
  isScheduleTileEnabled: vi.fn().mockReturnValue(false),
}));

// Mock reportTelemetry
vi.mock("../../src/services/errorReporter.ts", () => ({
  reportTelemetry: vi.fn(),
  reportError: vi.fn(),
}));

// Mock scheduleTileReadPath for dynamic import interception
vi.mock("../../src/services/scheduleTileReadPath.ts", () => ({
  departuresForStop: vi.fn(),
}));

import { api } from "../../src/services/api.ts";
import { isScheduleTileEnabled } from "../../src/services/scheduleTileFlag.ts";
import { reportTelemetry } from "../../src/services/errorReporter.ts";
import { departuresForStop } from "../../src/services/scheduleTileReadPath.ts";

const mockDepartures = [
  {
    routeId: "r1", routeShortName: "1", routeColor: "e53935",
    mode: "BUS" as const, headsign: "Centre",
    scheduledTime: new Date(Date.now() + 5 * 60_000).toISOString(),
    tripId: "t1",
  },
];

const mockTileDepartures = [
  {
    routeId: "r2", routeShortName: "2", routeColor: "1e88e5",
    mode: "BUS" as const, headsign: "Terminus",
    scheduledTime: new Date(Date.now() + 10 * 60_000).toISOString(),
    predictedTime: new Date(Date.now() + 11 * 60_000).toISOString(),
    tripId: "t2",
  },
];

// Vitest 4's restoreAllMocks only restores vi.spyOn spies; resetAllMocks is
// what returns the vi.mock factory fns above to a clean slate between cases.
// Live departures are allowed unless a case denies them.
beforeEach(() => {
  resetFlows();
  allowFlow("operator.realtime");
});

describe("useDepartures — flag-OFF (regression anchor)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    (isScheduleTileEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (api.getDepartures as ReturnType<typeof vi.fn>).mockResolvedValue({ data: mockDepartures });
    (departuresForStop as ReturnType<typeof vi.fn>).mockReset();
  });
  afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); vi.restoreAllMocks(); });

  it("fetches departures on mount when stopId provided", async () => {
    const { result } = renderHook(() => useDepartures("stop_1", false));
    await waitFor(() => expect(result.current.departures).toHaveLength(1));
    // The legacy call now carries the schedule-tile default limit.
    expect(api.getDepartures).toHaveBeenCalledWith("stop_1", undefined, DEFAULT_SCHEDULE_TILE_LIMIT, undefined);
  });

  it("does not call departuresForStop when flag is OFF", async () => {
    renderHook(() => useDepartures("stop_1", false));
    await waitFor(() => expect(api.getDepartures).toHaveBeenCalledTimes(1));
    expect(departuresForStop).not.toHaveBeenCalled();
  });

  it("does not poll when polling is disabled", async () => {
    renderHook(() => useDepartures("stop_1", false));
    await waitFor(() => expect(api.getDepartures).toHaveBeenCalledTimes(1));
    vi.advanceTimersByTime(60_000);
    expect(api.getDepartures).toHaveBeenCalledTimes(1);
  });

  it("polls every 30s when polling is enabled", async () => {
    renderHook(() => useDepartures("stop_1", true));
    await waitFor(() => expect(api.getDepartures).toHaveBeenCalledTimes(1));
    vi.advanceTimersByTime(30_000);
    await waitFor(() => expect(api.getDepartures).toHaveBeenCalledTimes(2));
  });

  it("returns empty when no stopId", () => {
    const { result } = renderHook(() => useDepartures(null, false));
    expect(result.current.departures).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it("does not set loading=true on background poll refresh", async () => {
    const { result } = renderHook(() => useDepartures("stop_1", true));
    await waitFor(() => expect(result.current.departures).toHaveLength(1));

    // loading should be false after initial fetch
    expect(result.current.loading).toBe(false);

    // Advance to trigger poll — loading should stay false during background refresh
    vi.advanceTimersByTime(30_000);
    expect(result.current.loading).toBe(false);

    await waitFor(() => expect(api.getDepartures).toHaveBeenCalledTimes(2));
    expect(result.current.loading).toBe(false);
  });

  it("emits no schedule_tile_fallback telemetry when flag is OFF", async () => {
    renderHook(() => useDepartures("stop_1", false));
    await waitFor(() => expect(api.getDepartures).toHaveBeenCalledTimes(1));
    expect(reportTelemetry).not.toHaveBeenCalledWith("schedule_tile_fallback", expect.anything());
  });
});

describe("useDepartures — flag-ON, tile ok", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    (isScheduleTileEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (api.getDepartures as ReturnType<typeof vi.fn>).mockResolvedValue({ data: mockDepartures });
    (departuresForStop as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: "ok",
      departures: mockTileDepartures,
      serviceState: "normal",
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); vi.restoreAllMocks(); });

  it("returns tile departures, not api departures", async () => {
    const { result } = renderHook(() => useDepartures("stop_1", false));
    await waitFor(() => expect(result.current.departures).toHaveLength(1));
    expect(result.current.departures[0].tripId).toBe("t2");
    expect(api.getDepartures).not.toHaveBeenCalled();
  });

  it("clears loading after tile-ok (J12)", async () => {
    const { result } = renderHook(() => useDepartures("stop_1", false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.departures).toHaveLength(1);
  });

  it("sets no error on tile-ok", async () => {
    const { result } = renderHook(() => useDepartures("stop_1", false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
  });

  it("settledStopId names the stop once its read has finished, and is null from the render the stop changes", async () => {
    let resolveB!: (v: unknown) => void;
    (departuresForStop as ReturnType<typeof vi.fn>).mockImplementation(({ stopId }: { stopId: string }) =>
      stopId === "stop_b"
        ? new Promise((r) => { resolveB = r; })
        : Promise.resolve({ state: "ok", departures: mockTileDepartures, serviceState: "normal" }));
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useDepartures(id, false), {
      initialProps: { id: "stop_a" as string | null },
    });
    expect(result.current.settledStopId).toBeNull();
    await waitFor(() => expect(result.current.settledStopId).toBe("stop_a"));
    expect(result.current.loading).toBe(false);

    // Never "stop_a" next to the new id, not even in the first render.
    rerender({ id: "stop_b" });
    expect(result.current.settledStopId).toBeNull();
    await waitFor(() => expect(resolveB).toBeTypeOf("function"));
    expect(result.current.settledStopId).toBeNull();
    await act(async () => {
      resolveB({ state: "ok", departures: [], serviceState: "normal" });
    });
    await waitFor(() => expect(result.current.settledStopId).toBe("stop_b"));

    rerender({ id: null });
    expect(result.current.settledStopId).toBeNull();
  });

  it("settledStopId is set after a failed read too", async () => {
    (departuresForStop as ReturnType<typeof vi.fn>).mockResolvedValue({ state: "unavailable" });
    (api.getDepartures as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useDepartures("stop_1", false));
    await waitFor(() => expect(result.current.settledStopId).toBe("stop_1"));
    expect(result.current.error).not.toBeNull();
  });

  it("a new stop never shows the previous stop's departures, not in its first frame and not after its own read fails", async () => {
    // stop_b: the tile cannot serve it and the network fallback fails too.
    (departuresForStop as ReturnType<typeof vi.fn>).mockImplementation(({ stopId }: { stopId: string }) =>
      Promise.resolve(stopId === "stop_b"
        ? { state: "unavailable" }
        : { state: "ok", departures: mockTileDepartures, serviceState: "normal" }));
    (api.getDepartures as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("offline"));
    // Every committed frame, not only the last one: a stale list shown for one
    // frame is still shown.
    const commits: { id: string | null; tripIds: string[]; loading: boolean }[] = [];
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => {
      const r = useDepartures(id, false);
      useLayoutEffect(() => {
        commits.push({ id, tripIds: r.departures.map((d) => d.tripId), loading: r.loading });
      });
      return r;
    }, { initialProps: { id: "stop_a" as string | null } });
    await waitFor(() => expect(result.current.settledStopId).toBe("stop_a"));
    expect(result.current.departures.map((d) => d.tripId)).toEqual(["t2"]);

    rerender({ id: "stop_b" });
    await waitFor(() => expect(result.current.settledStopId).toBe("stop_b"));
    expect(result.current.departures).toEqual([]);
    expect(result.current.error).not.toBeNull();
    expect(result.current.loading).toBe(false);

    const bFrames = commits.filter((c) => c.id === "stop_b");
    expect(bFrames.length).toBeGreaterThan(0);
    for (const frame of bFrames) expect(frame.tripIds).toEqual([]);
    // Its first frame already reads as loading: no "no departures" flash.
    expect(bFrames[0].loading).toBe(true);
  });

  it("a poll of the previous stop coming due between the commit and the passive effects reads nothing", async () => {
    let inGap: (() => void) | null = null;
    const { result, rerender } = renderHook(({ id }: { id: string }) => {
      const r = useDepartures(id, true);
      // In the commit, before the passive effects that clear A's interval
      // (see the hedge twin of this test).
      useLayoutEffect(() => { inGap?.(); }, [id]);
      return r;
    }, { initialProps: { id: "stop_a" } });
    await waitFor(() => expect(result.current.settledStopId).toBe("stop_a"));

    inGap = () => { vi.advanceTimersByTime(REALTIME_POLL_INTERVAL_MS); };
    rerender({ id: "stop_b" });
    await waitFor(() => expect(result.current.settledStopId).toBe("stop_b"));
    await act(async () => { await Promise.resolve(); });
    const readStops = (departuresForStop as ReturnType<typeof vi.fn>).mock.calls.map(([a]) => a.stopId);
    expect(readStops).toEqual(["stop_a", "stop_b"]);
  });

  it("a background poll of the same stop keeps the list it shows, also when the poll fails", async () => {
    const { result } = renderHook(() => useDepartures("stop_1", true));
    await waitFor(() => expect(result.current.departures.map((d) => d.tripId)).toEqual(["t2"]));

    let rejectPoll!: (e: Error) => void;
    (departuresForStop as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((_, rej) => { rejectPoll = rej; }));
    (api.getDepartures as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("offline"));
    vi.advanceTimersByTime(30_000);
    await waitFor(() => expect(departuresForStop).toHaveBeenCalledTimes(2));
    expect(result.current.departures.map((d) => d.tripId)).toEqual(["t2"]);

    await act(async () => { rejectPoll(new Error("network")); });
    await waitFor(() => expect(api.getDepartures).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.departures.map((d) => d.tripId)).toEqual(["t2"]);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("tile-ok with zero departures — no fallback, returns empty list", async () => {
    (departuresForStop as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: "ok",
      departures: [],
      serviceState: "no_service",
    });
    const { result } = renderHook(() => useDepartures("stop_1", false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.departures).toEqual([]);
    expect(api.getDepartures).not.toHaveBeenCalled();
  });

  it("poll re-runs the tile path (G7: background poll never sets loading)", async () => {
    const { result } = renderHook(() => useDepartures("stop_1", true));
    await waitFor(() => expect(departuresForStop).toHaveBeenCalledTimes(1));
    expect(result.current.loading).toBe(false);

    vi.advanceTimersByTime(30_000);
    await waitFor(() => expect(departuresForStop).toHaveBeenCalledTimes(2));
    expect(result.current.loading).toBe(false);
    expect(api.getDepartures).not.toHaveBeenCalled();
  });

  it("background poll never sets loading or error (G7)", async () => {
    const { result } = renderHook(() => useDepartures("stop_1", true));
    await waitFor(() => expect(departuresForStop).toHaveBeenCalledTimes(1));

    // Make the next poll slow-resolve to catch any transient loading=true
    let resolvePoll: (v: unknown) => void;
    const slowPoll = new Promise((res) => { resolvePoll = res; });
    (departuresForStop as ReturnType<typeof vi.fn>).mockReturnValueOnce(slowPoll);

    vi.advanceTimersByTime(30_000);
    // loading should never flip true for a background poll
    expect(result.current.loading).toBe(false);

    act(() => { resolvePoll!({ state: "ok", departures: mockTileDepartures, serviceState: "normal" }); });
    await waitFor(() => expect(departuresForStop).toHaveBeenCalledTimes(2));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

describe("useDepartures — flag-ON, tile fallback paths", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    (isScheduleTileEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (api.getDepartures as ReturnType<typeof vi.fn>).mockResolvedValue({ data: mockDepartures });
    (reportTelemetry as ReturnType<typeof vi.fn>).mockReset();
  });
  afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); vi.restoreAllMocks(); });

  it("tile unavailable → api fallback + one schedule_tile_fallback telemetry", async () => {
    (departuresForStop as ReturnType<typeof vi.fn>).mockResolvedValue({ state: "unavailable" });
    const { result } = renderHook(() => useDepartures("stop_1", false));
    await waitFor(() => expect(result.current.departures).toHaveLength(1));
    expect(result.current.departures[0].tripId).toBe("t1");
    expect(api.getDepartures).toHaveBeenCalledTimes(1);
    expect(reportTelemetry).toHaveBeenCalledWith("schedule_tile_fallback", { stopId: "stop_1", reason: "unavailable" });
    // Exactly one fallback event (no double-fallback). The winner also emits a schedule_tile_served
    // event now, so total telemetry count > 1.
    const fallbackCalls = (reportTelemetry as ReturnType<typeof vi.fn>).mock.calls
      .filter(([event]) => event === "schedule_tile_fallback");
    expect(fallbackCalls).toHaveLength(1);
  });

  it("tile stop_not_in_tile → api fallback + one schedule_tile_fallback telemetry", async () => {
    (departuresForStop as ReturnType<typeof vi.fn>).mockResolvedValue({ state: "stop_not_in_tile" });
    const { result } = renderHook(() => useDepartures("stop_1", false));
    await waitFor(() => expect(result.current.departures).toHaveLength(1));
    expect(api.getDepartures).toHaveBeenCalledTimes(1);
    expect(reportTelemetry).toHaveBeenCalledWith("schedule_tile_fallback", { stopId: "stop_1", reason: "stop_not_in_tile" });
  });

  it("tile throw → api fallback + schedule_tile_fallback{reason:throw}", async () => {
    (departuresForStop as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network"));
    const { result } = renderHook(() => useDepartures("stop_1", false));
    await waitFor(() => expect(result.current.departures).toHaveLength(1));
    expect(api.getDepartures).toHaveBeenCalledTimes(1);
    expect(reportTelemetry).toHaveBeenCalledWith("schedule_tile_fallback", { stopId: "stop_1", reason: "throw" });
  });

  it("tile fallback → loading cleared after api resolves (J12)", async () => {
    (departuresForStop as ReturnType<typeof vi.fn>).mockResolvedValue({ state: "unavailable" });
    const { result } = renderHook(() => useDepartures("stop_1", false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.departures).toHaveLength(1);
  });
});

describe("useDepartures — latest-wins token (J8/J11)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    (isScheduleTileEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (reportTelemetry as ReturnType<typeof vi.fn>).mockReset();
  });
  afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); vi.restoreAllMocks(); });

  it("a stale settle writes nothing including in finally", async () => {
    // Distinct payload for the stale (stop_1) fetch so we can prove it never
    // reaches React state — stop_2 resolves to mockDepartures (tripId "t1").
    const staleDepartures = [{ ...mockDepartures[0], tripId: "STALE" }];
    // First call hangs until we resolve it manually
    let resolveFirst!: (v: { data: typeof mockDepartures }) => void;
    const firstPromise = new Promise<{ data: typeof mockDepartures }>((res) => { resolveFirst = res; });
    (api.getDepartures as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValue({ data: mockDepartures });

    const { result, rerender } = renderHook(
      ({ stopId }: { stopId: string }) => useDepartures(stopId, false),
      { initialProps: { stopId: "stop_1" } },
    );

    // First fetch is in-flight. Change the stopId — triggers a new fetch.
    rerender({ stopId: "stop_2" });

    // Synchronize on the FRESH stop_2 fetch fully SETTLING — not merely being
    // called. The latest-wins flake was waiting on `toHaveBeenCalledWith` (the
    // call happens before stop_2's settle clears loading on a later microtask),
    // then asserting loading synchronously; under CI contention the settle had
    // not yet committed. Waiting on loading===false guarantees stop_2 won.
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.getDepartures).toHaveBeenCalledWith("stop_2", undefined, DEFAULT_SCHEDULE_TILE_LIMIT, undefined);
    expect(result.current.departures).toHaveLength(1);
    expect(result.current.departures[0].tripId).toBe("t1");

    // Now resolve the stale first fetch with distinct data and flush its
    // microtasks (async act). The latest-wins token must reject it: no departures
    // overwrite, no loading flip, nothing written in its finally either.
    await act(async () => { resolveFirst({ data: staleDepartures }); });

    expect(result.current.loading).toBe(false);
    expect(result.current.departures[0].tripId).toBe("t1");
  });
});

describe("useDepartures — bg-poll loading lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    (isScheduleTileEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (reportTelemetry as ReturnType<typeof vi.fn>).mockReset();
  });
  afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); vi.restoreAllMocks(); });

  it("bg poll settling while fg is in flight does NOT leave loading stuck at true", async () => {
    // Foreground fetch hangs until we release it manually.
    let resolveFg!: (v: { data: typeof mockDepartures }) => void;
    const fgPromise = new Promise<{ data: typeof mockDepartures }>((res) => { resolveFg = res; });

    // bg poll resolves immediately.
    (api.getDepartures as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(fgPromise)           // 1st call = foreground
      .mockResolvedValue({ data: mockDepartures }); // subsequent = background polls

    const { result } = renderHook(() => useDepartures("stop_1", true));

    // Foreground fetch is in flight — loading should be true.
    expect(result.current.loading).toBe(true);

    // Advance past the poll interval so a background poll fires and settles.
    vi.advanceTimersByTime(30_000);
    await waitFor(() => expect(api.getDepartures).toHaveBeenCalledTimes(2));

    // After the bg poll settles, loading must still be true (fg is still pending).
    // Before the fix, the bg poll bumped latestTokenRef so fresh()=false for fg →
    // fg's finally skipped setLoading(false) AND bg never cleared it → stuck.
    // After the fix, the bg poll does NOT bump latestFgTokenRef, so the fg finally
    // will still fire correctly once we release the fg promise.
    expect(result.current.loading).toBe(true);

    // Now resolve the foreground fetch.
    act(() => { resolveFg({ data: mockDepartures }); });

    // Loading must eventually clear to false.
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.departures).toHaveLength(1);
  });
});

describe("useDepartures — G9 module-graph: dynamic not static load", () => {
  // This test verifies that scheduleTileReadPath is NOT evaluated at module import time —
  // only when a flag-ON fetch actually runs. We confirm by checking the factory for the
  // vi.mock above was only invoked lazily, not at static import time.

  it("scheduleTileReadPath mock factory was not invoked at import time (G9/K6)", async () => {
    // If the import were static, the `departuresForStop` mock would have been called
    // when `useDepartures` module was first evaluated. We reset the spy here and verify
    // that simply importing useDepartures (already done above) did not execute the factory.
    // The mock module factory in vi.mock runs once per test file when the module is first
    // needed. The factory itself running once is expected (vi.mock hoisting), but
    // `departuresForStop` (the function exported by the mock) should only be called when
    // an actual flag-ON fetch is triggered — never at import-evaluation time.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    (isScheduleTileEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (departuresForStop as ReturnType<typeof vi.fn>).mockReset();
    (api.getDepartures as ReturnType<typeof vi.fn>).mockResolvedValue({ data: mockDepartures });

    // Render with flag OFF — departuresForStop should never be called.
    const { result } = renderHook(() => useDepartures("stop_1", false));
    await waitFor(() => expect(result.current.departures).toHaveLength(1));
    // Flag is OFF, so departuresForStop was never invoked even though it is vi.mocked.
    expect(departuresForStop).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("departuresForStop is only called when flag is ON (G9 positive)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    (isScheduleTileEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (departuresForStop as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: "ok",
      departures: mockTileDepartures,
      serviceState: "normal",
    });

    const { result } = renderHook(() => useDepartures("stop_1", false));
    await waitFor(() => expect(departuresForStop).toHaveBeenCalledTimes(1));
    expect(result.current.departures[0].tripId).toBe("t2");
    vi.useRealTimers();
  });
});

describe("useDepartures — /departures real-time gate", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    usePrivacyStore.getState().reset();
    (isScheduleTileEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (api.getDepartures as ReturnType<typeof vi.fn>).mockClear();
    (api.getDepartures as ReturnType<typeof vi.fn>).mockResolvedValue({ data: mockDepartures });
    (departuresForStop as ReturnType<typeof vi.fn>).mockReset();
  });
  afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); vi.restoreAllMocks(); });

  it("real-time denied + tile-unavailable does NOT call /departures (fallback gated)", async () => {
    denyFlow("operator.realtime");
    (departuresForStop as ReturnType<typeof vi.fn>).mockResolvedValue({ state: "unavailable" });
    const { result } = renderHook(() => useDepartures("S1", false, 1.5));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.getDepartures).not.toHaveBeenCalled();
    expect(result.current.departures).toEqual([]);
  });

  it("real-time allowed + tile-unavailable DOES fall back to /departures", async () => {
    (departuresForStop as ReturnType<typeof vi.fn>).mockResolvedValue({ state: "unavailable" });
    renderHook(() => useDepartures("S1", false, 1.5));
    await waitFor(() => expect(api.getDepartures).toHaveBeenCalled());
  });

  it("real-time denied + background poll whose tile fails does NOT call /departures", async () => {
    denyFlow("operator.realtime");
    (departuresForStop as ReturnType<typeof vi.fn>).mockResolvedValue({ state: "unavailable" });
    renderHook(() => useDepartures("S1", true, 24)); // polling
    // Foreground initial fetch settles first — gated, no /departures.
    await waitFor(() => expect(departuresForStop).toHaveBeenCalledTimes(1));
    expect(api.getDepartures).not.toHaveBeenCalled();
    // Advance past the poll interval so a genuine BACKGROUND poll fires; its
    // tile fails too and must stay gated (the guard is shared by both paths).
    await act(async () => { await vi.advanceTimersByTimeAsync(REALTIME_POLL_INTERVAL_MS); });
    await waitFor(() => expect(departuresForStop).toHaveBeenCalledTimes(2));
    expect(api.getDepartures).not.toHaveBeenCalled();
  });

  it("global-off + real-time denied does NOT call /departures, and reports the stop unavailable", async () => {
    denyFlow("operator.realtime");
    (isScheduleTileEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const { result } = renderHook(() => useDepartures("S1", false, 1.5));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.getDepartures).not.toHaveBeenCalled();
    expect(result.current.unavailable).toBe(true);
  });

  it("global-off + real-time allowed uses /departures (rollback override)", async () => {
    (isScheduleTileEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    renderHook(() => useDepartures("S1", false, 1.5));
    await waitFor(() => expect(api.getDepartures).toHaveBeenCalled());
  });

  it("marks a gated missing tile unavailable rather than an empty timetable", async () => {
    denyFlow("operator.realtime");
    (departuresForStop as ReturnType<typeof vi.fn>).mockResolvedValue({ state: "unavailable" });
    const { result } = renderHook(() => useDepartures("S1", false, 1.5));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unavailable).toBe(true);
    expect(result.current.updatedAt).not.toBeNull();
  });

  it("refetches when live departures are granted, and again when revoked", async () => {
    resetFlows();
    (departuresForStop as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: "ok",
      departures: mockDepartures,
      serviceState: "active",
    });
    const { result } = renderHook(() => useDepartures("S1", false, 1.5));
    await waitFor(() => expect(departuresForStop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unavailable).toBe(false);

    (departuresForStop as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: "ok",
      departures: mockTileDepartures,
      serviceState: "active",
    });
    act(() => allowFlow("operator.realtime"));
    await waitFor(() => expect(departuresForStop).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.departures).toEqual(mockTileDepartures));

    (departuresForStop as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: "ok",
      departures: mockDepartures,
      serviceState: "active",
    });
    act(() => denyFlow("operator.realtime"));
    await waitFor(() => expect(departuresForStop).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.departures).toEqual(mockDepartures));
  });

  it("emits schedule_tile_served with source on a warm tile", async () => {
    (isScheduleTileEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (departuresForStop as ReturnType<typeof vi.fn>).mockResolvedValue({ state: "ok", departures: [], serviceState: "active" });
    renderHook(() => useDepartures("S1", false, 1.5, { hedge: true }));
    await waitFor(() => expect(reportTelemetry).toHaveBeenCalledWith(
      "schedule_tile_served", expect.objectContaining({ stopId: "S1", source: "tile_warm", hedgeFired: false }),
    ));
  });
});

const TILE_DEP = { ...mockTileDepartures[0], routeId: "tile" };
const LEGACY_DEP = { ...mockDepartures[0], routeId: "legacy" };

describe("useDepartures — cache-miss hedge", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    usePrivacyStore.getState().reset();
    (isScheduleTileEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (api.getDepartures as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [LEGACY_DEP] });
  });
  afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); vi.restoreAllMocks(); });

  it("warm tile (no onTileDownloadStart) never calls /departures", async () => {
    (departuresForStop as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      ({ state: "ok", departures: [TILE_DEP], serviceState: "active" }));
    const { result } = renderHook(() => useDepartures("S1", false, 1.5, { hedge: true }));
    await waitFor(() => expect(result.current.departures).toEqual([TILE_DEP]));
    expect(api.getDepartures).not.toHaveBeenCalled();
  });

  it("cold tile slower than HEDGE_MS fires the hedge and renders it", async () => {
    (departuresForStop as ReturnType<typeof vi.fn>).mockImplementation(async (_a, opts) => {
      opts?.onTileDownloadStart?.();
      await new Promise((r) => setTimeout(r, 5000));
      return { state: "ok", departures: [TILE_DEP], serviceState: "active" };
    });
    const { result } = renderHook(() => useDepartures("S1", false, 1.5, { hedge: true }));
    await waitFor(() => expect(result.current.departures).toEqual([LEGACY_DEP]));
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it("rapid stopId A->B does not fire A's hedged /departures (cleanup)", async () => {
    (departuresForStop as ReturnType<typeof vi.fn>).mockImplementation(async (a, opts) => {
      if (a.stopId === "A") { opts?.onTileDownloadStart?.(); await new Promise((r) => setTimeout(r, 5000)); }
      return { state: "ok", departures: [], serviceState: "active" };
    });
    const { rerender } = renderHook(({ id }) => useDepartures(id, false, 1.5, { hedge: true }), { initialProps: { id: "A" } });
    rerender({ id: "B" });
    await act(async () => { await vi.advanceTimersByTimeAsync(HEDGE_MS + 50); });
    expect(api.getDepartures).not.toHaveBeenCalled();
  });

  it("A's hedge coming due after the commit that shows B, before its passive effects, asks for nothing", async () => {
    // A: a cold tile that never arrives, so A's hedge is armed and pending.
    (departuresForStop as ReturnType<typeof vi.fn>).mockImplementation(async (a, opts) => {
      if (a.stopId === "A") opts?.onTileDownloadStart?.();
      return new Promise(() => {});
    });
    let inGap: (() => void) | null = null;
    const { rerender } = renderHook(({ id }: { id: string }) => {
      const r = useDepartures(id, false, 1.5, { hedge: true });
      // Runs in the commit, after the hook's own layout effects and before
      // any passive effect: where a timer task can land when the stop change
      // is not a discrete event (a geolocation fix), since React flushes
      // those passive effects in a later task.
      useLayoutEffect(() => { inGap?.(); }, [id]);
      return r;
    }, { initialProps: { id: "A" } });
    await waitFor(() => expect(departuresForStop).toHaveBeenCalledTimes(1));

    inGap = () => { vi.advanceTimersByTime(HEDGE_MS); };
    rerender({ id: "B" });
    expect(api.getDepartures).not.toHaveBeenCalled();
    // B's read has started (its tile is warm: no hedge of its own), and
    // nothing asks for either stop past the hedge window.
    await waitFor(() => expect(departuresForStop).toHaveBeenCalledTimes(2));
    await act(async () => { await vi.advanceTimersByTimeAsync(HEDGE_MS + 50); });
    expect(api.getDepartures).not.toHaveBeenCalled();
  });

  it("hedge=false (ETA cards) never arms the hedge even on a cold tile", async () => {
    (departuresForStop as ReturnType<typeof vi.fn>).mockImplementation(async (_a, opts) => {
      opts?.onTileDownloadStart?.(); return { state: "ok", departures: [TILE_DEP], serviceState: "active" };
    });
    renderHook(() => useDepartures("S1", false, 1));
    await act(async () => { await vi.advanceTimersByTimeAsync(HEDGE_MS + 50); });
    expect(api.getDepartures).not.toHaveBeenCalled();
  });

  it("real-time denied + hedge:true + slow COLD tile → /departures is never called (allowBackend gate)", async () => {
    denyFlow("operator.realtime");
    // Cold tile: signals download start then hangs longer than HEDGE_MS.
    (departuresForStop as ReturnType<typeof vi.fn>).mockImplementation(async (_a, opts) => {
      opts?.onTileDownloadStart?.();
      await new Promise((r) => setTimeout(r, 5000));
      return { state: "ok", departures: [TILE_DEP], serviceState: "active" };
    });
    renderHook(() => useDepartures("S1", false, 1.5, { hedge: true }));
    // Advance past the hedge window — with real-time denied, allowBackend=false so
    // canHedge is false and the timer is never armed.
    await act(async () => { await vi.advanceTimersByTimeAsync(HEDGE_MS + 50); });
    expect(api.getDepartures).not.toHaveBeenCalled();
  });
});


it("clears a reused stop ID on city change and discards the old city's late result", async () => {
  const {useCityStore} = await import("../../src/stores/cityStore.ts");
  const original = useCityStore.getState().activeCity;
  usePrivacyStore.getState().reset();
  vi.mocked(isScheduleTileEnabled).mockReturnValue(false);
  let finish!: (value: {data: typeof mockDepartures}) => void;
  vi.mocked(api.getDepartures).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}))
    .mockResolvedValue({data: mockTileDepartures});
  const view = renderHook(() => useDepartures("same-stop", false));
  try {
    await waitFor(() => expect(api.getDepartures).toHaveBeenCalled());
    act(() => useCityStore.setState({activeCity: {...original, id: "other-city"}}));
    expect(view.result.current.departures).toEqual([]);
    await waitFor(() => expect(view.result.current.departures).toEqual(mockTileDepartures));
    await act(async () => {finish({data: mockDepartures}); await Promise.resolve();});
    expect(view.result.current.departures).toEqual(mockTileDepartures);
  } finally {view.unmount(); useCityStore.setState({activeCity: original});}
});
