//! Current PTB v1 bundle emitter.
//!
//! The final bundle shape matches `pt-core::Reader`:
//! - 4096 B header prefix, then page-aligned region bodies;
//! - a 24 B tagged region table at header byte 32
//!   (`regionId u16 @0 | entryFlags u16 @2 | reserved u32 @4 | offset u64 @8 |
//!   length u64 @16`), terminated by a trailing zero `regionId`;
//! - SoA stop/route columns, intern tables, deduplicated service bitfields,
//!   string pool, transfers, and the route-pattern timetable band;
//! - optional WindowMeta, PatternSemantics, and Frequencies regions.

use crate::error::Result;
use crate::interns::{
    write_routes_soa, write_stops_soa, ROUTES_SOA_BYTES_PER_ROUTE, STOPS_SOA_BYTES_PER_STOP,
};
use crate::strpool::StringPool;

/// Header prefix size and page granularity.
const PAGE: usize = 4096;
const HEADER: usize = 4096;

/// Region IDs for the two SoA columns.
const STOPS_SOA: u16 = 0x40;
const ROUTES_SOA: u16 = 0x41;

/// `0x17 Frequencies` — GTFS `frequencies.txt` rows. Must match
/// `pt-core`'s `region_ids::FREQUENCIES`). 16 B/record; count u32 LE prefix;
/// sorted by `(tripIdx, startSecs)` and omitted when empty.
const FREQUENCIES: u16 = 0x17;

/// Intern and temporary timetable region IDs used while constructing the
/// current pattern band. The final bundle retains TripsIntern, StringPool, and
/// Transfers; the temporary timetable regions are stripped before return.
const TRIPS_INTERN: u16 = 0xF2;
const STAGING_STOP_TIMES: u16 = 0xF4;
const STAGING_TRIP_STARTS: u16 = 0xF5;
const STAGING_CSR: u16 = 0xF6;
const STRING_POOL: u16 = 0xF7;
const TRANSFERS: u16 = 0xF8;

/// Temporary `StopTimeBoarding` region (`0xFA`): one packed boarding byte per
/// stop_time (`pickup_type[1:0] · drop_off_type[3:2] · continuous_pickup[5:4] ·
/// continuous_drop_off[7:6]`; default `0x50`). Emitted ONLY when at least one
/// byte is non-default. It feeds `0x12 PatternSemantics` and is stripped from
/// the final bundle. Must match `pt-core`'s region ID.
const STAGING_STOP_TIME_BOARDING: u16 = 0xFA;

/// Service-bitfield pool storage. `0x15 ServiceBitfieldPool` holds a
/// `count u32` prefix then `count × S` DISTINCT service day-vectors (`S =
/// bytes_per_service(windowDays)`); `0x16 ServiceToBitfield` is `numServices ×
/// u32` LE pool indices, one per service. Must match `pt-core`'s
/// `region_ids::{SERVICE_BITFIELD_POOL, SERVICE_TO_BITFIELD}`. `0x16` is
/// registry-`Align(4)` (a u32 array); `0x15` is `Align(1)`.
const SERVICE_BITFIELD_POOL: u16 = 0x15;
const SERVICE_TO_BITFIELD: u16 = 0x16;

/// Registry alignment for `0x16 ServiceToBitfield` — a `u32` array, so the
/// reader reads LE u32 at the region offset; the emit MUST 4-align the body.
const SERVICE_TO_BITFIELD_ALIGN: usize = 4;

/// `0x01 WindowMeta` carries the derived `windowDays`. Must match
/// `pt-core`'s `region_ids::WINDOW_META`. 4-byte body: `windowDays u16 LE` +
/// `reserved u16 LE = 0`. Omitted when `windowDays` equals the 90-day default.
const WINDOW_META: u16 = 0x01;

/// Pattern-band region IDs. Must match
/// `pt-core`'s `region_ids::{PATTERNS, PATTERN_STOPS, PATTERN_SEMANTICS,
/// TRIP_TIMES, TRIP_META, PATTERNS_AT_STOP, PATTERN_TRIPS}`. `0x12
/// PatternSemantics` is omitted when every stop-time uses default semantics.
const PATTERNS: u16 = 0x10;
const PATTERN_STOPS: u16 = 0x11;
const PATTERN_SEMANTICS: u16 = 0x12;
const TRIP_TIMES: u16 = 0x13;
const TRIP_META: u16 = 0x14;
const PATTERNS_AT_STOP: u16 = 0x45;
const PATTERN_TRIPS: u16 = 0x46;

