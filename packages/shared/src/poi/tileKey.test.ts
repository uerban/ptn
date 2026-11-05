import { describe, expect, it } from "vitest";

import { TILE_EDGE_KM, TILE_OVERLAP_RATIO } from "./tileParams.js";
import {
  GLOBAL_ANCHOR,
  TILE_SIZE_LABEL,
  tileCoordAt,
  tileKeyAt,
  tilesForViewport,
  scheduleTileCoordAt,
  scheduleCellBounds,
  bisectQuadrant,
  quadrantDigitForPoint,
  leafSuffixForPoint,
  TILE_COORD_RE,
  parseTileCoords,
  leafForPoint,
  leafSuffixSet,
  type TileAnchor,
} from "./tileKey.js";

const KM_PER_DEG_LAT = 111.32;
const STEP_LAT_DEG = TILE_EDGE_KM / KM_PER_DEG_LAT;

function parseTileKey(key: string): { cityId: string; size: string; x: number; y: number } {
  const [cityId, size, xy] = key.split("/");
  const [xs, ys] = xy.split("_");
  return { cityId, size, x: parseInt(xs, 10), y: parseInt(ys, 10) };
}

describe("tileKeyAt", () => {
  it("returns key of form {cityId}/{tileSize}/{x}_{y}", () => {
    const key = tileKeyAt("gdansk", 54.35, 18.65);
    expect(key).toMatch(/^gdansk\/\d+km\/-?\d+_-?\d+$/);
  });

  it("uses TILE_SIZE_LABEL as the size segment", () => {
    const key = tileKeyAt("gdansk", 54.35, 18.65);
    expect(key.split("/")[1]).toBe(TILE_SIZE_LABEL);
    expect(TILE_SIZE_LABEL).toBe(`${TILE_EDGE_KM}km`);
  });

  it("is deterministic: same lat/lon → same key", () => {
    const a = tileKeyAt("gdansk", 54.351, 18.648);
    const b = tileKeyAt("gdansk", 54.351, 18.648);
    expect(a).toBe(b);
  });

  it("different cities produce different keys at the same coord", () => {
    const a = tileKeyAt("gdansk", 54.35, 18.65);
    const b = tileKeyAt("gdynia", 54.35, 18.65);
    expect(a).not.toBe(b);
    expect(parseTileKey(a).x).toBe(parseTileKey(b).x);
    expect(parseTileKey(a).y).toBe(parseTileKey(b).y);
  });

  it("nearby points map to the same tile", () => {
    const a = tileCoordAt(54.35, 18.65);
    const b = tileCoordAt(54.35001, 18.65001);
    expect(a).toEqual(b);
  });

  it("points ~15km apart in latitude map to different y rows", () => {
    const deltaDeg = (15 / KM_PER_DEG_LAT) + STEP_LAT_DEG;
    const a = tileCoordAt(54.2, 18.65);
    const b = tileCoordAt(54.2 + deltaDeg, 18.65);
    expect(a.y).not.toBe(b.y);
  });

  it("negative coordinates produce negative indices", () => {
    const { x, y } = tileCoordAt(-0.01, -0.01);
    expect(y).toBeLessThan(0);
    expect(x).toBeLessThan(0);
  });
});

describe("tilesForViewport", () => {
  it("includes the tile containing a point-sized bbox", () => {
    const lat = 54.35;
    const lon = 18.65;
    const keys = tilesForViewport("gdansk", {
      minLat: lat,
      maxLat: lat,
      minLon: lon,
      maxLon: lon,
    });
    expect(keys).toContain(tileKeyAt("gdansk", lat, lon));
  });

  it("returns multiple tiles for a viewport spanning several cells", () => {
    const keys = tilesForViewport("gdansk", {
      minLat: 54.2,
      maxLat: 54.6,
      minLon: 18.2,
      maxLon: 18.9,
    });
    expect(keys.length).toBeGreaterThan(4);
  });

  it("is deterministic", () => {
    const bbox = { minLat: 54.2, maxLat: 54.6, minLon: 18.2, maxLon: 18.9 };
    const a = tilesForViewport("gdansk", bbox);
    const b = tilesForViewport("gdansk", bbox);
    expect(a).toEqual(b);
  });

  it("returns unique keys", () => {
    const keys = tilesForViewport("gdansk", {
      minLat: 54.2,
      maxLat: 54.6,
      minLon: 18.2,
      maxLon: 18.9,
    });
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns tiles from both sides of a cell boundary when point is within overlap halo", () => {
    const step = STEP_LAT_DEG;
    const overlapExtentDeg =
      (TILE_EDGE_KM * TILE_OVERLAP_RATIO) / (2 * KM_PER_DEG_LAT);
    const pLat = step - overlapExtentDeg / 2;
    const pLon = 0;

    const keys = tilesForViewport("city", {
      minLat: pLat,
      maxLat: pLat,
      minLon: pLon,
      maxLon: pLon,
    });
    const ys = new Set(keys.map((k) => parseTileKey(k).y));
    expect(ys.has(0)).toBe(true);
    expect(ys.has(1)).toBe(true);
  });

  it("bbox far outside the city's usual latitude still yields a covering set", () => {
    const keys = tilesForViewport("gdansk", {
      minLat: 0,
      maxLat: 0,
      minLon: 0,
      maxLon: 0,
    });
    expect(keys.length).toBeGreaterThanOrEqual(1);
  });
});

