//! Parse GTFS `frequencies.txt` into resolved frequency rows.
//!
//! Runs AFTER the trip interner is finalized (so every `trip_id` resolves to
//! its post-finalize ordinal — the SAME index the PTB record stores). Each row
//! describes a [start_time, end_time) headway window for a frequency-based trip.
//!
//! `end_time` is half-open (EXCLUDED): trips depart at `start_time`,
//! `start_time + headway_secs`, …, up to but NOT including `end_time`. This
//! matches the GTFS spec, which states that the last departure is the largest
//! `start_time + n * headway_secs < end_time`.
//!
//! Times are GTFS seconds-since-midnight, allowing values > 86400 for overnight
//! service (e.g. `24:00:00` = 86400, `25:30:00` = 91800).
//!
//! The following rows are SKIPPED with a counted warning (the feed is not
//! rejected):
//! - `trip_id` is missing, blank, or not present in the trips interner
//! - `headway_secs == 0` (nonsensical) or `> 65535` (overflows the u16 field)
//! - `start_secs >= end_secs` (empty or inverted window)
//! - `start_time` or `end_time` is missing, blank, or unparseable as HH:MM:SS
//! - `exact_times` is present but not in {0, 1} (GTFS allows only those two;
//!   blank/absent defaults to 0)
//!
//! Empty or missing `frequencies.txt` → 0 rows (the file is optional in GTFS).
//!
//! Rows are returned sorted by `(trip_idx, start_secs)`.
//!
//! GTFS reference: https://gtfs.org/documentation/schedule/reference/#frequenciestxt

use crate::error::Result;
use crate::pass1::Pass1Result;
use std::path::Path;

/// One resolved GTFS `frequencies.txt` row.
///
/// Wire format (A3): 16 B/row —
/// `trip_idx u32 | start_secs u32 | end_secs u32 | headway_secs u16 | exact_times u8 | reserved u8`.
/// `end_secs` is half-open (EXCLUDED per GTFS spec).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrequencyRow {
    pub trip_idx: u32,
    pub start_secs: u32,
    pub end_secs: u32,
    pub headway_secs: u16,
    pub exact_times: u8,
}

/// Result of parsing `frequencies.txt`: the resolved rows plus a count of rows
/// dropped because they were invalid (unknown trip, bad headway, inverted window,
/// or unparseable time).
#[derive(Debug, Default)]
pub struct FrequenciesResult {
    pub rows: Vec<FrequencyRow>,
    pub dropped: usize,
}

