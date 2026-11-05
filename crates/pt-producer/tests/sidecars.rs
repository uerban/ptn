use pt_producer::pass2::shapes::parse_shapes_all;
use pt_producer::pass3::departures_idx::build_departures_idx_csr;
use pt_producer::sidecars::{
    format_ymd, write_meta, write_shapes, FeedMeta, ShapeGroup, ShapePoint,
};
use pt_shared::sidecar::{
    encode_departures_idx, encode_shapes_bin, intern_namespace_sha256, DeparturesIdx,
    ShapeEncodeInput, ShapesBin,
};
use std::path::PathBuf;

const FSD: &str = "2026-01-01";

#[test]
fn meta_json_round_trips() {
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("p1.bin.meta.json");
    let feeds = vec![FeedMeta {
        url: "https://example/feed.zip".into(),
        blob_sha256: "de".repeat(32),
        etag: Some("\"W/\\\"abc\\\"\"".into()),
    }];
    write_meta(&out, &feeds, "test-sha", FSD, None, None).unwrap();
    let parsed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert_eq!(parsed["schemaVersion"], 1);
    assert_eq!(parsed["producerGitSha"], "test-sha");
    assert!(parsed.get("probeGitSha").is_none());
    assert_eq!(parsed["feedStartDate"], FSD);
    assert_eq!(parsed["feeds"][0]["url"], "https://example/feed.zip");
    assert_eq!(parsed["feeds"][0]["etag"], "\"W/\\\"abc\\\"\"");
    // blobSha256 round-trips
    assert_eq!(parsed["feeds"][0]["blobSha256"], "de".repeat(32));
    // cityTzIana=None → field omitted (forward-compat with v1 readers).
    assert!(parsed.get("cityTzIana").is_none());
    // derivedInseatRules=None → field omitted (optional observability field).
    assert!(parsed.get("derivedInseatRules").is_none());
}

#[test]
fn meta_json_emits_derived_inseat_rules_when_some() {
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("p1.bin.meta.json");
    let feeds = vec![FeedMeta {
        url: "https://example/feed.zip".into(),
        blob_sha256: "ab".repeat(32),
        etag: None,
    }];
    write_meta(&out, &feeds, "sha-x", FSD, None, Some(42)).unwrap();
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert_eq!(v["derivedInseatRules"], 42);
}

#[test]
fn meta_json_omits_derived_inseat_rules_when_none() {
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("p1.bin.meta.json");
    let feeds = vec![FeedMeta {
        url: "https://example/feed.zip".into(),
        blob_sha256: "cd".repeat(32),
        etag: None,
    }];
    write_meta(&out, &feeds, "sha-y", FSD, None, None).unwrap();
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert!(
        v.get("derivedInseatRules").is_none(),
        "derivedInseatRules must be absent when None for back-compat"
    );
}

#[test]
fn meta_json_handles_missing_etag_as_null() {
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("p1.bin.meta.json");
    let feeds = vec![FeedMeta {
        url: "https://example/feed.zip".into(),
        blob_sha256: "00".repeat(32),
        etag: None,
    }];
    write_meta(&out, &feeds, "test-sha", FSD, None, None).unwrap();
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert_eq!(v["feeds"][0]["etag"], serde_json::Value::Null);
}

#[test]
fn meta_json_round_trips_three_feeds_in_order() {
    // Krakow shape: comma-separated GTFS_STATIC_URL → 3 FeedRecord entries.
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("p1.bin.meta.json");
    let feeds = vec![
        FeedMeta {
            url: "https://a.example/feed.zip".into(),
            blob_sha256: "aa".repeat(32),
            etag: Some("\"W/\\\"a\\\"\"".into()),
        },
        FeedMeta {
            url: "https://b.example/feed.zip".into(),
            blob_sha256: "bb".repeat(32),
            etag: None,
        },
        FeedMeta {
            url: "https://c.example/feed.zip".into(),
            blob_sha256: "cc".repeat(32),
            etag: Some("\"c-etag\"".into()),
        },
    ];
    write_meta(&out, &feeds, "sha-3", FSD, None, None).unwrap();
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert_eq!(v["feeds"].as_array().unwrap().len(), 3);
    assert_eq!(v["feeds"][0]["url"], "https://a.example/feed.zip");
    assert_eq!(v["feeds"][1]["etag"], serde_json::Value::Null);
    assert_eq!(v["feeds"][2]["url"], "https://c.example/feed.zip");
}

