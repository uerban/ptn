//! PTB v2 service-day time: the `0x18 ServiceDayOrigins` table, absolute-time
//! resolution and the 48-hour completeness horizon.
//!
//! GTFS defines `Time` as elapsed seconds from local noon minus 12 hours on the
//! service date (<https://gtfs.org/documentation/schedule/reference/#field-types>),
//! which differs from local midnight on DST transition dates. The producer
//! resolves the IANA zone once and writes one absolute origin per civil date, so
//! `pt-core` needs no timezone database:
//!
//! ```text
//! event_unix    = origin[trip_service_date] + trip_stop_time_secs
//! timeline_secs = event_unix - origin[query.date]
//! ```
//!
//! Every v2 routing comparison uses `timeline_secs`, a monotonic elapsed-second
//! coordinate. All arithmetic is checked; overflow is a typed error, never a
//! saturated value or a dropped branch.

use crate::engine::types::EngineError;
use crate::Reader;

/// V2 fixed completeness horizon: every candidate of a v2 journey occurs no
/// later than `departure + ROUTING_HORIZON_SECS` (48 elapsed hours). A routing
/// contract constant, not an operational knob.
pub const ROUTING_HORIZON_SECS: i64 = 172_800;

/// Longest scheduled wait a linked continuation may have between the source
/// trip's arrival and the target trip's departure. In-seat and re-board
/// connections are a few hours at most; a longer scheduled gap is a feed
/// inconsistency, so the link is dropped instead of attaching to a run a day
/// later. A policy constant, not an operational knob.
pub const MAX_LINK_WAIT_SECS: i64 = 4 * 3600;

/// The resolved service date and origin for one absolute departure instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeResolution {
    /// `YYYYMMDD` of the selected service date (`feedStartDate + ordinal`).
    pub service_date: u32,
    /// Ordinal of that date in the origin table.
    pub date_ordinal: u32,
    /// `origin[ordinal]`: the Unix instant of local noon minus 12 h.
    pub time_origin_unix: i64,
    /// `departure_unix - time_origin_unix`; non-negative and below the next
    /// origin, so both fall-overlap instants stay distinct.
    pub departure_secs: i64,
}

/// Number of routable service dates (`effectiveWindowDays`): the origin table
/// has one more entry, the exclusive next-date origin.
#[inline]
pub(crate) fn routable_dates<B: AsRef<[u8]> + Send + Sync + 'static>(r: &Reader<B>) -> usize {
    r.num_service_day_origins().saturating_sub(1)
}

/// `origin[i]` or a typed corruption error (the reader validated the table, so
/// this only fails for an out-of-range ordinal).
#[inline]
pub(crate) fn origin<B: AsRef<[u8]> + Send + Sync + 'static>(
    r: &Reader<B>,
    i: usize,
) -> Result<i64, EngineError> {
    r.service_day_origin(i).ok_or(EngineError::Corrupt(
        "service_day_origin ordinal out of range",
    ))
}

/// Resolve `departure_unix` to the unique routable interval
/// `origin[i] <= departure_unix < origin[i+1]`. An instant outside every
/// routable interval is [`EngineError::UnsupportedServiceDate`]; a v1 bundle has
/// no origins and is [`EngineError::UnsupportedVersion`].
pub fn resolve_time<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    departure_unix: i64,
) -> Result<TimeResolution, EngineError> {
    if !reader.is_v2() {
        return Err(EngineError::UnsupportedVersion);
    }
    let n = routable_dates(reader);
    if n == 0 {
        return Err(EngineError::UnsupportedServiceDate);
    }
    if departure_unix < origin(reader, 0)? || departure_unix >= origin(reader, n)? {
        return Err(EngineError::UnsupportedServiceDate);
    }
    // Largest i in [0, n) with origin[i] <= departure_unix.
    let (mut lo, mut hi) = (0usize, n);
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if origin(reader, mid)? <= departure_unix {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let o = origin(reader, lo)?;
    let date = crate::reader::days_add(reader.feed_start_date(), lo as i64);
    Ok(TimeResolution {
        service_date: date,
        date_ordinal: lo as u32,
        time_origin_unix: o,
        departure_secs: departure_unix
            .checked_sub(o)
            .ok_or(EngineError::TimeOverflow)?,
    })
}

/// The ordinal of `yyyymmdd` in the origin table, if it is a routable date.
pub(crate) fn date_ordinal<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    yyyymmdd: u32,
) -> Option<usize> {
    let start = crate::reader::days_from_civil(reader.feed_start_date());
    let d = crate::reader::days_from_civil(yyyymmdd);
    let off = d.checked_sub(start)?;
    if off < 0 || off as usize >= routable_dates(reader) {
        return None;
    }
    // Reject a non-canonical date that round-trips to another value.
    if crate::reader::days_add(reader.feed_start_date(), off) != yyyymmdd {
        return None;
    }
    Some(off as usize)
}

/// A v2 query's absolute frame: the query origin, the departure instant and
/// the inclusive journey deadline, all in Unix seconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct QueryFrame {
    pub date_ordinal: usize,
    pub origin_unix: i64,
    pub departure_unix: i64,
    pub deadline_unix: i64,
}

