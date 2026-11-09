import { useMemo } from "react";
import type { Alert, Departure, Itinerary, Leg } from "@pt/shared";
import {
  isAlertActiveAt,
  isAlertActiveDuring,
  matchAlert,
  selectAlerts,
  type AlertTarget,
} from "../services/serviceAlertSelection.ts";
import {
  useServiceAlerts,
  type ServiceAlertsSnapshot,
} from "../services/serviceAlertsClient.ts";
import { tripDirectionId } from "../services/nearbyDirections.ts";
import type { RaptorIndex } from "../services/raptorIndex.ts";
import { useGtfsDataStore } from "../stores/gtfsDataStore.ts";

const NO_ALERTS: readonly Alert[] = Object.freeze([]);

/** The parts of the loaded timetable that describe routes and trips. */
export type AlertTargetIndex = Pick<RaptorIndex, "patterns" | "routes" | "routeIdToIdx">;

/**
 * A trip (or route) as an alert target, with what the timetable says about
 * it: its agency, GTFS route type and direction. Alerts can name any of
 * these, so a target without them misses agency-wide, mode-wide and
 * direction-specific alerts.
 */
export function serviceTarget(
  index: AlertTargetIndex | null | undefined,
  ids: { routeId?: string; tripId?: string; stopId?: string },
): AlertTarget {
  const target: AlertTarget = {};
  if (ids.routeId) target.routeId = ids.routeId;
  if (ids.tripId) target.tripId = ids.tripId;
  if (ids.stopId) target.stopId = ids.stopId;
  if (!index || !ids.routeId) return target;
  const routeIdx = index.routeIdToIdx.get(ids.routeId);
  const route = routeIdx === undefined ? undefined : index.routes[routeIdx];
  if (route?.agencyId) target.agencyId = route.agencyId;
  if (route?.routeType !== undefined) target.routeType = route.routeType;
  if (ids.tripId) {
    const directionId = tripDirectionId(index, ids.routeId, ids.tripId);
    if (directionId !== undefined) target.directionId = directionId;
  }
  return target;
}

/** What a stop's departure list shows: the stop, and each departure there. */
export function stopTargets(
  stopId: string,
  departures: readonly Pick<Departure, "routeId" | "tripId">[],
  index?: AlertTargetIndex | null,
): AlertTarget[] {
  const targets: AlertTarget[] = [{ stopId }];
  const seen = new Set<string>();
  for (const { routeId, tripId } of departures) {
    const key = `${routeId}\u0000${tripId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(serviceTarget(index, { stopId, routeId, tripId }));
  }
  return targets;
}

/** A transit leg as alert targets: its trip at its boarding and alighting stops. */
export function legTargets(leg: Leg, index?: AlertTargetIndex | null): AlertTarget[] {
  if (!leg.routeId && !leg.tripId) return [];
  const ids = { routeId: leg.routeId, tripId: leg.tripId };
  const targets: AlertTarget[] = [];
  for (const stopId of [leg.from.stopId, leg.to.stopId]) {
    if (stopId) targets.push(serviceTarget(index, { ...ids, stopId }));
  }
  return targets.length > 0 ? targets : [serviceTarget(index, ids)];
}

/**
 * Alerts concerning each leg of `itinerary` while that leg runs (direct
 * matches only: a partial match may be about another direction or stop).
 * Indexed like `itinerary.legs`; walking legs get none.
 */
export function alertsByLeg(
  alerts: readonly Alert[],
  itinerary: Pick<Itinerary, "legs">,
  index?: AlertTargetIndex | null,
): (readonly Alert[])[] {
  return itinerary.legs.map((leg) => {
    const targets = legTargets(leg, index);
    if (targets.length === 0) return NO_ALERTS;
    const from = Date.parse(leg.departureTime);
    const to = Date.parse(leg.arrivalTime);
    const during = Number.isFinite(from) && Number.isFinite(to);
    const found = alerts.filter(
      (alert) =>
        (!during || isAlertActiveDuring(alert, from, Math.max(to, from + 1))) &&
        targets.some((target) => matchAlert(alert, target) === "direct"),
    );
    return found.length > 0 ? found : NO_ALERTS;
  });
}

export interface ServiceAlertSelection {
  snapshot: ServiceAlertsSnapshot;
  alerts: readonly Alert[];
}

/**
 * The city's alerts concerning `targets` and active now (or at any time,
 * with `activeNow: false`). `targets` should be
 * memoized by the caller. `visible = false` stops this surface counting
 * towards polling.
 */
export function useServiceAlertSelection(
  cityId: string | undefined,
  targets: readonly AlertTarget[],
  options: { includePartial?: boolean; visible?: boolean; activeNow?: boolean } = {},
): ServiceAlertSelection {
  const { includePartial = false, visible = true, activeNow = true } = options;
  const snapshot = useServiceAlerts(cityId, visible);
  const response = snapshot.response;
  const checkedAt = snapshot.checkedAt;
  const alerts = useMemo(() => {
    if (!response || targets.length === 0) return NO_ALERTS;
    // Re-evaluated on every check (`checkedAt`), so alerts that ended drop out.
    void checkedAt;
    const found = selectAlerts(response.alerts, targets, {
      includePartial,
      activeAt: activeNow ? Date.now() : undefined,
    });
    return found.length > 0 ? found : NO_ALERTS;
  }, [response, checkedAt, targets, includePartial, activeNow]);
  return { snapshot, alerts };
}

/** Route ids (at a stop) with an active alert, for small indicators. */
export function useAlertedDepartures(
  cityId: string | undefined,
  visible: boolean,
): ((departure: Pick<Departure, "routeId" | "tripId">, stopId: string) => boolean) | null {
  const snapshot = useServiceAlerts(cityId, visible);
  const response = snapshot.response;
  const checkedAt = snapshot.checkedAt;
  const index = useGtfsDataStore((s) => s.raptorIndex);
  return useMemo(() => {
    if (!response || response.alerts.length === 0) return null;
    void checkedAt;
    const now = Date.now();
    const active = response.alerts.filter((alert) => isAlertActiveAt(alert, now));
    if (active.length === 0) return null;
    const cache = new Map<string, boolean>();
    return (departure, stopId) => {
      const key = `${departure.routeId}\u0000${departure.tripId}\u0000${stopId}`;
      let hit = cache.get(key);
      if (hit === undefined) {
        const target = serviceTarget(index, {
          routeId: departure.routeId,
          tripId: departure.tripId,
          stopId,
        });
        hit = active.some((alert) => matchAlert(alert, target) === "direct");
        cache.set(key, hit);
      }
      return hit;
    };
  }, [response, checkedAt, index]);
}

/**
 * Per-leg alerts for the guided trip, indexed like `itinerary.legs`.
 * `active = false` (no trip) stops counting towards polling.
 */
export function useTripServiceAlerts(
  cityId: string | undefined,
  itinerary: Pick<Itinerary, "legs"> | null,
): (readonly Alert[])[] {
  const snapshot = useServiceAlerts(cityId, itinerary !== null);
  const response = snapshot.response;
  const index = useGtfsDataStore((s) => s.raptorIndex);
  return useMemo(
    () => (response && itinerary ? alertsByLeg(response.alerts, itinerary, index) : []),
    [response, itinerary, index],
  );
}
