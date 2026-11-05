//! Walking-aware Trip-Based experiment: bounded, unreduced transfer
//! preprocessing.
//!
//! The index covers one explicit timeline interval of one service date and one
//! mobility/mode configuration. Every concrete stop event is identified by
//! vehicle (trip, service date, frequency shift) and canonical position, so a
//! loop/lasso stop visited twice is two events. Each arrival in the interval
//! keeps every boarding the v2 reference would expand from it, no reduction:
//! same-stop, one directed PTFT movement, synthetic rule movements, linked
//! continuations and derived block continuations. Rules, calendars, overnight
//! times, DST origins and frequency instances come from the reference
//! primitives, unchanged. Walking and the minimum arrival-to-departure time
//! are stored separately; edges stay feasible concrete boardings, so a query
//! still applies its own horizon and round cap.
//! GTFS: <https://gtfs.org/documentation/schedule/reference/#transferstxt>,
//! <https://gtfs.org/documentation/schedule/reference/#frequenciestxt>,
//! <https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes>,
//! <https://gtfs.org/documentation/schedule/reference/#field-types>.

use super::r3::R3TransitWitness;
use super::v2::{
    inaccessible, route_allowed, trip_allowed, visit_boardings, Boarding, State, Strategy,
};
use crate::engine::consts::{
    DEFAULT_WALK_SPEED_MM_S, RAPTOR_MIN_TRANSFER_SECS, WHEELCHAIR_WALK_SPEED_MM_S,
};
use crate::engine::scan::{
    alight_secs_at, dep_secs_at, drop_off_forbidden_at, pickup_forbidden_at,
};
use crate::engine::v2::{instances::visit_instances, scan::Inst, time};
use crate::engine::{EngineError, Index, Mobility, Query};
use crate::{Reader, Transfers};
use alloc::vec::Vec;
use core::mem::size_of;
use core::num::NonZeroU32;
use core::ops::Range;
use sha2::{Digest, Sha256};

mod date_memo;
mod deadline;
mod event_index;
mod frontier;
mod incoming_sort;
mod journey;
mod journey_meter;
mod latest_scan;
mod lazy;
mod optimistic;
mod portfolio;
mod prefix;
mod query;
mod raptor_seeds;
mod reduction;
mod seeds;
mod session;
mod timetable_prefix;
pub use deadline::{
    query_deadline, query_deadline_incumbent_ceiling, query_deadline_portfolio,
    query_deadline_portfolio_with_phases, query_deadline_portfolio_with_suffix_pruning,
    query_deadline_preference, query_deadline_preference_with_phases,
    query_deadline_preference_with_suffix_pruning, query_deadline_with_phases, DeadlineDiagnostics,
    DeadlineError, DeadlineIncumbentCeiling, DeadlineIncumbentCeilingError, DeadlineLookup,
    DeadlinePhase, DeadlinePruning, DeadlineRequest, DeadlineResult, DeadlineTraversal,
    DeadlineWarmupDiagnostics, DeadlineWinnerCeilingPass, DeadlineWinnerCeilingPhase,
    DeadlineWinnerIncumbentCeiling, DeadlineWitnessComparison, OriginHintDiagnostics,
};
pub use event_index::{build_event_index, EventIndex, EventIndexDiagnostics};
#[cfg(test)]
pub(crate) use event_index::{
    build_window_event_index_for_test, slice_copy_for_test, take_slice_for_test,
};

/// Test-only: the owner's catalogue path, with stored trip spans.
#[cfg(test)]
pub(crate) fn build_event_index_with_spans_for_test<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    config: &TransferIndexConfig,
) -> Result<EventIndex, TransferIndexError> {
    let spans = TripSpans::build(reader, index);
    event_index::build_event_index_with_phases(
        reader,
        index,
        None,
        config,
        None,
        Some(&spans),
        &mut |_| {},
    )
}
pub use frontier::{DeadlineFrontierStats, DeadlineFrontierStorage};
pub use journey::{
    DeadlineJourney, DeadlineJourneyConnection, DeadlineJourneyDiagnostics, DeadlineJourneyEgress,
    DeadlineJourneyRide, DeadlinePortfolioJourneyResult, DeadlinePreferenceJourneyResult,
};
pub use latest_scan::{
    LatestScanDiagnostics, LatestScanError, LatestScanResult, SelectorScanResult,
};
pub use lazy::{
    IncomingTransfer, LazyLookupConfig, LazyLookupDiagnostics, LazyLookupError, LazyLookupMode,
    LazyPredecessors,
};
pub use optimistic::OptimisticDiagnostics;
pub use portfolio::{
    DeadlinePortfolioDiagnostics, DeadlinePortfolioResult, DeadlinePortfolioWinners,
    DeadlinePreference, DeadlinePreferenceResult, DeadlineSuffixPruning,
};
pub use prefix::PrefixDiagnostics;
#[cfg(test)]
pub(crate) use prefix::{origin_uppers_for_test, transfer_lowers_for_test};
pub use query::{
    profile_trip_m4, profile_trip_r3, TripProfileDiagnostics, TripProfileError, TripProfileRequest,
    TripProfileResult,
};
pub use raptor_seeds::RaptorSeedDiagnostics;
pub use reduction::{reduce_transfer_index, TransferReductionDiagnostics};
pub use seeds::ForwardSeedDiagnostics;
pub use session::{
    CatalogueOrigin, CatalogueSource, DeadlineSession, DeadlineSessionConfig,
    DeadlineSessionPrepareError,
};
pub use timetable_prefix::TimetablePrefixDiagnostics;

