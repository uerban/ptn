import { useEffect } from "react";
import type { Itinerary } from "@pt/shared";
import { useRtStore, useTripDelay } from "../stores/rtStore.ts";

/**
 * What live RT says about the itinerary's first ride:
 *   - shiftSeconds: how far it moves the ride from the time the plan already
 *     carries — the live delay minus the delay the overlay folded in at plan
 *     time (`Leg.appliedDelaySeconds`). Negative: running early.
 *   - cancelled: the trip is not running.
 *   - removed: the trip is DELETED — gone, and not to be shown as cancelled.
 * All neutral without live data for the trip.
 */
export function useFirstRideLive(itinerary: Itinerary | null): {
  shiftSeconds: number;
  cancelled: boolean;
  removed: boolean;
} {
  const firstRide = itinerary?.legs.find((l) => l.mode !== "WALK");
  const live = useTripDelay(firstRide?.tripId);
  return {
    shiftSeconds: live ? live.delaySeconds - (firstRide?.appliedDelaySeconds ?? 0) : 0,
    cancelled: live?.cancelled === true,
    removed: live?.deleted === true,
  };
}

/**
 * Hold live data for these routes while the caller is mounted — a counted
 * hold (see `rtStore.retainRoutes`), so letting go never cuts off guidance or
 * another surface on the same route.
 */
export function useRetainRoutes(routeIds: readonly string[]): void {
  const key = [...new Set(routeIds)].sort().join("|");
  useEffect(() => {
    if (!key) return;
    return useRtStore.getState().retainRoutes(key.split("|"));
  }, [key]);
}
