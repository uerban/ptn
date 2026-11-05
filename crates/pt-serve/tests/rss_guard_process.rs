//! process-level guard tests.
//!
//! Two scenarios:
//!
//! - **Over-limit config rejects before bind.** We spawn `pt-serve` with a
//!   1 KiB RSS ceiling that even an empty process would bust. Asserts:
//!     1. exit code ≠ 0 (the guard's `process::exit(1)`),
//!     2. stderr names `rss_guard_reject`, the limit number, and the
//!        estimate number,
//!     3. no port was bound (no "listening on" line on stdout).
//!
//! - **Under-limit config starts and serves /ready.** A 1 GiB ceiling is
//!   already covered by every other test in `tests/server.rs::spawn(...)` —
//!   we cover it here too with an explicit assertion so a future regression
//!   that always-rejects can't ship.
//!
//! The bin path comes from cargo via `CARGO_BIN_EXE_pt-serve`, the same
//! pattern `tests/server.rs` uses; no separate harness or fixture is
//! introduced.

use std::io::{BufRead as _, Read as _};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Startup budgets for the spawned pt-serve, mirroring `server.rs`. Both waits
/// exit as soon as the server is up, so the ceiling only costs time when the
/// server is genuinely broken.
const LISTEN_BUDGET: Duration = Duration::from_secs(30);
const READY_BUDGET: Duration = Duration::from_secs(15);

#[path = "common/mod.rs"]
mod common;

// ----------------------------------------------------------------------------
// Helpers — kept self-contained so this file doesn't import `tests/server.rs`.
// ----------------------------------------------------------------------------

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

/// Mirror of `tests/server.rs::seed_data_root` (no transfers variant). The
/// duplication keeps each integration-test binary self-contained — cargo's
/// per-binary dead-code lint complains when only one of N tests uses a
/// helper, and the publisher module already lives under `tests/common/`.
fn seed_data_root() -> (tempfile::TempDir, String) {
    let dir = tempfile::TempDir::new().expect("tempdir");
    let bundle_bytes = std::fs::read(tiny_ptb_path()).expect("read tiny.ptb");
    let bundle_sha = common::publisher::sha256_hex(&bundle_bytes);
    let id = pt_shared::manifest::publication_id(&bundle_sha, &"0".repeat(64));
    let gen_dir = dir.path().join("generations").join(&id);
    std::fs::create_dir_all(&gen_dir).expect("create gen dir");
    std::fs::write(gen_dir.join("bundle.ptb"), &bundle_bytes).expect("write bundle");

    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let created_at = common::publisher::rfc3339_format(now_unix);

    let manifest = serde_json::json!({
        "manifestSchemaVersion": 2,
        "generationId": id,
        "citySlug": "vilnius",
        "bundleSha256": bundle_sha,
        "publicationInputsSha256": "0".repeat(64),
        "bundleSizeBytes": bundle_bytes.len() as u64,
        "feedStartDate": common::publisher::feed_start_date_of(&bundle_bytes),
        "hasTransfers": false,
        "transfersSha256": serde_json::Value::Null,
        "transfersSizeBytes": serde_json::Value::Null,
        "createdAt": created_at,
    });
    std::fs::write(
        gen_dir.join("generation.json"),
        serde_json::to_string_pretty(&manifest).expect("manifest"),
    )
    .expect("write manifest");

    let pointer = serde_json::json!({
        "manifestSchemaVersion": 2,
        "generationId": id,
        "citySlug": "vilnius",
        "createdAt": created_at,
    });
    std::fs::write(
        dir.path().join("current.json"),
        serde_json::to_string_pretty(&pointer).expect("pointer"),
    )
    .expect("write current.json");

    (dir, id)
}

/// Common argv builder. The RSS knobs are caller-supplied because that's the
/// thing under test; everything else is the canonical "small-test" config.
fn pt_serve_command(
    data_root_path: &std::path::Path,
    max_rss_bytes: u64,
    process_fixed_overhead_bytes: u64,
    per_worker_overhead_bytes: u64,
) -> Command {
    let bin = env!("CARGO_BIN_EXE_pt-serve");
    let mut cmd = Command::new(bin);
    cmd.args([
        "--listen-addr",
        "127.0.0.1:0",
        "--metrics-listen-addr",
        "127.0.0.1:0",
        // Ephemeral loopback listener (Stage-C C2c) so parallel test binaries
        // don't collide on the fixed default 0.0.0.0:9002.
        "--loopback-listen-addr",
        "127.0.0.1:0",
        "--data-root",
        data_root_path.to_str().unwrap(),
        "--pidfile-path",
        data_root_path.join("pt-serve.pid").to_str().unwrap(),
        "--city-slug",
        "vilnius",
        // The fixture has no cityTzIana in its manifest; supply the operator
        // default so the T13 tz cross-check passes and startup reaches the
        // RSS guard this test exercises.
        "--city-tz-iana-default",
        "Europe/Vilnius",
        "--worker-pool-size",
        "2",
        "--max-rss-bytes",
        &max_rss_bytes.to_string(),
        "--process-fixed-overhead-bytes",
        &process_fixed_overhead_bytes.to_string(),
        "--per-worker-overhead-bytes",
        &per_worker_overhead_bytes.to_string(),
    ]);
    cmd
}

