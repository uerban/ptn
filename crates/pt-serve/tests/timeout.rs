//! Transport-enforced request timeout integration tests.
//!
//! These tests pair a real [`pt_serve::WorkerPool`] with the timeout
//! [`pt_serve::TimeoutRegistry`] watchdog. They drive requests over a real
//! TCP socket so the full chain — accept → dispatch → register → watchdog
//! flips `timed_out` → worker drops `Request` — is exercised end-to-end.
//!
//! ## Test matrix
//!
//! 1. **Stalled request past `request_timeout_ms` is force-closed**. The
//!    park endpoint blocks until the watchdog flips the slot's `timed_out`
//!    flag; the dispatcher drops the `Request` without calling `respond`;
//!    `request_timeouts_total` increments by exactly 1; the client sees an
//!    EOF (no HTTP status line ever arrives).
//!
//! 2. **Timed-out worker serves subsequent requests normally**. After the
//!    stalled request resolves, a fresh `GET /health` against the same pool
//!    returns 200 — the worker did not exit, the inflight gauge returned to
//!    0, and the watchdog did not leak any state.
//!
//! 3. **Timed-out request holding the old generation does NOT block
//!    retirement** (rev 3). Park a request on gen A, swap to gen B via the
//!    reload runner, let the parked request time out, and assert:
//!    - `inflight_requests` returns to 0,
//!    - `generation_retired_total` == 1 (gen A retired),
//!    - `mapped_generation_count` == 1 (only gen B alive).
//!
//! 4. **Slow-reader (server-side timeout fires)**. Adapts the spec's
//!    "1 byte/sec" framing to what tiny_http permits: a TCP client connects
//!    but never sends a complete request line. The watchdog cannot fire on
//!    this client (tiny_http hasn't produced a Request yet), so this test
//!    PARKS a normal request and verifies the server-side dwell counter
//!    fires (the realistic semantic that pt-serve's watchdog can enforce).
//!    The "tiny_http internally drops a half-read connection" path is
//!    covered by tiny_http's own tests.
//!
//! ## Why we don't use tiny_http socket timeouts
//!
//! tiny_http 0.12's public API does not expose the accepted `TcpStream`
//! before the worker receives the `Request`, so we cannot call
//! `set_read_timeout` / `set_write_timeout` on the per-request socket. The
//! watchdog (`crate::ops::timeout`) is the only deadline enforcement
//! mechanism available — see the doc-comment on that module for the full
//! rationale.

#![cfg(feature = "test-park")]

use pt_serve::{Generation, Metrics, ServerCtx, WorkerPool};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[path = "common/mod.rs"]
mod common;

use common::publisher;
use pt_shared::clock::{Clock, MockClock};
use std::time::SystemTime;

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

fn canary_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/canary.ptb")
}

