//! `--max-rss` startup guard.
//!
//! At startup, **after** loading the initial generation (and **before** binding any listener), we
//! compute the resident-set ceiling we expect the process to occupy and compare it against the
//! operator-pinned `max_rss_bytes`. If the projection exceeds the limit, pt-serve refuses to bind —
//! the JSON breakdown on stderr tells the operator exactly which term blew the budget so they can
//! either raise the limit, shrink a bundle, or drop a worker.
//!
//! ## The estimate
//!
//! ```text
//!   estimate = 2 * (payload + transfers)
//!            + process_fixed_overhead_bytes
//!            + (worker_pool_size + 1 auxiliary + loopback_worker_count)
//!                * per_worker_overhead_bytes
//!            + schedule_tile_cache_max_bytes
//!            + rt_tile_membership_cache_max_entries * RT_TILE_MEMBERSHIP_ENTRY_BYTES_ASSUMED
//!            + rt_tile_response_cache_max_entries * RT_TILE_RESPONSE_ENTRY_BYTES_ASSUMED
//!            + poi_bundle_max_decoded_bytes * MAX_POI_CITY_SLOTS * POI_CITY_ENTRIES_RSS_FACTOR_ASSUMED
//!            + poi_tile_cache_max_bytes
//!            + configured_poi_brotli_concurrency * poi_brotli_scratch_bytes_per_build
//!            + (rt_urls nonempty) * (RT_POLLER_PROCESS_FIXED_BYTES
//!                + rt_url_count * RT_POLLER_ASSUMED_MAX_ENTRIES_PER_FEED
//!                    * RT_POLLER_SNAPSHOT_ENTRY_BYTES_ASSUMED)
//! ```
//!
//! `schedule_tile_cache_max_bytes` reserves for the schedule-tile response
//! cache (`ops/tile_cache.rs`) at its configured budget ceiling, not its
//! live occupancy. The STATIC estimate this guard computes must stay
//! truthful about worst-case reservation regardless of current traffic,
//! matching the process-lifetime nature of every other term here.
//! Constrained deployments configure it down (or to `0`) via
//! `PT_SERVE_SCHEDULE_TILE_CACHE_MAX_BYTES`.
//!
//! The two rt-tile caches (`ops/rt_tile_membership_cache.rs`,
//! `ops/rt_tile_response_cache.rs`) are bounded by ENTRY COUNT, not bytes
//! (matching Node's `RT_TILE_LRU_SIZE`) — there is no direct byte config to
//! sum, so each gets an `_ENTRY_BYTES_ASSUMED` conversion constant, same
//! "seeded, not runtime-calibrated" status as `process_fixed_overhead_bytes`
//! / `per_worker_overhead_bytes` below. the pt-serve budget file
//! `_rtTileCacheRebaselineObligation` tracks replacing these placeholders
//! with a measured average.
//!
//! NOTE ON GATING, because it is the first thing to check when the 40 MiB
//! rt-tile reservation looks alarming: unlike the POI terms (gated on
//! `poi_bundle_dir`) and `rt_poller_term` (gated on `rt_trip_updates_urls`),
//! the two rt-tile terms are added UNCONDITIONALLY. They were charged on
//! every deployed process while the route was still dark behind nginx, so
//! flipping the axis moved this estimate by zero bytes. Both caches also
//! bound entry COUNT at 4096 against a densest-corpus tile count of 402
//! (paris), so the occupancy the reservation is sized off is not reachable
//! by any corpus this repo serves — see that obligation's `_flipState`.
//!
//! Earlier revisions of this doc described the schedule-tile and rt-tile
//! caches as "dark (no nginx flip)". Both axes are now flipped for every
//! city; the reservations are unchanged, which is the point above.
//!
//! The decoded POI entry cache has five fixed city slots, but city count does
//! not bound bytes. Each bundle read is capped by
//! `poi_bundle_max_decoded_bytes`; the estimator reserves that cap for every
//! profile, multiplied by a conservative factor for `PoiEntry`, `String`,
//! alias-map, and allocator overhead over the source JSON bytes.
//!
//! POI response caching is byte-bounded. The estimator reserves the exact
//! configured charged-byte ceiling rather than multiplying an entry count by
//! an assumed average. When POI is configured it also reserves two concurrent
//! quality-11 encoder slots, matching Node's `ZLIB_CONCURRENCY`. Each slot
//! includes a conservative 64 MiB fixed working set for the crate's lgwin-22
//! encoder plus bounded input/output buffers derived from the configured
//! decoded-bundle cap. `PoiTileResponseCache` enforces the concurrency ceiling.
//!
//! The `2 *` factor reserves headroom for the **transient window during a
//! hot reload** when BOTH the old and new generations are mmap-resident.
//! Steady-state RSS settles to ~1× payload once the old generation
//! retires; the 2× is the calibration knob that keeps the OOMKiller off
//! the process during the swap. Operators sizing `--max-rss-bytes` must
//! accommodate the 2× transient — sizing for steady-state risks OOM
//! during reload.
//!
//! The factor also bounds the warm-up: during `Index::build` the engine
//! touches every page of the freshly-mapped bundle; the kernel LRU
//! keeps a substantial slice resident for the hot working set. Both
//! the reload-transient and warm-up bounds collapse to the same `2×`
//! constant — the [`tests::rss_guard_pins_2x_factor_exactly`] test
//! brackets it between 1 (too loose for the transient) and 3 (too tight
//! for warm-up amplification) to pin it at exactly 2.
//!
//! The GTFS-RT poller term is gated on a non-empty `rt_trip_updates_urls`,
//! for the same reason the POI terms are gated on `poi_bundle_dir`:
//! `RtPoller::new` returns early on an empty URL list, so a process without
//! feeds spawns no poll thread and allocates no snapshot. Unlike every other
//! term here, its dominant cost is FIXED rather than proportional to a
//! configured ceiling — see [`RT_POLLER_PROCESS_FIXED_BYTES`]. The snapshot
//! itself is the one term in this estimate with **no config bound at all**:
//! how many entries a feed delivers is the agency's choice, not an operator
//! knob, so it is reserved against an assumed per-feed entry ceiling.
//!
//! The per-term `_overhead_bytes` knobs are NOT calibrated at runtime; they are seeded from the P3
//! idle baseline recorded under the pt-serve budget file (`processFixedOverheadBytesAssumed` and
//! `perWorkerOverheadBytesAssumed`). the bench harness updates the file when the calibration
//! drifts.

