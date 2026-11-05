// crates/pt-serve/src/rt/resolve.rs

//! Turns time-only GTFS-RT predictions into trip delays against the bundle.
//!
//! A feed may say when a vehicle will be at a stop (`StopTimeEvent.time`)
//! without saying how late that is (`delay`); krakow's tram feed and most of
//! its bus feed only do that (the rt cancelled trips notes
//! ). The parser keeps such a prediction on the trip ([`TimePrediction`]);
//! the poll cycle resolves it here, once, before the snapshot is published, so
//! every reader keeps reading one `delay_seconds` per trip and no request pays
//! for a timetable lookup.
//!
//! The delay is `time − scheduled`, where `scheduled` is the trip's timetabled
//! departure at the prediction's stop:
//! - The stop is matched by `stop_id`: a band bundle has no GTFS
//!   `stop_sequence` (`pt_core::Reader::stop_time`'s band path synthesises it
//!   from the position), and krakow's tram feed sends none anyway.
//! - The service date is the feed's `start_date` when the entity carries one,
//!   else each of the day before, the day of and the day after the predicted
//!   instant (local, in the city zone) on which the trip runs. The day before
//!   covers overnight runs (`dep_secs ≥ 86400`, guardrail 1); the day after, a
//!   run due just after midnight that is early.
//! - A trip visiting the stop more than once, on more than one candidate date,
//!   takes the visit nearest the predicted time.
//! - Nearest further than [`MAX_MATCH_SECONDS`] is not trusted: the trip keeps
//!   the delay the parser fell back to.
//!
//! An arrival-only prediction is compared against the departure too: the band
//! stores departures, and the one place feeds send arrival-only events is the
//! last stop, where GTFS arrival and departure coincide.
//!
//! GTFS-Realtime reference: <https://gtfs.org/documentation/realtime/reference/#message-stoptimeevent>

use crate::bundle::Generation;
use crate::domain::time_domain::service_day_to_unix;
use crate::rt::parser::{TimePrediction, TripUpdate, MAX_DELAY_SECONDS, MIN_DELAY_SECONDS};
use jiff::{civil::Date, tz::TimeZone, Timestamp, ToSpan};
use std::collections::HashMap;

/// Beyond this, a predicted time is not a prediction for that run: it points
/// at another day, another trip reusing the id, or a broken clock.
pub const MAX_MATCH_SECONDS: i64 = 3600;

/// `dep_secs` at a stop with no departure time (non-timepoint).
const MISSING_DEP_SECS: u32 = 0xFFFF_FFFF;

/// Per cycle, per trip (bare trip id): predictions turned into a delay, and
/// predictions left on the parser's fallback. Surfaced on `/health/rt`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TimePredictionStats {
    pub resolved: u32,
    pub unresolved: u32,
}

/// Resolve every [`TripUpdate::time_prediction`] in `updates` against `gen`
/// and clear it, resolved or not — the snapshot never carries one. `None`
/// (no generation to read) leaves every trip on its fallback delay.
///
/// One pass over the bundle's trip ids, and only when some trip carries a
/// prediction: a feed that sends delays never pays for it.
pub fn resolve_time_predictions(
    updates: &mut HashMap<String, TripUpdate>,
    gen: Option<&Generation>,
) -> TimePredictionStats {
    // trip id → the keys carrying a prediction for it (bare and dated).
    let mut pending: HashMap<String, Vec<String>> = HashMap::new();
    for (key, update) in updates.iter() {
        if update.time_prediction.is_some() {
            let trip_id = key.split('|').next().unwrap_or(key);
            pending
                .entry(trip_id.to_string())
                .or_default()
                .push(key.clone());
        }
    }
    let mut stats = TimePredictionStats::default();
    if pending.is_empty() {
        return stats;
    }

    if let Some((gen, tz)) = gen.and_then(|g| g.city_tz.as_ref().map(|tz| (g, tz))) {
        for t in 0..gen.reader.num_trips() {
            let Ok(trip_id) = gen.reader.trip_id(t) else {
                continue;
            };
            let Some(keys) = pending.remove(trip_id) else {
                continue;
            };
            for key in keys {
                let update = updates.get_mut(&key).expect("key collected above");
                let prediction = update.time_prediction.take().expect("collected above");
                let delay = delay_at(gen, tz, t, &prediction);
                if let Some(d) = delay {
                    update.delay_seconds =
                        d.clamp(MIN_DELAY_SECONDS.into(), MAX_DELAY_SECONDS.into()) as i32;
                }
                if !key.contains('|') {
                    if delay.is_some() {
                        stats.resolved += 1;
                    } else {
                        stats.unresolved += 1;
                    }
                }
            }
            if pending.is_empty() {
                break;
            }
        }
    }

    // Trips the bundle does not have, or no generation / zone to read.
    for key in pending.into_values().flatten() {
        if let Some(update) = updates.get_mut(&key) {
            update.time_prediction = None;
        }
        if !key.contains('|') {
            stats.unresolved += 1;
        }
    }
    stats
}