/// Parse `frequencies.txt` for a single feed directory, resolving `trip_id`
/// against the finalized trips interner in `p1`. Missing file → empty result
/// (`frequencies.txt` is optional in GTFS). Multiple feeds: call once per
/// `feed_dir` and concatenate the `rows` (the indices are global post-finalize
/// ordinals, so concatenation is sound).
///
/// Rows are sorted by `(trip_idx, start_secs)` before returning.
pub fn parse_frequencies(feed_dir: &Path, p1: &Pass1Result) -> Result<FrequenciesResult> {
    let path = feed_dir.join("frequencies.txt");
    if !path.exists() {
        return Ok(FrequenciesResult::default());
    }
    let file = crate::csv_open::open_csv_skip_bom(&path)?;
    let mut rdr = csv::Reader::from_reader(file);
    let headers = rdr.headers()?.clone();

    let col_trip = headers.iter().position(|h| h == "trip_id");
    let col_start = headers.iter().position(|h| h == "start_time");
    let col_end = headers.iter().position(|h| h == "end_time");
    let col_headway = headers.iter().position(|h| h == "headway_secs");
    let col_exact = headers.iter().position(|h| h == "exact_times");

    let mut out = FrequenciesResult::default();
    let mut record = csv::StringRecord::new();
    while rdr.read_record(&mut record)? {
        // trip_id is required; drop if missing/blank/unknown.
        let trip_idx = match col_trip.and_then(|i| record.get(i)).map(str::trim) {
            Some(v) if !v.is_empty() => match p1.trips.lookup(v) {
                Some(idx) => idx,
                None => {
                    eprintln!(
                        "[producer] frequencies: unknown trip_id {:?} — row skipped",
                        v
                    );
                    out.dropped += 1;
                    continue;
                }
            },
            _ => {
                eprintln!("[producer] frequencies: missing/blank trip_id — row skipped");
                out.dropped += 1;
                continue;
            }
        };

        // start_time / end_time: required, must parse as HH:MM:SS (>24h allowed).
        let start_secs = match parse_time_col(&record, col_start) {
            Some(s) => s,
            None => {
                eprintln!("[producer] frequencies: unparseable start_time — row skipped");
                out.dropped += 1;
                continue;
            }
        };
        let end_secs = match parse_time_col(&record, col_end) {
            Some(s) => s,
            None => {
                eprintln!("[producer] frequencies: unparseable end_time — row skipped");
                out.dropped += 1;
                continue;
            }
        };

        // headway_secs: required, must be 1..=65535.
        let headway_secs = match col_headway
            .and_then(|i| record.get(i))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(|s| s.parse::<u32>().ok())
        {
            Some(h) if (1..=65535).contains(&h) => h as u16,
            Some(0) => {
                eprintln!("[producer] frequencies: headway_secs=0 — row skipped");
                out.dropped += 1;
                continue;
            }
            Some(h) => {
                eprintln!(
                    "[producer] frequencies: headway_secs={h} > 65535 (overflows u16) — row skipped"
                );
                out.dropped += 1;
                continue;
            }
            None => {
                eprintln!(
                    "[producer] frequencies: missing/blank/unparseable headway_secs — row skipped"
                );
                out.dropped += 1;
                continue;
            }
        };

        // start_secs must be strictly less than end_secs (half-open window).
        if start_secs >= end_secs {
            eprintln!(
                "[producer] frequencies: start_secs={start_secs} >= end_secs={end_secs} (empty/inverted window) — row skipped"
            );
            out.dropped += 1;
            continue;
        }

        // exact_times: optional, GTFS allows ONLY 0 or 1; blank/absent → 0
        // (the default, frequency-based with inexact times). Any other value
        // (including unparseable) is out of spec and would be ambiguous for
        // Phase B routing — skip-with-counted-warning, same discipline as the
        // other invalid-row arms.
        let exact_times = match col_exact
            .and_then(|i| record.get(i))
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            None => 0, // blank/absent → default 0
            Some(s) => {
                match s.parse::<u8>() {
                    Ok(v @ (0 | 1)) => v,
                    _ => {
                        eprintln!("[producer] frequencies: exact_times={s:?} not in {{0,1}} — row skipped");
                        out.dropped += 1;
                        continue;
                    }
                }
            }
        };

        out.rows.push(FrequencyRow {
            trip_idx,
            start_secs,
            end_secs,
            headway_secs,
            exact_times,
        });
    }

    out.rows.sort_by_key(|r| (r.trip_idx, r.start_secs));
    Ok(out)
}

