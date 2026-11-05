//! Worker pool with split main + auxiliary listeners.
//!
//! ## Why two listeners?
//!
//! the main listener serves `/plan` (CPU-heavy, can saturate the worker pool under load). The
//! auxiliary listener serves the lightweight Prometheus + lifecycle scrape surface (`/metrics`,
//! `/ready`, `/version`, `/health`) on its own port and its own single-thread pool. A slow `/plan`
//! storm on the main pool no longer head-of-line-blocks a Prometheus scrape or a k8s liveness probe
//! — the aux listener has its own accept queue, its own worker, and its own dispatch path.
//!
//! ## Routing
//!
//! Both listeners share the SAME [`dispatch`](super::dispatch) function, but
//! the aux listener passes [`ListenerKind::Auxiliary`], which exposes only
//! `/metrics`, `/ready`, `/version`, `/health`, and `/health/rt`. Application
//! routes stay on the main pool so expensive work cannot monopolize the sole
//! scrape worker.
//!
//! ## Lifecycle
//!
//! [`WorkerPool::new`] binds both listeners, asserts `tiny_http::Request`
//! crosses thread boundaries (the `Send` requirement that lets workers receive
//! from a shared `Arc<Server>`), then spawns `worker_pool_size` main workers +
//! 1 aux worker. Each worker uses `recv_timeout(100ms)` so the cooperative
//! stop-flag check fires within ~100ms of `stop_accepting()`.
//!
//! [`WorkerPool::stop_accepting`] flips the shared `AtomicBool`; the workers
//! observe it on the next timeout and exit their loops.
//!
//! [`WorkerPool::join`] joins every worker thread.

use crate::http::server::dispatch;
use crate::ops::{ServerCtx, TimeoutRegistry, TimeoutWatchdog};
use crate::router::ListenerKind;
use pt_core::ScanState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tiny_http::Server;

// Compile-time assertion: a `tiny_http::Request` must be `Send` so a worker
// thread can take ownership of one off the shared `Arc<Server>`. If a future
// tiny_http bump regresses this, the build fails here rather than in the body
// of `WorkerPool::new`.
static_assertions::assert_impl_all!(tiny_http::Request: Send);

/// Errors surfaced by [`WorkerPool::new`].
#[derive(Debug, thiserror::Error)]
pub enum WorkerPoolError {
    /// Either listener failed to bind. The wrapped string carries the
    /// originating tiny_http error so the operator log identifies which
    /// listener (main vs aux) failed via the address it tried to bind.
    #[error("bind failed: {0}")]
    Bind(String),
}

/// Main + auxiliary listener worker pool. One [`WorkerPool`] per process.
pub struct WorkerPool {
    main_workers: Vec<JoinHandle<()>>,
    aux_worker: JoinHandle<()>,
    /// Cooperative stop signal — workers read on their `recv_timeout` cycle.
    /// `SeqCst` on the store side; `Relaxed` on the worker-side load is
    /// sufficient because the worker re-enters the loop on a timeout, which
    /// already provides the memory barrier we need.
    stop_flag: Arc<AtomicBool>,
    /// Bound address of the main listener — returned by [`WorkerPool::main_addr`]
    /// so `main.rs` can print it (test-harness's stdout-reader looks for this
    /// string to know the server is up).
    main_addr: std::net::SocketAddr,
    /// Bound address of the aux listener — exposed for smoke tests +
    /// operator log clarity.
    aux_addr: std::net::SocketAddr,
    /// shared timeout registry. Workers register/unregister per request; the companion watchdog
    /// thread scans and fires `request_timeouts_total` for slots past deadline. `Arc` so tests can
    /// observe `len()` and the registered counter from outside the pool.
    timeout_registry: Arc<TimeoutRegistry>,
    /// watchdog thread handle. `Option` so [`WorkerPool::join`] can `take()` it on the way out —
    /// shutdown calls [`TimeoutWatchdog::shutdown`] which joins the watchdog thread.
    timeout_watchdog: Option<TimeoutWatchdog>,
}

