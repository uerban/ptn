//! PTB v2 production search: a round-based Pareto label search over concrete
//! trip instances on the service-day-origin timeline.
//!
//! Each label is one rider state after a transit round: arrival (timeline
//! seconds relative to `origin[Query.date]`), passenger-transfer count, the
//! concrete arriving `TripInstance` and the original alight stop. Labels live
//! in per-stop bags partitioned by future-behaviour class; label A dominates B
//! only within one class, only when `A.round <= B.round`, and only when A is no
//! worse on arrival and passenger transfers. There is no global arrival-only
//! pruning and no scalar target cutoff; the only cutoff is Pareto: a label a
//! found target dominates on both criteria is dropped (see `Ctx::cut`).
//!
//! The class of a label keeps every identity a later transition can observe:
//! the original alight stop and any walk; the trip when it is `from_trip` of
//! any explicit row; the GTFS route when it is `from_route` of any ordinary
//! row; nothing more otherwise. Merging is sound there because every later
//! transition depends only on the kept fields. The concrete instance matters
//! only to a linked or derived continuation, which binds by service date at
//! the source trip's terminal row; that arrival also gets a link-only label
//! in its own per-instance class, which takes nothing but those continuations.
//!
//! Transfer semantics follow GTFS `transfers.txt`
//! (<https://gtfs.org/documentation/schedule/reference/#transferstxt>) through
//! the single resolver in [`super::rules`]; frequency instances follow
//! `frequencies.txt` (<https://gtfs.org/documentation/schedule/reference/#frequenciestxt>):
//! first departures `start + n * headway < end`, `exact_times=0` marked
//! approximate, and the template never emitted on its own.

use alloc::vec::Vec;
use hashbrown::HashMap;
use rustc_hash::FxBuildHasher;

use super::index::V2Index;
use super::rules::{ordinary_floor, synthetic_elapsed, Selected, Transition};
use super::time;
use crate::engine::consts::{rescale_walk_secs, RAPTOR_MAX_ROUNDS};
use crate::engine::index::Index;
use crate::engine::mode::route_type_to_mode;
use crate::engine::scan::{
    alight_secs_at, dep_secs_at, drop_off_forbidden_at, pickup_forbidden_at,
};
use crate::engine::types::{EngineError, Itinerary, Leg, LegKind, Mobility, Query};
use crate::transfers::Transfers;
use crate::Reader;

type FxHashMap<K, V> = HashMap<K, V, FxBuildHasher>;

const NONE: u32 = u32::MAX;

/// A concrete trip instance: `(trip_idx, service-date ordinal, frequency
/// shift)`. The shift is 0 for a scheduled trip and the occurrence's offset
/// from the template's first departure for a frequency trip (rows of one trip
/// never overlap, so the shift identifies the occurrence).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct Inst {
    pub trip: u32,
    pub date: u32,
    pub shift: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Kind {
    Origin,
    Transit,
    /// Alighted, then walked a PTFT edge (`walk` = mobility-scaled seconds).
    WalkPtft,
    /// Alighted, then crossed a synthetic explicit-minimum edge; its elapsed
    /// duration is fixed only by the boarding rule.
    WalkSynthetic,
}

#[derive(Debug, Clone, Copy)]
struct Label {
    kind: Kind,
    /// Origin: arrival at the entry stop. Otherwise: the alight time at
    /// `from_stop` (walks add their duration at boarding or egress).
    time: i64,
    transfers: u32,
    round: u32,
    stop: u32,
    /// The original alight stop (== `stop` for transit labels).
    from_stop: u32,
    walk: i64,
    inst: Inst,
    reader_route: u32,
    at_terminal: bool,
    /// Alighting is not permitted here: the state may only take a matching
    /// type-4 / derived in-seat continuation.
    stay_only: bool,
    /// The continuation half of an instance-level trip's terminal arrival:
    /// it only takes linked and derived continuations of its own instance.
    /// Its ordinary twin (same arrival, `link_only == false`) boards, walks
    /// and reaches targets in the shared class. See [`Ctx::ride`].
    link_only: bool,
    alive: bool,
    // ---- witness ----
    parent: u32,
    route: u32,
    slot: u32,
    board_pos: u32,
    alight_pos: u32,
    in_seat: bool,
    approximate: bool,
    /// Elapsed transfer seconds consumed before this ride's boarding (for a
    /// synthetic walk leg's displayed duration).
    elapsed: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Proj {
    None,
    Route(u32),
    Trip(u32, bool),
    Instance(Inst, bool),
}

/// The rides taken of one concrete instance ([`Ctx::ride`]): boarding
/// position, round and passenger transfers, none dominating another. Holding
/// at most `RIDES` of them only forgets rides, which costs a repeat, never a
/// result.
#[derive(Debug, Clone, Copy, Default)]
struct Rides {
    n: u8,
    e: [(u32, u32, u32); RIDES],
}

const RIDES: usize = 3;

impl Rides {
    /// Whether a ride boarded no later, in no later a round, with no more
    /// transfers was taken.
    #[inline]
    fn covers(&self, pos: u32, round: u32, transfers: u32) -> bool {
        self.e[..self.n as usize]
            .iter()
            .any(|&(p, r, t)| p <= pos && r <= round && t <= transfers)
    }

    /// Record a ride that [`Rides::covers`] does not: drop the ones it
    /// dominates, then keep it if there is room.
    #[inline]
    fn record(&mut self, pos: u32, round: u32, transfers: u32) {
        let mut n = 0;
        for i in 0..self.n as usize {
            let (p, r, t) = self.e[i];
            if !(pos <= p && round <= r && transfers <= t) {
                self.e[n] = self.e[i];
                n += 1;
            }
        }
        if n < RIDES {
            self.e[n] = (pos, round, transfers);
            n += 1;
        }
        self.n = n as u8;
    }
}

/// A dominance class of labels ([`Ctx::class_of`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct Class {
    stop: u32,
    kind: Kind,
    stay_only: bool,
    link_only: bool,
    from_stop: u32,
    walk: i64,
    proj: Proj,
}

