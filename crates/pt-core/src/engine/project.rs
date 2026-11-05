//! Index→string projection: converts index-space `Itinerary[]` to the
//! string-keyed `ProjectedItinerary` shape that mirrors `@pt/shared::RaptorItinerary`.
//!
//! This is NOT a hot path — it runs once per query result to produce the
//! wire-ready shape P3/P5 serialize. Owned-String accessors are fine here.
//!
//! Walk legs get mode = "WALK" (TransportMode::WALK, `transit.ts:17`).

use alloc::string::String;
use alloc::vec::Vec; // re-exported by super::* but listed explicitly for no_std clarity

use crate::engine::mode::{mode_to_wire_str, route_type_to_mode};
use crate::engine::types::{EngineError, Itinerary, LegKind};
use crate::Reader;

// ── Projected types ────────────────────────────────────────────────────────
//
// Mirror `routing.ts: RaptorWalkLeg / RaptorTransitLeg / RaptorItinerary`.
// Field surface is minimal: only the fields the differential gate
// compares. Optional TS fields omitted by design:
// - `intermediateStops` on walk legs (not compared by the gate)
//   - `routeShortName`, `routeColor`, `headsign` on transit legs
// (client enrichment in ; omit unless the gate adds them)
// Do not add these fields without updating the differential gate accordingly.

/// A projected walk leg; mirrors `RaptorWalkLeg` (`routing.ts:17-25`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectedWalkLeg {
    /// Always `"walk"`.
    ///
    /// Callers serialising to the TS wire shape must emit this as `"type"`
    /// (Rust keyword-renamed to `leg_type`).
    pub leg_type: &'static str,
    /// Always `"WALK"` (`transit.ts:17`).
    ///
    /// Unlike `RaptorWalkLeg.mode?` (optional in TS), this field is always
    /// present; serialisers must emit it unconditionally.
    pub mode: &'static str,
    pub from_stop_id: String,
    pub to_stop_id: String,
    pub depart_secs: i64,
    pub arrive_secs: i64,
}

/// A projected transit leg; mirrors `RaptorTransitLeg` (`routing.ts:27-44`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectedTransitLeg {
    /// Always `"transit"`.
    ///
    /// Callers serialising to the TS wire shape must emit this as `"type"`
    /// (Rust keyword-renamed to `leg_type`).
    pub leg_type: &'static str,
    /// GTFS route_type mapped via `route_type_to_mode`.
    pub mode: &'static str,
    pub from_stop_id: String,
    pub to_stop_id: String,
    pub depart_secs: i64,
    pub arrive_secs: i64,
    pub route_id: String,
    pub trip_id: String,
    /// Position of `from_stop_id` in route's stop sequence.
    pub board_stop_idx: u32,
    /// Position of `to_stop_id` in route's stop sequence.
    pub alight_stop_idx: u32,
    /// Number of intermediate stops (not counting board/alight).
    pub intermediate_stops: u32,
    /// The scanned pattern's full stop-id sequence (resolved from stop indices). Used by the
    /// frontend for transit leg geometry.
    pub pattern_stop_ids: Vec<String>,
    pub approximate: bool,
}

/// A projected leg: walk or transit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectedLeg {
    Walk(ProjectedWalkLeg),
    Transit(ProjectedTransitLeg),
}

/// Projected itinerary; mirrors `RaptorItinerary` (`routing.ts:48-53`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectedItinerary {
    pub legs: Vec<ProjectedLeg>,
    pub board_secs: i64,
    pub alight_secs: i64,
    pub transfers: u32,
}

// ── Projection entry point ─────────────────────────────────────────────────

