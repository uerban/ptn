import { scheduleTileCoordAt } from "@pt/shared";
import type { CanonicalStore } from "./canonical/CanonicalStore.js";
import type { GtfsStop } from "./parser.js";

/**
 * Bucket every stop in `canonical` by its tile-cell coordinates.
 *
 * Iteration order within each cell is preserved (stable, in `iterStops` order)
 * so downstream tile generation produces deterministic output for the same
 * canonical store. Callers that re-order may break bundle-hash determinism
 * for downstream encoders that hash structural fingerprints.
 */
export function groupStopsByCell(canonical: CanonicalStore): Map<string, GtfsStop[]> {
  const cells = new Map<string, GtfsStop[]>();
  canonical.iterStops((_id, stop) => {
    const { x, y } = scheduleTileCoordAt(stop.lat, stop.lon);
    const key = `${x}_${y}`;
    let bucket = cells.get(key);
    if (!bucket) {
      bucket = [];
      cells.set(key, bucket);
    }
    bucket.push(stop);
  });
  return cells;
}
