// crates/pt-serve/src/rt/parser.rs

//! Decodes a GTFS-RT `FeedMessage` protobuf into the same `{tripId ->
//! TripUpdate}` (and `{tripId|startDate -> TripUpdate}`) map that
//! `packages/backend/src/gtfs/realtime.ts`'s `parseTripUpdatesBuffer`
//! produces. Started as a faithful port of ITS behavior, not a general
//! GTFS-RT decoder — see the plan's field-map reference for exactly which
//! fields are read.
//!
//! DIVERGES from Node since 2026-09-26, on how a feed says a scheduled bus
//! will not run and on the trip delay around updates that carry none.
//! Node's
//! per-city serving code carries no production traffic and is not extended:
//! - `cancelled` is also set for a trip whose every StopTimeUpdate is
//!   `SKIPPED` — Node reads `CANCELED` (3) only.
//! - A trip `DELETED` (TripDescriptor ScheduleRelationship 7) sets `deleted`,
//!   not `cancelled`: the spec wants it removed, "not shown as cancelled to
//!   riders". Node treats it as running.
//! - `delay_seconds` is the last StopTimeUpdate that CARRIES a delay and is
//!   served (not `SKIPPED` / `NO_DATA`), then `TripUpdate.delay` (field 5),
//!   then 0 — Node takes the last update's delay-or-0, so a `NO_DATA` or
//!   time-less `SKIPPED` tail reset a late trip to on time.
//! - A served update with a predicted time and no delay, when it is the last
//!   one carrying either, is kept as a [`TimePrediction`] for the poll cycle to
//!   resolve against the bundle (`rt::resolve`); `delay_seconds` holds the
//!   fallback above meanwhile. Node reads `delay` only, so a feed that sends
//!   times (krakow's trams, most of its buses) read as on time.
//!
//! GTFS-Realtime reference: <https://gtfs.org/documentation/realtime/reference/>
//! Canonical protobuf schema:
//! <https://github.com/google/transit/blob/master/gtfs-realtime/proto/gtfs-realtime.proto>

use crate::rt::protobuf::Reader;
use jiff::civil::Date;
use std::collections::HashMap;

pub const MAX_DELAY_SECONDS: i32 = 1800;
pub const MIN_DELAY_SECONDS: i32 = -1800;