use crate::ops::poi_tile_cache::POI_TILE_BUILD_CONCURRENCY;
use crate::ops::ServerConfig;
use crate::poi::catalog::MAX_POI_CITY_SLOTS;

/// The hard-coded multiplier on the (payload + transfers) term. See the
/// module-level docs for rationale; the bracketing test pins this to
/// exactly 2 — anyone proposing a different factor must update both the
/// estimator AND the bracketing assertions in `tests/rss_guard.rs`.
pub const PAYLOAD_RSS_FACTOR: u64 = 2;

/// The auxiliary lifecycle listener always owns exactly one worker.
pub const AUXILIARY_WORKER_COUNT: u64 = 1;

/// Assumed average heap footprint of one trip-membership cache entry (an
/// `Arc<[String]>` of trip ids for one tile) — NOT measured, a conservative
/// placeholder pending the empirical re-baseline
/// `_rtTileCacheRebaselineObligation` tracks.
/// ~50 trips/tile at ~40 bytes/String (heap alloc + struct overhead) rounds
/// up generously to 2 KiB.
pub const RT_TILE_MEMBERSHIP_ENTRY_BYTES_ASSUMED: u64 = 2 * 1024;

/// Assumed average byte size of one rt-tile response-cache entry (a full
/// JSON response body) — same "assumed, not measured" status. Generous
/// headroom over a ~50-trip tile's JSON encoding.
pub const RT_TILE_RESPONSE_ENTRY_BYTES_ASSUMED: u64 = 8 * 1024;

/// Fixed resident cost of running the GTFS-RT poller AT ALL, charged once
/// when any feed URL is configured: the `pt-serve-rt-poll` thread's touched
/// stack plus the ureq/rustls/ring code pages the first poll faults in.
///
/// MEASURED, unlike the `_ASSUMED` constants around it. The vilnius capture
/// pair on 2026-08-09 (runs 31336589978 `rt_poller=fixture` / 31336661915
/// `rt_poller=off`, both pinned to deimos, same commit) differenced to
/// **+1,007,616 B steady RSS at 9.2σ** over 10 samples each, of which only
/// 282,624 B was private-dirty. The ~708 KiB balance is shared/clean — the
/// resident code pages, not the heap. Note the fixture served plain
/// `http://127.0.0.1`, so no TLS handshake ever ran and the TLS stack still
/// cost that much resident; a real HTTPS feed can only be worse.
///
/// One capture point cannot separate `fixed + N * per_entry`; see
/// [`RT_POLLER_SNAPSHOT_ENTRY_BYTES_ASSUMED`] for the bounds. This constant
/// takes the whole measured delta as the fixed part and rounds up, which is
/// the conservative direction for a guard that must not under-reserve.
pub const RT_POLLER_PROCESS_FIXED_BYTES: u64 = 1024 * 1024;

/// Assumed heap footprint of one merged `RtSnapshot` entry: an
/// `RtSnapshot.merged` slot (`String` key → 16-byte `TripUpdate`) plus the
/// `by_trip` slot, which holds a CLONE of the same trip id because no wired
/// feed sets `trip.startDate` (`rt/state.rs`).
///
/// `TripUpdate` grew from 8 to 16 B on 2026-09-27 for time-only predictions
/// (`rt::resolve`): +8 B inline per entry, plus one boxed prediction (under
/// 100 B with its stop id) per trip that sent one, held in the poller's
/// per-feed state; the published snapshot never holds one. That stays inside
/// the headroom below without a re-measure, and the vilnius capture lane could
/// not show it anyway: vilnius sends delays only.
///
/// Bounded, not derived. The analytic floor is ~175-225 B/entry at these
/// feeds' ~23 B mean id length; the vilnius pair's private-dirty delta puts
/// an upper bound of 558 B/entry, and charging the ENTIRE delta per entry
/// (fixed = 0) would give 1991 B/entry. 1 KiB sits above the private-dirty
/// bound with headroom for allocator slack and hashbrown capacity overshoot,
/// without inheriting the fixed cost that
/// [`RT_POLLER_PROCESS_FIXED_BYTES`] already reserves.
pub const RT_POLLER_SNAPSHOT_ENTRY_BYTES_ASSUMED: u64 = 1024;

/// Assumed ceiling on merged entries per feed. `RtSnapshot` has NO
/// config-bounded size — entry count is whatever the agency publishes, and
/// it swings with service hours — so unlike every byte- or entry-capped
/// cache in this estimate there is nothing to read off `ServerConfig`.
///
/// 4096 is ~5.5x the busiest live sample measured across the four wired
/// feeds on 2026-08-09 (vilnius 741, krakow A 448 / M 150 / T 190, tricity
/// 288). A feed that exceeds it is under-reserved by this guard, which is
/// why the number is deliberately far above observation rather than near it.
pub const RT_POLLER_ASSUMED_MAX_ENTRIES_PER_FEED: u64 = 4096;

