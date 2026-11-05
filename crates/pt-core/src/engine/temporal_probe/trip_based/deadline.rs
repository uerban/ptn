//! Exact deadline-constrained R3/M4 reference over concrete ride suffixes.
//! This is not a complete unconstrained profile or a few-option ranking policy.
//! Incoming edges are either the unreduced graph or exact lazy lookup. Reverse
//! labels keep actual arrival and the latest horizon-controlled suffix time;
//! the caller's egress walking is not incorrectly clipped at origin + 48h.
//! GTFS: https://gtfs.org/documentation/schedule/reference/#transferstxt

use super::date_memo::WitnessDateMemo;
use super::frontier::Frontiers;
use super::optimistic::OptimisticBounds;
use super::portfolio::{PortfolioTracker, WinnerGoal};
use super::prefix::{CachedPrefix, PrefixBound, PrefixStorage};
use super::*;
use crate::engine::consts::RAPTOR_MAX_ROUNDS;
use crate::engine::temporal_probe::r3::{ProfileObjectives, R3Point};
use crate::engine::temporal_probe::v2::{insert_point, physical_walks};
use alloc::collections::{BTreeMap, BinaryHeap, VecDeque};
use core::cmp::{Ordering, Reverse};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeadlinePruning {
    None,
    EarliestPrefix,
    EarliestPrefixAndPoints,
    /// Native experiment: also retain timetable-compatible origin profiles.
    EarliestPrefixAndTimetablePoints,
}

/// Representation-only ablation. All modes retain the identical canonical
/// witness ordering; the production planner does not use this experiment.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum DeadlineWitnessComparison {
    #[default]
    Materialized,
    /// Same vectors and comparison, with exact search-local date projection.
    MaterializedDateMemo,
    Streaming,
}
impl DeadlineWitnessComparison {
    pub fn name(self) -> &'static str {
        match self {
            Self::Materialized => "materialized",
            Self::MaterializedDateMemo => "materialized-date-memo",
            Self::Streaming => "streaming",
        }
    }

    /// Fixed stack scratch reserved by every experimental search, including
    /// the uncached baseline. Not heap bytes, live memory or browser RSS.
    pub const fn date_memo_stack_bytes() -> usize {
        core::mem::size_of::<WitnessDateMemo>()
    }
}

/// Scheduling ablation only: no order discards an eligible suffix.
/// Earlier-arrival suffixes may discover legal incumbent points sooner. Equal
/// objective witnesses still pass the existing strict pruning certificate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeadlineTraversal {
    Fifo,
    ArrivalFirst,
    Guided,
    /// Scheduling only: prefer later possible boarding boundaries. No queue
    /// early exit or new pruning rule. Concrete occurrences stay distinct:
    /// https://gtfs.org/documentation/schedule/schedule-best-practices/#loop-routes
    /// https://gtfs.org/documentation/schedule/reference/#stop_timestxt
    DepartureFirst,
    /// Native experiment: 64 active departure-first scans, then the ordinary
    /// arrival-first order. No work/cap reset, omitted suffix or early stop.
    /// A concrete occurrence, not a stop ID, supplies the scheduling hint:
    /// https://gtfs.org/documentation/schedule/schedule-best-practices/#loop-routes
    DepartureWarmup64,
    /// Native scheduling experiment: prefer origin-reachable earlier boarding
    /// occurrences, then restore arrival-first after one legal point or 64
    /// active scans. The relaxed prefix is never transfer permission.
    /// https://gtfs.org/documentation/schedule/reference/#stop_timestxt
    OriginPrefixWarmup,
}

type ArrivalPriority = Reverse<(i64, u32, u64, u32, usize)>;
type GuidedPriority = Reverse<(Reverse<i64>, i64, u32, u64, u32, usize)>;

enum Queue {
    Fifo(VecDeque<usize>),
    ArrivalFirst(BinaryHeap<ArrivalPriority>),
    Guided(BinaryHeap<GuidedPriority>),
}
impl Queue {
    fn new(order: DeadlineTraversal) -> Self {
        match order {
            DeadlineTraversal::Fifo => Self::Fifo(VecDeque::new()),
            DeadlineTraversal::ArrivalFirst => Self::ArrivalFirst(BinaryHeap::new()),
            DeadlineTraversal::Guided
            | DeadlineTraversal::DepartureFirst
            | DeadlineTraversal::DepartureWarmup64
            | DeadlineTraversal::OriginPrefixWarmup => Self::Guided(BinaryHeap::new()),
        }
    }
    // The priority can be an uncertified scheduling hint, depending on mode.
    fn push(&mut self, id: usize, suffix: &Suffix, departure_priority: Option<i64>) {
        match self {
            Self::Fifo(q) => q.push_back(id),
            Self::ArrivalFirst(q) => q.push(Reverse((
                suffix.arrival,
                suffix.transfers,
                suffix.walk,
                suffix.rounds,
                id,
            ))),
            Self::Guided(q) => q.push(Reverse((
                Reverse(departure_priority.unwrap_or(i64::MIN)),
                suffix.arrival,
                suffix.transfers,
                suffix.walk,
                suffix.rounds,
                id,
            ))),
        }
    }
    fn pop(&mut self) -> Option<usize> {
        match self {
            Self::Fifo(q) => q.pop_front(),
            Self::ArrivalFirst(q) => q.pop().map(|Reverse((_, _, _, _, id))| id),
            Self::Guided(q) => q.pop().map(|Reverse((_, _, _, _, _, id))| id),
        }
    }

    // Preserve every pending active ID. Ancestors stay in the search arena;
    // inactive IDs were already skipped by the ordinary traversal loop.
    fn restore_arrival_first(self, segments: &[Suffix]) -> (Self, usize, usize, usize) {
        let Self::Guided(q) = self else {
            unreachable!("departure warmup owns a guided queue")
        };
        let pending = q.len();
        let mut keys = Vec::with_capacity(pending);
        for Reverse((_, _, _, _, _, id)) in q {
            let suffix = &segments[id];
            if suffix.active {
                keys.push(Reverse((
                    suffix.arrival,
                    suffix.transfers,
                    suffix.walk,
                    suffix.rounds,
                    id,
                )));
            }
        }
        let live = keys.len();
        // New buffer coexists with the old guided heap during migration.
        // This is additional capacity, not total queue or process memory.
        let scratch = keys.capacity() * core::mem::size_of::<ArrivalPriority>();
        (
            Self::ArrivalFirst(BinaryHeap::from(keys)),
            pending,
            live,
            scratch,
        )
    }
}

// The immediately preceding catalogue occurrence can be non-boardable. This
// is merely a cheap ordering hint, never permission to board or a certificate.
// Keep date/frequency identity and signed timeline times; do not infer a stop
// position from a stop ID (loop/lasso stops may repeat).
fn departure_hint(events: &[StopEvent], alight: u32) -> i64 {
    let end = events[alight as usize];
    (alight as usize)
        .checked_sub(1)
        .and_then(|i| events.get(i))
        .filter(|&&before| same_vehicle(before, end))
        .map_or(end.arrival_secs, |before| before.departure_secs)
}

// Only for a checked nonempty departure window and monotone catalogue. Keeping
// clipping here prevents the scheduling-only priority from becoming a looser
// substitute for the completion bound in long-gap deadline queries.
fn suffix_departure_upper(events: &[StopEvent], alight: u32, window_end: i64) -> i64 {
    departure_hint(events, alight).min(window_end - 1)
}

#[derive(Clone, Copy)]
pub enum DeadlineLookup<'a> {
    Graph(&'a TransferIndex),
    Lazy(LazyLookupMode),
}

#[derive(Clone)]
pub struct DeadlineRequest<'a> {
    pub query: &'a Query,
    pub window: Range<i64>,
    pub arrival_deadline: i64,
    pub transfers: Option<&'a Transfers>,
    pub objectives: ProfileObjectives,
    pub lookup: DeadlineLookup<'a>,
    pub pruning: DeadlinePruning,
    pub traversal: DeadlineTraversal,
    pub witness_comparison: DeadlineWitnessComparison,
    pub frontier_storage: DeadlineFrontierStorage,
    pub static_bound: bool,
    pub walking_bound: bool,
    /// Opt-in derived-aware, time-relaxed passenger-transfer prefix.
    pub transfer_bound: bool,
    pub forward_seeds: bool,
    /// Removed experiment: true is rejected with InvalidRequest.
    pub raptor_seeds: bool,
    /// Removed experiment: true is rejected with InvalidRequest.
    pub raptor_destination_ordering: bool,
    pub max_segments: usize,
    pub max_frontier_width: usize,
    pub max_stop_scans: usize,
    pub max_lookup_work: usize,
}