/// Round `n` up to the next multiple of `a` (mirrors testkit `align`).
#[inline]
fn align(n: usize, a: usize) -> usize {
    n.div_ceil(a) * a
}

/// AoS StopTimes (12 B/row: dep u32@0, arr i16@4, stop_idx u32@6, seq u16@10) ->
/// SoA columns (dep[0..], stop_idx[4N..], arr[8N..], seq[10N..]). Total bytes unchanged.
pub fn transpose_stop_times_aos_to_soa(aos: &[u8]) -> Vec<u8> {
    let n = aos.len() / 12;
    let mut soa = vec![0u8; aos.len()];
    for i in 0..n {
        let o = i * 12;
        soa[4 * i..4 * i + 4].copy_from_slice(&aos[o..o + 4]); // dep
        soa[4 * n + 4 * i..4 * n + 4 * i + 4].copy_from_slice(&aos[o + 6..o + 10]); // stop_idx
        soa[8 * n + 2 * i..8 * n + 2 * i + 2].copy_from_slice(&aos[o + 4..o + 6]); // arr
        soa[10 * n + 2 * i..10 * n + 2 * i + 2].copy_from_slice(&aos[o + 10..o + 12]);
        // seq
    }
    soa
}

/// Sparse (child_idx, parent_idx) pairs -> dense parent_idx[num_stops], with
/// u32::MAX for unparented stops. Absent MUST be u32::MAX (the reader's
/// "no parent" sentinel), never 0 (a valid stop ordinal).
pub fn dense_parent_idx(num_stops: usize, pairs: &[(u32, u32)]) -> Vec<u32> {
    let mut v = vec![u32::MAX; num_stops];
    for &(child, parent) in pairs {
        v[child as usize] = parent;
    }
    v
}

/// Write the 24-byte tagged region table at header byte 32.
///
/// Entry layout (mirrors `pt-core` `header.rs` parse + the testkit writer):
/// `regionId u16 @+0 | entryFlags u16 @+2 | reserved u32 @+4 | offset u64 @+8 |
/// length u64 @+16`. `entries` is `(region_id, offset, length)`; the trailing
/// 24 B slot stays zero so a `regionId == 0` terminates the table.
///
/// The caller owns sizing `header` so that `32 + (entries.len()+1)*24` fits
/// (and stays within the 4096 B header prefix the reader scans).
pub fn emit_region_table(header: &mut [u8], entries: &[(u16, u64, u64)]) {
    for (i, (region_id, off, len)) in entries.iter().enumerate() {
        let e = 32 + i * 24;
        header[e..e + 2].copy_from_slice(&region_id.to_le_bytes()); // flags@+2, reserved@+4 stay 0
        header[e + 8..e + 16].copy_from_slice(&off.to_le_bytes());
        header[e + 16..e + 24].copy_from_slice(&len.to_le_bytes());
    }
    // The next 24 B slot stays zero → regionId 0 terminates the table.
}