#[test]
fn meta_json_overwrites_cleanly() {
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("p1.bin.meta.json");
    write_meta(
        &out,
        &[FeedMeta {
            url: "a".into(),
            blob_sha256: "00".repeat(32),
            etag: None,
        }],
        "v1",
        FSD,
        None,
        None,
    )
    .unwrap();
    write_meta(
        &out,
        &[
            FeedMeta {
                url: "a".into(),
                blob_sha256: "00".repeat(32),
                etag: None,
            },
            FeedMeta {
                url: "b".into(),
                blob_sha256: "11".repeat(32),
                etag: None,
            },
        ],
        "sha-2",
        FSD,
        None,
        None,
    )
    .unwrap();
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert_eq!(v["feeds"].as_array().unwrap().len(), 2);
    assert_eq!(v["producerGitSha"], "sha-2");
}

#[test]
fn meta_json_round_trips_non_ascii_url() {
    // Non-ASCII URLs (some municipal feeds) must survive JSON encoding/decoding.
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("p1.bin.meta.json");
    let feeds = vec![FeedMeta {
        url: "https://example/krakow-ąćź.zip".into(),
        blob_sha256: "ff".repeat(32),
        etag: None,
    }];
    write_meta(&out, &feeds, "x", FSD, None, None).unwrap();
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert_eq!(v["feeds"][0]["url"], "https://example/krakow-ąćź.zip");
}

#[test]
fn format_ymd_zero_pads_components() {
    assert_eq!(format_ymd(20260518), "2026-05-18");
    assert_eq!(format_ymd(20260101), "2026-01-01");
    // Sentinel: no dated services in the feed.
    assert_eq!(format_ymd(0), "1970-01-01");
}

#[test]
fn shapes_json_round_trips_with_real_fixture() {
    // tiny-gtfs-with-shapes has SH_A (3 pts) + SH_B (3 pts), each with
    // monotonic shape_dist_traveled.
    let shapes = parse_shapes_all(&[
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tiny-gtfs-with-shapes")
    ])
    .unwrap();
    assert_eq!(shapes.len(), 2);
    let sh_a = shapes.iter().find(|s| s.shape_id == "SH_A").unwrap();
    assert_eq!(sh_a.points.len(), 3);
    // trips.txt references SH_A from T1+T2 (2 trips) and SH_B from T3 (1);
    // T4 carries no shape_id so it contributes nothing.
    assert_eq!(sh_a.trip_ref_count, 2);
    let sh_b = shapes.iter().find(|s| s.shape_id == "SH_B").unwrap();
    assert_eq!(sh_b.trip_ref_count, 1);
    // Cell-for-cell oracle: point 1 lat/lon
    assert!((sh_a.points[0].lat - 54.69).abs() < 1e-4);
    assert!((sh_a.points[0].lon - 25.28).abs() < 1e-4);
    // Sorted by shape_pt_sequence (shape_dist_traveled is monotonic in the fixture)
    assert!(
        sh_a.points[0].shape_dist_traveled.unwrap() < sh_a.points[1].shape_dist_traveled.unwrap()
    );

    // Round-trip through write_shapes + JSON parse
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("p1.bin.shapes.json");
    write_shapes(&out, &shapes).unwrap();
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert_eq!(v["schemaVersion"], 1);
    assert_eq!(v["shapes"].as_array().unwrap().len(), 2);
    // Sidecar keys are camelCase per the spec
    assert_eq!(v["shapes"][0]["shapeId"], "SH_A");
    assert_eq!(v["shapes"][0]["tripRefCount"], 2);
}

