//! Per-instance metrics counters + Prometheus text exposition body builder.
//!
//! No `tiny_http` import lives here — the (transport-free) response wrapper is over in
//! `app::metrics`, and the `http::adapter` materialises it into a `tiny_http::ResponseBox` at the
//! single seam. Splitting the body builder from the response envelope keeps `tiny_http` confined to
//! `src/http/`.
//!
//! Counters hang off [`Metrics`] (held by [`crate::ops::ServerCtx`] as `Arc<Metrics>`) rather than
//! process-global statics. The per-instance shape is load-bearing for upcoming work: - the reload
//! runner takes `metrics: Arc<Metrics>` by injection — it needs to atomically observe its own
//! counters, not a process-wide bag. - the `inflight_requests` gauge will be a per-instance atomic;
//! process-globals would cross-pollute in parallel test runs. - the
//! `tests/common::isolated_config()` gives each test a fresh `Arc<Metrics>` so counter assertions
//! don't leak across the harness-default parallel test execution. - the per-generation labels (e.g.
//! `generation_adopted_total{generation_id=...}`) need state owned by the metrics surface, not just
//! a free counter.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Reload outcome label — paired with [`ReloadCause`] to form the
/// `reload_total{result,cause}` series. Stored as a fixed enum so the map
/// `(ReloadResult, ReloadCause) -> AtomicU64` has bounded cardinality
/// (3 × 6 = 18 cells at most).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ReloadResult {
    Ok,
    Noop,
    Failed,
}

impl ReloadResult {
    /// Prometheus label-value string. Used by [`Metrics::render_body`] and by
    /// tests that read the counter via `metrics.reload_total(result, cause)`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Noop => "noop",
            Self::Failed => "failed",
        }
    }
}

/// Reload `cause` label, paired with [`ReloadResult`] for `reload_total`. The
/// `None` value (rendered as `""`) is used for `ok` and `noop`; `Failed`
/// always carries a non-None cause.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ReloadCause {
    /// Empty cause — used for `ok` and `noop` results.
    None,
    Producer,
    Structural,
    Operator,
    Engine,
    Io,
}

impl ReloadCause {
    /// Prometheus label-value string. `None` renders as `""`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "",
            Self::Producer => "producer",
            Self::Structural => "structural",
            Self::Operator => "operator",
            Self::Engine => "engine",
            Self::Io => "io",
        }
    }

    /// Build from the stable cause label produced by
    /// `pt_shared::validate::errors::ValidationError::cause_label`. Returns
    /// `None` for the empty/unknown string.
    pub fn from_label(label: &str) -> Self {
        match label {
            "producer" => Self::Producer,
            "structural" => Self::Structural,
            "operator" => Self::Operator,
            "engine" => Self::Engine,
            "io" => Self::Io,
            _ => Self::None,
        }
    }
}

/// Per-instance metrics surface. One `Arc<Metrics>` lives on
/// [`crate::ops::ServerCtx`] for the lifetime of the process; tests can mint a
/// fresh one via [`Metrics::default`] for isolation.
///
/// All counters are `AtomicU64` and incremented with `Relaxed` ordering — the
/// values are diagnostic, not synchronisation-bearing, and a torn read across
/// counters is harmless for a Prometheus scrape.
#[derive(Debug, Default)]
pub struct Metrics {
    // ---- P3 baseline ----
    /// `plan_requests_total` — every `/plan` request received, counted by the
    /// dispatcher BEFORE the body-size check.
    pub plan_requests: AtomicU64,
    /// `oversized_plan_requests_total` — subset of `plan_requests` whose body
    /// exceeded the dispatcher's hard cap and was rejected with 413.
    pub oversized_plan_requests: AtomicU64,

    // A `Mutex<HashMap<...>>` is overkill for the fixed-shape labels but matches the planned shape
    // for the label-set storage (which adds dynamic generation_id labels).
    pub reload_total: Mutex<HashMap<(ReloadResult, ReloadCause), AtomicU64>>,
    /// `reload_consecutive_failures` — gauge. Resets to 0 only on
    /// `result="ok"`; noop does NOT reset (rev 3 — a stuck-on-bad-bundle
    /// server must look unhealthy, not flatline).
    pub reload_consecutive_failures: AtomicU64,
    /// `reload_last_success_timestamp_seconds` — unix seconds when the
    /// runner last adopted a new generation. `0` until first adoption.
    pub reload_last_success_timestamp_seconds: AtomicU64,
    /// `reload_pending_coalesced_total` — number of SIGHUPs absorbed by the
    /// pending-reload latch while another reload was in flight.
    pub reload_pending_coalesced_total: AtomicU64,
    /// `mapped_generation_count` — number of live `Generation` instances.
    /// `Generation::new` increments; `Generation::drop` decrements. Must be 1
    /// in steady state, briefly 2 during a reload. `AtomicI64` because the
    /// startup → drop sequence in tests may decrement before the matching
    /// increment is observed (and a negative reading is more diagnostic than
    /// a silent saturating-sub).
    pub mapped_generation_count: AtomicI64,
    /// High-watermark of `mapped_generation_count` over the process lifetime. NOT rendered on
    /// `/metrics` — a test/bench witness that the reload runner's "one `run_one` at a time"
    /// discipline held (the `mapped_generation_count <= 2` invariant): a sampled gauge can miss a
    /// transient third mapping, the watermark cannot.
    pub mapped_generation_watermark: AtomicI64,
    /// `generation_retired_total` — fires on `Generation::drop`. Combined
    /// with `mapped_generation_count`, lets the bench harness assert
    /// retirement without timing.
    pub generation_retired_total: AtomicU64,
    /// `reload_manifest_version_unsupported_total{found_version}` — labeled
    /// counter for the forward-incompat case. Cardinality is bounded
    /// by the number of distinct versions seen in a process lifetime.
    pub reload_manifest_version_unsupported_total: Mutex<HashMap<u32, AtomicU64>>,
    /// `generation_adopted_total{generation_id}` — counter per generation_id
    /// successfully adopted. Cardinality is bounded by the retention window
    /// (default ≤10 generations per process; operators can drop the label at
    /// scrape time).
    pub generation_adopted_total: Mutex<HashMap<String, AtomicU64>>,
    /// `current_generation_adopted_timestamp_seconds` — unix seconds when
    /// the currently-active generation was first adopted (the swap moment,
    /// NOT manifest.createdAt).
    pub current_generation_adopted_timestamp_seconds: AtomicU64,
    /// `current_generation_id` — the id label rendered alongside
    /// `current_generation_info{generation_id=...} 1`. Owned as `Mutex<String>`
    /// because Prometheus exposition reads a coherent snapshot of (id,
    /// adopted_at) per scrape.
    pub current_generation_id: Mutex<String>,

    // Incremented by the dispatcher on receipt, decremented in the same frame after the handler
    // returns (panic-or-not, via the dispatcher's catch_unwind). the transport timeout reads the
    // same atomic to bound preStop drain residency.
    pub inflight_requests: AtomicU64,
    /// `ready_503` — flipped to `true` by the preStop hook so the aux-listener `/ready` returns 503
    /// while in-flight requests drain.
    pub ready_503: AtomicBool,

    // ---- Stage-C C2c loopback listener surface ----
    /// `loopback_inflight_requests` — gauge of requests currently being
    /// dispatched on the loopback (`:9002`) listener's worker pool. Mirrors
    /// `inflight_requests` but for the loopback listener; the dispatcher
    /// inc/decs whichever gauge matches the receiving listener so the two
    /// listeners' in-flight counts never cross-pollute.
    pub loopback_inflight_requests: AtomicU64,
    /// `loopback_pool_size` — configured loopback worker count, set once at
    /// startup by [`crate::http::loopback_pool::LoopbackPool::new`]. A static
    /// gauge so operators can confirm the loopback pool was spun up with the
    /// expected width.
    pub loopback_pool_size: AtomicU64,
    /// `scheduled_departures_truncated_total` — fired by the
    /// `/scheduled-departures-for-stop` handler each time the candidate set
    /// exceeds `maxResults` and the response is truncated to the earliest
    /// `maxResults` rows. Operators alert on a sustained rate: a client whose
    /// window routinely truncates is likely paginating poorly or requesting a
    /// too-busy stop.
    pub scheduled_departures_truncated_total: AtomicU64,

    // Counter, unlabeled — the watchdog has a single "deadline expired" trigger today; future-task
    // labels (read / write / compute) would shape this into a `Mutex<HashMap<&'static str,
    // AtomicU64>>` like `reload_total`.
    pub request_timeouts_total: AtomicU64,


