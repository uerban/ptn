import { db } from "../db/index.ts";
import type { DecodedTransfers, RouteDirectionPattern, TransportMode } from "@pt/shared";
import { PatternMode, PATTERN_MODE, patternsEnabled } from "@pt/shared/raptor";
import { readGtfsBundle, getTransfersManifest, type RaptorBundleWire } from "./gtfsBundle.ts";
import { fetchTransfersArtifact } from "./transfersArtifact.ts";
import type { OsmTransferLookup } from "./stopFinder.ts";
import { useCityStore } from "../stores/cityStore.ts";

export interface RaptorIndexRoute {
  id: string;
  shortName: string;
  mode: TransportMode;
  color?: string;
  textColor?: string;
  stopIds: string[];
  trips: {
    tripId: string;
    serviceId: string;
    headsign: string;
    /** GTFS display direction; never consulted by the RAPTOR scan. */
    directionId?: 0 | 1;
    /** PTB global trip ordinal, used to join GTFS frequencies.txt rows after route-local sorting. */
    ptbTripIdx?: number;
    departureSecs: number[];
    /**
     * Sparse per-stop dwell = `departure_time - arrival_time`. When present,
     * aligned to the enclosing route's `stopIds`. Absence means "zero dwell
     * everywhere" — by far the common case, and avoids allocating a
     * parallel array per trip when the feed has no non-zero dwells. A trip
     * that has any non-zero dwell emits the full array. RAPTOR subtracts
     * this from `departureSecs[pos]` when alighting so a terminus-dwell
     * stop is not reported 7 min late; boarding still uses the raw
     * `departureSecs` (you can't board before the bus leaves).
     */
    dwellSecs?: number[];
    /**
     * Sparse per-stop GTFS pickup_type / drop_off_type, aligned to the enclosing
     * route's `stopIds` (parallel to `dwellSecs`). `pickup_type == 1` = alight-only
     * (no boarding); `drop_off_type == 1` = board-only (no alighting). Absent when
     * every value is default 0 (the norm). The RAPTOR scan reads these to forbid
     * boarding/alighting at `== 1` stops; absent ⇒ predicate inert. Re-aligned to the
     * canonical positions by `realignTripsToCanonical`, mirroring `dwellSecs`.
     */
    pickupTypes?: number[];
    dropOffTypes?: number[];
    wheelchairAccessible?: number;
    bikesAllowed?: number;
    // Carried through the bundle-read path when a trip has a shape reference.
    // The Dexie fallback can resolve the same reference from its trip row.
    shapeId?: string;
  }[];
  /**
   * Per-direction stop sequences. Carried through bundle-read so the line
   * preview can render both directions of bidirectional routes whose return
   * direction uses different stop_ids than the canonical (longest-trip)
   * sequence. Absent when the feed has no per-direction sequences — consumers
   * fall back to `stopIds` in that case.
   */
  directionPatterns?: RouteDirectionPattern[];
  /**
   * Memoized `computeBoardSorted(route)` result (F1). Lazily filled by the
   * scan on the route's first visit (`route.boardSorted ??= ...`) — hand-built
   * indexes need no change and hydrate stays untouched. `true` gates the
   * O(stops + trips) canonical-hop board search; `false`/absent keeps the
   * array-order fallback scan. The flag only ever selects between two paths
   * proven to produce identical output, so a stale/absent value can cost
   * speed, never correctness.
   */
  boardSorted?: boolean;
}

/**
 * Whether a route's trips depart in non-decreasing array order at EVERY stop
 * position (ignoring `-1` "not served" markers). Trips are array-ordered by
 * `departureSecs[0]` (see `hydrate`), so this holds unless a trip overtakes
 * another somewhere downstream (or skips position 0 and sorts first with an
 * out-of-order downstream time).
 *
 * The RAPTOR board search relies on this to run the canonical-RAPTOR hop:
 * with an incumbent boarded trip, only earlier-in-array trips can be
 * re-boarded, and the downward scan may stop at the first SERVING trip that
 * departs before the boardable threshold. Both properties are false on
 * overtaking routes — those keep the full array fallback scan (F1).
 */
export function computeBoardSorted(
  route: Pick<RaptorIndexRoute, "stopIds" | "trips">,
): boolean {
  const n = route.stopIds.length;
  const lastDep = new Array<number>(n).fill(-Infinity);
  for (const trip of route.trips) {
    const deps = trip.departureSecs;
    for (let pos = 0; pos < n; pos++) {
      const dep = deps[pos];
      if (dep === undefined || dep === -1) continue;
      if (dep < lastDep[pos]) return false;
      lastDep[pos] = dep;
    }
  }
  return true;
}

export interface RaptorIndexService {
  serviceId: string;
  days: boolean[];
  startDate: string;
  endDate: string;
  exceptions: Record<string, number>;
}

/**
 * Pre-computed pedestrian transfer table indexed for fast stop-keyed lookup.
 * Mirrors the CSR layout from `decode()` and adds `stopIdToIdx` so the
 * RAPTOR consumer (which iterates marked stops by id) can find a stop's
 * edge slice without scanning `stopIds`.
 */
export interface FootTransfers {
  stopIds: string[];
  stopIdToIdx: Map<string, number>;
  neighborIx: Uint32Array;
  walkSecs: Uint32Array;
  /** CSR offsets, length stopIds.length + 1. */
  offsets: Uint32Array;
}

