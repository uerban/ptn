#![cfg(feature = "temporal-experiment")]

use std::fs::{remove_file, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn reset_reference_reports_event_cap_as_incomplete() {
    let path = std::env::temp_dir().join(format!(
        "pt-core-emit-range-ref-{}-{}.json",
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
        .arg("bench-range-ref")
        .arg(tiny)
        .args(["--query-tuples", path.to_str().unwrap()])
        .args(["--window-start", "25000", "--window-end", "30000"])
        .args(["--max-events", "1", "--pattern-mode", "covering-merge"])
        .args(["--iterations", "3", "--warmup", "1"])
        .output()
        .unwrap();
    let _ = remove_file(&path);

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let data: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(data["queryCount"], 1);
    assert_eq!(data["iterations"], 3);
    assert_eq!(data["warmup"], 1);
    assert!(data["queries"][0]["p50Ms"].as_f64().unwrap() >= 0.0);
    assert!(
        data["queries"][0]["p95Ms"].as_f64().unwrap()
            >= data["queries"][0]["p50Ms"].as_f64().unwrap()
    );
    assert_eq!(data["queries"][0]["totalEvents"], 2);
    assert_eq!(data["queries"][0]["examinedEvents"], 1);
    assert_eq!(data["queries"][0]["incomplete"], true);
    assert_eq!(
        data["queries"][0]["samples"][0]["eventOriginReadySecs"],
        25200
    );
    assert_eq!(data["queries"][0]["samples"][0]["firstBoardSecs"], 25200);
}

#[test]
fn reset_reference_respects_each_tuples_departure_anchor() {
    let path = std::env::temp_dir().join(format!(
        "pt-core-emit-range-ref-anchors-{}-{}.json",
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
    file.write_all(br#"{"tuples":[{"entryStops":[{"stopId":"S1","walkSecs":0}],"exitStops":[{"stopId":"S3","walkSecs":0}],"date":"20260505","departureSecs":25000},{"entryStops":[{"stopId":"S1","walkSecs":0}],"exitStops":[{"stopId":"S3","walkSecs":0}],"date":"20260505","departureSecs":28000}]}"#).unwrap();
    drop(file);
    let tiny = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb");
    let output = Command::new(env!("CARGO_BIN_EXE_pt-core-emit"))
        .arg("bench-range-ref")
        .arg(tiny)
        .args(["--query-tuples", path.to_str().unwrap()])
        .args(["--window-start", "25000", "--window-end", "30000"])
        .args(["--max-events", "1", "--pattern-mode", "covering-merge"])
        .args(["--iterations", "2", "--warmup", "0"])
        .output()
        .unwrap();
    let _ = remove_file(&path);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let data: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(data["queryCount"], 2);
    assert_eq!(data["queries"][0]["samples"][0]["eventBoardSecs"], 25200);
    assert_eq!(data["queries"][1]["samples"][0]["eventBoardSecs"], 28800);
}
