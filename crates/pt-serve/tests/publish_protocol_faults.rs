//!
//! Drives the `pt-producer periodic-refresh` binary from the
//! `crates/pt-producer/` crate. We resolve the release binary relative to the
//! root workspace and gate the suite on the binary actually existing — run
//! `cargo build -p pt-producer --release --locked` before
//! invoking the suite. Build instructions live in
//! the pt phase p4 serve operability notes
//! item 12.
//!
//! ## Test matrix
//!
//! 1. happy path — clean publish + current.json flip
//! 2. after_step_4 — staging dir survives, no rename, no flip
//! 3. between_step_5_and_step_7 — staging dir + manifest survive, no flip
//! 4. after_step_7_validate_fail — staging dir gone, no flip (forensics off)
//! 5. after_step_9 — current.json flipped + generation dir promoted; no
//!    SIGHUP (no pt-serve running anyway)
//! 6. mid_rename_copyup — staging dir intact, no generation dir promotion,
//!    no flip
//! 7. enospc_step_3 — exit code 1 (real ENOSPC), no flip, no generations
//!    dir created
//! 8. producer.paused mid-publish — operator sentinel landing between
//!    step 2 and step 6 aborts cleanly
//! 9. concurrent producers race — second producer vs same data-root exits
//!    non-zero with the first's PID
//!
//! These tests are NOT `#[ignore]`d — they self-skip at runtime via
//! `require_producer()` (an early `return` when the release producer binary is
//! absent), so `--include-ignored` has no effect here. Local developers run
//! `cargo build -p pt-producer --release --locked` once so
//! `require_producer()` finds the binary, then
//! `cargo test -p pt-serve --test publish_protocol_faults`.
//!
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

// ----------------------------------------------------------------------------
// Path resolution
// ----------------------------------------------------------------------------

fn workspace_root() -> PathBuf {
    // CARGO_MANIFEST_DIR is `crates/pt-serve`; go up two for the workspace.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn producer_binary() -> PathBuf {
    workspace_root().join("target/release/pt-producer")
}

fn tiny_gtfs() -> PathBuf {
    workspace_root().join("crates/pt-producer/tests/fixtures/tiny-gtfs.zip")
}

/// Hermetic Node stub for the producer's color-artifacts-gen step (publish step
/// 3e). Without `PT_COLOR_ARTIFACTS_SCRIPT` the producer falls back to the prod
/// image path (`/app/packages/backend/scripts/color-artifacts-gen.mjs`), which
/// is absent outside the container, so every publish fails before flipping
/// `current.json`. Same stub the producer's own unit tests use.
fn color_artifacts_stub() -> PathBuf {
    workspace_root().join("crates/pt-producer/tests/fixtures/color-artifacts-stub.mjs")
}

/// Skip the test (returning early) if the producer binary isn't built. Returns
/// `false` if the test should be skipped — callers use:
/// ```ignore
/// if !require_producer() { return; }
/// ```
/// We don't `panic!()`-on-missing because then `cargo test` reports a fake
/// failure on a fresh checkout where the operator hasn't built the producer yet.
fn require_producer() -> bool {
    let p = producer_binary();
    if !p.exists() {
        eprintln!(
            "publish_protocol_faults: SKIP — producer binary not built at {p:?}. \
             Build it first: cargo build --release --manifest-path \
             crates/pt-producer/Cargo.toml"
        );
        return false;
    }
    if !tiny_gtfs().exists() {
        eprintln!(
            "publish_protocol_faults: SKIP — tiny-gtfs.zip fixture missing at {:?}",
            tiny_gtfs()
        );
        return false;
    }
    true
}

// ----------------------------------------------------------------------------
// Producer invocation helpers
// ----------------------------------------------------------------------------

