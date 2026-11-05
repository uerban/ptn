//! consecutive-reload leak gate.
//!
//! In one `pt-serve` process, run **N ≥ 20 consecutive reloads** against a
//! producer that publishes fresh generations. After each drain
//! (`generation_retired_total` increment), sample
//!  - Pss (from `/proc/self/smaps_rollup`; skipped on macOS — no /proc)
//!  - `process_threads` (Linux only — same skip rule)
//!  - `process_open_fds` (Linux only — same skip rule)
//!  - `/metrics` text size
//!
//! Then assert (rev 4 invariant — tightened from rev 3):
//!  - **Slope-regression leak gate**: least-squares slope of
//!    `pss_after_drain[i]` vs `i` is below
//!    `consecutiveReloadPssGrowthSlopeBytesMax`, computed as
//!    `max(4096, (0.01 / N) × median(pss_after_drain[0..5]))`.
//!
//!    Two changes from rev 3:
//!     1. Tightened the fractional factor from `0.10/N` to `0.01/N` —
//!        a per-reload growth of 1% of baseline is still very loose but
//!        no longer accommodates leaks that drift the residency by 10%
//!        across the window.
//!     2. Added a per-page absolute FLOOR (4096 B/reload). On a small-
//!        baseline run the fractional threshold can fall below one page;
//!        a real leak that allocates one page per reload would slide
//!        under the test undetected. The floor guarantees we catch a
//!        single-page-per-reload pattern.
//!
//!    The threshold is `max(floor, fractional)`; whichever is larger governs.
//!
//!  - **Absolute floor**: `pss_after_drain[N-1] - median(pss_after_drain[0..5])
//!    < 5 × sigma_residual`, where `sigma_residual` is the stddev of the
//!    series AFTER subtracting the linear trend at the measured slope. The
//!    residual σ reflects pure jitter, not jitter+drift; 5σ on Gaussian
//!    jitter is p<1e-6, robust to one-off spikes but catches a small steady
//!    drift that a 10σ guard over the raw series would let through. Computing
//!    σ over the un-detrended series would self-defeat: a real linear leak
//!    inflates σ by the drift itself, pushing the 5σ ceiling above the drift.
//!  - `process_threads`, `process_open_fds` stay flat (≤ baseline + 2).
//!  - `/metrics` text size stays sub-linear (no per-generation label
//!    cardinality leak — a per-id counter alone is fine because the
//!    retention janitor caps adoption history).
//!
//! ## #[ignore] by default
//!
//! The test takes ~5 minutes wall-clock on Linux and is marked `#[ignore]`
//! so a developer running `cargo test -p pt-serve` doesn't pay the cost.
//! CI opts in via `cargo test -p pt-serve --features test-park --
//! --ignored leak_consecutive`. On macOS the Pss/process_threads/
//! process_open_fds assertions are SKIPPED (no /proc); the metrics-text
//! size + reload-count assertions still run, proving the runner does what
//! it claims to do on platforms where the kernel surface is present.
//!
//! ## Why "in-process" rather than a child binary
//!
//! Driving the reload-runner API directly (no subprocess spawn, no signal
//! delivery, no transport) lets the test run deterministically across N
//! reloads in a few seconds rather than racing 20 SIGHUPs against a
//! tiny_http event loop. The signal-delivery path itself is covered by
//! `tests/reload_coalesce.rs` and the topology bats test.

#[path = "common/mod.rs"]
mod common;

use common::publisher;
use pt_serve::ops::Metrics;
use pt_serve::{ReloadOutcome, ReloadRunner};
use pt_shared::clock::{Clock, MockClock};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

fn canary_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/canary.ptb")
}

/// Number of consecutive reloads to drive. Spec floor is N ≥ 20.
const N: usize = 24;

/// Per-reload wall-clock ceiling. 15s is generous; the in-process path actually completes in a few
/// ms.
const PER_RELOAD_BUDGET: Duration = Duration::from_secs(15);

/// Whole-test wall-clock ceiling.
const TOTAL_BUDGET: Duration = Duration::from_secs(300);

/// Sample from `/proc/self/smaps_rollup`. Returns `None` on non-Linux
/// or any I/O error.
#[cfg(target_os = "linux")]
fn read_pss_bytes() -> Option<u64> {
    let text = std::fs::read_to_string("/proc/self/smaps_rollup").ok()?;
    pt_serve::ops::metrics::parse_smaps_rollup_pss(&text)
}

#[cfg(not(target_os = "linux"))]
fn read_pss_bytes() -> Option<u64> {
    None
}

#[cfg(target_os = "linux")]
fn read_num_threads() -> Option<u64> {
    let text = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("Threads:") {
            return rest.split_whitespace().next()?.parse().ok();
        }
    }
    None
}

