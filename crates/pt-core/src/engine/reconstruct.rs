//! Path reconstruction + Pareto dedup + stable array-order sort.
//!
//! Three pins:
//!
//! 1. **Walk back from each `ExitResult`** through the per-round `parents` chain. A **Walk** parent
//! continues from `parent.source_round` — NOT `cur_round - 1` — so a footpath leg that bridged
//! several rounds rewinds to the round its source stop was last improved. A **Transit** parent uses
//! the EXPLICIT `alight_stop_idx` POSITION, never a search for `to_stop`: on a circular route the
//! terminal stop appears twice and a first-match search would pick the wrong occurrence.
//! 2. **Legs
//! are built back-to-front by `push` then a single `reverse()`** — O(n), not the O(n²) prepend. 3.
//! **Pareto dedup keyed `(transfers, exit_stop)`, keep MIN `alight_secs`**, built in first-seen
//! insertion order (first-seen wins on ties — `>=` keeps the existing entry, replace only on strict
//! `<`). Then a **STABLE** sort by `alight_secs` ONLY (no secondary tiebreak). The insertion order
//! — driven by the `exit_results` order, which is driven by the already-found skip in `scan.rs` —
//! is the array order the committed golden (`crates/pt-core/tests/golden/`) locks.

use alloc::vec::Vec;
use hashbrown::HashMap;
use rustc_hash::FxBuildHasher;

use crate::engine::index::Index;
use crate::engine::scan::{alight_secs_at, dep_secs_at, ExitResult, Parent};
use crate::engine::types::{EngineError, Itinerary, Leg, LegKind};
use crate::Reader;

// Same `no_std` FxHashMap alias as the rest of the engine (see scan.rs).
type FxHashMap<K, V> = HashMap<K, V, FxBuildHasher>;

