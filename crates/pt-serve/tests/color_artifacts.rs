//! Stage-C color-provenance: pt-serve loads the per-generation color artifacts
//! (`color-config.json`, `route-styles.json`) and lazily serializes the
//! canonical shapes JSON from `shapes.bin`.
//!
//! These tests drive the production `build_generation` path (the manifest is
//! present, so the full-file SHA integrity checks run). They assert:
//!   1. a gen dir WITH all three artifacts loads — `color_config`/`route_styles`
//!      are `Some`, and `shapes_json_bytes()` parses as `{"shapes":[...]}`. The
//!      lazy shapes JSON `OnceLock` hands back the SAME `Arc` on a repeat call.
//!   2. a gen dir WITHOUT the artifacts loads fine — all `None`, no panic.
//!   3. a present-but-corrupt `shapes.bin` is a hard `ValidationError` at LOAD
//!      (never a panic, never a silent `None`).
//!   4. a `shapes.bin` whose on-disk full-file SHA disagrees with the manifest
//!      is a hard `ValidationError` at LOAD.
//!   5. a `color-config.json` whose on-disk full-file SHA disagrees with the
//!      manifest is a hard `ValidationError` at LOAD (the JSON integrity check).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

#[path = "common/mod.rs"]
mod common;

use common::publisher::{self, SidecarArtifacts};
use pt_serve::bundle::{build_generation, BuildInputs};
use pt_serve::{Generation, Metrics};
use pt_shared::clock::{Clock, MockClock};
use pt_shared::manifest::GenerationManifest;
use pt_shared::validate::errors::ValidationError;

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

// A clock anchored well after the fixture's feed_start_date so the metadata
// validator's createdAt skew tolerance accepts the manifest timestamp.
const ANCHOR_UNIX: u64 = 1779494400;

fn anchored_clock() -> Arc<MockClock> {
    Arc::new(MockClock::new(
        SystemTime::UNIX_EPOCH + Duration::from_secs(ANCHOR_UNIX),
    ))
}

/// Build a `Generation` from a freshly-published data_root via the production
/// `build_generation` path (manifest present → full SHA check runs).
fn build_from_published(
    data_root: &std::path::Path,
    city: &str,
    id: &str,
    clock: &dyn Clock,
) -> Result<Generation, ValidationError> {
    let manifest_text =
        std::fs::read_to_string(publisher::manifest_path_for(data_root, id)).unwrap();
    let manifest: GenerationManifest = serde_json::from_str(&manifest_text).unwrap();
    build_generation(BuildInputs {
        manifest: &manifest,
        bundle_path: &publisher::bundle_path_for(data_root, id),
        transfers_path: None,
        expected_city: city,
        clock,
        is_startup: true,
        epoch: 0,
        metrics: Some(Metrics::new()),
        city_tz_iana_default: Some("Europe/Vilnius"),
        pattern_mode: pt_core::PatternMode::Off,
    })
}

