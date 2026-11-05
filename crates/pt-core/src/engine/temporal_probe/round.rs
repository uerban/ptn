//! Experimental PTB v2 round/pattern profile kernel.
//!
//! Ordinary and linked states have different future behavior. GTFS rules and
//! concrete dates follow the v2 foundation, not legacy transfer hydration:
//! <https://gtfs.org/documentation/schedule/reference/#transferstxt>.
//! Every loop/lasso occurrence remains distinct:
//! <https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes>.

use super::r3::{ProfileObjectives, R3ProfilePage, R3TransitWitness};
use super::v2::{State, Strategy};
use crate::engine::scan::{alight_secs_at, dep_secs_at, pickup_forbidden_at};
use crate::engine::v2::scan::Inst;
use crate::engine::{EngineError, Index, Query};
use crate::{Reader, Transfers};
use alloc::vec;
use alloc::vec::Vec;
use core::ops::Range;
use hashbrown::HashMap;
use rustc_hash::FxBuildHasher;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StopOccurrence {
    pub pattern: u32,
    pub position: u32,
}

/// Derived metadata bound to the exact routing index and PatternMode.
pub struct RoundProfileIndex<'a> {
    index: &'a Index,
    offsets: Vec<usize>,
    occurrences: Vec<StopOccurrence>,
    trip_sensitive: Vec<bool>,
    route_sensitive: Vec<bool>,
    instance_sensitive: Vec<bool>,
    ordinary_instance_sensitive: Vec<bool>,
    boardable: Vec<Vec<bool>>,
    scheduled: Vec<Option<ScheduledBounds>>,
    shared_boarding_cost: Vec<bool>,
}

/// Sorted slot ordinals only; timetable columns stay in the reader.
pub(super) struct ScheduledBounds {
    pub(super) slots: Vec<Vec<u32>>,
    pub(super) span: i64,
}