/// Parsed-heap multiplier over one bundle's decompressed JSON byte cap.
/// `PoiEntry` owns strings and alias maps in addition to the source bytes
/// represented on the wire, so this must exceed 1x: JSON length is not
/// equivalent to resident heap.
///
/// MEASURED, no longer assumed. Capture `30801452924` (`poi_corpus_mode=at-cap`,
/// four corpora at 99% of the 1 MiB cap, 4,151,487 decoded bytes total) moved
/// `privateDirtySteadyBytes` by 6,619,136 over the POI-off control
/// `30753886830`, a factor of **1.594x**. The marginal factor across that
/// capture and the single-corpus `real` run `30755738875` agrees at 1.551x.
/// Reserving 2x keeps ~25% headroom over a measurement taken at exactly the
/// condition this term reserves for -- the maximum decoded size -- and the
/// bench cannot observe allocator drift over production-length uptime.
///
/// The prior value was 4x, chosen before any measurement existed. The `real`
/// run's apparent 3.564x is NOT evidence against 1.594x: at 89,653 decoded
/// bytes, 8.5% of the cap, fixed per-entry overhead and allocator slack
/// dominate the ratio. This term reserves at the cap, so the at-cap factor is
/// the one that governs.
pub const POI_CITY_ENTRIES_RSS_FACTOR_ASSUMED: u64 = 2;

/// Process-lifetime decoded-entry slots. Startup rejects manifests with more
/// active strict corpora, keeping the static reservation and loader bound equal.
pub const POI_CITY_ENTRIES_CACHE_SLOTS: u64 = MAX_POI_CITY_SLOTS;

/// Conservative fixed working set for one quality-11 Brotli encoder at the
/// route's fixed default lgwin=22. The additional variable input/output
/// buffers are charged separately from `poi_bundle_max_decoded_bytes`.
///
/// STILL ASSUMED, deliberately. Capture `30801452924` bounds the WHOLE observed
/// scratch transient at 40,617,984 bytes against the 138,412,032 this term
/// reserves -- a real 3.4x headroom result -- but it does not isolate the
/// per-encoder working set. Backing one out requires assuming that the entire
/// non-steady peak is Brotli scratch (it also holds corpus-decode transients
/// and allocator high-water) AND that both build slots were live at the instant
/// of peak. If only one slot was active the per-slot figure doubles, and the
/// artifact does not record which. Isolating this needs an instrument that
/// samples RSS around a single build with concurrency pinned to 1.
pub const POI_BROTLI_ENCODER_WORKING_SET_BYTES: u64 = 64 * 1024 * 1024;

/// One serialized JSON input plus one not-yet-admitted compressed output.
pub const POI_BROTLI_TRANSIENT_BUFFER_FACTOR: u64 = 2;

fn total_http_worker_count(cfg: &ServerConfig) -> u64 {
    (cfg.worker_pool_size as u64)
        .saturating_add(AUXILIARY_WORKER_COUNT)
        .saturating_add(cfg.loopback_worker_count as u64)
}

fn poi_brotli_scratch_bytes_per_build(cfg: &ServerConfig) -> u64 {
    POI_BROTLI_ENCODER_WORKING_SET_BYTES.saturating_add(
        cfg.poi_bundle_max_decoded_bytes
            .saturating_mul(POI_BROTLI_TRANSIENT_BUFFER_FACTOR),
    )
}

fn poi_brotli_build_concurrency(cfg: &ServerConfig) -> u64 {
    if cfg.poi_bundle_dir.is_some() {
        POI_TILE_BUILD_CONCURRENCY as u64
    } else {
        0
    }
}

fn poi_brotli_scratch_term(cfg: &ServerConfig) -> u64 {
    poi_brotli_build_concurrency(cfg).saturating_mul(poi_brotli_scratch_bytes_per_build(cfg))
}

/// Gated on `poi_bundle_dir` for the same reason as
/// [`poi_brotli_build_concurrency`]: a process without a POI bundle directory
/// never populates this cache, so charging it shrinks the admissible
/// `2 × (payload + transfers)` envelope for a route that process does not
/// serve. Only one deployment passes `--poi-bundle-dir`; the rest would pay
/// for POI memory they never allocate.
fn poi_city_entries_cache_term(cfg: &ServerConfig) -> u64 {
    if cfg.poi_bundle_dir.is_none() {
        return 0;
    }
    cfg.poi_bundle_max_decoded_bytes
        .saturating_mul(POI_CITY_ENTRIES_CACHE_SLOTS)
        .saturating_mul(POI_CITY_ENTRIES_RSS_FACTOR_ASSUMED)
}

/// Feeds the poller will actually run, parsed exactly as `RtPoller` parses
/// them so the reservation cannot disagree with what gets spawned.
fn rt_poller_feed_count(cfg: &ServerConfig) -> u64 {
    cfg.rt_urls().len() as u64
}

/// Gated on a non-empty URL list: `RtPoller::new` returns early otherwise, so
/// a process with no feeds spawns no thread and holds no snapshot. Charging
/// it there would shrink the admissible payload envelope for a poller that
/// does not exist — paris has no feed at all, and oslo's is empty by default.
fn rt_poller_term(cfg: &ServerConfig) -> u64 {
    let feeds = rt_poller_feed_count(cfg);
    if feeds == 0 {
        return 0;
    }
    RT_POLLER_PROCESS_FIXED_BYTES.saturating_add(
        feeds
            .saturating_mul(RT_POLLER_ASSUMED_MAX_ENTRIES_PER_FEED)
            .saturating_mul(RT_POLLER_SNAPSHOT_ENTRY_BYTES_ASSUMED),
    )
}

/// Response-cache reservation, gated on `poi_bundle_dir` for the same reason.
fn poi_tile_response_cache_term(cfg: &ServerConfig) -> u64 {
    if cfg.poi_bundle_dir.is_none() {
        return 0;
    }
    cfg.poi_tile_cache_max_bytes
}

