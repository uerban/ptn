import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useLayoutEffect } from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { Departure, StopWithLines } from "@pt/shared";
import { directedPattern, patternIndex } from "../../src/test-helpers/patternIndex.ts";
import { at } from "../helpers/metreGrid.ts";

// The api module: `getDepartures` is the per-stop server read the privacy
// tests spy on (useDepartures' legacy fallback for the nearest stop).
vi.mock("../../src/services/api.ts", () => ({
  api: { getDepartures: vi.fn() },
  fetchManifest: vi.fn(),
  fetchRtTile: vi.fn(),
  ManifestUnavailableError: class ManifestUnavailableError extends Error {},
}));

vi.mock("../../src/services/scheduleTileFlag.ts", () => ({
  isScheduleTileEnabled: vi.fn(() => true),
}));

vi.mock("../../src/services/errorReporter.ts", () => ({
  reportTelemetry: vi.fn(),
  reportError: vi.fn(),
}));

// Both tile reads are mocked: the nearest stop's (via the real useDepartures)
// and the several-stops batch the hook calls for every other side's stop.
vi.mock("../../src/services/scheduleTileReadPath.ts", () => ({
  departuresForStop: vi.fn(),
  departuresForStops: vi.fn(),
}));

// The real resolver, wrapped in a spy so a re-resolve can be counted.
vi.mock("../../src/services/nearbyDirections.ts", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/nearbyDirections.ts")>();
  return { ...actual, resolveNearbySides: vi.fn(actual.resolveNearbySides) };
});

import { api } from "../../src/services/api.ts";
import { departuresForStop, departuresForStops } from "../../src/services/scheduleTileReadPath.ts";
import { resolveNearbySides, type Side } from "../../src/services/nearbyDirections.ts";
import { useNearbyDirections } from "../../src/hooks/useNearbyDirections.ts";
import { useStopStore } from "../../src/stores/stopStore.ts";
import { useGtfsDataStore } from "../../src/stores/gtfsDataStore.ts";
import { useCityStore } from "../../src/stores/cityStore.ts";
import { usePrivacyStore } from "../../src/stores/privacyStore.ts";
import { allowFlow, resetFlows } from "../../src/test-helpers/networkDecisions.ts";

// ─── Geometry (metres from the grid origin) ──────────────────────────────────

function stop(id: string, name: string, northM: number, eastM = 0): StopWithLines {
  return { id, name, location: at(northM, eastM), lastSeen: 0 };
}

function dep(routeId: string, tripId: string, mins: number): Departure {
  return {
    routeId,
    routeShortName: routeId,
    mode: "BUS",
    headsign: `${routeId} headsign`,
    scheduledTime: new Date(Date.now() + mins * 60_000).toISOString(),
    tripId,
  } as Departure;
}

// Two-sided street: lines 1 and 2 stop at S (user's side) and at R, the
// same-name pole across the road. User 10 m south of S, R 20 m east of S.
const S = stop("S", "Main St", 0);
const R = stop("R", "Main St", 0, 20);
const STREET = [S, R];
const USER = at(-10);
const STREET_INDEX = patternIndex([
  directedPattern("1", ["A", "S", "B"], "t1", 0),
  directedPattern("1", ["B", "R", "A"], "t2", 1),
  directedPattern("2", ["C", "S", "D"], "t3", 0),
  directedPattern("2", ["D", "R", "C"], "t4", 1),
]);
const S_DEPS = [dep("1", "t1", 3), dep("2", "t3", 5)];
const R_DEPS = [dep("1", "t2", 4), dep("2", "t4", 6)];

type Props = Parameters<typeof useNearbyDirections>[0];

function sideOf(sides: Side[], routeId: string, row: Side["row"]): Side | undefined {
  return sides.find((s) => s.routeId === routeId && s.row === row);
}

const realCity = useCityStore.getState().activeCity;

