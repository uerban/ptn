//! Current-winner ceiling only; do not multiply the older cartesian stress test.
use super::*;

fn config(window: core::ops::Range<i64>, deadline: i64) -> DeadlineSessionConfig {
    let mut c = DeadlineSessionConfig::new(window, deadline);
    c.lookup = LazyLookupMode::PlainCached;
    c.pruning = DeadlinePruning::EarliestPrefixAndPoints;
    c.traversal = DeadlineTraversal::ArrivalFirst;
    c.frontier_storage = DeadlineFrontierStorage::EventIndexed;
    c
}

fn check_ceiling(net: &Net, q: &Query, window: core::ops::Range<i64>, deadline: i64) -> bool {
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let walks = net.ptft_table();
    let mut nonempty = false;
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let index = Index::build(&reader, mode).unwrap();
        let mut r = R3Request::new(q, window.clone());
        r.transfers = walks.as_ref();
        r.max_labels = 1_000_000;
        let points: Vec<_> = profile_m4(&reader, &index, r)
            .unwrap()
            .points
            .into_iter()
            .filter(|p| p.destination_arrival_secs <= deadline)
            .collect();
        let raw: Vec<_> = expected(net, q, &window, ProfileObjectives::M4)
            .into_iter()
            .filter(|p| p.1 <= deadline)
            .collect();
        assert_eq!(
            tuples(&points, ProfileObjectives::M4),
            raw,
            "independent raw oracle {mode:?}"
        );
        nonempty |= !points.is_empty();
        let mut session = DeadlineSession::new(
            Reader::from_bytes(net.bytes()).unwrap(),
            mode,
            net.ptft_table(),
        )
        .unwrap();
        for witness in [
            DeadlineWitnessComparison::Materialized,
            DeadlineWitnessComparison::MaterializedDateMemo,
        ] {
            let mut c = config(window.clone(), deadline);
            c.witness_comparison = witness;
            session.prepare(q.clone(), c).unwrap();
            let key = session.catalogue_key();
            for preference in [None].into_iter().chain(DeadlinePreference::ALL.map(Some)) {
                let mut phases = Vec::new();
                let result = session
                    .run_winner_incumbent_ceiling_with_phases(
                        preference,
                        DeadlineSuffixPruning::RowPrefix,
                        |p| phases.push(p),
                    )
                    .unwrap();
                assert_eq!(
                    phases,
                    [
                        DeadlineWinnerCeilingPhase::Baseline(DeadlinePhase::Prepared),
                        DeadlineWinnerCeilingPhase::Baseline(DeadlinePhase::SearchFinished),
                        DeadlineWinnerCeilingPhase::Ceiling(DeadlinePhase::Prepared),
                        DeadlineWinnerCeilingPhase::Ceiling(DeadlinePhase::SearchFinished)
                    ]
                );
                assert_eq!(result.preference, preference);
                let mut expected = DeadlinePortfolioWinners::from_m4_points(&points);
                if let Some(p) = preference {
                    for (s, point) in DeadlinePreference::ALL
                        .into_iter()
                        .zip(&mut expected.by_preference)
                    {
                        if s != p {
                            *point = None;
                        }
                    }
                }
                assert_eq!(
                    result.baseline.winners, expected,
                    "canonical source {mode:?}/{witness:?}/{preference:?}"
                );
                assert_eq!(
                    result.ceiling.winners, expected,
                    "canonical ceiling {mode:?}/{witness:?}/{preference:?}"
                );
                let mut unique = Vec::new();
                for p in expected.by_preference.iter().flatten() {
                    if !unique.contains(p) {
                        unique.push(p.clone());
                    }
                }
                assert_eq!(result.initial_points, unique.len());
                assert_eq!(result.baseline.window, window);
                assert_eq!(result.ceiling.window, window);
                assert_eq!(result.baseline.arrival_deadline, deadline);
                assert_eq!(result.ceiling.arrival_deadline, deadline);
                legal_witnesses(net, q, &index, &unique);
                let (diagnostics, frontiers, selection) = if let Some(p) = preference {
                    let ordinary = session
                        .run_preference_with_phases(p, DeadlineSuffixPruning::RowPrefix, |_| {})
                        .unwrap();
                    assert_eq!(ordinary.winner, p.from_m4_points(&points));
                    (ordinary.diagnostics, ordinary.frontiers, ordinary.selection)
                } else {
                    let ordinary = session
                        .run_portfolio_with_phases(DeadlineSuffixPruning::RowPrefix, |_| {})
                        .unwrap();
                    assert_eq!(ordinary.winners, expected);
                    (ordinary.diagnostics, ordinary.frontiers, ordinary.selection)
                };
                assert_eq!(result.baseline.diagnostics, diagnostics);
                assert_eq!(result.baseline.frontiers, frontiers);
                assert_eq!(result.baseline.selection, selection);
                assert_eq!(
                    result.ceiling.diagnostics.forward,
                    ForwardSeedDiagnostics::default()
                );
                assert_eq!(session.catalogue_key(), key);
                assert!(!session.catalogue_reused());
            }
        }
    }
    nonempty
}

