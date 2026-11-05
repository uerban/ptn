import { useMemo } from "react";
import type { Itinerary, Leg } from "@pt/shared";
import type { ItineraryDisplay } from "../components/RouteResults/shared/itineraryDisplay.ts";
import { useGtfsDataStore } from "../stores/gtfsDataStore.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { useRtStore } from "../stores/rtStore.ts";
import { makeGetNextDeparture } from "../services/nextDeparture.ts";

/**
 * A departure within this of the missed one is the same bus seen twice
 * (minute rounding, a duplicated trip) — look past it.
 */
const PAST_THE_MISSED_MS = 60_000;

/**
 * When the same line next leaves the ride's boarding stop after `afterMs` —
 * what a rider about to miss this bus can take instead. Read from the local
 * timetable, with a live delay applied where one is fresh. null when not
 * asked (`afterMs` null), or without a route, a boarding stop id, a loaded
 * timetable, or a later departure that service day.
 */
export function useNextDepartureAfter(ride: Leg | undefined, afterMs: number | null): number | null {
  const raptorIndex = useGtfsDataStore((s) => s.raptorIndex);
  const feedTz = useCityStore((s) => s.activeCity.tz);
  // The lookup applies live delays, so an RT patch can move the answer.
  const rtUpdates = useRtStore((s) => s.updates);
  const routeId = ride?.routeId;
  const stopId = ride?.from.stopId;

  return useMemo(() => {
    if (!raptorIndex || !routeId || !stopId || afterMs === null) return null;
    const { getTripDelay, getReceivedAt } = useRtStore.getState();
    const lookup = makeGetNextDeparture(
      raptorIndex,
      { getTripDelay, getReceivedAt },
      () => afterMs + PAST_THE_MISSED_MS,
      feedTz,
    );
    return lookup(routeId, stopId)?.departureMs ?? null;
    // rtUpdates: the store's getters read it — re-run when it changes.
  }, [raptorIndex, routeId, stopId, afterMs, feedTz, rtUpdates]);
}

/**
 * Minutes from `nowMs` until the same line next leaves the first ride's stop,
 * when `display` says this departure is a likely miss, cancelled or removed;
 * null otherwise.
 */
export function useNextDepartureInMin(
  itinerary: Itinerary | null,
  display: ItineraryDisplay | null,
  nowMs: number,
): number | null {
  const firstRide = itinerary?.legs.find((l) => l.mode !== "WALK");
  const nextMs = useNextDepartureAfter(
    firstRide,
    display?.catchStatus === "likely-miss" ||
      display?.catchStatus === "cancelled" ||
      display?.catchStatus === "removed"
      ? display.firstTransitDepartureMs
      : null,
  );
  return nextMs === null ? null : Math.max(0, Math.ceil((nextMs - nowMs) / 60_000));
}
