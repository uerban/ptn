use alloc::string::String;
use core::sync::atomic::{AtomicU64, Ordering};
use hashbrown::HashMap;
use rustc_hash::FxBuildHasher;

use crate::error::{PtbError, Result};
use crate::header::{Header, Region, RegionEntry};
use crate::records::*;
use crate::strpool::StringPool;

/// One decoded `0x17 Frequencies` row (`no_std`-compatible; decoded on demand
/// from the mmap bytes by [`Reader::frequencies_for_trip`]).
///
/// Wire layout (16 B/row):
/// `[0..4]  tripIdx     u32 LE`
/// `[4..8]  startSecs   u32 LE`
/// `[8..12] endSecs     u32 LE  (half-open, EXCLUDED per GTFS spec)`
/// `[12..14] headwaySecs u16 LE`
/// `[14]    exactTimes  u8`
/// `[15]    reserved    u8`
///
/// GTFS reference: <https://gtfs.org/documentation/schedule/reference/#frequenciestxt>
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrequencyRecord {
    pub trip_idx: u32,
    pub start_secs: u32,
    /// Half-open end (EXCLUDED): last departure is the largest
    /// `start_secs + n * headway_secs` that is strictly less than `end_secs`.
    pub end_secs: u32,
    pub headway_secs: u16,
    /// `0` = inexact (frequency-based), `1` = exact (schedule-based).
    pub exact_times: u8,
}

/// Zero-copy iterator returned by [`Reader::frequencies_for_trip`].
///
/// Decodes 16 B/row lazily from the backing bytes in the contiguous range
/// `[idx, end)` of the `0x17 Frequencies` region body (which starts at `off`
/// — the byte offset of `rows[0]`, AFTER the 4-byte count prefix). `no_std`.
pub struct FrequencyIter<'a> {
    bytes: &'a [u8],
    /// Byte offset of `rows[0]` within `bytes` (i.e. `region_offset + 4`).
    off: usize,
    /// Current row index within the trip's contiguous run.
    idx: usize,
    /// One-past-the-last row index in the trip's run.
    end: usize,
}

impl Iterator for FrequencyIter<'_> {
    type Item = FrequencyRecord;

    fn next(&mut self) -> Option<FrequencyRecord> {
        if self.idx >= self.end {
            return None;
        }
        let o = self.off + self.idx * 16;
        self.idx += 1;
        // The region was bounds-checked at load time (Header::parse +
        // from_bytes); these reads are always in-range for a valid bundle.
        let trip_idx = u32::from_le_bytes(self.bytes[o..o + 4].try_into().ok()?);
        let start_secs = u32::from_le_bytes(self.bytes[o + 4..o + 8].try_into().ok()?);
        let end_secs = u32::from_le_bytes(self.bytes[o + 8..o + 12].try_into().ok()?);
        let headway_secs = u16::from_le_bytes(self.bytes[o + 12..o + 14].try_into().ok()?);
        let exact_times = *self.bytes.get(o + 14)?;
        Some(FrequencyRecord {
            trip_idx,
            start_secs,
            end_secs,
            headway_secs,
            exact_times,
        })
    }
}

/// Bit `day` of a per-service bitmask slice (LSB-first within each byte).
///
/// `byte = day/8`, `bit = day%8`, LSB-first within each byte. Worked example:
/// the tiny fixture's service 0 byte1 is `0xA1` = `1010_0001`; day 13 maps to
/// byte1 bit5, and `(0xA1 >> 5) & 1 == 1` → active.
#[inline]
pub fn service_active_bit(bitmask: &[u8], day: u32) -> bool {
    let byte = (day / 8) as usize;
    let bit = (day % 8) as u8;
    bitmask.get(byte).is_some_and(|b| (b >> bit) & 1 == 1)
}

/// `0x13 TripTimes` `entryFlags` bit0 reserves the ragged variant.
/// Readers reject this unsupported variant at load time.
pub const TRIP_TIMES_FLAG_RAGGED: u16 = 1 << 0;
/// `0x13 TripTimes` `entryFlags` bit1 = the `i32`-DELTA variant selector (the
/// intercity-Paris on-ramp for trip spans > the `i16` ±32767 s cap). SUPPORTED:
/// the `i32` (4-byte) deltas decode like the `i16` (2-byte) ones — the width
/// rides in `BandSlab::delta_bytes` (see [`delta_bytes_for_flags`]).
pub const TRIP_TIMES_FLAG_I32_DELTAS: u16 = 1 << 1;

/// The CANONICAL `0x13 TripTimes` delta width (bytes per dep/dwell element) for
/// a region whose `entryFlags` are `entry_flags`: `4` when the `i32`-delta
/// variant is declared (bit1, [`TRIP_TIMES_FLAG_I32_DELTAS`]), else `2` (the
/// BYTE-IDENTICAL `i16` layout). REGION-level — one width sizes every pattern's
/// dep/dwell stride. This is the SINGLE flag->width mapping; both the band-slab
/// resolver ([`Reader::trip_times_delta_bytes`]) and the load-time band gate
/// ([`resolve_pattern_band`]) call it so the two can never disagree (a TS twin
/// mirrors this one mapping).
#[inline]
pub(crate) fn delta_bytes_for_flags(entry_flags: u16) -> usize {
    if entry_flags & TRIP_TIMES_FLAG_I32_DELTAS != 0 {
        4
    } else {
        2
    }
}

/// `0x10 Patterns` `flags` bit0 — the pattern is all-regular ⇒ its `0x12
/// PatternSemantics` bytes are OMITTED (it contributes zero bytes to the `0x12`
/// region). Mirrors `pattern_emit::FLAG_ALL_REGULAR` (the producer half); the
/// B1.5 `0x12` decode (`band_semantics_byte`) reads this to compute the
/// per-pattern offset and to short-circuit an all-regular pattern to the regular
/// default. Spec: the b1 1 pattern band locked layout notes.
pub const PATTERN_FLAG_ALL_REGULAR: u8 = 1 << 0;

/// The GTFS-default packed `0x12 PatternSemantics` byte: regular pickup
/// (`pickup_type 0`), regular drop-off (`drop_off_type 0`), not timepoint-only.
/// Returned by `band_semantics_byte` when a pattern is all-regular or the `0x12`
/// region is omitted. Mirrors `pattern_emit::SEMANTICS_REGULAR`.
pub const SEMANTICS_REGULAR: u8 = 0x00;

/// The B1.5 band time-decode "not served" sentinel — a position the trip does NOT
/// serve. Identical to `scan::dep_secs_at`'s `pos_to_row == -1` sentinel
/// (`scan.rs:325-337`), so band-decoded times are directly comparable to the flat
/// carry. (The flat `0xF4` "no departure" dep value is `DEP_SECS_NOT_SERVED`
/// `= 0xFFFF_FFFF`; the SCAN maps that to `-1` — this is the scan-facing sentinel.)
pub const BAND_NOT_SERVED: i64 = -1;

/// A validated `(start_byte, len_in_u32)` range of a packed `u32` sub-array
/// inside the CSR (or TripStarts) region. `start` is a byte offset into the
/// backing `bytes`; `len` counts u32s. The cast to `&[u32]` happens lazily in
/// the accessor via `try_cast_slice` — never stored decoded.
#[derive(Debug, Clone, Copy)]
struct U32Range {
    start: usize,
    len: usize,
}

/// Where `Reader::stop_index` resolves a `stop_id` from.
///
/// `Persisted` is the mmap win: a byte range of the bundle's
/// StopIndex region (`stop_index::REGION_ID`), looked up lazily via
/// `stop_index::lookup` with NO eager structure built at load. `Eager` is the
/// `HashMap<String,u32>` rebuilt at construction for a bundle that lacks the
/// region (the region is a regenerable cache derived from the lossless stops,
/// so its absence is safe).
enum StopIndexSource {
    Eager(HashMap<String, u32, FxBuildHasher>),
    Persisted { offset: usize, length: usize },
}

/// Validated byte ranges of the `StopsSoA` (`0x40`) typed columns, in the FROZEN order
/// (`docs/ptb-region-ids.md` §4): four `u32`/`i32` columns first, the `u8` column last. Each range
/// is bounds-checked against the backing buffer at resolution; the zero-copy cast happens lazily
/// per accessor. `wheelchair` is the byte offset of the `u8` column start (one byte per stop).
#[derive(Clone, Copy)]
struct StopsSoa {
    id_idx: U32Range,
    name_idx: U32Range,
    lat_e7: U32Range,
    lon_e7: U32Range,
    parent_idx: U32Range,
    wheelchair: usize,
}

/// Validated byte ranges of the `RoutesSoA` (`0x41`) typed columns: six `u32`
/// idx columns then the `u16 route_type` column (last). `route_type` is the byte
/// offset of the `u16` column start (two bytes per route).
#[derive(Clone, Copy)]
struct RoutesSoa {
    id_idx: U32Range,
    agency_idx: U32Range,
    short_idx: U32Range,
    long_idx: U32Range,
    color_idx: U32Range,
    text_color_idx: U32Range,
    route_type: usize,
}

/// One decoded `0x10 Patterns` record (B1.2 Task A). `stops_off` is an ELEMENT
/// index into the `0x11 PatternStops` column (NOT a byte offset — locked-layout
/// Decision 2); `stop_count` is the number of pattern positions; `flags` is the
/// packed `0x10` flag byte (`bit0`=all-regular, `bit1`=has stop_headsign,
/// `bit2`=has seq-override). Spec: the b1 1 pattern band locked layout notes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PatternRec {
    /// ELEMENT index into the `0x11 PatternStops` `u32` column.
    pub stops_off: u32,
    /// Number of pattern positions (entries this pattern reads from `0x11`).
    pub stop_count: u16,
    /// Packed `0x10` flag byte (bit0=all-regular, bit1=headsign, bit2=seq-override).
    pub flags: u8,
}

/// The pattern band (`0x10`-`0x14` / `0x45`/`0x46`) region entries, resolved
/// and gated ONCE in `from_bytes` (B1.2 Task A). Present only when the bundle
/// actually carries the band (`0x10` resolved); a band-less (staging) bundle
/// leaves `Reader::pattern_band` as `None`, and `Index::build` dispatches
/// between the band and the flat-carry path. Mirrors the optional
/// `boarding_off` / `service_pool` resolution: cache the validated `RegionEntry`
/// per region, decode zero-copy in the accessors — no eager `Vec`s.
///
/// `0x12 PatternSemantics` is OMITTED when every pattern is all-regular, so it is
/// an `Option`. The other six are always present once the band exists.
#[derive(Clone, Copy)]
struct PatternBand {
    patterns: RegionEntry,                  // 0x10
    pattern_stops: RegionEntry,             // 0x11
    pattern_semantics: Option<RegionEntry>, // 0x12 (omit-when-all-regular)
    trip_times: RegionEntry,                // 0x13
    trip_meta: RegionEntry,                 // 0x14
    patterns_at_stop: RegionEntry,          // 0x45 CSR
    pattern_trips: RegionEntry,             // 0x46 CSR
    /// `0x10.count` == number of patterns (== `0x46` CSR offsets length − 1).
    num_patterns: usize,
}

/// A pattern's `0x13 TripTimes` slab resolved ONCE (B1.5-T2 hot-path hoist).
///
/// The per-call decoders ([`Reader::band_dep_secs`] etc.) re-resolve `trip_times(p)`
/// — an O(p) walk that sums every earlier pattern's slab span — on EVERY position.
/// The scan reads many positions per trip, so it instead resolves this ONCE per
/// trip at index-build time ([`Reader::band_trip_times_slab`]) and decodes each
/// position with O(1) slice math ([`Reader::band_dep_at`]/[`Reader::band_arr_at`]).
/// `slab_off` is the ABSOLUTE byte offset of the pattern's slab within the reader
/// bytes; `big_t`/`s` are its trip/stop dims (the `0x13` layout is
/// `trip_first_dep[T] u32 · dep_deltas[T][S] · dwell_deltas[T][S] ·
/// served_bits[T][ceil(S/8)]`, the dep/dwell deltas `delta_bytes` wide each — 2
/// for `i16`, 4 for the i32-delta variant). All `usize`s — no borrow, so it
/// lands on `RouteTrip` without a lifetime. The resolver returns `None` only for
/// the ragged `0x13` (still unsupported); the i32-delta variant IS resolved (the
/// width rides in `delta_bytes`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BandSlab {
    /// Absolute byte offset of this pattern's `0x13` slab within the reader bytes.
    pub slab_off: usize,
    /// Trip count `T` of this band pattern (== `pattern_trips(p).len()`).
    pub big_t: usize,
    /// Stop count `S` of this band pattern (== `pattern_stops(p).len()`).
    pub s: usize,
    /// Byte offset (within the slab) of `dep_deltas[0][0]`.
    pub dep_off: usize,
    /// Byte offset (within the slab) of `dwell_deltas[0][0]`.
    pub dwell_off: usize,
    /// Byte offset (within the slab) of `served_bits[0][0]`.
    pub served_off: usize,
    /// Width of ONE delta element in bytes — `2` for the `i16` layout, `4` for
    /// the `i32`-delta variant (REGION-level, from the `0x13` entryFlags bit1).
    /// The dep/dwell decoders read at this width.
    pub delta_bytes: usize,
}

/// Owns the backing bytes; `'static + Send + Sync` so `Arc<Reader<B>>` fits
/// P3's arc-swap. `B` = `Vec<u8>` (tests/wasm) or `Arc<Mmap>`-newtype (pt-serve).
///
/// LAZY decode: holds only `bytes`, the parsed `header`, the four validated CSR
/// ranges, and the eager `stop_index` (the one structure the format lacks on
/// disk). No decoded record `Vec`s — records decode on demand, CSR arrays are
/// zero-copy `&[u32]` views.
pub struct Reader<B: AsRef<[u8]>> {
    bytes: B,
    header: Header,
    /// CSR sub-array ranges, computed + validated once in `from_bytes`. On a
    /// carry-LESS band bundle (B1.5-T4a) these point at the now-stripped
    /// (zero-length) carry slots and are NEVER read — the `trip_starts()` /
    /// `route_trips()` accessors take the `synth_*` arrays below instead.
    trip_starts: U32Range,
    rt_offsets: U32Range,
    rt_values: U32Range,
    sr_offsets: U32Range,
    sr_values: U32Range,
    /// B1.5-T4a carry-less: the small structural arrays re-materialized from the
    /// band at load when the flat `0xF4`/`0xF5`/`0xF6` carry is stripped (Approach
    /// A). `None` on every carry-BEARING bundle (the byte-unchanged path) — the
    /// `U32Range` views above are used there. When `Some`, `trip_starts()` /
    /// `route_trips()` read these owned `Vec`s. NOT the timetable: times stay in
    /// `0x13` (the load-CPU/RSS win survives — only kilobyte-scale route→trips +
    /// per-trip prefix-sum metadata is re-materialized). `synth_trip_starts` is a
    /// `(num_trips+1)` prefix-sum of per-trip band POSITION counts (self-consistent
    /// `last == num_stop_times`, used only for `build_from_band`'s Pin-6 monotonic
    /// /length validation — never to index a flat stop-time row, which no longer
    /// exists). `synth_rt_offsets`/`synth_rt_values` are the route→trips CSR
    /// inverted from each trip's `0xF2 TripsIntern` `route_idx` (the trip→route
    /// backref, which is NOT a stripped carry).
    synth_trip_starts: Option<alloc::vec::Vec<u32>>,
    synth_rt_offsets: Option<alloc::vec::Vec<u32>>,
    synth_rt_values: Option<alloc::vec::Vec<u32>>,
    /// stopId → stop ordinal. Without a persisted StopIndex region this is the
    /// eager `HashMap` rebuilt at construction; with one it is a lazy byte-range
    /// lookup with no load-time rebuild. See [`StopIndexSource`].
    stop_index: StopIndexSource,
    /// The `0x40 StopsSoA` / `0x41 RoutesSoA` column ranges, resolved and
    /// validated once in `from_bytes`.
    stops_soa: StopsSoa,
    routes_soa: RoutesSoa,
    /// Byte offset of the optional `StopTimeBoarding` (0xFA) column, or `None`
    /// when absent (⇒ every stop_time defaults to 0x50). Resolved + length-validated in `from_bytes`.
    boarding_off: Option<usize>,
    /// Byte offset and row count of the optional `0x17 Frequencies` region, or
    /// `None` when absent (feeds with no `frequencies.txt` rows).
    /// Resolved in `from_bytes`; the accessor [`Reader::frequencies_for_trip`]
    /// binary-searches on `tripIdx` over the sorted 16 B/row region body.
    frequencies_off: Option<usize>,
    frequencies_count: usize,
    /// Service-bitfield storage, resolved ONCE in `from_bytes` so
    /// `service_bitmask` slices the pool without a per-call `region_by_id` scan
    /// (that scan would be a hot-path regression). BOTH regions MUST resolve —
    /// absence is a hard `ServiceBitfieldPoolInvalid` (C3). `service_pool` is the
    /// `0x15 ServiceBitfieldPool` entry (`count u32` prefix then
    /// `count × bytes_per_service` distinct bitfields); `service_to_bitfield` is
    /// the `0x16 ServiceToBitfield` entry (`num_services × u32` pool indices).
    service_pool: RegionEntry,
    service_to_bitfield: RegionEntry,
    /// Pattern band (`0x10`-`0x14` / `0x45`/`0x46`), resolved + gated ONCE in
    /// `from_bytes` (B1.2 Task A). `None` for a bundle that omits the band
    /// (`0x10` absent — `Index::build` then takes the flat-carry path).
    /// When `Some`, every gate in `resolve_pattern_band` passed, so the accessors
    /// (`patterns`/`pattern_stops`/`trip_times`/`pattern_trips`/`patterns_at_stop`)
    /// are panic-free reads. See [`PatternBand`].
    pattern_band: Option<PatternBand>,
    /// Service-bitmask window length (days), from the header's `0x01 WindowMeta`
    /// region (default 90 when absent). The window guard in `service_active_on`
    /// reads this runtime value — NOT a fixed 90-day window — so a non-90 window
    /// resolves in-window far-future days correctly.
    window_days: u16,
    /// Per-service bitmask stride = `bytes_per_service(window_days)`, derived once
    /// at construction. The exact-size capacity gate AND the per-service slice
    /// both use this runtime value (NOT a fixed 12-byte stride).
    bytes_per_service: usize,
    /// Cumulative `stop_index` lookups served (observability; see
    /// `stop_index_lookups`). `AtomicU64` for `&self` interior mutability while
    /// keeping `Reader: Sync` (the `Arc`-swap requirement); `Relaxed` is fine —
    /// a monotonic counter with no ordering dependency on other state.
    lookups: AtomicU64,
    /// PTB v2 mandatory regions (`0x18`/`0x19`/`0x1A`), resolved and validated
    /// once in `from_bytes`. `None` on a v1 bundle.
    v2: Option<crate::v2::V2Regions>,
}

// Compile-time guarantee that `Reader<Vec<u8>>` is `Send + Sync + 'static` so
// P3's `Arc<Reader>` arc-swap requirement is enforced structurally, not left to
// emerge from the `impl` bound. A regression (e.g. adding a non-Send field)
// fails the build here, not downstream in pt-serve.
const _: fn() = || {
    fn assert_send_sync_static<T: Send + Sync + 'static>() {}
    assert_send_sync_static::<Reader<alloc::vec::Vec<u8>>>();
};

