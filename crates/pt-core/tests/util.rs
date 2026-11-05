//! Shared bundle builder for the integration tests. Lays out a page-aligned
//! PTB v1 bundle (tagged region table, SoA stops/routes/stop_times, service
//! pool) from already-serialized region bodies, so a test can hand-corrupt any
//! one of them. `std` is fine here — only the `pt-core` library crate is
//! `no_std`.
#![allow(dead_code)] // each test binary uses a subset

pub const PAGE: usize = 4096;

pub const STOPS_SOA: u16 = 0x40;
pub const ROUTES_SOA: u16 = 0x41;
pub const SERVICE_BITFIELD_POOL: u16 = 0x15;
pub const SERVICE_TO_BITFIELD: u16 = 0x16;
pub const TRIPS_INTERN: u16 = 0xF2;
pub const STOP_TIMES: u16 = 0xF4;
pub const TRIP_STARTS: u16 = 0xF5;
pub const CSR: u16 = 0xF6;
pub const STRING_POOL: u16 = 0xF7;
pub const TRANSFERS: u16 = 0xF8;

#[inline]
fn align_up(n: usize) -> usize {
    (n + PAGE - 1) & !(PAGE - 1)
}

pub fn u32s(vals: &[u32]) -> Vec<u8> {
    let mut o = Vec::with_capacity(vals.len() * 4);
    for v in vals {
        o.extend_from_slice(&v.to_le_bytes());
    }
    o
}

/// One StringPool: `count u32 | offsets[count+1] u32 | UTF-8 blob`. Index 0 = "".
pub fn string_pool(strings: &[&str]) -> Vec<u8> {
    let count = strings.len() as u32;
    let mut out = Vec::new();
    out.extend_from_slice(&count.to_le_bytes());
    let mut cur = 0u32;
    for s in strings {
        out.extend_from_slice(&cur.to_le_bytes());
        cur += s.len() as u32;
    }
    out.extend_from_slice(&cur.to_le_bytes()); // terminator = blob len
    for s in strings {
        out.extend_from_slice(s.as_bytes());
    }
    out
}

/// `0x40 StopsSoA` for stops with the given id / name pool indices: zero
/// coords, no parent (`u32::MAX`), wheelchair 0. Tight `N*21`.
pub fn stops_soa(id_idx: &[u32], name_idx: &[u32]) -> Vec<u8> {
    let n = id_idx.len();
    assert_eq!(name_idx.len(), n);
    let mut out = u32s(id_idx);
    out.extend_from_slice(&u32s(name_idx));
    out.extend_from_slice(&vec![0u8; 8 * n]); // lat_e7, lon_e7
    out.extend_from_slice(&u32s(&vec![u32::MAX; n])); // parent_idx
    out.extend_from_slice(&vec![0u8; n]); // wheelchair
    out
}

/// `0x41 RoutesSoA` for BUS routes with the given id pool indices (every other
/// string column → pool index 0). Tight `M*26`.
pub fn routes_soa(id_idx: &[u32]) -> Vec<u8> {
    let m = id_idx.len();
    let mut out = u32s(id_idx);
    out.extend_from_slice(&vec![0u8; 20 * m]); // agency, short, long, color, text_color
    for _ in 0..m {
        out.extend_from_slice(&3u16.to_le_bytes());
    }
    out
}

/// `0xF4 StopTimes` SoA columns for `(dep_secs, arr_diff, stop_idx, stop_seq)`
/// rows: dep u32 ×N | stop_idx u32 ×N | arr_diff i16 ×N | stop_seq u16 ×N.
pub fn stop_times_soa(rows: &[(u32, i16, u32, u16)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rows.len() * 12);
    for r in rows {
        out.extend_from_slice(&r.0.to_le_bytes());
    }
    for r in rows {
        out.extend_from_slice(&r.2.to_le_bytes());
    }
    for r in rows {
        out.extend_from_slice(&r.1.to_le_bytes());
    }
    for r in rows {
        out.extend_from_slice(&r.3.to_le_bytes());
    }
    out
}

/// Parameters for a full bundle. Each field is the already-serialized body of
/// one region (records packed at their stride, CSR packed back-to-back).
/// Start from [`Bundle::empty`] and override what the test needs.
pub struct Bundle {
    pub num_stops: u32,
    pub num_routes: u32,
    pub num_trips: u32,
    pub num_services: u32,
    pub feed_start_date: u32,
    pub stops_soa: Vec<u8>,
    pub routes_soa: Vec<u8>,
    pub trips: Vec<u8>,
    /// `0x15`: `count u32` + `count` bitfields of `bytes_per_service` bytes.
    pub service_pool: Vec<u8>,
    /// `0x16`: `num_services × u32` pool indices.
    pub service_to_bitfield: Vec<u8>,
    pub stop_times: Vec<u8>,
    pub trip_starts: Vec<u8>, // (num_trips+1) u32 LE
    pub csr: Vec<u8>,         // rtOff | rtVal | srOff | srVal, packed
    pub string_pool: Vec<u8>,
    /// 32 B per GTFS transfers.txt rule. Empty by default.
    pub transfers: Vec<u8>,
}