#[test]
fn trip_ref_count_dedupes_duplicate_trip_ids_first_wins() {
    // Mirrors the Node mergeSmallFiles keep-first merge: across two feeds a
    // duplicate trip_id (T1) must NOT have its second feed's shape_id counted.
    // Feed 1: T1 -> SH_A. Feed 2: duplicate T1 -> SH_B, plus a fresh T2 -> SH_B.
    // Node keeps feed 1's T1 (SH_A), so SH_B's only live ref is T2 → count 1,
    // and SH_A → count 1. Without dedup the duplicate T1 would inflate SH_B to 2.
    let tmp = tempfile::tempdir().unwrap();
    let feed1 = tmp.path().join("feed1");
    let feed2 = tmp.path().join("feed2");
    std::fs::create_dir_all(&feed1).unwrap();
    std::fs::create_dir_all(&feed2).unwrap();

    let shapes_csv = "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n\
        SH_A,1.0,2.0,1\nSH_A,1.1,2.1,2\nSH_B,3.0,4.0,1\nSH_B,3.1,4.1,2\n";
    std::fs::write(feed1.join("shapes.txt"), shapes_csv).unwrap();
    std::fs::write(feed2.join("shapes.txt"), shapes_csv).unwrap();
    std::fs::write(
        feed1.join("trips.txt"),
        "route_id,service_id,trip_id,shape_id\nR1,WD,T1,SH_A\n",
    )
    .unwrap();
    std::fs::write(
        feed2.join("trips.txt"),
        "route_id,service_id,trip_id,shape_id\nR1,WD,T1,SH_B\nR1,WD,T2,SH_B\n",
    )
    .unwrap();

    let shapes = parse_shapes_all(&[feed1, feed2]).unwrap();
    let sh_a = shapes.iter().find(|s| s.shape_id == "SH_A").unwrap();
    let sh_b = shapes.iter().find(|s| s.shape_id == "SH_B").unwrap();
    assert_eq!(sh_a.trip_ref_count, 1, "SH_A from the kept T1");
    assert_eq!(
        sh_b.trip_ref_count, 1,
        "duplicate T1->SH_B is dropped first-wins; only T2->SH_B counts"
    );
}

#[test]
fn trip_ref_count_shapeless_first_row_suppresses_duplicate_shape() {
    // A first row with no shape_id still claims the trip_id slot, so a later
    // duplicate carrying a shape_id contributes nothing — matching Node, where
    // the kept (shapeless) trip leaves the shape orphaned.
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("feed");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("shapes.txt"),
        "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nSH_X,1.0,2.0,1\nSH_X,1.1,2.1,2\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("trips.txt"),
        "route_id,service_id,trip_id,shape_id\nR1,WD,T1,\nR1,WD,T1,SH_X\n",
    )
    .unwrap();

    let shapes = parse_shapes_all(&[dir]).unwrap();
    let sh_x = shapes.iter().find(|s| s.shape_id == "SH_X").unwrap();
    assert_eq!(
        sh_x.trip_ref_count, 0,
        "first shapeless T1 wins, so the duplicate's SH_X is not counted"
    );
}

