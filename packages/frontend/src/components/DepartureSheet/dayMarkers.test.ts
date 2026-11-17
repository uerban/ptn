import { describe, expect, it } from "vitest";
import type { Departure } from "@pt/shared";
import { dayMarkers } from "./dayMarkers.ts";

function dep(local: string, serviceDate?: string): Departure {
  return {
    routeId: "r",
    routeShortName: "1",
    mode: "BUS",
    headsign: "X",
    scheduledTime: new Date(local).toISOString(),
    tripId: local,
    serviceDate,
  };
}

const now = new Date("2026-11-17T22:00:00");

describe("dayMarkers", () => {
  it("marks the calendar day change and the service day change separately", () => {
    const list = [
      dep("2026-11-17T22:29:00", "20261117"),
      dep("2026-11-17T23:50:00", "20261117"),
      dep("2026-11-18T00:40:00", "20261117"), // 24:40 on the 17th's service
      dep("2026-11-18T05:27:00", "20261118"),
    ];
    const m = dayMarkers(list, now);
    expect(m[0]).toEqual({});
    expect(m[1]).toEqual({});
    expect(m[2]!.dateDivider?.getDate()).toBe(18);
    expect(m[2]!.lastOfServiceDay).toBe(true);
    expect(m[3]).toEqual({ firstOfServiceDay: true });
  });

  it("announces a first row that is not today", () => {
    const m = dayMarkers([dep("2026-11-18T05:27:00", "20261118")], now);
    expect(m[0]!.dateDivider?.getDate()).toBe(18);
    expect(m[0]!.firstOfServiceDay).toBeUndefined();
  });

  it("guesses nothing without service dates", () => {
    const m = dayMarkers([dep("2026-11-17T23:00:00"), dep("2026-11-18T05:00:00")], now);
    expect(m[0]).toEqual({});
    expect(m[1]!.lastOfServiceDay).toBeUndefined();
    expect(m[1]!.firstOfServiceDay).toBeUndefined();
    expect(m[1]!.dateDivider).toBeDefined();
  });
});
