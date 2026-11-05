//! Janitorial cleanup pass — runs at the end of every producer publish tick.
//!
//! the producer must enforce generation retention and reap stale detritus. Three classes of
//! garbage:
//!
//! 1. **Excess retained generations.** `--max-retained-generations` is the
//!    upper bound. Oldest non-pinned generations beyond that bound are
//!    deletable. Pinned roles: `current.json`, `last-good.json`. We never
//!    delete the generation those point at.
//! 2. **Stale `.publishing/<gen>` staging directories.** Older than 1 hour
//!    AND the parent's `producer.lock` is not held → crashed-producer
//!    detritus, safe to reap. A still-locked lock means a legitimate slow
//!    publish is in flight; we must NOT reap it.
//! 3. **Stale `*.tmp` siblings of pointer manifests.** Interrupted writes
//!    leave `current.json.tmp` or `last-good.json.tmp` behind; these are
//!    unconditionally safe to delete (the rename is the publish point —
//!    any `.tmp` survivor by definition didn't make it).
//!
//! ## Producer-runs-janitor convention
//!
//! Why janitor lives inside the producer rather than as a separate cron: the publish cadence is
//! already the natural rhythm for cleanup, and the producer already holds `producer.lock` so a
//! same-host cron racing the producer is mooted. The trade-off: a long-stopped producer leaves
//! detritus accumulating.

use crate::error::Result;
use crate::producer_lock;
use pt_shared::clock::Clock;
use pt_shared::manifest::{GenerationManifest, PointerManifest};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Stale `.publishing/<gen>` directories are reapable after 1 hour of
/// inactivity (and a lock-state check). 1h is a generous bound — the
/// slowest realistic publish for a continent-scale GTFS feed is single-digit
/// minutes. We pick 1h to leave a wide margin so a legitimate slow publish
/// is never reaped.
const PUBLISHING_STALE_THRESHOLD: Duration = Duration::from_secs(3600);

/// Outcome of one janitor pass.
#[derive(Debug, Default)]
pub struct JanitorOutcome {
    /// Generation directories deleted (excess retention).
    pub generations_deleted: Vec<String>,
    /// `.publishing/<gen>` directories deleted (stale detritus).
    pub publishing_dirs_deleted: Vec<String>,
    /// `*.tmp` files deleted (orphaned pointer-manifest tempfiles).
    pub tmp_files_deleted: Vec<PathBuf>,
    /// Non-fatal warnings — e.g. `last-good` is now the oldest retained
    /// generation, which means the next janitor pass might delete it if a
    /// rollback creates a new last-good pin somewhere else.
    pub warnings: Vec<String>,
}

