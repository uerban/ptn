import type { FrequencyWindow, RaptorIndex, RaptorIndexRoute } from "./raptorIndex.ts";
import { resolveActiveServicesForYmd } from "./serviceDay.ts";
import { serviceDayFrame } from "./serviceDayFrame.ts";

const SECS_PER_DAY = 86400;
// Frozen so a misbehaving caller can't `(x as Set).add()` and poison the
// shared empty-result sentinel for every future call.
const EMPTY_ROUTE_IDS: ReadonlySet<string> = Object.freeze(new Set<string>()) as ReadonlySet<string>;

/**
 * Everything the per-trip window checks need, resolved ONCE per call: "now"
 * on the feed's wall clock plus the service sets active today and (when the
 * window can still catch an overnight tail) yesterday.
 */
export interface ActivityWindow {
  nowSecs: number;
  windowEndSecs: number;
  activeToday: ReadonlySet<string>;
  activeYesterday: ReadonlySet<string> | null;
  /** Seconds that yesterday's GTFS frame is ahead of today's (see serviceDayFrame). */
  yesterdayShiftSecs: number;
}

/**
 * Resolve the activity window for `now`.
 *
 * Feed-tz "now": when `feedTz` is supplied, `now`'s wall-clock seconds and
 * service date are taken from the FEED's timezone (correct for a cross-tz
 * device — a foreign device near its own midnight would otherwise resolve
 * its own weekday/seconds and filter the wrong day's stops). When absent,
 * the legacy device-local derivation is used (a local user's device tz ==
 * feed tz, so the two agree).
 *
 * Cross-midnight handling: GTFS allows a trip's `departureSecs[i]` to
 * exceed 86400 when the trip continues past the service day's midnight.
 * When `now` is in the early hours we also consult yesterday's active
 * services and shift their departure times forward by a day.
 */
export function resolveActivityWindow(
  now: Date,
  lookaheadHours: number,
  raptorIndex: RaptorIndex,
  feedTz?: string,
): ActivityWindow {
  // Exported so per-frame/per-tick loops over MANY stops (useVisibleStops)
  // can resolve the window ONCE and thread it into activeRouteIdsAtStop /
  // stopMaybeActive — the window depends only on (now, lookaheadHours,
  // services, feedTz), never on the stop. Resolving per stop costs an Intl
  // formatToParts + a full services-map scan each: O(stops × services).
  // [R-fold v4 #9] Decompose `now` in the feed tz EXACTLY ONCE (the formatter
  // memo removes DTF construction but not the formatToParts call, so do not
  // call unixToServiceDay twice).
  // "now" is read in the GTFS service-day frame of its civil date, the same
  // frame `departureSecs` use (see serviceDayFrame). A wall-clock reading is an
  // hour off on a DST date.
  const frame = serviceDayFrame(Math.floor(now.getTime() / 1000), feedTz);
  const nowSecs = frame.nowSecs;
  const windowEndSecs = nowSecs + lookaheadHours * 3600;

  // Today's civil service date (feed-tz when known, else device-local), then
  // YESTERDAY via pure civil arithmetic (DST-safe — never a real-second subtract).
  // [R-fold v3 BLOCKING #1] On the morning after a spring-forward (a 23h civil
  // day) a `now.getTime() - 86400*1000` subtraction would skip a whole civil day
  // and miss the overnight tail this filter is meant to surface.
  const todayYmd = frame.todayYmd;
  const activeToday = resolveActiveServicesForYmd(raptorIndex.services, todayYmd);
  // Only resolve yesterday's services if the lookahead window is entirely
  // inside today — avoids an extra scan in the common midday case where
  // yesterday's overnight tail (dep >= 86400) can't possibly fire within
  // the window anyway.
  const needYesterday = nowSecs < SECS_PER_DAY && windowEndSecs > 0;
  const activeYesterday = needYesterday
    ? resolveActiveServicesForYmd(raptorIndex.services, frame.yesterdayYmd)
    : null;
  return { nowSecs, windowEndSecs, activeToday, activeYesterday, yesterdayShiftSecs: frame.yesterdayShiftSecs };
}

/** Is a concrete departure clock value inside the window, on today's service
 *  or (shifted a day forward) on yesterday's overnight tail? `-1` is the
 *  per-pattern wire's unserved sentinel; `undefined` is the sparse legacy
 *  shape — neither is a departure. */
