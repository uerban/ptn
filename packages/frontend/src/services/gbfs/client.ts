/**
 * Generic GBFS client: discovery resolution, feed fetching, and the
 * station_information ⋈ station_status merge.
 *
 * Speaks the GBFS standard, both major versions:
 * - 2.x language-keyed discovery `data.<lang>.feeds[]`
 *   (https://github.com/MobilityData/gbfs/blob/v2.3/gbfs.md#gbfsjson)
 * - 3.0 flat discovery `data.feeds[]`, plus the 3.0 station-file renames:
 *   `num_vehicles_available` and localized `name` arrays are normalized to
 *   the 2.x shapes in `types.ts`
 *   (https://github.com/MobilityData/gbfs/blob/v3.0/gbfs.md)
 *
 * Parse policy (plan the gbfs bike share map layer notes):
 * malformed station rows are skipped, never thrown; feed-level failures
 * (network, non-2xx, non-JSON, missing required feed) throw a typed
 * {@link GbfsError}.
 */

import {
  GbfsError,
  type GbfsFeedRef,
  type GbfsStation,
  type GbfsStationInformationRow,
  type GbfsStationStatusRow,
} from "./types.ts";

/** URLs of the two feeds the bike-share layer consumes. */
export interface GbfsFeedUrls {
  readonly stationInformation: string;
  readonly stationStatus: string;
}

// ---------------------------------------------------------------------------
// Shared fetch + JSON plumbing
// ---------------------------------------------------------------------------

/**
 * Per-request timeout. GBFS files are small (tens of kB); a feed that takes
 * longer than this is effectively down, and a hung fetch would otherwise
 * wedge the poll cycle (the store skips overlapping ticks).
 */
export const FETCH_TIMEOUT_MS = 10_000;

