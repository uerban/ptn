import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n/index.ts";
import { usePresentationText } from "../../i18n/presentationStrings.ts";
import { useTripServiceAlerts } from "../../hooks/useServiceAlertSelection.ts";
import { pickTranslation } from "../../services/serviceAlertSelection.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useGuidanceStore } from "../../stores/guidanceStore.ts";

/**
 * The one spoken alert: a polite announcement when a `SEVERE` alert newly
 * concerns the trip being guided. Each alert is announced once per trip;
 * every other alert is shown without being announced. Runs for Text and Map
 * guidance alike, also in rider mode.
 */
export function ServiceAlertTripAnnouncer() {
  const text = usePresentationText();
  const { locale } = useTranslation();
  const cityId = useCityStore((s) => s.activeCity.id);
  const itinerary = useGuidanceStore((s) => (s.phase === "idle" ? null : s.itinerary));
  const byLeg = useTripServiceAlerts(cityId, itinerary);
  const announced = useRef<{ trip: unknown; ids: Set<string> }>({ trip: null, ids: new Set() });
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (announced.current.trip !== itinerary) {
      announced.current = { trip: itinerary, ids: new Set() };
      setMessage("");
    }
    if (!itinerary) return;
    // Alerts arriving together make one announcement.
    const fresh: string[] = [];
    for (const legAlerts of byLeg) {
      for (const alert of legAlerts) {
        if (alert.severity !== "SEVERE" || announced.current.ids.has(alert.id)) continue;
        announced.current.ids.add(alert.id);
        const header =
          pickTranslation(alert.header, locale) ?? pickTranslation(alert.description, locale);
        fresh.push(text("serviceAlerts.tripSevere", { header: header?.text ?? "" }));
      }
    }
    if (fresh.length > 0) setMessage(fresh.join(" "));
  }, [itinerary, byLeg, locale, text]);

  return (
    <div role="status" aria-live="polite" className="sr-only" data-testid="service-alert-trip-announcer">
      {message}
    </div>
  );
}
