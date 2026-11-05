//! RAPTOR round loop + route scan + board guard + normal alight.
//!
//! Covers round init, `routesToScan` collection, the board guard, the transfer
//! floor, the normal alight, express-skip, footpath relaxation, exit-result
//! recording, the wheelchair stop-skip, and the excluded-mode skip.
//!
//! The normative reference for every decision below is the COMMITTED expected
//! behaviour: `crates/pt-core/tests/raptor_behavior.rs` routes the committed
//! `.ptb` corpus under all three `PatternMode`s and pins the output against
//! `crates/pt-core/tests/golden/`, and `crates/pt-wasm/tests/plan_golden.mjs`
//! replays that same golden through the production `pt-wasm` binding. A change
//! here that moves a result is a deliberate golden update in the same PR.
//!
//! Iteration-determinism: `HashSet`/`HashMap` do NOT iterate in insertion order, and scan order
//! decides which equal-time candidate wins. So anything *iterated* (`routes_to_scan`, `new_marked`,
//! `marked`) is an [`OrderedSet`]; keyed lookups that are never iterated (`best_arrival`,
//! `routes_at_stop`) stay `FxHashMap`.

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use hashbrown::{HashMap, HashSet};
use rustc_hash::FxBuildHasher;

use crate::engine::bitset::Bitset;
use crate::engine::consts::{rescale_walk_secs, INF};
use crate::engine::index::{
    transfer_key_into, transfer_route_scoped_key_into, transfer_trip_scoped_key_into, Index,
    RouteTrip, TransferRuleApplied,
};
use crate::engine::EngineError;
use crate::transfers::Transfers;
use crate::Reader;

/// Resolve a single matched rule's `transfer_type` to the board outcome
/// `(forbid, floor, in_seat)`. A rule has exactly ONE type — this is
/// type→outcome dispatch, NOT a within-rule precedence; the SCOPE precedence
/// (trip>route>unscoped) is resolved earlier in `same_stop_board_rule`.
/// type→outcome: 3 / 2 / 1 / 4 / 5 / no-rule→global floor. Mirrors the TS
/// `applyBoardRule`:
///   - type 3 (not possible)             → forbid the re-board.
///   - type 2 (min_transfer_time)        → floor = min_transfer_secs.
///   - type 1 (timed / guaranteed conn.) → floor 0 (no minimum wait).
///   - type 4 (in-seat / stay-seated)    → floor 0 AND in_seat=true (S3); the
///     board is a stay-seated continuation, marked on the parent so
///     reconstruction can exclude it from the transfer count (Stage 3).
///   - type 5 (in-seat forbidden)        → NORMAL floor (a documented no-op —
///     the engine never performs a stay-seated continuation, S3).
///
/// `base_floor` is the query's minimum transfer
/// ([`crate::engine::Query::min_transfer_floor_secs`]; by default
/// [`RAPTOR_MIN_TRANSFER_SECS`]).
///
/// MODELED LIMITATION (GTFS type 1/4, "the departing vehicle waits / the rider
/// stays seated"): RAPTOR has fixed departures, so we model only the achievable
/// part — a per-pair floor of 0. We do NOT dynamically delay a departure that
/// leaves BEFORE arrival, and we do NOT merge the two transit legs into one —
/// type 4 keeps two legs and only drops the floor + the transfer-count
/// contribution. Standard RAPTOR treatment, symmetric with TS.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
fn apply_board_rule(rule: &TransferRuleApplied, base_floor: i64) -> (bool, i64, bool) {
    match rule.transfer_type {
        3 => (true, base_floor, false),
        2 => (false, rule.min_transfer_secs as i64, false),
        1 => (false, 0, false),
        4 => (false, 0, true),
        // type 5 (in-seat forbidden) → normal floor (no-op).
        _ => (false, base_floor, false),
    }
}

/// The most-specific same-stop board rule (S3) for continuing from `from_ids`
/// (the arriving trip id + its route id at `stop_id`, or `None` when the parent
/// is a walk / entry so no scoped match is possible) onto a `to_trip` (its trip
/// id + route id). Specificity: trip→trip > route→route > stop→stop(unscoped).
/// SAME order + tie-breaks as the TS `sameStopBoardRule`. Returns the matched
/// [`TransferRuleApplied`] (copied; it is `Copy`), or `None` when no rule
/// matches (the caller then uses the global floor). `key_buf` is the caller's
/// reusable scratch so the lookup allocates nothing per call.
fn same_stop_board_rule(
    index: &Index,
    key_buf: &mut String,
    stop_id: &str,
    from_ids: Option<(&str, &str)>, // (from_trip_id, from_route_id)
    to_trip_id: &str,
    to_route_id: &str,
) -> Option<TransferRuleApplied> {
    if let Some((from_trip_id, from_route_id)) = from_ids {
        transfer_trip_scoped_key_into(key_buf, stop_id, stop_id, from_trip_id, to_trip_id);
        if let Some(r) = index.transfer_rules_trip.get(key_buf.as_str()) {
            return Some(*r);
        }
        transfer_route_scoped_key_into(key_buf, stop_id, stop_id, from_route_id, to_route_id);
        if let Some(r) = index.transfer_rules_route.get(key_buf.as_str()) {
            return Some(*r);
        }
    }
    transfer_key_into(key_buf, stop_id, stop_id);
    index.transfer_rules.get(key_buf.as_str()).copied()
}

/// String ids `(trip_id, route_id)` of the trip the rider arrived on at `stop`
/// (the parent transit leg), or `None` when the parent is a walk / entry /
/// absent. Mirrors the TS `arrivingTripIds`: the parent is the one in the round
/// recorded by `last_parent_round[stop]` (the most recent improvement); a
/// [`Parent::Transit`] carries `route_idx`/`trip_idx_in_route`, from which the
/// global trip ordinal → trip_id + the route_id are read. Returns OWNED Strings
/// so they outlive the reader borrows the candidate-rule lookup needs.
fn arriving_trip_ids<B>(
    reader: &Reader<B>,
    index: &Index,
    state: &ScanState,
    stop: u32,
) -> Result<Option<(String, String)>, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let r = match state.last_parent_round.get(&stop) {
        Some(&r) => r as usize,
        None => return Ok(None),
    };
    let parent = match state.parents.get(r).and_then(|p| p.get(&stop)) {
        Some(p) => p,
        None => return Ok(None),
    };
    match parent {
        Parent::Transit {
            route_idx,
            trip_idx_in_route,
            ..
        } => {
            let route = &index.routes[*route_idx as usize];
            let global_trip = route.trips[*trip_idx_in_route as usize].trip_idx;
            let trip_id = reader.trip(global_trip as usize)?.trip_id;
            let route_id = reader.route(route.reader_route_idx as usize)?.route_id;
            Ok(Some((trip_id, route_id)))
        }
        Parent::Walk { .. } => Ok(None),
    }
}

// `FxHashMap`/`FxHashSet` here are the `hashbrown` form with `FxBuildHasher`
// (the `no_std` idiom confirmed in the plan's preconditions — `rustc_hash`'s
// own `FxHashMap`/`FxHashSet` are `std`-gated and unavailable). Wherever the
// plan's code blocks write `FxHashMap`/`FxHashSet`, read them as these aliases.
type FxHashMap<K, V> = HashMap<K, V, FxBuildHasher>;
type FxHashSet<T> = HashSet<T, FxBuildHasher>;

/// Insertion-ordered set of stop/route indices. Iterating yields elements in first-insert order
/// (reproduces V8 `Set` semantics so scan order, and thus which equal-time candidate wins, matches
/// TS).
#[derive(Default)]
pub struct OrderedSet {
    order: Vec<u32>,
    seen: FxHashSet<u32>,
}
impl OrderedSet {
    pub fn insert(&mut self, v: u32) {
        if self.seen.insert(v) {
            self.order.push(v);
        }
    }
    pub fn iter(&self) -> core::slice::Iter<'_, u32> {
        self.order.iter()
    }
    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }
    pub fn as_slice(&self) -> &[u32] {
        &self.order
    }
    pub fn clear(&mut self) {
        self.order.clear();
        self.seen.clear();
    }
}

/// Parent pointer per round, for path reconstruction. Mirrors the TS `Parent` union (30`;
/// round-0/position rationale at the pinned scan order): `null` round-0 entries are simply absent
/// from the per-round map. `alight_stop_idx` is tracked explicitly as a POSITION (not `indexOf`) so
/// a circular route reconstructs at the real alight position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Parent {
    Transit {
        board_stop: u32,
        route_idx: u32,
        trip_idx_in_route: u32,
        board_stop_idx: u32,
        alight_stop_idx: u32,
        /// Concrete board time when this leg boards a GTFS frequencies.txt
        /// exact_times=0 headway instance. `None` for exact scheduled trips.
        frequency_board_secs: Option<i64>,
        /// Concrete frequency offset applied to every downstream template time.
        /// Zero for exact scheduled trips.
        frequency_offset_secs: i64,
        /// True when this parent boards a GTFS frequencies.txt exact_times=0 row.
        approximate: bool,
        /// Whether this board was a GTFS type-4 in-seat (stay-seated)
        /// continuation from the previous transit leg (S3). Mirrors the TS
        /// `ParentTransit.inSeat`. `false` on every ordinary board; the leg list
        /// is unchanged, but reconstruction subtracts in-seat boards from the
        /// transfer count (an in-seat continuation is "0 transfers" for that hop).
        in_seat: bool,
    },
    Walk {
        from_stop: u32,
        walk_secs: i64,
        source_round: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FrequencyBoardResult {
    board_secs: i64,
    offset_secs: i64,
}

fn has_exact_times_zero_frequency<B>(reader: &Reader<B>, trip_idx: u32) -> bool
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    reader
        .frequencies_for_trip(trip_idx)
        .any(|row| row.exact_times == 0)
}

/// One improved exit-stop arrival, recorded per round. Populated by the exit-result recording;
/// defined here because it is a [`ScanState`] field. (`{ round, stopId, arrivalSecs }`.)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitResult {
    pub round: u32,
    pub stop: u32,
    pub arrival_secs: i64,
}

/// Reusable per-query scan buffers. P3 pools one per worker thread; `plan()` calls
/// [`ScanState::reset`] at the top of each query. The flat maps + [`OrderedSet`]s + scratch `Vec`s
/// retain capacity across queries; the per-round `round_arrival`/`parents` maps are rebuilt per
/// query. (Full per-round-map pooling is deferred to P3.)
///
/// **Encapsulation (P3 per-worker pooling).** All scratch fields are
/// `pub(crate)`: the only PUBLIC operations are [`ScanState::default`] (P3
/// constructs one per worker) and [`ScanState::reset`] (P3 reuses it per query).
/// The single public entry that RUNS a query is [`crate::plan`], which calls
/// `reset()` at the top before seeding any state. A caller therefore cannot
/// mutate a `ScanState` out of band between queries — the only way to populate
/// it is through `plan()`, which always clears first. (Within the crate the
/// fields stay reachable so `scan`/`reconstruct`/`plan` can read+write them.)
#[derive(Default)]
pub struct ScanState {
    /// Generation epoch this `ScanState` was last sized for. Used by pt-serve's
    /// hot-reload (P4): when a worker's cached `ScanState.epoch` does not match
    /// the current `Generation.epoch`, the worker reallocates fresh state via
    /// [`ScanState::new_for`] before invoking the engine. `Default` (P3) seeds
    /// this to `0`; producers of new generations bump the counter monotonically.
    pub epoch: u64,
    /// `bestArrival[stop]` — best arrival across all rounds.
    pub(crate) best_arrival: FxHashMap<u32, i64>,
    /// `roundArrival[k][stop]` — best arrival after `k` rounds.
    pub(crate) round_arrival: Vec<FxHashMap<u32, i64>>,
    /// `parents[k][stop]` — parent pointer per round.
    pub(crate) parents: Vec<FxHashMap<u32, Parent>>,
    /// `lastParentRound[stop]` — used by the footpath.
    pub(crate) last_parent_round: FxHashMap<u32, u32>,
    /// `markedStops` for the current round.
    pub(crate) marked: OrderedSet,
    /// `newMarked` accumulated this round.
    pub(crate) new_marked: OrderedSet,
    /// `routesToScan` collected this round.
    pub(crate) routes_to_scan: OrderedSet,
    /// Single-round-guard snapshot scratch for the footpath (the pinned scan order `footSources =
    /// Array.from(newMarked)`).
    pub(crate) foot_sources: Vec<u32>,
    /// Per-round snapshot scratch for the route-scan loop: the `routes_to_scan`
    /// slice copied once per round so the scan doesn't hold an immutable borrow
    /// of `state` across the mutable `best_arrival`/`round_k` updates. Reused
    /// across rounds (cleared + refilled) so the snapshot costs no fresh
    /// allocation after the first round's capacity is established.
    routes_scratch: Vec<u32>,
    /// Entry-stop set, built once per query in `plan()` — the transfer-floor exemption.
    pub(crate) entry_set: FxHashSet<u32>,
    /// Improved exit-stop arrivals (records here; the pinned scan order).
    pub(crate) exit_results: Vec<ExitResult>,
    /// Per-query excluded-mode bitmask: bit `i` set ⇔ `Mode` ordinal `i` is
    /// excluded. Built in `plan()` from `query.excluded_modes`; `0` ⇒ no
    /// exclusion (spec A5).
    pub(crate) excluded_mask: u32,
}
impl ScanState {
    /// Construct a fresh `ScanState` tagged for `epoch`. Used by pt-serve when
    /// the active generation has rolled past the worker's cached scratch state
    /// (P4 hot-reload). The `_index` parameter is currently unused — taken by
    /// reference so callers can pre-size buffers from `index.routes_at_stop()`
    /// etc. in a future P4 task without breaking the signature.
    pub fn new_for(_index: &crate::engine::index::Index, epoch: u64) -> Self {
        Self {
            epoch,
            ..Default::default()
        }
    }

    /// Test-only diagnostic — return the current heap capacity of the
    /// `best_arrival` map. Used by pt-serve's reload tests to assert that
    /// post-swap `ScanState`s are sized for the NEW generation (a worker
    /// reusing a state sized for an old generation's stop space would
    /// silently mis-size on the first reuse, which the epoch-mismatch
    /// reallocation prevents).
    ///
    /// Not load-bearing in production code — kept compiled-in so the
    /// integration test in pt-serve doesn't need a `cfg`-flag dance.
    pub fn capacity_hint(&self) -> usize {
        self.best_arrival.capacity()
    }

    /// Clear all buffers for the next query.
    ///
    /// The flat maps (`best_arrival`, `last_parent_round`), the [`OrderedSet`]s
    /// (`marked`, `new_marked`, `routes_to_scan`), and the scratch `Vec`s
    /// (`foot_sources`, `routes_scratch`) clear in-place and **retain their heap
    /// capacity** across queries.
    ///
    /// The per-round `Vec`s (`round_arrival`, `parents`) are **truncated to
    /// empty** — the round count varies per query, so the outer `Vec`s are
    /// rebuilt each call AND their inner maps are reallocated fresh per round
    /// (no inner-map capacity is pooled here). Full per-round-map pooling is
    /// deferred to P3.
    pub fn reset(&mut self) {
        self.best_arrival.clear();
        self.round_arrival.clear(); // round count varies; rebuild per query
        self.parents.clear();
        self.last_parent_round.clear();
        self.marked.clear();
        self.new_marked.clear();
        self.routes_to_scan.clear();
        self.foot_sources.clear();
        self.routes_scratch.clear();
        self.entry_set.clear();
        self.exit_results.clear();
        self.excluded_mask = 0;
    }
}

