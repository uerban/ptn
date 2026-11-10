import { useEffect, useState } from "react";
import type { Departure, Stop, TransportMode } from "@pt/shared";
import { POPUP_DEPARTED_CUTOFF_MINUTES } from "@pt/shared/constants";
import { useCountdown } from "../../hooks/useCountdown.ts";
import { useTranslation } from "../../i18n/index.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { resolveRouteStyle } from "../../utils/routeColor.ts";
import { useColorConfigStore } from "../../stores/colorConfigStore.ts";
import { ModeFilterPills } from "../ModeFilterPills.tsx";
import { Icon } from "../Icon.tsx";
import { StopFavoriteButton } from "../Favorites/StopFavoriteButton.tsx";
import { groupDeparturesByLine } from "../../utils/groupDeparturesByLine.ts";

const EMPTY_OVERRIDES: Partial<Record<TransportMode, string>> = {};

const MAX_UPCOMING_PER_GROUP = 10;

interface StopPopupProps {
  stopName: string;
  /** When set, the header offers a favorite star for this stop. */
  stop?: Pick<Stop, "id" | "name" | "location">;
  departures: Departure[];
  loading?: boolean;
  isSheetOpen?: boolean;
  onSeeAll: () => void;
  onClose?: () => void;
  onLineClick?: (routeId: string, routeShortName: string, routeColor: string | undefined, headsign: string) => void;
}

interface RouteGroup {
  routeId: string;
  routeShortName: string;
  routeColor?: string;
  mode: TransportMode;
  subMode?: string;
  headsign: string;
  upcoming: Departure[];
  allCancelled: boolean;
}

function groupByRoute(departures: Departure[]): RouteGroup[] {
  return groupDeparturesByLine(departures).map((g) => {
    const active = g.departures.filter((d) => !d.cancelled);
    const allCancelled = active.length === 0;
    // When the whole group is cancelled, fall back to the cancelled
    // list so the UI has *something* to render alongside the strike-
    // through styling. Otherwise show only active departures.
    const source = allCancelled ? g.departures : active;
    return {
      routeId: g.routeId,
      routeShortName: g.routeShortName,
      routeColor: g.routeColor,
      mode: g.mode,
      subMode: g.subMode,
      headsign: g.headsign,
      upcoming: source.slice(0, MAX_UPCOMING_PER_GROUP),
      allCancelled,
    };
  });
}

function collectTimestamps(groups: RouteGroup[]): string[] {
  const ts: string[] = [];
  for (const g of groups) {
    for (const dep of g.upcoming) {
      ts.push(dep.predictedTime ?? dep.scheduledTime);
    }
  }
  return ts;
}

function splitMinutes(groups: RouteGroup[], allMinutes: number[]): number[][] {
  const result: number[][] = [];
  let offset = 0;
  for (const g of groups) {
    result.push(allMinutes.slice(offset, offset + g.upcoming.length));
    offset += g.upcoming.length;
  }
  return result;
}

