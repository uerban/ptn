// crates/pt-serve/src/rt/alerts_state.rs

//! ServiceAlerts polling and the published `GET /api/<city>/alerts` reply.
//!
//! The `pt-serve-alerts-poll` thread owns an [`AlertsPoller`] (the shared
//! [`FeedPoller`]: per-feed health, last good alerts kept across failures)
//! and, once per cycle:
//! 1. fetches every configured feed (`rt::runner::fetch_and_apply`, the same
//!    fetch, retry and logging as TripUpdates);
//! 2. merges the feeds' last good alerts in configured order, a later feed
//!    replacing an earlier alert with the same id;
//! 3. drops alerts whose active periods have all ended;
//! 4. resolves selectors against the active generation ([`KnownIds`]),
//!    dropping and counting selectors that name an id the bundle lacks, and
//!    alerts left with none;
//! 5. serialises the reply once, with its ETag, and publishes it.
//!
//! Requests then only read the published bytes. Expiry and staleness are
//! therefore evaluated once per cycle: an alert can outlive its last period
//! by up to one poll interval.
//!
//! ## Feed ids and bundle ids
//!
//! TripUpdates are matched by using feed ids verbatim as bundle ids
//! (`rt::resolve`, the rt-tile and departures routes). Alerts use the same
//! mapping. A multi-feed city's bundle is a union of its static feeds with
//! ids kept as published (the producer's pass 1 collapses a duplicate id,
//! first feed wins); ids are not namespaced per source feed. So a selector
//! from any of a city's alert feeds resolves directly, and one that does not
//! is reported in `/health/rt` rather than guessed at.
//!
//! ## Staleness
//!
//! `fetchedAt` is the oldest last successful fetch across the feeds that
//! have one. The reply is `stale` when that is older than
//! [`stale_after`] (three poll intervals, at least
//! [`MIN_STALE_AFTER`]), or when a feed has failed without ever succeeding.
//! Until some feed has succeeded there is no reply to serve.

use crate::bundle::Generation;
use crate::ops::config::LogFormat;
use crate::rt::alerts::{EntitySelector, FeedAlerts, ServiceAlert, Translation};
use crate::rt::poller::{FeedHealth, FeedPoller, FeedStatus};
use crate::rt::runner::{fetch_and_apply, now_ms, run_fixed_rate, BROKEN_BODY_RETRY_DELAY};
use indexmap::IndexMap;
use pt_shared::clock::Clock;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

/// The ServiceAlerts poller.
pub type AlertsPoller = FeedPoller<FeedAlerts>;

/// Schema version of the reply body. Must match
/// `SERVICE_ALERTS_SCHEMA_VERSION` in `packages/shared/src/types/serviceAlert.ts`.
pub const SERVICE_ALERTS_SCHEMA_VERSION: u32 = 1;

/// Alerts served per reply, across every feed.
pub const MAX_ALERTS_SERVED: usize = 1000;

/// The floor of [`stale_after`]: a reply is never called stale sooner.
pub const MIN_STALE_AFTER: Duration = Duration::from_secs(5 * 60);

/// How old the last successful fetch may be before the reply is `stale`:
/// three missed polls, and never under [`MIN_STALE_AFTER`].
pub fn stale_after(poll_interval: Duration) -> Duration {
    poll_interval.saturating_mul(3).max(MIN_STALE_AFTER)
}

/// Counts from one cycle, for `/health/rt`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AlertsStats {
    /// Alerts in the published reply.
    pub served: u32,
    /// Alerts every active period of which had ended.
    pub expired: u32,
    /// Selectors naming an id the bundle does not have, or dropped while
    /// decoding.
    pub dropped_selectors: u32,
    /// Alerts dropped while decoding, left with no selector, or past
    /// [`MAX_ALERTS_SERVED`].
    pub dropped_alerts: u32,
}

/// The pre-built reply.
#[derive(Debug, Clone)]
pub struct AlertsReply {
    pub body: Arc<[u8]>,
    /// Quoted strong ETag over `body`.
    pub etag: String,
    pub stale: bool,
}

/// One cycle's result.
#[derive(Debug, Default)]
pub struct AlertsSnapshot {
    pub health: Vec<FeedHealth>,
    /// `None` until some feed has been fetched successfully.
    pub reply: Option<AlertsReply>,
    pub stats: AlertsStats,
}

/// Process-scoped alerts state: the poll thread publishes, handlers read
/// lock-free (the same `arc-swap` seam as [`crate::rt::RtState`]).
pub struct AlertsState {
    enabled: bool,
    snapshot: arc_swap::ArcSwap<AlertsSnapshot>,
}