struct Ctx<'a, B: AsRef<[u8]> + Send + Sync + 'static> {
    reader: &'a Reader<B>,
    index: &'a Index,
    v2: &'a V2Index,
    transfers: Option<&'a Transfers>,
    is_wheelchair: bool,
    is_bicycle: bool,
    /// Transfer-walk speed (mm/s) and the minimum transfer where no rule
    /// sets one ([`Query::transfer_walk_speed_mm_s`],
    /// [`Query::min_transfer_floor_secs`]).
    walk_speed_mm_s: u32,
    min_transfer: i64,
    excluded_routes: &'a [u32],
    excluded_mask: u32,
    origin_unix: i64,
    deadline: i64,
    /// `origin[d] - origin[Query.date]` per routable date ordinal.
    date_shift: Vec<i64>,
    dates: core::ops::Range<usize>,
    labels: Vec<Label>,
    /// Labels by dominance class ([`Ctx::class_of`]): a label is compared only
    /// with the labels of its own class.
    bags: FxHashMap<Class, Vec<u32>>,
    ptft: FxHashMap<u32, Vec<(u32, i64)>>,
    /// Target Pareto frontier over (arrival incl. egress, passenger
    /// transfers, label).
    targets: Vec<(i64, u32, u32)>,
    /// Exit stops -> smallest caller egress walk, shared by both target policies.
    exits: FxHashMap<u32, i64>,
    /// Drop labels a found target dominates ([`Ctx::cut`]). Always on in
    /// production; the tests turn it off to prove it changes no result.
    cutoff: bool,
    /// Indexed boarding ([`Ctx::uniform_ready`]) and the ride memo
    /// ([`Ctx::ride`]). Always on in production; the tests turn them off to
    /// prove they change no result.
    shortcuts: bool,
    /// Rides already taken, per concrete instance ([`Ctx::ride`]). A trip
    /// lives in one pattern slot, so the instance names the ride's vehicle.
    ridden: FxHashMap<Inst, Rides>,
    /// Per pattern position (`V2Index::position_base`): its index into
    /// `departures`, or `NONE` before its first boarding.
    departure_at: Vec<u32>,
    /// Per listed pattern position: every boardable instance in the horizon,
    /// in boarding order ([`Ctx::list_departures`]); `None` when one could
    /// not be listed, which keeps that position on the per-trip path.
    departures: Vec<Option<Departures>>,
    buf_cands: Vec<Boarding>,
    buf_scratch: Vec<(i64, Inst, bool)>,
    buf_taken: Vec<bool>,
    buf_limits: Vec<Option<i64>>,
    /// Per pattern: its offset into `active` ([`Ctx::active_masks`]), or
    /// `NONE` before its first use.
    active_at: Vec<u32>,
    active: Vec<u64>,
    /// The query's departure on the timeline: no label is earlier.
    query_departure: i64,
}

/// One boardable instance of a pattern position ([`Ctx::list_departures`]).
#[derive(Debug, Clone, Copy)]
struct Departure {
    time: i64,
    slot: u32,
    inst: Inst,
    approximate: bool,
    /// Every instance of the trip is a candidate, not only its earliest.
    all: bool,
    /// The trip's labels share a projection ([`Ctx::is_shared`]).
    shared: bool,
    /// The trip's shape group (`V2Index::trip_group`).
    group: u32,
    /// The last shared departure of its group in the list.
    last_of_group: bool,
}

#[derive(Debug, Clone)]
struct Departures {
    /// Some trip passes the static filters, so the per-trip path computes
    /// its ready time.
    eligible: bool,
    list: Vec<Departure>,
    /// Indices into `list` of the departures that are not shared, in order.
    unshared: Vec<u32>,
    /// Per index into `list` (and one past its end): how many shape groups
    /// have a shared departure there or later.
    suffix_groups: Vec<u32>,
}

/// One boarding candidate of a pattern position ([`Ctx::ride_candidates`]).
#[derive(Debug, Clone, Copy)]
struct Boarding {
    time: i64,
    slot: u32,
    inst: Inst,
    approximate: bool,
    elapsed: i64,
    shared: bool,
}

/// Plan a PTB v2 query. `query.date`/`query.departure_secs` are a v2 time
/// (see [`super::resolve_time`]); every returned second is relative to
/// `origin[query.date]` and may exceed 86 400.
pub fn plan_v2<B>(
    reader: &Reader<B>,
    index: &Index,
    transfers: Option<&Transfers>,
    query: &Query,
    abort: Option<&core::sync::atomic::AtomicBool>,
) -> Result<Vec<Itinerary>, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    plan_v2_with(reader, index, transfers, query, abort, true, true).map(|(out, _)| out)
}

/// [`plan_v2`] with the target cutoff and the boarding shortcuts switchable,
/// also returning how many labels the search created, so the tests can show
/// neither changes a returned itinerary and bound the size of a search.
pub(crate) fn plan_v2_with<B>(
    reader: &Reader<B>,
    index: &Index,
    transfers: Option<&Transfers>,
    query: &Query,
    abort: Option<&core::sync::atomic::AtomicBool>,
    cutoff: bool,
    shortcuts: bool,
) -> Result<(Vec<Itinerary>, usize), EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    plan_impl(reader, index, transfers, query, abort, cutoff, shortcuts)
}

