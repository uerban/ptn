import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useWalkRoute, WALK_ROUTE_RETRY_MS } from "../../src/hooks/useWalkRoute.ts";
import { clearWalkRouteCache } from "../../src/services/walkRouteCache.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { useCityStore } from "../../src/stores/cityStore.ts";
import { WalkGraphUnavailableError, type WalkRoute } from "../../src/services/walkGraphClient.ts";

const A = { lat: 54.68, lon: 25.28 };
const B = { lat: 54.681, lon: 25.281 };
const ROUTE: WalkRoute = { coords: [[25.28, 54.68], [25.281, 54.681]], distanceMeters: 130, steps: [] };

beforeEach(() => {
  clearWalkRouteCache();
  useSettingsStore.setState({ mobilityProfile: "default" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useWalkRoute", () => {
  it("is pending, then resolves with the route for the active city", async () => {
    const source = { routeFor: vi.fn(async () => ROUTE) };
    const { result } = renderHook(() => useWalkRoute(A, B, source));
    expect(result.current).toEqual({ route: null, pending: true });
    await waitFor(() => expect(result.current).toEqual({ route: ROUTE, pending: false }));
    const cityId = useCityStore.getState().activeCity.id;
    expect(source.routeFor).toHaveBeenCalledWith(cityId, A, B, "default");
  });

  it("asks for a wheelchair route when the profile says so", async () => {
    useSettingsStore.setState({ mobilityProfile: "wheelchair" });
    const source = { routeFor: vi.fn(async () => ROUTE) };
    renderHook(() => useWalkRoute(A, B, source));
    await waitFor(() => expect(source.routeFor).toHaveBeenCalled());
    expect(source.routeFor.mock.calls[0]![3]).toBe("wheelchair");
  });

  it("settles to no route without pending when there is none", async () => {
    const source = { routeFor: vi.fn(async () => null) };
    const { result } = renderHook(() => useWalkRoute(A, B, source));
    await waitFor(() => expect(result.current).toEqual({ route: null, pending: false }));
  });

  it("answers synchronously from the cache on remount", async () => {
    const source = { routeFor: vi.fn(async () => ROUTE) };
    const first = renderHook(() => useWalkRoute(A, B, source));
    await waitFor(() => expect(first.result.current.pending).toBe(false));
    const second = renderHook(() => useWalkRoute(A, B, source));
    expect(second.result.current).toEqual({ route: ROUTE, pending: false });
    expect(source.routeFor).toHaveBeenCalledTimes(1);
  });

  it("after a transient failure draws no route, waits, then asks once more", async () => {
    vi.useFakeTimers();
    const source = {
      routeFor: vi
        .fn<() => Promise<WalkRoute | null>>()
        .mockRejectedValueOnce(new WalkGraphUnavailableError("vilnius", "transient"))
        .mockResolvedValueOnce(ROUTE),
    };
    const { result } = renderHook(() => useWalkRoute(A, B, source));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current).toEqual({ route: null, pending: false });
    // No retry loop: re-renders do not re-ask inside the window.
    await act(async () => { await vi.advanceTimersByTimeAsync(WALK_ROUTE_RETRY_MS - 1); });
    expect(source.routeFor).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(source.routeFor).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ route: ROUTE, pending: false });
  });

  it("keeps re-asking through a longer outage until the route comes", async () => {
    vi.useFakeTimers();
    const source = {
      routeFor: vi
        .fn<() => Promise<WalkRoute | null>>()
        .mockRejectedValueOnce(new WalkGraphUnavailableError("vilnius", "transient"))
        .mockRejectedValueOnce(new WalkGraphUnavailableError("vilnius", "transient"))
        .mockResolvedValueOnce(ROUTE),
    };
    const { result } = renderHook(() => useWalkRoute(A, B, source));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current).toEqual({ route: null, pending: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(WALK_ROUTE_RETRY_MS); });
    expect(source.routeFor).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ route: null, pending: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(WALK_ROUTE_RETRY_MS); });
    expect(source.routeFor).toHaveBeenCalledTimes(3);
    expect(result.current).toEqual({ route: ROUTE, pending: false });
  });

  it("asks nothing and answers no route without endpoints", async () => {
    const source = { routeFor: vi.fn(async () => ROUTE) };
    const { result } = renderHook(() => useWalkRoute(null, null, source));
    expect(result.current).toEqual({ route: null, pending: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(source.routeFor).not.toHaveBeenCalled();
  });

  it("does not retry after unmount", async () => {
    vi.useFakeTimers();
    const source = {
      routeFor: vi.fn(async (): Promise<WalkRoute | null> => {
        throw new WalkGraphUnavailableError("vilnius", "transient");
      }),
    };
    const { unmount } = renderHook(() => useWalkRoute(A, B, source));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(WALK_ROUTE_RETRY_MS * 3); });
    expect(source.routeFor).toHaveBeenCalledTimes(1);
  });
});
