use crate::error::{PtbError, Result};

#[inline]
fn slice4(b: &[u8], off: usize) -> Result<[u8; 4]> {
    b.get(off..off + 4)
        .and_then(|s| s.try_into().ok())
        .ok_or(PtbError::SliceOutOfBounds { what: "u32 field" })
}
#[inline]
fn slice2(b: &[u8], off: usize) -> Result<[u8; 2]> {
    b.get(off..off + 2)
        .and_then(|s| s.try_into().ok())
        .ok_or(PtbError::SliceOutOfBounds { what: "u16 field" })
}
#[inline]
pub fn rd_u32(b: &[u8], off: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(slice4(b, off)?))
}
#[inline]
pub fn rd_u16(b: &[u8], off: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(slice2(b, off)?))
}
#[inline]
pub fn rd_i16(b: &[u8], off: usize) -> Result<i16> {
    Ok(i16::from_le_bytes(slice2(b, off)?))
}
#[inline]
pub fn rd_i32(b: &[u8], off: usize) -> Result<i32> {
    Ok(i32::from_le_bytes(slice4(b, off)?))
}
#[inline]
pub fn rd_u8(b: &[u8], off: usize) -> Result<u8> {
    b.get(off)
        .copied()
        .ok_or(PtbError::SliceOutOfBounds { what: "u8 field" })
}

use crate::strpool::StringPool;
use alloc::string::String;

pub const TRIP_RECORD_BYTES: usize = 24;
pub const STOP_TIME_ROW_BYTES: usize = 12;
pub const TRANSFER_RECORD_BYTES: usize = 32;

/// Sentinel for an absent optional index / min-transfer-time in a Transfers
/// record (`0xFFFFFFFF`).
pub const TRANSFER_ABSENT: u32 = 0xFFFF_FFFF;

#[derive(Debug, Clone, PartialEq)]
pub struct Stop {
    pub stop_id: String,
    pub stop_name: String,
    pub stop_lat: f32,
    pub stop_lon: f32,
    pub wheelchair_boarding: u8,
}
#[derive(Debug, Clone, PartialEq)]
pub struct RouteRec {
    pub route_id: String,
    pub agency_id: String,
    pub short_name: String,
    pub long_name: String,
    pub route_type: u16,
    pub route_color: String,
    pub route_text_color: String,
}
#[derive(Debug, Clone, PartialEq)]
pub struct TripRec {
    pub trip_id: String,
    pub headsign: String,
    pub route_idx: u32,
    pub service_idx: u32,
    pub wheelchair_accessible: u8,
    pub direction_id: u8,
    /// GTFS trips.bikes_allowed 0/1/2 (record byte +18). 0 = no info.
    pub bikes_allowed: u8,
    pub shape_id: String,
}
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StopTime {
    pub dep_secs: u32,
    pub arr_diff: i16,
    pub stop_idx: u32,
    pub stop_seq: u16,
}

/// One GTFS `transfers.txt` rule decoded from the 32 B `0xF8 Transfers` record.
///
/// `from_stop_idx` / `to_stop_idx` are stop ordinals;
/// the optional route/trip scope (`*_route_idx` / `*_trip_idx`) and
/// `min_transfer_secs` carry [`TRANSFER_ABSENT`] (`0xFFFFFFFF`) when the source
/// feed omits them. `transfer_type` is the GTFS `transfer_type` (0–5).
///
/// Carried only in S0 — no scan/relaxation code reads it.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransferRule {
    pub from_stop_idx: u32,
    pub to_stop_idx: u32,
    pub from_route_idx: u32,
    pub to_route_idx: u32,
    pub from_trip_idx: u32,
    pub to_trip_idx: u32,
    pub min_transfer_secs: u32,
    pub transfer_type: u8,
}

#[inline]
fn s(pool: &StringPool, b: &[u8], off: usize) -> Result<String> {
    Ok(String::from(pool.str_at(rd_u32(b, off)?)?))
}

