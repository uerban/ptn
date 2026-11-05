//! process-level pidfile race + recovery tests.
//!
//! Four scenarios:
//!
//! - **first wins, second fails before bind.** Two `pt-serve` processes
//!   against the same `--pidfile-path`: the first acquires + binds; the
//!   second exits non-zero, prints the first's PID on stderr, and never
//!   advertises a listener.
//!
//! - **after graceful exit, fresh acquire succeeds.** Kill the first with
//!   SIGTERM, let it drain cleanly, then a second `pt-serve` against the
//!   same pidfile path comes up healthy.
//!
//! - **kernel-released on SIGKILL.** SIGKILL the first; the kernel reaps the
//!   open-file description and releases the flock. A successor `pt-serve`
//!   acquires the lock, becomes ready, and the pidfile now contains the
//!   successor's PID (not the dead first's).
//!
//! - **statfs warning on tmpfs.** Pidfile parent on a tmpfs (or skip if no
//!   tmpfs is mounted on the runner). Stderr carries the warning; startup
//!   does NOT fail.
//!
//! ## Shape
//!
//! Mirrors `tests/rss_guard_process.rs`: a `pt_serve_command` builder that
//! takes the test-varied knobs as arguments, a per-test fresh `TempDir`,
//! `CARGO_BIN_EXE_pt-serve` for the binary path. Each test cleans up its
//! spawned children before returning.

use std::io::{BufRead as _, Read as _};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[path = "common/mod.rs"]
mod common;

// ----------------------------------------------------------------------------
// Shared helpers (kept self-contained — cargo's per-binary dead-code lint
// flags helpers that go unused in one of the N test binaries).
// ----------------------------------------------------------------------------

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

/// Per-test data_root seed with one generation pointed at by `current.json`.
/// Identical shape to `rss_guard_process.rs::seed_data_root` — duplicated so
/// no inter-integration-test dependency forms.
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