impl<'a> RoundProfileIndex<'a> {
    pub fn build<B: AsRef<[u8]> + Send + Sync + 'static>(
        reader: &Reader<B>,
        index: &'a Index,
    ) -> Result<Self, EngineError> {
        let v2 = index.v2.as_deref().ok_or(EngineError::UnsupportedVersion)?;
        if !reader.is_v2() {
            return Err(EngineError::UnsupportedVersion);
        }
        let n = reader.num_stops();
        let mut offsets = vec![0usize; n.checked_add(1).ok_or(EngineError::TimeOverflow)?];
        let mut ordinary_instance_sensitive = vec![false; reader.num_trips()];
        let mut boardable = Vec::with_capacity(index.routes.len());
        for route in &index.routes {
            let mut positions = vec![false; route.stop_ids.len()];
            for &stop in &route.stop_ids {
                let count = offsets
                    .get_mut(stop as usize + 1)
                    .ok_or(EngineError::Corrupt("round occurrence stop"))?;
                *count = count.checked_add(1).ok_or(EngineError::TimeOverflow)?;
            }
            for trip in &route.trips {
                let mut previous_departure = None;
                for (position, boardable_position) in positions.iter_mut().enumerate() {
                    if trip.pos_to_row[position] == -1 {
                        continue;
                    }
                    let info = v2.trips[trip.trip_idx as usize];
                    if info.route != u32::MAX
                        && position < info.last_pos as usize
                        && !pickup_forbidden_at(reader, trip, position)
                    {
                        *boardable_position = true;
                    }
                    let arrival = alight_secs_at(reader, trip, position)?;
                    if previous_departure.is_some_and(|d| arrival <= d) {
                        ordinary_instance_sensitive[trip.trip_idx as usize] = true;
                    }
                    previous_departure = Some(dep_secs_at(reader, trip, position)?);
                }
            }
            boardable.push(positions);
        }
        for i in 1..=n {
            offsets[i] = offsets[i]
                .checked_add(offsets[i - 1])
                .ok_or(EngineError::TimeOverflow)?;
        }
        let mut occurrences = vec![StopOccurrence::default(); offsets[n]];
        let mut next = offsets[..n].to_vec();
        for (pattern, route) in index.routes.iter().enumerate() {
            for (position, &stop) in route.stop_ids.iter().enumerate() {
                occurrences[next[stop as usize]] = StopOccurrence {
                    pattern: u32::try_from(pattern).map_err(|_| EngineError::TimeOverflow)?,
                    position: u32::try_from(position).map_err(|_| EngineError::TimeOverflow)?,
                };
                next[stop as usize] += 1;
            }
        }
        let mut target_sensitive = vec![false; reader.num_trips()];
        for rule in &v2.rules.ordinary {
            if let Some(trip) = rule.to_trip {
                target_sensitive[trip as usize] = true;
            }
        }
        for rule in &v2.rules.linked {
            target_sensitive[rule.to_trip as usize] = true;
        }
        let shared_boarding_cost = index
            .routes
            .iter()
            .map(|route| {
                !route.trips.is_empty()
                    && route
                        .trips
                        .iter()
                        .all(|trip| !target_sensitive[trip.trip_idx as usize])
            })
            .collect();
        let mut scheduled = Vec::with_capacity(index.routes.len());
        for (pattern, route) in index.routes.iter().enumerate() {
            let mut stops = route.stop_ids.clone();
            stops.sort_unstable();
            stops.dedup();
            let eligible = v2.route_shape[pattern].0
                && stops.len() == route.stop_ids.len()
                && !route.trips.is_empty()
                && route.trips.iter().all(|trip| {
                    let t = trip.trip_idx as usize;
                    let info = v2.trips[t];
                    info.route == pattern as u32
                        && info.first_pos == 0
                        && info.last_pos as usize + 1 == route.stop_ids.len()
                        && !info.is_frequency
                        && trip.pos_to_row.iter().all(|&row| row != -1)
                        && !target_sensitive[t]
                        && !v2.rules.trip_has_from_rules[t]
                        && !v2.instance_level[t]
                        && !ordinary_instance_sensitive[t]
                });
            if !eligible {
                scheduled.push(None);
                continue;
            }
            let mut slots = Vec::with_capacity(route.stop_ids.len());
            for (position, &may_board) in boardable[pattern].iter().enumerate() {
                let mut order = Vec::new();
                if may_board {
                    for (slot, trip) in route.trips.iter().enumerate() {
                        order.push((
                            dep_secs_at(reader, trip, position)?,
                            u32::try_from(slot).map_err(|_| EngineError::TimeOverflow)?,
                        ));
                    }
                    order.sort_unstable();
                }
                slots.push(order.into_iter().map(|(_, slot)| slot).collect());
            }
            scheduled.push(Some(ScheduledBounds {
                slots,
                span: v2.route_shape[pattern]
                    .1
                    .checked_mul(2)
                    .ok_or(EngineError::TimeOverflow)?,
            }));
        }
        Ok(Self {
            index,
            offsets,
            occurrences,
            trip_sensitive: v2.rules.trip_has_from_rules.clone(),
            route_sensitive: v2.rules.route_has_from_rules.clone(),
            instance_sensitive: v2.instance_level.clone(),
            ordinary_instance_sensitive,
            boardable,
            scheduled,
            shared_boarding_cost,
        })
    }

    pub fn occurrences(&self, stop: u32) -> &[StopOccurrence] {
        let Some((&start, &end)) = self
            .offsets
            .get(stop as usize)
            .zip(self.offsets.get(stop as usize + 1))
        else {
            return &[];
        };
        &self.occurrences[start..end]
    }

    pub(super) fn may_board(&self, occurrence: &StopOccurrence) -> bool {
        self.boardable[occurrence.pattern as usize][occurrence.position as usize]
    }

    pub(super) fn scheduled(&self, pattern: u32) -> Option<&ScheduledBounds> {
        self.scheduled[pattern as usize].as_ref()
    }

    pub(super) fn shared_boarding_cost(&self, pattern: u32) -> bool {
        self.shared_boarding_cost[pattern as usize]
    }

    fn class(&self, state: &State) -> Class {
        let trip = state.inst.trip as usize;
        let v2 = self.index.v2.as_deref().expect("validated round index");
        let info = v2.trips[trip];
        let terminal = state.position == info.last_pos;
        let identity = if state.continuation_only || self.ordinary_instance_sensitive[trip] {
            Identity::Instance(state.inst, terminal)
        } else if self.trip_sensitive[trip] {
            Identity::Trip(state.inst.trip, terminal)
        } else if self.route_sensitive[info.reader_route as usize] {
            Identity::Route(info.reader_route)
        } else {
            Identity::None
        };
        Class {
            stop: state.stop,
            can_alight: state.can_alight,
            continuation_only: state.continuation_only,
            identity,
        }
    }
}

