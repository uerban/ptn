//! Transport-enforced request timeout watchdog.
//!
//! ## Why a watchdog (option (i)) instead of socket-level timeouts (option (iii))
//!
//! tiny_http 0.12's public API does NOT expose the accepted `TcpStream` to
//! consumer code. `Server::http` / `Server::from_listener` take ownership of a
//! `TcpListener`; the accept loop runs on a private worker thread that hands
//! the connection through an internal `RefinedTcpStream` wrapper before the
//! consumer ever sees a `Request`. We therefore cannot call
//! `set_read_timeout` / `set_write_timeout` on the per-request socket — by the
//! time we hold the `Request`, the stream is sealed inside tiny_http.
//!
//! The implementation here is the spec's option (i): a single shared
//! watchdog thread that tracks per-worker request start instants in a
//! `Mutex<HashMap<WorkerId, Slot>>`. On each scan tick (100 ms by default)
//! the watchdog computes `(now - start)` for every registered slot and, if
//! it exceeds `request_timeout_ms`, sets the slot's `timed_out` flag and
//! increments `request_timeouts_total`.
//!
//! ## Cooperative drop, not preemption
//!
//! Rust has no thread cancellation primitive and tiny_http does not let us
//! shut down the underlying TCP stream from a third thread. The watchdog
//! therefore signals cooperatively:
//!
//! 1. Worker calls [`TimeoutRegistry::register`] before dispatch — receives a
//!    [`TimeoutTicket`] that owns the slot's `timed_out: Arc<AtomicBool>`.
//! 2. Watchdog scans periodically; flips `timed_out` when deadline expires
//!    AND increments `request_timeouts_total` once per request.
//! 3. After the handler returns, the worker checks
//!    [`TimeoutTicket::timed_out`]. If set, the dispatcher SKIPS the
//!    `req.respond()` call and lets `Request` drop. tiny_http's
//!    `RefinedTcpStream::Drop` then closes the underlying stream via
//!    `shutdown(SHUT_READ|SHUT_WRITE)`.
//! 4. The [`TimeoutTicket`] itself is a RAII guard — drop unregisters the
//!    slot so the watchdog doesn't keep firing on a worker that already
//!    moved on.
//!
//! ## Compute-bound vs I/O-bound semantics
//!
//! The watchdog detects ELAPSED-WALL-CLOCK timeouts regardless of whether
//! the worker is stuck on compute (a long RAPTOR scan) or on I/O (a slow
//! reader/writer). The counter increments in both cases. What the watchdog
//! CANNOT do is preempt the worker — it can only set a flag the worker
//! checks at safepoints (handler return; cooperative checks inside long
//! handlers like the parked-test endpoint).
//!
//! Tests assert the realistic semantic: counter ++, `inflight_requests` returns to 0 once the
//! (cooperative) worker exits.

use crate::ops::Metrics;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// Monotonic identifier for an in-flight request slot. The watchdog uses it
/// as the map key; workers receive a fresh id from
/// [`TimeoutRegistry::next_id`] each time they register. `u64` is comfortably
/// past the lifetime-of-a-process saturation point even at 1 M reqs/sec
/// (which pt-serve will never see).
pub type WorkerId = u64;

/// One entry in the watchdog's registry. Owned by the worker thread (via
/// [`TimeoutTicket`]) AND by the watchdog (via the shared map). The
/// `timed_out` flag is the single bit of cross-thread state.
#[derive(Debug)]
struct Slot {
    /// Monotonic instant the worker registered the request. The watchdog
    /// compares `now - start` against the deadline on each scan.
    start: Instant,
    /// Cooperative timeout flag. Watchdog sets it on deadline expiry;
    /// worker reads it at the end of the dispatch frame.
    timed_out: Arc<AtomicBool>,
    /// Sticky flag: once the watchdog has fired the counter for this slot,
    /// it must NOT fire again on subsequent scans before the worker
    /// unregisters. Without this, a worker that stays in dispatch for two
    /// scan ticks past the deadline would double-count.
    fired: bool,
}

