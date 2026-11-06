//!
//! the producer writes `.producer-data-root-id` with its view of the data root's `device:inode`;
//! pt-serve re-stats the data root at startup and exits non-zero on mismatch.
//!
//! The unit tests in `ops::sentinel::tests` cover the parser + the verifier
//! function. This file drives the BIN: it seeds a data_root, writes a
//! mismatched sentinel, spawns `pt-serve`, and asserts:
//!
//! 1. Exit status is non-zero.
//! 2. stderr carries `sentinel_verify_failed`.
//! 3. stderr names BOTH the producer's recorded inode AND the server's
//!    observed inode (operator runbook ergonomics: the diagnostic must
//!    pinpoint the volume).
//! 4. No listener was bound (the verifier runs BEFORE bind).
//!
//! Positive control: a matching sentinel does NOT block startup.

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

#[path = "common/mod.rs"]
mod common;

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

/// Seed a generation + current.json so the loader CAN start in principle —
/// the sentinel check fires before load_initial_generation regardless, but
/// keeping the data root realistic surfaces any unrelated regression.
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

#[cfg(unix)]
fn stat_dev_ino(p: &Path) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(p).expect("stat");
    (m.dev(), m.ino())
}

fn pt_serve_command(data_root: &Path, pidfile_path: &Path) -> Command {
    let bin = env!("CARGO_BIN_EXE_pt-serve");
    let mut cmd = Command::new(bin);
    cmd.env_remove(pt_shared::data_root_identity::ENV);
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
        data_root.to_str().unwrap(),
        "--pidfile-path",
        pidfile_path.to_str().unwrap(),
        "--city-slug",
        "vilnius",
        // The fixture manifest carries no cityTzIana; supply the operator
        // default so the T13 tz cross-check passes and startup proceeds.
        "--city-tz-iana-default",
        "Europe/Vilnius",
        "--worker-pool-size",
        "2",
        "--max-rss-bytes",
        "1073741824",
        "--process-fixed-overhead-bytes",
        "200000000",
        "--per-worker-overhead-bytes",
        "50000000",
    ]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd
}

/// Spawn pt-serve, wait up to `timeout` for exit, return (status, stdout, stderr).
/// Panics if the process does not exit within the timeout (a sentinel verify
/// failure must surface in well under 1s; we allot 10s to absorb CI jitter).
fn spawn_and_collect_exit(
    mut cmd: Command,
    timeout: Duration,
) -> (std::process::ExitStatus, String, String) {
    let mut child = cmd.spawn().expect("spawn pt-serve");
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                let mut stderr = String::new();
                if let Some(mut s) = child.stdout.take() {
                    let _ = s.read_to_string(&mut stdout);
                }
                if let Some(mut s) = child.stderr.take() {
                    let _ = s.read_to_string(&mut stderr);
                }
                return (status, stdout, stderr);
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("pt-serve did not exit within {timeout:?}");
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => panic!("pt-serve try_wait error: {e}"),
        }
    }
}

fn assert_listens(mut cmd: Command) {
    use std::io::BufRead as _;
    let mut child = cmd.spawn().expect("spawn pt-serve");
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines() {
            match line {
                Ok(line) if line.starts_with("pt-serve listening on ") => {
                    let _ = tx.send(());
                    return;
                }
                Ok(_) => {}
                Err(_) => return,
            }
        }
    });
    let listened = rx.recv_timeout(Duration::from_secs(10)).is_ok();
    let _ = child.kill();
    let _ = child.wait();
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert!(listened, "bound root did not start: {stderr}");
}

