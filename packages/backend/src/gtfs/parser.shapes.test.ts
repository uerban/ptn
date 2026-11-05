import { describe, it, expect } from "vitest";
import { parseShapes, type GtfsShapePoint } from "./parser.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("parseShapes", () => {
  it("parses a well-formed file", async () => {
    const csv = [
      "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence",
      "A,54.1,25.1,1",
      "A,54.2,25.2,2",
      "B,54.3,25.3,1",
    ].join("\n");
    const rows = await parseShapes(enc(csv));
    expect(rows).toEqual<GtfsShapePoint[]>([
      { shapeId: "A", lat: 54.1, lon: 25.1, sequence: 1 },
      { shapeId: "A", lat: 54.2, lon: 25.2, sequence: 2 },
      { shapeId: "B", lat: 54.3, lon: 25.3, sequence: 1 },
    ]);
  });

  it("skips malformed rows (NaN coord or missing id)", async () => {
    const csv = [
      "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence",
      ",54.1,25.1,1",
      "A,notanum,25.2,2",
      "A,54.3,25.3,3",
    ].join("\n");
    const rows = await parseShapes(enc(csv));
    expect(rows).toEqual<GtfsShapePoint[]>([
      { shapeId: "A", lat: 54.3, lon: 25.3, sequence: 3 },
    ]);
  });

  it("returns [] for header-only input", async () => {
    const rows = await parseShapes(enc("shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n"));
    expect(rows).toEqual([]);
  });
});