/// Assemble current PTB v1 as a flat `Vec<u8>`.
///
/// Produces the two SoA bodies in-process (`0x40` via [`write_stops_soa`],
/// `0x41` via [`write_routes_soa`], using [`dense_parent_idx`] for the dense
/// parent column). Temporary timetable slices are supplied as tightly sized
/// inputs, used to build the pattern band, and removed before return. Every
/// retained body is page-aligned except the compact 0x16 pool index, which is
/// naturally aligned to four bytes. The tagged table is written by
/// [`emit_region_table`].
///
/// `stop_time_boarding` is the per-stop_time packed boarding column (global-row
/// order, length == num_stop_times). The `0xFA` region is emitted ONLY when at
/// least one byte is non-default (`!= 0x50`): an all-default feed omits the
/// region entirely (the reader then defaults every stop_time to `0x50`). Pass
/// `&[]` to omit unconditionally.
///
/// `service_pool` is the `count × S` distinct-bitfield body (the emitter writes
/// the count prefix); `service_to_bitfield` is the `numServices × u32` LE index.
#[allow(clippy::too_many_arguments)]
pub fn build_current_bundle(
    stop_keys: &[String],
    stops_attrs: &[crate::pass1::attrs::StopAttrs],
    route_keys: &[String],
    routes_attrs: &[crate::pass1::attrs::RouteAttrs],
    parent_pairs: &[(u32, u32)],
    pool: &StringPool,
    trips: &[u8],
    stop_times: &[u8],
    trip_starts: &[u8],
    csr: &[u8],
    string_pool: &[u8],
    transfers: &[u8],
    stop_time_boarding: &[u8],
    service_pool: &[u8],
    service_to_bitfield: &[u8],
    service_pool_count: u32,
    num_stops: u32,
    num_routes: u32,
    num_trips: u32,
    num_services: u32,
    feed_start_date: u32,
    city_tz_offset_seconds: i32,
    window_days: u16,
    // GTFS `frequencies.txt` rows. The region is omitted when empty.
    frequencies: &[crate::pass1::FrequencyRow],
) -> Result<Vec<u8>> {
    // Transpose the temporary 12-byte AoS rows into the current SoA columns.
    // Total length is unchanged.
    let stop_times_owned = transpose_stop_times_aos_to_soa(stop_times);
    let stop_times = stop_times_owned.as_slice();

    // --- SoA column bodies (tight) -------------------------------------------
    let stops_soa_len = stop_keys.len() * STOPS_SOA_BYTES_PER_STOP;
    let mut stops_soa = vec![0u8; stops_soa_len];
    let parent_idx = dense_parent_idx(stop_keys.len(), parent_pairs);
    write_stops_soa(&mut stops_soa, stop_keys, stops_attrs, &parent_idx, pool)?;

    let routes_soa_len = route_keys.len() * ROUTES_SOA_BYTES_PER_ROUTE;
    let mut routes_soa = vec![0u8; routes_soa_len];
    write_routes_soa(&mut routes_soa, route_keys, routes_attrs, pool)?;

    // Build `0x15` as count prefix plus distinct bitfields; `0x16` is the
    // verbatim per-service pool index.
    let mut service_pool_region = Vec::with_capacity(4 + service_pool.len());
    service_pool_region.extend_from_slice(&service_pool_count.to_le_bytes());
    service_pool_region.extend_from_slice(service_pool);

    // --- Lay out regions; each starts PAGE-aligned (⇒ 4-aligned). The table
    //     `length` is the TIGHT body length (reader/parity derive every column
    //     range from the START via tight strides). Mirrors the reference's
    //     `place(len, cursor)` closure exactly. ---
    let mut cursor = HEADER;
    let mut place = |body: &[u8]| -> (usize, usize) {
        let off = cursor;
        let len = body.len();
        cursor = align(cursor + len, PAGE);
        (off, len)
    };
    // Order is normative: 0x40, 0x41, 0xF2, 0x15/0x16, then 0xF4..0xF8.
    let (stops_soa_off, stops_soa_b) = place(&stops_soa);
    let (routes_soa_off, routes_soa_b) = place(&routes_soa);
    let (trips_off, trips_b) = place(trips);
    // Pool-pair placement: 0x15 starts page-aligned (the
    // prior `place(trips)` left the cursor page-aligned) but its cursor advance
    // is TIGHT (NOT page-padded) so 0x16 follows COMPACTLY at registry
    // `Align(SERVICE_TO_BITFIELD_ALIGN)` — genuinely exercising the align-4 path
    // (I4), not a page-aligned no-op. After 0x16 the cursor is RE-PAGED so the
    // FOLLOWING region (0xF4) still lands PAGE-aligned like every other body.
    let svc_pool_off = cursor;
    let svc_pool_b = service_pool_region.len();
    cursor += svc_pool_b;
    let s2b_off = align(cursor, SERVICE_TO_BITFIELD_ALIGN);
    let s2b_b = service_to_bitfield.len();
    cursor = align(s2b_off + s2b_b, PAGE);
    // Re-establish the `place` closure for the remaining regions.
    let mut place = |body: &[u8]| -> (usize, usize) {
        let off = cursor;
        let len = body.len();
        cursor = align(cursor + len, PAGE);
        (off, len)
    };
    let (st_off, st_b) = place(stop_times);
    let (ts_off, ts_b) = place(trip_starts);
    let (csr_off, csr_b) = place(csr);
    let (pool_off, pool_b) = place(string_pool);
    let (transfers_off, transfers_b) = place(transfers);

    // Optional 0xFA StopTimeBoarding: omit entirely when every byte is the
    // 0x50 default (an all-default feed → no region; the reader then defaults
    // each stop_time to 0x50). When emitted, it is 1:1 with stop_times rows, so
    // its length MUST equal the StopTimes region row count — assert it here so a
    // mis-sized column fails the build rather than tripping the reader's
    // `length == num_stop_times` check downstream. `st_b` is the TIGHT
    // StopTimes body length (== 12·N for both AoS and SoA), so N = st_b / 12.
    let emit_boarding = stop_time_boarding.iter().any(|&b| b != 0x50);
    if emit_boarding {
        let n_st = st_b / crate::layout::STOP_TIME_ROW_BYTES as usize;
        if stop_time_boarding.len() != n_st {
            return Err(crate::error::Error::Config(format!(
                "current PTB emit: StopTimeBoarding length {} != num_stop_times {n_st}",
                stop_time_boarding.len()
            )));
        }
    }
    let (boarding_off, boarding_b) = if emit_boarding {
        place(stop_time_boarding)
    } else {
        (0, 0)
    };

    // Optional 0x01 WindowMeta: emit ONLY when the derived window exceeds the
    // 90-day default (omit-at-default, the 0xFA precedent). 4-byte body
    // (windowDays u16 LE + reserved u16 LE). ALIGNMENT (M10): a NATURAL 2-byte
    // boundary — the body is two u16s, so we 2-align the offset rather than
    // burning a full page on a 4-byte cold container; every other region is
    // PAGE-aligned and PAGE % 2 == 0, so the prior cursor is already even,
    // making this align a no-op in practice but explicit for correctness. The
    // reader (pt-core header.rs) reads the LE u16 at the table offset with no
    // stricter alignment requirement than this.
    let emit_window_meta = window_days > pt_core::WINDOW_DEFAULT_DAYS;
    let (window_meta_off, window_meta_b) = if emit_window_meta {
        let off = align(cursor, 2);
        cursor = off + 4;
        (off, 4usize)
    } else {
        (0, 0)
    };

    let total = align(cursor, PAGE);

    let mut buf = vec![0u8; total];

    // Header prefix: stamp current PTB v1. The 32-byte prefix stores counts at
    // [8..28], tz at [28..32]; featureFlags [6..8] stay 0.
    crate::header::write_header_fields(
        &mut buf,
        num_stops,
        num_routes,
        num_trips,
        feed_start_date,
        num_services,
        city_tz_offset_seconds,
    )?;

    // Tagged region table: 24-byte entries; regionId 0 terminates. The 0xFA
    // StopTimeBoarding entry is appended only when present (variable length).
    // Current PTB stores service bitfields through the 0x15/0x16 pool pair.
    let mut entries: Vec<(u16, u64, u64)> = vec![
        (STOPS_SOA, stops_soa_off as u64, stops_soa_b as u64),
        (ROUTES_SOA, routes_soa_off as u64, routes_soa_b as u64),
        (TRIPS_INTERN, trips_off as u64, trips_b as u64),
    ];
    entries.push((
        SERVICE_BITFIELD_POOL,
        svc_pool_off as u64,
        svc_pool_b as u64,
    ));
    entries.push((SERVICE_TO_BITFIELD, s2b_off as u64, s2b_b as u64));
    entries.extend_from_slice(&[
        (STAGING_STOP_TIMES, st_off as u64, st_b as u64),
        (STAGING_TRIP_STARTS, ts_off as u64, ts_b as u64),
        (STAGING_CSR, csr_off as u64, csr_b as u64),
        (STRING_POOL, pool_off as u64, pool_b as u64),
        (TRANSFERS, transfers_off as u64, transfers_b as u64),
    ]);
    if emit_boarding {
        entries.push((
            STAGING_STOP_TIME_BOARDING,
            boarding_off as u64,
            boarding_b as u64,
        ));
    }
    if emit_window_meta {
        entries.push((WINDOW_META, window_meta_off as u64, window_meta_b as u64));
    }
    emit_region_table(&mut buf, &entries);

    // Region bodies.
    buf[stops_soa_off..stops_soa_off + stops_soa_b].copy_from_slice(&stops_soa);
    buf[routes_soa_off..routes_soa_off + routes_soa_b].copy_from_slice(&routes_soa);
    buf[trips_off..trips_off + trips_b].copy_from_slice(trips);
    buf[svc_pool_off..svc_pool_off + svc_pool_b].copy_from_slice(&service_pool_region);
    buf[s2b_off..s2b_off + s2b_b].copy_from_slice(service_to_bitfield);
    buf[st_off..st_off + st_b].copy_from_slice(stop_times);
    buf[ts_off..ts_off + ts_b].copy_from_slice(trip_starts);
    buf[csr_off..csr_off + csr_b].copy_from_slice(csr);
    buf[pool_off..pool_off + pool_b].copy_from_slice(string_pool);
    buf[transfers_off..transfers_off + transfers_b].copy_from_slice(transfers);
    if emit_boarding {
        buf[boarding_off..boarding_off + boarding_b].copy_from_slice(stop_time_boarding);
    }
    if emit_window_meta {
        // windowDays u16 LE @ +0, reserved u16 LE = 0 @ +2 (the +2 stays zero
        // from the zeroed buffer — no Step-B presumption).
        buf[window_meta_off..window_meta_off + 2].copy_from_slice(&window_days.to_le_bytes());
    }

    // The body assembled above is stamped v1 and still carries the temporary
    // timetable regions. `append_pattern_band` needs them because it builds a
    // Reader and derives the band from `Index::build(.., Unbounded)`. The band's seven
    // region bodies are appended LAST (page-aligned so the frozen offsets above
    // are unchanged), with their table entries after the carry entries; `0x12
    // PatternSemantics` is omitted when the band reports it empty
    // (omit-when-all-regular). The temporary regions are then stripped below.
    // The band is the sole source of times, boarding, and trip bounds in a PTB v1
    // bundle and is not optional; the resulting Reader decodes it. Do not
    // reorder/remove `append_pattern_band`, and keep the strip AFTER it.
    buf = append_pattern_band(buf)?;
    buf = pt_core::strip_regions(
        buf,
        &[
            STAGING_STOP_TIMES,
            STAGING_TRIP_STARTS,
            STAGING_CSR,
            STAGING_STOP_TIME_BOARDING,
        ],
    )
    .map_err(|e| crate::error::Error::Config(format!("v1 carry strip: {e:?}")))?;

    // Append frequencies after repacking so the table is stable. The parser
    // already sorted rows by `(tripIdx, startSecs)`.
    // GTFS reference: https://gtfs.org/documentation/schedule/reference/#frequenciestxt
    if !frequencies.is_empty() {
        buf = append_frequencies_region(buf, frequencies);
    }

    Ok(buf)
}