#[test]
fn stable_identity_starts_after_restore_and_repeated_restart_without_producer() {
    let (source, id) = seed_data_root();
    let identity = "test-deployment:vilnius";
    pt_shared::data_root_identity::bind(source.path(), identity, Some(&id)).unwrap();
    // Model restoration/remount: all accepted bytes move to a different inode.
    let restored = tempfile::tempdir().unwrap();
    let generation = restored.path().join("generations").join(&id);
    std::fs::create_dir_all(&generation).unwrap();
    for name in ["bundle.ptb", "generation.json"] {
        std::fs::copy(
            source.path().join("generations").join(&id).join(name),
            generation.join(name),
        )
        .unwrap();
    }
    for name in ["current.json", pt_shared::data_root_identity::FILENAME] {
        std::fs::copy(source.path().join(name), restored.path().join(name)).unwrap();
    }
    let (dev, ino) = stat_dev_ino(source.path());
    let legacy = format!(
        "schemaVersion=1\ndeviceInode={}:{}\n",
        dev.wrapping_add(7777),
        ino.wrapping_add(999_999)
    );
    std::fs::write(restored.path().join(".producer-data-root-id"), &legacy).unwrap();
    let pointer = std::fs::read(restored.path().join("current.json")).unwrap();
    for _ in 0..2 {
        let mut cmd = pt_serve_command(restored.path(), &restored.path().join("pt-serve.pid"));
        cmd.env(pt_shared::data_root_identity::ENV, identity);
        assert_listens(cmd);
    }
    assert_eq!(
        std::fs::read(restored.path().join("current.json")).unwrap(),
        pointer
    );
    assert_eq!(
        std::fs::read_to_string(restored.path().join(".producer-data-root-id")).unwrap(),
        legacy
    );
}

#[test]
fn wrong_stable_identity_exits_before_binding_or_advertising_version() {
    let (data_root, id) = seed_data_root();
    pt_shared::data_root_identity::bind(data_root.path(), "other-deployment:vilnius", Some(&id))
        .unwrap();
    let mut cmd = pt_serve_command(data_root.path(), &data_root.path().join("pt-serve.pid"));
    cmd.env(
        pt_shared::data_root_identity::ENV,
        "expected-deployment:vilnius",
    );
    let (status, stdout, stderr) = spawn_and_collect_exit(cmd, Duration::from_secs(10));
    assert!(!status.success());
    assert!(stderr.contains("data-root identity mismatch"), "{stderr}");
    assert!(stderr.contains("sentinel_verify_failed"), "{stderr}");
    assert!(!stdout.contains("pt-serve listening on"));
    assert!(!data_root.path().join("pt-serve.version").exists());
}

// ----------------------------------------------------------------------------
// Test 1 — mismatched sentinel → fail closed before binding listener
// ----------------------------------------------------------------------------

#[test]
#[cfg(unix)]
fn sentinel_mismatch_exits_nonzero_before_bind() {
    let (data_root, _id) = seed_data_root();
    let pidfile = data_root.path().join("pt-serve.pid");

    // Write a sentinel with a deliberately-wrong inode so the verifier fires.
    // We pick a constant pair the server's stat cannot produce
    // (dev=0, ino=u64::MAX).
    let (server_dev, server_ino) = stat_dev_ino(data_root.path());
    let bogus_dev: u64 = server_dev.wrapping_add(7777);
    let bogus_ino: u64 = server_ino.wrapping_add(999_999);
    let body = format!("schemaVersion=1\ndeviceInode={bogus_dev}:{bogus_ino}\n");
    std::fs::write(data_root.path().join(".producer-data-root-id"), body).expect("write sentinel");

    let cmd = pt_serve_command(data_root.path(), &pidfile);
    let (status, stdout, stderr) = spawn_and_collect_exit(cmd, Duration::from_secs(10));

    assert!(
        !status.success(),
        "pt-serve should exit non-zero on sentinel mismatch; got {status:?}\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert!(
        stderr.contains("sentinel_verify_failed"),
        "stderr missing sentinel_verify_failed tag:\n{stderr}"
    );
    assert!(
        stderr.contains("mismatch"),
        "stderr missing 'mismatch' reason:\n{stderr}"
    );
    // The recorded (producer) inode AND the observed (server) inode must
    // BOTH appear in stderr — operator's "which volume is wrong" diagnostic.
    assert!(
        stderr.contains(&bogus_ino.to_string()),
        "stderr missing producer's recorded inode ({bogus_ino}):\n{stderr}"
    );
    assert!(
        stderr.contains(&server_ino.to_string()),
        "stderr missing server's observed inode ({server_ino}):\n{stderr}"
    );
    // The verifier runs BEFORE worker pool bind → no listening line on
    // stdout.
    assert!(
        !stdout.contains("pt-serve listening on"),
        "pt-serve should not bind a listener on sentinel failure:\n{stdout}"
    );
}

// ----------------------------------------------------------------------------
// Test 2 — matching sentinel does NOT block startup (positive control)
// ----------------------------------------------------------------------------