/// Completion markers for diagnostic setup attribution. No clock, retained
/// state, work charge or timing-based decision lives in the engine. A failed
/// preparation emits only its completed prefix of markers, never `Completed`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeadlineSetupPhase {
    Started,
    /// Owner construction only: the routing index is built.
    IndexBuilt,
    /// Owner construction only: every trip's template span is stored.
    TripSpansBuilt,
    /// `prepare_window` only: a window catalogue is built and stored.
    WindowCatalogueBuilt,
    RequestInvalidated,
    RequestShapeValidated,
    CatalogueKeyComputed,
    EventCoverageValidated,
    ImmutableBindingReused,
    PtbHashed,
    TransfersHashed,
    LayoutHashed,
    BindingComputed,
    EventsEnumerated,
    EventsSorted,
    ArrivalsIndexed,
    /// The request's catalogue was cut from the stored window catalogue, in
    /// place of `EventsEnumerated`, `EventsSorted` and `ArrivalsIndexed`.
    CatalogueSliced,
    /// H83: the request's catalogue was copied from the held catalogue, in
    /// place of `EventsEnumerated`, `EventsSorted` and `ArrivalsIndexed`.
    HeldCatalogueSliced,
    CatalogueCompacted,
    CatalogueValidated,
    RequestStored,
    PrefixBuilt,
    Completed,
}

/// How a boarding after an arrival was formed. Type-4 and derived block
/// continuations spend a transit round but no passenger transfer.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
#[repr(u8)]
pub enum TransferKind {
    SameStop = 0,
    Footpath = 1,
    Synthetic = 2,
    Linked = 3,
    InSeat = 4,
    Derived = 5,
}

impl TransferKind {
    pub fn spends_transfer(self) -> bool {
        !matches!(self, TransferKind::InSeat | TransferKind::Derived)
    }
}

/// Build caps. `max_bytes` bounds tracked event/CSR/edge buffers and boarding
/// scratch, including growth headroom. Input indices, trip-template/hash
/// scratch, allocator overhead and reallocation overlap are not charged.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TransferIndexLimits {
    pub max_events: usize,
    pub max_edges: usize,
    pub max_bytes: usize,
}

