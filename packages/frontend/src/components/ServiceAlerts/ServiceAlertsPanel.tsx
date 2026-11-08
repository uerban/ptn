import { useId } from "react";
import { useTranslation } from "../../i18n/index.ts";
import { usePresentationText } from "../../i18n/presentationStrings.ts";
import { useServiceAlertSelection } from "../../hooks/useServiceAlertSelection.ts";
import { useRealtimeKindStatus } from "../../services/realtimeAvailability.ts";
import type { AlertTarget } from "../../services/serviceAlertSelection.ts";
import { useInlineAlertsOffer } from "../../services/serviceAlertsOffer.ts";
import { ServiceAlertItem } from "./ServiceAlertItem.tsx";
import { ServiceAlertsOffer } from "./ServiceAlertsOffer.tsx";

/** Alert targets for a line view: the route, in any direction or stop. */
export function routeTargets(routeId: string | null | undefined): AlertTarget[] {
  return routeId ? [{ routeId }] : [];
}

export interface ServiceAlertsPanelProps {
  cityId: string;
  cityName?: string;
  /** What the surface shows, as alert selectors. Memoize it. */
  targets: readonly AlertTarget[];
  /** Also list alerts naming a field the surface does not know (line view). */
  includePartial?: boolean;
  /** Names the surface for tests and styling. */
  surface: "departure-sheet" | "line-view" | "route-results";
  /** Hide the per-surface alert list and show only the state and offer
   * (route results list alerts on each card instead). */
  listAlerts?: boolean;
  /** False while hidden: stops counting towards polling. */
  visible?: boolean;
}

export type ServiceAlertsPanelState =
  | "offer"
  | "loading"
  | "alerts"
  | "none-reported"
  | "stale"
  | "failed"
  | "unavailable";

/**
 * Service alerts for one surface: the alerts concerning what is on screen,
 * and the state of the city's alerts — none reported (with the check time;
 * never “service normal”), loading, stale, unavailable in this city, failed —
 * or the inline offer while alerts are not decided. Nothing here is a live
 * region: alerts appear without being announced.
 */
export function ServiceAlertsPanel({
  cityId,
  cityName,
  targets,
  includePartial = false,
  surface,
  listAlerts = true,
  visible = true,
}: ServiceAlertsPanelProps) {
  const text = usePresentationText();
  const { formattingLocale } = useTranslation();
  const headingId = useId();
  const { snapshot, alerts } = useServiceAlertSelection(cityId, targets, {
    includePartial,
    visible,
    // Route results judge each leg by when it runs (on its card).
    activeNow: listAlerts,
  });
  const offered = useRealtimeKindStatus(cityId, "alerts");
  const showOffer = useInlineAlertsOffer(cityId);

  const time = (ms: number | undefined) =>
    ms === undefined || !Number.isFinite(ms)
      ? ""
      : new Date(ms).toLocaleTimeString(formattingLocale, {
          hour: "2-digit",
          minute: "2-digit",
        });

  if (!visible) return null;
  let state: ServiceAlertsPanelState | null = null;
  let line: string | null = null;
  const response = snapshot.response;
  switch (snapshot.status) {
    case "blocked":
      if (showOffer) state = "offer";
      break;
    case "unavailable":
      if (offered === "unavailable") {
        state = "unavailable";
        line = cityName
          ? text("serviceAlerts.unavailable", { city: cityName })
          : text("serviceAlerts.unavailableGeneric");
      }
      break;
    case "loading":
      state = "loading";
      line = text("serviceAlerts.loading");
      break;
    case "ready":
      if (response?.stale) {
        // The server's copy of the feed is old: say so, alerts or not.
        state = "stale";
        line = text("serviceAlerts.stale", { time: time(Date.parse(response.fetchedAt)) });
      } else if (alerts.length > 0) {
        state = "alerts";
      } else {
        state = "none-reported";
        line = `${text("serviceAlerts.noneReported")} ${text("serviceAlerts.checkedAt", {
          time: time(snapshot.checkedAt),
        })}`;
      }
      break;
    case "failed":
      if (response) {
        state = "stale";
        line = text("serviceAlerts.refreshFailed", { time: time(snapshot.checkedAt) });
      } else {
        state = "failed";
        line = text("serviceAlerts.failed");
      }
      break;
  }
  if (state === null) return null;
  if (state === "offer") {
    return (
      <div data-testid="service-alerts-panel" data-surface={surface} data-state="offer">
        <ServiceAlertsOffer cityName={cityName} />
      </div>
    );
  }

  const shown = listAlerts ? alerts : [];
  if (shown.length === 0 && !line) return null;
  return (
    <section
      data-testid="service-alerts-panel"
      data-surface={surface}
      data-state={state}
      aria-labelledby={shown.length > 0 ? headingId : undefined}
      className="px-3 py-1.5"
    >
      {shown.length > 0 && (
        <>
          <h3 id={headingId} className="text-xs font-semibold text-fg-secondary mb-1">
            {text("serviceAlerts.heading")}
          </h3>
          <ul className="list-none m-0 p-0 flex flex-col gap-1.5">
            {shown.map((alert) => (
              <ServiceAlertItem key={alert.id} alert={alert} />
            ))}
          </ul>
        </>
      )}
      {line && (
        <p data-testid="service-alerts-status" className="text-xs text-fg-muted mt-1">
          {line}
        </p>
      )}
    </section>
  );
}
