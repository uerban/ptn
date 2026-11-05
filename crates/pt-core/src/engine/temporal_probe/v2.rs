//! Bounded exhaustive v2 temporal prototype, prior to the faster pattern scan.
//!
//! Uses the production v2 rule indices, concrete-instance iterator and absolute
//! service-day timeline. Every feasible state is expanded; no scalar arrival
//! pruning can erase an R3/M4 trade-off. This is a correctness reference, not
//! an interactive-performance claim. Resource exhaustion never yields a page.
//! GTFS: <https://gtfs.org/documentation/schedule/reference/#transferstxt>,
//! <https://gtfs.org/documentation/schedule/reference/#frequenciestxt>, and
//! <https://gtfs.org/documentation/schedule/reference/#field-types>.

use super::events::{event_sort_key, EntryEventEnumerationError};
use super::r3::*;
use super::round::increment;
use super::trip_based::TransferKind;
use super::EntryEvent;
use crate::engine::consts::{rescale_walk_secs, RAPTOR_MAX_ROUNDS};
use crate::engine::scan::{
    alight_secs_at, dep_secs_at, drop_off_forbidden_at, pickup_forbidden_at,
};
use crate::engine::v2::{
    index::V2Index,
    instances::{visit_instances, ConcreteInstance},
    rules::{ordinary_floor, synthetic_elapsed, RuleIndex, Selected, Transition},
    scan::Inst,
    time,
};
use crate::engine::{EngineError, Index, Mobility, Query};
use crate::{Reader, Transfers};
use alloc::vec::Vec;
use core::ops::Range;

pub(super) fn entry_events<B>(
    reader: &Reader<B>,
    index: &Index,
    query: &Query,
    window: Range<i64>,
    max_events: usize,
) -> Result<Vec<EntryEvent>, EntryEventEnumerationError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let v2 = index.v2.as_deref().ok_or(EngineError::UnsupportedVersion)?;
    if window.start >= window.end {
        return Ok(Vec::new());
    }
    let frame = time::query_frame(reader, query.date, window.start, v2.max_event_secs)?;
    time::query_frame(reader, query.date, window.end - 1, v2.max_event_secs)?;
    let mut events = Vec::new();
    for entry in &query.entry_stops {
        if inaccessible(reader, query, entry.stop)? {
            continue;
        }
        let ready = window
            .start
            .checked_add(entry.walk_secs as i64)
            .ok_or(EngineError::TimeOverflow)?;
        let deadline = (window.end - 1)
            .checked_add(entry.walk_secs as i64)
            .ok_or(EngineError::TimeOverflow)?;
        let dates = time::candidate_dates(
            reader,
            frame
                .origin_unix
                .checked_add(ready)
                .ok_or(EngineError::TimeOverflow)?,
            frame
                .origin_unix
                .checked_add(deadline)
                .ok_or(EngineError::TimeOverflow)?,
            v2.min_event_secs,
            v2.max_event_secs,
        )?;
        let Some(routes) = index.routes_at_stop.get(&entry.stop) else {
            continue;
        };
        for &ri in routes {
            let route = &index.routes[ri as usize];
            if !route_allowed(route, query) {
                continue;
            }
            for trip in &route.trips {
                let info = v2.trips[trip.trip_idx as usize];
                if info.route == u32::MAX || !trip_allowed(trip, query) {
                    continue;
                }
                for (pos, &stop) in route.stop_ids.iter().enumerate() {
                    if stop != entry.stop
                        || pos >= info.last_pos as usize
                        || trip.pos_to_row.get(pos).copied().unwrap_or(-1) == -1
                        || pickup_forbidden_at(reader, trip, pos)
                    {
                        continue;
                    }
                    visit_instances(
                        reader,
                        v2,
                        trip,
                        pos,
                        dates.clone(),
                        frame.origin_unix,
                        ready,
                        deadline,
                        true,
                        |c| -> Result<(), EntryEventEnumerationError> {
                            if events.len() >= max_events {
                                return Err(EntryEventEnumerationError::LimitExceeded {
                                    max_events,
                                    attempted_events: events.len().saturating_add(1),
                                });
                            }
                            let date = crate::reader::days_add(
                                reader.feed_start_date(),
                                c.inst.date as i64,
                            );
                            events.push(EntryEvent {
                                service_date: date,
                                route_idx: ri,
                                trip_idx: c.inst.trip,
                                board_position: pos as u32,
                                origin_ready_secs: c
                                    .board_secs
                                    .checked_sub(entry.walk_secs as i64)
                                    .ok_or(EngineError::TimeOverflow)?,
                                effective_board_secs: c.board_secs,
                                frequency_offset_secs: c.inst.shift,
                            });
                            Ok(())
                        },
                    )?;
                }
            }
        }
    }
    events.sort_by_key(event_sort_key);
    events.dedup();
    Ok(events)
}

pub(super) fn inaccessible<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    query: &Query,
    stop: u32,
) -> Result<bool, EngineError> {
    Ok(matches!(query.mobility, Mobility::Wheelchair)
        && reader.stop_wheelchair_boarding(stop as usize)? == 2)
}

pub(super) fn route_allowed(route: &crate::engine::index::IndexRoute, query: &Query) -> bool {
    !query.excluded_routes.contains(&route.reader_route_idx)
        && !query
            .excluded_modes
            .iter()
            .any(|&r| crate::engine::mode::route_type_to_mode(r) == route.mode)
}

pub(super) fn trip_allowed(trip: &crate::engine::index::RouteTrip, query: &Query) -> bool {
    !(matches!(query.mobility, Mobility::Wheelchair) && trip.wheelchair_accessible == 2)
        && !(matches!(query.mobility, Mobility::Bicycle) && trip.bikes_allowed == 2)
}

pub(super) struct Session<'a, B: AsRef<[u8]>> {
    reader: &'a Reader<B>,
    index: &'a Index,
    query: &'a Query,
    transfers: Option<&'a Transfers>,
    window: Range<i64>,
    events: Vec<EntryEvent>,
    cursor: usize,
    max_labels: usize,
    objectives: ProfileObjectives,
    profile: Vec<R3Point>,
    emitted: Vec<R3Point>,
    diagnostics: R3Diagnostics,
    failed: bool,
}

