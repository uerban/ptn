import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the gtfsBundleBytes module BEFORE importing cityStore so the
// eviction call on setActiveCity is observable. cityStore eagerly
// imports `evictPtbBytes` at module load. `vi.hoisted` is required
// because vi.mock is hoisted above all top-level statements — a
// plain `const` declaration would TDZ-trap when the factory runs.
const { evictPtbBytesMock } = vi.hoisted(() => ({
  evictPtbBytesMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/gtfsBundleBytes.ts", () => ({
  evictPtbBytes: evictPtbBytesMock,
}));

import { useCityStore } from "../../src/stores/cityStore.ts";
import { CITIES } from "../../src/config/cities.ts";
import { db } from "../../src/db/index.ts";

describe("cityStore", () => {
  beforeEach(() => {
    useCityStore.setState({ activeCity: CITIES[0] });
    evictPtbBytesMock.mockClear();
  });

  it("defaults to first city (vilnius)", () => {
    expect(useCityStore.getState().activeCity.id).toBe("vilnius");
  });

  it("setActiveCity switches city", () => {
    const tricity = CITIES.find((c) => c.id === "tricity")!;
    useCityStore.getState().setActiveCity(tricity);
    expect(useCityStore.getState().activeCity.id).toBe("tricity");
  });

  it("getApiUrl returns /api/{cityId} for the active city", () => {
    const url = useCityStore.getState().getApiUrl();
    expect(url).toBe("/api/vilnius");
  });

  it("migrates stored gdansk to tricity on hydration", () => {
    // Simulate what zustand persist merge does with stale localStorage data
    const { merge } = (useCityStore as unknown as { persist: { getOptions: () => { merge: (p: unknown, c: unknown) => unknown } } }).persist.getOptions();
    const stale = { activeCity: { id: "gdansk" } };
    const current = useCityStore.getState();
    const merged = merge(stale, current) as { activeCity: { id: string } };
    expect(merged.activeCity.id).toBe("tricity");
  });

  it("keeps a persisted available city on hydration", () => {
    // The plain rehydration case: a stored id that still maps to an available
    // CITIES entry wins over the store's default, with no remapping.
    const { merge } = (useCityStore as unknown as { persist: { getOptions: () => { merge: (p: unknown, c: unknown) => unknown } } }).persist.getOptions();
    const stale = { activeCity: { id: "krakow" } };
    const current = useCityStore.getState();
    const merged = merge(stale, current) as { activeCity: { id: string } };
    expect(merged.activeCity.id).toBe("krakow");
  });

  it("evicts the previous city's PTB bytes on city switch (panel DB F3)", async () => {
    // Cache-poison guard: db.ptbBytes is keyed by cityId, so a `put` for
    // the new city doesn't overwrite the prior city's ~5 MB row. Without
    // this eviction, hopping between cities accumulates bytes indefinitely.
    const tricity = CITIES.find((c) => c.id === "tricity")!;
    useCityStore.getState().setActiveCity(tricity);
    // setActiveCity fires-and-forgets the eviction; await a microtask
    // tick so the mocked promise's `.then` has a chance to run before
    // we assert.
    await Promise.resolve();
    expect(evictPtbBytesMock).toHaveBeenCalledTimes(1);
    expect(evictPtbBytesMock).toHaveBeenCalledWith("vilnius");
  });

  it("does not evict when setActiveCity is called with the same city", () => {
    // Idempotent re-selection of the same city must not delete bytes —
    // the next RAPTOR query would have to re-download the full PTB
    // bundle for no reason.
    const vilnius = CITIES[0];
    useCityStore.getState().setActiveCity(vilnius);
    expect(evictPtbBytesMock).not.toHaveBeenCalled();
  });

  it("swallows eviction errors so the city switch still succeeds", async () => {
    // A transient IDB error (quota, locked tab, schema-upgrade race) must
    // not block the UI swap; the next visit recovers via the network-
    // first PTB fetcher. We just log + drop the error.
    evictPtbBytesMock.mockRejectedValueOnce(new Error("idb down"));
    const tricity = CITIES.find((c) => c.id === "tricity")!;
    expect(() => useCityStore.getState().setActiveCity(tricity)).not.toThrow();
    expect(useCityStore.getState().activeCity.id).toBe("tricity");
    // Drain the rejected promise so the unhandled-rejection tracker is happy.
    await new Promise((r) => setTimeout(r, 0));
  });

  it("drops persisted activeCity if its CITIES entry is no longer available", () => {
    // A removed or disabled city must not survive rehydration and send every
    // fetch to an unavailable backend.
    const { merge } = (useCityStore as unknown as { persist: { getOptions: () => { merge: (p: unknown, c: unknown) => unknown } } }).persist.getOptions();
    const stale = { activeCity: { id: "retired-city" } };
    const current = useCityStore.getState();
    const merged = merge(stale, current) as { activeCity: { id: string } };
    expect(merged.activeCity.id).toBe(current.activeCity.id);
    expect(merged.activeCity.id).not.toBe("retired-city");
  });
  it("rehydrate evicts other cities' cached bytes (F10)", async () => {
    // Cold start straight into city B bypasses setActiveCity's transition
    // eviction — the persist onRehydrateStorage hook must sweep instead.
    //
    // The module-import-time rehydrate hook (active city vilnius) is parked
    // on db-ready; opening the DB here releases it. Flush it BEFORE seeding
    // so its eviction can't race the rows this test asserts on.
    await db.open();
    await new Promise((r) => setTimeout(r, 25));

    await db.ptbBytes.bulkPut([
      { cityId: "vilnius", bytes: new ArrayBuffer(8), etag: '"a"', firstStoredAt: 1, lastValidatedAt: 1 },
      { cityId: "tricity", bytes: new ArrayBuffer(8), etag: '"b"', firstStoredAt: 1, lastValidatedAt: 1 },
    ] as never);
    await db.gtfsBundle.bulkPut([
      { cityId: "vilnius" },
      { cityId: "tricity" },
    ] as never);

    const { onRehydrateStorage } = (
      useCityStore as unknown as {
        persist: { getOptions: () => { onRehydrateStorage: () => (state: unknown) => void } };
      }
    ).persist.getOptions();
    const tricity = CITIES.find((c) => c.id === "tricity")!;
    onRehydrateStorage()({ activeCity: tricity });

    await vi.waitFor(async () => {
      expect(await db.ptbBytes.toCollection().primaryKeys()).toEqual(["tricity"]);
      expect(await db.gtfsBundle.toCollection().primaryKeys()).toEqual(["tricity"]);
    });
  });
});
