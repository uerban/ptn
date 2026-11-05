//! Complete movement output versus independent raw boardings and winner profile.
use super::*;

fn config(window: core::ops::Range<i64>, deadline: i64) -> DeadlineSessionConfig {
    let mut c = DeadlineSessionConfig::new(window, deadline);
    c.lookup = LazyLookupMode::PlainCached;
    c.pruning = DeadlinePruning::EarliestPrefixAndPoints;
    c.traversal = DeadlineTraversal::ArrivalFirst;
    c.frontier_storage = DeadlineFrontierStorage::EventIndexed;
    c
}

fn assert_movement(net: &Net, q: &Query, index: &Index, journey: &DeadlineJourney) {
    let p = &journey.point;
    legal_witnesses(net, q, index, core::slice::from_ref(p));
    assert!(q.entry_stops.contains(&journey.access));
    assert_eq!(journey.rides.len(), p.witness.len());
    assert_eq!(journey.connections.len() + 1, journey.rides.len());
    assert_eq!(
        p.origin_departure_secs + i64::from(journey.access.walk_secs),
        p.witness[0].board_secs
    );
    with_oracle(net, q, |o| {
        o.deadline = p.origin_departure_secs + ROUTING_HORIZON_SECS;
        let mut previous = None;
        for (i, ride) in journey.rides.iter().enumerate() {
            let w = ride.witness;
            assert_eq!(w, p.witness[i]);
            let route = &index.routes[w.route_idx as usize];
            assert_eq!(ride.from_stop, route.stop_ids[w.board_position as usize]);
            assert_eq!(ride.to_stop, route.stop_ids[w.alight_position as usize]);
            assert_eq!(ride.pattern_stop_ids, route.stop_ids);
            assert_eq!(ride.route_type, route.route_type);
            let trip = &route
                .trips
                .iter()
                .find(|t| t.trip_idx == w.trip_idx)
                .unwrap();
            let served = |p| trip.pos_to_row[..=p].iter().filter(|&&r| r != -1).count() - 1;
            let (board, alight) = (
                served(w.board_position as usize),
                served(w.alight_position as usize),
            );
            let date = (crate::reader::days_from_civil(w.service_date)
                - crate::reader::days_from_civil(START)) as usize;
            let at = o
                .insts
                .iter()
                .position(|t| {
                    t.trip == w.trip_idx
                        && t.date == date
                        && t.evs[board].dep == w.board_secs
                        && t.evs[alight].arr == w.alight_secs
                })
                .unwrap();
            if let Some((from, k)) = previous {
                let movement = &journey.connections[i - 1];
                let oracle = o.transfers_from(Ride {
                    inst: from,
                    k,
                    stay_only: !o.insts[from].evs[k].drop,
                });
                assert!(
                    oracle.iter().any(|b| b.inst == at
                        && b.b == board
                        && b.walk == movement.walk_secs
                        && b.kind
                            == match movement.kind {
                                TransferKind::SameStop => OKind::SameStop,
                                TransferKind::Footpath => OKind::Footpath,
                                TransferKind::Synthetic => OKind::Synthetic,
                                TransferKind::Linked => OKind::Linked,
                                TransferKind::InSeat => OKind::InSeat,
                                TransferKind::Derived => OKind::Derived,
                            }),
                    "movement absent from raw oracle"
                );
                assert_eq!(movement.from_stop, journey.rides[i - 1].to_stop);
                assert_eq!(movement.to_stop, ride.from_stop);
                assert_eq!(
                    movement.arrival_secs,
                    journey.rides[i - 1].witness.alight_secs
                );
                assert_eq!(movement.boarding_secs, w.board_secs);
                assert!(movement.elapsed_secs >= movement.walk_secs as i64);
                assert!(movement.arrival_secs + movement.elapsed_secs <= movement.boarding_secs);
                assert_eq!(!movement.kind.spends_transfer(), w.in_seat);
            }
            previous = Some((at, alight));
        }
        let e = journey.egress;
        assert!(q
            .exit_stops
            .iter()
            .any(|s| s.stop == e.exit_stop && s.walk_secs == e.caller_walk_secs));
        assert_eq!(e.from_stop, journey.rides.last().unwrap().to_stop);
        assert!(
            (e.from_stop == e.exit_stop && e.physical_walk_secs == 0)
                || o.ptft.iter().any(|&(from, to, secs)| from == e.from_stop
                    && to == e.exit_stop
                    && secs as u64 == e.physical_walk_secs)
        );
    });
    let last = journey.rides.last().unwrap().witness;
    assert_eq!(
        last.alight_secs
            + journey.egress.physical_walk_secs as i64
            + i64::from(journey.egress.caller_walk_secs),
        p.destination_arrival_secs
    );
    assert_eq!(
        u64::from(journey.access.walk_secs)
            + journey.connections.iter().map(|c| c.walk_secs).sum::<u64>()
            + journey.egress.physical_walk_secs
            + u64::from(journey.egress.caller_walk_secs),
        p.total_walk_secs
    );
    assert_eq!(
        journey
            .connections
            .iter()
            .filter(|c| c.kind.spends_transfer())
            .count() as u32,
        p.actual_transfers
    );
}