impl Default for TransferIndexLimits {
    fn default() -> Self {
        Self {
            max_events: 20_000_000,
            max_edges: 50_000_000,
            max_bytes: 1 << 30,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferIndexConfig {
    /// Timeline anchor: seconds are relative to this date's service-day origin.
    pub service_date: u32,
    /// Half-open. Sources arrive and targets depart inside it.
    pub covered: Range<i64>,
    pub mobility: Mobility,
    /// Parent GTFS route ordinals, as Query::excluded_routes.
    pub excluded_routes: Vec<u32>,
    /// GTFS route_type codes, compared by mode family as in `plan()`.
    pub excluded_modes: Vec<u16>,
    /// The rider's transfer-walk speed and minimum transfer, as
    /// [`Query::walk_speed_mm_s`] and [`Query::min_transfer_secs`]; `None`
    /// keeps the defaults. Edge walks and floors depend on both.
    pub walk_speed_mm_s: Option<NonZeroU32>,
    pub min_transfer_secs: Option<u32>,
    pub limits: TransferIndexLimits,
}

impl TransferIndexConfig {
    pub fn new(service_date: u32, covered: Range<i64>) -> Self {
        Self {
            service_date,
            covered,
            mobility: Mobility::Default,
            excluded_routes: Vec::new(),
            excluded_modes: Vec::new(),
            walk_speed_mm_s: None,
            min_transfer_secs: None,
            limits: TransferIndexLimits::default(),
        }
    }

    /// `query`'s date, mobility, excluded modes and walk settings over
    /// `covered`, with the default limits.
    pub fn for_query(query: &Query, covered: Range<i64>) -> Self {
        Self {
            mobility: query.mobility,
            excluded_routes: query.excluded_routes.clone(),
            excluded_modes: query.excluded_modes.clone(),
            walk_speed_mm_s: query.walk_speed_mm_s,
            min_transfer_secs: query.min_transfer_secs,
            ..Self::new(query.date, covered)
        }
    }

    /// A stop-free query with this configuration, departing at `covered.start`.
    fn query(&self) -> Query {
        Query {
            excluded_routes: self.excluded_routes.clone(),
            entry_stops: Vec::new(),
            exit_stops: Vec::new(),
            departure_secs: self.covered.start,
            date: self.service_date,
            max_rounds: None,
            mobility: self.mobility,
            excluded_modes: self.excluded_modes.clone(),
            walk_speed_mm_s: self.walk_speed_mm_s,
            min_transfer_secs: self.min_transfer_secs,
        }
    }

    /// The effective (walk speed mm/s, minimum transfer s) pair, so equal
    /// settings compare equal however they were spelled.
    pub(super) fn walk_settings(&self) -> (u32, i64) {
        let q = self.query();
        (q.transfer_walk_speed_mm_s(), q.min_transfer_floor_secs())
    }
}

const BOARD: u8 = 1;
const ALIGHT: u8 = 2;
const SOURCE: u8 = 4;
const APPROXIMATE: u8 = 8;
const TARGET: u8 = 16;
const START: u8 = 32;

/// One concrete stop event. Times are timeline seconds of the configured date.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StopEvent {
    pub frequency_offset_secs: i64,
    pub arrival_secs: i64,
    pub departure_secs: i64,
    /// Pattern ordinal in `Index::routes`.
    pub route_idx: u32,
    pub trip_idx: u32,
    pub date_ordinal: u32,
    pub position: u32,
    flags: u8,
}

impl StopEvent {
    /// The passenger may board here (pickup, accessibility, not terminal).
    pub fn can_board(&self) -> bool {
        self.flags & BOARD != 0
    }

    pub fn can_alight(&self) -> bool {
        self.flags & ALIGHT != 0
    }

    /// Arrives inside the covered interval and may continue: alighting, or a
    /// terminal stop's in-seat continuation.
    pub fn is_source(&self) -> bool {
        self.flags & SOURCE != 0
    }

    /// An `exact_times=0` frequency instance.
    pub fn approximate(&self) -> bool {
        self.flags & APPROXIMATE != 0
    }

    /// The vehicle's initial stop_time: an in-seat continuation boards here
    /// without a pickup, so it is a target even when `can_board` is false.
    pub fn is_trip_start(&self) -> bool {
        self.flags & START != 0
    }

    fn key(&self) -> (u32, u32, i64, u32) {
        (
            self.trip_idx,
            self.date_ordinal,
            self.frequency_offset_secs,
            self.position,
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TransferEdge {
    /// Boarding event ordinal in [`TransferIndex::events`].
    pub target: u32,
    /// Physical walking of this movement only.
    pub walk_secs: u32,
    /// Minimum arrival-to-departure time the movement needs; at least the walk.
    pub elapsed_secs: u32,
    pub kind: TransferKind,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TransferIndexDiagnostics {
    pub events: usize,
    pub arrival_sources: usize,
    pub boarding_events: usize,
    pub edges: usize,
    /// Indexed by `TransferKind as usize`.
    pub edges_by_kind: [usize; 6],
    pub max_out_degree: usize,
    /// Final event, offset and edge arrays.
    pub index_bytes: usize,
    /// Largest simultaneous capacity of the index's own build buffers. Search
    /// scratch and allocator overhead are excluded; measure RSS separately.
    pub peak_build_bytes: usize,
}

/// SHA-256 digests of everything the edges depend on.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TransferIndexBinding {
    pub ptb_sha256: [u8; 32],
    pub ptft_sha256: Option<[u8; 32]>,
    /// Pattern layout: positions are pattern positions, so PatternMode matters.
    pub layout_sha256: [u8; 32],
    /// Date, interval, mobility, excluded mode families and non-default walk
    /// settings; not the limits.
    pub config_sha256: [u8; 32],
}

// Not a public validation token. Only an immutable owned session retains this;
// generic builders/checks always derive it from their actual input references.
#[derive(Clone, Copy)]
struct ImmutableBinding {
    ptb_sha256: [u8; 32],
    ptft_sha256: Option<[u8; 32]>,
    layout_sha256: [u8; 32],
}

impl ImmutableBinding {
    fn with_config(self, config: &TransferIndexConfig) -> TransferIndexBinding {
        TransferIndexBinding {
            ptb_sha256: self.ptb_sha256,
            ptft_sha256: self.ptft_sha256,
            layout_sha256: self.layout_sha256,
            config_sha256: configuration_digest(config),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TransferIndexError {
    Engine(EngineError),
    InvalidConfig(&'static str),
    EventsExhausted { limit: usize, attempted: usize },
    EdgesExhausted { limit: usize, attempted: usize },
    BytesExhausted { limit: usize, attempted: usize },
}

impl From<EngineError> for TransferIndexError {
    fn from(e: EngineError) -> Self {
        TransferIndexError::Engine(e)
    }
}

/// Flat adjacency: `edges[offsets[e]..offsets[e + 1]]` leave arrival event `e`.
pub struct TransferIndex {
    binding: TransferIndexBinding,
    covered: Range<i64>,
    events: Vec<StopEvent>,
    offsets: Vec<u32>,
    edges: Vec<TransferEdge>,
    diagnostics: TransferIndexDiagnostics,
}

impl TransferIndex {
    pub fn covered(&self) -> Range<i64> {
        self.covered.clone()
    }

    /// Sorted by vehicle (trip, date, frequency shift), then position.
    pub fn events(&self) -> &[StopEvent] {
        &self.events
    }

    pub fn transfers_from(&self, event: u32) -> &[TransferEdge] {
        let e = event as usize;
        match (self.offsets.get(e), self.offsets.get(e + 1)) {
            (Some(&a), Some(&b)) => &self.edges[a as usize..b as usize],
            _ => &[],
        }
    }

    pub fn diagnostics(&self) -> TransferIndexDiagnostics {
        self.diagnostics
    }

    pub fn binding(&self) -> TransferIndexBinding {
        self.binding
    }

    /// Whether these edges are valid for this bundle, PTFT, index layout and
    /// configuration. Never reuse the index when this is false.
    pub fn is_bound_to<B: AsRef<[u8]> + Send + Sync + 'static>(
        &self,
        reader: &Reader<B>,
        index: &Index,
        transfers: Option<&Transfers>,
        config: &TransferIndexConfig,
    ) -> bool {
        binding(reader, index, transfers, config) == self.binding
    }
}

fn build_events<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    transfers: Option<&Transfers>,
    config: &TransferIndexConfig,
) -> Result<(TransferIndexBinding, Vec<StopEvent>, usize), TransferIndexError> {
    build_events_with_phases(reader, index, transfers, config, None, None, &mut |_| {})
}

/// Checks and binding shared by a fresh and a sliced catalogue, in the fresh
/// build's order: interval and limits, versions, service date, horizon, then
/// the binding. Returns the binding and the service date's origin.
fn catalogue_prelude<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    transfers: Option<&Transfers>,
    config: &TransferIndexConfig,
    immutable_binding: Option<ImmutableBinding>,
    observe: &mut impl FnMut(DeadlineSetupPhase),
) -> Result<(TransferIndexBinding, i64), TransferIndexError> {
    let covered = config.covered.clone();
    if covered.start >= covered.end {
        return Err(TransferIndexError::InvalidConfig(
            "covered interval must be non-empty",
        ));
    }
    let limits = config.limits;
    if limits.max_events >= u32::MAX as usize || limits.max_edges >= u32::MAX as usize {
        return Err(TransferIndexError::InvalidConfig(
            "event and edge limits must fit u32 ordinals",
        ));
    }
    let v2 = index.v2.as_deref().ok_or(EngineError::UnsupportedVersion)?;
    if !reader.is_v2() {
        return Err(EngineError::UnsupportedVersion.into());
    }
    let ordinal = time::date_ordinal(reader, config.service_date)
        .ok_or(EngineError::UnsupportedServiceDate)?;
    let origin_unix = time::origin(reader, ordinal)?;
    // Every service date with an event inside the interval must be routable,
    // or the edges would silently omit vehicles.
    let n = time::routable_dates(reader);
    let first_complete = time::origin(reader, 0)?
        .checked_add(v2.max_event_secs)
        .ok_or(EngineError::TimeOverflow)?;
    let next_missing = time::origin(reader, n)?
        .checked_add(v2.min_event_secs.min(0))
        .ok_or(EngineError::TimeOverflow)?;
    let start_unix = origin_unix
        .checked_add(covered.start)
        .ok_or(EngineError::TimeOverflow)?;
    let last_unix = origin_unix
        .checked_add(covered.end - 1)
        .ok_or(EngineError::TimeOverflow)?;
    if start_unix < first_complete || last_unix >= next_missing {
        return Err(EngineError::IncompleteHorizon.into());
    }
    observe(DeadlineSetupPhase::EventCoverageValidated);
    let binding = if let Some(immutable) = immutable_binding {
        observe(DeadlineSetupPhase::ImmutableBindingReused);
        let binding = immutable.with_config(config);
        observe(DeadlineSetupPhase::BindingComputed);
        binding
    } else {
        binding_with_phases(reader, index, transfers, config, observe)
    };
    Ok((binding, origin_unix))
}

#[allow(clippy::too_many_arguments)]
fn build_events_with_phases<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    transfers: Option<&Transfers>,
    config: &TransferIndexConfig,
    immutable_binding: Option<ImmutableBinding>,
    spans: Option<&TripSpans>,
    observe: &mut impl FnMut(DeadlineSetupPhase),
) -> Result<(TransferIndexBinding, Vec<StopEvent>, usize), TransferIndexError> {
    let (binding, origin_unix) =
        catalogue_prelude(reader, index, transfers, config, immutable_binding, observe)?;
    let covered = config.covered.clone();
    let limits = config.limits;
    let query = config.query();
    let mut peak = 0;
    let mut events = Vec::new();
    enumerate_events(
        reader,
        index,
        &query,
        &covered,
        origin_unix,
        limits,
        spans,
        &mut events,
        &mut peak,
    )?;
    observe(DeadlineSetupPhase::EventsEnumerated);
    events.sort_unstable_by_key(StopEvent::key);
    observe(DeadlineSetupPhase::EventsSorted);
    Ok((binding, events, peak))
}

pub fn build_transfer_index<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    transfers: Option<&Transfers>,
    config: &TransferIndexConfig,
) -> Result<TransferIndex, TransferIndexError> {
    let (binding, mut events, mut peak) = build_events(reader, index, transfers, config)?;
    let covered = config.covered.clone();
    let limits = config.limits;
    let ordinal = time::date_ordinal(reader, config.service_date)
        .ok_or(EngineError::UnsupportedServiceDate)?;
    let origin_unix = time::origin(reader, ordinal)?;
    let query = config.query();

    let mut offsets: Vec<u32> = Vec::new();
    let mut edges: Vec<TransferEdge> = Vec::new();
    let mut scratch: Vec<Boarding> = Vec::new();
    let events_bytes = bytes_of(&events);
    reserve(
        &mut offsets,
        events.len() + 1,
        events_bytes,
        limits,
        &mut peak,
    )?;
    let mut diagnostics = TransferIndexDiagnostics {
        events: events.len(),
        ..TransferIndexDiagnostics::default()
    };
    for i in 0..events.len() {
        offsets.push(edges.len() as u32);
        let ev = events[i];
        if ev.flags & TARGET != 0 {
            diagnostics.boarding_events += 1;
        }
        if !ev.is_source() {
            continue;
        }
        diagnostics.arrival_sources += 1;
        let route = &index.routes[ev.route_idx as usize];
        let arrival = State {
            inst: Inst {
                trip: ev.trip_idx,
                date: ev.date_ordinal,
                shift: ev.frequency_offset_secs,
            },
            stop: route.stop_ids[ev.position as usize],
            position: ev.position,
            time: ev.arrival_secs,
            transfers: 0,
            rounds: 1,
            walk: 0,
            can_alight: ev.can_alight(),
            id: 0,
            parent: None,
            leg: R3TransitWitness {
                service_date: crate::reader::days_add(
                    reader.feed_start_date(),
                    ev.date_ordinal as i64,
                ),
                route_idx: ev.route_idx,
                reader_route_idx: route.reader_route_idx,
                trip_idx: ev.trip_idx,
                board_position: ev.position,
                alight_position: ev.position,
                board_secs: ev.arrival_secs,
                alight_secs: ev.arrival_secs,
                frequency_offset_secs: ev.frequency_offset_secs,
                frequency_instance: ev.approximate(),
                in_seat: false,
            },
            origin_departure: 0,
            continuation_only: false,
        };
        scratch.clear();
        let others = events_bytes + bytes_of(&offsets) + bytes_of(&edges);
        visit_boardings(
            reader,
            index,
            &query,
            transfers,
            origin_unix,
            covered.end - 1,
            arrival,
            Collect {
                out: &mut scratch,
                edges: edges.len(),
                others,
                limits,
                peak: &mut peak,
            },
        )?;
        let start = edges.len();
        let others = events_bytes + bytes_of(&offsets) + bytes_of(&scratch);
        reserve(&mut edges, start + scratch.len(), others, limits, &mut peak)?;
        for b in &scratch {
            let key = (
                b.instance.inst.trip,
                b.instance.inst.date,
                b.instance.inst.shift,
                b.position,
            );
            let target = events
                .binary_search_by_key(&key, StopEvent::key)
                .map_err(|_| EngineError::Corrupt("trip-transfer target was not enumerated"))?;
            let walk = u32::try_from(b.walk).map_err(|_| EngineError::TimeOverflow)?;
            let elapsed = u32::try_from(b.elapsed).map_err(|_| EngineError::TimeOverflow)?;
            edges.push(TransferEdge {
                target: target as u32,
                walk_secs: walk,
                elapsed_secs: elapsed,
                kind: b.kind,
            });
            diagnostics.edges_by_kind[b.kind as usize] += 1;
        }
        edges[start..].sort_unstable_by_key(|e| (e.target, e.kind, e.walk_secs));
        diagnostics.max_out_degree = diagnostics.max_out_degree.max(edges.len() - start);
    }
    offsets.push(edges.len() as u32);
    events.shrink_to_fit();
    offsets.shrink_to_fit();
    edges.shrink_to_fit();
    diagnostics.edges = edges.len();
    diagnostics.index_bytes = len_bytes(&events) + len_bytes(&offsets) + len_bytes(&edges);
    diagnostics.peak_build_bytes = peak.max(diagnostics.index_bytes);
    Ok(TransferIndex {
        binding,
        covered,
        events,
        offsets,
        edges,
        diagnostics,
    })
}

/// Every allowed vehicle's stop events that can be a source or a target in
/// `covered`. Instances are found from the first served position with bounds
/// widened by the trip's own event span, then each event is filtered exactly.
#[allow(clippy::too_many_arguments)]
/// Each routing-index trip slot's template span: the `(lo, hi)` offsets from
/// the trip's first departure that enumeration derives from its template.
/// Built once per owner from the owner's reader and index; `None` marks a slot
/// enumeration skips, or one whose times fail to decode (enumeration then takes
/// the full path for it and reports the same error).
pub(super) struct TripSpans {
    route_starts: Vec<u32>,
    spans: Vec<Option<(i64, i64)>>,
}

impl TripSpans {
    pub(super) fn build<B: AsRef<[u8]> + Send + Sync + 'static>(
        reader: &Reader<B>,
        index: &Index,
    ) -> Self {
        let mut route_starts = Vec::with_capacity(index.routes.len() + 1);
        let mut spans = Vec::new();
        for route in &index.routes {
            route_starts.push(spans.len() as u32);
            for trip in &route.trips {
                spans.push(index.v2.as_deref().and_then(|v2| {
                    let info = v2.trips.get(trip.trip_idx as usize)?;
                    if info.route == u32::MAX {
                        return None;
                    }
                    let (first, last) = (info.first_pos as usize, info.last_pos as usize);
                    trip_span(reader, trip, first, last).ok()
                }));
            }
        }
        route_starts.push(spans.len() as u32);
        Self {
            route_starts,
            spans,
        }
    }

    fn get(&self, route: usize, slot: usize) -> Option<(i64, i64)> {
        let start = *self.route_starts.get(route)? as usize;
        let end = *self.route_starts.get(route + 1)? as usize;
        if start + slot >= end {
            return None;
        }
        self.spans[start + slot]
    }

    pub(super) fn bytes(&self) -> usize {
        len_bytes(&self.route_starts) + len_bytes(&self.spans)
    }
}

/// The span part of a trip template, by the same calls and the same initial
/// `(0, 0)` as [`fill_template`].
fn trip_span<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    trip: &crate::engine::index::RouteTrip,
    first: usize,
    last: usize,
) -> Result<(i64, i64), EngineError> {
    let first_dep = dep_secs_at(reader, trip, first)?;
    let (mut lo, mut hi) = (0i64, 0i64);
    for position in first..=last {
        if trip.pos_to_row[position] == -1 {
            continue;
        }
        let arrival = alight_secs_at(reader, trip, position)?;
        let departure = dep_secs_at(reader, trip, position)?;
        lo = lo.min(arrival.min(departure) - first_dep);
        hi = hi.max(arrival.max(departure) - first_dep);
    }
    Ok((lo, hi))
}

type Template = Vec<(u32, i64, i64, u8)>;

/// One trip's time-independent template: each served position's arrival,
/// departure and flags. Returns its span `(lo, hi)`.
fn fill_template<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    query: &Query,
    route: &crate::engine::index::IndexRoute,
    trip: &crate::engine::index::RouteTrip,
    first: usize,
    last: usize,
    template: &mut Template,
) -> Result<(i64, i64), EngineError> {
    let first_dep = dep_secs_at(reader, trip, first)?;
    let (mut lo, mut hi) = (0i64, 0i64);
    template.clear();
    for position in first..=last {
        if trip.pos_to_row[position] == -1 {
            continue;
        }
        let arrival = alight_secs_at(reader, trip, position)?;
        let departure = dep_secs_at(reader, trip, position)?;
        lo = lo.min(arrival.min(departure) - first_dep);
        hi = hi.max(arrival.max(departure) - first_dep);
        let accessible = !inaccessible(reader, query, route.stop_ids[position])?;
        let mut flags = 0;
        if position < last && !pickup_forbidden_at(reader, trip, position) && accessible {
            flags |= BOARD;
        }
        if !drop_off_forbidden_at(reader, trip, position) && accessible {
            flags |= ALIGHT;
        }
        if position == first {
            flags |= START;
        }
        // Mirrors `ride`: a non-alighting stop only continues in seat.
        if position > first && (flags & ALIGHT != 0 || position == last) {
            flags |= SOURCE;
        }
        template.push((position as u32, arrival, departure, flags));
    }
    Ok((lo, hi))
}

/// With `spans`, a trip's template is built at its first instance in the
/// window, so trips the window cannot reach never decode their times. The
/// span, instances, template and event order are the same either way.
#[allow(clippy::too_many_arguments)]
fn enumerate_events<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    query: &Query,
    covered: &Range<i64>,
    origin_unix: i64,
    limits: TransferIndexLimits,
    spans: Option<&TripSpans>,
    events: &mut Vec<StopEvent>,
    peak: &mut usize,
) -> Result<(), TransferIndexError> {
    let v2 = index.v2.as_deref().ok_or(EngineError::UnsupportedVersion)?;
    let mut template: Template = Vec::new();
    for (ri, route) in index.routes.iter().enumerate() {
        if !route_allowed(route, query) {
            continue;
        }
        for (slot, trip) in route.trips.iter().enumerate() {
            let info = v2.trips[trip.trip_idx as usize];
            if info.route == u32::MAX || !trip_allowed(trip, query) {
                continue;
            }
            let (first, last) = (info.first_pos as usize, info.last_pos as usize);
            let stored = spans.and_then(|s| s.get(ri, slot));
            let mut built = stored.is_none();
            let (lo, hi) = match stored {
                Some(span) => span,
                None => fill_template(reader, query, route, trip, first, last, &mut template)?,
            };
            let ready = covered.start - hi;
            let deadline = covered.end - 1 - lo;
            let dates = time::candidate_dates(
                reader,
                origin_unix
                    .checked_add(ready)
                    .ok_or(EngineError::TimeOverflow)?,
                origin_unix
                    .checked_add(deadline)
                    .ok_or(EngineError::TimeOverflow)?,
                v2.min_event_secs,
                v2.max_event_secs,
            )?;
            visit_instances(
                reader,
                v2,
                trip,
                first,
                dates,
                origin_unix,
                ready,
                deadline,
                true,
                |c| -> Result<(), TransferIndexError> {
                    if !built {
                        let span =
                            fill_template(reader, query, route, trip, first, last, &mut template)?;
                        debug_assert_eq!(Some(span), stored);
                        built = true;
                    }
                    let base = time::origin(reader, c.inst.date as usize)?
                        .checked_sub(origin_unix)
                        .and_then(|t| t.checked_add(c.inst.shift))
                        .ok_or(EngineError::TimeOverflow)?;
                    for &(position, arrival, departure, template_flags) in &template {
                        let arrival = base.checked_add(arrival).ok_or(EngineError::TimeOverflow)?;
                        let departure = base
                            .checked_add(departure)
                            .ok_or(EngineError::TimeOverflow)?;
                        let mut flags = template_flags & (BOARD | ALIGHT | START);
                        if template_flags & SOURCE != 0 && covered.contains(&arrival) {
                            flags |= SOURCE;
                        }
                        if template_flags & (BOARD | START) != 0 && covered.contains(&departure) {
                            flags |= TARGET;
                        }
                        if flags & (SOURCE | TARGET) == 0 {
                            continue;
                        }
                        if c.approximate {
                            flags |= APPROXIMATE;
                        }
                        if events.len() >= limits.max_events {
                            return Err(TransferIndexError::EventsExhausted {
                                limit: limits.max_events,
                                attempted: events.len() + 1,
                            });
                        }
                        reserve(events, events.len() + 1, 0, limits, peak)?;
                        events.push(StopEvent {
                            frequency_offset_secs: c.inst.shift,
                            arrival_secs: arrival,
                            departure_secs: departure,
                            route_idx: ri as u32,
                            trip_idx: c.inst.trip,
                            date_ordinal: c.inst.date,
                            position,
                            flags,
                        });
                    }
                    Ok(())
                },
            )?;
        }
    }
    Ok(())
}

