//! Legacy civil-service-day-seconds → Unix projection with frozen DST policy.
//!
//! This compatibility surface and the TS mirror timeDomain.ts interpret
//! seconds from civil midnight: folds choose the earlier instant, gaps shift
//! forward by the transition's duration. Negative seconds and values >86400
//! move the civil date before timezone resolution.
//!
//! Jiff's explicit compatible disambiguation implements this policy without
//! sampling offsets three hours away from the gap. The committed cross-language
//! fixture (packages/shared/tests/__fixtures__/tz-cases.json, originally
//! generated with chrono-tz) freezes the expected results.
//!
//! PTB v2 GTFS origins are a separate contract: local noon minus 12 elapsed
//! hours, emitted by pt-producer. Do not substitute this legacy projection for
//! those origins: <https://gtfs.org/documentation/schedule/reference/#field-types>.

use jiff::{civil::Date, tz::TimeZone, SignedDuration};

/// Errors projecting a (service_date, secs) pair to Unix seconds.
#[derive(Debug, PartialEq, Eq)]
pub enum TimeDomainError {
    /// Civil arithmetic or timezone projection exceeded Jiff's date range.
    BadDate,
}

/// Apply the frozen civil-time DST policy, including overnight/negative secs.
pub fn service_day_to_unix(
    date: Date,
    secs_of_service_day: i64,
    tz: &TimeZone,
) -> Result<i64, TimeDomainError> {
    let local = date
        .at(0, 0, 0, 0)
        .checked_add(SignedDuration::from_secs(secs_of_service_day))
        .map_err(|_| TimeDomainError::BadDate)?;
    tz.to_ambiguous_timestamp(local)
        .compatible()
        .map(|timestamp| timestamp.as_second())
        .map_err(|_| TimeDomainError::BadDate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use jiff::tz::AmbiguousOffset;
    use pt_shared::tz::resolve_time_zone;

    fn ymd(y: i16, m: i8, d: i8) -> Date {
        Date::new(y, m, d).unwrap()
    }

    fn utc_unix(y: i16, m: i8, d: i8, hh: i8, mm: i8, ss: i8) -> i64 {
        ymd(y, m, d)
            .at(hh, mm, ss, 0)
            .to_zoned(TimeZone::UTC)
            .unwrap()
            .timestamp()
            .as_second()
    }

    #[test]
    fn plain_winter_day() {
        let paris = resolve_time_zone("Europe/Paris").unwrap();
        let date = ymd(2026, 1, 15);
        assert!(matches!(
            paris.to_ambiguous_timestamp(date.at(12, 0, 0, 0)).offset(),
            AmbiguousOffset::Unambiguous { .. }
        ));
        assert_eq!(
            service_day_to_unix(date, 12 * 3600, &paris).unwrap(),
            utc_unix(2026, 1, 15, 11, 0, 0)
        );
    }

    #[test]
    fn overnight_past_86400() {
        let paris = resolve_time_zone("Europe/Paris").unwrap();
        assert_eq!(
            service_day_to_unix(ymd(2026, 1, 15), 25 * 3600 + 30 * 60, &paris).unwrap(),
            utc_unix(2026, 1, 16, 0, 30, 0)
        );
    }

    #[test]
    fn spring_forward_gap_is_none_then_snapped() {
        let paris = resolve_time_zone("Europe/Paris").unwrap();
        let date = ymd(2026, 3, 29);
        assert!(matches!(
            paris.to_ambiguous_timestamp(date.at(2, 30, 0, 0)).offset(),
            AmbiguousOffset::Gap { .. }
        ));
        let got = service_day_to_unix(date, 2 * 3600 + 30 * 60, &paris).unwrap();
        assert_eq!(got, utc_unix(2026, 3, 29, 1, 30, 0));
        assert_eq!(
            got,
            paris
                .to_timestamp(date.at(3, 30, 0, 0))
                .unwrap()
                .as_second()
        );
    }

    #[test]
    fn fall_back_overlap_is_ambiguous_takes_earlier() {
        let vilnius = resolve_time_zone("Europe/Vilnius").unwrap();
        let date = ymd(2026, 10, 25);
        let ambiguous = vilnius.to_ambiguous_timestamp(date.at(3, 30, 0, 0));
        assert!(matches!(ambiguous.offset(), AmbiguousOffset::Fold { .. }));
        assert!(ambiguous.earlier().unwrap() < ambiguous.later().unwrap());
        assert_eq!(
            service_day_to_unix(date, 3 * 3600 + 30 * 60, &vilnius).unwrap(),
            utc_unix(2026, 10, 25, 0, 30, 0)
        );
    }

    #[test]
    fn tbilisi_no_dst_stable_offset() {
        let tbilisi = resolve_time_zone("Asia/Tbilisi").unwrap();
        for date in [ymd(2026, 1, 15), ymd(2026, 7, 15)] {
            assert!(matches!(
                tbilisi
                    .to_ambiguous_timestamp(date.at(12, 0, 0, 0))
                    .offset(),
                AmbiguousOffset::Unambiguous { .. }
            ));
            assert_eq!(
                service_day_to_unix(date, 12 * 3600, &tbilisi).unwrap(),
                utc_unix(date.year(), date.month(), date.day(), 8, 0, 0)
            );
        }
    }

    #[test]
    fn extreme_seconds_return_errors_without_panicking() {
        for seconds in [i64::MIN, i64::MAX] {
            assert_eq!(
                service_day_to_unix(ymd(2026, 1, 15), seconds, &TimeZone::UTC),
                Err(TimeDomainError::BadDate)
            );
        }
        assert!(service_day_to_unix(Date::MIN, -1, &TimeZone::UTC).is_err());
        assert!(service_day_to_unix(Date::MAX, 86400, &TimeZone::UTC).is_err());
    }
}