/// Lazy reader read of a trip's departure at canonical `pos`, implementing the `.ptb`→TS sentinel
/// map (the pinned scan order `departureSecs[stopPos]`): `-1` when the trip does not serve `pos`
/// (skipped OR present-but-sentinel), else the departure secs.
///
/// **B1.5-T2 dual source.** A FLAT trip (`band == None`: `Off`, no-band)
/// reads `pos_to_row[pos]` → the flat `0xF4` row's `dep_secs`, UNCHANGED. A BAND
/// trip (`band == Some`: `Unbounded`/`CoveringMerge`) decodes from `0x13
/// TripTimes` at band-position `pos - offset` via the hoisted O(1) `BandSlab`
/// (offset 0 under Unbounded). `pos_to_row` is a SERVED MARKER on the band path
/// (`pos` / `-1`), so the `pos_to_row[pos] == -1` "not served" guard is the same
/// on both. Band decode == flat decode by construction (T1 equivalence; the flat
/// carry is still present so the engine-regression gate's flat-vs-band IS the
/// proof).
pub(crate) fn dep_secs_at<B>(
    reader: &Reader<B>,
    trip: &RouteTrip,
    pos: usize,
) -> Result<i64, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    if let Some(bc) = trip.band.as_ref() {
        // Band: the served-marker `-1` short-circuits without a slab read;
        // otherwise decode `0x13` at band-position `pos - offset`.
        if trip.pos_to_row.get(pos).copied().unwrap_or(-1) == -1 {
            return Ok(-1);
        }
        let band_pos = pos - bc.offset as usize; // marker guarantees pos >= offset
        return Ok(reader.band_dep_at(&bc.slab, bc.local_t as usize, band_pos));
    }
    match trip.pos_to_row.get(pos).copied().unwrap_or(-1) {
        -1 => Ok(-1),
        row => Ok(reader.dep_secs(row as usize)? as i64),
    }
}

/// Lazy reader read of a trip's alight time at canonical `pos`:
/// `dep_secs + arr_diff`. Since `arr_diff = -dwell` (`arr_diff <= 0`), this is
/// `departHere - dwell`. Caller guarantees the trip serves
/// `pos` (`pos_to_row[pos] != -1`).
///
/// **B1.5-T2 dual source** — see [`dep_secs_at`]. FLAT: the flat `0xF4` row's
/// `dep_secs + arr_diff`. BAND: `0x13` `band_arr_at` at band-position
/// `pos - offset`.
pub(crate) fn alight_secs_at<B>(
    reader: &Reader<B>,
    trip: &RouteTrip,
    pos: usize,
) -> Result<i64, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    if let Some(bc) = trip.band.as_ref() {
        let band_pos = pos - bc.offset as usize; // caller guarantees served ⇒ pos >= offset
        return Ok(reader.band_arr_at(&bc.slab, bc.local_t as usize, band_pos));
    }
    let row = trip.pos_to_row[pos]; // caller guarantees != -1
    let st = reader.stop_time(row as usize)?;
    Ok(st.dep_secs as i64 + st.arr_diff as i64) // = departHere - dwell
}

fn first_served_departure_secs<B>(
    reader: &Reader<B>,
    trip: &RouteTrip,
) -> Result<Option<i64>, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    for pos in 0..trip.pos_to_row.len() {
        let dep = dep_secs_at(reader, trip, pos)?;
        if dep != -1 {
            return Ok(Some(dep));
        }
    }
    Ok(None)
}

/// Compute the next concrete `exact_times=0` headway instance for a template trip.
/// GTFS `frequencies.txt` windows are expressed in the template trip's first served
/// stop timebase, not necessarily position 0.
/// GTFS reference: https://gtfs.org/documentation/schedule/reference/#frequenciestxt
fn frequency_board<B>(
    reader: &Reader<B>,
    trip_idx: u32,
    earliest_board: i64,
    template_first_departure_secs: i64,
    template_board_secs: i64,
) -> Option<FrequencyBoardResult>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let template_offset = template_board_secs - template_first_departure_secs;
    let earliest_first_departure = earliest_board - template_offset;
    let mut best: Option<FrequencyBoardResult> = None;
    for row in reader.frequencies_for_trip(trip_idx) {
        if row.exact_times != 0 {
            continue;
        }
        let start = row.start_secs as i64;
        let end = row.end_secs as i64;
        let headway = row.headway_secs as i64;
        if earliest_first_departure >= end {
            continue;
        }
        let first_departure = if earliest_first_departure <= start {
            start
        } else {
            start + ((earliest_first_departure - start + headway - 1) / headway) * headway
        };
        if first_departure < end {
            let offset_secs = first_departure - template_first_departure_secs;
            let candidate = FrequencyBoardResult {
                board_secs: template_board_secs + offset_secs,
                offset_secs,
            };
            if best
                .as_ref()
                .map(|b| candidate.board_secs < b.board_secs)
                .unwrap_or(true)
            {
                best = Some(candidate);
            }
        }
    }
    best
}

/// Whether BOARDING is forbidden at canonical `pos` (`pickup_type == 1`, A1).
/// Caller queries only positions the trip SERVES (`pos_to_row[pos] != -1`).
///
/// **B1.5-T2 dual source.** FLAT trip (`band == None`): the flat `0xFA` row's
/// `pickup_forbidden`, UNCHANGED. BAND trip (`band == Some`): the `0x12
/// PatternSemantics` byte of the trip's OWN band pattern at band-position
/// `pos - offset` — under a `CoveringMerge` fold the boarding lives under the
/// folded trip's source pattern, not the route's surviving pattern (exactly as
/// the flat path read it off the trip's own `0xFA` row).
#[inline]
pub(crate) fn pickup_forbidden_at<B>(reader: &Reader<B>, trip: &RouteTrip, pos: usize) -> bool
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    match trip.band.as_ref() {
        Some(bc) => reader.band_pickup_forbidden_at(bc.semantics_base, pos - bc.offset as usize),
        None => reader.pickup_forbidden(trip.pos_to_row[pos] as usize),
    }
}

/// Whether ALIGHTING is forbidden at canonical `pos` (`drop_off_type == 1`, A1).
/// Caller queries only positions the trip SERVES. **B1.5-T2 dual source** — see
/// [`pickup_forbidden_at`].
#[inline]
pub(crate) fn drop_off_forbidden_at<B>(reader: &Reader<B>, trip: &RouteTrip, pos: usize) -> bool
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    match trip.band.as_ref() {
        Some(bc) => reader.band_drop_off_forbidden_at(bc.semantics_base, pos - bc.offset as usize),
        None => reader.drop_off_forbidden(trip.pos_to_row[pos] as usize),
    }
}

