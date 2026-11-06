//! P4 publish protocol — `publish_one_tick` (periodic-refresh) and the shared
//! [`publish_inner`] helper that `republish` also calls.
//!
//! The function is structured one ASCII comment per step so a reader can `Ctrl-F` "step 5" and find
//! the matching call site. Fault-injection abort points correspond to documented boundaries
//! (`FaultPoint::AfterStep4` fires at end of step 4, etc).
//!
//! ## Invariants
//!
//! - Producer lock is held for steps 1..=9. SIGHUP is sent in step 10 AFTER
//!   `current.json` is durable; if the SIGHUP fails (pidfile absent / pt-
//!   serve not running) we log + continue — a missing pt-serve is not a
//!   publish failure.
//! - Every file write goes through tmp-write → fsync(tmp) → rename → fsync
//!   (parent). The parent-dir fsync is what makes the rename durable across
//!   crash; on ext4 `data=ordered` (the default) skipping it loses the
//!   rename on power loss.
//! - The staging directory is `<data_root>/.publishing/<gen-id>/`. The
//! janitor handles the case where this directory survives a crash:
//!   the 1-hour staleness threshold + lock-state check is the reap predicate.
//! - The janitor runs AT END OF STEP 9 (before SIGHUP) on every successful
//!   publish — see step 9b below. Each tick therefore self-bounds the
//!   retention slate.
//!
//! ## Stage B factoring
//!
//! `publish_one_tick` (periodic-refresh mode) and `republish::publish_from_cache`
//! both share the steps-3-through-10 trunk. We factor that trunk into
//! [`publish_inner`] which takes pre-supplied feed records (and optionally a
//! pre-built `transfers.bin` blob); the two callers diverge only in how they
//! source the input.

use crate::build::{sha256_hex, BuildOutcome};
use crate::error::{Error, Result};
use crate::fault_inject::{maybe_abort_at, FaultPoint};
use crate::janitor::{self, JanitorOutcome};
use crate::producer_lock;
use crate::ptb_v2::build_published;
use crate::sentinel;
use pt_shared::clock::Clock;
use pt_shared::manifest::{GenerationManifest, PointerManifest};
use pt_shared::pack_manifest::{
    validate_artifact_path, PackArtifact, PackFeed, PackManifest, PackRights,
};
use pt_shared::validate::metadata::validate_metadata;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::os::fd::AsFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

// Thread-local, NOT process-global: `publish_inner` runs on the installing
// test's own thread, and libtest runs tests in parallel threads — a global
// mutator would fire inside every concurrently running publish test and
// corrupt its pack.json (observed as flaky sizeBytes/citySlug mismatches).
#[cfg(test)]
thread_local! {
    static PACK_MANIFEST_TEST_MUTATOR: std::cell::Cell<Option<fn(&Path)>> =
        const { std::cell::Cell::new(None) };
}

#[cfg(test)]
fn maybe_mutate_pack_manifest_for_test(staging_dir: &Path) {
    if let Some(mutate) = PACK_MANIFEST_TEST_MUTATOR.with(|m| m.get()) {
        mutate(staging_dir);
    }
}

#[cfg(not(test))]
fn maybe_mutate_pack_manifest_for_test(_staging_dir: &Path) {}

/// Reason a publish tick was paused without doing work.
#[derive(Debug, PartialEq, Eq)]
pub enum PausedReason {
    /// `producer.paused` sentinel was present — operator-initiated park.
    OperatorPaused,
    /// `pt-serve.version` sentinel reported a version older than the producer
    /// requires; waiting for the pt-serve image to be rolled out.
    PtServeVersionMismatch,
    /// `pt-serve.version` sentinel was present but could not be parsed.
    PtServeVersionMalformed,
}

/// Output of one publish tick.
#[derive(Debug)]
pub enum PublishOutcome {
    /// Published a new generation and updated `current.json`. Carries the
    /// newly-published `generationId`.
    Published {
        generation_id: String,
        /// Outcome of the janitor sweep that ran at the end of step 9.
        /// Stage B wires this through so the caller can log retention metrics.
        janitor: JanitorOutcome,
    },
    /// The tick was a no-op for a known reason. `current.json` is unchanged.
    Paused { reason: PausedReason },
    /// `current.json` already pointed at this content (idempotent re-publish
    /// of the same `generationId`). No filesystem changes.
    Noop { generation_id: String },
}

/// Where a generation's pedestrian transfer table (PTFT) comes from.
///
/// RAPTOR inter-stop walking is a build-time table;
/// both variants produce it before pt-serve ever sees the generation.
#[derive(Debug, Clone, Copy)]
pub enum TransfersSource<'a> {
    /// A pre-built `transfers.bin`, copied verbatim (`--transfers`).
    Prebuilt(&'a Path),
    /// An osmium GeoJSONSeq walking graph (plain or `.gz`). The producer
    /// prices every stop of THIS generation's bundle over it, so the table's
    /// stop set always matches the PTB it ships with (`--walking-graph`).
    WalkingGraph(&'a Path),
}

/// Hash immutable input bytes rather than their paths/mtime. The same inputs
/// participate in both the skip key and publication identity, so an OSM-only
/// change cannot collide with a previously published PTB generation.
fn publication_inputs(
    code_sha: Option<&str>,
    transfers: Option<TransfersSource<'_>>,
    addresses: Option<&Path>,
) -> Result<String> {
    fn file_hash(path: &Path) -> Result<String> {
        use std::io::Read;
        let mut input = std::fs::File::open(path)?;
        let mut hash = Sha256::new();
        let mut buffer = [0; 65536];
        loop {
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        Ok(format!("{:x}", hash.finalize()))
    }
    fn code_tree(
        root: &Path,
        directory: &Path,
        prefix: &str,
        inputs: &mut std::collections::BTreeMap<String, String>,
    ) -> Result<()> {
        if !directory.exists() {
            return Ok(());
        }
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                return Err(Error::Config(
                    "generator code must not contain symlinks".into(),
                ));
            }
            if kind.is_dir() {
                code_tree(root, &entry.path(), prefix, inputs)?;
            } else if kind.is_file() {
                inputs.insert(
                    format!(
                        "{prefix}/{}",
                        entry.path().strip_prefix(root).unwrap().display()
                    ),
                    file_hash(&entry.path())?,
                );
            }
        }
        Ok(())
    }
    let mut inputs = std::collections::BTreeMap::<String, String>::new();
    // An unreadable executable leaves the code out of the identity, as the
    // generation id did before publication inputs existed. The skip key is
    // also unavailable then, so every tick still builds (see build_inputs).
    inputs.insert("code".into(), code_sha.unwrap_or("unidentified").into());
    match transfers {
        Some(TransfersSource::Prebuilt(path)) => {
            inputs.insert("transfers-prebuilt".into(), file_hash(path)?);
        }
        Some(TransfersSource::WalkingGraph(path)) => {
            inputs.insert("transfers-walking".into(), file_hash(path)?);
        }
        None => {}
    }
    if let Some(path) = addresses {
        inputs.insert("addresses".into(), file_hash(path)?);
    }
    for name in [
        "PT_COLOR_BUILD",
        "PT_TILE_BUILD",
        "PT_TILE_THREADS",
        "PT_TILE_BROTLI_QUALITY",
    ] {
        inputs.insert(name.into(), std::env::var(name).unwrap_or_default());
    }
    let color = parse_color_artifact_builder(std::env::var_os("PT_COLOR_BUILD").as_deref())?;
    let tile = parse_schedule_tile_builder(std::env::var_os("PT_TILE_BUILD").as_deref())?;
    for (name, path, enabled) in [
        (
            "color-script",
            color_artifacts_script_path(),
            color == ColorArtifactBuilder::Node,
        ),
        (
            "tile-script",
            schedule_tile_script_path(),
            tile == ScheduleTileBuilder::Node,
        ),
    ] {
        if enabled {
            let path = Path::new(&path);
            inputs.insert(name.into(), file_hash(path)?);
            if let Some(backend) = path.parent().and_then(Path::parent) {
                let dist = backend.join("dist");
                code_tree(&dist, &dist, &format!("{name}/backend-code"), &mut inputs)?;
                if let Some(packages) = backend.parent() {
                    let shared = packages.join("shared/dist");
                    code_tree(
                        &shared,
                        &shared,
                        &format!("{name}/shared-code"),
                        &mut inputs,
                    )?;
                }
            }
        }
    }
    Ok(sha256_hex(
        &serde_json::to_vec(&inputs).map_err(|e| Error::Config(e.to_string()))?,
    ))
}

/// Top-level publish-tick entry. The caller is responsible for holding the
/// producer lock — this fn DOES acquire it internally (step 1) but the
/// lifetime is the function call, not the entire `pt-producer` process.
///
/// `transfers_path` is the Stage B knob: if `Some(path)`, the named file
/// (typically pre-built by `scripts/build-transfers.mjs` or a sibling
/// `--engine=osrm` run) is published alongside `bundle.ptb`. If `None`,
/// `hasTransfers=false` is emitted and pt-serve falls back to its haversine
/// internal table at query time.
///
/// `address_search_path` is the same shape of knob for the optional address
/// corpus: if `Some(path)`, the named `address-search.json` is copied into
/// every staged generation so pt-serve's `/api/<city>/address-search*` routes
/// stay alive across refresh ticks. If `None`, the generation carries none and
/// those routes 404.
///
/// `stop` is the daemon's SIGTERM/SIGINT flag installed by
/// `idle::install_signal_handler`. When set, the step-2.5 absent-retry loop
/// exits early so SIGTERM latency stays ≤ ~1 s. Pass `None` from callers
/// that run a single tick without a signal handler (e.g. `republish`).
#[allow(clippy::too_many_arguments)]
pub fn publish_one_tick(
    data_root: &Path,
    city: &str,
    feed_records: Vec<crate::download::FeedRecord>,
    anchor_date: Option<u32>,
    transfers_path: Option<TransfersSource<'_>>,
    address_search_path: Option<&Path>,
    max_retained_generations: usize,
    city_tz_offset_seconds: Option<i32>,
    city_tz_iana: Option<&str>,
    derive_inseat: crate::cli::DeriveInseat,
    stop: Option<&AtomicBool>,
    clock: &dyn Clock,
) -> Result<PublishOutcome> {
    let fault = FaultPoint::from_env();

    // ----------------------- Step 1: producer.lock -----------------------
    //
    // Exclusive flock for the duration of the tick. If a second producer is
    // already running we exit early with a clear error naming the conflicting
    // PID. The lock is held via the returned ProducerLock guard's OwnedFd;
    // releasing happens when `_lock` drops at end-of-fn (success or panic).
    let _lock = producer_lock::acquire(data_root).map_err(|e| match e {
        producer_lock::ProducerLockError::AlreadyLocked { existing_pid } => Error::Config(format!(
            "producer.lock already held by pid={} — refusing to publish; \
             ensure the existing pt-producer terminates before re-running",
            existing_pid
                .map(|p| p.to_string())
                .unwrap_or_else(|| "unknown".into()),
        )),
        producer_lock::ProducerLockError::Io(e) => Error::Io(e),
    })?;

    // Test-only fault hook: hold the producer.lock for 2s after acquire so a
    // concurrent second producer deterministically races a held lock. The
    // integration test in `crates/pt-serve/tests/publish_protocol_faults.rs::
    // concurrent_producers_serialize_via_lock` pairs this with a second
    // producer (no fault) to assert the second observes EWOULDBLOCK rather
    // than relying on OS-scheduler luck for overlap. Logged so a stray env
    // var in CI is visible.
    if fault == Some(FaultPoint::HoldLockFor2s) {
        eprintln!(
            "[producer] FAULT_INJECT=hold_lock_for_2s — sleeping 2s while holding producer.lock"
        );
        std::thread::sleep(std::time::Duration::from_secs(2));
    }

    // Stable binding is load-bearing: reject a different deployment's root
    // before publishing. The legacy stat diagnostic remains best-effort.
    pt_shared::data_root_identity::verify_configured(data_root)?;
    if let Err(e) = sentinel::write_producer_sentinel(data_root) {
        eprintln!("[producer] sentinel write failed (non-fatal): {e}");
    }

    publish_inner(
        data_root,
        city,
        feed_records,
        anchor_date,
        transfers_path,
        address_search_path,
        max_retained_generations,
        city_tz_offset_seconds,
        city_tz_iana,
        derive_inseat,
        fault,
        stop,
        clock,
    )
}

/// Whether a running pt-serve advertises the sole PTB contract emitted by this
/// producer. PTB v1 is an exact capability, not a minimum-version floor.
fn pt_serve_supports_current_version(reported: u16) -> bool {
    reported == pt_core::PTB_VERSION
}

