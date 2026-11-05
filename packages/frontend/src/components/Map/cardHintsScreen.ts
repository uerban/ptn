// ── Geographic hint → live screen-space projection ──────────────────────────
//
// `deriveStopHints` produces a curb direction in a local geographic frame
// (`+x` east, `+y` north). Card placement consumes a screen-space vector. The
// map can have bearing and pitch, so a component-wise north-up y-flip is not
// sufficient: project the stop and a nearby displaced point through the map's
// current transform and normalize their pixel delta.

import type { LatLon } from "@pt/shared";
import type { Vec2 } from "./cardBearing.ts";

const EARTH_RADIUS_M = 6_371_000;
const RAD_TO_DEG = 180 / Math.PI;
const PROJECTION_STEP_M = 10;

export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Project a geographic curb direction through the live map transform.
 *
 * The callback keeps this helper independent of MapLibre and easy to test with
 * rotated/pitched affine projections. Returns `null` for absent, degenerate,
 * or projection-degenerate hints.
 */
export function projectGeoSideToScreen(
  origin: LatLon,
  side: Vec2 | null,
  project: (point: LatLon) => ScreenPoint,
): { dx: number; dy: number } | null {
  if (!side) return null;
  const sideLength = Math.hypot(side.x, side.y);
  if (sideLength === 0 || !Number.isFinite(sideLength)) return null;

  const northM = (side.y / sideLength) * PROJECTION_STEP_M;
  const eastM = (side.x / sideLength) * PROJECTION_STEP_M;
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  if (Math.abs(cosLat) < 1e-9) return null;

  const displaced: LatLon = {
    lat: origin.lat + (northM / EARTH_RADIUS_M) * RAD_TO_DEG,
    lon: origin.lon + (eastM / (EARTH_RADIUS_M * cosLat)) * RAD_TO_DEG,
  };
  const a = project(origin);
  const b = project(displaced);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const screenLength = Math.hypot(dx, dy);
  if (screenLength === 0 || !Number.isFinite(screenLength)) return null;
  return { dx: dx / screenLength + 0, dy: dy / screenLength + 0 };
}
