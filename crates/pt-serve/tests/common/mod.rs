//! Per-test isolation helpers.
//!
//! `isolated_config()` returns a triple `(TempDir, ServerConfig, Arc<MockClock>)`:
//!
//! - The `TempDir` is the test's `data_root`. Each test gets a fresh dir so filesystem state from
//! one test never bleeds into another under parallel execution. Drop deletes the dir.
//! - The
//! `ServerConfig` carries the full P4 surface. Tests pin a minimal but realistic set of values via
//! [`default_test_config`]; the non-trivial knobs (`max_rss_bytes`, the overhead bytes) get
//! sentinels large enough never to trip the guard.
//! - The `Arc<MockClock>` lets tests drive
//! staleness / reload runner / cleanup logic deterministically (the cleanup pass's "older than 1h"
//! check keys off the clock).
//!
//! NOTE on `#[allow(dead_code)]`: this module is included via
//! `#[path = "common/mod.rs"] mod common;` in each integration test file, so
//! each integration binary only links the helpers it actually uses. Cargo's
//! per-binary dead-code lint then flags the rest. The blanket allow keeps the
//! helper module re-usable as more tests pull it in over Tasks 2.5/3/4*.

#![allow(dead_code)]

pub mod publisher;

use pt_serve::{Generation, LogFormat, Metrics, PatternModeArg, ReloadRunner, ServerConfig};
use pt_shared::clock::{Clock, MockClock};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tempfile::TempDir;

/// Mock-clock anchor shared by the reload harness and its tests. NOT the unix
/// epoch — epoch fails the `createdAt`-skew validator. `tiny.ptb`'s
/// `feed_start_date` is 20260501 so we pick 2026-05-23 12:00:00Z, the same
/// shape as the rest of the test corpus.
pub const RELOAD_HARNESS_ANCHOR: u64 = 1779494400;

/// Path to the committed `tiny.ptb` fixture (the harness's initial generation).
pub fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

/// Path to the committed `canary.ptb` fixture — a DIFFERENT source PTB from
/// `tiny.ptb`, so a generation published from it has a distinct `generation_id`
/// (the id is the bundle's SHA-256). Tests that publish a "new" generation over
/// the tiny-backed harness use this so the adoption assertion is non-trivial.
pub fn canary_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/canary.ptb")
}

/// A ready-to-drive reload harness: a `ReloadRunner` pre-loaded with an initial
/// generation built from `tiny.ptb`, plus the handles tests need to publish new
/// generations and assert on the post-reload world.
///
/// `_tmp` (the `data_root`'s backing `TempDir`) MUST stay alive for the
/// harness's lifetime — dropping it deletes the on-disk generation tree.
pub struct ReloadHarness {
    pub runner: ReloadRunner,
    pub gen_handle: Arc<arc_swap::ArcSwap<Generation>>,
    pub metrics: Arc<Metrics>,
    pub data_root: PathBuf,
    pub clock: Arc<MockClock>,
    pub _tmp: TempDir,
}

/// Build a reload harness for `city`. The initial generation is published from
/// `tiny.ptb` and built through the SAME `build_generation` path the reload
/// runner uses (so tests exercise the shared builder end-to-end). The mock
/// clock is anchored at [`RELOAD_HARNESS_ANCHOR`].
pub fn reload_harness(city: &str) -> ReloadHarness {
    reload_harness_inner(city, None)
}

/// Like [`reload_harness`] but the initial generation is published WITH a
/// `shapes.bin` sidecar (`shapes_bin` bytes) and its `shapesJsonSha256` recorded
/// in the manifest — so the built `Generation`'s `shapes_json_sha256` is `Some`.
/// Tests that prove the served shapes hash advances across a reload need the
/// initial gen to carry one (the plain `reload_harness` publishes no shapes.bin,
/// so its `shapes_json_sha256` is `None`).
pub fn reload_harness_with_shapes(city: &str, shapes_bin: Vec<u8>) -> ReloadHarness {
    reload_harness_inner(city, Some(shapes_bin))
}

