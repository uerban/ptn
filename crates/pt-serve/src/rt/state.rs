// crates/pt-serve/src/rt/state.rs

//! Process-scoped shared RT state. The `pt-serve-rt-poll` thread owns the
//! mutable [`RtPoller`] and publishes an immutable [`RtSnapshot`] here after
//! every poll cycle; request handlers read lock-free via `arc-swap` — same
//! pattern as the `Generation` swap, minus the `load_full` whitelist
//! (handlers use the cheap [`arc_swap::ArcSwap::load`] guard, held only for
//! the request duration; no ambient `Arc` escapes).
//!
//! Node equivalent: the `GtfsStore.setRealtimeUpdates(merged)` seam (one
//! store per `poll()` cycle) plus `GtfsRealtimePoller.getFeedHealth()`.
//! Divergence (documented in the plan): Node mutates per-feed health
//! mid-cycle; here health becomes visible per-cycle — ≤ one interval of
//! extra staleness, unobservable at the 12 s cadence.

use crate::ops::config::ServerConfig;
use crate::rt::parser::TripUpdate;
use crate::rt::poller::{FeedHealth, RtPoller};
use crate::rt::resolve::TimePredictionStats;
use std::collections::HashMap;
use std::sync::Arc;

/// One immutable poll-cycle result.
///
/// Always construct via [`RtSnapshot::from_merged`], not a bare struct
/// literal — `by_trip` must stay derived from `merged`, and the fields are
/// `pub` only so tests can inspect them, not so callers hand-build a
/// snapshot with a mismatched index.
#[derive(Debug, Default)]
pub struct RtSnapshot {
    /// Superset merge across feeds, later-configured feeds winning
    /// collisions (see `RtPoller::merged_updates`). No route reads this
    /// yet — it is published from day one so the rtTile / departures-RT-
    /// merge follow-ups only add readers, never touch the poll loop.
    pub merged: HashMap<String, TripUpdate>,
    pub health: Vec<FeedHealth>,
    /// Secondary index: bare tripId → every key present in `merged` for
    /// that trip (itself, plus every `"{tripId}|{startDate}"` variant).
    /// Node equivalent: `GtfsStore`'s `realtimeTripKeys` map
    /// (`store.ts:890-903`), rebuilt on every `setRealtimeUpdates` call —
    /// same rebuild-per-publish cost model here. Exists so a per-trip RT
    /// lookup (the rtTile 3b overlay route) is O(1)-average instead of an
    /// O(`merged.len()`) scan per trip per request.
    pub by_trip: HashMap<String, Vec<String>>,
    /// How this cycle's time-only predictions fared (`rt::resolve`), for
    /// `/health/rt`.
    pub time_predictions: TimePredictionStats,
}

impl RtSnapshot {
    /// Build a snapshot from a fresh `merged` map, deriving `by_trip`
    /// alongside it so the two can never drift out of sync.
    pub fn from_merged(merged: HashMap<String, TripUpdate>, health: Vec<FeedHealth>) -> Self {
        let mut by_trip: HashMap<String, Vec<String>> = HashMap::new();
        for key in merged.keys() {
            let trip_id = key.split('|').next().unwrap_or(key);
            by_trip
                .entry(trip_id.to_string())
                .or_default()
                .push(key.clone());
        }
        Self {
            merged,
            health,
            by_trip,
            time_predictions: TimePredictionStats::default(),
        }
    }

    /// Attach the cycle's resolution counts (see [`crate::rt::resolve`]).
    pub fn with_time_predictions(mut self, stats: TimePredictionStats) -> Self {
        self.time_predictions = stats;
        self
    }
}

pub struct RtState {
    enabled: bool,
    snapshot: arc_swap::ArcSwap<RtSnapshot>,
}

// Mirror of Generation's guard (bundle/generation.rs): the poll thread
// publishes RtSnapshot while worker threads read it — a future field that
// regresses Send+Sync must break the build here, not at spawn time.
static_assertions::assert_impl_all!(RtSnapshot: Send, Sync);
static_assertions::assert_impl_all!(RtState: Send, Sync);

impl RtState {
    /// Config-driven constructor: empty [`ServerConfig::rt_urls`] ⇒ disabled
    /// (parity: Node only constructs `GtfsRealtimePoller` when URLs are
    /// configured).
    pub fn from_config(config: &ServerConfig) -> Arc<Self> {
        Self::from_urls(config.rt_urls())
    }