/**
 * An applied GTFS `transfers.txt` rule, keyed in `RaptorIndex.transferRules`
 * by the stop-pair string `` `${fromStopId}\t${toStopId}` `` (see
 * `transferRuleKey`). UNSCOPED rules (no from/to route AND no from/to trip) are
 * kept here; SCOPED rules (trip→trip / route→route) live in the separate scoped
 * maps below (S3). `type` is the GTFS `transfer_type`; `minSecs` carries
 * `min_transfer_time` only when `type === 2`. Applied types: 3 (forbid),
 * 2 (per-pair min), 1 (timed / guaranteed connection → per-pair floor 0, S2),
 * 4 (in-seat / stay-seated → per-pair floor 0 + transfer-count exclusion, S3),
 * 5 (in-seat forbidden → normal floor, a no-op the engine already enforces, S3).
 * GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
 */
export interface TransferRule {
  type: number;
  minSecs?: number;
}

/**
 * Stop-pair key for `RaptorIndex.transferRules`. A `\t` separator is safe:
 * GTFS stop_ids cannot contain a tab. KEY BY STRING PAIR (not a dense int
 * key) — both engines use this exact formula, avoiding the stop-index-space
 * mismatch documented in the S1 design spec.
 */
export function transferRuleKey(fromStopId: string, toStopId: string): string {
  return `${fromStopId}\t${toStopId}`;
}

/**
 * Trip-scoped key for `RaptorIndex.transferRulesTripScoped` (S3). A GTFS
 * `transfers.txt` row carrying BOTH `from_trip_id` AND `to_trip_id` is the
 * MOST-SPECIFIC rule for a board: it applies only when continuing from
 * `fromTripId` onto `toTripId` at the `(fromStopId,toStopId)` pair. The `\t`
 * separator is safe (GTFS trip_ids/stop_ids cannot contain a tab). Both engines
 * use this EXACT formula so the scan looks up the same key — the index-space
 * hazard from S1 is sidestepped by keying on STRING ids on both sides.
 */
export function transferTripScopedKey(
  fromStopId: string,
  toStopId: string,
  fromTripId: string,
  toTripId: string,
): string {
  return `${fromStopId}\t${toStopId}\t${fromTripId}\t${toTripId}`;
}

/**
 * Route-scoped key for `RaptorIndex.transferRulesRouteScoped` (S3). A
 * `transfers.txt` row carrying BOTH `from_route_id` AND `to_route_id` (and no
 * trip scope) applies when continuing from any trip on `fromRouteId` onto any
 * trip on `toRouteId` at the stop pair — LESS specific than trip→trip, MORE
 * specific than the unscoped stop→stop rule. Same string-key discipline.
 */
export function transferRouteScopedKey(
  fromStopId: string,
  toStopId: string,
  fromRouteId: string,
  toRouteId: string,
): string {
  return `${fromStopId}\t${toStopId}\t${fromRouteId}\t${toRouteId}`;
}

export interface RaptorIndex {
  routes: RaptorIndexRoute[];
  routeIdToIdx: Map<string, number>;
  routesAtStop: Map<string, number[]>;
  services: Map<string, RaptorIndexService>;
  stopWheelchairBoarding?: Map<string, number>;
  /**
 * IANA timezone of the feed's agency, carried from the bundle wire's `meta.cityTzIana`.
 * Populated only on the blob/bundle hydration path; `undefined` on the Dexie fallback (the meta
 * never reaches that branch). Threaded so the warm-start drift guard can cross-check
 * `CityConfig.tz` against the bundle tz at the `gtfsDataStore` install sites —
 * `buildRaptorIndex()` drops the raw `wire`, so this is the only survivor.
 */
  cityTzIana?: string;
  /**
   * Pre-computed pedestrian footpaths from the routing bundle's transfers
   * artifact. Absent when the artifact is not present in `meta` or fetch
   * failed — consumers must handle that case (haversine fallback).
   */
  footTransfers?: FootTransfers;
  /**
   * UNSCOPED GTFS `transfers.txt` rules keyed by `transferRuleKey`. `hydrate`
   * ALWAYS populates it (empty `Map` when the bundle carries no transfers). The
   * scan applies `transfer_type` 3 (skip the edge / forbid same-stop re-board),
   * 2 (per-pair min_transfer_time floor, replacing the global
   * RAPTOR_MIN_TRANSFER_SECS), and 1 (timed / guaranteed connection → per-pair
   * floor 0, S2). Scoped rules are dropped here (deferred to S3).
   *
   * Optional ONLY so the analogous "feature absent" pattern as `footTransfers`
   * holds for hand-built indexes (the scan defaults an absent map to empty,
   * equivalent to the Rust engine's empty
   * `transfer_rules`). Production builds it via `hydrate`, which never omits it.
   * GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
   */
  transferRules?: Map<string, TransferRule>;
  /**
   * TRIP-SCOPED GTFS `transfers.txt` rules (S3), keyed by
   * `transferTripScopedKey`. A row carrying BOTH `from_trip_id` AND
   * `to_trip_id` lands here — the MOST-SPECIFIC scope. At the board the scan
   * resolves the arriving trip (the parent transit leg's trip) and the boarding
   * trip, looks up this map FIRST, and applies the rule (type 3 forbid, 2 min,
   * 1 floor-0, 4 in-seat floor-0, 5 no-op) before falling back to the
   * route-scoped then unscoped maps. Absent ⇒ empty (no scoped rules).
   */
  transferRulesTripScoped?: Map<string, TransferRule>;
  /**
   * ROUTE-SCOPED GTFS `transfers.txt` rules (S3), keyed by
   * `transferRouteScopedKey`. A row carrying BOTH `from_route_id` AND
   * `to_route_id` (and NO trip scope) lands here — less specific than
   * trip→trip, more specific than the unscoped stop→stop rule. Consulted at the
   * board AFTER the trip-scoped map misses and BEFORE the unscoped map.
   */
  transferRulesRouteScoped?: Map<string, TransferRule>;
  /**
 * SCAN model. One entry per trip-pattern (a route-shaped object whose `stopIds` is the
 * pattern's own sequence and whose `id` is the bare GTFS route_id, repeated across a route's
 * patterns). Absent when PatternMode is Off — the scan then falls back to
 * `routes`/`routesAtStop` (canonical display model).
 */
  patterns?: RaptorIndexRoute[];
  /** stop_id → indices into `patterns`. Absent when PatternMode is Off. */
  patternsAtStop?: Map<string, number[]>;
  frequenciesByTrip?: Map<number, FrequencyWindow[]>;
}