impl QueryFrame {
    /// Timeline seconds (relative to the query origin) of an absolute instant.
    #[inline]
    pub fn timeline(&self, unix: i64) -> Result<i64, EngineError> {
        unix.checked_sub(self.origin_unix)
            .ok_or(EngineError::TimeOverflow)
    }
}

/// Build and guard the query frame. `max_event_secs` is the index's
/// `max_encoded_event_secs`. Fails with `UnsupportedServiceDate` when the date
/// is not routable and `IncompleteHorizon` when either data guard fails:
///
/// ```text
/// Q >= origin[0] + max_encoded_event_secs
/// Q + ROUTING_HORIZON_SECS < origin[effectiveWindowDays]
/// ```
pub(crate) fn query_frame<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    yyyymmdd: u32,
    departure_secs: i64,
    max_event_secs: i64,
) -> Result<QueryFrame, EngineError> {
    let ord = date_ordinal(reader, yyyymmdd).ok_or(EngineError::UnsupportedServiceDate)?;
    let o = origin(reader, ord)?;
    if departure_secs < 0 {
        return Err(EngineError::UnsupportedServiceDate);
    }
    let q = o
        .checked_add(departure_secs)
        .ok_or(EngineError::TimeOverflow)?;
    let n = routable_dates(reader);
    // The departure must fall in a routable origin interval.
    if q >= origin(reader, n)? {
        return Err(EngineError::UnsupportedServiceDate);
    }
    let lower = origin(reader, 0)?
        .checked_add(max_event_secs)
        .ok_or(EngineError::TimeOverflow)?;
    let deadline = q
        .checked_add(ROUTING_HORIZON_SECS)
        .ok_or(EngineError::TimeOverflow)?;
    if q < lower || deadline >= origin(reader, n)? {
        return Err(EngineError::IncompleteHorizon);
    }
    Ok(QueryFrame {
        date_ordinal: ord,
        origin_unix: o,
        departure_unix: q,
        deadline_unix: deadline,
    })
}

/// Service-date ordinals whose events can fall in `[from_unix, to_unix]`, given
/// the index's event range: dates `d` with `origin[d] + min_event <= to_unix`
/// and `origin[d] + max_event >= from_unix`. Walks the origin table rather than
/// dividing by 86,400, so DST dates and times above 24:00 are exact.
///
/// The reader rejects origins that are not strictly increasing, so the first
/// condition holds on a prefix of the dates and the second on a suffix: two
/// binary searches find the same range a scan of every date would. An overflow
/// at any date implies one at the first or last date, checked first, so the
/// errors match the scan's too.
pub(crate) fn candidate_dates<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    from_unix: i64,
    to_unix: i64,
    min_event: i64,
    max_event: i64,
) -> Result<core::ops::Range<usize>, EngineError> {
    let n = routable_dates(reader);
    if n == 0 {
        return Ok(0..0);
    }
    for d in [0, n - 1] {
        let o = origin(reader, d)?;
        o.checked_add(min_event).ok_or(EngineError::TimeOverflow)?;
        o.checked_add(max_event).ok_or(EngineError::TimeOverflow)?;
    }
    // First date at which `starts` holds; `starts` is false then true.
    let partition = |starts: &dyn Fn(i64) -> bool| -> Result<usize, EngineError> {
        let (mut lo, mut hi) = (0usize, n);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if starts(origin(reader, mid)?) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        Ok(lo)
    };
    // Both sums were range-checked at the extremes above.
    let lo = partition(&|o| o + max_event >= from_unix)?;
    let hi = partition(&|o| o + min_event > to_unix)?;
    if lo >= hi {
        return Ok(0..0);
    }
    Ok(lo..hi)
}

/// The linear scan `candidate_dates` replaced, kept as its test oracle.
#[cfg(test)]
pub(crate) fn candidate_dates_by_scan<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    from_unix: i64,
    to_unix: i64,
    min_event: i64,
    max_event: i64,
) -> Result<core::ops::Range<usize>, EngineError> {
    let n = routable_dates(reader);
    let mut lo = n;
    let mut hi = 0usize;
    for d in 0..n {
        let o = origin(reader, d)?;
        let first = o.checked_add(min_event).ok_or(EngineError::TimeOverflow)?;
        let last = o.checked_add(max_event).ok_or(EngineError::TimeOverflow)?;
        if first <= to_unix && last >= from_unix {
            lo = lo.min(d);
            hi = hi.max(d + 1);
        }
    }
    if lo >= hi {
        return Ok(0..0);
    }
    Ok(lo..hi)
}

/// First routable date `j` with `origin[j] + secs >= scheduled_unix` (binary
/// search over the full origin table), or `None` when no routable date
/// qualifies. `scheduled_unix` is the source trip's scheduled arrival, so `j` is
/// the scheduled successor's service date. This is the sole calendar candidate
/// for a linked continuation: the caller never advances to a later active date
/// when `j` is inactive, and never re-dates a connection whose scheduled layover
/// is shorter than its minimum transfer time.
pub(crate) fn first_date_at_or_after<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    secs: i64,
    scheduled_unix: i64,
) -> Result<Option<usize>, EngineError> {
    let n = routable_dates(reader);
    let (mut lo, mut hi) = (0usize, n);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        let t = origin(reader, mid)?
            .checked_add(secs)
            .ok_or(EngineError::TimeOverflow)?;
        if t >= scheduled_unix {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    Ok((lo < n).then_some(lo))
}
