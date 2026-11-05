/**
 * PTB binary reader (format versions 1 and 2).
 *
 * Version 2 (GTFS temporal/transfer foundation,
 * the gtfs temporal transfer foundation notes)
 * adds the mandatory `0x18 ServiceDayOrigins`, `0x19 BlockDerivationCommitment`
 * and `0x1A CompatibilityArtifactCommitment` regions, the featureFlags bit2
 * `DERIVE_BLOCK_INSEAT`, and lets linked transfer rows (types 4/5) omit their
 * stops. Version 1 keeps its frozen legacy interpretation.
 *
 * Mirrors the Rust reader (`crates/pt-core/src/header.rs` + `reader.rs`) and the
 * bytes written by `crates/pt-producer` (`src/current_emit.rs`):
 *
 *   header [0..32]   magic `PTB\0`, version u16 @4 (= 1), featureFlags u16 @6,
 *                    numStops/numRoutes/numTrips u32 @8/@12/@16,
 *                    feedStartDate u32 @20 (YYYYMMDD), numServices u32 @24,
 *                    cityTzOffsetSeconds i32 @28
 *   region table     24 B entries from byte 32 (regionId u16, entryFlags u16,
 *                    reserved u32, offset u64, length u64); regionId 0
 *                    terminates, within the 4096 B header prefix
 *
 * Registry regions (docs/ptb-region-ids.md §4): `0x40 StopsSoA`, `0x41
 * RoutesSoA`, `0x15 ServiceBitfieldPool` + `0x16 ServiceToBitfield` (all
 * mandatory), the pattern band `0x10`–`0x14` / `0x45` / `0x46`, and the optional
 * `0x01 WindowMeta`, `0x17 Frequencies`, `0x44 StopIndex`. Carry regions
 * (`0xF2+`, not in the registry): `0xF2 TripsIntern` (24 B/row), `0xF7
 * StringPool`, `0xF8 Transfers` (32 B/row) ride every bundle; `0xF4 StopTimes`
 * (SoA columns), `0xF5 TripStarts`, `0xF6 Csr`, and `0xFA StopTimeBoarding` ride
 * only the producer's staging bundle — the published bundle strips them and the
 * band is its only timetable, which this reader re-materializes.
 *
 * ALIGNMENT (writer/reader coupling — record it here so it's not lost): the
 * u32 array regions (CSR offsets/values, TripStarts) MUST start on a 4-byte
 * boundary. This loader reads them element-wise (`buf.readUInt32LE`) and so
 * tolerates any offset, but the Rust reader (`crates/pt-core`) takes a zero-copy
 * `bytemuck::try_cast_slice::<u8, u32>` view, which REJECTS a misaligned start.
 * The writer page-aligns these regions (alignment 4096), so this holds in
 * practice; a future writer change that breaks 4-byte alignment would pass here
 * but fail the Rust reader — keep both ends 4-byte-aligned.
 *
 * GTFS reference: https://gtfs.org/documentation/schedule/reference/
 */

import { decodeE7 } from "./coordQuant.js";
// B1.5: the single shared band → flat {stopTimes, tripStarts, boarding} decoder, used here to
// materialize the flat representation when the 0xF4/0xF5/0xFA carry is stripped but the pattern
// band is present. `bandToFlatStopTimes` imports only TYPES from this module (erased at runtime),
// so there is no runtime import cycle.
import { bandToFlatStopTimes } from "./bandToFlatStopTimes.js";
// B1.5: the single 0x13-slab byte-span formula, shared with bandToFlatStopTimes.
// Lives in a leaf module (no imports) so both consumers pull it one-direction —
// no runtime import cycle (see patternBandLayout.ts).
import {
  deltaBytesForFlags,
  patternTripTimesSpan,
  TRIP_TIMES_FLAG_I32_DELTAS,
} from "./patternBandLayout.js";

/** The carry regions addressed by name (see {@link CARRY_REGIONS}). */
const REGION_NAMES = [
  "tripsIntern",
  "stopTimes",
  "tripStarts",
  "csr",
  "stringPool",
  "transfers",
] as const;
export type RegionName = (typeof REGION_NAMES)[number];

const REGION_TABLE_OFFSET = 32;
/** Tagged region-table entry size. Mirrors crates/pt-core/src/header.rs. */
const REGION_ENTRY_BYTES = 24;
const PTB_HEADER_BYTES = 4096;
/** PTB v1 (`pt_core::PTB_VERSION_V1`), still read; the producer publishes v2. */
export const PTB_VERSION = 1;
/** PTB v2 (`pt_core::PTB_VERSION_V2`). */
export const PTB_VERSION_V2 = 2;
/** featureFlags bit2, v2 only (`pt_core::FEATURE_DERIVE_BLOCK_INSEAT`). */
export const FEATURE_DERIVE_BLOCK_INSEAT = 1 << 2;
/** Every featureFlags bit a v2 reader understands (`pt_core::FEATURE_FLAGS_KNOWN_V2`). */
const FEATURE_FLAGS_KNOWN_V2 = 0b111;

// ── PTB v2 regions (docs/ptb-region-ids.md) ─────────────────────────────────
// 0x18 ServiceDayOrigins: (effectiveWindowDays + 1) × i64 LE Unix seconds of
// local noon minus 12 h for feedStartDate + i, strictly increasing.
// 0x19 BlockDerivationCommitment (48 B): algorithm u16 @0, reserved [2..8),
// pair_date_count u64 @8, sha256 @16.
// 0x1A CompatibilityArtifactCommitment (88 B): algorithm u16 @0, reserved
// [2..8), v1 identity size u64 @8, v1 gzip size u64 @16, identity sha256 @24,
// gzip sha256 @56. All three are mandatory and 8-byte aligned in v2.
const SERVICE_DAY_ORIGINS_REGION_ID = 0x18;
const BLOCK_DERIVATION_COMMITMENT_REGION_ID = 0x19;
const COMPATIBILITY_ARTIFACT_COMMITMENT_REGION_ID = 0x1a;
const BLOCK_DERIVATION_COMMITMENT_BYTES = 48;
const COMPATIBILITY_ARTIFACT_COMMITMENT_BYTES = 88;
const COMMITMENT_ALGORITHM_V1 = 1;
/** SHA-256 of the empty byte sequence: the `0x19` hash of a disabled derivation. */
const SHA256_EMPTY_HEX = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Carry regionId → RegionName. Mirrors `header::CARRY_REGIONS` (Rust): the
 * record-format regions kept outside the frozen registry, under the `0xF2+`
 * band. `0xF4`/`0xF5`/`0xF6` ride the staging bundle only (stripped on publish). */
const CARRY_REGIONS: ReadonlyArray<readonly [number, RegionName]> = [
  [0xf2, "tripsIntern"],
  [0xf4, "stopTimes"],
  [0xf5, "tripStarts"],
  [0xf6, "csr"],
  [0xf7, "stringPool"],
  [0xf8, "transfers"],
] as const;
/** Persisted StopIndex region id — mirrors `stop_index::REGION_ID` (0x44). */
const STOP_INDEX_REGION_ID = 0x44;
/** StopIndex table entry stride: (fnv32 u32, stringpool_idx u32, ordinal u32). */
const STOP_INDEX_ENTRY_BYTES = 12;

// ── SoA region IDs (FROZEN registry §4 — docs/ptb-region-ids.md) ─────────────
// Mandatory typed-column regions for stops/routes (parents live in the dense
// `parent_idx` column).
const STOPS_SOA_REGION_ID = 0x40;
const ROUTES_SOA_REGION_ID = 0x41;

// ── Staging carry: StopTimeBoarding (optional) ───────────────────────────────
// `StopTimeBoarding` (0xFA): one packed byte per stop_time (N = num_stop_times),
// LSB-first [1:0]=pickup_type, [3:2]=drop_off_type, [5:4]=continuous_pickup,
// [7:6]=continuous_drop_off; default 0x50. Rides the 0xF2–0xF8 carry band
// alongside StopTimes 0xF4 on the staging bundle; absent ⇒ default 0x50.
// Mirrors `region_ids::STOP_TIME_BOARDING` (Rust). GTFS reference:
// https://gtfs.org/documentation/schedule/reference/#stop_timestxt (pickup_type /
// drop_off_type / continuous_pickup / continuous_drop_off).
const STOP_TIME_BOARDING_REGION_ID = 0xfa;

// ── 0x17 Frequencies region ────────────────────────
// Optional. When present: `count u32 LE` prefix + `count × 16` row bytes,
// sorted by `(tripIdx, startSecs)`. Each 16 B row:
//   [0..4]   tripIdx     u32 LE
//   [4..8]   startSecs   u32 LE
//   [8..12]  endSecs     u32 LE  (half-open EXCLUDED bound per GTFS spec)
//   [12..14] headwaySecs u16 LE
//   [14]     exactTimes  u8  (0 = frequency-based, 1 = schedule-based)
//   [15]     reserved    u8
// Absent when the feed has no frequencies.txt or all rows were omitted.
// Mirrors `region_ids::FREQUENCIES` + `FrequencyRecord` (Rust).
// GTFS reference: https://gtfs.org/documentation/schedule/reference/#frequenciestxt
export const FREQUENCIES_REGION_ID = 0x17;

// ── Pattern-major band region IDs (B1 — FROZEN registry §4) ───────────────────
// The frozen-registry homes for the pattern-major timetable (docs/ptb-region-ids.md §4). Mirror pt-core's `region_ids`
// consts. The pattern band:
//   0x10 Patterns · 0x11 PatternStops · 0x12 PatternSemantics ·
//   0x13 TripTimes · 0x14 TripMeta · 0x45 PatternsAtStop · 0x46 PatternTrips.
const PATTERNS_REGION_ID = 0x10;
const PATTERN_STOPS_REGION_ID = 0x11;
const PATTERN_SEMANTICS_REGION_ID = 0x12;
const TRIP_TIMES_REGION_ID = 0x13;
const TRIP_META_REGION_ID = 0x14;
const PATTERNS_AT_STOP_REGION_ID = 0x45;
const PATTERN_TRIPS_REGION_ID = 0x46;

/** `0x10 Patterns.flags` bit0 — the pattern is all-regular ⇒ it contributes NO
 *  `0x12 PatternSemantics` bytes (omit-when-all-regular). Mirrors Rust
 *  `reader::PATTERN_FLAG_ALL_REGULAR` / `pattern_emit::FLAG_ALL_REGULAR` and the
 *  copy in `bandToFlatStopTimes.ts`. */
const PATTERN_FLAG_ALL_REGULAR = 0b0000_0001;

// ── 0x01 WindowMeta (optional) ───────────────────────────────────────────────
// Carries the service-bitmask window length in days as a little-endian u16 at
// byte 0 (a trailing reserved tail is permitted and ignored). Absent ⇒ the
// SERVICE_WINDOW_DAYS default (90). Drives the per-service bitmask stride
// `ceil(windowDays/8)`. Mirrors the Rust reader's
// `window_days` decode: a present-but-<2 B region is a hard error (a malformed
// region must not masquerade as absent), and a decoded value above the hard
// ceiling (400) is a hard error.
const WINDOW_META_REGION_ID = 0x01;
/** Inclusive upper bound on a decoded `windowDays`; mirrors the Rust hard error. */
const WINDOW_HARD_CEILING = 400;

// ── Service-bitfield storage (B2) ─────────────────────────────────────────────
// A deduped pool of distinct day-vectors (`0x15 ServiceBitfieldPool`: `count
// u32` LE prefix then `count × ceil(windowDays/8)` distinct bitfields) plus a
// per-service index into that pool (`0x16 ServiceToBitfield`: `numServices ×
// u32` LE pool indices). BOTH are mandatory (a hard error if either is absent —
// C3); the loader materializes a flat `numServices × S` `serviceBitmasks` view
// from `pool[idx[s]*S .. +S]` for downstream readers. Mirrors the Rust reader
// (crates/pt-core/src/reader.rs) gates + `region_ids` (FROZEN registry §4 —
// docs/ptb-region-ids.md).
const SERVICE_BITFIELD_POOL_REGION_ID = 0x15;
const SERVICE_TO_BITFIELD_REGION_ID = 0x16;

/**
 * lowerCamel region name for a registry region id, or `"unknown"`. A subset of
 * the Rust `region_ids::region_name_by_id` (the ids this reader names in its
 * error messages).
 */
export function regionNameById(id: number): string {
  switch (id) {
    case STOPS_SOA_REGION_ID:
      return "stopsSoA";
    case ROUTES_SOA_REGION_ID:
      return "routesSoA";
    case STOP_INDEX_REGION_ID:
      return "stopIndex";
    case SERVICE_BITFIELD_POOL_REGION_ID:
      return "serviceBitfieldPool";
    case SERVICE_TO_BITFIELD_REGION_ID:
      return "serviceToBitfield";
    default:
      return "unknown";
  }
}

const TRIP_RECORD_BYTES = 24;
const STOP_TIME_ROW_BYTES = 12;
const TRANSFER_RECORD_BYTES = 32;

/** Sentinel for an absent optional index / min-transfer-time in a Transfers record. */
const TRANSFER_ABSENT = 0xffffffff;

export const SERVICE_WINDOW_DAYS = 90;
export const SERVICE_BITMASK_BYTES_PER_SERVICE = Math.ceil(SERVICE_WINDOW_DAYS / 8);

/**
 * Per-service bitmask stride in bytes for a given service-window length =
 * `ceil(windowDays / 8)`. Mirrors the Rust `pt_core::bytes_per_service`; the
 * default-90 result is `SERVICE_BITMASK_BYTES_PER_SERVICE` (= 12). Used by the
 * reader's runtime stride and by the tiny-PTB writer's window parameterization.
 */
export function bytesPerService(windowDays: number): number {
  return Math.ceil(windowDays / 8);
}

/**
 * Window-provenance pair decoded from a PTB header: the runtime service-bitmask
 * window length and the feed's day-0 anchor. See {@link readWindowProvenance}.
 */
