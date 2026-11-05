//! Parse GTFS `transfers.txt` into resolved transfer rows.
//!
//! Runs AFTER the stop/route/trip interners are finalized (so every id
//! resolves to its post-finalize ordinal — the SAME index the PTB record
//! stores). Optional ids (`from_route_id`, `to_route_id`, `from_trip_id`,
//! `to_trip_id`) and `min_transfer_time` collapse to the [`ABSENT`] sentinel
//! (`0xFFFFFFFF`) when blank/omitted, mirroring the network parser's tri-state.
//! `transfer_type` is the GTFS `transfer_type` (0–5; blank → 0).
//!
//! A row whose `from_stop_id` or `to_stop_id` is unknown (not in the stops
//! interner) is DROPPED and counted — the sibling-file convention used by the
//! rest of Pass 1 (a transfer referencing a non-existent stop is unroutable).
//!
//! Empty or missing `transfers.txt` → 0 rows (the common case; the file is an
//! optional GTFS file).
//!
//! GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt

use crate::error::Result;
use crate::pass1::identity::InternTable;
use crate::pass1::Pass1Result;
use std::path::Path;

/// Absent optional index / min-transfer-time sentinel in the PTB Transfers record.
pub const ABSENT: u32 = 0xFFFF_FFFF;

/// One resolved GTFS `transfers.txt` rule, indices into the finalized
/// stop/route/trip interners. Absent optional scope / min time → [`ABSENT`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransferRow {
    pub from_stop_idx: u32,
    pub to_stop_idx: u32,
    pub from_route_idx: u32,
    pub to_route_idx: u32,
    pub from_trip_idx: u32,
    pub to_trip_idx: u32,
    pub min_transfer_secs: u32,
    pub transfer_type: u8,
}

/// Result of parsing `transfers.txt`: the resolved rows plus a count of rows
/// dropped because their `from`/`to` stop id was unknown.
#[derive(Debug, Default)]
pub struct TransfersResult {
    pub rows: Vec<TransferRow>,
    pub dropped_unknown_stop: usize,
}

/// Parse `transfers.txt` for a single feed directory, resolving ids against the
/// finalized interners in `p1`. Missing file → empty result (transfers.txt is
/// optional). Multiple feeds: call once per `feed_dir` and concatenate the
/// `rows` (the indices are global post-finalize ordinals, so concatenation is
/// sound).
pub fn parse_transfers(feed_dir: &Path, p1: &Pass1Result) -> Result<TransfersResult> {
    let path = feed_dir.join("transfers.txt");
    if !path.exists() {
        return Ok(TransfersResult::default());
    }
    let file = crate::csv_open::open_csv_skip_bom(&path)?;
    let mut rdr = csv::Reader::from_reader(file);
    let headers = rdr.headers()?.clone();

    // transfers.txt columns. from/to_stop_id are required by GTFS; absent
    // columns ⇒ every row drops (treated as unknown stop). The optional scope
    // and min-time columns may be missing entirely.
    let from_stop = headers.iter().position(|h| h == "from_stop_id");
    let to_stop = headers.iter().position(|h| h == "to_stop_id");
    let from_route = headers.iter().position(|h| h == "from_route_id");
    let to_route = headers.iter().position(|h| h == "to_route_id");
    let from_trip = headers.iter().position(|h| h == "from_trip_id");
    let to_trip = headers.iter().position(|h| h == "to_trip_id");
    let transfer_type = headers.iter().position(|h| h == "transfer_type");
    let min_time = headers.iter().position(|h| h == "min_transfer_time");

    let mut out = TransfersResult::default();
    let mut record = csv::StringRecord::new();
    while rdr.read_record(&mut record)? {
        // Required stop ids: drop (and count) if either is missing/unknown.
        let from_stop_idx = match resolve_required(&record, from_stop, &p1.stops) {
            Some(i) => i,
            None => {
                out.dropped_unknown_stop += 1;
                continue;
            }
        };
        let to_stop_idx = match resolve_required(&record, to_stop, &p1.stops) {
            Some(i) => i,
            None => {
                out.dropped_unknown_stop += 1;
                continue;
            }
        };
        out.rows.push(TransferRow {
            from_stop_idx,
            to_stop_idx,
            // Optional scope: unknown id resolves to ABSENT (not a drop) so a
            // route/trip-scoped rule whose stop endpoints are valid still
            // carries; S2/S3 decide how to treat an unresolved scope id.
            from_route_idx: resolve_optional(&record, from_route, &p1.routes),
            to_route_idx: resolve_optional(&record, to_route, &p1.routes),
            from_trip_idx: resolve_optional(&record, from_trip, &p1.trips),
            to_trip_idx: resolve_optional(&record, to_trip, &p1.trips),
            min_transfer_secs: parse_u32_or_absent(&record, min_time),
            transfer_type: parse_transfer_type(&record, transfer_type),
        });
    }
    Ok(out)
}

