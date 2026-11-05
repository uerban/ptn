//! Negative reload-runner cases (Stage 2).
//!
//!
//! 1. **Failed reload does NOT update `last-good.json` mtime.** A failed validation must keep the
//! previously-committed last-good pointer untouched — operators rely on `last-good.json`'s age for
//! the `last_good_age_exceeds_retention` alert.
//! 2. **`Noop` does NOT reset
//! `reload_consecutive_failures`.** Already covered as a unit test in `tests/reload.rs`; replicated
//! here for completeness alongside the other negative cases, with an additional sub-assertion that
//! a SUBSEQUENT successful adoption DOES reset.
//! 3. **In-place corruption → `BundleSizeMismatch`.**
//! The reload pipeline's cheap on-disk-size precheck must catch a truncated bundle BEFORE SHA-256
//! fires (the precheck closes the torn-write race window).
//! 4. **Snapshot proof via content stamp.**
//! A request that captures `Arc<Generation>` before a swap continues to see the OLD generation's
//! `generation_id` even after the swap — verifying the lock-free reload contract: in-flight holders
//! observe the generation they snapshotted, not the latest swap target.
//!
//! Note: this integration test legitimately calls `ArcSwap::load_full` to
//! simulate the in-flight worker; the clippy disallowed-methods rule that
//! restricts ambient `Arc<Generation>` in handlers is opted-out at file
//! scope for the duration of this test.

#![allow(clippy::disallowed_methods)]

#[path = "common/mod.rs"]
mod common;

use common::publisher;
use pt_serve::ops::metrics::{ReloadCause, ReloadResult};
use pt_serve::{Generation, Metrics, ReloadRunner};
use pt_shared::clock::{Clock, MockClock};
use pt_shared::validate::errors::{ProducerError, ValidationError};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}
fn canary_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/canary.ptb")
}

struct H {
    runner: Arc<ReloadRunner>,
    metrics: Arc<Metrics>,
    data_root: tempfile::TempDir,
    gen_handle: Arc<arc_swap::ArcSwap<Generation>>,
}

fn boot(city: &str, initial_ptb: &Path) -> H {
    let data_root = tempfile::tempdir().expect("tempdir");
    let clock_mock = Arc::new(MockClock::new(
        SystemTime::UNIX_EPOCH + Duration::from_secs(1779494400),
    ));
    let clock: Arc<dyn Clock> = clock_mock.clone();
    let metrics = Metrics::new();
    let created_at = publisher::rfc3339_format(1779494400);
    let id = publisher::publish_generation(data_root.path(), city, initial_ptb, &created_at);
    let manifest_text =
        std::fs::read_to_string(publisher::manifest_path_for(data_root.path(), &id)).unwrap();
    let manifest: pt_shared::manifest::GenerationManifest =
        serde_json::from_str(&manifest_text).unwrap();
    let initial = pt_serve::bundle::build_generation(pt_serve::bundle::BuildInputs {
        manifest: &manifest,
        bundle_path: &publisher::bundle_path_for(data_root.path(), &id),
        transfers_path: None,
        expected_city: city,
        clock: clock.as_ref(),
        is_startup: true,
        epoch: 0,
        metrics: Some(Arc::clone(&metrics)),
        city_tz_iana_default: Some("Europe/Vilnius"),
        pattern_mode: pt_core::PatternMode::Off,
    })
    .expect("initial");
    metrics.record_generation_adopted(
        &initial.generation_id,
        clock
            .now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    );
    let gen_handle = Arc::new(arc_swap::ArcSwap::new(Arc::new(initial)));
    let mut cfg = common::default_test_config(data_root.path().to_path_buf());
    cfg.city_slug = city.to_string();
    cfg.worker_pool_size = 1;
    let config = Arc::new(cfg);
    let runner = Arc::new(ReloadRunner::new(
        Arc::clone(&gen_handle),
        Arc::clone(&config),
        Arc::clone(&metrics),
        clock,
    ));
    H {
        runner,
        metrics,
        data_root,
        gen_handle,
    }
}

