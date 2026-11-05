import { describe, expect, it } from "vitest";
import {
  buildGtfsCorridorFeatureCollection,
  MAX_LOCAL_CORRIDOR_FEATURES,
} from "../../src/components/Map/gtfsCorridors.ts";

const POLY_A = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
const POLY_B = "_p~iF~ps|U_ulLnnqC";

describe("buildGtfsCorridorFeatureCollection", () => {
  it("deduplicates exact shape geometry and aggregates route metadata", () => {
    const data = buildGtfsCorridorFeatureCollection({
      shapes: [
        { shapeId: "S1", encodedPolyline: POLY_A },
        { shapeId: "S2", encodedPolyline: POLY_A },
        { shapeId: "S3", encodedPolyline: POLY_B },
      ],
      trips: [
        { tripId: "T1", routeId: "R1", shapeId: "S1" },
        { tripId: "T2", routeId: "R1", shapeId: "S1" },
        { tripId: "T3", routeId: "R2", shapeId: "S2" },
        { tripId: "T4", routeId: "R3", shapeId: "S3" },
      ],
      routes: [
        { id: "R1", mode: "BUS" },
        { id: "R2", mode: "BUS" },
        { id: "R3", mode: "RAIL" },
      ],
    });

    expect(data.features).toHaveLength(2);
    expect(data.features[0].properties).toMatchObject({
      id: "S1",
      mode: "BUS",
      routeCount: 2,
      shapeCount: 2,
      tripCount: 3,
    });
    expect(data.features[0].geometry.coordinates.length).toBeGreaterThan(1);
  });

  it("only draws referenced, decodable shapes", () => {
    const data = buildGtfsCorridorFeatureCollection({
      shapes: [
        { shapeId: "used", encodedPolyline: POLY_A },
        { shapeId: "orphan", encodedPolyline: POLY_B },
        { shapeId: "bad", encodedPolyline: "x" },
      ],
      trips: [
        { tripId: "T1", routeId: "R1", shapeId: "used" },
        { tripId: "T2", routeId: "R1", shapeId: "missing" },
        { tripId: "T3", routeId: "R1", shapeId: "bad" },
        { tripId: "T4", routeId: "R1" },
      ],
      routes: [{ id: "R1", mode: "TRAM" }],
    });

    expect(data.features).toHaveLength(1);
    expect(data.features[0].properties.id).toBe("used");
  });

  it("caps output by most-used corridors", () => {
    const data = buildGtfsCorridorFeatureCollection({
      shapes: [
        { shapeId: "busy", encodedPolyline: POLY_A },
        { shapeId: "quiet", encodedPolyline: POLY_B },
      ],
      trips: [
        { tripId: "T1", routeId: "R1", shapeId: "quiet" },
        { tripId: "T2", routeId: "R1", shapeId: "busy" },
        { tripId: "T3", routeId: "R1", shapeId: "busy" },
      ],
      routes: [{ id: "R1", mode: "BUS" }],
      maxFeatures: 1,
    });

    expect(data.features).toHaveLength(1);
    expect(data.features[0].properties.id).toBe("busy");
    expect(MAX_LOCAL_CORRIDOR_FEATURES).toBeGreaterThan(1);
  });

  it("renders producer sidecar point-array shapes", () => {
    const data = buildGtfsCorridorFeatureCollection({
      shapes: [
        {
          shapeId: "points-a",
          points: [
            { lat: 54.6872, lon: 25.2797 },
            { lat: 54.688, lon: 25.281 },
          ],
        },
      ],
      trips: [{ tripId: "T1", routeId: "R1", shapeId: "points-a" }],
      routes: [{ id: "R1", mode: "BUS" }],
    });

    expect(data.features).toHaveLength(1);
    expect(data.features[0].geometry.coordinates).toEqual([
      [25.2797, 54.6872],
      [25.281, 54.688],
    ]);
  });

  it("falls back to route stop sequences when GTFS shapes are unavailable", () => {
    const data = buildGtfsCorridorFeatureCollection({
      shapes: [],
      trips: [
        { tripId: "T1", routeId: "R1" },
        { tripId: "T2", routeId: "R1" },
      ],
      routes: [
        {
          id: "R1",
          mode: "BUS",
          stopIds: ["A", "B", "C"],
        },
      ],
      stops: [
        { id: "A", lat: 54.6872, lon: 25.2797 },
        { id: "B", lat: 54.688, lon: 25.281 },
        { id: "C", lat: 54.689, lon: 25.282 },
      ],
    });

    expect(data.features).toHaveLength(1);
    expect(data.features[0].properties).toMatchObject({
      id: "stopseq:R1",
      mode: "BUS",
      routeCount: 1,
      tripCount: 2,
    });
    expect(data.features[0].geometry.coordinates).toEqual([
      [25.2797, 54.6872],
      [25.281, 54.688],
      [25.282, 54.689],
    ]);
  });

  it("keeps repeated stops in stop-sequence fallback corridors", () => {
    const data = buildGtfsCorridorFeatureCollection({
      shapes: [],
      trips: [{ tripId: "T1", routeId: "LOOP" }],
      routes: [{ id: "LOOP", mode: "TRAM", stopIds: ["A", "B", "A"] }],
      stops: [
        { id: "A", lat: 54.6872, lon: 25.2797 },
        { id: "B", lat: 54.688, lon: 25.281 },
      ],
    });

    expect(data.features).toHaveLength(1);
    expect(data.features[0].geometry.coordinates).toEqual([
      [25.2797, 54.6872],
      [25.281, 54.688],
      [25.2797, 54.6872],
    ]);
  });

  it("sorts equal-weight stop-sequence fallback corridors without shape ids", () => {
    const data = buildGtfsCorridorFeatureCollection({
      shapes: [],
      trips: [
        { tripId: "T1", routeId: "R1" },
        { tripId: "T2", routeId: "R2" },
      ],
      routes: [
        { id: "R1", mode: "BUS", stopIds: ["A", "B"] },
        { id: "R2", mode: "BUS", stopIds: ["C", "D"] },
      ],
      stops: [
        { id: "A", lat: 54.6872, lon: 25.2797 },
        { id: "B", lat: 54.688, lon: 25.281 },
        { id: "C", lat: 54.689, lon: 25.282 },
        { id: "D", lat: 54.69, lon: 25.283 },
      ],
    });

    expect(data.features.map((feature) => feature.properties.id)).toEqual([
      "stopseq:R1",
      "stopseq:R2",
    ]);
  });

  it("uses direction patterns before canonical stopIds for fallback geometry", () => {
    const data = buildGtfsCorridorFeatureCollection({
      shapes: [],
      trips: [{ tripId: "T1", routeId: "R1" }],
      routes: [
        {
          id: "R1",
          mode: "BUS",
          stopIds: ["A", "B"],
          directionPatterns: [{ stopIds: ["B", "A"] }],
        },
      ],
      stops: [
        { id: "A", lat: 54.6872, lon: 25.2797 },
        { id: "B", lat: 54.688, lon: 25.281 },
      ],
    });

    expect(data.features).toHaveLength(1);
    expect(data.features[0].geometry.coordinates).toEqual([
      [25.281, 54.688],
      [25.2797, 54.6872],
    ]);
  });
});