#[allow(clippy::too_many_arguments)]
fn plan_impl<'a, B: AsRef<[u8]> + Send + Sync + 'static>(
    reader: &'a Reader<B>,
    index: &'a Index,
    transfers: Option<&'a Transfers>,
    query: &Query,
    abort: Option<&core::sync::atomic::AtomicBool>,
    cutoff: bool,
    shortcuts: bool,
) -> Result<(Vec<Itinerary>, usize), EngineError> {
    let v2 = index.v2.as_deref().ok_or(EngineError::UnsupportedVersion)?;
    let frame = time::query_frame(reader, query.date, query.departure_secs, v2.max_event_secs)?;
    let n = time::routable_dates(reader);
    let deadline_unix = frame.deadline_unix;
    let mut date_shift = Vec::with_capacity(n);
    for d in 0..n {
        let o = time::origin(reader, d)?;
        date_shift.push(
            o.checked_sub(frame.origin_unix)
                .ok_or(EngineError::TimeOverflow)?,
        );
    }
    let dates = time::candidate_dates(
        reader,
        frame.departure_unix,
        deadline_unix,
        v2.min_event_secs,
        v2.max_event_secs,
    )?;
    let mut excluded_mask = 0u32;
    for &rt in &query.excluded_modes {
        excluded_mask |= 1u32 << (route_type_to_mode(rt) as u32);
    }
    let mut cx = Ctx {
        reader,
        index,
        v2,
        transfers,
        is_wheelchair: matches!(query.mobility, Mobility::Wheelchair),
        is_bicycle: matches!(query.mobility, Mobility::Bicycle),
        walk_speed_mm_s: query.transfer_walk_speed_mm_s(),
        min_transfer: query.min_transfer_floor_secs(),
        excluded_routes: &query.excluded_routes,
        excluded_mask,
        origin_unix: frame.origin_unix,
        deadline: frame.timeline(deadline_unix)?,
        date_shift,
        dates,
        labels: Vec::new(),
        bags: FxHashMap::default(),
        ptft: FxHashMap::default(),
        targets: Vec::new(),
        exits: FxHashMap::default(),
        cutoff,
        shortcuts,
        ridden: FxHashMap::default(),
        departure_at: alloc::vec![NONE; v2.num_positions as usize],
        departures: Vec::new(),
        active_at: alloc::vec![NONE; index.routes.len()],
        buf_cands: Vec::new(),
        buf_scratch: Vec::new(),
        buf_taken: Vec::new(),
        buf_limits: Vec::new(),
        active: Vec::new(),
        query_departure: query.departure_secs,
    };

    // Exit stops -> smallest egress walk.
    for e in &query.exit_stops {
        let w = e.walk_secs as i64;
        cx.exits
            .entry(e.stop)
            .and_modify(|x| *x = (*x).min(w))
            .or_insert(w);
    }

    // Round 0: origin labels.
    let mut frontier: Vec<u32> = Vec::new();
    for e in &query.entry_stops {
        let t = query
            .departure_secs
            .checked_add(e.walk_secs as i64)
            .ok_or(EngineError::TimeOverflow)?;
        if t > cx.deadline {
            continue;
        }
        let l = Label {
            kind: Kind::Origin,
            time: t,
            transfers: 0,
            round: 0,
            stop: e.stop,
            from_stop: e.stop,
            walk: 0,
            inst: Inst {
                trip: NONE,
                date: NONE,
                shift: 0,
            },
            reader_route: NONE,
            at_terminal: false,
            stay_only: false,
            link_only: false,
            alive: true,
            parent: NONE,
            route: NONE,
            slot: NONE,
            board_pos: 0,
            alight_pos: 0,
            in_seat: false,
            approximate: false,
            elapsed: 0,
        };
        if let Some(i) = cx.insert(l)? {
            frontier.push(i);
        }
    }

    let max_rounds = query.max_rounds.unwrap_or(RAPTOR_MAX_ROUNDS);
    for k in 1..=max_rounds {
        if let Some(flag) = abort {
            if flag.load(core::sync::atomic::Ordering::Relaxed) {
                return Err(EngineError::Aborted);
            }
        }
        if frontier.is_empty() {
            break;
        }
        let mut created: Vec<u32> = Vec::new();
        for &li in &frontier {
            let l = &cx.labels[li as usize];
            // Targets found at the end of the previous round may dominate a
            // frontier label inserted before they existed.
            if !l.alive || cx.cut(l.time, l.transfers)? {
                continue;
            }
            cx.board_from(li, k, &mut created)?;
            cx.linked_from(li, k, &mut created)?;
        }
        // One walk per transit label, in the same round.
        let rides: Vec<u32> = created.clone();
        for li in rides {
            let l = cx.labels[li as usize];
            if l.alive && l.kind == Kind::Transit && !l.stay_only && !l.link_only {
                cx.walk_from(li, k, &mut created)?;
            }
        }
        created.retain(|&i| cx.labels[i as usize].alive);
        for &li in &created {
            let l = &cx.labels[li as usize];
            let Some(&egress) = cx.exits.get(&l.stop) else {
                continue;
            };
            let arrive = match l.kind {
                Kind::Transit if !l.stay_only && !l.link_only => l.time,
                Kind::WalkPtft => l.time + l.walk,
                _ => continue,
            };
            let total = arrive
                .checked_add(egress)
                .ok_or(EngineError::TimeOverflow)?;
            if total
                > cx.deadline
                    .checked_add(egress)
                    .ok_or(EngineError::TimeOverflow)?
            {
                continue;
            }
            if cx.target_dominated(total, l.transfers)? {
                continue;
            }
            let transfers = l.transfers;
            cx.targets
                .retain(|&(a, t, _)| !(total <= a && transfers <= t));
            cx.targets.push((total, transfers, li));
        }
        frontier = created;
    }

    let mut targets = core::mem::take(&mut cx.targets);
    targets.sort_by_key(|&(a, t, _)| (a, t));
    let mut out = Vec::with_capacity(targets.len());
    for &(_, _, li) in &targets {
        out.push(cx.reconstruct(li)?);
    }
    Ok((out, cx.labels.len()))
}

