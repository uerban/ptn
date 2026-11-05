//! Region-ID constants + a `no_std`-clean id->name lookup.
//!
//! These IDs are the FROZEN region-ID registry (`docs/ptb-region-ids.md` §4).
//! The registry doc is the single source of truth; the
//! consts here mirror it and a parse-test (`tests/registry_ids.rs`) gates that
//! they keep agreeing. Names are **lowerCamel**, consistent with the carry
//! `Region::name()` convention (`header.rs`) and the loader's `RegionName`.

/// `WindowMeta` — the cold container region carrying `windowDays u16`
/// outside the header prefix (`0x01`, `docs/ptb-region-ids.md` §4,
/// FROZEN registry; container band `0x01–0x03`, min size 2 bytes).
///
/// **Unlike `0xFA`** (a carry-band id that is NOT in the frozen registry and
/// retires into `0x12 PatternSemantics`), `0x01` IS in the FROZEN registry — a
/// permanent allocation, not transitional.
pub const WINDOW_META: u16 = 0x01;

/// `StopsSoA` — hot stop columns (`0x40`, FROZEN 2026-06-04).
pub const STOPS_SOA: u16 = 0x40;
/// `RoutesSoA` — hot route columns (`0x41`, FROZEN 2026-06-04).
pub const ROUTES_SOA: u16 = 0x41;
/// `StopIndex` — persisted sorted stop-id index (`0x44`). Re-exported from
/// `stop_index` so there is a single definition.
pub use crate::stop_index::REGION_ID as STOP_INDEX;

/// `ServiceBitfieldPool` — deduped distinct service day-vectors (`0x15`, FROZEN
/// registry; `docs/ptb-region-ids.md` §4, hot, align 1). Each entry
/// is a `ceil(windowDays/8)`-byte day-vector; `0x16 ServiceToBitfield` maps each
/// service to an index into this pool. Mandatory.
pub const SERVICE_BITFIELD_POOL: u16 = 0x15;

/// `ServiceToBitfield` — per-service index into `0x15 ServiceBitfieldPool`
/// (`0x16`, FROZEN registry; `docs/ptb-region-ids.md` §4, hot,
/// align 4): `numServices u32` then one `u32` bitfield-pool index per service.
/// Mandatory.
pub const SERVICE_TO_BITFIELD: u16 = 0x16;

/// `Frequencies` — GTFS `frequencies.txt` rows keyed on `TripMeta 0x14` index
/// (`0x17`, FROZEN registry; `docs/ptb-region-ids.md` §4, hot,
/// align 4). Carries GTFS frequencies.txt rows; keyed on TripMeta
/// (0x14) index. Emitted omit-empty; decoded by both the Rust reader and the TS
/// loader.
pub const FREQUENCIES: u16 = 0x17;

/// `ServiceDayOrigins` — PTB v2 mandatory per-civil-date GTFS time origins
/// (`0x18`, time band beside `0x17`; align 8): `effectiveWindowDays + 1`
/// little-endian `i64` Unix seconds, entry `i` = local noon minus 43,200 SI
/// seconds on `feedStartDate + i` in the feed's `agency_timezone`. The last entry
/// is the exclusive next-date origin and is not a routable date. Strictly
/// increasing. GTFS `Time`: https://gtfs.org/documentation/schedule/reference/#field-types
pub const SERVICE_DAY_ORIGINS: u16 = 0x18;

/// `BlockDerivationCommitment` — PTB v2 mandatory cold commitment (`0x19`, align
/// 8, exactly 48 B): `algorithm_version u16 = 1`, 6 reserved zero bytes,
/// `pair_date_count u64`, `tuples_sha256 [u8; 32]` over the sorted fixed-width
/// `(source_trip u32, service_date_ordinal u32, target_trip u32)` LE tuples the
/// date-gated `block_id` derivation produces. Every `Index::build` recomputes and
/// compares it before routing.
pub const BLOCK_DERIVATION_COMMITMENT: u16 = 0x19;

/// `CompatibilityArtifactCommitment` — PTB v2 mandatory cold commitment (`0x1A`,
/// align 8, exactly 88 B): `algorithm_version u16 = 1`, 6 reserved zero bytes,
/// `v1_identity_size u64`, `v1_gzip_size u64`, `v1_identity_sha256 [u8; 32]`,
/// `v1_gzip_sha256 [u8; 32]`. Binds the deterministic v1 compatibility bytes into
/// the authoritative v2 hash and generation id.
pub const COMPATIBILITY_ARTIFACT_COMMITMENT: u16 = 0x1A;

