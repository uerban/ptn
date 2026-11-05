//! End-to-end integration tests for block_id → type-4 in-seat derivation.
//!
//! Exercises the full producer path: synthetic GTFS feed → `build_ptb` →
//! PTB bytes on disk → decode Transfers region → assert derivation outcome.
//! Unit-level predicate tests live in `src/pass1/inseat.rs`; these tests
//! prove the plumbing from pass-1 through region-write is intact.
//!
//! GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt

use pt_producer::download::FeedRecord;
use std::io::Write as _;
use zip::write::FileOptions;

// ---------------------------------------------------------------------------
// Feed builder helpers
// ---------------------------------------------------------------------------

/// Write a minimal single-block feed into a zip at `<dir>/<name>`.
///
/// Feed shape:
/// - 3 stops: S1 (origin), S2 (junction), S3 (terminus)
/// - 1 route R1 (bus)
/// - 1 service WD (weekdays)
/// - 2 trips T0 and T1, both with `block_id=BLK`:
///   - T0: S1 07:00 → S2 08:00:00 (arr), block_id=BLK
///   - T1: S2 08:01:00 (dep) → S3 09:00, block_id=BLK
///
///   T0 last-stop == T1 first-stop == S2, layover = 60 s (within 120 s cap).
///
/// `transfers_body` — if `Some(csv)`, writes that as `transfers.txt`; if
/// `None`, the file is omitted (common "no transfers.txt" case).
fn write_block_feed_zip(
    dir: &std::path::Path,
    name: &str,
    transfers_body: Option<&str>,
) -> std::path::PathBuf {
    let path = dir.join(name);
    let f = std::fs::File::create(&path).unwrap();
    let mut zw = zip::ZipWriter::new(f);
    let opts: FileOptions<'_, '_, ()> = FileOptions::default();

    let mut add = |fname: &str, body: &str| {
        zw.start_file(fname, opts).unwrap();
        zw.write_all(body.as_bytes()).unwrap();
    };

    add(
        "agency.txt",
        "agency_id,agency_name,agency_url,agency_timezone\n\
         A,Agency,http://example.com,UTC\n",
    );
    add(
        "stops.txt",
        "stop_id,stop_name,stop_lat,stop_lon\n\
         S1,Stop One,54.69,25.28\n\
         S2,Stop Two,54.70,25.29\n\
         S3,Stop Three,54.71,25.30\n",
    );
    add(
        "routes.txt",
        "route_id,agency_id,route_short_name,route_type\n\
         R1,A,1,3\n",
    );
    // block_id=BLK on both trips: T0's last stop (S2 arr 08:00) == T1's first
    // stop (S2 dep 08:01), layover 60 s < MAX_LAYOVER_SECS=120.
    add(
        "trips.txt",
        "route_id,service_id,trip_id,block_id\n\
         R1,WD,T0,BLK\n\
         R1,WD,T1,BLK\n",
    );
    add(
        "calendar.txt",
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,\
         start_date,end_date\n\
         WD,1,1,1,1,1,0,0,20260101,20271231\n",
    );
    add(
        "stop_times.txt",
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
         T0,07:00:00,07:00:00,S1,1\n\
         T0,08:00:00,08:00:00,S2,2\n\
         T1,08:01:00,08:01:00,S2,1\n\
         T1,09:00:00,09:00:00,S3,2\n",
    );

    if let Some(csv) = transfers_body {
        zw.start_file("transfers.txt", opts).unwrap();
        zw.write_all(csv.as_bytes()).unwrap();
    }

    zw.finish().unwrap();
    path
}

/// Build a PTB from `zip_path` using `build_ptb` and return the raw bytes.
///
/// Passes `--anchor-date 20260501` for deterministic PTB v1 output.
fn build_and_read(
    tmp: &tempfile::TempDir,
    zip_path: std::path::PathBuf,
    derive: pt_producer::cli::DeriveInseat,
) -> Vec<u8> {
    let bundle = tmp.path().join("bundle.ptb");
    let extract = tmp.path().join("extract");
    pt_producer::build::build_ptb(
        vec![FeedRecord {
            url: "test".into(),
            zip_path,
            sha_hex: String::new(),
            etag: None,
        }],
        &extract,
        &bundle,
        Some(20260501),
        Some(0), // city_tz_offset_seconds = 0 (UTC)
        None,    // city_tz_iana
        derive,
    )
    .unwrap();
    std::fs::read(&bundle).unwrap()
}

// ---------------------------------------------------------------------------
// PTB Transfers region decoder (local helper — no new public API on the producer)
// ---------------------------------------------------------------------------

/// Decoded 32 B Transfers record.
fn decode_transfers(buf: Vec<u8>) -> Vec<pt_core::records::TransferRule> {
    let reader = pt_core::Reader::from_bytes(buf).expect("decode current PTB v1");
    (0..reader.num_transfers())
        .map(|i| reader.transfer(i).expect("decode transfer record"))
        .collect()
}

// ---------------------------------------------------------------------------
// Test A — auto-derivation emits exactly one type-4 record
// ---------------------------------------------------------------------------