impl WorkerPool {
    /// Bind both listeners and spawn the worker threads. The pool keeps
    /// running until [`WorkerPool::stop_accepting`] is called (typically from
    /// the SIGTERM signal handler) and [`WorkerPool::join`] returns.
    ///
    /// `worker_pool_size` is the count for the MAIN listener only — the aux
    /// listener always has exactly one worker (it serves cheap routes).
    pub fn new(
        listen_addr: &str,
        metrics_listen_addr: &str,
        worker_pool_size: usize,
        ctx: Arc<ServerCtx>,
    ) -> Result<Self, WorkerPoolError> {
        let request_timeout = Duration::from_millis(ctx.config.request_timeout_ms);
        Self::new_with_timeout(
            listen_addr,
            metrics_listen_addr,
            worker_pool_size,
            ctx,
            request_timeout,
            Duration::from_millis(100),
        )
    }

    /// Construct a [`WorkerPool`] with explicit timeout knobs. Production
    /// code goes through [`WorkerPool::new`] (which reads `request_timeout_ms`
    /// from `ctx.config`); tests use this overload to pin a short timeout
    /// + a tight scan interval without smuggling synthetic config.
    pub fn new_with_timeout(
        listen_addr: &str,
        metrics_listen_addr: &str,
        worker_pool_size: usize,
        ctx: Arc<ServerCtx>,
        request_timeout: Duration,
        watchdog_scan_interval: Duration,
    ) -> Result<Self, WorkerPoolError> {
        let main_server = Server::http(listen_addr)
            .map(Arc::new)
            .map_err(|e| WorkerPoolError::Bind(format!("main listener {listen_addr}: {e}")))?;
        let aux_server = Server::http(metrics_listen_addr)
            .map(Arc::new)
            .map_err(|e| {
                WorkerPoolError::Bind(format!("aux listener {metrics_listen_addr}: {e}"))
            })?;

        let main_addr = main_server
            .server_addr()
            .to_ip()
            .ok_or_else(|| WorkerPoolError::Bind("main listener has no TCP address".into()))?;
        let aux_addr = aux_server
            .server_addr()
            .to_ip()
            .ok_or_else(|| WorkerPoolError::Bind("aux listener has no TCP address".into()))?;

        // instantiate the timeout registry + spawn the watchdog BEFORE the worker threads so the
        // first request can never observe a `None` registry.
        let timeout_registry = TimeoutRegistry::new(request_timeout, Arc::clone(&ctx.metrics));
        let timeout_watchdog =
            TimeoutWatchdog::start(Arc::clone(&timeout_registry), watchdog_scan_interval);

        let stop_flag = Arc::new(AtomicBool::new(false));
        let mut main_workers = Vec::with_capacity(worker_pool_size);
        for _ in 0..worker_pool_size {
            let srv = Arc::clone(&main_server);
            let stop = Arc::clone(&stop_flag);
            let ctx = Arc::clone(&ctx);
            let reg = Arc::clone(&timeout_registry);
            main_workers.push(thread::spawn(move || {
                main_worker_loop(srv, stop, ctx, reg);
            }));
        }

        let aux_worker = {
            let srv = Arc::clone(&aux_server);
            let stop = Arc::clone(&stop_flag);
            let ctx = Arc::clone(&ctx);
            let reg = Arc::clone(&timeout_registry);
            thread::spawn(move || {
                aux_worker_loop(srv, stop, ctx, reg);
            })
        };

        Ok(Self {
            main_workers,
            aux_worker,
            stop_flag,
            main_addr,
            aux_addr,
            timeout_registry,
            timeout_watchdog: Some(timeout_watchdog),
        })
    }

    /// Main listener bound address — printed by `main.rs` on startup so the
    /// test harness's stdout reader can discover the ephemeral port.
    pub fn main_addr(&self) -> std::net::SocketAddr {
        self.main_addr
    }

    /// Auxiliary listener bound address — exposed for smoke tests and
    /// operator log clarity. `main.rs` prints this alongside `main_addr` so
    /// the scrape target is discoverable without inspecting the config.
    pub fn aux_addr(&self) -> std::net::SocketAddr {
        self.aux_addr
    }