impl<'a> DeadlineRequest<'a> {
    pub fn new(query: &'a Query, window: Range<i64>, arrival_deadline: i64) -> Self {
        Self {
            query,
            window,
            arrival_deadline,
            transfers: None,
            objectives: ProfileObjectives::M4,
            lookup: DeadlineLookup::Lazy(LazyLookupMode::PlainFast),
            pruning: DeadlinePruning::None,
            traversal: DeadlineTraversal::Fifo,
            witness_comparison: DeadlineWitnessComparison::Materialized,
            frontier_storage: DeadlineFrontierStorage::Tree,
            static_bound: false,
            walking_bound: false,
            transfer_bound: false,
            forward_seeds: false,
            raptor_seeds: false,
            raptor_destination_ordering: false,
            max_segments: 250_000,
            max_frontier_width: 64,
            max_stop_scans: 10_000_000,
            max_lookup_work: 10_000_000,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeadlineError {
    Engine(EngineError),
    Lookup(LazyLookupError),
    BindingMismatch,
    InvalidRequest(&'static str),
    IncompleteCoverage {
        required: Range<i64>,
        covered: Range<i64>,
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
    OptimisticEdgesExhausted {
        limit: usize,
        attempted: usize,
    },
}
impl From<EngineError> for DeadlineError {
    fn from(e: EngineError) -> Self {
        Self::Engine(e)
    }
}
impl From<LazyLookupError> for DeadlineError {
    fn from(e: LazyLookupError) -> Self {
        Self::Lookup(e)
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DeadlineWarmupDiagnostics {
    pub preferred_scans: usize,
    pub restored: bool,
    pub points_at_restore: usize,
    pub pending_at_restore: usize,
    pub live_requeued: usize,
    pub additional_queue_capacity_bytes: usize,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DeadlineDiagnostics {
    pub seed_event_checks: usize,
    pub segments_enqueued: usize,
    pub segments_scanned: usize,
    pub dominated_segments: usize,
    pub stop_events_scanned: usize,
    pub max_frontier_width: usize,
    pub arena_bytes: usize,
    pub incoming_index_bytes: usize,
    pub graph_edges_prepared: usize,
    pub graph_edges_scanned: usize,
    pub lazy: LazyLookupDiagnostics,
    pub prefix: PrefixDiagnostics,
    pub optimistic: OptimisticDiagnostics,
    pub forward: ForwardSeedDiagnostics,
    pub raptor: RaptorSeedDiagnostics,
    pub warmup: DeadlineWarmupDiagnostics,
    /// Native origin-prefix scheduling only. Checks are also included in
    /// seed_event_checks, hence in the original aggregate stop-work limit.
    pub origin_hint: OriginHintDiagnostics,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct OriginHintDiagnostics {
    pub enabled: bool,
    pub checks: usize,
    /// Peak logical hint bytes, excluding allocator/queue/arena overhead.
    pub index_bytes: usize,
}

#[derive(Debug)]
pub struct DeadlineResult {
    pub points: Vec<R3Point>,
    pub window: Range<i64>,
    pub arrival_deadline: i64,
    /// Only the supplied window with this deadline and objectives is exhausted.
    pub complete: bool,
    pub diagnostics: DeadlineDiagnostics,
    /// Representation accounting, separate from unchanged routing diagnostics.
    pub frontiers: DeadlineFrontierStats,
}

/// Timing boundaries for the native harness; the engine itself has no clock.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeadlinePhase {
    /// Binding, monotonicity, access and incoming-index setup are complete.
    Prepared,
    /// Seeding, traversal, witness construction, sorting and counters are done.
    SearchFinished,
}

struct GraphIncoming<'a> {
    table: &'a TransferIndex,
    offsets: Vec<u32>,
    order: Vec<(u32, u32)>, // source event, original edge ordinal
    scanned: usize,
    source_bound_skips: usize,
    limit: usize,
    consumed: usize,
}

impl<'a> GraphIncoming<'a> {
    fn new(table: &'a TransferIndex, limit: usize, consumed: usize) -> Result<Self, DeadlineError> {
        let prepared = table
            .edges
            .len()
            .checked_add(consumed)
            .ok_or(EngineError::TimeOverflow)?;
        if prepared > limit {
            return Err(LazyLookupError::WorkExhausted {
                limit,
                attempted: prepared,
            }
            .into());
        }
        let mut order = Vec::with_capacity(table.edges.len());
        for source in 0..table.events.len() {
            for edge in table.offsets[source]..table.offsets[source + 1] {
                order.push((source as u32, edge));
            }
        }
        order.sort_unstable_by_key(|&(s, e)| (table.edges[e as usize].target, s, e));
        let mut offsets = alloc::vec![0u32; table.events.len() + 1];
        for &(_, edge) in &order {
            offsets[table.edges[edge as usize].target as usize + 1] += 1;
        }
        for i in 1..offsets.len() {
            offsets[i] += offsets[i - 1];
        }
        Ok(Self {
            table,
            offsets,
            order,
            scanned: 0,
            source_bound_skips: 0,
            limit,
            consumed,
        })
    }

    fn incoming(
        &mut self,
        target: u32,
        index: &Index,
        earliest: Option<&[i64]>,
    ) -> Result<Vec<IncomingTransfer>, DeadlineError> {
        let rows = &self.order
            [self.offsets[target as usize] as usize..self.offsets[target as usize + 1] as usize];
        let attempted = self
            .scanned
            .checked_add(rows.len())
            .ok_or(EngineError::TimeOverflow)?;
        let total = attempted
            .checked_add(self.consumed)
            .ok_or(EngineError::TimeOverflow)?;
        if total > self.limit {
            return Err(LazyLookupError::WorkExhausted {
                limit: self.limit,
                attempted: total,
            }
            .into());
        }
        self.scanned = attempted;
        let table = self.table;
        let skipped = &mut self.source_bound_skips;
        Ok(rows
            .iter()
            .filter(|&&(source, _)| {
                let e = table.events[source as usize];
                let stop = index.routes[e.route_idx as usize].stop_ids[e.position as usize];
                let keep = earliest.is_none_or(|bounds| e.arrival_secs >= bounds[stop as usize]);
                if !keep {
                    *skipped += 1;
                }
                keep
            })
            .map(|&(source, e)| {
                let edge = self.table.edges[e as usize];
                IncomingTransfer {
                    source,
                    walk_secs: edge.walk_secs,
                    elapsed_secs: edge.elapsed_secs,
                    kind: edge.kind,
                }
            })
            .collect())
    }
}

// Only one provider exists per query; boxing it would add a heap allocation
// to every uncached baseline solely to reduce this single enum's stack size.
#[allow(clippy::large_enum_variant)]
enum Provider<'a, B: AsRef<[u8]>> {
    Graph(GraphIncoming<'a>),
    Lazy(LazyPredecessors<'a, B>),
}
impl<B: AsRef<[u8]> + Send + Sync + 'static> Provider<'_, B> {
    fn incoming(
        &mut self,
        target: u32,
        index: &Index,
        earliest: Option<&[i64]>,
    ) -> Result<Vec<IncomingTransfer>, DeadlineError> {
        match self {
            Self::Graph(g) => g.incoming(target, index, earliest),
            Self::Lazy(l) => Ok(l.incoming_bounded(target, earliest)?),
        }
    }
}

#[derive(Clone, Copy)]
struct Suffix {
    alight: u32,
    next: Option<(usize, u32, TransferKind)>,
    walk: u64,
    transfers: u32,
    rounds: u32,
    arrival: i64,
    horizon_latest: i64,
    active: bool,
}

#[derive(Clone, Copy)]
struct WitnessLeg {
    start: StopEvent,
    alight_position: u32,
    alight_secs: i64,
    reader_route_idx: u32,
    in_seat: bool,
}
impl WitnessLeg {
    fn with_date(self, service_date: u32) -> R3TransitWitness {
        R3TransitWitness {
            service_date,
            route_idx: self.start.route_idx,
            reader_route_idx: self.reader_route_idx,
            trip_idx: self.start.trip_idx,
            board_position: self.start.position,
            alight_position: self.alight_position,
            board_secs: self.start.departure_secs,
            alight_secs: self.alight_secs,
            frequency_offset_secs: self.start.frequency_offset_secs,
            frequency_instance: self.start.approximate(),
            in_seat: self.in_seat,
        }
    }
}

// Lexicographic Vec<R3TransitWitness> ordering without allocating the vectors.
// service_date is the first derived-Ord field. Only identical ordinals bypass
// calendar conversion; unequal ordinals use the exact existing conversion.
// No date, frequency instance, loop position or in-seat provenance is merged.
// GTFS: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
fn compare_witnesses(
    mut a: impl Iterator<Item = WitnessLeg>,
    mut b: impl Iterator<Item = WitnessLeg>,
    mut service_date: impl FnMut(u32) -> u32,
) -> Ordering {
    loop {
        let (a, b) = match (a.next(), b.next()) {
            (Some(a), Some(b)) => (a, b),
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
        };
        let dates = if a.start.date_ordinal == b.start.date_ordinal {
            Ordering::Equal
        } else {
            service_date(a.start.date_ordinal).cmp(&service_date(b.start.date_ordinal))
        };
        // Equal dummy dates preserve the derived ordering of every remaining
        // field. A new witness field must be handled in with_date as well.
        let order = dates.then_with(|| a.with_date(0).cmp(&b.with_date(0)));
        if order != Ordering::Equal {
            return order;
        }
    }
}

struct Search<'a, B: AsRef<[u8]>, const WINNERS: bool> {
    reader: &'a Reader<B>,
    index: &'a Index,
    events: &'a [StopEvent],
    request: DeadlineRequest<'a>,
    provider: Provider<'a, B>,
    prefix: Option<PrefixStorage<'a>>,
    optimistic: Option<OptimisticBounds>,
    segments: Vec<Suffix>,
    queue: Queue,
    origin_hints: Option<Vec<u8>>,
    frontiers: Frontiers,
    entries: BTreeMap<u32, Vec<u32>>,
    points: Vec<R3Point>,
    seed_points: Vec<R3Point>,
    diagnostics: DeadlineDiagnostics,
    portfolio: PortfolioTracker,
    suffix_pruning: DeadlineSuffixPruning,
    date_memo: WitnessDateMemo,
}

pub(super) fn same_vehicle(a: StopEvent, b: StopEvent) -> bool {
    (a.trip_idx, a.date_ordinal, a.frequency_offset_secs)
        == (b.trip_idx, b.date_ordinal, b.frequency_offset_secs)
}

impl<B: AsRef<[u8]> + Send + Sync + 'static, const WINNERS: bool> Search<'_, B, WINNERS> {
    fn witness(&self, suffix: &Suffix, board: u32) -> Vec<R3TransitWitness> {
        let (mut suffix, mut board, mut in_seat) = (*suffix, board, false);
        let mut out = Vec::new();
        loop {
            let start = self.events[board as usize];
            let end = self.events[suffix.alight as usize];
            let route = &self.index.routes[start.route_idx as usize];
            out.push(R3TransitWitness {
                service_date: if self.request.witness_comparison
                    == DeadlineWitnessComparison::MaterializedDateMemo
                {
                    self.date_memo
                        .date(self.reader.feed_start_date(), start.date_ordinal)
                } else {
                    crate::reader::days_add(
                        self.reader.feed_start_date(),
                        start.date_ordinal as i64,
                    )
                },
                route_idx: start.route_idx,
                reader_route_idx: route.reader_route_idx,
                trip_idx: start.trip_idx,
                board_position: start.position,
                alight_position: end.position,
                board_secs: start.departure_secs,
                alight_secs: end.arrival_secs,
                frequency_offset_secs: start.frequency_offset_secs,
                frequency_instance: start.approximate(),
                in_seat,
            });
            let Some((next, next_board, kind)) = suffix.next else {
                break;
            };
            suffix = self.segments[next];
            board = next_board;
            in_seat = !kind.spends_transfer();
        }
        out
    }

    fn witness_legs(&self, suffix: Suffix, board: u32) -> impl Iterator<Item = WitnessLeg> + '_ {
        let mut cursor = Some((suffix, board, false));
        core::iter::from_fn(move || {
            let (suffix, board, in_seat) = cursor?;
            let start = self.events[board as usize];
            let end = self.events[suffix.alight as usize];
            let leg = WitnessLeg {
                start,
                alight_position: end.position,
                alight_secs: end.arrival_secs,
                reader_route_idx: self.index.routes[start.route_idx as usize].reader_route_idx,
                in_seat,
            };
            cursor = suffix.next.map(|(next, next_board, kind)| {
                (self.segments[next], next_board, !kind.spends_transfer())
            });
            Some(leg)
        })
    }

    // At the same alighting event, all possible prefixes see the same current
    // vehicle and occurrence. Every kept suffix is already a legal transition
    // chain. Earlier arrival and smaller horizon requirement are distinct.
    fn covers(&self, a: &Suffix, b: &Suffix) -> bool {
        if a.arrival > b.arrival
            || a.horizon_latest > b.horizon_latest
            || a.walk > b.walk
            || a.transfers > b.transfers
            || a.rounds > b.rounds
        {
            return false;
        }
        if a.arrival < b.arrival || a.walk < b.walk || a.transfers < b.transfers {
            return true;
        }
        a.rounds == b.rounds
            && match self.request.witness_comparison {
                DeadlineWitnessComparison::Materialized
                | DeadlineWitnessComparison::MaterializedDateMemo => {
                    self.witness(a, a.alight) <= self.witness(b, b.alight)
                }
                DeadlineWitnessComparison::Streaming => {
                    compare_witnesses(
                        self.witness_legs(*a, a.alight),
                        self.witness_legs(*b, b.alight),
                        |ordinal| {
                            crate::reader::days_add(self.reader.feed_start_date(), ordinal as i64)
                        },
                    ) != Ordering::Greater
                }
            }
    }

    fn enqueue(&mut self, suffix: Suffix) -> Result<(), DeadlineError> {
        // The checked catalogue has monotone vehicle times. Every boarding
        // scanned here precedes this alight occurrence on the same concrete
        // trip/date/frequency instance. Prefix/access time cannot be negative,
        // including linked/block transitions. Suffix costs cannot be removed.
        // Unlike the scheduling hint, this bound is clipped to the departure
        // window. Strict numeric rank preserves all canonical witness ties.
        // GTFS: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
        // https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
        if WINNERS && self.suffix_pruning != DeadlineSuffixPruning::Off {
            let latest =
                suffix_departure_upper(self.events, suffix.alight, self.request.window.end);
            if self.portfolio.certifies_suffix(
                latest,
                suffix.arrival,
                suffix.transfers,
                suffix.walk,
            ) {
                return Ok(());
            }
        }
        let mut origin_upper = None;
        if let Some(bounds) = &self.optimistic {
            let end = self.events[suffix.alight as usize];
            let stop = self.index.routes[end.route_idx as usize].stop_ids[end.position as usize];
            origin_upper = bounds.latest_origin(stop, end.arrival_secs)?;
            if origin_upper.is_none_or(|at| at < self.request.window.start) {
                self.diagnostics.optimistic.origin_pruned_segments += 1;
                return Ok(());
            }
            if !bounds.can_reach(stop, end.arrival_secs, self.request.arrival_deadline)? {
                self.diagnostics.optimistic.destination_pruned_segments += 1;
                return Ok(());
            }
            origin_upper = origin_upper.map(|at| at.min(self.request.window.end - 1));
        }
        if self
            .frontiers
            .get(&suffix.alight)
            .is_some_and(|f| f.iter().any(|&i| self.covers(&self.segments[i], &suffix)))
        {
            self.diagnostics.dominated_segments += 1;
            return Ok(());
        }
        let removed: Vec<_> = self
            .frontiers
            .get(&suffix.alight)
            .into_iter()
            .flatten()
            .copied()
            .filter(|&i| self.covers(&suffix, &self.segments[i]))
            .collect();
        let width = self.frontiers.get(&suffix.alight).map_or(0, Vec::len) - removed.len() + 1;
        if width > self.request.max_frontier_width {
            return Err(DeadlineError::FrontierExhausted {
                limit: self.request.max_frontier_width,
                attempted: width,
            });
        }
        let attempted = self
            .segments
            .len()
            .checked_add(self.diagnostics.forward.accepted_states)
            .and_then(|n| n.checked_add(1))
            .ok_or(EngineError::TimeOverflow)?;
        if attempted > self.request.max_segments {
            return Err(DeadlineError::SegmentsExhausted {
                limit: self.request.max_segments,
                attempted,
            });
        }
        for &i in &removed {
            self.segments[i].active = false;
        }
        let frontier = self.frontiers.get_or_default(suffix.alight);
        frontier.retain(|i| !removed.contains(i));
        let id = self.segments.len();
        frontier.push(id);
        let priority = if matches!(
            self.request.traversal,
            DeadlineTraversal::DepartureFirst | DeadlineTraversal::DepartureWarmup64
        ) {
            Some(departure_hint(self.events, suffix.alight))
        } else if self.request.traversal == DeadlineTraversal::OriginPrefixWarmup {
            self.origin_hints
                .as_ref()
                .map(|hints| -i64::from(hints[suffix.alight as usize]))
        } else {
            origin_upper
        };
        self.queue.push(id, &suffix, priority);
        self.segments.push(suffix);
        self.diagnostics.segments_enqueued += 1;
        self.diagnostics.max_frontier_width = self.diagnostics.max_frontier_width.max(width);
        Ok(())
    }

    fn charge_stop(&mut self, seed: bool) -> Result<(), DeadlineError> {
        let attempted = self
            .diagnostics
            .seed_event_checks
            .checked_add(self.diagnostics.stop_events_scanned)
            .and_then(|n| n.checked_add(self.diagnostics.prefix.work()))
            .and_then(|n| n.checked_add(self.diagnostics.optimistic.work()))
            .and_then(|n| n.checked_add(self.diagnostics.forward.stop_work()))
            .and_then(|n| n.checked_add(1))
            .ok_or(EngineError::TimeOverflow)?;
        if attempted > self.request.max_stop_scans {
            return Err(DeadlineError::StopScansExhausted {
                limit: self.request.max_stop_scans,
                attempted,
            });
        }
        if seed {
            self.diagnostics.seed_event_checks += 1;
        } else {
            self.diagnostics.stop_events_scanned += 1;
        }
        Ok(())
    }

    fn seed(&mut self) -> Result<(), DeadlineError> {
        if self.request.query.max_rounds == Some(0) {
            return Ok(());
        }
        if self.request.query.max_rounds == Some(0) {
            return Ok(());
        }
        let mut exits: BTreeMap<u32, u32> = BTreeMap::new();
        for exit in &self.request.query.exit_stops {
            if !inaccessible(self.reader, self.request.query, exit.stop)? {
                exits
                    .entry(exit.stop)
                    .and_modify(|w| *w = (*w).min(exit.walk_secs))
                    .or_insert(exit.walk_secs);
            }
        }
        let mut movements: BTreeMap<u32, Vec<(u32, i64)>> = BTreeMap::new();
        let mut prefix_rides = u8::MAX;
        for e in 0..self.events.len() {
            self.charge_stop(true)?;
            let event = self.events[e];
            if self.origin_hints.is_some() {
                if e == 0 || !same_vehicle(self.events[e - 1], event) {
                    prefix_rides = u8::MAX;
                }
                // Only earlier occurrences can board this suffix. Preserve
                // concrete vehicle boundaries, including date/frequency and
                // repeated stops: https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
                self.origin_hints.as_mut().unwrap()[e] = prefix_rides;
                if event.can_board() && prefix_rides > 0 {
                    let stop = self.index.routes[event.route_idx as usize].stop_ids
                        [event.position as usize];
                    let rounds = self.request.query.max_rounds.unwrap_or(RAPTOR_MAX_ROUNDS);
                    for r in 0..rounds.min(u32::from(prefix_rides)) {
                        self.charge_stop(true)?;
                        self.diagnostics.origin_hint.checks += 1;
                        if self
                            .prefix
                            .as_ref()
                            .unwrap()
                            .allows(r, stop, event.departure_secs)
                        {
                            prefix_rides = r as u8;
                            break;
                        }
                    }
                }
            }
            if !event.is_source() || !event.can_alight() {
                continue;
            }
            let stop =
                self.index.routes[event.route_idx as usize].stop_ids[event.position as usize];
            if let alloc::collections::btree_map::Entry::Vacant(entry) = movements.entry(stop) {
                let mut walk = physical_walks(
                    self.reader,
                    self.request.query,
                    self.request.transfers,
                    stop,
                )?;
                walk.push((stop, 0));
                entry.insert(walk);
            }
            let options: Vec<_> = movements[&stop]
                .iter()
                .filter_map(|&(to, physical)| exits.get(&to).map(|&caller| (physical, caller)))
                .collect();
            for (physical, caller) in options {
                let horizon_latest = event
                    .arrival_secs
                    .checked_add(physical)
                    .ok_or(EngineError::TimeOverflow)?;
                let arrival = horizon_latest
                    .checked_add(caller as i64)
                    .ok_or(EngineError::TimeOverflow)?;
                if arrival > self.request.arrival_deadline {
                    continue;
                }
                self.enqueue(Suffix {
                    alight: e as u32,
                    next: None,
                    walk: physical as u64 + caller as u64,
                    transfers: 0,
                    rounds: 1,
                    arrival,
                    horizon_latest,
                    active: true,
                })?;
            }
        }
        Ok(())
    }

    fn scan(&mut self, id: usize) -> Result<(), DeadlineError> {
        let suffix = self.segments[id];
        let end = self.events[suffix.alight as usize];
        self.diagnostics.segments_scanned += 1;
        let mut board_id = suffix.alight as usize;
        while board_id > 0 {
            board_id -= 1;
            let board = self.events[board_id];
            if !same_vehicle(board, end) {
                break;
            }
            self.charge_stop(false)?;
            if board.flags & TARGET == 0 {
                continue;
            }
            let horizon_latest = suffix.horizon_latest.max(board.departure_secs);
            let stop =
                self.index.routes[board.route_idx as usize].stop_ids[board.position as usize];
            let preceding =
                self.request.query.max_rounds.unwrap_or(RAPTOR_MAX_ROUNDS) - suffix.rounds;
            if self
                .prefix
                .as_ref()
                .is_some_and(|p| !p.allows(preceding, stop, board.departure_secs))
            {
                self.diagnostics.prefix.pruned_boardings += 1;
                continue;
            }
            if let Some(prefix) = &self.prefix {
                if let Some(latest) = prefix.latest_origin(preceding, stop, board.departure_secs)? {
                    let latest = latest.min(self.request.window.end - 1);
                    let prefix_rides =
                        prefix.minimum_transfers(preceding, stop, board.departure_secs);
                    let transfers = suffix
                        .transfers
                        .checked_add(prefix_rides)
                        .ok_or(EngineError::TimeOverflow)?;
                    let m4 = self.request.objectives == ProfileObjectives::M4;
                    let static_walking = self
                        .optimistic
                        .as_ref()
                        .and_then(|b| b.walking_prefix(stop))
                        .unwrap_or(0);
                    let layered_walking = prefix.minimum_walking(preceding, stop).unwrap_or(0);
                    // Independent lower bounds combine by max, never sum.
                    let walking_prefix = static_walking.max(layered_walking);
                    let static_walk_lower = suffix
                        .walk
                        .checked_add(static_walking)
                        .ok_or(EngineError::TimeOverflow)?;
                    let walk_lower = suffix
                        .walk
                        .checked_add(walking_prefix)
                        .ok_or(EngineError::TimeOverflow)?;
                    // All completions depart <= latest and add >= prefix_rides
                    // passenger transfers (zero with derived block
                    // continuations, which may follow in-seat) and >= the
                    // relaxed prefix walking (zero without static bounds).
                    // Explicit linked rules disable the prefix bound.
                    // Strict objective improvement only: equal-cost canonical
                    // witnesses remain eligible for exact comparison.
                    let covers = |p: &R3Point, walk_lower| {
                        p.origin_departure_secs >= latest
                            && p.destination_arrival_secs <= suffix.arrival
                            && p.actual_transfers <= transfers
                            && (!m4 || p.total_walk_secs <= walk_lower)
                            && (p.origin_departure_secs > latest
                                || p.destination_arrival_secs < suffix.arrival
                                || p.actual_transfers < transfers
                                || m4 && p.total_walk_secs < walk_lower)
                    };
                    let without_walk_bound = self.points.iter().any(|p| covers(p, suffix.walk));
                    let without_layered = without_walk_bound
                        || static_walking > 0
                            && self.points.iter().any(|p| covers(p, static_walk_lower));
                    if without_layered
                        || layered_walking > static_walking
                            && self.points.iter().any(|p| covers(p, walk_lower))
                    {
                        self.diagnostics.prefix.point_pruned_boardings += 1;
                        if self.seed_points.iter().any(|p| covers(p, walk_lower)) {
                            self.diagnostics.forward.certified_prunes += 1;
                        }
                        if !without_walk_bound && without_layered {
                            self.diagnostics.optimistic.walking_pruned_boardings += 1;
                        }
                        if !without_layered {
                            self.diagnostics.prefix.walking_pruned_boardings += 1;
                        }
                        continue;
                    }
                    if WINNERS
                        && self
                            .portfolio
                            .certifies(latest, suffix.arrival, transfers, walk_lower)
                    {
                        continue;
                    }
                }
            }
            if board.can_board() {
                let access = self.entries.get(&stop).cloned().unwrap_or_default();
                for access in access {
                    let origin = board
                        .departure_secs
                        .checked_sub(access as i64)
                        .ok_or(EngineError::TimeOverflow)?;
                    if self.request.window.contains(&origin)
                        && horizon_latest
                            <= origin
                                .checked_add(time::ROUTING_HORIZON_SECS)
                                .ok_or(EngineError::TimeOverflow)?
                    {
                        let witness = self.witness(&suffix, board_id as u32);
                        let point = R3Point {
                            origin_departure_secs: origin,
                            destination_arrival_secs: suffix.arrival,
                            actual_transfers: suffix.transfers,
                            transit_rounds: suffix.rounds,
                            total_walk_secs: suffix
                                .walk
                                .checked_add(access as u64)
                                .ok_or(EngineError::TimeOverflow)?,
                            service_date: self.request.query.date,
                            witness,
                        };
                        if WINNERS {
                            self.portfolio.observe(&point);
                        }
                        insert_point(&mut self.points, point, self.request.objectives);
                    }
                }
            }
            if suffix.rounds >= self.request.query.max_rounds.unwrap_or(RAPTOR_MAX_ROUNDS) {
                continue;
            }
            let earliest = self.prefix.as_ref().map(|p| p.earliest_alight(preceding));
            let incoming = if WINNERS && self.suffix_pruning == DeadlineSuffixPruning::BeforePairs {
                // Before link resolution, use zero extra costs. Every legal
                // link adds nonnegative time/walking/passenger transfers; a
                // block/in-seat link may add zero transfers, never negative.
                // A source-prefix completion still boards before this source's
                // alight event. Strict ranks preserve canonical witness ties.
                // GTFS: https://gtfs.org/documentation/schedule/reference/#transferstxt
                let portfolio = &mut self.portfolio;
                let events = self.events;
                let window_end = self.request.window.end;
                match &mut self.provider {
                    Provider::Lazy(l) => {
                        l.incoming_certified(board_id as u32, earliest, |source| {
                            !portfolio.certifies_predecessor(
                                suffix_departure_upper(events, source, window_end),
                                suffix.arrival,
                                suffix.transfers,
                                suffix.walk,
                            )
                        })?
                    }
                    // Graph links have already been resolved and charged.
                    Provider::Graph(g) => g.incoming(board_id as u32, self.index, earliest)?,
                }
            } else if WINNERS
                && self.suffix_pruning == DeadlineSuffixPruning::RowPrefix
                && self.portfolio.has_incumbents()
            {
                let portfolio = &self.portfolio;
                let window_last = self.request.window.end - 1;
                match &mut self.provider {
                    Provider::Lazy(l) => {
                        l.incoming_row_certified(board_id as u32, earliest, |arrival| {
                            portfolio.covers_bound(
                                arrival.min(window_last),
                                suffix.arrival,
                                suffix.transfers,
                                suffix.walk,
                            )
                        })?
                    }
                    Provider::Graph(g) => g.incoming(board_id as u32, self.index, earliest)?,
                }
            } else if WINNERS
                && self.suffix_pruning == DeadlineSuffixPruning::RowCeiling
                && self.portfolio.has_incumbents()
            {
                match &mut self.provider {
                    Provider::Lazy(l) if l.has_sorted_sources() => {
                        match self.portfolio.row_ceiling(
                            suffix.arrival,
                            suffix.transfers,
                            suffix.walk,
                            self.request.window.end - 1,
                        ) {
                            Some(ceiling) => {
                                l.incoming_row_certified(board_id as u32, earliest, |arrival| {
                                    arrival <= ceiling
                                })?
                            }
                            // Every possible row predicate was false. Avoid
                            // those comparisons; retain exact public lookup.
                            None => l.incoming_bounded(board_id as u32, earliest)?,
                        }
                    }
                    _ => self
                        .provider
                        .incoming(board_id as u32, self.index, earliest)?,
                }
            } else {
                self.provider
                    .incoming(board_id as u32, self.index, earliest)?
            };
            for edge in incoming {
                self.enqueue(Suffix {
                    alight: edge.source,
                    next: Some((id, board_id as u32, edge.kind)),
                    walk: suffix
                        .walk
                        .checked_add(edge.walk_secs as u64)
                        .ok_or(EngineError::TimeOverflow)?,
                    transfers: suffix
                        .transfers
                        .checked_add(u32::from(edge.kind.spends_transfer()))
                        .ok_or(EngineError::TimeOverflow)?,
                    rounds: suffix
                        .rounds
                        .checked_add(1)
                        .ok_or(EngineError::TimeOverflow)?,
                    arrival: suffix.arrival,
                    horizon_latest: horizon_latest
                        .max(self.events[edge.source as usize].arrival_secs),
                    active: true,
                })?;
            }
        }
        Ok(())
    }
}

pub fn query_deadline<'a, B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &'a Reader<B>,
    index: &'a Index,
    catalogue: &'a EventIndex,
    request: DeadlineRequest<'a>,
) -> Result<DeadlineResult, DeadlineError> {
    query_deadline_with_phases(reader, index, catalogue, request, |_| {})
}

/// Native diagnostic only: the second pass receives the first pass's complete
/// legal skyline for free. This is NOT an optimization or an aggregate-capped
/// two-pass algorithm. Each pass independently keeps the original limits.
/// No caller can inject points or replace inputs between passes. Vec backing
/// excludes mutable AsRef implementations; transfer/occurrence witnesses come
/// from the same exact query (GTFS transfers.txt and loop/lasso rules above).
pub fn query_deadline_incumbent_ceiling<'a>(
    reader: &'a Reader<Vec<u8>>,
    index: &'a Index,
    catalogue: &'a EventIndex,
    request: DeadlineRequest<'a>,
) -> Result<DeadlineIncumbentCeiling, DeadlineIncumbentCeilingError> {
    if request.pruning != DeadlinePruning::EarliestPrefixAndPoints
        || request.forward_seeds
        || request.raptor_seeds
        || request.raptor_destination_ordering
    {
        return Err(DeadlineIncumbentCeilingError::Baseline(
            DeadlineError::InvalidRequest("ceiling requires point pruning and sampling off"),
        ));
    }
    let baseline = query_deadline(reader, index, catalogue, request.clone())
        .map_err(DeadlineIncumbentCeilingError::Baseline)?;
    let ceiling = query_impl::<_, false>(
        reader,
        index,
        catalogue,
        request,
        |_| {},
        false,
        baseline.points.clone(),
        WinnerGoal::default(),
    )
    .map_err(DeadlineIncumbentCeilingError::Ceiling)?
    .profile();
    Ok(DeadlineIncumbentCeiling { baseline, ceiling })
}

#[derive(Debug)]
pub struct DeadlineIncumbentCeiling {
    pub baseline: DeadlineResult,
    pub ceiling: DeadlineResult,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeadlineIncumbentCeilingError {
    /// No perfect skyline is available; the repeated pass was not run.
    Baseline(DeadlineError),
    /// The repeated query failed its unchanged limit; no partial result escapes.
    Ceiling(DeadlineError),
}

/// Phase boundaries of the two independent diagnostic passes. Failed passes
/// expose no partial result or qualifying timing, even if Prepared was observed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeadlineWinnerCeilingPhase {
    Baseline(DeadlinePhase),
    Ceiling(DeadlinePhase),
}

/// Complete only for the enclosing diagnostic's requested selector(s).
/// A single-selector pass leaves every other winner slot empty.
#[derive(Debug, Eq, PartialEq)]
pub struct DeadlineWinnerCeilingPass {
    pub winners: DeadlinePortfolioWinners,
    pub window: Range<i64>,
    pub arrival_deadline: i64,
    pub diagnostics: DeadlineDiagnostics,
    pub frontiers: DeadlineFrontierStats,
    pub selection: DeadlinePortfolioDiagnostics,
}

/// Hypothetical free-incumbent diagnostic, NOT a deployable two-pass algorithm.
/// Each pass keeps its original independent caps. The baseline must complete
/// before its own selected legal witnesses can initialize the repeated pass.
#[derive(Debug)]
pub struct DeadlineWinnerIncumbentCeiling {
    /// None means all four fixed selectors, not a full M4 skyline.
    pub preference: Option<DeadlinePreference>,
    pub initial_points: usize,
    pub baseline: DeadlineWinnerCeilingPass,
    pub ceiling: DeadlineWinnerCeilingPass,
}

/// Same query with optional instrumentation. No elapsed time or partial result
/// is returned on failure; callbacks are diagnostic boundaries, not completion.
pub fn query_deadline_with_phases<'a, B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &'a Reader<B>,
    index: &'a Index,
    catalogue: &'a EventIndex,
    request: DeadlineRequest<'a>,
    observe: impl FnMut(DeadlinePhase),
) -> Result<DeadlineResult, DeadlineError> {
    query_checked::<_, false>(
        reader,
        index,
        catalogue,
        request,
        observe,
        WinnerGoal::default(),
    )
    .map(QueryOutcome::profile)
}

/// Exact fixed-selector experiment, not a full R3/M4 skyline. Discovers its own
/// legal incumbents; there is no public initial-point or unchecked API.
/// Ordinary/linked/block legality remains in the existing exact resolver:
/// https://gtfs.org/documentation/schedule/reference/#transferstxt
pub fn query_deadline_portfolio<'a, B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &'a Reader<B>,
    index: &'a Index,
    catalogue: &'a EventIndex,
    request: DeadlineRequest<'a>,
) -> Result<DeadlinePortfolioResult, DeadlineError> {
    query_deadline_portfolio_with_phases(reader, index, catalogue, request, |_| {})
}

pub fn query_deadline_portfolio_with_phases<'a, B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &'a Reader<B>,
    index: &'a Index,
    catalogue: &'a EventIndex,
    request: DeadlineRequest<'a>,
    observe: impl FnMut(DeadlinePhase),
) -> Result<DeadlinePortfolioResult, DeadlineError> {
    query_deadline_portfolio_with_suffix_pruning(
        reader,
        index,
        catalogue,
        request,
        DeadlineSuffixPruning::Off,
        observe,
    )
}

/// Checked all-four experiment with optional pre-allocation suffix pruning.
/// No full skyline or queue-wide stopping guarantee is implied.
pub fn query_deadline_portfolio_with_suffix_pruning<'a, B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &'a Reader<B>,
    index: &'a Index,
    catalogue: &'a EventIndex,
    request: DeadlineRequest<'a>,
    suffix_pruning: DeadlineSuffixPruning,
    mut observe: impl FnMut(DeadlinePhase),
) -> Result<DeadlinePortfolioResult, DeadlineError> {
    validate_winner_options(&request)?;
    let outcome = query_checked::<_, true>(
        reader,
        index,
        catalogue,
        request,
        |phase| {
            if phase == DeadlinePhase::Prepared {
                observe(phase);
            }
        },
        WinnerGoal {
            preference: None,
            suffix_pruning,
        },
    )?;
    let result = outcome.portfolio();
    // Selection/cloning and disposal of the non-winner candidate points are
    // included in the winner workload, not hidden after SearchFinished.
    observe(DeadlinePhase::SearchFinished);
    Ok(result)
}

