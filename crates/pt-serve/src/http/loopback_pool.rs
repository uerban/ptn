//! Loopback listener worker pool.
//!
//! ## Why a third listener?
//!
//! The main (`:9000`) and aux (`:9001`) listeners serve the public
//! Contract-A surface. The loopback listener (`:9002`) serves ONLY
//! `GET /api/<city>/scheduled-departures-for-stop` — a route the router 404s
//! on the public listeners ([`crate::router::ListenerKind`]). It is bound on
//! an open `0.0.0.0:9002` but kept unreachable from outside the container by:
//!   1. NO host-port mapping for `9002` in `docker-compose.yml`, and
//!   2. an nginx CI gate (`.github/workflows/nginx-loopback-isolation.yml`)
//!      that fails if any rendered `proxy_pass` targets `:9002` or if the
//!      route string leaks into `nginx/`.
//!
//! ## Routing + isolation
//!
//! All three listeners share the SAME [`dispatch`](super::dispatch) function;
//! the loopback pool passes [`ListenerKind::Loopback`] so `dispatch` selects
//! the loopback route table (one route) and bumps the
//! `loopback_inflight_requests` gauge instead of `inflight_requests`. The
//! loopback workers own NO `ScanState` — the single served route never
//! reaches the `/plan` handler, so `dispatch` is handed `&mut None`.
//!
//! ## Lifecycle
//!
//! [`LoopbackPool::new`] rejects a zero width, binds the listener, sets the
//! `loopback_pool_size` gauge, then spawns exactly `worker_count` workers. It SHARES the
//! [`WorkerPool`](super::WorkerPool)'s `stop_flag` (passed in by `main.rs`)
//! so a single SIGTERM-triggered `stop_accepting()` drains both pools.
//! [`LoopbackPool::join`] joins every worker thread.

use crate::http::server::dispatch;
use crate::ops::ServerCtx;
use crate::router::ListenerKind;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tiny_http::Server;

/// Errors surfaced by [`LoopbackPool::new`].
#[derive(Debug, thiserror::Error)]
pub enum LoopbackPoolError {
    /// Config validation normally catches this before pool construction. Keep
    /// the constructor defensive so direct test/embedding callers cannot bind
    /// a listener with no request consumers.
    #[error("loopback worker count must be >= 1")]
    WorkerCountZero,
    /// The loopback listener failed to bind. The wrapped string carries the
    /// originating tiny_http error + the address that was tried.
    #[error("bind failed: {0}")]
    Bind(String),
}

/// Loopback-listener worker pool. One [`LoopbackPool`] per process, spawned
/// alongside the main [`WorkerPool`](super::WorkerPool).
pub struct LoopbackPool {
    workers: Vec<JoinHandle<()>>,
    /// Bound address of the loopback listener — exposed for operator log
    /// clarity / smoke tests.
    addr: std::net::SocketAddr,
}

impl LoopbackPool {
    /// Bind the loopback listener and spawn exactly `worker_count` worker
    /// threads. The pool shares `stop_flag` with the main worker pool so a
    /// single `stop_accepting()` (SIGTERM drain) terminates both pools'
    /// `recv_timeout` loops within ~100 ms.
    ///
    /// Records the configured `worker_count` into the `loopback_pool_size`
    /// gauge so operators can confirm the pool spun up at the expected width.
    pub fn new(
        listen_addr: &str,
        worker_count: usize,
        ctx: Arc<ServerCtx>,
        stop_flag: Arc<AtomicBool>,
    ) -> Result<Self, LoopbackPoolError> {
        if worker_count == 0 {
            return Err(LoopbackPoolError::WorkerCountZero);
        }
        let server = Server::http(listen_addr).map(Arc::new).map_err(|e| {
            LoopbackPoolError::Bind(format!("loopback listener {listen_addr}: {e}"))
        })?;
        let addr = server.server_addr().to_ip().ok_or_else(|| {
            LoopbackPoolError::Bind("loopback listener has no TCP address".into())
        })?;

        ctx.metrics.set_loopback_pool_size(worker_count as u64);

        let mut workers = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            let srv = Arc::clone(&server);
            let stop = Arc::clone(&stop_flag);
            let ctx = Arc::clone(&ctx);
            workers.push(thread::spawn(move || {
                loopback_worker_loop(srv, stop, ctx);
            }));
        }

        Ok(Self { workers, addr })
    }

    /// Loopback listener bound address — `main.rs` prints this alongside the
    /// main/aux addresses so the loopback port is discoverable in the log.
    pub fn addr(&self) -> std::net::SocketAddr {
        self.addr
    }

    /// Block until every loopback worker thread has returned. Mirrors
    /// [`WorkerPool::join`](super::WorkerPool::join): callers MUST have
    /// flipped the shared stop flag first (the main pool's `stop_accepting`
    /// does this) so the workers observe it on their next `recv_timeout` tick.
    pub fn join(self) {
        for h in self.workers {
            let _ = h.join();
        }
    }
}

/// Loopback-listener worker loop. Single served route, so it owns NO
/// `ScanState`: `dispatch` is handed `&mut None` and `None` for the timeout
/// registry (the loopback route is a thin lookup; the watchdog is wired to
/// the main pool only). Models the aux/main loops in
/// [`worker_pool`](super::worker_pool).
fn loopback_worker_loop(srv: Arc<Server>, stop: Arc<AtomicBool>, ctx: Arc<ServerCtx>) {
    while !stop.load(Ordering::Relaxed) {
        match srv.recv_timeout(Duration::from_millis(100)) {
            Ok(Some(req)) => {
                dispatch(&ctx, &mut None, req, None, ListenerKind::Loopback);
            }
            Ok(None) => {
                // recv_timeout fired; loop and re-check the stop flag.
            }
            Err(_) => {
                // Server closed — drop out of the loop.
                break;
            }
        }
    }
}
