import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRetainRoutes } from "../../src/hooks/useLiveRt.ts";
import { useRtStore } from "../../src/stores/rtStore.ts";

beforeEach(() => {
  useRtStore.getState().unsubscribeAll();
  // Exercise real counted holds without starting network polling.
  vi.spyOn(useRtStore.getState().poller, "start").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  useRtStore.getState().unsubscribeAll();
  vi.restoreAllMocks();
});

it.each(["A|B", 'A"B\\C', "雪|🚌"])("retains %s as one opaque route ID", id => {
  const poller = useRtStore.getState().poller;
  const subscribe = vi.spyOn(poller, "subscribe");
  const unsubscribe = vi.spyOn(poller, "unsubscribe");
  const { unmount } = renderHook(() => useRetainRoutes([id]));
  expect(subscribe.mock.calls.map(([route]) => route)).toEqual([id]);
  unmount();
  expect(unsubscribe.mock.calls.map(([route]) => route)).toEqual([id]);
});

it("replaces distinct route sets that have the same joined text", () => {
  const poller = useRtStore.getState().poller;
  const subscribe = vi.spyOn(poller, "subscribe");
  const unsubscribe = vi.spyOn(poller, "unsubscribe");
  const { rerender, unmount } = renderHook(({ ids }) => useRetainRoutes(ids), {
    initialProps: { ids: ["A", "B"] },
  });
  subscribe.mockClear();
  rerender({ ids: ["A|B"] });
  expect(unsubscribe.mock.calls.map(([id]) => id)).toEqual(["A", "B"]);
  expect(subscribe.mock.calls.map(([id]) => id)).toEqual(["A|B"]);
  unmount();
  expect(unsubscribe.mock.calls.map(([id]) => id)).toEqual(["A", "B", "A|B"]);
});

it("keeps the same hold when only route order or duplicates change", () => {
  const retain = vi.spyOn(useRtStore.getState(), "retainRoutes");
  const unsubscribe = vi.spyOn(useRtStore.getState().poller, "unsubscribe");
  const { rerender, unmount } = renderHook(({ ids }) => useRetainRoutes(ids), {
    initialProps: { ids: ["B", "A", "B"] },
  });
  expect(retain).toHaveBeenCalledExactlyOnceWith(["A", "B"]);
  rerender({ ids: ["A", "B"] });
  expect(retain).toHaveBeenCalledTimes(1);
  expect(unsubscribe).not.toHaveBeenCalled();
  unmount();
  expect(unsubscribe.mock.calls.map(([id]) => id)).toEqual(["A", "B"]);
});

it("keeps a shared opaque route while another surface still holds it", () => {
  const unsubscribe = vi.spyOn(useRtStore.getState().poller, "unsubscribe");
  let release!: () => void;
  act(() => { release = useRtStore.getState().retainRoutes(["A|B"]); });
  const { unmount } = renderHook(() => useRetainRoutes(["A|B"]));
  act(() => useRtStore.getState().applyUpdate({
    routeId: "A|B", trips: [{ tripId: "trip", delaySeconds: 60, cancelled: false }], generatedAt: 1,
  }));
  unmount();
  expect(unsubscribe).not.toHaveBeenCalled();
  expect(useRtStore.getState().getTripDelay("trip")?.delaySeconds).toBe(60);
  act(() => release());
  expect(unsubscribe).toHaveBeenCalledExactlyOnceWith("A|B");
  expect(useRtStore.getState().updates.size).toBe(0);
});
