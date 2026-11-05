//!
//! Constructs a real [`WorkerPool`] over a real [`ServerCtx`] anchored at a
//! generated tiny.ptb, then proves:
//!
//! 1. **Both listeners bind and accept**. A GET to `<main_addr>/health` and a
//!    GET to `<aux_addr>/metrics` both return 200 — the aux listener is
//!    discoverable on its own port.
//!
//! 2. **The new `ready_503` plumbing is observable end-to-end**. The aux listener's `/ready`
//! returns 200 by default; after `set_ready_503()` on the shared `Metrics`, the SAME route returns
//! 503.
//!
//! 3. **`stop_accepting()` + `join()` returns**. A pool that hangs on join
//!    would wedge the binary on SIGTERM — the test runs the join on a
//!    helper thread with an outer timeout so a regression surfaces as a
//!    failed test rather than a hung CI worker.

use pt_serve::{Generation, Metrics, ServerCtx, WorkerPool};
use std::io::Read;
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

/// Minimal HTTP/1.0 GET over a raw TCP socket — keeps the test free of an
/// HTTP client dep (ureq is already a dev-dep but encapsulates connection
/// behaviour we want to control here, especially for the join timing).
/// Returns the response status code, or `None` on any I/O error.
fn http_get_status(addr: SocketAddr, path: &str) -> Option<u16> {
    let mut stream = TcpStream::connect(addr).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .ok()?;
    use std::io::Write as _;
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

/// Poll until `http_get_status` returns `Some(_)` (any status — we just want
/// the listener to be live), or the deadline expires.
fn wait_for_listener(addr: SocketAddr, path: &str, deadline: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < deadline {
        if http_get_status(addr, path).is_some() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}

/// Build a `ServerCtx` over the committed tiny.ptb fixture. Shares the test
/// harness's `isolated_config` for everything else (ephemeral ports,
/// temporary data_root for pidfile parent, etc.). Uses `Generation::from_paths`
/// — the same constructor the deleted P3 `main.rs` used; it bypasses the
/// reload-runner manifest pipeline that's not under test here.
fn ctx_over_tiny() -> (tempfile::TempDir, Arc<ServerCtx>, Arc<Metrics>) {
    let (dir, config, _clock) = common::isolated_config();
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

#[test]
fn both_listeners_bind_and_serve_health_and_metrics() {
    let (_dir, ctx, _metrics) = ctx_over_tiny();
    let pool = WorkerPool::new("127.0.0.1:0", "127.0.0.1:0", 2, Arc::clone(&ctx))
        .expect("WorkerPool::new must bind both listeners");
    let main_addr = pool.main_addr();
    let aux_addr = pool.aux_addr();
    assert_ne!(
        main_addr.port(),
        aux_addr.port(),
        "main + aux must bind to distinct ports"
    );

    assert!(
        wait_for_listener(main_addr, "/health", Duration::from_secs(3)),
        "main listener must accept connections"
    );
    assert!(
        wait_for_listener(aux_addr, "/metrics", Duration::from_secs(3)),
        "aux listener must accept connections"
    );

    // The aux listener is lifecycle-only so application work cannot consume
    // its sole scrape worker.
    assert_eq!(
        http_get_status(main_addr, "/health"),
        Some(200),
        "main /health"
    );
    assert_eq!(
        http_get_status(aux_addr, "/metrics"),
        Some(200),
        "aux /metrics"
    );
    assert_eq!(
        http_get_status(aux_addr, "/api/gtfs/poi-tile/vilnius/12km/0_0"),
        Some(404),
        "aux must reject application routes"
    );

    pool.stop_accepting();
    join_with_outer_timeout(pool, Duration::from_secs(2), Duration::from_secs(5));
}

#[test]
fn aux_ready_returns_503_when_flag_is_set() {
    let (_dir, ctx, metrics) = ctx_over_tiny();
    let pool = WorkerPool::new("127.0.0.1:0", "127.0.0.1:0", 1, Arc::clone(&ctx))
        .expect("WorkerPool::new");
    let aux_addr = pool.aux_addr();
    assert!(wait_for_listener(
        aux_addr,
        "/ready",
        Duration::from_secs(3)
    ));

    // Default: ready_503 is false → /ready returns 200.
    assert_eq!(http_get_status(aux_addr, "/ready"), Some(200));

    // Flip the readiness flag — the SAME route now returns 503.
    metrics.set_ready_503();
    assert_eq!(http_get_status(aux_addr, "/ready"), Some(503));

    // Clear restores 200 (plumbs the symmetric path; will never actually clear it, but having the
    // path lit by a test keeps a future recovery story open).
    metrics.clear_ready_503();
    assert_eq!(http_get_status(aux_addr, "/ready"), Some(200));

    pool.stop_accepting();
    join_with_outer_timeout(pool, Duration::from_secs(2), Duration::from_secs(5));
}

#[test]
fn stop_accepting_then_join_terminates_cleanly() {
    let (_dir, ctx, _metrics) = ctx_over_tiny();
    let pool = WorkerPool::new("127.0.0.1:0", "127.0.0.1:0", 3, Arc::clone(&ctx))
        .expect("WorkerPool::new");
    assert!(wait_for_listener(
        pool.main_addr(),
        "/health",
        Duration::from_secs(3)
    ));

    pool.stop_accepting();
    join_with_outer_timeout(pool, Duration::from_secs(2), Duration::from_secs(5));
}

/// Run `pool.join()` on a helper thread and panic if the outer deadline lapses — a regression that
/// wedges join would otherwise hang the test binary indefinitely. The `_drain_timeout` parameter is
/// kept on the helper signature for caller readability but is unused — the bound lives entirely in
/// the per-request watchdog, not the join call. See WorkerPool::join doc-comment.
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
