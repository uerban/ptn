//! Integration tests for `--health-probe` (ops::health_probe::probe).

use std::io::{Read, Write};
use std::net::TcpListener;

/// Bind an ephemeral listener, spawn a thread that accepts one connection and
/// replies with `response`, then return the bound address string.
fn stub_server(response: &'static [u8]) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub");
    let addr = listener.local_addr().expect("local_addr").to_string();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            // Drain the request (ignore it).
            let mut buf = [0u8; 256];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(response);
        }
    });
    addr
}

#[test]
fn probe_ok_on_200() {
    let addr = stub_server(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    assert!(pt_serve::ops::health_probe::probe(&addr).is_ok());
}

#[test]
fn probe_err_on_503() {
    let addr = stub_server(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
    assert!(pt_serve::ops::health_probe::probe(&addr).is_err());
}

#[test]
fn probe_err_on_no_listener() {
    // Port 1 is reserved and will always refuse connections on any
    // sane OS — gives us a reliable "no listener" scenario.
    assert!(pt_serve::ops::health_probe::probe("127.0.0.1:1").is_err());
}

/// Proves that `read_exact` reassembles a split status line: the stub server
/// writes the status line in two separate `write_all` calls with a small sleep
/// between them, simulating a partial first read. The old single-`read` code
/// would have flaked/failed (seeing only "HTTP/1.1 " and no "200"); read_exact
/// blocks until all 12 bytes arrive.
#[test]
fn probe_ok_on_chunked_200() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub");
    let addr = listener.local_addr().expect("local_addr").to_string();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 256];
            let _ = stream.read(&mut buf);
            // Write the first 9 bytes ("HTTP/1.1 ") then pause before the rest.
            let _ = stream.write_all(b"HTTP/1.1 ");
            std::thread::sleep(std::time::Duration::from_millis(20));
            // Write the remainder of the status line + headers.
            let _ = stream.write_all(b"200 OK\r\nContent-Length: 0\r\n\r\n");
        }
    });
    assert!(
        pt_serve::ops::health_probe::probe(&addr).is_ok(),
        "probe must succeed even when the status line arrives in two TCP segments"
    );
}

// IPv6 wildcard test: skipped — binding `[::]:0` is not reliably available on
// all CI environments (some macOS/Linux sandbox configs disable IPv6 loopback or
// return EADDRNOTAVAIL). The wildcard-rewrite logic (`[::]` → `[::1]`) is a
// pure string transform verified by the unit test for `rewrite_wildcard` in
// health_probe.rs itself; an integration bind would add OS-layer flakiness
// without meaningfully strengthening the coverage of that one-liner.

// ---------------------------------------------------------------------------
// End-to-end binary regression: `--health-probe` must NOT require the launch
// flags. This reproduces the staging incident where the compose healthcheck
// `["CMD","/pt-serve","--health-probe"]` aborted with clap's "required
// arguments were not provided" (exit 2), so every container went unhealthy.
// ---------------------------------------------------------------------------

/// `--health-probe` alone must run the probe (not abort on missing launch
/// args). We point it at port 1 (always connection-refused) so the probe runs
/// deterministically and fails to connect — exit 1 with our "health-probe:"
/// message — proving clap let the invocation through.
#[test]
fn health_probe_flag_alone_does_not_require_launch_args() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_pt-serve"))
        .args(["--health-probe", "--metrics-listen-addr=127.0.0.1:1"])
        .output()
        .expect("spawn pt-serve");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        !stderr.contains("required arguments were not provided"),
        "clap still demands launch args in probe mode (the bug): {stderr}"
    );
    assert!(
        stderr.contains("health-probe:"),
        "probe did not run — stderr: {stderr}"
    );
    assert_eq!(
        out.status.code(),
        Some(1),
        "expected probe connect-failure exit 1; stderr: {stderr}"
    );
}

/// Guard the scope of the fix: a NORMAL launch with no flags must still be
/// rejected by clap for the missing required args. The pre-parse must only
/// short-circuit probe mode — never relax the real startup path.
#[test]
fn normal_launch_still_requires_args() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_pt-serve"))
        .output()
        .expect("spawn pt-serve");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("--max-rss-bytes"),
        "expected clap to still require launch args; stderr: {stderr}"
    );
    assert_eq!(
        out.status.code(),
        Some(2),
        "expected clap usage-error exit 2"
    );
}
