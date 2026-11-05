//! Shared test helpers for engine unit tests (Tasks 3–8+).
//!
//! Kept separate from each test module so multiple engine test modules can
//! `use crate::engine::testkit::*;` without copy-pasting the PTB builder.
//!
//! Every builder emits a current PTB v1 bundle through [`build_v1_ptb`], which
//! encodes a logical [`V1Feed`]. The named builders (`build_n_trip_ptb`,
//! `build_multi_route_ptb`, …) are focused wrappers that fix the ids, route,
//! service, and CSR conventions their tests rely on.

use alloc::vec;
use alloc::vec::Vec;

// ---------------------------------------------------------------------------
// tiny.ptb (committed fixture)
// ---------------------------------------------------------------------------

/// Load the committed `tiny.ptb` fixture as a byte vec.
pub fn tiny_bytes() -> Vec<u8> {
    include_bytes!("../../../../packages/shared/src/ptb/__fixtures__/tiny.ptb").to_vec()
}

/// Open a `Reader` directly from the committed `tiny.ptb`.
pub fn tiny_reader() -> crate::Reader<Vec<u8>> {
    crate::Reader::from_bytes(tiny_bytes()).unwrap()
}

// ---------------------------------------------------------------------------
// Tagged region table
// ---------------------------------------------------------------------------

/// Retained carry region ids in the `0xF2+` band (see `header::CARRY_REGIONS`).
pub const TRIPS_INTERN: u16 = 0xF2;
pub const STOP_TIMES: u16 = 0xF4;
pub const TRIP_STARTS: u16 = 0xF5;
pub const CSR: u16 = 0xF6;
pub const STRING_POOL: u16 = 0xF7;
pub const TRANSFERS: u16 = 0xF8;

/// Scan the tagged region table (24 B entries at offset 32, regionId-0
/// terminated) for `region_id`, returning its `(offset, length)`. Panics if
/// absent: a builder or poke helper that cannot find its region is a test bug.
pub fn tagged_region(buf: &[u8], region_id: u16) -> (usize, usize) {
    let mut e = 32;
    loop {
        let id = u16::from_le_bytes(buf[e..e + 2].try_into().unwrap());
        if id == 0 {
            panic!("region 0x{region_id:02X} not found in tagged table");
        }
        if id == region_id {
            let off = u64::from_le_bytes(buf[e + 8..e + 16].try_into().unwrap()) as usize;
            let len = u64::from_le_bytes(buf[e + 16..e + 24].try_into().unwrap()) as usize;
            return (off, len);
        }
        e += 24;
    }
}

fn header_count(buf: &[u8], at: usize) -> usize {
    u32::from_le_bytes(buf[at..at + 4].try_into().unwrap()) as usize
}

// --------------------------------------------------------------------------- Field patchers
// (wheelchair / excluded-mode coverage)
//
// The general builders zero-fill wheelchair columns and hard-code route_type 3.
// Rather than thread optional params through every caller, these post-patch a
// built bundle in place: the `0x40 StopsSoA` wheelchair column (u8, after the
// five 4-byte columns), the `0x41 RoutesSoA` route_type column (u16, after the
// six 4-byte columns), and the `0xF2 TripsIntern` 24 B records (wheelchair u8
// @+16, direction_id u8 @+17, bikes_allowed u8 @+18). They patch the carry
// records only, so use them on bundles without a pattern band.
// ---------------------------------------------------------------------------

/// Set `wheelchair_boarding` for stop ordinal `stop` in-place.
pub fn set_stop_wheelchair(buf: &mut [u8], stop: usize, val: u8) {
    let n = header_count(buf, 8);
    let (off, _) = tagged_region(buf, crate::region_ids::STOPS_SOA);
    buf[off + n * 20 + stop] = val;
}

/// Set `wheelchair_accessible` (Trip @+16) for trip ordinal `trip` in-place.
pub fn set_trip_wheelchair(buf: &mut [u8], trip: usize, val: u8) {
    let (off, _) = tagged_region(buf, TRIPS_INTERN);
    buf[off + trip * 24 + 16] = val;
}

/// Set `bikes_allowed` (Trip @+18) for trip ordinal `trip` in-place.
pub fn set_trip_bikes_allowed(buf: &mut [u8], trip: usize, val: u8) {
    let (off, _) = tagged_region(buf, TRIPS_INTERN);
    buf[off + trip * 24 + 18] = val;
}

/// Set `route_type` (u16 LE) for route ordinal `route` in-place.
pub fn set_route_type(buf: &mut [u8], route: usize, route_type: u16) {
    let m = header_count(buf, 12);
    let (off, _) = tagged_region(buf, crate::region_ids::ROUTES_SOA);
    let o = off + m * 24 + route * 2;
    buf[o..o + 2].copy_from_slice(&route_type.to_le_bytes());
}

/// Overwrite service `svc`'s 90-day (12-byte) bitmask in a built PTB buffer.
/// `bitmask[byte]` bit `(off % 8)` set => active on
/// `feedStartDate + (byte*8 + off%8)`. LSB-first (matches `service_active_bit`).
///
/// This is the default-window (90-day ⇒ `bytes_per_service(90) == 12`) poke. For
/// a non-90 window use [`set_service_bitmask_windowed`].
pub fn set_service_bitmask(buf: &mut [u8], svc: usize, bitmask: &[u8; 12]) {
    set_service_bitmask_windowed(buf, svc, crate::WINDOW_DEFAULT_DAYS, bitmask);
}

/// Window-parameterized [`set_service_bitmask`]: the per-service stride is
/// `bytes_per_service(window_days)`, and `bitmask` MUST be exactly that many
/// bytes. The poke rewrites the `0x15 ServiceBitfieldPool` entry that
/// `0x16 ServiceToBitfield` maps `svc` to, so every service sharing that pool
/// entry changes with it. The builders here give each service its own entry.
pub fn set_service_bitmask_windowed(buf: &mut [u8], svc: usize, window_days: u16, bitmask: &[u8]) {
    let stride = crate::bytes_per_service(window_days);
    assert_eq!(
        bitmask.len(),
        stride,
        "bitmask must be bytes_per_service(window_days)={stride} bytes"
    );
    let (s2b_off, _) = tagged_region(buf, crate::region_ids::SERVICE_TO_BITFIELD);
    let pool_idx = header_count(buf, s2b_off + svc * 4);
    let (pool_off, _) = tagged_region(buf, crate::region_ids::SERVICE_BITFIELD_POOL);
    let o = pool_off + 4 + pool_idx * stride;
    buf[o..o + stride].copy_from_slice(bitmask);
}

// ---------------------------------------------------------------------------
// In-memory PTB builders
// ---------------------------------------------------------------------------

/// Round `n` up to the nearest multiple of `a`.
pub fn align(n: usize, a: usize) -> usize {
    n.div_ceil(a) * a
}

/// Intern `s` into `pool`, returning its index. Index 0 is always the empty
/// string inserted by the caller before the first call.
pub fn intern(s: &str, pool: &mut Vec<alloc::string::String>) -> u32 {
    if let Some(p) = pool.iter().position(|x| x == s) {
        return p as u32;
    }
    pool.push(alloc::string::String::from(s));
    (pool.len() - 1) as u32
}

/// Append a LEB128 varint to `out` (PTFT/PTB use unsigned LEB128).
fn push_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            break;
        }
        out.push(b | 0x80);
    }
}

/// Build a PTFT (pedestrian-transfer) binary buffer in memory for footpath
/// tests. Wire format (see `transfers.rs` / `packages/shared/src/transfers/wire.ts`):
/// magic `PTFT`, version `1`, varint `stop_count`, then per stop
/// `{ id_len, id_bytes, edge_count, (neighbor_idx, walk_secs)* }`.
///
/// `stops` are the transfer-table stop IDs in ordinal order; `edges[i]` is the
/// adjacency for stop `i` as `(neighbor_ordinal, raw_walk_secs)` pairs. Edges
/// are written verbatim (no sorting/validation) — callers control the bytes.
pub fn build_ptft(stops: &[&str], edges: &[&[(u32, u32)]]) -> Vec<u8> {
    assert_eq!(stops.len(), edges.len(), "one edge list per stop");
    let mut b: Vec<u8> = vec![0x50, 0x54, 0x46, 0x54, 0x01]; // "PTFT", v1
    push_varint(&mut b, stops.len() as u64);
    for (i, id) in stops.iter().enumerate() {
        let bytes = id.as_bytes();
        push_varint(&mut b, bytes.len() as u64);
        b.extend_from_slice(bytes);
        let adj = edges[i];
        push_varint(&mut b, adj.len() as u64);
        for &(nbr, walk) in adj {
            push_varint(&mut b, nbr as u64);
            push_varint(&mut b, walk as u64);
        }
    }
    b
}

/// One logical stop. Coords are the f64 SOURCE (quantized to `i32@1e7` via
/// `coord_quant::encode_{lat,lon}_e7` by the writer); `parent` is the dense
/// `parent_idx` (`None` ⇒ the `u32::MAX` sentinel).
#[derive(Clone, Copy)]
pub struct SoaStop<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub lat: f64,
    pub lon: f64,
    pub parent: Option<u32>,
    pub wheelchair: u8,
}

/// One logical route. The string fields intern through the StringPool to
/// `*_idx u32` columns of `0x41 RoutesSoA`.
#[derive(Clone, Copy)]
pub struct SoaRoute<'a> {
    pub id: &'a str,
    pub agency: &'a str,
    pub short: &'a str,
    pub long: &'a str,
    pub color: &'a str,
    pub text_color: &'a str,
    pub route_type: u16,
}

/// Service storage for [`build_v1_ptb`]: the `0x15 ServiceBitfieldPool`
/// (`count u32` + `count` distinct day-vectors of
/// `bytes_per_service(window_days)` bytes each) and the `0x16 ServiceToBitfield`
/// index (`num_services × u32`, each entry an index into the pool).
///
/// Each `pool` entry MUST be exactly `bytes_per_service(window_days)` bytes
/// (`12` at the default 90-day window). `num_services` is `service_to_bitfield.len()`.
pub struct ServicePoolSpec<'a> {
    /// The window length (days). Drives `S = bytes_per_service(window_days)` and,
    /// when `!= 90`, emits a `0x01 WindowMeta` region.
    pub window_days: u16,
    /// Distinct day-vectors. Order is the on-wire pool order;
    /// `service_to_bitfield` indexes into it.
    pub pool: &'a [&'a [u8]],
    /// `service_to_bitfield[s]` = the `pool` index for service `s`. Every entry
    /// MUST be `< pool.len()`.
    pub service_to_bitfield: &'a [u32],
}

