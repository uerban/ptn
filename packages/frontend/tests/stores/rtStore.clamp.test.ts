import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useRtStore } from "../../src/stores/rtStore.ts";
import type { RtRouteUpdate, RtTripUpdate } from "@pt/shared";

const DELAY_SECONDS_MAX = 1800;

function invokePollerCallback(routeId: string, trips: RtTripUpdate[]): void {
  const poller = useRtStore.getState().poller;
  const subscribeSpy = vi
    .spyOn(poller, "subscribe")
    .mockImplementation(() => {});
  vi.spyOn(poller, "unsubscribe").mockImplementation(() => {});
  vi.spyOn(poller, "start").mockImplementation(() => {});
  useRtStore.getState().subscribeRoutes([routeId]);
  const callback = subscribeSpy.mock.calls[0]?.[1];
  expect(callback).toBeDefined();
  const update: RtRouteUpdate = {
    routeId,
    generatedAt: Date.now(),
    trips,
  };
  callback!(update);
}

describe("rtStore delaySeconds clamp", () => {
  beforeEach(() => {
    useRtStore.setState({ updates: new Map() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes 0 through unchanged and emits no breadcrumb", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    invokePollerCallback("R1", [
      { tripId: "T0", delaySeconds: 0, cancelled: false } as RtTripUpdate,
    ]);
    expect(useRtStore.getState().getTripDelay("T0")).toEqual({
      delaySeconds: 0,
      cancelled: false,
    });
    const clampCalls = debugSpy.mock.calls.filter((c) => c[0] === "rt.clamp");
    expect(clampCalls).toHaveLength(0);
  });

  it("passes 60 through unchanged and emits no breadcrumb", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    invokePollerCallback("R1", [
      { tripId: "T60", delaySeconds: 60, cancelled: false } as RtTripUpdate,
    ]);
    expect(useRtStore.getState().getTripDelay("T60")?.delaySeconds).toBe(60);
    const clampCalls = debugSpy.mock.calls.filter((c) => c[0] === "rt.clamp");
    expect(clampCalls).toHaveLength(0);
  });

  it("passes 1800 (max boundary) through unchanged", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    invokePollerCallback("R1", [
      { tripId: "Tmax", delaySeconds: 1800, cancelled: false } as RtTripUpdate,
    ]);
    expect(useRtStore.getState().getTripDelay("Tmax")?.delaySeconds).toBe(
      DELAY_SECONDS_MAX,
    );
    const clampCalls = debugSpy.mock.calls.filter((c) => c[0] === "rt.clamp");
    expect(clampCalls).toHaveLength(0);
  });

  it("passes -1800 (min boundary) through unchanged", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    invokePollerCallback("R1", [
      { tripId: "Tmin", delaySeconds: -1800, cancelled: false } as RtTripUpdate,
    ]);
    expect(useRtStore.getState().getTripDelay("Tmin")?.delaySeconds).toBe(
      -DELAY_SECONDS_MAX,
    );
    const clampCalls = debugSpy.mock.calls.filter((c) => c[0] === "rt.clamp");
    expect(clampCalls).toHaveLength(0);
  });

  it("clamps 1801 down to 1800 and emits a breadcrumb", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    invokePollerCallback("R1", [
      { tripId: "T1801", delaySeconds: 1801, cancelled: false } as RtTripUpdate,
    ]);
    expect(useRtStore.getState().getTripDelay("T1801")?.delaySeconds).toBe(
      DELAY_SECONDS_MAX,
    );
    const clampCalls = debugSpy.mock.calls.filter((c) => c[0] === "rt.clamp");
    expect(clampCalls).toHaveLength(1);
    expect(clampCalls[0]?.[1]).toMatchObject({
      tripId: "T1801",
      raw: 1801,
      clamped: DELAY_SECONDS_MAX,
    });
  });

  it("clamps -1801 up to -1800 and emits a breadcrumb", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    invokePollerCallback("R1", [
      {
        tripId: "Tneg1801",
        delaySeconds: -1801,
        cancelled: false,
      } as RtTripUpdate,
    ]);
    expect(useRtStore.getState().getTripDelay("Tneg1801")?.delaySeconds).toBe(
      -DELAY_SECONDS_MAX,
    );
    const clampCalls = debugSpy.mock.calls.filter((c) => c[0] === "rt.clamp");
    expect(clampCalls).toHaveLength(1);
    expect(clampCalls[0]?.[1]).toMatchObject({
      tripId: "Tneg1801",
      raw: -1801,
      clamped: -DELAY_SECONDS_MAX,
    });
  });

  it("clamps 7200 down to 1800 and emits a breadcrumb", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    invokePollerCallback("R1", [
      { tripId: "T7200", delaySeconds: 7200, cancelled: false } as RtTripUpdate,
    ]);
    expect(useRtStore.getState().getTripDelay("T7200")?.delaySeconds).toBe(
      DELAY_SECONDS_MAX,
    );
    const clampCalls = debugSpy.mock.calls.filter((c) => c[0] === "rt.clamp");
    expect(clampCalls).toHaveLength(1);
    expect(clampCalls[0]?.[1]).toMatchObject({
      tripId: "T7200",
      raw: 7200,
      clamped: DELAY_SECONDS_MAX,
    });
  });

  it("clamps -7200 up to -1800 and emits a breadcrumb", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    invokePollerCallback("R1", [
      {
        tripId: "Tneg7200",
        delaySeconds: -7200,
        cancelled: false,
      } as RtTripUpdate,
    ]);
    expect(useRtStore.getState().getTripDelay("Tneg7200")?.delaySeconds).toBe(
      -DELAY_SECONDS_MAX,
    );
    const clampCalls = debugSpy.mock.calls.filter((c) => c[0] === "rt.clamp");
    expect(clampCalls).toHaveLength(1);
    expect(clampCalls[0]?.[1]).toMatchObject({
      tripId: "Tneg7200",
      raw: -7200,
      clamped: -DELAY_SECONDS_MAX,
    });
  });

  it("coerces NaN to 0 and emits a breadcrumb", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    invokePollerCallback("R1", [
      { tripId: "Tnan", delaySeconds: NaN, cancelled: false } as RtTripUpdate,
    ]);
    expect(useRtStore.getState().getTripDelay("Tnan")?.delaySeconds).toBe(0);
    const clampCalls = debugSpy.mock.calls.filter((c) => c[0] === "rt.clamp");
    expect(clampCalls).toHaveLength(1);
    expect(clampCalls[0]?.[1]).toMatchObject({
      tripId: "Tnan",
      clamped: 0,
    });
    expect(Number.isNaN(clampCalls[0]?.[1]?.raw as number)).toBe(true);
  });

  it("coerces Infinity to 0 (non-finite) and emits a breadcrumb", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    invokePollerCallback("R1", [
      {
        tripId: "Tinf",
        delaySeconds: Infinity,
        cancelled: false,
      } as RtTripUpdate,
    ]);
    expect(useRtStore.getState().getTripDelay("Tinf")?.delaySeconds).toBe(0);
    const clampCalls = debugSpy.mock.calls.filter((c) => c[0] === "rt.clamp");
    expect(clampCalls).toHaveLength(1);
    expect(clampCalls[0]?.[1]).toMatchObject({
      tripId: "Tinf",
      raw: Infinity,
      clamped: 0,
    });
  });

  it("coerces -Infinity to 0 and emits a breadcrumb", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    invokePollerCallback("R1", [
      {
        tripId: "TnegInf",
        delaySeconds: -Infinity,
        cancelled: false,
      } as RtTripUpdate,
    ]);
    expect(useRtStore.getState().getTripDelay("TnegInf")?.delaySeconds).toBe(0);
    const clampCalls = debugSpy.mock.calls.filter((c) => c[0] === "rt.clamp");
    expect(clampCalls).toHaveLength(1);
    expect(clampCalls[0]?.[1]).toMatchObject({
      tripId: "TnegInf",
      raw: -Infinity,
      clamped: 0,
    });
  });

  // Guards the second writer path (LinePreview.tsx) and any future surface
  // that subscribes to the poller directly. They all go through the store's
  // `applyUpdate` action, so the clamp + receivedAt stamp stay in one place.
  it("applyUpdate is the single store-level writer and clamps on the alt path", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const update: RtRouteUpdate = {
      routeId: "R-alt",
      generatedAt: Date.now(),
      trips: [
        { tripId: "Talt", delaySeconds: 7200, cancelled: false } as RtTripUpdate,
      ],
    };
    useRtStore.getState().applyUpdate(update);
    expect(useRtStore.getState().getTripDelay("Talt")?.delaySeconds).toBe(
      DELAY_SECONDS_MAX,
    );
    const clampCalls = debugSpy.mock.calls.filter((c) => c[0] === "rt.clamp");
    expect(clampCalls).toHaveLength(1);
    expect(clampCalls[0]?.[1]).toMatchObject({
      tripId: "Talt",
      raw: 7200,
      clamped: DELAY_SECONDS_MAX,
    });
    expect(useRtStore.getState().getReceivedAt("Talt")).toEqual(expect.any(Number));
  });
});