/// Records each boarding the reference would expand, without riding it.
struct Collect<'a> {
    out: &'a mut Vec<Boarding>,
    edges: usize,
    others: usize,
    limits: TransferIndexLimits,
    peak: &'a mut usize,
}

impl Strategy for Collect<'_> {
    type Error = TransferIndexError;

    fn before_board(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }

    fn accept(&mut self, _: &State, _: &[State], _: usize) -> Result<bool, Self::Error> {
        Ok(false)
    }

    fn observe_board(&mut self, _: &State, boarding: &Boarding) -> Result<bool, Self::Error> {
        let attempted = self.edges + self.out.len() + 1;
        if attempted > self.limits.max_edges {
            return Err(TransferIndexError::EdgesExhausted {
                limit: self.limits.max_edges,
                attempted,
            });
        }
        reserve(
            self.out,
            self.out.len() + 1,
            self.others,
            self.limits,
            self.peak,
        )?;
        self.out.push(*boarding);
        Ok(false)
    }
}

/// Grow `v` to `need` items, doubling while the build stays within
/// `max_bytes` and falling back to the exact need. `others` is the capacity in
/// bytes of the other live build buffers.
fn reserve<T>(
    v: &mut Vec<T>,
    need: usize,
    others: usize,
    limits: TransferIndexLimits,
    peak: &mut usize,
) -> Result<(), TransferIndexError> {
    if need <= v.capacity() {
        return Ok(());
    }
    let capacity = grown_capacity(v.capacity(), need, size_of::<T>(), others, limits)?;
    v.reserve_exact(capacity - v.len());
    *peak = (*peak).max(others + v.capacity() * size_of::<T>());
    Ok(())
}