// ── Pattern-major band (B1) ───────────────────────────────────────────────────
// The frozen-registry homes for the pattern-major timetable (`docs/ptb-region-ids.md` §4). Real FROZEN-registry ids (read
// via `region_by_id`, NOT carries), so they are NOT in `header::CARRY_REGIONS`.
// The published bundle carries the band as its only timetable; the producer's
// staging bundle carries none.

/// `Patterns` — per-pattern stop offset/count/flags (`0x10`, FROZEN registry §4,
/// hot, align 4). `flags.bit0`=all-regular (semantics OMITTED),
/// `bit1`=has stop_headsign, `bit2`=has seq-override (`PatternStopSeq`); `[7]`
/// reserved. (The dense-vs-ragged `TripTimes` selector is NOT a `Patterns` flag —
/// see `TRIP_TIMES`.)
pub const PATTERNS: u16 = 0x10;

/// `PatternStops` — shared `u32` stop-ordinal column referenced by `Patterns`
/// offset/count slices (`0x11`, FROZEN registry §4, hot, align 4).
pub const PATTERN_STOPS: u16 = 0x11;

/// `PatternSemantics` — packed `pickup_type`/`drop_off_type`/`timepoint` per
/// pattern-stop (`0x12`, FROZEN registry §4, hot, align 1); OMITTED
/// when a pattern is all-regular (`Patterns.flags.bit0`). The `0xFA`
/// `StopTimeBoarding` staging carry is folded in here at encode time.
pub const PATTERN_SEMANTICS: u16 = 0x12;

/// `TripTimes` — per-trip `trip_first_dep u32` + fixed-width `i16` dep/dwell
/// deltas + `served_bits` (`0x13`, FROZEN registry §4, hot, align
/// 8). `entryFlags` bit1 selects i32 deltas; bit0 reserves the unsupported
/// ragged variant.
pub const TRIP_TIMES: u16 = 0x13;

/// `TripMeta` — per-trip route/service/direction/wheelchair/`bikes_allowed`/
/// `block_id` carry (`0x14`, FROZEN registry §4, hot, align 4).
pub const TRIP_META: u16 = 0x14;

/// `PatternsAtStop` — CSR `sr_offsets[stops+1]` + `sr_values` (pattern ordinals),
/// replacing `routesAtStop` (`0x45`, FROZEN registry §4, hot, align
/// 4).
pub const PATTERNS_AT_STOP: u16 = 0x45;

/// `PatternTrips` — CSR `pt_offsets[patterns+1]` + trip ordinals (`0x46`, FROZEN
/// registry §4, hot, align 4).
pub const PATTERN_TRIPS: u16 = 0x46;

/// `StopTimeBoarding` — staging carry region (`0xFA`): one packed byte
/// per stop_time (pickup_type[1:0], drop_off_type[3:2], continuous_pickup[5:4],
/// continuous_drop_off[7:6]; default 0x50). Rides the high carry band (the
/// `0xF2+` region-id range, same band as the carried StopTimes `0xF4`); `0xFA`
/// is the next free id after the `0xF2–0xF8` carries. NOT in the FROZEN registry
/// (docs/ptb-region-ids.md §4); the producer strips it once `0x12
/// PatternSemantics` is derived.
pub const STOP_TIME_BOARDING: u16 = 0xFA;