// ---------------------------------------------------------------------------
// 1. Failed reload does NOT update last-good.json mtime
// ---------------------------------------------------------------------------

#[test]
fn failed_reload_leaves_last_good_untouched() {
    let h = boot("vilnius", &tiny_ptb_path());

    // First, do a SUCCESSFUL reload so last-good.json exists. We need
    // canary.ptb published as the new target.
    let created_b = publisher::rfc3339_format(1779494410);
    publisher::publish_generation(
        h.data_root.path(),
        "vilnius",
        &canary_ptb_path(),
        &created_b,
    );
    let outcome = h.runner.trigger_reload();
    assert!(outcome.is_adopted(), "{outcome:?}");
    let last_good_path = publisher::last_good_path(h.data_root.path());
    let mtime_before = std::fs::metadata(&last_good_path)
        .unwrap()
        .modified()
        .unwrap();

    // Now publish a "broken" pointer — point at a non-existent gen.
    let created_c = publisher::rfc3339_format(1779494420);
    publisher::point_current_at(
        h.data_root.path(),
        "vilnius",
        "f".repeat(64).as_str(),
        &created_c,
    );

    // Wait at least 1s so an inadvertent mtime touch is observable on
    // filesystems with second-resolution mtime. We use the test clock for
    // the validator, but the filesystem still uses real time.
    std::thread::sleep(std::time::Duration::from_millis(1100));

    let outcome = h.runner.trigger_reload();
    assert!(outcome.is_failed(), "{outcome:?}");

    let mtime_after = std::fs::metadata(&last_good_path)
        .unwrap()
        .modified()
        .unwrap();
    assert_eq!(
        mtime_before, mtime_after,
        "failed reload must NOT update last-good.json mtime"
    );
}

// ---------------------------------------------------------------------------
// 2. Noop does NOT reset reload_consecutive_failures; subsequent ok DOES
// ---------------------------------------------------------------------------

#[test]
fn noop_does_not_reset_but_subsequent_ok_does() {
    let h = boot("vilnius", &tiny_ptb_path());
    h.metrics.inc_reload_consecutive_failures();
    h.metrics.inc_reload_consecutive_failures();
    assert_eq!(h.metrics.reload_consecutive_failures(), 2);

    let noop_outcome = h.runner.trigger_reload();
    assert!(noop_outcome.is_noop(), "{noop_outcome:?}");
    assert_eq!(
        h.metrics.reload_consecutive_failures(),
        2,
        "noop must not reset"
    );

    // Now publish a real new gen and trigger; ok MUST reset.
    let created_b = publisher::rfc3339_format(1779494410);
    publisher::publish_generation(
        h.data_root.path(),
        "vilnius",
        &canary_ptb_path(),
        &created_b,
    );
    let ok_outcome = h.runner.trigger_reload();
    assert!(ok_outcome.is_adopted(), "{ok_outcome:?}");
    assert_eq!(
        h.metrics.reload_consecutive_failures(),
        0,
        "successful adoption resets reload_consecutive_failures"
    );
}

// ---------------------------------------------------------------------------
// 3. In-place corruption → BundleSizeMismatch
// ---------------------------------------------------------------------------

