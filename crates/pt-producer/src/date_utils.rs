/// Howard Hinnant's civil calendar algorithm: days since Unix epoch (1970-01-01)
/// → (year, month, day). No external crate needed.
///
/// Reference: <https://howardhinnant.github.io/date_algorithms.html>
pub fn civil_from_days(z0: i64) -> (i64, u32, u32) {
    let z = z0 + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Returns today's UTC date as YYYYMMDD (e.g. 20260521), computed from the
/// system clock without any external date crate. Uses UTC, so near midnight
/// the rolling-window anchor can differ by ±1 day from operator-local time —
/// acceptable for the coarse 90-day window.
pub fn today_yyyymmdd() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    (y as u32) * 10_000 + m * 100 + d
}

/// Returns `true` if `year` is a leap year in the proleptic Gregorian calendar.
fn is_leap_year(year: u32) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

/// Returns the number of days in `month` (1-indexed) of `year`.
fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap_year(year) {
                29
            } else {
                28
            }
        }
        _ => 0, // invalid month — caller checks month range first
    }
}

/// Validates a YYYYMMDD value as a plausible anchor date.
///
/// Accepts years 2000..=2100, months 1..=12, and days 1..=days_in_month
/// (with a proper leap-year check for February). Rejects impossible dates
/// such as Feb 30 or Apr 31.
pub fn validate_yyyymmdd(v: u32) -> Result<(), String> {
    let (y, m, d) = (v / 10_000, (v / 100) % 100, v % 100);
    if v == 0
        || !(2000..=2100).contains(&y)
        || !(1..=12).contains(&m)
        || d < 1
        || d > days_in_month(y, m)
    {
        Err(format!(
            "invalid --anchor-date {v}: expected a YYYYMMDD date in 2000..=2100 \
             (got year={y} month={m} day={d})"
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_from_days_known_dates() {
        // Unix epoch = day 0 → 1970-01-01
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2000-03-01: days since 1970-01-01 = 11017
        // Verified: (2000 - 1970) * 365 + leap_days + day-of-year offset
        assert_eq!(civil_from_days(11017), (2000, 3, 1));
        // 2026-05-21: days since 1970-01-01 = 20594
        assert_eq!(civil_from_days(20594), (2026, 5, 21));
    }

    #[test]
    fn civil_from_days_leap_day_2000() {
        // 2000-02-29 (leap year): day 11016
        assert_eq!(civil_from_days(11016), (2000, 2, 29));
    }

    #[test]
    fn validate_yyyymmdd_accepts_valid_date() {
        assert!(validate_yyyymmdd(20260501).is_ok());
        assert!(validate_yyyymmdd(20000101).is_ok());
        assert!(validate_yyyymmdd(21001231).is_ok());
    }

    #[test]
    fn validate_yyyymmdd_rejects_zero() {
        let err = validate_yyyymmdd(0).unwrap_err();
        assert!(err.contains("invalid --anchor-date 0"), "unexpected: {err}");
    }

    #[test]
    fn validate_yyyymmdd_rejects_day_out_of_range() {
        // day=32: 20260132
        let err = validate_yyyymmdd(20260132).unwrap_err();
        assert!(err.contains("20260132"), "unexpected: {err}");
    }

    #[test]
    fn validate_yyyymmdd_rejects_month_out_of_range() {
        // month=13: 20261301
        let err = validate_yyyymmdd(20261301).unwrap_err();
        assert!(err.contains("20261301"), "unexpected: {err}");
    }

    #[test]
    fn validate_yyyymmdd_rejects_bogus_value() {
        // 99999999: year=9999 > 2100
        let err = validate_yyyymmdd(99999999).unwrap_err();
        assert!(err.contains("99999999"), "unexpected: {err}");
    }

    #[test]
    fn validate_yyyymmdd_rejects_year_too_old() {
        // 19700101: year=1970 < 2000
        let err = validate_yyyymmdd(19700101).unwrap_err();
        assert!(err.contains("19700101"), "unexpected: {err}");
    }

    #[test]
    fn validate_yyyymmdd_rejects_feb30() {
        let err = validate_yyyymmdd(20260230).unwrap_err();
        assert!(err.contains("20260230"), "unexpected: {err}");
    }

    #[test]
    fn validate_yyyymmdd_rejects_apr31() {
        let err = validate_yyyymmdd(20260431).unwrap_err();
        assert!(err.contains("20260431"), "unexpected: {err}");
    }

    #[test]
    fn validate_yyyymmdd_rejects_non_leap_feb29() {
        // 2027 is not a leap year
        let err = validate_yyyymmdd(20270229).unwrap_err();
        assert!(err.contains("20270229"), "unexpected: {err}");
    }

    #[test]
    fn validate_yyyymmdd_accepts_leap_feb29() {
        // 2024 is a leap year
        assert!(validate_yyyymmdd(20240229).is_ok());
    }

    #[test]
    fn validate_yyyymmdd_accepts_feb28() {
        assert!(validate_yyyymmdd(20260228).is_ok());
    }

    #[test]
    fn validate_yyyymmdd_accepts_apr30() {
        assert!(validate_yyyymmdd(20260430).is_ok());
    }

    #[test]
    fn validate_yyyymmdd_accepts_dec31() {
        assert!(validate_yyyymmdd(20261231).is_ok());
    }

    #[test]
    fn today_yyyymmdd_is_plausible() {
        let d = today_yyyymmdd();
        // Must be a date after 2020-01-01 (sanity)
        assert!(d >= 20_200_101, "today_yyyymmdd={d} predates 2020");
        // Year component
        let y = d / 10_000;
        assert!(y >= 2020 && y <= 2100, "year={y} out of plausible range");
        // Month [1..12]
        let m = (d / 100) % 100;
        assert!(m >= 1 && m <= 12, "month={m} out of range");
        // Day [1..31]
        let day = d % 100;
        assert!(day >= 1 && day <= 31, "day={day} out of range");
    }
}
