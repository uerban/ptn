import type { TransportMode } from "./transit.js";
import type { RtTripUpdate } from "../proto/route-update.js";
import type { Bbox } from "../poi/tileKey.js";

/**
 * In-band bundle-hash discovery header, carried by tile, RT-tile and manifest
 * responses on BOTH serving planes (Node `routes/*.ts` and pt-serve
 * `http/adapter.rs`). The single source of truth for the name on the TS side —
 * import it rather than writing the literal, so a rename stays atomic.
 *
 * `ptn` is the outward-facing name (URLs, deploy); `pt` is the internal one,
 * and the bundle is an internal artifact. Every client consumer falls back to
 * the manifest body's `bundleHash` when the header is absent
 * (`scheduleTileReadPath.ts`: `r.bundleHash ?? r.manifest.bundleHash`), so a
 * missing header costs one round-trip, not correctness.
 */
export const BUNDLE_HASH_HEADER = "X-PT-Bundle-Hash";

/**
 * Decoded schedule tile.
 *
 * Stop-major columnar layout: each stop has parallel `(tripIxs, departureSecs)`
 * arrays sorted ascending by `departureSecs`. Trip rows in `trips` carry
 * uint32 indices into `routes`, `calendar`, and `stringTable`.
 *

 * * Base-date scoping: the tile does NOT carry a `baseDates` field. It carries the full
 * calendar, and `getDeparturesFromTile` derives the relevant base-date set
 * (yesterday/today/tomorrow/day-after-tomorrow per round-4) from its `now` parameter at call
 * time.
 */
export interface DecodedScheduleTile {
  /**
 * Hex SHA-256 of canonical inputs.
 */
  bundleHash: string;
  /** Stable city slug, e.g. "vilnius". */
  cityId: string;
  /**
 * Cell side length in meters; fixed at 12000.
 */
  tileSize: number;
  /** String intern table. Per-tile, NFC-normalised; not shared across tiles. */
  stringTable: readonly string[];
  /** Routes indexed by `TileTripRow.routeIx`. */
  routes: readonly RouteRow[];
  /** Calendar entries indexed by `TileTripRow.serviceIx`. */
  calendar: readonly CalendarRow[];
  /** Per-stop columnar view. Key: GTFS canonical `stop_id`. */
  stops: Readonly<Record<string, TileStopColumns>>;
  /** Per-trip metadata; `TileStopColumns.tripIxs[k]` indexes into this array. */
  trips: readonly TileTripRow[];
}

/**
 * Per-stop columnar view: trip indices and their boarding times at this stop,
 * sorted ascending by `departureSecs`. `lowerBound` over `departureSecs`
 * locates the first trip at or after a given query time in O(log n).
 *

 * * Both arrays MUST have the same length and parallel ordering. `departureSecs` may exceed
 * 86400 for trips that roll past midnight ("Multi-day window"); the consumer reconstructs
 * wall-clock time from `baseDate + departureSecs`.
 */
export interface TileStopColumns {
  /** Indices into `DecodedScheduleTile.trips`, parallel to `departureSecs`. */
  tripIxs: Readonly<Uint32Array>;
  /** Seconds since base-date midnight, sorted ascending. */
  departureSecs: Readonly<Uint32Array>;
}

/**
 * Per-trip metadata. All string-valued fields are stringTable indices.
 * The trip's GTFS canonical `trip_id` is `stringTable[tripIdIx]`.
 */
export interface TileTripRow {
  /** Index into `stringTable` for the GTFS `trip_id`. */
  tripIdIx: number;
  /** Index into `DecodedScheduleTile.routes`. */
  routeIx: number;
  /** Index into `DecodedScheduleTile.calendar`. */
  serviceIx: number;
  /** Index into `stringTable` for the trip's headsign. */
  headsignIx: number;
}

/**
 * Per-route metadata. IDs are GTFS canonical strings ("Canonical bundle IDs"); `mode` reuses
 * the existing shared `TransportMode` union so `Departure.mode` and `RouteRow.mode` agree
 * without conversion.
 */
