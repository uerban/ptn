import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RtRouteUpdate } from "@pt/shared";
import { useRtStore } from "../../src/stores/rtStore.ts";
import { api } from "../../src/services/api.ts";
import { allowFlow, resetFlows } from "../../src/test-helpers/networkDecisions.ts";

vi.mock("../../src/services/api.ts", () => ({ api: { fetchRouteRt: vi.fn() } }));
const update = (routeId: string): RtRouteUpdate => ({
  routeId, trips: [{ tripId: `${routeId}-trip`, delaySeconds: 60, cancelled: false }], generatedAt: 1,
});
function deferred() {
  let resolve!: (value: RtRouteUpdate) => void;
  const promise = new Promise<RtRouteUpdate>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  resetFlows();
  allowFlow("operator.realtime");
  vi.mocked(api.fetchRouteRt).mockReset().mockImplementation(async (route) => update(route));
  useRtStore.getState().unsubscribeAll();
  useRtStore.getState().setMode("idle");
});
afterEach(() => {
  useRtStore.getState().unsubscribeAll();
  resetFlows();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("a released route's pending reply cannot repopulate RT state or restart polling", async () => {
  const pending = deferred();
  vi.mocked(api.fetchRouteRt).mockReturnValueOnce(pending.promise);
  useRtStore.getState().subscribeRoutes(["old"]);
  useRtStore.getState().subscribeRoutes([]);
  pending.resolve(update("old"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(useRtStore.getState().updates.size).toBe(0);
  expect(api.fetchRouteRt).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("replacing guidance routes drops the old reply but delivers the current route", async () => {
  const pending = deferred();
  vi.mocked(api.fetchRouteRt).mockReturnValueOnce(pending.promise);
  useRtStore.getState().subscribeRoutes(["old"]);
  useRtStore.getState().subscribeRoutes(["current"]);
  pending.resolve(update("old"));
  await vi.advanceTimersByTimeAsync(0);
  expect(useRtStore.getState().updates.size).toBe(0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect([...useRtStore.getState().updates.keys()]).toEqual(["current"]);
  expect(useRtStore.getState().getTripDelay("old-trip")).toBeNull();
  expect(useRtStore.getState().getTripDelay("current-trip")).not.toBeNull();
});

it("delivers a pending reply while another surface still holds the route", async () => {
  const pending = deferred();
  vi.mocked(api.fetchRouteRt).mockReturnValueOnce(pending.promise);
  useRtStore.getState().subscribeRoutes(["shared"]);
  const release = useRtStore.getState().retainRoutes(["shared"]);
  try {
    useRtStore.getState().subscribeRoutes([]);
    pending.resolve(update("shared"));
    await vi.advanceTimersByTimeAsync(0);
    expect(useRtStore.getState().getTripDelay("shared-trip")).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    release();
    expect(useRtStore.getState().updates.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release();
  }
});