/// A predicted time with no delay (`StopTimeEvent.time` only), at the last
/// served stop that carries a prediction — waiting for the poll cycle to turn
/// it into a delay against the bundle (`rt::resolve`). Never published: the
/// runner resolves or drops it before a snapshot goes out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimePrediction {
    pub stop_id: Box<str>,
    /// POSIX seconds, `departure.time ?? arrival.time`.
    pub time: i64,
    /// The entity's `TripDescriptor.start_date`, kept here because the same
    /// update is also stored under the bare trip id, which loses it.
    pub start_date: Option<Date>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TripUpdate {
    pub delay_seconds: i32,
    /// The run will not happen and riders are told so: `CANCELED`, or every
    /// stop `SKIPPED`.
    pub cancelled: bool,
    /// The run is removed and must not be shown to riders — not even as
    /// cancelled (`DELETED`, e.g. replaced by substitute service). Never
    /// offered, never listed on a board.
    pub deleted: bool,
    /// Set by the parser when the trip's last prediction is a time with no
    /// delay; `delay_seconds` then holds the fallback until it is resolved.
    /// Boxed so the common case, `None`, costs one word per entry.
    pub time_prediction: Option<Box<TimePrediction>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ParseError {
    /// The buffer ended mid-field, or a length prefix pointed past the end
    /// of the buffer, or a proto2-required field was absent. Node's
    /// `FeedMessage.decode` throws on these; the (future) caller is expected
    /// to catch this the same way `pollOne`'s try/catch does — mark the feed
    /// failed, keep its last-good state.
    Malformed,
}

/// Clamp to the same +/-1800s bound Node enforces. Unlike the JS version,
/// there is no `Number.isFinite` branch here: `delay` is decoded straight
/// from a protobuf `int32` into a Rust `i32`, which cannot represent NaN or
/// Infinity — that JS branch guards against a defensive case that's
/// structurally unreachable once the value is a real `i32` (same category
/// of intentional non-verbatim divergence as PTFT's Dijkstra heap: the
/// *behavior* being guarded against JS `Number()` coercion doesn't exist in
/// this type system, so there's nothing to port).
fn clamp_delay(v: i32) -> i32 {
    v.clamp(MIN_DELAY_SECONDS, MAX_DELAY_SECONDS)
}

pub fn parse_trip_updates_buffer(data: &[u8]) -> Result<HashMap<String, TripUpdate>, ParseError> {
    let mut updates = HashMap::new();
    let mut saw_header = false;
    let mut r = Reader::new(data);
    while !r.is_empty() {
        let (field, wire_type) = r.read_tag().ok_or(ParseError::Malformed)?;
        match (field, wire_type) {
            (1, 2) => {
                let header_bytes = r.read_length_delimited().ok_or(ParseError::Malformed)?;
                parse_feed_header(header_bytes)?;
                saw_header = true;
            }
            (2, 2) => {
                let entity_bytes = r.read_length_delimited().ok_or(ParseError::Malformed)?;
                if let Some((trip_id, start_date, update)) = parse_entity(entity_bytes)? {
                    if let Some(sd) = &start_date {
                        updates.insert(format!("{trip_id}|{sd}"), update.clone());
                    }
                    updates.insert(trip_id, update);
                }
            }
            _ => {
                r.skip_field(wire_type).ok_or(ParseError::Malformed)?;
            }
        }
    }
    if !saw_header {
        return Err(ParseError::Malformed);
    }
    Ok(updates)
}

fn parse_feed_header(buf: &[u8]) -> Result<(), ParseError> {
    let mut saw_version = false;
    let mut r = Reader::new(buf);
    while !r.is_empty() {
        let (field, wt) = r.read_tag().ok_or(ParseError::Malformed)?;
        if field == 1 && wt == 2 {
            r.read_length_delimited().ok_or(ParseError::Malformed)?;
            saw_version = true;
        } else {
            r.skip_field(wt).ok_or(ParseError::Malformed)?;
        }
    }
    if !saw_version {
        return Err(ParseError::Malformed);
    }
    Ok(())
}

fn parse_entity(buf: &[u8]) -> Result<Option<(String, Option<String>, TripUpdate)>, ParseError> {
    let mut saw_id = false;
    let mut trip_update = None;
    let mut r = Reader::new(buf);
    while !r.is_empty() {
        let (field, wt) = r.read_tag().ok_or(ParseError::Malformed)?;
        match (field, wt) {
            (1, 2) => {
                r.read_length_delimited().ok_or(ParseError::Malformed)?;
                saw_id = true;
            }
            (3, 2) => {
                let bytes = r.read_length_delimited().ok_or(ParseError::Malformed)?;
                // Decode every occurrence immediately: protobufjs rejects a
                // malformed required field even if a later duplicate message
                // would otherwise overwrite it.
                trip_update = Some(parse_trip_update(bytes)?);
            }
            _ => {
                r.skip_field(wt).ok_or(ParseError::Malformed)?;
            }
        }
    }
    if !saw_id {
        return Err(ParseError::Malformed);
    }
    Ok(trip_update.flatten())
}

fn parse_trip_update(
    buf: &[u8],
) -> Result<Option<(String, Option<String>, TripUpdate)>, ParseError> {
    let mut trip_id: Option<String> = None;
    let mut start_date: Option<String> = None;
    let mut descriptor_cancelled = false;
    let mut deleted = false;
    let mut saw_trip = false;
    // The last served stop_time_update that carries a delay, in feed order —
    // the LAST such, not the max/first. An update with no delay (NO_DATA,
    // or SKIPPED: the bus doesn't stop there) leaves it standing.
    let mut last_delay: Option<i32> = None;
    // TripUpdate.delay (field 5): the trip-level deviation, used only when no
    // stop_time_update carries one.
    let mut trip_delay: Option<i32> = None;
    // A served stop_time_update with a predicted time and no delay, when it
    // is the last one carrying either: a later delay clears it, and
    // `last_delay` stays as the fallback if it cannot be resolved.
    let mut time_prediction: Option<(Box<str>, i64)> = None;
    let mut stop_updates: u32 = 0;
    let mut skipped_updates: u32 = 0;

    let mut r = Reader::new(buf);
    while !r.is_empty() {
        let (field, wt) = r.read_tag().ok_or(ParseError::Malformed)?;
        match (field, wt) {
            (1, 2) => {
                let b = r.read_length_delimited().ok_or(ParseError::Malformed)?;
                let (tid, sd, rel) = parse_trip_descriptor(b)?;
                saw_trip = true;
                trip_id = tid;
                start_date = sd;
                descriptor_cancelled = rel == TripRel::Canceled;
                deleted = rel == TripRel::Deleted;
            }
            (2, 2) => {
                let b = r.read_length_delimited().ok_or(ParseError::Malformed)?;
                let stu = parse_stop_time_update(b)?;
                stop_updates += 1;
                if stu.skipped {
                    skipped_updates += 1;
                } else if let Some(d) = stu.delay {
                    last_delay = Some(d);
                    time_prediction = None;
                } else if let (Some(time), Some(stop_id)) = (stu.time, stu.stop_id) {
                    time_prediction = Some((stop_id, time));
                }
            }
            (5, 0) => {
                // int32: sign-extended varint, same decode as StopTimeEvent.delay.
                let v = r.read_varint().ok_or(ParseError::Malformed)?;
                trip_delay = Some((v as i64) as i32);
            }
            _ => {
                r.skip_field(wt).ok_or(ParseError::Malformed)?;
            }
        }
    }

    if !saw_trip {
        return Err(ParseError::Malformed);
    }
    let Some(tid) = trip_id.filter(|tid| !tid.is_empty()) else {
        return Ok(None);
    };
    let start_date = start_date.filter(|sd| !sd.is_empty());
    // A run whose every stop is skipped does not run: some producers say
    // "cancelled" that way rather than with the trip's own relationship. A run
    // skipping only some stops still goes.
    let all_stops_skipped = stop_updates > 0 && skipped_updates == stop_updates;
    let time_prediction = time_prediction.map(|(stop_id, time)| {
        Box::new(TimePrediction {
            stop_id,
            time,
            start_date: start_date
                .as_deref()
                .and_then(|sd| Date::strptime("%Y%m%d", sd).ok()),
        })
    });
    Ok(Some((
        tid,
        start_date,
        TripUpdate {
            delay_seconds: clamp_delay(last_delay.or(trip_delay).unwrap_or(0)),
            // A removed trip is not shown as cancelled: `deleted` alone.
            cancelled: !deleted && (descriptor_cancelled || all_stops_skipped),
            deleted,
            time_prediction,
        },
    )))
}

/// The `TripDescriptor.ScheduleRelationship` values the parser acts on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TripRel {
    Other,
    /// 3: "existed in the schedule but was removed" — shown as cancelled.
    Canceled,
    /// 7: "…removed and must not be shown to users … so the trip is not shown
    /// as cancelled to riders", e.g. replaced by substitute service.
    Deleted,
}

