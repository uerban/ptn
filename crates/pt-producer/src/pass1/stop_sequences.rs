use crate::error::{Error, Result};
use crate::pass1::identity::InternTable;
use crate::pass2::parse_hms;
use std::path::Path;

/// `(trip_idx, stop_idx, stop_sequence)` triples captured during the Pass-1 stop_times scan.
pub type TripStopTriple = (u32, u32, u16);

/// Per-trip endpoints captured during the Pass-1 stop_times scan, indexed by
/// post-finalize trip ordinal. `first`/`last` are chosen by min/max
/// stop_sequence (triples are scanned in file order, NOT sequence order).
/// Times are absolute seconds since midnight (GTFS; may exceed 86400 for
/// overnight services, HH up to 47 — see `parse_hms`). `u32::MAX` =
/// missing/unparseable.
///
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TripEndpoint {
    pub first_seq: u16,
    pub first_stop_idx: u32,
    pub first_dep_secs: u32,
    pub last_seq: u16,
    pub last_stop_idx: u32,
    pub last_arr_secs: u32,
}

impl Default for TripEndpoint {
    fn default() -> Self {
        Self {
            first_seq: u16::MAX,
            first_stop_idx: u32::MAX,
            first_dep_secs: u32::MAX,
            last_seq: 0,
            last_stop_idx: u32::MAX,
            last_arr_secs: u32::MAX,
        }
    }
}