export interface RouteRow {
  /** GTFS `route_id`. */
  id: string;
  /** GTFS `route_short_name` (e.g. "42", "M1"). */
  shortName: string;
  /** GTFS `route_long_name`. */
  longName: string;
  /** Brand color in hex `#RRGGBB`, when present in GTFS `route_color`. */
  color?: string;
  /** Transport mode shared with `Departure.mode`. */
  mode: TransportMode;
  /**
   * GTFS extended `route_type` sub-mode label (e.g. "EXPRESS_BUS").
   * Optional; absent for routes without a sub-mode classification.
   */
  subMode?: string;
}

/**
 * GTFS calendar row plus `calendar_dates.txt` exceptions, flattened.
 * `serviceActiveForDate(ymd, row)` is the canonical predicate.
 *
 * `days` follows the existing `RoutingBundleService.days` convention
 * (`packages/shared/src/types/routingBundle.ts`):
 * `[mon, tue, wed, thu, fri, sat, sun]`, length 7.
 * To check today's bit from a JS `Date`, use `days[(d.getDay() + 6) % 7]`
 * (`getDay()` returns Sun = 0, but this array is Mon = 0).
 *
 * `startDate`, `endDate`, `added`, `removed` are local-time `YYYYMMDD`
 * 8-character strings, matching `ymdLocal` output.
 */
/**
 * Day-of-week activity mask, length 7, in
 * `[mon, tue, wed, thu, fri, sat, sun]` order.
 *
 * Encoded as a fixed-arity tuple so TypeScript enforces length=7 at the
 * type level. Without this, the legacy length-7 invariant lived only in
 * a doc comment and could be silently violated by passing a 5- or
 * 8-element array.
 */
export type DaysOfWeek = readonly [
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
];

export interface CalendarRow {
  /** GTFS `service_id`. */
  serviceId: string;
  /** `[mon, tue, wed, thu, fri, sat, sun]`; `true` means service runs that day. */
  days: DaysOfWeek;
  /** Inclusive `YYYYMMDD` start date. */
  startDate: string;
  /** Inclusive `YYYYMMDD` end date. */
  endDate: string;
  /** Dates added by `calendar_dates.txt` (YYYYMMDD). */
  added: readonly string[];
  /** Dates removed by `calendar_dates.txt` (YYYYMMDD). */
  removed: readonly string[];
}

/**
 * Tri-state result returned by `getDeparturesFromTile` alongside the filtered departures list.
 * Drives the frontend countdown component's tri-state pill.

 *
 * - `"active"`: today is active for the queried stop AND at least one
 *   departure was returned within the requested window.
 * - `"ended_today"`: today is active for the queried stop but no entry
 *   survives the window filter (last scheduled departure already past).
 * - `"no_service_today"`: no `CalendarRow` is active for today's date for
 *   any trip touching the queried stop.
 *
 * **Important invariant for consumers:** `serviceState === "no_service_today"`
 * does NOT imply `departures.length === 0`. An overnight trip from
 * yesterday's base date (e.g. `departureSec >= 86400`) can roll into today's
 * wall-clock window and appear in `departures` while the pill correctly
 * reports today as inactive. Render `departures` independently of the pill
 * state — never gate the departure list on `serviceState`.
 */
export type ServiceState = "active" | "ended_today" | "no_service_today";

/**
 * One subdivision leaf descriptor recorded in the manifest. `suffix` is the
 * quadtree-path digits ("0", "0-3", …) appended to the parent `<x>_<y>` cell
 * key to form the on-disk filename `<x>_<y>-<suffix>.br`. `bbox` is the leaf's
 * exact lat/lon bounds (the sub-edge; the URL/grid label stays the 6 km cell).
 * `oversized` ⇒ the leaf could not be brought under the compressed-byte cap
 * (irreducible mega-station). Pinned field order for stable JSON.
 */
export interface SubdivisionLeaf {
  suffix: string;
  bbox: Bbox;
  compressedBytes: number;
  oversized: boolean;
}

/**
 * Per-cell subdivision plan. The manifest is the SOLE authority for which leaves
 * exist — consumers MUST enumerate leaves from here, never derive addresses from
 * geometry alone.
 */
export interface SubdivisionPlan {
  leaves: SubdivisionLeaf[];
}

