//! Metadata validators — manifest cross-checks.
//!
//! Wraps the cheap "did the producer publish what they claim" checks before
//! the engine touches the bundle bytes: schema version, city slug, bundle
//! hash/size, generationId-as-hash grammar, transfers consistency,
//! manifest↔bundle feedStartDate pairing, and createdAt clock skew.
//!
//! ## Order of checks (cheapest first)
//!
//! 1. Manifest schema version  (one integer compare; the only `is_fatal()`)
//! 2. City slug                  (one string compare)
//! 3. Bundle size                (catches torn writes in microseconds)
//! 4. Generation-id grammar     (== hex(bundle_sha256))
//! 5. Bundle SHA-256             (the expensive one — gated by size first)
//! 6. FeedStartDate pairing      (one u32 compare; caller-supplied bundle anchor)
//! 7. Transfers consistency      (4-arm match; SHA only when sizes agree)
//! 8. CreatedAt clock skew       (only-tolerance-dependent; runs last)
//!
//! ## RFC 3339: strict subset, hand-rolled
//!
//! `manifest.created_at` is the only timestamp this layer parses. The
//! producer publish protocol emits exactly `YYYY-MM-DDTHH:MM:SSZ` (UTC, no
//! fractional seconds, no offset). We parse that grammar by hand to avoid
//! pulling `chrono` or `time` for a single 20-char string. A
//! non-conformant manifest surfaces as
//! [`ProducerError::CreatedAtMalformed`] (Postel does NOT apply to
//! invariants).

use crate::clock::Clock;
use crate::manifest::{GenerationManifest, MANIFEST_SCHEMA_VERSION_MAX};
use crate::validate::errors::{OperatorError, ProducerError, ValidationError};
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime};

/// Tolerance for `created_at > now` skew during **startup** load — wider
/// because a freshly-rolling container may have a clock drifting up to the
/// configured NTP-step window before sync.
const SKEW_TOLERANCE_STARTUP: Duration = Duration::from_secs(300);
/// Tolerance for `created_at > now` skew during **reload** — tighter
/// because the server's clock has been ticking for at least one prior
/// generation's worth of time and NTP has had its chance.
const SKEW_TOLERANCE_RELOAD: Duration = Duration::from_secs(60);