    /// Raw-URLs constructor — the primitive [`RtState::from_config`] wraps.
    /// Empty vec ⇒ disabled state. Callers must not pass empty strings
    /// (panics via the `expect` below); [`ServerConfig::rt_urls`] guarantees
    /// that for the config path, and in-crate test callers pass literals.
    pub fn from_urls(urls: Vec<String>) -> Arc<Self> {
        if urls.is_empty() {
            return Arc::new(Self {
                enabled: false,
                snapshot: arc_swap::ArcSwap::from_pointee(RtSnapshot::default()),
            });
        }
        // `rt_urls()` filters empty segments, so both `PollerConfigError`
        // arms are unreachable from config-driven callers.
        let poller = RtPoller::new(urls).expect("rt_urls() yields non-empty, no-empty-string urls");
        Arc::new(Self {
            enabled: true,
            snapshot: arc_swap::ArcSwap::from_pointee(RtSnapshot::from_merged(
                HashMap::new(),
                poller.feed_health(),
            )),
        })
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// Poller-thread side: publish one cycle's result.
    pub fn publish(&self, snap: RtSnapshot) {
        self.snapshot.store(Arc::new(snap));
    }

    /// Handler side: lock-free read. Hold only for the request duration —
    /// stashing the guard (or its `Arc`) across requests pins an old
    /// snapshot exactly the way ambient `Arc<Generation>` clones would.
    pub fn load(&self) -> arc_swap::Guard<Arc<RtSnapshot>> {
        self.snapshot.load()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rt::poller::FeedStatus;

    #[test]
    fn empty_urls_yield_disabled_state() {
        let state = RtState::from_urls(vec![]);
        assert!(!state.enabled());
        let snap = state.load();
        assert!(snap.merged.is_empty());
        assert!(snap.health.is_empty());
    }

    #[test]
    fn enabled_state_starts_with_pending_feeds() {
        let state = RtState::from_urls(vec!["http://a.test/a.pb".to_string()]);
        assert!(state.enabled());
        let snap = state.load();
        assert_eq!(snap.health.len(), 1);
        assert_eq!(snap.health[0].status, FeedStatus::Pending);
        assert!(snap.merged.is_empty());
    }

    #[test]
    fn publish_replaces_the_snapshot() {
        let state = RtState::from_urls(vec!["http://a.test/a.pb".to_string()]);
        let mut poller = RtPoller::new(vec!["http://a.test/a.pb".to_string()]).unwrap();
        poller.apply_fetch_result(
            "http://a.test/a.pb",
            Ok(include_bytes!("../../tests/fixtures/rt/dated_trip.bin").to_vec()),
            1_000,
        );
        state.publish(RtSnapshot::from_merged(
            poller.merged_updates(),
            poller.feed_health(),
        ));
        let snap = state.load();
        assert_eq!(snap.health[0].status, FeedStatus::Ok);
        assert_eq!(snap.merged["trip-1"].delay_seconds, 60);
    }

    #[test]
    fn by_trip_maps_bare_key_to_itself() {
        let mut merged = HashMap::new();
        merged.insert(
            "T1".to_string(),
            TripUpdate {
                delay_seconds: 0,
                cancelled: false,
                deleted: false,
                time_prediction: None,
            },
        );
        let snap = RtSnapshot::from_merged(merged, vec![]);
        assert_eq!(snap.by_trip.get("T1").map(Vec::len), Some(1));
        assert_eq!(snap.by_trip["T1"], vec!["T1".to_string()]);
    }

    #[test]
    fn by_trip_collects_both_bare_and_dated_keys_for_the_same_trip() {
        let mut merged = HashMap::new();
        merged.insert(
            "T1".to_string(),
            TripUpdate {
                delay_seconds: 0,
                cancelled: false,
                deleted: false,
                time_prediction: None,
            },
        );
        merged.insert(
            "T1|20260721".to_string(),
            TripUpdate {
                delay_seconds: 0,
                cancelled: false,
                deleted: false,
                time_prediction: None,
            },
        );
        let snap = RtSnapshot::from_merged(merged, vec![]);
        let mut keys = snap.by_trip["T1"].clone();
        keys.sort();
        assert_eq!(keys, vec!["T1".to_string(), "T1|20260721".to_string()]);
    }

    #[test]
    fn by_trip_does_not_cross_contaminate_different_trips() {
        let mut merged = HashMap::new();
        merged.insert(
            "T1".to_string(),
            TripUpdate {
                delay_seconds: 0,
                cancelled: false,
                deleted: false,
                time_prediction: None,
            },
        );
        merged.insert(
            "T2|20260721".to_string(),
            TripUpdate {
                delay_seconds: 0,
                cancelled: false,
                deleted: false,
                time_prediction: None,
            },
        );
        let snap = RtSnapshot::from_merged(merged, vec![]);
        assert_eq!(snap.by_trip["T1"], vec!["T1".to_string()]);
        assert_eq!(snap.by_trip["T2"], vec!["T2|20260721".to_string()]);
        assert_eq!(snap.by_trip.len(), 2);
    }

    #[test]
    fn by_trip_is_empty_for_an_empty_snapshot() {
        let snap = RtSnapshot::from_merged(HashMap::new(), vec![]);
        assert!(snap.by_trip.is_empty());
    }
}
