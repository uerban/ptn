import { parse } from "csv-parse";
import type {
  GtfsStop,
  GtfsRoute,
  GtfsTrip,
  GtfsStopTime,
  GtfsService,
  GtfsCalendarDate,
  CompactStopTimes,
  TripStringTable,
} from "./parser.js";
import { parseTimeToSecs, buildTripStringTable } from "./parser.js";
import { type OrphanTracker } from "./referentialIntegrity.js";
import { testIdentityWith } from "./identity/testIdentity.js";
import type { RoutingBuildInput } from "./views/RoutingView.js";
import type { RouteDirectionPattern } from "@pt/shared";
import { PatternMode, patternsEnabled, groupTripsByPattern } from "@pt/shared";
import { createCanonicalStore, type CanonicalStore } from "./canonical/CanonicalStore.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type { CompactStopTimes, TripStringTable } from "./parser.js";
export type { RoutingBuildInput } from "./views/RoutingView.js";

export interface BuildResult {
  /** Legacy monolithic indexes — will continue shrinking in future cleanup. */
  indexes: GtfsIndexes;
  /** Source-of-truth canonical store. Owned for the lifetime of this BuildResult + downstream swap. */
  canonical: CanonicalStore;
  /** Transient per-route schedule data — consumed by buildRoutingView, then released. */
  routingInput: RoutingBuildInput;
}

export interface GtfsIndexes {
  /** Stop → Set of route-ids that serve it (filtered by minTripsPerRoute). Consumed by MapView at build only. */
  stopRoutes: Map<string, Set<string>>;
  /** Raw (stop, route) → trip-count. Consumed by MapView at build only. */
  stopRouteTripCounts: Map<string, Map<string, number>>;
  /**
   * Ordered route records for MapView's `routeStopIndex` (stopId lookup). One
   * entry per canonical route in Off mode; one entry per pattern (repeated
   * routeId) in Unbounded mode. `stopIds` is the canonical/pattern stop
   * sequence. MapView uses only the `stopIds` for stop→route index building.
   */
  routeTrips: { routeId: string; stopIds: string[] }[];
  /** Always-resident per-city intern tables + service bitmasks. */
  readonly identity: import("./identity/types.js").Identity;
}

// ── Shared helpers ────────────────────────────────────────────────────────

function buildServicesIndex(
  services: GtfsService[],
  calendarDates: GtfsCalendarDate[],
): Map<string, GtfsService & { exceptions: Map<string, number> }> {
  const servicesIndex = new Map<
    string,
    GtfsService & { exceptions: Map<string, number> }
  >();

  for (const svc of services) {
    servicesIndex.set(svc.serviceId, {
      ...svc,
      exceptions: new Map<string, number>(),
    });
  }

  for (const cd of calendarDates) {
    let entry = servicesIndex.get(cd.serviceId);
    if (entry === undefined) {
      entry = {
        serviceId: cd.serviceId,
        monday: false,
        tuesday: false,
        wednesday: false,
        thursday: false,
        friday: false,
        saturday: false,
        sunday: false,
        startDate: "",
        endDate: "",
        exceptions: new Map<string, number>(),
      };
      servicesIndex.set(cd.serviceId, entry);
    }
    entry.exceptions.set(cd.date, cd.exceptionType);
  }

  return servicesIndex;
}

function buildStopRoutesFromCounts(
  stopRouteTripCounts: Map<string, Map<string, number>>,
  minTripsPerRoute: number,
): Map<string, Set<string>> {
  const stopRoutesIndex = new Map<string, Set<string>>();
  for (const [stopId, routeMap] of stopRouteTripCounts) {
    const filtered = new Set<string>();
    for (const [routeId, count] of routeMap) {
      if (count >= minTripsPerRoute) {
        filtered.add(routeId);
      }
    }
    if (filtered.size > 0) {
      stopRoutesIndex.set(stopId, filtered);
    }
  }
  return stopRoutesIndex;
}

/** Route trip entry for RAPTOR export */
interface RouteTripEntry {
  tripId: string;
  serviceId: string;
  headsign: string;
  /**
   * Per-stop departure seconds aligned to the enclosing route's stopIds.
   * Sentinel `0xFFFFFFFF` means this trip variant does not serve that stop.
   * Stored as Uint32Array (vs boxed number[]) to save ~40–80 MB of V8 array
   * object overhead on Paris-scale feeds (~400k trips). Wire format (RAPTOR
   * export) converts back to number[] with -1 sentinel — see store.ts.
   */
  departureSecs: Uint32Array;
  /**
   * Per-stop dwell = `departure_time − arrival_time`, aligned to stopIds.
   * Only materialised for trips that have any non-zero dwell (typically a
   * handful: loop routes pausing at a terminus). `undefined` means "zero
   * dwell everywhere" and saves a `stopIds.length * 2 bytes` allocation on
   * the vast majority of trips. Uint16Array — dwells cap at 65,535s which
   * is well beyond the operational range (a full-hour terminus is 3,600s).
   */
  dwellSecs?: Uint16Array;
  /**
   * Per-stop GTFS pickup_type, aligned to stopIds. Only materialised when at
   * least one stop has a non-zero value. Uint8Array — values 0–3 per spec.
   */
  pickupTypes?: Uint8Array;
  /**
   * Per-stop GTFS drop_off_type, aligned to stopIds. Same layout as pickupTypes.
   */
  dropOffTypes?: Uint8Array;
}

/** Sentinel placed in RouteTripEntry.departureSecs when a trip variant skips
 *  a stop in the route's canonical stopIds sequence. Uint32Array can't hold
 *  -1, so we use the max uint32 as the unserved marker. Wire format keeps -1. */
