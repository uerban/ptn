import { describe, expect, it } from "vitest";
import { projectGeoSideToScreen } from "../../src/components/Map/cardHintsScreen.ts";

const ORIGIN = { lat: 54.6872, lon: 25.2797 };

describe("projectGeoSideToScreen", () => {
  it("returns null for an absent or degenerate side", () => {
    const project = () => ({ x: 0, y: 0 });
    expect(projectGeoSideToScreen(ORIGIN, null, project)).toBeNull();
    expect(projectGeoSideToScreen(ORIGIN, { x: 0, y: 0 }, project)).toBeNull();
  });

  it("projects east and north correctly on a north-up map", () => {
    const project = (point: typeof ORIGIN) => ({
      x: (point.lon - ORIGIN.lon) * 1_000_000,
      y: -(point.lat - ORIGIN.lat) * 1_000_000,
    });

    const east = projectGeoSideToScreen(ORIGIN, { x: 1, y: 0 }, project)!;
    const north = projectGeoSideToScreen(ORIGIN, { x: 0, y: 1 }, project)!;
    expect(east.dx).toBeCloseTo(1);
    expect(east.dy).toBeCloseTo(0);
    expect(north.dx).toBeCloseTo(0);
    expect(north.dy).toBeCloseTo(-1);
  });

  it("uses the supplied rotated and pitched map transform", () => {
    // Start with north-up local pixels (east, -north), rotate them 90° and
    // compress the rotated y axis to model pitch.
    const project = (point: typeof ORIGIN) => {
      const east = (point.lon - ORIGIN.lon) * 1_000_000;
      const screenNorth = -(point.lat - ORIGIN.lat) * 1_000_000;
      return { x: -screenNorth, y: east * 0.4 };
    };

    const north = projectGeoSideToScreen(ORIGIN, { x: 0, y: 1 }, project)!;
    const east = projectGeoSideToScreen(ORIGIN, { x: 1, y: 0 }, project)!;
    expect(north.dx).toBeCloseTo(1);
    expect(north.dy).toBeCloseTo(0);
    expect(east.dx).toBeCloseTo(0);
    expect(east.dy).toBeCloseTo(1);
  });
});
