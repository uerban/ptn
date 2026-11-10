import { useMemo, useRef, useCallback, useEffect } from "react";
import { useGuidanceStore } from "../../stores/guidanceStore.ts";
import { useRtStore } from "../../stores/rtStore.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useAutoFocus } from "../../hooks/useFocusManagement.ts";
import { useSheetResize } from "../../hooks/useSheetResize.ts";
import { LegRow } from "./LegRow.tsx";
import { computeConnectionStatus, type ConnectionStatus } from "./connectionStatus.ts";
import { useTranslation } from "../../i18n/index.ts";
import { Timebar } from "./Timebar.tsx";
import { Icon } from "../Icon.tsx";
import { useGuidanceDisplay } from "../../hooks/useGuidanceDisplay.ts";
import { useNextDepartureInMin } from "../../hooks/useNextDepartureAfter.ts";
import { shownTripSpan } from "../RouteResults/shared/itineraryDisplay.ts";
import { LeaveHint } from "../RouteResults/shared/LeaveHint.tsx";
import { LeadingWaitBanner, shouldShowLeadingWaitBanner } from "../RouteResults/shared/LeadingWaitBanner.tsx";
import { TzIndicator } from "../RouteResults/shared/TzIndicator.tsx";
import { transferRisk, peakDelayMinutes } from "../RouteResults/shared/legHelpers.ts";
import { useTripServiceAlerts } from "../../hooks/useServiceAlertSelection.ts";

interface StepListProps {
  onLegTap: (legIndex: number) => void;
  onClose: () => void;
}


const SHEET_PRESETS = { peek: 0.15, half: 0.45, full: 0.85 };