/// Resolve a required id column. Returns `None` if the column is absent, the
/// field is blank, or the id is unknown to the interner (caller drops + counts).
fn resolve_required(
    record: &csv::StringRecord,
    idx: Option<usize>,
    table: &InternTable<String>,
) -> Option<u32> {
    let v = idx.and_then(|i| record.get(i))?.trim();
    if v.is_empty() {
        return None;
    }
    table.lookup(v)
}

/// Resolve an optional scope id column. Blank/absent/unknown → [`ABSENT`].
fn resolve_optional(
    record: &csv::StringRecord,
    idx: Option<usize>,
    table: &InternTable<String>,
) -> u32 {
    match idx.and_then(|i| record.get(i)).map(str::trim) {
        Some(v) if !v.is_empty() => table.lookup(v).unwrap_or(ABSENT),
        _ => ABSENT,
    }
}

/// Parse `min_transfer_time` (non-negative integer seconds). Blank/absent/
/// malformed → [`ABSENT`].
fn parse_u32_or_absent(record: &csv::StringRecord, idx: Option<usize>) -> u32 {
    idx.and_then(|i| record.get(i))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(ABSENT)
}

/// Parse `transfer_type`. Blank/absent/unparseable/`>255` → 0 (recommended
/// transfer point), matching the network parser. Values `6..=255` are carried
/// as-is (no range validation in S0; the producer trusts feed validity). Note:
/// this does NOT truncate to the low byte — `>255` fails `u8::parse` → 0.
fn parse_transfer_type(record: &csv::StringRecord, idx: Option<usize>) -> u8 {
    idx.and_then(|i| record.get(i))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse::<u8>().ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pass1::run_pass1;
    use std::io::Write;

    fn write_feed(dir: &Path, transfers: Option<&str>) {
        // Minimal valid GTFS the existing Pass-1 scan accepts: 2 stops, 1 route,
        // 1 service, 1 trip, 2 stop_times.
        std::fs::write(
            dir.join("stops.txt"),
            "stop_id,stop_name,stop_lat,stop_lon\nS1,Stop One,54.6,25.2\nS2,Stop Two,54.7,25.3\n",
        )
        .unwrap();
        std::fs::write(dir.join("routes.txt"), "route_id,route_type\nR1,3\n").unwrap();
        std::fs::write(
            dir.join("calendar.txt"),
            "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n\
             WD,1,1,1,1,1,0,0,20260501,20260801\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("trips.txt"),
            "route_id,service_id,trip_id\nR1,WD,T1\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("stop_times.txt"),
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
             T1,07:00:00,07:00:00,S1,1\n\
             T1,07:05:00,07:05:00,S2,2\n",
        )
        .unwrap();
        if let Some(t) = transfers {
            let mut f = std::fs::File::create(dir.join("transfers.txt")).unwrap();
            f.write_all(t.as_bytes()).unwrap();
        }
    }

    #[test]
    fn missing_transfers_file_yields_empty() {
        let tmp = tempfile::tempdir().unwrap();
        write_feed(tmp.path(), None);
        let p1 = run_pass1(tmp.path()).unwrap();
        let res = parse_transfers(tmp.path(), &p1).unwrap();
        assert_eq!(res.rows.len(), 0);
        assert_eq!(res.dropped_unknown_stop, 0);
    }

    #[test]
    fn resolves_ids_optional_absent_and_min_time() {
        let tmp = tempfile::tempdir().unwrap();
        write_feed(
            tmp.path(),
            Some(
                "from_stop_id,to_stop_id,transfer_type,min_transfer_time\n\
                 S1,S2,3,\n\
                 S2,S1,2,180\n",
            ),
        );
        let p1 = run_pass1(tmp.path()).unwrap();
        // Resolve the post-finalize ordinals (sorted: S1=0, S2=1).
        let s1 = p1.stops.lookup("S1").unwrap();
        let s2 = p1.stops.lookup("S2").unwrap();
        let res = parse_transfers(tmp.path(), &p1).unwrap();
        assert_eq!(res.dropped_unknown_stop, 0);
        assert_eq!(res.rows.len(), 2);
        assert_eq!(
            res.rows[0],
            TransferRow {
                from_stop_idx: s1,
                to_stop_idx: s2,
                from_route_idx: ABSENT,
                to_route_idx: ABSENT,
                from_trip_idx: ABSENT,
                to_trip_idx: ABSENT,
                min_transfer_secs: ABSENT,
                transfer_type: 3,
            }
        );
        assert_eq!(res.rows[1].min_transfer_secs, 180);
        assert_eq!(res.rows[1].transfer_type, 2);
    }

    #[test]
    fn carries_route_and_trip_scope() {
        let tmp = tempfile::tempdir().unwrap();
        write_feed(
            tmp.path(),
            Some(
                "from_stop_id,to_stop_id,from_route_id,to_route_id,from_trip_id,to_trip_id,transfer_type\n\
                 S1,S2,R1,R1,T1,T1,4\n",
            ),
        );
        let p1 = run_pass1(tmp.path()).unwrap();
        let r1 = p1.routes.lookup("R1").unwrap();
        let t1 = p1.trips.lookup("T1").unwrap();
        let res = parse_transfers(tmp.path(), &p1).unwrap();
        assert_eq!(res.rows.len(), 1);
        let row = res.rows[0];
        assert_eq!(row.from_route_idx, r1);
        assert_eq!(row.to_route_idx, r1);
        assert_eq!(row.from_trip_idx, t1);
        assert_eq!(row.to_trip_idx, t1);
        assert_eq!(row.transfer_type, 4);
    }

    #[test]
    fn drops_and_counts_unknown_stop_rows() {
        let tmp = tempfile::tempdir().unwrap();
        write_feed(
            tmp.path(),
            Some(
                "from_stop_id,to_stop_id,transfer_type\n\
                 S1,S2,0\n\
                 S1,GHOST,0\n\
                 GHOST,S2,0\n",
            ),
        );
        let p1 = run_pass1(tmp.path()).unwrap();
        let res = parse_transfers(tmp.path(), &p1).unwrap();
        assert_eq!(res.rows.len(), 1); // only S1->S2 survives
        assert_eq!(res.dropped_unknown_stop, 2);
    }

    #[test]
    fn blank_transfer_type_defaults_to_zero() {
        let tmp = tempfile::tempdir().unwrap();
        write_feed(
            tmp.path(),
            Some("from_stop_id,to_stop_id,transfer_type\nS1,S2,\n"),
        );
        let p1 = run_pass1(tmp.path()).unwrap();
        let res = parse_transfers(tmp.path(), &p1).unwrap();
        assert_eq!(res.rows[0].transfer_type, 0);
    }
}