export interface PtbWindowProvenance {
  /**
   * Runtime service-bitmask window length (days). Matches `loadPtb(...).windowDays`
   * for a well-formed bundle: the `0x01 WindowMeta` u16, or {@link SERVICE_WINDOW_DAYS}
   * (90) when the region is absent.
   */
  windowDays: number;
  /** Day-0 of the service-bitmask window (YYYYMMDD integer @ header [20..24]). */
  feedStartDate: number;
}

/**
 * Cheap, TOTAL header-only decode of `windowDays` + `feedStartDate` from raw PTB
 * bytes — for the on-device `db.ptbBytes` provenance fields, where a full
 * {@link loadPtb} parse (every stop/route/trip/stop_time) is wasteful. This
 * reads ONLY the fixed header and the tagged region table via `DataView`, so
 * it runs in any JS realm without allocating the full decoded bundle.
 *
 * It mirrors {@link loadPtb}'s WindowMeta decode (LE u16 `windowDays`, default 90
 * when the `0x01` region is absent), but is NON-THROWING: any
 * malformed / too-short / unsupported buffer yields the defaults
 * `{ windowDays: SERVICE_WINDOW_DAYS, feedStartDate: 0 }` so a provenance read can
 * never break the byte-persist path. A present-but-malformed (`< 2 B`) or
 * over-ceiling WindowMeta region also degrades to the default rather than
 * throwing — the authoritative validation still lives in {@link loadPtb} / the
 * Rust reader; this is observability only.
 */
export function readWindowProvenance(bytes: Uint8Array): PtbWindowProvenance {
  const fallback: PtbWindowProvenance = {
    windowDays: SERVICE_WINDOW_DAYS,
    feedStartDate: 0,
  };
  try {
    if (bytes.length < PTB_HEADER_BYTES) return fallback;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Magic: 0x50 0x54 0x42 0x00 ("PTB" + NUL).
    if (bytes[0] !== 0x50 || bytes[1] !== 0x54 || bytes[2] !== 0x42 || bytes[3] !== 0x00) {
      return fallback;
    }
    const version = dv.getUint16(4, true);
    if (version !== PTB_VERSION && version !== PTB_VERSION_V2) return fallback;
    const feedStartDate = dv.getUint32(20, true);

    let windowDays = SERVICE_WINDOW_DAYS;
    for (let i = 0; ; i++) {
      const e = REGION_TABLE_OFFSET + i * REGION_ENTRY_BYTES;
      if (e + REGION_ENTRY_BYTES > bytes.length) break;
      const regionId = dv.getUint16(e, true);
      if (regionId === 0) break; // table terminator
      if (regionId === WINDOW_META_REGION_ID) {
        const offset = Number(dv.getBigUint64(e + 8, true));
        const length = Number(dv.getBigUint64(e + 16, true));
        if (length >= 2 && offset + 2 <= bytes.length) {
          const w = dv.getUint16(offset, true);
          if (w <= WINDOW_HARD_CEILING) windowDays = w;
        }
        break;
      }
    }
    return { windowDays, feedStartDate };
  } catch {
    return fallback;
  }
}

export interface PtbRegion {
  offset: number;
  length: number;
}

/**
 * A tagged-table region entry that also carries the 16-bit `entryFlags`
 * field (`u16 @ entry+2`). Only the pattern
 * band's `0x13 TripTimes` consumes a flag bit (the dense/ragged/i32 selector —
 * see {@link PtbPatternBand.tripTimesEntryFlags}); other entries default it to
 * `0`. Mirrors the Rust `RegionEntry.entry_flags`.
 */
export interface PtbBandRegion extends PtbRegion {
  entryFlags: number;
}

/**
 * The seven pattern-band region entries resolved from the tagged region table
 * (each `undefined` when its regionId is absent). `0x12 PatternSemantics` is
 * absent on an all-regular feed; the band is "present" iff `patterns` (`0x10`)
 * resolves, and {@link decodePatternBand} then requires the other five
 * companions. Mirrors the `header.region_by_id(...)` lookups at the top of the
 * Rust `resolve_pattern_band`.
 */
export interface PtbBandRegions {
  /** `0x10 Patterns` — presence is the band-present signal. */
  patterns?: PtbBandRegion;
  /** `0x11 PatternStops`. */
  patternStops?: PtbBandRegion;
  /** `0x12 PatternSemantics` — omit-when-all-regular (optional even when present). */
  patternSemantics?: PtbBandRegion;
  /** `0x13 TripTimes` — its `entryFlags` is the dense/ragged/i32 selector. */
  tripTimes?: PtbBandRegion;
  /** `0x14 TripMeta`. */
  tripMeta?: PtbBandRegion;
  /** `0x45 PatternsAtStop` CSR. */
  patternsAtStop?: PtbBandRegion;
  /** `0x46 PatternTrips` CSR. */
  patternTrips?: PtbBandRegion;
}

export interface PtbHeader {
  magic: string;
  version: number;
  /** Day-0 of the 90-day service-bitmask window (YYYYMMDD integer). */
  feedStartDate: number;
  /**
   * UTC offset (seconds) at feedStartDate's midnight UTC (i32 LE @ [28..32]).
   * This is a STATIC anchor-date snapshot, NOT a DST-correct
   * runtime offset — for a DST city (e.g. Europe/Vilnius) it is only valid for
   * the half of the year matching feedStartDate's DST state. It exists for
   * pt-serve's load-time sanity cross-check against chrono-tz; do NOT use it for
   * wall-clock math (runtime tz arithmetic must be chrono-tz/IANA-driven).
   */
  cityTzOffsetSeconds: number;
  /**
   * Feature flags (header `[6..8]`): bit0 hasFlex, bit1 hasFares. Mirrors
   * `Header::feature_flags`.
   */
  featureFlags: number;
  /**
   * Service-bitmask window length in days, decoded from the optional `0x01`
   * WindowMeta region (LE u16 at byte 0). Default `90` when the region is
   * absent. Drives the per-service bitmask stride
   * `ceil(windowDays/8)`. Mirrors the Rust reader's `window_days` (default 90,
   * hard-errors on a present-but-<2 B region and on a decoded value > 400).
   */
  windowDays: number;
  regions: Record<RegionName, PtbRegion>;
}

/** Decoded `0x19 BlockDerivationCommitment`. */
export interface PtbBlockDerivationCommitment {
  algorithmVersion: number;
  /** `(source_trip, service_date_ordinal, target_trip)` tuple count; safe integer. */
  pairDateCount: number;
  /** Lower-case hex SHA-256 of the canonical tuple stream. */
  tuplesSha256: string;
}

/** Decoded `0x1A CompatibilityArtifactCommitment`. */
export interface PtbCompatibilityArtifactCommitment {
  algorithmVersion: number;
  v1IdentitySize: number;
  v1GzipSize: number;
  v1IdentitySha256: string;
  v1GzipSha256: string;
}

/** PTB v2-only data. Absent on a v1 bundle. */
export interface PtbV2 {
  /**
   * `0x18 ServiceDayOrigins`: entry `i` is the Unix second of local noon minus
   * 12 h on `feedStartDate + i` (`windowDays + 1` entries). The only v2
   * authority for converting between service-day seconds and instants.
   */
  serviceDayOrigins: number[];
  /** featureFlags bit2: trips sharing a block continue in-seat when derivable. */
  deriveBlockInseat: boolean;
  blockDerivationCommitment: PtbBlockDerivationCommitment;
  compatibilityArtifactCommitment: PtbCompatibilityArtifactCommitment;
  /**
   * Trips whose `frequencies.txt` rows were malformed or overlapping. They are
   * never routed (not even as their scheduled template); their marker rows are
   * left out of `frequencies`.
   */
  quarantinedFrequencyTrips: number[];
}

export interface PtbStopParentEntry {
  /** Post-finalize stop index. */
  childIdx: number;
  /** Post-finalize stop index. */
  parentIdx: number;
}

export interface PtbStop {
  stopId: string;
  stopName: string;
  /**
   * Decoded latitude in degrees (f64): `latE7 / 1e7` (computed lazily from the
   * canonical i32 column — see `decodeStopsSoA`).
   */
  stopLat: number;
  /** Decoded longitude in degrees (f64). See `stopLat`. */
  stopLon: number;
  /** Canonical latitude as `i32` deg×1e7 (the `lat_e7` column). */
  latE7: number;
  /** Canonical longitude as `i32` deg×1e7 (the `lon_e7` column). */
  lonE7: number;
  wheelchairBoarding: number;
}

export interface PtbRoute {
  routeId: string;
  agencyId: string;
  routeShortName: string;
  routeLongName: string;
  routeType: number;
  routeColor: string;
  routeTextColor: string;
}

export interface PtbTrip {
  tripId: string;
  headsign: string;
  routeIdx: number;
  serviceIdx: number;
  wheelchairAccessible: number;
  bikesAllowed: number;
  /**
   * GTFS direction_id — `0` (outbound), `1` (inbound), or `255` (`0xFF`).
   * `255` is the "absent/none" sentinel written by the Rust producer when the
   * source feed omits or blanks the column. `loadFromPtb.ts` maps `255` to
   * `undefined` on `GtfsTrip.directionId`, matching `parser.ts`'s tri-state.
   */
  directionId: number;
  /** GTFS shape_id — empty string if absent in source feed. */
  shapeId: string;
}

/**
 * Stop-time row decoded from the 12 B PTB encoding.
 *
 * - depSecs: u32 — `0xFFFFFFFF` indicates a missing departure_time.
 * - arrDiff: i16 — `arrival_secs - depSecs`. The producer writes 0 when arrival
 *   equals departure OR when either field is missing; consumers reconstruct
 *   `arrSecs = depSecs + arrDiff` only when both fields are present.
 * - stopIdx: u32 — post-finalize stops interner index (matches `stops[i]`).
 * - stopSeq: u16 — clamped to `0xFFFF` if the source value overflows.
 */
export interface PtbStopTime {
  depSecs: number;
  arrDiff: number;
  stopIdx: number;
  stopSeq: number;
}

/**
 * One GTFS `transfers.txt` rule decoded from the 32 B `0xF8 Transfers` record.
 *
 * Indices are positions in `stops[]` / `routes[]` / `trips[]`. The optional
 * route/trip scope and `minTransferSecs` are `undefined` when the source feed
 * omits them (the on-disk `0xFFFFFFFF` sentinel). `transferType` is the GTFS
 * `transfer_type` (0–5; blank → 0 at parse time). The stops are always present
 * on a v1 bundle; a v2 bundle may omit them on linked rows (types 4/5), which
 * GTFS lets key on trips alone.
 *
 * Carried only in S0 — no scan/relaxation code reads it.
 * GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
 */
export interface PtbTransfer {
  fromStopIdx?: number;
  toStopIdx?: number;
  fromRouteIdx?: number;
  toRouteIdx?: number;
  fromTripIdx?: number;
  toTripIdx?: number;
  minTransferSecs?: number;
  transferType: number;
}

/**
 * One decoded `0x17 Frequencies` row. Mirrors `FrequencyRecord` (Rust).
 * `endSecs` is the half-open EXCLUDED upper bound per the GTFS spec — the last
 * departure is the largest `startSecs + n * headwaySecs < endSecs`.
 * GTFS reference: https://gtfs.org/documentation/schedule/reference/#frequenciestxt
 */
export interface PtbFrequencyRow {
  tripIdx: number;
  startSecs: number;
  /** Half-open end (EXCLUDED), carried verbatim — do NOT add/subtract 1. */
  endSecs: number;
  headwaySecs: number;
  /** `0` = frequency-based (inexact), `1` = schedule-based (exact). */
  exactTimes: number;
}

/**
 * One decoded `0x10 Patterns` record: a contiguous slice of the `0x11`
 * PatternStops column (ELEMENT-indexed) plus the per-pattern flag byte.
 */
export interface PtbPatternRecord {
  /** ELEMENT index into {@link PtbPatternBand.patternStops} (NOT a byte offset). */
  stopsOff: number;
  /** Number of pattern-positions (length of this pattern's `0x11` slice). */
  stopCount: number;
  /**
   * `0x10` flags byte: bit0 all-regular (⇒ this pattern's `0x12` bytes omitted),
   * bit1 has stop_headsign (0 in B1.x), bit2 has seq-override (0 in B1.x).
   */
  flags: number;
}

/**
 * The decoded pattern band (`0x10`-`0x14` + `0x45`/`0x46`), mirroring the
 * Rust `PatternBand` resolved by `resolve_pattern_band`
 * (`crates/pt-core/src/reader.rs`). Locked layout:
 *
 * **Consumed by `loadPtb`'s carry-less materialization (B1.5).**
 * {@link decodePatternBand} decodes + fully validates the band; {@link loadPtb}
 * then either ignores it (when the flat `0xF4/0xF5/0xF6` carry is present — the
 * carry drives the engine and the engine-regression stays byte-identical) OR
 * re-materializes `stopTimes`/`tripStarts`/`boarding` FROM it via
 * {@link bandToFlatStopTimes} when the carry is absent/empty (the B1.5 carry-less
 * path). So it is dormant only while the flat carry is still present.
 */
