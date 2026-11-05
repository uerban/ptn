//! `/raptor-bundle` generation-provenance headers.
//!
//! pt-serve serves `GET /api/<city>/raptor-bundle` in production (nginx proxies
//! it). The Node backend route emits transfer-provenance headers so the wasm
//! frontend can fetch + verify the transfers artifact regardless of which
//! server answered; pt-serve must emit the SAME headers:
//!
//!   - `X-PT-Raptor-Bundle-Provenance: transfers-v1` — capability marker, on
//!     EVERY raptor-bundle 200/304 response (even with no transfers).
//!   - `X-PT-Transfers-Artifact-Url`  — only when transfers exist.
//!   - `X-PT-Transfers-Artifact-Hash` — only when transfers exist.
//!   - `X-PT-Transfers-Artifact-Size` — only when transfers exist.
//!   - `X-PT-City-Tz-Iana` — authoritative generation timezone on every
//!     200/304 response when the generation resolved one.
//!
//! The PTB ETag stays derived from the PTB bytes only (`gen.bundle_etag`) — the
//! transfer hash is NEVER folded into it.
//!
//! The hash on the wire is the UNQUOTED lowercase-hex sha256 of the transfers
//! bytes — byte-parity with the Node backend's `getArtifactMeta().hash`
//! (`transfersStore.ts`). `gen.transfers_etag` is that SAME digest wrapped in
//! ETag double-quotes; the handler strips the quotes for the `*-Hash` header so
//! a frontend that verifies `header == sha256hex(bytes)` succeeds against either
//! server. These tests assert against the unquoted digest.

use std::path::PathBuf;

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

/// P2's committed canonical PTFT artifact — a valid `transfers.bin` so the
/// built `Generation` carries `transfers_etag = Some(..)`.
fn tiny_transfers_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/frontend/tests/services/__fixtures__/footpath-transfers.bin")
}

const CITY: &str = "vilnius";
const PROVENANCE_HEADER: &str = "X-PT-Raptor-Bundle-Provenance";
const PROVENANCE_VALUE: &str = "transfers-v1";
const URL_HEADER: &str = "X-PT-Transfers-Artifact-Url";
const HASH_HEADER: &str = "X-PT-Transfers-Artifact-Hash";
const SIZE_HEADER: &str = "X-PT-Transfers-Artifact-Size";
const CITY_TZ_HEADER: &str = "X-PT-City-Tz-Iana";
const CITY_TZ: &str = "Europe/Vilnius";
const GEOMETRY_PROVENANCE_HEADER: &str = "X-PT-Route-Geometry-Provenance";
const GEOMETRY_PROVENANCE_VALUE: &str = "shpb-v1";
const GEOMETRY_URL_HEADER: &str = "X-PT-Route-Geometry-Artifact-Url";
const GEOMETRY_HASH_HEADER: &str = "X-PT-Route-Geometry-Artifact-Hash";
const GEOMETRY_SIZE_HEADER: &str = "X-PT-Route-Geometry-Artifact-Size";

fn gen_with_transfers() -> pt_serve::Generation {
    // Bind the transfers path so `Some(..)` is `Option<&Path>` (deref coercion
    // from `&PathBuf` does NOT apply inside `Option`).
    let transfers = tiny_transfers_path();
    let mut generation = pt_serve::Generation::from_paths(
        &tiny_ptb_path(),
        Some(transfers.as_path()),
        CITY.to_string(),
        pt_core::PatternMode::Off,
    )
    .expect("generation builds from tiny.ptb + footpath-transfers.bin");
    generation.city_tz_iana = CITY_TZ.to_string();
    generation
}

fn gen_without_transfers() -> pt_serve::Generation {
    let mut generation = pt_serve::Generation::from_paths(
        &tiny_ptb_path(),
        None,
        CITY.to_string(),
        pt_core::PatternMode::Off,
    )
    .expect("generation builds from tiny.ptb (no transfers)");
    generation.city_tz_iana = CITY_TZ.to_string();
    generation
}

