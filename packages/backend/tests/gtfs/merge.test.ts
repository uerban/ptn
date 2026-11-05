import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mergeSmallFiles } from "../../src/gtfs/loader.js";
import type { TransportMode } from "@pt/shared";

function stop(id: string, name: string) {
  return { id, name, lat: 0, lon: 0 };
}

function route(id: string, shortName: string, mode: TransportMode = "BUS") {
  return { id, shortName, color: "", mode, type: 3, agency: "" };
}

function trip(tripId: string, routeId: string) {
  return { tripId, routeId, serviceId: "s1", headsign: "", wheelchairAccessible: false };
}

function service(serviceId: string) {
  return {
    serviceId, startDate: "20260101", endDate: "20261231",
    monday: true, tuesday: true, wednesday: true, thursday: true,
    friday: true, saturday: false, sunday: false,
  };
}

describe("mergeSmallFiles", () => {
  it("concatenates stops from multiple feeds", () => {
    const feed1 = { stops: [stop("S1", "Stop 1")], routes: [], trips: [], calendar: [], calendarDates: [] };
    const feed2 = { stops: [stop("S2", "Stop 2")], routes: [], trips: [], calendar: [], calendarDates: [] };
    const merged = mergeSmallFiles([feed1, feed2]);
    expect(merged.stops).toHaveLength(2);
    expect(merged.stops.map(s => s.id)).toEqual(["S1", "S2"]);
  });

  it("deduplicates stops by ID, first feed wins", () => {
    const feed1 = { stops: [stop("S1", "Feed 1")], routes: [], trips: [], calendar: [], calendarDates: [] };
    const feed2 = { stops: [stop("S1", "Feed 2")], routes: [], trips: [], calendar: [], calendarDates: [] };
    const merged = mergeSmallFiles([feed1, feed2]);
    expect(merged.stops).toHaveLength(1);
    expect(merged.stops[0].name).toBe("Feed 1");
  });

  describe("collision warnings", () => {
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it("warns on stop_id collision and names the source feed", () => {
      const feed1 = { stops: [stop("S1", "A")], routes: [], trips: [], calendar: [], calendarDates: [] };
      const feed2 = { stops: [stop("S1", "B")], routes: [], trips: [], calendar: [], calendarDates: [] };
      mergeSmallFiles([feed1, feed2], ["bus.zip", "tram.zip"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("stop_id"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("S1"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("tram.zip"));
    });

    it("warns on route_id collision; first feed wins", () => {
      const feed1 = { stops: [], routes: [route("R1", "1", "BUS")], trips: [], calendar: [], calendarDates: [] };
      const feed2 = { stops: [], routes: [route("R1", "T1", "TRAM")], trips: [], calendar: [], calendarDates: [] };
      const merged = mergeSmallFiles([feed1, feed2]);
      expect(merged.routes).toHaveLength(1);
      expect(merged.routes[0].mode).toBe("BUS");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("route_id"));
    });

    it("warns on trip_id collision; first feed wins", () => {
      const feed1 = { stops: [], routes: [], trips: [trip("T1", "R1")], calendar: [], calendarDates: [] };
      const feed2 = { stops: [], routes: [], trips: [trip("T1", "R2")], calendar: [], calendarDates: [] };
      const merged = mergeSmallFiles([feed1, feed2]);
      expect(merged.trips).toHaveLength(1);
      expect(merged.trips[0].routeId).toBe("R1");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("trip_id"));
    });

    it("warns on service_id collision; first feed wins", () => {
      const s1 = service("S1");
      const s2 = { ...service("S1"), saturday: true };
      const feed1 = { stops: [], routes: [], trips: [], calendar: [s1], calendarDates: [] };
      const feed2 = { stops: [], routes: [], trips: [], calendar: [s2], calendarDates: [] };
      const merged = mergeSmallFiles([feed1, feed2]);
      expect(merged.calendar).toHaveLength(1);
      expect(merged.calendar[0].saturday).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("service_id"));
    });
  });

  it("merges routes from different feeds", () => {
    const feed1 = { stops: [], routes: [route("R1", "1", "BUS")], trips: [], calendar: [], calendarDates: [] };
    const feed2 = { stops: [], routes: [route("R2", "T1", "TRAM")], trips: [], calendar: [], calendarDates: [] };
    const merged = mergeSmallFiles([feed1, feed2]);
    expect(merged.routes).toHaveLength(2);
    expect(merged.routes.map(r => r.mode)).toEqual(["BUS", "TRAM"]);
  });

  it("merges trips and calendar", () => {
    const feed1 = {
      stops: [], routes: [],
      trips: [trip("T1", "R1")],
      calendar: [service("S1")],
      calendarDates: [],
    };
    const feed2 = {
      stops: [], routes: [],
      trips: [trip("T2", "R2")],
      calendar: [service("S2")],
      calendarDates: [],
    };
    const merged = mergeSmallFiles([feed1, feed2]);
    expect(merged.trips).toHaveLength(2);
    expect(merged.calendar).toHaveLength(2);
  });

  it("concatenates calendarDates without dedup", () => {
    const d1 = { serviceId: "S1", date: "20260101", exceptionType: 1 as const };
    const d2 = { serviceId: "S1", date: "20260102", exceptionType: 2 as const };
    const feed1 = { stops: [], routes: [], trips: [], calendar: [], calendarDates: [d1] };
    const feed2 = { stops: [], routes: [], trips: [], calendar: [], calendarDates: [d2] };
    const merged = mergeSmallFiles([feed1, feed2]);
    expect(merged.calendarDates).toHaveLength(2);
  });

  it("handles single feed identically to direct usage", () => {
    const feed = {
      stops: [stop("S1", "Stop 1"), stop("S2", "Stop 2")],
      routes: [route("R1", "1")],
      trips: [trip("T1", "R1")],
      calendar: [service("S1")],
      calendarDates: [],
    };
    const merged = mergeSmallFiles([feed]);
    expect(merged.stops).toHaveLength(2);
    expect(merged.routes).toHaveLength(1);
    expect(merged.trips).toHaveLength(1);
    expect(merged.calendar).toHaveLength(1);
  });

  // Regression: V8's spread (`target.push(...source)`) blows the stack once
  // source crosses ~125k args. Real GTFS feeds (Vilnius, Kraków) trip this
  // on calendar_dates.txt and shapes.txt.
  it("merges large calendarDates and shapePoints arrays without stack overflow", () => {
    const N = 200_000;
    const calendarDates = Array.from({ length: N }, (_, i) => ({
      serviceId: `s${i % 10}`,
      date: "20260101",
      exceptionType: 1 as const,
    }));
    const shapePoints = Array.from({ length: N }, (_, i) => ({
      shapeId: `sh${i % 100}`,
      lat: 0,
      lon: 0,
      sequence: i,
      distTraveled: 0,
    }));
    const feed = {
      stops: [], routes: [], trips: [], calendar: [],
      calendarDates,
      shapePoints,
    };
    const merged = mergeSmallFiles([feed]);
    expect(merged.calendarDates).toHaveLength(N);
    expect(merged.shapePoints).toHaveLength(N);
  });
});