    pub last_good_age_exceeds_retention_total: AtomicU64,
    /// `startup_fallback_active` — `true` when the startup loader fell
    /// back from `current.json` to `last-good.json`. Reflected in `/ready`
    /// (`servingLastGoodFallback`). Cleared on the first successful reload
    /// that adopts a new generation (the swap proves `current.json` is
    /// healthy again).
    pub startup_fallback_active: AtomicBool,
    /// `startup_generation_fallback_total` — monotonic counter incremented once each time the
    /// startup loader adopts `last-good.json` after a failed `current.json`. Distinct from
    /// `startup_fallback_active` (a boolean cleared on first successful reload) because alerts need
    /// a rate signal: a process that boot-falls-back THEN reloads cleanly would show
    /// `startup_fallback_active=0` at scrape time, but the counter pins the event in history.
    pub startup_generation_fallback_total: AtomicU64,
    /// `forced_current_mode_active` — `true` when `--force-current` was
    /// supplied at startup. Sticky for the process lifetime (operators
    /// clear by restarting WITHOUT the flag AND re-publishing). Reflected
    /// in `/ready` (`forcedCurrentMode`) and `/metrics`
    /// (`pt_serve_forced_current_mode`). The metric exists so a Prometheus
    /// alert can fire when forced mode is live (it's a DR escape hatch,
    /// not a normal mode of operation).
    pub forced_current_mode_active: AtomicBool,
    /// `response_write_failures_total` — fires on client-disconnect
    /// mid-write or TCP write errors at the `req.respond(…)` boundary in
    /// `http::server::dispatch`. Bumped at the three sites where a
    /// `tiny_http::Request::respond` outcome is otherwise dropped (413
    /// over-cap, 413 over-stream, normal response). Operators alert when
    /// this rate spikes relative to `plan_requests_total` — a sustained
    /// share indicates a client-side timeout or a network pathology.
    pub response_write_failures_total: AtomicU64,
    /// tzdb release age in days, parsed from `pt_shared::tz::IANA_TZDB_VERSION`
    /// at startup. Set ONCE during main.rs init (after the horizon check
    /// passes) and never updated thereafter — operators rebuild the image
    /// to pick up a newer tzdb release, and a process restart re-runs the
    /// check. A `-1` sentinel means "not yet initialised" (the check
    /// hasn't run, which should only be observable during very early test
    /// harnesses; production reaches `set_tzdb_release_age_days` before
    /// `/metrics` is reachable).
    pub tzdb_release_age_days: AtomicI64,
    /// `reload_duration_seconds` — hand-rolled cumulative histogram over
    /// the buckets in the pt-serve budget file.
    /// Bucket i counts reloads whose duration ≤ `bucket_le[i]` seconds.
    /// `+Inf` bucket is the last element (always equal to `count`). The
    /// runner samples `Instant::now()` at entry to `run_one_inner` and
    /// computes the diff before incrementing.
    ///
    /// Hand-rolled (not `prometheus::Histogram`) to avoid pulling in the
    /// full `prometheus` crate for a single series — the metric exposition
    /// is rendered manually in `render_body` from the cumulative counts.
    pub reload_duration_seconds: ReloadDurationHistogram,

    // ---- C2b read-route surface ----
    /// `pt_serve_requests_total{route,status}` — the per-route status counter.
    /// It began as C2b-only (`color-config`, `shapes`, whose
    /// 404-on-advertise-desync and 503-during-reload responses were the
    /// operationally significant signals) and every read route added since has
    /// joined it. Current callers, all in `http::server::dispatch`:
    /// `scheduled-departures-for-stop`, `departures-for-stop`, `color-config`,
    /// `stops-all`, `stops-nearby`, `shapes`, `gtfs-manifest`, `schedule-tile`,
    /// `rt-tile`. The non-route endpoints (plan, raptor-bundle, transfers,
    /// health, ready, version, metrics) still do NOT call `inc_request`.
    ///
    /// Keyed by `(route, status)` `&'static str` pairs so the label set cannot
    /// grow unbounded. Adding a LABEL here ends and restarts the series of
    /// every route above at once — see `rt_tile_cache_total` for why a new
    /// counter name is the right way to add a dimension to one route.
    pub requests_total: Mutex<HashMap<(&'static str, &'static str), AtomicU64>>,
    /// `pt_serve_poi_tile_requests_total{poi_city,status}`. `poi_city` is
    /// classified against the immutable manifest and collapses to `unknown`
    /// unless it is one of the at-most-four strict corpus cities.
    pub poi_tile_requests_total: Mutex<HashMap<(String, &'static str), AtomicU64>>,
    /// `pt_serve_poi_tile_shed_total{poi_city}` — a SUBSET of the 503s already
    /// counted above, isolating deliberate load shedding
    /// (`POI_TILE_BUILD_BUSY`) from the durable per-city
    /// `POI_TILE_DELIVERY_INACTIVE`. Both land on `status="503"` in
    /// `poi_tile_requests_total`, so that counter alone cannot tell an operator
    /// whether a corpus is switched off or the build pool is merely saturated —
    /// which is exactly what `PoiTileErrorRate` alerts on.
    ///
    /// A separate counter rather than a `reason` label on the existing one:
    /// this repo ships no Prometheus, so operators point their own at PTN
    /// (the alert rules opens by saying exactly that). A metric's
    /// label set is therefore a published API to a fleet that cannot be
    /// inventoried or migrated — adding a label ends every existing series and
    /// restarts it at zero, silently breaking any `increase()` or long-range
    /// query across the deploy. A new NAME is invisible to existing queries.
    ///
    /// Shedding is also Rust-only: Node coalesces same-key builds and never
    /// emits this, so a `reason` label there would be permanently empty. (Note
    /// the two planes already use different metric names — Node's is
    /// `pt_poi_tile_requests_total` — so "symmetry" is about the `pt_serve_`
    /// prefix convention, not a shared series.)
    ///
    /// `poi_city` is classified through the same single bounded helper as the
    /// request counter, so this label set cannot grow past the four strict
    /// manifest cities plus `unknown`.
    pub poi_tile_shed_total: Mutex<HashMap<String, AtomicU64>>,
    /// `pt_serve_rt_tile_cache_total{cache,outcome}` — hit/miss for each of the
    /// RT overlay route's two caches. Keyed by `&'static str` pairs from fixed
    /// sets (`cache` ∈ `response`|`membership`, `outcome` ∈ `hit`|`miss`), so
    /// this is four series and cannot grow.
    ///
    /// STATUS IS NOT DUPLICATED HERE. `app/rt_tile.rs` is already counted by
    /// status through `requests_total{route="rt-tile",status}` in the
    /// dispatcher. What that counter cannot express is cache behaviour, and the
    /// route's whole design premise is that a 10 s TTL response cache absorbs
    /// client polling (`ops/rt_tile_response_cache.rs`). A cache that silently
    /// stops hitting costs a tile read, a brotli decompress and a JSON decode
    /// per request on the request thread, and shows up in no other signal this
    /// process emits.
    ///
    /// A separate NAME rather than a `cache_hit` label on `requests_total`, for
    /// the reason `poi_tile_shed_total` documents at length: this repo ships no
    /// Prometheus, so a metric's label set is a published API to a fleet that
    /// cannot be inventoried. Adding a label to `requests_total` would end and
    /// restart the series of all nine routes that share it, not just this one.
    ///
    /// Both caches are counted because their miss costs differ by orders of
    /// magnitude: a response miss re-merges RT from memory, a membership miss
    /// also re-reads and re-decodes the schedule tile from disk. Node counts
    /// only the response cache (`cache_hit` on `pt_rt_tile_request_total`) and
    /// its membership `Map` has no counter at all, so this is strictly more
    /// than the plane it replaces.
    pub rt_tile_cache_total: Mutex<HashMap<(&'static str, &'static str), AtomicU64>>,
    /// `pt_serve_client_engine_failure_reports_total{kind}` — opt-in client engine-failure reports.
    /// Node parity: `pt_client_engine_failure_reports_total` in
    /// `packages/backend/src/metrics/registry.ts`.
    ///
    /// Keyed by `&'static str` from `CLIENT_REPORT_KINDS`, never from the
    /// request body. That is the point of the allowlist in
    /// `app/client_report.rs`: the label value arrives over the network from an
    /// untrusted client, so accepting it verbatim would let anyone mint
    /// unbounded metric series. An unrecognised `kind` is a 400 and increments
    /// nothing, so the series count is fixed at five.
    ///
    /// Deliberately a DIFFERENT NAME from Node's, like every other counter
    /// here: the `pt_` / `pt_serve_` split is what attributes a report to a
    /// plane during the cutover, and both planes accept this route until the
    /// per-city containers go.
    pub client_engine_failure_reports_total: Mutex<HashMap<&'static str, AtomicU64>>,
}

/// Hand-rolled cumulative histogram for reload durations. The bucket
/// boundaries match the pt-serve budget file
/// (`[0.01, 0.1, 0.5, 1, 2, 5, 10, 30]`) plus an implicit `+Inf` bucket.
#[derive(Debug)]
pub struct ReloadDurationHistogram {
    /// Cumulative bucket counts. `buckets[i]` = number of observations with
    /// duration ≤ `BUCKET_LE[i]` seconds. Length is `BUCKET_LE.len() + 1`;
    /// the last element is the `+Inf` bucket (== `count`).
    buckets: Vec<AtomicU64>,
    /// `sum` of all observations in seconds, scaled to micros and
    /// stored as u64 (so we have integer arithmetic on observation
    /// addition). Rendered as a float in `render_body`.
    sum_micros: AtomicU64,
}

/// Bucket upper bounds in seconds. Mirrors
/// the pt-serve budget file.
pub const RELOAD_DURATION_BUCKET_LE: &[f64] = &[0.01, 0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0];

impl ReloadDurationHistogram {
    fn new() -> Self {
        let n = RELOAD_DURATION_BUCKET_LE.len() + 1; // +1 for the +Inf bucket
        let mut buckets = Vec::with_capacity(n);
        for _ in 0..n {
            buckets.push(AtomicU64::new(0));
        }
        Self {
            buckets,
            sum_micros: AtomicU64::new(0),
        }
    }

