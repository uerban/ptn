import { parse } from "csv-parse";
import { routeTypeToMode } from "@pt/shared";
import type { TransportMode } from "@pt/shared";

// ── Types ───────────────��────────────────────────────────���─────────────────

/** Compact stop-time entry stored in indexes (no stopId/stopSequence — implicit from Map key / unused) */
export interface IndexedStopTime {
  tripId: string;
  departureSecs: number;
}

export interface GtfsStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  parentStation: string;
  wheelchairBoarding?: number; // 0=unknown, 1=yes, 2=no (GTFS spec)
}

export interface GtfsRoute {
  id: string;
  shortName: string;
  longName: string;
  mode: TransportMode;
  color: string;
  textColor: string;
  /** GTFS route agency_id cross-reference (conditionally required; omitted for single-agency feeds). */
  agencyId?: string;
}

export interface GtfsTrip {
  tripId: string;
  routeId: string;
  serviceId: string;
  headsign: string;
  /** Stable PTB global trip ordinal. Present only on PTB-backed loads. */
  ptbTripIdx?: number;
  wheelchairAccessible?: number; // 0=unknown, 1=yes, 2=no (GTFS spec)
  bikesAllowed?: number; // 0=unknown, 1=yes, 2=no (GTFS spec)
  shapeId?: string;
  // GTFS `direction_id` — 0 or 1. Optional in the spec; absent on feeds that
  // don't disambiguate. Index-builder uses it to group trips into directional
  // patterns and falls back to headsign when missing.
  directionId?: 0 | 1;
}

export interface GtfsShapePoint {
  shapeId: string;
  lat: number;
  lon: number;
  sequence: number;
}

export interface GtfsStopTime {
  tripId: string;
  stopId: string;
  /**
   * GTFS `arrival_time` string (may be `>= 24:00:00` for overnight trips).
   * Optional: feeds are only required by the GTFS spec to provide one of
   * arrival_time / departure_time; older or minimal feeds omit arrival_time
   * and we treat it as equal to `departureTime` (zero dwell). When present
   * and strictly earlier than departureTime, the delta feeds the per-stop
   * dwell that RAPTOR uses to compute `arrival_time` at alight-time.
   */
  arrivalTime?: string;
  departureTime: string;
  stopSequence: number;
  /**
   * GTFS `pickup_type` (0=regular/default, 1=not-available, 2=phone, 3=driver).
   * Omitted when 0 or empty (default — passengers may board).
   * Spec: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
   */
  pickupType?: number;
  /**
   * GTFS `drop_off_type` (same domain as pickup_type). Omitted when 0 or empty.
   * Spec: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
   */
  dropOffType?: number;
}

export interface GtfsService {
  serviceId: string;
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
  startDate: string;
  endDate: string;
}

export interface GtfsCalendarDate {
  serviceId: string;
  date: string;
  exceptionType: number;
}

export interface GtfsAgency {
  /**
   * GTFS `agency_id`. Conditionally required — optional when the feed has
   * exactly one agency — so the missing column collapses to "".
   */
  agencyId: string;
  agencyName: string;
  /** GTFS `agency_timezone` — IANA tz database name (e.g. "Europe/Vilnius"). */
  agencyTimezone: string;
  /** GTFS agency_url. */ url?: string;
  /** GTFS agency_lang. */ lang?: string;
  /** GTFS agency_phone. */ phone?: string;
  /** GTFS agency_fare_url. */ fareUrl?: string;
  /** GTFS agency_email. */ email?: string;
}

export interface GtfsTransfer {
  /** Absent only on a PTB v2 linked row (transfer_type 4/5) keyed by trips alone. */
  fromStopId?: string;
  toStopId?: string;
  /** GTFS `transfer_type`. 0=recommended, 1=timed, 2=min-time, 3=not-possible, 4=in-seat, 5=re-board. Blank/missing -> 0. */
  transferType: number;
  /** GTFS `min_transfer_time` in seconds. Absent/empty -> undefined. */
  minTransferSecs?: number;
  fromRouteId?: string;
  toRouteId?: string;
  fromTripId?: string;
  toTripId?: string;
}

