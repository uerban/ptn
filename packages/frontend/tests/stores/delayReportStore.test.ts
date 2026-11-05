import { describe, it, expect, beforeEach, vi } from "vitest";
import { useDelayReportStore } from "../../src/stores/delayReportStore.ts";

describe("delayReportStore", () => {
  beforeEach(() => {
    useDelayReportStore.setState({ reports: [] });
  });

  it("starts with empty reports", () => {
    expect(useDelayReportStore.getState().reports).toEqual([]);
  });

  it("addReport adds a report with generated id", () => {
    useDelayReportStore.getState().addReport({
      tripId: "trip-1",
      routeId: "route-1",
      routeShortName: "42",
      timestamp: Date.now(),
      category: "slight",
    });

    const reports = useDelayReportStore.getState().reports;
    expect(reports).toHaveLength(1);
    expect(reports[0].id).toBeDefined();
    expect(reports[0].routeShortName).toBe("42");
    expect(reports[0].category).toBe("slight");
  });

  it("addReport caps at 100 most recent reports", () => {
    const { addReport } = useDelayReportStore.getState();
    for (let i = 0; i < 105; i++) {
      addReport({
        tripId: `trip-${i}`,
        routeId: "route-1",
        routeShortName: "42",
        timestamp: Date.now(),
        category: "slight",
      });
    }

    const reports = useDelayReportStore.getState().reports;
    expect(reports.length).toBeLessThanOrEqual(100);
  });

  it("getReportsForRoute returns only matching route", () => {
    const now = Date.now();
    useDelayReportStore.getState().addReport({
      tripId: "trip-1",
      routeId: "route-1",
      routeShortName: "42",
      timestamp: now,
      category: "slight",
    });
    useDelayReportStore.getState().addReport({
      tripId: "trip-2",
      routeId: "route-2",
      routeShortName: "15",
      timestamp: now,
      category: "major",
    });

    const route1Reports = useDelayReportStore
      .getState()
      .getReportsForRoute("route-1");
    expect(route1Reports).toHaveLength(1);
    expect(route1Reports[0].routeShortName).toBe("42");
  });

  it("getReportsForRoute respects withinMinutes filter", () => {
    const now = Date.now();
    useDelayReportStore.getState().addReport({
      tripId: "trip-1",
      routeId: "route-1",
      routeShortName: "42",
      timestamp: now - 10 * 60 * 1000, // 10 minutes ago
      category: "slight",
    });
    useDelayReportStore.getState().addReport({
      tripId: "trip-2",
      routeId: "route-1",
      routeShortName: "42",
      timestamp: now, // now
      category: "major",
    });

    const within5 = useDelayReportStore
      .getState()
      .getReportsForRoute("route-1", 5);
    expect(within5).toHaveLength(1);
    expect(within5[0].category).toBe("major");

    const within15 = useDelayReportStore
      .getState()
      .getReportsForRoute("route-1", 15);
    expect(within15).toHaveLength(2);
  });

  it("prunes reports older than 2 hours on access", () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000 - 1000;

    // Directly set state with old reports to bypass addReport's pruning
    useDelayReportStore.setState({
      reports: [
        {
          id: "old-1",
          tripId: "trip-1",
          routeId: "route-1",
          routeShortName: "42",
          timestamp: twoHoursAgo,
          category: "slight",
        },
        {
          id: "new-1",
          tripId: "trip-2",
          routeId: "route-1",
          routeShortName: "42",
          timestamp: Date.now(),
          category: "major",
        },
      ],
    });

    // Access triggers pruning
    const results = useDelayReportStore
      .getState()
      .getReportsForRoute("route-1");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("new-1");

    // State should also be pruned
    expect(useDelayReportStore.getState().reports).toHaveLength(1);
  });

  it("addReport preserves location when provided", () => {
    useDelayReportStore.getState().addReport({
      tripId: "trip-1",
      routeId: "route-1",
      routeShortName: "42",
      timestamp: Date.now(),
      category: "on_time",
      location: { lat: 54.35, lon: 18.65 },
    });

    const report = useDelayReportStore.getState().reports[0];
    expect(report.location).toEqual({ lat: 54.35, lon: 18.65 });
  });

  it("newest reports are at the front of the array", () => {
    const { addReport } = useDelayReportStore.getState();
    addReport({
      tripId: "trip-1",
      routeId: "route-1",
      routeShortName: "42",
      timestamp: Date.now() - 5000,
      category: "slight",
    });
    addReport({
      tripId: "trip-2",
      routeId: "route-1",
      routeShortName: "42",
      timestamp: Date.now(),
      category: "major",
    });

    const reports = useDelayReportStore.getState().reports;
    expect(reports[0].category).toBe("major");
    expect(reports[1].category).toBe("slight");
  });
});