/// Encode and append the `0x17 Frequencies` region to an already-assembled bundle.
///
/// Mirrors `append_pattern_band`'s approach: find the tagged-table terminator
/// (regionId 0), append the body page-aligned at the current buf tail, write the
/// table entry. The region body is:
/// ```text
/// count u32 LE               — number of rows
/// rows[count] × 16 B each:
///   [0..4]   tripIdx     u32 LE
///   [4..8]   startSecs   u32 LE
///   [8..12]  endSecs     u32 LE (half-open, EXCLUDED)
///   [12..14] headwaySecs u16 LE
///   [14]     exactTimes  u8
///   [15]     reserved    u8 = 0
/// ```
/// Rows are already sorted by `(tripIdx, startSecs)` by the parser — the reader
/// binary-searches on `tripIdx` over this layout.
///
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#frequenciestxt
fn append_frequencies_region(mut buf: Vec<u8>, rows: &[crate::pass1::FrequencyRow]) -> Vec<u8> {
    // Build the region body.
    let count = rows.len();
    let mut body = Vec::with_capacity(4 + count * 16);
    body.extend_from_slice(&(count as u32).to_le_bytes()); // count u32 LE
    for r in rows {
        body.extend_from_slice(&r.trip_idx.to_le_bytes());
        body.extend_from_slice(&r.start_secs.to_le_bytes());
        body.extend_from_slice(&r.end_secs.to_le_bytes());
        body.extend_from_slice(&r.headway_secs.to_le_bytes());
        body.push(r.exact_times);
        body.push(0); // reserved
    }

    // Find the first zero regionId (table terminator).
    let mut table_e = 32;
    while u16::from_le_bytes(buf[table_e..table_e + 2].try_into().unwrap()) != 0 {
        table_e += 24;
    }

    // Append body page-aligned at the current tail (buf is already page-aligned).
    let off = buf.len();
    let end = off + body.len();
    let new_total = align(end, PAGE);
    buf.resize(new_total, 0);
    buf[off..end].copy_from_slice(&body);

    // Write the table entry at the terminator slot (the next slot stays zero →
    // regionId 0 still terminates after this entry). Layout mirrors `emit_region_table`:
    // regionId u16 @+0 | entryFlags u16 @+2 | reserved u32 @+4 | offset u64 @+8 | length u64 @+16.
    buf[table_e..table_e + 2].copy_from_slice(&FREQUENCIES.to_le_bytes());
    // entryFlags @+2 and reserved @+4 stay 0: this table slot was the terminator,
    // zero-initialized at `vec![0u8; total]` and never written since (`resize` only
    // zeroes appended tail bytes, not the header table region), so the bytes we
    // don't touch here are already zero.
    buf[table_e + 8..table_e + 16].copy_from_slice(&(off as u64).to_le_bytes());
    buf[table_e + 16..table_e + 24].copy_from_slice(&(body.len() as u64).to_le_bytes());

    buf
}