impl Bundle {
    /// 0 stops/routes/trips/services, pool=[""], tripStarts=[0], an empty
    /// service pool, and the degenerate CSR (rtOff=[0], srOff=[0]).
    pub fn empty() -> Bundle {
        Bundle {
            num_stops: 0,
            num_routes: 0,
            num_trips: 0,
            num_services: 0,
            feed_start_date: 20260501,
            stops_soa: vec![],
            routes_soa: vec![],
            trips: vec![],
            service_pool: u32s(&[0]),
            service_to_bitfield: vec![],
            stop_times: vec![],
            trip_starts: u32s(&[0]),
            csr: u32s(&[0, 0]),
            string_pool: string_pool(&[""]),
            transfers: vec![],
        }
    }
}

/// Lay out the header and the tagged region table (24 B entries from offset
/// 32, regionId 0 terminates), then each region page-aligned in table order:
/// 0x40, 0x41, 0xF2, 0x15, 0x16, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8. The table
/// records each body's exact length.
pub fn assemble_bundle(b: &Bundle) -> Vec<u8> {
    let regions: [(u16, &[u8]); 10] = [
        (STOPS_SOA, &b.stops_soa),
        (ROUTES_SOA, &b.routes_soa),
        (TRIPS_INTERN, &b.trips),
        (SERVICE_BITFIELD_POOL, &b.service_pool),
        (SERVICE_TO_BITFIELD, &b.service_to_bitfield),
        (STOP_TIMES, &b.stop_times),
        (TRIP_STARTS, &b.trip_starts),
        (CSR, &b.csr),
        (STRING_POOL, &b.string_pool),
        (TRANSFERS, &b.transfers),
    ];
    let mut offsets = [0usize; 10];
    let mut cursor = PAGE; // first region after the 4096-byte header
    for (i, (_, body)) in regions.iter().enumerate() {
        offsets[i] = cursor;
        cursor = align_up(cursor + body.len());
    }
    let mut buf = vec![0u8; cursor.max(PAGE)];

    buf[0..4].copy_from_slice(&pt_core::PTB_MAGIC);
    buf[4..6].copy_from_slice(&pt_core::PTB_VERSION_V1.to_le_bytes());
    buf[8..12].copy_from_slice(&b.num_stops.to_le_bytes());
    buf[12..16].copy_from_slice(&b.num_routes.to_le_bytes());
    buf[16..20].copy_from_slice(&b.num_trips.to_le_bytes());
    buf[20..24].copy_from_slice(&b.feed_start_date.to_le_bytes());
    buf[24..28].copy_from_slice(&b.num_services.to_le_bytes());
    for (i, (id, body)) in regions.iter().enumerate() {
        let e = 32 + i * 24;
        buf[e..e + 2].copy_from_slice(&id.to_le_bytes());
        buf[e + 8..e + 16].copy_from_slice(&(offsets[i] as u64).to_le_bytes());
        buf[e + 16..e + 24].copy_from_slice(&(body.len() as u64).to_le_bytes());
        buf[offsets[i]..offsets[i] + body.len()].copy_from_slice(body);
    }
    buf
}

/// Byte offset of the table entry for `region_id` (panics if absent).
pub fn table_entry(buf: &[u8], region_id: u16) -> usize {
    let mut e = 32;
    loop {
        let id = u16::from_le_bytes(buf[e..e + 2].try_into().unwrap());
        assert_ne!(id, 0, "region 0x{region_id:02X} not in the table");
        if id == region_id {
            return e;
        }
        e += 24;
    }
}

/// `region_id`'s body offset, read from the tagged table.
pub fn region_offset(buf: &[u8], region_id: u16) -> usize {
    let e = table_entry(buf, region_id);
    u64::from_le_bytes(buf[e + 8..e + 16].try_into().unwrap()) as usize
}

/// Overwrite `region_id`'s offset field in the tagged table.
pub fn set_region_offset(buf: &mut [u8], region_id: u16, off: u64) {
    let e = table_entry(buf, region_id);
    buf[e + 8..e + 16].copy_from_slice(&off.to_le_bytes());
}

/// 0 stops/routes/trips/services: [`Bundle::empty`] assembled.
pub fn assemble_empty() -> Vec<u8> {
    assemble_bundle(&Bundle::empty())
}

/// CSR whose srValues references a route index >= num_routes (0) -> CsrInvalid.
/// 1 stop, 0 routes, but srOffsets=[0,1] and srValues=[0] (route 0 doesn't exist).
pub fn assemble_with_bad_csr() -> Vec<u8> {
    let mut csr = u32s(&[0]); // rtOffsets[1] = [0]
    csr.extend_from_slice(&u32s(&[0, 1])); // srOffsets[2]
    csr.extend_from_slice(&u32s(&[0])); // srValues = [0] — route 0 OOB (0 routes)
    assemble_bundle(&Bundle {
        num_stops: 1,
        stops_soa: stops_soa(&[1], &[2]),
        csr,
        string_pool: string_pool(&["", "S1", "Stop One"]),
        ..Bundle::empty()
    })
}
