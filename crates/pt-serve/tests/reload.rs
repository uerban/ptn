//! Reload runner integration tests (Stage 1).
//!
//! Exercises the SIGHUP-equivalent reload path via [`pt_serve::ReloadRunner::trigger_reload`] — the
//! internal trigger that mirrors a SIGHUP event without delivering a real signal. The signal
//! delivery path itself is covered by the end-to-end integration test (`pt-serve-topology.yml`);
//! these unit-level tests focus on:
//!
//! - the state machine: pointer → manifest → mmap → validate → Index → swap
//! - metrics surface: `reload_total{result=ok}` increments,
//!   `reload_consecutive_failures` resets ONLY on `ok` (rev 3)
//! - `Generation::Drop` instrumentation: `mapped_generation_count` returns
//!   to 1 once the old generation is retired
//! - `epoch` bump: each adoption produces a strictly-monotonic epoch
//!
//! Stage 2 (separate PR or follow-up commit on this branch) adds the
//! deterministic coalescing test via the `test-barrier` feature, the
//! parked-handler tests, and `tests/reload_negative.rs`.

#[path = "common/mod.rs"]
mod common;

use common::{canary_ptb_path, publisher, reload_harness, tiny_ptb_path, ReloadHarness};
use pt_serve::ops::metrics::{ReloadCause, ReloadResult};
use pt_serve::ReloadOutcome;

/// Build a runner against an already-published initial generation built from
/// `tiny.ptb`. Delegates to the shared [`common::reload_harness`]; the harness
/// body (publish → build_generation → wrap in ArcSwap → construct
/// ReloadRunner) now lives in `common/mod.rs` so `reload_poll.rs` reuses it.
///
/// `initial_gen_id` is the live generation's id at construction time — read
/// straight off `gen_handle` rather than threaded back out of the builder.
fn build_harness() -> (ReloadHarness, String) {
    let h = reload_harness("vilnius");
    let initial_gen_id = h.gen_handle.load().generation_id.clone();
    (h, initial_gen_id)
}

// ---------------------------------------------------------------------------
// Stage 1: baseline happy-path adoption
// ---------------------------------------------------------------------------

/// A schema-1 generation written before the publication id still loads after
/// an upgrade: its id and ETag are both the PTB hash.
#[test]
fn schema_1_generation_is_adopted_after_an_upgrade() {
    let (h, _) = build_harness();
    let created_at = publisher::rfc3339_format(1779494410);
    let id = publisher::publish_generation_with_schema_version(
        &h.data_root,
        "vilnius",
        &canary_ptb_path(),
        &created_at,
        1,
    );
    let outcome = h.runner.trigger_reload();
    assert!(outcome.is_adopted(), "outcome = {outcome:?}");
    let gen = h.gen_handle.load();
    assert_eq!(gen.generation_id, id);
    assert_eq!(gen.bundle_sha256, id);
    assert_eq!(gen.bundle_etag, format!("\"{id}\""));
}

/// Publish a NEW generation (`canary.ptb`), trigger reload, assert the swap
/// happened: `gen_handle` points at the new id, `reload_total{result=ok}` +1,
/// `reload_consecutive_failures` stays 0, and the new generation's epoch is 1.
#[test]
fn sighup_adopts_new_generation_and_resets_failures() {
    let (h, initial_id) = build_harness();
    assert_eq!(h.metrics.mapped_generation_count(), 1, "startup gauge = 1");
    assert_eq!(
        h.metrics.reload_total(ReloadResult::Ok, ReloadCause::None),
        0
    );

    // Publish a distinct second generation by laying down the canary bytes
    // into a NEW directory + new current.json pointing at it.
    let created_at = publisher::rfc3339_format(1779494410);
    let new_id =
        publisher::publish_generation(&h.data_root, "vilnius", &canary_ptb_path(), &created_at);
    assert_ne!(initial_id, new_id, "fixtures must have distinct SHA-256");

    let outcome = h.runner.trigger_reload();
    assert!(outcome.is_adopted(), "outcome = {outcome:?}");
    match outcome {
        ReloadOutcome::Adopted { generation_id } => assert_eq!(generation_id, new_id),
        _ => unreachable!(),
    }

    // Metrics
    assert_eq!(
        h.metrics.reload_total(ReloadResult::Ok, ReloadCause::None),
        1
    );
    assert_eq!(h.metrics.reload_consecutive_failures(), 0);
    assert_eq!(
        h.metrics.generation_adopted_total(&new_id),
        1,
        "per-id counter increments on adoption"
    );
    assert_eq!(h.metrics.current_generation_id(), new_id);

    // Swap target: gen_handle now points at new_id.
    let live = h.gen_handle.load();
    assert_eq!(live.generation_id, new_id);
    assert_eq!(live.epoch, 1, "first reload allocates epoch=1");
    // Bundle SHA round-trips into the new generation (handle builder
    // populates `bundle_sha256` from the manifest).
    assert_eq!(
        live.bundle_sha256,
        publisher::sha256_hex(&std::fs::read(canary_ptb_path()).unwrap())
    );
}