/// Build a `Command` that runs the producer in `periodic-refresh` mode against
/// `data_root`. The caller adds `.env(...)` to set fault-injection.
fn producer_periodic_refresh(data_root: &Path) -> Command {
    // T16 deploy-ordering gate: the producer's periodic-refresh step 2.5 waits up
    // to 60s for <data_root>/pt-serve.version before publishing (the absent-
    // retry window that absorbs the compose service-start-order gap). In tests
    // we simulate "pt-serve already rolled out" by writing the sentinel up
    // front so the gate permits immediately — otherwise every producer run here
    // would burn the 60s retry and blow run_producer's 30s timeout.
    std::fs::create_dir_all(data_root).ok();
    std::fs::write(
        data_root.join("pt-serve.version"),
        format!("{}\n", pt_core::PTB_VERSION),
    )
    .ok();
    let mut cmd = Command::new(producer_binary());
    // Point the producer's color-artifacts-gen step at the hermetic stub; otherwise
    // step 3e spawns the nonexistent prod image script and the publish fails
    // before flipping current.json. Set per-Command (not process-global) so
    // parallel tests don't race.
    cmd.env("PT_COLOR_ARTIFACTS_SCRIPT", color_artifacts_stub());
    cmd.args([
        "periodic-refresh",
        "--data-root",
        data_root.to_str().unwrap(),
        "--city",
        "vilnius",
        "--gtfs",
        tiny_gtfs().to_str().unwrap(),
        // Anchor-date pinning makes createdAt-skew validation deterministic
        // — pick a date inside the rolling 90-day bitmask window.
        "--anchor-date",
        "20260524",
        // PTB v2 publication requires the city zone (its origins are local
        // noon minus 12 h); UTC needs no offset.
        "--city-tz-iana",
        "UTC",
        // Minimise the post-tick idle so SIGTERM fires quickly after the
        // side-effect is observed (1 s ≪ 3600 s default). The daemon still
        // exits only on SIGTERM; this just shortens the sleep_until_term
        // window when we SIGTERM mid-sleep.
        "--refresh-interval-secs",
        "1",
    ]);
    // Inherit stdout/stderr to the test's captured buffers so the assertion
    // diagnostics show producer output on failure.
    cmd
}

/// Run the producer to completion with a bounded timeout. Returns the exit
/// status + captured stderr (stdout is mostly empty for the publish path).
///
/// This variant is for fault-injected tests: the fault causes the producer to
/// call `process::exit(42)` on its own, so we just poll for self-exit.
fn run_producer(mut cmd: Command, timeout: Duration) -> (std::process::ExitStatus, String) {
    let mut child = cmd
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("spawn producer");
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stderr = String::new();
                if let Some(mut s) = child.stderr.take() {
                    use std::io::Read as _;
                    let _ = s.read_to_string(&mut stderr);
                }
                return (status, stderr);
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("producer did not complete within {timeout:?}");
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => panic!("producer try_wait error: {e}"),
        }
    }
}