/// Exact one-selector experiment. Retains concrete GTFS occurrences and the
/// same legality checks as the full profile; there is no clock-now cutoff.
/// https://gtfs.org/documentation/schedule/reference/#transferstxt
/// https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
pub fn query_deadline_preference<'a, B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &'a Reader<B>,
    index: &'a Index,
    catalogue: &'a EventIndex,
    request: DeadlineRequest<'a>,
    preference: DeadlinePreference,
) -> Result<DeadlinePreferenceResult, DeadlineError> {
    query_deadline_preference_with_phases(reader, index, catalogue, request, preference, |_| {})
}

pub fn query_deadline_preference_with_phases<'a, B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &'a Reader<B>,
    index: &'a Index,
    catalogue: &'a EventIndex,
    request: DeadlineRequest<'a>,
    preference: DeadlinePreference,
    observe: impl FnMut(DeadlinePhase),
) -> Result<DeadlinePreferenceResult, DeadlineError> {
    query_deadline_preference_with_suffix_pruning(
        reader,
        index,
        catalogue,
        request,
        preference,
        DeadlineSuffixPruning::Off,
        observe,
    )
}

/// Checked single-selector ablation. Other selectors are not certified.
pub fn query_deadline_preference_with_suffix_pruning<'a, B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &'a Reader<B>,
    index: &'a Index,
    catalogue: &'a EventIndex,
    request: DeadlineRequest<'a>,
    preference: DeadlinePreference,
    suffix_pruning: DeadlineSuffixPruning,
    mut observe: impl FnMut(DeadlinePhase),
) -> Result<DeadlinePreferenceResult, DeadlineError> {
    validate_winner_options(&request)?;
    let outcome = query_checked::<_, true>(
        reader,
        index,
        catalogue,
        request,
        |phase| {
            if phase == DeadlinePhase::Prepared {
                observe(phase);
            }
        },
        WinnerGoal {
            preference: Some(preference),
            suffix_pruning,
        },
    )?;
    let result = outcome.preference();
    observe(DeadlinePhase::SearchFinished);
    Ok(result)
}

