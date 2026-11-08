import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {createPanCitySwitcher} from "./panCitySwitch.ts";

const mocks = vi.hoisted(() => ({active: "a", target: "b", switch: vi.fn()}));
vi.mock("../../config/cities.ts", () => ({
  findCityByLocation: () => ({id: mocks.target}),
  getAvailableCities: () => [{id: "a"}, {id: "b"}],
}));
vi.mock("../../stores/cityStore.ts", () => ({useCityStore: {getState: () => ({
  activeCity: {id: mocks.active}, setActiveCity: mocks.switch,
})}}));
const map = {getCenter: vi.fn(() => ({lat: 1, lng: 2})), isMoving: vi.fn(() => false)};
beforeEach(() => {vi.useFakeTimers(); mocks.active = "a"; mocks.target = "b"; vi.clearAllMocks(); map.isMoving.mockReturnValue(false);});
afterEach(() => vi.useRealTimers());
const create = () => createPanCitySwitcher(map as never);

it("coalesces quick terminal events before activating the settled city", () => {
  const switcher = create();
  switcher.schedule();
  vi.advanceTimersByTime(150);
  switcher.schedule();
  vi.advanceTimersByTime(199);
  expect(mocks.switch).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(mocks.switch).toHaveBeenCalledExactlyOnceWith({id: "b"});
});

it("does not switch during a flight started after the terminal event", () => {
  const switcher = create();
  switcher.schedule();
  map.isMoving.mockReturnValue(true);
  vi.advanceTimersByTime(200);
  expect(mocks.switch).not.toHaveBeenCalled();
  map.isMoving.mockReturnValue(false);
  switcher.schedule();
  vi.advanceTimersByTime(200);
  expect(mocks.switch).toHaveBeenCalledExactlyOnceWith({id: "b"});
});

it("uses the latest location and rejects unavailable or already active cities", () => {
  const switcher = create();
  switcher.schedule(); mocks.target = "unavailable";
  vi.advanceTimersByTime(200);
  expect(mocks.switch).not.toHaveBeenCalled();
  switcher.schedule(); mocks.target = "a";
  vi.advanceTimersByTime(200);
  expect(mocks.switch).not.toHaveBeenCalled();
});

it("cancels pending work when its map is disposed", () => {
  const switcher = create();
  switcher.schedule(); switcher.dispose();
  vi.advanceTimersByTime(1000);
  expect(mocks.switch).not.toHaveBeenCalled();
});
