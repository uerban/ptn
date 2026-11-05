//! Two-stage SIGTERM drain controller.
//!
//! ## Why two stages
//!
//!
//! 1. **`/ready` flips to 503 immediately** on SIGTERM. The LB (k8s Service / nginx upstream
//! healthcheck) needs to see the 503 so it removes the pod from the rotation — otherwise new
//! requests would keep landing on a process that's about to close the listener.
//! 2. **PreStop grace
//! sleep (`prestop_grace_secs`, default 5)**. While the LB observes 503 and finishes its dampening
//! window, the listener still accepts traffic — any in-flight request from BEFORE the flip still
//! completes via the normal path.
//! 3. **`stop_accepting()` closes the accept loop**. After the grace
//! expires, the listener no longer hands new connections to workers. Workers exit their
//! `recv_timeout(100ms)` cycle as soon as the stop flag is observed.
//! 4. **Bounded join**. Workers
//! join up to `request_timeout`. Because the per-request watchdog fires at exactly
//! `request_timeout`, a worker that's still pinned to an in-flight request is guaranteed to be
//! unstuck within the bound — the dispatcher drops the `tiny_http::Request` without responding, the
//! recv_timeout loop re-checks the stop flag, and the worker exits.
//! 5. **`exit(0)`** even when
//! stage 4 hits the timeout. Rationale: a timeout-induced drain is the watchdog working AS DESIGNED
//! — the orchestrator asked us to shut down, and we did. Returning exit code 1 would imply
//! "shutdown failed", which is not what happened (the transport-enforced timeout is the
//! force-drain mechanism).
//!
//!
//! That thread is gone — the controller below now owns the bridge, runs all four stages in
//! sequence, and returns the [`DrainOutcome`] so `main.rs` knows what exit code to pass to
//! `std::process::exit`.
//!
//! ## In-process test surface
//!
//! `initiate_drain` does NOT call `std::process::exit` itself — it returns
//! the `exit_code` inside [`DrainOutcome`]. This is what makes the tests in
//! `tests/shutdown.rs` possible: they drive the controller in-process,
//! assert on the stage timestamps, and check that the exit code is 0.
//! `main.rs` is the only call site that materialises the exit code by
//! handing it to `std::process::exit`.

use crate::http::WorkerPool;
use crate::ops::Metrics;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Per-stage timestamps + duration + exit code reported by
/// [`DrainController::initiate_drain`]. The fields are public so tests can
/// assert on the sequencing (`stage_1 <= stage_3 <= stage_4`) and on the
/// total wall-clock duration relative to `prestop_grace + request_timeout`.
#[derive(Debug, Clone)]
pub struct DrainOutcome {
    /// The exit code `main.rs` should pass to `std::process::exit`. Always `0` today — even on
    /// forced drain (request timeout) — per the rationale. The field is kept as `i32` so future
    /// variants (e.g. reload-runner crash) can surface a distinct code without breaking callers.
    pub exit_code: i32,
    /// Instant at which the controller flipped `/ready` to 503. This is
    /// the FIRST observable side effect of drain — the LB integration
    /// path depends on it firing essentially synchronously with SIGTERM
    /// receipt.
    pub stage_1_ready_503_at: Instant,
    /// Instant at which the controller called
    /// [`WorkerPool::stop_accepting`]. Equals `stage_1` +
    /// `prestop_grace_secs` (modulo scheduler jitter). The interval
    /// `[stage_1, stage_3)` is the grace window during which the listener
    /// still accepts new connections.
    pub stage_3_stop_accepting_at: Instant,
    /// Instant at which [`WorkerPool::join`] returned. Equals
    /// `stage_3` + (≤ `request_timeout` for forced drain, or whatever
    /// the actual in-flight requests took for a normal drain).
    pub stage_4_join_complete_at: Instant,
    /// Total wall-clock duration of the drain, measured from `stage_1`
    /// to `stage_4`. Roughly `prestop_grace + actual-drain` — bounded
    /// above by `prestop_grace + request_timeout` modulo a small
    /// scheduler-induced overshoot from `recv_timeout(100ms)`.
    pub total_duration: Duration,
}

/// Two-stage SIGTERM drain orchestrator. One instance per process; built
/// in `main.rs` (or in tests) and consumed by [`Self::initiate_drain`].
///
/// **Construction policy.** Tests build a [`DrainController`] directly
/// from `WorkerPool::new` + `Metrics::new`; production builds it after the
/// reload runner is wired so the SIGTERM-triggered shutdown flag is the
/// thing that releases `initiate_drain`. See `main.rs` for the canonical
/// wiring.
pub struct DrainController {
    /// The worker pool to drain. Consumed by [`Self::initiate_drain`] —
    /// the controller takes ownership so callers can't accidentally race
    /// a second drain.
    worker_pool: WorkerPool,
    /// Metrics surface — `stage_1` calls
    /// [`Metrics::set_ready_503`] so the aux-listener `/ready` flips
    /// instantly. The atomic flag is `SeqCst` so concurrent readers on
    /// the aux worker thread observe the flip across the next
    /// `recv_timeout` cycle.
    metrics: Arc<Metrics>,
    /// Stage 2 sleep duration. The default-via-`ServerConfig` is 5
    /// seconds (matches the spec); tests pass 100–250ms so the
    /// assertion-bearing test runtimes stay under 1 second.
    prestop_grace: Duration,
    /// Stage 4 bound — kept on the struct for symmetry with the constructor signature (callers
    /// compute it from `ServerConfig::request_timeout_ms`). It is NOT passed to `WorkerPool::join`
    /// — the per-request watchdog registered the same value at request-dispatch time and is the
    /// authoritative bound; see `WorkerPool::join` doc-comment.
    #[allow(dead_code)]
    request_timeout: Duration,
}

