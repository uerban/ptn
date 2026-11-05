use std::fs::{remove_file, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

struct TempFile(std::path::PathBuf);

static NEXT_TEMP_FILE: AtomicU64 = AtomicU64::new(0);

impl TempFile {
    fn new(contents: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is after the Unix epoch")
            .as_nanos();
        let sequence = NEXT_TEMP_FILE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "pt-core-emit-bench-tuples-{}-{nonce}-{sequence}.json",
            std::process::id()
        ));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .expect("create temporary tuple file");
        file.write_all(contents.as_bytes())
            .expect("write temporary tuple file");
        Self(path)
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = remove_file(&self.0);
    }
}

fn tiny_ptb() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

fn run_bench(tuple_file: Option<&Path>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_pt-core-emit"));
    command.arg("bench").arg(tiny_ptb());
    if let Some(path) = tuple_file {
        command.args([
            "--query-tuples",
            path.to_str().expect("temporary path is UTF-8"),
        ]);
    }
    command.args(["--iterations", "1", "--warmup", "0"]);
    command.output().expect("run pt-core-emit bench")
}

fn run_malformed_tuples(contents: &str) -> Output {
    let tuples = TempFile::new(contents);
    run_bench(Some(tuples.path()))
}

#[test]
fn bench_accepts_valid_query_tuples() {
    let tuples = TempFile::new(
        r#"{
            "tuples": [{
                "_note": "tiny direct smoke tuple",
                "entryStops": [{"stopId": "S1", "walkSecs": 0}],
                "exitStops": [{"stopId": "S3", "walkSecs": 0}],
                "date": "20260505",
                "departureSecs": 25000
            }]
        }"#,
    );
    let tiny_ptb = tiny_ptb();

    let output = Command::new(env!("CARGO_BIN_EXE_pt-core-emit"))
        .args([
            "bench",
            tiny_ptb.to_str().expect("fixture path is UTF-8"),
            "--query-tuples",
            tuples.path().to_str().expect("temporary path is UTF-8"),
            "--pattern-mode",
            "covering-merge",
            "--iterations",
            "2",
            "--warmup",
            "0",
        ])
        .output()
        .expect("run pt-core-emit bench");

    assert!(
        output.status.success(),
        "bench failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8(output.stdout).expect("bench output is UTF-8");
    let json: serde_json::Value = serde_json::from_str(&stdout).expect("bench output is JSON");
    assert_eq!(json["query_count"], 1);
    assert_eq!(json["nonempty_result_count"], 1);
    let row = &json["queries"][0];
    assert_eq!(row["entryStops"][0]["stopId"], "S1");
    assert_eq!(row["exitStops"][0]["stopId"], "S3");
    assert_eq!(row["date"], "20260505");
    assert_eq!(row["departureSecs"], 25000);
    assert!(row["result_len"].as_u64().expect("result_len is numeric") > 0);
}

#[test]
fn bench_rejects_unknown_stop_ids() {
    let output = run_malformed_tuples(
        r#"{"tuples":[{"entryStops":[{"stopId":"NOPE","walkSecs":0}],"exitStops":[{"stopId":"S3","walkSecs":0}],"date":"20260505","departureSecs":25000}]}"#,
    );
    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).expect("stderr is UTF-8");
    assert!(stderr.contains("query-tuples: tuples[0].entryStops[0].stopId unknown stop id 'NOPE'"));
}

#[test]
fn bench_rejects_invalid_calendar_dates() {
    let output = run_malformed_tuples(
        r#"{"tuples":[{"entryStops":[{"stopId":"S1","walkSecs":0}],"exitStops":[{"stopId":"S3","walkSecs":0}],"date":"20269999","departureSecs":25000}]}"#,
    );
    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).expect("stderr is UTF-8");
    assert!(stderr.contains("query-tuples: tuples[0].date invalid calendar date '20269999'"));
}

#[test]
fn bench_rejects_dates_outside_the_ptb_window() {
    let output = run_malformed_tuples(
        r#"{"tuples":[{"entryStops":[{"stopId":"S1","walkSecs":0}],"exitStops":[{"stopId":"S3","walkSecs":0}],"date":"20270101","departureSecs":25000}]}"#,
    );
    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).expect("stderr is UTF-8");
    assert!(stderr
        .contains("query-tuples: tuples[0].date '20270101' is outside the PTB service window"));
}

#[test]
fn bench_rejects_empty_tuple_files() {
    let output = run_malformed_tuples(r#"{"tuples":[]}"#);
    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).expect("stderr is UTF-8");
    assert_eq!(
        stderr.trim_end(),
        "pt-core-emit: query-tuples: `tuples` must be a non-empty array"
    );
}

#[test]
fn bench_rejects_empty_entry_and_exit_stop_vectors() {
    let entry_empty = run_malformed_tuples(
        r#"{"tuples":[{"entryStops":[],"exitStops":[{"stopId":"S3","walkSecs":0}],"date":"20260505","departureSecs":25000}]}"#,
    );
    assert!(!entry_empty.status.success());
    assert!(String::from_utf8(entry_empty.stderr)
        .expect("stderr is UTF-8")
        .contains("query-tuples: tuples[0].entryStops must be non-empty"));

    let exit_empty = run_malformed_tuples(
        r#"{"tuples":[{"entryStops":[{"stopId":"S1","walkSecs":0}],"exitStops":[],"date":"20260505","departureSecs":25000}]}"#,
    );
    assert!(!exit_empty.status.success());
    assert!(String::from_utf8(exit_empty.stderr)
        .expect("stderr is UTF-8")
        .contains("query-tuples: tuples[0].exitStops must be non-empty"));
}

#[test]
fn bench_rejects_a_manifest_pinned_to_a_different_ptb() {
    let manifest = format!(
        r#"{{"ptbSha256":"{}","tuples":[{{"entryStops":[{{"stopId":"S1","walkSecs":0}}],"exitStops":[{{"stopId":"S3","walkSecs":0}}],"date":"20260505","departureSecs":25000}}]}}"#,
        "0".repeat(64)
    );
    let output = run_malformed_tuples(&manifest);
    assert!(!output.status.success());
    assert!(String::from_utf8(output.stderr)
        .unwrap()
        .contains("ptbSha256 does not match the PTB bytes"));
}

#[test]
fn bench_without_query_tuples_keeps_the_embedded_profile() {
    let output = run_bench(None);
    assert!(
        output.status.success(),
        "bench failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("bench output is UTF-8");
    assert!(stdout.contains("\"name\": \"tiny/default-direct\""));
    assert!(!stdout.contains("query_tuples_path"));
}
