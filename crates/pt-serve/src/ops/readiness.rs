//! Readiness-related constants and helpers shared between `/ready` exposition
//! and the operability surface.
//!
//! ## `FEED_STALE_DAYS`
//!
//! Days past `feed_start_date` after which the 90-day service-window bitmask
//! is considered "close enough to running out" that operators should be paged.
//! Pinned at 80 — 10-day buffer before the 90-day window exhausts.
//!
//! **The Rust constant MUST match the Node one** at
//! `packages/backend/src/health/feedStaleConstants.ts`. This module's value
//! is asserted equal to the Node export by
//! `crates/pt-serve/tests/feed_stale_constant.rs`, fed by `build.rs` which
//! greps the TS file at compile time.
//!
//! ## Why a separate module
//!
//! The constant could have lived on `Metrics` or `ServerConfig` — and the
//! operator-configurable runtime threshold DOES live on
//! `ServerConfig::feed_stale_days` (clap default 80). This module hosts the
//! immutable Rust↔Node contract value the operator default is derived from.
//! `tests/feed_stale_constant.rs` pins the source-of-truth constant, NOT
//! the per-process configurable one.

/// Days since `feed_start_date` beyond which the service window is
/// considered stale. **Must equal** the Node export at
/// `packages/backend/src/health/feedStaleConstants.ts` — the build script
/// emits the Node value into `NODE_FEED_STALE_DAYS` and
/// `tests/feed_stale_constant.rs` asserts equality.
pub const FEED_STALE_DAYS: u32 = 80;

/// Compute the number of full days between two YYYYMMDD-encoded anchors.
/// Used by `/ready` to compute `feedStartDateAgeDays` from the active
/// generation's `feed_start_date` (PTB header anchor) and the wall clock's
/// current civil date.
///
/// `now_ymd` is the YYYYMMDD-encoded "today" in UTC. Returns 0 when the
/// anchor lies in the future (e.g. a clock skew or a hand-built test
/// manifest) — operators should detect this via the same `serviceWindowStale`
/// gauge they already monitor.
///
/// The arithmetic mirrors `pt_shared::validate::metadata::days_from_civil`
/// (Howard-Hinnant) so this helper rounds the same way the
/// metadata-validation code does — keeping a single source of truth across
/// the staleness gauge and the createdAt-skew validator avoids off-by-one
/// drift.
pub fn days_between_ymd(anchor_ymd: u32, now_ymd: u32) -> u64 {
    let (ay, am, ad) = decode_ymd(anchor_ymd);
    let (ny, nm, nd) = decode_ymd(now_ymd);
    let a = days_from_civil(ay, am, ad);
    let n = days_from_civil(ny, nm, nd);
    if n <= a {
        0
    } else {
        (n - a) as u64
    }
}

/// `YYYYMMDD` u32 → `(year, month, day)`. A malformed encoding (year < 1970
/// or month/day out of range) clamps to UNIX epoch so callers don't have to
/// thread an error type through the readiness exposition.
fn decode_ymd(ymd: u32) -> (i64, i64, i64) {
    let y = (ymd / 10000) as i64;
    let m = ((ymd / 100) % 100) as i64;
    let d = (ymd % 100) as i64;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || y < 1 {
        return (1970, 1, 1);
    }
    (y, m, d)
}

/// Howard-Hinnant `days_from_civil` — mirrors the metadata-validator helper.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// `civil_from_days` — inverse of `days_from_civil`. Used by [`now_ymd_utc`]
/// to render the system clock's "today" as a YYYYMMDD u32 for the staleness
/// comparison.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Render a `SystemTime` as a UTC YYYYMMDD u32. Used by `/ready` to compute
/// the staleness gauge against the active generation's `feed_start_date`.
pub fn ymd_utc(now: std::time::SystemTime) -> u32 {
    let secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    (y as u32) * 10000 + m * 100 + d
}