fn check(net: &Net, q: &Query, window: core::ops::Range<i64>, deadline: i64) -> bool {
    let mut nonempty = false;
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let reader = Reader::from_bytes(net.bytes()).unwrap();
        let index = Index::build(&reader, mode).unwrap();
        let table = net.ptft_table();
        let mut request = R3Request::new(q, window.clone());
        request.transfers = table.as_ref();
        request.max_labels = 1_000_000;
        let points: Vec<_> = profile_m4(&reader, &index, request)
            .unwrap()
            .points
            .into_iter()
            .filter(|p| p.destination_arrival_secs <= deadline)
            .collect();
        // Independent raw objective oracle plus full canonical forward witnesses.
        let mut union = Vec::new();
        for entry in &q.entry_stops {
            for exit in &q.exit_stops {
                let single = Query {
                    entry_stops: vec![*entry],
                    exit_stops: vec![*exit],
                    ..q.clone()
                };
                union.extend(
                    expected(net, &single, &window, ProfileObjectives::M4)
                        .into_iter()
                        .filter(|p| p.1 <= deadline),
                );
            }
        }
        union.sort_unstable();
        union.dedup();
        let raw: Vec<_> = union
            .iter()
            .copied()
            .filter(|p| {
                !union
                    .iter()
                    .any(|a| a != p && a.0 >= p.0 && a.1 <= p.1 && a.2 <= p.2 && a.3 <= p.3)
            })
            .collect();
        assert_eq!(tuples(&points, ProfileObjectives::M4), raw);
        let mut owner = DeadlineSession::new(
            Reader::from_bytes(net.bytes()).unwrap(),
            mode,
            net.ptft_table(),
        )
        .unwrap();
        let cfg = config(window.clone(), deadline);
        owner.prepare(q.clone(), cfg.clone()).unwrap();
        let base = owner
            .run_portfolio_with_phases(DeadlineSuffixPruning::RowPrefix, |_| {})
            .unwrap();
        let result = owner
            .run_portfolio_journeys(DeadlineSuffixPruning::RowPrefix)
            .unwrap();
        assert_eq!(result.search.winners, base.winners);
        assert_eq!(
            result.search.winners,
            DeadlinePortfolioWinners::from_m4_points(&points)
        );
        assert_eq!(result.search.diagnostics, base.diagnostics);
        assert_eq!(result.search.frontiers, base.frontiers);
        assert_eq!(result.search.selection, base.selection);
        assert!(result.search.complete);
        assert!(result.projection.aggregate_stop_work <= cfg.max_stop_scans);
        assert_eq!(
            result.projection.aggregate_lookup_work,
            base.diagnostics.lazy.work + result.projection.lookup_work
        );
        assert!(result.projection.aggregate_lookup_work <= cfg.max_lookup_work);
        assert_eq!(result.projection.unique_journeys, result.journeys.len());
        nonempty |= !result.journeys.is_empty();
        for j in &result.journeys {
            assert_movement(net, q, &index, j);
        }
        for (slot, pref) in DeadlinePreference::ALL.into_iter().enumerate() {
            assert_eq!(
                result.by_preference[slot].map(|i| &result.journeys[i].point),
                base.winners.by_preference[slot].as_ref()
            );
            let single = owner
                .run_preference_journey(pref, DeadlineSuffixPruning::RowPrefix)
                .unwrap();
            assert_eq!(single.search.winner, pref.from_m4_points(&points));
            assert_eq!(
                single.journey.as_ref().map(|j| &j.point),
                single.search.winner.as_ref()
            );
            if let Some(j) = &single.journey {
                assert_movement(net, q, &index, j);
            }
        }
    }
    nonempty
}

