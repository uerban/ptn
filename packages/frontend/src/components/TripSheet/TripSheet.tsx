import { Fragment, useMemo, useState } from "react";
import type { Departure, StopWithLines } from "@pt/shared";
import { COUNTDOWN_INTERVAL_MS, POPUP_DEPARTED_CUTOFF_MINUTES } from "@pt/shared/constants";
import { BottomSheet } from "../Layout/BottomSheet.tsx";
import { DepartureLineBadge } from "../DepartureLineBadge.tsx";
import { LiveBadge } from "../RouteResults/shared/LiveBadge.tsx";
import { formatTime } from "../RouteResults/shared/format.ts";
import { Icon } from "../Icon.tsx";
import { useTranslation } from "../../i18n/index.ts";
import { fill } from "../../i18n/fill.ts";
import { pluralize } from "../../i18n/plurals.ts";
import { minutesUntil } from "../../hooks/useCountdown.ts";
import { useServerNow } from "../../hooks/useServerNow.ts";
import { useRetainRoutes } from "../../hooks/useLiveRt.ts";
import { useTripDelay } from "../../stores/rtStore.ts";
import { useGtfsDataStore } from "../../stores/gtfsDataStore.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { getBadgeSize } from "../../utils/appearance.ts";
import {
  buildTripTimeline,
  estimateVehicle,
  type TripTimeline,
  type VehicleEstimate,
} from "../../services/tripTimeline.ts";

/** How often the vehicle estimate is recomputed. */
export const TRIP_SHEET_TICK_MS = 15_000;

const NO_NAMES = new Map<string, string>();

interface TripSheetProps {
  /** The departure the rider tapped (a pill's). */
  departure: Departure;
  /** The stop it leaves from: where the rider boards. */
  stop: StopWithLines;
  onClose: () => void;
  /** "All departures here": the boarding stop's departure sheet. */
  onAllDepartures: () => void;
  /** "Show on map": the line on the map. */
  onShowOnMap: () => void;
}

/**
 * The delay the tapped departure carried from its own feed (the stop's
 * `rt-tile`, or the departures response): `delaySeconds`, else the gap
 * between its predicted and scheduled times. `undefined` = timetable only.
 */
function departureDelaySeconds(d: Departure): number | undefined {
  if (typeof d.delaySeconds === "number" && Number.isFinite(d.delaySeconds)) return d.delaySeconds;
  if (!d.predictedTime) return undefined;
  const gapMs = Date.parse(d.predictedTime) - Date.parse(d.scheduledTime);
  return Number.isFinite(gapMs) ? gapMs / 1000 : undefined;
}

/**
 * One trip as boarded at `stop`: the header (line, headsign, stop, countdown,
 * live status), the trip's stops with their times, and where its vehicle
 * probably is.
 *
 * The vehicle row is an ESTIMATE, never a position: the timetable
 * (`buildTripTimeline`) shifted by the trip's delay (`estimateVehicle`),
 * recomputed every 15 s. No vehicle feed is read, and the sheet never says
 * otherwise. The delay is the live one from `rtStore` when it holds the trip,
 * else the one the departure carried; the source label says "live delay"
 * whenever either is known.
 *
 * While open, the trip's route is held for live data (`useRetainRoutes`, a
 * counted hold). The poller resolves live departures on every poll, so
 * without them the hold makes no `/rt/<routeId>` call; the tile read skips the
 * rt-tile then too, so the pill carries no delay and the sheet reads the
 * timetable alone.
 * A cancelled trip gets a neutral banner, a DELETED one a neutral "no longer
 * scheduled" banner (the `useFirstRideLive` split); neither shows an estimate.
 *
 * Without a timeline (no `patterns` in the index — `PatternMode.Off`, the
 * Dexie fallback — or a trip the index does not hold) only the header and
 * the actions are shown.
 */
