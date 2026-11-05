import type { LatLon, LegGeometryResult, LonLat } from "@pt/shared";

export interface BuildWalkGeometryInput {
  fromLocation: LatLon;
  toLocation: LatLon;
  /** Walk-graph path, [lon, lat]; absent → straight line between endpoints. */
  routeCoords?: readonly LonLat[];
}

export function buildWalkGeometry(input: BuildWalkGeometryInput): LegGeometryResult {
  if (input.routeCoords && input.routeCoords.length >= 2) {
    return { coords: [...input.routeCoords], source: "walk-graph", partial: false, pending: false };
  }
  return {
    coords: [
      [input.fromLocation.lon, input.fromLocation.lat] as LonLat,
      [input.toLocation.lon, input.toLocation.lat] as LonLat,
    ],
    source: "endpoints", partial: false, pending: false,
  };
}
