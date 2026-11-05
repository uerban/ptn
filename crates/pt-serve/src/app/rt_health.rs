// crates/pt-serve/src/app/rt_health.rs

//! `GET /health/rt` — per-feed GTFS-RT poller health. Parity with the Node
//! route `packages/backend/src/routes/rtHealth.ts` (mounted there as
//! `/api/health/rt`): identical camelCase field names, identical `overall`
//! ladder, identical 503-on-disabled body. Reads the per-cycle snapshot the
//! `pt-serve-rt-poll` thread publishes — no locks, no generation access
//! (RT state is process-scoped, not bundle-scoped).
//!
//! Diverges from Node by one field, `timePredictions`: how many trips of the
//! last cycle carried a time-only prediction, and whether it could be turned
//! into a delay against the bundle (`crate::rt::resolve`). The disabled body is
//! unchanged.

use crate::app::response::Resp;
use crate::ops::ServerCtx;
use crate::rt::poller::{FeedHealth, FeedStatus};
use crate::rt::resolve::TimePredictionStats;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedHealthWire<'a> {
    url: &'a str,
    status: &'static str,
    last_fetched_at: Option<u64>,
    last_error: Option<&'a str>,
    entry_count: usize,
}

#[derive(Serialize)]
struct TimePredictionsWire {
    resolved: u32,
    unresolved: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RtHealthWire<'a> {
    overall: &'static str,
    feeds: Vec<FeedHealthWire<'a>>,
    time_predictions: TimePredictionsWire,
}

fn status_str(s: FeedStatus) -> &'static str {
    match s {
        FeedStatus::Pending => "pending",
        FeedStatus::Ok => "ok",
        FeedStatus::Failed => "failed",
    }
}

const DISABLED_BODY: &str = r#"{"overall":"disabled","feeds":[]}"#;

fn json_response(status: u16, body: String) -> Resp {
    Resp::Json { status, body }
}

pub fn rt_health(ctx: &ServerCtx) -> Resp {
    if !ctx.rt.enabled() {
        return json_response(503, DISABLED_BODY.to_string());
    }
    let snap = ctx.rt.load();
    let feeds: &[FeedHealth] = &snap.health;
    // Defensive only — an enabled RtState always carries >= 1 feed. Mirrors
    // the Node route's identical guard.
    if feeds.is_empty() {
        return json_response(503, DISABLED_BODY.to_string());
    }
    let overall = if feeds.iter().all(|f| f.status == FeedStatus::Ok) {
        "ok"
    } else if feeds.iter().any(|f| f.status == FeedStatus::Ok) {
        "degraded"
    } else {
        "failed"
    };
    let wire = RtHealthWire {
        overall,
        feeds: feeds
            .iter()
            .map(|f| FeedHealthWire {
                url: &f.url,
                status: status_str(f.status),
                last_fetched_at: f.last_fetched_at,
                last_error: f.last_error.as_deref(),
                entry_count: f.entry_count,
            })
            .collect(),
        time_predictions: {
            let TimePredictionStats {
                resolved,
                unresolved,
            } = snap.time_predictions;
            TimePredictionsWire {
                resolved,
                unresolved,
            }
        },
    };
    json_response(
        200,
        serde_json::to_string(&wire).expect("static wire shape serialises"),
    )
}
