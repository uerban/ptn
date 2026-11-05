import {afterEach, describe, expect, it, vi} from "vitest";
import {runtimeCityIds, deploymentCityIds} from "./deployment.ts";

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
