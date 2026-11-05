import { memo, useCallback, useMemo } from "react";
import type { Itinerary, Leg } from "@pt/shared";
import { useTranslation } from "../../i18n/index.ts";
import { pluralize } from "../../i18n/plurals.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { getBadgeSize } from "../../utils/appearance.ts";
import { LineBadge } from "./shared/LineBadge.tsx";
import { LiveLegBadge } from "./shared/LiveBadge.tsx";
import { TransferRiskBadge } from "./shared/TransferRiskBadge.tsx";
import { LeaveHint } from "./shared/LeaveHint.tsx";
import { AccessibleWaitRow } from "./shared/AccessibleWaitRow.tsx";
import { BoardingLine } from "./shared/BoardingLine.tsx";
import { TzIndicator } from "./shared/TzIndicator.tsx";
import { formatTime, toMinutes } from "./shared/format.ts";
import {
  peakDelayMinutes,
  transferRisk,
  type Segment,
} from "./shared/legHelpers.ts";
import { deriveItineraryDisplay, shownTripSpan } from "./shared/itineraryDisplay.ts";
import { itineraryAriaLabel } from "./shared/itineraryAriaLabel.ts";
import { useFirstRideLive } from "../../hooks/useLiveRt.ts";
import { useNextDepartureInMin } from "../../hooks/useNextDepartureAfter.ts";
import { RtWarningBanner } from "./shared/RtWarningBanner.tsx";

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
 * Variant C — "Accessibility-forward". Each transit leg renders as its own
 * inset row with explicit "Off at <stop>" copy. Larger hit targets, larger
 * body text, prominent fastest indicator.
 */