export function StopPopup({
  stopName,
  stop,
  departures,
  loading = false,
  isSheetOpen = false,
  onSeeAll,
  onClose,
  onLineClick,
}: StopPopupProps) {
  const { t } = useTranslation();
  const departuresPerLine = useSettingsStore((s) => s.departuresPerLine);
  const maxPopupLines = useSettingsStore((s) => s.maxPopupLines);

  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!loading) { setSlow(false); return; }
    const id = setTimeout(() => setSlow(true), 1500);
    return () => clearTimeout(id);
  }, [loading]);

  const [modeFilter, setModeFilter] = useState<TransportMode | null>(null);

  const allGroups = groupByRoute(departures);

  const uniqueModes = Array.from(new Set(allGroups.map((g) => g.mode)));

  useEffect(() => {
    if (modeFilter && !uniqueModes.includes(modeFilter)) {
      setModeFilter(null);
    }
  }, [uniqueModes, modeFilter]);

  const filteredGroups = modeFilter
    ? allGroups.filter((g) => g.mode === modeFilter)
    : allGroups;

  const allTimestamps = collectTimestamps(filteredGroups);
  const allMinutes = useCountdown(allTimestamps);
  const perGroupMinutes = splitMinutes(filteredGroups, allMinutes);

  const visible: { group: RouteGroup; mins: number[]; deps: Departure[] }[] = [];
  for (let i = 0; i < filteredGroups.length; i++) {
    const group = filteredGroups[i];
    const mins = perGroupMinutes[i];
    const filtered: { dep: Departure; min: number }[] = [];
    for (let j = 0; j < group.upcoming.length; j++) {
      // Popup doesn't poll, so use a tight cutoff to evict stale "Due"
      // entries quickly instead of letting them hang for minutes.
      if (mins[j] >= POPUP_DEPARTED_CUTOFF_MINUTES) {
        filtered.push({ dep: group.upcoming[j], min: mins[j] });
      }
    }
    const limited = filtered.slice(0, departuresPerLine);
    if (limited.length > 0) {
      visible.push({
        group,
        mins: limited.map((f) => f.min),
        deps: limited.map((f) => f.dep),
      });
    }
  }

  visible.sort((a, b) => a.mins[0] - b.mins[0]);

  return (
    <div data-testid="stop-popup" className="bg-surface-raised rounded-2xl shadow-2 w-80 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-divider">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <h3
            data-testid="popup-stop-name"
            className="font-semibold text-fg text-[17px] leading-tight"
            style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", whiteSpace: "normal" }}
          >
            {stopName}
          </h3>
          {departures.some((d) => d.predictedTime) && (
            <span className="text-[9px] font-bold text-success bg-success/15
              px-1.5 py-0.5 rounded-full flex items-center gap-1 shrink-0">
              <span className="w-1.5 h-1.5 bg-success rounded-full animate-pulse" />
              {t("popup.live", "LIVE")}
            </span>
          )}
        </div>
        {stop && <StopFavoriteButton stop={stop} />}
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-2 p-1 rounded-full hover:bg-surface-overlay"
          >
            <Icon name="close" size={16} className="text-fg-muted" />
          </button>
        )}
      </div>

      {/* Mode filter pills — only shown when 2+ modes present */}
      <ModeFilterPills modes={uniqueModes} activeMode={modeFilter} onChange={setModeFilter} />

      {/* Body — line cards (scrollable, capped at ~1/3 screen height) */}
      <div className="px-3 py-2 space-y-2 max-h-[33vh] overflow-y-auto">
        {loading && (
          <div className="space-y-2 py-2" data-testid="stop-popup-skeleton" aria-hidden>
            {Array.from({ length: 3 }).map((_, i) => (
              <LineCardSkeleton key={i} delay={i * 120} />
            ))}
          </div>
        )}
        {loading && slow && (
          <p data-testid="popup-loading-slow" className="text-xs text-fg-muted text-center pt-1">
            {t("popup.loading_schedule", "Loading schedule…")}
          </p>
        )}

        {!loading && visible.length === 0 && (
          <p className="text-sm text-fg-muted py-2 text-center">
            {modeFilter && allGroups.length > 0
              ? t("popup.no_departures_for_mode", "No departures for this mode")
              : t("popup.no_departures", "No upcoming departures")}
          </p>
        )}

        {!loading &&
          visible.slice(0, maxPopupLines).map(({ group, mins, deps }) => (
            <LineCard key={`${group.routeId}::${group.headsign}`} group={group} departures={deps} minutes={mins} onLineClick={onLineClick} />
          ))}
      </div>

      {/* Footer */}
      <div className="px-3 pb-3 pt-1">
        {isSheetOpen ? (
          <div className="w-full py-2 text-sm font-medium text-center text-fg-muted">
            ▼ {t("popup.expanded_below", "Expanded below")}
          </div>
        ) : (
          <button
            onClick={onSeeAll}
            className="w-full py-2 text-sm font-medium text-accent hover:bg-accent/10 rounded-lg transition-colors"
          >
            {t("popup.see_all", "See all")}
          </button>
        )}
      </div>
    </div>
  );
}

function LineCardSkeleton({ delay }: { delay: number }) {
  return (
    <div
      className="bg-surface-overlay rounded-lg px-3 py-2.5 border border-divider animate-shimmer motion-reduce:animate-none"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <div className="h-4 w-9 rounded-md bg-divider/80" />
        <div className="h-3 flex-1 max-w-[60%] rounded bg-divider/60" />
      </div>
      <div className="flex items-center gap-2.5 pl-0.5">
        <div className="h-4 w-12 rounded bg-divider/70" />
        <div className="h-3 w-8 rounded bg-divider/50" />
        <div className="h-3 w-8 rounded bg-divider/40" />
      </div>
    </div>
  );
}