/// Validate a generation manifest against the on-disk bundle (and optional
/// transfers) bytes plus the operator config.
///
/// Arguments:
/// - `manifest` — already-deserialized generation manifest.
/// - `bundle_bytes` — the bytes the loader mmapped or read. The caller is
///   responsible for paging them in; this fn computes a fresh SHA-256.
/// - `transfers_bytes` — same, but optional (per `manifest.has_transfers`).
/// - `expected_city` — the `--city` slug pt-serve was started with.
/// - `bundle_feed_start_date` — `Reader::feed_start_date()` from the
///   already-parsed bundle. Passed in so this fn doesn't reach into the
///   reader (keeps the seam one-way).
/// - `now` — the value of `clock.now()` taken by the caller.
/// - `is_startup` — `true` for the initial load, `false` for hot-reload;
///   selects the createdAt skew tolerance.
///
/// Returns `Ok(())` if every check passes; a typed [`ValidationError`]
/// otherwise. The CALLER decides what to do with the error (fall back to
/// last-good, exit non-zero, label as `cause="…"` in audit log, …).
#[allow(clippy::too_many_arguments)]
pub fn validate_metadata(
    manifest: &GenerationManifest,
    bundle_bytes: &[u8],
    transfers_bytes: Option<&[u8]>,
    expected_city: &str,
    bundle_feed_start_date: u32,
    now: SystemTime,
    is_startup: bool,
) -> Result<(), ValidationError> {
    // 1. Manifest schema version (FATAL — no point trying last-good if the
    //    pt-serve binary is too old; the producer is on a wire-incompatible
    //    rev).
    if !(crate::manifest::MANIFEST_SCHEMA_VERSION_MIN..=MANIFEST_SCHEMA_VERSION_MAX)
        .contains(&manifest.manifest_schema_version)
    {
        return Err(OperatorError::UnsupportedManifestSchemaVersion(
            manifest.manifest_schema_version,
        )
        .into());
    }

    // 2. City slug (operator config mismatch).
    if manifest.city_slug != expected_city {
        return Err(OperatorError::WrongCity {
            expected: expected_city.to_string(),
            found: manifest.city_slug.clone(),
        }
        .into());
    }

    // 3. Bundle size — cheap precheck that catches torn writes in
    //    microseconds. A size disagreement makes the SHA disagreement
    //    inevitable, and SHA-256 over a multi-MB bundle is expensive
    //    compared to a u64 compare.
    if bundle_bytes.len() as u64 != manifest.bundle_size_bytes {
        return Err(ProducerError::BundleSizeMismatch {
            expected: manifest.bundle_size_bytes,
            actual: bundle_bytes.len() as u64,
        }
        .into());
    }

    // 4 + 5. SHA-256 of the bundle, then both grammar checks against it.
    let computed_bundle_sha = sha256_hex(bundle_bytes);
    if manifest.bundle_sha256 != computed_bundle_sha {
        return Err(ProducerError::BundleHashMismatch {
            expected: manifest.bundle_sha256.clone(),
            computed: computed_bundle_sha,
        }
        .into());
    }
    // Publication identity binds independently changing sidecar inputs while
    // bundle_sha256 continues to identify the PTB bytes alone. Schema-1
    // generations predate it: their id is the PTB hash.
    let id_bound = if manifest.manifest_schema_version == 1 {
        manifest.generation_id == computed_bundle_sha
    } else {
        crate::osm_manifest::valid_digest(&manifest.publication_inputs_sha256)
            && manifest.generation_id
                == crate::manifest::publication_id(
                    &computed_bundle_sha,
                    &manifest.publication_inputs_sha256,
                )
    };
    if !id_bound {
        return Err(ProducerError::GenerationIdHashMismatch.into());
    }

    // 6. feedStartDate pairing (manifest vs the bytes the reader actually
    //    parsed).  Disagreement means someone published an old PTB with a
    //    fresh manifest (or vice-versa).
    if manifest.feed_start_date != bundle_feed_start_date {
        return Err(ProducerError::FeedStartDateMismatch {
            manifest: manifest.feed_start_date,
            bundle: bundle_feed_start_date,
        }
        .into());
    }

    // 7. Transfers consistency. Four cases over (has_transfers, file
    //    present?). The error class differs by who's at fault: missing
    //    file with has_transfers=true is OPERATOR (failed to publish the
    //    pair), stale-carryover with has_transfers=false is PRODUCER
    //    (didn't GC the previous artifact).
    match (manifest.has_transfers, transfers_bytes) {
        (true, Some(b)) => {
            let expected_size = manifest.transfers_size_bytes.unwrap_or(0);
            if b.len() as u64 != expected_size {
                return Err(ProducerError::TransfersSizeMismatch {
                    expected: expected_size,
                    actual: b.len() as u64,
                }
                .into());
            }
            let computed = sha256_hex(b);
            // `Option::as_ref().map(|s| s.as_str())` lets us compare
            // against `manifest.transfers_sha256` without unwrapping its
            // `Option<String>`.
            if manifest.transfers_sha256.as_deref() != Some(computed.as_str()) {
                return Err(ProducerError::TransfersHashMismatch {
                    expected: manifest.transfers_sha256.clone().unwrap_or_default(),
                    computed,
                }
                .into());
            }
        }
        (true, None) => return Err(OperatorError::MissingTransfersFile.into()),
        (false, Some(_)) => return Err(ProducerError::StaleTransfersCarryover.into()),
        (false, None) => { /* clean — bundle has no transfers and none on disk */ }
    }

    // 8. createdAt clock skew.
    let tolerance = if is_startup {
        SKEW_TOLERANCE_STARTUP
    } else {
        SKEW_TOLERANCE_RELOAD
    };
    let parsed = parse_rfc3339(&manifest.created_at)
        .map_err(|_| ProducerError::CreatedAtMalformed(manifest.created_at.clone()))?;
    // We tolerate manifest "in the past" without bound — the staleness
    // check (FEED_STALE_DAYS) is the separate axis. Skew only fires when
    // the manifest claims to be from the FUTURE by more than `tolerance`.
    if parsed > now + tolerance {
        return Err(ProducerError::CreatedAtClockSkew {
            created_at: manifest.created_at.clone(),
            now: format_rfc3339(now),
        }
        .into());
    }
    Ok(())
}

