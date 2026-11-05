import type { CompactStopTimes, GtfsStop, GtfsRoute, GtfsTrip, GtfsService, TripStringTable } from "../parser.js";

/**
 * Service entry — merged calendar row with a readonly `exceptions` map.
 * Matches the shape the builder produces today, but the public surface types
 * `exceptions` as `ReadonlyMap` to enforce the "no mutation after swap" rule.
 */
export type ServiceEntry = GtfsService & {
  exceptions: ReadonlyMap<string, number>;
};

/**
 * Public read surface for canonical GTFS data.
 *
 * All accessors are function-based — no `Map<>` or `TripStringTable` references
 * leak through the boundary. This keeps a future Identity-backed / disk-offload
 * implementation swap-in without rewriting consumers.
 */
export interface CanonicalStore {
  /** Number of distinct stops in the feed (stops.size — includes stops without departures). */
  readonly stopCount: number;
  /** Number of stops with at least one CompactStopTimes row (stopTimes.size). */
  readonly compactStopTimesCount: number;

  getCompactStopTimes(stopId: string): CompactStopTimes | undefined;
  iterCompactStopTimes(cb: (stopId: string, ct: CompactStopTimes) => void): void;

  /**
   * Resolve a trip-string index from a `CompactStopTimes.tripIdIdx` cell to its
   * underlying tripId string. Returns `undefined` for negative or out-of-range
   * indices (softer than the underlying `TripStringTable.stringAt` which throws —
   * keeps canonical's public surface uniform with the other `get*` accessors).
   */
  getTripIdForIx(ix: number): string | undefined;

  /** Number of interned trip-id strings (read-only size accessor). */
  internTripStringCount(): number;

  getStop(stopId: string): GtfsStop | undefined;
  iterStops(cb: (stopId: string, stop: GtfsStop) => void): void;

  getRoute(routeId: string): GtfsRoute | undefined;
  iterRoutes(cb: (routeId: string, route: GtfsRoute) => void): void;

  getTrip(tripId: string): GtfsTrip | undefined;
  iterTrips(cb: (tripId: string, trip: GtfsTrip) => void): void;

  getService(serviceId: string): ServiceEntry | undefined;
  iterServices(cb: (serviceId: string, svc: ServiceEntry) => void): void;
}

export interface CanonicalBuildInput {
  stopTimes: ReadonlyMap<string, CompactStopTimes>;
  tripStrings: TripStringTable;
  stops: ReadonlyMap<string, GtfsStop>;
  routes: ReadonlyMap<string, GtfsRoute>;
  trips: ReadonlyMap<string, GtfsTrip>;
  services: ReadonlyMap<string, ServiceEntry>;
}

export function createCanonicalStore(input: CanonicalBuildInput): CanonicalStore {
  const { stopTimes, tripStrings, stops, routes, trips, services } = input;
  return {
    get stopCount(): number { return stops.size; },
    get compactStopTimesCount(): number { return stopTimes.size; },

    getCompactStopTimes(id) { return stopTimes.get(id); },
    iterCompactStopTimes(cb) { for (const [id, ct] of stopTimes) cb(id, ct); },

    getTripIdForIx(ix) {
      if (!Number.isInteger(ix) || ix < 0 || ix >= tripStrings.size) return undefined;
      return tripStrings.stringAt(ix);
    },

    internTripStringCount() { return tripStrings.size; },

    getStop(id) { return stops.get(id); },
    iterStops(cb) { for (const [id, v] of stops) cb(id, v); },

    getRoute(id) { return routes.get(id); },
    iterRoutes(cb) { for (const [id, v] of routes) cb(id, v); },

    getTrip(id) { return trips.get(id); },
    iterTrips(cb) { for (const [id, v] of trips) cb(id, v); },

    getService(id) { return services.get(id); },
    iterServices(cb) { for (const [id, v] of services) cb(id, v); },
  };
}