#[test]
fn winner_ceiling_matches_independent_oracles_on_200_generated_networks() {
    let mut rng = Rng(0x5749_4e43_4549_4c41);
    let mut nonempty = 0;
    for _ in 0..200 {
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
        nonempty += usize::from(check_ceiling(&net, &q, 68000..72000, 76000));
    }
    assert!(nonempty > 35, "sparse winner ceiling corpus: {nonempty}");
}

#[test]
fn winner_ceiling_preserves_ties_empty_results_and_deduplicates_full_winners() {
    let mut net = Net::new(2, 1);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(0, &[(0, 900), (1, 1000)]);
    assert!(check_ceiling(&net, &query(0, 1, 900, 1), 900..901, 1000));
    assert!(!check_ceiling(&net, &query(1, 0, 900, 1), 900..901, 1000));
    let mut s = DeadlineSession::new(
        Reader::from_bytes(net.bytes()).unwrap(),
        PatternMode::CoveringMerge,
        None,
    )
    .unwrap();
    for (entry, exit, count) in [(0, 1, 1), (1, 0, 0)] {
        s.prepare(query(entry, exit, 900, 1), config(900..901, 1000))
            .unwrap();
        let r = s
            .run_winner_incumbent_ceiling_with_phases(
                None,
                DeadlineSuffixPruning::RowPrefix,
                |_| {},
            )
            .unwrap();
        assert_eq!(r.initial_points, count);
        assert_eq!(r.baseline.diagnostics, r.ceiling.diagnostics);
        for p in r.ceiling.winners.by_preference.iter().flatten() {
            assert_eq!(p.witness[0].trip_idx, 0);
        }
    }
}

#[test]
fn winner_ceiling_uses_actual_selector_tracker_and_saves_late_discovery_work() {
    let mut net = Net::new(3, 3);
    for i in 0..8 {
        net.trip(0, &[(0, 700 + i * 10), (1, 800 + i * 10)]);
    }
    net.trip(1, &[(1, 1100), (2, 1200)]);
    net.trip(2, &[(0, 1000), (2, 1500)]);
    assert!(check_ceiling(&net, &query(0, 2, 700, 2), 700..1101, 1500));
    let mut s = DeadlineSession::new(
        Reader::from_bytes(net.bytes()).unwrap(),
        PatternMode::Off,
        None,
    )
    .unwrap();
    s.prepare(query(0, 2, 700, 2), config(700..1101, 1500))
        .unwrap();
    let r = s
        .run_winner_incumbent_ceiling_with_phases(
            Some(DeadlinePreference::LatestDeparture),
            DeadlineSuffixPruning::RowPrefix,
            |_| {},
        )
        .unwrap();
    assert!(r.ceiling.diagnostics.lazy.work < r.baseline.diagnostics.lazy.work);
    assert!(r.ceiling.diagnostics.seed_event_checks > 0); // Not a returned cached answer.
    assert_eq!(r.baseline.winners, r.ceiling.winners);
}

#[test]
fn winner_ceiling_keeps_rules_inseat_loops_frequencies_dst_and_both_lassos() {
    let mut net = Net::new(3, 3);
    let banned = net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(0, 900), (1, 1000)]);
    let onward = net.trip(2, &[(1, 1200), (2, 1300)]);
    net.transfers
        .push((1, 1, ABSENT, ABSENT, banned, onward, ABSENT, 3));
    assert!(check_ceiling(&net, &query(0, 2, 900, 2), 900..901, 1300));
    let mut net = Net::new(3, 2);
    let a = net.trip(0, &[(0, 900), (1, 1000)]);
    let b = net.trip(1, &[(1, 1050), (2, 1200)]);
    net.boarding = vec![0x50, 0x54, 0x51, 0x50];
    net.transfers.push((1, 1, ABSENT, ABSENT, a, b, ABSENT, 4));
    assert!(check_ceiling(&net, &query(0, 2, 900, 2), 900..901, 1200));
    assert!(!check_ceiling(&net, &query(0, 2, 900, 1), 900..901, 1200));
    for exact in [0, 1] {
        let mut net = Net::new(4, 2);
        net.trip(0, &[(0, 86000), (1, 87000)]);
        let target = net.trip(1, &[(1, 87050), (2, 87200), (1, 87300), (3, 87400)]);
        net.freqs.push((target, 87050, 87551, 100, exact));
        let mut origins = utc_origins(START, DAYS as usize, 0);
        for o in origins.iter_mut().skip(4) {
            *o -= 3600;
        }
        net.origins = Some(origins);
        assert!(check_ceiling(
            &net,
            &query(0, 3, 85000, 2),
            85000..87001,
            88000
        ));
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
        assert!(check_ceiling(&net, &query(1, 0, 950, 2), 950..1101, 1300));
    }
    let mut net = Net::new(5, 2);
    net.trip(0, &[(0, 900), (1, 1000)]);
    net.trip(1, &[(2, 1200), (4, 1400), (3, 1500), (4, 1800)]);
    net.ptft.extend([(1, 2, 90), (1, 3, 30)]);
    assert!(check_ceiling(&net, &query(0, 4, 900, 2), 900..901, 1800));
}