// ----------------------------------------------------------------------------
// Step 5 — process-level: over-limit config exits non-zero before bind.
// ----------------------------------------------------------------------------

#[test]
fn over_limit_config_exits_non_zero_before_bind() {
    let (data_root, _id) = seed_data_root();
    // 1 KiB ceiling + 1 MiB overhead → the overhead alone busts the limit.
    let mut cmd = pt_serve_command(data_root.path(), 1024, 1_048_576, 524_288);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().expect("spawn pt-serve");

    // 5s wait for the child to exit. The guard runs synchronously before
    // listener bind so the actual exit takes < 1s on every supported runner;
    // the 5s budget covers slow CI cold-starts (clap parse + manifest load +
    // mmap + Index::build over tiny.ptb).
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stderr = String::new();
                if let Some(mut s) = child.stderr.take() {
                    let _ = s.read_to_string(&mut stderr);
                }
                let mut stdout = String::new();
                if let Some(mut s) = child.stdout.take() {
                    let _ = s.read_to_string(&mut stdout);
                }
                assert!(
                    !status.success(),
                    "expected non-zero exit, got {status:?}\nstdout:\n{stdout}\nstderr:\n{stderr}"
                );
                // Headline tags from the JSON record + the human-readable
                // fallback line. Both must appear so an operator using
                // either parsing path can identify the cause.
                assert!(
                    stderr.contains("rss_guard_reject"),
                    "stderr missing rss_guard_reject tag:\n{stderr}"
                );
                assert!(
                    stderr.contains("estimate"),
                    "stderr missing the word 'estimate':\n{stderr}"
                );
                assert!(
                    stderr.contains("limit"),
                    "stderr missing the word 'limit':\n{stderr}"
                );
                // The fallback line carries the literal limit number.
                assert!(
                    stderr.contains("1024"),
                    "stderr missing the 1024-byte limit literal:\n{stderr}"
                );
                // Belt-and-braces: the server must NOT have advertised a
                // listener address before bailing. Stdout's "listening on"
                // line is produced AFTER the WorkerPool bind in main.rs.
                assert!(
                    !stdout.contains("pt-serve listening on"),
                    "guard fired AFTER bind — stdout contains a listen line:\n{stdout}"
                );
                return;
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    panic!("pt-serve did not exit within 5s under over-limit RSS budget");
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = child.kill();
                panic!("try_wait error: {e}");
            }
        }
    }
}

// ----------------------------------------------------------------------------
// Step 5 — process-level: just-under-limit config starts and serves /ready.
// ----------------------------------------------------------------------------

#[test]
fn under_limit_config_starts_and_serves_ready() {
    let (data_root, _id) = seed_data_root();
    // 1 GiB ceiling, the standard test sentinel — matches `default_test_config`
    // and `tests/server.rs::spawn(...)`. tiny.ptb (~few KB) trivially fits.
    let mut cmd = pt_serve_command(data_root.path(), 1_073_741_824, 200_000_000, 50_000_000);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().expect("spawn pt-serve");

    // Read stdout in a helper thread, looking for the "listening on" line.
    // Same pattern as `tests/server.rs::spawn` — duplicated here to avoid
    // an inter-integration-test dependency.
    let stdout = child.stdout.take().expect("stdout piped");
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = tx.send(None);
                    break;
                }
                Ok(_) => {
                    let trimmed = line.trim();
                    if let Some(rest) = trimmed.strip_prefix("pt-serve listening on ") {
                        let _ = tx.send(Some(rest.to_string()));
                        break;
                    }
                }
                Err(_) => {
                    let _ = tx.send(None);
                    break;
                }
            }
        }
    });

    let base = match rx.recv_timeout(LISTEN_BUDGET) {
        Ok(Some(base)) => base,
        Ok(None) => {
            let _ = child.kill();
            panic!("pt-serve exited before printing its bound address (under-limit config)");
        }
        Err(_) => {
            let _ = child.kill();
            panic!(
                "pt-serve did not print its bound address within {LISTEN_BUDGET:?} (under-limit config)"
            );
        }
    };

    // Poll /ready every 50 ms until READY_BUDGET expires. Same shape as
    // server.rs, including the deliberately generous budget: this file's tests
    // run in parallel with the rest of the crate's, so a tight ceiling turns
    // machine contention into a spurious failure.
    let host_port = base.trim_start_matches("http://").to_string();
    let mut ready = false;
    let deadline = Instant::now() + READY_BUDGET;
    while Instant::now() < deadline {
        if let Ok(stream) = TcpStream::connect(&host_port) {
            drop(stream); // just probing that the listener exists
                          // Make a real /ready GET via ureq.
            let url = format!("{base}/ready");
            if let Ok(resp) = ureq::get(&url).call() {
                if resp.status() == 200 {
                    ready = true;
                    break;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    // Kill the child before unwinding — independent of pass/fail so a
    // failing assertion below doesn't leave a stray pt-serve running.
    let _ = child.kill();
    let _ = child.wait();

    assert!(
        ready,
        "pt-serve did not become ready within {READY_BUDGET:?} under-limit"
    );
}