export interface PtbPatternBand {
  /** `0x10.count` — number of patterns (== `0x46` CSR offsets length − 1). */
  numPatterns: number;
  /** `0x10` records, in enumeration order (first-appearance over route_trips). */
  patterns: PtbPatternRecord[];
  /** `0x11 PatternStops` — flat `stop_idx u32` column, repeats preserved. */
  patternStops: Uint32Array;
  /**
   * `0x12 PatternSemantics` — 1 packed byte per pattern-position for the
   * non-all-regular patterns only. `undefined` when the region is OMITTED (every
   * pattern all-regular — the B1.1-over-regular-feeds case).
   */
  patternSemantics?: Uint8Array;
  /**
   * `0x13 TripTimes` region (carried as `{ offset, length }`, not pre-decoded into
   * rows). {@link bandToFlatStopTimes} reads the slab bytes from here on the
   * carry-less materialization path.
   */
  tripTimes: PtbRegion;
  /** `0x14 TripMeta` region (carried — `numTrips × 24 B`). */
  tripMeta: PtbRegion;
  /** `0x45 PatternsAtStop` CSR offsets (`numStops + 1` u32). */
  patternsAtStopOffsets: Uint32Array;
  /** `0x45 PatternsAtStop` CSR values (pattern ordinals serving each stop). */
  patternsAtStopValues: Uint32Array;
  /** `0x46 PatternTrips` CSR offsets (`numPatterns + 1` u32). */
  patternTripsOffsets: Uint32Array;
  /** `0x46 PatternTrips` CSR values (trip ordinals per pattern, contiguous). */
  patternTripsValues: Uint32Array;
  /**
   * `0x13 TripTimes`'s `entryFlags` (`u16` @ table-entry +2). `0` = the i16
   * default; bit1 (i32-deltas) is also supported — it sets the region-level
   * dep/dwell delta width to 4 B (the materializer resolves it via
   * {@link deltaBytesForFlags}). bit0 (ragged) is the deferred intercity/Paris
   * on-ramp, which {@link decodePatternBand} fails closed on. Mirrors the Rust
   * `Reader::trip_times_entry_flags`.
   */
  tripTimesEntryFlags: number;
}

export interface PtbBundle extends PtbHeader {
  stops: PtbStop[];
  routes: PtbRoute[];
  trips: PtbTrip[];
  stopTimes: PtbStopTime[];
  /**
   * TripStarts: `trips.length + 1` u32 prefix-sum offsets into
   * `stopTimes`, in sorted-trip order. `tripStarts[i]..tripStarts[i+1]` is
   * exactly trip `i`'s contiguous stop_times row range. Monotonic;
   * `tripStarts[0] === 0` and `tripStarts[trips.length] === stopTimes.length`.
   */
  tripStarts: Uint32Array;
  routeTripsOffsets: Uint32Array;
  routeTripsValues: Uint32Array;
  stopRoutesOffsets: Uint32Array;
  stopRoutesValues: Uint32Array;
  /**
   * Flat `numServices × bytesPerService(windowDays)` service bitmasks,
   * materialized from the `0x15`/`0x16` pool. `numServices` is read
   * authoritatively from header bytes [24..28].
   */
  serviceBitmasks: Uint8Array;
  /** Authoritative count of service bitmasks, read from header bytes [24..28]. */
  numServices: number;
  /**
   * GTFS `transfers.txt` rules (`0xF8 Transfers` region). Empty when the feed
   * carries no `transfers.txt`.
   * GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
   */
  transfers: PtbTransfer[];
  /** PTB v2 data; `undefined` on a v1 bundle. */
  v2?: PtbV2;
  /**
   * The dense `parent_idx` column decoded into `(childIdx, parentIdx)` pairs,
   * sorted by `childIdx`. Empty array when the feed has no parent_station
   * column. `loadFromPtb.ts` uses this to resolve `parentStation` strings on
   * `GtfsStop`.
   */
  stopParents: PtbStopParentEntry[];
  /**
   * Deduped StringPool entries (index 0 is `""`). Exposed so the persisted
   * StopIndex (`stopIndexRegion`) can resolve a candidate's `stringpool_idx`
   * back to its id string for the full-string tiebreak. Consumers that only need decoded records can ignore it.
   */
  stringPool: string[];
  /**
   * Persisted StopIndex region (`0x44`), or `undefined` for a bundle that omits
   * it. Decode with `lookupStopIndexRegion(buf, region,
   * stringPool, id)`. Mirrors the Rust reader's persisted-StopIndex path.
   */
  stopIndexRegion?: PtbRegion;
  /** `StopsSoA` region (`0x40`). */
  stopsSoaRegion: PtbRegion;
  /** `RoutesSoA` region (`0x41`). */
  routesSoaRegion: PtbRegion;
  /**
   * Per-stop_time packed boarding bytes, indexed by the global stop_time row
   * (same index space as `stopTimes[i]`): the staging `0xFA StopTimeBoarding`
   * region, or re-materialized from the band's `0x12 PatternSemantics` on a
   * carry-less bundle. `undefined` when every stop_time is the default `0x50`. Each byte (LSB-first):
   * `[1:0]`=pickup_type, `[3:2]`=drop_off_type, `[5:4]`=continuous_pickup,
   * `[7:6]`=continuous_drop_off. Carried only here — no consumer/engine reads it
   * yet. GTFS reference:
   * https://gtfs.org/documentation/schedule/reference/#stop_timestxt
   */
  boarding?: Uint8Array;
  /**
   * Decoded `0x17 Frequencies` rows, or `undefined` when the region is absent
   * (feeds with no frequencies.txt). When present, sorted by
   * `(tripIdx, startSecs)` as stored. Carry-only — no scan/engine reads it yet.
   * GTFS reference: https://gtfs.org/documentation/schedule/reference/#frequenciestxt
   */
  frequencies?: PtbFrequencyRow[];
  /**
   * Decoded pattern band (`0x10`-`0x14` / `0x45`/`0x46`), or `undefined` when
   * the bundle carries no band (a staging bundle).
   * Decoded + validated by {@link decodePatternBand}; {@link loadPtb} consumes it
   * to re-materialize `stopTimes`/`tripStarts`/`boarding` when the flat carry is
   * absent/empty (B1.5), and ignores it otherwise (the flat carry drives the
   * engine and the engine-regression stays byte-identical). See {@link PtbPatternBand}.
   */
  patternBand?: PtbPatternBand;
  /**
   * `true` when this is a CARRY-LESS bundle (B1.5-T5): the flat
   * `0xF4`/`0xF5`/`0xF6` carry was stripped and `stopTimes`/`tripStarts` (+ the
   * route→trips CSR) were re-materialized FROM the pattern band via
   * {@link bandToFlatStopTimes}. `false` on every carry-BEARING bundle (the band
   * is dormant). Mirrors the Rust reader's `is_carry_less_band()`. Consumers that
   * must take the band-only path (e.g. the engine-regression gate skipping the flat
   * `PatternMode::Off` build, which has no flat carry to build over) key on this.
   */
  carryMaterializedFromBand: boolean;
}

function assertRegionInBounds(name: string, region: PtbRegion, bufLen: number): void {
  if (region.offset + region.length > bufLen) {
    throw new Error(
      `ptb: ${name} region out of bounds — offset=${region.offset} length=${region.length} buf=${bufLen}`,
    );
  }
}

const UTF8_DECODER = new TextDecoder("utf-8");
const UTF8_ENCODER = new TextEncoder();

/**
 * Browser-safe subset of Node Buffer's read API used by this decoder. Named
 * little-endian reads keep the binary layout auditable without shipping a
 * Buffer polyfill in the frontend worker.
 */
class PtbByteReader {
  readonly buffer: ArrayBufferLike;
  readonly byteOffset: number;
  readonly length: number;
  private readonly view: DataView;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.buffer = bytes.buffer;
    this.byteOffset = bytes.byteOffset;
    this.length = bytes.byteLength;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  readUInt8(offset: number): number { return this.view.getUint8(offset); }
  readUInt16LE(offset: number): number { return this.view.getUint16(offset, true); }
  readInt16LE(offset: number): number { return this.view.getInt16(offset, true); }
  readUInt32LE(offset: number): number { return this.view.getUint32(offset, true); }
  readInt32LE(offset: number): number { return this.view.getInt32(offset, true); }
  readBigUInt64LE(offset: number): bigint { return this.view.getBigUint64(offset, true); }
  subarray(start: number, end?: number): Uint8Array { return this.bytes.subarray(start, end); }

  decode(encoding: "utf8" | "latin1", start: number, end: number): string {
    const slice = this.bytes.subarray(start, end);
    if (encoding === "utf8") return UTF8_DECODER.decode(slice);
    let out = "";
    for (const byte of slice) out += String.fromCharCode(byte);
    return out;
  }
}

function sameBytes(a: Uint8Array, b: readonly number[]): boolean {
  return a.length === b.length && b.every((value, index) => a[index] === value);
}

