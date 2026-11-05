//! `ServerConfig` — the operator-facing configuration surface for pt-serve.
//!
//! Every flag has a paired `PT_SERVE_*` environment variable so container orchestrators can ship
//! config via env (the canonical k8s pattern) without losing the CLI ergonomics that humans want
//! during a DR drill.
//!
//! ## Two-stage parsing
//!
//! 1. `ServerConfig::parse()` — clap's compile-time-validated parse step.
//!    Type coercion, missing-required detection, env-var fallback. clap
//!    handles the help/version output and prints to stderr on error.
//! 2. `ServerConfig::validate()` — runtime filesystem checks that clap
//!    cannot express (does the `data_root` dir exist? Is it writable?).
//!    Surfaced through [`ConfigError`] so `main.rs` can format an operator-
//!    actionable message and exit non-zero.
//!
//! Tests instantiate `ServerConfig` directly (struct literal); see
//! `tests/common/mod.rs::default_test_config` for the canonical helper.

use clap::{Parser, ValueEnum};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use thiserror::Error;

/// Default bind/connect address for the auxiliary metrics listener.
///
/// Hoisted to a `pub const` (rather than an inline clap literal) so the
/// `--health-probe` pre-parse in `main.rs` can resolve the SAME default
/// WITHOUT routing through `ServerConfig::parse()` — which would demand the
/// required launch flags the healthcheck never supplies. See
/// [`crate::ops::health_probe::probe_target_if_requested`].
pub const DEFAULT_METRICS_LISTEN_ADDR: &str = "0.0.0.0:9001";

/// Per-city cap for both compressed and decompressed POI bundle bytes.
/// The committed strict bundle is well below this; operators shipping a
/// larger corpus must raise the cap, which also raises the RSS reservation.
pub const DEFAULT_POI_BUNDLE_MAX_DECODED_BYTES: u64 = 1024 * 1024;

/// Charged-byte ceiling for cached POI tile responses. This replaces the
/// previous RSS-only assumption of 256 responses averaging 8 KiB while
/// preserving the same 2 MiB default reservation.
pub const DEFAULT_POI_TILE_CACHE_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// CLI + env-driven operator config. Constructed via [`ServerConfig::parse`]
/// in `main.rs`; tests build it directly.
///
/// **Field naming.** The CLI flags use kebab-case; the env vars are
/// `PT_SERVE_*` SCREAMING_SNAKE. Each pair is co-located in the `#[arg(...)]`
/// attribute to make accidental drift obvious during review.
#[derive(Clone, Debug, Parser)]
#[command(name = "pt-serve", version)]
pub struct ServerConfig {
    /// Worker thread count for the main HTTP listener (excludes the
    /// metrics-listener thread). Must be ≥ 1; clap parses as `usize` so
    /// negative values fail at parse.
    #[arg(long, env = "PT_SERVE_WORKER_POOL_SIZE", default_value_t = 4)]
    pub worker_pool_size: usize,

    /// Per-request transport timeout in milliseconds. Enforced by the timeout wrapper at the
    /// dispatcher seam.
    #[arg(long, env = "PT_SERVE_REQUEST_TIMEOUT_MS", default_value_t = 30_000)]
    pub request_timeout_ms: u64,

    /// PreStop drain grace (seconds). the SIGTERM handler flips `/ready` to 503 then waits this
    /// long before closing the listener.
    #[arg(long, env = "PT_SERVE_PRESTOP_GRACE_SECS", default_value_t = 5)]
    pub prestop_grace_secs: u64,

    /// Hard RSS budget (bytes). the guard refuses adoption of a new generation whose projected RSS
    /// would exceed this number — bracketed by `process_fixed_overhead_bytes` +
    /// `per_worker_overhead_bytes`. Must be > 0; no default — the operator pins it from the
    /// calibrated value in the pt-serve budget file.
    #[arg(long, env = "PT_SERVE_MAX_RSS_BYTES")]
    pub max_rss_bytes: u64,

    /// Fixed process overhead (bytes) — heap allocator, clap, signal
    /// handlers, etc. Subtracted from `max_rss_bytes` before the
    /// generation-size + worker-overhead bracket is computed.
    #[arg(long, env = "PT_SERVE_PROCESS_FIXED_OVERHEAD_BYTES")]
    pub process_fixed_overhead_bytes: u64,

