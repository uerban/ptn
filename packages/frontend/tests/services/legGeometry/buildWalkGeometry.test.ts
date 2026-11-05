import { describe, it, expect } from "vitest";
import { buildWalkGeometry } from "../../../src/services/legGeometry/buildWalkGeometry.ts";

describe("buildWalkGeometry", () => {
  it("walk-graph when coords given", () => {
    const r = buildWalkGeometry({
      fromLocation: { lat: 54.1, lon: 25.1 },
      toLocation: { lat: 54.2, lon: 25.2 },
      routeCoords: [[25.1, 54.1], [25.15, 54.15], [25.2, 54.2]],
    });
    expect(r.source).toBe("walk-graph");
    expect(r.coords.length).toBe(3);
  });

  it("endpoints when no coords", () => {
    const r = buildWalkGeometry({
      fromLocation: { lat: 54.1, lon: 25.1 },
      toLocation: { lat: 54.2, lon: 25.2 },
    });
    expect(r.source).toBe("endpoints");
    expect(r.coords).toEqual([[25.1, 54.1], [25.2, 54.2]]);
  });
});
