//! Forward-incompat handling.
//!
//! When a producer publishes a manifest whose `manifestSchemaVersion`
//! exceeds the loader's `MANIFEST_SCHEMA_VERSION_MAX`, the reload runner
//! MUST:
//!
//! 1. Reject the reload with
//!    `ValidationError::Operator(OperatorError::UnsupportedManifestSchemaVersion(<n>))`.
//! 2. Bump `reload_manifest_version_unsupported_total{found_version=<n>}`.
//! 3. NOT swap the live generation (the bad pointer stays out of service).
//! 4. NOT reset `reload_consecutive_failures` on a subsequent same-bad
//!    reload — operator dashboards depend on that gauge climbing.
//!
//! `/ready` continues to surface `manifestSchemaVersionMax = 2` so an
//! operator can spot the version mismatch in the readiness body without
//! parsing logs.

#[path = "common/mod.rs"]
mod common;

use common::publisher;
use pt_serve::ops::metrics::{ReloadCause, ReloadResult};
use pt_serve::{Generation, Metrics, ReloadOutcome, ReloadRunner};
use pt_shared::clock::{Clock, MockClock};
use pt_shared::validate::errors::{OperatorError, ValidationError};
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

struct Harness {
    runner: Arc<ReloadRunner>,
    metrics: Arc<Metrics>,
    data_root: tempfile::TempDir,
    initial_gen_id: String,
    gen_handle: Arc<arc_swap::ArcSwap<Generation>>,
}

fn build_harness(city: &str, initial_ptb: &Path) -> Harness {
    // Same anchor as `tests/reload.rs` so the metadata validator accepts
    // the manifest's createdAt without skew rejection.
    let clock = Arc::new(MockClock::new(
        SystemTime::UNIX_EPOCH + Duration::from_secs(1779494400),
    ));
    let data_root = tempfile::tempdir().expect("tempdir");
    let created_at = publisher::rfc3339_format(1779494400);
    let initial_gen_id =
        publisher::publish_generation(data_root.path(), city, initial_ptb, &created_at);
    let manifest_text = std::fs::read_to_string(publisher::manifest_path_for(
        data_root.path(),
        &initial_gen_id,
    ))
    .expect("read manifest");
    let manifest: pt_shared::manifest::GenerationManifest =
        serde_json::from_str(&manifest_text).expect("parse manifest");
    let metrics = Metrics::new();
    let clock_dyn: Arc<dyn Clock> = clock.clone();
    let initial = pt_serve::bundle::build_generation(pt_serve::bundle::BuildInputs {
        manifest: &manifest,
        bundle_path: &publisher::bundle_path_for(data_root.path(), &initial_gen_id),
        transfers_path: None,
        expected_city: city,
        clock: clock_dyn.as_ref(),
        is_startup: true,
        epoch: 0,
        metrics: Some(Arc::clone(&metrics)),
        city_tz_iana_default: Some("Europe/Vilnius"),
        pattern_mode: pt_core::PatternMode::Off,
    })
    .expect("build initial generation");
    let now_unix = clock_dyn
        .now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    metrics.record_generation_adopted(&initial.generation_id, now_unix);

    let gen_handle = Arc::new(arc_swap::ArcSwap::new(Arc::new(initial)));
    let mut cfg = common::default_test_config(data_root.path().to_path_buf());
    cfg.city_slug = city.to_string();
    cfg.worker_pool_size = 1;
    let config = Arc::new(cfg);
    let runner = Arc::new(ReloadRunner::new(
        Arc::clone(&gen_handle),
        Arc::clone(&config),
        Arc::clone(&metrics),
        clock_dyn,
    ));
    Harness {
        runner,
        metrics,
        data_root,
        initial_gen_id,
        gen_handle,
    }
}

/// A manifest with `manifestSchemaVersion=99` MUST fail reload with
/// `OperatorError::UnsupportedManifestSchemaVersion(99)`, bump the labeled
/// counter, and leave the live generation untouched.
#[test]
fn reload_rejects_manifest_schema_version_99() {
    let h = build_harness("vilnius", &tiny_ptb_path());
    let initial_id = h.initial_gen_id.clone();

    // Publish a NEW generation (canary bytes → distinct id) with the bad
    // schema version. Pointer points at the new id.
    let created_at = publisher::rfc3339_format(1779494410);
    let new_id = publisher::publish_generation_with_schema_version(
        h.data_root.path(),
        "vilnius",
        &canary_ptb_path(),
        &created_at,
        99,
    );
    assert_ne!(initial_id, new_id, "canary must differ from tiny");

    let outcome = h.runner.trigger_reload();
    match outcome {
        ReloadOutcome::Failed(ValidationError::Operator(
            OperatorError::UnsupportedManifestSchemaVersion(v),
        )) => assert_eq!(v, 99),
        other => panic!("expected UnsupportedManifestSchemaVersion(99); got {other:?}"),
    }

    // Labeled counter increments.
    assert_eq!(
        h.metrics.reload_manifest_version_unsupported(99),
        1,
        "reload_manifest_version_unsupported_total{{found_version=\"99\"}} must increment"
    );

    // The operator-class cause renders under `reload_total{cause=operator}`.
    assert!(
        h.metrics
            .reload_total(ReloadResult::Failed, ReloadCause::Operator)
            > 0,
        "reload_total{{result=failed,cause=operator}} must increment"
    );

    // Live generation untouched.
    let live = h.gen_handle.load();
    assert_eq!(
        live.generation_id, h.initial_gen_id,
        "live generation must not swap on a rejected reload"
    );

    // consecutive_failures climbed to 1.
    assert_eq!(h.metrics.reload_consecutive_failures(), 1);
}

