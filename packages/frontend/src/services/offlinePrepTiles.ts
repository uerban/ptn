/**
 * Enumerate the schedule-tile coords covering a bounding box.
 *
 * The idle prewarm resolves one tile from a lat/lon at the map centre. A
 * deliberate "prepare for offline" run needs the set covering a whole city,
 * and Settings has no map to read a viewport from — so the grid is walked
 * directly off the city bbox.
 *
 * Walking uses each cell's own bounds to find the next cell rather than
 * assuming a fixed degree step, so it stays correct if the tiling scheme
 * changes. `maxCells` is a hard stop: a bad bbox must fail small, not fire
 * thousands of requests.
 */
import {
  scheduleTileCoordAt,
  scheduleCellBounds,
  leafSuffixSet,
} from "@pt/shared";
import type { BundleManifest } from "@pt/shared";

export interface Bbox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/** Enough for a large metro at the current cell size, far below a storm. */
export const DEFAULT_MAX_CELLS = 400;

export function scheduleTileCoordsForBbox(
  bbox: Bbox,
  manifest: BundleManifest,
  opts: { maxCells?: number } = {},
): string[] {
  const maxCells = opts.maxCells ?? DEFAULT_MAX_CELLS;
  const seen = new Set<string>();
  const out: string[] = [];

  let lat = bbox.minLat;
  // Guard against a non-advancing walk (a degenerate cell would otherwise spin).
  let rows = 0;
  while (lat <= bbox.maxLat && out.length < maxCells && rows <= maxCells) {
    rows += 1;
    let lon = bbox.minLon;
    let cols = 0;
    let rowTop = lat;
    while (lon <= bbox.maxLon && out.length < maxCells && cols <= maxCells) {
      cols += 1;
      const { x, y } = scheduleTileCoordAt(lat, lon);
      const cellKey = `${x}_${y}`;
      const cell = scheduleCellBounds(x, y);
      rowTop = Math.max(rowTop, cell.maxLat);

      if (!seen.has(cellKey)) {
        seen.add(cellKey);
        const plan = manifest.subdivisions?.[cellKey];
        if (plan) {
          // A subdivided cell has no tile of its own — only its leaves do.
          for (const suffix of leafSuffixSet(plan)) {
            out.push(`${cellKey}-${suffix}`);
          }
        } else {
          out.push(cellKey);
        }
      }

      const nextLon = cell.maxLon + EPSILON;
      if (nextLon <= lon) break; // no forward progress — bail rather than spin
      lon = nextLon;
    }
    const nextLat = rowTop + EPSILON;
    if (nextLat <= lat) break;
    lat = nextLat;
  }

  return out.slice(0, maxCells);
}

const EPSILON = 1e-9;
