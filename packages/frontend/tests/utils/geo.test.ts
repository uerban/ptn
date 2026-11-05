import { describe, it, expect } from "vitest";
import {
  haversineDistance,
  bearing,
  nearestPointOnSegment,
  progressAlongLine,
  cardinalDirection,
} from "../../src/utils/geo.ts";

describe("haversineDistance", () => {
  it("returns 0 for same point", () => {
    const p = { lat: 54.35, lon: 18.65 };
    expect(haversineDistance(p, p)).toBeCloseTo(0, 0);
  });

  it("computes distance between Gdansk and Warsaw (~300km)", () => {
    const gdansk = { lat: 54.35, lon: 18.65 };
    const warsaw = { lat: 52.23, lon: 21.01 };
    const dist = haversineDistance(gdansk, warsaw);
    expect(dist).toBeGreaterThan(280_000);
    expect(dist).toBeLessThan(320_000);
  });
});

describe("bearing", () => {
  it("returns ~0 for due north", () => {
    const from = { lat: 50.0, lon: 18.0 };
    const to = { lat: 51.0, lon: 18.0 };
    const b = bearing(from, to);
    expect(b).toBeCloseTo(0, 0);
  });

  it("returns ~90 for due east", () => {
    const from = { lat: 50.0, lon: 18.0 };
    const to = { lat: 50.0, lon: 19.0 };
    const b = bearing(from, to);
    expect(b).toBeGreaterThan(85);
    expect(b).toBeLessThan(95);
  });

  it("returns ~180 for due south", () => {
    const from = { lat: 51.0, lon: 18.0 };
    const to = { lat: 50.0, lon: 18.0 };
    const b = bearing(from, to);
    expect(b).toBeCloseTo(180, 0);
  });
});

describe("cardinalDirection", () => {
  it("returns N for 0 degrees", () => {
    expect(cardinalDirection(0)).toBe("N");
  });

  it("returns E for 90 degrees", () => {
    expect(cardinalDirection(90)).toBe("E");
  });

  it("returns SW for 225 degrees", () => {
    expect(cardinalDirection(225)).toBe("SW");
  });

  it("returns N for 350 degrees", () => {
    expect(cardinalDirection(350)).toBe("N");
  });
});

describe("nearestPointOnSegment", () => {
  it("returns start when point projects before segment", () => {
    const p = { lat: 0, lon: -1 };
    const a = { lat: 0, lon: 0 };
    const b = { lat: 0, lon: 10 };
    const result = nearestPointOnSegment(p, a, b);
    expect(result.lat).toBeCloseTo(0, 4);
    expect(result.lon).toBeCloseTo(0, 1);
  });

  it("returns end when point projects past segment", () => {
    const p = { lat: 0, lon: 11 };
    const a = { lat: 0, lon: 0 };
    const b = { lat: 0, lon: 10 };
    const result = nearestPointOnSegment(p, a, b);
    expect(result.lat).toBeCloseTo(0, 4);
    expect(result.lon).toBeCloseTo(10, 1);
  });

  it("returns projected point on segment", () => {
    const p = { lat: 1, lon: 5 };
    const a = { lat: 0, lon: 0 };
    const b = { lat: 0, lon: 10 };
    const result = nearestPointOnSegment(p, a, b);
    expect(result.lat).toBeCloseTo(0, 0);
    expect(result.lon).toBeCloseTo(5, 0);
  });
});

describe("progressAlongLine", () => {
  it("returns 0 at the start of a line", () => {
    const line = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 10 },
    ];
    const pos = { lat: 0, lon: 0 };
    expect(progressAlongLine(pos, line)).toBeCloseTo(0, 1);
  });

  it("returns 1 at the end of a line", () => {
    const line = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 10 },
    ];
    const pos = { lat: 0, lon: 10 };
    expect(progressAlongLine(pos, line)).toBeCloseTo(1, 1);
  });

  it("returns ~0.5 at the midpoint", () => {
    const line = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 10 },
    ];
    const pos = { lat: 0, lon: 5 };
    const progress = progressAlongLine(pos, line);
    expect(progress).toBeGreaterThan(0.4);
    expect(progress).toBeLessThan(0.6);
  });
});