#[cfg(not(target_os = "linux"))]
fn read_num_threads() -> Option<u64> {
    None
}

#[cfg(target_os = "linux")]
fn read_open_fds() -> Option<u64> {
    let entries = std::fs::read_dir("/proc/self/fd").ok()?;
    Some(entries.filter_map(|e| e.ok()).count() as u64)
}

#[cfg(not(target_os = "linux"))]
fn read_open_fds() -> Option<u64> {
    None
}

fn median(values: &[u64]) -> u64 {
    let mut sorted: Vec<u64> = values.to_vec();
    sorted.sort_unstable();
    let mid = sorted.len() / 2;
    if sorted.len().is_multiple_of(2) {
        (sorted[mid - 1] + sorted[mid]) / 2
    } else {
        sorted[mid]
    }
}

/// Stddev of residuals after subtracting a linear trend at the given slope.
/// Used as the "noise floor" sigma for the 5σ absolute-drift gate so that a
/// real linear leak (slope ≠ 0) doesn't inflate the σ used to permit it.
/// Mean of the residuals is computed from the same series (intercept implied
/// by `slope * i`); subtracts mean to obtain centred residuals before
/// summing squares with Bessel's correction (n-1).
fn stddev_detrended(ys: &[u64], slope: f64) -> f64 {
    if ys.len() < 2 {
        return 0.0;
    }
    let residuals: Vec<f64> = ys
        .iter()
        .enumerate()
        .map(|(i, &y)| y as f64 - slope * i as f64)
        .collect();
    let mean = residuals.iter().sum::<f64>() / residuals.len() as f64;
    let sum_sq: f64 = residuals.iter().map(|&r| (r - mean).powi(2)).sum();
    (sum_sq / (residuals.len() - 1) as f64).sqrt()
}

/// Least-squares slope of (ys[i] vs i). Returns bytes-per-reload.
fn slope_per_index(ys: &[u64]) -> f64 {
    let n = ys.len() as f64;
    let sum_x: f64 = (0..ys.len()).map(|i| i as f64).sum();
    let mean_x = sum_x / n;
    let mean_y = ys.iter().sum::<u64>() as f64 / n;
    let mut num = 0.0;
    let mut den = 0.0;
    for (i, &y) in ys.iter().enumerate() {
        let dx = i as f64 - mean_x;
        num += dx * (y as f64 - mean_y);
        den += dx * dx;
    }
    if den == 0.0 {
        0.0
    } else {
        num / den
    }
}

