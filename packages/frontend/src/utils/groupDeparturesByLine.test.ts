import { describe, it, expect } from "vitest";
import type { Departure } from "@pt/shared";
import { groupDeparturesByLine } from "./groupDeparturesByLine.ts";

function dep(over: Partial<Departure> & { routeShortName: string; scheduledTime: string }): Departure {
  return {
    routeId: over.routeId ?? `route-${over.routeShortName}`,
    routeShortName: over.routeShortName,
    routeColor: over.routeColor,
    mode: over.mode ?? "BUS",
    subMode: over.subMode,
    headsign: over.headsign ?? "Somewhere",
    scheduledTime: over.scheduledTime,
    predictedTime: over.predictedTime,
    delaySeconds: over.delaySeconds,
    tripId: over.tripId ?? `trip-${over.routeShortName}-${over.scheduledTime}`,
    cancelled: over.cancelled,
  };
}

const T0 = new Date("2026-05-05T12:00:00Z").getTime();
const at = (offsetMin: number) => new Date(T0 + offsetMin * 60_000).toISOString();

describe("groupDeparturesByLine", () => {
  it("returns [] for empty input", () => {
    expect(groupDeparturesByLine([])).toEqual([]);
  });

  it("sorts groups by soonest effective departure regardless of input order", () => {
    const groups = groupDeparturesByLine([
      dep({ routeShortName: "3", scheduledTime: at(22) }),
      dep({ routeShortName: "63", scheduledTime: at(25) }),
      dep({ routeShortName: "7", scheduledTime: at(1) }),
    ]);

    expect(groups.map((g) => g.routeShortName)).toEqual(["7", "3", "63"]);
  });

  it("uses predictedTime over scheduledTime when ranking groups", () => {
    const groups = groupDeparturesByLine([
      dep({ routeShortName: "A", scheduledTime: at(20), predictedTime: at(2) }),
      dep({ routeShortName: "B", scheduledTime: at(5) }),
    ]);

    expect(groups.map((g) => g.routeShortName)).toEqual(["A", "B"]);
  });

  it("sorts departures within each group by effective time", () => {
    const groups = groupDeparturesByLine([
      dep({ routeShortName: "9", scheduledTime: at(30), tripId: "t-30" }),
      dep({ routeShortName: "9", scheduledTime: at(5), tripId: "t-5" }),
      dep({ routeShortName: "9", scheduledTime: at(15), tripId: "t-15" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].departures.map((d) => d.tripId)).toEqual(["t-5", "t-15", "t-30"]);
  });

  it("treats different headsigns on the same routeId as separate groups", () => {
    const groups = groupDeparturesByLine([
      dep({ routeShortName: "4", routeId: "r4", headsign: "North", scheduledTime: at(20) }),
      dep({ routeShortName: "4", routeId: "r4", headsign: "South", scheduledTime: at(5) }),
    ]);

    expect(groups.map((g) => g.headsign)).toEqual(["South", "North"]);
  });

  it("retains cancelled departures (filtering is the caller's policy)", () => {
    const groups = groupDeparturesByLine([
      dep({ routeShortName: "9", scheduledTime: at(5), cancelled: true, tripId: "t-cancelled" }),
      dep({ routeShortName: "9", scheduledTime: at(15), tripId: "t-active" }),
    ]);

    expect(groups[0].departures.map((d) => d.tripId)).toEqual(["t-cancelled", "t-active"]);
    expect(groups[0].departures[0].cancelled).toBe(true);
  });

  it("preserves input order for departures with identical effective times (stable sort)", () => {
    const groups = groupDeparturesByLine([
      dep({ routeShortName: "9", scheduledTime: at(10), tripId: "t-first" }),
      dep({ routeShortName: "9", scheduledTime: at(10), tripId: "t-second" }),
      dep({ routeShortName: "9", scheduledTime: at(10), tripId: "t-third" }),
    ]);

    expect(groups[0].departures.map((d) => d.tripId)).toEqual(["t-first", "t-second", "t-third"]);
  });

  it("uses the first-encountered departure's metadata when same line appears with diverging fields", () => {
    const groups = groupDeparturesByLine([
      dep({ routeShortName: "5", routeColor: "red", scheduledTime: at(5) }),
      dep({ routeShortName: "5", routeColor: "blue", scheduledTime: at(15) }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].routeColor).toBe("red");
  });

  it("emits a stable React key in the format routeId::headsign", () => {
    const groups = groupDeparturesByLine([
      dep({ routeShortName: "1", routeId: "route-1", headsign: "Center", scheduledTime: at(5) }),
    ]);

    expect(groups[0].key).toBe("route-1::Center");
  });
});