    /// Per-worker overhead (bytes). Multiplied by all HTTP workers: the main
    /// pool, one auxiliary worker, and the configured loopback pool.
    #[arg(long, env = "PT_SERVE_PER_WORKER_OVERHEAD_BYTES")]
    pub per_worker_overhead_bytes: u64,

    /// Producer-managed data root: holds `current.json`, `last-good.json`, and
    /// `generations/<id>/{generation.json,bundle.ptb,transfers.bin}`. REQUIRED.
    #[arg(long, env = "PT_SERVE_DATA_ROOT")]
    pub data_root: PathBuf,

    /// Where the PidfileGuard takes its kernel-released advisory lock.
    #[arg(long, env = "PT_SERVE_PIDFILE_PATH")]
    pub pidfile_path: PathBuf,

    /// Operator-supplied city slug. The router matches the `/api/<city>/` path prefix against this
    /// — a mismatch is 404. The PTB carries no slug, so this is asserted by config.
    #[arg(long, env = "PT_SERVE_CITY_SLUG")]
    pub city_slug: String,

    /// Main listener bind address (host:port).
    #[arg(long, env = "PT_SERVE_LISTEN_ADDR", default_value = "0.0.0.0:9000")]
    pub listen_addr: String,

    /// Auxiliary metrics-listener bind address (spawns this listener on its own thread). Separating
    /// ports lets ops scrape `/metrics` without exposing the plan port externally.
    #[arg(
        long,
        env = "PT_SERVE_METRICS_LISTEN_ADDR",
        default_value = DEFAULT_METRICS_LISTEN_ADDR
    )]
    pub metrics_listen_addr: String,

    /// Loopback-listener bind address (Stage-C C2c). Serves ONLY
    /// `GET /api/<city>/scheduled-departures-for-stop`. Bound on an open
    /// `0.0.0.0:9002` but isolated from external reach by the absence of a
    /// compose host-port mapping + an nginx CI gate — the route never
    /// resolves on the public listeners.
    #[arg(
        long,
        env = "PT_SERVE_LOOPBACK_LISTEN_ADDR",
        default_value = "0.0.0.0:9002"
    )]
    pub loopback_listen_addr: String,

    /// Worker thread count for the loopback HTTP listener. Defaults to 2;
    /// the loopback route is internal/low-volume, so a small pool suffices.
    #[arg(long, env = "PT_SERVE_LOOPBACK_WORKER_COUNT", default_value_t = 2)]
    pub loopback_worker_count: usize,

    /// Legacy compatibility setting. Generation-directory retention is
    /// enforced by `pt-producer`; `pt-serve` does not delete published
    /// generations. Keep this aligned with the producer until this unused
    /// serving-side surface is removed.
    #[arg(long, env = "PT_SERVE_MAX_RETAINED_GENERATIONS", default_value_t = 10)]
    pub max_retained_generations: usize,

    /// Whether generation adoption asks the kernel to page in mmap-backed
    /// bundle and sidecar data. `will-need` preserves the production default;
    /// `off` avoids speculative reads and page-cache pressure on constrained
    /// hosts at the cost of higher first-request latency.
    #[arg(
        long,
        env = "PT_SERVE_PAGE_WARM_MODE",
        value_enum,
        default_value_t = PageWarmMode::WillNeed
    )]
    pub page_warm_mode: PageWarmMode,

    /// Operator log format. `json` (default) is parseable by the k8s log
    /// pipeline; `text` is for local dev.
    #[arg(
        long,
        env = "PT_SERVE_LOG_FORMAT",
        value_enum,
        default_value_t = LogFormat::Json
    )]
    pub log_format: LogFormat,

    /// RAPTOR pattern-grouping mode for `Index::build`. `covering-merge`
    /// (default) makes branch/variant/lasso-reverse stops routable with a
    /// bounded pattern blowup; `off` is the byte-identical legacy engine;
    /// `unbounded` is the unbounded pattern split. Must match the frontend
    /// `VITE_PATTERN_MODE` + index-builder `PT_PATTERN_MODE` at deploy time
    /// (atomic flip — see the flip checklist). Set to `off` to roll back; see
    /// the pattern mode rollback notes.
    #[arg(long, value_enum, env = "PT_SERVE_PATTERN_MODE", default_value_t = PatternModeArg::CoveringMerge)]
    pub pattern_mode: PatternModeArg,

    /// Feed-staleness threshold (days). When the active generation's
    /// `feed_start_date` lies further in the past than this, `/ready`
    /// returns 503. Default 80d matches the Phase-B sidecar window
    /// (90-day bitmask, 10-day buffer).
    #[arg(long, env = "PT_SERVE_FEED_STALE_DAYS", default_value_t = 80)]
    pub feed_stale_days: u32,

    /// DR escape hatch: bypass `current.json` / `last-good.json` and adopt this specific generation
    /// id. Emits an error log on adoption; clears only on producer republish (ops doc).
    #[arg(long, env = "PT_SERVE_FORCE_CURRENT")]
    pub force_current: Option<String>,

    /// Fallback IANA tz when a v1 manifest lacks `cityTzIana`. Required when
    /// retained v1 generations exist on disk; can be omitted on greenfield
    /// deploys where the producer publishes v2 from the start.
    #[arg(long, env = "PT_CITY_TZ_IANA_DEFAULT")]
    pub city_tz_iana_default: Option<String>,

    /// One-shot probe mode: TCP-connect to the metrics listener, GET /ready,
    /// exit 0 iff HTTP 200. Used by the compose healthcheck (FROM scratch, no shell).
    ///
    /// Kept here for `--help` documentation and env binding, but it is NOT
    /// what triggers the probe at runtime: `ServerConfig::parse()` would abort
    /// on the missing required launch flags before this field could be read.
    /// `main.rs` detects probe mode from raw argv/env BEFORE parse via
    /// [`crate::ops::health_probe::probe_target_if_requested`].
    #[arg(long, env = "PT_SERVE_HEALTH_PROBE", default_value_t = false)]
    pub health_probe: bool,

    /// How often the reload-poll thread re-reads `current.json` and adopts a
    /// new generation (seconds). `0` disables polling (tests; SIGHUP-only).
    #[arg(long, env = "PT_SERVE_RELOAD_POLL_INTERVAL_SECS", default_value_t = 15)]
    pub reload_poll_interval_secs: u64,

    /// Comma-separated GTFS-RT TripUpdates feed URLs. Empty (the default)
    /// disables the RT poller entirely — a DELIBERATE divergence from the
    /// Node backend, whose unset-env fallback is the vilnius feed URL (a
    /// legacy of the vilnius-only era). pt-serve requires explicit per-city
    /// opt-in. Parsed via [`ServerConfig::rt_urls`] with Node's exact
    /// split/trim/filter semantics.
    #[arg(long, env = "PT_SERVE_RT_TRIP_UPDATES_URLS", default_value = "")]
    pub rt_trip_updates_urls: String,

    /// GTFS-RT poll cadence in milliseconds. The default is build.rs-pinned
    /// to `RT_BACKEND_POLL_INTERVAL_MS` in
    /// `packages/shared/src/constants/defaults.ts` (12 000 ms) so both
    /// serving planes tick together during the migration. Must be ≥ 1;
    /// enforced in `validate()` (stage 2) — a zero interval would hot-spin
    /// the poll thread.
    #[arg(long, env = "PT_SERVE_RT_POLL_INTERVAL_MS", default_value_t = 12_000)]
    pub rt_poll_interval_ms: u64,

    /// Byte budget for the schedule-tile response cache
    /// (`ops/tile_cache.rs`), default 16 MiB (matches Node's hardcoded
    /// `TileLruCache` budget). Unlike Node, this is configurable: the
    /// `--max-rss-bytes` startup guard (`ops/rss_guard.rs`) reserves this
    /// term unconditionally, so a constrained deployment (e.g. the potato
    /// profile) can lower or zero it rather than reserve RSS headroom it
    /// will never use.
    #[arg(
        long,
        env = "PT_SERVE_SCHEDULE_TILE_CACHE_MAX_BYTES",
        default_value_t = 16 * 1024 * 1024
    )]
    pub schedule_tile_cache_max_bytes: u64,

    /// Entry-count budget for the rt-tile trip-membership cache
    /// (`ops/rt_tile_membership_cache.rs`), default 4096 (matches Node's
    /// hardcoded `RT_TILE_LRU_SIZE`). Configurable for the same reason
    /// `schedule_tile_cache_max_bytes` is — reserved unconditionally in the
    /// `--max-rss-bytes` estimate (`ops/rss_guard.rs`), so a constrained
    /// deployment can size it down.
    #[arg(
        long,
        env = "PT_SERVE_RT_TILE_MEMBERSHIP_CACHE_MAX_ENTRIES",
        default_value_t = 4096
    )]
    pub rt_tile_membership_cache_max_entries: u64,

    /// Entry-count budget for the rt-tile response cache
    /// (`ops/rt_tile_response_cache.rs`), default 4096 (matches Node's
    /// hardcoded `RT_TILE_LRU_SIZE` on the SAME route — Node shares one
    /// constant across both its cache layers; kept as two independent flags
    /// here since they're separate types with separate RSS reservations).
    #[arg(
        long,
        env = "PT_SERVE_RT_TILE_RESPONSE_CACHE_MAX_ENTRIES",
        default_value_t = 4096
    )]
    pub rt_tile_response_cache_max_entries: u64,

    /// TTL (milliseconds) for the rt-tile response cache, default 10_000
    /// (matches Node's hardcoded `RT_TILE_TTL_MS`, `rtTile.ts:51` — a
    /// route-local const, not a shared cross-language export, so this is a
    /// hand-matched default with no build.rs pinning).
    #[arg(
        long,
        env = "PT_SERVE_RT_TILE_RESPONSE_CACHE_TTL_MS",
        default_value_t = 10_000
    )]
    pub rt_tile_response_cache_ttl_ms: u64,

    /// Directory holding the POI `manifest.json` and its bundles.
    /// Absent disables the route. When configured, startup validates every
    /// manifest-enabled strict corpus before readiness.
    #[arg(long, env = "PT_SERVE_POI_BUNDLE_DIR")]
    pub poi_bundle_dir: Option<PathBuf>,

    /// Writable lease directory shared with the artifact manager. When set,
    /// pt-serve leases each POI release it serves, so retention cannot prune a
    /// release while requests (or a snapshot retained after a rejected update)
    /// still read it. The served directory must then be a managed release,
    /// named by its sha256 identity.
    #[arg(long, env = "PT_SERVE_POI_LEASE_ROOT")]
    pub poi_lease_root: Option<PathBuf>,

    /// Maximum compressed or decompressed bytes accepted for one POI bundle.
    /// The same value feeds the decoded-entry RSS reservation, so increasing
    /// it cannot silently bypass `--max-rss-bytes`.
    #[arg(
        long,
        env = "PT_SERVE_POI_BUNDLE_MAX_DECODED_BYTES",
        default_value_t = DEFAULT_POI_BUNDLE_MAX_DECODED_BYTES
    )]
    pub poi_bundle_max_decoded_bytes: u64,

    /// Entry-count budget for the poi-tile response cache
    /// (`ops/poi_tile_cache.rs`), default 256 (matches Node's hardcoded
    /// `RESPONSE_CACHE_MAX_ENTRIES`, `routes/poiTile.ts:61`). Configurable
    /// for the same reason the rt-tile/schedule-tile cache sizes are —
    /// reserved unconditionally in the `--max-rss-bytes` estimate
    /// (`ops/rss_guard.rs`).
    #[arg(
        long,
        env = "PT_SERVE_POI_TILE_CACHE_MAX_ENTRIES",
        default_value_t = 256
    )]
    pub poi_tile_cache_max_entries: u64,

    /// Charged-byte budget for the poi-tile response cache. Charge includes
    /// compressed bodies plus owned key/ETag buffers and fixed entry structs.
    /// The RSS guard reserves this exact ceiling instead of assuming an
    /// average response size.
    #[arg(
        long,
        env = "PT_SERVE_POI_TILE_CACHE_MAX_BYTES",
        default_value_t = DEFAULT_POI_TILE_CACHE_MAX_BYTES
    )]
    pub poi_tile_cache_max_bytes: u64,

    /// Captured POI startup state. `None` means disabled; configured
    /// directories retain a cold, ready, or failed preflight so POI faults
    /// cannot prevent transit startup. Requests validate changed immutable
    /// targets before adoption and retain a working prior snapshot on failure.
    #[arg(skip)]
    pub validated_poi_manifest: Option<crate::poi::catalog::PoiPreflightState>,
}

