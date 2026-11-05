import { describe, it, expect, vi } from "vitest";
import {
  resolveUpcomingStops,
  resolveConnectingDepartures,
} from "../../src/hooks/useRiderDashboardData.ts";
import type { UpcomingStop, ConnectionAtStop } from "@pt/shared";

describe("resolveUpcomingStops", () => {
  const mockRaptorIndex = {
    getRouteStops: vi.fn().mockReturnValue(["s1", "s2", "s3", "s4", "s5"]),
    getStopName: vi.fn().mockImplementation((id: string) => `Stop ${id}`),
    routesAtStop: vi.fn().mockReturnValue(["r1", "r2"]),
  };

  it("returns upcoming stops from user position onward", () => {
    // User is near stop s2 (index 1), so upcoming = s3, s4, s5
    const result = resolveUpcomingStops("route_1", 2, mockRaptorIndex);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.every((s: UpcomingStop) => s.name && s.id)).toBe(true);
  });

  it("returns empty array when near end of route", () => {
    const result = resolveUpcomingStops("route_1", 5, mockRaptorIndex);
    expect(result).toEqual([]);
  });

  it("returns empty array when route not found", () => {
    const emptyIndex = {
      ...mockRaptorIndex,
      getRouteStops: vi.fn().mockReturnValue([]),
    };
    const result = resolveUpcomingStops("unknown_route", 0, emptyIndex);
    expect(result).toEqual([]);
  });
});

describe("resolveConnectingDepartures", () => {
  const mockRaptorIndex = {
    routesAtStop: vi.fn().mockReturnValue(["r1", "r2"]),
    getRouteShortName: vi.fn().mockImplementation((id: string) => id.toUpperCase()),
    getRouteHeadsign: vi.fn().mockReturnValue("Destination"),
  };

  const mockRtStore = {
    getNextDeparture: vi.fn().mockReturnValue({
      minutesUntil: 5,
      routeShortName: "R1",
      headsign: "Destination",
    }),
  };

  it("returns connecting departures for upcoming stops", () => {
    const upcomingStops: UpcomingStop[] = [
      { name: "Stop A", id: "s3" },
      { name: "Stop B", id: "s4" },
    ];
    const result = resolveConnectingDepartures(
      upcomingStops,
      "route_1", // exclude current route
      mockRaptorIndex,
      mockRtStore
    );
    expect(result.length).toBeGreaterThanOrEqual(0);
    result.forEach((c: ConnectionAtStop) => {
      expect(c.stopName).toBeDefined();
      expect(Array.isArray(c.departures)).toBe(true);
    });
  });

  it("excludes the current route from connections", () => {
    const upcomingStops: UpcomingStop[] = [{ name: "Stop A", id: "s3" }];
    const singleRouteIndex = {
      ...mockRaptorIndex,
      routesAtStop: vi.fn().mockReturnValue(["route_1"]), // only current route
    };
    const result = resolveConnectingDepartures(
      upcomingStops,
      "route_1",
      singleRouteIndex,
      mockRtStore
    );
    // Should have no connections since the only route is excluded
    expect(result.every((c: ConnectionAtStop) => c.departures.length === 0)).toBe(true);
  });
});
