//! Version-aware transfer-aware R3/M4 temporal prototype.
//!
//! Scope is explicit in [`R3Request`] and [`R3ProfilePage`]: same-stop
//! `transfers.txt` rules and one PTFT walking edge per transit round are
//! supported. V1 uses a single service date; v2 uses the foundation's complete
//! rule resolver and ServiceDayOrigins, including adjacent dates and exact
//! frequency instances. V2 is bounded and exhaustive pending a faster engine.
//! Stop-time positions remain occurrence identities, including loop repeats.
//!
//! GTFS references:
//! - stop times, pickup/drop-off, repeated stops, and times beyond 24:00:
//!   <https://gtfs.org/documentation/schedule/reference/#stop_timestxt>
//! - scoped transfer rules and transfer types:
//!   <https://gtfs.org/documentation/schedule/reference/#transferstxt>
//! - concrete `exact_times=0` frequency instances:
//!   <https://gtfs.org/documentation/schedule/reference/#frequenciestxt>

use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;
use core::cmp::Ordering;
use core::ops::Range;

use hashbrown::{HashMap, HashSet};
use rustc_hash::FxBuildHasher;

use super::events::{enumerate_entry_events_bounded, EntryEventEnumerationError};
use super::EntryEvent;
use crate::engine::consts::{rescale_walk_secs, RAPTOR_MAX_ROUNDS};
use crate::engine::index::{
    transfer_key_into, transfer_route_scoped_key_into, transfer_trip_scoped_key_into, IndexRoute,
    RouteTrip, TransferRuleApplied,
};
use crate::engine::mode::route_type_to_mode;
use crate::engine::scan::{
    alight_secs_at, dep_secs_at, drop_off_forbidden_at, pickup_forbidden_at,
};
use crate::engine::{EngineError, Index, Mobility, Query};
use crate::records::TRANSFER_ABSENT;
use crate::transfers::Transfers;
use crate::Reader;