/** fetch → JSON with feed-level failures mapped to typed GbfsError kinds. */
async function fetchJson(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (cause) {
    throw new GbfsError("network", `GBFS request failed: ${url}`, { url, cause });
  }
  if (!response.ok) {
    throw new GbfsError("http", `GBFS request returned ${response.status}: ${url}`, {
      status: response.status,
      url,
    });
  }
  try {
    return await response.json();
  } catch (cause) {
    throw new GbfsError("parse", `GBFS response was not JSON: ${url}`, { url, cause });
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Discovery (gbfs.json)
// ---------------------------------------------------------------------------

const isFeedRef = (value: unknown): value is GbfsFeedRef =>
  isRecord(value) && typeof value.name === "string" && typeof value.url === "string";

/**
 * Extract the `feeds[]` array from either discovery shape:
 * 3.0 flat `data.feeds[]`, or 2.x `data.<lang>.feeds[]` (first language
 * block wins — feed URLs are language-independent for the files we use).
 * Returns null when neither shape matches (caller maps to a parse error).
 */
function extractFeeds(data: unknown): readonly GbfsFeedRef[] | null {
  if (!isRecord(data)) return null;
  if (Array.isArray(data.feeds)) {
    return data.feeds.filter(isFeedRef);
  }
  for (const block of Object.values(data)) {
    if (isRecord(block) && Array.isArray(block.feeds)) {
      return block.feeds.filter(isFeedRef);
    }
  }
  return null;
}

/**
 * Fetch the discovery document and resolve the URLs of the two required
 * feeds. Both `station_information` and `station_status` are required for
 * this layer — either one missing throws `GbfsError{kind:"missing-feed"}`
 * (the plan's "no live counts without status" stance).
 */
export async function fetchDiscovery(discoveryUrl: string): Promise<GbfsFeedUrls> {
  const doc = await fetchJson(discoveryUrl);
  const feeds = isRecord(doc) ? extractFeeds(doc.data) : null;
  if (feeds === null) {
    throw new GbfsError("parse", `GBFS discovery document has no usable feeds list: ${discoveryUrl}`, {
      url: discoveryUrl,
    });
  }
  const feedUrl = (name: string): string => {
    const feed = feeds.find((f) => f.name === name);
    if (feed === undefined) {
      throw new GbfsError("missing-feed", `GBFS discovery lists no "${name}" feed: ${discoveryUrl}`, {
        url: discoveryUrl,
      });
    }
    // The discovery document is third-party input — never follow a resolved
    // feed URL that would downgrade off https (config enforces https on the
    // discovery URL itself; this extends the floor to what it points at).
    let parsed: URL;
    try {
      parsed = new URL(feed.url);
    } catch {
      throw new GbfsError("parse", `GBFS discovery "${name}" feed URL is not a valid URL: ${feed.url}`, {
        url: discoveryUrl,
      });
    }
    if (parsed.protocol !== "https:") {
      throw new GbfsError("parse", `GBFS discovery "${name}" feed URL is not https: ${feed.url}`, {
        url: discoveryUrl,
      });
    }
    return feed.url;
  };
  return {
    stationInformation: feedUrl("station_information"),
    stationStatus: feedUrl("station_status"),
  };
}

// ---------------------------------------------------------------------------
// station_information.json / station_status.json
// ---------------------------------------------------------------------------

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isLatitude = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= -90 && value <= 90;

const isLongitude = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= -180 && value <= 180;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * `name`, both spec shapes → plain string:
 * - 2.x: a plain string
 *   (https://github.com/MobilityData/gbfs/blob/v2.3/gbfs.md#station_informationjson)
 * - 3.0: a localized array `[{ text, language }]` — the first entry's text
 *   wins, mirroring the 2.x first-language-block rule in `extractFeeds`
 *   (https://github.com/MobilityData/gbfs/blob/v3.0/gbfs.md#station_informationjson)
 */
function parseName(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value[0];
    if (isRecord(first) && typeof first.text === "string") return first.text;
  }
  return null;
}

/**
 * Tolerant row validator for station_information: `station_id`, `name`,
 * `lat`, `lon` present with the spec types
 * (https://github.com/MobilityData/gbfs/blob/v2.3/gbfs.md#station_informationjson);
 * GBFS 3.0's localized `name` array is unwrapped (see {@link parseName});
 * optional `address`/`capacity` are kept only when correctly typed.
 */
function parseInformationRow(value: unknown): GbfsStationInformationRow | null {
  if (!isRecord(value)) return null;
  const name = parseName(value.name);
  if (
    typeof value.station_id !== "string" ||
    name === null ||
    !isLatitude(value.lat) ||
    !isLongitude(value.lon)
  ) {
    return null;
  }
  return {
    station_id: value.station_id,
    name,
    lat: value.lat,
    lon: value.lon,
    ...(typeof value.address === "string" ? { address: value.address } : {}),
    ...(isNonNegativeInteger(value.capacity) ? { capacity: value.capacity } : {}),
  };
}

/**
 * Tolerant row validator for station_status: `station_id`, count and the
 * three operational flags with the spec types
 * (https://github.com/MobilityData/gbfs/blob/v2.3/gbfs.md#station_statusjson).
 * GBFS 3.0's `num_vehicles_available` rename is accepted as the bike count
 * (https://github.com/MobilityData/gbfs/blob/v3.0/gbfs.md#station_statusjson);
 * optional fields kept only when correctly typed — 3.0's RFC 3339
 * `last_reported` string is therefore dropped, not mangled.
 */
function parseStatusRow(value: unknown): GbfsStationStatusRow | null {
  if (!isRecord(value)) return null;
  const bikes = isNonNegativeInteger(value.num_bikes_available)
    ? value.num_bikes_available // 2.x
    : isNonNegativeInteger(value.num_vehicles_available)
      ? value.num_vehicles_available // 3.0 rename
      : null;
  if (
    typeof value.station_id !== "string" ||
    bikes === null ||
    typeof value.is_installed !== "boolean" ||
    typeof value.is_renting !== "boolean" ||
    typeof value.is_returning !== "boolean"
  ) {
    return null;
  }
  return {
    station_id: value.station_id,
    num_bikes_available: bikes,
    ...(isNonNegativeInteger(value.num_docks_available)
      ? { num_docks_available: value.num_docks_available }
      : {}),
    is_installed: value.is_installed,
    is_renting: value.is_renting,
    is_returning: value.is_returning,
    ...(isNonNegativeInteger(value.last_reported) ? { last_reported: value.last_reported } : {}),
  };
}

/** Extract `data.stations[]` from a feed envelope, or throw a parse error. */
function stationsArray(doc: unknown, url: string): readonly unknown[] {
  if (isRecord(doc) && isRecord(doc.data) && Array.isArray(doc.data.stations)) {
    return doc.data.stations;
  }
  throw new GbfsError("parse", `GBFS feed has no data.stations array: ${url}`, { url });
}

/** Fetch station_information; malformed rows are skipped, never thrown. */
export async function fetchStationInformation(
  url: string,
): Promise<readonly GbfsStationInformationRow[]> {
  const doc = await fetchJson(url);
  return stationsArray(doc, url)
    .map(parseInformationRow)
    .filter((row): row is GbfsStationInformationRow => row !== null);
}

/** Fetch station_status; malformed rows are skipped, never thrown. */
export async function fetchStationStatus(
  url: string,
): Promise<readonly GbfsStationStatusRow[]> {
  const doc = await fetchJson(url);
  return stationsArray(doc, url)
    .map(parseStatusRow)
    .filter((row): row is GbfsStationStatusRow => row !== null);
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merge station_information with station_status into the UI model.
 *
 * - Output order follows the info feed; status rows with no matching info
 *   row are ignored (nothing to place on the map).
 * - A station absent from status gets null counts and conservative flags:
 *   `isInstalled: true` (it is in the info feed), `isRenting: false`,
 *   `isReturning: false` — never advertise renting without status evidence.
 * - Inputs are trusted as already validated: the fetchers above (and the
 *   Dexie cache, which persists the same row shape) only ever hand over
 *   rows that passed the tolerant per-row parsers.
 */
export function mergeStations(
  info: readonly GbfsStationInformationRow[],
  status: readonly GbfsStationStatusRow[],
): GbfsStation[] {
  const statusById = new Map<string, GbfsStationStatusRow>();
  for (const row of status) {
    statusById.set(row.station_id, row);
  }

  const merged: GbfsStation[] = [];
  for (const row of info) {
    const s = statusById.get(row.station_id);
    merged.push({
      stationId: row.station_id,
      name: row.name,
      lat: row.lat,
      lon: row.lon,
      ...(row.address !== undefined ? { address: row.address } : {}),
      ...(row.capacity !== undefined ? { capacity: row.capacity } : {}),
      bikesAvailable: s?.num_bikes_available ?? null,
      docksAvailable: s?.num_docks_available ?? null,
      isInstalled: s?.is_installed ?? true,
      isRenting: s?.is_renting ?? false,
      isReturning: s?.is_returning ?? false,
      lastReported: s?.last_reported ?? null,
    });
  }
  return merged;
}