/// A single GTFS `transfers.txt` rule in the order the 32 B `0xF8 Transfers`
/// record stores them. Use `u32::MAX` for an absent optional scope /
/// min-transfer-time.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
pub type TransferRow = (u32, u32, u32, u32, u32, u32, u32, u8);

/// One trip for [`build_v1_ptb`]. Start from `V1Trip::default()` and set
/// what the test needs.
#[derive(Clone, Copy, Default)]
pub struct V1Trip<'a> {
    /// GTFS `trip_id` (interned; `""` is pool index 0).
    pub id: &'a str,
    pub headsign: &'a str,
    pub route: u32,
    pub service: u32,
    pub wheelchair: u8,
    pub direction_id: u8,
    /// `(stop_seq, stop_idx, dep_secs)` rows in storage order.
    pub rows: &'a [(u16, u32, u32)],
    /// Per-row `arr_diff` (dwell, `arr = dep + arr_diff`); empty ⇒ all 0.
    pub arr_diffs: &'a [i16],
}

/// How [`build_v1_ptb`] fills the flat stop→routes CSR (`0xF6`).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum StopRoutes<'a> {
    /// Each stop lists the routes whose trips serve it, ascending, deduped. An
    /// unserved stop lists none.
    Served,
    /// Every stop, served or not, lists route 0 only.
    AllRouteZero,
    /// The caller's list per stop (e.g. the producer's canonical-trip-only CSR).
    Given(&'a [Vec<u32>]),
}

/// The logical feed [`build_v1_ptb`] encodes.
pub struct V1Feed<'a> {
    pub stops: &'a [SoaStop<'a>],
    pub routes: &'a [SoaRoute<'a>],
    pub trips: &'a [V1Trip<'a>],
    pub stop_routes: StopRoutes<'a>,
    /// Header `feedStartDate` (`YYYYMMDD`).
    pub feed_start_date: u32,
    /// Header `city_tz_offset_seconds` at `feedStartDate` (0 = UTC).
    pub city_tz_offset_seconds: i32,
    pub services: ServicePoolSpec<'a>,
    pub transfers: &'a [TransferRow],
    /// Packed `0xFA StopTimeBoarding` bytes, one per stop_time in storage
    /// order. Empty ⇒ no `0xFA` region (every stop_time reads `0x50`).
    pub boarding: &'a [u8],
    /// Emit the persisted `0x44 StopIndex`. Without it the reader rebuilds the
    /// id map from the `0x40` `id_idx` column at load.
    pub stop_index: bool,
}

/// One all-active service over the default 90-day window.
pub const ALL_ACTIVE_90: [u8; 12] = [0xFF; 12];
static ALL_ACTIVE_90_POOL: [&[u8]; 1] = [&ALL_ACTIVE_90];

/// The single all-active service most builders use.
pub fn all_active_service() -> ServicePoolSpec<'static> {
    ServicePoolSpec {
        window_days: crate::WINDOW_DEFAULT_DAYS,
        pool: &ALL_ACTIVE_90_POOL,
        service_to_bitfield: &[0],
    }
}