/// Reconstruct full itineraries from the scan's `exit_results` + `parents`,
/// then Pareto-dedup and stable-sort by arrival — array order included.
pub(crate) fn reconstruct<B>(
    reader: &Reader<B>,
    index: &Index,
    round_arrival: &[FxHashMap<u32, i64>],
    parents: &[FxHashMap<u32, Parent>],
    exit_results: &[ExitResult],
) -> Result<Vec<Itinerary>, EngineError>
where
    B: AsRef<[u8]> + Send + Sync + 'static,
{
    let mut itineraries: Vec<Itinerary> = Vec::new();
    for er in exit_results {
        // Build the leg list back-to-front by PUSHING, then reverse once —
        // avoids O(n^2) `insert(0, ..)` front-shifts.
        let mut legs: Vec<Leg> = Vec::new();
        let mut cur_stop = er.stop;
        let mut cur_round = er.round as i64;
        // Count of GTFS type-4 in-seat (stay-seated) boards on this itinerary
        // (S3). Each is NOT a rider-facing transfer, so the transfer count
        // subtracts it (below). Counted while walking the parent chain (the
        // pinned scan order), so the Pareto dedup key `(transfers, exit_stop)`
        // is deterministic.
        let mut in_seat_boards: u32 = 0;
        while cur_round > 0 {
            let parent = match parents[cur_round as usize].get(&cur_stop) {
                Some(p) => p,
                None => break,
            };
            match parent {
                Parent::Walk {
                    from_stop,
                    walk_secs,
                    source_round,
                } => {
                    // Footpath leg: arrival at `cur_stop` is the round's recorded
                    // arrival; departure = arrival - walkSecs. A missing
                    // round_arrival entry here is unreachable in well-formed scan
                    // output — a Walk parent is only written when the stop was
                    // improved this round. The debug_assert surfaces a future scan
                    // regression in debug/test (instead of silently emitting a
                    // garbage arrive_secs=0 leg); the unwrap_or(&0) stays for the
                    // no_std release path.
                    debug_assert!(
                        round_arrival[cur_round as usize].contains_key(&cur_stop),
                        "Walk parent at round {cur_round} for stop {cur_stop} has no round_arrival entry",
                    );
                    let arrive = *round_arrival[cur_round as usize]
                        .get(&cur_stop)
                        .unwrap_or(&0); // keep unwrap_or(&0) — no panic in no_std
                    legs.push(Leg {
                        kind: LegKind::Walk,
                        from_stop: *from_stop,
                        to_stop: cur_stop,
                        depart_secs: arrive - walk_secs,
                        arrive_secs: arrive,
                    });
                    cur_stop = *from_stop;
                    cur_round = *source_round as i64; // the pinned scan order — NOT cur_round-1
                }
                Parent::Transit {
                    // board_stop == route.stop_ids[board_stop_idx]; recompute from
                    // the position (don't wire the redundant field).
                    board_stop: _,
                    route_idx,
                    trip_idx_in_route,
                    board_stop_idx,
                    alight_stop_idx,
                    frequency_board_secs,
                    frequency_offset_secs,
                    approximate,
                    in_seat,
                } => {
                    // type-4 in-seat continuation onto THIS transit leg (S3):
                    // exclude it from the transfer count. Counted here while the
                    // parent is in hand — the leg list is unaffected.
                    if *in_seat {
                        in_seat_boards += 1;
                    }
                    let route = &index.routes[*route_idx as usize];
                    let trip = &route.trips[*trip_idx_in_route as usize];
                    // Boarding uses raw departure_time; alighting uses
                    // arrival_time = departure + arr_diff (= departure - dwell),
                    // matching the τ stored on the forward pass.
                    let template_depart = dep_secs_at(reader, trip, *board_stop_idx as usize)?;
                    let depart = frequency_board_secs.unwrap_or(template_depart);
                    let arrive = alight_secs_at(reader, trip, *alight_stop_idx as usize)?
                        + frequency_offset_secs;
                    legs.push(Leg {
                        kind: LegKind::Transit {
                            route_idx: *route_idx,
                            reader_route_idx: route.reader_route_idx,
                            trip_idx: trip.trip_idx,
                            route_type: route.route_type,
                            board_stop_idx: *board_stop_idx,
                            alight_stop_idx: *alight_stop_idx,
                            // Raw POSITION arithmetic, matching the pinned scan order
                            // (`alightIdx - boardIdx - 1`) — NOT a served-stop
                            // count. Faithful to TS even across express skips.
                            intermediate_stops: alight_stop_idx
                                .saturating_sub(*board_stop_idx)
                                .saturating_sub(1),
                            pattern_stop_ids: route.stop_ids.clone(),
                            approximate: *approximate,
                        },
                        from_stop: route.stop_ids[*board_stop_idx as usize],
                        to_stop: cur_stop,
                        depart_secs: depart,
                        arrive_secs: arrive,
                    });
                    cur_stop = route.stop_ids[*board_stop_idx as usize];
                    cur_round -= 1;
                }
            }
        }
        if !legs.is_empty() {
            legs.reverse(); // back-to-front -> chronological
            let transit_legs = legs
                .iter()
                .filter(|l| matches!(l.kind, LegKind::Transit { .. }))
                .count() as u32;
            // Transfer count = transit boardings − 1 − in-seat (GTFS type-4)
            // boards, clamped ≥ 0 (S3). Mirrors the pinned scan order
            // `Math.max(0, transitLegs - 1 - inSeatBoards)`. This feeds the
            // Pareto dedup key below, so it is computed identically (same point,
            // same arithmetic) on the engine and its wasm binding.
            itineraries.push(Itinerary {
                board_secs: legs[0].depart_secs,
                alight_secs: legs[legs.len() - 1].arrive_secs,
                transfers: transit_legs
                    .saturating_sub(1)
                    .saturating_sub(in_seat_boards),
                legs,
            });
        }
    }

    // Dedup keyed (transfers, exit_stop), keep min alight; preserve insertion
    // order. IndexMap-style: Vec of keys in insertion order + map key->itin.
    let mut order: Vec<(u32, u32)> = Vec::new(); // keys in insertion order
    let mut by_key: FxHashMap<(u32, u32), Itinerary> = FxHashMap::default();
    for itin in itineraries {
        let to_stop = itin.legs[itin.legs.len() - 1].to_stop;
        let key = (itin.transfers, to_stop);
        match by_key.get(&key) {
            // First-seen wins on ties: `>=` keeps the existing entry, pinning TS
            // `Map.set` only-on-strict-`<`. Do NOT relax to `>`.
            Some(existing) if itin.alight_secs >= existing.alight_secs => {}
            Some(_) => {
                by_key.insert(key, itin); // strictly better: replace, position unchanged
            }
            None => {
                order.push(key);
                by_key.insert(key, itin);
            }
        }
    }
    let mut out: Vec<Itinerary> = order
        .into_iter()
        .map(|k| by_key.remove(&k).unwrap())
        .collect();
    out.sort_by_key(|i| i.alight_secs); // STABLE, alight_secs only
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::bitset::Bitset;
    use crate::engine::patterns::PatternMode;
    use crate::engine::scan::{run_scan, ScanState};
    use crate::engine::testkit::{
        build_multi_route_ptb, build_multi_route_ptb_with_transfers, build_n_trip_ptb, build_ptft,
    };
    use crate::engine::{Mobility, Query, StopWalk};
    use crate::transfers::Transfers;
    use alloc::vec;

    /// Test helper: an all-active membership [`Bitset`] of `n` services (the
    /// `Bitset` equivalent of the old `vec![true; n]`).
    fn all_active(n: usize) -> Bitset {
        let mut b = Bitset::with_len(n);
        for i in 0..n {
            b.set(i);
        }
        b
    }

    /// Run the scan then reconstruct, returning the final itinerary array. A
    /// single service, active everywhere (all fixtures here use service 0).
    fn plan_itineraries(bytes: alloc::vec::Vec<u8>, query: &Query) -> Vec<Itinerary> {
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        let active = all_active(1); // num_services == 1 in all testkit fixtures
        let mut state = ScanState::default();
        state.reset();
        for sw in &query.entry_stops {
            state.entry_set.insert(sw.stop);
        }
        run_scan(&reader, &index, &mut state, query, &active, None, None).unwrap();
        reconstruct(
            &reader,
            &index,
            &state.round_arrival,
            &state.parents,
            &state.exit_results,
        )
        .unwrap()
    }

    #[test]
    fn frequency_exact_zero_reconstructs_concrete_approximate_leg() {
        let bytes = include_bytes!(
            "../../../../packages/shared/src/ptb/__fixtures__/frequencies-parity.ptb"
        )
        .to_vec();
        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            exit_stops: vec![StopWalk {
                stop: 1,
                walk_secs: 0,
            }],
            departure_secs: 25_201,
            date: 20260601,
            max_rounds: Some(1),
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };

        let itins = plan_itineraries(bytes, &query);

        assert_eq!(itins.len(), 1);
        assert_eq!(itins[0].board_secs, 25_800);
        assert_eq!(itins[0].alight_secs, 26_100);
        assert_eq!(itins[0].legs.len(), 1);
        assert_eq!(itins[0].legs[0].depart_secs, 25_800);
        assert_eq!(itins[0].legs[0].arrive_secs, 26_100);
        match &itins[0].legs[0].kind {
            LegKind::Transit { approximate, .. } => assert!(*approximate),
            LegKind::Walk => panic!("expected transit leg"),
        }
    }

    // ---- Test 1: terminal-at-destination — TWO itineraries, SPECIFIC ORDER ----
    //
    // Mirrors raptor-loop.test.ts:52-119 (the topology), but asserts ARRAY ORDER
    // directly on the reconstructed itinerary list.
    //
    // Single route R [E,M,D,T] = stops s0,s1,s2,s3; one trip departs
    // 0,300,600,900. Entry E(s0) walk 0, departure 0. Exit stops in query order:
    //   [ T(s3) walk 0, D(s2) walk 180 ].
    //
    // Round 1: transit reaches s1@300, s2@600, s3@900. Exit recording iterates
    // query.exit_stops order: s3 first (push ExitResult{round1,s3,900}), then s2
    // (push ExitResult{round1,s2,600}). Both reconstruct as 0-transfer transit
    // itineraries to DIFFERENT exit stops -> distinct (transfers,exit) keys -> no
    // dedup collapse. Final STABLE sort by alight_secs: s2@600 < s3@900, so the
    // earlier-arriving D itinerary sorts FIRST, the terminal T second.
    #[test]
    fn terminal_at_destination_two_itineraries_in_order() {
        let bytes = build_n_trip_ptb(4, &[&[(1, 0, 0), (2, 1, 300), (3, 2, 600), (4, 3, 900)]]);
        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            exit_stops: vec![
                StopWalk {
                    stop: 3,
                    walk_secs: 0,
                }, // T
                StopWalk {
                    stop: 2,
                    walk_secs: 180,
                }, // D
            ],
            departure_secs: 0,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };
        let out = plan_itineraries(bytes, &query);

        assert_eq!(out.len(), 2, "two distinct exit-stop itineraries");
        // Stable sort by alight_secs: D (s2 @600) before T (s3 @900).
        assert_eq!(out[0].alight_secs, 600);
        assert_eq!(out[0].legs.last().unwrap().to_stop, 2); // D
        assert_eq!(out[0].transfers, 0);
        assert_eq!(out[1].alight_secs, 900);
        assert_eq!(out[1].legs.last().unwrap().to_stop, 3); // T
        assert_eq!(out[1].transfers, 0);

        // Board leg detail on the terminal itinerary: board s0 (pos 0) @0,
        // alight s3 (pos 3) @900, intermediate = 3 - 0 - 1 = 2.
        let t_leg = &out[1].legs[0];
        assert_eq!(t_leg.from_stop, 0);
        assert_eq!(t_leg.to_stop, 3);
        assert_eq!(t_leg.depart_secs, 0);
        assert_eq!(t_leg.arrive_secs, 900);
        assert_eq!(
            t_leg.kind,
            LegKind::Transit {
                route_idx: 0,
                reader_route_idx: 0,
                trip_idx: 0,
                route_type: 3,
                board_stop_idx: 0,
                alight_stop_idx: 3,
                intermediate_stops: 2,
                pattern_stop_ids: vec![0, 1, 2, 3],
                approximate: false,
            }
        );
    }

    // ---- Test 2: multi-route competition — ORDER ----
    //
    // Mirrors raptor-loop.test.ts:121-183 (topology), asserting array order on
    // the reconstructed output directly.
    //
    // Route A [E,D0] = s0,s1, departs 0,1200. Route B [E,X] = s0,s2, departs
    // 0,600. Entry E(s0) walk 0. Exit stops in query order: [ D0(s1) walk 0,
    // X(s2) walk 300 ].
    //
    // Both routes are reached from E in round 1: D0@1200 (route A), X@600
    // (route B). Exit recording (query order): s1 first (1200), then s2 (600).
    // Two 0-transfer itineraries, distinct exit keys. Stable sort by alight:
    // X(s2 @600) before D0(s1 @1200). The slower door-to-door route sorts LAST,
    // proving the dedup did NOT collapse on transfers alone (the regression the
    // TS test guards).
    #[test]
    fn multi_route_competition_order() {
        let bytes = build_multi_route_ptb(
            3,
            &[
                &[(1, 0, 0), (2, 1, 1200)], // route 0 (A): E -> D0
                &[(1, 0, 0), (2, 2, 600)],  // route 1 (B): E -> X
            ],
        );
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
                }, // D0 (route A)
                StopWalk {
                    stop: 2,
                    walk_secs: 300,
                }, // X (route B)
            ],
            departure_secs: 0,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };
        let out = plan_itineraries(bytes, &query);

        assert_eq!(out.len(), 2);
        // Stable sort by alight: X (route B, s2 @600) first, D0 (route A, s1 @1200) second.
        assert_eq!(out[0].alight_secs, 600);
        assert_eq!(out[0].legs.last().unwrap().to_stop, 2); // X
        if let LegKind::Transit { route_idx, .. } = out[0].legs[0].kind {
            assert_eq!(route_idx, 1, "X reached via route B");
        } else {
            panic!("expected transit leg");
        }
        assert_eq!(out[1].alight_secs, 1200);
        assert_eq!(out[1].legs.last().unwrap().to_stop, 1); // D0
        if let LegKind::Transit { route_idx, .. } = out[1].legs[0].kind {
            assert_eq!(route_idx, 0, "D0 reached via route A");
        } else {
            panic!("expected transit leg");
        }
    }

    // ---- Test 3: circular route — alight at the TERMINAL occurrence ----
    //
    // Mirrors raptor-loop.test.ts:185-228. Route LOOP [T,X,Y,T] = stop_idx
    // [0,1,2,0] (terminal s0 repeats). One trip departs T@0,X@600,Y@1200,T@1800.
    // Entry X(s1) walk 0, departure 0. Exit T(s0) walk 0.
    //
    // The canonical pattern keeps the repeat; the per-trip cursor serves BOTH
    // occurrences of stop_idx 0 (pos_to_row = [0,1,2,3], see index.rs circular
    // test). The scan boards at X (pos 1, dep 600) and, going FORWARD from pos 1,
    // alights at s0 via POSITION 3 (dep 1800) — position 0 precedes the board
    // position so it is unreachable on this trip. Reconstruction uses the
    // explicit alight_stop_idx (3), so it reports the position-3 departure 1800
    // — proving it is NOT `indexOf(s0)` (which would return 0 -> the wrong,
    // arrival-before-departure occurrence).
    #[test]
    fn circular_route_alights_at_terminal_occurrence_not_indexof() {
        let bytes = build_n_trip_ptb(3, &[&[(1, 0, 0), (2, 1, 600), (3, 2, 1200), (4, 0, 1800)]]);
        let query = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: 1,
                walk_secs: 0,
            }], // X
            exit_stops: vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }], // T
            departure_secs: 0,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };
        let out = plan_itineraries(bytes, &query);

        assert!(!out.is_empty(), "terminal T must be reachable");
        let itin = &out[0];
        let leg = &itin.legs[0];
        assert_eq!(leg.from_stop, 1); // X
        assert_eq!(leg.to_stop, 0); // T
        assert_eq!(leg.depart_secs, 600); // board X @600
        assert_eq!(leg.arrive_secs, 1800); // alight T @1800 (position 3, NOT 0)
        assert_eq!(itin.alight_secs, 1800);
        // The explicit alight POSITION is 3 (the terminal occurrence), board 1.
        assert_eq!(
            leg.kind,
            LegKind::Transit {
                route_idx: 0,
                reader_route_idx: 0,
                trip_idx: 0,
                route_type: 3,
                board_stop_idx: 1,
                alight_stop_idx: 3,
                // 3 - 1 - 1 = 1 (raw position arithmetic; here = the served Y).
                intermediate_stops: 1,
                pattern_stop_ids: vec![0, 1, 2, 0],
                approximate: false,
            }
        );
    }

    // ---- Test 4: equal-alight array-order pin (the Pareto-tie case) ----
    //
    // Two exit stops reached at EQUAL alight_secs, SAME transfers (0), at
    // DIFFERENT exit stops. The stable sort by alight_secs alone (no secondary
    // tiebreak) MUST preserve their insertion order — which is the
    // `exit_results` order, which is `query.exit_stops` order (both reached
    // round 1, neither pre-empts the other via the alreadyFound skip since they
    // are different stops). A reordered result must FAIL.
    //
    // Route A [E,P] = s0,s1 departs 0,600. Route B [E,Q] = s0,s2 departs 0,600.
    // Exit stops query order: [ P(s1), Q(s2) ]. Both alight @600, 0 transfers.
    #[test]
    fn equal_alight_preserves_array_order_through_stable_sort() {
        let bytes = build_multi_route_ptb(
            3,
            &[
                &[(1, 0, 0), (2, 1, 600)], // route 0 (A): E -> P
                &[(1, 0, 0), (2, 2, 600)], // route 1 (B): E -> Q
            ],
        );
        let query_pq = Query {
            excluded_routes: Default::default(),
            entry_stops: vec![StopWalk {
                stop: 0,
                walk_secs: 0,
            }],
            exit_stops: vec![
                StopWalk {
                    stop: 1,
                    walk_secs: 0,
                }, // P first
                StopWalk {
                    stop: 2,
                    walk_secs: 0,
                }, // Q second
            ],
            departure_secs: 0,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };
        let out_pq = plan_itineraries(bytes.clone(), &query_pq);
        assert_eq!(out_pq.len(), 2);
        assert_eq!(out_pq[0].alight_secs, 600);
        assert_eq!(out_pq[1].alight_secs, 600);
        // EXACT array order: P (s1) before Q (s2) — insertion order survives the
        // stable sort because the two equal-alight entries never reorder.
        assert_eq!(out_pq[0].legs.last().unwrap().to_stop, 1, "P first");
        assert_eq!(out_pq[1].legs.last().unwrap().to_stop, 2, "Q second");

        // Flip the exit-stop order: the array order flips with it, proving the
        // order is genuinely insertion-driven (not an artefact of stop index or
        // route order). A stable sort on equal keys cannot reorder.
        let query_qp = Query {
            exit_stops: vec![
                StopWalk {
                    stop: 2,
                    walk_secs: 0,
                }, // Q first
                StopWalk {
                    stop: 1,
                    walk_secs: 0,
                }, // P second
            ],
            ..query_pq.clone()
        };
        let out_qp = plan_itineraries(bytes, &query_qp);
        assert_eq!(out_qp.len(), 2);
        assert_eq!(
            out_qp[0].legs.last().unwrap().to_stop,
            2,
            "Q first when listed first"
        );
        assert_eq!(out_qp[1].legs.last().unwrap().to_stop, 1, "P second");
    }

    // ---- Test 5: Transit leg followed by Walk leg (Walk-arm + source_round pin) ----
    //
    // Topology: 3 stops s0/s1/s2; 1 route serving ONLY s0 and s1; PTFT footpath
    // s1 ↔ s2 (300 s). Transit is the only way to reach s1; the walk is the only
    // way to reach s2.
    //
    // Trip: s0 departs 600, s1 departs/alights 900 (arr_diff = 0).
    // Entry s0, departure 600. Exit s2 (not on the transit pattern).
    //
    // Round 1 route scan: boards at s0 (pos 0, dep 600), alights at s1 (pos 1,
    // arr 900). Footpath pass: s1 walked to s2 in 300 s → best_arrival[s2] = 1200.
    // parent[1][s2] = Walk { from_stop: 1, walk_secs: 300, source_round: 1 }.
    //
    // Reconstruction rewinds:
    //   cur_stop = s2, cur_round = 1 → Walk leg (s1→s2, depart 900, arrive 1200).
    //   cur_stop = s1, cur_round = 1 (source_round) → Transit leg (s0→s1, dep 600, arr 900).
    //   cur_stop = s0, cur_round = 0 → loop exits (no parent in round 0).
    //
    // Resulting itinerary (reversed back-to-front push order):
    //   legs[0] = Transit { s0→s1, board 600, alight 900 }
    //   legs[1] = Walk    { s1→s2, depart 900, arrive 1200 }
    //   transfers = transit_count.saturating_sub(1) = 1 - 1 = 0
    //   board_secs = 600, alight_secs = 1200
    //
    // This is the only test that exercises reconstruct's Walk arm end-to-end and
    // pins the source_round continuation (cur_round = source_round, not cur_round-1).
    #[test]
    fn transit_then_walk_leg_reconstruction() {
        // 3 stops; route covers only s0 (pos 0) and s1 (pos 1); s2 is off-pattern.
        let bytes = build_n_trip_ptb(3, &[&[(1, 0, 600), (2, 1, 900)]]);
        let reader = crate::Reader::from_bytes(bytes).unwrap();
        let index = Index::build(&reader, PatternMode::Off).unwrap();
        assert_eq!(
            index.routes[0].stop_ids,
            vec![0u32, 1u32],
            "s2 not on the pattern"
        );

        // 300 s walk s1 ↔ s2 (> RAPTOR_MIN_TRANSFER_SECS = 120, so no floor).
        let ptnt = build_ptft(&["s1", "s2"], &[&[(1u32, 300u32)], &[(0u32, 300u32)]]);
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
            }], // s2 only reachable by walk
            departure_secs: 600,
            date: 20260505,
            max_rounds: None,
            mobility: Mobility::Default,
            excluded_modes: vec![],
            walk_speed_mm_s: None,
            min_transfer_secs: None,
        };

        let active = all_active(1);
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
        let out = reconstruct(
            &reader,
            &index,
            &state.round_arrival,
            &state.parents,
            &state.exit_results,
        )
        .unwrap();

        assert_eq!(out.len(), 1, "exactly one itinerary (transit+walk to s2)");
        let itin = &out[0];

        // Itinerary-level fields.
        assert_eq!(itin.board_secs, 600, "boards at 600");
        assert_eq!(itin.alight_secs, 1200, "arrives s2 at 900+300=1200");
        assert_eq!(itin.transfers, 0, "one transit leg → 0 transfers");
        assert_eq!(itin.legs.len(), 2, "transit leg + walk leg");

        // legs[0]: Transit s0→s1.
        let transit = &itin.legs[0];
        assert_eq!(transit.from_stop, 0, "boards at s0");
        assert_eq!(transit.to_stop, 1, "alights at s1");
        assert_eq!(transit.depart_secs, 600);
        assert_eq!(transit.arrive_secs, 900);
        assert_eq!(
            transit.kind,
            LegKind::Transit {
                route_idx: 0,
                reader_route_idx: 0,
                trip_idx: 0,
                route_type: 3,
                board_stop_idx: 0,
                alight_stop_idx: 1,
                intermediate_stops: 0, // 1 - 0 - 1 = 0
                pattern_stop_ids: vec![0, 1],
                approximate: false,
            }
        );

        // legs[1]: Walk s1→s2.
        let walk = &itin.legs[1];
        assert_eq!(walk.kind, LegKind::Walk);
        assert_eq!(walk.from_stop, 1, "walks from s1");
        assert_eq!(walk.to_stop, 2, "walks to s2");
        assert_eq!(
            walk.depart_secs, 900,
            "depart = arrive_s2 - walk_secs = 1200 - 300"
        );
        assert_eq!(walk.arrive_secs, 1200, "arrive s2 = 900 + 300");
    }

    // ---- S3: in-seat (type-4) transfer-count exclusion ------------------------
    //
    // A 2-leg s0→s1→s2 itinerary that is feasible at the global floor (R1
    // departs s1 at arrival(25500)+120 = 25620). WITHOUT a transfer rule the
    // reconstruction reports transfers = transitLegs(2) − 1 = 1. A trip→trip
    // type-4 (s1,s1, T0→T1) marks the T0→T1 board in-seat, so reconstruction
    // reports transfers = 2 − 1 − 1 = 0 (ONE FEWER) — the in-seat semantic. The
    // leg list is UNCHANGED (still two transit legs), per the pinned scan
    // order `max(0, transitLegs - 1 - inSeatBoards)`; the native golden
    // regression fixture (transfer-inseat tuple) pins this behavior.
    #[test]
    fn in_seat_type4_board_excluded_from_transfer_count() {
        let routes: &[&[(u16, u32, u32)]] = &[
            &[(1, 0, 25200), (2, 1, 25500)], // R0/T0: s0 -> s1 (arrives 25500)
            &[(1, 1, 25620), (2, 2, 26000)], // R1/T1: s1 -> s2 (departs at the floor)
        ];
        const ABSENT: u32 = u32::MAX;
        let plan_count = |transfers_rows: &[crate::engine::testkit::TransferRow]| {
            let bytes = build_multi_route_ptb_with_transfers(3, routes, transfers_rows);
            let reader = crate::Reader::from_bytes(bytes).unwrap();
            let index = crate::engine::Index::build(&reader, PatternMode::Off).unwrap();
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
            for sw in &query.entry_stops {
                state.entry_set.insert(sw.stop);
            }
            run_scan(&reader, &index, &mut state, &query, &active, None, None).unwrap();
            let out = reconstruct(
                &reader,
                &index,
                &state.round_arrival,
                &state.parents,
                &state.exit_results,
            )
            .unwrap();
            (
                out.len(),
                out.first()
                    .map(|i| (i.transfers, i.legs.len(), i.alight_secs)),
            )
        };

        // No rule: 2 transit legs → 1 transfer.
        assert_eq!(plan_count(&[]), (1, Some((1, 2, 26000))));
        // trip→trip type-4 (T0→T1): still 2 legs, but the in-seat board is
        // excluded → 0 transfers (one fewer). Floor 0 keeps the connection
        // feasible, so arrival is unchanged.
        assert_eq!(
            plan_count(&[(1, 1, ABSENT, ABSENT, 0, 1, ABSENT, 4)]),
            (1, Some((0, 2, 26000))),
        );
        // type-5 (in-seat forbidden) is a no-op → still 1 transfer (≡ no rule).
        assert_eq!(
            plan_count(&[(1, 1, ABSENT, ABSENT, 0, 1, ABSENT, 5)]),
            (1, Some((1, 2, 26000))),
        );
    }

    // ---- block-chained lasso: type-4 in-seat at apex → 0 transfers -----------
    //
    // Topology: T0 serves s0→s1→s2 (the lasso stem + apex); T1 serves s2→s3→s4 (the lasso tail,
    // starting at the apex). A GTFS type-4 in-seat rule (fromStop=s2, toStop=s2, fromTrip=T0,
    // toTrip=T1) models the block-chained continuation — the driver stays on the vehicle at s2. The
    // apex layover is only 60 s (dep T1 180 − arr T0 120 = 60 s), which is below the default 120 s
    // transfer floor, making the connection feasible ONLY via the in-seat rule (floor=0). Two
    // transit legs → normally 1 transfer, but the type-4 exclusion yields 0.
    #[test]
    fn block_chained_lasso_inseat_is_zero_transfer() {
        const ABSENT: u32 = u32::MAX;
        let plan_count = |transfers_rows: &[crate::engine::testkit::TransferRow]| {
            let bytes = build_multi_route_ptb_with_transfers(
                5,
                &[
                    &[(1, 0, 0), (2, 1, 60), (3, 2, 120)], // R0/T0: s0→s1→s2, apex arr 120
                    &[(1, 2, 180), (2, 3, 240), (3, 4, 300)], // R1/T1: s2→s3→s4, apex dep 180
                ],
                transfers_rows,
            );
            let reader = crate::Reader::from_bytes(bytes).unwrap();
            let index = crate::engine::Index::build(&reader, PatternMode::Off).unwrap();
            let active = all_active(2);
            let query = Query {
                excluded_routes: Default::default(),
                entry_stops: vec![StopWalk {
                    stop: 0,
                    walk_secs: 0,
                }],
                exit_stops: vec![StopWalk {
                    stop: 4,
                    walk_secs: 0,
                }],
                departure_secs: 0,
                date: 20260501,
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
            let out = reconstruct(
                &reader,
                &index,
                &state.round_arrival,
                &state.parents,
                &state.exit_results,
            )
            .unwrap();
            (
                out.len(),
                out.first()
                    .map(|i| (i.transfers, i.legs.len(), i.alight_secs)),
            )
        };

        // No rule: 60 s apex gap is below the 120 s floor → connection is blocked;
        // no itinerary is found.
        assert_eq!(plan_count(&[]), (0, None));
        // trip→trip type-4 (T0→T1 at s2): floor drops to 0, connection is feasible;
        // 2 transit legs counted as 0 transfers (in-seat exclusion).
        assert_eq!(
            plan_count(&[(2, 2, ABSENT, ABSENT, 0, 1, ABSENT, 4)]),
            (1, Some((0, 2, 300))),
        );
    }
}
