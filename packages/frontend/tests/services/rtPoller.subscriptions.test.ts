import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RtRouteUpdate } from "@pt/shared";
import { RtPoller } from "../../src/services/rtPoller.ts";
import { api } from "../../src/services/api.ts";
import { allowFlow, resetFlows } from "../../src/test-helpers/networkDecisions.ts";

vi.mock("../../src/services/api.ts", () => ({ api: { fetchRouteRt: vi.fn() } }));
const update = (routeId = "r1"): RtRouteUpdate => ({
  routeId, trips: [{ tripId: `${routeId}-trip`, delaySeconds: 60, cancelled: false }], generatedAt: 1,
});
function deferred() {
  let resolve!: (value: RtRouteUpdate) => void;
  const promise = new Promise<RtRouteUpdate>((done) => { resolve = done; });
  return { promise, resolve };
}
let poller: RtPoller;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.mocked(api.fetchRouteRt).mockReset().mockResolvedValue(update());
  resetFlows();
  allowFlow("operator.realtime");
  poller = new RtPoller();
});
afterEach(() => {
  poller.stop();
  resetFlows();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("drops a released route's response while delivering a still-held route's response", async () => {
  const removed = deferred(), active = deferred(), removedCallback = vi.fn(), activeCallback = vi.fn();
  vi.mocked(api.fetchRouteRt).mockReturnValueOnce(removed.promise).mockReturnValueOnce(active.promise);
  poller.subscribe("removed", removedCallback);
  poller.subscribe("active", activeCallback);
  poller.start();
  poller.unsubscribe("removed");
  removed.resolve(update("removed"));
  active.resolve(update("active"));
  await vi.advanceTimersByTimeAsync(0);
  expect(activeCallback).toHaveBeenCalledWith(update("active"));
  expect(removedCallback).not.toHaveBeenCalled();
});

it("does not deliver an earlier subscription's result after the same callback is re-added", async () => {
  const old = deferred(), callback = vi.fn();
  vi.mocked(api.fetchRouteRt).mockReturnValueOnce(old.promise);
  poller.subscribe("r1", callback);
  poller.start();
  poller.unsubscribe("r1");
  poller.subscribe("r1", callback);
  old.resolve(update());
  await vi.advanceTimersByTimeAsync(0);
  expect(callback).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(callback).toHaveBeenCalledOnce();
});

it("replacing a callback does not deliver the old in-flight result to either callback", async () => {
  const old = deferred(), previous = vi.fn(), current = vi.fn();
  vi.mocked(api.fetchRouteRt).mockReturnValueOnce(old.promise);
  poller.subscribe("r1", previous);
  poller.start();
  poller.subscribe("r1", current);
  old.resolve(update());
  await vi.advanceTimersByTimeAsync(0);
  expect(previous).not.toHaveBeenCalled();
  expect(current).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(current).toHaveBeenCalledOnce();
});

it("keeps a still-active identical subscription and repeated start idempotent", async () => {
  const pending = deferred(), callback = vi.fn();
  vi.mocked(api.fetchRouteRt).mockReturnValueOnce(pending.promise);
  poller.subscribe("r1", callback);
  poller.start();
  poller.subscribe("r1", callback);
  poller.start();
  expect(api.fetchRouteRt).toHaveBeenCalledOnce();
  pending.resolve(update());
  await vi.advanceTimersByTimeAsync(0);
  expect(callback).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(1);
});
