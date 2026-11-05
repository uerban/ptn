//! End-to-end PTB v2 staging: GTFS feed on disk -> `ptb_v2::stage` -> the
//! three staging artifacts -> `pt_core` reader, index and v2 planner.
//!
//! Synthetic feed only; this does not exercise a real city feed.

use pt_producer::cli::DeriveInseat;
use pt_producer::download::record_for_local;
use std::io::{Read, Write};
use std::path::Path;
use zip::write::FileOptions;

const ANCHOR: u32 = 20260504; // a Monday

fn write_feed(dir: &Path) {
    // Stops sort: S1, S2, S3, S4, ST (station parenting S2 and S3).
    std::fs::write(
        dir.join("stops.txt"),
        "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n\
         S1,One,48.85,2.35,0,\n\
         S2,Two,48.86,2.36,0,ST\n\
         S3,Three,48.86,2.36,0,ST\n\
         S4,Four,48.87,2.37,0,\n\
         ST,Station,48.86,2.36,1,\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("routes.txt"),
        "route_id,route_type\nR1,3\nR2,3\nR3,3\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("calendar.txt"),
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n\
         ALL,1,1,1,1,1,1,1,20260401,20261231\n",
    )
    .unwrap();
    // T1 -> T2 is a stay-seated vehicle continuation at S2 with only a 60 s
    // layover (an ordinary same-stop transfer would miss it). T1 and T2 share a
    // block; T3 is an after-midnight trip.
    std::fs::write(
        dir.join("trips.txt"),
        "route_id,service_id,trip_id,block_id\n\
         R1,ALL,T1,B1\n\
         R2,ALL,T2,B1\n\
         R3,ALL,T3,\n\
         R3,ALL,T4,\n\
         R3,ALL,T5,\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("stop_times.txt"),
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
         T1,08:00:00,08:00:00,S1,1\n\
         T1,08:10:00,08:10:00,S2,2\n\
         T2,08:11:00,08:11:00,S2,1\n\
         T2,08:30:00,08:30:00,S4,2\n\
         T3,25:00:00,25:00:00,S3,1\n\
         T3,25:20:00,25:20:00,S4,2\n\
         T4,12:00:00,12:00:00,S3,1\n\
         T4,12:10:00,12:10:00,S4,2\n\
         T5,14:00:00,14:00:00,S3,1\n\
         T5,14:10:00,14:10:00,S4,2\n",
    )
    .unwrap();
    // T4 is a healthy exact_times=1 frequency trip. T5's windows overlap, so
    // the whole trip is quarantined. GHOST cannot be scoped and is dropped.
    std::fs::write(
        dir.join("frequencies.txt"),
        "trip_id,start_time,end_time,headway_secs,exact_times\n\
         T4,12:00:00,12:59:59,1200,1\n\
         T5,14:00:00,15:00:00,600,0\n\
         T5,14:30:00,15:30:00,600,0\n\
         GHOST,10:00:00,11:00:00,600,0\n",
    )
    .unwrap();
    // Row 1: stopless explicit type 4 (v1 cannot carry it across stops; v2 keeps it).
    // Row 2: station rule. Row 3: exact duplicate of row 2.
    // Row 4: unknown trip -> dropped, never broadened.
    // Rows 5/6: divergent primary key -> one type-3 tombstone.
    std::fs::write(
        dir.join("transfers.txt"),
        "from_stop_id,to_stop_id,from_route_id,to_route_id,from_trip_id,to_trip_id,transfer_type,min_transfer_time\n\
         ,,,,T1,T2,4,\n\
         ST,ST,,,,,2,90\n\
         ST,ST,,,,,2,90\n\
         S1,S4,,,GHOST,,3,\n\
         S4,S1,,,,,0,\n\
         S4,S1,,,,,1,\n",
    )
    .unwrap();
}

fn zip_dir(dir: &Path, zip_path: &Path) {
    let f = std::fs::File::create(zip_path).unwrap();
    let mut zw = zip::ZipWriter::new(f);
    let opts: FileOptions<'_, '_, ()> = FileOptions::default();
    for e in std::fs::read_dir(dir).unwrap() {
        let e = e.unwrap();
        zw.start_file(e.file_name().into_string().unwrap(), opts)
            .unwrap();
        zw.write_all(&std::fs::read(e.path()).unwrap()).unwrap();
    }
    zw.finish().unwrap();
}

/// Stage the synthetic feed into `<tmp>/out`.
fn stage_feed(tmp: &Path) -> pt_producer::ptb_v2::V2Outcome {
    let feed = tmp.join("feed");
    std::fs::create_dir_all(&feed).unwrap();
    write_feed(&feed);
    let zip = tmp.join("feed.zip");
    zip_dir(&feed, &zip);
    pt_producer::ptb_v2::stage(
        vec![record_for_local(&zip).unwrap()],
        &tmp.join("extract"),
        &tmp.join("out"),
        ANCHOR,
        "Europe/Paris",
        DeriveInseat::Auto,
    )
    .expect("stage")
}