impl<B: AsRef<[u8]> + Send + Sync + 'static> Reader<B> {
    pub fn from_bytes(bytes: B) -> Result<Reader<B>> {
        let buf = bytes.as_ref();
        let header = Header::parse(buf)?;

        // Transient pool view used only during construction (for stop_index).
        let pool = pool_view(buf, &header)?;

        // Per-service bitmask stride from the runtime window (the `0x01 WindowMeta`
        // region, default 90 ⇒ 12 bytes). This is the consumer-first half of the
        // ordering invariant: the reader handles a non-90 stride BEFORE any
        // producer emits one. Both the capacity gate and the per-service slice use
        // this runtime stride, NOT a fixed 12-byte stride.
        let bytes_per_service = crate::bytes_per_service(header.window_days);

        // Service-bitfield storage. Resolve + cache the `0x15`
        // ServiceBitfieldPool and `0x16` ServiceToBitfield entries ONCE so
        // `service_bitmask` slices them without a per-call `region_by_id` scan.
        // C3: BOTH regions MUST be present — absence is a hard
        // `ServiceBitfieldPoolInvalid`, NOT a default-empty like the optional
        // `0xFA`.
        let (service_pool, service_to_bitfield) = {
            let pool = header
                .region_by_id(crate::region_ids::SERVICE_BITFIELD_POOL)
                .ok_or(PtbError::ServiceBitfieldPoolInvalid { reason: "absent" })?;
            let s2b = header
                .region_by_id(crate::region_ids::SERVICE_TO_BITFIELD)
                .ok_or(PtbError::ServiceBitfieldPoolInvalid { reason: "absent" })?;
            // `Header::parse` already bounds-checks every tagged-table region
            // against the buffer, so both entries are addressable here.
            //
            // Step 2 (B2) load-time gates. Step 1 left a malformed pool
            // silently-empty (`service_bitmask` returns `&[]`); these turn each
            // such shape into a HARD `ServiceBitfieldPoolInvalid` so a corrupt
            // bundle never decodes to inactive-everywhere. `S = bytes_per_service`
            // is the runtime stride from the `0x01 WindowMeta` window (resolved
            // above); `checked_*` keeps the math sound on wasm32 (`usize == u32`).
            let num_services = header.num_services as usize;
            // `0x15` length MUST be exactly `4 + count*S` (count u32 prefix + count
            // distinct S-byte bitfields). `count` reads the first 4 bytes of the
            // pool body (in-bounds: `Header::parse` validated the region range).
            let count = rd_u32(buf, pool.offset)? as usize;
            let pool_need = count
                .checked_mul(bytes_per_service)
                .and_then(|b| b.checked_add(4))
                .ok_or(PtbError::ServiceBitfieldPoolInvalid {
                    reason: "pool_length",
                })?;
            if pool.length != pool_need {
                return Err(PtbError::ServiceBitfieldPoolInvalid {
                    reason: "pool_length",
                });
            }
            // `0x16` length MUST be exactly `num_services*4` (one u32 pool index
            // per service).
            let index_need =
                num_services
                    .checked_mul(4)
                    .ok_or(PtbError::ServiceBitfieldPoolInvalid {
                        reason: "index_length",
                    })?;
            if s2b.length != index_need {
                return Err(PtbError::ServiceBitfieldPoolInvalid {
                    reason: "index_length",
                });
            }
            // C2: the empty-pool rule is a BICONDITIONAL — `count == 0` is permitted
            // IFF `num_services == 0`. Both asymmetries are hard errors (checked
            // BEFORE the index loop so this distinct reason fires rather than
            // `index_oob`):
            //   - `count == 0 && num_services > 0`: services with no bitfield to map.
            //   - `num_services == 0 && count > 0`: an orphaned pool — non-empty
            //     bitfield storage that no `ServiceToBitfield` entry can ever point
            //     at (the index loop below runs zero times, so it can't catch this).
            if (count == 0) != (num_services == 0) {
                return Err(PtbError::ServiceBitfieldPoolInvalid {
                    reason: "empty_pool",
                });
            }
            // Every `ServiceToBitfield[s]` MUST be `< count` so the hot-path
            // `service_bitmask` pool-index read is provably in-range. Bounded loop
            // over the cached `0x16` body (LE u32 per service); both region ranges
            // are in-bounds (validated above + by `Header::parse`).
            for s in 0..num_services {
                let idx = rd_u32(buf, s2b.offset + s * 4)? as usize;
                if idx >= count {
                    return Err(PtbError::ServiceBitfieldPoolInvalid {
                        reason: "index_oob",
                    });
                }
            }
            (pool, s2b)
        };

        // The `StopsSoA` (0x40) / `RoutesSoA` (0x41) regions are mandatory; a
        // bundle missing either is malformed (`MissingRequiredRegion`).
        // Resolution validates the column ranges (incl. the coord range).
        let stops_soa = match header.region_by_id(crate::region_ids::STOPS_SOA) {
            Some(e) => resolve_stops_soa(buf, e, header.num_stops as usize)?,
            None => return Err(PtbError::MissingRequiredRegion { region: "stopsSoA" }),
        };
        let routes_soa = match header.region_by_id(crate::region_ids::ROUTES_SOA) {
            Some(e) => resolve_routes_soa(buf, e, header.num_routes as usize)?,
            None => {
                return Err(PtbError::MissingRequiredRegion {
                    region: "routesSoA",
                })
            }
        };

        // StopTimes are four SoA columns: validate the 4-aligned offset and the
        // tight 12*N length here so `stop_time` needs no per-call checks.
        resolve_stop_times_soa(buf, &header)?;

        // Optional StopTimeBoarding (0xFA): exactly one packed byte per stop_time
        // (pickup/drop-off/continuous bits; default 0x50). Absent ⇒ every
        // stop_time defaults to 0x50. Validate the length matches `num_stop_times` and the region is
        // addressable so the `boarding_byte(i)` accessor is a single in-bounds read.
        let n_st = header.region(Region::StopTimes).length / STOP_TIME_ROW_BYTES;
        let boarding_off = match header.region_by_id(crate::region_ids::STOP_TIME_BOARDING) {
            Some(e) => {
                if e.length != n_st {
                    return Err(PtbError::CountExceedsRegion {
                        region: "stopTimeBoarding",
                    });
                }
                // No `offset + length > buf.len()` guard here: `Header::parse`
                // already bounds-checks every tagged-table region against the
                // buffer (header.rs `RegionOutOfBounds`), so a 0xFA region that
                // overruns the buffer is rejected at parse time, before this point.
                Some(e.offset)
            }
            None => None,
        };

        // Optional `0x17 Frequencies` region: `count u32 LE` prefix + `count * 16`
        // row bytes, sorted by `(tripIdx, startSecs)`. Present only on bundles
        // with ≥1 row. Absent → `frequencies_off = None`, `frequencies_count = 0`.
        // Validation: region length must be `4 + count * 16`; the offset is already
        // bounds-checked by `Header::parse` (tagged-table `RegionOutOfBounds`).
        let (frequencies_off, frequencies_count) =
            match header.region_by_id(crate::region_ids::FREQUENCIES) {
                Some(e) => {
                    // Must hold at least a 4-byte count prefix.
                    if e.length < 4 {
                        return Err(PtbError::CountExceedsRegion {
                            region: "frequencies",
                        });
                    }
                    let count_bytes: [u8; 4] =
                        buf[e.offset..e.offset + 4].try_into().map_err(|_| {
                            PtbError::CountExceedsRegion {
                                region: "frequencies",
                            }
                        })?;
                    let count = u32::from_le_bytes(count_bytes) as usize;
                    // Validate: length must equal 4 + count * 16.
                    let expected_len = 4usize
                        .checked_add(count.checked_mul(16).ok_or(PtbError::CountExceedsRegion {
                            region: "frequencies",
                        })?)
                        .ok_or(PtbError::CountExceedsRegion {
                            region: "frequencies",
                        })?;
                    if e.length != expected_len {
                        return Err(PtbError::CountExceedsRegion {
                            region: "frequencies",
                        });
                    }
                    (Some(e.offset), count)
                }
                None => (None, 0),
            };

        // Validate the trip-record capacity up front (count*stride, checked) so
        // the on-demand trip accessors only need a cheap `i < count` check.
        check_table(
            &header,
            Region::TripsIntern,
            header.num_trips,
            TRIP_RECORD_BYTES,
            "trips",
        )?;

        // Pattern band (B1.2 Task A). OPTIONAL: when `0x10` is absent the band
        // resolves to `None` and `Index::build` takes the flat-carry path — a
        // bundle missing the band is NOT hard-failed here. When PRESENT, every
        // region is resolved + gated against the header counts so the accessors
        // are panic-free. The band ids are FROZEN-registry ids, NOT carries. Resolved HERE
        // (moved ahead of the carry blocks) so the carry-less branch below can
        // synthesize the structural arrays FROM the band.
        let pattern_band = resolve_pattern_band(
            buf,
            &header,
            header.num_stops as usize,
            header.num_trips as usize,
        )?;

        // B1.5-T4a carry-less detection. The producer strips the flat
        // `0xF4 StopTimes` / `0xF5 TripStarts` / `0xF6 Csr` carry off a band
        // bundle (`0xFA` too — handled above: absent ⇒ `boarding_off == None`). A
        // stripped carry leaves its `Region` slot zero-length. We take the
        // carry-less path ONLY for a bundle that (a) carries the pattern band and
        // (b) has ALL THREE of `0xF4`/`0xF5`/`0xF6` absent — never a partial mix
        // (a half-stripped bundle is corrupt and must still fail the carry gates).
        // The band is the source of truth for the timetable; here we re-materialize
        // ONLY the small structural arrays the band path's load-time validation +
        // route iteration still read (`trip_starts` for Pin-6, route→trips CSR),
        // NOT the stop_times themselves (the load-CPU/RSS win survives).
        let st_absent = header.region(Region::StopTimes).length == 0;
        let ts_absent = header.region(Region::TripStarts).length == 0;
        let csr_absent = header.region(Region::Csr).length == 0;
        let carry_less_band = pattern_band.is_some() && st_absent && ts_absent && csr_absent;

        let (
            trip_starts,
            rt_offsets,
            rt_values,
            sr_offsets,
            sr_values,
            synth_trip_starts,
            synth_rt_offsets,
            synth_rt_values,
        ) = if carry_less_band {
            // Synthesize the structural metadata from the band + the surviving
            // `0xF2 TripsIntern` trip→route backref. The carry `U32Range`s point at
            // the zero-length stripped slots (never read — the accessors take the
            // owned `synth_*` arrays). See `synthesize_carry_from_band`. The band is
            // `Some` (gated by `carry_less_band`).
            let band = pattern_band
                .as_ref()
                .expect("carry_less_band implies pattern_band is Some");
            let (ts, rt_off, rt_val) = synthesize_carry_from_band(buf, &header, band)?;
            let empty = U32Range { start: 0, len: 0 };
            (
                empty,
                empty,
                empty,
                empty,
                empty,
                Some(ts),
                Some(rt_off),
                Some(rt_val),
            )
        } else {
            // Carry-BEARING path — byte-unchanged from before B1.5-T4a.
            //
            // TripStarts: (num_trips+1) u32 prefix-sum.
            let trip_starts = u32_range(
                buf,
                header.region(Region::TripStarts).offset,
                (header.num_trips as usize)
                    .checked_add(1)
                    .ok_or(PtbError::SliceOutOfBounds { what: "tripStarts" })?,
            )?;

            // Fail closed if the StopTimes region carries more (or fewer) rows than
            // the trips reference: tripStarts is a (num_trips+1) prefix-sum whose last
            // entry is the total stop-time row count. Mirrors the TS loader invariant
            // (loader.ts: tripStarts[last] === stopTimes.length) so Rust and TS reject
            // the same malformed bundles. Holds for every carry-bearing PTB version —
            // the StopTimes region id (0xF4) and `length/12` row count are identical
            // Runs after `resolve_stop_times_soa` (the tight-12*N check above) so a phantom row that keeps
            // `length % 12 == 0` still fails here rather than slipping through to a
            // silent out-of-range projection scan.
            let num_stop_time_rows = header.region(Region::StopTimes).length / STOP_TIME_ROW_BYTES;
            if last_u32(buf, trip_starts) as usize != num_stop_time_rows {
                return Err(PtbError::CountExceedsRegion {
                    region: "stopTimes",
                });
            }

            // CSR — packed back-to-back (mirrors loader.ts lines 222-279). Compute +
            // validate the four sub-array ranges; store ranges, not decoded Vecs.
            let csr_base = header.region(Region::Csr).offset;
            let rt_off_len =
                (header.num_routes as usize)
                    .checked_add(1)
                    .ok_or(PtbError::CsrInvalid {
                        detail: "num_routes overflow",
                    })?;
            let rt_offsets = u32_range(buf, csr_base, rt_off_len)?;
            let rt_values_len = last_u32(buf, rt_offsets) as usize; // == num_trips (validated below)
                                                                    // Provably safe (u32_range above bounded rt_offsets), but use checked
                                                                    // arithmetic for uniformity with the neighbouring sub-array math.
            let rt_values_start = rt_off_len
                .checked_mul(4)
                .and_then(|b| csr_base.checked_add(b))
                .ok_or(PtbError::CsrInvalid {
                    detail: "rt_values_start overflow",
                })?;
            let rt_values = u32_range(buf, rt_values_start, rt_values_len)?;
            let sr_off_start = (header.num_trips as usize)
                .checked_mul(4)
                .and_then(|b| rt_values_start.checked_add(b))
                .ok_or(PtbError::CsrInvalid {
                    detail: "sr_off_start overflow",
                })?;
            let sr_off_len =
                (header.num_stops as usize)
                    .checked_add(1)
                    .ok_or(PtbError::CsrInvalid {
                        detail: "num_stops overflow",
                    })?;
            let sr_offsets = u32_range(buf, sr_off_start, sr_off_len)?;
            let sr_values_len = last_u32(buf, sr_offsets) as usize;
            let sr_values_start = sr_off_len
                .checked_mul(4)
                .and_then(|b| sr_off_start.checked_add(b))
                .ok_or(PtbError::CsrInvalid {
                    detail: "sr_values_start overflow",
                })?;
            let sr_values = u32_range(buf, sr_values_start, sr_values_len)?;
            validate_csr(
                cast_u32(buf, rt_offsets)?,
                cast_u32(buf, rt_values)?,
                cast_u32(buf, sr_offsets)?,
                cast_u32(buf, sr_values)?,
                header.num_trips as usize,
                header.num_routes as usize,
            )?;
            (
                trip_starts,
                rt_offsets,
                rt_values,
                sr_offsets,
                sr_values,
                None,
                None,
                None,
            )
        };

        // Transfers: fixed 32 B stride, count derived as region.length/32.
        // Validate count*32 <= region.length (the spec's bound) AND that the
        // region slice is in-bounds so the on-demand `transfer(i)` accessor only
        // needs a cheap `i < count` check. Carried-only — no scan reads it.
        {
            let tr = header.region(Region::Transfers);
            let count = tr.length / TRANSFER_RECORD_BYTES;
            let need =
                count
                    .checked_mul(TRANSFER_RECORD_BYTES)
                    .ok_or(PtbError::CountExceedsRegion {
                        region: "transfers",
                    })?;
            if need > tr.length {
                return Err(PtbError::CountExceedsRegion {
                    region: "transfers",
                });
            }
            // Region must be addressable in the backing buffer.
            region_slice(buf, &header, Region::Transfers)?;
        }

        // stop_index source. A bundle carrying a persisted StopIndex region
        // (`stop_index::REGION_ID`) skips the eager rebuild entirely — the mmap
        // win: load drops from an O(num_stops) String-allocating
        // pass to a stored byte range. Otherwise build the eager `HashMap` (the
        // region is regenerable from the lossless stops). The persisted lookup reproduces the HashMap's
        // last-wins-on-duplicate-id semantics (see `stop_index::build`).
        let stop_index = match header.region_by_id(crate::stop_index::REGION_ID) {
            Some(e) => StopIndexSource::Persisted {
                offset: e.offset,
                length: e.length,
            },
            None => {
                let mut m =
                    HashMap::with_capacity_and_hasher(header.num_stops as usize, FxBuildHasher);
                // Rebuild from the `id_idx` column, resolved through the pool.
                for i in 0..header.num_stops as usize {
                    let id_idx = rd_u32(buf, stops_soa.id_idx.start + i * 4)?;
                    let id = pool.str_at(id_idx)?;
                    m.insert(id.into(), i as u32); // last-wins on dup ids
                }
                StopIndexSource::Eager(m)
            }
        };

        // PTB v2: the mandatory origin/commitment regions, the v2 transfer-row
        // contract and the source-scoped TripMeta block keys. A v1 bundle keeps
        // its frozen legacy validation (none of this runs).
        let v2 = if header.is_v2() {
            let regions = crate::v2::resolve_v2_regions(buf, &header)?;
            let trips = region_slice(buf, &header, Region::TripsIntern)?;
            let trip_route = |t: u32| rd_u32(trips, t as usize * TRIP_RECORD_BYTES + 8);
            crate::v2::validate_transfers_v2(buf, &header, &trip_route)?;
            crate::v2::validate_frequencies_v2(buf, &header)?;
            if let Some(band) = pattern_band.as_ref() {
                let count = pool.count();
                for t in 0..header.num_trips as usize {
                    let b = rd_u32(buf, band.trip_meta.offset + t * 24 + 16)?;
                    if b != u32::MAX && b >= count {
                        return Err(PtbError::TripMetaInvalid {
                            reason: "block_idx_out_of_range",
                        });
                    }
                }
            }
            Some(regions)
        } else {
            None
        };

        let window_days = header.window_days;
        Ok(Reader {
            bytes,
            header,
            trip_starts,
            rt_offsets,
            rt_values,
            sr_offsets,
            sr_values,
            synth_trip_starts,
            synth_rt_offsets,
            synth_rt_values,
            stop_index,
            stops_soa,
            routes_soa,
            boarding_off,
            frequencies_off,
            frequencies_count,
            service_pool,
            service_to_bitfield,
            pattern_band,
            window_days,
            bytes_per_service,
            lookups: AtomicU64::new(0),
            v2,
        })
    }

    /// The bundle's PTB format version (1 or 2).
    #[inline]
    pub fn version(&self) -> u16 {
        self.header.version
    }

    /// Whether this is a PTB v2 bundle.
    #[inline]
    pub fn is_v2(&self) -> bool {
        self.v2.is_some()
    }

    /// PTB v2 `DERIVE_BLOCK_INSEAT` feature bit (always `false` on v1).
    #[inline]
    pub fn derive_block_inseat(&self) -> bool {
        self.header.derive_block_inseat()
    }

    /// Number of `0x18 ServiceDayOrigins` entries (`effectiveWindowDays + 1`), or
    /// 0 on a v1 bundle.
    #[inline]
    pub fn num_service_day_origins(&self) -> usize {
        self.v2.map_or(0, |v| v.origins_len)
    }

    /// Origin `i` of `0x18 ServiceDayOrigins`: the Unix instant of local noon
    /// minus 43,200 s on `feedStartDate + i`. `None` on v1 or out of range.
    /// Validated strictly increasing at load.
    #[inline]
    pub fn service_day_origin(&self, i: usize) -> Option<i64> {
        let v = self.v2?;
        if i >= v.origins_len {
            return None;
        }
        let o = v.origins_off + i * 8;
        let b: [u8; 8] = self.bytes.as_ref().get(o..o + 8)?.try_into().ok()?;
        Some(i64::from_le_bytes(b))
    }

    /// Decoded `0x19 BlockDerivationCommitment` (v2 only).
    pub fn block_derivation_commitment(&self) -> Option<crate::v2::BlockDerivationCommitment> {
        self.v2.map(|v| v.block_commitment)
    }

    /// Decoded `0x1A CompatibilityArtifactCommitment` (v2 only).
    pub fn compatibility_artifact_commitment(
        &self,
    ) -> Option<crate::v2::CompatibilityArtifactCommitment> {
        self.v2.map(|v| v.compat_commitment)
    }

    /// Trip `t`'s source-scoped block key (`TripMeta.block_idx` resolved through
    /// the StringPool), or `None` when the trip has no `block_id`, the bundle is
    /// v1 (whose TripMeta never carries one), or the band is absent.
    pub fn trip_block_key(&self, t: usize) -> Option<&str> {
        self.v2?;
        let band = self.pattern_band.as_ref()?;
        if t >= self.num_trips() {
            return None;
        }
        let idx = rd_u32(self.bytes.as_ref(), band.trip_meta.offset + t * 24 + 16).ok()?;
        if idx == u32::MAX {
            return None;
        }
        self.pool().ok()?.str_at(idx).ok()
    }

    /// Trip `t`'s raw `TripMeta.block_idx` (StringPool index, `u32::MAX` =
    /// absent). `None` when the band is absent or `t` is out of range.
    pub fn trip_block_idx(&self, t: usize) -> Option<u32> {
        let band = self.pattern_band.as_ref()?;
        if t >= self.num_trips() {
            return None;
        }
        rd_u32(self.bytes.as_ref(), band.trip_meta.offset + t * 24 + 16).ok()
    }

    /// Decode transfer row `i` under the PTB v2 contract (absent stops allowed on
    /// type 4/5 rows). The load-time validation already accepted every row, so
    /// this only fails on an out-of-range `i` or a v1 bundle.
    pub fn transfer_v2(&self, i: usize) -> Result<crate::v2::TransferRowV2> {
        if self.v2.is_none() {
            return Err(PtbError::UnsupportedVersion {
                got: self.header.version,
            });
        }
        if i >= self.num_transfers() {
            return Err(PtbError::SliceOutOfBounds {
                what: "transfer index",
            });
        }
        let region = self.region_slice(Region::Transfers)?;
        let trips = self.region_slice(Region::TripsIntern)?;
        let trip_route = |t: u32| rd_u32(trips, t as usize * TRIP_RECORD_BYTES + 8);
        crate::v2::decode_transfer_v2(
            region,
            i,
            (
                self.header.num_stops,
                self.header.num_routes,
                self.header.num_trips,
            ),
            &trip_route,
        )
    }

    /// The underlying `.ptb` byte slice the reader was constructed from.
    ///
    /// Cheap sub-millisecond accessor. `pt-wasm::PtRouter::is_alive()` uses this internally, but
    /// **`is_alive()` is the authoritative liveness contract** — `bytes_view().is_some()` is NOT
    /// equivalent. The two can diverge: after `PtRouter::manual_free()` flips its dropped flag,
    /// `is_alive()` returns `false`, but `bytes_view()` still returns `Some(...)` because the
    /// underlying `Vec<u8>` doesn't drop until JS GC fires the FinalizationRegistry. Do NOT use
    /// `bytes_view()` as a liveness probe in any new caller.
    ///
    /// Returns `None` when the underlying buffer is empty (in practice
    /// unreachable today — the constructor's header parse rejects
    /// zero-length and short buffers before a Reader is ever built; the
    /// empty-check here is the defensive lower-bound).
    pub fn bytes_view(&self) -> Option<&[u8]> {
        let b = self.bytes.as_ref();
        if b.is_empty() {
            None
        } else {
            Some(b)
        }
    }

    /// Borrowed access to the parsed header. Used by pt-serve's loader
    /// (e.g. cross-namespace integrity checks at reload time).
    #[inline]
    pub fn header(&self) -> &Header {
        &self.header
    }

    /// The stop index of `stop_idx`'s parent_station, or `None` when the stop has
    /// no parent (`u32::MAX` in the dense `parent_idx` column) or the column
    /// holds an out-of-range value — corruption, which `validate_structural`
    /// flags at load; returning `None` keeps a caller from indexing past its
    /// stops table.
    pub fn stop_parent(&self, stop_idx: u32) -> Option<u32> {
        let parents = cast_u32(self.bytes.as_ref(), self.stops_soa.parent_idx).ok()?;
        let p = *parents.get(stop_idx as usize)?;
        if p == u32::MAX || p >= self.header.num_stops {
            None
        } else {
            Some(p)
        }
    }

    // ---- header-derived counts ----    // ---- header-derived counts ----
    pub fn feed_start_date(&self) -> u32 {
        self.header.feed_start_date
    }
    pub fn num_services(&self) -> u32 {
        self.header.num_services
    }
    /// Service-bitmask window length (days), from the `0x01 WindowMeta` region
    /// (default 90 when absent). The window guard in
    /// `service_active_on` is anchored on this runtime value.
    pub fn window_days(&self) -> u16 {
        self.window_days
    }
    /// Per-service bitmask stride (bytes) = `bytes_per_service(window_days)`. The
    /// service-bitmask slice and the load-time exact-size capacity gate are both
    /// keyed on this runtime stride, not the historical fixed 12 bytes.
    pub fn bytes_per_service(&self) -> usize {
        self.bytes_per_service
    }
    pub fn num_stops(&self) -> usize {
        self.header.num_stops as usize
    }
    pub fn num_routes(&self) -> usize {
        self.header.num_routes as usize
    }
    pub fn num_trips(&self) -> usize {
        self.header.num_trips as usize
    }
    pub fn num_stop_times(&self) -> usize {
        // Carry-less (B1.5-T4a): the flat `0xF4 StopTimes` region is stripped, so
        // its length is 0. The band path's Pin-6 validation needs a count CONSISTENT
        // with the synthesized `trip_starts` (whose last entry is this total — a sum
        // of per-trip band POSITION counts, not flat rows, which no longer exist).
        // The scan never reads a flat stop_time on this path; `project()` IS
        // exercised carry-less (its `is_carry_less_band()` branch) but reconstructs
        // each stop_time from the band rather than reading a flat `0xF4` row, so it
        // too needs no flat region — only this count. Carry-bearing bundles unchanged.
        if let Some(ts) = &self.synth_trip_starts {
            return ts.last().copied().unwrap_or(0) as usize;
        }
        self.header.region(Region::StopTimes).length / STOP_TIME_ROW_BYTES
    }
    /// Number of GTFS `transfers.txt` rules in the `0xF8 Transfers` region
    /// (derived as `region.length / 32`). Zero for a feed without transfers.
    pub fn num_transfers(&self) -> usize {
        self.header.region(Region::Transfers).length / TRANSFER_RECORD_BYTES
    }

    // ---- on-demand record accessors (decode from bytes; owned Strings, fine
    //      for P1/projection — P2 may add idx/&str hot-path variants) ----
    /// The RAW `parent_idx` column (`u32::MAX` = no parent, plus any corrupt
    /// values). For the structural parent validator, which must SEE the raw
    /// values to flag them — unlike `stop_parent`, which masks
    /// `u32::MAX`/out-of-range.
    pub(crate) fn soa_parent_column(&self) -> Result<&[u32]> {
        cast_u32(self.bytes.as_ref(), self.stops_soa.parent_idx)
    }

    /// Decode stop `i`. NOTE: `Stop::stop_lat`/`stop_lon` are a LOSSY f32 derived
    /// from the canonical `i32@1e7` columns; callers that need the exact
    /// coordinate must use `stop_lat_e7`/`stop_lon_e7` (or
    /// `stop_lat_f64`/`stop_lon_f64`), NOT this field.
    pub fn stop(&self, i: usize) -> Result<Stop> {
        if i >= self.num_stops() {
            return Err(PtbError::SliceOutOfBounds { what: "stop index" });
        }
        {
            // Read the typed columns at their tight strides, then resolve the two
            // `*_idx` columns through the StringPool.
            let s = &self.stops_soa;
            {
                let buf = self.bytes.as_ref();
                let id_idx = rd_u32(buf, s.id_idx.start + i * 4)?;
                let name_idx = rd_u32(buf, s.name_idx.start + i * 4)?;
                let lat_e7 =
                    cast_i32(buf, s.lat_e7)?
                        .get(i)
                        .copied()
                        .ok_or(PtbError::SliceOutOfBounds {
                            what: "lat_e7 column",
                        })?;
                let lon_e7 =
                    cast_i32(buf, s.lon_e7)?
                        .get(i)
                        .copied()
                        .ok_or(PtbError::SliceOutOfBounds {
                            what: "lon_e7 column",
                        })?;
                let wheelchair = rd_u8(buf, s.wheelchair + i)?;
                let pool = self.pool()?;
                Ok(Stop {
                    stop_id: pool.str_at(id_idx)?.into(),
                    stop_name: pool.str_at(name_idx)?.into(),
                    // LOSSY: the `as f32` narrows the canonical `i32@1e7`
                    // column — callers wanting the exact value use
                    // `stop_lat_e7`/`stop_lat_f64`, NOT this field.
                    stop_lat: crate::coord_quant::decode_e7(lat_e7) as f32,
                    stop_lon: crate::coord_quant::decode_e7(lon_e7) as f32,
                    wheelchair_boarding: wheelchair,
                })
            }
        }
    }

    /// `stop_lat` as the canonical `i32@1e7` (the stored column).
    pub fn stop_lat_e7(&self, i: usize) -> Result<i32> {
        if i >= self.num_stops() {
            return Err(PtbError::SliceOutOfBounds { what: "stop index" });
        }
        cast_i32(self.bytes.as_ref(), self.stops_soa.lat_e7)?
            .get(i)
            .copied()
            .ok_or(PtbError::SliceOutOfBounds {
                what: "lat_e7 column",
            })
    }
    /// `stop_lon` as the canonical `i32@1e7`. See [`Self::stop_lat_e7`].
    pub fn stop_lon_e7(&self, i: usize) -> Result<i32> {
        if i >= self.num_stops() {
            return Err(PtbError::SliceOutOfBounds { what: "stop index" });
        }
        cast_i32(self.bytes.as_ref(), self.stops_soa.lon_e7)?
            .get(i)
            .copied()
            .ok_or(PtbError::SliceOutOfBounds {
                what: "lon_e7 column",
            })
    }
    /// `stop_lat` as `f64` degrees, decoded from the `i32@1e7` column. The exact
    /// coordinate accessor.
    pub fn stop_lat_f64(&self, i: usize) -> Result<f64> {
        Ok(crate::coord_quant::decode_e7(self.stop_lat_e7(i)?))
    }
    /// `stop_lon` as `f64` degrees. See [`Self::stop_lat_f64`].
    pub fn stop_lon_f64(&self, i: usize) -> Result<f64> {
        Ok(crate::coord_quant::decode_e7(self.stop_lon_e7(i)?))
    }
    pub fn route(&self, i: usize) -> Result<RouteRec> {
        if i >= self.num_routes() {
            return Err(PtbError::SliceOutOfBounds {
                what: "route index",
            });
        }
        {
            let s = &self.routes_soa;
            {
                let buf = self.bytes.as_ref();
                let id_idx = rd_u32(buf, s.id_idx.start + i * 4)?;
                let agency_idx = rd_u32(buf, s.agency_idx.start + i * 4)?;
                let short_idx = rd_u32(buf, s.short_idx.start + i * 4)?;
                let long_idx = rd_u32(buf, s.long_idx.start + i * 4)?;
                let color_idx = rd_u32(buf, s.color_idx.start + i * 4)?;
                let text_idx = rd_u32(buf, s.text_color_idx.start + i * 4)?;
                let route_type = rd_u16(buf, s.route_type + i * 2)?;
                let pool = self.pool()?;
                Ok(RouteRec {
                    route_id: pool.str_at(id_idx)?.into(),
                    agency_id: pool.str_at(agency_idx)?.into(),
                    short_name: pool.str_at(short_idx)?.into(),
                    long_name: pool.str_at(long_idx)?.into(),
                    route_type,
                    route_color: pool.str_at(color_idx)?.into(),
                    route_text_color: pool.str_at(text_idx)?.into(),
                })
            }
        }
    }
    pub fn trip(&self, i: usize) -> Result<TripRec> {
        let region = self.region_slice(Region::TripsIntern)?;
        if i >= self.num_trips() {
            return Err(PtbError::SliceOutOfBounds { what: "trip index" });
        }
        decode_trip(region, i * TRIP_RECORD_BYTES, &self.pool()?)
    }
    /// Hot-path accessor: decode ONLY the `wheelchair_boarding` u8 (the `0x40`
    /// wheelchair column) without allocating the `stop_id`/`stop_name` Strings that
    /// `stop(i)` builds. The wheelchair stop-skip runs per position per round
    /// — two String allocs per call there would dominate the
    /// hot loop. This is the "P2 may add idx/&str hot-path variant" the reader's
    /// own comment anticipated.
    pub fn stop_wheelchair_boarding(&self, i: usize) -> Result<u8> {
        if i >= self.num_stops() {
            return Err(PtbError::SliceOutOfBounds { what: "stop index" });
        }
        rd_u8(self.bytes.as_ref(), self.stops_soa.wheelchair + i)
    }
    /// Packed GTFS pickup/drop-off byte for stop_time `i` (the optional
    /// `StopTimeBoarding` 0xFA column). LSB-first: `pickup_type[1:0]`,
    /// `drop_off_type[3:2]`, `continuous_pickup[5:4]`, `continuous_drop_off[7:6]`.
    /// Default `0x50` (regular pickup + drop-off, continuous services "no") when
    /// the region is absent OR the read is out of range.
    ///
    /// A carry-less bundle has no `0xFA`; its per-position pickup/drop-off
    /// semantics live in the band's `0x12`, so row `i` is mapped onto the band
    /// the same way [`Self::stop_time`] maps it. The flat scan path (`Off` mode)
    /// reads boarding through here, so without this it would board and alight
    /// where GTFS forbids it. All-regular bundles (no `0x12`) skip the mapping.
    /// GTFS reference: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
    #[inline]
    pub fn boarding_byte(&self, i: usize) -> u8 {
        match self.boarding_off {
            Some(off) => rd_u8(self.bytes.as_ref(), off + i).unwrap_or(0x50),
            None if self.has_pattern_semantics() && self.is_carry_less_band() => {
                self.band_boarding_byte(i).unwrap_or(0x50)
            }
            None => 0x50,
        }
    }
    /// `true` when this bundle carries an explicit `StopTimeBoarding` (0xFA)
    /// region (i.e. the producer emitted non-default pickup/drop-off bytes for
    /// at least one stop_time). `false` ⇒ every stop_time defaults to `0x50`
    /// (regular pickup + drop-off). Surfaced on pt-serve `/ready` so operators
    /// can confirm the always-on pickup/drop-off predicate has data to act on
    /// for this city — the PTB version stays 7 whether or not the region is
    /// present, so the version field cannot signal it.
    #[inline]
    pub fn has_boarding(&self) -> bool {
        self.boarding_off.is_some()
    }
    /// `true` when this bundle carries a `0x17 Frequencies` region with ≥1 row.
    /// Keyed on the decoded row `count`, NOT mere region presence: a structurally
    /// present region with `count == 0` (which a third-party producer could emit,
    /// even though OUR producer omits-when-empty) yields `false` — the reader
    /// enforces the "≥1 row" contract itself rather than trusting producer
    /// discipline, so `has_frequencies()` can never disagree with the accessors.
    #[inline]
    pub fn has_frequencies(&self) -> bool {
        self.frequencies_count > 0
    }

    /// PTB v2: whether `trip_idx` is a quarantined frequency trip (its only
    /// `0x17` row carries [`crate::v2::FREQUENCY_FLAG_QUARANTINED`]). Always
    /// `false` on v1, whose byte 15 is reserved.
    pub fn frequency_trip_quarantined(&self, trip_idx: u32) -> bool {
        if !self.is_v2() {
            return false;
        }
        let Some(off) = self.frequencies_off else {
            return false;
        };
        let buf = self.bytes.as_ref();
        let rows_off = off + 4;
        let (mut lo, mut hi) = (0usize, self.frequencies_count);
        while lo < hi {
            let mid = (lo + hi) / 2;
            let o = rows_off + mid * 16;
            let t = u32::from_le_bytes(buf[o..o + 4].try_into().unwrap_or([0u8; 4]));
            if t < trip_idx {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo >= self.frequencies_count {
            return false;
        }
        let o = rows_off + lo * 16;
        u32::from_le_bytes(buf[o..o + 4].try_into().unwrap_or([0u8; 4])) == trip_idx
            && buf[o + 15] & crate::v2::FREQUENCY_FLAG_QUARANTINED != 0
    }

    /// Returns an iterator over the [`FrequencyRecord`]s for `trip_idx`, in
    /// ascending `start_secs` order (as stored).
    ///
    /// Binary-searches the sorted 16 B/row region on `tripIdx` to find the
    /// contiguous run of rows belonging to this trip, then decodes them lazily.
    /// Returns an empty iterator when the region is absent, the trip has no rows,
    /// or `trip_idx` is out of range — never panics.
    ///
    /// GTFS reference: <https://gtfs.org/documentation/schedule/reference/#frequenciestxt>
    pub fn frequencies_for_trip(
        &self,
        trip_idx: u32,
    ) -> impl Iterator<Item = FrequencyRecord> + '_ {
        let Some(off) = self.frequencies_off else {
            return FrequencyIter {
                bytes: self.bytes.as_ref(),
                off: 0,
                idx: 0,
                end: 0,
            };
        };
        let count = self.frequencies_count;
        if count == 0 {
            return FrequencyIter {
                bytes: self.bytes.as_ref(),
                off,
                idx: 0,
                end: 0,
            };
        }
        let buf = self.bytes.as_ref();
        // Row body starts at off+4 (after the count u32 prefix); each row is 16 B.
        let rows_off = off + 4;

        // Binary-search for the FIRST row with trip_idx == trip_idx.
        let row_trip = |i: usize| -> u32 {
            let o = rows_off + i * 16;
            u32::from_le_bytes(buf[o..o + 4].try_into().unwrap_or([0u8; 4]))
        };
        let (mut lo, mut hi) = (0usize, count);
        while lo < hi {
            let mid = (lo + hi) / 2;
            if row_trip(mid) < trip_idx {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        // `lo` is now the first index with trip_idx >= trip_idx. Scan forward for
        // the contiguous run matching exactly trip_idx.
        let start = lo;
        let mut end = lo;
        while end < count && row_trip(end) == trip_idx {
            end += 1;
        }
        FrequencyIter {
            bytes: buf,
            off: rows_off,
            idx: start,
            end,
        }
    }

    /// `true` when this bundle carries an explicit `0x01 WindowMeta` region (i.e.
    /// the producer emitted a non-default `windowDays`). `false` ⇒ the region was
    /// ABSENT and `window_days()` floored to `WINDOW_DEFAULT_DAYS` (90) — which is
    /// the case for any feed whose derived window is 90 (the producer omits the
    /// region at the default). This is the AUTHORITATIVE
    /// provenance bit, independent of the value: `window_meta_present() == false`
    /// with `window_days() == 90` is the default path, whereas
    /// `window_meta_present() == true` means a window was explicitly DECODED.
    /// Surfaced on pt-serve `/ready` next to `boardingRegionPresent` (the PTB
    /// version field cannot signal it). This mirrors `has_boarding()`'s
    /// region-presence semantics exactly.
    #[inline]
    pub fn window_meta_present(&self) -> bool {
        self.header
            .region_by_id(crate::region_ids::WINDOW_META)
            .is_some()
    }
    /// The distinct-bitfield `count` from the `0x15 ServiceBitfieldPool` prefix.
    /// The pool region was resolved + length-validated in `from_bytes`
    /// (`count` is the first 4 LE bytes of the pool body; the load-time gate already
    /// asserted `pool.length == 4 + count*S`), so this is a panic-free re-read of the
    /// cached entry. Surfaced on pt-serve `/ready` as `serviceBitfieldPoolCount` so
    /// operators can confirm the de-dup pool decoded for this generation.
    #[inline]
    pub fn service_bitfield_pool_count(&self) -> u32 {
        // Re-read the `count u32` prefix from the cached pool entry. `from_bytes`
        // already read it through the same bounds-checked range, so this cannot
        // fail on a loaded bundle; 0 keeps the accessor panic-free regardless.
        rd_u32(self.bytes.as_ref(), self.service_pool.offset).unwrap_or(0)
    }
    // ── Pattern-band accessors (B1.2 Task A) ────────────────────────────────────
    //
    // All panic-free: they return `None`/`&[]` for an out-of-range ordinal or a
    // no-band bundle. `resolve_pattern_band` gated every region against the header
    // counts at load, so the zero-copy reads here cannot OOB on a loaded bundle.

    /// True when this bundle carries the pattern band (the `0x10 Patterns`
    /// region resolved). `false` for a bundle that omits the band.
    #[inline]
    pub fn pattern_band_present(&self) -> bool {
        self.pattern_band.is_some()
    }

    /// True when this is a CARRY-LESS band bundle (B1.5-T4a): the flat
    /// `0xF4`/`0xF5`/`0xF6` carry is stripped and the structural metadata was
    /// re-materialized from the band at load (`synth_trip_starts` is `Some`). On
    /// this path the flat `stop_time(i)` accessor would OOB-read the zero-length
    /// `0xF4` slot — the band is the SOLE timetable. `false` on every
    /// carry-BEARING bundle (incl. a band bundle that still carries the flat
    /// regions). Used by `projection::project` to choose the band-materialized
    /// stop-times reconstruction (mirroring TS `bandToFlatStopTimes`) over the
    /// flat `stop_time(i)` read; the live scan never needs this (it reads the band
    /// directly).
    #[inline]
    pub fn is_carry_less_band(&self) -> bool {
        self.synth_trip_starts.is_some()
    }

    /// Decode the `0x10 Patterns` enumeration into per-pattern records, or `None`
    /// when the band is absent. `count u32` prefix + `count × 8 B` records (each
    /// `stops_off u32` ELEMENT index, `stop_count u16`, `flags u8`, reserved u8).
    pub fn patterns(&self) -> Option<alloc::vec::Vec<PatternRec>> {
        let band = self.pattern_band.as_ref()?;
        let buf = self.bytes.as_ref();
        let base = band.patterns.offset;
        let mut out = alloc::vec::Vec::with_capacity(band.num_patterns);
        for i in 0..band.num_patterns {
            let o = base + 4 + i * 8;
            // Gated at load (record region holds `4 + 8*count` bytes), so these
            // reads are in-bounds; fall back to `None` on the impossible failure.
            let stops_off = rd_u32(buf, o).ok()?;
            let stop_count = rd_u16(buf, o + 4).ok()?;
            let flags = rd_u8(buf, o + 6).ok()?;
            out.push(PatternRec {
                stops_off,
                stop_count,
                flags,
            });
        }
        Some(out)
    }

    /// The `0x11 PatternStops` `&[u32]` stop-ordinal slice for pattern `p`
    /// (`[stops_off .. stops_off + stop_count]`, ELEMENT-indexed). `None` for a
    /// no-band bundle or an out-of-range `p`. Repeats are preserved (a lasso's
    /// repeated stop appears twice).
    pub fn pattern_stops(&self, p: usize) -> Option<&[u32]> {
        let band = self.pattern_band.as_ref()?;
        if p >= band.num_patterns {
            return None;
        }
        let buf = self.bytes.as_ref();
        let rec_o = band.patterns.offset + 4 + p * 8;
        let stops_off = rd_u32(buf, rec_o).ok()? as usize;
        let stop_count = rd_u16(buf, rec_o + 4).ok()? as usize;
        // 0x11 is a flat u32 column at `pattern_stops.offset`; ELEMENT slice.
        let start = band
            .pattern_stops
            .offset
            .checked_add(stops_off.checked_mul(4)?)?;
        let range = u32_range(buf, start, stop_count).ok()?;
        cast_u32(buf, range).ok()
    }

    /// The raw `0x13 TripTimes` byte slice for pattern `p`. Per-pattern size is
    /// `T*(4 + 2*W*S + ceil(S/8))` where `T = pattern_trips(p).len()`,
    /// `S = stop_count`, and `W` = the region delta width (2 for `i16`, 4 for the
    /// `i32`-delta variant); the slices are contiguous in pattern order, so this
    /// sums the preceding patterns' sizes to find `p`'s offset. `None` for a
    /// no-band bundle or out-of-range `p`. The dense decode consumes this slice.
    pub fn trip_times(&self, p: usize) -> Option<&[u8]> {
        let band = self.pattern_band.as_ref()?;
        if p >= band.num_patterns {
            return None;
        }
        let delta_bytes = self.trip_times_delta_bytes();
        let buf = self.bytes.as_ref();
        let base = band.trip_times.offset;
        let mut off = 0usize; // byte offset WITHIN the 0x13 body
                              // [`Self::band_trip_times_slab`]'s `0..p` prefix-sum walk MIRRORS this loop
                              // — keep the two in sync if the `0x13` pattern enumeration changes.
        for q in 0..=p {
            let rec_o = band.patterns.offset + 4 + q * 8;
            let s = rd_u16(buf, rec_o + 4).ok()? as usize;
            let t = self.pattern_trips_len(band, q)?;
            let span = pattern_trip_times_span(t, s, delta_bytes)?;
            if q == p {
                return buf.get(base + off..base + off + span);
            }
            off = off.checked_add(span)?;
        }
        None
    }

    /// The `0x13 TripTimes` region's `entryFlags`, or `None` when the band is
    /// absent. `0` is the dense default; bit0 = ragged, bit1 = i32-deltas
    /// (locked-layout doc) — B1.2 supports ONLY `entry_flags == 0`, and Task B
    /// error-stubs any non-zero variant. Surfaced here so Task B can branch.
    #[inline]
    pub fn trip_times_entry_flags(&self) -> Option<u16> {
        self.pattern_band.as_ref().map(|b| b.trip_times.entry_flags)
    }

    /// True when the `0x13 TripTimes` region declares the RAGGED variant
    /// (`entry_flags` bit0). `None` when the band is absent. The dense layout is
    /// the only one decoded — the RAGGED variant is REJECTED at LOAD by
    /// `resolve_pattern_band` (which fails closed on any non-bit1 flag), so a
    /// ragged band never produces a `Some` reader. This accessor therefore only
    /// ever returns `Some(false)` / `None` for a successfully-loaded reader; it
    /// stays for the unreachable-but-cheap defense-in-depth guard in `Index::build`
    /// and the band accessors below.
    #[inline]
    pub fn trip_times_is_ragged(&self) -> Option<bool> {
        self.trip_times_entry_flags()
            .map(|f| f & TRIP_TIMES_FLAG_RAGGED != 0)
    }

    /// True when the `0x13 TripTimes` region declares the `i32`-DELTA variant
    /// (`entry_flags` bit1, the intercity-Paris on-ramp). `None` when the band is
    /// absent. SUPPORTED: the `i32` (4-byte) deltas are decoded just like the
    /// `i16` (2-byte) ones — the width rides in `BandSlab::delta_bytes` and the
    /// `trip_times_subarrays` / `rd_delta` math is width-parameterized. (Only the
    /// RAGGED bit0 variant remains rejected.)
    #[inline]
    pub fn trip_times_is_i32_deltas(&self) -> Option<bool> {
        self.trip_times_entry_flags()
            .map(|f| f & TRIP_TIMES_FLAG_I32_DELTAS != 0)
    }

    /// The raw `0x12 PatternSemantics` byte slice (one packed byte per
    /// pattern-position: `pickup_type`/`drop_off_type`/`timepoint`), or `None`
    /// when the band is absent OR the region was OMITTED (every pattern
    /// all-regular — the omit-when-all-regular rule). Task B decodes it per
    /// position for the non-regular patterns.
    pub fn pattern_semantics(&self) -> Option<&[u8]> {
        let band = self.pattern_band.as_ref()?;
        let e = band.pattern_semantics?;
        self.bytes.as_ref().get(e.offset..e.offset + e.length)
    }

    /// True when this bundle carries an explicit `0x12 PatternSemantics` region
    /// (≥1 non-regular pattern). `false` ⇒ the region was omitted (every pattern
    /// all-regular) OR the band is absent. Mirrors `has_boarding`.
    #[inline]
    pub fn has_pattern_semantics(&self) -> bool {
        self.pattern_band
            .as_ref()
            .is_some_and(|b| b.pattern_semantics.is_some())
    }

    /// The raw `0x14 TripMeta` byte slice (24 B per trip: pattern/service/
    /// direction/wheelchair/bikes_allowed/block carry), or `None` when the band
    /// is absent. Task B decodes per-trip records from it; carried-only in Task A.
    pub fn trip_meta_raw(&self) -> Option<&[u8]> {
        let band = self.pattern_band.as_ref()?;
        let e = band.trip_meta;
        self.bytes.as_ref().get(e.offset..e.offset + e.length)
    }

    /// Trip `t`'s `pattern_idx` backref from `0x14 TripMeta` (`u32 @ t*24+0`), or
    /// `None` when the band is absent OR `t >= num_trips` OR the read is OOB. Under
    /// `Unbounded` every trip belongs to exactly one pattern, so the band freezes
    /// this global trip→pattern mapping; B1.2 `Index::build` regroups each route's
    /// trips by it (preserving `route_trips` order) to reconstruct the per-route
    /// pattern groups without re-running `group_by_pattern`. `u32::MAX` is the
    /// emit-side absent sentinel for a trip on no covered route (cannot happen for
    /// a fully-built index) — returned verbatim, the caller validates the range.
    #[inline]
    pub fn trip_pattern_idx(&self, t: usize) -> Option<u32> {
        let band = self.pattern_band.as_ref()?;
        if t >= self.num_trips() {
            return None;
        }
        let e = band.trip_meta;
        rd_u32(self.bytes.as_ref(), e.offset + t * 24).ok()
    }

    /// The `0x46 PatternTrips` CSR slice for pattern `p` — the trip ordinals
    /// (into the global trips table) this pattern owns, in pattern order. `None`
    /// for a no-band bundle or out-of-range `p`.
    pub fn pattern_trips(&self, p: usize) -> Option<&[u32]> {
        let band = self.pattern_band.as_ref()?;
        if p >= band.num_patterns {
            return None;
        }
        let (offsets, values) = self.csr_ranges(band.pattern_trips, band.num_patterns)?;
        csr_slice(self.bytes.as_ref(), offsets, values, p).ok()
    }

    //
    // Read-only decoders that prove the pattern band already carries everything the
    // scan reads off the flat carry (`0xF4 StopTimes` + `0xFA StopTimeBoarding`).
    // They DO NOT change the scan — a later task cuts the scan over. Equivalence
    // (band == flat for the same trip+position) is asserted under
    // `--features pattern-crosscheck` (`index.rs::assert_band_matches_flat`) AND in
    // an always-on unit test over the committed fixtures.
    //
    // Sentinel: a position the trip does NOT serve decodes to [`BAND_NOT_SERVED`]
    // (`-1`), matching `scan::dep_secs_at`'s `pos_to_row == -1` sentinel exactly
    // (`scan.rs:325-337`). The band's `served_bits` bit is set iff `pos_to_row != -1`
    // at emit time (`pattern_emit.rs:361-371`), and an express-skip / sentinel-dep
    // position keeps `pos_to_row == -1` (`index.rs:232-256`), so a band-NOT-served
    // position is exactly a flat `-1` position.

    /// Delta-element width in bytes for the `0x13 TripTimes` region: `4` when the
    /// region declares the `i32`-delta variant (`entryFlags` bit1), else `2`
    /// (the BYTE-IDENTICAL `i16` layout). REGION-level, so a single value sizes
    /// every pattern's dep/dwell strides. `2` when the band is absent (harmless —
    /// no band decode runs).
    #[inline]
    fn trip_times_delta_bytes(&self) -> usize {
        // The band may be absent (no entryFlags) — treat that as the i16 width
        // (2 B; harmless, no band decode runs). Otherwise the SINGLE canonical
        // flag->width mapping (shared with the load-time gate).
        match self.trip_times_entry_flags() {
            Some(f) => delta_bytes_for_flags(f),
            None => 2,
        }
    }

    /// `0x13 TripTimes` byte layout (locked-layout L19-26 + i32-delta variant):
    /// per pattern with `T` trips and `S` stops, the slab is `trip_first_dep[T]
    /// u32` · `dep_deltas[T][S]` · `dwell_deltas[T][S]` · `served_bits[T][ceil(S/8)]`
    /// (all trip-major, `served_bits` LSB-first), the dep/dwell deltas `dw` bytes
    /// wide each (2 for `i16`, 4 for `i32`). This returns the byte offsets WITHIN
    /// one pattern's `0x13` slice for the four sub-arrays given `(T, S, dw)`, so
    /// the decode reads are straight slices. Ragged is still rejected upstream;
    /// `dw` carries the dense width (i16 or i32).
    #[inline]
    fn trip_times_subarrays(t: usize, s: usize, dw: usize) -> (usize, usize, usize) {
        let first_dep_bytes = t * 4; // trip_first_dep[T] u32
        let dep_bytes = t * s * dw; // dep_deltas[T][S] (dw B each)
        let dep_off = first_dep_bytes;
        let dwell_off = dep_off + dep_bytes;
        let served_off = dwell_off + dep_bytes; // dwell_deltas same size as dep_deltas
        (dep_off, dwell_off, served_off)
    }

    /// True when trip `t` (LOCAL trip-in-pattern index) serves canonical position
    /// `pos` of pattern `p`, decoded from the `0x13` `served_bits` (LSB-first). `None`
    /// for a no-band bundle, out-of-range `p`/`t`/`pos`, or the RAGGED `0x13`
    /// variant (still unsupported). The `i32`-delta variant IS decodable — the
    /// width only shifts `served_off`, which `trip_times_subarrays` handles.
    pub fn band_served(&self, p: usize, t: usize, pos: usize) -> Option<bool> {
        if self.trip_times_is_ragged() != Some(false) {
            return None; // ragged (or no band) → not decodable here
        }
        let s = self.pattern_stops(p)?.len();
        let big_t = self.pattern_trips(p)?.len();
        if t >= big_t || pos >= s {
            return None;
        }
        let dw = self.trip_times_delta_bytes();
        let slab = self.trip_times(p)?;
        let (_, _, served_off) = Self::trip_times_subarrays(big_t, s, dw);
        let bytes_per_trip = s.div_ceil(8);
        let byte = *slab.get(served_off + t * bytes_per_trip + pos / 8)?;
        Some(byte & (1 << (pos % 8)) != 0)
    }

    /// Band-decoded departure secs of LOCAL trip `t` at canonical position `pos` of
    /// pattern `p`, per the `0x13` contract: `served ? trip_first_dep[t] +
    /// dep_deltas[t][pos] : BAND_NOT_SERVED`. The `i64` result matches
    /// `scan::dep_secs_at` exactly (real secs for served; `-1` for not-served).
    /// `None` for a no-band bundle, out-of-range index, or a non-dense `0x13`.
    ///
    /// NOTE: re-resolves `(s, big_t, slab)` per call (each `trip_times(p)` is
    /// O(p)); B1.5-T2 hot-path callers hoist the resolution once per trip and
    /// decode served-bit / dep-delta / dwell-delta inline from the single slab.
    pub fn band_dep_secs(&self, p: usize, t: usize, pos: usize) -> Option<i64> {
        if !self.band_served(p, t, pos)? {
            return Some(BAND_NOT_SERVED);
        }
        let s = self.pattern_stops(p)?.len();
        let big_t = self.pattern_trips(p)?.len();
        let dw = self.trip_times_delta_bytes();
        let slab = self.trip_times(p)?;
        let (dep_off, _, _) = Self::trip_times_subarrays(big_t, s, dw);
        // trip_first_dep[t] is the FIRST sub-array (slab offset 0, u32 entries);
        // trip_times_subarrays returns the other three offsets after it.
        let first_dep = rd_u32(slab, t * 4).ok()? as i64;
        let delta = rd_delta(slab, dep_off + (t * s + pos) * dw, dw)?;
        Some(first_dep + delta)
    }

    /// Band-decoded arrival secs of LOCAL trip `t` at canonical position `pos` of
    /// pattern `p`: `served ? band_dep_secs + dwell_deltas[t][pos] : BAND_NOT_SERVED`
    /// (`dwell_delta = arr_diff <= 0`, so `arr = dep - dwell`). Matches
    /// `scan::alight_secs_at` (which the scan calls only for served positions).
    /// `None` for a no-band bundle, out-of-range index, or a non-dense `0x13`.
    pub fn band_arr_secs(&self, p: usize, t: usize, pos: usize) -> Option<i64> {
        let dep = self.band_dep_secs(p, t, pos)?;
        if dep == BAND_NOT_SERVED {
            return Some(BAND_NOT_SERVED);
        }
        let s = self.pattern_stops(p)?.len();
        let big_t = self.pattern_trips(p)?.len();
        let dw = self.trip_times_delta_bytes();
        let slab = self.trip_times(p)?;
        let (_, dwell_off, _) = Self::trip_times_subarrays(big_t, s, dw);
        // dwell_deltas[t][pos] is stored as arr_diff (<= 0), so arr = dep + arr_diff.
        let arr_diff = rd_delta(slab, dwell_off + (t * s + pos) * dw, dw)?;
        Some(dep + arr_diff)
    }

    //
    // The scan resolves these ONCE per trip at index-build time and reads each
    // position with O(1) slice math, instead of calling `band_dep_secs(p,t,pos)`
    // (O(p) per position). They decode the SAME bytes as the T1 reference
    // decoders above — the always-on `assert_band_decode_matches_flat` oracle runs
    // both the reference (`band_dep_secs`) and the scan helper (`dep_secs_at`,
    // which now routes through `band_dep_at`) and asserts they agree.

    /// Resolve pattern `p`'s `0x13 TripTimes` slab to a [`BandSlab`] (the O(p)
    /// per-pattern resolution done ONCE). `None` for a no-band bundle, out-of-range
    /// `p`, or the RAGGED `0x13` variant (still unsupported, matching
    /// [`Self::band_served`]). The `i32`-delta variant IS resolved — its width
    /// rides in `BandSlab::delta_bytes`. The returned `slab_off` is ABSOLUTE within
    /// the reader bytes, so a caller that stores it can read positions later with
    /// no further `trip_times(p)` resolution.
    #[allow(dead_code)]
    pub(crate) fn band_trip_times_slab(&self, p: usize) -> Option<BandSlab> {
        if self.trip_times_is_ragged() != Some(false) {
            return None; // ragged (or no band) → not decodable here
        }
        let band = self.pattern_band.as_ref()?;
        if p >= band.num_patterns {
            return None;
        }
        let dw = self.trip_times_delta_bytes();
        let s = self.pattern_stops(p)?.len();
        let big_t = self.pattern_trips(p)?.len();
        // Absolute offset of pattern p's slab: base + Σ earlier pattern spans.
        // This per-pattern span walk MIRRORS [`Self::trip_times`]'s loop (the `0..=p`
        // one ~25 lines up) — keep the two in sync if the `0x13` pattern enumeration
        // (record stride / span formula) ever changes.
        let buf = self.bytes.as_ref();
        let base = band.trip_times.offset;
        let mut off = 0usize;
        for q in 0..p {
            let rec_o = band.patterns.offset + 4 + q * 8;
            let sq = rd_u16(buf, rec_o + 4).ok()? as usize;
            let tq = self.pattern_trips_len(band, q)?;
            off = off.checked_add(pattern_trip_times_span(tq, sq, dw)?)?;
        }
        let (dep_off, dwell_off, served_off) = Self::trip_times_subarrays(big_t, s, dw);
        Some(BandSlab {
            slab_off: base.checked_add(off)?,
            big_t,
            s,
            dep_off,
            dwell_off,
            served_off,
            delta_bytes: dw,
        })
    }

    /// Resolve every pattern's `0x13 TripTimes` slab in ONE prefix walk.
    ///
    /// [`Self::band_trip_times_slab`] is correct for one-off callers, but it
    /// computes pattern `p`'s slab offset by summing `0..p`. Calling that once per
    /// trip makes index build proportional to `Σ trip_count(p) × p` on large
    /// feeds. The band index builder needs every trip's slab, so it uses this
    /// batch resolver instead: one pass over the pattern records, one running byte
    /// offset, O(num_patterns).
    pub(crate) fn band_trip_times_slabs(&self) -> Option<alloc::vec::Vec<BandSlab>> {
        if self.trip_times_is_ragged() != Some(false) {
            return None; // ragged (or no band) → not decodable here
        }
        let band = self.pattern_band.as_ref()?;
        let dw = self.trip_times_delta_bytes();
        let buf = self.bytes.as_ref();
        let base = band.trip_times.offset;
        let mut off = 0usize;
        let mut out = alloc::vec::Vec::with_capacity(band.num_patterns);
        for p in 0..band.num_patterns {
            let rec_o = band.patterns.offset + 4 + p * 8;
            let s = rd_u16(buf, rec_o + 4).ok()? as usize;
            let big_t = self.pattern_trips_len(band, p)?;
            let (dep_off, dwell_off, served_off) = Self::trip_times_subarrays(big_t, s, dw);
            out.push(BandSlab {
                slab_off: base.checked_add(off)?,
                big_t,
                s,
                dep_off,
                dwell_off,
                served_off,
                delta_bytes: dw,
            });
            off = off.checked_add(pattern_trip_times_span(big_t, s, dw)?)?;
        }
        Some(out)
    }

    /// True when LOCAL trip `t` serves position `pos` of the resolved `slab`,
    /// decoded from `served_bits` (LSB-first). O(1). Caller guarantees
    /// `t < slab.big_t`; `pos` MAY exceed `slab.s` (a folded member queried at a
    /// position outside its band-pattern window) → `false`.
    #[inline]
    pub(crate) fn band_served_at(&self, slab: &BandSlab, t: usize, pos: usize) -> bool {
        if pos >= slab.s {
            return false;
        }
        let bytes_per_trip = slab.s.div_ceil(8);
        let buf = self.bytes.as_ref();
        match rd_u8(
            buf,
            slab.slab_off + slab.served_off + t * bytes_per_trip + pos / 8,
        ) {
            Ok(byte) => byte & (1 << (pos % 8)) != 0,
            Err(_) => false,
        }
    }

    /// Band-decoded departure secs of LOCAL trip `t` at position `pos` of the
    /// resolved `slab`: `served ? trip_first_dep[t] + dep_deltas[t][pos]
    /// : BAND_NOT_SERVED`. O(1) — no `trip_times(p)` re-resolution. Byte-identical
    /// to [`Self::band_dep_secs`].
    ///
    /// NOTE: the internal [`Self::band_served_at`] check re-decodes the served bit
    /// the scan's `dep_secs_at` marker-guard (`pos_to_row[pos] != -1`) already
    /// proved — a defensive backstop, redundant on the hot scan path but kept so the
    /// sort-key / oracle callers (which lack the marker context) stay safe. Not
    /// worth an unchecked variant.
    #[inline]
    pub(crate) fn band_dep_at(&self, slab: &BandSlab, t: usize, pos: usize) -> i64 {
        if !self.band_served_at(slab, t, pos) {
            return BAND_NOT_SERVED;
        }
        let buf = self.bytes.as_ref();
        // trip_first_dep[t] is the first sub-array (slab offset 0, u32 entries).
        let first_dep = match rd_u32(buf, slab.slab_off + t * 4) {
            Ok(v) => v as i64,
            Err(_) => return BAND_NOT_SERVED,
        };
        let dw = slab.delta_bytes;
        let delta = match rd_delta(
            buf,
            slab.slab_off + slab.dep_off + (t * slab.s + pos) * dw,
            dw,
        ) {
            Some(v) => v,
            None => return BAND_NOT_SERVED,
        };
        first_dep + delta
    }

    /// Band-decoded arrival secs of LOCAL trip `t` at position `pos` of the
    /// resolved `slab`: `dep + dwell_deltas[t][pos]` (`dwell_delta = arr_diff
    /// <= 0`, so `arr = dep - dwell`). O(1). Caller queries only served positions
    /// (matching [`crate::engine::scan::alight_secs_at`]); a not-served position
    /// returns [`BAND_NOT_SERVED`]. Byte-identical to [`Self::band_arr_secs`].
    #[inline]
    pub(crate) fn band_arr_at(&self, slab: &BandSlab, t: usize, pos: usize) -> i64 {
        let dep = self.band_dep_at(slab, t, pos);
        if dep == BAND_NOT_SERVED {
            return BAND_NOT_SERVED;
        }
        let buf = self.bytes.as_ref();
        let dw = slab.delta_bytes;
        let arr_diff = match rd_delta(
            buf,
            slab.slab_off + slab.dwell_off + (t * slab.s + pos) * dw,
            dw,
        ) {
            Some(v) => v,
            None => return BAND_NOT_SERVED,
        };
        dep + arr_diff
    }

    /// Resolve pattern `p`'s `0x12 PatternSemantics` base — the ABSOLUTE byte
    /// offset of its position-0 semantics byte within the reader bytes — done ONCE
    /// (the O(num_patterns) all-regular-skip sum). `None` when pattern `p`
    /// contributes NO `0x12` bytes (it is all-regular, or the region is omitted
    /// because EVERY pattern is regular) → the caller treats every position as
    /// [`SEMANTICS_REGULAR`]. The per-pattern offset sums `stop_count` only over
    /// EARLIER patterns that are NOT all-regular (`pattern_emit.rs:170-178`),
    /// matching [`Self::band_semantics_byte`].
    #[allow(dead_code)]
    pub(crate) fn band_semantics_base(&self, p: usize) -> Option<usize> {
        let recs = self.patterns()?;
        let rec = recs.get(p)?;
        // This pattern all-regular ⇒ contributes no bytes.
        if rec.flags & PATTERN_FLAG_ALL_REGULAR != 0 {
            return None;
        }
        // Region omitted entirely (every pattern all-regular).
        let band = self.pattern_band.as_ref()?;
        let e = band.pattern_semantics?;
        let mut base = 0usize;
        for q in 0..p {
            let r = recs.get(q)?;
            if r.flags & PATTERN_FLAG_ALL_REGULAR == 0 {
                base += r.stop_count as usize;
            }
        }
        e.offset.checked_add(base)
    }

    /// Resolve every pattern's `0x12 PatternSemantics` base in ONE pass.
    ///
    /// The one-off [`Self::band_semantics_base`] helper decodes the full `0x10`
    /// pattern record vector and then prefix-sums earlier non-regular patterns for
    /// each call. Index build calls this for many trips, so a large feed can spend
    /// most of cold load repeatedly re-reading the same pattern metadata. This
    /// batch form returns `None` for all-regular patterns and the absolute
    /// semantics byte base for non-regular patterns, preserving the exact hot-path
    /// decode contract with O(num_patterns) work.
    pub(crate) fn band_semantics_bases(&self) -> Option<alloc::vec::Vec<Option<usize>>> {
        let band = self.pattern_band.as_ref()?;
        let semantics = band.pattern_semantics;
        let buf = self.bytes.as_ref();
        let mut base = 0usize;
        let mut out = alloc::vec::Vec::with_capacity(band.num_patterns);
        for p in 0..band.num_patterns {
            let rec_o = band.patterns.offset + 4 + p * 8;
            let stop_count = rd_u16(buf, rec_o + 4).ok()? as usize;
            let flags = rd_u8(buf, rec_o + 6).ok()?;
            if flags & PATTERN_FLAG_ALL_REGULAR != 0 {
                out.push(None);
            } else {
                match semantics {
                    Some(e) => {
                        out.push(Some(e.offset.checked_add(base)?));
                        base = base.checked_add(stop_count)?;
                    }
                    None => out.push(None),
                }
            }
        }
        Some(out)
    }

    /// The packed `0x12` byte at ABSOLUTE offset `base + pos`, read THROUGH the
    /// `0x12` region's declared `[offset, offset+length)` extent (NOT the whole
    /// buffer). Returns [`SEMANTICS_REGULAR`] (`0x00`) when the offset spills past
    /// the region — so a malformed/short `0x12` (or an out-of-window `pos`) decodes
    /// as regular instead of reinterpreting an ADJACENT region's bytes as boarding
    /// flags. This is the defense-in-depth backstop that keeps the hot-path read
    /// byte-identical to the TS materializer's slice-bounded `semantics[base+pos]
    /// ?? 0x00` even if the load-time exact-size gate (`resolve_pattern_band`) were
    /// ever bypassed; the gate is the primary guard, this is the second line.
    #[inline]
    fn band_semantics_byte_at(&self, base: usize, pos: usize) -> u8 {
        // `base` is an ABSOLUTE buffer offset from `band_semantics_base`; the `0x12`
        // slice is `bytes[e.offset .. e.offset+e.length]`. `base + pos` must land in
        // that window — otherwise treat as regular (default 0x00).
        let region = match self.pattern_band.as_ref().and_then(|b| b.pattern_semantics) {
            Some(e) => e,
            None => return SEMANTICS_REGULAR,
        };
        let abs = match base.checked_add(pos) {
            Some(a) => a,
            None => return SEMANTICS_REGULAR,
        };
        let region_end = match region.offset.checked_add(region.length) {
            Some(e) => e,
            None => return SEMANTICS_REGULAR,
        };
        if abs < region.offset || abs >= region_end {
            return SEMANTICS_REGULAR;
        }
        rd_u8(self.bytes.as_ref(), abs).unwrap_or(SEMANTICS_REGULAR)
    }

    /// True when boarding is FORBIDDEN (`pickup_type == 1`) at position `pos`,
    /// given a resolved `0x12` `base` from [`Self::band_semantics_base`]. O(1).
    /// `None`-base patterns are regular (all-regular pattern / omitted region) ⇒
    /// never forbidden. Callers query only SERVED positions, so `pos < pattern
    /// stop_count` always holds; the read is BOUNDED to the `0x12` region extent
    /// (see [`Self::band_semantics_byte_at`]) so a short/malformed region decodes
    /// as regular — matching the TS materializer's `?? 0x00` default — instead of
    /// reading the next region's bytes. Byte-identical to
    /// [`Self::band_pickup_forbidden`].
    #[inline]
    pub(crate) fn band_pickup_forbidden_at(&self, base: Option<usize>, pos: usize) -> bool {
        match base {
            None => false,
            Some(b) => self.band_semantics_byte_at(b, pos) & 0b11 == 1,
        }
    }

    /// True when alighting is FORBIDDEN (`drop_off_type == 1`) at position `pos`,
    /// given a resolved `0x12` `base`. O(1). Same served-position invariant and
    /// region-bounded read as [`Self::band_pickup_forbidden_at`].
    /// Byte-identical to [`Self::band_drop_off_forbidden`].
    #[inline]
    pub(crate) fn band_drop_off_forbidden_at(&self, base: Option<usize>, pos: usize) -> bool {
        match base {
            None => false,
            Some(b) => (self.band_semantics_byte_at(b, pos) >> 2) & 0b11 == 1,
        }
    }

    /// The packed `0x12 PatternSemantics` byte for pattern `p`'s canonical position
    /// `pos` — `pickup_type[1:0]` · `drop_off_type[3:2]` · `timepoint[4]`. Returns
    /// [`SEMANTICS_REGULAR`] (`0x00`) when the `0x12` region is OMITTED (every
    /// pattern all-regular) OR when pattern `p` is itself all-regular
    /// (`Patterns.flags.bit0` set → it contributes NO bytes to `0x12`); the
    /// per-pattern offset therefore sums `stop_count` only over EARLIER patterns
    /// that are NOT all-regular (`pattern_emit.rs:170-178`). `None` for a no-band
    /// bundle, out-of-range `p`/`pos`, or a malformed read.
    pub fn band_semantics_byte(&self, p: usize, pos: usize) -> Option<u8> {
        let recs = self.patterns()?;
        let rec = recs.get(p)?;
        let s = rec.stop_count as usize;
        if pos >= s {
            return None;
        }
        // This pattern all-regular ⇒ no bytes contributed ⇒ regular default.
        if rec.flags & PATTERN_FLAG_ALL_REGULAR != 0 {
            return Some(SEMANTICS_REGULAR);
        }
        // Region omitted entirely (every pattern all-regular) ⇒ regular default.
        let sem = match self.pattern_semantics() {
            Some(b) => b,
            None => return Some(SEMANTICS_REGULAR),
        };
        // Per-pattern offset = Σ stop_count over EARLIER non-all-regular patterns.
        let mut base = 0usize;
        for q in 0..p {
            let r = recs.get(q)?;
            if r.flags & PATTERN_FLAG_ALL_REGULAR == 0 {
                base += r.stop_count as usize;
            }
        }
        sem.get(base + pos).copied()
    }

    /// True when boarding is FORBIDDEN at pattern `p`'s canonical position `pos`
    /// (`pickup_type == 1`), decoded from `0x12`. Mirrors [`Self::pickup_forbidden`]
    /// on the flat `0xFA` row. Regular default (all-regular pattern / omitted region)
    /// ⇒ `false`. `None` for a no-band bundle or out-of-range index.
    #[inline]
    pub fn band_pickup_forbidden(&self, p: usize, pos: usize) -> Option<bool> {
        Some(self.band_semantics_byte(p, pos)? & 0b11 == 1)
    }

    /// True when alighting is FORBIDDEN at pattern `p`'s canonical position `pos`
    /// (`drop_off_type == 1`), decoded from `0x12`. Mirrors
    /// [`Self::drop_off_forbidden`] on the flat `0xFA` row. `None` for a no-band
    /// bundle or out-of-range index.
    #[inline]
    pub fn band_drop_off_forbidden(&self, p: usize, pos: usize) -> Option<bool> {
        Some((self.band_semantics_byte(p, pos)? >> 2) & 0b11 == 1)
    }

    /// The `0x45 PatternsAtStop` CSR slice for stop `s` — the pattern ordinals
    /// serving this stop (deduped, per the build order). `None` for a no-band
    /// bundle or out-of-range `s`.
    pub fn patterns_at_stop(&self, s: usize) -> Option<&[u32]> {
        let band = self.pattern_band.as_ref()?;
        if s >= self.num_stops() {
            return None;
        }
        let (offsets, values) = self.csr_ranges(band.patterns_at_stop, self.num_stops())?;
        csr_slice(self.bytes.as_ref(), offsets, values, s).ok()
    }

    /// Per-pattern trip count = the `0x46` CSR slice length. Used by `trip_times`
    /// to size each pattern's `0x13` slab. Panic-free; `None` on a cast failure.
    #[inline]
    fn pattern_trips_len(&self, band: &PatternBand, p: usize) -> Option<usize> {
        let (offsets, values) = self.csr_ranges(band.pattern_trips, band.num_patterns)?;
        Some(
            csr_slice(self.bytes.as_ref(), offsets, values, p)
                .ok()?
                .len(),
        )
    }

    /// Split a CSR region entry into its `(offsets[n+1], values)` u32 ranges.
    /// `n` is the offsets count − 1 (numPatterns for `0x46`, numStops for `0x45`).
    /// The values length is read from `offsets[n]` (the last offset). Gated at
    /// load, so these are panic-free; `None` on the impossible cast failure.
    #[inline]
    fn csr_ranges(&self, entry: RegionEntry, n: usize) -> Option<(U32Range, U32Range)> {
        let buf = self.bytes.as_ref();
        let off_len = n.checked_add(1)?;
        let offsets = u32_range(buf, entry.offset, off_len).ok()?;
        let values_len = last_u32(buf, offsets) as usize;
        let values_start = entry.offset.checked_add(off_len.checked_mul(4)?)?;
        let values = u32_range(buf, values_start, values_len).ok()?;
        Some((offsets, values))
    }

    /// True when boarding is FORBIDDEN at stop_time `i` (`pickup_type == 1`).
    #[inline]
    pub fn pickup_forbidden(&self, i: usize) -> bool {
        self.boarding_byte(i) & 0b11 == 1
    }
    /// True when alighting is FORBIDDEN at stop_time `i` (`drop_off_type == 1`).
    #[inline]
    pub fn drop_off_forbidden(&self, i: usize) -> bool {
        (self.boarding_byte(i) >> 2) & 0b11 == 1
    }
    /// Hot-path accessor: resolve a stop's `stop_id` to a borrowed `&str`
    /// straight from the string pool, WITHOUT allocating the `stop_id`/`stop_name`
    /// Strings that `stop(i)` builds. We read the `id_idx` column and dereference
    /// the pool. The footpath relaxation pass (`scan.rs`) needs the
    /// source stop's id per walked source per round — `reader.stop(i)` there would
    /// allocate two Strings per call. Mirrors `stop_wheelchair_boarding`'s
    /// decode-one-field discipline.
    pub fn stop_id(&self, i: usize) -> Result<&str> {
        if i >= self.num_stops() {
            return Err(PtbError::SliceOutOfBounds { what: "stop index" });
        }
        let idx = rd_u32(self.bytes.as_ref(), self.stops_soa.id_idx.start + i * 4)?;
        self.pool()?.str_at(idx)
    }
    /// Zero-alloc: resolve a stop's `stop_name` to a borrowed `&str` straight from
    /// the string pool, WITHOUT allocating the `stop_id`/`stop_name` Strings that
    /// `stop(i)` builds, from the `name_idx` column. Mirrors `stop_id`; the
    /// projection uses it to avoid a full `stop(i)` decode just for the name.
    pub fn stop_name(&self, i: usize) -> Result<&str> {
        if i >= self.num_stops() {
            return Err(PtbError::SliceOutOfBounds { what: "stop index" });
        }
        let idx = rd_u32(self.bytes.as_ref(), self.stops_soa.name_idx.start + i * 4)?;
        self.pool()?.str_at(idx)
    }
    /// Zero-alloc: resolve a trip's `trip_id` from the string pool without
    /// allocating the full `TripRec`. Reads the u32 pool index at TripsIntern
    /// record offset +0 and dereferences the pool.
    pub fn trip_id(&self, i: usize) -> Result<&str> {
        let region = self.region_slice(Region::TripsIntern)?;
        if i >= self.num_trips() {
            return Err(PtbError::SliceOutOfBounds { what: "trip index" });
        }
        let idx = rd_u32(region, i * TRIP_RECORD_BYTES)?;
        self.pool()?.str_at(idx)
    }
    /// Zero-alloc: resolve a trip's `headsign` from the string pool (offset +4).
    pub fn trip_headsign(&self, i: usize) -> Result<&str> {
        let region = self.region_slice(Region::TripsIntern)?;
        if i >= self.num_trips() {
            return Err(PtbError::SliceOutOfBounds { what: "trip index" });
        }
        let idx = rd_u32(region, i * TRIP_RECORD_BYTES + 4)?;
        self.pool()?.str_at(idx)
    }
    /// Scalar accessor: `route_idx` for trip `i` (u32 at record offset +8).
    pub fn trip_route_idx(&self, i: usize) -> Result<u32> {
        let region = self.region_slice(Region::TripsIntern)?;
        if i >= self.num_trips() {
            return Err(PtbError::SliceOutOfBounds { what: "trip index" });
        }
        rd_u32(region, i * TRIP_RECORD_BYTES + 8)
    }
    /// Scalar accessor: `service_idx` for trip `i` (u32 at record offset +12).
    pub fn trip_service_idx(&self, i: usize) -> Result<u32> {
        let region = self.region_slice(Region::TripsIntern)?;
        if i >= self.num_trips() {
            return Err(PtbError::SliceOutOfBounds { what: "trip index" });
        }
        rd_u32(region, i * TRIP_RECORD_BYTES + 12)
    }
    /// Scalar accessor: `wheelchair_accessible` u8 for trip `i` (offset +16).
    pub fn trip_wheelchair(&self, i: usize) -> Result<u8> {
        let region = self.region_slice(Region::TripsIntern)?;
        if i >= self.num_trips() {
            return Err(PtbError::SliceOutOfBounds { what: "trip index" });
        }
        rd_u8(region, i * TRIP_RECORD_BYTES + 16)
    }
    /// Scalar accessor: `direction_id` u8 for trip `i` (offset +17).
    pub fn trip_direction_id(&self, i: usize) -> Result<u8> {
        let region = self.region_slice(Region::TripsIntern)?;
        if i >= self.num_trips() {
            return Err(PtbError::SliceOutOfBounds { what: "trip index" });
        }
        rd_u8(region, i * TRIP_RECORD_BYTES + 17)
    }
    /// Scalar accessor: `bikes_allowed` u8 for trip `i` (offset +18). 0 = no info,
    /// 1 = bikes allowed, 2 = no bikes. Mirrors `trip_wheelchair`.
    pub fn trip_bikes_allowed(&self, i: usize) -> Result<u8> {
        let region = self.region_slice(Region::TripsIntern)?;
        if i >= self.num_trips() {
            return Err(PtbError::SliceOutOfBounds { what: "trip index" });
        }
        rd_u8(region, i * TRIP_RECORD_BYTES + 18)
    }
    /// Resolve one of route `i`'s string columns (`col(s)`) from the StringPool.
    /// Bounds-checks `i` against `num_routes` first. The zero-alloc public accessors
    /// (`route_id` / `route_agency_id` / …) are thin wrappers over this helper.
    #[inline]
    fn route_str(&self, i: usize, col: impl Fn(&RoutesSoa) -> U32Range) -> Result<&str> {
        if i >= self.num_routes() {
            return Err(PtbError::SliceOutOfBounds {
                what: "route index",
            });
        }
        let idx = rd_u32(self.bytes.as_ref(), col(&self.routes_soa).start + i * 4)?;
        self.pool()?.str_at(idx)
    }
    /// Zero-alloc: resolve route `i`'s `route_id` from the string pool (`id_idx`
    /// column). Mirrors [`Reader::trip_id`] — the C2c
    /// `/scheduled-departures-for-stop` handler needs the `routeId` per surviving
    /// departure without allocating the full `RouteRec` via [`Reader::route`].
    pub fn route_id(&self, i: usize) -> Result<&str> {
        self.route_str(i, |s| s.id_idx)
    }
    /// Zero-alloc: route `i`'s `agency_id` (`agency_idx` column). Empty
    /// string when the feed omits it (GTFS `agency_id` is optional). Needed by
    /// `projection` + the TS loader's `decodeRoutes`.
    pub fn route_agency_id(&self, i: usize) -> Result<&str> {
        self.route_str(i, |s| s.agency_idx)
    }
    /// Zero-alloc: route `i`'s `short_name` (`short_idx` column).
    pub fn route_short_name(&self, i: usize) -> Result<&str> {
        self.route_str(i, |s| s.short_idx)
    }
    /// Zero-alloc: route `i`'s `long_name` (`long_idx` column). Needed by
    /// `projection` + the TS loader's `decodeRoutes`.
    pub fn route_long_name(&self, i: usize) -> Result<&str> {
        self.route_str(i, |s| s.long_idx)
    }
    /// Scalar: `route_type` u16 for route `i` (`route_type` column).
    pub fn route_type(&self, i: usize) -> Result<u16> {
        if i >= self.num_routes() {
            return Err(PtbError::SliceOutOfBounds {
                what: "route index",
            });
        }
        rd_u16(self.bytes.as_ref(), self.routes_soa.route_type + i * 2)
    }
    /// Zero-alloc: route `i`'s `route_color` (`color_idx` column).
    pub fn route_color(&self, i: usize) -> Result<&str> {
        self.route_str(i, |s| s.color_idx)
    }
    /// Zero-alloc: route `i`'s `route_text_color` (`text_color_idx` column).
    pub fn route_text_color(&self, i: usize) -> Result<&str> {
        self.route_str(i, |s| s.text_color_idx)
    }
    /// Raw bytes of region `r` exactly as described by the header region table.
    pub fn region_bytes(&self, r: Region) -> Result<&[u8]> {
        self.region_slice(r)
    }

    pub fn stop_time(&self, i: usize) -> Result<StopTime> {
        let n = self.num_stop_times();
        if i >= n {
            return Err(PtbError::SliceOutOfBounds {
                what: "stop_time index",
            });
        }
        // CARRY-LESS (B1.5-T4a): the flat `0xF4 StopTimes` carry is stripped, so
        // `region_slice(StopTimes)` is the zero-length slot and a flat decode would
        // OOB. The band is the SOLE timetable — reconstruct row `i`'s `StopTime`
        // from it, EXACTLY as `projection::project`'s `is_carry_less_band()` branch
        // does (which in turn mirrors TS `bandToFlatStopTimes`), so any consumer of
        // `stop_time(i)` (pt-serve C2a `/stops`, C2c `/scheduled-departures-for-stop`)
        // sees field-identical rows on band-only bundles. The carry-BEARING path
        // (any bundle still carrying `0xF4`) reads the flat row below.
        if self.is_carry_less_band() {
            return self.band_stop_time(i);
        }
        let region = self.region_slice(Region::StopTimes)?;
        crate::records::decode_stop_time_soa(region, i, n)
    }

    /// Map synthesized flat row `i` of a carry-less bundle to `(trip, canonical
    /// position, pattern)`: the trip whose synthesized `trip_starts` range holds
    /// `i`, the offset into that range, and the trip's `0x14` pattern backref.
    fn band_row_coords(&self, i: usize) -> Result<(usize, usize, usize)> {
        let ts = self.trip_starts()?;
        // `trip_starts` is monotonic non-decreasing with `ts[0] == 0` and
        // `ts.last() == num_stop_times` (validated at load); `i < num_stop_times`
        // here, so `partition_point` lands inside `0..num_trips`.
        let t = ts
            .partition_point(|&start| start as usize <= i)
            .saturating_sub(1);
        let trip_start = *ts.get(t).ok_or(PtbError::CsrInvalid {
            detail: "carry-less stop_time: trip start out of range",
        })? as usize;
        let pos = i - trip_start;
        let p = self
            .trip_pattern_idx(t)
            .ok_or(PtbError::PatternBandInvalid {
                reason: "carry-less stop_time: trip pattern idx",
            })? as usize;
        Ok((t, pos, p))
    }

    /// The flat-format boarding byte for synthesized row `i` of a carry-less
    /// bundle, rebuilt from the band's `0x12` semantics: the pickup/drop-off
    /// nibble comes from the pattern position, and the continuous-service bits
    /// keep the `0x50` default (the band does not carry them). `None` when the
    /// row does not map onto the band.
    fn band_boarding_byte(&self, i: usize) -> Option<u8> {
        if i >= self.num_stop_times() {
            return None;
        }
        let (_, pos, p) = self.band_row_coords(i).ok()?;
        Some(0x50 | (self.band_semantics_byte(p, pos)? & 0x0F))
    }

    /// Reconstruct the `i`-th flat `StopTime` from the pattern band on a carry-less
    /// bundle. Caller (`stop_time`) has already bounds-checked `i < num_stop_times`.
    ///
    /// Mapping (mirrors `projection::project`'s carry-less reconstruction):
    /// - global row `i` → trip `t` via the synthesized `trip_starts()` prefix-sum
    ///   (`trip_starts[t] <= i < trip_starts[t+1]`), canonical position `pos = i -
    ///   trip_starts[t]`;
    /// - `p = trip_pattern_idx(t)`; LOCAL slab row `j` = `t`'s position in
    ///   `pattern_trips(p)`;
    /// - `stop_idx = pattern_stops(p)[pos]` (the `0x11` ordinal);
    /// - `dep_secs`/`arr_diff` from `band_dep_secs`/`band_arr_secs` — a NOT_SERVED
    ///   position decodes to the flat carry's sentinel (`dep_secs = 0xFFFF_FFFF`,
    ///   `arr_diff = 0`), matching `bandToFlatStopTimes`;
    /// - `stop_seq = pos` (the band carries no GTFS `stop_sequence`; the carry-less
    ///   convention sets it to the canonical position, matching `project()` + TS).
    fn band_stop_time(&self, i: usize) -> Result<StopTime> {
        let (t, pos, p) = self.band_row_coords(i)?;
        let pattern_trips = self.pattern_trips(p).ok_or(PtbError::PatternBandInvalid {
            reason: "carry-less stop_time: pattern_trips",
        })?;
        // LOCAL slab row = position of global trip `t` in pattern_trips(p).
        let j = pattern_trips
            .iter()
            .position(|&gt| gt as usize == t)
            .ok_or(PtbError::PatternBandInvalid {
                reason: "carry-less stop_time: trip absent from its pattern",
            })?;
        let stops = self.pattern_stops(p).ok_or(PtbError::PatternBandInvalid {
            reason: "carry-less stop_time: pattern_stops",
        })?;
        let stop_idx = *stops.get(pos).ok_or(PtbError::SliceOutOfBounds {
            what: "carry-less stop_time position",
        })?;

        let dep = self
            .band_dep_secs(p, j, pos)
            .ok_or(PtbError::PatternBandInvalid {
                reason: "carry-less stop_time: band dep",
            })?;
        let (dep_secs, arr_diff) = if dep == BAND_NOT_SERVED {
            // NOT_SERVED hole: 0xFFFFFFFF dep, 0 arrDiff — the flat carry's sentinel
            // and TS `bandToFlatStopTimes`.
            (0xFFFF_FFFFu32, 0i16)
        } else {
            let arr = self
                .band_arr_secs(p, j, pos)
                .ok_or(PtbError::PatternBandInvalid {
                    reason: "carry-less stop_time: band arr",
                })?;
            // `arr - dep` is the GTFS dwell delta (`<= 0`), which originated as an
            // `i16 arr_diff` before band encoding, so it round-trips into `i16`.
            let diff = arr - dep;
            (
                dep as u32,
                i16::try_from(diff).map_err(|_| PtbError::PatternBandInvalid {
                    reason: "carry-less stop_time: arr_diff out of i16 range",
                })?,
            )
        };

        Ok(StopTime {
            dep_secs,
            arr_diff,
            stop_idx,
            // `stop_seq` is u16; canonical positions are small (pattern stop counts),
            // so `pos` fits — guard rather than silently truncate.
            stop_seq: u16::try_from(pos).map_err(|_| PtbError::SliceOutOfBounds {
                what: "carry-less stop_time: stop_seq exceeds u16",
            })?,
        })
    }
    /// Narrow departure-only read of stop-time `i` — the hot RAPTOR scan path
    /// (`dep_secs_at`) needs only `dep_secs`. On the current SoA layout this touches a
    /// single cache line (the dep column at `4*i`) instead of the four `stop_time`
    /// would read. Equal to `stop_time(i).dep_secs` for every `i` (asserted in
    /// `dep_secs_matches_stop_time_dep_current_flat_layout`).
    pub fn dep_secs(&self, i: usize) -> Result<u32> {
        let n = self.num_stop_times();
        if i >= n {
            return Err(PtbError::SliceOutOfBounds {
                what: "stop_time index",
            });
        }
        // CARRY-LESS (B1.5-T4a): same dispatch `stop_time` performs, for the same
        // reason — `region_slice(StopTimes)` is the zero-length stripped slot, so the
        // flat decode below would OOB-read it. `stop_time` gained this branch;
        // `dep_secs`, its departure-only twin, did not, which left the flat scan path
        // (`scan::dep_secs_at` for a trip with `band == None`, i.e. `PatternMode::Off`)
        // failing with a bare `SliceOutOfBounds { what: "u32 field" }` on every
        // carry-less bundle. Equal to `stop_time(i).dep_secs` here as everywhere else
        // (the narrow-read optimisation this function exists for only applies to the
        // flat layouts; on the band the cheapest correct read is the shared one).
        if self.is_carry_less_band() {
            return Ok(self.band_stop_time(i)?.dep_secs);
        }
        let region = self.region_slice(Region::StopTimes)?;
        crate::records::decode_stop_time_soa_dep(region, i)
    }
    /// Decode the `i`-th GTFS `transfers.txt` rule from the `0xF8 Transfers` region.
    ///
    /// Carried only in S0 — the RAPTOR scan never calls this; it exists so the
    /// rules round-trip and so S1–S3 can apply them. Bounds-checked like the
    /// other record accessors. GTFS reference:
    /// https://gtfs.org/documentation/schedule/reference/#transferstxt
    pub fn transfer(&self, i: usize) -> Result<TransferRule> {
        let region = self.region_slice(Region::Transfers)?;
        if i >= self.num_transfers() {
            return Err(PtbError::SliceOutOfBounds {
                what: "transfer index",
            });
        }
        decode_transfer(region, i * TRANSFER_RECORD_BYTES)
    }
    /// Zero-alloc string lookup straight from the pool view.
    pub fn string(&self, idx: u32) -> Result<&str> {
        self.pool()?.str_at(idx)
    }

    // ---- zero-copy CSR / tripStarts views ----
    pub fn trip_starts(&self) -> Result<&[u32]> {
        // Carry-less (B1.5-T4a): the synthesized `(num_trips+1)` prefix-sum
        // (band position counts) instead of the stripped `0xF5` carry. `build_from_band`
        // reads it ONLY for the Pin-6 monotonic / length validation.
        if let Some(ts) = &self.synth_trip_starts {
            return Ok(ts.as_slice());
        }
        cast_u32(self.bytes.as_ref(), self.trip_starts)
    }
    /// Trip indices on route `r` (CSR slice). `Err` if `r` is out of range.
    pub fn route_trips(&self, r: usize) -> Result<&[u32]> {
        // Carry-less (B1.5-T4a): the route→trips CSR synthesized from each trip's
        // `0xF2 TripsIntern` `route_idx` backref (the carry `0xF6` is stripped). Same
        // value-array ORDER as the carry CSR (ascending trip ordinal within a route),
        // so the index built over it is identical.
        if let (Some(off), Some(val)) = (&self.synth_rt_offsets, &self.synth_rt_values) {
            let lo = *off.get(r).ok_or(PtbError::SliceOutOfBounds {
                what: "route index",
            })? as usize;
            let hi = *off.get(r + 1).ok_or(PtbError::SliceOutOfBounds {
                what: "route index",
            })? as usize;
            return val.get(lo..hi).ok_or(PtbError::CsrInvalid {
                detail: "synth route_trips slice out of range",
            });
        }
        csr_slice(self.bytes.as_ref(), self.rt_offsets, self.rt_values, r)
    }
    /// Route indices serving stop `s` (CSR slice). `Err` if `s` is out of range.
    ///
    /// Carry-less: the stop→routes CSR (`0xF6`) is stripped and NOT
    /// re-materialized — the band path derives `routes_at_stop` from `0x45`
    /// PatternsAtStop, so this accessor is unreachable there.
    ///
    /// A carry-less call returns `Err` (the zero-length stripped slot). Callers on
    /// that path must derive the table instead: `Index::build_flat`'s `Off` branch
    /// rebuilds it from each route's canonical `stop_ids`, which is the same table
    /// by construction (see the Pin 5 note there).
    ///
    /// `Off` on a carry-less bundle is a supported combination: `Index::build`
    /// takes the band only when `mode != Off`, so every `Off` build reaches the
    /// flat path. The `off` rows of the committed raptor goldens exercise it.
    pub fn stop_routes(&self, s: usize) -> Result<&[u32]> {
        csr_slice(self.bytes.as_ref(), self.sr_offsets, self.sr_values, s)
    }
    pub fn stop_index(&self, stop_id: &str) -> Option<u32> {
        self.lookups.fetch_add(1, Ordering::Relaxed);
        match &self.stop_index {
            StopIndexSource::Eager(m) => m.get(stop_id).copied(),
            // mmap path: binary-search the persisted region by fnv32, then a
            // full-string tiebreak against the pool so a hash collision can never
            // return a wrong ordinal. The transient pool view is
            // cheap offset math; nothing was decoded at load.
            StopIndexSource::Persisted { offset, length } => {
                let region = self.bytes.as_ref().get(*offset..*offset + *length)?;
                let pool = self.pool().ok()?;
                crate::stop_index::lookup(region, stop_id, |idx| pool.str_at(idx).ok())
            }
        }
    }

    /// True when this reader resolves `stop_index` from the bundle's persisted
    /// StopIndex region (the mmap path — no eager `HashMap` built at load),
    /// false when it built the eager `HashMap<String,u32>` (a bundle lacking the
    /// region). A load diagnostic: the
    /// Index::build-vs-mmap measurement and pt-serve load accounting use it to
    /// confirm the cold-start rebuild was avoided.
    pub fn stop_index_is_persisted(&self) -> bool {
        matches!(self.stop_index, StopIndexSource::Persisted { .. })
    }

    /// Cumulative count of `stop_index` lookups served (hit or miss). A read-only
    /// observability metric — read the delta around a query to get lookups per
    /// query. `stop_index` is NOT the RAPTOR hot loop (route scanning is
    /// ordinal-only); it fires at query entry/exit resolution and, when the
    /// bundle carries a footpath table, once per relaxed footpath edge.
    pub fn stop_index_lookups(&self) -> u64 {
        self.lookups.load(Ordering::Relaxed)
    }

    // ---- raw on-disk CSR array views (zero-copy) ----
    // Whole-array views over the bytes exactly as laid out on disk. The
    // projection emits THESE (not arrays reconstructed from per-row accessors)
    // so the cross-language parity gate compares source-of-truth bytes: a
    // non-canonical-but-valid offsets array (e.g. `offsets[0] != 0`) shows up as
    // a diff instead of being silently re-normalised by a prefix-sum rebuild.
    pub fn route_trips_offsets(&self) -> Result<&[u32]> {
        // Carry-less (B1.5-T4a): the `0xF6 Csr` carry is stripped, so the raw
        // on-disk range is zero-length. The route→trips CSR was synthesized from
        // the surviving `0xF2 TripsIntern` route backref — the source-of-truth
        // carry-less. Mirrors `trip_starts()` / `route_trips()`.
        if let Some(off) = &self.synth_rt_offsets {
            return Ok(off.as_slice());
        }
        cast_u32(self.bytes.as_ref(), self.rt_offsets)
    }
    pub fn route_trips_values(&self) -> Result<&[u32]> {
        if let Some(val) = &self.synth_rt_values {
            return Ok(val.as_slice());
        }
        cast_u32(self.bytes.as_ref(), self.rt_values)
    }
    pub fn stop_routes_offsets(&self) -> Result<&[u32]> {
        cast_u32(self.bytes.as_ref(), self.sr_offsets)
    }
    pub fn stop_routes_values(&self) -> Result<&[u32]> {
        cast_u32(self.bytes.as_ref(), self.sr_values)
    }

    /// Raw bitmask slice for a service (`bytes_per_service()` bytes — 12 at the
    /// default 90-day window), or empty if out of range.
    ///
    /// `service_idx` is a free public param — bound it against `num_services`
    /// FIRST, then compute the byte range with checked arithmetic. On wasm32
    /// (`usize == u32`) `service_idx * stride` would otherwise overflow → debug panic
    /// / release silent-wrong-answer. Returns `&[]` on any out-of-range/overflow,
    /// which makes `service_active_on` panic-free on arbitrary input.
    pub fn service_bitmask(&self, service_idx: u32) -> &[u8] {
        if service_idx >= self.header.num_services {
            return &[];
        }
        // The per-service bitfield is indirected through the
        // `0x16 ServiceToBitfield` index into the `0x15 ServiceBitfieldPool`.
        // Panic-free: any OOB / overflow returns `&[]` (the load-time exact-size
        // gates make a malformed pool impossible; this stays defensive).
        let (pool, s2b) = (self.service_pool, self.service_to_bitfield);
        let buf = self.bytes.as_ref();
        // Read the pool index for this service from the `0x16` body @ idx*4.
        let i_start = match (service_idx as usize).checked_mul(4) {
            Some(s) => s,
            None => return &[],
        };
        let i_end = match i_start.checked_add(4) {
            Some(e) => e,
            None => return &[],
        };
        let s2b_body = match buf.get(s2b.offset..s2b.offset + s2b.length) {
            Some(b) => b,
            None => return &[],
        };
        let pool_idx = match s2b_body.get(i_start..i_end) {
            Some(b) => u32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            None => return &[],
        };
        // Slice the `0x15` pool, skipping its 4-byte `count` prefix, at
        // `pool_idx * S .. + S` with checked arithmetic.
        let pool_body = match buf.get(pool.offset..pool.offset + pool.length) {
            Some(b) => b,
            None => return &[],
        };
        let payload = match pool_body.get(4..) {
            Some(p) => p,
            None => return &[],
        };
        let start = match (pool_idx as usize).checked_mul(self.bytes_per_service) {
            Some(s) => s,
            None => return &[],
        };
        let end = match start.checked_add(self.bytes_per_service) {
            Some(e) => e,
            None => return &[],
        };
        payload.get(start..end).unwrap_or(&[])
    }
    /// The in-window day offset for `date` (YYYYMMDD), or `None` when `date` falls
    /// outside the `[feedStartDate, feedStartDate + window_days)` window.
    ///
    /// This is the single window guard shared by every active-on-date check:
    /// `service_active_on` (per-service) and the decode-once pool path
    /// (`engine::service::active_services`) both compute `day` via this, then call
    /// [`service_active_bit`] on the relevant bitfield slice — so the pool path
    /// and the per-service path apply IDENTICAL day/bit logic (equivalence). The
    /// guard is keyed on the RUNTIME `window_days` (the `0x01 WindowMeta` region,
    /// default 90); if this stayed the fixed 90 while the window grew, an in-window
    /// far-future day would be wrongly reported inactive.
    #[inline]
    pub(crate) fn day_offset(&self, date: u32) -> Option<u32> {
        match days_between(self.header.feed_start_date, date) {
            Some(d) if d < self.window_days as u32 => Some(d),
            _ => None,
        }
    }
    /// [`Self::service_active_on`] for the date `day` days after the feed start
    /// (`days_add(feed_start_date, day)`), without the calendar round trip: that
    /// date's `day_offset` is `day` itself, so this is the same bit.
    #[inline]
    pub(crate) fn service_active_on_day(&self, service_idx: u32, day: u32) -> bool {
        day < self.window_days as u32 && service_active_bit(self.service_bitmask(service_idx), day)
    }
    /// True iff service `service_idx` runs on `date` (YYYYMMDD). False outside the window.
    pub fn service_active_on(&self, service_idx: u32, date: u32) -> bool {
        let day = match self.day_offset(date) {
            Some(d) => d,
            None => return false,
        };
        service_active_bit(self.service_bitmask(service_idx), day)
    }

    /// The raw `S`-byte bitfield slice for distinct-pool index `pool_idx` in the
    /// `0x15 ServiceBitfieldPool`, or `&[]` when out of range.
    ///
    /// decode-once: `engine::service::active_services` evaluates each of
    /// the `service_bitfield_pool_count()` distinct bitfields ONCE, instead of
    /// re-resolving the indirection per service. Reads ONLY the cached `0x15`
    /// entry (skipping its 4-byte `count` prefix); panic-free on any OOB/overflow
    /// (mirrors `service_bitmask`'s defensive slicing). The load-time gates (Step
    /// 2) guarantee `pool.length == 4 + count*S`, so `pool_idx < count` is always
    /// in range.
    pub(crate) fn service_pool_bitfield(&self, pool_idx: u32) -> &[u8] {
        let pool = self.service_pool;
        let buf = self.bytes.as_ref();
        let pool_body = match buf.get(pool.offset..pool.offset + pool.length) {
            Some(b) => b,
            None => return &[],
        };
        let payload = match pool_body.get(4..) {
            Some(p) => p,
            None => return &[],
        };
        let start = match (pool_idx as usize).checked_mul(self.bytes_per_service) {
            Some(s) => s,
            None => return &[],
        };
        let end = match start.checked_add(self.bytes_per_service) {
            Some(e) => e,
            None => return &[],
        };
        payload.get(start..end).unwrap_or(&[])
    }

    /// The distinct-pool index that service `service_idx` maps to via the
    /// `0x16 ServiceToBitfield` region, or `None` when out of range.
    ///
    /// decode-once: after evaluating `poolActive[0..count]`, the membership
    /// for service `s` is `poolActive[service_pool_index(s)]`. Reads ONLY the cached
    /// `0x16` entry (one LE u32 per service); panic-free on any OOB/overflow. The
    /// load-time gates guarantee `s2b.length == num_services*4` and every entry
    /// `< count`, so a returned index is always a valid `service_pool_bitfield` index.
    pub(crate) fn service_pool_index(&self, service_idx: u32) -> Option<u32> {
        let s2b = self.service_to_bitfield;
        let buf = self.bytes.as_ref();
        let i_start = (service_idx as usize).checked_mul(4)?;
        let i_end = i_start.checked_add(4)?;
        let s2b_body = buf.get(s2b.offset..s2b.offset + s2b.length)?;
        let b = s2b_body.get(i_start..i_end)?;
        Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    // ---- internal helpers ----
    #[inline]
    fn region_slice(&self, r: Region) -> Result<&[u8]> {
        region_slice(self.bytes.as_ref(), &self.header, r)
    }
    /// Build a transient `StringPool` view from the stored region range. Cheap
    /// (just offset math); rebuilt per string-returning accessor.
    #[inline]
    fn pool(&self) -> Result<StringPool<'_>> {
        pool_view(self.bytes.as_ref(), &self.header)
    }
}

#[inline]
fn pool_view<'a>(buf: &'a [u8], h: &Header) -> Result<StringPool<'a>> {
    let region = region_slice(buf, h, Region::StringPool)?;
    StringPool::parse(region, h.region(Region::StringPool).length)
}