export const UNSERVED_STOP_SENTINEL = 0xFFFFFFFF;

/** Route trips index entry. Under Unbounded mode multiple records share a routeId (one per pattern). */
interface RouteTripsData {
  /** The bare GTFS route_id. Repeated under Unbounded mode (one entry per pattern). */
  routeId: string;
  stopIds: string[];
  trips: RouteTripEntry[];
  /**
   * Per-direction stop sequences preserving return-only stops that the
   * canonical longest-trip-derived `stopIds` drops on bidirectional routes.
   * See `RouteDirectionPattern` (`@pt/shared`) for the shape contract.
   */
  directionPatterns: RouteDirectionPattern[];
}

/**
 * Per-trip stop_time entry accumulated during parse. `arrivalSecs` is
 * optional — when the feed provides no arrival_time column (or its value
 * equals departure_time, which the parser collapses to `undefined`), the
 * dwell at this stop is zero and we leave the field off.
 */
export interface TripStopSeqEntry {
  stopId: string;
  departureSecs: number;
  arrivalSecs?: number;
  /** GTFS pickup_type (0 = regular/default). Omitted when 0. */
  pickupType?: number;
  /** GTFS drop_off_type (0 = regular/default). Omitted when 0. */
  dropOffType?: number;
  seq: number;
}

/**
 * Build routeTrips index from per-trip stop time sequences.
 * @param tripStopSeqs  tripId → array of { stopId, departureSecs, seq } entries
 * @param tripsIndex    tripId → GtfsTrip for looking up routeId/serviceId/headsign
 * @param mode          PatternMode flag (default Off). Under Unbounded, groups each
 *                      route's trips by stop-sequence signature and emits one
 *                      RouteTripsData per pattern (repeated routeId). Under Off, the
 *                      single longest-canonical path is emitted — byte-identical to
 *                      pre-pattern behaviour.
 */