#[test]
fn in_place_corruption_caught_by_bundle_size_precheck() {
    let h = boot("vilnius", &tiny_ptb_path());

    // Publish canary as a NEW generation. Then truncate the on-disk
    // bundle.ptb under that gen dir to break the size cross-check WITHOUT
    // touching generation.json.
    let created_b = publisher::rfc3339_format(1779494410);
    let id_b = publisher::publish_generation(
        h.data_root.path(),
        "vilnius",
        &canary_ptb_path(),
        &created_b,
    );
    let bundle_path = publisher::bundle_path_for(h.data_root.path(), &id_b);
    // Truncate to half size.
    let bytes = std::fs::read(&bundle_path).unwrap();
    std::fs::write(&bundle_path, &bytes[..bytes.len() / 2]).unwrap();

    let outcome = h.runner.trigger_reload();
    assert!(outcome.is_failed(), "{outcome:?}");
    match outcome {
        pt_serve::ReloadOutcome::Failed(ValidationError::Producer(
            ProducerError::BundleSizeMismatch { expected, actual },
        )) => {
            assert_eq!(expected, bytes.len() as u64);
            assert_eq!(actual, (bytes.len() / 2) as u64);
        }
        other => panic!("expected Producer(BundleSizeMismatch), got {other:?}"),
    }
    // Metrics: producer cause increments.
    assert!(
        h.metrics
            .reload_total(ReloadResult::Failed, ReloadCause::Producer)
            >= 1
    );
}

// ---------------------------------------------------------------------------
// 4. load_full snapshot proof: in-flight Arc<Generation> holders see the
//    OLD generation_id after the swap
// ---------------------------------------------------------------------------

#[test]
fn load_full_snapshot_observes_pre_swap_generation_id() {
    let h = boot("vilnius", &tiny_ptb_path());

    // Snapshot the live generation BEFORE the swap.
    let pre = h.gen_handle.load_full();
    let pre_id = pre.generation_id.clone();

    // Publish a new gen and swap.
    let created_b = publisher::rfc3339_format(1779494410);
    let id_b = publisher::publish_generation(
        h.data_root.path(),
        "vilnius",
        &canary_ptb_path(),
        &created_b,
    );
    assert_ne!(pre_id, id_b);
    let outcome = h.runner.trigger_reload();
    assert!(outcome.is_adopted(), "{outcome:?}");

    // The Arc we snapshotted before the swap still points at the old gen.
    assert_eq!(
        pre.generation_id, pre_id,
        "pre-swap Arc<Generation> snapshot is stable across the swap"
    );
    // A FRESH load_full sees the new gen.
    let post = h.gen_handle.load_full();
    assert_eq!(post.generation_id, id_b);
    assert_ne!(post.generation_id, pre.generation_id);

    // mapped_generation_count is 2 while BOTH Arcs are alive.
    assert_eq!(
        h.metrics.mapped_generation_count(),
        2,
        "two live generations while pre + post Arcs are both held"
    );
    drop(pre);
    // After dropping the pre-swap Arc, the old gen retires.
    assert_eq!(h.metrics.mapped_generation_count(), 1);
    assert!(h.metrics.generation_retired_total() >= 1);
}

// ---------------------------------------------------------------------------
// 5. In-place corruption with UNCHANGED pointer also fires BundleSizeMismatch
//
// the size precheck runs on every reload, NOT just when the pointer changes. If the producer
// atomically swaps current.json to a new generation AND then the on-disk bundle.ptb under that
// generation is truncated (e.g. by a corrupted volume snapshot or a misbehaving sidecar), a
// subsequent SIGHUP must still catch the mismatch. The test fakes this by: (1) boot on tiny.ptb,
// (2) adopt a canary generation cleanly, (3) truncate the canary's bundle.ptb in place (without
// touching the generation.json or republishing), (4) trigger_reload — pointer is unchanged so the
// runner WOULD classify as Noop based on pointer-stat alone, but the size precheck inspects the
// on-disk bundle and must fire BundleSizeMismatch.
// ---------------------------------------------------------------------------

