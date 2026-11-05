import { describe, test, expect } from "vitest";
import type { BaseEndpoint } from "@pt/shared";
import { resolveToEntryStops } from "./resolveEndpoint.ts";
import type { OsmTransferLookup } from "./stopFinder.ts";

const stops = [
  { id: "S1", name: "Stop A", lat: 54.6872, lon: 25.2797 },
  { id: "S2", name: "Stop B", lat: 54.6882, lon: 25.2797 },
  { id: "S3", name: "Stop C", lat: 54.6972, lon: 25.2797 },
  { id: "S4", name: "Stop D", lat: 54.7572, lon: 25.2797 },
];

const opts = { maxWalkSecs: 900, walkSpeedMps: 1.25 };

describe("resolveToEntryStops", () => {
  test("Stop endpoint short-circuits with walkSecs=0 for that stop", () => {
    const ep: BaseEndpoint = {
      kind: "stop",
      stopId: "S1",
      name: "Stop A",
      lat: 54.6872,
      lon: 25.2797,
    };
    const result = resolveToEntryStops(ep, stops, opts);
    const origin = result.find((s) => s.stopId === "S1");
    expect(origin).toBeDefined();
    expect(origin!.walkSecs).toBe(0);
    expect(origin!.distanceMeters).toBe(0);
  });

  test("Stop endpoint includes nearby radius stops in addition", () => {
    const ep: BaseEndpoint = {
      kind: "stop",
      stopId: "S1",
      name: "Stop A",
      lat: 54.6872,
      lon: 25.2797,
    };
    const result = resolveToEntryStops(ep, stops, opts);
    const ids = result.map((s) => s.stopId);
    expect(ids).toContain("S1");
    expect(ids).toContain("S2");
    expect(result.length).toBeGreaterThan(1);
  });

  test("MapPoint endpoint uses findStopsInRadius directly", () => {
    const ep: BaseEndpoint = {
      kind: "mappoint",
      lat: 54.6872,
      lon: 25.2797,
    };
    const result = resolveToEntryStops(ep, stops, opts);
    expect(result.length).toBeGreaterThan(0);
    const s1 = result.find((s) => s.stopId === "S1");
    expect(s1).toBeDefined();
    expect(s1!.walkSecs).toBeGreaterThanOrEqual(0);
    expect(result.every((s) => s.stopId !== undefined)).toBe(true);
  });

  test("Geocoded endpoint behaves identically to MapPoint", () => {
    const geo: BaseEndpoint = {
      kind: "geocoded",
      lat: 54.6872,
      lon: 25.2797,
      label: "Somewhere",
      provider: "bundled",
      confidence: 0.9,
    };
    const mp: BaseEndpoint = {
      kind: "mappoint",
      lat: 54.6872,
      lon: 25.2797,
    };
    const a = resolveToEntryStops(geo, stops, opts);
    const b = resolveToEntryStops(mp, stops, opts);
    expect(a).toEqual(b);
  });

  test("empty-radius result returns [] (no throw)", () => {
    const ep: BaseEndpoint = {
      kind: "mappoint",
      lat: 0,
      lon: 0,
    };
    const result = resolveToEntryStops(ep, stops, opts);
    expect(result).toEqual([]);
  });

  test("role='destination' reverses the OSM-table lookup direction", () => {
    // Asymmetric lookup so the direction is observable: S1→S2 returns
    // a value, S2→S1 does not. The endpoint is S2; with role='origin'
    // the lookup reads (S2, candidate)=undefined → haversine. With
    // role='destination' it reads (candidate, S2)=200 → table.
    const lookup: OsmTransferLookup = {
      getWalkSecs: (from, to) => {
        if (from === "S1" && to === "S2") return 200;
        return undefined;
      },
    };
    const ep: BaseEndpoint = {
      kind: "stop",
      stopId: "S2",
      name: "Stop B",
      lat: 54.6882,
      lon: 25.2797,
    };
    const stopsHere = [
      { id: "S1", name: "Stop A", lat: 54.6872, lon: 25.2797 },
      { id: "S2", name: "Stop B", lat: 54.6882, lon: 25.2797 },
    ];
    const baseOpts = { maxWalkSecs: 900, walkSpeedMps: 1.25, osmLookup: lookup };
    const asOrigin = resolveToEntryStops(ep, stopsHere, baseOpts);
    const asDestination = resolveToEntryStops(ep, stopsHere, {
      ...baseOpts,
      role: "destination",
    });
    const originS1 = asOrigin.find((s) => s.stopId === "S1");
    const destS1 = asDestination.find((s) => s.stopId === "S1");
    expect(originS1).toBeDefined();
    expect(destS1).toBeDefined();
    // Distinct values prove the lookup direction actually flipped.
    expect(destS1!.walkSecs).toBe(200);
    expect(originS1!.walkSecs).not.toBe(200);
  });

  test("stop endpoint beyond nearby radius still includes itself at walkSecs=0", () => {
    const ep: BaseEndpoint = {
      kind: "stop",
      stopId: "S4",
      name: "Stop D",
      lat: 54.7572,
      lon: 25.2797,
    };
    const tightOpts = { maxWalkSecs: 60, walkSpeedMps: 1.25 };
    const result = resolveToEntryStops(ep, stops, tightOpts);
    const self = result.find((s) => s.stopId === "S4");
    expect(self).toBeDefined();
    expect(self!.walkSecs).toBe(0);
    expect(self!.distanceMeters).toBe(0);
  });

  test("stopGroup endpoint seeds every member at walkSecs=0", () => {
    // S1 is in-radius of the centroid, S4 is well outside it. Both members
    // must be present at walkSecs=0 regardless of where the radius scan lands.
    const ep: BaseEndpoint = {
      kind: "stopGroup",
      stopIds: ["S1", "S4"],
      lat: 54.6872,
      lon: 25.2797,
      label: "Stop A / Stop D",
    };
    const result = resolveToEntryStops(ep, stops, opts);
    const s1 = result.find((s) => s.stopId === "S1");
    const s4 = result.find((s) => s.stopId === "S4");
    expect(s1).toBeDefined();
    expect(s1!.walkSecs).toBe(0);
    expect(s4).toBeDefined();
    expect(s4!.walkSecs).toBe(0);
  });

  test("stopGroup members forced to walkSecs=0 even when in radius, no duplicates", () => {
    // S1 and S2 are both inside the centroid radius, so the bare radius scan
    // would emit them with non-zero haversine walk. The stopGroup branch must
    // pin them to 0 and emit each exactly once.
    const ep: BaseEndpoint = {
      kind: "stopGroup",
      stopIds: ["S1", "S2"],
      lat: 54.6872,
      lon: 25.2797,
      label: "Stop A / Stop B",
    };
    const result = resolveToEntryStops(ep, stops, opts);
    for (const id of ["S1", "S2"]) {
      const matches = result.filter((s) => s.stopId === id);
      expect(matches.length).toBe(1);
      expect(matches[0].walkSecs).toBe(0);
    }
  });

  test("stopGroup still appends radius neighbours beyond its members", () => {
    // Member set {S1} is a subset of the in-radius stops {S1, S2, S3};
    // the non-member neighbours S2 and S3 must still appear (with their
    // own haversine walk), so the group doesn't shrink the entry set.
    const ep: BaseEndpoint = {
      kind: "stopGroup",
      stopIds: ["S1"],
      lat: 54.6872,
      lon: 25.2797,
      label: "Stop A",
    };
    const result = resolveToEntryStops(ep, stops, opts);
    const ids = result.map((s) => s.stopId);
    expect(ids).toContain("S2");
    expect(ids).toContain("S3");
    const s2 = result.find((s) => s.stopId === "S2");
    expect(s2!.walkSecs).toBeGreaterThan(0);
  });

  test("degenerate single-member stopGroup behaves like a stop endpoint", () => {
    // One member (S4) whose centroid sits far from every stop, with a tight
    // radius that excludes the member itself — so the bare radius scan would
    // drop it. Like the stop-endpoint short-circuit, the lone member must
    // still be present at walkSecs=0 / distanceMeters=0.
    const ep: BaseEndpoint = {
      kind: "stopGroup",
      stopIds: ["S4"],
      lat: 54.6872,
      lon: 25.2797,
      label: "Stop D",
    };
    const tightOpts = { maxWalkSecs: 60, walkSpeedMps: 1.25 };
    const result = resolveToEntryStops(ep, stops, tightOpts);
    const self = result.find((s) => s.stopId === "S4");
    expect(self).toBeDefined();
    expect(self!.walkSecs).toBe(0);
    expect(self!.distanceMeters).toBe(0);
  });
});