/// Operator log format — JSON for prod, text for local dev.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum LogFormat {
    Json,
    Text,
}

/// mmap page-warming policy applied after a generation validates.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum PageWarmMode {
    Off,
    WillNeed,
}

impl PageWarmMode {
    pub const fn enabled(self) -> bool {
        matches!(self, Self::WillNeed)
    }
}

/// RAPTOR pattern-grouping mode (operator-facing). Wraps `pt_core::PatternMode`
/// because the orphan rule forbids `impl clap::ValueEnum` on the foreign
/// pt-core type. clap derives the kebab tokens `off` / `unbounded` /
/// `covering-merge`, matching the TS `PatternMode` enum + `pt-core-emit`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum PatternModeArg {
    Off,
    Unbounded,
    CoveringMerge,
}

impl From<PatternModeArg> for pt_core::PatternMode {
    fn from(a: PatternModeArg) -> Self {
        // No wildcard arm: a new pt_core::PatternMode variant must force a
        // compile error here so the surfaces cannot silently drift.
        match a {
            PatternModeArg::Off => pt_core::PatternMode::Off,
            PatternModeArg::Unbounded => pt_core::PatternMode::Unbounded,
            PatternModeArg::CoveringMerge => pt_core::PatternMode::CoveringMerge,
        }
    }
}

