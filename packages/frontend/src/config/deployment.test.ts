import {afterEach, describe, expect, it, vi} from "vitest";
import {runtimeCityIds, deploymentCityIds, runtimeCityConfigs, deploymentCityConfigs} from "./deployment.ts";

afterEach(() => {
  delete globalThis.__PTN_DEPLOYMENT__;
  localStorage.removeItem("ptn:deployment-cities");
  vi.resetModules();
});
describe("runtime deployment city selection", () => {
  it("validates explicit cities and leaves source defaults when no config exists", () => {
    expect(runtimeCityIds(null, ["oslo"])).toBeNull();
    expect(runtimeCityIds({schemaVersion: 1, cities: ["tbilisi", "tricity"]}, ["tricity", "tbilisi"]))
      .toEqual(["tbilisi", "tricity"]);
    for (const cities of [[], ["oslo", "oslo"], ["unknown"]])
      expect(() => runtimeCityIds({schemaVersion: 1, cities}, ["oslo"])).toThrow();
  });
  it("retains first-page selection on an offline cold start before SW caching", () => {
    globalThis.__PTN_DEPLOYMENT__ = {schemaVersion: 1, cities: ["tbilisi"]};
    expect(deploymentCityIds(["vilnius", "tbilisi"])).toEqual(["tbilisi"]);
    delete globalThis.__PTN_DEPLOYMENT__;
    expect(deploymentCityIds(["vilnius", "tbilisi"])).toEqual(["tbilisi"]);
    globalThis.__PTN_DEPLOYMENT__ = null;
    expect(deploymentCityIds(["vilnius", "tbilisi"])).toBeNull();
    delete globalThis.__PTN_DEPLOYMENT__;
    expect(deploymentCityIds(["vilnius", "tbilisi"])).toBeNull();
  });
  it("keeps the cities this build knows when the config names a newer one", () => {
    globalThis.__PTN_DEPLOYMENT__ = {schemaVersion: 1, cities: ["vilnius", "newcity"]};
    expect(deploymentCityIds(["vilnius", "tbilisi"])).toEqual(["vilnius"]);
  });
  it("falls back to source defaults when no usable city remains", () => {
    for (const value of [{schemaVersion: 2, cities: ["vilnius"]}, {schemaVersion: 1, cities: ["gone"]}, "cities", []]) {
      globalThis.__PTN_DEPLOYMENT__ = value;
      expect(deploymentCityIds(["vilnius", "tbilisi"])).toBeNull();
      expect(localStorage.getItem("ptn:deployment-cities")).toBeNull();
    }
    delete globalThis.__PTN_DEPLOYMENT__;
    localStorage.setItem("ptn:deployment-cities", JSON.stringify({schemaVersion: 1, cities: ["gone"]}));
    expect(deploymentCityIds(["vilnius", "tbilisi"])).toBeNull();
  });
  it("still boots the city list when the runtime config is invalid", async () => {
    globalThis.__PTN_DEPLOYMENT__ = {schemaVersion: 1, cities: ["unknown"]};
    const {getAvailableCities, CITIES} = await import("./cities.ts");
    expect(getAvailableCities().map(city => city.id))
      .toEqual(CITIES.filter(city => city.available).map(city => city.id));
  });
  it("enables exactly selected cities, including Tbilisi without a binary rebuild", async () => {
    globalThis.__PTN_DEPLOYMENT__ = {schemaVersion: 1, cities: ["tbilisi", "tricity"]};
    vi.stubEnv("VITE_PT_TBILISI_ENABLED", "0");
    try {
      const {getAvailableCities, findCityByLocation} = await import("./cities.ts");
      expect(getAvailableCities().map(city => city.id)).toEqual(["tbilisi", "tricity"]);
      expect(findCityByLocation(54.68, 25.28)).toBeNull();
    } finally {vi.unstubAllEnvs();}
  });
});

const runtimeCity = {
  id: "host-only-city", name: "Host City", tz: "Europe/Riga",
  center: {lat: 56.95, lon: 24.1},
  bbox: {minLat: 56.8, minLon: 23.9, maxLat: 57.1, maxLon: 24.4},
};

describe("host-defined runtime cities", () => {
  it("boots an unknown city across catalog, store, API URLs and location lookup", async () => {
    globalThis.__PTN_DEPLOYMENT__ = {schemaVersion: 2, cities: [runtimeCity]};
    const {CITIES, getAvailableCities, findNearestCity, findCityByLocation} = await import("./cities.ts");
    const {useCityStore} = await import("../stores/cityStore.ts");
    expect(CITIES).toEqual([{...runtimeCity, available: true}]);
    expect(getAvailableCities()[0]).toEqual(CITIES[0]);
    expect(findNearestCity(56.95, 24.1).id).toBe(runtimeCity.id);
    expect(findCityByLocation(56.95, 24.1)?.id).toBe(runtimeCity.id);
    expect(findCityByLocation(54.68, 25.28)).toBeNull();
    expect(useCityStore.getState().activeCity.tz).toBe("Europe/Riga");
    expect(useCityStore.getState().getApiUrl()).toBe("/api/host-only-city");
  });
  it("retains complete metadata for an offline cold start", () => {
    globalThis.__PTN_DEPLOYMENT__ = {schemaVersion: 2, cities: [runtimeCity]};
    expect(deploymentCityConfigs([])?.[0].center).toEqual(runtimeCity.center);
    delete globalThis.__PTN_DEPLOYMENT__;
    expect(deploymentCityConfigs([])?.[0]).toEqual({...runtimeCity, available: true});
  });
  it("rejects invalid metadata instead of silently serving an unrelated default city", () => {
    const bad = [
      {...runtimeCity, tz: "not/a-zone"}, {...runtimeCity, id: "../bad"},
      {...runtimeCity, center: {lat: NaN, lon: 24.1}},
      {...runtimeCity, bbox: {...runtimeCity.bbox, minLat: 58}},
      {...runtimeCity, center: {lat: 40, lon: 24.1}}, {...runtimeCity, name: ""},
    ];
    for (const city of bad) expect(() => runtimeCityConfigs({schemaVersion: 2, cities: [city]}, [])).toThrow();
    expect(() => runtimeCityConfigs({schemaVersion: 2, cities: [runtimeCity, runtimeCity]}, [])).toThrow();
  });
  it("refreshes a saved city's metadata from the host catalog", async () => {
    globalThis.__PTN_DEPLOYMENT__ = {schemaVersion: 2, cities: [runtimeCity]};
    localStorage.setItem("ptn-city", JSON.stringify({state: {activeCity: {...runtimeCity, name: "Old name", tz: "UTC"}}, version: 0}));
    try {
      const {useCityStore} = await import("../stores/cityStore.ts");
      expect(useCityStore.getState().activeCity.name).toBe("Host City");
      expect(useCityStore.getState().activeCity.tz).toBe("Europe/Riga");
    } finally {localStorage.removeItem("ptn-city");}
  });
});
