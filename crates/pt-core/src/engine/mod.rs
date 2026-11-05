//! RAPTOR scan engine; public entry point is [`plan`].
//!
//! `plan` takes a pre-built [`Index`] (built
//! ONCE via [`Index::build`], reused across queries) and a reusable [`ScanState`] (`reset` per
//! query, capacity retained across calls). The structural index and the scan buffers are NOT
//! rebuilt per request; doing so would re-read every StopTimes row and re-allocate on every call,
//! blowing the RSS + latency targets.

use alloc::vec::Vec;

pub(crate) mod bitset;
pub mod consts;
pub mod index;
pub mod mode;
pub mod patterns;
pub mod project;
pub(crate) mod reconstruct;
pub(crate) mod scan;
pub(crate) mod service;
pub mod types;
pub mod v2;

// Under `cargo test` the `test` cfg activates it via the unit-test build; the
// `test-helpers` feature activates it for a downstream crate's tests (Cargo
// unifies the dev-dependency feature onto the normal dep). Neither is set by a
// plain `cargo build --release`, so testkit carries zero production cost.
#[cfg(any(test, feature = "test-helpers"))]
pub mod testkit;

// A deliberately tiny, exhaustive temporal graph oracle used only by this
// crate's unit tests. It is not linked into production or downstream
// `test-helpers` consumers.
#[cfg(test)]
pub(crate) mod temporal_experiment;

// Experimental single-service-date entry-event view. It is deliberately not
// re-exported from the crate root and is absent from feature-off builds.
#[cfg(feature = "temporal-experiment")]
pub mod temporal_probe;

pub use index::{Index, IndexRoute, RouteTrip};
pub use patterns::PatternMode;
pub use project::{
    project, ProjectedItinerary, ProjectedLeg, ProjectedTransitLeg, ProjectedWalkLeg,
};
pub use scan::ScanState;
pub use types::{EngineError, Itinerary, Leg, LegKind, Mobility, Query, StopWalk};

use crate::engine::mode::route_type_to_mode;
use crate::transfers::Transfers;
use crate::Reader;

/// Early-morning overnight-fallback window (< 05:00) — matches the TS
/// orchestrator (`searchOrchestrator.ts:207`).
const EARLY_MORNING_SECS: i64 = 18000;
/// Late-night overnight-fallback window (>= 23:00).
const LATE_NIGHT_SECS: i64 = 82800;
/// One civil day in seconds (early-morning query shift + result rewrite).
const SECS_PER_DAY: i64 = 86400;

/// Plan itineraries for `query` over a pre-built [`Index`] and reusable
/// [`ScanState`]. The public RAPTOR entry; its results are pinned against the
/// committed golden (`crates/pt-core/tests/raptor_behavior.rs`).
///
/// `transfers` is the decoded pedestrian-transfer CSR; `None` falls back to no footpath relaxation
/// (the haversine fallback is the caller's concern). An empty result — no path, no active service,
/// all modes excluded, rounds exhausted — is `Ok(vec![])`, never an error; only a reader/bounds or
/// cross-region-corruption failure surfaces as `Err`.
///
/// Defaults: `max_rounds` is resolved inside `run_scan`
/// to `RAPTOR_MAX_ROUNDS` when `query.max_rounds` is `None`; `mobility` and
/// `excluded_modes` default at the [`Query`] construction site.
pub fn plan<B>(
    reader: &Reader<B>,
    index: &Index,
    transfers: Option<&Transfers>,
    st: &mut ScanState,
    query: &Query,
) -> Result<Vec<Itinerary>, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    plan_with_abort(reader, index, transfers, st, query, None)
}