export function buildRouteTripsIndex(
  tripStopSeqs: Map<string, TripStopSeqEntry[]>,
  tripsIndex: Map<string, GtfsTrip>,
  mode: PatternMode = PatternMode.Off,
): RouteTripsData[] {
  // Group trips by routeId (preserving insertion order for determinism)
  const routeTripMap = new Map<string, string[]>();
  for (const [tripId] of tripStopSeqs) {
    const trip = tripsIndex.get(tripId);
    if (!trip) continue;
    let tripIds = routeTripMap.get(trip.routeId);
    if (!tripIds) {
      tripIds = [];
      routeTripMap.set(trip.routeId, tripIds);
    }
    tripIds.push(tripId);
  }

  const result: RouteTripsData[] = [];

  for (const [routeId, tripIds] of routeTripMap) {
    // Derive route stop sequence from the longest trip (most stops) to avoid
    // express trips that skip intermediate stops producing incomplete sequences.
    let longestTripId = tripIds[0];
    let longestLen = tripStopSeqs.get(tripIds[0])?.length ?? 0;
    for (let ti = 1; ti < tripIds.length; ti++) {
      const len = tripStopSeqs.get(tripIds[ti])?.length ?? 0;
      if (len > longestLen) {
        longestLen = len;
        longestTripId = tripIds[ti];
      }
    }
    const longestTripSeqs = tripStopSeqs.get(longestTripId)!;
    const sortedLongest = [...longestTripSeqs].sort((a, b) => a.seq - b.seq);
    const stopIds = sortedLongest.map((s) => s.stopId);
    // Lasso / loop routes revisit a stop within a SINGLE trip (Vilnius 6G:
    // stem out → loop → stem back), so the canonical stopIds contain repeats.
    // GTFS best-practices model this as one trip whose stop_times lists the
    // stop twice; check the spec for the canonical case/example before changing
    // this alignment:
    //   https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
    //   https://gtfs.org/documentation/schedule/schedule-best-practices/#loop-routes
    // Map each stopId to the LIST of its canonical positions (ascending). A
    // single-position map (last-write-wins) would leave the OUTBOUND occurrence
    // of every repeated stop unserved, making the stem unboardable.
    const stopIdToPositions = new Map<string, number[]>();
    for (let i = 0; i < stopIds.length; i++) {
      let positions = stopIdToPositions.get(stopIds[i]);
      if (!positions) { positions = []; stopIdToPositions.set(stopIds[i], positions); }
      positions.push(i);
    }

    const trips: RouteTripEntry[] = [];
    for (const tripId of tripIds) {
      const trip = tripsIndex.get(tripId)!;
      // Consume occurrences in stop_seq order: walk the trip's rows in sequence
      // and assign each to the NEXT unused canonical position for its stop, via
      // a per-trip cursor. A non-repeated stop has a length-1 position list, so
      // this degrades to the previous single-position behaviour exactly. Sort
      // is required — ordered occurrence-consumption is sequence-sensitive
      // (a plain Map lookup was not).
      const seqs = [...tripStopSeqs.get(tripId)!].sort((a, b) => a.seq - b.seq);
      // Fill departureSecs array aligned to route stop order.
      // Uint32Array — sentinel UNSERVED_STOP_SENTINEL (0xFFFFFFFF) marks
      // stops skipped by this variant trip; wire export rewrites to -1.
      const departureSecs = new Uint32Array(stopIds.length).fill(UNSERVED_STOP_SENTINEL);
      // Track dwells as we assign, but only allocate the Uint16Array when
      // we actually see a non-zero dwell — see RouteTripEntry.dwellSecs.
      let dwellSecs: Uint16Array | undefined;
      let pickupTypes: Uint8Array | undefined;
      let dropOffTypes: Uint8Array | undefined;
      const cursor = new Map<string, number>();
      for (const entry of seqs) {
        const positions = stopIdToPositions.get(entry.stopId);
        if (positions === undefined) continue;
        const k = cursor.get(entry.stopId) ?? 0;
        if (k >= positions.length) continue; // trip visits this stop more often than canonical
        const idx = positions[k]!;
        cursor.set(entry.stopId, k + 1);
        departureSecs[idx] = entry.departureSecs;
        if (entry.arrivalSecs !== undefined) {
          const dwell = entry.departureSecs - entry.arrivalSecs;
          if (dwell > 0) {
            if (!dwellSecs) dwellSecs = new Uint16Array(stopIds.length);
            dwellSecs[idx] =
              dwell > 0xFFFF ? 0xFFFF : dwell;
          }
        }
        if (entry.pickupType !== undefined && entry.pickupType !== 0) {
          if (!pickupTypes) pickupTypes = new Uint8Array(stopIds.length);
          pickupTypes[idx] = entry.pickupType;
        }
        if (entry.dropOffType !== undefined && entry.dropOffType !== 0) {
          if (!dropOffTypes) dropOffTypes = new Uint8Array(stopIds.length);
          dropOffTypes[idx] = entry.dropOffType;
        }
      }
      trips.push({
        tripId,
        serviceId: trip.serviceId,
        headsign: trip.headsign,
        departureSecs,
        ...(dwellSecs ? { dwellSecs } : {}),
        ...(pickupTypes ? { pickupTypes } : {}),
        ...(dropOffTypes ? { dropOffTypes } : {}),
      });
    }

    // Sort trips by first departure time.
    // Normalize the Uint32Array sentinel (0xFFFFFFFF) back to -1 inside the
    // comparator so trips that don't serve the first stop keep sorting to
    // the beginning — preserves legacy ordering from when storage was a
    // signed `number[]` using -1 as the unserved marker.
    trips.sort((a, b) => {
      const a0 = a.departureSecs[0] === UNSERVED_STOP_SENTINEL ? -1 : a.departureSecs[0]!;
      const b0 = b.departureSecs[0] === UNSERVED_STOP_SENTINEL ? -1 : b.departureSecs[0]!;
      return a0 - b0;
    });

    // Per-direction stop sequences. Bucket on `(direction_key, headsign)` so
    // each unique headsign gets its own pattern — feeds with branched trips
    // ("Centras" + "Centras via Saulėtekis" sharing direction_id 0) emit
    // one pattern per headsign, otherwise the frontend's headsign-keyed
    // lookup misses for the second variant and falls back to the canonical
    // (one-direction-only) path. `direction_id` still primarily separates
    // genuinely opposite directions; headsign appended to it disambiguates
    // within a direction. Headsign alone serves as the key when the feed
    // omits direction_id.
    const directionGroups = new Map<string, { directionKey: string; headsign: string; tripIds: string[] }>();
    for (const tripId of tripIds) {
      const trip = tripsIndex.get(tripId);
      if (!trip) continue;
      const directionKey = trip.directionId !== undefined ? String(trip.directionId) : "";
      const compositeKey = directionKey === "" ? trip.headsign : `${directionKey}:${trip.headsign}`;
      let group = directionGroups.get(compositeKey);
      if (!group) {
        group = { directionKey: directionKey || trip.headsign, headsign: trip.headsign, tripIds: [] };
        directionGroups.set(compositeKey, group);
      }
      group.tripIds.push(tripId);
    }
    const directionPatterns: RouteDirectionPattern[] = [];
    for (const group of directionGroups.values()) {
      let bestTripId = group.tripIds[0];
      let bestLen = tripStopSeqs.get(bestTripId)?.length ?? 0;
      for (let ti = 1; ti < group.tripIds.length; ti++) {
        const len = tripStopSeqs.get(group.tripIds[ti])?.length ?? 0;
        if (len > bestLen) {
          bestLen = len;
          bestTripId = group.tripIds[ti];
        }
      }
      const seqs = tripStopSeqs.get(bestTripId);
      // Guard against zero-length stop sequences: a trip with no
      // stop_times rows that survived earlier filtering would otherwise
      // emit a pattern with `stopIds: []`. Pathological feed shape; cheap
      // defense.
      if (!seqs || seqs.length === 0) continue;
      const sorted = [...seqs].sort((a, b) => a.seq - b.seq);
      directionPatterns.push({
        key: group.directionKey,
        headsign: group.headsign,
        stopIds: sorted.map((s) => s.stopId),
      });
    }

    if (!patternsEnabled(mode)) {
      // Off (legacy): emit the single canonical record, byte-identical to pre-pattern.
      // Shallow-copy directionPatterns so the caller holds an independent record.
      result.push({ routeId, stopIds, trips, directionPatterns: directionPatterns.map((p) => ({ ...p })) });
    } else {
      // Unbounded/CoveringMerge: group all trips by their FULL ordered served-stop
      // signature derived from RAW stop ids — NOT from longest-trip canonical
      // positions — and emit one RouteTripsData record per pattern (repeated
      // routeId). Deriving the signature from raw stop ids is what makes
      // off-canonical branch / variant / opposite-direction stops independently
      // routable: a canonical-position derivation drops every stop the longest
      // trip omits (a true branch loses its branch-only stop; disjoint directions
      // collapse to an EMPTY signature). This mirrors the gated sites
      // `ptbBundleToWire.ts::emitWireRoute` and the Rust `index.rs`, plus
      // `loadFromPtb.ts`'s Unbounded grouping, so a network-bundle parity assert
      // against the PTB boot path would pass.
      //
      // Per-ROUTE local stop-id → index map, assigned by FIRST APPEARANCE over ALL stops the
      // route's trips serve (in trip-input order, then stop_seq within each trip), repeats
      // preserved.
      const stopIdToLocalIdx = new Map<string, number>();
      const localIdxToStopId: string[] = [];
      // Per-trip raw stop-id sequence (sorted by stop_seq), reused for both the
      // grouping signature and the positional realignment below.
      const rawSeqByTripId = new Map<string, TripStopSeqEntry[]>();
      for (const t of trips) {
        const sorted = [...(tripStopSeqs.get(t.tripId) ?? [])].sort((a, b) => a.seq - b.seq);
        rawSeqByTripId.set(t.tripId, sorted);
        for (const entry of sorted) {
          if (!stopIdToLocalIdx.has(entry.stopId)) {
            stopIdToLocalIdx.set(entry.stopId, localIdxToStopId.length);
            localIdxToStopId.push(entry.stopId);
          }
        }
      }

      // TripForGrouping signatures: each trip's own raw stop sequence mapped to the route-local
      // indices, repeats preserved.
      const tripForGrouping = trips.map((t, localTripIdx) => ({
        tripIdx: localTripIdx,
        stopIdxs: rawSeqByTripId.get(t.tripId)!.map((e) => stopIdToLocalIdx.get(e.stopId)!),
        boarding: rawSeqByTripId.get(t.tripId)!.map((e) => (e.pickupType ?? 0) | ((e.dropOffType ?? 0) << 2)),
      }));

      const patternGroups = groupTripsByPattern(tripForGrouping, mode);
      for (const pg of patternGroups) {
        // Pattern's own stopIds: the signature's local indices back to stop-id
        // strings (NOT the route canonical) — preserves off-canonical stops.
        const patternStopIds = pg.stopIdxs.map((idx) => localIdxToStopId[idx]!);

        // stopId → LIST of pattern positions (ascending) — for the offset===0
        // occurrence-cursor (lasso/loop-safe). Mirrors emitWireRoute's
        // positionsByStop.
        const positionsByStop = new Map<string, number[]>();
        patternStopIds.forEach((sid, pos) => {
          let positions = positionsByStop.get(sid);
          if (!positions) { positions = []; positionsByStop.set(sid, positions); }
          positions.push(pos);
        });

        const alignedTrips: RouteTripEntry[] = pg.tripIdxs.map((localTripIdx, mi) => {
          const t = trips[localTripIdx]!;
          const offset = pg.offsets[mi]!;
          const rows = rawSeqByTripId.get(t.tripId)!;
          const patDeps = new Uint32Array(patternStopIds.length).fill(UNSERVED_STOP_SENTINEL);
          let patDwell: Uint16Array | undefined;
          let patPickup: Uint8Array | undefined;
          let patDropOff: Uint8Array | undefined;

          // Dwell comes straight from each row's own `arrivalSecs`
          // (dwell = departure − arrival when arrival is earlier), exactly as
          // the route-canonical fill above and emitWireRoute compute it. No
          // round-trip through the route-canonical `t.dwellSecs` array — the
          // raw row is the single source of truth, so the realignment is
          // independent of the route-canonical occurrence ordering.
          const dwellForRow = (row: TripStopSeqEntry): number => {
            if (row.arrivalSecs === undefined) return 0;
            const dwell = row.departureSecs - row.arrivalSecs;
            return dwell > 0 ? dwell : 0;
          };

          if (offset > 0) {
            // CoveringMerge folded member: this shorter trip rides the longer pattern at window
            // [offset, offset+rows.length). Its own stop sequence IS patternStopIds[offset..
            // offset+rows.length] by the fold predicate (contiguous subsequence), so row i lands at
            // position offset+i POSITIONALLY — NOT via the from-position-0 cursor (which would
            // re-seek to the first occurrence and mis-place rows when the covering pattern repeats
            // a stop). Mirrors emitWireRoute's offset>0 branch and index.rs byte-for-byte.
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i]!;
              const pos = offset + i;
              patDeps[pos] = row.departureSecs;
              const dwell = dwellForRow(row);
              if (dwell > 0) {
                if (!patDwell) patDwell = new Uint16Array(patternStopIds.length);
                patDwell[pos] = dwell > 0xFFFF ? 0xFFFF : dwell;
              }
              if (row.pickupType !== undefined && row.pickupType !== 0) {
                if (!patPickup) patPickup = new Uint8Array(patternStopIds.length);
                patPickup[pos] = row.pickupType;
              }
              if (row.dropOffType !== undefined && row.dropOffType !== 0) {
                if (!patDropOff) patDropOff = new Uint8Array(patternStopIds.length);
                patDropOff[pos] = row.dropOffType;
              }
            }
          } else {
            // offset === 0: native members (every member under Off/Unbounded)
            // AND prefix folds under CoveringMerge. A per-stop occurrence cursor
            // over the pattern's own positions keeps lasso/loop repeats aligned.
            const cursor = new Map<string, number>();
            for (const row of rows) {
              const positions = positionsByStop.get(row.stopId);
              if (positions === undefined) continue;
              const k = cursor.get(row.stopId) ?? 0;
              if (k >= positions.length) continue;
              const pos = positions[k]!;
              cursor.set(row.stopId, k + 1);
              patDeps[pos] = row.departureSecs;
              const dwell = dwellForRow(row);
              if (dwell > 0) {
                if (!patDwell) patDwell = new Uint16Array(patternStopIds.length);
                patDwell[pos] = dwell > 0xFFFF ? 0xFFFF : dwell;
              }
              if (row.pickupType !== undefined && row.pickupType !== 0) {
                if (!patPickup) patPickup = new Uint8Array(patternStopIds.length);
                patPickup[pos] = row.pickupType;
              }
              if (row.dropOffType !== undefined && row.dropOffType !== 0) {
                if (!patDropOff) patDropOff = new Uint8Array(patternStopIds.length);
                patDropOff[pos] = row.dropOffType;
              }
            }
          }

          return {
            tripId: t.tripId,
            serviceId: t.serviceId,
            headsign: t.headsign,
            departureSecs: patDeps,
            ...(patDwell ? { dwellSecs: patDwell } : {}),
            ...(patPickup ? { pickupTypes: patPickup } : {}),
            ...(patDropOff ? { dropOffTypes: patDropOff } : {}),
          };
        });

        // Keep trips sorted by first departure within the pattern.
        alignedTrips.sort((a, b) => {
          const a0 = a.departureSecs[0] === UNSERVED_STOP_SENTINEL ? -1 : a.departureSecs[0]!;
          const b0 = b.departureSecs[0] === UNSERVED_STOP_SENTINEL ? -1 : b.departureSecs[0]!;
          return a0 - b0;
        });

        // Shallow-copy directionPatterns per record so patterns sharing the
        // same route don't alias the same array reference. (buildRoutingView
        // copies defensively at build time, but pre-build consumers must not
        // be surprised by shared-reference aliasing.)
        const dp = directionPatterns.map((p) => ({ ...p }));
        result.push({ routeId, stopIds: patternStopIds, trips: alignedTrips, directionPatterns: dp });
      }
    }
  }

  return result;
}

