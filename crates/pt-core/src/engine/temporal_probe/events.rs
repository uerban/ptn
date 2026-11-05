//! Legal entry opportunities over the selected bundle's time model.
//!
//! This is the Task A seam for later temporal candidates. It intentionally
//! owns no query/profile state and does not call the production `plan()` API.
//! V1 uses one GTFS service date. V2 merges active dates through ServiceDayOrigins
//! and expresses every second relative to the query date's origin. A 25:30 event
//! always retains its originating service date.
//!
//! GTFS references:
//! - stop times, repeated stops, pickup type, and overnight times:
//!   <https://gtfs.org/documentation/schedule/reference/#stop_timestxt>
//! - frequency windows and their half-open end:
//!   <https://gtfs.org/documentation/schedule/reference/#frequenciestxt>
//! - loop/lasso repeated occurrences:
//!   <https://gtfs.org/documentation/schedule/schedule-best-practices/#loop-routes>
//!   <https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes>

use alloc::vec::Vec;
use core::ops::Range;

use crate::engine::mode::route_type_to_mode;
use crate::engine::scan::{dep_secs_at, pickup_forbidden_at};
use crate::engine::{EngineError, Index, Mobility, Query};
use crate::reader::FrequencyRecord;
use crate::Reader;

/// One legal first-boarding opportunity at an entry stop.
///
/// `route_idx` is the route/pattern ordinal in [`Index::routes`], while
/// `trip_idx` is the underlying PTB/GTFS trip ordinal. `board_position` is a
/// canonical occurrence position, not a stop-id lookup; this distinction keeps
/// both loop and lasso repeats usable.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EntryEvent {
    pub service_date: u32,
    pub route_idx: u32,
    pub trip_idx: u32,
    pub board_position: u32,
    /// The origin-side ready time after subtracting access walking.
    pub origin_ready_secs: i64,
    /// The concrete departure at the boarded occurrence, including a frequency
    /// instance's shift from the template trip.
    pub effective_board_secs: i64,
    /// `0` for a scheduled trip; otherwise the frequency instance's shift from
    /// the template trip's first served departure. Includes v2 exact_times=1
    /// instances, which remain scheduled rather than approximate.
    pub frequency_offset_secs: i64,
}

#[derive(Debug)]
pub(crate) enum EntryEventEnumerationError {
    Engine(EngineError),
    LimitExceeded {
        max_events: usize,
        attempted_events: usize,
    },
}

impl From<EngineError> for EntryEventEnumerationError {
    fn from(error: EngineError) -> Self {
        Self::Engine(error)
    }
}

/// Enumerate all legal entry events whose origin-ready time lies in
/// `service_secs.start..service_secs.end` (start inclusive, end exclusive).
///
/// The range is explicit because [`Query`] is the legacy one-departure query
/// shape and cannot be extended by this experiment. `query.date` selects the
/// v1 service date or the v2 timeline origin. V2 includes adjacent service dates
/// whose concrete boardings overlap the supplied window, with a complete 48h
/// horizon required at both window boundaries.
pub fn enumerate_entry_events<B>(
    reader: &Reader<B>,
    index: &Index,
    query: &Query,
    service_secs: Range<i64>,
) -> Result<Vec<EntryEvent>, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    match enumerate_entry_events_bounded(reader, index, query, service_secs, usize::MAX) {
        Ok(events) => Ok(events),
        Err(EntryEventEnumerationError::Engine(error)) => Err(error),
        Err(EntryEventEnumerationError::LimitExceeded { .. }) => {
            Err(EngineError::Corrupt("temporal entry event count overflow"))
        }
    }
}

