import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RtRouteUpdate } from "@pt/shared";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
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

it("drops an initial response after polling has stopped", async () => {
  const pending = deferred(), callback = vi.fn();
  vi.mocked(api.fetchRouteRt).mockReturnValueOnce(pending.promise);
  poller.subscribe("r1", callback);
  poller.start();
  poller.stop();
  pending.resolve(update());
  await vi.advanceTimersByTimeAsync(0);
  expect(callback).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not rearm a periodic loop when stop arrives during its request", async () => {
  const pending = deferred();
  vi.mocked(api.fetchRouteRt).mockResolvedValueOnce(update()).mockReturnValueOnce(pending.promise);
  poller.subscribe("r1", vi.fn());
  poller.start();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(api.fetchRouteRt).toHaveBeenCalledTimes(2);
  poller.stop();
  pending.resolve(update());
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.fetchRouteRt).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("an old startup completion cannot start a loop while the restarted poll is pending", async () => {
  const old = deferred(), current = deferred();
  vi.mocked(api.fetchRouteRt).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  poller.subscribe("r1", vi.fn());
  poller.start();
  poller.stop();
  poller.start();
  old.resolve(update());
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.fetchRouteRt).toHaveBeenCalledTimes(2);
  current.resolve(update());
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(api.fetchRouteRt).toHaveBeenCalledTimes(3);
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

it("reduces idle refreshes in Battery saver and refreshes immediately when guidance starts", async () => {
  const previous = useSettingsStore.getState().searchPowerMode;
  useSettingsStore.getState().setSearchPowerMode("battery-saver");
  vi.stubEnv("VITE_PTN_SEARCH_POWER_MODES", "1");
  try {
    poller.subscribe("r1", vi.fn());
    poller.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(api.fetchRouteRt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.fetchRouteRt).toHaveBeenCalledTimes(2);
    poller.setMode("navigating");
    await vi.advanceTimersByTimeAsync(0);
    expect(api.fetchRouteRt).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(api.fetchRouteRt).toHaveBeenCalledTimes(4);
    poller.setMode("transfer");
    await vi.advanceTimersByTimeAsync(0);
    expect(api.fetchRouteRt).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.fetchRouteRt).toHaveBeenCalledTimes(6);
  } finally {
    vi.unstubAllEnvs();
    useSettingsStore.getState().setSearchPowerMode(previous);
  }
});
