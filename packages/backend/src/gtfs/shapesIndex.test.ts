import { describe, it, expect, vi } from "vitest";
import { buildShapesIndex } from "./shapesIndex.js";
import type { GtfsShapePoint, GtfsTrip } from "./parser.js";

const trip = (tripId: string, shapeId?: string): GtfsTrip => ({
  tripId, routeId: "R1", serviceId: "S1", headsign: "", shapeId,
});
const pt = (shapeId: string, lat: number, lon: number, sequence: number): GtfsShapePoint =>
  ({ shapeId, lat, lon, sequence });

describe("buildShapesIndex", () => {
  it("encodes polyline5 in sequence order", () => {
    const pts = [pt("A", 54.2, 25.2, 2), pt("A", 54.1, 25.1, 1)];
    const trips = [trip("T1", "A")];
    const { shapes, droppedCount } = buildShapesIndex({
      shapePoints: pts, trips,
      caps: { shapesCount: 10, pointsPerShape: 10, shapesEncodedBytes: 1_000_000 },
    });
    expect(shapes).toHaveLength(1);
    expect(shapes[0].shapeId).toBe("A");
    expect(shapes[0].encodedPolyline.length).toBeGreaterThan(0);
    expect(droppedCount).toBe(0);
  });

  it("drops shapes with no referencing trip", () => {
    const pts = [pt("orphan", 0, 0, 1), pt("ref", 0, 0, 1)];
    const trips = [trip("T1", "ref")];
    const { shapes } = buildShapesIndex({
      shapePoints: pts, trips,
      caps: { shapesCount: 10, pointsPerShape: 10, shapesEncodedBytes: 1_000_000 },
    });
    expect(shapes.map((s) => s.shapeId)).toEqual(["ref"]);
  });

  it("drops over pointsPerShape entirely (not truncated)", () => {
    const pts = [pt("big", 0, 0, 1), pt("big", 0, 0, 2), pt("big", 0, 0, 3)];
    const trips = [trip("T1", "big")];
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { shapes, droppedCount } = buildShapesIndex({
      shapePoints: pts, trips,
      caps: { shapesCount: 10, pointsPerShape: 2, shapesEncodedBytes: 1_000_000 },
    });
    expect(shapes).toHaveLength(0);
    expect(droppedCount).toBe(1);
    info.mockRestore();
  });

  it("shapesCount enforced by lowest ref-count, tiebreak lex asc by shapeId", () => {
    const pts = [pt("A", 0, 0, 1), pt("B", 0, 0, 1), pt("C", 0, 0, 1)];
    const trips = [
      trip("T1", "A"), trip("T2", "A"),
      trip("T3", "B"),
      trip("T4", "C"),
    ];
    const { shapes } = buildShapesIndex({
      shapePoints: pts, trips,
      caps: { shapesCount: 2, pointsPerShape: 10, shapesEncodedBytes: 1_000_000 },
    });
    expect(shapes.map((s) => s.shapeId).sort()).toEqual(["A", "B"]);
  });

  it("shapesEncodedBytes enforced by dropping lowest ref-count first", () => {
    const pts = [pt("A", 0, 0, 1), pt("B", 0, 0, 1)];
    const trips = [trip("T1", "A"), trip("T2", "A"), trip("T3", "B")];
    const { shapes } = buildShapesIndex({
      shapePoints: pts, trips,
      caps: { shapesCount: 10, pointsPerShape: 10, shapesEncodedBytes: 1 },
    });
    expect(shapes).toHaveLength(0);
  });
});
