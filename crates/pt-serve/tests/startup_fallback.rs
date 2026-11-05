//! Startup-fallback contract for `bundle::loader::load_initial`.
//!
//! The five scenarios cover the load path's branches:
//! 1. `current.json` malformed → fall back to `last-good.json` and adopt.
//! 2. Both pointers malformed → caller exits non-zero before listener bind.
//! 3. Stale `*.tmp` siblings of the pointer files are deleted on startup.
//! 4. `.publishing/` dirs older than 1h with NO producer lock held are
//!    cleaned; ≤1h OR lock held → preserved.
//! 5. `last-good.json` pointing at a wrong-city generation → fail closed (the
//!    server must NOT silently serve a different city's bundle just because
//!    the happy-path pointer broke).
//!

#[path = "common/mod.rs"]
mod common;

use common::isolated_config;
use pt_serve::bundle::loader::{load_initial, LoadError, PointerSource};
use pt_shared::clock::{Clock, SystemClock};
use pt_shared::validate::errors::{OperatorError, ProducerError, ValidationError};
use std::fs;
use std::os::fd::AsFd;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

// Serialize the two tests that exercise `producer.lock` flock semantics
// against a subprocess spawn. `publishing_dir_cleanup_respects_lock_and_age`
// holds flock LOCK_EX briefly via `cleanup_startup_artifacts`; the sibling
// `producer_lock_held_returns_true_when_producer_holds_lock` test spawns a
// child via `Command::spawn()` that, on MUSL builds (the production+CI
// target — see pt-serve-gate.yml: `x86_64-unknown-linux-musl`), can be
// implemented as userspace fork+exec. The fork briefly duplicates *every*
// parent fd into the child — including the sibling thread's transient lock
// fd — keeping the OFD alive until the child's exec triggers `O_CLOEXEC`.
// During that window, a subsequent flock on a fresh OFD at the same path
// sees `EWOULDBLOCK`. macOS + glibc `posix_spawn` use a true kernel atomic
// op and don't expose this window; MUSL does. The serialization guarantees
// the spawn never happens while the sibling holds the lock.
static FLOCK_SERIAL: Mutex<()> = Mutex::new(());

// ---------------------------------------------------------------------------
// Test-only seeding helpers
// ---------------------------------------------------------------------------