/// Project the peak RSS the process can occupy. The `2 ×` factor on
/// (payload + transfers) is the load-bearing reservation for the
/// transient mid-reload window when BOTH the old and new generations
/// are mmap-resident; steady-state RSS settles to ~1× payload once the
/// old generation retires. Operators sizing `--max-rss-bytes` must
/// accommodate this peak (~2×), NOT the steady-state value, or the
/// reload itself will OOMKill the process.
///
/// Inputs: `payload` = `bundle.ptb` size in bytes; `transfers` =
/// `transfers.bin` size (`0` when the manifest does not declare one).
///
/// Pure function: no syscalls, no global state, no allocation. Used by
/// the [`enforce`] startup guard and exhaustively unit-tested via the
/// 3-point factor bracketing in `tests/rss_guard.rs`.
pub fn estimate_rss(cfg: &ServerConfig, payload: u64, transfers: u64) -> u64 {
    PAYLOAD_RSS_FACTOR
        .saturating_mul(payload.saturating_add(transfers))
        .saturating_add(cfg.process_fixed_overhead_bytes)
        .saturating_add(total_http_worker_count(cfg).saturating_mul(cfg.per_worker_overhead_bytes))
        .saturating_add(cfg.schedule_tile_cache_max_bytes)
        .saturating_add(
            cfg.rt_tile_membership_cache_max_entries
                .saturating_mul(RT_TILE_MEMBERSHIP_ENTRY_BYTES_ASSUMED),
        )
        .saturating_add(
            cfg.rt_tile_response_cache_max_entries
                .saturating_mul(RT_TILE_RESPONSE_ENTRY_BYTES_ASSUMED),
        )
        .saturating_add(poi_city_entries_cache_term(cfg))
        .saturating_add(poi_tile_response_cache_term(cfg))
        .saturating_add(poi_brotli_scratch_term(cfg))
        .saturating_add(rt_poller_term(cfg))
}

/// Outcome of a [`enforce`] call. The accept arm is a unit type so
/// `main.rs` can `?`-propagate the rejection without losing the per-term
/// breakdown on the reject arm.
#[derive(Debug, PartialEq, Eq)]
pub enum RssDecision {
    Accept {
        estimate_bytes: u64,
    },
    Reject {
        estimate_bytes: u64,
        limit_bytes: u64,
        /// Boxed to keep `RssDecision` small: the accept arm carries one
        /// `u64`, and `RssBreakdown` grew past clippy's variant-size spread
        /// when the RT-poller terms landed. Every consumer reaches it through
        /// field access or `to_json()`, both of which deref transparently, so
        /// the box costs one allocation on a path that is about to `exit(1)`.
        breakdown: Box<RssBreakdown>,
    },
}

/// Per-term contributions to the [`estimate_rss`] sum. Surfaced on the
/// rejection log as JSON so operators can diff one boot against another
/// (e.g. "the bundle grew by 80 MB, but workers fit"). Field names are
/// camelCase to match the rest of the JSON surface (`/ready`, `/version`,
/// the manifest).
#[derive(Debug, PartialEq, Eq)]
pub struct RssBreakdown {
    pub payload_bytes: u64,
    pub transfers_bytes: u64,
    pub payload_factor: u64,
    pub payload_term_bytes: u64,
    pub process_fixed_overhead_bytes: u64,
    /// Main-listener worker count retained under its established field name.
    pub worker_pool_size: u64,
    pub auxiliary_worker_count: u64,
    pub loopback_worker_count: u64,
    pub total_worker_count: u64,
    pub per_worker_overhead_bytes: u64,
    pub workers_term_bytes: u64,
    pub schedule_tile_cache_max_bytes: u64,
    pub rt_tile_membership_cache_term_bytes: u64,
    pub rt_tile_response_cache_term_bytes: u64,
    pub poi_bundle_max_decoded_bytes: u64,
    pub poi_city_entries_cache_slots: u64,
    pub poi_city_entries_rss_factor: u64,
    pub poi_city_entries_cache_term_bytes: u64,
    pub poi_tile_cache_max_bytes: u64,
    pub poi_tile_cache_term_bytes: u64,
    pub poi_brotli_build_concurrency: u64,
    pub poi_brotli_scratch_bytes_per_build: u64,
    pub poi_brotli_scratch_term_bytes: u64,
    pub rt_poller_feed_count: u64,
    pub rt_poller_process_fixed_bytes: u64,
    pub rt_poller_assumed_max_entries_per_feed: u64,
    pub rt_poller_snapshot_entry_bytes: u64,
    pub rt_poller_term_bytes: u64,
}

impl RssBreakdown {
    /// Render the breakdown as a stable JSON object. Hand-written to avoid
    /// dragging serde derives over a struct only used in stderr logs.
    pub fn to_json(&self) -> String {
        format!(
            "{{\"payloadBytes\":{},\"transfersBytes\":{},\"payloadFactor\":{},\"payloadTermBytes\":{},\"processFixedOverheadBytes\":{},\"workerPoolSize\":{},\"auxiliaryWorkerCount\":{},\"loopbackWorkerCount\":{},\"totalWorkerCount\":{},\"perWorkerOverheadBytes\":{},\"workersTermBytes\":{},\"scheduleTileCacheMaxBytes\":{},\"rtTileMembershipCacheTermBytes\":{},\"rtTileResponseCacheTermBytes\":{},\"poiBundleMaxDecodedBytes\":{},\"poiCityEntriesCacheSlots\":{},\"poiCityEntriesRssFactor\":{},\"poiCityEntriesCacheTermBytes\":{},\"poiTileCacheMaxBytes\":{},\"poiTileCacheTermBytes\":{},\"poiBrotliBuildConcurrency\":{},\"poiBrotliScratchBytesPerBuild\":{},\"poiBrotliScratchTermBytes\":{},\"rtPollerFeedCount\":{},\"rtPollerProcessFixedBytes\":{},\"rtPollerAssumedMaxEntriesPerFeed\":{},\"rtPollerSnapshotEntryBytes\":{},\"rtPollerTermBytes\":{}}}",
            self.payload_bytes,
            self.transfers_bytes,
            self.payload_factor,
            self.payload_term_bytes,
            self.process_fixed_overhead_bytes,
            self.worker_pool_size,
            self.auxiliary_worker_count,
            self.loopback_worker_count,
            self.total_worker_count,
            self.per_worker_overhead_bytes,
            self.workers_term_bytes,
            self.schedule_tile_cache_max_bytes,
            self.rt_tile_membership_cache_term_bytes,
            self.rt_tile_response_cache_term_bytes,
            self.poi_bundle_max_decoded_bytes,
            self.poi_city_entries_cache_slots,
            self.poi_city_entries_rss_factor,
            self.poi_city_entries_cache_term_bytes,
            self.poi_tile_cache_max_bytes,
            self.poi_tile_cache_term_bytes,
            self.poi_brotli_build_concurrency,
            self.poi_brotli_scratch_bytes_per_build,
            self.poi_brotli_scratch_term_bytes,
            self.rt_poller_feed_count,
            self.rt_poller_process_fixed_bytes,
            self.rt_poller_assumed_max_entries_per_feed,
            self.rt_poller_snapshot_entry_bytes,
            self.rt_poller_term_bytes,
        )
    }
}

