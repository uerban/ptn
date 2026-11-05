//! Reload-poll thread — watches `<data_root>/current.json` and drives the
//! EXISTING coalesced reload trigger when it changes. Topology-independent
//! replacement for the cross-container SIGHUP (which can't land in compose:
//! the producer and pt-serve run in separate containers, so a `kill -HUP`
//! from the producer can never reach pt-serve's pid).
//!
//! ## Why mtime, not a second pointer reader
//!
//! The poll is a cheap *gate* over the canonical reload path — it never reads
//! or parses `current.json` itself. [`poll_tick`] only stats the pointer file
//! for its mtime; when the mtime moves it calls
//! [`ReloadRunner::trigger_reload`], which routes through the same coalesced
//! SIGHUP path (the `in_flight`/`pending_latch` latch) and is the single
//! source of truth for pointer parsing, no-op classification, validation,
//! swap, and metrics. The trigger already no-ops on an unchanged pointer (so a
//! spurious mtime bump that didn't actually move the pointer costs a cheap
//! manifest re-read + no-op classification, not a swap), and it records every
//! reload metric. Adding a second `current.json` reader here would duplicate
//! that classification and risk divergence.
//!
//! ## Coalescing
//!
//! Routing through [`ReloadRunner::trigger_reload`] (not the raw `run_one`) means the poll path
//! inherits the SAME coalescing the SIGHUP path uses: a concurrent SIGHUP + poll tick can't produce
//! three live generations (`mapped_generation_count <= 2`). The raw `run_one` bypasses the latch,
//! so the poll must go through `trigger_reload`.
//!
//! ## Backoff
//!
//! On a run of consecutive failures the loop backs off exponentially (capped)
//! so a persistently-bad pointer doesn't hammer the disk every interval. The
//! failure count comes from [`ReloadRunner::consecutive_failures`] (the same
//! `reload_consecutive_failures` gauge the metrics surface exposes), which the
//! reload path resets to 0 on the next success or no-op. The backoff math
//! lives in the pure [`backoff_interval`] helper so it can be unit-tested
//! without timing flake.

use crate::reload::ReloadRunner;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// One poll unit-of-work: stat `<data_root>/current.json`, and if its mtime
/// has changed since `last_mtime`, drive [`ReloadRunner::trigger_reload`] (the
/// coalesced SIGHUP path).
///
/// `last_mtime` starts at 0 (a sentinel meaning "never observed"). A
/// successful stat with mtime equal to the last-observed value short-circuits
/// without touching the trigger. A stat failure (missing file mid-rotation,
/// permission blip) yields mtime 0, which never matches a real mtime, so the
/// next real stat will always re-trigger — the gate fails *open*, never
/// silently wedging the reload path.
///
/// Resolution is **nanoseconds** (`as_nanos() as u64`), not whole seconds: a
/// producer can rotate `current.json` more than once within the same second,
/// and a second-resolution gate would silently miss the second rotation until
/// the next second boundary. Nanos-since-epoch stays well under `u64::MAX`
/// (it overflows ~year 2554), so the `u128 → u64` cast is lossless for any
/// realistic date while keeping the `AtomicU64` storage the poll loop wants.
pub fn poll_tick(runner: &ReloadRunner, data_root: &Path, last_mtime: &AtomicU64) {
    let cur = data_root.join("current.json");
    let mtime = std::fs::metadata(&cur)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    if mtime != 0 && mtime == last_mtime.load(Ordering::Relaxed) {
        return;
    }
    last_mtime.store(mtime, Ordering::Relaxed);
    let _ = runner.trigger_reload();
}

/// Effective sleep before the next poll given the base interval and the current
/// consecutive-failure count: exponential backoff (×2 per failure) capped at 5 min.
pub(crate) fn backoff_interval(base: Duration, consecutive_failures: u64) -> Duration {
    const MAX_BACKOFF_SECS: u64 = 300;
    if consecutive_failures == 0 {
        return base;
    }
    Duration::from_secs(
        base.as_secs()
            .saturating_mul(1u64 << consecutive_failures.min(6))
            .min(MAX_BACKOFF_SECS),
    )
}

/// The reload-poll loop. Spawned on its own named thread by `main.rs`. Runs [`poll_tick`] every
/// `interval`, backing off exponentially (capped — see [`backoff_interval`]) while reloads are
/// failing, and exits promptly when the runner's shutdown flag is set (checked every 500 ms so a
/// long interval doesn't delay SIGTERM shutdown).
pub fn run_poll_loop(runner: Arc<ReloadRunner>, data_root: std::path::PathBuf, interval: Duration) {
    // A zero interval disables polling (config documents
    // `reload_poll_interval_secs == 0` as "disables polling"); returning here
    // avoids a hot-spin of `stat()` with no sleep between ticks.
    if interval.is_zero() {
        return;
    }
    let last_mtime = AtomicU64::new(0);
    let shutdown = runner.shutdown_flag();
    loop {
        if shutdown.load(Ordering::SeqCst) {
            return;
        }
        poll_tick(&runner, &data_root, &last_mtime);
        let fails = runner.consecutive_failures();
        let effective = backoff_interval(interval, fails);
        // Sleep in 500 ms slices so a pending shutdown is observed quickly
        // even when `effective` is large.
        let mut slept = Duration::ZERO;
        while slept < effective {
            if shutdown.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_millis(500));
            slept += Duration::from_millis(500);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_no_failures_is_base() {
        assert_eq!(
            backoff_interval(Duration::from_secs(15), 0),
            Duration::from_secs(15)
        );
    }

    #[test]
    fn backoff_doubles_per_failure() {
        assert_eq!(
            backoff_interval(Duration::from_secs(15), 1),
            Duration::from_secs(30)
        );
        assert_eq!(
            backoff_interval(Duration::from_secs(15), 2),
            Duration::from_secs(60)
        );
    }

    #[test]
    fn backoff_caps_at_300s() {
        // A large failure count saturates the ×2 shift (capped at <<6) and the
        // result is clamped to the 5-minute ceiling rather than growing
        // unbounded.
        assert_eq!(
            backoff_interval(Duration::from_secs(15), 10),
            Duration::from_secs(300)
        );
    }
}
