import {beforeEach, expect, it, vi} from "vitest";
import type {CityConfig} from "./config/cities.ts";
import {chooseInitialCity, restoredCityId} from "./chooseInitialCity.ts";

const mocks = vi.hoisted(() => ({list: vi.fn(), live: vi.fn(), select: vi.fn()}));
vi.mock("./services/deviceCities.ts", () => ({listDeviceCities: mocks.list, hasLiveDeviceCity: mocks.live}));
vi.mock("./db/migrationRunner.ts", () => ({ensureDbReady: async () => ({recovered: false})}));
vi.mock("./db/dataSchemaVersion.ts", () => ({ensureDataSchemaUpToDate: async () => ({kind: "up-to-date"})}));
vi.mock("./stores/cityStore.ts", () => ({useCityStore: {getState: () => ({setActiveCity: mocks.select})}}));
const cities = [{id: "vilnius"}, {id: "tricity"}] as CityConfig[];

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  mocks.list.mockResolvedValue([]);
  mocks.live.mockResolvedValue(false);
});

it("selects an online returning user's city without reading downloaded or live artifacts", async () => {
  localStorage.setItem("ptn-city", JSON.stringify({state: {currentCityId: "tricity"}}));
  await chooseInitialCity(cities);
  expect(mocks.select).toHaveBeenCalledWith(cities[1]);
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.live).not.toHaveBeenCalled();
});

it("still checks local availability before restoring a saved city offline", async () => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  localStorage.setItem("ptn-city", JSON.stringify({state: {activeCity: {id: "vilnius"}}}));
  mocks.list.mockResolvedValue([{cityId: "vilnius", state: "legacy"}]);
  await chooseInitialCity(cities);
  expect(mocks.list).toHaveBeenCalledOnce();
  expect(mocks.select).toHaveBeenCalledWith(cities[0]);
  expect(mocks.live).not.toHaveBeenCalled();
});

it("reads legacy aliases and rejects a selection absent from the host catalog", () => {
  localStorage.setItem("ptn-city", JSON.stringify({state: {activeCity: {id: "gdansk"}}}));
  expect(restoredCityId(cities)).toBe("tricity");
  expect(restoredCityId(cities.slice(0, 1))).toBeNull();
});

it("restores an ordinary offline cache without probing other cities", async () => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  localStorage.setItem("ptn-city", JSON.stringify({state: {currentCityId: "tricity"}}));
  mocks.live.mockImplementation(async id => id === "tricity");
  await chooseInitialCity(cities);
  expect(mocks.select).toHaveBeenCalledWith(cities[1]);
  expect(mocks.live.mock.calls).toEqual([["tricity"]]);
});
