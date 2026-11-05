use pt_producer::layout::{Layout, Region};
use pt_producer::pass1::{compute_trip_starts, run_pass1};
use pt_producer::pass2::parse_and_write_stop_times;
use pt_producer::writer::{open_writer, WriteRegion};
use std::path::PathBuf;

fn fixture_dir(tmp: &tempfile::TempDir) -> PathBuf {
    let zip = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tiny-gtfs.zip");
    pt_producer::source::extract_zip(&zip, tmp.path()).unwrap();
    tmp.path().to_path_buf()
}

#[test]
fn parser_writes_expected_dep_secs() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = fixture_dir(&tmp);
    let p1 = run_pass1(&dir).unwrap();
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
    let mut w = open_writer(&out, layout.total_bytes()).unwrap();
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
    assert_eq!(written, 12);
    let region = w.region_slice(&layout, Region::StopTimes);
    let first = u32::from_le_bytes(region[0..4].try_into().unwrap());
    // The fixture's first row (T1, 07:00:00) → 7 * 3600 = 25200. T1 sorts to
    // index 0, so its first row still lands at offset 0.
    assert_eq!(first, 7 * 3600);
    // T4 (last sorted trip) is the last 3-row block; its third row (25:35:00)
    // lands at row 11 → offset 11 * 12 = 132.
    let last = u32::from_le_bytes(region[132..136].try_into().unwrap());
    assert_eq!(last, 25 * 3600 + 35 * 60);
}

#[test]
fn hms_parse_handles_rollover() {
    use pt_producer::pass2::parse_hms;
    assert_eq!(parse_hms(b"07:00:00").unwrap(), 7 * 3600);
    assert_eq!(parse_hms(b"00:00:00").unwrap(), 0);
    assert_eq!(parse_hms(b"23:59:59").unwrap(), 23 * 3600 + 59 * 60 + 59);
    assert_eq!(parse_hms(b"25:30:00").unwrap(), 25 * 3600 + 30 * 60);
    // Single-digit hour form (some GTFS exports emit it):
    assert_eq!(parse_hms(b"7:00:00").unwrap(), 7 * 3600);
    assert!(parse_hms(b"bad").is_err());
    assert!(parse_hms(b"99:00").is_err()); // only one colon
    assert!(parse_hms(b"99:00:00:00").is_err()); // three colons
    assert!(parse_hms(b"07:5:00").is_err()); // MM not 2 chars
    assert!(parse_hms(b"07:60:00").is_err()); // MM out of range
    assert!(parse_hms(b"48:00:00").is_err()); // HH out of range
    assert!(parse_hms(b":00:00").is_err()); // empty HH
}

#[test]
fn parser_groups_rows_by_sorted_trip_and_fills_each_range() {
    // Trip-grouped Pass 2: each stop_times row lands in its sorted trip's
    // reserved range, NOT in feed order. After the pass, `write_cursor[i]`
    // must equal `trip_starts[i + 1]` (every trip's range exactly filled), and
    // decoding the rows in `[trip_starts[i], trip_starts[i + 1])` must yield a
    // single trip's rows with monotonically increasing stop_sequence.
    let tmp = tempfile::tempdir().unwrap();
    let dir = fixture_dir(&tmp);
    let p1 = run_pass1(&dir).unwrap();
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
    let mut w = open_writer(&out, layout.total_bytes()).unwrap();

    let trip_starts = compute_trip_starts(&p1);
    let mut write_cursor = trip_starts.clone();
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
    assert_eq!(written, 12);

    // Each trip's range is exactly filled: cursor lands on the next trip's start.
    for i in 0..p1.trips.len() {
        assert_eq!(
            write_cursor[i],
            trip_starts[i + 1],
            "write_cursor[{i}] must reach trip_starts[{}]",
            i + 1
        );
    }

    // Each per-trip slice holds one trip's rows in stop_sequence order. The
    // tiny fixture's T1/T2/T4 ascend by stop_sequence; T3 also ascends (its
    // stop_ids are reversed but stop_sequence still goes 1,2,3).
    let region = w.region_slice(&layout, Region::StopTimes);
    let stride = 12usize;
    for i in 0..p1.trips.len() {
        let lo = trip_starts[i] as usize;
        let hi = trip_starts[i + 1] as usize;
        let mut prev_seq: Option<u16> = None;
        for row in lo..hi {
            let off = row * stride;
            let seq = u16::from_le_bytes(region[off + 10..off + 12].try_into().unwrap());
            if let Some(p) = prev_seq {
                assert!(
                    seq > p,
                    "trip {i} row {row}: stop_sequence not increasing ({p} -> {seq})"
                );
            }
            prev_seq = Some(seq);
        }
        assert_eq!(hi - lo, 3, "fixture trip {i} has 3 rows");
    }
}

