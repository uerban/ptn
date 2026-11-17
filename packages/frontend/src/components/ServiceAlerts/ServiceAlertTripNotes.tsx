import type { Alert, Itinerary } from "@pt/shared";
import {
  alertsByLeg,
  type AlertTargetIndex,
} from "../../hooks/useServiceAlertSelection.ts";

export interface LegAlert {
  alert: Alert;
  /** Line names of the affected legs, in leg order. */
  lines: string[];
}

/**
 * Each alert of one route result once, with the lines of the legs it
 * concerns. Active periods are compared with when each leg runs, not with
 * now. Result lists merge these per list (`RouteAlerts.tsx`).
 */
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
