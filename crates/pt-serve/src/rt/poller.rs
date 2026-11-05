// crates/pt-serve/src/rt/poller.rs

//! Pure in-memory state for the GTFS-RT poller: per-feed health tracking,
//! last-good-on-failure retention, and multi-feed merge. Mirrors the
//! non-network parts of `packages/backend/src/gtfs/realtime.ts`'s
//! `GtfsRealtimePoller` class.
//!
//! **No network I/O lives here.** [`RtPoller::apply_fetch_result`] is the
//! seam a future fetch layer calls after making the actual HTTP request —
//! see the plan's "Scope boundary" for why the fetch itself isn't wired up
//! yet (TLS/musl-cross-compile CI blocker, tracked separately).
//!
//! **API shape note:** the JS constructor has a `tripUpdatesUrl: string |
//! tripUpdatesUrls: string[]` discriminated union — a TS ergonomics
//! accommodation for callers with exactly one feed. Rust's `Vec<String>`
//! covers both cases naturally (a single-feed caller just passes a
//! one-element vec), so there's no equivalent union here — this is a
//! deliberate simplification of the *type*, not a behavioral change: the
//! same non-empty / no-empty-strings validation applies either way.

use crate::rt::parser::{parse_trip_updates_buffer, TripUpdate};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedStatus {
    Pending,
    Ok,
    Failed,
}

#[derive(Debug, Clone)]
pub struct FeedHealth {
    pub url: String,
    pub status: FeedStatus,
    pub last_fetched_at: Option<u64>,
    pub last_error: Option<String>,
    pub entry_count: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PollerConfigError {
    EmptyUrls,
    EmptyStringInUrls,
}

// `Debug` only (no `PartialEq`) — needed so `Result<RtPoller, _>::unwrap_err()`
// type-checks in the constructor-validation tests below (it must be able to
// print the `Ok` value in a panic message if the result were unexpectedly
// `Ok`). `RtPoller` is mutable poller state, not a value type, so equality
// comparison is intentionally not derived.
#[derive(Debug)]
pub struct RtPoller {
    urls: Vec<String>,
    last_updates_by_url: HashMap<String, HashMap<String, TripUpdate>>,
    health_by_url: HashMap<String, FeedHealth>,
}

impl RtPoller {
    pub fn new(urls: Vec<String>) -> Result<Self, PollerConfigError> {
        if urls.is_empty() {
            return Err(PollerConfigError::EmptyUrls);
        }
        if urls.iter().any(|u| u.is_empty()) {
            return Err(PollerConfigError::EmptyStringInUrls);
        }
        let mut health_by_url = HashMap::new();
        for url in &urls {
            health_by_url.insert(
                url.clone(),
                FeedHealth {
                    url: url.clone(),
                    status: FeedStatus::Pending,
                    last_fetched_at: None,
                    last_error: None,
                    entry_count: 0,
                },
            );
        }
        Ok(RtPoller {
            urls,
            last_updates_by_url: HashMap::new(),
            health_by_url,
        })
    }

    pub fn feed_urls(&self) -> &[String] {
        &self.urls
    }

    pub fn feed_health(&self) -> Vec<FeedHealth> {
        self.urls
            .iter()
            .map(|u| self.health_by_url[u].clone())
            .collect()
    }

    /// Applies the outcome of one feed's fetch attempt. `Ok(bytes)` parses
    /// and stores the update map, marking the feed healthy. `Err(msg)`
    /// marks the feed failed WITHOUT touching its previously-stored map —
    /// a failed fetch never wipes a feed's last-good state (parity with
    /// JS's `lastUpdatesByUrl` retention across failures).
    pub fn apply_fetch_result(&mut self, url: &str, result: Result<Vec<u8>, String>, now_ms: u64) {
        match result {
            Ok(bytes) => match parse_trip_updates_buffer(&bytes) {
                Ok(updates) => {
                    let entry_count = updates.len();
                    self.last_updates_by_url.insert(url.to_string(), updates);
                    if let Some(h) = self.health_by_url.get_mut(url) {
                        h.status = FeedStatus::Ok;
                        h.last_error = None;
                        h.last_fetched_at = Some(now_ms);
                        h.entry_count = entry_count;
                    }
                }
                Err(_) => self.mark_failed(url, "malformed GTFS-RT feed".to_string(), now_ms),
            },
            Err(e) => self.mark_failed(url, e, now_ms),
        }
    }