    /// Record a reload duration. Incremented buckets are CUMULATIVE — a
    /// 50ms reload bumps the 0.1, 0.5, 1, 2, 5, 10, 30, and +Inf buckets
    /// (every bucket whose `le` is ≥ the observation).
    pub fn observe(&self, secs: f64) {
        let micros = (secs * 1_000_000.0).max(0.0) as u64;
        self.sum_micros.fetch_add(micros, Ordering::Relaxed);
        for (i, &le) in RELOAD_DURATION_BUCKET_LE.iter().enumerate() {
            if secs <= le {
                self.buckets[i].fetch_add(1, Ordering::Relaxed);
            }
        }
        // +Inf bucket: always increment.
        let last = self.buckets.len() - 1;
        self.buckets[last].fetch_add(1, Ordering::Relaxed);
    }

    /// Total count of observations (== `+Inf` bucket).
    pub fn count(&self) -> u64 {
        self.buckets
            .last()
            .map(|a| a.load(Ordering::Relaxed))
            .unwrap_or(0)
    }

    /// Sum of all observations in seconds.
    pub fn sum_secs(&self) -> f64 {
        self.sum_micros.load(Ordering::Relaxed) as f64 / 1_000_000.0
    }

    /// Read bucket `i` (cumulative). Used by `render_body`.
    pub fn bucket(&self, i: usize) -> u64 {
        self.buckets[i].load(Ordering::Relaxed)
    }
}

impl Default for ReloadDurationHistogram {
    fn default() -> Self {
        Self::new()
    }
}

impl Metrics {
    /// Build a `Arc<Metrics>` with sentinel-initialised fields.
    /// Most counters start at zero (via `Default`); `tzdb_release_age_days`
    /// starts at -1 to signal "not yet initialised" — set by `main.rs` after
    /// the tzdb horizon check runs (before any listener is bound).
    pub fn new() -> Arc<Self> {
        let m = Arc::new(Self::default());
        m.tzdb_release_age_days.store(-1, Ordering::Relaxed);
        m
    }

    /// Increment `plan_requests_total`.
    pub fn inc_plan_requests(&self) {
        self.plan_requests.fetch_add(1, Ordering::Relaxed);
    }

    /// Increment `oversized_plan_requests_total`.
    pub fn inc_oversized_plan_requests(&self) {
        self.oversized_plan_requests.fetch_add(1, Ordering::Relaxed);
    }

    /// Current value of `plan_requests_total` (test/debug only).
    pub fn plan_requests(&self) -> u64 {
        self.plan_requests.load(Ordering::Relaxed)
    }

    /// Current value of `oversized_plan_requests_total` (test/debug only).
    pub fn oversized_plan_requests(&self) -> u64 {
        self.oversized_plan_requests.load(Ordering::Relaxed)
    }

