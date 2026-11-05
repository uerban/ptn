//! Stage 5 sub-fix C: assert that `--log-format=json` produces at least one
//! emitted line that parses as JSON with the required structured fields
//! (`level`, `msg`, `timestamp`). Counterpart for `--log-format=text` is
//! kept narrow (just confirm we don't accidentally emit JSON braces) so
//! a future format-tweak doesn't constrain wording.

use std::process::{Command, Stdio};
use std::time::Duration;

fn workspace_root() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn pt_serve_binary() -> std::path::PathBuf {
    let target_dir = workspace_root().join("target");
    // Release first — `cargo test` doesn't auto-build the bin, so the
    // user must have run `cargo build --release --bin pt-serve` or
    // `cargo build --bin pt-serve`. Release tends to be the freshest in
    // CI; debug is the common dev flow. Either is fine.
    for profile in &["release", "debug"] {
        let p = target_dir.join(profile).join("pt-serve");
        if p.exists() {
            return p;
        }
    }
    target_dir.join("debug").join("pt-serve")
}

fn require_binary() -> bool {
    if !pt_serve_binary().exists() {
        eprintln!(
            "log_format: SKIP — pt-serve binary not built at {:?}",
            pt_serve_binary()
        );
        return false;
    }
    true
}

/// Spawn pt-serve with a deliberately invalid pidfile parent so it exits
/// quickly during startup — but AFTER emitting at least one structured log
/// line about the pidfile / sentinel / config phase. The exit path is
/// deterministic; the side-effect we assert is the format of the stderr
/// output.
#[test]
fn json_log_format_emits_parseable_records() {
    if !require_binary() {
        return;
    }

    // Use a tempdir as data_root + a non-existent pidfile parent so the
    // process fails the config validate path AND emits the structured
    // error record. We assert against the validate-failure record which
    // is hard-coded as a plain prefix; instead, request the
    // sentinel/pidfile success path by giving a valid data_root and
    // pidfile parent, then point at a nonexistent generation forcing
    // a load-fail.
    let dir = tempfile::TempDir::new().expect("tempdir");
    // No current.json — startup load will fail; we emit structured logs
    // for pidfile_acquired (Info) + sentinel_verify_ok (Info) BEFORE the
    // failure.
    let pidfile = dir.path().join("pt-serve.pid");

    // No current.json AND no last-good.json in the dir → startup load fails
    // fast after pidfile_acquired + sentinel_verify_ok. We let it run to
    // completion (it self-exits with code 1) rather than killing, so the
    // pipe captures the full stderr stream.
    let output = Command::new(pt_serve_binary())
        .args([
            "--city-slug=vilnius",
            "--data-root",
            dir.path().to_str().unwrap(),
            "--pidfile-path",
            pidfile.to_str().unwrap(),
            "--max-rss-bytes=1073741824",
            "--process-fixed-overhead-bytes=200000000",
            "--per-worker-overhead-bytes=50000000",
            "--log-format=json",
            "--listen-addr=127.0.0.1:0",
            "--metrics-listen-addr=127.0.0.1:0",
            // Ephemeral loopback listener (Stage-C C2c) so parallel test
            // binaries don't collide on the fixed default 0.0.0.0:9002.
            "--loopback-listen-addr=127.0.0.1:0",
        ])
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .stdin(Stdio::null())
        .output()
        .expect("spawn + wait pt-serve");

    let stderr = String::from_utf8_lossy(&output.stderr);
    // Sanity: the process should have exited non-zero (load failure path).
    assert!(
        !output.status.success(),
        "expected pt-serve to exit non-zero with no pointer files; stderr was:\n{stderr}\nstatus={:?}",
        output.status
    );
    let _ = Duration::from_millis(0); // keep `Duration` import live

    // Find at least one line that's a JSON object with the required fields.
    let mut found_structured = false;
    for line in stderr.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
            continue;
        }
        // Naive check: required keys must all appear. Avoiding a serde dep
        // here means we substring-match — fine for an assertion test.
        if trimmed.contains("\"timestamp\":")
            && trimmed.contains("\"level\":")
            && trimmed.contains("\"msg\":")
        {
            found_structured = true;
            break;
        }
    }
    assert!(
        found_structured,
        "expected at least one JSON log line with timestamp+level+msg; stderr was:\n{stderr}"
    );

    // CI verify-ran marker — mirrors the pattern in pidfile_race::tmpfs_pidfile_parent_warns_but_does_not_fail.
    // pt-serve-gate.yml greps for this line and fails the job if absent, so a
    // future change that turns `require_binary` into a silent-skip path (e.g.
    // because the host-target binary stopped being built before this test) is
    // caught loudly rather than reported as a passing test that actually skipped.
    eprintln!("json_log_format_emits_parseable_records: ran assertion");
}