export function loadPtb(bytes: Uint8Array): PtbBundle {
  const buf = new PtbByteReader(bytes);
  if (buf.length < PTB_HEADER_BYTES) {
    throw new Error(`ptb: buffer too small for header — got ${buf.length} bytes, need ≥ ${PTB_HEADER_BYTES}`);
  }

  // On-disk magic is 4 bytes: 0x50 0x54 0x42 0x00 ("PTB" + NUL).
  const PTB_MAGIC = [0x50, 0x54, 0x42, 0x00] as const;
  if (!sameBytes(buf.subarray(0, 4), PTB_MAGIC)) {
    throw new Error(`ptb: bad magic — got ${JSON.stringify(buf.decode("latin1", 0, 4))}`);
  }
  const magic = "PTB";
  const version = buf.readUInt16LE(4);
  if (version !== PTB_VERSION && version !== PTB_VERSION_V2) {
    throw new Error(
      `ptb: unsupported version ${version} — supported versions are ${PTB_VERSION} and ${PTB_VERSION_V2} (rebuild the producer)`,
    );
  }
  const isV2 = version === PTB_VERSION_V2;
  const feedStartDate = buf.readUInt32LE(20);
  // featureFlags @ [6..8]: bit0 hasFlex, bit1 hasFares, bit2 (v2 only)
  // DERIVE_BLOCK_INSEAT. A v2 reader rejects every unknown bit; v1 keeps its
  // historical unchecked interpretation (mirrors header.rs).
  const featureFlags = buf.readUInt16LE(6);
  if (isV2 && (featureFlags & ~FEATURE_FLAGS_KNOWN_V2) !== 0) {
    throw new Error(`ptb: v2 featureFlags 0x${featureFlags.toString(16)} carry unknown bits`);
  }

  const regions = {} as Record<RegionName, PtbRegion>;
  let stopIndexRegion: PtbRegion | undefined;
  let stopsSoaRegion: PtbRegion | undefined;
  let routesSoaRegion: PtbRegion | undefined;
  // Staging StopTimeBoarding carry (0xFA); undefined ⇒ absent ⇒ every stop_time
  // defaults to 0x50 (no decode).
  let stopTimeBoardingRegion: PtbRegion | undefined;
  // Optional 0x17 Frequencies region; undefined ⇒ absent ⇒ no frequency rows.
  let frequenciesRegion: PtbRegion | undefined;
  // Optional WindowMeta (0x01); undefined ⇒ absent ⇒ windowDays defaults to
  // SERVICE_WINDOW_DAYS (90).
  let windowMetaRegion: PtbRegion | undefined;
  // Service-bitfield storage (0x15/0x16). BOTH MUST resolve (C3 hard error below).
  let serviceBitfieldPoolRegion: PtbRegion | undefined;
  let serviceToBitfieldRegion: PtbRegion | undefined;
  // PTB v2 mandatory regions (0x18/0x19/0x1A); ignored on a v1 bundle.
  const v2Regions = new Map<number, PtbRegion>();
  // Pattern-band region entries (0x10-0x14 / 0x45 / 0x46), resolved in the table
  // walk (capturing entryFlags) and handed to decodePatternBand below.
  // Undefined ⇒ absent (a staging bundle). The band's 0x13 TripTimes carries an
  // entryFlags selector (dense/ragged/i32), so these are PtbBandRegion (PtbRegion
  // + entryFlags). 0x12 is omit-when-regular.
  const band: PtbBandRegions = {};
  // 24 B tagged entries addressed by regionId; regionId 0 terminates. Carry ids
  // fold into the RegionName slots (mirrors header.rs CARRY_REGIONS). Pre-fill
  // every RegionName empty so an omitted region decodes as "none".
  for (const name of REGION_NAMES) regions[name] = { offset: 0, length: 0 };
  const carry = new Map<number, RegionName>(CARRY_REGIONS);
  // Mirror the Rust Header::parse table walk (crates/pt-core/src/header.rs):
  // the scan is capped at PTB_HEADER_BYTES (4096), a duplicate regionId is a
  // hard error (`dup_region_id`), and a table with no regionId==0 terminator
  // within the header prefix is `unterminated` — so a table Rust fails closed on
  // can never decode silently-wrong in the browser.
  const seen = new Set<number>();
  for (let i = 0; ; i++) {
    const e = REGION_TABLE_OFFSET + i * REGION_ENTRY_BYTES;
    if (e + REGION_ENTRY_BYTES > PTB_HEADER_BYTES) {
      // A well-formed table hits its regionId==0 terminator before the 4096 B
      // header prefix ends; running off the prefix means it is unterminated.
      throw new Error("ptb: region table unterminated (no regionId==0 within the 4096 B header prefix)");
    }
    const regionId = buf.readUInt16LE(e);
    if (regionId === 0) break; // regionId 0 = table terminator
    if (seen.has(regionId)) {
      throw new Error(`ptb: region table has a duplicate regionId 0x${regionId.toString(16)} (dup_region_id)`);
    }
    seen.add(regionId);
    // entryFlags u16 @ +2 — feature bits per region (Rust captures these into
    // RegionEntry.entry_flags). Only the pattern band consumes one (0x13
    // TripTimes dense/ragged selector), but capturing it uniformly here mirrors
    // header.rs's table walk.
    const entryFlags = buf.readUInt16LE(e + 2);
    const offset = Number(buf.readBigUInt64LE(e + 8));
    const length = Number(buf.readBigUInt64LE(e + 16));
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)) {
      throw new Error(`ptb: region 0x${regionId.toString(16)} offsets exceed Number.MAX_SAFE_INTEGER`);
    }
    const reg = { offset, length };
    assertRegionInBounds(`region 0x${regionId.toString(16)}`, reg, buf.length);
    const bandReg: PtbBandRegion = { offset, length, entryFlags };
    const name = carry.get(regionId);
    if (name) regions[name] = reg;
    else if (regionId === STOP_INDEX_REGION_ID) stopIndexRegion = reg;
    else if (regionId === STOPS_SOA_REGION_ID) stopsSoaRegion = reg;
    else if (regionId === ROUTES_SOA_REGION_ID) routesSoaRegion = reg;
    else if (regionId === STOP_TIME_BOARDING_REGION_ID) stopTimeBoardingRegion = reg;
    else if (regionId === FREQUENCIES_REGION_ID) frequenciesRegion = reg;
    else if (regionId === WINDOW_META_REGION_ID) windowMetaRegion = reg;
    else if (regionId === SERVICE_BITFIELD_POOL_REGION_ID) serviceBitfieldPoolRegion = reg;
    else if (regionId === SERVICE_TO_BITFIELD_REGION_ID) serviceToBitfieldRegion = reg;
    else if (regionId === PATTERNS_REGION_ID) band.patterns = bandReg;
    else if (regionId === PATTERN_STOPS_REGION_ID) band.patternStops = bandReg;
    else if (regionId === PATTERN_SEMANTICS_REGION_ID) band.patternSemantics = bandReg;
    else if (regionId === TRIP_TIMES_REGION_ID) band.tripTimes = bandReg;
    else if (regionId === TRIP_META_REGION_ID) band.tripMeta = bandReg;
    else if (regionId === PATTERNS_AT_STOP_REGION_ID) band.patternsAtStop = bandReg;
    else if (regionId === PATTERN_TRIPS_REGION_ID) band.patternTrips = bandReg;
    else if (
      regionId === SERVICE_DAY_ORIGINS_REGION_ID ||
      regionId === BLOCK_DERIVATION_COMMITMENT_REGION_ID ||
      regionId === COMPATIBILITY_ARTIFACT_COMMITMENT_REGION_ID
    ) v2Regions.set(regionId, reg);
    // Unknown regionIds are ignored (forward-compat: absent ⇒ empty region).
  }

  const numStops = buf.readUInt32LE(8);
  const numRoutes = buf.readUInt32LE(12);
  const numTrips = buf.readUInt32LE(16);
  const numServices = buf.readUInt32LE(24);
  const cityTzOffsetSeconds = buf.readInt32LE(28);
  // WindowMeta (0x01): decode the runtime service-bitmask window length. Mirrors
  // the Rust reader — absent ⇒ default 90; present-but-<2 B ⇒ hard error (a
  // malformed region must not masquerade as absent); decoded value > 400 ⇒ hard
  // error.
  let windowDays = SERVICE_WINDOW_DAYS;
  if (windowMetaRegion !== undefined) {
    if (windowMetaRegion.length < 2) {
      throw new Error(
        `ptb: WindowMeta (0x01) region too short — length=${windowMetaRegion.length}, need ≥ 2`,
      );
    }
    windowDays = buf.readUInt16LE(windowMetaRegion.offset);
    if (windowDays > WINDOW_HARD_CEILING) {
      throw new Error(
        `ptb: WindowMeta windowDays=${windowDays} exceeds hard ceiling ${WINDOW_HARD_CEILING}`,
      );
    }
  }
  // Per-service bitmask stride derived from the runtime window (mirrors the Rust
  // `pt_core::bytes_per_service` = `ceil(windowDays/8)`).
  const serviceStride = bytesPerService(windowDays);
  const v2 = isV2 ? decodeV2(buf, v2Regions, windowDays, featureFlags) : undefined;

  const pool = decodeStringPool(buf, regions.stringPool);

  // Stops/routes: the mandatory 0x40 / 0x41 typed columns. A bundle missing
  // either is malformed (mirrors the Rust `MissingRequiredRegion`).
  if (stopsSoaRegion === undefined || routesSoaRegion === undefined) {
    const id = stopsSoaRegion === undefined ? STOPS_SOA_REGION_ID : ROUTES_SOA_REGION_ID;
    throw new Error(`ptb: bundle missing required region ${regionNameById(id)} (0x${id.toString(16)})`);
  }
  const decodedStops = decodeStopsSoA(buf, stopsSoaRegion, numStops, pool);
  const stops = decodedStops.stops;
  const routes = decodeRoutesSoA(buf, routesSoaRegion, numRoutes, pool);

  const trips = decodeTrips(buf, regions.tripsIntern, numTrips, pool);
  // Pattern band (0x10-0x14 / 0x45 / 0x46), decoded UP FRONT so the carry-less
  // path below can materialize the flat times/boarding from it. DORMANT when the
  // flat carry is present (the carry still drives every consumer); see the band
  // dispatch below + decodePatternBand. Absent 0x10 ⇒ undefined (a staging
  // bundle carries no band).
  const patternBand = decodePatternBand(bytes, band, stops.length, trips.length);
  // PTB v2 TripMeta +16 is a StringPool block key (`ptn:block:...`) or
  // u32::MAX; mirrors pt_core's `block_idx_out_of_range` check.
  if (v2 && patternBand) {
    for (let t = 0; t < numTrips; t++) {
      const b = buf.readUInt32LE(patternBand.tripMeta.offset + t * TRIP_META_RECORD_BYTES + 16);
      if (b !== 0xffffffff && b >= pool.length) {
        throw new Error(`ptb: v2 TripMeta[${t}] block_idx ${b} out of range (pool ${pool.length})`);
      }
    }
  }

  // ── StopTimes / TripStarts / boarding dispatch: flat carry vs band (B1.5) ───── Normally the
  // flat 0xF4 StopTimes + 0xF5 TripStarts + 0xFA boarding carry drive the read path (BYTE-UNCHANGED
  // — today's fixtures all carry it). The B1.5 teardown STRIPS that carry from published bundles,
  // leaving only the pattern band: when the carry is absent/zero-length AND the band is present, we
  // re-materialize the SAME flat {stopTimes, tripStarts, boarding} from the band via the single
  // shared bandToFlatStopTimes decoder, so loadPtb returns a populated bundle identical in shape to
  // a carry-bearing load (downstream — ptbToBundleWire, loadFromPtb — needs no change). A
  // carry-less bundle WITHOUT a band is unroutable: fall through to the flat decode + the
  // cross-check throw (an empty 0xF4 with no band is a malformed/incomplete bundle).
  const st = regions.stopTimes;
  // Carry-LESS detection requires ALL THREE flat carries — `0xF4 StopTimes`,
  // `0xF5 TripStarts`, AND `0xF6 Csr` — to be absent, EXACTLY mirroring the Rust
  // reader's `carry_less_band` gate. A mixed-shape bundle (e.g.
  // 0xF4/0xF5 stripped but 0xF6 present) must NOT take the band-materialize +
  // CSR-synth path here while Rust takes the carry-bearing path — that would be a
  // cross-runtime divergence. Production strips all three together (T5a), so the
  // mixed shape never occurs; this gate makes the two runtimes agree by construction.
  const carryAbsent =
    regions.stopTimes.length === 0 && regions.tripStarts.length === 0 && regions.csr.length === 0;
  let stopTimes: PtbStopTime[];
  let tripStarts: Uint32Array;
  let materializedBoarding: Uint8Array | undefined;
  let carryMaterializedFromBand = false;
  if (carryAbsent && patternBand !== undefined) {
    // Carry-less: materialize the flat representation from the band. Rows are
    // emitted in trip_idx order (tripStarts is the prefix-sum, tripIdx === i),
    // exactly what the flat consumers expect — the band grouping + emitWireRoute
    // cursor align over the SAME tripStarts/row order. The `0xF6 Csr` (route_trips
    // / stop_routes) is ALSO stripped at T5, so the route→trips CSR is synthesized
    // from the per-trip `routeIdx` and stop→routes is left empty in the CSR block
    // below (gated by `carryMaterializedFromBand`) — mirroring the Rust reader's
    // `synthesize_carry_from_band`.
    const mat = bandToFlatStopTimes(patternBand, bytes, trips.length);
    stopTimes = mat.stopTimes;
    tripStarts = mat.tripStarts;
    materializedBoarding = mat.boarding;
    carryMaterializedFromBand = true;
  } else {
    // StopTimes are 12·N bytes de-interleaved into four SoA columns. Validate the
    // region geometry up front and fail closed — a length that is not a multiple
    // of 12 (or an unaligned offset) would otherwise be silently mis-strided into
    // a plausible-but-wrong decode instead of an error.
    if (st.offset % 4 !== 0 || st.length % STOP_TIME_ROW_BYTES !== 0) {
      throw new Error(`ptb: malformed SoA StopTimes region (offset=${st.offset}, length=${st.length})`);
    }
    stopTimes = decodeStopTimesSoA(buf, st);

    // TripStarts: num_trips+1 u32 LE prefix-sum
    // into the StopTimes rows, in sorted-trip order. tripStarts[i]..tripStarts[i+1]
    // is trip i's contiguous row range; tripStarts[0]===0 and
    // tripStarts[last]===stopTimes.length.
    // The region table records the exact populated byte count ((trips+1)*4),
    // even though the writer page-aligns the NEXT region's offset.
    tripStarts = readU32Slice(buf, regions.tripStarts.offset, trips.length + 1);

    // Loud cross-check of the two independently-decoded regions: TripStarts'
    // prefix-sum must terminate at the StopTimes row count. An always-true
    // invariant for any well-formed bundle — if it fires, a region (e.g. the SoA
    // StopTimes columns) was mis-decoded, and we fail closed rather than ship a
    // silently-corrupt scan. (A carry-less bundle took the band-materialize branch
    // above and never reaches this check.)
    if (tripStarts[tripStarts.length - 1] !== stopTimes.length) {
      throw new Error(
        `ptb: tripStarts[last]=${tripStarts[tripStarts.length - 1]} != stopTimes.length=${stopTimes.length} (mis-decoded StopTimes region)`,
      );
    }
  }

  // CSR (route→trips + stop→routes). Carry-BEARING: decoded from the `0xF6 Csr`
  // region (per regions.rs::flush_mid_pass_regions, packed back-to-back with no
  // padding): rt_offsets[routes+1] | rt_neighbors[trips] | sr_offsets[stops+1] |
  // sr_neighbors[variable] — `rt_neighbors.len() == trips.length` (every trip on
  // exactly one route), so the arithmetic advances past it by `trips.length * 4`.
  // Carry-LESS (B1.5-T5): `0xF6` is stripped, so the route→trips CSR is
  // synthesized from per-trip `routeIdx` and stop→routes is empty (see below).
  let routeTripsOffsets: Uint32Array;
  let routeTripsValues: Uint32Array;
  let stopRoutesOffsets: Uint32Array;
  let stopRoutesValues: Uint32Array;
  if (carryMaterializedFromBand) {
    // Carry-less (B1.5-T5): the `0xF6 Csr` region was stripped alongside
    // `0xF4`/`0xF5`. Synthesize the route→trips CSR from the surviving per-trip
    // `routeIdx` (decoded from `0xF2 TripsIntern`) by reproducing the value-array
    // order of the producer's canonical emitter
    // `build_route_trips_csr` (`crates/pt-producer/src/csr/route_trips.rs`)
    // and the Rust reader's `synthesize_carry_from_band` (counting sort keyed by
    // route, trips visited in ascending ordinal). All THREE must stay in sync — the
    // value-array order drives plan correctness and no CI gate links them. The
    // stop→routes CSR is left EMPTY — exactly as the Rust carry-less reader leaves
    // `sr_offsets`/`sr_values`. See `synthesize_carry_from_band`.
    //
    // Empty is safe HERE because nothing in this plane routes on it: the engine's
    // `routesAtStop` comes from `raptorIndex.ts`'s `buildDisplayAtStop` fold over
    // the wire bundle's route `stopIds`, never from `stopRoutesValues` (see
    // `crates/pt-core/tests/raptor_behavior.rs` — "Never reads stopRoutesValues"). Only the
    // engine-regression comparison reads these arrays.
    //
    // This comment used to justify it differently — "the OFF flat path is not taken
    // by a carry-less bundle" — and that premise is false. The Rust side carried
    // the identical claim and acted on it, leaving `PatternMode::Off` on a
    // carry-less bundle to read the stripped CSR and die with a bare
    // `SliceOutOfBounds`; `Index::build` dispatches `Off` to the flat path on EVERY
    // bundle. Rust now derives the table from each route's canonical `stop_ids`,
    // which is what this plane has always effectively done. Don't reintroduce the
    // premise on either side.
    const numRoutes = routes.length;
    const counts = new Uint32Array(numRoutes);
    for (let t = 0; t < trips.length; t++) {
      const r = trips[t]!.routeIdx;
      if (r >= numRoutes) {
        throw new Error(`ptb: carry-less synth trip ${t} routeIdx=${r} out of range (routes=${numRoutes})`);
      }
      counts[r]!++;
    }
    routeTripsOffsets = new Uint32Array(numRoutes + 1);
    for (let r = 0; r < numRoutes; r++) routeTripsOffsets[r + 1] = routeTripsOffsets[r]! + counts[r]!;
    routeTripsValues = new Uint32Array(trips.length);
    const cursor = Uint32Array.from(routeTripsOffsets.subarray(0, numRoutes));
    for (let t = 0; t < trips.length; t++) {
      const r = trips[t]!.routeIdx;
      routeTripsValues[cursor[r]!++] = t;
    }
    stopRoutesOffsets = new Uint32Array(stops.length + 1); // all-zero ⇒ every stop empty
    stopRoutesValues = new Uint32Array(0);
  } else {
    // CSR layout: rt_offsets[routes+1] | rt_neighbors[trips] | sr_offsets[stops+1]
    //           | sr_neighbors[variable], packed back-to-back.
    const csrBase = regions.csr.offset;
    const rtOffsetsLen = routes.length + 1;
    routeTripsOffsets = readU32Slice(buf, csrBase, rtOffsetsLen);
    const rtValuesLen = routeTripsOffsets[routeTripsOffsets.length - 1];
    const rtValuesStart = csrBase + rtOffsetsLen * 4;
    routeTripsValues = readU32Slice(buf, rtValuesStart, rtValuesLen);
    const srOffsetsStart = rtValuesStart + trips.length * 4;
    const srOffsetsLen = stops.length + 1;
    stopRoutesOffsets = readU32Slice(buf, srOffsetsStart, srOffsetsLen);
    const srValuesLen = stopRoutesOffsets[stopRoutesOffsets.length - 1];
    const srValuesStart = srOffsetsStart + srOffsetsLen * 4;
    stopRoutesValues = readU32Slice(buf, srValuesStart, srValuesLen);
  }

  // CSR integrity: guards corrupt/hostile bundles — the loader is shared across future consumers.
  // routeTripsOffsets: non-decreasing, last entry == trips.length
  for (let i = 1; i < routeTripsOffsets.length; i++) {
    if (routeTripsOffsets[i]! < routeTripsOffsets[i - 1]!) {
      throw new Error(
        `ptb: routeTripsOffsets is not non-decreasing at index ${i} ` +
          `(${routeTripsOffsets[i - 1]} > ${routeTripsOffsets[i]})`,
      );
    }
  }
  if (routeTripsOffsets[routeTripsOffsets.length - 1] !== trips.length) {
    throw new Error(
      `ptb: routeTripsOffsets[last]=${routeTripsOffsets[routeTripsOffsets.length - 1]} !== trips.length=${trips.length}`,
    );
  }
  // routeTripsValues: every value < trips.length
  for (let i = 0; i < routeTripsValues.length; i++) {
    if (routeTripsValues[i]! >= trips.length) {
      throw new Error(
        `ptb: routeTripsValues[${i}]=${routeTripsValues[i]} out of bounds (trips.length=${trips.length})`,
      );
    }
  }
  // stopRoutesOffsets: non-decreasing, last entry == stopRoutesValues.length
  for (let i = 1; i < stopRoutesOffsets.length; i++) {
    if (stopRoutesOffsets[i]! < stopRoutesOffsets[i - 1]!) {
      throw new Error(
        `ptb: stopRoutesOffsets is not non-decreasing at index ${i} ` +
          `(${stopRoutesOffsets[i - 1]} > ${stopRoutesOffsets[i]})`,
      );
    }
  }
  if (stopRoutesOffsets[stopRoutesOffsets.length - 1] !== stopRoutesValues.length) {
    throw new Error(
      `ptb: stopRoutesOffsets[last]=${stopRoutesOffsets[stopRoutesOffsets.length - 1]} !== stopRoutesValues.length=${stopRoutesValues.length}`,
    );
  }
  // stopRoutesValues: every value < routes.length
  for (let i = 0; i < stopRoutesValues.length; i++) {
    if (stopRoutesValues[i]! >= routes.length) {
      throw new Error(
        `ptb: stopRoutesValues[${i}]=${stopRoutesValues[i]} out of bounds (routes.length=${routes.length})`,
      );
    }
  }

  // ServiceBitmasks materialization from the `0x15 ServiceBitfieldPool` /
  // `0x16 ServiceToBitfield` pool pair: a flat `numServices × S` view built from
  // `pool[idx[s]*S .. +S]` — downstream readers (ptbToBundleWire / loadFromPtb /
  // assert-ptb-cross-parity / engine-regression) consume it. The gates mirror
  // the Rust reader (crates/pt-core/src/reader.rs): BOTH regions present (C3);
  // exact `0x15.length === 4 + count*S` and `0x16.length === numServices*4`;
  // `count==0` permitted IFF `numServices==0` (C2, checked before the index
  // loop); every `ServiceToBitfield[s] < count`.
  if (serviceBitfieldPoolRegion === undefined || serviceToBitfieldRegion === undefined) {
    throw new Error(
      "ptb: bundle missing required ServiceBitfieldPool (0x15) / ServiceToBitfield (0x16) region",
    );
  }
  const poolReg = serviceBitfieldPoolRegion;
  const s2bReg = serviceToBitfieldRegion;
  const count = buf.readUInt32LE(poolReg.offset);
  const poolNeed = 4 + count * serviceStride;
  if (poolReg.length !== poolNeed) {
    throw new Error(
      `ptb: ServiceBitfieldPool (0x15) length=${poolReg.length} != 4 + count*${serviceStride} ` +
        `(count=${count}, windowDays=${windowDays}, need ${poolNeed})`,
    );
  }
  const indexNeed = numServices * 4;
  if (s2bReg.length !== indexNeed) {
    throw new Error(
      `ptb: ServiceToBitfield (0x16) length=${s2bReg.length} != numServices*4 ` +
        `(numServices=${numServices}, need ${indexNeed})`,
    );
  }
  // C2: the empty-pool rule is a BICONDITIONAL — count==0 is permitted IFF
  // numServices==0. Both asymmetries are hard errors (checked before the index
  // loop so this distinct reason fires, not index_oob), mirroring the Rust
  // reader's `(count == 0) != (num_services == 0)` gate:
  //   - count==0 && numServices>0: services with no bitfield to map.
  //   - numServices==0 && count>0: an orphaned pool — non-empty bitfield storage
  //     no ServiceToBitfield entry can point at (the index loop runs zero times).
  if ((count === 0) !== (numServices === 0)) {
    throw new Error(
      `ptb: ServiceBitfieldPool (0x15) count=${count} but numServices=${numServices} ` +
        `(empty pool permitted IFF numServices==0)`,
    );
  }
  const poolPayloadOffset = poolReg.offset + 4;
  const serviceBitmasks = new Uint8Array(numServices * serviceStride);
  for (let s = 0; s < numServices; s++) {
    const poolIdx = buf.readUInt32LE(s2bReg.offset + s * 4);
    if (poolIdx >= count) {
      throw new Error(
        `ptb: ServiceToBitfield[${s}]=${poolIdx} out of range (pool count=${count})`,
      );
    }
    const srcStart = poolPayloadOffset + poolIdx * serviceStride;
    // Copy pool[poolIdx*S .. +S] into the flat view at s*S.
    for (let b = 0; b < serviceStride; b++) {
      serviceBitmasks[s * serviceStride + b] = buf.readUInt8(srcStart + b);
    }
  }

  const transfers = isV2
    ? decodeTransfersV2(buf, regions.transfers, numStops, numRoutes, trips)
    : decodeTransfers(buf, regions.transfers);

  // Boarding column (pickup/drop-off, per global stop_time row). Two sources, mutually exclusive: •
  // CARRY PRESENT (a staging bundle): decode the optional 0xFA StopTimeBoarding region — a
  // per-stop_time packed-byte column indexed by the global stop_time row. Absent ⇒ undefined (every
  // stop_time defaults to 0x50). Length validated == stopTimes.length (fail closed). • CARRY
  // MATERIALIZED FROM BAND (carry-less): the boarding column was synthesized from 0x12
  // PatternSemantics inside bandToFlatStopTimes above (same omit-when-all-default ⇒ undefined
  // contract as 0xFA), so reuse it verbatim. The 0xFA region is absent on a carry-less bundle.
  const boarding = carryMaterializedFromBand
    ? materializedBoarding
    : decodeStopTimeBoarding(buf, stopTimeBoardingRegion, stopTimes.length);

  // Optional 0x17 Frequencies region. Carry-only — no scan reads it yet.
  const decodedFrequencies = decodeFrequencies(buf, frequenciesRegion, isV2, numTrips);
  const frequencies = decodedFrequencies.rows;
  if (v2) v2.quarantinedFrequencyTrips = decodedFrequencies.quarantined;

  // `patternBand` (0x10-0x14 / 0x45 / 0x46) was decoded UP FRONT (before the
  // StopTimes/TripStarts dispatch) so the carry-less branch could materialize the
  // flat times/boarding from it. When the flat carry is present it is DORMANT —
  // attached below but consumed by nothing (the carry drives the read path), so a
  // carry-bearing load is byte-unchanged. Absent 0x10 ⇒ undefined.

  // Parents were derived from the dense `parent_idx` column inside
  // decodeStopsSoA (self-ref/bounds throws there).
  const stopParents: PtbStopParentEntry[] = decodedStops.stopParents;

  return {
    magic,
    version,
    feedStartDate,
    cityTzOffsetSeconds,
    featureFlags,
    windowDays,
    regions,
    stops,
    routes,
    trips,
    stopTimes,
    tripStarts,
    routeTripsOffsets,
    routeTripsValues,
    stopRoutesOffsets,
    stopRoutesValues,
    serviceBitmasks,
    numServices,
    transfers,
    ...(v2 ? { v2 } : {}),
    stopParents,
    stringPool: pool,
    stopIndexRegion,
    stopsSoaRegion,
    routesSoaRegion,
    boarding,
    frequencies,
    patternBand,
    carryMaterializedFromBand,
  };
}