pub fn decode_trip(region: &[u8], off: usize, pool: &StringPool) -> Result<TripRec> {
    Ok(TripRec {
        trip_id: s(pool, region, off)?,
        headsign: s(pool, region, off + 4)?,
        route_idx: rd_u32(region, off + 8)?,
        service_idx: rd_u32(region, off + 12)?,
        wheelchair_accessible: rd_u8(region, off + 16)?,
        direction_id: rd_u8(region, off + 17)?,
        bikes_allowed: rd_u8(region, off + 18)?,
        shape_id: s(pool, region, off + 20)?,
    })
}
/// Decode the `i`-th stop-time from the SoA `StopTimes` region (`N` = num rows).
/// Columns: dep_secs u32@`4i`, stop_idx u32@`4N+4i`, arr_diff i16@`8N+2i`, stop_seq u16@`10N+2i`.
/// The reader validates `region.len() == 12*N` at load, so these offsets are in-bounds.
pub fn decode_stop_time_soa(region: &[u8], i: usize, n: usize) -> Result<StopTime> {
    Ok(StopTime {
        dep_secs: rd_u32(region, 4 * i)?,
        stop_idx: rd_u32(region, 4 * n + 4 * i)?,
        arr_diff: rd_i16(region, 8 * n + 2 * i)?,
        stop_seq: rd_u16(region, 10 * n + 2 * i)?,
    })
}

/// Narrow hot-path decode: `dep_secs` only (column base 0, independent of `N`).
/// Reached via `Reader::dep_secs`, which the RAPTOR scan's `dep_secs_at` calls so
/// a dep-only read touches a single cache line, not the four `stop_time` would.
pub fn decode_stop_time_soa_dep(region: &[u8], i: usize) -> Result<u32> {
    rd_u32(region, 4 * i)
}

/// Decode one 32 B `0xF8 Transfers` record at `off` within `region`. Layout (LE):
/// fromStopIdx u32@0 | toStopIdx u32@4 | fromRouteIdx u32@8 | toRouteIdx u32@12 |
/// fromTripIdx u32@16 | toTripIdx u32@20 | minTransferSecs u32@24 |
/// transferType u8@28 | reserved[3]@29. `0xFFFFFFFF` = absent.
///
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
pub fn decode_transfer(region: &[u8], off: usize) -> Result<TransferRule> {
    Ok(TransferRule {
        from_stop_idx: rd_u32(region, off)?,
        to_stop_idx: rd_u32(region, off + 4)?,
        from_route_idx: rd_u32(region, off + 8)?,
        to_route_idx: rd_u32(region, off + 12)?,
        from_trip_idx: rd_u32(region, off + 16)?,
        to_trip_idx: rd_u32(region, off + 20)?,
        min_transfer_secs: rd_u32(region, off + 24)?,
        transfer_type: rd_u8(region, off + 28)?,
    })
}

#[cfg(test)]
mod helper_tests {
    use super::*;
    #[test]
    fn reads_le_at_offset() {
        let b = [0u8, 0, 0x01, 0x00, 0x00, 0x00]; // u32 = 1 at offset 2
        assert_eq!(rd_u32(&b, 2).unwrap(), 1);
        assert!(rd_u32(&b, 4).is_err()); // would read past end
    }

    #[test]
    fn soa_decode_reads_each_column() {
        let rows = [
            StopTime {
                dep_secs: 25_200,
                arr_diff: -1,
                stop_idx: 7,
                stop_seq: 1,
            },
            StopTime {
                dep_secs: 25_800,
                arr_diff: 300,
                stop_idx: 42,
                stop_seq: 2,
            },
        ];
        let n = rows.len();
        let mut soa = alloc::vec![0u8; 12 * n];
        for (i, r) in rows.iter().enumerate() {
            soa[4 * i..4 * i + 4].copy_from_slice(&r.dep_secs.to_le_bytes());
            soa[4 * n + 4 * i..4 * n + 4 * i + 4].copy_from_slice(&r.stop_idx.to_le_bytes());
            soa[8 * n + 2 * i..8 * n + 2 * i + 2].copy_from_slice(&r.arr_diff.to_le_bytes());
            soa[10 * n + 2 * i..10 * n + 2 * i + 2].copy_from_slice(&r.stop_seq.to_le_bytes());
        }
        for (i, want) in rows.iter().enumerate() {
            assert_eq!(&decode_stop_time_soa(&soa, i, n).unwrap(), want, "row {i}");
            assert_eq!(
                decode_stop_time_soa_dep(&soa, i).unwrap(),
                want.dep_secs,
                "dep row {i}"
            );
        }
    }
}
