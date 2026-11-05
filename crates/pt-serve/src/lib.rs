//! `pt-serve` library surface.
//!
//! Module layout:
//! - `app` — transport-agnostic request handlers; MUST NOT import
//! tiny_http.
//! - `http` — tiny_http seam: dispatcher + adapter. The only home for tiny_http. -
//! `bundle` — `Generation`: per-bundle immutable state, swap target.
//! - `domain` — pure projection
//! helpers (mode, time) for the scheduled-departures handler.
//! - `ops` — process-scoped:
//! `ServerCtx`, `ServerConfig`, metrics counters.
//! - `reload` — typed-signal reload runner +
//! pending-reload latch.
//! - `router` — pure path/method → `Route` resolver (no transport types). -
//! `mmap` — `MmapBytes` newtype + read-only file mapping.
//! - `wire` — JSON request/response shapes
//! for `/plan`.
//!
//! `tiny_http` is imported only from `src/http/` and `src/main.rs`.
//! 2. `app/`, `bundle/`, `ops/`,
//! `router`, `mmap`, `wire` are tiny_http-free.

pub mod app;
pub mod bundle;
pub mod domain;
pub mod http;
pub mod mmap;
pub mod ops;
pub mod poi;
pub mod reload;
pub mod router;
pub mod rt;
pub mod wire;

// Re-export the dispatcher so the bin and integration tests can call
// `pt_serve::dispatch(&ctx, &mut scan_state, req)` without a deep path.
pub use bundle::Generation;
pub use http::{dispatch, LoopbackPool, LoopbackPoolError, WorkerPool, WorkerPoolError};
pub use ops::{
    acquire_pidfile, enforce_rss_budget, estimate_rss, log_event, spawn_shutdown_observer,
    verify_producer_sentinel, ConfigError, DrainController, DrainOutcome, LogFormat, LogLevel,
    Metrics, PatternModeArg, PidfileError, PidfileGuard, RssBreakdown, RssDecision, SentinelError,
    ServerConfig, ServerCtx, TimeoutRegistry, TimeoutTicket, TimeoutWatchdog,
};
pub use reload::{ReloadOutcome, ReloadRunner};