#[test]
fn journey_replay_checked_matches_prepared_prefixes_and_phase_markers() {
    let mut net = Net::new(5, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(2, 1300), (3, 1500)]);
    net.ptft.extend([(1, 2, 30), (3, 4, 80)]);
    let q = query(0, 4, 880, 2);
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let mut owner = DeadlineSession::new_with_immutable_binding(
            Reader::from_bytes(net.bytes()).unwrap(),
            mode,
            net.ptft_table(),
        )
        .unwrap();
        for pruning in [
            DeadlinePruning::EarliestPrefixAndPoints,
            DeadlinePruning::EarliestPrefixAndTimetablePoints,
        ] {
            let mut c = config(880..1000, 1620);
            c.pruning = pruning;
            owner.prepare_with_prefix_cache(q.clone(), c).unwrap();
            for suffix in [DeadlineSuffixPruning::Off, DeadlineSuffixPruning::RowPrefix] {
                let mut phases = Vec::new();
                let checked = owner
                    .run_portfolio_journeys_checked_with_phases(suffix, |p| phases.push(p))
                    .unwrap();
                assert_eq!(
                    phases,
                    [DeadlinePhase::Prepared, DeadlinePhase::SearchFinished]
                );
                phases.clear();
                let prepared = owner
                    .run_portfolio_journeys_with_phases(suffix, |p| phases.push(p))
                    .unwrap();
                assert_eq!(
                    phases,
                    [DeadlinePhase::Prepared, DeadlinePhase::SearchFinished]
                );
                assert_eq!(checked.search.winners, prepared.search.winners);
                assert_eq!(checked.search.diagnostics, prepared.search.diagnostics);
                assert_eq!(checked.journeys, prepared.journeys);
                assert_eq!(checked.by_preference, prepared.by_preference);
                assert_eq!(checked.projection, prepared.projection);
                assert!(!checked.journeys.is_empty());
                for p in DeadlinePreference::ALL {
                    let checked = owner
                        .run_preference_journey_checked_with_phases(p, suffix, |_| {})
                        .unwrap();
                    let prepared = owner
                        .run_preference_journey_with_phases(p, suffix, |_| {})
                        .unwrap();
                    assert_eq!(checked.search.winner, prepared.search.winner);
                    assert_eq!(checked.search.diagnostics, prepared.search.diagnostics);
                    assert_eq!(checked.journey, prepared.journey);
                    assert_eq!(checked.projection, prepared.projection);
                }
            }
        }
        owner.clear();
        assert!(matches!(
            owner.run_portfolio_journeys_checked_with_phases(DeadlineSuffixPruning::Off, |_| {}),
            Err(DeadlineError::InvalidRequest(_))
        ));
        assert!(matches!(
            owner.run_preference_journey_checked_with_phases(
                DeadlinePreference::LatestDeparture,
                DeadlineSuffixPruning::Off,
                |_| {}
            ),
            Err(DeadlineError::InvalidRequest(_))
        ));
    }
}

#[test]
fn journey_replay_matches_generated_raw_and_canonical_winners_all_modes() {
    let mut rng = Rng(0x4a4f_5552_4e45_5931);
    let mut nonempty = 0;
    for _ in 0..100 {
        let mut net = random_net(&mut rng);
        net.strip = rng.chance(50);
        let mut q = query(
            rng.below(5) as u32,
            rng.below(5) as u32,
            68000,
            1 + rng.below(3) as u32,
        );
        q.entry_stops[0].walk_secs = rng.below(60) as u32;
        q.exit_stops[0].walk_secs = rng.below(60) as u32;
        if rng.chance(30) {
            q.mobility = Mobility::Wheelchair;
        }
        nonempty += usize::from(check(&net, &q, 68000..72000, 76000));
    }
    assert!(nonempty > 15, "sparse projection corpus: {nonempty}");
}

#[test]
fn journey_replay_separates_access_directed_egress_and_transfer_floor() {
    let mut net = Net::new(5, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(2, 1300), (3, 1500)]);
    net.ptft.extend([(1, 2, 30), (2, 1, 7), (3, 4, 80)]);
    let mut q = query(0, 4, 880, 2);
    q.entry_stops[0].walk_secs = 20;
    q.exit_stops[0].walk_secs = 40;
    assert!(check(&net, &q, 880..881, 1620));
    let mut owner = DeadlineSession::new(
        Reader::from_bytes(net.bytes()).unwrap(),
        PatternMode::CoveringMerge,
        net.ptft_table(),
    )
    .unwrap();
    owner.prepare(q, config(880..881, 1620)).unwrap();
    let r = owner
        .run_portfolio_journeys(DeadlineSuffixPruning::RowPrefix)
        .unwrap();
    assert_eq!(r.journeys.len(), 1);
    assert_eq!(r.by_preference, [Some(0); 4]);
    let j = &r.journeys[0];
    assert_eq!(j.connections[0].walk_secs, 30);
    assert_eq!(j.connections[0].elapsed_secs, 120);
    assert_eq!(j.point.total_walk_secs, 170);
    assert_eq!(j.egress.exit_stop, 4);
    assert_eq!(j.egress.physical_walk_secs, 80);
    assert_eq!(j.egress.caller_walk_secs, 40);
}

