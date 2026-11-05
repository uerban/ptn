import { unixToGtfsSecs, unixToServiceDate } from "@pt/shared/time";
import type { RaptorIndex } from "./raptorIndex.ts";

/**
 * The stops of one trip with their scheduled times, for the trip sheet opened
 * from a departure pill.
 *
 * Built from `RaptorIndex.patterns` only: a pattern's trips carry
 * `departureSecs` aligned to that pattern's own `stopIds` (`-1` = no time at
 * the position, e.g. a trip folded into a longer pattern under
 * `PatternMode.CoveringMerge` that does not serve it). The canonical `routes`
 * view re-aligns trips to one stop sequence per route and is lossy for
 * return-direction stops, so it is never read here.
 *
 * Known gap: GTFS lets a feed leave the times of a non-timepoint stop blank
 * (`timepoint=0`) for the consumer to interpolate
 * (https://gtfs.org/documentation/schedule/reference/#stop_timestxt). The
 * bundle marks a row without a departure time the same way as a position the
 * trip does not serve, and nothing interpolates it on the device, so such a
 * stop is left out of the timeline and the vehicle estimate runs straight
 * past it.
 */

const SECS_PER_DAY = 86_400;

export interface TimelineStop {
  stopId: string;
  /** From `stopNames`; the stop id when the name is unknown. */
  name: string;
  scheduled: Date;
}

export interface TripTimeline {
  /** The stops the trip has a time at, in trip order (positions without one omitted, see the module note). */
  stops: TimelineStop[];
  /** Index into `stops` of the stop the rider boards at. */
  boardingIndex: number;
}

export interface TripTimelineArgs {
  tripId: string;
  /** The boarding stop (the pill's stop). */
  stopId: string;
  /** The departure's scheduled instant at `stopId` (ISO 8601). */
  scheduledTime: string;
  /** City IANA zone, used only to pick a lasso trip's boarding occurrence. */
  tz: string;
  stopNames: Map<string, string>;
}

/**
 * Timeline of `args.tripId` as boarded at `args.stopId`.
 *
 * Every time is RELATIVE to the boarding stop:
 * `time(i) = scheduledTime + (departureSecs[i] − departureSecs[boarding])`.
 * GTFS `stop_times` are seconds from the service day's local midnight and may
 * exceed 24:00:00 for trips running past midnight
 * (https://gtfs.org/documentation/schedule/reference/#stop_timestxt); the
 * difference of two of them is a plain duration, so no service-date
 * arithmetic is needed and times past 24:00 need no special case. It also
 * holds when the departure is not the template run itself (schedule tiles
 * never expand `frequencies.txt`, so a frequency trip's departure carries its
 * template times; the offsets between its stops are the same either way).
 * Departure times only: a stop's dwell (`dwellSecs`) is ignored.
 *
 * Boarding occurrence: a lasso trip passes some stops twice within one
 * `trip_id` (https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes).
 * With one occurrence of `stopId` that one is used; with several, the one
 * whose `departureSecs % SECS_PER_DAY` equals the boarding instant's GTFS
 * `Time` in its city-zone service date (`unixToGtfsSecs`, never the device
 * zone or the wall clock, which is an hour off on a DST date); with no match (e.g. a frequency run away from its template, or an
 * instant inside a DST gap), the first occurrence.
 *
 * `null` when there is nothing to anchor on: no index or no `patterns`
 * (`PatternMode.Off`, the Dexie fallback index), the trip is in no pattern,
 * the trip never serves `stopId`, or `scheduledTime` does not parse.
 *
 * Linear in the index's trip count; callers memoise per departure.
 */