// ── Pair sort ─────────────────────────────────────────────────────────────

/**
 * In-place Hoare quicksort on two parallel Uint32Arrays, keyed by `b`.
 *
 * @param a - values reordered in lockstep with b (e.g. tripIdIdx column)
 * @param b - sort key (e.g. departureSecs column)
 * @param lo - inclusive lower bound
 * @param hi - exclusive upper bound (like Array.slice)
 *
 * Not stable — consumers (getDepartures, getActiveRoutesByStop) do not
 * rely on tie-breaking order for equal b values.
 */
export function pairSortByB(
  a: Uint32Array,
  b: Uint32Array,
  lo: number,
  hi: number,
): void {
  // Insertion sort for small sub-ranges (standard quicksort polish).
  if (hi - lo <= 16) {
    for (let i = lo + 1; i < hi; i++) {
      const ai = a[i]!;
      const bi = b[i]!;
      let j = i - 1;
      while (j >= lo && b[j]! > bi) {
        a[j + 1] = a[j]!;
        b[j + 1] = b[j]!;
        j--;
      }
      a[j + 1] = ai;
      b[j + 1] = bi;
    }
    return;
  }

  // Median-of-three pivot — guards against already-sorted input, which is
  // common because stop_times.txt rows often arrive near-departure order.
  const mid = (lo + hi) >>> 1;
  const b0 = b[lo]!;
  const b1 = b[mid]!;
  const b2 = b[hi - 1]!;
  const pivot =
    b0 > b1
      ? b1 > b2
        ? b1
        : b0 > b2
          ? b2
          : b0
      : b0 > b2
        ? b0
        : b1 > b2
          ? b2
          : b1;

  // Hoare partition — swap both columns together.
  let i = lo;
  let j = hi - 1;
  while (i <= j) {
    while (b[i]! < pivot) i++;
    while (b[j]! > pivot) j--;
    if (i <= j) {
      const ta = a[i]!;
      const tb = b[i]!;
      a[i] = a[j]!;
      b[i] = b[j]!;
      a[j] = ta;
      b[j] = tb;
      i++;
      j--;
    }
  }

  // Standard Hoare recursion bounds: left = [lo, j+1), right = [j+1, hi).
  // Recurse on the smaller half first so the max depth of nested non-
  // returned frames is O(log n). V8 does not do TCO, but smaller-first
  // ordering still bounds depth because each first call returns before
  // the second call grows the stack.
  if (j - lo < hi - (j + 1)) {
    pairSortByB(a, b, lo, j + 1);
    pairSortByB(a, b, j + 1, hi);
  } else {
    pairSortByB(a, b, j + 1, hi);
    pairSortByB(a, b, lo, j + 1);
  }
}