/**
 * FNV-1a 32-bit. Mirrors `stop_index::fnv1a32` (Rust) — `Math.imul` does the
 * 32-bit wrapping multiply and the final `>>> 0` normalizes to unsigned, so the
 * hash is byte-identical to the Rust producer's (verified against the pinned
 * `S2U9`/`AGCVF` collision in loader.test.ts).
 */
export function fnv1a32(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Resolve `key` to its stop ordinal via the persisted StopIndex region, or
 * `undefined` if absent. Mirrors `stop_index::lookup` (Rust): binary-search the
 * sorted `(fnv32, stringpool_idx, ordinal)` table by `fnv32`, then a full-string
 * tiebreak against `pool` (resolving `stringpool_idx`) so a hash collision can
 * never return a wrong ordinal, and a duplicate id returns its last ordinal.
 */
export function lookupStopIndexRegion(
  bytes: Uint8Array,
  region: PtbRegion,
  pool: string[],
  key: string,
): number | undefined {
  const buf = new PtbByteReader(bytes);
  const n = Math.floor(region.length / STOP_INDEX_ENTRY_BYTES);
  const target = fnv1a32(UTF8_ENCODER.encode(key));
  const fnvAt = (i: number): number => buf.readUInt32LE(region.offset + i * STOP_INDEX_ENTRY_BYTES);
  // First entry with fnv >= target.
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (fnvAt(mid) < target) lo = mid + 1;
    else hi = mid;
  }
  // Scan the equal-hash run; exact full-string tiebreak via the pool.
  for (let i = lo; i < n && fnvAt(i) === target; i++) {
    const base = region.offset + i * STOP_INDEX_ENTRY_BYTES;
    const idx = buf.readUInt32LE(base + 4);
    if (pool[idx] === key) return buf.readUInt32LE(base + 8);
  }
  return undefined;
}

function readU32Slice(buf: PtbByteReader, start: number, count: number): Uint32Array {
  if (start + count * 4 > buf.length) {
    throw new Error(`ptb: u32 slice out of bounds — start=${start} count=${count} buf=${buf.length}`);
  }
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) out[i] = buf.readUInt32LE(start + i * 4);
  return out;
}

function decodeStringPool(buf: PtbByteReader, region: PtbRegion): string[] {
  const base = region.offset;
  const count = buf.readUInt32LE(base);
  if (4 + (count + 1) * 4 > region.length) {
    throw new Error(`ptb: stringPool count ${count} overflows region length ${region.length}`);
  }
  const offsetsBase = base + 4;
  const blobBase = offsetsBase + (count + 1) * 4;
  const blobLen = buf.readUInt32LE(offsetsBase + count * 4);
  const expected = 4 + (count + 1) * 4 + blobLen;
  if (region.length !== expected) {
    throw new Error(`ptb: stringPool length mismatch — region=${region.length} expected=${expected}`);
  }
  const pool: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const lo = buf.readUInt32LE(offsetsBase + i * 4);
    const hi = buf.readUInt32LE(offsetsBase + (i + 1) * 4);
    pool[i] = buf.decode("utf8", blobBase + lo, blobBase + hi);
  }
  return pool;
}

function poolAt(pool: string[], idx: number, ctx?: string): string {
  if (idx < 0 || idx >= pool.length) {
    const suffix = ctx ? ` (${ctx})` : "";
    throw new Error(`ptb: string index out of range — idx=${idx} count=${pool.length}${suffix}`);
  }
  return pool[idx]!;
}

/** Sentinel in the dense `parent_idx` column meaning "no parent". `u32::MAX`. */
const SOA_PARENT_NONE = 0xffffffff;

/**
 * Decode the `StopsSoA` (`0x40`) typed columns into `PtbStop[]`, deriving the
 * dense parents alongside. Mirrors the Rust reader (`resolve_stops_soa`) +
 * the testkit writer (`build_v1_ptb`): frozen column order with all 4-byte columns first
 * and the `u8` wheelchair column last —
 *   id_idx u32×N | name_idx u32×N | lat_e7 i32×N | lon_e7 i32×N
 *   | parent_idx u32×N | wheelchair u8×N
 * Column `col` of the five 4-byte columns starts at `base + col*4*N`, element `i`
 * at `base + col*4*N + i*4`; the wheelchair `u8` column starts at `base + 20*N`.
 *
 * Coords are exposed BOTH as the canonical i32 `latE7`/`lonE7` (`readInt32LE`)
 * AND as f64 `stopLat`/`stopLon` via `decodeE7` (= e7/1e7) for back-compat.
 * `parent_idx == u32::MAX` ⇒ no parent; an in-range non-self parent becomes a
 * `(childIdx, parentIdx)` entry. Self-ref and out-of-range parents throw
 * (`parent >= N` and `parent == i`).
 */
