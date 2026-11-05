import type { Departure } from "../types/transit.js";
import type {
  DecodedScheduleTile,
  ServiceState,
} from "../types/scheduleTile.js";
import type { RtTripUpdate } from "../proto/route-update.js";
import { lowerBound } from "../util/binarySearch.js";
import { ymdLocal, addDaysCivil } from "../util/ymd.js";
import { serviceDayToUnix, unixToServiceDay } from "../time/timeDomain.js";
import { serviceActiveForDate } from "./serviceActiveForDate.js";

/**
 * Version tag baked into `bundleHash` ('s `computeBundleHash`). Bump when the algorithm in
 * `getDeparturesFromTile` changes in a way that makes existing tiles produce different
 * departures for the same inputs. Adding optional fields, fixing wrong test assertions, etc. do
 * NOT bump.
 */
export const GET_DEPARTURES_FROM_TILE_VERSION = "1";

/** Query input for `getDeparturesFromTile`. */
export interface GetDeparturesFromTileArgs {
  tile: DecodedScheduleTile;
  stopId: string;
  /** Wall-clock reference time. The 10-minute backward cutoff is `now - 10min`. */
  now: Date;
  /** Maximum departures to return after sorting by scheduled time. */
  limit: number;
  /** Window upper bound at `now + lookAheadHours`. Range 1..48 per legacy contract. */
  lookAheadHours: number;
  /**
   * Optional IANA feed timezone. When set, civil dates AND absolute instants
   * are computed in this zone via serviceDayToUnix/unixToServiceDay (DST-correct).
   * ABSENT ⇒ browser-local behaviour (the backend caller passes none, so
   * /departures stays byte-identical).
   */
  tz?: string;
  /**
   * Optional real-time trip updates. Map keys: prefer `${tripId}|${YYYYMMDD}`
   * for date-scoped updates; fall back to bare `tripId`. Mirrors the legacy
   * RT key strategy in `getDepartures`. When absent, no RT fields are populated.
   */
  realtimeUpdates?: ReadonlyMap<string, RtTripUpdate>;
}

/** Result: filtered departures plus the tri-state pill flag. */
export interface GetDeparturesFromTileResult {
  departures: Departure[];
  serviceState: ServiceState;
}

const TEN_MINUTES_MS = 10 * 60 * 1000;

/**
 * Filter a decoded schedule tile to upcoming departures at one stop.
 *
 * Mirrors the legacy `getDepartures` in `packages/backend/src/gtfs/store.ts`.
 * Boundary behaviour preserved verbatim: floor on `lowerSecs`, ceil on
 * `upperSecs`, belt-and-suspenders re-check after wall-clock reconstruction.
 *
 * Multi-day base-date set is **dynamic** per legacy:
 *   - today + yesterday always (yesterday covers trips with `departureSecs >= 86400`
 *     rolling into today's wall-clock window).
 *   - tomorrow and beyond appended one day at a time while
 *     `dayMidnight + 24h <= upperCutoff`. With `lookAheadHours = 1` at midday
 *     this is just today + yesterday; with `lookAheadHours = 48` near
 *     end-of-day this can be 4 days (yesterday + today + tomorrow + day-after).
 *
 * Real-time merge (when `realtimeUpdates` is provided): per departure, look up
 * the date-scoped key `${tripId}|${baseDateYmd}` first; fall back to the bare
 * `tripId`. Set `delaySeconds` from RT; set `predictedTime` only when
 * `delaySeconds !== 0`; set `cancelled` only when `rt.cancelled === true`
 * (false collapses to undefined to drop the wire field, matching legacy). A
 * trip with `rt.deleted` is dropped from the board altogether.
 *
 * `serviceState` semantics:
 *   - `"no_service_today"` when no calendar row for any service used by
 *     trips at this stop is active on TODAY's date. This is the pill's
 *     "today" reading; it is independent of `sliced.length` so an overnight
 *     trip from yesterday's base date can still appear in `departures`
 *     while the pill correctly reports today as inactive.
 *   - `"active"` when today is active AND `sliced` has at least one entry
 *     (today's, yesterday's overnight, or tomorrow's early — any departure
 *     reachable within the look-ahead window).
 *   - `"ended_today"` when today is active but no entry survives the
 *     window filter.
 *

 * * Stop-not-in-tile is collapsed into `serviceState: "no_service_today"` (with `departures:
 * []`). The frontend distinguishes stop-not-in-tile from no-service-today by inspecting the
 * loaded tile's `stops` map BEFORE calling this function (the loader already needs `stops` to
 * render the sheet header).
 */
