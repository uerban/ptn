//! Metadata-validator coverage — one test per ProducerError / OperatorError variant. Plus the
//! cause_label / is_fatal contract checks.
//!
//! Strategy: build a baseline-valid generation manifest + matching bundle
//! bytes, then perturb ONE field per test and assert the EXACT
//! [`ValidationError`] variant. The baseline-clean assertion at the top
//! guards against an accidentally-failing baseline (which would mask every
//! per-variant test below).

use pt_shared::clock::{Clock, MockClock};
use pt_shared::manifest::GenerationManifest;
use pt_shared::validate::errors::{OperatorError, ProducerError, ValidationError};
use pt_shared::validate::metadata::{validate_metadata, validate_metadata_with_clock};
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime};

/// Lowercase-hex SHA-256, mirrors the producer's encoding and the
/// validator's internal helper.
fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest.iter() {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Baseline-valid 4 KiB bundle + matching manifest. The exact bytes don't
/// matter for metadata validation (the structural validator owns that); the
/// hash and size do.
fn baseline_bundle() -> Vec<u8> {
    let mut v = vec![0u8; 4096];
    v[0..4].copy_from_slice(b"PTB\0");
    v[4..6].copy_from_slice(&1u16.to_le_bytes());
    v
}

/// Baseline-valid manifest for the baseline bundle.
fn baseline_manifest(bundle: &[u8]) -> GenerationManifest {
    let sha = sha256_hex(bundle);
    GenerationManifest {
        manifest_schema_version: 2,
        generation_id: pt_shared::manifest::publication_id(&sha, &"0".repeat(64)),
        publication_inputs_sha256: "0".repeat(64),
        city_slug: "vilnius".to_string(),
        bundle_sha256: sha,
        bundle_size_bytes: bundle.len() as u64,
        feed_start_date: 20260501,
        has_transfers: false,
        transfers_sha256: None,
        transfers_size_bytes: None,
        created_at: "2026-05-23T10:00:00Z".to_string(),
        departures_idx_sha256: None,
        shapes_bin_sha256: None,
        color_config_sha256: None,
        route_styles_sha256: None,
        label_anchors_sha256: None,
        shapes_json_sha256: None,
        shapes_json_size_bytes: None,
        city_tz_iana: None,
        window_days: None,
        window_clamped_high: false,
        window_floored_low: false,
        service_bitfield_pool_count: None,
        num_services: None,
        schedule_tile_bundle_sha256: None,
        schedule_tile_bundle_hash: None,
        trip_route_sha256: None,
        stop_cell_sha256: None,
    }
}

/// A `now` that's well past the baseline manifest's `created_at` so the
/// skew check always passes in the baseline.
fn baseline_now() -> SystemTime {
    // 2026-06-01T00:00:00Z — comfortably past 2026-05-23.
    SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_704_000)
}

// ---------------------------------------------------------------------------
// Baseline-clean
// ---------------------------------------------------------------------------

#[test]
fn baseline_is_clean() {
    let bundle = baseline_bundle();
    let manifest = baseline_manifest(&bundle);
    validate_metadata(
        &manifest,
        &bundle,
        None,
        "vilnius",
        20260501,
        baseline_now(),
        true,
    )
    .expect("baseline must validate clean");
}

// ---------------------------------------------------------------------------
// OperatorError — 3 variants
// ---------------------------------------------------------------------------

#[test]
fn wrong_city_is_classified() {
    let bundle = baseline_bundle();
    let manifest = baseline_manifest(&bundle);
    let err = validate_metadata(
        &manifest,
        &bundle,
        None,
        "kaunas",
        20260501,
        baseline_now(),
        true,
    )
    .unwrap_err();
    match err {
        ValidationError::Operator(OperatorError::WrongCity { expected, found }) => {
            assert_eq!(expected, "kaunas");
            assert_eq!(found, "vilnius");
        }
        other => panic!("expected WrongCity, got {other:?}"),
    }
    assert!(!ValidationError::Operator(OperatorError::WrongCity {
        expected: "a".into(),
        found: "b".into(),
    })
    .is_fatal());
}

