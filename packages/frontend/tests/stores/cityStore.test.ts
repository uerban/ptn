import { describe, it, expect, beforeEach, vi } from "vitest";

import { useCityStore } from "../../src/stores/cityStore.ts";
import { CITIES } from "../../src/config/cities.ts";
import { db } from "../../src/db/index.ts";

describe("cityStore", () => {
  beforeEach(() => {
    useCityStore.setState({ activeCity: CITIES[0] });
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

  it("changes only the selected reference and preserves legacy recovery bytes", async () => {
    await db.open();
    await db.ptbBytes.bulkPut([
      {cityId: "vilnius", bytes: new Uint8Array([1]), etag: '"a"', firstStoredAt: 1, lastValidatedAt: 1},
      {cityId: "tricity", bytes: new Uint8Array([2]), etag: '"b"', firstStoredAt: 1, lastValidatedAt: 1},
    ] as never);
    await db.gtfsBundle.bulkPut([{cityId: "vilnius"}, {cityId: "tricity"}] as never);
    const rawDelete = vi.spyOn(db.ptbBytes, "delete");
    const bundleDelete = vi.spyOn(db.gtfsBundle, "delete");
    useCityStore.getState().setActiveCity(CITIES.find(city => city.id === "tricity")!);
    expect(rawDelete).not.toHaveBeenCalled();
    expect(bundleDelete).not.toHaveBeenCalled();
    expect(await db.ptbBytes.toCollection().primaryKeys()).toEqual(["tricity", "vilnius"]);
    expect(await db.gtfsBundle.toCollection().primaryKeys()).toEqual(["tricity", "vilnius"]);
    rawDelete.mockRestore(); bundleDelete.mockRestore();
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

});

it("persists only city identity and resolves new and legacy identities from the catalog", () => {
  const city = CITIES.find(c => c.id === "krakow")!;
  useCityStore.getState().setActiveCity(city);
  expect(JSON.parse(localStorage.getItem("ptn-city")!).state).toEqual({currentCityId: city.id});
  const merge = useCityStore.persist.getOptions().merge!;
  for (const persisted of [{currentCityId: city.id}, {activeCity: {...city, tz: "UTC", name: "stale"}}]) {
    expect(merge(persisted, useCityStore.getState()).activeCity).toBe(city);
  }
  expect(merge({currentCityId: "gdansk"}, useCityStore.getState()).activeCity.id).toBe("tricity");
});