#[test]
fn trip_ref_count_feed_without_shape_id_column_suppresses_later_duplicate() {
    // Feed 1's trips.txt omits the optional shape_id column entirely. Node still
    // parses T1 as a (shapeless) trip and merges it by trip_id, so feed 2's
    // duplicate T1 -> SH_B is dropped first-wins and SH_B stays orphaned. The
    // sidecar must claim T1 from feed 1 even though it carries no shape_id, so
    // SH_B's only live ref is feed 2's fresh T2.
    let tmp = tempfile::tempdir().unwrap();
    let feed1 = tmp.path().join("feed1");
    let feed2 = tmp.path().join("feed2");
    std::fs::create_dir_all(&feed1).unwrap();
    std::fs::create_dir_all(&feed2).unwrap();

    let shapes_csv = "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n\
        SH_B,3.0,4.0,1\nSH_B,3.1,4.1,2\n";
    std::fs::write(feed2.join("shapes.txt"), shapes_csv).unwrap();
    // Feed 1: no shape_id column at all.
    std::fs::write(
        feed1.join("trips.txt"),
        "route_id,service_id,trip_id\nR1,WD,T1\n",
    )
    .unwrap();
    std::fs::write(
        feed2.join("trips.txt"),
        "route_id,service_id,trip_id,shape_id\nR1,WD,T1,SH_B\nR1,WD,T2,SH_B\n",
    )
    .unwrap();

    let shapes = parse_shapes_all(&[feed1, feed2]).unwrap();
    let sh_b = shapes.iter().find(|s| s.shape_id == "SH_B").unwrap();
    assert_eq!(
        sh_b.trip_ref_count, 1,
        "feed 1's shapeless T1 wins; feed 2's duplicate T1->SH_B is dropped, only T2->SH_B counts"
    );
}

#[test]
fn shapes_json_empty_array_when_no_shapes_file() {
    // Original tiny-gtfs fixture has no shapes.txt — emit {"schemaVersion":1,"shapes":[]}.
    let shapes = parse_shapes_all(&[
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tiny-gtfs")
    ])
    .unwrap();
    assert_eq!(shapes.len(), 0);
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("p1.bin.shapes.json");
    write_shapes(&out, &shapes).unwrap();
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert!(v["shapes"].is_array());
    assert_eq!(v["shapes"].as_array().unwrap().len(), 0);
}

#[test]
fn shape_point_serialization_skips_null_dist() {
    // shape_dist_traveled is `Option<f32>`; when absent the key should NOT
    // appear in JSON (skip_serializing_if = "Option::is_none"). Keeps the
    // sidecar bytes minimal for feeds that don't carry distances.
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("p1.bin.shapes.json");
    let groups = vec![ShapeGroup {
        shape_id: "X".into(),
        points: vec![ShapePoint {
            lat: 1.0,
            lon: 2.0,
            shape_dist_traveled: None,
        }],
        trip_ref_count: 1,
    }];
    write_shapes(&out, &groups).unwrap();
    let text = std::fs::read_to_string(&out).unwrap();
    assert!(!text.contains("shape_dist_traveled"));
}

#[test]
fn departures_idx_round_trips_from_triples() {
    // Fixed triples (post-finalize): 2 stops, 2 trips.
    let triples: Vec<(u32, u32, u16)> = vec![(0, 1, 1), (0, 0, 2), (1, 0, 1)];
    let trip_starts = [0u32, 2, 3];
    let (offsets, entries) = build_departures_idx_csr(&triples, 2, &trip_starts).unwrap();
    let trips_sha = intern_namespace_sha256(&["T1".to_string(), "T2".to_string()]);
    let stops_sha = intern_namespace_sha256(&["S1".to_string(), "S2".to_string()]);
    let bytes = encode_departures_idx(&offsets, &entries, &trips_sha, &stops_sha).unwrap();

    let idx = DeparturesIdx::parse(&bytes, &trips_sha, &stops_sha).unwrap();
    assert_eq!(idx.num_stops(), 2);
    // entries carry (trip_idx, stopTimeIdx): stop0 → (0,1),(1,2) ; stop1 → (0,0)
    assert_eq!(idx.entries_for(0), vec![(0u32, 1u32), (1, 2)]);
    assert_eq!(idx.entries_for(1), vec![(0u32, 0u32)]);
}