/// Encode `feed` as a current PTB v1 bundle carrying the flat timetable
/// (`0xF4` SoA StopTimes, `0xF5` TripStarts, `0xF6` CSR) and no pattern band —
/// the shape the producer and [`build_pattern_band_ptb_with_boarding`] derive
/// the band from.
///
/// Regions, each page-aligned, in table order: `0x40 StopsSoA`, `0x41
/// RoutesSoA`, optional `0x44 StopIndex`, `0xF2 TripsIntern`, `0x15`/`0x16`
/// service pool, `0xF4`, `0xF5`, `0xF6`, `0xF7 StringPool`, `0xF8 Transfers`,
/// optional `0xFA StopTimeBoarding`, then `0x01 WindowMeta` at its natural
/// 2-byte boundary when the window is not 90 days. Table lengths are tight.
///
/// Coords outside WGS84 panic (a test builder may assert valid input).
pub fn build_v1_ptb(feed: &V1Feed<'_>) -> Vec<u8> {
    use crate::region_ids::{
        ROUTES_SOA, SERVICE_BITFIELD_POOL, SERVICE_TO_BITFIELD, STOPS_SOA, STOP_TIME_BOARDING,
        WINDOW_META,
    };

    let n = feed.stops.len();
    let m = feed.routes.len();
    let num_trips = feed.trips.len();
    let st_rows: usize = feed.trips.iter().map(|t| t.rows.len()).sum();
    let spec = &feed.services;
    let num_services = spec.service_to_bitfield.len();
    let s_bytes = crate::bytes_per_service(spec.window_days);
    assert!(
        feed.boarding.is_empty() || feed.boarding.len() == st_rows,
        "boarding must be empty or one byte per stop_time ({st_rows})"
    );
    assert!(
        spec.pool.iter().all(|bf| bf.len() == s_bytes),
        "each ServiceBitfieldPool entry must be bytes_per_service(window)={s_bytes} bytes"
    );
    assert!(
        spec.service_to_bitfield
            .iter()
            .all(|&i| (i as usize) < spec.pool.len()),
        "every service_to_bitfield index must be < pool.len()={}",
        spec.pool.len()
    );
    for t in feed.trips {
        assert!(
            (t.route as usize) < m,
            "trip {:?} route {} >= {m}",
            t.id,
            t.route
        );
        assert!(
            t.arr_diffs.is_empty() || t.arr_diffs.len() == t.rows.len(),
            "trip {:?}: arr_diffs must be empty or one per row",
            t.id
        );
    }

    // StringPool: index 0 = ""; then stop, route, and trip strings (de-duped).
    let mut pool: Vec<alloc::string::String> = vec![alloc::string::String::new()];
    let stop_id_idx: Vec<u32> = feed.stops.iter().map(|s| intern(s.id, &mut pool)).collect();
    let stop_name_idx: Vec<u32> = feed
        .stops
        .iter()
        .map(|s| intern(s.name, &mut pool))
        .collect();
    let mut route_cols: [Vec<u32>; 6] = Default::default();
    for r in feed.routes {
        for (col, s) in
            route_cols
                .iter_mut()
                .zip([r.id, r.agency, r.short, r.long, r.color, r.text_color])
        {
            col.push(intern(s, &mut pool));
        }
    }
    let trip_id_idx: Vec<u32> = feed.trips.iter().map(|t| intern(t.id, &mut pool)).collect();
    let headsign_idx: Vec<u32> = feed
        .trips
        .iter()
        .map(|t| intern(t.headsign, &mut pool))
        .collect();

    // 0x40 StopsSoA (tight n*21) and 0x41 RoutesSoA (tight m*26).
    let lat_e7: Vec<i32> = feed
        .stops
        .iter()
        .map(|s| {
            crate::coord_quant::encode_lat_e7(s.lat)
                .unwrap_or_else(|| panic!("lat out of WGS84 range: {}", s.lat))
        })
        .collect();
    let lon_e7: Vec<i32> = feed
        .stops
        .iter()
        .map(|s| {
            crate::coord_quant::encode_lon_e7(s.lon)
                .unwrap_or_else(|| panic!("lon out of WGS84 range: {}", s.lon))
        })
        .collect();
    let parent_idx: Vec<u32> = feed
        .stops
        .iter()
        .map(|s| s.parent.unwrap_or(u32::MAX))
        .collect();
    let wheelchair: Vec<u8> = feed.stops.iter().map(|s| s.wheelchair).collect();
    let mut stops_soa = Vec::with_capacity(n * 21);
    crate::soa_emit::encode_stops_soa_columns(
        &mut stops_soa,
        &stop_id_idx,
        &stop_name_idx,
        &lat_e7,
        &lon_e7,
        &parent_idx,
        &wheelchair,
    );
    let route_type: Vec<u16> = feed.routes.iter().map(|r| r.route_type).collect();
    let mut routes_soa = Vec::with_capacity(m * 26);
    crate::soa_emit::encode_routes_soa_columns(
        &mut routes_soa,
        &route_cols[0],
        &route_cols[1],
        &route_cols[2],
        &route_cols[3],
        &route_cols[4],
        &route_cols[5],
        &route_type,
    );

    // 0x44 StopIndex over (id pool idx, ordinal), resolved through the pool.
    let stop_index = if feed.stop_index {
        let resolve = |idx: u32| pool.get(idx as usize).map(|s| s.as_str());
        let seq: Vec<(u32, u32)> = stop_id_idx
            .iter()
            .enumerate()
            .map(|(i, &idx)| (idx, i as u32))
            .collect();
        crate::stop_index::build(&seq, resolve)
    } else {
        Vec::new()
    };

    // 0xF2 TripsIntern: 24 B records (trip_id @+0, headsign @+4, route_idx @+8,
    // service_idx @+12, wheelchair @+16, direction_id @+17).
    let mut trips_body = vec![0u8; num_trips * 24];
    for (t, trip) in feed.trips.iter().enumerate() {
        let o = t * 24;
        trips_body[o..o + 4].copy_from_slice(&trip_id_idx[t].to_le_bytes());
        trips_body[o + 4..o + 8].copy_from_slice(&headsign_idx[t].to_le_bytes());
        trips_body[o + 8..o + 12].copy_from_slice(&trip.route.to_le_bytes());
        trips_body[o + 12..o + 16].copy_from_slice(&trip.service.to_le_bytes());
        trips_body[o + 16] = trip.wheelchair;
        trips_body[o + 17] = trip.direction_id;
    }

    // 0x15 ServiceBitfieldPool (`count u32` + bitfields) and 0x16
    // ServiceToBitfield (`num_services × u32`).
    let mut pool_regions = (Vec::new(), Vec::new());
    pool_regions
        .0
        .extend_from_slice(&(spec.pool.len() as u32).to_le_bytes());
    for bf in spec.pool {
        pool_regions.0.extend_from_slice(bf);
    }
    for &idx in spec.service_to_bitfield {
        pool_regions.1.extend_from_slice(&idx.to_le_bytes());
    }

    // 0xF4 StopTimes, SoA columns (tight 12*N): dep_secs u32@4i |
    // stop_idx u32@4N+4i | arr_diff i16@8N+2i | stop_seq u16@10N+2i.
    let mut st_body = vec![0u8; st_rows * 12];
    let mut row = 0usize;
    for trip in feed.trips {
        for (k, &(seq, sidx, dep)) in trip.rows.iter().enumerate() {
            st_body[4 * row..4 * row + 4].copy_from_slice(&dep.to_le_bytes());
            let o = 4 * st_rows + 4 * row;
            st_body[o..o + 4].copy_from_slice(&sidx.to_le_bytes());
            let arr_diff = trip.arr_diffs.get(k).copied().unwrap_or(0);
            let o = 8 * st_rows + 2 * row;
            st_body[o..o + 2].copy_from_slice(&arr_diff.to_le_bytes());
            let o = 10 * st_rows + 2 * row;
            st_body[o..o + 2].copy_from_slice(&seq.to_le_bytes());
            row += 1;
        }
    }

    // 0xF5 TripStarts: prefix sum of per-trip row counts.
    let mut ts_body = Vec::with_capacity((num_trips + 1) * 4);
    let mut acc = 0u32;
    ts_body.extend_from_slice(&acc.to_le_bytes());
    for trip in feed.trips {
        acc += trip.rows.len() as u32;
        ts_body.extend_from_slice(&acc.to_le_bytes());
    }

    // 0xF6 CSR: route→trips (offsets m+1, trips grouped by route in storage
    // order), then stop→routes (offsets n+1, values).
    let mut rt_off = vec![0u32; m + 1];
    for trip in feed.trips {
        rt_off[trip.route as usize + 1] += 1;
    }
    for r in 0..m {
        rt_off[r + 1] += rt_off[r];
    }
    let mut rt_val: Vec<u32> = Vec::with_capacity(num_trips);
    for r in 0..m as u32 {
        rt_val.extend((0..num_trips as u32).filter(|&t| feed.trips[t as usize].route == r));
    }
    let mut routes_per_stop: Vec<Vec<u32>> = vec![Vec::new(); n];
    match feed.stop_routes {
        StopRoutes::AllRouteZero => {
            for v in routes_per_stop.iter_mut() {
                v.push(0);
            }
        }
        StopRoutes::Served => {
            for trip in feed.trips {
                for &(_, sidx, _) in trip.rows {
                    let v = &mut routes_per_stop[sidx as usize];
                    if !v.contains(&trip.route) {
                        v.push(trip.route);
                    }
                }
            }
            for v in routes_per_stop.iter_mut() {
                v.sort_unstable();
            }
        }
        StopRoutes::Given(lists) => {
            assert_eq!(lists.len(), n, "one stop_routes list per stop");
            routes_per_stop = lists.to_vec();
        }
    }
    let mut sr_off = vec![0u32; n + 1];
    let mut sr_val: Vec<u32> = Vec::new();
    for (s, routes) in routes_per_stop.iter().enumerate() {
        sr_val.extend_from_slice(routes);
        sr_off[s + 1] = sr_val.len() as u32;
    }
    let mut csr_body = Vec::new();
    for v in rt_off.iter().chain(&rt_val).chain(&sr_off).chain(&sr_val) {
        csr_body.extend_from_slice(&v.to_le_bytes());
    }

    // 0xF7 StringPool: `count u32` | offsets[count+1] u32 | UTF-8 blob.
    let mut pool_body = Vec::new();
    pool_body.extend_from_slice(&(pool.len() as u32).to_le_bytes());
    let mut cur = 0u32;
    for s in &pool {
        pool_body.extend_from_slice(&cur.to_le_bytes());
        cur += s.len() as u32;
    }
    pool_body.extend_from_slice(&cur.to_le_bytes());
    for s in &pool {
        pool_body.extend_from_slice(s.as_bytes());
    }

    // 0xF8 Transfers: one 32 B record per rule.
    let mut transfers_body = Vec::with_capacity(feed.transfers.len() * 32);
    for &(fs, ts, fr, tr, ft, tt, mins, ty) in feed.transfers {
        for v in [fs, ts, fr, tr, ft, tt, mins] {
            transfers_body.extend_from_slice(&v.to_le_bytes());
        }
        transfers_body.extend_from_slice(&[ty, 0, 0, 0]);
    }

    // Lay out the regions page-aligned after the 4096 B header.
    let mut regions: Vec<(u16, &[u8])> = vec![
        (STOPS_SOA, stops_soa.as_slice()),
        (ROUTES_SOA, routes_soa.as_slice()),
    ];
    if feed.stop_index {
        regions.push((crate::stop_index::REGION_ID, stop_index.as_slice()));
    }
    regions.extend_from_slice(&[
        (TRIPS_INTERN, trips_body.as_slice()),
        (SERVICE_BITFIELD_POOL, pool_regions.0.as_slice()),
        (SERVICE_TO_BITFIELD, pool_regions.1.as_slice()),
        (STOP_TIMES, st_body.as_slice()),
        (TRIP_STARTS, ts_body.as_slice()),
        (CSR, csr_body.as_slice()),
        (STRING_POOL, pool_body.as_slice()),
        (TRANSFERS, transfers_body.as_slice()),
    ]);
    if !feed.boarding.is_empty() {
        regions.push((STOP_TIME_BOARDING, feed.boarding));
    }
    let mut placed: Vec<(u16, usize, usize)> = Vec::with_capacity(regions.len() + 1);
    let mut cursor = PAGE;
    for (id, body) in &regions {
        placed.push((*id, cursor, body.len()));
        cursor = align(cursor + body.len(), PAGE);
    }
    // 0x01 WindowMeta (windowDays u16 LE + reserved u16) only for a non-90
    // window, at its natural 2-byte boundary (M10).
    let window_meta = feed.services.window_days != crate::WINDOW_DEFAULT_DAYS;
    if window_meta {
        let off = align(cursor, 2);
        placed.push((WINDOW_META, off, 4));
        cursor = off + 4;
    }
    let mut buf = vec![0u8; align(cursor, PAGE)];

    buf[0..4].copy_from_slice(&crate::PTB_MAGIC);
    buf[4..6].copy_from_slice(&crate::PTB_VERSION_V1.to_le_bytes());
    buf[8..12].copy_from_slice(&(n as u32).to_le_bytes());
    buf[12..16].copy_from_slice(&(m as u32).to_le_bytes());
    buf[16..20].copy_from_slice(&(num_trips as u32).to_le_bytes());
    buf[20..24].copy_from_slice(&feed.feed_start_date.to_le_bytes());
    buf[24..28].copy_from_slice(&(num_services as u32).to_le_bytes());
    buf[28..32].copy_from_slice(&feed.city_tz_offset_seconds.to_le_bytes());
    for (i, &(id, off, len)) in placed.iter().enumerate() {
        let e = 32 + i * 24;
        buf[e..e + 2].copy_from_slice(&id.to_le_bytes());
        buf[e + 8..e + 16].copy_from_slice(&(off as u64).to_le_bytes());
        buf[e + 16..e + 24].copy_from_slice(&(len as u64).to_le_bytes());
    }
    for (&(_, off, len), (_, body)) in placed.iter().zip(&regions) {
        buf[off..off + len].copy_from_slice(body);
    }
    if window_meta {
        let (_, off, _) = placed[placed.len() - 1];
        buf[off..off + 2].copy_from_slice(&feed.services.window_days.to_le_bytes());
    }
    buf
}

const PAGE: usize = 4096;

/// Append `body` as a new tagged region `region_id`, page-aligned after the
/// current end of `buf`, with its table entry written into the terminator slot
/// (the next slot stays zero, so the table stays terminated).
pub fn append_region(mut buf: Vec<u8>, region_id: u16, body: &[u8]) -> Vec<u8> {
    let off = align(buf.len(), PAGE);
    buf.resize(align(off + body.len(), PAGE), 0);
    buf[off..off + body.len()].copy_from_slice(body);
    let mut e = 32;
    while u16::from_le_bytes(buf[e..e + 2].try_into().unwrap()) != 0 {
        e += 24;
    }
    buf[e..e + 2].copy_from_slice(&region_id.to_le_bytes());
    buf[e + 8..e + 16].copy_from_slice(&(off as u64).to_le_bytes());
    buf[e + 16..e + 24].copy_from_slice(&(body.len() as u64).to_le_bytes());
    buf
}

/// Stops `ids[i]` with empty names, zero coords, no parent.
pub fn bare_stops<'a>(ids: &[&'a str]) -> Vec<SoaStop<'a>> {
    ids.iter()
        .map(|&id| SoaStop {
            id,
            name: "",
            lat: 0.0,
            lon: 0.0,
            parent: None,
            wheelchair: 0,
        })
        .collect()
}

/// A BUS route with only its id set.
pub fn bare_route(id: &str) -> SoaRoute<'_> {
    SoaRoute {
        id,
        agency: "",
        short: "",
        long: "",
        color: "",
        text_color: "",
        route_type: 3,
    }
}

/// `s0..s{n-1}` (or `R0..`, `T0..`) as owned strings.
pub fn numbered_ids(prefix: &str, n: usize) -> Vec<alloc::string::String> {
    (0..n).map(|i| alloc::format!("{prefix}{i}")).collect()
}

pub fn as_strs(ids: &[alloc::string::String]) -> Vec<&str> {
    ids.iter().map(|s| s.as_str()).collect()
}

/// Build a minimal 1-route, 2-trip PTB in memory.
///
/// `pattern` — `(stop_seq, stop_idx, dep_secs)` rows for trip 0 (the
/// canonical / longest trip).  `other` — same tuple slice for trip 1.
pub fn build_two_trip_ptb(
    num_stops: u32,
    pattern: &[(u16, u32, u32)], // (stop_seq, stop_idx, dep_secs) for trip 0
    other: &[(u16, u32, u32)],   // for trip 1
) -> Vec<u8> {
    build_n_trip_ptb(num_stops, &[pattern, other])
}