/// Strict RFC 3339 (`YYYY-MM-DDTHH:MM:SSZ`) parser. Mirrors
/// `pt_shared::validate::metadata::parse_rfc3339` (private there) so the
/// readiness exposition can derive `generationAgeSecs` from a
/// `Generation::created_at` string without a chrono/time dep.
///
/// Returns `None` on any grammar deviation — callers render the field as
/// `null` in JSON when the parse fails (the manifest validator rejects bad
/// timestamps before adoption, so a `Generation` reaching this path should
/// always parse).
pub fn parse_rfc3339_utc(s: &str) -> Option<std::time::SystemTime> {
    let bytes = s.as_bytes();
    if bytes.len() != 20 {
        return None;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    if bytes[13] != b':' || bytes[16] != b':' || bytes[19] != b'Z' {
        return None;
    }
    let y = parse_uint(&bytes[0..4])?;
    let mo = parse_uint(&bytes[5..7])?;
    let d = parse_uint(&bytes[8..10])?;
    let h = parse_uint(&bytes[11..13])?;
    let mi = parse_uint(&bytes[14..16])?;
    let se = parse_uint(&bytes[17..19])?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let days = days_from_civil(y as i64, mo as i64, d as i64);
    let unix = days * 86400 + (h as i64) * 3600 + (mi as i64) * 60 + se as i64;
    if unix < 0 {
        return None;
    }
    Some(std::time::UNIX_EPOCH + std::time::Duration::from_secs(unix as u64))
}

/// Format a `SystemTime` back to the strict 20-char RFC 3339 grammar — used
/// by `/ready` to render `lastSuccessfulReloadAt` from
/// `Metrics::reload_last_success_timestamp_seconds`.
pub fn format_rfc3339_utc(t: std::time::SystemTime) -> String {
    let secs = t
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn parse_uint(bytes: &[u8]) -> Option<u32> {
    let mut v: u32 = 0;
    for &b in bytes {
        if !b.is_ascii_digit() {
            return None;
        }
        v = v.checked_mul(10)?;
        v = v.checked_add((b - b'0') as u32)?;
    }
    Some(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_between_basic() {
        assert_eq!(days_between_ymd(20260501, 20260501), 0);
        assert_eq!(days_between_ymd(20260501, 20260502), 1);
        assert_eq!(days_between_ymd(20260101, 20260201), 31);
    }

    #[test]
    fn days_between_future_anchor_returns_zero() {
        // Anchor in the future — operator-detected; we clamp to 0 so the
        // staleness gauge never flips to "stale" on a clock skew.
        assert_eq!(days_between_ymd(20990101, 20260501), 0);
    }

    #[test]
    fn ymd_utc_round_trip() {
        // Round-trip a known timestamp: 2026-05-23T12:00:00Z → 20260523.
        let s = "2026-05-23T12:00:00Z";
        let t = parse_rfc3339_utc(s).unwrap();
        assert_eq!(ymd_utc(t), 20260523);
        // The format helper produces the same string back.
        assert_eq!(format_rfc3339_utc(t), s);
    }

    #[test]
    fn ymd_utc_midnight_boundary() {
        // 2026-05-23T00:00:00Z and 2026-05-23T23:59:59Z must both render as
        // 20260523 — the truncating div_euclid is the seam where an
        // off-by-one would surface.
        let start = parse_rfc3339_utc("2026-05-23T00:00:00Z").unwrap();
        let end = parse_rfc3339_utc("2026-05-23T23:59:59Z").unwrap();
        assert_eq!(ymd_utc(start), 20260523);
        assert_eq!(ymd_utc(end), 20260523);
    }

    #[test]
    fn rfc3339_parses_and_formats() {
        let s = "2026-05-23T12:00:00Z";
        let t = parse_rfc3339_utc(s).unwrap();
        assert_eq!(format_rfc3339_utc(t), s);
    }

    #[test]
    fn rfc3339_rejects_bad_grammar() {
        assert!(parse_rfc3339_utc("2026-05-23T12:00:00").is_none()); // missing Z
        assert!(parse_rfc3339_utc("2026-05-23T12:00:00.000Z").is_none()); // fractional
        assert!(parse_rfc3339_utc("not a date").is_none());
    }

    #[test]
    fn feed_stale_days_constant_is_80() {
        // Sanity: the Rust-side constant matches the spec; the cross-language
        // pin lives in `tests/feed_stale_constant.rs`.
        assert_eq!(FEED_STALE_DAYS, 80);
    }
}
