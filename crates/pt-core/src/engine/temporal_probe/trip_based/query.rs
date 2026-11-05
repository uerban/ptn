//! Complete-window profiles over precomputed concrete transfers. Each queued
//! segment scans the suffix of one vehicle; it never enumerates new transfers.
//! Frontiers are keyed by a concrete boarding occurrence, retaining vehicle,
//! date, frequency shift, walking, origin departure, transfers and round capacity.
//! No scalar trip-reached or per-pattern vehicle pruning is used.
//! GTFS: https://gtfs.org/documentation/schedule/reference/#transferstxt
//! and https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes

use super::{StopEvent, TransferIndex, TransferIndexConfig};
use crate::engine::consts::{rescale_walk_secs, RAPTOR_MAX_ROUNDS};
use crate::engine::temporal_probe::events::EntryEventEnumerationError;
use crate::engine::temporal_probe::r3::*;
use crate::engine::temporal_probe::round::increment;
use crate::engine::temporal_probe::v2::{entry_events, inaccessible, insert_point};
use crate::engine::v2::time;
use crate::{EngineError, Index, Query, Reader, Transfers};
use alloc::collections::{BTreeMap, VecDeque};
use alloc::vec::Vec;
use core::ops::Range;

pub struct TripProfileRequest<'a> {
    pub query: &'a Query,
    pub window: Range<i64>,
    pub transfers: Option<&'a Transfers>,
    pub max_entry_events: usize,
    pub max_segments: usize,
    pub max_frontier_width: usize,
    pub max_stop_scans: usize,
    pub max_edge_scans: usize,
}