pub(crate) fn enumerate_entry_events_bounded<B>(
    reader: &Reader<B>,
    index: &Index,
    query: &Query,
    service_secs: Range<i64>,
    max_events: usize,
) -> Result<Vec<EntryEvent>, EntryEventEnumerationError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let mut events = Vec::new();
    if reader.is_v2() {
        return super::v2::entry_events(reader, index, query, service_secs, max_events);
    }
    if service_secs.start >= service_secs.end {
        return Ok(events);
    }

    for access in &query.entry_stops {
        if matches!(query.mobility, Mobility::Wheelchair)
            && reader
                .stop_wheelchair_boarding(access.stop as usize)
                .map_err(EngineError::from)?
                == 2
        {
            continue;
        }

        let Some(route_indices) = index.routes_at_stop.get(&access.stop) else {
            continue;
        };
        for &route_index in route_indices {
            let route = index
                .routes
                .get(route_index as usize)
                .ok_or(EngineError::Corrupt("routes_at_stop route index"))?;

            if query.excluded_routes.contains(&route.reader_route_idx)
                || query
                    .excluded_modes
                    .iter()
                    .any(|&route_type| route_type_to_mode(route_type) == route.mode)
            {
                continue;
            }

            for trip in &route.trips {
                if !reader.service_active_on(trip.service_idx, query.date) {
                    continue;
                }
                if matches!(query.mobility, Mobility::Wheelchair) && trip.wheelchair_accessible == 2
                {
                    continue;
                }
                if matches!(query.mobility, Mobility::Bicycle) && trip.bikes_allowed == 2 {
                    continue;
                }

                let has_frequency_rows = reader
                    .frequencies_for_trip(trip.trip_idx)
                    .any(|row| row.exact_times == 0);

                if !has_frequency_rows {
                    enumerate_scheduled_positions(
                        reader,
                        route,
                        trip,
                        access,
                        query.date,
                        &service_secs,
                        max_events,
                        &mut events,
                    )?;
                    continue;
                }

                let Some(template_first_departure) = first_served_departure_secs(reader, trip)?
                else {
                    continue;
                };

                for (position, &stop) in route.stop_ids.iter().enumerate() {
                    if stop != access.stop {
                        continue;
                    }
                    let template_board_secs = dep_secs_at(reader, trip, position)?;
                    if template_board_secs == -1 || pickup_forbidden_at(reader, trip, position) {
                        continue;
                    }

                    for row in reader
                        .frequencies_for_trip(trip.trip_idx)
                        .filter(|row| row.exact_times == 0)
                    {
                        enumerate_frequency_row(
                            FrequencyOccurrence {
                                route_idx: route.route_idx,
                                trip,
                                board_position: position,
                                walk_secs: access.walk_secs,
                                service_date: query.date,
                                template_first_departure,
                                template_board_secs,
                            },
                            &service_secs,
                            row,
                            max_events,
                            &mut events,
                        )?;
                    }
                }
            }
        }
    }

    events.sort_by_key(event_sort_key);
    events.dedup_by(|left, right| event_sort_key(left) == event_sort_key(right));
    Ok(events)
}

#[allow(clippy::too_many_arguments)]
fn enumerate_scheduled_positions<B>(
    reader: &Reader<B>,
    route: &crate::engine::IndexRoute,
    trip: &crate::engine::RouteTrip,
    access: &crate::engine::StopWalk,
    service_date: u32,
    service_secs: &Range<i64>,
    max_events: usize,
    events: &mut Vec<EntryEvent>,
) -> Result<(), EntryEventEnumerationError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    for (position, &stop) in route.stop_ids.iter().enumerate() {
        if stop != access.stop {
            continue;
        }
        let dep = dep_secs_at(reader, trip, position)?;
        if dep == -1 || pickup_forbidden_at(reader, trip, position) {
            continue;
        }
        let Some(origin_ready_secs) = dep.checked_sub(access.walk_secs as i64) else {
            continue;
        };
        if service_secs.contains(&origin_ready_secs) {
            push_event(
                events,
                max_events,
                EntryEvent {
                    service_date,
                    route_idx: route.route_idx,
                    trip_idx: trip.trip_idx,
                    board_position: position as u32,
                    origin_ready_secs,
                    effective_board_secs: dep,
                    frequency_offset_secs: 0,
                },
            )?;
        }
    }
    Ok(())
}

struct FrequencyOccurrence<'a> {
    route_idx: u32,
    trip: &'a crate::engine::RouteTrip,
    board_position: usize,
    walk_secs: u32,
    service_date: u32,
    template_first_departure: i64,
    template_board_secs: i64,
}

