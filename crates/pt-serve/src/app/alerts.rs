//! `GET /api/<city>/alerts` — the city's GTFS-RT service alerts.
//!
//! Body: `ServiceAlertsResponse` (`packages/shared/src/types/serviceAlert.ts`),
//! built once per poll cycle by `rt::alerts_state` and served as stored.
//! The route takes no stop or route parameters, so a request discloses only
//! the city; clients match selectors against what they show.
//!
//! - 200 with a strong `ETag` and `Cache-Control: no-cache` (revalidate every
//!   time; the ETag makes that cheap).
//! - 304 when `If-None-Match` matches: any listed tag, `*`, weak (`W/`)
//!   tags, and tags a compressing proxy suffixed (`"<tag>-gzip"`) all count.
//! - 404 `ALERTS_NOT_CONFIGURED` when this process has no alerts feed.
//! - 503 `ALERTS_UNAVAILABLE` until a feed has been fetched successfully.
//!
//! There is no Node counterpart: pt-serve is the only implementation.

use crate::app::response::{ByteBody, Resp};
use crate::ops::ServerCtx;
use std::sync::Arc;

const NOT_CONFIGURED_BODY: &str = r#"{"error":{"code":"ALERTS_NOT_CONFIGURED","message":"Service alerts are not configured for this city"}}"#;
const UNAVAILABLE_BODY: &str = r#"{"error":{"code":"ALERTS_UNAVAILABLE","message":"Service alerts have not been fetched yet"}}"#;

fn json(status: u16, body: &'static str) -> Resp {
    Resp::CachedBytes {
        status,
        body: ByteBody::Raw(Arc::from(body.as_bytes())),
        content_type: "application/json",
        cache_control: "no-cache",
        etag: None,
        gzipped: false,
    }
}

pub fn service_alerts(ctx: &ServerCtx, if_none_match: Option<&str>) -> Resp {
    if !ctx.alerts.enabled() {
        return json(404, NOT_CONFIGURED_BODY);
    }
    let snap = ctx.alerts.load();
    let Some(reply) = snap.reply.as_ref() else {
        return json(503, UNAVAILABLE_BODY);
    };
    if if_none_match.is_some_and(|header| etag_matches(header, &reply.etag)) {
        return Resp::CachedBytes {
            status: 304,
            body: ByteBody::Raw(Arc::from(&[][..])),
            content_type: "application/json",
            cache_control: "no-cache",
            etag: Some(reply.etag.clone()),
            gzipped: false,
        };
    }
    Resp::CachedBytes {
        status: 200,
        body: ByteBody::Raw(Arc::clone(&reply.body)),
        content_type: "application/json",
        cache_control: "no-cache",
        etag: Some(reply.etag.clone()),
        gzipped: false,
    }
}

/// `If-None-Match` uses weak comparison (RFC 9110 §13.1.2). Proxies that
/// compress the body may hand the client a tag with an encoding suffix; it
/// names the same alerts, so it matches too.
fn etag_matches(header: &str, etag: &str) -> bool {
    let wanted = etag.trim_matches('"');
    header.split(',').map(str::trim).any(|candidate| {
        if candidate == "*" {
            return true;
        }
        let opaque = candidate
            .strip_prefix("W/")
            .unwrap_or(candidate)
            .trim_matches('"');
        let opaque = ["-gzip", "-br", "-zstd", "-deflate"]
            .iter()
            .find_map(|suffix| opaque.strip_suffix(suffix))
            .unwrap_or(opaque);
        opaque == wanted
    })
}

#[cfg(test)]
mod tests {
    use super::etag_matches;

    const TAG: &str = "\"abc123\"";

    #[test]
    fn exact_tag_matches() {
        assert!(etag_matches("\"abc123\"", TAG));
        assert!(!etag_matches("\"abc124\"", TAG));
    }

    #[test]
    fn lists_wildcards_and_weak_tags_match() {
        assert!(etag_matches("\"x\", \"abc123\"", TAG));
        assert!(etag_matches("*", TAG));
        assert!(etag_matches("W/\"abc123\"", TAG));
        assert!(!etag_matches("\"x\", W/\"y\"", TAG));
    }

    #[test]
    fn tags_a_compressing_proxy_suffixed_match() {
        assert!(etag_matches("\"abc123-gzip\"", TAG));
        assert!(etag_matches("W/\"abc123-br\"", TAG));
        assert!(!etag_matches("\"abc123-other\"", TAG));
    }
}
