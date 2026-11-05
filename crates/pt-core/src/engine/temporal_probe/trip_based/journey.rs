//! Complete movement for selected winners, not another route search. Concrete
//! connections use the reference boarding resolver, never schedule-gap guesses.
//! GTFS: https://gtfs.org/documentation/schedule/reference/#transferstxt
//! https://gtfs.org/documentation/schedule/reference/#frequenciestxt
//! https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes

use super::journey_meter::{Exhaustion, PlanMeter, Work};
use super::*;
use crate::engine::temporal_probe::{
    r3::R3Point,
    v2::{physical_walks_metered, BoardingTarget},
};
use crate::engine::v2::instances::ConcreteInstance;
use crate::engine::StopWalk;
use alloc::collections::BTreeMap;
use core::mem::size_of_val;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeadlineJourneyRide {
    pub witness: R3TransitWitness,
    pub from_stop: u32,
    pub to_stop: u32,
    pub route_type: u16,
    /// Pattern positions remain meaningful for loops and covering patterns.
    pub pattern_stop_ids: Vec<u32>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DeadlineJourneyConnection {
    pub from_stop: u32,
    pub to_stop: u32,
    /// Start walking (or remain aboard) at the preceding ride's arrival.
    pub arrival_secs: i64,
    pub boarding_secs: i64,
    pub walk_secs: u64,
    /// Required arrival-to-departure time, not an extra walking duration.
    pub elapsed_secs: i64,
    pub kind: TransferKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DeadlineJourneyEgress {
    pub from_stop: u32,
    pub exit_stop: u32,
    pub physical_walk_secs: u64,
    pub caller_walk_secs: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeadlineJourney {
    /// Unmodified canonical winner, including the query timeline's date.
    pub point: R3Point,
    pub access: StopWalk,
    pub rides: Vec<DeadlineJourneyRide>,
    pub connections: Vec<DeadlineJourneyConnection>,
    pub egress: DeadlineJourneyEgress,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DeadlineJourneyDiagnostics {
    pub stop_work: usize,
    pub lookup_work: usize,
    pub aggregate_stop_work: usize,
    pub aggregate_lookup_work: usize,
    pub unique_journeys: usize,
    /// Logical retained payload, not allocator capacity/peak/RSS.
    pub output_bytes: usize,
}

#[derive(Debug)]
pub struct DeadlinePortfolioJourneyResult {
    pub search: DeadlinePortfolioResult,
    pub journeys: Vec<DeadlineJourney>,
    /// Fixed DeadlinePreference::ALL order; duplicate winners share an index.
    pub by_preference: [Option<usize>; 4],
    pub projection: DeadlineJourneyDiagnostics,
}

#[derive(Debug)]
pub struct DeadlinePreferenceJourneyResult {
    pub search: DeadlinePreferenceResult,
    pub journey: Option<DeadlineJourney>,
    pub projection: DeadlineJourneyDiagnostics,
}

fn corrupt(message: &'static str) -> EngineError {
    EngineError::Corrupt(message)
}

struct Connection<'a> {
    target: BoardingTarget,
    in_seat: bool,
    best: Option<Boarding>,
    meter: &'a PlanMeter,
}
impl Strategy for Connection<'_> {
    type Error = EngineError;
    fn before_board(&mut self) -> Result<(), Self::Error> {
        self.meter.lookup()
    }
    fn before_trip(&mut self) -> Result<(), Self::Error> {
        self.meter.lookup()
    }
    fn before_stop(&mut self) -> Result<(), Self::Error> {
        self.meter.stop()
    }
    fn before_physical_edge(&mut self) -> Result<(), EngineError> {
        self.meter.stop()
    }
    fn accept(&mut self, _: &State, _: &[State], _: usize) -> Result<bool, Self::Error> {
        Ok(false)
    }
    fn boarding_target(&self) -> Option<BoardingTarget> {
        Some(self.target)
    }
    fn observe_board(&mut self, _: &State, b: &Boarding) -> Result<bool, Self::Error> {
        if b.route == self.target.route
            && b.position == self.target.position
            && b.instance.inst == self.target.instance.inst
            && b.instance.board_secs == self.target.instance.board_secs
            && b.instance.approximate == self.target.instance.approximate
            && b.kind.spends_transfer() != self.in_seat
            && self
                .best
                .is_none_or(|old| (b.walk, b.elapsed, b.kind) < (old.walk, old.elapsed, old.kind))
        {
            self.best = Some(*b);
        }
        // Observe only: never ride or enqueue an expanded routing state. The
        // shared visitor has one scratch copy of the known arrival state.
        Ok(false)
    }
}

struct Projector<'a> {
    reader: &'a Reader<Vec<u8>>,
    index: &'a Index,
    catalogue: &'a EventIndex,
    query: &'a Query,
    transfers: Option<&'a Transfers>,
    origin_unix: i64,
    meter: &'a PlanMeter,
}
impl Projector<'_> {
    fn event(&self, w: &R3TransitWitness, position: u32) -> Result<StopEvent, EngineError> {
        let date = time::date_ordinal(self.reader, w.service_date)
            .ok_or(EngineError::UnsupportedServiceDate)? as u32;
        let key = (w.trip_idx, date, w.frequency_offset_secs, position);
        let events = self.catalogue.events();
        let (mut lo, mut hi) = (0, events.len());
        while lo < hi {
            self.meter.lookup()?;
            let mid = lo + (hi - lo) / 2;
            if events[mid].key() < key {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        self.meter.lookup()?;
        let e = events
            .get(lo)
            .copied()
            .filter(|e| e.key() == key)
            .ok_or(corrupt("journey occurrence absent from owned catalogue"))?;
        let route = self
            .index
            .routes
            .get(e.route_idx as usize)
            .ok_or(corrupt("journey pattern missing"))?;
        if e.route_idx != w.route_idx
            || route.reader_route_idx != w.reader_route_idx
            || e.approximate() != w.frequency_instance
        {
            return Err(corrupt("journey occurrence identity mismatch"));
        }
        Ok(e)
    }

    fn project(&self, point: &R3Point) -> Result<DeadlineJourney, EngineError> {
        if point.service_date != self.query.date
            || point.witness.is_empty()
            || point.witness.len() != point.transit_rounds as usize
        {
            return Err(corrupt("journey point shape"));
        }
        let mut rides: Vec<DeadlineJourneyRide> = Vec::new();
        let mut ends = Vec::new();
        let mut targets = Vec::new();
        for (i, w) in point.witness.iter().enumerate() {
            self.meter.stop()?;
            let board = self.event(w, w.board_position)?;
            let alight = self.event(w, w.alight_position)?;
            if w.board_position >= w.alight_position
                || board.departure_secs != w.board_secs
                || alight.arrival_secs != w.alight_secs
                || !alight.is_source()
                || (i == 0 && (!board.can_board() || w.in_seat))
            {
                return Err(corrupt("journey ride mismatch"));
            }
            let route = &self.index.routes[w.route_idx as usize];
            for _ in &route.stop_ids {
                self.meter.stop()?;
            }
            rides.push(DeadlineJourneyRide {
                witness: *w,
                from_stop: route.stop_ids[w.board_position as usize],
                to_stop: route.stop_ids[w.alight_position as usize],
                route_type: route.route_type,
                pattern_stop_ids: route.stop_ids.clone(),
            });
            ends.push(alight);
            targets.push(BoardingTarget {
                route: board.route_idx,
                position: board.position,
                instance: ConcreteInstance {
                    inst: Inst {
                        trip: board.trip_idx,
                        date: board.date_ordinal,
                        shift: board.frequency_offset_secs,
                    },
                    board_secs: board.departure_secs,
                    approximate: board.approximate(),
                },
            });
        }
        let first = &rides[0];
        let access_secs = u32::try_from(
            first
                .witness
                .board_secs
                .checked_sub(point.origin_departure_secs)
                .ok_or(EngineError::TimeOverflow)?,
        )
        .map_err(|_| EngineError::TimeOverflow)?;
        let mut access = None;
        for e in &self.query.entry_stops {
            self.meter.stop()?;
            if e.stop == first.from_stop && e.walk_secs == access_secs {
                access = Some(*e);
            }
        }
        let access = access.ok_or(corrupt("journey access not in prepared query"))?;
        let mut walking = u64::from(access_secs);
        let mut transfers = 0u32;
        let mut connections = Vec::new();
        // Exits affect only destination recording in visit_boardings; clearing
        // them suppresses unused destination points, never boarding eligibility.
        let mut boarding_query = self.query.clone();
        boarding_query.exit_stops.clear();
        for i in 1..rides.len() {
            let a = ends[i - 1];
            let previous = &rides[i - 1];
            let next = &rides[i];
            let arrival = State {
                inst: Inst {
                    trip: a.trip_idx,
                    date: a.date_ordinal,
                    shift: a.frequency_offset_secs,
                },
                stop: previous.to_stop,
                position: a.position,
                time: a.arrival_secs,
                transfers,
                rounds: i as u32,
                walk: walking,
                can_alight: a.can_alight(),
                id: 0,
                parent: None,
                leg: previous.witness,
                origin_departure: point.origin_departure_secs,
                continuation_only: false,
            };
            let b = visit_boardings(
                self.reader,
                self.index,
                &boarding_query,
                self.transfers,
                self.origin_unix,
                next.witness.board_secs,
                arrival,
                Connection {
                    target: targets[i],
                    in_seat: next.witness.in_seat,
                    best: None,
                    meter: self.meter,
                },
            )?
            .best
            .ok_or(corrupt("journey connection not admitted by reference"))?;
            if b.elapsed < 0
                || b.walk > b.elapsed as u64
                || a.arrival_secs
                    .checked_add(b.elapsed)
                    .ok_or(EngineError::TimeOverflow)?
                    > next.witness.board_secs
            {
                return Err(corrupt("journey elapsed/walking mismatch"));
            }
            walking = walking
                .checked_add(b.walk)
                .ok_or(EngineError::TimeOverflow)?;
            transfers += u32::from(b.kind.spends_transfer());
            connections.push(DeadlineJourneyConnection {
                from_stop: previous.to_stop,
                to_stop: next.from_stop,
                arrival_secs: previous.witness.alight_secs,
                boarding_secs: next.witness.board_secs,
                walk_secs: b.walk,
                elapsed_secs: b.elapsed,
                kind: b.kind,
            });
        }
        let last = rides.last().expect("nonempty rides");
        if !ends.last().expect("nonempty ends").can_alight() {
            return Err(corrupt("journey final drop-off forbidden"));
        }
        let mut exits: BTreeMap<u32, u32> = BTreeMap::new();
        for exit in &self.query.exit_stops {
            self.meter.stop()?;
            if !inaccessible(self.reader, self.query, exit.stop)? {
                exits
                    .entry(exit.stop)
                    .and_modify(|w| *w = (*w).min(exit.walk_secs))
                    .or_insert(exit.walk_secs);
            }
        }
        let mut movements = physical_walks_metered(
            self.reader,
            self.query,
            self.transfers,
            last.to_stop,
            || self.meter.stop(),
        )?;
        movements.push((last.to_stop, 0));
        let mut egress = None;
        let horizon = point
            .origin_departure_secs
            .checked_add(time::ROUTING_HORIZON_SECS)
            .ok_or(EngineError::TimeOverflow)?;
        for (stop, physical) in movements {
            self.meter.stop()?;
            let Some(&caller) = exits.get(&stop) else {
                continue;
            };
            let at = last
                .witness
                .alight_secs
                .checked_add(physical)
                .ok_or(EngineError::TimeOverflow)?;
            if at <= horizon
                && at
                    .checked_add(i64::from(caller))
                    .ok_or(EngineError::TimeOverflow)?
                    == point.destination_arrival_secs
            {
                let physical_walk_secs =
                    u64::try_from(physical).map_err(|_| EngineError::TimeOverflow)?;
                let key = (stop, physical_walk_secs, caller);
                if egress.is_none_or(|old: DeadlineJourneyEgress| {
                    key < (old.exit_stop, old.physical_walk_secs, old.caller_walk_secs)
                }) {
                    egress = Some(DeadlineJourneyEgress {
                        from_stop: last.to_stop,
                        exit_stop: stop,
                        physical_walk_secs,
                        caller_walk_secs: caller,
                    });
                }
            }
        }
        let egress = egress.ok_or(corrupt("journey egress not in prepared query"))?;
        walking = walking
            .checked_add(egress.physical_walk_secs)
            .and_then(|w| w.checked_add(u64::from(egress.caller_walk_secs)))
            .ok_or(EngineError::TimeOverflow)?;
        if walking != point.total_walk_secs || transfers != point.actual_transfers {
            return Err(corrupt("journey metrics differ from canonical point"));
        }
        Ok(DeadlineJourney {
            point: point.clone(),
            access,
            rides,
            connections,
            egress,
        })
    }
}

type ProjectedJourneys = (
    Vec<DeadlineJourney>,
    [Option<usize>; 4],
    DeadlineJourneyDiagnostics,
);

#[allow(clippy::too_many_arguments)]
pub(super) fn project(
    reader: &Reader<Vec<u8>>,
    index: &Index,
    catalogue: &EventIndex,
    query: &Query,
    transfers: Option<&Transfers>,
    config: &DeadlineSessionConfig,
    search: &DeadlineDiagnostics,
    points: [Option<&R3Point>; 4],
) -> Result<ProjectedJourneys, DeadlineError> {
    let consumed_stop = search
        .seed_event_checks
        .checked_add(search.stop_events_scanned)
        .and_then(|n| n.checked_add(search.prefix.work()))
        .and_then(|n| n.checked_add(search.optimistic.work()))
        .and_then(|n| n.checked_add(search.forward.stop_work()))
        .ok_or(EngineError::TimeOverflow)?;
    let consumed_lookup = search.lazy.work;
    let limits = Work {
        stop: config.max_stop_scans,
        lookup: config.max_lookup_work,
        states: config.max_segments,
    };
    let meter = PlanMeter::new(
        limits,
        Work {
            stop: consumed_stop,
            lookup: consumed_lookup,
            states: search.segments_enqueued,
        },
        limits,
    );
    let ordinal =
        time::date_ordinal(reader, query.date).ok_or(EngineError::UnsupportedServiceDate)?;
    let projector = Projector {
        reader,
        index,
        catalogue,
        query,
        transfers,
        origin_unix: time::origin(reader, ordinal)?,
        meter: &meter,
    };
    let mut journeys: Vec<DeadlineJourney> = Vec::new();
    let mut by_preference = [None; 4];
    for (slot, point) in points.into_iter().enumerate() {
        let Some(point) = point else {
            continue;
        };
        if let Some(at) = journeys.iter().position(|j| j.point == *point) {
            by_preference[slot] = Some(at);
            continue;
        }
        let journey = projector
            .project(point)
            .map_err(|e| match meter.exhaustion() {
                Some(Exhaustion::Stop { limit, attempted }) => {
                    DeadlineError::StopScansExhausted { limit, attempted }
                }
                Some(Exhaustion::Lookup { limit, attempted }) => {
                    DeadlineError::Lookup(LazyLookupError::WorkExhausted { limit, attempted })
                }
                _ => DeadlineError::Engine(e),
            })?;
        by_preference[slot] = Some(journeys.len());
        journeys.push(journey);
    }
    let work = meter.work();
    debug_assert_eq!(work.states, 0);
    let output_bytes = journeys
        .iter()
        .map(|j| {
            size_of::<DeadlineJourney>()
                + size_of_val(j.point.witness.as_slice())
                + size_of_val(j.rides.as_slice())
                + j.rides
                    .iter()
                    .map(|r| size_of_val(r.pattern_stop_ids.as_slice()))
                    .sum::<usize>()
                + size_of_val(j.connections.as_slice())
        })
        .sum();
    let d = DeadlineJourneyDiagnostics {
        stop_work: work.stop,
        lookup_work: work.lookup,
        aggregate_stop_work: consumed_stop + work.stop,
        aggregate_lookup_work: consumed_lookup + work.lookup,
        unique_journeys: journeys.len(),
        output_bytes,
    };
    Ok((journeys, by_preference, d))
}
