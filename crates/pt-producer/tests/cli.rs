use pt_producer::cli::Args;

#[test]
fn url_from_env_when_no_flag() {
    let parsed = Args::try_parse_from_with_env(
        ["pt-producer"],
        &[("GTFS_STATIC_URL", "https://example.com/feed.zip")],
    )
    .unwrap();
    assert_eq!(
        parsed.gtfs_url.as_deref(),
        Some("https://example.com/feed.zip")
    );
    assert!(parsed.gtfs_path.is_empty());
}

#[test]
fn gtfs_path_is_repeatable_for_multi_feed_cities() {
    // Krakow ships three agency feeds. A memory capture stages them as local
    // zips, so the local-path flag has to union the same way a comma-separated
    // --gtfs-url does; a single-feed run would see ~1/3 of stop_times and bank a
    // baseline that is small by construction rather than by merit.
    let parsed = Args::try_parse_from_with_env(
        [
            "pt-producer",
            "--gtfs-path",
            "a.zip",
            "--gtfs-path",
            "b.zip",
            "--gtfs-path",
            "c.zip",
        ],
        &[],
    )
    .unwrap();
    assert_eq!(
        parsed
            .gtfs_path
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        vec!["a.zip", "b.zip", "c.zip"],
        "feed order must be preserved — it is the union order"
    );
    assert!(parsed.gtfs_url.is_none());
}

#[test]
fn gtfs_path_still_conflicts_with_gtfs_url() {
    // Two sources would silently pick one. Keep it an error.
    let parsed = Args::try_parse_from_with_env(
        [
            "pt-producer",
            "--gtfs-path",
            "a.zip",
            "--gtfs-url",
            "https://example.com/feed.zip",
        ],
        &[],
    );
    assert!(parsed.is_err(), "--gtfs-path and --gtfs-url must conflict");
}

#[test]
fn flag_wins_over_env() {
    let parsed = Args::try_parse_from_with_env(
        [
            "pt-producer",
            "--gtfs-url",
            "https://flag.example.com/x.zip",
        ],
        &[("GTFS_STATIC_URL", "https://env.example.com/y.zip")],
    )
    .unwrap();
    assert_eq!(
        parsed.gtfs_url.as_deref(),
        Some("https://flag.example.com/x.zip")
    );
}

#[test]
fn defaults_match_harness_contract() {
    let parsed = Args::try_parse_from_with_env(["pt-producer"], &[]).unwrap();
    assert_eq!(parsed.listen_addr.to_string(), "0.0.0.0:3000");
    assert_eq!(parsed.idle_after_ingestion_secs, 180);
}

#[test]
fn obsolete_ptb_target_flag_is_rejected() {
    let parsed = Args::try_parse_from_with_env(["pt-producer", "--ptb-target", "5"], &[]);
    assert!(
        parsed.is_err(),
        "the producer must not expose old PTB layouts"
    );
}

#[test]
fn path_and_url_mutually_exclusive() {
    let parsed = Args::try_parse_from_with_env(
        [
            "pt-producer",
            "--gtfs-url",
            "https://x.zip",
            "--gtfs-path",
            "/tmp/x.zip",
        ],
        &[],
    );
    assert!(parsed.is_err());
}

#[test]
fn out_flag_defaults_to_none() {
    let parsed = Args::try_parse_from_with_env(["pt-producer"], &[]).unwrap();
    assert!(parsed.out.is_none(), "--out is opt-in; default is None");
}

#[test]
fn out_flag_parses_path() {
    let parsed =
        Args::try_parse_from_with_env(["pt-producer", "--out", "/tmp/p1-vilnius.ptnb"], &[])
            .unwrap();
    assert_eq!(
        parsed.out.as_deref(),
        Some(std::path::Path::new("/tmp/p1-vilnius.ptnb"))
    );
}

/// `build-schedule-tiles` is the tile-step-only entry point the differential
/// workflow's comment says the producer lacks ("no tile-step-only entry point
/// (only `periodic-refresh`/`republish`, both of which run the full publish)").
#[test]
fn build_schedule_tiles_parses_gen_dir_and_city() {
    let parsed = Args::try_parse_from_with_env(
        [
            "pt-producer",
            "build-schedule-tiles",
            "--gen-dir",
            "/tmp/gen/abc",
            "--city",
            "vilnius",
        ],
        &[],
    )
    .unwrap();
    match parsed.command {
        Some(pt_producer::cli::Command::BuildScheduleTiles {
            gen_dir,
            city,
            gen_id,
        }) => {
            assert_eq!(gen_dir, std::path::Path::new("/tmp/gen/abc"));
            assert_eq!(city, "vilnius");
            // Defaulting to the bundle's own sha256 is what makes the common
            // case correct without an argument; see the runner's doc comment.
            assert!(gen_id.is_none(), "--gen-id is an optional cross-check");
        }
        other => panic!("expected BuildScheduleTiles, got {other:?}"),
    }
}

#[test]
fn build_schedule_tiles_carries_an_explicit_gen_id() {
    let parsed = Args::try_parse_from_with_env(
        [
            "pt-producer",
            "build-schedule-tiles",
            "--gen-dir",
            "/tmp/gen/abc",
            "--city",
            "paris",
            "--gen-id",
            "deadbeef",
        ],
        &[],
    )
    .unwrap();
    match parsed.command {
        Some(pt_producer::cli::Command::BuildScheduleTiles { gen_id, .. }) => {
            assert_eq!(gen_id.as_deref(), Some("deadbeef"));
        }
        other => panic!("expected BuildScheduleTiles, got {other:?}"),
    }
}

#[test]
fn build_schedule_tiles_requires_gen_dir_and_city() {
    assert!(
        Args::try_parse_from_with_env(["pt-producer", "build-schedule-tiles"], &[]).is_err(),
        "--gen-dir and --city are both mandatory"
    );
}

#[test]
fn managed_osm_inputs_are_explicit_and_conflict_with_mutable_fixture_paths() {
    let base = [
        "pt-producer",
        "periodic-refresh",
        "--data-root",
        "/data",
        "--city",
        "vilnius",
        "--gtfs",
        "/feed.zip",
        "--osm-artifact-root",
        "/artifacts",
    ];
    let args = Args::try_parse_from_with_env(base, &[]).unwrap();
    assert!(matches!(
        args.command,
        Some(pt_producer::cli::Command::PeriodicRefresh {
            osm_artifact_root: Some(_),
            ..
        })
    ));
    let mut conflicting = base.to_vec();
    conflicting.extend(["--city-osm-dir", "/mutable"]);
    assert!(Args::try_parse_from_with_env(conflicting, &[]).is_err());
}