#[test]
fn journey_replay_keeps_inseat_forbidden_pickup_dropoff_and_scoped_ban() {
    let mut net = Net::new(3, 2);
    let first = net.trip(0, &[(0, 900), (1, 1000)]);
    let next = net.trip(1, &[(1, 1050), (2, 1200)]);
    net.boarding = vec![0x50, 0x54, 0x51, 0x50];
    net.transfers
        .push((1, 1, ABSENT, ABSENT, first, next, ABSENT, 4));
    assert!(check(&net, &query(0, 2, 900, 2), 900..901, 1200));
    let mut net = Net::new(3, 3);
    let banned = net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(0, 900), (1, 1000)]);
    let onward = net.trip(2, &[(1, 1200), (2, 1300)]);
    net.transfers
        .push((1, 1, ABSENT, ABSENT, banned, onward, ABSENT, 3));
    assert!(check(&net, &query(0, 2, 900, 2), 900..901, 1300));
}

#[test]
fn journey_replay_keeps_synthetic_and_explicit_minimum_time_movements() {
    for physical in [false, true] {
        let mut net = Net::new(4, 2);
        let a = net.trip(0, &[(0, 900), (1, 1000)]);
        let b = net.trip(1, &[(2, 1300), (3, 1500)]);
        net.transfers.push((1, 2, ABSENT, ABSENT, a, b, 180, 2));
        if physical {
            net.ptft.push((1, 2, 30));
        }
        let q = query(0, 3, 900, 2);
        assert!(check(&net, &q, 900..901, 1500));
        let mut owner = DeadlineSession::new(
            Reader::from_bytes(net.bytes()).unwrap(),
            PatternMode::CoveringMerge,
            net.ptft_table(),
        )
        .unwrap();
        owner.prepare(q, config(900..901, 1500)).unwrap();
        let r = owner
            .run_preference_journey(
                DeadlinePreference::LatestDeparture,
                DeadlineSuffixPruning::RowPrefix,
            )
            .unwrap();
        let c = r.journey.unwrap().connections[0];
        assert_eq!(c.elapsed_secs, 180);
        assert_eq!(c.walk_secs, if physical { 30 } else { 180 });
        assert_eq!(
            c.kind,
            if physical {
                TransferKind::Footpath
            } else {
                TransferKind::Synthetic
            }
        );
    }
}

#[test]
fn journey_replay_keeps_four_rides_and_duplicate_access_egress_ties() {
    let mut net = Net::new(6, 4);
    for (route, depart) in [900, 1200, 1500, 1800].into_iter().enumerate() {
        net.trip(
            route as u32,
            &[(route as u32, depart), (route as u32 + 1, depart + 100)],
        );
    }
    net.ptft.push((4, 5, 50));
    let mut q = query(0, 5, 880, 4);
    q.entry_stops = vec![
        StopWalk {
            stop: 0,
            walk_secs: 20,
        },
        StopWalk {
            stop: 0,
            walk_secs: 10,
        },
        StopWalk {
            stop: 0,
            walk_secs: 20,
        },
    ];
    q.exit_stops = vec![
        StopWalk {
            stop: 5,
            walk_secs: 30,
        },
        StopWalk {
            stop: 4,
            walk_secs: 80,
        },
        StopWalk {
            stop: 4,
            walk_secs: 90,
        },
    ];
    assert!(check(&net, &q, 880..881, 1980));
    let mut owner = DeadlineSession::new(
        Reader::from_bytes(net.bytes()).unwrap(),
        PatternMode::CoveringMerge,
        net.ptft_table(),
    )
    .unwrap();
    owner.prepare(q, config(880..881, 1980)).unwrap();
    let r = owner
        .run_portfolio_journeys(DeadlineSuffixPruning::RowPrefix)
        .unwrap();
    assert_eq!(r.journeys.len(), 1);
    let j = &r.journeys[0];
    assert_eq!(j.rides.len(), 4);
    assert_eq!(j.point.actual_transfers, 3);
    assert_eq!(j.point.total_walk_secs, 100);
    assert_eq!(j.egress.exit_stop, 4);
    assert_eq!(j.egress.caller_walk_secs, 80);
}