/// Canonical wire spelling for a pattern mode — the single source shared by
/// `/ready` and (via the lockstep test) the clap token. Equals the TS
/// `PatternMode` values and the `pt-core-emit --pattern-mode` tokens.
pub fn pattern_mode_token(m: pt_core::PatternMode) -> &'static str {
    match m {
        pt_core::PatternMode::Off => "off",
        pt_core::PatternMode::Unbounded => "unbounded",
        pt_core::PatternMode::CoveringMerge => "covering-merge",
    }
}

/// Validation errors produced by [`ServerConfig::validate`]. One variant per
/// field that can be operator-misconfigured — the field name in each variant
/// is the operator-facing tag they'll see in the error log.
#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("worker_pool_size must be >= 1 (got 0)")]
    WorkerPoolSizeZero,
    #[error("loopback_worker_count must be >= 1 (got 0)")]
    LoopbackWorkerCountZero,
    #[error("request_timeout_ms must be > 0 (got 0)")]
    RequestTimeoutMsZero,
    #[error("max_rss_bytes must be > 0 (got 0)")]
    MaxRssBytesZero,
    #[error(
        "rt-poll-interval-ms / PT_SERVE_RT_POLL_INTERVAL_MS must be >= 1 (a zero interval would hot-spin the poll thread)"
    )]
    RtPollIntervalMsZero,
    #[error("city_slug must be non-empty")]
    CitySlugEmpty,
    #[error("data_root {0:?} does not exist or is not a directory")]
    DataRootMissing(PathBuf),
    #[error("data_root {0:?} exists but is not writable: {1}")]
    DataRootNotWritable(PathBuf, std::io::Error),
    #[error("poi_bundle_dir {0:?} does not exist or is not a directory")]
    PoiBundleDirMissing(PathBuf),
    #[error("POI serving preflight failed: {0}")]
    PoiConfig(String),
    #[error("pidfile_path {0:?} has no parent directory")]
    PidfileParentMissing(PathBuf),
    #[error("pidfile_path parent {0:?} exists but is not writable: {1}")]
    PidfileParentNotWritable(PathBuf, std::io::Error),
}

