import type { RouteDirectionPattern } from "@pt/shared";
import { serviceDayFrame } from "./serviceDayFrame.ts";
import { findStopIdxInRoute } from "./util/directionPatternIdx.ts";

/** Mon-first (0=Mon..6=Sun) weekday of a YYYYMMDD integer. */
function monFirst(ymd: number): number {
  const y = Math.floor(ymd / 10000), m = Math.floor((ymd % 10000) / 100), d = ymd % 100;
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return js === 0 ? 6 : js - 1;
}

// Single source of truth for the freshness window — kept here as a const
// so the dashboard's RT overlay and rtOverlay's leg-shift overlay agree.
// If this needs to change in either place, change it here.
export const NEXT_DEPARTURE_FRESHNESS_WINDOW_MS = 120_000;

const SECS_PER_DAY = 86_400;

export interface RaptorIndexRouteLite {
  id: string;
  shortName: string;
  stopIds: string[];
  // Carried so return-only stops on bidirectional routes are reachable
  // via `findStopIdxInRoute`. Absent on routes without per-direction
  // sequences — the helper's canonical fast path still resolves those.
  directionPatterns?: RouteDirectionPattern[];
  // NOTE: `RaptorIndexLite` is a deliberate subset of the real `RaptorIndex`
  // in `services/raptorIndex.ts`. It lifts only the fields needed for
  // next-departure-at-stop computation. When adding a field to
  // `RaptorIndexRoute` / `Trip` / `Service`, mirror it here only if the
  // next-departure logic must read it; otherwise leave it off and the
  // adapter in `Home.tsx` will continue to drop it.
  trips: Array<{
    tripId: string;
    serviceId: string;
    // Per-trip headsign — matches the real RaptorIndex shape. Returned in
    // `NextDeparture.headsign` so a multi-headsign route (return trips,
    // vias) shows the headsign of the *winning* trip rather than a
    // single representative.
    headsign: string;
    departureSecs: number[];
    // PTB trip index — the key into `frequenciesByTrip`. Absent on the
    // legacy Dexie-table path (no frequencies there either).
    ptbTripIdx?: number;
  }>;
}

/** Structural subset of `raptorIndex.ts`'s `FrequencyWindow` — only what the
 *  next-departure computation reads. The real type (with `tripIdx`) assigns
 *  fine. GTFS reference:
 *  https://gtfs.org/documentation/schedule/reference/#frequenciestxt */
export interface FrequencyWindowLite {
  startSecs: number;
  endSecs: number;
  headwaySecs: number;
  exactTimes: 0 | 1;
}

export interface RaptorIndexServiceLite {
  serviceId: string;
  days: boolean[];
  startDate: string;
  endDate: string;
  // GTFS exception_type: 1 = service added on date, 2 = service removed.
  // Other values are illegal per spec; we defensively fall through (and
  // dev-warn) — see `isServiceActive` below.
  exceptions: Record<string, number>;
}

export interface RaptorIndexLite {
  routes: RaptorIndexRouteLite[];
  routeIdToIdx: Map<string, number>;
  routesAtStop: Map<string, number[]>;
  services: Map<string, RaptorIndexServiceLite>;
  /**
   * PATTERN-EXACT source (mirrors `RaptorIndex.patterns`): one entry per
   * trip-pattern, `id` = the bare GTFS route_id (repeated across a route's
   * patterns), `stopIds` = the pattern's OWN stop sequence, and each trip's
   * `departureSecs` aligned to that sequence — so the departure time at a
   * stop is readable EXACTLY, including at reverse-direction sibling stops
   * the canonical display sequence never covers. Absent when PatternMode is
   * Off — the factory then falls back to the canonical+positional
   * approximation (see `isApproximate`).
   */
  patterns?: RaptorIndexRouteLite[];
  /** stop_id → indices into `patterns`. Absent when PatternMode is Off. */
  patternsAtStop?: Map<string, number[]>;
  /** PTB trip idx → frequency service windows (GTFS `frequencies.txt`). */
  frequenciesByTrip?: Map<number, FrequencyWindowLite[]>;
}

export interface RtStoreLite {
  getTripDelay: (
    tripId: string,
  ) => { delaySeconds: number; cancelled: boolean; deleted?: boolean } | null;
  getReceivedAt: (tripId: string) => number | null;
}