/// The TypeScript loader's v2 fixture is this producer's output for the feed
/// above. Regenerate with
/// `PTN_REGEN_V2_FIXTURE=1 cargo test -p pt-producer --test ptb_v2_stage`.
#[test]
fn committed_ts_v2_fixture_matches_staged_bytes() {
    let tmp = tempfile::tempdir().unwrap();
    stage_feed(tmp.path());
    let staged = std::fs::read(tmp.path().join("out/bundle.ptb")).unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny-v2.ptb");
    if std::env::var_os("PTN_REGEN_V2_FIXTURE").is_some() {
        std::fs::write(&fixture, &staged).unwrap();
    }
    let committed = std::fs::read(&fixture).expect("read committed tiny-v2.ptb");
    assert!(
        committed == staged,
        "tiny-v2.ptb drifted from the producer; regenerate it (see this test's doc)"
    );
}

#[test]
fn stage_writes_a_routable_v2_bundle_with_committed_v1_artifacts() {
    let tmp = tempfile::tempdir().unwrap();
    let outcome = stage_feed(tmp.path());
    let out = tmp.path().join("out");

    // Transfer ingestion diagnostics.
    let d = &outcome.transfers;
    assert_eq!(d.rows_read, 6);
    assert_eq!(d.dropped_unknown_id, 1);
    assert_eq!(d.exact_duplicates, 1);
    assert_eq!(d.tombstones, 1);
    assert_eq!(d.linked_stopless, 1);
    assert_eq!(d.station_rules, 1);
    assert_eq!(d.rows_emitted, 3);
    assert_eq!(
        outcome.feed_start_date, 20260502,
        "anchor minus two guard days"
    );

    // Frequency quarantine diagnostics.
    let f = &outcome.frequencies;
    assert_eq!(f.rows_read, 4);
    assert_eq!(f.dropped_unknown_trip, 1);
    assert_eq!(f.quarantined_trips, 1);
    assert_eq!(f.rows_emitted, 2, "one T4 window plus one T5 marker");
    let rules: Vec<(u64, &str, pt_producer::ptb_v2::FrequencyRule)> = f
        .diagnostics
        .iter()
        .map(|d| (d.line, d.trip_id.as_str(), d.rule))
        .collect();
    use pt_producer::ptb_v2::FrequencyRule::{OverlappingWindows, UnknownTrip};
    assert_eq!(
        rules,
        vec![
            (3, "T5", OverlappingWindows),
            (4, "T5", OverlappingWindows),
            (5, "GHOST", UnknownTrip),
        ]
    );

    // v1 compatibility artifacts are committed byte for byte.
    let v1 = std::fs::read(out.join("bundle-v1.ptb")).unwrap();
    let gz = std::fs::read(out.join("bundle-v1.ptb.gz")).unwrap();
    let mut dec = Vec::new();
    flate2::read::GzDecoder::new(gz.as_slice())
        .read_to_end(&mut dec)
        .unwrap();
    assert_eq!(dec, v1);
    let v2 = std::fs::read(out.join("bundle.ptb")).unwrap();
    let reader = pt_core::Reader::from_bytes(v2).unwrap();
    assert!(reader.is_v2());
    assert!(reader.derive_block_inseat());
    let c = reader.compatibility_artifact_commitment().unwrap();
    assert_eq!(c.v1_identity_size, v1.len() as u64);
    assert_eq!(c.v1_gzip_size, gz.len() as u64);
    assert_eq!(
        reader.num_service_day_origins(),
        reader.window_days() as usize + 1
    );
    assert_eq!(reader.num_transfers(), 3);
    let (t4, t5) = (3u32, 4u32);
    assert_eq!(reader.trip_id(3).unwrap(), "T4");
    assert_eq!(reader.trip_id(4).unwrap(), "T5");
    assert!(!reader.frequency_trip_quarantined(t4));
    assert!(reader.frequency_trip_quarantined(t5));
    assert_eq!(reader.frequencies_for_trip(t4).count(), 1);
    let t1 = 0usize;
    assert_eq!(reader.trip_block_key(t1), Some("ptn:block:0:QjE"));
    assert_eq!(reader.trip_block_key(2), None);
    // The explicit T1->T2 type 4 suppresses the derived pair.
    assert_eq!(outcome.derived_block_pair_date_count, 0);

    // Route the in-seat continuation at the operational anchor.
    let index = pt_core::engine::Index::build(&reader, pt_core::engine::PatternMode::CoveringMerge)
        .unwrap();
    let origin = reader.service_day_origin(2).unwrap();
    let t = pt_core::engine::v2::resolve_time(&reader, origin + 7 * 3600).unwrap();
    assert_eq!(t.service_date, ANCHOR);
    let s1 = reader.stop_index("S1").unwrap();
    let s4 = reader.stop_index("S4").unwrap();
    let q = pt_core::engine::Query {
        excluded_routes: Default::default(),
        entry_stops: vec![pt_core::engine::StopWalk {
            stop: s1,
            walk_secs: 0,
        }],
        exit_stops: vec![pt_core::engine::StopWalk {
            stop: s4,
            walk_secs: 0,
        }],
        departure_secs: t.departure_secs,
        date: t.service_date,
        max_rounds: None,
        mobility: pt_core::engine::Mobility::Default,
        excluded_modes: vec![],
        walk_speed_mm_s: None,
        min_transfer_secs: None,
    };
    let its = pt_core::engine::v2::plan_v2(&reader, &index, None, &q, None).unwrap();
    assert_eq!(its.len(), 1);
    assert_eq!(its[0].transfers, 0, "type 4 keeps the rider seated");
    assert_eq!(its[0].alight_secs, 8 * 3600 + 30 * 60);
}
