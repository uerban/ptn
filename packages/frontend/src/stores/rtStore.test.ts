import { describe, it, expect, beforeEach, vi } from "vitest";
import { useRtStore } from "./rtStore.ts";
import type { RtRouteUpdate } from "@pt/shared";

// The poller would fire real fetches; neuter its network entry points. The
// store's own bookkeeping (updates/byTrip maps) is what's under test.
vi.mock("../services/rtPoller.ts", () => ({
  RtPoller: class {
    subscribe() {}
    unsubscribe() {}
    start() {}
    stop() {}
    setMode() {}
  },
}));

function routeUpdate(routeId: string, trips: Array<[string, number]>): RtRouteUpdate {
  return {
    routeId,
    trips: trips.map(([tripId, delaySeconds]) => ({
      tripId,
      delaySeconds,
      cancelled: false,
    })),
  } as RtRouteUpdate;
}

beforeEach(() => {
  useRtStore.getState().unsubscribeAll();
});

describe("rtStore bookkeeping", () => {
  it("getTripDelay resolves trips across routes", () => {
    const s = useRtStore.getState();
    s.applyUpdate(routeUpdate("r1", [["t1", 60]]));
    s.applyUpdate(routeUpdate("r2", [["t2", -30]]));
    expect(useRtStore.getState().getTripDelay("t1")).toEqual({ delaySeconds: 60, cancelled: false });
    expect(useRtStore.getState().getTripDelay("t2")).toEqual({ delaySeconds: -30, cancelled: false });
    expect(useRtStore.getState().getTripDelay("t3")).toBeNull();
  });

  it("re-applying a route's update drops trips no longer present", () => {
    const s = useRtStore.getState();
    s.applyUpdate(routeUpdate("r1", [["t1", 60], ["t2", 30]]));
    s.applyUpdate(routeUpdate("r1", [["t2", 45]]));
    // t1 vanished from the poll — must not linger in the trip index.
    expect(useRtStore.getState().getTripDelay("t1")).toBeNull();
    expect(useRtStore.getState().getTripDelay("t2")).toEqual({ delaySeconds: 45, cancelled: false });
  });

  it("subscribeRoutes prunes updates of dropped routes", () => {
    const s = useRtStore.getState();
    s.applyUpdate(routeUpdate("r1", [["t1", 60]]));
    s.applyUpdate(routeUpdate("r2", [["t2", 30]]));
    // Route set narrows to r2 only — r1's entry (and its trips) must go,
    // or a session of changing subscriptions grows the map unboundedly.
    s.subscribeRoutes(["r2"]);
    expect(useRtStore.getState().updates.has("r1")).toBe(false);
    expect(useRtStore.getState().getTripDelay("t1")).toBeNull();
    expect(useRtStore.getState().getTripDelay("t2")).toEqual({ delaySeconds: 30, cancelled: false });
  });

  it("unsubscribeAll clears everything", () => {
    const s = useRtStore.getState();
    s.applyUpdate(routeUpdate("r1", [["t1", 60]]));
    s.unsubscribeAll();
    expect(useRtStore.getState().updates.size).toBe(0);
    expect(useRtStore.getState().getTripDelay("t1")).toBeNull();
  });

  it("keeps the ±1800s delay clamp and receivedAt stamp", () => {
    const s = useRtStore.getState();
    s.applyUpdate(routeUpdate("r1", [["t1", 99999]]));
    expect(useRtStore.getState().getTripDelay("t1")).toEqual({
      delaySeconds: 1800,
      cancelled: false,
    });
    expect(useRtStore.getState().getReceivedAt("t1")).toBeTypeOf("number");
  });
});