fn validate_winner_options(request: &DeadlineRequest<'_>) -> Result<(), DeadlineError> {
    if request.objectives != ProfileObjectives::M4
        || request.forward_seeds
        || request.raptor_seeds
        || request.raptor_destination_ordering
    {
        return Err(DeadlineError::InvalidRequest(
            "portfolio requires M4 and sampling off",
        ));
    }
    Ok(())
}

fn query_checked<'a, B: AsRef<[u8]> + Send + Sync + 'static, const WINNERS: bool>(
    reader: &'a Reader<B>,
    index: &'a Index,
    catalogue: &'a EventIndex,
    request: DeadlineRequest<'a>,
    observe: impl FnMut(DeadlinePhase),
    goal: WinnerGoal,
) -> Result<QueryOutcome<WINNERS>, DeadlineError> {
    let until = validate_request_shape(reader, &request)?;
    let config = TransferIndexConfig::for_query(request.query, catalogue.covered());
    if !catalogue.is_bound_to(reader, index, request.transfers, &config) {
        return Err(DeadlineError::BindingMismatch);
    }
    validate_catalogue(catalogue, request.window.start..until)?;
    query_impl::<_, WINNERS>(
        reader,
        index,
        catalogue,
        request,
        observe,
        false,
        Vec::new(),
        goal,
    )
}