/// The capacity `reserve` grows a buffer of `size`-byte items to, from
/// `capacity` to hold `need`, or its error. Shared so a sliced catalogue can
/// replay the fresh build's peak exactly.
fn grown_capacity(
    capacity: usize,
    need: usize,
    size: usize,
    others: usize,
    limits: TransferIndexLimits,
) -> Result<usize, TransferIndexError> {
    let total = |capacity: usize| {
        capacity
            .checked_mul(size)
            .and_then(|b| b.checked_add(others))
    };
    let doubled = capacity.saturating_mul(2).max(need).max(16);
    let capacity = match total(doubled) {
        Some(b) if b <= limits.max_bytes => doubled,
        _ => need,
    };
    let attempted = total(capacity).unwrap_or(usize::MAX);
    if attempted > limits.max_bytes {
        return Err(TransferIndexError::BytesExhausted {
            limit: limits.max_bytes,
            attempted,
        });
    }
    Ok(capacity)
}

fn bytes_of<T>(v: &Vec<T>) -> usize {
    v.capacity() * size_of::<T>()
}

fn len_bytes<T>(v: &[T]) -> usize {
    core::mem::size_of_val(v)
}

fn binding<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    transfers: Option<&Transfers>,
    config: &TransferIndexConfig,
) -> TransferIndexBinding {
    binding_with_phases(reader, index, transfers, config, &mut |_| {})
}

