//! `--force-current` DR escape hatch.
//!
//! When the operator passes `--force-current=<id>`, pt-serve MUST:
//!
//! 1. Bypass `current.json` and `last-good.json` entirely — load
//!    `<data_root>/generations/<id>/{generation.json,bundle.ptb}` directly.
//! 2. Run the same city-slug + bundle-size cross-checks the normal load
//!    path runs (forced mode is a fallback adoption, not a permission to
//!    serve garbage).
//! 3. Flip the sticky `forced_current_mode_active` flag so `/ready` and
//!    `/metrics` expose `pt_serve_forced_current_mode 1` for operator
//!    dashboards + alert rules.
//! 4. Fail-closed when the forced gen directory is missing or the manifest
//!    points at the wrong city.
//!
//! Architect review #3 caught that the DR surface was wired in
//! `bundle/mod.rs::load_initial_generation_with_force` + `load_forced_generation`
//! with ZERO direct test coverage — same class of finding the prior
//! architect pass made on the original (un)wiring. These tests pin the
//! four contract bullets above.

#[path = "common/mod.rs"]
mod common;

use common::publisher;
use pt_serve::ops::config::LogFormat;
use pt_serve::Metrics;
use pt_shared::clock::MockClock;
use pt_shared::validate::errors::{OperatorError, ProducerError, ValidationError};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

fn canary_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/canary.ptb")
}

/// Happy path: `--force-current=<id>` loads the forced generation,
/// independent of what `current.json` says, AND flips the sticky metric.
#[test]
fn force_current_adopts_named_generation_and_flips_sticky_flag() {
    let clock = MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(1779494400));
    let data_root = tempfile::tempdir().expect("tempdir");
    let metrics = Metrics::new();
    let city = "vilnius";

    // Publish gen A and let current.json point at it (this is the "broken"
    // pointer the operator wants to bypass — the test isn't checking that
    // current.json is bad, just that the forced path doesn't even read it).
    let created_a = publisher::rfc3339_format(1779494400);
    let id_a = publisher::publish_generation(data_root.path(), city, &tiny_ptb_path(), &created_a);

    // Publish gen B (from canary.ptb so the content-addressed generation_id
    // differs from A's); since `publish_generation` flips current.json to B,
    // current.json now names B. Force back to A.
    let created_b = publisher::rfc3339_format(1779494410);
    let id_b =
        publisher::publish_generation(data_root.path(), city, &canary_ptb_path(), &created_b);
    assert_ne!(id_a, id_b, "sanity: A and B must be distinct generations");

    // Pre-condition: the sticky flag starts false.
    assert!(
        !metrics.forced_current_mode_active(),
        "sticky flag must be false before adoption"
    );

    let gen = pt_serve::bundle::load_initial_generation_with_force(
        data_root.path(),
        city,
        &clock,
        &metrics,
        Some(&id_a),
        LogFormat::Json,
        // tiny.ptb/canary.ptb carry cityTzOffsetSeconds=10800 (Europe/Vilnius
        // EEST at feed_start_date 20260501); supply the matching IANA default so
        // the T13 cross-check resolves and passes. Mirrors the compose
        // --city-tz-iana-default=Europe/Vilnius for pt-serve-vilnius.
        Some("Europe/Vilnius"),
        pt_core::PatternMode::Off,
    )
    .expect("force-current adoption must succeed");

    assert_eq!(
        gen.generation_id, id_a,
        "forced mode must adopt id_a, not whatever current.json names"
    );
    assert!(
        metrics.forced_current_mode_active(),
        "sticky flag MUST flip true after a forced adoption"
    );
}

/// Missing-gen fail-closed: `--force-current=<bogus>` returns an Io::NotFound
/// rather than silently falling through to current/last-good.
#[test]
fn force_current_missing_generation_returns_not_found() {
    let clock = MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(1779494400));
    let data_root = tempfile::tempdir().expect("tempdir");
    let metrics = Metrics::new();
    let city = "vilnius";

    // Seed at least one published gen so current.json points somewhere valid;
    // the test must prove the forced load does NOT fall through to it.
    let created = publisher::rfc3339_format(1779494400);
    let _real_id =
        publisher::publish_generation(data_root.path(), city, &tiny_ptb_path(), &created);

    let result = pt_serve::bundle::load_initial_generation_with_force(
        data_root.path(),
        city,
        &clock,
        &metrics,
        Some("00000000000000000000000000000000bogus0000000000000000000000000000"),
        LogFormat::Json,
        None,
        pt_core::PatternMode::Off,
    );
    let err = match result {
        Ok(_) => panic!("forced-current with non-existent id must fail-closed"),
        Err(e) => e,
    };
    match err {
        pt_serve::bundle::loader::LoadError::Validation(ValidationError::Io(io_err)) => {
            assert_eq!(io_err.kind, std::io::ErrorKind::NotFound);
        }
        other => panic!("expected Validation(Io(NotFound)); got {other:?}"),
    }
    assert!(
        !metrics.forced_current_mode_active(),
        "sticky flag must NOT flip on a failed forced adoption"
    );
}