/// Triggering a reload when `current.json` still points at the live
/// generation is a NOOP. Counters: `reload_total{result=noop}` +1;
/// `reload_consecutive_failures` UNCHANGED (rev 3 invariant — load-bearing).
#[test]
fn sighup_noop_when_pointer_unchanged_does_not_reset_failures() {
    let (h, _initial_id) = build_harness();

    // Seed a non-zero consecutive_failures counter so we can prove the
    // noop path does NOT reset it.
    h.metrics.inc_reload_consecutive_failures();
    h.metrics.inc_reload_consecutive_failures();
    assert_eq!(h.metrics.reload_consecutive_failures(), 2);

    let outcome = h.runner.trigger_reload();
    assert!(outcome.is_noop(), "outcome = {outcome:?}");
    assert_eq!(
        h.metrics
            .reload_total(ReloadResult::Noop, ReloadCause::None),
        1
    );
    assert_eq!(
        h.metrics.reload_consecutive_failures(),
        2,
        "noop must NOT reset reload_consecutive_failures (rev 3 fix)"
    );
}

/// `last-good.json` is written PRE-SWAP (rev 3 ordering). After a successful
/// reload, `last-good.json` exists and points at the newly-adopted id.
#[test]
fn successful_reload_writes_last_good_pointing_at_new_generation() {
    let (h, _initial_id) = build_harness();
    let created_at = publisher::rfc3339_format(1779494410);
    let new_id =
        publisher::publish_generation(&h.data_root, "vilnius", &canary_ptb_path(), &created_at);

    let outcome = h.runner.trigger_reload();
    assert!(outcome.is_adopted(), "outcome = {outcome:?}");

    let last_good_path = publisher::last_good_path(&h.data_root);
    assert!(
        last_good_path.exists(),
        "last-good.json must exist after a successful reload"
    );
    let text = std::fs::read_to_string(&last_good_path).expect("read last-good.json");
    let parsed: pt_shared::manifest::PointerManifest =
        serde_json::from_str(&text).expect("parse last-good");
    assert_eq!(parsed.generation_id, new_id);
}

/// After a swap, the OLD `Arc<Generation>` retires once the test drops its
/// load handle — `mapped_generation_count` returns to 1, and
/// `generation_retired_total` increments by 1. This proves
/// `Generation::Drop` is wired up.
#[test]
fn retire_old_generation_decrements_mapped_count() {
    let (h, _initial_id) = build_harness();
    assert_eq!(h.metrics.mapped_generation_count(), 1);
    assert_eq!(h.metrics.generation_retired_total(), 0);

    let created_at = publisher::rfc3339_format(1779494410);
    let _new_id =
        publisher::publish_generation(&h.data_root, "vilnius", &canary_ptb_path(), &created_at);
    let outcome = h.runner.trigger_reload();
    assert!(outcome.is_adopted(), "outcome = {outcome:?}");

    // After the swap and with no outstanding load_full clones, the old
    // generation has been dropped. ArcSwap retires the old Arc immediately
    // when `store` is called and no other strong refs exist.
    assert_eq!(
        h.metrics.mapped_generation_count(),
        1,
        "gauge falls back to 1 after old gen retires"
    );
    assert_eq!(
        h.metrics.generation_retired_total(),
        1,
        "generation_retired_total fires when old gen is dropped"
    );
}