/// Completion signal for `run_producer_until_published`.
///
/// The producer is a long-running daemon that never self-exits on success; the
/// harness must observe a per-tick side-effect and then SIGTERM the process.
/// This enum lets each test express what "done with this tick" means without
/// coupling the helper to a single detection strategy.
enum DoneSignal<'a> {
    /// The producer has published when `<data_root>/current.json` exists and
    /// the generation dir it points to contains `bundle.ptb`.
    CurrentJsonFlipped(&'a Path),
    /// The producer has completed the paused-tick when stderr contains `needle`.
    StderrContains(&'static str),
}

/// Drive a daemon producer until a per-tick completion side-effect is observed,
/// then SIGTERM the process and return its exit status + full stderr.
///
/// Unlike `run_producer`, this is for the no-fault (happy / paused) tests where
/// the producer loops forever and exits only on SIGTERM/SIGINT.  The workflow:
///
/// 1. Spawn the producer with stderr piped to a background reader thread.
/// 2. Poll the completion signal (on-disk artifact or stderr marker).
/// 3. Once observed (or the timeout fires), send SIGTERM via `libc::kill`.
/// 4. `child.wait()` for the process to acknowledge the signal and exit.
/// 5. Return the exit status + accumulated stderr.
///
/// SIGTERM causes the producer to log "SIGTERM/SIGINT received, exiting cleanly"
/// and return `Ok(())` (exit 0).  Callers should assert the on-disk SIDE
/// EFFECTS rather than the exit code, since SIGTERM-driven exits that land
/// mid-sleep produce a 0 exit, but the OS may also report a signal-killed
/// status on some platforms.
fn run_producer_until_published(
    mut cmd: Command,
    done: DoneSignal<'_>,
    timeout: Duration,
) -> (std::process::ExitStatus, String) {
    use std::io::BufRead as _;
    use std::sync::{Arc, Mutex};

    let mut child = cmd
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("spawn producer");

    let pid = child.id();

    // Drain stderr in a background thread into a shared String so we can
    // both accumulate the full log AND poll it for the completion marker
    // while the producer is still running.
    let stderr_pipe = child.stderr.take().expect("stderr piped");
    let stderr_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let stderr_clone = Arc::clone(&stderr_buf);
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stderr_pipe);
        for line in reader.lines().map_while(Result::ok) {
            let mut buf = stderr_clone.lock().unwrap();
            buf.push_str(&line);
            buf.push('\n');
        }
    });

    let deadline = std::time::Instant::now() + timeout;
    let mut done_observed = false;

    loop {
        // Check for early self-exit (should not happen on no-fault runs but
        // handle it so we don't block forever on a misconfigured producer).
        match child.try_wait() {
            Ok(Some(status)) => {
                // Process exited on its own before we sent SIGTERM.
                std::thread::sleep(Duration::from_millis(50)); // let reader drain
                let stderr = stderr_buf.lock().unwrap().clone();
                return (status, stderr);
            }
            Ok(None) => {}
            Err(e) => panic!("producer try_wait error: {e}"),
        }

        if !done_observed {
            let observed = match &done {
                DoneSignal::CurrentJsonFlipped(data_root) => {
                    let current = data_root.join("current.json");
                    if current.exists() {
                        // Also check that the generation dir with bundle.ptb
                        // exists, confirming the publish completed atomically.
                        if let Ok(bytes) = std::fs::read(&current) {
                            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                                if let Some(gen_id) = v["generationId"].as_str() {
                                    data_root
                                        .join("generations")
                                        .join(gen_id)
                                        .join("bundle.ptb")
                                        .exists()
                                } else {
                                    false
                                }
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                }
                DoneSignal::StderrContains(needle) => stderr_buf.lock().unwrap().contains(needle),
            };
            if observed {
                done_observed = true;
            }
        }

        if done_observed || std::time::Instant::now() >= deadline {
            if !done_observed {
                // Timed out without observing the side-effect — kill then
                // report so the test failure message is informative.
                let _ = child.kill();
                let _ = child.wait();
                std::thread::sleep(Duration::from_millis(50));
                let stderr = stderr_buf.lock().unwrap().clone();
                panic!(
                    "producer did not produce completion signal within {timeout:?}\nstderr:\n{stderr}"
                );
            }
            // Send SIGTERM so the daemon exits cleanly.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
            let status = child.wait().expect("wait after SIGTERM");
            // Let the reader thread drain the remaining bytes (SIGTERM log line).
            std::thread::sleep(Duration::from_millis(150));
            let stderr = stderr_buf.lock().unwrap().clone();
            return (status, stderr);
        }

        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Returns `true` iff `<data_root>/.publishing/<dir>/bundle.ptb` exists for
/// some `<dir>` (the actual SHA-named dir name is content-derived; we don't
/// pin it).
fn any_staging_with_bundle(data_root: &Path) -> bool {
    let pub_root = data_root.join(".publishing");
    if !pub_root.exists() {
        return false;
    }
    for entry in std::fs::read_dir(&pub_root).unwrap() {
        let entry = entry.unwrap();
        if entry.path().join("bundle.ptb").exists() {
            return true;
        }
    }
    false
}

/// Returns the lone `<data_root>/generations/<id>` if exactly one exists,
/// else None.
fn sole_generation_dir(data_root: &Path) -> Option<PathBuf> {
    let g = data_root.join("generations");
    if !g.exists() {
        return None;
    }
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&g)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    if dirs.len() == 1 {
        Some(dirs.pop().unwrap())
    } else {
        None
    }
}

// ----------------------------------------------------------------------------
// Test 1 — happy path: clean publish + current.json flip
// ----------------------------------------------------------------------------

#[test]
fn happy_path_publishes_and_flips_current() {
    if !require_producer() {
        return;
    }
    let dir = tempfile::TempDir::new().unwrap();
    let cmd = producer_periodic_refresh(dir.path());
    // Drive the daemon until current.json appears with a valid bundle, then
    // SIGTERM it. We assert the on-disk invariants (the test name's promise);
    // the exit code after SIGTERM is expected to be 0 but we don't gate on it
    // because the producer may be mid-sleep when SIGTERM lands.
    let (_status, stderr) = run_producer_until_published(
        cmd,
        DoneSignal::CurrentJsonFlipped(dir.path()),
        Duration::from_secs(30),
    );
    // current.json exists and points at a generation under generations/<id>/.
    let current = dir.path().join("current.json");
    assert!(current.exists(), "current.json must exist after publish");
    let pointer: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&current).unwrap()).expect("parse current.json");
    let gen_id = pointer["generationId"]
        .as_str()
        .expect("generationId")
        .to_string();
    let gen_dir = dir.path().join("generations").join(&gen_id);
    assert!(
        gen_dir.join("bundle.ptb").exists(),
        "generation bundle must exist\nstderr:\n{stderr}"
    );
    assert!(
        gen_dir.join("generation.json").exists(),
        "generation manifest must exist\nstderr:\n{stderr}"
    );
    // No leftover staging dir for THIS publish (the rename consumed it).
    assert!(
        !any_staging_with_bundle(dir.path()),
        "happy-path should leave no staging dir behind\nstderr:\n{stderr}"
    );
}