/// Run the RAPTOR round loop over a reusable [`ScanState`].
///
/// Round 0 seed + rounds `1..=max_rounds` with normal alight + board, express-skip alt-trip,
/// footpath relaxation, exit-result recording, and wheelchair stop/trip skips + excluded-mode skip.
///
/// `transfers` is the decoded pedestrian-transfer CSR (the pinned scan order
/// `index.footTransfers`). `None` ⇒ the footpath block is skipped entirely, so
/// behaviour is unchanged (the haversine fallback is the caller's concern, not
/// the engine's — `raptor.transfers.test.ts:134-145`).
///
/// `active.get(service_idx) == true` ⇔ that service runs on the query date
/// (`engine::service::active_services` `activeServiceIds.has`).
/// `active` is a [`Bitset`] (one bit per service); `get` panics on OOB exactly
/// like the `Vec<bool>` it replaced (safe by construction — `service_idx <
/// num_services`).
pub(crate) fn run_scan<B>(
    reader: &Reader<B>,
    index: &Index,
    state: &mut ScanState,
    query: &crate::engine::Query,
    active: &Bitset,
    transfers: Option<&Transfers>,
    abort: Option<&core::sync::atomic::AtomicBool>,
) -> Result<(), EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let max_rounds = query
        .max_rounds
        .unwrap_or(crate::engine::consts::RAPTOR_MAX_ROUNDS);

    // `is_wheelchair` gates the wheelchair stop-skip and the
    // trip-skips. `is_bicycle` gates the bicycle trip-skips
    // only (no stop-skip equivalent — GTFS has no stop-level bikes field).
    // `excluded_modes` gates the route-entry mode skip; applied
    // via state.excluded_mask (built once in plan()); an empty set ⇒ mask == 0 ⇒ no-op.
    let is_wheelchair = matches!(query.mobility, crate::engine::Mobility::Wheelchair);
    let is_bicycle = matches!(query.mobility, crate::engine::Mobility::Bicycle);
    // The query's transfer-walk speed and its minimum transfer where no
    // transfers.txt rule sets one (the global floor; `Query` docs).
    let walk_speed_mm_s = query.transfer_walk_speed_mm_s();
    let min_transfer = query.min_transfer_floor_secs();

    // Reusable key scratch for the UNSCOPED GTFS transfers.txt lookups (S1):
    // the same-stop board floor (sites A/B) and the per-edge footpath rule. One
    // buffer for the whole scan — `transfer_key_into` clears+refills it, so each
    // lookup allocates nothing. Empty `transfer_rules` ⇒ every lookup misses and
    // behaviour is exactly pre-S1.
    // GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
    let mut transfer_key_buf = String::new();

    // Whether the feed carries ANY transfers.txt rule (mirror of the TS
    // `hasTransferRules` hoist). With all three maps empty,
    // `same_stop_board_rule` can only miss and every candidate resolves to the
    // global RAPTOR_MIN_TRANSFER_SECS floor — the precondition for the F1
    // uniform-floor board-search fast path below.
    let has_transfer_rules = !index.transfer_rules.is_empty()
        || !index.transfer_rules_trip.is_empty()
        || !index.transfer_rules_route.is_empty();

    // Best (lowest) arrival_secs pushed to exit_results per exit stop (F3).
    // Replaces the per-round `exit_results.iter().any(...)` linear scan: an
    // entry is pushed only when it strictly improves on every prior entry for
    // the stop, so "some prior entry has arrival_secs <= arr_t" ⟺ "min per
    // stop <= arr_t", and each push lowers that min to its own arrival_secs.
    let mut best_exit_arrival: FxHashMap<u32, i64> =
        HashMap::with_capacity_and_hasher(query.exit_stops.len(), FxBuildHasher);

    // bestArrival is NOT pre-seeded to INF per stop (97 does that
    // over `allStopIds`); we treat an absent key as INF via `unwrap_or(&INF)`,
    // which is observationally identical for every read in the scan.

    // ----- Round 0: seed entry stops -----
    let mut round0: FxHashMap<u32, i64> =
        HashMap::with_capacity_and_hasher(query.entry_stops.len(), FxBuildHasher);
    let parent0: FxHashMap<u32, Parent> = HashMap::with_capacity_and_hasher(0, FxBuildHasher);
    for sw in &query.entry_stops {
        // saturating_add: departure_secs is caller-supplied (P3 external queries),
        // so a hostile/huge value must not overflow-panic (debug) / wrap (release).
        // INF (9e15) ≪ i64::MAX, so saturating preserves the INF sentinel semantics.
        let arrive_at = query.departure_secs.saturating_add(sw.walk_secs as i64);
        round0.insert(sw.stop, arrive_at);
        state.best_arrival.insert(sw.stop, arrive_at);
        // parent0 stays absent (the TS `null` round-0 entry).
        state.last_parent_round.insert(sw.stop, 0);
        state.marked.insert(sw.stop); // markedStops = entryStops
    }
    // parent0 carries no entries; pushed for round-index alignment.
    state.round_arrival.push(round0);
    state.parents.push(parent0);

    // ----- Rounds 1..=max_rounds -----
    for k in 1..=max_rounds {
        // Cooperative wall-clock bound (see `plan_with_abort`): checked at
        // round granularity — cheap (one atomic load per round) and prompt
        // enough, a single round is the engine's natural unit of work. Can
        // only REMOVE work, never alter a produced result (the whole scan is
        // discarded), so TS-equivalence is unaffected when `abort` is None.
        if let Some(flag) = abort {
            if flag.load(core::sync::atomic::Ordering::Relaxed) {
                return Err(EngineError::Aborted);
            }
        }
        // Copy previous round forward into round k.
        let prev = &state.round_arrival[(k - 1) as usize];
        let mut round_k: FxHashMap<u32, i64> =
            HashMap::with_capacity_and_hasher(prev.len(), FxBuildHasher);
        for (&stop, &t) in prev.iter() {
            round_k.insert(stop, t);
        }
        let mut parent_k: FxHashMap<u32, Parent> =
            HashMap::with_capacity_and_hasher(0, FxBuildHasher);

        // Collect routesToScan from markedStops. Insertion
        // order = marked order, then route order within each stop's CSR list.
        state.routes_to_scan.clear();
        for &stop in state.marked.iter() {
            if let Some(route_idxs) = index.routes_at_stop.get(&stop) {
                for &ridx in route_idxs {
                    state.routes_to_scan.insert(ridx);
                }
            }
        }

        state.new_marked.clear();

        // Scan each route.
        // Snapshot the route-index list so we don't hold an immutable borrow of
        // `state` across the mutable best_arrival/round_k updates. Reuse the
        // persistent `routes_scratch` buffer (take it out so the loop owns the
        // snapshot while it mutably borrows `state`, then restore it) — same
        // snapshot semantics (taken before mutation), no fresh per-round alloc.
        let mut routes = core::mem::take(&mut state.routes_scratch);
        routes.clear();
        routes.extend_from_slice(state.routes_to_scan.as_slice());
        for &route_idx in &routes {
            let route = &index.routes[route_idx as usize];

            // Excluded-mode skip (spec A5): per-route by derived Mode via the
            // u32 bitmask built once in plan(). Empty mask ⇒ no-op short-circuit.
            if query.excluded_routes.contains(&route.reader_route_idx)
                || (state.excluded_mask != 0
                    && (state.excluded_mask >> (route.mode as u32)) & 1 != 0)
            {
                continue;
            }

            let route_has_exact_times_zero_frequency = route
                .trips
                .iter()
                .any(|trip| has_exact_times_zero_frequency(reader, trip.trip_idx));
            // F1 fast-path gate (mirror of the pinned scan order): the canonical-hop board
            // search requires non-decreasing serving departures per position
            // (computed once at index build) AND concrete departures
            // (`effective_dep == dep_at_stop`), which a zero-frequency
            // template breaks. Routes failing either keep the legacy scan.
            let board_sorted = !route_has_exact_times_zero_frequency && route.board_sorted;
            let mut boarding_trip: Option<usize> = None;
            let mut board_stop_idx: i64 = -1;
            let mut board_approximate = false;
            let mut board_frequency_secs: Option<i64> = None;
            let mut board_frequency_offset_secs = 0;
            // Whether the current `boarding_trip` was boarded via a GTFS type-4
            // in-seat (stay-seated) continuation (S3). Stamped onto the normal
            // alight's parent. Mirrors the TS `boardInSeat`.
            let mut board_in_seat = false;

            for stop_pos in 0..route.stop_ids.len() {
                let stop_idx = route.stop_ids[stop_pos];

                // Wheelchair stop-skip — the FIRST statement
                // of the stop_pos body, BEFORE alight and board. Skipping with
                // `continue` leaves `boarding_trip`/`board_stop_idx` untouched, so
                // a trip boarded earlier carries across the inaccessible stop and
                // can still alight at a later accessible position. Only `== 2`
                // (not-accessible) is skipped; 0/1 are allowed. Hot-path accessor
                // reads the wheelchair u8 only — `reader.stop(i)` would allocate
                // stop_id + stop_name every position.
                if is_wheelchair && reader.stop_wheelchair_boarding(stop_idx as usize)? == 2 {
                    continue;
                }

                // ---- Alight: can we get off here and improve arrival? ----
                if let Some(bt) = boarding_trip {
                    let trip = &route.trips[bt];
                    let depart_here = dep_secs_at(reader, trip, stop_pos)?;
                    if depart_here == -1 {
                        // Express-skip alt-trip fallback. The boarded trip skips
                        // this stop; search all candidate trips from the same board
                        // position and keep the best concrete effective board.
                        let board_stop = route.stop_ids[board_stop_idx as usize];
                        let board_arrival = *state.best_arrival.get(&board_stop).unwrap_or(&INF);
                        let is_board_entry = state.entry_set.contains(&board_stop);
                        // Same-stop transfers.txt rule at the (re-)board stop
                        // (S1/S2 unscoped + S3 scoped), resolved PER CANDIDATE
                        // against the arriving trip (the parent of board_stop) and
                        // the candidate's own ids. type 3 forbids the re-board onto
                        // that candidate; type 2 → min_transfer_time floor; type
                        // 1/4 → floor 0; type 5 / no rule → the global floor. Only
                        // when the floor would apply (k>1 && non-entry); round-1/
                        // entry re-boards keep wait 0 exactly as pre-S1. The
                        // arriving-trip half (from_ids) + the constant route id are
                        // resolved ONCE per board stop. board_id (the stop id
                        // string) is the same for the from/to halves of a same-stop
                        // rule. GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
                        let floor_applies = k > 1 && !is_board_entry;
                        let from_ids: Option<(String, String)> = if floor_applies {
                            arriving_trip_ids(reader, index, state, board_stop)?
                        } else {
                            None
                        };
                        let board_id: String = if floor_applies {
                            reader.stop_id(board_stop as usize)?.to_string()
                        } else {
                            String::new()
                        };
                        let board_route_id: String = if floor_applies {
                            reader.route(route.reader_route_idx as usize)?.route_id
                        } else {
                            String::new()
                        };

                        // Cheap early reject (F1, mirror of the pinned scan order). When no
                        // per-candidate transfers.txt rule can apply (uniform
                        // floor) and the route has no zero-frequency template
                        // (`effective_dep_at_board == dep_at_board`, `alt_freq`
                        // always None), a candidate departing the board stop
                        // before `board_arrival + min_wait` is EXACTLY the set
                        // the loop body `continue`s on at the
                        // `effective_dep_at_board < board_earliest` check —
                        // every check in between is pure. Hoisting it skips the
                        // per-candidate trip_id read, the O(stops)
                        // first_served_departure_secs walk and the frequency
                        // lookups for the (typically large) prefix of trips
                        // that already departed.
                        let alt_cheap_reject = !(route_has_exact_times_zero_frequency
                            || (floor_applies && has_transfer_rules));
                        let alt_reject_below = if alt_cheap_reject {
                            board_arrival + if floor_applies { min_transfer } else { 0 }
                        } else {
                            0
                        };
                        let mut alt_trip: Option<usize> = None;
                        let mut alt_in_seat = false;
                        let mut alt_best_arrival = INF;
                        let mut alt_best_board_secs = INF;
                        let mut alt_approximate = false;
                        let mut alt_frequency_board_secs: Option<i64> = None;
                        let mut alt_frequency_offset_secs = 0;
                        for t in 0..route.trips.len() {
                            let cand = &route.trips[t];
                            if !active.get(cand.service_idx as usize) {
                                continue;
                            }
                            if is_wheelchair && cand.wheelchair_accessible == 2 {
                                continue;
                            }
                            if is_bicycle && cand.bikes_allowed == 2 {
                                continue;
                            }
                            let dep_at_board = dep_secs_at(reader, cand, board_stop_idx as usize)?;
                            if dep_at_board == -1 {
                                continue;
                            }
                            if alt_cheap_reject && dep_at_board < alt_reject_below {
                                continue;
                            }
                            // Pickup predicate (A1, the pinned scan order alt-trip board): a
                            // candidate whose pickup_type == 1 at the (re-)board
                            // stop forbids boarding here — skip it (continue, like
                            // the transfer_type == 3 forbid precedent). The position
                            // is SERVED (!= -1) per the dep_at_board check above, so
                            // pickup_forbidden_at reads the candidate's flat 0xFA row
                            // or its band 0x12 byte (B1.5-T2).
                            // GTFS reference: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
                            if pickup_forbidden_at(reader, cand, board_stop_idx as usize) {
                                continue;
                            }
                            // Per-candidate floor (S3). No rule ⇒ the global floor
                            // exactly as pre-S1; type-3 (forbid) ⇒ skip this
                            // candidate; type 4 ⇒ floor 0 + in-seat. Plain `+`
                            // (not saturating): board_arrival is a real arrival
                            // (< INF) here, never the sentinel — matches the pinned scan order.
                            let (board_min_wait, cand_in_seat) = if floor_applies {
                                let cand_trip_id = reader.trip(cand.trip_idx as usize)?.trip_id;
                                let rule = same_stop_board_rule(
                                    index,
                                    &mut transfer_key_buf,
                                    &board_id,
                                    from_ids.as_ref().map(|(t, r)| (t.as_str(), r.as_str())),
                                    &cand_trip_id,
                                    &board_route_id,
                                );
                                match rule {
                                    None => (min_transfer, false),
                                    Some(r) if r.transfer_type == 3 => continue,
                                    Some(r) => {
                                        let (_, floor, in_seat) =
                                            apply_board_rule(&r, min_transfer);
                                        (floor, in_seat)
                                    }
                                }
                            } else {
                                (0, false)
                            };
                            let board_earliest = board_arrival + board_min_wait;
                            let template_first_departure_secs =
                                match first_served_departure_secs(reader, cand)? {
                                    Some(secs) => secs,
                                    None => continue,
                                };
                            let alt_freq = frequency_board(
                                reader,
                                cand.trip_idx,
                                board_earliest,
                                template_first_departure_secs,
                                dep_at_board,
                            );
                            if alt_freq.is_none()
                                && has_exact_times_zero_frequency(reader, cand.trip_idx)
                            {
                                continue;
                            }
                            let effective_dep_at_board = alt_freq
                                .as_ref()
                                .map(|f| f.board_secs)
                                .unwrap_or(dep_at_board);
                            if effective_dep_at_board < board_earliest {
                                continue;
                            }
                            let dep_at_here = dep_secs_at(reader, cand, stop_pos)?;
                            if dep_at_here == -1 {
                                continue; // candidate also skips this stop
                            }
                            let frequency_offset_secs =
                                alt_freq.as_ref().map(|f| f.offset_secs).unwrap_or(0);
                            let arr_at_here =
                                alight_secs_at(reader, cand, stop_pos)? + frequency_offset_secs;
                            // Drop-off predicate (A1, the pinned scan order alt-trip alight): a
                            // candidate whose drop_off_type == 1 at this stop forbids
                            // alighting here — skip it. The position is SERVED (!= -1)
                            // per the dep_at_here check above (and alight_secs_at's
                            // != -1 contract), so drop_off_forbidden_at reads the
                            // candidate's flat 0xFA row or its band 0x12 byte (B1.5-T2).
                            // GTFS reference: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
                            if drop_off_forbidden_at(reader, cand, stop_pos) {
                                continue;
                            }
                            if arr_at_here < *state.best_arrival.get(&stop_idx).unwrap_or(&INF)
                                && (arr_at_here < alt_best_arrival
                                    || (arr_at_here == alt_best_arrival
                                        && effective_dep_at_board < alt_best_board_secs))
                            {
                                alt_trip = Some(t);
                                alt_in_seat = cand_in_seat;
                                alt_best_arrival = arr_at_here;
                                alt_best_board_secs = effective_dep_at_board;
                                alt_approximate = alt_freq.is_some();
                                alt_frequency_board_secs = alt_freq.map(|f| f.board_secs);
                                alt_frequency_offset_secs = frequency_offset_secs;
                            }
                        }
                        if let Some(at) = alt_trip {
                            // Deliberate double-read of alight_secs_at: the
                            // first read (above) was inside the
                            // candidate loop to test improvement; this second
                            // read is in the apply block
                            // after alt_trip is confirmed. Mirrors TS exactly —
                            // not a missed optimisation.
                            let alt_arrival = alight_secs_at(reader, &route.trips[at], stop_pos)?
                                + alt_frequency_offset_secs;
                            round_k.insert(stop_idx, alt_arrival);
                            state.best_arrival.insert(stop_idx, alt_arrival);
                            parent_k.insert(
                                stop_idx,
                                Parent::Transit {
                                    board_stop,
                                    route_idx,
                                    trip_idx_in_route: at as u32,
                                    board_stop_idx: board_stop_idx as u32,
                                    alight_stop_idx: stop_pos as u32, // POSITION, not indexOf
                                    frequency_board_secs: alt_frequency_board_secs,
                                    frequency_offset_secs: alt_frequency_offset_secs,
                                    approximate: alt_approximate,
                                    in_seat: alt_in_seat, // type-4 onto the alt trip (S3)
                                },
                            );
                            state.last_parent_round.insert(stop_idx, k);
                            state.new_marked.insert(stop_idx);
                        }
                    } else {
                        // Normal alight.
                        let arrive_here =
                            alight_secs_at(reader, trip, stop_pos)? + board_frequency_offset_secs;
                        // Drop-off predicate (A1, the pinned scan order main alight): drop_off_
                        // type == 1 (board-only) ⇒ no alighting here. `continue`
                        // skips this stop_pos's alight (still inside the
                        // `for stop_pos` loop) — and, mirroring the pinned scan order byte-for-
                        // byte, ALSO skips the board phase for this position; the
                        // board check below still runs at LATER positions. Only `1`
                        // forbids (0 / 2 / 3 alightable). The position is SERVED
                        // (!= -1) per alight_secs_at's contract (this is the
                        // depart_here != -1 branch), so drop_off_forbidden_at reads
                        // the flat 0xFA row or the band 0x12 byte (B1.5-T2).
                        // GTFS reference: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
                        if drop_off_forbidden_at(reader, trip, stop_pos) {
                            continue;
                        }
                        if arrive_here < *state.best_arrival.get(&stop_idx).unwrap_or(&INF) {
                            round_k.insert(stop_idx, arrive_here);
                            state.best_arrival.insert(stop_idx, arrive_here);
                            parent_k.insert(
                                stop_idx,
                                Parent::Transit {
                                    board_stop: route.stop_ids[board_stop_idx as usize],
                                    route_idx,
                                    trip_idx_in_route: bt as u32,
                                    board_stop_idx: board_stop_idx as u32,
                                    alight_stop_idx: stop_pos as u32, // POSITION, not indexOf
                                    frequency_board_secs: board_frequency_secs,
                                    frequency_offset_secs: board_frequency_offset_secs,
                                    approximate: board_approximate,
                                    in_seat: board_in_seat, // stamped from the board (S3)
                                },
                            );
                            state.last_parent_round.insert(stop_idx, k);
                            state.new_marked.insert(stop_idx);
                        }
                    }
                }

                // ---- Board: can we board an earlier trip here? ----
                let arrival_at_stop = *state.best_arrival.get(&stop_idx).unwrap_or(&INF);
                if arrival_at_stop < INF {
                    // Transfer floor: round 1 and entry
                    // stops are exempt from RAPTOR_MIN_TRANSFER_SECS.
                    let is_entry_stop = state.entry_set.contains(&stop_idx);
                    // Whether the same-stop transfer floor/rule applies at all.
                    // The arriving-trip half (from_ids), the board-stop id, and
                    // the constant route id are resolved ONCE per stop; only the
                    // `to` half varies per candidate (S3). round-1/entry boards
                    // keep wait 0 exactly as pre-S1.
                    // GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
                    let floor_applies = k > 1 && !is_entry_stop;

                    let mut current_best_board_secs = INF;
                    let mut incumbent: Option<usize> = None;
                    if let Some(bt) = boarding_trip {
                        let current_trip_dep = dep_secs_at(reader, &route.trips[bt], stop_pos)?;
                        if current_trip_dep != -1 {
                            current_best_board_secs =
                                current_trip_dep + board_frequency_offset_secs;
                            incumbent = Some(bt);
                        } else {
                            // The incumbent boarded trip skips this stop. Do not
                            // replace it while scanning the skipped position; an
                            // alt-trip parent may serve this stop, but the rider
                            // stays on the incumbent for downstream stops.
                            continue;
                        }
                    }

                    // Whether every candidate resolves to the SAME wait floor:
                    // either the floor doesn't apply at all (round 1 / entry
                    // stop) or the feed has no transfers.txt rules, so
                    // `same_stop_board_rule` can only miss and the global
                    // RAPTOR_MIN_TRANSFER_SECS applies uniformly. Only then can
                    // a candidate be rejected on `dep_at_stop` alone.
                    let uniform_floor = !(floor_applies && has_transfer_rules);

                    if board_sorted && uniform_floor {
                        if let Some(bt0) = incumbent {
                            // F1 fast path — the canonical RAPTOR hop (mirror of
                            // the pinned scan order; the full equivalence argument lives
                            // there). With serving departures non-decreasing in
                            // array order at every position (board_sorted), no
                            // zero-frequency template on the route
                            // (effective_dep == dep_at_stop, freq lookups always
                            // None) and a uniform floor, the legacy loop's
                            // outcome at this stop is exactly: first eligible
                            // serving trip t* (array order) with dep >=
                            // earliest_board; adopt iff dep(t*) < incumbent's
                            // dep; break. Sortedness confines any adoptable t*
                            // to indices BELOW the incumbent, and t* is the
                            // LOWEST eligible serving trip in that window. So:
                            // scan DOWN from the incumbent, remember the lowest
                            // eligible serving trip with dep >= earliest_board,
                            // stop at the first serving trip departing earlier.
                            // Identical adoptions, identical stamps (freq fields
                            // degenerate; no rule was consulted so in_seat is
                            // false), O(window) instead of O(trips) per stop.
                            let earliest_board =
                                arrival_at_stop + if floor_applies { min_transfer } else { 0 };
                            let mut best: Option<(usize, i64)> = None;
                            let mut t = bt0;
                            while t > 0 {
                                t -= 1;
                                let trip = &route.trips[t];
                                let dep = dep_secs_at(reader, trip, stop_pos)?;
                                if dep == -1 {
                                    continue; // not served: sortedness says nothing
                                }
                                if dep < earliest_board {
                                    break; // all earlier serving trips depart even earlier
                                }
                                if !active.get(trip.service_idx as usize) {
                                    continue;
                                }
                                if is_wheelchair && trip.wheelchair_accessible == 2 {
                                    continue;
                                }
                                if is_bicycle && trip.bikes_allowed == 2 {
                                    continue;
                                }
                                if pickup_forbidden_at(reader, trip, stop_pos) {
                                    continue;
                                }
                                best = Some((t, dep));
                            }
                            // Adopt only on a STRICTLY earlier departure — an
                            // equal-departure candidate is not adopted by the
                            // legacy loop either (it breaks without replacing).
                            // `current_best_board_secs` == the incumbent's dep
                            // here: no zero-frequency template on the route ⇒
                            // board_frequency_offset_secs is 0 for every board.
                            if let Some((bt2, dep)) = best {
                                if dep < current_best_board_secs {
                                    boarding_trip = Some(bt2);
                                    board_stop_idx = stop_pos as i64;
                                    board_in_seat = false;
                                    board_approximate = false;
                                    board_frequency_secs = None;
                                    board_frequency_offset_secs = 0;
                                }
                            }
                            continue; // done with this stop position
                        }
                    }

                    // Legacy scan. The arriving-trip half (from_ids), the
                    // board-stop id, and the constant route id are resolved ONCE
                    // per stop; only the `to` half varies per candidate (S3).
                    // round-1/entry boards keep wait 0 exactly as pre-S1.
                    // GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
                    let from_ids: Option<(String, String)> = if floor_applies {
                        arriving_trip_ids(reader, index, state, stop_idx)?
                    } else {
                        None
                    };
                    let here_id: String = if floor_applies {
                        reader.stop_id(stop_idx as usize)?.to_string()
                    } else {
                        String::new()
                    };
                    let here_route_id: String = if floor_applies {
                        reader.route(route.reader_route_idx as usize)?.route_id
                    } else {
                        String::new()
                    };

                    // Cheap early reject (F1, mirror of the pinned scan order): under a
                    // uniform floor on a route without zero-frequency templates,
                    // a candidate with dep_at_stop < earliest_board is EXACTLY
                    // the set the loop body ignores at the
                    // `effective_dep_at_stop >= earliest_board` check (all
                    // intermediate checks are pure) — skip it before the
                    // per-candidate trip_id read, the O(stops)
                    // first_served_departure_secs walk and the freq lookups.
                    let cheap_reject = uniform_floor && !route_has_exact_times_zero_frequency;
                    let reject_below = if cheap_reject {
                        arrival_at_stop + if floor_applies { min_transfer } else { 0 }
                    } else {
                        0
                    };

                    for (ti, trip) in route.trips.iter().enumerate() {
                        if !active.get(trip.service_idx as usize) {
                            continue;
                        }
                        // Wheelchair trip-skip: skip trips that are not wheelchair-accessible (`==
                        // 2`). 0/1 allowed. The express-skip candidate loop already has its
                        // equivalent.
                        if is_wheelchair && trip.wheelchair_accessible == 2 {
                            continue;
                        }
                        // Bicycle trip-skip: skip trips that forbid bikes (==2).
                        // 0/1/out-of-range kept. Trip-level only — no stop-skip.
                        if is_bicycle && trip.bikes_allowed == 2 {
                            continue;
                        }
                        let dep_at_stop = dep_secs_at(reader, trip, stop_pos)?;
                        if dep_at_stop == -1 {
                            continue; // trip skips this stop
                        }
                        if cheap_reject && dep_at_stop < reject_below {
                            continue;
                        }
                        // Pickup predicate (A1, the pinned scan order main board): pickup_type
                        // == 1 (alight-only) ⇒ no boarding here; try the next trip
                        // (continue, like the transfer_type == 3 forbid). 0 / 2 / 3
                        // are all boardable; only `1` forbids. UNCONDITIONAL — an
                        // alight-only origin stop is unboardable regardless of
                        // round/floor. The position is SERVED (!= -1) per the
                        // dep_at_stop check above, so pickup_forbidden_at reads the
                        // flat 0xFA row or the band 0x12 byte (B1.5-T2).
                        // GTFS reference: https://gtfs.org/documentation/schedule/reference/#stop_timestxt
                        if pickup_forbidden_at(reader, trip, stop_pos) {
                            continue;
                        }
                        // Per-candidate same-stop board rule (S3 scoped + S1/S2
                        // unscoped). No rule ⇒ the global floor exactly as pre-S1;
                        // type-3 (forbid) ⇒ skip this candidate (the re-board onto
                        // it is not possible) and try the next; type 4 ⇒ floor 0 +
                        // in-seat. Trips are sorted by departure, so the first
                        // NON-forbidden trip satisfying its OWN floor is still the
                        // earliest boardable.
                        let (min_wait, cand_in_seat) = if floor_applies {
                            let cand_trip_id = reader.trip(trip.trip_idx as usize)?.trip_id;
                            let rule = same_stop_board_rule(
                                index,
                                &mut transfer_key_buf,
                                &here_id,
                                from_ids.as_ref().map(|(t, r)| (t.as_str(), r.as_str())),
                                &cand_trip_id,
                                &here_route_id,
                            );
                            match rule {
                                None => (min_transfer, false),
                                Some(r) if r.transfer_type == 3 => continue,
                                Some(r) => {
                                    let (_, floor, in_seat) = apply_board_rule(&r, min_transfer);
                                    (floor, in_seat)
                                }
                            }
                        } else {
                            (0, false)
                        };
                        let earliest_board = arrival_at_stop + min_wait;
                        let template_first_departure_secs =
                            match first_served_departure_secs(reader, trip)? {
                                Some(secs) => secs,
                                None => continue,
                            };
                        let freq = frequency_board(
                            reader,
                            trip.trip_idx,
                            earliest_board,
                            template_first_departure_secs,
                            dep_at_stop,
                        );
                        if freq.is_none() && has_exact_times_zero_frequency(reader, trip.trip_idx) {
                            continue;
                        }
                        let effective_dep_at_stop =
                            freq.as_ref().map(|f| f.board_secs).unwrap_or(dep_at_stop);
                        if effective_dep_at_stop >= earliest_board {
                            if boarding_trip.is_none()
                                || effective_dep_at_stop < current_best_board_secs
                            {
                                boarding_trip = Some(ti);
                                board_stop_idx = stop_pos as i64;
                                current_best_board_secs = effective_dep_at_stop;
                                board_in_seat = cand_in_seat;
                                board_approximate = freq.is_some();
                                board_frequency_secs = freq.map(|f| f.board_secs);
                                board_frequency_offset_secs =
                                    board_frequency_secs.unwrap_or(dep_at_stop) - dep_at_stop;
                            }
                            if !route_has_exact_times_zero_frequency
                                && dep_at_stop >= current_best_board_secs
                            {
                                break;
                            }
                        }
                    }
                }
            }
        }
        // Restore the snapshot buffer for reuse next round (retains capacity).
        state.routes_scratch = routes;

        // footpath relaxation. After the route scan, propagate arrival times along the pre-computed
        // pedestrian-transfer CSR. Absent table ⇒ skipped entirely (haversine-fallback behaviour
        // unchanged, raptor.transfers.test.ts:134-145).
        if let Some(transfers) = transfers {
            // Single-round guard: snapshot `new_marked`
            // BEFORE the walk loop adds to it, and iterate the SNAPSHOT — a stop
            // walked-in this round must not chain into a second walk this round
            // (which would otherwise build arbitrarily long single-round walk
            // chains). `foot_sources` is the reusable scratch buffer; clear it,
            // fill from the current `new_marked`, then iterate the buffer.
            state.foot_sources.clear();
            state
                .foot_sources
                .extend_from_slice(state.new_marked.as_slice());
            for si in 0..state.foot_sources.len() {
                let src = state.foot_sources[si];
                // Map engine stop index -> Transfers' own stop index via the
                // stopId string. `stop_id(i)` borrows from the pool with NO
                // allocation (`reader.stop(i)` would allocate stop_id + stop_name
                // per walked source per round); `index_of` returns Option, no `?`.
                let src_id = reader.stop_id(src as usize)?;
                let tidx = match transfers.index_of(src_id) {
                    Some(i) => i,
                    None => continue,
                };
                let base_arrival = match round_k.get(&src) {
                    Some(&a) if a < INF => a,
                    _ => continue,
                };
                let source_round = *state.last_parent_round.get(&src).unwrap_or(&k);
                let (nbrs, walks) = transfers.edges(tidx);
                for (j, &raw) in walks.iter().enumerate() {
                    // Neighbor's stopId (the Transfers table's own id string),
                    // resolved BEFORE the rule lookup + improvement check to
                    // mirror the pinned scan order's ordering (`neighborId` first, then the
                    // transfers.txt rule, then `effectiveWalk`).
                    let nbr_id = transfers.stop_id(nbrs[j]);
                    // GTFS transfers.txt rule for this footpath edge (S1/S2),
                    // PRECEDENCE 3 > 2 > 1 > global floor. type 3 (not-possible)
                    // removes the edge regardless of any walk time (rule wins →
                    // skip); type 2 (min_transfer_time) replaces the
                    // RAPTOR_MIN_TRANSFER_SECS floor for this pair; type 1 (TIMED
                    // / guaranteed connection) sets the floor to 0 so the edge
                    // uses the pure walk time. No rule ⇒ the global floor,
                    // exactly as pre-S1. Timed transfers are modeled as
                    // zero-minimum — no dynamic vehicle-holding (see
                    // same_stop_board_floor).
                    // GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
                    transfer_key_into(&mut transfer_key_buf, src_id, nbr_id);
                    // NOTE: type-3 enforcement HERE is contingent on PTFT-table
                    // coverage — the rule can only skip an edge that exists. With
                    // no transfers table (or no edge for this pair) the footpath
                    // relaxation never runs for this pair, so the rule is a no-op
                    // (the edge doesn't exist to remove). The same-stop board
                    // type-3 (same_stop_board_floor) is always enforced.
                    let floor = match index.transfer_rules.get(transfer_key_buf.as_str()) {
                        Some(r) if r.transfer_type == 3 => continue, // not possible — skip edge
                        Some(r) if r.transfer_type == 2 => r.min_transfer_secs as i64,
                        Some(r) if r.transfer_type == 1 => 0, // timed: no minimum — pure walk
                        _ => min_transfer,
                    };
                    // Rounding pin: exact integer half-up, no f64 (no_std). the pinned scan order
                    // `Math.round(walkSecs * footWalkScale)`.
                    let scaled = rescale_walk_secs(raw, walk_speed_mm_s);
                    // Floor very-short walks at the per-pair floor (the global
                    // RAPTOR_MIN_TRANSFER_SECS, or this pair's min_transfer_time
                    // under a type-2 rule). The walk time still applies if larger
                    // — the rule overrides only the minimum.
                    let effective = if scaled < floor { floor } else { scaled };
                    // saturating_add: base_arrival derives from the caller-supplied
                    // departure_secs (see round-0 seed); guard the same overflow.
                    let cand = base_arrival.saturating_add(effective);
                    // Neighbor's Transfers index -> engine stop index via the
                    // stopId string. `stop_index` returns Option<u32>, NOT
                    // Result — no `?`; skip neighbors absent from the feed.
                    let nbr_stop = match reader.stop_index(nbr_id) {
                        Some(s) => s,
                        None => continue,
                    };
                    if cand < *state.best_arrival.get(&nbr_stop).unwrap_or(&INF) {
                        round_k.insert(nbr_stop, cand);
                        state.best_arrival.insert(nbr_stop, cand);
                        parent_k.insert(
                            nbr_stop,
                            Parent::Walk {
                                from_stop: src,
                                walk_secs: effective,
                                source_round,
                            },
                        );
                        state.last_parent_round.insert(nbr_stop, k);
                        state.new_marked.insert(nbr_stop);
                    }
                }
            }
        }

        state.round_arrival.push(round_k);
        state.parents.push(parent_k);

        // ----- Exit-result recording -----
        // For each exit stop reached this round, record an ExitResult — but ONLY
        // if no earlier entry already reached that stop at `arrival_secs <=
        // arr_t` (the `alreadyFound` skip). This skip drives
        // `bestByKey` insertion order in reconstruction, so it is ported EXACTLY:
        // a `find`/`any` over the entire `exit_results` accumulated so far, the
        // `<=` comparison, and the per-exit-stop iteration in `query.exit_stops`
        // order.
        let round_k_ref = &state.round_arrival[k as usize];
        for ew in &query.exit_stops {
            if let Some(&arr_t) = round_k_ref.get(&ew.stop) {
                if arr_t < INF {
                    // "Already found" ⟺ an earlier push for this stop has
                    // arrival_secs <= arr_t ⟺ the tracked per-stop minimum is
                    // <= arr_t (F3 — was a linear `exit_results.iter().any`).
                    let already = best_exit_arrival
                        .get(&ew.stop)
                        .is_some_and(|&best| best <= arr_t);
                    if !already {
                        state.exit_results.push(ExitResult {
                            round: k,
                            stop: ew.stop,
                            arrival_secs: arr_t,
                        });
                        best_exit_arrival.insert(ew.stop, arr_t);
                    }
                }
            }
        }

        // markedStops = newMarked; break when empty
        //.
        core::mem::swap(&mut state.marked, &mut state.new_marked);
        if state.marked.is_empty() {
            break;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::consts::{
        DEFAULT_WALK_SPEED_MM_S, RAPTOR_MIN_TRANSFER_SECS, WHEELCHAIR_WALK_SPEED_MM_S,
    };
    use crate::engine::patterns::PatternMode;
    use crate::engine::service::active_services;
    use crate::engine::testkit::{
        build_multi_route_ptb_with_transfers, build_n_trip_ptb, build_ptft, tiny_reader,
    };
    use crate::engine::{Mobility, Query, StopWalk};
    use crate::transfers::Transfers;
    use alloc::vec;
    use core::num::NonZeroU32;

    /// Test helper: an all-active membership [`Bitset`] of `n` services — the
    /// `Bitset` equivalent of the old `vec![true; n]` these scan tests used. The
    /// real query path builds this via `active_services`; these unit tests want a
    /// fixed all-active set so the scan logic (not the calendar) is under test.
    fn all_active(n: usize) -> Bitset {
        let mut b = Bitset::with_len(n);
        for i in 0..n {
            b.set(i);
        }
        b
    }

    fn frequencies_parity_reader() -> crate::Reader<alloc::vec::Vec<u8>> {
        crate::Reader::from_bytes(
            include_bytes!(
                "../../../../packages/shared/src/ptb/__fixtures__/frequencies-parity.ptb"
            )
            .to_vec(),
        )
        .unwrap()
    }

    #[test]
    fn frequency_board_picks_next_headway_instance() {
        let reader = frequencies_parity_reader();

        assert_eq!(
            frequency_board(&reader, 0, 25_201, 25_200, 25_200).map(|b| b.board_secs),
            Some(25_800),
        );
    }

    #[test]
    fn frequency_board_allows_exact_window_start() {
        let reader = frequencies_parity_reader();

        assert_eq!(
            frequency_board(&reader, 0, 21_600, 25_200, 25_200).map(|b| b.board_secs),
            Some(21_600),
        );
    }

    #[test]
    fn frequency_board_treats_end_as_half_open() {
        let reader = frequencies_parity_reader();

        assert_eq!(frequency_board(&reader, 0, 86_400, 25_200, 25_200), None);
    }

    #[test]
    fn frequency_board_ignores_exact_times_one_rows() {
        let reader = frequencies_parity_reader();

        assert_eq!(frequency_board(&reader, 0, 86_401, 25_200, 25_200), None);
    }

    #[test]
    fn frequency_board_adds_template_offset_for_downstream_board() {
        let reader = frequencies_parity_reader();

        assert_eq!(
            frequency_board(&reader, 0, 25_801, 25_200, 25_500).map(|b| b.board_secs),
            Some(26_100),
        );
    }

    #[test]
    fn frequency_first_served_departure_skips_leading_unserved_sentinel() {
        let bytes = build_n_trip_ptb(3, &[&[(2, 1, 28_800), (3, 2, 29_100)]]);
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        let trip = &index.routes[0].trips[0];

        assert_eq!(
            first_served_departure_secs(&reader, trip).unwrap(),
            Some(28_800)
        );
    }

    #[test]
    fn ordered_set_preserves_first_insert_order() {
        let mut s = OrderedSet::default();
        for v in [3u32, 1, 3, 2, 1] {
            s.insert(v);
        }
        assert_eq!(s.as_slice(), &[3, 1, 2]);
    }

    // Direct-route scan over the committed tiny.ptb (mirrors raptor.test.ts:45-105 "direct route,
    // board after arrival").
    //
    // tiny.ptb (producer output of crates/pt-producer/tests/fixtures/tiny-gtfs.zip):
    //   stops:  S1=0, S2=1, S3=2
    //   route 0 (R1): canonical [S1,S2,S3]; T1 (trip_idx 0, service 1/WD,
    //     wheelchairAccessible=2) departs S1@25200,S2@25500,S3@25800;
    //     T2 (trip_idx 1, service 1/WD) departs S1@28800,S2@29100,S3@29400.
    //     arr_diff = 0 everywhere -> alight == departure.
    //   Date 20260505 -> WD (service 1) active, SA (service 0) inactive.
    //
    // Query: entry S1@walk 0, departure 25200, default mobility.
    //   Round 1: board T1 at S1 (pos 0, dep 25200 >= 25200), alight S2 @25500,
    //   S3 @25800. Destination S3 best_arrival == 25800, parent is a Transit on
    //   route 0 / trip-in-route 0, board pos 0, alight pos 2.
    #[test]
    fn direct_route_scan_sets_destination_arrival_and_parent() {
        let reader = tiny_reader();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        let active = active_services(&reader, 20260505).unwrap();
        assert!(
            active.get(1) && !active.get(0),
            "WD active, SA inactive on 20260505"
        );

        let s1 = reader.stop_index("S1").unwrap();
        let s2 = reader.stop_index("S2").unwrap();
        let s3 = reader.stop_index("S3").unwrap();
        assert_eq!((s1, s2, s3), (0, 1, 2));

        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: s1,
                walk_secs: 0,
            }],
            exit_stops: vec![StopWalk {
                stop: s3,
                walk_secs: 0,
            }],
            departure_secs: 25200,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };

        let mut state = ScanState::default();
        state.reset();
        for sw in &query.entry_stops {
            state.entry_set.insert(sw.stop);
        }
        run_scan(&reader, &index, &mut state, &query, &active, None, None).unwrap();

        // Destination arrival is concrete: S3 @ 25800.
        assert_eq!(state.best_arrival.get(&s3).copied(), Some(25800));
        // Intermediate S2 @ 25500.
        assert_eq!(state.best_arrival.get(&s2).copied(), Some(25500));

        // S3's parent (set in round 1) is a Transit on route 0, the first trip
        // in route order (T1, trip_idx_in_route 0), boarded at pos 0, alighted
        // at pos 2 (POSITION, not indexOf).
        let parent_s3 = state.parents[1].get(&s3).copied();
        assert_eq!(
            parent_s3,
            Some(Parent::Transit {
                board_stop: s1,
                route_idx: 0,
                trip_idx_in_route: 0,
                board_stop_idx: 0,
                alight_stop_idx: 2,
                frequency_board_secs: None,
                frequency_offset_secs: 0,
                approximate: false,
                in_seat: false, // no transfer rule → ordinary board
            }),
        );
        assert_eq!(state.last_parent_round.get(&s3).copied(), Some(1));
    }

    // A later departure forces boarding T2 instead of T1: departing at 25201
    // (just after T1 leaves S1) means T1's dep 25200 < earliest_board, so the
    // board loop falls through to T2 (dep 28800), arriving S3 @ 29400.
    #[test]
    fn later_departure_boards_second_trip() {
        let reader = tiny_reader();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        let active = active_services(&reader, 20260505).unwrap();
        let s1 = reader.stop_index("S1").unwrap();
        let s3 = reader.stop_index("S3").unwrap();

        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: s1,
                walk_secs: 0,
            }],
            exit_stops: vec![StopWalk {
                stop: s3,
                walk_secs: 0,
            }],
            departure_secs: 25201,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };

        let mut state = ScanState::default();
        state.reset();
        for sw in &query.entry_stops {
            state.entry_set.insert(sw.stop);
        }
        run_scan(&reader, &index, &mut state, &query, &active, None, None).unwrap();

        assert_eq!(state.best_arrival.get(&s3).copied(), Some(29400));
        assert_eq!(
            state.parents[1].get(&s3).copied(),
            Some(Parent::Transit {
                board_stop: s1,
                route_idx: 0,
                trip_idx_in_route: 1, // T2 is second in route order
                board_stop_idx: 0,
                alight_stop_idx: 2,
                frequency_board_secs: None,
                frequency_offset_secs: 0,
                approximate: false,
                in_seat: false,
            }),
        );
    }



    // Express-skip IMPROVE case (mirrors raptor.test.ts:321-354). The boarded
    // trip is an express that skips the middle stop; a later local trip serves
    // it, so the alt-trip fallback fills in the skipped stop's arrival.
    //
    // Fixture (1 route, 2 trips over stops s0=0, s1=1, s2=2):
    //   trip 0 (LOCAL, canonical/longest): s0@25300, s1@25500, s2@26100
    //   trip 1 (EXPRESS): s0@25200, s2@26000 — SKIPS s1 (pos 1).
    // Sorted by dep at canonical pos 0: EXPRESS@25200 sorts FIRST (trip_idx_in_
    // route 0), LOCAL@25300 second (trip_idx_in_route 1).
    //
    // Query: entry s0 @ walk 0, departure 25200, default mobility.
    //   pos 0: board EXPRESS (dep 25200 >= 25200).
    //   pos 1 (s1): EXPRESS skips it (depart_here == -1) -> express-skip branch.
    //     board_earliest = best_arrival[s0]=25200 (k=1, min_wait 0). LOCAL
    //     (dep s0 25300 >= 25200, serves s1) improves s1 (INF -> 25500).
    //   => s1 arrival 25500 via LOCAL (trip_idx_in_route 1), alight pos 1.
    #[test]
    fn express_skip_falls_back_to_later_local_trip() {
        let bytes = build_n_trip_ptb(
            3,
            &[
                &[(1, 0, 25300), (2, 1, 25500), (3, 2, 26100)], // trip 0: LOCAL
                &[(1, 0, 25200), (3, 2, 26000)],                // trip 1: EXPRESS, skips s1
            ],
        );
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        let active = all_active(1); // single service, active

        // Canonical is the longest (LOCAL) pattern; EXPRESS sorts first by dep@0.
        assert_eq!(index.routes[0].stop_ids, vec![0, 1, 2]);
        assert_eq!(index.routes[0].trips[0].trip_idx, 1); // EXPRESS first
        assert_eq!(index.routes[0].trips[0].pos_to_row, vec![3, -1, 4]); // skips pos 1
        assert_eq!(index.routes[0].trips[1].trip_idx, 0); // LOCAL second

        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            exit_stops: vec![StopWalk {
                stop: 2,
                walk_secs: 0,
            }],
            departure_secs: 25200,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };

        let mut state = ScanState::default();
        state.reset();
        for sw in &query.entry_stops {
            state.entry_set.insert(sw.stop);
        }
        run_scan(&reader, &index, &mut state, &query, &active, None, None).unwrap();

        // The skipped middle stop s1 is reached via the ALT trip (LOCAL) at
        // 25500 — NOT via the boarded EXPRESS (which skips it).
        assert_eq!(state.best_arrival.get(&1).copied(), Some(25500));
        // Its parent is a Transit on the LOCAL trip (trip_idx_in_route 1),
        // boarded at pos 0 (s0), alighted at pos 1 (POSITION).
        assert_eq!(
            state.parents[1].get(&1).copied(),
            Some(Parent::Transit {
                board_stop: 0,
                route_idx: 0,
                trip_idx_in_route: 1, // the LOCAL alt trip
                board_stop_idx: 0,
                alight_stop_idx: 1,
                frequency_board_secs: None,
                frequency_offset_secs: 0,
                approximate: false,
                in_seat: false,
            }),
        );
        assert_eq!(state.last_parent_round.get(&1).copied(), Some(1));
    }

    // Express-skip fallback scans all candidates and keeps the best effective
    // board. A later candidate that improves arrival must win over an earlier
    // candidate that serves the skipped stop but arrives too late.
    //
    // Fixture (1 route, 3 trips over stops s0=0, s1=1, s2=2):
    //   trip 0 (LOCAL, canonical): s0@25400, s1@25500, s2@26500
    //   trip 1 (EXPRESS): s0@25200, s2@26000 — SKIPS s1.
    //   trip 2 (C1): s0@25300, s1@26500, s2@27000 — serves s1 LATE (26500).
    // Sorted by dep@0: EXPRESS@25200 (idx 0), C1@25300 (idx 1), LOCAL@25400 (idx 2).
    //
    // Query: entry s0 @ walk 0 (departure 25200) AND entry s1 @ walk 800 ->
    // best_arrival[s1] pre-seeded to 26000.
    //   pos 0: board EXPRESS (idx 0).
    //   pos 1 (s1): EXPRESS skips it -> express-skip branch. C1 (idx 1) serves
    //     s1 but arrives 26500, which is NOT < best_arrival[s1]=26000. LOCAL
    //     (idx 2) is still considered and arrives s1 at 25500, so it wins.
    //   => s1 improves to 25500 via LOCAL.
    #[test]
    fn express_skip_fallback_considers_better_later_candidate() {
        let bytes = build_n_trip_ptb(
            3,
            &[
                &[(1, 0, 25400), (2, 1, 25500), (3, 2, 26500)], // trip 0: LOCAL (best at s1)
                &[(1, 0, 25200), (3, 2, 26000)],                // trip 1: EXPRESS, skips s1
                &[(1, 0, 25300), (2, 1, 26500), (3, 2, 27000)], // trip 2: C1 (late at s1)
            ],
        );
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        let active = all_active(1);

        // Trip ordering after dep@0 sort: EXPRESS(idx0), C1(idx1), LOCAL(idx2).
        assert_eq!(index.routes[0].stop_ids, vec![0, 1, 2]);
        assert_eq!(index.routes[0].trips[0].trip_idx, 1); // EXPRESS
        assert_eq!(index.routes[0].trips[0].pos_to_row, vec![3, -1, 4]); // skips s1
        assert_eq!(index.routes[0].trips[1].trip_idx, 2); // C1 (too late at s1)
        assert_eq!(index.routes[0].trips[2].trip_idx, 0); // LOCAL (best at s1)

        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![
                StopWalk {
                    stop: 0,
                    walk_secs: 0,
                },
                StopWalk {
                    stop: 1,
                    walk_secs: 800,
                }, // best_arrival[s1] = 25200 + 800 = 26000
            ],
            exit_stops: vec![StopWalk {
                stop: 2,
                walk_secs: 0,
            }],
            departure_secs: 25200,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };

        let mut state = ScanState::default();
        state.reset();
        for sw in &query.entry_stops {
            state.entry_set.insert(sw.stop);
        }
        run_scan(&reader, &index, &mut state, &query, &active, None, None).unwrap();

        assert_eq!(state.best_arrival.get(&1).copied(), Some(25500));
        assert_eq!(
            state.parents[1].get(&1).copied(),
            Some(Parent::Transit {
                board_stop: 0,
                route_idx: 0,
                trip_idx_in_route: 2, // LOCAL later candidate
                board_stop_idx: 0,
                alight_stop_idx: 1,
                frequency_board_secs: None,
                frequency_offset_secs: 0,
                approximate: false,
                in_seat: false,
            })
        );
    }

    //
    // All three cases share one fixture topology mirroring the TS river-crossing
    // (raptor.transfers.test.ts): one route serves stops s0->s1; stop s2 is NOT
    // on any trip's pattern, so the ONLY way to reach it is by walking from s1
    // along the transfer table. The route scan reaches s1 in round 1, then the
    // footpath pass pulls s2 into best_arrival via Parent::Walk.
    //
    // build_n_trip_ptb gives stop ids "s0","s1","s2" (the Transfers table keys on
    // those exact strings). The single trip serves only s0 (pos 0) and s1 (pos 1);
    // s2 has no stop_times, so the canonical pattern is [s0,s1] and transit never
    // reaches s2.

    // OSM-walk crossing: the footpath pulls s2 into best_arrival, AND the
    // absent-table (None) case leaves s2 unreached (raptor.transfers.test.ts:99-145).
    #[test]
    fn footpath_walk_pulls_neighbor_into_best_arrival() {
        // Trip departs s0@25200, s1@25500 (arr_diff 0 -> alight == dep). s2 absent.
        let bytes = build_n_trip_ptb(3, &[&[(1, 0, 25200), (2, 1, 25500)]]);
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        let active = all_active(1);
        assert_eq!(index.routes[0].stop_ids, vec![0, 1]); // s2 not on the pattern

        // 480s walk s1<->s2 (>RAPTOR_MIN_TRANSFER_SECS so no floor applies).
        let ptnt = build_ptft(&["s1", "s2"], &[&[(1, 480)], &[(0, 480)]]);
        let transfers = Transfers::from_bytes(ptnt).unwrap();

        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            exit_stops: vec![StopWalk {
                stop: 2,
                walk_secs: 0,
            }],
            departure_secs: 25200,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };

        // --- With the table: s1 reached by transit @25500, then walked to s2. ---
        let mut state = ScanState::default();
        state.reset();
        for sw in &query.entry_stops {
            state.entry_set.insert(sw.stop);
        }
        run_scan(
            &reader,
            &index,
            &mut state,
            &query,
            &active,
            Some(&transfers),
            None,
        )
        .unwrap();

        assert_eq!(state.best_arrival.get(&1).copied(), Some(25500)); // s1 via transit
                                                                      // s2 reached only by walking: 25500 + 480 = 25980.
        assert_eq!(state.best_arrival.get(&2).copied(), Some(25980));
        // s2's round-1 parent is a Walk from s1 with the full 480s (no floor),
        // sourceRound = lastParentRound[s1] = 1 (s1 was improved this round).
        assert_eq!(
            state.parents[1].get(&2).copied(),
            Some(Parent::Walk {
                from_stop: 1,
                walk_secs: 480,
                source_round: 1
            }),
        );
        assert_eq!(state.last_parent_round.get(&2).copied(), Some(1));

        // --- Absent table (None): s2 is never reached; behaviour unchanged. ---
        let mut state2 = ScanState::default();
        state2.reset();
        for sw in &query.entry_stops {
            state2.entry_set.insert(sw.stop);
        }
        run_scan(&reader, &index, &mut state2, &query, &active, None, None).unwrap();
        assert_eq!(state2.best_arrival.get(&1).copied(), Some(25500)); // transit still works
        assert_eq!(state2.best_arrival.get(&2).copied(), None); // no walk -> unreachable
        assert!(state2.parents.iter().all(|p| !p.contains_key(&2)));
    }

    // Floor at RAPTOR_MIN_TRANSFER_SECS: a sub-120s raw walk is floored to 120
    // (raptor.transfers.test.ts:147-202). 30s raw -> effective 120s.
    #[test]
    fn footpath_floors_short_walk_at_min_transfer_secs() {
        let bytes = build_n_trip_ptb(3, &[&[(1, 0, 25200), (2, 1, 25500)]]);
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        let active = all_active(1);

        // 30s raw walk s1->s2 — below the 120s floor.
        let ptnt = build_ptft(&["s1", "s2"], &[&[(1, 30)], &[(0, 30)]]);
        let transfers = Transfers::from_bytes(ptnt).unwrap();

        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            exit_stops: vec![StopWalk {
                stop: 2,
                walk_secs: 0,
            }],
            departure_secs: 25200,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };
        let mut state = ScanState::default();
        state.reset();
        for sw in &query.entry_stops {
            state.entry_set.insert(sw.stop);
        }
        run_scan(
            &reader,
            &index,
            &mut state,
            &query,
            &active,
            Some(&transfers),
            None,
        )
        .unwrap();

        // s1 @25500; s2 floored: 25500 + 120 = 25620 (NOT 25500 + 30 = 25530).
        assert_eq!(state.best_arrival.get(&2).copied(), Some(25620));
        assert_ne!(state.best_arrival.get(&2).copied(), Some(25530));
        // The Walk leg records the FLOORED duration (120), not the raw 30.
        assert_eq!(
            state.parents[1].get(&2).copied(),
            Some(Parent::Walk {
                from_stop: 1,
                walk_secs: RAPTOR_MIN_TRANSFER_SECS,
                source_round: 1
            }),
        );
    }

    // Wheelchair rescale 200->313 (raptor.transfers.test.ts:204-264). The integer
    // half-up rescale (200*25+8)/16 = 313 is the rounding pin; under the wheelchair
    // profile a 200s edge yields effective 313 (above the floor, applied verbatim).
    #[test]
    fn footpath_rescales_for_wheelchair_profile() {
        // Pin the rescale itself first: 200 * 1.5625 = 312.5 -> 313.
        assert_eq!(rescale_walk_secs(200, WHEELCHAIR_WALK_SPEED_MM_S), 313);
        assert_eq!(rescale_walk_secs(200, DEFAULT_WALK_SPEED_MM_S), 200); // default identity

        let bytes = build_n_trip_ptb(3, &[&[(1, 0, 25200), (2, 1, 25500)]]);
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        let active = all_active(1);

        // 200s raw walk at builder speed.
        let ptnt = build_ptft(&["s1", "s2"], &[&[(1, 200)], &[(0, 200)]]);
        let transfers = Transfers::from_bytes(ptnt).unwrap();

        let base_query = |mobility| Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            exit_stops: vec![StopWalk {
                stop: 2,
                walk_secs: 0,
            }],
            departure_secs: 25200,
            date: 20260505,
            max_rounds: None,
            mobility,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };

        // Default profile: 200s passes through unchanged -> s2 @ 25700.
        let q_def = base_query(Mobility::Default);
        let mut sd = ScanState::default();
        sd.reset();
        sd.entry_set.insert(0);
        run_scan(
            &reader,
            &index,
            &mut sd,
            &q_def,
            &active,
            Some(&transfers),
            None,
        )
        .unwrap();
        assert_eq!(sd.best_arrival.get(&2).copied(), Some(25700)); // 25500 + 200
        assert_eq!(
            sd.parents[1].get(&2).copied(),
            Some(Parent::Walk {
                from_stop: 1,
                walk_secs: 200,
                source_round: 1
            }),
        );

        // Wheelchair profile: 200 -> 313 -> s2 @ 25813.
        let q_wc = base_query(Mobility::Wheelchair);
        let mut sw = ScanState::default();
        sw.reset();
        sw.entry_set.insert(0);
        run_scan(
            &reader,
            &index,
            &mut sw,
            &q_wc,
            &active,
            Some(&transfers),
            None,
        )
        .unwrap();
        assert_eq!(sw.best_arrival.get(&2).copied(), Some(25813)); // 25500 + 313
        assert_eq!(
            sw.parents[1].get(&2).copied(),
            Some(Parent::Walk {
                from_stop: 1,
                walk_secs: 313,
                source_round: 1
            }),
        );
    }

    // The query's walking speed rescales a transfer walk, whatever the
    // mobility; without one, wheelchair keeps 800 mm/s and default 1250. A
    // query minimum transfer above the walk floors it. 200 s raw at 1250 mm/s
    // is 250 m: 257 s at 972 mm/s (3.5 km/h), 313 s at 800 mm/s.
    #[test]
    fn footpath_uses_query_walk_speed_and_min_transfer() {
        let bytes = build_n_trip_ptb(3, &[&[(1, 0, 25200), (2, 1, 25500)]]);
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        let active = all_active(1);
        let ptnt = build_ptft(&["s1", "s2"], &[&[(1, 200)], &[(0, 200)]]);
        let transfers = Transfers::from_bytes(ptnt).unwrap();

        let walk_to_s2 = |mobility, speed: Option<u32>, min: Option<u32>| {
            let query = Query {
                excluded_routes: Default::default(),
                entry_stops: vec![StopWalk {
                    stop: 0,
                    walk_secs: 0,
                }],
                exit_stops: vec![StopWalk {
                    stop: 2,
                    walk_secs: 0,
                }],
                departure_secs: 25200,
                date: 20260505,
                max_rounds: None,
                mobility,
                excluded_modes: vec![],
                walk_speed_mm_s: speed.and_then(NonZeroU32::new),
                min_transfer_secs: min,
            };
            let mut st = ScanState::default();
            st.reset();
            st.entry_set.insert(0);
            run_scan(
                &reader,
                &index,
                &mut st,
                &query,
                &active,
                Some(&transfers),
                None,
            )
            .unwrap();
            let walk = match st.parents[1].get(&2).copied() {
                Some(Parent::Walk { walk_secs, .. }) => Some(walk_secs),
                _ => None,
            };
            (st.best_arrival.get(&2).copied(), walk)
        };

        assert_eq!(
            walk_to_s2(Mobility::Default, Some(972), None),
            (Some(25757), Some(257))
        );
        assert_eq!(
            walk_to_s2(Mobility::Default, Some(1250), None),
            (Some(25700), Some(200))
        );
        assert_eq!(
            walk_to_s2(Mobility::Wheelchair, None, None),
            (Some(25813), Some(313))
        );
        assert_eq!(
            walk_to_s2(Mobility::Wheelchair, Some(1250), None),
            (Some(25700), Some(200))
        );
        assert_eq!(
            walk_to_s2(Mobility::Default, None, Some(300)),
            (Some(25800), Some(300))
        );
        assert_eq!(
            walk_to_s2(Mobility::Default, Some(972), Some(240)),
            (Some(25757), Some(257))
        );
        // A zero minimum leaves the walk as it is.
        assert_eq!(
            walk_to_s2(Mobility::Default, None, Some(0)),
            (Some(25700), Some(200))
        );
    }

    // Single-round guard: a stop walked-in THIS round must not
    // itself originate a second walk this round. Chain s1 --100--> s2 --100--> s3.
    //
    // Round 1: transit reaches s1; the footpath snapshot taken BEFORE the walk
    // loop is the route-scan `new_marked` = {s1}, so s1->s2 fires (s2 floored to
    // 25620) but s2->s3 does NOT — s2 was walked in this round and is absent from
    // the snapshot. The guard is what blocks the chain.
    //
    // Round 2: `new_marked` is the round-2 ROUTE-scan output. No route serves s2,
    // so s2 is never re-improved -> never re-enters `new_marked` -> never
    // originates a walk. Therefore s3 stays UNREACHABLE for the whole query (only
    // a transit re-improvement of s2 could ever extend the chain). This is the
    // strong form of the guard: a purely-walked stop is a walk dead-end.
    #[test]
    fn footpath_single_round_guard_blocks_chained_walk() {
        // s2, s3 absent from the transit pattern (canonical [s0,s1]).
        let bytes = build_n_trip_ptb(4, &[&[(1, 0, 25200), (2, 1, 25500)]]);
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        let active = all_active(1);
        assert_eq!(index.routes[0].stop_ids, vec![0, 1]);

        // Chain: s1<->s2 (100s) and s2<->s3 (100s). All sub-floor -> 120 each.
        let ptnt = build_ptft(
            &["s1", "s2", "s3"],
            &[
                &[(1, 100)],           // s1 -> s2
                &[(0, 100), (2, 100)], // s2 -> s1, s2 -> s3
                &[(1, 100)],           // s3 -> s2
            ],
        );
        let transfers = Transfers::from_bytes(ptnt).unwrap();

        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            exit_stops: vec![StopWalk {
                stop: 3,
                walk_secs: 0,
            }],
            departure_secs: 25200,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };
        let mut state = ScanState::default();
        state.reset();
        state.entry_set.insert(0);
        run_scan(
            &reader,
            &index,
            &mut state,
            &query,
            &active,
            Some(&transfers),
            None,
        )
        .unwrap();

        // Round 1: s1 (transit @25500) walks to s2 (floored 120 -> 25620). The
        // guard blocks s2 from chaining to s3 in the SAME round: parents[1] has
        // s2 but NOT s3.
        assert_eq!(
            state.parents[1].get(&2).copied(),
            Some(Parent::Walk {
                from_stop: 1,
                walk_secs: 120,
                source_round: 1
            })
        );
        assert_eq!(
            state.parents[1].get(&3),
            None,
            "s3 must NOT be walked in round 1"
        );

        // s2 reached, s3 never reached: s2 is purely walked-in and no route
        // re-improves it, so it never re-enters new_marked to originate the
        // s2->s3 walk in any later round. The chain is broken permanently — the
        // guard prevents the multi-hop walk that would otherwise reach s3.
        assert_eq!(state.best_arrival.get(&2).copied(), Some(25620));
        assert_eq!(state.best_arrival.get(&3), None, "s3 must stay unreachable");
        assert!(state.parents.iter().all(|p| !p.contains_key(&3)));
    }

    // ---- S1: GTFS transfers.txt apply (unscoped type-3 / type-2) -------------
    //
    // These mirror the pinned scan order's `sameStopBoardFloor` (board sites) and the
    // per-edge footpath rule. The engine-regression gate (crates/pt-core/tests/raptor_behavior.rs)
    // is the real engine≡golden bar; these guard each branch in isolation.
    // GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt

    const ABSENT: u32 = u32::MAX;

    // type-3 FOOTPATH skip. footpath topology (s0→s1 by transit; s2 reachable
    // ONLY by walking from s1). An UNSCOPED type-3 (s1,s2) transfers.txt rule
    // removes that footpath edge regardless of walk time → s2 unreachable. The
    // negative control (no rule) reaches s2 @25620 (60s floored to 120).
    #[test]
    fn footpath_type3_rule_skips_edge() {
        // 1-route fixture s0→s1 over 3 stops (s2 served by NO transit). The
        // 60s s1→s2 footpath is the only way to reach s2.
        let with_rule = build_multi_route_ptb_with_transfers(
            3,
            &[&[(1, 0, 25200), (2, 1, 25500)]], // R0: s0 -> s1
            // UNSCOPED (no route/trip scope) type-3 s1 -> s2: not possible.
            &[(1, 2, ABSENT, ABSENT, ABSENT, ABSENT, ABSENT, 3)],
        );
        let ptnt = build_ptft(&["s1", "s2"], &[&[(1, 60)], &[(0, 60)]]);
        let transfers = Transfers::from_bytes(ptnt).unwrap();

        let run = |bytes: Vec<u8>| {
            let reader = crate::Reader::from_bytes(bytes).unwrap();
            let index = Index::build(&reader, PatternMode::Off).unwrap();
            let active = all_active(1);
            let query = Query {
                excluded_routes: Default::default(),
                entry_stops: vec![StopWalk {
                    stop: 0,
                    walk_secs: 0,
                }],
                exit_stops: vec![StopWalk {
                    stop: 2,
                    walk_secs: 0,
                }],
                departure_secs: 25200,
                date: 20260505,
                max_rounds: None,
                mobility: Mobility::Default,
                excluded_modes: vec![],
                walk_speed_mm_s: None,
                min_transfer_secs: None,
            };
            let mut state = ScanState::default();
            state.reset();
            state.entry_set.insert(0);
            run_scan(
                &reader,
                &index,
                &mut state,
                &query,
                &active,
                Some(&transfers),
                None,
            )
            .unwrap();
            state.best_arrival.get(&2).copied()
        };

        // With the type-3 rule the s1→s2 edge is removed → s2 unreachable.
        assert_eq!(run(with_rule), None);
        // Negative control: no transfers.txt rule → s2 reached @25620 (60→120 floor).
        let no_rule =
            build_multi_route_ptb_with_transfers(3, &[&[(1, 0, 25200), (2, 1, 25500)]], &[]);
        assert_eq!(run(no_rule), Some(25620));
    }

    // type-2 FOOTPATH floor override (downward). A 30s raw walk normally floors
    // to RAPTOR_MIN_TRANSFER_SECS (120). An UNSCOPED type-2 (s1,s2) rule with
    // min_transfer_time 30 REPLACES that floor → effective 30 → s2 @25530, not
    // the 25620 the global floor would force.
    #[test]
    fn footpath_type2_rule_overrides_floor_downward() {
        let bytes = build_multi_route_ptb_with_transfers(
            3,
            &[&[(1, 0, 25200), (2, 1, 25500)]], // R0: s0 -> s1
            // UNSCOPED type-2 s1 -> s2, min_transfer_time = 30 (below the 120 floor).
            &[(1, 2, ABSENT, ABSENT, ABSENT, ABSENT, 30, 2)],
        );
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        let active = all_active(1);
        let ptnt = build_ptft(&["s1", "s2"], &[&[(1, 30)], &[(0, 30)]]);
        let transfers = Transfers::from_bytes(ptnt).unwrap();

        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            exit_stops: vec![StopWalk {
                stop: 2,
                walk_secs: 0,
            }],
            departure_secs: 25200,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };
        let mut state = ScanState::default();
        state.reset();
        state.entry_set.insert(0);
        run_scan(
            &reader,
            &index,
            &mut state,
            &query,
            &active,
            Some(&transfers),
            None,
        )
        .unwrap();

        // 30s rule floor (not the global 120): s2 @ 25500 + 30 = 25530.
        assert_eq!(state.best_arrival.get(&2).copied(), Some(25530));
        assert_eq!(
            state.parents[1].get(&2).copied(),
            Some(Parent::Walk {
                from_stop: 1,
                walk_secs: 30,
                source_round: 1,
            }),
        );
    }

    // SAME-STOP type-3 forbid (board site). A 2-leg transfer s0→s1→s2 where the
    // s1 re-board in round 2 is a non-entry board (the floor applies). An
    // UNSCOPED type-3 (s1,s1) rule forbids that re-board → s2 unreachable. The
    // negative control (no rule) reaches s2 @26000.
    #[test]
    fn same_stop_type3_rule_forbids_reboard() {
        let routes: &[&[(u16, u32, u32)]] = &[
            &[(1, 0, 25200), (2, 1, 25500)], // R0: s0 -> s1 (board entry s0)
            &[(1, 1, 25620), (2, 2, 26000)], // R1: s1 -> s2 (departs s1 at the 120s floor)
        ];

        let run = |transfers_rows: &[crate::engine::testkit::TransferRow]| {
            let bytes = build_multi_route_ptb_with_transfers(3, routes, transfers_rows);
            let reader = crate::Reader::from_bytes(bytes).unwrap();
            let index = Index::build(&reader, PatternMode::Off).unwrap();
            let active = all_active(2);
            let query = Query {
                excluded_routes: Default::default(),
                entry_stops: vec![StopWalk {
                    stop: 0,
                    walk_secs: 0,
                }],
                exit_stops: vec![StopWalk {
                    stop: 2,
                    walk_secs: 0,
                }],
                departure_secs: 25000,
                date: 20260505,
                max_rounds: None,
                mobility: Mobility::Default,
                excluded_modes: vec![],
                walk_speed_mm_s: None,
                min_transfer_secs: None,
            };
            let mut state = ScanState::default();
            state.reset();
            state.entry_set.insert(0);
            run_scan(&reader, &index, &mut state, &query, &active, None, None).unwrap();
            state.best_arrival.get(&2).copied()
        };

        // No rule: the round-2 re-board at s1 boards R1 @25620 → s2 @26000.
        assert_eq!(run(&[]), Some(26000));
        // UNSCOPED type-3 (s1,s1): the non-entry re-board at s1 is forbidden →
        // R1 never boarded → s2 unreachable.
        assert_eq!(
            run(&[(1, 1, ABSENT, ABSENT, ABSENT, ABSENT, ABSENT, 3)]),
            None,
        );
    }

    // SAME-STOP type-2 floor override (board site, upward). The s1 re-board's
    // floor is normally arrival(25500)+120 = 25620; R1 departs exactly 25620 so
    // the transfer is feasible. An UNSCOPED type-2 (s1,s1) rule with
    // min_transfer_time 300 RAISES the floor to 25800 > 25620 → infeasible. A
    // min of 0 LOWERS it, leaving the connection feasible.
    #[test]
    fn same_stop_type2_rule_overrides_board_floor() {
        let routes: &[&[(u16, u32, u32)]] = &[
            &[(1, 0, 25200), (2, 1, 25500)], // R0: s0 -> s1
            &[(1, 1, 25620), (2, 2, 26000)], // R1: s1 -> s2 (departs at the 120s floor)
        ];
        let run = |transfers_rows: &[crate::engine::testkit::TransferRow]| {
            let bytes = build_multi_route_ptb_with_transfers(3, routes, transfers_rows);
            let reader = crate::Reader::from_bytes(bytes).unwrap();
            let index = Index::build(&reader, PatternMode::Off).unwrap();
            let active = all_active(2);
            let query = Query {
                excluded_routes: Default::default(),
                entry_stops: vec![StopWalk {
                    stop: 0,
                    walk_secs: 0,
                }],
                exit_stops: vec![StopWalk {
                    stop: 2,
                    walk_secs: 0,
                }],
                departure_secs: 25000,
                date: 20260505,
                max_rounds: None,
                mobility: Mobility::Default,
                excluded_modes: vec![],
                walk_speed_mm_s: None,
                min_transfer_secs: None,
            };
            let mut state = ScanState::default();
            state.reset();
            state.entry_set.insert(0);
            run_scan(&reader, &index, &mut state, &query, &active, None, None).unwrap();
            state.best_arrival.get(&2).copied()
        };

        // type-2 min 300 → floor 25800 > R1 dep 25620 → infeasible (s2 unreachable).
        assert_eq!(run(&[(1, 1, ABSENT, ABSENT, ABSENT, ABSENT, 300, 2)]), None,);
        // type-2 min 0 → floor 25500 ≤ 25620 → feasible (s2 @26000).
        assert_eq!(
            run(&[(1, 1, ABSENT, ABSENT, ABSENT, ABSENT, 0, 2)]),
            Some(26000),
        );
    }

    // The query's minimum transfer replaces the 120 s same-stop board floor
    // where no rule sets one (both with and without transfers.txt rules in
    // the feed), and a type-2 rule keeps its own floor. R1 departs s1 exactly
    // 120 s after R0 arrives.
    #[test]
    fn same_stop_board_floor_uses_query_min_transfer() {
        let routes: &[&[(u16, u32, u32)]] = &[
            &[(1, 0, 25200), (2, 1, 25500)],
            &[(1, 1, 25620), (2, 2, 26000)],
        ];
        let run = |min: Option<u32>, transfers_rows: &[crate::engine::testkit::TransferRow]| {
            let bytes = build_multi_route_ptb_with_transfers(3, routes, transfers_rows);
            let reader = crate::Reader::from_bytes(bytes).unwrap();
            let index = Index::build(&reader, PatternMode::Off).unwrap();
            let active = all_active(2);
            let query = Query {
                excluded_routes: Default::default(),
                entry_stops: vec![StopWalk {
                    stop: 0,
                    walk_secs: 0,
                }],
                exit_stops: vec![StopWalk {
                    stop: 2,
                    walk_secs: 0,
                }],
                departure_secs: 25000,
                date: 20260505,
                max_rounds: None,
                mobility: Mobility::Default,
                excluded_modes: vec![],
                walk_speed_mm_s: None,
                min_transfer_secs: min,
            };
            let mut state = ScanState::default();
            state.reset();
            state.entry_set.insert(0);
            run_scan(&reader, &index, &mut state, &query, &active, None, None).unwrap();
            state.best_arrival.get(&2).copied()
        };
        // A rule elsewhere in the feed turns off the uniform-floor fast path.
        let elsewhere = [(0, 2, ABSENT, ABSENT, ABSENT, ABSENT, ABSENT, 3)];

        for rows in [&[][..], &elsewhere[..]] {
            assert_eq!(run(None, rows), Some(26000));
            assert_eq!(run(Some(120), rows), Some(26000));
            assert_eq!(run(Some(121), rows), None);
            assert_eq!(run(Some(0), rows), Some(26000));
        }
        // A type-2 (s1,s1) minimum of 60 keeps its floor under a 300 s query
        // minimum: 25500 + 60 <= 25620.
        assert_eq!(
            run(Some(300), &[(1, 1, ABSENT, ABSENT, ABSENT, ABSENT, 60, 2)]),
            Some(26000),
        );
    }

    // SCOPED type-3 is IGNORED (unscoped-only predicate guard). A type-3 (s1,s1)
    // rule that ALSO carries a from_route scope must be dropped by Index::build,
    // so the same-stop re-board is NOT forbidden → behaviour identical to no
    // rule (s2 @26000). Guards that a scoped rule never leaks into the scan.
    #[test]
    fn scoped_type3_rule_is_ignored() {
        let routes: &[&[(u16, u32, u32)]] = &[
            &[(1, 0, 25200), (2, 1, 25500)],
            &[(1, 1, 25620), (2, 2, 26000)],
        ];
        // SCOPED type-3 (s1,s1) with from_route_idx = 0 → must be ignored.
        let bytes = build_multi_route_ptb_with_transfers(
            3,
            routes,
            &[(1, 1, 0, ABSENT, ABSENT, ABSENT, ABSENT, 3)],
        );
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        // The scoped rule was dropped → transfer_rules is empty.
        assert!(index.transfer_rules.is_empty());

        let active = all_active(2);
        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            exit_stops: vec![StopWalk {
                stop: 2,
                walk_secs: 0,
            }],
            departure_secs: 25000,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };
        let mut state = ScanState::default();
        state.reset();
        state.entry_set.insert(0);
        run_scan(&reader, &index, &mut state, &query, &active, None, None).unwrap();
        // Scoped rule ignored → re-board allowed → s2 reached @26000.
        assert_eq!(state.best_arrival.get(&2).copied(), Some(26000));
    }

    // TYPE-2-WITHOUT-MIN is DROPPED (S1 finding 1: the actionable predicate).
    // A type-2 (s1,s1) row with `min_transfer_secs == TRANSFER_ABSENT` (real
    // feeds emit this spec-invalid row) must NOT reach the scan — Index::build
    // keeps type-2 ONLY when a min is present. Dropped → the pair falls through
    // to the global RAPTOR_MIN_TRANSFER_SECS, identical to no rule. If it leaked
    // in, the scan would read TRANSFER_ABSENT (≈4.29e9) as the floor and forbid
    // the re-board → s2 unreachable. So a reachable s2 @26000 proves it dropped.
    #[test]
    fn type2_without_min_is_dropped() {
        let routes: &[&[(u16, u32, u32)]] = &[
            &[(1, 0, 25200), (2, 1, 25500)], // R0: s0 -> s1 (arrives 25500)
            &[(1, 1, 25620), (2, 2, 26000)], // R1: s1 -> s2 (departs at the global floor)
        ];
        // UNSCOPED type-2 (s1,s1) with NO min (ABSENT) → must be dropped.
        let bytes = build_multi_route_ptb_with_transfers(
            3,
            routes,
            &[(1, 1, ABSENT, ABSENT, ABSENT, ABSENT, ABSENT, 2)],
        );
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        // The under-specified type-2 row was dropped → transfer_rules is empty.
        assert!(index.transfer_rules.is_empty());

        let active = all_active(2);
        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            exit_stops: vec![StopWalk {
                stop: 2,
                walk_secs: 0,
            }],
            departure_secs: 25000,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };
        let mut state = ScanState::default();
        state.reset();
        state.entry_set.insert(0);
        run_scan(&reader, &index, &mut state, &query, &active, None, None).unwrap();
        // No-min type-2 dropped → global 120s floor → R1 @25620 feasible → s2 @26000.
        assert_eq!(state.best_arrival.get(&2).copied(), Some(26000));
    }

    // FOOTPATH type-2 floor override UPWARD (S1 finding 2). The downward case is
    // already covered by `footpath_type2_rule_overrides_floor_downward`; this
    // pins the upward override on a footpath EDGE — a min ABOVE both the raw
    // walk (60) and the global floor (120) raises the effective walk to 300.
    #[test]
    fn footpath_type2_rule_overrides_floor_upward() {
        let bytes = build_multi_route_ptb_with_transfers(
            3,
            &[&[(1, 0, 25200), (2, 1, 25500)]], // R0: s0 -> s1
            // UNSCOPED type-2 s1 -> s2, min 300 (above raw 60 and global 120).
            &[(1, 2, ABSENT, ABSENT, ABSENT, ABSENT, 300, 2)],
        );
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        let active = all_active(1);
        let ptnt = build_ptft(&["s1", "s2"], &[&[(1, 60)], &[(0, 60)]]);
        let transfers = Transfers::from_bytes(ptnt).unwrap();

        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            exit_stops: vec![StopWalk {
                stop: 2,
                walk_secs: 0,
            }],
            departure_secs: 25200,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };
        let mut state = ScanState::default();
        state.reset();
        state.entry_set.insert(0);
        run_scan(
            &reader,
            &index,
            &mut state,
            &query,
            &active,
            Some(&transfers),
            None,
        )
        .unwrap();

        // 300s rule floor (not raw 60, not global 120): s2 @ 25500 + 300 = 25800.
        assert_eq!(state.best_arrival.get(&2).copied(), Some(25800));
        assert_eq!(
            state.parents[1].get(&2).copied(),
            Some(Parent::Walk {
                from_stop: 1,
                walk_secs: 300,
                source_round: 1,
            }),
        );
    }

    // ---- S2: GTFS transfers.txt type-1 (timed / guaranteed connection) -------
    //
    // A timed transfer sets the per-pair floor to 0 (no minimum wait — the held
    // connection has no minimum). These pin the type-1 → floor-0 branch at both
    // apply sites in isolation; the engine-regression gate is the real engine≡golden bar.
    // Modeled as zero-minimum (no dynamic vehicle-holding). GTFS reference:
    // https://gtfs.org/documentation/schedule/reference/#transferstxt

    // SAME-STOP type-1 timed board (floor 0). The s1 re-board's floor is normally
    // arrival(25500)+120 = 25620; R1 departs only 30s after arrival (25530), a
    // gap BELOW the global floor that would normally BLOCK the re-board. An
    // UNSCOPED type-1 (s1,s1) rule drops the floor to 0 → board floor = 25500 ≤
    // 25530 → feasible → s2 @25830. The negative control (no rule) is unreachable.
    #[test]
    fn same_stop_type1_rule_sets_zero_board_floor() {
        let routes: &[&[(u16, u32, u32)]] = &[
            &[(1, 0, 25200), (2, 1, 25500)], // R0: s0 -> s1 (arrives 25500)
            &[(1, 1, 25530), (2, 2, 25830)], // R1: s1 -> s2 (departs 25530, 30s gap)
        ];
        let run = |transfers_rows: &[crate::engine::testkit::TransferRow]| {
            let bytes = build_multi_route_ptb_with_transfers(3, routes, transfers_rows);
            let reader = crate::Reader::from_bytes(bytes).unwrap();
            let index = Index::build(&reader, PatternMode::Off).unwrap();
            let active = all_active(2);
            let query = Query {
                excluded_routes: Default::default(),
                entry_stops: vec![StopWalk {
                    stop: 0,
                    walk_secs: 0,
                }],
                exit_stops: vec![StopWalk {
                    stop: 2,
                    walk_secs: 0,
                }],
                departure_secs: 25000,
                date: 20260505,
                max_rounds: None,
                mobility: Mobility::Default,
                excluded_modes: vec![],
                walk_speed_mm_s: None,
                min_transfer_secs: None,
            };
            let mut state = ScanState::default();
            state.reset();
            state.entry_set.insert(0);
            run_scan(&reader, &index, &mut state, &query, &active, None, None).unwrap();
            state.best_arrival.get(&2).copied()
        };

        // No rule: the 30s gap is below the global 120s floor → s2 unreachable.
        assert_eq!(run(&[]), None);
        // UNSCOPED type-1 (s1,s1): floor 0 → 25500 ≤ 25530 → feasible → s2 @25830.
        assert_eq!(
            run(&[(1, 1, ABSENT, ABSENT, ABSENT, ABSENT, ABSENT, 1)]),
            Some(25830),
        );
    }

    // FOOTPATH type-1 timed edge (floor 0). A 60s raw walk normally floors to
    // RAPTOR_MIN_TRANSFER_SECS (120) → s2 @25620. An UNSCOPED type-1 (s1,s2) rule
    // drops the floor to 0 → effective = max(60, 0) = 60 (pure walk time) → s2
    // @25560, not the 25620 the global floor would force.
    #[test]
    fn footpath_type1_rule_sets_zero_floor() {
        let bytes = build_multi_route_ptb_with_transfers(
            3,
            &[&[(1, 0, 25200), (2, 1, 25500)]], // R0: s0 -> s1
            // UNSCOPED type-1 s1 -> s2: timed → floor 0 → pure walk time applies.
            &[(1, 2, ABSENT, ABSENT, ABSENT, ABSENT, ABSENT, 1)],
        );
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        let active = all_active(1);
        let ptnt = build_ptft(&["s1", "s2"], &[&[(1, 60)], &[(0, 60)]]);
        let transfers = Transfers::from_bytes(ptnt).unwrap();

        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            exit_stops: vec![StopWalk {
                stop: 2,
                walk_secs: 0,
            }],
            departure_secs: 25200,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };
        let mut state = ScanState::default();
        state.reset();
        state.entry_set.insert(0);
        run_scan(
            &reader,
            &index,
            &mut state,
            &query,
            &active,
            Some(&transfers),
            None,
        )
        .unwrap();

        // floor 0 → pure raw walk 60 (not the global 120): s2 @ 25500 + 60 = 25560.
        assert_eq!(state.best_arrival.get(&2).copied(), Some(25560));
        assert_eq!(
            state.parents[1].get(&2).copied(),
            Some(Parent::Walk {
                from_stop: 1,
                walk_secs: 60,
                source_round: 1,
            }),
        );
    }

    // SCOPED type-1 is IGNORED (unscoped-only predicate guard for S2). A type-1
    // (s1,s1) rule that ALSO carries a from_route scope must be dropped by
    // Index::build, so the timed floor-0 is NOT applied → the global floor blocks
    // the 30s-gap re-board → s2 unreachable, identical to no rule.
    #[test]
    fn scoped_type1_rule_is_ignored() {
        let routes: &[&[(u16, u32, u32)]] = &[
            &[(1, 0, 25200), (2, 1, 25500)], // R0: s0 -> s1 (arrives 25500)
            &[(1, 1, 25530), (2, 2, 25830)], // R1: s1 -> s2 (departs 25530, 30s gap)
        ];
        // SCOPED type-1 (s1,s1) with from_route_idx = 0 → must be ignored.
        let bytes = build_multi_route_ptb_with_transfers(
            3,
            routes,
            &[(1, 1, 0, ABSENT, ABSENT, ABSENT, ABSENT, 1)],
        );
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        // The scoped rule was dropped → transfer_rules is empty.
        assert!(index.transfer_rules.is_empty());

        let active = all_active(2);
        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            exit_stops: vec![StopWalk {
                stop: 2,
                walk_secs: 0,
            }],
            departure_secs: 25000,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };
        let mut state = ScanState::default();
        state.reset();
        state.entry_set.insert(0);
        run_scan(&reader, &index, &mut state, &query, &active, None, None).unwrap();
        // Scoped type-1 ignored → global floor → 30s gap blocked → s2 unreachable.
        assert_eq!(state.best_arrival.get(&2), None);
    }

    // ---- S3: scoped (trip→trip / route→route) apply + specificity -------------
    //
    // The engine-regression gate is the real engine≡golden bar; these pin the scoped
    // resolution in isolation. `build_multi_route_ptb_with_transfers` writes trip
    // ids "T0".."T{n-1}" and route ids "R0".. (one trip per route, trip r on
    // route r), so the trip-scoped key for arriving-trip T0 → boarding-trip T1
    // is `(s1,s1,T0,T1)`. The arriving trip at s1 is T0 (the parent transit leg
    // of leg 1); the boarding trip is T1 (route 1's only trip).
    // GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt

    const TRIP_T0: u32 = 0; // global trip ordinal of route 0's trip
    const TRIP_T1: u32 = 1; // global trip ordinal of route 1's trip

    // TRIP-SCOPED type-3 forbids EXACTLY the T0→T1 continuation at s1. The 2-leg
    // s0→s1→s2 transfer is otherwise feasible (R1 departs s1 at the 120s floor);
    // the trip→trip rule removes it → s2 unreachable. The negative control (no
    // rule) reaches s2 @26000.
    #[test]
    fn trip_scoped_type3_forbids_matching_continuation() {
        let routes: &[&[(u16, u32, u32)]] = &[
            &[(1, 0, 25200), (2, 1, 25500)], // R0/T0: s0 -> s1 (board entry s0)
            &[(1, 1, 25620), (2, 2, 26000)], // R1/T1: s1 -> s2 (departs s1 at the floor)
        ];
        let run = |transfers_rows: &[crate::engine::testkit::TransferRow]| {
            let bytes = build_multi_route_ptb_with_transfers(3, routes, transfers_rows);
            let reader = crate::Reader::from_bytes(bytes).unwrap();
            let index = Index::build(&reader, PatternMode::Off).unwrap();
            let active = all_active(2);
            let query = Query {
                excluded_routes: Default::default(),
                entry_stops: vec![StopWalk {
                    stop: 0,
                    walk_secs: 0,
                }],
                exit_stops: vec![StopWalk {
                    stop: 2,
                    walk_secs: 0,
                }],
                departure_secs: 25000,
                date: 20260505,
                max_rounds: None,
                mobility: Mobility::Default,
                excluded_modes: vec![],
                walk_speed_mm_s: None,
                min_transfer_secs: None,
            };
            let mut state = ScanState::default();
            state.reset();
            state.entry_set.insert(0);
            run_scan(&reader, &index, &mut state, &query, &active, None, None).unwrap();
            state.best_arrival.get(&2).copied()
        };
        // No rule: the round-2 re-board at s1 boards R1 @25620 → s2 @26000.
        assert_eq!(run(&[]), Some(26000));
        // TRIP-SCOPED type-3 (s1,s1, T0→T1): the matching continuation is
        // forbidden → R1/T1 never boarded → s2 unreachable.
        assert_eq!(
            run(&[(1, 1, ABSENT, ABSENT, TRIP_T0, TRIP_T1, ABSENT, 3)]),
            None,
        );
    }

    // SPECIFICITY: a more-specific trip→trip rule WINS over the unscoped
    // stop→stop rule on the SAME stops. Below-floor topology (R1 departs s1 30s
    // after R0 arrives, below the global 120s floor → empty without any rule).
    // An UNSCOPED type-3 (s1,s1) would forbid the re-board; a TRIP-SCOPED type-1
    // (s1,s1, T0→T1) sets floor 0. The trip rule wins → feasible → s2 @25830.
    #[test]
    fn trip_scoped_rule_overrides_unscoped() {
        let routes: &[&[(u16, u32, u32)]] = &[
            &[(1, 0, 25200), (2, 1, 25500)], // R0/T0: s0 -> s1 (arrives 25500)
            &[(1, 1, 25530), (2, 2, 25830)], // R1/T1: s1 -> s2 (departs 25530, 30s gap)
        ];
        let bytes = build_multi_route_ptb_with_transfers(
            3,
            routes,
            &[
                // UNSCOPED type-3 (s1,s1): would forbid the re-board on its own.
                (1, 1, ABSENT, ABSENT, ABSENT, ABSENT, ABSENT, 3),
                // TRIP-SCOPED type-1 (s1,s1, T0→T1): more specific → wins → floor 0.
                (1, 1, ABSENT, ABSENT, TRIP_T0, TRIP_T1, ABSENT, 1),
            ],
        );
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        // Both maps populated: 1 unscoped, 1 trip-scoped.
        assert_eq!(index.transfer_rules.len(), 1);
        assert_eq!(index.transfer_rules_trip.len(), 1);

        let active = all_active(2);
        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            exit_stops: vec![StopWalk {
                stop: 2,
                walk_secs: 0,
            }],
            departure_secs: 25000,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };
        let mut state = ScanState::default();
        state.reset();
        state.entry_set.insert(0);
        run_scan(&reader, &index, &mut state, &query, &active, None, None).unwrap();
        // Trip-scoped type-1 wins over the unscoped type-3 → re-board feasible →
        // s2 @25830 (NOT empty, which is what the unscoped rule alone would force).
        assert_eq!(state.best_arrival.get(&2).copied(), Some(25830));
    }

    // type-5 (in-seat forbidden) is a documented NO-OP: it routes identically to
    // NO rule. An UNSCOPED type-5 (s1,s1) leaves the global floor in place, so
    // the feasible 2-leg transfer (R1 departs s1 at the 120s floor) still works
    // → s2 @26000, exactly as with no rule.
    #[test]
    fn type5_in_seat_forbidden_is_noop() {
        let routes: &[&[(u16, u32, u32)]] = &[
            &[(1, 0, 25200), (2, 1, 25500)], // R0: s0 -> s1
            &[(1, 1, 25620), (2, 2, 26000)], // R1: s1 -> s2 (departs at the floor)
        ];
        let run = |transfers_rows: &[crate::engine::testkit::TransferRow]| {
            let bytes = build_multi_route_ptb_with_transfers(3, routes, transfers_rows);
            let reader = crate::Reader::from_bytes(bytes).unwrap();
            let index = Index::build(&reader, PatternMode::Off).unwrap();
            let active = all_active(2);
            let query = Query {
                excluded_routes: Default::default(),
                entry_stops: vec![StopWalk {
                    stop: 0,
                    walk_secs: 0,
                }],
                exit_stops: vec![StopWalk {
                    stop: 2,
                    walk_secs: 0,
                }],
                departure_secs: 25000,
                date: 20260505,
                max_rounds: None,
                mobility: Mobility::Default,
                excluded_modes: vec![],
                walk_speed_mm_s: None,
                min_transfer_secs: None,
            };
            let mut state = ScanState::default();
            state.reset();
            state.entry_set.insert(0);
            run_scan(&reader, &index, &mut state, &query, &active, None, None).unwrap();
            state.best_arrival.get(&2).copied()
        };
        // No rule and UNSCOPED type-5 both reach s2 @26000 (type-5 is a no-op).
        assert_eq!(run(&[]), Some(26000));
        assert_eq!(
            run(&[(1, 1, ABSENT, ABSENT, ABSENT, ABSENT, ABSENT, 5)]),
            Some(26000),
        );
    }

    // ── F1 board-search characterization (mirrors raptor.boardsearch.test.ts) ──

    fn boardsearch_query(entries: &[(u32, u32)], exit: u32, dep: i64) -> Query {
        Query {
            excluded_routes: Default::default(),
            entry_stops: entries
                .iter()
                .map(|&(stop, walk_secs)| StopWalk { stop, walk_secs })
                .collect(),
            exit_stops: vec![StopWalk {
                stop: exit,
                walk_secs: 0,
            }],
            departure_secs: dep,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        }
    }

    fn boardsearch_run(
        reader: &crate::Reader<alloc::vec::Vec<u8>>,
        index: &Index,
        query: &Query,
    ) -> ScanState {
        let active = all_active(1);
        let mut state = ScanState::default();
        state.reset();
        for sw in &query.entry_stops {
            state.entry_set.insert(sw.stop);
        }
        run_scan(reader, index, &mut state, query, &active, None, None).unwrap();
        state
    }

    // Mirror of the TS "overtaking (unsorted) downstream departures" pin: T2
    // overtakes T1 before s1 (deps at s1: [31800, 30000, 32400] — NOT sorted),
    // so the route must take the legacy array-order scan; the first boardable
    // trip at s1 is T1 (31800 < incumbent T3's 32400) and it is re-boarded. A
    // sortedness-assuming downward scan would stop at T2 (30000 < arrival
    // 30300) and miss T1.
    #[test]
    fn unsorted_route_reboards_first_boardable_in_array_order() {
        let bytes = build_n_trip_ptb(
            3,
            &[
                &[(0, 0, 28_800), (1, 1, 31_800), (2, 2, 33_000)], // T1
                &[(0, 0, 29_400), (1, 1, 30_000), (2, 2, 35_400)], // T2 (overtakes T1 at s1)
                &[(0, 0, 30_600), (1, 1, 32_400), (2, 2, 34_200)], // T3
            ],
        );
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        assert!(
            !index.routes[0].board_sorted,
            "overtaking route must not be board_sorted"
        );

        // arrive s0 @29700 (boards T3), arrive s1 @30300 (T1 catchable there).
        let query = boardsearch_query(&[(0, 4_500), (1, 5_100)], 2, 25_200);
        let state = boardsearch_run(&reader, &index, &query);

        assert_eq!(state.best_arrival.get(&2).copied(), Some(33_000));
        assert_eq!(
            state.parents[1].get(&2).copied(),
            Some(Parent::Transit {
                board_stop: 1,
                route_idx: 0,
                trip_idx_in_route: 0, // T1, re-boarded at s1
                board_stop_idx: 1,
                alight_stop_idx: 2,
                frequency_board_secs: None,
                frequency_offset_secs: 0,
                approximate: false,
                in_seat: false,
            }),
        );
    }

    // Mirror of the TS "re-boards an earlier catchable trip mid-route while
    // carrying an incumbent (sorted route)" pin — the canonical-hop fast path:
    // incumbent T2 boarded at s0; at s1 the walk-in arrival (29100) makes the
    // earlier T1 catchable (dep 30600 < incumbent's 31200) — re-board.
    #[test]
    fn sorted_route_reboards_earlier_trip_via_downward_hop() {
        let bytes = build_n_trip_ptb(
            3,
            &[
                &[(0, 0, 28_800), (1, 1, 30_600), (2, 2, 33_000)], // T1
                &[(0, 0, 30_000), (1, 1, 31_200), (2, 2, 34_200)], // T2
            ],
        );
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        assert!(index.routes[0].board_sorted);

        // arrive s0 @29400 (boards T2), arrive s1 @29100 (T1 catchable there).
        let query = boardsearch_query(&[(0, 1_200), (1, 900)], 2, 28_200);
        let state = boardsearch_run(&reader, &index, &query);

        assert_eq!(state.best_arrival.get(&2).copied(), Some(33_000));
        assert_eq!(
            state.parents[1].get(&2).copied(),
            Some(Parent::Transit {
                board_stop: 1,
                route_idx: 0,
                trip_idx_in_route: 0, // T1, re-boarded at s1
                board_stop_idx: 1,
                alight_stop_idx: 2,
                frequency_board_secs: None,
                frequency_offset_secs: 0,
                approximate: false,
                in_seat: false,
            }),
        );
    }

    // Mirror of the TS "skips pickup-forbidden earlier trips when re-boarding"
    // pin: at s1 the lowest earlier trip T1 is pickup_type=1 (alight-only) —
    // the re-board must land on T2, the lowest ELIGIBLE trip in the window.
    #[test]
    fn downward_hop_skips_pickup_forbidden_candidates() {
        use crate::engine::testkit::build_n_trip_ptb_with_boarding;
        let bytes = build_n_trip_ptb_with_boarding(
            &["s0", "s1", "s2"],
            &[
                &[(0, 0, 28_200), (1, 1, 30_000), (2, 2, 32_400)], // T1 (pickup=1 at s1)
                &[(0, 0, 28_800), (1, 1, 30_600), (2, 2, 33_600)], // T2
                &[(0, 0, 30_000), (1, 1, 31_200), (2, 2, 34_800)], // T3
            ],
            &[
                0x50, 0x51, 0x50, // T1: pickup_type=1 at s1
                0x50, 0x50, 0x50, // T2
                0x50, 0x50, 0x50, // T3
            ],
        );
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        assert!(index.routes[0].board_sorted);

        // arrive s0 @29400 (boards T3), arrive s1 @29100: T1 is unboardable
        // (pickup) → T2 wins (30600 < incumbent's 31200).
        let query = boardsearch_query(&[(0, 1_200), (1, 900)], 2, 28_200);
        let state = boardsearch_run(&reader, &index, &query);

        assert_eq!(state.best_arrival.get(&2).copied(), Some(33_600));
        assert_eq!(
            state.parents[1].get(&2).copied(),
            Some(Parent::Transit {
                board_stop: 1,
                route_idx: 0,
                trip_idx_in_route: 1, // T2 — T1 pickup-forbidden at s1
                board_stop_idx: 1,
                alight_stop_idx: 2,
                frequency_board_secs: None,
                frequency_offset_secs: 0,
                approximate: false,
                in_seat: false,
            }),
        );
    }
}