export function TripSheet({ departure, stop, onClose, onAllDepartures, onShowOnMap }: TripSheetProps) {
  const { t, locale, formattingLocale } = useTranslation();
  const raptorIndex = useGtfsDataStore((s) => s.raptorIndex);
  const stopNames = useGtfsDataStore((s) => s.stopNames);
  const tz = useCityStore((s) => s.activeCity.tz);
  const badgeSize = useSettingsStore((s) => getBadgeSize(s.routeSearchVariant));
  const [showEarlier, setShowEarlier] = useState(false);

  useRetainRoutes([departure.routeId]);
  const live = useTripDelay(departure.tripId);
  // One server-synced clock at two paces: the countdown's every second, the
  // estimate's every 15 s (so the countdown's re-render does not move it).
  const countdownNow = useServerNow(COUNTDOWN_INTERVAL_MS);
  const estimateNow = useServerNow(TRIP_SHEET_TICK_MS);

  const timeline = useMemo(
    () =>
      buildTripTimeline(raptorIndex, {
        tripId: departure.tripId,
        stopId: stop.id,
        scheduledTime: departure.scheduledTime,
        tz,
        stopNames: stopNames ?? NO_NAMES,
      }),
    [raptorIndex, departure.tripId, stop.id, departure.scheduledTime, tz, stopNames],
  );

  const removed = live?.deleted === true;
  const cancelled = live?.cancelled === true || departure.cancelled === true;
  const delaySeconds = live ? live.delaySeconds : departureDelaySeconds(departure);
  const shiftMs = (delaySeconds ?? 0) * 1000;

  const estimate = useMemo(
    () => (timeline && !cancelled && !removed ? estimateVehicle(timeline, new Date(estimateNow), delaySeconds) : null),
    [timeline, cancelled, removed, estimateNow, delaySeconds],
  );

  // NaN (an unparseable scheduled time) shows no countdown.
  const minutes = minutesUntil(Date.parse(departure.scheduledTime) + shiftMs, countdownNow);
  const countdown =
    Number.isNaN(minutes) || minutes < POPUP_DEPARTED_CUTOFF_MINUTES
      ? null
      : minutes <= 0
        ? t("popup.due", "Due")
        : `${minutes} ${t("time.min", "min")}`;

  const clock = (instant: Date) => formatTime(instant.toISOString(), formattingLocale, tz);

  // With the earlier stops folded away, a vehicle between the stop before the
  // boarding stop and the boarding stop has no row of its own to follow: its
  // dot goes just above the boarding stop.
  const approachingFolded =
    timeline !== null &&
    !showEarlier &&
    estimate?.kind === "between" &&
    estimate.fromIndex < timeline.boardingIndex &&
    timeline.boardingIndex <= estimate.toIndex;

  return (
    <BottomSheet
      onClose={onClose}
      ariaLabel={fill(t("trip.sheet_aria", "Line {line} toward {headsign}"), {
        line: departure.routeShortName,
        headsign: departure.headsign,
      })}
      height="half"
      data-testid="trip-sheet"
      className="bg-surface-raised rounded-t-2xl shadow-2 max-h-[50vh] overflow-hidden flex flex-col"
    >
      <div
        data-testid="trip-header"
        className="flex items-start justify-between gap-2 px-4 pt-3 pb-2 border-b border-divider"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <DepartureLineBadge
              data-testid="route-badge"
              label={departure.routeShortName}
              mode={departure.mode}
              subMode={departure.subMode}
              routeColor={departure.routeColor}
              className="inline-flex items-center justify-center rounded font-bold shrink-0 tabular-nums h-7 min-w-[1.75rem] px-2 text-xs"
            />
            <h2 className="text-lg font-semibold text-fg truncate">{departure.headsign}</h2>
          </div>
          <div className="mt-1 flex items-center gap-2 min-w-0 text-sm text-fg-secondary">
            <span data-testid="trip-boarding-stop" className="truncate">{stop.name}</span>
            {countdown && (
              <span data-testid="trip-countdown" data-countdown className="shrink-0 font-semibold text-fg tabular-nums">
                {countdown}
              </span>
            )}
            {!cancelled && !removed && <LiveBadge delaySeconds={delaySeconds} compact size={badgeSize} />}
          </div>
        </div>
        <button
          type="button"
          data-testid="trip-close"
          data-sheet-close
          onClick={onClose}
          aria-label={t("trip.close", "Close")}
          className="shrink-0 p-2 rounded-full hover:bg-surface-overlay"
        >
          <Icon name="close" className="text-fg-muted" />
        </button>
      </div>

      {(cancelled || removed) && (
        <div data-testid="trip-banner" className="mx-4 mt-2 rounded-lg bg-surface-overlay px-3 py-2 text-sm text-fg">
          {/* DELETED is not to be shown as cancelled. */}
          {removed
            ? t("trip.removed", "This trip is no longer scheduled")
            : t("trip.cancelled", "This trip is cancelled")}
        </div>
      )}

      {timeline && (
        <div className="overflow-y-auto flex-1 px-4 py-2">
          {estimate && (
            <div className="mb-2">
              <p data-testid="trip-vehicle" className="text-sm font-medium text-fg">
                {vehicleText(estimate, timeline, t, clock)}
              </p>
              <p data-testid="trip-source" className="text-xs text-fg-muted">
                {delaySeconds !== undefined
                  ? t("trip.estimated_live", "Estimated from timetable + live delay")
                  : t("trip.estimated_schedule", "Estimated from timetable")}
              </p>
            </div>
          )}
          {timeline.boardingIndex > 0 && (
            <button
              type="button"
              aria-expanded={showEarlier}
              onClick={() => setShowEarlier((v) => !v)}
              className="py-1 text-xs font-medium text-accent"
            >
              {fill(
                pluralize(
                  locale,
                  timeline.boardingIndex,
                  t("trip.earlier_stops_one", "{count} earlier stop"),
                  t("trip.earlier_stops_few", "{count} earlier stops"),
                  t("trip.earlier_stops_many", "{count} earlier stops"),
                ),
                { count: String(timeline.boardingIndex) },
              )}
            </button>
          )}
          <ol data-testid="trip-stops" className="flex flex-col">
            {timeline.stops.map((s, i) => {
              if (!showEarlier && i < timeline.boardingIndex) return null;
              const boarding = i === timeline.boardingIndex;
              const vehicleHere = estimate?.kind === "at_stop" && estimate.index === i;
              return (
                <Fragment key={`${s.stopId}:${i}`}>
                  {boarding && approachingFolded && <VehicleBetween />}
                  <li
                    data-testid="trip-stop"
                    data-stop-id={s.stopId}
                    aria-current={boarding ? "location" : undefined}
                    className={`flex items-center gap-3 px-2 py-1 rounded text-sm ${
                      boarding
                        ? "bg-accent/10 font-semibold text-fg"
                        : i < timeline.boardingIndex
                          ? "text-fg-muted"
                          : "text-fg"
                    }`}
                  >
                    <span className="w-14 shrink-0 tabular-nums text-xs">
                      {clock(new Date(s.scheduled.getTime() + shiftMs))}
                    </span>
                    <span className="truncate">{s.name}</span>
                    {vehicleHere && <VehicleDot />}
                  </li>
                  {estimate?.kind === "between" && estimate.fromIndex === i && <VehicleBetween />}
                </Fragment>
              );
            })}
          </ol>
        </div>
      )}

      <div className="flex gap-2 px-4 py-2 border-t border-divider">
        <button
          type="button"
          onClick={onAllDepartures}
          className="flex-1 rounded-lg bg-surface-overlay px-3 py-2 text-sm font-medium text-fg hover:bg-divider"
        >
          {t("trip.all_departures", "All departures here")}
        </button>
        <button
          type="button"
          onClick={onShowOnMap}
          className="flex-1 rounded-lg bg-surface-overlay px-3 py-2 text-sm font-medium text-fg hover:bg-divider"
        >
          {t("trip.show_on_map", "Show on map")}
        </button>
      </div>
    </BottomSheet>
  );
}