#[inline]
fn region_slice<'a>(buf: &'a [u8], h: &Header, r: Region) -> Result<&'a [u8]> {
    let e = h.region(r);
    buf.get(e.offset..e.offset + e.length)
        .ok_or(PtbError::RegionOutOfBounds {
            region: r.name(),
            offset: e.offset as u64,
            length: e.length as u64,
            buf: buf.len(),
        })
}

/// Capacity check for a record region: `count*stride <= region.len` (checked_mul
/// for the wasm32 `usize==u32` overflow case). Real region name in the error.
fn check_table(h: &Header, r: Region, count: u32, stride: usize, name: &'static str) -> Result<()> {
    let need = (count as usize)
        .checked_mul(stride)
        .ok_or(PtbError::CountExceedsRegion { region: name })?;
    if need > h.region(r).length {
        return Err(PtbError::CountExceedsRegion { region: name });
    }
    Ok(())
}

/// Compute + bounds-check a `(start, len)` u32-array range against `buf`.
fn u32_range(buf: &[u8], start: usize, len: usize) -> Result<U32Range> {
    let bytes = len
        .checked_mul(4)
        .ok_or(PtbError::SliceOutOfBounds { what: "u32 slice" })?;
    let end = start
        .checked_add(bytes)
        .ok_or(PtbError::SliceOutOfBounds { what: "u32 slice" })?;
    if end > buf.len() {
        return Err(PtbError::SliceOutOfBounds { what: "u32 slice" });
    }
    Ok(U32Range { start, len })
}

