//! Process-scoped operability: metrics counters, server context, config.
//!
//! No `tiny_http` import lives in this module tree — anything that crosses the
//! HTTP boundary lives in `crate::http`. Splitting keeps the metrics counters
//! and `ServerCtx` free of transport types so a future framework swap is
//! contained.

pub mod config;
pub mod health_probe;
pub mod log;
pub mod metrics;
pub mod pidfile;
pub mod poi_tile_cache;
pub mod readiness;
pub mod rss_guard;
pub mod rt_tile_membership_cache;
pub mod rt_tile_response_cache;
pub mod sentinel;
pub mod server_ctx;
pub mod shutdown;
pub mod tile_cache;
pub mod timeout;
pub mod tzdb_horizon;
pub mod version_sentinel;

pub use config::{ConfigError, LogFormat, PageWarmMode, PatternModeArg, ServerConfig};
pub use log::{log_event, Level as LogLevel};
pub use metrics::{Metrics, ReloadCause, ReloadResult};
pub use pidfile::{acquire as acquire_pidfile, PidfileError, PidfileGuard};
pub use poi_tile_cache::{
    CachedPoiTileResponse, PoiCityTiling, PoiCityTilingCache, PoiTileResponseCache,
};
pub use readiness::FEED_STALE_DAYS;
pub use rss_guard::{enforce as enforce_rss_budget, estimate_rss, RssBreakdown, RssDecision};
pub use rt_tile_membership_cache::TripMembershipCache;
pub use rt_tile_response_cache::RtTileResponseCache;
pub use sentinel::{verify_producer_sentinel, SentinelError};
pub use server_ctx::ServerCtx;
pub use shutdown::{spawn_shutdown_observer, DrainController, DrainOutcome};
pub use tile_cache::{CachedTile, TileCache};
pub use timeout::{TimeoutRegistry, TimeoutTicket, TimeoutWatchdog};
