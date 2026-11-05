//! The test publisher produces SELF-CONSISTENT color-provenance fixtures:
//! `encode_test_shapes_bin(ptb)` writes a shapes.bin whose header SHAs equal the bundle's
//! recomputed interner SHAs, and `publish_generation_with_artifacts` records a `shapesJsonSha256`
//! matching the canonical body — what lets the load-time integrity checks pass on the test
//! fixtures.
#[path = "common/mod.rs"]
mod common;
use common::publisher;
use std::path::PathBuf;

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

fn bundle_shas(ptb: &std::path::Path) -> ([u8; 32], [u8; 32]) {
    let bytes: Vec<u8> = std::fs::read(ptb).unwrap();
    let reader = pt_core::Reader::from_bytes(bytes).unwrap();
    pt_serve::bundle::integrity::bundle_namespace_shas(&reader).unwrap()
}

#[test]
fn shapes_bin_header_matches_bundle_interner() {
    let ptb = tiny_ptb_path();
    let bin = publisher::encode_test_shapes_bin(&ptb);
    let (trips_sha, stops_sha) = bundle_shas(&ptb);
    let header =
        pt_shared::sidecar::parse_sidecar_header(&bin, pt_shared::sidecar::SHAPES_MAGIC).unwrap();
    assert_eq!(
        header.trips_intern_sha256, trips_sha,
        "shapes.bin trips SHA must match bundle"
    );
    assert_eq!(
        header.stops_intern_sha256, stops_sha,
        "shapes.bin stops SHA must match bundle"
    );
    assert!(pt_shared::sidecar::ShapesBin::parse(&bin, &trips_sha, &stops_sha).is_ok());
}

#[test]
fn manifest_records_shapes_json_sha256() {
    let tmp = tempfile::tempdir().unwrap();
    let ptb = tiny_ptb_path();
    let bin = publisher::encode_test_shapes_bin(&ptb);
    let artifacts = publisher::SidecarArtifacts {
        color_config: Some(
            br#"{"modes":[],"palettes":{"light":{},"dark":{}},"universalLimited":false}"#.to_vec(),
        ),
        route_styles: Some(b"{}".to_vec()),
        shapes_bin: Some(bin.clone()),
        departures_idx: None,
        label_anchors: None,
        address_search: None,
    };
    let id = publisher::publish_generation_with_artifacts(
        tmp.path(),
        "vilnius",
        &ptb,
        "2026-05-01T00:00:00Z",
        &artifacts,
    );
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            tmp.path()
                .join("generations")
                .join(&id)
                .join("generation.json"),
        )
        .unwrap(),
    )
    .unwrap();

    let (trips_sha, stops_sha) = bundle_shas(&ptb);
    let parsed = pt_shared::sidecar::ShapesBin::parse(&bin, &trips_sha, &stops_sha).unwrap();
    let (digest, len) = pt_shared::sidecar::shapes_json_sha256(&parsed);
    let expect_hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();

    assert_eq!(
        manifest["shapesJsonSha256"].as_str(),
        Some(expect_hex.as_str())
    );
    assert_eq!(manifest["shapesJsonSizeBytes"].as_u64(), Some(len));
}