/// City-slug cross-check still fires under forced mode. The operator's
/// `--city-slug=X` plus `--force-current=<id-for-city-Y>` MUST be rejected
/// — serving Y's data under X's slug is exactly the wrong-PVC class of
/// outage the sentinel + cross-checks exist to prevent.
#[test]
fn force_current_wrong_city_returns_wrong_city() {
    let clock = MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(1779494400));
    let data_root = tempfile::tempdir().expect("tempdir");
    let metrics = Metrics::new();

    // Publish under city "kaunas"...
    let created = publisher::rfc3339_format(1779494400);
    let id = publisher::publish_generation(data_root.path(), "kaunas", &tiny_ptb_path(), &created);

    // ...then attempt to force-adopt it under "vilnius".
    let result = pt_serve::bundle::load_initial_generation_with_force(
        data_root.path(),
        "vilnius",
        &clock,
        &metrics,
        Some(&id),
        LogFormat::Json,
        None,
        pt_core::PatternMode::Off,
    );
    let err = match result {
        Ok(_) => panic!("forced-current with wrong city must fail-closed"),
        Err(e) => e,
    };
    match err {
        pt_serve::bundle::loader::LoadError::Validation(ValidationError::Operator(
            OperatorError::WrongCity { expected, found },
        )) => {
            assert_eq!(expected, "vilnius");
            assert_eq!(found, "kaunas");
        }
        other => panic!("expected Validation(Operator(WrongCity)); got {other:?}"),
    }
    assert!(
        !metrics.forced_current_mode_active(),
        "sticky flag must NOT flip on a city-mismatched forced adoption"
    );
}

/// Bundle-size cross-check still fires under forced mode. Publish a normal
/// gen, then truncate `bundle.ptb` on disk so its size no longer matches
/// `manifest.bundle_size_bytes`. Forced-adopting that gen MUST surface a
/// `BundleSizeMismatch` from the load-time metadata check, NOT a silent
/// adopt of corrupted bytes.
#[test]
fn force_current_in_place_bundle_truncation_returns_size_mismatch() {
    let clock = MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(1779494400));
    let data_root = tempfile::tempdir().expect("tempdir");
    let metrics = Metrics::new();
    let city = "vilnius";

    let created = publisher::rfc3339_format(1779494400);
    let id = publisher::publish_generation(data_root.path(), city, &tiny_ptb_path(), &created);

    // Truncate bundle.ptb in place; manifest is untouched so it now lies
    // about the on-disk size.
    let bundle_path = data_root
        .path()
        .join("generations")
        .join(&id)
        .join("bundle.ptb");
    let original = std::fs::metadata(&bundle_path).unwrap().len();
    let truncated = original / 2;
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(&bundle_path)
        .unwrap();
    file.set_len(truncated).unwrap();

    let result = pt_serve::bundle::load_initial_generation_with_force(
        data_root.path(),
        city,
        &clock,
        &metrics,
        Some(&id),
        LogFormat::Json,
        None,
        pt_core::PatternMode::Off,
    );
    let err = match result {
        Ok(_) => panic!("forced-current with truncated bundle must fail-closed"),
        Err(e) => e,
    };
    match err {
        pt_serve::bundle::loader::LoadError::Validation(ValidationError::Producer(
            ProducerError::BundleSizeMismatch { expected, actual },
        )) => {
            assert_eq!(expected, original);
            assert_eq!(actual, truncated);
        }
        other => panic!("expected Validation(Producer(BundleSizeMismatch)); got {other:?}"),
    }
    assert!(
        !metrics.forced_current_mode_active(),
        "sticky flag must NOT flip on a truncated-bundle forced adoption"
    );
}