pub fn scan_trip_stop_triples(
    path: &Path,
    trips: &InternTable<String>,
    stops: &InternTable<String>,
    triples: &mut Vec<TripStopTriple>,
    endpoints: &mut [TripEndpoint],
    counts: &mut [u32],
    total: &mut u32,
) -> Result<()> {
    if !path.exists() {
        return Err(Error::MissingFile(path.display().to_string()));
    }
    let file = crate::csv_open::open_csv_skip_bom(path)?;
    let mut rdr = csv::Reader::from_reader(file);
    let headers = rdr.byte_headers()?.clone();
    let trip_col = headers
        .iter()
        .position(|h| h == b"trip_id")
        .ok_or_else(|| Error::MalformedGtfs("stop_times.txt missing trip_id".into()))?;
    let stop_col = headers
        .iter()
        .position(|h| h == b"stop_id")
        .ok_or_else(|| Error::MalformedGtfs("stop_times.txt missing stop_id".into()))?;
    let seq_col = headers
        .iter()
        .position(|h| h == b"stop_sequence")
        .ok_or_else(|| Error::MalformedGtfs("stop_times.txt missing stop_sequence".into()))?;
    // Optional here; Pass-2 (`stop_times_csv.rs`) treats them as required (hard
    // error). Present in all real feeds.
    let dep_col = headers.iter().position(|h| h == b"departure_time");
    let arr_col = headers.iter().position(|h| h == b"arrival_time");

    let mut record = csv::ByteRecord::new();
    while rdr.read_byte_record(&mut record)? {
        let trip_raw = record
            .get(trip_col)
            .ok_or_else(|| Error::MalformedGtfs("stop_times row missing trip_id".into()))?;
        let stop_raw = record
            .get(stop_col)
            .ok_or_else(|| Error::MalformedGtfs("stop_times row missing stop_id".into()))?;
        let seq_raw = record
            .get(seq_col)
            .ok_or_else(|| Error::MalformedGtfs("stop_times row missing stop_sequence".into()))?;

        let trip_str = std::str::from_utf8(trip_raw)
            .map_err(|_| Error::MalformedGtfs("non-utf8 trip_id".into()))?;
        let stop_str = std::str::from_utf8(stop_raw)
            .map_err(|_| Error::MalformedGtfs("non-utf8 stop_id".into()))?;
        let seq_str = std::str::from_utf8(seq_raw)
            .map_err(|_| Error::MalformedGtfs("non-utf8 stop_sequence".into()))?;

        let trip_id = trips
            .lookup(trip_str)
            .ok_or_else(|| Error::MalformedGtfs(format!("unknown trip_id {trip_str}")))?;
        let stop_id = stops
            .lookup(stop_str)
            .ok_or_else(|| Error::MalformedGtfs(format!("unknown stop_id {stop_str}")))?;
        // GTFS allows arbitrarily large stop_sequence values; the wire format
        // clamps to u16. Pass 2 applies the same clamp (see
        // `pass2/stop_times_csv.rs` and `pass2/stop_times_raw.rs`) — keep both
        // passes consistent so a single oversized row doesn't abort the bench.
        let seq_u32: u32 = seq_str
            .parse()
            .map_err(|_| Error::MalformedGtfs(format!("stop_sequence parse: {seq_str}")))?;
        let seq = u16::try_from(seq_u32).unwrap_or(u16::MAX);

        // Capture departure_time for the first-endpoint and arrival_time for
        // the last-endpoint. Fall back: arr defaults to dep when absent.
        // `u32::MAX` signals "missing/unparseable" to downstream consumers.
        // GTFS reference: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
        let dep = dep_col
            .and_then(|i| record.get(i))
            .and_then(|s| parse_hms(s).ok())
            .unwrap_or(u32::MAX);
        let arr = arr_col
            .and_then(|i| record.get(i))
            .and_then(|s| parse_hms(s).ok())
            .unwrap_or(dep);

        let ep = &mut endpoints[trip_id as usize];
        if seq <= ep.first_seq {
            ep.first_seq = seq;
            ep.first_stop_idx = stop_id;
            ep.first_dep_secs = dep;
        }
        if ep.last_stop_idx == u32::MAX || seq >= ep.last_seq {
            ep.last_seq = seq;
            ep.last_stop_idx = stop_id;
            ep.last_arr_secs = arr;
        }

        triples.push((trip_id, stop_id, seq));
        counts[trip_id as usize] += 1;
        *total += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::TripEndpoint;
    use crate::pass1::counts::run_pass1;
    use std::fs;

    /// Write the minimal set of GTFS files needed by `run_pass1`, with the
    /// given `stop_times.txt` content. Stops S1 and S2 are always defined.
    fn write_feed_stop_times(dir: &std::path::Path, stop_times: &str) {
        fs::write(
            dir.join("stops.txt"),
            "stop_id,stop_name,stop_lat,stop_lon\nS1,Stop1,0,0\nS2,Stop2,1,1\n",
        )
        .unwrap();
        fs::write(
            dir.join("routes.txt"),
            "route_id,agency_id,route_short_name,route_long_name,route_type\nR1,A,1,One,3\n",
        )
        .unwrap();
        fs::write(
            dir.join("calendar.txt"),
            "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n\
             Sv1,1,1,1,1,1,0,0,20260101,20271231\n",
        )
        .unwrap();
        fs::write(
            dir.join("trips.txt"),
            "route_id,service_id,trip_id\nR1,Sv1,T1\n",
        )
        .unwrap();
        fs::write(dir.join("stop_times.txt"), stop_times).unwrap();
    }

    /// Rows written OUT of stop_sequence order to prove we pick endpoints by
    /// min/max stop_sequence, not file order.
    ///
    /// Feed: T1 visits S2 (seq=2, 08:10) THEN S1 (seq=1, 08:00) in file
    /// order — first endpoint must be S1/08:00:00 (seq=1), last must be
    /// S2/08:10:00 (seq=2).
    ///
    /// GTFS reference: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
    #[test]
    fn captures_trip_endpoints_by_min_max_sequence() {
        let tmp = tempfile::tempdir().unwrap();
        write_feed_stop_times(
            tmp.path(),
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
             T1,08:10:00,08:10:00,S2,2\n\
             T1,08:00:00,08:00:00,S1,1\n",
        );
        let p1 = run_pass1(tmp.path()).unwrap();
        let t1 = p1.trips.lookup("T1").unwrap() as usize;
        let ep = p1.trip_endpoints[t1];
        let s1 = p1.stops.lookup("S1").unwrap();
        let s2 = p1.stops.lookup("S2").unwrap();
        assert_eq!(ep.first_stop_idx, s1, "first stop must be S1 (seq=1)");
        assert_eq!(ep.first_dep_secs, 8 * 3600, "first dep must be 08:00:00");
        assert_eq!(ep.last_stop_idx, s2, "last stop must be S2 (seq=2)");
        assert_eq!(
            ep.last_arr_secs,
            8 * 3600 + 600,
            "last arr must be 08:10:00"
        );
        // Confirm Default sentinel was replaced (no u32::MAX leakage).
        assert_ne!(ep, TripEndpoint::default());
    }
}