// No public unchecked entry point. The caller is the immutable owned session,
// whose catalogue and request were prepared together and cannot be substituted.
// Restrict the backing to Vec: arbitrary generic AsRef implementations may have
// interior mutability even when borrowed through &Reader<B>.
pub(super) fn query_prepared_with_phases<'a>(
    reader: &'a Reader<Vec<u8>>,
    index: &'a Index,
    catalogue: &'a EventIndex,
    request: DeadlineRequest<'a>,
    cached_prefix: Option<&'a CachedPrefix>,
    observe: impl FnMut(DeadlinePhase),
) -> Result<DeadlineResult, DeadlineError> {
    query_impl_with_prefix::<_, false>(
        reader,
        index,
        catalogue,
        request,
        observe,
        true,
        Vec::new(),
        WinnerGoal::default(),
        cached_prefix,
    )
    .map(QueryOutcome::profile)
}

// Same ownership proof as the full-profile prepared path above. These helpers
// are private to the owned session; generic public APIs always stay checked.
pub(super) fn query_prepared_portfolio_with_phases<'a>(
    reader: &'a Reader<Vec<u8>>,
    index: &'a Index,
    catalogue: &'a EventIndex,
    request: DeadlineRequest<'a>,
    suffix_pruning: DeadlineSuffixPruning,
    cached_prefix: Option<&'a CachedPrefix>,
    mut observe: impl FnMut(DeadlinePhase),
) -> Result<DeadlinePortfolioResult, DeadlineError> {
    validate_winner_options(&request)?;
    let outcome = query_impl_with_prefix::<_, true>(
        reader,
        index,
        catalogue,
        request,
        |phase| {
            if phase == DeadlinePhase::Prepared {
                observe(phase);
            }
        },
        true,
        Vec::new(),
        WinnerGoal {
            preference: None,
            suffix_pruning,
        },
        cached_prefix,
    )?;
    let result = outcome.portfolio();
    observe(DeadlinePhase::SearchFinished);
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn query_prepared_preference_with_phases<'a>(
    reader: &'a Reader<Vec<u8>>,
    index: &'a Index,
    catalogue: &'a EventIndex,
    request: DeadlineRequest<'a>,
    preference: DeadlinePreference,
    suffix_pruning: DeadlineSuffixPruning,
    cached_prefix: Option<&'a CachedPrefix>,
    mut observe: impl FnMut(DeadlinePhase),
) -> Result<DeadlinePreferenceResult, DeadlineError> {
    validate_winner_options(&request)?;
    let outcome = query_impl_with_prefix::<_, true>(
        reader,
        index,
        catalogue,
        request,
        |phase| {
            if phase == DeadlinePhase::Prepared {
                observe(phase);
            }
        },
        true,
        Vec::new(),
        WinnerGoal {
            preference: Some(preference),
            suffix_pruning,
        },
        cached_prefix,
    )?;
    let result = outcome.preference();
    observe(DeadlinePhase::SearchFinished);
    Ok(result)
}