/// Steps 2..=10 of the publish protocol. Both `publish_one_tick`
/// (periodic-refresh) and `republish::publish_from_cache` call this after
/// they've acquired the producer lock and sourced the input feed records.
///
/// The caller MUST hold the producer lock before invoking. The function
/// does NOT take the lock itself (so the lock can be held across the cache
/// archival step in republish without re-acquiring).
///
/// `stop` is the daemon's SIGTERM/SIGINT flag (from `idle::install_signal_handler`).
/// When `Some` and set, the step-2.5 absent-retry loop exits early so SIGTERM
/// latency stays ≤ ~1 s. Pass `None` from single-tick callers (e.g. `republish`).
#[allow(clippy::too_many_arguments)]
pub(crate) fn publish_inner(
    data_root: &Path,
    city: &str,
    feed_records: Vec<crate::download::FeedRecord>,
    anchor_date: Option<u32>,
    transfers_path: Option<TransfersSource<'_>>,
    address_search_path: Option<&Path>,
    max_retained_generations: usize,
    city_tz_offset_seconds: Option<i32>,
    city_tz_iana: Option<&str>,
    derive_inseat: crate::cli::DeriveInseat,
    fault: Option<FaultPoint>,
    stop: Option<&AtomicBool>,
    clock: &dyn Clock,
) -> Result<PublishOutcome> {
    // ----------------------- Step 2: producer.paused -----------------------
    //
    // Start-of-tick check. The operator can park the producer by creating
    // `<data_root>/producer.paused`; we re-check at step 6 because the
    // pipeline is long-running and an operator-initiated rollback can land
    // mid-publish.
    if data_root.join("producer.paused").exists() {
        eprintln!("[producer] producer.paused present at start of tick — exiting 0 (no-op)");
        return Ok(PublishOutcome::Paused {
            reason: PausedReason::OperatorPaused,
        });
    }

    // ----------------------- Step 2.5: pt-serve version gate ---------------
    //
    // pt-serve image MUST be deployed before producer image. Compose depends_on currently orders
    // the OPPOSITE way (producer starts first), so on a cold deploy the sentinel is briefly absent.
    // Retry-wait with capped attempts, then fail closed: an absent sentinel means no pt-serve has
    // advertised PTB v1 read capability. On a present-but-different version, return Paused {
    // PtServeVersionMismatch } so compose restart doesn't loop us through the full pass-1 build.
    //
    // SIGTERM safety: each 5 s sleep is split into 10 × 500 ms increments
    // that check the stop flag, so SIGTERM latency inside the retry window
    // is ≤ ~500 ms instead of up to 5 s.
    {
        use crate::sentinel::{read_pt_serve_version, PtServeVersionCheck};
        let emitted_version = pt_core::PTB_VERSION;
        // Default 12 attempts × 5 s = ~60 s of absent-retry on a cold deploy.
        // `PT_SERVE_VERSION_ABSENT_RETRY_ATTEMPTS` overrides it (tests set
        // it to 0 to reach the FINAL absent verdict without the 60 s wall-clock
        // wait; never set in prod). Parse failure falls back to the default.
        const ABSENT_RETRY_ATTEMPTS_DEFAULT: u32 = 12;
        let absent_retry_attempts: u32 = std::env::var("PT_SERVE_VERSION_ABSENT_RETRY_ATTEMPTS")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(ABSENT_RETRY_ATTEMPTS_DEFAULT);
        // Each "interval" is broken into 10 × 500 ms ticks so we can check
        // the stop flag and keep SIGTERM latency ≤ ~500 ms.
        const SLEEP_TICK_MS: u64 = 500;
        const SLEEP_TICKS_PER_INTERVAL: u32 = 10; // 10 × 500 ms = 5 s
        let mut attempt = 0;
        let final_check = loop {
            match read_pt_serve_version(data_root) {
                PtServeVersionCheck::Absent if attempt < absent_retry_attempts => {
                    eprintln!(
                        "[producer] pt-serve.version sentinel absent (attempt {}/{}); \
                         retrying in {}ms",
                        attempt + 1,
                        absent_retry_attempts,
                        SLEEP_TICK_MS * SLEEP_TICKS_PER_INTERVAL as u64,
                    );
                    attempt += 1;
                    // Sleep in short increments so SIGTERM fires within ~500 ms.
                    for _ in 0..SLEEP_TICKS_PER_INTERVAL {
                        if stop.is_some_and(|s| s.load(Ordering::SeqCst)) {
                            eprintln!(
                                "[producer] pt-serve.version retry interrupted by stop signal"
                            );
                            return Ok(PublishOutcome::Paused {
                                reason: PausedReason::OperatorPaused,
                            });
                        }
                        std::thread::sleep(std::time::Duration::from_millis(SLEEP_TICK_MS));
                    }
                }
                other => break other,
            }
        };
        match final_check {
            PtServeVersionCheck::Absent => {
                // An absent sentinel means no pt-serve has advertised matching
                // read capability on this data root yet. Permitting here could
                // publish a bundle no running server can parse.
                //
                // This does NOT deadlock a normal fresh deploy: pt-serve writes
                // its capability at STARTUP (main.rs), independent of loading
                // a generation, so a compatible running
                // pt-serve has already written the sentinel by the time the
                // producer's NEXT periodic-refresh tick re-invokes this gate
                // (the periodic loop in main.rs treats a Pause as non-terminal
                // — it sleeps `refresh_interval` and ticks again). The Pause
                // is counted in pt_producer_pt_serve_version_skips_total.
                eprintln!(
                    "[producer] WARN pt-serve.version sentinel absent after {absent_retry_attempts} \
                     attempts (~{}s) and producer emits v{emitted_version}; no pt-serve has \
                     advertised matching read-capability yet — skipping tick. Deploy/await a \
                     compatible pt-serve (it writes the sentinel at startup), then the next \
                     refresh will publish. Counted in pt_producer_pt_serve_version_skips_total.",
                    absent_retry_attempts
                        * (SLEEP_TICK_MS as u32 * SLEEP_TICKS_PER_INTERVAL / 1000),
                );
                return Ok(PublishOutcome::Paused {
                    reason: PausedReason::PtServeVersionMismatch,
                });
            }
            PtServeVersionCheck::Malformed => {
                eprintln!(
                    "[producer] WARN pt-serve.version sentinel malformed; skipping tick. \
                     Operator must investigate."
                );
                return Ok(PublishOutcome::Paused {
                    reason: PausedReason::PtServeVersionMalformed,
                });
            }
            PtServeVersionCheck::Present(v) if !pt_serve_supports_current_version(v) => {
                eprintln!(
                    "[producer] WARN pt-serve.version reports v{v} but producer emits v{emitted_version} — \
                     skipping tick; roll out pt-serve image then wait for next refresh. \
                     Counted in pt_producer_pt_serve_version_skips_total."
                );
                return Ok(PublishOutcome::Paused {
                    reason: PausedReason::PtServeVersionMismatch,
                });
            }
            PtServeVersionCheck::Present(_) => {
                // Permitted; carry on.
            }
        }
    }

    // ----------------------- Step 2.7: unchanged inputs -------------------
    //
    // The producer publishes PTB v2 only. Its origins need the city zone, and
    // the window is anchored like the v1 build (rolling today unless pinned).
    // Both are fixed here, once, so the inputs key and the build below can
    // never straddle midnight with different anchors.
    let anchor = anchor_date.unwrap_or_else(crate::date_utils::today_yyyymmdd);
    let iana = city_tz_iana
        .ok_or_else(|| Error::Config("PTB v2 publication requires a city IANA zone".into()))?;
    // Inputs identical to the last build's produce the same bundle, so the
    // generation they produced is still current: skip the build instead of
    // rebuilding it only to throw it away at the Step 3 Noop check below.
    // Fault-injected runs always build, so the faults fire where they say.
    let publication_inputs_sha256 = publication_inputs(
        crate::build_inputs::producer_code_sha(),
        transfers_path,
        address_search_path,
    )?;
    let inputs_key = match fault {
        Some(_) => None,
        None => crate::build_inputs::BuildInputs {
            feeds: &feed_records,
            anchor,
            tz_offset_seconds: city_tz_offset_seconds,
            tz_iana: iana,
            derive_inseat,
            publication_inputs_sha256: &publication_inputs_sha256,
        }
        .key(),
    };
    if let Some(gen_id) = inputs_key
        .as_deref()
        .and_then(|k| crate::build_inputs::unchanged_generation(data_root, k))
    {
        eprintln!("[producer] inputs unchanged since generation {gen_id}; build skipped");
        return Ok(PublishOutcome::Noop {
            generation_id: gen_id,
        });
    }

    // ----------------------- Step 3: build PTB ----------------------------
    //
    // Hand the build pipeline a scratch dir for unzip. The output is a PTB
    // file at a temp path inside data_root/.publishing/<random>/; we'll
    // rename to <gen-id>/ once we know the SHA in step 4.
    //
    // ENOSPC handling: real ENOSPC surfaces as io::Error from the underlying
    // write. We propagate as-is so the producer aborts non-zero with the
    // raw errno; the janitor reaps the half-written staging dir on the
    // next tick.
    if fault == Some(FaultPoint::EnospcStep3) {
        eprintln!("[producer] FAULT_INJECT=enospc_step_3 — simulating ENOSPC at bundle write");
        // Create the staging-root and a placeholder so the janitor still has
        // something to reap (the test asserts staging dir survives).
        let publishing_root = data_root.join(".publishing");
        std::fs::create_dir_all(&publishing_root)?;
        let stage_tmp = publishing_root.join("enospc-simulated");
        std::fs::create_dir_all(&stage_tmp)?;
        return Err(Error::Io(std::io::Error::from_raw_os_error(28)));
    }

    let publishing_root = data_root.join(".publishing");
    std::fs::create_dir_all(&publishing_root)?;
    // Use a UUID-ish unique name for the pre-SHA staging dir. We don't have
    // the SHA yet, so use process pid + monotonic counter to avoid clashes
    // with a concurrent (impossible — we hold the lock) or a leftover stale
    // dir.
    let pre_sha_dir = publishing_root.join(format!(
        "pending-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    ));
    std::fs::create_dir_all(&pre_sha_dir)?;
    let bundle_path = pre_sha_dir.join("bundle.ptb");
    let extract_root = pre_sha_dir.join("extract");

    let outcome: BuildOutcome = build_published(
        feed_records,
        &extract_root,
        &bundle_path,
        anchor,
        city_tz_offset_seconds,
        iana,
        derive_inseat,
    )?;

    // Now we know the SHA → rename pre_sha_dir to <gen-id>/
    let gen_id =
        pt_shared::manifest::publication_id(&outcome.bundle_sha256, &publication_inputs_sha256);
    let staging_dir = publishing_root.join(&gen_id);
    if staging_dir.exists() {
        // Idempotent re-publish: clean up the duplicate work we just did.
        // The "real" staging dir is the existing one (committed by a prior
        // tick that crashed BEFORE step 7). Reap our pre-SHA dir; the
        // existing staging dir survives the janitor's 1h check and a future
        // tick will retry.
        std::fs::remove_dir_all(&pre_sha_dir).ok();
        return Err(Error::Config(format!(
            "staging dir for generation {gen_id} already exists — \
             a prior crashed tick left detritus; rerun after janitor reap",
        )));
    }
    std::fs::rename(&pre_sha_dir, &staging_dir)?;

    // Check if `generations/<gen-id>/` already exists — if so this content was already published;
    // idempotent no-op.
    let final_gen_dir = data_root.join("generations").join(&gen_id);
    if final_gen_dir.join("generation.json").exists() {
        // Already published; drop our work + return Noop. The orphaned
        // staging dir won't survive the next janitor pass.
        std::fs::remove_dir_all(&staging_dir).ok();
        let already_current = current_generation_on_disk(data_root).as_deref() == Some(&gen_id);
        if !already_current {
            let existing: GenerationManifest =
                serde_json::from_slice(&std::fs::read(final_gen_dir.join("generation.json"))?)
                    .map_err(|e| Error::Config(e.to_string()))?;
            if existing.generation_id != gen_id
                || existing.bundle_sha256 != outcome.bundle_sha256
                || existing.publication_inputs_sha256 != publication_inputs_sha256
            {
                return Err(Error::Config(
                    "existing publication identity mismatch".into(),
                ));
            }
            let pack: PackManifest =
                serde_json::from_slice(&std::fs::read(final_gen_dir.join("pack.json"))?)
                    .map_err(|e| Error::Config(e.to_string()))?;
            pack.validate_pack_id()
                .map_err(|e| Error::Config(e.to_string()))?;
            validate_pack_against_dir(&pack, &final_gen_dir).map_err(Error::Config)?;
            if data_root.join("producer.paused").exists() {
                return Ok(PublishOutcome::Paused {
                    reason: PausedReason::OperatorPaused,
                });
            }
            activate_pointer(
                data_root,
                &PointerManifest {
                    manifest_schema_version: 2,
                    generation_id: gen_id.clone(),
                    city_slug: city.into(),
                    created_at: existing.created_at,
                },
            )?;
            if let Some(k) = &inputs_key {
                crate::build_inputs::record(data_root, k, &gen_id);
            }
            if let Err(error) = send_sighup(data_root) {
                eprintln!("[producer] WARN reactivation SIGHUP failed: {error}");
            }
            return Ok(PublishOutcome::Published {
                generation_id: gen_id,
                janitor: janitor::run_janitor(data_root, max_retained_generations, clock)
                    .unwrap_or_default(),
            });
        }
        if let Some(k) = &inputs_key {
            crate::build_inputs::record(data_root, k, &gen_id);
        }
        return Ok(PublishOutcome::Noop {
            generation_id: gen_id,
        });
    }

    // bundle.ptb now lives at staging_dir/bundle.ptb. Re-fsync it via a
    // fresh open(O_RDONLY) — that's a Linux fsync no-op for already-flushed
    // pages, but on macOS F_FULLFSYNC needs a writable fd. Open write-only.
    fsync_file(&staging_dir.join("bundle.ptb"))?;
    fsync_dir(&staging_dir)?;

    // ---- Step 3b (Stage B): optional transfers.bin pre-built artifact -----
    //
    // If the operator supplied `--transfers <path>`, copy the file into the
    // staging dir, compute its SHA-256 + size, and wire `hasTransfers=true`
    // into the manifest. Failure to copy is a publish error (we can't ship a
    // partial transfers pair). The Rust producer doesn't itself BUILD transfers
    // (that's the Node `scripts/build-transfers.mjs` job); we just propagate
    // a pre-built artifact through the protocol so the producer/consumer
    // contract carries it. Stage C wires the Node builder into the same
    // periodic-refresh job.
    let transfers_meta: Option<TransfersInfo> = match transfers_path {
        Some(TransfersSource::Prebuilt(src)) => Some(stage_transfers(src, &staging_dir)?),
        Some(TransfersSource::WalkingGraph(graph)) => {
            Some(build_and_stage_transfers(graph, &staging_dir, city)?)
        }
        None => None,
    };

    // ---- Step 3b2: optional address-search.json pre-built artifact --------
    //
    // Same propagate-only contract as transfers above: the producer does not
    // build the address corpus. Staged into EVERY generation because the read
    // side is generation-scoped — see stage_address_search's docstring for why
    // a hand-placed file cannot survive the refresh loop.
    if let Some(src) = address_search_path {
        let size_bytes = stage_address_search(src, &staging_dir)?;
        eprintln!(
            "[producer] address-search staged from {} size_bytes={size_bytes}",
            src.display()
        );
    }

    // ---- Step 3c: departures-idx.bin sidecar (Stage C C1b) ----------------
    // build_ptb produced the complete bytes (header + CSR). Write them into
    // the staging dir, fsync, and read back to hash (torn-write protection,
    // consistent with bundle.ptb). The SHA goes into the manifest; it does
    // NOT feed gen_id (see the reconcile note above).
    let dep_idx_path = staging_dir.join("departures-idx.bin");
    std::fs::write(&dep_idx_path, &outcome.departures_idx_bytes)?;
    fsync_file(&dep_idx_path)?;
    fsync_dir(&staging_dir)?;
    let departures_idx_sha256 = sha256_hex(&std::fs::read(&dep_idx_path)?);

    // ---- Step 3d: shapes.bin sidecar (Stage C C1c) ------------------------
    // build_ptb produced the complete bytes (SHPB header + index + polylines).
    // Same staging discipline as departures-idx.bin: write, fsync, read back
    // to hash (torn-write protection). The SHA goes into the manifest; it does
    // do not directly feed gen_id; their effective inputs are bound separately.
    let shapes_bin_path = staging_dir.join("shapes.bin");
    std::fs::write(&shapes_bin_path, &outcome.shapes_bin_bytes)?;
    fsync_file(&shapes_bin_path)?;
    fsync_dir(&staging_dir)?;
    let shapes_bin_sha256 = sha256_hex(&std::fs::read(&shapes_bin_path)?);

    // ---- Step 3e: precomputed color artifacts + shapes-JSON hash (C-color-provenance) ----
    // PT_COLOR_BUILD selects the builder: "rust" runs the in-process port
    // (color_artifacts::build_color_artifacts); "node" (default until the
    // differential gate soak completes — see
    // the color artifacts rust native notes) shells
    // out to color-artifacts-gen.mjs as before. Every publish logs the
    // selected builder, mirroring PT_TILE_BUILD's Step 3g convention.
    let color_build = parse_color_artifact_builder(std::env::var_os("PT_COLOR_BUILD").as_deref())?;
    eprintln!(
        "[producer] color-artifacts builder={}",
        color_build.as_str()
    );
    let (color_config_sha256, route_styles_sha256, label_anchors_sha256) = if color_build
        == ColorArtifactBuilder::Rust
    {
        let outputs = crate::color_artifacts::build_color_artifacts(&staging_dir)?;
        // Same durability + defensive re-hash discipline as PT_TILE_BUILD=rust (Step 3g) and the
        // node path below: fsync, then re-read + re-hash the on-disk bytes to catch a torn write
        // between the build and this check. build_color_artifacts's write_and_hash helper already
        // fsyncs each file internally but hashes the in-memory buffer, not what actually landed on
        // disk — re-hash all three artifacts here from disk for that reason (code-quality review
        // gap).
        fsync_dir(&staging_dir)?;
        for (name, expected) in [
            ("color-config.json", &outputs.color_config_sha256),
            ("route-styles.json", &outputs.route_styles_sha256),
            ("label-anchors.json", &outputs.label_anchors_sha256),
        ] {
            let on_disk = sha256_hex(&std::fs::read(staging_dir.join(name))?);
            if &on_disk != expected {
                return Err(Error::Config(format!(
                        "{name} SHA mismatch right after build (rust path): produced={expected} on_disk={on_disk}"
                    )));
            }
        }
        (
            outputs.color_config_sha256,
            outputs.route_styles_sha256,
            outputs.label_anchors_sha256,
        )
    } else {
        // (a) Node step writes color-config.json + route-styles.json into the staging
        //     dir and prints "<name> <sha256> <bytes>" lines we parse.
        let node_out = std::process::Command::new("node")
            .arg(color_artifacts_script_path())
            .arg(&staging_dir)
            .output()
            .map_err(|e| Error::Config(format!("color-artifacts-gen spawn failed: {e}")))?;
        if !node_out.status.success() {
            return Err(Error::Config(format!(
                "color-artifacts-gen exited {:?}: {}",
                node_out.status.code(),
                String::from_utf8_lossy(&node_out.stderr),
            )));
        }
        let (mut color_config_sha256, mut route_styles_sha256) = (None, None);
        let mut label_anchors_sha256: Option<String> = None;
        fn is_sha256_hex(s: &str) -> bool {
            s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
        }
        for line in String::from_utf8_lossy(&node_out.stdout).lines() {
            let mut it = line.split_whitespace();
            match (it.next(), it.next()) {
                (Some("color-config.json"), Some(sha)) if is_sha256_hex(sha) => {
                    color_config_sha256 = Some(sha.to_string())
                }
                (Some("route-styles.json"), Some(sha)) if is_sha256_hex(sha) => {
                    route_styles_sha256 = Some(sha.to_string())
                }
                (Some("label-anchors.json"), Some(sha)) if is_sha256_hex(sha) => {
                    label_anchors_sha256 = Some(sha.to_string())
                }
                _ => {}
            }
        }
        let color_config_sha256 = color_config_sha256.ok_or_else(|| {
            Error::Config("color-artifacts-gen did not emit color-config.json sha".into())
        })?;
        let route_styles_sha256 = route_styles_sha256.ok_or_else(|| {
            Error::Config("color-artifacts-gen did not emit route-styles.json sha".into())
        })?;
        let label_anchors_sha256 = label_anchors_sha256.ok_or_else(|| {
            Error::Config("color-artifacts-gen did not emit label-anchors.json sha".into())
        })?;
        (
            color_config_sha256,
            route_styles_sha256,
            label_anchors_sha256,
        )
    };
    // (b) Rust-serialize the canonical shapes JSON from the staged shapes.bin so
    //     pt-serve (same serializer) produces identical bytes; record its sha+size.
    let (shapes_json_sha256, shapes_json_size_bytes) = {
        let bin = std::fs::read(staging_dir.join("shapes.bin"))?;
        let hdr = pt_shared::sidecar::parse_sidecar_header(&bin, *b"SHPB")
            .map_err(|e| Error::Config(format!("shapes.bin header: {e}")))?;
        let sb = pt_shared::sidecar::ShapesBin::parse(
            &bin,
            &hdr.trips_intern_sha256,
            &hdr.stops_intern_sha256,
        )
        .map_err(|e| Error::Config(format!("shapes.bin parse: {e}")))?;
        let json = pt_shared::sidecar::shapes_json_bytes(&sb);
        (sha256_hex(&json), json.len() as u64)
    };

    // ---- Step 3f: legacy JSON sidecars (loadFromPtb bridge until Plan-C4) --
    // The Node backend's `loadFromPtb` reads `<bundle>.meta.json` +
    // `<bundle>.shapes.json` adjacent to the PTB. The P4 gen-dir layout
    // otherwise lacks them, so a backend booted over a republished generation
    // throws → silent `ptb_fallback`. Write both here, reusing the same writers
    // `main.rs --out` uses. Both writers + this block retire when Plan-C4
    // deletes loadFromPtb.ts.
    let meta_path = staging_dir.join("bundle.ptb.meta.json");
    let shapes_path = staging_dir.join("bundle.ptb.shapes.json");
    let feed_metas: Vec<crate::sidecars::FeedMeta> = outcome
        .feed_records
        .iter()
        .map(|f| crate::sidecars::FeedMeta {
            url: f.url.clone(),
            blob_sha256: f.sha_hex.clone(),
            etag: f.etag.clone(),
        })
        .collect();
    let producer_sha: &str = option_env!("PT_PRODUCER_GIT_SHA").unwrap_or("unknown");
    let feed_start_date_iso = crate::sidecars::format_ymd(outcome.feed_start_date);
    crate::sidecars::write_meta(
        &meta_path,
        &feed_metas,
        producer_sha,
        &feed_start_date_iso,
        city_tz_iana,
        Some(outcome.derived_inseat_rules),
    )?;
    crate::sidecars::write_shapes(&shapes_path, &outcome.shape_groups)?;
    fsync_file(&meta_path)?;
    fsync_file(&shapes_path)?;
    fsync_dir(&staging_dir)?;

    // ---- Step 3g: schedule-tile producer build (interim spike-killer) ------
    // Build the per-cell tile bundle + manifest into `<staging>/schedule-tiles/`
    // (carried into the published gen dir by the whole-dir rename in step 8),
    // AFTER color-artifacts + the loadFromPtb-bridge sidecars: both builders
    // consume the staged bundle (bundle.ptb + bundle.ptb.{meta,shapes}.json)
    // and `route-styles.json` for tile colors. The default rust path runs the
    // in-process port (schedule_tiles::build_schedule_tiles), which takes
    // `gen_id` as an argument (no generation.json read) and hands back the
    // artifact SHAs directly. The node escape hatch shells
    // out to `schedule-tile-gen.mjs`, which additionally reads the staged
    // `generation.json` for the bundleHash (= generationId =
    // hex(bundle_sha256)) — so that branch writes a PROVISIONAL one (Step 5
    // overwrites it atomically with the full manifest) and parses
    // `schedule-tile-bundle <sha256-of-manifest.json> <bytes> <bundleHash>`
    // from the script's stdout.
    //
    // The explicit node escape hatch requires the script to exist. A missing
    // script is a configuration error: silently omitting the tile artifacts
    // would make a rollback/soak appear successful while publishing an
    // incomplete generation. Spec:
    let schedule_tile_bundle_sha256: Option<String>;
    let schedule_tile_bundle_hash: Option<String>;
    // C4 (B4/B6): producer-artifact SHAs (`trip-route.json` / `stop-cell.json`),
    // parsed from the SAME schedule-tile-gen stdout. Required iff the build ran.
    let trip_route_sha256: Option<String>;
    let stop_cell_sha256: Option<String>;
    // PT_TILE_BUILD selects the schedule-tile builder: "rust" (default) runs
    // the in-process port (schedule_tiles::build_schedule_tiles); "node" is
    // the escape hatch that shells out to schedule-tile-gen.mjs below. The
    // escape hatch is kept for one staging soak cycle then deleted along with
    // the node script.
    let tile_build = parse_schedule_tile_builder(std::env::var_os("PT_TILE_BUILD").as_deref())?;
    if tile_build == ScheduleTileBuilder::Rust {
        let config = crate::schedule_tiles::TileBuildConfig::from_env()?;
        eprintln!(
            "[producer] schedule-tile builder={} threads={} quality={}",
            tile_build.as_str(),
            config.threads,
            config.quality
        );
        let outputs =
            crate::schedule_tiles::build_schedule_tiles(&staging_dir, city, &gen_id, &config)?;
        schedule_tile_bundle_sha256 = Some(outputs.manifest_sha256);
        schedule_tile_bundle_hash = Some(outputs.bundle_hash);
        trip_route_sha256 = Some(outputs.trip_route_sha256);
        stop_cell_sha256 = Some(outputs.stop_cell_sha256);
        // Same durability + defensive re-hash discipline as the node path
        // below: fsync the produced manifest, then re-hash the on-disk bytes
        // to catch a torn write between the build and this check.
        let tile_manifest = staging_dir.join("schedule-tiles").join("manifest.json");
        fsync_file(&tile_manifest)?;
        fsync_dir(&staging_dir.join("schedule-tiles"))?;
        let on_disk = sha256_hex(&std::fs::read(&tile_manifest)?);
        if Some(&on_disk) != schedule_tile_bundle_sha256.as_ref() {
            let produced = schedule_tile_bundle_sha256.as_deref().unwrap_or("<unset>");
            return Err(Error::Config(format!(
                "schedule-tiles/manifest.json SHA mismatch right after build (rust path): \
                 produced={produced} on_disk={on_disk}"
            )));
        }
    } else {
        eprintln!("[producer] schedule-tile builder={}", tile_build.as_str());
        let schedule_tile_script = schedule_tile_script_path();
        if !Path::new(&schedule_tile_script).exists() {
            return Err(Error::Config(format!(
                "PT_TILE_BUILD=node but schedule-tile-gen script does not exist at {}",
                schedule_tile_script.to_string_lossy(),
            )));
        }
        // Provisional generation.json so the script can read the generationId.
        // Step 5 replaces this with the full, durable manifest.
        let provisional = serde_json::json!({ "generationId": gen_id });
        std::fs::write(
            staging_dir.join("generation.json"),
            serde_json::to_vec(&provisional).map_err(|e| Error::Io(std::io::Error::other(e)))?,
        )?;
        let tile_out = std::process::Command::new("node")
            .arg(&schedule_tile_script)
            .arg(&staging_dir)
            // The producer knows the city via the `city` parameter; the bundle
            // carries no slug, so wire it explicitly for the script.
            .env("PT_CITY_ID", city)
            .env("CITY_ID", city)
            .output()
            .map_err(|e| Error::Config(format!("schedule-tile-gen spawn failed: {e}")))?;
        if !tile_out.status.success() {
            return Err(Error::Config(format!(
                "schedule-tile-gen exited {:?}: {}",
                tile_out.status.code(),
                String::from_utf8_lossy(&tile_out.stderr),
            )));
        }
        let parsed = parse_producer_build_output(&String::from_utf8_lossy(&tile_out.stdout));
        // C4 (B-2/B-3): the trip-route/stop-cell SHA lines are required IFF the
        // schedule-tile-bundle line is present (i.e. the build ran). This runs
        // BEFORE the `?`-unwrap below so a build that printed the bundle line but
        // not the artifact lines (an old/torn emitter) fails the publish rather
        // than silently shipping a generation the consumer can't shed `canonical` on.
        parsed.validate_required()?;
        schedule_tile_bundle_sha256 = parsed.schedule_tile_bundle_sha256;
        schedule_tile_bundle_hash = parsed.schedule_tile_bundle_hash;
        trip_route_sha256 = parsed.trip_route_sha256;
        stop_cell_sha256 = parsed.stop_cell_sha256;
        let schedule_tile_bundle_sha256_ref =
            schedule_tile_bundle_sha256.as_ref().ok_or_else(|| {
                Error::Config(
                    "schedule-tile-gen did not emit a schedule-tile-bundle sha line".into(),
                )
            })?;
        // The script derives bundleHash from the provisional generation.json
        // `generationId`, so the parsed `<hash>` MUST equal `gen_id`
        // (= hex(bundle_sha256)). Enforce it in the production publish path
        // (previously only a unit test checked it): a stale/raced hash would
        // advertise a generationId the gen dir doesn't carry, cascading into
        // 409s on the backend's bundle-freshness gate.
        if let Some(hash) = schedule_tile_bundle_hash.as_ref() {
            if hash != &gen_id {
                return Err(Error::Config(format!(
                    "schedule-tile bundleHash != generationId: bundleHash={hash} generationId={gen_id}"
                )));
            }
        }
        // fsync the produced manifest so the staged bytes are durable before the
        // step-8 rename (same discipline as the other staged artifacts).
        let tile_manifest = staging_dir.join("schedule-tiles").join("manifest.json");
        fsync_file(&tile_manifest)?;
        fsync_dir(&staging_dir.join("schedule-tiles"))?;
        // Defensive: the recorded sha must match the manifest bytes on disk NOW
        // (the script computed it; re-hash to catch a torn write between the
        // script's write and ours). The step-7 offline-validate re-checks this
        // after the manifest is finalized, mirroring the color/sidecar guards.
        let on_disk = sha256_hex(&std::fs::read(&tile_manifest)?);
        if &on_disk != schedule_tile_bundle_sha256_ref {
            return Err(Error::Config(format!(
                "schedule-tiles/manifest.json SHA mismatch right after build: \
                 produced={schedule_tile_bundle_sha256_ref} on_disk={on_disk}"
            )));
        }
    }

    // ----------------------- Step 4: build manifest ----------------------
    //
    // Compose the GenerationManifest. createdAt comes from the clock; the
    // RFC 3339 format is strict (matches the metadata validator's parser).
    let created_at = format_rfc3339(clock.now());
    let city_tz_iana_owned = city_tz_iana.map(|s| s.to_string());
    let manifest = GenerationManifest {
        // Plan-C1a kept this at 1 (Postel rule): the new optional fields are
        // additive and absent-on-the-wire when None, so consumers built
        // against the old schema continue to parse new manifests.
        manifest_schema_version: 2,
        generation_id: gen_id.clone(),
        publication_inputs_sha256: publication_inputs_sha256.clone(),
        city_slug: city.to_string(),
        bundle_sha256: outcome.bundle_sha256.clone(),
        bundle_size_bytes: outcome.bundle_size_bytes,
        feed_start_date: outcome.feed_start_date,
        has_transfers: transfers_meta.is_some(),
        transfers_sha256: transfers_meta.as_ref().map(|t| t.sha256.clone()),
        transfers_size_bytes: transfers_meta.as_ref().map(|t| t.size_bytes),
        created_at,
        // Plan-C1a: optional sidecar SHA fields — Plan-C1b/c populate these
        // when the departures/shapes sidecars land. Absent-on-the-wire until.
        departures_idx_sha256: Some(departures_idx_sha256),
        shapes_bin_sha256: Some(shapes_bin_sha256),
        // real value sourced from the operator's `--city-tz-iana` flag (validated in main.rs via
        // `validate_tz`).
        city_tz_iana: city_tz_iana_owned,
        // Plan C-color-provenance (Step 3e): color-provenance fields. SHAs of
        // the Node-emitted color-config.json + route-styles.json, plus the
        // Rust-serialized canonical shapes JSON's sha + byte size.
        color_config_sha256: Some(color_config_sha256),
        route_styles_sha256: Some(route_styles_sha256),
        // Plan-C2a: SHA of the Node-emitted label-anchors.json (high-zoom stop
        // card label placement), parsed from the same color-artifacts-gen
        // stdout. Cross-checked at publish alongside the color artifacts.
        label_anchors_sha256: Some(label_anchors_sha256),
        shapes_json_sha256: Some(shapes_json_sha256),
        shapes_json_size_bytes: Some(shapes_json_size_bytes),
        // Derived window and counted fidelity flags, sourced
        // verbatim from the BuildOutcome (the SAME value emitted into the bundle's
        // bitmask stride + optional 0x01 region). Recorded so operators can see the
        // derived window without re-decoding the PTB.
        window_days: Some(outcome.window_days),
        window_clamped_high: outcome.window_clamped_high,
        window_floored_low: outcome.window_floored_low,
        // Service-bitfield deduplication provenance.
        service_bitfield_pool_count: outcome.service_bitfield_pool_count,
        num_services: outcome
            .service_bitfield_pool_count
            .map(|_| outcome.num_services),
        // Schedule-tile producer build (Step 3g). `None` when the script is
        // absent (omitted on the wire), `Some` when the producer built the
        // tiles — cross-checked in step 7.
        schedule_tile_bundle_sha256,
        schedule_tile_bundle_hash,
        // C4 (B4/B6): producer-artifact SHAs, parsed from the schedule-tile-gen
        // stdout (required iff the schedule-tile build ran — see Step 3g's
        // `validate_required`). `None` when the script was absent (omitted on
        // the wire, Postel rule). Cross-checked in step 7 alongside the
        // schedule-tile bundle when `Some`.
        trip_route_sha256,
        stop_cell_sha256,
    };

    let pack_manifest = build_pack_manifest(
        &staging_dir,
        city,
        &manifest,
        &outcome,
        &transfers_meta,
        city_tz_iana,
    )?;

    maybe_abort_at(fault, FaultPoint::AfterStep4);

    // ----------------------- Step 5: write manifest ----------------------
    //
    // tmp-write → fsync(tmp_fd) → rename → fsync(parent_dir). Same pattern
    // as current.json in step 9.
    let manifest_final = staging_dir.join("generation.json");
    let manifest_tmp = staging_dir.join("generation.json.tmp");
    {
        let bytes = serde_json::to_vec_pretty(&manifest)
            .map_err(|e| Error::Io(std::io::Error::other(e)))?;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&manifest_tmp)?;
        use std::io::Write as _;
        f.write_all(&bytes)?;
        pt_shared::fsync::durable(f.as_fd())?;
    }
    std::fs::rename(&manifest_tmp, &manifest_final)?;
    fsync_dir(&staging_dir)?;

    let pack_final = staging_dir.join("pack.json");
    let pack_tmp = staging_dir.join("pack.json.tmp");
    {
        let bytes = serde_json::to_vec_pretty(&pack_manifest)
            .map_err(|e| Error::Io(std::io::Error::other(e)))?;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&pack_tmp)?;
        use std::io::Write as _;
        f.write_all(&bytes)?;
        pt_shared::fsync::durable(f.as_fd())?;
    }
    std::fs::rename(&pack_tmp, &pack_final)?;
    fsync_dir(&staging_dir)?;

    maybe_mutate_pack_manifest_for_test(&staging_dir);

    maybe_abort_at(fault, FaultPoint::BetweenStep5AndStep7);

    // ----------------------- Step 6: producer.paused re-check ------------
    //
    // The publish protocol is long-running (PTB build over a continent-scale
    // feed is multi-minute). A start-of-tick check is insufficient: an
    // operator-initiated rollback that lands between step 2 and step 7 must
    // still abort cleanly.
    if data_root.join("producer.paused").exists() {
        eprintln!(
            "[producer] producer.paused appeared during publish — aborting + cleaning staging"
        );
        std::fs::remove_dir_all(&staging_dir).ok();
        return Ok(PublishOutcome::Paused {
            reason: PausedReason::OperatorPaused,
        });
    }

    // ----------------------- Step 7: offline validate --------------------
    //
    // The same metadata validator pt-serve will run at reload time. If the
    // staged bundle/manifest cross-checks fail HERE, we never flip
    // current.json — last-good stays valid, the operator's runbook surfaces
    // the staging-dir for forensics, and the janitor reaps it on a later
    // pass.
    let staged_pack_bytes = std::fs::read(staging_dir.join("pack.json"))?;
    let staged_pack: PackManifest = serde_json::from_slice(&staged_pack_bytes)
        .map_err(|e| Error::Config(format!("pack.json parse failed: {e}")))?;
    staged_pack
        .validate_shape()
        .map_err(|e| Error::Config(format!("pack.json shape invalid: {e}")))?;
    staged_pack
        .validate_pack_id()
        .map_err(|e| Error::Config(format!("pack.json packId invalid: {e}")))?;
    validate_pack_metadata(&staged_pack, &manifest, &outcome, city)
        .map_err(|e| Error::Config(format!("pack.json metadata invalid: {e}")))?;
    validate_pack_against_dir(&staged_pack, &staging_dir)
        .map_err(|e| Error::Config(format!("pack.json artifact validation failed: {e}")))?;

    let bundle_bytes = std::fs::read(staging_dir.join("bundle.ptb"))?;
    // Read transfers bytes back from the staged copy (NOT the source) so the
    // validator hashes the same bytes the consumer will mmap.
    let transfers_bytes: Option<Vec<u8>> = if transfers_meta.is_some() {
        Some(std::fs::read(staging_dir.join("transfers.bin"))?)
    } else {
        None
    };
    // Sidecar integrity: the staged file's SHA must match the manifest. A
    // mismatch = torn write between staging and validate; abort the tick (the
    // staging dir is reaped, current.json untouched). This is the drift-
    // detection the abandoned gen_id-fold was reaching for.
    let staged_dep_sha = sha256_hex(&std::fs::read(staging_dir.join("departures-idx.bin"))?);
    if Some(&staged_dep_sha) != manifest.departures_idx_sha256.as_ref() {
        return Err(Error::Config(format!(
            "departures-idx.bin SHA mismatch: staged={staged_dep_sha} manifest={:?}",
            manifest.departures_idx_sha256
        )));
    }
    // Sidecar integrity: shapes.bin staged SHA must match the manifest — same
    // torn-write guard as departures-idx.bin (abort the tick; current.json
    // untouched; janitor reaps the staging dir).
    let staged_shapes_sha = sha256_hex(&std::fs::read(staging_dir.join("shapes.bin"))?);
    if Some(&staged_shapes_sha) != manifest.shapes_bin_sha256.as_ref() {
        return Err(Error::Config(format!(
            "shapes.bin SHA mismatch: staged={staged_shapes_sha} manifest={:?}",
            manifest.shapes_bin_sha256
        )));
    }
    // Artifact integrity: staged color-config.json + route-styles.json SHAs must
    // match the manifest (torn-write guard, same as the sidecars).
    for (name, expect) in [
        ("color-config.json", manifest.color_config_sha256.as_ref()),
        ("route-styles.json", manifest.route_styles_sha256.as_ref()),
        ("label-anchors.json", manifest.label_anchors_sha256.as_ref()),
    ] {
        let staged = sha256_hex(&std::fs::read(staging_dir.join(name))?);
        if Some(&staged) != expect {
            return Err(Error::Config(format!(
                "{name} SHA mismatch: staged={staged} manifest={expect:?}"
            )));
        }
    }
    // Schedule-tile artifact integrity: when the producer built tiles, the
    // staged `schedule-tiles/manifest.json` SHA must match the recorded
    // `scheduleTileBundleSha256` (torn-write guard, same as the color/sidecar
    // artifacts; mirrors the backend's load-time check — bridge pattern). When
    // the build was skipped (field None) there is nothing to verify.
    if let Some(expect) = manifest.schedule_tile_bundle_sha256.as_ref() {
        let tile_manifest = staging_dir.join("schedule-tiles").join("manifest.json");
        let staged = sha256_hex(&std::fs::read(&tile_manifest).map_err(|e| {
            Error::Config(format!(
                "failed to read schedule-tiles manifest at {}: {e}",
                tile_manifest.display()
            ))
        })?);
        if &staged != expect {
            return Err(Error::Config(format!(
                "schedule-tiles/manifest.json SHA mismatch: staged={staged} manifest={expect}"
            )));
        }
    }
    // C4 (B4/B6) artifact integrity: when the producer build ran it staged
    // `trip-route.json` + `stop-cell.json` into the staging-dir root (they ride
    // the whole-dir rename); their on-disk SHAs must match the recorded manifest
    // fields (torn-write guard, same as the schedule-tile/color artifacts). When
    // the build was skipped (fields None) there is nothing to verify.
    for (name, expect) in [
        ("trip-route.json", manifest.trip_route_sha256.as_ref()),
        ("stop-cell.json", manifest.stop_cell_sha256.as_ref()),
    ] {
        if let Some(expect) = expect {
            let path = staging_dir.join(name);
            let staged = sha256_hex(&std::fs::read(&path).map_err(|e| {
                Error::Config(format!("failed to read {name} at {}: {e}", path.display()))
            })?);
            if &staged != expect {
                return Err(Error::Config(format!(
                    "{name} SHA mismatch: staged={staged} manifest={expect}"
                )));
            }
        }
    }
    let validate_result = validate_metadata(
        &manifest,
        &bundle_bytes,
        transfers_bytes.as_deref(),
        city,
        outcome.feed_start_date,
        clock.now(),
        true, // is_startup — we want the wider tolerance for a publish-time check
    );

    if fault == Some(FaultPoint::AfterStep7ValidateFail) {
        eprintln!(
            "[producer] FAULT_INJECT=after_step_7_validate_fail — synthesising validation error"
        );
        std::fs::remove_dir_all(&staging_dir).ok();
        return Err(Error::Config(
            "fault-injected validation failure (after_step_7_validate_fail)".into(),
        ));
    }

    if let Err(e) = validate_result {
        // Leave staging dir on disk for forensics; the janitor's 1h sweep
        // reaps it. Caller logs the error class.
        return Err(Error::Config(format!(
            "offline validation failed at step 7: {e:?} — staging dir \
             {staging_dir:?} preserved for forensics",
        )));
    }

    // ----------------------- Step 8: rename staging → final --------------
    //
    // Atomic on the same filesystem; overlayfs respects this on the upper
    // layer. fsync both parents (publishing/ and generations/) so the
    // rename is durable.
    if fault == Some(FaultPoint::MidRenameCopyup) {
        eprintln!(
            "[producer] FAULT_INJECT=mid_rename_copyup — synthesising overlayfs copy-up failure"
        );
        // Don't actually rename; leave staging on disk so the test can
        // assert the recovery path.
        return Err(Error::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "fault-injected overlayfs copy-up failure",
        )));
    }

    std::fs::create_dir_all(data_root.join("generations"))?;
    std::fs::rename(&staging_dir, &final_gen_dir)?;
    fsync_dir(&publishing_root)?;
    fsync_dir(&data_root.join("generations"))?;

    // ----------------------- Step 9: flip current.json -------------------
    //
    // tmp-write → fsync(tmp_fd) → rename → fsync(parent_dir). Skipping the parent fsync loses the
    // rename on ext4 data=ordered after power loss.
    let pointer = PointerManifest {
        manifest_schema_version: 2,
        generation_id: gen_id.clone(),
        city_slug: city.to_string(),
        created_at: manifest.created_at.clone(),
    };
    activate_pointer(data_root, &pointer)?;
    if let Some(k) = &inputs_key {
        crate::build_inputs::record(data_root, k, &gen_id);
    }

    // ----------------------- Step 9b (Stage B): janitor ------------------
    //
    // the publish cadence is the natural rhythm for retention enforcement. Run the janitor AFTER
    // current.json is durable so a crash mid-janitor doesn't lose the new generation we just
    // flipped to, and BEFORE SIGHUP so pt-serve doesn't reload while we're still trimming. (Order
    // matters: the janitor reads current.json + last-good.json to identify pinned generations.)
    //
    // Janitor errors are non-fatal: a same-process re-acquire of
    // producer.lock or a missing pointer file shouldn't fail an otherwise-
    // successful publish. Log + continue; the next tick's sweep retries.
    let janitor_outcome = match janitor::run_janitor(data_root, max_retained_generations, clock) {
        Ok(o) => {
            eprintln!(
                "[producer] janitor: generations_deleted={} publishing_dirs_deleted={} tmp_files_deleted={} warnings={}",
                o.generations_deleted.len(),
                o.publishing_dirs_deleted.len(),
                o.tmp_files_deleted.len(),
                o.warnings.len(),
            );
            for w in &o.warnings {
                eprintln!("[producer] janitor WARN: {w}");
            }
            o
        }
        Err(e) => {
            eprintln!("[producer] janitor pass failed (non-fatal): {e}");
            JanitorOutcome::default()
        }
    };

    maybe_abort_at(fault, FaultPoint::AfterStep9);

    // ----------------------- Step 10: signal pt-serve --------------------
    //
    // Read the pidfile; SIGHUP the PID. Missing pidfile is "no pt-serve
    // running" — log + continue, not an error.
    if let Err(e) = send_sighup(data_root) {
        eprintln!("[producer] SIGHUP delivery failed (non-fatal): {e}");
    }

    maybe_abort_at(fault, FaultPoint::AfterSighup);

    Ok(PublishOutcome::Published {
        generation_id: gen_id,
        janitor: janitor_outcome,
    })
}