/// Case-insensitive header lookup off the materialized `tiny_http` response.
fn header_value(resp: &tiny_http::ResponseBox, name: &str) -> Option<String> {
    resp.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

#[test]
fn raptor_bundle_200_includes_transfer_provenance_headers() {
    use pt_serve::app::bytes::raptor_bundle;

    let gen = gen_with_transfers();
    let expected_hash = gen.transfers_etag.as_deref().expect("transfers loaded");
    let expected_hash = expected_hash.trim_matches('"').to_string();
    let expected_size = gen.transfers_bytes_len();
    let bundle_etag = gen.bundle_etag.clone();

    let resp = raptor_bundle(&gen, None, false, CITY);
    // Must be a 200 bytes response, not a 304.
    assert!(
        matches!(resp, pt_serve::app::response::Resp::Bytes { .. }),
        "fresh GET (no If-None-Match) must be a 200 Bytes response"
    );
    let http = pt_serve::http::adapter::to_tiny_http(resp);

    assert_eq!(http.status_code().0, 200);
    assert_eq!(
        header_value(&http, PROVENANCE_HEADER).as_deref(),
        Some(PROVENANCE_VALUE),
        "capability marker must be present on every raptor-bundle response"
    );
    assert_eq!(
        header_value(&http, GEOMETRY_PROVENANCE_HEADER).as_deref(),
        Some(GEOMETRY_PROVENANCE_VALUE)
    );
    assert!(header_value(&http, GEOMETRY_URL_HEADER).is_none());
    assert!(header_value(&http, GEOMETRY_HASH_HEADER).is_none());
    assert!(header_value(&http, GEOMETRY_SIZE_HEADER).is_none());
    assert_eq!(
        header_value(&http, URL_HEADER).as_deref(),
        Some(format!("/api/{CITY}/transfers/fetch").as_str())
    );
    assert_eq!(
        header_value(&http, HASH_HEADER).as_deref(),
        Some(expected_hash.as_str()),
        "artifact hash must be the UNQUOTED sha256 hex (parity with Node getArtifactMeta().hash)"
    );
    assert_eq!(
        header_value(&http, SIZE_HEADER).as_deref(),
        Some(expected_size.to_string().as_str())
    );
    assert_eq!(
        header_value(&http, CITY_TZ_HEADER).as_deref(),
        Some(CITY_TZ),
        "bundle metadata must carry the active generation timezone"
    );

    // The response ETag is the PTB ETag, NOT the transfer hash.
    assert_eq!(
        header_value(&http, "ETag").as_deref(),
        Some(bundle_etag.as_str()),
        "raptor-bundle ETag must stay the PTB ETag"
    );
    assert_ne!(
        header_value(&http, "ETag").as_deref(),
        Some(expected_hash.as_str()),
        "the transfer hash must NEVER be folded into the PTB ETag"
    );

    // Parity Cache-Control with the Node route (store-but-revalidate).
    assert_eq!(
        header_value(&http, "Cache-Control").as_deref(),
        Some("public, max-age=0, must-revalidate")
    );
}

#[test]
fn raptor_bundle_304_includes_fresh_transfer_provenance_headers() {
    use pt_serve::app::bytes::raptor_bundle;

    let gen = gen_with_transfers();
    let bundle_etag = gen.bundle_etag.clone();
    let expected_hash = gen
        .transfers_etag
        .as_deref()
        .expect("transfers loaded")
        .trim_matches('"')
        .to_string();
    let expected_size = gen.transfers_bytes_len();

    // If-None-Match against the PTB ETag → 304.
    let resp = raptor_bundle(&gen, Some(bundle_etag.as_str()), false, CITY);
    assert!(
        matches!(resp, pt_serve::app::response::Resp::NotModified { .. }),
        "If-None-Match against the bundle ETag must yield 304"
    );
    let http = pt_serve::http::adapter::to_tiny_http(resp);

    assert_eq!(http.status_code().0, 304);
    // The 304 must still carry the FRESH transfer provenance — a transfer-only
    // change (same PTB ETag) must reach the client without a PTB redownload.
    assert_eq!(
        header_value(&http, PROVENANCE_HEADER).as_deref(),
        Some(PROVENANCE_VALUE)
    );
    assert_eq!(
        header_value(&http, GEOMETRY_PROVENANCE_HEADER).as_deref(),
        Some(GEOMETRY_PROVENANCE_VALUE)
    );
    assert_eq!(
        header_value(&http, URL_HEADER).as_deref(),
        Some(format!("/api/{CITY}/transfers/fetch").as_str())
    );
    assert_eq!(
        header_value(&http, HASH_HEADER).as_deref(),
        Some(expected_hash.as_str())
    );
    assert_eq!(
        header_value(&http, SIZE_HEADER).as_deref(),
        Some(expected_size.to_string().as_str())
    );
    assert_eq!(
        header_value(&http, CITY_TZ_HEADER).as_deref(),
        Some(CITY_TZ),
        "304 revalidation must carry fresh timezone metadata"
    );
    assert_eq!(
        header_value(&http, "ETag").as_deref(),
        Some(bundle_etag.as_str())
    );
}

#[test]
fn raptor_bundle_omits_transfer_headers_when_transfers_absent() {
    use pt_serve::app::bytes::raptor_bundle;

    let gen = gen_without_transfers();
    assert!(
        gen.transfers_etag.is_none(),
        "fixture precondition: no transfers loaded"
    );

    let resp = raptor_bundle(&gen, None, false, CITY);
    let http = pt_serve::http::adapter::to_tiny_http(resp);

    assert_eq!(http.status_code().0, 200);
    // Capability marker is ALWAYS present — even with no transfers — so a
    // wasm-capable frontend can distinguish "server speaks transfers-v1 but has
    // no artifact" from "old server that doesn't speak the protocol".
    assert_eq!(
        header_value(&http, PROVENANCE_HEADER).as_deref(),
        Some(PROVENANCE_VALUE)
    );
    assert_eq!(
        header_value(&http, GEOMETRY_PROVENANCE_HEADER).as_deref(),
        Some(GEOMETRY_PROVENANCE_VALUE)
    );
    // The 3 artifact headers are omitted when no transfers exist.
    assert!(header_value(&http, URL_HEADER).is_none());
    assert!(header_value(&http, HASH_HEADER).is_none());
    assert!(header_value(&http, SIZE_HEADER).is_none());
    assert_eq!(
        header_value(&http, CITY_TZ_HEADER).as_deref(),
        Some(CITY_TZ),
        "timezone metadata is independent of the transfers artifact"
    );
}

#[test]
fn raptor_bundle_omits_timezone_header_when_generation_has_no_resolved_timezone() {
    use pt_serve::app::bytes::raptor_bundle;

    let mut generation = gen_without_transfers();
    generation.city_tz_iana.clear();

    let response = raptor_bundle(&generation, None, false, CITY);
    let http = pt_serve::http::adapter::to_tiny_http(response);

    assert_eq!(http.status_code().0, 200);
    assert!(header_value(&http, CITY_TZ_HEADER).is_none());
}
