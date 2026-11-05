//! Shared city-timezone offset computation. The producer bakes
//! `cityTzOffsetSeconds` into the PTB header and pt-serve cross-checks it at
//! load; BOTH sides MUST compute the offset identically or every publish fails
//! the cross-check. This is the single source of that computation.

use jiff::{civil::Date, tz::TimeZone};

/// Version of the exact bundled IANA database used by [`resolve_time_zone`].
/// Exposed for pt-serve's freshness guard; never inferred from the host OS.
pub const IANA_TZDB_VERSION: &str = match jiff_tzdb::VERSION {
    Some(version) => version,
    None => panic!("the pinned timezone database must have a release identifier"),
};

/// Resolve an IANA name from the pinned bundle, retaining case-sensitive name
/// validation. No host filesystem, TZ environment lookup, or process-global
/// parsed-zone cache: each generation owns just its resolved city zone.
pub fn resolve_time_zone(iana: &str) -> Result<TimeZone, TzOffsetError> {
    let (name, bytes) = jiff_tzdb::get(iana).ok_or(TzOffsetError::UnknownIana)?;
    if name != iana {
        return Err(TzOffsetError::UnknownIana);
    }
    TimeZone::tzif(name, bytes).map_err(|_| TzOffsetError::UnknownIana)
}

/// Decode a YYYYMMDD anchor without truncating an out-of-range year to i16.
/// GTFS dates have four-digit years:
/// <https://gtfs.org/documentation/schedule/reference/#field-types>.
pub fn date_from_ymd(yyyymmdd: u32) -> Option<Date> {
    Date::new(
        i16::try_from(yyyymmdd / 10000).ok()?,
        ((yyyymmdd / 100) % 100) as i8,
        (yyyymmdd % 100) as i8,
    )
    .ok()
}

/// Errors resolving a city tz offset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TzOffsetError {
    /// `iana` is not a parseable IANA tz name.
    UnknownIana,
    /// `yyyymmdd` does not decompose to a valid calendar date.
    BadDate,
}

/// UTC offset (seconds) for `iana` at midnight UTC of the `yyyymmdd` anchor
/// date. This is the static anchor-date snapshot baked into the PTB header — NOT
/// a DST-correct runtime offset (see the header field docs).
pub fn offset_at_anchor(iana: &str, yyyymmdd: u32) -> Result<i32, TzOffsetError> {
    let tz = resolve_time_zone(iana)?;
    let midnight = date_from_ymd(yyyymmdd)
        .ok_or(TzOffsetError::BadDate)?
        .at(0, 0, 0, 0)
        .to_zoned(TimeZone::UTC)
        .map_err(|_| TzOffsetError::BadDate)?
        .timestamp();
    Ok(tz.to_offset(midnight).seconds())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vilnius_eest_summer() {
        // Europe/Vilnius on 2026-05-01 = EEST = UTC+3 = 10800.
        assert_eq!(offset_at_anchor("Europe/Vilnius", 20260501), Ok(10800));
    }

    #[test]
    fn tbilisi_year_round_plus4() {
        assert_eq!(offset_at_anchor("Asia/Tbilisi", 20260501), Ok(14400));
    }

    #[test]
    fn unknown_iana_errs() {
        assert_eq!(
            offset_at_anchor("Bogus/Nowhere", 20260501),
            Err(TzOffsetError::UnknownIana)
        );
    }

    #[test]
    fn bad_date_errs() {
        assert_eq!(
            offset_at_anchor("UTC", 20261332),
            Err(TzOffsetError::BadDate)
        );
    }

    #[test]
    fn bundled_names_preserve_aliases_and_case_validation() {
        assert!(resolve_time_zone("US/Eastern").is_ok());
        assert!(resolve_time_zone("UTC").is_ok());
        assert!(resolve_time_zone("europe/vilnius").is_err());
        assert!(resolve_time_zone(" Europe/Vilnius").is_err());
    }

    #[test]
    fn dates_reject_out_of_range_years_without_wrapping() {
        assert!(date_from_ymd(99991231).is_some());
        assert!(date_from_ymd(100000101).is_none());
        assert!(date_from_ymd(675620101).is_none()); // would wrap to year 2026
        assert!(date_from_ymd(u32::MAX).is_none());
        assert!(date_from_ymd(20260229).is_none());
    }

    #[test]
    fn offsets_use_the_utc_anchor_even_on_a_transition_day() {
        assert_eq!(offset_at_anchor("Europe/Vilnius", 20260329), Ok(7200));
        assert_eq!(offset_at_anchor("Europe/Vilnius", 20261025), Ok(10800));
    }
}