/// A pointer pointing at a non-existent generation dir surfaces as
/// `ValidationError::Io(NotFound)` (the read of the missing
/// `generation.json` fails first). The reload runner labels this as
/// `cause="io"` and bumps `reload_consecutive_failures`.
#[test]
fn reload_fails_with_io_when_generation_dir_missing() {
    let (h, initial_id) = build_harness();

    // Hand-mutate current.json to point at a non-existent id. We don't go
    // through `publish_generation` because we want the gen dir absent.
    let created_at = publisher::rfc3339_format(1779494410);
    publisher::point_current_at(
        &h.data_root,
        "vilnius",
        "deadbeef".repeat(8).as_str(),
        &created_at,
    );

    let outcome = h.runner.trigger_reload();
    assert!(outcome.is_failed(), "outcome = {outcome:?}");
    assert!(
        h.metrics
            .reload_total(ReloadResult::Failed, ReloadCause::Io)
            > 0,
        "io cause increments"
    );
    assert_eq!(
        h.metrics.reload_consecutive_failures(),
        1,
        "consecutive_failures bumps on failure"
    );
    // The live generation is untouched.
    let live = h.gen_handle.load();
    assert_eq!(live.generation_id, initial_id);
}

/// Two SHUP-equivalent triggers picking up two distinct generations in
/// sequence both adopt successfully. Epochs are strictly monotonic.
#[test]
fn two_sequential_adoptions_each_bump_epoch() {
    let (h, _initial_id) = build_harness();

    // Reload #1: publish canary, trigger, expect adoption to epoch=1.
    let created_at_1 = publisher::rfc3339_format(1779494410);
    let id1 =
        publisher::publish_generation(&h.data_root, "vilnius", &canary_ptb_path(), &created_at_1);
    let o1 = h.runner.trigger_reload();
    assert!(o1.is_adopted(), "first reload outcome = {o1:?}");
    let live = h.gen_handle.load();
    assert_eq!(live.generation_id, id1);
    assert_eq!(live.epoch, 1);
    drop(live);

    // Reload #2: publish tiny again (different id from canary), trigger,
    // expect adoption to epoch=2.
    let created_at_2 = publisher::rfc3339_format(1779494420);
    let id2 =
        publisher::publish_generation(&h.data_root, "vilnius", &tiny_ptb_path(), &created_at_2);
    assert_ne!(id1, id2);
    let o2 = h.runner.trigger_reload();
    assert!(o2.is_adopted(), "second reload outcome = {o2:?}");
    let live = h.gen_handle.load();
    assert_eq!(live.generation_id, id2);
    assert_eq!(live.epoch, 2, "epochs are strictly monotonic");
}

/// a NOOP reload (pointer unchanged) preserves the `bundle_etag` byte-for-byte — a conditional GET
/// with the pre-noop ETag MUST still receive 304. We don't roundtrip through HTTP here; we check
/// the underlying field stability (the dispatcher reads `gen.bundle_etag` once per response).
#[test]
fn noop_reload_preserves_bundle_etag() {
    let (h, _initial_id) = build_harness();

    let etag_before = h.gen_handle.load().bundle_etag.clone();
    assert!(!etag_before.is_empty(), "etag must be non-empty");

    // Same pointer — re-trigger.
    let outcome = h.runner.trigger_reload();
    assert!(outcome.is_noop(), "expected noop; got {outcome:?}");

    let etag_after = h.gen_handle.load().bundle_etag.clone();
    assert_eq!(
        etag_before, etag_after,
        "noop reload must preserve bundle_etag byte-for-byte"
    );
}