pub struct RoundProfileRequest<'a> {
    pub query: &'a Query,
    pub window: Range<i64>,
    pub transfers: Option<&'a Transfers>,
    pub max_entry_events: usize,
    pub max_accepted_states: usize,
    pub max_bag_width: usize,
    /// Bounds concrete candidates plus source registrations before buffering.
    pub max_board_candidates: usize,
    /// Disable both optimizations to retain the exact differential reference.
    pub enable_scheduled_bounds: bool,
    /// Prune equivalent incoming sources after resolving their boarding costs.
    pub enable_source_frontiers: bool,
}

impl<'a> RoundProfileRequest<'a> {
    pub fn new(query: &'a Query, window: Range<i64>) -> Self {
        Self {
            query,
            window,
            transfers: None,
            max_entry_events: 100_000,
            max_accepted_states: 250_000,
            max_bag_width: 64,
            max_board_candidates: 10_000_000,
            enable_scheduled_bounds: true,
            enable_source_frontiers: true,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoundProfileError {
    Engine(EngineError),
    InvalidRequest(&'static str),
    EntryEventsExhausted { limit: usize, attempted: usize },
    StatesExhausted { limit: usize, attempted: usize },
    BagWidthExhausted { limit: usize, attempted: usize },
    BoardCandidatesExhausted { limit: usize, attempted: usize },
}

impl From<EngineError> for RoundProfileError {
    fn from(e: EngineError) -> Self {
        Self::Engine(e)
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RoundDiagnostics {
    pub rounds: usize,
    pub pattern_scans: usize,
    pub exact_fallback_scans: usize,
    pub bounded_pattern_scans: usize,
    pub bounded_board_sources: usize,
    /// Scheduled eligibility probes, not concrete boardings or arena states.
    pub scheduled_trip_checks: usize,
    /// Guarded pattern drains; target-trip-specific rules retain all sources.
    pub source_frontier_patterns: usize,
    /// Per-position sources, including repeated stop occurrences.
    pub source_frontier_inputs: usize,
    /// Rejected new sources plus old sources replaced by a better source.
    pub source_frontier_pruned: usize,
    pub source_frontier_survivors: usize,
    /// Separately counted; each frontier is bounded by max_bag_width.
    pub source_frontier_comparisons: usize,
    pub max_source_frontier_width: usize,
    pub board_candidates: usize,
    /// Included in board_candidates; bounds intermediate marked-pattern work.
    pub source_registrations: usize,
    pub accepted_states: usize,
    pub dominated_states: usize,
    pub max_bag_width: usize,
    pub continuation_candidates: usize,
    pub arena_bytes: usize,
}

pub struct RoundProfileResult {
    pub page: R3ProfilePage,
    pub diagnostics: RoundDiagnostics,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum Identity {
    None,
    Route(u32),
    Trip(u32, bool),
    Instance(Inst, bool),
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct Class {
    stop: u32,
    can_alight: bool,
    continuation_only: bool,
    identity: Identity,
}

pub(super) struct Control<'a> {
    pub(super) index: &'a RoundProfileIndex<'a>,
    bags: HashMap<Class, Vec<usize>, FxBuildHasher>,
    active: Vec<bool>,
    objective: ProfileObjectives,
    max_states: usize,
    max_width: usize,
    max_candidates: usize,
    pub(super) diagnostics: RoundDiagnostics,
}

impl Control<'_> {
    pub(super) fn objective(&self) -> ProfileObjectives {
        self.objective
    }

    pub(super) fn mark_source(&mut self) -> Result<(), RoundProfileError> {
        self.before_board()?;
        increment(&mut self.diagnostics.source_registrations)?;
        Ok(())
    }
}

fn no_worse(a: &State, b: &State, objective: ProfileObjectives) -> bool {
    a.rounds <= b.rounds
        && a.origin_departure >= b.origin_departure
        && a.time <= b.time
        && a.transfers <= b.transfers
        && (objective == ProfileObjectives::R3 || a.walk <= b.walk)
}

fn equal_budget(a: &State, b: &State) -> bool {
    (a.rounds, a.origin_departure, a.time, a.transfers)
        == (b.rounds, b.origin_departure, b.time, b.transfers)
}

fn witness(state: &State, arena: &[State]) -> Vec<R3TransitWitness> {
    let mut out = vec![state.leg];
    let mut parent = state.parent;
    while let Some(id) = parent {
        let p = &arena[id];
        out.push(p.leg);
        parent = p.parent;
    }
    out.reverse();
    out
}

fn preferred(a: &State, b: &State, arena: &[State]) -> bool {
    a.walk < b.walk || (a.walk == b.walk && witness(a, arena) < witness(b, arena))
}

impl Strategy for Control<'_> {
    type Error = RoundProfileError;

    fn before_board(&mut self) -> Result<(), Self::Error> {
        if self.diagnostics.board_candidates >= self.max_candidates {
            return Err(RoundProfileError::BoardCandidatesExhausted {
                limit: self.max_candidates,
                attempted: self.diagnostics.board_candidates.saturating_add(1),
            });
        }
        increment(&mut self.diagnostics.board_candidates)?;
        Ok(())
    }

    fn accept(
        &mut self,
        candidate: &State,
        arena: &[State],
        _: usize,
    ) -> Result<bool, Self::Error> {
        let class = self.index.class(candidate);
        let ids = self.bags.get(&class).map(|b| b.as_slice()).unwrap_or(&[]);
        for &id in ids {
            let old = &arena[id];
            if no_worse(old, candidate, self.objective)
                && !(equal_budget(old, candidate) && preferred(candidate, old, arena))
            {
                increment(&mut self.diagnostics.dominated_states)?;
                return Ok(false);
            }
        }
        let kills: Vec<_> = ids
            .iter()
            .copied()
            .filter(|&id| no_worse(candidate, &arena[id], self.objective))
            .collect();
        let width = ids.len() - kills.len() + 1;
        if width > self.max_width {
            return Err(RoundProfileError::BagWidthExhausted {
                limit: self.max_width,
                attempted: width,
            });
        }
        if arena.len() >= self.max_states {
            return Err(RoundProfileError::StatesExhausted {
                limit: self.max_states,
                attempted: arena.len().saturating_add(1),
            });
        }
        let bag = self.bags.entry(class).or_default();
        for id in kills {
            self.active[id] = false;
            increment(&mut self.diagnostics.dominated_states)?;
        }
        bag.retain(|&id| self.active[id]);
        bag.push(candidate.id);
        self.active.push(true);
        self.diagnostics.max_bag_width = self.diagnostics.max_bag_width.max(width);
        increment(&mut self.diagnostics.accepted_states)?;
        Ok(true)
    }

    fn active(&self, id: usize) -> bool {
        self.active[id]
    }
    fn split_continuations(&self, trip: u32) -> bool {
        self.index.instance_sensitive[trip as usize]
    }
}

pub fn profile_round_r3<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    acceleration: &RoundProfileIndex<'_>,
    request: RoundProfileRequest<'_>,
) -> Result<RoundProfileResult, RoundProfileError> {
    profile(reader, index, acceleration, request, ProfileObjectives::R3)
}

pub fn profile_round_m4<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    acceleration: &RoundProfileIndex<'_>,
    request: RoundProfileRequest<'_>,
) -> Result<RoundProfileResult, RoundProfileError> {
    profile(reader, index, acceleration, request, ProfileObjectives::M4)
}

fn profile<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    acceleration: &RoundProfileIndex<'_>,
    request: RoundProfileRequest<'_>,
    objective: ProfileObjectives,
) -> Result<RoundProfileResult, RoundProfileError> {
    if !core::ptr::eq(index, acceleration.index) {
        return Err(EngineError::IndexBundleMismatch.into());
    }
    if request.window.start >= request.window.end {
        return Err(RoundProfileError::InvalidRequest(
            "round window must be nonempty",
        ));
    }
    if [
        request.max_entry_events,
        request.max_accepted_states,
        request.max_bag_width,
        request.max_board_candidates,
    ]
    .contains(&0)
    {
        return Err(RoundProfileError::InvalidRequest(
            "round resource limits must be positive",
        ));
    }
    let control = Control {
        index: acceleration,
        bags: HashMap::with_hasher(FxBuildHasher),
        active: Vec::new(),
        objective,
        max_states: request.max_accepted_states,
        max_width: request.max_bag_width,
        max_candidates: request.max_board_candidates,
        diagnostics: RoundDiagnostics::default(),
    };
    super::v2::run_round(reader, index, request, control)
}

pub(super) fn increment(counter: &mut usize) -> Result<(), EngineError> {
    *counter = counter.checked_add(1).ok_or(EngineError::TimeOverflow)?;
    Ok(())
}