/// Build a minimal 1-route, N-trip PTB in memory (express-skip needs ≥3 trips to exercise the
/// non-greedy `break`; `build_two_trip_ptb` delegates here with N=2). Stops `s0..`, route `R`
/// (BUS), all trips on route 0, service 0 (all-active over 90 days from 20260501). `trips[i]` is
/// `(stop_seq, stop_idx, dep_secs)` rows for trip `i` in storage order.
pub fn build_n_trip_ptb(num_stops: u32, trips: &[&[(u16, u32, u32)]]) -> Vec<u8> {
    let ids = numbered_ids("s", num_stops as usize);
    build_n_trip_ptb_with_ids(&as_strs(&ids), trips)
}

/// Like [`build_n_trip_ptb`] but with caller-supplied `stop_ids` (one per stop,
/// in ordinal order). Lets StopIndex tests inject duplicate ids (last-wins) and
/// fnv32-colliding id pairs the `s{i}` generator can't produce. Every stop's
/// stop→routes entry is `[0]`, served or not; no persisted StopIndex.
pub fn build_n_trip_ptb_with_ids(stop_ids: &[&str], trips: &[&[(u16, u32, u32)]]) -> Vec<u8> {
    assert!(!trips.is_empty(), "need at least one trip");
    let stops = bare_stops(stop_ids);
    let v1_trips: Vec<V1Trip<'_>> = trips
        .iter()
        .map(|rows| V1Trip {
            rows,
            ..V1Trip::default()
        })
        .collect();
    build_v1_ptb(&V1Feed {
        stops: &stops,
        routes: &[bare_route("R")],
        trips: &v1_trips,
        stop_routes: StopRoutes::AllRouteZero,
        feed_start_date: 20260501,
        city_tz_offset_seconds: 0,
        services: all_active_service(),
        transfers: &[],
        boarding: &[],
        stop_index: false,
    })
}

