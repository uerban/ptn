import { describe, it, expect } from "vitest";
import {
  activeRouteIdsAtStop,
  resolveActivityWindow,
  stopMaybeActive,
} from "./hasUpcomingDeparture.ts";
import type { RaptorIndex } from "./raptorIndex.ts";

// Route R: canonical stopIds ["A","B"] (NOT "S"); a direction pattern that DOES
// contain "S". routesAtStop maps S→[0]. Canonical trip departs 05:00 only.
// Trip headsign "H" does NOT match directionPattern headsign "H2", so
// activeRouteIdsAtStop cannot confirm activity at "S" via the return-only branch.
function index(): RaptorIndex {
  return {
    routesAtStop: new Map([["S", [0]], ["A", [0]], ["B", [0]]]),
    routes: [{
      id: "R",
      shortName: "R",
      mode: "BUS" as const,
      stopIds: ["A", "B"],
      trips: [{
        tripId: "t1",
        serviceId: "svc",
        headsign: "H",
        departureSecs: [5 * 3600, 5 * 3600 + 120],
      }],
      directionPatterns: [{ key: "k", headsign: "H2", stopIds: ["S", "A"] }],
    }],
    services: new Map([["svc", {
      serviceId: "svc",
      startDate: "20260101",
      endDate: "20271231",
      days: [true, true, true, true, true, true, true],
      exceptions: {},
    }]]),
    routeIdToIdx: new Map([["R", 0]]),
  } as unknown as RaptorIndex;
}

describe("stopMaybeActive", () => {
  const now = new Date("2026-06-16T12:00:00Z");
  it("activeRouteIdsAtStop drops the return-only route (documents the bug)", () => {
    expect(activeRouteIdsAtStop("S", now, 2, index(), "Europe/Vilnius").size).toBe(0);
  });
  it("stopMaybeActive keeps the stop visible (fail-open)", () => {
    // True NOT because of headsigns, but because "S" is absent from route.stopIds
    // (stopIdx < 0) → return-only → indeterminate → keep. stopMaybeActive does
    // not re-inspect headsigns; it only checks stopIds membership.
    expect(stopMaybeActive("S", now, 2, index(), "Europe/Vilnius")).toBe(true);
  });
  it("stopMaybeActive is false for a canonical-only stop with no in-window departure", () => {
    // "A" IS on route.stopIds (canonical, stopIdx >= 0), so the return-only
    // fail-open branch does not fire; with no in-window departure → false.
    expect(stopMaybeActive("A", now, 2, index(), "Europe/Vilnius")).toBe(false);
  });
  it("a precomputed ActivityWindow yields identical results to the lazy path", () => {
    // useVisibleStops resolves the window once per render and threads it in;
    // the answer must not depend on which path computed the window.
    const idx = index();
    const w = resolveActivityWindow(now, 2, idx, "Europe/Vilnius");
    for (const stopId of ["S", "A", "unknown"]) {
      expect(activeRouteIdsAtStop(stopId, now, 2, idx, "Europe/Vilnius", w)).toEqual(
        activeRouteIdsAtStop(stopId, now, 2, idx, "Europe/Vilnius"),
      );
      expect(stopMaybeActive(stopId, now, 2, idx, "Europe/Vilnius", w)).toBe(
        stopMaybeActive(stopId, now, 2, idx, "Europe/Vilnius"),
      );
    }
  });
});