function decodeStopsSoA(
  buf: PtbByteReader,
  region: PtbRegion,
  count: number,
  pool: string[],
): { stops: PtbStop[]; stopParents: PtbStopParentEntry[] } {
  // Tight column total: five 4-byte columns + one u8 column, all × N (= N*21).
  const tight = count * 21;
  if (region.length < tight) {
    throw new Error(`ptb: stopsSoA count ${count} exceeds region capacity (${region.length} bytes)`);
  }
  if (region.offset % 4 !== 0) {
    throw new Error(`ptb: stopsSoA region offset ${region.offset} is not 4-aligned`);
  }
  const base = region.offset;
  // Per-column base byte offsets (4-byte columns, then the u8 column).
  const idIdxBase = base + 0 * 4 * count;
  const nameIdxBase = base + 1 * 4 * count;
  const latE7Base = base + 2 * 4 * count;
  const lonE7Base = base + 3 * 4 * count;
  const parentIdxBase = base + 4 * 4 * count;
  const wheelchairBase = base + 20 * count;

  const stops: PtbStop[] = new Array(count);
  const stopParents: PtbStopParentEntry[] = [];
  for (let i = 0; i < count; i++) {
    const idIdx = buf.readUInt32LE(idIdxBase + i * 4);
    const nameIdx = buf.readUInt32LE(nameIdxBase + i * 4);
    const latE7 = buf.readInt32LE(latE7Base + i * 4);
    const lonE7 = buf.readInt32LE(lonE7Base + i * 4);
    const parentIdx = buf.readUInt32LE(parentIdxBase + i * 4);
    const wheelchairBoarding = buf.readUInt8(wheelchairBase + i);
    stops[i] = {
      stopId: poolAt(pool, idIdx, `stop[${i}].stopId`),
      stopName: poolAt(pool, nameIdx, `stop[${i}].stopName`),
      stopLat: decodeE7(latE7),
      stopLon: decodeE7(lonE7),
      latE7,
      lonE7,
      wheelchairBoarding,
    };
    if (parentIdx !== SOA_PARENT_NONE) {
      // Bounds + self-ref guards
      // (loader.ts self-ref/bounds throws) to the dense column path.
      if (parentIdx >= count) {
        throw new Error(
          `ptb: stopsSoA parent_idx out of range at ${i} (parent=${parentIdx}, numStops=${count})`,
        );
      }
      if (parentIdx === i) {
        throw new Error(`ptb: stopsSoA parent_idx self-reference at ${i} (parent_idx=${i})`);
      }
      stopParents.push({ childIdx: i, parentIdx });
    }
  }
  return { stops, stopParents };
}

/**
 * Decode the `RoutesSoA` (`0x41`) typed columns into `PtbRoute[]`. Mirrors
 * the Rust reader (`resolve_routes_soa`) + the testkit writer: six `u32`
 * idx columns first, then the `u16` route_type column —
 *   id_idx · agency_idx · short_idx · long_idx · color_idx · text_color_idx
 *   (u32×M each) | route_type u16×M
 * Resolves the six idx columns through the StringPool (`agency_idx` @col1,
 * `long_idx` @col3).
 */
function decodeRoutesSoA(buf: PtbByteReader, region: PtbRegion, count: number, pool: string[]): PtbRoute[] {
  // Tight column total: six 4-byte columns + one u16 column, all × M (= M*26).
  const tight = count * 26;
  if (region.length < tight) {
    throw new Error(`ptb: routesSoA count ${count} exceeds region capacity (${region.length} bytes)`);
  }
  if (region.offset % 4 !== 0) {
    throw new Error(`ptb: routesSoA region offset ${region.offset} is not 4-aligned`);
  }
  const base = region.offset;
  const idIdxBase = base + 0 * 4 * count;
  const agencyIdxBase = base + 1 * 4 * count;
  const shortIdxBase = base + 2 * 4 * count;
  const longIdxBase = base + 3 * 4 * count;
  const colorIdxBase = base + 4 * 4 * count;
  const textColorIdxBase = base + 5 * 4 * count;
  const routeTypeBase = base + 24 * count;

  const out: PtbRoute[] = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = {
      routeId: poolAt(pool, buf.readUInt32LE(idIdxBase + i * 4), `route[${i}].routeId`),
      agencyId: poolAt(pool, buf.readUInt32LE(agencyIdxBase + i * 4), `route[${i}].agencyId`),
      routeShortName: poolAt(pool, buf.readUInt32LE(shortIdxBase + i * 4), `route[${i}].routeShortName`),
      routeLongName: poolAt(pool, buf.readUInt32LE(longIdxBase + i * 4), `route[${i}].routeLongName`),
      routeType: buf.readUInt16LE(routeTypeBase + i * 2),
      routeColor: poolAt(pool, buf.readUInt32LE(colorIdxBase + i * 4), `route[${i}].routeColor`),
      routeTextColor: poolAt(pool, buf.readUInt32LE(textColorIdxBase + i * 4), `route[${i}].routeTextColor`),
    };
  }
  return out;
}

function decodeTrips(buf: PtbByteReader, region: PtbRegion, count: number, pool: string[]): PtbTrip[] {
  if (count * TRIP_RECORD_BYTES > region.length) {
    throw new Error(`ptb: trips count ${count} exceeds region capacity (${region.length} bytes)`);
  }
  const out: PtbTrip[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const off = region.offset + i * TRIP_RECORD_BYTES;
    // 24 B record: idIdx@0 | headsignIdx@4 | routeIdx@8 | serviceIdx@12 |
    //              wheelchairAccessible u8@16 | direction_id u8@17 | bikes_allowed u8@18 | reserved[19] | shapeIdIdx u32@20
    out[i] = {
      tripId: poolAt(pool, buf.readUInt32LE(off), `trip[${i}].tripId`),
      headsign: poolAt(pool, buf.readUInt32LE(off + 4), `trip[${i}].headsign`),
      routeIdx: buf.readUInt32LE(off + 8),
      serviceIdx: buf.readUInt32LE(off + 12),
      wheelchairAccessible: buf.readUInt8(off + 16),
      directionId: buf.readUInt8(off + 17),
      bikesAllowed: buf.readUInt8(off + 18),
      shapeId: poolAt(pool, buf.readUInt32LE(off + 20), `trip[${i}].shapeId`),
    };
  }
  return out;
}

function decodeStopTimesSoA(buf: PtbByteReader, region: PtbRegion): PtbStopTime[] {
  const n = Math.floor(region.length / STOP_TIME_ROW_BYTES);
  const dep = region.offset;
  const sidx = region.offset + 4 * n;
  const arr = region.offset + 8 * n;
  const seq = region.offset + 10 * n;
  const out: PtbStopTime[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      depSecs: buf.readUInt32LE(dep + 4 * i),
      arrDiff: buf.readInt16LE(arr + 2 * i),
      stopIdx: buf.readUInt32LE(sidx + 4 * i),
      stopSeq: buf.readUInt16LE(seq + 2 * i),
    };
  }
  return out;
}

/**
 * Decode the optional `StopTimeBoarding` region (`0xFA`) into a flat
 * per-stop_time column of packed bytes (one byte per stop_time row). Returns
 * `undefined` when the region is absent or length-0 (⇒ every stop_time defaults
 * to `0x50`). The region length MUST equal `n` (= `stopTimes.length`); a mismatch
 * is a malformed bundle — fail closed rather than ship a silently-misaligned
 * column. Mirrors the Rust reader's `boarding_off` resolve (length == num_stop_times).
 *
 * The bytes are copied out (not a view onto `buf`) so callers needn't worry about
 * the backing buffer's lifetime. Each byte (LSB-first): `[1:0]`=pickup_type,
 * `[3:2]`=drop_off_type, `[5:4]`=continuous_pickup, `[7:6]`=continuous_drop_off.
 * GTFS reference: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
 */
function decodeStopTimeBoarding(buf: PtbByteReader, region: PtbRegion | undefined, n: number): Uint8Array | undefined {
  if (!region || region.length === 0) return undefined;
  if (region.length !== n) {
    throw new Error(`ptb: stopTimeBoarding length ${region.length} != num_stop_times ${n}`);
  }
  return buf.subarray(region.offset, region.offset + n).slice();
}

/**
 * Decode the optional `0x17 Frequencies` region into an array of
 * {@link PtbFrequencyRow} objects. Returns `undefined` when the region is
 * absent or empty. Mirrors `Reader::frequencies_for_trip` / `FrequencyRecord`
 * (Rust): little-endian, 16 B/row, `count u32 LE` prefix.
 *
 * Wire layout (identical to the Rust `FrequencyRecord`):
 * ```
 * [0..4]   tripIdx     u32 LE
 * [4..8]   startSecs   u32 LE
 * [8..12]  endSecs     u32 LE  (half-open EXCLUDED — carried verbatim)
 * [12..14] headwaySecs u16 LE
 * [14]     exactTimes  u8
 * [15]     reserved    u8
 * ```
 * GTFS reference: https://gtfs.org/documentation/schedule/reference/#frequenciestxt
 */
/** v2 `0x17` row byte 15 bit0 (`pt_core::v2::FREQUENCY_FLAG_QUARANTINED`). */
const FREQUENCY_FLAG_QUARANTINED = 1;

/**
 * Decode `0x17`. On v2 every row is checked against the v2 frequency contract
 * (mirrors `pt_core::v2::validate_frequencies_v2`) and quarantine marker rows
 * are returned as trip ordinals instead of frequency rows.
 * GTFS reference: https://gtfs.org/documentation/schedule/reference/#frequenciestxt
 */
function decodeFrequencies(
  buf: PtbByteReader,
  region: PtbRegion | undefined,
  isV2: boolean,
  numTrips: number,
): { rows: PtbFrequencyRow[] | undefined; quarantined: number[] } {
  const quarantined: number[] = [];
  const rows = decodeFrequencyRows(buf, region);
  if (!rows || !isV2) return { rows: rows?.map((r) => r.row), quarantined };
  const healthy: PtbFrequencyRow[] = [];
  let prev: { trip: number; end: number; q: boolean } | undefined;
  rows.forEach(({ row: r, flags }, i) => {
    const bad = (reason: string): Error => new Error(`ptb: invalid v2 frequency row ${i} (${reason})`);
    if (r.tripIdx >= numTrips) throw bad("trip_out_of_range");
    if ((flags & ~FREQUENCY_FLAG_QUARANTINED) !== 0) throw bad("unknown_flags");
    const q = (flags & FREQUENCY_FLAG_QUARANTINED) !== 0;
    if (prev) {
      if (r.tripIdx < prev.trip) throw bad("unsorted");
      if (r.tripIdx === prev.trip) {
        if (q || prev.q) throw bad("quarantine_marker_not_alone");
        if (r.startSecs < prev.end) throw bad("overlapping_windows");
      }
    }
    if (q) {
      if (r.startSecs !== 0 || r.endSecs !== 1 || r.headwaySecs !== 1 || r.exactTimes !== 0) {
        throw bad("noncanonical_quarantine_marker");
      }
      quarantined.push(r.tripIdx);
    } else {
      if (r.headwaySecs === 0) throw bad("zero_headway");
      if (r.startSecs >= r.endSecs) throw bad("empty_window");
      if (r.exactTimes > 1) throw bad("exact_times");
      healthy.push(r);
    }
    prev = { trip: r.tripIdx, end: r.endSecs, q };
  });
  return { rows: healthy.length > 0 ? healthy : undefined, quarantined };
}

function decodeFrequencyRows(
  buf: PtbByteReader,
  region: PtbRegion | undefined,
): Array<{ row: PtbFrequencyRow; flags: number }> | undefined {
  if (!region || region.length === 0) return undefined;
  const dv = new DataView(buf.buffer, buf.byteOffset + region.offset, region.length);
  if (region.length < 4) {
    throw new Error(`ptb: frequencies region too short — length=${region.length}, need ≥ 4 (count prefix)`);
  }
  const count = dv.getUint32(0, true);
  if (count === 0) return undefined;
  const expectedLen = 4 + count * 16;
  if (region.length !== expectedLen) {
    throw new Error(
      `ptb: frequencies region length ${region.length} != 4 + count(${count}) * 16 = ${expectedLen}`,
    );
  }
  const rows: Array<{ row: PtbFrequencyRow; flags: number }> = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = 4 + i * 16;
    rows[i] = {
      row: {
        tripIdx:     dv.getUint32(o,      true),
        startSecs:   dv.getUint32(o + 4,  true),
        endSecs:     dv.getUint32(o + 8,  true),
        headwaySecs: dv.getUint16(o + 12, true),
        exactTimes:  dv.getUint8(o + 14),
      },
      flags: dv.getUint8(o + 15),
    };
  }
  return rows;
}

// ── Pattern-band decode (B1.3 Task A) — TS mirror of the Rust ──────────────────
//    `resolve_pattern_band` (crates/pt-core/src/reader.rs). See PtbPatternBand.
//    The `0x13`-slab byte-span formula (`patternTripTimesSpan`) lives in the
//    leaf module `patternBandLayout.ts`, shared with `bandToFlatStopTimes`.

/** Read a `count`-long u32 LE slice at `start`, bounds-checked (throws on OOB). */
function readU32SliceChecked(buf: PtbByteReader, start: number, count: number, what: string): Uint32Array {
  if (start < 0 || start + count * 4 > buf.length) {
    throw new Error(`ptb: ${what} u32 slice out of bounds — start=${start} count=${count} buf=${buf.length}`);
  }
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) out[i] = buf.readUInt32LE(start + i * 4);
  return out;
}

/**
 * Fail-closed bound for a CSR `{offsets[entries+1] u32, values[valuesLen] u32}`
 * region: reject any band whose DECLARED region length is shorter than the
 * computed CSR byte span, and whose region start is not 4-aligned.
 *
 * `readU32SliceChecked` only bounds reads against `buf.length`, so a malformed
 * band whose `0x45`/`0x46` region length is shorter than `(entries+1)*4 +
 * valuesLen*4` would read PAST the declared region into the following region.
 * Rust's `resolve_pattern_band` bounds against the region AND casts the slice
 * via `bytemuck::try_cast_slice` (which rejects a non-4-aligned start); this
 * mirrors BOTH — closing the out-of-region read and the alignment gap the TS
 * reader was otherwise more permissive about. See `crates/pt-core/src/reader.rs`
 * (`cast_u32` / `resolve_pattern_band`).
 */
