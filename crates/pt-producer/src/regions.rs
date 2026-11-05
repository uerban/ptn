use crate::csr::route_trips::build_route_trips_csr;
use crate::csr::stop_routes::build_stop_routes_csr;
use crate::error::{Error, Result};
use crate::layout::{Layout, Region, TRANSFER_RECORD_BYTES};
use crate::pass1::{Pass1Result, TransferRow};
use crate::service::bitmask::compute_service_bitmasks;
use crate::writer::WriteRegion;

/// Write `values` little-endian into `dest`. Errors if `dest` is too small.
///
/// Silent truncation here would corrupt the PTB staging file while the RSS
/// number still looked sensible — see `flush_mid_pass_regions` for the
/// rationale behind hard-erroring on overflow.
pub fn write_u32_slice(dest: &mut [u8], values: &[u32]) -> Result<()> {
    let need = values.len() * 4;
    if dest.len() < need {
        return Err(Error::Config(format!(
            "write_u32_slice: region overflow need={need} have={}",
            dest.len()
        )));
    }
    for (i, v) in values.iter().enumerate() {
        dest[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
    }
    Ok(())
}

/// Flush the mid-pass artifacts (service bitmasks + both CSRs) into the
/// PTB staging regions backed by `w`. Called between Pass 1 and Pass 2 — the
/// bitmasks and CSRs are independent of `stop_times.txt` and would
/// otherwise sit in RAM until Pass 2 finished, double-counting against
/// peak RSS.
///
/// Overflow is a hard error: a truncated CSR or bitmask region produces
/// a PTB that reads cleanly but routes wrong, and the bench would still
/// report a passing peak/steady RSS.
pub fn flush_mid_pass_regions<W: WriteRegion>(
    w: &mut W,
    layout: &Layout,
    p1: &Pass1Result,
    window_days: u16,
) -> Result<()> {
    let num_routes = p1.routes.len();
    let num_stops = p1.stops.len();
    let (rt_offsets, rt_neighbors) = build_route_trips_csr(&p1.trips_attrs, num_routes)?;
    let (sr_offsets, sr_neighbors) =
        build_stop_routes_csr(&p1.trip_stop_triples, &p1.trips_attrs, num_stops)?;
    // The bitmask stride MUST match the layout's `ServiceBitmasks` region (sized
    // from the SAME `window_days` in `Layout::compute`) — both derive the stride
    // via `pt_core::bytes_per_service`, so they cannot disagree (the I6 invariant).
    let bitmasks = compute_service_bitmasks(&p1.service_attrs, p1.feed_start_date, window_days)?;

    {
        let bm = w.region_slice(layout, Region::ServiceBitmasks);
        let mut cursor = 0usize;
        for mask in &bitmasks {
            let end = cursor + mask.len();
            if end > bm.len() {
                return Err(Error::Config(format!(
                    "bitmask region overflow cursor={cursor} need={} have={}",
                    mask.len(),
                    bm.len()
                )));
            }
            bm[cursor..end].copy_from_slice(mask);
            cursor = end;
        }
    }

    {
        let csr = w.region_slice(layout, Region::Csr);
        // Layout: route_trips_offsets, route_trips_neighbors,
        // stop_routes_offsets, stop_routes_neighbors — packed back-to-back.
        let mut cursor = 0usize;
        for slice in [
            &rt_offsets[..],
            &rt_neighbors[..],
            &sr_offsets[..],
            &sr_neighbors[..],
        ] {
            let need = slice.len() * 4;
            if cursor + need > csr.len() {
                return Err(Error::Config(format!(
                    "csr region overflow cursor={cursor} need={need} have={}",
                    csr.len()
                )));
            }
            write_u32_slice(&mut csr[cursor..cursor + need], slice)?;
            cursor += need;
        }
    }

    Ok(())
}

/// Write the temporary Transfers region: one fixed 32-byte record per GTFS
/// `transfers.txt` rule, in `rows` order. Layout (all LE):
///   fromStopIdx u32@0 | toStopIdx u32@4 | fromRouteIdx u32@8 | toRouteIdx u32@12 |
///   fromTripIdx u32@16 | toTripIdx u32@20 | minTransferSecs u32@24 |
///   transferType u8@28 | reserved[3]@29 (zero).
/// `0xFFFFFFFF` = absent (the `TransferRow` already carries the sentinel).
///
/// Overflow is a hard error (consistent with `flush_mid_pass_regions`): a
/// truncated Transfers region would read cleanly but carry wrong rules.
/// Empty `rows` → no writes (the region length is 0, the empty-feed case).
///
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
pub fn write_transfers_region<W: WriteRegion>(
    w: &mut W,
    layout: &Layout,
    rows: &[TransferRow],
) -> Result<()> {
    let region = w.region_slice(layout, Region::Transfers);
    let stride = TRANSFER_RECORD_BYTES as usize;
    let need = rows.len() * stride;
    if need > region.len() {
        return Err(Error::Config(format!(
            "transfers region overflow need={need} have={}",
            region.len()
        )));
    }
    for (i, row) in rows.iter().enumerate() {
        let o = i * stride;
        region[o..o + 4].copy_from_slice(&row.from_stop_idx.to_le_bytes());
        region[o + 4..o + 8].copy_from_slice(&row.to_stop_idx.to_le_bytes());
        region[o + 8..o + 12].copy_from_slice(&row.from_route_idx.to_le_bytes());
        region[o + 12..o + 16].copy_from_slice(&row.to_route_idx.to_le_bytes());
        region[o + 16..o + 20].copy_from_slice(&row.from_trip_idx.to_le_bytes());
        region[o + 20..o + 24].copy_from_slice(&row.to_trip_idx.to_le_bytes());
        region[o + 24..o + 28].copy_from_slice(&row.min_transfer_secs.to_le_bytes());
        region[o + 28] = row.transfer_type;
        // reserved [o+29..o+32] left zero (writer zero-fills the region).
    }
    Ok(())
}
