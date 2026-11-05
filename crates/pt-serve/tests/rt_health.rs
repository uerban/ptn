// crates/pt-serve/tests/rt_health.rs
//
// Handler-level tests for /health/rt + the ServerCtx.rt seam. End-to-end binary tests live in
// tests/server.rs.

#[path = "common/mod.rs"]
mod common;

use pt_serve::app::rt_health::rt_health;
use pt_serve::app::Resp;
use pt_serve::rt::poller::{FeedHealth, FeedStatus};
use pt_serve::rt::RtSnapshot;
use pt_serve::{Generation, Metrics, ServerCtx};
use std::collections::HashMap;
use std::sync::Arc;

/// ServerCtx with a real tiny.ptb Generation and the given RT URL config.
/// Returned TempDir must be held for the test's duration.
fn ctx_with_rt(urls: &str) -> (tempfile::TempDir, Arc<ServerCtx>) {
    let (dir, mut config, _clock) = common::isolated_config();
    config.rt_trip_updates_urls = urls.to_string();
    let gen = Generation::from_paths(
        &common::tiny_ptb_path(),
        None,
        "vilnius".to_string(),
        pt_core::PatternMode::Off,
    )
    .expect("generation builds from tiny.ptb");
    let ctx = ServerCtx::new(gen, config, Arc::new(Metrics::default()));
    (dir, ctx)
}

#[test]
fn server_ctx_derives_rt_state_from_config() {
    let (_dir, ctx) = ctx_with_rt("");
    assert!(!ctx.rt.enabled());

    let (_dir2, ctx2) = ctx_with_rt("http://a.test/a.pb,http://b.test/b.pb");
    assert!(ctx2.rt.enabled());
    assert_eq!(ctx2.rt.load().health.len(), 2);
}

fn json_of(resp: Resp) -> (u16, String) {
    match resp {
        Resp::Json { status, body } => (status, body),
        _ => panic!("expected Resp::Json"),
    }
}

fn feed(
    url: &str,
    status: FeedStatus,
    fetched: Option<u64>,
    err: Option<&str>,
    n: usize,
) -> FeedHealth {
    FeedHealth {
        url: url.to_string(),
        status,
        last_fetched_at: fetched,
        last_error: err.map(str::to_string),
        entry_count: n,
    }
}

#[test]
fn disabled_returns_503_with_node_exact_body() {
    let (_dir, ctx) = ctx_with_rt("");
    let (status, body) = json_of(rt_health(&ctx));
    assert_eq!(status, 503);
    assert_eq!(body, r#"{"overall":"disabled","feeds":[]}"#);
}

#[test]
fn all_pending_reports_overall_failed() {
    // Node parity: before the first cycle completes, no feed is "ok", so the
    // ladder lands on "failed" (rtHealth.ts computes exactly this).
    let (_dir, ctx) = ctx_with_rt("http://a.test/a.pb");
    let (status, body) = json_of(rt_health(&ctx));
    assert_eq!(status, 200);
    assert!(body.contains(r#""overall":"failed""#), "{body}");
    assert!(body.contains(r#""status":"pending""#), "{body}");
    // camelCase + null serialisation parity with the Node route.
    assert!(body.contains(r#""lastFetchedAt":null"#), "{body}");
    assert!(body.contains(r#""lastError":null"#), "{body}");
    assert!(body.contains(r#""entryCount":0"#), "{body}");
    assert!(body.contains(r#""url":"http://a.test/a.pb""#), "{body}");
}

#[test]
fn overall_ladder_ok_degraded_failed() {
    let (_dir, ctx) = ctx_with_rt("http://a.test/a.pb,http://b.test/b.pb");

    ctx.rt.publish(RtSnapshot::from_merged(
        HashMap::new(),
        vec![
            feed("http://a.test/a.pb", FeedStatus::Ok, Some(1_000), None, 3),
            feed("http://b.test/b.pb", FeedStatus::Ok, Some(1_000), None, 2),
        ],
    ));
    assert!(json_of(rt_health(&ctx)).1.contains(r#""overall":"ok""#));

    ctx.rt.publish(RtSnapshot::from_merged(
        HashMap::new(),
        vec![
            feed("http://a.test/a.pb", FeedStatus::Ok, Some(2_000), None, 3),
            feed(
                "http://b.test/b.pb",
                FeedStatus::Failed,
                Some(2_000),
                Some("HTTP 503"),
                0,
            ),
        ],
    ));
    let (status, body) = json_of(rt_health(&ctx));
    assert_eq!(status, 200);
    assert!(body.contains(r#""overall":"degraded""#), "{body}");
    assert!(body.contains(r#""lastError":"HTTP 503""#), "{body}");

    ctx.rt.publish(RtSnapshot::from_merged(
        HashMap::new(),
        vec![
            feed(
                "http://a.test/a.pb",
                FeedStatus::Failed,
                Some(3_000),
                Some("timeout"),
                0,
            ),
            feed(
                "http://b.test/b.pb",
                FeedStatus::Failed,
                Some(3_000),
                Some("HTTP 500"),
                0,
            ),
        ],
    ));
    assert!(json_of(rt_health(&ctx)).1.contains(r#""overall":"failed""#));
}
