//! Producer-side `/healthz` + `/metrics` HTTP server.
//!
//! When the producer runs as a long-lived k8s sidecar, k8s wants a liveness
//! probe so a stuck producer gets restarted automatically. We expose a
//! tiny tiny_http listener on `--liveness-listen-addr <addr>` (default
//! production: `127.0.0.1:9100`). Three endpoints:
//!
//! - `GET /healthz` → 200 when the periodic-refresh loop iteration is
//!   recent (< `2 × refresh_interval`), 503 when stale.
//! - `GET /metrics` → Prometheus text exposition with the producer counter
//!   set:
//!     - `producer_publish_total` — successful publishes.
//!     - `producer_last_success_timestamp_seconds` — Unix time of the last
//!       successful publish (0 until the first publish).
//!     - `producer_lock_wait_seconds` — total seconds spent waiting for
//!       `producer.lock`. (Single-producer deployments accrue 0; multi-
//!       producer-host setups would see this grow if a republish overlapped
//!       a tick.)
//!     - `producer_validation_failures_total` — offline-validate aborts at
//!       step 7 of the publish protocol.
//! - Any other path → 404.
//!
//! ## Why tiny_http
//!
//! The producer already has it as a dep (used by the legacy P3 readiness server
//! in `http.rs`). Pulling in a second HTTP crate just for the liveness
//! endpoint would bloat the build with no win. The listener runs on a
//! dedicated background thread; the periodic-refresh loop never blocks on it.
//!
//! ## Health state model
//!
//! [`HealthState`] is shared via `Arc<Mutex<HealthState>>`. The
//! periodic-refresh loop holds the only writer; the liveness thread holds
//! a clone and only ever reads. We use a `Mutex` (not `RwLock`) because the
//! liveness thread's read is sub-microsecond and a single mutex avoids the
//! `RwLock` writer-starvation gotcha.

use std::io::Cursor;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

/// Producer health state. The periodic-refresh loop mutates this; the
/// liveness HTTP thread reads it.
#[derive(Debug, Clone)]
pub struct HealthState {
    /// When the periodic-refresh loop last completed one iteration
    /// (success or failure). `None` at startup before the first tick has
    /// finished.
    pub last_loop_at: Option<Instant>,
    /// Successful publishes since process start. Rendered as
    /// `producer_publish_total{result="ok"}`.
    pub publish_ok: u64,
    /// Failed publishes (any non-success exit from the tick). Rendered as
    /// `producer_publish_total{result="failed"}`. The
    /// `PtServeReloadStuck`-adjacent alert annotation references this
    /// label.
    pub publish_failed: u64,
    /// Publishes skipped because producer.lock was held by another
    /// process and the wait would exceed configured tolerance. Rendered
    /// as `producer_publish_total{result="paused"}`.
    pub publish_paused: u64,
    /// Wall-clock time of the most recent successful publish. `None` until
    /// the first success.
    pub last_success_at: Option<SystemTime>,
    /// Total seconds spent waiting for `producer.lock`. We aggregate as f64
    /// so the Prometheus exposition is a single counter — the bucketing
    /// histogram form is out of scope (k8s alerting keys off the running
    /// sum + rate).
    pub lock_wait_seconds_sum: f64,
    /// Step-7 offline-validate failures.
    pub validation_failures: u64,
    /// Ticks skipped because the `pt-serve.version` sentinel reported a PTB
    /// version older than the producer requires, or was malformed. These are
    /// NOT operator-initiated pauses — they indicate a deploy-ordering issue.
    /// Rendered as `pt_producer_pt_serve_version_skips_total`.
    pub pt_serve_version_skips: u64,
    /// The generation `current.json` pointed at, on disk, when the process
    /// started. Lets `/readyz` report ready while the first tick of a
    /// restarted producer is still building — see [`render_readyz`].
    pub generation_on_disk: Option<String>,
}

impl HealthState {
    /// Convenience: sum of all per-result publish counters. Used by
    /// callers that want a single rate without faceting on result.
    pub fn publish_total(&self) -> u64 {
        self.publish_ok
            .saturating_add(self.publish_failed)
            .saturating_add(self.publish_paused)
    }
}