function depInWindow(
  dep: number | undefined,
  w: ActivityWindow,
  onToday: boolean,
  onYesterday: boolean,
): boolean {
  if (dep === undefined || dep === -1) return false;
  if (onToday && dep >= w.nowSecs && dep <= w.windowEndSecs) return true;
  return onYesterday && dep >= w.nowSecs + w.yesterdayShiftSecs && dep <= w.windowEndSecs + w.yesterdayShiftSecs;
}

/** First non-sentinel departure of a trip — the frequency template's anchor
 *  (`frequencyBoard`'s `templateFirstDepartureSecs`, tolerant of folded
 *  members whose leading columns are `-1`). */
function firstServedDeparture(departureSecs: readonly number[]): number | undefined {
  for (const d of departureSecs) if (d !== undefined && d !== -1) return d;
  return undefined;
}

/** Last non-sentinel departure of a trip (see {@link firstServedDeparture}). */
function lastServedDeparture(departureSecs: readonly number[]): number | undefined {
  for (let i = departureSecs.length - 1; i >= 0; i--) {
    const d = departureSecs[i];
    if (d !== undefined && d !== -1) return d;
  }
  return undefined;
}

/**
 * Do a frequency-based trip's service windows produce a departure inside the
 * activity window anywhere in the offset span `[loOffset, hiOffset]` past the
 * trip's first stop? Checked as an interval intersection —
 * `[start+loOffset, end+hiOffset] ∩ [now, now+lookahead]` — which is exact up
 * to one headway at the trailing edge (never too restrictive). Yesterday's
 * windows are shifted a day forward, mirroring `depInWindow`. A single stop
 * column passes `loOffset === hiOffset`; the legacy any-stop fallback passes
 * the whole trip's span.
 */
function freqActiveInOffsetSpan(
  windows: readonly FrequencyWindow[],
  loOffset: number,
  hiOffset: number,
  w: ActivityWindow,
  onToday: boolean,
  onYesterday: boolean,
): boolean {
  for (const win of windows) {
    const lo = win.startSecs + loOffset;
    const hi = win.endSecs + hiOffset;
    if (onToday && lo <= w.windowEndSecs && hi >= w.nowSecs) return true;
    if (onYesterday && lo <= w.windowEndSecs + w.yesterdayShiftSecs && hi >= w.nowSecs + w.yesterdayShiftSecs) return true;
  }
  return false;
}

/**
 * Does `trip` produce an in-window departure at column `col` of its own
 * stop sequence?
 *
 * Frequency-based trips (`frequencies.txt`) are matched via their service
 * windows, NOT their template clock times — the template's `departureSecs`
 * only define relative offsets between stops:
 * https://gtfs.org/documentation/schedule/reference/#frequenciestxt
 */
function tripActiveAtColumn(
  trip: RaptorIndexRoute["trips"][number],
  col: number,
  frequenciesByTrip: Map<number, FrequencyWindow[]> | undefined,
  w: ActivityWindow,
): boolean {
  const onToday = w.activeToday.has(trip.serviceId);
  const onYesterday = w.activeYesterday !== null && w.activeYesterday.has(trip.serviceId);
  if (!onToday && !onYesterday) return false;
  const dep = trip.departureSecs[col];
  if (dep === undefined || dep === -1) return false; // trip doesn't serve this occurrence
  const windows = trip.ptbTripIdx !== undefined ? frequenciesByTrip?.get(trip.ptbTripIdx) : undefined;
  if (windows && windows.length > 0) {
    const first = firstServedDeparture(trip.departureSecs);
    if (first === undefined) return false;
    const offset = dep - first;
    return freqActiveInOffsetSpan(windows, offset, offset, w, onToday, onYesterday);
  }
  return depInWindow(dep, w, onToday, onYesterday);
}