/** Where the vehicle probably is, in words. */
function vehicleText(
  estimate: VehicleEstimate,
  timeline: TripTimeline,
  t: (key: string, fallback?: string) => string,
  clock: (instant: Date) => string,
): string {
  const name = (i: number) => timeline.stops[i].name;
  switch (estimate.kind) {
    case "not_started":
      return fill(t("trip.not_started", "Not started — leaves {stop} at {time}"), {
        stop: name(0),
        time: clock(estimate.departs),
      });
    case "between":
      return fill(t("trip.probably_between", "Probably between {from} and {to}"), {
        from: name(estimate.fromIndex),
        to: name(estimate.toIndex),
      });
    case "at_stop":
      return fill(t("trip.at_stop", "Probably at {stop}"), { stop: name(estimate.index) });
    case "finished":
      return t("trip.finished", "Trip probably ended");
  }
}

/** The estimated vehicle between two listed stops, as a row of its own. */
function VehicleBetween() {
  return (
    <li aria-hidden data-testid="trip-vehicle-between" className="flex items-center px-2 py-0.5">
      <span className="w-14 shrink-0" />
      <VehicleDot />
    </li>
  );
}

/** The estimated vehicle in the stop list; the vehicle row says it in words. */
function VehicleDot() {
  return (
    <span
      aria-hidden
      data-testid="trip-vehicle-marker"
      className="inline-block w-2 h-2 shrink-0 rounded-full bg-accent"
    />
  );
}