static_assertions::assert_impl_all!(AlertsSnapshot: Send, Sync);
static_assertions::assert_impl_all!(AlertsState: Send, Sync);

impl AlertsState {
    /// Empty `urls` ⇒ disabled. Callers must not pass empty strings
    /// ([`crate::ops::ServerConfig::alerts_urls`] never yields one).
    pub fn from_urls(urls: Vec<String>) -> Arc<Self> {
        if urls.is_empty() {
            return Arc::new(Self {
                enabled: false,
                snapshot: arc_swap::ArcSwap::from_pointee(AlertsSnapshot::default()),
            });
        }
        let poller = AlertsPoller::new(urls).expect("non-empty, no-empty-string alert feed urls");
        Arc::new(Self {
            enabled: true,
            snapshot: arc_swap::ArcSwap::from_pointee(AlertsSnapshot {
                health: poller.feed_health(),
                reply: None,
                stats: AlertsStats::default(),
            }),
        })
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// Poll-thread side.
    pub fn publish(&self, snap: AlertsSnapshot) {
        self.snapshot.store(Arc::new(snap));
    }

    /// Handler side; hold only for the request.
    pub fn load(&self) -> arc_swap::Guard<Arc<AlertsSnapshot>> {
        self.snapshot.load()
    }
}

/// The bundle ids alert selectors may name, limited to the ids the alerts
/// actually reference (so a cycle never copies the bundle's id tables).
#[derive(Debug, Default)]
pub struct KnownIds {
    routes: HashSet<String>,
    stops: HashSet<String>,
    trips: HashSet<String>,
    agencies: HashSet<String>,
    /// False when no route carries an agency id (single-agency feeds may
    /// omit it); an agency selector then cannot be checked and is accepted.
    has_agency_ids: bool,
}

impl KnownIds {
    /// Build from explicit id lists (tests, and callers without a bundle).
    pub fn from_ids<'a>(
        routes: impl IntoIterator<Item = &'a str>,
        stops: impl IntoIterator<Item = &'a str>,
        trips: impl IntoIterator<Item = &'a str>,
        agencies: impl IntoIterator<Item = &'a str>,
    ) -> Self {
        let agencies: HashSet<String> = agencies.into_iter().map(str::to_string).collect();
        Self {
            routes: routes.into_iter().map(str::to_string).collect(),
            stops: stops.into_iter().map(str::to_string).collect(),
            trips: trips.into_iter().map(str::to_string).collect(),
            has_agency_ids: !agencies.is_empty(),
            agencies,
        }
    }

    /// Look up every id `alerts` reference in `gen`'s bundle. One pass over
    /// routes, and over stops or trips only when some selector names one.
    pub fn from_generation<'a>(
        gen: &Generation,
        alerts: impl IntoIterator<Item = &'a ServiceAlert>,
    ) -> Self {
        let mut wanted_routes = HashSet::new();
        let mut wanted_stops = HashSet::new();
        let mut wanted_trips = HashSet::new();
        for sel in alerts.into_iter().flat_map(|a| &a.informed_entities) {
            if let Some(r) = sel.route_id.as_deref() {
                wanted_routes.insert(r);
            }
            if let Some(s) = sel.stop_id.as_deref() {
                wanted_stops.insert(s);
            }
            if let Some(t) = sel.trip_id.as_deref() {
                wanted_trips.insert(t);
            }
        }
        let reader = &gen.reader;
        let mut known = KnownIds::default();
        for i in 0..reader.num_routes() {
            if let Ok(id) = reader.route_id(i) {
                if wanted_routes.contains(id) {
                    known.routes.insert(id.to_string());
                }
            }
            if let Ok(agency) = reader.route_agency_id(i) {
                if !agency.is_empty() {
                    known.has_agency_ids = true;
                    if !known.agencies.contains(agency) {
                        known.agencies.insert(agency.to_string());
                    }
                }
            }
        }
        if !wanted_stops.is_empty() {
            for i in 0..reader.num_stops() {
                if let Ok(id) = reader.stop_id(i) {
                    if wanted_stops.contains(id) {
                        known.stops.insert(id.to_string());
                    }
                }
            }
        }
        if !wanted_trips.is_empty() {
            for i in 0..reader.num_trips() {
                if let Ok(id) = reader.trip_id(i) {
                    if wanted_trips.contains(id) {
                        known.trips.insert(id.to_string());
                    }
                }
            }
        }
        known
    }

    fn resolves(&self, sel: &EntitySelector) -> bool {
        let has = |set: &HashSet<String>, id: &Option<Box<str>>| {
            id.as_deref().is_none_or(|id| set.contains(id))
        };
        has(&self.routes, &sel.route_id)
            && has(&self.stops, &sel.stop_id)
            && has(&self.trips, &sel.trip_id)
            && (!self.has_agency_ids || has(&self.agencies, &sel.agency_id))
    }
}