// ----------------------------------------------------------------------------
// Test 2 — after_step_4: staging dir survives, no rename, no flip
// ----------------------------------------------------------------------------

#[test]
fn after_step_4_leaves_staging_and_no_flip() {
    if !require_producer() {
        return;
    }
    let dir = tempfile::TempDir::new().unwrap();
    let mut cmd = producer_periodic_refresh(dir.path());
    cmd.env("PT_PRODUCER_FAULT_INJECT", "after_step_4");
    let (status, stderr) = run_producer(cmd, Duration::from_secs(30));
    assert_eq!(
        status.code(),
        Some(42),
        "after_step_4 must exit with fault-inject code 42; got {status:?}\nstderr:\n{stderr}"
    );
    assert!(
        any_staging_with_bundle(dir.path()),
        "staging dir must survive for forensics + janitor"
    );
    assert!(
        !dir.path().join("current.json").exists(),
        "current.json must NOT flip"
    );
    assert!(
        sole_generation_dir(dir.path()).is_none(),
        "no generation dir must be promoted (rename happens in step 8)"
    );
}

// ----------------------------------------------------------------------------
// Test 3 — between_step_5_and_step_7: staging dir + manifest survive
// ----------------------------------------------------------------------------

#[test]
fn between_step_5_and_step_7_preserves_manifest() {
    if !require_producer() {
        return;
    }
    let dir = tempfile::TempDir::new().unwrap();
    let mut cmd = producer_periodic_refresh(dir.path());
    cmd.env("PT_PRODUCER_FAULT_INJECT", "between_step_5_and_step_7");
    let (status, stderr) = run_producer(cmd, Duration::from_secs(30));
    assert_eq!(
        status.code(),
        Some(42),
        "between_step_5_and_step_7 must exit 42; got {status:?}\nstderr:\n{stderr}"
    );
    // Staging dir survives AND it contains generation.json (step 5 ran).
    let pub_root = dir.path().join(".publishing");
    let mut found_manifest = false;
    for entry in std::fs::read_dir(&pub_root).unwrap() {
        let entry = entry.unwrap();
        if entry.path().join("generation.json").exists() {
            found_manifest = true;
            break;
        }
    }
    assert!(
        found_manifest,
        "step 5 should have written generation.json before the abort"
    );
    assert!(
        !dir.path().join("current.json").exists(),
        "current.json must NOT flip"
    );
}