const DEFAULT_MAX_LABELS: usize = 100_000;
const DEFAULT_MAX_ENTRY_EVENTS: usize = 100_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum R3CoverageScope {
    SuppliedWindowOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum R3PtftStatus {
    NotSupplied,
    Applied,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProfileObjectives {
    R3,
    M4,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum R3MultiDateStatus {
    UnsupportedSingleServiceDateOnly,
    /// Concrete dates resolved through PTB v2 ServiceDayOrigins.
    ServiceDayOrigins,
}

#[derive(Debug)]
pub enum R3Error {
    Engine(EngineError),
    ResourceExhausted {
        max_labels: usize,
        attempted_labels: usize,
    },
    EntryEventsExhausted {
        max_entry_events: usize,
        attempted_events: usize,
    },
    InvalidRequest(&'static str),
}

impl From<EngineError> for R3Error {
    fn from(error: EngineError) -> Self {
        Self::Engine(error)
    }
}

/// Typed input for one retained descending profile session.
pub struct R3Request<'a> {
    pub query: &'a Query,
    pub window: Range<i64>,
    /// Optional directed pedestrian-transfer table. At most one PTFT edge is
    /// relaxed after each transit arrival, matching the production RAPTOR
    /// round guard.
    pub transfers: Option<&'a Transfers>,
    /// Hard bound over accepted search states in the session. V2 counts work
    /// cumulatively even when an exhausted entry event's arena is released.
    pub max_labels: usize,
    /// Hard bound applied while legal entry events are materialized.
    pub max_entry_events: usize,
    #[cfg(test)]
    pub(crate) reverse_bucket_events_for_test: bool,
    #[cfg(test)]
    pub(crate) preserve_all_boarding_trips_for_test: bool,
}

impl<'a> R3Request<'a> {
    pub fn new(query: &'a Query, window: Range<i64>) -> Self {
        Self {
            query,
            window,
            transfers: None,
            max_labels: DEFAULT_MAX_LABELS,
            max_entry_events: DEFAULT_MAX_ENTRY_EVENTS,
            #[cfg(test)]
            reverse_bucket_events_for_test: false,
            #[cfg(test)]
            preserve_all_boarding_trips_for_test: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct R3Diagnostics {
    /// Entry events processed in this page, after timestamp-bucket closure.
    pub entry_events: usize,
    /// All entry events enumerated in the supplied window.
    pub enumerated_entry_events: usize,
    pub timestamp_buckets: usize,
    /// Search states accepted (v1 also counts one root per entry event).
    pub accepted_labels: usize,
    /// Retained frontier labels whose outgoing connections were expanded.
    pub propagated_labels: usize,
    /// Candidate labels rejected by an existing reusable frontier label.
    pub reused_labels: usize,
}

/// Certificate that every entry event in `covered_from_secs..covered_until` was
/// processed and that no equal-time event was left for the next page.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct R3LatestDepartureCertificate {
    pub covered_from_secs: i64,
    pub covered_until_exclusive_secs: i64,
    pub next_unprocessed_origin_ready_secs: Option<i64>,
    pub equal_time_boundary_closed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum R3PageCompletion {
    /// Requested surviving-result count was reached, then its complete
    /// equal-origin-departure bucket was closed.
    SurvivorTargetClosed,
    /// Supplied window ended before requested surviving-result count was met.
    WindowExhausted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct R3ProfilePage {
    pub points: Vec<R3Point>,
    pub objectives: ProfileObjectives,
    pub requested_page_size: usize,
    pub completion: R3PageCompletion,
    pub supported_service_date: u32,
    pub ptft_status: R3PtftStatus,
    pub multi_date_status: R3MultiDateStatus,
    pub requested_window: Range<i64>,
    /// This slice certifies only the caller-supplied interval. It never infers
    /// that an arbitrary interval exhausts every possible GTFS service time.
    pub coverage_scope: R3CoverageScope,
    /// Latest-departure interval fully covered by this page.
    pub covered_window: Range<i64>,
    /// Inclusive lower edge of the certified latest-departure interval.
    pub covered_frontier_secs: i64,
    pub latest_departure_certificate: R3LatestDepartureCertificate,
    /// Proven by `completion`: survivor target plus boundary closure, or window
    /// exhaustion with fewer survivors. Resource exhaustion returns an error.
    pub page_complete: bool,
    /// True only when every entry bucket in `requested_window` was processed.
    pub window_exhausted: bool,
    /// Always false in this slice: only the supplied window can be exhausted.
    pub day_exhausted: bool,
    /// Cumulative retained-session diagnostics.
    pub diagnostics: R3Diagnostics,
    /// Work performed only by this `next_page` call.
    pub page_diagnostics: R3Diagnostics,
}

/// One transit occurrence in the canonical witness for an R3 tuple.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct R3TransitWitness {
    pub service_date: u32,
    /// Pattern ordinal in [`Index::routes`](crate::engine::Index).
    pub route_idx: u32,
    /// Bare GTFS route ordinal used by scoped transfer rules.
    pub reader_route_idx: u32,
    pub trip_idx: u32,
    pub board_position: u32,
    pub alight_position: u32,
    pub board_secs: i64,
    pub alight_secs: i64,
    pub frequency_offset_secs: i64,
    /// True for approximate `exact_times=0` instances, even at zero offset.
    /// V2 exact_times=1 instances are scheduled (false) with a concrete shift.
    pub frequency_instance: bool,
    /// True for GTFS type-4 or date-gated derived block continuations.
    pub in_seat: bool,
}

/// One Pareto-optimal `(departure, arrival, actual transfers)` result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct R3Point {
    pub origin_departure_secs: i64,
    pub destination_arrival_secs: i64,
    pub actual_transfers: u32,
    /// Transit rounds consumed. Type-4 still increments this value.
    pub transit_rounds: u32,
    /// Access, transfer, and egress walking. Not an R3 membership criterion; it
    /// selects a deterministic witness only when all three R3 objectives are
    /// equal.
    pub total_walk_secs: u64,
    /// The date whose origin defines this point's seconds. Individual witness
    /// legs keep their own originating service dates.
    pub service_date: u32,
    pub witness: Vec<R3TransitWitness>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum ArrivalProvenance {
    Entry,
    Transit,
    Walk,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct ParentWitness {
    label_idx: usize,
    leg: R3TransitWitness,
}

/// Immutable candidate state. Unlike production `ScanState`, labels retain
/// provenance and predecessor identity instead of reducing each stop to one
/// scalar arrival.
#[derive(Clone, Debug)]
struct Label {
    stop: u32,
    arrival_secs: i64,
    origin_ready_secs: i64,
    origin_departure_secs: i64,
    transit_rounds: u32,
    actual_transfers: u32,
    parent: Option<ParentWitness>,
    service_date: u32,
    frequency_offset_secs: i64,
    frequency_instance: bool,
    arriving_route_idx: Option<u32>,
    arriving_reader_route_idx: Option<u32>,
    arriving_trip_idx: Option<u32>,
    provenance: ArrivalProvenance,
    in_seat: bool,
    stay_seated_only: bool,
    total_walk_secs: u64,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct LabelKey {
    stop: u32,
    transit_rounds: u32,
    service_date: u32,
    arriving_trip_idx: Option<u32>,
    arriving_reader_route_idx: Option<u32>,
    frequency_offset_secs: i64,
    frequency_instance: bool,
    provenance: ArrivalProvenance,
    in_seat: bool,
    stay_seated_only: bool,
}

impl LabelKey {
    fn from_label(label: &Label) -> Self {
        Self {
            stop: label.stop,
            transit_rounds: label.transit_rounds,
            service_date: label.service_date,
            arriving_trip_idx: label.arriving_trip_idx,
            arriving_reader_route_idx: label.arriving_reader_route_idx,
            frequency_offset_secs: label.frequency_offset_secs,
            frequency_instance: label.frequency_instance,
            provenance: label.provenance,
            in_seat: label.in_seat,
            stay_seated_only: label.stay_seated_only,
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct BoardCandidate {
    route_idx: u32,
    trip_idx_in_route: usize,
    board_position: usize,
    board_secs: i64,
    frequency_offset_secs: i64,
    frequency_instance: bool,
    in_seat: bool,
}

#[derive(Clone, Copy)]
struct ConcreteBoard {
    board_secs: i64,
    frequency_offset_secs: i64,
    frequency_instance: bool,
}

#[derive(Clone, Copy, Debug)]
struct ExitCandidate {
    origin_departure_secs: i64,
    destination_arrival_secs: i64,
    actual_transfers: u32,
    total_walk_secs: u64,
    label_idx: usize,
}

type FrontierMap = HashMap<LabelKey, Vec<usize>, FxBuildHasher>;

/// Exhaust the supplied window in one retained session.
///
/// Prefer [`R3Session`] when consuming bounded pages. This convenience requests
/// an effectively unbounded survivor page and therefore cannot masquerade as a
/// resumable page boundary.
pub fn profile_r3<B>(
    reader: &Reader<B>,
    index: &Index,
    request: R3Request<'_>,
) -> Result<R3ProfilePage, R3Error>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let mut session = R3Session::new(reader, index, request)?;
    session.next_page(usize::MAX)
}

/// Exhaust the supplied window with walking as a fourth Pareto objective.
pub fn profile_m4<B>(
    reader: &Reader<B>,
    index: &Index,
    request: R3Request<'_>,
) -> Result<R3ProfilePage, R3Error>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let mut session =
        R3Session::new_with_objectives(reader, index, request, ProfileObjectives::M4)?;
    session.next_page(usize::MAX)
}

type EmittedObjectives = (i64, i64, u32, Option<u64>);

/// Version-aware temporal prototype. V1 retains reusable legacy labels; v2
/// uses a bounded exhaustive search over the foundation's rules and dates.
pub struct R3Session<'a, B: AsRef<[u8]>> {
    backend: SessionBackend<'a, B>,
}

enum SessionBackend<'a, B: AsRef<[u8]>> {
    Legacy(LegacySession<'a, B>),
    V2(super::v2::Session<'a, B>),
}

impl<'a, B: AsRef<[u8]> + Send + Sync + 'static> R3Session<'a, B> {
    pub fn new(
        reader: &'a Reader<B>,
        index: &'a Index,
        request: R3Request<'a>,
    ) -> Result<Self, R3Error> {
        Self::new_with_objectives(reader, index, request, ProfileObjectives::R3)
    }

    pub fn new_with_objectives(
        reader: &'a Reader<B>,
        index: &'a Index,
        request: R3Request<'a>,
        objectives: ProfileObjectives,
    ) -> Result<Self, R3Error> {
        let backend = if reader.is_v2() {
            SessionBackend::V2(super::v2::Session::new(reader, index, request, objectives)?)
        } else {
            SessionBackend::Legacy(LegacySession::new_with_objectives(
                reader, index, request, objectives,
            )?)
        };
        Ok(Self { backend })
    }

    pub fn next_page(&mut self, page_size: usize) -> Result<R3ProfilePage, R3Error> {
        match &mut self.backend {
            SessionBackend::Legacy(session) => session.next_page(page_size),
            SessionBackend::V2(session) => session.next_page(page_size),
        }
    }
}

/// Stateful descending profile sweep. Event cursor, label arena, transfer-aware
/// frontiers, and emitted-result set survive every [`R3Session::next_page`]
/// call; prior timestamp buckets are never enumerated or propagated again.
struct LegacySession<'a, B: AsRef<[u8]>> {
    events: Vec<EntryEvent>,
    cursor: usize,
    requested_window: Range<i64>,
    emitted: Vec<EmittedObjectives>,
    search: Search<'a, B>,
    #[cfg(test)]
    reverse_bucket_events_for_test: bool,
}

impl<'a, B> LegacySession<'a, B>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    pub fn new(
        reader: &'a Reader<B>,
        index: &'a Index,
        request: R3Request<'a>,
    ) -> Result<Self, R3Error> {
        Self::new_with_objectives(reader, index, request, ProfileObjectives::R3)
    }

    /// Create a retained profile session using R3 or M4 Pareto objectives.
    pub fn new_with_objectives(
        reader: &'a Reader<B>,
        index: &'a Index,
        request: R3Request<'a>,
        objectives: ProfileObjectives,
    ) -> Result<Self, R3Error> {
        let events = match enumerate_entry_events_bounded(
            reader,
            index,
            request.query,
            request.window.clone(),
            request.max_entry_events,
        ) {
            Ok(events) => events,
            Err(EntryEventEnumerationError::Engine(error)) => return Err(error.into()),
            Err(EntryEventEnumerationError::LimitExceeded {
                max_events,
                attempted_events,
            }) => {
                return Err(R3Error::EntryEventsExhausted {
                    max_entry_events: max_events,
                    attempted_events,
                })
            }
        };
        let cursor = events.len();
        let enumerated_entry_events = events.len();
        let preserve_all_boarding_trips = index
            .transfer_rules_route
            .values()
            .any(|rule| rule.transfer_type == 4)
            || index
                .transfer_rules
                .values()
                .any(|rule| rule.transfer_type == 4);
        #[cfg(test)]
        let preserve_all_boarding_trips =
            preserve_all_boarding_trips || request.preserve_all_boarding_trips_for_test;
        Ok(Self {
            events,
            cursor,
            requested_window: request.window,
            emitted: Vec::new(),
            search: Search {
                reader,
                index,
                query: request.query,
                transfers: request.transfers,
                objectives,
                trip_scoped_source_trips: trip_scoped_source_trips(reader)?,
                preserve_all_boarding_trips,
                max_rounds: request.query.max_rounds.unwrap_or(RAPTOR_MAX_ROUNDS),
                max_labels: request.max_labels,
                labels: Vec::new(),
                frontiers: HashMap::with_hasher(FxBuildHasher),
                exits: Vec::new(),
                diagnostics: R3Diagnostics {
                    enumerated_entry_events,
                    ..R3Diagnostics::default()
                },
            },
            #[cfg(test)]
            reverse_bucket_events_for_test: request.reverse_bucket_events_for_test,
        })
    }

    /// Return at least `page_size` newly certified surviving results when
    /// available. Processing stops only after the full equal-origin-departure
    /// bucket that crosses the target, so ties can make a page larger.
    pub fn next_page(&mut self, page_size: usize) -> Result<R3ProfilePage, R3Error> {
        if page_size == 0 {
            return Err(R3Error::InvalidRequest(
                "temporal R3 page size must be positive",
            ));
        }
        let before = self.search.diagnostics;

        let completion = loop {
            if self.new_exit_count() >= page_size {
                break R3PageCompletion::SurvivorTargetClosed;
            }
            if self.cursor == 0 {
                break R3PageCompletion::WindowExhausted;
            }
            self.process_next_bucket()?;
        };

        let mut exit_indices: Vec<usize> = self
            .search
            .exits
            .iter()
            .enumerate()
            .filter_map(|(index, exit)| (!self.is_emitted(exit)).then_some(index))
            .collect();
        exit_indices.sort_by(|&left, &right| {
            exit_order(
                &self.search.labels,
                &self.search.exits[left],
                &self.search.exits[right],
            )
        });
        let points: Vec<R3Point> = exit_indices
            .iter()
            .map(|&index| self.search.point_from_exit(self.search.exits[index]))
            .collect();
        for index in exit_indices {
            let exit = self.search.exits[index];
            self.emitted
                .push(exit_objectives(&exit, self.search.objectives));
        }

        let window_exhausted = self.cursor == 0;
        let next_unprocessed_origin_ready_secs =
            (self.cursor > 0).then(|| self.events[self.cursor - 1].origin_ready_secs);
        let covered_frontier_secs = if window_exhausted {
            self.requested_window.start
        } else {
            self.events[self.cursor].origin_ready_secs
        };
        let diagnostics = self.search.diagnostics;
        let page_diagnostics = diagnostics_delta(diagnostics, before);
        let page_complete = match completion {
            R3PageCompletion::SurvivorTargetClosed => points.len() >= page_size,
            R3PageCompletion::WindowExhausted => window_exhausted,
        };

        Ok(R3ProfilePage {
            points,
            objectives: self.search.objectives,
            requested_page_size: page_size,
            completion,
            supported_service_date: self.search.query.date,
            ptft_status: if self.search.transfers.is_some() {
                R3PtftStatus::Applied
            } else {
                R3PtftStatus::NotSupplied
            },
            multi_date_status: R3MultiDateStatus::UnsupportedSingleServiceDateOnly,
            requested_window: self.requested_window.clone(),
            coverage_scope: R3CoverageScope::SuppliedWindowOnly,
            covered_window: covered_frontier_secs..self.requested_window.end,
            covered_frontier_secs,
            latest_departure_certificate: R3LatestDepartureCertificate {
                covered_from_secs: covered_frontier_secs,
                covered_until_exclusive_secs: self.requested_window.end,
                next_unprocessed_origin_ready_secs,
                equal_time_boundary_closed: true,
            },
            page_complete,
            window_exhausted,
            day_exhausted: false,
            diagnostics,
            page_diagnostics,
        })
    }

    fn process_next_bucket(&mut self) -> Result<(), R3Error> {
        let ready = self.events[self.cursor - 1].origin_ready_secs;
        let mut bucket_start = self.cursor - 1;
        while bucket_start > 0 && self.events[bucket_start - 1].origin_ready_secs == ready {
            bucket_start -= 1;
        }
        let bucket = self.events[bucket_start..self.cursor].to_vec();
        #[cfg(test)]
        let bucket = if self.reverse_bucket_events_for_test {
            bucket.into_iter().rev().collect()
        } else {
            bucket
        };
        let mut queue = Vec::new();
        for event in bucket {
            self.search.diagnostics.entry_events += 1;
            self.search.seed(event, &mut queue)?;
        }
        self.search.propagate(queue)?;
        self.search.diagnostics.timestamp_buckets += 1;
        self.cursor = bucket_start;
        Ok(())
    }

    fn new_exit_count(&self) -> usize {
        self.search
            .exits
            .iter()
            .filter(|exit| !self.is_emitted(exit))
            .count()
    }

    fn is_emitted(&self, exit: &ExitCandidate) -> bool {
        self.emitted
            .contains(&exit_objectives(exit, self.search.objectives))
    }
}

struct Search<'a, B: AsRef<[u8]>> {
    reader: &'a Reader<B>,
    index: &'a Index,
    query: &'a Query,
    transfers: Option<&'a Transfers>,
    objectives: ProfileObjectives,
    trip_scoped_source_trips: HashSet<u32, FxBuildHasher>,
    preserve_all_boarding_trips: bool,
    max_rounds: u32,
    max_labels: usize,
    labels: Vec<Label>,
    frontiers: FrontierMap,
    exits: Vec<ExitCandidate>,
    diagnostics: R3Diagnostics,
}

impl<B> Search<'_, B>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    fn seed(&mut self, event: EntryEvent, queue: &mut Vec<usize>) -> Result<(), R3Error> {
        if self.max_rounds == 0 {
            return Ok(());
        }
        let route = self
            .index
            .routes
            .get(event.route_idx as usize)
            .ok_or(EngineError::Corrupt("temporal R3 route index"))?;
        let trip_idx_in_route = route
            .trips
            .iter()
            .position(|trip| trip.trip_idx == event.trip_idx)
            .ok_or(EngineError::Corrupt("temporal R3 trip index"))?;
        let board_position = event.board_position as usize;
        let stop = *route
            .stop_ids
            .get(board_position)
            .ok_or(EngineError::Corrupt("temporal R3 board position"))?;
        let total_walk_secs = event
            .effective_board_secs
            .checked_sub(event.origin_ready_secs)
            .and_then(|walk| u64::try_from(walk).ok())
            .ok_or(EngineError::Corrupt("temporal R3 access walk"))?;
        let frequency_instance = has_exact_times_zero_frequency(self.reader, event.trip_idx);
        let root_idx = self.push_label(Label {
            stop,
            arrival_secs: event.effective_board_secs,
            origin_ready_secs: event.origin_ready_secs,
            origin_departure_secs: event.origin_ready_secs,
            transit_rounds: 0,
            actual_transfers: 0,
            parent: None,
            service_date: event.service_date,
            frequency_offset_secs: event.frequency_offset_secs,
            frequency_instance,
            arriving_route_idx: None,
            arriving_reader_route_idx: None,
            arriving_trip_idx: None,
            provenance: ArrivalProvenance::Entry,
            in_seat: false,
            stay_seated_only: false,
            total_walk_secs,
        })?;
        let board = BoardCandidate {
            route_idx: event.route_idx,
            trip_idx_in_route,
            board_position,
            board_secs: event.effective_board_secs,
            frequency_offset_secs: event.frequency_offset_secs,
            frequency_instance,
            in_seat: false,
        };
        self.accept_ride(root_idx, board, queue)
    }

    fn propagate(&mut self, queue: Vec<usize>) -> Result<(), R3Error> {
        let mut cursor = 0;
        let mut queue = queue;
        while cursor < queue.len() {
            let label_idx = queue[cursor];
            cursor += 1;
            if !self.is_retained(label_idx) {
                continue;
            }
            self.diagnostics.propagated_labels += 1;
            self.record_exits(label_idx)?;
            self.relax_walk(label_idx, &mut queue)?;
            if self.labels[label_idx].transit_rounds >= self.max_rounds {
                continue;
            }
            for board in self.board_candidates(label_idx)? {
                self.accept_ride(label_idx, board, &mut queue)?;
            }
        }
        Ok(())
    }

    fn relax_walk(&mut self, label_idx: usize, queue: &mut Vec<usize>) -> Result<(), R3Error> {
        let Some(transfers) = self.transfers else {
            return Ok(());
        };
        let source = &self.labels[label_idx];
        if source.provenance != ArrivalProvenance::Transit || source.stay_seated_only {
            return Ok(());
        }

        let source_id = self
            .reader
            .stop_id(source.stop as usize)
            .map_err(EngineError::from)?;
        let Some(transfer_idx) = transfers.index_of(source_id) else {
            return Ok(());
        };
        let (neighbors, walks) = transfers.edges(transfer_idx);
        let mut transfer_key = String::new();
        let mut candidates = Vec::with_capacity(walks.len());
        for (edge_idx, &raw_walk_secs) in walks.iter().enumerate() {
            let neighbor_id = transfers.stop_id(neighbors[edge_idx]);
            transfer_key_into(&mut transfer_key, source_id, neighbor_id);
            let floor = match self.index.transfer_rules.get(transfer_key.as_str()) {
                Some(rule) if rule.transfer_type == 3 => continue,
                Some(rule) if rule.transfer_type == 2 => rule.min_transfer_secs as i64,
                Some(rule) if rule.transfer_type == 1 => 0,
                _ => self.query.min_transfer_floor_secs(),
            };
            let scaled = rescale_walk_secs(raw_walk_secs, self.query.transfer_walk_speed_mm_s());
            let effective = scaled.max(floor);
            let Some(arrival_secs) = source.arrival_secs.checked_add(effective) else {
                continue;
            };
            let Ok(effective_u64) = u64::try_from(effective) else {
                continue;
            };
            let Some(total_walk_secs) = source.total_walk_secs.checked_add(effective_u64) else {
                continue;
            };
            let Some(stop) = self.reader.stop_index(neighbor_id) else {
                continue;
            };
            candidates.push(Label {
                stop,
                arrival_secs,
                origin_ready_secs: source.origin_ready_secs,
                origin_departure_secs: source.origin_departure_secs,
                transit_rounds: source.transit_rounds,
                actual_transfers: source.actual_transfers,
                parent: source.parent,
                service_date: source.service_date,
                frequency_offset_secs: 0,
                frequency_instance: false,
                arriving_route_idx: None,
                arriving_reader_route_idx: None,
                arriving_trip_idx: None,
                provenance: ArrivalProvenance::Walk,
                in_seat: false,
                stay_seated_only: false,
                total_walk_secs,
            });
        }

        for candidate in candidates {
            if let Some(walk_idx) = self.accept_frontier(candidate)? {
                queue.push(walk_idx);
            }
        }
        Ok(())
    }

    fn accept_ride(
        &mut self,
        parent_idx: usize,
        board: BoardCandidate,
        queue: &mut Vec<usize>,
    ) -> Result<(), R3Error> {
        for child in self.ride_labels(parent_idx, board)? {
            if let Some(label_idx) = self.accept_frontier(child)? {
                queue.push(label_idx);
            }
        }
        Ok(())
    }

    fn ride_labels(
        &self,
        parent_idx: usize,
        board: BoardCandidate,
    ) -> Result<Vec<Label>, EngineError> {
        let parent = &self.labels[parent_idx];
        let route = self
            .index
            .routes
            .get(board.route_idx as usize)
            .ok_or(EngineError::Corrupt("temporal R3 route index"))?;
        let trip = route
            .trips
            .get(board.trip_idx_in_route)
            .ok_or(EngineError::Corrupt("temporal R3 trip in route"))?;
        let transit_rounds = parent.transit_rounds + 1;
        let actual_transfers =
            parent.actual_transfers + u32::from(parent.transit_rounds > 0 && !board.in_seat);
        let mut children = Vec::new();

        for alight_position in (board.board_position + 1)..route.stop_ids.len() {
            if dep_secs_at(self.reader, trip, alight_position)? == -1 {
                continue;
            }
            let stop = route.stop_ids[alight_position];
            let stay_seated_only = drop_off_forbidden_at(self.reader, trip, alight_position)
                || (matches!(self.query.mobility, Mobility::Wheelchair)
                    && self.reader.stop_wheelchair_boarding(stop as usize)? == 2);
            let Some(arrival_secs) = alight_secs_at(self.reader, trip, alight_position)?
                .checked_add(board.frequency_offset_secs)
            else {
                continue;
            };
            if arrival_secs < board.board_secs {
                continue;
            }
            let leg = R3TransitWitness {
                service_date: parent.service_date,
                route_idx: route.route_idx,
                reader_route_idx: route.reader_route_idx,
                trip_idx: trip.trip_idx,
                board_position: board.board_position as u32,
                alight_position: alight_position as u32,
                board_secs: board.board_secs,
                alight_secs: arrival_secs,
                frequency_offset_secs: board.frequency_offset_secs,
                frequency_instance: board.frequency_instance,
                in_seat: board.in_seat,
            };
            children.push(Label {
                stop,
                arrival_secs,
                origin_ready_secs: parent.origin_ready_secs,
                origin_departure_secs: parent.origin_departure_secs,
                transit_rounds,
                actual_transfers,
                parent: Some(ParentWitness {
                    label_idx: parent_idx,
                    leg,
                }),
                service_date: parent.service_date,
                frequency_offset_secs: board.frequency_offset_secs,
                frequency_instance: board.frequency_instance,
                arriving_route_idx: Some(route.route_idx),
                arriving_reader_route_idx: Some(route.reader_route_idx),
                arriving_trip_idx: Some(trip.trip_idx),
                provenance: ArrivalProvenance::Transit,
                in_seat: board.in_seat,
                stay_seated_only,
                total_walk_secs: parent.total_walk_secs,
            });
        }
        Ok(children)
    }

    fn accept_frontier(&mut self, candidate: Label) -> Result<Option<usize>, R3Error> {
        let key = self.label_key(&candidate);
        let mut frontier = self.frontiers.get(&key).cloned().unwrap_or_default();

        if let Some(equal_idx) = frontier.iter().position(|&label_idx| {
            same_label_objectives(&self.labels[label_idx], &candidate, self.objectives)
        }) {
            let existing_idx = frontier[equal_idx];
            if !label_tie_preferred(&self.labels, &candidate, existing_idx) {
                self.diagnostics.reused_labels += 1;
                return Ok(None);
            }
            frontier.swap_remove(equal_idx);
        }
        if frontier
            .iter()
            .any(|&label_idx| label_dominates(&self.labels[label_idx], &candidate, self.objectives))
        {
            self.diagnostics.reused_labels += 1;
            return Ok(None);
        }
        frontier.retain(|&label_idx| {
            !label_dominates(&candidate, &self.labels[label_idx], self.objectives)
        });

        let label_idx = self.push_label(candidate)?;
        frontier.push(label_idx);
        self.frontiers.insert(key, frontier);
        Ok(Some(label_idx))
    }

    fn push_label(&mut self, label: Label) -> Result<usize, R3Error> {
        let attempted_labels = self.labels.len() + 1;
        if attempted_labels > self.max_labels {
            return Err(R3Error::ResourceExhausted {
                max_labels: self.max_labels,
                attempted_labels,
            });
        }
        let label_idx = self.labels.len();
        self.labels.push(label);
        self.diagnostics.accepted_labels += 1;
        Ok(label_idx)
    }

    fn is_retained(&self, label_idx: usize) -> bool {
        let key = self.label_key(&self.labels[label_idx]);
        self.frontiers
            .get(&key)
            .is_some_and(|frontier| frontier.contains(&label_idx))
    }

    fn label_key(&self, label: &Label) -> LabelKey {
        let mut key = LabelKey::from_label(label);
        if !self.preserve_all_boarding_trips
            && key
                .arriving_trip_idx
                .is_some_and(|trip| !self.trip_scoped_source_trips.contains(&trip))
        {
            // A trip absent from every actionable from_trip_id scope has no
            // trip-specific future behavior. Keep bare-route identity for
            // route-scoped rules, but let ordinary Pareto dominance merge its
            // otherwise equivalent arrival state.
            key.arriving_trip_idx = None;
        }
        key
    }

    fn board_candidates(&self, label_idx: usize) -> Result<Vec<BoardCandidate>, EngineError> {
        let label = &self.labels[label_idx];
        if matches!(self.query.mobility, Mobility::Wheelchair)
            && self.reader.stop_wheelchair_boarding(label.stop as usize)? == 2
        {
            return Ok(Vec::new());
        }
        let Some(route_indices) = self.index.routes_at_stop.get(&label.stop) else {
            return Ok(Vec::new());
        };
        let mut candidates = Vec::new();

        for &route_idx in route_indices {
            let route = self
                .index
                .routes
                .get(route_idx as usize)
                .ok_or(EngineError::Corrupt("temporal R3 routes_at_stop"))?;
            if self.query.excluded_routes.contains(&route.reader_route_idx)
                || self
                    .query
                    .excluded_modes
                    .iter()
                    .any(|&route_type| route_type_to_mode(route_type) == route.mode)
            {
                continue;
            }
            for (board_position, &stop) in route.stop_ids.iter().enumerate() {
                if stop != label.stop {
                    continue;
                }
                let mut position_candidates = Vec::new();
                for (trip_idx_in_route, trip) in route.trips.iter().enumerate() {
                    if !self
                        .reader
                        .service_active_on(trip.service_idx, label.service_date)
                        || (matches!(self.query.mobility, Mobility::Wheelchair)
                            && trip.wheelchair_accessible == 2)
                        || (matches!(self.query.mobility, Mobility::Bicycle)
                            && trip.bikes_allowed == 2)
                        || dep_secs_at(self.reader, trip, board_position)? == -1
                    {
                        continue;
                    }
                    let Some((floor, in_seat)) = self.board_rule(label, route, trip)? else {
                        continue;
                    };
                    if (label.stay_seated_only
                        || pickup_forbidden_at(self.reader, trip, board_position))
                        && !in_seat
                    {
                        continue;
                    }
                    let Some(earliest_board) = label.arrival_secs.checked_add(floor) else {
                        continue;
                    };
                    let Some(concrete) =
                        concrete_board(self.reader, trip, board_position, earliest_board)?
                    else {
                        continue;
                    };
                    if label.arriving_trip_idx == Some(trip.trip_idx)
                        && label.arriving_reader_route_idx == Some(route.reader_route_idx)
                        && label.frequency_instance == concrete.frequency_instance
                        && label.frequency_offset_secs == concrete.frequency_offset_secs
                    {
                        continue;
                    }
                    position_candidates.push(BoardCandidate {
                        route_idx,
                        trip_idx_in_route,
                        board_position,
                        board_secs: concrete.board_secs,
                        frequency_offset_secs: concrete.frequency_offset_secs,
                        frequency_instance: concrete.frequency_instance,
                        in_seat,
                    });
                }
                if self.preserve_all_boarding_trips {
                    candidates.extend(position_candidates);
                    continue;
                }

                // Without trip-scoped rules or type-4 continuations, candidates
                // from one pattern and board position differ downstream only by
                // arrival time. Keep each trip that wins at least one alight
                // position instead of emitting every trip at every position.
                // Reboarding a discarded trip cannot add reachability: that
                // trip's winning downstream positions are emitted directly.
                let mut best_by_position = vec![[None, None]; route.stop_ids.len()];
                for candidate in position_candidates {
                    let trip = &route.trips[candidate.trip_idx_in_route];
                    if self.trip_scoped_source_trips.contains(&trip.trip_idx) {
                        candidates.push(candidate);
                        continue;
                    }
                    for (alight_position, best_by_in_seat) in best_by_position
                        .iter_mut()
                        .enumerate()
                        .skip(candidate.board_position + 1)
                    {
                        if dep_secs_at(self.reader, trip, alight_position)? == -1
                            || drop_off_forbidden_at(self.reader, trip, alight_position)
                            || (matches!(self.query.mobility, Mobility::Wheelchair)
                                && self.reader.stop_wheelchair_boarding(
                                    route.stop_ids[alight_position] as usize,
                                )? == 2)
                        {
                            continue;
                        }
                        let Some(arrival_secs) =
                            alight_secs_at(self.reader, trip, alight_position)?
                                .checked_add(candidate.frequency_offset_secs)
                        else {
                            continue;
                        };
                        if arrival_secs < candidate.board_secs {
                            continue;
                        }
                        let best = &mut best_by_in_seat[usize::from(candidate.in_seat)];
                        let replace = best.is_none_or(
                            |(best_arrival, best_candidate): (i64, BoardCandidate)| {
                                if arrival_secs != best_arrival {
                                    return arrival_secs < best_arrival;
                                }
                                let best_trip = &route.trips[best_candidate.trip_idx_in_route];
                                (
                                    trip.trip_idx,
                                    candidate.board_secs,
                                    candidate.frequency_offset_secs,
                                    candidate.frequency_instance,
                                    candidate.in_seat,
                                ) < (
                                    best_trip.trip_idx,
                                    best_candidate.board_secs,
                                    best_candidate.frequency_offset_secs,
                                    best_candidate.frequency_instance,
                                    best_candidate.in_seat,
                                )
                            },
                        );
                        if replace {
                            *best = Some((arrival_secs, candidate));
                        }
                    }
                }
                for (_, winner) in best_by_position.into_iter().flatten().flatten() {
                    if !candidates.contains(&winner) {
                        candidates.push(winner);
                    }
                }
            }
        }
        Ok(candidates)
    }

    fn board_rule(
        &self,
        label: &Label,
        route: &IndexRoute,
        trip: &RouteTrip,
    ) -> Result<Option<(i64, bool)>, EngineError> {
        if label.provenance == ArrivalProvenance::Entry {
            return Ok(Some((0, false)));
        }

        let stop_id = self.reader.stop_id(label.stop as usize)?;
        let to_trip_id = self.reader.trip(trip.trip_idx as usize)?.trip_id;
        let to_route_id = self.reader.route(route.reader_route_idx as usize)?.route_id;
        let from_ids = if label.provenance == ArrivalProvenance::Transit {
            match (label.arriving_trip_idx, label.arriving_reader_route_idx) {
                (Some(from_trip_idx), Some(from_route_idx)) => Some((
                    self.reader.trip(from_trip_idx as usize)?.trip_id,
                    self.reader.route(from_route_idx as usize)?.route_id,
                )),
                _ => None,
            }
        } else {
            None
        };
        let mut key = String::new();
        let rule = same_stop_rule(
            self.index,
            &mut key,
            stop_id,
            from_ids
                .as_ref()
                .map(|(trip_id, route_id)| (trip_id.as_str(), route_id.as_str())),
            &to_trip_id,
            &to_route_id,
        );
        Ok(match rule {
            Some(rule) if rule.transfer_type == 3 => None,
            Some(rule) if rule.transfer_type == 2 => Some((rule.min_transfer_secs as i64, false)),
            Some(rule) if rule.transfer_type == 1 => Some((0, false)),
            Some(rule) if rule.transfer_type == 4 => Some((0, true)),
            Some(_) | None => Some((self.query.min_transfer_floor_secs(), false)),
        })
    }

    fn record_exits(&mut self, label_idx: usize) -> Result<(), EngineError> {
        let label = &self.labels[label_idx];
        if label.stay_seated_only {
            return Ok(());
        }
        for exit in &self.query.exit_stops {
            if exit.stop != label.stop
                || (matches!(self.query.mobility, Mobility::Wheelchair)
                    && self.reader.stop_wheelchair_boarding(exit.stop as usize)? == 2)
            {
                continue;
            }
            let Some(destination_arrival_secs) =
                label.arrival_secs.checked_add(exit.walk_secs as i64)
            else {
                continue;
            };
            let Some(total_walk_secs) =
                label.total_walk_secs.checked_add(u64::from(exit.walk_secs))
            else {
                continue;
            };
            insert_exit(
                &self.labels,
                &mut self.exits,
                ExitCandidate {
                    origin_departure_secs: label.origin_departure_secs,
                    destination_arrival_secs,
                    actual_transfers: label.actual_transfers,
                    total_walk_secs,
                    label_idx,
                },
                self.objectives,
            );
        }
        Ok(())
    }

    fn point_from_exit(&self, exit: ExitCandidate) -> R3Point {
        let label = &self.labels[exit.label_idx];
        R3Point {
            origin_departure_secs: exit.origin_departure_secs,
            destination_arrival_secs: exit.destination_arrival_secs,
            actual_transfers: exit.actual_transfers,
            transit_rounds: label.transit_rounds,
            total_walk_secs: exit.total_walk_secs,
            service_date: label.service_date,
            witness: build_witness(&self.labels, exit.label_idx),
        }
    }
}

fn trip_scoped_source_trips<B>(
    reader: &Reader<B>,
) -> Result<HashSet<u32, FxBuildHasher>, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let mut sources = HashSet::with_hasher(FxBuildHasher);
    for transfer_idx in 0..reader.num_transfers() {
        let rule = reader.transfer(transfer_idx)?;
        let actionable = rule.transfer_type == 3
            || (rule.transfer_type == 2 && rule.min_transfer_secs != TRANSFER_ABSENT)
            || matches!(rule.transfer_type, 1 | 4 | 5);
        if actionable
            && rule.from_trip_idx != TRANSFER_ABSENT
            && rule.to_trip_idx != TRANSFER_ABSENT
        {
            sources.insert(rule.from_trip_idx);
        }
    }
    Ok(sources)
}

fn same_stop_rule(
    index: &Index,
    key: &mut String,
    stop_id: &str,
    from_ids: Option<(&str, &str)>,
    to_trip_id: &str,
    to_route_id: &str,
) -> Option<TransferRuleApplied> {
    if let Some((from_trip_id, from_route_id)) = from_ids {
        transfer_trip_scoped_key_into(key, stop_id, stop_id, from_trip_id, to_trip_id);
        if let Some(rule) = index.transfer_rules_trip.get(key.as_str()) {
            return Some(*rule);
        }
        transfer_route_scoped_key_into(key, stop_id, stop_id, from_route_id, to_route_id);
        if let Some(rule) = index.transfer_rules_route.get(key.as_str()) {
            return Some(*rule);
        }
    }
    transfer_key_into(key, stop_id, stop_id);
    index.transfer_rules.get(key.as_str()).copied()
}

fn concrete_board<B>(
    reader: &Reader<B>,
    trip: &RouteTrip,
    board_position: usize,
    earliest_board: i64,
) -> Result<Option<ConcreteBoard>, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let template_board_secs = dep_secs_at(reader, trip, board_position)?;
    if !has_exact_times_zero_frequency(reader, trip.trip_idx) {
        return Ok(
            (template_board_secs >= earliest_board).then_some(ConcreteBoard {
                board_secs: template_board_secs,
                frequency_offset_secs: 0,
                frequency_instance: false,
            }),
        );
    }

    let Some(template_first_departure) = first_served_departure_secs(reader, trip)? else {
        return Ok(None);
    };
    let Some(template_offset) = template_board_secs.checked_sub(template_first_departure) else {
        return Ok(None);
    };
    let Some(earliest_first_departure) = earliest_board.checked_sub(template_offset) else {
        return Ok(None);
    };
    let mut best: Option<ConcreteBoard> = None;
    for row in reader
        .frequencies_for_trip(trip.trip_idx)
        .filter(|row| row.exact_times == 0)
    {
        let start = row.start_secs as i64;
        let end = row.end_secs as i64;
        let headway = row.headway_secs as i64;
        if headway <= 0 || start >= end || earliest_first_departure >= end {
            continue;
        }
        let first_departure = if earliest_first_departure <= start {
            start
        } else {
            let Some(distance) = earliest_first_departure.checked_sub(start) else {
                continue;
            };
            let Some(steps) = distance
                .checked_add(headway - 1)
                .and_then(|value| value.checked_div(headway))
            else {
                continue;
            };
            let Some(first_departure) = steps
                .checked_mul(headway)
                .and_then(|value| start.checked_add(value))
            else {
                continue;
            };
            first_departure
        };
        if first_departure >= end {
            continue;
        }
        let Some(frequency_offset_secs) = first_departure.checked_sub(template_first_departure)
        else {
            continue;
        };
        let Some(board_secs) = template_board_secs.checked_add(frequency_offset_secs) else {
            continue;
        };
        let candidate = ConcreteBoard {
            board_secs,
            frequency_offset_secs,
            frequency_instance: true,
        };
        if best.is_none_or(|incumbent| candidate.board_secs < incumbent.board_secs) {
            best = Some(candidate);
        }
    }
    Ok(best)
}

fn first_served_departure_secs<B>(
    reader: &Reader<B>,
    trip: &RouteTrip,
) -> Result<Option<i64>, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    for position in 0..trip.pos_to_row.len() {
        let departure = dep_secs_at(reader, trip, position)?;
        if departure != -1 {
            return Ok(Some(departure));
        }
    }
    Ok(None)
}