#[test]
fn unsupported_manifest_schema_version_is_fatal() {
    let bundle = baseline_bundle();
    let mut manifest = baseline_manifest(&bundle);
    manifest.manifest_schema_version = 99;
    let err = validate_metadata(
        &manifest,
        &bundle,
        None,
        "vilnius",
        20260501,
        baseline_now(),
        true,
    )
    .unwrap_err();
    match &err {
        ValidationError::Operator(OperatorError::UnsupportedManifestSchemaVersion(v)) => {
            assert_eq!(*v, 99);
        }
        other => panic!("expected UnsupportedManifestSchemaVersion, got {other:?}"),
    }
    // The ONE fatal class — caller must exit non-zero.
    assert!(err.is_fatal(), "schema version must be fatal");
    assert_eq!(err.cause_label(), "operator");
}

#[test]
fn missing_transfers_file_is_classified() {
    let bundle = baseline_bundle();
    let mut manifest = baseline_manifest(&bundle);
    manifest.has_transfers = true;
    manifest.transfers_sha256 = Some("0".repeat(64));
    manifest.transfers_size_bytes = Some(128);
    let err = validate_metadata(
        &manifest,
        &bundle,
        None, // file absent on disk
        "vilnius",
        20260501,
        baseline_now(),
        true,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        ValidationError::Operator(OperatorError::MissingTransfersFile)
    ));
    assert!(!err.is_fatal());
}

// ---------------------------------------------------------------------------
// ProducerError — 9 variants (8 + the new CreatedAtMalformed)
// ---------------------------------------------------------------------------

#[test]
fn generation_id_hash_mismatch_is_classified() {
    let bundle = baseline_bundle();
    let mut manifest = baseline_manifest(&bundle);
    // generation_id intentionally != hex(bundle_sha256). Keep bundle_sha256
    // correct so this is specifically the grammar invariant.
    manifest.generation_id = "deadbeef".repeat(8);
    let err = validate_metadata(
        &manifest,
        &bundle,
        None,
        "vilnius",
        20260501,
        baseline_now(),
        true,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        ValidationError::Producer(ProducerError::GenerationIdHashMismatch)
    ));
    assert_eq!(err.cause_label(), "producer");
}

#[test]
fn bundle_hash_mismatch_is_classified() {
    let bundle = baseline_bundle();
    let mut manifest = baseline_manifest(&bundle);
    // Both fields claim the same wrong hash so the BundleHashMismatch fires
    // before GenerationIdHashMismatch (the size precheck is still clean).
    let wrong = "ff".repeat(32);
    manifest.bundle_sha256 = wrong.clone();
    manifest.generation_id = wrong;
    let err = validate_metadata(
        &manifest,
        &bundle,
        None,
        "vilnius",
        20260501,
        baseline_now(),
        true,
    )
    .unwrap_err();
    match err {
        ValidationError::Producer(ProducerError::BundleHashMismatch { computed, .. }) => {
            assert_eq!(computed, sha256_hex(&bundle));
        }
        other => panic!("expected BundleHashMismatch, got {other:?}"),
    }
}

#[test]
fn bundle_size_mismatch_is_classified() {
    let bundle = baseline_bundle();
    let mut manifest = baseline_manifest(&bundle);
    manifest.bundle_size_bytes = bundle.len() as u64 + 1;
    let err = validate_metadata(
        &manifest,
        &bundle,
        None,
        "vilnius",
        20260501,
        baseline_now(),
        true,
    )
    .unwrap_err();
    match err {
        ValidationError::Producer(ProducerError::BundleSizeMismatch { expected, actual }) => {
            assert_eq!(expected, (bundle.len() as u64) + 1);
            assert_eq!(actual, bundle.len() as u64);
        }
        other => panic!("expected BundleSizeMismatch, got {other:?}"),
    }
}