export function buildTripTimeline(
  index: Pick<RaptorIndex, "patterns"> | null | undefined,
  args: TripTimelineArgs,
): TripTimeline | null {
  const patterns = index?.patterns;
  if (!patterns) return null;
  const boardingMs = Date.parse(args.scheduledTime);
  if (Number.isNaN(boardingMs)) return null;

  for (const pattern of patterns) {
    const trip = pattern.trips.find((t) => t.tripId === args.tripId);
    if (!trip) continue;

    // Served positions only, in trip order.
    const served: { stopId: string; secs: number }[] = [];
    pattern.stopIds.forEach((stopId, pos) => {
      const secs = trip.departureSecs[pos];
      if (secs !== undefined && secs >= 0) served.push({ stopId, secs });
    });

    const occurrences: number[] = [];
    served.forEach((s, i) => {
      if (s.stopId === args.stopId) occurrences.push(i);
    });
    if (occurrences.length === 0) return null;

    let boardingIndex = occurrences[0];
    if (occurrences.length > 1) {
      const unix = Math.floor(boardingMs / 1000);
      const boardingGtfsSecs = unixToGtfsSecs(unix, unixToServiceDate(unix, args.tz), args.tz);
      boardingIndex = occurrences.find((i) => served[i].secs % SECS_PER_DAY === boardingGtfsSecs % SECS_PER_DAY) ?? boardingIndex;
    }

    const boardingSecs = served[boardingIndex].secs;
    return {
      stops: served.map((s) => ({
        stopId: s.stopId,
        name: args.stopNames.get(s.stopId) ?? s.stopId,
        scheduled: new Date(boardingMs + (s.secs - boardingSecs) * 1000),
      })),
      boardingIndex,
    };
  }
  return null;
}

/** A stop's (delayed) time within this many seconds of `now` reads as "at the stop". */
const AT_STOP_WINDOW_SECS = 30;

/** Where the trip's vehicle probably is. Indices point into `TripTimeline.stops`. */
export type VehicleEstimate =
  | { kind: "not_started"; firstStopId: string; departs: Date }
  | { kind: "between"; fromIndex: number; toIndex: number }
  | { kind: "at_stop"; index: number }
  | { kind: "finished" };

/**
 * Where the vehicle of `timeline` probably is at `now`: the timetable shifted
 * by the trip's delay. An estimate, never a position — no vehicle feed is read.
 *
 * Every stop's time moves by the same `delaySeconds` (negative = running
 * early; `undefined` or non-finite = the timetable alone). Departure times
 * only, dwell ignored, as in `buildTripTimeline`.
 *
 * - `at_stop` while `now` is within ±30 s (inclusive) of a stop's shifted
 *   time. Where two windows overlap the nearer stop wins, the stop just
 *   reached on an exact tie; so of stops sharing one time the first is read
 *   while approaching and the last once the time has passed.
 * - `not_started` before the first stop's window; `departs` is that stop's
 *   shifted time.
 * - `finished` after the last stop's window (also for a timeline with no stops).
 * - `between` otherwise: left `fromIndex`, not yet at `toIndex = fromIndex + 1`.
 */
export function estimateVehicle(
  timeline: TripTimeline,
  now: Date,
  delaySeconds: number | undefined,
): VehicleEstimate {
  const { stops } = timeline;
  if (stops.length === 0) return { kind: "finished" };
  const shiftMs = (delaySeconds !== undefined && Number.isFinite(delaySeconds) ? delaySeconds : 0) * 1000;
  const timeOf = (i: number) => stops[i].scheduled.getTime() + shiftMs;
  const nowMs = now.getTime();

  // The last stop whose shifted time is not after `now` (-1 = none yet).
  let reached = -1;
  while (reached + 1 < stops.length && timeOf(reached + 1) <= nowMs) reached++;
  const next = reached + 1;

  const sinceReached = reached >= 0 ? nowMs - timeOf(reached) : Infinity;
  const untilNext = next < stops.length ? timeOf(next) - nowMs : Infinity;
  if (Math.min(sinceReached, untilNext) <= AT_STOP_WINDOW_SECS * 1000) {
    return { kind: "at_stop", index: untilNext < sinceReached ? next : reached };
  }
  if (reached < 0) return { kind: "not_started", firstStopId: stops[0].stopId, departs: new Date(timeOf(0)) };
  if (next >= stops.length) return { kind: "finished" };
  return { kind: "between", fromIndex: reached, toIndex: next };
}
