import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { Stop, TransportMode } from "@pt/shared";
import { useDepartures } from "../../hooks/useDepartures.ts";
import { StopFavoriteButton } from "../Favorites/StopFavoriteButton.tsx";
import { useCityStore } from "../../stores/cityStore.ts";
import { useGtfsDataStore } from "../../stores/gtfsDataStore.ts";
import { useTranslation } from "../../i18n/index.ts";
import { LineGroup } from "./LineGroup.tsx";
import { LiveTimesNotice } from "./LiveTimesNotice.tsx";
import { ServiceAlertsPanel } from "../ServiceAlerts/ServiceAlertsPanel.tsx";
import { stopTargets } from "../../hooks/useServiceAlertSelection.ts";
import { useLineClick } from "../../hooks/useLineClick.ts";
import { ModeFilterPills } from "../ModeFilterPills.tsx";
import { Icon } from "../Icon.tsx";
import {
  useFocusTrap,
  useReturnFocus,
} from "../../hooks/useFocusManagement.ts";
import { useSheetResize } from "../../hooks/useSheetResize.ts";
import { groupDeparturesByLine } from "../../utils/groupDeparturesByLine.ts";

interface DepartureSheetProps {
  stop: Stop;
  onClose: () => void;
}

const SHEET_PRESETS = { peek: 120, half: 0.5, full: 0.9 };