impl DrainController {
    /// Build a controller. `request_timeout` should match
    /// `ServerConfig::request_timeout_ms` — the per-request watchdog
    /// fires on the SAME bound, and the two need to agree so the join
    /// is guaranteed to return when a request hits its deadline.
    pub fn new(
        worker_pool: WorkerPool,
        metrics: Arc<Metrics>,
        prestop_grace: Duration,
        request_timeout: Duration,
    ) -> Self {
        Self {
            worker_pool,
            metrics,
            prestop_grace,
            request_timeout,
        }
    }

    /// Run the four-stage drain and return the outcome. The caller (which
    /// is `main.rs` in production) is responsible for handing the
    /// `exit_code` to `std::process::exit`.
    ///
    /// `initiate_drain` consumes `self` — drain is one-shot.
    pub fn initiate_drain(self) -> DrainOutcome {
        // Stage 1: flip /ready to 503 immediately. SeqCst on the set so
        // the aux worker observes the flip on its next route resolution
        // — `recv_timeout(100ms)` means the LB sees the new status
        // within ~100ms.
        let stage_1_ready_503_at = Instant::now();
        self.metrics.set_ready_503();

        // Stage 2: sleep `prestop_grace` so the LB drains. In tests this
        // is 100-250ms; in production the operator pins it via
        // ServerConfig (default 5s).
        std::thread::sleep(self.prestop_grace);

        // Stage 3: close the accept loop. Workers exit their
        // recv_timeout(100ms) cycle as soon as the stop flag is
        // observed. New connections after this point get a TCP RST.
        let stage_3_stop_accepting_at = Instant::now();
        self.worker_pool.stop_accepting();

        // Stage 4: join with the bounded-time deadline. The per-request watchdog fires at
        // `request_timeout` and flips the ticket's `timed_out` flag; the dispatcher drops the
        // Request without responding; the worker loop returns to the top, sees `stop_flag`, exits.
        // WorkerPool::join itself joins each thread sequentially; the bound is `request_timeout`
        // because every worker observes the same per-request deadline.
        self.worker_pool.join();
        let stage_4_join_complete_at = Instant::now();

        // Stage 5: assemble the outcome. exit_code is always 0 today —
        // see the rationale in the module-level doc. A future variant
        // for "shutdown crashed" would set exit_code != 0 here.
        DrainOutcome {
            exit_code: 0,
            stage_1_ready_503_at,
            stage_3_stop_accepting_at,
            stage_4_join_complete_at,
            total_duration: stage_4_join_complete_at
                .saturating_duration_since(stage_1_ready_503_at),
        }
    }
}

/// Bridge thread: poll the reload runner's `shutdown` `AtomicBool`, and once
/// it's set (SIGTERM observed by the typed-signal loop), invoke the supplied
/// callback exactly once. The thread exits after the callback returns.
///
/// **Why a polling thread instead of a Condvar.** The shutdown flag is set
/// from inside [`crate::reload::ReloadRunner::signal_loop`], which is the
/// only owner of the typed `Signals` iterator. Adding a Condvar there would
/// couple the reload runner to the drain controller; polling at 100ms is
/// cheap (one atomic load per tick) and keeps the two modules decoupled.
///
/// The 100ms tick matches the worker pool's own `recv_timeout(100ms)` —
/// SIGTERM observability across the whole process is consistently
/// ~100ms-bounded.
pub fn spawn_shutdown_observer<F>(shutdown: Arc<AtomicBool>, on_shutdown: F)
where
    F: FnOnce() + Send + 'static,
{
    std::thread::Builder::new()
        .name("pt-serve-shutdown-observer".into())
        .spawn(move || loop {
            if shutdown.load(Ordering::SeqCst) {
                on_shutdown();
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        })
        .expect("spawn pt-serve-shutdown-observer");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shutdown observer fires exactly once when the flag is flipped.
    /// Unit-level guard: a regression that polls in a tight loop without
    /// the `break` would fire the callback multiple times.
    #[test]
    fn shutdown_observer_fires_callback_once_on_flag_flip() {
        let flag = Arc::new(AtomicBool::new(false));
        let counter = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let counter_clone = Arc::clone(&counter);
        spawn_shutdown_observer(Arc::clone(&flag), move || {
            counter_clone.fetch_add(1, Ordering::SeqCst);
        });
        // Sleep so the observer thread spins once and observes false.
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(counter.load(Ordering::SeqCst), 0, "no fire before flag");
        flag.store(true, Ordering::SeqCst);
        // Wait up to ~500ms for the observer to fire.
        let deadline = Instant::now() + Duration::from_millis(500);
        while counter.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            counter.load(Ordering::SeqCst),
            1,
            "observer fired exactly once"
        );
        // Give the observer thread time to exit — a subsequent flag flip
        // must NOT re-fire because the thread broke out of the loop.
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(counter.load(Ordering::SeqCst), 1, "no re-fire");
    }
}