/** A GTFS frequencies.txt row (headway-based service). Spec: https://gtfs.org/documentation/schedule/reference/#frequenciestxt */
export interface GtfsFrequency {
  tripId: string;
  /** start_time in seconds (overnight-safe). */
  startSecs: number;
  /** end_time in seconds (exclusive). */
  endSecs: number;
  /** headway_secs — INTEGER seconds, not a time string. */
  headwaySecs: number;
  /** exact_times: 1 = schedule-based (expanded in 2b); 0/absent = frequency-based (rejected in 2b). */
  exactTimes: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Convert "HH:MM:SS" (may be >= 24:00:00 for overnight trips) to seconds since midnight. Returns NaN for missing/malformed input. */
export function parseTimeToSecs(time: string | undefined): number {
  if (!time) return NaN;
  const parts = time.split(":");
  if (parts.length < 3) return NaN;
  const secs = parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
  return secs;
}

/**
 * Serialize seconds-since-midnight to "HH:MM:SS", NO modulo (emits "25:00:00"
 * for overnight). Date-free. Inverse of parseTimeToSecs for integer secs >= 0.
 * Spec: https://gtfs.org/documentation/schedule/reference/#field-types (time)
 */
export function secsToGtfsTime(secs: number): string {
  if (!Number.isInteger(secs) || secs < 0) {
    throw new Error(`secsToGtfsTime: expected a non-negative integer, got ${secs}`);
  }
  const hh = String(Math.floor(secs / 3600)).padStart(2, "0");
  const mm = String(Math.floor(secs / 60) % 60).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

const CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB

/** Parse a Uint8Array of CSV data into record objects using streaming csv-parse */
async function parseCsvAsync(data: Uint8Array): Promise<Record<string, string>[]> {
  const parser = parse({
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    relax_column_count: true,
    bom: true,
  });

  const records: Record<string, string>[] = [];
  parser.on("readable", () => {
    let record: Record<string, string> | null;
    while ((record = parser.read() as Record<string, string> | null) !== null) {
      records.push(record);
    }
  });

  const done = new Promise<void>((resolve, reject) => {
    parser.on("end", resolve);
    parser.on("error", reject);
  });

  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, data.length);
    parser.write(data.subarray(offset, end));
  }
  parser.end();

  await done;
  return records;
}

/** Convert GTFS 0/1 string to boolean */
function toBoolean(value: string): boolean {
  return value === "1";
}

// ── Parsers ────────────────────────────────────────────────────────────────

export async function parseStops(data: Uint8Array): Promise<GtfsStop[]> {
  const rows = await parseCsvAsync(data);
  return rows.map((row) => ({
    id: row["stop_id"],
    name: row["stop_name"],
    lat: parseFloat(row["stop_lat"]),
    lon: parseFloat(row["stop_lon"]),
    parentStation: row["parent_station"] ?? "",
    wheelchairBoarding: row["wheelchair_boarding"] ? parseInt(row["wheelchair_boarding"], 10) : undefined,
  }));
}

export async function parseRoutes(data: Uint8Array): Promise<GtfsRoute[]> {
  const rows = await parseCsvAsync(data);
  return rows.map((row) => ({
    id: row["route_id"],
    shortName: row["route_short_name"],
    longName: row["route_long_name"],
    mode: routeTypeToMode(parseInt(row["route_type"], 10)),
    color: row["route_color"] ?? "",
    textColor: row["route_text_color"] ?? "",
    agencyId: row["agency_id"] || undefined,
  }));
}

export async function parseTrips(data: Uint8Array): Promise<GtfsTrip[]> {
  const rows = await parseCsvAsync(data);
  return rows.map((row) => {
    const rawDir = row["direction_id"];
    let directionId: 0 | 1 | undefined;
    if (rawDir === "0") directionId = 0;
    else if (rawDir === "1") directionId = 1;
    return {
      tripId: row["trip_id"],
      routeId: row["route_id"],
      serviceId: row["service_id"],
      headsign: row["trip_headsign"] ?? "",
      wheelchairAccessible: row["wheelchair_accessible"] ? parseInt(row["wheelchair_accessible"], 10) : undefined,
      bikesAllowed: row["bikes_allowed"] ? parseInt(row["bikes_allowed"], 10) : undefined,
      shapeId: row["shape_id"] || undefined,
      ...(directionId !== undefined ? { directionId } : {}),
    };
  });
}