beforeEach(() => {
  vi.clearAllMocks();
  usePrivacyStore.getState().reset();
  resetFlows();
  allowFlow("operator.realtime");
  useCityStore.setState({ activeCity: { ...realCity, tz: "UTC" } });
  useStopStore.setState({ stops: STREET, hydrated: true } as never);
  useGtfsDataStore.setState({ raptorIndex: STREET_INDEX });
  vi.mocked(departuresForStop).mockImplementation(async ({ stopId }) => ({
    state: "ok",
    departures: stopId === "S" ? S_DEPS : [],
    serviceState: "normal",
  }) as never);
  vi.mocked(departuresForStops).mockImplementation(async ({ stopIds }) =>
    new Map(stopIds.filter((id) => id === "R").map((id) => [id, R_DEPS])));
  vi.mocked(api.getDepartures).mockResolvedValue({ data: [] } as never);
});

afterEach(() => {
  useCityStore.setState({ activeCity: realCity });
  useGtfsDataStore.setState({ raptorIndex: null });
  useStopStore.setState({ stops: [] } as never);
});

describe("useNearbyDirections — nearest stop", () => {
  // No index: only the nearest-stop choice is under test here.
  beforeEach(() => {
    useGtfsDataStore.setState({ raptorIndex: null });
  });

  it("picks the nearest visible stop within 1 km", () => {
    const stops = [stop("P", "P", 0), stop("Q", "Q", 100)];
    const { result } = renderHook(() =>
      useNearbyDirections({ enabled: true, position: at(30), visibleStops: stops }));
    expect(result.current.nearestStop?.id).toBe("P");
  });

  it("no stop within 1 km → none", () => {
    const stops = [stop("P", "P", 0)];
    const { result } = renderHook(() =>
      useNearbyDirections({ enabled: true, position: at(1010), visibleStops: stops }));
    expect(result.current.nearestStop).toBeNull();
    expect(departuresForStop).not.toHaveBeenCalled();
  });

  it("hysteresis: a stop 10 m closer does not take over, 20 m closer does", () => {
    const stops = [stop("P", "P", 0), stop("Q", "Q", 100)];
    const { result, rerender } = renderHook((p: Props) => useNearbyDirections(p), {
      initialProps: { enabled: true, position: at(45), visibleStops: stops },
    });
    expect(result.current.nearestStop?.id).toBe("P");
    // P 52.5 m, Q 47.5 m: 5 m closer.
    rerender({ enabled: true, position: at(52.5), visibleStops: stops });
    expect(result.current.nearestStop?.id).toBe("P");
    // P 55 m, Q 45 m: 10 m closer.
    rerender({ enabled: true, position: at(55), visibleStops: stops });
    expect(result.current.nearestStop?.id).toBe("P");
    // P 60 m, Q 40 m: 20 m closer.
    rerender({ enabled: true, position: at(60), visibleStops: stops });
    expect(result.current.nearestStop?.id).toBe("Q");
  });

  it("hysteresis boundary: 14.9 m closer keeps the stop, 15.1 m closer takes over", () => {
    const stops = [stop("P", "P", 0), stop("Q", "Q", 100)];
    const { result, rerender } = renderHook((p: Props) => useNearbyDirections(p), {
      initialProps: { enabled: true, position: at(40), visibleStops: stops },
    });
    expect(result.current.nearestStop?.id).toBe("P");
    // P 57.45 m, Q 42.55 m: 14.9 m closer.
    rerender({ enabled: true, position: at(57.45), visibleStops: stops });
    expect(result.current.nearestStop?.id).toBe("P");
    // P 57.55 m, Q 42.45 m: 15.1 m closer.
    rerender({ enabled: true, position: at(57.55), visibleStops: stops });
    expect(result.current.nearestStop?.id).toBe("Q");
  });

  it("1 km cap boundary: 999.9 m is in, 1000.1 m is out", () => {
    const stops = [stop("P", "P", 0)];
    const { result, rerender } = renderHook((p: Props) => useNearbyDirections(p), {
      initialProps: { enabled: true, position: at(999.9), visibleStops: stops },
    });
    expect(result.current.nearestStop?.id).toBe("P");
    rerender({ enabled: true, position: at(1000.1), visibleStops: stops });
    expect(result.current.nearestStop).toBeNull();
  });

  it("a previous stop beyond 1 km is dropped, even when the new one is barely closer", () => {
    const stops = [stop("P", "P", 0), stop("Q", "Q", 2000)];
    const { result, rerender } = renderHook((p: Props) => useNearbyDirections(p), {
      initialProps: { enabled: true, position: at(995), visibleStops: stops },
    });
    expect(result.current.nearestStop?.id).toBe("P");
    // P 1005 m (past the cap), Q 995 m: only 10 m closer, but P is gone.
    rerender({ enabled: true, position: at(1005), visibleStops: stops });
    expect(result.current.nearestStop?.id).toBe("Q");
  });

  it("a city change resets the hysteresis", () => {
    const stops = [stop("P", "P", 0), stop("Q", "Q", 100)];
    const { result, rerender } = renderHook((p: Props) => useNearbyDirections(p), {
      initialProps: { enabled: true, position: at(45), visibleStops: stops },
    });
    rerender({ enabled: true, position: at(55), visibleStops: stops });
    expect(result.current.nearestStop?.id).toBe("P");
    act(() => {
      useCityStore.setState({ activeCity: { ...realCity, id: "elsewhere", tz: "UTC" } });
    });
    expect(result.current.nearestStop?.id).toBe("Q");
  });
});