// ── U32PairBuilder ────────────────────────────────────────────────────────

/**
 * Paired Uint32Array growable buffer. Mirrors the two-column layout of
 * CompactStopTimes during accumulation so pushing into a per-stop
 * builder costs the same as pushing into a typed array, with amortized
 * O(1) growth via doubling.
 *
 * Used during stream-stop-times to avoid the ~600 MB V8 per-array/
 * per-object overhead of the prior `{ tripIdxs: number[]; deps: number[] }`
 * shape on Paris-scale feeds.
 *
 * Single-use: finalize() is terminal. Pushing after finalize throws.
 */
export class U32PairBuilder {
  private aCap: Uint32Array;   // tripIdIdx column, working buffer
  private bCap: Uint32Array;   // departureSecs column, working buffer
  private len = 0;
  private finalized = false;

  constructor(initialCap = 16) {
    if (initialCap < 1) {
      throw new RangeError("U32PairBuilder: initialCap must be >= 1");
    }
    this.aCap = new Uint32Array(initialCap);
    this.bCap = new Uint32Array(initialCap);
  }

  push(aVal: number, bVal: number): void {
    if (this.finalized) {
      throw new Error("U32PairBuilder: push after finalize");
    }
    if (this.len >= this.aCap.length) {
      const newCap = this.aCap.length * 2;
      const newA = new Uint32Array(newCap);
      const newB = new Uint32Array(newCap);
      newA.set(this.aCap);
      newB.set(this.bCap);
      this.aCap = newA;
      this.bCap = newB;
    }
    this.aCap[this.len] = aVal;
    this.bCap[this.len] = bVal;
    this.len++;
  }