/// Append the pattern band to an already assembled PTB v1 bundle.
/// `buf` is a v1-stamped body carrying the service pool but NO band yet; this
/// builds a `pt_core::Reader` over it, runs `Index::build(.., Unbounded)`, calls
/// `pt_core::pattern_emit::encode_pattern_band`, and appends the seven band
/// region bodies (page-aligned, frozen offsets unchanged) with their table
/// entries pushed after the existing carry entries. Returns the extended buffer.
///
/// SHARES the band layout with the committed-fixture and testkit writers via
/// `encode_pattern_band` — NO duplicated band layout here. GTFS lasso/repeated
/// -stop reference (the cursor's repeated-stop case):
/// https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
fn append_pattern_band(mut buf: Vec<u8>) -> Result<Vec<u8>> {
    let band = {
        let reader = pt_core::Reader::from_bytes(buf.clone()).map_err(|e| {
            crate::error::Error::Config(format!("v1 band: reader over v1 body failed: {e:?}"))
        })?;
        let index =
            pt_core::Index::build(&reader, pt_core::PatternMode::Unbounded).map_err(|e| {
                crate::error::Error::Config(format!("v1 band: Index::build (Unbounded): {e:?}"))
            })?;
        pt_core::pattern_emit::encode_pattern_band(&reader, &index).map_err(|e| {
            crate::error::Error::Config(format!("v1 band: encode_pattern_band: {e:?}"))
        })?
    };

    // Observability: a trip whose span exceeds the i16 ~9.1h delta cap forces the
    // WHOLE `0x13 TripTimes` region to 4-byte i32 deltas (~2× region size). Warn
    // once per build (the producer is `std`; pt-core is `no_std` and can't log).
    if band.trip_times_i32 {
        eprintln!(
            "[producer] WARN trip_times_i32: 0x13 TripTimes widened to i32 deltas (~2x region size; a trip span exceeds the i16 ~9.1h cap)"
        );
    }

    // Find the table terminator (regionId 0) and the append cursor (buf is
    // page-aligned).
    let mut table_e = 32;
    while u16::from_le_bytes(buf[table_e..table_e + 2].try_into().unwrap()) != 0 {
        table_e += 24;
    }
    let mut cursor = buf.len();

    let mut band_regions: Vec<(u16, &[u8])> = vec![
        (PATTERNS, band.patterns.as_slice()),
        (PATTERN_STOPS, band.pattern_stops.as_slice()),
    ];
    if !band.pattern_semantics.is_empty() {
        band_regions.push((PATTERN_SEMANTICS, band.pattern_semantics.as_slice()));
    }
    band_regions.extend_from_slice(&[
        (TRIP_TIMES, band.trip_times.as_slice()),
        (TRIP_META, band.trip_meta.as_slice()),
        (PATTERNS_AT_STOP, band.patterns_at_stop.as_slice()),
        (PATTERN_TRIPS, band.pattern_trips.as_slice()),
    ]);

    let mut appended: Vec<(u16, usize, usize)> = Vec::with_capacity(band_regions.len());
    for (id, body) in &band_regions {
        let off = cursor;
        let end = off + body.len();
        let new_total = align(end, PAGE);
        buf.resize(new_total, 0);
        buf[off..end].copy_from_slice(body);
        appended.push((*id, off, body.len()));
        cursor = new_total;
    }
    // Push the band table entries after the existing carry entries (the slot
    // after the last write stays zero ⇒ regionId 0 still terminates the table).
    // The `0x13 TripTimes` entry carries `entryFlags` bit1
    // (`TRIP_TIMES_FLAG_I32_DELTAS`) when the band used the wide i32 layout — the
    // REGION-level width signal threaded from `encode_pattern_band`. If this is
    // NOT stamped while the body holds i32 deltas, every reader decodes at the
    // wrong (2-byte) stride ⇒ silent corruption of all departures. Mirrors
    // `gen_fixtures.rs` / `testkit.rs` (the other two band assemblers).
    for (id, off, len) in &appended {
        let entry_flags: u16 = if *id == TRIP_TIMES && band.trip_times_i32 {
            pt_core::reader::TRIP_TIMES_FLAG_I32_DELTAS
        } else {
            0
        };
        buf[table_e..table_e + 2].copy_from_slice(&id.to_le_bytes());
        buf[table_e + 2..table_e + 4].copy_from_slice(&entry_flags.to_le_bytes());
        buf[table_e + 8..table_e + 16].copy_from_slice(&(*off as u64).to_le_bytes());
        buf[table_e + 16..table_e + 24].copy_from_slice(&(*len as u64).to_le_bytes());
        table_e += 24;
    }
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dense_parent_indices_use_unambiguous_sentinel() {
        assert_eq!(dense_parent_idx(3, &[(1, 0)]), vec![u32::MAX, 0, u32::MAX]);
        assert_eq!(dense_parent_idx(2, &[]), vec![u32::MAX, u32::MAX]);
    }

    #[test]
    fn region_table_entries_use_current_wire_shape() {
        let mut header = vec![0u8; HEADER];
        emit_region_table(
            &mut header,
            &[(STOPS_SOA, 4096, 42), (ROUTES_SOA, 8192, 26)],
        );

        assert_eq!(
            u16::from_le_bytes(header[32..34].try_into().unwrap()),
            STOPS_SOA
        );
        assert_eq!(u64::from_le_bytes(header[40..48].try_into().unwrap()), 4096);
        assert_eq!(u64::from_le_bytes(header[48..56].try_into().unwrap()), 42);
        assert_eq!(
            u16::from_le_bytes(header[32 + 2 * 24..32 + 2 * 24 + 2].try_into().unwrap()),
            0
        );
    }

    #[test]
    fn stop_times_transpose_preserves_all_columns() {
        let mut aos = vec![0u8; 24];
        aos[0..4].copy_from_slice(&100u32.to_le_bytes());
        aos[4..6].copy_from_slice(&(-5i16).to_le_bytes());
        aos[6..10].copy_from_slice(&7u32.to_le_bytes());
        aos[10..12].copy_from_slice(&1u16.to_le_bytes());
        aos[12..16].copy_from_slice(&200u32.to_le_bytes());
        aos[16..18].copy_from_slice(&3i16.to_le_bytes());
        aos[18..22].copy_from_slice(&8u32.to_le_bytes());
        aos[22..24].copy_from_slice(&2u16.to_le_bytes());

        let soa = transpose_stop_times_aos_to_soa(&aos);
        assert_eq!(
            &soa[0..8],
            &[100u32.to_le_bytes(), 200u32.to_le_bytes()].concat()
        );
        assert_eq!(
            &soa[8..16],
            &[7u32.to_le_bytes(), 8u32.to_le_bytes()].concat()
        );
        assert_eq!(
            &soa[16..20],
            &[(-5i16).to_le_bytes(), 3i16.to_le_bytes()].concat()
        );
        assert_eq!(
            &soa[20..24],
            &[1u16.to_le_bytes(), 2u16.to_le_bytes()].concat()
        );
    }
}