/// A SECOND reload against the SAME bad manifest must also fail AND must
/// keep `reload_consecutive_failures` climbing (the spec's reset-only-on-
/// `ok` rule applies; a stuck-on-bad-bundle process must look unhealthy).
#[test]
fn repeated_bad_schema_keeps_consecutive_failures_climbing() {
    let h = build_harness("vilnius", &tiny_ptb_path());
    let created_at = publisher::rfc3339_format(1779494410);
    let _new_id = publisher::publish_generation_with_schema_version(
        h.data_root.path(),
        "vilnius",
        &canary_ptb_path(),
        &created_at,
        99,
    );

    let first = h.runner.trigger_reload();
    assert!(first.is_failed());
    assert_eq!(h.metrics.reload_consecutive_failures(), 1);

    let second = h.runner.trigger_reload();
    assert!(second.is_failed());
    assert_eq!(
        h.metrics.reload_consecutive_failures(),
        2,
        "subsequent same-bad reload must NOT reset the failure counter"
    );

    // Both failures increment the labeled counter.
    assert_eq!(
        h.metrics.reload_manifest_version_unsupported(99),
        2,
        "labeled counter increments per attempt"
    );
}

/// The `/metrics` exposition surface must render
/// `reload_manifest_version_unsupported_total{found_version="99"} 1`
/// after a rejected reload. Sanity-test through the Prometheus body
/// builder so a regression in the labeled-counter render path is caught.
#[test]
fn metrics_exposition_renders_unsupported_version_label() {
    let h = build_harness("vilnius", &tiny_ptb_path());
    let created_at = publisher::rfc3339_format(1779494410);
    let _new_id = publisher::publish_generation_with_schema_version(
        h.data_root.path(),
        "vilnius",
        &canary_ptb_path(),
        &created_at,
        99,
    );
    let _ = h.runner.trigger_reload();

    let body = pt_serve::ops::metrics::render_body(&h.metrics);
    assert!(
        body.contains("reload_manifest_version_unsupported_total{found_version=\"99\"} 1\n"),
        "metrics body must carry the labeled counter; body:\n{body}"
    );
}

/// `manifestSchemaVersionMax` exposed via the FROM-Rust constant must
/// equal `pt_shared::manifest::MANIFEST_SCHEMA_VERSION_MAX` (currently
/// `1`). The `/ready` body surfaces this so operators can spot the
/// version-mismatch class without parsing logs.
#[test]
fn manifest_schema_version_max_is_two() {
    assert_eq!(pt_shared::manifest::MANIFEST_SCHEMA_VERSION_MAX, 2);
}

/// **Startup-path fail-closed contract** (post-review pass #3, Engineer +
/// Architect convergence): a `current.json` with a forward-incompat
/// `manifestSchemaVersion` MUST cause startup to exit with the fatal
/// validation error and NOT fall back to `last-good.json`. The prior tests
/// in this file exercise the reload runner; the startup path is a different
/// caller (`load_initial_generation_with_force` in `bundle/mod.rs`) and a
/// silent regression there would let a fail-closed-on-fatal-class promise
/// rot. Seed BOTH pointers: `current.json` schema=99, `last-good.json`
/// schema=1; the loader must surface the fatal error before falling back.
#[test]
fn startup_path_is_fatal_short_circuits_last_good_fallback() {
    let clock = MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(1779494400));
    let data_root = tempfile::tempdir().expect("tempdir");
    let metrics = Metrics::new();
    let city = "vilnius";

    // Publish a valid last-good (schema=1) FIRST so it exists on disk.
    let lg_created = publisher::rfc3339_format(1779494400);
    let last_good_id =
        publisher::publish_generation(data_root.path(), city, &tiny_ptb_path(), &lg_created);
    // Re-point last-good.json explicitly (publish_generation flips current.json;
    // we want last-good.json to point at this gen and current.json to point at
    // the forward-incompat one below).
    let last_good_pointer = pt_shared::manifest::PointerManifest {
        manifest_schema_version: 2,
        generation_id: last_good_id.clone(),
        city_slug: city.to_string(),
        created_at: lg_created,
    };
    std::fs::write(
        data_root.path().join("last-good.json"),
        serde_json::to_vec(&last_good_pointer).unwrap(),
    )
    .unwrap();

    // Now publish a forward-incompat current.json (schema=99).
    let cur_created = publisher::rfc3339_format(1779494410);
    let _bad_id = publisher::publish_generation_with_schema_version(
        data_root.path(),
        city,
        &canary_ptb_path(),
        &cur_created,
        99,
    );

    // Startup load MUST fail-closed: the is_fatal()-class current error
    // short-circuits last-good fallback.
    let result = pt_serve::bundle::load_initial_generation_with_force(
        data_root.path(),
        city,
        &clock,
        &metrics,
        None,
        pt_serve::ops::config::LogFormat::Json,
        None,
        pt_core::PatternMode::Off,
    );
    let err = match result {
        Ok(_) => {
            panic!("startup must fail-closed on forward-incompat current.json; got Ok(Generation)")
        }
        Err(e) => e,
    };
    match err {
        pt_serve::bundle::loader::LoadError::Validation(ValidationError::Operator(
            OperatorError::UnsupportedManifestSchemaVersion(v),
        )) => {
            assert_eq!(v, 99, "the rejected version must match what was published");
        }
        other => panic!(
            "expected Validation(Operator(UnsupportedManifestSchemaVersion(99))); got {other:?}"
        ),
    }
    // Sanity: last-good.json IS present and otherwise loadable — proving
    // the short-circuit is doing real work (NOT falling-through to it).
    assert!(data_root.path().join("last-good.json").exists());
    let _ = clock; // silence the warning if MockClock is otherwise unused
}