#[test]
fn parser_regroups_interleaved_feed_rows_by_trip() {
    // Discriminating test: a feed whose stop_times rows are INTERLEAVED across
    // trips (not grouped) and whose trip_ids do NOT sort in feed order. With
    // sequential (feed-order) writes the per-trip ranges would be scrambled;
    // trip-grouped writes must place each trip's rows contiguously and in
    // ascending stop_sequence inside `[trip_starts[i], trip_starts[i+1])`.
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    std::fs::write(
        dir.join("agency.txt"),
        "agency_id,agency_name,agency_url,agency_timezone\nA,A,https://example.com,UTC\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("stops.txt"),
        "stop_id,stop_name,stop_lat,stop_lon\nS1,A,0,0\nS2,B,0,0\nS3,C,0,0\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("routes.txt"),
        "route_id,agency_id,route_short_name,route_type\nR1,A,1,3\n",
    )
    .unwrap();
    // Two trips. Tb sorts AFTER Ta, but appears interleaved/first in the feed.
    std::fs::write(
        dir.join("trips.txt"),
        "route_id,service_id,trip_id\nR1,S,Tb\nR1,S,Ta\n",
    )
    .unwrap();
    // Feed order interleaves Tb and Ta and is NOT sorted by trip_id. dep_secs
    // encodes (trip, seq) so we can verify exact placement:
    //   Ta seq1=01:00 seq2=02:00 seq3=03:00
    //   Tb seq1=11:00 seq2=12:00 seq3=13:00
    std::fs::write(
        dir.join("stop_times.txt"),
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
         Tb,11:00:00,11:00:00,S1,1\n\
         Ta,01:00:00,01:00:00,S1,1\n\
         Tb,12:00:00,12:00:00,S2,2\n\
         Ta,02:00:00,02:00:00,S2,2\n\
         Ta,03:00:00,03:00:00,S3,3\n\
         Tb,13:00:00,13:00:00,S3,3\n",
    )
    .unwrap();

    let p1 = run_pass1(dir).unwrap();
    assert_eq!(p1.total_stop_times, 6);
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
    let out = dir.join("p1.bin");
    let mut w = open_writer(&out, layout.total_bytes()).unwrap();
    let trip_starts = compute_trip_starts(&p1);
    let mut write_cursor = trip_starts.clone();
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
    assert_eq!(written, 6);

    // Ta sorts to index 0, Tb to index 1.
    let ta = p1.trips.lookup("Ta").unwrap() as usize;
    let tb = p1.trips.lookup("Tb").unwrap() as usize;
    assert_eq!(ta, 0);
    assert_eq!(tb, 1);

    let region = w.region_slice(&layout, Region::StopTimes);
    let dep = |row: usize| u32::from_le_bytes(region[row * 12..row * 12 + 4].try_into().unwrap());

    // Ta's range [0,3): dep 01:00, 02:00, 03:00 — contiguous and ordered.
    assert_eq!(dep(trip_starts[ta] as usize), 3600);
    assert_eq!(dep(trip_starts[ta] as usize + 1), 2 * 3600);
    assert_eq!(dep(trip_starts[ta] as usize + 2), 3 * 3600);
    // Tb's range [3,6): dep 11:00, 12:00, 13:00.
    assert_eq!(dep(trip_starts[tb] as usize), 11 * 3600);
    assert_eq!(dep(trip_starts[tb] as usize + 1), 12 * 3600);
    assert_eq!(dep(trip_starts[tb] as usize + 2), 13 * 3600);

    // Each trip's range exactly filled.
    assert_eq!(write_cursor[ta], trip_starts[ta + 1]);
    assert_eq!(write_cursor[tb], trip_starts[tb + 1]);
}

