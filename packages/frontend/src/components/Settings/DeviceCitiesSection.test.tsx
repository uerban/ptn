import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {DeviceCitiesSection} from "./DeviceCitiesSection.tsx";

const mocks = vi.hoisted(() => {
  const city = {id: "custom", name: "Custom"};
  return {city, save: vi.fn(), list: vi.fn(), remove: vi.fn(), select: vi.fn(), reset: vi.fn(), init: vi.fn(), refresh: vi.fn(), ready: vi.fn(), unsubscribe: vi.fn()};
});
const state = {syncing: false, loadedCityId: null as string | null, error: null as string | null,
  reset: mocks.reset, init: mocks.init, refresh: mocks.refresh, ensureWasmReady: mocks.ready};
vi.mock("../../config/cities.ts", () => ({getAvailableCities: () => [mocks.city]}));
vi.mock("../../stores/cityStore.ts", () => ({useCityStore: Object.assign((selector: (value: unknown) => unknown) => selector({activeCity: mocks.city}), {getState: () => ({setActiveCity: mocks.select})})}));
vi.mock("../../stores/gtfsDataStore.ts", () => ({useGtfsDataStore: {getState: () => state}}));
vi.mock("../../stores/rtStore.ts", () => ({useRtStore: {getState: () => ({unsubscribeAll: mocks.unsubscribe})}}));
vi.mock("../../services/deviceCities.ts", () => ({saveDeviceCity: mocks.save, listDeviceCities: mocks.list, removeDeviceCity: mocks.remove}));

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(state, {syncing: false, loadedCityId: null, error: null});
  mocks.list.mockResolvedValue([{cityId: "custom", city: mocks.city, preparedAt: 1000, sizeBytes: 1000}]);
  mocks.init.mockImplementation(async () => {state.loadedCityId = "custom";});
  mocks.refresh.mockImplementation(async () => {state.loadedCityId = "custom";});
});
afterEach(() => {cleanup(); vi.restoreAllMocks();});

it("opens a retained timetable while offline without downloading or changing its date", async () => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  render(<DeviceCitiesSection />);
  fireEvent.click(await screen.findByRole("button", {name: "Open Custom"}));
  await waitFor(() => expect(mocks.ready).toHaveBeenCalled());
  expect(mocks.init).toHaveBeenCalledWith("custom", {preferDownload: true});
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});
it("does not overwrite an existing download after a failed explicit update", async () => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  mocks.refresh.mockImplementation(async () => {state.error = "Network unavailable";});
  render(<DeviceCitiesSection />);
  fireEvent.click(screen.getByRole("button", {name: "Open and download"}));
  await screen.findByText("Network unavailable");
  expect(mocks.refresh).toHaveBeenCalledWith("custom", {requireNetwork: true});
  expect(mocks.save).not.toHaveBeenCalled();
});
it("saves a newly validated update only after the planner is ready", async () => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  render(<DeviceCitiesSection />);
  fireEvent.click(screen.getByRole("button", {name: "Open and download"}));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(mocks.city));
  expect(mocks.ready.mock.invocationCallOrder[0]).toBeLessThan(mocks.save.mock.invocationCallOrder[0]);
});