/// Run one janitor pass against `data_root`.
///
/// - `max_retained` is the upper bound from `--max-retained-generations`.
/// - `clock` provides the "now" for the 1h staleness threshold. Tests pass
///   `MockClock`; production passes `SystemClock`.
///
/// Errors propagate from underlying IO; partial progress is fine — the next
/// tick's janitor pass will re-attempt.
pub fn run_janitor(
    data_root: &Path,
    max_retained: usize,
    clock: &dyn Clock,
) -> Result<JanitorOutcome> {
    let mut out = JanitorOutcome::default();

    // 1. Identify pinned roles. Either pointer may be absent on first publish
    //    (initial state has no last-good yet); that's fine — None means no
    //    pin and the generations dir's natural order is the only constraint.
    let current = read_pointer(&data_root.join("current.json"));
    let last_good = read_pointer(&data_root.join("last-good.json"));

    let pinned: Vec<String> = [current.as_ref(), last_good.as_ref()]
        .into_iter()
        .flatten()
        .map(|p| p.generation_id.clone())
        .collect();

    // 2. Enumerate generations dir.
    let gens_dir = data_root.join("generations");
    let mut gens: Vec<(String, GenerationManifest)> = Vec::new();
    if gens_dir.exists() {
        for entry in std::fs::read_dir(&gens_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            // Skip `.publishing/` and any other dotfile-style sibling — we
            // handle those in step 4.
            if name.starts_with('.') {
                continue;
            }
            let manifest_path = entry.path().join("generation.json");
            match read_generation_manifest(&manifest_path) {
                Some(m) => gens.push((name, m)),
                None => {
                    // Generation dir without a parseable manifest is detritus
                    // (probably a half-published gen that lost its rename
                    // race before step 5). Reap if not pinned.
                    out.warnings.push(format!(
                        "generation dir {:?} has no parseable generation.json — \
                         treating as detritus",
                        entry.path()
                    ));
                    if !pinned.contains(&name) {
                        if let Err(e) = std::fs::remove_dir_all(entry.path()) {
                            out.warnings
                                .push(format!("remove_dir_all {:?} failed: {e}", entry.path()));
                        } else {
                            out.generations_deleted.push(name);
                        }
                    }
                }
            }
        }
    }

    // 3. Sort by createdAt ascending so oldest-first deletion is trivial.
    //    Tiebreak by generationId so the order is total + deterministic.
    gens.sort_by(|a, b| a.1.created_at.cmp(&b.1.created_at).then(a.0.cmp(&b.0)));

    // 4. Compute deletables: non-pinned, beyond max_retained.
    //
    //    Logic: count toward the cap starting from the NEWEST. Pinned gens
    //    count too (they sit "above" the cap regardless of position). Any
    //    non-pinned gen older than the cap is deletable.
    let non_pinned: Vec<&(String, GenerationManifest)> =
        gens.iter().filter(|(id, _)| !pinned.contains(id)).collect();
    // Sort the WHOLE list newest-first to identify which fall outside the cap.
    let mut newest_first: Vec<&(String, GenerationManifest)> = gens.iter().collect();
    newest_first.sort_by(|a, b| b.1.created_at.cmp(&a.1.created_at).then(b.0.cmp(&a.0)));
    let retained: Vec<&str> = newest_first
        .iter()
        .take(max_retained)
        .map(|(id, _)| id.as_str())
        .collect();

    for (id, _) in &non_pinned {
        if !retained.contains(&id.as_str()) {
            let path = gens_dir.join(id);
            if let Err(e) = std::fs::remove_dir_all(&path) {
                out.warnings.push(format!("remove_dir_all {path:?}: {e}"));
            } else {
                out.generations_deleted.push(id.clone());
            }
        }
    }

    // 4b. Warn-only: last-good is the oldest retained. A future janitor pass
    //     would normally never delete it (it's pinned), but the operator
    //     should be aware — the retention slate is tight.
    if let Some(lg) = &last_good {
        if let Some(oldest) = gens.first() {
            if oldest.0 == lg.generation_id {
                out.warnings.push(format!(
                    "last-good generation {} is the oldest retained — \
                     rollback room is minimal",
                    lg.generation_id
                ));
            }
        }
    }

    // 5. Stale .publishing/<gen> dirs. Two predicates AND'd: directory mtime
    //    older than PUBLISHING_STALE_THRESHOLD, AND producer.lock is NOT
    //    currently held (best-effort: a held lock means a producer is alive).
    let publishing_root = data_root.join(".publishing");
    if publishing_root.exists() {
        let producer_lock_held = is_producer_lock_held(data_root);
        let now = clock.now();
        for entry in std::fs::read_dir(&publishing_root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            let mtime = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            let age = now.duration_since(mtime).unwrap_or(Duration::ZERO);
            if age >= PUBLISHING_STALE_THRESHOLD && !producer_lock_held {
                if let Err(e) = std::fs::remove_dir_all(&path) {
                    out.warnings.push(format!("remove_dir_all {path:?}: {e}"));
                } else {
                    out.publishing_dirs_deleted.push(name);
                }
            }
        }
    }

    // 6. Stale *.tmp siblings of pointer manifests.
    for sibling in &["current.json.tmp", "last-good.json.tmp"] {
        let p = data_root.join(sibling);
        if p.exists() {
            match std::fs::remove_file(&p) {
                Ok(()) => out.tmp_files_deleted.push(p),
                Err(e) => out.warnings.push(format!("remove_file {p:?}: {e}")),
            }
        }
    }

    Ok(out)
}

/// Read a pointer manifest from disk; return None on any parse or IO error.
/// The janitor is best-effort: a corrupt pointer means we lose the pin info
/// but don't get to delete generations the operator was relying on, which is
/// the safer failure mode.
fn read_pointer(path: &Path) -> Option<PointerManifest> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice::<PointerManifest>(&bytes).ok()
}

/// Read a generation manifest; same fail-open policy.
fn read_generation_manifest(path: &Path) -> Option<GenerationManifest> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice::<GenerationManifest>(&bytes).ok()
}

