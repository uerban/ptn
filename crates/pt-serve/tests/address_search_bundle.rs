//! Integration tests for `GET /api/<city>/address-search/bundle`.
//!
//! Calls the transport-free `app::address_search::bundle` directly (no
//! tiny_http). The route serves the whole corpus — the one body a client is
//! expected to download in full — so the gzip branch is the thing under test:
//! on the vilnius corpus it is 21.4 MB raw against 3.2 MB gzipped.

#[path = "common/mod.rs"]
mod common;

use common::publisher::{self, SidecarArtifacts};
use pt_serve::app::address_search::{bundle, manifest};
use pt_serve::app::response::{ByteBody, Resp};
use pt_serve::Generation;
use std::io::Read as _;
use std::path::PathBuf;

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

/// A corpus with enough rows that gzip has something to work with — a handful
/// of bytes would compress to MORE than the input and the size assertion below
/// would be meaningless.
fn corpus_bytes() -> Vec<u8> {
    let rows: Vec<pt_geocode::AddrRow> = (0..200)
        .map(|i| pt_geocode::AddrRow {
            label: format!("Gedimino pr. {i}"),
            lat: 54.6879,
            lon: 25.2757,
        })
        .collect();
    let keys: Vec<pt_geocode::AddrKey> = (0..200)
        .map(|i| pt_geocode::AddrKey {
            key: format!("gedimino prospektas {i}"),
            row_id: i,
        })
        .collect();
    pt_geocode::AddrIndex::pack(
        &rows,
        &keys,
        &pt_geocode::ArtifactMeta {
            city_id: Some("vilnius".into()),
            source: None,
            generated_at: "2026-05-01T00:00:00Z".into(),
        },
    )
    .expect("pack corpus")
}

fn gen_with_corpus(corpus: Option<Vec<u8>>) -> (tempfile::TempDir, Generation) {
    let tmp = tempfile::tempdir().unwrap();
    let artifacts = SidecarArtifacts {
        color_config: None,
        route_styles: None,
        shapes_bin: None,
        departures_idx: None,
        label_anchors: None,
        address_search: corpus,
    };
    let id = publisher::publish_generation_with_artifacts(
        tmp.path(),
        "vilnius",
        &tiny_ptb_path(),
        "2026-05-01T00:00:00Z",
        &artifacts,
    );
    let bundle_path = publisher::bundle_path_for(tmp.path(), &id);
    let gen = Generation::from_paths(
        &bundle_path,
        None,
        "vilnius".to_string(),
        pt_core::PatternMode::Off,
    )
    .unwrap();
    (tmp, gen)
}

fn gunzip(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_end(&mut out)
        .expect("body must be valid gzip");
    out
}

fn parts(resp: &Resp) -> (u16, &ByteBody, bool, Option<&String>) {
    match resp {
        Resp::CachedBytes {
            status,
            body,
            gzipped,
            etag,
            ..
        } => (*status, body, *gzipped, etag.as_ref()),
        _ => panic!("expected CachedBytes"),
    }
}

#[test]
fn bundle_without_accept_gzip_serves_raw_bytes() {
    let corpus = corpus_bytes();
    let (_tmp, gen) = gen_with_corpus(Some(corpus.clone()));

    let resp = bundle(&gen, None, false);
    let (status, body, gzipped, _) = parts(&resp);

    assert_eq!(status, 200);
    assert!(!gzipped, "no Accept-Encoding: gzip must serve raw bytes");
    match body {
        ByteBody::Raw(bytes) => assert_eq!(bytes.as_ref(), corpus.as_slice()),
        _ => panic!("raw branch must hand back a Raw body"),
    }
}