impl Default for HealthState {
    fn default() -> Self {
        Self {
            last_loop_at: None,
            publish_ok: 0,
            publish_failed: 0,
            publish_paused: 0,
            last_success_at: None,
            lock_wait_seconds_sum: 0.0,
            validation_failures: 0,
            pt_serve_version_skips: 0,
            generation_on_disk: None,
        }
    }
}

/// Configuration for the liveness server.
#[derive(Debug, Clone)]
pub struct LivenessConfig {
    /// Address to bind the listener on.
    pub listen_addr: SocketAddr,
    /// `refresh_interval`; staleness threshold = 2 × this.
    pub refresh_interval: Duration,
}

/// Render `/healthz` body. Returns (status_code, body) where status_code
/// is 200 when the loop is recent, 503 when stale, and 200 with body
/// `loop_pending` BEFORE the very first tick has completed (k8s
/// `initialDelaySeconds` will tolerate this).
///
/// `/healthz` is **liveness only**. It does NOT gate on the first successful
/// publish — use [`render_readyz`] for the readiness signal that compose
/// `depends_on: service_healthy` and k8s `readinessProbe` should consume.
/// Conflating the two is the failure mode the 7-perspective review surfaced:
/// 4 reviewers independently noted that `/healthz` returning 200 during
/// `loop_pending` lets downstream backends boot before the producer has
/// published anything, silently regressing to network-side GTFS.
pub fn render_healthz(
    state: &HealthState,
    now: Instant,
    refresh_interval: Duration,
) -> (u16, String) {
    let threshold = refresh_interval.saturating_mul(2);
    match state.last_loop_at {
        None => (200, "loop_pending\n".into()),
        Some(t) => {
            let age = now.saturating_duration_since(t);
            if age <= threshold {
                (200, format!("ok loop_age_secs={}\n", age.as_secs()))
            } else {
                (
                    503,
                    format!(
                        "stale loop_age_secs={} threshold_secs={}\n",
                        age.as_secs(),
                        threshold.as_secs()
                    ),
                )
            }
        }
    }
}

/// Render `/readyz` body. Returns (status_code, body) where status_code is
/// 200 once `last_success_at` is set (the first successful publish has
/// completed and `current.json` references a real bundle on disk), 503
/// otherwise — with one exception: a producer restarted over a data root
/// whose `current.json` already references a generation on disk is ready
/// while its FIRST tick is still running. That generation is what pt-serve
/// serves meanwhile, and a full build (Paris: tens of minutes) would
/// otherwise outlast any reasonable healthcheck grace period and mark a
/// working stack unhealthy. The grace ends with the first tick: if it
/// fails, pauses, or is skipped by the version gate, `/readyz` drops back to
/// 503 until a publish succeeds, so a producer that cannot publish still
/// shows up as unhealthy.
///
/// This is the signal downstream consumers should gate on. Compose
/// `healthcheck:` for `ptn-producer-*` points at this endpoint so that
/// `depends_on: condition: service_healthy` from `backend-*` actually
/// reflects "producer has published a bundle"; backends booting against a
/// not-yet-published producer would fall through `pt-startup.sh`'s
/// `current.json`-resolution to legacy Node-side GTFS, silently bypassing
/// the migration's whole win.
pub fn render_readyz(state: &HealthState) -> (u16, String) {
    let first_tick_running =
        state.publish_failed == 0 && state.publish_paused == 0 && state.pt_serve_version_skips == 0;
    match (&state.last_success_at, &state.generation_on_disk) {
        (Some(_), _) => (200, format!("ready publish_ok={}\n", state.publish_ok)),
        (None, Some(gen)) if first_tick_running => (
            200,
            format!("ready generation_on_disk={gen} first_tick=running\n"),
        ),
        (None, _) => (503, "publish_pending\n".into()),
    }
}

