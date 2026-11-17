import type {RtRouteUpdate, RtTripUpdate} from "@pt/shared";

/** Same frontend guard as the server's ±1800-second cap. */
export function clampRtDelay(raw: number): number {
  return Number.isFinite(raw) ? Math.min(1800, Math.max(-1800, raw)) : 0;
}
export function stampRtUpdate(update: RtRouteUpdate, nowMs: number, onClamp?: (trip: RtTripUpdate, clamped: number) => void): RtTripUpdate[] {
  return update.trips.map(trip => {
    const delaySeconds = clampRtDelay(trip.delaySeconds);
    if (delaySeconds !== trip.delaySeconds || !Number.isFinite(trip.delaySeconds)) onClamp?.(trip, delaySeconds);
    return {...trip, delaySeconds, receivedAt: nowMs};
  });
}
/** First match in route insertion/trip-array order wins, including duplicates. */
export function indexRtTrips(updates: Map<string, RtTripUpdate[]>): Map<string, RtTripUpdate> {
  const index = new Map<string, RtTripUpdate>();
  for (const trips of updates.values()) for (const trip of trips) if (!index.has(trip.tripId)) index.set(trip.tripId, trip);
  return index;
}