/// `prediction.time` minus trip `t`'s nearest scheduled departure at the
/// prediction's stop, if one is within [`MAX_MATCH_SECONDS`].
fn delay_at(gen: &Generation, tz: &TimeZone, t: usize, prediction: &TimePrediction) -> Option<i64> {
    let reader = &gen.reader;
    let service = reader.trip_service_idx(t).ok()?;
    let dates: Vec<Date> = match prediction.start_date {
        Some(d) => vec![d],
        None => {
            let instant = Timestamp::from_second(prediction.time).ok()?;
            let local = tz.to_datetime(instant).date();
            [-1, 0, 1]
                .into_iter()
                .filter_map(|n: i64| local.checked_add(n.days()).ok())
                .collect()
        }
    };
    let dates: Vec<Date> = dates
        .into_iter()
        .filter(|d| ymd(*d).is_some_and(|key| reader.service_active_on(service, key)))
        .collect();
    if dates.is_empty() {
        return None;
    }

    let starts = reader.trip_starts().ok()?;
    let (lo, hi) = (*starts.get(t)? as usize, *starts.get(t + 1)? as usize);
    let mut best: Option<i64> = None;
    for pos in 0..hi - lo {
        // Through the per-generation cursor when one built: on a carry-less
        // bundle `Reader::stop_time` re-derives the band addressing per call.
        let st = match gen.stop_time_cursor.as_ref() {
            Some(c) => c.stop_time_in_trip(reader, t, pos),
            None => reader.stop_time(lo + pos),
        };
        let Ok(st) = st else { continue };
        if st.dep_secs == MISSING_DEP_SECS {
            continue;
        }
        if reader.stop_id(st.stop_idx as usize).ok() != Some(&*prediction.stop_id) {
            continue;
        }
        for &date in &dates {
            let Ok(scheduled) = service_day_to_unix(date, i64::from(st.dep_secs), tz) else {
                continue;
            };
            let delta = prediction.time - scheduled;
            if best.is_none_or(|b| delta.abs() < b.abs()) {
                best = Some(delta);
            }
        }
    }
    best.filter(|d| d.abs() <= MAX_MATCH_SECONDS)
}

/// The reader's `YYYYMMDD` date key.
fn ymd(d: Date) -> Option<u32> {
    let year = u32::try_from(d.year()).ok()?;
    Some(year * 10000 + d.month() as u32 * 100 + d.day() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_to_resolve_costs_nothing_and_counts_nothing() {
        let mut updates = HashMap::from([(
            "trip".to_string(),
            TripUpdate {
                delay_seconds: 60,
                ..Default::default()
            },
        )]);
        let stats = resolve_time_predictions(&mut updates, None);
        assert_eq!(stats, TimePredictionStats::default());
        assert_eq!(updates["trip"].delay_seconds, 60);
    }
}
