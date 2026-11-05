/**
 * activeRouteIdsAtStop derives nowSecs + service day in the feed tz when a
 * feedTz is supplied, so a foreign-device "now" matches the city's wall clock.
 */
import { describe, expect, it } from "vitest";
import { activeRouteIdsAtStop } from "./hasUpcomingDeparture.ts";
import type { RaptorIndex } from "./raptorIndex.ts";

function idx(): RaptorIndex {
  // Minimal index: one route, stop "s", one trip departing at 23:15 (83700s),
  // service "svc" active Thursday 2026-01-15 (Mon-first idx 3).
  return {
    routesAtStop: new Map([["s", [0]]]),
    routes: [{ id: "R1", stopIds: ["s"], trips: [{ serviceId: "svc", headsign: "H", departureSecs: [83700] }], directionPatterns: [] }],
    services: new Map([["svc", { startDate: "20260101", endDate: "20261231", days: [false, false, false, true, false, false, false], exceptions: {} }]]),
  } as unknown as RaptorIndex;
}

describe("activeRouteIdsAtStop feed-tz now", () => {
  it("uses the feed-tz wall clock to place 'now' on the right service day", () => {
    // Instant = 2026-01-15 23:00 local Vilnius (+02:00) = 21:00 UTC. Feed-tz
    // nowSecs = 82800 (23:00); the 23:15 departure is within a 1h lookahead.
    const now = new Date(Date.UTC(2026, 0, 15, 21, 0, 0));
    const active = activeRouteIdsAtStop("s", now, 1, idx(), "Europe/Vilnius");
    expect(active.has("R1")).toBe(true);
  });

  it("resolves YESTERDAY via civil arithmetic the morning after spring-forward (DST-safe)", () => {
    // Vilnius springs forward 2026-03-29 03:00 (the civil day 20260329 is 23h
    // long). An overnight tail belonging to the 20260329 service day departs at
    // 24:20 (=88800s, i.e. 00:20 the next civil day). At the feed-tz instant
    // 2026-03-30 00:30 a rider's "yesterday" service day is 20260329.
    //
    // The OLD `now.getTime() - 86400*1000` real-second subtraction lands on
    // 20260328 (it skips the 23h civil day), so the 20260329-only service is
    // never consulted and the tail is missed. Civil `addDaysCivil(today, -1)`
    // yields 20260329 and finds it.
    const index = {
      routesAtStop: new Map([["s", [0]]]),
      routes: [
        {
          id: "RN",
          stopIds: ["s"],
          trips: [{ serviceId: "svc-sun", headsign: "Night", departureSecs: [88800] }],
          directionPatterns: [],
        },
      ],
      // Active ONLY on 20260329 (a Sunday — Mon-first idx 6).
      services: new Map([
        [
          "svc-sun",
          { startDate: "20260101", endDate: "20261231", days: [false, false, false, false, false, false, true], exceptions: {} },
        ],
      ]),
    } as unknown as RaptorIndex;

    // 2026-03-30 00:30 Vilnius (+03:00 post-spring-forward) = 2026-03-29 21:30 UTC.
    const now = new Date(Date.UTC(2026, 2, 29, 21, 30, 0));
    const active = activeRouteIdsAtStop("s", now, 1, index, "Europe/Vilnius");
    expect(active.has("RN")).toBe(true);
  });
});