/// Seed a generation directory under `data_root/generations/<gen_id>/`:
/// generation.json + bundle.ptb of `bundle_size` bytes.
/// `city` is encoded in the manifest's `city_slug`. The bundle bytes are
/// arbitrary (loader only checks `len == bundle_size_bytes`;
/// structural PTB validation is pt-core's job and not exercised here).
fn seed_generation(data_root: &Path, gen_id: &str, city: &str, bundle_size: u64) {
    let dir = data_root.join("generations").join(gen_id);
    fs::create_dir_all(&dir).unwrap();
    // `bundle.ptb` — arbitrary bytes of the declared length.
    fs::write(dir.join("bundle.ptb"), vec![0u8; bundle_size as usize]).unwrap();
    let manifest = serde_json::json!({
        "manifestSchemaVersion": 2,
        "generationId": gen_id,
        "citySlug": city,
        "bundleSha256": "0".repeat(64),
        "publicationInputsSha256": "0".repeat(64),
        "bundleSizeBytes": bundle_size,
        "feedStartDate": 20260501u32,
        "hasTransfers": false,
        "transfersSha256": null,
        "transfersSizeBytes": null,
        "createdAt": "2026-05-23T10:00:00Z",
    });
    fs::write(
        dir.join("generation.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();
}

/// Write a valid pointer file (`current.json` or `last-good.json`) targeting
/// `gen_id` with the given `city_slug`.
fn write_valid_pointer(data_root: &Path, file_name: &str, gen_id: &str, city: &str) {
    let pointer = serde_json::json!({
        "manifestSchemaVersion": 2,
        "generationId": gen_id,
        "citySlug": city,
        "createdAt": "2026-05-23T10:00:00Z",
    });
    fs::write(
        data_root.join(file_name),
        serde_json::to_string_pretty(&pointer).unwrap(),
    )
    .unwrap();
}

fn write_garbage_pointer(data_root: &Path, file_name: &str) {
    fs::write(data_root.join(file_name), b"{ this is not json }").unwrap();
}

// ---------------------------------------------------------------------------
// Scenario 1: current invalid, last-good valid → adopt last-good
// ---------------------------------------------------------------------------

#[test]
fn invalid_current_falls_back_to_last_good() {
    let (dir, cfg, _clock) = isolated_config();
    let root = dir.path();
    write_garbage_pointer(root, "current.json");
    write_valid_pointer(root, "last-good.json", "gen_a", &cfg.city_slug);
    seed_generation(root, "gen_a", &cfg.city_slug, 4096);

    let loaded = load_initial(root, &cfg.city_slug, &SystemClock).expect("fallback must succeed");
    assert_eq!(loaded.generation_id(), "gen_a");
    assert_eq!(loaded.source_pointer, PointerSource::LastGood);
}

// ---------------------------------------------------------------------------
// Scenario 2: both invalid → BothPointersInvalid
// ---------------------------------------------------------------------------

#[test]
fn both_pointers_invalid_returns_err() {
    let (dir, cfg, _clock) = isolated_config();
    let root = dir.path();
    write_garbage_pointer(root, "current.json");
    write_garbage_pointer(root, "last-good.json");

    let err = load_initial(root, &cfg.city_slug, &SystemClock).unwrap_err();
    assert!(
        matches!(err, LoadError::BothPointersInvalid { .. }),
        "expected BothPointersInvalid, got: {err:?}"
    );
}

#[test]
fn neither_pointer_exists_returns_err() {
    let (dir, cfg, _clock) = isolated_config();
    let root = dir.path();
    // No files at all in the data_root — both pointers missing should still
    // fail closed (the load path treats missing-pointer the same as malformed
    // for fallback purposes; the caller must not bind a listener with no
    // generation to serve).
    let err = load_initial(root, &cfg.city_slug, &SystemClock).unwrap_err();
    assert!(
        matches!(err, LoadError::BothPointersInvalid { .. }),
        "expected BothPointersInvalid, got: {err:?}"
    );
}

// ---------------------------------------------------------------------------
// Scenario 3: stale `*.tmp` siblings are deleted on startup
// ---------------------------------------------------------------------------

#[test]
fn stale_tmp_siblings_are_deleted_on_startup() {
    let (dir, cfg, _clock) = isolated_config();
    let root = dir.path();
    // Lay down a healthy current.json + matching generation, AND a couple of
    // stale tmps next to the pointer files (a producer crash mid-publish).
    write_valid_pointer(root, "current.json", "gen_a", &cfg.city_slug);
    seed_generation(root, "gen_a", &cfg.city_slug, 4096);
    fs::write(root.join("current.json.tmp"), b"stale-producer-crash-1").unwrap();
    fs::write(root.join("last-good.json.tmp"), b"stale-producer-crash-2").unwrap();

    let loaded = load_initial(root, &cfg.city_slug, &SystemClock).expect("happy path");
    assert_eq!(loaded.generation_id(), "gen_a");
    assert!(
        !root.join("current.json.tmp").exists(),
        "stale tmp not deleted"
    );
    assert!(
        !root.join("last-good.json.tmp").exists(),
        "stale tmp not deleted"
    );
}

// ---------------------------------------------------------------------------
// Scenario 4: .publishing/ cleanup respects age + lock
// ---------------------------------------------------------------------------

#[test]
fn publishing_dir_cleanup_respects_lock_and_age() {
    let _serial = FLOCK_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
    use pt_shared::clock::MockClock;
    use std::sync::Arc;

    // Anchor the mock clock at a fixed instant; then back-date some dirs by
    // mtime and check the cleanup rule:
    //   - old (>1h) AND producer lock NOT held → DELETED
    //   - old (>1h) AND producer lock held     → PRESERVED (entire .publishing/
    //                                           sweep skips entries when the
    //                                           per-data-root producer.lock is
    //                                           held by someone else)
    //   - young (≤1h) AND producer lock NOT held → PRESERVED
    //
    // The lock checked is `<data_root>/producer.lock` — the SINGLE per-data-root lock the producer
    // takes per publish tick, NOT a per-staging-dir file. Earlier revisions of this test (and
    // loader.rs) used a per-staging-dir lock; that mismatched producer behaviour and could delete a
    // live staging dir.
    let (dir, _cfg, _) = isolated_config();
    let root = dir.path();
    let publishing = root.join(".publishing");
    fs::create_dir_all(&publishing).unwrap();

    // Sub-scenario 1: producer lock NOT held (the happy path) → old orphans
    // are deleted, young entries kept.
    let dir_a = publishing.join("old-orphan");
    fs::create_dir_all(&dir_a).unwrap();
    let dir_c = publishing.join("young-orphan");
    fs::create_dir_all(&dir_c).unwrap();

    // Back-date A's mtime to 2h ago.
    let two_h_ago = SystemTime::now() - Duration::from_secs(7200);
    set_mtime(&dir_a, two_h_ago);

    let clock = Arc::new(MockClock::new(SystemTime::now()));
    pt_serve::bundle::loader::cleanup_startup_artifacts(root, clock.as_ref() as &dyn Clock)
        .expect("cleanup");
    assert!(
        !dir_a.exists(),
        "old-orphan must be deleted when no lock held"
    );
    assert!(dir_c.exists(), "young-orphan must be preserved (age <= 1h)");

    // Sub-scenario 2: producer lock IS held → old orphan should be PRESERVED
    // even though it would otherwise be deleted. We hold the per-data-root
    // producer.lock from THIS process via an OFD-distinct fd: flock is per
    // open-file-description, so we open with O_RDWR|O_CREAT and call flock
    // exclusively. The cleanup code's `try_acquire_producer_lock` will open
    // its own fd to the same path and try to take an exclusive lock — that
    // attempt must fail (EWOULDBLOCK), and our held lock must keep the
    // cleanup from rmdir'ing dir_d.
    //
    // CAVEAT: on some platforms (Linux), flock(2) is per-OFD, so a second
    // open+flock from the same process via a DIFFERENT OFD will block as
    // expected. On macOS the behaviour matches. If a future port lands on
    // an OS where same-process flock is incorrectly granted, this test
    // will fail loudly — which is desirable.
    let dir_d = publishing.join("old-locked");
    fs::create_dir_all(&dir_d).unwrap();
    set_mtime(&dir_d, two_h_ago);

    let lock_path = root.join("producer.lock");
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .unwrap();
    rustix::fs::flock(
        lock_file.as_fd(),
        rustix::fs::FlockOperation::NonBlockingLockExclusive,
    )
    .expect("test holds producer.lock exclusively");

    pt_serve::bundle::loader::cleanup_startup_artifacts(root, clock.as_ref() as &dyn Clock)
        .expect("cleanup with lock held");
    assert!(
        dir_d.exists(),
        "old staging dir must be preserved while producer.lock is held by someone else"
    );

    // Release the test's lock; a subsequent cleanup must then delete the
    // (still-old) dir_d — proves the gating is dynamic on lock state, not a
    // permanent skip.
    drop(lock_file);
    let _ = std::fs::remove_file(&lock_path); // cosmetic cleanup
    pt_serve::bundle::loader::cleanup_startup_artifacts(root, clock.as_ref() as &dyn Clock)
        .expect("cleanup after lock release");
    assert!(
        !dir_d.exists(),
        "old staging dir must be deleted once producer.lock is released"
    );
}

// Unit test: producer_lock_held returns true when a second process holds
// the lock. We use a subprocess (the running test binary itself with an
// env-var sentinel) rather than a fork so the assertion is portable across
// macOS / Linux without `unsafe` fork plumbing.
#[test]
fn producer_lock_held_returns_true_when_producer_holds_lock() {
    // Skip orchestration when running as the spawned-child side: hold the
    // lock for a fixed window so the parent observes it as held.
    if std::env::var("PTNS_HOLD_PRODUCER_LOCK_PATH").is_ok() {
        let path = std::env::var("PTNS_HOLD_PRODUCER_LOCK_PATH").unwrap();
        let f = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&path)
            .unwrap();
        rustix::fs::flock(
            f.as_fd(),
            rustix::fs::FlockOperation::NonBlockingLockExclusive,
        )
        .expect("child holds lock");
        // Signal readiness by touching a sentinel file. The parent polls
        // for this rather than sleeping a fixed interval.
        let ready = std::env::var("PTNS_HOLD_PRODUCER_LOCK_READY").unwrap();
        std::fs::write(&ready, b"ready").unwrap();
        // Hold for 5s (parent's window is much shorter).
        std::thread::sleep(std::time::Duration::from_secs(5));
        return;
    }

    // Parent-side: acquire the serial lock AFTER the child-mode early-return.
    // The child runs in a separate process, doesn't share this Mutex, and must
    // not block on it. See module-level FLOCK_SERIAL doc for the MUSL fork-exec
    // window race this guards against.
    let _serial = FLOCK_SERIAL.lock().unwrap_or_else(|p| p.into_inner());

    let dir = tempfile::TempDir::new().unwrap();
    let lock_path = dir.path().join("producer.lock");
    let ready_path = dir.path().join("ready");

    // Spawn ourselves with the child-mode env vars set. `current_exe()`
    // points at the test binary; cargo's test harness will run all tests,
    // so we pass `--exact` + this test's name to narrow scope. We also
    // unset the env on the parent side after spawn so we don't re-enter
    // the child branch in the same process.
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .env("PTNS_HOLD_PRODUCER_LOCK_PATH", &lock_path)
        .env("PTNS_HOLD_PRODUCER_LOCK_READY", &ready_path)
        .args([
            "--exact",
            "producer_lock_held_returns_true_when_producer_holds_lock",
            "--nocapture",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn child");

    // Wait for the child to signal readiness.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !ready_path.exists() {
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("child never signalled readiness");
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    // The child holds an exclusive flock; our check must observe "held".
    assert!(
        pt_serve::bundle::loader::producer_lock_held(&lock_path),
        "producer_lock_held must return true while child holds the lock"
    );

    // Tear down: kill the child and wait so it doesn't outlive the test.
    let _ = child.kill();
    let _ = child.wait();
}

/// Set a path's mtime via `utimensat`. macOS + Linux both expose this via
/// rustix's `fs::utimensat`. We pass `dirfd = CWD`, follow symlinks, and
/// preserve atime via `Timestamps::default`.
fn set_mtime(p: &Path, t: SystemTime) {
    let dur = t
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("post-epoch mtime");
    let times = rustix::fs::Timestamps {
        last_access: rustix::fs::Timespec {
            tv_sec: dur.as_secs() as _,
            tv_nsec: dur.subsec_nanos() as _,
        },
        last_modification: rustix::fs::Timespec {
            tv_sec: dur.as_secs() as _,
            tv_nsec: dur.subsec_nanos() as _,
        },
    };
    rustix::fs::utimensat(rustix::fs::CWD, p, &times, rustix::fs::AtFlags::empty())
        .expect("utimensat");
}

// ---------------------------------------------------------------------------
// Scenario 5: last-good with wrong city → fail closed
// ---------------------------------------------------------------------------

#[test]
fn last_good_with_wrong_city_returns_wrong_city_err() {
    let (dir, cfg, _clock) = isolated_config();
    let root = dir.path();
    // current.json broken → fallback engages
    write_garbage_pointer(root, "current.json");
    // last-good.json points at a generation for a DIFFERENT city.
    write_valid_pointer(root, "last-good.json", "wrong_city_gen", "kaunas");
    seed_generation(root, "wrong_city_gen", "kaunas", 4096);

    // From the fallback wrapper, the city mismatch surfaces as
    // BothPointersInvalid (the wrapper collapses any single-pointer error).
    // That is the correct end-state: the server fails closed before bind.
    let err = load_initial(root, &cfg.city_slug, &SystemClock).unwrap_err();
    assert!(matches!(err, LoadError::BothPointersInvalid { .. }));

    // For the wrong-city signal itself, drive the single-pointer try directly so the test can
    // assert on the concrete ValidationError variant. This is the signal the full validator
    // preserves through the audit-log seam. `try_load_pointer` returns `ValidationError` directly;
    // the `Operator(WrongCity { expected, found })` shape is the class the reload runner / `/ready`
    // will branch on.
    let err =
        pt_serve::bundle::loader::try_load_pointer(root, &cfg.city_slug, PointerSource::LastGood)
            .unwrap_err();
    match err {
        ValidationError::Operator(OperatorError::WrongCity { expected, found }) => {
            assert_eq!(expected, cfg.city_slug);
            assert_eq!(found, "kaunas");
        }
        other => panic!("expected Operator(WrongCity), got {other:?}"),
    }
}

// --------------------------------------------------------------------------- Bundle size mismatch
// (extra coverage; implicit)
// ---------------------------------------------------------------------------

#[test]
fn bundle_size_mismatch_is_detected() {
    let (dir, cfg, _clock) = isolated_config();
    let root = dir.path();
    write_valid_pointer(root, "current.json", "gen_a", &cfg.city_slug);
    // Seed with size=4096 in the manifest, then truncate the bundle to a
    // different length.
    seed_generation(root, "gen_a", &cfg.city_slug, 4096);
    fs::write(root.join("generations/gen_a/bundle.ptb"), vec![0u8; 2048]).unwrap();

    let err =
        pt_serve::bundle::loader::try_load_pointer(root, &cfg.city_slug, PointerSource::Current)
            .unwrap_err();
    match err {
        ValidationError::Producer(ProducerError::BundleSizeMismatch { expected, actual }) => {
            assert_eq!(actual, 2048);
            assert_eq!(expected, 4096);
        }
        other => panic!("expected Producer(BundleSizeMismatch), got {other:?}"),
    }
}