#[test]
fn transfers_hash_mismatch_is_classified() {
    let bundle = baseline_bundle();
    let transfers = vec![0u8; 64];
    let mut manifest = baseline_manifest(&bundle);
    manifest.has_transfers = true;
    // Size matches, hash doesn't.
    manifest.transfers_size_bytes = Some(transfers.len() as u64);
    manifest.transfers_sha256 = Some("ff".repeat(32));
    let err = validate_metadata(
        &manifest,
        &bundle,
        Some(&transfers),
        "vilnius",
        20260501,
        baseline_now(),
        true,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        ValidationError::Producer(ProducerError::TransfersHashMismatch { .. })
    ));
}

#[test]
fn transfers_size_mismatch_is_classified() {
    let bundle = baseline_bundle();
    let transfers = vec![0u8; 64];
    let mut manifest = baseline_manifest(&bundle);
    manifest.has_transfers = true;
    manifest.transfers_size_bytes = Some(128); // size disagreement
    manifest.transfers_sha256 = Some(sha256_hex(&transfers));
    let err = validate_metadata(
        &manifest,
        &bundle,
        Some(&transfers),
        "vilnius",
        20260501,
        baseline_now(),
        true,
    )
    .unwrap_err();
    match err {
        ValidationError::Producer(ProducerError::TransfersSizeMismatch { expected, actual }) => {
            assert_eq!(expected, 128);
            assert_eq!(actual, 64);
        }
        other => panic!("expected TransfersSizeMismatch, got {other:?}"),
    }
}

#[test]
fn stale_transfers_carryover_is_classified() {
    let bundle = baseline_bundle();
    let transfers = vec![0u8; 32];
    let manifest = baseline_manifest(&bundle); // has_transfers=false
    let err = validate_metadata(
        &manifest,
        &bundle,
        Some(&transfers), // present despite has_transfers=false
        "vilnius",
        20260501,
        baseline_now(),
        true,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        ValidationError::Producer(ProducerError::StaleTransfersCarryover)
    ));
}

#[test]
fn created_at_clock_skew_is_classified_with_mock_clock() {
    let bundle = baseline_bundle();
    // Manifest says the FAR future.
    let mut manifest = baseline_manifest(&bundle);
    manifest.created_at = "2099-01-01T00:00:00Z".to_string();
    // MockClock at a deterministic instant well before the manifest's
    // claimed createdAt → the +tolerance can't catch up → skew fires.
    let clock = MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_000_000));
    let err = validate_metadata_with_clock(
        &manifest,
        &bundle,
        None,
        "vilnius",
        20260501,
        &clock as &dyn Clock,
        true,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        ValidationError::Producer(ProducerError::CreatedAtClockSkew { .. })
    ));
}

#[test]
fn skew_tolerance_is_wider_at_startup_than_reload() {
    let bundle = baseline_bundle();
    let mut manifest = baseline_manifest(&bundle);
    // Manifest claims now+120s; tolerance is 300s on startup, 60s on
    // reload. Startup MUST accept; reload MUST reject.
    let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_000_000);
    let manifest_t = now + Duration::from_secs(120);
    let secs = manifest_t
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;
    manifest.created_at = format!("{y:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}Z");

    // Startup: tolerated.
    assert!(validate_metadata(&manifest, &bundle, None, "vilnius", 20260501, now, true).is_ok());
    // Reload: rejected.
    assert!(matches!(
        validate_metadata(&manifest, &bundle, None, "vilnius", 20260501, now, false).unwrap_err(),
        ValidationError::Producer(ProducerError::CreatedAtClockSkew { .. })
    ));
}

#[test]
fn feed_start_date_mismatch_is_classified() {
    let bundle = baseline_bundle();
    let manifest = baseline_manifest(&bundle); // manifest.feed_start_date = 20260501
    let err = validate_metadata(
        &manifest,
        &bundle,
        None,
        "vilnius",
        20260601, // bundle disagrees
        baseline_now(),
        true,
    )
    .unwrap_err();
    match err {
        ValidationError::Producer(ProducerError::FeedStartDateMismatch { manifest, bundle }) => {
            assert_eq!(manifest, 20260501);
            assert_eq!(bundle, 20260601);
        }
        other => panic!("expected FeedStartDateMismatch, got {other:?}"),
    }
}

