#![cfg(feature = "temporal-experiment")]

use std::fs::{remove_file, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn direct_profile_reports_actual_r3_departure_arrival_tradeoffs() {
    let path = std::env::temp_dir().join(format!(
        "pt-core-emit-direct-{}-{}.json",
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
    file.write_all(br#"{"tuples":[{"entryStops":[{"stopId":"S1","walkSecs":0}],"exitStops":[{"stopId":"S3","walkSecs":0}],"date":"20260505","departureSecs":25000}]}"#).unwrap();
    drop(file);
    let tiny = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb");
    let output = Command::new(env!("CARGO_BIN_EXE_pt-core-emit"))
        .arg("bench-direct-profile")
        .arg(tiny)
        .args(["--query-tuples", path.to_str().unwrap()])
        .args(["--window-start", "25000", "--window-end", "30000"])
        .args(["--objective", "r3", "--pattern-mode", "covering-merge"])
        .output()
        .unwrap();
    let _ = remove_file(&path);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let data: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(data["scope"], "direct-transit-only");
    assert_eq!(data["objective"], "r3");
    assert_eq!(data["iterations"], 20);
    assert_eq!(data["warmup"], 3);
    assert!(
        data["queries"][0]["p95Ms"].as_f64().unwrap()
            >= data["queries"][0]["p50Ms"].as_f64().unwrap()
    );
    assert_eq!(data["queries"][0]["profileCount"], 2);
    assert_eq!(data["queries"][0]["points"][0]["departureSecs"], 28800);
    assert_eq!(data["queries"][0]["points"][0]["arrivalSecs"], 29400);
    assert_eq!(data["queries"][0]["points"][1]["departureSecs"], 25200);
    assert_eq!(data["queries"][0]["points"][1]["arrivalSecs"], 25800);
}