/**
 * `GET /api/gtfs/manifest` response. `Cache-Control: no-cache`, ETag-revalidated. Used by the
 * frontend on first cold load to discover the current `bundleHash`; subsequent updates flow
 * in-band via the {@link BUNDLE_HASH_HEADER} response header on tile and RT-tile responses.

 *
 * Named `BundleManifest` to disambiguate from the existing `Manifest` in
 * `packages/backend/src/poi/manifest.ts` (POI bundle manifest, a different
 * concern). Both names live in the monorepo; the distinguishing prefix
 * prevents accidental cross-import confusion.
 */
export interface BundleManifest {
  /**
   * Manifest schema version. Bumped when the manifest shape changes in a way
   * older readers cannot parse. 1 introduces `subdivisions`. Old readers that
   * only consume `bundleHash`/`generatedAt`/`tileSize` ignore it.
   */
  schemaVersion: number;
  bundleHash: string;
  /** Unix timestamp (ms) the bundle was published. */
  generatedAt: number;
  /**
   * Side length of the TOP-LEVEL grid cell in meters (always 6000 for schedule
   * tiles). Stays the grid/URL label even for subdivided cells — a leaf's true
   * sub-edge lives ONLY in its `subdivisions[*].leaves[*].bbox`.
   */
  tileSize: number;
  /**
   * Per-cell subdivision plans, keyed by `<x>_<y>`. Absent ⇒ no cell was
   * subdivided this build (back-compat default).
   */
  subdivisions?: Record<string, SubdivisionPlan>;
}

/**
 * `GET /api/gtfs/rt-tile/:bundleHash/:tileSize/:tileCoords` response. One-request-per-tile
 * aggregation of GTFS-RT trip updates.

 *
 * `bundleHash` echoes the URL segment so a stale-bundle client gets a
 * 409 Conflict (carrying the current hash in the body) rather than a
 * silently-mismatched payload.
 *
 * Membership (Stage A): `trips` carries an RT entry for EVERY trip the
 * schedule-tile at these coords carries a departure for (membership mirrors
 * `buildTileForCell`'s touch-any-stop set). A trip touching stops in two tiles
 * therefore appears in BOTH tiles' responses — there is no first-stop
 * partition. `getDeparturesFromTile` overlays by `tripId`, so per-tile
 * duplication across tiles is benign (each consumer fetches one tile).
 */
export interface RtTileResponse {
  bundleHash: string;
  /** Unix timestamp (ms) the response was generated by the backend. */
  generatedAt: number;
  /**
   * RT trip updates for every trip in this tile (see membership note above).
   * Reuses the `RtTripUpdate` shape from `proto/route-update.ts`; `receivedAt`
   * is never emitted (the handler builds wire objects field-by-field), and
   * `startDate` (YYYYMMDD) is present when the feed set `trip.start_date`.
   */
  trips: RtTripUpdate[];
}

/**
 * 404 body for a bare coord addressed to a SUBDIVIDED cell. `leaves` inlines the
 * cell's leaf suffixes from the same manifest snapshot (S15) so the consumer
 * resolves the owning leaf with no extra manifest round-trip. ONLY the
 * `scheduleTile` route inlines `leaves`; the RT route omits it (R11).
 */
export interface TileSubdividedBody {
  error: "tile_subdivided";
  leaves: string[];
}

/** 404 body for a leaf coord whose suffix is not in the cell's plan, or a leaf
 *  coord against an unsubdivided cell (S8). */
export interface TileNotFoundBody {
  error: "tile_not_found";
}

/** Either 404 sub-reason. Exported so the consumer cascade and the route handlers
 *  share ONE shape and cannot drift (R24). */
export type TileErrorBody = TileSubdividedBody | TileNotFoundBody;

/** 409 body: requested hash is stale and the current hash is known. */
export interface BundleHashMismatchBody {
  error: "bundle_hash_mismatch";
  currentBundleHash: string;
}

/** 409 body: bundle dir absent (build in progress / cold start). */
export interface BundleUnavailableBody {
  error: "bundle_unavailable";
}

/** Either 409 sub-reason (R24). */
export type Tile409Body = BundleHashMismatchBody | BundleUnavailableBody;
