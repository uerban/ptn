import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({loadedCityId: "a" as string | null, init: vi.fn(), reset: vi.fn()}));
const idle = vi.hoisted(() => ({task: undefined as (() => void) | undefined}));
vi.mock("../../src/stores/gtfsDataStore.ts", () => ({useGtfsDataStore: {getState: () => state}}));
vi.mock("../../src/stores/rtStore.ts", () => ({useRtStore: {getState: () => ({unsubscribeAll: vi.fn()})}}));
vi.mock("../../src/stores/colorConfigStore.ts", () => ({useColorConfigStore: {getState: () => ({fetchForCity: vi.fn()})}}));
vi.mock("../../src/utils/idle.ts", () => ({scheduleIdle: (task: () => void) => {idle.task = task; return 1;}, cancelIdle: vi.fn()}));
import { useCityGtfsLifecycle } from "../../src/hooks/useCityGtfsLifecycle.ts";

it("does not restart an abandoned intermediate city when its reset finally completes", async () => {
  let finish!: () => void;
  state.reset.mockImplementation(() => {
    state.loadedCityId = null;
    return new Promise<void>(resolve => {finish = resolve;});
  });
  const view = renderHook(({city}) => useCityGtfsLifecycle(city), {initialProps: {city: "b"}});
  view.rerender({city: "c"});
  await act(async () => { finish(); await Promise.resolve(); });
  expect(state.init).not.toHaveBeenCalled();
  act(() => idle.task?.());
  expect(state.init).toHaveBeenCalledOnce();
  expect(state.init).toHaveBeenCalledWith("c");
  view.unmount();
});
