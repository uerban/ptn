import { memo, useCallback, useMemo } from "react";
import type { Itinerary, Leg } from "@pt/shared";
import { useTranslation } from "../../i18n/index.ts";
import { pluralize } from "../../i18n/plurals.ts";
import { computeEcoScore } from "../../utils/ecoScore.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { getBadgeSize } from "../../utils/appearance.ts";
import { LineBadge } from "./shared/LineBadge.tsx";
import { LiveLegBadge } from "./shared/LiveBadge.tsx";
import { ItineraryBar } from "./shared/ItineraryBar.tsx";
import { TransferRiskBadge } from "./shared/TransferRiskBadge.tsx";
import { LeaveHint } from "./shared/LeaveHint.tsx";
import { BoardingLine } from "./shared/BoardingLine.tsx";
import { LeadingWaitBanner, shouldShowLeadingWaitBanner } from "./shared/LeadingWaitBanner.tsx";
import { RtWarningBanner } from "./shared/RtWarningBanner.tsx";
import { ServiceAlertTripNotes } from "../ServiceAlerts/ServiceAlertTripNotes.tsx";
import { TzIndicator } from "./shared/TzIndicator.tsx";
import { formatTime, toMinutes } from "./shared/format.ts";
import {
  peakDelayMinutes,
  rideSeconds,
  transferRisk,
  type Segment,
} from "./shared/legHelpers.ts";
import { deriveItineraryDisplay, shownTripSpan } from "./shared/itineraryDisplay.ts";
import { useFirstRideLive } from "../../hooks/useLiveRt.ts";
import { itineraryAriaLabel } from "./shared/itineraryAriaLabel.ts";
import { useNextDepartureInMin } from "../../hooks/useNextDepartureAfter.ts";

interface Props {
  itineraries: Itinerary[];
  onSelect: (it: Itinerary) => void;
  referenceNowMs: number;
  bufferSeconds: number;
  /** `selectRunSpeedRatio`: set while run-to-catch is on, for the catch advice. */
  runSpeedRatio?: number;
  /** Feed/agency tz (IANA); when set, time labels render in the feed tz. */
  feedTz?: string;
}

/**
 * Variant A — "Clean consumer" (Citymapper-style).
 * Each card emphasizes the time-proportional timeline bar and a legible
 * leg row with route badges, headsigns, and transfer/walking meta.
 */