impl<'a, B: AsRef<[u8]> + Send + Sync + 'static> Session<'a, B> {
    pub(super) fn new(
        reader: &'a Reader<B>,
        index: &'a Index,
        request: R3Request<'a>,
        objectives: ProfileObjectives,
    ) -> Result<Self, R3Error> {
        let events = entry_events(
            reader,
            index,
            request.query,
            request.window.clone(),
            request.max_entry_events,
        )
        .map_err(|e| match e {
            EntryEventEnumerationError::Engine(e) => R3Error::Engine(e),
            EntryEventEnumerationError::LimitExceeded {
                max_events,
                attempted_events,
            } => R3Error::EntryEventsExhausted {
                max_entry_events: max_events,
                attempted_events,
            },
        })?;
        let n = events.len();
        Ok(Self {
            reader,
            index,
            query: request.query,
            transfers: request.transfers,
            window: request.window,
            events,
            cursor: n,
            max_labels: request.max_labels,
            objectives,
            profile: Vec::new(),
            emitted: Vec::new(),
            diagnostics: R3Diagnostics {
                enumerated_entry_events: n,
                ..R3Diagnostics::default()
            },
            failed: false,
        })
    }

    pub(super) fn next_page(&mut self, page_size: usize) -> Result<R3ProfilePage, R3Error> {
        if self.failed {
            return Err(R3Error::InvalidRequest(
                "exhausted temporal session must be recreated",
            ));
        }
        if page_size == 0 {
            return Err(R3Error::InvalidRequest(
                "temporal R3 page size must be positive",
            ));
        }
        let before = self.diagnostics;
        while self.cursor > 0 && self.new_points().count() < page_size {
            let ready = self.events[self.cursor - 1].origin_ready_secs;
            let mut start = self.cursor - 1;
            while start > 0 && self.events[start - 1].origin_ready_secs == ready {
                start -= 1;
            }
            for i in start..self.cursor {
                let event = self.events[i];
                let mut search = Search {
                    reader: self.reader,
                    index: self.index,
                    v2: self
                        .index
                        .v2
                        .as_deref()
                        .ok_or(EngineError::UnsupportedVersion)?,
                    query: self.query,
                    transfers: self.transfers,
                    event,
                    deadline: ready
                        .checked_add(time::ROUTING_HORIZON_SECS)
                        .ok_or(EngineError::TimeOverflow)?,
                    origin_unix: time::origin(
                        self.reader,
                        time::date_ordinal(self.reader, self.query.date)
                            .ok_or(EngineError::UnsupportedServiceDate)?,
                    )?,
                    states: Vec::new(),
                    pending: Vec::new(),
                    points: Vec::new(),
                    strategy: Exhaustive {
                        max_labels: self.max_labels,
                    },
                    objectives: self.objectives,
                    diagnostics: &mut self.diagnostics,
                };
                match search.run() {
                    Ok(points) => {
                        for point in points {
                            insert_point(&mut self.profile, point, self.objectives);
                        }
                    }
                    Err(e) => {
                        self.failed = true;
                        return Err(e);
                    }
                }
                increment(&mut self.diagnostics.entry_events)?;
            }
            self.cursor = start;
            increment(&mut self.diagnostics.timestamp_buckets)?;
        }
        let mut points: Vec<_> = self.new_points().cloned().collect();
        points.sort_by(|a, b| {
            b.origin_departure_secs
                .cmp(&a.origin_departure_secs)
                .then(a.destination_arrival_secs.cmp(&b.destination_arrival_secs))
                .then(a.actual_transfers.cmp(&b.actual_transfers))
                .then(a.total_walk_secs.cmp(&b.total_walk_secs))
                .then(a.witness.cmp(&b.witness))
        });
        let completion = if points.len() >= page_size {
            R3PageCompletion::SurvivorTargetClosed
        } else {
            R3PageCompletion::WindowExhausted
        };
        self.emitted.extend(points.iter().cloned());
        let exhausted = self.cursor == 0;
        let covered = if exhausted {
            self.window.start
        } else {
            self.events[self.cursor].origin_ready_secs
        };
        let now = self.diagnostics;
        Ok(R3ProfilePage {
            points,
            objectives: self.objectives,
            requested_page_size: page_size,
            completion,
            supported_service_date: self.query.date,
            ptft_status: if self.transfers.is_some() {
                R3PtftStatus::Applied
            } else {
                R3PtftStatus::NotSupplied
            },
            multi_date_status: R3MultiDateStatus::ServiceDayOrigins,
            requested_window: self.window.clone(),
            coverage_scope: R3CoverageScope::SuppliedWindowOnly,
            covered_window: covered..self.window.end,
            covered_frontier_secs: covered,
            latest_departure_certificate: R3LatestDepartureCertificate {
                covered_from_secs: covered,
                covered_until_exclusive_secs: self.window.end,
                next_unprocessed_origin_ready_secs: if exhausted {
                    None
                } else {
                    Some(self.events[self.cursor - 1].origin_ready_secs)
                },
                equal_time_boundary_closed: true,
            },
            page_complete: true,
            window_exhausted: exhausted,
            day_exhausted: false,
            diagnostics: now,
            page_diagnostics: R3Diagnostics {
                entry_events: now.entry_events - before.entry_events,
                enumerated_entry_events: 0,
                timestamp_buckets: now.timestamp_buckets - before.timestamp_buckets,
                accepted_labels: now.accepted_labels - before.accepted_labels,
                propagated_labels: now.propagated_labels - before.propagated_labels,
                reused_labels: now.reused_labels - before.reused_labels,
            },
        })
    }

    fn new_points(&self) -> impl Iterator<Item = &R3Point> {
        self.profile.iter().filter(|p| {
            !self
                .emitted
                .iter()
                .any(|e| equal_objectives(p, e, self.objectives))
        })
    }
}

#[derive(Clone, Copy)]
pub(super) struct State {
    pub(super) inst: Inst,
    pub(super) stop: u32,
    pub(super) position: u32,
    pub(super) time: i64,
    pub(super) transfers: u32,
    pub(super) rounds: u32,
    pub(super) walk: u64,
    pub(super) can_alight: bool,
    pub(super) id: usize,
    pub(super) parent: Option<usize>,
    pub(super) leg: R3TransitWitness,
    pub(super) origin_departure: i64,
    pub(super) continuation_only: bool,
}

/// Exact target hint for lazy predecessor validation. It narrows enumeration,
/// never changes movement, rule specificity, calendar or instance legality.
#[derive(Clone, Copy)]
pub(super) struct BoardingTarget {
    pub(super) route: u32,
    pub(super) position: u32,
    pub(super) instance: ConcreteInstance,
}

