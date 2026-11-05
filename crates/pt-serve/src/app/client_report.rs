//! `POST /api/<city>/client-report` — opt-in client engine-failure report.
//!
//! Node parity: `packages/backend/src/routes/clientReport.ts`. The client calls
//! it fire-and-forget from `api.ts` `sendClientReport` and ignores the response
//! entirely, which is exactly why the validation below matters: nothing on the
//! client side will ever surface a rejection, so a permissive server would
//! accumulate junk silently.
//!
//! URL SHAPE. Node registers `/api/client-report` and relies on nginx stripping
//! `/api/<city>/`. pt-serve matches the city-scoped path directly, like
//! `gtfs/manifest` and the tile routes — the real client contract has always
//! carried the city segment (`getBaseUrl()` yields `/api/<city>`), and the
//! stripped spelling is a Node-internal detail. Do NOT add an nginx rewrite.
//!
//! PRIVACY. The handler persists no body, app version, IP, or client identifier: it performs one
//! bounded counter increment by allowlisted kind and nothing else. The HTTP/nginx layer can still
//! observe normal connection metadata such as source IP and request time. Note this diverges from
//! Node in one respect on purpose: Node also writes a coarse `request.log.info({kind})` line.
//! pt-serve does not, because that would add the diagnostic kind to logs at the cost of one write
//! per report on the request thread.

use crate::app::response::Resp;
use crate::ops::metrics::Metrics;

/// The allowlist. Mirrors `ENGINE_FAILURE_KINDS` in
/// `packages/shared/src/routing/engineFailureKinds.ts`, which is the single
/// source of truth shared by the client classifier and Node's copy of this
/// list. Duplicated across the language boundary the same way `tile_coord`'s
/// constants are — pt-shared cannot import TypeScript.
///
/// KEEP IN SYNC. A kind added on the client and not here is a 400, so the
/// report is dropped and the client never learns; the round trip is
/// `engineFailureKinds.ts` -> here -> `clientReport.ts`.
pub const CLIENT_REPORT_KINDS: [&str; 5] = ["no-wasm", "import", "init", "query", "other"];

/// Maximum accepted body. Node sets `bodyLimit: 1 * 1024` on this route; the
/// dispatcher enforces the same cap before calling in, so this constant exists
/// to keep the two spellings next to each other.
pub const MAX_CLIENT_REPORT_BODY_BYTES: u64 = 1024;

const INVALID_BODY: &str =
    r#"{"error":{"code":"INVALID_BODY","message":"Body must be an object"}}"#;

fn invalid_kind() -> String {
    format!(
        r#"{{"error":{{"code":"INVALID_KIND","message":"kind must be one of: {}"}}}}"#,
        CLIENT_REPORT_KINDS.join(", ")
    )
}

pub fn client_report(body: &[u8], metrics: &Metrics) -> Resp {
    let parsed: serde_json::Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => {
            return Resp::Json {
                status: 400,
                body: INVALID_BODY.to_string(),
            }
        }
    };
    // `is_object` rejects arrays and scalars in one check, matching Node's
    // `!body || typeof body !== "object" || Array.isArray(body)`. A JSON array
    // is `typeof "object"` in JS too, hence the explicit Array test there.
    if !parsed.is_object() {
        return Resp::Json {
            status: 400,
            body: INVALID_BODY.to_string(),
        };
    }

    let kind = parsed.get("kind").and_then(|k| k.as_str());
    // Borrow the &'static str from the allowlist rather than the request's own
    // bytes — the metric label must never be attacker-controlled.
    let allowed = kind.and_then(|k| CLIENT_REPORT_KINDS.iter().find(|a| **a == k));
    match allowed {
        Some(kind) => {
            metrics.inc_client_engine_failure_report(kind);
            Resp::NoContent
        }
        None => Resp::Json {
            status: 400,
            body: invalid_kind(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status_of(resp: &Resp) -> u16 {
        match resp {
            Resp::Json { status, .. } => *status,
            Resp::NoContent => 204,
            _ => panic!("unexpected Resp variant"),
        }
    }

    #[test]
    fn accepts_every_allowlisted_kind_and_counts_it() {
        let metrics = Metrics::new();
        for kind in CLIENT_REPORT_KINDS {
            let body = format!(r#"{{"kind":"{kind}"}}"#);
            assert_eq!(status_of(&client_report(body.as_bytes(), &metrics)), 204);
            assert_eq!(metrics.client_engine_failure_reports_total(kind), 1);
        }
    }

    #[test]
    fn unknown_kind_is_400_and_mints_no_series() {
        let metrics = Metrics::new();
        let resp = client_report(br#"{"kind":"../../etc/passwd"}"#, &metrics);
        assert_eq!(status_of(&resp), 400);
        // The whole point of the allowlist: an untrusted label must not create
        // a series. Checked on the map itself, because the typed reader would
        // return 0 for an absent key either way.
        assert!(metrics
            .client_engine_failure_reports_total
            .lock()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn rejects_arrays_and_scalars_like_node_does() {
        let metrics = Metrics::new();
        for body in [&b"[]"[..], b"\"other\"", b"42", b"null", b"not json at all"] {
            assert_eq!(status_of(&client_report(body, &metrics)), 400, "{body:?}");
        }
    }

    #[test]
    fn a_missing_or_non_string_kind_is_400_not_a_panic() {
        let metrics = Metrics::new();
        assert_eq!(status_of(&client_report(br#"{}"#, &metrics)), 400);
        assert_eq!(status_of(&client_report(br#"{"kind":7}"#, &metrics)), 400);
        assert_eq!(
            status_of(&client_report(br#"{"kind":null}"#, &metrics)),
            400
        );
    }

    #[test]
    fn extra_fields_are_ignored_rather_than_rejected() {
        // The client sends a richer report object than `{kind}`; only `kind`
        // is read, and Node does the same. Rejecting unknown keys here would
        // silently drop every real report the moment the client adds a field.
        let metrics = Metrics::new();
        let body = br#"{"kind":"query","detail":"whatever","nested":{"a":1}}"#;
        assert_eq!(status_of(&client_report(body, &metrics)), 204);
        assert_eq!(metrics.client_engine_failure_reports_total("query"), 1);
    }

    #[test]
    fn the_allowlist_matches_the_shared_typescript_union() {
        // Cross-language drift guard. The source of truth is
        // packages/shared/src/routing/engineFailureKinds.ts; this asserts the
        // literal spelling so a rename there fails here rather than silently
        // 400-ing every report of the renamed kind in production.
        assert_eq!(
            CLIENT_REPORT_KINDS,
            ["no-wasm", "import", "init", "query", "other"]
        );
    }
}