describe("useNearbyDirections — sides and departures", () => {
  it("S departures come from useDepartures, the other stops' from departuresForStops", async () => {
    const { result } = renderHook(() =>
      useNearbyDirections({ enabled: true, position: USER, visibleStops: STREET }));

    await waitFor(() => {
      const bottom1 = sideOf(result.current.sides, "1", "bottom");
      expect(bottom1 && result.current.departuresBySide.get(bottom1)).toEqual([R_DEPS[0]]);
    });
    expect(result.current.nearestStop?.id).toBe("S");
    expect(result.current.sides.map((s) => `${s.row}:${s.stopId}:${s.routeId}:${s.dirKey}`)).toEqual([
      "top:S:1:d0", "top:S:2:d0", "bottom:R:1:d1", "bottom:R:2:d1",
    ]);
    const { sides, departuresBySide } = result.current;
    expect(departuresBySide.get(sideOf(sides, "1", "top")!)).toEqual([S_DEPS[0]]);
    expect(departuresBySide.get(sideOf(sides, "2", "top")!)).toEqual([S_DEPS[1]]);
    expect(departuresBySide.get(sideOf(sides, "2", "bottom")!)).toEqual([R_DEPS[1]]);

    // S through the single-stop path (same look-ahead as today's strip)…
    expect(departuresForStop).toHaveBeenCalledTimes(1);
    expect(vi.mocked(departuresForStop).mock.calls[0][0]).toMatchObject({ stopId: "S", lookAheadHours: 1 });
    // …every other stop through the tile-only batch, S never in it.
    expect(departuresForStops).toHaveBeenCalledTimes(1);
    expect(departuresForStops).toHaveBeenCalledWith({
      stopIds: ["R"],
      lookAheadHours: 1,
      signal: expect.any(AbortSignal),
    });
  });

  it("starts the batch only once S's read has finished", async () => {
    let resolveS!: (v: unknown) => void;
    vi.mocked(departuresForStop).mockImplementation(() => new Promise((r) => { resolveS = r; }) as never);
    const { result } = renderHook(() =>
      useNearbyDirections({ enabled: true, position: USER, visibleStops: STREET }));

    await waitFor(() => expect(result.current.loading).toBe(true));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    // S and the pole across the street share a tile: never resolved side by side.
    expect(departuresForStops).not.toHaveBeenCalled();

    await act(async () => {
      resolveS({ state: "ok", departures: S_DEPS, serviceState: "normal" });
    });
    await waitFor(() => expect(departuresForStops).toHaveBeenCalledTimes(1));
  });

  it("position jitter that keeps S → no re-resolve and no refetch", async () => {
    const { result, rerender } = renderHook((p: Props) => useNearbyDirections(p), {
      initialProps: { enabled: true, position: USER, visibleStops: STREET },
    });
    await waitFor(() => expect(departuresForStops).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const resolves = vi.mocked(resolveNearbySides).mock.calls.length;

    rerender({ enabled: true, position: at(-11, 1), visibleStops: STREET });
    rerender({ enabled: true, position: at(-9, -1), visibleStops: STREET });

    expect(result.current.nearestStop?.id).toBe("S");
    expect(vi.mocked(resolveNearbySides).mock.calls.length).toBe(resolves);
    expect(departuresForStop).toHaveBeenCalledTimes(1);
    expect(departuresForStops).toHaveBeenCalledTimes(1);
  });

  it("loading reflects S only: S done → not loading, and the other row fills in later", async () => {
    let resolveS!: (v: unknown) => void;
    vi.mocked(departuresForStop).mockImplementation(() => new Promise((r) => { resolveS = r; }) as never);
    let resolveOthers!: (v: Map<string, Departure[]>) => void;
    vi.mocked(departuresForStops).mockImplementation(() => new Promise((r) => { resolveOthers = r; }));
    const { result } = renderHook(() =>
      useNearbyDirections({ enabled: true, position: USER, visibleStops: STREET }));

    await waitFor(() => expect(result.current.loading).toBe(true));

    await act(async () => {
      resolveS({ state: "ok", departures: S_DEPS, serviceState: "normal" });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(departuresForStops).toHaveBeenCalledTimes(1));
    const bottom1 = sideOf(result.current.sides, "1", "bottom")!;
    expect(result.current.departuresBySide.get(bottom1)).toEqual([]);

    await act(async () => {
      resolveOthers(new Map([["R", R_DEPS]]));
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.departuresBySide.get(sideOf(result.current.sides, "1", "bottom")!)).toEqual([R_DEPS[0]]);
  });

  it("walking up to S brings the far side within reach: the pairing follows the rider", async () => {
    // From 600 m south, R (across the street) is past the 500 m reverse radius.
    const { result, rerender } = renderHook((p: Props) => useNearbyDirections(p), {
      initialProps: { enabled: true, position: at(-600), visibleStops: STREET },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sides.map((s) => s.row)).toEqual(["top", "top"]);
    const resolves = vi.mocked(resolveNearbySides).mock.calls.length;

    // 60 m on: S is still nearest and the pairing stays where it was resolved.
    rerender({ enabled: true, position: at(-540), visibleStops: STREET });
    expect(vi.mocked(resolveNearbySides).mock.calls.length).toBe(resolves);

    // 150 m on: resolved again from here; R is 450 m away now.
    rerender({ enabled: true, position: at(-450), visibleStops: STREET });
    expect(result.current.nearestStop?.id).toBe("S");
    await waitFor(() => {
      const bottom1 = sideOf(result.current.sides, "1", "bottom");
      expect(bottom1 && result.current.departuresBySide.get(bottom1)).toEqual([R_DEPS[0]]);
    });
    expect(departuresForStops).toHaveBeenCalledTimes(1);
    expect(vi.mocked(departuresForStops).mock.calls[0][0].stopIds).toEqual(["R"]);
    // S itself was never refetched.
    expect(departuresForStop).toHaveBeenCalledTimes(1);
  });

  it("a new nearest stop whose read fails never shows the previous stop's departures as its own", async () => {
    // T, 300 m north, is unknown to the index: every side there would be a
    // route-level side built from the departures read for it.
    const T = stop("T", "Far St", 300);
    const stops = [...STREET, T];
    useStopStore.setState({ stops, hydrated: true } as never);
    vi.mocked(departuresForStop).mockImplementation(async ({ stopId }) =>
      (stopId === "T"
        ? { state: "unavailable" }
        : { state: "ok", departures: stopId === "S" ? S_DEPS : [], serviceState: "normal" }) as never);
    // The policy-gated fallback for T fails too (offline, 4xx, 5xx).
    vi.mocked(api.getDepartures).mockRejectedValue(new Error("offline"));
    const sTrips = new Set(S_DEPS.map((d) => d.tripId));
    // Every committed frame: a stale list shown for one frame is still shown.
    const tFrames: { sides: string[]; tripIds: string[]; loading: boolean }[] = [];
    const { result, rerender } = renderHook((p: Props) => {
      const r = useNearbyDirections(p);
      useLayoutEffect(() => {
        if (r.nearestStop?.id !== "T") return;
        tFrames.push({
          sides: r.sides.map((s) => `${s.stopId}:${s.routeId}`),
          tripIds: [...r.departuresBySide.values()].flat().map((d) => d.tripId),
          loading: r.loading,
        });
      });
      return r;
    }, { initialProps: { enabled: true, position: USER, visibleStops: stops } });
    await waitFor(() => {
      const top1 = sideOf(result.current.sides, "1", "top");
      expect(top1 && result.current.departuresBySide.get(top1)).toEqual([S_DEPS[0]]);
    });

    rerender({ enabled: true, position: at(290), visibleStops: stops });
    expect(result.current.nearestStop?.id).toBe("T");
    await waitFor(() => expect(api.getDepartures).toHaveBeenCalledWith("T", undefined, expect.any(Number), 1));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // No side at T for S's lines, and not one S departure anywhere.
    expect(result.current.sides).toEqual([]);
    expect(tFrames.length).toBeGreaterThan(0);
    for (const frame of tFrames) {
      expect(frame.sides).toEqual([]);
      expect(frame.tripIds.filter((id) => sTrips.has(id))).toEqual([]);
    }
    // T's first frame already reads as loading.
    expect(tFrames[0].loading).toBe(true);
  });

  it("S settled while the other stops are still pending → not loading, bottom sides empty", async () => {
    vi.mocked(departuresForStops).mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() =>
      useNearbyDirections({ enabled: true, position: USER, visibleStops: STREET }));

    await waitFor(() => {
      const top1 = sideOf(result.current.sides, "1", "top")!;
      expect(result.current.departuresBySide.get(top1)).toEqual([S_DEPS[0]]);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.departuresBySide.get(sideOf(result.current.sides, "1", "bottom")!)).toEqual([]);
  });
});

describe("useNearbyDirections — the other stops' batch over time", () => {
  /** Every `departuresForStops` call, left pending until the test settles it. */
  function deferBatches() {
    const pending: { stopIds: string[]; signal?: AbortSignal; settle: (m: Map<string, Departure[]>) => void }[] = [];
    vi.mocked(departuresForStops).mockImplementation(({ stopIds, signal }) =>
      new Promise((settle) => { pending.push({ stopIds, signal, settle }); }));
    return pending;
  }

  it("a superseded batch that lands late never overwrites the newer one", async () => {
    // A second street 300 m north: S2 on the user's side, R2 across.
    const S2 = stop("S2", "North St", 300);
    const R2 = stop("R2", "North St", 300, 20);
    const stops = [S, R, S2, R2];
    useStopStore.setState({ stops } as never);
    useGtfsDataStore.setState({
      raptorIndex: patternIndex([
        directedPattern("1", ["A", "S", "B"], "t1", 0),
        directedPattern("1", ["B", "R", "A"], "t2", 1),
        directedPattern("3", ["E", "S2", "F"], "t5", 0),
        directedPattern("3", ["F", "R2", "E"], "t6", 1),
      ]),
    });
    const S2_DEPS = [dep("3", "t5", 3)];
    const R2_DEPS = [dep("3", "t6", 5)];
    vi.mocked(departuresForStop).mockImplementation(async ({ stopId }) => ({
      state: "ok",
      departures: stopId === "S" ? S_DEPS : S2_DEPS,
      serviceState: "normal",
    }) as never);
    const batches = deferBatches();

    const { result, rerender } = renderHook((p: Props) => useNearbyDirections(p), {
      initialProps: { enabled: true, position: USER, visibleStops: stops },
    });
    await waitFor(() => expect(batches).toHaveLength(1));
    expect(batches[0].stopIds).toEqual(["R"]);

    // The rider moves on before batch A lands: S2 is now the nearest stop.
    rerender({ enabled: true, position: at(290), visibleStops: stops });
    await waitFor(() => expect(batches).toHaveLength(2));
    expect(batches[1].stopIds).toEqual(["R2"]);
    expect(batches[0].signal?.aborted).toBe(true);

    await act(async () => batches[1].settle(new Map([["R2", R2_DEPS]])));
    await act(async () => batches[0].settle(new Map([["R", R_DEPS]])));

    expect(result.current.nearestStop?.id).toBe("S2");
    const bottom = sideOf(result.current.sides, "3", "bottom")!;
    expect(bottom.stopId).toBe("R2");
    expect(result.current.departuresBySide.get(bottom)).toEqual(R2_DEPS);
    expect([...result.current.departuresBySide.values()].flat()).not.toContain(R_DEPS[0]);
  });

  it("a stop arriving late in the store completes a pair: one batch for it, S not refetched", async () => {
    useStopStore.setState({ stops: [S] } as never);
    const { result } = renderHook(() =>
      useNearbyDirections({ enabled: true, position: USER, visibleStops: [S] }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(departuresForStops).not.toHaveBeenCalled();
    expect(result.current.sides.every((s) => s.row === "top")).toBe(true);

    act(() => useStopStore.setState({ stops: STREET } as never));

    await waitFor(() => {
      const bottom1 = sideOf(result.current.sides, "1", "bottom");
      expect(bottom1 && result.current.departuresBySide.get(bottom1)).toEqual([R_DEPS[0]]);
    });
    expect(departuresForStops).toHaveBeenCalledTimes(1);
    expect(vi.mocked(departuresForStops).mock.calls[0][0].stopIds).toEqual(["R"]);
    expect(departuresForStop).toHaveBeenCalledTimes(1);
  });

  it("switched off mid-batch: the batch is aborted and its rows are never shown again", async () => {
    const { result, rerender } = renderHook((p: Props) => useNearbyDirections(p), {
      initialProps: { enabled: true, position: USER, visibleStops: STREET },
    });
    await waitFor(() => {
      const bottom1 = sideOf(result.current.sides, "1", "bottom");
      expect(bottom1 && result.current.departuresBySide.get(bottom1)).toEqual([R_DEPS[0]]);
    });

    // Off (a departure sheet), then on again with the next batch still out.
    rerender({ enabled: false, position: USER, visibleStops: STREET });
    const batches = deferBatches();
    rerender({ enabled: true, position: USER, visibleStops: STREET });
    await waitFor(() => expect(batches).toHaveLength(1));
    // The first batch's rows are gone: nothing stale shows while this one is out.
    const bottom1 = sideOf(result.current.sides, "1", "bottom")!;
    expect(result.current.departuresBySide.get(bottom1)).toEqual([]);

    // Off again before it lands: aborted, and nothing it returns is shown.
    rerender({ enabled: false, position: USER, visibleStops: STREET });
    expect(batches[0].signal?.aborted).toBe(true);
    await act(async () => batches[0].settle(new Map([["R", R_DEPS]])));
    expect(result.current.sides).toEqual([]);
    expect(result.current.departuresBySide.size).toBe(0);
  });
});

describe("useNearbyDirections — privacy", () => {
  it("api.getDepartures is never called with a non-S stop id", async () => {
    // The tile cannot serve S → useDepartures' decision-gated fallback asks the
    // server about S. The other stops must never take that path.
    vi.mocked(departuresForStop).mockResolvedValue({ state: "unavailable" } as never);
    vi.mocked(departuresForStops).mockResolvedValue(new Map());
    renderHook(() => useNearbyDirections({ enabled: true, position: USER, visibleStops: STREET }));

    await waitFor(() => expect(api.getDepartures).toHaveBeenCalled());
    await waitFor(() => expect(departuresForStops).toHaveBeenCalled());
    for (const call of vi.mocked(api.getDepartures).mock.calls) expect(call[0]).toBe("S");
  });

  it("enabled: false → no fetch of any kind", async () => {
    const { result } = renderHook(() =>
      useNearbyDirections({ enabled: false, position: USER, visibleStops: STREET }));
    // Let any stray effect or dynamic import settle.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

    expect(departuresForStop).not.toHaveBeenCalled();
    expect(departuresForStops).not.toHaveBeenCalled();
    expect(api.getDepartures).not.toHaveBeenCalled();
    expect(result.current.nearestStop).toBeNull();
    expect(result.current.sides).toEqual([]);
    expect(result.current.departuresBySide.size).toBe(0);
    expect(result.current.loading).toBe(false);
  });

  it("switching to disabled stops fetching; nothing more is asked", async () => {
    const { rerender } = renderHook((p: Props) => useNearbyDirections(p), {
      initialProps: { enabled: true, position: USER, visibleStops: STREET },
    });
    await waitFor(() => expect(departuresForStops).toHaveBeenCalledTimes(1));
    rerender({ enabled: false, position: at(-12), visibleStops: STREET });
    rerender({ enabled: false, position: at(40), visibleStops: STREET });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(departuresForStop).toHaveBeenCalledTimes(1);
    expect(departuresForStops).toHaveBeenCalledTimes(1);
  });
});

describe("useNearbyDirections — without a pattern index", () => {
  async function expectOnlyS(): Promise<void> {
    const { result } = renderHook(() =>
      useNearbyDirections({ enabled: true, position: USER, visibleStops: STREET }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.sides.length).toBe(2));

    const { sides, departuresBySide } = result.current;
    expect(sides.every((s) => s.stopId === "S" && s.row === "top")).toBe(true);
    expect(sides.map((s) => s.routeId)).toEqual(["1", "2"]);
    expect([...departuresBySide.values()].flat()).toEqual(S_DEPS);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(departuresForStops).not.toHaveBeenCalled();
  }

  it("raptorIndex null → only S, today's behaviour", async () => {
    useGtfsDataStore.setState({ raptorIndex: null });
    await expectOnlyS();
  });

  it("patterns absent (PatternMode Off / Dexie fallback) → only S, today's behaviour", async () => {
    useGtfsDataStore.setState({ raptorIndex: patternIndex(undefined) });
    await expectOnlyS();
  });

  it("S unknown to the index's patternsAtStop → only S, every departure kept (known trips too)", async () => {
    // t1 is a known trip (its pattern keys it d0) but no pattern lists S.
    useGtfsDataStore.setState({ raptorIndex: patternIndex([directedPattern("1", ["A", "X", "B"], "t1", 0)]) });
    await expectOnlyS();
  });

  it("a route the index does not list at S still gets a side there", async () => {
    // Tiles from a newer bundle than the index: route 9 is new at S.
    const newLine = dep("9", "t9", 2);
    vi.mocked(departuresForStop).mockResolvedValue({
      state: "ok",
      departures: [...S_DEPS, newLine],
      serviceState: "normal",
    } as never);
    useGtfsDataStore.setState({ raptorIndex: STREET_INDEX });
    const { result } = renderHook(() =>
      useNearbyDirections({ enabled: true, position: USER, visibleStops: STREET }));
    await waitFor(() => expect(sideOf(result.current.sides, "9", "top")).toBeDefined());

    const side9 = sideOf(result.current.sides, "9", "top")!;
    expect(side9.stopId).toBe("S");
    expect(result.current.departuresBySide.get(side9)).toEqual([newLine]);
    expect(result.current.departuresBySide.get(sideOf(result.current.sides, "1", "top")!)).toEqual([S_DEPS[0]]);
    // The index's own sides are unchanged, the batch still asks for R only.
    await waitFor(() => expect(departuresForStops).toHaveBeenCalledTimes(1));
    expect(vi.mocked(departuresForStops).mock.calls[0][0].stopIds).toEqual(["R"]);
  });

  it("an S route with two headsigns stays one side and keeps both departures", async () => {
    useGtfsDataStore.setState({ raptorIndex: null });
    const both = [dep("1", "x1", 2), { ...dep("1", "x2", 4), headsign: "Other way" }];
    vi.mocked(departuresForStop).mockResolvedValue({ state: "ok", departures: both, serviceState: "normal" } as never);
    const { result } = renderHook(() =>
      useNearbyDirections({ enabled: true, position: USER, visibleStops: STREET }));
    await waitFor(() => expect(result.current.sides.length).toBe(1));
    expect(result.current.departuresBySide.get(result.current.sides[0])).toEqual(both);
  });

  it("position null → nothing", async () => {
    const { result } = renderHook(() =>
      useNearbyDirections({ enabled: true, position: null, visibleStops: STREET }));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(result.current.nearestStop).toBeNull();
    expect(result.current.sides).toEqual([]);
    expect(departuresForStop).not.toHaveBeenCalled();
    expect(departuresForStops).not.toHaveBeenCalled();
  });
});