// Only the immutable session may invoke this diagnostic; there is deliberately
// no caller-supplied seed, reader, catalogue or unchecked public entry point.
// Concrete GTFS transfer and loop/lasso occurrences remain in the exact query:
// https://gtfs.org/documentation/schedule/reference/#transferstxt
// https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
#[allow(clippy::too_many_arguments)]
pub(super) fn query_prepared_winner_incumbent_ceiling<'a>(
    reader: &'a Reader<Vec<u8>>,
    index: &'a Index,
    catalogue: &'a EventIndex,
    request: DeadlineRequest<'a>,
    preference: Option<DeadlinePreference>,
    suffix_pruning: DeadlineSuffixPruning,
    mut observe: impl FnMut(DeadlineWinnerCeilingPhase),
) -> Result<DeadlineWinnerIncumbentCeiling, DeadlineIncumbentCeilingError> {
    validate_winner_options(&request).map_err(DeadlineIncumbentCeilingError::Baseline)?;
    if request.pruning != DeadlinePruning::EarliestPrefixAndPoints {
        return Err(DeadlineIncumbentCeilingError::Baseline(
            DeadlineError::InvalidRequest("winner ceiling requires point pruning"),
        ));
    }
    let goal = WinnerGoal {
        preference,
        suffix_pruning,
    };
    let baseline = winner_ceiling_pass(
        query_impl::<_, true>(
            reader,
            index,
            catalogue,
            request.clone(),
            |phase| {
                if phase == DeadlinePhase::Prepared {
                    observe(DeadlineWinnerCeilingPhase::Baseline(phase));
                }
            },
            true,
            Vec::new(),
            goal,
        )
        .map_err(DeadlineIncumbentCeilingError::Baseline)?,
    );
    observe(DeadlineWinnerCeilingPhase::Baseline(
        DeadlinePhase::SearchFinished,
    ));
    // Deduplicate identical FULL witnesses only. Keep all requested selectors'
    // distinct winners; do not inject a full skyline or any caller-supplied hint.
    // Extraction/cloning is inside the repeated pass's preparation interval.
    let mut initial = Vec::new();
    for p in baseline.winners.by_preference.iter().flatten() {
        if !initial.contains(p) {
            initial.push(p.clone());
        }
    }
    let initial_points = initial.len();
    let ceiling = winner_ceiling_pass(
        query_impl::<_, true>(
            reader,
            index,
            catalogue,
            request,
            |phase| {
                if phase == DeadlinePhase::Prepared {
                    observe(DeadlineWinnerCeilingPhase::Ceiling(phase));
                }
            },
            true,
            initial,
            goal,
        )
        .map_err(DeadlineIncumbentCeilingError::Ceiling)?,
    );
    observe(DeadlineWinnerCeilingPhase::Ceiling(
        DeadlinePhase::SearchFinished,
    ));
    Ok(DeadlineWinnerIncumbentCeiling {
        preference,
        initial_points,
        baseline,
        ceiling,
    })
}

fn winner_ceiling_pass(outcome: QueryOutcome<true>) -> DeadlineWinnerCeilingPass {
    if outcome.preference.is_some() {
        let r = outcome.preference();
        let mut winners = DeadlinePortfolioWinners::default();
        let slot = DeadlinePreference::ALL
            .iter()
            .position(|p| *p == r.preference)
            .expect("known preference");
        winners.by_preference[slot] = r.winner;
        DeadlineWinnerCeilingPass {
            winners,
            window: r.window,
            arrival_deadline: r.arrival_deadline,
            diagnostics: r.diagnostics,
            frontiers: r.frontiers,
            selection: r.selection,
        }
    } else {
        let r = outcome.portfolio();
        DeadlineWinnerCeilingPass {
            winners: r.winners,
            window: r.window,
            arrival_deadline: r.arrival_deadline,
            diagnostics: r.diagnostics,
            frontiers: r.frontiers,
            selection: r.selection,
        }
    }
}

pub(super) fn validate_request<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    catalogue: &EventIndex,
    request: &DeadlineRequest<'_>,
) -> Result<(), DeadlineError> {
    let until = validate_request_shape(reader, request)?;
    validate_catalogue(catalogue, request.window.start..until)
}

pub(super) fn validate_request_shape<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    request: &DeadlineRequest<'_>,
) -> Result<i64, DeadlineError> {
    if request.raptor_seeds || request.raptor_destination_ordering {
        return Err(DeadlineError::InvalidRequest(
            "production-forward seed experiments have been removed",
        ));
    }
    let until = request
        .arrival_deadline
        .checked_add(1)
        .ok_or(EngineError::TimeOverflow)?;
    if request.window.start >= request.window.end
        || request.window.end > until
        || [
            request.max_segments,
            request.max_frontier_width,
            request.max_stop_scans,
            request.max_lookup_work,
        ]
        .contains(&0)
        || request.traversal == DeadlineTraversal::Guided && !request.static_bound
        || request.walking_bound
            && !matches!(
                request.pruning,
                DeadlinePruning::EarliestPrefixAndPoints
                    | DeadlinePruning::EarliestPrefixAndTimetablePoints
            )
        || request.transfer_bound
            && (request.objectives != ProfileObjectives::M4
                || !matches!(
                    request.pruning,
                    DeadlinePruning::EarliestPrefixAndPoints
                        | DeadlinePruning::EarliestPrefixAndTimetablePoints
                ))
        || request.forward_seeds && request.pruning != DeadlinePruning::EarliestPrefixAndPoints
    {
        return Err(DeadlineError::InvalidRequest(
            "invalid departure window, deadline or zero limit",
        ));
    }
    if request
        .query
        .entry_stops
        .iter()
        .chain(&request.query.exit_stops)
        .any(|s| s.stop as usize >= reader.num_stops())
    {
        return Err(DeadlineError::InvalidRequest("physical stop out of range"));
    }
    Ok(until)
}

fn validate_catalogue(catalogue: &EventIndex, required: Range<i64>) -> Result<(), DeadlineError> {
    if catalogue.covered.start > required.start || catalogue.covered.end < required.end {
        return Err(DeadlineError::IncompleteCoverage {
            required,
            covered: catalogue.covered(),
        });
    }
    for (i, &e) in catalogue.events.iter().enumerate() {
        if e.arrival_secs > e.departure_secs
            || i > 0
                && same_vehicle(catalogue.events[i - 1], e)
                && catalogue.events[i - 1].departure_secs > e.arrival_secs
        {
            return Err(DeadlineError::InvalidRequest("nonmonotone vehicle events"));
        }
    }
    Ok(())
}

struct QueryOutcome<const WINNERS: bool> {
    points: Vec<R3Point>,
    window: Range<i64>,
    arrival_deadline: i64,
    diagnostics: DeadlineDiagnostics,
    frontiers: DeadlineFrontierStats,
    selection: DeadlinePortfolioDiagnostics,
    preference: Option<DeadlinePreference>,
}
impl QueryOutcome<false> {
    fn profile(self) -> DeadlineResult {
        DeadlineResult {
            points: self.points,
            window: self.window,
            arrival_deadline: self.arrival_deadline,
            complete: true,
            diagnostics: self.diagnostics,
            frontiers: self.frontiers,
        }
    }
}
impl QueryOutcome<true> {
    fn portfolio(self) -> DeadlinePortfolioResult {
        assert!(
            self.preference.is_none(),
            "single goal cannot claim portfolio completion"
        );
        DeadlinePortfolioResult {
            winners: DeadlinePortfolioWinners::from_m4_points(&self.points),
            window: self.window,
            arrival_deadline: self.arrival_deadline,
            complete: true,
            diagnostics: self.diagnostics,
            frontiers: self.frontiers,
            selection: self.selection,
        }
    }
    fn preference(self) -> DeadlinePreferenceResult {
        let preference = self.preference.expect("checked single-preference goal");
        DeadlinePreferenceResult {
            preference,
            winner: preference.from_m4_points(&self.points),
            window: self.window,
            arrival_deadline: self.arrival_deadline,
            complete: true,
            diagnostics: self.diagnostics,
            frontiers: self.frontiers,
            selection: self.selection,
        }
    }
}