/// Metadata captured for a staged `transfers.bin`. The manifest serialises
/// these fields when `has_transfers=true`.
struct TransfersInfo {
    sha256: String,
    size_bytes: u64,
}

/// Copy the source `transfers.bin` into `<staging_dir>/transfers.bin`, fsync
/// it durable, compute SHA-256 + size, and return the manifest metadata.
///
/// We hash the bytes that LANDED on disk (read back from the staged copy)
/// rather than the source — that way a torn-write inside the staging dir
/// surfaces here, not at pt-serve's startup-validator.
/// Copy the source packed address artifact into
/// `<staging_dir>/address-search.fst`, fsync, and return its size.
///
/// This exists because the address corpus is GENERATION-SCOPED on the read
/// side: pt-serve loads it from `<data-root>/generations/<sha>/
/// address-search.fst` (bundle/generation.rs `load_address_search_artifact`)
/// so a hot reload swaps corpus and PTB together. Every refresh tick builds a
/// fresh generation dir, so a sidecar placed by hand survives at most one
/// `--refresh-interval-secs` before the routes silently 404. Staging it here
/// is what makes it durable while keeping that atomic swap.
///
/// Deliberately NOT recorded in the generation manifest: unlike transfers, no
/// consumer cross-checks this artifact's SHA, and adding a field would be a
/// wire-format change for what is a propagate-only passthrough. pt-serve
/// validates the corpus itself at load (schemaVersion, cityId match, stats vs
/// row/key lengths) and treats absent as a supported state.
fn stage_address_search(src: &Path, staging_dir: &Path) -> Result<u64> {
    let dest = staging_dir.join("address-search.fst");
    std::fs::copy(src, &dest).map_err(|e| {
        Error::Config(format!(
            "failed to copy address-search from {} to {}: {e}",
            src.display(),
            dest.display()
        ))
    })?;
    // Same durability discipline as bundle.ptb and transfers.bin above.
    fsync_file(&dest)?;
    fsync_dir(staging_dir)?;
    Ok(std::fs::metadata(&dest)?.len())
}