#[test]
fn winner_ceiling_retains_each_original_cap_and_invalidates_prepared_state() {
    let net = lattice(2, 1, false);
    let q = query(0, 2, 900, 2);
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let mut s =
            DeadlineSession::new(Reader::from_bytes(net.bytes()).unwrap(), mode, None).unwrap();
        let c = config(900..1200, 1314);
        s.prepare(q.clone(), c.clone()).unwrap();
        for pref in [None, Some(DeadlinePreference::LatestDeparture)] {
            let full = s
                .run_winner_incumbent_ceiling_with_phases(
                    pref,
                    DeadlineSuffixPruning::RowPrefix,
                    |_| {},
                )
                .unwrap();
            let d = full.baseline.diagnostics;
            let stop = d.seed_event_checks
                + d.stop_events_scanned
                + d.prefix.event_scans
                + d.prefix.walking_relaxations
                + d.optimistic.work()
                + d.forward.stop_work();
            for (kind, bound) in [
                (0, d.lazy.work),
                (1, stop),
                (2, d.segments_enqueued),
                (3, d.max_frontier_width),
            ] {
                for cap in 1..=bound + 1 {
                    let mut limited = c.clone();
                    match kind {
                        0 => limited.max_lookup_work = cap,
                        1 => limited.max_stop_scans = cap,
                        2 => limited.max_segments = cap,
                        _ => limited.max_frontier_width = cap,
                    };
                    s.prepare_reusing(q.clone(), limited).unwrap();
                    let expected = if let Some(p) = pref {
                        s.run_preference_with_phases(p, DeadlineSuffixPruning::RowPrefix, |_| {})
                            .map(|_| ())
                    } else {
                        s.run_portfolio_with_phases(DeadlineSuffixPruning::RowPrefix, |_| {})
                            .map(|_| ())
                    };
                    let got = s.run_winner_incumbent_ceiling_with_phases(
                        pref,
                        DeadlineSuffixPruning::RowPrefix,
                        |_| {},
                    );
                    match expected {
                        Err(e) => {
                            assert_eq!(got.unwrap_err(), DeadlineIncumbentCeilingError::Baseline(e))
                        }
                        Ok(()) => match got {
                            Ok(r) => assert_eq!(r.baseline.winners, r.ceiling.winners),
                            Err(DeadlineIncumbentCeilingError::Ceiling(e)) => assert!(matches!(
                                e,
                                DeadlineError::Lookup(LazyLookupError::WorkExhausted { .. })
                                    | DeadlineError::StopScansExhausted { .. }
                                    | DeadlineError::SegmentsExhausted { .. }
                                    | DeadlineError::FrontierExhausted { .. }
                            )),
                            Err(e) => panic!("successful source cannot become unavailable: {e:?}"),
                        },
                    }
                }
            }
        }
        s.prepare(q.clone(), c.clone()).unwrap();
        let mut external = q.clone();
        external.entry_stops.clear();
        assert!(
            s.run_winner_incumbent_ceiling_with_phases(
                None,
                DeadlineSuffixPruning::RowPrefix,
                |_| {}
            )
            .unwrap()
            .initial_points
                > 0
        );
        s.prepare_reusing(external, c.clone()).unwrap();
        assert_eq!(
            s.run_winner_incumbent_ceiling_with_phases(
                None,
                DeadlineSuffixPruning::RowPrefix,
                |_| {}
            )
            .unwrap()
            .initial_points,
            0
        );
        let mut bad = q.clone();
        bad.entry_stops[0].stop = u32::MAX;
        assert!(s.prepare_reusing(bad, c.clone()).is_err());
        let e = DeadlineIncumbentCeilingError::Baseline(DeadlineError::InvalidRequest(
            "deadline request is not prepared",
        ));
        assert_eq!(
            s.run_winner_incumbent_ceiling_with_phases(
                None,
                DeadlineSuffixPruning::RowPrefix,
                |_| {}
            )
            .unwrap_err(),
            e
        );
        s.prepare(q.clone(), c).unwrap();
        s.clear();
        assert_eq!(
            s.run_winner_incumbent_ceiling_with_phases(
                None,
                DeadlineSuffixPruning::RowPrefix,
                |_| {}
            )
            .unwrap_err(),
            e
        );
    }
}
