//! H58 phase A: the latest departure by a backward round scan over concrete
//! trip instances, without a request catalogue. Labels are latest times per
//! stop and ride budget; only the origin applies the departure window.
//!
//! Movements mirror the v2 reference: egress at the alighting stop or after
//! one directed PTFT walk; same-stop boarding after the global minimum; PTFT
//! boarding after the larger of that and the walk; derived block
//! continuations at a trip's last position (a round, no passenger transfer,
//! no minimum, allowed without drop-off). Scope: no ordinary or linked
//! `transfers.txt` rows and no frequencies (so transfers depend only on
//! stops), and a deadline at most 48 h after the window start (so the horizon
//! cannot bind). Anything else is [`LatestScanError::Unsupported`].
//! GTFS: <https://gtfs.org/documentation/schedule/reference/#stop_timestxt>,
//! <https://gtfs.org/documentation/schedule/reference/#transferstxt>.

use super::*;
use crate::engine::consts::{rescale_walk_secs, RAPTOR_MAX_ROUNDS};
use alloc::vec;
use hashbrown::HashMap;
use rustc_hash::FxBuildHasher;

const UNREACHED: i64 = i64::MIN;
const BOARD: u8 = 1;
const ALIGHT: u8 = 2;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LatestScanError {
    Engine(EngineError),
    /// Outside the scan's scope: the caller runs the full request instead.
    Unsupported(&'static str),
}

impl From<EngineError> for LatestScanError {
    fn from(error: EngineError) -> Self {
        Self::Engine(error)
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct LatestScanDiagnostics {
    /// The owner-level scan index was built by this call.
    pub index_built: bool,
    pub dates: usize,
    pub instances: usize,
    pub template_positions: usize,
    pub position_scans: usize,
    pub label_relaxations: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LatestScanResult {
    /// The latest origin departure inside the window of any journey that
    /// arrives by the deadline within the round cap; `None` when none does.
    /// A departure, not a journey: phase B certifies the winner.
    pub departure: Option<i64>,
    pub diagnostics: LatestScanDiagnostics,
}

/// H81: a selector whose first key is not the departure, reduced like H58.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectorScanResult {
    /// The selector's optimal first key over the window: passenger transfers
    /// or total walk seconds; `None` when no journey arrives by the deadline.
    pub optimum: Option<u64>,
    /// The latest origin departure inside the window among journeys with
    /// that optimum. A departure, not a journey: the selector on
    /// `[departure, departure + 1)` certifies the winner.
    pub departure: Option<i64>,
    pub diagnostics: LatestScanDiagnostics,
}

/// Owner-level data reused across requests: each route's routable slots in
/// first-departure order with their span bounds, and every stop's directed
/// PTFT walks deduplicated to the shortest, as `physical_walks` does.
pub(super) struct LatestScanIndex {
    unsupported: Option<&'static str>,
    route_starts: Vec<u32>,
    slots: Vec<u32>,
    /// Per route: the smallest span start and largest span end of its slots.
    route_bounds: Vec<(i64, i64)>,
    walk_starts: Vec<u32>,
    /// `(to stop, raw seconds)`; rescaled for wheelchair at use (monotone).
    walks: Vec<(u32, u32)>,
}

impl LatestScanIndex {
    pub(super) fn build<B: AsRef<[u8]> + Send + Sync + 'static>(
        reader: &Reader<B>,
        index: &Index,
        transfers: Option<&Transfers>,
        spans: &TripSpans,
    ) -> Result<Self, EngineError> {
        let v2 = index.v2.as_deref().ok_or(EngineError::UnsupportedVersion)?;
        let mut unsupported = if !v2.rules.ordinary.is_empty() || !v2.rules.linked.is_empty() {
            Some("explicit transfer rules")
        } else if !v2.freq.is_empty() {
            Some("frequencies")
        } else {
            None
        };
        let mut route_starts = Vec::with_capacity(index.routes.len() + 1);
        let mut slots = Vec::new();
        let mut route_bounds = Vec::with_capacity(index.routes.len());
        for (ri, route) in index.routes.iter().enumerate() {
            route_starts.push(slots.len() as u32);
            let start = slots.len();
            let (mut lo, mut hi) = (i64::MAX, i64::MIN);
            for (slot, trip) in route.trips.iter().enumerate() {
                if v2.trips[trip.trip_idx as usize].route == u32::MAX {
                    continue;
                }
                match spans.get(ri, slot) {
                    Some((l, h)) => {
                        lo = lo.min(l);
                        hi = hi.max(h);
                        slots.push(slot as u32);
                    }
                    None => unsupported = unsupported.or(Some("trip span")),
                }
            }
            slots[start..].sort_unstable_by_key(|&s| {
                (v2.first_dep[route.trips[s as usize].trip_idx as usize], s)
            });
            route_bounds.push((lo, hi));
        }
        route_starts.push(slots.len() as u32);
        let mut walk_starts = Vec::with_capacity(reader.num_stops() + 1);
        let mut walks = Vec::new();
        let mut stop_walks = Vec::new();
        for stop in 0..reader.num_stops() {
            walk_starts.push(walks.len() as u32);
            stop_walks.clear();
            if let Some(table) = transfers {
                if let Some(i) = table.index_of(reader.stop_id(stop)?) {
                    let (neighbors, seconds) = table.edges(i);
                    for (&n, &w) in neighbors.iter().zip(seconds) {
                        if let Some(to) = reader.stop_index(table.stop_id(n)) {
                            if to as usize != stop {
                                stop_walks.push((to, w));
                            }
                        }
                    }
                }
            }
            stop_walks.sort_unstable();
            stop_walks.dedup_by_key(|e| e.0);
            walks.extend_from_slice(&stop_walks);
        }
        walk_starts.push(walks.len() as u32);
        Ok(Self {
            unsupported,
            route_starts,
            slots,
            route_bounds,
            walk_starts,
            walks,
        })
    }

    pub(super) fn bytes(&self) -> usize {
        len_bytes(&self.route_starts)
            + len_bytes(&self.slots)
            + len_bytes(&self.route_bounds)
            + len_bytes(&self.walk_starts)
            + len_bytes(&self.walks)
    }

    fn walks_from(&self, stop: usize) -> &[(u32, u32)] {
        &self.walks[self.walk_starts[stop] as usize..self.walk_starts[stop + 1] as usize]
    }
}

struct Instance {
    trip: u32,
    date: u32,
    base: i64,
    template: (u32, u32),
}

/// One served position of a trip: position, stop, arrival, departure, flags.
type Served = (u32, u32, i64, i64, u8);

/// The request-local part every scan shares: concrete trip instances that can
/// have an event in `[window start, deadline]`, the caller's egress and access
/// walks, and the movement rules. Labels differ per scan.
struct Scan<'a> {
    v2: &'a crate::engine::v2::V2Index,
    scan: &'a LatestScanIndex,
    window: Range<i64>,
    deadline: i64,
    rounds: usize,
    /// Smallest caller egress walk per exit stop; `u32::MAX` if not an exit.
    egress_walk: Vec<u32>,
    entries: HashMap<u32, Vec<i64>, FxBuildHasher>,
    walk_speed: u32,
    min_transfer: i64,
    served: Vec<Served>,
    instances: Vec<Instance>,
    by_vehicle: HashMap<(u32, u32), u32, FxBuildHasher>,
    diagnostics: LatestScanDiagnostics,
}

enum Setup<'a> {
    /// No journey can exist (no rounds, or the deadline precedes the window).
    Empty(LatestScanDiagnostics),
    Ready(Scan<'a>),
}

#[allow(clippy::too_many_arguments)]
fn setup<'a, B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &'a Index,
    spans: &TripSpans,
    scan: &'a LatestScanIndex,
    query: &Query,
    window: Range<i64>,
    deadline: i64,
    index_built: bool,
) -> Result<Setup<'a>, LatestScanError> {
    if let Some(why) = scan.unsupported {
        return Err(LatestScanError::Unsupported(why));
    }
    let v2 = index.v2.as_deref().ok_or(EngineError::UnsupportedVersion)?;
    if window.start >= window.end {
        return Err(LatestScanError::Unsupported("empty window"));
    }
    if deadline
        .checked_sub(window.start)
        .is_none_or(|span| span > time::ROUTING_HORIZON_SECS)
    {
        return Err(LatestScanError::Unsupported("deadline beyond the horizon"));
    }
    // The catalogue's coverage rule for `[window start, deadline]`: every
    // service date with an event inside must be routable.
    let ordinal =
        time::date_ordinal(reader, query.date).ok_or(EngineError::UnsupportedServiceDate)?;
    let origin_unix = time::origin(reader, ordinal)?;
    let first_complete = time::origin(reader, 0)?
        .checked_add(v2.max_event_secs)
        .ok_or(EngineError::TimeOverflow)?;
    let next_missing = time::origin(reader, time::routable_dates(reader))?
        .checked_add(v2.min_event_secs.min(0))
        .ok_or(EngineError::TimeOverflow)?;
    let unix = |t: i64| origin_unix.checked_add(t).ok_or(EngineError::TimeOverflow);
    if unix(window.start)? < first_complete || unix(deadline.max(window.start))? >= next_missing {
        return Err(EngineError::IncompleteHorizon.into());
    }
    let mut diagnostics = LatestScanDiagnostics {
        index_built,
        ..LatestScanDiagnostics::default()
    };
    let rounds = query.max_rounds.unwrap_or(RAPTOR_MAX_ROUNDS) as usize;
    if rounds == 0 || deadline < window.start {
        return Ok(Setup::Empty(diagnostics));
    }
    let dates = time::candidate_dates(
        reader,
        unix(window.start)?,
        unix(deadline)?,
        v2.min_event_secs,
        v2.max_event_secs,
    )?;
    let mut shifts = Vec::with_capacity(dates.len());
    for d in dates {
        let shift = time::origin(reader, d)?
            .checked_sub(origin_unix)
            .ok_or(EngineError::TimeOverflow)?;
        shifts.push((d as u32, shift));
    }
    diagnostics.dates = shifts.len();

    let n = reader.num_stops();
    // 0 = unknown, 1 = accessible, 2 = not (wheelchair only).
    let mut access = vec![0u8; n];
    let mut accessible = |stop: u32| -> Result<bool, EngineError> {
        let a = &mut access[stop as usize];
        if *a == 0 {
            *a = if inaccessible(reader, query, stop)? {
                2
            } else {
                1
            };
        }
        Ok(*a == 1)
    };
    let mut egress_walk = vec![u32::MAX; n];
    for e in &query.exit_stops {
        if (e.stop as usize) < n && accessible(e.stop)? {
            let at = &mut egress_walk[e.stop as usize];
            *at = (*at).min(e.walk_secs);
        }
    }
    let mut entries: HashMap<u32, Vec<i64>, FxBuildHasher> = HashMap::default();
    for e in &query.entry_stops {
        if (e.stop as usize) < n && accessible(e.stop)? {
            entries.entry(e.stop).or_default().push(e.walk_secs as i64);
        }
    }
    let walk_speed = query.transfer_walk_speed_mm_s();
    let min_transfer = query.min_transfer_floor_secs();

    // Instances that can have an event in [window start, deadline].
    let mut served: Vec<Served> = Vec::new();
    let mut templates: HashMap<u32, (u32, u32), FxBuildHasher> = HashMap::default();
    let mut instances: Vec<Instance> = Vec::new();
    for (ri, route) in index.routes.iter().enumerate() {
        let (lo_r, hi_r) = scan.route_bounds[ri];
        if lo_r > hi_r || !route_allowed(route, query) {
            continue;
        }
        let route_slots =
            &scan.slots[scan.route_starts[ri] as usize..scan.route_starts[ri + 1] as usize];
        let first_dep = |s: u32| v2.first_dep[route.trips[s as usize].trip_idx as usize];
        for &(date, shift) in &shifts {
            let from = window.start - hi_r - shift;
            let to = deadline - lo_r - shift;
            let begin = route_slots.partition_point(|&s| first_dep(s) < from);
            for &s in &route_slots[begin..] {
                let fd = first_dep(s);
                if fd > to {
                    break;
                }
                let trip = &route.trips[s as usize];
                let (lo, hi) = spans.get(ri, s as usize).expect("routable slot has a span");
                let key = shift + fd;
                if key + hi < window.start
                    || key + lo > deadline
                    || !trip_allowed(trip, query)
                    || !reader.service_active_on_day(trip.service_idx, date)
                {
                    continue;
                }
                let template = match templates.get(&trip.trip_idx) {
                    Some(&t) => t,
                    None => {
                        let info = v2.trips[trip.trip_idx as usize];
                        let begin = served.len() as u32;
                        for pos in info.first_pos as usize..=info.last_pos as usize {
                            if trip.pos_to_row[pos] == -1 {
                                continue;
                            }
                            let stop = route.stop_ids[pos];
                            let ok = accessible(stop)?;
                            let mut flags = 0;
                            if pos < info.last_pos as usize
                                && !pickup_forbidden_at(reader, trip, pos)
                                && ok
                            {
                                flags |= BOARD;
                            }
                            if !drop_off_forbidden_at(reader, trip, pos) && ok {
                                flags |= ALIGHT;
                            }
                            served.push((
                                pos as u32,
                                stop,
                                alight_secs_at(reader, trip, pos)?,
                                dep_secs_at(reader, trip, pos)?,
                                flags,
                            ));
                        }
                        let t = (begin, served.len() as u32);
                        templates.insert(trip.trip_idx, t);
                        t
                    }
                };
                instances.push(Instance {
                    trip: trip.trip_idx,
                    date,
                    base: shift,
                    template,
                });
            }
        }
    }
    diagnostics.instances = instances.len();
    diagnostics.template_positions = served.len();
    let mut by_vehicle: HashMap<(u32, u32), u32, FxBuildHasher> = HashMap::default();
    if !v2.derived.is_empty() {
        for (i, inst) in instances.iter().enumerate() {
            by_vehicle.entry((inst.trip, inst.date)).or_insert(i as u32);
        }
    }
    Ok(Setup::Ready(Scan {
        v2,
        scan,
        window,
        deadline,
        rounds,
        egress_walk,
        entries,
        walk_speed,
        min_transfer,
        served,
        instances,
        by_vehicle,
        diagnostics,
    }))
}

