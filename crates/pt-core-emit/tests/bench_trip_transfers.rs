#![cfg(feature = "temporal-experiment")]

use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

/// A PTB v2 feeder s0→s1, a PTFT walk s1→s2 and a trunk s2→s3 on 20261004.
fn fixture() -> (PathBuf, PathBuf) {
    use pt_core::engine::testkit::{
        build_ptft, build_v2_ptb, utc_origins, ServicePoolSpec, SoaRoute, SoaStop, StopRoutes,
        V1Feed, V1Trip, V2Feed,
    };
    let dir = std::env::temp_dir().join(format!(
        "pt-core-emit-trip-transfers-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&dir).unwrap();
    let ids = ["s0", "s1", "s2", "s3"];
    let stops: Vec<_> = ids
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
            rows: &[(1, 0, 36_000), (2, 1, 36_600)],
            ..V1Trip::default()
        },
        V1Trip {
            id: "trunk",
            route: 1,
            rows: &[(1, 2, 37_200), (2, 3, 37_800)],
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
        frequencies: &[],
        quarantined_frequency_trips: &[],
        strip_carry: true,
    });
    let bundle = dir.join("v2.ptb");
    let walks = dir.join("transfers.bin");
    std::fs::write(&bundle, bytes).unwrap();
    std::fs::write(&walks, build_ptft(&ids, &[&[], &[(2, 120)], &[], &[]])).unwrap();
    (bundle, walks)
}

fn run(extra: &[&str]) -> (bool, serde_json::Value, String, String) {
    let (bundle, walks) = fixture();
    let output = Command::new(env!("CARGO_BIN_EXE_pt-core-emit"))
        .arg("bench-trip-transfers")
        .arg(&bundle)
        .arg(&walks)
        .args(["--date", "20261004", "--window-start", "36000"])
        .args(["--window-end", "40000", "--pattern-mode", "covering-merge"])
        .args(extra)
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let data = serde_json::from_slice(&output.stdout).unwrap_or(serde_json::Value::Null);
    let ptb_sha256 = format!("{:x}", Sha256::digest(std::fs::read(&bundle).unwrap()));
    std::fs::remove_dir_all(bundle.parent().unwrap()).unwrap();
    (output.status.success(), data, stderr, ptb_sha256)
}

#[test]
fn trip_transfers_reports_unreduced_size_and_binding() {
    let (ok, data, stderr, ptb_sha256) = run(&[]);
    assert!(ok, "{stderr}");
    assert_eq!(data["scope"], "unreduced-trip-transfers");
    assert_eq!(data["status"], "completed");
    assert_eq!(data["coveredWindow"], serde_json::json!([36000, 40000]));
    assert_eq!(data["mobility"], "default");
    assert_eq!(data["binding"]["ptbSha256"], ptb_sha256);
    assert!(data["binding"]["ptftSha256"].is_string());
    let d = &data["diagnostics"];
    assert_eq!(d["events"], 4);
    assert_eq!(d["arrivalSources"], 2);
    assert_eq!(d["boardingEvents"], 2);
    let edges = d["edges"].as_u64().unwrap();
    assert_eq!(edges, 1);
    let by_kind: u64 = d["edgesByKind"]
        .as_object()
        .unwrap()
        .values()
        .map(|v| v.as_u64().unwrap())
        .sum();
    assert_eq!(by_kind, edges);
    assert_eq!(d["edgesByKind"]["footpath"], 1);
    assert!(d["peakBuildBytes"].as_u64() >= d["indexBytes"].as_u64());
    assert!(data["buildMs"].as_f64().unwrap() >= 0.0);
}

#[test]
fn trip_transfers_retains_a_failed_build_without_sizes() {
    let (ok, data, stderr, _) = run(&["--max-events", "1"]);
    assert!(ok, "{stderr}");
    assert_eq!(data["status"], "failed");
    assert_eq!(data["error"]["kind"], "events-exhausted");
    assert_eq!(data["error"]["limit"], 1);
    assert_eq!(data["error"]["attempted"], 2);
    assert!(data["diagnostics"].is_null());
    let (ok, _, stderr, _) = run(&["--mobility", "skateboard"]);
    assert!(!ok);
    assert!(stderr.contains("--mobility"), "{stderr}");
}

#[test]
fn trip_transfers_reports_reduction_separately_from_build() {
    let (ok, data, stderr, _) = run(&["--reduce"]);
    assert!(ok, "{stderr}");
    assert_eq!(data["scope"], "reduced-trip-transfers");
    assert_eq!(data["reduction"]["edgesBefore"], 1);
    assert_eq!(data["reduction"]["edgesAfter"], 1);
    assert_eq!(data["reduction"]["removedEdges"], 0);
    assert!(data["reductionMs"].as_f64().unwrap() >= 0.0);
    let (ok, data, stderr, _) = run(&["--reduce", "--max-events", "1"]);
    assert!(ok, "{stderr}");
    assert_eq!(data["status"], "failed");
    assert!(data["reduction"].is_null());
    assert!(data.get("reductionMs").is_none());
}