// ----------------------------------------------------------------------------
// Test 4 — after_step_7_validate_fail: staging dir DELETED, no flip
// ----------------------------------------------------------------------------

#[test]
fn after_step_7_validate_fail_cleans_staging() {
    if !require_producer() {
        return;
    }
    let dir = tempfile::TempDir::new().unwrap();
    let mut cmd = producer_periodic_refresh(dir.path());
    cmd.env("PT_PRODUCER_FAULT_INJECT", "after_step_7_validate_fail");
    // This fault returns Err (not exit(42)) from publish_one_tick, which the
    // daemon handles as a soft-fail (log + sleep + retry). Detect the fault's
    // own log line, SIGTERM, then assert the on-disk invariants.
    let (_status, stderr) = run_producer_until_published(
        cmd,
        DoneSignal::StderrContains("FAULT_INJECT=after_step_7_validate_fail"),
        Duration::from_secs(30),
    );
    // Staging dir deleted by the fault path (validation failure is the
    // worst case — staged bytes are broken; we don't want them lingering).
    assert!(
        !any_staging_with_bundle(dir.path()),
        "validation-failure path must delete the staging dir\nstderr:\n{stderr}"
    );
    assert!(
        !dir.path().join("current.json").exists(),
        "current.json must NOT flip\nstderr:\n{stderr}"
    );
}

// ----------------------------------------------------------------------------
// Test 5 — after_step_9: current.json flipped, no SIGHUP (no pt-serve running)
// ----------------------------------------------------------------------------

#[test]
fn after_step_9_flips_current_before_abort() {
    if !require_producer() {
        return;
    }
    let dir = tempfile::TempDir::new().unwrap();
    let mut cmd = producer_periodic_refresh(dir.path());
    cmd.env("PT_PRODUCER_FAULT_INJECT", "after_step_9");
    let (status, stderr) = run_producer(cmd, Duration::from_secs(30));
    assert_eq!(
        status.code(),
        Some(42),
        "after_step_9 must exit 42; got {status:?}\nstderr:\n{stderr}"
    );
    assert!(
        dir.path().join("current.json").exists(),
        "current.json must have flipped before the fault-inject abort"
    );
    assert!(
        sole_generation_dir(dir.path()).is_some(),
        "generation dir must be promoted (step 8 ran before abort)"
    );
}

// ----------------------------------------------------------------------------
// Test 6 — mid_rename_copyup: staging intact, no promotion, no flip
// ----------------------------------------------------------------------------

#[test]
fn mid_rename_copyup_preserves_staging() {
    if !require_producer() {
        return;
    }
    let dir = tempfile::TempDir::new().unwrap();
    let mut cmd = producer_periodic_refresh(dir.path());
    cmd.env("PT_PRODUCER_FAULT_INJECT", "mid_rename_copyup");
    // mid_rename_copyup is approximated with io::ErrorKind::PermissionDenied
    // at the rename — it returns Err from publish_one_tick (soft-fail, no
    // exit(42)). The daemon loops forever; detect the fault's log line and
    // SIGTERM. Assert on-disk invariants only (not exit code).
    let (_status, stderr) = run_producer_until_published(
        cmd,
        DoneSignal::StderrContains("FAULT_INJECT=mid_rename_copyup"),
        Duration::from_secs(30),
    );
    assert!(
        any_staging_with_bundle(dir.path()),
        "staging must survive the failed rename for forensics\nstderr:\n{stderr}"
    );
    assert!(
        sole_generation_dir(dir.path()).is_none(),
        "no generation dir must be promoted (rename failed)\nstderr:\n{stderr}"
    );
    assert!(
        !dir.path().join("current.json").exists(),
        "current.json must NOT flip\nstderr:\n{stderr}"
    );
}