#[test]
fn in_place_corruption_with_unchanged_pointer_fires_size_precheck() {
    let h = boot("vilnius", &tiny_ptb_path());

    // Step 1+2: publish canary and adopt it. current.json now points at
    // canary's generation_id; pointer is now stable on that target.
    let created_b = publisher::rfc3339_format(1779494410);
    let id_b = publisher::publish_generation(
        h.data_root.path(),
        "vilnius",
        &canary_ptb_path(),
        &created_b,
    );
    let outcome_adopt = h.runner.trigger_reload();
    assert!(
        outcome_adopt.is_adopted(),
        "first adopt failed: {outcome_adopt:?}"
    );

    // Step 3: truncate canary's bundle.ptb in place WITHOUT touching
    // generation.json. The manifest's bundleSizeBytes now disagrees with
    // the on-disk file size. The pointer (current.json) is UNCHANGED;
    // a noop-classification based on pointer alone would miss this.
    let bundle_path = publisher::bundle_path_for(h.data_root.path(), &id_b);
    let bytes = std::fs::read(&bundle_path).unwrap();
    std::fs::write(&bundle_path, &bytes[..bytes.len() / 2]).unwrap();

    // Step 4: trigger reload. The runner's noop classification reads
    // generation.json; the size precheck then catches the truncation.
    let before_failed = h
        .metrics
        .reload_total(ReloadResult::Failed, ReloadCause::Producer);
    let outcome = h.runner.trigger_reload();
    // Either Failed (size precheck caught it) OR Noop (pointer unchanged
    // path classified before the size check). The CONTRACT is the size
    // check fires; we tolerate either Noop-then-failed-next-tick or
    // immediate Failed but assert the producer-cause counter eventually
    // bumps for the truncated bundle.
    match outcome {
        pt_serve::ReloadOutcome::Failed(ValidationError::Producer(
            ProducerError::BundleSizeMismatch { expected, actual },
        )) => {
            assert_eq!(expected, bytes.len() as u64);
            assert_eq!(actual, (bytes.len() / 2) as u64);
            assert!(
                h.metrics
                    .reload_total(ReloadResult::Failed, ReloadCause::Producer)
                    > before_failed,
                "reload_total{{result=failed,cause=producer}} must increment"
            );
        }
        pt_serve::ReloadOutcome::Noop => {
            // If the runner classifies as Noop on unchanged pointer, the
            // size precheck does NOT fire — which would be a spec gap.
            // Surface it loudly so the runner's logic gets reviewed.
            panic!(
                "Noop classification on unchanged pointer SHOULD NOT bypass the size precheck — \
                 in-place truncation went undetected. Size must be checked on every \
                 reload pass."
            );
        }
        other => panic!("expected Failed(BundleSizeMismatch), got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// 6. SAME-SIZE in-place corruption with unchanged pointer fires the no-op
//    path's re-hash (audit R3)
//
// The size precheck (case 5 above) is blind to corruption that preserves the
// byte count. The no-op classification therefore re-hashes the on-disk bytes
// against the manifest before returning Noop: "no-op" must mean "manifest,
// served bytes, and on-disk bytes all agree", not "the pointer didn't move".
// ---------------------------------------------------------------------------

#[test]
fn same_size_in_place_corruption_with_unchanged_pointer_fires_rehash() {
    let h = boot("vilnius", &tiny_ptb_path());

    // Publish + adopt canary so the pointer is stable on a known target.
    let created_b = publisher::rfc3339_format(1779494410);
    let id_b = publisher::publish_generation(
        h.data_root.path(),
        "vilnius",
        &canary_ptb_path(),
        &created_b,
    );
    let outcome_adopt = h.runner.trigger_reload();
    assert!(
        outcome_adopt.is_adopted(),
        "first adopt failed: {outcome_adopt:?}"
    );

    // Flip one byte at the END of the bundle (out of the header) WITHOUT
    // changing the size. The size precheck passes; only a content re-hash
    // can catch this.
    let bundle_path = publisher::bundle_path_for(h.data_root.path(), &id_b);
    let mut bytes = std::fs::read(&bundle_path).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 0xff;
    std::fs::write(&bundle_path, &bytes).unwrap();

    let before_failed = h
        .metrics
        .reload_total(ReloadResult::Failed, ReloadCause::Producer);
    let outcome = h.runner.trigger_reload();
    match outcome {
        pt_serve::ReloadOutcome::Failed(ValidationError::Producer(
            ProducerError::BundleHashMismatch { expected, computed },
        )) => {
            assert_eq!(
                expected,
                publisher::sha256_hex(&std::fs::read(canary_ptb_path()).unwrap()),
                "manifest SHA identifies PTB bytes independently of publication ID"
            );
            assert_ne!(computed, expected);
            assert!(
                h.metrics
                    .reload_total(ReloadResult::Failed, ReloadCause::Producer)
                    > before_failed,
                "reload_total{{result=failed,cause=producer}} must increment"
            );
        }
        pt_serve::ReloadOutcome::Noop => panic!(
            "Noop classification MUST re-hash the on-disk bundle — same-size in-place \
             corruption went undetected"
        ),
        other => panic!("expected Failed(BundleHashMismatch), got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// 7. A live generation WITHOUT a bundle sha cannot vouch for a no-op
//    (audit R6)
//
// Startup generations built via `Generation::from_paths` carry an empty
// `bundle_sha256` (no manifest). If `current.json` points at the live
// generation's id, the runner used to skip the reuse check entirely and
// return Noop — trusting an id match it could not verify. It must instead
// fall through to a full rebuild, whose validation re-establishes the
// hashes structurally. The rebuild here fails manifest validation (the
// hand-crafted generation id is not the bundle's sha), which is fine: the
// contract under test is only "an unverifiable pointer match is NOT a Noop".
// ---------------------------------------------------------------------------

#[test]
fn empty_live_sha_does_not_shortcircuit_noop_classification() {
    let h = boot("vilnius", &tiny_ptb_path());

    // Replace the live generation with a from_paths one (empty bundle_sha256)
    // over the SAME published bundle bytes.
    let ptr_text = std::fs::read_to_string(h.data_root.path().join("current.json")).unwrap();
    let ptr: serde_json::Value = serde_json::from_str(&ptr_text).unwrap();
    let tiny_id = ptr["generationId"].as_str().unwrap().to_string();
    let tiny_bundle = publisher::bundle_path_for(h.data_root.path(), &tiny_id);
    let live = Generation::from_paths(
        &tiny_bundle,
        None,
        "vilnius".to_string(),
        pt_core::PatternMode::Off,
    )
    .expect("from_paths");
    assert!(
        live.bundle_sha256.is_empty(),
        "precondition: from_paths generations carry no bundle sha"
    );
    let live_id = live.generation_id.clone();
    h.gen_handle.store(Arc::new(live));

    // Craft a generation dir whose id matches the live from_paths id and
    // point current.json at it. Old behavior: pointer id == live id + empty
    // live sha => Noop without any verification.
    let bytes = std::fs::read(&tiny_bundle).unwrap();
    let gen_dir = h.data_root.path().join("generations").join(&live_id);
    std::fs::create_dir_all(&gen_dir).unwrap();
    std::fs::write(gen_dir.join("bundle.ptb"), &bytes).unwrap();
    let manifest = serde_json::json!({
        "manifestSchemaVersion": 2,
        "generationId": live_id,
        "citySlug": "vilnius",
        "bundleSha256": tiny_id,
        "publicationInputsSha256": "0".repeat(64),
        "bundleSizeBytes": bytes.len() as u64,
        "feedStartDate": publisher::feed_start_date_of(&bytes),
        "hasTransfers": false,
        "transfersSha256": null,
        "transfersSizeBytes": null,
        "createdAt": publisher::rfc3339_format(1779494420),
    });
    std::fs::write(
        gen_dir.join("generation.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();
    publisher::point_current_at(
        h.data_root.path(),
        "vilnius",
        &live_id,
        &publisher::rfc3339_format(1779494420),
    );

    let outcome = h.runner.trigger_reload();
    assert!(
        !outcome.is_noop(),
        "an unverifiable pointer match (live generation has no bundle sha) must NOT be \
         classified as Noop — got {outcome:?}"
    );
}
