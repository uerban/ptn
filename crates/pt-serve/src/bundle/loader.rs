//! Startup loader — read the active generation from `<data_root>/current.json`, fall back to
//! `<data_root>/last-good.json` on any validation failure.
//!
//!
//! The per-stage error types this file used to define have been replaced by
//! the 5-class taxonomy in [`pt_shared::validate::errors::ValidationError`].
//! Mapping:
//!
//! - Pointer / generation-dir / bundle-file IO failures → `ValidationError::Io`
//!   (preserves the `std::io::ErrorKind` so callers can tell "not found"
//!   from "permission denied").
//! - Manifest / pointer JSON malformed → `ValidationError::Io` with
//!   `ErrorKind::InvalidData` (the loader synthesises this from the
//!   `serde_json::Error`; the wire-format-malformed class lives in
//!   pt-shared::manifest's Postel rule, not here).
//! - `city_slug` mismatch → `ValidationError::Operator(OperatorError::WrongCity)`.
//! - Bundle size mismatch → `ValidationError::Producer(ProducerError::BundleSizeMismatch)`.
//!
//! Structural validation of PTB bytes (magic, version, region bounds, CSR) lives in
//! `pt_core::validate::structural` and the boundary test
//! `tests/boundaries.rs::no_duplicated_structural_validation_in_bundle_loader` enforces that it
//! stays there.
//!
//! ## The two-level error shape
//!
//! Single-pointer attempts return [`ValidationError`] directly. The
//! fallback wrapper [`load_initial`] returns [`LoadError`], a tiny enum
//! that either embeds a single [`ValidationError`] (when only one pointer
//! was tried — currently unused outside tests) OR signals that BOTH
//! pointers failed. The two-level shape mirrors the spec's
//! "fail-closed-before-bind" requirement: the wrapper deliberately
//! collapses both per-pointer errors into one terminal state.

use pt_shared::clock::Clock;
use pt_shared::manifest::{GenerationManifest, PointerManifest};
use pt_shared::validate::errors::{IoErr, OperatorError, ProducerError, ValidationError};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Outcome of a successful pointer→generation resolution.
#[derive(Debug, Clone)]
pub struct LoadedGeneration {
    /// Source pointer that resolved this generation (`current.json` or
    /// `last-good.json`). Reload telemetry uses this to label a `fallback`
    /// adoption.
    pub source_pointer: PointerSource,
    /// Parsed generation manifest. Owns `String`s so the caller can store it
    /// on the Generation without lifetime gymnastics.
    pub manifest: GenerationManifest,
    /// Resolved path to `bundle.ptb` inside the generation dir.
    pub bundle_path: PathBuf,
    /// Resolved path to `transfers.bin` if `manifest.has_transfers`, else
    /// `None`.
    pub transfers_path: Option<PathBuf>,
}

impl LoadedGeneration {
    /// Convenience accessor — the reload runner uses this to label the generation in `/version`
    /// exposition.
    pub fn generation_id(&self) -> &str {
        &self.manifest.generation_id
    }
}

/// Which pointer file we ended up reading from. Adopting `LastGood` is the
/// fall-closed-but-still-serve outcome; adopting `Current` is the happy path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerSource {
    Current,
    LastGood,
}

impl PointerSource {
    fn file_name(self) -> &'static str {
        match self {
            PointerSource::Current => "current.json",
            PointerSource::LastGood => "last-good.json",
        }
    }
}

/// Outer load-path error. Single-pointer failures preserve the full
/// [`ValidationError`] under [`LoadError::Validation`]; the
/// [`LoadError::BothPointersInvalid`] arm carries BOTH per-pointer errors
/// so the operator-facing exit log can tell them apart (e.g. "current
/// said wrong-city, last-good said bundle size mismatch" is a different
/// runbook entry than "both said NotFound").
#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    /// A single-pointer attempt failed with the given validation class.
    /// Test paths use this via `try_load_pointer`; the fallback wrapper
    /// collapses it into `BothPointersInvalid`.
    #[error("validation failed: {0}")]
    Validation(#[from] ValidationError),
    /// Both `current.json` and `last-good.json` failed to load — caller
    /// must exit non-zero BEFORE binding the listener. Each per-pointer
    /// error is boxed to keep `LoadError` small.
    #[error(
        "both pointers failed to load — fail closed (current: {current_err}; last-good: {last_good_err})"
    )]
    BothPointersInvalid {
        current_err: Box<ValidationError>,
        last_good_err: Box<ValidationError>,
    },
}

