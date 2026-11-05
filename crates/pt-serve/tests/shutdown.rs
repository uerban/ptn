//! Two-stage SIGTERM drain integration tests.
//!
//! Drives the [`pt_serve::DrainController`] end-to-end over a real
//! [`pt_serve::WorkerPool`] backed by the committed `tiny.ptb` fixture.
//! Tests bypass actual signal delivery — the controller's
//! `initiate_drain()` is the seam, and the SIGTERM-typed dispatch path is
//! covered by `tests/reload.rs` (the reload runner installs the signal
//! handler and sets the shutdown flag; this test starts from "shutdown
//! flag observed", i.e. the controller's entry point).
//!
//! ## Test matrix
//!
//! 1. **Normal drain**: SIGTERM with one in-flight request. During the
//!    `prestop_grace` window, `/ready` returns 503 (LB drain signal);
//!    in-flight request completes within `prestop_grace + request_timeout`;
//!    `DrainOutcome.exit_code == 0`; stage timestamps are well-ordered.
//!
//! 2. **Forced drain (parked request)**: SIGTERM while a `/test/park` request is wedged.
//!
//! ## Why no slow-reader test today
//!
//! The "1 byte/sec TCP slow reader" framing the spec sketches would require interleaving a per-byte
//! `Write::write` on a background thread with the drain trigger. tiny_http does not expose the
//! per-request `TcpStream`, so we cannot inject a slow-writer at the response side; the test would
//! degenerate into "park a request and observe the watchdog fires", which is exactly what
//! `forced_drain_with_parked_request` already covers. The literal-bytes-per-second variant is
//! deferred to the topology-integration suite (it'll be a smoketest harness against the real nginx
//! → pt-serve plumbing, not an in-process test).

use pt_serve::{DrainController, Generation, Metrics, ServerCtx, WorkerPool};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[path = "common/mod.rs"]
mod common;

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

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

/// Like `http_get_status` but also returns the response body text (the
/// portion after the blank line separating headers from body).
fn http_get_status_and_body(
    addr: SocketAddr,
    path: &str,
    read_timeout: Duration,
) -> Option<(u16, String)> {
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
    // Split on the blank line separating headers from body.
    let (header_part, body) = text.split_once("\r\n\r\n").unwrap_or((text, ""));
    let status: u16 = header_part
        .lines()
        .next()?
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())?;
    Some((status, body.to_string()))
}

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