    /// Clone the stop flag — the SIGTERM handler stores `true` from a different thread (the reload
    /// runner's signal_loop) to trigger drain.
    pub fn stop_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.stop_flag)
    }

    /// Cooperative shutdown: flip the stop flag. Workers exit on their next
    /// `recv_timeout` tick (≤ ~100 ms). Call once from any thread; idempotent.
    pub fn stop_accepting(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
    }

    /// Block until every worker thread has returned, then shutdown the
    /// timeout watchdog. The bounded-time guarantee comes from two places
    /// working together:
    ///
    /// 1. [`Self::stop_accepting`] must be called BEFORE `join` (the
    /// [`crate::ops::DrainController`] does this in stage 3). Workers observe the stop flag on
    /// their next `recv_timeout(100ms)` tick and exit the loop.
    /// 2. For workers currently pinned to
    /// an in-flight request: the per-request watchdog fires the `timed_out` flag at exactly
    /// `request_timeout` (registered when the request was dispatched); the dispatcher drops the
    /// `tiny_http::Request` without responding; the dispatch frame returns and the recv loop
    /// re-checks the stop flag. The per-request watchdog is configured at registration time, NOT at
    /// join time — this method takes no timeout argument because it has nothing to do with it.
    ///
    /// The realistic ceiling on `join` is `max(in-flight request_timeout) +
    /// ~100ms` (one recv_timeout cycle).
    pub fn join(mut self) {
        for h in self.main_workers.drain(..) {
            let _ = h.join();
        }
        // Replacing `self.aux_worker` with a sentinel is ugly; instead we
        // restructure to allow take()-and-join.
        let aux_worker = std::mem::replace(&mut self.aux_worker, thread::spawn(|| {}));
        let _ = aux_worker.join();
        if let Some(wd) = self.timeout_watchdog.take() {
            wd.shutdown();
        }
    }

    /// Shared reference to the timeout registry — tests use this to assert
    /// `len()` / `request_timeouts_total` interactions from outside the
    /// pool. Not used in production code paths today.
    pub fn timeout_registry(&self) -> Arc<TimeoutRegistry> {
        Arc::clone(&self.timeout_registry)
    }
}

/// Main-listener worker loop. Owns a lazy-init `ScanState` (per-worker
/// scratch for `/plan`) and dispatches everything else through the shared
/// router.
fn main_worker_loop(
    srv: Arc<Server>,
    stop: Arc<AtomicBool>,
    ctx: Arc<ServerCtx>,
    timeout_registry: Arc<TimeoutRegistry>,
) {
    let mut scan_state: Option<ScanState> = None;
    while !stop.load(Ordering::Relaxed) {
        match srv.recv_timeout(Duration::from_millis(100)) {
            Ok(Some(req)) => {
                dispatch(
                    &ctx,
                    &mut scan_state,
                    req,
                    Some(&timeout_registry),
                    ListenerKind::Public,
                );
            }
            Ok(None) => {
                // recv_timeout fired; loop and re-check the stop flag.
            }
            Err(_) => {
                // Server closed — drop out of the loop. The Arc<Server> is
                // dropped when the last worker exits and the pool owner
                // releases its own clone.
                break;
            }
        }
    }
}

/// Auxiliary-listener worker loop. Single thread; runs the shared dispatcher
/// with a lifecycle-only route table so application work cannot block scrapes.
/// `scan_state` exists only because `dispatch` takes the common signature; aux
/// routing never reaches `/plan`.
fn aux_worker_loop(
    srv: Arc<Server>,
    stop: Arc<AtomicBool>,
    ctx: Arc<ServerCtx>,
    timeout_registry: Arc<TimeoutRegistry>,
) {
    let mut scan_state: Option<ScanState> = None;
    while !stop.load(Ordering::Relaxed) {
        match srv.recv_timeout(Duration::from_millis(100)) {
            Ok(Some(req)) => {
                dispatch(
                    &ctx,
                    &mut scan_state,
                    req,
                    Some(&timeout_registry),
                    ListenerKind::Auxiliary,
                );
            }
            Ok(None) => {}
            Err(_) => break,
        }
    }
}