fn parse_trip_descriptor(
    buf: &[u8],
) -> Result<(Option<String>, Option<String>, TripRel), ParseError> {
    let mut trip_id = None;
    let mut start_date = None;
    let mut relationship = TripRel::Other;
    let mut r = Reader::new(buf);
    while !r.is_empty() {
        let (field, wt) = r.read_tag().ok_or(ParseError::Malformed)?;
        match (field, wt) {
            (1, 2) => {
                let b = r.read_length_delimited().ok_or(ParseError::Malformed)?;
                // Lossy decode (never errors) matches protobufjs's non-throwing
                // string decode in the Node original — malformed UTF-8 in a
                // string field doesn't abort the parse, it just produces
                // replacement characters.
                trip_id = Some(String::from_utf8_lossy(b).into_owned());
            }
            (3, 2) => {
                let b = r.read_length_delimited().ok_or(ParseError::Malformed)?;
                start_date = Some(String::from_utf8_lossy(b).into_owned());
            }
            (4, 0) => {
                relationship = match r.read_varint().ok_or(ParseError::Malformed)? {
                    3 => TripRel::Canceled,
                    7 => TripRel::Deleted,
                    _ => TripRel::Other,
                };
            }
            _ => {
                r.skip_field(wt).ok_or(ParseError::Malformed)?;
            }
        }
    }
    Ok((trip_id, start_date, relationship))
}

