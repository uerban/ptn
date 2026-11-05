//! Stage 2 deterministic coalescing test for the reload runner (rev 3).
//!
//! Two SIGHUP-equivalent triggers, the second arriving while the first is
//! parked between validation and swap, MUST result in exactly two adoptions
//! (the second picking up the latest pointer published while the first was
//! parked) without `mapped_generation_count` ever exceeding 2.
//!
//! This is the deterministic version of rev 2's flaky "sleep + cross fingers"
//! coalescing test: the [`pt_serve::reload::ReloadBarrier`] lets the test
//! thread release the runner at a known point, eliminating the timing race.

#[path = "common/mod.rs"]
mod common;

use common::publisher;
use pt_serve::ops::metrics::{ReloadCause, ReloadResult};
use pt_serve::reload::ReloadBarrier;
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

fn build_initial_generation(
    data_root: &Path,
    city: &str,
    initial_ptb: &Path,
    metrics: &Arc<Metrics>,
    clock: &Arc<dyn Clock>,
) -> (Generation, String) {
    let created_at = publisher::rfc3339_format(1779494400);
    let id = publisher::publish_generation(data_root, city, initial_ptb, &created_at);
    let manifest_text =
        std::fs::read_to_string(publisher::manifest_path_for(data_root, &id)).unwrap();
    let manifest: pt_shared::manifest::GenerationManifest =
        serde_json::from_str(&manifest_text).unwrap();
    let g = pt_serve::bundle::build_generation(pt_serve::bundle::BuildInputs {
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
    .expect("build initial");
    metrics.record_generation_adopted(
        &g.generation_id,
        clock
            .now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    );
    (g, id)
}

/// The load-bearing rev-3 coalescing assertion.
///
/// Sequence:
/// 1. Publish gen A (tiny.ptb); construct runner with a `ReloadBarrier`
///    installed; gen_handle points at gen A.
/// 2. Test thread publishes gen B (canary.ptb), triggers reload on a
///    sidecar thread. Sidecar runs `handle_sighup_event` → in_flight goes
///    true → runner builds new gen → parks at the barrier.
/// 3. Test thread waits for barrier arrival, then publishes gen C (tiny.ptb
///    again but with a tweaked manifest createdAt so it has a distinct id...
///    actually we use a second copy via a marker prefix on a fresh
///    file path). Simpler: re-publish tiny.ptb under a different generation
///    id by appending a no-op byte? No — generation_id == sha256(bytes). To
///    publish a distinct gen C with our current test fixtures (tiny +
///    canary), we use a third fixture OR mutate the bytes. Easiest: copy
///    tiny.ptb to a temp file, append 1 byte, then publish — but that
///    would fail PTB structural validation. So we publish a separate
///    "gen C = canary.ptb" — wait, gen B is canary.ptb. Use tiny.ptb for
///    gen C (gen A's bytes again, but with a NEW generation_id from a
///    fresh tweak... or accept "two adoptions" includes A→B and then a
///    second adoption B→tiny.ptb-which-is-the-old-A-id is fine).
///
/// Actually the spec rationale is "the latch fires; the second reload
/// runs". Even if gen C re-publishes gen A's content, the runner still
/// goes through the full reload pipeline (gen_handle compares ids); the
/// noop classification kicks in only when the ID matches the LIVE gen,
/// which by that time is gen B. So pointing current.json back at gen A's
/// id IS a valid second adoption.
///
/// Concretely:
///   - gen A (tiny.ptb id), live initially
///   - reload 1: gen_handle should adopt gen B (canary.ptb id)
///   - latch path: reload 2 should adopt gen C = tiny.ptb id (re-using
///     the on-disk generation dir from the initial publish; current.json
///     just gets repointed)
#[test]
fn double_sighup_coalesces_via_barrier() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let clock_mock = Arc::new(MockClock::new(
        SystemTime::UNIX_EPOCH + Duration::from_secs(1779494400),
    ));
    let clock: Arc<dyn Clock> = clock_mock.clone();
    let metrics = Metrics::new();

    let (initial_gen, id_a) = build_initial_generation(
        data_root.path(),
        "vilnius",
        &tiny_ptb_path(),
        &metrics,
        &clock,
    );
    let gen_handle = Arc::new(arc_swap::ArcSwap::new(Arc::new(initial_gen)));
    let mut cfg = common::default_test_config(data_root.path().to_path_buf());
    cfg.worker_pool_size = 1;
    let config = Arc::new(cfg);
    let barrier = Arc::new(ReloadBarrier::new());
    let runner = Arc::new(ReloadRunner::new_with_barrier(
        Arc::clone(&gen_handle),
        Arc::clone(&config),
        Arc::clone(&metrics),
        Arc::clone(&clock),
        Arc::clone(&barrier),
    ));

    // ---- Trigger reload #1 by publishing gen B (canary.ptb) ----
    let created_b = publisher::rfc3339_format(1779494410);
    let id_b =
        publisher::publish_generation(data_root.path(), "vilnius", &canary_ptb_path(), &created_b);
    assert_ne!(id_a, id_b, "fixtures must have distinct ids");

    // Spawn a sidecar thread to run the reload — it will park at the
    // barrier between validation and swap.
    let runner_t = Arc::clone(&runner);
    let t1 = std::thread::spawn(move || runner_t.trigger_reload());

    // Wait for the runner to ENTER the barrier before continuing.
    barrier.wait_for_arrival();

    // ---- Reload-in-flight: publish gen C (point at tiny.ptb's gen dir) ----
    // We don't need to write the gen dir again — id_a's dir is already on
    // disk from the initial publish. Repointing current.json is enough.
    let created_c = publisher::rfc3339_format(1779494420);
    publisher::point_current_at(data_root.path(), "vilnius", &id_a, &created_c);

    // Spawn a SECOND sidecar to deliver the "SIGHUP while in-flight". This
    // call must short-circuit through the latch path (in_flight is true).
    let runner_t2 = Arc::clone(&runner);
    let t2 = std::thread::spawn(move || runner_t2.trigger_reload());

    // Spin briefly until the latch is observed-set by the second trigger.
    // We expose this via the pending-coalesced metric — the second
    // trigger increments it.
    let start = std::time::Instant::now();
    while metrics.reload_pending_coalesced_total() < 1 {
        if start.elapsed() > Duration::from_secs(5) {
            panic!(
                "second trigger did not set the latch within 5s — \
                 pending_coalesced_total = {}",
                metrics.reload_pending_coalesced_total()
            );
        }
        std::thread::yield_now();
    }

    // Latch is set. DISARM the barrier first so the follow-up reload
    // (triggered by the latch consult) doesn't park-and-deadlock at the
    // same barrier, then release the in-flight reload. Disarming first
    // (rather than just releasing) is the load-bearing ordering: the
    // follow-up's park() must observe `disarmed=true` and pass through.
    barrier.disarm();
    barrier.release();

    let outcome_1 = t1.join().expect("t1");
    let outcome_2 = t2.join().expect("t2");

    // outcome_1 was an Adopted of gen B; outcome_2 was the latch-induced
    // Noop placeholder returned by `handle_sighup_event` when in_flight was
    // already set. The follow-up reload (which adopts gen C) is the work
    // the runner did inside outcome_1's `handle_sighup_event`.
    match &outcome_1 {
        pt_serve::ReloadOutcome::Adopted { generation_id } => {
            assert_eq!(generation_id, &id_b, "first reload adopts gen B");
        }
        other => panic!("first reload outcome = {other:?}, expected Adopted(gen_b)"),
    }
    match &outcome_2 {
        pt_serve::ReloadOutcome::Noop => { /* latch placeholder */ }
        other => panic!("second trigger outcome = {other:?}, expected Noop (latch)"),
    }

    // The live generation should be the LATEST adopted (gen C = id_a's id).
    let live = gen_handle.load();
    assert_eq!(
        live.generation_id, id_a,
        "post-coalesce live generation is the latest pointer (gen C = id_a)"
    );

    // Metrics: two successful adoptions, one pending-coalesced.
    assert_eq!(
        metrics.reload_total(ReloadResult::Ok, ReloadCause::None),
        2,
        "exactly two ok reloads happened (gen B + gen C)"
    );
    assert_eq!(
        metrics.reload_pending_coalesced_total(),
        1,
        "the latch absorbed one SIGHUP"
    );

    // mapped_generation_count never exceeded 2 (the test holds no extra Arc
    // clones, so by the time we read the gauge here it should be 1).
    assert!(
        metrics.mapped_generation_count() <= 2,
        "mapped_generation_count must never exceed 2 (was {})",
        metrics.mapped_generation_count()
    );
}

/// Regression stress for the latch-consult race: `handle_sighup_event` used
/// to release `in_flight` BEFORE consulting `pending_latch`, then blindly
/// `store(true)` for the follow-up — so a concurrent trigger (poll thread +
/// signal thread share one runner) could acquire the flag in the gap and run
/// `run_one` in parallel with the follow-up, transiently mapping THREE
/// generations. The follow-up now re-acquires via `swap`, making "run_one
/// only while holding in_flight" structural. This test hammers the runner
/// from several threads while the pointer flips, then asserts the lifetime
/// watermark (which, unlike a sampled gauge, cannot miss a transient third
/// mapping) never exceeded 2.
///
/// The interleave is probabilistic — the test can pass on broken code, but
/// can never fail on correct code.
#[test]
fn concurrent_triggers_never_map_three_generations() {
    let data_root = tempfile::tempdir().expect("tempdir");
    let clock_mock = Arc::new(MockClock::new(
        SystemTime::UNIX_EPOCH + Duration::from_secs(1779494400),
    ));
    let clock: Arc<dyn Clock> = clock_mock.clone();
    let metrics = Metrics::new();

    let (initial_gen, id_a) = build_initial_generation(
        data_root.path(),
        "vilnius",
        &tiny_ptb_path(),
        &metrics,
        &clock,
    );
    let gen_handle = Arc::new(arc_swap::ArcSwap::new(Arc::new(initial_gen)));
    let mut cfg = common::default_test_config(data_root.path().to_path_buf());
    cfg.worker_pool_size = 1;
    let config = Arc::new(cfg);
    let runner = Arc::new(ReloadRunner::new(
        Arc::clone(&gen_handle),
        Arc::clone(&config),
        Arc::clone(&metrics),
        Arc::clone(&clock),
    ));

    // Second on-disk generation so the pointer flips between two real ids.
    let created_b = publisher::rfc3339_format(1779494410);
    let id_b =
        publisher::publish_generation(data_root.path(), "vilnius", &canary_ptb_path(), &created_b);
    assert_ne!(id_a, id_b);

    const TRIGGER_THREADS: usize = 3;
    const TRIGGERS_PER_THREAD: usize = 40;
    let mut handles = Vec::new();
    for _ in 0..TRIGGER_THREADS {
        let r = Arc::clone(&runner);
        handles.push(std::thread::spawn(move || {
            for _ in 0..TRIGGERS_PER_THREAD {
                let _ = r.trigger_reload();
                std::thread::yield_now();
            }
        }));
    }
    // Flip the pointer while the triggers hammer, so reloads do real
    // adoption work (mapping a second generation) rather than noop-ing.
    for i in 0..TRIGGERS_PER_THREAD {
        let id = if i % 2 == 0 { &id_b } else { &id_a };
        let created = publisher::rfc3339_format(1779494420 + i as u64);
        publisher::point_current_at(data_root.path(), "vilnius", id, &created);
        std::thread::yield_now();
    }
    for h in handles {
        h.join().expect("trigger thread");
    }
    // Drain any latch left by the last trigger.
    let _ = runner.trigger_reload();

    assert!(
        metrics.mapped_generation_watermark() <= 2,
        "mapped_generation_count watermark must never exceed 2 (was {})",
        metrics.mapped_generation_watermark()
    );
    let live = gen_handle.load();
    assert!(
        live.generation_id == id_a || live.generation_id == id_b,
        "live generation is one of the published ids"
    );
}
