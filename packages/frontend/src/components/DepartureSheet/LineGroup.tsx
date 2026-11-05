import { useState } from "react";
import type { Departure, TransportMode } from "@pt/shared";
import { useCountdown } from "../../hooks/useCountdown.ts";
import { DEPARTED_CUTOFF_MINUTES } from "@pt/shared/constants";
import { useTranslation } from "../../i18n/index.ts";
import { pluralize } from "../../i18n/plurals.ts";
import { resolveRouteStyle } from "../../utils/routeColor.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useColorConfigStore } from "../../stores/colorConfigStore.ts";
import { useDelayReportStore } from "../../stores/delayReportStore.ts";
import { Icon } from "../Icon.tsx";

const EMPTY_OVERRIDES: Partial<Record<TransportMode, string>> = {};

interface LineGroupProps {
  routeShortName: string;
  routeColor?: string;
  mode: TransportMode;
  subMode?: string;
  headsign: string;
  departures: readonly Departure[];
  onLineClick?: (routeId: string, routeShortName: string, routeColor: string | undefined, headsign: string) => void;
  routeId?: string;
}

export function LineGroup({
  routeShortName,
  routeColor,
  mode,
  subMode,
  headsign,
  departures,
  onLineClick,
  routeId,
}: LineGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const { t, locale, formattingLocale } = useTranslation();
  const cityId = useCityStore((s) => s.activeCity.id);
  const modeOverrides = useSettingsStore((s) => s.modeColorOverrides[cityId]) ?? EMPTY_OVERRIDES;
  const scheme = useSettingsStore((s) => s.accessibilityScheme);
  const theme = useSettingsStore((s) => s.resolvedTheme);
  const highContrastEnabled = useSettingsStore((s) => s.highContrastEnabled);
  const colorConfig = useColorConfigStore((s) => s.config);
  const timestamps = departures.map(
    (d) => d.predictedTime ?? d.scheduledTime
  );
  const minutes = useCountdown(timestamps);
  const badgeStyle = resolveRouteStyle(routeColor, mode, modeOverrides, scheme, theme, subMode, highContrastEnabled, colorConfig);

  // Crowdsourced delay indicator — only when no official RT data exists
  const hasRealTime = departures.some((d) => d.predictedTime);
  const allReports = useDelayReportStore((s) => s.reports);
  const crowdReports = hasRealTime || !routeId
    ? []
    : (() => {
        const cutoff = Date.now() - 60 * 60 * 1000;
        return allReports.filter(
          (r) => r.routeId === routeId && r.timestamp >= cutoff,
        );
      })();

  return (
    <div className="bg-surface-overlay rounded-lg mx-2 mb-1.5 border border-divider overflow-hidden">
      {/* Collapsed row */}
      <div
        className="flex items-center"
        style={{
          gap: "var(--variant-chip-gap)",
          padding: "var(--variant-row-pad)",
          minHeight: "var(--variant-row-min-height)",
        }}
      >
        {/* Route badge + view route button */}
        <span className="flex items-center gap-1 shrink-0">
          <span
            className="font-bold text-center rounded px-1.5 py-0.5 shrink-0 whitespace-nowrap"
            style={{
              '--route-color': badgeStyle.background,
              background: badgeStyle.background,
              color: badgeStyle.color,
              fontSize: "var(--variant-meta-text-size)",
              minWidth: "2rem",
              ...(badgeStyle.textStroke && { WebkitTextStroke: badgeStyle.textStroke }),
              ...(badgeStyle.paintOrder && { paintOrder: badgeStyle.paintOrder }),
            } as React.CSSProperties}
          >
            {routeShortName}
          </span>
          {onLineClick && routeId && (
            <button
              type="button"
              data-testid="view-route-btn"
              onClick={() => onLineClick(routeId, routeShortName, routeColor, headsign)}
              className="p-0.5 rounded hover:bg-surface-overlay/70"
              aria-label={`View route ${routeShortName} towards ${headsign}`}
            >
              <Icon name="map" size={16} className="text-fg-muted" />
            </button>
          )}
        </span>

        {/* Expand/collapse toggle — covers headsign, chips, and chevron */}
        <button
          type="button"
          data-testid="line-group-toggle"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex-1 flex items-center gap-2 min-w-0 hover:bg-surface-overlay/50 rounded -my-1 py-1 text-left"
          aria-expanded={expanded}
          aria-label={`${routeShortName} ${headsign}`}
        >
          {/* Headsign */}
          <span className="flex-1 text-sm text-fg-secondary truncate">
            {headsign}
          </span>

          {/* Departure time chips (collapsed summary) */}
          <CollapsedChips
            departures={departures}
            minutes={minutes}
            t={t}
          />

          {/* Expand/collapse chevron */}
          <Icon
            name="chevron-down"
            size={16}
            className={`text-fg-muted shrink-0 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
          />
        </button>
      </div>

      {/* Crowdsourced delay indicator */}
      {crowdReports.length > 0 && (
        <CrowdDelayIndicator reports={crowdReports} t={t} locale={locale} />
      )}

      {/* Expanded schedule panel */}
      {expanded && (
        <div className="mx-3 mb-2 border-t border-divider pt-1.5 space-y-1">
          {departures.map((dep, idx) => {
            const mins = minutes[idx] ?? 0;
            if (mins < DEPARTED_CUTOFF_MINUTES) return null;

            return (
              <ScheduleRow
                key={`${dep.tripId}_${dep.scheduledTime}`}
                departure={dep}
                minutes={mins}
                formattingLocale={formattingLocale}
                t={t}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

const MAX_COLLAPSED_CHIPS = 4;

interface CollapsedChipsProps {
  departures: readonly Departure[];
  minutes: number[];
  t: (key: string, fallback?: string) => string;
}

function CollapsedChips({ departures, minutes, t }: CollapsedChipsProps) {
  // Separate into due items and regular upcoming items
  const dueItems: { dep: Departure; mins: number }[] = [];
  const upcomingItems: { dep: Departure; mins: number }[] = [];

  for (let i = 0; i < departures.length; i++) {
    const dep = departures[i];
    const mins = minutes[i] ?? 0;
    if (mins < DEPARTED_CUTOFF_MINUTES) continue; // already departed past cutoff
    if (mins < 0) continue; // freshly departed — hide from collapsed view
    if (mins === 0) {
      dueItems.push({ dep, mins });
    } else {
      upcomingItems.push({ dep, mins });
    }
  }

  // Limit upcoming chips to MAX_COLLAPSED_CHIPS
  const limitedUpcoming = upcomingItems.slice(0, MAX_COLLAPSED_CHIPS);

  return (
    <div
      className="flex items-center gap-1.5 shrink-0"
      style={{ fontSize: "var(--variant-meta-text-size)" }}
    >
      {/* Due items shown separately */}
      {dueItems.map(({ dep }) => (
        <span
          key={`${dep.tripId}_${dep.scheduledTime}`}
          data-countdown
          className={`text-xs font-semibold ${dep.cancelled ? "text-danger line-through opacity-60" : "text-success"}`}
        >
          {dep.cancelled ? t("popup.cancelled", "Cancelled") : t("popup.due", "Due")}
        </span>
      ))}

      {/* Regular upcoming chips — up to MAX_COLLAPSED_CHIPS */}
      {limitedUpcoming.map(({ dep, mins }) => {
        if (dep.cancelled) {
          return (
            <span
              key={`${dep.tripId}_${dep.scheduledTime}`}
              data-countdown
              className="text-xs font-medium text-danger line-through opacity-60"
              title={t("popup.cancelled", "Cancelled")}
            >
              {mins}&thinsp;m
            </span>
          );
        }

        const isRealTime = Boolean(dep.predictedTime);
        const delaySeconds = dep.delaySeconds ?? 0;
        const delayShouldShow = delaySeconds >= 60;
        const delayMinutes = Math.round(delaySeconds / 60);

        const timeColor = isRealTime ? "text-success" : "text-fg-secondary";

        const delayColor =
          delayMinutes >= 5
            ? "text-danger"
            : "text-warning";

        return (
          <span
            key={`${dep.tripId}_${dep.scheduledTime}`}
            className="flex items-center gap-0.5 text-xs font-semibold"
          >
            <span data-countdown className={timeColor}>{mins}&thinsp;m</span>
            {delayShouldShow && (
              <span data-countdown className={`text-[10px] font-bold ${delayColor}`}>
                +{delayMinutes}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

interface ScheduleRowProps {
  departure: Departure;
  minutes: number;
  formattingLocale: string;
  t: (key: string, fallback?: string) => string;
}

function ScheduleRow({ departure, minutes, formattingLocale, t }: ScheduleRowProps) {
  const dep = departure;
  const isRealTime = Boolean(dep.predictedTime);
  const isDeparted = minutes < 0;
  const delaySeconds = dep.delaySeconds ?? 0;
  const delayMinutes = Math.round(delaySeconds / 60);
  const delayShouldShow = isRealTime && Math.abs(delaySeconds) >= 60;

  const scheduledDate = new Date(dep.scheduledTime);
  const clockTime = scheduledDate.toLocaleTimeString(formattingLocale, {
    hour: "2-digit",
    minute: "2-digit",
  });

  // Predicted clock time — only when real-time and differs from scheduled
  const predictedDate = dep.predictedTime ? new Date(dep.predictedTime) : null;
  const predictedClockTime = predictedDate
    ? predictedDate.toLocaleTimeString(formattingLocale, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const showPredicted = isRealTime && predictedClockTime && predictedClockTime !== clockTime;

  if (dep.cancelled) {
    return (
      <div
        data-testid="schedule-row"
        className="flex items-center justify-between opacity-60"
        style={{ padding: "var(--variant-row-pad)", fontSize: "var(--variant-meta-text-size)" }}
      >
        <span data-testid="scheduled-time" data-countdown className="text-danger line-through">{clockTime}</span>
        <span className="text-danger font-medium">{t("popup.cancelled", "Cancelled")}</span>
      </div>
    );
  }

  // Countdown always in minutes
  let countdownLabel: string;
  if (minutes === 0) {
    countdownLabel = t("popup.due", "Due");
  } else if (minutes < 0) {
    countdownLabel = `${Math.abs(minutes)} ${t("time.min_ago", "min ago")}`;
  } else {
    countdownLabel = `${minutes} ${t("time.min", "min")}`;
  }

  const timeColor = isDeparted
    ? "text-fg-muted"
    : isRealTime
    ? "text-success"
    : "text-fg-secondary";

  return (
    <div
      data-testid="schedule-row"
      className="flex items-center justify-between"
      style={{ padding: "var(--variant-row-pad)", fontSize: "var(--variant-meta-text-size)" }}
    >
      {/* Scheduled clock time */}
      <span data-testid="scheduled-time" data-countdown className="text-fg-muted font-medium">{clockTime}</span>

      <div className="flex items-center gap-2">
        {/* Delay badge — only when real-time and delay >= 60s */}
        {delayShouldShow && (
          <span data-countdown className={`font-bold ${Math.abs(delayMinutes) >= 5 ? "text-danger" : "text-warning"}`}>
            {delayMinutes > 0 ? "+" : ""}{delayMinutes}m
          </span>
        )}

        {/* Predicted clock time — only when real-time and different from scheduled */}
        {showPredicted && (
          <span data-testid="predicted-time" data-countdown className="text-fg-secondary font-medium">
            {predictedClockTime}
          </span>
        )}

        {/* Realtime indicator dot */}
        {isRealTime && !isDeparted && (
          <span className="w-1.5 h-1.5 bg-success rounded-full" />
        )}

        {/* Countdown — always in minutes */}
        <span data-countdown className={`font-semibold ${timeColor}`}>
          {countdownLabel}
        </span>
      </div>
    </div>
  );
}

const CATEGORY_LABELS: Record<string, { key: string; fallback: string }> = {
  on_time: { key: "delay.on_time", fallback: "On time" },
  slight: { key: "delay.slight_short", fallback: "slight delay" },
  significant: { key: "delay.significant_short", fallback: "significant delay" },
  major: { key: "delay.major_short", fallback: "major delay" },
  cancelled: { key: "delay.cancelled_short", fallback: "cancelled" },
};

interface CrowdDelayIndicatorProps {
  reports: { category: string }[];
  t: (key: string, fallback?: string) => string;
  locale: string;
}

function CrowdDelayIndicator({ reports, t, locale }: CrowdDelayIndicatorProps) {
  // Find the most common category
  const counts = new Map<string, number>();
  for (const r of reports) {
    counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  }
  let dominant = "slight";
  let maxCount = 0;
  for (const [cat, count] of counts) {
    if (count > maxCount) {
      dominant = cat;
      maxCount = count;
    }
  }

  const label = CATEGORY_LABELS[dominant] ?? CATEGORY_LABELS.slight;
  const count = reports.length;

  return (
    <div
      data-testid="crowd-delay-indicator"
      className="mx-3 mb-1 px-2 py-1 rounded bg-warning/10 border border-warning/20
        flex items-center gap-1.5 text-xs text-warning"
    >
      <span aria-hidden="true" className="text-sm">&#128101;</span>
      <span>
        {count} {pluralize(
          locale,
          count,
          t("delay.report_count_one", "report"),
          t("delay.report_count_few", "reports"),
          t("delay.report_count_many", "reports"),
        )}
        : {t(label.key, label.fallback)}
      </span>
    </div>
  );
}
