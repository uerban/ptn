import type { Identity } from "../identity/types.js";
import type { RouteDirectionPattern, RouteSchedule } from "@pt/shared";
import { DEP_SECS_NOT_SERVED } from "@pt/shared";

/**
 * Per-route schedule data built at GTFS load. See spec
 * the routing view csr ix notes.
 *
 * `routes` is an ordered array. Under PatternMode.Off each entry has a unique
 * `routeId`; under Unbounded the array contains one entry per pattern (repeated
 * `routeId`). RoutingView iterates it in order and preserves all entries.
 */
export interface RoutingBuildInput {
  readonly routes: readonly {
    /** The bare GTFS route_id. May be repeated under Unbounded (one entry per pattern). */
    routeId: string;
    stopIds: string[];
    trips: {
      tripId: string;
      serviceId: string;
      headsign: string;
      departureSecs: number[] | Uint32Array;
      /**
       * Per-stop dwell seconds (`departure_time − arrival_time`) parallel to
       * `stopIds`. Absent for trips where every stop has zero dwell — the
       * common case — which lets RoutingView skip the CSR fill entirely for
       * that trip's row. When present, values > 0 mark the dwell at each
       * stop; 0 means the trip serves the stop with no dwell; the unserved
       * marker in `departureSecs` implicitly applies.
       */
      dwellSecs?: Uint16Array | Uint32Array | number[];
      pickupTypes?: Uint8Array | number[];
      dropOffTypes?: Uint8Array | number[];
    }[];
    /**
     * Per-direction stop sequences carried alongside the canonical `stopIds`
     * so the line preview can render both directions of a bidirectional
     * route. Optional — index-builder may omit it on legacy paths or for
     * unidirectional routes. RoutingView passes it through unchanged; RAPTOR
     * does not consume it.
     */
    directionPatterns?: readonly RouteDirectionPattern[];
  }[];
}

export interface RoutingView {
  /**
   * Number of pattern records in this view. Under PatternMode.Off this equals
   * the number of unique route_ids. Under Unbounded this is the total number
   * of pattern-records and is ≥ the number of unique route_ids (one entry per
   * distinct stop-sequence pattern, with route_id repeated across patterns of
   * the same route). For the unique route count use `uniqueRouteCount`.
   */
  readonly routeCount: number;
  /**
   * Number of unique route_ids across all pattern records. Under PatternMode.Off
   * this is identical to `routeCount`. Under Unbounded it is backed by the
   * first-wins schedule-map size and may be less than `routeCount`.
   */
  readonly uniqueRouteCount: number;
  getRouteStopIds(routeId: string): readonly string[] | undefined;
  getRouteSchedule(routeId: string): RouteSchedule | undefined;
  iterRoutes(cb: (routeId: string, schedule: RouteSchedule) => void): void;
}

