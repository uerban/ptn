//! Runtime tzdb horizon check.
//!
//! `pt_shared::tz::IANA_TZDB_VERSION` identifies our pinned bundled database.
//! The IANA release identifier format is `YYYY<letter>` where the letter is roughly
//! the Nth release in that year (a=Jan-ish, b=Feb-ish, …). The exact day
//! varies — we approximate via the table below (updated when a new release
//! ships; an unknown version falls back to YYYY-01-01 + N*30 days, with a
//! WARN log).
//!
//! Horizon: > 12 months old = WARN log + Prometheus gauge; > 24 months old =
//! exit(1). Forces operators to rebuild the image to pick up newer releases.

use jiff::{civil::Date, tz::TimeZone, Timestamp, ToSpan};
use pt_shared::tz::IANA_TZDB_VERSION;

const TZDB_WARN_AGE_DAYS: i64 = 365;
const TZDB_HARD_EXPIRY_DAYS: i64 = 365 * 2;

/// Approximate release dates for known IANA tzdb versions. Keep current
/// when bumping jiff-tzdb; an unknown version logs a WARN and uses the
/// year-+-letter heuristic.
const KNOWN_RELEASES: &[(&str, &str)] = &[
    ("2023a", "2023-03-23"),
    ("2023b", "2023-09-03"),
    ("2023c", "2023-09-12"),
    ("2023d", "2023-12-21"),
    ("2024a", "2024-02-01"),
    ("2024b", "2024-09-04"),
    ("2025a", "2025-01-15"),
    ("2025b", "2025-03-22"),
    // Source: https://data.iana.org/time-zones/releases/
    ("2026e", "2026-09-29"),
];

#[derive(Debug, thiserror::Error)]
pub enum TzdbError {
    #[error("tzdb release {version:?} expired ({age_days} days old > {limit} day hard expiry)")]
    Expired {
        version: String,
        age_days: i64,
        limit: i64,
    },
}

/// Thin wrapper — reads the wall clock and delegates to [`check_horizon_at`].
pub fn check_horizon() -> Result<i64, TzdbError> {
    check_horizon_at(Timestamp::now().to_zoned(TimeZone::UTC).date())
}

/// Core logic: compute the tzdb release age relative to `today` and return
/// `Ok(age_days)` or `Err(Expired)`. Factored out so the WARN/Expired
/// thresholds are unit-testable without mocking the wall clock.
pub fn check_horizon_at(today: Date) -> Result<i64, TzdbError> {
    let version = IANA_TZDB_VERSION;
    let release_date = parse_release_date(version);
    let age_days = i64::from(
        today
            .since(release_date)
            .expect("difference of valid dates")
            .get_days(),
    );
    if age_days > TZDB_HARD_EXPIRY_DAYS {
        return Err(TzdbError::Expired {
            version: version.to_string(),
            age_days,
            limit: TZDB_HARD_EXPIRY_DAYS,
        });
    }
    if age_days > TZDB_WARN_AGE_DAYS {
        eprintln!(
            "pt-serve: WARN tzdb {version:?} is {age_days} days old (> {TZDB_WARN_AGE_DAYS} day \
             threshold); rebuild pt-serve to pick up a newer jiff-tzdb release."
        );
    }
    Ok(age_days)
}

fn parse_release_date(version: &str) -> Date {
    if let Some((_, date_str)) = KNOWN_RELEASES.iter().find(|(v, _)| *v == version) {
        if let Ok(d) = date_str.parse::<Date>() {
            return d;
        }
    }
    // Fallback: YYYY-01-01 + (letter_idx * 30) days, clamped to Dec 31 of
    // the same year. Imprecise but monotonic within the year; better than
    // panicking on an unknown release name.
    eprintln!(
        "pt-serve: WARN tzdb release {version:?} not in KNOWN_RELEASES table; \
         using YYYY+letter*30d heuristic"
    );
    // Use version.get(..4) rather than version[..4] so a short or non-ASCII
    // version string doesn't panic in this "never panic on unknown release" path.
    let year: i16 = version
        .get(..4)
        .and_then(|s| s.parse().ok())
        .unwrap_or(2024);
    let letter_idx = version
        .as_bytes()
        .get(4)
        .map(|b| (b.saturating_sub(b'a')) as i64)
        .unwrap_or(0);
    let jan1 = Date::new(year, 1, 1).unwrap_or(Date::constant(2024, 1, 1));
    let dec31 = Date::new(jan1.year(), 12, 31).unwrap();
    let candidate = jan1.checked_add((letter_idx * 30).days()).unwrap_or(dec31);
    candidate.min(dec31)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_release_resolves() {
        let d = parse_release_date("2024a");
        assert_eq!(d, Date::new(2024, 2, 1).unwrap());
        assert!(KNOWN_RELEASES
            .iter()
            .any(|(version, _)| *version == IANA_TZDB_VERSION));
        assert_eq!(parse_release_date("2026e"), Date::constant(2026, 9, 29));
    }

    #[test]
    fn unknown_release_falls_back_to_heuristic() {
        let d = parse_release_date("2999z");
        assert_eq!(d.year(), 2999);
        for version in ["", "💥", "9999z", "not-a-release"] {
            let _ = parse_release_date(version);
        }
    }

    #[test]
    fn horizon_730d_is_still_valid() {
        let today = parse_release_date(IANA_TZDB_VERSION) + TZDB_HARD_EXPIRY_DAYS.days();
        assert_eq!(check_horizon_at(today).unwrap(), TZDB_HARD_EXPIRY_DAYS);
    }

    // Boundary tests for check_horizon_at. We use the ACTUAL compiled-in
    // release date (from parse_release_date on IANA_TZDB_VERSION) as the
    // anchor so these pass regardless of which jiff-tzdb release is current.
    // ok(age) up to TZDB_HARD_EXPIRY_DAYS inclusive; Err(Expired) at +1.

    #[test]
    fn horizon_364d_is_ok() {
        // 364 days after release: below the WARN threshold → Ok.
        let release = parse_release_date(IANA_TZDB_VERSION);
        let today = release + 364.days();
        assert!(check_horizon_at(today).is_ok());
    }

    #[test]
    fn horizon_366d_is_ok_warn_path() {
        // 366 days: over the 365-day WARN threshold but under the 730-day
        // hard expiry — still Ok (WARN is a log side-effect, not an Err).
        let release = parse_release_date(IANA_TZDB_VERSION);
        let today = release + 366.days();
        assert!(check_horizon_at(today).is_ok());
    }

    #[test]
    fn horizon_729d_is_ok() {
        // One day before the hard expiry boundary → Ok.
        let release = parse_release_date(IANA_TZDB_VERSION);
        let today = release + (TZDB_HARD_EXPIRY_DAYS - 1).days();
        assert!(check_horizon_at(today).is_ok());
    }

    #[test]
    fn horizon_731d_is_expired() {
        // One day past the hard expiry boundary → Err(Expired).
        let release = parse_release_date(IANA_TZDB_VERSION);
        let today = release + (TZDB_HARD_EXPIRY_DAYS + 1).days();
        let result = check_horizon_at(today);
        match result {
            Err(TzdbError::Expired { age_days, .. }) => {
                assert_eq!(age_days, TZDB_HARD_EXPIRY_DAYS + 1);
            }
            other => panic!("expected Expired, got {other:?}"),
        }
    }
}
