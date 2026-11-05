//! Integration tests for the `/color-config` and `/shapes` HTTP handlers.
//!
//! Calls the transport-free `app::color_config` and `app::shapes` functions
//! directly (no tiny_http). Exercises 200, 304, 404, and 503 paths.

#[path = "common/mod.rs"]
mod common;

use common::publisher::{self, SidecarArtifacts};
use pt_serve::app::response::Resp;
use pt_serve::app::{color_config::color_config, shapes::shapes};
use pt_serve::Generation;
use std::path::PathBuf;

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

/// Publish a gen dir WITH color-config.json + shapes.bin, return (keep-alive dir, Generation).
fn gen_with_artifacts() -> (tempfile::TempDir, Generation) {
    let tmp = tempfile::tempdir().unwrap();
    let artifacts = SidecarArtifacts {
        color_config: Some(br#"{"colors":{"R1":"FF0000"}}"#.to_vec()),
        route_styles: Some(b"{}".to_vec()),
        shapes_bin: Some(publisher::encode_test_shapes_bin(&tiny_ptb_path())),
        departures_idx: None,
        label_anchors: None,
        address_search: None,
    };
    let id = publisher::publish_generation_with_artifacts(
        tmp.path(),
        "vilnius",
        &tiny_ptb_path(),
        "2026-05-01T00:00:00Z",
        &artifacts,
    );
    let bundle = publisher::bundle_path_for(tmp.path(), &id);
    let gen = Generation::from_paths(
        &bundle,
        None,
        "vilnius".to_string(),
        pt_core::PatternMode::Off,
    )
    .unwrap();
    (tmp, gen)
}

/// A bare generation from tiny.ptb (its parent dir has NO sidecars) → color_config/shapes absent.
fn gen_bare() -> Generation {
    Generation::from_paths(
        &tiny_ptb_path(),
        None,
        "vilnius".to_string(),
        pt_core::PatternMode::Off,
    )
    .unwrap()
}

#[test]
fn color_config_200_serves_verbatim() {
    let (_tmp, gen) = gen_with_artifacts();
    match color_config(&gen) {
        Resp::CachedBytes {
            status,
            content_type,
            cache_control,
            etag,
            gzipped,
            ..
        } => {
            assert_eq!(status, 200);
            assert_eq!(content_type, "application/json");
            assert_eq!(cache_control, "public, max-age=3600");
            assert!(etag.is_none(), "color-config has no ETag (matches backend)");
            assert!(!gzipped);
        }
        _ => panic!("expected CachedBytes 200"),
    }
}

#[test]
fn color_config_503_when_absent() {
    let gen = gen_bare();
    match color_config(&gen) {
        Resp::Json { status, body } => {
            assert_eq!(status, 503);
            assert_eq!(body, "{\"error\":\"Color config not yet computed\"}");
        }
        _ => panic!("expected 503 Json"),
    }
}

#[test]
fn shapes_200_on_correct_hash() {
    let (_tmp, gen) = gen_with_artifacts();
    let hash = gen.shapes_json_sha256.clone().expect("fixture has shapes");
    let artifact = format!("shapes-{hash}.json");
    match shapes(&gen, &artifact, None, false) {
        Resp::CachedBytes {
            status,
            content_type,
            cache_control,
            etag,
            gzipped,
            ..
        } => {
            assert_eq!(status, 200);
            assert_eq!(content_type, "application/json");
            assert_eq!(cache_control, "public, max-age=2592000, immutable");
            assert_eq!(etag.as_deref(), Some(format!("\"{hash}\"").as_str()));
            assert!(!gzipped);
        }
        _ => panic!("expected CachedBytes 200"),
    }
}

#[test]
fn shapes_304_on_if_none_match() {
    let (_tmp, gen) = gen_with_artifacts();
    let hash = gen.shapes_json_sha256.clone().unwrap();
    let etag = format!("\"{hash}\"");
    let artifact = format!("shapes-{hash}.json");
    assert!(matches!(
        shapes(&gen, &artifact, Some(&etag), false),
        Resp::NotModified { .. }
    ));
}

#[test]
fn shapes_404_on_bad_regex_and_wrong_hash() {
    let (_tmp, gen) = gen_with_artifacts();
    assert!(matches!(
        shapes(&gen, "not-an-artifact", None, false),
        Resp::NotFoundEmpty
    ));
    // Uppercase hex digits are rejected (not lowercase-only)
    assert!(matches!(
        shapes(&gen, "shapes-XYZ.json", None, false),
        Resp::NotFoundEmpty
    ));
    let wrong = format!("shapes-{}.json", "0".repeat(64));
    assert!(matches!(
        shapes(&gen, &wrong, None, false),
        Resp::NotFoundEmpty
    ));
}

#[test]
fn shapes_503_when_absent() {
    let gen = gen_bare();
    let artifact = format!("shapes-{}.json", "a".repeat(64));
    match shapes(&gen, &artifact, None, false) {
        Resp::Json { status, body } => {
            assert_eq!(status, 503);
            assert_eq!(body, "{\"error\":\"shapes artifact unavailable\"}");
        }
        _ => panic!("expected 503 Json"),
    }
}

#[test]
fn shapes_200_gzip_when_accepted() {
    let (_tmp, gen) = gen_with_artifacts();
    let hash = gen.shapes_json_sha256.clone().unwrap();
    let artifact = format!("shapes-{hash}.json");
    match shapes(&gen, &artifact, None, true) {
        Resp::CachedBytes { gzipped, .. } => assert!(gzipped, "gzip negotiated"),
        _ => panic!("expected CachedBytes"),
    }
}
