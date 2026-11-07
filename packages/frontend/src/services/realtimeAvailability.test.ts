import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRealtimeAvailability,
  isRealtimeKindAvailable,
  REALTIME_AVAILABILITY_STORAGE_KEY,
  recordRealtimeHeader,
  subscribeRealtimeAvailability,
} from "./realtimeAvailability.ts";

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("realtime availability", () => {
  it("is unknown until a manifest response was seen for the city", () => {
    expect(getRealtimeAvailability("vilnius")).toBeUndefined();
    expect(isRealtimeKindAvailable("vilnius", "alerts")).toBe(false);
  });

  it("stores parsed kinds per city", () => {
    recordRealtimeHeader("vilnius", "alerts, departures, bogus");
    recordRealtimeHeader("riga", "departures");
    expect(getRealtimeAvailability("vilnius")).toEqual(["departures", "alerts"]);
    expect(getRealtimeAvailability("riga")).toEqual(["departures"]);
    expect(isRealtimeKindAvailable("vilnius", "alerts")).toBe(true);
    expect(isRealtimeKindAvailable("riga", "alerts")).toBe(false);
  });

  it("records an empty or missing header as no kinds, distinct from unknown", () => {
    recordRealtimeHeader("vilnius", null);
    expect(getRealtimeAvailability("vilnius")).toEqual([]);
  });

  it("ignores malformed city ids and corrupt storage", () => {
    recordRealtimeHeader("../evil", "alerts");
    expect(localStorage.getItem(REALTIME_AVAILABILITY_STORAGE_KEY)).toBeNull();

    localStorage.setItem(REALTIME_AVAILABILITY_STORAGE_KEY, "{not json");
    expect(getRealtimeAvailability("vilnius")).toBeUndefined();

    localStorage.setItem(
      REALTIME_AVAILABILITY_STORAGE_KEY,
      JSON.stringify({ vilnius: { kinds: ["alerts", 7, "x"] }, "BAD ID": { kinds: [] } }),
    );
    expect(getRealtimeAvailability("vilnius")).toEqual(["alerts"]);
    expect(getRealtimeAvailability("BAD ID")).toBeUndefined();
  });

  it("notifies subscribers on change only", () => {
    const listener = vi.fn();
    const stop = subscribeRealtimeAvailability(listener);
    recordRealtimeHeader("vilnius", "alerts");
    recordRealtimeHeader("vilnius", "alerts");
    expect(listener).toHaveBeenCalledTimes(1);
    recordRealtimeHeader("vilnius", "");
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    recordRealtimeHeader("vilnius", "alerts");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("notifies subscribers when another tab writes the value", () => {
    const listener = vi.fn();
    const stop = subscribeRealtimeAvailability(listener);
    window.dispatchEvent(
      new StorageEvent("storage", { key: REALTIME_AVAILABILITY_STORAGE_KEY }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: "ptn-other" }));
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it("survives storage that throws", () => {
    const storage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => recordRealtimeHeader("vilnius", "alerts", { storage })).not.toThrow();
    expect(getRealtimeAvailability("vilnius", storage)).toBeUndefined();
  });
});