  /**
   * Sort in place by departureSecs, then return trimmed final arrays.
   * Uses slice() to copy into exact-sized buffers; the oversized capacity
   * buffers drop out of scope and are GC'd. subarray() would be zero-copy
   * but would retain the full ~1.5× average-capacity ArrayBuffer alive for
   * the life of the view — a persistent steady-state overhead across all
   * 54k stops. The transient copy cost during finalize is the right trade.
   *
   * Terminal: after finalize, push() throws. Create a new builder if more
   * data needs to be accumulated.
   */
  finalize(): { tripIdIdx: Uint32Array; departureSecs: Uint32Array } {
    pairSortByB(this.aCap, this.bCap, 0, this.len);
    this.finalized = true;
    return {
      tripIdIdx: this.aCap.slice(0, this.len),
      departureSecs: this.bCap.slice(0, this.len),
    };
  }
}

// ── Builder (array path — used by tests) ──────────────────────────────────

export function buildIndexes(
  stops: GtfsStop[],
  routes: GtfsRoute[],
  trips: GtfsTrip[],
  stopTimes: GtfsStopTime[],
  services: GtfsService[],
  calendarDates: GtfsCalendarDate[],
  minTripsPerRoute: number = 0,
  mode: PatternMode = PatternMode.Off,
): BuildResult {
  const stopsIndex = new Map<string, GtfsStop>(
    stops.map((s) => [s.id, s]),
  );

  const routesIndex = new Map<string, GtfsRoute>(
    routes.map((r) => [r.id, r]),
  );

  const tripsIndex = new Map<string, GtfsTrip>(
    trips.map((t) => [t.tripId, t]),
  );

  // Pass 1: accumulate per-stop Uint32Array columns via doubling-growth builders
  const stopTimeBuilder = new Map<string, U32PairBuilder>();
  const tripStrings = buildTripStringTable(trips.map((t) => t.tripId));

  for (const st of stopTimes) {
    const trip = tripsIndex.get(st.tripId);
    const tripId = trip ? trip.tripId : st.tripId;
    const departureSecs = parseTimeToSecs(st.departureTime);
    if (Number.isNaN(departureSecs)) continue;

    let entry = stopTimeBuilder.get(st.stopId);
    if (!entry) { entry = new U32PairBuilder(); stopTimeBuilder.set(st.stopId, entry); }
    entry.push(tripStrings.intern(tripId), departureSecs);
  }

  // Pass 2: finalize each builder — in-place sort + slice to exact length.
  // finalize() returns the CompactStopTimes shape directly, so no rename.
  const stopTimesIndex = new Map<string, CompactStopTimes>();
  for (const [stopId, builder] of stopTimeBuilder) {
    stopTimesIndex.set(stopId, builder.finalize());
  }

  // Count trips per (stop, route)
  const stopRouteTripSets = new Map<string, Map<string, Set<string>>>();
  for (const st of stopTimes) {
    const trip = tripsIndex.get(st.tripId);
    if (trip === undefined) continue;

    let routeMap = stopRouteTripSets.get(st.stopId);
    if (routeMap === undefined) {
      routeMap = new Map<string, Set<string>>();
      stopRouteTripSets.set(st.stopId, routeMap);
    }
    let tripSet = routeMap.get(trip.routeId);
    if (tripSet === undefined) {
      tripSet = new Set<string>();
      routeMap.set(trip.routeId, tripSet);
    }
    tripSet.add(st.tripId);
  }

  const stopRouteTripCounts = new Map<string, Map<string, number>>();
  for (const [stopId, routeMap] of stopRouteTripSets) {
    const countMap = new Map<string, number>();
    for (const [routeId, tripSet] of routeMap) {
      countMap.set(routeId, tripSet.size);
    }
    stopRouteTripCounts.set(stopId, countMap);
  }

  // Build per-trip stop sequences for routeTrips
  const tripStopSeqs = new Map<string, TripStopSeqEntry[]>();
  for (const st of stopTimes) {
    const departureSecs = parseTimeToSecs(st.departureTime);
    if (Number.isNaN(departureSecs)) continue;
    // Parser collapses `arrival_time === departure_time` (and empty cells)
    // to undefined — we only carry a distinct arrivalSecs when the feed
    // actually reports a dwell. Malformed values degrade to "no dwell".
    let arrivalSecs: number | undefined;
    if (st.arrivalTime) {
      const parsed = parseTimeToSecs(st.arrivalTime);
      if (!Number.isNaN(parsed) && parsed < departureSecs) {
        arrivalSecs = parsed;
      }
    }
    let entries = tripStopSeqs.get(st.tripId);
    if (!entries) {
      entries = [];
      tripStopSeqs.set(st.tripId, entries);
    }
    entries.push({
      stopId: st.stopId,
      departureSecs,
      ...(arrivalSecs !== undefined ? { arrivalSecs } : {}),
      ...(st.pickupType !== undefined ? { pickupType: st.pickupType } : {}),
      ...(st.dropOffType !== undefined ? { dropOffType: st.dropOffType } : {}),
      seq: st.stopSequence,
    });
  }

  // Build a populated Identity from the available trips data so that
  // buildRoutingView can resolve trip/service/headsign lookups correctly.
  const allHeadsigns = [...new Set(trips.map((t) => t.headsign))];
  const testIdentity = testIdentityWith({
    stops: stops.map((s) => s.id),
    routes: routes.map((r) => r.id),
    trips: trips.map((t) => t.tripId),
    services: services.map((s) => s.serviceId),
    headsigns: allHeadsigns,
  });

  // Build full per-route data (stopIds + trips) in a local variable, then split:
  // - routingInput.routes gets the full data (consumed by buildRoutingView, then released)
  // - indexes.routeTrips gets { routeId, stopIds } records for MapView stop→route index
  const routeTripData = buildRouteTripsIndex(tripStopSeqs, tripsIndex, mode);

  const routingInput: RoutingBuildInput = {
    routes: routeTripData.map((data) => ({
      routeId: data.routeId,
      stopIds: data.stopIds,
      trips: data.trips,
      directionPatterns: data.directionPatterns,
    })),
  };

  const servicesIndex = buildServicesIndex(services, calendarDates);

  const indexes: GtfsIndexes = {
    stopRoutes: buildStopRoutesFromCounts(stopRouteTripCounts, minTripsPerRoute),
    stopRouteTripCounts,
    routeTrips: routeTripData.map((data) => ({ routeId: data.routeId, stopIds: data.stopIds })),
    identity: testIdentity,
  };

  let canonical: CanonicalStore;
  try {
    canonical = createCanonicalStore({
      stopTimes: stopTimesIndex,
      tripStrings,
      stops: stopsIndex,
      routes: routesIndex,
      trips: tripsIndex,
      services: servicesIndex,
    });
  } catch (err) {
    throw new Error("[canonical-factory] createCanonicalStore failed during buildIndexes", { cause: err });
  }

  return { indexes, canonical, routingInput };
}