/// Render `/metrics` body in Prometheus text exposition format.
pub fn render_metrics(state: &HealthState) -> String {
    let last_success_unix = state
        .last_success_at
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut out = String::new();
    use std::fmt::Write as _;
    // producer_publish_total now carries a `result` label so the alert
    // pack (PtServeReloadStuck / ProducerStuck) can rate-key off the
    // failed-only series. Zero-value cells are emitted for the three
    // labels so dashboards don't have to handle missing series.
    let _ = writeln!(
        out,
        "# HELP producer_publish_total Publish tick outcomes by result label (ok|failed|paused).\n\
         # TYPE producer_publish_total counter\n\
         producer_publish_total{{result=\"ok\"}} {}\n\
         producer_publish_total{{result=\"failed\"}} {}\n\
         producer_publish_total{{result=\"paused\"}} {}",
        state.publish_ok, state.publish_failed, state.publish_paused
    );
    let _ = writeln!(
        out,
        "# HELP producer_last_success_timestamp_seconds Unix time of the most recent successful publish (0 until first success).\n\
         # TYPE producer_last_success_timestamp_seconds gauge\n\
         producer_last_success_timestamp_seconds {}",
        last_success_unix
    );
    let _ = writeln!(
        out,
        "# HELP producer_lock_wait_seconds Total seconds spent waiting for producer.lock.\n\
         # TYPE producer_lock_wait_seconds counter\n\
         producer_lock_wait_seconds {}",
        state.lock_wait_seconds_sum
    );
    let _ = writeln!(
        out,
        "# HELP producer_validation_failures_total Step-7 offline-validate aborts.\n\
         # TYPE producer_validation_failures_total counter\n\
         producer_validation_failures_total {}",
        state.validation_failures
    );
    let _ = writeln!(
        out,
        "# HELP pt_producer_pt_serve_version_skips_total Ticks skipped because \
         pt-serve.version sentinel reported an incompatible or malformed PTB version \
         (deploy-ordering gate; distinct from operator-initiated producer.paused).\n\
         # TYPE pt_producer_pt_serve_version_skips_total counter\n\
         pt_producer_pt_serve_version_skips_total {}",
        state.pt_serve_version_skips
    );
    out
}

/// Spawn the liveness HTTP server on a background thread. Returns the
/// server's bound address (useful when binding to port 0 in tests).
///
/// The thread runs forever (until the process exits). We don't expose a
/// shutdown channel because the liveness server is process-scoped — when
/// the producer dies, tiny_http's listener fd is closed by the kernel.
pub fn spawn(cfg: LivenessConfig, state: Arc<Mutex<HealthState>>) -> std::io::Result<SocketAddr> {
    // tiny_http binds the address; we surface bind failures to the caller
    // (clap-validation catches typos; an EADDRINUSE here is operator-
    // actionable).
    let server = tiny_http::Server::http(cfg.listen_addr)
        .map_err(|e| std::io::Error::other(format!("tiny_http bind {}: {e}", cfg.listen_addr)))?;
    let addr = match server.server_addr() {
        tiny_http::ListenAddr::IP(a) => a,
        tiny_http::ListenAddr::Unix(_) => {
            return Err(std::io::Error::other(
                "liveness server bound to unix socket; expected IP",
            ))
        }
    };
    let refresh_interval = cfg.refresh_interval;
    std::thread::Builder::new()
        .name("pt-producer-liveness".into())
        .spawn(move || run_loop(server, state, refresh_interval))
        .map_err(|e| std::io::Error::other(format!("spawn pt-producer-liveness: {e}")))?;
    Ok(addr)
}