#[test]
#[cfg(unix)]
fn matching_sentinel_does_not_block_startup() {
    use std::io::BufRead as _;
    use std::sync::mpsc;

    let (data_root, _id) = seed_data_root();
    let pidfile = data_root.path().join("pt-serve.pid");

    // Write a sentinel that matches what the verifier will stat.
    let (server_dev, server_ino) = stat_dev_ino(data_root.path());
    let body = format!("schemaVersion=1\ndeviceInode={server_dev}:{server_ino}\n");
    std::fs::write(data_root.path().join(".producer-data-root-id"), body).expect("write sentinel");

    let mut cmd = pt_serve_command(data_root.path(), &pidfile);
    let mut child = cmd.spawn().expect("spawn pt-serve");
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
    let listened = matches!(rx.recv_timeout(Duration::from_secs(10)), Ok(Some(_)));
    let _ = child.kill();
    let _ = child.wait();
    let mut stderr = String::new();
    if let Some(mut s) = child.stderr.take() {
        let _ = s.read_to_string(&mut stderr);
    }
    assert!(
        listened,
        "matching sentinel must NOT block startup; stderr:\n{stderr}"
    );
}

// ----------------------------------------------------------------------------
// Test 2b — version sentinel is written at STARTUP, before generation load
// ----------------------------------------------------------------------------

/// FIX 1(a): pt-serve must advertise its PTB read-capability
/// (`pt-serve.version`) the moment the process is up — BEFORE (and independent
/// of) loading the first generation. This is what makes the producer's
/// absent-means-no-capable-server fail-closed gate safe on a fresh / producer-
/// first / stale-pt-serve rollout.
///
/// We prove the ordering by pointing pt-serve at a data_root with NO loadable
/// generation: the startup load fails and the process exits non-zero. If the
/// version-sentinel write still happened, it must have run BEFORE the load
/// attempt — exactly the property we need.
#[test]
#[cfg(unix)]
fn version_sentinel_written_at_startup_before_load() {
    use pt_serve::ops::version_sentinel::VERSION_SENTINEL_FILENAME;

    // Empty data_root: no generations/, no current.json → load_initial fails.
    let data_root = tempfile::TempDir::new().expect("tempdir");
    let pidfile = data_root.path().join("pt-serve.pid");
    let version_file = data_root.path().join(VERSION_SENTINEL_FILENAME);
    assert!(
        !version_file.exists(),
        "test invariant: data_root must not yet have a version sentinel"
    );

    let cmd = pt_serve_command(data_root.path(), &pidfile);
    let (status, stdout, stderr) = spawn_and_collect_exit(cmd, Duration::from_secs(10));

    // The load fails (no generation) → non-zero exit and no bound listener.
    assert!(
        !status.success(),
        "expected non-zero exit on unloadable data_root; got {status:?}\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert!(
        !stdout.contains("pt-serve listening on"),
        "load must fail before binding a listener:\n{stdout}"
    );
    // ...but the version sentinel was written at startup, BEFORE the load
    // that just failed.
    assert!(
        version_file.exists(),
        "version sentinel must be written at startup even when the generation \
         load fails; stderr:\n{stderr}"
    );
    let contents = std::fs::read_to_string(&version_file).expect("read version sentinel");
    let advertised = contents
        .trim()
        .parse::<u16>()
        .expect("version sentinel is an int");
    assert_eq!(advertised, pt_core::PTB_VERSION);
    assert_eq!(advertised, 2, "the public PTB reader contract is v2");
}

// ----------------------------------------------------------------------------
// Test 3 — missing sentinel is OK (pre-Stage-B compat)
// ----------------------------------------------------------------------------

#[test]
#[cfg(unix)]
fn missing_sentinel_does_not_block_startup() {
    use std::io::BufRead as _;
    use std::sync::mpsc;

    let (data_root, _id) = seed_data_root();
    let pidfile = data_root.path().join("pt-serve.pid");
    // Explicitly assert absence (the seed helper doesn't create it).
    assert!(
        !data_root.path().join(".producer-data-root-id").exists(),
        "test invariant: data_root should not yet have a sentinel"
    );

    let mut cmd = pt_serve_command(data_root.path(), &pidfile);
    let mut child = cmd.spawn().expect("spawn pt-serve");
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
    let listened = matches!(rx.recv_timeout(Duration::from_secs(10)), Ok(Some(_)));
    let _ = child.kill();
    let _ = child.wait();
    assert!(
        listened,
        "missing sentinel must be backward-compatible with pre-Stage-B producers"
    );
}
