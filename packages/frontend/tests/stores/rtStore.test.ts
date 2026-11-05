import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useRtStore } from "../../src/stores/rtStore.ts";
import type { RtTripUpdate } from "@pt/shared";
import { polledRoutes } from "../helpers/rtPollerRoutes.ts";

describe("rtStore receivedAt", () => {
  beforeEach(() => {
    useRtStore.setState({ updates: new Map() });
  });

  it("getReceivedAt returns null for an unknown trip", () => {
    expect(useRtStore.getState().getReceivedAt("unknown")).toBeNull();
  });

  it("seeded updates with receivedAt are queryable via getReceivedAt", () => {
    const now = Date.now();
    const trip: RtTripUpdate = {
      tripId: "T1",
      delaySeconds: 30,
      cancelled: false,
      receivedAt: now,
    };
    useRtStore.setState({ updates: new Map([["R1", [trip]]]) });
    expect(useRtStore.getState().getReceivedAt("T1")).toBe(now);
  });

  it("returns null when an update has no receivedAt (backwards-compat)", () => {
    // Simulates the case where a writer hasn't been updated yet, or a
    // legacy seeded entry. Missing receivedAt must not crash the getter
    // — the freshness guard's design treats missing as "fresh".
    const trip: RtTripUpdate = {
      tripId: "T1",
      delaySeconds: 30,
      cancelled: false,
    };
    useRtStore.setState({ updates: new Map([["R1", [trip]]]) });
    expect(useRtStore.getState().getReceivedAt("T1")).toBeNull();
  });

  it("getTripDelay still returns the trip even when receivedAt is unset", () => {
    // Ensure D2 didn't accidentally couple getTripDelay to receivedAt.
    useRtStore.setState({
      updates: new Map([
        [
          "R1",
          [{ tripId: "T1", delaySeconds: 30, cancelled: false } as RtTripUpdate],
        ],
      ]),
    });
    expect(useRtStore.getState().getTripDelay("T1")).toEqual({
      delaySeconds: 30,
      cancelled: false,
    });
  });

  it("subscribeRoutes' poller callback stamps receivedAt on every trip", () => {
    // Pin the behavioural contract: a regression that drops the
    // `receivedAt: now` stamp from the subscribeRoutes callback would
    // make every update look "no stamp" → freshness guard treats as
    // fresh forever → stale data could shift legs indefinitely.
    // Tests that seed via direct `setState` would not catch this.
    const poller = useRtStore.getState().poller;
    const subscribeSpy = vi
      .spyOn(poller, "subscribe")
      .mockImplementation(() => {});
    vi.spyOn(poller, "unsubscribe").mockImplementation(() => {});
    vi.spyOn(poller, "start").mockImplementation(() => {});
    try {
      useRtStore.getState().subscribeRoutes(["R1"]);

      // The store should have called poller.subscribe with a callback;
      // capture and invoke it with a real RtRouteUpdate and assert the
      // store now exposes a numeric receivedAt for the trip.
      expect(subscribeSpy).toHaveBeenCalled();
      const callback = subscribeSpy.mock.calls[0]?.[1];
      expect(callback).toBeDefined();

      const before = Date.now();
      callback!({
        routeId: "R1",
        generatedAt: before,
        trips: [
          { tripId: "T1", delaySeconds: 45, cancelled: false } as RtTripUpdate,
          { tripId: "T2", delaySeconds: 0, cancelled: true } as RtTripUpdate,
        ],
      });
      const after = Date.now();

      const t1Stamp = useRtStore.getState().getReceivedAt("T1");
      const t2Stamp = useRtStore.getState().getReceivedAt("T2");
      expect(t1Stamp).not.toBeNull();
      expect(t2Stamp).not.toBeNull();
      expect(t1Stamp).toBeGreaterThanOrEqual(before);
      expect(t1Stamp).toBeLessThanOrEqual(after);
      expect(t2Stamp).toBe(t1Stamp); // same poll, same stamp
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("rtStore — routes held by surfaces", () => {
  const polled = polledRoutes;

  beforeEach(() => {
    const { poller } = useRtStore.getState();
    // Keep the poller off the network; subscriptions are what these tests read.
    vi.spyOn(poller, "start").mockImplementation(() => {});
    useRtStore.getState().unsubscribeAll();
  });

  afterEach(() => {
    useRtStore.getState().unsubscribeAll();
    vi.restoreAllMocks();
  });

  it("polls a retained route until it is released, then drops its data", () => {
    const release = useRtStore.getState().retainRoutes(["r1", "r2"]);
    expect(polled()).toEqual(["r1", "r2"]);
    useRtStore.setState({ updates: new Map([["r1", [{ tripId: "t1", delaySeconds: 60, cancelled: false }]]]) });
    release();
    expect(polled()).toEqual([]);
    expect(useRtStore.getState().getTripDelay("t1")).toBeNull();
  });

  it("keeps a route while any holder still wants it", () => {
    const a = useRtStore.getState().retainRoutes(["r1"]);
    const b = useRtStore.getState().retainRoutes(["r1"]);
    a();
    expect(polled()).toEqual(["r1"]);
    b();
    expect(polled()).toEqual([]);
  });

  it("survives the results → guidance handover on a shared route", () => {
    // Picking a result starts guidance, then the result list unmounts.
    const releaseResults = useRtStore.getState().retainRoutes(["r1"]);
    useRtStore.getState().subscribeRoutes(["r1"]);
    releaseResults();
    expect(polled()).toEqual(["r1"]);
  });

  it("stopping guidance leaves routes another surface still holds", () => {
    const release = useRtStore.getState().retainRoutes(["r2"]);
    useRtStore.getState().subscribeRoutes(["r1"]);
    useRtStore.getState().unsubscribeAll();
    expect(polled()).toEqual(["r2"]);
    release();
    expect(polled()).toEqual([]);
  });
});

describe("rtStore — deleted trips", () => {
  it("reports a deleted trip as deleted, not cancelled", () => {
    useRtStore.setState({
      updates: new Map([["R1", [{ tripId: "T1", delaySeconds: 0, cancelled: false, deleted: true }]]]),
    });
    expect(useRtStore.getState().getTripDelay("T1")).toEqual({
      delaySeconds: 0,
      cancelled: false,
      deleted: true,
    });
  });
});

