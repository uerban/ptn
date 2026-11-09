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
//!
//! When ServiceAlerts feeds are configured, the body also carries
//! `serviceAlerts`: their own `overall` ladder and per-feed health, and the
//! last cycle's counts (`served`, `expired`, `droppedSelectors`,
//! `droppedAlerts`, see `rt::alerts_state`). They are reported separately so
//! an alerts outage never reads as a departures outage. With TripUpdates off
//! and alerts on, the status stays 503 with `overall: "disabled"`.

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
    #[serde(skip_serializing_if = "Option::is_none")]
    time_predictions: Option<TimePredictionsWire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    service_alerts: Option<AlertsHealthWire<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlertsHealthWire<'a> {
    overall: &'static str,
    feeds: Vec<FeedHealthWire<'a>>,
    served: u32,
    expired: u32,
    dropped_selectors: u32,
    dropped_alerts: u32,
}

fn overall_of(feeds: &[FeedHealth]) -> &'static str {
    if feeds.iter().all(|f| f.status == FeedStatus::Ok) {
        "ok"
    } else if feeds.iter().any(|f| f.status == FeedStatus::Ok) {
        "degraded"
    } else {
        "failed"
    }
}

fn feeds_wire(feeds: &[FeedHealth]) -> Vec<FeedHealthWire<'_>> {
    feeds
        .iter()
        .map(|f| FeedHealthWire {
            url: &f.url,
            status: status_str(f.status),
            last_fetched_at: f.last_fetched_at,
            last_error: f.last_error.as_deref(),
            entry_count: f.entry_count,
        })
        .collect()
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
    let alerts_snap = ctx.alerts.enabled().then(|| ctx.alerts.load());
    let service_alerts = alerts_snap.as_ref().map(|snap| AlertsHealthWire {
        overall: overall_of(&snap.health),
        feeds: feeds_wire(&snap.health),
        served: snap.stats.served,
        expired: snap.stats.expired,
        dropped_selectors: snap.stats.dropped_selectors,
        dropped_alerts: snap.stats.dropped_alerts,
    });
    let disabled = |service_alerts: Option<AlertsHealthWire<'_>>| match service_alerts {
        None => json_response(503, DISABLED_BODY.to_string()),
        Some(alerts) => json_response(
            503,
            serde_json::to_string(&RtHealthWire {
                overall: "disabled",
                feeds: Vec::new(),
                time_predictions: None,
                service_alerts: Some(alerts),
            })
            .expect("static wire shape serialises"),
        ),
    };
    if !ctx.rt.enabled() {
        return disabled(service_alerts);
    }
    let snap = ctx.rt.load();
    let feeds: &[FeedHealth] = &snap.health;
    // Defensive only — an enabled RtState always carries >= 1 feed. Mirrors
    // the Node route's identical guard.
    if feeds.is_empty() {
        return disabled(service_alerts);
    }
    let TimePredictionStats {
        resolved,
        unresolved,
    } = snap.time_predictions;
    let wire = RtHealthWire {
        overall: overall_of(feeds),
        feeds: feeds_wire(feeds),
        time_predictions: Some(TimePredictionsWire {
            resolved,
            unresolved,
        }),
        service_alerts,
    };
    json_response(
        200,
        serde_json::to_string(&wire).expect("static wire shape serialises"),
    )
}
