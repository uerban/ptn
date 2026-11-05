// crates/pt-serve/src/rt/fetch.rs

//! Blocking HTTP fetch for GTFS-RT feeds — the network half of Node's
//! `GtfsRealtimePoller.pollOne` (`packages/backend/src/gtfs/realtime.ts`).
//! One GET per feed URL; 15 s overall timeout; non-2xx mapped to the exact
//! `"HTTP <status>"` string Node stores in `FeedHealth.lastError`; transport
//! errors mapped to their `Display` (semantics parity — the text differs
//! from undici's). ureq's `gzip` feature gives the same transparent
//! Accept-Encoding negotiation Node's `fetch` does; ureq follows up to 5
//! redirects (Node: 20 — no known feed redirects at all).
//!
//! This module never parses: bytes go through
//! [`crate::rt::RtPoller::apply_fetch_result`], keeping the PR #426 seam.

use std::io::Read;
use std::time::Duration;

/// Overall per-request timeout. Parity: `FEED_FETCH_TIMEOUT_MS = 15_000` in
/// `packages/backend/src/gtfs/realtime.ts` (AbortController-driven there;
/// ureq's agent-level overall timeout here).
pub const FEED_FETCH_TIMEOUT: Duration = Duration::from_secs(15);

/// Hard response-body cap. DELIBERATE divergence from Node (which buffers
/// the arrayBuffer unbounded): an untrusted upstream must not be able to
/// OOM the server. Real TripUpdates feeds are single-digit MB; 64 MiB is
/// ~30× headroom. A capped feed is a fetch failure — last-good retention
/// applies, never a truncated parse.
pub const MAX_FEED_BYTES: u64 = 64 * 1024 * 1024;

/// The process-wide agent for RT fetches (connection reuse across cycles).
/// Construct ONCE at startup and reuse; cloning is cheap (Arc-backed, clones
/// share the connection pool), but calling `rt_agent()` per fetch or per
/// cycle builds a fresh pool each time and silently defeats keep-alive.
pub fn rt_agent() -> ureq::Agent {
    let builder = ureq::AgentBuilder::new().timeout(FEED_FETCH_TIMEOUT);
    #[cfg(all(target_arch = "arm", target_env = "musl"))]
    let builder = builder.tls_connector(std::sync::Arc::new(
        ureq::native_tls::TlsConnector::new().expect("initialize RT TLS connector"),
    ));
    builder.build()
}

/// One feed fetch. `Err` strings land verbatim in `FeedHealth.last_error`
/// (and therefore in `/health/rt` bodies) — keep them operator-readable.
pub fn fetch_feed(agent: &ureq::Agent, url: &str) -> Result<Vec<u8>, String> {
    fetch_feed_capped(agent, url, MAX_FEED_BYTES)
}

/// Cap-parameterised inner so tests exercise the cap without allocating
/// 64 MiB bodies.
fn fetch_feed_capped(agent: &ureq::Agent, url: &str, cap: u64) -> Result<Vec<u8>, String> {
    match agent.get(url).call() {
        Ok(resp) => {
            let mut bytes = Vec::new();
            match resp.into_reader().take(cap + 1).read_to_end(&mut bytes) {
                Ok(_) => {
                    if bytes.len() as u64 > cap {
                        return Err(format!("feed body exceeds {cap} byte cap"));
                    }
                    Ok(bytes)
                }
                Err(e) => Err(e.to_string()),
            }
        }
        Err(ureq::Error::Status(code, _)) => Err(format!("HTTP {code}")),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// One-shot local HTTP server on a raw TcpListener: reads one request, writes one minimal
    /// HTTP/1.1 response, exits. Deliberately NOT tiny_http — the boundary test pins tiny_http
    /// imports to `http/` (transport confinement), and that rule stays absolute; same
    /// hand-rolled-HTTP approach as tests/server.rs's raw-TCP helper.
    fn one_shot(status: u16, body: Vec<u8>) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().expect("local addr");
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                // Drain the request head so the client isn't racing a reset.
                let mut buf = [0u8; 4096];
                let mut head = Vec::new();
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => head.extend_from_slice(&buf[..n]),
                    }
                }
                let reason = match status {
                    200 => "OK",
                    503 => "Service Unavailable",
                    _ => "Status",
                };
                let mut resp = format!(
                    "HTTP/1.1 {status} {reason}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                )
                .into_bytes();
                resp.extend_from_slice(&body);
                let _ = stream.write_all(&resp);
            }
        });
        format!("http://{addr}/trip_updates.pb")
    }

    fn agent() -> ureq::Agent {
        rt_agent()
    }

    #[test]
    fn ok_response_yields_bytes() {
        let payload = include_bytes!("../../tests/fixtures/rt/dated_trip.bin").to_vec();
        let url = one_shot(200, payload.clone());
        assert_eq!(fetch_feed(&agent(), &url), Ok(payload));
    }

    #[test]
    fn http_error_maps_to_http_status_string() {
        // Parity: Node's pollOne sets `HTTP ${response.status}` verbatim.
        let url = one_shot(503, b"upstream sad".to_vec());
        assert_eq!(fetch_feed(&agent(), &url), Err("HTTP 503".to_string()));
    }

    #[test]
    fn transport_error_maps_to_message() {
        // Port 1 is never listening (same trick as health_probe.rs's
        // probe_err_on_no_listener) — no bind-drop-reconnect port-reuse race
        // under parallel test binds.
        let err = fetch_feed(&agent(), "http://127.0.0.1:1/x.pb").unwrap_err();
        assert!(!err.is_empty());
        assert!(
            !err.starts_with("HTTP "),
            "transport errors are not HTTP-status errors: {err}"
        );
    }

    #[test]
    fn oversized_body_is_a_fetch_failure() {
        let url = one_shot(200, vec![0u8; 16]);
        let err = fetch_feed_capped(&agent(), &url, 8).unwrap_err();
        assert!(err.contains("cap"), "expected cap error, got: {err}");
    }

    #[test]
    fn body_exactly_at_cap_succeeds_and_one_over_fails() {
        // Locks in the take(cap + 1) / len > cap off-by-one: exactly-cap is
        // a valid feed, cap+1 is a failure.
        let at_cap = one_shot(200, vec![0u8; 8]);
        assert_eq!(fetch_feed_capped(&agent(), &at_cap, 8), Ok(vec![0u8; 8]));

        let over_cap = one_shot(200, vec![0u8; 9]);
        let err = fetch_feed_capped(&agent(), &over_cap, 8).unwrap_err();
        assert!(err.contains("cap"), "expected cap error, got: {err}");
    }
}