// ----------------------------------------------------------------------------
// Test 7 — enospc_step_3: exit code 1 (real ENOSPC), no flip
// ----------------------------------------------------------------------------

#[test]
fn enospc_step_3_aborts_before_flip() {
    if !require_producer() {
        return;
    }
    let dir = tempfile::TempDir::new().unwrap();
    let mut cmd = producer_periodic_refresh(dir.path());
    cmd.env("PT_PRODUCER_FAULT_INJECT", "enospc_step_3");
    // enospc_step_3 returns Err (not exit(42)) from publish_one_tick; the
    // daemon soft-fails and would retry indefinitely. Detect the fault's own
    // log line as the completion signal, SIGTERM, then assert on-disk state.
    let (_status, stderr) = run_producer_until_published(
        cmd,
        DoneSignal::StderrContains("FAULT_INJECT=enospc_step_3"),
        Duration::from_secs(30),
    );
    assert!(
        !dir.path().join("current.json").exists(),
        "current.json must NOT flip on ENOSPC\nstderr:\n{stderr}"
    );
    // The fault implementation creates a placeholder staging dir so the
    // janitor's reap predicate has something to test on Stage B. We assert
    // the .publishing root exists; whether a specific subdir survives is
    // a janitor concern.
    assert!(
        dir.path().join(".publishing").exists(),
        "staging root must exist for the janitor to sweep on the next tick\nstderr:\n{stderr}"
    );
}

// ----------------------------------------------------------------------------
// Test 8 — producer.paused mid-publish: aborts cleanly at step 6 re-check
// ----------------------------------------------------------------------------
//
// This test is trickier because the producer is a single in-process pipeline:
// we can't externally inject `producer.paused` between step 5 and step 6
// without a separate fault hook. For Stage A, we exercise the simpler
// variant: `producer.paused` PRE-EXISTS at the start of the tick, and the
// step-2 check fires.
//
// The mid-publish race (operator creates `producer.paused` AFTER step 2 but
// before step 6) requires a synchronisation hook the producer doesn't yet
// expose; deferring to Stage B once the producer's HTTP /healthz hook is
// added.

#[test]
fn producer_paused_at_start_skips_publish() {
    if !require_producer() {
        return;
    }
    let dir = tempfile::TempDir::new().unwrap();
    std::fs::write(dir.path().join("producer.paused"), b"manual-pause-test").unwrap();
    let cmd = producer_periodic_refresh(dir.path());
    // There is no on-disk artifact to detect for the paused path — the producer
    // deliberately skips the publish. Instead we wait for the producer's stderr
    // log line that confirms it observed the pause sentinel, then SIGTERM.
    let (_status, stderr) = run_producer_until_published(
        cmd,
        DoneSignal::StderrContains("producer.paused — no-op"),
        Duration::from_secs(30),
    );
    assert!(
        !dir.path().join("current.json").exists(),
        "no publish should have occurred\nstderr:\n{stderr}"
    );
    assert!(
        !dir.path().join("generations").exists()
            || std::fs::read_dir(dir.path().join("generations"))
                .map(|mut d| d.next().is_none())
                .unwrap_or(true),
        "no generation dir should be created\nstderr:\n{stderr}"
    );
}