#[test]
fn journey_replay_keeps_frequency_dates_loops_and_block_lasso() {
    for exact in [0, 1] {
        let mut net = Net::new(4, 2);
        net.trip(0, &[(0, 86000), (1, 87000)]);
        let target = net.trip(1, &[(1, 87050), (2, 87200), (1, 87300), (3, 87400)]);
        net.freqs.push((target, 87050, 87551, 100, exact));
        let mut origins = utc_origins(START, DAYS as usize, 0);
        for origin in origins.iter_mut().skip(4) {
            *origin -= 3600;
        }
        net.origins = Some(origins);
        assert!(check(&net, &query(0, 3, 85000, 2), 85000..87001, 88000));
    }
    for split in [false, true] {
        let mut net = Net::new(3, 2);
        net.services = vec![0b0000_1000];
        if split {
            net.trip(0, &[(0, 900), (1, 1000), (2, 1100)]);
            net.trip(1, &[(2, 1100), (1, 1200), (0, 1300)]);
            net.trips[0].block = Some("lasso");
            net.trips[1].block = Some("lasso");
            net.derive = true;
        } else {
            net.trip(0, &[(0, 900), (1, 1000), (2, 1100), (1, 1200), (0, 1300)]);
        }
        assert!(check(&net, &query(1, 0, 950, 2), 950..1101, 1300));
    }
}

#[test]
fn journey_replay_is_aggregate_capped_and_invalidates_with_owner_request() {
    let mut net = Net::new(2, 1);
    net.trip(0, &[(0, 900), (1, 1000)]);
    let q = query(0, 1, 900, 1);
    let mut owner = DeadlineSession::new(
        Reader::from_bytes(net.bytes()).unwrap(),
        PatternMode::Off,
        None,
    )
    .unwrap();
    assert!(owner
        .run_portfolio_journeys(DeadlineSuffixPruning::RowPrefix)
        .is_err());
    owner.prepare(q.clone(), config(900..901, 1000)).unwrap();
    let baseline = owner
        .run_portfolio_with_phases(DeadlineSuffixPruning::RowPrefix, |_| {})
        .unwrap();
    let projected = owner
        .run_portfolio_journeys(DeadlineSuffixPruning::RowPrefix)
        .unwrap();
    let search_stop = projected.projection.aggregate_stop_work - projected.projection.stop_work;
    for stop_cap in [true, false] {
        let mut cfg = config(900..901, 1000);
        if stop_cap {
            cfg.max_stop_scans = search_stop;
        } else {
            // A direct single-ride search can use zero lazy work, but a zero
            // configured cap is invalid. One still admits that search and
            // rejects the additional catalogue probes in projection.
            cfg.max_lookup_work = baseline.diagnostics.lazy.work.max(1);
        }
        owner.prepare(q.clone(), cfg).unwrap();
        assert!(owner
            .run_portfolio_with_phases(DeadlineSuffixPruning::RowPrefix, |_| {})
            .is_ok());
        let error = owner
            .run_portfolio_journeys(DeadlineSuffixPruning::RowPrefix)
            .unwrap_err();
        assert!(if stop_cap {
            matches!(error, DeadlineError::StopScansExhausted { .. })
        } else {
            matches!(
                error,
                DeadlineError::Lookup(LazyLookupError::WorkExhausted { .. })
            )
        });
    }
    owner
        .prepare(
            Query {
                entry_stops: vec![],
                ..q.clone()
            },
            config(900..901, 1000),
        )
        .unwrap();
    let empty = owner
        .run_portfolio_journeys(DeadlineSuffixPruning::RowPrefix)
        .unwrap();
    assert!(empty.journeys.is_empty());
    assert_eq!(empty.by_preference, [None; 4]);
    assert_eq!(empty.projection.stop_work, 0);
    assert_eq!(empty.projection.lookup_work, 0);
    owner.prepare(q, config(900..901, 1000)).unwrap();
    owner.clear();
    assert!(owner
        .run_portfolio_journeys(DeadlineSuffixPruning::RowPrefix)
        .is_err());
    assert!(owner
        .run_preference_journey(
            DeadlinePreference::LatestDeparture,
            DeadlineSuffixPruning::RowPrefix
        )
        .is_err());
}

#[test]
fn journey_replay_caps_controlled_movement_but_not_caller_egress_at_48_hours() {
    let mut net = Net::new(3, 1);
    net.services = vec![0b0000_1000];
    net.trip(0, &[(0, 900), (1, 900 + ROUTING_HORIZON_SECS as u32 - 20)]);
    net.ptft.push((1, 2, 20));
    let mut q = query(0, 2, 900, 1);
    q.exit_stops[0].walk_secs = 500;
    assert!(check(&net, &q, 900..901, 900 + ROUTING_HORIZON_SECS + 500));
}