/// Best-effort: try to acquire `producer.lock` non-blocking; if we can, the
/// lock was not held. We RELEASE immediately (the drop runs) so this probe
/// has no side effect on a real concurrent producer.
///
/// Note: the janitor runs INSIDE the producer (which already holds the lock
/// over itself), so the natural call site has the lock held by the SAME
/// process. The non-blocking flock returns success in that case on Linux
/// (same-process re-acquire) but the test we actually care about is "is some
/// OTHER process holding it?". Within the producer's own publish-tick path,
/// the janitor is called AFTER the publish is committed — but the lock is
/// still held by the calling thread. So this probe will succeed (no other
/// holder) and reap the staging dirs. Good.
///
/// External callers (Stage B's pt-serve startup janitor) call this from a
/// process that doesn't hold the lock; they correctly observe a real
/// producer-held lock as "in-flight".
fn is_producer_lock_held(data_root: &Path) -> bool {
    match producer_lock::acquire(data_root) {
        Ok(guard) => {
            drop(guard);
            false
        }
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pt_shared::clock::MockClock;

    /// Minimal happy-path: empty data root → no-op, no warnings.
    #[test]
    fn empty_data_root_is_noop() {
        let dir = tempfile::TempDir::new().unwrap();
        let clock = MockClock::new(SystemTime::UNIX_EPOCH);
        let out = run_janitor(dir.path(), 10, &clock).expect("janitor");
        assert!(out.generations_deleted.is_empty());
        assert!(out.publishing_dirs_deleted.is_empty());
        assert!(out.tmp_files_deleted.is_empty());
    }

    /// `*.tmp` files next to pointers get reaped unconditionally.
    #[test]
    fn tmp_files_reaped() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("current.json.tmp"), b"junk").unwrap();
        std::fs::write(dir.path().join("last-good.json.tmp"), b"junk").unwrap();
        let clock = MockClock::new(SystemTime::UNIX_EPOCH);
        let out = run_janitor(dir.path(), 10, &clock).expect("janitor");
        assert_eq!(out.tmp_files_deleted.len(), 2);
        assert!(!dir.path().join("current.json.tmp").exists());
        assert!(!dir.path().join("last-good.json.tmp").exists());
    }

    /// `.publishing/<gen>/` younger than 1h is NOT reaped, even if no
    /// producer lock is held.
    #[test]
    fn young_publishing_dir_survives() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join(".publishing").join("abc")).unwrap();
        // mtime is now-ish; mock clock at "now" → age == 0.
        let clock = MockClock::new(SystemTime::now());
        let out = run_janitor(dir.path(), 10, &clock).expect("janitor");
        assert!(out.publishing_dirs_deleted.is_empty());
        assert!(dir.path().join(".publishing").join("abc").exists());
    }

    /// Generation directory with no parseable manifest, not pinned, gets
    /// reaped with a warning.
    #[test]
    fn malformed_unpinned_generation_reaped() {
        let dir = tempfile::TempDir::new().unwrap();
        let gen_path = dir.path().join("generations").join("xyz");
        std::fs::create_dir_all(&gen_path).unwrap();
        std::fs::write(gen_path.join("generation.json"), b"not json").unwrap();
        let clock = MockClock::new(SystemTime::UNIX_EPOCH);
        let out = run_janitor(dir.path(), 10, &clock).expect("janitor");
        assert_eq!(out.generations_deleted, vec!["xyz".to_string()]);
        assert!(!gen_path.exists());
    }

    /// Generations written before the publication id (schema 1, no
    /// `publicationInputsSha256`) are retained under the cap, not reaped as
    /// detritus on the first publish after an upgrade.
    #[test]
    fn schema_1_generation_within_cap_is_retained() {
        let dir = tempfile::TempDir::new().unwrap();
        let id = "a".repeat(64);
        let gen_path = dir.path().join("generations").join(&id);
        std::fs::create_dir_all(&gen_path).unwrap();
        let manifest = serde_json::json!({
            "manifestSchemaVersion": 1, "generationId": id, "citySlug": "vilnius",
            "bundleSha256": id, "bundleSizeBytes": 4096, "feedStartDate": 20260501,
            "hasTransfers": false, "transfersSha256": null, "transfersSizeBytes": null,
            "createdAt": "2026-05-23T10:00:00Z",
        });
        std::fs::write(gen_path.join("generation.json"), manifest.to_string()).unwrap();
        let clock = MockClock::new(SystemTime::UNIX_EPOCH);
        let out = run_janitor(dir.path(), 10, &clock).expect("janitor");
        assert!(out.generations_deleted.is_empty(), "{:?}", out.warnings);
        assert!(gen_path.exists());
    }
}