/// Parse a time column field as GTFS HH:MM:SS (allowing hours > 24 for
/// overnight service). Returns `None` when the column is absent, blank, or
/// the value is not a valid GTFS time string.
fn parse_time_col(record: &csv::StringRecord, idx: Option<usize>) -> Option<u32> {
    let s = idx.and_then(|i| record.get(i))?.trim();
    if s.is_empty() {
        return None;
    }
    crate::pass2::parse_hms(s.as_bytes()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pass1::run_pass1;
    use std::io::Write;
    use std::path::Path;

    /// Write a minimal valid GTFS feed (1 route, 1 service, 1 trip, 2 stop_times)
    /// into `dir`, optionally writing `frequencies.txt` with the given content.
    fn write_feed(dir: &Path, frequencies: Option<&str>) {
        std::fs::write(
            dir.join("stops.txt"),
            "stop_id,stop_name,stop_lat,stop_lon\n\
             S1,Stop One,54.6,25.2\n\
             S2,Stop Two,54.7,25.3\n",
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
             T1,05:00:00,05:00:00,S1,1\n\
             T1,05:10:00,05:10:00,S2,2\n",
        )
        .unwrap();
        if let Some(f) = frequencies {
            let mut file = std::fs::File::create(dir.join("frequencies.txt")).unwrap();
            file.write_all(f.as_bytes()).unwrap();
        }
    }

    #[test]
    fn absent_file_yields_empty() {
        let tmp = tempfile::tempdir().unwrap();
        write_feed(tmp.path(), None);
        let p1 = run_pass1(tmp.path()).unwrap();
        let res = parse_frequencies(tmp.path(), &p1).unwrap();
        assert_eq!(res.rows.len(), 0);
        assert_eq!(res.dropped, 0);
    }

    /// Two windows for trip T1, modelled on the mdb-1162 (Vizcaya) feed shape:
    /// a daytime window (headway 600s) and an overnight window (headway 900s,
    /// start past midnight). Both should parse; rows are returned sorted by
    /// (trip_idx, start_secs).
    #[test]
    fn two_windows_parse_and_sort() {
        let tmp = tempfile::tempdir().unwrap();
        // Daytime: 05:00:00–23:50:01, headway 600s, exact_times 0
        // Overnight: 00:00:00–05:00:03, headway 900s, exact_times 1
        // Note: in a real feed the overnight window wraps to the next service day
        // (i.e. 00:00:00 < 05:00:00 → start_secs < end_secs), which is valid.
        write_feed(
            tmp.path(),
            Some(
                "trip_id,start_time,end_time,headway_secs,exact_times\n\
                 T1,05:00:00,23:50:01,600,0\n\
                 T1,00:00:00,05:00:03,900,1\n",
            ),
        );
        let p1 = run_pass1(tmp.path()).unwrap();
        let t1_idx = p1.trips.lookup("T1").unwrap();
        let res = parse_frequencies(tmp.path(), &p1).unwrap();
        assert_eq!(res.dropped, 0);
        assert_eq!(res.rows.len(), 2);

        // Sorted by (trip_idx, start_secs): 00:00:00 (0) before 05:00:00 (18000)
        assert_eq!(res.rows[0].trip_idx, t1_idx);
        assert_eq!(res.rows[0].start_secs, 0); // 00:00:00
        assert_eq!(res.rows[0].end_secs, 18003); // 05:00:03
        assert_eq!(res.rows[0].headway_secs, 900);
        assert_eq!(res.rows[0].exact_times, 1);

        assert_eq!(res.rows[1].trip_idx, t1_idx);
        assert_eq!(res.rows[1].start_secs, 18000); // 05:00:00
        assert_eq!(res.rows[1].end_secs, 85801); // 23:50:01
        assert_eq!(res.rows[1].headway_secs, 600);
        assert_eq!(res.rows[1].exact_times, 0);
    }

    #[test]
    fn headway_over_65535_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        write_feed(
            tmp.path(),
            Some(
                "trip_id,start_time,end_time,headway_secs,exact_times\n\
                 T1,05:00:00,23:50:01,70000,0\n",
            ),
        );
        let p1 = run_pass1(tmp.path()).unwrap();
        let res = parse_frequencies(tmp.path(), &p1).unwrap();
        assert_eq!(res.rows.len(), 0);
        assert_eq!(res.dropped, 1);
    }

    #[test]
    fn headway_zero_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        // headway_secs == 0 is nonsensical (no departures); skipped + counted.
        write_feed(
            tmp.path(),
            Some(
                "trip_id,start_time,end_time,headway_secs,exact_times\n\
                 T1,05:00:00,23:50:01,0,0\n",
            ),
        );
        let p1 = run_pass1(tmp.path()).unwrap();
        let res = parse_frequencies(tmp.path(), &p1).unwrap();
        assert_eq!(res.rows.len(), 0);
        assert_eq!(res.dropped, 1);
    }

    #[test]
    fn exact_times_out_of_range_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        // exact_times == 2 is out of GTFS spec ({0,1} only); skipped + counted.
        write_feed(
            tmp.path(),
            Some(
                "trip_id,start_time,end_time,headway_secs,exact_times\n\
                 T1,05:00:00,23:50:01,600,2\n",
            ),
        );
        let p1 = run_pass1(tmp.path()).unwrap();
        let res = parse_frequencies(tmp.path(), &p1).unwrap();
        assert_eq!(res.rows.len(), 0);
        assert_eq!(res.dropped, 1);
    }

    #[test]
    fn exact_times_blank_defaults_to_zero() {
        let tmp = tempfile::tempdir().unwrap();
        // Blank exact_times cell → default 0; row is otherwise valid → kept.
        write_feed(
            tmp.path(),
            Some(
                "trip_id,start_time,end_time,headway_secs,exact_times\n\
                 T1,05:00:00,23:50:01,600,\n",
            ),
        );
        let p1 = run_pass1(tmp.path()).unwrap();
        let res = parse_frequencies(tmp.path(), &p1).unwrap();
        assert_eq!(res.dropped, 0);
        assert_eq!(res.rows.len(), 1);
        assert_eq!(res.rows[0].exact_times, 0);
    }

    #[test]
    fn exact_times_absent_column_defaults_to_zero() {
        let tmp = tempfile::tempdir().unwrap();
        // No exact_times column at all → default 0; row is otherwise valid → kept.
        write_feed(
            tmp.path(),
            Some(
                "trip_id,start_time,end_time,headway_secs\n\
                 T1,05:00:00,23:50:01,600\n",
            ),
        );
        let p1 = run_pass1(tmp.path()).unwrap();
        let res = parse_frequencies(tmp.path(), &p1).unwrap();
        assert_eq!(res.dropped, 0);
        assert_eq!(res.rows.len(), 1);
        assert_eq!(res.rows[0].exact_times, 0);
    }

    #[test]
    fn start_gte_end_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        // start == end: empty window; skipped + counted.
        write_feed(
            tmp.path(),
            Some(
                "trip_id,start_time,end_time,headway_secs,exact_times\n\
                 T1,08:00:00,08:00:00,600,0\n",
            ),
        );
        let p1 = run_pass1(tmp.path()).unwrap();
        let res = parse_frequencies(tmp.path(), &p1).unwrap();
        assert_eq!(res.rows.len(), 0);
        assert_eq!(res.dropped, 1);
    }

    #[test]
    fn inverted_window_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        // start > end: inverted; skipped + counted.
        write_feed(
            tmp.path(),
            Some(
                "trip_id,start_time,end_time,headway_secs,exact_times\n\
                 T1,10:00:00,08:00:00,600,0\n",
            ),
        );
        let p1 = run_pass1(tmp.path()).unwrap();
        let res = parse_frequencies(tmp.path(), &p1).unwrap();
        assert_eq!(res.rows.len(), 0);
        assert_eq!(res.dropped, 1);
    }

    #[test]
    fn unknown_trip_id_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        write_feed(
            tmp.path(),
            Some(
                "trip_id,start_time,end_time,headway_secs,exact_times\n\
                 GHOST,05:00:00,23:50:01,600,0\n",
            ),
        );
        let p1 = run_pass1(tmp.path()).unwrap();
        let res = parse_frequencies(tmp.path(), &p1).unwrap();
        assert_eq!(res.rows.len(), 0);
        assert_eq!(res.dropped, 1);
    }

    /// Mix of valid and invalid rows: only the valid row survives.
    #[test]
    fn mixed_valid_and_invalid() {
        let tmp = tempfile::tempdir().unwrap();
        write_feed(
            tmp.path(),
            Some(
                "trip_id,start_time,end_time,headway_secs,exact_times\n\
                 T1,05:00:00,23:50:01,600,0\n\
                 GHOST,05:00:00,23:50:01,600,0\n\
                 T1,05:00:00,23:50:01,70000,0\n\
                 T1,08:00:00,08:00:00,600,0\n",
            ),
        );
        let p1 = run_pass1(tmp.path()).unwrap();
        let res = parse_frequencies(tmp.path(), &p1).unwrap();
        assert_eq!(res.rows.len(), 1);
        assert_eq!(res.dropped, 3);
    }
}
