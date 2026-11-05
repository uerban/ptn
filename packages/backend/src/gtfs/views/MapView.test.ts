import { describe, it, expect } from "vitest";
import { buildMapView } from "./MapView.js";
import { createCanonicalStore } from "../canonical/CanonicalStore.js";
import { buildTripStringTable } from "../parser.js";

function canonicalWithStops(stops: Array<{ id: string; lat: number; lon: number }>) {
  return createCanonicalStore({
    stopTimes: new Map(),
    tripStrings: buildTripStringTable([]),
    stops: new Map(stops.map((s) => [s.id, { id: s.id, name: s.id, lat: s.lat, lon: s.lon, parentStation: "" }])),
    routes: new Map(),
    trips: new Map(),
    services: new Map(),
  });
}

describe("buildMapView", () => {
  it("builds stopRoutes from stopRouteTripCounts", () => {
    const canonical = canonicalWithStops([
      { id: "s1", lat: 0, lon: 0 },
      { id: "s2", lat: 1, lon: 1 },
    ]);
    const counts = new Map([
      ["s1", new Map([["r1", 3], ["r2", 5]])],
      ["s2", new Map([["r3", 2]])],
    ]);
    const view = buildMapView({ canonical, stopRouteTripCounts: counts });
    expect(new Set(view.getActiveRoutesForStop("s1"))).toEqual(new Set(["r1", "r2"]));
    expect(new Set(view.getActiveRoutesForStop("s2"))).toEqual(new Set(["r3"]));
    expect(view.getActiveRoutesForStop("unknown")).toEqual([]);
  });

  it("filters routes below minTripsPerRoute", () => {
    const canonical = canonicalWithStops([{ id: "s1", lat: 0, lon: 0 }]);
    const counts = new Map([
      ["s1", new Map([["r_frequent", 10], ["r_rare", 1]])],
    ]);
    const view = buildMapView({ canonical, stopRouteTripCounts: counts, minTripsPerRoute: 5 });
    expect(view.getActiveRoutesForStop("s1")).toEqual(["r_frequent"]);
  });

  it("exposes stopRouteTripCount for (stop, route) pair", () => {
    const canonical = canonicalWithStops([{ id: "s1", lat: 0, lon: 0 }]);
    const counts = new Map([["s1", new Map([["r1", 7]])]]);
    const view = buildMapView({ canonical, stopRouteTripCounts: counts });
    expect(view.getTripCount("s1", "r1")).toBe(7);
    expect(view.getTripCount("s1", "unknown")).toBe(0);
    expect(view.getTripCount("unknown", "r1")).toBe(0);
  });

  it("exposes the underlying counts map for consumers that need full access", () => {
    const canonical = canonicalWithStops([{ id: "s1", lat: 0, lon: 0 }]);
    const counts = new Map([["s1", new Map([["r1", 7], ["r2", 3]])]]);
    const view = buildMapView({ canonical, stopRouteTripCounts: counts });
    const full = view.getStopRouteTripCounts();
    expect(full.get("s1")?.get("r1")).toBe(7);
    expect(full.get("s1")?.get("r2")).toBe(3);
  });

  it("spatial grid returns stopIds whose cells overlap bbox", () => {
    const canonical = canonicalWithStops([
      { id: "s1", lat: 54.68, lon: 25.28 },
      { id: "s2", lat: 54.69, lon: 25.29 },
      { id: "s_far", lat: 48.85, lon: 2.35 },
    ]);
    const view = buildMapView({
      canonical,
      stopRouteTripCounts: new Map(),
      cellSizeDegrees: 0.02,
    });
    const ids = view.stopsInBbox({ minLat: 54.67, minLon: 25.27, maxLat: 54.70, maxLon: 25.30 });
    expect(new Set(ids)).toEqual(new Set(["s1", "s2"]));
  });

  it("stopCount matches stops Map size", () => {
    const canonical = canonicalWithStops([
      { id: "s1", lat: 0, lon: 0 },
      { id: "s2", lat: 1, lon: 1 },
    ]);
    const view = buildMapView({ canonical, stopRouteTripCounts: new Map() });
    expect(view.stopCount).toBe(2);
  });
});

describe("MapView.stopRouteEntries", () => {
  it("iterates (stopId, routes[]) pairs for stops with routes", () => {
    const canonical = canonicalWithStops([
      { id: "s1", lat: 0, lon: 0 },
      { id: "s2", lat: 0, lon: 0 },
      { id: "s3", lat: 0, lon: 0 },
    ]);
    const counts = new Map([
      ["s1", new Map([["r1", 3], ["r2", 5]])],
      ["s2", new Map([["r3", 2]])],
      // s3 has no counts → should NOT appear in iteration
    ]);
    const view = buildMapView({ canonical, stopRouteTripCounts: counts });
    const entries = Array.from(view.stopRouteEntries()).map(([stopId, routes]) => [stopId, [...routes].sort()]);
    entries.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(entries).toEqual([
      ["s1", ["r1", "r2"]],
      ["s2", ["r3"]],
    ]);
  });

  it("filters stops whose routes all fall below minTripsPerRoute", () => {
    const canonical = canonicalWithStops([{ id: "s1", lat: 0, lon: 0 }]);
    const counts = new Map([["s1", new Map([["r1", 1]])]]);
    const view = buildMapView({ canonical, stopRouteTripCounts: counts, minTripsPerRoute: 5 });
    expect(Array.from(view.stopRouteEntries())).toEqual([]);
  });
});

describe("MapView — stopsInBbox via canonical", () => {
  it("returns stops whose lat/lon is read from canonical.getStop", () => {
    const canonical = canonicalWithStops([
      { id: "A", lat: 48.85, lon: 2.35 },
      { id: "B", lat: 48.87, lon: 2.37 },
      { id: "C", lat: 49.5,  lon: 2.3  },
    ]);
    const view = buildMapView({
      canonical,
      stopRouteTripCounts: new Map(),
    });
    const result = view.stopsInBbox({ minLat: 48.8, minLon: 2.3, maxLat: 48.9, maxLon: 2.4 }).sort();
    expect(result).toEqual(["A", "B"]);
  });
});