/// Build a SoA-field PTB: caller-supplied stops and routes (names, coords,
/// parents, wheelchair, all seven route fields), every trip on route 0 /
/// service 0 (all-active over 90 days from 20260601), every stop's
/// stop→routes entry `[0]`, and a persisted `0x44 StopIndex`.
pub fn build_soa_ptb(
    stops: &[SoaStop<'_>],
    routes: &[SoaRoute<'_>],
    trips: &[&[(u16, u32, u32)]],
) -> Vec<u8> {
    build_soa_ptb_inner(stops, routes, trips, true, &[], all_active_service())
}

/// Like [`build_soa_ptb`] but OMITS the `0x44` persisted StopIndex region, so
/// `Reader::from_bytes` takes the eager id-rebuild path over the `StopsSoA`
/// `id_idx` column. Used for persisted-vs-eager StopIndex parity.
pub fn build_soa_ptb_without_stop_index(
    stops: &[SoaStop<'_>],
    routes: &[SoaRoute<'_>],
    trips: &[&[(u16, u32, u32)]],
) -> Vec<u8> {
    build_soa_ptb_inner(stops, routes, trips, false, &[], all_active_service())
}

/// Like [`build_soa_ptb`] but with an explicit `window_days`: one all-active
/// service of `bytes_per_service(window_days)` bytes and, when
/// `window_days != 90`, a `0x01 WindowMeta` region.
pub fn build_soa_ptb_windowed(
    stops: &[SoaStop<'_>],
    routes: &[SoaRoute<'_>],
    trips: &[&[(u16, u32, u32)]],
    window_days: u16,
) -> Vec<u8> {
    let all_active = vec![0xFFu8; crate::bytes_per_service(window_days)];
    let pool: [&[u8]; 1] = [&all_active];
    let services = ServicePoolSpec {
        window_days,
        pool: &pool,
        service_to_bitfield: &[0],
    };
    build_soa_ptb_inner(stops, routes, trips, true, &[], services)
}

/// Like [`build_soa_ptb`] but with caller-supplied service storage: `trips`
/// still ride service 0, while `service_bitmask(s)` resolves any
/// `s < num_services` through the `0x16 → 0x15` indirection.
pub fn build_service_pool_ptb(
    stops: &[SoaStop<'_>],
    routes: &[SoaRoute<'_>],
    trips: &[&[(u16, u32, u32)]],
    spec: &ServicePoolSpec<'_>,
) -> Vec<u8> {
    let services = ServicePoolSpec {
        window_days: spec.window_days,
        pool: spec.pool,
        service_to_bitfield: spec.service_to_bitfield,
    };
    build_soa_ptb_inner(stops, routes, trips, true, &[], services)
}

fn build_soa_ptb_inner(
    stops: &[SoaStop<'_>],
    routes: &[SoaRoute<'_>],
    trips: &[&[(u16, u32, u32)]],
    stop_index: bool,
    boarding: &[u8],
    services: ServicePoolSpec<'_>,
) -> Vec<u8> {
    assert!(!trips.is_empty(), "need at least one trip");
    assert!(!routes.is_empty(), "need at least one route");
    let v1_trips: Vec<V1Trip<'_>> = trips
        .iter()
        .map(|rows| V1Trip {
            rows,
            ..V1Trip::default()
        })
        .collect();
    build_v1_ptb(&V1Feed {
        stops,
        routes,
        trips: &v1_trips,
        stop_routes: StopRoutes::AllRouteZero,
        feed_start_date: 20260601,
        city_tz_offset_seconds: 0,
        services,
        transfers: &[],
        boarding,
        stop_index,
    })
}

/// Build a multi-route PTB in memory: each route owns ONE trip with its own stop pattern.
///
/// Stops `s0..s{num_stops-1}`, routes `R0..` (BUS), trip `r` on route `r`,
/// service 0 (all-active over 90 days from 20260501). `routes[r]` is the
/// `(stop_seq, stop_idx, dep_secs)` rows for route `r`'s single trip. A stop
/// served by several routes lists them in route order in the stop→routes CSR.
pub fn build_multi_route_ptb(num_stops: u32, routes: &[&[(u16, u32, u32)]]) -> Vec<u8> {
    build_multi_route_inner(num_stops, routes, false, &[])
}

/// Multi-route PTB (as [`build_multi_route_ptb`]) that ALSO carries trip ids
/// `T0..` and a populated GTFS `transfers.txt` region. Used by the scan unit
/// tests that exercise the S1/S2/S3 transfer rules (type-3 skip / type-2 floor
/// / same-stop forbid / trip- and route-scoped rules); trip-scoped rules key on
/// the trip id strings.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
pub fn build_multi_route_ptb_with_transfers(
    num_stops: u32,
    routes: &[&[(u16, u32, u32)]],
    transfers: &[TransferRow],
) -> Vec<u8> {
    build_multi_route_inner(num_stops, routes, true, transfers)
}

fn build_multi_route_inner(
    num_stops: u32,
    routes: &[&[(u16, u32, u32)]],
    trip_ids: bool,
    transfers: &[TransferRow],
) -> Vec<u8> {
    assert!(!routes.is_empty(), "need at least one route");
    let stop_ids = numbered_ids("s", num_stops as usize);
    let stops = bare_stops(&as_strs(&stop_ids));
    let route_ids = numbered_ids("R", routes.len());
    let soa_routes: Vec<SoaRoute<'_>> = route_ids.iter().map(|id| bare_route(id)).collect();
    let trip_id_strs = numbered_ids("T", routes.len());
    let trips: Vec<V1Trip<'_>> = routes
        .iter()
        .enumerate()
        .map(|(r, rows)| V1Trip {
            id: if trip_ids {
                trip_id_strs[r].as_str()
            } else {
                ""
            },
            route: r as u32,
            rows,
            ..V1Trip::default()
        })
        .collect();
    build_v1_ptb(&V1Feed {
        stops: &stops,
        routes: &soa_routes,
        trips: &trips,
        stop_routes: StopRoutes::Served,
        feed_start_date: 20260501,
        city_tz_offset_seconds: 0,
        services: all_active_service(),
        transfers,
        boarding: &[],
        stop_index: false,
    })
}

/// Build a minimal 1-route, 1-trip PTB (2 stops s0/s1, trip s0@100 → s1@200)
/// carrying a populated `0xF8 Transfers` region — the round-trip exercise for
/// `reader.transfer(i)`.
pub fn build_transfers_ptb(rows: &[TransferRow]) -> Vec<u8> {
    let stops = bare_stops(&["s0", "s1"]);
    build_v1_ptb(&V1Feed {
        stops: &stops,
        routes: &[bare_route("R")],
        trips: &[V1Trip {
            rows: &[(1, 0, 100), (2, 1, 200)],
            ..V1Trip::default()
        }],
        stop_routes: StopRoutes::AllRouteZero,
        feed_start_date: 20260501,
        city_tz_offset_seconds: 0,
        services: all_active_service(),
        transfers: rows,
        boarding: &[],
        stop_index: false,
    })
}

/// Build a multi-route, multi-trip-per-route PTB in memory. `routes[r]` is a
/// slice of trip row-lists `(stop_seq, stop_idx, dep_secs)` for route `r`; each
/// entry in that slice is one trip's rows. Stop ids are `s0..`, route ids
/// `R0..`, trip ids `T0..T{total_trips-1}` in route-major order (all trips of R0
/// first, then R1, …). Single all-active service, no GTFS Transfers.
///
/// This is the only builder that supports BOTH multi-route AND
/// multi-trip-per-route simultaneously. Every StopTime has `arr_diff = 0`.
#[allow(clippy::type_complexity)] // nested-slice fixture-spec type (routes→trips→rows)
pub fn build_routes_multi_trip_ptb(num_stops: u32, routes: &[&[&[(u16, u32, u32)]]]) -> Vec<u8> {
    assert!(!routes.is_empty(), "need at least one route");
    let num_trips: usize = routes.iter().map(|r| r.len()).sum();
    assert!(num_trips >= 1, "need at least one trip");
    let stop_ids = numbered_ids("s", num_stops as usize);
    let stops = bare_stops(&as_strs(&stop_ids));
    let route_ids = numbered_ids("R", routes.len());
    let soa_routes: Vec<SoaRoute<'_>> = route_ids.iter().map(|id| bare_route(id)).collect();
    let trip_ids = numbered_ids("T", num_trips);
    let mut trips: Vec<V1Trip<'_>> = Vec::with_capacity(num_trips);
    for (r, route_trips) in routes.iter().enumerate() {
        for rows in route_trips.iter() {
            let t = trips.len();
            trips.push(V1Trip {
                id: trip_ids[t].as_str(),
                route: r as u32,
                rows,
                ..V1Trip::default()
            });
        }
    }
    build_v1_ptb(&V1Feed {
        stops: &stops,
        routes: &soa_routes,
        trips: &trips,
        stop_routes: StopRoutes::Served,
        feed_start_date: 20260501,
        city_tz_offset_seconds: 0,
        services: all_active_service(),
        transfers: &[],
        boarding: &[],
        stop_index: false,
    })
}

/// Build a single-route (`R`, BUS) PTB whose stop_times carry an additive
/// `0xFA StopTimeBoarding` column. `boarding` is one packed byte per stop_time
/// in storage order; EMPTY ⇒ no `0xFA` region (every stop_time reads `0x50`).
pub fn build_n_trip_ptb_with_boarding(
    stop_ids: &[&str],
    trips: &[&[(u16, u32, u32)]],
    boarding: &[u8],
) -> Vec<u8> {
    let stops = bare_stops(stop_ids);
    build_soa_ptb_inner(
        &stops,
        &[bare_route("R")],
        trips,
        true,
        boarding,
        all_active_service(),
    )
}

/// Build a **v1** pattern-band PTB in memory — the testkit mirror of
/// `gen_fixtures.rs::build_pattern_band_ptb` (B1.1 Task B). Single route 0, N
/// trips (`trips[i]` = `(stop_seq, stop_idx, dep_secs)` rows in storage order),
/// service 0; emits the flat carry via [`build_soa_ptb`]'s layout PLUS the
/// additive pattern band (`0x10`-`0x14`/`0x45`/`0x46`).
///
/// It delegates the band bytes to [`crate::pattern_emit::encode_pattern_band`] —
/// NO duplicated band layout here. After the carry is assembled it pokes each
/// `sentinel_rows` row's `dep_secs` (the SoA dep column at
/// `StopTimes_off + 4*row`) to `DEP_SECS_NOT_SERVED` (the express-skip `-1`-hole
/// trap), builds a `Reader` + `Index::build(.., Unbounded)` over the poked
/// carry, calls `encode_pattern_band`, then appends the band region bodies LAST
/// (page-aligned, so the carry offsets are unchanged) and pushes their table
/// entries after the carry entries.
///
/// `0x12 PatternSemantics` is omitted (no body, no table entry) when the band
/// reports it empty (omit-when-all-regular).
///
/// NOTE: unlike the committed fixtures (carry-LESS), this testkit builder
/// INTENTIONALLY keeps the flat carry (`0xF4`/`0xF5`/`0xF6`) — the band-vs-flat
/// equivalence oracles in `index.rs`/`pattern_emit.rs` compare the band against
/// this carry, so it must stay present here.
///
/// GTFS lasso/repeated-stop reference (the cursor's repeated-stop case):
/// https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
pub fn build_pattern_band_ptb(
    stops: &[SoaStop<'_>],
    routes: &[SoaRoute<'_>],
    trips: &[&[(u16, u32, u32)]],
    sentinel_rows: &[usize],
) -> Vec<u8> {
    build_pattern_band_ptb_with_boarding(stops, routes, trips, sentinel_rows, &[], &[])
}

/// Mirror of gen_fixtures::mixed_boarding: restrictions differ between three
/// trips sharing a stop sequence. The pattern band must keep all three.
/// GTFS: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
pub fn build_mixed_boarding_pattern_ptb() -> Vec<u8> {
    build_pattern_band_ptb_with_boarding(
        &bare_stops(&["s0", "s1", "s2"]),
        &[bare_route("R")],
        &[
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
            &[(1, 0, 28800), (2, 1, 29100), (3, 2, 29400)],
            &[(1, 0, 32400), (2, 1, 32700), (3, 2, 33000)],
        ],
        &[],
        &[0x50, 0x51, 0x50, 0x50, 0x50, 0x50, 0x50, 0x54, 0x50],
        &[],
    )
}

/// Like [`build_pattern_band_ptb`] but pokes a NONZERO `arr_diff` (dwell) into
/// the SoA `StopTimes` carry BEFORE the band is derived, so the band's `0x13`
/// dwell sub-array carries the value (`encode_pattern_band` reads `arr_diff` from
/// the carry at encode time). `dwell_rows` is `(flat_row, arr_diff)` pairs
/// (`arr_diff <= 0` per GTFS dwell convention -- `arr = dep + arr_diff`). Used by
/// the i32-delta test to assert a NONZERO wide-stride dwell decode
/// (`band_arr_secs`): without it the dwell sub-array is all-zero and an i16
/// mis-stride of the dwell column reads four zero bytes and stays uncaught.
/// `dwell_rows` empty => identical to [`build_pattern_band_ptb`].
pub fn build_pattern_band_ptb_with_dwell(
    stops: &[SoaStop<'_>],
    routes: &[SoaRoute<'_>],
    trips: &[&[(u16, u32, u32)]],
    sentinel_rows: &[usize],
    dwell_rows: &[(usize, i16)],
) -> Vec<u8> {
    build_pattern_band_ptb_with_boarding(stops, routes, trips, sentinel_rows, &[], dwell_rows)
}

/// Like [`build_pattern_band_ptb`] but injects a `0xFA StopTimeBoarding` carry
/// column (one packed byte per stop_time row, flat row order — same layout as
/// [`build_n_trip_ptb_with_boarding`]) and optional dwell pokes. The band's
/// `0x12 PatternSemantics` folds the boarding low-nibble in at encode time, so a
/// non-default boarding byte makes the band carry a non-omitted `0x12` region.
/// Used by the B1.5 band-vs-flat equivalence test to exercise the `0x12`
/// non-regular decode path (`band_pickup_forbidden` / `band_drop_off_forbidden`).
/// `boarding` empty ⇒ all-regular.
pub fn build_pattern_band_ptb_with_boarding(
    stops: &[SoaStop<'_>],
    routes: &[SoaRoute<'_>],
    trips: &[&[(u16, u32, u32)]],
    sentinel_rows: &[usize],
    boarding: &[u8],
    dwell_rows: &[(usize, i16)],
) -> Vec<u8> {
    use crate::engine::consts::DEP_SECS_NOT_SERVED;
    use crate::region_ids::{
        PATTERNS, PATTERNS_AT_STOP, PATTERN_SEMANTICS, PATTERN_STOPS, PATTERN_TRIPS, TRIP_META,
        TRIP_TIMES,
    };

    let st_rows: usize = trips.iter().map(|t| t.len()).sum();
    for &row in sentinel_rows {
        assert!(
            row < st_rows,
            "sentinel row {row} >= num stop_time rows {st_rows}"
        );
    }
    for &(row, _) in dwell_rows {
        assert!(
            row < st_rows,
            "dwell row {row} >= num stop_time rows {st_rows}"
        );
    }

    // 1. Assemble the flat carry, then poke express-skip sentinels into the SoA
    //    dep column (StopTimes_off + 4*row) and dwell into the arr_diff column
    //    (StopTimes_off + 8N + 2*row) BEFORE the band derive reads them.
    let mut buf = build_soa_ptb_inner(stops, routes, trips, true, boarding, all_active_service());
    let (st_off, _st_len) = tagged_region(&buf, STOP_TIMES);
    for &row in sentinel_rows {
        let o = st_off + 4 * row;
        buf[o..o + 4].copy_from_slice(&DEP_SECS_NOT_SERVED.to_le_bytes());
    }
    for &(row, arr_diff) in dwell_rows {
        let o = st_off + 8 * st_rows + 2 * row;
        buf[o..o + 2].copy_from_slice(&arr_diff.to_le_bytes());
    }

    // 2. Build the index over the poked carry and encode the band (shared layout).
    let band = {
        let reader = crate::Reader::from_bytes(buf.clone()).expect("flat carry decode");
        let index = crate::engine::index::Index::build(
            &reader,
            crate::engine::patterns::PatternMode::Unbounded,
        )
        .unwrap();
        crate::pattern_emit::encode_pattern_band(&reader, &index).expect("encode_pattern_band")
    };

    // 3. Find the current table end (regionId-0 terminator) and the current body
    //    cursor (the buffer length is page-aligned, so append from there).
    let mut table_e = 32;
    while u16::from_le_bytes(buf[table_e..table_e + 2].try_into().unwrap()) != 0 {
        table_e += 24;
    }
    let mut cursor = buf.len();

    // Band bodies in their canonical region order; 0x12 omitted when empty.
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

    // 4. Append each band body page-aligned; record (id, off, len) for the table.
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

    // 5. Push the band table entries after the carry entries (regionId-0 still
    //    terminates because resize zero-fills the slot after the last write). The
    //    `0x13 TripTimes` entry carries `entryFlags` bit1
    //    (`TRIP_TIMES_FLAG_I32_DELTAS`) when the band used the wide i32 layout —
    //    the REGION-level width signal threaded from `encode_pattern_band`.
    for (id, off, len) in &appended {
        let entry_flags: u16 = if *id == TRIP_TIMES && band.trip_times_i32 {
            crate::reader::TRIP_TIMES_FLAG_I32_DELTAS
        } else {
            0
        };
        buf[table_e..table_e + 2].copy_from_slice(&id.to_le_bytes());
        buf[table_e + 2..table_e + 4].copy_from_slice(&entry_flags.to_le_bytes());
        buf[table_e + 8..table_e + 16].copy_from_slice(&(*off as u64).to_le_bytes());
        buf[table_e + 16..table_e + 24].copy_from_slice(&(*len as u64).to_le_bytes());
        table_e += 24;
    }
    buf
}

/// One `frequencies.txt` row for [`build_v2_ptb`]:
/// `(trip_idx, start_secs, end_secs, headway_secs, exact_times)`.
pub type FrequencyRow = (u32, u32, u32, u16, u8);

/// The logical PTB v2 feed [`build_v2_ptb`] encodes: a [`V1Feed`] whose
/// `transfers` follow the v2 row contract (type 4/5 rows may omit stops with
/// `u32::MAX`), plus the v2-only inputs.
pub struct V2Feed<'a> {
    pub base: V1Feed<'a>,
    /// `0x18 ServiceDayOrigins`: `window_days + 1` strictly increasing Unix
    /// instants (local noon minus 12 h per service date).
    pub origins: &'a [i64],
    /// Raw GTFS `block_id` per trip (`None` or `""` = absent).
    pub blocks: &'a [Option<&'a str>],
    /// Component-feed rank scoping the block keys.
    pub feed_rank: u32,
    pub derive_block_inseat: bool,
    pub frequencies: &'a [FrequencyRow],
    /// Trips written as quarantined frequency trips: one canonical marker row
    /// each, carrying `v2::FREQUENCY_FLAG_QUARANTINED`.
    pub quarantined_frequency_trips: &'a [u32],
    /// Strip the flat `0xF4`/`0xF5`/`0xF6` carry like a published bundle.
    pub strip_carry: bool,
}

/// UTC-midnight origins (`86_400`-second days) for `days + 1` entries from
/// `feed_start_date`, shifted by `offset_secs`. Real feeds use the producer's
/// zone-resolved noon-minus-12h instants; tests that need DST pass their own.
pub fn utc_origins(feed_start_date: u32, days: usize, offset_secs: i64) -> Vec<i64> {
    let d0 = crate::reader::days_from_civil(feed_start_date);
    (0..=days as i64)
        .map(|i| (d0 + i) * 86_400 + offset_secs)
        .collect()
}

/// Encode a PTB v2 bundle the way the producer does: build the v1-layout
/// staging bytes, derive the pattern band through the shared encoder, intern
/// the source-scoped block keys into the StringPool and `TripMeta.block_idx`,
/// then re-pack with version 2, the `DERIVE_BLOCK_INSEAT` bit, `0x18`, the
/// recomputed `0x19` and a `0x1A` placeholder commitment.
pub fn build_v2_ptb(feed: &V2Feed<'_>) -> Vec<u8> {
    use crate::region_ids::{
        BLOCK_DERIVATION_COMMITMENT, COMPATIBILITY_ARTIFACT_COMMITMENT, FREQUENCIES, PATTERNS,
        PATTERNS_AT_STOP, PATTERN_SEMANTICS, PATTERN_STOPS, PATTERN_TRIPS, SERVICE_DAY_ORIGINS,
        TRIP_META, TRIP_TIMES,
    };
    use crate::RegionEdit;
    assert_eq!(
        feed.origins.len(),
        feed.base.services.window_days as usize + 1,
        "origins must have window_days + 1 entries"
    );
    // 1. v1-layout staging without transfers (the v1 index hydrator rejects
    //    the v2 stopless linked rows), plus frequencies.
    let f = &feed.base;
    let staging_feed = V1Feed {
        stops: f.stops,
        routes: f.routes,
        trips: f.trips,
        stop_routes: f.stop_routes,
        feed_start_date: f.feed_start_date,
        city_tz_offset_seconds: f.city_tz_offset_seconds,
        services: ServicePoolSpec {
            window_days: f.services.window_days,
            pool: f.services.pool,
            service_to_bitfield: f.services.service_to_bitfield,
        },
        transfers: &[],
        boarding: f.boarding,
        stop_index: f.stop_index,
    };
    let mut staging = build_v1_ptb(&staging_feed);
    if !feed.frequencies.is_empty() || !feed.quarantined_frequency_trips.is_empty() {
        let mut rows: Vec<(FrequencyRow, u8)> =
            feed.frequencies.iter().map(|&r| (r, 0u8)).collect();
        rows.extend(
            feed.quarantined_frequency_trips
                .iter()
                .map(|&t| ((t, 0, 1, 1, 0), crate::v2::FREQUENCY_FLAG_QUARANTINED)),
        );
        rows.sort_by_key(|r| (r.0 .0, r.0 .1));
        let mut body = Vec::with_capacity(4 + rows.len() * 16);
        body.extend_from_slice(&(rows.len() as u32).to_le_bytes());
        for ((t, s, e, h, x), flags) in rows {
            body.extend_from_slice(&t.to_le_bytes());
            body.extend_from_slice(&s.to_le_bytes());
            body.extend_from_slice(&e.to_le_bytes());
            body.extend_from_slice(&h.to_le_bytes());
            body.extend_from_slice(&[x, flags]);
        }
        staging = crate::rewrite_regions(&staging, 1, 0, &[RegionEdit::Set(FREQUENCIES, &body)])
            .expect("frequencies");
    }
    // 2. Pattern band through the shared encoder.
    let band = {
        let reader = crate::Reader::from_bytes(staging.clone()).expect("staging decode");
        let index = crate::engine::index::Index::build(
            &reader,
            crate::engine::patterns::PatternMode::Unbounded,
        )
        .expect("staging index");
        crate::pattern_emit::encode_pattern_band(&reader, &index).expect("encode_pattern_band")
    };
    // 3. Block keys into the StringPool; TripMeta.block_idx per trip.
    let (pool_off, pool_len) = tagged_region(&staging, STRING_POOL);
    let pool_body = &staging[pool_off..pool_off + pool_len];
    let count = u32::from_le_bytes(pool_body[0..4].try_into().unwrap()) as usize;
    let off_at =
        |i: usize| u32::from_le_bytes(pool_body[4 + 4 * i..8 + 4 * i].try_into().unwrap()) as usize;
    let blob = 4 + 4 * (count + 1);
    let mut pool: Vec<alloc::string::String> = (0..count)
        .map(|i| {
            alloc::string::String::from(
                core::str::from_utf8(&pool_body[blob + off_at(i)..blob + off_at(i + 1)]).unwrap(),
            )
        })
        .collect();
    let mut trip_meta = band.trip_meta.clone();
    for (t, b) in feed.blocks.iter().enumerate() {
        if let Some(raw) = b.filter(|s| !s.is_empty()) {
            let idx = intern(&crate::v2::block_key(feed.feed_rank, raw), &mut pool);
            trip_meta[t * 24 + 16..t * 24 + 20].copy_from_slice(&idx.to_le_bytes());
        }
    }
    let mut new_pool = Vec::new();
    new_pool.extend_from_slice(&(pool.len() as u32).to_le_bytes());
    let mut cur = 0u32;
    for s in &pool {
        new_pool.extend_from_slice(&cur.to_le_bytes());
        cur += s.len() as u32;
    }
    new_pool.extend_from_slice(&cur.to_le_bytes());
    for s in &pool {
        new_pool.extend_from_slice(s.as_bytes());
    }
    // 4. v2 regions.
    let mut transfers_body = Vec::with_capacity(feed.base.transfers.len() * 32);
    for &(fs, ts, fr, tr, ft, tt, mins, ty) in feed.base.transfers {
        for v in [fs, ts, fr, tr, ft, tt, mins] {
            transfers_body.extend_from_slice(&v.to_le_bytes());
        }
        transfers_body.extend_from_slice(&[ty, 0, 0, 0]);
    }
    let origins: Vec<u8> = feed.origins.iter().flat_map(|o| o.to_le_bytes()).collect();
    let compat = crate::v2::CompatibilityArtifactCommitment {
        algorithm_version: crate::v2::COMMITMENT_ALGORITHM_V1,
        v1_identity_size: 0,
        v1_gzip_size: 0,
        v1_identity_sha256: [0; 32],
        v1_gzip_sha256: [0; 32],
    }
    .to_bytes();
    let empty = crate::v2::BlockDerivationCommitment::EMPTY.to_bytes();
    let flags = if feed.derive_block_inseat {
        crate::FEATURE_DERIVE_BLOCK_INSEAT
    } else {
        0
    };
    let tt_flags = if band.trip_times_i32 {
        crate::reader::TRIP_TIMES_FLAG_I32_DELTAS
    } else {
        0
    };
    let mut edits = vec![
        RegionEdit::Set(PATTERNS, &band.patterns),
        RegionEdit::Set(PATTERN_STOPS, &band.pattern_stops),
    ];
    if !band.pattern_semantics.is_empty() {
        edits.push(RegionEdit::Set(PATTERN_SEMANTICS, &band.pattern_semantics));
    }
    edits.extend([
        RegionEdit::SetWithFlags(TRIP_TIMES, tt_flags, &band.trip_times),
        RegionEdit::Set(TRIP_META, &trip_meta),
        RegionEdit::Set(PATTERNS_AT_STOP, &band.patterns_at_stop),
        RegionEdit::Set(PATTERN_TRIPS, &band.pattern_trips),
        RegionEdit::Set(STRING_POOL, &new_pool),
        RegionEdit::Set(TRANSFERS, &transfers_body),
        RegionEdit::Set(SERVICE_DAY_ORIGINS, &origins),
        RegionEdit::Set(BLOCK_DERIVATION_COMMITMENT, &empty),
        RegionEdit::Set(COMPATIBILITY_ARTIFACT_COMMITMENT, &compat),
    ]);
    if feed.strip_carry {
        edits.extend([
            RegionEdit::Remove(STOP_TIMES),
            RegionEdit::Remove(TRIP_STARTS),
            RegionEdit::Remove(CSR),
            RegionEdit::Remove(crate::region_ids::STOP_TIME_BOARDING),
        ]);
    }
    let mut out =
        crate::rewrite_regions(&staging, crate::PTB_VERSION_V2, flags, &edits).expect("v2 rewrite");
    // 5. The real 0x19 value, recomputed through the routing index builder.
    if feed.derive_block_inseat {
        let reader = crate::Reader::from_bytes(out.clone()).expect("v2 decode");
        let c = crate::engine::v2::recompute_block_commitment(
            &reader,
            crate::engine::patterns::PatternMode::Unbounded,
        )
        .expect("block commitment");
        out = crate::rewrite_regions(
            &out,
            crate::PTB_VERSION_V2,
            flags,
            &[RegionEdit::Set(BLOCK_DERIVATION_COMMITMENT, &c.to_bytes())],
        )
        .expect("commitment rewrite");
    }
    out
}

// ── Builder self-tests (vacuous-pass guard) ──────────────────────────────────
//
// The engine unit tests trust these builders to emit structurally-valid PTB /
// PTFT bytes. If a builder drifts (wrong region offset, miscounted rows), a unit
// test could pass against malformed bytes that the reader silently mis-decodes.
// These round-trip each builder's output through the SAME `Reader`/`Transfers`
// the engine consumes and assert the counts + key fields the builders promise,
// so a layout drift fails HERE rather than corrupting a downstream assertion.
#[cfg(test)]
mod selftests {
    use super::*;

    #[test]
    fn build_n_trip_ptb_roundtrips() {
        // 1 route, 2 trips; trip 1 SKIPS the middle stop (only s0, s2).
        let bytes = build_n_trip_ptb(
            3,
            &[
                &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
                &[(1, 0, 28800), (3, 2, 29400)],
            ],
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (3, 1, 2));
        assert_eq!(r.stop_id(0).unwrap(), "s0");
        assert_eq!(r.stop_id(2).unwrap(), "s2");
        // trip_starts reflects 3 rows then 2 rows.
        assert_eq!(r.trip_starts().unwrap(), &[0u32, 3, 5]);
        // row 1 = trip0 @ s1, dep 25500, arr_diff 0.
        let s1 = r.stop_time(1).unwrap();
        assert_eq!((s1.dep_secs, s1.arr_diff, s1.stop_idx), (25500, 0, 1));
        assert_eq!(r.stop_routes(0).unwrap(), &[0u32]);
        assert_eq!(r.stop_routes(1).unwrap(), &[0u32]);
    }

    #[test]
    fn build_two_trip_ptb_roundtrips() {
        let bytes = build_two_trip_ptb(2, &[(1, 0, 100), (2, 1, 700)], &[(1, 0, 200), (2, 1, 800)]);
        let r = crate::Reader::from_bytes(bytes).unwrap();
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (2, 1, 2));
        assert_eq!(r.trip_starts().unwrap(), &[0u32, 2, 4]);
        assert_eq!(r.stop_time(1).unwrap().dep_secs, 700);
        assert_eq!(r.stop_time(3).unwrap().dep_secs, 800);
    }

    #[test]
    fn build_multi_route_ptb_roundtrips() {
        // 2 routes, distinct exits; s0 shared (entry) -> routes [0,1] in order.
        let bytes =
            build_multi_route_ptb(3, &[&[(1, 0, 0), (2, 1, 600)], &[(1, 0, 0), (2, 2, 600)]]);
        let r = crate::Reader::from_bytes(bytes).unwrap();
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (3, 2, 2));
        assert_eq!(r.trip_starts().unwrap(), &[0u32, 2, 4]);
        assert_eq!(r.stop_routes(0).unwrap(), &[0u32, 1]); // shared entry, route order
        assert_eq!(r.stop_routes(1).unwrap(), &[0u32]); // s1 only on route 0
        assert_eq!(r.stop_routes(2).unwrap(), &[1u32]); // s2 only on route 1
        assert_eq!(r.stop_time(1).unwrap().dep_secs, 600);
        assert_eq!(r.stop_time(3).unwrap().dep_secs, 600);
    }

    #[test]
    fn build_transfers_ptb_roundtrips() {
        // Two GTFS transfers.txt rows: a type-3 stop-pair (no scope / min time)
        // and a type-2 row carrying a min_transfer_time of 180s.
        const ABSENT: u32 = u32::MAX;
        let bytes = build_transfers_ptb(&[
            (0, 1, ABSENT, ABSENT, ABSENT, ABSENT, ABSENT, 3),
            (1, 0, ABSENT, ABSENT, ABSENT, ABSENT, 180, 2),
        ]);
        let r = crate::Reader::from_bytes(bytes).unwrap();
        // Carried only — the routing fields still decode normally.
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (2, 1, 1));
        assert_eq!(r.num_transfers(), 2);
        let t0 = r.transfer(0).unwrap();
        assert_eq!(
            (t0.from_stop_idx, t0.to_stop_idx, t0.transfer_type),
            (0, 1, 3)
        );
        assert_eq!(t0.min_transfer_secs, u32::MAX); // absent
        assert_eq!(t0.from_route_idx, u32::MAX);
        let t1 = r.transfer(1).unwrap();
        assert_eq!(
            (t1.from_stop_idx, t1.to_stop_idx, t1.transfer_type),
            (1, 0, 2)
        );
        assert_eq!(t1.min_transfer_secs, 180);
        // Out-of-range index errors like the other record accessors.
        assert!(r.transfer(2).is_err());
    }

    #[test]
    fn build_routes_multi_trip_ptb_roundtrips() {
        // 2 routes: R0 has 2 trips (s0->s1->s4 and s0->s2->s4); R1 has 1 trip (s3->s4->s5).
        let bytes = build_routes_multi_trip_ptb(
            6,
            &[
                &[
                    &[(1, 0, 25200), (2, 1, 25500), (3, 4, 25800)], // R0 trip0: s0->s1->s4
                    &[(1, 0, 25200), (2, 2, 25500), (3, 4, 25800)], // R0 trip1: s0->s2->s4
                ],
                &[
                    &[(1, 3, 25200), (2, 4, 25800), (3, 5, 26100)], // R1 trip0: s3->s4->s5
                ],
            ],
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (6, 2, 3));
        // TripStarts: R0-trip0 (3 rows), R0-trip1 (3 rows), R1-trip0 (3 rows).
        assert_eq!(r.trip_starts().unwrap(), &[0u32, 3, 6, 9]);
        // Trip 0 and 1 on route 0; trip 2 on route 1.
        let t0 = r.trip(0).unwrap();
        let t1 = r.trip(1).unwrap();
        let t2 = r.trip(2).unwrap();
        assert_eq!(t0.route_idx, 0);
        assert_eq!(t1.route_idx, 0);
        assert_eq!(t2.route_idx, 1);
        // s1 and s2 (branch stops) served only by route 0; s4 served by both routes.
        assert_eq!(r.stop_routes(1).unwrap(), &[0u32]); // s1 only R0
        assert_eq!(r.stop_routes(2).unwrap(), &[0u32]); // s2 only R0
        assert_eq!(r.stop_routes(4).unwrap(), &[0u32, 1]); // s4: both routes
                                                           // route_trips CSR: R0 owns trips [0,1]; R1 owns trip [2].
        assert_eq!(r.route_trips(0).unwrap(), &[0u32, 1]); // R0: trips 0+1
        assert_eq!(r.route_trips(1).unwrap(), &[2u32]); // R1: trip 2
    }

    #[test]
    fn build_n_trip_ptb_with_boarding_roundtrips() {
        // 1 route, 2 trips; trip 0 visits all 3 stops, trip 1 skips s1 (s0,s2).
        // boarding column is one byte per stop_time row (5 rows): mix default,
        // pickup-forbidden (0x51) and drop-off-forbidden (0x54) so a per-row
        // mis-index in the 0xFA carry would shift a predicate and fail HERE.
        let boarding = [0x51u8, 0x50, 0x54, 0x50, 0x51];
        let bytes = build_n_trip_ptb_with_boarding(
            &["s0", "s1", "s2"],
            &[
                &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)],
                &[(1, 0, 28800), (2, 2, 29400)],
            ],
            &boarding,
        );
        let r = crate::Reader::from_bytes(bytes).unwrap();
        assert_eq!(r.header().version, crate::PTB_VERSION_V1);
        assert_eq!((r.num_stops(), r.num_routes(), r.num_trips()), (3, 1, 2));
        // trip_starts reflects 3 rows then 2 rows (5 stop_times total).
        assert_eq!(r.trip_starts().unwrap(), &[0u32, 3, 5]);
        // row 4 = trip1 @ s2, dep 29400, arr_diff 0 (SoA columns decode).
        let s4 = r.stop_time(4).unwrap();
        assert_eq!((s4.dep_secs, s4.arr_diff, s4.stop_idx), (29400, 0, 2));
        // Single route owns every stop -> stop->routes CSR is [0] per stop.
        assert_eq!(r.stop_routes(0).unwrap(), &[0u32]);
        assert_eq!(r.stop_routes(1).unwrap(), &[0u32]);
        assert_eq!(r.stop_routes(2).unwrap(), &[0u32]);
        // 0xFA StopTimeBoarding: each row's byte + decoded predicates round-trip.
        for (row, &b) in boarding.iter().enumerate() {
            assert_eq!(r.boarding_byte(row), b, "boarding byte for row {row}");
        }
        // row 0 (0x51): pickup forbidden, drop-off allowed.
        assert!(r.pickup_forbidden(0) && !r.drop_off_forbidden(0));
        // row 1 (0x50): default — neither forbidden.
        assert!(!r.pickup_forbidden(1) && !r.drop_off_forbidden(1));
        // row 2 (0x54): drop-off forbidden, pickup allowed.
        assert!(!r.pickup_forbidden(2) && r.drop_off_forbidden(2));
    }

    /// INDEPENDENT present-vs-absent oracle.
    ///
    /// The engine-regression golden is a LOCKSTEP check: if the engine and its wasm binding silently
    /// dropped the predicate, the gate would still pass (both empty / both board).
    /// This oracle proves the `0xFA` BYTES change behaviour, independent of any
    /// host↔engine equivalence: the SAME topology built WITHOUT the region boards the
    /// forbidden stop (current/legacy behaviour), built WITH `s1 pickup_type==1`
    /// (`0x51`) refuses to board it. ON-canonical so the predicate genuinely runs.
    #[test]
    fn boarding_region_changes_first_leg() {
        use crate::engine::{plan, Index, Mobility, PatternMode, Query, ScanState, StopWalk};

        // Route s0→s1→s2, one trip; all-active service, feed_start_date 20260601.
        let topo: &[&[(u16, u32, u32)]] = &[&[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800)]];
        // 3 stop_times rows: s1 (row 1) gets pickup_type==1 (0x51) in the WITH build.
        let without = build_n_trip_ptb_with_boarding(&["s0", "s1", "s2"], topo, &[]);
        let with_b = build_n_trip_ptb_with_boarding(&["s0", "s1", "s2"], topo, &[0x50, 0x51, 0x50]);

        // Query s1→s2: the only board is at s1. Without the region it boards;
        // with pickup_type==1 at s1 it cannot board → empty.
        let q_s1_s2 = |date: u32| Query {
            excluded_routes: Default::default(),
            entry_stops: alloc::vec![StopWalk {
                stop: 1,
                walk_secs: 0
            }],
            exit_stops: alloc::vec![StopWalk {
                stop: 2,
                walk_secs: 0
            }],
            departure_secs: 25000,
            date,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: alloc::vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };

        let run = |bytes: alloc::vec::Vec<u8>, q: &Query| -> Vec<crate::engine::Itinerary> {
            let reader = crate::Reader::from_bytes(bytes).unwrap();
            let index = Index::build(&reader, PatternMode::Off).unwrap();
            let mut st = ScanState::default();
            plan(&reader, &index, None, &mut st, q).unwrap()
        };

        // 20260605 is offset 4 in the 90-day window → active (all-0xFF bitmask).
        let no_region = run(without.clone(), &q_s1_s2(20260605));
        assert_eq!(
            no_region.len(),
            1,
            "WITHOUT the 0xFA region the s1 board is allowed (legacy behaviour)"
        );
        let with_region = run(with_b.clone(), &q_s1_s2(20260605));
        assert!(
            with_region.is_empty(),
            "WITH s1 pickup_type==1 the only board (s1) is forbidden → empty"
        );

        // And the s0→s2 reroute still works WITH the region: board the allowed s0,
        // alight s2 (the predicate forbids s1 boarding, not the whole trip).
        let q_s0_s2 = Query {
            excluded_routes: Default::default(),
            entry_stops: alloc::vec![StopWalk {
                stop: 0,
                walk_secs: 0
            }],
            exit_stops: alloc::vec![StopWalk {
                stop: 2,
                walk_secs: 0
            }],
            departure_secs: 25000,
            date: 20260605,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: alloc::vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };
        let reroute = run(with_b, &q_s0_s2);
        assert_eq!(
            reroute.len(),
            1,
            "s0→s2 boards the allowed s0 even WITH the region"
        );
        let leg = &reroute[0].legs[0];
        match &leg.kind {
            crate::engine::LegKind::Transit {
                board_stop_idx,
                alight_stop_idx,
                ..
            } => {
                assert_eq!(
                    (*board_stop_idx, *alight_stop_idx),
                    (0, 2),
                    "board s0, alight s2"
                );
            }
            _ => panic!("expected a transit first leg"),
        }
    }

    #[test]
    fn build_soa_ptb_writes_distinct_stop_and_route_fields() {
        let b = build_soa_ptb(
            &[
                SoaStop {
                    id: "S0",
                    name: "Alpha",
                    lat: 54.6912345,
                    lon: 25.2797456,
                    parent: None,
                    wheelchair: 0,
                },
                SoaStop {
                    id: "S1",
                    name: "Beta",
                    lat: -33.8688,
                    lon: 151.2093,
                    parent: Some(0),
                    wheelchair: 2,
                },
            ],
            &[
                SoaRoute {
                    id: "R0",
                    agency: "AG0",
                    short: "1",
                    long: "One",
                    color: "FF0000",
                    text_color: "FFFFFF",
                    route_type: 3,
                },
                SoaRoute {
                    id: "R1",
                    agency: "AG1",
                    short: "2",
                    long: "Two",
                    color: "00FF00",
                    text_color: "000000",
                    route_type: 0,
                },
            ],
            &[&[(1, 0, 100), (2, 1, 200)]],
        );
        let r = crate::Reader::from_bytes(b).unwrap();
        assert_eq!(r.header().version, crate::PTB_VERSION_V1);
        assert_eq!(r.num_routes(), 2);
        assert_eq!(r.stop(1).unwrap().stop_name, "Beta"); // distinct name (not zero-filled)
        assert_eq!(r.stop_wheelchair_boarding(1).unwrap(), 2);
        assert_eq!(r.stop_parent(1), Some(0));
        assert!((r.stop_lat_f64(0).unwrap() - 54.6912345).abs() < 1e-6); // coords present
                                                                         // distinct route fields (not zero-filled)
        assert_eq!(r.route_id(1).unwrap(), "R1");
        assert_eq!(r.route_long_name(1).unwrap(), "Two");
        assert_eq!(r.route_type(1).unwrap(), 0);
        // route 0 carries DISTINCT non-zero values — guards the route-field write offsets
        // (route_type(1)==0 alone is the zero default and masks offset regressions).
        assert_eq!(r.route_type(0).unwrap(), 3);
        assert_eq!(r.route_id(0).unwrap(), "R0");
        assert_eq!(r.route_agency_id(0).unwrap(), "AG0");
        assert_eq!(r.route_short_name(0).unwrap(), "1");
        assert_eq!(r.route_long_name(0).unwrap(), "One");
        assert_eq!(r.route_color(0).unwrap(), "FF0000");
        assert_eq!(r.route_text_color(0).unwrap(), "FFFFFF");
    }

    #[test]
    fn build_v1_ptb_handles_empty_feed() {
        let r = crate::Reader::from_bytes(build_v1_ptb(&V1Feed {
            stops: &[],
            routes: &[],
            trips: &[],
            stop_routes: StopRoutes::Served,
            feed_start_date: 20260501,
            city_tz_offset_seconds: 0,
            services: all_active_service(),
            transfers: &[],
            boarding: &[],
            stop_index: false,
        }))
        .unwrap();
        assert_eq!(r.num_stops(), 0);
        assert_eq!(r.num_routes(), 0);
        assert!(r.stop(0).is_err());
    }

    #[test]
    fn build_soa_ptb_region_table_parses() {
        use crate::header::Header;
        use crate::region_ids::{ROUTES_SOA, STOPS_SOA, STOP_INDEX};

        // 3 stops, 2 routes; one route owns one trip (carry topology). Coords are
        // asymmetric/signed so a lat/lon transposition would be visible; stop 1
        // has a real parent, stop 2 has none (u32::MAX).
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
        // Route 0 owns the single trip; route 1 has no trips.
        let bytes = build_soa_ptb(&stops, &routes, &[&[(1, 0, 100), (2, 1, 200), (3, 2, 300)]]);

        let h = Header::parse(&bytes).expect("SoA header must parse");
        assert_eq!(h.version, crate::PTB_VERSION_V1);

        let n = stops.len() as u64;
        let m = routes.len() as u64;

        // 0x40 StopsSoA: tight = N*(4*5) + N*1 = N*21. 4-aligned offset.
        let soa = h
            .region_by_id(STOPS_SOA)
            .expect("0x40 StopsSoA region present");
        assert_eq!(soa.offset % 4, 0, "0x40 offset must be 4-aligned");
        assert_eq!(soa.length as u64, n * 21, "0x40 tight column total");

        // 0x41 RoutesSoA: tight = M*(4*6) + M*2 = M*26. 4-aligned offset.
        let rsoa = h
            .region_by_id(ROUTES_SOA)
            .expect("0x41 RoutesSoA region present");
        assert_eq!(rsoa.offset % 4, 0, "0x41 offset must be 4-aligned");
        assert_eq!(rsoa.length as u64, m * 26, "0x41 tight column total");

        // 0x44 StopIndex: present, 4-aligned, 12 B per distinct id (3 distinct).
        let si = h
            .region_by_id(STOP_INDEX)
            .expect("0x44 StopIndex region present");
        assert_eq!(si.offset % 4, 0, "0x44 offset must be 4-aligned");
        assert_eq!(si.length as u64, n * 12, "0x44 entry total");

        assert!(
            h.region_by_id(0x99).is_none(),
            "an unallocated id resolves to None"
        );
    }

    #[test]
    fn build_ptft_roundtrips() {
        let bytes = build_ptft(&["s0", "s1", "s2"], &[&[(1, 60), (2, 200)], &[], &[]]);
        let t = crate::Transfers::from_bytes(&bytes).unwrap();
        assert_eq!(t.stop_count(), 3);
        let s0 = t.index_of("s0").unwrap();
        let (nbrs, walks) = t.edges(s0);
        assert_eq!(nbrs, &[1u32, 2]);
        assert_eq!(walks, &[60u32, 200]);
        assert!(t.edges(t.index_of("s1").unwrap()).0.is_empty());
    }

    /// Window-parameterized builder: a 90-day window is byte-identical to the
    /// default builder (no `0x01`, 12-byte stride), and a non-90 window emits the
    /// `0x01 WindowMeta` region so the reader reports the wider window + a wider
    /// per-service bitmask stride.
    #[test]
    fn build_soa_ptb_windowed_emits_window_meta_only_when_non_default() {
        let stops = [
            SoaStop {
                id: "s0",
                name: "Zero",
                lat: 54.0,
                lon: 25.0,
                parent: None,
                wheelchair: 0,
            },
            SoaStop {
                id: "s1",
                name: "One",
                lat: 54.1,
                lon: 25.1,
                parent: None,
                wheelchair: 0,
            },
        ];
        let routes = [SoaRoute {
            id: "R",
            agency: "A",
            short: "1",
            long: "One",
            color: "FF0000",
            text_color: "FFFFFF",
            route_type: 3,
        }];
        let trips: &[&[(u16, u32, u32)]] = &[&[(1, 0, 100), (2, 1, 200)]];

        // window 90 ⇒ byte-identical to the non-windowed builder (no 0x01).
        let at_90 = build_soa_ptb_windowed(&stops, &routes, trips, 90);
        let baseline = build_soa_ptb(&stops, &routes, trips);
        assert_eq!(
            at_90, baseline,
            "window 90 must be byte-identical (no 0x01)"
        );
        let r90 = crate::Reader::from_bytes(at_90).unwrap();
        assert_eq!(r90.window_days(), 90);
        assert_eq!(r90.bytes_per_service(), 12);
        assert!(
            r90.header()
                .region_by_id(crate::region_ids::WINDOW_META)
                .is_none(),
            "no 0x01 region at the default window"
        );

        // window 400 ⇒ 0x01 present, window/stride widen, bundle still parses.
        let at_400 = build_soa_ptb_windowed(&stops, &routes, trips, 400);
        let r400 = crate::Reader::from_bytes(at_400).unwrap();
        assert_eq!(r400.window_days(), 400);
        assert_eq!(r400.bytes_per_service(), crate::bytes_per_service(400)); // ceil(400/8)=50
        let wm = r400
            .header()
            .region_by_id(crate::region_ids::WINDOW_META)
            .expect("0x01 region present at a non-default window");
        assert_eq!(wm.length, 4, "WindowMeta body is 4 bytes");
        assert_eq!(wm.offset % 2, 0, "M10: natural 2-byte alignment");
        assert_eq!((r400.num_stops(), r400.num_routes()), (2, 1));
    }
}