fn has_exact_times_zero_frequency<B>(reader: &Reader<B>, trip_idx: u32) -> bool
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    reader
        .frequencies_for_trip(trip_idx)
        .any(|row| row.exact_times == 0)
}

fn same_label_objectives(left: &Label, right: &Label, objectives: ProfileObjectives) -> bool {
    left.origin_departure_secs == right.origin_departure_secs
        && left.arrival_secs == right.arrival_secs
        && left.actual_transfers == right.actual_transfers
        && (objectives == ProfileObjectives::R3 || left.total_walk_secs == right.total_walk_secs)
}

fn label_dominates(left: &Label, right: &Label, objectives: ProfileObjectives) -> bool {
    left.origin_departure_secs >= right.origin_departure_secs
        && left.arrival_secs <= right.arrival_secs
        && left.actual_transfers <= right.actual_transfers
        && (objectives == ProfileObjectives::R3 || left.total_walk_secs <= right.total_walk_secs)
        && (left.origin_departure_secs > right.origin_departure_secs
            || left.arrival_secs < right.arrival_secs
            || left.actual_transfers < right.actual_transfers
            || (objectives == ProfileObjectives::M4
                && left.total_walk_secs < right.total_walk_secs))
}

type SemanticWitnessLeg = (u32, u32, u32, u32, u32, u32, i64, i64, i64, bool, bool);

