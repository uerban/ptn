/** Default radius in meters for nearby stop searches */
export const DEFAULT_NEARBY_RADIUS_METERS = 500;

/** Default number of departures to fetch */
export const DEFAULT_DEPARTURES_LIMIT = 20;

/** Default number of search results */
export const DEFAULT_SEARCH_LIMIT = 10;

/** Minimum query length the remote stops endpoint will accept. Shared so the
 *  frontend skips the round-trip and the backend rejects on the same threshold. */
export const REMOTE_STOP_SEARCH_MIN_CHARS = 2;

/** Polling interval for real-time vehicle positions (ms) */
export const REALTIME_POLL_INTERVAL_MS = 30_000;

/** Polling interval for alerts (ms) */
export const ALERTS_POLL_INTERVAL_MS = 60_000;

/** Cache TTL for recent routes (ms) — 24 hours */
export const ROUTE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Transitous API base URL (free MOTIS instance) */
export const TRANSITOUS_API_URL = "https://api.transitous.org/api";

/** Progressive preload radii in meters */
export const PRELOAD_RADII_METERS = [1000, 3000, 5000, 10000];

/** Max stops per nearby request */
export const MAX_NEARBY_STOPS = 200;

/** Cache TTLs */
export const STOP_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const LINE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const DEPARTURE_CACHE_TTL_MS = 60 * 1000; // 60 seconds

/** Viewport enrichment */
export const ENRICHMENT_DEBOUNCE_MS = 300;
export const ENRICHMENT_MAX_CONCURRENT = 2;

/** Countdown */
export const COUNTDOWN_INTERVAL_MS = 1000;
export const DEPARTED_CUTOFF_MINUTES = -10;
/** Tighter cutoff for non-polling views (popup) — evict stale "Due" faster */
export const POPUP_DEPARTED_CUTOFF_MINUTES = -1;

/** Show absolute clock time instead of countdown beyond this threshold */
export const ABSOLUTE_TIME_THRESHOLD_MINUTES = 60;

/**
 * Map zoom thresholds. Below ZOOM_OVERVIEW_MAX the map shows one static marker
 * per covered city instead of stops; stop aggregates hid the streets of the
 * city users were navigating, so stops show individually from there on. At
 * zoom 9 a phone fits a whole metro area in ~110 px, where dots merge into one
 * blob that hides the city, so the switch happens at 10.
 */
export const ZOOM_OVERVIEW_MAX = 10;
export const ZOOM_DOTS_MIN = ZOOM_OVERVIEW_MAX;
export const ZOOM_LABELS_MIN = 14;
export const ZOOM_CARDS_MIN = 15;

/**
 * Fraction of the viewport span by which marker rendering — and the urban-mode
 * badge-activity sweep — extend beyond the visible bounds on every side. 0.5
 * means stop cards are pre-rendered within 1.5x the viewport so they don't pop
 * in during panning. The badge-activity computation MUST use the SAME buffer as
 * the marker filter: a card drawn in the buffer ring without a resolved badge
 * entry would fail open to its full (stale) line set. Shared so the two filters
 * can never drift apart.
 */
export const VIEWPORT_BUFFER = 0.5;

/** Urban mode: default lookahead window in hours */
export const DEFAULT_URBAN_LOOKAHEAD_HOURS = 2;

/** Urban mode: how often to refresh active routes (ms) */
export const URBAN_REFRESH_INTERVAL_MS = 300_000;

/** Backend GTFS-RT ingestion interval (ms) — feeds polled this often */
export const RT_BACKEND_POLL_INTERVAL_MS = 12_000;

/** Client RT polling — idle (browsing, no active trip) */
export const RT_CLIENT_IDLE_INTERVAL_MS = 30_000;

/** Client RT polling — active navigation */
export const RT_CLIENT_NAVIGATE_INTERVAL_MS = 8_000;

/** Client RT polling — approaching a transfer */
export const RT_CLIENT_TRANSFER_INTERVAL_MS = 5_000;

/** Max age for per-route RT protobuf Cache-Control (seconds) */
export const RT_CACHE_MAX_AGE_S = 5;

/** Client GTFS data refresh interval (ms) — 6 hours */
export const GTFS_CLIENT_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** RAPTOR: maximum number of transfer rounds */
export const RAPTOR_MAX_ROUNDS = 4;
/** RAPTOR: minimum transfer time in seconds */
export const RAPTOR_MIN_TRANSFER_SECS = 120;
/** Wire-format schema version for the raptor-data bundle. Bump when adding
 *  fields the frontend must read. New fields should be optional so older
 *  clients keep working — the frontend warns when the server reports a
 *  version greater than this constant (server ahead of client). */
export const RAPTOR_DATA_VERSION = 1;
/** Default walking speed in meters per second (4.5 km/h) */
export const DEFAULT_WALK_SPEED_MPS = 1.25;
/** Default walking speed for wheelchair profile in m/s (~3 km/h) */
export const WHEELCHAIR_WALK_SPEED_MPS = 0.8;
/** Walking speed in m/s (3.5 km/h) the vision-impaired profile starts from
 *  when the rider chooses it. A start, not a cap: the rider can raise it. The
 *  figure is the profile table of
 *  the on device navigation notes. */
export const VISION_IMPAIRED_WALK_SPEED_MPS = 3.5 / 3.6;
/** Run-to-catch: how much faster than their own walking speed a rider moves
 *  when they are willing to hurry. A jog, not a sprint — the feature exists to
 *  make a departure that is already in sight, not to model an athlete. */
export const RUN_TO_CATCH_SPEED_FACTOR = 2.0;
/** Run-to-catch: ceiling on the hurried speed in m/s (~9.4 km/h), so a user
 *  who has raised their walking speed does not end up sprinting. */
export const MAX_RUN_SPEED_MPS = 2.6;
/** OSRM foot profile walking speed in m/s (5 km/h — the speed OSRM's default
 *  pedestrian profile uses when reporting `duration` from a table query). */
export const OSRM_FOOT_SPEED_MPS = 1.3889;
/** Default maximum walking time in seconds (15 min) */
export const DEFAULT_MAX_WALK_SECS = 900;
/** Default maximum walking distance in meters */
export const DEFAULT_MAX_WALK_METERS = 1125;
/** Maximum results to return from search */
export const ROUTING_MAX_RESULTS = 5;
/** Fallback stop search radius in meters (when OSRM not available) */
export const FALLBACK_STOP_RADIUS_METERS = 800;