/// Zero-copy `&[u32]` view over a validated range, via a CHECKED cast.
/// `try_cast_slice` returns `Err` on misalignment or `len % 4 != 0` (never
/// `align_to`, which silently drops a misaligned head/tail). The CSR region is
/// page-aligned so it casts fine; corruption surfaces as `PtbError::Misaligned`.
fn cast_u32(buf: &[u8], range: U32Range) -> Result<&[u32]> {
    let bytes = buf
        .get(range.start..range.start + range.len * 4)
        .ok_or(PtbError::SliceOutOfBounds { what: "u32 slice" })?;
    bytemuck::try_cast_slice::<u8, u32>(bytes)
        .map_err(|_| PtbError::Misaligned { what: "u32 array" })
}

/// Zero-copy `&[i32]` view over a validated range, via a CHECKED cast — the
/// signed twin of [`cast_u32`] for the SoA `lat_e7`/`lon_e7` columns
/// (`i32@1e7`). `try_cast_slice::<u8, i32>` is STRICT: it returns `Err` on a
/// misaligned start (`TargetAlignmentGreaterAndInputNotAligned`) OR a non-`%4`
/// length (`OutputSliceWouldHaveSlop`) and never `align_to`s; BOTH map to
/// `PtbError::Misaligned`. A 4-aligned region start + a `count*4` byte length
/// (asserted at column resolution) make a valid bundle cast cleanly; corruption
/// surfaces here rather than silently truncating. Read by the SoA coordinate
/// accessors (`stop_lat_e7`/`stop_lon_e7` and `stop`).
fn cast_i32(buf: &[u8], range: U32Range) -> Result<&[i32]> {
    let bytes = buf
        .get(range.start..range.start + range.len * 4)
        .ok_or(PtbError::SliceOutOfBounds { what: "i32 slice" })?;
    bytemuck::try_cast_slice::<u8, i32>(bytes).map_err(|_| PtbError::Misaligned {
        what: "lat_e7/lon_e7 i32 column",
    })
}

/// A `u32` SoA column: `count` elements of 4 bytes starting at
/// `region_offset + col_index * 4 * count`. Bounds-checked against `buf`.
fn soa_u32_col(
    buf: &[u8],
    region_offset: usize,
    col_index: usize,
    count: usize,
) -> Result<U32Range> {
    let start = col_index
        .checked_mul(4)
        .and_then(|w| w.checked_mul(count))
        .and_then(|off| region_offset.checked_add(off))
        .ok_or(PtbError::SliceOutOfBounds { what: "soa column" })?;
    u32_range(buf, start, count)
}

/// Validate the `StopTimes` (`0xF4`) region as four contiguous SoA columns:
/// (1) `e.offset` is 4-aligned
/// (the dep/stop_idx `u32` columns are cast/decoded at 4-byte strides) and
/// (2) `e.length` is a TIGHT multiple of `STOP_TIME_ROW_BYTES` (= `12*N`), so
/// the column bases `4N`/`8N`/`10N` and the `length/12` row count agree with no
/// dangling tail. The region is already bounds-checked against `buf` in
/// `Header::parse`, so no further `buf`-length check is needed. Mirrors the
/// `Misaligned` / `CountExceedsRegion` error shapes used by `resolve_stops_soa`.
fn resolve_stop_times_soa(buf: &[u8], header: &Header) -> Result<()> {
    let _ = buf; // bounds already enforced in `Header::parse`; kept for signature symmetry
    let e = header.region(Region::StopTimes);
    if !e.offset.is_multiple_of(4) {
        return Err(PtbError::Misaligned {
            what: "stopTimesSoA region offset",
        });
    }
    if !e.length.is_multiple_of(STOP_TIME_ROW_BYTES) {
        return Err(PtbError::CountExceedsRegion {
            region: "stopTimesSoA",
        });
    }
    Ok(())
}

/// Resolve the `StopsSoA` (`0x40`) column ranges from its region entry.
/// `e.offset` must be 4-aligned (the `u32`/`i32` cast contract) and the region
/// must hold the tight column total `N*21` (five 4-byte columns + one `u8`).
fn resolve_stops_soa(buf: &[u8], e: crate::header::RegionEntry, n: usize) -> Result<StopsSoa> {
    if !e.offset.is_multiple_of(4) {
        return Err(PtbError::Misaligned {
            what: "stopsSoA region offset",
        });
    }
    // Tight total: 5 columns * 4 bytes + 1 byte, all * N. checked for wasm32.
    let tight = n
        .checked_mul(21)
        .ok_or(PtbError::CountExceedsRegion { region: "stopsSoA" })?;
    if e.length < tight {
        return Err(PtbError::CountExceedsRegion { region: "stopsSoA" });
    }
    let wheelchair_start = n
        .checked_mul(20)
        .and_then(|off| e.offset.checked_add(off))
        .ok_or(PtbError::SliceOutOfBounds {
            what: "wheelchair column",
        })?;
    let wheelchair_end = wheelchair_start
        .checked_add(n)
        .ok_or(PtbError::SliceOutOfBounds {
            what: "wheelchair column",
        })?;
    if wheelchair_end > buf.len() {
        return Err(PtbError::SliceOutOfBounds {
            what: "wheelchair column",
        });
    }
    let lat_e7 = soa_u32_col(buf, e.offset, 2, n)?;
    let lon_e7 = soa_u32_col(buf, e.offset, 3, n)?;

    // Cast each column ONCE and scan — O(N) integer compares, no allocation (does NOT regress the
    // load win, which was about String allocations). Hoisted here out of
    // `validate_stops_soa_structural` so a malformed coord is caught by `from_bytes`, not deferred
    // to validation.
    for &v in cast_i32(buf, lat_e7)? {
        if !(-900_000_000..=900_000_000).contains(&v) {
            return Err(PtbError::CoordOutOfRange { axis: "lat_e7" });
        }
    }
    for &v in cast_i32(buf, lon_e7)? {
        if !(-1_800_000_000..=1_800_000_000).contains(&v) {
            return Err(PtbError::CoordOutOfRange { axis: "lon_e7" });
        }
    }

    Ok(StopsSoa {
        id_idx: soa_u32_col(buf, e.offset, 0, n)?,
        name_idx: soa_u32_col(buf, e.offset, 1, n)?,
        lat_e7,
        lon_e7,
        parent_idx: soa_u32_col(buf, e.offset, 4, n)?,
        wheelchair: wheelchair_start,
    })
}

/// Resolve the `RoutesSoA` (`0x41`) column ranges. Six `u32` idx columns then a
/// `u16 route_type` column; tight total `M*26`; `e.offset` 4-aligned.
fn resolve_routes_soa(buf: &[u8], e: crate::header::RegionEntry, m: usize) -> Result<RoutesSoa> {
    if !e.offset.is_multiple_of(4) {
        return Err(PtbError::Misaligned {
            what: "routesSoA region offset",
        });
    }
    let tight = m.checked_mul(26).ok_or(PtbError::CountExceedsRegion {
        region: "routesSoA",
    })?;
    if e.length < tight {
        return Err(PtbError::CountExceedsRegion {
            region: "routesSoA",
        });
    }
    let rt_start = m
        .checked_mul(24)
        .and_then(|off| e.offset.checked_add(off))
        .ok_or(PtbError::SliceOutOfBounds {
            what: "route_type column",
        })?;
    let rt_bytes = m.checked_mul(2).ok_or(PtbError::SliceOutOfBounds {
        what: "route_type column",
    })?;
    let rt_end = rt_start
        .checked_add(rt_bytes)
        .ok_or(PtbError::SliceOutOfBounds {
            what: "route_type column",
        })?;
    if rt_end > buf.len() {
        return Err(PtbError::SliceOutOfBounds {
            what: "route_type column",
        });
    }
    Ok(RoutesSoa {
        id_idx: soa_u32_col(buf, e.offset, 0, m)?,
        agency_idx: soa_u32_col(buf, e.offset, 1, m)?,
        short_idx: soa_u32_col(buf, e.offset, 2, m)?,
        long_idx: soa_u32_col(buf, e.offset, 3, m)?,
        color_idx: soa_u32_col(buf, e.offset, 4, m)?,
        text_color_idx: soa_u32_col(buf, e.offset, 5, m)?,
        route_type: rt_start,
    })
}

/// Read the last entry of an offsets range without panicking on an empty range.
/// Returning 0 on a cast/bounds failure is intentional: the same range is
/// re-validated downstream by `u32_range`/`validate_csr`, which surface the real
/// error — a silent 0 here just produces a benign zero-length values slice that
/// those checks then reject if the bundle is actually corrupt.
#[inline]
fn last_u32(buf: &[u8], range: U32Range) -> u32 {
    match cast_u32(buf, range) {
        Ok(s) => s.last().copied().unwrap_or(0),
        Err(_) => 0,
    }
}

/// Sub-slice the CSR `values` array by `offsets[i]..offsets[i+1]`. `Err` on an
/// out-of-range `i` (cleaner than a silent `&[]`).
fn csr_slice(buf: &[u8], offsets: U32Range, values: U32Range, i: usize) -> Result<&[u32]> {
    let off = cast_u32(buf, offsets)?;
    let val = cast_u32(buf, values)?;
    // i.checked_add(1): i == usize::MAX would overflow the `i + 1` index.
    let i1 = i
        .checked_add(1)
        .ok_or(PtbError::SliceOutOfBounds { what: "csr index" })?;
    match (off.get(i), off.get(i1)) {
        (Some(&lo), Some(&hi))
            if (lo as usize) <= val.len() && (hi as usize) <= val.len() && lo <= hi =>
        {
            Ok(&val[lo as usize..hi as usize])
        }
        (Some(_), Some(_)) => Err(PtbError::CsrInvalid {
            detail: "csr offsets out of range",
        }),
        _ => Err(PtbError::SliceOutOfBounds { what: "csr index" }),
    }
}

fn validate_csr(
    rt_off: &[u32],
    rt_val: &[u32],
    sr_off: &[u32],
    sr_val: &[u32],
    n_trips: usize,
    n_routes: usize,
) -> Result<()> {
    for w in rt_off.windows(2) {
        if w[1] < w[0] {
            return Err(PtbError::CsrInvalid {
                detail: "rtOffsets not monotonic",
            });
        }
    }
    if rt_off.last().copied().unwrap_or(0) as usize != n_trips {
        return Err(PtbError::CsrInvalid {
            detail: "rtOffsets[last] != trips.len",
        });
    }
    if rt_val.iter().any(|&v| v as usize >= n_trips) {
        return Err(PtbError::CsrInvalid {
            detail: "rtValue out of range",
        });
    }
    for w in sr_off.windows(2) {
        if w[1] < w[0] {
            return Err(PtbError::CsrInvalid {
                detail: "srOffsets not monotonic",
            });
        }
    }
    if sr_off.last().copied().unwrap_or(0) as usize != sr_val.len() {
        return Err(PtbError::CsrInvalid {
            detail: "srOffsets[last] != srValues.len",
        });
    }
    if sr_val.iter().any(|&v| v as usize >= n_routes) {
        return Err(PtbError::CsrInvalid {
            detail: "srValue out of range",
        });
    }
    Ok(())
}

/// Read ONE `0x13` dep/dwell delta at byte offset `off`, width `delta_bytes`
/// (`2` → `i16`, `4` → `i32`), sign-extended to `i64`. `None` on an OOB read or
/// an unexpected width (the only two widths the format defines are 2 and 4). The
/// width is REGION-level (the `0x13` entryFlags bit1), fixed once per region.
#[inline]
fn rd_delta(buf: &[u8], off: usize, delta_bytes: usize) -> Option<i64> {
    match delta_bytes {
        2 => rd_i16(buf, off).ok().map(|v| v as i64),
        4 => rd_i32(buf, off).ok().map(|v| v as i64),
        _ => None,
    }
}

/// Byte span of ONE pattern's `0x13 TripTimes` slab. `delta_bytes` is the width
/// of ONE delta element — `2` for the `i16` layout (the BYTE-IDENTICAL fast
/// path) or `4` for the `i32`-delta variant (entryFlags bit1). The slab is
/// `T*(4 + 2*W*S + ceil(S/8))`: `T` × (`trip_first_dep u32` + `dep_deltas[S]` +
/// `dwell_deltas[S]` each `W` bytes + `served_bits[ceil(S/8)]`). `checked_*` keeps
/// the math sound on wasm32 (`usize == u32`); `None` on overflow. Mirrors the
/// locked-layout `0x13` size + the i32-delta design spec.
#[inline]
fn pattern_trip_times_span(t: usize, s: usize, delta_bytes: usize) -> Option<usize> {
    let bits = s.checked_add(7)? / 8; // ceil(S/8); s+7 cannot overflow for any real S
    let per_trip = s
        .checked_mul(delta_bytes)? // dep_deltas[S] (W B each) +
        .checked_mul(2)? // dwell_deltas[S] (W B each) = 2*W*S
        .checked_add(4)? // trip_first_dep u32
        .checked_add(bits)?; // served_bits ceil(S/8)
    t.checked_mul(per_trip)
}