export interface NextDeparture {
  minutesUntil: number;
  /** The departure itself, epoch ms, RT delay included — to the second, where minutesUntil floors. */
  departureMs: number;
  routeShortName: string;
  headsign: string;
  // True when the displayed time is an estimate rather than an exact
  // schedule read: either the stop was resolved via a direction pattern on
  // the LEGACY path (per-stop departure column unknown → positional
  // approximation off the trip's earliest entry), or the winning departure
  // comes from a headway-based frequency window (`exact_times=0` — no fixed
  // schedule exists). Surfaced to the UI as a `~` prefix on the chip.
  isApproximate: boolean;
}

function isServiceActive(
  service: RaptorIndexServiceLite,
  dateKey: string,
  dayOfWeek: number,
): boolean {
  const exception = service.exceptions[dateKey];
  if (exception === 1) return true;
  if (exception === 2) return false;
  // Defensive: any non-1/non-2 exception (data corruption, unknown vendor
  // extension, NaN from a buggy parser) falls through to the calendar
  // check. Surface in dev so feed bugs don't hide.
  if (
    exception !== undefined &&
    typeof process !== "undefined" &&
    process.env?.NODE_ENV !== "production"
  ) {
    console.warn(
      `[nextDeparture] unknown exception_type for service=${service.serviceId} on ${dateKey}: ${exception}`,
    );
  }
  if (dateKey < service.startDate || dateKey > service.endDate) return false;
  return service.days[dayOfWeek] === true;
}

/** First non-sentinel departure of a trip — the frequency template's anchor
 *  (tolerant of covering-merge folded members whose leading columns are
 *  `-1`). Mirrors `hasUpcomingDeparture.ts`. */
function firstServedDeparture(departureSecs: readonly number[]): number | undefined {
  for (const d of departureSecs) if (typeof d === "number" && d !== -1) return d;
  return undefined;
}

/**
 * Earliest concrete departure `>= targetSecs` a frequency-based trip
 * produces at the stop column sitting `offset` seconds past the trip's
 * first served stop. Departures run `start+offset, start+offset+headway, …`
 * up to `end+offset` (inclusive end, matching `hasUpcomingDeparture.ts`'s
 * interval convention — one-headway slack at the trailing edge, never too
 * restrictive). `exact` is false for `exact_times=0` windows (headway-based
 * service — the value is an estimate, not a schedule):
 * https://gtfs.org/documentation/schedule/reference/#frequenciestxt
 */
function nextFreqDeparture(
  windows: readonly FrequencyWindowLite[],
  offset: number,
  targetSecs: number,
): { secs: number; exact: boolean } | null {
  let bestSecs = Infinity;
  let bestExact = false;
  for (const win of windows) {
    if (win.headwaySecs <= 0) continue; // defensive: malformed feed row
    const base = win.startSecs + offset;
    const last = win.endSecs + offset;
    const cand =
      targetSecs <= base
        ? base
        : base + Math.ceil((targetSecs - base) / win.headwaySecs) * win.headwaySecs;
    if (cand > last) continue;
    if (cand < bestSecs) {
      bestSecs = cand;
      bestExact = win.exactTimes === 1;
    }
  }
  return bestSecs === Infinity ? null : { secs: bestSecs, exact: bestExact };
}


/**
 * Curried factory: bind `raptorIndex` + `rtStore` once and pass a single
 * `(routeId, stopId) => NextDeparture | null` function down to the
 * dashboard hook. The caller's `useMemo` is what stabilises the
 * reference across renders; this factory makes that ergonomic.
 *
 * Clock model: a single `now: () => number` returning **wall-clock Unix
 * epoch milliseconds** (default `Date.now`). Inside the factory we
 * derive both the `Date` (for service-day calendar / `dateKey` /
 * `dayOfWeek`) and the midnight-relative `nowSecs` from that one
 * source. This avoids a class of bugs where a caller passes a
 * midnight-relative ms count (~ 8.6e7) as the clock and `new Date(...)`
 * interprets it as Unix epoch (Jan 1 1970), so every service appears
 * out of date range.
 *
 * Cross-midnight handling: GTFS encodes a service-day's late trips with
 * `departureSecs >= 86400`. When called early in the day (before
 * 05:00), we additionally consult yesterday's services with their
 * `departureSecs` shifted forward by the yesterday shift (86400 s, or the
 * DST-adjusted origin difference) so an overnight
 * route's tail (e.g. dep=88800 = 24:40) is reachable from the
 * day-after's perspective. Mirrors `hasUpcomingDeparture.ts`'s
 * convention.
 *
 * Feed-tz "now": `dateKey` + `nowSecs` are read in the GTFS service-day frame
 * of the FEED's timezone (see serviceDayFrame), so they match `departureSecs`
 * on DST dates too and a cross-tz device lands on the city's service day. When
 * `feedTz` is absent the device zone is used. Either way the calendar `dayOfWeek`
 * is derived **Mon-first** from `dateKey` to match the `days[]` layout — the
 * factory historically passed the JS `getDay()` (Sun=0) unconverted, reading
 * the wrong weekday slot ([R-fold #6]).
 */