export async function parseStopTimes(data: Uint8Array): Promise<GtfsStopTime[]> {
  const rows = await parseCsvAsync(data);
  return rows.map((row) => ({
    tripId: row["trip_id"],
    stopId: row["stop_id"],
    // Keep only when it differs from departure_time — at most stops they
    // are equal, and we want the downstream "dwell = dep - arr" computation
    // to see `undefined` in that case so it short-circuits without
    // allocating a dwell array. Empty strings in the CSV also collapse to
    // undefined so a feed that writes `""` is treated like a feed that
    // omits the column.
    arrivalTime:
      row["arrival_time"] && row["arrival_time"] !== row["departure_time"]
        ? row["arrival_time"]
        : undefined,
    departureTime: row["departure_time"],
    stopSequence: parseInt(row["stop_sequence"], 10),
    pickupType:
      row["pickup_type"] && row["pickup_type"] !== "0"
        ? parseInt(row["pickup_type"], 10)
        : undefined,
    dropOffType:
      row["drop_off_type"] && row["drop_off_type"] !== "0"
        ? parseInt(row["drop_off_type"], 10)
        : undefined,
  }));
}

export async function parseCalendar(data: Uint8Array): Promise<GtfsService[]> {
  const rows = await parseCsvAsync(data);
  return rows.map((row) => ({
    serviceId: row["service_id"],
    monday: toBoolean(row["monday"]),
    tuesday: toBoolean(row["tuesday"]),
    wednesday: toBoolean(row["wednesday"]),
    thursday: toBoolean(row["thursday"]),
    friday: toBoolean(row["friday"]),
    saturday: toBoolean(row["saturday"]),
    sunday: toBoolean(row["sunday"]),
    startDate: row["start_date"],
    endDate: row["end_date"],
  }));
}

export async function parseCalendarDates(data: Uint8Array): Promise<GtfsCalendarDate[]> {
  const rows = await parseCsvAsync(data);
  return rows.map((row) => ({
    serviceId: row["service_id"],
    date: row["date"],
    exceptionType: parseInt(row["exception_type"], 10),
  }));
}

/**
 * Parse GTFS `transfers.txt` into `GtfsTransfer[]`.
 *
 * Spec: https://gtfs.org/documentation/schedule/reference/#transferstxt
 *
 * `transfer_type` is required by the spec but tolerated here: blank/missing
 * collapses to 0 (recommended transfer point). `min_transfer_time` is parsed
 * to integer seconds; absent/empty -> undefined. The optional id columns
 * (`from_route_id`, `to_route_id`, `from_trip_id`, `to_trip_id`) collapse to
 * undefined when empty so a feed that writes `""` is treated like a feed that
 * omits the column.
 */
export async function parseTransfers(data: Uint8Array): Promise<GtfsTransfer[]> {
  const rows = await parseCsvAsync(data);
  return rows.map((row) => {
    const rawType = parseInt(row["transfer_type"] ?? "", 10);
    const rawMin = parseInt(row["min_transfer_time"] ?? "", 10);
    return {
      fromStopId: row["from_stop_id"],
      toStopId: row["to_stop_id"],
      // Blank/unparseable/out-of-u8-range transfer_type → 0 (recommended),
      // matching the producer's `parse::<u8>().unwrap_or(0)` (pass1/transfers.rs):
      // anything not in 0..=255 (incl. NaN, negative, ">255") becomes 0, so the
      // two ingest paths agree and no NaN leaks into S1's switch.
      transferType: Number.isInteger(rawType) && rawType >= 0 && rawType <= 255 ? rawType : 0,
      // Malformed/negative/out-of-u32-range min_transfer_time → undefined
      // (absent), matching the producer's `parse::<u32>()`-or-ABSENT.
      minTransferSecs:
        Number.isInteger(rawMin) && rawMin >= 0 && rawMin <= 0xffffffff ? rawMin : undefined,
      fromRouteId: row["from_route_id"] || undefined,
      toRouteId: row["to_route_id"] || undefined,
      fromTripId: row["from_trip_id"] || undefined,
      toTripId: row["to_trip_id"] || undefined,
    };
  });
}