fn reload_harness_inner(city: &str, shapes_bin: Option<Vec<u8>>) -> ReloadHarness {
    let clock = Arc::new(MockClock::new(
        SystemTime::UNIX_EPOCH + Duration::from_secs(RELOAD_HARNESS_ANCHOR),
    ));
    let tmp = TempDir::new().expect("tempdir");
    let data_root = tmp.path().to_path_buf();
    let created_at = publisher::rfc3339_format(RELOAD_HARNESS_ANCHOR);
    let initial_gen_id = match shapes_bin {
        Some(bin) => publisher::publish_generation_with_artifacts(
            &data_root,
            city,
            &tiny_ptb_path(),
            &created_at,
            &publisher::SidecarArtifacts {
                shapes_bin: Some(bin),
                ..Default::default()
            },
        ),
        None => publisher::publish_generation(&data_root, city, &tiny_ptb_path(), &created_at),
    };

    // Build the initial Generation through the SAME path the reload runner
    // will use, so the harness exercises the shared builder end-to-end.
    let manifest_text =
        std::fs::read_to_string(publisher::manifest_path_for(&data_root, &initial_gen_id))
            .expect("read manifest");
    let manifest: pt_shared::manifest::GenerationManifest =
        serde_json::from_str(&manifest_text).expect("parse manifest");
    let metrics = Metrics::new();
    let clock_dyn: Arc<dyn Clock> = clock.clone();
    let initial = pt_serve::bundle::build_generation(pt_serve::bundle::BuildInputs {
        manifest: &manifest,
        bundle_path: &publisher::bundle_path_for(&data_root, &initial_gen_id),
        transfers_path: None,
        expected_city: city,
        clock: clock_dyn.as_ref(),
        is_startup: true,
        epoch: 0,
        metrics: Some(Arc::clone(&metrics)),
        city_tz_iana_default: Some("Europe/Vilnius"),
        pattern_mode: pt_core::PatternMode::Off,
    })
    .expect("build initial generation");
    // Record adoption so the info-gauge surface mirrors prod.
    let now_unix = clock_dyn
        .now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    metrics.record_generation_adopted(&initial.generation_id, now_unix);

    let gen_handle = Arc::new(arc_swap::ArcSwap::new(Arc::new(initial)));
    let mut cfg = default_test_config(data_root.clone());
    cfg.city_slug = city.to_string();
    cfg.worker_pool_size = 1;
    let config = Arc::new(cfg);
    let runner = ReloadRunner::new(
        Arc::clone(&gen_handle),
        Arc::clone(&config),
        Arc::clone(&metrics),
        clock_dyn,
    );
    ReloadHarness {
        runner,
        gen_handle,
        metrics,
        data_root,
        clock,
        _tmp: tmp,
    }
}

/// Silence the per-binary dead-code lint when a test binary doesn't touch
/// every `ReloadHarness` field.
#[allow(dead_code)]
fn _silence_reload_harness(_: &ReloadHarness) {}

/// Build a fully-populated P4 `ServerConfig` for tests. The pidfile lives
/// under `data_root` so the `pidfile_path` parent check passes; the RSS
/// budget is a 1 GiB sentinel — far above anything tests trigger — and
/// the listen ports are `:0` so the OS picks free ports under parallel
/// execution.
pub fn default_test_config(data_root: PathBuf) -> ServerConfig {
    ServerConfig {
        worker_pool_size: 2,
        request_timeout_ms: 5_000,
        prestop_grace_secs: 1,
        max_rss_bytes: 1_073_741_824, // 1 GiB sentinel; RSS guard tests cover the configured limit
        process_fixed_overhead_bytes: 200_000_000,
        per_worker_overhead_bytes: 50_000_000,
        pidfile_path: data_root.join("pt-serve.pid"),
        data_root,
        city_slug: "vilnius".to_string(),
        listen_addr: "127.0.0.1:0".to_string(),
        metrics_listen_addr: "127.0.0.1:0".to_string(),
        loopback_listen_addr: "127.0.0.1:0".to_string(),
        loopback_worker_count: 2,
        max_retained_generations: 10,
        page_warm_mode: pt_serve::ops::PageWarmMode::WillNeed,
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

/// Mint an isolated test environment. The returned `TempDir` MUST be held by
/// the test for the duration — drop deletes the directory.
pub fn isolated_config() -> (TempDir, ServerConfig, Arc<MockClock>) {
    let dir = TempDir::new().expect("tempdir");
    let config = default_test_config(dir.path().to_path_buf());
    // Start at the UNIX epoch so duration arithmetic in tests is easy to read
    // (e.g. `clock.advance(Duration::from_secs(3600 + 1))` is unambiguously
    // "past the 1h cleanup threshold").
    let clock = Arc::new(MockClock::new(SystemTime::UNIX_EPOCH));
    (dir, config, clock)
}