/// Shared watchdog state. One [`TimeoutRegistry`] per process; the worker
/// pool holds an `Arc<TimeoutRegistry>`, every worker clones it for
/// register/drop, and the watchdog thread holds another clone.
pub struct TimeoutRegistry {
    /// Per-request slots, keyed by [`WorkerId`]. `Mutex` protects scan +
    /// insert + remove; contention is low (4–8 workers × 1 op/request).
    slots: Mutex<HashMap<WorkerId, Slot>>,
    /// Monotonic source of [`WorkerId`] values. `AtomicU64::fetch_add` is
    /// lock-free and never reused.
    next_id: AtomicU64,
    /// Per-request deadline. Pinned at construction so the operator-visible
    /// `request_timeout_ms` config flag is the single source of truth.
    request_timeout: Duration,
    /// Metrics surface — watchdog calls
    /// [`Metrics::inc_request_timeouts_total`] on each fired slot.
    metrics: Arc<Metrics>,
    /// Cooperative stop signal — flipped by [`TimeoutWatchdog::shutdown`] to
    /// terminate the watchdog thread.
    stop: Arc<AtomicBool>,
}

impl TimeoutRegistry {
    /// Build an empty registry pinned at `request_timeout`. The companion
    /// watchdog thread is spawned by [`TimeoutWatchdog::start`].
    pub fn new(request_timeout: Duration, metrics: Arc<Metrics>) -> Arc<Self> {
        Arc::new(Self {
            slots: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            request_timeout,
            metrics,
            stop: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Register a fresh request slot. Returns a [`TimeoutTicket`] the worker
    /// must hold for the duration of the request — its Drop unregisters the
    /// slot. The `timed_out` flag stays observable after Drop because it's
    /// reachable via the worker's own [`TimeoutTicket::timed_out`] reference.
    pub fn register(self: &Arc<Self>) -> TimeoutTicket {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let timed_out = Arc::new(AtomicBool::new(false));
        {
            let mut g = self.slots.lock().expect("TimeoutRegistry slots poisoned");
            g.insert(
                id,
                Slot {
                    start: Instant::now(),
                    timed_out: Arc::clone(&timed_out),
                    fired: false,
                },
            );
        }
        TimeoutTicket {
            id,
            registry: Arc::clone(self),
            timed_out,
        }
    }

    /// Inspect a single scan tick. Pure function over `(now, slots)` so the
    /// behaviour is unit-testable without spawning a thread. Returns the
    /// number of slots transitioned into the `fired` state on this tick —
    /// callers (the watchdog thread + tests) bump
    /// [`Metrics::inc_request_timeouts_total`] that many times.
    #[doc(hidden)]
    pub fn scan_once(&self, now: Instant) -> u64 {
        let mut fired_this_tick: u64 = 0;
        let mut g = self.slots.lock().expect("TimeoutRegistry slots poisoned");
        for slot in g.values_mut() {
            if slot.fired {
                continue;
            }
            if now.saturating_duration_since(slot.start) >= self.request_timeout {
                slot.timed_out.store(true, Ordering::SeqCst);
                slot.fired = true;
                fired_this_tick += 1;
            }
        }
        fired_this_tick
    }

    /// Current registered-slot count — diagnostic only.
    #[doc(hidden)]
    pub fn len(&self) -> usize {
        self.slots
            .lock()
            .expect("TimeoutRegistry slots poisoned")
            .len()
    }

    #[doc(hidden)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Clone of the cooperative stop flag — used by the watchdog thread's
    /// outer loop to exit cleanly on pool shutdown.
    fn stop_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.stop)
    }

    fn remove_slot(&self, id: WorkerId) {
        let mut g = self.slots.lock().expect("TimeoutRegistry slots poisoned");
        g.remove(&id);
    }
}

/// RAII guard returned by [`TimeoutRegistry::register`]. Owns the slot's
/// `timed_out` flag (worker checks this after the handler returns) and
/// removes the slot from the registry on Drop so the watchdog stops scanning
/// it. Cheap to hold — three `Arc` pointers and a `u64`.
pub struct TimeoutTicket {
    id: WorkerId,
    registry: Arc<TimeoutRegistry>,
    timed_out: Arc<AtomicBool>,
}

impl TimeoutTicket {
    /// True iff the watchdog set the timed-out flag on this slot. The
    /// dispatcher checks this after the handler returns; if `true`, it
    /// drops the [`tiny_http::Request`] without calling `respond` so
    /// tiny_http's internal `RefinedTcpStream::Drop` closes the connection.
    pub fn timed_out(&self) -> bool {
        self.timed_out.load(Ordering::SeqCst)
    }

    /// Clone of the per-slot `timed_out` flag — handed to cooperative
    /// long-running handlers (e.g. the `/test/park` endpoint) so they can
    /// poll and exit early when the deadline expires.
    pub fn timed_out_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.timed_out)
    }

    /// Worker id — used by tests to identify the slot in the registry.
    pub fn id(&self) -> WorkerId {
        self.id
    }
}

impl Drop for TimeoutTicket {
    fn drop(&mut self) {
        self.registry.remove_slot(self.id);
    }
}

