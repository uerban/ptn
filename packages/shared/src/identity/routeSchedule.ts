/**
 * RouteSchedule — typed-array-backed per-route schedule data owned by RoutingView.
 *
 * Storage layout: 4 parallel Uint32Arrays. `tripIx`, `serviceIx`, `headsignIx`
 * each hold `tripCount` entries indexed by trip. `departureSecs` is a flat
 * trip-major CSR of length `tripCount * stopCount`, accessed as
 * `departureSecs[tripIdx * stopCount + stopIdx]`. The sentinel
 * `DEP_SECS_NOT_SERVED` marks stop-skipped slots for variant-pattern trips.
 *
 */

/** Max uint32. Marks "stop not served by this variant trip" in RouteSchedule.departureSecs. */
export const DEP_SECS_NOT_SERVED = 0xFFFF_FFFF;

/**
 * Per-direction stop sequence for a route. The canonical `stopIds` on
 * `RouteSchedule` reflects only one direction (the longest single trip);
 * `RouteDirectionPattern[]` preserves the full stop set per direction so
 * the line preview can render both directions correctly. Routing
 * (RAPTOR) does not consult this; it consumes only the canonical
 * `stopIds`. See the known defects notes for the routing-side gap.
 */
export interface RouteDirectionPattern {
  /** Stable grouping key — `"0"`/`"1"` for `direction_id`, else headsign. */
  key: string;
  /** Headsign for this direction (matches `buildLinePatterns` grouping). */
  headsign: string;
  /** Full stop sequence for this direction. */
  stopIds: string[];
}

export interface RouteSchedule {
  readonly stopIds: readonly string[];
  readonly tripCount: number;
  readonly stopCount: number;
  /** length === tripCount; values are TripIx. */
  readonly tripIx: Uint32Array;
  /** length === tripCount; values are ServiceIx. */
  readonly serviceIx: Uint32Array;
  /** length === tripCount; values are HeadsignIx. */
  readonly headsignIx: Uint32Array;
  /** length === tripCount * stopCount (trip-major). `DEP_SECS_NOT_SERVED` marks skipped stops. */
  readonly departureSecs: Uint32Array;
  /**
   * Per-trip-per-stop dwell = departure − arrival, trip-major CSR. Absent
   * when no trip on this route has any non-zero dwell — the typical case;
   * avoids allocating `tripCount * stopCount * 2 bytes` for routes where
   * every stop is instant-turnaround. When present, `dwellSecs[trip *
   * stopCount + stop]` is the dwell (0 = no dwell, unserved rows stay 0).
   * Uint16Array caps dwells at 65 535 s, well beyond any realistic
   * terminus layover; values that would overflow are clamped at build.
   */
  readonly dwellSecs?: Uint16Array;
  /**
   * Per-trip-per-stop GTFS pickup_type, trip-major CSR `[trip*stopCount+stop]`. Absent when
   * every trip on the route has pickup_type 0 everywhere.
   * GTFS: 0=regular (default), 1=not-available (board forbidden), 2=phone, 3=driver.
   */
  readonly pickupTypes?: Uint8Array;
  /**
   * Per-trip-per-stop GTFS drop_off_type, trip-major CSR (same layout as pickupTypes).
   * Absent when every trip on the route has drop_off_type 0 everywhere.
   */
  readonly dropOffTypes?: Uint8Array;
  /**
   * Per-direction stop sequences. Optional — older bundles don't carry it
   * and consumers fall back to `stopIds` (one-direction-only) in that case.
   * Length 1 for unidirectional routes, ≥2 for bidirectional.
   */
  readonly directionPatterns?: readonly RouteDirectionPattern[];
}