/**
 * The set of route IDs at `stopId` that have at least one scheduled
 * departure in `[now, now + lookaheadHours]`, per the locally-loaded
 * RAPTOR index. Returns an empty set if the stop is unknown or no route
 * is active.
 *
 * Schedule-only — RT integration intentionally deferred. A cancelled
 * trip still counts here, which is slightly too permissive but never
 * too restrictive.
 *
 * PATTERN-EXACT PATH (production: PATTERN_MODE=CoveringMerge): when the
 * index carries `patterns`/`patternsAtStop`, each pattern's trips store
 * `departureSecs` aligned to the pattern's OWN stop sequence, so the
 * departure time at `stopId` is readable EXACTLY for every pattern that
 * serves it — including reverse-direction sibling stops the canonical
 * display sequence never covers. Loop and lasso patterns revisit a stop
 * within one trip (the first/last stop appears twice on a loop; a lasso
 * trip re-serves its stem), so EVERY occurrence of `stopId` in the
 * pattern's sequence is checked, not just the first:
 * https://gtfs.org/documentation/schedule/schedule-best-practices/#loop-routes
 * https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
 *
 * LEGACY PATH (PatternMode.Off — Dexie-table boots, hand-built test
 * indexes — AND any stop the patterns don't cover): canonical-column reads
 * plus the headsign-matched direction-pattern fallback for return-only
 * stops, unchanged from the pre-pattern implementation (time axis
 * over-approximated for return-only stops — any in-window departure of a
 * direction-matched trip counts). The per-stop coverage gate matters on a
 * per-ROUTE wire (one record per route_id, reverse stops present only in
 * `directionPatterns` — e.g. a stale cached bundle): its "patterns" carry
 * canonical sequences only, so a reverse-only stop must degrade to the
 * legacy fallback rather than read "not served by any pattern" as exact
 * inactivity. See {@link stopActivityDecidable}.
 */
export function activeRouteIdsAtStop(
  stopId: string,
  now: Date,
  lookaheadHours: number,
  raptorIndex: RaptorIndex,
  feedTz?: string,
  window?: ActivityWindow,
): ReadonlySet<string> {
  const { patterns, patternsAtStop, frequenciesByTrip } = raptorIndex;
  if (patterns && patternsAtStop && patternsAtStop.has(stopId)) {
    const patternIdxs = patternsAtStop.get(stopId);
    if (!patternIdxs || patternIdxs.length === 0) return EMPTY_ROUTE_IDS;
    const w = window ?? resolveActivityWindow(now, lookaheadHours, raptorIndex, feedTz);

    let result: Set<string> | null = null;
    for (const patternIdx of patternIdxs) {
      const pattern = patterns[patternIdx];
      if (!pattern) continue; // defensive: patternsAtStop should never point out of range
      // One route id spans several patterns — skip patterns of an
      // already-confirmed route.
      if (result !== null && result.has(pattern.id)) continue;

      let active = false;
      for (let col = 0; col < pattern.stopIds.length && !active; col++) {
        if (pattern.stopIds[col] !== stopId) continue; // every occurrence (loop/lasso)
        for (const trip of pattern.trips) {
          if (tripActiveAtColumn(trip, col, frequenciesByTrip, w)) {
            active = true;
            break;
          }
        }
      }
      if (active) {
        if (result === null) result = new Set();
        result.add(pattern.id);
      }
    }
    return result ?? EMPTY_ROUTE_IDS;
  }

  const routeIdxs = raptorIndex.routesAtStop.get(stopId);
  if (!routeIdxs || routeIdxs.length === 0) return EMPTY_ROUTE_IDS;
  const w = window ?? resolveActivityWindow(now, lookaheadHours, raptorIndex, feedTz);

  let result: Set<string> | null = null;
  for (const routeIdx of routeIdxs) {
    const route = raptorIndex.routes[routeIdx];
    const stopIdx = route.stopIds.indexOf(stopId);

    let active = false;
    if (stopIdx >= 0) {
      // Stop is on the canonical sequence — check trip departures at this
      // exact column.
      for (const trip of route.trips) {
        if (tripActiveAtColumn(trip, stopIdx, frequenciesByTrip, w)) {
          active = true;
          break;
        }
      }
    } else {
      // Return-only-stop fallback. The stop is in `routesAtStop` for this
      // route but not on `route.stopIds` — it lives only in a non-canonical
      // direction pattern (typical for opposite-side-of-road siblings on
      // bidirectional bus/trolleybus routes). Per-trip times are stored
      // canonical-column-only, so we can't read the exact departure at
      // `stopId`. Narrow the over-approximation by matching each trip's
      // `headsign` to the headsigns of direction patterns that actually
      // contain this stop — a forward-direction trip never makes the route
      // appear active at a reverse-only stop, etc. Trips that match the
      // direction are still over-approximated on the time axis (any
      // in-window canonical departure counts as activity at the stop),
      // which is the residual ledger-noted slack. Tracked in
      // the route shapes backlog notes Phase 2g.
      const matchingHeadsigns = new Set<string>();
      for (const dp of route.directionPatterns ?? []) {
        if (dp.stopIds.includes(stopId)) matchingHeadsigns.add(dp.headsign);
      }
      for (const trip of route.trips) {
        if (!matchingHeadsigns.has(trip.headsign)) continue;
        const onToday = w.activeToday.has(trip.serviceId);
        const onYesterday = w.activeYesterday !== null && w.activeYesterday.has(trip.serviceId);
        if (!onToday && !onYesterday) continue;
        const windows =
          trip.ptbTripIdx !== undefined ? frequenciesByTrip?.get(trip.ptbTripIdx) : undefined;
        if (windows && windows.length > 0) {
          // Frequency-based trip on the any-stop fallback: departures span
          // offsets [0, lastServed - firstServed] past each window start.
          const first = firstServedDeparture(trip.departureSecs);
          const last = lastServedDeparture(trip.departureSecs);
          if (
            first !== undefined &&
            last !== undefined &&
            freqActiveInOffsetSpan(windows, 0, last - first, w, onToday, onYesterday)
          ) {
            active = true;
          }
        } else {
          for (const dep of trip.departureSecs) {
            if (depInWindow(dep, w, onToday, onYesterday)) {
              active = true;
              break;
            }
          }
        }
        if (active) break;
      }
    }

    if (active) {
      if (result === null) result = new Set();
      result.add(route.id);
    }
  }

  return result ?? EMPTY_ROUTE_IDS;
}