    /// Increment `reload_total{result,cause}`. Creates the (result, cause)
    /// cell lazily if it doesn't already exist.
    pub fn inc_reload_total(&self, result: ReloadResult, cause: ReloadCause) {
        let mut m = self
            .reload_total
            .lock()
            .expect("reload_total Mutex poisoned");
        m.entry((result, cause))
            .or_insert_with(|| AtomicU64::new(0))
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Read `reload_total{result,cause}`. Returns 0 when the cell has never
    /// been written.
    pub fn reload_total(&self, result: ReloadResult, cause: ReloadCause) -> u64 {
        let m = self
            .reload_total
            .lock()
            .expect("reload_total Mutex poisoned");
        m.get(&(result, cause))
            .map(|a| a.load(Ordering::Relaxed))
            .unwrap_or(0)
    }

    /// `reload_consecutive_failures` += 1 on a failed reload.
    pub fn inc_reload_consecutive_failures(&self) {
        self.reload_consecutive_failures
            .fetch_add(1, Ordering::Relaxed);
    }

    /// `reload_consecutive_failures` = 0 — called ONLY on `result="ok"`.
    /// `noop` does NOT reset this counter (rev 3 fix).
    pub fn reset_reload_consecutive_failures(&self) {
        self.reload_consecutive_failures.store(0, Ordering::Relaxed);
    }

    /// Read `reload_consecutive_failures`.
    pub fn reload_consecutive_failures(&self) -> u64 {
        self.reload_consecutive_failures.load(Ordering::Relaxed)
    }

    /// Set `reload_last_success_timestamp_seconds` to `t`.
    pub fn set_reload_last_success_timestamp_seconds(&self, t: u64) {
        self.reload_last_success_timestamp_seconds
            .store(t, Ordering::Relaxed);
    }

    /// Read `reload_last_success_timestamp_seconds`.
    pub fn reload_last_success_timestamp_seconds(&self) -> u64 {
        self.reload_last_success_timestamp_seconds
            .load(Ordering::Relaxed)
    }

    /// Increment `reload_pending_coalesced_total` by 1. Fired by the signal
    /// loop when a second SIGHUP lands during an in-flight reload.
    pub fn inc_reload_pending_coalesced_total(&self) {
        self.reload_pending_coalesced_total
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Read `reload_pending_coalesced_total`.
    pub fn reload_pending_coalesced_total(&self) -> u64 {
        self.reload_pending_coalesced_total.load(Ordering::Relaxed)
    }

    /// `mapped_generation_count` += 1 on `Generation::new`.
    pub fn inc_mapped_generation_count(&self) {
        let now = self.mapped_generation_count.fetch_add(1, Ordering::Relaxed) + 1;
        self.mapped_generation_watermark
            .fetch_max(now, Ordering::Relaxed);
    }

    /// Read the lifetime high-watermark of `mapped_generation_count`.
    pub fn mapped_generation_watermark(&self) -> i64 {
        self.mapped_generation_watermark.load(Ordering::Relaxed)
    }

    /// `mapped_generation_count` -= 1 on `Generation::drop`.
    pub fn dec_mapped_generation_count(&self) {
        self.mapped_generation_count.fetch_sub(1, Ordering::Relaxed);
    }

    /// Read `mapped_generation_count`.
    pub fn mapped_generation_count(&self) -> i64 {
        self.mapped_generation_count.load(Ordering::Relaxed)
    }

    /// `generation_retired_total` += 1 on `Generation::drop`.
    pub fn inc_generation_retired_total(&self) {
        self.generation_retired_total
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Read `generation_retired_total`.
    pub fn generation_retired_total(&self) -> u64 {
        self.generation_retired_total.load(Ordering::Relaxed)
    }

    /// Increment `reload_manifest_version_unsupported_total{found_version}`.
    pub fn inc_reload_manifest_version_unsupported(&self, found_version: u32) {
        let mut m = self
            .reload_manifest_version_unsupported_total
            .lock()
            .expect("reload_manifest_version_unsupported_total Mutex poisoned");
        m.entry(found_version)
            .or_insert_with(|| AtomicU64::new(0))
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Read `reload_manifest_version_unsupported_total{found_version}`.
    pub fn reload_manifest_version_unsupported(&self, found_version: u32) -> u64 {
        let m = self
            .reload_manifest_version_unsupported_total
            .lock()
            .expect("reload_manifest_version_unsupported_total Mutex poisoned");
        m.get(&found_version)
            .map(|a| a.load(Ordering::Relaxed))
            .unwrap_or(0)
    }

    /// Increment `generation_adopted_total{generation_id}`.
    pub fn inc_generation_adopted_total(&self, generation_id: &str) {
        let mut m = self
            .generation_adopted_total
            .lock()
            .expect("generation_adopted_total Mutex poisoned");
        m.entry(generation_id.to_string())
            .or_insert_with(|| AtomicU64::new(0))
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Read `generation_adopted_total{generation_id}`.
    pub fn generation_adopted_total(&self, generation_id: &str) -> u64 {
        let m = self
            .generation_adopted_total
            .lock()
            .expect("generation_adopted_total Mutex poisoned");
        m.get(generation_id)
            .map(|a| a.load(Ordering::Relaxed))
            .unwrap_or(0)
    }

    /// Record a generation adoption: bump per-id counter, snapshot id and
    /// adopted-at into the info-gauge surface. Called by the reload runner
    /// (and once at startup for the initial generation).
    pub fn record_generation_adopted(&self, generation_id: &str, unix_secs: u64) {
        self.inc_generation_adopted_total(generation_id);
        self.current_generation_adopted_timestamp_seconds
            .store(unix_secs, Ordering::Relaxed);
        let mut id = self
            .current_generation_id
            .lock()
            .expect("current_generation_id Mutex poisoned");
        *id = generation_id.to_string();
    }

    /// Read `current_generation_adopted_timestamp_seconds`.
    pub fn current_generation_adopted_timestamp_seconds(&self) -> u64 {
        self.current_generation_adopted_timestamp_seconds
            .load(Ordering::Relaxed)
    }

    /// Read the current generation id (clone). Empty when no adoption has
    /// ever been recorded — the startup path records the initial generation
    /// so a healthy process always has a non-empty id here.
    pub fn current_generation_id(&self) -> String {
        self.current_generation_id
            .lock()
            .expect("current_generation_id Mutex poisoned")
            .clone()
    }

    /// `inflight_requests` += 1. Called by the dispatcher on receipt of any
    /// request handed off to the main listener's worker pool. Returns the
    /// pre-increment value (unused today; kept for future call-site tests
    /// that want to observe ordering without a re-read).
    pub fn inc_inflight_requests(&self) -> u64 {
        self.inflight_requests.fetch_add(1, Ordering::Relaxed)
    }

    /// `inflight_requests` -= 1. Decrements via `fetch_sub` — relaxed because
    /// the value is diagnostic, and the dispatcher's catch_unwind guarantees
    /// the dec runs even on a handler panic.
    pub fn dec_inflight_requests(&self) {
        self.inflight_requests.fetch_sub(1, Ordering::Relaxed);
    }

    /// Read `inflight_requests`.
    pub fn inflight_requests(&self) -> u64 {
        self.inflight_requests.load(Ordering::Relaxed)
    }

    /// `loopback_inflight_requests` += 1. Called by the dispatcher on receipt
    /// of any request handed off to the loopback listener's worker pool.
    pub fn inc_loopback_inflight(&self) {
        self.loopback_inflight_requests
            .fetch_add(1, Ordering::Relaxed);
    }

    /// `loopback_inflight_requests` -= 1. Relaxed — the value is diagnostic,
    /// and the dispatcher's catch_unwind guarantees the dec runs even on a
    /// handler panic.
    pub fn dec_loopback_inflight(&self) {
        self.loopback_inflight_requests
            .fetch_sub(1, Ordering::Relaxed);
    }

    /// Read `loopback_inflight_requests`.
    pub fn loopback_inflight_requests(&self) -> u64 {
        self.loopback_inflight_requests.load(Ordering::Relaxed)
    }

    /// Set `loopback_pool_size` — called once at startup by the loopback pool
    /// constructor with the configured worker count.
    pub fn set_loopback_pool_size(&self, n: u64) {
        self.loopback_pool_size.store(n, Ordering::Relaxed);
    }

    /// Read `loopback_pool_size`.
    pub fn loopback_pool_size(&self) -> u64 {
        self.loopback_pool_size.load(Ordering::Relaxed)
    }

    /// `scheduled_departures_truncated_total` += 1 — called by the
    /// `/scheduled-departures-for-stop` handler when the candidate set is
    /// truncated to `maxResults`.
    pub fn inc_scheduled_departures_truncated(&self) {
        self.scheduled_departures_truncated_total
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Read `scheduled_departures_truncated_total`.
    pub fn scheduled_departures_truncated_total(&self) -> u64 {
        self.scheduled_departures_truncated_total
            .load(Ordering::Relaxed)
    }

    /// Set `ready_503` to `true` — called by the preStop hook so that `/ready` returns 503 while
    /// in-flight requests drain.
    pub fn set_ready_503(&self) {
        self.ready_503.store(true, Ordering::SeqCst);
    }

    /// Clear `ready_503`. Tests use this to model the (currently unused)
    /// recovery path; production never clears it — the preStop hook only
    /// ever transitions the process toward shutdown.
    pub fn clear_ready_503(&self) {
        self.ready_503.store(false, Ordering::SeqCst);
    }

    /// Read `ready_503`. The aux-listener `/ready` handler consults this.
    pub fn ready_503(&self) -> bool {
        self.ready_503.load(Ordering::SeqCst)
    }

    /// `request_timeouts_total` += 1 — called by the timeout watchdog when a
    /// registered request's dwell exceeds `request_timeout_ms`. Relaxed
    /// ordering: the counter is diagnostic, not synchronisation-bearing.
    pub fn inc_request_timeouts_total(&self) {
        self.request_timeouts_total.fetch_add(1, Ordering::Relaxed);
    }

    /// Read `request_timeouts_total`.
    pub fn request_timeouts_total(&self) -> u64 {
        self.request_timeouts_total.load(Ordering::Relaxed)
    }

    /// `last_good_age_exceeds_retention_total` += 1 — fired by the retention janitor when
    /// `last-good.json` references a generation older than the retention window.
    pub fn inc_last_good_age_exceeds_retention_total(&self) {
        self.last_good_age_exceeds_retention_total
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Read `last_good_age_exceeds_retention_total`.
    pub fn last_good_age_exceeds_retention_total(&self) -> u64 {
        self.last_good_age_exceeds_retention_total
            .load(Ordering::Relaxed)
    }

    /// Set `startup_fallback_active` — flipped to `true` by the startup
    /// loader if `current.json` fails and `last-good.json` is adopted. The
    /// first successful reload that adopts a new generation clears it.
    pub fn set_startup_fallback_active(&self, active: bool) {
        self.startup_fallback_active.store(active, Ordering::SeqCst);
    }

    /// Read `startup_fallback_active`.
    pub fn startup_fallback_active(&self) -> bool {
        self.startup_fallback_active.load(Ordering::SeqCst)
    }

    /// `startup_generation_fallback_total` += 1 — called by the startup
    /// loader once when `current.json` failed and `last-good.json` was
    /// adopted instead. Distinct from the boolean
    /// `set_startup_fallback_active(true)` because the boolean is cleared on
    /// the first successful reload while this counter is monotonic, so a
    /// dashboard can rate-limit alert on fallback events even when the
    /// process recovers.
    pub fn inc_startup_generation_fallback_total(&self) {
        self.startup_generation_fallback_total
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Read `startup_generation_fallback_total`.
    pub fn startup_generation_fallback_total(&self) -> u64 {
        self.startup_generation_fallback_total
            .load(Ordering::Relaxed)
    }

    /// Set `forced_current_mode_active` — flipped to `true` once at startup
    /// by the loader when `--force-current` is supplied. Sticky for the
    /// process lifetime.
    pub fn set_forced_current_mode_active(&self, active: bool) {
        self.forced_current_mode_active
            .store(active, Ordering::SeqCst);
    }

    /// Read `forced_current_mode_active`.
    pub fn forced_current_mode_active(&self) -> bool {
        self.forced_current_mode_active.load(Ordering::SeqCst)
    }

    /// Set `tzdb_release_age_days` — called once at startup by `main.rs`
    /// after `tzdb_horizon::check_horizon()` returns `Ok(age_days)`.
    pub fn set_tzdb_release_age_days(&self, age_days: i64) {
        self.tzdb_release_age_days.store(age_days, Ordering::SeqCst);
    }

    /// Increment `pt_serve_requests_total{route,status}`. `route`/`status` are
    /// `&'static str` (fixed label sets) so cardinality stays bounded.
    pub fn inc_request(&self, route: &'static str, status: &'static str) {
        self.requests_total
            .lock()
            .expect("requests_total Mutex poisoned")
            .entry((route, status))
            .or_insert_with(|| AtomicU64::new(0))
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Read `pt_serve_requests_total{route,status}`. 0 when never written.
    pub fn requests_total(&self, route: &str, status: &str) -> u64 {
        self.requests_total
            .lock()
            .expect("requests_total Mutex poisoned")
            .iter()
            .find(|((r, s), _)| *r == route && *s == status)
            .map(|(_, c)| c.load(Ordering::Relaxed))
            .unwrap_or(0)
    }

    /// Increment the bounded per-city POI tile counter. Callers must pass only
    /// a manifest-classified city label or `unknown`.
    pub fn inc_poi_tile_request(&self, poi_city: &str, status: &'static str) {
        let mut counters = self
            .poi_tile_requests_total
            .lock()
            .expect("poi_tile_requests_total Mutex poisoned");
        if let Some((_, counter)) = counters
            .iter()
            .find(|((city, recorded_status), _)| city == poi_city && *recorded_status == status)
        {
            counter.fetch_add(1, Ordering::Relaxed);
            return;
        }
        counters.insert((poi_city.to_owned(), status), AtomicU64::new(1));
    }

    /// Increment `pt_serve_poi_tile_shed_total{poi_city}`. Call this IN ADDITION
    /// to `inc_poi_tile_request(poi_city, "503")` when the 503 is deliberate
    /// load shedding rather than a corpus being inactive — the shed counter is a
    /// subset of the 503s, not a replacement for them. Same city-label
    /// classification, so the label set stays bounded.
    pub fn inc_poi_tile_shed(&self, poi_city: &str) {
        let mut counters = self
            .poi_tile_shed_total
            .lock()
            .expect("poi_tile_shed_total Mutex poisoned");
        if let Some(counter) = counters.get(poi_city) {
            counter.fetch_add(1, Ordering::Relaxed);
            return;
        }
        counters.insert(poi_city.to_owned(), AtomicU64::new(1));
    }

    /// Read `pt_serve_poi_tile_shed_total{poi_city}`.
    pub fn poi_tile_shed_total(&self, poi_city: &str) -> u64 {
        self.poi_tile_shed_total
            .lock()
            .expect("poi_tile_shed_total Mutex poisoned")
            .get(poi_city)
            .map(|counter| counter.load(Ordering::Relaxed))
            .unwrap_or(0)
    }

    /// Increment `pt_serve_rt_tile_cache_total{cache,outcome}`. Both labels are
    /// `&'static str` from fixed sets, so cardinality is bounded at compile
    /// time. Counts a CACHE CONSULTATION, not a request: an exit that returns
    /// before consulting a cache records nothing here, so these series do not
    /// sum to `requests_total{route="rt-tile"}`.
    pub fn inc_rt_tile_cache(&self, cache: &'static str, outcome: &'static str) {
        self.rt_tile_cache_total
            .lock()
            .expect("rt_tile_cache_total Mutex poisoned")
            .entry((cache, outcome))
            .or_insert_with(|| AtomicU64::new(0))
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Read `pt_serve_rt_tile_cache_total{cache,outcome}`. 0 when never written.
    pub fn rt_tile_cache_total(&self, cache: &str, outcome: &str) -> u64 {
        self.rt_tile_cache_total
            .lock()
            .expect("rt_tile_cache_total Mutex poisoned")
            .iter()
            .find(|((c, o), _)| *c == cache && *o == outcome)
            .map(|(_, counter)| counter.load(Ordering::Relaxed))
            .unwrap_or(0)
    }

    /// Increment `pt_serve_client_engine_failure_reports_total{kind}`. `kind` is
    /// a `&'static str` borrowed from the compile-time allowlist, NEVER the
    /// caller's own bytes — see the field doc.
    pub fn inc_client_engine_failure_report(&self, kind: &'static str) {
        self.client_engine_failure_reports_total
            .lock()
            .expect("client_engine_failure_reports_total Mutex poisoned")
            .entry(kind)
            .or_insert_with(|| AtomicU64::new(0))
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Read `pt_serve_client_engine_failure_reports_total{kind}`. 0 when never
    /// written.
    pub fn client_engine_failure_reports_total(&self, kind: &str) -> u64 {
        self.client_engine_failure_reports_total
            .lock()
            .expect("client_engine_failure_reports_total Mutex poisoned")
            .iter()
            .find(|(k, _)| **k == kind)
            .map(|(_, counter)| counter.load(Ordering::Relaxed))
            .unwrap_or(0)
    }

    /// Read `pt_serve_poi_tile_requests_total{poi_city,status}`.
    pub fn poi_tile_requests_total(&self, poi_city: &str, status: &str) -> u64 {
        self.poi_tile_requests_total
            .lock()
            .expect("poi_tile_requests_total Mutex poisoned")
            .iter()
            .find(|((city, recorded_status), _)| city == poi_city && *recorded_status == status)
            .map(|(_, counter)| counter.load(Ordering::Relaxed))
            .unwrap_or(0)
    }

    /// `response_write_failures_total` += 1 — called at the
    /// `req.respond(…)` boundary in `http::server::dispatch` when the
    /// write returns an error (typically a client disconnect).
    pub fn inc_response_write_failures(&self) {
        self.response_write_failures_total
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Read `response_write_failures_total`.
    pub fn response_write_failures_total(&self) -> u64 {
        self.response_write_failures_total.load(Ordering::Relaxed)
    }
}

/// Parse the `Pss:` line of `/proc/self/smaps_rollup`, returning bytes (kB * 1024).
///
/// Returns `None` when the text contains no `Pss:` line or the value is non-numeric.
pub fn parse_smaps_rollup_pss(text: &str) -> Option<u64> {
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("Pss:") {
            let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
            return Some(kb * 1024);
        }
    }
    None
}

/// Read `/proc/self/smaps_rollup` and return the Pss in bytes.
/// Returns `None` on any I/O error or missing `Pss:` line (e.g. on macOS).
fn resident_bytes() -> Option<u64> {
    let text = std::fs::read_to_string("/proc/self/smaps_rollup").ok()?;
    parse_smaps_rollup_pss(&text)
}

/// Build the Prometheus text-exposition body for a specific `Metrics` instance.
/// Emits:
/// - `resident_bytes` (gauge) — only on Linux where `/proc/self/smaps_rollup` is readable.
/// - `plan_requests_total` (counter) — always emitted.
/// - `oversized_plan_requests_total` (counter) — always emitted.
/// - the P4 reload surface — always emitted, zeros included.
pub fn render_body(metrics: &Metrics) -> String {
    let mut body = String::new();

    if let Some(rb) = resident_bytes() {
        body.push_str("# HELP resident_bytes Process resident set (Pss from smaps_rollup).\n");
        body.push_str("# TYPE resident_bytes gauge\n");
        body.push_str(&format!("resident_bytes {rb}\n"));
    }

    body.push_str("# HELP plan_requests_total Total /plan requests received.\n");
    body.push_str("# TYPE plan_requests_total counter\n");
    body.push_str(&format!(
        "plan_requests_total {}\n",
        metrics.plan_requests()
    ));

    body.push_str(
        "# HELP oversized_plan_requests_total /plan requests rejected with 413 (body over cap).\n",
    );
    body.push_str("# TYPE oversized_plan_requests_total counter\n");
    body.push_str(&format!(
        "oversized_plan_requests_total {}\n",
        metrics.oversized_plan_requests()
    ));

    // ---- P4 reload surface ----
    body.push_str("# HELP reload_total Reload attempts by (result, cause).\n");
    body.push_str("# TYPE reload_total counter\n");
    {
        let m = metrics
            .reload_total
            .lock()
            .expect("reload_total Mutex poisoned");
        for ((result, cause), counter) in m.iter() {
            body.push_str(&format!(
                "reload_total{{result=\"{}\",cause=\"{}\"}} {}\n",
                result.as_str(),
                cause.as_str(),
                counter.load(Ordering::Relaxed)
            ));
        }
    }

    body.push_str(
        "# HELP pt_serve_poi_tile_requests_total POI tile requests by bounded manifest city and status.\n",
    );
    body.push_str("# TYPE pt_serve_poi_tile_requests_total counter\n");
    {
        let m = metrics
            .poi_tile_requests_total
            .lock()
            .expect("poi_tile_requests_total Mutex poisoned");
        for ((poi_city, status), counter) in m.iter() {
            body.push_str(&format!(
                "pt_serve_poi_tile_requests_total{{poi_city=\"{}\",status=\"{}\"}} {}\n",
                poi_city,
                status,
                counter.load(Ordering::Relaxed)
            ));
        }
    }

    {
        let m = metrics
            .poi_tile_shed_total
            .lock()
            .expect("poi_tile_shed_total Mutex poisoned");
        if !m.is_empty() {
            body.push_str(
                "# HELP pt_serve_poi_tile_shed_total POI tile 503s that are deliberate load shedding (POI_TILE_BUILD_BUSY), a subset of poi_tile_requests_total{status=\"503\"}.\n",
            );
            body.push_str("# TYPE pt_serve_poi_tile_shed_total counter\n");
            for (poi_city, counter) in m.iter() {
                body.push_str(&format!(
                    "pt_serve_poi_tile_shed_total{{poi_city=\"{}\"}} {}\n",
                    poi_city,
                    counter.load(Ordering::Relaxed)
                ));
            }
        }
    }

    {
        let m = metrics
            .rt_tile_cache_total
            .lock()
            .expect("rt_tile_cache_total Mutex poisoned");
        if !m.is_empty() {
            body.push_str(
                "# HELP pt_serve_rt_tile_cache_total RT overlay tile cache consultations by cache and outcome. Does NOT sum to requests_total{route=\"rt-tile\"} — pre-cache exits consult no cache.\n",
            );
            body.push_str("# TYPE pt_serve_rt_tile_cache_total counter\n");
            for ((cache, outcome), counter) in m.iter() {
                body.push_str(&format!(
                    "pt_serve_rt_tile_cache_total{{cache=\"{}\",outcome=\"{}\"}} {}\n",
                    cache,
                    outcome,
                    counter.load(Ordering::Relaxed)
                ));
            }
        }
    }

    {
        let m = metrics
            .client_engine_failure_reports_total
            .lock()
            .expect("client_engine_failure_reports_total Mutex poisoned");
        // Absent until the first accepted report, like poi_tile_shed_total. A
        // rejected (400) report increments nothing, so an empty block here
        // means "no valid reports", not "no traffic".
        if !m.is_empty() {
            body.push_str(
                "# HELP pt_serve_client_engine_failure_reports_total Opt-in client engine-failure reports by kind.\n",
            );
            body.push_str("# TYPE pt_serve_client_engine_failure_reports_total counter\n");
            for (kind, counter) in m.iter() {
                body.push_str(&format!(
                    "pt_serve_client_engine_failure_reports_total{{kind=\"{}\"}} {}\n",
                    kind,
                    counter.load(Ordering::Relaxed)
                ));
            }
        }
    }

    body.push_str("# HELP reload_consecutive_failures Consecutive failed reloads since last ok.\n");
    body.push_str("# TYPE reload_consecutive_failures gauge\n");
    body.push_str(&format!(
        "reload_consecutive_failures {}\n",
        metrics.reload_consecutive_failures()
    ));

    body.push_str(
        "# HELP reload_last_success_timestamp_seconds Unix seconds of last successful reload.\n",
    );
    body.push_str("# TYPE reload_last_success_timestamp_seconds gauge\n");
    body.push_str(&format!(
        "reload_last_success_timestamp_seconds {}\n",
        metrics.reload_last_success_timestamp_seconds()
    ));

    body.push_str(
        "# HELP reload_pending_coalesced_total SIGHUPs absorbed by the pending-reload latch.\n",
    );
    body.push_str("# TYPE reload_pending_coalesced_total counter\n");
    body.push_str(&format!(
        "reload_pending_coalesced_total {}\n",
        metrics.reload_pending_coalesced_total()
    ));

    body.push_str("# HELP mapped_generation_count Live Generation instances.\n");
    body.push_str("# TYPE mapped_generation_count gauge\n");
    body.push_str(&format!(
        "mapped_generation_count {}\n",
        metrics.mapped_generation_count()
    ));

    body.push_str(
        "# HELP generation_retired_total Generation::drop firings since process start.\n",
    );
    body.push_str("# TYPE generation_retired_total counter\n");
    body.push_str(&format!(
        "generation_retired_total {}\n",
        metrics.generation_retired_total()
    ));

    body.push_str(
        "# HELP reload_manifest_version_unsupported_total Forward-incompat manifest version sightings.\n",
    );
    body.push_str("# TYPE reload_manifest_version_unsupported_total counter\n");
    {
        let m = metrics
            .reload_manifest_version_unsupported_total
            .lock()
            .expect("reload_manifest_version_unsupported_total Mutex poisoned");
        for (version, counter) in m.iter() {
            body.push_str(&format!(
                "reload_manifest_version_unsupported_total{{found_version=\"{}\"}} {}\n",
                version,
                counter.load(Ordering::Relaxed)
            ));
        }
    }

    body.push_str("# HELP generation_adopted_total Successful adoptions by generation_id.\n");
    body.push_str("# TYPE generation_adopted_total counter\n");
    {
        let m = metrics
            .generation_adopted_total
            .lock()
            .expect("generation_adopted_total Mutex poisoned");
        for (gen_id, counter) in m.iter() {
            body.push_str(&format!(
                "generation_adopted_total{{generation_id=\"{}\"}} {}\n",
                gen_id,
                counter.load(Ordering::Relaxed)
            ));
        }
    }

    body.push_str(
        "# HELP current_generation_adopted_timestamp_seconds Unix seconds of current generation's adoption.\n",
    );
    body.push_str("# TYPE current_generation_adopted_timestamp_seconds gauge\n");
    body.push_str(&format!(
        "current_generation_adopted_timestamp_seconds {}\n",
        metrics.current_generation_adopted_timestamp_seconds()
    ));

    body.push_str(
        "# HELP current_generation_info Info gauge with constant label set; value always 1.\n",
    );
    body.push_str("# TYPE current_generation_info gauge\n");
    body.push_str(&format!(
        "current_generation_info{{generation_id=\"{}\"}} 1\n",
        metrics.current_generation_id()
    ));


    body.push_str(
        "# HELP inflight_requests Requests currently dispatched on the public listeners.\n",
    );
    body.push_str("# TYPE inflight_requests gauge\n");
    body.push_str(&format!(
        "inflight_requests {}\n",
        metrics.inflight_requests()
    ));

    // ---- Stage-C C2c loopback listener surface ----
    body.push_str(
        "# HELP loopback_inflight_requests Requests currently dispatched on the loopback listener.\n",
    );
    body.push_str("# TYPE loopback_inflight_requests gauge\n");
    body.push_str(&format!(
        "loopback_inflight_requests {}\n",
        metrics.loopback_inflight_requests()
    ));

    body.push_str("# HELP loopback_pool_size Configured loopback worker count.\n");
    body.push_str("# TYPE loopback_pool_size gauge\n");
    body.push_str(&format!(
        "loopback_pool_size {}\n",
        metrics.loopback_pool_size()
    ));

    body.push_str(
        "# HELP scheduled_departures_truncated_total /scheduled-departures-for-stop responses truncated to maxResults.\n",
    );
    body.push_str("# TYPE scheduled_departures_truncated_total counter\n");
    body.push_str(&format!(
        "scheduled_departures_truncated_total {}\n",
        metrics.scheduled_departures_truncated_total()
    ));

    body.push_str("# HELP ready_503 1 when preStop has flipped /ready to 503, 0 otherwise.\n");
    body.push_str("# TYPE ready_503 gauge\n");
    body.push_str(&format!(
        "ready_503 {}\n",
        if metrics.ready_503() { 1 } else { 0 }
    ));


    body.push_str(
        "# HELP request_timeouts_total Requests forcibly closed because their dwell exceeded request_timeout_ms.\n",
    );
    body.push_str("# TYPE request_timeouts_total counter\n");
    body.push_str(&format!(
        "request_timeouts_total {}\n",
        metrics.request_timeouts_total()
    ));

    //
    // (`reload_signals_dropped_total` previously emitted here was a permanently-
    // zero gauge — signal_hook's iterator model does not drop in practice.
    // Removed to avoid dashboards keying off a counter that cannot rise.)
    body.push_str(
        "# HELP last_good_age_exceeds_retention_total last-good references a generation past the retention window.\n",
    );
    body.push_str("# TYPE last_good_age_exceeds_retention_total counter\n");
    body.push_str(&format!(
        "last_good_age_exceeds_retention_total {}\n",
        metrics.last_good_age_exceeds_retention_total()
    ));

    body.push_str(
        "# HELP startup_generation_fallback_total Boot-time fallback events (current.json failed; last-good.json adopted).\n",
    );
    body.push_str("# TYPE startup_generation_fallback_total counter\n");
    body.push_str(&format!(
        "startup_generation_fallback_total {}\n",
        metrics.startup_generation_fallback_total()
    ));

    body.push_str(
        "# HELP pt_serve_forced_current_mode 1 when --force-current was supplied at startup (DR escape hatch active).\n",
    );
    body.push_str("# TYPE pt_serve_forced_current_mode gauge\n");
    body.push_str(&format!(
        "pt_serve_forced_current_mode {}\n",
        if metrics.forced_current_mode_active() {
            1
        } else {
            0
        }
    ));

    body.push_str(
        "# HELP pt_serve_tzdb_release_age_days Age in days of the IANA tzdb release compiled into pt-serve.\n",
    );
    body.push_str("# TYPE pt_serve_tzdb_release_age_days gauge\n");
    body.push_str(&format!(
        "pt_serve_tzdb_release_age_days {}\n",
        metrics.tzdb_release_age_days.load(Ordering::SeqCst)
    ));

    body.push_str(
        "# HELP response_write_failures_total Response writes that failed at req.respond(…) (client disconnect / TCP error).\n",
    );
    body.push_str("# TYPE response_write_failures_total counter\n");
    body.push_str(&format!(
        "response_write_failures_total {}\n",
        metrics.response_write_failures_total()
    ));

    // ---- C2b read-route surface ----
    body.push_str("# HELP pt_serve_requests_total C2 read-route requests by (route, status).\n");
    body.push_str("# TYPE pt_serve_requests_total counter\n");
    {
        let m = metrics
            .requests_total
            .lock()
            .expect("requests_total Mutex poisoned");
        for ((route, status), counter) in m.iter() {
            body.push_str(&format!(
                "pt_serve_requests_total{{route=\"{}\",status=\"{}\"}} {}\n",
                route,
                status,
                counter.load(Ordering::Relaxed)
            ));
        }
    }

    // reload_duration_seconds histogram. Buckets defined in
    // RELOAD_DURATION_BUCKET_LE (mirrored in the pt-serve budget file
    // histogramBuckets).
    body.push_str(
        "# HELP reload_duration_seconds Wall-clock duration of one reload pass (Instant::now() at entry to exit).\n",
    );
    body.push_str("# TYPE reload_duration_seconds histogram\n");
    for (i, &le) in RELOAD_DURATION_BUCKET_LE.iter().enumerate() {
        body.push_str(&format!(
            "reload_duration_seconds_bucket{{le=\"{le}\"}} {}\n",
            metrics.reload_duration_seconds.bucket(i)
        ));
    }
    let last_idx = RELOAD_DURATION_BUCKET_LE.len();
    body.push_str(&format!(
        "reload_duration_seconds_bucket{{le=\"+Inf\"}} {}\n",
        metrics.reload_duration_seconds.bucket(last_idx)
    ));
    body.push_str(&format!(
        "reload_duration_seconds_sum {}\n",
        metrics.reload_duration_seconds.sum_secs()
    ));
    body.push_str(&format!(
        "reload_duration_seconds_count {}\n",
        metrics.reload_duration_seconds.count()
    ));

    // Linux-only process gauges. On macOS dev runs `/proc` does not exist
    // and emitting zeros would lie about the platform's introspection
    // surface; cfg-gating means the series are ABSENT on non-Linux scrapes
    // (the Prometheus contract for missing series is "unknown", which is
    // correct here).
    #[cfg(target_os = "linux")]
    {
        if let Some(n) = read_proc_self_status_num_threads() {
            body.push_str(
                "# HELP process_threads OS threads in the process (/proc/self/status Threads:).\n",
            );
            body.push_str("# TYPE process_threads gauge\n");
            body.push_str(&format!("process_threads {n}\n"));
        }
        if let Some(n) = count_proc_self_fds() {
            body.push_str("# HELP process_open_fds Open file descriptors in the process (count of /proc/self/fd).\n");
            body.push_str("# TYPE process_open_fds gauge\n");
            body.push_str(&format!("process_open_fds {n}\n"));
        }
    }

    // `pt_serve_up` — Prometheus-blackbox-style "I'm alive" gauge. Always
    // emits 1 on every scrape: an absent series means the scrape itself
    // failed (process down, network blackhole), while `pt_serve_up 1` plus
    // the rest of the surface proves the process is responsive AND has a
    // working metrics path. Cheap and load-bearing for alert rules that
    // join against this on `up == 1`.
    body.push_str("# HELP pt_serve_up Always 1 when the metrics endpoint responds. Absence => scrape failed.\n");
    body.push_str("# TYPE pt_serve_up gauge\n");
    body.push_str("pt_serve_up 1\n");

    body
}

/// Parse the `Threads:` line of `/proc/self/status`. Linux-only — the
/// callers cfg-gate the use. Returns `None` if the file isn't present or
/// the line is malformed.
#[cfg(target_os = "linux")]
fn read_proc_self_status_num_threads() -> Option<u64> {
    let text = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("Threads:") {
            return rest.split_whitespace().next()?.parse().ok();
        }
    }
    None
}

/// Count entries in `/proc/self/fd`. Linux-only — the callers cfg-gate.
/// Returns `None` if the directory isn't present.
#[cfg(target_os = "linux")]
fn count_proc_self_fds() -> Option<u64> {
    let entries = std::fs::read_dir("/proc/self/fd").ok()?;
    Some(entries.filter_map(|e| e.ok()).count() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
00400000-7fff00000000 ---p 00000000 00:00 0      [rollup]
Rss:               12345 kB
Pss:                9876 kB
Pss_Anon:           4000 kB
Private_Clean:      2000 kB
Private_Dirty:      3000 kB
Shared_Clean:       1000 kB
";

    #[test]
    fn parses_pss_bytes() {
        assert_eq!(parse_smaps_rollup_pss(SAMPLE), Some(9876 * 1024));
    }

    #[test]
    fn missing_pss_is_none() {
        assert_eq!(parse_smaps_rollup_pss("Rss: 1 kB\n"), None);
    }

    /// `Arc::new(Metrics::default())` must give zero-initialised counters — the per-test isolation
    /// helper depends on this trivial path.
    #[test]
    fn default_metrics_is_zero_initialised() {
        let m: Arc<Metrics> = Arc::new(Metrics::default());
        assert_eq!(m.plan_requests(), 0);
        assert_eq!(m.oversized_plan_requests(), 0);
        assert_eq!(m.reload_consecutive_failures(), 0);
        assert_eq!(m.mapped_generation_count(), 0);
        assert_eq!(m.generation_retired_total(), 0);
        assert_eq!(
            m.reload_total(ReloadResult::Ok, ReloadCause::None),
            0,
            "reload_total cells default to 0"
        );
    }

    /// Per-instance counters do NOT cross-pollute. Two `Arc<Metrics>` are
    /// independent — the regression that this guards against is a sneaky
    /// reintroduction of process-globals.
    #[test]
    fn per_instance_counters_are_independent() {
        let a = Metrics::new();
        let b = Metrics::new();
        a.inc_plan_requests();
        a.inc_oversized_plan_requests();
        a.inc_reload_total(ReloadResult::Ok, ReloadCause::None);
        a.inc_mapped_generation_count();
        assert_eq!(a.plan_requests(), 1);
        assert_eq!(a.reload_total(ReloadResult::Ok, ReloadCause::None), 1);
        assert_eq!(a.mapped_generation_count(), 1);
        assert_eq!(b.plan_requests(), 0);
        assert_eq!(b.reload_total(ReloadResult::Ok, ReloadCause::None), 0);
        assert_eq!(b.mapped_generation_count(), 0);
    }

    /// `noop` MUST NOT reset reload_consecutive_failures. We model the call sites explicitly in
    /// this unit test so a future refactor that conflates noop and ok regressing this rule fails
    /// here before any integration test runs.
    #[test]
    fn noop_does_not_reset_consecutive_failures() {
        let m = Metrics::new();
        m.inc_reload_consecutive_failures();
        m.inc_reload_consecutive_failures();
        assert_eq!(m.reload_consecutive_failures(), 2);
        // Simulate a noop — increment the counter, do NOT reset.
        m.inc_reload_total(ReloadResult::Noop, ReloadCause::None);
        assert_eq!(m.reload_consecutive_failures(), 2, "noop must not reset");
        // Now an Ok — the runner calls reset_reload_consecutive_failures.
        m.reset_reload_consecutive_failures();
        assert_eq!(m.reload_consecutive_failures(), 0);
    }

    #[test]
    fn generation_adopted_label_increments_per_id() {
        let m = Metrics::new();
        m.record_generation_adopted("gen_a", 1000);
        m.record_generation_adopted("gen_b", 2000);
        m.record_generation_adopted("gen_b", 2500);
        assert_eq!(m.generation_adopted_total("gen_a"), 1);
        assert_eq!(m.generation_adopted_total("gen_b"), 2);
        assert_eq!(m.generation_adopted_total("gen_c"), 0);
        // last-write-wins for the info-gauge surface.
        assert_eq!(m.current_generation_id(), "gen_b");
        assert_eq!(m.current_generation_adopted_timestamp_seconds(), 2500);
    }

    /// Exposition body MUST render every key reload series even when zero —
    /// scrape consumers expect stable series names rather than missing
    /// keys (Prometheus best practice).
    #[test]
    fn render_body_emits_reload_surface_on_zero_state() {
        let m = Metrics::new();
        let body = render_body(&m);
        assert!(body.contains("reload_consecutive_failures 0\n"));
        assert!(body.contains("mapped_generation_count 0\n"));
        assert!(body.contains("generation_retired_total 0\n"));
        assert!(body.contains("reload_pending_coalesced_total 0\n"));
        assert!(body.contains("# TYPE reload_total counter"));
        // The info gauge renders an empty label when no adoption has been
        // recorded; the line still appears so the series is discoverable.
        assert!(body.contains("current_generation_info{generation_id=\"\"} 1"));
    }

    /// the worker-pool surface (`inflight_requests`, `ready_503`) is part of the zero-state
    /// exposition — same Prometheus best-practice rule as the reload series. Regression guard for a
    /// future refactor that drops the gauges when they've never been touched.
    #[test]
    fn render_body_emits_worker_pool_surface_on_zero_state() {
        let m = Metrics::new();
        let body = render_body(&m);
        assert!(body.contains("# TYPE inflight_requests gauge"));
        assert!(body.contains("inflight_requests 0\n"));
        assert!(body.contains("# TYPE ready_503 gauge"));
        assert!(body.contains("ready_503 0\n"));
    }

    /// `inflight_requests` inc/dec round-trip + reflection in the exposition.
    /// The dispatcher inc's on receipt and dec's after handler return; this
    /// asserts both legs are observable in `render_body`.
    #[test]
    fn inflight_requests_round_trip_and_renders() {
        let m = Metrics::new();
        m.inc_inflight_requests();
        m.inc_inflight_requests();
        assert_eq!(m.inflight_requests(), 2);
        let body = render_body(&m);
        assert!(
            body.contains("inflight_requests 2\n"),
            "exposition must reflect current inflight value; body: {body}"
        );
        m.dec_inflight_requests();
        assert_eq!(m.inflight_requests(), 1);
    }

    /// Stage-C C2c loopback gauges are part of the zero-state exposition and
    /// inc/dec/set round-trip independently of the public `inflight_requests`
    /// gauge (no cross-pollution between listeners).
    #[test]
    fn loopback_gauges_round_trip_and_render() {
        let m = Metrics::new();
        let body = render_body(&m);
        assert!(body.contains("# TYPE loopback_inflight_requests gauge"));
        assert!(body.contains("loopback_inflight_requests 0\n"));
        assert!(body.contains("# TYPE loopback_pool_size gauge"));
        assert!(body.contains("loopback_pool_size 0\n"));
        assert!(body.contains("# TYPE scheduled_departures_truncated_total counter"));
        assert!(body.contains("scheduled_departures_truncated_total 0\n"));

        m.inc_loopback_inflight();
        m.inc_loopback_inflight();
        m.set_loopback_pool_size(2);
        assert_eq!(m.loopback_inflight_requests(), 2);
        assert_eq!(m.loopback_pool_size(), 2);
        // The public inflight gauge is untouched by loopback inc's.
        assert_eq!(m.inflight_requests(), 0);

        let body = render_body(&m);
        assert!(body.contains("loopback_inflight_requests 2\n"));
        assert!(body.contains("loopback_pool_size 2\n"));

        m.dec_loopback_inflight();
        assert_eq!(m.loopback_inflight_requests(), 1);

        // The truncation counter increments + renders independently.
        assert_eq!(m.scheduled_departures_truncated_total(), 0);
        m.inc_scheduled_departures_truncated();
        m.inc_scheduled_departures_truncated();
        assert_eq!(m.scheduled_departures_truncated_total(), 2);
        assert!(render_body(&m).contains("scheduled_departures_truncated_total 2\n"));
    }

    /// The watchdog increments it on each detected deadline.
    #[test]
    fn render_body_emits_timeout_surface_on_zero_state() {
        let m = Metrics::new();
        let body = render_body(&m);
        assert!(body.contains("# TYPE request_timeouts_total counter"));
        assert!(body.contains("request_timeouts_total 0\n"));
    }

    /// `request_timeouts_total` inc + read + render round-trip.
    #[test]
    fn request_timeouts_total_round_trip_and_renders() {
        let m = Metrics::new();
        assert_eq!(m.request_timeouts_total(), 0);
        m.inc_request_timeouts_total();
        m.inc_request_timeouts_total();
        m.inc_request_timeouts_total();
        assert_eq!(m.request_timeouts_total(), 3);
        let body = render_body(&m);
        assert!(
            body.contains("request_timeouts_total 3\n"),
            "exposition must reflect current timeouts count; body: {body}"
        );
    }

    /// `ready_503` flips render to `1`; clear flips back.
    #[test]
    fn ready_503_flag_round_trip_and_renders() {
        let m = Metrics::new();
        assert!(!m.ready_503(), "default is false");
        m.set_ready_503();
        assert!(m.ready_503());
        assert!(render_body(&m).contains("ready_503 1\n"));
        m.clear_ready_503();
        assert!(!m.ready_503());
        assert!(render_body(&m).contains("ready_503 0\n"));
    }


    #[test]
    fn render_body_emits_operability_surface_on_zero_state() {
        let m = Metrics::new();
        let body = render_body(&m);
        // reload_signals_dropped_total was removed (T8 fix: dead paranoia
        // gauge that signal_hook's iterator model could never bump in
        // practice). Confirm absence so dashboards keying off a stale
        // series name surface the change loudly.
        assert!(!body.contains("reload_signals_dropped_total"));
        assert!(body.contains("# TYPE last_good_age_exceeds_retention_total counter"));
        assert!(body.contains("last_good_age_exceeds_retention_total 0\n"));
        assert!(body.contains("# TYPE startup_generation_fallback_total counter"));
        assert!(body.contains("startup_generation_fallback_total 0\n"));
        assert!(body.contains("# TYPE pt_serve_up gauge"));
        assert!(body.contains("pt_serve_up 1\n"));
    }

    #[test]
    fn last_good_age_exceeds_retention_increments_and_renders() {
        let m = Metrics::new();
        m.inc_last_good_age_exceeds_retention_total();
        assert_eq!(m.last_good_age_exceeds_retention_total(), 1);
        assert!(render_body(&m).contains("last_good_age_exceeds_retention_total 1\n"));
    }

    #[test]
    fn startup_generation_fallback_increments_and_renders() {
        let m = Metrics::new();
        assert_eq!(m.startup_generation_fallback_total(), 0);
        m.inc_startup_generation_fallback_total();
        assert_eq!(m.startup_generation_fallback_total(), 1);
        assert!(render_body(&m).contains("startup_generation_fallback_total 1\n"));
    }

    /// `startup_fallback_active` is a plain boolean flag, not rendered in
    /// /metrics (it surfaces via /ready). Test just covers the accessor
    /// round-trip.
    #[test]
    fn startup_fallback_active_round_trip() {
        let m = Metrics::new();
        assert!(!m.startup_fallback_active());
        m.set_startup_fallback_active(true);
        assert!(m.startup_fallback_active());
        m.set_startup_fallback_active(false);
        assert!(!m.startup_fallback_active());
    }

    /// Linux-only series: only assert their PRESENCE under cfg(linux). The
    /// /proc reads are best-effort — a sandboxed runner without /proc would
    /// see `None` from the helpers and the series would be omitted.
    #[cfg(target_os = "linux")]
    #[test]
    fn render_body_emits_linux_process_gauges() {
        let m = Metrics::new();
        let body = render_body(&m);
        if std::path::Path::new("/proc/self/status").exists() {
            assert!(body.contains("# TYPE process_threads gauge"));
            assert!(body.contains("process_threads "));
        }
        if std::path::Path::new("/proc/self/fd").exists() {
            assert!(body.contains("# TYPE process_open_fds gauge"));
            assert!(body.contains("process_open_fds "));
        }
    }

    /// On macOS, the Linux-only series MUST NOT appear in the scrape — the
    /// cfg-gate is the contract for "this platform has no introspection
    /// for this".
    #[cfg(target_os = "macos")]
    #[test]
    fn render_body_omits_linux_process_gauges_on_macos() {
        let m = Metrics::new();
        let body = render_body(&m);
        assert!(
            !body.contains("process_threads"),
            "process_threads must not appear on macOS dev runs (cfg-gated to Linux)"
        );
        assert!(
            !body.contains("process_open_fds"),
            "process_open_fds must not appear on macOS dev runs (cfg-gated to Linux)"
        );
    }

    #[test]
    fn requests_total_labeled_round_trip_and_renders() {
        let m = Metrics::new();
        m.inc_request("shapes", "200");
        m.inc_request("shapes", "200");
        m.inc_request("color-config", "503");
        assert_eq!(m.requests_total("shapes", "200"), 2);
        assert_eq!(m.requests_total("color-config", "503"), 1);
        assert_eq!(m.requests_total("shapes", "404"), 0);
        let body = render_body(&m);
        assert!(body.contains("# TYPE pt_serve_requests_total counter"));
        assert!(
            body.contains("pt_serve_requests_total{route=\"shapes\",status=\"200\"} 2\n"),
            "body:\n{body}"
        );
    }

    #[test]
    fn poi_tile_requests_total_labeled_round_trip_and_renders() {
        let m = Metrics::new();
        m.inc_poi_tile_request("vilnius", "200");
        m.inc_poi_tile_request("vilnius", "200");
        m.inc_poi_tile_request("unknown", "404");
        assert_eq!(m.poi_tile_requests_total("vilnius", "200"), 2);
        assert_eq!(m.poi_tile_requests_total("unknown", "404"), 1);
        assert_eq!(m.poi_tile_requests_total("vilnius", "409"), 0);
        let body = render_body(&m);
        assert!(body.contains("# TYPE pt_serve_poi_tile_requests_total counter"));
        assert!(body
            .contains("pt_serve_poi_tile_requests_total{poi_city=\"vilnius\",status=\"200\"} 2\n"));
    }

    #[test]
    fn rt_tile_cache_counter_round_trips_and_renders() {
        let m = Metrics::new();
        // Absent until first use, like the shed counter: a route that is dark
        // behind nginx should not publish four permanently-zero series.
        assert!(!render_body(&m).contains("pt_serve_rt_tile_cache_total"));

        m.inc_rt_tile_cache("response", "miss");
        m.inc_rt_tile_cache("response", "hit");
        m.inc_rt_tile_cache("response", "hit");
        m.inc_rt_tile_cache("membership", "miss");
        assert_eq!(m.rt_tile_cache_total("response", "hit"), 2);
        assert_eq!(m.rt_tile_cache_total("response", "miss"), 1);
        assert_eq!(m.rt_tile_cache_total("membership", "miss"), 1);
        assert_eq!(m.rt_tile_cache_total("membership", "hit"), 0);

        let body = render_body(&m);
        assert!(body.contains("# TYPE pt_serve_rt_tile_cache_total counter"));
        assert!(
            body.contains("pt_serve_rt_tile_cache_total{cache=\"response\",outcome=\"hit\"} 2\n")
        );
        assert!(body
            .contains("pt_serve_rt_tile_cache_total{cache=\"membership\",outcome=\"miss\"} 1\n"));
    }

    /// The two counters answer different questions and must not be conflated:
    /// `requests_total{route="rt-tile"}` counts responses, `rt_tile_cache_total`
    /// counts cache consultations, and a pre-cache exit increments only the
    /// former. Asserted here so the render block's HELP text stays true.
    #[test]
    fn rt_tile_cache_series_do_not_sum_to_rt_tile_requests() {
        let m = Metrics::new();
        m.inc_request("rt-tile", "400"); // pre-cache exit: consults no cache
        m.inc_request("rt-tile", "200");
        m.inc_rt_tile_cache("response", "miss");

        assert_eq!(m.requests_total("rt-tile", "400"), 1);
        assert_eq!(m.requests_total("rt-tile", "200"), 1);
        let cache_events: u64 = ["hit", "miss"]
            .iter()
            .flat_map(|o| ["response", "membership"].map(|c| m.rt_tile_cache_total(c, o)))
            .sum();
        assert_eq!(cache_events, 1, "pre-cache exits must not be counted here");
    }

    #[test]
    fn poi_tile_shed_counter_round_trips_and_renders() {
        let m = Metrics::new();
        assert_eq!(m.poi_tile_shed_total("vilnius"), 0);
        // Absent until the first shed: unlike its sibling, the render block is
        // gated on emptiness so a server that never sheds emits no series.
        assert!(!render_body(&m).contains("pt_serve_poi_tile_shed_total"));

        m.inc_poi_tile_shed("vilnius");
        m.inc_poi_tile_shed("vilnius");
        m.inc_poi_tile_shed("unknown");
        assert_eq!(m.poi_tile_shed_total("vilnius"), 2);
        assert_eq!(m.poi_tile_shed_total("unknown"), 1);
        assert_eq!(m.poi_tile_shed_total("gdansk"), 0);

        let body = render_body(&m);
        assert!(body.contains("# TYPE pt_serve_poi_tile_shed_total counter"));
        assert!(body.contains("pt_serve_poi_tile_shed_total{poi_city=\"vilnius\"} 2\n"));
    }

    #[test]
    fn shed_is_a_subset_of_the_503s_never_a_replacement() {
        // The alert subtracts shed from the pt-serve 5xx numerator, which is
        // only sound if every shed ALSO lands in the requests counter as a
        // 503. Pin that relationship: the handler increments the shed counter
        // and the dispatcher independently records the 503.
        let m = Metrics::new();
        m.inc_poi_tile_shed("vilnius");
        m.inc_poi_tile_request("vilnius", "503");
        assert_eq!(m.poi_tile_requests_total("vilnius", "503"), 1);
        assert_eq!(m.poi_tile_shed_total("vilnius"), 1);
        // Subtracting one from the other must not go negative.
        assert!(m.poi_tile_requests_total("vilnius", "503") >= m.poi_tile_shed_total("vilnius"));
    }
}
