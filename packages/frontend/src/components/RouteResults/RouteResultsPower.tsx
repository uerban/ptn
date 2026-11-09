import { memo, useCallback, useMemo } from "react";
import type { Itinerary } from "@pt/shared";
import { useTranslation } from "../../i18n/index.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { getBadgeSize } from "../../utils/appearance.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useColorConfigStore } from "../../stores/colorConfigStore.ts";
import { resolveRouteColor } from "../../utils/routeColor.ts";
import { LineBadge } from "./shared/LineBadge.tsx";
import { LiveLegBadge } from "./shared/LiveBadge.tsx";
import { ItineraryBar } from "./shared/ItineraryBar.tsx";
import { TransferRiskBadge } from "./shared/TransferRiskBadge.tsx";
import { TzIndicator } from "./shared/TzIndicator.tsx";
import { BoardingLine } from "./shared/BoardingLine.tsx";
import { formatTime, toMinutes } from "./shared/format.ts";
import {
  deriveItineraryDisplay,
  shownTripSpan,
} from "./shared/itineraryDisplay.ts";
import { itineraryAriaLabel } from "./shared/itineraryAriaLabel.ts";
import { LeaveHint } from "./shared/LeaveHint.tsx";
import {
  peakDelayMinutes,
  rideSeconds,
  transferRisk,
  type Segment,
} from "./shared/legHelpers.ts";
import { useFirstRideLive } from "../../hooks/useLiveRt.ts";
import { useNextDepartureInMin } from "../../hooks/useNextDepartureAfter.ts";
import { RtWarningBanner } from "./shared/RtWarningBanner.tsx";
import { ServiceAlertTripNotes } from "../ServiceAlerts/ServiceAlertTripNotes.tsx";

const EMPTY_OVERRIDES = {};

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
 * Variant B — "Dense power-user". Grid-aligned rows with a monospace feel:
 * DEP → ARR · legs strip · TOTAL. Left-edge mode stripe keyed to the first
 * transit leg. Live delay banner at the top when any route is affected.
 */
