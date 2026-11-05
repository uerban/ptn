//! Engine-class reload failure (Stage 3).
//!
//! When the candidate bundle passes structural validation but
//! [`pt_core::Index::build`] rejects it (e.g. a trip pointing at a
//! `service_idx` that exceeds `num_services`), the reload runner MUST surface the
//! failure as `ValidationError::Engine` and label
//! `reload_total{result="failed",cause="engine"}` accordingly. Operators
//! alert differently on Engine-class failures (the producer emitted
//! internally-inconsistent records) vs Structural-class (the wire format
//! itself is broken).
//!
//! ## Fixture: hand-mutated tiny.ptb
//!
//! We hand-mutate `tiny.ptb` so trip 0's `service_idx` equals `num_services`
//! (out of bounds). The structural validator re-uses `Reader::from_bytes`,
//! which checks region bounds and table shape but NOT per-record validity —
//! so the bytes ROUND-TRIP through structural cleanly. `Index::build`,
//! however, reads each trip's service and rejects `service_idx >=
//! num_services`. (An out-of-range pattern stop ordinal is caught earlier, by
//! structural validation of the pattern band.)
//!
//! See `tests/fixtures/README.md` for the wider rationale.

#[path = "common/mod.rs"]
mod common;

use common::publisher;
use pt_serve::ops::metrics::{ReloadCause, ReloadResult};
use pt_serve::{Metrics, ReloadRunner};
use pt_shared::clock::{Clock, MockClock};
use pt_shared::validate::errors::ValidationError;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

/// Hand-mutate the bundle so trip 0's `service_idx` equals `num_services`
/// (out of bounds), leaving every region in bounds.
///
/// Layout knowledge encoded here (current PTB v1):
/// - PTB header has `num_services` at byte offset [24..28].
/// - The tagged region table starts at byte offset 32; each entry is 24 bytes
///   (`regionId u16 @+0`, `offset u64 @+8`, `length u64 @+16`), terminated by
///   regionId 0.
/// - `0xF2 TripsIntern` holds one 24-byte record per trip with
///   `service_idx u32 @+12`.
fn mutate_service_idx_to_out_of_bounds(bytes: &[u8]) -> Vec<u8> {
    const TRIPS_INTERN: u16 = 0xF2;
    let mut out = bytes.to_vec();
    let num_services = u32::from_le_bytes(out[24..28].try_into().unwrap());
    let mut entry = 32;
    let trips_offset = loop {
        let id = u16::from_le_bytes(out[entry..entry + 2].try_into().unwrap());
        assert_ne!(id, 0, "fixture has no 0xF2 TripsIntern region");
        if id == TRIPS_INTERN {
            break u64::from_le_bytes(out[entry + 8..entry + 16].try_into().unwrap()) as usize;
        }
        entry += 24;
    };
    out[trips_offset + 12..trips_offset + 16].copy_from_slice(&num_services.to_le_bytes());
    out
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Publish a generation directory whose bundle bytes are the mutated
/// (Engine-class-broken) buffer. Returns the on-disk generation id.
fn publish_corrupt_generation(data_root: &Path, city: &str, created_at: &str) -> String {
    let original = fs::read(tiny_ptb_path()).expect("read tiny.ptb");
    let bytes = mutate_service_idx_to_out_of_bounds(&original);
    // generationId is the SHA-256 of the bundle bytes (manifest grammar).
    let bundle_sha = sha256_hex(&bytes);
    let id = pt_shared::manifest::publication_id(&bundle_sha, &"0".repeat(64));
    let gen_dir = data_root.join("generations").join(&id);
    fs::create_dir_all(&gen_dir).expect("create gen dir");
    fs::write(gen_dir.join("bundle.ptb"), &bytes).expect("write bundle");
    let feed_start = publisher::feed_start_date_of(&bytes);
    let manifest = serde_json::json!({
        "manifestSchemaVersion": 2,
        "generationId": id,
        "citySlug": city,
        "bundleSha256": bundle_sha,
        "publicationInputsSha256": "0".repeat(64),
        "bundleSizeBytes": bytes.len() as u64,
        "feedStartDate": feed_start,
        "hasTransfers": false,
        "transfersSha256": null,
        "transfersSizeBytes": null,
        "createdAt": created_at,
    });
    fs::write(
        gen_dir.join("generation.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let pointer = serde_json::json!({
        "manifestSchemaVersion": 2,
        "generationId": id,
        "citySlug": city,
        "createdAt": created_at,
    });
    fs::write(
        data_root.join("current.json"),
        serde_json::to_string_pretty(&pointer).unwrap(),
    )
    .unwrap();
    id
}

fn boot_with_tiny(city: &str) -> (Arc<ReloadRunner>, Arc<Metrics>, tempfile::TempDir, String) {
    let data_root = tempfile::tempdir().expect("tempdir");
    let clock_mock = Arc::new(MockClock::new(
        SystemTime::UNIX_EPOCH + Duration::from_secs(1779494400),
    ));
    let clock: Arc<dyn Clock> = clock_mock.clone();
    let metrics = Metrics::new();
    let created_at = publisher::rfc3339_format(1779494400);
    let id = publisher::publish_generation(data_root.path(), city, &tiny_ptb_path(), &created_at);
    let manifest_text =
        fs::read_to_string(publisher::manifest_path_for(data_root.path(), &id)).unwrap();
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
    metrics.record_generation_adopted(&initial.generation_id, 1779494400);
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
    (runner, metrics, data_root, id)
}

#[test]
fn corrupt_service_idx_routes_to_engine_class() {
    let (runner, metrics, data_root, _initial_id) = boot_with_tiny("vilnius");

    // Publish a generation whose bundle is the hand-mutated tiny.ptb. The
    // bytes round-trip through structural cleanly; `Index::build` rejects
    // them with `EngineError::Corrupt`.
    let created_at = publisher::rfc3339_format(1779494410);
    let _id = publish_corrupt_generation(data_root.path(), "vilnius", &created_at);

    let outcome = runner.trigger_reload();
    assert!(outcome.is_failed(), "reload should fail; got {outcome:?}");
    match outcome {
        pt_serve::ReloadOutcome::Failed(ValidationError::Engine(e)) => {
            assert!(
                e.reason.contains("service_idx"),
                "engine error should mention the corrupt service_idx; got {}",
                e.reason
            );
        }
        other => panic!("expected Engine class; got {other:?}"),
    }
    assert_eq!(
        metrics.reload_total(ReloadResult::Failed, ReloadCause::Engine),
        1,
        "reload_total{{result=failed,cause=engine}} increments"
    );
    assert_eq!(metrics.reload_consecutive_failures(), 1);

    // Sanity: the structural cause counter is NOT incremented — the bytes
    // pass structural validation; only Index::build refuses them.
    assert_eq!(
        metrics.reload_total(ReloadResult::Failed, ReloadCause::Structural),
        0,
        "structural cause is NOT incremented on engine-class failure"
    );
}
