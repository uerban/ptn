//! H78: existing duration/timetable walking profile in an exact immutable prepared slot.
use super::*;

fn check_prepared_walking(
    net: &Net,
    q: &Query,
    window: core::ops::Range<i64>,
    deadline: i64,
) -> bool {
    let reader = Reader::from_bytes(net.bytes()).unwrap();
    let walks = net.ptft_table();
    let mut nonempty = false;
    for mode in [
        PatternMode::Off,
        PatternMode::Unbounded,
        PatternMode::CoveringMerge,
    ] {
        let index = Index::build(&reader, mode).unwrap();
        let mut forward = R3Request::new(q, window.clone());
        forward.transfers = walks.as_ref();
        forward.max_labels = 1_000_000;
        let points: Vec<_> = profile_m4(&reader, &index, forward)
            .unwrap()
            .points
            .into_iter()
            .filter(|p| p.destination_arrival_secs <= deadline)
            .collect();
        let raw: Vec<_> = expected(net, q, &window, ProfileObjectives::M4)
            .into_iter()
            .filter(|p| p.1 <= deadline)
            .collect();
        assert_eq!(tuples(&points, ProfileObjectives::M4), raw);
        nonempty |= !points.is_empty();
        let mut cached = DeadlineSession::new_with_immutable_binding(
            Reader::from_bytes(net.bytes()).unwrap(),
            mode,
            net.ptft_table(),
        )
        .unwrap();
        let mut rebuilt = DeadlineSession::new_with_immutable_binding(
            Reader::from_bytes(net.bytes()).unwrap(),
            mode,
            net.ptft_table(),
        )
        .unwrap();
        for pruning in [
            DeadlinePruning::EarliestPrefixAndPoints,
            DeadlinePruning::EarliestPrefixAndTimetablePoints,
        ] {
            let mut c = DeadlineSessionConfig::new(window.clone(), deadline);
            c.lookup = LazyLookupMode::PlainCached;
            c.pruning = pruning;
            c.walking_bound = true;
            c.traversal = DeadlineTraversal::ArrivalFirst;
            c.frontier_storage = DeadlineFrontierStorage::EventIndexed;
            cached
                .prepare_with_prefix_cache(q.clone(), c.clone())
                .unwrap();
            rebuilt.prepare(q.clone(), c.clone()).unwrap();
            let built = cached.prefix_cache_diagnostics_for_test().unwrap();
            assert_eq!(built.walking_enabled, built.enabled);
            assert_eq!(cached.run().unwrap().points, points);
            for _ in 0..2 {
                let a = cached
                    .run_portfolio_with_phases(DeadlineSuffixPruning::RowPrefix, |_| {})
                    .unwrap();
                let b = rebuilt
                    .run_portfolio_with_phases(DeadlineSuffixPruning::RowPrefix, |_| {})
                    .unwrap();
                assert_eq!(a.winners, DeadlinePortfolioWinners::from_m4_points(&points));
                assert_eq!(a.winners, b.winners);
                assert_eq!(a.diagnostics, b.diagnostics);
                assert_eq!(cached.prefix_cache_diagnostics_for_test(), Some(built));
                assert_owned_winners(&cached, &points);
            }
            let work =
                (built.event_scans + built.walking_relaxations + built.timetable.work()).max(2);
            for cap in [1, work - 1, work] {
                c.max_stop_scans = cap;
                cached
                    .prepare_with_prefix_cache(q.clone(), c.clone())
                    .unwrap();
                rebuilt.prepare(q.clone(), c.clone()).unwrap();
                assert_eq!(
                    cached.run().map(|r| (r.points, r.diagnostics)),
                    rebuilt.run().map(|r| (r.points, r.diagnostics))
                );
            }
            cached.clear();
            assert!(cached.prefix_cache_diagnostics_for_test().is_none());
            assert!(cached.run().is_err());
        }
    }
    nonempty
}

#[test]
fn prepared_walking_matches_raw_canonical_winners_work_caps_and_repeated_runs() {
    let mut rng = Rng(0x4837_3850_5245_5031);
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
        q.entry_stops[0].walk_secs = rng.below(120) as u32;
        q.exit_stops[0].walk_secs = rng.below(120) as u32;
        vary_walk_settings(&mut rng, &mut q);
        if check_prepared_walking(&net, &q, 68000..72000, 76000) {
            nonempty += 1;
        }
    }
    assert!(nonempty > 10, "sparse corpus {nonempty}");
}

#[test]
fn prepared_walking_combination_keeps_inseat_loops_rule_fallback_and_directed_walks() {
    for derived in [false, true] {
        for ruled in [false, true] {
            let mut net = Net::new(6, 4);
            let a = net.trip(0, &[(0, 900), (1, 1000), (0, 1050), (2, 1100)]);
            let b = net.trip(1, &[(2, 1100), (3, 1300)]);
            net.trip(2, &[(0, 900), (4, 1000)]);
            net.trip(3, &[(5, 1200), (3, 1300)]);
            net.trip(3, &[(5, 1200), (3, 1300)]);
            net.ptft.extend([(4, 5, 50), (4, 5, 90), (5, 4, 0)]);
            if derived {
                net.trips[a as usize].block = Some("h78");
                net.trips[b as usize].block = Some("h78");
                net.derive = true;
            }
            if ruled {
                net.transfers
                    .push((4, 5, ABSENT, ABSENT, ABSENT, ABSENT, ABSENT, 0));
            }
            let mut q = query(0, 3, 883, 4);
            q.entry_stops[0].walk_secs = 17;
            q.exit_stops[0].walk_secs = 13;
            assert!(check_prepared_walking(&net, &q, 883..884, 1313));
        }
    }
}