impl Scan<'_> {
    fn template(&self, inst: &Instance) -> &[Served] {
        &self.served[inst.template.0 as usize..inst.template.1 as usize]
    }

    /// The instance index of the derived continuation targets of `inst`.
    fn derived_targets<'s>(&'s self, inst: &Instance) -> impl Iterator<Item = (usize, i64)> + 's {
        let date = inst.date;
        self.v2
            .derived
            .get(&(inst.trip, date))
            .into_iter()
            .flatten()
            .filter_map(move |&t| {
                self.by_vehicle.get(&(t, date)).map(|&j| {
                    let j = j as usize;
                    (j, self.instances[j].base + self.v2.first_dep[t as usize])
                })
            })
    }

    /// Round 0 time labels: alighting at a stop, then egress there or after
    /// one walk, as the latest time that still meets the deadline.
    fn egress_times(&self) -> Vec<i64> {
        let n = self.egress_walk.len();
        let at_exit = |s: usize| {
            let w = self.egress_walk[s];
            (w != u32::MAX).then(|| self.deadline - w as i64)
        };
        let mut alight = vec![UNREACHED; n];
        for (s, at) in alight.iter_mut().enumerate() {
            if let Some(e) = at_exit(s) {
                *at = e;
            }
            for &(to, raw) in self.scan.walks_from(s) {
                if let Some(e) = at_exit(to as usize) {
                    let left = e - rescale_walk_secs(raw, self.walk_speed);
                    if left > *at {
                        *at = left;
                    }
                }
            }
        }
        alight
    }

    /// H58: the latest origin departure of any journey.
    fn latest(self) -> LatestScanResult {
        let mut diagnostics = self.diagnostics;
        let n = self.egress_walk.len();
        let rounds = self.rounds;
        let mut alight = self.egress_times();
        let mut best: Option<i64> = None;
        // A ride from an instance's first position was feasible in the last round.
        let mut ride_from_first = vec![false; self.instances.len()];
        let mut ride_now = vec![false; self.instances.len()];
        let mut board = vec![UNREACHED; n];
        for k in 1..=rounds {
            board.fill(UNREACHED);
            for (i, inst) in self.instances.iter().enumerate() {
                let template = self.template(inst);
                let last = template.len() - 1;
                let mut feasible = false;
                for (idx, &(_, stop, arrival, departure, flags)) in
                    template.iter().enumerate().rev()
                {
                    diagnostics.position_scans += 1;
                    if feasible && flags & BOARD != 0 {
                        let b = inst.base + departure;
                        if b > board[stop as usize] {
                            board[stop as usize] = b;
                        }
                        if let Some(walks) = self.entries.get(&stop) {
                            for &w in walks {
                                let origin = b - w;
                                if self.window.contains(&origin) && best.is_none_or(|x| origin > x)
                                {
                                    best = Some(origin);
                                }
                            }
                        }
                    }
                    if idx == 0 {
                        ride_now[i] = feasible;
                        break;
                    }
                    if feasible {
                        continue;
                    }
                    let a = inst.base + arrival;
                    if flags & ALIGHT != 0 && a <= alight[stop as usize] {
                        feasible = true;
                    } else if idx == last && k >= 2 {
                        feasible = self
                            .derived_targets(inst)
                            .any(|(j, first)| ride_from_first[j] && first >= a);
                    }
                }
            }
            core::mem::swap(&mut ride_from_first, &mut ride_now);
            if k == rounds {
                break;
            }
            for (s, label) in alight.iter_mut().enumerate() {
                let mut at = *label;
                if board[s] != UNREACHED {
                    at = at.max(board[s] - self.min_transfer);
                }
                for &(to, raw) in self.scan.walks_from(s) {
                    diagnostics.label_relaxations += 1;
                    let b = board[to as usize];
                    if b != UNREACHED {
                        at = at.max(
                            b - self
                                .min_transfer
                                .max(rescale_walk_secs(raw, self.walk_speed)),
                        );
                    }
                }
                *label = at;
            }
        }
        LatestScanResult {
            departure: best,
            diagnostics,
        }
    }

    /// H81: per passenger-transfer budget `x`, the latest origin departure of
    /// a journey with at most `x` transfers. A same-stop or walking change
    /// moves from budget `x - 1` to `x`; a derived continuation keeps it.
    fn fewest_transfers(self) -> SelectorScanResult {
        let mut diagnostics = self.diagnostics;
        let n = self.egress_walk.len();
        let rounds = self.rounds;
        // At most rounds - 1 transfers; budget x is stored at x * n + stop.
        let budgets = rounds;
        let egress = self.egress_times();
        let mut alight = Vec::with_capacity(budgets * n);
        for _ in 0..budgets {
            alight.extend_from_slice(&egress);
        }
        let mut best: Vec<Option<i64>> = vec![None; budgets];
        let m = self.instances.len();
        let mut ride_from_first = vec![false; budgets * m];
        let mut ride_now = vec![false; budgets * m];
        let mut board = vec![UNREACHED; budgets * n];
        let mut feasible = vec![false; budgets];
        for k in 1..=rounds {
            board.fill(UNREACHED);
            for (i, inst) in self.instances.iter().enumerate() {
                let template = self.template(inst);
                let last = template.len() - 1;
                feasible.fill(false);
                for (idx, &(_, stop, arrival, departure, flags)) in
                    template.iter().enumerate().rev()
                {
                    diagnostics.position_scans += 1;
                    if flags & BOARD != 0 {
                        let b = inst.base + departure;
                        for (x, _) in feasible.iter().enumerate().filter(|(_, f)| **f) {
                            let slot = &mut board[x * n + stop as usize];
                            if b > *slot {
                                *slot = b;
                            }
                            if let Some(walks) = self.entries.get(&stop) {
                                for &w in walks {
                                    let origin = b - w;
                                    if self.window.contains(&origin)
                                        && best[x].is_none_or(|y| origin > y)
                                    {
                                        best[x] = Some(origin);
                                    }
                                }
                            }
                        }
                    }
                    if idx == 0 {
                        for x in 0..budgets {
                            ride_now[x * m + i] = feasible[x];
                        }
                        break;
                    }
                    if feasible.iter().all(|f| *f) {
                        continue;
                    }
                    let a = inst.base + arrival;
                    for x in 0..budgets {
                        if feasible[x] {
                            continue;
                        }
                        if flags & ALIGHT != 0 && a <= alight[x * n + stop as usize] {
                            feasible[x] = true;
                        } else if idx == last && k >= 2 {
                            feasible[x] = self
                                .derived_targets(inst)
                                .any(|(j, first)| ride_from_first[x * m + j] && first >= a);
                        }
                    }
                }
            }
            core::mem::swap(&mut ride_from_first, &mut ride_now);
            if k == rounds {
                break;
            }
            for x in (1..budgets).rev() {
                for s in 0..n {
                    let mut at = alight[x * n + s];
                    let b = board[(x - 1) * n + s];
                    if b != UNREACHED {
                        at = at.max(b - self.min_transfer);
                    }
                    for &(to, raw) in self.scan.walks_from(s) {
                        diagnostics.label_relaxations += 1;
                        let b = board[(x - 1) * n + to as usize];
                        if b != UNREACHED {
                            at = at.max(
                                b - self
                                    .min_transfer
                                    .max(rescale_walk_secs(raw, self.walk_speed)),
                            );
                        }
                    }
                    alight[x * n + s] = at;
                }
            }
            // A smaller budget is also within a larger one.
            for x in 1..budgets {
                for s in 0..n {
                    let lower = alight[(x - 1) * n + s];
                    let at = &mut alight[x * n + s];
                    if lower > *at {
                        *at = lower;
                    }
                }
            }
        }
        let found = best
            .iter()
            .enumerate()
            .find_map(|(x, d)| d.map(|d| (x as u64, d)));
        SelectorScanResult {
            optimum: found.map(|f| f.0),
            departure: found.map(|f| f.1),
            diagnostics,
        }
    }

    /// H81: the smallest total walk of any journey and the latest origin
    /// departure achieving it. Labels are Pareto sets of (latest alight time,
    /// remaining walk); walk counts caller access/egress, the egress PTFT walk
    /// and each walking change, rescaled as the search does.
    fn least_walking(self) -> SelectorScanResult {
        let mut diagnostics = self.diagnostics;
        let n = self.egress_walk.len();
        let rounds = self.rounds;
        let mut alight: Vec<Bag> = vec![Bag::default(); n];
        for (s, bag) in alight.iter_mut().enumerate() {
            let w = self.egress_walk[s];
            if w != u32::MAX {
                bag.insert(self.deadline - w as i64, u64::from(w));
            }
            for &(to, raw) in self.scan.walks_from(s) {
                let w = self.egress_walk[to as usize];
                if w != u32::MAX {
                    let walk = rescale_walk_secs(raw, self.walk_speed);
                    bag.insert(self.deadline - w as i64 - walk, u64::from(w) + walk as u64);
                }
            }
        }
        // (total walk, origin departure): smallest walk, then latest departure.
        let mut best: Option<(u64, i64)> = None;
        let m = self.instances.len();
        let mut ride_from_first: Vec<Option<u64>> = vec![None; m];
        let mut ride_now: Vec<Option<u64>> = vec![None; m];
        let mut board: Vec<Bag> = vec![Bag::default(); n];
        for k in 1..=rounds {
            board.iter_mut().for_each(Bag::clear);
            for (i, inst) in self.instances.iter().enumerate() {
                let template = self.template(inst);
                let last = template.len() - 1;
                // Smallest remaining walk over the feasible later alightings.
                let mut remaining: Option<u64> = None;
                for (idx, &(_, stop, arrival, departure, flags)) in
                    template.iter().enumerate().rev()
                {
                    diagnostics.position_scans += 1;
                    if let (Some(w), true) = (remaining, flags & BOARD != 0) {
                        let b = inst.base + departure;
                        board[stop as usize].insert(b, w);
                        if let Some(walks) = self.entries.get(&stop) {
                            for &access in walks {
                                let origin = b - access;
                                let total = w + access as u64;
                                if self.window.contains(&origin)
                                    && best.is_none_or(|(bw, bd)| (total, -origin) < (bw, -bd))
                                {
                                    best = Some((total, origin));
                                }
                            }
                        }
                    }
                    if idx == 0 {
                        ride_now[i] = remaining;
                        break;
                    }
                    let a = inst.base + arrival;
                    if flags & ALIGHT != 0 {
                        if let Some(w) = alight[stop as usize].least_walk_by(a) {
                            remaining = Some(remaining.map_or(w, |r| r.min(w)));
                        }
                    }
                    if idx == last && k >= 2 {
                        for (j, first) in self.derived_targets(inst) {
                            if let (Some(w), true) = (ride_from_first[j], first >= a) {
                                remaining = Some(remaining.map_or(w, |r| r.min(w)));
                            }
                        }
                    }
                }
            }
            core::mem::swap(&mut ride_from_first, &mut ride_now);
            if k == rounds {
                break;
            }
            for s in 0..n {
                for &(b, w) in board[s].entries() {
                    alight[s].insert(b - self.min_transfer, w);
                }
                for &(to, raw) in self.scan.walks_from(s) {
                    diagnostics.label_relaxations += 1;
                    let walk = rescale_walk_secs(raw, self.walk_speed);
                    let elapsed = self.min_transfer.max(walk);
                    for &(b, w) in board[to as usize].entries() {
                        alight[s].insert(b - elapsed, w + walk as u64);
                    }
                }
            }
        }
        SelectorScanResult {
            optimum: best.map(|b| b.0),
            departure: best.map(|b| b.1),
            diagnostics,
        }
    }
}

