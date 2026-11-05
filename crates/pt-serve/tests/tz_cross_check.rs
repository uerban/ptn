//! T13 city-tz cross-check coverage (review gap: the MISMATCH paths had zero
//! tests, which is how the original IANA-vs-slug resolution bug shipped).
//!
//! `build_generation` cross-checks the PTB header's `cityTzOffsetSeconds`
//! against the bundled tzdb's computed offset for the resolved IANA name at
//! `feedStartDate`. The committed `tiny.ptb` has `feedStartDate =
//! 20260501` and `cityTzOffsetSeconds = 10800` (Europe/Vilnius EEST). The
//! publisher writes no `cityTzIana`, so the resolved IANA comes from the
//! operator's `--city-tz-iana-default` — letting each test drive one branch.

#[path = "common/mod.rs"]
mod common;

use common::publisher;
use pt_serve::Metrics;
use pt_shared::clock::{Clock, MockClock};
use pt_shared::manifest::GenerationManifest;
use pt_shared::validate::errors::{OperatorError, ProducerError, ValidationError};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

/// The committed current-v1 `window400.ptb` (official producer output):
/// `feedStartDate = 20260619`, `cityTzOffsetSeconds = 7200`.
fn window400_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/window400.ptb")
}

/// Publish `tiny.ptb` into a fresh data root and invoke `build_generation`
/// with the given `--city-tz-iana-default`. Returns the build result so each
/// test can assert Ok or the exact ValidationError class.
fn build_with_tz_default(iana_default: Option<&str>) -> Result<(), ValidationError> {
    build_bundle_with_tz_default(&tiny_ptb_path(), 1779494400, iana_default).map(|_| ())
}

/// Publish `ptb` into a fresh data root at `now_secs` and invoke
/// `build_generation`, returning the resolved `cityTzIana` on success.
fn build_bundle_with_tz_default(
    ptb: &Path,
    now_secs: u64,
    iana_default: Option<&str>,
) -> Result<String, ValidationError> {
    let clock = Arc::new(MockClock::new(
        SystemTime::UNIX_EPOCH + Duration::from_secs(now_secs),
    ));
    let data_root = tempfile::tempdir().expect("tempdir");
    let created_at = publisher::rfc3339_format(now_secs);
    let id = publisher::publish_generation(data_root.path(), "vilnius", ptb, &created_at);
    let manifest_text =
        std::fs::read_to_string(publisher::manifest_path_for(data_root.path(), &id)).unwrap();
    let manifest: GenerationManifest = serde_json::from_str(&manifest_text).unwrap();
    let metrics = Metrics::new();
    let clock_dyn: Arc<dyn Clock> = clock.clone();
    let bundle_path: &Path = &publisher::bundle_path_for(data_root.path(), &id);
    pt_serve::bundle::build_generation(pt_serve::bundle::BuildInputs {
        manifest: &manifest,
        bundle_path,
        transfers_path: None,
        expected_city: "vilnius",
        clock: clock_dyn.as_ref(),
        is_startup: true,
        epoch: 0,
        metrics: Some(Arc::clone(&metrics)),
        city_tz_iana_default: iana_default,
        pattern_mode: pt_core::PatternMode::Off,
    })
    .map(|generation| generation.city_tz_iana.clone())
}

#[test]
fn matching_iana_passes() {
    // Europe/Vilnius at 20260501 = EEST = +10800 = the bundle's baked offset.
    assert!(build_with_tz_default(Some("Europe/Vilnius")).is_ok());
}

#[test]
fn offset_mismatch_is_producer_error() {
    // Europe/Paris at 20260501 = CEST = +7200, but the bundle baked +10800
    // (Vilnius). The cross-check must reject with TzOffsetMismatch.
    let err = build_with_tz_default(Some("Europe/Paris")).unwrap_err();
    match err {
        ValidationError::Producer(ProducerError::TzOffsetMismatch {
            found_secs,
            expected_secs,
            ..
        }) => {
            assert_eq!(found_secs, 10800, "bundle baked Vilnius EEST");
            assert_eq!(expected_secs, 7200, "Paris CEST at 20260501");
        }
        other => panic!("expected TzOffsetMismatch, got {other:?}"),
    }
}

#[test]
fn unknown_iana_is_producer_error() {
    let err = build_with_tz_default(Some("Bogus/Nowhere")).unwrap_err();
    match err {
        ValidationError::Producer(ProducerError::UnknownIana { iana }) => {
            assert_eq!(iana, "Bogus/Nowhere");
        }
        other => panic!("expected UnknownIana, got {other:?}"),
    }
}

#[test]
fn missing_iana_and_no_default_is_operator_error() {
    // Bundle + manifest with no cityTzIana + no --city-tz-iana-default →
    // fail closed with the fix-by-config OperatorError.
    let err = build_with_tz_default(None).unwrap_err();
    match err {
        ValidationError::Operator(OperatorError::TzIanaUnresolved { city }) => {
            assert_eq!(city, "vilnius");
        }
        other => panic!("expected TzIanaUnresolved, got {other:?}"),
    }
}

// Every bundle carries the header tz offset, so the cross-check always runs
// (it once sat behind a numeric `version >= 5` gate that skipped version 1).
// 2026-06-20 00:00 UTC keeps `window400.ptb`'s feed start fresh.
const WINDOW400_NOW_SECS: u64 = 1781913600;

#[test]
fn current_v1_bundle_matching_iana_resolves_the_zone() {
    // Europe/Paris at 20260619 = CEST = +7200 = the bundle's baked offset.
    let iana = build_bundle_with_tz_default(
        &window400_ptb_path(),
        WINDOW400_NOW_SECS,
        Some("Europe/Paris"),
    )
    .expect("matching IANA loads");
    assert_eq!(iana, "Europe/Paris");
}

#[test]
fn current_v1_bundle_offset_mismatch_is_producer_error() {
    // Europe/Vilnius at 20260619 = EEST = +10800, but the bundle baked +7200.
    let err = build_bundle_with_tz_default(
        &window400_ptb_path(),
        WINDOW400_NOW_SECS,
        Some("Europe/Vilnius"),
    )
    .unwrap_err();
    match err {
        ValidationError::Producer(ProducerError::TzOffsetMismatch {
            found_secs,
            expected_secs,
            ..
        }) => {
            assert_eq!(found_secs, 7200, "bundle baked CEST");
            assert_eq!(expected_secs, 10800, "Vilnius EEST at 20260619");
        }
        other => panic!("expected TzOffsetMismatch, got {other:?}"),
    }
}

#[test]
fn current_v1_bundle_missing_iana_is_operator_error() {
    let err =
        build_bundle_with_tz_default(&window400_ptb_path(), WINDOW400_NOW_SECS, None).unwrap_err();
    match err {
        ValidationError::Operator(OperatorError::TzIanaUnresolved { city }) => {
            assert_eq!(city, "vilnius");
        }
        other => panic!("expected TzIanaUnresolved, got {other:?}"),
    }
}