function assertCsrSpanWithinRegion(
  region: PtbBandRegion,
  entries: number,
  valuesLen: number,
  what: string,
): void {
  if (region.offset % 4 !== 0) {
    throw new Error(`ptb: ${what} region start not 4-aligned (offset=${region.offset})`);
  }
  const spanBytes = (entries + 1) * 4 + valuesLen * 4;
  if (spanBytes > region.length) {
    throw new Error(
      `ptb: ${what} CSR span ${spanBytes} exceeds declared region length ${region.length}`,
    );
  }
}

/**
 * Walk the tagged region table to resolve the seven pattern-band entries
 * (capturing each `entryFlags`). Returns an empty {@link PtbBandRegions} when
 * the band ids are absent. NON-throwing on table shape — this only resolves entries; full
 * validation is {@link decodePatternBand}. Used by {@link loadPtb} (where the
 * main walk already resolved them) and directly by callers handed raw bytes.
 *
 * Mirrors the `header.region_by_id(...)` lookups at the top of the Rust
 * `resolve_pattern_band`.
 */
export function resolvePatternBandRegions(bytes: Uint8Array): PtbBandRegions {
  const buf = new PtbByteReader(bytes);
  const band: PtbBandRegions = {};
  for (let i = 0; ; i++) {
    const e = REGION_TABLE_OFFSET + i * REGION_ENTRY_BYTES;
    if (e + REGION_ENTRY_BYTES > PTB_HEADER_BYTES) break;
    const regionId = buf.readUInt16LE(e);
    if (regionId === 0) break; // terminator
    const entryFlags = buf.readUInt16LE(e + 2);
    const offset = Number(buf.readBigUInt64LE(e + 8));
    const length = Number(buf.readBigUInt64LE(e + 16));
    const reg: PtbBandRegion = { offset, length, entryFlags };
    if (regionId === PATTERNS_REGION_ID) band.patterns = reg;
    else if (regionId === PATTERN_STOPS_REGION_ID) band.patternStops = reg;
    else if (regionId === PATTERN_SEMANTICS_REGION_ID) band.patternSemantics = reg;
    else if (regionId === TRIP_TIMES_REGION_ID) band.tripTimes = reg;
    else if (regionId === TRIP_META_REGION_ID) band.tripMeta = reg;
    else if (regionId === PATTERNS_AT_STOP_REGION_ID) band.patternsAtStop = reg;
    else if (regionId === PATTERN_TRIPS_REGION_ID) band.patternTrips = reg;
  }
  return band;
}

/** TripMeta record stride (`0x14`): `numTrips × 24 B`. */
const TRIP_META_RECORD_BYTES = 24;
/** `0x10 Patterns` record stride (after the `count u32` prefix): 8 B. */
const PATTERN_RECORD_BYTES = 8;

/**
 * Decode + FULLY VALIDATE the pattern band from `bands` (resolved band region
 * entries) into a {@link PtbPatternBand}, or `undefined` when the band is ABSENT
 * (`0x10 Patterns` not resolved — a staging bundle carries none). A PRESENT-but-malformed band is a hard `Error` (`ptb: ...`), never
 * a silent partial decode.
 *
 * **Byte-for-byte mirror of the Rust `resolve_pattern_band`**
 * (`crates/pt-core/src/reader.rs`) — every gate below replicates one there:
 *   - all five required companions present (`0x11`/`0x13`/`0x14`/`0x45`/`0x46`);
 *     `0x12` is optional (omit-when-all-regular);
 *   - `0x10` body fits `count u32` + `count × 8 B`;
 *   - `0x14.length === numTrips × 24` (exact — a short region mis-groups trips);
 *   - `0x45`/`0x46` CSR offsets monotonic + last == values len + ordinals in range;
 *   - the `0x14`↔`0x46` consistency check (bucket trips by `0x14.pattern_idx`,
 *     each `0x46` slice set-identical to its bucket, every trip claimed once);
 *   - `0x11` ordinals in range + `0x11.length` holds the contiguous elements;
 *   - `0x13.length === Σ T·(4 + 2·W·S + ceil(S/8))` exactly, where `W` is the
 *     region-level delta width (2 for i16, 4 for the i32-delta variant — bit1).
 *
 * **entryFlags variants.** The `0x13` `entryFlags` bit1 (i32-deltas) IS decoded:
 * the region-level width (4 B vs the i16 default 2 B) rides in `deltaBytes` and
 * only widens the dep/dwell stride — `bandToFlatStopTimes` reads it identically to
 * Rust. bit0 (ragged) is still the deferred intercity/Paris on-ramp and fails
 * closed (`ptb: 0x13 TripTimes ragged variant unsupported`), as does any unknown
 * bit, matching the Rust band gate.
 *
 * **Consumed by `loadPtb` only on the carry-less path (B1.5).** When the flat
 * carry is present it drives the engine and the returned band is ignored (the
 * engine-regression stays byte-identical); when the carry is absent/empty, `loadPtb`
 * materializes `stopTimes`/`tripStarts`/`boarding` from this band via
 * {@link bandToFlatStopTimes}. See {@link PtbPatternBand}.
 */
export function decodePatternBand(
  bytes: Uint8Array,
  bands: PtbBandRegions,
  numStops: number,
  numTrips: number,
): PtbPatternBand | undefined {
  const buf = new PtbByteReader(bytes);
  const patternsReg = bands.patterns;
  // Absent 0x10 ⇒ no band (NOT an error). loadPtb then takes the flat-carry path.
  if (patternsReg === undefined) return undefined;

  // Required companions — a PRESENT band missing any of these is malformed.
  const need = (r: PtbBandRegion | undefined, what: string): PtbBandRegion => {
    if (r === undefined) throw new Error(`ptb: pattern band present but missing ${what} region`);
    return r;
  };
  const patternStopsReg = need(bands.patternStops, "0x11 PatternStops");
  const tripTimesReg = need(bands.tripTimes, "0x13 TripTimes");
  const tripMetaReg = need(bands.tripMeta, "0x14 TripMeta");
  const patternsAtStopReg = need(bands.patternsAtStop, "0x45 PatternsAtStop");
  const patternTripsReg = need(bands.patternTrips, "0x46 PatternTrips");
  const patternSemanticsReg = bands.patternSemantics; // 0x12 optional

  // entryFlags: bit1 (i32-delta) IS decodable — its width rides in `deltaBytes`
  // below and only widens the dep/dwell stride. bit0 (ragged) is still the
  // deferred intercity/Paris on-ramp; fail closed on it (and on any unknown bit),
  // matching the Rust band gate. The width is resolved ONCE from the same
  // flag→width mapping the materializer uses (patternBandLayout.deltaBytesForFlags).
  if ((tripTimesReg.entryFlags & ~TRIP_TIMES_FLAG_I32_DELTAS) !== 0) {
    throw new Error(
      `ptb: 0x13 TripTimes ragged variant unsupported (entryFlags=0x${tripTimesReg.entryFlags.toString(16)})`,
    );
  }
  const tripTimesDeltaBytes = deltaBytesForFlags(tripTimesReg.entryFlags);

  // 0x10: `count u32` prefix then `count × 8 B`.
  if (patternsReg.length < 4) {
    throw new Error("ptb: 0x10 Patterns region too short (no count prefix)");
  }
  const numPatterns = buf.readUInt32LE(patternsReg.offset);
  const patternsNeed = 4 + numPatterns * PATTERN_RECORD_BYTES;
  if (patternsReg.length < patternsNeed) {
    throw new Error(
      `ptb: 0x10 Patterns length ${patternsReg.length} < 4 + ${numPatterns}*8 (need ${patternsNeed})`,
    );
  }

  // 0x14 TripMeta: exactly numTrips × 24 B (a short region would let a trip's
  // pattern_idx read into the next region and silently mis-group).
  const tripMetaNeed = numTrips * TRIP_META_RECORD_BYTES;
  if (tripMetaReg.length !== tripMetaNeed) {
    throw new Error(
      `ptb: 0x14 TripMeta length ${tripMetaReg.length} != numTrips*24 (numTrips=${numTrips}, need ${tripMetaNeed})`,
    );
  }

  // 0x46 PatternTrips CSR: offsets[numPatterns+1] u32 + trip-ordinal values.
  // Reject a non-4-aligned region start before any u32 read (Rust bytemuck cast).
  if (patternTripsReg.offset % 4 !== 0) {
    throw new Error(`ptb: 0x46 PatternTrips region start not 4-aligned (offset=${patternTripsReg.offset})`);
  }
  const ptOffsets = readU32SliceChecked(buf, patternTripsReg.offset, numPatterns + 1, "0x46 offsets");
  for (let i = 1; i < ptOffsets.length; i++) {
    if (ptOffsets[i]! < ptOffsets[i - 1]!) {
      throw new Error(`ptb: 0x46 PatternTrips offsets not monotonic at ${i}`);
    }
  }
  const ptValuesLen = ptOffsets[ptOffsets.length - 1]!;
  // Bound the computed CSR span to the DECLARED 0x46 region length (Rust parity):
  // the value reads must not spill past the region into the following region.
  assertCsrSpanWithinRegion(patternTripsReg, numPatterns, ptValuesLen, "0x46 PatternTrips");
  const ptValuesStart = patternTripsReg.offset + (numPatterns + 1) * 4;
  const ptValues = readU32SliceChecked(buf, ptValuesStart, ptValuesLen, "0x46 values");
  for (let i = 0; i < ptValues.length; i++) {
    if (ptValues[i]! >= numTrips) {
      throw new Error(`ptb: 0x46 PatternTrips value ${ptValues[i]} out of range (numTrips=${numTrips})`);
    }
  }

  // 0x14 ↔ 0x46 consistency: bucket trips by 0x14.pattern_idx, then require each
  // 0x46 slice to be SET-identical to its bucket, with every trip claimed once.
  // (Defense-in-depth — the two regions are independently valid but never else
  // compared; a producer bug that disagrees yields a wrong-but-non-crashing band.)
  const tmBucket = new Uint32Array(numPatterns);
  const tmPat = new Uint32Array(numTrips);
  for (let t = 0; t < numTrips; t++) {
    const p = buf.readUInt32LE(tripMetaReg.offset + t * TRIP_META_RECORD_BYTES);
    if (p >= numPatterns) {
      throw new Error(`ptb: 0x14 TripMeta pattern_idx ${p} out of range (numPatterns=${numPatterns})`);
    }
    tmPat[t] = p;
    tmBucket[p]!++;
  }
  const seen = new Uint8Array(numTrips);
  for (let p = 0; p < numPatterns; p++) {
    const lo = ptOffsets[p]!;
    const hi = ptOffsets[p + 1]!;
    if (hi - lo !== tmBucket[p]!) {
      throw new Error(`ptb: 0x14/0x46 disagree for pattern ${p} (0x46 claims ${hi - lo}, 0x14 buckets ${tmBucket[p]})`);
    }
    for (let i = lo; i < hi; i++) {
      const t = ptValues[i]!;
      if (seen[t] || tmPat[t] !== p) {
        throw new Error(`ptb: 0x14/0x46 disagree at trip ${t} (pattern ${p})`);
      }
      seen[t] = 1;
    }
  }
  for (let t = 0; t < numTrips; t++) {
    if (!seen[t]) throw new Error(`ptb: 0x14/0x46 disagree — trip ${t} claimed by no 0x46 slice`);
  }

  // 0x45 PatternsAtStop CSR: offsets[numStops+1] u32 + pattern-ordinal values.
  // Reject a non-4-aligned region start before any u32 read (Rust bytemuck cast).
  if (patternsAtStopReg.offset % 4 !== 0) {
    throw new Error(`ptb: 0x45 PatternsAtStop region start not 4-aligned (offset=${patternsAtStopReg.offset})`);
  }
  const srOffsets = readU32SliceChecked(buf, patternsAtStopReg.offset, numStops + 1, "0x45 offsets");
  for (let i = 1; i < srOffsets.length; i++) {
    if (srOffsets[i]! < srOffsets[i - 1]!) {
      throw new Error(`ptb: 0x45 PatternsAtStop offsets not monotonic at ${i}`);
    }
  }
  const srValuesLen = srOffsets[srOffsets.length - 1]!;
  // Bound the computed CSR span to the DECLARED 0x45 region length (Rust parity).
  assertCsrSpanWithinRegion(patternsAtStopReg, numStops, srValuesLen, "0x45 PatternsAtStop");
  const srValuesStart = patternsAtStopReg.offset + (numStops + 1) * 4;
  const srValues = readU32SliceChecked(buf, srValuesStart, srValuesLen, "0x45 values");
  for (let i = 0; i < srValues.length; i++) {
    if (srValues[i]! >= numPatterns) {
      throw new Error(`ptb: 0x45 PatternsAtStop value ${srValues[i]} out of range (numPatterns=${numPatterns})`);
    }
  }

  // 0x10 records + 0x11 PatternStops: walk every pattern, decode its 0x11 slice
  // (ELEMENT-indexed), validate stop ordinals in range, and accumulate the 0x13
  // span (T from the gated 0x46 slice length, S = stop_count).
  const patterns: PtbPatternRecord[] = new Array(numPatterns);
  // 0x11 is contiguous (patterns reference it back-to-back). Decode the whole
  // referenced prefix into one Uint32Array; per-pattern slices are stopsOff-based.
  let stopsSeen = 0; // total 0x11 elements consumed
  let tripTimesSpan = 0;
  // 0x12 expected length = Σ stopCount over NON-all-regular patterns (the producer
  // pushes one byte per stop only when flags.bit0 is UNSET — mirrors Rust
  // `resolve_pattern_band`'s `semantics_expected` and `pattern_emit.rs`).
  let semanticsExpected = 0;
  for (let p = 0; p < numPatterns; p++) {
    const recO = patternsReg.offset + 4 + p * PATTERN_RECORD_BYTES;
    const stopsOff = buf.readUInt32LE(recO); // ELEMENT index into 0x11
    const stopCount = buf.readUInt16LE(recO + 4);
    const flags = buf.readUInt8(recO + 6);
    if (buf.readUInt8(recO + 7) !== 0) {
      throw new Error(`ptb: 0x10 reserved byte must be 0 (pattern ${p})`);
    }
    if ((flags & PATTERN_FLAG_ALL_REGULAR) === 0) {
      semanticsExpected += stopCount;
    }
    // 0x11 slice in-bounds + stop ordinals in range.
    const stopsStart = patternStopsReg.offset + stopsOff * 4;
    const stops = readU32SliceChecked(buf, stopsStart, stopCount, `0x11 pattern ${p}`);
    for (let i = 0; i < stops.length; i++) {
      if (stops[i]! >= numStops) {
        throw new Error(`ptb: 0x11 PatternStops value ${stops[i]} out of range (numStops=${numStops}, pattern ${p})`);
      }
    }
    stopsSeen += stopCount;
    patterns[p] = { stopsOff, stopCount, flags };
    // 0x13 span for this pattern: T from the 0x46 slice length, S = stop_count,
    // W = the region-level delta width (2 for i16, 4 for the i32-delta variant).
    const t = ptOffsets[p + 1]! - ptOffsets[p]!;
    tripTimesSpan += patternTripTimesSpan(t, stopCount, tripTimesDeltaBytes);
  }

  // 0x13 length must EXACTLY equal the per-pattern span sum (no slack tail).
  if (tripTimesReg.length !== tripTimesSpan) {
    throw new Error(`ptb: 0x13 TripTimes length ${tripTimesReg.length} != Σ span ${tripTimesSpan}`);
  }
  // 0x11 must hold at least the contiguous elements the patterns reference.
  if (patternStopsReg.length < stopsSeen * 4) {
    throw new Error(`ptb: 0x11 PatternStops length ${patternStopsReg.length} < ${stopsSeen}*4`);
  }

  // Decode the whole referenced 0x11 prefix once (patterns slice it by stopsOff).
  const patternStops = readU32SliceChecked(buf, patternStopsReg.offset, stopsSeen, "0x11 PatternStops");

  // 0x12 PatternSemantics (optional): one packed byte per pattern-position, for
  // the non-all-regular patterns only. The region length MUST equal Σ stopCount
  // over non-all-regular patterns (the producer omits the region entirely when
  // EVERY pattern is all-regular). Gate the exact size so a short/long 0x12 fails
  // closed IDENTICALLY to Rust `resolve_pattern_band` — a malformed region would
  // otherwise let the Rust hot path read an adjacent region's bytes as boarding
  // flags while this materializer defaults a missing byte to regular (`?? 0x00`),
  // a same-bytes Rust↔TS boarding divergence. Carried verbatim (not interpreted).
  const semanticsLen = patternSemanticsReg?.length ?? 0;
  if (semanticsLen !== semanticsExpected) {
    throw new Error(
      `ptb: 0x12 PatternSemantics length ${semanticsLen} != Σ stopCount over non-all-regular patterns (${semanticsExpected})`,
    );
  }
  let patternSemantics: Uint8Array | undefined;
  if (patternSemanticsReg !== undefined && patternSemanticsReg.length > 0) {
    patternSemantics = buf.subarray(
      patternSemanticsReg.offset,
      patternSemanticsReg.offset + patternSemanticsReg.length,
    ).slice();
  }

  return {
    numPatterns,
    patterns,
    patternStops,
    patternSemantics,
    tripTimes: { offset: tripTimesReg.offset, length: tripTimesReg.length },
    tripMeta: { offset: tripMetaReg.offset, length: tripMetaReg.length },
    patternsAtStopOffsets: srOffsets,
    patternsAtStopValues: srValues,
    patternTripsOffsets: ptOffsets,
    patternTripsValues: ptValues,
    tripTimesEntryFlags: tripTimesReg.entryFlags,
  };
}