/// Attempt to load the active generation, with last-good fallback.
///
/// Order of operations:
/// 1. `cleanup_startup_artifacts` — delete stale `*.tmp` siblings and aged-out
///    `.publishing/` subdirs. Runs before any pointer read so the first
///    pointer attempt sees a clean directory.
/// 2. Try `current.json`. If it loads cleanly, adopt with
///    `source_pointer = Current`.
/// 3. Else try `last-good.json`. If it loads cleanly, adopt with
///    `source_pointer = LastGood`.
/// 4. Else return `LoadError::BothPointersInvalid` so the caller can exit
///    non-zero BEFORE binding the listener.
///
pub fn load_initial(
    data_root: &Path,
    city: &str,
    clock: &dyn Clock,
) -> Result<LoadedGeneration, LoadError> {
    cleanup_startup_artifacts(data_root, clock).map_err(|e| {
        // A cleanup IO error is a load-path IO error.
        LoadError::Validation(ValidationError::Io(IoErr::from(e)))
    })?;
    // The fallback chain. We try Current first; on any error, fall through
    // to LastGood. If BOTH fail, the caller exits non-zero before bind.
    // See `load_initial_generation_with_force` in `bundle/mod.rs` for the
    // is_fatal()-gated variant that short-circuits fallback on a fatal
    // class.
    match try_load_pointer(data_root, city, PointerSource::Current) {
        Ok(g) => Ok(g),
        Err(current_err) => match try_load_pointer(data_root, city, PointerSource::LastGood) {
            Ok(g) => Ok(g),
            Err(last_good_err) => Err(LoadError::BothPointersInvalid {
                current_err: Box::new(current_err),
                last_good_err: Box::new(last_good_err),
            }),
        },
    }
}

/// Try a single pointer file → resolve → manifest → existence/size checks. Returns the per-pointer
/// [`ValidationError`] directly so the audit log can see which specific class failed before the
/// fallback wrapper collapses both into `BothPointersInvalid`.
pub fn try_load_pointer(
    data_root: &Path,
    city: &str,
    source: PointerSource,
) -> Result<LoadedGeneration, ValidationError> {
    let pointer_path = data_root.join(source.file_name());
    let pointer_text = fs::read_to_string(&pointer_path).map_err(io_to_validation)?;
    let pointer: PointerManifest =
        serde_json::from_str(&pointer_text).map_err(|e| serde_to_validation(&pointer_path, e))?;

    let gen_dir = data_root.join("generations").join(&pointer.generation_id);
    if !gen_dir.is_dir() {
        // Surface as Io::NotFound so the cause_label is "io" and the
        // ErrorKind tells the caller which file/dir was missing.
        return Err(ValidationError::Io(IoErr {
            kind: io::ErrorKind::NotFound,
            msg: format!(
                "generation dir for `{}` not found under `{}`",
                pointer.generation_id,
                data_root.display()
            ),
        }));
    }
    let manifest_path = gen_dir.join("generation.json");
    let manifest_text = fs::read_to_string(&manifest_path).map_err(io_to_validation)?;
    let manifest: GenerationManifest =
        serde_json::from_str(&manifest_text).map_err(|e| serde_to_validation(&manifest_path, e))?;

    // City-slug cross-check (a `last-good.json` pointing at a wrong-city generation MUST fail
    // closed; the server must not adopt and serve traffic from the wrong city).
    if manifest.city_slug != city {
        return Err(ValidationError::Operator(OperatorError::WrongCity {
            expected: city.to_string(),
            found: manifest.city_slug.clone(),
        }));
    }

    // Bundle existence + size cross-check.
    let bundle_path = gen_dir.join("bundle.ptb");
    let bundle_meta = fs::metadata(&bundle_path).map_err(io_to_validation)?;
    if bundle_meta.len() != manifest.bundle_size_bytes {
        return Err(ValidationError::Producer(
            ProducerError::BundleSizeMismatch {
                expected: manifest.bundle_size_bytes,
                actual: bundle_meta.len(),
            },
        ));
    }

    let transfers_path = if manifest.has_transfers {
        Some(gen_dir.join("transfers.bin"))
    } else {
        None
    };

    Ok(LoadedGeneration {
        source_pointer: source,
        manifest,
        bundle_path,
        transfers_path,
    })
}

/// `std::io::Error` → `ValidationError::Io` preserving kind + message.
fn io_to_validation(e: io::Error) -> ValidationError {
    ValidationError::Io(IoErr::from(e))
}

/// `serde_json::Error` → `ValidationError::Io` with kind=InvalidData. JSON
/// shape errors aren't structural (PTB bytes), aren't producer-controlled
/// (could be a hand-edit during ops), and aren't operator config — Io with
/// `InvalidData` is the closest taxonomy fit and preserves the path +
/// serde message in the wrapped string.
fn serde_to_validation(path: &Path, e: serde_json::Error) -> ValidationError {
    ValidationError::Io(IoErr {
        kind: io::ErrorKind::InvalidData,
        msg: format!("manifest at {} is malformed: {e}", path.display()),
    })
}