impl ServerConfig {
    /// Run the post-parse runtime checks that clap cannot express: integer
    /// bounds, filesystem existence + writability. Returns `Ok(())` when
    /// the config is operator-shippable.
    ///
    /// Filesystem writability is tested by an atomic touch-and-delete of a
    /// uniquely-named sentinel file. We do this rather than just stat-ing
    /// the dir because POSIX permissions don't always reflect mount-time
    /// readonly state (e.g. container ro-mounts). The touch will surface
    /// `EROFS` where stat says "writable bits set" but the kernel will
    /// refuse the write.
    pub fn validate(&mut self) -> Result<(), ConfigError> {
        if self.worker_pool_size == 0 {
            return Err(ConfigError::WorkerPoolSizeZero);
        }
        if self.loopback_worker_count == 0 {
            return Err(ConfigError::LoopbackWorkerCountZero);
        }
        if self.request_timeout_ms == 0 {
            return Err(ConfigError::RequestTimeoutMsZero);
        }
        if self.max_rss_bytes == 0 {
            return Err(ConfigError::MaxRssBytesZero);
        }
        if self.rt_poll_interval_ms == 0 {
            return Err(ConfigError::RtPollIntervalMsZero);
        }
        if self.city_slug.is_empty() {
            return Err(ConfigError::CitySlugEmpty);
        }

        // data_root: must exist + be a directory + writable.
        match std::fs::metadata(&self.data_root) {
            Ok(meta) if meta.is_dir() => match probe_writable(&self.data_root) {
                Ok(()) => {}
                Err(e) => return Err(ConfigError::DataRootNotWritable(self.data_root.clone(), e)),
            },
            _ => return Err(ConfigError::DataRootMissing(self.data_root.clone())),
        }

        if let Some(configured_dir) = self.poi_bundle_dir.clone() {
            use crate::poi::catalog::PoiPreflightState;

            self.validated_poi_manifest =
                match crate::poi::catalog::validate_poi_configuration(self) {
                    Ok(Some(ready)) => {
                        // Keep discovery at the configured pointer. Each validated
                        // request snapshot separately pins its immutable directory,
                        // allowing later managed releases to be adopted.
                        self.poi_bundle_dir = Some(configured_dir);
                        Some(PoiPreflightState::Ready(ready))
                    }
                    Ok(None) => {
                        self.poi_bundle_dir = Some(configured_dir);
                        Some(PoiPreflightState::Cold)
                    }
                    Err(error) => {
                        self.poi_bundle_dir = Some(configured_dir);
                        Some(PoiPreflightState::Failed(Arc::from(error.to_string())))
                    }
                };
        } else {
            self.validated_poi_manifest = None;
        }

        // pidfile_path: parent must exist + be writable. The pidfile itself may legitimately not
        // exist yet ('s PidfileGuard creates it on first acquire).
        let parent = match self.pidfile_path.parent() {
            Some(p) if !p.as_os_str().is_empty() => p,
            // No parent OR an empty parent string ("foo.pid" — same dir as
            // cwd, which we refuse to assume). Treat both as missing.
            _ => return Err(ConfigError::PidfileParentMissing(self.pidfile_path.clone())),
        };
        match std::fs::metadata(parent) {
            Ok(meta) if meta.is_dir() => match probe_writable(parent) {
                Ok(()) => {}
                Err(e) => {
                    return Err(ConfigError::PidfileParentNotWritable(
                        parent.to_path_buf(),
                        e,
                    ))
                }
            },
            _ => return Err(ConfigError::PidfileParentMissing(self.pidfile_path.clone())),
        }

        Ok(())
    }