/**
 * Decode the `0xF8 Transfers` region into `PtbTransfer[]`.
 *
 * Each row is a fixed 32 B record (count derived as `region.length / 32`; an
 * empty feed → length-0 region → `[]`). Layout (all LE):
 *   off 0  u32 fromStopIdx     off 16 u32 fromTripIdx
 *   off 4  u32 toStopIdx       off 20 u32 toTripIdx
 *   off 8  u32 fromRouteIdx    off 24 u32 minTransferSecs
 *   off 12 u32 toRouteIdx      off 28 u8  transferType | [u8;3] reserved
 * `0xFFFFFFFF` marks an absent optional index / min-transfer-time → `undefined`.
 *
 * GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
 */
function decodeTransfers(buf: PtbByteReader, region: PtbRegion): PtbTransfer[] {
  const numRows = Math.floor(region.length / TRANSFER_RECORD_BYTES);
  const opt = (v: number): number | undefined => (v === TRANSFER_ABSENT ? undefined : v);
  const out: PtbTransfer[] = new Array(numRows);
  for (let i = 0; i < numRows; i++) {
    const off = region.offset + i * TRANSFER_RECORD_BYTES;
    out[i] = {
      fromStopIdx: buf.readUInt32LE(off),
      toStopIdx: buf.readUInt32LE(off + 4),
      fromRouteIdx: opt(buf.readUInt32LE(off + 8)),
      toRouteIdx: opt(buf.readUInt32LE(off + 12)),
      fromTripIdx: opt(buf.readUInt32LE(off + 16)),
      toTripIdx: opt(buf.readUInt32LE(off + 20)),
      minTransferSecs: opt(buf.readUInt32LE(off + 24)),
      transferType: buf.readUInt8(off + 28),
    };
  }
  return out;
}

function hexOf(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Read a u64 LE and require it to be a safe integer (fail closed otherwise). */
function readSafeU64(buf: PtbByteReader, off: number, what: string): number {
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`ptb: ${what} ${v} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(v);
}

/** A mandatory v2 commitment region: present, 8-byte aligned, exact size,
 *  algorithm 1, reserved bytes `[2..8)` zero. Mirrors `v2::commitment_region`. */
function commitmentRegion(
  buf: PtbByteReader,
  regions: Map<number, PtbRegion>,
  id: number,
  name: string,
  size: number,
): number {
  const r = regions.get(id);
  if (!r) throw new Error(`ptb: v2 bundle missing required region ${name} (0x${id.toString(16)})`);
  if (r.offset % 8 !== 0) throw new Error(`ptb: ${name} is not 8-byte aligned`);
  if (r.length !== size) throw new Error(`ptb: ${name} length ${r.length} != ${size}`);
  if (buf.readUInt16LE(r.offset) !== COMMITMENT_ALGORITHM_V1) {
    throw new Error(`ptb: ${name} has an unknown algorithm version`);
  }
  for (let i = 2; i < 8; i++) {
    if (buf.readUInt8(r.offset + i) !== 0) throw new Error(`ptb: ${name} reserved bytes are nonzero`);
  }
  return r.offset;
}

/**
 * Validate and decode the PTB v2 mandatory regions. Mirrors
 * `pt_core::v2::resolve_v2_regions`: origins are `(windowDays + 1)` signed
 * 64-bit values, each exactly representable as a safe integer, strictly
 * increasing; a disabled derivation must commit to the empty index.
 */
function decodeV2(
  buf: PtbByteReader,
  regions: Map<number, PtbRegion>,
  windowDays: number,
  featureFlags: number,
): PtbV2 {
  const o = regions.get(SERVICE_DAY_ORIGINS_REGION_ID);
  if (!o) throw new Error("ptb: v2 bundle missing required region serviceDayOrigins (0x18)");
  if (o.offset % 8 !== 0) throw new Error("ptb: serviceDayOrigins is not 8-byte aligned");
  const entries = windowDays + 1;
  if (o.length !== entries * 8) {
    throw new Error(`ptb: serviceDayOrigins length ${o.length} != (windowDays + 1) * 8 = ${entries * 8}`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const serviceDayOrigins: number[] = new Array(entries);
  for (let i = 0; i < entries; i++) {
    const v = view.getBigInt64(o.offset + i * 8, true);
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(`ptb: serviceDayOrigins[${i}]=${v} is not a safe integer`);
    }
    const n = Number(v);
    if (i > 0 && n <= serviceDayOrigins[i - 1]!) {
      throw new Error(`ptb: serviceDayOrigins not strictly increasing at ${i}`);
    }
    serviceDayOrigins[i] = n;
  }
  const b = commitmentRegion(
    buf,
    regions,
    BLOCK_DERIVATION_COMMITMENT_REGION_ID,
    "blockDerivationCommitment",
    BLOCK_DERIVATION_COMMITMENT_BYTES,
  );
  const blockDerivationCommitment: PtbBlockDerivationCommitment = {
    algorithmVersion: COMMITMENT_ALGORITHM_V1,
    pairDateCount: readSafeU64(buf, b + 8, "blockDerivationCommitment.pairDateCount"),
    tuplesSha256: hexOf(buf.subarray(b + 16, b + 48)),
  };
  const c = commitmentRegion(
    buf,
    regions,
    COMPATIBILITY_ARTIFACT_COMMITMENT_REGION_ID,
    "compatibilityArtifactCommitment",
    COMPATIBILITY_ARTIFACT_COMMITMENT_BYTES,
  );
  const compatibilityArtifactCommitment: PtbCompatibilityArtifactCommitment = {
    algorithmVersion: COMMITMENT_ALGORITHM_V1,
    v1IdentitySize: readSafeU64(buf, c + 8, "compatibilityArtifactCommitment.v1IdentitySize"),
    v1GzipSize: readSafeU64(buf, c + 16, "compatibilityArtifactCommitment.v1GzipSize"),
    v1IdentitySha256: hexOf(buf.subarray(c + 24, c + 56)),
    v1GzipSha256: hexOf(buf.subarray(c + 56, c + 88)),
  };
  const deriveBlockInseat = (featureFlags & FEATURE_DERIVE_BLOCK_INSEAT) !== 0;
  if (
    !deriveBlockInseat &&
    (blockDerivationCommitment.pairDateCount !== 0 ||
      blockDerivationCommitment.tuplesSha256 !== SHA256_EMPTY_HEX)
  ) {
    throw new Error("ptb: blockDerivationCommitment must be empty when derivation is disabled");
  }
  return {
    serviceDayOrigins,
    deriveBlockInseat,
    blockDerivationCommitment,
    compatibilityArtifactCommitment,
    quarantinedFrequencyTrips: [],
  };
}

/**
 * Decode and validate `0xF8` rows under the v2 contract. Mirrors
 * `pt_core::v2::decode_transfer_v2`: reserved bytes zero, `transfer_type` 0–5,
 * linked rows (4/5) need both trips and may omit stops, every other row needs
 * both stops, type 2 needs `min_transfer_time`, present indices are in range,
 * and a present trip belongs to the present route on the same side. An absent
 * sentinel is never confused with out-of-range corruption.
 * GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
 */
function decodeTransfersV2(
  buf: PtbByteReader,
  region: PtbRegion,
  numStops: number,
  numRoutes: number,
  trips: PtbTrip[],
): PtbTransfer[] {
  if (region.length % TRANSFER_RECORD_BYTES !== 0) {
    throw new Error(`ptb: transfers length ${region.length} is not a multiple of ${TRANSFER_RECORD_BYTES}`);
  }
  const opt = (v: number): number | undefined => (v === TRANSFER_ABSENT ? undefined : v);
  const numRows = region.length / TRANSFER_RECORD_BYTES;
  const out: PtbTransfer[] = new Array(numRows);
  for (let i = 0; i < numRows; i++) {
    const off = region.offset + i * TRANSFER_RECORD_BYTES;
    const bad = (reason: string): Error => new Error(`ptb: v2 transfer row ${i} invalid (${reason})`);
    const fromStopIdx = opt(buf.readUInt32LE(off));
    const toStopIdx = opt(buf.readUInt32LE(off + 4));
    const fromRouteIdx = opt(buf.readUInt32LE(off + 8));
    const toRouteIdx = opt(buf.readUInt32LE(off + 12));
    const fromTripIdx = opt(buf.readUInt32LE(off + 16));
    const toTripIdx = opt(buf.readUInt32LE(off + 20));
    const minTransferSecs = opt(buf.readUInt32LE(off + 24));
    const transferType = buf.readUInt8(off + 28);
    for (let k = 29; k < 32; k++) if (buf.readUInt8(off + k) !== 0) throw bad("reserved_nonzero");
    if (transferType > 5) throw bad("transfer_type");
    if (transferType >= 4) {
      if (fromTripIdx === undefined || toTripIdx === undefined) throw bad("linked_without_trips");
    } else if (fromStopIdx === undefined || toStopIdx === undefined) {
      throw bad("stopless_ordinary");
    }
    if (transferType === 2 && minTransferSecs === undefined) throw bad("type2_without_min");
    for (const s of [fromStopIdx, toStopIdx]) if (s !== undefined && s >= numStops) throw bad("stop_out_of_range");
    for (const r of [fromRouteIdx, toRouteIdx]) if (r !== undefined && r >= numRoutes) throw bad("route_out_of_range");
    for (const t of [fromTripIdx, toTripIdx]) if (t !== undefined && t >= trips.length) throw bad("trip_out_of_range");
    for (const [r, t] of [[fromRouteIdx, fromTripIdx], [toRouteIdx, toTripIdx]] as const) {
      if (r !== undefined && t !== undefined && trips[t]!.routeIdx !== r) throw bad("trip_route_mismatch");
    }
    const row: PtbTransfer = { transferType };
    if (fromStopIdx !== undefined) row.fromStopIdx = fromStopIdx;
    if (toStopIdx !== undefined) row.toStopIdx = toStopIdx;
    if (fromRouteIdx !== undefined) row.fromRouteIdx = fromRouteIdx;
    if (toRouteIdx !== undefined) row.toRouteIdx = toRouteIdx;
    if (fromTripIdx !== undefined) row.fromTripIdx = fromTripIdx;
    if (toTripIdx !== undefined) row.toTripIdx = toTripIdx;
    if (minTransferSecs !== undefined) row.minTransferSecs = minTransferSecs;
    out[i] = row;
  }
  return out;
}
