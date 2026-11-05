import { useMemo } from "react";
import type { LatLon, LegGeometryResult } from "@pt/shared";
import { buildWalkGeometry } from "../services/legGeometry/buildWalkGeometry.ts";
import type { WalkRouteSource } from "../services/walkRouteCache.ts";
import { useWalkRoute } from "./useWalkRoute.ts";

/** Walk leg geometry, the same object (and `coords` array) from render to
 *  render until the route or an endpoint changes: `buildWalkGeometry` copies
 *  the coordinates, and `WalkLegLayer` re-sends map data when they change. */
export function useWalkLegGeometry(
  fromLocation: LatLon,
  toLocation: LatLon,
  source?: WalkRouteSource,
): LegGeometryResult {
  const { route, pending } = useWalkRoute(fromLocation, toLocation, source);
  const { lat: fromLat, lon: fromLon } = fromLocation;
  const { lat: toLat, lon: toLon } = toLocation;
  const routeCoords = route?.coords;
  return useMemo(
    () => ({
      ...buildWalkGeometry({
        fromLocation: { lat: fromLat, lon: fromLon },
        toLocation: { lat: toLat, lon: toLon },
        routeCoords,
      }),
      pending,
    }),
    [fromLat, fromLon, toLat, toLon, routeCoords, pending],
  );
}