export function DepartureSheet({ stop, onClose }: DepartureSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const { height, grabProps, sheetProps } = useSheetResize(sheetRef, SHEET_PRESETS, "half");
  const { departures, loading, error, unavailable, updatedAt } = useDepartures(
    stop.id,
    true,
    24,
    { hedge: true },
  );
  const activeCityId = useCityStore((s) => s.activeCity.id);
  const activeCityName = useCityStore((s) => s.activeCity.name);
  const { t } = useTranslation();
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // US-037: capture activeElement on mount, restore on unmount.
  useReturnFocus();

  // Trap focus only when sheet is at full height — peek/half should not trap
  // because the user might still want to navigate the map behind the sheet.
  useFocusTrap(sheetRef, height === "full");

  // Move focus to the close button when the sheet first opens. Do this once
  // (mount only) so re-renders don't yank focus away from a row the user is
  // navigating to with arrow keys.
  useEffect(() => {
    closeBtnRef.current?.focus();
  }, []);

  // Arrow keys navigate between LineGroup rows inside the body.
  const handleBodyKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const container = bodyRef.current;
    if (!container) return;
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>(
        'button, [href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (rows.length === 0) return;
    e.preventDefault();
    const idx = rows.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === "ArrowDown") {
      next = idx < rows.length - 1 ? idx + 1 : 0;
    } else {
      next = idx > 0 ? idx - 1 : rows.length - 1;
    }
    rows[next]?.focus();
  }, []);

  const [modeFilter, setModeFilter] = useState<TransportMode | null>(null);
  const timetable = useGtfsDataStore((s) => s.raptorIndex);
  const alertTargets = useMemo(
    () => stopTargets(stop.id, departures, timetable),
    [stop.id, departures, timetable],
  );

  const groups = groupDeparturesByLine(departures);
  const { openLine: handleLineClick } = useLineClick();

  const uniqueModes = Array.from(new Set(groups.map((g) => g.mode)));

  useEffect(() => {
    if (modeFilter && !uniqueModes.includes(modeFilter)) {
      setModeFilter(null);
    }
  }, [uniqueModes, modeFilter]);

  const filteredGroups = modeFilter
    ? groups.filter((g) => g.mode === modeFilter)
    : groups;

  // Dismiss sheet on Escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      ref={sheetRef}
      data-testid="departure-sheet"
      role="dialog"
      aria-modal={height === "full" ? true : undefined}
      aria-label={stop.name}
      data-sheet-height={height}
      {...sheetProps}
      className={`bg-surface-raised rounded-t-2xl shadow-2 overflow-hidden flex flex-col transition-[max-height] duration-300`}
    >
      {/* Grab area: swipe up/down or tap the handle and header to resize */}
      <div {...grabProps} data-testid="sheet-grab-area" className="cursor-pointer select-none">
      <button
        type="button"
        data-testid="sheet-handle"
        data-sheet-handle
        className="flex w-full justify-center pt-3 pb-2 min-h-8 cursor-pointer"
        aria-label={height === "peek" ? "Expand sheet" : height === "half" ? "Expand sheet" : "Collapse sheet"}
      >
        <span aria-hidden="true" className="block w-10 h-1 rounded-full bg-sheet-handle" />
      </button>

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-divider">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <h2 data-testid="sheet-stop-name" className="text-lg font-semibold text-fg truncate">
            {stop.name}
          </h2>
          {departures.some((d) => d.predictedTime) && (
            <span className="text-[9px] font-bold text-success bg-success/10
              px-1.5 py-0.5 rounded-full flex items-center gap-1 shrink-0">
              <span className="w-1.5 h-1.5 bg-success rounded-full animate-pulse motion-reduce:animate-none" />
              {t("popup.live", "LIVE")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 ml-2">
          <StopFavoriteButton stop={stop} />
          <button
            ref={closeBtnRef}
            data-testid="sheet-close"
            data-sheet-close
            onClick={onClose}
            className="p-2 rounded-full hover:bg-surface-overlay"
            aria-label="Close"
          >
            <Icon name="close" className="text-fg-muted" />
          </button>
        </div>
      </div>
      </div>

      {/* Scheduled vs live, and the way to live times */}
      {height !== "peek" && (
        <LiveTimesNotice
          cityId={activeCityId}
          cityName={activeCityName}
          departures={departures}
          loading={loading}
          unavailable={unavailable}
          updatedAt={updatedAt}
        />
      )}

      {/* Mode filter pills — only shown when 2+ modes present */}
      {height !== "peek" && !loading && (
        <ModeFilterPills modes={uniqueModes} activeMode={modeFilter} onChange={setModeFilter} />
      )}

      {/* Body */}
      {height !== "peek" && (
        <div
          ref={bodyRef}
          onKeyDown={handleBodyKeyDown}
          className="overflow-y-auto flex-1 py-1"
        >
          {/* Service alerts for this stop and its departures, or the offer */}
          <ServiceAlertsPanel
            cityId={activeCityId}
            cityName={activeCityName}
            targets={alertTargets}
            surface="departure-sheet"
          />
          {loading && (
            <div className="space-y-1.5 mx-2 my-2" data-testid="departure-sheet-skeleton" aria-hidden>
              {Array.from({ length: 5 }).map((_, i) => (
                <LineGroupSkeleton key={i} delay={i * 100} />
              ))}
            </div>
          )}

          {error && (
            <div className="p-4 text-center text-danger text-sm">{error}</div>
          )}

          {!loading && !error && !unavailable && filteredGroups.length === 0 && (
            <div className="p-4 text-center text-fg-muted text-sm">
              {modeFilter && groups.length > 0
                ? t("sheet.no_departures_for_mode", "No departures for this mode")
                : t("sheet.no_departures", "No upcoming departures")}
            </div>
          )}

          {filteredGroups.map((group) => (
            <LineGroup
              key={group.key}
              routeId={group.routeId}
              routeShortName={group.routeShortName}
              routeColor={group.routeColor}
              mode={group.mode}
              subMode={group.subMode}
              headsign={group.headsign}
              departures={group.departures}
              onLineClick={handleLineClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LineGroupSkeleton({ delay }: { delay: number }) {
  return (
    <div
      className="bg-surface-overlay rounded-lg border border-divider px-3 py-2 flex items-center gap-2 animate-shimmer motion-reduce:animate-none"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="h-4 w-8 rounded bg-divider/80 shrink-0" />
      <div className="h-3 flex-1 max-w-[55%] rounded bg-divider/60" />
      <div className="h-3 w-6 rounded bg-divider/50 shrink-0" />
      <div className="h-3 w-6 rounded bg-divider/40 shrink-0" />
      <div className="h-3 w-4 rounded bg-divider/30 shrink-0" />
    </div>
  );
}