/// Project the RSS and compare against `cfg.max_rss_bytes`. Returns
/// [`RssDecision::Accept`] when `estimate <= limit`, otherwise
/// [`RssDecision::Reject`] with the full breakdown so the caller can log
/// it AND propagate the non-zero exit. The function does NOT log or exit
/// itself — that's `main.rs`'s job (and the process-level tests in
/// `tests/rss_guard.rs` would otherwise have nothing to capture on
/// stderr).
pub fn enforce(cfg: &ServerConfig, payload: u64, transfers: u64) -> RssDecision {
    let estimate = estimate_rss(cfg, payload, transfers);
    if estimate <= cfg.max_rss_bytes {
        return RssDecision::Accept {
            estimate_bytes: estimate,
        };
    }
    let payload_term = PAYLOAD_RSS_FACTOR.saturating_mul(payload.saturating_add(transfers));
    let total_worker_count = total_http_worker_count(cfg);
    let workers_term = total_worker_count.saturating_mul(cfg.per_worker_overhead_bytes);
    RssDecision::Reject {
        estimate_bytes: estimate,
        limit_bytes: cfg.max_rss_bytes,
        breakdown: Box::new(RssBreakdown {
            payload_bytes: payload,
            transfers_bytes: transfers,
            payload_factor: PAYLOAD_RSS_FACTOR,
            payload_term_bytes: payload_term,
            process_fixed_overhead_bytes: cfg.process_fixed_overhead_bytes,
            worker_pool_size: cfg.worker_pool_size as u64,
            auxiliary_worker_count: AUXILIARY_WORKER_COUNT,
            loopback_worker_count: cfg.loopback_worker_count as u64,
            total_worker_count,
            per_worker_overhead_bytes: cfg.per_worker_overhead_bytes,
            workers_term_bytes: workers_term,
            schedule_tile_cache_max_bytes: cfg.schedule_tile_cache_max_bytes,
            rt_tile_membership_cache_term_bytes: cfg
                .rt_tile_membership_cache_max_entries
                .saturating_mul(RT_TILE_MEMBERSHIP_ENTRY_BYTES_ASSUMED),
            rt_tile_response_cache_term_bytes: cfg
                .rt_tile_response_cache_max_entries
                .saturating_mul(RT_TILE_RESPONSE_ENTRY_BYTES_ASSUMED),
            poi_bundle_max_decoded_bytes: cfg.poi_bundle_max_decoded_bytes,
            poi_city_entries_cache_slots: POI_CITY_ENTRIES_CACHE_SLOTS,
            poi_city_entries_rss_factor: POI_CITY_ENTRIES_RSS_FACTOR_ASSUMED,
            poi_city_entries_cache_term_bytes: poi_city_entries_cache_term(cfg),
            poi_tile_cache_max_bytes: cfg.poi_tile_cache_max_bytes,
            poi_tile_cache_term_bytes: cfg.poi_tile_cache_max_bytes,
            poi_brotli_build_concurrency: poi_brotli_build_concurrency(cfg),
            poi_brotli_scratch_bytes_per_build: poi_brotli_scratch_bytes_per_build(cfg),
            poi_brotli_scratch_term_bytes: poi_brotli_scratch_term(cfg),
            rt_poller_feed_count: rt_poller_feed_count(cfg),
            rt_poller_process_fixed_bytes: RT_POLLER_PROCESS_FIXED_BYTES,
            rt_poller_assumed_max_entries_per_feed: RT_POLLER_ASSUMED_MAX_ENTRIES_PER_FEED,
            rt_poller_snapshot_entry_bytes: RT_POLLER_SNAPSHOT_ENTRY_BYTES_ASSUMED,
            rt_poller_term_bytes: rt_poller_term(cfg),
        }),
    }
}

#[cfg(test)]
mod tests {
    //! In-crate sanity tests — defence in depth alongside the
    //! `tests/rss_guard.rs` 3-point bracketing.
    use super::*;
    use crate::ops::{LogFormat, PageWarmMode, PatternModeArg};
    use std::path::PathBuf;

    fn cfg() -> ServerConfig {
        ServerConfig {
            worker_pool_size: 2,
            request_timeout_ms: 5_000,
            prestop_grace_secs: 1,
            max_rss_bytes: 1_073_741_824,
            process_fixed_overhead_bytes: 200_000_000,
            per_worker_overhead_bytes: 50_000_000,
            pidfile_path: PathBuf::from("/tmp/pt-serve.pid"),
            data_root: PathBuf::from("/tmp"),
            city_slug: "vilnius".into(),
            listen_addr: "127.0.0.1:0".into(),
            metrics_listen_addr: "127.0.0.1:0".into(),
            loopback_listen_addr: "127.0.0.1:0".into(),
            loopback_worker_count: 2,
            max_retained_generations: 10,
            without_geometry: false,
            page_warm_mode: PageWarmMode::WillNeed,
            log_format: LogFormat::Text,
            pattern_mode: PatternModeArg::Off,
            feed_stale_days: 80,
            force_current: None,
            city_tz_iana_default: Some("Europe/Vilnius".to_string()),
            health_probe: false,
            reload_poll_interval_secs: 0,
            rt_trip_updates_urls: String::new(),
            rt_poll_interval_ms: 12_000,
            schedule_tile_cache_max_bytes: 16 * 1024 * 1024,
            rt_tile_membership_cache_max_entries: 4096,
            rt_tile_response_cache_max_entries: 4096,
            rt_tile_response_cache_ttl_ms: 10_000,
            poi_bundle_dir: None,
            poi_lease_root: None,
            poi_bundle_max_decoded_bytes: 1024 * 1024,
            poi_tile_cache_max_entries: 256,
            poi_tile_cache_max_bytes: 2 * 1024 * 1024,
            validated_poi_manifest: None,
        }
    }