/// Price every stop of the staged `bundle.ptb` over `graph` and stage the
/// resulting `transfers.bin`. Stop ids and positions come from the PTB itself,
/// so a feed that adds or renames stops can never leave the table stale.
fn build_and_stage_transfers(
    graph: &Path,
    staging_dir: &Path,
    city: &str,
) -> Result<TransfersInfo> {
    let bundle = std::fs::read(staging_dir.join("bundle.ptb"))?;
    let reader = pt_core::Reader::from_bytes(bundle)
        .map_err(|e| Error::Config(format!("transfers build: bundle.ptb reader: {e:?}")))?;
    let mut stops = Vec::with_capacity(reader.num_stops());
    for i in 0..reader.num_stops() {
        let bad =
            |what: &str| Error::Config(format!("transfers build: stop {i} {what} unreadable"));
        stops.push(crate::transfers::StopPoint {
            id: reader.stop_id(i).map_err(|_| bad("id"))?.to_string(),
            lat: reader.stop_lat_f64(i).map_err(|_| bad("lat"))?,
            lon: reader.stop_lon_f64(i).map_err(|_| bad("lon"))?,
        });
    }
    let (bytes, report) = crate::transfers::build_transfers(
        graph,
        &stops,
        crate::transfers::TransferParams::default(),
        city,
        "walking-graph",
    )?;
    eprintln!(
        "[producer] transfers built from {} stops={} snapped={} skipped={} edges={} p50={:?}s total_ms={}",
        graph.display(),
        report.inputs.stop_count,
        report.snap.snapped_count,
        report.snap.skipped_count,
        report.transfers.edge_count,
        report.transfers.walk_secs.p50,
        report.timing_ms.total,
    );
    let dest = staging_dir.join("transfers.bin");
    std::fs::write(&dest, &bytes)?;
    fsync_file(&dest)?;
    fsync_dir(staging_dir)?;
    let size_bytes = std::fs::read(&dest)?.len() as u64;
    Ok(TransfersInfo {
        sha256: sha256_hex(&std::fs::read(&dest)?),
        size_bytes,
    })
}

fn stage_transfers(src: &Path, staging_dir: &Path) -> Result<TransfersInfo> {
    let dest = staging_dir.join("transfers.bin");
    std::fs::copy(src, &dest).map_err(|e| {
        Error::Config(format!(
            "failed to copy transfers from {} to {}: {e}",
            src.display(),
            dest.display()
        ))
    })?;
    // Re-fsync the dest. Same pattern as bundle.ptb in step 3.
    fsync_file(&dest)?;
    fsync_dir(staging_dir)?;

    let bytes = std::fs::read(&dest)?;
    let size_bytes = bytes.len() as u64;
    let digest = Sha256::digest(&bytes);
    let mut sha256 = String::with_capacity(64);
    for b in digest.iter() {
        sha256.push_str(&format!("{b:02x}"));
    }
    Ok(TransfersInfo { sha256, size_bytes })
}

fn build_pack_manifest(
    staging_dir: &Path,
    city: &str,
    manifest: &GenerationManifest,
    outcome: &BuildOutcome,
    transfers_meta: &Option<TransfersInfo>,
    city_tz_iana: Option<&str>,
) -> Result<PackManifest> {
    let service_end_date =
        add_days_yyyymmdd(outcome.feed_start_date, i64::from(outcome.window_days) - 1);
    let stale_after = add_days_yyyymmdd(service_end_date, -14);

    let mut artifacts = Vec::new();
    let mut ptb_artifact = pack_artifact(
        "ptb",
        "bundle.ptb",
        manifest.bundle_sha256.clone(),
        manifest.bundle_size_bytes,
        true,
        "application/vnd.ptn.ptb",
    );
    ptb_artifact.format_version = Some(pt_core::PTB_VERSION);
    artifacts.push(ptb_artifact);

    if let Some(t) = transfers_meta {
        artifacts.push(pack_artifact(
            "pedestrian-transfers-ptft",
            "transfers.bin",
            t.sha256.clone(),
            t.size_bytes,
            false,
            "application/vnd.ptn.ptft",
        ));
    }
    if let Some(sha) = manifest.departures_idx_sha256.as_ref() {
        if staging_dir.join("departures-idx.bin").exists() {
            let mut artifact = staged_artifact(
                staging_dir,
                "departures-idx",
                "departures-idx.bin",
                sha,
                "application/vnd.ptn.dpix",
            )?;
            artifact.namespaces = sidecar_namespaces(staging_dir, "departures-idx.bin", *b"DPIX")?;
            artifacts.push(artifact);
        }
    }
    if let Some(sha) = manifest.shapes_bin_sha256.as_ref() {
        let mut artifact = staged_artifact(
            staging_dir,
            "shapes-bin",
            "shapes.bin",
            sha,
            "application/vnd.ptn.shpb",
        )?;
        artifact.bbox = Some(outcome.coverage_bbox);
        artifact.namespaces = sidecar_namespaces(staging_dir, "shapes.bin", *b"SHPB")?;
        artifacts.push(artifact);
    }
    for (kind, path, sha, media_type) in [
        (
            "color-config",
            "color-config.json",
            manifest.color_config_sha256.as_ref(),
            "application/json",
        ),
        (
            "route-styles",
            "route-styles.json",
            manifest.route_styles_sha256.as_ref(),
            "application/json",
        ),
        (
            "label-anchors",
            "label-anchors.json",
            manifest.label_anchors_sha256.as_ref(),
            "application/json",
        ),
        (
            "schedule-tiles-manifest",
            "schedule-tiles/manifest.json",
            manifest.schedule_tile_bundle_sha256.as_ref(),
            "application/json",
        ),
        (
            "trip-route",
            "trip-route.json",
            manifest.trip_route_sha256.as_ref(),
            "application/json",
        ),
        (
            "stop-cell",
            "stop-cell.json",
            manifest.stop_cell_sha256.as_ref(),
            "application/json",
        ),
    ] {
        if let Some(sha) = sha {
            push_staged_artifact(&mut artifacts, staging_dir, kind, path, sha, media_type)?;
        }
    }

    for (kind, path) in [
        ("legacy-meta-json", "bundle.ptb.meta.json"),
        ("legacy-shapes-json", "bundle.ptb.shapes.json"),
    ] {
        let full_path = staging_dir.join(path);
        if full_path.exists() {
            let bytes = std::fs::read(&full_path)?;
            artifacts.push(pack_artifact(
                kind,
                path,
                sha256_hex(&bytes),
                bytes.len() as u64,
                false,
                "application/json",
            ));
        }
    }

    // Address/POI/walking artifacts have independent publication lifecycles.
    // The local generation may still stage an address index for serving, but
    // the downloadable transit pack must not require or distribute that extra.

    let feeds: Vec<PackFeed> = outcome
        .feed_records
        .iter()
        .zip(outcome.feed_infos.iter())
        .map(|(record, info)| PackFeed {
            source_url: record.url.clone(),
            publisher_name: info.publisher_name.clone(),
            lang: info.lang.clone(),
            feed_version: info.feed_version.clone(),
            license: None,
        })
        .collect();

    let mut pack = PackManifest {
        schema_version: 2,
        pack_id: String::new(),
        bundle_id: manifest.bundle_sha256.clone(),
        generation_id: manifest.generation_id.clone(),
        publication_inputs_sha256: manifest.publication_inputs_sha256.clone(),
        city_slug: city.to_string(),
        city_tz_iana: city_tz_iana.map(str::to_string),
        created_at: manifest.created_at.clone(),
        feed_start_date: outcome.feed_start_date,
        window_days: outcome.window_days,
        service_end_date,
        stale_after: crate::sidecars::format_ymd(stale_after),
        hard_expire_after: crate::sidecars::format_ymd(service_end_date),
        stop_bbox: outcome.stop_bbox,
        coverage_bbox: outcome.coverage_bbox,
        coverage_incomplete_reasons: outcome.coverage_incomplete_reasons.clone(),
        feeds,
        rights: PackRights {
            redistributable: false,
            status: "unknown".into(),
            note: "not cleared for public CDN distribution".into(),
        },
        artifacts,
    };
    pack.validate_shape()
        .map_err(|e| Error::Config(format!("pack.json shape validation failed: {e}")))?;
    pack.pack_id = pack
        .compute_pack_id()
        .map_err(|e| Error::Config(format!("pack.json packId compute failed: {e}")))?;
    pack.validate_pack_id()
        .map_err(|e| Error::Config(format!("pack.json packId validation failed: {e}")))?;
    Ok(pack)
}

fn staged_artifact(
    staging_dir: &Path,
    kind: &str,
    path: &str,
    sha256: &str,
    media_type: &str,
) -> Result<PackArtifact> {
    let full_path = staging_dir.join(path);
    let size_bytes = std::fs::metadata(&full_path)
        .map_err(|e| {
            Error::Config(format!(
                "failed to stat pack artifact {}: {e}",
                full_path.display()
            ))
        })?
        .len();
    Ok(pack_artifact(
        kind,
        path,
        sha256.to_string(),
        size_bytes,
        false,
        media_type,
    ))
}

fn push_staged_artifact(
    artifacts: &mut Vec<PackArtifact>,
    staging_dir: &Path,
    kind: &str,
    path: &str,
    sha256: &str,
    media_type: &str,
) -> Result<()> {
    if staging_dir.join(path).exists() {
        artifacts.push(staged_artifact(
            staging_dir,
            kind,
            path,
            sha256,
            media_type,
        )?);
    }
    Ok(())
}

fn pack_artifact(
    kind: &str,
    path: &str,
    sha256: String,
    size_bytes: u64,
    required: bool,
    media_type: &str,
) -> PackArtifact {
    PackArtifact {
        kind: kind.to_string(),
        path: path.to_string(),
        sha256,
        size_bytes,
        required,
        media_type: media_type.to_string(),
        cache: "immutable".to_string(),
        bbox: None,
        namespaces: BTreeMap::new(),
        encoding: None,
        derived_from: Vec::new(),
        format_version: None,
    }
}

