import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  __walkRouteCacheSize,
  clearWalkRouteCache,
  getOrFetchWalkRoute,
  peekWalkRoute,
  walkRouteKey,
} from "../../src/services/walkRouteCache.ts";
import { WalkGraphUnavailableError, type WalkRoute } from "../../src/services/walkGraphClient.ts";

const A = { lat: 54.68, lon: 25.28 };
const B = { lat: 54.681, lon: 25.281 };
const ROUTE: WalkRoute = { coords: [[25.28, 54.68], [25.281, 54.681]], distanceMeters: 130, steps: [] };

beforeEach(() => clearWalkRouteCache());

describe("walkRouteCache", () => {
  it("keys by city, profile and ~1 m rounded endpoints", () => {
    expect(walkRouteKey("vilnius", A, B, "default")).toBe("vilnius|default|54.68,25.28|54.681,25.281");
    expect(walkRouteKey("vilnius", { lat: 54.680001, lon: 25.28 }, B, "default")).toBe(walkRouteKey("vilnius", A, B, "default"));
    expect(walkRouteKey("vilnius", A, B, "wheelchair")).not.toBe(walkRouteKey("vilnius", A, B, "default"));
  });

  it("fetches once, then serves from cache (including null)", async () => {
    const source = { routeFor: vi.fn(async () => ROUTE) };
    expect(peekWalkRoute("vilnius", A, B, "default")).toBeUndefined();
    const [r1, r2] = await Promise.all([
      getOrFetchWalkRoute("vilnius", A, B, "default", source),
      getOrFetchWalkRoute("vilnius", A, B, "default", source),
    ]);
    expect(r1).toBe(ROUTE);
    expect(r2).toBe(ROUTE);
    expect(source.routeFor).toHaveBeenCalledTimes(1);
    expect(peekWalkRoute("vilnius", A, B, "default")).toBe(ROUTE);

    const none = { routeFor: vi.fn(async () => null) };
    expect(await getOrFetchWalkRoute("vilnius", B, A, "default", none)).toBeNull();
    expect(peekWalkRoute("vilnius", B, A, "default")).toBeNull();
  });

  it("expires a cached missing graph so a new release can be used", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
    try {
      const source = {routeFor: vi.fn<() => Promise<WalkRoute | null>>().mockResolvedValueOnce(null).mockResolvedValueOnce(ROUTE)};
      expect(await getOrFetchWalkRoute("vilnius", A, B, "default", source)).toBeNull();
      clock.mockReturnValue(160_001);
      expect(peekWalkRoute("vilnius", A, B, "default")).toBeUndefined();
      expect(await getOrFetchWalkRoute("vilnius", A, B, "default", source)).toEqual(ROUTE);
    } finally {clock.mockRestore();}
  });

  it("passes a rejection through without caching it", async () => {
    const err = new WalkGraphUnavailableError("vilnius", "transient");
    const source = { routeFor: vi.fn(async () => { throw err; }) };
    await expect(getOrFetchWalkRoute("vilnius", A, B, "default", source)).rejects.toBe(err);
    expect(peekWalkRoute("vilnius", A, B, "default")).toBeUndefined();
  });

  it("asks again after a transient failure, then caches the real route", async () => {
    const source = {
      routeFor: vi
        .fn<() => Promise<WalkRoute | null>>()
        .mockRejectedValueOnce(new WalkGraphUnavailableError("vilnius", "transient"))
        .mockResolvedValueOnce(ROUTE),
    };
    await expect(getOrFetchWalkRoute("vilnius", A, B, "default", source)).rejects.toThrow();
    expect(await getOrFetchWalkRoute("vilnius", A, B, "default", source)).toBe(ROUTE);
    expect(source.routeFor).toHaveBeenCalledTimes(2);
    expect(peekWalkRoute("vilnius", A, B, "default")).toBe(ROUTE);
  });

  it("does not cache an answer that arrives after a clear", async () => {
    let resolve!: (r: WalkRoute) => void;
    const source = { routeFor: vi.fn(() => new Promise<WalkRoute>((r) => { resolve = r; })) };
    const pending = getOrFetchWalkRoute("vilnius", A, B, "default", source);
    clearWalkRouteCache();
    resolve(ROUTE);
    expect(await pending).toBe(ROUTE);
    expect(peekWalkRoute("vilnius", A, B, "default")).toBeUndefined();
  });

  it("evicts the oldest entry past the cap", async () => {
    const source = { routeFor: vi.fn(async () => ROUTE) };
    for (let i = 0; i < 510; i++) {
      await getOrFetchWalkRoute("vilnius", { lat: 54 + i * 0.001, lon: 25 }, B, "default", source);
    }
    expect(__walkRouteCacheSize()).toBe(500);
    expect(peekWalkRoute("vilnius", { lat: 54, lon: 25 }, B, "default")).toBeUndefined();
  });
});