/// [`plan`] with a cooperative abort flag. When `abort` flips true, the scan
/// stops at the next ROUND boundary and returns [`EngineError::Aborted`] —
/// the wall-clock bound hosts need so a CPU-heavy `/plan` cannot pin a
/// blocking worker past its request timeout (only `max_rounds` bounds the
/// work otherwise). `abort: None` is byte-for-decision identical to [`plan`]
/// (the golden suite runs with `None`), so the pinned-behaviour contract
/// is untouched: the flag can only ever REMOVE work, never change a result —
/// an aborted scan returns no result at all.
pub fn plan_with_abort<B>(
    reader: &Reader<B>,
    index: &Index,
    transfers: Option<&Transfers>,
    st: &mut ScanState,
    query: &Query,
    abort: Option<&core::sync::atomic::AtomicBool>,
) -> Result<Vec<Itinerary>, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    if reader.is_v2() {
        // PTB v2: one exact multi-date search; no overnight retry (it could
        // miss a better previous-service-day journey when the primary result
        // is non-empty).
        return v2::plan_v2(reader, index, transfers, query, abort);
    }
    if index.v2.is_some() {
        return Err(EngineError::IndexBundleMismatch);
    }
    let res = scan_one_day(reader, index, transfers, st, query, abort)?;
    if !res.is_empty() {
        return Ok(res);
    }
    // Overnight fallback (A4) — behavior-preserving port of the TS orchestrator
    // (searchOrchestrator.ts:207-241). Fires only on an EMPTY primary in the
    // near-midnight window. GTFS overnight trips: times >= 86400 belong to the
    // PREVIOUS service day.
    // https://gtfs.org/documentation/schedule/reference/#stop_timestxt
    let secs = query.departure_secs;
    if secs < EARLY_MORNING_SECS {
        let alt = Query {
            date: crate::reader::days_add(query.date, -1),
            departure_secs: secs + SECS_PER_DAY,
            ..query.clone()
        };
        let mut alt_res = scan_one_day(reader, index, transfers, st, &alt, abort)?;
        rewrite_minus_one_day(&mut alt_res);
        return Ok(alt_res);
    }
    if secs >= LATE_NIGHT_SECS {
        // Late night: the TS branch re-scans the CURRENT day with the SAME secs
        // and SAME services — provably identical to `res` (empty). Short-circuit
        // (behavior-preserving).
        return Ok(res);
    }
    // Midday (EARLY_MORNING_SECS <= secs < LATE_NIGHT_SECS): no overnight
    // fallback in the TS orchestrator — return the (empty) primary result.
    Ok(res)
}

/// Map early-morning overnight results (scanned on the previous service day at
/// `+SECS_PER_DAY`) back to the query day. Uniform `−SECS_PER_DAY` over all four
/// emitted time fields — preserves the `alight_secs` Pareto order. Mirrors the TS
/// rewrite (searchOrchestrator.ts:231-238).
fn rewrite_minus_one_day(itins: &mut [Itinerary]) {
    for it in itins.iter_mut() {
        it.board_secs -= SECS_PER_DAY;
        it.alight_secs -= SECS_PER_DAY;
        for leg in it.legs.iter_mut() {
            leg.depart_secs -= SECS_PER_DAY;
            leg.arrive_secs -= SECS_PER_DAY;
        }
    }
}

