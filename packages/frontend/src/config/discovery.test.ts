import {afterEach, expect, it, vi} from "vitest";
import {discoverCities, selectCities} from "./discovery.ts";
const city = {id: "custom", name: "Custom", tz: "UTC", center: {lat: 1, lon: 1}, bbox: {minLat: 0, minLon: 0, maxLat: 2, maxLon: 2}};
const catalog = {schemaVersion: 2, cities: [city, {...city, id: "second"}]};
afterEach(() => {localStorage.clear(); delete globalThis.__PTN_DEPLOYMENT__;});
it("serves all or the exact subset without choosing a default", () => {
  expect(selectCities(catalog, "all").map(c => c.id)).toEqual(["custom", "second"]);
  expect(selectCities(catalog, ["second"]).map(c => c.id)).toEqual(["second"]);
  expect(() => selectCities(catalog, ["missing"])).toThrow();
  expect(() => selectCities(catalog, [])).toThrow();
});
it("discovers custom cities and caches metadata without downloading transit data", async () => {
  globalThis.__PTN_DEPLOYMENT__ = {cities: ["second"]};
  expect((await discoverCities(vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog))))).map(c => c.id)).toEqual(["second"]);
  expect(localStorage.getItem("ptn-city")).toBeNull();
  expect(localStorage.getItem("ptn:backend-city-catalog")).toContain("custom");
});
it("uses cached metadata on network failure but rejects an invalid live catalog", async () => {
  localStorage.setItem("ptn:backend-city-catalog", JSON.stringify(catalog));
  expect(await discoverCities(vi.fn().mockRejectedValue(new Error("offline")))).toHaveLength(2);
  globalThis.__PTN_DEPLOYMENT__ = {cities: "all"};
  await expect(discoverCities(vi.fn().mockResolvedValue(new Response(JSON.stringify({schemaVersion: 2, cities: []}))))).rejects.toThrow();
});
it("does not invent cities on an offline first visit", async () => {
  await expect(discoverCities(vi.fn().mockRejectedValue(new Error("offline")))).rejects.toThrow("offline");
});
