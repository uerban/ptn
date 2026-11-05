// crates/pt-serve/src/rt/runner.rs

//! The RT poll loop — the scheduling half of Node's
//! `GtfsRealtimePoller.start/poll` (`packages/backend/src/gtfs/realtime.ts`).
//! Runs on its own named thread (`pt-serve-rt-poll`, spawned by `main.rs`
//! when RT is enabled), mirroring `pt-serve-reload-poll`
//! (`crate::reload::poll`): plain blocking thread, no tokio, shutdown
//! observed every ≤ 500 ms.
//!
//! Cadence parity: first cycle fires immediately (Node calls `guarded()`
//! before arming `setInterval`), then fixed-rate every interval. Divergence
//! (plan-documented): Node's `setInterval` can OVERLAP a poll that outlives
//! the interval (feeds timing out at 15 s against a 12 s tick); one blocking
//! thread cannot — an overrunning cycle delays the next tick. Steady-state
//! cadence is identical; outages serialise instead of stacking.
//!
//! `fetch` is injected (`FnMut(&str) -> Result<Vec<u8>, String>`) so tests
//! drive cycles without a network; production passes a closure over
//! [`crate::rt::fetch::fetch_feed`].
//!
//! `current_gen` is injected the same way: each cycle takes the active
//! generation once to turn time-only predictions into delays
//! ([`crate::rt::resolve`]) and drops it when the snapshot is published, so the
//! poll thread never pins a generation across a swap. Production passes
//! `ServerCtx::current_generation`.