export function StepList({ onLegTap, onClose }: StepListProps) {
  const { t, formattingLocale } = useTranslation();
  // The guidance itinerary's leg/arrival ISO times are feed-tz-anchored true
  // instants (produced by convertRaptorResults), so render them in the feed tz.
  const feedTz = useCityStore((s) => s.activeCity.tz);
  const cityId = useCityStore((s) => s.activeCity.id);
  const sheetRef = useRef<HTMLDivElement>(null);
  const { height, grabProps, sheetProps } = useSheetResize(sheetRef, SHEET_PRESETS, "half");
  const legListRef = useRef<HTMLDivElement>(null);
  const activeLegRef = useRef<HTMLElement | null>(null);

  // Escape key closes the step list
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

  // Arrow keys navigate between leg rows
  const handleLegListKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const container = legListRef.current;
    if (!container) return;
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-testid='leg-row']"));
    if (rows.length === 0) return;
    const idx = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      rows[idx < rows.length - 1 ? idx + 1 : 0]?.focus();
    } else {
      rows[idx > 0 ? idx - 1 : rows.length - 1]?.focus();
    }
  }, []);

  const phase = useGuidanceStore((s) => s.phase);
  const itinerary = useGuidanceStore((s) => s.itinerary);
  const legStatuses = useGuidanceStore((s) => s.legStatuses);
  const walkingProgress = useGuidanceStore((s) => s.walkingProgress);
  const transitProgress = useGuidanceStore((s) => s.transitProgress);
  const currentLegIndex = useGuidanceStore((s) => s.currentLegIndex);
  const legAlerts = useTripServiceAlerts(cityId, phase === "idle" ? null : itinerary);

  // US-037: when the active step advances (e.g. user crossed a stop boundary),
  // move keyboard focus to the new "current" leg row so screen-reader/keyboard
  // users follow the progress without losing context. Use a derived ref that
  // tracks the active row in the DOM, then re-runs on currentLegIndex change.
  useEffect(() => {
    const container = legListRef.current;
    if (!container) {
      activeLegRef.current = null;
      return;
    }
    const rows = container.querySelectorAll<HTMLElement>(
      '[data-testid="leg-row"]',
    );
    activeLegRef.current = rows[currentLegIndex] ?? null;
  }, [currentLegIndex, itinerary]);
  useAutoFocus(activeLegRef, currentLegIndex);

  // Live: the clock ticks, the walk still ahead shrinks, RT moves the bus.
  const { display, referenceNowMs } = useGuidanceDisplay();
  const nextDepartureInMin = useNextDepartureInMin(itinerary, display, referenceNowMs);
  const risk = display ? transferRisk(display.segments) : null;
  const liveDelay = itinerary ? peakDelayMinutes(itinerary) : { minutes: 0, line: null };
  const showBanner = display
    ? shouldShowLeadingWaitBanner({
        leadingWaitSeconds: display.leadingWaitSeconds,
        bufferSeconds: display.bufferSeconds,
        missRisk: risk === "miss",
        hasLiveDelay: liveDelay.minutes >= 2,
      })
    : false;
  const hideBufferChrome = !display || display.parseFailed || display.alreadyDeparted;

  const overallProgress = useMemo(() => {
    if (!itinerary || phase !== "navigating") return null;
    const totalLegs = itinerary.legs.length;
    if (totalLegs === 0) return null;
    const completedFraction = currentLegIndex / totalLegs;
    const currentLegFraction = 1 / totalLegs;
    if (transitProgress) {
      const totalStops = (itinerary.legs[currentLegIndex]?.intermediateStops ?? 0) + 1;
      const stopsCompleted = totalStops - transitProgress.stopsRemaining;
      return completedFraction + (stopsCompleted / totalStops) * currentLegFraction;
    }
    return completedFraction;
  }, [itinerary, phase, currentLegIndex, transitProgress]);

  // Compute connection statuses for each leg.
  // We subscribe to `updates` so the memo re-runs when RT patches land —
  // calling useRtStore.getState() here would freeze the snapshot at mount and
  // the connection banners would never reflect live delays (D-009).
  const rtUpdates = useRtStore((s) => s.updates);
  const connectionStatuses = useMemo((): (ConnectionStatus | null)[] => {
    if (!itinerary) return [];
    const lookup = {
      getTripDelay: (tripId: string) => {
        for (const trips of rtUpdates.values()) {
          const t = trips.find((u) => u.tripId === tripId);
          if (t) return { delaySeconds: t.delaySeconds, cancelled: t.cancelled };
        }
        return null;
      },
    };
    return itinerary.legs.map((leg, i) => {
      if (i === 0) return null; // first leg has no connection to evaluate
      const prevLeg = itinerary.legs[i - 1];
      // Only compute for transit legs that follow another transit leg
      if (leg.mode === "WALK" || leg.mode === "BIKE" || leg.mode === "SCOOTER") return null;
      if (!prevLeg.tripId) return null;
      return computeConnectionStatus(prevLeg, leg, lookup, t);
    });
  }, [itinerary, rtUpdates, t]);

  if (phase === "idle" || !itinerary) return null;

  // Arrival and length as the card showed them: counted from the leave time.
  const span = display ? shownTripSpan(itinerary, display) : itinerary;
  const arrivalTime = new Date(span.arrivalTime);
  const formatTime = (d: Date) =>
    d.toLocaleTimeString(formattingLocale, {
      hour: "2-digit",
      minute: "2-digit",
      ...(feedTz ? { timeZone: feedTz } : {}),
    });

  return (
    <div
      ref={sheetRef}
      data-testid="guidance-step-list"
      data-sheet-height={height}
      {...sheetProps}
      role="region"
      aria-live="polite"
      aria-label={t("guidance.navigation_steps", "Navigation steps")}
      className={`bg-surface-raised rounded-t-2xl shadow-2 overflow-hidden flex flex-col transition-[max-height] duration-300`}
    >
      {/* Grab area: swipe up/down or tap the handle and header to resize */}
      <div {...grabProps} data-testid="sheet-grab-area" className="cursor-pointer select-none">
      <div className="flex justify-center pt-3 pb-2">
        <div className="w-10 h-1 rounded-full bg-sheet-handle" />
      </div>

      {/* Header */}
      <div className="flex items-center justify-between border-b border-divider" style={{ padding: "var(--variant-row-pad)" }}>
        <div className="flex items-center gap-2">
          <span className="font-semibold text-fg" style={{ fontSize: "var(--variant-primary-text-size)" }}>
            {t("guidance.arrive_by", "Arrive")} <span data-countdown>{formatTime(arrivalTime)}</span>
          </span>
          <span data-countdown className="text-fg-muted" style={{ fontSize: "var(--variant-meta-text-size)" }}>
            {Math.round(span.durationSeconds / 60)} {t("time.min", "min")}
          </span>
          {/* One tz indicator in the guidance header — nothing for a local verified user. */}
          <TzIndicator />
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-full hover:bg-surface-overlay"
          aria-label={t("guidance.stop_navigation", "Stop navigation")}
        >
          <Icon name="close" className="text-fg-muted" />
        </button>
      </div>
      </div>

      {/* Timebar */}
      <div className="px-4 py-2 flex flex-col gap-1.5">
        {display && !hideBufferChrome && (
          <LeaveHint
            bufferSeconds={display.bufferSeconds}
            leadingWaitSeconds={display.leadingWaitSeconds}
            recommendedDepartureMs={display.recommendedDepartureMs}
            feedTz={feedTz}
            catchStatus={display.catchStatus}
            nextDepartureInMin={nextDepartureInMin}
          />
        )}
        <Timebar
          itinerary={itinerary}
          progress={overallProgress}
          segments={display?.segments}
          // Aligned with the BufferWaitSegment emission threshold (>=60s) so the
          // bar isn't hidden from AT below 60s where LeaveHint may not render either.
          ariaHidden={display ? !hideBufferChrome && display.bufferSeconds >= 60 : false}
        />
        {display && !hideBufferChrome && showBanner && (
          <LeadingWaitBanner
            firstTransitDepMs={display.firstTransitDepartureMs}
            referenceNowMs={referenceNowMs}
            recommendedDepartureMs={display.recommendedDepartureMs}
            feedTz={feedTz}
          />
        )}
      </div>

      {/* Leg list */}
      <div
        ref={legListRef}
        className="overflow-y-auto flex-1 py-1 px-2 space-y-0.5"
        onKeyDown={handleLegListKeyDown}
      >
        {(display?.legs ?? itinerary.legs).map((leg, i) => (
          <LegRow
            key={i}
            leg={leg}
            status={legStatuses[i] ?? "future"}
            walkingProgress={i === currentLegIndex ? walkingProgress : null}
            transitProgress={i === currentLegIndex ? transitProgress : null}
            connectionStatus={connectionStatuses[i] ?? null}
            serviceAlerts={legAlerts[i]}
            onTap={() => onLegTap(i)}
          />
        ))}
      </div>
    </div>
  );
}
