import { describe, it, expect } from "vitest";
import { parseCoordinateEndpoint } from "../../src/pages/Search.tsx";

describe("Search coordinate parsing", () => {
  it("parses a raw lat/lon pair into a mappoint endpoint", () => {
    expect(parseCoordinateEndpoint("54.7138, 25.2506")).toEqual({
      kind: "mappoint",
      lat: 54.7138,
      lon: 25.2506,
    });
  });

  it("returns null for free text or out-of-range coordinates", () => {
    expect(parseCoordinateEndpoint("Beta Plaza Annex")).toBeNull();
    expect(parseCoordinateEndpoint("91, 20")).toBeNull();
    expect(parseCoordinateEndpoint("54.7, 181")).toBeNull();
  });
});
