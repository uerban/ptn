//! `ServerCtx` — process-scoped state that survives a hot-reload.
//!
//! Everything that depends on a SPECIFIC bundle (`Reader`, `Index`, `Transfers`,
//! the ETag/gzip caches, the city-slug echo) lives on
//! [`crate::bundle::Generation`] and is swapped wholesale via [`arc_swap`].
//! Everything that lives ACROSS generations (counters, the swap handle itself,
//! the start-time anchor, the parsed config) lives here.
//!
//! P3 baseline wires a single generation through the swap handle and never reloads — the shape is
//! what matters here.
//!
//! The ctx also carries `rt`, the arc-swap GTFS-RT snapshot seam (see
//! `crate::rt::state`), published by the `pt-serve-rt-poll` thread;
//! `tile_cache`, the schedule-tile response LRU (`crate::ops::tile_cache`);
//! and the rt-tile overlay route's two caches, `rt_tile_membership_cache`
//! and `rt_tile_response_cache`.

use crate::bundle::Generation;
use crate::ops::config::ServerConfig;
use crate::ops::metrics::Metrics;
use arc_swap::ArcSwap;
use std::sync::Arc;
use std::time::Instant;

/// Process-scoped state. Cheap to clone (a couple of `Arc`s); each worker
/// thread holds a single `ServerCtx` reference for the life of the process.
pub struct ServerCtx {
    /// Per-instance metrics counters. `Arc<Metrics>` so the reload runner can be handed its own
    /// clone of the same surface for injection, and so tests can mint a fresh
    /// `Arc::new(Metrics::default())` per `ServerCtx` (avoiding cross-test pollution under parallel
    /// execution).
    pub metrics: Arc<Metrics>,
    /// Process start time, used by `/metrics` uptime exposition.
    pub start_time: Instant,
    /// Active-generation swap handle. Workers load via
    /// [`ArcSwap::load_full`] per request — the swap is lock-free, and the
    /// returned `Arc<Generation>` lives only on the request's stack frame.
    pub gen_handle: Arc<ArcSwap<Generation>>,
    /// Parsed config. `Arc`-wrapped so a future config-reload (out of scope
    /// for P4) can swap it without touching `ServerCtx`'s shape.
    pub config: Arc<ServerConfig>,
    /// GTFS-RT shared state. Always present; `RtState::enabled()` is false
    /// when no `PT_SERVE_RT_TRIP_UPDATES_URLS` are configured, so handlers
    /// need no `Option` dance and tests need no constructor change. The
    /// `pt-serve-rt-poll` thread (main.rs) is the only publisher.
    pub rt: Arc<crate::rt::RtState>,
    /// GTFS-RT ServiceAlerts state, disabled when no
    /// `PT_SERVE_RT_SERVICE_ALERTS_URLS` are configured. The
    /// `pt-serve-alerts-poll` thread (main.rs) is the only publisher.
    pub alerts: Arc<crate::rt::AlertsState>,
    /// `X-PT-Realtime` value sent on `/gtfs/manifest` replies, computed once
    /// from the feed configuration ([`ServerConfig::realtime_header_value`]).
    pub realtime_header: Arc<str>,
    /// Schedule-tile response cache (`ops/tile_cache.rs`). Process-scoped
    /// like `rt` — survives a generation swap; its epoch-gated design
    /// purges wholesale (forward-only, race-safe) on the next request that
    /// observes a newer `Generation::epoch`, so it never needs to be
    /// rebuilt here.
    pub tile_cache: Arc<crate::ops::TileCache>,
    /// rt-tile overlay route: decoded trip-membership cache, epoch-gated
    /// like `tile_cache` (`ops/rt_tile_membership_cache.rs`).
    pub rt_tile_membership_cache: Arc<crate::ops::TripMembershipCache>,
    /// rt-tile overlay route: full-response TTL+LRU cache, NOT epoch-gated
    /// — self-scoping via its bundle-hash-embedding key
    /// (`ops/rt_tile_response_cache.rs`).
    pub rt_tile_response_cache: Arc<crate::ops::RtTileResponseCache>,
    /// POI manifest cache seeded from startup preflight. A failed
    /// preflight seeds a sticky error; a missing manifest remains cold.
    pub poi_manifest_cache: Arc<crate::poi::catalog::PoiManifestCache>,
    /// poi-tile route: resolved tiling status and decoded entries per city,
    /// pinned to the POI release they were read from (`ops/poi_tile_cache.rs`).
    /// Not epoch-gated — POI bundles are independent of GTFS reload.
    pub poi_city_tiling_cache: Arc<crate::ops::PoiCityTilingCache>,
    /// poi-tile route: full-response entry-count LRU, no TTL
    /// (`ops/poi_tile_cache.rs`).
    pub poi_tile_response_cache: Arc<crate::ops::PoiTileResponseCache>,
}