/**
 * Can `activeRouteIdsAtStop` answer EXACTLY for this stop? True when the
 * index carries patterns AND some pattern's own stop sequence contains the
 * stop — pattern-column departure times are then readable, so an empty
 * active set means "provably no upcoming service" rather than "can't tell".
 *
 * On the production per-PATTERN wire every served stop is covered. On a
 * per-ROUTE wire (reverse stops only in `directionPatterns` — e.g. a stale
 * cached bundle) reverse-only stops are NOT covered and must keep the
 * legacy fail-open treatment (and the schedule-tile serviceless hide in
 * `useVisibleStops`).
 */
export function stopActivityDecidable(stopId: string, raptorIndex: RaptorIndex): boolean {
  return !!(raptorIndex.patterns && raptorIndex.patternsAtStop?.has(stopId));
}

/**
 * Fail-open stop visibility for urban mode.
 *
 * PATTERN-COVERED stop (production: every served stop): `activeRouteIdsAtStop`
 * reads real departure times at the stop, so its answer is authoritative —
 * an empty set means the stop provably has no departure in the window, and
 * the stop should be hidden. No structural fail-open. This is what lets
 * stop visibility be decided city-wide at ANY zoom, independent of the
 * viewport-bounded schedule-tile sweep (which only ever covers the last
 * card-zoom viewport and is evicted on pan — hiding on it made stops blip
 * in/out with zoom).
 *
 * UNCOVERED stop (PatternMode.Off index, or a per-route wire's return-only
 * stop): per-trip times are canonical-column-only, so a stop that is
 * return-only for some route is indeterminate — keep it visible (fail open)
 * rather than conflate "can't determine" with "inactive", which is exactly
 * what made stops with non-canonical-only service vanish in urban mode. The
 * accurate per-route badge set then comes from the schedule tile
 * (`activeRouteIdsFromTile`), not from here.
 */
export function stopMaybeActive(
  stopId: string,
  now: Date,
  lookaheadHours: number,
  raptorIndex: RaptorIndex,
  feedTz?: string,
  window?: ActivityWindow,
): boolean {
  if (activeRouteIdsAtStop(stopId, now, lookaheadHours, raptorIndex, feedTz, window).size > 0) return true;
  if (stopActivityDecidable(stopId, raptorIndex)) return false; // exact answer — no fail-open
  const routeIdxs = raptorIndex.routesAtStop.get(stopId);
  if (!routeIdxs) return false;
  for (const routeIdx of routeIdxs) {
    const route = raptorIndex.routes[routeIdx];
    if (!route) continue; // defensive: routesAtStop should never point out of range
    if (route.stopIds.indexOf(stopId) < 0) return true; // return-only ⇒ indeterminate ⇒ keep
  }
  return false;
}

/**
 * Does the given stop have at least one scheduled departure in
 * `[now, now + lookaheadHours]`? Thin convenience wrapper around
 * {@link activeRouteIdsAtStop} — see that function for the full
 * semantics (RT caveats, cross-midnight handling).
 */
export function hasUpcomingDeparture(
  stopId: string,
  now: Date,
  lookaheadHours: number,
  raptorIndex: RaptorIndex,
  feedTz?: string,
): boolean {
  return activeRouteIdsAtStop(stopId, now, lookaheadHours, raptorIndex, feedTz).size > 0;
}