fn validate_pack_against_dir(
    pack: &PackManifest,
    staging_dir: &Path,
) -> std::result::Result<(), String> {
    let ptb = pack
        .artifacts
        .iter()
        .find(|a| a.kind == "ptb")
        .ok_or_else(|| "missing ptb artifact".to_string())?;
    if ptb.path != "bundle.ptb" {
        return Err(format!("ptb.path must be bundle.ptb, got {}", ptb.path));
    }
    if ptb.sha256 != pack.bundle_id {
        return Err("ptb.sha256 must equal bundleId".to_string());
    }

    let mut paths = BTreeSet::new();
    let mut checked = Vec::with_capacity(pack.artifacts.len());
    for (idx, artifact) in pack.artifacts.iter().enumerate() {
        validate_artifact_path(&artifact.path).map_err(|e| e.to_string())?;
        if !paths.insert(artifact.path.as_str()) {
            return Err(format!("duplicate artifact path: {}", artifact.path));
        }

        let (path, meta) = validate_artifact_file_path(staging_dir, &artifact.path)?;
        checked.push((idx, path, meta.len()));
    }

    let bundle_path = checked
        .iter()
        .find(|(idx, _, _)| pack.artifacts[*idx].kind == "ptb")
        .map(|(_, path, _)| path)
        .ok_or_else(|| "missing ptb artifact".to_string())?;
    let bundle_bytes = std::fs::read(bundle_path)
        .map_err(|e| format!("read bundle.ptb for namespace validation: {e}"))?;
    let (trips_sha, stops_sha) = bundle_namespace_shas(&bundle_bytes)?;

    for (idx, path, size_bytes) in checked {
        let artifact = &pack.artifacts[idx];

        if size_bytes != artifact.size_bytes {
            return Err(format!(
                "artifact {} sizeBytes mismatch: staged={} pack={}",
                artifact.path, size_bytes, artifact.size_bytes
            ));
        }
        let bytes = std::fs::read(&path)
            .map_err(|e| format!("artifact {} read failed: {e}", artifact.path))?;
        let staged_sha = sha256_hex(&bytes);
        if staged_sha != artifact.sha256 {
            return Err(format!(
                "artifact {} SHA mismatch: staged={} pack={}",
                artifact.path, staged_sha, artifact.sha256
            ));
        }

        match artifact.kind.as_str() {
            "departures-idx" => {
                validate_sidecar_namespaces(artifact, &bytes, *b"DPIX", &trips_sha, &stops_sha)?
            }
            "shapes-bin" => {
                validate_sidecar_namespaces(artifact, &bytes, *b"SHPB", &trips_sha, &stops_sha)?
            }
            _ => {}
        }
    }

    Ok(())
}

fn validate_artifact_file_path(
    staging_dir: &Path,
    artifact_path: &str,
) -> std::result::Result<(PathBuf, std::fs::Metadata), String> {
    validate_artifact_path(artifact_path).map_err(|e| e.to_string())?;

    let mut path = staging_dir.to_path_buf();
    let mut segments = artifact_path.split('/').peekable();
    while let Some(segment) = segments.next() {
        path.push(segment);
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("artifact {} missing or unreadable: {e}", artifact_path))?;
        if meta.file_type().is_symlink() {
            return Err(format!(
                "artifact {} path component {} must not be a symlink",
                artifact_path, segment
            ));
        }
        if segments.peek().is_some() {
            if !meta.file_type().is_dir() {
                return Err(format!(
                    "artifact {} path component {} must be a directory",
                    artifact_path, segment
                ));
            }
        } else if !meta.file_type().is_file() {
            return Err(format!("artifact {} must be a regular file", artifact_path));
        } else {
            return Ok((path, meta));
        }
    }

    Err("artifact path unexpectedly empty".to_string())
}

fn validate_pack_metadata(
    pack: &PackManifest,
    manifest: &GenerationManifest,
    outcome: &BuildOutcome,
    city: &str,
) -> std::result::Result<(), String> {
    if pack.generation_id != manifest.generation_id {
        return Err(format!(
            "generationId mismatch: pack={} manifest={}",
            pack.generation_id, manifest.generation_id
        ));
    }
    if pack.publication_inputs_sha256 != manifest.publication_inputs_sha256 {
        return Err("publicationInputsSha256 mismatch".into());
    }
    if pack.bundle_id != manifest.bundle_sha256 {
        return Err(format!(
            "bundleId mismatch: pack={} manifest={}",
            pack.bundle_id, manifest.bundle_sha256
        ));
    }
    if pack.city_slug != city {
        return Err(format!(
            "citySlug mismatch: pack={} city={city}",
            pack.city_slug
        ));
    }
    if pack.created_at != manifest.created_at {
        return Err(format!(
            "createdAt mismatch: pack={} manifest={}",
            pack.created_at, manifest.created_at
        ));
    }
    if pack.feed_start_date != outcome.feed_start_date {
        return Err(format!(
            "feedStartDate mismatch: pack={} outcome={}",
            pack.feed_start_date, outcome.feed_start_date
        ));
    }
    if pack.window_days != outcome.window_days {
        return Err(format!(
            "windowDays mismatch: pack={} outcome={}",
            pack.window_days, outcome.window_days
        ));
    }
    if pack.stop_bbox != outcome.stop_bbox {
        return Err(format!(
            "stopBBox mismatch: pack={:?} outcome={:?}",
            pack.stop_bbox, outcome.stop_bbox
        ));
    }
    if pack.coverage_bbox != outcome.coverage_bbox {
        return Err(format!(
            "coverageBBox mismatch: pack={:?} outcome={:?}",
            pack.coverage_bbox, outcome.coverage_bbox
        ));
    }
    if pack.coverage_incomplete_reasons != outcome.coverage_incomplete_reasons {
        return Err(format!(
            "coverageIncompleteReasons mismatch: pack={:?} outcome={:?}",
            pack.coverage_incomplete_reasons, outcome.coverage_incomplete_reasons
        ));
    }

    let service_end_date =
        add_days_yyyymmdd(outcome.feed_start_date, i64::from(outcome.window_days) - 1);
    let stale_after = add_days_yyyymmdd(service_end_date, -14);
    if pack.service_end_date != service_end_date {
        return Err(format!(
            "serviceEndDate mismatch: pack={} expected={}",
            pack.service_end_date, service_end_date
        ));
    }
    if pack.stale_after != crate::sidecars::format_ymd(stale_after) {
        return Err(format!(
            "staleAfter mismatch: pack={} expected={}",
            pack.stale_after,
            crate::sidecars::format_ymd(stale_after)
        ));
    }
    if pack.hard_expire_after != crate::sidecars::format_ymd(service_end_date) {
        return Err(format!(
            "hardExpireAfter mismatch: pack={} expected={}",
            pack.hard_expire_after,
            crate::sidecars::format_ymd(service_end_date)
        ));
    }
    if pack.rights.redistributable
        || pack.rights.status != "unknown"
        || pack.rights.note != "not cleared for public CDN distribution"
    {
        return Err("rights must retain conservative producer defaults".to_string());
    }

    Ok(())
}

fn sidecar_namespaces(
    staging_dir: &Path,
    path: &str,
    magic: [u8; 4],
) -> Result<BTreeMap<String, String>> {
    let bytes = std::fs::read(staging_dir.join(path))?;
    let hdr = pt_shared::sidecar::parse_sidecar_header(&bytes, magic)
        .map_err(|e| Error::Config(format!("{path} header: {e}")))?;
    let mut namespaces = BTreeMap::new();
    namespaces.insert("trips".to_string(), hex_bytes(&hdr.trips_intern_sha256));
    namespaces.insert("stops".to_string(), hex_bytes(&hdr.stops_intern_sha256));
    Ok(namespaces)
}

fn validate_sidecar_namespaces(
    artifact: &PackArtifact,
    bytes: &[u8],
    magic: [u8; 4],
    trips_sha: &str,
    stops_sha: &str,
) -> std::result::Result<(), String> {
    let declared_trips = artifact
        .namespaces
        .get("trips")
        .ok_or_else(|| format!("{} missing trips namespace", artifact.path))?;
    let declared_stops = artifact
        .namespaces
        .get("stops")
        .ok_or_else(|| format!("{} missing stops namespace", artifact.path))?;
    let hdr = pt_shared::sidecar::parse_sidecar_header(bytes, magic)
        .map_err(|e| format!("{} header invalid: {e}", artifact.path))?;
    let header_trips = hex_bytes(&hdr.trips_intern_sha256);
    let header_stops = hex_bytes(&hdr.stops_intern_sha256);
    if declared_trips != &header_trips || declared_stops != &header_stops {
        return Err(format!(
            "{} namespace declaration/header mismatch",
            artifact.path
        ));
    }
    if declared_trips != trips_sha || declared_stops != stops_sha {
        return Err(format!(
            "{} namespace declaration/PTB mismatch",
            artifact.path
        ));
    }
    Ok(())
}

fn bundle_namespace_shas(bundle_bytes: &[u8]) -> std::result::Result<(String, String), String> {
    let reader = pt_core::Reader::from_bytes(bundle_bytes.to_vec())
        .map_err(|e| format!("bundle.ptb reader: {e:?}"))?;

    let mut stop_keys: Vec<&str> = Vec::with_capacity(reader.num_stops());
    for i in 0..reader.num_stops() {
        stop_keys.push(
            reader
                .stop_id(i)
                .map_err(|_| "interner recompute: stop_id out of range".to_string())?,
        );
    }
    let stops_sha = hex_bytes(&pt_shared::sidecar::intern_namespace_sha256(&stop_keys));

    let mut trip_keys: Vec<String> = Vec::with_capacity(reader.num_trips());
    for i in 0..reader.num_trips() {
        let t = reader
            .trip(i)
            .map_err(|_| "interner recompute: trip out of range".to_string())?;
        trip_keys.push(t.trip_id);
    }
    let trips_sha = hex_bytes(&pt_shared::sidecar::intern_namespace_sha256(&trip_keys));

    Ok((trips_sha, stops_sha))
}

fn hex_bytes(bytes: &[u8]) -> String {
    const NIBBLE: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(NIBBLE[(b >> 4) as usize] as char);
        out.push(NIBBLE[(b & 0x0f) as usize] as char);
    }
    out
}

fn add_days_yyyymmdd(yyyymmdd: u32, days: i64) -> u32 {
    let jdn = crate::service::bitmask::ymd_to_julian(yyyymmdd) + days;
    let unix_days = jdn - 2_440_588;
    let (year, month, day) = civil_from_days(unix_days);
    (year as u32) * 10_000 + month * 100 + day
}

/// The generation `current.json` references, if its directory is complete
/// on disk (its `generation.json` exists). `None` for a fresh data root or a
/// dangling pointer.
pub fn current_generation_on_disk(data_root: &Path) -> Option<String> {
    let bytes = std::fs::read(data_root.join("current.json")).ok()?;
    let pointer: PointerManifest = serde_json::from_slice(&bytes).ok()?;
    let id = pointer.generation_id;
    let well_formed = id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit());
    (well_formed
        && data_root
            .join("generations")
            .join(&id)
            .join("generation.json")
            .exists())
    .then_some(id)
}

fn activate_pointer(data_root: &Path, pointer: &PointerManifest) -> Result<()> {
    let current = data_root.join("current.json");
    let current_tmp = data_root.join("current.json.tmp");
    {
        let bytes =
            serde_json::to_vec_pretty(pointer).map_err(|e| Error::Io(std::io::Error::other(e)))?;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&current_tmp)?;
        use std::io::Write as _;
        f.write_all(&bytes)?;
        pt_shared::fsync::durable(f.as_fd())?;
    }
    std::fs::rename(&current_tmp, &current)?;
    fsync_dir(data_root)?;
    Ok(())
}

/// Send SIGHUP to whatever PID `data_root/pt-serve.pid` holds.
///
/// Two non-error returns:
/// - pidfile absent → "no pt-serve to signal" (log via caller).
/// - pidfile present but contents unparseable → log + continue (corrupted
///   pidfile is operator-debuggable; not blocking publish).
///
/// A genuine kill(2) failure (ESRCH = no such process; EPERM = wrong owner)
/// returns Err. Both are non-fatal at the call site; the caller logs and
/// continues.
pub(crate) fn send_sighup(data_root: &Path) -> std::io::Result<()> {
    let pidfile = data_root.join("pt-serve.pid");
    let bytes = match std::fs::read(&pidfile) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("[producer] no pt-serve.pid in data root — skipping SIGHUP");
            return Ok(());
        }
        Err(e) => return Err(e),
    };
    let text = std::str::from_utf8(&bytes).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "pt-serve.pid not utf-8")
    })?;
    let pid: i32 = match text.lines().next().and_then(|l| l.trim().parse().ok()) {
        Some(p) => p,
        None => {
            eprintln!("[producer] pt-serve.pid unparseable — skipping SIGHUP");
            return Ok(());
        }
    };

    // libc::kill is portable (Linux + macOS); we already depend on libc.
    // SIGHUP = 1 on every Unix platform pt-serve targets.
    #[cfg(unix)]
    {
        let rc = unsafe { libc::kill(pid as libc::pid_t, libc::SIGHUP) };
        if rc != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    eprintln!("[producer] SIGHUP delivered to pid={pid}");
    Ok(())
}

/// Open the file read-write and call the platform-appropriate durable fsync.
pub(crate) fn fsync_file(path: &Path) -> Result<()> {
    let f = std::fs::OpenOptions::new().write(true).open(path)?;
    pt_shared::fsync::durable(f.as_fd())?;
    Ok(())
}

/// Open the directory and fsync it. Linux: fsync(2) on the open dir fd.
/// macOS: durable_dir degrades to plain fsync — F_FULLFSYNC on a directory
/// fd is unreliable (EBADF/ENOTSUP) and would fail every publish in dev/CI.
pub(crate) fn fsync_dir(path: &Path) -> Result<()> {
    let d = std::fs::File::open(path)?;
    pt_shared::fsync::durable_dir(d.as_fd())?;
    Ok(())
}