/// One StopTimeUpdate, reduced to what the trip needs.
struct StopUpdate {
    /// `departure.delay ?? arrival.delay` — departure wins when both are on
    /// the SAME update. `None` for a `NO_DATA` stop even if it carries times:
    /// the spec says it must not, and it means "no realtime data here".
    delay: Option<i32>,
    /// `departure.time ?? arrival.time`, same precedence and the same
    /// `NO_DATA` rule as `delay`. Read only for a time-only prediction.
    time: Option<i64>,
    /// Field 4. Resolving a predicted time needs the stop: the band bundle
    /// has no GTFS `stop_sequence` to match on instead.
    stop_id: Option<Box<str>>,
    /// `schedule_relationship == SKIPPED` (1): the vehicle will not stop here.
    skipped: bool,
}

/// One StopTimeEvent: delay (1, int32) and time (2, int64 POSIX seconds).
#[derive(Default)]
struct StopEvent {
    delay: Option<i32>,
    time: Option<i64>,
}

/// StopTimeUpdate fields: arrival (2), departure (3), stop_id (4),
/// schedule_relationship (5: SCHEDULED 0, SKIPPED 1, NO_DATA 2, UNSCHEDULED 3).
fn parse_stop_time_update(buf: &[u8]) -> Result<StopUpdate, ParseError> {
    let mut arrival = StopEvent::default();
    let mut departure = StopEvent::default();
    let mut stop_id: Option<Box<str>> = None;
    let mut relationship: u64 = 0;
    let mut r = Reader::new(buf);
    while !r.is_empty() {
        let (field, wt) = r.read_tag().ok_or(ParseError::Malformed)?;
        match (field, wt) {
            (2, 2) => {
                let b = r.read_length_delimited().ok_or(ParseError::Malformed)?;
                arrival = parse_stop_time_event(b)?;
            }
            (3, 2) => {
                let b = r.read_length_delimited().ok_or(ParseError::Malformed)?;
                departure = parse_stop_time_event(b)?;
            }
            (4, 2) => {
                let b = r.read_length_delimited().ok_or(ParseError::Malformed)?;
                stop_id = Some(String::from_utf8_lossy(b).into());
            }
            (5, 0) => {
                relationship = r.read_varint().ok_or(ParseError::Malformed)?;
            }
            _ => {
                r.skip_field(wt).ok_or(ParseError::Malformed)?;
            }
        }
    }
    let no_data = relationship == 2;
    Ok(StopUpdate {
        delay: if no_data {
            None
        } else {
            departure.delay.or(arrival.delay)
        },
        time: if no_data {
            None
        } else {
            departure.time.or(arrival.time)
        },
        stop_id: stop_id.filter(|s| !s.is_empty()),
        skipped: relationship == 1,
    })
}

