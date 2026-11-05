import type { LatLon, TransportMode } from "./transit.js";

export type MobilityProfile = "default" | "wheelchair" | "vision_impaired" | "bicycle";
/** The profiles the engine accepts: `pt-wasm` (`classify_mobility` in
 *  `crates/pt-wasm/src/query.rs`) fails a plan on any other string, and
 *  `pt-serve` `/plan` plans any other string as default. Map a rider's
 *  profile with `engineMobilityProfile`. */
export type EngineMobilityProfile = "default" | "wheelchair" | "bicycle";
export type RoutingPreference = "default" | "easy_path" | "night" | "custom";

export interface RaptorQuery {
  entryStops: { stopId: string; walkSecs: number }[];
  exitStops: { stopId: string; walkSecs: number }[];
  departureSecs: number;
  activeServiceIds: Set<string>;
  maxRounds?: number;
  mobilityProfile?: MobilityProfile;
  /** Transport modes to exclude from route scanning */
  excludedModes?: TransportMode[];
  /** Generic hard route exclusions, applied before candidate generation. */
  excludedRouteIds?: string[];
  /** Walking speed (m/s) for the engine's own transfer walks; the entry and
   *  exit walks above already carry it. Absent: the engine profile's speed. */
  walkSpeedMps?: number;
  /** Minimum transfer (s) wherever no GTFS `transfers.txt` rule sets one,
   *  per profile (`minTransferSecsFor`). Absent: 120. */
  minTransferSecs?: number;
}

export interface RaptorWalkLeg {
  type: "walk";
  fromStopId: string;
  toStopId: string;
  departSecs: number;
  arriveSecs: number;
  mode?: TransportMode;
  intermediateStops?: number;
}

export interface RaptorTransitLeg {
  type: "transit";
  fromStopId: string;
  toStopId: string;
  departSecs: number;
  arriveSecs: number;
  /**
   * True when this leg boards a GTFS frequencies.txt exact_times=0 headway
   * window. departSecs/arriveSecs are concrete routing seconds, but the rider-
   * visible presentation must be approximate rather than a fabricated exact
   * scheduled departure.
   * GTFS reference: https://gtfs.org/documentation/schedule/reference/#frequenciestxt
   */
  approximate?: boolean;
  /**
   * RT delay already folded into `departSecs`/`arriveSecs` by the overlay at
   * plan time. Absent when the times are scheduled. A later live delay moves
   * the leg by the difference, not the whole delay again.
   */
  appliedDelaySeconds?: number;
  routeId: string;
  routeShortName?: string;
  routeColor?: string;
  mode?: TransportMode;
  tripId: string;
  headsign?: string;
  intermediateStops?: number;
  /** Position of `fromStopId` in the leg's pattern sequence (`patternStopIds`). */
  boardStopIdx: number;
  /** Position of `toStopId` in the leg's pattern sequence (`patternStopIds`). */
  alightStopIdx: number;
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

export type RaptorLeg = RaptorWalkLeg | RaptorTransitLeg;

export interface RaptorItinerary {
  legs: RaptorLeg[];
  boardSecs: number;
  alightSecs: number;
  transfers: number;
}

export interface ComposedItinerary {
  sourceWalkSecs: number;
  /**
   * True when the first boarding stop is only reachable by running
   * (run-to-catch): `sourceWalkSecs` is then a RUNNING time, not a walking one.
   */
  sourceRunToCatch?: boolean;
  legs: RaptorLeg[];
  destWalkSecs: number;
  totalSecs: number;
  departureSecs: number;
  arrivalSecs: number;
  transfers: number;
  totalWalkSecs: number;
  /** Metres walked to the first stop and from the last one, when both
   *  endpoints' distances are known. Independent of the speed that turned
   *  them into seconds (a slower rider, or a run to catch). */
  totalWalkMeters?: number;
}

export type RankingCriteria = "fastest" | "fewest_transfers" | "least_walking";

/** One stop + walk-seconds entry; mirrors pt-serve `wire.rs::StopWalkReq`. */
export interface StopWalk {
  stopId: string;
  walkSecs: number;
}

/**
 * Inbound pt-serve `POST /api/<city>/plan` request body. camelCase mirror of
 * `crates/pt-serve/src/wire.rs::PlanRequest`.
 *
 * `excludedModes` is intentionally omitted in B5: pt-serve wants GTFS
 * `route_type` integers (`u16[]`), and the `TransportMode` → `route_type`
 * mapping is deferred to B1 (the wasm-engine `/plan` cutover). Sending the
 * Contract-A string form (`["BUS", ...]`) is a hard 400, so the field is left
 * off entirely until B1 ships the mapping.
 */
export interface PlanRequest {
  entryStops: StopWalk[];
  exitStops: StopWalk[];
  departureSecs: number;
  /** ISO-numeric date "YYYYMMDD". */
  date: string;
  maxRounds?: number;
  /** The engine profile (`engineMobilityProfile`), never the rider's own
   *  profile name: the request describes the journey, not the rider. */
  mobilityProfile?: EngineMobilityProfile;
}

export interface SearchPreferences {
  mobilityProfile?: MobilityProfile;
  routingPreference?: RoutingPreference;
  /** Willing to run for a departure: the same walk-time budget is searched at
   *  running pace, and the legs it adds carry running times. Never widens the
   *  budget — see services/isochrone.ts. */
  runToCatch?: boolean;
}

export type LegGeometrySource =
  | "shape"
  | "intermediate"
  | "endpoints"
  | "osrm-foot"
  | "walk-graph";
// Phase 2 will extend with "osm-relation" (OSM relations) and "rt-derived"
// (observed vehicle positions).

/** GeoJSON-order coordinate pair: [longitude, latitude]. */
export type LonLat = readonly [lon: number, lat: number];
/** Google polyline-order coordinate pair: [latitude, longitude]. */
export type LatLonTuple = readonly [lat: number, lon: number];

export interface LegGeometryResult {
  coords: LonLat[]; // [lon, lat] (GeoJSON order)
  source: LegGeometrySource;
  partial: boolean;           // transit: resolved subset < full slice
  pending: boolean;           // transit: sync in progress; walk: OSRM fetch in flight
}
