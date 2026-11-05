use super::parse_hms;
use crate::error::{Error, Result};
use crate::layout::{Layout, Region, STOP_TIME_ROW_BYTES};
use crate::pass1::Pass1Result;
use crate::writer::WriteRegion;
use std::path::Path;

/// Per-row layout (12 B):
///   [0..4]   dep_secs  (u32 LE) — `u32::MAX` for missing `departure_time`
///   [4..6]   arr_diff  (i16 LE) — arrival_secs - dep_secs; 0 when equal or
///                                 when either field is missing
///   [6..10]  stop_idx  (u32 LE) — post-finalize stops interner index
///   [10..12] stop_seq  (u16 LE) — clamped to u16::MAX on overflow
///
/// Rows are written into their trip's reserved range, NOT in feed order: each
/// row's `trip_id` is looked up to its sorted (post-finalize) trip index `ti`
/// and the row is placed at `write_cursor[ti]`, which then advances by one.
/// `write_cursor` starts as a clone of `compute_trip_starts(p1)` and persists
/// across feeds (it is owned by the caller and threaded by `&mut`), so a
/// multi-feed union fills each trip's contiguous range exactly. Returns the
/// number of rows written by this call.
///
/// `boarding` is a parallel, caller-owned buffer of length `num_stop_times`
/// (== the StopTimes region row count) carrying one packed boarding byte per
/// stop_time row, in the SAME global-row order as the StopTimes region
/// (`boarding[off / stride]`). Each byte packs the four GTFS boarding fields
/// from `stop_times.txt` — `pickup_type`, `drop_off_type`, `continuous_pickup`,
/// `continuous_drop_off` — 2 bits each:
///   `(continuous_drop_off << 6) | (continuous_pickup << 4) | (drop_off_type << 2) | pickup_type`.
/// Defaults when a column is absent / a cell is blank / a value is out of the
/// 0..=3 range: `pickup_type`/`drop_off_type` ⇒ 0, `continuous_*` ⇒ 1, so the
/// default packed byte is `0x50`. The caller pre-fills `boarding` with `0x50`
/// and threads the same `&mut [u8]` across all feeds so the slot is left at the
/// default for any row this pass never reaches.
///
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
pub fn parse_and_write_stop_times<W: WriteRegion>(
    path: &Path,
    layout: &Layout,
    p1: &Pass1Result,
    writer: &mut W,
    write_cursor: &mut [u32],
    boarding: &mut [u8],
) -> Result<usize> {
    let region = writer.region_slice(layout, Region::StopTimes);
    let mut written: usize = 0;
    let stride = STOP_TIME_ROW_BYTES as usize;

    let file = crate::csv_open::open_csv_skip_bom(path)?;
    let mut rdr = csv::Reader::from_reader(file);
    let headers = rdr.headers()?.clone();
    let trip_id_col = headers
        .iter()
        .position(|h| h == "trip_id")
        .ok_or_else(|| Error::MalformedGtfs("stop_times missing trip_id".into()))?;
    let dep_idx = headers
        .iter()
        .position(|h| h == "departure_time")
        .ok_or_else(|| Error::MalformedGtfs("stop_times missing departure_time".into()))?;
    let arr_idx = headers
        .iter()
        .position(|h| h == "arrival_time")
        .ok_or_else(|| Error::MalformedGtfs("stop_times missing arrival_time".into()))?;
    let stop_id_col = headers
        .iter()
        .position(|h| h == "stop_id")
        .ok_or_else(|| Error::MalformedGtfs("stop_times missing stop_id".into()))?;
    let seq_idx = headers
        .iter()
        .position(|h| h == "stop_sequence")
        .ok_or_else(|| Error::MalformedGtfs("stop_times missing stop_sequence".into()))?;

    // Optional GTFS boarding columns (any may be absent — `Option<usize>`).
    let pickup_col = headers.iter().position(|h| h == "pickup_type");
    let dropoff_col = headers.iter().position(|h| h == "drop_off_type");
    let cont_pickup_col = headers.iter().position(|h| h == "continuous_pickup");
    let cont_dropoff_col = headers.iter().position(|h| h == "continuous_drop_off");

    let mut record = csv::ByteRecord::new();
    while rdr.read_byte_record(&mut record)? {
        let trip_raw = record
            .get(trip_id_col)
            .ok_or_else(|| Error::MalformedGtfs("row missing trip_id".into()))?;
        let dep_raw = record
            .get(dep_idx)
            .ok_or_else(|| Error::MalformedGtfs("row missing departure_time".into()))?;
        let arr_raw = record
            .get(arr_idx)
            .ok_or_else(|| Error::MalformedGtfs("row missing arrival_time".into()))?;
        let stop_raw = record
            .get(stop_id_col)
            .ok_or_else(|| Error::MalformedGtfs("row missing stop_id".into()))?;
        let seq_raw = record
            .get(seq_idx)
            .ok_or_else(|| Error::MalformedGtfs("row missing stop_sequence".into()))?;

        let dep_secs = if dep_raw.is_empty() {
            u32::MAX
        } else {
            parse_hms(dep_raw)?
        };
        let arr_secs_opt = if arr_raw.is_empty() {
            None
        } else {
            Some(parse_hms(arr_raw)?)
        };
        let arr_diff: i16 = match (arr_secs_opt, dep_secs) {
            (Some(arr), dep) if dep != u32::MAX => {
                let diff = arr as i64 - dep as i64;
                // Clamp to i16 range. Same policy as the stop_sequence u16 clamp
                // below: a few out-of-range rows (multi-hour sleeper/ferry
                // layovers crossing the ±9h6m window) corrupt the affected
                // trips but the bench measurement remains usable.
                diff.clamp(i16::MIN as i64, i16::MAX as i64) as i16
            }
            _ => 0,
        };
        let stop_str = std::str::from_utf8(stop_raw)
            .map_err(|_| Error::MalformedGtfs("non-utf8 stop_id".into()))?;
        let stop_idx = p1
            .stops
            .lookup(stop_str)
            .ok_or_else(|| Error::MalformedGtfs(format!("unknown stop_id {stop_str}")))?;
        let seq_str = std::str::from_utf8(seq_raw)
            .map_err(|_| Error::MalformedGtfs("non-utf8 stop_sequence".into()))?;
        let seq_u32: u32 = seq_str
            .parse()
            .map_err(|_| Error::MalformedGtfs(format!("stop_sequence parse: {seq_str}")))?;
        // GTFS allows arbitrarily large stop_sequence values; the wire format
        // clamps to u16 (sequences over 65k are vanishingly rare in real feeds
        // and we'd rather corrupt one trip than abort the bench).
        let seq = u16::try_from(seq_u32).unwrap_or(u16::MAX);

        // Resolve the sorted (post-finalize) trip index and write into the
        // row slot reserved for this trip. A row referencing an unknown trip
        // is malformed GTFS — error rather than silently misattribute.
        let trip_str = std::str::from_utf8(trip_raw)
            .map_err(|_| Error::MalformedGtfs("non-utf8 trip_id".into()))?;
        let ti = p1
            .trips
            .lookup(trip_str)
            .ok_or_else(|| Error::MalformedGtfs(format!("unknown trip_id {trip_str}")))?
            as usize;

        let off = write_cursor[ti] as usize * stride;
        if off + stride > region.len() {
            return Err(Error::MalformedGtfs(
                "stop_times row count exceeded layout".into(),
            ));
        }
        region[off..off + 4].copy_from_slice(&dep_secs.to_le_bytes());
        region[off + 4..off + 6].copy_from_slice(&arr_diff.to_le_bytes());
        region[off + 6..off + 10].copy_from_slice(&stop_idx.to_le_bytes());
        region[off + 10..off + 12].copy_from_slice(&seq.to_le_bytes());

        // Pack the four GTFS boarding fields into the parallel byte for this
        // row's GLOBAL stop_time index (`off / stride`, == write_cursor before
        // the advance). Defaults: pickup/drop_off ⇒ 0, continuous_* ⇒ 1.
        let pu = boarding_field(&record, pickup_col, 0);
        let du = boarding_field(&record, dropoff_col, 0);
        let cp = boarding_field(&record, cont_pickup_col, 1);
        let cd = boarding_field(&record, cont_dropoff_col, 1);
        boarding[off / stride] = (cd << 6) | (cp << 4) | (du << 2) | pu;

        write_cursor[ti] += 1;
        written += 1;
    }
    Ok(written)
}

