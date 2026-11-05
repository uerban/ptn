import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildTransitGeometry,
  __resetWarnedSets,
  __findNearestShapeIdxForTests,
} from "../../../src/services/legGeometry/buildTransitGeometry.ts";
import { clearShapeDecodeCache } from "../../../src/services/legGeometry/shapeDecodeCache.ts";
import type { LonLat, RaptorLeg } from "@pt/shared";

const LEG: RaptorLeg = {
  type: "transit", fromStopId: "A", toStopId: "C",
  departSecs: 0, arriveSecs: 300,
  routeId: "R1", tripId: "T1",
  boardStopIdx: 0, alightStopIdx: 2,
};
const ROUTE = { id: "R1", stopIds: ["A", "B", "C"] };
const STOPS = [
  { id: "A", lat: 54.1, lon: 25.1 },
  { id: "B", lat: 54.2, lon: 25.2 },
  { id: "C", lat: 54.3, lon: 25.3 },
];

beforeEach(() => {
  clearShapeDecodeCache();
  __resetWarnedSets();
});

describe("buildTransitGeometry", () => {
  // Encodes 5 points (54.0,25.0)→(54.4,25.4) in 0.1° steps.
  // Leg boards at A=(54.1,25.1) and alights at C=(54.3,25.3) — the shape
  // slice should return exactly those 3 interior points.
  const ALIGNED_SHAPE_POLYLINE = "_{qhI_yqwC_pR_pR_pR_pR_pR_pR_pR_pR";

  it('shape tier: slices to board→alight segment when fromLocation/toLocation provided', () => {
    const shape = { shapeId: "S", encodedPolyline: ALIGNED_SHAPE_POLYLINE, source: "gtfs" as const };
    const r = buildTransitGeometry({
      kind: "leg", leg: LEG, route: ROUTE, trip: { shapeId: "S" }, shape, stops: STOPS,
      fromLocation: { lat: 54.1, lon: 25.1 },
      toLocation: { lat: 54.3, lon: 25.3 },
    });
    expect(r.source).toBe("shape");
    expect(r.partial).toBe(false);
    expect(r.coords).toEqual([[25.1, 54.1], [25.2, 54.2], [25.3, 54.3]]);
  });

  it('shape tier: full shape returned for stopIds (line overlay, no slicing)', () => {
    const shape = { shapeId: "S", encodedPolyline: ALIGNED_SHAPE_POLYLINE, source: "gtfs" as const };
    const r = buildTransitGeometry({
      kind: "stopIds",
      explicitStopIds: ["A", "B", "C"], stops: STOPS,
      fromLocation: { lat: 54.1, lon: 25.1 }, toLocation: { lat: 54.3, lon: 25.3 },
      shape,
    });
    expect(r.source).toBe("shape");
    expect(r.coords).toHaveLength(5);
  });

  it('shape tier: full shape returned when fromLocation/toLocation absent', () => {
    const shape = { shapeId: "S2", encodedPolyline: ALIGNED_SHAPE_POLYLINE, source: "gtfs" as const };
    const r = buildTransitGeometry({ kind: "leg", leg: LEG, route: ROUTE, trip: { shapeId: "S2" }, shape, stops: STOPS });
    expect(r.source).toBe("shape");
    expect(r.coords).toHaveLength(5);
  });

  it('shape tier: degenerate snap falls through to intermediate, warns once with context, no error log', () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // Two-point shape far from the stops — both board and alight snap to index 0,
    // producing a single-element slice that triggers the fallback.
    const twoPointShape = { shapeId: "S3", encodedPolyline: "_p~iF~ps|U_ulLnnqC", source: "gtfs" as const };
    const input = {
      kind: "leg" as const, leg: LEG, route: ROUTE, trip: { shapeId: "S3" }, shape: twoPointShape, stops: STOPS,
      fromLocation: { lat: 54.1, lon: 25.1 },
      toLocation: { lat: 54.3, lon: 25.3 },
    };
    const r = buildTransitGeometry(input);
    expect(r.source).toBe("intermediate");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("degenerate"),
      expect.objectContaining({ fromLocation: input.fromLocation, toLocation: input.toLocation }),
    );
    expect(err).not.toHaveBeenCalled();

    // Second call with same shapeId — dedup suppresses the warn.
    buildTransitGeometry(input);
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockRestore();
    err.mockRestore();
  });

  describe('nearestShapeIdx threshold (snap-distance guard)', () => {
    // Five vertices in Vilnius region (54°N, 25°E), 0.1° apart on diagonal.
    const VILNIUS_SHAPE: LonLat[] = [
      [25.0, 54.0], [25.1, 54.1], [25.2, 54.2], [25.3, 54.3], [25.4, 54.4],
    ];

    it('returns the nearest index when a vertex is within the snap threshold', () => {
      // Stop directly between vertices 1 and 2.
      expect(__findNearestShapeIdxForTests(VILNIUS_SHAPE, { lat: 54.15, lon: 25.15 })).toBe(1);
    });

    it('returns -1 when no vertex is within the snap threshold (stop in a different city)', () => {
      // Stop in California — every Vilnius vertex is ~10000 km away.
      expect(__findNearestShapeIdxForTests(VILNIUS_SHAPE, { lat: 38.5, lon: -120.2 })).toBe(-1);
    });

    it('respects startIdx so alight cannot snap before board', () => {
      // Stop near vertex 0, but search starts at index 3.
      expect(__findNearestShapeIdxForTests(VILNIUS_SHAPE, { lat: 54.0, lon: 25.0 }, 3)).toBe(3);
    });

    it('returns -1 when startIdx is set but no vertex from there is within threshold', () => {
      // Start at index 3, but stop is far from the entire shape.
      expect(__findNearestShapeIdxForTests(VILNIUS_SHAPE, { lat: 38.5, lon: -120.2 }, 3)).toBe(-1);
    });
  });

  it('intermediate full when shape missing + stops resolve', () => {
    const r = buildTransitGeometry({ kind: "leg", leg: LEG, route: ROUTE, trip: {}, stops: STOPS });
    expect(r.source).toBe("intermediate");
    expect(r.partial).toBe(false);
    expect(r.coords).toEqual([[25.1, 54.1], [25.2, 54.2], [25.3, 54.3]]);
  });

  it('intermediate + partial=true at ≥ max(3, 0.8*slice)', () => {
    const longLeg: RaptorLeg = { ...LEG, boardStopIdx: 0, alightStopIdx: 4 };
    const longRoute = { id: "R1", stopIds: ["A", "B", "C", "D", "E"] };
    const resolved = [STOPS[0], undefined, STOPS[2], STOPS[2], STOPS[2]] as Array<typeof STOPS[0] | undefined>;
    const r = buildTransitGeometry({ kind: "leg", leg: longLeg, route: longRoute, trip: {}, stops: resolved });
    expect(r.source).toBe("intermediate");
    expect(r.partial).toBe(true);
  });

  it('endpoints below threshold', () => {
    const longLeg: RaptorLeg = { ...LEG, boardStopIdx: 0, alightStopIdx: 4 };
    const longRoute = { id: "R1", stopIds: ["A", "B", "C", "D", "E"] };
    const only2 = [STOPS[0], undefined, undefined, undefined, STOPS[2]] as Array<typeof STOPS[0] | undefined>;
    const r = buildTransitGeometry({
      kind: "leg",
      leg: longLeg, route: longRoute, trip: {}, stops: only2,
      fromLocation: { lat: 54.0, lon: 25.0 },
      toLocation: { lat: 54.9, lon: 25.9 },
    });
    expect(r.source).toBe("endpoints");
    expect(r.coords).toEqual([[25.0, 54.0], [25.9, 54.9]]);
  });

  it('endpoints + dev warn when boardStopIdx > alightStopIdx', () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad: RaptorLeg = { ...LEG, boardStopIdx: 3, alightStopIdx: 1 };
    const r = buildTransitGeometry({
      kind: "leg",
      leg: bad, route: ROUTE, trip: {}, stops: STOPS,
      fromLocation: { lat: 54.0, lon: 25.0 }, toLocation: { lat: 54.9, lon: 25.9 },
    });
    expect(r.source).toBe("endpoints");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('circular route uses alightStopIdx (not first-occurrence indexOf)', () => {
    const circRoute = { id: "R1", stopIds: ["T", "X", "Y", "T"] };
    const circStops = [
      { id: "X", lat: 11, lon: 21 },
      { id: "Y", lat: 12, lon: 22 },
      { id: "T", lat: 13, lon: 23 },
    ];
    const circLeg: RaptorLeg = {
      ...LEG, fromStopId: "X", toStopId: "T", boardStopIdx: 1, alightStopIdx: 3,
    };
    const r = buildTransitGeometry({ kind: "leg", leg: circLeg, route: circRoute, trip: {}, stops: circStops });
    expect(r.coords).toEqual([[21, 11], [22, 12], [23, 13]]);
  });

  it('malformed polyline falls back to intermediate + exactly one error log, no warn', () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = { shapeId: "S-bad", encodedPolyline: "   ", source: "gtfs" as const };
    const r = buildTransitGeometry({
      kind: "leg",
      leg: LEG, route: ROUTE, trip: { shapeId: "S-bad" }, shape: bad, stops: STOPS,
    });
    expect(r.source).toBe("intermediate");
    expect(err).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    err.mockRestore();
    warn.mockRestore();
  });

  it('explicit stopIds path (LineRouteOverlay): returns pattern-order coords', () => {
    const r = buildTransitGeometry({
      kind: "stopIds",
      fromLocation: { lat: 54.1, lon: 25.1 }, toLocation: { lat: 54.3, lon: 25.3 },
      explicitStopIds: ["A", "B", "C"], stops: STOPS,
    });
    expect(r.source).toBe("intermediate");
    expect(r.coords).toEqual([[25.1, 54.1], [25.2, 54.2], [25.3, 54.3]]);
  });
});
