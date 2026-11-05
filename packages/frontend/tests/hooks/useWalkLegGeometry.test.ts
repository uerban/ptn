import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useWalkLegGeometry } from "../../src/hooks/useWalkLegGeometry.ts";
import { clearWalkRouteCache } from "../../src/services/walkRouteCache.ts";

beforeEach(() => clearWalkRouteCache());

describe("useWalkLegGeometry", () => {
  it("draws endpoints while pending, then the walk-graph path", async () => {
    const coords = [[0, 0], [0.5, 0.2], [1, 1]] as [number, number][];
    const source = { routeFor: vi.fn(async () => ({ coords, distanceMeters: 100, steps: [] })) };
    const { result } = renderHook(() => useWalkLegGeometry({ lat: 0, lon: 0 }, { lat: 1, lon: 1 }, source));
    expect(result.current.source).toBe("endpoints");
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(result.current.source).toBe("walk-graph"));
    expect(result.current.coords).toEqual(coords);
    expect(result.current.pending).toBe(false);
  });

  it("keeps the same coords between renders until the route or endpoints change", async () => {
    const coords = [[0, 0], [0.5, 0.2], [1, 1]] as [number, number][];
    const source = { routeFor: vi.fn(async () => ({ coords, distanceMeters: 100, steps: [] })) };
    const { result, rerender } = renderHook(
      ({ to }) => useWalkLegGeometry({ lat: 0, lon: 0 }, to, source),
      { initialProps: { to: { lat: 1, lon: 1 } } },
    );
    const pendingCoords = result.current.coords;
    rerender({ to: { lat: 1, lon: 1 } }); // fresh objects, same points
    expect(result.current.coords).toBe(pendingCoords);
    await waitFor(() => expect(result.current.source).toBe("walk-graph"));
    const routed = result.current.coords;
    rerender({ to: { lat: 1, lon: 1 } });
    expect(result.current.coords).toBe(routed);
    rerender({ to: { lat: 2, lon: 2 } });
    expect(result.current.coords).not.toBe(routed);
  });

  it("falls back to endpoints, not pending, when there is no route", async () => {
    const source = { routeFor: vi.fn(async () => null) };
    const { result } = renderHook(() => useWalkLegGeometry({ lat: 0, lon: 0 }, { lat: 1, lon: 1 }, source));
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.source).toBe("endpoints");
  });
});