    #[test]
    fn zero_payload_is_just_overhead() {
        // `cfg()` leaves `poi_bundle_dir` unset, so EVERY POI term is zero here.
        // That is the point: a process that does not serve POI must not have its
        // admissible payload shrunk by POI reservations it will never allocate.
        let c = cfg();
        assert!(c.poi_bundle_dir.is_none(), "cfg() must model POI-disabled");
        // Same reasoning for the RT poller: no feeds configured, no poll
        // thread spawned, nothing reserved. If this precondition ever changes
        // the `want` sum below must grow an rt_poller_term.
        assert!(
            c.rt_urls().is_empty(),
            "cfg() must model RT-poller-disabled"
        );
        let want = c.process_fixed_overhead_bytes
            + ((c.worker_pool_size + c.loopback_worker_count) as u64 + AUXILIARY_WORKER_COUNT)
                * c.per_worker_overhead_bytes
            + c.schedule_tile_cache_max_bytes
            + c.rt_tile_membership_cache_max_entries * RT_TILE_MEMBERSHIP_ENTRY_BYTES_ASSUMED
            + c.rt_tile_response_cache_max_entries * RT_TILE_RESPONSE_ENTRY_BYTES_ASSUMED;
        assert_eq!(estimate_rss(&c, 0, 0), want);
    }

    #[test]
    fn poi_disabled_process_reserves_nothing_for_poi() {
        let c = cfg();
        assert!(c.poi_bundle_dir.is_none());
        assert_eq!(poi_city_entries_cache_term(&c), 0);
        assert_eq!(poi_tile_response_cache_term(&c), 0);
        assert_eq!(poi_brotli_scratch_term(&c), 0);
    }

    #[test]
    fn rt_poller_disabled_reserves_nothing() {
        // paris (no feed on either plane) and oslo (var wired but empty by
        // default) both boot in this state. Reserving for them would shrink
        // the admissible payload envelope for a poll thread that never spawns.
        let c = cfg();
        assert!(c.rt_urls().is_empty());
        assert_eq!(rt_poller_feed_count(&c), 0);
        assert_eq!(rt_poller_term(&c), 0);
    }

    #[test]
    fn configured_rt_poller_reserves_fixed_plus_per_feed_entries() {
        let mut c = cfg();
        let without = estimate_rss(&c, 0, 0);
        c.rt_trip_updates_urls = "https://www.stops.lt/vilnius/trip_updates.pb".to_string();
        let with = estimate_rss(&c, 0, 0);
        assert_eq!(rt_poller_feed_count(&c), 1);
        assert_eq!(
            with - without,
            RT_POLLER_PROCESS_FIXED_BYTES
                + RT_POLLER_ASSUMED_MAX_ENTRIES_PER_FEED * RT_POLLER_SNAPSHOT_ENTRY_BYTES_ASSUMED
        );
    }

    #[test]
    fn rt_poller_term_scales_with_feed_count() {
        // krakow's shape: three TripUpdates feeds merged into one snapshot.
        // The fixed part is charged ONCE — it is the thread and the TLS code
        // pages, which three feeds share — while the snapshot reservation
        // scales, because each feed contributes its own entries to `merged`.
        let mut c = cfg();
        c.rt_trip_updates_urls = "https://a.test/A.pb".to_string();
        let one = rt_poller_term(&c);
        c.rt_trip_updates_urls =
            "https://a.test/A.pb,https://a.test/M.pb,https://a.test/T.pb".to_string();
        let three = rt_poller_term(&c);
        assert_eq!(rt_poller_feed_count(&c), 3);
        assert_eq!(
            three - one,
            2 * RT_POLLER_ASSUMED_MAX_ENTRIES_PER_FEED * RT_POLLER_SNAPSHOT_ENTRY_BYTES_ASSUMED
        );
    }

    #[test]
    fn rt_poller_counts_feeds_the_way_the_poller_parses_them() {
        // `rt_urls()` trims and drops empties, so a trailing comma or padded
        // separator must not be reserved for as if it were another feed. The
        // guard has to agree with what `RtPoller::new` actually spawns.
        let mut c = cfg();
        c.rt_trip_updates_urls = "  https://a.test/A.pb , , https://a.test/M.pb ,, ".to_string();
        assert_eq!(rt_poller_feed_count(&c), 2);
        assert_eq!(
            rt_poller_term(&c),
            RT_POLLER_PROCESS_FIXED_BYTES
                + 2 * RT_POLLER_ASSUMED_MAX_ENTRIES_PER_FEED
                    * RT_POLLER_SNAPSHOT_ENTRY_BYTES_ASSUMED
        );
        // A string of nothing but separators configures no feed at all.
        c.rt_trip_updates_urls = " , ,, ".to_string();
        assert_eq!(rt_poller_term(&c), 0);
    }

    #[test]
    fn rt_poller_reservation_covers_the_measured_vilnius_delta() {
        // The vilnius pair (runs 31336589978 / 31336661915, deimos, 10 samples
        // each) differenced to +1,007,616 B steady RSS with one feed at 506
        // merged entries. A guard that reserves LESS than what a capture
        // measured is the failure mode this term exists to close, so pin the
        // direction rather than the value.
        const MEASURED_VILNIUS_POLLER_DELTA_BYTES: u64 = 1_007_616;
        let mut c = cfg();
        c.rt_trip_updates_urls = "https://www.stops.lt/vilnius/trip_updates.pb".to_string();
        assert!(
            rt_poller_term(&c) >= MEASURED_VILNIUS_POLLER_DELTA_BYTES,
            "reservation {} must not sit below the measured delta {}",
            rt_poller_term(&c),
            MEASURED_VILNIUS_POLLER_DELTA_BYTES
        );
    }