/// a successful adopt-from-`current.json` clears the `startup_fallback_active` flag. The startup
/// loader sets it when last-good was adopted instead of current; the first successful reload must
/// clear it.
#[test]
fn successful_reload_clears_startup_fallback_flag() {
    let (h, _initial_id) = build_harness();
    // Simulate "we booted off last-good": flip the flag manually (the
    // startup loader is exercised by `tests/startup_fallback.rs`, this
    // test focuses on the reload-runner clear path).
    h.metrics.set_startup_fallback_active(true);
    assert!(h.metrics.startup_fallback_active());

    let created_at = publisher::rfc3339_format(1779494410);
    let _new_id =
        publisher::publish_generation(&h.data_root, "vilnius", &canary_ptb_path(), &created_at);

    let outcome = h.runner.trigger_reload();
    assert!(outcome.is_adopted(), "outcome = {outcome:?}");
    assert!(
        !h.metrics.startup_fallback_active(),
        "successful adopt must clear startup_fallback_active"
    );
}

// Suppress dead-code warnings on the harness helpers when integration
// binaries don't exercise every method.
#[allow(dead_code)]
fn _silence_unused(_: &ReloadHarness) {}

#[test]
fn osm_only_address_publication_adopts_and_rolls_back_with_same_ptb() {
    let (h, _) = build_harness();
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
                city_id: Some("vilnius".into()),
                source: Some("fixture".into()),
                generated_at: "2026-10-29T00:00:00Z".into(),
            },
        )
        .unwrap()
    };
    let created = publisher::rfc3339_format(1779494400);
    let first = publisher::publish_generation_with_artifacts(
        &h.data_root,
        "vilnius",
        &tiny_ptb_path(),
        &created,
        &publisher::SidecarArtifacts {
            address_search: Some(pack("Old address")),
            ..Default::default()
        },
    );
    assert!(h.runner.trigger_reload().is_adopted());
    let held = h.gen_handle.load();
    let original_sha = held.address_search.as_ref().unwrap().sha256.clone();
    let second = publisher::publish_generation_with_artifacts(
        &h.data_root,
        "vilnius",
        &tiny_ptb_path(),
        &created,
        &publisher::SidecarArtifacts {
            address_search: Some(pack("New address")),
            ..Default::default()
        },
    );
    assert_ne!(first, second);
    assert!(h.runner.trigger_reload().is_adopted());
    let current = h.gen_handle.load();
    assert_eq!(current.bundle_sha256, held.bundle_sha256);
    assert_eq!(current.bundle_etag, held.bundle_etag);
    assert_ne!(
        current.address_search.as_ref().unwrap().sha256,
        original_sha
    );
    assert_eq!(
        held.address_search.as_ref().unwrap().sha256,
        original_sha,
        "in-flight requests retain the prior generation"
    );
    publisher::point_current_at(&h.data_root, "vilnius", &first, &created);
    assert!(h.runner.trigger_reload().is_adopted());
    assert_eq!(
        h.gen_handle.load().address_search.as_ref().unwrap().sha256,
        original_sha
    );
}

#[test]
fn geometry_policy_survives_reload_with_unusable_shapes() {
    let h = reload_harness("vilnius");
    let mut config = common::default_test_config(h.data_root.clone());
    config.city_slug = "vilnius".into();
    config.without_geometry = true;
    let runner = pt_serve::ReloadRunner::new(
        h.gen_handle.clone(),
        std::sync::Arc::new(config),
        h.metrics.clone(),
        h.clock.clone(),
    );
    let created_at = publisher::rfc3339_format(common::RELOAD_HARNESS_ANCHOR + 60);
    let id = publisher::publish_generation_with_artifacts(
        &h.data_root,
        "vilnius",
        &canary_ptb_path(),
        &created_at,
        &publisher::SidecarArtifacts {
            shapes_bin: Some(b"SHPBcorrupt".to_vec()),
            ..Default::default()
        },
    );
    let manifest_path = publisher::manifest_path_for(&h.data_root, &id);
    let before = std::fs::read(&manifest_path).unwrap();
    assert!(runner.trigger_reload().is_adopted());
    let current = h.gen_handle.load();
    assert_eq!(current.generation_id, id);
    assert!(current.shapes_json_bytes().is_none());
    assert!(current.shapes_json_sha256.is_none());
    assert!(current.route_geometry_etag.is_none());
    assert_eq!(std::fs::read(manifest_path).unwrap(), before);
}
