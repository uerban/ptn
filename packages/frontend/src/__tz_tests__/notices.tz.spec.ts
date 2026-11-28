import { describe, expect, it } from "vitest";
import type { RoutingBundleRoute, RoutingBundleService, ServiceNotice } from "@pt/shared";
import { resolveNoticeTrips } from "../services/notices.ts";

// The device zone (NY / Vilnius under test:tz) must not change which trip a
// notice's first-stop start resolves to: only the feed zone counts.
describe("notice trips under a foreign device zone", () => {
  it("resolves 18:00 Vilnius to the 64800s trip", () => {
    const notice: ServiceNotice = {
      id: "choir", routeIds: ["1G"], kind: "event", free: false,
      windows: [{ start: "2026-12-03T16:00:00Z", end: "2026-12-03T17:00:00Z" }],
      displayUntil: "2026-12-03", source: "https://example.org", trips: ["2026-12-03T16:00:00Z"],
    };
    const route: RoutingBundleRoute = { id: "1G", shortName: "1G", mode: "BUS", stopIds: ["a"],
      trips: [{ tripId: "x", serviceId: "s", headsign: "", departureSecs: [64800] },
        { tripId: "y", serviceId: "s", headsign: "", departureSecs: [57600] }] };
    const calendar: RoutingBundleService[] = [{ serviceId: "s", days: Array(7).fill(true), startDate: "20261101", endDate: "20261231", exceptions: {} }];
    expect([...(resolveNoticeTrips([notice], [route], calendar, "Europe/Vilnius").get("choir") ?? [])]).toEqual(["x"]);
  });
});