/// One-shot pre-load cleanup. Two scans, both bounded by what's in
/// `data_root`:
///
/// 1. Delete `*.tmp` siblings of the pointer files. A producer crash between `write tmp →
/// rename(tmp, final)` leaves a stale tmp behind; the next start reclaims it. We delete
/// unconditionally — the rename is single-atomic and there is no legitimate ambient `*.tmp` sibling
/// between publish operations.
/// 2. Walk `<data_root>/.publishing/`. Any subdir whose mtime is older
/// than 1h AND which is not protected by an actively-held producer lock is deleted (cleanup pass).
///
///    The "lock held" check is against `<data_root>/producer.lock` — the
///    SINGLE per-data-root producer lock from
///    `crates/pt-producer/src/producer_lock.rs` — NOT against a
///    per-staging-dir file. Earlier revisions wrongly looked for a
///    `<.publishing>/<dir>/producer.lock`, which never existed and made the
///    check vacuously return false; a slow publish + pt-serve restart could
///    then delete a live staging dir.
///
/// We acquire the lock PER-ENTRY, hold it across that entry's `remove_dir_all`, and release at end
/// of iteration. A held lock causes us to SKIP THIS ENTRY and retry the acquire on the next (so a
/// long- running producer doesn't pin the whole sweep to no-op). Holding the lock across the rmdir
/// closes the TOCTOU window where a producer could start a new publish into a dir we're about to
/// delete (says the producer takes the lock BEFORE writing into `.publishing/`, so as long as we
/// hold it the dir contents are stable).
pub fn cleanup_startup_artifacts(data_root: &Path, clock: &dyn Clock) -> io::Result<()> {
    // Step 1: pointer-tmp sweep.
    for sibling in ["current.json.tmp", "last-good.json.tmp"] {
        let p = data_root.join(sibling);
        match fs::remove_file(&p) {
            Ok(()) => { /* deleted a stale tmp */ }
            Err(e) if e.kind() == io::ErrorKind::NotFound => { /* expected */ }
            // Other errors (permission, etc.) bubble up — operator visibility.
            Err(e) => return Err(e),
        }
    }
    // Step 2: .publishing/ sweep.
    let publishing = data_root.join(".publishing");
    if !publishing.is_dir() {
        return Ok(());
    }
    let now = clock.now();
    let one_hour = Duration::from_secs(3600);

    // The single per-data-root producer lock. Computed once; acquired
    // per-entry below so a long-running producer skips THAT entry only,
    // not the entire sweep. See module doc for the per-entry hold rationale.
    let producer_lock_path = data_root.join("producer.lock");

    for entry in fs::read_dir(&publishing)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let mtime = match fs::metadata(&path).and_then(|m| m.modified()) {
            Ok(t) => t,
            Err(_) => continue, // unreadable; skip
        };
        let age = now.duration_since(mtime).unwrap_or(Duration::ZERO);
        if age <= one_hour {
            continue; // young → keep; producer might still be working
        }
        // Acquire the producer lock for this remove; held across the rmdir
        // to close the TOCTOU window. Released at end of iteration.
        match try_acquire_producer_lock(&producer_lock_path) {
            None => {
                // Producer holds the lock → respect it and skip this entry.
                continue;
            }
            Some(_guard) => {
                // Old AND we hold the producer lock → safe to remove.
                let _ = fs::remove_dir_all(&path);
                // _guard drops here → flock released, fd closed.
            }
        }
    }
    Ok(())
}

/// Try to acquire the per-data-root producer lock non-blocking. Returns
/// `Some(OwnedFd)` if acquired (caller must keep the fd alive to hold the
/// lock); `None` if held by another process or unopenable.
///
/// We do NOT create the file — the producer's `acquire()` creates it as
/// part of the publish protocol ( step 1). If the file doesn't exist,
/// nothing is publishing, so we can proceed.
fn try_acquire_producer_lock(lock_path: &Path) -> Option<std::os::fd::OwnedFd> {
    use rustix::fs::{flock, FlockOperation};
    use std::os::fd::AsFd;
    // Open create+read+write so we behave the same as the producer (which
    // opens with create=true). Without create, a stale lock file removed
    // between two cleanup iterations would make this return None and we'd
    // silently skip the rest of the sweep.
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path)
        .ok()?;
    let fd: std::os::fd::OwnedFd = file.into();
    match flock(fd.as_fd(), FlockOperation::NonBlockingLockExclusive) {
        Ok(()) => Some(fd), // we hold it; caller keeps fd alive to keep lock
        Err(_) => None,     // EWOULDBLOCK / EAGAIN — producer has it
    }
}

/// `true` iff `<lock_path>` is currently held by some process. Convenience
/// wrapper around [`try_acquire_producer_lock`] for callers that don't need
/// the guard. Note: a `true` result means SOMEONE has it (could be us in a
/// nested-acquire bug — flock(2) is per-OFD on Linux, so two acquires from
/// the same process via different OpenOptions WILL both succeed; this
/// helper is only meaningful across processes).
#[doc(hidden)]
pub fn producer_lock_held(lock_path: &Path) -> bool {
    try_acquire_producer_lock(lock_path).is_none()
}

/// Test helper: re-export `SystemTime::now()` for tests that don't need a
/// MockClock. Wrapped so the test crate doesn't pull `std::time` directly.
#[doc(hidden)]
pub fn now() -> std::time::SystemTime {
    std::time::SystemTime::now()
}
