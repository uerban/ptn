//! Direct-transit-only R3/M4 kernel experiment over the dated event view.
//!
//! This kernel deliberately excludes transfers and other multi-leg paths; a
//! result is NOT a complete arrive-by answer. It measures what the additional
//! walking criterion costs for one legal transit ride without passing a
//! reduced candidate set off as a full-day rRAPTOR/McRAPTOR profile.
//!
//! GTFS: boarding uses departure_time, alighting uses arrival_time, repeated
//! stop occurrences have distinct positions, and times may exceed 24:00.
//! https://gtfs.org/documentation/schedule/reference/#stop_timestxt

use alloc::vec::Vec;
use core::ops::Range;

use super::enumerate_entry_events;
use crate::engine::scan::{alight_secs_at, dep_secs_at, drop_off_forbidden_at};
use crate::engine::{EngineError, Index, Mobility, Query};
use crate::Reader;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DirectObjectives {
    R3,
    M4,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DirectPoint {
    pub origin_departure_secs: i64,
    pub destination_arrival_secs: i64,
    pub actual_transfers: u32,
    pub total_walk_secs: u32,
    pub service_date: u32,
    pub route_idx: u32,
    pub trip_idx: u32,
    pub board_position: u32,
    pub alight_position: u32,
    pub frequency_offset_secs: i64,
}

pub fn profile_direct<B>(
    reader: &Reader<B>,
    index: &Index,
    query: &Query,
    window: Range<i64>,
    objectives: DirectObjectives,
) -> Result<Vec<DirectPoint>, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    if query.max_rounds == Some(0) {
        return Ok(Vec::new());
    }
    let events = enumerate_entry_events(reader, index, query, window)?;
    let mut profile: Vec<DirectPoint> = Vec::new();
    for event in events {
        let date_shift = if reader.is_v2() {
            let event_date = crate::engine::v2::time::date_ordinal(reader, event.service_date)
                .ok_or(EngineError::UnsupportedServiceDate)?;
            let query_date = crate::engine::v2::time::date_ordinal(reader, query.date)
                .ok_or(EngineError::UnsupportedServiceDate)?;
            crate::engine::v2::time::origin(reader, event_date)?
                .checked_sub(crate::engine::v2::time::origin(reader, query_date)?)
                .ok_or(EngineError::TimeOverflow)?
        } else {
            0
        };
        let Some(route) = index.routes.get(event.route_idx as usize) else {
            return Err(EngineError::Corrupt("temporal direct route index"));
        };
        let Some(trip) = route
            .trips
            .iter()
            .find(|trip| trip.trip_idx == event.trip_idx)
        else {
            return Err(EngineError::Corrupt("temporal direct trip index"));
        };
        for exit in &query.exit_stops {
            if matches!(query.mobility, Mobility::Wheelchair)
                && reader.stop_wheelchair_boarding(exit.stop as usize)? == 2
            {
                continue;
            }
            for position in (event.board_position as usize + 1)..route.stop_ids.len() {
                if route.stop_ids[position] != exit.stop
                    || dep_secs_at(reader, trip, position)? == -1
                    || drop_off_forbidden_at(reader, trip, position)
                {
                    continue;
                }
                let Some(arrival) = alight_secs_at(reader, trip, position)?
                    .checked_add(event.frequency_offset_secs)
                    .and_then(|t| t.checked_add(date_shift))
                    .and_then(|t| t.checked_add(exit.walk_secs as i64))
                else {
                    continue;
                };
                let Some(walk) = event
                    .effective_board_secs
                    .checked_sub(event.origin_ready_secs)
                    .and_then(|access| u32::try_from(access).ok())
                    .and_then(|access| access.checked_add(exit.walk_secs))
                else {
                    continue;
                };
                if arrival < event.origin_ready_secs {
                    continue;
                }
                if reader.is_v2()
                    && arrival - exit.walk_secs as i64
                        > event
                            .origin_ready_secs
                            .checked_add(crate::engine::v2::ROUTING_HORIZON_SECS)
                            .ok_or(EngineError::TimeOverflow)?
                {
                    continue;
                }
                let candidate = DirectPoint {
                    origin_departure_secs: event.origin_ready_secs,
                    destination_arrival_secs: arrival,
                    actual_transfers: 0,
                    total_walk_secs: walk,
                    service_date: event.service_date,
                    route_idx: event.route_idx,
                    trip_idx: event.trip_idx,
                    board_position: event.board_position,
                    alight_position: position as u32,
                    frequency_offset_secs: event.frequency_offset_secs,
                };
                insert(&mut profile, candidate, objectives);
            }
        }
    }
    profile.sort_by_key(|point| {
        (
            core::cmp::Reverse(point.origin_departure_secs),
            point.destination_arrival_secs,
            point.total_walk_secs,
            point.route_idx,
            point.trip_idx,
            point.board_position,
            point.alight_position,
        )
    });
    Ok(profile)
}

fn dominates(a: &DirectPoint, b: &DirectPoint, objective: DirectObjectives) -> bool {
    a.origin_departure_secs >= b.origin_departure_secs
        && a.destination_arrival_secs <= b.destination_arrival_secs
        && (objective == DirectObjectives::R3 || a.total_walk_secs <= b.total_walk_secs)
        && (a.origin_departure_secs > b.origin_departure_secs
            || a.destination_arrival_secs < b.destination_arrival_secs
            || (objective == DirectObjectives::M4 && a.total_walk_secs < b.total_walk_secs))
}

fn insert(profile: &mut Vec<DirectPoint>, candidate: DirectPoint, objective: DirectObjectives) {
    if let Some(existing) = profile.iter_mut().find(|p| {
        p.origin_departure_secs == candidate.origin_departure_secs
            && p.destination_arrival_secs == candidate.destination_arrival_secs
            && (objective == DirectObjectives::R3 || p.total_walk_secs == candidate.total_walk_secs)
    }) {
        if (
            candidate.total_walk_secs,
            candidate.route_idx,
            candidate.trip_idx,
            candidate.board_position,
        ) < (
            existing.total_walk_secs,
            existing.route_idx,
            existing.trip_idx,
            existing.board_position,
        ) {
            *existing = candidate;
        }
        return;
    }
    if profile.iter().any(|p| dominates(p, &candidate, objective)) {
        return;
    }
    profile.retain(|p| !dominates(&candidate, p, objective));
    profile.push(candidate);
}