// ── Streaming builder (production path — avoids intermediate arrays) ──────

export interface StopTimeStreamResult {
  stopTimesIndex: Map<string, CompactStopTimes>;
  tripStrings: TripStringTable;
  stopRouteTripCounts: Map<string, Map<string, number>>;
  /** Ordered list of route records. One per canonical route (Off) or one per pattern (Unbounded). */
  routeTrips: RouteTripsData[];
  /** Number of stop_times rows parsed per stop_id. Exposed for PR 2 pre-sizing. */
  perStopRowCount: Map<string, number>;
  /** Number of stop_times rows parsed per known trip_id. Exposed for PR 2 pre-sizing. */
  perTripRowCount: Map<string, number>;
}

/**
 * Creates a push-based stop time index builder.
 * Accepts raw decompressed CSV chunks (Uint8Array) via `push()`,
 * parses rows on-the-fly, and builds compact indexes without ever
 * buffering the full decompressed file or millions of intermediate objects.
 *
 * Supports merging multiple GTFS feeds: call `beginFeed()` before streaming
 * each feed's stop_times.txt and `endFeed()` after. `push()` auto-begins a
 * feed when none is active, so single-feed callers may ignore beginFeed/endFeed.
 */
export function createStopTimeStreamBuilder(
  tripsIndex: Map<string, GtfsTrip>,
  orphanTracker?: OrphanTracker,
  prebuiltTripStrings?: TripStringTable,
  mode: PatternMode = PatternMode.Off,
): {
  beginFeed(): void;
  push(chunk: Uint8Array): void;
  endFeed(): Promise<void>;
  finish(): Promise<StopTimeStreamResult>;
} {
  const tripStrings = prebuiltTripStrings ?? buildTripStringTable(Array.from(tripsIndex.keys()));
  const stopTimeBuilder = new Map<string, U32PairBuilder>();
  const tripCountSets = new Map<string, Map<string, Set<string>>>();
  const tripStopSeqs = new Map<string, TripStopSeqEntry[]>();
  const perStopRowCount = new Map<string, number>();
  const perTripRowCount = new Map<string, number>();

  let csvParser: ReturnType<typeof parse> | null = null;
  let parserDone: Promise<void> | null = null;

  function drain() {
    if (!csvParser) return;
    let record: Record<string, string> | null;
    while ((record = csvParser.read() as Record<string, string> | null) !== null) {
      const rawTripId = record["trip_id"];
      const stopId = record["stop_id"];

      const trip = tripsIndex.get(rawTripId);
      if (orphanTracker) {
        if (trip) orphanTracker.recordKnown();
        else orphanTracker.recordOrphan();
      }
      const tripId = trip ? trip.tripId : rawTripId;

      perStopRowCount.set(stopId, (perStopRowCount.get(stopId) ?? 0) + 1);
      if (trip) perTripRowCount.set(tripId, (perTripRowCount.get(tripId) ?? 0) + 1);

      const departureSecs = parseTimeToSecs(record["departure_time"]);
      if (Number.isNaN(departureSecs)) continue;

      let entry = stopTimeBuilder.get(stopId);
      if (!entry) {
        entry = new U32PairBuilder();
        stopTimeBuilder.set(stopId, entry);
      }
      entry.push(tripStrings.intern(tripId), departureSecs);

      // Buffer per-trip stop sequences for routeTrips. arrival_time is kept
      // only when it is present AND strictly earlier than departure_time;
      // otherwise dwell is zero and we leave the field off so
      // buildRouteTripsIndex can short-circuit the Uint16Array allocation
      // for trips (the vast majority) with no dwell anywhere.
      const seq = parseInt(record["stop_sequence"], 10);
      const rawArrival = record["arrival_time"];
      let arrivalSecs: number | undefined;
      if (rawArrival && rawArrival !== record["departure_time"]) {
        const parsed = parseTimeToSecs(rawArrival);
        if (!Number.isNaN(parsed) && parsed < departureSecs) {
          arrivalSecs = parsed;
        }
      }
      let entries = tripStopSeqs.get(tripId);
      if (!entries) {
        entries = [];
        tripStopSeqs.set(tripId, entries);
      }
      const rawPickup = record["pickup_type"];
      const pickupType =
        rawPickup && rawPickup !== "0" ? parseInt(rawPickup, 10) : undefined;
      const rawDropOff = record["drop_off_type"];
      const dropOffType =
        rawDropOff && rawDropOff !== "0" ? parseInt(rawDropOff, 10) : undefined;

      entries.push({
        stopId,
        departureSecs,
        ...(arrivalSecs !== undefined ? { arrivalSecs } : {}),
        ...(pickupType !== undefined ? { pickupType } : {}),
        ...(dropOffType !== undefined ? { dropOffType } : {}),
        seq,
      });

      if (trip) {
        let routeMap = tripCountSets.get(stopId);
        if (!routeMap) {
          routeMap = new Map();
          tripCountSets.set(stopId, routeMap);
        }
        let tripSet = routeMap.get(trip.routeId);
        if (!tripSet) {
          tripSet = new Set();
          routeMap.set(trip.routeId, tripSet);
        }
        tripSet.add(tripId);
      }
    }
  }

  function beginFeed(): void {
    if (csvParser !== null) {
      throw new Error("previous feed not ended — call endFeed() first");
    }
    csvParser = parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
      relax_column_count: true,
      bom: true,
    });
    csvParser.on("readable", drain);
    const parser = csvParser;
    parserDone = new Promise<void>((resolve, reject) => {
      parser.on("end", resolve);
      parser.on("error", reject);
    });
    // Attach a no-op handler so a parse error before endFeed() is awaited
    // doesn't trigger Node's unhandledRejection (default: process crash).
    // The real error handling happens via `await parserDone` in endFeed().
    parserDone.catch(() => {});
  }

  async function endFeed(): Promise<void> {
    if (csvParser === null) return;
    csvParser.end();
    await parserDone;
    drain();
    csvParser = null;
    parserDone = null;
  }

  return {
    beginFeed,
    push(chunk: Uint8Array) {
      if (csvParser === null) beginFeed();
      csvParser!.write(chunk);
      drain();
    },
    endFeed,
    async finish(): Promise<StopTimeStreamResult> {
      if (csvParser !== null) await endFeed();

      const stopTimesIndex = new Map<string, CompactStopTimes>();
      for (const [stopId, builder] of stopTimeBuilder) {
        stopTimesIndex.set(stopId, builder.finalize());
      }

      const stopRouteTripCounts = new Map<string, Map<string, number>>();
      for (const [stopId, routeMap] of tripCountSets) {
        const countMap = new Map<string, number>();
        for (const [routeId, tripSet] of routeMap) {
          countMap.set(routeId, tripSet.size);
        }
        stopRouteTripCounts.set(stopId, countMap);
      }

      if (orphanTracker) orphanTracker.assertWithinThreshold();

      return {
        stopTimesIndex,
        tripStrings,
        stopRouteTripCounts,
        routeTrips: buildRouteTripsIndex(tripStopSeqs, tripsIndex, mode),
        perStopRowCount,
        perTripRowCount,
      };
    },
  };
}