/// Parse a 2-bit GTFS boarding field (`pickup_type` / `drop_off_type` /
/// `continuous_pickup` / `continuous_drop_off`) from a stop_times row.
///
/// Returns `default` when the column is absent, the cell is blank, or the
/// value is outside the valid 0..=3 range (clamp-to-default policy, matching
/// the bench's "corrupt one cell rather than abort" stance elsewhere in this
/// file). Otherwise returns the parsed 0..=3 value.
///
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
fn boarding_field(rec: &csv::ByteRecord, col: Option<usize>, default: u8) -> u8 {
    match col.and_then(|c| rec.get(c)) {
        Some(b) if !b.is_empty() => std::str::from_utf8(b)
            .ok()
            .and_then(|s| s.trim().parse::<u8>().ok())
            .filter(|&v| v <= 3)
            .unwrap_or(default),
        _ => default,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::Layout;
    use crate::pass1::{compute_trip_starts, run_pass1};

    fn rec(fields: &[&str]) -> csv::ByteRecord {
        csv::ByteRecord::from(fields.to_vec())
    }

    #[test]
    fn boarding_field_parses_present_in_range() {
        let r = rec(&["1", "2", "3", "0"]);
        assert_eq!(boarding_field(&r, Some(0), 0), 1);
        assert_eq!(boarding_field(&r, Some(1), 0), 2);
        assert_eq!(boarding_field(&r, Some(2), 1), 3);
        assert_eq!(boarding_field(&r, Some(3), 1), 0);
    }

    #[test]
    fn boarding_field_defaults_on_absent_blank_or_out_of_range() {
        let r = rec(&["", "  ", "4", "99", "x"]);
        // Absent column ⇒ default.
        assert_eq!(boarding_field(&r, None, 1), 1);
        assert_eq!(boarding_field(&r, None, 0), 0);
        // Blank / whitespace-only cell ⇒ default.
        assert_eq!(boarding_field(&r, Some(0), 1), 1);
        assert_eq!(boarding_field(&r, Some(1), 0), 0);
        // Out-of-range (>3) ⇒ default; non-numeric ⇒ default.
        assert_eq!(boarding_field(&r, Some(2), 0), 0);
        assert_eq!(boarding_field(&r, Some(3), 1), 1);
        assert_eq!(boarding_field(&r, Some(4), 0), 0);
    }

    /// End-to-end pack over a single-trip feed (so global-row order == feed
    /// order). Header carries `pickup_type` + `drop_off_type` but NOT the
    /// `continuous_*` columns, so continuous bits stay at their default 1.
    #[test]
    fn parse_packs_boarding_bytes_in_global_row_order() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(
            dir.join("agency.txt"),
            "agency_id,agency_name,agency_url,agency_timezone\nA,A,https://example.com,UTC\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("stops.txt"),
            "stop_id,stop_name,stop_lat,stop_lon\nS1,A,0,0\nS2,B,0,0\nS3,C,0,0\nS4,D,0,0\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("routes.txt"),
            "route_id,agency_id,route_short_name,route_type\nR1,A,1,3\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("trips.txt"),
            "route_id,service_id,trip_id\nR1,S,T1\n",
        )
        .unwrap();
        // Single trip T1, 4 rows. No `continuous_*` columns in the header.
        //   row 0: pickup_type=1            ⇒ 0x51
        //   row 1: (blank pickup/drop_off)  ⇒ 0x50 (default)
        //   row 2: pickup_type=2            ⇒ 0x52
        //   row 3: drop_off_type=1          ⇒ 0x54
        std::fs::write(
            dir.join("stop_times.txt"),
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\n\
             T1,07:00:00,07:00:00,S1,1,1,0\n\
             T1,07:05:00,07:05:00,S2,2,,\n\
             T1,07:10:00,07:10:00,S3,3,2,0\n\
             T1,07:15:00,07:15:00,S4,4,0,1\n",
        )
        .unwrap();

        let p1 = run_pass1(dir).unwrap();
        assert_eq!(p1.total_stop_times, 4);
        let layout = Layout::compute(
            p1.stops.len() as u64,
            p1.routes.len() as u64,
            p1.trips.len() as u64,
            p1.total_stop_times as u64,
            90,
            2,
            0,
            0,
        );
        let out = tmp.path().join("p1.bin");
        let mut w = crate::writer::open_writer(&out, layout.total_bytes()).unwrap();
        let mut write_cursor = compute_trip_starts(&p1);
        let mut boarding = vec![0x50u8; p1.total_stop_times as usize];
        let written = parse_and_write_stop_times(
            &dir.join("stop_times.txt"),
            &layout,
            &p1,
            &mut w,
            &mut write_cursor,
            &mut boarding,
        )
        .unwrap();
        assert_eq!(written, 4);
        // continuous_* columns absent ⇒ continuous bits 1 (high nibble 0x50).
        assert_eq!(
            boarding,
            vec![0x51, 0x50, 0x52, 0x54],
            "packed boarding bytes must match per-row pickup/drop_off with default continuous_*"
        );
    }
}
