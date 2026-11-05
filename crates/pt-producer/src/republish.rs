//! `pt-producer republish` — DR escape hatch.
//!
//! Operators run this when the live periodic-refresh pipeline is stuck and
//! they need to ship a known-good cached GTFS zip to pt-serve immediately.
//! It bypasses normal scheduling but runs the SAME publish protocol
//! (steps 3..=10 of [`refresh::publish_inner`]) so the on-disk shape is
//! indistinguishable from a periodic-refresh publish.
//!
//! ## Behavior
//!
//! 1. Acquire `producer.lock` (same as periodic-refresh).
//! 2. `--archive-to <dir>`: copy the current generation's bundle + current.json
//!    to `<dir>/<timestamp>/` BEFORE publishing — preserves the broken state
//!    for forensics. Skipped if `--archive-to` is absent or no `current.json`
//!    exists yet.
//! 3. Run `refresh::publish_inner` over the cached zip.
//! 4. Janitor + SIGHUP fire as part of `publish_inner` step 9b/10.
//!
//! ## Why this lives outside `publish_one_tick`
//!
//! The two flows differ in:
//! - Input source (periodic-refresh: live URL or local zip; republish:
//!   ALWAYS a local cached zip via `--from-cache`).
//! - Archival step (only republish offers `--archive-to`).
//! - CLI semantics (subcommand vs sibling subcommand) — operators see them
//!   as distinct verbs in the runbook.
//!
//! The shared trunk is [`refresh::publish_inner`] (steps 2..=10).

use crate::download;
use crate::error::{Error, Result};
use crate::fault_inject::FaultPoint;
use crate::producer_lock;
use crate::refresh::{self, PublishOutcome};
use crate::sentinel;
use pt_shared::clock::Clock;
use std::path::Path;

/// Execute the republish DR flow.
///
/// - `data_root` — same path the producer normally publishes to.
/// - `city` — operator-supplied slug; cross-checked against the cached zip's
///   eventual `generation.json` city_slug at validation time.
/// - `cache_zip` — path to the cached GTFS zip.
/// - `archive_to` — optional. When set, the current generation's bundle +
///   `current.json` is copied to `<archive_to>/<rfc3339-timestamp>/` BEFORE
///   the new publish flips current.json. The destination directory is
///   created with `mkdir -p` semantics. If the producer has never published
///   before (no `current.json`), the archival step is a no-op.
/// - `anchor_date` — same semantics as periodic-refresh.
/// - `transfers_path` — optional pre-built transfers.bin (matches the
///   periodic-refresh contract).
/// - `address_search_path` — optional pre-built address-search.json (matches
///   the periodic-refresh contract). Omitting it here republishes a
///   generation with no address corpus, which takes
///   `/api/<city>/address-search*` dark until the next periodic tick stages
///   the sidecar again.
/// - `max_retained_generations` — janitor cap.
#[allow(clippy::too_many_arguments)]
pub fn run_republish(
    data_root: &Path,
    city: &str,
    cache_zip: &Path,
    archive_to: Option<&Path>,
    anchor_date: Option<u32>,
    transfers_path: Option<crate::refresh::TransfersSource<'_>>,
    address_search_path: Option<&Path>,
    max_retained_generations: usize,
    city_tz_offset_seconds: Option<i32>,
    city_tz_iana: Option<&str>,
    derive_inseat: crate::cli::DeriveInseat,
    clock: &dyn Clock,
) -> Result<PublishOutcome> {
    run_republish_many(
        data_root,
        city,
        &[cache_zip.to_path_buf()],
        archive_to,
        anchor_date,
        transfers_path,
        address_search_path,
        max_retained_generations,
        city_tz_offset_seconds,
        city_tz_iana,
        derive_inseat,
        clock,
    )
}