export function getDeparturesFromTile(
  args: GetDeparturesFromTileArgs,
): GetDeparturesFromTileResult {
  const { tile, stopId, now, limit, lookAheadHours, realtimeUpdates, tz } =
    args;

  const stopColumns = tile.stops[stopId];
  if (!stopColumns) {
    return { departures: [], serviceState: "no_service_today" };
  }

  const { tripIxs, departureSecs } = stopColumns;
  // Civil "today" in the operative zone. In the city-tz branch this is the
  // city civil date (DST-correct via unixToServiceDay); without tz it stays
  // the browser-local ymd (byte-identical to legacy).
  const todayYmd = tz
    ? String(unixToServiceDay(Math.floor(now.getTime() / 1000), tz).serviceDateYmd)
    : ymdLocal(now);
  const cutoffMs = now.getTime() - TEN_MINUTES_MS;
  const upperCutoffMs = now.getTime() + lookAheadHours * 60 * 60 * 1000;

  // Stop-scoped service set: only services USED BY trips at THIS stop.
  // A tile-global scan would mis-classify the pill when an unrelated
  // service in the same cell is active today but no trip at this stop runs.
  const stopServiceIxs = new Set<number>();
  for (let i = 0; i < tripIxs.length; i++) {
    stopServiceIxs.add(tile.trips[tripIxs[i]!]!.serviceIx);
  }

  // Build the dynamic base-date set: yesterday + today always, then tomorrow…
  // while `dayMidnight + 24h <= upperCutoff`. Mirrors the legacy base-date
  // expansion loop in `getDepartures`. Each entry carries the base-date
  // midnight instant in milliseconds (`baseMs`) and its `ymd` string. In the
  // tz branch `baseMs` is the city civil-midnight instant (DST-correct via
  // serviceDayToUnix); without tz it is the browser-local midnight (legacy).
  const baseDates: { baseMs: number; ymd: string }[] = [];
  if (tz) {
    // City civil dates: yesterday/today via addDaysCivil, then forward.
    const yesterdayYmd = addDaysCivil(todayYmd, -1);
    baseDates.push({
      baseMs: serviceDayToUnix(Number(yesterdayYmd), 0, tz) * 1000,
      ymd: yesterdayYmd,
    });
    baseDates.push({
      baseMs: serviceDayToUnix(Number(todayYmd), 0, tz) * 1000,
      ymd: todayYmd,
    });
    // Forward expansion: include tomorrow when its civil midnight instant is
    // still <= upperCutoff. DST-invariant civil-date stepping.
    for (let n = 1; ; n++) {
      const ymd = addDaysCivil(todayYmd, n);
      const baseMs = serviceDayToUnix(Number(ymd), 0, tz) * 1000;
      if (baseMs > upperCutoffMs) break;
      baseDates.push({ baseMs, ymd });
    }
  } else {
    const todayMidnight = new Date(now);
    todayMidnight.setHours(0, 0, 0, 0);
    const yesterdayMidnight = new Date(todayMidnight);
    yesterdayMidnight.setDate(yesterdayMidnight.getDate() - 1);

    baseDates.push({
      baseMs: yesterdayMidnight.getTime(),
      ymd: ymdLocal(yesterdayMidnight),
    });
    baseDates.push({ baseMs: todayMidnight.getTime(), ymd: todayYmd });
    // Forward expansion: include tomorrow when its midnight <= upperCutoff.
    // The shared contract makes `lookAheadHours` a required number (not an
    // optional `upperCutoff` Date as in legacy), so the loop body simply
    // never runs when the window doesn't cross midnight.
    const cursor = new Date(todayMidnight);
    cursor.setDate(cursor.getDate() + 1);
    while (cursor.getTime() <= upperCutoffMs) {
      const m = new Date(cursor);
      baseDates.push({ baseMs: m.getTime(), ymd: ymdLocal(m) });
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  // Per-base-date active service set (stop-scoped).
  const activeByBase = new Map<string, Set<number>>();
  for (const { ymd } of baseDates) {
    const active = new Set<number>();
    for (const svcIx of stopServiceIxs) {
      if (serviceActiveForDate(ymd, tile.calendar[svcIx]!)) active.add(svcIx);
    }
    activeByBase.set(ymd, active);
  }

  // We do NOT early-return on `activeByBase[todayYmd]` being empty: yesterday's
  // overnight trips (`departureSecs >= 86400`) still need to roll into today's
  // wall-clock window. `serviceState` is computed AFTER the loop so the pill
  // can read "no_service_today" while the departure list still shows the late
  // overnight trip — that matches what the user sees.

  // Per-base-date filter: lowerSecs/upperSecs reframed against each midnight.
  const departures: Departure[] = [];
  for (const { baseMs, ymd } of baseDates) {
    const lowerSecs = Math.floor((cutoffMs - baseMs) / 1000);
    const upperSecs = Math.ceil((upperCutoffMs - baseMs) / 1000);

    // Skip a base date whose entire window is below the stop's first
    // departureSecs or above its last — saves the binary-search call.
    // In the tz branch these guards are widened by 3600s (the K1 DST band) so
    // that a fall-back-day departure whose TRUE instant is in-window but whose
    // elapsed `dep` is up to 3600s below `lowerSecs` is not dropped here before
    // the exact instant re-check can run. The no-tz branch stays byte-identical.
    if (departureSecs.length === 0) break;
    if (tz ? upperSecs + 3600 < 0 : upperSecs < 0) continue;
    if (tz ? lowerSecs - 3600 > departureSecs[departureSecs.length - 1]! : lowerSecs > departureSecs[departureSecs.length - 1]!) continue;

    const active = activeByBase.get(ymd)!;
    // DST window-bounds guard (K1): in the tz branch `dep` (GTFS elapsed-secs)
    // diverges from `(scheduledMs-baseMs)/1000` by up to ±3600s on a transition
    // base date, so the elapsed-frame bounds can prematurely skip a departure
    // whose TRUE instant is still in-window. Widen the band by 3600s and let
    // the exact instant re-check below be authoritative.
    // NOTE: the 3600s band assumes ≤1h DST transitions. All configured PTN cities
    // (Europe/{Vilnius,Warsaw,Paris,Minsk,Oslo}, Asia/Tbilisi) use 1h transitions,
    // which is correct here. The IANA maximum is 2h (see timeDomain.ts docstring);
    // a future city with a >1h transition would need a wider band — or derive it
    // dynamically from (offsetBefore − offsetAfter) for that zone.
    const startIdx = tz
      ? lowerBound(departureSecs, Math.max(0, lowerSecs - 3600), (d) => d)
      : lowerBound(departureSecs, Math.max(0, lowerSecs), (d) => d);
    for (let i = startIdx; i < departureSecs.length; i++) {
      const dep = departureSecs[i]!;
      if (tz) {
        if (dep > upperSecs + 3600) break;
      } else {
        if (dep > upperSecs) break;
      }

      const trip = tile.trips[tripIxs[i]!]!;
      if (!active.has(trip.serviceIx)) continue;

      const route = tile.routes[trip.routeIx]!;
      const tripId = tile.stringTable[trip.tripIdIx]!;
      const headsign = tile.stringTable[trip.headsignIx]!;

      let scheduledMs: number;
      let scheduledTime: string;
      if (tz) {
        // City-tz instant: project (serviceDate, dep) through the DST-correct
        // seam. `dep` may exceed 86400 (overnight) — serviceDayToUnix handles it.
        scheduledMs = serviceDayToUnix(Number(ymd), dep, tz) * 1000;
        scheduledTime = new Date(scheduledMs).toISOString();
      } else {
        const scheduled = new Date(baseMs);
        scheduled.setSeconds(dep);
        scheduledMs = scheduled.getTime();
        scheduledTime = scheduled.toISOString();
      }
      // Exact real-instant cut (unchanged): authoritative window membership.
      if (scheduledMs < cutoffMs) continue;
      if (scheduledMs > upperCutoffMs) continue;

      let predictedTime: string | undefined;
      let delaySeconds: number | undefined;
      let cancelled: boolean | undefined;

      if (realtimeUpdates) {
        const rt =
          realtimeUpdates.get(`${tripId}|${ymd}`) ??
          realtimeUpdates.get(tripId);
        // A DELETED trip must not be shown to riders, not even as cancelled.
        if (rt?.deleted) continue;
        if (rt) {
          delaySeconds = rt.delaySeconds;
          cancelled = rt.cancelled || undefined;
          if (rt.delaySeconds !== 0) {
            predictedTime = new Date(
              scheduledMs + rt.delaySeconds * 1000,
            ).toISOString();
          }
        }
      }

      departures.push({
        routeId: route.id,
        routeShortName: route.shortName,
        routeColor: route.color,
        mode: route.mode,
        subMode: route.subMode ?? route.mode,
        headsign,
        scheduledTime,
        predictedTime,
        delaySeconds,
        tripId,
        cancelled,
      });
    }
  }

  departures.sort(
    (a, b) =>
      new Date(a.scheduledTime).getTime() -
      new Date(b.scheduledTime).getTime(),
  );

  const sliced = departures.slice(0, limit);

  // serviceState classifier — today's stop-scoped activity decides
  // "no_service_today"; only then does presence-in-window decide active vs ended.
  const todayActive = activeByBase.get(todayYmd)!;
  let serviceState: ServiceState;
  if (todayActive.size === 0) serviceState = "no_service_today";
  else if (sliced.length > 0) serviceState = "active";
  else serviceState = "ended_today";

  return { departures: sliced, serviceState };
}