fn binding_with_phases<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    transfers: Option<&Transfers>,
    config: &TransferIndexConfig,
    observe: &mut impl FnMut(DeadlineSetupPhase),
) -> TransferIndexBinding {
    let binding =
        immutable_binding_with_phases(reader, index, transfers, observe).with_config(config);
    observe(DeadlineSetupPhase::BindingComputed);
    binding
}

fn immutable_binding_with_phases<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    transfers: Option<&Transfers>,
    observe: &mut impl FnMut(DeadlineSetupPhase),
) -> ImmutableBinding {
    let ptb_sha256 = Sha256::digest(reader.bytes_view().unwrap_or(&[])).into();
    observe(DeadlineSetupPhase::PtbHashed);
    let ptft_sha256 = transfers.map(|t| {
        let mut h = Sha256::new();
        h.update((t.stop_count() as u64).to_le_bytes());
        for i in 0..t.stop_count() as u32 {
            let id = t.stop_id(i).as_bytes();
            h.update((id.len() as u64).to_le_bytes());
            h.update(id);
            let (neighbors, walks) = t.edges(i);
            h.update((neighbors.len() as u64).to_le_bytes());
            for (&n, &w) in neighbors.iter().zip(walks) {
                h.update(n.to_le_bytes());
                h.update(w.to_le_bytes());
            }
        }
        h.finalize().into()
    });
    observe(DeadlineSetupPhase::TransfersHashed);
    let mut h = Sha256::new();
    h.update(b"ptn/trip-transfer-layout/v2\0");
    h.update((index.routes.len() as u64).to_le_bytes());
    for route in &index.routes {
        h.update(route.route_idx.to_le_bytes());
        h.update(route.reader_route_idx.to_le_bytes());
        h.update((route.stop_ids.len() as u64).to_le_bytes());
        for &stop in &route.stop_ids {
            h.update(stop.to_le_bytes());
        }
        h.update((route.trips.len() as u64).to_le_bytes());
        for trip in &route.trips {
            h.update(trip.trip_idx.to_le_bytes());
            // Route/trip order alone does not identify occurrence positions:
            // Off cursor alignment and a CoveringMerge fold can have identical
            // orders but place a short lasso trip at different occurrences.
            h.update((trip.pos_to_row.len() as u64).to_le_bytes());
            for &row in &trip.pos_to_row {
                h.update(row.to_le_bytes());
            }
            if let Some(band) = trip.band {
                h.update([1]);
                h.update(band.offset.to_le_bytes());
                h.update(band.local_t.to_le_bytes());
                for value in [
                    band.slab.slab_off,
                    band.slab.big_t,
                    band.slab.s,
                    band.slab.dep_off,
                    band.slab.dwell_off,
                    band.slab.served_off,
                    band.slab.delta_bytes,
                ] {
                    h.update((value as u64).to_le_bytes());
                }
                h.update(
                    band.semantics_base
                        .map_or(u64::MAX, |offset| offset as u64)
                        .to_le_bytes(),
                );
            } else {
                h.update([0]);
            }
        }
    }
    let layout_sha256 = h.finalize().into();
    observe(DeadlineSetupPhase::LayoutHashed);
    ImmutableBinding {
        ptb_sha256,
        ptft_sha256,
        layout_sha256,
    }
}