/// Fire a basic GET against `addr` over a raw TCP socket. Returns the
/// response status code, or `None` if the connection closed before a
/// status-line arrived (a timed-out request).
fn http_get_status(addr: SocketAddr, path: &str, read_timeout: Duration) -> Option<u16> {
    let mut stream = TcpStream::connect(addr).ok()?;
    stream.set_read_timeout(Some(read_timeout)).ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .ok()?;
    write!(
        stream,
        "GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )
    .ok()?;
    stream.flush().ok()?;
    let mut buf = Vec::with_capacity(256);
    let _ = stream.read_to_end(&mut buf);
    let text = std::str::from_utf8(&buf).ok()?;
    let first_line = text.lines().next()?;
    first_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
}

/// Poll until the listener responds (any status) or deadline expires.
fn wait_for_listener(addr: SocketAddr, path: &str, deadline: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < deadline {
        if http_get_status(addr, path, Duration::from_secs(2)).is_some() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}

/// Spawn a thread that fires `GET path` against the pool and returns the
/// thread's join handle. The thread captures the status (or `None` on a
/// closed connection) so the test can assert on it.
fn spawn_get_thread(
    addr: SocketAddr,
    path: &'static str,
    read_timeout: Duration,
) -> std::thread::JoinHandle<Option<u16>> {
    std::thread::spawn(move || http_get_status(addr, path, read_timeout))
}

/// Build a [`ServerCtx`] over the committed `tiny.ptb` fixture using
/// `Generation::from_paths`. Returns the temp dir (whose Drop deletes the
/// pidfile parent) + the ctx + the shared metrics surface.
fn ctx_over_tiny() -> (tempfile::TempDir, Arc<ServerCtx>, Arc<Metrics>) {
    let (dir, mut config, _clock) = common::isolated_config();
    // Short timeout so the watchdog fires quickly in tests.
    config.request_timeout_ms = 250;
    let gen = Generation::from_paths(
        &tiny_ptb_path(),
        None,
        "vilnius".to_string(),
        pt_core::PatternMode::Off,
    )
    .expect("Generation::from_paths");
    let metrics = Metrics::new();
    let ctx = ServerCtx::new(gen, config, Arc::clone(&metrics));
    (dir, ctx, metrics)
}

fn join_with_outer_timeout(pool: WorkerPool, _drain_timeout: Duration, outer: Duration) {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        pool.join();
        let _ = tx.send(());
    });
    match rx.recv_timeout(outer) {
        Ok(()) => {}
        Err(_) => panic!("WorkerPool::join did not return within {outer:?}"),
    }
}

/// Test 1 + 4 combined: park a request, watchdog fires after the deadline,
/// dispatcher drops the connection without responding, counter ++. This
/// covers both the "stalled past deadline" assertion and the slow-reader
/// outcome (the worker's response write is never attempted, so the watchdog
/// is the sole arbiter of the deadline — same effect as a slow client
/// where the worker would block on a write).
#[test]
fn stalled_request_past_deadline_is_force_closed_and_counter_increments() {
    let (_dir, ctx, metrics) = ctx_over_tiny();
    // Use 2 workers so a parked request doesn't block the watchdog's
    // observability path (test calls /metrics on the aux listener in
    // parallel — though that's served by the aux worker anyway).
    let pool = WorkerPool::new_with_timeout(
        "127.0.0.1:0",
        "127.0.0.1:0",
        2,
        Arc::clone(&ctx),
        Duration::from_millis(250), // request_timeout
        Duration::from_millis(20),  // watchdog scan
    )
    .expect("WorkerPool::new_with_timeout");
    let main_addr = pool.main_addr();
    assert!(wait_for_listener(
        main_addr,
        "/health",
        Duration::from_secs(3)
    ));

    let pre_count = metrics.request_timeouts_total();
    let h = spawn_get_thread(main_addr, "/test/park", Duration::from_secs(5));

    // Wait for the parked request to register in the watchdog. Bounded
    // by a 1s deadline; the worker should pick it up well inside ~100ms.
    let reg = pool.timeout_registry();
    let park_deadline = Instant::now() + Duration::from_secs(1);
    while reg.is_empty() && Instant::now() < park_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        reg.len(),
        1,
        "parked request must show up in the timeout registry"
    );

    // Wait for the watchdog to fire + the dispatcher to drop the request
    // (which clears the registry slot via TimeoutTicket::Drop).
    let close_deadline = Instant::now() + Duration::from_secs(2);
    while reg.len() == 1 && Instant::now() < close_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        reg.len(),
        0,
        "watchdog must have closed the slot once the dispatcher drops the request"
    );

    // Counter increments by exactly 1.
    let post_count = metrics.request_timeouts_total();
    assert_eq!(
        post_count - pre_count,
        1,
        "request_timeouts_total must increment exactly once per timed-out request"
    );

    // Client side: the connection closed without a status line (no HTTP
    // response was sent because dispatcher dropped the Request without
    // respond()). tiny_http's Request::Drop may still emit an empty 500
    // depending on timing of the underlying socket — accept either outcome
    // (None or 500), but NOT a 200.
    let client_status = h.join().expect("join client thread");
    assert!(
        client_status.is_none() || client_status == Some(500),
        "expected dropped-connection (None) or empty 500 from Request::Drop, got {client_status:?}"
    );

    // Inflight gauge returns to 0 — the InflightGuard's Drop fires on the
    // dispatch frame's return (regardless of whether respond was called).
    let inflight_deadline = Instant::now() + Duration::from_millis(500);
    while metrics.inflight_requests() != 0 && Instant::now() < inflight_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        metrics.inflight_requests(),
        0,
        "inflight_requests must drop to 0 after the timed-out request returns"
    );

    pool.stop_accepting();
    join_with_outer_timeout(pool, Duration::from_secs(1), Duration::from_secs(5));
}