export interface FrequencyWindow {
  tripIdx: number;
  startSecs: number;
  endSecs: number;
  headwaySecs: number;
  exactTimes: 0 | 1;
}

/** The per-trip shape stored inline on a route record. Mirrors `tripRecords`
 *  element shape minus `routeId`, so `hydrate` can read trips per-record
 *  without re-grouping by id (which is ambiguous when records share a route_id
 *  under per-pattern wire). */
type InlineTripRecord = {
  tripId: string;
  serviceId: string;
  headsign: string;
  directionId?: 0 | 1;
  ptbTripIdx?: number;
  departureSecs: number[];
  dwellSecs?: number[];
  // Pattern-position-aligned pickup/drop_off types (re-aligned to canonical by
  // `realignTripsToCanonical`, parallel to `dwellSecs`). See RaptorIndexRoute.trips.
  pickupTypes?: number[];
  dropOffTypes?: number[];
  wheelchairAccessible?: number;
  bikesAllowed?: number;
  shapeId?: string;
};

interface Raw {
  routeRecords: Array<{
    id: string;
    shortName: string;
    mode: TransportMode;
    color?: string;
    textColor?: string;
    stopIds: string[];
    directionPatterns?: RouteDirectionPattern[];
    /**
     * Trips for THIS record only (per-pattern wire: one pattern's trips;
     * Off wire: all of the route's trips on the single record).
     * Populated by `rawFromBundle` from `wire.routes[i].trips`. On the
     * Dexie fallback, `buildRaptorIndex` groups `tripRecords` by routeId
     * into each record. `hydrate` reads this field directly — the old
     * `tripsByRoute.get(r.id)` regroup is dropped (ambiguous when records
     * share an id under Unbounded).
     *
     * Optional only for hand-built `Raw` objects in tests that do not exercise
     * trip data. Absent → treated as empty array in `hydrate`.
     */
    trips?: InlineTripRecord[];
  }>;
  tripRecords: Array<{
    tripId: string;
    routeId: string;
    serviceId: string;
    headsign: string;
    directionId?: 0 | 1;
    ptbTripIdx?: number;
    departureSecs: number[];
    dwellSecs?: number[];
    pickupTypes?: number[];
    dropOffTypes?: number[];
    wheelchairAccessible?: number;
    bikesAllowed?: number;
    shapeId?: string;
  }>;
  serviceRecords: Array<{
    serviceId: string;
    days: boolean[];
    startDate: string;
    endDate: string;
    exceptions: Record<string, number>;
  }>;
  stopRecords: Array<{
    id: string;
    name: string;
    lat: number;
    lon: number;
    wheelchairBoarding?: number;
  }>;
  /** GTFS transfers.txt rules (string ids), or absent on bundles without them. */
  transferRecords?: Array<{
    fromStopId: string;
    toStopId: string;
    transferType: number;
    minTransferSecs?: number;
    fromRouteId?: string;
    toRouteId?: string;
    fromTripId?: string;
    toTripId?: string;
  }>;
  frequencyRecords?: FrequencyWindow[];
}

/**
 * Adapt a `FootTransfers` CSR into the `OsmTransferLookup` interface
 * `findStopsInRadius` consumes. Returns `undefined` when no foot-transfer
 * artifact is loaded — callers must handle that case.
 */
export function makeOsmTransferLookup(
  ft: FootTransfers | undefined,
): OsmTransferLookup | undefined {
  if (!ft) return undefined;
  return {
    getWalkSecs(fromStopId, toStopId) {
      const fromIdx = ft.stopIdToIdx.get(fromStopId);
      if (fromIdx === undefined) return undefined;
      const start = ft.offsets[fromIdx];
      const end = ft.offsets[fromIdx + 1];
      for (let e = start; e < end; e++) {
        if (ft.stopIds[ft.neighborIx[e]] === toStopId) {
          return ft.walkSecs[e];
        }
      }
      return undefined;
    },
  };
}

/**
  * Index a decoded PTFT transfer table into the stop-keyed `FootTransfers` CSR
 * the RAPTOR consumer uses. Exported so the P2 differential harness can build
 * the SAME structure the production read path builds (`loadFootTransfers`),
 * decode bytes → `indexTransfers` → `hydrate(..., footTransfers)`, without
 * duplicating the CSR wiring.
 */
export function indexTransfers(decoded: DecodedTransfers): FootTransfers {
  const stopIdToIdx = new Map<string, number>();
  for (let i = 0; i < decoded.stopIds.length; i++) {
    stopIdToIdx.set(decoded.stopIds[i], i);
  }
  return {
    stopIds: decoded.stopIds,
    stopIdToIdx,
    neighborIx: decoded.adj.neighborIx,
    walkSecs: decoded.adj.walkSecs,
    offsets: decoded.adj.offsets,
  };
}

/**
 * Build stop_id → route-index map unioning ONLY `stopIds` for each entry (NOT
 * directionPatterns). Used for the SCAN `patternsAtStop` — the scan indexes pattern.stopIds
 * positions only.
 */