    #[test]
    fn schedule_tile_cache_budget_is_a_distinct_additive_term() {
        let mut c = cfg();
        c.schedule_tile_cache_max_bytes = 0;
        let without_cache = estimate_rss(&c, 0, 0);
        c.schedule_tile_cache_max_bytes = 16 * 1024 * 1024;
        let with_cache = estimate_rss(&c, 0, 0);
        assert_eq!(with_cache - without_cache, 16 * 1024 * 1024);
    }

    #[test]
    fn rt_tile_membership_cache_budget_is_a_distinct_additive_term() {
        let mut c = cfg();
        c.rt_tile_membership_cache_max_entries = 0;
        let without_cache = estimate_rss(&c, 0, 0);
        c.rt_tile_membership_cache_max_entries = 100;
        let with_cache = estimate_rss(&c, 0, 0);
        assert_eq!(
            with_cache - without_cache,
            100 * RT_TILE_MEMBERSHIP_ENTRY_BYTES_ASSUMED
        );
    }

    #[test]
    fn rt_tile_response_cache_budget_is_a_distinct_additive_term() {
        let mut c = cfg();
        c.rt_tile_response_cache_max_entries = 0;
        let without_cache = estimate_rss(&c, 0, 0);
        c.rt_tile_response_cache_max_entries = 100;
        let with_cache = estimate_rss(&c, 0, 0);
        assert_eq!(
            with_cache - without_cache,
            100 * RT_TILE_RESPONSE_ENTRY_BYTES_ASSUMED
        );
    }

    #[test]
    fn poi_tile_cache_budget_is_a_distinct_additive_term() {
        let mut c = cfg();
        // The term is gated on `poi_bundle_dir`, so POI must be enabled for the
        // budget to vary at all.
        c.poi_bundle_dir = Some(PathBuf::from("/tmp/poi"));
        c.poi_tile_cache_max_bytes = 0;
        let without_cache = estimate_rss(&c, 0, 0);
        c.poi_tile_cache_max_bytes = 123_456;
        let with_cache = estimate_rss(&c, 0, 0);
        assert_eq!(with_cache - without_cache, 123_456);
    }

    #[test]
    fn all_http_workers_are_accounted_exactly() {
        let mut c = cfg();
        c.process_fixed_overhead_bytes = 0;
        c.per_worker_overhead_bytes = 10;
        c.worker_pool_size = 2;
        c.loopback_worker_count = 3;
        c.schedule_tile_cache_max_bytes = 0;
        c.rt_tile_membership_cache_max_entries = 0;
        c.rt_tile_response_cache_max_entries = 0;
        c.poi_bundle_max_decoded_bytes = 0;
        c.poi_tile_cache_max_bytes = 0;

        assert_eq!(estimate_rss(&c, 0, 0), 60);
    }

    #[test]
    fn configured_poi_reserves_bounded_brotli_scratch() {
        let mut c = cfg();
        let disabled = estimate_rss(&c, 0, 0);
        c.poi_bundle_dir = Some(PathBuf::from("/tmp/poi"));
        let enabled = estimate_rss(&c, 0, 0);
        let per_build = POI_BROTLI_ENCODER_WORKING_SET_BYTES
            + c.poi_bundle_max_decoded_bytes * POI_BROTLI_TRANSIENT_BUFFER_FACTOR;
        // Enabling POI now turns on ALL THREE reservations together — brotli
        // scratch, the decoded-entries cache, and the response cache — because
        // each is gated on `poi_bundle_dir`. Before that gating the latter two
        // were charged even to POI-disabled processes.
        let want = per_build * POI_TILE_BUILD_CONCURRENCY as u64
            + c.poi_bundle_max_decoded_bytes
                * POI_CITY_ENTRIES_CACHE_SLOTS
                * POI_CITY_ENTRIES_RSS_FACTOR_ASSUMED
            + c.poi_tile_cache_max_bytes;
        assert_eq!(enabled - disabled, want);
    }

    #[test]
    fn poi_city_entries_budget_is_a_distinct_additive_term() {
        let mut c = cfg();
        // Gated on `poi_bundle_dir`; enable POI so the term is live. Note the
        // delta also picks up the brotli-scratch term, which scales with the same
        // `poi_bundle_max_decoded_bytes`, so subtract it to isolate this one.
        c.poi_bundle_dir = Some(PathBuf::from("/tmp/poi"));
        c.poi_bundle_max_decoded_bytes = 0;
        let without_cache = estimate_rss(&c, 0, 0);
        c.poi_bundle_max_decoded_bytes = 1024;
        let with_cache = estimate_rss(&c, 0, 0);
        let brotli_delta =
            1024 * POI_BROTLI_TRANSIENT_BUFFER_FACTOR * POI_TILE_BUILD_CONCURRENCY as u64;
        assert_eq!(
            with_cache - without_cache - brotli_delta,
            1024 * POI_CITY_ENTRIES_CACHE_SLOTS * POI_CITY_ENTRIES_RSS_FACTOR_ASSUMED
        );
    }

    #[test]
    fn payload_and_transfers_both_counted_under_factor() {
        let c = cfg();
        // Both should contribute identically under the factor.
        let only_payload = estimate_rss(&c, 1_000_000, 0);
        let only_transfers = estimate_rss(&c, 0, 1_000_000);
        assert_eq!(only_payload, only_transfers);
    }

    #[test]
    fn monotonic_in_payload() {
        let c = cfg();
        let a = estimate_rss(&c, 1_000_000, 0);
        let b = estimate_rss(&c, 2_000_000, 0);
        assert!(b > a);
    }

    #[test]
    fn enforce_accepts_under_limit() {
        let c = cfg();
        match enforce(&c, 1_000_000, 0) {
            RssDecision::Accept { estimate_bytes } => {
                assert!(estimate_bytes <= c.max_rss_bytes);
            }
            RssDecision::Reject { .. } => panic!("expected accept"),
        }
    }

