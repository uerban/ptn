import { scheduleTileCoordAt, leafForPoint, type Bbox } from "@pt/shared";

export interface FirstStopLocation {
  lat: number;
  lon: number;
}

/**
 * RT ownership: a trip is owned by exactly the tile/leaf that contains its first stop. 4-arg
 * form: `parsed` is the requested coord split into `{cellKey, suffix}`; `leafSet` is the cell's
 * plan suffixes (`null` ⇒ the cell is NOT subdivided); `cellBounds` is `scheduleCellBounds(x,
 * y)`, hoisted once per request. - wrong cell ⇒ false; - unsubdivided (leafSet null) ⇒ owns the
 * bare cell iff `suffix === ""`; - subdivided ⇒ owns iff `leafForPoint(cellBounds, lat, lon,
 * leafSet) === suffix` (a `null` walk ⇒ false; the trip drops, geometry-drift guard).
 */
export function isOwningTile(
  firstStop: FirstStopLocation,
  parsed: { cellKey: string; suffix: string },
  leafSet: ReadonlySet<string> | null,
  cellBounds: Bbox,
): boolean {
  const { x, y } = scheduleTileCoordAt(firstStop.lat, firstStop.lon);
  if (`${x}_${y}` !== parsed.cellKey) return false;
  if (leafSet === null) return parsed.suffix === "";
  return leafForPoint(cellBounds, firstStop.lat, firstStop.lon, leafSet) === parsed.suffix;
}
