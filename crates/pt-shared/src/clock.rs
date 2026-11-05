//! Pluggable wall-clock source.
//!
//! Reload, staleness, and last-good-age telemetry all key off
//! `SystemTime::now()`. Threading that through a [`Clock`] trait lets tests
//! advance "now" deterministically without sleeping or messing with the OS
//! clock.
//!
//! ## No cfg-gate on `MockClock`
//!
//! The plan originally proposed `#[cfg(any(test, feature = "test-clock"))]`
//! around `MockClock`, but gating it means pt-serve's `[dev-dependencies]`
//! block needs `pt-shared = { path = "...", features = ["test-clock"] }` and
//! each downstream test crate has to remember to flip the feature. `MockClock`
//! is ~10 LOC; we drop the gate and rely on convention (don't use in non-test
//! code). The boundary tests in pt-serve already prevent ambient misuse from
//! creeping into request handlers.

use std::sync::RwLock;
use std::time::{Duration, SystemTime};

/// Wall-clock source. The trait is `Send + Sync + 'static` so a `Clock`
/// implementor can be held inside an `Arc` shared across workers and the
/// reload runner.
pub trait Clock: Send + Sync + 'static {
    /// Current wall time. Implementations MUST be monotonic-enough for
    /// staleness telemetry (i.e. don't return values that go BACKWARDS within
    /// the same process; jump-forwards are fine).
    fn now(&self) -> SystemTime;
}

/// Production clock. Delegates straight to `SystemTime::now`.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}

/// Test clock — start at a fixed instant, advance manually. Tests drive the
/// reload runner / staleness logic by calling [`MockClock::advance`] between
/// assertions.
///
/// Internally `RwLock<SystemTime>` rather than atomic — `SystemTime` is bigger
/// than a u64 on most platforms (it's `i64 + u32` on POSIX), so any lock-free
/// option would need a `Mutex<SystemTime>` or `AtomicU64<nanos>` dance. The
/// `RwLock` is fine: reads dominate (every `now()` is a read), and there's at
/// most one writer at a time in tests.
pub struct MockClock {
    inner: RwLock<SystemTime>,
}

impl MockClock {
    /// Start the mock at `t`.
    pub fn new(t: SystemTime) -> Self {
        Self {
            inner: RwLock::new(t),
        }
    }

    /// Replace the current time with `t`. Useful for setting up a specific
    /// "now" before each assertion block.
    pub fn set(&self, t: SystemTime) {
        *self.inner.write().expect("MockClock RwLock poisoned") = t;
    }

    /// Advance the mock by `d`. Most reload/staleness assertions are
    /// expressed as "after N days have passed", which maps to one call.
    pub fn advance(&self, d: Duration) {
        let mut t = self.inner.write().expect("MockClock RwLock poisoned");
        *t += d;
    }
}

impl Clock for MockClock {
    fn now(&self) -> SystemTime {
        *self.inner.read().expect("MockClock RwLock poisoned")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_clock_is_nondecreasing() {
        let c = SystemClock;
        let a = c.now();
        let b = c.now();
        assert!(b >= a, "SystemTime went backwards within a single test");
    }

    #[test]
    fn mock_clock_advances_deterministically() {
        let t0 = SystemTime::UNIX_EPOCH;
        let c = MockClock::new(t0);
        assert_eq!(c.now(), t0);
        c.advance(Duration::from_secs(60));
        assert_eq!(c.now(), t0 + Duration::from_secs(60));
        c.set(t0);
        assert_eq!(c.now(), t0);
    }
}