/// Format a SystemTime as the strict 20-char RFC 3339 subset the metadata
/// validator parses (`YYYY-MM-DDTHH:MM:SSZ`).
pub(crate) fn format_rfc3339(t: std::time::SystemTime) -> String {
    let secs = t
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

// Re-export so the binary main can resolve canonical paths the same way.
#[allow(dead_code)]
pub(crate) fn data_root_join(data_root: &Path, name: &str) -> PathBuf {
    data_root.join(name)
}

/// Path to the Node color-artifacts-gen script. `PT_COLOR_ARTIFACTS_SCRIPT` overrides for
/// tests/dev; defaults to the path the prod image ships it at (the backend Dockerfile COPYs it
/// there — see).
fn color_artifacts_script_path() -> std::ffi::OsString {
    std::env::var_os("PT_COLOR_ARTIFACTS_SCRIPT")
        .unwrap_or_else(|| "/app/packages/backend/scripts/color-artifacts-gen.mjs".into())
}

/// Path to the Node schedule-tile-gen script (interim spike-killer — builds the
/// per-cell schedule-tile bundle producer-side instead of in the serving
/// backend's resident GTFS index). `PT_SCHEDULE_TILE_SCRIPT` overrides for
/// tests/dev; defaults to the path the prod image ships it at (same convention
/// as `color_artifacts_script_path`).
fn schedule_tile_script_path() -> std::ffi::OsString {
    std::env::var_os("PT_SCHEDULE_TILE_SCRIPT")
        .unwrap_or_else(|| "/app/packages/backend/scripts/schedule-tile-gen.mjs".into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScheduleTileBuilder {
    Rust,
    Node,
}

impl ScheduleTileBuilder {
    fn as_str(self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::Node => "node",
        }
    }
}

/// Parse the schedule-tile builder selector strictly. An unset value defaults
/// to Rust; misspellings, case changes, surrounding whitespace, and non-UTF-8
/// values are configuration errors rather than implicit Node fallbacks.
fn parse_schedule_tile_builder(value: Option<&std::ffi::OsStr>) -> Result<ScheduleTileBuilder> {
    match value {
        None => Ok(ScheduleTileBuilder::Rust),
        Some(value) => match value.to_str() {
            Some("rust") => Ok(ScheduleTileBuilder::Rust),
            Some("node") => Ok(ScheduleTileBuilder::Node),
            Some(other) => Err(Error::Config(format!(
                "invalid PT_TILE_BUILD={other:?}; expected \"rust\" or \"node\""
            ))),
            None => Err(Error::Config(
                "invalid non-UTF-8 PT_TILE_BUILD; expected \"rust\" or \"node\"".into(),
            )),
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ColorArtifactBuilder {
    Rust,
    Node,
}

impl ColorArtifactBuilder {
    fn as_str(self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::Node => "node",
        }
    }
}

/// Parse the color-artifacts builder selector strictly — unset defaults to Node FIRST (lands with
/// node as default, matching schedule-tile's own initial rollout; flips this default to Rust after
/// the differential gate is green, exactly mirroring schedule-tile's progression).
fn parse_color_artifact_builder(value: Option<&std::ffi::OsStr>) -> Result<ColorArtifactBuilder> {
    match value {
        None => Ok(ColorArtifactBuilder::Node),
        Some(value) => match value.to_str() {
            Some("rust") => Ok(ColorArtifactBuilder::Rust),
            Some("node") => Ok(ColorArtifactBuilder::Node),
            Some(other) => Err(Error::Config(format!(
                "invalid PT_COLOR_BUILD={other:?}; expected \"rust\" or \"node\""
            ))),
            None => Err(Error::Config(
                "invalid non-UTF-8 PT_COLOR_BUILD; expected \"rust\" or \"node\"".into(),
            )),
        },
    }
}

/// True for a 64-char lowercase-hex SHA-256 (the producer-build line protocol).
/// Module-level twin of the `is_sha256_hex` nested in `publish_inner`'s
/// color-artifacts parse (kept separate so the parser below is unit-testable).
fn is_sha256_hex_line(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The SHA lines parsed from the schedule-tile-gen (`schedule-tile-gen.mjs`)
/// producer build's stdout. The script prints one `"<name> <sha256> <bytes>"`
/// (the schedule-tile-bundle line additionally carries a trailing `<bundleHash>`)
/// per artifact; `parse_producer_build_output` extracts them with the same
/// `split_whitespace` protocol the schedule-tile-bundle line has always used.
///
/// C4 (B4/B6): `trip_route` / `stop_cell` are the producer-artifact SHAs. They
/// are required IFF the schedule-tile build actually ran
/// (`schedule_tile_bundle_sha256.is_some()`) — see [`Self::validate_required`].
#[derive(Debug, Default)]
struct ProducerBuildOutput {
    /// SHA of `schedule-tiles/manifest.json` (`Some` ⇒ the build ran).
    schedule_tile_bundle_sha256: Option<String>,
    /// The trailing `<bundleHash>` on the schedule-tile-bundle line.
    schedule_tile_bundle_hash: Option<String>,
    /// SHA of `trip-route.json` (B4 producer artifact).
    trip_route_sha256: Option<String>,
    /// SHA of `stop-cell.json` (B6 producer artifact).
    stop_cell_sha256: Option<String>,
}

impl ProducerBuildOutput {
    /// Enforce the conditional-requirement (B-2/B-3): the two C4 artifact SHA
    /// lines are required if and only if the schedule-tile build ran. When the
    /// build was skipped (script absent ⇒ `schedule_tile_bundle_sha256` is
    /// `None`) the artifacts are legitimately absent and this is `Ok`.
    fn validate_required(&self) -> std::result::Result<(), Error> {
        if self.schedule_tile_bundle_sha256.is_some() {
            if self.trip_route_sha256.is_none() {
                return Err(Error::Config(
                    "schedule-tile-gen ran but did not emit a trip-route sha line".into(),
                ));
            }
            if self.stop_cell_sha256.is_none() {
                return Err(Error::Config(
                    "schedule-tile-gen ran but did not emit a stop-cell sha line".into(),
                ));
            }
        }
        Ok(())
    }
}

/// Parse the schedule-tile-gen producer build's stdout into a
/// [`ProducerBuildOutput`]. Unknown / malformed lines are ignored (forward
/// compatible). The schedule-tile-bundle line keeps its trailing `<bundleHash>`
/// 4th token; `trip-route` / `stop-cell` are the 3-token `"<name> <sha> <bytes>"`
/// form.
fn parse_producer_build_output(stdout: &str) -> ProducerBuildOutput {
    let mut out = ProducerBuildOutput::default();
    for line in stdout.lines() {
        let mut it = line.split_whitespace();
        match (it.next(), it.next(), it.next(), it.next()) {
            // "schedule-tile-bundle <sha256> <bytes> <bundleHash>"
            (Some("schedule-tile-bundle"), Some(sha), Some(_bytes), Some(hash))
                if is_sha256_hex_line(sha) =>
            {
                out.schedule_tile_bundle_sha256 = Some(sha.to_string());
                out.schedule_tile_bundle_hash = Some(hash.to_string());
            }
            // "trip-route <sha256> <bytes>"
            (Some("trip-route"), Some(sha), Some(_bytes), None) if is_sha256_hex_line(sha) => {
                out.trip_route_sha256 = Some(sha.to_string());
            }
            // "stop-cell <sha256> <bytes>"
            (Some("stop-cell"), Some(sha), Some(_bytes), None) if is_sha256_hex_line(sha) => {
                out.stop_cell_sha256 = Some(sha.to_string());
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sentinel::PT_SERVE_VERSION_FILENAME;
    use std::sync::atomic::AtomicBool;

    /// Env var name that overrides the absent-retry attempt count (prod
    /// default 12). Tests that depend on the absent path serialize on
    /// [`ABSENT_RETRY_SERIAL`] and set this to 0 so the FINAL absent verdict
    /// is reached without the ~60 s wall-clock retry wait.
    const ABSENT_RETRY_ATTEMPTS_ENV: &str = "PT_SERVE_VERSION_ABSENT_RETRY_ATTEMPTS";

    /// Serializes tests that read the process-global
    /// `PT_SERVE_VERSION_ABSENT_RETRY_ATTEMPTS` env var (the absent-path
    /// tests). Without this, a parallel test setting/clearing the var could
    /// flip another test's absent-retry behaviour mid-run.
    static ABSENT_RETRY_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Serializes tests that reach Step 3g and therefore read the process-
    /// global `PT_TILE_BUILD` env var. Only tests that actually publish a
    /// full generation (fixture_zip() feed) get this far; without the lock, a
    /// test setting `PT_TILE_BUILD=node` running concurrently with a
    /// `PT_TILE_BUILD=rust` (or default-rust) publish test could flip the
    /// OTHER test's branch mid-run (env vars are process-global, tests run on
    /// threads in one process) — same hazard [`ABSENT_RETRY_SERIAL`] guards
    /// above.
    static TILE_BUILD_ENV_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn publication_inputs_survive_an_unidentified_producer_binary() {
        // Same shared stub path as the publish-driving tests below.
        std::env::set_var(
            "PT_COLOR_ARTIFACTS_SCRIPT",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/color-artifacts-stub.mjs"
            ),
        );
        let unidentified = publication_inputs(None, None, None)
            .expect("an unreadable executable must not stop publishing");
        let identified =
            publication_inputs(Some(&"a".repeat(64)), None, None).expect("identified code hashes");
        assert_ne!(unidentified, identified);
        assert!(pt_shared::osm_manifest::valid_digest(&unidentified));
    }

    #[test]
    fn current_v1_requires_an_exact_advertised_reader() {
        assert!(pt_serve_supports_current_version(pt_core::PTB_VERSION));
        for unsupported in 0..=9 {
            if unsupported == pt_core::PTB_VERSION {
                continue;
            }
            assert!(
                !pt_serve_supports_current_version(unsupported),
                "sentinel v{unsupported} must not authorize current PTB v1"
            );
        }
    }

    /// Unsets the named env var on scope exit, even on panic — used by the
    /// [`TILE_BUILD_ENV_SERIAL`]-guarded tests so a leaked `PT_TILE_BUILD`
    /// override can't silently flip a later test's branch.
    struct EnvUnset(&'static str);
    impl Drop for EnvUnset {
        fn drop(&mut self) {
            std::env::remove_var(self.0);
        }
    }

    /// A non-v1 `pt-serve.version` sentinel produces
    /// `PublishOutcome::Paused { reason: PtServeVersionMismatch }` and NOT
    /// the operator-paused variant — callers route these to separate counters.
    #[test]
    fn version_gate_non_v1_gives_version_mismatch_reason() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join(PT_SERVE_VERSION_FILENAME), "1\n").unwrap();
        // Tests run in parallel in one process; every publish-driving test sets this env to
        // the SAME stub path, so the writes are idempotent and race-free. A future test that
        // needs a DIFFERENT stub (e.g. failure injection) must serialize (e.g. a Mutex / #[serial]).
        std::env::set_var(
            "PT_COLOR_ARTIFACTS_SCRIPT",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/color-artifacts-stub.mjs"
            ),
        );
        let clock = pt_shared::clock::MockClock::new(std::time::SystemTime::UNIX_EPOCH);
        let outcome = publish_inner(
            dir.path(),
            "test",
            vec![],
            None,
            None,
            None,
            10,
            None,
            Some("Europe/Vilnius"),
            crate::cli::DeriveInseat::Auto,
            None,
            None, // no stop flag
            &clock,
        )
        .expect("publish_inner should return Ok");
        assert!(
            matches!(
                outcome,
                PublishOutcome::Paused {
                    reason: PausedReason::PtServeVersionMismatch
                }
            ),
            "expected PtServeVersionMismatch, got {outcome:?}"
        );
    }

    /// A sentinel matching the producer's PTB version permits the publish to
    /// advance beyond the gate.
    #[test]
    fn version_gate_matching_permits_publish() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(
            dir.path().join(PT_SERVE_VERSION_FILENAME),
            format!("{}\n", pt_core::PTB_VERSION),
        )
        .unwrap();
        std::env::set_var(
            "PT_COLOR_ARTIFACTS_SCRIPT",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/color-artifacts-stub.mjs"
            ),
        );
        let clock = pt_shared::clock::MockClock::new(std::time::SystemTime::UNIX_EPOCH);
        let outcome = publish_inner(
            dir.path(),
            "test",
            vec![], // no feed → the build fails AFTER the gate; we only assert the gate verdict
            None,
            None,
            None,
            10,
            None,
            Some("Europe/Vilnius"),
            crate::cli::DeriveInseat::Auto,
            None,
            None, // no stop flag
            &clock,
        );
        // The gate must NOT short-circuit with a version mismatch. The empty
        // feed makes the post-gate build Err (or otherwise not-paused-on-version),
        // which is fine — we are asserting the gate verdict, not a full publish.
        match outcome {
            Ok(PublishOutcome::Paused {
                reason: PausedReason::PtServeVersionMismatch,
            }) => panic!("matching PTB capability must pass the version gate"),
            _ => { /* permitted past the gate (Ok(other) or Err) */ }
        }
    }

    /// An absent `pt-serve.version` sentinel fails closed, so the producer never
    /// publishes where no v1-capable pt-serve has advertised read capability. Uses
    /// `PT_SERVE_VERSION_ABSENT_RETRY_ATTEMPTS=0` to reach the final verdict
    /// instantly; serialized on `ABSENT_RETRY_SERIAL`.
    #[test]
    fn version_gate_absent_fails_closed() {
        let _serial = ABSENT_RETRY_SERIAL
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        std::env::set_var(ABSENT_RETRY_ATTEMPTS_ENV, "0");
        let dir = tempfile::TempDir::new().unwrap();
        // No pt-serve.version file → Absent.
        assert!(!dir.path().join(PT_SERVE_VERSION_FILENAME).exists());
        std::env::set_var(
            "PT_COLOR_ARTIFACTS_SCRIPT",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/color-artifacts-stub.mjs"
            ),
        );
        let clock = pt_shared::clock::MockClock::new(std::time::SystemTime::UNIX_EPOCH);
        let outcome = publish_inner(
            dir.path(),
            "test",
            vec![],
            None,
            None,
            None,
            10,
            None,
            Some("Europe/Vilnius"),
            crate::cli::DeriveInseat::Auto,
            None,
            None,
            &clock,
        );
        std::env::remove_var(ABSENT_RETRY_ATTEMPTS_ENV);
        let outcome = outcome.expect("publish_inner should return Ok");
        assert!(
            matches!(
                outcome,
                PublishOutcome::Paused {
                    reason: PausedReason::PtServeVersionMismatch
                }
            ),
            "absent sentinel must Pause with PtServeVersionMismatch, got {outcome:?}"
        );
    }

    /// A malformed `pt-serve.version` sentinel produces
    /// `PublishOutcome::Paused { reason: PtServeVersionMalformed }`.
    #[test]
    fn version_gate_malformed_gives_malformed_reason() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join(PT_SERVE_VERSION_FILENAME), "not-a-number\n").unwrap();
        std::env::set_var(
            "PT_COLOR_ARTIFACTS_SCRIPT",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/color-artifacts-stub.mjs"
            ),
        );
        let clock = pt_shared::clock::MockClock::new(std::time::SystemTime::UNIX_EPOCH);
        let outcome = publish_inner(
            dir.path(),
            "test",
            vec![],
            None,
            None,
            None,
            10,
            None,
            Some("Europe/Vilnius"),
            crate::cli::DeriveInseat::Auto,
            None,
            None,
            &clock,
        )
        .expect("publish_inner should return Ok");
        assert!(
            matches!(
                outcome,
                PublishOutcome::Paused {
                    reason: PausedReason::PtServeVersionMalformed
                }
            ),
            "expected PtServeVersionMalformed, got {outcome:?}"
        );
    }

    /// When the stop flag is set before the absent-retry loop starts, the loop
    /// exits immediately with `Paused { OperatorPaused }` rather than waiting
    /// up to 60 s.
    #[test]
    fn absent_retry_exits_immediately_when_stop_flag_set() {
        // Serialize + force the prod default (>=1 attempt) so a parallel
        // absent-test's `=0` override can't make us skip the retry loop and
        // miss the stop-flag short-circuit we are asserting.
        let _serial = ABSENT_RETRY_SERIAL
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        std::env::remove_var(ABSENT_RETRY_ATTEMPTS_ENV);
        let dir = tempfile::TempDir::new().unwrap();
        // No pt-serve.version file → sentinel is Absent, which would normally
        // trigger the 12-attempt / 5s-per-attempt retry loop.
        let stop = AtomicBool::new(true); // already set
        std::env::set_var(
            "PT_COLOR_ARTIFACTS_SCRIPT",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/color-artifacts-stub.mjs"
            ),
        );
        let clock = pt_shared::clock::MockClock::new(std::time::SystemTime::UNIX_EPOCH);
        let t0 = std::time::Instant::now();
        let outcome = publish_inner(
            dir.path(),
            "test",
            vec![],
            None,
            None,
            None,
            10,
            None,
            Some("Europe/Vilnius"),
            crate::cli::DeriveInseat::Auto,
            None,
            Some(&stop),
            &clock,
        )
        .expect("publish_inner should return Ok");
        // Should complete in well under 1 s (no actual sleep).
        assert!(
            t0.elapsed().as_secs() < 2,
            "stop flag should short-circuit the retry loop (elapsed: {:?})",
            t0.elapsed()
        );
        assert!(
            matches!(
                outcome,
                PublishOutcome::Paused {
                    reason: PausedReason::OperatorPaused
                }
            ),
            "expected OperatorPaused bail-out, got {outcome:?}"
        );
    }

    /// `producer.paused` sentinel → `OperatorPaused` (not a version-gate skip).
    #[test]
    fn operator_paused_sentinel_gives_operator_paused_reason() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("producer.paused"), "").unwrap();
        std::env::set_var(
            "PT_COLOR_ARTIFACTS_SCRIPT",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/color-artifacts-stub.mjs"
            ),
        );
        let clock = pt_shared::clock::MockClock::new(std::time::SystemTime::UNIX_EPOCH);
        let outcome = publish_inner(
            dir.path(),
            "test",
            vec![],
            None,
            None,
            None,
            10,
            None,
            Some("Europe/Vilnius"),
            crate::cli::DeriveInseat::Auto,
            None,
            None,
            &clock,
        )
        .expect("publish_inner should return Ok");
        assert!(
            matches!(
                outcome,
                PublishOutcome::Paused {
                    reason: PausedReason::OperatorPaused
                }
            ),
            "expected OperatorPaused, got {outcome:?}"
        );
    }

    fn fixture_zip() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tiny-gtfs.zip")
    }

    struct PackManifestMutatorGuard;

    impl PackManifestMutatorGuard {
        fn install(mutate: fn(&Path)) -> Self {
            PACK_MANIFEST_TEST_MUTATOR.with(|m| m.set(Some(mutate)));
            Self
        }
    }

    impl Drop for PackManifestMutatorGuard {
        fn drop(&mut self) {
            PACK_MANIFEST_TEST_MUTATOR.with(|m| m.set(None));
        }
    }

    /// The pack-manifest test mutator must be thread-confined: a mutator
    /// installed by one test must never fire inside another test's publish
    /// running on a different libtest thread. (A process-global mutator did
    /// exactly that — the sidecar publish tests failed flakily with the
    /// mutation tests' sizeBytes/citySlug corruptions.)
    #[test]
    fn pack_manifest_test_mutator_does_not_leak_across_threads() {
        static FIRED: AtomicBool = AtomicBool::new(false);
        fn mark(_: &Path) {
            FIRED.store(true, Ordering::SeqCst);
        }
        let (installed_tx, installed_rx) = std::sync::mpsc::channel::<()>();
        let (checked_tx, checked_rx) = std::sync::mpsc::channel::<()>();
        let installer = std::thread::spawn(move || {
            let _guard = PackManifestMutatorGuard::install(mark);
            installed_tx.send(()).unwrap();
            // Hold the mutator installed until the main thread has checked it.
            checked_rx.recv().unwrap();
        });
        installed_rx.recv().unwrap();
        maybe_mutate_pack_manifest_for_test(Path::new("/nonexistent"));
        assert!(
            !FIRED.load(Ordering::SeqCst),
            "mutator installed on another thread must not fire here"
        );
        checked_tx.send(()).unwrap();
        installer.join().unwrap();

        // Positive path: on the installing thread itself it does fire.
        let _guard = PackManifestMutatorGuard::install(mark);
        maybe_mutate_pack_manifest_for_test(Path::new("/nonexistent"));
        assert!(FIRED.load(Ordering::SeqCst));
    }

    fn run_pack_manifest_publish_with_mutation(mutate: fn(&Path)) -> Result<PublishOutcome> {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(
            dir.path().join(PT_SERVE_VERSION_FILENAME),
            format!("{}\n", pt_core::PTB_VERSION),
        )
        .unwrap();
        let feed = crate::download::record_for_local(&fixture_zip()).unwrap();
        std::env::set_var(
            "PT_COLOR_ARTIFACTS_SCRIPT",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/color-artifacts-stub.mjs"
            ),
        );
        std::env::set_var(
            "PT_SCHEDULE_TILE_SCRIPT",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/schedule-tile-stub.mjs"
            ),
        );
        let clock = pt_shared::clock::MockClock::new(std::time::SystemTime::UNIX_EPOCH);
        let _mutator = PackManifestMutatorGuard::install(mutate);
        let outcome = publish_inner(
            dir.path(),
            "test",
            vec![feed],
            Some(20260501),
            None,
            None,
            10,
            None,
            Some("Europe/Vilnius"),
            crate::cli::DeriveInseat::Auto,
            None,
            None,
            &clock,
        );
        assert!(!dir.path().join("current.json").exists());
        outcome
    }

    fn write_pack_with_recomputed_id(
        path: &Path,
        mut pack: pt_shared::pack_manifest::PackManifest,
    ) {
        pack.pack_id = pack.compute_pack_id().unwrap();
        std::fs::write(path, serde_json::to_vec_pretty(&pack).unwrap()).unwrap();
    }

    fn mutate_pack_id_drift_without_rehash(staging_dir: &Path) {
        let path = staging_dir.join("pack.json");
        let mut pack: pt_shared::pack_manifest::PackManifest =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        pack.city_slug = "pack-id-drift".into();
        std::fs::write(path, serde_json::to_vec_pretty(&pack).unwrap()).unwrap();
    }

    fn mutate_pack_declares_wrong_size(staging_dir: &Path) {
        let path = staging_dir.join("pack.json");
        let mut pack: pt_shared::pack_manifest::PackManifest =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        pack.artifacts[0].size_bytes += 1;
        write_pack_with_recomputed_id(&path, pack);
    }

    fn mutate_pack_declares_safe_missing_artifact(staging_dir: &Path) {
        let path = staging_dir.join("pack.json");
        let mut pack: pt_shared::pack_manifest::PackManifest =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let mut artifact = pack.artifacts[0].clone();
        artifact.kind = "bad".into();
        artifact.path = "missing.bin".into();
        artifact.required = false;
        artifact.sha256 = "b".repeat(64);
        pack.artifacts.push(artifact);
        write_pack_with_recomputed_id(&path, pack);
    }

    fn mutate_pack_declares_wrong_artifact_sha(staging_dir: &Path) {
        let path = staging_dir.join("pack.json");
        let mut pack: pt_shared::pack_manifest::PackManifest =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let artifact = pack
            .artifacts
            .iter_mut()
            .find(|a| a.kind == "color-config")
            .expect("fixture pack includes color-config artifact");
        artifact.sha256 = if artifact.sha256 == "b".repeat(64) {
            "c".repeat(64)
        } else {
            "b".repeat(64)
        };
        write_pack_with_recomputed_id(&path, pack);
    }

    fn mutate_pack_declares_wrong_city(staging_dir: &Path) {
        let path = staging_dir.join("pack.json");
        let mut pack: pt_shared::pack_manifest::PackManifest =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        pack.city_slug = "other-city".into();
        write_pack_with_recomputed_id(&path, pack);
    }

    fn mutate_pack_declares_wrong_stop_bbox(staging_dir: &Path) {
        let path = staging_dir.join("pack.json");
        let mut pack: pt_shared::pack_manifest::PackManifest =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        pack.stop_bbox.0[0] += 100; // 0.001° bump, in E5 units
        write_pack_with_recomputed_id(&path, pack);
    }

    #[cfg(unix)]
    fn mutate_pack_uses_nested_symlink(staging_dir: &Path) {
        let real_dir = staging_dir.join("schedule-tiles");
        let real_manifest = real_dir.join("manifest.json");
        let manifest_bytes = std::fs::read(&real_manifest).unwrap();
        std::fs::remove_dir_all(&real_dir).unwrap();

        let outside_dir = staging_dir
            .parent()
            .unwrap()
            .join("pack-manifest-symlink-target");
        std::fs::create_dir_all(&outside_dir).unwrap();
        std::fs::write(outside_dir.join("manifest.json"), manifest_bytes).unwrap();
        std::os::unix::fs::symlink(&outside_dir, &real_dir).unwrap();
    }

    #[test]
    fn pack_manifest_validation_aborts_publish_on_pack_id_drift() {
        let err = run_pack_manifest_publish_with_mutation(mutate_pack_id_drift_without_rehash)
            .expect_err("packId drift must abort publish");
        let msg = format!("{err:?}");
        assert!(
            msg.contains("packId mismatch") || msg.contains("pack.json packId invalid"),
            "unexpected error: {msg}"
        );
    }

    #[test]
    fn pack_manifest_validation_aborts_publish_on_wrong_size_bytes() {
        let err = run_pack_manifest_publish_with_mutation(mutate_pack_declares_wrong_size)
            .expect_err("wrong pack artifact size must abort publish");
        let msg = format!("{err:?}");
        assert!(
            msg.contains("pack.json artifact validation failed")
                && msg.contains("sizeBytes mismatch"),
            "unexpected error: {msg}"
        );
    }

    #[test]
    fn pack_manifest_validation_aborts_publish_on_missing_artifact() {
        let err =
            run_pack_manifest_publish_with_mutation(mutate_pack_declares_safe_missing_artifact)
                .expect_err("missing pack artifact must abort publish");
        let msg = format!("{err:?}");
        assert!(
            msg.contains("pack.json artifact validation failed")
                && msg.contains("missing.bin missing or unreadable"),
            "unexpected error: {msg}"
        );
    }

    #[test]
    fn pack_manifest_validation_aborts_publish_on_wrong_artifact_sha() {
        let err = run_pack_manifest_publish_with_mutation(mutate_pack_declares_wrong_artifact_sha)
            .expect_err("wrong pack artifact SHA must abort publish");
        let msg = format!("{err:?}");
        assert!(
            msg.contains("pack.json artifact validation failed") && msg.contains("SHA mismatch"),
            "unexpected error: {msg}"
        );
    }

    #[test]
    fn pack_manifest_validation_aborts_publish_on_metadata_mismatch() {
        let err = run_pack_manifest_publish_with_mutation(mutate_pack_declares_wrong_city)
            .expect_err("wrong pack metadata must abort publish");
        let msg = format!("{err:?}");
        assert!(
            msg.contains("pack.json metadata invalid") && msg.contains("citySlug mismatch"),
            "unexpected error: {msg}"
        );
    }

    #[test]
    fn pack_manifest_validation_aborts_publish_on_bbox_metadata_mismatch() {
        let err = run_pack_manifest_publish_with_mutation(mutate_pack_declares_wrong_stop_bbox)
            .expect_err("wrong pack bbox metadata must abort publish");
        let msg = format!("{err:?}");
        assert!(
            msg.contains("pack.json metadata invalid") && msg.contains("stopBBox mismatch"),
            "unexpected error: {msg}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn pack_manifest_validation_aborts_publish_on_nested_symlink_artifact() {
        let err = run_pack_manifest_publish_with_mutation(mutate_pack_uses_nested_symlink)
            .expect_err("nested symlink artifact path must abort publish");
        let msg = format!("{err:?}");
        assert!(
            msg.contains("pack.json artifact validation failed") && msg.contains("symlink"),
            "unexpected error: {msg}"
        );
    }

    /// Read the published manifest at `generations/<gen-id>/generation.json`,
    /// assert the staged `departures-idx.bin` and `shapes.bin` both exist, that
    /// their on-disk SHAs match `departuresIdxSha256`/`shapesBinSha256`
    /// respectively (each carrying its DPIX/SHPB header), and that
    /// publication identity binds the PTB and effective sidecar inputs.
    fn assert_sidecar_published(data_root: &Path, gen_id: &str) {
        let gen_dir = data_root.join("generations").join(gen_id);
        let dep_path = gen_dir.join("departures-idx.bin");
        assert!(
            dep_path.exists(),
            "departures-idx.bin must be staged into the final generation dir: {dep_path:?}"
        );
        let manifest: GenerationManifest =
            serde_json::from_slice(&std::fs::read(gen_dir.join("generation.json")).unwrap())
                .unwrap();
        let pack_path = gen_dir.join("pack.json");
        assert!(
            pack_path.exists(),
            "pack.json must be written next to generation.json"
        );
        let raw = std::fs::read(&pack_path).unwrap();
        let pack: pt_shared::pack_manifest::PackManifest = serde_json::from_slice(&raw).unwrap();
        assert_eq!(pack.generation_id, manifest.generation_id);
        assert_eq!(
            pack.city_tz_iana.as_deref(),
            Some("Europe/Vilnius"),
            "the v2 publish carries the city zone its origins are built from"
        );
        assert_eq!(pack.bundle_id, manifest.bundle_sha256);
        assert_eq!(pack.service_end_date, 20260814);
        assert_eq!(pack.stale_after, "2026-07-31");
        assert_eq!(pack.hard_expire_after, "2026-08-14");
        assert_bbox_close(
            pack.stop_bbox.0,
            [2_528_000, 5_469_000, 2_529_000, 5_470_000],
        );
        assert_bbox_close(pack.coverage_bbox.0, pack.stop_bbox.0);
        assert!(
            pack.coverage_incomplete_reasons.is_empty(),
            "fixture has no shapes.txt, so coverage is complete for declared geometry"
        );
        // The fixture feed carries no feed_info.txt, so provenance is
        // URL-only: one feeds[] entry with all optional fields absent.
        assert_eq!(pack.feeds.len(), 1);
        assert!(pack.feeds[0].publisher_name.is_none());
        assert_eq!(pack.artifacts.iter().filter(|a| a.kind == "ptb").count(), 1);
        let ptb_artifact = pack.artifacts.iter().find(|a| a.kind == "ptb").unwrap();
        assert_eq!(
            ptb_artifact.format_version,
            Some(pt_core::PTB_VERSION),
            "ptb artifact must carry the current wire-format version"
        );
        for artifact in &pack.artifacts {
            if artifact.kind != "ptb" {
                assert!(
                    artifact.format_version.is_none(),
                    "only the ptb artifact carries formatVersion, got {:?} on {}",
                    artifact.format_version,
                    artifact.kind
                );
            }
        }
        for kind in ["departures-idx", "shapes-bin"] {
            let artifact = pack.artifacts.iter().find(|a| a.kind == kind).unwrap();
            assert!(artifact.namespaces.contains_key("trips"));
            assert!(artifact.namespaces.contains_key("stops"));
        }
        assert!(pack.validate_shape().is_ok());
        assert!(pack.validate_pack_id().is_ok());
        for artifact in &pack.artifacts {
            match artifact.kind.as_str() {
                "shapes-bin" => assert_eq!(artifact.media_type, "application/vnd.ptn.shpb"),
                "departures-idx" => assert_eq!(artifact.media_type, "application/vnd.ptn.dpix"),
                _ => {}
            }
        }
        for artifact in &pack.artifacts {
            let path = gen_dir.join(&artifact.path);
            assert!(path.exists(), "pack artifact path must exist: {path:?}");
            let bytes = std::fs::read(&path).unwrap();
            assert_eq!(
                artifact.size_bytes,
                bytes.len() as u64,
                "pack artifact size for {}",
                artifact.path
            );
            assert_eq!(
                artifact.sha256,
                sha256_hex(&bytes),
                "pack artifact sha for {}",
                artifact.path
            );
        }
        let on_disk_sha = sha256_hex(&std::fs::read(&dep_path).unwrap());
        assert_eq!(
            manifest.departures_idx_sha256.as_deref(),
            Some(on_disk_sha.as_str()),
            "manifest departuresIdxSha256 must equal the on-disk sidecar SHA"
        );
        assert_eq!(
            manifest.generation_id,
            pt_shared::manifest::publication_id(
                &manifest.bundle_sha256,
                &manifest.publication_inputs_sha256
            ),
            "generation_id binds bundle bytes and effective sidecar inputs"
        );
        // The DPIX bytes parse as a sidecar header.
        let header =
            pt_shared::sidecar::parse_sidecar_header(&std::fs::read(&dep_path).unwrap(), *b"DPIX")
                .expect("staged sidecar must carry the DPIX header");
        assert_eq!(header.version, 1);
        // --- shapes.bin (C1c) ---
        let shapes_path = gen_dir.join("shapes.bin");
        assert!(
            shapes_path.exists(),
            "shapes.bin must be staged into the final generation dir: {shapes_path:?}"
        );
        let shapes_on_disk = sha256_hex(&std::fs::read(&shapes_path).unwrap());
        assert_eq!(
            manifest.shapes_bin_sha256.as_deref(),
            Some(shapes_on_disk.as_str()),
            "manifest shapesBinSha256 must equal the on-disk shapes.bin SHA"
        );
        let shapes_header = pt_shared::sidecar::parse_sidecar_header(
            &std::fs::read(&shapes_path).unwrap(),
            *b"SHPB",
        )
        .expect("staged shapes.bin must carry the SHPB header");
        assert_eq!(shapes_header.version, 1);
        // --- color-provenance artifacts (C-color-provenance) ---
        for (name, sha) in [
            ("color-config.json", manifest.color_config_sha256.as_deref()),
            ("route-styles.json", manifest.route_styles_sha256.as_deref()),
            (
                "label-anchors.json",
                manifest.label_anchors_sha256.as_deref(),
            ),
        ] {
            let p = gen_dir.join(name);
            assert!(p.exists(), "{name} must be staged into the gen dir: {p:?}");
            assert_eq!(
                sha,
                Some(sha256_hex(&std::fs::read(&p).unwrap()).as_str()),
                "manifest sha for {name} must equal on-disk"
            );
        }
        assert!(
            manifest.label_anchors_sha256.is_some(),
            "manifest labelAnchorsSha256 must be recorded"
        );
        assert!(
            manifest.shapes_json_sha256.is_some(),
            "shapesJsonSha256 recorded"
        );
        assert!(
            manifest.shapes_json_size_bytes.unwrap_or(0) > 0,
            "shapesJsonSizeBytes > 0"
        );
        // --- schedule-tile producer build (Step 3g) ---
        let tile_manifest = gen_dir.join("schedule-tiles").join("manifest.json");
        assert!(
            tile_manifest.exists(),
            "schedule-tiles/manifest.json must be staged into the gen dir: {tile_manifest:?}"
        );
        assert_eq!(
            manifest.schedule_tile_bundle_sha256.as_deref(),
            Some(sha256_hex(&std::fs::read(&tile_manifest).unwrap()).as_str()),
            "manifest scheduleTileBundleSha256 must equal the on-disk schedule-tiles/manifest.json SHA"
        );
        assert_eq!(
            manifest.schedule_tile_bundle_hash.as_deref(),
            Some(manifest.generation_id.as_str()),
            "scheduleTileBundleHash must equal the generationId (bridge pattern)"
        );
        // --- C4 (B4/B6) producer artifacts (Step 3g) ---
        // Staged into the gen-dir ROOT (not under schedule-tiles/), with their
        // SHAs recorded; required whenever the schedule-tile build ran.
        for (name, sha) in [
            ("trip-route.json", manifest.trip_route_sha256.as_deref()),
            ("stop-cell.json", manifest.stop_cell_sha256.as_deref()),
        ] {
            let p = gen_dir.join(name);
            assert!(p.exists(), "{name} must be staged into the gen dir: {p:?}");
            assert_eq!(
                sha,
                Some(sha256_hex(&std::fs::read(&p).unwrap()).as_str()),
                "manifest sha for {name} must equal on-disk"
            );
        }
        // loadFromPtb bridge sidecars.
        let meta_json = gen_dir.join("bundle.ptb.meta.json");
        let shapes_json = gen_dir.join("bundle.ptb.shapes.json");
        assert!(
            meta_json.exists(),
            "bundle.ptb.meta.json must be published for loadFromPtb"
        );
        assert!(
            shapes_json.exists(),
            "bundle.ptb.shapes.json must be published for loadFromPtb"
        );
        let meta: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&meta_json).unwrap()).unwrap();
        assert_eq!(meta["schemaVersion"], 1, "meta.json schemaVersion 1");
        assert!(
            meta["producerGitSha"].is_string(),
            "meta.json carries producerGitSha"
        );
        assert!(
            meta.get("probeGitSha").is_none(),
            "meta.json omits the old probeGitSha name"
        );
        assert!(meta["feeds"].is_array(), "meta.json carries a feeds array");
        let shapes: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&shapes_json).unwrap()).unwrap();
        assert_eq!(shapes["schemaVersion"], 1, "shapes.json schemaVersion 1");
        assert!(
            shapes["shapes"].is_array(),
            "shapes.json carries a shapes array"
        );
    }

    fn assert_bbox_close(actual: [i32; 4], expected: [i32; 4]) {
        for (actual, expected) in actual.into_iter().zip(expected) {
            // <=1 E5 unit (~1.1 m): quantization may round the compared paths
            // apart by one step; anything larger is a real bbox divergence.
            assert!(
                (actual - expected).abs() <= 1,
                "bbox coord mismatch: actual={actual} expected={expected}"
            );
        }
    }

    /// Periodic-refresh caller (`publish_inner`) stages BOTH sidecars
    /// (`departures-idx.bin` + `shapes.bin`) alongside `bundle.ptb` and records
    /// their SHAs in the manifest, binding generation identity to effective sidecar inputs instead of the old
    /// grammar intact.
    #[test]
    fn publishes_sidecars_periodic_path() {
        // Exercises the node escape hatch (PT_TILE_BUILD default flipped to "rust" — this test pins
        // "node" explicitly so the shell-out path stays covered until deletes it) — serialize
        // against the rust-path test below.
        let _serial = TILE_BUILD_ENV_SERIAL
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        std::env::set_var("PT_TILE_BUILD", "node");
        let _unset_tile_build = EnvUnset("PT_TILE_BUILD");
        let dir = tempfile::TempDir::new().unwrap();
        // Permit the version gate (sentinel reports the current PTB version).
        std::fs::write(
            dir.path().join(PT_SERVE_VERSION_FILENAME),
            format!("{}\n", pt_core::PTB_VERSION),
        )
        .unwrap();
        let feed = crate::download::record_for_local(&fixture_zip()).unwrap();
        std::env::set_var(
            "PT_COLOR_ARTIFACTS_SCRIPT",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/color-artifacts-stub.mjs"
            ),
        );
        std::env::set_var(
            "PT_SCHEDULE_TILE_SCRIPT",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/schedule-tile-stub.mjs"
            ),
        );
        let clock = pt_shared::clock::MockClock::new(std::time::SystemTime::UNIX_EPOCH);
        let outcome = publish_inner(
            dir.path(),
            "test",
            vec![feed],
            Some(20260501), // matches tiny-gtfs calendar.txt min start_date
            None,
            None,
            10,
            None,
            Some("Europe/Vilnius"),
            crate::cli::DeriveInseat::Auto,
            None,
            None,
            &clock,
        )
        .expect("publish_inner should return Ok");
        let gen_id = match outcome {
            PublishOutcome::Published { generation_id, .. } => generation_id,
            other => panic!("expected Published, got {other:?}"),
        };
        assert_sidecar_published(dir.path(), &gen_id);
    }

    /// Republish caller (`republish::run_republish`) shares `publish_inner`, so
    /// it must stage both sidecars identically — confirming both callers are
    /// consistent.
    #[test]
    fn publishes_sidecars_republish_path() {
        // Exercises the node escape hatch (PT_TILE_BUILD default flipped to "rust" — this test pins
        // "node" explicitly so the shell-out path stays covered until deletes it) — serialize
        // against the rust-path test below.
        let _serial = TILE_BUILD_ENV_SERIAL
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        std::env::set_var("PT_TILE_BUILD", "node");
        let _unset_tile_build = EnvUnset("PT_TILE_BUILD");
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(
            dir.path().join(PT_SERVE_VERSION_FILENAME),
            format!("{}\n", pt_core::PTB_VERSION),
        )
        .unwrap();
        std::env::set_var(
            "PT_COLOR_ARTIFACTS_SCRIPT",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/color-artifacts-stub.mjs"
            ),
        );
        std::env::set_var(
            "PT_SCHEDULE_TILE_SCRIPT",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/schedule-tile-stub.mjs"
            ),
        );
        let clock = pt_shared::clock::MockClock::new(std::time::SystemTime::UNIX_EPOCH);
        let outcome = crate::republish::run_republish(
            dir.path(),
            "test",
            &fixture_zip(),
            None,
            Some(20260501),
            None,
            None,
            10,
            None,
            Some("Europe/Vilnius"),
            crate::cli::DeriveInseat::Auto,
            &clock,
        )
        .expect("run_republish should return Ok");
        let gen_id = match outcome {
            PublishOutcome::Published { generation_id, .. } => generation_id,
            other => panic!("expected Published, got {other:?}"),
        };
        assert_sidecar_published(dir.path(), &gen_id);
    }

    /// `PT_TILE_BUILD=rust` runs the in-process port
    /// (`schedule_tiles::build_schedule_tiles`) instead of shelling out to
    /// `schedule-tile-gen.mjs`, but must stage IDENTICAL artifacts + populate
    /// the SAME `generation.json` fields as the node path — `assert_sidecar_
    /// published` (shared with the node-path tests above) checks
    /// `schedule-tiles/manifest.json`, `trip-route.json`, `stop-cell.json`
    /// existence and their recorded SHAs. "rust" is now the process default
    /// (Step 3g falls back to it when `PT_TILE_BUILD` is unset), but this test
    /// keeps setting it explicitly so it still exercises the rust path
    /// unambiguously if the default ever changes.
    #[test]
    fn publishes_schedule_tiles_rust_path() {
        // Reaches Step 3g and sets PT_TILE_BUILD=rust — serialize against the
        // node-path tests above (env vars are process-global).
        let _serial = TILE_BUILD_ENV_SERIAL
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(
            dir.path().join(PT_SERVE_VERSION_FILENAME),
            format!("{}\n", pt_core::PTB_VERSION),
        )
        .unwrap();
        let feed = crate::download::record_for_local(&fixture_zip()).unwrap();
        std::env::set_var(
            "PT_COLOR_ARTIFACTS_SCRIPT",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/color-artifacts-stub.mjs"
            ),
        );
        std::env::set_var("PT_TILE_BUILD", "rust");
        // Unset on scope exit even if publish_inner panics — a leaked
        // PT_TILE_BUILD=rust would silently flip the node-path tests.
        let _unset = EnvUnset("PT_TILE_BUILD");
        let clock = pt_shared::clock::MockClock::new(std::time::SystemTime::UNIX_EPOCH);
        let outcome = publish_inner(
            dir.path(),
            "test",
            vec![feed],
            Some(20260501), // matches tiny-gtfs calendar.txt min start_date
            None,
            None,
            10,
            None,
            Some("Europe/Vilnius"),
            crate::cli::DeriveInseat::Auto,
            None,
            None,
            &clock,
        );
        let outcome = outcome.expect("publish_inner should return Ok");
        let gen_id = match outcome {
            PublishOutcome::Published { generation_id, .. } => generation_id,
            other => panic!("expected Published, got {other:?}"),
        };
        assert_sidecar_published(dir.path(), &gen_id);
    }

    #[test]
    fn osm_only_walking_change_rebuilds_transfers_with_identical_ptb() {
        let _serial = TILE_BUILD_ENV_SERIAL
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(
            dir.path().join(PT_SERVE_VERSION_FILENAME),
            format!("{}\n", pt_core::PTB_VERSION),
        )
        .unwrap();
        std::env::set_var(
            "PT_COLOR_ARTIFACTS_SCRIPT",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/color-artifacts-stub.mjs"
            ),
        );
        let feed = crate::download::record_for_local(&fixture_zip()).unwrap();
        let graph = dir.path().join("walking.geojsonseq");
        let clock = pt_shared::clock::MockClock::new(std::time::SystemTime::UNIX_EPOCH);
        let tick = || match publish_inner(
            dir.path(),
            "test",
            vec![feed.clone()],
            Some(20260501),
            Some(TransfersSource::WalkingGraph(&graph)),
            None,
            10,
            None,
            Some("Europe/Vilnius"),
            crate::cli::DeriveInseat::Auto,
            None,
            None,
            &clock,
        )
        .unwrap()
        {
            PublishOutcome::Published { generation_id, .. } => generation_id,
            other => panic!("expected publication, got {other:?}"),
        };
        std::fs::write(&graph, r#"{"type":"Feature","geometry":{"type":"LineString","coordinates":[[25.28,54.69],[25.285,54.695],[25.29,54.70]]}}"#).unwrap();
        let first = dir.path().join("generations").join(tick());
        let ptb = std::fs::read(first.join("bundle.ptb")).unwrap();
        let transfers = std::fs::read(first.join("transfers.bin")).unwrap();
        std::fs::write(&graph, r#"{"type":"Feature","geometry":{"type":"LineString","coordinates":[[25.28,54.69],[25.30,54.69],[25.285,54.695],[25.29,54.70]]}}"#).unwrap();
        let second = dir.path().join("generations").join(tick());
        assert_ne!(first, second);
        assert_eq!(std::fs::read(second.join("bundle.ptb")).unwrap(), ptb);
        assert_ne!(
            std::fs::read(second.join("transfers.bin")).unwrap(),
            transfers
        );
        assert_eq!(
            std::fs::read(first.join("transfers.bin")).unwrap(),
            transfers
        );
    }

    #[test]
    fn osm_only_address_change_publishes_without_changing_ptb() {
        let _serial = TILE_BUILD_ENV_SERIAL
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(
            dir.path().join(PT_SERVE_VERSION_FILENAME),
            format!("{}\n", pt_core::PTB_VERSION),
        )
        .unwrap();
        std::env::set_var(
            "PT_COLOR_ARTIFACTS_SCRIPT",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/color-artifacts-stub.mjs"
            ),
        );
        let feed = crate::download::record_for_local(&fixture_zip()).unwrap();
        let address = dir.path().join("input.fst");
        let pack = |label: &str| {
            pt_geocode::AddrIndex::pack(
                &[pt_geocode::AddrRow {
                    label: label.into(),
                    lat: 54.0,
                    lon: 25.0,
                }],
                &[pt_geocode::AddrKey {
                    key: "street".into(),
                    row_id: 0,
                }],
                &pt_geocode::ArtifactMeta {
                    city_id: Some("test".into()),
                    source: Some("fixture".into()),
                    generated_at: "2026-10-29T00:00:00Z".into(),
                },
            )
            .unwrap()
        };
        let clock = pt_shared::clock::MockClock::new(std::time::SystemTime::UNIX_EPOCH);
        let tick = || {
            publish_inner(
                dir.path(),
                "test",
                vec![feed.clone()],
                Some(20260501),
                None,
                Some(&address),
                10,
                None,
                Some("Europe/Vilnius"),
                crate::cli::DeriveInseat::Auto,
                None,
                None,
                &clock,
            )
            .unwrap()
        };
        let published = |outcome| match outcome {
            PublishOutcome::Published { generation_id, .. } => generation_id,
            other => panic!("expected publication, got {other:?}"),
        };
        std::fs::write(&address, pack("Old address")).unwrap();
        let first = published(tick());
        let first_dir = dir.path().join("generations").join(&first);
        let transit_pack: PackManifest =
            serde_json::from_slice(&std::fs::read(first_dir.join("pack.json")).unwrap()).unwrap();
        assert!(transit_pack
            .artifacts
            .iter()
            .all(|artifact| artifact.kind != "address-search"));
        let original = std::fs::read(first_dir.join("address-search.fst")).unwrap();
        let bundle = std::fs::read(first_dir.join("bundle.ptb")).unwrap();
        std::fs::write(&address, pack("New address")).unwrap();
        let second = published(tick());
        assert_ne!(first, second);
        let second_dir = dir.path().join("generations").join(&second);
        assert_eq!(
            std::fs::read(second_dir.join("bundle.ptb")).unwrap(),
            bundle
        );
        assert_ne!(
            std::fs::read(second_dir.join("address-search.fst")).unwrap(),
            original
        );
        assert_eq!(
            std::fs::read(first_dir.join("address-search.fst")).unwrap(),
            original
        );
        assert!(
            matches!(tick(), PublishOutcome::Noop { generation_id } if generation_id == second)
        );
        let manifest: GenerationManifest =
            serde_json::from_slice(&std::fs::read(second_dir.join("generation.json")).unwrap())
                .unwrap();
        std::fs::write(&address, &original).unwrap();
        assert_eq!(published(tick()), first);
        assert_eq!(
            current_generation_on_disk(dir.path()).as_deref(),
            Some(first.as_str())
        );
        assert_eq!(
            std::fs::read(first_dir.join("address-search.fst")).unwrap(),
            original
        );
        assert_eq!(manifest.bundle_sha256, sha256_hex(&bundle));
        assert_eq!(
            manifest.generation_id,
            pt_shared::manifest::publication_id(
                &manifest.bundle_sha256,
                &manifest.publication_inputs_sha256
            )
        );
    }

    /// A tick whose inputs match the last build's returns `Noop` without
    /// building; any changed input builds again. The skipped ticks are fed a
    /// zip path that does not exist (with the real zip's sha): a tick that
    /// tried to build would fail to extract it.
    #[test]
    fn unchanged_inputs_skip_the_build() {
        let _serial = TILE_BUILD_ENV_SERIAL
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(
            dir.path().join(PT_SERVE_VERSION_FILENAME),
            format!("{}\n", pt_core::PTB_VERSION),
        )
        .unwrap();
        std::env::set_var(
            "PT_COLOR_ARTIFACTS_SCRIPT",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/color-artifacts-stub.mjs"
            ),
        );
        let feed = crate::download::record_for_local(&fixture_zip()).unwrap();
        let missing_zip = crate::download::FeedRecord {
            zip_path: dir.path().join("gone.zip"),
            ..feed.clone()
        };
        let clock = pt_shared::clock::MockClock::new(std::time::SystemTime::UNIX_EPOCH);
        let tick = |feed: &crate::download::FeedRecord, anchor: u32| {
            publish_inner(
                dir.path(),
                "test",
                vec![feed.clone()],
                Some(anchor),
                None,
                None,
                10,
                None,
                Some("Europe/Vilnius"),
                crate::cli::DeriveInseat::Auto,
                None,
                None,
                &clock,
            )
        };
        let record = dir.path().join(crate::build_inputs::RECORD_FILENAME);

        let gen_id = match tick(&feed, 20260501).expect("first publish") {
            PublishOutcome::Published { generation_id, .. } => generation_id,
            other => panic!("expected Published, got {other:?}"),
        };
        assert!(record.exists(), "a publish records its inputs");

        match tick(&missing_zip, 20260501).expect("unchanged inputs") {
            PublishOutcome::Noop { generation_id } => assert_eq!(generation_id, gen_id),
            other => panic!("expected Noop, got {other:?}"),
        }

        // Without the record, the tick builds and lands on the existing
        // generation (the post-build Noop), which records the inputs again.
        std::fs::remove_file(&record).unwrap();
        match tick(&feed, 20260501).expect("rebuild of the same inputs") {
            PublishOutcome::Noop { generation_id } => assert_eq!(generation_id, gen_id),
            other => panic!("expected Noop, got {other:?}"),
        }
        assert!(record.exists(), "the post-build Noop records its inputs");
        assert!(matches!(
            tick(&missing_zip, 20260501),
            Ok(PublishOutcome::Noop { .. })
        ));

        // A new day is a new anchor: the tick must build, which this zip
        // path cannot.
        assert!(
            tick(&missing_zip, 20260502).is_err(),
            "a changed anchor must not reuse the recorded generation"
        );
    }

    #[test]
    fn add_days_yyyymmdd_crosses_month_year_and_leap_boundaries() {
        assert_eq!(add_days_yyyymmdd(20260131, 1), 20260201);
        assert_eq!(add_days_yyyymmdd(20261231, 1), 20270101);
        assert_eq!(add_days_yyyymmdd(20240228, 1), 20240229);
        assert_eq!(add_days_yyyymmdd(20240301, -1), 20240229);
    }

    #[test]
    fn schedule_tile_builder_defaults_to_rust_and_accepts_only_documented_values() {
        use std::ffi::OsStr;

        assert_eq!(
            parse_schedule_tile_builder(None).unwrap(),
            ScheduleTileBuilder::Rust
        );
        assert_eq!(
            parse_schedule_tile_builder(Some(OsStr::new("rust"))).unwrap(),
            ScheduleTileBuilder::Rust
        );
        assert_eq!(
            parse_schedule_tile_builder(Some(OsStr::new("node"))).unwrap(),
            ScheduleTileBuilder::Node
        );

        for invalid in ["ruts", "Rust", " node", "node ", ""] {
            let err = parse_schedule_tile_builder(Some(OsStr::new(invalid))).unwrap_err();
            assert!(
                err.to_string().contains("invalid PT_TILE_BUILD"),
                "unexpected error for {invalid:?}: {err}"
            );
        }
    }

    #[test]
    fn color_artifact_builder_defaults_to_node_and_accepts_only_documented_values() {
        use std::ffi::OsStr;

        assert_eq!(
            parse_color_artifact_builder(None).unwrap(),
            ColorArtifactBuilder::Node
        );
        assert_eq!(
            parse_color_artifact_builder(Some(OsStr::new("rust"))).unwrap(),
            ColorArtifactBuilder::Rust
        );
        assert_eq!(
            parse_color_artifact_builder(Some(OsStr::new("node"))).unwrap(),
            ColorArtifactBuilder::Node
        );

        for invalid in ["ruts", "Rust", " node", "node ", ""] {
            let err = parse_color_artifact_builder(Some(OsStr::new(invalid))).unwrap_err();
            assert!(
                err.to_string().contains("invalid PT_COLOR_BUILD"),
                "unexpected error for {invalid:?}: {err}"
            );
        }
    }

    /// The producer build's stdout carries `trip-route`/`stop-cell` SHA lines
    /// (the C4 B4/B6 artifacts) alongside the existing `schedule-tile-bundle`
    /// line; `parse_producer_build_output` extracts all of them with the same
    /// `split_whitespace` protocol.
    #[test]
    fn parses_trip_route_and_stop_cell_sha_lines() {
        let h = "a".repeat(64);
        let stdout = format!(
            "schedule-tile-bundle {h} 10 {hash}\ntrip-route {h} 20\nstop-cell {h} 30\n",
            hash = "f".repeat(64)
        );
        let parsed = parse_producer_build_output(&stdout);
        assert_eq!(
            parsed.trip_route_sha256.as_deref(),
            Some(&"a".repeat(64)[..])
        );
        assert_eq!(
            parsed.stop_cell_sha256.as_deref(),
            Some(&"a".repeat(64)[..])
        );
    }

    /// The two new SHA lines are required IFF the schedule-tile build ran
    /// (`schedule_tile_bundle_sha256.is_some()`). Build present but artifact
    /// line missing ⇒ error; nothing emitted (build did not run) ⇒ Ok/None.
    #[test]
    fn trip_route_sha_required_only_when_schedule_tile_bundle_present() {
        let h = "a".repeat(64);
        // schedule-tile-bundle present but trip-route/stop-cell missing => error
        let stdout = format!(
            "schedule-tile-bundle {h} 10 {hash}\n",
            hash = "f".repeat(64)
        );
        assert!(parse_producer_build_output(&stdout)
            .validate_required()
            .is_err());
        // nothing present (build did not run) => Ok, all None
        assert!(parse_producer_build_output("").validate_required().is_ok());
    }

    /// `current_generation_on_disk` names the pointed-at generation only when
    /// its directory is complete; a fresh root, a dangling pointer or a
    /// malformed id is `None`.
    #[test]
    fn current_generation_on_disk_requires_a_complete_generation() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path();
        assert_eq!(current_generation_on_disk(root), None, "fresh data root");

        let point_at = |id: &str| {
            let pointer = PointerManifest {
                manifest_schema_version: 2,
                generation_id: id.to_string(),
                city_slug: "test".into(),
                created_at: "2026-10-11T00:00:00Z".into(),
            };
            std::fs::write(
                root.join("current.json"),
                serde_json::to_vec(&pointer).unwrap(),
            )
            .unwrap();
        };
        let gen_id = "ab".repeat(32);
        point_at(&gen_id);
        assert_eq!(current_generation_on_disk(root), None, "dangling pointer");

        let gen_dir = root.join("generations").join(&gen_id);
        std::fs::create_dir_all(&gen_dir).unwrap();
        assert_eq!(
            current_generation_on_disk(root),
            None,
            "a generation dir without generation.json is incomplete"
        );
        std::fs::write(gen_dir.join("generation.json"), b"{}").unwrap();
        assert_eq!(current_generation_on_disk(root), Some(gen_id));

        point_at("../outside");
        assert_eq!(current_generation_on_disk(root), None, "malformed id");
    }
}