#[test]
fn trip_events_reports_linear_storage_and_never_materializes_transfers() {
    let (ok, data, stderr, _) = run(&["--events-only", "--max-edges", "1"]);
    assert!(ok, "{stderr}");
    assert_eq!(data["scope"], "trip-event-catalogue");
    assert_eq!(data["status"], "completed");
    let d = &data["diagnostics"];
    assert_eq!(d["events"], 4);
    assert_eq!(d["arrivalSources"], 2);
    assert_eq!(d["boardingEvents"], 2);
    assert_eq!(d["materializedTransferEdges"], 0);
    assert!(d.get("edges").is_none());
    assert!(data.get("reduction").is_none());
    assert!(d["indexBytes"].as_u64().unwrap() < 1024);
    let (ok, data, stderr, _) = run(&["--events-only", "--max-events", "1"]);
    assert!(ok, "{stderr}");
    assert_eq!(data["status"], "failed");
    assert!(data["diagnostics"].is_null());
    let (ok, _, stderr, _) = run(&["--events-only", "--reduce"]);
    assert!(!ok);
    assert!(stderr.contains("mutually exclusive"));
}

fn deadline(extra: &[&str]) -> serde_json::Value {
    let (bundle, walks) = fixture();
    let tuples = bundle.parent().unwrap().join("queries.json");
    std::fs::write(
        &tuples,
        serde_json::to_vec(&serde_json::json!({"tuples":[{
        "entryStops":[{"stopId":"s0","walkSecs":0}], "exitStops":[{"stopId":"s3","walkSecs":0}],
        "date":"20261004", "departureSecs":36000}]}))
        .unwrap(),
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_pt-core-emit"))
        .arg("bench-trip-deadline")
        .arg(&bundle)
        .arg(&walks)
        .arg("--query-tuples")
        .arg(tuples)
        .args([
            "--window-start",
            "36000",
            "--window-end",
            "36001",
            "--arrival-deadline",
            "37800",
            "--iterations",
            "2",
            "--warmup",
            "0",
        ])
        .args(extra)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result = serde_json::from_slice(&output.stdout).unwrap();
    std::fs::remove_dir_all(bundle.parent().unwrap()).unwrap();
    result
}

#[test]
fn deadline_bench_compares_matched_engines_and_keeps_failed_cells_honest() {
    let result = deadline(&["--engine", "compare"]);
    assert_eq!(result["status"], "completed");
    assert_eq!(result["scope"], "deadline-constrained-r3-m4-experiment");
    assert_eq!(result["fullProfilePromotion"], false);
    let row = &result["queries"][0];
    assert_eq!(row["parity"], "unreduced-graph-and-lazy-canonical-equal");
    assert_eq!(row["measurements"].as_array().unwrap().len(), 2);
    for engine in row["measurements"].as_array().unwrap() {
        assert_eq!(engine["pointCount"], 1);
        assert_eq!(engine["points"][0]["arrivalSecs"], 37800);
        assert_eq!(engine["points"][0]["totalWalkSecs"], 120);
        assert_eq!(engine["complete"], true);
    }
    let failed = deadline(&["--engine", "lazy-all", "--max-lookup-work", "1"]);
    assert_eq!(failed["status"], "failed");
    let row = &failed["queries"][0];
    assert!(row["error"].as_str().unwrap().contains("WorkExhausted"));
    assert!(row.get("measurements").is_none());
    assert!(row.get("points").is_none());
    let pruned = deadline(&["--engine", "compare", "--prefix-bound", "on"]);
    assert_eq!(pruned["status"], "completed");
    assert_eq!(pruned["prefixBound"], "on");
    for measurement in pruned["queries"][0]["measurements"].as_array().unwrap() {
        assert_eq!(measurement["pointCount"], 1);
        assert_eq!(measurement["diagnostics"]["prefix"]["enabled"], true);
        assert!(measurement["prepareP95Ms"].as_f64().unwrap() >= 0.0);
        assert!(measurement["searchP95Ms"].as_f64().unwrap() >= 0.0);
    }
    let points = deadline(&[
        "--engine",
        "compare",
        "--prefix-bound",
        "on",
        "--point-bound",
        "on",
    ]);
    assert_eq!(points["status"], "completed");
    assert_eq!(points["pointBound"], "on");
    assert_eq!(
        points["queries"][0]["measurements"][0]["points"],
        result["queries"][0]["measurements"][0]["points"]
    );
}