pub(super) trait Strategy {
    type Error: From<EngineError>;
    fn before_board(&mut self) -> Result<(), Self::Error>;
    fn before_stop(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
    fn before_trip(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
    /// Optional accounting before reading a raw PTFT edge, including duplicates
    /// later removed by the shared shortest-directed-movement normalization.
    fn before_physical_edge(&mut self) -> Result<(), EngineError> {
        Ok(())
    }
    fn deadline_ceiling(&self) -> Option<i64> {
        None
    }
    fn eager_destinations(&self) -> bool {
        false
    }
    fn after_destinations(&mut self, _: &[R3Point]) -> Result<(), Self::Error> {
        Ok(())
    }
    fn accept(
        &mut self,
        candidate: &State,
        arena: &[State],
        accepted: usize,
    ) -> Result<bool, Self::Error>;
    fn active(&self, _: usize) -> bool {
        true
    }
    fn split_continuations(&self, _: u32) -> bool {
        false
    }
    fn boarding_target(&self) -> Option<BoardingTarget> {
        None
    }
    /// Sees every non-origin boarding before its ride expands; `false`
    /// skips the ride. Trip-transfer preprocessing records without riding.
    fn observe_board(&mut self, _: &State, _: &Boarding) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// One concrete boarding from an arrival state: the movement that formed it,
/// its physical walking, and the minimum arrival-to-departure time it needs.
#[derive(Clone, Copy)]
pub(super) struct Boarding {
    pub(super) kind: TransferKind,
    pub(super) instance: ConcreteInstance,
    pub(super) route: u32,
    pub(super) position: u32,
    pub(super) walk: u64,
    pub(super) elapsed: i64,
}

impl Movement {
    fn kind(&self) -> TransferKind {
        if self.synthetic {
            TransferKind::Synthetic
        } else if self.walk.is_some() {
            TransferKind::Footpath
        } else {
            TransferKind::SameStop
        }
    }
}

struct Exhaustive {
    max_labels: usize,
}

impl Strategy for Exhaustive {
    type Error = R3Error;
    fn before_board(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
    fn accept(&mut self, _: &State, _: &[State], accepted: usize) -> Result<bool, Self::Error> {
        if accepted >= self.max_labels {
            return Err(R3Error::ResourceExhausted {
                max_labels: self.max_labels,
                attempted_labels: accepted.saturating_add(1),
            });
        }
        Ok(true)
    }
}

struct Search<'a, B: AsRef<[u8]>, S> {
    reader: &'a Reader<B>,
    index: &'a Index,
    v2: &'a V2Index,
    query: &'a Query,
    transfers: Option<&'a Transfers>,
    event: EntryEvent,
    deadline: i64,
    origin_unix: i64,
    states: Vec<State>,
    pending: Vec<usize>,
    points: Vec<R3Point>,
    strategy: S,
    objectives: ProfileObjectives,
    diagnostics: &'a mut R3Diagnostics,
}

#[derive(Clone, Copy)]
struct Movement {
    stop: u32,
    walk: Option<i64>,
    synthetic: bool,
}

#[derive(Clone, Copy)]
struct BoardSource {
    state: usize,
    movement: Movement,
}

struct PreparedSource {
    source: BoardSource,
    order: usize,
    ready: i64,
    walk: u64,
    excluded_board: Option<i64>,
}

impl PreparedSource {
    fn covers(&self, other: &Self, states: &[State]) -> bool {
        let a = states[self.source.state];
        let b = states[other.source.state];
        self.ready <= other.ready
            && self.walk <= other.walk
            && a.origin_departure >= b.origin_departure
            && a.rounds <= b.rounds
            && a.transfers <= b.transfers
            // A source cannot reboard its own concrete vehicle. Its exclusion
            // must also exclude B, or lie strictly before B can board.
            && (a.inst == b.inst || self.excluded_board.is_none_or(|t| t < other.ready))
    }
}

#[cfg(test)]
#[test]
fn source_frontier_exclusion_is_strict_and_uses_concrete_date_and_frequency_shift() {
    let state = State {
        inst: Inst {
            trip: 1,
            date: 3,
            shift: 0,
        },
        stop: 0,
        position: 1,
        time: 100,
        transfers: 0,
        rounds: 1,
        walk: 0,
        can_alight: true,
        id: 0,
        parent: None,
        leg: R3TransitWitness {
            service_date: 20261004,
            route_idx: 0,
            reader_route_idx: 0,
            trip_idx: 1,
            board_position: 0,
            alight_position: 1,
            board_secs: 0,
            alight_secs: 100,
            frequency_offset_secs: 0,
            frequency_instance: false,
            in_seat: false,
        },
        origin_departure: 0,
        continuation_only: false,
    };
    let mut states = [state, State { id: 1, ..state }];
    let a = PreparedSource {
        source: BoardSource {
            state: 0,
            movement: Movement {
                stop: 0,
                walk: None,
                synthetic: false,
            },
        },
        order: 0,
        ready: 200,
        walk: 0,
        excluded_board: Some(300),
    };
    let mut b = PreparedSource {
        source: BoardSource {
            state: 1,
            movement: a.source.movement,
        },
        order: 1,
        ready: 300,
        walk: 0,
        excluded_board: None,
    };
    assert!(a.covers(&b, &states)); // identical instance excludes both
    states[1].inst.date += 1;
    assert!(!a.covers(&b, &states)); // same trip on another day can board A
    states[1].inst = Inst {
        shift: 100,
        ..state.inst
    };
    assert!(!a.covers(&b, &states)); // likewise another frequency instance
    b.ready = 301;
    assert!(a.covers(&b, &states)); // excluded departure is strictly too early
    b.ready = 199;
    assert!(!a.covers(&b, &states));
    b.ready = 301;
    states[0].walk = 999; // use resolved total walk, not just source walk
    assert!(a.covers(&b, &states));
    states[0].transfers = 1;
    assert!(!a.covers(&b, &states));
    states[0] = state;
    states[0].rounds = 2;
    assert!(!a.covers(&b, &states));
    states[0] = state;
    states[0].origin_departure = -1;
    assert!(!a.covers(&b, &states));
    states[0] = state;
    let more_walk = PreparedSource { walk: 1, ..a };
    assert!(!more_walk.covers(&b, &states));
}
impl<B: AsRef<[u8]> + Send + Sync + 'static, S: Strategy> Search<'_, B, S> {
    fn run(&mut self) -> Result<Vec<R3Point>, S::Error> {
        self.seed(self.event)?;
        while let Some(id) = self.pending.pop() {
            if !self.strategy.active(id) {
                continue;
            }
            let state = self.states[id];
            increment(&mut self.diagnostics.propagated_labels)?;
            for movement in self.prepare(&state)? {
                self.board(&state, movement.stop, movement.walk, movement.synthetic)?;
            }
            if state.rounds < self.query.max_rounds.unwrap_or(RAPTOR_MAX_ROUNDS) {
                self.linked(&state)?;
            }
        }
        Ok(core::mem::take(&mut self.points))
    }

    fn activate(&mut self, state: &State) -> Result<(), EngineError> {
        self.deadline = state
            .origin_departure
            .checked_add(time::ROUTING_HORIZON_SECS)
            .ok_or(EngineError::TimeOverflow)?;
        if let Some(ceiling) = self.strategy.deadline_ceiling() {
            self.deadline = self.deadline.min(ceiling);
        }
        Ok(())
    }

    fn seed(&mut self, event: EntryEvent) -> Result<(), S::Error> {
        self.event = event;
        self.deadline = event
            .origin_ready_secs
            .checked_add(time::ROUTING_HORIZON_SECS)
            .ok_or(EngineError::TimeOverflow)?;
        if let Some(ceiling) = self.strategy.deadline_ceiling() {
            self.deadline = self.deadline.min(ceiling);
        }
        if self.query.max_rounds == Some(0) {
            return Ok(());
        }
        let date = time::date_ordinal(self.reader, event.service_date)
            .ok_or(EngineError::UnsupportedServiceDate)?;
        let inst = Inst {
            trip: event.trip_idx,
            date: date as u32,
            shift: event.frequency_offset_secs,
        };
        let info = self.v2.trips[inst.trip as usize];
        let approximate = self.v2.freq.get(&inst.trip).is_some_and(|windows| {
            windows.iter().any(|w| {
                !w.exact
                    && inst.shift + self.v2.first_dep[inst.trip as usize] >= w.start
                    && inst.shift + self.v2.first_dep[inst.trip as usize] < w.end
            })
        });
        let access = event
            .effective_board_secs
            .checked_sub(event.origin_ready_secs)
            .ok_or(EngineError::TimeOverflow)?;
        self.strategy.before_board()?;
        self.ride(
            None,
            ConcreteInstance {
                board_secs: event.effective_board_secs,
                inst,
                approximate,
            },
            info.route,
            info.slot,
            event.board_position,
            false,
            access as u64,
        )
    }

    // A transit state creates at most one movement per outgoing source. Walking
    // sources board a ride; they never recursively generate another walk.
    fn prepare(&mut self, state: &State) -> Result<Vec<Movement>, S::Error> {
        self.strategy.before_stop()?;
        self.activate(state)?;
        let mut sources = Vec::new();
        if !state.can_alight || state.continuation_only {
            return Ok(sources);
        }
        self.record(state, state.stop, state.time, state.walk)?;
        let edges = self.walks(state.stop)?;
        for &(stop, walk) in &edges {
            self.strategy.before_stop()?;
            let arrive = state
                .time
                .checked_add(walk)
                .ok_or(EngineError::TimeOverflow)?;
            if arrive <= self.deadline {
                self.record(state, stop, arrive, add_walk(state.walk, walk)?)?;
            }
        }
        if state.rounds >= self.query.max_rounds.unwrap_or(RAPTOR_MAX_ROUNDS) {
            return Ok(sources);
        }
        sources.push(Movement {
            stop: state.stop,
            walk: None,
            synthetic: false,
        });
        for &(stop, walk) in &edges {
            self.strategy.before_stop()?;
            sources.push(Movement {
                stop,
                walk: Some(walk),
                synthetic: false,
            });
        }
        let synthetic = synthetic_destinations(
            &self.v2.rules,
            state.stop,
            Some((
                state.inst.trip,
                self.v2.trips[state.inst.trip as usize].reader_route,
            )),
        );
        for stop in synthetic {
            self.strategy.before_stop()?;
            if stop != state.stop && !edges.iter().any(|&(s, _)| s == stop) {
                sources.push(Movement {
                    stop,
                    walk: None,
                    synthetic: true,
                });
            }
        }
        Ok(sources)
    }

    fn walks(&mut self, stop: u32) -> Result<Vec<(u32, i64)>, EngineError> {
        physical_walks_metered(self.reader, self.query, self.transfers, stop, || {
            self.strategy.before_physical_edge()
        })
    }

    fn record(&mut self, state: &State, stop: u32, arrive: i64, walk: u64) -> Result<(), S::Error> {
        let Some(egress) = self
            .query
            .exit_stops
            .iter()
            .filter(|e| e.stop == stop)
            .map(|e| e.walk_secs)
            .min()
        else {
            return Ok(());
        };
        if inaccessible(self.reader, self.query, stop)? {
            return Ok(());
        }
        let witness = self.witness(state.id);
        insert_point(
            &mut self.points,
            R3Point {
                origin_departure_secs: state.origin_departure,
                destination_arrival_secs: arrive
                    .checked_add(egress as i64)
                    .ok_or(EngineError::TimeOverflow)?,
                actual_transfers: state.transfers,
                transit_rounds: state.rounds,
                total_walk_secs: walk
                    .checked_add(egress as u64)
                    .ok_or(EngineError::TimeOverflow)?,
                service_date: self.query.date,
                witness,
            },
            self.objectives,
        );
        Ok(())
    }

    fn witness(&self, mut id: usize) -> Vec<R3TransitWitness> {
        let mut legs = Vec::new();
        loop {
            let state = &self.states[id];
            legs.push(state.leg);
            let Some(parent) = state.parent else {
                break;
            };
            id = parent;
        }
        legs.reverse();
        legs
    }

    fn board(
        &mut self,
        state: &State,
        stop: u32,
        walk: Option<i64>,
        synthetic: bool,
    ) -> Result<(), S::Error> {
        let index = self.index;
        if let Some(target) = self.strategy.boarding_target() {
            if index.routes[target.route as usize].stop_ids[target.position as usize] == stop {
                return self.board_at(
                    state,
                    stop,
                    walk,
                    synthetic,
                    target.route,
                    target.position as usize,
                );
            }
            return Ok(());
        }
        let Some(routes) = index.routes_at_stop.get(&stop) else {
            return Ok(());
        };
        for &ri in routes {
            for (position, &s) in index.routes[ri as usize].stop_ids.iter().enumerate() {
                self.strategy.before_stop()?;
                if s == stop {
                    self.board_at(state, stop, walk, synthetic, ri, position)?;
                }
            }
        }
        Ok(())
    }

    fn board_at(
        &mut self,
        state: &State,
        stop: u32,
        walk: Option<i64>,
        synthetic: bool,
        ri: u32,
        position: usize,
    ) -> Result<(), S::Error> {
        let target = self.strategy.boarding_target();
        if target.is_some_and(|t| t.route != ri || t.position as usize != position) {
            return Ok(());
        }
        self.activate(state)?;
        if inaccessible(self.reader, self.query, stop)? {
            return Ok(());
        }
        let reader = self.reader;
        let index = self.index;
        let v2 = self.v2;
        let route = &index.routes[ri as usize];
        if !route_allowed(route, self.query) {
            return Ok(());
        }
        let dates = if let Some(target) = target {
            target.instance.inst.date as usize..target.instance.inst.date as usize + 1
        } else {
            time::candidate_dates(
                reader,
                self.origin_unix
                    .checked_add(state.time)
                    .ok_or(EngineError::TimeOverflow)?,
                self.origin_unix
                    .checked_add(self.deadline)
                    .ok_or(EngineError::TimeOverflow)?,
                v2.min_event_secs,
                v2.max_event_secs,
            )?
        };
        let movement = Movement {
            stop,
            walk,
            synthetic,
        };
        let slots = target.map_or(0..route.trips.len(), |t| {
            let slot = v2.trips[t.instance.inst.trip as usize].slot as usize;
            slot..slot + 1
        });
        for slot in slots {
            self.strategy.before_trip()?;
            let trip = &route.trips[slot];
            let info = v2.trips[trip.trip_idx as usize];
            if info.route == u32::MAX
                || !trip_allowed(trip, self.query)
                || position >= info.last_pos as usize
                || trip.pos_to_row[position] == -1
                || pickup_forbidden_at(reader, trip, position)
            {
                continue;
            }
            let Some((ready, total_walk)) =
                self.boarding_cost(state, movement, ri, position, trip.trip_idx)?
            else {
                continue;
            };
            let (dates, visit_ready, deadline) = if let Some(target) = target {
                if target.instance.board_secs < ready || target.instance.board_secs > self.deadline
                {
                    continue;
                }
                (
                    target.instance.inst.date as usize..target.instance.inst.date as usize + 1,
                    target.instance.board_secs,
                    target.instance.board_secs,
                )
            } else {
                (dates.clone(), ready, self.deadline)
            };
            visit_instances(
                reader,
                v2,
                trip,
                position,
                dates,
                self.origin_unix,
                visit_ready,
                deadline,
                true,
                |candidate| -> Result<(), S::Error> {
                    self.strategy.before_board()?;
                    if target.is_some_and(|t| candidate.inst != t.instance.inst) {
                        return Ok(());
                    }
                    if candidate.inst != state.inst
                        && self.strategy.observe_board(
                            state,
                            &Boarding {
                                kind: movement.kind(),
                                instance: candidate,
                                route: ri,
                                position: position as u32,
                                walk: total_walk - state.walk,
                                elapsed: ready - state.time,
                            },
                        )?
                    {
                        self.ride(
                            Some(state),
                            candidate,
                            ri,
                            slot as u32,
                            position as u32,
                            false,
                            total_walk,
                        )?;
                    }
                    Ok(())
                },
            )?;
        }
        Ok(())
    }

    // One rule/cost primitive for exhaustive and bounded boarding. Only the
    // guarded scheduled and source-frontier paths may share across target trips.
    fn boarding_cost(
        &self,
        state: &State,
        movement: Movement,
        ri: u32,
        position: usize,
        target: u32,
    ) -> Result<Option<(i64, u64)>, EngineError> {
        let source = self.v2.trips[state.inst.trip as usize];
        let info = self.v2.trips[target as usize];
        let selected = self
            .v2
            .rules
            .resolve(&Transition {
                from_stop: state.stop,
                to_stop: movement.stop,
                from_trip: state.inst.trip,
                from_route: source.reader_route,
                to_trip: target,
                to_route: self.index.routes[ri as usize].reader_route_idx,
                at_boundary: state.position == source.last_pos
                    && position == info.first_pos as usize,
            })
            .0;
        let rule = match selected {
            Selected::Linked(_) => return Ok(None),
            Selected::None => None,
            Selected::Ordinary(i) => Some(&self.v2.rules.ordinary[i as usize]),
        };
        let base = self.query.min_transfer_floor_secs();
        let elapsed = if movement.synthetic {
            synthetic_elapsed(rule, base)
        } else {
            ordinary_floor(rule, base).map(|f| movement.walk.map_or(f, |w| f.max(w)))
        };
        let Some(elapsed) = elapsed else {
            return Ok(None);
        };
        let ready = state
            .time
            .checked_add(elapsed)
            .ok_or(EngineError::TimeOverflow)?;
        let total_walk = add_walk(
            state.walk,
            if movement.synthetic {
                elapsed
            } else {
                movement.walk.unwrap_or(0)
            },
        )?;
        Ok(Some((ready, total_walk)))
    }

    fn linked(&mut self, state: &State) -> Result<(), S::Error> {
        self.activate(state)?;
        let reader = self.reader;
        let index = self.index;
        let v2 = self.v2;
        let source = v2.trips[state.inst.trip as usize];
        if state.position != source.last_pos || source.is_frequency {
            return Ok(());
        }
        if let Some(targets) = v2.rules.linked_targets.get(&state.inst.trip) {
            for &target in targets {
                let info = v2.trips[target as usize];
                if info.route == u32::MAX {
                    continue;
                }
                let route = &index.routes[info.route as usize];
                let trip = &route.trips[info.slot as usize];
                if !route_allowed(route, self.query) || !trip_allowed(trip, self.query) {
                    continue;
                }
                let stop = route.stop_ids[info.first_pos as usize];
                let Selected::Linked(row) = v2
                    .rules
                    .resolve(&Transition {
                        from_stop: state.stop,
                        to_stop: stop,
                        from_trip: state.inst.trip,
                        from_route: source.reader_route,
                        to_trip: target,
                        to_route: info.reader_route,
                        at_boundary: true,
                    })
                    .0
                else {
                    continue;
                };
                let rule = v2.rules.linked[row as usize];
                if !rule.pairing_available {
                    continue;
                }
                let in_seat = rule.transfer_type == 4;
                let min = rule.min_secs.map(|m| m as i64);
                let (elapsed, walk) = if in_seat {
                    (min.unwrap_or(0), 0)
                } else {
                    if !state.can_alight
                        || pickup_forbidden_at(reader, trip, info.first_pos as usize)
                        || inaccessible(reader, self.query, stop)?
                    {
                        continue;
                    }
                    let base = self.query.min_transfer_floor_secs();
                    let floor = min.map_or(base, |m| m.max(base));
                    if stop == state.stop {
                        (floor, 0)
                    } else if let Some((_, w)) =
                        self.walks(state.stop)?.iter().find(|e| e.0 == stop)
                    {
                        (floor.max(*w), *w)
                    } else if min.is_some() {
                        (floor, floor)
                    } else {
                        continue;
                    }
                };
                let arrival_unix = self
                    .origin_unix
                    .checked_add(state.time)
                    .ok_or(EngineError::TimeOverflow)?;
                let Some(date) = time::first_date_at_or_after(
                    reader,
                    v2.first_dep[target as usize],
                    arrival_unix,
                )?
                else {
                    continue;
                };
                let ymd = crate::reader::days_add(reader.feed_start_date(), date as i64);
                if !reader.service_active_on(trip.service_idx, ymd) {
                    continue;
                }
                let board = time::origin(reader, date)?
                    .checked_sub(self.origin_unix)
                    .and_then(|s| s.checked_add(v2.first_dep[target as usize]))
                    .ok_or(EngineError::TimeOverflow)?;
                if board
                    < state
                        .time
                        .checked_add(elapsed)
                        .ok_or(EngineError::TimeOverflow)?
                    || board > self.deadline
                    || board - state.time > time::MAX_LINK_WAIT_SECS
                {
                    continue;
                }
                self.strategy.before_board()?;
                let instance = ConcreteInstance {
                    board_secs: board,
                    inst: Inst {
                        trip: target,
                        date: date as u32,
                        shift: 0,
                    },
                    approximate: false,
                };
                let observed = Boarding {
                    kind: if in_seat {
                        TransferKind::InSeat
                    } else {
                        TransferKind::Linked
                    },
                    instance,
                    route: info.route,
                    position: info.first_pos,
                    walk: add_walk(0, walk)?,
                    elapsed,
                };
                if self.strategy.observe_board(state, &observed)? {
                    self.ride(
                        Some(state),
                        instance,
                        info.route,
                        info.slot,
                        info.first_pos,
                        in_seat,
                        add_walk(state.walk, walk)?,
                    )?;
                }
            }
        }
        if let Some(targets) = v2.derived.get(&(state.inst.trip, state.inst.date)) {
            for &target in targets {
                let info = v2.trips[target as usize];
                if info.route == u32::MAX {
                    continue;
                }
                let route = &index.routes[info.route as usize];
                let trip = &route.trips[info.slot as usize];
                if !route_allowed(route, self.query) || !trip_allowed(trip, self.query) {
                    continue;
                }
                let board = time::origin(reader, state.inst.date as usize)?
                    .checked_sub(self.origin_unix)
                    .and_then(|s| s.checked_add(v2.first_dep[target as usize]))
                    .ok_or(EngineError::TimeOverflow)?;
                if board < state.time || board > self.deadline {
                    continue;
                }
                self.strategy.before_board()?;
                let instance = ConcreteInstance {
                    board_secs: board,
                    inst: Inst {
                        trip: target,
                        date: state.inst.date,
                        shift: 0,
                    },
                    approximate: false,
                };
                let observed = Boarding {
                    kind: TransferKind::Derived,
                    instance,
                    route: info.route,
                    position: info.first_pos,
                    walk: 0,
                    elapsed: 0,
                };
                if self.strategy.observe_board(state, &observed)? {
                    self.ride(
                        Some(state),
                        instance,
                        info.route,
                        info.slot,
                        info.first_pos,
                        true,
                        state.walk,
                    )?;
                }
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn ride(
        &mut self,
        parent: Option<&State>,
        candidate: ConcreteInstance,
        ri: u32,
        slot: u32,
        board: u32,
        in_seat: bool,
        walk: u64,
    ) -> Result<(), S::Error> {
        let index = self.index;
        let route = &index.routes[ri as usize];
        let trip = &route.trips[slot as usize];
        let info = self.v2.trips[candidate.inst.trip as usize];
        let base = time::origin(self.reader, candidate.inst.date as usize)?
            .checked_sub(self.origin_unix)
            .and_then(|s| s.checked_add(candidate.inst.shift))
            .ok_or(EngineError::TimeOverflow)?;
        for pos in board as usize + 1..=info.last_pos as usize {
            self.strategy.before_stop()?;
            if trip.pos_to_row[pos] == -1 {
                continue;
            }
            let arrive = base
                .checked_add(alight_secs_at(self.reader, trip, pos)?)
                .ok_or(EngineError::TimeOverflow)?;
            if arrive > self.deadline {
                continue;
            }
            let stop = route.stop_ids[pos];
            let can_alight = !drop_off_forbidden_at(self.reader, trip, pos)
                && !inaccessible(self.reader, self.query, stop)?;
            if !can_alight && pos != info.last_pos as usize {
                continue;
            }
            let leg = R3TransitWitness {
                service_date: crate::reader::days_add(
                    self.reader.feed_start_date(),
                    candidate.inst.date as i64,
                ),
                route_idx: ri,
                reader_route_idx: route.reader_route_idx,
                trip_idx: candidate.inst.trip,
                board_position: board,
                alight_position: pos as u32,
                board_secs: candidate.board_secs,
                alight_secs: arrive,
                frequency_offset_secs: candidate.inst.shift,
                frequency_instance: candidate.approximate,
                in_seat,
            };
            let state = State {
                inst: candidate.inst,
                stop,
                position: pos as u32,
                time: arrive,
                transfers: match parent {
                    None => 0,
                    Some(p) => p
                        .transfers
                        .checked_add(u32::from(!in_seat))
                        .ok_or(EngineError::TimeOverflow)?,
                },
                rounds: match parent {
                    None => 1,
                    Some(p) => p.rounds.checked_add(1).ok_or(EngineError::TimeOverflow)?,
                },
                walk,
                can_alight,
                id: self.states.len(),
                parent: parent.map(|p| p.id),
                leg,
                origin_departure: parent
                    .map_or(self.event.origin_ready_secs, |p| p.origin_departure),
                continuation_only: false,
            };
            if self.strategy.split_continuations(candidate.inst.trip)
                && pos == info.last_pos as usize
            {
                if can_alight {
                    self.insert(state)?;
                }
                self.insert(State {
                    continuation_only: true,
                    ..state
                })?;
            } else {
                self.insert(state)?;
            }
        }
        Ok(())
    }
    fn insert(&mut self, mut state: State) -> Result<(), S::Error> {
        state.id = self.states.len();
        if self
            .strategy
            .accept(&state, &self.states, self.diagnostics.accepted_labels)?
        {
            self.states.push(state);
            self.pending.push(state.id);
            increment(&mut self.diagnostics.accepted_labels)?;
            if self.strategy.eager_destinations() {
                self.prepare(&state)?;
                self.strategy.after_destinations(&self.points)?;
            }
        } else {
            increment(&mut self.diagnostics.reused_labels)?;
        }
        Ok(())
    }
}

/// A later boarding beyond `first + 2 * spread` arrives strictly later at
/// every downstream position, even with overtaking. The index guards identical
/// future classes and costs. Retain the endpoint/ties and the full ride horizon.
/// GTFS dates, overnight times, and frequency replacement remain governed by
/// <https://gtfs.org/documentation/schedule/reference/#stop_timestxt> and
/// <https://gtfs.org/documentation/schedule/reference/#frequenciestxt>.
impl<B: AsRef<[u8]> + Send + Sync + 'static> Search<'_, B, super::round::Control<'_>> {
    /// Resolve transfer specificity before pruning sources. Target-trip-specific
    /// and linked-target patterns use exact source expansion instead:
    /// <https://gtfs.org/documentation/schedule/reference/#transferstxt>.
    /// Frontiers are per occurrence, including repeated loop/lasso stops.
    fn source_frontiers(
        &mut self,
        pattern: u32,
        sources: &[BoardSource],
        max_width: usize,
    ) -> Result<Vec<(usize, BoardSource)>, super::round::RoundProfileError> {
        use super::round::RoundProfileError;
        use alloc::collections::BTreeMap;
        let mut frontiers: BTreeMap<usize, Vec<PreparedSource>> = BTreeMap::new();
        let acceleration = self.strategy.index;
        let route = &self.index.routes[pattern as usize];
        increment(&mut self.strategy.diagnostics.source_frontier_patterns)?;
        for (order, &source) in sources.iter().enumerate() {
            if !self.strategy.active(source.state) {
                continue;
            }
            let state = self.states[source.state];
            for occurrence in acceleration.occurrences(source.movement.stop) {
                if occurrence.pattern != pattern || !acceleration.may_board(occurrence) {
                    continue;
                }
                increment(&mut self.strategy.diagnostics.source_frontier_inputs)?;
                let position = occurrence.position as usize;
                let Some((ready, walk)) = self.boarding_cost(
                    &state,
                    source.movement,
                    pattern,
                    position,
                    route.trips[0].trip_idx,
                )?
                else {
                    increment(&mut self.strategy.diagnostics.source_frontier_pruned)?;
                    continue;
                };
                let own = self.v2.trips[state.inst.trip as usize];
                let excluded_board = if own.route == pattern {
                    let trip = &route.trips[own.slot as usize];
                    if position < own.last_pos as usize
                        && trip.pos_to_row[position] != -1
                        && !pickup_forbidden_at(self.reader, trip, position)
                    {
                        let departure = dep_secs_at(self.reader, trip, position)?;
                        Some(
                            time::origin(self.reader, state.inst.date as usize)?
                                .checked_sub(self.origin_unix)
                                .and_then(|t| t.checked_add(state.inst.shift))
                                .and_then(|t| t.checked_add(departure))
                                .ok_or(EngineError::TimeOverflow)?,
                        )
                    } else {
                        None
                    }
                } else {
                    None
                };
                let candidate = PreparedSource {
                    source,
                    order,
                    ready,
                    walk,
                    excluded_board,
                };
                let frontier = frontiers.entry(position).or_default();
                let mut covered = false;
                for old in frontier.iter() {
                    increment(&mut self.strategy.diagnostics.source_frontier_comparisons)?;
                    if old.covers(&candidate, &self.states) {
                        covered = true;
                        break;
                    }
                }
                if covered {
                    increment(&mut self.strategy.diagnostics.source_frontier_pruned)?;
                    continue;
                }
                let mut i = 0;
                while i < frontier.len() {
                    increment(&mut self.strategy.diagnostics.source_frontier_comparisons)?;
                    if candidate.covers(&frontier[i], &self.states) {
                        frontier.remove(i);
                        increment(&mut self.strategy.diagnostics.source_frontier_pruned)?;
                    } else {
                        i += 1;
                    }
                }
                let width = frontier
                    .len()
                    .checked_add(1)
                    .ok_or(EngineError::TimeOverflow)?;
                if width > max_width {
                    return Err(RoundProfileError::BagWidthExhausted {
                        limit: max_width,
                        attempted: width,
                    });
                }
                self.strategy.diagnostics.max_source_frontier_width = self
                    .strategy
                    .diagnostics
                    .max_source_frontier_width
                    .max(width);
                frontier.push(candidate);
            }
        }
        let mut out = Vec::new();
        for (position, frontier) in frontiers {
            for source in frontier {
                increment(&mut self.strategy.diagnostics.source_frontier_survivors)?;
                out.push((source.order, position, source.source));
            }
        }
        // Preserve the reference's source/occurrence order. Grouping by position
        // alone admits avoidable intermediate labels before stronger sources.
        out.sort_unstable_by_key(|&(order, position, _)| (order, position));
        Ok(out
            .into_iter()
            .map(|(_, position, source)| (position, source))
            .collect())
    }

    fn board_bounded(
        &mut self,
        state: &State,
        movement: Movement,
        ri: u32,
        position: usize,
        bounds: &super::round::ScheduledBounds,
    ) -> Result<(), super::round::RoundProfileError> {
        self.activate(state)?;
        let reader = self.reader;
        let v2 = self.v2;
        let route = &self.index.routes[ri as usize];
        let slots = &bounds.slots[position];
        if slots.is_empty()
            || !route_allowed(route, self.query)
            || inaccessible(reader, self.query, movement.stop)?
        {
            return Ok(());
        }
        let Some((ready, walk)) = self.boarding_cost(
            state,
            movement,
            ri,
            position,
            route.trips[slots[0] as usize].trip_idx,
        )?
        else {
            return Ok(());
        };
        if ready > self.deadline {
            return Ok(());
        }
        let dates = time::candidate_dates(
            reader,
            self.origin_unix
                .checked_add(ready)
                .ok_or(EngineError::TimeOverflow)?,
            self.origin_unix
                .checked_add(self.deadline)
                .ok_or(EngineError::TimeOverflow)?,
            v2.min_event_secs,
            v2.max_event_secs,
        )?;
        let mut first: Option<i64> = None;
        for date in dates.clone() {
            let shift = time::origin(reader, date)?
                .checked_sub(self.origin_unix)
                .ok_or(EngineError::TimeOverflow)?;
            let start = scheduled_start(reader, route, slots, position, ready, shift)?;
            for &slot in &slots[start..] {
                increment(&mut self.strategy.diagnostics.scheduled_trip_checks)?;
                let trip = &route.trips[slot as usize];
                let board = shift
                    .checked_add(dep_secs_at(reader, trip, position)?)
                    .ok_or(EngineError::TimeOverflow)?;
                if board > self.deadline || first.is_some_and(|f| board > f) {
                    break;
                }
                if !trip_allowed(trip, self.query) {
                    continue;
                }
                let mut found = false;
                visit_instances(
                    reader,
                    v2,
                    trip,
                    position,
                    date..date + 1,
                    self.origin_unix,
                    ready,
                    self.deadline,
                    true,
                    |c| -> Result<(), EngineError> {
                        if c.inst != state.inst {
                            first = Some(first.map_or(c.board_secs, |f| f.min(c.board_secs)));
                            found = true;
                        }
                        Ok(())
                    },
                )?;
                if found {
                    break;
                }
            }
        }
        let Some(first) = first else { return Ok(()) };
        let cutoff = first
            .checked_add(bounds.span)
            .ok_or(EngineError::TimeOverflow)?
            .min(self.deadline);
        for date in dates {
            let shift = time::origin(reader, date)?
                .checked_sub(self.origin_unix)
                .ok_or(EngineError::TimeOverflow)?;
            let start = scheduled_start(reader, route, slots, position, ready, shift)?;
            for &slot in &slots[start..] {
                increment(&mut self.strategy.diagnostics.scheduled_trip_checks)?;
                let trip = &route.trips[slot as usize];
                let board = shift
                    .checked_add(dep_secs_at(reader, trip, position)?)
                    .ok_or(EngineError::TimeOverflow)?;
                if board > cutoff {
                    break;
                }
                if !trip_allowed(trip, self.query) {
                    continue;
                }
                visit_instances(
                    reader,
                    v2,
                    trip,
                    position,
                    date..date + 1,
                    self.origin_unix,
                    ready,
                    cutoff,
                    true,
                    |candidate| -> Result<(), super::round::RoundProfileError> {
                        self.strategy.before_board()?;
                        if candidate.inst != state.inst
                            && self.strategy.observe_board(
                                state,
                                &Boarding {
                                    kind: movement.kind(),
                                    instance: candidate,
                                    route: ri,
                                    position: position as u32,
                                    walk: walk - state.walk,
                                    elapsed: ready - state.time,
                                },
                            )?
                        {
                            self.ride(
                                Some(state),
                                candidate,
                                ri,
                                slot,
                                position as u32,
                                false,
                                walk,
                            )?;
                        }
                        Ok(())
                    },
                )?;
            }
        }
        Ok(())
    }
}

fn scheduled_start<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    route: &crate::engine::index::IndexRoute,
    slots: &[u32],
    position: usize,
    ready: i64,
    shift: i64,
) -> Result<usize, EngineError> {
    let need = ready.checked_sub(shift).ok_or(EngineError::TimeOverflow)?;
    let (mut lo, mut hi) = (0, slots.len());
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if dep_secs_at(reader, &route.trips[slots[mid] as usize], position)? < need {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    Ok(lo)
}

pub(super) fn run_round<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    request: super::round::RoundProfileRequest<'_>,
    control: super::round::Control<'_>,
) -> Result<super::round::RoundProfileResult, super::round::RoundProfileError> {
    use super::round::{RoundProfileError, RoundProfileResult};
    use alloc::collections::BTreeMap;
    let events = entry_events(
        reader,
        index,
        request.query,
        request.window.clone(),
        request.max_entry_events,
    )
    .map_err(|e| match e {
        EntryEventEnumerationError::Engine(e) => RoundProfileError::Engine(e),
        EntryEventEnumerationError::LimitExceeded {
            max_events,
            attempted_events,
        } => RoundProfileError::EntryEventsExhausted {
            limit: max_events,
            attempted: attempted_events,
        },
    })?;
    let v2 = index.v2.as_deref().ok_or(EngineError::UnsupportedVersion)?;
    let frame = time::query_frame(
        reader,
        request.query.date,
        request.window.start,
        v2.max_event_secs,
    )?;
    let objective = control.objective();
    let mut diagnostics = R3Diagnostics {
        enumerated_entry_events: events.len(),
        ..R3Diagnostics::default()
    };
    let mut search = Search {
        reader,
        index,
        v2,
        query: request.query,
        transfers: request.transfers,
        event: EntryEvent {
            service_date: request.query.date,
            route_idx: 0,
            trip_idx: 0,
            board_position: 0,
            origin_ready_secs: request.window.start,
            effective_board_secs: request.window.start,
            frequency_offset_secs: 0,
        },
        deadline: frame.timeline(frame.deadline_unix)?,
        origin_unix: frame.origin_unix,
        states: Vec::new(),
        pending: Vec::new(),
        points: Vec::new(),
        strategy: control,
        objectives: objective,
        diagnostics: &mut diagnostics,
    };
    let mut cursor = events.len();
    while cursor > 0 {
        let departure = events[cursor - 1].origin_ready_secs;
        let mut start = cursor - 1;
        while start > 0 && events[start - 1].origin_ready_secs == departure {
            start -= 1;
        }
        for &event in &events[start..cursor] {
            search.seed(event)?;
            increment(&mut search.diagnostics.entry_events)?;
        }
        increment(&mut search.diagnostics.timestamp_buckets)?;
        while !search.pending.is_empty() {
            let current = core::mem::take(&mut search.pending);
            increment(&mut search.strategy.diagnostics.rounds)?;
            // Each pattern has one drain per round/bucket, with every changed
            // incoming state and movement source kept for exact candidate scans.
            let mut marked: BTreeMap<u32, Vec<BoardSource>> = BTreeMap::new();
            let mut continuations = Vec::new();
            for id in current {
                if !search.strategy.active(id) {
                    continue;
                }
                let state = search.states[id];
                increment(&mut search.diagnostics.propagated_labels)?;
                if state.continuation_only {
                    if state.rounds < request.query.max_rounds.unwrap_or(RAPTOR_MAX_ROUNDS) {
                        continuations.push(id);
                    }
                    continue;
                }
                for movement in search.prepare(&state)? {
                    let mut previous_pattern = None;
                    for occurrence in search.strategy.index.occurrences(movement.stop) {
                        if !search.strategy.index.may_board(occurrence) {
                            continue;
                        }
                        if previous_pattern == Some(occurrence.pattern) {
                            continue;
                        }
                        search.strategy.mark_source()?;
                        marked
                            .entry(occurrence.pattern)
                            .or_default()
                            .push(BoardSource {
                                state: id,
                                movement,
                            });
                        previous_pattern = Some(occurrence.pattern);
                    }
                }
            }
            for (pattern, sources) in marked {
                increment(&mut search.strategy.diagnostics.pattern_scans)?;
                let acceleration = search.strategy.index;
                let bounds = request
                    .enable_scheduled_bounds
                    .then(|| acceleration.scheduled(pattern))
                    .flatten();
                if bounds.is_some() {
                    increment(&mut search.strategy.diagnostics.bounded_pattern_scans)?;
                } else {
                    increment(&mut search.strategy.diagnostics.exact_fallback_scans)?;
                }
                if request.enable_source_frontiers && acceleration.shared_boarding_cost(pattern) {
                    for (position, source) in
                        search.source_frontiers(pattern, &sources, request.max_bag_width)?
                    {
                        let state = search.states[source.state];
                        if let Some(bounds) = bounds {
                            increment(&mut search.strategy.diagnostics.bounded_board_sources)?;
                            search.board_bounded(
                                &state,
                                source.movement,
                                pattern,
                                position,
                                bounds,
                            )?;
                        } else {
                            let Movement {
                                stop,
                                walk,
                                synthetic,
                            } = source.movement;
                            search.board_at(&state, stop, walk, synthetic, pattern, position)?;
                        }
                    }
                    continue;
                }
                for source in sources {
                    let id = source.state;
                    let Movement {
                        stop,
                        walk,
                        synthetic,
                    } = source.movement;
                    if !search.strategy.active(id) {
                        continue;
                    }
                    let state = search.states[id];
                    let acceleration = search.strategy.index;
                    for occurrence in acceleration.occurrences(stop) {
                        if occurrence.pattern == pattern {
                            if !acceleration.may_board(occurrence) {
                                continue;
                            }
                            if let Some(bounds) = bounds {
                                increment(&mut search.strategy.diagnostics.bounded_board_sources)?;
                                search.board_bounded(
                                    &state,
                                    source.movement,
                                    pattern,
                                    occurrence.position as usize,
                                    bounds,
                                )?;
                            } else {
                                search.board_at(
                                    &state,
                                    stop,
                                    walk,
                                    synthetic,
                                    pattern,
                                    occurrence.position as usize,
                                )?;
                            }
                        }
                    }
                }
            }
            for id in continuations {
                if !search.strategy.active(id) {
                    continue;
                }
                increment(&mut search.strategy.diagnostics.continuation_candidates)?;
                let state = search.states[id];
                search.linked(&state)?;
            }
        }
        cursor = start;
    }
    let mut points = core::mem::take(&mut search.points);
    points.sort_by(|a, b| {
        b.origin_departure_secs
            .cmp(&a.origin_departure_secs)
            .then(a.destination_arrival_secs.cmp(&b.destination_arrival_secs))
            .then(a.actual_transfers.cmp(&b.actual_transfers))
            .then(a.total_walk_secs.cmp(&b.total_walk_secs))
            .then(a.witness.cmp(&b.witness))
    });
    search.strategy.diagnostics.arena_bytes = search
        .states
        .len()
        .checked_mul(core::mem::size_of::<State>())
        .ok_or(EngineError::TimeOverflow)?;
    let round_diagnostics = search.strategy.diagnostics;
    let page_diagnostics = *search.diagnostics;
    Ok(RoundProfileResult {
        diagnostics: round_diagnostics,
        page: R3ProfilePage {
            points,
            objectives: objective,
            requested_page_size: usize::MAX,
            completion: R3PageCompletion::WindowExhausted,
            supported_service_date: request.query.date,
            ptft_status: if request.transfers.is_some() {
                R3PtftStatus::Applied
            } else {
                R3PtftStatus::NotSupplied
            },
            multi_date_status: R3MultiDateStatus::ServiceDayOrigins,
            requested_window: request.window.clone(),
            coverage_scope: R3CoverageScope::SuppliedWindowOnly,
            covered_window: request.window.clone(),
            covered_frontier_secs: request.window.start,
            latest_departure_certificate: R3LatestDepartureCertificate {
                covered_from_secs: request.window.start,
                covered_until_exclusive_secs: request.window.end,
                next_unprocessed_origin_ready_secs: None,
                equal_time_boundary_closed: true,
            },
            page_complete: true,
            window_exhausted: true,
            day_exhausted: false,
            diagnostics: page_diagnostics,
            page_diagnostics,
        },
    })
}

/// Bounded heuristic driving shared legal forward primitives. No completeness
/// or canonical-witness certificate: the caller owns cutoffs and final checks.
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
pub(super) fn run_candidate_shot<B: AsRef<[u8]> + Send + Sync + 'static, S: Strategy>(
    reader: &Reader<B>,
    index: &Index,
    query: &Query,
    transfers: Option<&Transfers>,
    roots: &[EntryEvent],
    origin_unix: i64,
    objective: ProfileObjectives,
    arrival_deadline: i64,
    strategy: S,
) -> (Vec<R3Point>, S, Result<(), S::Error>, usize) {
    use alloc::collections::BinaryHeap;
    use core::cmp::Reverse;
    let mut diagnostics = R3Diagnostics::default();
    let mut search = Search {
        reader,
        index,
        v2: index.v2.as_deref().expect("validated v2 catalogue"),
        query,
        transfers,
        event: roots[0],
        deadline: roots[0].effective_board_secs,
        origin_unix,
        states: Vec::new(),
        pending: Vec::new(),
        points: Vec::new(),
        strategy,
        objectives: objective,
        diagnostics: &mut diagnostics,
    };
    let mut queue = BinaryHeap::new();
    let mut peak_queue = 0;
    let outcome = (|| {
        for &root in roots {
            search.seed(root)?;
        }
        loop {
            for id in core::mem::take(&mut search.pending) {
                search.strategy.before_stop()?;
                let state = search.states[id];
                queue.push(Reverse((state.time, state.transfers, state.walk, id)));
            }
            peak_queue = peak_queue.max(queue.len());
            let Some(Reverse((_, _, _, id))) = queue.pop() else {
                break;
            };
            search.strategy.before_stop()?;
            if !search.strategy.active(id) {
                continue;
            }
            let state = search.states[id];
            let movements = search.prepare(&state)?;
            if search
                .points
                .iter()
                .any(|p| p.destination_arrival_secs <= arrival_deadline)
            {
                break; // A legal incumbent, never a final query answer.
            }
            for movement in movements {
                search.board(&state, movement.stop, movement.walk, movement.synthetic)?;
            }
        }
        Ok(())
    })();
    let bytes = core::mem::size_of_val(search.states.as_slice())
        + peak_queue * core::mem::size_of::<Reverse<(i64, u32, u64, usize)>>();
    (search.points, search.strategy, outcome, bytes)
}

/// Expand one concrete arrival's boardings through the reference primitives
/// (`prepare`, `board`, `linked`) without changing their rules. `deadline` is
/// the inclusive latest boarding; the strategy decides whether rides expand.
#[allow(clippy::too_many_arguments)]
pub(super) fn visit_boardings<B: AsRef<[u8]> + Send + Sync + 'static, S: Strategy>(
    reader: &Reader<B>,
    index: &Index,
    query: &Query,
    transfers: Option<&Transfers>,
    origin_unix: i64,
    deadline: i64,
    mut arrival: State,
    strategy: S,
) -> Result<S, S::Error> {
    arrival.id = 0;
    arrival.parent = None;
    arrival.origin_departure = deadline
        .checked_sub(time::ROUTING_HORIZON_SECS)
        .ok_or(EngineError::TimeOverflow)?;
    let mut diagnostics = R3Diagnostics::default();
    let mut search = Search {
        reader,
        index,
        v2: index.v2.as_deref().ok_or(EngineError::UnsupportedVersion)?,
        query,
        transfers,
        event: EntryEvent {
            service_date: query.date,
            route_idx: 0,
            trip_idx: arrival.inst.trip,
            board_position: 0,
            origin_ready_secs: arrival.origin_departure,
            effective_board_secs: arrival.origin_departure,
            frequency_offset_secs: 0,
        },
        deadline,
        origin_unix,
        states: alloc::vec![arrival],
        pending: Vec::new(),
        points: Vec::new(),
        strategy,
        objectives: ProfileObjectives::M4,
        diagnostics: &mut diagnostics,
    };
    for movement in search.prepare(&arrival)? {
        search.board(&arrival, movement.stop, movement.walk, movement.synthetic)?;
    }
    if arrival.rounds < query.max_rounds.unwrap_or(RAPTOR_MAX_ROUNDS) {
        search.linked(&arrival)?;
    }
    Ok(search.strategy)
}

/// Shared ordinary synthetic movement enumeration. Omitting source identity
/// produces a candidate superset only; exact boarding still uses the resolver.
/// GTFS station rules: https://gtfs.org/documentation/schedule/reference/#transferstxt
pub(super) fn synthetic_destinations(
    rules: &RuleIndex,
    stop: u32,
    source: Option<(u32, u32)>,
) -> Vec<u32> {
    let mut out = Vec::new();
    for key in [Some(stop), rules.parent_of(stop)].into_iter().flatten() {
        if let Some(rows) = rules.synthetic_from.get(&key) {
            for &row in rows {
                let rule = &rules.ordinary[row as usize];
                if source
                    .is_none_or(|(trip, route)| RuleIndex::from_side_matches(rule, trip, route))
                {
                    if let Some(children) = rules.children.get(&rule.to_stop) {
                        out.extend_from_slice(children);
                    } else {
                        out.push(rule.to_stop);
                    }
                }
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// One directed physical PTFT movement, deduplicated by shortest duration.
/// Shared by the reference and reverse experiments; never chains walks.
pub(super) fn physical_walks<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    query: &Query,
    transfers: Option<&Transfers>,
    stop: u32,
) -> Result<Vec<(u32, i64)>, EngineError> {
    physical_walks_metered(reader, query, transfers, stop, || Ok(()))
}

pub(super) fn physical_walks_metered<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    query: &Query,
    transfers: Option<&Transfers>,
    stop: u32,
    mut before_edge: impl FnMut() -> Result<(), EngineError>,
) -> Result<Vec<(u32, i64)>, EngineError> {
    let mut out = Vec::new();
    if let Some(table) = transfers {
        if let Some(i) = table.index_of(reader.stop_id(stop as usize)?) {
            let (neighbors, walks) = table.edges(i);
            for (&n, &w) in neighbors.iter().zip(walks) {
                before_edge()?;
                if let Some(to) = reader.stop_index(table.stop_id(n)) {
                    if to != stop {
                        out.push((to, rescale_walk_secs(w, query.transfer_walk_speed_mm_s())));
                    }
                }
            }
        }
    }
    out.sort_unstable();
    out.dedup_by_key(|e| e.0);
    Ok(out)
}

fn add_walk(total: u64, walk: i64) -> Result<u64, EngineError> {
    let walk = u64::try_from(walk).map_err(|_| EngineError::TimeOverflow)?;
    total.checked_add(walk).ok_or(EngineError::TimeOverflow)
}

fn equal_objectives(a: &R3Point, b: &R3Point, objective: ProfileObjectives) -> bool {
    a.origin_departure_secs == b.origin_departure_secs
        && a.destination_arrival_secs == b.destination_arrival_secs
        && a.actual_transfers == b.actual_transfers
        && (objective == ProfileObjectives::R3 || a.total_walk_secs == b.total_walk_secs)
}

fn dominates(a: &R3Point, b: &R3Point, objective: ProfileObjectives) -> bool {
    a.origin_departure_secs >= b.origin_departure_secs
        && a.destination_arrival_secs <= b.destination_arrival_secs
        && a.actual_transfers <= b.actual_transfers
        && (objective == ProfileObjectives::R3 || a.total_walk_secs <= b.total_walk_secs)
}

pub(super) fn insert_point(
    profile: &mut Vec<R3Point>,
    candidate: R3Point,
    objective: ProfileObjectives,
) {
    if let Some(existing) = profile
        .iter_mut()
        .find(|p| equal_objectives(p, &candidate, objective))
    {
        if (candidate.total_walk_secs, &candidate.witness)
            < (existing.total_walk_secs, &existing.witness)
        {
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