describe("city-anchored grid", () => {
  const anchor: TileAnchor = { minLat: 54.28, minLon: 18.4, refLat: 54.365 };
  const stepLat = TILE_EDGE_KM / 111.32; // ≈0.10780°

  it("indexes the bbox corner as 0_0", () => {
    expect(tileCoordAt(54.28, 18.4, 24, anchor)).toEqual({ x: 0, y: 0 });
  });

  it("is origin-relative on latitude (one 24km step north → y=1, x=0)", () => {
    const step24 = 24 / 111.32; // ≈0.2156°
    expect(tileCoordAt(54.28 + step24 + 1e-6, 18.4, 24, anchor)).toEqual({ x: 0, y: 1 });
  });

  it("emits the pinned key grammar with the per-city edge", () => {
    expect(tileKeyAt("gdansk", 54.28, 18.4, 24, anchor)).toBe("gdansk/24km/0_0");
  });

  it("global default is byte-identical to the legacy no-arg call (5 coords)", () => {
    for (const [lat, lon] of [
      [54.35, 18.65], [54.28, 18.4], [0.001, 0.001], [54.62, 18.62], [25.0, 25.4],
    ] as const) {
      expect(tileCoordAt(lat, lon)).toEqual(tileCoordAt(lat, lon, TILE_EDGE_KM, GLOBAL_ANCHOR));
      expect(tileKeyAt("c", lat, lon)).toBe(tileKeyAt("c", lat, lon, TILE_EDGE_KM, GLOBAL_ANCHOR));
    }
    expect(tileKeyAt("gdansk", 54.35, 18.65)).toMatch(/^gdansk\/12km\/-?\d+_-?\d+$/);
  });

  it("tilesForViewport over the anchor corner only → exactly one tile 0_0", () => {
    const keys = tilesForViewport(
      "gdansk",
      { minLat: 54.28, minLon: 18.4, maxLat: 54.281, maxLon: 18.401 },
      24,
      anchor,
    );
    expect(keys).toContain("gdansk/24km/0_0");
    // overlap may add neighbors, but a tiny corner viewport must not span far:
    expect(keys.every((k) => /\/24km\/-?[01]_-?[01]$/.test(k))).toBe(true);
  });
});

describe("scheduleCellBounds + quadrant primitive", () => {
  it("scheduleCellBounds is the exact inverse of scheduleTileCoordAt (round-trip via cell midpoint)", () => {
    for (const [lat, lon] of [
      [48.8566, 2.3522],   // Paris core (≈ the 28_906 cell region)
      [54.6892, 25.2798],  // Vilnius
      [50.0647, 19.945],   // Krakow
      [0.001, 0.001],
      [-12.5, -77.0],      // southern/western
    ] as const) {
      const { x, y } = scheduleTileCoordAt(lat, lon);
      const b = scheduleCellBounds(x, y);
      const midLat = (b.minLat + b.maxLat) / 2;
      const midLon = (b.minLon + b.maxLon) / 2;
      expect(scheduleTileCoordAt(midLat, midLon)).toEqual({ x, y });
      // the original point lies inside its cell bounds
      expect(lat).toBeGreaterThanOrEqual(b.minLat);
      expect(lat).toBeLessThan(b.maxLat);
      expect(lon).toBeGreaterThanOrEqual(b.minLon);
      expect(lon).toBeLessThan(b.maxLon);
    }
  });

  it("bisectQuadrant splits a parent bbox into four exact non-overlapping halves", () => {
    const parent = scheduleCellBounds(906, 28); // {x:906, y:28}
    const midLat = (parent.minLat + parent.maxLat) / 2;
    const midLon = (parent.minLon + parent.maxLon) / 2;
    expect(bisectQuadrant(parent, 0)).toEqual({ minLat: parent.minLat, maxLat: midLat, minLon: parent.minLon, maxLon: midLon }); // SW
    expect(bisectQuadrant(parent, 1)).toEqual({ minLat: parent.minLat, maxLat: midLat, minLon: midLon, maxLon: parent.maxLon }); // SE
    expect(bisectQuadrant(parent, 2)).toEqual({ minLat: midLat, maxLat: parent.maxLat, minLon: parent.minLon, maxLon: midLon }); // NW
    expect(bisectQuadrant(parent, 3)).toEqual({ minLat: midLat, maxLat: parent.maxLat, minLon: midLon, maxLon: parent.maxLon }); // NE
  });

  it("quadrantDigitForPoint tie-break is half-open upper-closed (a point on a split plane goes to the upper child)", () => {
    const parent = scheduleCellBounds(906, 28);
    const midLat = (parent.minLat + parent.maxLat) / 2;
    const midLon = (parent.minLon + parent.maxLon) / 2;
    // exactly on both planes -> north && east -> digit 3 (NE)
    expect(quadrantDigitForPoint(parent, midLat, midLon)).toBe(3);
    // just-below both planes -> SW (0)
    expect(quadrantDigitForPoint(parent, midLat - 1e-9, midLon - 1e-9)).toBe(0);
    // on lat plane, below lon plane -> north && !east -> NW (2)
    expect(quadrantDigitForPoint(parent, midLat, midLon - 1e-9)).toBe(2);
    // below lat plane, on lon plane -> !north && east -> SE (1)
    expect(quadrantDigitForPoint(parent, midLat - 1e-9, midLon)).toBe(1);
  });

  it("leafSuffixForPoint composes per-depth digits and is deterministic", () => {
    const cell = scheduleCellBounds(906, 28);
    const lat = (cell.minLat + cell.maxLat) / 2 + 1e-6; // north half
    const lon = (cell.minLon + cell.maxLon) / 2 + 1e-6; // east half -> first digit 3
    const s = leafSuffixForPoint(cell, lat, lon, 2);
    expect(s).toMatch(/^3-[0-3]$/);
    expect(leafSuffixForPoint(cell, lat, lon, 2)).toBe(s);
    expect(leafSuffixForPoint(cell, lat, lon, 0)).toBe(""); // depth 0 -> no suffix
  });
});