/// Test 2: after a request times out, the SAME worker pool serves the next request normally. Guards
/// against a watchdog regression that wedges the pool (e.g. a stuck inflight gauge leading to a
/// phantom drain).
#[test]
fn timed_out_worker_serves_subsequent_requests_normally() {
    let (_dir, ctx, metrics) = ctx_over_tiny();
    let pool = WorkerPool::new_with_timeout(
        "127.0.0.1:0",
        "127.0.0.1:0",
        1, // single worker — the SAME thread serves both requests
        Arc::clone(&ctx),
        Duration::from_millis(200),
        Duration::from_millis(20),
    )
    .expect("WorkerPool::new_with_timeout");
    let main_addr = pool.main_addr();
    assert!(wait_for_listener(
        main_addr,
        "/health",
        Duration::from_secs(3)
    ));

    // Fire a parked request and wait for it to time out.
    let h = spawn_get_thread(main_addr, "/test/park", Duration::from_secs(5));
    let reg = pool.timeout_registry();
    let timed_out_deadline = Instant::now() + Duration::from_secs(2);
    while metrics.request_timeouts_total() == 0 && Instant::now() < timed_out_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(metrics.request_timeouts_total(), 1);
    let _ = h.join();
    // Let the dispatcher unwind and clear the slot.
    let slot_clear_deadline = Instant::now() + Duration::from_secs(1);
    while !reg.is_empty() && Instant::now() < slot_clear_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(reg.is_empty(), "registry slot cleared after timeout");

    // Subsequent /health returns 200 — the worker did not die.
    assert_eq!(
        http_get_status(main_addr, "/health", Duration::from_secs(2)),
        Some(200),
        "worker must continue serving after a timeout"
    );

    pool.stop_accepting();
    join_with_outer_timeout(pool, Duration::from_secs(1), Duration::from_secs(5));
}

/// Build a [`ServerCtx`] with metrics-attached generations via the publisher
/// pipeline, so `mapped_generation_count` and `generation_retired_total`
/// observe Drop. The runner is hot-wired to the same data_root so the test
/// can call `runner.trigger_reload()` to swap generations.
struct ReloadHarness {
    data_root: tempfile::TempDir,
    ctx: Arc<ServerCtx>,
    metrics: Arc<Metrics>,
    gen_handle: Arc<arc_swap::ArcSwap<Generation>>,
    runner: Arc<pt_serve::ReloadRunner>,
    initial_id: String,
}

