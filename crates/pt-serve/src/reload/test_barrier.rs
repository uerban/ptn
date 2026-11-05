//! Deterministic park primitive for the reload coalescing test (rev 3).
//!
//! The runner exposes an optional `Arc<ReloadBarrier>` field that, if set,
//! parks the inner reload loop between validation and swap. The test thread
//! releases the park via [`ReloadBarrier::release`] after publishing a SECOND
//! generation, deterministically reproducing the SIGHUP-during-reload race
//! that rev 2's design tried to test with sleeps.
//!
//! ## Why a custom barrier (not `std::sync::Barrier`)
//!
//! `std::sync::Barrier::new(2)` requires BOTH parties to call `wait()` to
//! release. The test thread doesn't want to "wait" — it wants to "release
//! AFTER asserting the runner has reached the rendezvous". The custom shape
//! gives us two distinct operations:
//!
//! - [`ReloadBarrier::wait_for_arrival`] (test side): blocks until the
//!   runner has reached the barrier. Returns immediately if the runner has
//!   already arrived.
//! - [`ReloadBarrier::release`] (test side): unblocks the runner.
//! - [`ReloadBarrier::park`] (runner side): parks the runner until release.
//!
//! Internally we use a `Mutex<State>` + two `Condvar`s. The test can poll
//! arrival without holding the runner's lock continuously.
//!
//! ## Why no `#[cfg(...)]` gate
//!
//! Stage 2 ships the barrier unconditionally so the integration test can
//! exercise it without a feature flag (the symbol is unused in prod paths
//! unless callers explicitly install a barrier on the runner — which only
//! tests do). A future-task hardening pass can move this behind a
//! `test-barrier` feature once `ServerConfig` carries the toggle.

use std::sync::{Condvar, Mutex};

/// The two-stage rendezvous shared between the runner and the test.
pub struct ReloadBarrier {
    state: Mutex<BarrierState>,
    /// Signalled when the runner enters [`park`](Self::park) — wakes the
    /// test thread blocked on [`wait_for_arrival`](Self::wait_for_arrival).
    arrived: Condvar,
    /// Signalled when the test calls [`release`](Self::release) — wakes
    /// the runner thread blocked in `park`.
    released: Condvar,
}

#[derive(Default, Debug)]
struct BarrierState {
    /// Set true by the runner on entering `park`.
    arrived: bool,
    /// Set true by the test calling `release`; consumed by the runner.
    released: bool,
    /// Sticky disarm flag: once the test thread has called
    /// [`ReloadBarrier::disarm`], subsequent `park()` calls return
    /// immediately. Used to make the coalescing test's follow-up reload
    /// (the one triggered by the pending-reload latch) NOT block forever
    /// at the same barrier as the first reload.
    disarmed: bool,
}

impl ReloadBarrier {
    /// Build a fresh barrier in the un-arrived, un-released state.
    pub fn new() -> Self {
        Self {
            state: Mutex::new(BarrierState::default()),
            arrived: Condvar::new(),
            released: Condvar::new(),
        }
    }

    /// Runner-side: park until [`release`](Self::release) is called.
    ///
    /// After release, the barrier is reset (`arrived=false, released=false`)
    /// so the SAME `Arc<ReloadBarrier>` can be reused across multiple reload
    /// passes in one test if the test thread re-arms by releasing again.
    ///
    /// If the barrier has been [`disarm`](Self::disarm)ed, park is a no-op —
    /// the coalescing test uses this so the LATCH-driven follow-up reload
    /// doesn't deadlock on a second `park()` no one will release.
    pub fn park(&self) {
        let mut g = self.state.lock().expect("barrier state poisoned");
        if g.disarmed {
            return;
        }
        g.arrived = true;
        self.arrived.notify_all();
        while !g.released && !g.disarmed {
            g = self.released.wait(g).expect("barrier released wait");
        }
        // Reset so the next reload pass starts fresh — but only if not
        // disarmed (disarm survives release).
        g.arrived = false;
        g.released = false;
    }

    /// Permanently turn the barrier into a pass-through. Subsequent
    /// `park()` calls return immediately; any pending `park()` is woken.
    /// Used by the coalescing test BEFORE releasing the first park, so
    /// the latch-driven follow-up reload doesn't block on a second
    /// park-and-no-releaser deadlock.
    pub fn disarm(&self) {
        let mut g = self.state.lock().expect("barrier state poisoned");
        g.disarmed = true;
        self.released.notify_all();
    }

    /// Test-side: block until the runner enters `park`. Returns immediately
    /// if the runner has already arrived (the test can call this AFTER
    /// triggering the reload to avoid a TOCTOU race).
    pub fn wait_for_arrival(&self) {
        let mut g = self.state.lock().expect("barrier state poisoned");
        while !g.arrived {
            g = self.arrived.wait(g).expect("barrier arrival wait");
        }
    }

    /// Test-side: wake the parked runner. The runner resets the barrier on
    /// wakeup so subsequent reloads can reuse the same handle.
    pub fn release(&self) {
        let mut g = self.state.lock().expect("barrier state poisoned");
        g.released = true;
        self.released.notify_all();
    }
}

impl Default for ReloadBarrier {
    fn default() -> Self {
        Self::new()
    }
}
