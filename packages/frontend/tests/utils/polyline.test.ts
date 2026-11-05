import { describe, it, expect } from "vitest";
import { decodePolyline } from "../../src/utils/polyline.ts";

describe("decodePolyline", () => {
  it("decodes a simple encoded polyline", () => {
    // Encoded polyline for two points: (38.5, -120.2) and (40.7, -120.95)
    const encoded = "_p~iF~ps|U_ulLnnqC";
    const result = decodePolyline(encoded);
    expect(result).toHaveLength(2);
    expect(result[0].lat).toBeCloseTo(38.5, 4);
    expect(result[0].lon).toBeCloseTo(-120.2, 4);
    expect(result[1].lat).toBeCloseTo(40.7, 4);
    expect(result[1].lon).toBeCloseTo(-120.95, 4);
  });

  it("returns empty array for empty string", () => {
    expect(decodePolyline("")).toEqual([]);
  });

  it("decodes a single-point polyline", () => {
    // Encoded (0, 0)
    const encoded = "??";
    const result = decodePolyline(encoded);
    expect(result).toHaveLength(1);
    expect(result[0].lat).toBeCloseTo(0, 4);
    expect(result[0].lon).toBeCloseTo(0, 4);
  });
});