/// Convenience wrapper that takes a `&dyn Clock` so callers don't have to
/// call `.now()` themselves. The reload runner uses this form.
pub fn validate_metadata_with_clock(
    manifest: &GenerationManifest,
    bundle_bytes: &[u8],
    transfers_bytes: Option<&[u8]>,
    expected_city: &str,
    bundle_feed_start_date: u32,
    clock: &dyn Clock,
    is_startup: bool,
) -> Result<(), ValidationError> {
    validate_metadata(
        manifest,
        bundle_bytes,
        transfers_bytes,
        expected_city,
        bundle_feed_start_date,
        clock.now(),
        is_startup,
    )
}

// ---------------------------------------------------------------------------
// SHA-256 helper
// ---------------------------------------------------------------------------

/// Lowercase-hex SHA-256 of `bytes`. Matches the producer's serializer
/// (`hex::encode(sha2::Sha256::digest(...))`).
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest.iter() {
        // The two-digit lowercase-hex encoding `hex::encode` produces.
        out.push(NIBBLE[(b >> 4) as usize] as char);
        out.push(NIBBLE[(b & 0x0f) as usize] as char);
    }
    out
}

const NIBBLE: &[u8; 16] = b"0123456789abcdef";

// ---------------------------------------------------------------------------
// RFC 3339 parsing — strict 20-char subset.
//
// The grammar producers MUST emit: YYYY-MM-DDTHH:MM:SSZ Lengths fixed; only the literal `T` and `Z`
// separators; no fractional seconds; no offset other than `Z`. A non-conforming input returns Err.
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct ParseRfc3339Err;

/// Parse a strict `YYYY-MM-DDTHH:MM:SSZ` UTC timestamp into a `SystemTime`.
fn parse_rfc3339(s: &str) -> Result<SystemTime, ParseRfc3339Err> {
    let bytes = s.as_bytes();
    if bytes.len() != 20 {
        return Err(ParseRfc3339Err);
    }
    // Layout check — separator positions are stable.
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return Err(ParseRfc3339Err);
    }
    if bytes[13] != b':' || bytes[16] != b':' || bytes[19] != b'Z' {
        return Err(ParseRfc3339Err);
    }
    let year = parse_int(&bytes[0..4])?;
    let month = parse_int(&bytes[5..7])?;
    let day = parse_int(&bytes[8..10])?;
    let hour = parse_int(&bytes[11..13])?;
    let minute = parse_int(&bytes[14..16])?;
    let second = parse_int(&bytes[17..19])?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        // second == 60 admitted for leap-second tolerance.
        return Err(ParseRfc3339Err);
    }
    // Howard-Hinnant days_from_civil — same algorithm pt-core uses for
    // service-window math. Output is days since 1970-01-01 UTC.
    let days = days_from_civil(year as i64, month as i64, day as i64);
    let unix = days * 86400 + (hour as i64) * 3600 + (minute as i64) * 60 + second as i64;
    if unix < 0 {
        return Err(ParseRfc3339Err);
    }
    Ok(SystemTime::UNIX_EPOCH + Duration::from_secs(unix as u64))
}

