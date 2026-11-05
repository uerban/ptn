import { beforeEach, describe, it, expect } from "vitest";
import {
  hasCityBeenPrefetched,
  markCityPrefetched,
  usePrivacyStore,
} from "./privacyStore.ts";

beforeEach(() => {
  globalThis.localStorage?.removeItem("ptn-privacy");
  usePrivacyStore.getState().reset();
});

describe("privacyStore — prefetchedCities", () => {
  it("starts empty", () => {
    expect(usePrivacyStore.getState().prefetchedCities).toEqual({});
    expect(hasCityBeenPrefetched("gdansk")).toBe(false);
  });

  it("markCityPrefetched records a timestamp", () => {
    markCityPrefetched("gdansk", 1234);
    expect(hasCityBeenPrefetched("gdansk")).toBe(true);
    expect(usePrivacyStore.getState().prefetchedCities).toEqual({
      gdansk: 1234,
    });
  });

  it("markCityPrefetched defaults to Date.now()", () => {
    const before = Date.now();
    markCityPrefetched("vilnius");
    const stamp = usePrivacyStore.getState().prefetchedCities.vilnius;
    const after = Date.now();
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);
  });

  it("tracks multiple cities independently", () => {
    markCityPrefetched("gdansk", 100);
    markCityPrefetched("vilnius", 200);
    expect(hasCityBeenPrefetched("gdansk")).toBe(true);
    expect(hasCityBeenPrefetched("vilnius")).toBe(true);
    expect(hasCityBeenPrefetched("sopot")).toBe(false);
  });

  it("clearPrefetchedCities wipes the map", () => {
    markCityPrefetched("gdansk", 100);
    markCityPrefetched("vilnius", 200);
    usePrivacyStore.getState().clearPrefetchedCities();
    expect(usePrivacyStore.getState().prefetchedCities).toEqual({});
    expect(hasCityBeenPrefetched("gdansk")).toBe(false);
  });

  it("reset clears prefetchedCities along with level/overrides", () => {
    markCityPrefetched("gdansk", 100);
    usePrivacyStore.getState().reset();
    expect(usePrivacyStore.getState().prefetchedCities).toEqual({});
  });

  it("partialize: prefetchedCities is not persisted", () => {
    markCityPrefetched("gdansk", 100);
    const raw = localStorage.getItem("ptn-privacy");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    const persistedState = parsed.state ?? parsed;
    expect(persistedState.prefetchedCities).toBeUndefined();
  });
});