interface LineCardProps {
  group: RouteGroup;
  departures: Departure[];
  minutes: number[];
  onLineClick?: (routeId: string, routeShortName: string, routeColor: string | undefined, headsign: string) => void;
}

function LineCard({ group, departures, minutes, onLineClick }: LineCardProps) {
  const { t } = useTranslation();
  const cityId = useCityStore((s) => s.activeCity.id);
  const modeOverrides = useSettingsStore((s) => s.modeColorOverrides[cityId]) ?? EMPTY_OVERRIDES;
  const scheme = useSettingsStore((s) => s.accessibilityScheme);
  const theme = useSettingsStore((s) => s.resolvedTheme);
  const highContrastEnabled = useSettingsStore((s) => s.highContrastEnabled);
  const colorConfig = useColorConfigStore((s) => s.config);
  const badgeStyle = resolveRouteStyle(group.routeColor, group.mode, modeOverrides, scheme, theme, group.subMode, highContrastEnabled, colorConfig);

  const handleClick = onLineClick
    ? () => onLineClick(group.routeId, group.routeShortName, group.routeColor, group.headsign)
    : undefined;

  return (
    <div
      data-testid="line-card"
      className={`bg-surface-overlay rounded-lg px-3 py-2.5 border border-divider${onLineClick ? " cursor-pointer hover:bg-surface-overlay/80 active:scale-[0.98] transition-transform" : ""}`}
      onClick={handleClick}
      role={onLineClick ? "button" : undefined}
      tabIndex={onLineClick ? 0 : undefined}
      onKeyDown={onLineClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleClick?.(); } } : undefined}
    >
      {/* Row 1: Badge + Headsign */}
      <div className="flex items-center gap-2 mb-1.5">
        <span
          data-testid="route-badge"
          className="text-sm font-bold min-w-[2.25rem] text-center rounded-md px-2 py-0.5 shrink-0 whitespace-nowrap"
          style={{
            "--route-color": badgeStyle.background,
            background: badgeStyle.background,
            color: badgeStyle.color,
            ...(badgeStyle.textStroke && { WebkitTextStroke: badgeStyle.textStroke }),
            ...(badgeStyle.paintOrder && { paintOrder: badgeStyle.paintOrder }),
          } as React.CSSProperties}
        >
          {group.routeShortName}
        </span>
        <span className="text-sm text-fg-secondary truncate">
          {group.headsign}
        </span>
      </div>

      {/* Row 2: Departure times */}
      <div className="flex items-center gap-2.5 pl-0.5">
        {group.allCancelled ? (
          <span className="text-sm font-medium text-danger">
            {t("popup.cancelled", "Cancelled")}
          </span>
        ) : (
          departures.map((dep, i) => {
            const mins = minutes[i];
            const isRealTime = Boolean(dep.predictedTime);
            const delaySeconds = dep.delaySeconds ?? 0;
            const delayMinutes = Math.round(delaySeconds / 60);

            const label = mins <= 0
              ? t("popup.due", "Due")
              : i === 0
                ? `${mins} ${t("time.min", "min")}`
                : t("unit.minutes_compact", "{n}m").replace("{n}", String(mins));

            const timeColor = i === 0
              ? isRealTime ? "text-success" : "text-fg"
              : "text-fg-muted";

            return (
              <span key={`${dep.tripId}_${dep.scheduledTime}`} className="flex items-baseline gap-0.5">
                <span data-countdown className={`font-semibold ${i === 0 ? "text-base" : "text-sm"} ${timeColor}`}>
                  {label}
                </span>
                {delayMinutes !== 0 && i === 0 && (
                  <span data-countdown className={`text-xs ${delayMinutes >= 5 ? "text-danger" : "text-warning"}`}>
                    ({delayMinutes > 0 ? "+" : ""}{delayMinutes})
                  </span>
                )}
              </span>
            );
          })
        )}
      </div>
    </div>
  );
}
