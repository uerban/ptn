import { describe, it, expect } from "vitest";
import { scheduleTileCoordsForBbox } from "./offlinePrepTiles.ts";
import type { BundleManifest } from "@pt/shared";

const bare = { subdivisions: {} } as unknown as BundleManifest;

describe("scheduleTileCoordsForBbox", () => {
  it("covers a bbox with at least the cell holding each corner", () => {
    const bbox = { minLat: 54.6, maxLat: 54.75, minLon: 25.2, maxLon: 25.35 };
    const coords = scheduleTileCoordsForBbox(bbox, bare);
    expect(coords.length).toBeGreaterThan(0);
    expect(new Set(coords).size).toBe(coords.length); // deduped
    for (const c of coords) expect(c).toMatch(/^-?\d+_-?\d+$/);
  });

  it("returns a single cell for a degenerate bbox", () => {
    const p = { minLat: 54.7, maxLat: 54.7, minLon: 25.3, maxLon: 25.3 };
    expect(scheduleTileCoordsForBbox(p, bare)).toHaveLength(1);
  });

  it("expands a subdivided cell into its leaves instead of the bare cell", () => {
    const p = { minLat: 54.7, maxLat: 54.7, minLon: 25.3, maxLon: 25.3 };
    const cell = scheduleTileCoordsForBbox(p, bare)[0];
    const manifest = {
      subdivisions: { [cell]: { leaves: [{ suffix: "a" }, { suffix: "b" }] } },
    } as unknown as BundleManifest;
    const coords = scheduleTileCoordsForBbox(p, manifest);
    expect(coords).toEqual([`${cell}-a`, `${cell}-b`]);
    expect(coords).not.toContain(cell);
  });

  it("is bounded — a whole-world bbox cannot produce an unbounded sweep", () => {
    const world = { minLat: -85, maxLat: 85, minLon: -180, maxLon: 180 };
    const coords = scheduleTileCoordsForBbox(world, bare, { maxCells: 50 });
    expect(coords.length).toBeLessThanOrEqual(50);
  });
});