#[test]
fn departures_idx_golden_bytes_unchanged() {
    let triples: Vec<(u32, u32, u16)> = vec![(0, 1, 1), (0, 0, 2), (1, 0, 1)];
    let trip_starts = [0u32, 2, 3];
    let (offsets, entries) = build_departures_idx_csr(&triples, 2, &trip_starts).unwrap();
    // Fixed, content-free SHAs so the golden is stable and independent of the
    // namespace-SHA helper (that helper has its own unit tests).
    let trips_sha = [0x11u8; 32];
    let stops_sha = [0x22u8; 32];
    let bytes = encode_departures_idx(&offsets, &entries, &trips_sha, &stops_sha).unwrap();

    let golden = std::path::Path::new("tests/fixtures/departures-idx-golden.bin");
    if std::env::var_os("REGEN_GOLDEN").is_some() {
        std::fs::write(golden, &bytes).unwrap();
    }
    let expected = std::fs::read(golden).expect("commit tests/fixtures/departures-idx-golden.bin");
    assert_eq!(
        bytes, expected,
        "departures-idx byte layout drifted; if intentional, REGEN_GOLDEN=1 and recommit"
    );
}

fn golden_shapes() -> Vec<ShapeEncodeInput<'static>> {
    // Fixed, sorted-by-shape_id. SH_A: 3 pts (anchor + 2 deltas); SH_B: 1 pt.
    vec![
        ShapeEncodeInput {
            shape_id: "SH_A",
            points: &[(54.69, 25.28), (54.691, 25.281), (54.692, 25.282)],
            trip_ref_count: 2,
        },
        ShapeEncodeInput {
            shape_id: "SH_B",
            points: &[(54.70, 25.30)],
            trip_ref_count: 1,
        },
    ]
}

#[test]
fn shapes_bin_round_trips_from_inputs() {
    let trips_sha = intern_namespace_sha256(&["T1".to_string(), "T2".to_string()]);
    let stops_sha = intern_namespace_sha256(&["S1".to_string(), "S2".to_string()]);
    let bytes = encode_shapes_bin(&golden_shapes(), &trips_sha, &stops_sha).unwrap();

    let sb = ShapesBin::parse(&bytes, &trips_sha, &stops_sha).unwrap();
    assert_eq!(sb.num_shapes(), 2);
    assert_eq!(sb.lookup("SH_A"), Some(0));
    assert_eq!(sb.lookup("SH_B"), Some(1));
    assert_eq!(sb.trip_ref_count(0), 2);
    assert_eq!(sb.trip_ref_count(1), 1);
    let a = sb.points(0);
    assert_eq!(a.len(), 3);
    // Anchor (absolute i32) + an interior delta-decoded point. Tolerance is the
    // 1e-5 quantization step itself, so a ≥10x quantize/dequantize regression fails.
    assert!((a[0].0 - 54.69).abs() < 1e-5 && (a[0].1 - 25.28).abs() < 1e-5);
    assert!((a[1].0 - 54.691).abs() < 1e-5 && (a[1].1 - 25.281).abs() < 1e-5);
    let b = sb.points(1);
    assert_eq!(b.len(), 1);
    assert!((b[0].0 - 54.70).abs() < 1e-5);
}

#[test]
fn shapes_bin_golden_bytes_unchanged() {
    // Fixed, content-free SHAs so the golden is stable + independent of the
    // namespace-SHA helper (which has its own unit tests).
    let trips_sha = [0x33u8; 32];
    let stops_sha = [0x44u8; 32];
    let bytes = encode_shapes_bin(&golden_shapes(), &trips_sha, &stops_sha).unwrap();

    let golden = std::path::Path::new("tests/fixtures/shapes-bin-golden.bin");
    if std::env::var_os("REGEN_GOLDEN").is_some() {
        std::fs::write(golden, &bytes).unwrap();
    }
    let expected = std::fs::read(golden).expect("commit tests/fixtures/shapes-bin-golden.bin");
    assert_eq!(
        bytes, expected,
        "shapes-bin byte layout drifted; if intentional, REGEN_GOLDEN=1 and recommit"
    );
}