export function makeGetNextDeparture(
  raptorIndex: RaptorIndexLite,
  rtStore: RtStoreLite,
  now: () => number = () => Date.now(),
  feedTz?: string,
): (routeId: string, stopId: string) => NextDeparture | null {
  return (routeId, stopId) => {
    const idx = raptorIndex.routeIdToIdx.get(routeId);
    if (idx === undefined) return null;
    const route = raptorIndex.routes[idx];
    if (!route) return null;

    const nowMs = now();
    // "now" in the GTFS service-day frame of its civil date, the frame the
    // departures are stored in (`departureSecs` is since service-day origin,
    // which is local noon minus 12 h, not local midnight, on DST dates).
    const frame = serviceDayFrame(Math.floor(nowMs / 1000), feedTz);
    const dateKey = frame.todayYmd;
    const nowSecs = frame.nowSecs;
    // [R-fold #6] Mon-first to match the days[] layout (was the buggy getDay()).
    const dayOfWeek = monFirst(Number(dateKey));
    // Yesterday's overnight tails are only reachable early in the day —
    // cap at 5 hours past midnight (mirrors the legacy path below).
    const yesterdayKey = nowSecs < 5 * 3600 ? frame.yesterdayYmd : null;
    const yesterdayDay = (dayOfWeek + 6) % 7;

    let earliestSecs = Infinity;
    let earliestTripId: string | null = null;
    let earliestHeadsign = "";
    let earliestIsApproximate = false;
    // A cancelled or deleted trip is not a departure. Skipped whatever the
    // report's age: a cancellation does not go stale the way a delay estimate
    // does, and a caller asking for "the bus after the one I'll miss" sets the
    // clock well past the report.
    const isCancelled = (tripId: string) => {
      const rt = rtStore.getTripDelay(tripId);
      return rt?.cancelled === true || rt?.deleted === true;
    };
    const consider = (
      secs: number,
      trip: { tripId: string; headsign: string },
      approx: boolean,
    ) => {
      if (isCancelled(trip.tripId)) return;
      if (secs < earliestSecs) {
        earliestSecs = secs;
        earliestTripId = trip.tripId;
        earliestHeadsign = trip.headsign;
        earliestIsApproximate = approx;
      }
    };

    // ── PATTERN-EXACT PATH (production per-pattern wire) ──────────────
    // Each pattern's trips store `departureSecs` aligned to the pattern's
    // OWN stop sequence, so the departure at `stopId` is readable EXACTLY —
    // including at reverse-direction sibling stops. Loop and lasso patterns
    // revisit a stop within one trip, so EVERY occurrence of `stopId` in
    // the sequence is checked, not just the first:
    // https://gtfs.org/documentation/schedule/schedule-best-practices/#loop-routes
    // https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
    // Coverage is checked per ROUTE, not just per stop: on a stale
    // per-route wire a reverse-only stop can sit in `patternsAtStop` via
    // ANOTHER route's pattern while this route's patterns (canonical
    // sequences only) miss it — that case must degrade to the legacy
    // positional fallback below, not read as "no upcoming departure".
    const { patterns, patternsAtStop, frequenciesByTrip } = raptorIndex;
    let patternCovered = false;
    if (patterns && patternsAtStop) {
      const patternIdxs = patternsAtStop.get(stopId);
      if (patternIdxs) {
        for (const patternIdx of patternIdxs) {
          const pattern = patterns[patternIdx];
          if (!pattern || pattern.id !== routeId) continue;
          patternCovered = true;
          for (let col = 0; col < pattern.stopIds.length; col++) {
            if (pattern.stopIds[col] !== stopId) continue; // every occurrence (loop/lasso)
            for (const trip of pattern.trips) {
              const service = raptorIndex.services.get(trip.serviceId);
              if (!service) continue;
              const onToday = isServiceActive(service, dateKey, dayOfWeek);
              const onYesterday =
                yesterdayKey !== null && isServiceActive(service, yesterdayKey, yesterdayDay);
              if (!onToday && !onYesterday) continue;
              const dep = trip.departureSecs[col];
              // `-1` is the per-pattern wire's unserved sentinel (covering-
              // merge folded members) — not a departure.
              if (typeof dep !== "number" || dep < 0) continue;
              const windows =
                trip.ptbTripIdx !== undefined
                  ? frequenciesByTrip?.get(trip.ptbTripIdx)
                  : undefined;
              if (windows && windows.length > 0) {
                // Frequency-based trip: concrete departures come from the
                // service windows, NOT the template clock times — the
                // template only defines the offset of this column past the
                // trip's first served stop.
                const first = firstServedDeparture(trip.departureSecs);
                if (first === undefined) continue;
                const offset = dep - first;
                if (onToday) {
                  const cand = nextFreqDeparture(windows, offset, nowSecs);
                  if (cand) consider(cand.secs, trip, !cand.exact);
                }
                if (onYesterday) {
                  // Yesterday's windows shifted a day forward; the candidate
                  // is >= nowSecs + yesterdayShiftSecs by construction.
                  const cand = nextFreqDeparture(windows, offset, nowSecs + frame.yesterdayShiftSecs);
                  if (cand) consider(cand.secs - frame.yesterdayShiftSecs, trip, !cand.exact);
                }
              } else {
                if (onToday && dep >= nowSecs) consider(dep, trip, false);
                // Only trips that genuinely cross midnight (dep >= 86400)
                // matter from yesterday's perspective; their effective
                // "now-relative" time is `dep - yesterdayShiftSecs`.
                if (onYesterday && dep >= SECS_PER_DAY) {
                  const todayRelative = dep - frame.yesterdayShiftSecs;
                  if (todayRelative >= nowSecs) consider(todayRelative, trip, false);
                }
              }
            }
          }
        }
      }
    }
    if (patternCovered) {
      // Exact answer — an empty result means "provably no upcoming
      // departure", never "fall back to the positional approximation".
      return finishDeparture(
        earliestSecs,
        earliestTripId,
        earliestHeadsign,
        earliestIsApproximate,
        route.shortName,
        nowMs,
        nowSecs,
        rtStore,
      );
    }

    // ── LEGACY PATH (PatternMode.Off indexes; stops the patterns don't
    // cover, e.g. a stale per-route wire's reverse-only stops) ─────────
    const { idx: stopIdx, pattern } = findStopIdxInRoute(route, stopId);
    if (stopIdx < 0) return null;
    // When the canonical sequence missed and a directionPattern hit, the
    // per-stop `trip.departureSecs[stopIdx]` is not aligned to the
    // pattern's sequence — the trip's `departureSecs` array indexes the
    // canonical `stopIds`. Fall back to the trip's earliest entry as a
    // positional approximation; mirrors `hasUpcomingDeparture.ts`'s
    // visibility-over-accuracy policy and is flagged via `isApproximate`.
    const isApproximate = pattern !== null;

    // Mirror `hasUpcomingDeparture.ts`: when the stop only exists on a
    // direction pattern, restrict the trip scan to trips whose headsign
    // matches a pattern that actually contains this stop. Without this
    // filter, an outbound trip's `departureSecs[0]` could win the
    // earliest-departure race at a return-only stop, surfacing the wrong
    // line/direction.
    const matchingHeadsigns = isApproximate
      ? new Set(
          (route.directionPatterns ?? [])
            .filter((dp) => dp.stopIds.includes(stopId))
            .map((dp) => dp.headsign),
        )
      : null;

    // Today's services.
    for (const trip of route.trips) {
      if (isCancelled(trip.tripId)) continue;
      const service = raptorIndex.services.get(trip.serviceId);
      if (!service || !isServiceActive(service, dateKey, dayOfWeek)) continue;
      if (matchingHeadsigns && !matchingHeadsigns.has(trip.headsign)) continue;
      // Approximate path: `departureSecs` is canonical-column-aligned with
      // `-1` for unvisited stops. For return-direction trips on
      // bidirectional routes the array is NOT in travel order, so
      // `departureSecs[0]` is whichever canonical column happens to be the
      // outbound's first stop — often `-1` (skipped) or the trip's latest
      // time. Scan every column and pick the smallest in-future entry as a
      // positional approximation. Mirrors `hasUpcomingDeparture.ts`'s
      // full-array scan at return-only stops.
      let dep: number | undefined;
      if (isApproximate) {
        let earliestForTrip = Infinity;
        for (const d of trip.departureSecs) {
          if (typeof d !== "number" || d < 0) continue;
          if (d < nowSecs) continue;
          if (d < earliestForTrip) earliestForTrip = d;
        }
        if (earliestForTrip === Infinity) continue;
        dep = earliestForTrip;
      } else {
        dep = trip.departureSecs[stopIdx];
        if (typeof dep !== "number") continue;
        if (dep < nowSecs) continue;
      }
      if (dep < earliestSecs) {
        earliestSecs = dep;
        earliestTripId = trip.tripId;
        earliestHeadsign = trip.headsign;
      }
    }

    // Yesterday's overnight tails — only relevant when we're early enough
    // in the day that yesterday's late trips could still be running
    // (`yesterdayKey` is non-null only before the 5-hour cap; it is the
    // previous civil day via pure YYYYMMDD arithmetic — DST-safe, uniform
    // with hasUpcomingDeparture and serviceDayFrame).
    if (yesterdayKey !== null) {
      for (const trip of route.trips) {
        if (isCancelled(trip.tripId)) continue;
        const service = raptorIndex.services.get(trip.serviceId);
        if (!service) continue;
        if (!isServiceActive(service, yesterdayKey, yesterdayDay)) continue;
        if (matchingHeadsigns && !matchingHeadsigns.has(trip.headsign)) continue;
        // For the approximate path, `departureSecs` is canonical-column-
        // aligned (not travel-order) and may contain `-1` for unvisited
        // columns. Scan every entry and pick the smallest post-midnight
        // value as the most-optimistic positional estimate. We can't
        // shortcut on first-match like the old logic did — return trips
        // on bidirectional routes have `departureSecs` reversed/mixed
        // relative to travel order, so the first array entry >= a day
        // is not necessarily the smallest.
        let dep: number | undefined;
        if (isApproximate) {
          let earliestForTrip = Infinity;
          for (const d of trip.departureSecs) {
            if (typeof d !== "number") continue;
            if (d < SECS_PER_DAY) continue;
            if (d < earliestForTrip) earliestForTrip = d;
          }
          if (earliestForTrip === Infinity) continue;
          dep = earliestForTrip;
        } else {
          dep = trip.departureSecs[stopIdx];
          if (typeof dep !== "number") continue;
          // Only trips that genuinely cross midnight (dep >= SECS_PER_DAY)
          // matter today; their effective "now-relative" time is
          // `dep - SECS_PER_DAY`.
          if (dep < SECS_PER_DAY) continue;
        }
        const todayRelative = dep - SECS_PER_DAY;
        if (todayRelative < nowSecs) continue;
        if (todayRelative < earliestSecs) {
          earliestSecs = todayRelative;
          earliestTripId = trip.tripId;
          earliestHeadsign = trip.headsign;
        }
      }
    }

    return finishDeparture(
      earliestSecs,
      earliestTripId,
      earliestHeadsign,
      isApproximate,
      route.shortName,
      nowMs,
      nowSecs,
      rtStore,
    );
  };
}

