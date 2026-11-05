//! Optional legal incumbents, never a departure/route coverage certificate.
//! Heuristic state loss only weakens the seeds. Reference forward primitives
//! retain movement, pickup/drop-off, concrete date/frequency and loop identity.
//! GTFS: https://gtfs.org/documentation/schedule/reference/#transferstxt
//! https://gtfs.org/documentation/schedule/reference/#frequenciestxt
//! https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes

use super::*;
use crate::engine::temporal_probe::{
    r3::R3Point,
    v2::{insert_point, run_candidate_shot},
    EntryEvent,
};
use alloc::collections::{BTreeMap, BTreeSet};

const MAX_ROOTS: usize = 16;
const SHOT_STOP_LIMIT: usize = 25_000;
const SHOT_LOOKUP_LIMIT: usize = 25_000;
const SHOT_STATES: usize = 4096;
const LOOKAHEAD: i64 = 90 * 60;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ForwardSeedDiagnostics {
    pub enabled: bool,
    pub selection_checks: usize,
    pub root_candidates: usize,
    pub shots: usize,
    pub truncated_shots: usize,
    pub stop_scans: usize,
    pub lookup_work: usize,
    pub accepted_states: usize,
    pub incumbents: usize,
    pub certified_prunes: usize,
    /// Maximum logical state/heap bytes; excludes map/capacity/allocator costs.
    pub arena_bytes: usize,
}
impl ForwardSeedDiagnostics {
    pub fn stop_work(&self) -> usize {
        self.selection_checks + self.stop_scans
    }
}

enum SeedError {
    Engine(EngineError),
    Hard(DeadlineError),
    Truncated,
    Found,
}
impl From<EngineError> for SeedError {
    fn from(e: EngineError) -> Self {
        Self::Engine(e)
    }
}

struct Sampler<'a> {
    diagnostics: &'a mut ForwardSeedDiagnostics,
    request: &'a DeadlineRequest<'a>,
    before_stop: usize,
    local_stop: usize,
    local_lookup: usize,
    local_states: usize,
    ceiling: i64,
    best: BTreeMap<(u32, u32), usize>,
    active: Vec<bool>,
    boarded: BTreeSet<(usize, u32, u32)>,
}
impl Strategy for Sampler<'_> {
    type Error = SeedError;
    fn before_stop(&mut self) -> Result<(), SeedError> {
        let attempted = self
            .before_stop
            .checked_add(self.diagnostics.stop_work())
            .and_then(|n| n.checked_add(1))
            .ok_or(EngineError::TimeOverflow)?;
        if attempted > self.request.max_stop_scans {
            return Err(SeedError::Hard(DeadlineError::StopScansExhausted {
                limit: self.request.max_stop_scans,
                attempted,
            }));
        }
        if self.local_stop >= SHOT_STOP_LIMIT {
            return Err(SeedError::Truncated);
        }
        self.local_stop += 1;
        self.diagnostics.stop_scans += 1;
        Ok(())
    }
    fn before_trip(&mut self) -> Result<(), SeedError> {
        self.before_board()
    }
    fn before_board(&mut self) -> Result<(), SeedError> {
        let attempted = self
            .diagnostics
            .lookup_work
            .checked_add(1)
            .ok_or(EngineError::TimeOverflow)?;
        if attempted > self.request.max_lookup_work {
            return Err(SeedError::Hard(
                LazyLookupError::WorkExhausted {
                    limit: self.request.max_lookup_work,
                    attempted,
                }
                .into(),
            ));
        }
        if self.local_lookup >= SHOT_LOOKUP_LIMIT {
            return Err(SeedError::Truncated);
        }
        self.local_lookup += 1;
        self.diagnostics.lookup_work = attempted;
        Ok(())
    }
    fn deadline_ceiling(&self) -> Option<i64> {
        Some(self.ceiling)
    }
    fn eager_destinations(&self) -> bool {
        true
    }
    fn after_destinations(&mut self, points: &[R3Point]) -> Result<(), SeedError> {
        if points
            .iter()
            .any(|p| p.destination_arrival_secs <= self.request.arrival_deadline)
        {
            Err(SeedError::Found)
        } else {
            Ok(())
        }
    }
    fn observe_board(&mut self, state: &State, boarding: &Boarding) -> Result<bool, SeedError> {
        // Sampling only: no earliest-vehicle or overtaking claim.
        Ok(self
            .boarded
            .insert((state.id, boarding.route, boarding.position)))
    }
    fn accept(&mut self, state: &State, arena: &[State], _: usize) -> Result<bool, SeedError> {
        if !state.can_alight {
            return Ok(false);
        }
        let key = (state.stop, state.rounds);
        if let Some(&old) = self.best.get(&key) {
            let a = arena[old];
            if (a.time, a.transfers, a.walk) <= (state.time, state.transfers, state.walk) {
                return Ok(false);
            }
        }
        let attempted = self
            .diagnostics
            .accepted_states
            .checked_add(1)
            .ok_or(EngineError::TimeOverflow)?;
        if attempted > self.request.max_segments {
            return Err(SeedError::Hard(DeadlineError::SegmentsExhausted {
                limit: self.request.max_segments,
                attempted,
            }));
        }
        if self.local_states >= SHOT_STATES {
            return Err(SeedError::Truncated);
        }
        if let Some(old) = self.best.insert(key, arena.len()) {
            self.active[old] = false;
        }
        self.active.push(true);
        self.local_states += 1;
        self.diagnostics.accepted_states = attempted;
        Ok(true)
    }
    fn active(&self, id: usize) -> bool {
        self.active[id]
    }
}