/// End-to-end: synthetic feed with two block_id-linked trips produces one
/// type-4 in-seat rule in the PTB Transfers region when derivation is Auto.
///
/// Ordinal expectations (interns sort keys lexicographically):
/// - Stops: S1=0, S2=1, S3=2  →  junction S2 has ordinal 1
/// - Trips: T0=0, T1=1
#[test]
fn derives_inseat_rule_end_to_end() {
    let tmp = tempfile::tempdir().unwrap();
    let zip = write_block_feed_zip(tmp.path(), "feed.zip", None);
    let buf = build_and_read(&tmp, zip, pt_producer::cli::DeriveInseat::Auto);

    // Verify magic bytes so a parse error later is easier to diagnose.
    assert_eq!(&buf[0..4], b"PTB\0", "bad PTB magic");
    assert_eq!(
        u16::from_le_bytes(buf[4..6].try_into().unwrap()),
        pt_core::PTB_VERSION_V1,
        "expected current PTB header"
    );

    let records = decode_transfers(buf);
    assert_eq!(
        records.len(),
        1,
        "expected exactly 1 derived in-seat rule; got {}: {records:#?}",
        records.len()
    );

    let r = &records[0];
    // transfer_type must be 4 (in-seat continuation).
    assert_eq!(r.transfer_type, 4, "transfer_type must be 4");

    // Both stop indices must be S2 (ordinal 1 in lexicographic sort S1<S2<S3).
    assert_eq!(r.from_stop_idx, 1, "from_stop_idx should be S2 (ordinal 1)");
    assert_eq!(r.to_stop_idx, 1, "to_stop_idx should be S2 (ordinal 1)");

    // Trip ordinals: T0=0, T1=1.
    assert_eq!(r.from_trip_idx, 0, "from_trip_idx should be T0 (ordinal 0)");
    assert_eq!(r.to_trip_idx, 1, "to_trip_idx should be T1 (ordinal 1)");

    // Route/min-transfer absent (ABSENT = 0xFFFFFFFF) — derived rules carry no
    // route scope and no minimum-transfer-time.
    const ABSENT: u32 = 0xFFFF_FFFF;
    assert_eq!(r.from_route_idx, ABSENT);
    assert_eq!(r.to_route_idx, ABSENT);
    assert_eq!(r.min_transfer_secs, ABSENT);
}

// ---------------------------------------------------------------------------
// Test B — opt-out suppresses derivation
// ---------------------------------------------------------------------------

/// `--derive-inseat=off` must produce an empty Transfers region even when the
/// feed has block_id-linked trips.
#[test]
fn opt_out_suppresses_derivation() {
    let tmp = tempfile::tempdir().unwrap();
    let zip = write_block_feed_zip(tmp.path(), "feed.zip", None);
    let buf = build_and_read(&tmp, zip, pt_producer::cli::DeriveInseat::Off);

    let records = decode_transfers(buf);
    assert!(
        records.is_empty(),
        "DeriveInseat::Off must produce 0 records; got {}: {records:#?}",
        records.len()
    );
}

// ---------------------------------------------------------------------------
// Test C — feed-declared type-4 suppresses derivation (auto-disable gate)
// ---------------------------------------------------------------------------

/// When `transfers.txt` already declares a `transfer_type=4` row, auto-derivation
/// is suppressed entirely (the feed curates its own in-seat rules). The Transfers
/// region must contain only the 1 feed row — no derived duplicate.
///
/// The declared row is S1→S3 (unrelated to the block continuation at S2) so we
/// can distinguish "only feed row present" from "derived row leaked through".
#[test]
fn feed_with_type4_suppresses_derivation() {
    let tmp = tempfile::tempdir().unwrap();

    // A transfers.txt with one explicit type-4 rule (S1 → S3, trip-scoped).
    // Stop ordinals: S1=0, S3=2. Trip ordinals don't matter for this assertion —
    // we only check the count and transfer_type, not the exact indices here,
    // because the trip resolution touches the finalized interners just like the
    // main path and we already assert those in Test A.
    //
    // We use an S1→S3 route-level rule (no trip scope) to keep the CSV simple:
    // from/to trip_id left blank → ABSENT sentinel after parse.
    let explicit_transfers = "from_stop_id,to_stop_id,transfer_type\n\
                              S1,S3,4\n";

    let zip = write_block_feed_zip(tmp.path(), "feed.zip", Some(explicit_transfers));
    let buf = build_and_read(&tmp, zip, pt_producer::cli::DeriveInseat::Auto);

    let records = decode_transfers(buf);

    // Exactly 1 record: the explicit feed row. Zero derived rows.
    assert_eq!(
        records.len(),
        1,
        "expected only the 1 explicit feed row; got {}: {records:#?}",
        records.len()
    );

    // Must be the explicit rule (transfer_type 4).
    assert_eq!(
        records[0].transfer_type, 4,
        "the sole record should be the explicit type-4 rule"
    );

    // from_stop is S1 (ordinal 0), to_stop is S3 (ordinal 2).
    assert_eq!(
        records[0].from_stop_idx, 0,
        "from_stop must be S1 (ordinal 0)"
    );
    assert_eq!(records[0].to_stop_idx, 2, "to_stop must be S3 (ordinal 2)");
}