pub(super) fn entry_walks<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    request: &DeadlineRequest<'_>,
) -> Result<BTreeMap<u32, Vec<u32>>, DeadlineError> {
    let mut entries: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    for entry in &request.query.entry_stops {
        if !inaccessible(reader, request.query, entry.stop)? {
            entries.entry(entry.stop).or_default().push(entry.walk_secs);
        }
    }
    for values in entries.values_mut() {
        values.sort_unstable();
        values.dedup();
    }
    Ok(entries)
}

// Generic checked/diagnostic paths always rebuild. Only the sealed owned
// session's ordinary prepared paths can supply an immutable prefix.
#[allow(clippy::too_many_arguments)]
fn query_impl<'a, B: AsRef<[u8]> + Send + Sync + 'static, const WINNERS: bool>(
    reader: &'a Reader<B>,
    index: &'a Index,
    catalogue: &'a EventIndex,
    request: DeadlineRequest<'a>,
    observe: impl FnMut(DeadlinePhase),
    session_bound: bool,
    initial_points: Vec<R3Point>,
    goal: WinnerGoal,
) -> Result<QueryOutcome<WINNERS>, DeadlineError> {
    query_impl_with_prefix(
        reader,
        index,
        catalogue,
        request,
        observe,
        session_bound,
        initial_points,
        goal,
        None,
    )
}