/// Handle to the running watchdog thread. Owns the join handle and a stop
/// signal; [`TimeoutWatchdog::shutdown`] flips the signal and joins.
pub struct TimeoutWatchdog {
    handle: Option<JoinHandle<()>>,
    stop: Arc<AtomicBool>,
}

impl TimeoutWatchdog {
    /// Spawn the watchdog thread. The thread scans the registry every
    /// `scan_interval` and increments `request_timeouts_total` for each
    /// slot whose deadline has expired. Exits on `stop` flag flip.
    pub fn start(registry: Arc<TimeoutRegistry>, scan_interval: Duration) -> Self {
        let stop = registry.stop_flag();
        let stop_for_thread = Arc::clone(&stop);
        let handle = thread::Builder::new()
            .name("pt-serve-timeout".into())
            .spawn(move || {
                while !stop_for_thread.load(Ordering::Relaxed) {
                    let fired = registry.scan_once(Instant::now());
                    for _ in 0..fired {
                        registry.metrics.inc_request_timeouts_total();
                    }
                    thread::sleep(scan_interval);
                }
            })
            .expect("spawn timeout watchdog");
        Self {
            handle: Some(handle),
            stop,
        }
    }

    /// Flip the stop flag and join the watchdog thread. Bounded by the
    /// caller's scan_interval (the thread checks the flag at the top of
    /// each loop iteration).
    pub fn shutdown(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Default-case: a single slot whose start instant is `request_timeout`
    /// in the past is fired exactly once. A second scan over the same slot
    /// is a no-op (the `fired` sticky guard).
    #[test]
    fn scan_once_fires_each_slot_exactly_once() {
        let metrics = Metrics::new();
        let reg = TimeoutRegistry::new(Duration::from_millis(100), Arc::clone(&metrics));
        let ticket = reg.register();
        // Immediate scan: deadline has not elapsed yet.
        let now = Instant::now();
        assert_eq!(reg.scan_once(now), 0);
        assert!(!ticket.timed_out());
        // Scan 200ms in the future: fires.
        let later = now + Duration::from_millis(200);
        assert_eq!(reg.scan_once(later), 1);
        assert!(ticket.timed_out());
        // Another scan further still: sticky — does not re-fire.
        let even_later = later + Duration::from_secs(1);
        assert_eq!(reg.scan_once(even_later), 0);
    }

    /// Slot removed via [`TimeoutTicket::drop`] before deadline does not
    /// fire the watchdog — defends the registry against a leaked counter
    /// from a fast request.
    #[test]
    fn dropped_ticket_unregisters_before_deadline() {
        let metrics = Metrics::new();
        let reg = TimeoutRegistry::new(Duration::from_millis(10), Arc::clone(&metrics));
        {
            let _ticket = reg.register();
            assert_eq!(reg.len(), 1);
        }
        assert_eq!(reg.len(), 0, "ticket Drop removed the slot");
        // Even a scan well past the deadline does nothing — slot is gone.
        let later = Instant::now() + Duration::from_secs(1);
        assert_eq!(reg.scan_once(later), 0);
    }

    /// Two concurrent registrations get distinct ids and the watchdog
    /// fires each independently.
    #[test]
    fn multiple_slots_fire_independently() {
        let metrics = Metrics::new();
        let reg = TimeoutRegistry::new(Duration::from_millis(50), Arc::clone(&metrics));
        let a = reg.register();
        let b = reg.register();
        assert_ne!(a.id(), b.id());
        let later = Instant::now() + Duration::from_millis(100);
        assert_eq!(reg.scan_once(later), 2);
        assert!(a.timed_out() && b.timed_out());
    }

    /// End-to-end watchdog: register, sleep past deadline, observe counter
    /// increment + ticket flag. Joining the watchdog is bounded by the
    /// scan_interval.
    #[test]
    fn watchdog_thread_fires_counter_and_flag() {
        let metrics = Metrics::new();
        let reg = TimeoutRegistry::new(Duration::from_millis(50), Arc::clone(&metrics));
        let watchdog = TimeoutWatchdog::start(Arc::clone(&reg), Duration::from_millis(10));
        let ticket = reg.register();
        // Spin until the watchdog fires (bounded ≤ 500ms).
        let deadline = Instant::now() + Duration::from_millis(500);
        while !ticket.timed_out() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(ticket.timed_out(), "watchdog must set timed_out flag");
        // Spin until counter observed (the watchdog increments AFTER setting
        // the flag, so a quick read can race).
        while metrics.request_timeouts_total() == 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(metrics.request_timeouts_total(), 1);
        watchdog.shutdown();
    }
}