    /// Feed URLs parsed the way Node parses `GTFS_RT_TRIP_UPDATES_URL`
    /// (`packages/backend/src/index.ts`): split on commas, trim, drop
    /// empties. Never yields empty strings, so `RtPoller::new`'s
    /// `EmptyStringInUrls` arm is unreachable from config-driven callers.
    pub fn rt_urls(&self) -> Vec<String> {
        self.rt_trip_updates_urls
            .split(',')
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .map(str::to_string)
            .collect()
    }
}

/// Touch-and-delete a sentinel file inside `dir`. Surfaces filesystem-level
/// writability (mount ro, no-perm directory, full disk → ENOSPC) that a
/// permissions-bit check would miss. Sentinel names include the process id and
/// a per-call nonce so concurrent validations do not collide.
fn probe_writable(dir: &Path) -> std::io::Result<()> {
    static PROBE_NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nonce = PROBE_NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = format!(".pt-serve-write-probe-{}-{nonce}", std::process::id());
    let sentinel = dir.join(name);
    // Create-exclusive so a stale sentinel from a crashed previous run
    // doesn't false-positive. Then drop the file and delete it.
    let f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&sentinel)?;
    drop(f);
    // Best-effort delete; an error here is unusual (we just created it),
    // but if it happens we still want to report success — the probe DID
    // demonstrate writability.
    let _ = std::fs::remove_file(&sentinel);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Helper: a minimal valid argv (required flags have no defaults).
    fn base_args() -> Vec<String> {
        [
            "pt-serve",
            "--data-root",
            "/tmp",
            "--pidfile-path",
            "/tmp/pt-serve.pid",
            "--city-slug",
            "vilnius",
            "--max-rss-bytes",
            "1073741824",
            "--process-fixed-overhead-bytes",
            "200000000",
            "--per-worker-overhead-bytes",
            "50000000",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    #[test]
    fn pattern_mode_defaults_covering_merge_and_parses_variants() {
        use clap::Parser;
        let c = ServerConfig::try_parse_from(base_args()).unwrap();
        assert_eq!(c.pattern_mode, PatternModeArg::CoveringMerge);

        let mut a = base_args();
        a.push("--pattern-mode".into());
        a.push("off".into());
        assert_eq!(
            ServerConfig::try_parse_from(a).unwrap().pattern_mode,
            PatternModeArg::Off
        );

        let mut bad = base_args();
        bad.push("--pattern-mode".into());
        bad.push("nope".into());
        assert!(ServerConfig::try_parse_from(bad).is_err());
    }

    #[test]
    fn validate_accepts_covering_merge() {
        use clap::Parser;
        let mut a = base_args();
        a.push("--pattern-mode".into());
        a.push("covering-merge".into());
        let mut cfg = ServerConfig::try_parse_from(a).unwrap();
        // covering-merge is now production-supported (RSS-baselined); validate()
        // must accept it the same as off/unbounded over valid paths.
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn writable_probe_is_safe_under_concurrent_validation() {
        let config = ServerConfig::try_parse_from(base_args()).unwrap();
        let start = std::sync::Arc::new(std::sync::Barrier::new(9));
        let mut workers = Vec::new();
        for _ in 0..8 {
            let mut config = config.clone();
            let start = std::sync::Arc::clone(&start);
            workers.push(std::thread::spawn(move || {
                start.wait();
                config.validate()
            }));
        }
        start.wait();
        for worker in workers {
            worker.join().unwrap().unwrap();
        }
    }

    #[test]
    fn reload_poll_interval_defaults_to_15() {
        use clap::Parser;
        let c = ServerConfig::try_parse_from(base_args()).unwrap();
        assert_eq!(c.reload_poll_interval_secs, 15);
    }

    #[test]
    fn reload_poll_interval_overridable() {
        use clap::Parser;
        let mut a = base_args();
        a.push("--reload-poll-interval-secs".into());
        a.push("0".into());
        let c = ServerConfig::try_parse_from(a).unwrap();
        assert_eq!(c.reload_poll_interval_secs, 0);
    }

    #[test]
    fn poi_defaults_are_disabled_and_bounded() {
        use clap::Parser;
        let c = ServerConfig::try_parse_from(base_args()).unwrap();
        assert_eq!(c.poi_bundle_dir, None);
        assert_eq!(
            c.poi_bundle_max_decoded_bytes,
            DEFAULT_POI_BUNDLE_MAX_DECODED_BYTES
        );
        assert_eq!(c.poi_tile_cache_max_bytes, DEFAULT_POI_TILE_CACHE_MAX_BYTES);
    }

    #[test]
    fn poi_bundle_limits_are_overridable() {
        use clap::Parser;
        let mut a = base_args();
        a.extend(
            [
                "--poi-bundle-max-decoded-bytes",
                "2097152",
                "--poi-tile-cache-max-entries",
                "128",
                "--poi-tile-cache-max-bytes",
                "3145728",
            ]
            .into_iter()
            .map(str::to_string),
        );
        let c = ServerConfig::try_parse_from(a).unwrap();
        assert_eq!(c.poi_bundle_max_decoded_bytes, 2 * 1024 * 1024);
        assert_eq!(c.poi_tile_cache_max_entries, 128);
        assert_eq!(c.poi_tile_cache_max_bytes, 3 * 1024 * 1024);
    }

    #[test]
    fn rt_urls_default_empty_means_disabled() {
        use clap::Parser;
        let c = ServerConfig::try_parse_from(base_args()).unwrap();
        assert_eq!(c.rt_trip_updates_urls, "");
        assert!(c.rt_urls().is_empty());
    }

    #[test]
    fn rt_urls_splits_trims_and_filters() {
        use clap::Parser;
        let mut c = ServerConfig::try_parse_from(base_args()).unwrap();
        // Parity: Node's `GTFS_RT_TRIP_UPDATES_URL` parsing is
        // `.split(",").map(trim).filter(len > 0)` (packages/backend/src/index.ts).
        c.rt_trip_updates_urls = "  http://a.test/a.pb , http://b.test/b.pb ,, ".to_string();
        assert_eq!(
            c.rt_urls(),
            vec![
                "http://a.test/a.pb".to_string(),
                "http://b.test/b.pb".to_string()
            ]
        );
    }

    #[test]
    fn rt_poll_interval_default_matches_node_constant() {
        use clap::Parser;
        // The build script pins RT_BACKEND_POLL_INTERVAL_MS out of
        // packages/shared/src/constants/defaults.ts; drift fails here.
        let node: u64 = env!("NODE_RT_BACKEND_POLL_INTERVAL_MS").parse().unwrap();
        let c = ServerConfig::try_parse_from(base_args()).unwrap();
        assert_eq!(c.rt_poll_interval_ms, node);
        // Deliberate tripwire, not redundancy: build.rs auto-syncs `node`, so a
        // Node-side cadence change would otherwise silently change this binary's
        // default. The literal forces that change to be acknowledged here.
        assert_eq!(node, 12_000);
    }

    #[test]
    fn rt_poll_interval_rejects_zero() {
        use clap::Parser;
        // Integer bounds are a stage-2 concern (module doc): clap only
        // coerces the type, so 0 parses fine here. `validate()` is what
        // must reject it, to head off a hot-spinning poll thread. Mirrors
        // the ConfigError-rejection harness in tests/config.rs (e.g.
        // `worker_pool_size_zero_rejected`): mutate one field off a
        // passing baseline, then match the specific error variant.
        let mut a = base_args();
        a.push("--rt-poll-interval-ms".into());
        a.push("0".into());
        let mut cfg =
            ServerConfig::try_parse_from(a).expect("clap accepts 0; validate() is the gate");
        match cfg.validate() {
            Err(ConfigError::RtPollIntervalMsZero) => {}
            other => panic!("expected RtPollIntervalMsZero, got {other:?}"),
        }
    }

    #[test]
    fn page_warm_mode_defaults_on_and_can_be_disabled() {
        use clap::Parser;
        let c = ServerConfig::try_parse_from(base_args()).unwrap();
        assert_eq!(c.page_warm_mode, PageWarmMode::WillNeed);
        assert!(c.page_warm_mode.enabled());

        let mut a = base_args();
        a.push("--page-warm-mode".into());
        a.push("off".into());
        let c = ServerConfig::try_parse_from(a).unwrap();
        assert_eq!(c.page_warm_mode, PageWarmMode::Off);
        assert!(!c.page_warm_mode.enabled());
    }

    #[test]
    fn pattern_mode_token_matches_clap_value_name_and_canonical_spelling() {
        use clap::ValueEnum;
        for arg in [
            PatternModeArg::Off,
            PatternModeArg::Unbounded,
            PatternModeArg::CoveringMerge,
        ] {
            let clap_name = arg.to_possible_value().unwrap().get_name().to_string();
            assert_eq!(
                clap_name,
                pattern_mode_token(arg.into()),
                "clap token must equal the /ready spelling for {arg:?}"
            );
        }
        // Pin the exact spellings — parity with the TS PatternMode enum
        // (packages/shared/src/raptor/patternMode.ts) and pt-core-emit.
        assert_eq!(pattern_mode_token(pt_core::PatternMode::Off), "off");
        assert_eq!(
            pattern_mode_token(pt_core::PatternMode::Unbounded),
            "unbounded"
        );
        assert_eq!(
            pattern_mode_token(pt_core::PatternMode::CoveringMerge),
            "covering-merge"
        );
    }
}