/// Format a `SystemTime` as `YYYY-MM-DDTHH:MM:SSZ`. Used in
/// [`ProducerError::CreatedAtClockSkew`] so the error message renders the
/// server's "now" in the SAME format the producer wrote — easier to spot
/// the discrepancy in logs.
fn format_rfc3339(t: SystemTime) -> String {
    let secs = t
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs() as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Parse a fixed-length ASCII-digit byte slice as a non-negative integer.
fn parse_int(bytes: &[u8]) -> Result<u32, ParseRfc3339Err> {
    let mut v: u32 = 0;
    for &b in bytes {
        if !b.is_ascii_digit() {
            return Err(ParseRfc3339Err);
        }
        v = v.checked_mul(10).ok_or(ParseRfc3339Err)?;
        v = v.checked_add((b - b'0') as u32).ok_or(ParseRfc3339Err)?;
    }
    Ok(v)
}

/// Howard-Hinnant `days_from_civil` — exact match to pt-core's
/// `days_from_civil`. Returns days since 1970-01-01.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Howard-Hinnant `civil_from_days` — inverse of `days_from_civil`.
/// Returns `(year, month, day)`.
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

#[cfg(test)]
mod rfc3339_tests {
    use super::*;

    #[test]
    fn parses_strict_subset() {
        let t = parse_rfc3339("2026-05-23T10:00:00Z").unwrap();
        let secs = t.duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs();
        // 2026-05-23T10:00:00Z is 1779004800-ish; compute by hand:
        // 2026-05-23 is 56*365.25 + 142 days ≈ 20596 days; 20596*86400 + 10*3600.
        // We don't pin the magic number, just sanity-check round-trip below.
        assert!(secs > 1_700_000_000, "post-2023 epoch");
    }

    #[test]
    fn rejects_wrong_length() {
        assert!(parse_rfc3339("2026-05-23T10:00:00").is_err()); // missing Z
        assert!(parse_rfc3339("2026-05-23T10:00:00.000Z").is_err()); // fractional
        assert!(parse_rfc3339("2026-05-23T10:00:00+00:00").is_err()); // offset
        assert!(parse_rfc3339("").is_err());
    }

    #[test]
    fn rejects_non_digits() {
        assert!(parse_rfc3339("2026-05-23T10:00:0XZ").is_err());
        assert!(parse_rfc3339("YYYY-05-23T10:00:00Z").is_err());
    }

    #[test]
    fn rejects_invalid_field_ranges() {
        assert!(parse_rfc3339("2026-13-23T10:00:00Z").is_err()); // month 13
        assert!(parse_rfc3339("2026-00-23T10:00:00Z").is_err()); // month 0
        assert!(parse_rfc3339("2026-05-32T10:00:00Z").is_err()); // day 32
        assert!(parse_rfc3339("2026-05-23T24:00:00Z").is_err()); // hour 24
    }

    #[test]
    fn civil_parity_vector_matches_pt_core() {
        // SAME (days, YYYYMMDD) pairs as pt-core's CIVIL_VECTORS — keeps the two
        // Howard-Hinnant copies aligned (the crates cannot import each other).
        for &(days, ymd) in &[
            (0i64, (1970i64, 1u32, 1u32)),
            (20574, (2026, 5, 1)),
            (20577, (2026, 5, 4)),
            (20578, (2026, 5, 5)),
            (19782, (2024, 2, 29)),
            (20483, (2026, 1, 30)),
        ] {
            let (y, m, d) = ymd;
            assert_eq!(days_from_civil(y, m as i64, d as i64), days);
            assert_eq!(civil_from_days(days), (y, m, d));
        }
    }

    /// `format_rfc3339(parse_rfc3339(x))` is the identity over the grammar.
    /// This guards the date-arithmetic helpers' inverse property — a wrong
    /// civil_from_days would surface here as a date drift.
    #[test]
    fn format_parse_roundtrip() {
        for s in [
            "2026-05-23T10:00:00Z",
            "1970-01-01T00:00:00Z",
            "2000-02-29T23:59:59Z", // leap day, day 29
            "2024-02-29T12:34:56Z", // leap day, recent
            "2099-12-31T23:59:59Z",
        ] {
            let t = parse_rfc3339(s).unwrap_or_else(|e| panic!("parse({s}) failed: {e:?}"));
            let back = format_rfc3339(t);
            assert_eq!(back, s, "round-trip mismatch for {s}");
        }
    }
}