/// Merge the feeds' alerts (configured order; a later feed replaces an
/// earlier alert with the same id, keeping its position), drop expired
/// ones, then resolve selectors against `known` (`None`: no bundle to check
/// against, every selector kept). Returns the served alerts and the stats.
pub fn merge_alerts<'a>(
    feeds: impl IntoIterator<Item = &'a FeedAlerts>,
    now_secs: u64,
    known: Option<&KnownIds>,
) -> (Vec<ServiceAlert>, AlertsStats) {
    let mut stats = AlertsStats::default();
    let mut merged: IndexMap<Box<str>, ServiceAlert> = IndexMap::new();
    for feed in feeds {
        stats.dropped_alerts += feed.dropped_alerts;
        stats.dropped_selectors += feed.dropped_selectors;
        for alert in &feed.alerts {
            merged.insert(alert.id.clone(), alert.clone());
        }
    }
    let mut out = Vec::with_capacity(merged.len().min(MAX_ALERTS_SERVED));
    for (_, mut alert) in merged {
        if alert.expired_by(now_secs) {
            stats.expired += 1;
            continue;
        }
        if let Some(known) = known {
            let before = alert.informed_entities.len();
            alert.informed_entities.retain(|sel| known.resolves(sel));
            stats.dropped_selectors += (before - alert.informed_entities.len()) as u32;
            if alert.informed_entities.is_empty() {
                stats.dropped_alerts += 1;
                continue;
            }
        }
        if out.len() >= MAX_ALERTS_SERVED {
            stats.dropped_alerts += 1;
            continue;
        }
        out.push(alert);
    }
    stats.served = out.len() as u32;
    (out, stats)
}

#[derive(Serialize)]
struct TranslationWire<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<&'a str>,
    text: &'a str,
}

#[derive(Serialize)]
struct PeriodWire {
    #[serde(skip_serializing_if = "Option::is_none")]
    start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    end: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectorWire<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    agency_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    route_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    route_type: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    direction_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trip_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop_id: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlertWire<'a> {
    id: &'a str,
    cause: &'static str,
    effect: &'static str,
    severity: &'static str,
    header: Vec<TranslationWire<'a>>,
    description: Vec<TranslationWire<'a>>,
    url: Vec<TranslationWire<'a>>,
    active_periods: Vec<PeriodWire>,
    informed_entities: Vec<SelectorWire<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplyWire<'a> {
    schema_version: u32,
    city: &'a str,
    fetched_at: String,
    stale: bool,
    alerts: Vec<AlertWire<'a>>,
}

/// POSIX seconds as an ISO 8601 UTC instant; `None` outside jiff's range
/// (read as an open end).
fn iso_utc(secs: u64) -> Option<String> {
    let secs = i64::try_from(secs).ok()?;
    jiff::Timestamp::from_second(secs)
        .ok()
        .map(|t| t.to_string())
}

/// Milliseconds since the epoch as ISO 8601 UTC, to the millisecond (the
/// shape `Date.prototype.toISOString` produces).
fn iso_utc_ms(ms: u64) -> String {
    let ts = i64::try_from(ms)
        .ok()
        .and_then(|ms| jiff::Timestamp::from_millisecond(ms).ok())
        .unwrap_or(jiff::Timestamp::UNIX_EPOCH);
    ts.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn texts(list: &[Translation]) -> Vec<TranslationWire<'_>> {
    list.iter()
        .map(|t| TranslationWire {
            language: t.language.as_deref(),
            text: &t.text,
        })
        .collect()
}