/**
 * Parse GTFS `frequencies.txt` into `GtfsFrequency[]`.
 *
 * Spec: https://gtfs.org/documentation/schedule/reference/#frequenciestxt
 *
 * Does NOT throw on malformed values — validation is left to the downstream
 * frequency-expansion consumer (the parser is shared with the deferred
 * exact_times=0 reader path). Times are
 * parsed via `parseTimeToSecs` (overnight-safe; returns NaN on malformed).
 * `headway_secs` is parsed as a base-10 integer. `exact_times` defaults to 0
 * when absent or blank. Returns [] for empty input.
 */
export async function parseFrequencies(data: Uint8Array): Promise<GtfsFrequency[]> {
  const rows = await parseCsvAsync(data);
  return rows.map((row) => ({
    tripId: row["trip_id"],
    startSecs: parseTimeToSecs(row["start_time"]),
    endSecs: parseTimeToSecs(row["end_time"]),
    headwaySecs: parseInt(row["headway_secs"] ?? "", 10),
    exactTimes: row["exact_times"] === "1" ? 1 : 0,
  }));
}

/**
 * Parse GTFS `agency.txt` into `GtfsAgency[]`.
 *
 * Spec: https://gtfs.org/documentation/schedule/reference/#agencytxt
 *

 * * `agency_timezone` is required by the spec and the feed's single feed-level timezone (PTN
 * models one tz per feed — see / the single-timezone best-practice; we do NOT model per-agency
 * tz). `agency_id` is conditionally required (optional for a single-agency feed) so the missing
 * column collapses to "". Tolerates an empty buffer (no agency.txt) by returning [] —
 * agency.txt is required by the spec but we never block a rebuild on its absence; the tz simply
 * stays unknown.
 */
export async function parseAgency(data: Uint8Array): Promise<GtfsAgency[]> {
  const rows = await parseCsvAsync(data);
  return rows.map((row) => ({
    agencyId: row["agency_id"] ?? "",
    agencyName: row["agency_name"] ?? "",
    agencyTimezone: row["agency_timezone"] ?? "",
    url: row["agency_url"] || undefined,
    lang: row["agency_lang"] || undefined,
    phone: row["agency_phone"] || undefined,
    fareUrl: row["agency_fare_url"] || undefined,
    email: row["agency_email"] || undefined,
  }));
}

