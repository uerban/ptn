import type {
  TripQuery,
  TripResult,
  Stop,
  Departure,
  Alert,
  VehiclePosition,
  LatLon,
  TransportMode,
} from "./transit.js";

/** Interface that all routing engine adapters must implement */
export interface RoutingAdapter {
  /** Unique name of this adapter (e.g., "motis", "otp", "navitia") */
  readonly name: string;

  /**
   * Plan a trip between two locations.
   *
   * Returns itineraries sorted by departure time. Each itinerary must have at
   * least one leg. Walking legs must have mode WALK. Transit legs must include
   * routeShortName and tripId. All times are ISO 8601 UTC.
   *
   * @param query - Origin, destination, and optional constraints (time, modes, transfers).
   * @returns Resolved TripResult containing sorted itineraries and optional pagination cursor.
   */
  planTrip(query: TripQuery): Promise<TripResult>;

  /**
   * Find stops near a geographic location.
   *
   * Returns stops sorted by distance (nearest first).
   * Default radius: 500m.
   *
   * @param location - Center point for the search.
   * @param radiusMeters - Search radius in meters. Defaults to 500.
   * @returns Stops within the radius, sorted by distance ascending.
   */
  getNearbyStops(
    location: LatLon,
    radiusMeters?: number
  ): Promise<Stop[]>;

  /**
   * Get upcoming departures from a stop.
   *
   * Must include predictedTime when real-time data is available.
   * All times are ISO 8601 UTC. Results are ordered by scheduledTime ascending.
   *
   * @param stopId - The GTFS stop ID to query.
   * @param time - Query time window start. Defaults to now.
   * @param limit - Maximum number of departures to return.
   * @returns Departures sorted by scheduledTime ascending.
   */
  getDepartures(
    stopId: string,
    time?: Date,
    limit?: number
  ): Promise<Departure[]>;

  /**
   * Search stops by name or identifier.
   *
   * Returns stops sorted by relevance. Default limit: 10.
   *
   * @param query - Search string (stop name, code, or partial match).
   * @param limit - Maximum number of results. Defaults to 10.
   * @returns Stops sorted by relevance descending.
   */
  searchStops(query: string, limit?: number): Promise<Stop[]>;

  /**
   * Get active service alerts affecting routes or stops.
   *
   * Returns all currently active alerts. Severity is one of INFO, WARNING,
   * or CANCELLATION. Times are ISO 8601 UTC.
   *
   * @returns All active alerts. Empty array if none.
   */
  getAlerts(): Promise<Alert[]>;

  /**
   * Get current vehicle positions within a bounding box.
   *
   * Optional method — adapters without real-time vehicle tracking may omit it.
   * Positions are snapshots; callers should poll at a suitable interval.
   * All timestamps are ISO 8601 UTC.
   *
   * @param bbox - Bounding box to query.
   * @returns Vehicle positions within the box at the time of the call.
   */
  getVehiclePositions?(bbox: {
    minLat: number;
    minLon: number;
    maxLat: number;
    maxLon: number;
  }): Promise<VehiclePosition[]>;

  /**
   * Check if this adapter is healthy and reachable.
   *
   * Should perform a lightweight probe against the upstream service.
   * Must resolve (not reject) — return false on failure rather than throwing.
   *
   * @returns True if the adapter is operational, false otherwise.
   */
  healthCheck(): Promise<boolean>;
}

/** Result of running the evaluation harness across multiple adapters */
export interface AdapterBenchmarkResult {
  adapterName: string;
  query: TripQuery;
  responseTimeMs: number;
  itineraryCount: number;
  error?: string;
}

// --- City Test Profile Types ---

/** A named location within a city used for test queries */
export interface CityLandmark {
  name: string;
  location: LatLon;
  /** Known stop ID (from GTFS) if available, used for departure board tests */
  stopId?: string;
  /** Human description (e.g., "main train station", "airport") */
  role?: string;
}

/**
 * A test route scenario within a city.
 * Each scenario defines an origin, destination, and expectations.
 */
export interface TestScenario {
  /** Short identifier (e.g., "center-to-airport") */
  id: string;
  /** Human description */
  description: string;
  from: CityLandmark;
  to: CityLandmark;
  /** Expected transport modes in at least one itinerary */
  expectModes?: TransportMode[];
  /** Maximum acceptable duration in seconds (sanity bound) */
  maxDurationSeconds?: number;
  /** Minimum expected itineraries (default: 1) */
  minItineraries?: number;
  /** Whether this scenario requires a transfer */
  expectsTransfer?: boolean;
}

export interface SelfHostedGeocoderConfig {
  kind: "self-hosted";
  endpoint: string;
  flavor: "nominatim" | "photon" | "ptn-fst";
  multiTenant: boolean;
}

/** Complete test profile for a city */
export interface CityProfile {
  /** City identifier (e.g., "vilnius", "tricity") */
  id: string;
  /** Display name */
  name: string;
  country: string;
  /** Map center for this city */
  center: LatLon;
  /** Bounding box for vehicle position queries */
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  /** Transit agencies operating in this city */
  agencies: string[];
  /** Available transport modes */
  modes: TransportMode[];
  /** GTFS feed URLs (static) */
  gtfsFeeds: string[];
  /** GTFS-RT feed URLs (real-time), empty if unavailable */
  gtfsRtFeeds: string[];
  /** Named landmarks / key stops */
  landmarks: CityLandmark[];
  /** Stop name search queries expected to return results */
  searchQueries: string[];
  /** Predefined test scenarios */
  scenarios: TestScenario[];
  geocoder?: SelfHostedGeocoderConfig;
}

/** Full harness run result for a city */
export interface CityHarnessResult {
  cityId: string;
  adapterName: string;
  timestamp: string;
  healthCheck: { healthy: boolean; responseTimeMs: number };
  searchResults: Array<{
    query: string;
    resultCount: number;
    responseTimeMs: number;
    error?: string;
  }>;
  scenarioResults: Array<{
    scenarioId: string;
    /**
     * Transit itineraries only. Deliberately excludes transit-free journeys so
     * that coverage still measures transit coverage — counting a walk here
     * would make the metric unfalsifiable, since almost any two points in a
     * city are walkable.
     */
    itineraryCount: number;
    /** Transit-free journeys offered for this scenario (`TripResult.direct`). */
    directCount: number;
    responseTimeMs: number;
    /** Modes seen across all returned itineraries */
    modesFound: TransportMode[];
    /** First itinerary summary, if any */
    firstItinerary?: {
      durationSeconds: number;
      transfers: number;
      legs: number;
    };
    error?: string;
  }>;
  nearbyResults: Array<{
    landmarkName: string;
    stopCount: number;
    responseTimeMs: number;
    error?: string;
  }>;
  departureResults: Array<{
    landmarkName: string;
    departureCount: number;
    responseTimeMs: number;
    error?: string;
  }>;
}