impl ServerCtx {
    /// Construct a `ServerCtx` parked around a single, eager-loaded generation — the P3 baseline.
    ///
    /// `metrics` is taken by ownership so that the same `Arc<Metrics>` can be shared with
    /// downstream subsystems ('s reload runner, 's timeout enforcement). Callers who don't need to
    /// share construct with `Metrics::new()` at the call site.
    pub fn new(initial: Generation, mut config: ServerConfig, metrics: Arc<Metrics>) -> Arc<Self> {
        let rt = crate::rt::RtState::from_config(&config);
        let alerts = crate::rt::AlertsState::from_urls(config.alerts_urls());
        let realtime_header: Arc<str> = config.realtime_header_value().into();
        let tile_cache = Arc::new(crate::ops::TileCache::new(
            config.schedule_tile_cache_max_bytes,
        ));
        let rt_tile_membership_cache = Arc::new(crate::ops::TripMembershipCache::new(
            config.rt_tile_membership_cache_max_entries,
        ));
        let rt_tile_response_cache = Arc::new(crate::ops::RtTileResponseCache::new(
            config.rt_tile_response_cache_max_entries,
            config.rt_tile_response_cache_ttl_ms,
        ));
        // Move the startup snapshot into the cache: a copy left in the shared
        // config would hold its release lease for the life of the process.
        let poi_manifest_cache = Arc::new(crate::poi::catalog::PoiManifestCache::new(
            config.validated_poi_manifest.take().as_ref(),
        ));
        let poi_city_tiling_cache = Arc::new(crate::ops::PoiCityTilingCache::default());
        let poi_tile_response_cache = Arc::new(crate::ops::PoiTileResponseCache::new(
            config.poi_tile_cache_max_entries,
            config.poi_tile_cache_max_bytes,
        ));
        Arc::new(Self {
            metrics,
            start_time: Instant::now(),
            gen_handle: Arc::new(ArcSwap::new(Arc::new(initial))),
            config: Arc::new(config),
            rt,
            alerts,
            realtime_header,
            tile_cache,
            rt_tile_membership_cache,
            rt_tile_response_cache,
            poi_manifest_cache,
            poi_city_tiling_cache,
            poi_tile_response_cache,
        })
    }

    /// Snapshot the active generation. Returns an `Arc<Generation>` whose
    /// lifetime is detached from the swap — safe to hold for the duration of
    /// a single request handler, NOT to stash on a worker across requests
    /// (would pin the old generation against a swap).
    ///
    /// This is THE http↔app seam: the single sanctioned `load_full` call site for the dispatcher.
    /// Other call sites are blocked both by `clippy::disallowed_methods` (see workspace
    /// `clippy.toml`) and by the boundary test in `tests/boundaries.rs`.
    #[allow(clippy::disallowed_methods)]
    pub fn current_generation(&self) -> Arc<Generation> {
        self.gen_handle.load_full()
    }
}