#[test]
fn loads_all_three_artifacts_and_serializes_shapes_json() {
    let data_root = tempfile::TempDir::new().expect("tempdir");
    let clock = anchored_clock();
    let created_at = publisher::rfc3339_format(ANCHOR_UNIX);

    let artifacts = SidecarArtifacts {
        color_config: Some(br#"{"colors":{"R1":"FF0000"}}"#.to_vec()),
        route_styles: Some(
            br#"{"R1":{"color":"FF0000","textColor":"FFFFFF","subMode":"bus"}}"#.to_vec(),
        ),
        shapes_bin: Some(publisher::encode_test_shapes_bin(&tiny_ptb_path())),
        departures_idx: None,
        label_anchors: Some(br#"{"anchors":[]}"#.to_vec()),
        address_search: None,
    };
    let id = publisher::publish_generation_with_artifacts(
        data_root.path(),
        "vilnius",
        &tiny_ptb_path(),
        &created_at,
        &artifacts,
    );

    let gen = build_from_published(data_root.path(), "vilnius", &id, clock.as_ref())
        .expect("generation with all three artifacts loads");

    assert!(
        gen.color_config.is_some(),
        "color-config.json should be loaded"
    );
    assert!(
        gen.route_styles.is_some(),
        "route-styles.json should be loaded"
    );
    assert!(
        gen.label_anchors.is_some(),
        "label-anchors.json should be loaded"
    );
    assert_eq!(
        gen.label_anchors.as_deref().unwrap(),
        artifacts.label_anchors.as_deref().unwrap(),
        "label-anchors bytes must be served verbatim"
    );
    assert_eq!(
        gen.color_config.as_deref().unwrap(),
        artifacts.color_config.as_deref().unwrap(),
        "color-config bytes must be served verbatim"
    );
    assert_eq!(
        gen.route_styles.as_deref().unwrap(),
        artifacts.route_styles.as_deref().unwrap(),
        "route-styles bytes must be served verbatim"
    );

    // Lazy shapes JSON parses as the canonical {"shapes":[...]} shape, non-empty
    // (the two test shapes are non-orphan, trip_ref_count >= 1).
    let json = gen.shapes_json_bytes().expect("shapes_json present");
    let v: serde_json::Value = serde_json::from_slice(&json).expect("shapes JSON parses");
    let arr = v["shapes"].as_array().expect("shapes is an array");
    assert_eq!(arr.len(), 2, "both non-orphan shapes serialized");
    assert_eq!(arr[0]["shapeId"], "SH_A");
    assert_eq!(arr[0]["source"], "gtfs");
    assert!(!arr[0]["encodedPolyline"].as_str().unwrap().is_empty());

    // Second call hits the OnceLock cache and returns identical bytes.
    let json2 = gen
        .shapes_json_bytes()
        .expect("shapes_json present (cached)");
    assert_eq!(&*json, &*json2, "lazy cache returns identical bytes");
    // Pin the caching mechanism, not just idempotent output: the OnceLock must
    // hand back the SAME Arc on a repeat call (no re-serialization).
    assert!(
        Arc::ptr_eq(&json, &json2),
        "OnceLock must cache — same Arc on repeat call"
    );

    assert!(
        gen.shapes_json_sha256.is_some(),
        "shapes_json_sha256 threaded from manifest"
    );
}

#[test]
fn loads_fine_without_any_artifacts() {
    let data_root = tempfile::TempDir::new().expect("tempdir");
    let clock = anchored_clock();
    let created_at = publisher::rfc3339_format(ANCHOR_UNIX);

    // publish_generation writes NO sidecars and records no sidecar SHAs.
    let id =
        publisher::publish_generation(data_root.path(), "vilnius", &tiny_ptb_path(), &created_at);

    let gen = build_from_published(data_root.path(), "vilnius", &id, clock.as_ref())
        .expect("generation with no artifacts still loads");

    assert!(gen.color_config.is_none(), "no color-config.json => None");
    assert!(gen.route_styles.is_none(), "no route-styles.json => None");
    assert!(gen.label_anchors.is_none(), "no label-anchors.json => None");
    assert!(
        gen.shapes_json_bytes().is_none(),
        "no shapes.bin => None (must not panic)"
    );
}

#[test]
fn corrupt_shapes_bin_is_a_hard_validation_error_at_load() {
    let data_root = tempfile::TempDir::new().expect("tempdir");
    let clock = anchored_clock();
    let created_at = publisher::rfc3339_format(ANCHOR_UNIX);

    // A truncated shapes.bin: keep a partial header so the magic is wrong /
    // the structural parse fails. The manifest records the SHA of THESE
    // (corrupt) bytes, so the full-file SHA check passes — isolating the
    // failure to the structural parse (the property the serve-time expect()
    // depends on).
    let corrupt = b"SHPBnope".to_vec(); // valid magic, but far too short to be a real sidecar
    let artifacts = SidecarArtifacts {
        color_config: None,
        route_styles: None,
        shapes_bin: Some(corrupt),
        departures_idx: None,
        label_anchors: None,
        address_search: None,
    };
    let id = publisher::publish_generation_with_artifacts(
        data_root.path(),
        "vilnius",
        &tiny_ptb_path(),
        &created_at,
        &artifacts,
    );

    // Surfaced as Io(InvalidData) per the loader's artifact_invalid mapping.
    // `Generation` is not `Debug`, so match the Result manually rather than
    // `expect_err`.
    match build_from_published(data_root.path(), "vilnius", &id, clock.as_ref()) {
        Ok(_) => panic!("corrupt shapes.bin must fail the load, not silently succeed"),
        Err(ValidationError::Io(io)) => {
            assert_eq!(io.kind, std::io::ErrorKind::InvalidData);
            assert!(
                io.msg.contains("shapes.bin"),
                "error message should name the artifact, got: {}",
                io.msg
            );
        }
        Err(other) => panic!("expected Io(InvalidData) for corrupt shapes.bin, got {other:?}"),
    }
}

#[test]
fn corrupt_shapes_bin_sha_mismatch_is_a_hard_validation_error() {
    let data_root = tempfile::TempDir::new().expect("tempdir");
    let clock = anchored_clock();
    let created_at = publisher::rfc3339_format(ANCHOR_UNIX);

    // Publish a VALID shapes.bin so the manifest records its (correct) SHA.
    let valid = publisher::encode_test_shapes_bin(&tiny_ptb_path());
    let artifacts = SidecarArtifacts {
        color_config: None,
        route_styles: None,
        shapes_bin: Some(valid),
        departures_idx: None,
        label_anchors: None,
        address_search: None,
    };
    let id = publisher::publish_generation_with_artifacts(
        data_root.path(),
        "vilnius",
        &tiny_ptb_path(),
        &created_at,
        &artifacts,
    );

    // Now overwrite the on-disk shapes.bin with DIFFERENT-but-still-valid bytes
    // so the structural parse passes but the full-file SHA no longer matches the
    // manifest. This isolates the full-file integrity check.
    let mut tampered = publisher::encode_test_shapes_bin(&tiny_ptb_path());
    // Flip a byte in the id-pool region (well past the header) so the bytes are
    // still a parseable sidecar but the SHA differs.
    let last = tampered.len() - 1;
    tampered[last] ^= 0xFF;
    std::fs::write(
        data_root
            .path()
            .join("generations")
            .join(&id)
            .join("shapes.bin"),
        &tampered,
    )
    .unwrap();

    match build_from_published(data_root.path(), "vilnius", &id, clock.as_ref()) {
        Ok(_) => panic!("shapes.bin SHA mismatch must fail the load, not silently succeed"),
        Err(ValidationError::Io(io)) => {
            assert_eq!(io.kind, std::io::ErrorKind::InvalidData);
            assert!(
                io.msg.contains("sha256 mismatch"),
                "error message should mention the SHA mismatch, got: {}",
                io.msg
            );
        }
        Err(other) => panic!("expected Io(InvalidData) for SHA mismatch, got {other:?}"),
    }
}

#[test]
fn tampered_color_config_sha_mismatch_is_a_hard_validation_error() {
    let data_root = tempfile::TempDir::new().expect("tempdir");
    let clock = anchored_clock();
    let created_at = publisher::rfc3339_format(ANCHOR_UNIX);

    // Publish a VALID color-config.json so the manifest records its (correct) SHA.
    let artifacts = SidecarArtifacts {
        color_config: Some(br#"{"colors":{"R1":"FF0000"}}"#.to_vec()),
        route_styles: None,
        shapes_bin: None,
        departures_idx: None,
        label_anchors: None,
        address_search: None,
    };
    let id = publisher::publish_generation_with_artifacts(
        data_root.path(),
        "vilnius",
        &tiny_ptb_path(),
        &created_at,
        &artifacts,
    );

    // Now overwrite the on-disk color-config.json with DIFFERENT bytes so the
    // full-file SHA no longer matches the SHA recorded in the manifest. This
    // isolates the new JSON full-file integrity check.
    std::fs::write(
        data_root
            .path()
            .join("generations")
            .join(&id)
            .join("color-config.json"),
        br#"{"colors":{"R1":"00FF00"}}"#,
    )
    .unwrap();

    match build_from_published(data_root.path(), "vilnius", &id, clock.as_ref()) {
        Ok(_) => panic!("color-config.json SHA mismatch must fail the load, not silently succeed"),
        Err(ValidationError::Io(io)) => {
            assert_eq!(io.kind, std::io::ErrorKind::InvalidData);
            assert!(
                io.msg.contains("color-config.json") && io.msg.contains("sha256 mismatch"),
                "error message should name the artifact + the SHA mismatch, got: {}",
                io.msg
            );
        }
        Err(other) => {
            panic!("expected Io(InvalidData) for color-config SHA mismatch, got {other:?}")
        }
    }
}

#[test]
fn tampered_label_anchors_sha_mismatch_is_a_hard_validation_error() {
    let data_root = tempfile::TempDir::new().expect("tempdir");
    let clock = anchored_clock();
    let created_at = publisher::rfc3339_format(ANCHOR_UNIX);

    // Publish a VALID label-anchors.json so the manifest records its (correct) SHA.
    let artifacts = SidecarArtifacts {
        color_config: None,
        route_styles: None,
        shapes_bin: None,
        departures_idx: None,
        label_anchors: Some(br#"{"anchors":[]}"#.to_vec()),
        address_search: None,
    };
    let id = publisher::publish_generation_with_artifacts(
        data_root.path(),
        "vilnius",
        &tiny_ptb_path(),
        &created_at,
        &artifacts,
    );

    // Now overwrite the on-disk label-anchors.json with DIFFERENT bytes so the
    // full-file SHA no longer matches the SHA recorded in the manifest. This
    // isolates the label-anchors full-file integrity check.
    std::fs::write(
        data_root
            .path()
            .join("generations")
            .join(&id)
            .join("label-anchors.json"),
        br#"{"anchors":[{"stopId":"S1"}]}"#,
    )
    .unwrap();

    match build_from_published(data_root.path(), "vilnius", &id, clock.as_ref()) {
        Ok(_) => {
            panic!("label-anchors.json SHA mismatch must fail the load, not silently succeed")
        }
        Err(ValidationError::Io(io)) => {
            assert_eq!(io.kind, std::io::ErrorKind::InvalidData);
            assert!(
                io.msg.contains("label-anchors.json") && io.msg.contains("sha256 mismatch"),
                "error message should name the artifact + the SHA mismatch, got: {}",
                io.msg
            );
        }
        Err(other) => {
            panic!("expected Io(InvalidData) for label-anchors SHA mismatch, got {other:?}")
        }
    }
}

#[test]
fn shapes_body_hash_mismatch_is_rejected() {
    let data_root = tempfile::TempDir::new().unwrap();
    let clock = anchored_clock();
    let created_at = publisher::rfc3339_format(ANCHOR_UNIX);
    let artifacts = SidecarArtifacts {
        color_config: None,
        route_styles: None,
        shapes_bin: Some(publisher::encode_test_shapes_bin(&tiny_ptb_path())),
        departures_idx: None,
        label_anchors: None,
        address_search: None,
    };
    let id = publisher::publish_generation_with_artifacts(
        data_root.path(),
        "vilnius",
        &tiny_ptb_path(),
        &created_at,
        &artifacts,
    );
    // Tamper ONLY the manifest's shapesJsonSha256 (shapes.bin + its full-file SHA stay valid),
    // isolating the new body-hash check.
    let mpath = publisher::manifest_path_for(data_root.path(), &id);
    let mut m: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&mpath).unwrap()).unwrap();
    m["shapesJsonSha256"] = serde_json::json!("00".repeat(32));
    std::fs::write(&mpath, serde_json::to_string_pretty(&m).unwrap()).unwrap();

    match build_from_published(data_root.path(), "vilnius", &id, clock.as_ref()) {
        Ok(_) => panic!("body-hash mismatch must fail the load"),
        Err(ValidationError::Io(io)) => {
            assert_eq!(io.kind, std::io::ErrorKind::InvalidData);
            assert!(io.msg.contains("shapes.json"), "got: {}", io.msg);
        }
        Err(other) => panic!("expected Io(InvalidData), got {other:?}"),
    }
}

#[test]
fn shapes_interner_mismatch_is_rejected() {
    use pt_shared::sidecar::{encode_shapes_bin, ShapeEncodeInput};
    let data_root = tempfile::TempDir::new().unwrap();
    let clock = anchored_clock();
    let created_at = publisher::rfc3339_format(ANCHOR_UNIX);
    // A shapes.bin whose header carries FOREIGN interner SHAs (not the bundle's).
    let shapes = [ShapeEncodeInput {
        shape_id: "SH_A",
        points: &[(54.69, 25.28), (54.70, 25.29)],
        trip_ref_count: 1,
    }];
    let foreign = encode_shapes_bin(&shapes, &[0u8; 32], &[0u8; 32]).unwrap();
    let artifacts = SidecarArtifacts {
        color_config: None,
        route_styles: None,
        shapes_bin: Some(foreign),
        departures_idx: None,
        label_anchors: None,
        address_search: None,
    };
    let id = publisher::publish_generation_with_artifacts(
        data_root.path(),
        "vilnius",
        &tiny_ptb_path(),
        &created_at,
        &artifacts,
    );

    match build_from_published(data_root.path(), "vilnius", &id, clock.as_ref()) {
        Ok(_) => panic!("interner-SHA mismatch must fail the load"),
        Err(ValidationError::Io(io)) => {
            assert_eq!(io.kind, std::io::ErrorKind::InvalidData);
            assert!(
                io.msg.contains("shapes.bin") && io.msg.contains("namespace"),
                "got: {}",
                io.msg
            );
        }
        Err(other) => panic!("expected Io(InvalidData), got {other:?}"),
    }
}

#[test]
fn geometry_policy_skips_unusable_shapes_without_changing_manifest() {
    let root = tempfile::TempDir::new().unwrap();
    let clock = anchored_clock();
    let artifacts = SidecarArtifacts {
        color_config: Some(br#"{"colors":{}}"#.to_vec()),
        route_styles: None,
        shapes_bin: Some(b"SHPBcorrupt".to_vec()),
        departures_idx: None,
        label_anchors: None,
        address_search: None,
    };
    let id = publisher::publish_generation_with_artifacts(
        root.path(),
        "vilnius",
        &tiny_ptb_path(),
        &publisher::rfc3339_format(ANCHOR_UNIX),
        &artifacts,
    );
    let manifest_path = publisher::manifest_path_for(root.path(), &id);
    let before = std::fs::read(&manifest_path).unwrap();
    // Exercise normal startup and the explicit recovery startup path.
    for forced in [None, Some(id.as_str())] {
        let generation = pt_serve::bundle::load_initial_generation_with_geometry(
            root.path(),
            "vilnius",
            clock.as_ref(),
            &Metrics::new(),
            forced,
            pt_serve::ops::LogFormat::Json,
            Some("Europe/Vilnius"),
            pt_core::PatternMode::Off,
            false,
            false,
        )
        .unwrap();
        assert!(generation.color_config.is_some());
        assert!(generation.shapes_json_bytes().is_none());
        assert!(generation.shapes_json_sha256.is_none());
        assert!(generation.shapes_json_size_bytes.is_none());
        assert!(generation.shapes_json_etag.is_none());
        assert!(generation.route_geometry_etag.is_none());
    }
    assert_eq!(std::fs::read(manifest_path).unwrap(), before);
    assert!(build_from_published(root.path(), "vilnius", &id, clock.as_ref()).is_err());
    // Skipping geometry must not bypass integrity checks for other artifacts.
    let color = publisher::bundle_path_for(root.path(), &id)
        .parent()
        .unwrap()
        .join("color-config.json");
    std::fs::write(color, b"corrupt").unwrap();
    assert!(pt_serve::bundle::load_initial_generation_with_geometry(
        root.path(),
        "vilnius",
        clock.as_ref(),
        &Metrics::new(),
        None,
        pt_serve::ops::LogFormat::Json,
        Some("Europe/Vilnius"),
        pt_core::PatternMode::Off,
        false,
        false,
    )
    .is_err());
}