impl<B: AsRef<[u8]> + Send + Sync + 'static> Ctx<'_, B> {
    /// True when a found target is no later than `time` with no more
    /// passenger transfers.
    fn target_dominated(&self, time: i64, transfers: u32) -> Result<bool, EngineError> {
        for &(a, t, _) in &self.targets {
            if a <= time && t <= transfers {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// The search's cutoff: a label at `time` with `transfers` that a found
    /// target dominates is dropped. Every descendant of the label is at least
    /// as late (rides, waits, walks and egress only add time) with at least as
    /// many transfers, so the target rejects each target it could reach, and
    /// every label it could dominate in a bag is dominated by the same target.
    /// Dropping it leaves the returned itineraries unchanged and only removes
    /// work: without it, every search runs to the end of the routing horizon.
    fn cut(&self, time: i64, transfers: u32) -> Result<bool, EngineError> {
        if self.cutoff {
            self.target_dominated(time, transfers)
        } else {
            Ok(false)
        }
    }

    fn proj(&self, l: &Label) -> Proj {
        if l.kind == Kind::Origin {
            return Proj::None;
        }
        let t = l.inst.trip as usize;
        if l.link_only {
            Proj::Instance(l.inst, l.at_terminal)
        } else if self
            .v2
            .rules
            .trip_has_from_rules
            .get(t)
            .copied()
            .unwrap_or(false)
        {
            Proj::Trip(l.inst.trip, l.at_terminal)
        } else if self
            .v2
            .rules
            .route_has_from_rules
            .get(l.reader_route as usize)
            .copied()
            .unwrap_or(false)
        {
            Proj::Route(l.reader_route)
        } else {
            Proj::None
        }
    }

    /// The label's dominance class: two labels are in the same class exactly
    /// when they share the stop, kind, stay-only and link-only flags and,
    /// except at the origin, the original alight stop, the walk and the
    /// projection ([`Ctx::proj`]).
    fn class_of(&self, l: &Label) -> Class {
        let origin = l.kind == Kind::Origin;
        Class {
            stop: l.stop,
            kind: l.kind,
            stay_only: l.stay_only,
            link_only: l.link_only,
            from_stop: if origin { 0 } else { l.from_stop },
            walk: if origin { 0 } else { l.walk },
            proj: if origin { Proj::None } else { self.proj(l) },
        }
    }

    /// Insert into the stop bag unless dominated within its class.
    fn insert(&mut self, l: Label) -> Result<Option<u32>, EngineError> {
        if self.cut(l.time, l.transfers)? {
            return Ok(None);
        }
        let class = self.class_of(&l);
        let list = self.bags.get(&class).map(|v| v.as_slice()).unwrap_or(&[]);
        for &i in list.iter() {
            let e = &self.labels[i as usize];
            if e.alive && e.round <= l.round && e.time <= l.time && e.transfers <= l.transfers {
                return Ok(None);
            }
        }
        let mut kill: Vec<u32> = Vec::new();
        for &i in list {
            let e = &self.labels[i as usize];
            if e.alive && l.round <= e.round && l.time <= e.time && l.transfers <= e.transfers {
                kill.push(i);
            }
        }
        for i in kill {
            self.labels[i as usize].alive = false;
        }
        let idx = self.labels.len() as u32;
        self.labels.push(l);
        let list = self.bags.entry(class).or_default();
        list.retain(|&i| self.labels[i as usize].alive);
        list.push(idx);
        Ok(Some(idx))
    }

    fn ptft_edges(&mut self, stop: u32) -> Result<&[(u32, i64)], EngineError> {
        if !self.ptft.contains_key(&stop) {
            let mut v = Vec::new();
            if let Some(tr) = self.transfers {
                let id = self.reader.stop_id(stop as usize)?;
                if let Some(ti) = tr.index_of(id) {
                    let (nbrs, walks) = tr.edges(ti);
                    for (j, &raw) in walks.iter().enumerate() {
                        if let Some(s) = self.reader.stop_index(tr.stop_id(nbrs[j])) {
                            if s != stop {
                                v.push((s, rescale_walk_secs(raw, self.walk_speed_mm_s)));
                            }
                        }
                    }
                }
            }
            self.ptft.insert(stop, v);
        }
        Ok(self.ptft.get(&stop).map(|v| v.as_slice()).unwrap_or(&[]))
    }

    fn ptft_walk(&mut self, from: u32, to: u32) -> Result<Option<i64>, EngineError> {
        Ok(self
            .ptft_edges(from)?
            .iter()
            .filter(|&&(s, _)| s == to)
            .map(|&(_, w)| w)
            .min())
    }

    fn trip_allowed(&self, rt: &crate::engine::index::RouteTrip) -> bool {
        !(self.is_wheelchair && rt.wheelchair_accessible == 2)
            && !(self.is_bicycle && rt.bikes_allowed == 2)
    }

    fn route_allowed(&self, route: u32) -> bool {
        let r = &self.index.routes[route as usize];
        !self.excluded_routes.contains(&r.reader_route_idx)
            && (self.excluded_mask == 0 || (self.excluded_mask >> (r.mode as u32)) & 1 == 0)
    }

    fn stop_inaccessible(&self, stop: u32) -> Result<bool, EngineError> {
        Ok(self.is_wheelchair && self.reader.stop_wheelchair_boarding(stop as usize)? == 2)
    }

    /// Ready time and elapsed transfer seconds for boarding `to_trip` at
    /// position `pos` from label `l`, or `None` when the explicit rules forbid
    /// it or leave it to a linked continuation.
    fn ready_for(
        &mut self,
        l: &Label,
        to_trip: u32,
        to_route: u32,
        pos: u32,
    ) -> Result<Option<(i64, i64)>, EngineError> {
        if l.kind == Kind::Origin {
            return Ok(Some((l.time, 0)));
        }
        let ti = self.v2.trips[to_trip as usize];
        let t = Transition {
            from_stop: l.from_stop,
            to_stop: l.stop,
            from_trip: l.inst.trip,
            from_route: l.reader_route,
            to_trip,
            to_route,
            at_boundary: l.at_terminal && pos == ti.first_pos,
        };
        let rule = match self.v2.rules.resolve(&t).0 {
            // A selected linked row governs this exact transition: the linked
            // candidate (if any) replaces ordinary boarding; a frequency-linked
            // winner fails closed.
            Selected::Linked(_) => return Ok(None),
            Selected::Ordinary(oi) => Some(self.v2.rules.ordinary[oi as usize]),
            Selected::None => None,
        };
        let elapsed = match l.kind {
            Kind::Transit => match ordinary_floor(rule.as_ref(), self.min_transfer) {
                Some(f) => f,
                None => return Ok(None),
            },
            Kind::WalkPtft => match ordinary_floor(rule.as_ref(), self.min_transfer) {
                Some(f) => f.max(l.walk),
                None => return Ok(None),
            },
            Kind::WalkSynthetic => match synthetic_elapsed(rule.as_ref(), self.min_transfer) {
                Some(e) => e,
                None => return Ok(None),
            },
            Kind::Origin => 0,
        };
        let ready = l
            .time
            .checked_add(elapsed)
            .ok_or(EngineError::TimeOverflow)?;
        Ok(Some((ready, elapsed)))
    }

    /// The earliest feasible instance of `trip` departing position `pos` at or
    /// after `ready` (all feasible instances when `all`), within the horizon.
    fn instances(
        &self,
        rt: &crate::engine::index::RouteTrip,
        pos: usize,
        ready: i64,
        all: bool,
        out: &mut Vec<(i64, Inst, bool)>,
    ) -> Result<(), EngineError> {
        let trip = rt.trip_idx;
        let dep = dep_secs_at(self.reader, rt, pos)?;
        if dep < 0 {
            return Ok(());
        }
        let fd = self.v2.first_dep[trip as usize];
        let mut best: Option<(i64, Inst, bool)> = None;
        for d in self.dates.clone() {
            if !self.reader.service_active_on_day(rt.service_idx, d as u32) {
                continue;
            }
            let shift_d = self.date_shift[d];
            match self.v2.freq.get(&trip) {
                None => {
                    let t = shift_d.checked_add(dep).ok_or(EngineError::TimeOverflow)?;
                    if t < ready || t > self.deadline {
                        continue;
                    }

                    let c = (
                        t,
                        Inst {
                            trip,
                            date: d as u32,
                            shift: 0,
                        },
                        false,
                    );
                    if all {
                        out.push(c);
                    } else if best.is_none_or(|b| t < b.0) {
                        best = Some(c);
                    }
                }
                Some(windows) => {
                    // A first departure f puts this position at shift_d + f - fd + dep.
                    let need = ready - shift_d - (dep - fd);
                    for w in windows {
                        let nrep = if need <= w.start {
                            0
                        } else {
                            (need - w.start + w.headway - 1) / w.headway
                        };
                        let f = w
                            .start
                            .checked_add(
                                nrep.checked_mul(w.headway)
                                    .ok_or(EngineError::TimeOverflow)?,
                            )
                            .ok_or(EngineError::TimeOverflow)?;
                        if f >= w.end {
                            continue;
                        }
                        let shift = f - fd;
                        let t = shift_d + dep + shift;
                        if t > self.deadline {
                            continue;
                        }

                        let c = (
                            t,
                            Inst {
                                trip,
                                date: d as u32,
                                shift,
                            },
                            !w.exact,
                        );
                        if best.is_none_or(|b| t < b.0) {
                            best = Some(c);
                        }
                    }
                }
            }
        }
        if let Some(b) = best {
            out.push(b);
        }
        Ok(())
    }

    /// Ordinary boarding of every route serving the label's stop.
    fn board_from(&mut self, li: u32, k: u32, created: &mut Vec<u32>) -> Result<(), EngineError> {
        let l = self.labels[li as usize];
        if l.stay_only || l.link_only {
            return Ok(());
        }
        if self.stop_inaccessible(l.stop)? {
            return Ok(());
        }
        let index = self.index;
        let v2 = self.v2;
        let pairs: &[(u32, u32)] = v2
            .stop_positions
            .get(&l.stop)
            .map(|v| v.as_slice())
            .unwrap_or(&[]);
        // Scratch buffers kept across calls (lost only on an error).
        let mut cands = core::mem::take(&mut self.buf_cands);
        let mut scratch = core::mem::take(&mut self.buf_scratch);
        let mut taken = core::mem::take(&mut self.buf_taken);
        let mut limits = core::mem::take(&mut self.buf_limits);
        let uniform = self.uniform_ready(&l);
        for &(r, p) in pairs {
            if !self.route_allowed(r) {
                continue;
            }
            let route = &index.routes[r as usize];
            let p = p as usize;
            cands.clear();
            if let Some(ready) = &uniform {
                let at = (v2.position_base[r as usize] as usize) + p;
                if self.departure_at[at] == NONE {
                    let listed = self.list_departures(r, p, self.query_departure);
                    self.departure_at[at] = self.departures.len() as u32;
                    self.departures.push(listed);
                }
                if let Some(deps) = &self.departures[self.departure_at[at] as usize] {
                    if deps.eligible {
                        // The per-trip path computes the ready time at the
                        // first eligible trip, and fails or skips there.
                        let Some((ready, elapsed)) = ready.clone()? else {
                            continue;
                        };
                        // Labels only move forward from the departure, so
                        // the list (built from it) holds every instance
                        // at or after `ready`.
                        debug_assert!(ready >= self.query_departure);
                        let spreads = &self.v2.group_spread[r as usize];
                        // Each trip's earliest instance from `ready` (every one
                        // for an instance-level trip); the vehicle the label
                        // rides is skipped, not replaced by a later instance.
                        taken.clear();
                        taken.resize(route.trips.len(), false);
                        let transfers = if l.kind == Kind::Origin {
                            0
                        } else {
                            l.transfers + 1
                        };
                        let ridden = &self.ridden;
                        // Whether `c` is a candidate; it is pushed unless an
                        // earlier ride covers it, so [`Ctx::ride`] would
                        // return at once.
                        let mut take = |c: &Departure, cands: &mut Vec<Boarding>| -> bool {
                            if !c.all {
                                if taken[c.slot as usize] {
                                    return false;
                                }
                                taken[c.slot as usize] = true;
                            }
                            if l.kind != Kind::Origin && c.inst == l.inst {
                                return false;
                            }
                            if ridden
                                .get(&c.inst)
                                .is_some_and(|s| s.covers(p as u32, k, transfers))
                            {
                                return true;
                            }
                            cands.push(Boarding {
                                time: c.time,
                                slot: c.slot,
                                inst: c.inst,
                                approximate: c.approximate,
                                elapsed,
                                shared: c.shared,
                            });
                            true
                        };
                        let mut i = deps.list.partition_point(|c| c.time < ready);
                        // A shared boarding from the first shared candidate
                        // of its shape group plus twice the group's spread
                        // on arrives no earlier at every stop it serves,
                        // into the same classes: each of its labels is
                        // dominated (as [`Ctx::ride_candidates`] uses on a
                        // uniform pattern, its one group). Once every group
                        // has its limit or no departure left, and the walk is
                        // past every limit, only the unshared departures are
                        // left.
                        limits.clear();
                        limits.resize(spreads.len(), None);
                        let mut pending = deps.suffix_groups[i];
                        let mut max_limit = i64::MIN;
                        while let Some(c) = deps.list.get(i) {
                            if pending == 0 && c.time >= max_limit {
                                break;
                            }
                            i += 1;
                            if !c.shared {
                                take(c, &mut cands);
                                continue;
                            }
                            let g = c.group as usize;
                            if limits[g].is_some_and(|lim| c.time >= lim) {
                                continue;
                            }
                            let accepted = take(c, &mut cands);
                            if limits[g].is_none() {
                                if accepted {
                                    let lim = c.time + 2 * spreads[g];
                                    limits[g] = Some(lim);
                                    max_limit = max_limit.max(lim);
                                    pending -= 1;
                                } else if c.last_of_group {
                                    pending -= 1;
                                }
                            }
                        }
                        let j = deps.unshared.partition_point(|&x| (x as usize) < i);
                        for &x in &deps.unshared[j..] {
                            take(&deps.list[x as usize], &mut cands);
                        }
                    }
                    self.ride_candidates(li, k, r, p, &l, &cands, created)?;
                    continue;
                }
            }
            for (si, rt) in route.trips.iter().enumerate() {
                let ti = self.v2.trips[rt.trip_idx as usize];
                if ti.route != r || ti.slot != si as u32 {
                    continue;
                }
                if p as u32 >= ti.last_pos || rt.pos_to_row.get(p).copied().unwrap_or(-1) == -1 {
                    continue;
                }
                if !self.trip_allowed(rt) || pickup_forbidden_at(self.reader, rt, p) {
                    continue;
                }
                let Some((ready, elapsed)) =
                    self.ready_for(&l, rt.trip_idx, route.reader_route_idx, p as u32)?
                else {
                    continue;
                };
                let all = self.v2.instance_level[rt.trip_idx as usize];
                scratch.clear();
                self.instances(rt, p, ready, all, &mut scratch)?;
                let shared = self.is_shared(rt.trip_idx, route.reader_route_idx);
                for &(t, inst, approx) in &scratch {
                    // Never re-board the same concrete vehicle.
                    if l.kind != Kind::Origin && inst == l.inst {
                        continue;
                    }
                    cands.push(Boarding {
                        time: t,
                        slot: si as u32,
                        inst,
                        approximate: approx,
                        elapsed,
                        shared,
                    });
                }
            }
            cands.sort_by_key(|c| (c.time, c.slot, c.inst.date, c.inst.shift));
            self.ride_candidates(li, k, r, p, &l, &cands, created)?;
        }
        self.buf_cands = cands;
        self.buf_scratch = scratch;
        self.buf_taken = taken;
        self.buf_limits = limits;
        Ok(())
    }

    /// Ride the boarding candidates of one pattern position, in order.
    #[allow(clippy::too_many_arguments)]
    fn ride_candidates(
        &mut self,
        li: u32,
        k: u32,
        r: u32,
        p: usize,
        l: &Label,
        cands: &[Boarding],
        created: &mut Vec<u32>,
    ) -> Result<(), EngineError> {
        let (uniform, spread) = self.v2.route_shape[r as usize];
        let mut first_shared: Option<i64> = None;
        let transfers = if l.kind == Kind::Origin {
            0
        } else {
            l.transfers + 1
        };
        for c in cands {
            if c.shared {
                if let Some(f) = first_shared {
                    // Pointwise dominated by the first shared boarding.
                    if uniform && c.time >= f + 2 * spread {
                        continue;
                    }
                } else {
                    first_shared = Some(c.time);
                }
            }
            self.ride(
                li,
                k,
                r,
                c.slot,
                c.inst,
                p as u32,
                transfers,
                false,
                c.approximate,
                c.elapsed,
                created,
            )?;
        }
        Ok(())
    }

    /// Whether boardings of `trip` share a projection, so that a later one on
    /// a uniform pattern can be dominated by the first ([`Ctx::proj_of_trip`]).
    fn is_shared(&self, trip: u32, reader_route: u32) -> bool {
        matches!(
            self.proj_of_trip(trip, reader_route),
            Proj::None | Proj::Route(_)
        )
    }

    /// The ready time and elapsed seconds [`Ctx::ready_for`] gives every trip
    /// boarded from `l`, when it gives them all the same one: at the origin,
    /// or when no explicit row can apply (no ordinary row for the stop pair,
    /// no linked row from the arriving trip), so the rule is none for every
    /// trip. `None` when it can differ by trip.
    fn uniform_ready(&self, l: &Label) -> Option<Result<Option<(i64, i64)>, EngineError>> {
        if !self.shortcuts {
            return None;
        }
        if l.kind == Kind::Origin {
            return Some(Ok(Some((l.time, 0))));
        }
        let rules = &self.v2.rules;
        if rules.has_ordinary_between(l.from_stop, l.stop)
            || (l.at_terminal && rules.has_linked_from(l.inst.trip))
        {
            return None;
        }
        let elapsed = match l.kind {
            Kind::Transit => ordinary_floor(None, self.min_transfer),
            Kind::WalkPtft => ordinary_floor(None, self.min_transfer).map(|f| f.max(l.walk)),
            Kind::WalkSynthetic => synthetic_elapsed(None, self.min_transfer),
            Kind::Origin => Some(0),
        };
        Some(match elapsed {
            None => Ok(None),
            Some(e) => l
                .time
                .checked_add(e)
                .map(|ready| Some((ready, e)))
                .ok_or(EngineError::TimeOverflow),
        })
    }

    /// Every instance [`Ctx::instances`] can return at pattern `r`, position
    /// `p`, for any ready time from the query's departure on, over the trips
    /// the per-trip path would consider, ordered as that path orders its
    /// candidates. `None` on any error, so the per-trip path meets it where it
    /// would.
    fn list_departures(&mut self, r: u32, p: usize, from: i64) -> Option<Departures> {
        let index = self.index;
        let route = &index.routes[r as usize];
        let masks = self.active_masks(r);
        let mut eligible = false;
        // The trips boardable here: (slot, departure at `p`).
        let mut slots: Vec<(u32, i64)> = Vec::new();
        for (si, rt) in route.trips.iter().enumerate() {
            let ti = self.v2.trips[rt.trip_idx as usize];
            if ti.route != r || ti.slot != si as u32 {
                continue;
            }
            if p as u32 >= ti.last_pos || rt.pos_to_row.get(p).copied().unwrap_or(-1) == -1 {
                continue;
            }
            if !self.trip_allowed(rt) || pickup_forbidden_at(self.reader, rt, p) {
                continue;
            }
            eligible = true;
            let dep = dep_secs_at(self.reader, rt, p).ok()?;
            if dep < 0 {
                continue;
            }
            slots.push((si as u32, dep));
        }
        let mut list: Vec<Departure> = Vec::new();
        // Date by date, so each date's departures come mostly in order.
        for (b, d) in self.dates.clone().enumerate() {
            let shift_d = self.date_shift[d];
            for &(si, dep) in &slots {
                let rt = &route.trips[si as usize];
                let active = match masks {
                    Some(at) => self.active[at as usize + si as usize] >> b & 1 == 1,
                    None => self.reader.service_active_on_day(rt.service_idx, d as u32),
                };
                if !active {
                    continue;
                }
                let trip = rt.trip_idx;
                let all =
                    self.v2.instance_level[trip as usize] && !self.v2.freq.contains_key(&trip);
                let shared = self.is_shared(trip, route.reader_route_idx);
                let group = self.v2.trip_group[trip as usize];
                let fd = self.v2.first_dep[trip as usize];
                match self.v2.freq.get(&trip) {
                    None => {
                        let t = shift_d.checked_add(dep)?;
                        if t < from || t > self.deadline {
                            continue;
                        }
                        list.push(Departure {
                            time: t,
                            slot: si,
                            inst: Inst {
                                trip,
                                date: d as u32,
                                shift: 0,
                            },
                            approximate: false,
                            all,
                            shared,
                            group,
                            last_of_group: false,
                        });
                    }
                    Some(windows) => {
                        for w in windows {
                            if w.headway <= 0 {
                                return None;
                            }
                            let mut f = w.start;
                            while f < w.end {
                                let shift = f - fd;
                                let t = shift_d + dep + shift;
                                if t > self.deadline {
                                    break;
                                }
                                if t >= from {
                                    list.push(Departure {
                                        time: t,
                                        slot: si,
                                        inst: Inst {
                                            trip,
                                            date: d as u32,
                                            shift,
                                        },
                                        approximate: !w.exact,
                                        all,
                                        shared,
                                        group,
                                        last_of_group: false,
                                    });
                                }
                                f = f.checked_add(w.headway)?;
                            }
                        }
                    }
                }
            }
        }
        // Stable: equal keys keep the per-trip path's visiting order.
        list.sort_by_key(|c| (c.time, c.slot, c.inst.date, c.inst.shift));
        let unshared = (0..list.len() as u32)
            .filter(|&i| !list[i as usize].shared)
            .collect();
        let mut seen = alloc::vec![false; self.v2.group_spread[r as usize].len()];
        let mut suffix_groups = alloc::vec![0u32; list.len() + 1];
        let mut groups = 0u32;
        for i in (0..list.len()).rev() {
            let c = &mut list[i];
            if c.shared && !core::mem::replace(&mut seen[c.group as usize], true) {
                c.last_of_group = true;
                groups += 1;
            }
            suffix_groups[i] = groups;
        }
        Some(Departures {
            eligible,
            list,
            unshared,
            suffix_groups,
        })
    }

    /// Per-slot service-day masks of pattern `r` over the candidate dates
    /// (bit `d - dates.start`), computed once per query: the offset of the
    /// pattern's first slot in `active`. `None` past 64 dates.
    fn active_masks(&mut self, r: u32) -> Option<u32> {
        if self.dates.len() > 64 {
            return None;
        }
        let at = self.active_at[r as usize];
        if at != NONE {
            return Some(at);
        }
        let off = self.active.len() as u32;
        for rt in &self.index.routes[r as usize].trips {
            let mut m = 0u64;
            for (b, d) in self.dates.clone().enumerate() {
                if self.reader.service_active_on_day(rt.service_idx, d as u32) {
                    m |= 1 << b;
                }
            }
            self.active.push(m);
        }
        self.active_at[r as usize] = off;
        Some(off)
    }

    fn proj_of_trip(&self, trip: u32, reader_route: u32) -> Proj {
        let t = trip as usize;
        if self.v2.instance_level.get(t).copied().unwrap_or(false) {
            Proj::Instance(
                Inst {
                    trip,
                    date: 0,
                    shift: 0,
                },
                false,
            )
        } else if self
            .v2
            .rules
            .trip_has_from_rules
            .get(t)
            .copied()
            .unwrap_or(false)
        {
            Proj::Trip(trip, false)
        } else if self
            .v2
            .rules
            .route_has_from_rules
            .get(reader_route as usize)
            .copied()
            .unwrap_or(false)
        {
            Proj::Route(reader_route)
        } else {
            Proj::None
        }
    }

    /// Ride `inst` from `board_pos`, emitting one label per later stop.
    #[allow(clippy::too_many_arguments)]
    fn ride(
        &mut self,
        parent: u32,
        k: u32,
        route_idx: u32,
        slot: u32,
        inst: Inst,
        board_pos: u32,
        transfers: u32,
        in_seat: bool,
        approximate: bool,
        elapsed: i64,
        created: &mut Vec<u32>,
    ) -> Result<(), EngineError> {
        // Every label a ride creates is fixed by the instance, the alight
        // stop, the round and the transfer count: its time, class and flags
        // do not depend on the boarding. An earlier ride of the same instance
        // in the same pattern, boarded no later, in no later a round, with no
        // more transfers, offered each of them first, no later and no worse,
        // and target cuts only grow. So every label of this ride is dominated
        // (by that ride's label, or by whatever dominates it in its class),
        // and riding again adds nothing.
        if self.shortcuts {
            let seen = self.ridden.entry(inst).or_default();
            if seen.covers(board_pos, k, transfers) {
                return Ok(());
            }
            seen.record(board_pos, k, transfers);
        }
        let index = self.index;
        let route = &index.routes[route_idx as usize];
        let rt = &route.trips[slot as usize];
        let ti = self.v2.trips[inst.trip as usize];
        let instance_level = self.v2.instance_level[inst.trip as usize];
        let base = self.date_shift[inst.date as usize]
            .checked_add(inst.shift)
            .ok_or(EngineError::TimeOverflow)?;
        for q in (board_pos as usize + 1)..=(ti.last_pos as usize) {
            if rt.pos_to_row.get(q).copied().unwrap_or(-1) == -1 {
                continue;
            }
            let arr = base
                .checked_add(alight_secs_at(self.reader, rt, q)?)
                .ok_or(EngineError::TimeOverflow)?;
            // Later stops arrive no earlier, at the same transfer count.
            if arr > self.deadline || self.cut(arr, transfers)? {
                break;
            }
            let stop = route.stop_ids[q];
            let terminal = q as u32 == ti.last_pos;
            let mut stay_only = false;
            if drop_off_forbidden_at(self.reader, rt, q) || self.stop_inaccessible(stop)? {
                if instance_level && terminal {
                    stay_only = true;
                } else {
                    continue;
                }
            }
            let l = Label {
                kind: Kind::Transit,
                time: arr,
                transfers,
                round: k,
                stop,
                from_stop: stop,
                walk: 0,
                inst,
                reader_route: route.reader_route_idx,
                at_terminal: terminal,
                stay_only,
                link_only: false,
                alive: true,
                parent,
                route: route_idx,
                slot,
                board_pos,
                alight_pos: q as u32,
                in_seat,
                approximate,
                elapsed,
            };
            // Only a continuation can tell two vehicles apart, and one binds
            // only at an instance-level trip's terminal row. So the arrival
            // competes in the shared class as an ordinary label, and the
            // terminal of an instance-level trip adds a link-only twin keyed
            // by the concrete instance. Keeping the instance in every label's
            // class instead leaves one label per vehicle at every stop it
            // serves: no two vehicles ever dominate each other.
            if !stay_only {
                if let Some(i) = self.insert(l)? {
                    created.push(i);
                }
            }
            if instance_level && terminal {
                if let Some(i) = self.insert(Label {
                    link_only: true,
                    ..l
                })? {
                    created.push(i);
                }
            }
        }
        Ok(())
    }

    /// Explicit type-4/5 and derived in-seat continuations at the source
    /// trip's terminal row.
    fn linked_from(&mut self, li: u32, k: u32, created: &mut Vec<u32>) -> Result<(), EngineError> {
        let l = self.labels[li as usize];
        if !l.link_only {
            return Ok(());
        }
        let src = l.inst.trip;
        let targets: Vec<u32> = self
            .v2
            .rules
            .linked_targets
            .get(&src)
            .cloned()
            .unwrap_or_default();
        for tgt in targets {
            let ti = self.v2.trips[tgt as usize];
            if ti.route == u32::MAX || !self.route_allowed(ti.route) {
                continue;
            }
            let index = self.index;
            let route = &index.routes[ti.route as usize];
            let rt = &route.trips[ti.slot as usize];
            if !self.trip_allowed(rt) {
                continue;
            }
            let to_stop = route.stop_ids[ti.first_pos as usize];
            let t = Transition {
                from_stop: l.stop,
                to_stop,
                from_trip: src,
                from_route: l.reader_route,
                to_trip: tgt,
                to_route: ti.reader_route,
                at_boundary: true,
            };
            let Selected::Linked(sel) = self.v2.rules.resolve(&t).0 else {
                continue;
            };
            let rule = self.v2.rules.linked[sel as usize];
            if !rule.pairing_available {
                continue;
            }
            let min = rule.min_secs.map(|m| m as i64);
            let (elapsed, transfers, in_seat) = if rule.transfer_type == 4 {
                (min.unwrap_or(0), l.transfers, true)
            } else {
                // Type 5: a real alight and re-board.
                if l.stay_only
                    || pickup_forbidden_at(self.reader, rt, ti.first_pos as usize)
                    || self.stop_inaccessible(to_stop)?
                {
                    continue;
                }
                let base = min.map_or(self.min_transfer, |m| m.max(self.min_transfer));
                let e = if to_stop == l.stop {
                    base
                } else if let Some(w) = self.ptft_walk(l.stop, to_stop)? {
                    base.max(w)
                } else if min.is_some() {
                    base
                } else {
                    continue; // required movement unavailable
                };
                (e, l.transfers + 1, false)
            };
            let ready = l
                .time
                .checked_add(elapsed)
                .ok_or(EngineError::TimeOverflow)?;
            let fd = self.v2.first_dep[tgt as usize];
            // The calendar candidate follows the scheduled successor, not the
            // layover floor: the first date whose instance departs at or after
            // the source's scheduled arrival. Inactive or out of horizon exhausts
            // the link.
            let arrive_unix = self
                .origin_unix
                .checked_add(l.time)
                .ok_or(EngineError::TimeOverflow)?;
            let Some(j) = time::first_date_at_or_after(self.reader, fd, arrive_unix)? else {
                continue;
            };
            if !self.reader.service_active_on_day(rt.service_idx, j as u32) {
                continue;
            }
            let dep = self.date_shift[j]
                .checked_add(fd)
                .ok_or(EngineError::TimeOverflow)?;
            // The minimum transfer time and walk are a feasibility floor on that
            // same instance. A scheduled layover shorter than the floor makes the
            // link infeasible; it never re-dates the link to a later service day.
            if dep < ready || dep > self.deadline || dep - l.time > time::MAX_LINK_WAIT_SECS {
                continue;
            }
            let inst = Inst {
                trip: tgt,
                date: j as u32,
                shift: 0,
            };
            self.ride(
                li,
                k,
                ti.route,
                ti.slot,
                inst,
                ti.first_pos,
                transfers,
                in_seat,
                false,
                elapsed,
                created,
            )?;
        }
        let derived: Vec<u32> = self
            .v2
            .derived
            .get(&(src, l.inst.date))
            .cloned()
            .unwrap_or_default();
        for tgt in derived {
            let ti = self.v2.trips[tgt as usize];
            if ti.route == u32::MAX || !self.route_allowed(ti.route) {
                continue;
            }
            let index = self.index;
            let rt = &index.routes[ti.route as usize].trips[ti.slot as usize];
            if !self.trip_allowed(rt) {
                continue;
            }
            let d = l.inst.date as usize;
            let dep = self.date_shift[d]
                .checked_add(self.v2.first_dep[tgt as usize])
                .ok_or(EngineError::TimeOverflow)?;
            if dep < l.time || dep > self.deadline {
                continue;
            }
            let inst = Inst {
                trip: tgt,
                date: d as u32,
                shift: 0,
            };
            self.ride(
                li,
                k,
                ti.route,
                ti.slot,
                inst,
                ti.first_pos,
                l.transfers,
                true,
                false,
                0,
                created,
            )?;
        }
        Ok(())
    }

    /// PTFT edges and synthetic explicit-minimum edges from a transit label.
    fn walk_from(&mut self, li: u32, k: u32, created: &mut Vec<u32>) -> Result<(), EngineError> {
        let l = self.labels[li as usize];
        let edges: Vec<(u32, i64)> = self.ptft_edges(l.stop)?.to_vec();
        for &(s, w) in &edges {
            if l.time.checked_add(w).ok_or(EngineError::TimeOverflow)? > self.deadline {
                continue;
            }
            let nl = Label {
                kind: Kind::WalkPtft,
                stop: s,
                walk: w,
                round: k,
                parent: li,
                alive: true,
                ..l
            };
            if let Some(i) = self.insert(nl)? {
                created.push(i);
            }
        }
        let mut targets: Vec<u32> = Vec::new();
        let keys = [Some(l.stop), self.v2.rules.parent_of(l.stop)];
        for key in keys.iter().flatten() {
            let Some(rows) = self.v2.rules.synthetic_from.get(key) else {
                continue;
            };
            for &oi in rows {
                let r = &self.v2.rules.ordinary[oi as usize];
                if !super::rules::RuleIndex::from_side_matches(r, l.inst.trip, l.reader_route) {
                    continue;
                }
                match self.v2.rules.children.get(&r.to_stop) {
                    Some(ch) => targets.extend_from_slice(ch),
                    None => targets.push(r.to_stop),
                }
            }
        }
        targets.sort_unstable();
        targets.dedup();
        for s in targets {
            if s == l.stop || edges.iter().any(|&(e, _)| e == s) {
                continue;
            }
            let nl = Label {
                kind: Kind::WalkSynthetic,
                stop: s,
                walk: 0,
                round: k,
                parent: li,
                alive: true,
                ..l
            };
            if let Some(i) = self.insert(nl)? {
                created.push(i);
            }
        }
        Ok(())
    }

    fn reconstruct(&self, li: u32) -> Result<Itinerary, EngineError> {
        let mut legs: Vec<Leg> = Vec::new();
        let mut cur = li;
        let transfers = self.labels[li as usize].transfers;
        // Elapsed transfer seconds of the ride that follows a synthetic walk.
        let mut next_elapsed = 0i64;
        let mut rides = 0u32;
        let mut in_seat = 0u32;
        while cur != NONE {
            let l = &self.labels[cur as usize];
            match l.kind {
                Kind::Origin => break,
                Kind::WalkPtft => legs.push(Leg {
                    kind: LegKind::Walk,
                    from_stop: l.from_stop,
                    to_stop: l.stop,
                    depart_secs: l.time,
                    arrive_secs: l.time + l.walk,
                }),
                Kind::WalkSynthetic => legs.push(Leg {
                    kind: LegKind::Walk,
                    from_stop: l.from_stop,
                    to_stop: l.stop,
                    depart_secs: l.time,
                    arrive_secs: l.time + next_elapsed,
                }),
                Kind::Transit => {
                    let route = &self.index.routes[l.route as usize];
                    let rt = &route.trips[l.slot as usize];
                    let base = self.date_shift[l.inst.date as usize] + l.inst.shift;
                    let depart = base + dep_secs_at(self.reader, rt, l.board_pos as usize)?;
                    legs.push(Leg {
                        kind: LegKind::Transit {
                            route_idx: l.route,
                            reader_route_idx: route.reader_route_idx,
                            trip_idx: l.inst.trip,
                            route_type: route.route_type,
                            board_stop_idx: l.board_pos,
                            alight_stop_idx: l.alight_pos,
                            intermediate_stops: l
                                .alight_pos
                                .saturating_sub(l.board_pos)
                                .saturating_sub(1),
                            pattern_stop_ids: route.stop_ids.clone(),
                            approximate: l.approximate,
                        },
                        from_stop: route.stop_ids[l.board_pos as usize],
                        to_stop: l.stop,
                        depart_secs: depart,
                        arrive_secs: l.time,
                    });
                    next_elapsed = l.elapsed;
                    rides += 1;
                    in_seat += l.in_seat as u32;
                }
            }
            cur = l.parent;
        }
        legs.reverse();
        // Search propagated the passenger-transfer count; replay only verifies.
        debug_assert_eq!(rides.saturating_sub(1).saturating_sub(in_seat), transfers);
        let (Some(first), Some(last)) = (legs.first(), legs.last()) else {
            return Err(EngineError::Corrupt("v2 target label without legs"));
        };
        Ok(Itinerary {
            board_secs: first.depart_secs,
            alight_secs: last.arrive_secs,
            transfers,
            legs,
        })
    }
}
