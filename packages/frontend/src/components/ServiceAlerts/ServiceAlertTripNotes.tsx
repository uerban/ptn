import { useMemo } from "react";
import type { Alert, Itinerary } from "@pt/shared";
import { usePresentationText } from "../../i18n/presentationStrings.ts";
import {
  alertsByLeg,
  type AlertTargetIndex,
} from "../../hooks/useServiceAlertSelection.ts";
import { useServiceAlerts } from "../../services/serviceAlertsClient.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useGtfsDataStore } from "../../stores/gtfsDataStore.ts";
import { ServiceAlertItem } from "./ServiceAlertItem.tsx";

interface LegAlert {
  alert: Alert;
  /** Line names of the affected legs, in leg order. */
  lines: string[];
}

/** Each alert once, with the lines of the legs it concerns. */
export function itineraryAlerts(
  alerts: readonly Alert[],
  itinerary: Pick<Itinerary, "legs">,
  index?: AlertTargetIndex | null,
): LegAlert[] {
  const byId = new Map<string, LegAlert>();
  alertsByLeg(alerts, itinerary, index).forEach((legAlerts, i) => {
    const line = itinerary.legs[i]?.routeShortName ?? "";
    for (const alert of legAlerts) {
      let entry = byId.get(alert.id);
      if (!entry) {
        entry = { alert, lines: [] };
        byId.set(alert.id, entry);
      }
      if (line && !entry.lines.includes(line)) entry.lines.push(line);
    }
  });
  return [...byId.values()];
}

/**
 * The alerts concerning one route result, under its card: one entry per
 * alert, naming the affected lines. Active periods are compared with when
 * each leg runs, not with now.
 */
export function ServiceAlertTripNotes({ itinerary }: { itinerary: Itinerary }) {
  const text = usePresentationText();
  const cityId = useCityStore((s) => s.activeCity.id);
  const snapshot = useServiceAlerts(cityId, true);
  const response = snapshot.response;
  const index = useGtfsDataStore((s) => s.raptorIndex);
  const entries = useMemo(
    () => (response ? itineraryAlerts(response.alerts, itinerary, index) : []),
    [response, itinerary, index],
  );
  if (entries.length === 0) return null;
  return (
    <ul
      data-testid="service-alert-trip-notes"
      aria-label={text("serviceAlerts.heading")}
      className="list-none m-0 p-0 flex flex-col gap-1"
    >
      {entries.map(({ alert, lines }) => (
        <ServiceAlertItem key={alert.id} alert={alert} lines={lines} />
      ))}
    </ul>
  );
}