pub(super) fn build<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    catalogue: &EventIndex,
    request: &DeadlineRequest<'_>,
    entries: &BTreeMap<u32, Vec<u32>>,
    before_stop: usize,
    eligible: bool,
) -> Result<(Vec<R3Point>, ForwardSeedDiagnostics), DeadlineError> {
    let mut d = ForwardSeedDiagnostics::default();
    let mut points = Vec::new();
    if !request.forward_seeds || !eligible {
        return Ok((points, d));
    }
    d.enabled = true;
    let last = request.window.end - 1;
    let mid = request
        .window
        .start
        .checked_add(
            last.checked_sub(request.window.start)
                .ok_or(EngineError::TimeOverflow)?
                / 2,
        )
        .ok_or(EngineError::TimeOverflow)?;
    let targets = [last, mid, request.window.start];
    let mut buckets: [(Option<i64>, Vec<EntryEvent>, bool); 3] =
        core::array::from_fn(|_| (None, Vec::new(), false));
    for &event in catalogue.events() {
        let attempted = before_stop
            .checked_add(d.stop_work())
            .and_then(|n| n.checked_add(1))
            .ok_or(EngineError::TimeOverflow)?;
        if attempted > request.max_stop_scans {
            return Err(DeadlineError::StopScansExhausted {
                limit: request.max_stop_scans,
                attempted,
            });
        }
        d.selection_checks += 1;
        if !event.can_board() {
            continue;
        }
        let stop = index.routes[event.route_idx as usize].stop_ids[event.position as usize];
        let Some(access) = entries.get(&stop) else {
            continue;
        };
        for &walk in access {
            let attempted = before_stop
                .checked_add(d.stop_work())
                .and_then(|n| n.checked_add(1))
                .ok_or(EngineError::TimeOverflow)?;
            if attempted > request.max_stop_scans {
                return Err(DeadlineError::StopScansExhausted {
                    limit: request.max_stop_scans,
                    attempted,
                });
            }
            d.selection_checks += 1;
            let origin = event
                .departure_secs
                .checked_sub(walk as i64)
                .ok_or(EngineError::TimeOverflow)?;
            if !request.window.contains(&origin) {
                continue;
            }
            d.root_candidates += 1;
            let root = EntryEvent {
                service_date: crate::reader::days_add(
                    reader.feed_start_date(),
                    event.date_ordinal as i64,
                ),
                route_idx: event.route_idx,
                trip_idx: event.trip_idx,
                board_position: event.position,
                origin_ready_secs: origin,
                effective_board_secs: event.departure_secs,
                frequency_offset_secs: event.frequency_offset_secs,
            };
            for (i, (at, roots, truncated)) in buckets.iter_mut().enumerate() {
                if origin > targets[i] || at.is_some_and(|old| origin < old) {
                    continue;
                }
                if *at != Some(origin) {
                    *at = Some(origin);
                    roots.clear();
                    *truncated = false;
                }
                if roots.len() < MAX_ROOTS {
                    roots.push(root);
                } else {
                    *truncated = true;
                }
            }
        }
    }
    let ordinal = time::date_ordinal(reader, request.query.date)
        .ok_or(EngineError::UnsupportedServiceDate)?;
    let origin_unix = time::origin(reader, ordinal)?;
    let mut previous = Vec::new();
    for (at, roots, roots_truncated) in buckets {
        let Some(at) = at else {
            continue;
        };
        if previous.contains(&at) {
            continue;
        }
        previous.push(at);
        d.shots += 1;
        let ceiling = at
            .checked_add(LOOKAHEAD)
            .ok_or(EngineError::TimeOverflow)?
            .min(request.arrival_deadline);
        let sampler = Sampler {
            diagnostics: &mut d,
            request,
            before_stop,
            local_stop: 0,
            local_lookup: 0,
            local_states: 0,
            ceiling,
            best: BTreeMap::new(),
            active: Vec::new(),
            boarded: BTreeSet::new(),
        };
        let (candidates, _, outcome, bytes) = run_candidate_shot(
            reader,
            index,
            request.query,
            request.transfers,
            &roots,
            origin_unix,
            request.objectives,
            request.arrival_deadline,
            sampler,
        );
        d.arena_bytes = d.arena_bytes.max(bytes);
        let cut = match outcome {
            Ok(()) => false,
            Err(SeedError::Found) => false,
            Err(SeedError::Truncated) => true,
            Err(SeedError::Engine(e)) => return Err(e.into()),
            Err(SeedError::Hard(e)) => return Err(e),
        };
        d.truncated_shots += usize::from(cut || roots_truncated);
        for p in candidates {
            if request.window.contains(&p.origin_departure_secs)
                && p.destination_arrival_secs <= request.arrival_deadline
            {
                insert_point(&mut points, p, request.objectives);
            }
        }
    }
    d.incumbents = points.len();
    Ok((points, d))
}