export function buildRoutingView(
  input: RoutingBuildInput,
  identity: Identity,
): RoutingView {
  // Ordered list of all entries (may contain repeated routeIds under Unbounded).
  const scheduleList: { routeId: string; sched: RouteSchedule }[] = [];
  // First-wins per-routeId lookup (for legacy getters; returns the first pattern).
  const scheduleMap = new Map<string, RouteSchedule>();

  for (const route of input.routes) {
    const routeId = route.routeId;
    const tripCount = route.trips.length;
    const stopCount = route.stopIds.length;

    const tripIx = new Uint32Array(tripCount);
    const serviceIx = new Uint32Array(tripCount);
    const headsignIx = new Uint32Array(tripCount);
    const departureSecs = new Uint32Array(tripCount * stopCount);
    departureSecs.fill(DEP_SECS_NOT_SERVED);
    // Dwell is stored lazily — we only allocate when we actually see a
    // trip with dwell data, so routes with no terminus pause (most of
    // them) pay zero bytes. Uint16Array: 65 535s cap is vastly more than
    // any scheduled layover.
    let dwellSecs: Uint16Array | undefined;
    // pickup_type / drop_off_type: Uint8Array CSRs, allocated lazily the
    // first time a non-zero value appears (same pattern as dwellSecs).
    // Values 0–3 per GTFS spec; 0 = regular/default (omit-at-default).
    let pickupTypes: Uint8Array | undefined;
    let dropOffTypes: Uint8Array | undefined;

    for (let t = 0; t < tripCount; t++) {
      const trip = route.trips[t]!;

      const tIx = identity.trips.indexOf(trip.tripId);
      if (tIx < 0) throw new Error(`RoutingView build: unknown trip_id "${trip.tripId}"`);
      const sIx = identity.services.indexOf(trip.serviceId);
      if (sIx < 0) throw new Error(`RoutingView build: unknown service_id "${trip.serviceId}"`);
      const hIx = identity.headsigns.indexOf(trip.headsign);
      if (hIx < 0) throw new Error(`RoutingView build: unknown headsign "${trip.headsign}"`);

      tripIx[t] = tIx;
      serviceIx[t] = sIx;
      headsignIx[t] = hIx;

      const rowBase = t * stopCount;
      const src = trip.departureSecs;
      const limit = Math.min(src.length, stopCount);
      for (let s = 0; s < limit; s++) {
        const v = src[s]!;
        // Handle both legacy sentinels: number[] uses -1, Uint32Array (PR #78) uses
        // 0xFFFFFFFF (which equals DEP_SECS_NOT_SERVED). Both map to the canonical sentinel.
        departureSecs[rowBase + s] = (v < 0 || v === DEP_SECS_NOT_SERVED) ? DEP_SECS_NOT_SERVED : v;
      }

      // Fold per-trip dwell into the route-level CSR. Lazy allocation:
      // first trip with non-zero dwell triggers creation of the full
      // tripCount×stopCount array; earlier zero-dwell rows stay implicit
      // zero. `dwell > 0xFFFF` (over ~18h) is clamped to avoid typed-array
      // overflow. Not correctness-preserving — a feed with a legit
      // >18h pause would lose precision — but the parser already filters
      // `arrival_time >= departure_time`, so the only way here is a
      // malformed feed, and clamping is preferable to a silent wrap.
      const tripDwell = trip.dwellSecs;
      if (tripDwell && tripDwell.length > 0) {
        const dwellLimit = Math.min(tripDwell.length, stopCount);
        for (let s = 0; s < dwellLimit; s++) {
          const d = tripDwell[s]!;
          if (d > 0) {
            if (!dwellSecs) dwellSecs = new Uint16Array(tripCount * stopCount);
            dwellSecs[rowBase + s] = d > 0xFFFF ? 0xFFFF : d;
          }
        }
      }

      const tripPickup = trip.pickupTypes;
      if (tripPickup && tripPickup.length > 0) {
        const pickupLimit = Math.min(tripPickup.length, stopCount);
        for (let s = 0; s < pickupLimit; s++) {
          const p = tripPickup[s]!;
          if (p !== 0) {
            if (!pickupTypes) pickupTypes = new Uint8Array(tripCount * stopCount);
            pickupTypes[rowBase + s] = p;
          }
        }
      }

      const tripDropOff = trip.dropOffTypes;
      if (tripDropOff && tripDropOff.length > 0) {
        const dropOffLimit = Math.min(tripDropOff.length, stopCount);
        for (let s = 0; s < dropOffLimit; s++) {
          const d = tripDropOff[s]!;
          if (d !== 0) {
            if (!dropOffTypes) dropOffTypes = new Uint8Array(tripCount * stopCount);
            dropOffTypes[rowBase + s] = d;
          }
        }
      }
    }

    // Object.freeze on the wrapper only — typed arrays, stopIds, and
    // directionPatterns inner state remain runtime-mutable. TypeScript
    // `readonly` declarations on RouteSchedule prevent accidental mutation
    // in the TS layer; this freeze just guards against property
    // reconfiguration on the wrapper itself.
    // Shallow defensive copy of directionPatterns so a later builder run
    // mutating the source array doesn't alias into a built schedule.
    const directionPatterns = route.directionPatterns
      ? route.directionPatterns.map((p) => ({
          key: p.key,
          headsign: p.headsign,
          stopIds: [...p.stopIds],
        }))
      : undefined;

    const sched: RouteSchedule = Object.freeze({
      stopIds: [...route.stopIds],
      tripCount,
      stopCount,
      tripIx,
      serviceIx,
      headsignIx,
      departureSecs,
      ...(dwellSecs ? { dwellSecs } : {}),
      ...(pickupTypes ? { pickupTypes } : {}),
      ...(dropOffTypes ? { dropOffTypes } : {}),
      // Canonicalize: only emit `directionPatterns` when non-empty. This
      // matches the wire serializer in `store.ts` which strips empty
      // arrays via the same length>0 guard, so consumers never have to
      // distinguish "field absent" from "field empty".
      ...(directionPatterns && directionPatterns.length > 0
        ? { directionPatterns }
        : {}),
    });
    scheduleList.push({ routeId, sched });
    // First-wins: keeps the legacy single-route lookup working for per-routeId
    // queries (e.g. getActiveRoutesByStop uses the canonical/longest pattern).
    if (!scheduleMap.has(routeId)) scheduleMap.set(routeId, sched);
  }

  return {
    // Under patterns, routeCount is the total number of pattern-records, not
    // the number of unique route_ids. MapView/stopRoutes is unaffected.
    get routeCount(): number { return scheduleList.length; },
    // Unique route_id count: backed by the first-wins schedule-map size.
    get uniqueRouteCount(): number { return scheduleMap.size; },
    getRouteStopIds(routeId: string): readonly string[] | undefined {
      return scheduleMap.get(routeId)?.stopIds;
    },
    getRouteSchedule(routeId: string): RouteSchedule | undefined {
      return scheduleMap.get(routeId);
    },
    iterRoutes(cb): void {
      for (const { routeId, sched } of scheduleList) cb(routeId, sched);
    },
  };
}