export function RouteResultsAccessible({
  itineraries,
  onSelect,
  referenceNowMs,
  bufferSeconds,
  runSpeedRatio,
  feedTz,
}: Props) {
  const { t } = useTranslation();
  const mobility = useSettingsStore((s) => s.mobilityProfile);

  return (
    <div className="flex flex-col gap-3 px-3 pb-3">
      {/* One tz indicator per surface — renders nothing for a local verified user. */}
      <div className="flex justify-end leading-none">
        <TzIndicator />
      </div>
      {/* Each line says only what the profile does. Wheelchair and bicycle
          skip what the feed marks unusable; a stop or trip with no data
          stays in, so neither line may promise step-free or bike-friendly. */}
      {mobility !== "default" && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-xl bg-accent/10 text-accent px-3.5 py-3 text-sm"
        >
          <span aria-hidden className="text-lg">
            {mobility === "wheelchair" ? "♿" : mobility === "bicycle" ? "🚲" : "◐"}
          </span>
          <div className="flex-1">
            <div className="font-bold">
              {mobility === "wheelchair"
                ? t("route.profile_wheelchair_title", "Wheelchair profile")
                : mobility === "bicycle"
                ? t("route.profile_bicycle_title", "Bicycle profile")
                : t(
                    "route.profile_vision_title",
                    "Vision-impaired profile",
                  )}
            </div>
            <div className="text-xs opacity-80">
              {mobility === "wheelchair"
                ? t(
                    "route.profile_wheelchair_desc",
                    "Skips stops and vehicles marked not wheelchair accessible. Unmarked ones may still have steps.",
                  )
                : mobility === "bicycle"
                ? t(
                    "route.profile_bicycle_desc",
                    "Skips vehicles marked as not taking bicycles. Unmarked ones may not take them either.",
                  )
                : t(
                    "route.profile_vision_desc",
                    "Walking times use your walking speed, and Run to catch is off.",
                  )}
            </div>
          </div>
        </div>
      )}

      {/* `role="list"` is not redundant: Tailwind preflight sets
          `list-style: none`, and WebKit strips list semantics from an
          unstyled-marker list — which is what left VoiceOver announcing this
          surface as an empty list. */}
      <ul role="list" aria-label={t("search.results", "Route results")} className="flex flex-col gap-3">
        {itineraries.map((it, i) => (
          <li key={i} className="flex flex-col gap-1">
            {/* Cancelled outranks unreliable timing, as on the consumer layout. */}
            {it.cancelled === true ? (
              <RtWarningBanner reason="cancelled" />
            ) : (
              it.timingUnreliable === true && <RtWarningBanner reason="unreliable" />
            )}
            <AccessibleCard
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

interface AccessibleCardProps {
  it: Itinerary;
  fastest: boolean;
  onSelect: (it: Itinerary) => void;
  referenceNowMs: number;
  bufferSeconds: number;
  /** `selectRunSpeedRatio`: set while run-to-catch is on, for the catch advice. */
  runSpeedRatio?: number;
  feedTz?: string;
}

const AccessibleCard = memo(function AccessibleCard({
  it,
  fastest,
  onSelect,
  referenceNowMs,
  bufferSeconds,
  runSpeedRatio,
  feedTz,
}: AccessibleCardProps) {
  const { t, locale, formattingLocale } = useTranslation();
  const mobility = useSettingsStore((s) => s.mobilityProfile);
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
  const risk = useMemo(() => transferRisk(display.segments), [display.segments]);
  const liveDelay = peakDelayMinutes(it);
  const stepFree = mobility === "wheelchair";

  const hideBufferChrome = display.parseFailed || display.alreadyDeparted;

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
      className={`w-full text-left rounded-2xl bg-surface-raised p-4 flex flex-col gap-3
        border ${fastest ? "border-accent" : "border-divider"}
        hover:border-accent transition-colors`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {fastest && (
            <div className="text-[11px] font-bold tracking-widest text-accent mb-0.5">
              ★ {t("route.fastest_label", "FASTEST")}
              {stepFree
                ? ` · ${t("route.step_free", "STEP-FREE")}`
                : ""}
            </div>
          )}
          <div className="text-2xl font-bold tabular-nums -tracking-tight">
            {duration}{" "}
            <span className="text-sm text-fg-muted font-medium">
              {t("time.min", "min")}
            </span>
          </div>
          <div className="text-sm text-fg-secondary mt-1 tabular-nums">
            {formatTime(span.departureTime, formattingLocale, feedTz)} →{" "}
            {formatTime(span.arrivalTime, formattingLocale, feedTz)}
          </div>
        </div>
        <div className="text-right text-xs text-fg-muted tabular-nums">
          {risk && (
            <div className="mb-1">
              <TransferRiskBadge kind={risk} />
            </div>
          )}
          <div>
            {it.transfers} {t("route.transfer_short", "tr")} ·{" "}
            {t("unit.meters", "{n} m").replace(
              "{n}",
              String(Math.round(it.walkingDistanceMeters)),
            )}
          </div>
        </div>
      </div>

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

      <BoardingLine
        segments={display.segments}
        className="text-sm text-fg-secondary"
      />

      {/* Stop-by-stop transit leg rows + transfer/buffer wait rows */}
      {display.segments.length > 0 && (
        <div className="flex flex-col gap-2">
          {renderAccessibleSegmentRows(display.segments, hideBufferChrome)}
        </div>
      )}

      {risk === "miss" ? (
        <div className="flex items-start gap-3 rounded-xl bg-danger/10 text-danger border border-danger/30 px-3 py-2.5">
          <span aria-hidden className="text-lg">
            ⚠
          </span>
          <div className="flex-1 text-sm">
            <div className="font-bold">
              {t("route.live_late_title", "Live: running late")}
            </div>
            <div className="text-xs opacity-80 mt-0.5">
              {t(
                "route.may_miss_long",
                "Your transfer may not hold. Tap for detail.",
              )}
            </div>
          </div>
        </div>
      ) : liveDelay.minutes >= 2 ? (
        <div className="flex items-center gap-2.5 rounded-xl bg-warning/10 text-warning border border-warning/30 px-3 py-2 text-sm">
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
      ) : null}
    </button>
  );
});

/**
 * Render the per-segment list for the Accessible card. Walk segments are
 * intentionally hidden (the original code iterated `transitLegs(it)`, which
 * filtered out walks). Buffer waits and transfer waits each render an
 * `AccessibleWaitRow`; rides render an `AccessibleLegRow`.
 */
function renderAccessibleSegmentRows(
  segments: Segment[],
  hideBufferChrome: boolean,
): React.ReactNode[] {
  const rows: React.ReactNode[] = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    switch (s.kind) {
      case "buffer-wait": {
        if (!hideBufferChrome) {
          rows.push(
            <AccessibleWaitRow
              key={`buffer-${i}`}
              minutes={Math.round(s.seconds / 60)}
              stopName={s.atStopName}
            />,
          );
        }
        break;
      }
      case "wait": {
        rows.push(
          <AccessibleWaitRow
            key={`wait-${i}`}
            minutes={s.minutes}
            stopName={s.atStopName}
          />,
        );
        break;
      }
      case "ride": {
        rows.push(<AccessibleLegRow key={`ride-${i}`} leg={s.leg} />);
        break;
      }
      case "walk": {
        // Walk segments are not surfaced as their own row in the Accessible
        // card — kept consistent with the original behaviour, which iterated
        // `transitLegs(it)` (i.e., excluded walks).
        break;
      }
      default: {
        const _exhaustive: never = s;
        void _exhaustive;
        break;
      }
    }
  }
  return rows;
}

function AccessibleLegRow({ leg }: { leg: Leg }) {
  const { t, locale } = useTranslation();
  const badgeSize = useSettingsStore((s) => getBadgeSize(s.routeSearchVariant));
  // intermediateStops = count BETWEEN board and alight stops, exclusive.
  // Adding 1 gives "stops passed on board" in the everyday sense (includes
  // alight, excludes board) — which is what most transit UIs show.
  const stopCount =
    typeof leg.intermediateStops === "number"
      ? leg.intermediateStops + 1
      : null;
  return (
    <div className="flex items-center gap-3 rounded-xl bg-surface-overlay px-3 py-2.5 min-h-[3rem]">
      <LineBadge
        mode={leg.mode}
        label={leg.routeShortName}
        routeColor={leg.routeColor}
        size="md"
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold flex items-center gap-2 flex-wrap">
          <span>
            {t("route.off_at_long", "Off at")}{" "}
            <span className="text-fg">{leg.to.name}</span>
          </span>
          <LiveLegBadge leg={leg} compact size={badgeSize} />
        </div>
        <div className="text-xs text-fg-muted tabular-nums mt-0.5">
          {stopCount !== null && (
            <>
              {stopCount}{" "}
              {pluralize(
                locale,
                stopCount,
                t("route.stop_one", "stop"),
                t("route.stop_few", "stops"),
                t("route.stop_many", "stops"),
              )}{" "}
              ·{" "}
            </>
          )}
          {toMinutes(leg.durationSeconds)} {t("time.min", "min")}
        </div>
      </div>
    </div>
  );
}