export function RouteResultsPower({
  itineraries,
  onSelect,
  referenceNowMs,
  bufferSeconds,
  runSpeedRatio,
  feedTz,
}: Props) {
  const { t } = useTranslation();

  // Find the biggest realtime delay across results for the top banner
  const delays = itineraries
    .map((it) => peakDelayMinutes(it))
    .filter((d) => d.minutes >= 2)
    .sort((a, b) => b.minutes - a.minutes);
  const topDelay = delays[0];

  return (
    <div className="font-mono">
      {topDelay && (
        <div
          role="status"
          className="flex items-center gap-2 px-3.5 py-2 text-[11px] bg-warning/10 text-warning border-b border-divider"
        >
          <span aria-hidden>⚠</span>
          <span className="flex-1">
            {t("route.live_prefix", "Live:")}{" "}
            {t("route.line", "line")}{" "}
            <b className="text-fg">{topDelay.line ?? ""}</b>{" "}
            {t("route.running_late_short", "running +{min} min").replace(
              "{min}",
              String(topDelay.minutes),
            )}
          </span>
        </div>
      )}

      {/* Column legend */}
      <div
        className="grid items-center px-3.5 py-1.5 text-[9px] text-fg-muted tracking-widest border-b border-divider"
        style={{ gridTemplateColumns: "70px 1fr 60px" }}
      >
        <span>
          {t("route.col_dep_arr", "DEP → ARR")}
          {/* One tz indicator per surface — nothing for a local verified user. */}
          <TzIndicator />
        </span>
        <span>{t("route.col_legs", "LEGS")}</span>
        <span className="text-right">{t("route.col_total", "TOTAL")}</span>
      </div>

      {/* `role="list"` is not redundant: Tailwind preflight sets
          `list-style: none`, and WebKit strips list semantics from an
          unstyled-marker list — which is what left VoiceOver announcing this
          surface as an empty list. */}
      <ul role="list" aria-label={t("search.results", "Route results")}>
        {itineraries.map((it, i) => (
          <li key={i} className="flex flex-col">
            {/* Cancelled outranks unreliable timing, as on the consumer layout. */}
            {it.cancelled === true ? (
              <RtWarningBanner reason="cancelled" />
            ) : (
              it.timingUnreliable === true && <RtWarningBanner reason="unreliable" />
            )}
            <ServiceAlertTripNotes itinerary={it} />
            <PowerCard
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

interface PowerCardProps {
  it: Itinerary;
  fastest: boolean;
  onSelect: (it: Itinerary) => void;
  referenceNowMs: number;
  bufferSeconds: number;
  /** `selectRunSpeedRatio`: set while run-to-catch is on, for the catch advice. */
  runSpeedRatio?: number;
  feedTz?: string;
}

const PowerCard = memo(function PowerCard({
  it,
  fastest,
  onSelect,
  referenceNowMs,
  bufferSeconds,
  runSpeedRatio,
  feedTz,
}: PowerCardProps) {
  const { t, locale, formattingLocale } = useTranslation();
  const cityId = useCityStore((s) => s.activeCity.id);
  const modeOverrides =
    useSettingsStore((s) => s.modeColorOverrides[cityId]) ?? EMPTY_OVERRIDES;
  const scheme = useSettingsStore((s) => s.accessibilityScheme);
  const theme = useSettingsStore((s) => s.resolvedTheme);
  const highContrastEnabled = useSettingsStore((s) => s.highContrastEnabled);
  const colorConfig = useColorConfigStore((s) => s.config);

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

  const handleClick = useCallback(() => {
    onSelect(it);
  }, [onSelect, it]);

  const firstTransit = it.legs.find((l) => l.mode !== "WALK");
  const stripeColor = firstTransit
    ? resolveRouteColor(
        firstTransit.routeColor,
        firstTransit.mode,
        modeOverrides,
        scheme,
        theme,
        undefined,
        highContrastEnabled,
        colorConfig,
      )
    : "var(--color-divider)";
  const risk = transferRisk(display.segments);
  const delay = peakDelayMinutes(it);
  // The header counts from the leave time — see shownTripSpan.
  const span = shownTripSpan(it, display);
  const nextDepartureInMin = useNextDepartureInMin(it, display, referenceNowMs);
  const duration = toMinutes(span.durationSeconds);
  const onBoard = toMinutes(rideSeconds(it));

  const leadingMin = Math.round(display.leadingWaitSeconds / 60);
  const leaveTime = formatTime(
    new Date(display.recommendedDepartureMs).toISOString(),
    formattingLocale,
    feedTz,
  );
  const showLeadingToken =
    !display.parseFailed &&
    !display.alreadyDeparted &&
    display.leadingWaitSeconds > 0;
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
      className={`w-full text-left grid items-start gap-2 px-3.5 py-3 text-xs border-b border-divider
        ${fastest ? "bg-accent/5" : "hover:bg-surface-overlay"}`}
      style={{
        gridTemplateColumns: "70px 1fr 60px",
        borderLeft: `3px solid ${stripeColor}`,
      }}
    >
      <div>
        <div className="text-sm font-bold tabular-nums -tracking-tight">
          {formatTime(span.departureTime, formattingLocale, feedTz)}
        </div>
        <div className="text-[10px] text-fg-muted tabular-nums">
          → {formatTime(span.arrivalTime, formattingLocale, feedTz)}
        </div>
        {fastest && (
          <div className="mt-1 text-[9px] tracking-widest text-accent font-bold">
            ★ {t("route.fastest_label", "FASTEST")}
          </div>
        )}
        {risk && (
          <div className="mt-1">
            <TransferRiskBadge kind={risk} compact />
          </div>
        )}
      </div>

      <div className="min-w-0 space-y-1.5">
        <BoardingLine
          segments={display.segments}
          className="text-[10px] text-fg-muted"
        />
        <LegStrip
          segments={display.segments}
          leadingMin={leadingMin}
          leaveTime={leaveTime}
          showLeadingToken={showLeadingToken}
        />
        {/* Power keeps the buffer to the leave token above; only a catch
            problem earns a line of its own. */}
        {!hideBufferChrome && display.catchStatus && display.catchStatus !== "on-time" && (
          <LeaveHint
            bufferSeconds={display.bufferSeconds}
            leadingWaitSeconds={display.leadingWaitSeconds}
            recommendedDepartureMs={display.recommendedDepartureMs}
            feedTz={feedTz}
            catchStatus={display.catchStatus}
            nextDepartureInMin={nextDepartureInMin}
          />
        )}
        <ItineraryBar
          itinerary={it}
          segments={display.segments}
          height={6}
          // Aligned with the BufferWaitSegment emission threshold (>=60s) so we
          // never hide the bar from AT when no replacement is in the tree.
          ariaHidden={!hideBufferChrome && display.bufferSeconds >= 60}
        />
        <div className="flex items-center gap-2.5 flex-wrap text-[10px] text-fg-muted tabular-nums">
          {onBoard > 0 && (
            <span>
              {t("route.ride_short", "ride")}{" "}
              {t("unit.minutes_compact", "{n}m").replace("{n}", String(onBoard))}
            </span>
          )}
          {it.walkingDistanceMeters > 0 && (
            <span>
              {t("route.walk_short", "walk")}{" "}
              {t("unit.meters_compact", "{n}m").replace(
                "{n}",
                String(Math.round(it.walkingDistanceMeters)),
              )}
            </span>
          )}
          <span>
            {it.transfers} {t("route.tr_short", "tr")}
          </span>
          {delay.minutes >= 2 && risk !== "miss" && (
            <span className="text-warning font-bold">
              ⚠ {delay.line ?? ""} +
              {t("unit.minutes_compact", "{n}m").replace(
                "{n}",
                String(delay.minutes),
              )}
            </span>
          )}
          {risk === "miss" && (
            <span className="text-danger font-bold">
              ⚠ {t("route.may_miss_short", "may miss transfer")}
            </span>
          )}
        </div>
      </div>

      <div className="text-right">
        <div className="text-lg font-bold tabular-nums -tracking-tight leading-none">
          {duration}
        </div>
        <div className="text-[9px] text-fg-muted tracking-widest uppercase">
          {t("time.min", "min")}
        </div>
      </div>
    </button>
  );
});

interface LegStripProps {
  segments: Segment[];
  leadingMin: number;
  leaveTime: string;
  showLeadingToken: boolean;
}

function LegStrip({
  segments,
  leadingMin,
  leaveTime,
  showLeadingToken,
}: LegStripProps) {
  const { t } = useTranslation();
  const badgeSize = useSettingsStore((s) => getBadgeSize(s.routeSearchVariant));
  const nodes: React.ReactNode[] = [];
  let firstRideEmitted = false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.kind === "ride") {
      if (!firstRideEmitted && showLeadingToken) {
        nodes.push(
          <span
            key={`lead-${i}`}
            className="text-[10px] text-fg tabular-nums mr-1"
            aria-label={t(
              "route.power_leading_wait_token_aria",
              "{n} minute leading wait, leave at {time}",
            )
              .replace("{n}", String(leadingMin))
              .replace("{time}", leaveTime)}
          >
            {t("route.power_leading_wait_token", "{n}m · leave {time}")
              .replace("{n}", String(leadingMin))
              .replace("{time}", leaveTime)}
          </span>,
        );
      }
      firstRideEmitted = true;
      nodes.push(
        <span key={i} className="inline-flex items-center gap-1">
          <LineBadge
            mode={seg.leg.mode}
            label={seg.leg.routeShortName}
            routeColor={seg.leg.routeColor}
            size="sm"
          />
          <span className="text-[10px] text-fg-muted tabular-nums">
            <span className="opacity-50" aria-hidden>
              ▸
            </span>
            {t("unit.minutes_compact", "{n}m").replace("{n}", String(seg.minutes))}
          </span>
          <LiveLegBadge leg={seg.leg} compact size={badgeSize} />
        </span>,
      );
      continue;
    }
    if (seg.kind === "walk") {
      if (seg.transferWalk) {
        nodes.push(
          <span
            key={i}
            className="inline-flex items-center gap-1 px-1.5 py-px rounded border border-divider text-[10px] text-fg-muted tabular-nums"
            title={t("route.bar_transfer_walk_title", "Transfer walk · {n} min · {m} m")
              .replace("{n}", String(seg.minutes))
              .replace("{m}", String(seg.meters))}
          >
            <span aria-hidden>↝</span>
            {t("unit.minutes_compact", "{n}m").replace("{n}", String(seg.minutes))}
            {" · "}
            {t("unit.meters_compact", "{n}m").replace("{n}", String(seg.meters))}
          </span>,
        );
      } else {
        nodes.push(
          <span
            key={i}
            className="inline-flex items-center gap-0.5 text-[10px] text-fg-muted tabular-nums"
            title={t("route.walk", "walk")}
          >
            <span aria-hidden>🚶</span>
            {t("unit.minutes_compact", "{n}m").replace("{n}", String(seg.minutes))}
          </span>,
        );
      }
      continue;
    }
    if (seg.kind === "buffer-wait") {
      // Pre-stop buffer is rendered in the bar; LegStrip skips it.
      continue;
    }
    // wait
    const tokenLabel = t("route.power_transfer_wait_token", "{n}m").replace(
      "{n}",
      String(seg.minutes),
    );
    nodes.push(
      <span
        key={i}
        className={`inline-flex items-center gap-0.5 px-1.5 py-px rounded text-[10px] tabular-nums font-bold
          ${seg.tight ? "text-danger border border-danger/60 bg-danger/10" : "text-fg-muted bg-surface-overlay"}`}
        aria-label={t(
          "route.power_transfer_wait_token_aria",
          "{n} minute transfer wait",
        ).replace("{n}", String(seg.minutes))}
        title={
          seg.sameStop
            ? t("route.power_wait_title_same_stop", "wait {n} min (same stop)").replace(
                "{n}",
                String(seg.minutes),
              )
            : t("route.power_wait_title", "wait {n} min").replace(
                "{n}",
                String(seg.minutes),
              )
        }
      >
        <span aria-hidden>◷</span>
        {tokenLabel}
      </span>,
    );
  }
  return <div className="flex items-center gap-1 flex-wrap">{nodes}</div>;
}