function buildPatternAtStop(rs: RaptorIndexRoute[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (let idx = 0; idx < rs.length; idx++) {
    // Deduplicate: a loop/lasso route may repeat a stop in stopIds; add the pattern index ONCE per
    // stop (mirrors the Rust `seen: HashSet<u32>` guard in `Index::build` Unbounded mode, Pin 5).
    const seen = new Set<string>();
    for (const stopId of rs[idx].stopIds) {
      if (seen.has(stopId)) continue;
      seen.add(stopId);
      let arr = m.get(stopId);
      if (!arr) { arr = []; m.set(stopId, arr); }
      arr.push(idx);
    }
  }
  return m;
}

/**
 * Build stop_id → route-index map unioning canonical `stopIds` with every
 * direction pattern. This is the DISPLAY `routesAtStop` fold (see note in
 * the original code about bidirectional routes / sibling-surfaces). Used for
 * display `routesAtStop` only — NOT scan `patternsAtStop`.
 */
function buildDisplayAtStop(rs: RaptorIndexRoute[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (let idx = 0; idx < rs.length; idx++) {
    // Union canonical `stopIds` with every direction pattern so return-only
    // stops on bidirectional routes (opposite-side-of-road siblings) are
    // discoverable by stop-keyed lookups. Without this, sibling surfaces
    // like `activeRouteIdsAtStop` short-circuit to "no routes" for those
    // stops and urban mode hides them entirely. See the known defects notes
    // (sibling-surfaces canonical-stopIds entry).
    const stops = new Set<string>(rs[idx].stopIds);
    for (const dp of rs[idx].directionPatterns ?? []) {
      for (const sid of dp.stopIds) stops.add(sid);
    }
    for (const stopId of stops) {
      let arr = m.get(stopId);
      if (!arr) { arr = []; m.set(stopId, arr); }
      arr.push(idx);
    }
  }
  return m;
}

/**
 * Re-align one pattern's trips onto a DISPLAY route's canonical `stopIds`.
 *
 * The wire (and `hydrate`) store each trip's `departureSecs` aligned to its
 * OWN pattern's `stopIds` (length = that pattern's stop count), with `-1` for
 * stops the trip skips within the pattern (see `ptbToBundleWire.ts`). The
 * display surfaces (`hasUpcomingDeparture.ts`, `nextDeparture.ts`) index by the
 * CANONICAL column: `stopIdx = route.stopIds.indexOf(stopId)` then
 * `trip.departureSecs[stopIdx]`. So a trip from a SHORTER/branch pattern, kept
 * verbatim, would have its `departureSecs` read at the wrong column (or
 * `undefined`) once it sits under the longest pattern's canonical `stopIds`.
 *
 * Rebuild each trip's `departureSecs` (and the parallel `dwellSecs`, if present)
 * to length `canonical.length`, filled with the unserved sentinel `-1` (dwell
 * filled with `0`), mapping each of the pattern's own positions to its canonical
 * column. The pattern's stops that are NOT on the canonical (genuine
 * off-canonical branch stops) have no canonical column and are dropped from the
 * DISPLAY trip — display is lossy by design; routing reads `patternsAtStop`, and
 * the display consumers' return-only-stop fallback covers branch-only stops via
 * `directionPatterns`.
 *
 * Repeated stops (lasso/loop canonical revisits a stop) are handled with the
 * SAME positional/cursor convention as `ptbToBundleWire.ts`: `canonicalPos` maps
 * a stop_id to its ASCENDING list of canonical positions, and a per-trip cursor
 * consumes one position per occurrence in the pattern's `stopIds` order. The
 * longest pattern's own trips re-align to its own sequence — an identity map, a
 * no-op (every position maps 1:1 to itself).
 */
function realignTripsToCanonical(
  pattern: RaptorIndexRoute,
  canonical: string[],
  canonicalPos: Map<string, number[]>,
): RaptorIndexRoute["trips"] {
  return pattern.trips.map((t) => {
    const departureSecs = new Array<number>(canonical.length).fill(-1);
    let dwellSecs: number[] | undefined;
    // Pickup/drop_off types re-align identically to dwellSecs: the source arrays
    // (`t.pickupTypes`/`t.dropOffTypes`) are indexed by this pattern's own positions
    // `i`; map each `i → pos` so the canonical-aligned arrays the scan reads stay in
    // step with `departureSecs`. Lazy-alloc; omit when all-default.
    let pickupTypes: number[] | undefined;
    let dropOffTypes: number[] | undefined;
    // Per-trip cursor over canonical positions, mirroring the lasso/loop
    // handling in ptbToBundleWire.ts: consume occurrences in pattern order.
    const cursor = new Map<string, number>();
    for (let i = 0; i < pattern.stopIds.length; i++) {
      const positions = canonicalPos.get(pattern.stopIds[i]);
      if (positions === undefined) continue; // off-canonical branch stop — dropped
      const k = cursor.get(pattern.stopIds[i]) ?? 0;
      if (k >= positions.length) continue; // pattern visits this stop more often than canonical
      const pos = positions[k];
      cursor.set(pattern.stopIds[i], k + 1);
      const dep = t.departureSecs[i];
      // A `-1`/absent source column means the pattern itself doesn't serve this
      // occurrence — keep the sentinel so downstream repeats stay aligned.
      if (dep === undefined || dep === -1) continue;
      departureSecs[pos] = dep;
      const dwell = t.dwellSecs?.[i];
      if (dwell !== undefined && dwell !== 0) {
        if (!dwellSecs) dwellSecs = new Array<number>(canonical.length).fill(0);
        dwellSecs[pos] = dwell;
      }
      const pickup = t.pickupTypes?.[i];
      if (pickup !== undefined && pickup !== 0) {
        (pickupTypes ??= new Array<number>(canonical.length).fill(0))[pos] = pickup;
      }
      const dropOff = t.dropOffTypes?.[i];
      if (dropOff !== undefined && dropOff !== 0) {
        (dropOffTypes ??= new Array<number>(canonical.length).fill(0))[pos] = dropOff;
      }
    }
    return {
      ...t,
      departureSecs,
      ...(dwellSecs ? { dwellSecs } : {}),
      ...(pickupTypes ? { pickupTypes } : {}),
      ...(dropOffTypes ? { dropOffTypes } : {}),
    };
  });
}

/**
 * Aggregate per-pattern objects into ONE display route per route_id: - stopIds = the longest
 * pattern's sequence (canonical for display) - trips = union of all patterns' trips, re-aligned
 * to the canonical stopIds (so every display consumer that reads `departureSecs[canonicalIdx]`
 * is correct), then re-sorted by departureSecs[0] - directionPatterns carried through if
 * present

 *
 * Under Off there is exactly one pattern per route_id and its own sequence IS
 * the canonical, so the re-alignment is an identity map — byte-identical output.
 */
function aggregateDisplay(patterns: RaptorIndexRoute[]): {
  routes: RaptorIndexRoute[];
  routeIdToIdx: Map<string, number>;
  routesAtStop: Map<string, number[]>;
} {
  // Pass 1: group patterns by route_id, determine the canonical (longest)
  // stopIds, and accumulate directionPatterns. Trip re-alignment is deferred to
  // pass 2 because the canonical sequence is only known after every pattern for
  // the id has been seen (a LATER, longer pattern can replace it — and then
  // even the earlier patterns' trips must re-align to the new canonical).
  const byId = new Map<
    string,
    { route: RaptorIndexRoute; patterns: RaptorIndexRoute[] }
  >();
  const order: string[] = [];
  for (const p of patterns) {
    const existing = byId.get(p.id);
    if (!existing) {
      byId.set(p.id, { route: { ...p, trips: [] }, patterns: [p] });
      order.push(p.id);
      continue;
    }
    existing.patterns.push(p);
    // longest pattern's sequence becomes the canonical display stopIds
    if (p.stopIds.length > existing.route.stopIds.length) {
      existing.route.stopIds = p.stopIds;
    }
    if (p.directionPatterns) {
      const merged = [
        ...(existing.route.directionPatterns ?? []),
        ...p.directionPatterns,
      ];
      // Dedup by (direction key, headsign). A direction_id may legitimately
      // have multiple branch headsigns, so key-only dedup drops valid patterns.
      // (Network path; no-op on the PTB path where directionPatterns is absent.)
      existing.route.directionPatterns = merged.filter(
        (dp, i, arr) => arr.findIndex(
          (x) => x.key === dp.key && x.headsign === dp.headsign,
        ) === i,
      );
    }
  }
  // Pass 2: re-align every pattern's trips to the finalized canonical stopIds
  // and union them, then sort by canonical departureSecs[0].
  const routes = order.map((id) => {
    const { route, patterns: ps } = byId.get(id)!;
    const canonical = route.stopIds;
    // stop_id → ascending list of canonical positions (repeated stops on
    // lasso/loop canonical keep one entry per occurrence — Pin 3).
    const canonicalPos = new Map<string, number[]>();
    canonical.forEach((sid, pos) => {
      let positions = canonicalPos.get(sid);
      if (!positions) { positions = []; canonicalPos.set(sid, positions); }
      positions.push(pos);
    });
    const trips: RaptorIndexRoute["trips"] = [];
    for (const p of ps) {
      trips.push(...realignTripsToCanonical(p, canonical, canonicalPos));
    }
    trips.sort((a, b) => a.departureSecs[0] - b.departureSecs[0]);
    route.trips = trips;
    return route;
  });
  const routeIdToIdx = new Map(routes.map((r, i) => [r.id, i]));
  return { routes, routeIdToIdx, routesAtStop: buildDisplayAtStop(routes) };
}

/**
 * Build a `RaptorIndex` from raw route/trip/service/stop records. Exported so
 * the P2 differential harness can hydrate an index from the `.ptb → wire`
 * adapter output without going through Dexie (`rawFromBundle` → `hydrate`),
 * exercising the SAME `routesAtStop` fold the production read path uses.
 *
 * @param raw
 * - Raw records. Each `routeRecords[i]` carries its own inline
 *   `trips` (populated by `rawFromBundle` from `wire.routes[i].trips` or by
 *   `buildRaptorIndex` from the Dexie fallback regroup). The
 *   `tripsByRoute.get(r.id)` regroup is dropped — it is ambiguous when
 *   records share a route_id under Unbounded per-pattern wire.
 * @param footTransfers
 * - Optional pedestrian transfer table.
 * @param mode
 * - PatternMode flag. Default `Off` so callers that omit the
 *   argument retain the canonical Off-mode result.
 */
export function hydrate(
  { routeRecords, serviceRecords, stopRecords, transferRecords, frequencyRecords }: Raw,
  footTransfers?: FootTransfers,
  mode: PatternMode = PatternMode.Off,
): RaptorIndex {
  // Build per-pattern objects 1:1 with routeRecords. Each record's inline
  // `trips` is already associated to the correct record — no regroup needed.
  const built: RaptorIndexRoute[] = routeRecords.map((r) => ({
    id: r.id,
    shortName: r.shortName,
    mode: r.mode,
    color: r.color,
    textColor: r.textColor,
    stopIds: r.stopIds,
    trips: (r.trips ?? [])
      .slice()
      .sort((a, b) => a.departureSecs[0] - b.departureSecs[0]),
    ...(r.directionPatterns && r.directionPatterns.length > 0
      ? { directionPatterns: r.directionPatterns }
      : {}),
  }));

  let routes: RaptorIndexRoute[];
  let routeIdToIdx: Map<string, number>;
  let routesAtStop: Map<string, number[]>;
  let patterns: RaptorIndexRoute[] | undefined;
  let patternsAtStop: Map<string, number[]> | undefined;

  if (patternsEnabled(mode)) {
    // Scan model: one entry per wire record (= one per pattern), 1:1.
    patterns = built;
    // Scan patternsAtStop unions ONLY each pattern's own stopIds (NOT
    // directionPatterns — the scan indexes pattern.stopIds positions only).
    patternsAtStop = buildPatternAtStop(patterns);
    // Display model: aggregate by route_id so the ~8 display surfaces see one
    // entry per route_id with the longest stopIds sequence and union of trips.
    ({ routes, routeIdToIdx, routesAtStop } = aggregateDisplay(patterns));
  } else {
    // Off: single record per route_id, build display model directly.
    routes = built;
    routeIdToIdx = new Map(routes.map((r, i) => [r.id, i]));
    routesAtStop = buildDisplayAtStop(routes);
    // patterns / patternsAtStop remain undefined — scan falls back to routes.
  }

  const services = new Map<string, RaptorIndexService>();
  for (const s of serviceRecords) {
    services.set(s.serviceId, {
      serviceId: s.serviceId, days: s.days,
      startDate: s.startDate, endDate: s.endDate, exceptions: s.exceptions,
    });
  }

  const stopWheelchairBoarding = new Map<string, number>();
  for (const s of stopRecords) {
    if (s.wheelchairBoarding !== undefined && s.wheelchairBoarding !== 0) {
      stopWheelchairBoarding.set(s.id, s.wheelchairBoarding);
    }
  }

  // GTFS transfers.txt → applied-rule lookups. Insert ONLY rules the scan
  // actually acts on, with WELL-DEFINED values, so the apply path never sees an
  // under-specified rule and the two engines can never diverge on one. Three
  // lookups by scope (S1/S2 = unscoped; S3 adds scoped):
  //   - UNSCOPED (no from/to route AND no from/to trip) → `transferRules`,
  //     keyed by `transferRuleKey`.
  //   - TRIP-SCOPED (BOTH from_trip_id AND to_trip_id present) →
  //     `transferRulesTripScoped`, keyed by `transferTripScopedKey` (most
  //     specific; route fields are ignored for keying on a trip-scoped row).
  //   - ROUTE-SCOPED (BOTH from_route_id AND to_route_id present, and NOT
  //     trip-scoped) → `transferRulesRouteScoped`, keyed by
  //     `transferRouteScopedKey`.
  // Rows that are partially scoped (e.g. only from_trip_id, or from_route_id +
  // to_trip_id) match none of the three predicates and are DROPPED on BOTH
  // engines — the spec's specificity ladder is the 3 named levels exactly.
  //
  // Actionable `transfer_type` per scope:
  //   - type 3 (not possible): kept for any row (no min needed).
  //   - type 2 (min_transfer_time): kept ONLY when `min_transfer_time` is
  //     present. A spec-invalid type-2 row with NO min (real feeds emit it) is
  //     SKIPPED, not inserted with `minSecs` undefined — otherwise the apply
  //     would read `rule.minSecs!` = undefined → NaN floor, while the Rust
  //     engine would read its `TRANSFER_ABSENT` sentinel as an enormous floor.
  //     Both engines drop it identically → the pair falls through to the global
  //     RAPTOR_MIN_TRANSFER_SECS.
  //   - type 1 (timed / guaranteed connection): kept for any row (S2). Carries
  //     NO min (the floor is the constant 0), so no min-presence guard.
  //   - type 4 (in-seat / stay-seated, S3): kept for any row. Carries no min;
  //     the apply uses a per-pair floor of 0 AND marks the board in-seat (the
  //     transfer-count exclusion lives in reconstruction).
  //   - type 5 (in-seat forbidden, S3): kept for any row. It is a documented
  //     NO-OP — the engine never performs a stay-seated continuation, so
  //     "in-seat forbidden" is already its default. We keep it so the apply can
  //     resolve a type-5 rule to the NORMAL global floor (no special effect)
  //     and so a type-5 row SHADOWS a less-specific actionable rule on the same
  //     scope chain (most-specific-wins). type 0 (recommended) is non-actionable
  //     and dropped (falls through to the global floor).
  // On a duplicate actionable key within a scope the LAST row wins (matches the
  // Rust HashMap insert order over `reader.transfer(i)`). Apply-time precedence
  // is trip-scoped > route-scoped > unscoped, then type 3 > 2 > 1/4 > 5/global.
  // GTFS reference:
  // https://gtfs.org/documentation/schedule/reference/#transferstxt
  const isActionableType = (ty: number, hasMin: boolean): boolean =>
    ty === 3 || (ty === 2 && hasMin) || ty === 1 || ty === 4 || ty === 5;

  const transferRules = new Map<string, TransferRule>();
  const transferRulesTripScoped = new Map<string, TransferRule>();
  const transferRulesRouteScoped = new Map<string, TransferRule>();
  for (const t of transferRecords ?? []) {
    if (!isActionableType(t.transferType, t.minTransferSecs !== undefined)) continue;
    const rule: TransferRule = {
      type: t.transferType,
      ...(t.minTransferSecs !== undefined ? { minSecs: t.minTransferSecs } : {}),
    };
    const tripScoped = t.fromTripId !== undefined && t.toTripId !== undefined;
    const routeScoped = t.fromRouteId !== undefined && t.toRouteId !== undefined;
    const unscoped =
      t.fromRouteId === undefined &&
      t.toRouteId === undefined &&
      t.fromTripId === undefined &&
      t.toTripId === undefined;
    if (tripScoped) {
      transferRulesTripScoped.set(
        transferTripScopedKey(t.fromStopId, t.toStopId, t.fromTripId!, t.toTripId!),
        rule,
      );
    } else if (routeScoped) {
      transferRulesRouteScoped.set(
        transferRouteScopedKey(t.fromStopId, t.toStopId, t.fromRouteId!, t.toRouteId!),
        rule,
      );
    } else if (unscoped) {
      transferRules.set(transferRuleKey(t.fromStopId, t.toStopId), rule);
    }
    // else: partially-scoped row — dropped on both engines.
  }

  let frequenciesByTrip: Map<number, FrequencyWindow[]> | undefined;
  if (frequencyRecords && frequencyRecords.length > 0) {
    frequenciesByTrip = new Map();
    for (const f of frequencyRecords) {
      let rows = frequenciesByTrip.get(f.tripIdx);
      if (!rows) { rows = []; frequenciesByTrip.set(f.tripIdx, rows); }
      rows.push(f);
    }
    for (const rows of frequenciesByTrip.values()) {
      rows.sort((a, b) => a.startSecs - b.startSecs || a.endSecs - b.endSecs || a.headwaySecs - b.headwaySecs);
    }
  }

  return {
    routes,
    routeIdToIdx,
    routesAtStop,
    services,
    stopWheelchairBoarding,
    ...(footTransfers ? { footTransfers } : {}),
    transferRules,
    transferRulesTripScoped,
    transferRulesRouteScoped,
    ...(patterns !== undefined ? { patterns, patternsAtStop } : {}),
    ...(frequenciesByTrip ? { frequenciesByTrip } : {}),
  };
}

/**
 * Project a `RaptorBundleWire` into the flat `Raw` record shape `hydrate`
 * consumes. Exported for the P2 differential harness (see `hydrate`).
 *
 * Each `routeRecords[i]` carries its own inline `trips` from
 * `wire.routes[i].trips` — this is safe across both Off (one record per
 * route_id) and Unbounded (one record per pattern, multiple records may share
 * a route_id). The flat `tripRecords` is retained for the Dexie fallback
 * only; `hydrate` no longer reads it on the bundle path.
 *
 * @param wire
 * - The decoded `RaptorBundleWire`.
 * @param _mode
 * - Unused. `rawFromBundle` is mode-agnostic — the raw record
 *   shape it emits does not depend on PatternMode (mode is consumed by
 *   `hydrate`, not here). The param exists only so call sites can pass
 *   `(wire, mode)` symmetrically with `hydrate(raw, transfers, mode)`.
 */
export function rawFromBundle(
  wire: RaptorBundleWire,
  _mode: PatternMode = PatternMode.Off,
): Raw {
  let inlineFallbackTripIdx = 0;
  const routeRecords = wire.routes.map((r) => ({
    id: r.id,
    shortName: r.shortName,
    mode: r.mode as TransportMode,
    color: r.color,
    textColor: r.textColor,
    stopIds: r.stopIds,
    directionPatterns: r.directionPatterns,
    // Inline trips for THIS record only (per-pattern safe — no id regroup).
    trips: r.trips.map((t) => {
      const fallbackTripIdx = inlineFallbackTripIdx++;
      return {
        tripId: t.tripId,
        serviceId: t.serviceId,
        headsign: t.headsign,
        directionId: t.directionId,
        ptbTripIdx: t.ptbTripIdx ?? fallbackTripIdx,
        departureSecs: t.departureSecs,
        dwellSecs: t.dwellSecs,
        pickupTypes: t.pickupTypes,
        dropOffTypes: t.dropOffTypes,
        wheelchairAccessible: t.wheelchairAccessible,
        bikesAllowed: t.bikesAllowed,
        shapeId: t.shapeId,
      };
    }),
  }));
  // Flat tripRecords retained for the Dexie fallback path in
  // `buildRaptorIndex` (which regrouped by routeId). `hydrate` no longer
  // reads this on the bundle path — it reads routeRecords[i].trips directly.
  let flatFallbackTripIdx = 0;
  const tripRecords = wire.routes.flatMap((r) =>
    r.trips.map((t) => {
      const fallbackTripIdx = flatFallbackTripIdx++;
      return {
        tripId: t.tripId,
        routeId: r.id,
        serviceId: t.serviceId,
        headsign: t.headsign,
        directionId: t.directionId,
        ptbTripIdx: t.ptbTripIdx ?? fallbackTripIdx,
        departureSecs: t.departureSecs,
        dwellSecs: t.dwellSecs,
        pickupTypes: t.pickupTypes,
        dropOffTypes: t.dropOffTypes,
        wheelchairAccessible: t.wheelchairAccessible,
        bikesAllowed: t.bikesAllowed,
        shapeId: t.shapeId,
      };
    }),
  );
  const serviceRecords = wire.calendar.map((s) => ({
    serviceId: s.serviceId,
    days: s.days,
    startDate: s.startDate,
    endDate: s.endDate,
    exceptions: s.exceptions,
  }));
  const stopRecords = wire.stops.map((s) => ({
    id: s.id,
    name: s.name,
    lat: s.lat,
    lon: s.lon,
    wheelchairBoarding: s.wheelchairBoarding,
  }));
  // This JS planner keys every rule by its stop pair (the v1 contract), so a
  // stopless PTB v2 linked row (transfer_type 4/5) has nothing to key on and is
  // skipped. v1 rows always carry both stops; v2 linked semantics live in the
  // pt-core v2 engine.
  const transferRecords = wire.transfers?.flatMap((t) => {
    if (t.fromStopId === undefined || t.toStopId === undefined) return [];
    return [{
      fromStopId: t.fromStopId,
      toStopId: t.toStopId,
      transferType: t.transferType,
      minTransferSecs: t.minTransferSecs,
      fromRouteId: t.fromRouteId,
      toRouteId: t.toRouteId,
      fromTripId: t.fromTripId,
      toTripId: t.toTripId,
    }];
  });
  const frequencyRecords = wire.frequencies?.map((f) => ({
    tripIdx: f.tripIdx,
    startSecs: f.startSecs,
    endSecs: f.endSecs,
    headwaySecs: f.headwaySecs,
    exactTimes: f.exactTimes,
  }));
  return { routeRecords, tripRecords, serviceRecords, stopRecords, transferRecords, frequencyRecords };
}

/**
 * Feature flag for the blob-first read path. Defaults on — the blob is a
 * strict superset of the Dexie tables and the fallback is immediate if the
 * blob is absent or decode fails. Opt-out exists so we can disable quickly
 * via env without a redeploy if something surprises us on staging.
 */
const BUNDLE_READ_ENABLED =
  (import.meta.env.VITE_GTFS_BUNDLE_READ as string | undefined) !== "0";

export async function buildRaptorIndex(
  opts: { signal?: AbortSignal } = {},
): Promise<RaptorIndex> {
  if (BUNDLE_READ_ENABLED) {
    try {
      const cityId = useCityStore.getState().activeCity.id;
      const wire = await readGtfsBundle(cityId);
      if (wire) {
        const footTransfers = await loadFootTransfers(wire, opts.signal);
        // Pass PATTERN_MODE so per-pattern wire (Unbounded) builds
        // patterns[]/patternsAtStop and aggregates the display model.
        const index = hydrate(rawFromBundle(wire, PATTERN_MODE), footTransfers, PATTERN_MODE);
        // Surface the bundle's agency tz so the warm-start drift guard can cross-check it against
        // CityConfig.tz. `hydrate` consumes only the projected `Raw` — the raw `wire.meta` is
        // dropped — so we attach it here on the blob path. `undefined` on the Dexie fallback.
        if (wire.meta.cityTzIana !== undefined) {
          index.cityTzIana = wire.meta.cityTzIana;
        }
        return index;
      }
    } catch (err) {
      console.warn("gtfsBundle read failed, falling back to Dexie tables:", err);
    }
  }

  const [rawRouteRecords, rawTripRecords, serviceRecords, stopRecords, syncMeta] = await Promise.all([
    db.gtfsRoutes.toArray(),
    db.gtfsTrips.toArray(),
    db.gtfsServices.toArray(),
    db.gtfsStops.toArray(),
    db.gtfsSyncMeta.get("current"),
  ]);
  const tripRecords = rawTripRecords.map((t, i) => ({
    ...t,
    ptbTripIdx: t.ptbTripIdx ?? i,
  }));

  // The transfers artifact URL only lives in the bundle wire; on the
  // Dexie fallback it is unreachable, so RAPTOR falls back to
  // haversine without the OSM-routed footpaths. Surface this so
  // operators notice if staging silently degrades.
  console.warn(
    "raptorIndex hydrated from Dexie tables; pre-computed pedestrian transfers unavailable on this path",
  );

  // The Dexie path is always single-pattern / Off-equivalent. Group
  // tripRecords by routeId into each record's inline `trips` field so hydrate
  // can read per-record trips without a regroup. Pass PatternMode.Off
  // explicitly — per-pattern routing is only on the blob/wire path.
  const tripsByRouteId = new Map<string, typeof tripRecords>();
  for (const t of tripRecords) {
    let arr = tripsByRouteId.get(t.routeId);
    if (!arr) { arr = []; tripsByRouteId.set(t.routeId, arr); }
    arr.push(t);
  }
  const routeRecords = rawRouteRecords.map((r) => ({
    ...r,
    trips: (tripsByRouteId.get(r.id) ?? []).map((t) => ({
      tripId: t.tripId,
      serviceId: t.serviceId,
      headsign: t.headsign,
      directionId: t.directionId,
      ptbTripIdx: t.ptbTripIdx,
      departureSecs: t.departureSecs,
      dwellSecs: t.dwellSecs,
      wheelchairAccessible: t.wheelchairAccessible,
      bikesAllowed: t.bikesAllowed,
      shapeId: t.shapeId,
    })),
  }));

  const frequencyRecords = syncMeta?.frequencies?.map((f) => ({
    tripIdx: f.tripIdx,
    startSecs: f.startSecs,
    endSecs: f.endSecs,
    headwaySecs: f.headwaySecs,
    exactTimes: f.exactTimes,
  }));

  return hydrate({ routeRecords, tripRecords, serviceRecords, stopRecords, frequencyRecords }, undefined, PatternMode.Off);
}

async function loadFootTransfers(
  wire: RaptorBundleWire,
  signal?: AbortSignal,
): Promise<FootTransfers | undefined> {
  const artifact = getTransfersManifest(wire);
  if (!artifact) return undefined;
  try {
    const decoded = await fetchTransfersArtifact(artifact.url, artifact.hash, { signal });
    return indexTransfers(decoded);
  } catch (err) {
    console.warn("transfers artifact fetch/decode failed; haversine fallback:", err);
    return undefined;
  }
}