fn semantic_leg(leg: R3TransitWitness) -> SemanticWitnessLeg {
    (
        leg.service_date,
        leg.route_idx,
        leg.reader_route_idx,
        leg.trip_idx,
        leg.board_position,
        leg.alight_position,
        leg.board_secs,
        leg.alight_secs,
        leg.frequency_offset_secs,
        leg.frequency_instance,
        leg.in_seat,
    )
}

fn semantic_witness_from_parent(
    labels: &[Label],
    mut parent: Option<ParentWitness>,
) -> Vec<SemanticWitnessLeg> {
    let mut witness = Vec::new();
    while let Some(step) = parent {
        witness.push(semantic_leg(step.leg));
        parent = labels[step.label_idx].parent;
    }
    witness.reverse();
    witness
}

fn semantic_witness(labels: &[Label], label_idx: usize) -> Vec<SemanticWitnessLeg> {
    semantic_witness_from_parent(labels, labels[label_idx].parent)
}

fn label_tie_preferred(labels: &[Label], candidate: &Label, existing_idx: usize) -> bool {
    let existing = &labels[existing_idx];
    match candidate.total_walk_secs.cmp(&existing.total_walk_secs) {
        Ordering::Less => true,
        Ordering::Greater => false,
        Ordering::Equal => {
            semantic_witness_from_parent(labels, candidate.parent)
                < semantic_witness(labels, existing_idx)
        }
    }
}

