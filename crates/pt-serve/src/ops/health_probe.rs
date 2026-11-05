//! `--health-probe`: connect to the metrics listener, GET /ready, exit 0 on 200.
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

/// Returns Ok(()) iff the metrics listener returns HTTP 200 for GET /ready.
///
/// `metrics_listen_addr` may be any of: `0.0.0.0:PORT`, `[::]:PORT`, `HOST:PORT`.
/// Wildcard bind addresses are rewritten to the appropriate loopback address before
/// connecting: `0.0.0.0` → `127.0.0.1`, `[::]` → `[::1]`, `::` (bare) → `::1`.
/// A hostname or non-wildcard IP is used as-is.
pub fn probe(metrics_listen_addr: &str) -> Result<(), String> {
    // Rewrite wildcard bind addresses to a connectable loopback address.
    let target = rewrite_wildcard(metrics_listen_addr);
    let mut stream =
        TcpStream::connect(target.as_str()).map_err(|e| format!("connect {target}: {e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(2))).ok();
    stream
        .write_all(b"GET /ready HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .map_err(|e| format!("write: {e}"))?;
    // read_exact over 12 bytes ("HTTP/1.x 200") prevents a partial first read
    // from making a healthy 200 look like a non-200 (single read is not guaranteed
    // to return the full status prefix in one syscall). The 2s read timeout applies.
    let mut buf = [0u8; 12];
    stream
        .read_exact(&mut buf)
        .map_err(|e| format!("read: {e}"))?;
    let head = std::str::from_utf8(&buf).unwrap_or("");
    if head.starts_with("HTTP/1.0 200") || head.starts_with("HTTP/1.1 200") {
        Ok(())
    } else {
        Err(format!("non-200 status line: {head:?}"))
    }
}

/// Rewrite a wildcard bind address to the corresponding loopback connect target.
///
/// Supported forms: `0.0.0.0:PORT` → `127.0.0.1:PORT`,
/// `[::]:PORT` → `[::1]:PORT`, `::<anything>` → `::1<anything>`.
/// Any other value (hostname, non-wildcard IP) is returned unchanged.
fn rewrite_wildcard(addr: &str) -> String {
    if let Some(rest) = addr.strip_prefix("0.0.0.0") {
        return format!("127.0.0.1{rest}");
    }
    if let Some(rest) = addr.strip_prefix("[::]") {
        return format!("[::1]{rest}");
    }
    if let Some(rest) = addr.strip_prefix("::") {
        // bare `::PORT` or `::` alone — replace the wildcard host part only
        return format!("::1{rest}");
    }
    addr.to_owned()
}

/// Decide whether this invocation is a one-shot health probe and, if so,
/// resolve the metrics-listener address to probe — WITHOUT requiring any of
/// the launch-only flags.
///
/// This is the seam that lets the compose healthcheck run `/pt-serve
/// --health-probe` with no other arguments. `ServerConfig::parse()` marks
/// `--max-rss-bytes` / `--data-root` / `--city-slug` / … as required, so it
/// aborts (clap exit 2) before `main` can ever inspect a parsed
/// `health_probe`. The probe only needs the metrics address, so `main` calls
/// this BEFORE `ServerConfig::parse()` and short-circuits when it returns
/// `Some`. (It also runs before `config.validate()`, which would write a
/// sentinel into `data_root` — the probe must not touch `data_root`.)
///
/// Probe mode is requested when `--health-probe` appears in `args` OR the
/// `PT_SERVE_HEALTH_PROBE` env var is truthy (`1`/`true`/`yes`/`on`,
/// case-insensitive). The address is resolved, in precedence order, from
/// `--metrics-listen-addr[=]<addr>` in `args` (last occurrence wins, matching
/// clap), then `PT_SERVE_METRICS_LISTEN_ADDR`, then
/// [`crate::ops::config::DEFAULT_METRICS_LISTEN_ADDR`] — the SAME default
/// `ServerConfig` applies, so a probe with no override targets the listener
/// the server actually bound.
pub fn probe_target_if_requested<F>(args: &[String], env: F) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
{
    let requested = args.iter().any(|a| a == "--health-probe")
        || env("PT_SERVE_HEALTH_PROBE")
            .map(|v| is_truthy(&v))
            .unwrap_or(false);
    if !requested {
        return None;
    }
    let addr = metrics_addr_from_args(args)
        .or_else(|| env("PT_SERVE_METRICS_LISTEN_ADDR"))
        .unwrap_or_else(|| crate::ops::config::DEFAULT_METRICS_LISTEN_ADDR.to_string());
    Some(addr)
}

/// Extract `--metrics-listen-addr` from argv, accepting both the
/// `--metrics-listen-addr=VALUE` and `--metrics-listen-addr VALUE` forms.
/// Last occurrence wins, matching clap's repeated-flag semantics.
fn metrics_addr_from_args(args: &[String]) -> Option<String> {
    let mut found = None;
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if let Some(v) = a.strip_prefix("--metrics-listen-addr=") {
            found = Some(v.to_string());
        } else if a == "--metrics-listen-addr" {
            if let Some(v) = args.get(i + 1) {
                found = Some(v.clone());
                i += 1; // consume the value token
            }
        }
        i += 1;
    }
    found
}

/// Truthy values for the boolean `PT_SERVE_HEALTH_PROBE` env switch
/// (case-insensitive, surrounding whitespace ignored).
fn is_truthy(v: &str) -> bool {
    matches!(
        v.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::config::DEFAULT_METRICS_LISTEN_ADDR;
    use std::collections::HashMap;

    fn env_from(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k: &str| map.get(k).cloned()
    }

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn not_requested_returns_none() {
        let a = argv(&["pt-serve", "--data-root=/x", "--city-slug=krakow"]);
        assert_eq!(probe_target_if_requested(&a, env_from(&[])), None);
    }

    #[test]
    fn flag_alone_targets_default_metrics_addr() {
        let a = argv(&["pt-serve", "--health-probe"]);
        assert_eq!(
            probe_target_if_requested(&a, env_from(&[])),
            Some(DEFAULT_METRICS_LISTEN_ADDR.to_string())
        );
    }

    #[test]
    fn metrics_addr_equals_form_overrides_default() {
        let a = argv(&[
            "pt-serve",
            "--health-probe",
            "--metrics-listen-addr=1.2.3.4:7",
        ]);
        assert_eq!(
            probe_target_if_requested(&a, env_from(&[])),
            Some("1.2.3.4:7".to_string())
        );
    }

    #[test]
    fn metrics_addr_space_form_overrides_default() {
        let a = argv(&[
            "pt-serve",
            "--health-probe",
            "--metrics-listen-addr",
            "1.2.3.4:7",
        ]);
        assert_eq!(
            probe_target_if_requested(&a, env_from(&[])),
            Some("1.2.3.4:7".to_string())
        );
    }

    #[test]
    fn env_var_requests_probe_with_default_addr() {
        let a = argv(&["pt-serve"]);
        assert_eq!(
            probe_target_if_requested(&a, env_from(&[("PT_SERVE_HEALTH_PROBE", "1")])),
            Some(DEFAULT_METRICS_LISTEN_ADDR.to_string())
        );
    }

    #[test]
    fn env_metrics_addr_used_when_no_argv_override() {
        let a = argv(&["pt-serve", "--health-probe"]);
        assert_eq!(
            probe_target_if_requested(
                &a,
                env_from(&[("PT_SERVE_METRICS_LISTEN_ADDR", "9.9.9.9:1")])
            ),
            Some("9.9.9.9:1".to_string())
        );
    }

    #[test]
    fn argv_metrics_addr_beats_env() {
        let a = argv(&[
            "pt-serve",
            "--health-probe",
            "--metrics-listen-addr=1.2.3.4:7",
        ]);
        assert_eq!(
            probe_target_if_requested(
                &a,
                env_from(&[("PT_SERVE_METRICS_LISTEN_ADDR", "9.9.9.9:1")])
            ),
            Some("1.2.3.4:7".to_string())
        );
    }

    #[test]
    fn env_false_does_not_request_probe() {
        let a = argv(&["pt-serve"]);
        assert_eq!(
            probe_target_if_requested(&a, env_from(&[("PT_SERVE_HEALTH_PROBE", "false")])),
            None
        );
    }

    #[test]
    fn last_metrics_addr_wins() {
        let a = argv(&[
            "pt-serve",
            "--health-probe",
            "--metrics-listen-addr=1.1.1.1:1",
            "--metrics-listen-addr=2.2.2.2:2",
        ]);
        assert_eq!(
            probe_target_if_requested(&a, env_from(&[])),
            Some("2.2.2.2:2".to_string())
        );
    }
}