/// Block the calling thread on the tiny_http server, dispatching to
/// `/healthz` / `/metrics` / 404.
fn run_loop(server: tiny_http::Server, state: Arc<Mutex<HealthState>>, refresh_interval: Duration) {
    for req in server.incoming_requests() {
        let url = req.url().to_string();
        let snapshot: HealthState = {
            let s = state.lock().unwrap_or_else(|e| e.into_inner());
            s.clone()
        };
        let (code, body, content_type) = match url.split('?').next().unwrap_or("") {
            "/healthz" => {
                let (c, b) = render_healthz(&snapshot, Instant::now(), refresh_interval);
                (c, b, "text/plain; charset=utf-8")
            }
            "/readyz" => {
                let (c, b) = render_readyz(&snapshot);
                (c, b, "text/plain; charset=utf-8")
            }
            "/metrics" => (
                200,
                render_metrics(&snapshot),
                "text/plain; version=0.0.4; charset=utf-8",
            ),
            _ => (404, "not found\n".into(), "text/plain; charset=utf-8"),
        };
        let response = tiny_http::Response::new(
            tiny_http::StatusCode(code),
            vec![
                tiny_http::Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes())
                    .expect("content-type header"),
            ],
            Cursor::new(body.into_bytes()),
            None,
            None,
        );
        if let Err(e) = req.respond(response) {
            eprintln!("[producer] liveness response error (non-fatal): {e}");
        }
    }
}

