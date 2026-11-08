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

const NO_ALERTS: readonly Alert[] = Object.freeze([]);

/** What a stop's departure list shows: the stop, and each departure there. */
export function stopTargets(
  stopId: string,
  departures: readonly Pick<Departure, "routeId" | "tripId">[],
): AlertTarget[] {
  const targets: AlertTarget[] = [{ stopId }];
  const seen = new Set<string>();
  for (const { routeId, tripId } of departures) {
    const key = `${routeId}\u0000${tripId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ stopId, routeId, tripId });
  }
  return targets;
}

/** A transit leg as alert targets: its trip at its boarding and alighting stops. */
export function legTargets(leg: Leg): AlertTarget[] {
  if (!leg.routeId && !leg.tripId) return [];
  const base: AlertTarget = { routeId: leg.routeId, tripId: leg.tripId };
  const targets: AlertTarget[] = [];
  for (const stopId of [leg.from.stopId, leg.to.stopId]) {
    if (stopId) targets.push({ ...base, stopId });
  }
  return targets.length > 0 ? targets : [base];
}

/**
 * Alerts concerning each leg of `itinerary` while that leg runs (direct
 * matches only: a partial match may be about another direction or stop).
 * Indexed like `itinerary.legs`; walking legs get none.
 */
export function alertsByLeg(
  alerts: readonly Alert[],
  itinerary: Pick<Itinerary, "legs">,
): (readonly Alert[])[] {
  return itinerary.legs.map((leg) => {
    const targets = legTargets(leg);
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
        const target: AlertTarget = {
          routeId: departure.routeId,
          tripId: departure.tripId,
          stopId,
        };
        hit = active.some((alert) => matchAlert(alert, target) === "direct");
        cache.set(key, hit);
      }
      return hit;
    };
  }, [response, checkedAt]);
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
  return useMemo(
    () => (response && itinerary ? alertsByLeg(response.alerts, itinerary) : []),
    [response, itinerary],
  );
}
