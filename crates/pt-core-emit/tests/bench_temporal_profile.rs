#![cfg(feature = "temporal-experiment")]

use std::fs::{remove_file, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn temporal_profile_applies_ptft_and_reports_m4_points() {
    let path = std::env::temp_dir().join(format!(
        "pt-core-emit-temporal-profile-{}-{}.json",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    file.write_all(br#"{"tuples":[{"entryStops":[{"stopId":"s0","walkSecs":0}],"exitStops":[{"stopId":"s2","walkSecs":0}],"date":"20260505","departureSecs":25000}]}"#).unwrap();
    drop(file);

    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/frontend/tests/services/__fixtures__");
    let output = Command::new(env!("CARGO_BIN_EXE_pt-core-emit"))
        .arg("bench-temporal-profile")
        .arg(fixtures.join("footpath.ptb"))
        .arg(fixtures.join("footpath-transfers.bin"))
        .args(["--query-tuples", path.to_str().unwrap()])
        .args(["--window-start", "25000", "--window-end", "27000"])
        .args(["--objective", "m4", "--pattern-mode", "covering-merge"])
        .args(["--iterations", "1", "--warmup", "0"])
        .output()
        .unwrap();
    let _ = remove_file(&path);

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let data: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(data["scope"], "full-temporal-profile");
    assert_eq!(data["objective"], "m4");
    assert!(data["transfersPath"]
        .as_str()
        .unwrap()
        .ends_with("footpath-transfers.bin"));
    assert_eq!(data["queries"][0]["ptftStatus"], "applied");
    assert_eq!(data["queries"][0]["completion"], "window-exhausted");
    assert_eq!(data["queries"][0]["coverageScope"], "supplied-window-only");
    assert_eq!(
        data["queries"][0]["coveredWindow"],
        serde_json::json!([25000, 27000])
    );
    assert_eq!(data["queries"][0]["pageComplete"], true);
    assert_eq!(data["queries"][0]["windowExhausted"], true);
    assert_eq!(
        data["queries"][0]["multiDateStatus"],
        "unsupported-single-service-date-only"
    );
    assert_eq!(data["queries"][0]["profileCount"], 1);
    assert_eq!(data["queries"][0]["points"][0]["departureSecs"], 25200);
    assert_eq!(data["queries"][0]["points"][0]["arrivalSecs"], 25620);
    assert_eq!(data["queries"][0]["points"][0]["actualTransfers"], 0);
    assert_eq!(data["queries"][0]["points"][0]["totalWalkSecs"], 120);
}

#[test]
fn temporal_profile_rejects_tuple_outside_window() {
    let path = std::env::temp_dir().join(format!(
        "pt-core-emit-temporal-profile-invalid-window-{}-{}.json",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    file.write_all(br#"{"tuples":[{"entryStops":[{"stopId":"s0","walkSecs":0}],"exitStops":[{"stopId":"s2","walkSecs":0}],"date":"20260505","departureSecs":27000}]}"#).unwrap();
    drop(file);

    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/frontend/tests/services/__fixtures__");
    let output = Command::new(env!("CARGO_BIN_EXE_pt-core-emit"))
        .arg("bench-temporal-profile")
        .arg(fixtures.join("footpath.ptb"))
        .args(["--query-tuples", path.to_str().unwrap()])
        .args(["--window-start", "25000", "--window-end", "27000"])
        .args(["--objective", "r3", "--pattern-mode", "covering-merge"])
        .args(["--iterations", "1", "--warmup", "0"])
        .output()
        .unwrap();
    let _ = remove_file(&path);

    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("tuple/0: departure 27000 is outside window 25000..27000"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn temporal_profile_routes_v2_and_reports_its_exhaustive_strategy() {
    use pt_core::engine::testkit::{
        build_v2_ptb, utc_origins, ServicePoolSpec, SoaRoute, SoaStop, StopRoutes, V1Feed, V1Trip,
        V2Feed,
    };
    let dir = std::env::temp_dir().join(format!(
        "pt-core-emit-v2-profile-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&dir).unwrap();
    let stops: Vec<_> = ["s0", "s1", "s2"]
        .iter()
        .map(|&id| SoaStop {
            id,
            name: "",
            lat: 0.0,
            lon: 0.0,
            parent: None,
            wheelchair: 0,
        })
        .collect();
    let routes: Vec<_> = ["r0", "r1"]
        .iter()
        .map(|&id| SoaRoute {
            id,
            agency: "",
            short: "",
            long: "",
            color: "",
            text_color: "",
            route_type: 3,
        })
        .collect();
    let trips = [
        V1Trip {
            id: "feeder",
            rows: &[(1, 0, 0), (2, 1, 600)],
            ..V1Trip::default()
        },
        V1Trip {
            id: "trunk",
            route: 1,
            rows: &[(1, 1, 36_720), (2, 2, 37_200)],
            ..V1Trip::default()
        },
    ];
    let bytes = build_v2_ptb(&V2Feed {
        base: V1Feed {
            stops: &stops,
            routes: &routes,
            trips: &trips,
            stop_routes: StopRoutes::Served,
            feed_start_date: 20261001,
            city_tz_offset_seconds: 0,
            services: ServicePoolSpec {
                window_days: 8,
                pool: &[&[0xff]],
                service_to_bitfield: &[0],
            },
            transfers: &[],
            boarding: &[],
            stop_index: false,
        },
        origins: &utc_origins(20261001, 8, 0),
        blocks: &[None, None],
        feed_rank: 0,
        derive_block_inseat: false,
        frequencies: &[(0, 36_000, 36_601, 600, 1)],
        quarantined_frequency_trips: &[],
        strip_carry: true,
    });
    let bundle = dir.join("v2.ptb");
    let tuples = dir.join("tuples.json");
    std::fs::write(&bundle, bytes).unwrap();
    std::fs::write(&tuples, br#"{"tuples":[{"entryStops":[{"stopId":"s0","walkSecs":0}],"exitStops":[{"stopId":"s2","walkSecs":0}],"date":"20261004","departureSecs":36000}]}"#).unwrap();
    let run = |engine: &str, extra: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_pt-core-emit"))
            .arg("bench-temporal-profile")
            .arg(&bundle)
            .arg("--query-tuples")
            .arg(&tuples)
            .args([
                "--window-start",
                "36000",
                "--window-end",
                "36001",
                "--objective",
                "m4",
                "--pattern-mode",
                "covering-merge",
                "--iterations",
                "1",
                "--warmup",
                "0",
                "--engine",
                engine,
            ])
            .args(extra)
            .output()
            .unwrap()
    };
    for engine in ["label", "round", "compare"] {
        let output = run(engine, &[]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let data: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(data["engine"], engine);
        assert_eq!(data["maxRounds"], 4);
        assert_eq!(data["ptbSha256"].as_str().unwrap().len(), 64);
        let query = if engine == "compare" {
            let comparison = &data["queries"][0];
            assert_eq!(comparison["objectiveParity"], "equal");
            assert_eq!(
                comparison["label"]["objectiveSha256"],
                comparison["round"]["objectiveSha256"]
            );
            &comparison["round"]
        } else {
            &data["queries"][0]
        };
        assert_eq!(query["multiDateStatus"], "service-day-origins");
        assert_eq!(
            query["searchStrategy"],
            if engine == "label" {
                "bounded-exhaustive-v2"
            } else {
                "round-pattern-frontier-v2"
            }
        );
        assert_eq!(query["profileCount"], 1);
        assert_eq!(query["points"][0]["departureSecs"], 36_000);
        assert_eq!(query["points"][0]["arrivalSecs"], 37_200);
        assert_eq!(query["points"][0]["actualTransfers"], 1);
        assert!(
            query["pageComplete"].as_bool().unwrap() && query["windowExhausted"].as_bool().unwrap()
        );
        let limited = run(engine, &["--max-rounds", "1"]);
        assert!(
            limited.status.success(),
            "{}",
            String::from_utf8_lossy(&limited.stderr)
        );
        let data: serde_json::Value = serde_json::from_slice(&limited.stdout).unwrap();
        assert_eq!(data["maxRounds"], 1);
        let query = if engine == "compare" {
            &data["queries"][0]["round"]
        } else {
            &data["queries"][0]
        };
        assert_eq!(
            query["profileCount"], 0,
            "the target requires a second boarding"
        );
        assert!(query["windowExhausted"].as_bool().unwrap());
    }
    let exact = run("round", &["--round-scan", "exact"]);
    let bounded = run("round", &["--round-scan", "bounded"]);
    assert!(exact.status.success() && bounded.status.success());
    let exact: serde_json::Value = serde_json::from_slice(&exact.stdout).unwrap();
    let bounded: serde_json::Value = serde_json::from_slice(&bounded.stdout).unwrap();
    assert_eq!(exact["roundScan"], "exact");
    assert_eq!(bounded["roundScan"], "bounded");
    assert_eq!(
        exact["queries"][0]["searchStrategy"],
        "round-pattern-exact-v2"
    );
    assert_eq!(
        exact["queries"][0]["roundDiagnostics"]["boundedPatternScans"],
        0
    );
    assert!(
        bounded["queries"][0]["roundDiagnostics"]["boundedPatternScans"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert_eq!(
        exact["queries"][0]["objectiveSha256"],
        bounded["queries"][0]["objectiveSha256"]
    );
    for reference in [&exact, &bounded] {
        assert_eq!(
            reference["queries"][0]["roundDiagnostics"]["sourceFrontierPatterns"],
            0
        );
    }
    let frontier = run("round", &["--round-scan", "frontier"]);
    assert!(frontier.status.success());
    let frontier: serde_json::Value = serde_json::from_slice(&frontier.stdout).unwrap();
    assert_eq!(frontier["roundScan"], "frontier");
    assert_eq!(
        frontier["queries"][0]["searchStrategy"],
        "round-pattern-frontier-v2"
    );
    assert!(
        frontier["queries"][0]["roundDiagnostics"]["sourceFrontierPatterns"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert_eq!(
        exact["queries"][0]["objectiveSha256"],
        frontier["queries"][0]["objectiveSha256"]
    );
    let failed = run("compare", &["--max-board-candidates", "1"]);
    assert!(!failed.status.success());
    assert!(
        failed.stdout.is_empty(),
        "no benchmark report may escape a resource error"
    );
    assert!(String::from_utf8_lossy(&failed.stderr).contains("BoardCandidatesExhausted"));
    for invalid in ["0", "4294967296", "not-a-number"] {
        let output = run("compare", &["--max-rounds", invalid]);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8_lossy(&output.stderr).contains("--max-rounds"));
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn temporal_profile_rejects_unknown_engine_before_input_io() {
    let out = Command::new(env!("CARGO_BIN_EXE_pt-core-emit"))
        .args(["bench-temporal-profile", "--engine", "unknown"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("--engine must be label, round or compare")
    );
    let out = Command::new(env!("CARGO_BIN_EXE_pt-core-emit"))
        .args(["bench-temporal-profile", "--round-scan", "unknown"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr)
        .contains("--round-scan must be exact, bounded or frontier"));
}
