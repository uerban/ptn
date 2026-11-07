// Type-only import — erased at compile time, so the transit↔routing type
// cycle (routing.ts imports LatLon/TransportMode from here) carries no runtime
// dependency.
import type { MobilityProfile } from "./routing.js";

/** Geographic coordinate */
export interface LatLon {
  lat: number;
  lon: number;
}

/** Transport mode for a transit leg */
export type TransportMode =
  | "BUS"
  | "TRAM"
  | "TROLLEYBUS"
  | "METRO"
  | "RAIL"
  | "FERRY"
  | "CABLE_TRAM"
  | "AERIAL"
  | "OTHER"
  | "FUNICULAR"
  | "WALK"
  | "BIKE"
  | "BIKE_SHARE"
  | "SCOOTER"
  | "CAR";

/** A transit stop or station */
export interface Stop {
  id: string;
  name: string;
  location: LatLon;
  parentStationId?: string;
  wheelchairBoarding?: boolean;
  /** Route IDs serving this stop */
  routeIds?: string[];
}

/** A transit route (e.g., bus line 42) */
export interface TransitRoute {
  id: string;
  shortName: string;
  longName: string;
  mode: TransportMode;
  color?: string;
  textColor?: string;
  agencyId?: string;
}

/** A single departure from a stop */
export interface Departure {
  routeId: string;
  routeShortName: string;
  routeColor?: string;
  mode: TransportMode;
  subMode?: string;
  headsign: string;
  scheduledTime: string;
  /** ISO 8601 timestamp, absent if no real-time data */
  predictedTime?: string;
  delaySeconds?: number;
  tripId: string;
  cancelled?: boolean;
}

/** A single leg of a journey (one segment between transfers) */
export interface Leg {
  /** Transport mode for this leg. WALK for walking legs; a transit mode for vehicle legs. */
  mode: TransportMode;
  /** Boarding location for this leg. */
  from: LegPlace;
  /** Alighting location for this leg. */
  to: LegPlace;
  /** ISO 8601 UTC timestamp of departure from `from`. */
  departureTime: string;
  /** ISO 8601 UTC timestamp of arrival at `to`. */
  arrivalTime: string;
  /** Leg duration in seconds. */
  durationSeconds: number;
  /**
   * Short route identifier (e.g., "42", "M1").
   * Required for transit legs; absent for WALK legs.
   */
  routeShortName?: string;
  /**
   * Route brand color in hex #RRGGBB format (e.g., "#FF6600").
   * Optional for transit legs; absent for WALK legs.
   */
  routeColor?: string;
  /**
   * GTFS trip ID for this leg.
   * Required for transit legs; absent for WALK legs.
   */
  tripId?: string;
  /** Headsign / destination sign shown on the vehicle. Transit legs only. */
  headsign?: string;
  /** Number of intermediate stops (not counting the boarding and alighting stops). */
  intermediateStops?: number;
  /** Google-encoded polyline string for the leg geometry. */
  polyline?: string;
  /** Walking or cycling distance in meters. Typically set for WALK and BIKE legs. */
  distanceMeters?: number;
  /**
   * WALK legs only: the planner timed this walk at a running pace
   * (run-to-catch reached a stop beyond the walking budget), so
   * `durationSeconds` is how long it takes to RUN it. Absent for an ordinary
   * walk.
   */
  runToCatch?: boolean;
  /** Real-time delay in seconds (positive = late, negative = early). */
  delaySeconds?: number;
  /**
   * Transit legs: RT delay already folded into `departureTime`/`arrivalTime`
   * when the itinerary was planned. A later live delay moves the leg by the
   * difference. Absent when the times are scheduled.
   */
  appliedDelaySeconds?: number;
  /** GTFS route ID for this leg. Transit legs only. */
  routeId?: string;
  /** True for GTFS frequencies.txt exact_times=0 legs; render as approximate/headway-based. */
  approximate?: boolean;
  /** Position of boarding stop in the leg's pattern sequence (`patternStopIds`). Transit legs only. */
  boardStopIdx?: number;
  /** Position of alighting stop in the leg's pattern sequence (`patternStopIds`). Transit legs only. */
  alightStopIdx?: number;
  /**
   * Stop IDs of the scanned pattern for this leg, in stop-sequence order.
   * Always emitted by both engines when pattern support ships — under
   * PatternMode Off it equals the display route's canonical stopIds; under
   * Unbounded it is the scanned pattern's sequence (which may include
   * branch/variant stops absent from the canonical stopIds). Kept optional only
   * for wire/back-compat; consumers (`readLegSnapshot.ts`) retain a
   * display-route stopIds fallback for legacy/optional-field safety.
   */
  patternStopIds?: string[];
}

