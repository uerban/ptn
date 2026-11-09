import type { TransportMode } from "./transit.js";
import type { RouteDirectionPattern } from "../identity/routeSchedule.js";

/**
 * Wire-format types for the routing-bundle payload served at
 * `/api/<city>/routing-bundle/fetch`. This is the data the frontend
 * consumes to run RAPTOR locally — hence "bundle" (wire format) rather
 * than "Raptor*" (algorithm coupling).
 */

/** A stop in the routing bundle. */
export interface RoutingBundleStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  wheelchairBoarding?: number; // 0=unknown, 1=yes, 2=no (GTFS spec)
}

/** A GTFS agency carried on the routing wire. */
export interface RoutingBundleAgency {
  id: string;
  name: string;
  url?: string;
  timezone?: string;
  lang?: string;
  phone?: string;
  fareUrl?: string;
  email?: string;
}

/** A route with its ordered stop sequence and trips. */
export interface RoutingBundleRoute {
  id: string;
  shortName: string;
  mode: TransportMode;
  color?: string;
  textColor?: string;
  /** GTFS agency_id cross-reference (omitted when the route has none). */
  agencyId?: string;
  /** GTFS `route_type` (`mode` is derived from it); absent on older bundles. */
  routeType?: number;
  /** Ordered stop IDs defining this route's stop sequence. */
  stopIds: string[];
  /** Trips on this route, each with departure times parallel to stopIds. */
  trips: RoutingBundleTrip[];
  /**
   * Per-direction stop sequences. Preserves return-only stops on
   * bidirectional routes whose canonical `stopIds` (one direction only)
   * would otherwise drop them. Absent on older bundles. See
   * `RouteDirectionPattern` for the shape contract.
   */
  directionPatterns?: RouteDirectionPattern[];
}

/** A single trip within a routing-bundle route. */
export interface RoutingBundleTrip {
  tripId: string;
  serviceId: string;
  headsign: string;
  /**
   * GTFS timetable direction. This is display metadata only: GTFS explicitly
   * says not to use `direction_id` for routing, but it is the stable way to
   * distinguish opposite trips when their rider-facing `trip_headsign` text is
   * identical.
   * https://gtfs.org/documentation/schedule/reference/#tripstxt
   */
  directionId?: 0 | 1;
  /** PTB global trip ordinal, used to join GTFS frequencies.txt rows after route-local sorting. */
  ptbTripIdx?: number;
  /** Departure seconds since midnight at each stop, parallel to route's stopIds. -1 means the trip skips that stop. */
  departureSecs: number[];
  /**
   * Sparse per-stop dwell in seconds (`departure_time − arrival_time`),
   * parallel to `stopIds` when present. Absent means every stop has zero
   * dwell — by far the common case, and omitting the array keeps the wire
   * payload (and gzip bundle) small for feeds whose stop_times.txt doesn't
   * bother reporting arrival_time separately. RAPTOR subtracts this from
   * `departureSecs[pos]` at alight time; the field is only emitted when
   * at least one position has a non-zero dwell, so the common case is
   * zero extra bytes.
   */
  dwellSecs?: number[];
  /**
   * GTFS pickup_type per stop, parallel to the route's stopIds. Omitted when all 0.
   * 1=board forbidden. GTFS reference: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
   */
  pickupTypes?: number[];
  /**
   * GTFS drop_off_type per stop, parallel to the route's stopIds. Omitted when all 0.
   * 1=alight forbidden.
   */
  dropOffTypes?: number[];
  wheelchairAccessible?: number; // 0=unknown, 1=yes, 2=no
  bikesAllowed?: number; // 0=unknown, 1=yes, 2=no
  shapeId?: string;
}

/** Calendar service with exceptions. */
export interface RoutingBundleService {
  serviceId: string;
  /** [mon, tue, wed, thu, fri, sat, sun] */
  days: boolean[];
  startDate: string; // YYYYMMDD
  endDate: string; // YYYYMMDD
  /** date (YYYYMMDD) → 1=added, 2=removed */
  exceptions: Record<string, number>;
}

/** A GTFS shape encoding a route's geometry. */
export interface RoutingBundleShape {
  shapeId: string;
  encodedPolyline: string;
  source: "gtfs";
}

/** Manifest metadata for the shapes artifact (separate blob). */
export interface RoutingBundleShapesArtifact {
  url: string;
  hash: string;
  sizeBytes: number;
}

/**
 * Manifest metadata for the pre-computed pedestrian transfers artifact
   * (`transfers.bin`, PTFT wire format). Mirrors `RoutingBundleShapesArtifact`:
 * URL + content hash for integrity, gzipped on the wire.
 */
export interface RoutingBundleTransfersArtifact {
  url: string;
  hash: string;
  sizeBytes: number;
}

/**
 * A GTFS transfers.txt rule carried on the routing wire (consumed by the
   * frontend `hydrate`). Distinct from `meta.transfersArtifact` (the PTFT
 * pedestrian walking graph). GTFS reference:
 * https://gtfs.org/documentation/schedule/reference/#transferstxt
 */
export interface RoutingBundleTransfer {
  /** Absent only on a PTB v2 linked row (transfer_type 4/5) keyed by trips alone. */
  fromStopId?: string;
  toStopId?: string;
  /** GTFS transfer_type: 0 recommended, 1 timed, 2 min-time, 3 not-possible, 4 in-seat, 5 re-board. */
  transferType: number;
  /** GTFS min_transfer_time (seconds); present for transfer_type=2. */
  minTransferSecs?: number;
  fromRouteId?: string;
  toRouteId?: string;
  fromTripId?: string;
  toTripId?: string;
}

/** GTFS frequencies.txt row carried on the routing wire, keyed by PTB trip ordinal. */
export interface RoutingBundleFrequency {
  tripIdx: number;
  startSecs: number;
  endSecs: number;
  headwaySecs: number;
  exactTimes: 0 | 1;
}

/** Complete routing-bundle payload served to the client. */
export interface RoutingBundleData {
  /** Schema version for backward-compatible evolution. */
  version?: number;
  stops: RoutingBundleStop[];
  routes: RoutingBundleRoute[];
  calendar: RoutingBundleService[];
  /** GTFS transfers.txt rules; omitted when the feed has none. */
  transfers?: RoutingBundleTransfer[];
  /** GTFS frequencies.txt rows, keyed by PTB global trip ordinal. Omitted when absent. */
  frequencies?: RoutingBundleFrequency[];
  meta: {
    generatedAt: string; // ISO 8601
    etag?: string;
    cityId: string;
    /**
     * IANA timezone of the feed's agency (`meta.cityTzIana`, the GTFS
     * agency_timezone). Populated on BOTH ingestion paths: the PTB sidecar
     * (`meta.cityTzIana` from the probe) AND the network-GTFS path (parsed from
     * `agency.txt`'s `agency_timezone`). Absent only when a feed has no
     * agency.txt/agency_timezone. The frontend cross-checks it against
     * `CityConfig.tz` at load (drift guard) and uses it as the feed-tz
     * source-of-truth confirmation. Additive — older clients ignore it.
     */
    cityTzIana?: string;
    /** GTFS agencies; omitted when the feed has no agency.txt. */
    agencies?: RoutingBundleAgency[];
    shapesArtifact?: RoutingBundleShapesArtifact;
    transfersArtifact?: RoutingBundleTransfersArtifact;
  };
}