#[test]
fn created_at_malformed_is_classified() {
    let bundle = baseline_bundle();
    let mut manifest = baseline_manifest(&bundle);
    manifest.created_at = "this is not rfc3339".to_string();
    let err = validate_metadata(
        &manifest,
        &bundle,
        None,
        "vilnius",
        20260501,
        baseline_now(),
        true,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        ValidationError::Producer(ProducerError::CreatedAtMalformed(_))
    ));
}

// ---------------------------------------------------------------------------
// cause_label / is_fatal contract
// ---------------------------------------------------------------------------

#[test]
fn cause_label_covers_all_five_classes() {
    use pt_core::validate::errors::StructuralError;
    use pt_shared::validate::errors::{EngineBuildError, IoErr};

    let producer: ValidationError = ProducerError::GenerationIdHashMismatch.into();
    assert_eq!(producer.cause_label(), "producer");
    assert!(!producer.is_fatal());

    let structural: ValidationError = StructuralError::WrongMagic.into();
    assert_eq!(structural.cause_label(), "structural");
    assert!(!structural.is_fatal());

    let operator: ValidationError = OperatorError::MissingTransfersFile.into();
    assert_eq!(operator.cause_label(), "operator");
    assert!(!operator.is_fatal());

    let engine: ValidationError = EngineBuildError {
        reason: "x".to_string(),
    }
    .into();
    assert_eq!(engine.cause_label(), "engine");
    assert!(!engine.is_fatal());

    let io: ValidationError = ValidationError::Io(IoErr {
        kind: std::io::ErrorKind::NotFound,
        msg: "x".to_string(),
    });
    assert_eq!(io.cause_label(), "io");
    assert!(!io.is_fatal());
}

#[test]
fn is_fatal_only_for_unsupported_schema_version() {
    // Spot-check the negative: every variant we tested is non-fatal except
    // the one that should be.
    assert!(
        ValidationError::Operator(OperatorError::UnsupportedManifestSchemaVersion(99)).is_fatal()
    );
    assert!(!ValidationError::Operator(OperatorError::WrongCity {
        expected: "a".into(),
        found: "b".into()
    })
    .is_fatal());
    assert!(!ValidationError::Operator(OperatorError::MissingTransfersFile).is_fatal());
}

// ---------------------------------------------------------------------------
// Local civil_from_days copy (used only by the skew-tolerance test to format
// the moving manifest timestamp; intentional duplication of the pt-shared
// private helper so this integration test isn't coupled to the helper's
// privacy).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Schema 1 — generations written before the publication id
// ---------------------------------------------------------------------------

/// A schema-1 `generation.json` as the pre-publication-id producer wrote it:
/// no `publicationInputsSha256`, and `generationId` is the PTB hash.
fn schema_1_manifest(bundle: &[u8], generation_id: &str) -> GenerationManifest {
    serde_json::from_value(serde_json::json!({
        "manifestSchemaVersion": 1,
        "generationId": generation_id,
        "citySlug": "vilnius",
        "bundleSha256": sha256_hex(bundle),
        "bundleSizeBytes": bundle.len(),
        "feedStartDate": 20260501,
        "hasTransfers": false,
        "transfersSha256": null,
        "transfersSizeBytes": null,
        "createdAt": "2026-05-23T10:00:00Z",
    }))
    .expect("schema-1 manifest must parse")
}

#[test]
fn schema_1_generation_still_validates() {
    let bundle = baseline_bundle();
    let manifest = schema_1_manifest(&bundle, &sha256_hex(&bundle));
    validate_metadata(
        &manifest,
        &bundle,
        None,
        "vilnius",
        20260501,
        baseline_now(),
        true,
    )
    .expect("an upgraded reader must keep serving schema-1 generations");
}

#[test]
fn schema_1_generation_id_must_be_the_bundle_hash() {
    let bundle = baseline_bundle();
    let manifest = schema_1_manifest(&bundle, &"deadbeef".repeat(8));
    let err = validate_metadata(
        &manifest,
        &bundle,
        None,
        "vilnius",
        20260501,
        baseline_now(),
        true,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        ValidationError::Producer(ProducerError::GenerationIdHashMismatch)
    ));
}
