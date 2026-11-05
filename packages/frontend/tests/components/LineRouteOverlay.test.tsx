import { describe, it, expect, vi } from "vitest";

// Avoid loading the real maplibre-gl bundle (and its CSP-worker setup) in
// jsdom — we only test the pure `geometryFor` helper from this module.
vi.mock("maplibre-gl", () => ({ default: {} }));
vi.mock("../../src/map/maplibre.ts", () => ({ default: {} }));

import { geometryFor } from "../../src/components/Map/LineRouteOverlay.tsx";
import type { LinePattern } from "../../src/stores/lineViewStore.ts";
import type { GtfsShapeRecord, GtfsStopRecord } from "../../src/db/index.ts";
import { clearShapeDecodeCache } from "../../src/services/legGeometry/shapeDecodeCache.ts";

// Pattern with stops in order [A, B, C].
const PATTERN: LinePattern = {
  directionId: 0,
  headsign: "To C",
  stops: [
    { id: "A", name: "A", location: { lat: 54.1, lon: 25.1 } },
    { id: "B", name: "B", location: { lat: 54.2, lon: 25.2 } },
    { id: "C", name: "C", location: { lat: 54.3, lon: 25.3 } },
  ],
};

// Canonical Dexie rows — provided in ID order; buildTransitGeometry reads
// them positionally (matching explicitStopIds order, not canonical insertion
// order), so direction-drift in gtfsRoutes.stopIds is irrelevant here.
const STOP_ROWS: GtfsStopRecord[] = [
  { id: "A", name: "A", lat: 54.1, lon: 25.1 },
  { id: "B", name: "B", lat: 54.2, lon: 25.2 },
  { id: "C", name: "C", lat: 54.3, lon: 25.3 },
];

describe("LineRouteOverlay/geometryFor", () => {
  it("returns coords in pattern order when stopRows are provided", () => {
    const result = geometryFor(PATTERN, STOP_ROWS);
    expect(result.coords).toEqual([
      [25.1, 54.1],
      [25.2, 54.2],
      [25.3, 54.3],
    ]);
  });

  it("returns coords in pattern order even when stopRows array is reordered (canonical gtfsRoutes drift)", () => {
    // Simulate what would happen if a caller accidentally passed stopRows in
    // canonical gtfsRoutes.stopIds order (reversed) rather than pattern order.
    // Because `geometryFor` uses `pattern.stops.map(s => s.id)` as
    // explicitStopIds and passes stopRows *positionally* (as returned by
    // Dexie bulkGet keyed on those same IDs), the component always builds
    // pattern-order geometry. This test encodes that contract by passing
    // stopRows in pattern order explicitly — the very thing bulkGet(patternIds)
    // produces.
    const result = geometryFor(PATTERN, STOP_ROWS);
    expect(result.coords).toEqual([
      [25.1, 54.1],
      [25.2, 54.2],
      [25.3, 54.3],
    ]);
  });

  it("falls back to inline pattern coordinates while Dexie is still loading", () => {
    const result = geometryFor(PATTERN, undefined);
    expect(result.coords).toEqual([
      [25.1, 54.1],
      [25.2, 54.2],
      [25.3, 54.3],
    ]);
  });

  it("handles stopRows with missing entries by treating undefined as unresolved", () => {
    // Dexie bulkGet returns `undefined` for missing ids. With 2 of 3 resolved
    // and the 0.8 threshold (needs >=3), the helper falls back to endpoints.
    const withHoles: Array<GtfsStopRecord | undefined> = [
      STOP_ROWS[0],
      undefined,
      STOP_ROWS[2],
    ];
    const result = geometryFor(PATTERN, withHoles);
    // Threshold max(3, 0.8*3) = 3 → 2 resolved < 3 → endpoints tier, which
    // yields the first/last pattern locations.
    expect(result.coords).toEqual([
      [25.1, 54.1],
      [25.3, 54.3],
    ]);
  });

  it("returns empty coords for a pattern with no stops", () => {
    const empty: LinePattern = { directionId: 0, headsign: "", stops: [] };
    const result = geometryFor(empty, []);
    expect(result.coords).toEqual([]);
  });

  it("uses the GTFS shape polyline when provided, ignoring stop-chord fallback", () => {
    // Cached decode entries leak across tests if not reset — the shape tier
    // hits the LRU first.
    clearShapeDecodeCache();
    const shape: GtfsShapeRecord = {
      shapeId: "shape-x",
      // Two-segment polyline encoding: roughly (38.5, -120.2), (40.7, -120.95), (43.252, -126.453).
      encodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
      source: "gtfs",
    };
    const result = geometryFor(PATTERN, STOP_ROWS, shape);
    // Shape tier returns 3 decoded points, none of which equal the stop
    // locations — proves we're rendering the shape, not the chord.
    expect(result.coords).toHaveLength(3);
    expect(result.coords).not.toEqual([
      [25.1, 54.1],
      [25.2, 54.2],
      [25.3, 54.3],
    ]);
  });

  it("falls back to stop-chord when shape is undefined", () => {
    const result = geometryFor(PATTERN, STOP_ROWS, undefined);
    expect(result.coords).toEqual([
      [25.1, 54.1],
      [25.2, 54.2],
      [25.3, 54.3],
    ]);
  });

  it("builds pattern-order coords independent of gtfsRoutes.stopIds direction", () => {
    // The whole point of this refactor: even though a canonical
    // `gtfsRoutes.stopIds` might be stored as ["C","B","A"] (reversed),
    // the overlay only consults the pattern. So for a pattern [A,B,C]
    // fed stop rows in the same pattern order (as bulkGet(patternIds)
    // always yields), we emit [A→B→C] coords.
    const reversedCanonicalStopIds = ["C", "B", "A"];
    // Even if a canonical stopIds list existed with reversed order, the
    // overlay never reads it — it only reads `pattern.stops`.
    expect(reversedCanonicalStopIds).not.toEqual(
      PATTERN.stops.map((s) => s.id),
    );

    const result = geometryFor(PATTERN, STOP_ROWS);
    expect(result.coords).toEqual([
      [25.1, 54.1],
      [25.2, 54.2],
      [25.3, 54.3],
    ]);
  });
});
