//! `GET /metrics` — transport-free handler that wraps the `ops::metrics::render_body(&Metrics)`
//! Prometheus-text body in a [`Resp`]. Lives alongside the other `app/` handlers; no `tiny_http`
//! types appear here (the `http::adapter` materialises `Resp::Prometheus` into a tiny_http response
//! at the single seam).

use crate::app::response::Resp;
use crate::ops::{metrics, Metrics};

pub fn metrics_resp(metrics: &Metrics) -> Resp {
    Resp::Prometheus {
        body: metrics::render_body(metrics),
    }
}