/// Publish a complete ordered component set through the same atomic protocol.
/// Input order is stable; callers must supply source-scoped IDs for unions.
#[allow(clippy::too_many_arguments)]
pub fn run_republish_many(
    data_root: &Path,
    city: &str,
    cache_zips: &[std::path::PathBuf],
    archive_to: Option<&Path>,
    anchor_date: Option<u32>,
    transfers_path: Option<crate::refresh::TransfersSource<'_>>,
    address_search_path: Option<&Path>,
    max_retained_generations: usize,
    city_tz_offset_seconds: Option<i32>,
    city_tz_iana: Option<&str>,
    derive_inseat: crate::cli::DeriveInseat,
    clock: &dyn Clock,
) -> Result<PublishOutcome> {
    eprintln!(
        "[producer] republish start data_root={} city={} cache={} archive_to={}",
        data_root.display(),
        city,
        cache_zips
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(","),
        archive_to
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "<none>".into()),
    );

    if !data_root.exists() {
        return Err(Error::Config(format!(
            "data root does not exist: {} — operator must create the directory first",
            data_root.display()
        )));
    }
    if cache_zips.is_empty() || cache_zips.iter().any(|p| !p.is_file()) {
        return Err(Error::Config(
            "supply a complete, nonempty set of --from-cache files".into(),
        ));
    }

    // Step 1: producer.lock. Same guard semantics as periodic-refresh.
    let _lock = producer_lock::acquire(data_root).map_err(|e| match e {
        producer_lock::ProducerLockError::AlreadyLocked { existing_pid } => Error::Config(format!(
            "producer.lock already held by pid={} — refusing to republish; \
             ensure the existing pt-producer terminates before re-running",
            existing_pid
                .map(|p| p.to_string())
                .unwrap_or_else(|| "unknown".into()),
        )),
        producer_lock::ProducerLockError::Io(e) => Error::Io(e),
    })?;

    // Sentinel: keep the producer-side view of the data root mount fresh.
    // Best-effort (matches periodic-refresh).
    if let Err(e) = sentinel::write_producer_sentinel(data_root) {
        eprintln!("[producer] sentinel write failed (non-fatal): {e}");
    }

    // Step 1b (republish-only): archive the current generation if requested.
    // This runs UNDER the producer lock so a concurrent producer can't move
    // the bundle out from under us mid-copy. We do NOT fsync the archive
    // copies — operator forensics, not load-bearing for the publish protocol.
    if let Some(archive_root) = archive_to {
        archive_current_generation(data_root, archive_root, clock)?;
    }

    // Step 3..10 via the shared trunk. We pre-built FeedRecord same as the
    // periodic-refresh wrapper does in main.rs.
    let feeds = cache_zips
        .iter()
        .map(|path| download::record_for_local(path))
        .collect::<Result<Vec<_>>>()?;
    refresh::publish_inner(
        data_root,
        city,
        feeds,
        anchor_date,
        transfers_path,
        address_search_path,
        max_retained_generations,
        city_tz_offset_seconds,
        city_tz_iana,
        derive_inseat,
        FaultPoint::from_env(),
        None, // republish is a single-tick DR command; no daemon stop flag
        clock,
    )
}

/// Copy `<data_root>/current.json` and `<data_root>/generations/<id>/` to
/// `<archive_root>/<rfc3339-stamp>/`. No-op if `current.json` doesn't exist.
///
/// We use `std::fs::copy` plus a recursive walk rather than shelling out to
/// `cp -a` so the behaviour is identical in test and prod, and so a missing
/// `cp` on a stripped container doesn't break the DR path.
fn archive_current_generation(
    data_root: &Path,
    archive_root: &Path,
    clock: &dyn Clock,
) -> Result<()> {
    let current_path = data_root.join("current.json");
    if !current_path.exists() {
        eprintln!(
            "[producer] republish archive: no current.json at {} — first publish, nothing to archive",
            current_path.display()
        );
        return Ok(());
    }

    // Read current.json to find the pinned generation id. We tolerate any
    // parse failure as a warning + skip (the archival step is forensics,
    // not load-bearing).
    let pointer_bytes = std::fs::read(&current_path)?;
    let pointer: pt_shared::manifest::PointerManifest = match serde_json::from_slice(&pointer_bytes)
    {
        Ok(p) => p,
        Err(e) => {
            eprintln!(
                "[producer] republish archive: current.json unparseable ({e}) — skipping archival"
            );
            return Ok(());
        }
    };

    // The stamp uses the same RFC 3339 format the manifest uses; replace
    // colons with hyphens so the directory name is filesystem-portable
    // (Windows / SMB shares disallow `:` in filenames; we don't currently
    // target Windows but the archive may be shipped off-host).
    let raw_stamp = refresh::format_rfc3339(clock.now());
    let safe_stamp = raw_stamp.replace(':', "-");
    let dest_root = archive_root.join(&safe_stamp);
    std::fs::create_dir_all(&dest_root)?;

    // Archive current.json itself.
    std::fs::copy(&current_path, dest_root.join("current.json"))?;

    // Archive the pinned generation directory recursively.
    let gen_src = data_root.join("generations").join(&pointer.generation_id);
    if gen_src.exists() {
        let gen_dest = dest_root.join("generation").join(&pointer.generation_id);
        std::fs::create_dir_all(&gen_dest)?;
        copy_dir_recursive(&gen_src, &gen_dest)?;
    } else {
        eprintln!(
            "[producer] republish archive: current.json points at generation {} \
             but generations/{} is missing — archived only the pointer",
            pointer.generation_id, pointer.generation_id,
        );
    }

    // last-good.json is interesting forensic context too — archive it if
    // present.
    let last_good = data_root.join("last-good.json");
    if last_good.exists() {
        std::fs::copy(&last_good, dest_root.join("last-good.json"))?;
    }

    eprintln!(
        "[producer] republish archive: wrote forensic copy to {}",
        dest_root.display()
    );
    Ok(())
}

