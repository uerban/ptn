//! `GET /api/<city>/gtfs/shapes/<artifact>` — content-addressed shapes JSON.
use crate::app::response::{if_none_match_hits, ByteBody, Resp};
use crate::bundle::{generation::gzip, Generation};
use std::sync::Arc;

/// `artifact` is the captured `shapes-<hex>.json` tail segment.
pub fn shapes(
    gen: &Generation,
    artifact: &str,
    if_none_match: Option<&str>,
    accept_gzip: bool,
) -> Resp {
    // Parse `shapes-<lowercasehex>.json` (matches the backend's
    // ^shapes-([0-9a-f]+)\.json$). Reject anything else as 404.
    let hash = match artifact
        .strip_prefix("shapes-")
        .and_then(|s| s.strip_suffix(".json"))
    {
        Some(h)
            if !h.is_empty()
                && h.bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) =>
        {
            h
        }
        _ => return Resp::NotFoundEmpty,
    };
    // Route enabled only when this generation advertises a shapes body hash.
    // NOTE: do NOT materialize the body here — the 404/304 short-circuits below
    // must not pay the (multi-MB) serialization cost. Only the 200 path calls
    // `shapes_json_bytes()`.
    let (Some(expected), Some(etag)) = (
        gen.shapes_json_sha256.as_deref(),
        gen.shapes_json_etag.as_ref(),
    ) else {
        return Resp::Json {
            status: 503,
            body: "{\"error\":\"shapes artifact unavailable\"}".to_string(),
        };
    };
    if hash != expected {
        return Resp::NotFoundEmpty;
    }
    if if_none_match_hits(if_none_match, etag) {
        // No provenance: the raptor-bundle capability marker is scoped to
        // /raptor-bundle only.
        return Resp::NotModified {
            etag: etag.clone(),
            provenance: None,
        };
    }
    // 200 path: materialize the body now. (`shapes_json_sha256` is Some iff the
    // shapes sidecar is loaded, so the body is present; guard defensively.)
    let Some(body) = gen.shapes_json_bytes() else {
        return Resp::Json {
            status: 503,
            body: "{\"error\":\"shapes artifact unavailable\"}".to_string(),
        };
    };
    let (out_body, gzipped) = if accept_gzip {
        let gz = gen
            .shapes_json_gzip
            .get_or_init(|| Arc::from(gzip(body.as_ref())));
        (ByteBody::Gzip(Arc::clone(gz)), true)
    } else {
        (ByteBody::Raw(body), false)
    };
    Resp::CachedBytes {
        status: 200,
        body: out_body,
        content_type: "application/json",
        cache_control: "public, max-age=2592000, immutable",
        etag: Some(etag.clone()),
        gzipped,
    }
}