/// Build a `ServerCtx` over the committed `tiny.ptb` fixture, paired
/// with a fresh `Arc<Metrics>` so each test isolates its assertions.
/// Returns `(TempDir, ServerCtx, Metrics)`; the TempDir's Drop cleans up
/// the per-test pidfile parent.
fn ctx_over_tiny() -> (tempfile::TempDir, Arc<ServerCtx>, Arc<Metrics>) {
    let (dir, mut config, _clock) = common::isolated_config();
    // 250ms per-request timeout — the watchdog fires at this bound for
    // forced-drain tests. The drain controller pairs `drain_timeout` to
    // the same value, so total drain bound is
    // `prestop_grace + 250ms + ~100ms recv_timeout`.
    config.request_timeout_ms = 250;
    config.prestop_grace_secs = 0; // tests override per-case with `Duration::from_millis(...)`
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

/// Wrap `DrainController::initiate_drain` with an outer wall-clock
/// deadline: a regression that wedges drain would otherwise hang the
/// test binary indefinitely. Returns the outcome (or panics on outer
/// timeout — which we explicitly want as a test failure).
fn drain_with_outer_timeout(
    controller: DrainController,
    outer: Duration,
) -> pt_serve::DrainOutcome {
    let (tx, rx) = std::sync::mpsc::channel::<pt_serve::DrainOutcome>();
    std::thread::spawn(move || {
        let outcome = controller.initiate_drain();
        let _ = tx.send(outcome);
    });
    rx.recv_timeout(outer).unwrap_or_else(|_| {
        panic!("DrainController::initiate_drain did not return within {outer:?}")
    })
}

/// **Test 1 — Normal drain**. One in-flight request completes during the
/// preStop window. The drain controller flips /ready to 503 immediately;
/// during the 200ms grace window, `/ready` already reads 503; the
/// in-flight `/health` returns 200; the drain returns `exit_code: 0`.
#[test]
fn normal_drain_flips_ready_503_then_completes_and_exits_zero() {
    let (_dir, ctx, metrics) = ctx_over_tiny();
    let pool = WorkerPool::new("127.0.0.1:0", "127.0.0.1:0", 2, Arc::clone(&ctx))
        .expect("WorkerPool::new");
    let main_addr = pool.main_addr();
    let aux_addr = pool.aux_addr();
    assert!(wait_for_listener(
        main_addr,
        "/health",
        Duration::from_secs(3)
    ));
    assert!(wait_for_listener(
        aux_addr,
        "/ready",
        Duration::from_secs(3)
    ));

    // Sanity: pre-drain, /ready is 200 and the flag is unset.
    assert_eq!(
        http_get_status(aux_addr, "/ready", Duration::from_secs(2)),
        Some(200)
    );
    assert!(!metrics.ready_503(), "ready_503 flag default is false");

    // Spawn the drain on a background thread with a 200ms grace. The
    // foreground thread will, during the grace window, hit /ready and
    // observe the 503 — proving stage 1 fired immediately.
    let metrics_for_drain = Arc::clone(&metrics);
    let controller = DrainController::new(
        pool,
        metrics_for_drain,
        Duration::from_millis(200),
        Duration::from_millis(250),
    );
    let drain_handle = std::thread::spawn(move || controller.initiate_drain());

    // Wait for ready_503 to flip (bounded ≤ 300ms; in practice ~milliseconds).
    let flip_deadline = Instant::now() + Duration::from_millis(300);
    while !metrics.ready_503() && Instant::now() < flip_deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        metrics.ready_503(),
        "stage 1: ready_503 must flip immediately"
    );

    // During the grace window, hit /ready over the wire — it MUST return
    // 503 even though the listener is still accepting. This is the LB
    // signal that drains the pool.
    assert_eq!(
        http_get_status(aux_addr, "/ready", Duration::from_secs(2)),
        Some(503),
        "stage 2 (grace window): /ready must return 503 to drain the LB"
    );
    // /health is unchanged — it's not part of the drain story.
    assert_eq!(
        http_get_status(main_addr, "/health", Duration::from_secs(2)),
        Some(200),
        "stage 2 (grace window): listener still accepts; /health 200"
    );

    // Wait for drain to complete. Outer bound: grace + request_timeout +
    // recv_timeout slack. Generous so a CI scheduler hiccup doesn't false-fail.
    let outcome = drain_handle.join().expect("drain handle joined cleanly");
    assert_eq!(outcome.exit_code, 0, "normal drain must report exit_code=0");

    // Sequencing: stage_1 < stage_3 < stage_4.
    assert!(
        outcome.stage_3_stop_accepting_at >= outcome.stage_1_ready_503_at,
        "stage_3 must be after stage_1"
    );
    assert!(
        outcome.stage_4_join_complete_at >= outcome.stage_3_stop_accepting_at,
        "stage_4 must be after stage_3"
    );
    let grace_observed = outcome
        .stage_3_stop_accepting_at
        .saturating_duration_since(outcome.stage_1_ready_503_at);
    assert!(
        grace_observed >= Duration::from_millis(180) && grace_observed < Duration::from_millis(600),
        "stage_1→stage_3 should be ~prestop_grace (200ms); got {grace_observed:?}"
    );
    // Total duration is bounded above by grace + request_timeout + slack.
    assert!(
        outcome.total_duration < Duration::from_millis(200 + 250 + 1500),
        "total drain duration too long: {:?}",
        outcome.total_duration
    );
}

