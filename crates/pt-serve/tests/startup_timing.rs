//! startup-timing budgets for the cold-start path.
//!
//! Two scenarios under `tests/common::isolated_config`:
//!
//!  1. **Happy-path cold start.** From a valid `current.json`, time
//!     `load_initial_generation` (which performs the loader + `Generation`
//!     build, including mmap + `pt_core::Index::build`). Cold-cache because
//!     each test mints a fresh `TempDir` whose bytes are not yet in the page
//!     cache. The measured budget is `startupReadyMsMax`. The 2 s ceiling is
//!     deliberately generous for a CI runner; this test is a regression
//!     trip-wire, not a calibration of the bound (real calibration lands in
//!     the pt-serve budget file via the bench harness).
//!
//!  2. **Fallback cold start.** A broken `current.json` + valid
//!     `last-good.json` must (a) succeed on the fallback path and (b)
//!     increment `startup_generation_fallback_total` exactly once. Same
//!     wall-clock budget — `startupFallbackReadyMsMax`.
//!
//! The Rust-API surface is exercised directly (no child-process spawn) so the timing is dominated
//! by the loader + Index build rather than a subprocess fork + TCP bind.

#[path = "common/mod.rs"]
mod common;

use common::isolated_config;
use common::publisher;
use pt_serve::bundle::load_initial_generation_with_force;
use pt_serve::ops::Metrics;
use pt_serve::LogFormat;
use pt_shared::clock::SystemClock;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

/// CI runners can be slow under contention; 2 s is a comfortable ceiling for
/// the tiny.ptb fixture cold-start. The bench harness will calibrate the
/// real budget into the pt-serve budget file via `--update-budgets`.
const STARTUP_BUDGET_MS: u128 = 2_000;

/// Publish a generation via the shared `publisher` helper, returning the id.
/// The helper writes `current.json` as well; the caller may then overwrite
/// it for the fallback scenario.
fn publish(data_root: &Path, city: &str, source_ptb: &Path) -> String {
    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    publisher::publish_generation(
        data_root,
        city,
        source_ptb,
        &publisher::rfc3339_format(now_unix),
    )
}

fn write_garbage_pointer(data_root: &Path, file_name: &str) {
    fs::write(data_root.join(file_name), b"{ not json }").unwrap();
}

fn write_valid_last_good(data_root: &Path, id: &str, city: &str) {
    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let pointer = serde_json::json!({
        "manifestSchemaVersion": 2,
        "generationId": id,
        "citySlug": city,
        "createdAt": publisher::rfc3339_format(now_unix),
    });
    fs::write(
        data_root.join("last-good.json"),
        serde_json::to_string_pretty(&pointer).unwrap(),
    )
    .unwrap();
}

// ---------------------------------------------------------------------------
// Scenario 1: happy-path cold start
// ---------------------------------------------------------------------------

#[test]
fn cold_start_from_valid_current_under_budget() {
    let (dir, cfg, _clock) = isolated_config();
    let root = dir.path();
    // `publish` writes both the generation directory AND current.json pointing
    // at the new id (the publisher mirrors a producer's happy-path).
    let id = publish(root, &cfg.city_slug, &tiny_ptb_path());

    let metrics = Metrics::new();
    let t0 = Instant::now();
    let gen = load_initial_generation_with_force(
        root,
        &cfg.city_slug,
        &SystemClock,
        &metrics,
        None,
        LogFormat::Json,
        Some("Europe/Vilnius"),
        pt_core::PatternMode::Off,
    )
    .expect("load");
    let elapsed_ms = t0.elapsed().as_millis();

    assert_eq!(
        gen.generation_id, id,
        "expected the seeded id to be adopted"
    );
    assert!(
        elapsed_ms < STARTUP_BUDGET_MS,
        "cold-start happy path took {elapsed_ms} ms (budget {STARTUP_BUDGET_MS} ms)"
    );

    // No fallback events on the happy path.
    assert!(
        !metrics.startup_fallback_active(),
        "startup_fallback_active must be false on happy path"
    );
    assert_eq!(
        metrics.startup_generation_fallback_total(),
        0,
        "startup_generation_fallback_total must be 0 on happy path"
    );
}

// ---------------------------------------------------------------------------
// Scenario 2: fallback cold start (current broken, last-good valid)
// ---------------------------------------------------------------------------

#[test]
fn cold_start_fallback_to_last_good_under_budget_and_increments_counter() {
    let (dir, cfg, _clock) = isolated_config();
    let root = dir.path();
    // Publish the generation (writes a valid current.json), then immediately
    // overwrite current.json with garbage so the loader is forced onto the
    // last-good fallback path.
    let id = publish(root, &cfg.city_slug, &tiny_ptb_path());
    write_valid_last_good(root, &id, &cfg.city_slug);
    write_garbage_pointer(root, "current.json");

    let metrics = Metrics::new();
    let t0 = Instant::now();
    let gen = load_initial_generation_with_force(
        root,
        &cfg.city_slug,
        &SystemClock,
        &metrics,
        None,
        LogFormat::Json,
        Some("Europe/Vilnius"),
        pt_core::PatternMode::Off,
    )
    .expect("load");
    let elapsed_ms = t0.elapsed().as_millis();

    assert_eq!(gen.generation_id, id);
    assert!(
        elapsed_ms < STARTUP_BUDGET_MS,
        "fallback cold-start took {elapsed_ms} ms (budget {STARTUP_BUDGET_MS} ms)"
    );

    // The fallback boolean is set + the counter is exactly 1.
    assert!(
        metrics.startup_fallback_active(),
        "startup_fallback_active must be true after last-good adoption"
    );
    assert_eq!(
        metrics.startup_generation_fallback_total(),
        1,
        "startup_generation_fallback_total must be exactly 1 after a fallback boot"
    );
}
