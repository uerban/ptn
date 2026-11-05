use super::parse_hms;
use crate::error::{Error, Result};
use crate::layout::{Layout, Region, STOP_TIME_ROW_BYTES};
use crate::pass1::Pass1Result;
use crate::writer::WriteRegion;
use std::io::{BufRead, BufReader};
use std::path::Path;

/// Per-row layout (12 B): same as `stop_times_csv.rs`. Keeping the layout in
/// one place would be cleaner, but a `&[u8]` row writer would have to take a
/// trait object or generic — both add cycles that the bench measures.
///
/// Row placement is trip-grouped, identical to the csv variant: each row's
/// `trip_id` resolves to a sorted trip index `ti`, and the row lands at
/// `write_cursor[ti]` (which then advances). `write_cursor` is a clone of
/// `compute_trip_starts(p1)` owned by the caller and persists across feeds.
///
/// `boarding` mirrors the csv variant: a caller-owned `0x50`-prefilled buffer
/// of length `num_stop_times` carrying one packed boarding byte per stop_time
/// row at its global index (`off / stride`). See `stop_times_csv.rs` for the
/// pack formula and per-field defaults.
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
    let f = std::fs::File::open(path)?;
    let mut reader = BufReader::new(f);

    let mut header_line = String::new();
    reader.read_line(&mut header_line)?;
    let header_str = header_line
        .trim_end_matches(['\r', '\n'])
        .trim_start_matches('\u{feff}');
    let mut trip_col: Option<usize> = None;
    let mut dep_col: Option<usize> = None;
    let mut arr_col: Option<usize> = None;
    let mut stop_col: Option<usize> = None;
    let mut seq_col: Option<usize> = None;
    let mut pickup_col: Option<usize> = None;
    let mut dropoff_col: Option<usize> = None;
    let mut cont_pickup_col: Option<usize> = None;
    let mut cont_dropoff_col: Option<usize> = None;
    for (i, name) in header_str.split(',').enumerate() {
        match name {
            "trip_id" => trip_col = Some(i),
            "departure_time" => dep_col = Some(i),
            "arrival_time" => arr_col = Some(i),
            "stop_id" => stop_col = Some(i),
            "stop_sequence" => seq_col = Some(i),
            "pickup_type" => pickup_col = Some(i),
            "drop_off_type" => dropoff_col = Some(i),
            "continuous_pickup" => cont_pickup_col = Some(i),
            "continuous_drop_off" => cont_dropoff_col = Some(i),
            _ => {}
        }
    }
    let trip_col = trip_col
        .ok_or_else(|| Error::MalformedGtfs("hand-rolled: stop_times missing trip_id".into()))?;
    let dep_col = dep_col.ok_or_else(|| {
        Error::MalformedGtfs("hand-rolled: stop_times missing departure_time".into())
    })?;
    let arr_col = arr_col.ok_or_else(|| {
        Error::MalformedGtfs("hand-rolled: stop_times missing arrival_time".into())
    })?;
    let stop_col = stop_col
        .ok_or_else(|| Error::MalformedGtfs("hand-rolled: stop_times missing stop_id".into()))?;
    let seq_col = seq_col.ok_or_else(|| {
        Error::MalformedGtfs("hand-rolled: stop_times missing stop_sequence".into())
    })?;
    // `max_col` must also cover any present optional boarding columns so the
    // split loop below doesn't `break` before reaching them.
    let max_col = [trip_col, dep_col, arr_col, stop_col, seq_col]
        .into_iter()
        .chain(
            [pickup_col, dropoff_col, cont_pickup_col, cont_dropoff_col]
                .into_iter()
                .flatten(),
        )
        .max()
        .unwrap();

    let mut buf = Vec::with_capacity(256);
    let mut written: usize = 0;
    let stride = STOP_TIME_ROW_BYTES as usize;
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf)?;
        if n == 0 {
            break;
        }
        let mut line: &[u8] = &buf[..n];
        while matches!(line.last(), Some(b'\r' | b'\n')) {
            line = &line[..line.len() - 1];
        }
        if line.is_empty() {
            continue;
        }

        // Naive comma split — does NOT handle RFC-4180 quoted fields. GTFS
        // discourages embedded commas in stop_times columns (HMS / integer /
        // id), so it's safe HERE. For columns like stop_name, use `csv`.
        let mut trip_bytes: &[u8] = &[];
        let mut dep_bytes: &[u8] = &[];
        let mut arr_bytes: &[u8] = &[];
        let mut stop_bytes: &[u8] = &[];
        let mut seq_bytes: &[u8] = &[];
        let mut pickup_bytes: &[u8] = &[];
        let mut dropoff_bytes: &[u8] = &[];
        let mut cont_pickup_bytes: &[u8] = &[];
        let mut cont_dropoff_bytes: &[u8] = &[];
        let mut field_start = 0usize;
        let mut field_idx = 0usize;
        // Snapshot one field into the appropriate target by column index.
        macro_rules! capture {
            ($field:expr) => {{
                let field = $field;
                if field_idx == trip_col {
                    trip_bytes = field;
                }
                if field_idx == dep_col {
                    dep_bytes = field;
                }
                if field_idx == arr_col {
                    arr_bytes = field;
                }
                if field_idx == stop_col {
                    stop_bytes = field;
                }
                if field_idx == seq_col {
                    seq_bytes = field;
                }
                if Some(field_idx) == pickup_col {
                    pickup_bytes = field;
                }
                if Some(field_idx) == dropoff_col {
                    dropoff_bytes = field;
                }
                if Some(field_idx) == cont_pickup_col {
                    cont_pickup_bytes = field;
                }
                if Some(field_idx) == cont_dropoff_col {
                    cont_dropoff_bytes = field;
                }
            }};
        }
        for (i, b) in line.iter().enumerate() {
            if *b == b',' {
                capture!(&line[field_start..i]);
                field_start = i + 1;
                field_idx += 1;
                if field_idx > max_col {
                    break;
                }
            }
        }
        if field_idx <= max_col {
            capture!(&line[field_start..]);
            field_idx += 1;
        }
        if field_idx <= max_col {
            return Err(Error::MalformedGtfs("hand-rolled: row too short".into()));
        }

        let dep_secs = if dep_bytes.is_empty() {
            u32::MAX
        } else {
            parse_hms(dep_bytes)?
        };
        let arr_secs_opt = if arr_bytes.is_empty() {
            None
        } else {
            Some(parse_hms(arr_bytes)?)
        };
        let arr_diff: i16 = match (arr_secs_opt, dep_secs) {
            (Some(arr), dep) if dep != u32::MAX => {
                let diff = arr as i64 - dep as i64;
                // Clamp to i16 range — same policy as the stop_sequence clamp
                // below; see the matching comment in stop_times_csv.rs.
                diff.clamp(i16::MIN as i64, i16::MAX as i64) as i16
            }
            _ => 0,
        };
        let stop_str = std::str::from_utf8(stop_bytes)
            .map_err(|_| Error::MalformedGtfs("hand-rolled: non-utf8 stop_id".into()))?;
        let stop_idx = p1
            .stops
            .lookup(stop_str)
            .ok_or_else(|| Error::MalformedGtfs(format!("unknown stop_id {stop_str}")))?;
        let seq_str = std::str::from_utf8(seq_bytes)
            .map_err(|_| Error::MalformedGtfs("hand-rolled: non-utf8 stop_sequence".into()))?;
        let seq_u32: u32 = seq_str
            .parse()
            .map_err(|_| Error::MalformedGtfs(format!("stop_sequence parse: {seq_str}")))?;
        let seq = u16::try_from(seq_u32).unwrap_or(u16::MAX);

        // Resolve the sorted (post-finalize) trip index and write into the
        // row slot reserved for this trip. A row referencing an unknown trip
        // is malformed GTFS — error rather than silently misattribute.
        let trip_str = std::str::from_utf8(trip_bytes)
            .map_err(|_| Error::MalformedGtfs("hand-rolled: non-utf8 trip_id".into()))?;
        let ti = p1
            .trips
            .lookup(trip_str)
            .ok_or_else(|| Error::MalformedGtfs(format!("unknown trip_id {trip_str}")))?
            as usize;

        let off = write_cursor[ti] as usize * stride;
        if off + stride > region.len() {
            return Err(Error::MalformedGtfs(
                "hand-rolled: row count exceeded layout".into(),
            ));
        }
        region[off..off + 4].copy_from_slice(&dep_secs.to_le_bytes());
        region[off + 4..off + 6].copy_from_slice(&arr_diff.to_le_bytes());
        region[off + 6..off + 10].copy_from_slice(&stop_idx.to_le_bytes());
        region[off + 10..off + 12].copy_from_slice(&seq.to_le_bytes());

        // Pack the four GTFS boarding fields into the parallel byte at this
        // row's global index. Defaults: pickup/drop_off ⇒ 0, continuous_* ⇒ 1.
        // Same pack formula + clamp-to-default policy as the csv variant.
        let pu = boarding_field(pickup_bytes, 0);
        let du = boarding_field(dropoff_bytes, 0);
        let cp = boarding_field(cont_pickup_bytes, 1);
        let cd = boarding_field(cont_dropoff_bytes, 1);
        boarding[off / stride] = (cd << 6) | (cp << 4) | (du << 2) | pu;

        write_cursor[ti] += 1;
        written += 1;
    }
    Ok(written)
}

/// Parse a 2-bit GTFS boarding field from an already-extracted byte slice.
///
/// Returns `default` when the slice is empty (absent column / blank cell) or
/// the value is outside the valid 0..=3 range; otherwise the parsed value.
/// Mirrors `stop_times_csv::boarding_field` (clamp-to-default policy).
///
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
fn boarding_field(bytes: &[u8], default: u8) -> u8 {
    if bytes.is_empty() {
        return default;
    }
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|s| s.trim().parse::<u8>().ok())
        .filter(|&v| v <= 3)
        .unwrap_or(default)
}