fn insert_exit(
    labels: &[Label],
    profile: &mut Vec<ExitCandidate>,
    candidate: ExitCandidate,
    objectives: ProfileObjectives,
) {
    if let Some(existing) = profile
        .iter_mut()
        .find(|point| same_exit_objectives(point, &candidate, objectives))
    {
        let preferred = match candidate.total_walk_secs.cmp(&existing.total_walk_secs) {
            Ordering::Less => true,
            Ordering::Greater => false,
            Ordering::Equal => {
                semantic_witness(labels, candidate.label_idx)
                    < semantic_witness(labels, existing.label_idx)
            }
        };
        if preferred {
            *existing = candidate;
        }
        return;
    }
    if profile
        .iter()
        .any(|point| exit_dominates(point, &candidate, objectives))
    {
        return;
    }
    profile.retain(|point| !exit_dominates(&candidate, point, objectives));
    profile.push(candidate);
}

fn same_exit_objectives(
    left: &ExitCandidate,
    right: &ExitCandidate,
    objectives: ProfileObjectives,
) -> bool {
    left.origin_departure_secs == right.origin_departure_secs
        && left.destination_arrival_secs == right.destination_arrival_secs
        && left.actual_transfers == right.actual_transfers
        && (objectives == ProfileObjectives::R3 || left.total_walk_secs == right.total_walk_secs)
}