impl DeadlinePreference {
    /// H81: fewest transfers and least walking rank departure second, so a
    /// scan for their optimum and its latest departure reduces them.
    pub fn has_selector_scan(self) -> bool {
        matches!(self, Self::FewestTransfers | Self::LeastWalking)
    }
}

/// Pareto set of (latest time, walk): sorted by walk ascending, so times are
/// strictly ascending too.
#[derive(Clone, Default)]
struct Bag(Vec<(i64, u64)>);

impl Bag {
    fn clear(&mut self) {
        self.0.clear();
    }

    fn entries(&self) -> &[(i64, u64)] {
        &self.0
    }

    fn insert(&mut self, time: i64, walk: u64) {
        // First entry with walk >= `walk`: everything before walks less.
        let at = self.0.partition_point(|e| e.1 < walk);
        // Dominated by a cheaper-or-equal walk that is at least as late.
        if at > 0 && self.0[at - 1].0 >= time {
            return;
        }
        if self.0.get(at).is_some_and(|e| e.1 == walk && e.0 >= time) {
            return;
        }
        // Remove entries with walk >= `walk` that are not later.
        let end = at + self.0[at..].partition_point(|e| e.0 <= time);
        self.0.splice(at..end, [(time, walk)]);
    }

    /// The smallest walk among entries reachable by alighting at `time`.
    fn least_walk_by(&self, time: i64) -> Option<u64> {
        let at = self.0.partition_point(|e| e.0 < time);
        self.0.get(at).map(|e| e.1)
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn latest_departure<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    spans: &TripSpans,
    scan: &LatestScanIndex,
    query: &Query,
    window: Range<i64>,
    deadline: i64,
    index_built: bool,
) -> Result<LatestScanResult, LatestScanError> {
    Ok(
        match setup(
            reader,
            index,
            spans,
            scan,
            query,
            window,
            deadline,
            index_built,
        )? {
            Setup::Empty(diagnostics) => LatestScanResult {
                departure: None,
                diagnostics,
            },
            Setup::Ready(s) => s.latest(),
        },
    )
}

/// H81 phase A for fewest transfers or least walking.
#[allow(clippy::too_many_arguments)]
pub(super) fn selector_departure<B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &Reader<B>,
    index: &Index,
    spans: &TripSpans,
    scan: &LatestScanIndex,
    preference: DeadlinePreference,
    query: &Query,
    window: Range<i64>,
    deadline: i64,
    index_built: bool,
) -> Result<SelectorScanResult, LatestScanError> {
    if !preference.has_selector_scan() {
        return Err(LatestScanError::Unsupported(
            "selector has no departure scan",
        ));
    }
    Ok(
        match setup(
            reader,
            index,
            spans,
            scan,
            query,
            window,
            deadline,
            index_built,
        )? {
            Setup::Empty(diagnostics) => SelectorScanResult {
                optimum: None,
                departure: None,
                diagnostics,
            },
            Setup::Ready(s) if preference == DeadlinePreference::FewestTransfers => {
                s.fewest_transfers()
            }
            Setup::Ready(s) => s.least_walking(),
        },
    )
}