/// Resolve + GATE the pattern band (`0x10`-`0x14` / `0x45`/`0x46`) ONCE at
/// load (B1.2 Task A). Returns `None` when the band is absent (the `0x10`
/// region is missing — a staging bundle `Index::build` routes to the flat
/// carry); `Some` only after every hard gate passes, so the reader accessors are
/// panic-free zero-copy reads. The band ids are FROZEN-registry ids reached via
/// `region_by_id` (NOT carries). Mirrors the `service_pool` exact-size gates.
///
/// Gates (all hard `PatternBandInvalid` / `PtbError`):
///  - `0x10` body holds its `count u32` prefix + `count × 8 B` records.
///  - `0x10.count == 0x46` numPatterns (the `0x46` CSR offsets length − 1).
///  - `0x14` length == `num_trips * 24` (exact; truncation mis-groups trips).
///  - `0x45`/`0x46` CSR offsets monotonic, last == values len, in-bounds.
///  - `0x11`/`0x45`/`0x46` ordinals within range (stop/pattern/trip indices).
///  - `0x14`/`0x46` grouping agreement: trips bucketed by `0x14 pattern_idx`
///    are set-identical to each pattern's `0x46` trip slice (every trip claimed
///    once, each `0x14` ordinal in range).
///  - `0x13` length == `Σ over patterns T*(4 + 4S + ceil(S/8))`.
///
/// `Header::parse` already bounds-checked each region range against `buf`.
/// B1.5-T4a: re-materialize the small structural metadata a carry-LESS band
/// bundle no longer carries — `trip_starts` (the `(num_trips+1)` prefix-sum) and
/// the route→trips CSR — from the band + the surviving `0xF2 TripsIntern` region.
/// Approach A (synthesize at load): the band stays the source of truth for the
/// timetable, so ONLY this kilobyte-scale metadata is rebuilt — NOT the stop_times.
///
/// `trip_starts[t+1] - trip_starts[t]` is trip `t`'s band POSITION count (the
/// `stop_count` of its `0x14`-declared pattern), NOT the flat stop-time row count
/// (which no longer exists). This keeps `last == num_stop_times()` (so the
/// `from_bytes` cross-check and `build_from_band`'s Pin-6 monotonic/length gates
/// pass) without indexing any flat row — the band path reads times from `0x13`.
///
/// The route→trips CSR is inverted from each trip's `0xF2 TripsIntern` `route_idx`
/// (`u32 @ t*24+8`). Trips are appended to their route's bucket in ASCENDING trip
/// ordinal (the natural `0..num_trips` walk), reproducing the producer's carry CSR
/// value-array order, so the index built over the synthesized CSR is byte-identical
/// to the carry-bearing one.
///
/// This counting-sort re-implements the producer's
/// `build_route_trips_csr` (`crates/pt-producer/src/csr/route_trips.rs`),
/// which emits the very `0xF6` CSR a carry-less bundle has stripped, and is also
/// duplicated by the TS carry-less loader synth (the `carryMaterializedFromBand`
/// branch in `loadPtb`, `packages/shared/src/ptb/loader.ts`). The **three** —
/// `build_route_trips_csr`, this `synthesize_carry_from_band`, and the `loadPtb`
/// synth — MUST stay in sync: counting-sort keyed by `route_idx`, ascending trip
/// ordinal (the value-array order drives plan correctness); no CI gate links them.
///
/// Reads are bounds-checked: `0x10`/`0x14` were gated by `resolve_pattern_band`,
/// and `0xF2 TripsIntern` was gated by `from_bytes`'s `check_table`, so a valid
/// carry-less bundle decodes cleanly; corruption surfaces as a typed `Err`.
fn synthesize_carry_from_band(
    buf: &[u8],
    header: &Header,
    band: &PatternBand,
) -> Result<(
    alloc::vec::Vec<u32>,
    alloc::vec::Vec<u32>,
    alloc::vec::Vec<u32>,
)> {
    let num_trips = header.num_trips as usize;
    let num_routes = header.num_routes as usize;

    // Per-pattern stop_count from the `0x10 Patterns` enumeration (`count u32`
    // prefix then 8 B records; `stop_count u16 @ +4`). Indexed by pattern_idx.
    let pat_base = band.patterns.offset;
    let mut pattern_stop_count: alloc::vec::Vec<u32> =
        alloc::vec::Vec::with_capacity(band.num_patterns);
    for p in 0..band.num_patterns {
        let o = pat_base + 4 + p * 8;
        pattern_stop_count.push(rd_u16(buf, o + 4)? as u32);
    }

    // `trip_starts`: (num_trips+1) prefix-sum of each trip's band position count.
    // pattern_idx is `0x14 TripMeta` `u32 @ t*24+0` (gated to `num_trips*24`).
    let tm_base = band.trip_meta.offset;
    let mut trip_starts: alloc::vec::Vec<u32> = alloc::vec::Vec::with_capacity(num_trips + 1);
    trip_starts.push(0);
    let mut acc: u32 = 0;
    for t in 0..num_trips {
        let pidx = rd_u32(buf, tm_base + t * 24)? as usize;
        let count = *pattern_stop_count
            .get(pidx)
            .ok_or(PtbError::PatternBandInvalid {
                reason: "0x14 trip pattern_idx out of range (synth)",
            })?;
        acc = acc.checked_add(count).ok_or(PtbError::CountExceedsRegion {
            region: "synth tripStarts",
        })?;
        trip_starts.push(acc);
    }

    // route→trips CSR, inverted from `0xF2 TripsIntern` `route_idx` (`u32 @ t*24+8`).
    // Two-pass counting sort keyed by route, preserving ascending trip ordinal.
    let trips_region = region_slice(buf, header, Region::TripsIntern)?;
    let mut counts = alloc::vec![0u32; num_routes];
    let mut route_of: alloc::vec::Vec<u32> = alloc::vec::Vec::with_capacity(num_trips);
    for t in 0..num_trips {
        let r = rd_u32(trips_region, t * TRIP_RECORD_BYTES + 8)?;
        if r as usize >= num_routes {
            return Err(PtbError::CsrInvalid {
                detail: "synth trip route_idx out of range",
            });
        }
        counts[r as usize] += 1;
        route_of.push(r);
    }
    let mut rt_offsets: alloc::vec::Vec<u32> = alloc::vec::Vec::with_capacity(num_routes + 1);
    rt_offsets.push(0);
    let mut acc: u32 = 0;
    for &c in &counts {
        acc = acc.checked_add(c).ok_or(PtbError::CsrInvalid {
            detail: "synth route_trips overflow",
        })?;
        rt_offsets.push(acc);
    }
    // Stable fill: cursor per route, trips visited in ascending ordinal.
    let mut cursor: alloc::vec::Vec<u32> = rt_offsets[..num_routes].to_vec();
    let mut rt_values = alloc::vec![0u32; num_trips];
    for (t, &r) in route_of.iter().enumerate() {
        let slot = cursor[r as usize] as usize;
        rt_values[slot] = t as u32;
        cursor[r as usize] += 1;
    }

    Ok((trip_starts, rt_offsets, rt_values))
}

fn resolve_pattern_band(
    buf: &[u8],
    header: &Header,
    num_stops: usize,
    num_trips: usize,
) -> Result<Option<PatternBand>> {
    use crate::region_ids as rid;

    // Absent `0x10` ⇒ no band; `Index::build` takes the flat carry.
    let patterns = match header.region_by_id(rid::PATTERNS) {
        Some(e) => e,
        None => return Ok(None),
    };

    // Required companions. A PRESENT band missing any of these is malformed.
    let missing = || PtbError::PatternBandInvalid {
        reason: "missing band region",
    };
    let pattern_stops = header
        .region_by_id(rid::PATTERN_STOPS)
        .ok_or_else(missing)?;
    let trip_times = header.region_by_id(rid::TRIP_TIMES).ok_or_else(missing)?;
    let trip_meta = header.region_by_id(rid::TRIP_META).ok_or_else(missing)?;
    let patterns_at_stop = header
        .region_by_id(rid::PATTERNS_AT_STOP)
        .ok_or_else(missing)?;
    let pattern_trips = header
        .region_by_id(rid::PATTERN_TRIPS)
        .ok_or_else(missing)?;
    // 0x12 is OMITTED when every pattern is all-regular.
    let pattern_semantics = header.region_by_id(rid::PATTERN_SEMANTICS);

    // 0x10: `count u32` prefix then `count × 8 B`. Region must hold them tightly
    // enough that the per-record reads are in-bounds.
    if patterns.length < 4 {
        return Err(PtbError::PatternBandInvalid {
            reason: "patterns too short",
        });
    }
    let num_patterns = rd_u32(buf, patterns.offset)? as usize;
    let patterns_need = num_patterns
        .checked_mul(8)
        .and_then(|b| b.checked_add(4))
        .ok_or(PtbError::PatternBandInvalid {
            reason: "patterns length overflow",
        })?;
    if patterns.length < patterns_need {
        return Err(PtbError::PatternBandInvalid {
            reason: "patterns length",
        });
    }

    // 0x14 TripMeta: one 24 B record per trip (`pattern_idx u32 @ +0`, …). Length
    // must hold EXACTLY `num_trips * 24` — a truncated region would let
    // `trip_pattern_idx(t)` read into the following region and silently mis-group
    // trips. (Sibling exact-size gate, mirrors `0x13` tripTimes length.)
    let trip_meta_need = num_trips
        .checked_mul(24)
        .ok_or(PtbError::PatternBandInvalid {
            reason: "tripMeta length overflow",
        })?;
    if trip_meta.length != trip_meta_need {
        return Err(PtbError::PatternBandInvalid {
            reason: "tripMeta length",
        });
    }

    // 0x46 PatternTrips CSR: `offsets[numPatterns+1] u32` + trip-ordinal values.
    // Validate the offsets prefix-sum (monotonic, last == values len) and that
    // `0x10.count == numPatterns` (the offsets length − 1).
    let pt_off_len = num_patterns
        .checked_add(1)
        .ok_or(PtbError::PatternBandInvalid {
            reason: "patternTrips offsets overflow",
        })?;
    let pt_offsets = u32_range(buf, pattern_trips.offset, pt_off_len)?;
    let pt_off = cast_u32(buf, pt_offsets)?;
    for w in pt_off.windows(2) {
        if w[1] < w[0] {
            return Err(PtbError::PatternBandInvalid {
                reason: "patternTrips offsets not monotonic",
            });
        }
    }
    let pt_values_len = pt_off.last().copied().unwrap_or(0) as usize;
    let pt_values_start = pattern_trips
        .offset
        .checked_add(
            pt_off_len
                .checked_mul(4)
                .ok_or(PtbError::PatternBandInvalid {
                    reason: "patternTrips values overflow",
                })?,
        )
        .ok_or(PtbError::PatternBandInvalid {
            reason: "patternTrips values overflow",
        })?;
    let pt_values = u32_range(buf, pt_values_start, pt_values_len)?;
    let pt_val = cast_u32(buf, pt_values)?;
    // Every trip ordinal in range, AND the CSR values exactly span the region
    // (no dangling tail past `offsets[last]`).
    if pt_val.iter().any(|&v| v as usize >= num_trips) {
        return Err(PtbError::PatternBandInvalid {
            reason: "patternTrips ordinal out of range",
        });
    }

    // 0x14 ↔ 0x46 cross-check (defense-in-depth). `build_from_band` derives
    // trip→pattern membership from `0x14 pattern_idx`; `0x46 PatternTrips` gives
    // pattern→trips. Each region is internally valid, but they are never compared
    // — a producer bug where the two disagree yields a wrong-but-non-crashing
    // index. Require the two groupings to be SET-identical per pattern: bucket
    // trips by `0x14 pattern_idx`, then confirm `0x46`'s slice for each pattern is
    // exactly that bucket (counts + membership), with every trip claimed once.
    //
    // `0x14` length was gated to `num_trips * 24` above, so each per-trip read is
    // in-bounds. O(num_trips) and panic-free (`checked_*`).
    {
        // Per-pattern bucket SIZE from the `0x14` grouping; the matching count
        // from `0x46` is `pt_off[p+1] - pt_off[p]`.
        let mut tm_bucket = alloc::vec![0usize; num_patterns];
        // Per-trip `0x14 pattern_idx`, range-checked (no ordinal gate covers it).
        let mut tm_pat = alloc::vec![0u32; num_trips];
        for (t, slot) in tm_pat.iter_mut().enumerate() {
            let p = rd_u32(buf, trip_meta.offset + t * 24)?;
            if p as usize >= num_patterns {
                return Err(PtbError::PatternBandInvalid {
                    reason: "tripMeta pattern_idx out of range",
                });
            }
            *slot = p;
            tm_bucket[p as usize] += 1;
        }
        // Walk `0x46` per pattern: each claimed trip must (a) carry the matching
        // `0x14 pattern_idx` and (b) be claimed by exactly ONE pattern. Counts
        // equal + every-pair-agrees ⇒ the two groupings are set-identical.
        let mut seen = alloc::vec![false; num_trips];
        for p in 0..num_patterns {
            let lo = pt_off[p] as usize;
            let hi = pt_off[p + 1] as usize;
            let claimed = hi.checked_sub(lo).ok_or(PtbError::PatternBandInvalid {
                reason: "patternTrips slice negative",
            })?;
            if claimed != tm_bucket[p] {
                return Err(PtbError::PatternBandInvalid {
                    reason: "tripMeta/patternTrips disagree",
                });
            }
            for &t in &pt_val[lo..hi] {
                let t = t as usize; // already range-checked < num_trips above
                if seen[t] || tm_pat[t] as usize != p {
                    return Err(PtbError::PatternBandInvalid {
                        reason: "tripMeta/patternTrips disagree",
                    });
                }
                seen[t] = true;
            }
        }
        // Every trip claimed exactly once ⇒ the `0x14` grouping has no trip the
        // `0x46` CSR omits (the reverse-inclusion direction).
        if seen.iter().any(|&s| !s) {
            return Err(PtbError::PatternBandInvalid {
                reason: "tripMeta/patternTrips disagree",
            });
        }
    }

    // 0x45 PatternsAtStop CSR: `offsets[numStops+1] u32` + pattern-ordinal values.
    let sr_off_len = num_stops
        .checked_add(1)
        .ok_or(PtbError::PatternBandInvalid {
            reason: "patternsAtStop offsets overflow",
        })?;
    let sr_offsets = u32_range(buf, patterns_at_stop.offset, sr_off_len)?;
    let sr_off = cast_u32(buf, sr_offsets)?;
    for w in sr_off.windows(2) {
        if w[1] < w[0] {
            return Err(PtbError::PatternBandInvalid {
                reason: "patternsAtStop offsets not monotonic",
            });
        }
    }
    let sr_values_len = sr_off.last().copied().unwrap_or(0) as usize;
    let sr_values_start = patterns_at_stop
        .offset
        .checked_add(
            sr_off_len
                .checked_mul(4)
                .ok_or(PtbError::PatternBandInvalid {
                    reason: "patternsAtStop values overflow",
                })?,
        )
        .ok_or(PtbError::PatternBandInvalid {
            reason: "patternsAtStop values overflow",
        })?;
    let sr_values = u32_range(buf, sr_values_start, sr_values_len)?;
    let sr_val = cast_u32(buf, sr_values)?;
    if sr_val.iter().any(|&v| v as usize >= num_patterns) {
        return Err(PtbError::PatternBandInvalid {
            reason: "patternsAtStop ordinal out of range",
        });
    }

    // 0x13 TripTimes entryFlags gate (load-time fail-closed; the symmetric twin of
    // TS `decodePatternBand` in `packages/shared/src/ptb/loader.ts`). Only TWO flag
    // words are supported: `0x0000` (the i16 layout) and `0x0002`
    // (`TRIP_TIMES_FLAG_I32_DELTAS`, the i32 layout). ANY other bit — the ragged
    // bit0 (`TRIP_TIMES_FLAG_RAGGED`) OR an unknown future bit — makes the band
    // UNRESOLVABLE here, so every downstream decode path fails closed at load
    // exactly like TS throwing. Without this, Rust was too lenient: a `0x13` with
    // bit1 PLUS an unknown bit (e.g. `0x0006`) would decode as pure i32 while TS
    // rejected the same bytes — a silent cross-runtime divergence. (Ragged was only
    // rejected later at `Index::build`; it now fails earlier, here.) `~` is
    // `TRIP_TIMES_FLAG_I32_DELTAS` complemented, so the test is "any bit but bit1".
    if trip_times.entry_flags & !TRIP_TIMES_FLAG_I32_DELTAS != 0 {
        return Err(PtbError::PatternBandInvalid {
            reason: "0x13 TripTimes unsupported entryFlags",
        });
    }

    // 0x11 PatternStops + 0x13 TripTimes: walk every pattern, accumulating the
    // 0x13 span and validating each pattern's stop ordinals are in range and its
    // 0x11 slice is in-bounds. `T` per pattern comes from the gated `0x46` CSR.
    // Delta width is REGION-level: 4 B when the `0x13` entryFlags declares the
    // `i32`-delta variant (bit1), else the BYTE-IDENTICAL 2 B `i16` layout. The gate
    // above guarantees `entry_flags` is exactly `0x0000` or `0x0002` here.
    let delta_bytes = delta_bytes_for_flags(trip_times.entry_flags);
    let mut trip_times_span = 0usize;
    // total 0x11 elements consumed (contiguous)
    let mut stops_seen = 0usize;
    // 0x12 expected length = Σ stop_count over NON-all-regular patterns (the
    // producer pushes one byte per stop only when `flags.bit0` is UNSET —
    // `pattern_emit.rs` "if !all_regular { semantics_body.push(...) }").
    let mut semantics_expected = 0usize;
    for p in 0..num_patterns {
        let rec_o = patterns.offset + 4 + p * 8;
        let stops_off = rd_u32(buf, rec_o)? as usize;
        let stop_count = rd_u16(buf, rec_o + 4)? as usize;
        let flags = rd_u8(buf, rec_o + 6)?;
        if flags & PATTERN_FLAG_ALL_REGULAR == 0 {
            semantics_expected =
                semantics_expected
                    .checked_add(stop_count)
                    .ok_or(PtbError::PatternBandInvalid {
                        reason: "patternSemantics length overflow",
                    })?;
        }
        // 0x11 slice in-bounds + stop ordinals in range.
        let stops_start = pattern_stops
            .offset
            .checked_add(
                stops_off
                    .checked_mul(4)
                    .ok_or(PtbError::PatternBandInvalid {
                        reason: "patternStops offset overflow",
                    })?,
            )
            .ok_or(PtbError::PatternBandInvalid {
                reason: "patternStops offset overflow",
            })?;
        let stops_range = u32_range(buf, stops_start, stop_count)?;
        let stops = cast_u32(buf, stops_range)?;
        if stops.iter().any(|&v| v as usize >= num_stops) {
            return Err(PtbError::PatternBandInvalid {
                reason: "patternStops ordinal out of range",
            });
        }
        stops_seen = stops_seen
            .checked_add(stop_count)
            .ok_or(PtbError::PatternBandInvalid {
                reason: "patternStops count overflow",
            })?;
        // 0x13 span for this pattern: T from the 0x46 CSR slice length.
        let lo = pt_off[p] as usize;
        let hi = pt_off[p + 1] as usize;
        let t = hi.checked_sub(lo).ok_or(PtbError::PatternBandInvalid {
            reason: "patternTrips slice negative",
        })?;
        let span = pattern_trip_times_span(t, stop_count, delta_bytes).ok_or(
            PtbError::PatternBandInvalid {
                reason: "tripTimes span overflow",
            },
        )?;
        trip_times_span =
            trip_times_span
                .checked_add(span)
                .ok_or(PtbError::PatternBandInvalid {
                    reason: "tripTimes span overflow",
                })?;
    }

    // 0x13 length must EXACTLY equal the per-pattern span sum (no slack tail).
    if trip_times.length != trip_times_span {
        return Err(PtbError::PatternBandInvalid {
            reason: "tripTimes length",
        });
    }
    // 0x11 must hold exactly the contiguous elements the patterns reference.
    if pattern_stops.length
        < stops_seen
            .checked_mul(4)
            .ok_or(PtbError::PatternBandInvalid {
                reason: "patternStops length overflow",
            })?
    {
        return Err(PtbError::PatternBandInvalid {
            reason: "patternStops length",
        });
    }
    // 0x12 PatternSemantics: exactly one byte per stop for each NON-all-regular
    // pattern (the producer omits the region entirely when EVERY pattern is
    // all-regular). A short/long `0x12` would let the hot-path semantics read
    // (`band_pickup_forbidden_at`) decode an adjacent region's bytes as
    // pickup/drop-off flags while the TS materializer defaults a missing byte to
    // regular — a same-bytes Rust↔TS boarding divergence. Gate the exact size so
    // BOTH runtimes fail closed identically. (Sibling exact-size gate, mirrors the
    // 0x13/0x14 length gates above.) Absent region ⇒ `semantics_expected` must be 0.
    match pattern_semantics {
        Some(e) => {
            if e.length != semantics_expected {
                return Err(PtbError::PatternBandInvalid {
                    reason: "patternSemantics length",
                });
            }
        }
        None => {
            if semantics_expected != 0 {
                return Err(PtbError::PatternBandInvalid {
                    reason: "patternSemantics missing",
                });
            }
        }
    }

    Ok(Some(PatternBand {
        patterns,
        pattern_stops,
        pattern_semantics,
        trip_times,
        trip_meta,
        patterns_at_stop,
        pattern_trips,
        num_patterns,
    }))
}

/// Whole days from anchor (YYYYMMDD) to date (YYYYMMDD), via days-from-civil.
/// Returns None if date < anchor. Mirrors the anchor math used by the producer.
fn days_between(anchor: u32, date: u32) -> Option<u32> {
    let a = days_from_civil(anchor);
    let d = days_from_civil(date);
    if d < a {
        None
    } else {
        Some((d - a) as u32)
    }
}
// Howard Hinnant days_from_civil: YYYYMMDD -> days since 1970-01-01.
pub(crate) fn days_from_civil(yyyymmdd: u32) -> i64 {
    let y = (yyyymmdd / 10000) as i64;
    let m = ((yyyymmdd / 100) % 100) as i64;
    let d = (yyyymmdd % 100) as i64;
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Howard-Hinnant `civil_from_days` — inverse of [`days_from_civil`]: days since
/// 1970-01-01 -> packed YYYYMMDD. Pure calendar arithmetic. Byte-identical to the
/// pt-shared twin (`crates/pt-shared/src/validate/metadata.rs`); both pin the
/// shared `CIVIL_VECTORS` table so the two copies cannot drift.
pub(crate) fn civil_from_days(days: i64) -> u32 {
    let z = days + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = z - era * 146097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y as u32) * 10000 + m * 100 + d
}