export interface LegPlace {
  name: string;
  stopId?: string;
  location: LatLon;
}

/** A complete journey itinerary from origin to destination */
export interface Itinerary {
  /**
   * Ordered list of legs composing the journey.
   * Must contain at least one leg. Walking legs have mode WALK;
   * transit legs have a vehicle mode and must include routeShortName and tripId.
   */
  legs: Leg[];
  /** ISO 8601 UTC timestamp of departure (equals legs[0].departureTime). */
  departureTime: string;
  /** ISO 8601 UTC timestamp of arrival (equals legs[legs.length-1].arrivalTime). */
  arrivalTime: string;
  /** Total journey duration in seconds (arrivalTime - departureTime). */
  durationSeconds: number;
  /** Number of transit vehicle transfers (0 = direct). */
  transfers: number;
  /** Total walking distance across all WALK legs, in meters. */
  walkingDistanceMeters: number;
  /** Opaque pagination cursor — pass to planTrip to retrieve subsequent itineraries. */
  paginationCursor?: string;
  /**
   * `true` when an upstream RT update marked any leg of this itinerary
   * cancelled. Set by `applyRtOverlay`; surfaced in the UI as a card-level
   * banner. Read directly — do not re-derive from per-leg signals.
   *
   * This means cancelled and nothing else. Delay-driven unviability is a
   * separate signal — see `timingUnreliable`.
   */
  cancelled?: boolean;
  /**
   * `true` when nothing was cancelled but delays pushed a leg's arrival so
   * late that the next leg can no longer be caught with the minimum transfer
   * buffer, so the itinerary as displayed is no longer viable. Set by
   * `applyRtOverlay`, which reverts to scheduled leg times in this case
   * rather than showing a chronologically impossible chain.
   *
   * Independent of `cancelled` — an itinerary can carry both, one, or
   * neither.
   */
  timingUnreliable?: boolean;
}

/** Query for route planning */
export interface TripQuery {
  from: LatLon;
  to: LatLon;
  /** ISO 8601 timestamp */
  departAt?: string;
  /** ISO 8601 timestamp — mutually exclusive with departAt */
  arriveBy?: string;
  modes?: TransportMode[];
  maxTransfers?: number;
  /** Which routing adapter to use */
  adapter?: string;
  /** Pagination cursor from previous result */
  cursor?: string;
  /**
   * Accessibility / mobility profile for the search. Threaded end-to-end so
   * adapters can apply the same trip-level exclusions the on-device engines
   * use (e.g. bicycle drops trips with GTFS bikes_allowed==2). Defaults to
   * "default" when absent. Use this string contract — not parallel booleans.
   */
  mobilityProfile?: MobilityProfile;
}

/** Response from route planning */
export interface TripResult {
  itineraries: Itinerary[];
  /**
   * Journeys that use no transit at all — walking or cycling the whole way.
   *
   * Kept apart from `itineraries` on purpose. An empty `itineraries` is a
   * meaningful answer ("no transit route here"), and folding a walk into it
   * would erase that distinction: there is no field on `Itinerary` that marks
   * one as transit-free, so a consumer could never tell the two apart again.
   * Callers that only care about transit read `itineraries` and are unaffected
   * by this field.
   *
   * A walk offered here is whatever the upstream engine considered reasonable,
   * which may exceed the walking limits this app applies to its own routing
   * (`DEFAULT_MAX_WALK_SECS`). Filter before presenting it as an option.
   *
   * Optional: an adapter whose engine reports no transit-free option omits it.
   */
  direct?: Itinerary[];
  /** Cursor for next page of results */
  nextPageCursor?: string;
}

/** A vehicle position for real-time tracking */
export interface VehiclePosition {
  vehicleId: string;
  tripId: string;
  routeId: string;
  location: LatLon;
  bearing?: number;
  speed?: number;
  /** Timestamp of this position update */
  timestamp: string;
}

/** A user's saved favorite place */
export interface FavoritePlace {
  id: string;
  name: string;
  type: "home" | "work" | "stop" | "place";
  location: LatLon;
  stopId?: string;
  cityId?: string;
  icon?: string;
  sortOrder: number;
  createdAt: string;
}