fn exit_dominates(
    left: &ExitCandidate,
    right: &ExitCandidate,
    objectives: ProfileObjectives,
) -> bool {
    left.origin_departure_secs >= right.origin_departure_secs
        && left.destination_arrival_secs <= right.destination_arrival_secs
        && left.actual_transfers <= right.actual_transfers
        && (objectives == ProfileObjectives::R3 || left.total_walk_secs <= right.total_walk_secs)
        && (left.origin_departure_secs > right.origin_departure_secs
            || left.destination_arrival_secs < right.destination_arrival_secs
            || left.actual_transfers < right.actual_transfers
            || (objectives == ProfileObjectives::M4
                && left.total_walk_secs < right.total_walk_secs))
}

fn exit_order(labels: &[Label], left: &ExitCandidate, right: &ExitCandidate) -> Ordering {
    right
        .origin_departure_secs
        .cmp(&left.origin_departure_secs)
        .then_with(|| {
            left.destination_arrival_secs
                .cmp(&right.destination_arrival_secs)
        })
        .then_with(|| left.actual_transfers.cmp(&right.actual_transfers))
        .then_with(|| left.total_walk_secs.cmp(&right.total_walk_secs))
        .then_with(|| {
            semantic_witness(labels, left.label_idx).cmp(&semantic_witness(labels, right.label_idx))
        })
}

fn exit_objectives(exit: &ExitCandidate, objectives: ProfileObjectives) -> EmittedObjectives {
    (
        exit.origin_departure_secs,
        exit.destination_arrival_secs,
        exit.actual_transfers,
        (objectives == ProfileObjectives::M4).then_some(exit.total_walk_secs),
    )
}

fn diagnostics_delta(after: R3Diagnostics, before: R3Diagnostics) -> R3Diagnostics {
    R3Diagnostics {
        entry_events: after.entry_events - before.entry_events,
        enumerated_entry_events: 0,
        timestamp_buckets: after.timestamp_buckets - before.timestamp_buckets,
        accepted_labels: after.accepted_labels - before.accepted_labels,
        propagated_labels: after.propagated_labels - before.propagated_labels,
        reused_labels: after.reused_labels - before.reused_labels,
    }
}

fn build_witness(labels: &[Label], mut label_idx: usize) -> Vec<R3TransitWitness> {
    let mut witness = Vec::new();
    while let Some(parent) = labels[label_idx].parent {
        witness.push(parent.leg);
        label_idx = parent.label_idx;
    }
    witness.reverse();
    witness
}