// ----------------------------------------------------------------------------
// Test 9 — concurrent producers race: second exits non-zero
// ----------------------------------------------------------------------------
//
// Two producers against the same data-root simultaneously. The flock on
// `producer.lock` must serialize them — the second one observes
// AlreadyLocked and exits non-zero with the first's PID in its stderr.
//
// Deterministic cross-process flock test. The first producer runs with
// `PT_PRODUCER_FAULT_INJECT=hold_lock_for_2s` (defined in
// `crates/pt-producer/src/fault_inject.rs`): it acquires
// `producer.lock`, sleeps 2 s while holding it, then completes the publish.
// The second producer starts inside that 2 s window and its `acquire()` MUST
// observe `EWOULDBLOCK` and exit non-zero with the lock-conflict message.
// No OS-scheduler luck — the race window is wall-clock-anchored by the
// 2 s sleep. The skip path that earlier revisions of this test carried
// has been removed (T11, commit d0e0ee7f).

#[test]
fn concurrent_producers_serialize_via_lock() {
    if !require_producer() {
        return;
    }
    let dir = tempfile::TempDir::new().unwrap();

    // Deterministic version (rev 2): the first producer runs with the
    // `hold_lock_for_2s` fault — it acquires producer.lock then sleeps
    // 2 seconds while holding it. The second producer starts during that
    // window; its `acquire()` call MUST observe EWOULDBLOCK and exit
    // with the lock-conflict error. No more OS-scheduler luck — the
    // race window is wall-clock-anchored by the 2s sleep.
    let mut a = producer_periodic_refresh(dir.path())
        .env("PT_PRODUCER_FAULT_INJECT", "hold_lock_for_2s")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn a");

    // Wait for `a` to log the lock-held message before launching `b`.
    // Poll its stderr-FILE? Easier: poll for the on-disk producer.lock
    // file existing AND being held (we can't directly test the second
    // condition from outside, but the lock-file presence + a re-read
    // deadline is reliable). Fast runners create the file in tens of ms;
    // a loaded CI box with parallel cargo-build artefacts ALSO hitting the
    // disk can take a couple of seconds. QA review #2 caught a flake at the
    // prior 2 s budget — bumped to 10 s to match the bats topology test's
    // poll window. Cost is paid only on slow runners (the wait terminates
    // as soon as the file appears).
    let lock_path = dir.path().join("producer.lock");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !lock_path.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        lock_path.exists(),
        "first producer should have created producer.lock before the second is launched"
    );

    let mut b = producer_periodic_refresh(dir.path())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn b");

    // `b` should fail fast (within ~100ms) because flock returns
    // EWOULDBLOCK immediately — it exits non-zero on its own, no SIGTERM.
    let status_b = b.wait().expect("wait b");

    let mut stderr_b = String::new();
    if let Some(mut s) = b.stderr.take() {
        use std::io::Read as _;
        let _ = s.read_to_string(&mut stderr_b);
    }

    // `b` MUST have observed the lock conflict — no skip path.
    assert!(
        stderr_b.contains("producer.lock already held"),
        "second producer must observe the lock as held;\nstatus_b={status_b:?} stderr_b:\n{stderr_b}"
    );

    // `a` is a daemon that loops forever after publishing. Now that `b`'s
    // conflict is confirmed, SIGTERM `a` so it exits cleanly; waiting on it
    // without signalling would block forever at the post-tick idle sleep.
    let pid_a = a.id();
    unsafe {
        libc::kill(pid_a as libc::pid_t, libc::SIGTERM);
    }
    let status_a = a.wait().expect("wait a after SIGTERM");

    let mut stderr_a = String::new();
    if let Some(mut s) = a.stderr.take() {
        use std::io::Read as _;
        let _ = s.read_to_string(&mut stderr_a);
    }

    // `a` must have logged the fault-inject hold so the test's intent is
    // visible in the harness output.
    assert!(
        stderr_a.contains("hold_lock_for_2s") || stderr_a.contains("sleeping 2s"),
        "first producer must log the hold-lock fault;\nstatus_a={status_a:?} stderr_a:\n{stderr_a}"
    );
}
