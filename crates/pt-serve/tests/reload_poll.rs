//! Reload-poll unit-of-work tests.
//!
//! `poll_tick` watches `<data_root>/current.json`'s mtime and, when it
//! changes, funnels through the EXISTING `ReloadRunner::run_one()` — the same
//! path SIGHUP drives. There is intentionally no second `current.json` reader:
//! `run_one()` already no-ops on an unchanged pointer and records every reload
//! metric. These tests prove the mtime gate adopts a freshly-published
//! generation and is a no-op when the pointer hasn't moved.
//!
//! The harness's initial generation is built from `tiny.ptb`; the "new"
//! generation is published from `canary.ptb` so their `generation_id`s (the
//! bundle SHA-256) differ — the `assert_ne!` precondition below is what makes
//! the adoption assertion non-trivial.

#[path = "common/mod.rs"]
mod common;

use common::{canary_ptb_path, publisher, reload_harness};
use pt_serve::reload::poll::{poll_tick, run_poll_loop};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Mock-clock anchor the harness uses (NOT the unix epoch — epoch fails the
/// `createdAt`-skew validator). Published generations use anchored timestamps
/// the validator accepts.
const ANCHOR: u64 = common::RELOAD_HARNESS_ANCHOR;

#[test]
fn poll_tick_adopts_a_new_generation() {
    let h = reload_harness("vilnius");
    let initial_id = h.gen_handle.load().generation_id.clone();
    let last_mtime = AtomicU64::new(0);

    // First tick: `current.json` already points at the harness's initial
    // generation, so `run_one()` no-ops and `gen_handle` is unchanged. (The
    // mtime gate lets the tick through because `last_mtime` starts at 0; the
    // no-op is enforced by `run_one()`'s own pointer-unchanged classification,
    // not the mtime gate.)
    poll_tick(&h.runner, &h.data_root, &last_mtime);
    assert_eq!(
        h.gen_handle.load().generation_id,
        initial_id,
        "unchanged current.json must not swap"
    );

    // Publish a DIFFERENT generation (canary.ptb → distinct SHA-256) and
    // repoint current.json at it. `publish_generation` already rewrites
    // current.json; `point_current_at` re-stamps it so the mtime advances even
    // on filesystems with coarse mtime granularity.
    let created_at = publisher::rfc3339_format(ANCHOR + 60);
    let new_id =
        publisher::publish_generation(&h.data_root, "vilnius", &canary_ptb_path(), &created_at);
    publisher::point_current_at(&h.data_root, "vilnius", &new_id, &created_at);
    assert_ne!(
        new_id, initial_id,
        "harness (tiny) and published (canary) gens must have distinct ids"
    );

    // Second tick: current.json's mtime changed → trigger_reload runs → adopts.
    poll_tick(&h.runner, &h.data_root, &last_mtime);
    assert_eq!(
        h.gen_handle.load().generation_id,
        new_id,
        "poll must adopt the new generation"
    );
}

/// `run_poll_loop` must observe the runner's shutdown flag and let its thread
/// exit within a bounded time even mid-sleep — the 500 ms shutdown-slice
/// guarantees a long backoff interval can't delay SIGTERM shutdown. We run it
/// with a tiny interval, set the shutdown flag, and assert the spawned thread
/// `.join()`s well inside a 2 s bound.
#[test]
fn run_poll_loop_exits_on_shutdown() {
    let h = reload_harness("vilnius");
    // `run_poll_loop` takes `Arc<ReloadRunner>`; the harness hands back an
    // owned runner, so wrap it. `shutdown_flag()` clones the inner `Arc`, so
    // the flag we toggle here is the same one the loop reads.
    let runner = Arc::new(h.runner);
    let shutdown = runner.shutdown_flag();
    let data_root = h.data_root.clone();

    let handle = std::thread::spawn(move || {
        run_poll_loop(runner, data_root, Duration::from_millis(50));
    });

    // Let the loop spin through at least one tick + sleep slice, then ask it
    // to stop.
    std::thread::sleep(Duration::from_millis(100));
    shutdown.store(true, Ordering::SeqCst);

    // Join with a bound. There's no std `join_timeout`, so poll the handle's
    // finished-ness via a short spin; the shutdown slice is 500 ms so the
    // thread is expected to exit well within 2 s.
    let deadline = Instant::now() + Duration::from_secs(2);
    while !handle.is_finished() {
        if Instant::now() >= deadline {
            panic!("run_poll_loop did not exit within 2s of shutdown");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    handle.join().expect("poll loop thread panicked");

    // The harness's _tmp must outlive the loop (it holds the data_root); keep
    // it explicitly alive past the join.
    drop(h._tmp);
}