export async function parseShapes(data: Uint8Array): Promise<GtfsShapePoint[]> {
  const rows = await parseCsvAsync(data);
  const out: GtfsShapePoint[] = [];
  for (const row of rows) {
    const shapeId = row["shape_id"];
    if (!shapeId) continue;
    const lat = Number(row["shape_pt_lat"]);
    const lon = Number(row["shape_pt_lon"]);
    const sequence = Number(row["shape_pt_sequence"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(sequence)) continue;
    out.push({ shapeId, lat, lon, sequence });
  }
  return out;
}

// ── Trip-ID string intern table ──────────────────────────────────────────────

/**
 * Intern table mapping strings to compact numeric indexes.
 *
 * Used by `index-builder` to store 20M+ tripId references as 4-byte Uint32
 * entries in a typed-array column instead of 48-byte String pointers, cutting
 * peak memory on large GTFS feeds (IDFM Paris: ~900 MB → ~160 MB for the
 * stopTimes layer). Read-only `indexOf` lookups support the fallback path
 * that needs to resolve a tripId without inserting it.
 */
export interface TripStringTable {
  /** Look up the numeric index for a previously-interned string. Returns -1 if not found. */
  indexOf(s: string): number;
  /** Intern a string, allocating a new index if not seen before. Returns the index. */
  intern(s: string): number;
  /** Retrieve the original string for a given index. Throws RangeError on out-of-range. */
  stringAt(idx: number): string;
  /** Total number of distinct strings in the table. */
  readonly size: number;
}

/**
 * Compact columnar stop-time storage.
 * Both arrays are the same length. Index i represents one stop-time entry:
 *   - tripIdIdx[i]: index into a TripStringTable
 *   - departureSecs[i]: seconds since midnight (may be >= 86400 for overnight)
 * Entries are sorted ascending by departureSecs.
 */
export interface CompactStopTimes {
  tripIdIdx: Uint32Array;
  departureSecs: Uint32Array;
}

/**
 * Build a TripStringTable pre-seeded with the provided strings.
 * Duplicates are collapsed to a single entry; first occurrence wins.
 */
export function buildTripStringTable(ids: Iterable<string>): TripStringTable {
  const map = new Map<string, number>();
  const arr: string[] = [];

  function intern(s: string): number {
    let idx = map.get(s);
    if (idx === undefined) {
      idx = arr.length;
      arr.push(s);
      map.set(s, idx);
    }
    return idx;
  }

  for (const id of ids) {
    intern(id);
  }

  return {
    indexOf(s: string): number {
      return map.get(s) ?? -1;
    },
    intern,
    stringAt(idx: number): string {
      if (idx < 0 || idx >= arr.length) {
        throw new RangeError(
          `TripStringTable: index ${idx} out of range (size=${arr.length})`,
        );
      }
      return arr[idx]!;
    },
    get size(): number {
      return arr.length;
    },
  };
}

/**
 * Cap-enforcing variant of buildTripStringTable. Throws on overflow; warns
 * once at 80% of cap. Pre-seeded strings are counted against the cap.
 */
export function buildCappedTripStringTable(ids: Iterable<string>, cap: number): TripStringTable {
  if (cap <= 0) throw new Error(`buildCappedTripStringTable: cap must be positive, got ${cap}`);
  const map = new Map<string, number>();
  const arr: string[] = [];
  let warned = false;

  function maybeWarn(): void {
    if (!warned && arr.length >= Math.floor(cap * 0.8)) {
      console.warn(
        `[GTFS] trips intern size ${arr.length} is ≥ 80% of cap ${cap} — consider raising PT_CAP_TRIPS`,
      );
      warned = true;
    }
  }

  function intern(s: string): number {
    const existing = map.get(s);
    if (existing !== undefined) return existing;
    if (arr.length >= cap) {
      throw new Error(
        `GTFS feed rejected — trips intern size would exceed cap ${cap}. Increase PT_CAP_TRIPS if this feed is legitimately larger.`,
      );
    }
    const idx = arr.length;
    arr.push(s);
    map.set(s, idx);
    maybeWarn();
    return idx;
  }

  for (const id of ids) intern(id);

  return {
    indexOf(s: string): number {
      return map.get(s) ?? -1;
    },
    intern,
    stringAt(idx: number): string {
      if (idx < 0 || idx >= arr.length) {
        throw new RangeError(`TripStringTable: index ${idx} out of range (size=${arr.length})`);
      }
      return arr[idx]!;
    },
    get size(): number {
      return arr.length;
    },
  };
}

// ── Per-parser row-count caps ───────────────────────────────────────────────

/**
 * Per-parser row-count caps. The parser default exports remain uncapped for
 * use in unit tests and fixture tooling; production ingest (loader.ts) goes
 * through withCaps(readCaps()) so every parser rejects overgrown inputs.
 */
export interface ParserCaps {
  stops: number;
  routes: number;
  trips: number;
  services: number;
  calendarDates: number;
}

interface CapOptions {
  label: string;
  cap: number;
}

function checkRowCap<T>(rows: T[], opts: CapOptions): T[] {
  if (rows.length > opts.cap) {
    throw new Error(
      `GTFS feed rejected — ${opts.label} row count ${rows.length} exceeds cap ${opts.cap}. ` +
      `Increase PT_CAP_${opts.label.toUpperCase()} if this feed is legitimately larger.`,
    );
  }
  if (rows.length >= Math.floor(opts.cap * 0.8)) {
    console.warn(
      `[GTFS] ${opts.label} row count ${rows.length} is ≥ 80% of cap ${opts.cap} — consider raising PT_CAP_${opts.label.toUpperCase()}`,
    );
  }
  return rows;
}

export function withCaps(caps: ParserCaps) {
  return {
    parseStops: async (data: Uint8Array) =>
      checkRowCap(await parseStops(data), { label: "stops", cap: caps.stops }),
    parseRoutes: async (data: Uint8Array) =>
      checkRowCap(await parseRoutes(data), { label: "routes", cap: caps.routes }),
    parseTrips: async (data: Uint8Array) =>
      checkRowCap(await parseTrips(data), { label: "trips", cap: caps.trips }),
    parseCalendar: async (data: Uint8Array) =>
      checkRowCap(await parseCalendar(data), { label: "services", cap: caps.services }),
    parseCalendarDates: async (data: Uint8Array) =>
      checkRowCap(await parseCalendarDates(data), { label: "calendarDates", cap: caps.calendarDates }),
  };
}