/// Project index-space `itins` into string-keyed `ProjectedItinerary`s.
///
/// Resolves stop/route/trip indices to string IDs via the reader; maps
/// `route_type → mode` using the TS-canonical mapping. Walk legs receive
/// `mode = "WALK"`.
///
/// Returns `Err(EngineError::Reader(_))` if a stop, route, or trip index in
/// `itins` is out of bounds in the reader.
///
/// This is NOT a hot path — owned-String accessors are acceptable.
pub fn project<B>(
    reader: &Reader<B>,
    itins: &[Itinerary],
) -> Result<Vec<ProjectedItinerary>, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let mut out = Vec::with_capacity(itins.len());
    for itin in itins {
        let mut legs = Vec::with_capacity(itin.legs.len());
        for leg in &itin.legs {
            let from_stop_id = reader.stop(leg.from_stop as usize)?.stop_id;
            let to_stop_id = reader.stop(leg.to_stop as usize)?.stop_id;
            let projected = match &leg.kind {
                LegKind::Walk => ProjectedLeg::Walk(ProjectedWalkLeg {
                    leg_type: "walk",
                    mode: "WALK",
                    from_stop_id,
                    to_stop_id,
                    depart_secs: leg.depart_secs,
                    arrive_secs: leg.arrive_secs,
                }),
                LegKind::Transit {
                    route_idx: _,
                    reader_route_idx,
                    trip_idx,
                    route_type,
                    board_stop_idx,
                    alight_stop_idx,
                    intermediate_stops,
                    pattern_stop_ids,
                    approximate,
                } => {
                    let route_id = reader.route(*reader_route_idx as usize)?.route_id;
                    let trip_id = reader.trip(*trip_idx as usize)?.trip_id;
                    let mode = mode_to_wire_str(route_type_to_mode(*route_type));
                    let pattern_stop_ids: Vec<String> = pattern_stop_ids
                        .iter()
                        .map(|&i| reader.stop(i as usize).map(|s| s.stop_id))
                        .collect::<Result<Vec<String>, _>>()?;
                    ProjectedLeg::Transit(ProjectedTransitLeg {
                        leg_type: "transit",
                        mode,
                        from_stop_id,
                        to_stop_id,
                        depart_secs: leg.depart_secs,
                        arrive_secs: leg.arrive_secs,
                        route_id,
                        trip_id,
                        board_stop_idx: *board_stop_idx,
                        alight_stop_idx: *alight_stop_idx,
                        intermediate_stops: *intermediate_stops,
                        pattern_stop_ids,
                        approximate: *approximate,
                    })
                }
            };
            legs.push(projected);
        }
        out.push(ProjectedItinerary {
            legs,
            board_secs: itin.board_secs,
            alight_secs: itin.alight_secs,
            transfers: itin.transfers,
        });
    }
    Ok(out)
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::patterns::PatternMode;
    use crate::engine::testkit::{
        build_multi_route_ptb, build_n_trip_ptb, build_two_trip_ptb, set_route_type,
    };
    use crate::engine::{plan, Index, Mobility, Query, ScanState, StopWalk};
    use alloc::vec;

    fn plan_and_project(bytes: Vec<u8>, query: &Query) -> Vec<ProjectedItinerary> {
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        let mut st = ScanState::default();
        let itins = plan(&reader, &index, None, &mut st, query).unwrap();
        project(&reader, &itins).unwrap()
    }

    fn q(entry: u32, exit: u32, departure: i64) -> Query {
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
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        }
    }

    // ── Transit leg: type/mode/stop-ids/route-id/trip-id/secs/indices ─────
    //
    // Single-route (route_type 3 = BUS), 1 trip, s0→s1. After projection:
    // - leg_type="transit", mode="BUS"
    // - from_stop_id="s0", to_stop_id="s1"
    // - route_id="R", trip_id resolved from trip 0
    // - board_stop_idx=0, alight_stop_idx=1, intermediate_stops=0
    // - depart_secs, arrive_secs, board_secs, alight_secs all match fixture

    #[test]
    fn transit_leg_type_mode_stop_ids_route_trip() {
        // Build: 2 stops, 1 trip: s0@28800 → s1@29400
        let bytes = build_n_trip_ptb(2, &[&[(1, 0, 28800), (2, 1, 29400)]]);
        let projected = plan_and_project(bytes, &q(0, 1, 28800));

        assert_eq!(projected.len(), 1, "one itinerary");
        let itin = &projected[0];
        assert_eq!(itin.board_secs, 28800, "board_secs carried through");
        assert_eq!(itin.alight_secs, 29400, "alight_secs carried through");
        assert_eq!(itin.transfers, 0, "direct trip, 0 transfers");

        assert_eq!(itin.legs.len(), 1, "single leg");
        let leg = match &itin.legs[0] {
            ProjectedLeg::Transit(t) => t,
            ProjectedLeg::Walk(_) => panic!("expected transit leg"),
        };
        assert_eq!(leg.leg_type, "transit");
        assert_eq!(leg.mode, "BUS", "route_type 3 → BUS");
        assert_eq!(leg.from_stop_id, "s0");
        assert_eq!(leg.to_stop_id, "s1");
        // route_id: the builder writes intern("R") as the route id for build_n_trip_ptb
        assert_eq!(leg.route_id, "R");
        // trip_id: the builder zero-fills the trip record's trip_id_idx field
        // (u32 @+0), so it points to pool[0] which is always "". Assert the
        // exact resolved value rather than just utf-8 validity.
        assert_eq!(leg.trip_id, "", "pool[0] resolves to empty string");
        assert_eq!(leg.board_stop_idx, 0);
        assert_eq!(leg.alight_stop_idx, 1);
        assert_eq!(leg.intermediate_stops, 0);
        assert_eq!(leg.depart_secs, 28800);
        assert_eq!(leg.arrive_secs, 29400);
    }

    // ── Walk leg: type="walk", mode="WALK" ────────────────────────────────
    //
    // Construct a walk Itinerary directly (the engine only emits walk legs
    // via footpath relaxation, but the projection must handle them regardless
    // of how they were produced). We build the Leg manually and call project().

    #[test]
    fn walk_leg_type_and_mode() {
        use crate::engine::types::{Leg, LegKind};

        let bytes = build_n_trip_ptb(2, &[&[(1, 0, 28800), (2, 1, 29400)]]);
        let reader = crate::Reader::from_bytes(bytes).unwrap();

        let itin = Itinerary {
            legs: vec![Leg {
                kind: LegKind::Walk,
                from_stop: 0,
                to_stop: 1,
                depart_secs: 3600,
                arrive_secs: 3900,
            }],
            board_secs: 3600,
            alight_secs: 3900,
            transfers: 0,
        };

        let projected = project(&reader, &[itin]).unwrap();
        assert_eq!(projected.len(), 1);
        let leg = match &projected[0].legs[0] {
            ProjectedLeg::Walk(w) => w,
            ProjectedLeg::Transit(_) => panic!("expected walk leg"),
        };
        assert_eq!(leg.leg_type, "walk");
        assert_eq!(leg.mode, "WALK");
        assert_eq!(leg.from_stop_id, "s0");
        assert_eq!(leg.to_stop_id, "s1");
        assert_eq!(leg.depart_secs, 3600);
        assert_eq!(leg.arrive_secs, 3900);
    }

    // ── Route type mapping through the full project() pipeline ────────────
    //
    // Two routes: route 0 (tram, type 0) s0→s1, route 1 (trolleybus, type 11)
    // s0→s2. Query exits at both s1 and s2. After projection both itineraries
    // have the correct mode for their route_type.

    #[test]
    fn route_type_mapped_for_tram_and_trolleybus() {
        let mut bytes = build_multi_route_ptb(
            3,
            &[
                &[(1, 0, 0), (2, 1, 600)], // route 0: s0 → s1
                &[(1, 0, 0), (2, 2, 600)], // route 1: s0 → s2
            ],
        );
        set_route_type(&mut bytes, 0, 0); // tram
        set_route_type(&mut bytes, 1, 11); // trolleybus

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
                },
                StopWalk {
                    stop: 2,
                    walk_secs: 0,
                },
            ],
            departure_secs: 0,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };

        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        let mut st = ScanState::default();
        let itins = plan(&reader, &index, None, &mut st, &query).unwrap();
        let projected = project(&reader, &itins).unwrap();

        assert_eq!(projected.len(), 2, "two itineraries (one per exit stop)");

        // Find the itin whose last leg terminates at s1 (route 0, tram).
        let tram_itin = projected
            .iter()
            .find(|p| {
                if let Some(ProjectedLeg::Transit(t)) = p.legs.last() {
                    t.to_stop_id == "s1"
                } else {
                    false
                }
            })
            .expect("tram itinerary to s1");
        let tram_leg = match &tram_itin.legs.last().unwrap() {
            ProjectedLeg::Transit(t) => t,
            _ => panic!(),
        };
        assert_eq!(tram_leg.mode, "TRAM", "route_type 0 → TRAM");
        assert_eq!(tram_leg.route_id, "R0");

        // Find the itin terminating at s2 (route 1, trolleybus).
        let troll_itin = projected
            .iter()
            .find(|p| {
                if let Some(ProjectedLeg::Transit(t)) = p.legs.last() {
                    t.to_stop_id == "s2"
                } else {
                    false
                }
            })
            .expect("trolleybus itinerary to s2");
        let troll_leg = match &troll_itin.legs.last().unwrap() {
            ProjectedLeg::Transit(t) => t,
            _ => panic!(),
        };
        assert_eq!(troll_leg.mode, "TROLLEYBUS", "route_type 11 → TROLLEYBUS");
        assert_eq!(troll_leg.route_id, "R1");
    }

    // ── board_secs/alight_secs/transfers carried through ──────────────────

    #[test]
    fn itinerary_metadata_carried_through() {
        // Two-route fixture requiring a transfer (s0→s1→s2 via two routes).
        let bytes = build_multi_route_ptb(
            3,
            &[
                &[(1, 0, 0), (2, 1, 600)],    // route 0: s0 → s1
                &[(1, 1, 900), (2, 2, 1500)], // route 1: s1 → s2
            ],
        );
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
            departure_secs: 0,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };
        let projected = plan_and_project(bytes, &query);

        assert_eq!(projected.len(), 1);
        let itin = &projected[0];
        assert_eq!(itin.board_secs, 0, "board_secs = first departure");
        assert_eq!(itin.alight_secs, 1500, "alight_secs = last arrival");
        assert_eq!(itin.transfers, 1, "one transfer (two transit legs)");
    }

    // ── Unbounded: branch-stop leg projects bare GTFS route_id + pattern_stop_ids ──
    //
    // Under PatternMode::Unbounded, the BRANCH pattern [s0,s1,s3,s4] is its own
    // IndexRoute (slot 1); its reader_route_idx == 0 (the GTFS route ordinal). A
    // plan from s3 (the branch stop) to s4 must use the BRANCH pattern. The
    // projected transit leg must resolve route_id via reader_route_idx (== "R",
    // the single GTFS route id from build_two_trip_ptb, NOT a pattern artifact),
    // and pattern_stop_ids must equal the pattern's stop-id sequence ["s0","s1",
    // "s3","s4"] so the frontend can slice the polyline at board/alight positions.
    //
    // Fixture: 5 stops (s0..s4); trip 0 = LOCAL [s0,s1,s2,s4]; trip 1 = BRANCH
    // [s0,s1,s3,s4]. Departure from s3 @28800, arrives s4 @29700.
    // Under Off, s3 is not in routes_at_stop → no itinerary; under Unbounded,
    // pattern 1 serves s3 → routable.
    #[test]
    fn unbounded_branch_stop_projects_bare_route_id_and_pattern_stop_ids() {
        let bytes = build_two_trip_ptb(
            5,
            &[(1, 0, 25200), (2, 1, 25500), (3, 2, 25800), (4, 4, 26100)], // LOCAL
            &[(1, 0, 28800), (2, 1, 29100), (3, 3, 29400), (4, 4, 29700)], // BRANCH via s3
        );
        let reader = crate::Reader::from_bytes(bytes).unwrap();

        // Under Off, s3 is not reachable (branch stop not in CSR).
        let idx_off = Index::build(&reader, PatternMode::Off).unwrap();
        let mut st = ScanState::default();
        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: 3,
                walk_secs: 0,
            }], // s3 (branch stop)
            exit_stops: vec![StopWalk {
                stop: 4,
                walk_secs: 0,
            }], // s4
            departure_secs: 28700,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };
        let itins_off = plan(&reader, &idx_off, None, &mut st, &query).unwrap();
        assert!(
            itins_off.is_empty(),
            "Off mode: s3 (branch stop) is not routable under canonical-only index"
        );

        // Under Unbounded, pattern 1 serves s3 → routable.
        let idx_un = Index::build(&reader, PatternMode::Unbounded).unwrap();
        let mut st2 = ScanState::default();
        let itins_un = plan(&reader, &idx_un, None, &mut st2, &query).unwrap();
        assert_eq!(
            itins_un.len(),
            1,
            "Unbounded: s3 reachable via the branch pattern"
        );

        let projected = project(&reader, &itins_un).unwrap();
        assert_eq!(projected.len(), 1);
        let itin = &projected[0];
        assert_eq!(itin.legs.len(), 1);

        let leg = match &itin.legs[0] {
            ProjectedLeg::Transit(t) => t,
            ProjectedLeg::Walk(_) => panic!("expected transit leg"),
        };
        // route_id must be the BARE GTFS route id "R" (resolved via reader_route_idx == 0),
        // NOT a pattern artifact (pattern slot 1 would also decode to "R" under Off, but
        // under Unbounded the pattern slot is 1 and reader_route_idx is 0 — this test
        // proves the projection reads reader_route_idx, not route_idx).
        assert_eq!(
            leg.route_id, "R",
            "bare GTFS route_id resolved via reader_route_idx"
        );
        // pattern_stop_ids must be the BRANCH pattern's full stop-id sequence.
        assert_eq!(
            leg.pattern_stop_ids,
            vec!["s0", "s1", "s3", "s4"],
            "pattern_stop_ids == branch pattern sequence"
        );
        // board/alight positions index into pattern_stop_ids correctly.
        assert_eq!(
            leg.from_stop_id, "s3",
            "from_stop_id = board stop (s3, pattern pos 2)"
        );
        assert_eq!(
            leg.to_stop_id, "s4",
            "to_stop_id = alight stop (s4, pattern pos 3)"
        );
        assert_eq!(
            leg.board_stop_idx, 2,
            "board at position 2 in branch pattern"
        );
        assert_eq!(
            leg.alight_stop_idx, 3,
            "alight at position 3 in branch pattern"
        );
    }
}