fn parse_stop_time_event(buf: &[u8]) -> Result<StopEvent, ParseError> {
    let mut event = StopEvent::default();
    let mut r = Reader::new(buf);
    while !r.is_empty() {
        let (field, wt) = r.read_tag().ok_or(ParseError::Malformed)?;
        match (field, wt) {
            (1, 0) => {
                let v = r.read_varint().ok_or(ParseError::Malformed)?;
                event.delay = Some((v as i64) as i32);
            }
            (2, 0) => {
                let v = r.read_varint().ok_or(ParseError::Malformed)?;
                event.time = Some(v as i64);
            }
            _ => {
                r.skip_field(wt).ok_or(ParseError::Malformed)?;
            }
        }
    }
    Ok(event)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Header-only FeedMessage, zero entities — the exact literal from
    // packages/backend/src/gtfs/realtime.test.ts's EMPTY_FEED_BYTES.
    const EMPTY_FEED_BYTES: &[u8] = &[
        0x0a, 0x09, 0x0a, 0x03, 0x32, 0x2e, 0x30, 0x10, 0x00, 0x18, 0x00,
    ];

    fn feed_with_entity(entity_bytes: &[u8]) -> Vec<u8> {
        assert!(entity_bytes.len() < 128);
        let mut feed_bytes = EMPTY_FEED_BYTES.to_vec();
        feed_bytes.extend_from_slice(&[0x12, entity_bytes.len() as u8]);
        feed_bytes.extend_from_slice(entity_bytes);
        feed_bytes
    }

    fn trip_update_with_descriptor(trip_descriptor_bytes: &[u8]) -> Vec<u8> {
        assert!(trip_descriptor_bytes.len() < 128);
        let mut trip_update_bytes = vec![0x0a, trip_descriptor_bytes.len() as u8];
        trip_update_bytes.extend_from_slice(trip_descriptor_bytes);
        trip_update_bytes
    }

    fn entity_with_trip_update(trip_update_bytes: &[u8]) -> Vec<u8> {
        assert!(trip_update_bytes.len() < 128);
        let mut entity_bytes = vec![0x0a, 0x02, b'e', b'0', 0x1a, trip_update_bytes.len() as u8];
        entity_bytes.extend_from_slice(trip_update_bytes);
        entity_bytes
    }

    #[test]
    fn empty_feed_returns_empty_map() {
        let result = parse_trip_updates_buffer(EMPTY_FEED_BYTES).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn empty_body_or_header_without_version_is_malformed() {
        assert_eq!(parse_trip_updates_buffer(&[]), Err(ParseError::Malformed));
        assert_eq!(
            parse_trip_updates_buffer(&[0x0a, 0x00]),
            Err(ParseError::Malformed)
        );
    }

    #[test]
    fn clamps_extreme_positive_and_negative_delays() {
        let data = include_bytes!("../../tests/fixtures/rt/clamp_cases.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        assert_eq!(updates["trip-positive"].delay_seconds, 1800);
        assert_eq!(updates["trip-negative"].delay_seconds, -1800);
    }

    #[test]
    fn boundary_values_pass_through_unchanged() {
        let data = include_bytes!("../../tests/fixtures/rt/clamp_cases.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        assert_eq!(updates["trip-at-max"].delay_seconds, 1800);
        assert_eq!(updates["trip-at-min"].delay_seconds, -1800);
    }

    #[test]
    fn clamps_one_second_past_boundary() {
        let data = include_bytes!("../../tests/fixtures/rt/clamp_cases.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        assert_eq!(updates["trip-1801"].delay_seconds, 1800);
        assert_eq!(updates["trip-minus-1801"].delay_seconds, -1800);
    }

    #[test]
    fn cancelled_trip_sets_cancelled_true() {
        let data = include_bytes!("../../tests/fixtures/rt/cancelled_trip.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        let u = &updates["trip-cancelled"];
        assert!(u.cancelled);
        assert_eq!(u.delay_seconds, 15);
    }

    // ── A scheduled bus that will not run ─────────────────────────────────
    // the rt cancelled trips notes

    #[test]
    fn deleted_trip_is_marked_deleted_not_cancelled() {
        // DELETED "must not be shown to users … so the trip is not shown as
        // cancelled to riders" (gtfs-realtime.proto): its own flag, not
        // `cancelled`.
        let data = include_bytes!("../../tests/fixtures/rt/cancellation_cases.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        assert_eq!(
            updates["trip-deleted"],
            TripUpdate {
                delay_seconds: 20,
                cancelled: false,
                deleted: true,
                time_prediction: None,
            }
        );
    }

    #[test]
    fn trip_with_every_stop_skipped_is_cancelled() {
        let data = include_bytes!("../../tests/fixtures/rt/cancellation_cases.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        assert!(updates["trip-all-skipped"].cancelled);
    }

    #[test]
    fn trip_skipping_one_stop_still_runs_with_its_delay() {
        let data = include_bytes!("../../tests/fixtures/rt/cancellation_cases.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        assert_eq!(
            updates["trip-partly-skipped"],
            TripUpdate {
                delay_seconds: 90,
                cancelled: false,
                deleted: false,
                time_prediction: None,
            }
        );
    }

    #[test]
    fn other_trip_relationships_are_not_cancellations() {
        let data = include_bytes!("../../tests/fixtures/rt/cancellation_cases.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        assert!(!updates["trip-duplicated"].cancelled);
    }

    // ── Trip delay around updates that carry none ──────────────────

    #[test]
    fn no_data_tail_keeps_the_delay_reported_before_it() {
        let data = include_bytes!("../../tests/fixtures/rt/delay_cases.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        assert_eq!(updates["trip-no-data-tail"].delay_seconds, 120);
    }

    #[test]
    fn skipped_tail_keeps_the_delay_reported_before_it() {
        let data = include_bytes!("../../tests/fixtures/rt/delay_cases.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        assert_eq!(updates["trip-skipped-tail"].delay_seconds, 150);
    }

    #[test]
    fn a_skipped_stops_times_are_not_the_trip_delay() {
        let data = include_bytes!("../../tests/fixtures/rt/delay_cases.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        assert_eq!(updates["trip-skipped-with-times"].delay_seconds, 60);
    }

    #[test]
    fn trip_level_delay_is_used_when_no_stop_carries_one() {
        let data = include_bytes!("../../tests/fixtures/rt/delay_cases.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        assert_eq!(updates["trip-level-only"].delay_seconds, 240);
    }

    #[test]
    fn a_stop_delay_wins_over_the_trip_level_delay() {
        let data = include_bytes!("../../tests/fixtures/rt/delay_cases.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        assert_eq!(updates["trip-level-overridden"].delay_seconds, 30);
    }

    #[test]
    fn trip_level_delay_is_clamped_like_any_other() {
        let data = include_bytes!("../../tests/fixtures/rt/delay_cases.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        assert_eq!(
            updates["trip-level-clamped"].delay_seconds,
            MAX_DELAY_SECONDS
        );
    }

    // ── Predicted times only (D3, ) ───────────────────────────────────
    // The parser keeps the prediction; `rt::resolve` turns it into a delay.

    fn prediction(stop_id: &str, time: i64) -> Option<Box<TimePrediction>> {
        Some(Box::new(TimePrediction {
            stop_id: stop_id.into(),
            time,
            start_date: None,
        }))
    }

    #[test]
    fn a_time_only_departure_is_kept_as_a_prediction_with_delay_zero() {
        let data = include_bytes!("../../tests/fixtures/rt/time_only_cases.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        assert_eq!(
            updates["T1"],
            TripUpdate {
                delay_seconds: 0,
                cancelled: false,
                deleted: false,
                time_prediction: prediction("S2", 1777957800 + 120),
            }
        );
    }

    #[test]
    fn a_time_only_arrival_is_kept_too() {
        let data = include_bytes!("../../tests/fixtures/rt/time_only_cases.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        assert_eq!(
            updates["T7"].time_prediction,
            prediction("S2", 1777957800 + 180)
        );
    }

    #[test]
    fn a_later_time_only_stop_wins_and_the_earlier_delay_is_the_fallback() {
        let data = include_bytes!("../../tests/fixtures/rt/time_only_cases.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        let u = &updates["T4"];
        assert_eq!(u.time_prediction, prediction("S2", 1777957800 + 90));
        assert_eq!(u.delay_seconds, 30);
    }

    #[test]
    fn a_later_delay_wins_over_an_earlier_time_only_stop() {
        let data = include_bytes!("../../tests/fixtures/rt/time_only_cases.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        let u = &updates["T9"];
        assert_eq!(u.delay_seconds, 75);
        assert_eq!(u.time_prediction, None);
    }

    #[test]
    fn an_event_with_both_delay_and_time_takes_the_delay() {
        let data = include_bytes!("../../tests/fixtures/rt/time_only_cases.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        let u = &updates["T5"];
        assert_eq!(u.delay_seconds, 45);
        assert_eq!(u.time_prediction, None);
    }

    #[test]
    fn a_dated_time_only_trip_keeps_the_prediction_under_both_keys() {
        let data = include_bytes!("../../tests/fixtures/rt/time_only_cases.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        let want = Some(Box::new(TimePrediction {
            start_date: Date::new(2026, 5, 5).ok(),
            ..*prediction("S2", 1777957800 - 60).unwrap()
        }));
        assert_eq!(updates["T2"].time_prediction, want);
        assert_eq!(updates["T2|20260505"].time_prediction, want);
    }

    #[test]
    fn trip_update_is_two_words_so_the_snapshot_stays_small() {
        // One per merged entry, per feed and in the published snapshot
        // (`ops::rss_guard::RT_POLLER_SNAPSHOT_ENTRY_BYTES_ASSUMED`). A
        // prediction lives behind the box, and only until the cycle resolves it.
        assert_eq!(std::mem::size_of::<TripUpdate>(), 16);
    }

    #[test]
    fn missing_stop_time_updates_defaults_to_zero() {
        let data = include_bytes!("../../tests/fixtures/rt/missing_stop_times.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        assert_eq!(
            updates["trip-zero"],
            TripUpdate {
                delay_seconds: 0,
                cancelled: false,
                deleted: false,
                time_prediction: None,
            }
        );
    }

    #[test]
    fn dated_trip_keeps_bare_and_dated_keys_in_sync() {
        let data = include_bytes!("../../tests/fixtures/rt/dated_trip.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        assert_eq!(updates["trip-1"].delay_seconds, 60);
        assert_eq!(updates["trip-1|20250602"].delay_seconds, 60);
    }

    #[test]
    fn last_stop_time_update_wins_departure_preferred_over_arrival() {
        let data = include_bytes!("../../tests/fixtures/rt/last_stop_time_wins.bin");
        let updates = parse_trip_updates_buffer(data).unwrap();
        // First StopTimeUpdate has departure=10; second (the LAST one) has
        // arrival=999 AND departure=42 — departure wins on that last entry,
        // and the first entry's delay is irrelevant (matches JS taking only
        // stopTimeUpdates[length-1], not the max/first/any-with-a-value).
        assert_eq!(updates["trip-multi"].delay_seconds, 42);
    }

    #[test]
    fn truncated_buffer_returns_parse_error() {
        let result = parse_trip_updates_buffer(&[0x0a, 0x09, 0x0a]); // claims a 9-byte header, only 1 byte follows
        assert_eq!(result, Err(ParseError::Malformed));
    }

    #[test]
    fn entity_without_trip_update_is_skipped() {
        // FeedMessage { entity: [ FeedEntity { id: "e0" } ] } — no trip_update field.
        // FeedEntity.id=1 (wire type 2, string "e0")
        let entity_bytes: &[u8] = &[0x0a, 0x02, b'e', b'0']; // id="e0", no trip_update
        let feed_bytes = feed_with_entity(entity_bytes);
        let updates = parse_trip_updates_buffer(&feed_bytes).unwrap();
        assert!(updates.is_empty());
    }

    #[test]
    fn trip_update_without_trip_id_is_skipped() {
        // FeedEntity { id: "e0", tripUpdate: { trip: {} } } — TripDescriptor present but empty (no trip_id).
        let trip_descriptor_bytes: &[u8] = &[]; // empty TripDescriptor
        let trip_update_bytes = trip_update_with_descriptor(trip_descriptor_bytes);
        let entity_bytes = entity_with_trip_update(&trip_update_bytes);
        let feed_bytes = feed_with_entity(&entity_bytes);
        let updates = parse_trip_updates_buffer(&feed_bytes).unwrap();
        assert!(updates.is_empty());
    }

    #[test]
    fn entity_id_and_trip_message_are_required() {
        let trip_update_bytes = trip_update_with_descriptor(&[0x0a, 0x01, b't']);
        let mut entity_without_id = vec![0x1a, trip_update_bytes.len() as u8];
        entity_without_id.extend_from_slice(&trip_update_bytes);
        assert_eq!(
            parse_trip_updates_buffer(&feed_with_entity(&entity_without_id)),
            Err(ParseError::Malformed)
        );

        let entity_bytes = entity_with_trip_update(&[]);
        assert_eq!(
            parse_trip_updates_buffer(&feed_with_entity(&entity_bytes)),
            Err(ParseError::Malformed)
        );

        let valid_trip_update = trip_update_with_descriptor(&[0x0a, 0x01, b't']);
        let mut duplicate_trip_updates = vec![0x0a, 0x02, b'e', b'0', 0x1a, 0x00];
        duplicate_trip_updates.extend_from_slice(&[0x1a, valid_trip_update.len() as u8]);
        duplicate_trip_updates.extend_from_slice(&valid_trip_update);
        assert_eq!(
            parse_trip_updates_buffer(&feed_with_entity(&duplicate_trip_updates)),
            Err(ParseError::Malformed)
        );
    }

    #[test]
    fn empty_trip_id_is_skipped_and_empty_start_date_has_no_scoped_key() {
        let empty_trip_id = trip_update_with_descriptor(&[0x0a, 0x00]);
        let entity_bytes = entity_with_trip_update(&empty_trip_id);
        let updates = parse_trip_updates_buffer(&feed_with_entity(&entity_bytes)).unwrap();
        assert!(updates.is_empty());

        let descriptor = [0x0a, 0x04, b't', b'r', b'i', b'p', 0x1a, 0x00];
        let empty_start_date = trip_update_with_descriptor(&descriptor);
        let entity_bytes = entity_with_trip_update(&empty_start_date);
        let updates = parse_trip_updates_buffer(&feed_with_entity(&entity_bytes)).unwrap();
        assert_eq!(updates.len(), 1);
        assert!(updates.contains_key("trip"));
        assert!(!updates.contains_key("trip|"));
    }

    #[test]
    fn generated_memory_bench_fixtures_decode_with_expected_trip_counts() {
        // These payloads are generated by
        // packages/backend/scripts/generate-rt-feed-fixtures.ts from the
        // GTFS-Realtime schema linked at this module's top. Keeping them on the
        // Rust parser gate prevents a generator change from making the memory
        // lane silently measure an empty snapshot.
        let fixtures: [(&str, &[u8], usize); 5] = [
            (
                "vilnius-trip-updates.pb",
                include_bytes!(
                    "../../../../packages/backend/scripts/fixtures/rt-feeds/vilnius-trip-updates.pb"
                ),
                506,
            ),
            (
                "krakow-trip-updates-a.pb",
                include_bytes!(
                    "../../../../packages/backend/scripts/fixtures/rt-feeds/krakow-trip-updates-a.pb"
                ),
                364,
            ),
            (
                "krakow-trip-updates-m.pb",
                include_bytes!(
                    "../../../../packages/backend/scripts/fixtures/rt-feeds/krakow-trip-updates-m.pb"
                ),
                108,
            ),
            (
                "krakow-trip-updates-t.pb",
                include_bytes!(
                    "../../../../packages/backend/scripts/fixtures/rt-feeds/krakow-trip-updates-t.pb"
                ),
                197,
            ),
            (
                "tricity-trip-updates.pb",
                include_bytes!(
                    "../../../../packages/backend/scripts/fixtures/rt-feeds/tricity-trip-updates.pb"
                ),
                193,
            ),
        ];

        for (name, bytes, expected) in fixtures {
            let updates = parse_trip_updates_buffer(bytes)
                .unwrap_or_else(|err| panic!("{name} failed to decode: {err:?}"));
            assert_eq!(updates.len(), expected, "{name}");
        }
    }
}