    // Silently no-ops if `url` isn't one of the configured feeds — the future
    // fetch layer only ever calls this with URLs from `feed_urls()`, so this
    // is a defensive guard against a caller bug, not a real code path.
    fn mark_failed(&mut self, url: &str, err: String, now_ms: u64) {
        if let Some(h) = self.health_by_url.get_mut(url) {
            h.status = FeedStatus::Failed;
            h.last_error = Some(err);
            h.last_fetched_at = Some(now_ms);
        }
    }

    /// Merges all per-feed maps into one superset. Feeds later in the
    /// configured URL order win on key collisions — a colliding tripId
    /// across two feeds indicates a feed misconfiguration, so this is a
    /// deterministic resolution, not a policy (matches JS's documented
    /// tradeoff in `realtime.ts`'s `poll()`).
    // Clones every TripUpdate on every call — fine at this stage (no network
    // wiring yet, no established call frequency). If a future poll loop calls
    // this per-request rather than once per poll cycle, revisit (e.g. Arc<TripUpdate>).
    pub fn merged_updates(&self) -> HashMap<String, TripUpdate> {
        let mut merged = HashMap::new();
        for url in &self.urls {
            if let Some(per) = self.last_updates_by_url.get(url) {
                for (k, v) in per {
                    merged.insert(k.clone(), v.clone());
                }
            }
        }
        merged
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_feed_bytes() -> Vec<u8> {
        include_bytes!("../../tests/fixtures/rt/dated_trip.bin").to_vec()
    }

    #[test]
    fn accepts_single_url() {
        let poller = RtPoller::new(vec!["http://example.test/a.pb".to_string()]).unwrap();
        assert_eq!(
            poller.feed_urls(),
            &["http://example.test/a.pb".to_string()]
        );
    }

    #[test]
    fn accepts_multiple_urls() {
        let poller = RtPoller::new(vec![
            "http://example.test/a.pb".to_string(),
            "http://example.test/b.pb".to_string(),
        ])
        .unwrap();
        assert_eq!(poller.feed_urls().len(), 2);
    }

    #[test]
    fn rejects_empty_url_list() {
        // `assert_eq!` on the full `Result<RtPoller, _>` would require
        // `RtPoller: Debug + PartialEq` even though only the `Err` arm is
        // exercised here — and `RtPoller` deliberately derives neither (it's
        // mutable poller state, not a value type). Compare the error arm
        // directly via `unwrap_err()` instead.
        assert_eq!(
            RtPoller::new(vec![]).unwrap_err(),
            PollerConfigError::EmptyUrls
        );
    }

    #[test]
    fn rejects_empty_string_in_url_list() {
        assert_eq!(
            RtPoller::new(vec!["http://a.test/a.pb".to_string(), "".to_string()]).unwrap_err(),
            PollerConfigError::EmptyStringInUrls
        );
    }

    #[test]
    fn feeds_start_pending() {
        let poller = RtPoller::new(vec!["http://example.test/a.pb".to_string()]).unwrap();
        let health = poller.feed_health();
        assert_eq!(health.len(), 1);
        assert_eq!(health[0].status, FeedStatus::Pending);
        assert_eq!(health[0].last_fetched_at, None);
    }

    #[test]
    fn successful_fetch_marks_ok_and_populates_merge() {
        let mut poller = RtPoller::new(vec!["http://example.test/a.pb".to_string()]).unwrap();
        poller.apply_fetch_result("http://example.test/a.pb", Ok(valid_feed_bytes()), 1_000);

        let health = poller.feed_health();
        assert_eq!(health[0].status, FeedStatus::Ok);
        assert_eq!(health[0].last_fetched_at, Some(1_000));
        assert!(health[0].entry_count > 0);

        let merged = poller.merged_updates();
        assert_eq!(merged["trip-1"].delay_seconds, 60);
    }

    #[test]
    fn failed_fetch_marks_failed_and_does_not_populate_merge() {
        let mut poller = RtPoller::new(vec!["http://example.test/a.pb".to_string()]).unwrap();
        poller.apply_fetch_result(
            "http://example.test/a.pb",
            Err("HTTP 503".to_string()),
            2_000,
        );

        let health = poller.feed_health();
        assert_eq!(health[0].status, FeedStatus::Failed);
        assert_eq!(health[0].last_error, Some("HTTP 503".to_string()));
        assert!(poller.merged_updates().is_empty());
    }

    #[test]
    fn keeps_surviving_feed_updates_when_another_feed_fails() {
        let mut poller = RtPoller::new(vec![
            "http://example.test/a.pb".to_string(),
            "http://example.test/b.pb".to_string(),
        ])
        .unwrap();
        poller.apply_fetch_result("http://example.test/a.pb", Ok(valid_feed_bytes()), 1_000);
        poller.apply_fetch_result(
            "http://example.test/b.pb",
            Err("timeout".to_string()),
            1_000,
        );

        let merged = poller.merged_updates();
        assert_eq!(merged["trip-1"].delay_seconds, 60);

        let health = poller.feed_health();
        let a = health.iter().find(|h| h.url.ends_with("a.pb")).unwrap();
        let b = health.iter().find(|h| h.url.ends_with("b.pb")).unwrap();
        assert_eq!(a.status, FeedStatus::Ok);
        assert_eq!(b.status, FeedStatus::Failed);
    }

    #[test]
    fn both_feeds_failing_leaves_merge_empty_with_independent_errors() {
        let mut poller = RtPoller::new(vec![
            "http://example.test/a.pb".to_string(),
            "http://example.test/b.pb".to_string(),
        ])
        .unwrap();
        poller.apply_fetch_result(
            "http://example.test/a.pb",
            Err("HTTP 500".to_string()),
            1_000,
        );
        poller.apply_fetch_result(
            "http://example.test/b.pb",
            Err("timeout".to_string()),
            1_000,
        );

        let health = poller.feed_health();
        let a = health.iter().find(|h| h.url.ends_with("a.pb")).unwrap();
        let b = health.iter().find(|h| h.url.ends_with("b.pb")).unwrap();
        assert_eq!(a.status, FeedStatus::Failed);
        assert_eq!(a.last_error, Some("HTTP 500".to_string()));
        assert_eq!(b.status, FeedStatus::Failed);
        assert_eq!(b.last_error, Some("timeout".to_string()));
        assert!(poller.merged_updates().is_empty());
    }

    #[test]
    fn a_feed_that_later_fails_retains_its_last_good_map() {
        // The exact scenario the JS comment on `lastUpdatesByUrl` documents:
        // a fetch failure does NOT wipe a feed's previously-fetched state.
        let mut poller = RtPoller::new(vec!["http://example.test/a.pb".to_string()]).unwrap();
        poller.apply_fetch_result("http://example.test/a.pb", Ok(valid_feed_bytes()), 1_000);
        assert_eq!(poller.merged_updates()["trip-1"].delay_seconds, 60);

        poller.apply_fetch_result(
            "http://example.test/a.pb",
            Err("HTTP 500".to_string()),
            2_000,
        );

        // Health reflects the failure...
        assert_eq!(poller.feed_health()[0].status, FeedStatus::Failed);
        // ...but the last-good map is still there.
        assert_eq!(poller.merged_updates()["trip-1"].delay_seconds, 60);
    }

    // A fetch that succeeds but returns malformed bytes must behave exactly like a fetch that
    // failed outright: mark the feed Failed and keep last-good.
    #[test]
    fn malformed_bytes_marks_failed_and_retains_last_good_state() {
        let mut poller = RtPoller::new(vec!["http://example.test/a.pb".to_string()]).unwrap();
        poller.apply_fetch_result("http://example.test/a.pb", Ok(valid_feed_bytes()), 1_000);
        assert_eq!(poller.merged_updates()["trip-1"].delay_seconds, 60);

        // Truncated FeedMessage: claims a 9-byte header, only 1 byte follows.
        let malformed = vec![0x0a, 0x09, 0x0a];
        poller.apply_fetch_result("http://example.test/a.pb", Ok(malformed), 2_000);

        let health = poller.feed_health();
        assert_eq!(health[0].status, FeedStatus::Failed);
        assert_eq!(
            health[0].last_error,
            Some("malformed GTFS-RT feed".to_string())
        );
        // Last-good map from the earlier successful fetch is retained.
        assert_eq!(poller.merged_updates()["trip-1"].delay_seconds, 60);
    }

    #[test]
    fn empty_body_marks_failed_and_retains_last_good_state() {
        let mut poller = RtPoller::new(vec!["http://example.test/a.pb".to_string()]).unwrap();
        poller.apply_fetch_result("http://example.test/a.pb", Ok(valid_feed_bytes()), 1_000);

        // An upstream can return HTTP 200 with an empty body. protobufjs
        // rejects this as a FeedMessage missing its required header, so Rust
        // must not accept it as an empty full snapshot and erase last-good.
        poller.apply_fetch_result("http://example.test/a.pb", Ok(vec![]), 2_000);

        let health = poller.feed_health();
        assert_eq!(health[0].status, FeedStatus::Failed);
        assert_eq!(
            health[0].last_error,
            Some("malformed GTFS-RT feed".to_string())
        );
        assert_eq!(poller.merged_updates()["trip-1"].delay_seconds, 60);
    }
}