/// Serialise the reply body and its ETag.
pub fn build_reply(
    city: &str,
    fetched_at_ms: u64,
    stale: bool,
    alerts: &[ServiceAlert],
) -> AlertsReply {
    let wire = ReplyWire {
        schema_version: SERVICE_ALERTS_SCHEMA_VERSION,
        city,
        fetched_at: iso_utc_ms(fetched_at_ms),
        stale,
        alerts: alerts
            .iter()
            .map(|a| AlertWire {
                id: &a.id,
                cause: a.cause.name(),
                effect: a.effect.name(),
                severity: a.severity.name(),
                header: texts(&a.header),
                description: texts(&a.description),
                url: texts(&a.url),
                active_periods: a
                    .active_periods
                    .iter()
                    .map(|p| PeriodWire {
                        start: p.start.and_then(iso_utc),
                        end: p.end.and_then(iso_utc),
                    })
                    .collect(),
                informed_entities: a
                    .informed_entities
                    .iter()
                    .map(|s| SelectorWire {
                        agency_id: s.agency_id.as_deref(),
                        route_id: s.route_id.as_deref(),
                        route_type: s.route_type,
                        direction_id: s.direction_id,
                        trip_id: s.trip_id.as_deref(),
                        stop_id: s.stop_id.as_deref(),
                    })
                    .collect(),
            })
            .collect(),
    };
    let body = serde_json::to_vec(&wire).expect("alerts reply serialises");
    let digest = Sha256::digest(&body);
    let hex: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    AlertsReply {
        body: body.into(),
        etag: format!("\"{hex}\""),
        stale,
    }
}

/// `fetchedAt` and `stale` for the reply, or `None` when no feed has ever
/// been fetched successfully. See the module docs.
pub fn freshness(poller: &AlertsPoller, now_ms: u64, stale_after: Duration) -> Option<(u64, bool)> {
    let stale_after_ms = u64::try_from(stale_after.as_millis()).unwrap_or(u64::MAX);
    let health = poller.feed_health();
    let mut oldest: Option<u64> = None;
    let mut stale = false;
    for h in &health {
        match poller.last_success_at(&h.url) {
            Some(at) => {
                oldest = Some(oldest.map_or(at, |o| o.min(at)));
                stale |= now_ms.saturating_sub(at) > stale_after_ms;
            }
            None => stale |= h.status == FeedStatus::Failed,
        }
    }
    oldest.map(|at| (at, stale))
}

/// What one alerts cycle needs besides the poller and the state.
pub struct AlertsCycle<'a> {
    pub city: &'a str,
    pub clock: &'a dyn Clock,
    pub log_format: LogFormat,
    pub stale_after: Duration,
    pub retry_delay: Duration,
}

/// One cycle: fetch every feed, merge, expire, resolve, publish one
/// snapshot. The generation is taken once and released before publishing.
pub fn run_alerts_cycle(
    poller: &mut AlertsPoller,
    state: &AlertsState,
    cycle: &AlertsCycle<'_>,
    fetch: &mut dyn FnMut(&str) -> Result<Vec<u8>, String>,
    current_gen: &dyn Fn() -> Option<Arc<Generation>>,
) {
    let urls: Vec<String> = poller.feed_urls().to_vec();
    for url in &urls {
        fetch_and_apply(
            poller,
            url,
            cycle.clock,
            cycle.log_format,
            fetch,
            cycle.retry_delay,
        );
    }
    let now = now_ms(cycle.clock);
    let snapshot = match freshness(poller, now, cycle.stale_after) {
        Some((fetched_at, stale)) => {
            let known = current_gen().map(|gen| {
                KnownIds::from_generation(&gen, poller.last_good().flat_map(|f| &f.alerts))
            });
            let (alerts, stats) = merge_alerts(poller.last_good(), now / 1000, known.as_ref());
            AlertsSnapshot {
                health: poller.feed_health(),
                reply: Some(build_reply(cycle.city, fetched_at, stale, &alerts)),
                stats,
            }
        }
        None => AlertsSnapshot {
            health: poller.feed_health(),
            reply: None,
            stats: AlertsStats::default(),
        },
    };
    state.publish(snapshot);
}

/// The alerts poll loop: [`run_alerts_cycle`] at a fixed rate.
#[allow(clippy::too_many_arguments)]
pub fn run_alerts_poll_loop(
    mut poller: AlertsPoller,
    state: Arc<AlertsState>,
    city: String,
    clock: Arc<dyn Clock>,
    log_format: LogFormat,
    interval: Duration,
    shutdown: Arc<AtomicBool>,
    mut fetch: impl FnMut(&str) -> Result<Vec<u8>, String>,
    current_gen: impl Fn() -> Option<Arc<Generation>>,
) {
    let cycle = AlertsCycle {
        city: &city,
        clock: clock.as_ref(),
        log_format,
        stale_after: stale_after(interval),
        retry_delay: BROKEN_BODY_RETRY_DELAY,
    };
    run_fixed_rate(interval, &shutdown, || {
        run_alerts_cycle(&mut poller, &state, &cycle, &mut fetch, &current_gen)
    });
}