    #[test]
    fn enforce_rejects_over_limit_with_full_breakdown() {
        let mut c = cfg();
        // POI must be configured for the POI terms to be non-zero — they are
        // gated on `poi_bundle_dir` — and a "full breakdown" test should
        // exercise every term rather than assert a row of zeroes.
        c.poi_bundle_dir = Some(PathBuf::from("/tmp/poi"));
        c.max_rss_bytes = 100; // absurdly low so the overhead term alone busts it
        let payload = 1_000_000_u64;
        let transfers = 500_000_u64;
        match enforce(&c, payload, transfers) {
            RssDecision::Reject {
                estimate_bytes,
                limit_bytes,
                breakdown,
            } => {
                assert_eq!(limit_bytes, 100);
                assert!(estimate_bytes > limit_bytes);
                assert_eq!(breakdown.payload_bytes, payload);
                assert_eq!(breakdown.transfers_bytes, transfers);
                assert_eq!(breakdown.payload_factor, PAYLOAD_RSS_FACTOR);
                assert_eq!(
                    breakdown.payload_term_bytes,
                    PAYLOAD_RSS_FACTOR * (payload + transfers)
                );
                assert_eq!(
                    breakdown.process_fixed_overhead_bytes,
                    c.process_fixed_overhead_bytes
                );
                assert_eq!(breakdown.worker_pool_size, c.worker_pool_size as u64);
                assert_eq!(breakdown.auxiliary_worker_count, AUXILIARY_WORKER_COUNT);
                assert_eq!(
                    breakdown.loopback_worker_count,
                    c.loopback_worker_count as u64
                );
                assert_eq!(
                    breakdown.total_worker_count,
                    (c.worker_pool_size + c.loopback_worker_count) as u64 + AUXILIARY_WORKER_COUNT
                );
                assert_eq!(
                    breakdown.per_worker_overhead_bytes,
                    c.per_worker_overhead_bytes
                );
                assert_eq!(
                    breakdown.workers_term_bytes,
                    ((c.worker_pool_size + c.loopback_worker_count) as u64
                        + AUXILIARY_WORKER_COUNT)
                        * c.per_worker_overhead_bytes
                );
                assert_eq!(
                    breakdown.schedule_tile_cache_max_bytes,
                    c.schedule_tile_cache_max_bytes
                );
                assert_eq!(
                    breakdown.rt_tile_membership_cache_term_bytes,
                    c.rt_tile_membership_cache_max_entries * RT_TILE_MEMBERSHIP_ENTRY_BYTES_ASSUMED
                );
                assert_eq!(
                    breakdown.rt_tile_response_cache_term_bytes,
                    c.rt_tile_response_cache_max_entries * RT_TILE_RESPONSE_ENTRY_BYTES_ASSUMED
                );
                assert_eq!(
                    breakdown.poi_bundle_max_decoded_bytes,
                    c.poi_bundle_max_decoded_bytes
                );
                assert_eq!(
                    breakdown.poi_city_entries_cache_slots,
                    POI_CITY_ENTRIES_CACHE_SLOTS
                );
                assert_eq!(
                    breakdown.poi_city_entries_rss_factor,
                    POI_CITY_ENTRIES_RSS_FACTOR_ASSUMED
                );
                assert_eq!(
                    breakdown.poi_city_entries_cache_term_bytes,
                    c.poi_bundle_max_decoded_bytes
                        * POI_CITY_ENTRIES_CACHE_SLOTS
                        * POI_CITY_ENTRIES_RSS_FACTOR_ASSUMED
                );
                assert_eq!(
                    breakdown.poi_tile_cache_term_bytes,
                    c.poi_tile_cache_max_bytes
                );
                assert_eq!(
                    breakdown.poi_tile_cache_max_bytes,
                    c.poi_tile_cache_max_bytes
                );
                // POI is configured in this test, so the brotli terms are live.
                assert_eq!(
                    breakdown.poi_brotli_build_concurrency,
                    POI_TILE_BUILD_CONCURRENCY as u64
                );
                assert_eq!(
                    breakdown.poi_brotli_scratch_term_bytes,
                    (POI_BROTLI_ENCODER_WORKING_SET_BYTES
                        + c.poi_bundle_max_decoded_bytes * POI_BROTLI_TRANSIENT_BUFFER_FACTOR)
                        * POI_TILE_BUILD_CONCURRENCY as u64
                );
                // JSON renders the camelCase field set.
                let j = breakdown.to_json();
                for needle in [
                    "payloadBytes",
                    "transfersBytes",
                    "payloadFactor",
                    "payloadTermBytes",
                    "processFixedOverheadBytes",
                    "workerPoolSize",
                    "auxiliaryWorkerCount",
                    "loopbackWorkerCount",
                    "totalWorkerCount",
                    "perWorkerOverheadBytes",
                    "workersTermBytes",
                    "scheduleTileCacheMaxBytes",
                    "rtTileMembershipCacheTermBytes",
                    "rtTileResponseCacheTermBytes",
                    "poiBundleMaxDecodedBytes",
                    "poiCityEntriesCacheSlots",
                    "poiCityEntriesRssFactor",
                    "poiCityEntriesCacheTermBytes",
                    "poiTileCacheMaxBytes",
                    "poiTileCacheTermBytes",
                    "poiBrotliBuildConcurrency",
                    "poiBrotliScratchBytesPerBuild",
                    "poiBrotliScratchTermBytes",
                ] {
                    assert!(j.contains(needle), "json missing {needle}: {j}");
                }
            }
            RssDecision::Accept { .. } => panic!("expected reject"),
        }
    }

    #[test]
    fn saturates_instead_of_overflow_on_pathological_input() {
        let mut c = cfg();
        c.process_fixed_overhead_bytes = u64::MAX - 1024;
        // Should NOT panic — saturating_add caps at u64::MAX.
        let est = estimate_rss(&c, u64::MAX / 4, u64::MAX / 4);
        assert_eq!(est, u64::MAX);
    }
}
