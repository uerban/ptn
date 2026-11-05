use alloc::vec::Vec;
use core::num::NonZeroU32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mobility {
    Default,
    Wheelchair,
    Bicycle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StopWalk {
    pub stop: u32,
    pub walk_secs: u32,
}

#[derive(Debug, Clone)]
pub struct Query {
    pub entry_stops: Vec<StopWalk>,
    pub exit_stops: Vec<StopWalk>,
    pub departure_secs: i64,
    pub date: u32, // YYYYMMDD; resolved to active services in-engine
    pub max_rounds: Option<u32>, // default RAPTOR_MAX_ROUNDS
    pub mobility: Mobility,
    /// Parent GTFS route ordinals excluded before scanning (not pattern ordinals).
    /// Empty preserves the existing routing contract; no PTB layout change.
    pub excluded_routes: Vec<u32>,
    pub excluded_modes: Vec<u16>, // route_type codes; normalised to Mode FAMILIES in plan()
    /// Walking speed for the engine's own transfer walks (the PTFT table,
    /// emitted at 1250 mm/s), in mm/s. `None` keeps the mobility's speed:
    /// 800 for wheelchair, 1250 otherwise. Entry and exit walks are the
    /// caller's and already carry the rider's speed.
    pub walk_speed_mm_s: Option<NonZeroU32>,
    /// The minimum transfer time wherever no GTFS `transfers.txt` rule sets
    /// its own: the floor of a same-stop re-board and of a transfer walk. A
    /// type 1 (timed), type 2 (`min_transfer_time`) or type 4 (in-seat) rule
    /// keeps its own floor. `None` = `RAPTOR_MIN_TRANSFER_SECS`.
    /// <https://gtfs.org/documentation/schedule/reference/#transferstxt>
    pub min_transfer_secs: Option<u32>,
}

impl Query {
    /// The transfer-walk speed this query uses, mm/s.
    pub fn transfer_walk_speed_mm_s(&self) -> u32 {
        match (self.walk_speed_mm_s, self.mobility) {
            (Some(v), _) => v.get(),
            (None, Mobility::Wheelchair) => crate::engine::consts::WHEELCHAIR_WALK_SPEED_MM_S,
            (None, _) => crate::engine::consts::DEFAULT_WALK_SPEED_MM_S,
        }
    }

    /// The minimum transfer this query uses where no rule sets one, seconds.
    pub fn min_transfer_floor_secs(&self) -> i64 {
        self.min_transfer_secs
            .map_or(crate::engine::consts::RAPTOR_MIN_TRANSFER_SECS, i64::from)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LegKind {
    Walk,
    Transit {
        route_idx: u32,
        /// Parent GTFS-route ordinal (into `reader.route()`). Equals `route_idx` when
        /// `PatternMode::Off`; under patterns `route_idx` is the pattern slot while this stays the
        /// bare GTFS route.
        reader_route_idx: u32,
        trip_idx: u32,
        route_type: u16,
        board_stop_idx: u32, // POSITION in route.stop_ids (circular routes)
        alight_stop_idx: u32, // POSITION, never indexOf
        intermediate_stops: u32,
        /// The scanned pattern's full stop-idx sequence (for frontend leg geometry). Stamped from
        /// `route.stop_ids` in reconstruct.rs where the index is in scope.
        pattern_stop_ids: Vec<u32>,
        /// True when this transit leg boards a GTFS frequencies.txt exact_times=0
        /// headway instance. Concrete secs are routed, but display is approximate.
        approximate: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Leg {
    pub kind: LegKind,
    pub from_stop: u32, // stop index
    pub to_stop: u32,   // stop index
    pub depart_secs: i64,
    pub arrive_secs: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Itinerary {
    pub legs: Vec<Leg>,
    pub board_secs: i64,
    pub alight_secs: i64,
    pub transfers: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    /// Reader/bounds failure surfaced from a region accessor. An EMPTY result is `Ok(vec![])`,
    /// never an error.
    Reader(crate::PtbError),
    /// A cross-region index/invariant the reader does NOT enforce (it mirrors `loader.ts`, which
    /// doesn't either) but the engine relies on as the consumer: `stop_time.stopIdx >= num_stops`,
    /// or a malformed `tripStarts` (non-monotonic / last entry beyond the StopTimes row count).
    /// Deferred from P1 to the consumer. `&'static str` says which.
    Corrupt(&'static str),
    /// The caller's abort flag flipped mid-scan ([`crate::plan_with_abort`]) —
    /// a cooperative wall-clock bound checked at round boundaries so a
    /// CPU-bound scan can't pin a host worker past its request timeout. Never
    /// produced when no abort flag is supplied; carries no engine-state
    /// meaning (results so far are simply discarded).
    Aborted,
    /// A PTB v2-only entry point (time resolution, v2 planning) was called on a
    /// bundle of another version, or the bundle version is unknown.
    UnsupportedVersion,
    /// The requested instant or service date lies outside every routable
    /// `0x18 ServiceDayOrigins` interval.
    UnsupportedServiceDate,
    /// The query lies inside the bundle window but outside the complete
    /// sub-interval: an omitted earlier service date could still have an event
    /// at or after the query, or a later date could start one inside the 48-hour
    /// journey horizon. Never a partial itinerary set.
    IncompleteHorizon,
    /// Checked date/time arithmetic overflowed.
    TimeOverflow,
    /// A PTB v2 index commitment (e.g. `0x19 BlockDerivationCommitment`) does not
    /// match what this build recomputes from the bundle contents.
    IndexBundleMismatch,
    /// The query asks for a capability the bundle cannot support exactly
    /// (`&'static str` names it).
    UnsupportedInput(&'static str),
}

impl From<crate::PtbError> for EngineError {
    fn from(e: crate::PtbError) -> Self {
        EngineError::Reader(e)
    }
}

// Compile-time guard: INF must stay below i64::MAX so arithmetic never wraps.
const _: () = assert!(super::consts::INF < i64::MAX);

#[cfg(test)]
mod tests {
    use super::super::consts::INF;
    #[test]
    fn inf_is_max_safe_integer() {
        const _: () = assert!(INF == 9_007_199_254_740_991);
    }
}