/** Shared tail of both paths: apply a fresh RT delay to the winning trip and
 *  shape the result. */
function finishDeparture(
  earliestSecs: number,
  earliestTripId: string | null,
  headsign: string,
  isApproximate: boolean,
  routeShortName: string,
  nowMs: number,
  nowSecs: number,
  rtStore: RtStoreLite,
): NextDeparture | null {
  if (earliestTripId === null) return null;

  let scheduledSecs = earliestSecs;
  const delay = rtStore.getTripDelay(earliestTripId);
  const receivedAt = rtStore.getReceivedAt(earliestTripId);
  // RT delay applied when:
  //  - delay exists, AND
  //  - either receivedAt is unknown (backwards-compat: missing stamp
  //    is treated as fresh, matching rtOverlay's policy), OR
  //  - receivedAt is fresh (within the freshness window).
  // `nowMs` is wall-clock epoch and `receivedAt` is wall-clock epoch
  // (stamped by rtStore via Date.now()), so the comparison is
  // dimensionally correct.
  if (delay) {
    const fresh =
      receivedAt === null ||
      nowMs - receivedAt < NEXT_DEPARTURE_FRESHNESS_WINDOW_MS;
    if (fresh) scheduledSecs += delay.delaySeconds;
  }

  const minutesUntil = Math.max(0, Math.floor((scheduledSecs - nowSecs) / 60));
  return {
    minutesUntil,
    departureMs: nowMs + (scheduledSecs - nowSecs) * 1000,
    routeShortName,
    headsign,
    isApproximate,
  };
}