/// One full single-day scan: reset state, build the excluded-mode mask, resolve
/// `query.date`'s active services, seed entry stops, scan, reconstruct. Begins
/// with `st.reset()`, so it is safe to call more than once per `plan()` (the
/// overnight fallback calls it for the alternate service day).
fn scan_one_day<B>(
    reader: &Reader<B>,
    index: &Index,
    transfers: Option<&Transfers>,
    st: &mut ScanState,
    query: &Query,
    abort: Option<&core::sync::atomic::AtomicBool>,
) -> Result<Vec<Itinerary>, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    st.reset();
    for &rt in &query.excluded_modes {
        st.excluded_mask |= 1u32 << (route_type_to_mode(rt) as u32);
    }
    let active = service::active_services(reader, query.date)?;
    // Build the entry-stop index set once for this query (transfer-floor
    // exemption). `run_scan` seeds round 0 from `query.entry_stops` itself.
    for ew in &query.entry_stops {
        st.entry_set.insert(ew.stop);
    }
    scan::run_scan(reader, index, st, query, &active, transfers, abort)?;
    reconstruct::reconstruct(
        reader,
        index,
        &st.round_arrival,
        &st.parents,
        &st.exit_results,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::testkit::{
        build_multi_route_ptb, build_n_trip_ptb, set_route_type, set_service_bitmask,
        set_stop_wheelchair, set_trip_bikes_allowed, set_trip_wheelchair,
    };
    use alloc::vec;
    use alloc::vec::Vec;

    /// Run the public `plan()` end-to-end over the given bytes + query. Builds a throwaway
    /// `Index`/`ScanState` (test convenience; long-lived hosts reuse both). `None` transfers —
    /// wheelchair/excluded cases don't walk.
    fn plan_bytes(bytes: Vec<u8>, query: &Query) -> Result<Vec<Itinerary>, EngineError> {
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        let mut st = ScanState::default();
        plan(&reader, &index, None, &mut st, query)
    }

    fn q(
        entry: u32,
        exit: u32,
        departure: i64,
        mobility: Mobility,
        excluded: Vec<u16>,
        max_rounds: Option<u32>,
    ) -> Query {
        Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: entry,
                walk_secs: 0,
            }],
            exit_stops: vec![StopWalk {
                stop: exit,
                walk_secs: 0,
            }],
            departure_secs: departure,
            date: 20260505,
            max_rounds,
            mobility,
            excluded_modes: excluded,
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        }
    }

    /// Helper: the route_idx + trip_idx of an itinerary's first transit leg.
    fn first_transit(itin: &Itinerary) -> (u32, u32) {
        match itin.legs[0].kind {
            LegKind::Transit {
                route_idx,
                trip_idx,
                ..
            } => (route_idx, trip_idx),
            LegKind::Walk => panic!("expected first leg to be transit"),
        }
    }

    #[test]
    fn route_exclusion_finds_the_slower_bus_in_all_pattern_modes() {
        let bytes = build_multi_route_ptb(
            2,
            &[
                &[(1, 0, 28800), (2, 1, 29400)],
                &[(1, 0, 28900), (2, 1, 30000)],
            ],
        );
        for mode in [
            PatternMode::Off,
            PatternMode::Unbounded,
            PatternMode::CoveringMerge,
        ] {
            let reader = crate::Reader::from_bytes(bytes.clone()).unwrap();
            let index = Index::build(&reader, mode).unwrap();
            let mut state = ScanState::default();
            let mut query = q(0, 1, 28000, Mobility::Default, vec![], Some(1));
            assert_eq!(
                plan(&reader, &index, None, &mut state, &query).unwrap()[0].alight_secs,
                29400
            );
            query.excluded_routes = vec![0];
            assert_eq!(
                plan(&reader, &index, None, &mut state, &query).unwrap()[0].alight_secs,
                30000
            );
            query.excluded_routes = vec![0, 1];
            assert!(plan(&reader, &index, None, &mut state, &query)
                .unwrap()
                .is_empty());
        }
    }

    // ---- Wheelchair TRIP-skip (raptor.test.ts:215-251) ----
    //
    // One route s0->s1, two trips. Trip 0 departs s0@28800 but is
    // wheelchairAccessible=2 (not accessible); trip 1 departs s0@29000 and is
    // accessible (1). Both sort by dep@0 -> trip 0 (28800) is trip_idx_in_route
    // 0, trip 1 (29000) is trip_idx_in_route 1; underlying trip ordinals 0 and 1.
    //
    // Wheelchair query: the board loop skips trip 0 (==2) and boards trip 1, so
    // the itinerary uses the accessible trip (underlying trip_idx 1), arriving
    // s1 @29600 — NOT @29400 (the inaccessible trip's arrival).
    // ---- Cooperative abort (plan_with_abort) ----
    #[test]
    fn abort_flag_set_returns_aborted_before_any_round() {
        use core::sync::atomic::AtomicBool;
        let bytes = build_n_trip_ptb(2, &[&[(1, 0, 28800), (2, 1, 29400)]]);
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        let mut st = ScanState::default();
        let query = q(0, 1, 28800, Mobility::Default, vec![], None);

        let aborted = AtomicBool::new(true);
        let res = plan_with_abort(&reader, &index, None, &mut st, &query, Some(&aborted));
        assert_eq!(res, Err(EngineError::Aborted));

        // Un-flipped flag is byte-for-decision identical to plan().
        let calm = AtomicBool::new(false);
        let mut st2 = ScanState::default();
        let with_flag =
            plan_with_abort(&reader, &index, None, &mut st2, &query, Some(&calm)).unwrap();
        let mut st3 = ScanState::default();
        let without = plan(&reader, &index, None, &mut st3, &query).unwrap();
        assert_eq!(with_flag, without);
        assert!(!with_flag.is_empty(), "sanity: the fixture has a path");
    }

    #[test]
    fn wheelchair_skips_inaccessible_trip() {
        let mut bytes = build_n_trip_ptb(
            2,
            &[
                &[(1, 0, 28800), (2, 1, 29400)], // trip 0: NOT accessible
                &[(1, 0, 29000), (2, 1, 29600)], // trip 1: accessible
            ],
        );
        set_trip_wheelchair(&mut bytes, 0, 2); // trip 0 -> not accessible
        set_trip_wheelchair(&mut bytes, 1, 1); // trip 1 -> accessible
                                               // Both stops accessible so only the TRIP filter bites.
        set_stop_wheelchair(&mut bytes, 0, 1);
        set_stop_wheelchair(&mut bytes, 1, 1);

        let query = q(0, 1, 28800, Mobility::Wheelchair, vec![], None);
        let out = plan_bytes(bytes, &query).unwrap();

        assert_eq!(
            out.len(),
            1,
            "exactly one itinerary via the accessible trip"
        );
        assert_eq!(out[0].alight_secs, 29600, "boards the accessible trip 1");
        assert_eq!(
            first_transit(&out[0]),
            (0, 1),
            "underlying trip_idx 1 (accessible)"
        );
    }

    // ---- Wheelchair STOP-skip: cannot BOARD at an inaccessible ENTRY stop ----
    //
    // One route s0->s1, single accessible trip. s0 has wheelchairBoarding=2.
    // A wheelchair query whose ENTRY is s0 gets no itinerary — the stop-skip
    // `continue` fires at pos 0 before the board block, so `boarding_trip` is
    // never set and s1 is never reached.
    #[test]
    fn wheelchair_cannot_board_at_inaccessible_entry_stop() {
        let mut bytes = build_n_trip_ptb(2, &[&[(1, 0, 28800), (2, 1, 29400)]]);
        set_trip_wheelchair(&mut bytes, 0, 1); // trip accessible
        set_stop_wheelchair(&mut bytes, 0, 2); // s0 NOT accessible (entry stop)
        set_stop_wheelchair(&mut bytes, 1, 1); // s1 accessible

        let query = q(0, 1, 28800, Mobility::Wheelchair, vec![], None);
        let out = plan_bytes(bytes, &query).unwrap();
        assert!(
            out.is_empty(),
            "cannot board at the inaccessible entry stop s0"
        );
    }

    // ---- Wheelchair STOP-skip: cannot ALIGHT at an inaccessible exit
    // (raptor.test.ts:253-285) ----
    //
    // One route s0->s1->s2, single accessible trip. s1 has wheelchairBoarding=2.
    // A wheelchair query whose EXIT is s1 gets no itinerary — the stop-skip
    // `continue` fires at pos 1 before the alight, so s1 is never recorded.
    #[test]
    fn wheelchair_cannot_alight_at_inaccessible_stop() {
        let mut bytes = build_n_trip_ptb(3, &[&[(1, 0, 28800), (2, 1, 29400), (3, 2, 30000)]]);
        set_trip_wheelchair(&mut bytes, 0, 1); // trip accessible
        set_stop_wheelchair(&mut bytes, 0, 1);
        set_stop_wheelchair(&mut bytes, 1, 2); // s1 NOT accessible
        set_stop_wheelchair(&mut bytes, 2, 1);

        let query = q(0, 1, 28800, Mobility::Wheelchair, vec![], None);
        let out = plan_bytes(bytes, &query).unwrap();
        assert!(out.is_empty(), "cannot alight at the inaccessible s1");
    }

    // ---- Wheelchair STOP-skip: a boarded trip carries THROUGH an inaccessible
    // stop and continues to a later accessible stop (placement proof) ----
    //
    // Same fixture: s0->s1->s2, accessible trip, s1 wheelchairBoarding=2 but s0
    // and s2 accessible. Wheelchair query EXIT s2. At pos 1 the stop-skip
    // `continue` fires BEFORE the board/alight blocks — but board state
    // (boarding_trip, board_stop_idx) set at pos 0 is untouched by `continue`, so
    // at pos 2 the rider alights at s2 @30000. This proves the skip is the FIRST
    // statement and preserves the carried board, not a hard route abort.
    #[test]
    fn wheelchair_boarded_trip_passes_through_inaccessible_stop() {
        let mut bytes = build_n_trip_ptb(3, &[&[(1, 0, 28800), (2, 1, 29400), (3, 2, 30000)]]);
        set_trip_wheelchair(&mut bytes, 0, 1);
        set_stop_wheelchair(&mut bytes, 0, 1);
        set_stop_wheelchair(&mut bytes, 1, 2); // s1 inaccessible (passed through)
        set_stop_wheelchair(&mut bytes, 2, 1); // s2 accessible (alight here)

        let query = q(0, 2, 28800, Mobility::Wheelchair, vec![], None);
        let out = plan_bytes(bytes, &query).unwrap();

        assert_eq!(out.len(), 1, "reaches s2 across the skipped s1");
        assert_eq!(out[0].alight_secs, 30000, "alights at s2 @30000");
        let leg = &out[0].legs[0];
        assert_eq!(leg.from_stop, 0);
        assert_eq!(leg.to_stop, 2);
        // board pos 0, alight pos 2 — the inaccessible s1 (pos 1) is the
        // intermediate raw-position count (2 - 0 - 1 = 1).
        assert_eq!(
            leg.kind,
            LegKind::Transit {
                route_idx: 0,
                reader_route_idx: 0,
                trip_idx: 0,
                route_type: 3,
                board_stop_idx: 0,
                alight_stop_idx: 2,
                intermediate_stops: 1,
                pattern_stop_ids: vec![0, 1, 2],
                approximate: false,
            }
        );
    }

    // ---- Default profile does NOT filter (raptor.test.ts:287-317) ----
    //
    // Single inaccessible trip (==2) over an inaccessible stop (==2). Under the
    // DEFAULT profile neither filter applies, so the trip is used normally.
    #[test]
    fn default_profile_ignores_wheelchair_columns() {
        let mut bytes = build_n_trip_ptb(2, &[&[(1, 0, 28800), (2, 1, 29400)]]);
        set_trip_wheelchair(&mut bytes, 0, 2); // not accessible — but default ignores it
        set_stop_wheelchair(&mut bytes, 0, 2);
        set_stop_wheelchair(&mut bytes, 1, 2);

        let query = q(0, 1, 28800, Mobility::Default, vec![], None);
        let out = plan_bytes(bytes, &query).unwrap();
        assert_eq!(out.len(), 1, "default profile uses the inaccessible trip");
        assert_eq!(out[0].alight_secs, 29400);
        assert_eq!(first_transit(&out[0]), (0, 0));
    }

    // ---- Bicycle TRIP-skip ----
    //
    // Mirrors the wheelchair trip-skip tests. Only bikes_allowed==2 (explicitly
    // forbidden) is skipped; 0 (unknown), 1 (allowed), and out-of-range values
    // are kept. There is no stop-level bikes field, so no stop-skip.

    #[test]
    fn bicycle_skips_no_bike_trip() {
        let mut bytes = build_n_trip_ptb(
            2,
            &[
                &[(1, 0, 28800), (2, 1, 29400)], // trip 0: no bikes
                &[(1, 0, 29000), (2, 1, 29600)], // trip 1: bikes allowed
            ],
        );
        set_trip_bikes_allowed(&mut bytes, 0, 2);
        set_trip_bikes_allowed(&mut bytes, 1, 1);
        let out = plan_bytes(bytes, &q(0, 1, 28800, Mobility::Bicycle, vec![], None)).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].alight_secs, 29600, "boards the bike-allowed trip 1");
        assert_eq!(first_transit(&out[0]), (0, 1));
    }

    #[test]
    fn bicycle_keeps_unknown_bike_trip() {
        let mut bytes = build_n_trip_ptb(2, &[&[(1, 0, 28800), (2, 1, 29400)]]);
        // bikes_allowed defaults to 0 (zero-fill); this explicit set documents the
        // "unknown is kept" intent even though it writes 0 onto 0.
        set_trip_bikes_allowed(&mut bytes, 0, 0); // unknown — kept
        let out = plan_bytes(bytes, &q(0, 1, 28800, Mobility::Bicycle, vec![], None)).unwrap();
        assert_eq!(out.len(), 1, "unknown bike status is not excluded");
    }

    #[test]
    fn bicycle_keeps_out_of_range_bike_value() {
        let mut bytes = build_n_trip_ptb(2, &[&[(1, 0, 28800), (2, 1, 29400)]]);
        set_trip_bikes_allowed(&mut bytes, 0, 3); // out-of-range — only ==2 skips
        let out = plan_bytes(bytes, &q(0, 1, 28800, Mobility::Bicycle, vec![], None)).unwrap();
        assert_eq!(out.len(), 1, "only bikes_allowed==2 is skipped; 3 is kept");
    }

    #[test]
    fn default_profile_ignores_bikes_allowed() {
        let mut bytes = build_n_trip_ptb(2, &[&[(1, 0, 28800), (2, 1, 29400)]]);
        set_trip_bikes_allowed(&mut bytes, 0, 2);
        let out = plan_bytes(bytes, &q(0, 1, 28800, Mobility::Default, vec![], None)).unwrap();
        assert_eq!(out.len(), 1, "default ignores the bikes column");
    }

    // ---- Excluded modes: exclude the only route's mode -> no path
    // (raptor.test.ts:424-436) ----
    //
    // One route, route_type 3 (bus). Excluding [3] removes it at route entry, so
    // the destination is unreachable.
    #[test]
    fn excluded_mode_removes_only_route() {
        let bytes = build_n_trip_ptb(3, &[&[(1, 0, 28800), (2, 1, 29400), (3, 2, 30000)]]);
        let query = q(0, 2, 28800, Mobility::Default, vec![3], None);
        let out = plan_bytes(bytes, &query).unwrap();
        assert!(out.is_empty(), "the only (bus) route is excluded");
    }

    // ---- Excluded modes: excluding an UNUSED mode is harmless
    // (raptor.test.ts:438-451) ----
    #[test]
    fn excluded_mode_not_present_has_no_effect() {
        let bytes = build_n_trip_ptb(3, &[&[(1, 0, 28800), (2, 1, 29400), (3, 2, 30000)]]);
        // Route is type 3 (bus); exclude 0 (tram) and 1 (metro) — neither present.
        let query = q(0, 2, 28800, Mobility::Default, vec![0, 1], None);
        let out = plan_bytes(bytes, &query).unwrap();
        assert_eq!(out.len(), 1, "excluding unused modes leaves the bus route");
        assert_eq!(out[0].alight_secs, 30000);
    }

    // ---- Excluded modes: empty list is a no-op (raptor.test.ts:453-465) ----
    #[test]
    fn excluded_modes_empty_is_noop() {
        let bytes = build_n_trip_ptb(3, &[&[(1, 0, 28800), (2, 1, 29400), (3, 2, 30000)]]);
        let query = q(0, 2, 28800, Mobility::Default, vec![], None);
        let out = plan_bytes(bytes, &query).unwrap();
        assert_eq!(out.len(), 1, "empty excludedModes does not filter anything");
        assert_eq!(out[0].alight_secs, 30000);
    }

    // ---- Excluded modes: exclude one of two modes -> only the other route
    // usable (proves the filter is per-route, by route_type) ----
    //
    // Route 0 (E->P) type 3 (bus), route 1 (E->Q) type 0 (tram). Excluding [0]
    // (tram) drops route 1, so only P (via the bus) is reachable. Q is gone.
    #[test]
    fn excluded_mode_filters_per_route_type() {
        let mut bytes = build_multi_route_ptb(
            3,
            &[
                &[(1, 0, 0), (2, 1, 600)], // route 0 (bus): E -> P
                &[(1, 0, 0), (2, 2, 600)], // route 1 (tram): E -> Q
            ],
        );
        set_route_type(&mut bytes, 0, 3); // bus
        set_route_type(&mut bytes, 1, 0); // tram

        // Exit P (s1) and Q (s2). Exclude tram (0): only P reachable.
        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            exit_stops: vec![
                StopWalk {
                    stop: 1,
                    walk_secs: 0,
                }, // P (bus)
                StopWalk {
                    stop: 2,
                    walk_secs: 0,
                }, // Q (tram, excluded)
            ],
            departure_secs: 0,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![0], // tram
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };
        let out = plan_bytes(bytes, &query).unwrap();
        assert_eq!(out.len(), 1, "only the non-tram exit P is reachable");
        assert_eq!(out[0].legs.last().unwrap().to_stop, 1, "P (bus)");
        assert_eq!(first_transit(&out[0]).0, 0, "via the bus route 0");
    }

    // Extended-type mode-family exclusion: route 1 is a metro (route_type 401).
    // Excluding METRO via its base code [1] must drop it by derived mode.
    #[test]
    fn excluded_mode_filters_extended_metro() {
        let mut bytes = build_multi_route_ptb(
            3,
            &[
                &[(1, 0, 0), (2, 1, 600)], // route 0 (bus): E -> P
                &[(1, 0, 0), (2, 2, 600)], // route 1 (metro 401): E -> Q
            ],
        );
        set_route_type(&mut bytes, 0, 3); // bus
        set_route_type(&mut bytes, 1, 401); // extended metro
        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            exit_stops: vec![
                StopWalk {
                    stop: 1,
                    walk_secs: 0,
                }, // P (bus)
                StopWalk {
                    stop: 2,
                    walk_secs: 0,
                }, // Q (metro 401, excluded)
            ],
            departure_secs: 0,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![1], // METRO base code → excludes the 401 family
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };
        let out = plan_bytes(bytes, &query).unwrap();
        assert_eq!(
            out.len(),
            1,
            "metro 401 excluded by mode → only bus P reachable"
        );
        assert_eq!(out[0].legs.last().unwrap().to_stop, 1, "P (bus)");
    }

    // ---- Negative: no path -> Ok(vec![]) (raptor.test.ts:94-105) ----
    //
    // Route only goes s0->s1->s2; query enters at s2 and exits at s0 (backwards).
    #[test]
    fn no_path_returns_empty_ok() {
        let bytes = build_n_trip_ptb(3, &[&[(1, 0, 28800), (2, 1, 29400), (3, 2, 30000)]]);
        let query = q(2, 0, 28800, Mobility::Default, vec![], None);
        let out = plan_bytes(bytes, &query);
        assert_eq!(out, Ok(vec![]), "no backwards path -> empty Ok, not Err");
    }

    // ---- Negative: no active service -> Ok(vec![]) (raptor.test.ts:82-92) ----
    //
    // The fixture's single service is active on 20260505 (default-builder
    // bitmask covers day 0+; anchor 20260501). Pick a date OUTSIDE the 90-day
    // window so `active_services` returns all-false -> every trip is skipped.
    #[test]
    fn no_active_service_returns_empty_ok() {
        let bytes = build_n_trip_ptb(3, &[&[(1, 0, 28800), (2, 1, 29400), (3, 2, 30000)]]);
        // anchor is 20260501; a date a year later is well past the fixture's
        // runtime service window (the default-builder emits the 90-day window).
        let query = Query {
            date: 20270501,
            ..q(0, 2, 28800, Mobility::Default, vec![], None)
        };
        let out = plan_bytes(bytes, &query);
        assert_eq!(out, Ok(vec![]), "no active service -> empty Ok, not Err");
    }

    // ---- Negative: maxRounds exhausted -> Ok(vec![]) (raptor.test.ts:199-212) -
    //
    // Reaching the exit needs a transfer (round 2). Two routes: route 0 (E->X)
    // and route 1 (X->D). With max_rounds=1 only direct (round-1) trips run, so D
    // (only reachable via the second route after a transfer at X) is unreachable.
    #[test]
    fn max_rounds_exhausted_returns_empty_ok() {
        let bytes = build_multi_route_ptb(
            3,
            &[
                &[(1, 0, 0), (2, 1, 600)],    // route 0: E(s0) -> X(s1)
                &[(1, 1, 900), (2, 2, 1500)], // route 1: X(s1) -> D(s2)
            ],
        );
        // Sanity: with the default (4) rounds, D IS reachable via the transfer.
        let reachable =
            plan_bytes(bytes.clone(), &q(0, 2, 0, Mobility::Default, vec![], None)).unwrap();
        assert_eq!(reachable.len(), 1, "D reachable with enough rounds");
        assert_eq!(reachable[0].alight_secs, 1500);

        // With max_rounds=1, the X->D transfer never happens -> empty.
        let query = q(0, 2, 0, Mobility::Default, vec![], Some(1));
        let out = plan_bytes(bytes, &query);
        assert_eq!(
            out,
            Ok(vec![]),
            "maxRounds=1 cannot make the transfer -> empty Ok"
        );
    }

    //
    // Two DIFFERENT queries on the SAME bytes (forward s0->s2 vs reverse s2->s0,
    // and different departures/round limits) are run twice: once each against a
    // FRESH ScanState (the reference), and once both against a SINGLE reused
    // ScanState in sequence. If reset() left any stale arrival/parent/marked/
    // exit-result/entry-set data behind, the second reused call would diverge
    // from its fresh-state reference. They must be equal, element + array order.
    #[test]
    fn reused_scan_state_matches_fresh_state_across_sequential_plans() {
        let bytes = build_multi_route_ptb(
            3,
            &[
                &[(1, 0, 0), (2, 1, 600)],    // route 0: s0 -> s1
                &[(1, 1, 900), (2, 2, 1500)], // route 1: s1 -> s2 (transfer at s1)
            ],
        );
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();

        // Query A: forward s0 -> s2 (reaches via the s1 transfer, 2 rounds).
        let qa = q(0, 2, 0, Mobility::Default, vec![], None);
        // Query B: a DIFFERENT shape — reverse s2 -> s0 (no backward path => empty),
        // different departure + an explicit round cap, so any leaked A-state
        // (marked stops, exit results, best arrivals) would visibly perturb B.
        let qb = q(2, 0, 50, Mobility::Default, vec![], Some(2));

        // Reference: a FRESH ScanState per query.
        let ref_a = {
            let mut st = ScanState::default();
            plan(&reader, &index, None, &mut st, &qa).unwrap()
        };
        let ref_b = {
            let mut st = ScanState::default();
            plan(&reader, &index, None, &mut st, &qb).unwrap()
        };

        // Reused: ONE ScanState, both queries in sequence (the P3 worker pattern).
        let mut pooled = ScanState::default();
        let pooled_a = plan(&reader, &index, None, &mut pooled, &qa).unwrap();
        let pooled_b = plan(&reader, &index, None, &mut pooled, &qb).unwrap();

        // A then B over the reused state must equal the fresh-state references,
        // element-by-element and in array order (reset() left nothing behind).
        assert_eq!(pooled_a, ref_a, "first reused plan() == fresh-state plan()");
        assert_eq!(
            pooled_b, ref_b,
            "second reused plan() == fresh-state plan() (reset fully cleared query-A state)"
        );
        // Sanity: the two queries are genuinely different (A non-empty, B empty),
        // so the equality above is not vacuous.
        assert!(!ref_a.is_empty(), "query A reaches s2 via the transfer");
        assert!(ref_b.is_empty(), "query B has no backward path");
    }

    // ---- Negative: exclude ALL routes -> Ok(vec![]) (raptor.test.ts:408-422) --
    #[test]
    fn excluded_all_routes_returns_empty_ok() {
        let mut bytes = build_multi_route_ptb(
            3,
            &[
                &[(1, 0, 0), (2, 1, 600)], // route 0 (bus)
                &[(1, 0, 0), (2, 2, 600)], // route 1 (tram)
            ],
        );
        set_route_type(&mut bytes, 0, 3);
        set_route_type(&mut bytes, 1, 0);
        let query = Query {
            exit_stops: vec![
                StopWalk {
                    stop: 1,
                    walk_secs: 0,
                },
                StopWalk {
                    stop: 2,
                    walk_secs: 0,
                },
            ],
            excluded_modes: vec![3, 0], // exclude both modes
            walk_speed_mm_s: None,
            min_transfer_secs: None,
            ..q(0, 1, 0, Mobility::Default, vec![], None)
        };
        let out = plan_bytes(bytes, &query);
        assert_eq!(out, Ok(vec![]), "all modes excluded -> empty Ok");
    }

    #[test]
    fn reader_exposes_bikes_allowed() {
        let mut bytes = build_n_trip_ptb(2, &[&[(1, 0, 28800), (2, 1, 29400)]]);
        set_trip_bikes_allowed(&mut bytes, 0, 2); // poke byte +18
        let r = crate::Reader::from_bytes(bytes).unwrap();
        assert_eq!(
            r.trip_bikes_allowed(0).unwrap(),
            2,
            "scalar accessor reads +18"
        );
        assert_eq!(r.trip(0).unwrap().bikes_allowed, 2, "decode_trip reads +18");
    }

    // A4 overnight fallback. testkit anchor feedStartDate = 20260501 = FRIDAY
    // (day 0). The fixture's service is active on MONDAYS ONLY (a clean weekly
    // pattern, offsets 3,10,17,…) => 20260504 (Mon) active, 20260505 (Tue)
    // inactive. The only trip departs s0@86500 (24:01:40), s1@86800.
    fn overnight_prev_day_bytes() -> Vec<u8> {
        let mut b = build_n_trip_ptb(2, &[&[(1, 0, 86500), (2, 1, 86800)]]);
        let mut bm = [0u8; 12];
        let mut off = 3usize; // first Monday (day0=Fri => Mon at offset 3)
        while off < 90 {
            bm[off / 8] |= 1 << (off % 8);
            off += 7;
        }
        set_service_bitmask(&mut b, 0, &bm);
        b
    }

    fn q_overnight(date: u32, departure_secs: i64) -> Query {
        Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            exit_stops: vec![StopWalk {
                stop: 1,
                walk_secs: 0,
            }],
            departure_secs,
            date,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        }
    }

    #[test]
    fn overnight_early_morning_finds_prev_day_and_rewrites() {
        // 20260505 (Tue) inactive => primary empty; fallback scans 20260504 (Mon).
        let out = plan_bytes(overnight_prev_day_bytes(), &q_overnight(20260505, 100)).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].board_secs, 100); // 86500 − 86400
        assert_eq!(out[0].alight_secs, 400); // 86800 − 86400
        assert_eq!(out[0].legs[0].depart_secs, 100);
        assert_eq!(out[0].legs[0].arrive_secs, 400);
    }

    #[test]
    fn overnight_no_fallback_when_primary_nonempty() {
        // 20260504 (Mon) active: trip departs 86500, query 100 <= 86500 => PRIMARY
        // boards it; no fallback, no rewrite.
        let out = plan_bytes(overnight_prev_day_bytes(), &q_overnight(20260504, 100)).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].board_secs, 86500);
    }

    #[test]
    fn overnight_late_night_empty_short_circuits() {
        // 20260505 (Tue) inactive, late-night secs: primary empty, late-night
        // short-circuit => empty.
        let out = plan_bytes(overnight_prev_day_bytes(), &q_overnight(20260505, 83000)).unwrap();
        assert!(out.is_empty());
    }
}