/// argv builder. The pidfile_path is the test-varied knob; everything else is
/// the canonical small-test config. RSS knobs sized to comfortably fit
/// tiny.ptb on every supported runner.
fn pt_serve_command(data_root: &Path, pidfile_path: &Path) -> Command {
    let bin = env!("CARGO_BIN_EXE_pt-serve");
    let mut cmd = Command::new(bin);
    cmd.args([
        "--listen-addr",
        "127.0.0.1:0",
        "--metrics-listen-addr",
        "127.0.0.1:0",
        // Ephemeral loopback listener too — these tests spawn TWO pt-serve
        // processes concurrently, so the fixed default 0.0.0.0:9002 would
        // collide (EADDRINUSE) on the second bind. 127.0.0.1:0 lets the OS
        // pick a free port per process (Stage-C C2c).
        "--loopback-listen-addr",
        "127.0.0.1:0",
        "--data-root",
        data_root.to_str().unwrap(),
        "--pidfile-path",
        pidfile_path.to_str().unwrap(),
        "--city-slug",
        "vilnius",
        // The committed fixture this test spawns against carries no
        // cityTzIana in its manifest; supply the operator default so the T13
        // tz cross-check resolves (mirrors compose --city-tz-iana-default).
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

/// Spawn pt-serve, capture stdout in a background thread, wait for the
/// "pt-serve listening on http://<addr>" line on stdout, return the base URL
/// (e.g. "http://127.0.0.1:54321"). Bounded by `timeout`.
fn spawn_and_await_listening(mut cmd: Command, timeout: Duration) -> (Child, String) {
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
    match rx.recv_timeout(timeout) {
        Ok(Some(base)) => (child, base),
        Ok(None) => {
            let _ = child.kill();
            let mut stderr = String::new();
            if let Some(mut s) = child.stderr.take() {
                let _ = s.read_to_string(&mut stderr);
            }
            panic!("pt-serve exited before printing its bound address.\nstderr:\n{stderr}");
        }
        Err(_) => {
            let _ = child.kill();
            panic!("pt-serve did not print its bound address within {timeout:?}");
        }
    }
}

/// Poll /ready against `base` until it returns 200, bounded by `timeout`.
/// Returns true on 200, false on timeout/error.
fn wait_for_ready(base: &str, timeout: Duration) -> bool {
    let host_port = base.trim_start_matches("http://").to_string();
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(stream) = TcpStream::connect(&host_port) {
            drop(stream);
            let url = format!("{base}/ready");
            if let Ok(resp) = ureq::get(&url).call() {
                if resp.status() == 200 {
                    return true;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

/// Drain stderr to a String — used after `child.wait()` to inspect logs.
fn drain_stderr(child: &mut Child) -> String {
    let mut s = String::new();
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut s);
    }
    s
}

// ----------------------------------------------------------------------------
// Test 1 — first acquires, second fails before bind, stderr names the PID.
// ----------------------------------------------------------------------------

#[test]
fn first_acquires_second_fails_with_pid() {
    let (data_root, _id) = seed_data_root();
    let pidfile = data_root.path().join("pt-serve.pid");

    // First: spawn + wait for listening. Holds the lock for the duration.
    let cmd1 = pt_serve_command(data_root.path(), &pidfile);
    let (mut first, base1) = spawn_and_await_listening(cmd1, Duration::from_secs(10));
    assert!(
        wait_for_ready(&base1, Duration::from_secs(5)),
        "first pt-serve did not become ready"
    );
    let first_pid = first.id();

    // Second: same pidfile path → must exit non-zero before binding.
    let mut cmd2 = pt_serve_command(data_root.path(), &pidfile);
    let mut second = cmd2.spawn().expect("spawn second pt-serve");
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        match second.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = second.kill();
                    let _ = first.kill();
                    let _ = first.wait();
                    panic!("second pt-serve did not exit within 10s — lock was not enforced");
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = second.kill();
                let _ = first.kill();
                let _ = first.wait();
                panic!("second try_wait error: {e}");
            }
        }
    };
    let second_stderr = drain_stderr(&mut second);
    let mut second_stdout = String::new();
    if let Some(mut s) = second.stdout.take() {
        let _ = s.read_to_string(&mut second_stdout);
    }

    // Clean up first BEFORE asserting so a failing assertion doesn't leak
    // the still-running first process.
    let _ = first.kill();
    let _ = first.wait();

    assert!(
        !status.success(),
        "second pt-serve should exit non-zero (lock held by first); got {status:?}\nstderr:\n{second_stderr}"
    );
    assert!(
        second_stderr.contains("pidfile_already_locked"),
        "second stderr missing pidfile_already_locked tag:\n{second_stderr}"
    );
    assert!(
        second_stderr.contains(&first_pid.to_string()),
        "second stderr missing the first's PID ({first_pid}):\n{second_stderr}"
    );
    // Belt-and-braces: the second must NOT have printed a listen line.
    assert!(
        !second_stdout.contains("pt-serve listening on"),
        "second pt-serve bound a listener despite the held lock:\n{second_stdout}"
    );
}

// ----------------------------------------------------------------------------
// Test 2 — after the first exits gracefully, a fresh pt-serve acquires.
// ----------------------------------------------------------------------------

#[test]
fn after_graceful_exit_second_acquires() {
    let (data_root, _id) = seed_data_root();
    let pidfile = data_root.path().join("pt-serve.pid");

    let cmd1 = pt_serve_command(data_root.path(), &pidfile);
    let (mut first, base1) = spawn_and_await_listening(cmd1, Duration::from_secs(10));
    assert!(
        wait_for_ready(&base1, Duration::from_secs(5)),
        "first pt-serve did not become ready"
    );

    // SIGKILL the first to release the lock quickly + deterministically.
    // (SIGTERM would route through the DrainController which has a 1s
    // preStop grace baked into default_test_config — extra latency we don't
    // need here. The graceful-vs-violent distinction is covered by the
    // kill_dash_9 test below; this test cares only that the FILE is gone
    // and the lock released, which both paths satisfy.)
    //
    // Wait: this test is named "after_graceful_exit". Use SIGTERM and let
    // the drain run, then assert the file was unlinked (drop ran).
    #[cfg(unix)]
    unsafe {
        libc::kill(first.id() as i32, libc::SIGTERM);
    }
    let _ = first.wait();

    // The PidfileGuard's Drop runs on a normal-exit path → file removed.
    // After SIGTERM the drain observer calls std::process::exit(N), which
    // does NOT run Drop. So the file may or may not be present here — what
    // matters is the lock is released. We do NOT assert file-presence; we
    // ONLY assert a successor acquires.
    let cmd2 = pt_serve_command(data_root.path(), &pidfile);
    let (mut second, base2) = spawn_and_await_listening(cmd2, Duration::from_secs(10));
    assert!(
        wait_for_ready(&base2, Duration::from_secs(5)),
        "successor pt-serve did not become ready"
    );

    let _ = second.kill();
    let _ = second.wait();
}

// ----------------------------------------------------------------------------
// Test 3 — kernel releases the lock on SIGKILL (no Drop runs).
// ----------------------------------------------------------------------------

#[test]
fn kill_dash_9_releases_lock_via_kernel() {
    let (data_root, _id) = seed_data_root();
    let pidfile = data_root.path().join("pt-serve.pid");

    let cmd1 = pt_serve_command(data_root.path(), &pidfile);
    let (mut first, base1) = spawn_and_await_listening(cmd1, Duration::from_secs(10));
    assert!(
        wait_for_ready(&base1, Duration::from_secs(5)),
        "first pt-serve did not become ready"
    );
    let first_pid = first.id();

    // SIGKILL — no opportunity for Drop / cleanup. The kernel reaps the
    // open-file-description and releases the flock automatically.
    #[cfg(unix)]
    unsafe {
        libc::kill(first_pid as i32, libc::SIGKILL);
    }
    let _ = first.wait();

    // The pidfile MAY still exist with the dead PID — Drop did not run. The
    // successor must overwrite it during its own acquire.
    let cmd2 = pt_serve_command(data_root.path(), &pidfile);
    let (mut second, base2) = spawn_and_await_listening(cmd2, Duration::from_secs(10));
    assert!(
        wait_for_ready(&base2, Duration::from_secs(5)),
        "successor did not become ready after kill -9 of the lock holder"
    );
    let second_pid = second.id();
    assert_ne!(first_pid, second_pid, "successor PID must differ");

    // Read the pidfile contents — must contain the SUCCESSOR's PID, not the
    // dead first's. This is the "overwritten during acquire" assertion.
    let contents = std::fs::read_to_string(&pidfile).expect("read pidfile after successor up");
    let read_pid: u32 = contents
        .trim()
        .parse()
        .expect("pidfile contents non-numeric");
    assert_eq!(
        read_pid, second_pid,
        "pidfile should contain successor PID after kernel-released acquire (first={first_pid}, successor={second_pid})"
    );

    let _ = second.kill();
    let _ = second.wait();
}

// ----------------------------------------------------------------------------
// Test 4 — statfs warning on tmpfs.
//
// On most Linux CI runners /tmp is tmpfs, in which case the seeded data_root
// also sits on tmpfs and the warning fires. On macOS dev the statfs check is
// a no-op (and pt-serve targets Linux production). On a runner where /tmp is
// NOT tmpfs, we have nothing reasonable to mount on the fly — mark as
// `#[ignore]` with a clear "how to enable" note in the panic message and
// run normally.
// ----------------------------------------------------------------------------

#[test]
fn tmpfs_pidfile_parent_warns_but_does_not_fail() {
    // Skip on non-Linux: the statfs warning is Linux-only by design (lists Linux magic numbers;
    // macOS dev is exempt). Return as a pass — the unit tests cover the parent-resolution path.
    #[cfg(not(target_os = "linux"))]
    eprintln!(
        "tmpfs_pidfile_parent_warns: skipped (target_os != linux; statfs check is Linux-only)"
    );

    #[cfg(target_os = "linux")]
    {
        // Detect whether the default tempdir lives on tmpfs. If yes, run the
        // assertion. If no, skip with a diagnostic note explaining how to
        // enable (mount -t tmpfs ... before running, or use a different
        // tempdir root via TMPDIR env).
        let probe = tempfile::TempDir::new().expect("tempdir");
        let is_tmpfs = match rustix::fs::statfs(probe.path()) {
            // st.f_type is already i64 on the linux-musl x86_64 CI target;
            // clippy::unnecessary_cast rejects the redundant `as i64`.
            Ok(st) => st.f_type == 0x0102_1994, // TMPFS_MAGIC
            Err(_) => false,
        };
        if !is_tmpfs {
            eprintln!(
                "tmpfs_pidfile_parent_warns: skipped — tempdir not on tmpfs (set TMPDIR to a tmpfs mount or run inside a tmpfs container)"
            );
            return;
        }
        drop(probe);

        let (data_root, _id) = seed_data_root();
        let pidfile = data_root.path().join("pt-serve.pid");

        let cmd = pt_serve_command(data_root.path(), &pidfile);
        let (mut child, base) = spawn_and_await_listening(cmd, Duration::from_secs(10));
        assert!(
            wait_for_ready(&base, Duration::from_secs(5)),
            "pt-serve should start successfully even with tmpfs warning"
        );

        // Kill + drain stderr to inspect the warning.
        let _ = child.kill();
        let _ = child.wait();
        let stderr = drain_stderr(&mut child);

        assert!(
            stderr.contains("pidfile_unsupported_filesystem")
                || stderr.contains("WARNING — pidfile parent"),
            "expected tmpfs warning in stderr:\n{stderr}"
        );
        // CI verify-ran marker: a green-but-skipped test would leave this
        // string absent. The pt-serve-gate workflow greps the harness
        // stdout for this exact line to confirm the assertion executed
        // on the runner (cf. T11 in the 2026-05-24 reviewer-pass fixes).
        eprintln!("tmpfs_pidfile_parent_warns: ran tmpfs assertion");
        assert!(
            stderr.contains("tmpfs"),
            "warning should name the filesystem:\n{stderr}"
        );
    }
}