/// lowerCamel region name for a registry region id, or `"unknown"`.
///
/// `no_std`-clean: a pure `match` returning a `&'static str`. Only the ids that
/// pt-core defines as consts (the SoA `0x40`/`0x41`/`0x44`, the pool pair
/// `0x15`/`0x16`, the B1 pattern band `0x10`–`0x14`/`0x45`/`0x46`, the
/// frequencies `0x17`, and the transitional `0x01`/`0xFA`) are named here;
/// everything else maps to `"unknown"`.
pub fn region_name_by_id(id: u16) -> &'static str {
    match id {
        WINDOW_META => "windowMeta",
        STOPS_SOA => "stopsSoA",
        ROUTES_SOA => "routesSoA",
        STOP_INDEX => "stopIndex",
        SERVICE_BITFIELD_POOL => "serviceBitfieldPool",
        SERVICE_TO_BITFIELD => "serviceToBitfield",
        FREQUENCIES => "frequencies",
        SERVICE_DAY_ORIGINS => "serviceDayOrigins",
        BLOCK_DERIVATION_COMMITMENT => "blockDerivationCommitment",
        COMPATIBILITY_ARTIFACT_COMMITMENT => "compatibilityArtifactCommitment",
        PATTERNS => "patterns",
        PATTERN_STOPS => "patternStops",
        PATTERN_SEMANTICS => "patternSemantics",
        TRIP_TIMES => "tripTimes",
        TRIP_META => "tripMeta",
        PATTERNS_AT_STOP => "patternsAtStop",
        PATTERN_TRIPS => "patternTrips",
        STOP_TIME_BOARDING => "stopTimeBoarding",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_lower_camel() {
        assert_eq!(region_name_by_id(0x40), "stopsSoA");
        assert_eq!(region_name_by_id(0x41), "routesSoA");
        assert_eq!(region_name_by_id(0x44), "stopIndex");
    }

    #[test]
    fn unknown_id_is_unknown() {
        assert_eq!(region_name_by_id(0x99), "unknown");
    }

    #[test]
    fn consts_match_frozen_registry() {
        assert_eq!(WINDOW_META, 0x01);
        assert_eq!(STOPS_SOA, 0x40);
        assert_eq!(ROUTES_SOA, 0x41);
        assert_eq!(STOP_INDEX, 0x44);
        assert_eq!(STOP_TIME_BOARDING, 0xFA);
        // ServiceBitfieldPool / ServiceToBitfield ids + names. The
        // Align column (0x15 -> 1, 0x16 -> 4) is asserted against the frozen
        // doc itself in `tests/registry_ids.rs` (this module has no align data).
        assert_eq!(SERVICE_BITFIELD_POOL, 0x15);
        assert_eq!(
            region_name_by_id(SERVICE_BITFIELD_POOL),
            "serviceBitfieldPool"
        );
        assert_eq!(SERVICE_TO_BITFIELD, 0x16);
        assert_eq!(region_name_by_id(SERVICE_TO_BITFIELD), "serviceToBitfield");
        // B1.0: the pattern-major band ids + names (allocated, not yet emitted/
        // decoded — B1.1+). The Align column for each is asserted against the
        // frozen doc itself in `tests/registry_ids.rs` (this module has no align
        // data): 0x10/0x11/0x14/0x45/0x46 align 4, 0x12 align 1, 0x13 align 8.
        assert_eq!(PATTERNS, 0x10);
        assert_eq!(region_name_by_id(PATTERNS), "patterns");
        assert_eq!(PATTERN_STOPS, 0x11);
        assert_eq!(region_name_by_id(PATTERN_STOPS), "patternStops");
        assert_eq!(PATTERN_SEMANTICS, 0x12);
        assert_eq!(region_name_by_id(PATTERN_SEMANTICS), "patternSemantics");
        assert_eq!(TRIP_TIMES, 0x13);
        assert_eq!(region_name_by_id(TRIP_TIMES), "tripTimes");
        assert_eq!(TRIP_META, 0x14);
        assert_eq!(region_name_by_id(TRIP_META), "tripMeta");
        assert_eq!(PATTERNS_AT_STOP, 0x45);
        assert_eq!(region_name_by_id(PATTERNS_AT_STOP), "patternsAtStop");
        assert_eq!(PATTERN_TRIPS, 0x46);
        assert_eq!(region_name_by_id(PATTERN_TRIPS), "patternTrips");
        // Frequencies id + name (decoded by both engines).
        // The Align column (0x17 -> 4) is asserted against the frozen doc itself in
        // `tests/registry_ids.rs` (this module has no align data).
        assert_eq!(FREQUENCIES, 0x17);
        assert_eq!(region_name_by_id(FREQUENCIES), "frequencies");
        // PTB v2 (temporal/transfer foundation): the 0x18-0x1A allocations.
        assert_eq!(SERVICE_DAY_ORIGINS, 0x18);
        assert_eq!(region_name_by_id(SERVICE_DAY_ORIGINS), "serviceDayOrigins");
        assert_eq!(BLOCK_DERIVATION_COMMITMENT, 0x19);
        assert_eq!(
            region_name_by_id(BLOCK_DERIVATION_COMMITMENT),
            "blockDerivationCommitment"
        );
        assert_eq!(COMPATIBILITY_ARTIFACT_COMMITMENT, 0x1A);
        assert_eq!(
            region_name_by_id(COMPATIBILITY_ARTIFACT_COMMITMENT),
            "compatibilityArtifactCommitment"
        );
    }

    #[test]
    fn window_meta_is_named() {
        assert_eq!(WINDOW_META, 0x01);
        assert_eq!(region_name_by_id(WINDOW_META), "windowMeta");
    }
}
