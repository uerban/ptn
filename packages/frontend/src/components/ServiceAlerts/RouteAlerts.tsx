import { useId, useMemo, useState } from "react";
import type { Alert, Itinerary } from "@pt/shared";
import { useTranslation } from "../../i18n/index.ts";
import { usePresentationText } from "../../i18n/presentationStrings.ts";
import type { AlertTargetIndex } from "../../hooks/useServiceAlertSelection.ts";
import { pickTranslation } from "../../services/serviceAlertSelection.ts";
import { useServiceAlerts } from "../../services/serviceAlertsClient.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useGtfsDataStore } from "../../stores/gtfsDataStore.ts";
import { Icon } from "../Icon.tsx";
import { itineraryAlerts, type LegAlert } from "./ServiceAlertTripNotes.tsx";
import { langAttribute, ServiceAlertItem, SeverityLabel } from "./ServiceAlertItem.tsx";

export interface ListAlerts {
  /** Each alert once, with the lines it concerns across all results. Urgent first. */
  all: LegAlert[];
  /** The alerts of each result, in result order. */
  perItinerary: LegAlert[][];
  /** Index of the first result each alert concerns, by alert id. */
  firstAt: ReadonlyMap<string, number>;
}

const EMPTY: ListAlerts = { all: [], perItinerary: [], firstAt: new Map() };

/** A severe alert or one that stops service is never folded away. */
export function isUrgentAlert(alert: Alert): boolean {
  return alert.severity === "SEVERE" || alert.effect === "NO_SERVICE";
}

/** The alerts of a whole result list, computed once for the list. */
export function listAlerts(
  alerts: readonly Alert[],
  itineraries: readonly Pick<Itinerary, "legs">[],
  index?: AlertTargetIndex | null,
): ListAlerts {
  const byId = new Map<string, LegAlert>();
  const firstAt = new Map<string, number>();
  const perItinerary = itineraries.map((it, i) => {
    const entries = itineraryAlerts(alerts, it, index);
    for (const { alert, lines } of entries) {
      let merged = byId.get(alert.id);
      if (!merged) {
        merged = { alert, lines: [] };
        byId.set(alert.id, merged);
        firstAt.set(alert.id, i);
      }
      for (const line of lines) if (!merged.lines.includes(line)) merged.lines.push(line);
    }
    return entries;
  });
  const all = [...byId.values()].sort(
    (a, b) => Number(isUrgentAlert(b.alert)) - Number(isUrgentAlert(a.alert)),
  );
  return { all, perItinerary, firstAt };
}

export function useListAlerts(itineraries: readonly Itinerary[]): ListAlerts {
  const cityId = useCityStore((s) => s.activeCity.id);
  const response = useServiceAlerts(cityId, true).response;
  const index = useGtfsDataStore((s) => s.raptorIndex);
  return useMemo(
    () => (response ? listAlerts(response.alerts, itineraries, index) : EMPTY),
    [response, itineraries, index],
  );
}

/**
 * One strip above the results: urgent alerts in full, the rest behind one
 * button naming how many there are. Each alert appears once per list.
 */
export function RouteAlertsSummary({ entries }: { entries: readonly LegAlert[] }) {
  const text = usePresentationText();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (entries.length === 0) return null;
  const urgent = entries.filter((e) => isUrgentAlert(e.alert));
  const rest = entries.filter((e) => !isUrgentAlert(e.alert));
  return (
    <section
      data-testid="route-alerts-summary"
      aria-label={text("serviceAlerts.heading")}
      className="font-sans not-italic flex flex-col gap-1 px-3 py-1.5 border-b border-divider"
    >
      {urgent.length > 0 && (
        <ul className="list-none m-0 p-0 flex flex-col gap-1">
          {urgent.map(({ alert, lines }) => (
            <ServiceAlertItem key={alert.id} alert={alert} lines={lines} />
          ))}
        </ul>
      )}
      {rest.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={listId}
            data-testid="route-alerts-toggle"
            onClick={() => setExpanded((v) => !v)}
            className="min-h-11 flex items-center gap-2 text-left text-sm font-medium text-fg rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Icon name="warning" size={16} className="shrink-0 text-warning-fg" />
            <span className="flex-1 min-w-0">
              {text("serviceAlerts.onRoutes", { count: String(rest.length) })}
            </span>
            <Icon
              name="chevron-down"
              size={14}
              className={`shrink-0 text-fg-muted transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </button>
          <ul id={listId} hidden={!expanded} className="list-none m-0 p-0 flex flex-col gap-1">
            {rest.map(({ alert, lines }) => (
              <ServiceAlertItem key={alert.id} alert={alert} lines={lines} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function affectedLines(entries: readonly LegAlert[]): string[] {
  const lines: string[] = [];
  for (const e of entries) for (const l of e.lines) if (!lines.includes(l)) lines.push(l);
  return lines;
}

/** Compact cue under a result: which of its lines have an alert. */
export function RouteAlertMarker({ entries }: { entries: readonly LegAlert[] }) {
  const text = usePresentationText();
  if (entries.length === 0) return null;
  const lines = affectedLines(entries);
  const urgent = entries.some((e) => isUrgentAlert(e.alert));
  return (
    <p
      data-testid="route-alert-marker"
      className={`font-sans not-italic m-0 flex items-center gap-1 px-1 text-xs font-semibold ${urgent ? "text-danger" : "text-warning-fg"}`}
    >
      <Icon name="warning" size={14} className="shrink-0" />
      <span aria-hidden>{lines.length > 0 ? lines.join(", ") : text("serviceAlerts.indicator")}</span>
      <span className="sr-only">
        {lines.length > 0
          ? text("serviceAlerts.affectsLines", { lines: lines.join(", ") })
          : text(urgent ? "serviceAlerts.indicatorSevere" : "serviceAlerts.indicator")}
      </span>
    </p>
  );
}

/**
 * Accessible layout: every result keeps its alerts with it. The first result
 * an alert concerns shows it in full; later ones point back to it.
 */
export function RouteAlertsForResult({
  entries,
  index,
  firstAt,
}: {
  entries: readonly LegAlert[];
  index: number;
  firstAt: ReadonlyMap<string, number>;
}) {
  const text = usePresentationText();
  const { locale } = useTranslation();
  if (entries.length === 0) return null;
  return (
    <ul
      data-testid="route-alerts-for-result"
      aria-label={text("serviceAlerts.heading")}
      className="font-sans not-italic list-none m-0 p-0 flex flex-col gap-1"
    >
      {entries.map(({ alert, lines }) => {
        if (firstAt.get(alert.id) === index) {
          return <ServiceAlertItem key={alert.id} alert={alert} lines={lines} />;
        }
        const header = pickTranslation(alert.header, locale) ?? pickTranslation(alert.description, locale);
        return (
          <li
            key={alert.id}
            data-testid="route-alert-repeat"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 rounded-lg border border-divider bg-surface-overlay text-xs text-fg"
          >
            <SeverityLabel severity={alert.severity} />
            <span className="font-semibold">{text("serviceAlerts.sameAsAbove")}</span>
            {lines.length > 0 && <span>{text("serviceAlerts.lines", { lines: lines.join(", ") })}</span>}
            {header && (
              <span lang={langAttribute(header, locale)} className="min-w-0 line-clamp-1 break-words">
                {header.text}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