/// Add `n` civil days to a packed YYYYMMDD. Pure calendar arithmetic (no tz) —
/// the DST-safe `±1` the in-engine overnight pass uses. Mirrors the TS
/// `addDaysCivil` (`packages/shared/src/util/ymd.ts`).
pub(crate) fn days_add(yyyymmdd: u32, n: i64) -> u32 {
    civil_from_days(days_from_civil(yyyymmdd) + n)
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Shared anti-drift vector (days-since-1970, packed YYYYMMDD). The SAME
    /// pairs are asserted in pt-shared (metadata.rs) — pt-core and pt-shared
    /// cannot import each other, so identical literals in both tests are the
    /// only thing keeping the two Howard-Hinnant copies aligned. Independent
    /// oracle values (hand-computed / cross-checked, NOT copied from either impl).
    const CIVIL_VECTORS: &[(i64, u32)] = &[
        (0, 19700101),
        (20574, 20260501), // feed-start anchor
        (20577, 20260504), // Monday
        (20578, 20260505), // Tuesday (gate PINNED_DATE)
        (19782, 20240229), // leap day
        (20483, 20260130),
    ];

    #[test]
    fn civil_round_trip_and_days_add() {
        use super::{civil_from_days, days_add, days_from_civil};
        for &(days, ymd) in CIVIL_VECTORS {
            assert_eq!(days_from_civil(ymd), days, "days_from_civil({ymd})");
            assert_eq!(civil_from_days(days), ymd, "civil_from_days({days})");
        }
        assert_eq!(days_add(20260301, -1), 20260228);
        assert_eq!(days_add(20240301, -1), 20240229);
        assert_eq!(days_add(20260101, -1), 20251231);
        assert_eq!(days_add(20260505, -1), 20260504); // gate fixture: Tue -> Mon
        assert_eq!(days_add(20260504, 1), 20260505);
    }

    // service_active_on: bit i of the bitmask = day (feedStartDate + i).
    #[test]
    fn service_active_on_reads_the_right_bit() {
        // 1 service, bitmask byte0 = 0b0000_0101 -> days 0 and 2 active.
        // anchor 20260501. date 20260501 -> day 0 -> active; 20260502 -> day1 -> inactive.
        let bm = [0b0000_0101u8; 1];
        assert!(service_active_bit(&bm, 0));
        assert!(!service_active_bit(&bm, 1));
        assert!(service_active_bit(&bm, 2));
    }

    // ---- the reader decodes the `0x15 ServiceBitfieldPool` +
    // ----            `0x16 ServiceToBitfield` pair via `service_bitmask`. ----

    /// A bundle maps services to KNOWN distinct pool bitfields; the reader's
    /// `service_bitmask(s)` returns the mapped bitfield and `service_active_on`
    /// agrees with `service_active_bit` over the window.
    #[test]
    fn service_bitmask_reads_pool() {
        use crate::engine::testkit::{build_service_pool_ptb, ServicePoolSpec, SoaRoute, SoaStop};
        // 90-day window ⇒ S = bytes_per_service(90) = 12.
        let s = crate::bytes_per_service(crate::WINDOW_DEFAULT_DAYS);
        assert_eq!(s, 12);
        // Two distinct bitfields in the pool.
        let bf_a = {
            let mut v = alloc::vec![0u8; s];
            v[0] = 0b0000_0101; // days 0 and 2 active
            v[1] = 0b1000_0000; // day 15 active
            v[s - 1] = 0x80; // Padding day95 must stay inactive outside90-day window.
            v
        };
        let bf_b = {
            let mut v = alloc::vec![0u8; s];
            v[0] = 0b0000_0010; // day 1 active
            v
        };
        let pool: alloc::vec::Vec<&[u8]> = alloc::vec![bf_a.as_slice(), bf_b.as_slice()];
        // 3 services: s0 -> pool[1], s1 -> pool[0], s2 -> pool[1].
        let s2b: [u32; 3] = [1, 0, 1];
        let spec = ServicePoolSpec {
            window_days: crate::WINDOW_DEFAULT_DAYS,
            pool: &pool,
            service_to_bitfield: &s2b,
        };
        let stops = [
            SoaStop {
                id: "s0",
                name: "",
                lat: 0.0,
                lon: 0.0,
                parent: None,
                wheelchair: 0,
            },
            SoaStop {
                id: "s1",
                name: "",
                lat: 0.0,
                lon: 0.0,
                parent: None,
                wheelchair: 0,
            },
        ];
        let routes = [SoaRoute {
            id: "R0",
            agency: "",
            short: "",
            long: "",
            color: "",
            text_color: "",
            route_type: 3,
        }];
        let bytes = build_service_pool_ptb(&stops, &routes, &[&[(1, 0, 100), (2, 1, 200)]], &spec);
        let mut r = Reader::from_bytes(bytes).expect("decode service-pool bundle");
        assert_eq!(r.num_services(), 3);

        // service_bitmask must return the MAPPED pool entry, byte-for-byte.
        assert_eq!(r.service_bitmask(0), bf_b.as_slice(), "s0 -> pool[1]");
        assert_eq!(r.service_bitmask(1), bf_a.as_slice(), "s1 -> pool[0]");
        assert_eq!(r.service_bitmask(2), bf_b.as_slice(), "s2 -> pool[1]");
        // Out-of-range service is `&[]` (panic-free), unchanged from the flat path.
        assert_eq!(r.service_bitmask(3), &[] as &[u8]);

        // Compare the ordinal lookup with the independent civil-date path,
        // including month/year/leap/DST-adjacent boundaries and missing services.
        // Calendar activation is about the originating service day, not the
        // event's wall-clock date: https://gtfs.org/documentation/schedule/reference/#field-types
        for anchor in [20231231, 20240228, 20240330, 20241026, 20241231, 20261024] {
            r.header.feed_start_date = anchor;
            for svc in [0, 1, 2, 3, u32::MAX] {
                for day in 0..r.window_days() as u32 + 8 {
                    let date = super::days_add(anchor, day as i64);
                    assert_eq!(
                        r.service_active_on_day(svc, day),
                        r.service_active_on(svc, date),
                        "service {svc} day {day} anchor {anchor}"
                    );
                }
                assert!(!r.service_active_on_day(svc, u32::MAX));
                assert!(!r.service_active_on(svc, super::days_add(anchor, -1)));
            }
        }
    }

    /// (I22): `service_bitfield_pool_count()` reports the distinct-bitfield
    /// `count` from the cached `0x15 ServiceBitfieldPool` prefix. pt-serve `/ready`
    /// surfaces this so operators can confirm the de-dup pool decoded.
    #[test]
    fn service_bitfield_pool_count_reports_distinct_count() {
        use crate::engine::testkit::{build_service_pool_ptb, ServicePoolSpec, SoaRoute, SoaStop};
        let s = crate::bytes_per_service(crate::WINDOW_DEFAULT_DAYS);
        // Two distinct bitfields in the pool, three services mapping into them.
        let bf_a = alloc::vec![0xAAu8; s];
        let bf_b = alloc::vec![0x55u8; s];
        let pool: alloc::vec::Vec<&[u8]> = alloc::vec![bf_a.as_slice(), bf_b.as_slice()];
        let s2b: [u32; 3] = [0, 1, 0];
        let spec = ServicePoolSpec {
            window_days: crate::WINDOW_DEFAULT_DAYS,
            pool: &pool,
            service_to_bitfield: &s2b,
        };
        let stops = [
            SoaStop {
                id: "s0",
                name: "",
                lat: 0.0,
                lon: 0.0,
                parent: None,
                wheelchair: 0,
            },
            SoaStop {
                id: "s1",
                name: "",
                lat: 0.0,
                lon: 0.0,
                parent: None,
                wheelchair: 0,
            },
        ];
        let routes = [SoaRoute {
            id: "R0",
            agency: "",
            short: "",
            long: "",
            color: "",
            text_color: "",
            route_type: 3,
        }];
        let bytes = build_service_pool_ptb(&stops, &routes, &[&[(1, 0, 100), (2, 1, 200)]], &spec);
        let r = Reader::from_bytes(bytes).expect("decode service-pool bundle");
        assert_eq!(
            r.service_bitfield_pool_count(),
            2,
            "pool count must report the distinct-bitfield count"
        );
    }

    /// C3: a bundle missing BOTH pool regions is a HARD load error — NOT a
    /// default-empty like the optional `0xFA` region. `from_bytes` must resolve
    /// `0x15`/`0x16` and fail when absent.
    #[test]
    fn absent_pool_regions_hard_error() {
        use crate::engine::testkit::{build_soa_ptb, SoaRoute, SoaStop};
        let stops = [
            SoaStop {
                id: "s0",
                name: "",
                lat: 0.0,
                lon: 0.0,
                parent: None,
                wheelchair: 0,
            },
            SoaStop {
                id: "s1",
                name: "",
                lat: 0.0,
                lon: 0.0,
                parent: None,
                wheelchair: 0,
            },
        ];
        let routes = [SoaRoute {
            id: "R0",
            agency: "",
            short: "",
            long: "",
            color: "",
            text_color: "",
            route_type: 3,
        }];
        let bytes = build_soa_ptb(&stops, &routes, &[&[(1, 0, 100), (2, 1, 200)]]);
        let bytes = crate::strip_regions(
            bytes,
            &[
                crate::region_ids::SERVICE_BITFIELD_POOL,
                crate::region_ids::SERVICE_TO_BITFIELD,
            ],
        )
        .unwrap();
        // `Reader` is not `Debug`, so match the `Result` rather than `expect_err`.
        match Reader::from_bytes(bytes) {
            Err(PtbError::ServiceBitfieldPoolInvalid { .. }) => {}
            Err(other) => panic!("expected ServiceBitfieldPoolInvalid, got {other:?}"),
            Ok(_) => panic!("a bundle without 0x15/0x16 must hard-fail, but loaded OK"),
        }
    }

    /// M4: `has_any_active_service` traverses the seam via `service_bitmask`, so an
    /// all-zero pool must read as "no active service".
    #[test]
    fn all_zero_pool_has_no_active_service() {
        use crate::engine::testkit::{build_service_pool_ptb, ServicePoolSpec, SoaRoute, SoaStop};
        let s = crate::bytes_per_service(crate::WINDOW_DEFAULT_DAYS);
        let zero = alloc::vec![0u8; s];
        let pool: alloc::vec::Vec<&[u8]> = alloc::vec![zero.as_slice()];
        let s2b: [u32; 2] = [0, 0]; // both services -> the single all-zero bitfield
        let spec = ServicePoolSpec {
            window_days: crate::WINDOW_DEFAULT_DAYS,
            pool: &pool,
            service_to_bitfield: &s2b,
        };
        let stops = [
            SoaStop {
                id: "s0",
                name: "",
                lat: 0.0,
                lon: 0.0,
                parent: None,
                wheelchair: 0,
            },
            SoaStop {
                id: "s1",
                name: "",
                lat: 0.0,
                lon: 0.0,
                parent: None,
                wheelchair: 0,
            },
        ];
        let routes = [SoaRoute {
            id: "R0",
            agency: "",
            short: "",
            long: "",
            color: "",
            text_color: "",
            route_type: 3,
        }];
        let bytes = build_service_pool_ptb(&stops, &routes, &[&[(1, 0, 100), (2, 1, 200)]], &spec);
        let r = Reader::from_bytes(bytes).expect("decode all-zero pool");
        assert_eq!(r.num_services(), 2);
        for svc in 0..r.num_services() {
            assert!(
                r.service_bitmask(svc).iter().all(|&b| b == 0),
                "all-zero pool entry expected for service {svc}"
            );
        }
    }

    // --- pool LOAD-TIME validation gates ----------------------
    //
    // A malformed pool (wrong `0x15`/`0x16` lengths, an out-of-range
    // `ServiceToBitfield` index, or `count == 0` with services) must be a HARD
    // `ServiceBitfieldPoolInvalid` at construction — not a silently-empty
    // `service_bitmask`. The helpers below build a WELL-FORMED bundle (via the
    // Step-1 testkit) and then surgically corrupt one field of the on-wire region
    // table / body so each gate is exercised in isolation. Pre-gate (Step 1) every
    // one of these loaded OK (the RED state these tests were written to catch).

    /// Two-stop / one-route SoA fixture shared by the pool gate tests.
    fn pool_gate_stops() -> [crate::engine::testkit::SoaStop<'static>; 2] {
        use crate::engine::testkit::SoaStop;
        [
            SoaStop {
                id: "s0",
                name: "",
                lat: 0.0,
                lon: 0.0,
                parent: None,
                wheelchair: 0,
            },
            SoaStop {
                id: "s1",
                name: "",
                lat: 0.0,
                lon: 0.0,
                parent: None,
                wheelchair: 0,
            },
        ]
    }
    fn pool_gate_routes() -> [crate::engine::testkit::SoaRoute<'static>; 1] {
        use crate::engine::testkit::SoaRoute;
        [SoaRoute {
            id: "R0",
            agency: "",
            short: "",
            long: "",
            color: "",
            text_color: "",
            route_type: 3,
        }]
    }

    /// Locate the 24-B region-table entry for `region_id` (scanning from offset
    /// 32 until the `regionId == 0` terminator) and return its entry byte offset,
    /// the region body `offset`, and `length`. Mirrors `Header::parse`'s walk.
    fn find_region_entry(buf: &[u8], region_id: u16) -> (usize, usize, usize) {
        const TABLE_OFF: usize = 32;
        const ENTRY: usize = 24;
        let mut i = 0usize;
        loop {
            let e = TABLE_OFF + i * ENTRY;
            let id = u16::from_le_bytes([buf[e], buf[e + 1]]);
            if id == 0 {
                panic!("region 0x{region_id:02x} not found in table");
            }
            if id == region_id {
                let off = u64::from_le_bytes(buf[e + 8..e + 16].try_into().unwrap()) as usize;
                let len = u64::from_le_bytes(buf[e + 16..e + 24].try_into().unwrap()) as usize;
                return (e, off, len);
            }
            i += 1;
        }
    }

    /// Patch the `length` u64 of `region_id`'s table entry in place. The bundle is
    /// page-aligned, so growing the length by a few bytes stays in-bounds (and so
    /// reaches the Step-2 gate rather than `Header::parse`'s `RegionOutOfBounds`).
    fn patch_region_length(buf: &mut [u8], region_id: u16, new_len: usize) {
        let (e, _, _) = find_region_entry(buf, region_id);
        buf[e + 16..e + 24].copy_from_slice(&(new_len as u64).to_le_bytes());
    }

    /// Build a well-formed bundle whose pool has `pool.len()` distinct
    /// bitfields and `service_to_bitfield` maps each service to a pool index.
    fn build_pool_bundle(pool: &[&[u8]], s2b: &[u32]) -> alloc::vec::Vec<u8> {
        use crate::engine::testkit::{build_service_pool_ptb, ServicePoolSpec};
        let spec = ServicePoolSpec {
            window_days: crate::WINDOW_DEFAULT_DAYS,
            pool,
            service_to_bitfield: s2b,
        };
        let stops = pool_gate_stops();
        let routes = pool_gate_routes();
        build_service_pool_ptb(&stops, &routes, &[&[(1, 0, 100), (2, 1, 200)]], &spec)
    }

    fn assert_pool_invalid(bytes: alloc::vec::Vec<u8>, what: &str) {
        match Reader::from_bytes(bytes) {
            Err(PtbError::ServiceBitfieldPoolInvalid { .. }) => {}
            Err(other) => panic!("{what}: expected ServiceBitfieldPoolInvalid, got {other:?}"),
            Ok(_) => panic!("{what}: malformed pool must hard-fail, but loaded OK"),
        }
    }

    /// `0x15 ServiceBitfieldPool` length ≠ `4 + count*S` (both too-short AND
    /// too-long) is a hard `ServiceBitfieldPoolInvalid`. `count` is read from the
    /// 4-byte prefix (unchanged here); only the region-table length is corrupted.
    #[test]
    fn pool_length_too_short_hard_error() {
        let s = crate::bytes_per_service(crate::WINDOW_DEFAULT_DAYS);
        let bf = alloc::vec![0u8; s];
        let pool: alloc::vec::Vec<&[u8]> = alloc::vec![bf.as_slice(), bf.as_slice()];
        let mut bytes = build_pool_bundle(&pool, &[0, 1]);
        // Well-formed length is 4 + 2*S; shave 4 bytes off → 4 + 2*S - 4.
        let (_, _, len) = find_region_entry(&bytes, crate::region_ids::SERVICE_BITFIELD_POOL);
        patch_region_length(
            &mut bytes,
            crate::region_ids::SERVICE_BITFIELD_POOL,
            len - 4,
        );
        assert_pool_invalid(bytes, "0x15 too-short");
    }

    #[test]
    fn pool_length_too_long_hard_error() {
        let s = crate::bytes_per_service(crate::WINDOW_DEFAULT_DAYS);
        let bf = alloc::vec![0u8; s];
        let pool: alloc::vec::Vec<&[u8]> = alloc::vec![bf.as_slice(), bf.as_slice()];
        let mut bytes = build_pool_bundle(&pool, &[0, 1]);
        // Grow the length by 4 bytes; page padding keeps offset+length in-bounds.
        let (_, _, len) = find_region_entry(&bytes, crate::region_ids::SERVICE_BITFIELD_POOL);
        patch_region_length(
            &mut bytes,
            crate::region_ids::SERVICE_BITFIELD_POOL,
            len + 4,
        );
        assert_pool_invalid(bytes, "0x15 too-long");
    }

    /// `0x16 ServiceToBitfield` length ≠ `num_services*4` (too-short AND too-long)
    /// is a hard error.
    #[test]
    fn pool_index_length_too_short_hard_error() {
        let s = crate::bytes_per_service(crate::WINDOW_DEFAULT_DAYS);
        let bf = alloc::vec![0u8; s];
        let pool: alloc::vec::Vec<&[u8]> = alloc::vec![bf.as_slice()];
        let mut bytes = build_pool_bundle(&pool, &[0, 0, 0]); // 3 services ⇒ 0x16 length 12
        let (_, _, len) = find_region_entry(&bytes, crate::region_ids::SERVICE_TO_BITFIELD);
        patch_region_length(&mut bytes, crate::region_ids::SERVICE_TO_BITFIELD, len - 4);
        assert_pool_invalid(bytes, "0x16 too-short");
    }

    #[test]
    fn pool_index_length_too_long_hard_error() {
        let s = crate::bytes_per_service(crate::WINDOW_DEFAULT_DAYS);
        let bf = alloc::vec![0u8; s];
        let pool: alloc::vec::Vec<&[u8]> = alloc::vec![bf.as_slice()];
        let mut bytes = build_pool_bundle(&pool, &[0, 0, 0]);
        let (_, _, len) = find_region_entry(&bytes, crate::region_ids::SERVICE_TO_BITFIELD);
        patch_region_length(&mut bytes, crate::region_ids::SERVICE_TO_BITFIELD, len + 4);
        assert_pool_invalid(bytes, "0x16 too-long");
    }

    /// A `ServiceToBitfield[s] >= count` (out-of-range pool index) is a hard error,
    /// so the hot-path `service_bitmask` pool-index read is provably in-range.
    #[test]
    fn pool_index_out_of_range_hard_error() {
        let s = crate::bytes_per_service(crate::WINDOW_DEFAULT_DAYS);
        let bf = alloc::vec![0u8; s];
        let pool: alloc::vec::Vec<&[u8]> = alloc::vec![bf.as_slice(), bf.as_slice()]; // count = 2
        let mut bytes = build_pool_bundle(&pool, &[0, 1, 0]); // 3 services, all in-range pre-patch
                                                              // Corrupt service 2's pool index in the `0x16` body to `count` (== 2, OOB).
        let (_, s2b_off, _) = find_region_entry(&bytes, crate::region_ids::SERVICE_TO_BITFIELD);
        let oob = 2u32; // == count, first invalid index
        bytes[s2b_off + 2 * 4..s2b_off + 2 * 4 + 4].copy_from_slice(&oob.to_le_bytes());
        assert_pool_invalid(bytes, "0x16 index OOB");
    }

    /// C2: `count == 0` is permitted IFF `num_services == 0`. A bundle with
    /// `count == 0` but `num_services > 0` is a hard error (no bitfield to map to).
    #[test]
    fn empty_pool_with_services_hard_error() {
        let s = crate::bytes_per_service(crate::WINDOW_DEFAULT_DAYS);
        let bf = alloc::vec![0u8; s];
        let pool: alloc::vec::Vec<&[u8]> = alloc::vec![bf.as_slice(), bf.as_slice()];
        // num_services = 3. Force count → 0 in the `0x15` body prefix AND shrink
        // the region length to the well-formed `4 + 0*S == 4` so the pool_length
        // gate passes and the empty_pool (C2) gate is the one that fires.
        let mut bytes = build_pool_bundle(&pool, &[0, 1, 0]);
        let (_, pool_off, _) = find_region_entry(&bytes, crate::region_ids::SERVICE_BITFIELD_POOL);
        bytes[pool_off..pool_off + 4].copy_from_slice(&0u32.to_le_bytes());
        patch_region_length(&mut bytes, crate::region_ids::SERVICE_BITFIELD_POOL, 4);
        assert_pool_invalid(bytes, "C2 count=0 num_services=3");
    }

    /// M1: `count == 0 && num_services == 0` is ACCEPTED (an empty-service bundle
    /// loads OK — both pool regions are zero-bitfield / zero-index).
    #[test]
    fn empty_pool_no_services_loads_ok() {
        let pool: alloc::vec::Vec<&[u8]> = alloc::vec::Vec::new();
        let s2b: [u32; 0] = [];
        let bytes = build_pool_bundle(&pool, &s2b);
        let r = Reader::from_bytes(bytes).expect("empty pool (count=0, num_services=0) loads");
        assert_eq!(r.num_services(), 0);
    }

    /// C2 (converse): the `count == 0 IFF num_services == 0` biconditional must
    /// reject the OTHER asymmetry too — `num_services == 0 && count > 0` is an
    /// ORPHANED pool (non-empty pool, no service to point at any bitfield). The
    /// `build_pool_bundle` helper derives `num_services` from `s2b.len()`, so an empty
    /// `s2b` with a non-empty `pool` yields a well-formed wire (`0x15` carries
    /// `count == 1`, `0x16` length 0) that the reader must hard-reject.
    #[test]
    fn orphan_pool_no_services_hard_error() {
        let s = crate::bytes_per_service(crate::WINDOW_DEFAULT_DAYS);
        let bf = alloc::vec![0u8; s];
        let pool: alloc::vec::Vec<&[u8]> = alloc::vec![bf.as_slice()]; // count = 1
        let s2b: [u32; 0] = []; // num_services = 0
        let bytes = build_pool_bundle(&pool, &s2b);
        assert_pool_invalid(bytes, "C2 converse count=1 num_services=0");
    }

    /// C1 load-success guard (regression from Step 1): a WELL-FORMED fixture
    /// loads, and the gates added in Step 2 must not reject it.
    #[test]
    fn well_formed_pool_still_loads() {
        let s = crate::bytes_per_service(crate::WINDOW_DEFAULT_DAYS);
        let bf_a = {
            let mut v = alloc::vec![0u8; s];
            v[0] = 0b0000_0101;
            v
        };
        let bf_b = alloc::vec![0u8; s];
        let pool: alloc::vec::Vec<&[u8]> = alloc::vec![bf_a.as_slice(), bf_b.as_slice()];
        let bytes = build_pool_bundle(&pool, &[1, 0, 1]);
        let r = Reader::from_bytes(bytes).expect("well-formed pool loads");
        assert_eq!(r.num_services(), 3);
        assert_eq!(r.service_bitmask(1), bf_a.as_slice());
    }

    // cast_i32 is the signed twin of cast_u32 for the SoA lat_e7/lon_e7
    // columns: a 4-aligned start casts to the exact i32 values (incl. negatives,
    // i.e. western lon / southern lat); a misaligned start is a hard
    // `Misaligned` error (never an align_to that silently drops bytes).
    #[test]
    fn cast_i32_reads_signed_columns_and_rejects_misalignment() {
        // `Vec<u8>` has alignment 1, so the heap base isn't guaranteed 4-aligned.
        // Derive the aligned start from the ACTUAL base address so the test is
        // deterministic on any allocator: `aligned` is the first 4-aligned byte,
        // `aligned + 1` is then provably NOT 4-aligned.
        let mut buf = alloc::vec![0u8; 16];
        let base = buf.as_ptr() as usize;
        let aligned = base.next_multiple_of(4) - base; // 0..=3, the pad to a 4-boundary
        let off = aligned + 4; // leave a 4-byte gap so `aligned+1` stays in-bounds for the misaligned probe
        buf[off..off + 4].copy_from_slice(&(-739857000i32).to_le_bytes()); // western lon e7
        buf[off + 4..off + 8].copy_from_slice(&546912345i32.to_le_bytes()); // 7-decimal lat e7
                                                                            // 4-aligned start: casts cleanly to the exact values (incl. the negative).
        let ok = cast_i32(&buf, U32Range { start: off, len: 2 }).unwrap();
        assert_eq!(ok, &[-739857000i32, 546912345]);
        // A start one byte past a 4-boundary is misaligned → a hard error (never
        // an `align_to` that silently drops the misaligned head).
        assert!(matches!(
            cast_i32(
                &buf,
                U32Range {
                    start: off + 1,
                    len: 2
                }
            ),
            Err(PtbError::Misaligned { .. })
        ));
        // Out-of-range length: SliceOutOfBounds (the `.get` guard), like cast_u32.
        assert!(matches!(
            cast_i32(
                &buf,
                U32Range {
                    start: off,
                    len: 99
                }
            ),
            Err(PtbError::SliceOutOfBounds { .. })
        ));
    }



    /// A small valid SoA bundle: 3 stops, 2 routes, 1 trip on route 0
    /// (single-route carry topology). Coords are asymmetric/signed.
    fn soa_bundle() -> alloc::vec::Vec<u8> {
        use crate::engine::testkit::{build_soa_ptb, SoaRoute, SoaStop};
        let stops = [
            SoaStop {
                id: "s0",
                name: "Stop Zero",
                lat: 54.6912345,
                lon: 25.2797456,
                parent: None,
                wheelchair: 1,
            },
            SoaStop {
                id: "s1",
                name: "Stop One",
                lat: -33.8688,
                lon: 151.2093,
                parent: Some(0),
                wheelchair: 0,
            },
            SoaStop {
                id: "s2",
                name: "Stop Two",
                lat: 0.0001234,
                lon: -73.9857,
                parent: None,
                wheelchair: 2,
            },
        ];
        let routes = [
            SoaRoute {
                id: "R0",
                agency: "A0",
                short: "10",
                long: "Route Ten",
                color: "FF0000",
                text_color: "FFFFFF",
                route_type: 3,
            },
            SoaRoute {
                id: "R1",
                agency: "A0",
                short: "20",
                long: "Route Twenty",
                color: "00FF00",
                text_color: "000000",
                route_type: 0,
            },
        ];
        build_soa_ptb(&stops, &routes, &[&[(1, 0, 100), (2, 1, 200), (3, 2, 300)]])
    }

    #[test]
    fn soa_bundle_constructs() {
        let r = Reader::from_bytes(soa_bundle()).expect("SoA bundle constructs");
        assert_eq!(r.num_stops(), 3);
        assert_eq!(r.num_routes(), 2);
        // build_soa_ptb always emits 0x44, so the persisted path is taken.
        assert!(r.stop_index_is_persisted());
    }

    #[test]
    fn bundle_missing_stops_soa_is_missing_required_region() {
        let mut bytes = soa_bundle();
        // Rewrite the 0x40 tagged entry's regionId to an unallocated id (0x99) so
        // `region_by_id(0x40)` is None, so `from_bytes` must report the SoA region
        // as missing.
        let mut e = 32usize; // REGION_TABLE_OFFSET = 32, 24 B/entry
        let found = loop {
            let id = u16::from_le_bytes([bytes[e], bytes[e + 1]]);
            if id == 0 {
                break false; // table terminator
            }
            if id == crate::region_ids::STOPS_SOA {
                bytes[e..e + 2].copy_from_slice(&0x99u16.to_le_bytes());
                break true;
            }
            e += 24;
        };
        assert!(found, "the 0x40 entry must exist to corrupt");
        assert!(matches!(
            Reader::from_bytes(bytes),
            Err(PtbError::MissingRequiredRegion { region: "stopsSoA" })
        ));
    }

    #[test]
    fn resolve_stops_soa_accepts_4aligned_non_page_aligned_offset() {
        // The reader requires only 4-ALIGNMENT (the u32/i32 cast contract), NOT
        // page-alignment. A region whose offset is 4-aligned but mid-page must
        // still resolve, so a tightly-packed (non-page-padded) bundle is accepted.
        // n=2 stops ⇒ tight = 2*21 = 42 bytes; place the columns at offset 4.
        let n = 2usize;
        let tight = n * 21;
        let off = 4usize; // 4-aligned, NOT a 4096 page boundary
        let mut buf = alloc::vec![0u8; off + tight + 8];
        let e = crate::header::RegionEntry {
            offset: off,
            length: tight,
            ..Default::default()
        };
        let s = resolve_stops_soa(&buf, e, n).expect("4-aligned mid-page offset must resolve");
        assert_eq!(
            s.id_idx.start, off,
            "id_idx column starts at the region offset"
        );
        assert_eq!(s.lat_e7.len, n);
        // wheelchair (u8) column starts after the five 4-byte columns: off + n*20.
        assert_eq!(s.wheelchair, off + n * 20);
        // And it casts cleanly through the i32 accessor path (no Misaligned).
        buf[s.lat_e7.start..s.lat_e7.start + 4].copy_from_slice(&546912345i32.to_le_bytes());
        assert_eq!(cast_i32(&buf, s.lat_e7).unwrap()[0], 546912345);
    }

    #[test]
    fn resolve_stops_soa_rejects_region_shorter_than_tight_total() {
        // region.length < n*21 ⇒ the declared stop count cannot fit ⇒
        // CountExceedsRegion (NOT a silent truncation to fewer stops).
        let n = 3usize;
        let buf = alloc::vec![0u8; 4096];
        let e = crate::header::RegionEntry {
            offset: 0,
            length: n * 21 - 1, // one byte short of the tight total
            ..Default::default()
        };
        assert!(matches!(
            resolve_stops_soa(&buf, e, n),
            Err(PtbError::CountExceedsRegion { region: "stopsSoA" })
        ));
    }

    #[test]
    fn resolve_stops_soa_rejects_non_4_aligned_offset() {
        // A region offset one byte past a 4-boundary breaks the u32/i32 column
        // cast contract ⇒ Misaligned, surfaced at resolution (never an align_to).
        let buf = alloc::vec![0u8; 4096];
        let e = crate::header::RegionEntry {
            offset: 1, // not 4-aligned
            length: 21,
            ..Default::default()
        };
        assert!(matches!(
            resolve_stops_soa(&buf, e, 1),
            Err(PtbError::Misaligned {
                what: "stopsSoA region offset"
            })
        ));
    }

    #[test]
    fn resolve_routes_soa_accepts_4aligned_non_page_aligned_offset() {
        // Mirror of the stops accept case: RoutesSoA tight = m*26, 4-aligned mid-
        // page offset accepts; the u16 route_type column starts after the six
        // 4-byte columns at off + m*24.
        let m = 2usize;
        let tight = m * 26;
        let off = 8usize; // 4-aligned, mid-page
        let buf = alloc::vec![0u8; off + tight + 4];
        let e = crate::header::RegionEntry {
            offset: off,
            length: tight,
            ..Default::default()
        };
        let rt = resolve_routes_soa(&buf, e, m).expect("4-aligned mid-page offset must resolve");
        assert_eq!(rt.id_idx.start, off);
        assert_eq!(rt.color_idx.len, m);
        assert_eq!(rt.route_type, off + m * 24);
    }

    #[test]
    fn resolve_routes_soa_rejects_region_shorter_than_tight_total() {
        let m = 2usize;
        let buf = alloc::vec![0u8; 4096];
        let e = crate::header::RegionEntry {
            offset: 0,
            length: m * 26 - 1,
            ..Default::default()
        };
        assert!(matches!(
            resolve_routes_soa(&buf, e, m),
            Err(PtbError::CountExceedsRegion {
                region: "routesSoA"
            })
        ));
    }

    #[test]
    fn resolve_routes_soa_rejects_non_4_aligned_offset() {
        let buf = alloc::vec![0u8; 4096];
        let e = crate::header::RegionEntry {
            offset: 2, // not 4-aligned
            length: 26,
            ..Default::default()
        };
        assert!(matches!(
            resolve_routes_soa(&buf, e, 1),
            Err(PtbError::Misaligned {
                what: "routesSoA region offset"
            })
        ));
    }

    #[test]
    fn resolve_soa_columns_handle_empty_feed() {
        // N==0 / M==0: zero-length columns, no panic, every range empty. (A fully
        // empty bundle is not expressible through `build_soa_ptb`'s single-route
        // carry topology, so the empty-feed contract is checked at resolution.)
        let buf = alloc::vec![0u8; 4096];
        let e = crate::header::RegionEntry {
            offset: 4096,
            length: 0,
            ..Default::default()
        };
        let s = resolve_stops_soa(&buf, e, 0).expect("empty stops SoA resolves");
        assert_eq!(s.id_idx.len, 0);
        assert_eq!(s.lat_e7.len, 0);
        assert_eq!(s.wheelchair, e.offset); // no preceding bytes ⇒ at the region start
        let rt = resolve_routes_soa(&buf, e, 0).expect("empty routes SoA resolves");
        assert_eq!(rt.id_idx.len, 0);
        assert_eq!(rt.route_type, e.offset);
    }

    /// A fully EMPTY bundle: 0 stops, 0 routes, 0 trips, 0 services (an empty
    /// service pool), and the degenerate CSR.
    fn empty_soa_bundle() -> alloc::vec::Vec<u8> {
        use crate::engine::testkit::{build_v1_ptb, ServicePoolSpec, StopRoutes, V1Feed};
        build_v1_ptb(&V1Feed {
            stops: &[],
            routes: &[],
            trips: &[],
            stop_routes: StopRoutes::Served,
            feed_start_date: 20260601,
            city_tz_offset_seconds: 0,
            services: ServicePoolSpec {
                window_days: crate::WINDOW_DEFAULT_DAYS,
                pool: &[],
                service_to_bitfield: &[],
            },
            transfers: &[],
            boarding: &[],
            stop_index: false,
        })
    }

    #[test]
    fn empty_soa_bundle_constructs_and_accessors_error_cleanly() {
        // An N==0 / M==0 bundle must construct via `from_bytes` (the empty
        // columns resolve), report zero counts, and have
        // `stop(0)`/`route(0)` return a clean SliceOutOfBounds — never panic.
        let r = Reader::from_bytes(empty_soa_bundle()).expect("empty SoA bundle constructs");
        assert_eq!(r.num_stops(), 0);
        assert_eq!(r.num_routes(), 0);
        assert_eq!(r.num_trips(), 0);
        assert!(matches!(
            r.stop(0),
            Err(PtbError::SliceOutOfBounds { what: "stop index" })
        ));
        assert!(matches!(
            r.route(0),
            Err(PtbError::SliceOutOfBounds {
                what: "route index"
            })
        ));
        // The zero-alloc accessors guard identically.
        assert!(r.stop_id(0).is_err());
        assert!(r.route_id(0).is_err());
        assert!(r.stop_parent(0).is_none());

        // Pin the empty-feed STRUCTURAL path: the SoA dense-column + coord
        // validators run cleanly on N==0 (empty column scans pass — no hard
        // RegionBoundsExceeded / CoordOutOfRange / ParentIdxInvalid), so the
        // only thing left to flag is the soft zero-services-in-window check. An
        // empty bundle therefore validates to exactly ZeroServicesInWindow, never a
        // hard SoA structural error.
        use crate::validate::errors::StructuralError;
        use crate::validate::structural::validate_structural;
        assert!(matches!(
            validate_structural(&empty_soa_bundle()),
            Err(StructuralError::ZeroServicesInWindow)
        ));
    }

    // ---- Step A.2: runtime windowDays / per-service bitmask stride ----

    /// A bundle with ZERO stops/routes/trips but `num_services = 1`, whose one
    /// `0x15 ServiceBitfieldPool` entry is EXACTLY `bitmask_len` bytes (so a
    /// stride that disagrees with the window can be tested against the exact-size
    /// gate), and an OPTIONAL `0x01 WindowMeta` region carrying `window_days` as
    /// an LE u16. `active_day` sets that single bit in the bitfield (LSB-first,
    /// `byte = day/8`, `bit = day%8`); `None` leaves it all-zero.
    fn window_meta_soa_bundle(
        window_days: Option<u16>,
        bitmask_len: usize,
        active_day: Option<u32>,
    ) -> alloc::vec::Vec<u8> {
        use crate::engine::testkit::{
            all_active_service, append_region, build_v1_ptb, StopRoutes, V1Feed,
        };
        use crate::region_ids::{SERVICE_BITFIELD_POOL, SERVICE_TO_BITFIELD, WINDOW_META};
        let base = build_v1_ptb(&V1Feed {
            stops: &[],
            routes: &[],
            trips: &[],
            stop_routes: StopRoutes::Served,
            feed_start_date: 20260601,
            city_tz_offset_seconds: 0,
            services: all_active_service(),
            transfers: &[],
            boarding: &[],
            stop_index: false,
        });
        let base =
            crate::strip_regions(base, &[SERVICE_BITFIELD_POOL, SERVICE_TO_BITFIELD]).unwrap();
        let mut pool_body = 1u32.to_le_bytes().to_vec();
        let mut bitfield = alloc::vec![0u8; bitmask_len];
        if let Some(day) = active_day {
            let byte = (day / 8) as usize;
            if byte < bitfield.len() {
                bitfield[byte] |= 1 << (day % 8);
            }
        }
        pool_body.extend_from_slice(&bitfield);
        let buf = append_region(base, SERVICE_BITFIELD_POOL, &pool_body);
        let buf = append_region(buf, SERVICE_TO_BITFIELD, &0u32.to_le_bytes());
        match window_days {
            Some(w) => {
                let mut body = w.to_le_bytes().to_vec();
                body.extend_from_slice(&[0, 0]); // reserved u16
                append_region(buf, WINDOW_META, &body)
            }
            None => buf,
        }
    }

    #[test]
    fn reader_defaults_window_to_90_and_stride_12_when_absent() {
        // A bundle with no 0x01 region (the common case) reports the default
        // 90-day / 12-byte stride.
        let r = Reader::from_bytes(crate::engine::testkit::build_n_trip_ptb(
            2,
            &[&[(1, 0, 100), (2, 1, 200)]],
        ))
        .expect("bundle constructs");
        assert_eq!(r.window_days(), 90);
        assert_eq!(r.bytes_per_service(), 12);
    }

    #[test]
    fn reader_window_meta_present_is_false_when_region_absent() {
        // Provenance bit: a bundle with no 0x01 region reports
        // `window_meta_present() == false` — the authoritative "default path"
        // signal, independent of the value (which floors to 90). Mirrors
        // `has_boarding()` for the boarding region.
        let r = Reader::from_bytes(crate::engine::testkit::build_n_trip_ptb(
            2,
            &[&[(1, 0, 100), (2, 1, 200)]],
        ))
        .expect("bundle constructs");
        assert!(
            !r.window_meta_present(),
            "absent 0x01 WindowMeta ⇒ window_meta_present() == false"
        );
        assert_eq!(r.window_days(), 90);
    }

    #[test]
    fn reader_window_meta_present_is_true_when_region_decoded() {
        // A present, non-90 0x01 region ⇒ `window_meta_present() == true`, so an
        // operator can distinguish a DECODED window from the absent-region default.
        let bundle = window_meta_soa_bundle(Some(400), 50, None);
        let r = Reader::from_bytes(bundle).expect("window-400 bundle constructs");
        assert!(
            r.window_meta_present(),
            "present 0x01 WindowMeta ⇒ window_meta_present() == true"
        );
        assert_eq!(r.window_days(), 400);
    }

    #[test]
    fn reader_reads_window_400_stride_50_and_resolves_far_future_active() {
        // 0x01 = 400 ⇒ window_days() == 400, bytes_per_service() == 50. A service
        // whose day-offset 300 bit is set (>= 90, < 400) resolves ACTIVE — proving
        // the window guard moved past the old fixed 90 (at the 12-byte stride this
        // day would fall outside the slice AND past the guard).
        let bundle = window_meta_soa_bundle(Some(400), 50, Some(300));
        let r = Reader::from_bytes(bundle).expect("window-400 bundle constructs");
        assert_eq!(r.window_days(), 400);
        assert_eq!(r.bytes_per_service(), 50);
        // feed_start_date = 20260601; day-offset 300 from that anchor.
        let date = super::civil_from_days(super::days_from_civil(20260601) + 300);
        assert!(
            r.service_active_on(0, date),
            "day-offset 300 bit set must resolve ACTIVE at the 400-day window"
        );
        for service in [0, 1, u32::MAX] {
            for day in 0..408 {
                assert_eq!(
                    r.service_active_on_day(service, day),
                    r.service_active_on(service, super::days_add(r.feed_start_date(), day as i64)),
                    "wide calendar service {service} day {day}"
                );
            }
        }
    }

    #[test]
    fn reader_exact_size_gate_rejects_stride_mismatch() {
        // M1: 0x01 = 400 (stride 50) but the 0x15 pool entry is sized at the
        // stride-12 length (4 + 1*12 != 4 + 1*50). The EXACT-size pool gate must
        // hard-error rather than silently read a too-short bitfield.
        let bundle = window_meta_soa_bundle(Some(400), 12, None);
        let res = Reader::from_bytes(bundle);
        assert!(
            matches!(
                res.as_ref().map(|_| ()),
                Err(PtbError::ServiceBitfieldPoolInvalid {
                    reason: "pool_length"
                })
            ),
            "expected exact-size pool_length error, got {:?}",
            res.as_ref().map(|_| "Ok")
        );
    }

    #[test]
    fn reader_wide_stride_query_is_panic_free() {
        // M1: 0x01 = 400, 0x15 at the correct stride 50; querying day-offset 300
        // must not panic and resolves by the bit. With the bit UNSET it is inactive
        // (the safe `service_active_bit` bounds-check holds at the wide stride).
        let bundle = window_meta_soa_bundle(Some(400), 50, None);
        let r = Reader::from_bytes(bundle).expect("window-400 bundle constructs");
        let date = super::civil_from_days(super::days_from_civil(20260601) + 300);
        assert!(
            !r.service_active_on(0, date),
            "unset bit at day-offset 300 ⇒ inactive, and the read must not panic"
        );
    }



    /// SoA reader SELF-CONSISTENCY: every decoded field round-trips the KNOWN input literals (and
    /// re-runs the producer's own quantizer for coords). That the SoA encoding is
    /// routing-equivalent is covered by `coords_are_inert_to_the_raptor_plan` (the inert-plan
    /// test).
    #[test]
    fn soa_reader_round_trips_logical_feed() {
        use crate::engine::testkit::{build_soa_ptb, SoaRoute, SoaStop};
        let stops = [
            SoaStop {
                id: "s0",
                name: "Alpha",
                lat: 54.6912345,
                lon: 25.2797456,
                parent: None,
                wheelchair: 1,
            },
            SoaStop {
                id: "s1",
                name: "Beta",
                lat: -33.8688,
                lon: 151.2093,
                parent: Some(0),
                wheelchair: 0,
            },
            SoaStop {
                id: "s2",
                name: "Gamma",
                lat: 0.0001234,
                lon: -73.9857,
                parent: None,
                wheelchair: 2,
            },
        ];
        let routes = [
            SoaRoute {
                id: "R0",
                agency: "A0",
                short: "10",
                long: "Ten Express",
                color: "FF0000",
                text_color: "FFFFFF",
                route_type: 3,
            },
            SoaRoute {
                id: "R1",
                agency: "A1",
                short: "20",
                long: "Twenty Local",
                color: "00FF00",
                text_color: "000000",
                route_type: 0,
            },
        ];
        let r = Reader::from_bytes(build_soa_ptb(
            &stops,
            &routes,
            &[&[(1, 0, 100), (2, 1, 200), (3, 2, 300)]],
        ))
        .expect("SoA bundle constructs");

        for (i, s) in stops.iter().enumerate() {
            assert_eq!(r.stop_id(i).unwrap(), s.id, "stop_id[{i}]");
            let full = r.stop(i).unwrap();
            assert_eq!(full.stop_id, s.id, "stop().stop_id[{i}]");
            assert_eq!(full.stop_name, s.name, "stop_name[{i}]");
            assert_eq!(
                r.stop_wheelchair_boarding(i).unwrap(),
                s.wheelchair,
                "wheelchair[{i}]"
            );
            // Decoded coords within a quantum (5e-8 deg) of the f64 source, per-axis.
            assert!(
                (r.stop_lat_f64(i).unwrap() - s.lat).abs() <= 1e-7,
                "lat_f64[{i}]"
            );
            assert!(
                (r.stop_lon_f64(i).unwrap() - s.lon).abs() <= 1e-7,
                "lon_f64[{i}]"
            );
            // Exact e7 columns match the producer quantizer.
            assert_eq!(
                r.stop_lat_e7(i).unwrap(),
                crate::coord_quant::encode_lat_e7(s.lat).unwrap(),
                "lat_e7[{i}]"
            );
            assert_eq!(
                r.stop_lon_e7(i).unwrap(),
                crate::coord_quant::encode_lon_e7(s.lon).unwrap(),
                "lon_e7[{i}]"
            );
        }
        for (i, rt) in routes.iter().enumerate() {
            assert_eq!(r.route_id(i).unwrap(), rt.id, "route_id[{i}]");
            assert_eq!(r.route_agency_id(i).unwrap(), rt.agency, "agency_id[{i}]");
            assert_eq!(r.route_short_name(i).unwrap(), rt.short, "short_name[{i}]");
            assert_eq!(r.route_long_name(i).unwrap(), rt.long, "long_name[{i}]");
            assert_eq!(r.route_type(i).unwrap(), rt.route_type, "route_type[{i}]");
            assert_eq!(r.route_color(i).unwrap(), rt.color, "route_color[{i}]");
            assert_eq!(
                r.route_text_color(i).unwrap(),
                rt.text_color,
                "route_text_color[{i}]"
            );
            // The full RouteRec decode agrees with the zero-alloc accessors.
            let rec = r.route(i).unwrap();
            assert_eq!(rec.agency_id, rt.agency, "RouteRec.agency_id[{i}]");
            assert_eq!(rec.long_name, rt.long, "RouteRec.long_name[{i}]");
            assert_eq!(rec.route_color, rt.color, "RouteRec.route_color[{i}]");
            assert_eq!(rec.route_type, rt.route_type, "RouteRec.route_type[{i}]");
        }
    }

    /// CI summary-line companion to `soa_reader_round_trips_logical_feed`.
    ///
    /// This tests SoA SELF-CONSISTENCY. It walks the SoA reader over a KNOWN logical feed and compares EVERY
    /// decoded field against its expected INPUT value, RE-RUNNING THE PRODUCER'S OWN
    /// QUANTIZER for the coord fields. Because the same quantizer produced the bytes
    /// and computes the expected value, this can only catch a read-path bug, never a
    /// producer-side coord swap. Any mismatch `assert_eq!`-panics BEFORE the summary
    /// print, so the emitted `soa-self-consistency: <N> fields compared, 0 mismatch`
    /// line is only ever reached when N field comparisons all held. The
    /// ptb-fixture-parity CI gate runs this with `--nocapture` and greps that line
    /// (mirrors the pt-wasm three-way and engine-regression `[1-9][0-9]*`
    /// summary-grep idiom); N>0 + "0 mismatch" proves the SoA read-path round-trips
    /// the logical feed.
    ///
    /// The independent (cross-SOURCE) checks live elsewhere: a coord/byte SWAP is
    /// caught by the HAND-AUTHORED oracle constants (gen_fixtures.rs `want_lat_e7` /
    /// `want_lon_e7` + the TS `loader.test.ts` literals — computed without the
    /// quantizer), and routing-equivalence of the encoding by the inert-plan test
    /// `coords_are_inert_to_the_raptor_plan`. The fn name + emitted
    /// `soa-self-consistency` token are load-bearing for the CI grep — keep stable.
    #[test]
    fn soa_self_consistency_summary() {
        extern crate std;
        use crate::engine::testkit::{build_soa_ptb, SoaRoute, SoaStop};
        let stops = [
            SoaStop {
                id: "s0",
                name: "Alpha",
                lat: 54.6912345,
                lon: 25.2797456,
                parent: None,
                wheelchair: 1,
            },
            SoaStop {
                id: "s1",
                name: "Beta",
                lat: -33.8688,
                lon: 151.2093,
                parent: Some(0),
                wheelchair: 0,
            },
            SoaStop {
                id: "s2",
                name: "Gamma",
                lat: 0.0001234,
                lon: -73.9857,
                parent: None,
                wheelchair: 2,
            },
        ];
        let routes = [
            SoaRoute {
                id: "R0",
                agency: "A0",
                short: "10",
                long: "Ten Express",
                color: "FF0000",
                text_color: "FFFFFF",
                route_type: 3,
            },
            SoaRoute {
                id: "R1",
                agency: "A1",
                short: "20",
                long: "Twenty Local",
                color: "00FF00",
                text_color: "000000",
                route_type: 0,
            },
        ];
        let r = Reader::from_bytes(build_soa_ptb(
            &stops,
            &routes,
            &[&[(1, 0, 100), (2, 1, 200), (3, 2, 300)]],
        ))
        .expect("SoA bundle constructs");

        let mut compared: u64 = 0;

        for (i, s) in stops.iter().enumerate() {
            // stop_id (via accessor + full record) = 2 fields/stop.
            assert_eq!(r.stop_id(i).unwrap(), s.id, "stop_id[{i}]");
            compared += 1;
            let full = r.stop(i).unwrap();
            assert_eq!(full.stop_id, s.id, "stop().stop_id[{i}]");
            compared += 1;
            assert_eq!(full.stop_name, s.name, "stop_name[{i}]");
            compared += 1;
            assert_eq!(
                r.stop_wheelchair_boarding(i).unwrap(),
                s.wheelchair,
                "wheelchair[{i}]"
            );
            compared += 1;
            assert_eq!(r.stop_parent(i as u32), s.parent, "stop_parent[{i}]");
            compared += 1;
            // Decoded coords within a quantum of the f64 source, per-axis (2).
            assert!(
                (r.stop_lat_f64(i).unwrap() - s.lat).abs() <= 1e-7,
                "lat_f64[{i}]"
            );
            compared += 1;
            assert!(
                (r.stop_lon_f64(i).unwrap() - s.lon).abs() <= 1e-7,
                "lon_f64[{i}]"
            );
            compared += 1;
            // Exact e7 columns match the producer quantizer (2).
            assert_eq!(
                r.stop_lat_e7(i).unwrap(),
                crate::coord_quant::encode_lat_e7(s.lat).unwrap(),
                "lat_e7[{i}]"
            );
            compared += 1;
            assert_eq!(
                r.stop_lon_e7(i).unwrap(),
                crate::coord_quant::encode_lon_e7(s.lon).unwrap(),
                "lon_e7[{i}]"
            );
            compared += 1;
        }
        for (i, rt) in routes.iter().enumerate() {
            assert_eq!(r.route_id(i).unwrap(), rt.id, "route_id[{i}]");
            compared += 1;
            assert_eq!(r.route_agency_id(i).unwrap(), rt.agency, "agency_id[{i}]");
            compared += 1;
            assert_eq!(r.route_short_name(i).unwrap(), rt.short, "short_name[{i}]");
            compared += 1;
            assert_eq!(r.route_long_name(i).unwrap(), rt.long, "long_name[{i}]");
            compared += 1;
            assert_eq!(r.route_type(i).unwrap(), rt.route_type, "route_type[{i}]");
            compared += 1;
            assert_eq!(r.route_color(i).unwrap(), rt.color, "route_color[{i}]");
            compared += 1;
            assert_eq!(
                r.route_text_color(i).unwrap(),
                rt.text_color,
                "route_text_color[{i}]"
            );
            compared += 1;
            // The full RouteRec decode agrees with the zero-alloc accessors (4).
            let rec = r.route(i).unwrap();
            assert_eq!(rec.agency_id, rt.agency, "RouteRec.agency_id[{i}]");
            compared += 1;
            assert_eq!(rec.long_name, rt.long, "RouteRec.long_name[{i}]");
            compared += 1;
            assert_eq!(rec.route_color, rt.color, "RouteRec.route_color[{i}]");
            compared += 1;
            assert_eq!(rec.route_type, rt.route_type, "RouteRec.route_type[{i}]");
            compared += 1;
        }

        // Reached ONLY if every comparison above held (a mismatch panics earlier).
        assert!(compared > 0, "no fields compared");
        std::println!("soa-self-consistency: {compared} fields compared, 0 mismatch");
    }

    // ---- coords are INERT to the RAPTOR plan ----
    //
    // The SoA design's central claim is that coordinates never enter routing:
    // RAPTOR scans by stop ORDINAL over the CSR, not by lat/lon. This test is the
    // true cross-source equality check the self-consistency gate (above) can't be:
    // it builds the SAME logical feed (identical stop ordinals / trip topology /
    // CSR) as TWO SoA bundles whose ONLY difference is the per-stop coordinate
    // columns, runs the identical RAPTOR query over both, and asserts the plan
    // output is byte-for-decision IDENTICAL and non-empty. If coords ever leaked
    // into a routing decision, the differing `lat_e7`/`lon_e7` columns would
    // perturb the plan and this `assert_eq!` over the full `Itinerary` (legs,
    // route/trip ordinals, board/alight secs, transfers) would fail.

    /// The three logical stops with caller-supplied coords; everything else (ids,
    /// names, parents, wheelchair) is fixed so the two feeds differ ONLY on coords.
    fn coord_inert_stops(coords: [(f64, f64); 3]) -> [crate::engine::testkit::SoaStop<'static>; 3] {
        use crate::engine::testkit::SoaStop;
        [
            SoaStop {
                id: "s0",
                name: "Alpha",
                lat: coords[0].0,
                lon: coords[0].1,
                parent: None,
                wheelchair: 0,
            },
            SoaStop {
                id: "s1",
                name: "Beta",
                lat: coords[1].0,
                lon: coords[1].1,
                parent: None,
                wheelchair: 0,
            },
            SoaStop {
                id: "s2",
                name: "Gamma",
                lat: coords[2].0,
                lon: coords[2].1,
                parent: None,
                wheelchair: 0,
            },
        ]
    }

    /// Build a SoA bundle with the FIXED routing topology (one route, one trip
    /// s0→s1→s2 at 100/200/300) and the given per-stop coords. Topology is
    /// identical across calls; only the coord columns vary with `coords`.
    fn coord_inert_bundle(coords: [(f64, f64); 3]) -> alloc::vec::Vec<u8> {
        use crate::engine::testkit::{build_soa_ptb, SoaRoute};
        let stops = coord_inert_stops(coords);
        let routes = [SoaRoute {
            id: "R0",
            agency: "A0",
            short: "10",
            long: "Route Ten",
            color: "FF0000",
            text_color: "FFFFFF",
            route_type: 3,
        }];
        build_soa_ptb(&stops, &routes, &[&[(1, 0, 100), (2, 1, 200), (3, 2, 300)]])
    }

    /// Run the public RAPTOR `plan()` end-to-end over a bundle: build a throwaway
    /// `Index`/`ScanState` (test convenience — long-lived hosts reuse both) and
    /// query s0→s2 departing at 0 on the feed's in-window date. No transfers.
    fn coord_inert_plan(bytes: alloc::vec::Vec<u8>) -> alloc::vec::Vec<crate::engine::Itinerary> {
        use crate::engine::{Index, Mobility, PatternMode, Query, ScanState, StopWalk};
        let reader = Reader::from_bytes(bytes).expect("SoA bundle constructs");
        let index = Index::build(&reader, PatternMode::Off).expect("index builds");
        let mut st = ScanState::default();
        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: alloc::vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            exit_stops: alloc::vec![StopWalk {
                stop: 2,
                walk_secs: 0,
            }],
            departure_secs: 0,
            // build_soa_ptb anchors feedStartDate at 20260601 with an all-active
            // service bitmask, so day 0 (20260601) resolves service 0 as active.
            date: 20260601,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: alloc::vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };
        crate::engine::plan(&reader, &index, None, &mut st, &query).expect("plan succeeds")
    }

    #[test]
    fn coords_are_inert_to_the_raptor_plan() {
        // Two bundles, SAME topology, DIFFERENT coords (Vilnius-ish vs. antipodal /
        // signed / near-zero). The plan must be identical AND non-empty.
        let reference = coord_inert_plan(coord_inert_bundle([
            (54.6912345, 25.2797456),
            (54.7000000, 25.3000000),
            (54.7100000, 25.3100000),
        ]));
        let perturbed = coord_inert_plan(coord_inert_bundle([
            (-33.8688, 151.2093),
            (0.0001234, -73.9857),
            (-89.9, -179.9),
        ]));

        // Non-empty: the s0→s2 query routes over the single trip in BOTH feeds.
        assert!(
            !reference.is_empty(),
            "the reference plan must route s0->s2 (non-empty)"
        );
        // Byte-for-decision identical: `Itinerary: PartialEq + Eq` compares every
        // leg (route/trip ordinals, board/alight stop positions, depart/arrive
        // secs) plus board_secs/alight_secs/transfers. A coord leak into routing
        // would perturb one of these and break this equality.
        assert_eq!(
            reference, perturbed,
            "RAPTOR plan differed when ONLY the coordinate columns changed — \
             coordinates are NOT inert to routing"
        );
    }

    // ---- Phase 2 Tasks 2.4 + 2.5: dense parent_idx dispatch + structural validators ----

    /// Byte offset of the tagged-table region `region_id`.
    fn soa_region_offset(bytes: &[u8], region_id: u16) -> usize {
        let mut e = 32usize;
        loop {
            let id = u16::from_le_bytes([bytes[e], bytes[e + 1]]);
            assert_ne!(id, 0, "region {region_id:#06x} absent");
            if id == region_id {
                return u64::from_le_bytes(bytes[e + 8..e + 16].try_into().unwrap()) as usize;
            }
            e += 24;
        }
    }
    /// Byte offset of element `i` in SoA `0x40` `u32`/`i32` column `col`
    /// (0=id_idx … 4=parent_idx) for `n` stops.
    fn soa_u32_col_at(bytes: &[u8], col: usize, n: usize, i: usize) -> usize {
        soa_region_offset(bytes, crate::region_ids::STOPS_SOA) + col * 4 * n + i * 4
    }

    #[test]
    fn soa_stop_parent_reads_dense_column() {
        let r = Reader::from_bytes(soa_bundle()).unwrap();
        assert_eq!(r.stop_parent(1), Some(0), "s1 -> parent s0");
        assert_eq!(r.stop_parent(0), None, "s0: u32::MAX sentinel");
        assert_eq!(r.stop_parent(2), None, "s2: u32::MAX sentinel");
        assert_eq!(r.stop_parent(99), None, "out-of-range stop index");
    }

    #[test]
    fn soa_stop_parent_guards_out_of_range_parent_idx() {
        // parent_idx[1] := 99 (>= num_stops=3). stop_parent must mask it to None,
        // never hand back an index that would OOB a caller's stops table.
        let mut b = soa_bundle();
        let at = soa_u32_col_at(&b, 4, 3, 1);
        b[at..at + 4].copy_from_slice(&99u32.to_le_bytes());
        let r = Reader::from_bytes(b).unwrap();
        assert_eq!(r.stop_parent(1), None, "OOB parent_idx -> None");
    }

    #[test]
    fn validate_structural_flags_soa_parent_bounds() {
        use crate::validate::errors::StructuralError;
        use crate::validate::structural::validate_structural;
        let mut b = soa_bundle();
        let at = soa_u32_col_at(&b, 4, 3, 1);
        b[at..at + 4].copy_from_slice(&99u32.to_le_bytes());
        assert!(matches!(
            validate_structural(&b),
            Err(StructuralError::ParentIdxInvalid { reason: "bounds" })
        ));
    }

    #[test]
    fn validate_structural_flags_soa_parent_self_ref() {
        use crate::validate::errors::StructuralError;
        use crate::validate::structural::validate_structural;
        let mut b = soa_bundle();
        let at = soa_u32_col_at(&b, 4, 3, 1);
        b[at..at + 4].copy_from_slice(&1u32.to_le_bytes()); // parent == own index
        assert!(matches!(
            validate_structural(&b),
            Err(StructuralError::ParentIdxInvalid { reason: "self_ref" })
        ));
    }

    #[test]
    fn from_bytes_rejects_soa_lat_out_of_range() {

        let mut b = soa_bundle();
        // lat_e7[0] (column 2) := 2e9 (> 90e7).
        let at = soa_u32_col_at(&b, 2, 3, 0);
        b[at..at + 4].copy_from_slice(&2_000_000_000i32.to_le_bytes());
        assert!(matches!(
            Reader::from_bytes(b),
            Err(PtbError::CoordOutOfRange { axis: "lat_e7" })
        ));
    }

    #[test]
    fn from_bytes_rejects_soa_lon_out_of_range() {
        let mut b = soa_bundle();
        // lon_e7[1] (column 3) := -2e9 (< -180e7).
        let at = soa_u32_col_at(&b, 3, 3, 1);
        b[at..at + 4].copy_from_slice(&(-2_000_000_000i32).to_le_bytes());
        assert!(matches!(
            Reader::from_bytes(b),
            Err(PtbError::CoordOutOfRange { axis: "lon_e7" })
        ));
    }

    #[test]
    fn validate_structural_flags_soa_coord_out_of_range() {
        use crate::validate::errors::StructuralError;
        use crate::validate::structural::validate_structural;
        let mut b = soa_bundle();
        // lat_e7[0] (column 2) := 2e9 (> 90e7). The coord check now lives in
        // `from_bytes`; `validate_structural` re-parses via Reader::from_bytes and
        // maps the resulting CoordOutOfRange to the stopsSoA RegionBoundsExceeded
        // class (no new public StructuralError variant).
        let at = soa_u32_col_at(&b, 2, 3, 0);
        b[at..at + 4].copy_from_slice(&2_000_000_000i32.to_le_bytes());
        assert!(matches!(
            validate_structural(&b),
            Err(StructuralError::RegionBoundsExceeded { .. })
        ));
    }

    #[test]
    fn validate_structural_passes_clean_soa_bundle() {
        use crate::validate::structural::validate_structural;
        // A well-formed SoA bundle (real parent, sentinels, in-range coords) must
        // pass the SoA structural validators.
        assert!(validate_structural(&soa_bundle()).is_ok());
    }

    // The hot-path wheelchair accessor must agree with the full `stop(i)`
    // decode for every fixture stop, and bound-check like `stop`.
    #[test]
    fn stop_wheelchair_boarding_matches_full_decode() {
        let r = crate::engine::testkit::tiny_reader();
        for i in 0..r.num_stops() {
            assert_eq!(
                r.stop_wheelchair_boarding(i).unwrap(),
                r.stop(i).unwrap().wheelchair_boarding,
                "wheelchair_boarding mismatch at stop {i}",
            );
        }
        // Out-of-range index errors like `stop` does (no panic / wrong read).
        assert!(r.stop_wheelchair_boarding(r.num_stops()).is_err());
    }

    // The zero-alloc stop_id accessor must agree with the full `stop(i)` decode
    // for every fixture stop, and bound-check like `stop`.
    #[test]
    fn stop_id_matches_full_decode() {
        let r = crate::engine::testkit::tiny_reader();
        for i in 0..r.num_stops() {
            assert_eq!(
                r.stop_id(i).unwrap(),
                r.stop(i).unwrap().stop_id,
                "stop_id mismatch at stop {i}",
            );
        }
        // Out-of-range index errors like `stop` does (no panic / wrong read).
        assert!(r.stop_id(r.num_stops()).is_err());
    }

    // The zero-alloc stop_name accessor must agree with the full `stop(i)` decode
    // for every fixture stop, and bound-check like `stop`.
    #[test]
    fn stop_name_matches_full_decode() {
        let r = crate::engine::testkit::tiny_reader();
        for i in 0..r.num_stops() {
            assert_eq!(
                r.stop_name(i).unwrap(),
                r.stop(i).unwrap().stop_name,
                "stop_name mismatch at stop {i}",
            );
        }
        // Out-of-range index errors like `stop` does (no panic / wrong read).
        assert!(r.stop_name(r.num_stops()).is_err());
    }

    #[test]
    fn borrowing_accessors_match_decoded_records() {
        let r = crate::engine::testkit::tiny_reader();
        let t0 = r.trip(0).unwrap();
        assert_eq!(r.trip_id(0).unwrap(), t0.trip_id);
        assert_eq!(r.trip_headsign(0).unwrap(), t0.headsign);
        assert_eq!(r.trip_route_idx(0).unwrap(), t0.route_idx);
        assert_eq!(r.trip_service_idx(0).unwrap(), t0.service_idx);
        assert_eq!(r.trip_direction_id(0).unwrap(), t0.direction_id);
        assert_eq!(r.trip_wheelchair(0).unwrap(), t0.wheelchair_accessible);
        assert_eq!(r.trip_bikes_allowed(0).unwrap(), t0.bikes_allowed);
        let rt0 = r.route(0).unwrap();
        assert_eq!(r.route_id(0).unwrap(), rt0.route_id);
        assert_eq!(r.route_short_name(0).unwrap(), rt0.short_name);
        assert_eq!(r.route_color(0).unwrap(), rt0.route_color);
        assert_eq!(r.route_text_color(0).unwrap(), rt0.route_text_color);
        assert_eq!(r.route_type(0).unwrap(), rt0.route_type);
        // Out-of-range bounds checks.
        assert!(r.trip_id(r.num_trips()).is_err());
        assert!(r.route_id(r.num_routes()).is_err());
        assert!(r.route_color(r.num_routes()).is_err());
    }

    #[test]
    fn bytes_view_returns_underlying_buffer() {
        let bytes = crate::engine::testkit::build_n_trip_ptb(2, &[&[(1, 0, 100), (2, 1, 200)]]);
        let expected_first = bytes[0];
        let reader = Reader::from_bytes(bytes.clone()).unwrap();
        let view = reader.bytes_view().unwrap();
        assert_eq!(
            view.len(),
            bytes.len(),
            "view length matches the input buffer"
        );
        assert_eq!(view[0], expected_first, "view[0] matches input[0]");
        assert_eq!(view, &bytes[..], "view content matches input byte-for-byte");
    }

    #[test]
    fn days_between_civil_calendar() {
        // 31 days across the May->June boundary (NOT 100 from naive subtraction).
        assert_eq!(super::days_between(20260501, 20260601), Some(31));
        assert_eq!(super::days_between(20260531, 20260601), Some(1)); // the naive-subtraction trap
        assert_eq!(super::days_between(20260601, 20260501), None); // underflow
    }

    #[test]
    fn stop_index_increments_lookup_counter() {
        // Each `stop_index` call (hit or miss) bumps the cumulative counter, so a
        // caller can read the delta around a query to get lookups-per-query (the
        // build-vs-mmap tradeoff hinges on this frequency).
        let r = crate::engine::testkit::tiny_reader();
        assert_eq!(r.stop_index_lookups(), 0);
        let _ = r.stop_index("S1");
        let _ = r.stop_index("S2");
        let _ = r.stop_index("nope"); // a miss still counts
        assert_eq!(r.stop_index_lookups(), 3);
    }

    /// Build a SoA bundle with caller-supplied stop ids (one per stop, ordinal
    /// order), 1 route, 1 trip — the StopIndex tests' fixture. `with_stop_index`
    /// toggles the persisted `0x44` region (off ⇒ the SoA eager-fallback path).
    /// Coords/names are uniform valid placeholders; only id→ordinal resolution is
    /// under test.
    fn soa_stop_index_bundle(ids: &[&str], with_stop_index: bool) -> alloc::vec::Vec<u8> {
        use crate::engine::testkit::{
            build_soa_ptb, build_soa_ptb_without_stop_index, SoaRoute, SoaStop,
        };
        let stops: alloc::vec::Vec<SoaStop<'_>> = ids
            .iter()
            .map(|&id| SoaStop {
                id,
                name: "Stop",
                lat: 54.6912345,
                lon: 25.2797456,
                parent: None,
                wheelchair: 0,
            })
            .collect();
        let routes = [SoaRoute {
            id: "R0",
            agency: "A0",
            short: "10",
            long: "Route Ten",
            color: "FF0000",
            text_color: "FFFFFF",
            route_type: 3,
        }];
        let trips: &[&[(u16, u32, u32)]] = &[&[(1, 0, 100), (2, 1, 200)]];
        if with_stop_index {
            build_soa_ptb(&stops, &routes, trips)
        } else {
            build_soa_ptb_without_stop_index(&stops, &routes, trips)
        }
    }

    #[test]
    fn persisted_stop_index_uses_mmap_path() {
        // A bundle carrying a 0x44 StopIndex region must resolve stop ids
        // from that region (no eager HashMap built at load).
        let bytes = soa_stop_index_bundle(&["s0", "s1", "s2"], true);
        let r = Reader::from_bytes(bytes).unwrap();
        assert!(
            r.stop_index_is_persisted(),
            "0x44 region must take the persisted (mmap) lookup path"
        );
    }

    #[test]
    fn producer_bundle_uses_eager_stop_index_path() {
        // The producer emits no 0x44 StopIndex, so the committed tiny.ptb
        // builds the eager HashMap from the StopsSoA id column.
        let r = crate::engine::testkit::tiny_reader();
        assert!(
            !r.stop_index_is_persisted(),
            "a bundle without 0x44 must use the eager HashMap"
        );
        assert_eq!(r.stop_index("S1"), Some(0));
    }

    #[test]
    fn soa_without_stop_index_region_falls_back_to_eager() {
        // A bundle that omits the 0x44 region falls back to the eager build
        // — rebuilding the id map from the StopsSoA `id_idx` column (the region is
        // a regenerable cache; absent ⇒ rebuild — SoA eager-fallback).
        let bytes = soa_stop_index_bundle(&["s0", "s1", "s2"], false);
        let r = Reader::from_bytes(bytes).unwrap();
        assert!(
            !r.stop_index_is_persisted(),
            "a bundle without 0x44 must fall back to the eager HashMap"
        );
        assert_eq!(r.stop_index("s0"), Some(0));
        assert_eq!(r.stop_index("s2"), Some(2));
        assert_eq!(r.stop_index("nope"), None);
    }

    #[test]
    fn soa_persisted_stop_index_matches_eager_fallback_for_every_id() {
        // The persisted StopIndex must resolve EVERY id identically to the SoA
        // eager-fallback (id_idx-column rebuild) path. Same
        // logical SoA feed, one with 0x44 and one without.
        let ids: alloc::vec::Vec<alloc::string::String> =
            (0..8u32).map(|i| alloc::format!("s{i}")).collect();
        let id_refs: alloc::vec::Vec<&str> = ids.iter().map(|s| s.as_str()).collect();
        let eager = Reader::from_bytes(soa_stop_index_bundle(&id_refs, false)).unwrap();
        let persisted = Reader::from_bytes(soa_stop_index_bundle(&id_refs, true)).unwrap();
        assert!(!eager.stop_index_is_persisted());
        assert!(persisted.stop_index_is_persisted());
        for i in 0..8u32 {
            let id = alloc::format!("s{i}");
            assert_eq!(
                persisted.stop_index(&id),
                eager.stop_index(&id),
                "persisted != eager for {id}"
            );
            assert_eq!(persisted.stop_index(&id), Some(i));
        }
        // An absent id resolves to None on both paths.
        assert_eq!(persisted.stop_index("absent"), eager.stop_index("absent"));
        assert_eq!(persisted.stop_index("absent"), None);
    }

    #[test]
    fn soa_persisted_stop_index_duplicate_id_last_wins() {
        // Two stops share id "dup" (ordinals 0 and 1); both the persisted lookup
        // and the SoA eager-fallback must return the LAST ordinal (last-wins).
        let eager =
            Reader::from_bytes(soa_stop_index_bundle(&["dup", "dup", "s2"], false)).unwrap();
        let persisted =
            Reader::from_bytes(soa_stop_index_bundle(&["dup", "dup", "s2"], true)).unwrap();
        assert_eq!(eager.stop_index("dup"), Some(1), "eager last-wins");
        assert_eq!(persisted.stop_index("dup"), Some(1), "persisted last-wins");
        assert_eq!(persisted.stop_index("s2"), Some(2));
    }

    #[test]
    fn soa_persisted_stop_index_resolves_fnv32_collision_pair() {
        // "S2U9"/"AGCVF" are a verified fnv-1a32 collision (stop_index.rs). As
        // distinct stop ids they must resolve to distinct ordinals via the
        // full-string tiebreak — a hash-only lookup would return a wrong one.
        let persisted =
            Reader::from_bytes(soa_stop_index_bundle(&["S2U9", "AGCVF", "s2"], true)).unwrap();
        assert!(persisted.stop_index_is_persisted());
        assert_eq!(persisted.stop_index("S2U9"), Some(0), "collision id A");
        assert_eq!(persisted.stop_index("AGCVF"), Some(1), "collision id B");
        assert_eq!(persisted.stop_index("s2"), Some(2));
        assert_eq!(persisted.stop_index("missing"), None);
    }

    // Per-field corruption coverage for the current `StopsSoA` (`0x40`) layout.
    // Each test flips one byte in a specific column and proves the corresponding
    // decoded value changes while the bundle remains structurally valid.
    //
    // Column-offset math (FROZEN `0x40` layout, `resolve_stops_soa`): the region is N tight stops
    // of five 4-byte columns then one `u8`, COLUMN-major: id_idx@(off+0), name_idx@(off+4N),
    // lat_e7@(off+8N), lon_e7@(off+12N), parent_idx@(off+16N), wheelchair@(off+20N). The region
    // OFFSET is NOT hardcoded: we read it from the tagged table via `header().region_by_id(0x40)`
    // exactly as the reader does, so the harness tracks the fixture if it is regenerated at a
    // different offset.

    /// Byte offset of element `i` of `StopsSoA` 4-byte column `col` (col 0..=4),
    /// derived from the live `0x40` region offset + the FROZEN column strides.
    fn stops_soa_u32_byte(r: &crate::Reader<alloc::vec::Vec<u8>>, col: usize, i: usize) -> usize {
        let e = r
            .header()
            .region_by_id(crate::region_ids::STOPS_SOA)
            .expect("current fixture carries the 0x40 StopsSoA region");
        let n = r.num_stops();
        e.offset + col * 4 * n + i * 4
    }

    /// Load the current producer-built fixture bytes, owned for mutation tests.
    fn current_producer_fixture_bytes() -> alloc::vec::Vec<u8> {
        include_bytes!("../tests/fixtures/producer-current.ptb").to_vec()
    }

    /// COORD field class. Flip one byte of stop 0's `lat_e7` column (col 2) and
    /// assert the EXACT-against-source coord leg of the oracle would fire: the
    /// decoded `stop_lat_e7(0)` no longer equals the source-quantized value the
    /// pristine fixture carries (S1 = 54.6900 => `encode_lat_e7(54.69)` =
    /// 546_900_000). Detection = VALUE CHANGE: flipping the low byte keeps the
    /// coord inside the WGS84 i32@1e7 range, so `from_bytes` accepts the bundle and
    /// the corruption surfaces as a wrong-but-valid coordinate (not a load reject).
    #[test]
    fn fail_red_coord_corruption_is_caught() {
        // Locate the byte via the pristine reader (region offset from the tagged table).
        let pristine = crate::Reader::from_bytes(current_producer_fixture_bytes())
            .expect("pristine current fixture decodes");
        let expected = crate::coord_quant::encode_lat_e7(54.69).unwrap();
        assert_eq!(
            pristine.stop_lat_e7(0).unwrap(),
            expected,
            "precondition: pristine lat_e7[0] is the source-quantized S1 value"
        );
        let byte = stops_soa_u32_byte(&pristine, 2, 0); // lat_e7 col, stop 0

        let mut buf = current_producer_fixture_bytes();
        buf[byte] ^= 0x01; // perturb the least-significant lat_e7 byte
        let corrupt = crate::Reader::from_bytes(buf).expect("low-byte flip stays in WGS84 range");

        // The coordinate equality invariant now fails.
        assert_ne!(
            corrupt.stop_lat_e7(0).unwrap(),
            expected,
            "a one-byte lat_e7 corruption must be visible to the coord parity leg"
        );
    }

    /// ID field class. Flip one byte of stop 0's `id_idx` column (col 0) and assert
    /// the id-equality leg would fire: `stop_id(0)` no longer reads "S1". Detection
    /// = VALUE CHANGE: the flipped index (1 -> 0) still points INSIDE the string
    /// pool, so `from_bytes` accepts and the id resolves to a DIFFERENT pooled
    /// string (here the empty string at pool index 0) rather than rejecting at load.
    #[test]
    fn fail_red_id_corruption_is_caught() {
        let pristine = crate::Reader::from_bytes(current_producer_fixture_bytes())
            .expect("pristine current fixture decodes");
        assert_eq!(
            pristine.stop_id(0).unwrap(),
            "S1",
            "precondition: pristine id[0] resolves to S1"
        );
        let byte = stops_soa_u32_byte(&pristine, 0, 0); // id_idx col, stop 0

        let mut buf = current_producer_fixture_bytes();
        buf[byte] ^= 0x01; // pool index 1 ("S1") -> 0 ("")
        let corrupt = crate::Reader::from_bytes(buf).expect("in-pool index flip decodes");

        // The id equality invariant now fails and resolves to a different string.
        assert_ne!(
            corrupt.stop_id(0).unwrap(),
            "S1",
            "a one-byte id_idx corruption must be visible to the id parity leg"
        );
    }

    /// PARENT field class. Flip one byte of stop 1's `parent_idx` column (col 4)
    /// and assert the parent-equality leg would fire: the decoded parent edge of a
    /// PARENTED stop changes. In the fixture S2 (ordinal 1) and S3 (ordinal 2) both
    /// declare `parent_station=S1` (ordinal 0), so the pristine `stop_parent(1)` is
    /// `Some(0)`. Detection = VALUE CHANGE: flipping the low byte (0 -> 1) yields a
    /// parent_idx still `< num_stops`, so `from_bytes` accepts and the parent edge
    /// becomes `Some(1)` — a wrong-but-in-range parent, exactly what the oracle's
    /// `stop_parent` equality leg guards.
    #[test]
    fn fail_red_parent_corruption_is_caught() {
        let pristine = crate::Reader::from_bytes(current_producer_fixture_bytes())
            .expect("pristine current fixture decodes");
        assert_eq!(
            pristine.stop_parent(1),
            Some(0),
            "precondition: pristine parent[1] (S2) points at S1 (ordinal 0)"
        );
        let byte = stops_soa_u32_byte(&pristine, 4, 1); // parent_idx col, stop 1

        let mut buf = current_producer_fixture_bytes();
        buf[byte] ^= 0x01; // parent ordinal 0 -> 1 (still in-range => accepted)
        let corrupt = crate::Reader::from_bytes(buf).expect("in-range parent flip decodes");

        // The parent equality invariant now fails.
        assert_ne!(
            corrupt.stop_parent(1),
            Some(0),
            "a one-byte parent_idx corruption must be visible to the parent parity leg"
        );
        assert_eq!(
            corrupt.stop_parent(1),
            Some(1),
            "the corrupted parent edge resolves to the flipped (wrong) ordinal"
        );
    }

    /// Current-v1 flat timetable fixture used by the SoA StopTimes corruption
    /// tests below. The service-pool pair is current too, so these tests exercise
    /// the public layout without retaining a predecessor bundle.
    fn current_flat_fixture_bytes() -> alloc::vec::Vec<u8> {
        include_bytes!("../../../packages/shared/src/ptb/__fixtures__/tiny-service-pool.ptb")
            .to_vec()
    }

    #[test]
    fn dep_secs_matches_stop_time_dep_current_flat_layout() {
        let r = crate::Reader::from_bytes(current_flat_fixture_bytes()).unwrap();
        for i in 0..r.num_stop_times() {
            assert_eq!(
                r.dep_secs(i).unwrap(),
                r.stop_time(i).unwrap().dep_secs,
                "row {i}"
            );
        }
        assert!(r.dep_secs(r.num_stop_times()).is_err());
    }

    /// The same equivalence on a CARRY-LESS bundle, where both accessors must
    /// resolve through the band because the flat `0xF4` region is stripped.
    ///
    /// `stop_time` got that dispatch at B1.5-T4a; `dep_secs` did not, so every read
    /// through it — i.e. the whole `PatternMode::Off` scan path, whose trips carry
    /// `band == None` and therefore go via `scan::dep_secs_at`'s flat branch —
    /// OOB-read the zero-length stripped slot and failed with a bare
    /// `SliceOutOfBounds { what: "u32 field" }`. Nothing caught it because every
    /// capture, gate and deploy in this repo runs `covering-merge`.
    #[test]
    fn dep_secs_matches_stop_time_dep_on_a_carry_less_band_bundle() {
        let bytes: alloc::vec::Vec<u8> = include_bytes!(
            "../../../packages/frontend/tests/services/__fixtures__/pattern-band-tiny.ptb"
        )
        .to_vec();
        let r = crate::Reader::from_bytes(bytes).expect("pattern-band-tiny.ptb decodes");
        assert!(r.is_carry_less_band(), "fixture must be carry-less");
        assert!(r.num_stop_times() > 0, "fixture must have rows to compare");
        for i in 0..r.num_stop_times() {
            assert_eq!(
                r.dep_secs(i).unwrap(),
                r.stop_time(i).unwrap().dep_secs,
                "row {i}"
            );
        }
        assert!(r.dep_secs(r.num_stop_times()).is_err());
    }

    // ---- Per-column FAIL-RED coverage for the current SoA decode path.
    //
    // Mirrors the `stops_soa_u32_byte` / `fail_red_*` idiom above (:3218). One test
    // per SoA column flips a single byte of THAT column in the on-disk region and
    // asserts the corresponding decoded field of the same row changes — proving the
    // SoA decode reads each column at its own base/stride (catches a column-base,
    // transpose, or width bug). The region OFFSET is read live from the tagged table
    // (`header().region(StopTimes)`) so the harness tracks a regenerated fixture; the
    // column bases use `N = num_stop_times()` exactly as `decode_stop_time_soa` does.

    /// Byte offset of element `i` of the SoA column whose base (relative to the
    /// StopTimes region offset) is `base_cols` and whose element width is `width`.
    /// Column bases (records.rs:157): dep `0` w4, stop_idx `4N` w4, arr_diff `8N`
    /// w2, stop_seq `10N` w2 — callers pass the base/width for the column under test.
    fn stop_times_soa_byte(
        r: &crate::Reader<alloc::vec::Vec<u8>>,
        base_cols: usize,
        i: usize,
        width: usize,
    ) -> usize {
        let e = r.header().region(crate::header::Region::StopTimes);
        e.offset + base_cols + i * width
    }

    #[test]
    fn fail_red_soa_dep_corruption_is_caught() {
        let pristine = crate::Reader::from_bytes(current_flat_fixture_bytes()).unwrap();
        let want = pristine.stop_time(0).unwrap().dep_secs;
        let byte = stop_times_soa_byte(&pristine, 0, 0, 4); // dep col base 0, width 4
        let mut buf = current_flat_fixture_bytes();
        buf[byte] ^= 0x01;
        let corrupt = crate::Reader::from_bytes(buf).unwrap();
        assert_ne!(
            corrupt.stop_time(0).unwrap().dep_secs,
            want,
            "dep corruption must be visible"
        );
    }

    #[test]
    fn fail_red_soa_stop_idx_corruption_is_caught() {
        let pristine = crate::Reader::from_bytes(current_flat_fixture_bytes()).unwrap();
        let n = pristine.num_stop_times();
        let want = pristine.stop_time(0).unwrap().stop_idx;
        let byte = stop_times_soa_byte(&pristine, 4 * n, 0, 4); // stop_idx col base 4N, width 4
        let mut buf = current_flat_fixture_bytes();
        buf[byte] ^= 0x01;
        let corrupt = crate::Reader::from_bytes(buf).unwrap();
        assert_ne!(
            corrupt.stop_time(0).unwrap().stop_idx,
            want,
            "stop_idx corruption must be visible"
        );
    }

    #[test]
    fn fail_red_soa_arr_diff_corruption_is_caught() {
        let pristine = crate::Reader::from_bytes(current_flat_fixture_bytes()).unwrap();
        let n = pristine.num_stop_times();
        let want_arr = pristine.stop_time(0).unwrap().arr_diff;
        let byte = stop_times_soa_byte(&pristine, 8 * n, 0, 2); // arr_diff col base 8N, width 2
        let mut buf = current_flat_fixture_bytes();
        buf[byte] ^= 0x01; // ^0x01 always flips the low bit => i16 value always changes
        let corrupt = crate::Reader::from_bytes(buf).unwrap();
        assert_ne!(
            corrupt.stop_time(0).unwrap().arr_diff,
            want_arr,
            "arr_diff corruption must be visible"
        );
    }

    #[test]
    fn fail_red_soa_stop_seq_corruption_is_caught() {
        let pristine = crate::Reader::from_bytes(current_flat_fixture_bytes()).unwrap();
        let n = pristine.num_stop_times();
        let want_seq = pristine.stop_time(0).unwrap().stop_seq;
        let byte = stop_times_soa_byte(&pristine, 10 * n, 0, 2); // stop_seq col base 10N, width 2
        let mut buf = current_flat_fixture_bytes();
        buf[byte] ^= 0x01;
        let corrupt = crate::Reader::from_bytes(buf).unwrap();
        assert_ne!(
            corrupt.stop_time(0).unwrap().stop_seq,
            want_seq,
            "stop_seq corruption must be visible"
        );
    }

    /// Add `delta` to the `length` field of the tagged region entry whose region id
    /// is `region_id`. The current tagged table starts at byte 32; each entry is 24 bytes
    /// laid out as `regionId u16 @ +0`, `entryFlags u16 @ +2`, `reserved u32 @ +4`,
    /// `offset u64 @ +8`, `length u64 @ +16` (header.rs:186-188, parse @ +16..+24).
    /// Region id 0 terminates the table.
    fn bump_region_len_by(buf: &mut [u8], region_id: u16, delta: u64) {
        let mut e = 32usize;
        loop {
            assert!(
                e + 24 <= crate::PTB_HEADER_BYTES,
                "region {region_id:#x} not found"
            );
            let id = u16::from_le_bytes(buf[e..e + 2].try_into().unwrap());
            if id == 0 {
                panic!("region {region_id:#x} not found before table terminator");
            }
            if id == region_id {
                let len = u64::from_le_bytes(buf[e + 16..e + 24].try_into().unwrap());
                buf[e + 16..e + 24].copy_from_slice(&(len + delta).to_le_bytes());
                return;
            }
            e += 24;
        }
    }

    #[test]
    fn rejects_stop_times_region_longer_than_tripstarts_current() {
        let mut buf = current_flat_fixture_bytes();
        bump_region_len_by(&mut buf, 0xF4u16, 12);
        assert!(
            matches!(
                crate::Reader::from_bytes(buf),
                Err(PtbError::CountExceedsRegion {
                    region: "stopTimes"
                })
            ),
            "current StopTimes with a row beyond tripStarts[last] must reject at load"
        );
    }

    #[test]
    fn boarding_byte_absent_defaults_to_0x50() {
        use crate::engine::testkit::build_n_trip_ptb_with_boarding;
        let bytes =
            build_n_trip_ptb_with_boarding(&["s0", "s1"], &[&[(0, 0, 100), (1, 1, 200)]], &[]);
        let r = Reader::from_bytes(bytes).unwrap();
        assert_eq!(r.boarding_byte(0), 0x50);
        assert!(!r.pickup_forbidden(0));
        assert!(!r.drop_off_forbidden(0));
    }

    #[test]
    fn boarding_byte_present_decodes_predicates() {
        use crate::engine::testkit::build_n_trip_ptb_with_boarding;
        let bytes = build_n_trip_ptb_with_boarding(
            &["s0", "s1"],
            &[&[(0, 0, 100), (1, 1, 200)]],
            &[0x51, 0x54],
        );
        let r = Reader::from_bytes(bytes).unwrap();
        assert!(r.pickup_forbidden(0) && !r.drop_off_forbidden(0));
        assert!(!r.pickup_forbidden(1) && r.drop_off_forbidden(1));
        assert_eq!(r.boarding_byte(0), 0x51);
    }

    /// Rewrite the `length` field (u64 @+16) of the tagged-table entry whose
    /// regionId == `0xFA` to `new_len`. Entries are 24 B starting at offset 32
    /// (`regionId u16@+0`, `entryFlags u16@+2`, `reserved u32@+4`, `offset u64@+8`,
    /// `length u64@+16`); regionId 0 terminates. Panics if no `0xFA` entry exists,
    /// so a layout drift that drops the region fails the test loudly rather than
    /// silently no-op'ing.
    fn rewrite_boarding_region_length(bytes: &mut [u8], new_len: u64) {
        const TABLE_OFF: usize = 32;
        const ENTRY_BYTES: usize = 24;
        let mut e = TABLE_OFF;
        loop {
            let region_id = u16::from_le_bytes([bytes[e], bytes[e + 1]]);
            if region_id == 0 {
                panic!("no 0xFA StopTimeBoarding entry found in the region table");
            }
            if region_id == crate::region_ids::STOP_TIME_BOARDING {
                bytes[e + 16..e + 24].copy_from_slice(&new_len.to_le_bytes());
                return;
            }
            e += ENTRY_BYTES;
        }
    }

    // T2 redundancy guard: a malformed 0xFA boarding region is rejected on the
    // load/validate gate by `Reader::from_bytes` itself (T1's `length != n_st`
    // check, reader.rs ~209-213; an out-of-bounds offset/length is rejected even
    // earlier, by `Header::parse`'s per-region bounds check). Every structural
    // gate that protects publish / load — pt-serve's `validate_structural` +
    // `Reader::from_bytes` (bundle/handle.rs) — flows through `from_bytes`, so a
    // separate `validate_stop_time_boarding_structural(&Reader)` would be
    // UNREACHABLE dead code (a `&Reader` with a bad boarding region cannot
    // exist). This test pins that rejection so the gate can't silently regress.
    #[test]
    fn malformed_boarding_region_rejected_count_exceeds() {
        use crate::engine::testkit::build_n_trip_ptb_with_boarding;
        // 2 stop_times, valid 2-byte boarding region; corrupt the entry length to
        // num_stop_times + 1 (3). Reader::from_bytes must reject (length != n_st).
        let mut bytes = build_n_trip_ptb_with_boarding(
            &["s0", "s1"],
            &[&[(0, 0, 100), (1, 1, 200)]],
            &[0x51, 0x54],
        );
        rewrite_boarding_region_length(&mut bytes, 3);
        match Reader::from_bytes(bytes) {
            Err(PtbError::CountExceedsRegion {
                region: "stopTimeBoarding",
            }) => {}
            Err(other) => panic!(
                "expected CountExceedsRegion(stopTimeBoarding) for an over-length 0xFA region, got {other:?}"
            ),
            Ok(_) => panic!(
                "expected from_bytes to reject an over-length 0xFA region, but it parsed OK"
            ),
        }
    }

    // ── B1.2 Task A: pattern-band reader accessors ──────────────────────────────
    //
    // The reader resolves the pattern band (`0x10`-`0x14` / `0x45`/`0x46`)
    // ONCE at load and exposes zero-copy accessors over it. These tests drive the
    // committed `pattern-band-tiny.ptb` (the shipped bytes: a branch + a
    // repeated-stop lasso + express-skip + skip-pos-0 over route R0, stops s0..s4)
    // and assert the enumeration, per-pattern stop membership, CSR memberships,
    // and that the `0x13` entry_flags default to 0 (the dense path). A flat-carry
    // bundle (no band) must degrade to `pattern_band_present() == false` with the
    // accessors returning None/empty gracefully.
    mod pattern_band {
        use super::*;

        fn committed_tiny() -> Reader<alloc::vec::Vec<u8>> {
            let bytes: alloc::vec::Vec<u8> = include_bytes!(
                "../../../packages/frontend/tests/services/__fixtures__/pattern-band-tiny.ptb"
            )
            .to_vec();
            Reader::from_bytes(bytes).expect("pattern-band-tiny.ptb decodes")
        }

        /// Find the pattern ordinal whose `pattern_stops` equals `want`, or panic.
        fn find_pattern(r: &Reader<alloc::vec::Vec<u8>>, want: &[u32]) -> usize {
            let pats = r.patterns().expect("patterns present");
            (0..pats.len())
                .find(|&p| r.pattern_stops(p).expect("pattern_stops") == want)
                .unwrap_or_else(|| panic!("no pattern with stops {want:?}"))
        }

        #[test]
        fn band_present_and_enumeration_count() {
            let r = committed_tiny();
            assert!(r.pattern_band_present(), "fixture carries the band");
            // Under Unbounded grouping the 5 trips collapse to 3 patterns:
            // [0,1,2,4] (LOCAL + express-skip + skip-pos-0), [0,1,3,4] (BRANCH),
            // [0,1,2,1,4] (LASSO).
            let pats = r.patterns().expect("patterns present");
            assert_eq!(pats.len(), 3, "0x10 enumeration count");
        }

        /// The batch resolvers ([`Reader::band_trip_times_slabs`] /
        /// [`Reader::band_semantics_bases`]) replaced the per-pattern
        /// [`Reader::band_trip_times_slab`] / [`Reader::band_semantics_base`] on the
        /// index-build hot path: the single-`p` forms re-walk `0..p` (and re-decode
        /// the WHOLE `0x10` record vector) on every call, which is what made the
        /// paris cold load quadratic in `num_trips × num_patterns`.
        ///
        /// The single-`p` forms now have NO production callers and survive only
        /// under `#[allow(dead_code)]`, so nothing else would notice the two
        /// implementations drifting apart — and the span arithmetic is duplicated a
        /// THIRD time in [`Reader::trip_times`]. This test is what keeps them
        /// honest: it makes the old helpers a live oracle for the new ones, so a
        /// wrong offset in the batch prefix walk fails here instead of silently
        /// mis-decoding times at index-build time.
        #[test]
        fn batch_band_resolvers_match_the_per_pattern_helpers() {
            let r = committed_tiny();
            let num_patterns = r.patterns().expect("patterns present").len();

            let slabs = r.band_trip_times_slabs().expect("batch slabs resolve");
            assert_eq!(slabs.len(), num_patterns, "one slab per 0x10 pattern");
            let bases = r
                .band_semantics_bases()
                .expect("batch semantics bases resolve");
            assert_eq!(bases.len(), num_patterns, "one base per 0x10 pattern");

            for p in 0..num_patterns {
                assert_eq!(
                    Some(slabs[p]),
                    r.band_trip_times_slab(p),
                    "0x13 slab mismatch at pattern {p}: the batch prefix walk and the \
                     per-pattern `0..p` walk disagree"
                );
                assert_eq!(
                    bases[p],
                    r.band_semantics_base(p),
                    "0x12 semantics base mismatch at pattern {p}"
                );
            }

            // COVERAGE GUARD — read this before trusting the assertions above.
            //
            // The `0x13` slab arm is genuinely sensitive: perturbing the batch
            // prefix walk by a single byte fails it (verified by mutation).
            //
            // The `0x12` arm is NOT covered. EVERY committed band fixture is
            // 100% all-regular — `nonregular_patterns == 0` for all seven, per
            // `pt-core-emit band-stats` — so `band_semantics_bases`' running
            // `base` accumulator is never advanced past zero and both sides
            // trivially agree on `None`. Mutating that accumulator does NOT fail
            // this test. Covering it needs a fixture with >= 2 NON-regular
            // patterns, which the repo does not currently have.
            //
            // So: assert the slab arm actually did work, so this test can never
            // silently decay into a no-op the way the `0x12` arm already is.
            assert!(
                num_patterns > 0 && slabs.iter().any(|s| s.big_t > 0),
                "fixture exercised no 0x13 slab — the oracle would be vacuous"
            );
        }

        #[test]
        fn pattern_stops_match_topology_incl_lasso_repeat() {
            let r = committed_tiny();
            // The local/express pattern.
            assert_eq!(
                r.pattern_stops(find_pattern(&r, &[0, 1, 2, 4])).unwrap(),
                &[0u32, 1, 2, 4]
            );
            // The branch pattern.
            assert_eq!(
                r.pattern_stops(find_pattern(&r, &[0, 1, 3, 4])).unwrap(),
                &[0u32, 1, 3, 4]
            );
            // The lasso pattern preserves the repeated stop (s1 twice).
            let lasso = find_pattern(&r, &[0, 1, 2, 1, 4]);
            assert_eq!(r.pattern_stops(lasso).unwrap(), &[0u32, 1, 2, 1, 4]);
        }

        #[test]
        fn patterns_record_fields() {
            let r = committed_tiny();
            let pats = r.patterns().expect("patterns present");
            // stops_off is an ELEMENT index into 0x11; the elements of consecutive
            // patterns are contiguous, so each stops_off + stop_count == the next.
            let mut expect_off = 0u32;
            for p in &pats {
                assert_eq!(
                    p.stops_off, expect_off,
                    "stops_off is a contiguous element index"
                );
                expect_off += p.stop_count as u32;
            }
            // Every pattern is all-regular (no pickup/drop-off restriction in the
            // fixture) ⇒ flags.bit0 set.
            for p in &pats {
                assert_eq!(p.flags & 0x01, 0x01, "all-regular flag set");
            }
            // stop_count matches the stop sequence length.
            let lasso = find_pattern(&r, &[0, 1, 2, 1, 4]);
            assert_eq!(pats[lasso].stop_count, 5);
        }

        #[test]
        fn pattern_trips_membership() {
            let r = committed_tiny();
            // The [0,1,2,4] pattern owns trips {0,3,4} (LOCAL + express-skip + skip-pos-0).
            let local = find_pattern(&r, &[0, 1, 2, 4]);
            let mut trips = r.pattern_trips(local).expect("pattern_trips").to_vec();
            trips.sort();
            assert_eq!(trips, alloc::vec![0u32, 3, 4]);
            // The branch pattern owns exactly trip 1; the lasso exactly trip 2.
            let branch = find_pattern(&r, &[0, 1, 3, 4]);
            assert_eq!(r.pattern_trips(branch).unwrap(), &[1u32]);
            let lasso = find_pattern(&r, &[0, 1, 2, 1, 4]);
            assert_eq!(r.pattern_trips(lasso).unwrap(), &[2u32]);
        }

        #[test]
        fn patterns_at_stop_membership() {
            let r = committed_tiny();
            let local = find_pattern(&r, &[0, 1, 2, 4]) as u32;
            let branch = find_pattern(&r, &[0, 1, 3, 4]) as u32;
            let lasso = find_pattern(&r, &[0, 1, 2, 1, 4]) as u32;
            // s3 only appears in the branch pattern.
            assert_eq!(r.patterns_at_stop(3).expect("patterns_at_stop"), &[branch]);
            // s0 appears in all three (deduped, sorted by build order).
            let mut at_s0 = r.patterns_at_stop(0).unwrap().to_vec();
            at_s0.sort();
            let mut all = alloc::vec![local, branch, lasso];
            all.sort();
            assert_eq!(at_s0, all, "s0 served by every pattern");
            // s2 appears in the local + lasso patterns (NOT branch).
            let mut at_s2 = r.patterns_at_stop(2).unwrap().to_vec();
            at_s2.sort();
            let mut want = alloc::vec![local, lasso];
            want.sort();
            assert_eq!(at_s2, want);
        }

        #[test]
        fn trip_times_slice_and_entry_flags_dense() {
            let r = committed_tiny();
            // 0x13's entry_flags must be the dense default (0): no ragged/i32 bit.
            assert_eq!(r.trip_times_entry_flags(), Some(0), "0x13 dense default");
            assert!(!r.trip_times_is_ragged().unwrap(), "bit0 ragged clear");
            assert!(!r.trip_times_is_i32_deltas().unwrap(), "bit1 i32 clear");
            // The raw 0x13 slice for the lasso pattern has the locked size:
            // T*(4 + 4*S + ceil(S/8)). Lasso: T=1, S=5 ⇒ 4 + 20 + 1 = 25 bytes.
            let lasso = find_pattern(&r, &[0, 1, 2, 1, 4]);
            let slice = r.trip_times(lasso).expect("trip_times slice");
            assert_eq!(slice.len(), 25, "lasso 0x13 slice = T*(4+4S+ceil(S/8))");
            // The local pattern: T=3, S=4 ⇒ 3*(4 + 16 + 1) = 63 bytes.
            let local = find_pattern(&r, &[0, 1, 2, 4]);
            assert_eq!(r.trip_times(local).unwrap().len(), 3 * 21);
        }

        #[test]
        fn semantics_omitted_and_trip_meta_carried() {
            let r = committed_tiny();
            // The fixture is all-regular ⇒ 0x12 omitted entirely.
            assert!(!r.has_pattern_semantics(), "all-regular ⇒ 0x12 omitted");
            assert_eq!(r.pattern_semantics(), None);
            // 0x14 TripMeta is always carried: 24 B per trip (5 trips here).
            let tm = r.trip_meta_raw().expect("trip_meta carried");
            assert_eq!(tm.len(), r.num_trips() * 24);
            // Each trip's pattern_idx backref (@+0) must be a valid pattern ordinal.
            let n_pat = r.patterns().unwrap().len() as u32;
            for t in 0..r.num_trips() {
                let pat = u32::from_le_bytes(tm[t * 24..t * 24 + 4].try_into().unwrap());
                assert!(pat < n_pat, "trip {t} pattern_idx {pat} in range");
            }
        }

        /// Rewrite a tagged-table region entry's `length u64` (low 32 bits) in
        /// place, returning the original body offset. Walks the table from byte 32
        /// in 24 B strides until it finds `region_id`.
        fn poke_region_length(buf: &mut [u8], region_id: u16, new_len: u32) {
            let mut e = 32;
            loop {
                let id = u16::from_le_bytes(buf[e..e + 2].try_into().unwrap());
                assert_ne!(id, 0, "region 0x{region_id:02X} not found");
                if id == region_id {
                    buf[e + 16..e + 20].copy_from_slice(&new_len.to_le_bytes());
                    return;
                }
                e += 24;
            }
        }

        /// Byte offset of a region body (from its tagged-table entry).
        fn region_body_off(buf: &[u8], region_id: u16) -> usize {
            let mut e = 32;
            loop {
                let id = u16::from_le_bytes(buf[e..e + 2].try_into().unwrap());
                assert_ne!(id, 0, "region 0x{region_id:02X} not found");
                if id == region_id {
                    return u32::from_le_bytes(buf[e + 8..e + 12].try_into().unwrap()) as usize;
                }
                e += 24;
            }
        }

        fn tiny_bytes() -> alloc::vec::Vec<u8> {
            include_bytes!(
                "../../../packages/frontend/tests/services/__fixtures__/pattern-band-tiny.ptb"
            )
            .to_vec()
        }

        #[test]
        fn gate_rejects_truncated_trip_times_length() {
            // Shrink the 0x13 TripTimes region length by 4 B: the per-pattern span
            // sum no longer equals the declared length ⇒ hard PatternBandInvalid.
            let mut bytes = tiny_bytes();
            let orig = crate::region_ids::TRIP_TIMES;
            // current length: find the entry, read it, subtract 4.
            let mut e = 32;
            let cur_len = loop {
                let id = u16::from_le_bytes(bytes[e..e + 2].try_into().unwrap());
                if id == orig {
                    break u32::from_le_bytes(bytes[e + 16..e + 20].try_into().unwrap());
                }
                e += 24;
            };
            poke_region_length(&mut bytes, orig, cur_len - 4);
            match Reader::from_bytes(bytes) {
                Err(PtbError::PatternBandInvalid {
                    reason: "tripTimes length",
                }) => {}
                Err(other) => {
                    panic!("expected PatternBandInvalid(tripTimes length), got {other:?}")
                }
                Ok(_) => panic!("expected from_bytes to reject the truncated 0x13 length"),
            }
        }

        #[test]
        fn gate_rejects_out_of_range_pattern_stop_ordinal() {
            // Poke a 0x11 PatternStops element to an out-of-range stop ordinal
            // (num_stops = 5 ⇒ 99 is invalid) ⇒ hard PatternBandInvalid.
            let mut bytes = tiny_bytes();
            let ps_off = region_body_off(&bytes, crate::region_ids::PATTERN_STOPS);
            // First 0x11 element (pattern 0 position 0) → 99.
            bytes[ps_off..ps_off + 4].copy_from_slice(&99u32.to_le_bytes());
            match Reader::from_bytes(bytes) {
                Err(PtbError::PatternBandInvalid {
                    reason: "patternStops ordinal out of range",
                }) => {}
                Err(other) => {
                    panic!("expected PatternBandInvalid(patternStops ordinal), got {other:?}")
                }
                Ok(_) => panic!("expected from_bytes to reject the out-of-range stop ordinal"),
            }
        }

        #[test]
        fn gate_rejects_out_of_range_pattern_trip_ordinal() {
            // Poke a 0x46 PatternTrips value to an out-of-range trip ordinal
            // (num_trips = 5 ⇒ 99 invalid). The values follow the
            // offsets[numPatterns+1] prefix in the same region body.
            let mut bytes = tiny_bytes();
            let pt_off = region_body_off(&bytes, crate::region_ids::PATTERN_TRIPS);
            // numPatterns = 3 ⇒ offsets occupy (3+1)*4 = 16 bytes; the first value
            // starts at +16. Poke it to 99.
            let v0 = pt_off + 16;
            bytes[v0..v0 + 4].copy_from_slice(&99u32.to_le_bytes());
            match Reader::from_bytes(bytes) {
                Err(PtbError::PatternBandInvalid {
                    reason: "patternTrips ordinal out of range",
                }) => {}
                Err(other) => {
                    panic!("expected PatternBandInvalid(patternTrips ordinal), got {other:?}")
                }
                Ok(_) => panic!("expected from_bytes to reject the out-of-range trip ordinal"),
            }
        }

        #[test]
        fn gate_rejects_truncated_trip_meta_length() {
            // Shrink the 0x14 TripMeta region length by 24 B (one record): the
            // region no longer holds `num_trips * 24` B, so `trip_pattern_idx(t)`
            // for the last trip would read into the following region ⇒ hard
            // PatternBandInvalid before any accessor can mis-group trips.
            let mut bytes = tiny_bytes();
            let id = crate::region_ids::TRIP_META;
            let mut e = 32;
            let cur_len = loop {
                let rid = u16::from_le_bytes(bytes[e..e + 2].try_into().unwrap());
                if rid == id {
                    break u32::from_le_bytes(bytes[e + 16..e + 20].try_into().unwrap());
                }
                e += 24;
            };
            poke_region_length(&mut bytes, id, cur_len - 24);
            match Reader::from_bytes(bytes) {
                Err(PtbError::PatternBandInvalid {
                    reason: "tripMeta length",
                }) => {}
                Err(other) => {
                    panic!("expected PatternBandInvalid(tripMeta length), got {other:?}")
                }
                Ok(_) => panic!("expected from_bytes to reject the truncated 0x14 length"),
            }
        }

        #[test]
        fn gate_rejects_trip_meta_pattern_trips_disagreement() {
            // Flip one trip's 0x14 pattern_idx to a DIFFERENT in-range pattern so
            // its 0x14 grouping disagrees with the 0x46 PatternTrips membership
            // (which still claims the original pattern). The cross-check must
            // reject — even though every individual region is internally valid
            // and the mutated ordinal stays in range (so no ordinal gate fires).
            let mut bytes = tiny_bytes();
            let n_pat = {
                let r = committed_tiny();
                r.patterns().unwrap().len() as u32
            };
            assert!(n_pat >= 2, "need >=2 patterns to flip to a distinct one");
            let tm_off = region_body_off(&bytes, crate::region_ids::TRIP_META);
            // Trip 1's pattern_idx lives at record 1, field @+0 (u32).
            let t1 = tm_off + 24;
            let cur = u32::from_le_bytes(bytes[t1..t1 + 4].try_into().unwrap());
            let flipped = (cur + 1) % n_pat; // a DIFFERENT valid pattern ordinal
            bytes[t1..t1 + 4].copy_from_slice(&flipped.to_le_bytes());
            match Reader::from_bytes(bytes) {
                Err(PtbError::PatternBandInvalid {
                    reason: "tripMeta/patternTrips disagree",
                }) => {}
                Err(other) => {
                    panic!("expected PatternBandInvalid(tripMeta/patternTrips disagree), got {other:?}")
                }
                Ok(_) => {
                    panic!("expected from_bytes to reject the 0x14/0x46 grouping disagreement")
                }
            }
        }

        #[test]
        fn flat_carry_bundle_has_no_band() {
            // build_two_trip_ptb emits the flat carry and no band. The accessors
            // degrade gracefully (None / empty), never panic.
            use crate::engine::testkit::build_two_trip_ptb;
            let bytes = build_two_trip_ptb(
                3,
                &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
                &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400)],
            );
            let r = Reader::from_bytes(bytes).unwrap();
            assert!(!r.pattern_band_present(), "flat carry, no band");
            assert!(r.patterns().is_none());
            assert!(r.pattern_stops(0).is_none());
            assert!(r.pattern_trips(0).is_none());
            assert!(r.patterns_at_stop(0).is_none());
            assert!(r.trip_times(0).is_none());
            assert_eq!(r.trip_times_entry_flags(), None);
        }

        // ── B1.5↔C2a integration: `stop_time(i)` over a CARRY-LESS band ────────
        //
        // The flat `0xF4 StopTimes` carry is stripped on a carry-less bundle, so
        // a flat `stop_time(i)` decode would OOB-read the zero-length slot. The two
        // pt-serve consumers (`/stops/all` membership, `/scheduled-departures-for-
        // stop`) call `stop_time(i).stop_idx`, so this MUST band-reconstruct. The
        // carry-bearing bundle of the SAME topology is the oracle: row-for-row
        // `stop_time` equality (all fields) proves the reconstruction is exact.

        const CARRY_IDS: &[u16] = &[0xF4, 0xF5, 0xF6, 0xFA];

        /// `(carry_bearing, carry_less)` readers of the same band topology.
        fn carry_pair(
            n_stops: u32,
            trips: &[&[(u16, u32, u32)]],
            sentinel_rows: &[usize],
        ) -> (Reader<alloc::vec::Vec<u8>>, Reader<alloc::vec::Vec<u8>>) {
            use crate::engine::testkit::{build_pattern_band_ptb, SoaRoute, SoaStop};
            const IDS: [&str; 10] = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"];
            let stops: alloc::vec::Vec<SoaStop<'static>> = (0..n_stops as usize)
                .map(|i| SoaStop {
                    id: IDS[i],
                    name: IDS[i],
                    lat: 54.68 + i as f64 * 0.001,
                    lon: 25.27 + i as f64 * 0.001,
                    parent: None,
                    wheelchair: 0,
                })
                .collect();
            let routes = alloc::vec![SoaRoute {
                id: "R0",
                agency: "A0",
                short: "1",
                long: "Band",
                color: "",
                text_color: "",
                route_type: 3,
            }];
            let full = build_pattern_band_ptb(&stops, &routes, trips, sentinel_rows);
            let stripped =
                crate::strip_regions::strip_regions(full.clone(), CARRY_IDS).expect("strip");
            (
                Reader::from_bytes(full).expect("carry-bearing decodes"),
                Reader::from_bytes(stripped).expect("carry-LESS decodes"),
            )
        }

        /// Off mode on a carry-less bundle routes through the flat per-row
        /// boarding accessors, so they must read the band's `0x12` semantics once
        /// the `0xFA` carry is stripped. The carry-bearing bundle of the same
        /// topology is the oracle.
        #[test]
        fn boarding_byte_band_reconstructs_carry_less_v9() {
            use crate::engine::testkit::{build_pattern_band_ptb_with_boarding, SoaRoute, SoaStop};
            let stops: alloc::vec::Vec<SoaStop<'static>> = ["s0", "s1", "s2", "s3"]
                .iter()
                .enumerate()
                .map(|(i, id)| SoaStop {
                    id,
                    name: id,
                    lat: 54.68 + i as f64 * 0.001,
                    lon: 25.27 + i as f64 * 0.001,
                    parent: None,
                    wheelchair: 0,
                })
                .collect();
            let routes = alloc::vec![SoaRoute {
                id: "R0",
                agency: "A0",
                short: "1",
                long: "Band",
                color: "",
                text_color: "",
                route_type: 3,
            }];
            // trip 0 [s0,s1,s2]: pickup_type 1 at s1. trip 1 [s0,s3,s2]:
            // drop_off_type 1 at s3, pickup_type 2 (still boardable) at s0.
            let trips: &[&[(u16, u32, u32)]] = &[
                &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
                &[(1, 0, 28800), (2, 3, 29100), (3, 2, 29400)],
            ];
            let boarding = [0x50u8, 0x51, 0x50, 0x52, 0x54, 0x50];
            let full =
                build_pattern_band_ptb_with_boarding(&stops, &routes, trips, &[], &boarding, &[]);
            let stripped =
                crate::strip_regions::strip_regions(full.clone(), CARRY_IDS).expect("strip");
            let rf = Reader::from_bytes(full).expect("carry-bearing decodes");
            let rs = Reader::from_bytes(stripped).expect("carry-LESS decodes");
            assert!(rs.is_carry_less_band() && !rs.has_boarding());
            assert!(
                rs.has_pattern_semantics(),
                "non-regular boarding survives in 0x12"
            );
            assert_eq!(rs.num_stop_times(), rf.num_stop_times());
            for i in 0..rf.num_stop_times() {
                assert_eq!(
                    rs.pickup_forbidden(i),
                    rf.pickup_forbidden(i),
                    "pickup row {i}"
                );
                assert_eq!(
                    rs.drop_off_forbidden(i),
                    rf.drop_off_forbidden(i),
                    "drop-off row {i}"
                );
                assert_eq!(
                    rs.boarding_byte(i) & 0x0F,
                    rf.boarding_byte(i) & 0x0F,
                    "pickup/drop-off nibble row {i}"
                );
            }
            assert!(rs.pickup_forbidden(1) && rs.drop_off_forbidden(4));
            assert!(!rs.pickup_forbidden(3), "pickup_type 2 stays boardable");
        }

        #[test]
        fn stop_time_band_reconstructs_carry_less_v9_branch_lasso() {
            // trip 0 LOCAL [s0,s1,s2,s4]; 1 BRANCH [s0,s1,s3,s4]; 2 LASSO
            // [s0,s1,s2,s1,s4] (revisits s1, like Vilnius 6G). Mixed dwells exercise
            // arr_diff; the lasso exercises a repeated stop ordinal at distinct pos.
            let trips: &[&[(u16, u32, u32)]] = &[
                &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25830), (4, 4, 26100)],
                &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29460), (4, 4, 29700)],
                &[
                    (1, 0, 32400),
                    (2, 1, 32700),
                    (3, 2, 33000),
                    (4, 1, 33330),
                    (5, 4, 33600),
                ],
            ];
            let (rf, rs) = carry_pair(5, trips, &[]);

            assert!(rs.is_carry_less_band(), "stripped bundle is carry-less");
            assert!(!rf.is_carry_less_band(), "full bundle is carry-bearing");
            assert_eq!(
                rs.num_stop_times(),
                rf.num_stop_times(),
                "carry-less num_stop_times == carry-bearing (synth prefix-sum)"
            );

            // Per-row: dep_secs / arr_diff / stop_idx on the carry-less band path
            // equal the carry-bearing flat decode (the field-consistency contract
            // C2a/C2c rely on — `/stops` membership reads `.stop_idx`). RED before
            // the band branch — `stop_time` OOB-errored on every row.
            //
            // `stop_seq` is DELIBERATELY excluded from the cross-carry compare: the
            // carry-less convention (shared by `project()` + TS `bandToFlatStopTimes`)
            // sets `stop_seq = canonical position`, because the band carries no GTFS
            // `stop_sequence` (the `PatternStopSeq` column is deferred). The flat
            // carry keeps the original GTFS sequence. Consumers only SORT by
            // `stop_seq`, never read its absolute value, so canonical position is
            // sufficient — and it is what `project()` emits, the golden this
            // reconstruction must match. `stop_seq == pos` is asserted below.
            for i in 0..rf.num_stop_times() {
                let want = rf.stop_time(i).expect("carry-bearing stop_time");
                let got = rs
                    .stop_time(i)
                    .unwrap_or_else(|e| panic!("carry-less stop_time({i}) errored: {e:?}"));
                assert_eq!(got.dep_secs, want.dep_secs, "stop_time({i}) dep_secs");
                assert_eq!(got.arr_diff, want.arr_diff, "stop_time({i}) arr_diff");
                assert_eq!(got.stop_idx, want.stop_idx, "stop_time({i}) stop_idx");
            }

            // The reconstructed dep/arr also equal the band time decoders directly
            // (independent of the flat oracle): for trip t, local slab row j, pos.
            let ts = rs.trip_starts().expect("synth trip_starts");
            for (t, &trip_start) in ts.iter().take(rs.num_trips()).enumerate() {
                let p = rs.trip_pattern_idx(t).expect("pattern idx") as usize;
                let pt = rs.pattern_trips(p).expect("pattern_trips");
                let j = pt.iter().position(|&g| g as usize == t).expect("j");
                let stops = rs.pattern_stops(p).expect("pattern_stops");
                for (pos, &stop_idx) in stops.iter().enumerate() {
                    let i = trip_start as usize + pos;
                    let st = rs.stop_time(i).expect("carry-less stop_time");
                    assert_eq!(st.stop_idx, stop_idx, "stop_idx == pattern_stops[pos]");
                    assert_eq!(st.stop_seq as usize, pos, "stop_seq == canonical pos");
                    let dep = rs.band_dep_secs(p, j, pos).expect("band dep");
                    assert_eq!(st.dep_secs, dep as u32, "dep_secs == band dep");
                    let arr = rs.band_arr_secs(p, j, pos).expect("band arr");
                    assert_eq!(
                        st.dep_secs as i64 + st.arr_diff as i64,
                        arr,
                        "dep + arr_diff == band arr"
                    );
                }
            }
        }

        #[test]
        fn stop_time_band_reconstructs_not_served_sentinel() {
            // A single express-skip sentinel row pokes a NOT_SERVED hole; the
            // reconstructed row must mirror the flat carry's sentinel (0xFFFFFFFF
            // dep, 0 arr_diff) — exactly what `bandToFlatStopTimes` emits.
            // trip 0 [s0,s1,s2,s3]; trip 1 express-skips s2 (row 4+2 = 6 poked).
            let trips: &[&[(u16, u32, u32)]] = &[
                &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 3, 26100)],
                &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400), (4, 3, 29700)],
            ];
            let (rf, rs) = carry_pair(4, trips, &[6]);
            assert!(rs.is_carry_less_band(), "carry-less");
            // dep/arr/stop_idx match the flat oracle (stop_seq excluded — see the
            // carry-less convention note in the branch_lasso test).
            for i in 0..rf.num_stop_times() {
                let got = rs.stop_time(i).expect("carry-less stop_time");
                let want = rf.stop_time(i).expect("carry-bearing stop_time");
                assert_eq!(got.dep_secs, want.dep_secs, "sentinel row {i} dep_secs");
                assert_eq!(got.arr_diff, want.arr_diff, "sentinel row {i} arr_diff");
                assert_eq!(got.stop_idx, want.stop_idx, "sentinel row {i} stop_idx");
            }
            // The poked row decodes to the NOT_SERVED sentinel on BOTH paths.
            let sentinel = rs.stop_time(6).expect("sentinel row");
            assert_eq!(sentinel.dep_secs, 0xFFFF_FFFF, "NOT_SERVED dep sentinel");
            assert_eq!(sentinel.arr_diff, 0, "NOT_SERVED arr_diff zero");
            assert_eq!(
                rf.stop_time(6).expect("carry-bearing sentinel").dep_secs,
                0xFFFF_FFFF,
                "carry-bearing sentinel also NOT_SERVED"
            );
        }

        #[test]
        fn stop_time_out_of_bounds_errors_on_carry_less() {
            let trips: &[&[(u16, u32, u32)]] = &[&[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)]];
            let (_rf, rs) = carry_pair(3, trips, &[]);
            let n = rs.num_stop_times();
            assert!(rs.stop_time(n).is_err(), "i == n is out of bounds");
            assert!(rs.stop_time(n + 5).is_err(), "i > n is out of bounds");
        }
    }
}