/// **Test 2 — Forced drain (parked request)**. With a `/test/park`
/// request wedged in a worker, drain takes longer than the natural
/// path — the watchdog must fire at `request_timeout` to release the
/// worker. The drain reports `exit_code: 0` because timeout-induced
/// drain is the watchdog working AS DESIGNED.
#[cfg(feature = "test-park")]
#[test]
fn forced_drain_with_parked_request_exits_zero() {
    let (_dir, ctx, metrics) = ctx_over_tiny();
    let pool = WorkerPool::new_with_timeout(
        "127.0.0.1:0",
        "127.0.0.1:0",
        2,
        Arc::clone(&ctx),
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

    // Park a request — wedges one worker until the watchdog fires.
    let park_handle = std::thread::spawn(move || {
        // Read timeout generous enough that we observe the closed-by-drop
        // outcome (None) rather than our own read timeout firing first.
        http_get_status(main_addr, "/test/park", Duration::from_secs(5))
    });

    // Wait for the parked request to register with the watchdog.
    let reg = pool.timeout_registry();
    let park_deadline = Instant::now() + Duration::from_secs(1);
    while reg.is_empty() && Instant::now() < park_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(reg.len(), 1, "parked request must be registered");

    // Trigger drain. prestop_grace=100ms, request_timeout=250ms — so
    // the bounded join must complete within ~350ms after stage_3.
    let pre_timeouts = metrics.request_timeouts_total();
    let metrics_for_drain = Arc::clone(&metrics);
    let controller = DrainController::new(
        pool,
        metrics_for_drain,
        Duration::from_millis(100),
        Duration::from_millis(250),
    );
    let outcome = drain_with_outer_timeout(controller, Duration::from_secs(5));

    // Forced drain reports exit_code 0 — the timeout watchdog firing is
    // a clean drain, NOT a failure.
    assert_eq!(
        outcome.exit_code, 0,
        "forced drain (parked request → watchdog) must report exit_code=0"
    );

    // The watchdog must have fired exactly once for the parked request.
    let post_timeouts = metrics.request_timeouts_total();
    assert_eq!(
        post_timeouts - pre_timeouts,
        1,
        "watchdog must increment request_timeouts_total once for the parked request"
    );

    // Drain bound holds: total < prestop_grace + request_timeout + slack.
    assert!(
        outcome.total_duration < Duration::from_millis(100 + 250 + 2000),
        "forced drain bound exceeded: total_duration={:?}",
        outcome.total_duration
    );

    // The client either saw a dropped connection (None) or an empty 500
    // from tiny_http's Request::Drop — both are valid forced-close
    // outcomes (matches the matrix in tests/timeout.rs).
    let client_status = park_handle.join().expect("park client thread joined");
    assert!(
        client_status.is_none() || client_status == Some(500),
        "parked client must see dropped (None) or 500, got {client_status:?}"
    );
}

/// **Test 3 — Slow-reader proxy**. The spec sketches a literal "1 byte/sec"
/// TCP slow reader; tiny_http does not expose the response-write socket
/// to consumer code, so we model the realistic equivalent: a request that
/// the worker is mid-handler on (here, parked) when drain fires. The
/// watchdog is the sole arbiter of the deadline; drain still exits 0.
///
/// This is intentionally a near-duplicate of `forced_drain_with_parked_request` — they exercise the
/// SAME machinery from slightly different angles. The literal-slow-reader is deferred to the
/// topology suite (where the real nginx → pt-serve plumbing is exercisable from outside the
/// process).
#[cfg(feature = "test-park")]
#[test]
fn slow_reader_proxy_forced_drain_exits_zero() {
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

    // Open a TCP connection, send the request, but never read the
    // response. This is the slow-reader pattern. The watchdog will fire
    // before any response could be written.
    let mut stream = TcpStream::connect(main_addr).expect("connect");
    write!(
        stream,
        "GET /test/park HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )
    .expect("write");
    stream.flush().expect("flush");

    // Wait for the request to be parked on the worker.
    let reg = pool.timeout_registry();
    let park_deadline = Instant::now() + Duration::from_secs(1);
    while reg.is_empty() && Instant::now() < park_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(reg.len(), 1, "slow-reader request must be parked");

    // Trigger drain. The watchdog will fire at 200ms; drain stage_4
    // unblocks; controller returns exit_code=0.
    let metrics_for_drain = Arc::clone(&metrics);
    let controller = DrainController::new(
        pool,
        metrics_for_drain,
        Duration::from_millis(100),
        Duration::from_millis(200),
    );
    let outcome = drain_with_outer_timeout(controller, Duration::from_secs(5));

    assert_eq!(
        outcome.exit_code, 0,
        "slow-reader forced drain must report exit_code=0"
    );
    assert!(
        outcome.total_duration < Duration::from_millis(100 + 200 + 2000),
        "slow-reader drain bound exceeded: total_duration={:?}",
        outcome.total_duration
    );

    // Close the slow-reader client.
    drop(stream);
}

/// **Test 4 — Drain without an in-flight request**. The empty case: drain
/// trips through all four stages cleanly. Confirms the controller doesn't
/// require any in-flight work to make progress and that the exit_code
/// path is wired even for the cheapest drain.
#[test]
fn drain_with_no_inflight_requests_exits_zero_fast() {
    let (_dir, ctx, metrics) = ctx_over_tiny();
    let pool = WorkerPool::new("127.0.0.1:0", "127.0.0.1:0", 2, Arc::clone(&ctx))
        .expect("WorkerPool::new");
    assert!(wait_for_listener(
        pool.main_addr(),
        "/health",
        Duration::from_secs(3)
    ));

    let controller = DrainController::new(
        pool,
        Arc::clone(&metrics),
        Duration::from_millis(50),
        Duration::from_millis(250),
    );
    let outcome = drain_with_outer_timeout(controller, Duration::from_secs(5));
    assert_eq!(outcome.exit_code, 0);
    // Empty drain bound: ~prestop_grace + recv_timeout slack.
    assert!(
        outcome.total_duration < Duration::from_millis(50 + 250 + 1500),
        "empty drain too slow: {:?}",
        outcome.total_duration
    );
    // After drain, the ready flag stays flipped (no recovery — production
    // never clears it).
    assert!(metrics.ready_503(), "ready_503 stays flipped post-drain");
}

/// **SHOULD 3 — 503 drain body omits `patternMode`**.
///
/// The `/ready` 503 body is a minimal `{"status":"draining","city":"..."}` —
/// it intentionally omits the readiness telemetry (including `patternMode`)
/// because workers may be mid-swap and the drain state is binary.
///
/// This test boots the real WorkerPool, triggers an in-process drain (without
/// a real SIGTERM — just flips `ready_503` directly via the metrics handle),
/// and asserts the 503 body has no `patternMode` key. A regression that adds
/// `patternMode` to the 503 body would cause this test to fail.
#[test]
fn drain_ready_503_body_omits_pattern_mode() {
    let (_dir, ctx, metrics) = ctx_over_tiny();
    let pool = WorkerPool::new("127.0.0.1:0", "127.0.0.1:0", 2, Arc::clone(&ctx))
        .expect("WorkerPool::new");
    let aux_addr = pool.aux_addr();
    assert!(wait_for_listener(
        aux_addr,
        "/ready",
        Duration::from_secs(3)
    ));

    // Flip ready_503 directly — same flag the DrainController sets at stage 1.
    metrics.set_ready_503();

    // Poll until the server responds 503 (it reads the flag on each request).
    let deadline = Instant::now() + Duration::from_millis(500);
    let mut got_503 = false;
    while Instant::now() < deadline {
        if let Some((503, _)) = http_get_status_and_body(aux_addr, "/ready", Duration::from_secs(1))
        {
            got_503 = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        got_503,
        "expected 503 from /ready after ready_503 flip within 500ms"
    );

    // Fetch the body and verify `patternMode` is absent.
    let (code, body) =
        http_get_status_and_body(aux_addr, "/ready", Duration::from_secs(1)).unwrap();
    assert_eq!(code, 503, "body: {body}");
    let v: serde_json::Value = serde_json::from_str(&body).expect("503 ready body must be JSON");
    assert!(
        v.get("patternMode").is_none(),
        "503 drain body must NOT contain patternMode; body: {body}"
    );
    // Sanity: the 503 body should still contain status and city.
    assert_eq!(v["status"], "draining", "body: {body}");
    assert_eq!(v["city"], "vilnius", "body: {body}");

    // Clean up — stop the pool without a full drain so the test exits promptly.
    drop(pool);
}