/**
 * Build full GtfsIndexes from pre-streamed stop time data.
 * Used in production where stop_times are streamed via createStopTimeStreamBuilder.
 *
 * `routeTrips` is an ordered list of records (one per canonical route under Off,
 * one per pattern under Unbounded). Each record carries its own `routeId`; the
 * list may contain repeated route_ids under Unbounded.
 */
export function buildIndexesFromStreamed(
  stops: GtfsStop[],
  routes: GtfsRoute[],
  trips: GtfsTrip[],
  stopTimesIndex: Map<string, CompactStopTimes>,
  tripStrings: TripStringTable,
  stopRouteTripCounts: Map<string, Map<string, number>>,
  routeTrips: RouteTripsData[],
  services: GtfsService[],
  calendarDates: GtfsCalendarDate[],
  minTripsPerRoute: number = 0,
  identity: import("./identity/types.js").Identity,
): BuildResult {
  // Split the full per-route data: routingInput gets stopIds + trips, indexes gets { routeId, stopIds }.
  const routingInput: RoutingBuildInput = {
    routes: routeTrips.map((data) => ({
      routeId: data.routeId,
      stopIds: data.stopIds,
      trips: data.trips,
      directionPatterns: data.directionPatterns,
    })),
  };

  const stopsMap = new Map(stops.map((s) => [s.id, s]));
  const routesMap = new Map(routes.map((r) => [r.id, r]));
  const tripsMap = new Map(trips.map((t) => [t.tripId, t]));
  const servicesIndex = buildServicesIndex(services, calendarDates);

  const indexes: GtfsIndexes = {
    stopRoutes: buildStopRoutesFromCounts(stopRouteTripCounts, minTripsPerRoute),
    stopRouteTripCounts,
    routeTrips: routeTrips.map((data) => ({ routeId: data.routeId, stopIds: data.stopIds })),
    identity,
  };

  let canonical: CanonicalStore;
  try {
    canonical = createCanonicalStore({
      stopTimes: stopTimesIndex,
      tripStrings,
      stops: stopsMap,
      routes: routesMap,
      trips: tripsMap,
      services: servicesIndex,
    });
  } catch (err) {
    throw new Error("[canonical-factory] createCanonicalStore failed during buildIndexesFromStreamed", { cause: err });
  }

  return { indexes, canonical, routingInput };
}