describe("parseTileCoords / TILE_COORD_RE / leafForPoint / leafSuffixSet", () => {
  it("parseTileCoords returns cellKey and empty suffix for bare cell", () => {
    expect(parseTileCoords("28_906")).toEqual({ cellKey: "28_906", suffix: "" });
  });

  it("parseTileCoords returns cellKey and suffix for a leaf coord", () => {
    expect(parseTileCoords("2329_-629-0-3")).toEqual({ cellKey: "2329_-629", suffix: "0-3" });
  });

  it("parseTileCoords handles negative x and y with 4-digit suffix", () => {
    expect(parseTileCoords("-893_-642-0-1-2-3")).toEqual({
      cellKey: "-893_-642",
      suffix: "0-1-2-3",
    });
  });

  it("parseTileCoords returns null when depth exceeds MAX_SUBDIVISION_DEPTH (5 digits)", () => {
    expect(parseTileCoords("28_906-0-1-2-3-0")).toBeNull();
  });

  it("parseTileCoords returns null when a digit is out of range (> 3)", () => {
    expect(parseTileCoords("28_906-4")).toBeNull();
  });

  it("parseTileCoords returns null on trailing dash", () => {
    expect(parseTileCoords("28_906-")).toBeNull();
  });

  it("TILE_COORD_RE accepts valid coords and rejects over-depth coords", () => {
    expect(TILE_COORD_RE.test("-893_-642-0-1-2-3")).toBe(true);
    expect(TILE_COORD_RE.test("28_906-0-1-2-3-0")).toBe(false);
  });

  it("leafSuffixSet returns a Set of the leaf suffixes from a plan", () => {
    const bbox = scheduleCellBounds(0, 0);
    const plan = {
      leaves: [
        { suffix: "0", bbox, compressedBytes: 1, oversized: false },
        { suffix: "3-1", bbox, compressedBytes: 1, oversized: false },
      ],
    };
    expect(leafSuffixSet(plan)).toEqual(new Set(["0", "3-1"]));
  });

  it("leafForPoint resolves to the matching leaf suffix for a point in the NE quadrant", () => {
    // cell (28, 906): x=28, y=906
    const cb = scheduleCellBounds(28, 906);
    // Pick the midpoint of the NE quadrant (digit 3) to guarantee membership
    const neQuadrant = bisectQuadrant(cb, 3);
    const lat = (neQuadrant.minLat + neQuadrant.maxLat) / 2;
    const lon = (neQuadrant.minLon + neQuadrant.maxLon) / 2;
    // Verify the point lands in quadrant 3 of the cell
    expect(quadrantDigitForPoint(cb, lat, lon)).toBe(3);
    // With only leaf "3" present, resolves immediately at depth 1
    expect(leafForPoint(cb, lat, lon, new Set(["3"]))).toBe("3");
  });

  it("leafForPoint returns null when no leaf matches the point's quadrant path", () => {
    const cb = scheduleCellBounds(28, 906);
    // NE-quadrant midpoint; leafSuffixes only contains "0" (SW leaf)
    const neQuadrant = bisectQuadrant(cb, 3);
    const lat = (neQuadrant.minLat + neQuadrant.maxLat) / 2;
    const lon = (neQuadrant.minLon + neQuadrant.maxLon) / 2;
    expect(leafForPoint(cb, lat, lon, new Set(["0"]))).toBeNull();
  });

  it("leafForPoint returns null for an empty leafSuffixes set", () => {
    const cb = scheduleCellBounds(28, 906);
    const lat = (cb.minLat + cb.maxLat) / 2;
    const lon = (cb.minLon + cb.maxLon) / 2;
    expect(leafForPoint(cb, lat, lon, new Set())).toBeNull();
  });
});