use crate::bundle::Generation;
use crate::ops::config::LogFormat;
use crate::ops::log::{log_event, Level};
use crate::rt::poller::{FeedStatus, RtPoller};
use crate::rt::resolve::resolve_time_predictions;
use crate::rt::state::{RtSnapshot, RtState};
use pt_shared::clock::Clock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn now_ms(clock: &dyn Clock) -> u64 {
    clock
        .now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// How long to wait before fetching a feed again whose body did not parse.
///
/// Krakow's server answers `200` with an empty or truncated body while it
/// rewrites the file. On 2026-09-27 that was about one fetch in five of its bus
/// feed, rewritten every 10 s. Of the broken fetches, a second fetch was still
/// broken 1 time in 18 at 1 s, and 5 times in 21 at 0.5 s. pt-serve's parser
/// rejects every such body, so without the retry the feed kept last cycle's
/// updates and `/health/rt` read `degraded`.
pub const BROKEN_BODY_RETRY_DELAY: Duration = Duration::from_secs(1);

/// Fetch one feed and apply the outcome to `poller`, logging a failure the
/// way Node's `pollOne` does.
///
/// A body that arrives but does not parse is fetched once more after
/// `retry_delay`, so a feed caught mid-rewrite still updates this cycle. The
/// failed first attempt is never published: health becomes visible per cycle.
/// A transport error is not retried: a timeout has already cost up to 15 s.
fn fetch_and_apply(
    poller: &mut RtPoller,
    url: &str,
    clock: &dyn Clock,
    log_format: LogFormat,
    fetch: &mut dyn FnMut(&str) -> Result<Vec<u8>, String>,
    retry_delay: Duration,
) {
    if !fetch_once(poller, url, clock, log_format, fetch) {
        return;
    }
    std::thread::sleep(retry_delay);
    if !fetch_once(poller, url, clock, log_format, fetch) {
        return;
    }
    // Node parity: pollOne's catch block logs a parse throw.
    if let Some(h) = poller.feed_health().into_iter().find(|h| h.url == url) {
        let err = h.last_error.as_deref().unwrap_or("unknown");
        log_event(
            log_format,
            Level::Warn,
            "rt_feed_malformed",
            &[("url", url), ("error", err), ("attempts", "2")],
        );
    }
}

/// One fetch, applied. True when bytes arrived but did not parse.
fn fetch_once(
    poller: &mut RtPoller,
    url: &str,
    clock: &dyn Clock,
    log_format: LogFormat,
    fetch: &mut dyn FnMut(&str) -> Result<Vec<u8>, String>,
) -> bool {
    let result = fetch(url);
    let fetched_ok = result.is_ok();
    if let Err(e) = &result {
        // Node parity: pollOne's warn on fetch/HTTP failure.
        log_event(
            log_format,
            Level::Warn,
            "rt_fetch_failed",
            &[("url", url), ("error", e)],
        );
    }
    poller.apply_fetch_result(url, result, now_ms(clock));
    fetched_ok
        && poller
            .feed_health()
            .iter()
            .any(|h| h.url == url && h.status == FeedStatus::Failed)
}

/// One poll cycle: fetch every configured feed sequentially, apply each
/// outcome through the PR #426 seam, resolve time-only predictions against
/// the current generation, publish ONE snapshot (Node parity: one
/// `store.setRealtimeUpdates` per `poll()` — health and merge become visible
/// together, per cycle).
///
/// A delay resolved here is against the generation active at poll time; after
/// a swap it stays up to one poll interval behind the new timetable.
pub fn run_cycle(
    poller: &mut RtPoller,
    state: &RtState,
    clock: &dyn Clock,
    log_format: LogFormat,
    fetch: &mut dyn FnMut(&str) -> Result<Vec<u8>, String>,
    current_gen: &dyn Fn() -> Option<Arc<Generation>>,
) {
    let urls: Vec<String> = poller.feed_urls().to_vec();
    for url in &urls {
        fetch_and_apply(
            poller,
            url,
            clock,
            log_format,
            fetch,
            BROKEN_BODY_RETRY_DELAY,
        );
    }
    let mut merged = poller.merged_updates();
    let stats = resolve_time_predictions(&mut merged, current_gen().as_deref());
    state.publish(
        RtSnapshot::from_merged(merged, poller.feed_health()).with_time_predictions(stats),
    );
}

/// The loop shell. Fixed-rate: each tick sleeps only the remainder of
/// `interval` after the cycle's own duration, in ≤ 500 ms slices so a
/// pending shutdown is observed promptly (mirrors `reload::poll`).
// Two of the eight are the injected seams (`fetch`, `current_gen`).
#[allow(clippy::too_many_arguments)]
pub fn run_rt_poll_loop(
    mut poller: RtPoller,
    state: Arc<RtState>,
    clock: Arc<dyn Clock>,
    log_format: LogFormat,
    interval: Duration,
    shutdown: Arc<AtomicBool>,
    mut fetch: impl FnMut(&str) -> Result<Vec<u8>, String>,
    current_gen: impl Fn() -> Option<Arc<Generation>>,
) {
    // Config validation rejects 0, but a struct-literal test config can still
    // produce it; return rather than hot-spin (mirrors reload::poll's guard).
    if interval.is_zero() {
        return;
    }
    loop {
        if shutdown.load(Ordering::SeqCst) {
            return;
        }
        let started = Instant::now();
        run_cycle(
            &mut poller,
            &state,
            clock.as_ref(),
            log_format,
            &mut fetch,
            &current_gen,
        );
        let mut remaining = interval.saturating_sub(started.elapsed());
        while !remaining.is_zero() {
            if shutdown.load(Ordering::SeqCst) {
                return;
            }
            let slice = remaining.min(Duration::from_millis(500));
            std::thread::sleep(slice);
            remaining = remaining.saturating_sub(slice);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::config::LogFormat;
    use crate::rt::poller::FeedStatus;
    use crate::rt::state::RtState;
    use pt_shared::clock::SystemClock;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    const URL: &str = "http://a.test/a.pb";

    fn feed_bytes() -> Vec<u8> {
        include_bytes!("../../tests/fixtures/rt/dated_trip.bin").to_vec()
    }

    /// Drive `fetch_and_apply` with scripted responses, in order; returns how
    /// many fetches it made.
    fn fetch_scripted(poller: &mut RtPoller, responses: Vec<Result<Vec<u8>, String>>) -> usize {
        let mut responses = std::collections::VecDeque::from(responses);
        let mut calls = 0;
        let mut fetch = |_: &str| {
            calls += 1;
            responses
                .pop_front()
                .expect("fetched more often than scripted")
        };
        fetch_and_apply(
            poller,
            URL,
            &SystemClock,
            LogFormat::Text,
            &mut fetch,
            Duration::ZERO,
        );
        calls
    }

    fn status(poller: &RtPoller) -> FeedStatus {
        poller.feed_health()[0].status
    }

    // Krakow's server answers 200 with an empty or truncated body while it
    // rewrites the file (see BROKEN_BODY_RETRY_DELAY).

    #[test]
    fn a_truncated_body_is_fetched_once_more_and_the_good_one_applies() {
        let good = feed_bytes();
        let truncated = good[..good.len() / 2].to_vec();
        assert!(crate::rt::parse_trip_updates_buffer(&truncated).is_err());
        let mut poller = RtPoller::new(vec![URL.to_string()]).unwrap();

        let calls = fetch_scripted(&mut poller, vec![Ok(truncated), Ok(good)]);

        assert_eq!(calls, 2);
        assert_eq!(status(&poller), FeedStatus::Ok);
        assert_eq!(poller.merged_updates()["trip-1"].delay_seconds, 60);
    }

    #[test]
    fn a_body_broken_twice_fails_the_feed_and_keeps_its_last_good_updates() {
        let mut poller = RtPoller::new(vec![URL.to_string()]).unwrap();
        poller.apply_fetch_result(URL, Ok(feed_bytes()), 1);

        let calls = fetch_scripted(&mut poller, vec![Ok(vec![]), Ok(vec![])]);

        assert_eq!(calls, 2, "one retry, not more");
        assert_eq!(status(&poller), FeedStatus::Failed);
        assert_eq!(poller.merged_updates()["trip-1"].delay_seconds, 60);
    }

    #[test]
    fn a_transport_error_is_not_retried() {
        // A timeout already cost up to 15 s; the server answering at all is
        // what the retry is for.
        let mut poller = RtPoller::new(vec![URL.to_string()]).unwrap();
        let calls = fetch_scripted(&mut poller, vec![Err("HTTP 503".to_string())]);
        assert_eq!(calls, 1);
        assert_eq!(status(&poller), FeedStatus::Failed);
    }

    #[test]
    fn a_good_body_is_fetched_once() {
        let mut poller = RtPoller::new(vec![URL.to_string()]).unwrap();
        assert_eq!(fetch_scripted(&mut poller, vec![Ok(feed_bytes())]), 1);
        assert_eq!(status(&poller), FeedStatus::Ok);
    }

    #[test]
    fn cycle_publishes_merged_updates_and_health() {
        let state = RtState::from_urls(vec![URL.to_string()]);
        let mut poller = RtPoller::new(vec![URL.to_string()]).unwrap();
        run_cycle(
            &mut poller,
            &state,
            &SystemClock,
            LogFormat::Text,
            &mut |_| Ok(feed_bytes()),
            &|| None,
        );
        let snap = state.load();
        assert_eq!(snap.health[0].status, FeedStatus::Ok);
        assert!(snap.health[0].last_fetched_at.unwrap() > 0);
        assert!(snap.health[0].entry_count > 0);
        assert_eq!(snap.merged["trip-1"].delay_seconds, 60);
    }

    #[test]
    fn cycle_failure_publishes_health_but_retains_last_good_merge() {
        let state = RtState::from_urls(vec![URL.to_string()]);
        let mut poller = RtPoller::new(vec![URL.to_string()]).unwrap();
        run_cycle(
            &mut poller,
            &state,
            &SystemClock,
            LogFormat::Text,
            &mut |_| Ok(feed_bytes()),
            &|| None,
        );
        run_cycle(
            &mut poller,
            &state,
            &SystemClock,
            LogFormat::Text,
            &mut |_| Err("HTTP 503".to_string()),
            &|| None,
        );
        let snap = state.load();
        // Health reflects the failure; the merge keeps the last-good map —
        // the exact staleness semantic that only shows during feed outages.
        assert_eq!(snap.health[0].status, FeedStatus::Failed);
        assert_eq!(snap.health[0].last_error, Some("HTTP 503".to_string()));
        assert_eq!(snap.merged["trip-1"].delay_seconds, 60);
    }

    #[test]
    fn loop_polls_immediately_and_honours_shutdown() {
        let state = RtState::from_urls(vec![URL.to_string()]);
        let poller = RtPoller::new(vec![URL.to_string()]).unwrap();
        let shutdown = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(AtomicU64::new(0));

        let loop_state = Arc::clone(&state);
        let loop_shutdown = Arc::clone(&shutdown);
        let fetch_shutdown = Arc::clone(&shutdown);
        let fetch_calls = Arc::clone(&calls);
        let handle = std::thread::spawn(move || {
            run_rt_poll_loop(
                poller,
                loop_state,
                Arc::new(SystemClock),
                LogFormat::Text,
                Duration::from_millis(10),
                loop_shutdown,
                move |_| {
                    let n = fetch_calls.fetch_add(1, Ordering::SeqCst) + 1;
                    if n >= 3 {
                        fetch_shutdown.store(true, Ordering::SeqCst);
                    }
                    Ok(include_bytes!("../../tests/fixtures/rt/dated_trip.bin").to_vec())
                },
                || None,
            );
        });
        handle.join().expect("loop thread exits after shutdown");
        assert!(
            calls.load(Ordering::SeqCst) >= 3,
            "first cycle must fire immediately, then ticks"
        );
        assert_eq!(state.load().health[0].status, FeedStatus::Ok);
    }

    #[test]
    fn loop_with_zero_interval_returns_instead_of_spinning() {
        // Config validation rejects 0, but struct-literal test configs can
        // still produce it — mirror reload::poll's defensive early return.
        let state = RtState::from_urls(vec![URL.to_string()]);
        let poller = RtPoller::new(vec![URL.to_string()]).unwrap();
        run_rt_poll_loop(
            poller,
            state,
            Arc::new(SystemClock),
            LogFormat::Text,
            Duration::ZERO,
            Arc::new(AtomicBool::new(false)),
            |_| Ok(vec![]),
            || None,
        );
        // Reaching here at all is the assertion.
    }
}