export function RouteResultsConsumer({
  itineraries,
  onSelect,
  referenceNowMs,
  bufferSeconds,
  runSpeedRatio,
  feedTz,
}: Props) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2.5 px-3 pb-3">
      {/* One tz indicator per surface — renders nothing for a local verified user. */}
      <div className="flex justify-end leading-none">
        <TzIndicator />
      </div>
      {/* `role="list"` is not redundant: Tailwind preflight sets
          `list-style: none`, and WebKit strips list semantics from an
          unstyled-marker list — which is what left VoiceOver announcing this
          surface as an empty list. */}
      <ul role="list" aria-label={t("search.results", "Route results")} className="flex flex-col gap-2.5">
        {itineraries.map((it, i) => (
          <li key={i} className="flex flex-col gap-1">
            {/* Cancelled outranks unreliable timing: it is the stronger
                claim and already implies the times cannot be trusted, so
                an itinerary raising both shows one banner, not two. */}
            {it.cancelled === true ? (
              <RtWarningBanner reason="cancelled" />
            ) : (
              it.timingUnreliable === true && <RtWarningBanner reason="unreliable" />
            )}
            <ServiceAlertTripNotes itinerary={it} />
            <ConsumerCard
              it={it}
              fastest={i === 0}
              onSelect={onSelect}
              referenceNowMs={referenceNowMs}
              bufferSeconds={bufferSeconds}
              runSpeedRatio={runSpeedRatio}
              feedTz={feedTz}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

interface ConsumerCardProps {
  it: Itinerary;
  /** Index-0 card; surfaced in the accessible name only (no consumer chrome). */
  fastest: boolean;
  onSelect: (it: Itinerary) => void;
  referenceNowMs: number;
  bufferSeconds: number;
  /** `selectRunSpeedRatio`: set while run-to-catch is on, for the catch advice. */
  runSpeedRatio?: number;
  feedTz?: string;
}

const ConsumerCard = memo(function ConsumerCard({
  it,
  fastest,
  onSelect,
  referenceNowMs,
  bufferSeconds,
  runSpeedRatio,
  feedTz,
}: ConsumerCardProps) {
  const { t, locale, formattingLocale } = useTranslation();
  // useCallback isn't load-bearing here — handleClick is attached to a native
  // <button>, which doesn't compare onClick by reference. Kept for defensive
  // identity-stability if this handler is ever passed to a memoized child.
  const handleClick = useCallback(() => onSelect(it), [onSelect, it]);
  // Live RT for the first ride (the list keeps its route polled).
  const live = useFirstRideLive(it);
  const display = useMemo(
    () =>
      deriveItineraryDisplay(it, {
        referenceNowMs,
        bufferSeconds,
        runSpeedRatio,
        firstDepartureShiftSeconds: live.shiftSeconds,
        firstRideCancelled: live.cancelled,
        firstRideRemoved: live.removed,
      }),
    [it, referenceNowMs, bufferSeconds, runSpeedRatio, live.shiftSeconds, live.cancelled, live.removed],
  );
  // The header counts from the leave time — see shownTripSpan.
  const span = shownTripSpan(it, display);
  const nextDepartureInMin = useNextDepartureInMin(it, display, referenceNowMs);
  const duration = toMinutes(span.durationSeconds);
  const onBoard = toMinutes(rideSeconds(it));
  const risk = useMemo(() => transferRisk(display.segments), [display.segments]);
  const liveDelay = peakDelayMinutes(it);
  const eco = useMemo(() => computeEcoScore(it.legs), [it.legs]);

  const hideBufferChrome = display.parseFailed || display.alreadyDeparted;
  const showBanner = shouldShowLeadingWaitBanner({
    leadingWaitSeconds: display.leadingWaitSeconds,
    bufferSeconds: display.bufferSeconds,
    missRisk: risk === "miss",
    hasLiveDelay: liveDelay.minutes >= 2,
  });

  // One author-supplied name for the whole card — see itineraryAriaLabel for
  // why name-from-content is the wrong shape here.
  const ariaLabel = itineraryAriaLabel(it, display, {
    t,
    locale,
    formattingLocale,
    referenceNowMs,
    feedTz,
    fastest,
    nextDepartureInMin,
  });

  return (
    <button
      data-testid="itinerary-card"
      aria-label={ariaLabel}
      onClick={handleClick}
      className="w-full text-left rounded-2xl bg-surface-raised border border-divider
        hover:border-accent transition-colors p-3.5 flex flex-col gap-2"
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-sm font-semibold text-fg tabular-nums">
          {formatTime(span.departureTime, formattingLocale, feedTz)} →{" "}
          {formatTime(span.arrivalTime, formattingLocale, feedTz)}
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-semibold text-fg tabular-nums">
            {duration} {t("time.min", "min")}
          </div>
          {onBoard > 0 && onBoard !== duration && (
            <div className="text-[10px] text-fg-muted tabular-nums mt-0.5">
              {t("route.on_vehicle", "on vehicle")} {onBoard}{" "}
              {t("time.min", "min")}
            </div>
          )}
        </div>
      </div>

      <ItineraryBar
        itinerary={it}
        segments={display.segments}
        height={10}
        // Hide bar from AT only when the parallel LeaveHint is actually rendering —
        // its threshold is bufferSeconds >= 30s rounded to 1+ min, but BufferWaitSegment
        // is only spliced into the bar at >= 60s. Below 60s the bar carries no extra
        // info, but LeaveHint may also be absent — gate on the segment threshold so
        // we never hide the bar without a textual replacement in the AT path.
        ariaHidden={!hideBufferChrome && display.bufferSeconds >= 60}
      />

      {!hideBufferChrome && (
        <LeaveHint
          bufferSeconds={display.bufferSeconds}
          leadingWaitSeconds={display.leadingWaitSeconds}
          recommendedDepartureMs={display.recommendedDepartureMs}
          feedTz={feedTz}
          catchStatus={display.catchStatus}
          nextDepartureInMin={nextDepartureInMin}
        />
      )}

      <BoardingLine segments={display.segments} />

      <div className="flex items-center gap-1 flex-wrap">
        {renderLegChipsWithWaits(display.segments, t)}
      </div>

      {/* Live delay callout when a route is running late */}
      {liveDelay.minutes >= 2 && risk !== "miss" && (
        <div className="flex items-center gap-2 rounded-lg bg-warning/10 text-warning px-2.5 py-1.5 text-[11px] leading-snug">
          <span aria-hidden>⚠</span>
          <span>
            {t("route.live_update_line", "Live:")}{" "}
            <b className="text-fg">{liveDelay.line ?? ""}</b>{" "}
            {t("route.running_late", "is running +{min} min").replace(
              "{min}",
              String(liveDelay.minutes),
            )}
          </span>
        </div>
      )}

      {/* Miss-risk callout — stronger */}
      {risk === "miss" && (
        <div className="flex items-start gap-2 rounded-lg bg-danger/10 text-danger px-2.5 py-1.5 text-[11px] leading-snug border border-danger/30">
          <span aria-hidden>⚠</span>
          <span>
            {t(
              "route.may_miss",
              "Live delay may cause you to miss a transfer.",
            )}
          </span>
        </div>
      )}

      {/* Leading-wait banner — informational, suppressed by miss-risk / live-delay */}
      {!hideBufferChrome && showBanner && (
        <LeadingWaitBanner
          firstTransitDepMs={display.firstTransitDepartureMs}
          referenceNowMs={referenceNowMs}
          recommendedDepartureMs={display.recommendedDepartureMs}
          feedTz={feedTz}
        />
      )}

      <div className="flex items-center gap-3 text-[11px] text-fg-muted tabular-nums">
        <span>
          {it.transfers}{" "}
          {pluralize(
            locale,
            it.transfers,
            t("route.transfer_one", "transfer"),
            t("route.transfer_few", "transfers"),
            t("route.transfer_many", "transfers"),
          )}
        </span>
        {it.walkingDistanceMeters > 0 && (
          <span>
            {t("unit.meters", "{n} m").replace(
              "{n}",
              String(Math.round(it.walkingDistanceMeters)),
            )}{" "}
            {t("route.walk", "walk")}
          </span>
        )}
        {risk && (
          <span className="ml-auto">
            <TransferRiskBadge kind={risk} compact />
          </span>
        )}
      </div>

      {eco.savingsPercent > 0 && (
        <div
          data-testid="eco-score"
          className="flex items-center gap-1 text-[10px] text-success"
        >
          <span aria-hidden>{"🌿"}</span>
          <span>
            {t(
              "route.eco_savings",
              "{percent}% less CO₂ than driving",
            ).replace("{percent}", String(eco.savingsPercent))}
          </span>
        </div>
      )}
    </button>
  );
});

/**
 * Build the chip row from segments, skipping buffer-wait (rendered in the bar
 * + LeaveHint) and tight transfer waits (already styled in the bar + flagged
 * by the existing miss-risk callout — adding a chip would triple-announce).
 * For each non-tight WaitSegment between rides, emit a "Nm wait" chip.
 * For each ride/walk leg, emit the existing LegChip.
 */
function renderLegChipsWithWaits(
  segments: Segment[],
  t: ReturnType<typeof useTranslation>["t"],
) {
  const chips: React.ReactNode[] = [];
  let chipIdx = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.kind === "buffer-wait") continue;
    if (s.kind === "wait" && s.tight) continue;
    if (chips.length > 0) {
      chips.push(
        <span
          key={`chev-${i}`}
          data-testid="leg-chevron"
          className="text-fg-muted text-xs mx-0.5"
          aria-hidden
        >
          ›
        </span>,
      );
    }
    if (s.kind === "wait") {
      chips.push(
        <span
          key={`wait-${i}`}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-surface-overlay text-fg-muted"
        >
          ⏱{" "}
          {t("route.transfer_wait_chip", "{n}m wait").replace(
            "{n}",
            String(s.minutes),
          )}
        </span>,
      );
    } else {
      // ride or walk — render the existing LegChip
      chips.push(<LegChip key={`leg-${chipIdx++}`} leg={s.leg} />);
    }
  }
  return chips;
}

function LegChip({ leg }: { leg: Leg }) {
  const { t } = useTranslation();
  const badgeSize = useSettingsStore((s) => getBadgeSize(s.routeSearchVariant));
  const isWalk = leg.mode === "WALK";
  if (isWalk) {
    const min = toMinutes(leg.durationSeconds);
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-surface-overlay text-fg-muted">
        <LineBadge mode="WALK" size="sm" />
        <span>
          {min} {t("time.min", "min")}
        </span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <LineBadge
        mode={leg.mode}
        label={leg.routeShortName}
        routeColor={leg.routeColor}
        size="sm"
      />
      {leg.headsign && (
        <span
          className="text-xs text-fg-muted truncate max-w-[120px]"
          title={leg.headsign}
        >
          › {leg.headsign}
        </span>
      )}
      <LiveLegBadge leg={leg} compact size={badgeSize} />
    </span>
  );
}