// Shared with the owned session's single-catalogue key. Preserve the binding's
// exact normalization and encoding; no second dependency list is maintained.
fn configuration_digest(config: &TransferIndexConfig) -> [u8; 32] {
    let mut families: Vec<u8> = config
        .excluded_modes
        .iter()
        .map(|&r| crate::engine::mode::route_type_to_mode(r) as u8)
        .collect();
    families.sort_unstable();
    families.dedup();
    let mut h = Sha256::new();
    h.update(config.service_date.to_le_bytes());
    h.update(config.covered.start.to_le_bytes());
    h.update(config.covered.end.to_le_bytes());
    h.update([match config.mobility {
        Mobility::Default => 0u8,
        Mobility::Wheelchair => 1,
        Mobility::Bicycle => 2,
    }]);
    h.update((families.len() as u64).to_le_bytes());
    h.update(&families);
    // Appended only off the defaults, so a default key keeps its encoding.
    let (speed, floor) = config.walk_settings();
    let default_speed = match config.mobility {
        Mobility::Wheelchair => WHEELCHAIR_WALK_SPEED_MM_S,
        _ => DEFAULT_WALK_SPEED_MM_S,
    };
    if (speed, floor) != (default_speed, RAPTOR_MIN_TRANSFER_SECS) {
        h.update([0xff]);
        h.update(speed.to_le_bytes());
        h.update(floor.to_le_bytes());
    }
    if !config.excluded_routes.is_empty() {
        let mut routes = config.excluded_routes.clone();
        routes.sort_unstable();
        routes.dedup();
        h.update(b"excluded-routes");
        h.update((routes.len() as u64).to_le_bytes());
        for route in routes {
            h.update(route.to_le_bytes());
        }
    }
    h.finalize().into()
}

#[cfg(test)]
mod route_filter_binding_tests {
    use super::*;

    #[test]
    fn route_filter_changes_invalidate_catalogue_binding() {
        let mut config = TransferIndexConfig::new(20261004, 900..1300);
        let unfiltered = configuration_digest(&config);
        config.excluded_routes = alloc::vec![2, 1, 2];
        let filtered = configuration_digest(&config);
        assert_ne!(unfiltered, filtered);
        config.excluded_routes = alloc::vec![1, 2];
        assert_eq!(filtered, configuration_digest(&config));
        config.excluded_routes.clear();
        assert_eq!(unfiltered, configuration_digest(&config));
    }
}
