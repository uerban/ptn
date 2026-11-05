/**
 * GBFS (General Bikeshare Feed Specification) wire types and the merged
 * station model for the bike-share map layer.
 *
 * The client speaks the GBFS standard — operator specifics (discovery URL,
 * display name) live in `CityConfig.sharedMobility`; nothing in here is
 * Cyclocity-specific. Spec reference (2.3, the version Cyclocity serves):
 * https://github.com/MobilityData/gbfs/blob/v2.3/gbfs.md
 * GBFS 3.0 is also parsed, normalized to the 2.x row shapes below: the flat
 * discovery `data.feeds[]`, `num_vehicles_available` (renamed from
 * `num_bikes_available`), and localized `name` arrays
 * (https://github.com/MobilityData/gbfs/blob/v3.0/gbfs.md). 3.0's RFC 3339
 * `last_reported` strings are dropped (the field is optional here).
 *
 * Parse policy (see plan the gbfs bike share map layer notes):
 * station rows are validated tolerantly — a malformed row is skipped, never
 * thrown — while feed-level failures (network, HTTP status, JSON parse,
 * missing required feed) surface as a typed {@link GbfsError}.
 */

// ---------------------------------------------------------------------------
// Discovery (gbfs.json)
// https://github.com/MobilityData/gbfs/blob/v2.3/gbfs.md#gbfsjson
// ---------------------------------------------------------------------------

/** One entry of the discovery `feeds[]` array (name + fetchable URL). */
export interface GbfsFeedRef {
  readonly name: string;
  readonly url: string;
}

// ---------------------------------------------------------------------------
// station_information.json
// https://github.com/MobilityData/gbfs/blob/v2.3/gbfs.md#station_informationjson
// ---------------------------------------------------------------------------

/**
 * One `data.stations[]` row of station_information, normalized: only the
 * fields the layer consumes; extra spec fields pass through untyped and are
 * ignored. `station_id`, `name`, `lat`, `lon` are REQUIRED by the spec —
 * rows where they are missing or mistyped are skipped by the tolerant
 * parser, which also unwraps GBFS 3.0's localized `name` array into the
 * plain string held here.
 */
export interface GbfsStationInformationRow {
  readonly station_id: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  /** Optional in spec; Cyclocity ships it. */
  readonly address?: string;
  /** Total docks at the station, optional in spec. */
  readonly capacity?: number;
}

// ---------------------------------------------------------------------------
// station_status.json
// https://github.com/MobilityData/gbfs/blob/v2.3/gbfs.md#station_statusjson
// ---------------------------------------------------------------------------

/**
 * One `data.stations[]` row of station_status, normalized: availability
 * counts plus the three operational flags (all REQUIRED by the spec).
 * `num_bikes_available` also carries GBFS 3.0's `num_vehicles_available`
 * (the parser normalizes the rename). `last_reported` is epoch seconds in
 * 2.3; 3.0's RFC 3339 string form is dropped by the tolerant parser.
 */
export interface GbfsStationStatusRow {
  readonly station_id: string;
  readonly num_bikes_available: number;
  readonly num_docks_available?: number;
  readonly is_installed: boolean;
  readonly is_renting: boolean;
  readonly is_returning: boolean;
  readonly last_reported?: number;
}

// ---------------------------------------------------------------------------
// Merged station model (station_information ⋈ station_status)
// ---------------------------------------------------------------------------

/**
 * A station as the UI consumes it: static info merged with live status.
 *
 * `null` counts mean "status unknown" (offline-cached positions, or the
 * station was absent from station_status) — the marker layer renders these
 * grey with no count label, never as `0`. A station absent from status also
 * gets `isRenting: false` / `isReturning: false`: we never advertise renting
 * without status evidence (conservative default).
 */
export interface GbfsStation {
  readonly stationId: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  readonly address?: string;
  readonly capacity?: number;
  /** null ⇒ status unknown (offline / missing from station_status) */
  readonly bikesAvailable: number | null;
  readonly docksAvailable: number | null;
  readonly isInstalled: boolean;
  readonly isRenting: boolean;
  readonly isReturning: boolean;
  /** Epoch seconds, from status `last_reported`; null when status unknown. */
  readonly lastReported: number | null;
}

// ---------------------------------------------------------------------------
// Feed-level errors
// ---------------------------------------------------------------------------

/**
 * Discriminant for {@link GbfsError}. The store treats every kind the same
 * way (log + degrade to `offline-cached`/`error`); the kind plus the
 * `status`/`url` payload exist for that diagnostic log and for tests that
 * pin which failure class a code path produces.
 */
export type GbfsErrorKind =
  /** fetch() rejected (offline, DNS, CORS, aborted). */
  | "network"
  /** Non-2xx HTTP response. */
  | "http"
  /** Body was not JSON, or the document shape was unusable. */
  | "parse"
  /** Discovery succeeded but a required feed is not listed. */
  | "missing-feed";

/**
 * Typed feed-level failure. Row-level problems never raise this — malformed
 * station rows are skipped per the tolerant parse policy; only failures that
 * make a whole feed unusable do.
 */
export class GbfsError extends Error {
  readonly kind: GbfsErrorKind;
  /** HTTP status code, set when `kind === "http"`. */
  readonly status?: number;
  /** URL of the request that failed, when known. */
  readonly url?: string;

  constructor(
    kind: GbfsErrorKind,
    message: string,
    options?: { status?: number; url?: string; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "GbfsError";
    this.kind = kind;
    this.status = options?.status;
    this.url = options?.url;
  }
}