#[test]
#[ignore = "slow: takes ~5 min wall-clock; run on CI via `--ignored leak_consecutive`"]
fn consecutive_reloads_do_not_leak_pss_or_fds() {
    let test_start = Instant::now();

    // Anchor the mock clock at a time the metadata validator accepts. The
    // exact value matches the rest of the integration-test corpus.
    let clock = Arc::new(MockClock::new(
        SystemTime::UNIX_EPOCH + Duration::from_secs(1779494400),
    ));
    let data_root = tempfile::tempdir().expect("tempdir");
    let city = "vilnius".to_string();

    // Publish an initial generation and build the first Generation through
    // the same builder the reload runner uses (so the test exercises the
    // shared path end-to-end).
    let created_at = publisher::rfc3339_format(1779494400);
    let initial_gen_id =
        publisher::publish_generation(data_root.path(), &city, &tiny_ptb_path(), &created_at);
    let manifest_text = std::fs::read_to_string(publisher::manifest_path_for(
        data_root.path(),
        &initial_gen_id,
    ))
    .expect("read manifest");
    let manifest: pt_shared::manifest::GenerationManifest =
        serde_json::from_str(&manifest_text).expect("parse manifest");
    let metrics = Metrics::new();
    let clock_dyn: Arc<dyn Clock> = clock.clone();
    let initial = pt_serve::bundle::build_generation(pt_serve::bundle::BuildInputs {
        manifest: &manifest,
        bundle_path: &publisher::bundle_path_for(data_root.path(), &initial_gen_id),
        transfers_path: None,
        expected_city: &city,
        clock: clock_dyn.as_ref(),
        is_startup: true,
        epoch: 0,
        metrics: Some(Arc::clone(&metrics)),
        city_tz_iana_default: Some("Europe/Vilnius"),
        pattern_mode: pt_core::PatternMode::Off,
    })
    .expect("build initial generation");
    let now_unix = clock_dyn
        .now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    metrics.record_generation_adopted(&initial.generation_id, now_unix);

    let gen_handle = Arc::new(arc_swap::ArcSwap::new(Arc::new(initial)));
    let mut cfg = common::default_test_config(data_root.path().to_path_buf());
    cfg.city_slug = city.clone();
    cfg.worker_pool_size = 1;
    let config = Arc::new(cfg);
    let runner = Arc::new(ReloadRunner::new(
        Arc::clone(&gen_handle),
        Arc::clone(&config),
        Arc::clone(&metrics),
        clock_dyn.clone(),
    ));

    // Baseline samples (taken AFTER the initial generation is in place).
    let baseline_pss = read_pss_bytes();
    let baseline_threads = read_num_threads();
    let baseline_fds = read_open_fds();
    let baseline_metrics_size = pt_serve::ops::metrics::render_body(&metrics).len();
    let baseline_retired = metrics.generation_retired_total();

    // Alternate between two fixture bundles so each reload picks up a NEW
    // generation_id (publish_generation derives the id from the bundle SHA).
    // The reload runner returns Noop when current.json pointer is unchanged;
    // alternating guarantees adoption each loop. The initial generation
    // was tiny.ptb, so START iteration 0 with canary to force adoption.
    let fixtures = [canary_ptb_path(), tiny_ptb_path()];
    let mut pss_after_drain: Vec<u64> = Vec::with_capacity(N);
    let mut threads_after_drain: Vec<u64> = Vec::with_capacity(N);
    let mut fds_after_drain: Vec<u64> = Vec::with_capacity(N);
    let mut metrics_size_after_drain: Vec<usize> = Vec::with_capacity(N);

    // createdAt fixed at the clock anchor + 10s (well within the 60s reload
    // skew tolerance). The id uniqueness across iterations comes from the
    // alternating bundle bytes, not the timestamp.
    let created_at = publisher::rfc3339_format(1779494410);
    for i in 0..N {
        let reload_start = Instant::now();
        // Publish a fresh generation by writing the alternate bundle (different
        // bytes => different SHA-256 => different generation_id), and re-point
        // current.json at it. The next trigger is then an adoption, not a noop.
        let new_id = publisher::publish_generation(
            data_root.path(),
            &city,
            &fixtures[i % fixtures.len()],
            &created_at,
        );

        let outcome = runner.trigger_reload();
        // Adoption — anything else is a runner bug we want to surface.
        match outcome {
            ReloadOutcome::Adopted { generation_id } => {
                assert_eq!(generation_id, new_id, "iteration {i}: wrong adoption id")
            }
            // A noop here would mean two consecutive iterations hashed to
            // the same id (fixture bug); a failure would mean the runner
            // mis-handled a valid generation. Either way the loop must stop.
            other => panic!("iteration {i}: expected Adopted, got {other:?}"),
        }

        // Drop the load handle inside this block so the OLD `Arc<Generation>`
        // (now no longer referenced by `gen_handle`) is retired before we
        // sample residency. The retired counter going up by 1 every iteration
        // is the load-bearing precondition.
        let elapsed = reload_start.elapsed();
        assert!(
            elapsed <= PER_RELOAD_BUDGET,
            "iteration {i}: reload took {elapsed:?} (budget {PER_RELOAD_BUDGET:?})"
        );

        // Sample the residency + process surface AFTER the drain.
        if let Some(p) = read_pss_bytes() {
            pss_after_drain.push(p);
        }
        if let Some(t) = read_num_threads() {
            threads_after_drain.push(t);
        }
        if let Some(f) = read_open_fds() {
            fds_after_drain.push(f);
        }
        metrics_size_after_drain.push(pt_serve::ops::metrics::render_body(&metrics).len());

        // Whole-test ceiling — bail loudly if a runaway loop blows past 5 min.
        assert!(
            test_start.elapsed() <= TOTAL_BUDGET,
            "leak_consecutive blew the {TOTAL_BUDGET:?} total budget at iteration {i}"
        );
    }

    // ---- Invariants ----

    // 1) Every reload retired exactly one prior generation.
    let retired_delta = metrics.generation_retired_total() - baseline_retired;
    assert_eq!(
        retired_delta, N as u64,
        "expected {N} retirements, got {retired_delta} (Generation::Drop instrumentation)"
    );

    // 2) Metrics text size stays sub-linear in N (allow some growth from the
    //    per-id `generation_adopted_total` and `reload_total{cause}` cells,
    //    but a linear factor would mean a label-cardinality leak — fail loud).
    //    Generous ceiling: baseline + 8 KiB (an upper bound on N=24 worth of
    //    HashMap-rendered counter rows on tiny.ptb).
    let final_metrics_size = *metrics_size_after_drain.last().expect("≥1 sample");
    assert!(
        final_metrics_size <= baseline_metrics_size + 8 * 1024,
        "metrics text size grew from {baseline_metrics_size} -> {final_metrics_size} \
         after {N} reloads (>+8 KiB ceiling: probable label cardinality leak)"
    );

    // 3) Linux-only invariants — Pss + process gauges. On macOS the samples
    //    vector is empty; we report the skip and stop, so the test still
    //    proves on macOS what it can (the in-process reload loop completes
    //    deterministically without a panic).
    if pss_after_drain.is_empty() {
        eprintln!(
            "[leak_consecutive] SKIP Pss/process_threads/process_open_fds: /proc not readable \
             (macOS or container without /proc). Reload-loop + metrics-text-size checks PASSED."
        );
        return;
    }

    // 3a) Slope-regression leak gate (rev 4 — tightened).
    let early_window: Vec<u64> = pss_after_drain.iter().take(5).copied().collect();
    let early_median = median(&early_window);
    // Threshold: max(4096 B/reload, 0.01/N × early median). The per-page
    // floor catches a single-page-per-reload leak that would otherwise
    // slide under a small-baseline-driven fractional floor; the
    // fractional component scales with the baseline so a large-bundle
    // run isn't tripped by routine page-table noise. See
    // the pt-serve budget file
    // for the documented threshold.
    const PER_PAGE_FLOOR: f64 = 4096.0;
    let fractional = (0.01 / (N as f64)) * (early_median as f64);
    let slope_threshold = PER_PAGE_FLOOR.max(fractional);
    let measured_slope = slope_per_index(&pss_after_drain);
    eprintln!(
        "[leak_consecutive] N={} pss[0]={} early_med={} pss[N-1]={} slope={:.2} bytes/reload \
         (threshold {:.2})",
        pss_after_drain.len(),
        pss_after_drain.first().copied().unwrap_or(0),
        early_median,
        pss_after_drain.last().copied().unwrap_or(0),
        measured_slope,
        slope_threshold,
    );
    // Strict `<`: a slope of EXACTLY PER_PAGE_FLOOR (4096 B/reload — the
    // documented single-page-per-reload leak the floor is designed to catch)
    // must fail, not pass. Perf review #3 caught the asymmetric `<=`.
    assert!(
        measured_slope < slope_threshold,
        "Pss growth slope {measured_slope:.2} bytes/reload meets-or-exceeds threshold \
         {slope_threshold:.2} (max(4096 B, 0.01/N × median(early-window))). \
         A growing residency across N={N} reloads is a leak."
    );

    // 3b) Absolute floor: final Pss - early_median < 5 × sigma_residual,
    //     where sigma_residual is the stddev AFTER removing the linear trend.
    //     Perf review #3 caught that computing stddev over the raw series
    //     inflates σ by the drift itself: a true linear leak of ~4 KB/reload
    //     over N=24 contributes mean drift ≈ 52 KB and a raw σ ~30 KB,
    //     yielding 5σ ≈ 150 KB > drift 52 KB — the test would pass DESPITE
    //     a clear leak. Detrending (subtract slope*i from each sample) makes
    //     σ reflect the noise floor only, so the 5σ guard fires on real
    //     drift.
    let sigma_residual = stddev_detrended(&pss_after_drain, measured_slope);
    let last_pss = *pss_after_drain.last().expect("≥1 sample");
    let drift = last_pss as f64 - early_median as f64;
    let abs_floor = 5.0 * sigma_residual;
    assert!(
        drift <= abs_floor,
        "Pss drift {drift:.2} bytes (final {last_pss} - early_median {early_median}) \
         exceeds 5×sigma_residual {abs_floor:.2} (sigma_residual {sigma_residual:.2}, \
         detrended at slope {measured_slope:.2})"
    );

    // 3c) process_threads stays flat (≤ baseline + 2). A worker thread that
    //     leaks across reloads would show up here.
    if let (Some(base), Some(final_t)) = (baseline_threads, threads_after_drain.last().copied()) {
        assert!(
            final_t <= base + 2,
            "process_threads grew from {base} -> {final_t} after {N} reloads (>+2 ceiling)"
        );
    }

    // 3d) process_open_fds stays flat (≤ baseline + 2). A mmap that doesn't
    //     get unmapped would leak the underlying file fd.
    if let (Some(base), Some(final_f)) = (baseline_fds, fds_after_drain.last().copied()) {
        assert!(
            final_f <= base + 2,
            "process_open_fds grew from {base} -> {final_f} after {N} reloads (>+2 ceiling)"
        );
    }

    // 4) Hold gen_handle alive so the test's last reload's generation isn't
    //    treated as a leak by Miri/asan (it's the LIVE one). Drop explicitly
    //    here so the borrow checker confirms intent.
    drop(gen_handle);
    let _ = baseline_pss; // recorded only as the diagnostic anchor; not gated
}