#[test]
fn bundle_with_accept_gzip_serves_gzip_that_round_trips() {
    let corpus = corpus_bytes();
    let (_tmp, gen) = gen_with_corpus(Some(corpus.clone()));

    let resp = bundle(&gen, None, true);
    let (status, body, gzipped, _) = parts(&resp);

    assert_eq!(status, 200);
    assert!(gzipped, "Accept-Encoding: gzip must set Content-Encoding");
    let ByteBody::Gzip(bytes) = body else {
        panic!("gzip branch must hand back a Gzip body");
    };
    assert_eq!(
        gunzip(bytes),
        corpus,
        "gzip body must decode to the byte-identical corpus — the manifest \
         advertises sha256/sizeBytes of the DECODED artifact and the PWA \
         verifies both after the browser decompresses",
    );
    assert!(
        bytes.len() < corpus.len(),
        "gzip body ({} B) must be smaller than raw ({} B)",
        bytes.len(),
        corpus.len(),
    );
}

#[test]
fn etag_does_not_vary_by_content_encoding() {
    // Content-Encoding is a transfer property, not an identity. A client that
    // switches encodings (proxy change, gzip disabled) must still get a 304
    // for bytes it already holds, so both branches carry the raw-bytes ETag.
    let (_tmp, gen) = gen_with_corpus(Some(corpus_bytes()));

    let resp_raw = bundle(&gen, None, false);
    let (_, _, _, raw_etag) = parts(&resp_raw);
    let raw_etag = raw_etag.expect("raw branch etag").clone();
    let resp_gz = bundle(&gen, None, true);
    let (_, _, _, gz_etag) = parts(&resp_gz);

    assert_eq!(gz_etag, Some(&raw_etag));
}

#[test]
fn if_none_match_304s_in_both_branches() {
    let (_tmp, gen) = gen_with_corpus(Some(corpus_bytes()));
    let etag = match bundle(&gen, None, false) {
        Resp::CachedBytes { etag, .. } => etag.expect("etag"),
        _ => panic!("expected CachedBytes"),
    };

    for accept_gzip in [false, true] {
        assert!(
            matches!(
                bundle(&gen, Some(etag.as_str()), accept_gzip),
                Resp::NotModified { .. }
            ),
            "If-None-Match must 304 with accept_gzip={accept_gzip}",
        );
    }
}

#[test]
fn weak_or_proxy_suffixed_if_none_match_304s() {
    let (_tmp, gen) = gen_with_corpus(Some(corpus_bytes()));
    let etag = match bundle(&gen, None, false) {
        Resp::CachedBytes { etag, .. } => etag.expect("etag"),
        _ => panic!("expected CachedBytes"),
    };
    let opaque = etag.trim_matches('"');
    for header in [format!("W/{etag}"), format!("\"{opaque}-gzip\"")] {
        assert!(
            matches!(bundle(&gen, Some(&header), true), Resp::NotModified { .. }),
            "{header} must 304",
        );
        assert!(
            matches!(manifest(&gen, Some(&header)), Resp::NotModified { .. }),
            "manifest: {header} must 304",
        );
    }
}

#[test]
fn gzip_body_is_built_once_and_reused() {
    // The gzip lives in a OnceLock on the sidecar, so two requests must hand
    // back the SAME allocation rather than re-compressing 21 MB per request.
    let (_tmp, gen) = gen_with_corpus(Some(corpus_bytes()));

    let first = bundle(&gen, None, true);
    let second = bundle(&gen, None, true);
    let (Resp::CachedBytes { body: b1, .. }, Resp::CachedBytes { body: b2, .. }) =
        (&first, &second)
    else {
        panic!("expected CachedBytes");
    };
    let (ByteBody::Gzip(a), ByteBody::Gzip(b)) = (b1, b2) else {
        panic!("expected Gzip bodies");
    };
    assert!(
        std::ptr::eq(a.as_ref(), b.as_ref()),
        "second request must reuse the cached gzip allocation",
    );
}

#[test]
fn absent_corpus_is_404_in_both_branches() {
    let (_tmp, gen) = gen_with_corpus(None);

    for accept_gzip in [false, true] {
        assert!(
            matches!(bundle(&gen, None, accept_gzip), Resp::NotFoundEmpty),
            "no corpus must 404 with accept_gzip={accept_gzip}",
        );
    }
}