fn ctx_with_reload_runner() -> ReloadHarness {
    // Anchor the mock clock at a time the metadata validator accepts as
    // "now" — same recipe as tests/reload.rs::build_harness.
    let clock = Arc::new(MockClock::new(
        SystemTime::UNIX_EPOCH + Duration::from_secs(1779494400),
    ));
    let data_root = tempfile::tempdir().expect("tempdir");
    let created_at = publisher::rfc3339_format(1779494400);
    let initial_id =
        publisher::publish_generation(data_root.path(), "vilnius", &tiny_ptb_path(), &created_at);

    let manifest_text =
        std::fs::read_to_string(publisher::manifest_path_for(data_root.path(), &initial_id))
            .expect("read manifest");
    let manifest: pt_shared::manifest::GenerationManifest =
        serde_json::from_str(&manifest_text).expect("parse manifest");
    let metrics = Metrics::new();
    let clock_dyn: Arc<dyn Clock> = clock.clone();
    let initial = pt_serve::bundle::build_generation(pt_serve::bundle::BuildInputs {
        manifest: &manifest,
        bundle_path: &publisher::bundle_path_for(data_root.path(), &initial_id),
        transfers_path: None,
        expected_city: "vilnius",
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

    let mut cfg = common::default_test_config(data_root.path().to_path_buf());
    cfg.city_slug = "vilnius".to_string();
    cfg.worker_pool_size = 2;
    cfg.request_timeout_ms = 250;
    let ctx = ServerCtx::new(initial, cfg, Arc::clone(&metrics));
    let gen_handle = Arc::clone(&ctx.gen_handle);
    let runner = Arc::new(pt_serve::ReloadRunner::new(
        Arc::clone(&gen_handle),
        Arc::clone(&ctx.config),
        Arc::clone(&metrics),
        clock_dyn,
    ));
    ReloadHarness {
        data_root,
        ctx,
        metrics,
        gen_handle,
        runner,
        initial_id,
    }
}

/// Test 3 (rev 3): a timed-out request holding the old generation must NOT
/// block retirement. After the watchdog fires:
///   - inflight_requests → 0
///   - generation_retired_total == 1 (gen A retired)
///   - mapped_generation_count == 1 (only gen B alive)
#[test]
fn timed_out_request_holding_old_gen_does_not_block_retirement() {
    let harness = ctx_with_reload_runner();
    // Pool with 2 workers so the parked request doesn't starve the rest of
    // the pool while we set up the reload from the test thread.
    let pool = WorkerPool::new_with_timeout(
        "127.0.0.1:0",
        "127.0.0.1:0",
        2,
        Arc::clone(&harness.ctx),
        Duration::from_millis(250),
        Duration::from_millis(20),
    )
    .expect("WorkerPool::new_with_timeout");
    let main_addr = pool.main_addr();
    assert!(wait_for_listener(
        main_addr,
        "/health",
        Duration::from_secs(3)
    ));
    assert_eq!(
        harness.metrics.mapped_generation_count(),
        1,
        "startup: one generation alive"
    );

    // Step 1: park a request on gen A. The dispatcher's `ctx.current_generation()`
    // call snapshots an `Arc<Generation>` for gen A — this pin keeps gen A
    // alive across the upcoming swap.
    let h = spawn_get_thread(main_addr, "/test/park", Duration::from_secs(10));
    let reg = pool.timeout_registry();
    let park_deadline = Instant::now() + Duration::from_secs(1);
    while reg.is_empty() && Instant::now() < park_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(reg.len(), 1, "request parked on gen A");

    // Step 2: publish gen B (canary fixture), trigger reload.
    let created_at_b = publisher::rfc3339_format(1779494410);
    let new_id = publisher::publish_generation(
        harness.data_root.path(),
        "vilnius",
        &canary_ptb_path(),
        &created_at_b,
    );
    assert_ne!(
        harness.initial_id, new_id,
        "canary must have distinct SHA-256"
    );
    let outcome = harness.runner.trigger_reload();
    assert!(
        outcome.is_adopted(),
        "reload must adopt gen B; outcome = {outcome:?}"
    );
    // gen B is live AND gen A is still pinned by the parked request.
    assert_eq!(
        harness.metrics.mapped_generation_count(),
        2,
        "during park: gen A (pinned) + gen B (current)"
    );
    assert_eq!(
        harness.metrics.generation_retired_total(),
        0,
        "no retirement until the parked request releases gen A"
    );
    // Sanity: the gen_handle now points at gen B.
    assert_eq!(harness.gen_handle.load().generation_id, new_id);

    // Step 3: let the parked request time out. The watchdog fires; the
    // dispatcher drops the Request; the dispatch frame returns and the
    // `Arc<Generation>` clone for gen A drops with it. Gen A retires.
    let retired_deadline = Instant::now() + Duration::from_secs(3);
    while harness.metrics.generation_retired_total() == 0 && Instant::now() < retired_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = h.join();

    // Final assertions: rev 3 trio.
    assert_eq!(
        harness.metrics.inflight_requests(),
        0,
        "inflight_requests must drop to 0 once the timed-out request returns"
    );
    assert_eq!(
        harness.metrics.generation_retired_total(),
        1,
        "gen A must retire once its last pinning Arc drops"
    );
    assert_eq!(
        harness.metrics.mapped_generation_count(),
        1,
        "only gen B remains alive after gen A retires"
    );

    pool.stop_accepting();
    join_with_outer_timeout(pool, Duration::from_secs(1), Duration::from_secs(5));
}

/// Test 4: slow-reader / slow-writer variant. The "1 byte/sec" framing in
/// the spec is the realistic case where a client never pulls bytes off the
/// wire after sending a request. tiny_http does not expose the accepted
/// stream to consumer code, so we cannot enforce SO_RCVTIMEO/SO_SNDTIMEO
/// from outside; what we CAN do is verify the watchdog detects + counts
/// the timeout. We model the test by:
///   1. spawning a TCP client that connects, sends a valid GET, then sits
///      idle (consuming nothing) — the server-side write may or may not
///      block depending on TCP buffer sizes.
///   2. asserting `request_timeouts_total` increments when the dwell
///      exceeds `request_timeout_ms`.
///   3. asserting subsequent /health calls work — the worker recovered.
#[test]
fn slow_reader_client_trips_request_timeouts_counter() {
    let (_dir, ctx, metrics) = ctx_over_tiny();
    let pool = WorkerPool::new_with_timeout(
        "127.0.0.1:0",
        "127.0.0.1:0",
        2,
        Arc::clone(&ctx),
        Duration::from_millis(200),
        Duration::from_millis(20),
    )
    .expect("WorkerPool::new_with_timeout");
    let main_addr = pool.main_addr();
    assert!(wait_for_listener(
        main_addr,
        "/health",
        Duration::from_secs(3)
    ));

    let pre = metrics.request_timeouts_total();

    // Open a TCP connection, send the request, but never read the
    // response. The kernel TCP buffer is large enough on macOS/Linux
    // that a small response will land in the socket buffer immediately
    // — the watchdog flips `timed_out` either way. For a /test/park
    // route, the worker is in the park loop and never gets to respond,
    // so the watchdog is the sole arbiter of the deadline (which is the
    // canonical "slow consumer" enforcement path).
    let mut stream = TcpStream::connect(main_addr).expect("connect");
    write!(
        stream,
        "GET /test/park HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )
    .expect("write request line");
    stream.flush().expect("flush");

    // Wait for the counter to fire. Bounded by deadline + scan interval.
    let counter_deadline = Instant::now() + Duration::from_secs(2);
    while metrics.request_timeouts_total() == pre && Instant::now() < counter_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        metrics.request_timeouts_total() - pre,
        1,
        "watchdog must count one timeout from the slow-reader client"
    );

    // Close the client — drop the stream — and verify the worker pool
    // still serves a fresh request (the slow-reader did not wedge it).
    drop(stream);
    let serve_deadline = Instant::now() + Duration::from_secs(2);
    let mut ok = false;
    while !ok && Instant::now() < serve_deadline {
        if http_get_status(main_addr, "/health", Duration::from_secs(1)) == Some(200) {
            ok = true;
        } else {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    assert!(
        ok,
        "worker pool must serve subsequent requests after a slow-reader timeout"
    );

    pool.stop_accepting();
    join_with_outer_timeout(pool, Duration::from_secs(1), Duration::from_secs(5));
}