// Shared scanner inputs plus private goal; public request semantics stay fixed.
#[allow(clippy::too_many_arguments)]
fn query_impl_with_prefix<'a, B: AsRef<[u8]> + Send + Sync + 'static, const WINNERS: bool>(
    reader: &'a Reader<B>,
    index: &'a Index,
    catalogue: &'a EventIndex,
    mut request: DeadlineRequest<'a>,
    mut observe: impl FnMut(DeadlinePhase),
    session_bound: bool,
    initial_points: Vec<R3Point>,
    goal: WinnerGoal,
    cached_prefix: Option<&'a CachedPrefix>,
) -> Result<QueryOutcome<WINNERS>, DeadlineError> {
    let entries = entry_walks(reader, &request)?;
    let (optimistic, optimistic_diagnostics) = OptimisticBounds::build(reader, index, &request, 0)?;
    let (prefix, prefix_diagnostics) = if let Some(cached) = cached_prefix {
        // Replayed nominal setup work remains in every original aggregate cap.
        // Config/caps are owned and immutable for this prepared slot.
        cached.borrow()?
    } else {
        let (prefix, diagnostics) = PrefixBound::build(
            reader,
            index,
            catalogue,
            &request,
            &entries,
            optimistic_diagnostics.work(),
        )?;
        (prefix.map(PrefixStorage::Fresh), diagnostics)
    };
    let origin_hints = if request.traversal == DeadlineTraversal::OriginPrefixWarmup {
        if prefix.is_some() {
            Some(alloc::vec![u8::MAX; catalogue.events.len()])
        } else {
            request.traversal = DeadlineTraversal::ArrivalFirst;
            None
        }
    } else {
        None
    };
    let origin_hint = OriginHintDiagnostics {
        enabled: origin_hints.is_some(),
        checks: 0,
        index_bytes: origin_hints.as_ref().map_or(0, Vec::len),
    };
    let (seed_points, forward) = super::seeds::build(
        reader,
        index,
        catalogue,
        &request,
        &entries,
        optimistic_diagnostics
            .work()
            .checked_add(prefix_diagnostics.work())
            .ok_or(EngineError::TimeOverflow)?,
        prefix.is_some(),
    )?;
    let raptor = RaptorSeedDiagnostics::default();
    let provider = match request.lookup {
        DeadlineLookup::Graph(table) => {
            if table.binding != catalogue.binding || table.events != catalogue.events {
                return Err(DeadlineError::BindingMismatch);
            }
            Provider::Graph(GraphIncoming::new(
                table,
                request.max_lookup_work,
                forward.lookup_work,
            )?)
        }
        DeadlineLookup::Lazy(mode) => {
            let config = LazyLookupConfig {
                mode,
                max_work: request.max_lookup_work,
            };
            Provider::Lazy(if session_bound {
                LazyPredecessors::new_session_bound_with_work(
                    reader,
                    index,
                    catalogue,
                    request.transfers,
                    request.query,
                    config,
                    forward.lookup_work,
                )?
            } else {
                LazyPredecessors::new_with_work(
                    reader,
                    index,
                    catalogue,
                    request.transfers,
                    request.query,
                    config,
                    forward.lookup_work,
                )?
            })
        }
    };
    let frontiers = Frontiers::new(request.frontier_storage, catalogue.events.len());
    observe(DeadlinePhase::Prepared);
    let queue = Queue::new(request.traversal);
    let mut points = seed_points.clone();
    for p in initial_points {
        insert_point(&mut points, p, request.objectives);
    }
    let mut portfolio = PortfolioTracker::new(goal.preference);
    if WINNERS {
        for point in &points {
            portfolio.observe(point);
        }
    }
    let mut search = Search::<_, WINNERS> {
        reader,
        index,
        events: &catalogue.events,
        request,
        provider,
        prefix,
        optimistic,
        segments: Vec::new(),
        queue,
        origin_hints,
        frontiers,
        entries,
        seed_points,
        points,
        portfolio,
        suffix_pruning: goal.suffix_pruning,
        date_memo: WitnessDateMemo::default(),
        diagnostics: DeadlineDiagnostics {
            prefix: prefix_diagnostics,
            optimistic: optimistic_diagnostics,
            forward,
            raptor,
            origin_hint,
            ..DeadlineDiagnostics::default()
        },
    };
    search.seed()?;
    let origin_warmup = search.request.traversal == DeadlineTraversal::OriginPrefixWarmup;
    let mut warmup_remaining = if matches!(
        search.request.traversal,
        DeadlineTraversal::DepartureWarmup64 | DeadlineTraversal::OriginPrefixWarmup
    ) {
        64
    } else {
        0
    };
    while let Some(id) = search.queue.pop() {
        if search.segments[id].active {
            search.scan(id)?;
            if warmup_remaining > 0 {
                warmup_remaining -= 1;
                search.diagnostics.warmup.preferred_scans += 1;
                if warmup_remaining == 0 || origin_warmup && !search.points.is_empty() {
                    warmup_remaining = 0;
                    let previous = core::mem::replace(
                        &mut search.queue,
                        Queue::ArrivalFirst(BinaryHeap::new()),
                    );
                    let (queue, pending, live, bytes) =
                        previous.restore_arrival_first(&search.segments);
                    search.queue = queue;
                    search.request.traversal = DeadlineTraversal::ArrivalFirst;
                    search.origin_hints = None;
                    search.diagnostics.warmup.restored = true;
                    search.diagnostics.warmup.points_at_restore = search.points.len();
                    search.diagnostics.warmup.pending_at_restore = pending;
                    search.diagnostics.warmup.live_requeued = live;
                    search.diagnostics.warmup.additional_queue_capacity_bytes = bytes;
                }
            }
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
    match &search.provider {
        Provider::Graph(g) => {
            search.diagnostics.incoming_index_bytes = core::mem::size_of_val(g.order.as_slice())
                + core::mem::size_of_val(g.offsets.as_slice());
            search.diagnostics.graph_edges_prepared = g.order.len();
            search.diagnostics.graph_edges_scanned = g.scanned;
            search.diagnostics.prefix.pruned_source_rows = g.source_bound_skips;
        }
        Provider::Lazy(l) => {
            search.diagnostics.lazy = l.diagnostics();
            search.diagnostics.incoming_index_bytes = l.incoming_index_bytes();
            search.diagnostics.prefix.pruned_source_rows =
                l.diagnostics().early_source_rows_skipped;
        }
    }
    let frontiers = search.frontiers.stats();
    observe(DeadlinePhase::SearchFinished);
    Ok(QueryOutcome {
        points: search.points,
        window: search.request.window,
        arrival_deadline: search.request.arrival_deadline,
        diagnostics: search.diagnostics,
        frontiers,
        selection: search.portfolio.diagnostics,
        preference: goal.preference,
    })
}

#[cfg(test)]
mod witness_tests {
    use super::*;

    fn leg() -> WitnessLeg {
        WitnessLeg {
            start: StopEvent {
                frequency_offset_secs: -60,
                arrival_secs: 899,
                departure_secs: 900,
                route_idx: 2,
                trip_idx: 3,
                date_ordinal: 0,
                position: 4,
                flags: APPROXIMATE,
            },
            alight_position: 7,
            alight_secs: 1200,
            reader_route_idx: 5,
            in_seat: true,
        }
    }
    fn field(leg: &mut WitnessLeg, index: usize, value: u32) {
        match index {
            0 => leg.start.date_ordinal = value,
            1 => leg.start.route_idx = value,
            2 => leg.reader_route_idx = value,
            3 => leg.start.trip_idx = value,
            4 => leg.start.position = value,
            5 => leg.alight_position = value,
            6 => leg.start.departure_secs = value as i64,
            7 => leg.alight_secs = value as i64,
            8 => leg.start.frequency_offset_secs = value as i64,
            9 => leg.start.flags = if value == 0 { 0 } else { APPROXIMATE },
            10 => leg.in_seat = value != 0,
            _ => unreachable!(),
        }
    }
    fn check(a: &[WitnessLeg], b: &[WitnessLeg], feed_start: u32) {
        let date = |ordinal: u32| crate::reader::days_add(feed_start, ordinal as i64);
        let materialize = |legs: &[WitnessLeg]| {
            legs.iter()
                .map(|leg| leg.with_date(date(leg.start.date_ordinal)))
                .collect::<Vec<_>>()
        };
        let want = materialize(a).cmp(&materialize(b));
        assert_eq!(
            compare_witnesses(a.iter().copied(), b.iter().copied(), date),
            want
        );
        assert_eq!(
            compare_witnesses(b.iter().copied(), a.iter().copied(), date),
            want.reverse()
        );
    }

    #[test]
    fn streaming_leg_maps_all_fields_without_publishing_dummy_dates() {
        assert_eq!(
            leg().with_date(20261015),
            R3TransitWitness {
                service_date: 20261015,
                route_idx: 2,
                reader_route_idx: 5,
                trip_idx: 3,
                board_position: 4,
                alight_position: 7,
                board_secs: 900,
                alight_secs: 1200,
                frequency_offset_secs: -60,
                frequency_instance: true,
                in_seat: true,
            }
        );
    }

    #[test]
    fn streaming_preserves_every_field_and_derived_field_priority() {
        for first in 0..11 {
            let (mut a, mut b) = (leg(), leg());
            field(&mut a, first, 0);
            field(&mut b, first, 1);
            check(&[a], &[b], 20261231);
            for later in first + 1..11 {
                let (mut a, mut b) = (a, b);
                field(&mut a, later, 1);
                field(&mut b, later, 0);
                check(&[a], &[b], 20261231);
            }
        }
    }

    #[test]
    fn streaming_skips_only_equal_ordinals_and_stops_at_first_difference() {
        let a = [leg(); 4];
        let mut calls = 0;
        assert_eq!(
            compare_witnesses(a.into_iter(), a.into_iter(), |_| {
                calls += 1;
                20261015
            }),
            Ordering::Equal
        );
        assert_eq!(calls, 0);
        let mut b = a;
        b[0].start.route_idx += 1;
        let (mut left_reads, mut right_reads) = (0, 0);
        assert_eq!(
            compare_witnesses(
                a.into_iter().inspect(|_| left_reads += 1),
                b.into_iter().inspect(|_| right_reads += 1),
                |_| panic!("equal ordinal converted")
            ),
            Ordering::Less
        );
        assert_eq!((left_reads, right_reads), (1, 1));
        b = a;
        b[0].start.date_ordinal = 1;
        // An intentionally nonmonotone conversion proves that unequal ordinals
        // call the supplied calendar operation instead of comparing integers.
        assert_eq!(
            compare_witnesses(a.into_iter(), b.into_iter(), |ordinal| {
                calls += 1;
                if ordinal == 0 {
                    20260103
                } else {
                    20260101
                }
            }),
            Ordering::Greater
        );
        assert_eq!(calls, 2);
    }

    #[test]
    fn streaming_matches_full_vectors_on_prefixes_late_ties_and_calendar_boundaries() {
        let mut random = 0x5749_544e_4553_5355u64;
        let mut next = || {
            random ^= random << 13;
            random ^= random >> 7;
            random ^= random << 17;
            random as u32
        };
        for _ in 0..1000 {
            let len = (next() % 9) as usize;
            let mut a = Vec::new();
            for _ in 0..len {
                let mut leg = leg();
                for f in 0..11 {
                    field(&mut leg, f, next() % 100);
                }
                a.push(leg);
            }
            let mut b = a.clone();
            match next() % 4 {
                0 if len > 0 => {
                    let f = (next() % 11) as usize;
                    field(&mut b[len - 1], f, next() % 100);
                }
                1 => {
                    b.pop();
                }
                2 => b.push(leg()),
                _ => (),
            }
            for start in [20240228, 20251231, 20260328, 20261024] {
                check(&a, &b, start);
            }
        }
    }
}

#[cfg(test)]
mod traversal_tests {
    use super::*;

    #[test]
    fn bounded_warmup_migration_preserves_live_ids_and_exact_arrival_order() {
        let mut suffixes = Vec::new();
        let mut queue = Queue::new(DeadlineTraversal::DepartureWarmup64);
        let mut reference = Queue::new(DeadlineTraversal::ArrivalFirst);
        for id in 0..130 {
            let s = Suffix {
                alight: id as u32,
                next: None,
                walk: (id % 3) as u64,
                transfers: (id % 2) as u32,
                rounds: (id % 4 + 1) as u32,
                arrival: (id % 7) as i64,
                horizon_latest: 1000,
                active: id % 5 != 0,
            };
            queue.push(id, &s, Some(id as i64));
            if s.active {
                reference.push(id, &s, None);
            }
            suffixes.push(s);
        }
        let (mut migrated, pending, live, bytes) = queue.restore_arrival_first(&suffixes);
        assert_eq!(pending, 130);
        assert_eq!(live, 104);
        assert_eq!(bytes, 130 * core::mem::size_of::<ArrivalPriority>());
        migrated.push(130, &suffixes[1], Some(i64::MAX));
        reference.push(130, &suffixes[1], None);
        let mut count = 0;
        while let Some(want) = reference.pop() {
            assert_eq!(migrated.pop(), Some(want));
            count += 1;
        }
        assert_eq!(count, 105);
        assert_eq!(migrated.pop(), None);
        let (mut empty, pending, live, bytes) =
            Queue::new(DeadlineTraversal::DepartureWarmup64).restore_arrival_first(&[]);
        assert_eq!((pending, live, bytes), (0, 0, 0));
        assert_eq!(empty.pop(), None);
    }

    #[test]
    fn traversal_orders_keep_every_id_and_break_equal_priorities_stably() {
        let suffix = |arrival, transfers, walk, rounds| Suffix {
            alight: 0,
            next: None,
            walk,
            transfers,
            rounds,
            arrival,
            horizon_latest: arrival,
            active: true,
        };
        for (order, expected) in [
            (DeadlineTraversal::Fifo, [5, 4, 3, 2, 1, 0]),
            (DeadlineTraversal::ArrivalFirst, [0, 1, 2, 3, 4, 5]),
            (DeadlineTraversal::Guided, [0, 1, 2, 3, 4, 5]),
            (DeadlineTraversal::DepartureFirst, [0, 1, 2, 3, 4, 5]),
        ] {
            let mut queue = Queue::new(order);
            for (id, s) in [
                (5, suffix(2000, 0, 0, 1)),
                (4, suffix(1000, 1, 0, 1)),
                (3, suffix(1000, 0, 10, 1)),
                (2, suffix(1000, 0, 0, 2)),
                (1, suffix(1000, 0, 0, 1)),
                (0, suffix(1000, 0, 0, 1)),
            ] {
                queue.push(id, &s, None);
            }
            for id in expected {
                assert_eq!(queue.pop(), Some(id));
            }
            assert_eq!(queue.pop(), None);
        }
    }

    #[test]
    fn guided_orders_by_the_latest_optimistic_origin_not_earliest_arrival() {
        let mut queue = Queue::new(DeadlineTraversal::Guided);
        let mut suffix = Suffix {
            alight: 0,
            next: None,
            walk: 0,
            transfers: 0,
            rounds: 1,
            arrival: 1000,
            horizon_latest: 1000,
            active: true,
        };
        queue.push(0, &suffix, Some(700));
        suffix.arrival = 1200;
        queue.push(1, &suffix, Some(900));
        queue.push(2, &suffix, Some(900));
        assert_eq!(queue.pop(), Some(1));
        assert_eq!(queue.pop(), Some(2));
        assert_eq!(queue.pop(), Some(0));
        assert_eq!(queue.pop(), None);
    }

    #[test]
    fn departure_hints_keep_occurrences_dates_frequency_and_signed_times() {
        let first = StopEvent {
            frequency_offset_secs: 0,
            arrival_secs: i64::MIN,
            departure_secs: i64::MIN,
            route_idx: 0,
            trip_idx: 0,
            date_ordinal: 0,
            position: 0,
            flags: 0,
        };
        let second = StopEvent {
            arrival_secs: -10,
            departure_secs: -5,
            position: 3,
            ..first
        };
        let third = StopEvent {
            arrival_secs: 0,
            departure_secs: 2,
            position: 5,
            ..first
        };
        let mut events = [first, second, third];
        assert_eq!(departure_hint(&events, 0), i64::MIN);
        assert_eq!(departure_hint(&events, 1), i64::MIN); // no pickup permission implied
        assert_eq!(departure_hint(&events, 2), -5);
        assert_eq!(suffix_departure_upper(&events, 2, -10), -11);
        assert_eq!(suffix_departure_upper(&events, 2, 1), -5);
        assert_eq!(suffix_departure_upper(&events, 0, i64::MIN + 1), i64::MIN);
        for kind in 0..3 {
            events[2] = third;
            match kind {
                0 => events[2].trip_idx = 1,
                1 => events[2].date_ordinal = 1,
                _ => events[2].frequency_offset_secs = 60,
            };
            assert_eq!(departure_hint(&events, 2), 0);
        }
        let mut queue = Queue::new(DeadlineTraversal::DepartureFirst);
        for (id, hint) in [(0, i64::MIN), (2, 10), (1, 10), (3, -5)] {
            let s = Suffix {
                alight: 0,
                next: None,
                walk: 0,
                transfers: 0,
                rounds: 1,
                arrival: 100,
                horizon_latest: 100,
                active: true,
            };
            queue.push(id, &s, Some(hint));
        }
        for id in [1, 2, 3, 0] {
            assert_eq!(queue.pop(), Some(id));
        }
        assert_eq!(queue.pop(), None);
    }
}