/// Convenience: write the latest health snapshot to an Arc<Mutex<...>>.
/// Used by the periodic-refresh loop to bump fields without taking the
/// mutex twice per tick.
pub fn with_state<F: FnOnce(&mut HealthState)>(state: &Arc<Mutex<HealthState>>, f: F) {
    let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut s);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Within the 2 × refresh-interval window, /healthz returns 200.
    #[test]
    fn healthz_returns_200_when_loop_recent() {
        let t0 = Instant::now();
        let state = HealthState {
            last_loop_at: Some(t0),
            ..HealthState::default()
        };
        let (code, body) = render_healthz(
            &state,
            t0 + Duration::from_secs(30),
            Duration::from_secs(60),
        );
        assert_eq!(code, 200);
        assert!(body.contains("loop_age_secs=30"), "body was: {body}");
    }

    /// Outside 2 × refresh-interval, /healthz returns 503.
    #[test]
    fn healthz_returns_503_when_loop_stale() {
        let t0 = Instant::now();
        let state = HealthState {
            last_loop_at: Some(t0),
            ..HealthState::default()
        };
        let (code, body) = render_healthz(
            &state,
            t0 + Duration::from_secs(300),
            Duration::from_secs(60),
        );
        assert_eq!(code, 503);
        // 2 × 60 = 120 threshold; age = 300 → stale.
        assert!(body.contains("stale"), "body was: {body}");
        assert!(body.contains("threshold_secs=120"), "body was: {body}");
    }

    /// Before the first iteration, /healthz returns 200 with `loop_pending`.
    #[test]
    fn healthz_loop_pending_before_first_iteration() {
        let state = HealthState::default();
        let (code, body) = render_healthz(&state, Instant::now(), Duration::from_secs(60));
        assert_eq!(code, 200);
        assert_eq!(body, "loop_pending\n");
    }

    /// Before any successful publish, /readyz returns 503 — downstream
    /// consumers (compose `service_healthy`, k8s readinessProbe) MUST NOT
    /// gate on `/healthz` because that returns 200 while the first publish
    /// is still in flight (the cold-start race the 7-perspective review
    /// surfaced).
    #[test]
    fn readyz_returns_503_before_first_publish() {
        let state = HealthState::default();
        let (code, body) = render_readyz(&state);
        assert_eq!(code, 503);
        assert_eq!(body, "publish_pending\n");
    }

    /// Even when the loop has completed but no successful publish has
    /// landed (e.g. validation failure on every tick), /readyz stays 503.
    /// `/healthz` would be 200 here — different signals.
    #[test]
    fn readyz_returns_503_when_loop_ticked_but_no_success() {
        let state = HealthState {
            last_loop_at: Some(Instant::now()),
            publish_failed: 3,
            // last_success_at deliberately None.
            ..HealthState::default()
        };
        let (code, body) = render_readyz(&state);
        assert_eq!(code, 503);
        assert_eq!(body, "publish_pending\n");
    }

    /// A restart over a published generation is ready while the first tick
    /// builds; once that tick fails, pauses or is version-skipped, /readyz is
    /// back to 503 until a publish succeeds.
    #[test]
    fn readyz_trusts_the_generation_on_disk_only_until_the_first_tick_ends() {
        let gen = "ab".repeat(32);
        let building = HealthState {
            generation_on_disk: Some(gen.clone()),
            ..HealthState::default()
        };
        let (code, body) = render_readyz(&building);
        assert_eq!(code, 200);
        assert_eq!(
            body,
            format!("ready generation_on_disk={gen} first_tick=running\n")
        );

        for ended in [
            HealthState {
                publish_failed: 1,
                ..building.clone()
            },
            HealthState {
                publish_paused: 1,
                ..building.clone()
            },
            HealthState {
                pt_serve_version_skips: 1,
                ..building.clone()
            },
        ] {
            assert_eq!(render_readyz(&ended), (503, "publish_pending\n".into()));
        }

        let published = HealthState {
            publish_ok: 1,
            publish_failed: 1,
            last_success_at: Some(SystemTime::UNIX_EPOCH),
            ..building
        };
        assert_eq!(render_readyz(&published).0, 200);
    }

    /// Once `last_success_at` is set, /readyz returns 200 and reports the
    /// success counter for operator visibility.
    #[test]
    fn readyz_returns_200_after_first_publish() {
        let state = HealthState {
            last_loop_at: Some(Instant::now()),
            publish_ok: 1,
            last_success_at: Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000)),
            ..HealthState::default()
        };
        let (code, body) = render_readyz(&state);
        assert_eq!(code, 200);
        assert!(body.starts_with("ready publish_ok=1"), "body was: {body}");
    }

    /// /metrics renders all producer series with the result-labelled
    /// producer_publish_total split plus the version-skip counter.
    #[test]
    fn metrics_renders_producer_series() {
        let state = HealthState {
            publish_ok: 7,
            publish_failed: 2,
            publish_paused: 1,
            last_success_at: Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000)),
            lock_wait_seconds_sum: 4.5,
            validation_failures: 2,
            pt_serve_version_skips: 3,
            ..HealthState::default()
        };

        let body = render_metrics(&state);
        // Three labeled cells for the result split.
        assert!(
            body.contains(r#"producer_publish_total{result="ok"} 7"#),
            "body: {body}"
        );
        assert!(
            body.contains(r#"producer_publish_total{result="failed"} 2"#),
            "body: {body}"
        );
        assert!(
            body.contains(r#"producer_publish_total{result="paused"} 1"#),
            "body: {body}"
        );
        assert!(
            body.contains("producer_last_success_timestamp_seconds 1700000000"),
            "body: {body}"
        );
        assert!(
            body.contains("producer_lock_wait_seconds 4.5"),
            "body: {body}"
        );
        assert!(
            body.contains("producer_validation_failures_total 2"),
            "body: {body}"
        );
        assert!(
            body.contains("pt_producer_pt_serve_version_skips_total 3"),
            "body: {body}"
        );
        assert!(body.contains("# TYPE producer_publish_total counter"));
        assert!(body.contains("# TYPE producer_lock_wait_seconds counter"));
        assert!(body.contains("# TYPE pt_producer_pt_serve_version_skips_total counter"));
        // Sanity: the publish_total() convenience accessor sums all three.
        assert_eq!(state.publish_total(), 10);
    }

    /// Spawned server actually serves /healthz over TCP (smoke test).
    #[test]
    fn liveness_server_smoke_serves_healthz() {
        let state = Arc::new(Mutex::new(HealthState::default()));
        let cfg = LivenessConfig {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            refresh_interval: Duration::from_secs(60),
        };
        let addr = spawn(cfg, Arc::clone(&state)).expect("spawn liveness");
        // Set the loop to "just ran" so /healthz returns 200.
        with_state(&state, |s| {
            s.last_loop_at = Some(Instant::now());
            s.publish_ok = 1;
        });
        let mut stream = std::net::TcpStream::connect(addr).expect("connect liveness");
        use std::io::{Read as _, Write as _};
        stream
            .write_all(b"GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
            .expect("write healthz");
        let mut response = String::new();
        stream
            .read_to_string(&mut response)
            .expect("read healthz response");
        assert!(
            response.starts_with("HTTP/1.1 200"),
            "expected 200 OK; got: {response}"
        );
        assert!(response.contains("ok loop_age_secs"), "got: {response}");
    }
}
