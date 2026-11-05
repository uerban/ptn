import { useMemo } from "react";
import type { UpcomingStop, ConnectionAtStop, ConnectingDeparture } from "@pt/shared";

interface RaptorIndex {
  getRouteStops: (routeId: string) => string[];
  getStopName: (stopId: string) => string;
  routesAtStop: (stopId: string) => string[];
  getRouteShortName?: (routeId: string) => string;
  getRouteHeadsign?: (routeId: string) => string;
}

interface RtStoreForDashboard {
  getNextDeparture?: (routeId: string, stopId: string) => {
    minutesUntil: number;
    routeShortName: string;
    headsign: string;
    isApproximate?: boolean;
  } | null;
}

/**
 * Resolve upcoming stops from the route's stop sequence,
 * starting from the user's current position index.
 */
export function resolveUpcomingStops(
  routeId: string,
  currentStopIndex: number,
  raptorIndex: Pick<RaptorIndex, "getRouteStops" | "getStopName">
): UpcomingStop[] {
  const stopIds = raptorIndex.getRouteStops(routeId);
  if (!stopIds || stopIds.length === 0) return [];

  // Return stops after the current position
  return stopIds
    .slice(currentStopIndex)
    .map((id) => ({
      id,
      name: raptorIndex.getStopName(id) ?? id,
    }));
}

/**
 * For each upcoming stop, find connecting routes (excluding the current route)
 * and fetch their next departure times.
 */
export function resolveConnectingDepartures(
  upcomingStops: UpcomingStop[],
  currentRouteId: string,
  raptorIndex: Pick<RaptorIndex, "routesAtStop" | "getRouteShortName" | "getRouteHeadsign">,
  rtStore: RtStoreForDashboard
): ConnectionAtStop[] {
  return upcomingStops.map((stop) => {
    const routes = raptorIndex.routesAtStop(stop.id);
    const connectingRoutes = routes.filter((r) => r !== currentRouteId);

    const departures: ConnectingDeparture[] = connectingRoutes
      .map((routeId) => {
        if (rtStore.getNextDeparture) {
          const dep = rtStore.getNextDeparture(routeId, stop.id);
          if (dep) {
            return {
              routeShortName: dep.routeShortName,
              headsign: dep.headsign,
              minutesUntil: dep.minutesUntil,
              ...(dep.isApproximate ? { isApproximate: true } : {}),
            };
          }
        }
        // Fallback: use static data from raptor index
        const shortName = raptorIndex.getRouteShortName?.(routeId) ?? routeId;
        const headsign = raptorIndex.getRouteHeadsign?.(routeId) ?? "";
        return { routeShortName: shortName, headsign, minutesUntil: -1 };
      })
      .filter((d): d is ConnectingDeparture => d !== null && d.minutesUntil >= 0);

    return {
      stopName: stop.name,
      departures,
    };
  });
}

/**
 * Hook that sources data for the RiderDashboard component.
 *
 * @param tripId - The active trip ID
 * @param routeId - The route ID for stop sequence lookup
 * @param userStopIndex - Estimated current stop index along the route
 * @param raptorIndex - RAPTOR index for stop/route lookups
 * @param rtStore - RT store for live departure data
 */
export function useRiderDashboardData(
  tripId: string | null,
  routeId: string | null,
  userStopIndex: number,
  raptorIndex: RaptorIndex | null,
  rtStore: RtStoreForDashboard
): { upcomingStops: UpcomingStop[]; connectingDepartures: ConnectionAtStop[] } {
  const upcomingStops = useMemo(() => {
    if (!routeId || !raptorIndex) return [];
    return resolveUpcomingStops(routeId, userStopIndex, raptorIndex);
  }, [routeId, userStopIndex, raptorIndex]);

  const connectingDepartures = useMemo(() => {
    if (!routeId || !raptorIndex || upcomingStops.length === 0) return [];
    return resolveConnectingDepartures(upcomingStops, routeId, raptorIndex, rtStore);
  }, [upcomingStops, routeId, raptorIndex, rtStore]);

  return { upcomingStops, connectingDepartures };
}