fn enumerate_frequency_row(
    occurrence: FrequencyOccurrence<'_>,
    service_secs: &Range<i64>,
    row: FrequencyRecord,
    max_events: usize,
    events: &mut Vec<EntryEvent>,
) -> Result<(), EntryEventEnumerationError> {
    let start = row.start_secs as i64;
    let end = row.end_secs as i64;
    let headway = row.headway_secs as i64;
    if headway <= 0 || start >= end {
        return Ok(());
    }

    let Some(mut first_departure) = first_frequency_start_at_or_after(
        service_secs.start,
        occurrence.walk_secs as i64,
        occurrence.template_board_secs,
        occurrence.template_first_departure,
        start,
        end,
        headway,
    ) else {
        return Ok(());
    };
    while first_departure < end {
        let Some(frequency_offset_secs) =
            first_departure.checked_sub(occurrence.template_first_departure)
        else {
            break;
        };
        let Some(effective_board_secs) = occurrence
            .template_board_secs
            .checked_add(frequency_offset_secs)
        else {
            break;
        };
        let Some(origin_ready_secs) = effective_board_secs.checked_sub(occurrence.walk_secs as i64)
        else {
            break;
        };
        if origin_ready_secs >= service_secs.end {
            break;
        }

        if service_secs.contains(&origin_ready_secs) {
            push_event(
                events,
                max_events,
                EntryEvent {
                    service_date: occurrence.service_date,
                    route_idx: occurrence.route_idx,
                    trip_idx: occurrence.trip.trip_idx,
                    board_position: occurrence.board_position as u32,
                    origin_ready_secs,
                    effective_board_secs,
                    frequency_offset_secs,
                },
            )?;
        }

        let Some(next) = first_departure.checked_add(headway) else {
            break;
        };
        if next <= first_departure {
            break;
        }
        first_departure = next;
    }
    Ok(())
}

fn push_event(
    events: &mut Vec<EntryEvent>,
    max_events: usize,
    event: EntryEvent,
) -> Result<(), EntryEventEnumerationError> {
    if events.len() >= max_events {
        return Err(EntryEventEnumerationError::LimitExceeded {
            max_events,
            attempted_events: events.len().saturating_add(1),
        });
    }
    events.push(event);
    Ok(())
}

/// First template instance whose concrete boarding-minus-access time is at
/// least the requested window start. Avoid iterating every earlier headway
/// instance when a query targets a narrow late part of a long frequency row.
pub(crate) fn first_frequency_start_at_or_after(
    window_start: i64,
    access_walk_secs: i64,
    template_board_secs: i64,
    template_first_departure: i64,
    row_start: i64,
    row_end: i64,
    headway: i64,
) -> Option<i64> {
    if row_start >= row_end || headway <= 0 {
        return None;
    }
    let min_first = window_start
        .checked_add(access_walk_secs)?
        .checked_sub(template_board_secs)?
        .checked_add(template_first_departure)?;
    if min_first <= row_start {
        return Some(row_start);
    }
    let distance = min_first.checked_sub(row_start)?;
    let steps = distance.checked_add(headway - 1)?.checked_div(headway)?;
    let first = row_start.checked_add(steps.checked_mul(headway)?)?;
    (first < row_end).then_some(first)
}

fn first_served_departure_secs<B>(
    reader: &Reader<B>,
    trip: &crate::engine::RouteTrip,
) -> Result<Option<i64>, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    for position in 0..trip.pos_to_row.len() {
        let dep = dep_secs_at(reader, trip, position)?;
        if dep != -1 {
            return Ok(Some(dep));
        }
    }
    Ok(None)
}

pub(super) fn event_sort_key(event: &EntryEvent) -> (i64, u32, u32, u32, u32, i64) {
    (
        event.origin_ready_secs,
        event.service_date,
        event.route_idx,
        event.trip_idx,
        event.board_position,
        // Keep frequency instances with equal ready times distinct. The
        // offset is part of the requested identity even when other fields tie.
        event.frequency_offset_secs,
    )
}