/// Minimal recursive `cp -r`. Symlinks are followed (we expect plain files).
fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let dest_path = dest.join(&name);
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&path, &dest_path)?;
        } else {
            std::fs::copy(&path, &dest_path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pt_shared::clock::MockClock;
    use std::time::SystemTime;

    /// `--archive-to` skipped → no archive dir is created.
    #[test]
    fn republish_without_archive_skips_copy() {
        let dir = tempfile::TempDir::new().unwrap();
        let clock = MockClock::new(SystemTime::UNIX_EPOCH);
        // No current.json + no archive arg → trivially succeed.
        archive_current_generation(dir.path(), &dir.path().join("archive"), &clock).expect("noop");
        assert!(
            !dir.path().join("archive").exists(),
            "no archive directory should be created when there is no current.json"
        );
    }

    /// `--archive-to` set + current.json present → a forensic copy is written.
    #[test]
    fn republish_with_archive_writes_forensic_copy() {
        let dir = tempfile::TempDir::new().unwrap();
        // Fake a complete published state: current.json + generations/<id>/.
        let gen_id = "deadbeef";
        let gen_dir = dir.path().join("generations").join(gen_id);
        std::fs::create_dir_all(&gen_dir).unwrap();
        std::fs::write(gen_dir.join("bundle.ptb"), b"fake-ptb-content").unwrap();
        std::fs::write(
            gen_dir.join("generation.json"),
            r#"{"manifestSchemaVersion":1,"generationId":"deadbeef","citySlug":"vilnius","bundleSha256":"deadbeef","bundleSizeBytes":16,"feedStartDate":20260524,"hasTransfers":false,"transfersSha256":null,"transfersSizeBytes":null,"createdAt":"2026-05-24T00:00:00Z"}"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join("current.json"),
            r#"{"manifestSchemaVersion":1,"generationId":"deadbeef","citySlug":"vilnius","createdAt":"2026-05-24T00:00:00Z"}"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join("last-good.json"),
            r#"{"manifestSchemaVersion":1,"generationId":"deadbeef","citySlug":"vilnius","createdAt":"2026-05-23T00:00:00Z"}"#,
        )
        .unwrap();

        let archive_root = dir.path().join("archive");
        let clock = MockClock::new(SystemTime::UNIX_EPOCH);
        archive_current_generation(dir.path(), &archive_root, &clock).expect("archive");

        // Find the single timestamped subdir.
        let stamped: Vec<_> = std::fs::read_dir(&archive_root)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .collect();
        assert_eq!(stamped.len(), 1, "exactly one timestamped archive dir");
        let stamp_dir = &stamped[0];
        assert!(stamp_dir.join("current.json").exists());
        assert!(stamp_dir.join("last-good.json").exists());
        assert!(stamp_dir
            .join("generation")
            .join(gen_id)
            .join("bundle.ptb")
            .exists());
        assert!(stamp_dir
            .join("generation")
            .join(gen_id)
            .join("generation.json")
            .exists());
    }

    /// `archive_current_generation` is a no-op when there's no current.json.
    /// Producer's first-ever republish (data root exists but never published)
    /// must not fail.
    #[test]
    fn archive_with_no_current_json_is_noop() {
        let dir = tempfile::TempDir::new().unwrap();
        let archive_root = dir.path().join("archive");
        let clock = MockClock::new(SystemTime::UNIX_EPOCH);
        archive_current_generation(dir.path(), &archive_root, &clock).expect("noop");
        // The archive dir SHOULD NOT exist because the function returns early.
        assert!(
            !archive_root.exists(),
            "no archive dir should be created when there's nothing to archive"
        );
    }
}
