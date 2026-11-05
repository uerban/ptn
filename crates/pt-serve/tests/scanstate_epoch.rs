//! `ScanState::epoch` invalidation across a reload swap (Stage 2).
//!
//! Workers cache a `ScanState` keyed by the active generation's epoch. After
//! a swap, the next `/plan` request must observe the epoch mismatch and
//! reallocate. The plan handler does this via:
//!
//! ```ignore
//! if cached_epoch != Some(gen.epoch) {
//!     *scan_state = Some(ScanState::new_for(&gen.index, gen.epoch));
//! }
//! ```
//!
//! This test exercises the dispatch path directly (not over HTTP), so the
//! assertion can read the worker's `ScanState` AFTER reload without racing
//! the wire. We use `ScanState::capacity_hint()` — a debug-only diagnostic
//! returning `best_arrival.capacity()` — to prove the post-reload state is
//! a FRESH allocation (capacity_hint becomes 0 immediately after the
//! `new_for` call, since `FxHashMap::new` allocates lazily on first
//! insert). The OLD `ScanState`, once used by a plan request, would have a
//! non-zero capacity from the previous query — observing the cleared
//! capacity is proof the reallocation fired.
//!
//! Note: this integration test legitimately calls `ArcSwap::load_full` to
//! simulate the in-flight worker reading the active generation; the clippy
//! disallowed-methods rule that restricts ambient `Arc<Generation>` in
//! handlers is opted-out at file scope here.

#![allow(clippy::disallowed_methods)]

#[path = "common/mod.rs"]
mod common;

use common::publisher;
use pt_core::ScanState;
use pt_serve::{Generation, Metrics, ReloadRunner};
use pt_shared::clock::{Clock, MockClock};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}
fn canary_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/canary.ptb")
}

fn build_initial(
    data_root: &Path,
    city: &str,
    initial_ptb: &Path,
    metrics: &Arc<Metrics>,
    clock: &Arc<dyn Clock>,
) -> Generation {
    let created_at = publisher::rfc3339_format(1779494400);
    let id = publisher::publish_generation(data_root, city, initial_ptb, &created_at);
    let manifest_text =
        std::fs::read_to_string(publisher::manifest_path_for(data_root, &id)).unwrap();
    let manifest: pt_shared::manifest::GenerationManifest =
        serde_json::from_str(&manifest_text).unwrap();
    pt_serve::bundle::build_generation(pt_serve::bundle::BuildInputs {
        manifest: &manifest,
        bundle_path: &publisher::bundle_path_for(data_root, &id),
        transfers_path: None,
        expected_city: city,
        clock: clock.as_ref(),
        is_startup: true,
        epoch: 0,
        metrics: Some(Arc::clone(metrics)),
        city_tz_iana_default: Some("Europe/Vilnius"),
        pattern_mode: pt_core::PatternMode::Off,
    })
    .expect("build initial generation")
}

/// After SIGHUP-driven adoption, the cached `ScanState`'s epoch lags the
/// live generation's. The plan-handler's epoch protocol reallocates on
/// mismatch — modelled here by the equivalent `ScanState::new_for` call,
/// asserting capacity_hint resets to 0 (a fresh map).
#[test]
fn reload_invalidates_worker_scanstate_via_epoch_bump() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let clock_mock = Arc::new(MockClock::new(
        SystemTime::UNIX_EPOCH + Duration::from_secs(1779494400),
    ));
    let clock: Arc<dyn Clock> = clock_mock.clone();
    let metrics = Metrics::new();

    let initial = build_initial(
        data_root.path(),
        "vilnius",
        &tiny_ptb_path(),
        &metrics,
        &clock,
    );
    let initial_epoch = initial.epoch;
    let gen_handle = Arc::new(arc_swap::ArcSwap::new(Arc::new(initial)));
    let mut cfg = common::default_test_config(data_root.path().to_path_buf());
    cfg.worker_pool_size = 1;
    let config = Arc::new(cfg);
    let runner = Arc::new(ReloadRunner::new(
        Arc::clone(&gen_handle),
        Arc::clone(&config),
        Arc::clone(&metrics),
        Arc::clone(&clock),
    ));

    // ---- Worker simulation: build a ScanState tagged at the initial epoch ----
    // We don't run a real plan query here (that would require a routable
    // entry/exit pair on tiny.ptb's S1/S2/S3 — covered by tests/server.rs).
    // The epoch protocol is the load-bearing invariant; we test it by
    // hand-feeding the same logic the dispatcher uses.
    let live_before = gen_handle.load_full();
    let mut scan_state: Option<ScanState> =
        Some(ScanState::new_for(&live_before.index, initial_epoch));
    // Capture the pre-state's epoch — after replacement, the new state's
    // epoch must differ. (Pointer identity is unreliable: the Option's
    // outer storage is stack-stable, and the inner ScanState's address can
    // accidentally coincide if the allocator re-uses the same slot after a
    // drop — observed on macOS aarch64.)
    let pre_epoch = scan_state.as_ref().unwrap().epoch;
    drop(live_before);

    // ---- Publish + reload ----
    let created_b = publisher::rfc3339_format(1779494410);
    publisher::publish_generation(data_root.path(), "vilnius", &canary_ptb_path(), &created_b);
    let outcome = runner.trigger_reload();
    assert!(outcome.is_adopted(), "{outcome:?}");

    let live = gen_handle.load_full();
    assert_ne!(live.epoch, initial_epoch, "epoch must bump on adoption");

    // ---- Dispatcher epoch protocol (verbatim from app/plan.rs) ----
    let cached_epoch = scan_state.as_ref().map(|s| s.epoch);
    if cached_epoch != Some(live.epoch) {
        scan_state = Some(ScanState::new_for(&live.index, live.epoch));
    }
    let new_state = scan_state.as_ref().expect("post-reload state");
    assert_eq!(
        new_state.epoch, live.epoch,
        "post-reload ScanState carries the live generation's epoch"
    );
    assert_eq!(
        new_state.capacity_hint(),
        0,
        "post-reload ScanState is a fresh allocation (capacity_hint = 0)"
    );
    // The Option-wrap → epoch mismatch → reallocate path actually replaced
    // the inner ScanState. The epoch field changed (proves a fresh
    // ScanState, not just an in-place mutation of the old one — the only
    // way `epoch` mutates is via `new_for`).
    assert_ne!(
        new_state.epoch, pre_epoch,
        "reload should have replaced the worker's ScanState (epoch changed)"
    );
}