#[test]
fn parser_writes_sentinel_for_empty_departure_time() {
    // GTFS lets non-timepoint mid-trip stops omit `departure_time`. The producer
    // must keep the Pass1/Pass2 row count aligned ( invariant) by writing a
    // sentinel rather than erroring out on `parse_hms` of an empty byte slice.
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    std::fs::write(
        dir.join("agency.txt"),
        "agency_id,agency_name,agency_url,agency_timezone\nA,A,https://example.com,UTC\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("stops.txt"),
        "stop_id,stop_name,stop_lat,stop_lon\nS1,A,0,0\nS2,B,0,0\nS3,C,0,0\n",
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
    // Three stops on T1: first and last have departure_time, middle is empty.
    std::fs::write(
        dir.join("stop_times.txt"),
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
         T1,07:00:00,07:00:00,S1,1\n\
         T1,,,S2,2\n\
         T1,07:10:00,07:10:00,S3,3\n",
    )
    .unwrap();

    let p1 = run_pass1(dir).unwrap();
    assert_eq!(p1.total_stop_times, 3, "Pass1 counts all 3 rows");
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
    let mut w = open_writer(&out, layout.total_bytes()).unwrap();
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
    assert_eq!(written, 3, "Pass2 wrote all 3 rows including the empty one");
    let region = w.region_slice(&layout, Region::StopTimes);
    // 12 B/row: rows are at offsets 0, 12, 24.
    assert_eq!(
        u32::from_le_bytes(region[0..4].try_into().unwrap()),
        7 * 3600
    );
    assert_eq!(
        u32::from_le_bytes(region[12..16].try_into().unwrap()),
        u32::MAX,
        "empty departure_time writes u32::MAX sentinel"
    );
    assert_eq!(
        u32::from_le_bytes(region[24..28].try_into().unwrap()),
        7 * 3600 + 10 * 60
    );
}

#[test]
fn parser_strips_bom_in_header() {
    // Real-world GTFS feeds sometimes emit a UTF-8 BOM on CSV files. The
    // csv-crate variants used to choke on this (header lookup for
    // `"departure_time"` failed because the first column was
    // `"\u{feff}trip_id"`), while the hand-rolled variant stripped BOM
    // explicitly. Variants must agree for measurements to be comparable.
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    std::fs::write(
        dir.join("agency.txt"),
        "agency_id,agency_name,agency_url,agency_timezone\nA,A,https://example.com,UTC\n",
    )
    .unwrap();
    // BOM-prefixed stops.txt to exercise Pass 1 path too.
    let mut stops_bytes = Vec::from(b"\xef\xbb\xbf".as_slice());
    stops_bytes.extend_from_slice(b"stop_id,stop_name,stop_lat,stop_lon\nS1,A,0,0\n");
    std::fs::write(dir.join("stops.txt"), stops_bytes).unwrap();
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
    let mut st_bytes = Vec::from(b"\xef\xbb\xbf".as_slice());
    st_bytes.extend_from_slice(b"trip_id,arrival_time,departure_time,stop_id,stop_sequence\n");
    st_bytes.extend_from_slice(b"T1,07:00:00,07:00:00,S1,1\n");
    std::fs::write(dir.join("stop_times.txt"), st_bytes).unwrap();

    let p1 = run_pass1(dir).unwrap();
    assert_eq!(p1.stops.len(), 1);
    assert_eq!(p1.total_stop_times, 1);
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
    let out = dir.join("p1.bin");
    let mut w = open_writer(&out, layout.total_bytes()).unwrap();
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
    assert_eq!(written, 1);
    let region = w.region_slice(&layout, Region::StopTimes);
    assert_eq!(
        u32::from_le_bytes(region[0..4].try_into().unwrap()),
        7 * 3600
    );
}

#[test]
fn parser_clamps_arr_diff_out_of_i16_range() {
    // A sleeper-train / overnight-layover row can have an arrival-to-departure
    // delta beyond ±9h6m (±i16). The producer must NOT abort the bench on such a
    // row — that policy is documented in the stop_sequence u16 clamp. Verify
    // both csv and hand-rolled parsers clamp arr_diff to i16::MIN..=i16::MAX
    // instead of erroring.
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    std::fs::write(
        dir.join("agency.txt"),
        "agency_id,agency_name,agency_url,agency_timezone\nA,A,https://example.com,UTC\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("stops.txt"),
        "stop_id,stop_name,stop_lat,stop_lon\nS1,A,0,0\nS2,B,0,0\n",
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
    // Row 0: arr=22:00, dep=06:00 next day (30:00 GTFS) → diff = -28800 (fits i16).
    // Row 1: arr=02:00, dep=26:00 next day (extreme layover) → diff = -86400 (clamps to i16::MIN).
    std::fs::write(
        dir.join("stop_times.txt"),
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
         T1,22:00:00,30:00:00,S1,1\n\
         T1,02:00:00,26:00:00,S2,2\n",
    )
    .unwrap();
    let p1 = run_pass1(dir).unwrap();
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
    let mut w = open_writer(&out, layout.total_bytes()).unwrap();
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
    assert_eq!(written, 2, "clamping must not skip rows");
    let region = w.region_slice(&layout, Region::StopTimes);
    // Row 0 arr_diff at offset 4..6: -28800 fits i16.
    let row0_diff = i16::from_le_bytes(region[4..6].try_into().unwrap());
    assert_eq!(row0_diff, -28800);
    // Row 1 arr_diff at offset 16..18: -86400 clamps to i16::MIN.
    let row1_diff = i16::from_le_bytes(region[16..18].try_into().unwrap());
    assert_eq!(row1_diff, i16::MIN);
}

#[test]
fn parser_clamps_stop_sequence_above_u16_range() {
    // GTFS allows arbitrarily large `stop_sequence`. Both Pass 2 writers
    // (`stop_times_csv.rs` and `stop_times_raw.rs`) clamp to `u16::MAX` rather
    // than abort the bench. Pass 1's `stop_sequences.rs` follows the same
    // policy — see `tests/attrs.rs::pass1_clamps_stop_sequence_above_u16_range`
    // for the Pass 1 side. This test asserts the byte at the seq slot in the
    // StopTimes region is `u16::MAX` for an oversized input row.
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    std::fs::write(
        dir.join("agency.txt"),
        "agency_id,agency_name,agency_url,agency_timezone\nA,A,https://example.com,UTC\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("stops.txt"),
        "stop_id,stop_name,stop_lat,stop_lon\nS1,A,0,0\nS2,B,0,0\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("routes.txt"),
        "route_id,agency_id,route_short_name,route_type\nR1,A,1,3\n",
    )
    .unwrap();
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
    // 70000 exceeds u16::MAX (65535) — must clamp without erroring.
    std::fs::write(
        dir.join("stop_times.txt"),
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
         T1,07:00:00,07:00:00,S1,1\n\
         T1,07:05:00,07:05:00,S2,70000\n",
    )
    .unwrap();
    let p1 = run_pass1(dir).unwrap();
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
    let mut w = open_writer(&out, layout.total_bytes()).unwrap();
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
    assert_eq!(written, 2, "clamping must not skip rows");
    let region = w.region_slice(&layout, Region::StopTimes);
    // Row 0 seq at offset 10..12: 1 (in-range).
    let row0_seq = u16::from_le_bytes(region[10..12].try_into().unwrap());
    assert_eq!(row0_seq, 1);
    // Row 1 seq at offset 22..24: 70000 clamps to u16::MAX.
    let row1_seq = u16::from_le_bytes(region[22..24].try_into().unwrap());
    assert_eq!(row1_seq, u16::MAX);
}

#[cfg(feature = "hand-rolled")]
#[test]
fn hand_rolled_parser_matches_csv_crate_output() {
    let tmp = tempfile::tempdir().unwrap();
    let zip =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tiny-gtfs.zip");
    pt_producer::source::extract_zip(&zip, tmp.path()).unwrap();
    let p1 = pt_producer::pass1::run_pass1(tmp.path()).unwrap();
    let layout = pt_producer::layout::Layout::compute(
        p1.stops.len() as u64,
        p1.routes.len() as u64,
        p1.trips.len() as u64,
        p1.total_stop_times as u64,
        90,
        2,
        0,
        0,
    );
    let out = tmp.path().join("hr.bin");
    let mut w = pt_producer::writer::open_writer(&out, layout.total_bytes()).unwrap();
    let mut write_cursor = pt_producer::pass1::compute_trip_starts(&p1);
    let mut boarding = vec![0x50u8; p1.total_stop_times as usize];
    let n = pt_producer::pass2::parse_and_write_stop_times(
        &tmp.path().join("stop_times.txt"),
        &layout,
        &p1,
        &mut w,
        &mut write_cursor,
        &mut boarding,
    )
    .unwrap();
    assert_eq!(n, 12);
    let region = w.region_slice(&layout, pt_producer::layout::Region::StopTimes);
    // 12 B/row: row 11 at offset 132.
    assert_eq!(
        u32::from_le_bytes(region[0..4].try_into().unwrap()),
        7 * 3600
    );
    assert_eq!(
        u32::from_le_bytes(region[132..136].try_into().unwrap()),
        25 * 3600 + 35 * 60
    );
}

/// Dual-path boarding parity: the active `parse_and_write_stop_times` (csv-crate
/// under `csv-mmap`, hand-rolled under `hand-rolled`) packs the SAME
/// `boarding` Vec over a boarding-bearing feed. The pre-existing
/// `hand_rolled_parser_matches_csv_crate_output` parity test only checks
/// departure times on a no-boarding fixture, so the two parsers' boarding logic
/// was previously un-gated against each other. This test body is compiled under
/// BOTH feature builds and asserts an identical packed result, so a divergence
/// in either parser's boarding packing fails CI. The expected vec mirrors the
/// in-crate csv-side test `parse_packs_boarding_bytes_in_global_row_order`.
#[test]
fn parser_packs_boarding_bytes_matches_across_paths() {
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
    // Single trip T1, 4 rows; header carries pickup_type + drop_off_type but
    // NOT the continuous_* columns (so the high nibble stays at default 0x50).
    //   row0 pickup_type=1 ⇒ 0x51, row1 blank ⇒ 0x50,
    //   row2 pickup_type=2 ⇒ 0x52, row3 drop_off_type=1 ⇒ 0x54
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
    let mut w = open_writer(&out, layout.total_bytes()).unwrap();
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
    assert_eq!(
        boarding,
        vec![0x51, 0x50, 0x52, 0x54],
        "both parser paths must pack identical boarding bytes"
    );
}
