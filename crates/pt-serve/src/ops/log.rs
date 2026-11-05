//! Structured-log helper — the one place outside `main.rs` that converts a
//! key-value event into either JSON (the k8s default) or plain text (the
//! local-dev fallback).
//!
//! ## Why a helper, not a crate
//!
//! The existing operability surface uses ad-hoc single-line JSON
//! `eprintln!` calls for the load-bearing events (pidfile lock fail, RSS
//! reject, sentinel mismatch, forced-current adoption). Adding `tracing`
//! or `slog` would pull a large compile-time dep and a runtime subscriber
//! we'd still have to configure manually; the cost outweighs the
//! consistency win for ~10 emit sites.
//!
//! This helper enforces ONE thing: every log line at a load-bearing site
//! has `level`, `event`, and (when JSON) `timestamp`. The 21 ad-hoc
//! `eprintln!` calls remain — the helper is opt-in for the events
//! operators page on.
//!
//! ## Format
//!
//! - `LogFormat::Json` →
//!   `{"timestamp":"2026-05-24T12:34:56Z","level":"INFO","msg":"reload_adopted","generationId":"…","durationMs":42}`
//!   (compact, no pretty-print; one line per record; fields in stable order).
//! - `LogFormat::Text` →
//!   `2026-05-24T12:34:56Z INFO reload_adopted generationId=… durationMs=42`
//!   (legibility for local `tail -f`).
//!
//! Timestamps are derived from `SystemTime::now()` and formatted via the
//! same helper as the manifest validators (`format_rfc3339_utc`), so a
//! grep across logs + manifests lines up.

use crate::ops::config::LogFormat;
use crate::ops::readiness::format_rfc3339_utc;

/// Severity tag emitted as `"level":"…"` in JSON or the second
/// space-delimited field in text mode. Mirrors syslog severities the k8s
/// log pipeline already knows about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }
}

/// Emit one structured log record to stderr. `fields` are emitted in the
/// order given so dashboards keying off positional fields stay stable.
///
/// Field values are NOT type-checked — callers convert numbers / bools /
/// IDs into the appropriate JSON-friendly string representation before
/// passing them. Strings are JSON-escaped; numbers/booleans should be
/// stringified without quotes by the caller (this helper wraps every
/// value in quotes for safety, so `"42"` renders as `"42"` in JSON;
/// dashboards that need numeric values should parse the field server-side).
pub fn log_event(format: LogFormat, level: Level, msg: &str, fields: &[(&str, &str)]) {
    let now = std::time::SystemTime::now();
    let ts = format_rfc3339_utc(now);
    match format {
        LogFormat::Json => {
            let mut out = String::with_capacity(
                64 + msg.len()
                    + fields
                        .iter()
                        .map(|(k, v)| k.len() + v.len() + 6)
                        .sum::<usize>(),
            );
            out.push('{');
            out.push_str("\"timestamp\":");
            json_string(&ts, &mut out);
            out.push_str(",\"level\":\"");
            out.push_str(level.as_str());
            out.push_str("\",\"msg\":");
            json_string(msg, &mut out);
            for (k, v) in fields {
                out.push(',');
                json_string(k, &mut out);
                out.push(':');
                json_string(v, &mut out);
            }
            out.push('}');
            eprintln!("{out}");
        }
        LogFormat::Text => {
            let mut out = String::new();
            out.push_str(&ts);
            out.push(' ');
            out.push_str(level.as_str());
            out.push(' ');
            out.push_str(msg);
            for (k, v) in fields {
                out.push(' ');
                out.push_str(k);
                out.push('=');
                // Quote values that contain whitespace; otherwise leave bare.
                if v.chars().any(|c| c.is_whitespace() || c == '"') {
                    out.push('"');
                    for c in v.chars() {
                        match c {
                            '"' => out.push_str("\\\""),
                            '\\' => out.push_str("\\\\"),
                            c => out.push(c),
                        }
                    }
                    out.push('"');
                } else {
                    out.push_str(v);
                }
            }
            eprintln!("{out}");
        }
    }
}

/// Minimal JSON string escaper — same shape as `app::version::json_string`
/// but private here to avoid a cross-module dep on the HTTP layer.
fn json_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_escapes_special_chars() {
        let mut out = String::new();
        json_string("a\"b\\c\nd", &mut out);
        assert_eq!(out, r#""a\"b\\c\nd""#);
    }

    #[test]
    fn level_as_str_is_stable() {
        assert_eq!(Level::Info.as_str(), "INFO");
        assert_eq!(Level::Warn.as_str(), "WARN");
        assert_eq!(Level::Error.as_str(), "ERROR");
    }
}