impl<'a> TripProfileRequest<'a> {
    pub fn new(query: &'a Query, window: Range<i64>) -> Self {
        Self {
            query,
            window,
            transfers: None,
            max_entry_events: 100_000,
            max_segments: 250_000,
            max_frontier_width: 64,
            max_stop_scans: 10_000_000,
            max_edge_scans: 10_000_000,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TripProfileError {
    Engine(EngineError),
    InvalidRequest(&'static str),
    BindingMismatch,
    IncompleteCoverage {
        required: Range<i64>,
        covered: Range<i64>,
    },
    EntryEventsExhausted {
        limit: usize,
        attempted: usize,
    },
    SegmentsExhausted {
        limit: usize,
        attempted: usize,
    },
    FrontierExhausted {
        limit: usize,
        attempted: usize,
    },
    StopScansExhausted {
        limit: usize,
        attempted: usize,
    },
    EdgeScansExhausted {
        limit: usize,
        attempted: usize,
    },
}

impl From<EngineError> for TripProfileError {
    fn from(error: EngineError) -> Self {
        Self::Engine(error)
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TripProfileDiagnostics {
    pub segments_enqueued: usize,
    pub segments_scanned: usize,
    pub dominated_segments: usize,
    pub stop_events_scanned: usize,
    pub transfer_edges_scanned: usize,
    pub max_frontier_width: usize,
    /// Immutable witness arena, excluding entry events, frontiers and queue.
    pub arena_bytes: usize,
}

pub struct TripProfileResult {
    pub page: R3ProfilePage,
    pub diagnostics: TripProfileDiagnostics,
}

pub fn profile_trip_r3<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    table: &TransferIndex,
    request: TripProfileRequest<'_>,
) -> Result<TripProfileResult, TripProfileError> {
    profile(reader, index, table, request, ProfileObjectives::R3)
}

pub fn profile_trip_m4<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    table: &TransferIndex,
    request: TripProfileRequest<'_>,
) -> Result<TripProfileResult, TripProfileError> {
    profile(reader, index, table, request, ProfileObjectives::M4)
}

/// Immutable predecessor: the parent segment and its concrete alighting event.
#[derive(Clone, Copy)]
struct Segment {
    board: u32,
    origin_departure: i64,
    walk: u64,
    rounds: u32,
    transfers: u32,
    in_seat: bool,
    parent: Option<(usize, u32)>,
    active: bool,
}

struct Search<'a, B: AsRef<[u8]>> {
    reader: &'a Reader<B>,
    index: &'a Index,
    table: &'a TransferIndex,
    request: TripProfileRequest<'a>,
    objective: ProfileObjectives,
    segments: Vec<Segment>,
    queue: VecDeque<usize>,
    frontiers: BTreeMap<u32, Vec<usize>>,
    points: Vec<R3Point>,
    diagnostics: TripProfileDiagnostics,
}

fn same_vehicle(a: &StopEvent, b: &StopEvent) -> bool {
    (a.trip_idx, a.date_ordinal, a.frequency_offset_secs)
        == (b.trip_idx, b.date_ordinal, b.frequency_offset_secs)
}

impl<B: AsRef<[u8]> + Send + Sync + 'static> Search<'_, B> {
    /// At the SAME boarding event both labels have identical future rules and
    /// times. A later origin permits at least as long a horizon; fewer rounds
    /// retain at least as much capacity. Keeping walking in R3 also preserves
    /// its least-walking witness tie-break. Equal costs with different round
    /// counts remain, so witness selection does not silently become round-first.
    fn covers(&self, a: &Segment, b: &Segment) -> bool {
        if a.origin_departure < b.origin_departure
            || a.walk > b.walk
            || a.rounds > b.rounds
            || a.transfers > b.transfers
        {
            return false;
        }
        if a.origin_departure > b.origin_departure || a.walk < b.walk || a.transfers < b.transfers {
            return true;
        }
        a.rounds == b.rounds && self.witness(a, a.board) <= self.witness(b, b.board)
    }

    fn enqueue(&mut self, segment: Segment) -> Result<(), TripProfileError> {
        if let Some(frontier) = self.frontiers.get(&segment.board) {
            if frontier
                .iter()
                .any(|&id| self.covers(&self.segments[id], &segment))
            {
                increment(&mut self.diagnostics.dominated_segments)?;
                return Ok(());
            }
        }
        let removed: Vec<usize> = self
            .frontiers
            .get(&segment.board)
            .into_iter()
            .flatten()
            .copied()
            .filter(|&id| self.covers(&segment, &self.segments[id]))
            .collect();
        let width = self.frontiers.get(&segment.board).map_or(0, Vec::len) - removed.len() + 1;
        if width > self.request.max_frontier_width {
            return Err(TripProfileError::FrontierExhausted {
                limit: self.request.max_frontier_width,
                attempted: width,
            });
        }
        let attempted = self
            .segments
            .len()
            .checked_add(1)
            .ok_or(EngineError::TimeOverflow)?;
        if attempted > self.request.max_segments {
            return Err(TripProfileError::SegmentsExhausted {
                limit: self.request.max_segments,
                attempted,
            });
        }
        for &id in &removed {
            self.segments[id].active = false;
        }
        let frontier = self.frontiers.entry(segment.board).or_default();
        frontier.retain(|id| !removed.contains(id));
        let id = self.segments.len();
        frontier.push(id);
        self.segments.push(segment);
        self.queue.push_back(id);
        self.diagnostics.max_frontier_width = self.diagnostics.max_frontier_width.max(width);
        increment(&mut self.diagnostics.segments_enqueued)?;
        Ok(())
    }

    fn witness(&self, segment: &Segment, alight: u32) -> Vec<R3TransitWitness> {
        let mut legs = Vec::new();
        let (mut segment, mut alight) = (*segment, alight);
        loop {
            let board = self.table.events[segment.board as usize];
            let end = self.table.events[alight as usize];
            let route = &self.index.routes[board.route_idx as usize];
            legs.push(R3TransitWitness {
                service_date: crate::reader::days_add(
                    self.reader.feed_start_date(),
                    board.date_ordinal as i64,
                ),
                route_idx: board.route_idx,
                reader_route_idx: route.reader_route_idx,
                trip_idx: board.trip_idx,
                board_position: board.position,
                alight_position: end.position,
                board_secs: board.departure_secs,
                alight_secs: end.arrival_secs,
                frequency_offset_secs: board.frequency_offset_secs,
                frequency_instance: board.approximate(),
                in_seat: segment.in_seat,
            });
            match segment.parent {
                Some((id, arrival)) => {
                    segment = self.segments[id];
                    alight = arrival;
                }
                None => break,
            }
        }
        legs.reverse();
        legs
    }

    fn record(
        &mut self,
        segment: &Segment,
        event: u32,
        stop: u32,
        arrive: i64,
        walk: u64,
    ) -> Result<(), TripProfileError> {
        let Some(egress) = self
            .request
            .query
            .exit_stops
            .iter()
            .filter(|e| e.stop == stop)
            .map(|e| e.walk_secs)
            .min()
        else {
            return Ok(());
        };
        if inaccessible(self.reader, self.request.query, stop)? {
            return Ok(());
        }
        let witness = self.witness(segment, event);
        insert_point(
            &mut self.points,
            R3Point {
                origin_departure_secs: segment.origin_departure,
                destination_arrival_secs: arrive
                    .checked_add(egress as i64)
                    .ok_or(EngineError::TimeOverflow)?,
                actual_transfers: segment.transfers,
                transit_rounds: segment.rounds,
                total_walk_secs: walk
                    .checked_add(egress as u64)
                    .ok_or(EngineError::TimeOverflow)?,
                service_date: self.request.query.date,
                witness,
            },
            self.objective,
        );
        Ok(())
    }

    fn scan(&mut self, id: usize) -> Result<(), TripProfileError> {
        let segment = self.segments[id];
        let board = self.table.events[segment.board as usize];
        let deadline = segment
            .origin_departure
            .checked_add(time::ROUTING_HORIZON_SECS)
            .ok_or(EngineError::TimeOverflow)?;
        increment(&mut self.diagnostics.segments_scanned)?;
        for e in segment.board as usize + 1..self.table.events.len() {
            let event = self.table.events[e];
            if !same_vehicle(&board, &event) {
                break;
            }
            if self.diagnostics.stop_events_scanned >= self.request.max_stop_scans {
                return Err(TripProfileError::StopScansExhausted {
                    limit: self.request.max_stop_scans,
                    attempted: self.diagnostics.stop_events_scanned.saturating_add(1),
                });
            }
            increment(&mut self.diagnostics.stop_events_scanned)?;
            if !event.is_source() || event.arrival_secs > deadline {
                continue;
            }
            let stop =
                self.index.routes[event.route_idx as usize].stop_ids[event.position as usize];
            if event.can_alight() {
                self.record(&segment, e as u32, stop, event.arrival_secs, segment.walk)?;
                // Egress uses one physical PTFT movement, as in the reference.
                // Synthetic minimum-time rules never become walking egress.
                if let Some(table) = self.request.transfers {
                    if let Some(from) = table.index_of(
                        self.reader
                            .stop_id(stop as usize)
                            .map_err(EngineError::from)?,
                    ) {
                        let (neighbors, walks) = table.edges(from);
                        let mut movements = Vec::new();
                        for (&neighbor, &raw) in neighbors.iter().zip(walks) {
                            if let Some(to) = self.reader.stop_index(table.stop_id(neighbor)) {
                                if to != stop {
                                    movements.push((
                                        to,
                                        rescale_walk_secs(
                                            raw,
                                            self.request.query.transfer_walk_speed_mm_s(),
                                        ),
                                    ));
                                }
                            }
                        }
                        movements.sort_unstable();
                        movements.dedup_by_key(|e| e.0);
                        for (to, walk) in movements {
                            let arrive = event
                                .arrival_secs
                                .checked_add(walk)
                                .ok_or(EngineError::TimeOverflow)?;
                            if arrive <= deadline {
                                self.record(
                                    &segment,
                                    e as u32,
                                    to,
                                    arrive,
                                    segment
                                        .walk
                                        .checked_add(walk as u64)
                                        .ok_or(EngineError::TimeOverflow)?,
                                )?;
                            }
                        }
                    }
                }
            }
            if segment.rounds >= self.request.query.max_rounds.unwrap_or(RAPTOR_MAX_ROUNDS) {
                continue;
            }
            for edge in self.table.transfers_from(e as u32) {
                if self.diagnostics.transfer_edges_scanned >= self.request.max_edge_scans {
                    return Err(TripProfileError::EdgeScansExhausted {
                        limit: self.request.max_edge_scans,
                        attempted: self.diagnostics.transfer_edges_scanned.saturating_add(1),
                    });
                }
                increment(&mut self.diagnostics.transfer_edges_scanned)?;
                if self.table.events[edge.target as usize].departure_secs > deadline {
                    continue;
                }
                self.enqueue(Segment {
                    board: edge.target,
                    origin_departure: segment.origin_departure,
                    walk: segment
                        .walk
                        .checked_add(edge.walk_secs as u64)
                        .ok_or(EngineError::TimeOverflow)?,
                    rounds: segment
                        .rounds
                        .checked_add(1)
                        .ok_or(EngineError::TimeOverflow)?,
                    transfers: segment
                        .transfers
                        .checked_add(u32::from(edge.kind.spends_transfer()))
                        .ok_or(EngineError::TimeOverflow)?,
                    in_seat: !edge.kind.spends_transfer(),
                    parent: Some((id, e as u32)),
                    active: true,
                })?;
            }
        }
        Ok(())
    }
}

fn profile<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    table: &TransferIndex,
    request: TripProfileRequest<'_>,
    objective: ProfileObjectives,
) -> Result<TripProfileResult, TripProfileError> {
    if request.window.start >= request.window.end {
        return Err(TripProfileError::InvalidRequest(
            "trip profile window must be nonempty",
        ));
    }
    if [
        request.max_entry_events,
        request.max_segments,
        request.max_frontier_width,
        request.max_stop_scans,
        request.max_edge_scans,
    ]
    .contains(&0)
    {
        return Err(TripProfileError::InvalidRequest(
            "trip profile limits must be positive",
        ));
    }
    let config = TransferIndexConfig::for_query(request.query, table.covered());
    if !table.is_bound_to(reader, index, request.transfers, &config) {
        return Err(TripProfileError::BindingMismatch);
    }
    let required = request.window.start
        ..request
            .window
            .end
            .checked_add(time::ROUTING_HORIZON_SECS)
            .ok_or(EngineError::TimeOverflow)?;
    if table.covered.start > required.start || table.covered.end < required.end {
        return Err(TripProfileError::IncompleteCoverage {
            required,
            covered: table.covered(),
        });
    }
    let events = entry_events(
        reader,
        index,
        request.query,
        request.window.clone(),
        request.max_entry_events,
    )
    .map_err(|e| match e {
        EntryEventEnumerationError::Engine(e) => TripProfileError::Engine(e),
        EntryEventEnumerationError::LimitExceeded {
            max_events,
            attempted_events,
        } => TripProfileError::EntryEventsExhausted {
            limit: max_events,
            attempted: attempted_events,
        },
    })?;
    let window = request.window.clone();
    let date = request.query.date;
    let has_transfers = request.transfers.is_some();
    let mut search = Search {
        reader,
        index,
        table,
        request,
        objective,
        segments: Vec::new(),
        queue: VecDeque::new(),
        frontiers: BTreeMap::new(),
        points: Vec::new(),
        diagnostics: TripProfileDiagnostics::default(),
    };
    let mut buckets = 0;
    let mut last = None;
    for event in events.iter().rev() {
        if last != Some(event.origin_ready_secs) {
            buckets += 1;
            last = Some(event.origin_ready_secs);
        }
        if search.request.query.max_rounds == Some(0) {
            continue;
        }
        if event.effective_board_secs
            > event
                .origin_ready_secs
                .checked_add(time::ROUTING_HORIZON_SECS)
                .ok_or(EngineError::TimeOverflow)?
        {
            continue;
        }
        let ordinal = time::date_ordinal(reader, event.service_date)
            .ok_or(EngineError::UnsupportedServiceDate)?;
        let key = (
            event.trip_idx,
            ordinal as u32,
            event.frequency_offset_secs,
            event.board_position,
        );
        let board = table
            .events
            .binary_search_by_key(&key, StopEvent::key)
            .map_err(|_| EngineError::Corrupt("trip profile entry event is not indexed"))?;
        search.enqueue(Segment {
            board: board as u32,
            origin_departure: event.origin_ready_secs,
            walk: u64::try_from(
                event
                    .effective_board_secs
                    .checked_sub(event.origin_ready_secs)
                    .ok_or(EngineError::TimeOverflow)?,
            )
            .map_err(|_| EngineError::TimeOverflow)?,
            rounds: 1,
            transfers: 0,
            in_seat: false,
            parent: None,
            active: true,
        })?;
    }
    while let Some(id) = search.queue.pop_front() {
        if search.segments[id].active {
            search.scan(id)?;
        }
    }
    search.points.sort_by(|a, b| {
        b.origin_departure_secs
            .cmp(&a.origin_departure_secs)
            .then(a.destination_arrival_secs.cmp(&b.destination_arrival_secs))
            .then(a.actual_transfers.cmp(&b.actual_transfers))
            .then(a.total_walk_secs.cmp(&b.total_walk_secs))
            .then(a.witness.cmp(&b.witness))
    });
    search.diagnostics.arena_bytes = core::mem::size_of_val(search.segments.as_slice());
    let diagnostics = R3Diagnostics {
        entry_events: events.len(),
        enumerated_entry_events: events.len(),
        timestamp_buckets: buckets,
        accepted_labels: search.diagnostics.segments_enqueued,
        propagated_labels: search.diagnostics.segments_scanned,
        reused_labels: search.diagnostics.dominated_segments,
    };
    Ok(TripProfileResult {
        diagnostics: search.diagnostics,
        page: R3ProfilePage {
            points: search.points,
            objectives: objective,
            requested_page_size: usize::MAX,
            completion: R3PageCompletion::WindowExhausted,
            supported_service_date: date,
            ptft_status: if has_transfers {
                R3PtftStatus::Applied
            } else {
                R3PtftStatus::NotSupplied
            },
            multi_date_status: R3MultiDateStatus::ServiceDayOrigins,
            requested_window: window.clone(),
            coverage_scope: R3CoverageScope::SuppliedWindowOnly,
            covered_window: window.clone(),
            covered_frontier_secs: window.start,
            latest_departure_certificate: R3LatestDepartureCertificate {
                covered_from_secs: window.start,
                covered_until_exclusive_secs: window.end,
                next_unprocessed_origin_ready_secs: None,
                equal_time_boundary_closed: true,
            },
            page_complete: true,
            window_exhausted: true,
            day_exhausted: false,
            diagnostics,
            page_diagnostics: diagnostics,
        },
    })
}
